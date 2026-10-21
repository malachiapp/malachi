// HIDDEN-BUG-HUNT PASS: close() waehrend eines laufenden Kyber-Handshakes
// resurrectiert RTCStore.sharedSecrets / die persistente Ablage direkt nach
// einem vermeintlich vollstaendigen Wipe oder Chat-Loeschen - siehe
// SECURITY_HIDDEN_BUG_HUNT.md fuer die vollstaendige Herleitung.
//
// Kernbefund: WebRTCManager.close() (aufgerufen von RTCStore.resetAll() beim
// 5-Fehlversuche-Wipe, RTCStore.clearContact() beim Chat-Loeschen/
// device_wiped-Tombstone, oder RTCStore.setConnection()'s eigenem
// "verliere Verbindung wird geschlossen"-Pfad bei einem Reconnect-Wettlauf)
// nullt nur Instanzfelder - es bricht NICHT einen bereits laufenden
// `channel.onmessage`-Handler ab, der zum Zeitpunkt des close()-Aufrufs
// mitten in `await kyberEncapsulate(...)`/`await kyberDecapsulate(...)`
// haengt (ein echter, mehrere Millisekunden dauernder nativer
// Bridge-Aufruf bzw. ein echter ML-KEM-768-Aufruf auf web - siehe
// HybridCrypto.js/.ts). Laeuft der Wipe/das Loeschen GENAU in diesem
// Fenster, schreibt der fortgesetzte Handler beim Fortsetzen
// `this.sharedSecret`/`RTCStore.sharedSecrets` sowie die persistente
// `shared_secret_<chatId>`-Ablage erneut - DIREKT NACH dem vermeintlich
// vollstaendigen Wipe/Loeschen, und startet ausserdem Cover-Traffic/
// _onKeyExchange (Profil-/Avatar-Versand) fuer eine Verbindung, die gerade
// aktiv geschlossen wurde.
//
// Fix: ein `_closed`-Flag, gesetzt in close(), abgefragt direkt NACH dem
// Bridge-Aufruf in beiden Kyber-Handlern (analog zum bereits bestehenden
// `keyExchangeDone`-Duplikat-Schutz) - bevor irgendein State mutiert wird.

const crypto = require('crypto');

function makeAsyncChannel() {
  return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null };
}

describe('Hidden-Bug-Hunt (nativ): close() waehrend laufendem Kyber-Handshake darf RTCStore.sharedSecrets/Disk nicht wiederherstellen', () => {
  const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
  installKyberModuleMock();
  const { NativeModules } = require('react-native');
  NativeModules.KyberModule.generateKeypair = async () => ({
    publicKey: 'pub_' + crypto.randomBytes(8).toString('hex'),
    secretKey: 'sec_' + crypto.randomBytes(8).toString('hex'),
  });

  const RTCStore = require('../../RTCStore').default;
  const { WebRTCManager } = require('../../WebRTCManager');
  const EncryptedStorage = require('react-native-encrypted-storage').default;

  let releaseEncapsulate;
  let releaseDecapsulate;

  beforeEach(() => {
    // Bewusst KEIN jest.resetModules() hier (anders als in anderen Tests
    // dieses Verzeichnisses): WebRTCManager.js liest NativeModules.KyberModule
    // ueber HybridCrypto.js zur Aufrufzeit, ein Modul-Reset wuerde die hier
    // ueber installKyberModuleMock()/NativeModules konfigurierten Mocks von
    // den nach dem Reset frisch geladenen Kopien von WebRTCManager/RTCStore
    // entkoppeln. Stattdessen: RTCStore.resetAll() fuer einen sauberen
    // In-Memory-Zustand pro Test, exakt wie im bestehenden
    // chaos.keyStateRace.test.js.
    RTCStore.resetAll();
    releaseEncapsulate = null;
    releaseDecapsulate = null;
    NativeModules.KyberModule.encapsulate = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseEncapsulate = () => {
            const sharedSecret = crypto.randomBytes(32).toString('base64');
            resolve({ sharedSecret, cipherText: Buffer.from(sharedSecret).toString('base64') });
          };
        }),
    );
    NativeModules.KyberModule.decapsulate = jest.fn(
      (cipherTextB64) =>
        new Promise((resolve) => {
          releaseDecapsulate = () => resolve(Buffer.from(cipherTextB64, 'base64').toString('utf8'));
        }),
    );
  });

  test('Responder-Seite (kyber_pubkey): 5-Fail-Wipe (RTCStore.resetAll()) waehrend await kyberEncapsulate() gefolgt von verspaetetem Bridge-Ergebnis darf das Secret nicht wiederherstellen', async () => {
    const setItemSpy = jest.spyOn(EncryptedStorage, 'setItem');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sentByInitiator = [];
      const chInit = makeAsyncChannel();
      chInit.send = (d) => sentByInitiator.push(d);
      const chResp = makeAsyncChannel();
      chResp.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit._setupDataChannel(chInit);
      rtcInit.myKyberKeys = await NativeModules.KyberModule.generateKeypair();
      chInit.send(
        JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }),
      );

      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactWipedMidHandshake';
      // Realistisch eingebunden ueber RTCStore.connections, genau wie im
      // Produktionscode (App.tsx ruft RTCStore.setConnection() nach
      // onConnected auf, bevor der Kyber-Austausch abgeschlossen ist).
      RTCStore.setConnection(rtcResp.chatId, rtcResp);
      rtcResp._setupDataChannel(chResp);

      // Eingehendes kyber_pubkey wird verarbeitet - kyberEncapsulate() haengt
      // (Gate noch nicht freigegeben).
      const handlerPromise = chResp.onmessage({ data: sentByInitiator[0] });
      await new Promise((r) => setTimeout(r, 0));
      expect(releaseEncapsulate).toBeTruthy();
      expect(rtcResp.keyExchangeDone).toBe(false); // Handshake noch nicht abgeschlossen

      // GENAU JETZT: Nutzer erreicht den 5. Fehlversuch - der Wipe-Handler
      // (App.tsx) ruft RTCStore.resetAll() auf, welches rtc.close() auf
      // GENAU dieser Instanz aufruft, waehrend deren Handshake noch mitten
      // im Bridge-Aufruf steckt.
      RTCStore.resetAll();
      expect(rtcResp._closed).toBe(true);
      expect(RTCStore.sharedSecrets.size).toBe(0);
      expect(RTCStore.connections.size).toBe(0);

      // Die (verspaetete) Bridge liefert jetzt ihr Ergebnis.
      releaseEncapsulate();
      await handlerPromise;

      // DER FIX: der fortgesetzte Handler darf RTCStore.sharedSecrets NICHT
      // erneut befuellen und darf NICHT auf die Platte persistieren - "wipe"
      // muss "wipe" bleiben, auch wenn ein Handshake mittendrin unterbrochen
      // wurde.
      expect(RTCStore.sharedSecrets.has('contactWipedMidHandshake')).toBe(false);
      expect(setItemSpy).not.toHaveBeenCalledWith(
        'shared_secret_contactWipedMidHandshake',
        expect.anything(),
      );
      expect(rtcResp.sharedSecret).toBeNull();
      expect(rtcResp.keyExchangeDone).toBe(false);
      expect(
        warnSpy.mock.calls.some((args) => String(args[0]).includes('Kyber-Encapsulate geschlossen')),
      ).toBe(true);
    } finally {
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('Initiator-Seite (kyber_ciphertext): Chat-Loeschen (RTCStore.clearContact()) waehrend await kyberDecapsulate() darf das Secret nicht wiederherstellen', async () => {
    const setItemSpy = jest.spyOn(EncryptedStorage, 'setItem');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sentByResponder = [];
      const chResp = makeAsyncChannel();
      chResp.send = (d) => sentByResponder.push(d);
      const chInit = makeAsyncChannel();
      chInit.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit.chatId = 'contactDeletedMidHandshake';
      RTCStore.setConnection(rtcInit.chatId, rtcInit);
      rtcInit._setupDataChannel(chInit);
      rtcInit.myKyberKeys = await NativeModules.KyberModule.generateKeypair();

      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp._setupDataChannel(chResp);
      // Real kyber_ciphertext-Nachricht produzieren (unabhaengig vom
      // gegateten encapsulate-Mock - decapsulate ist es, was hier gegatet
      // wird), indem wir das Ciphertext-Format direkt nachbilden (dieselbe
      // Form, die encapsulate() liefert): Klartext-Kopie der Bridge-Antwort.
      const rawSecret = crypto.randomBytes(32).toString('base64');
      const cipherText = Buffer.from(rawSecret).toString('base64');

      const handlerPromise = chInit.onmessage({
        data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText }),
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(releaseDecapsulate).toBeTruthy();
      expect(rtcInit.keyExchangeDone).toBe(false);

      // GENAU JETZT: Nutzer loescht den Chat - RTCStore.clearContact() ruft
      // rtc.close() auf GENAU dieser Instanz auf.
      RTCStore.clearContact('contactDeletedMidHandshake');
      expect(rtcInit._closed).toBe(true);
      expect(RTCStore.sharedSecrets.has('contactDeletedMidHandshake')).toBe(false);
      expect(RTCStore.connections.has('contactDeletedMidHandshake')).toBe(false);

      releaseDecapsulate();
      await handlerPromise;

      expect(RTCStore.sharedSecrets.has('contactDeletedMidHandshake')).toBe(false);
      expect(setItemSpy).not.toHaveBeenCalledWith(
        'shared_secret_contactDeletedMidHandshake',
        expect.anything(),
      );
      expect(rtcInit.sharedSecret).toBeNull();
      expect(rtcInit.keyExchangeDone).toBe(false);
      expect(
        warnSpy.mock.calls.some((args) => String(args[0]).includes('Kyber-Decapsulate geschlossen')),
      ).toBe(true);
    } finally {
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('Hidden-Bug-Hunt (web): close() waehrend laufendem Kyber-Handshake darf RTCStore.sharedSecrets/Storage nicht wiederherstellen', () => {
  function makeChannel() {
    return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null };
  }

  test('Responder-Seite (kyber_pubkey): resetAll() waehrend await kyberEncapsulate() darf das Secret nicht wiederherstellen', async () => {
    jest.resetModules();
    const RTCStore = require('../../web/src/lib/RTCStore.ts').default;
    RTCStore.resetAll();
    const HybridCrypto = require('../../web/src/lib/HybridCrypto.ts');
    const Storage = require('../../web/src/lib/Storage.ts');
    const setItemSpy = jest.spyOn(Storage, 'setItem').mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    let releaseEncapsulate;
    const encapsulateSpy = jest.spyOn(HybridCrypto, 'kyberEncapsulate').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseEncapsulate = () => {
            const sharedSecret = crypto.randomBytes(32).toString('base64');
            resolve({ sharedSecret, cipherText: Buffer.from(sharedSecret).toString('base64') });
          };
        }),
    );

    try {
      const { WebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');
      const sentByInitiator = [];
      const chInit = makeChannel();
      chInit.send = (d) => sentByInitiator.push(d);
      const chResp = makeChannel();
      chResp.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit._setupDataChannel(chInit);
      rtcInit.myKyberKeys = await HybridCrypto.generateKyberKeypair();
      chInit.send(
        JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }),
      );

      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactWipedMidHandshakeWeb';
      RTCStore.setConnection(rtcResp.chatId, rtcResp);
      rtcResp._setupDataChannel(chResp);

      const handlerPromise = chResp.onmessage({ data: sentByInitiator[0] });
      await new Promise((r) => setTimeout(r, 0));
      expect(releaseEncapsulate).toBeTruthy();
      expect(rtcResp.keyExchangeDone).toBe(false);

      // GENAU JETZT: der Pepper-Wipe (web, 5 Fehlversuche) ruft
      // RTCStore.resetAll() auf.
      RTCStore.resetAll();
      expect(rtcResp._closed).toBe(true);
      expect(RTCStore.sharedSecrets.size).toBe(0);

      releaseEncapsulate();
      await handlerPromise;

      expect(RTCStore.sharedSecrets.has('contactWipedMidHandshakeWeb')).toBe(false);
      expect(setItemSpy).not.toHaveBeenCalledWith(
        'shared_secret_contactWipedMidHandshakeWeb',
        expect.anything(),
      );
      expect(rtcResp.sharedSecret).toBeNull();
      expect(
        warnSpy.mock.calls.some((args) => String(args[0]).includes('Kyber-Encapsulate geschlossen')),
      ).toBe(true);
    } finally {
      encapsulateSpy.mockRestore();
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
