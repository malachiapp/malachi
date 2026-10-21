// KONKURRENZ-REVIEW: zwei weitere Zeitfenster rund um WebRTCManager.close()
// racing gegen einen laufenden Kyber-Handshake bzw. eine laufende
// channel.onmessage()-Verarbeitung, die vom "Hidden-Bug-Hunt"-Fund in
// hiddenBugHunt.closeDuringHandshake.test.js NICHT abgedeckt sind. Jener Fund
// (und Fix - siehe dortiger Kommentar) schliesst nur das Fenster WAEHREND
// `await kyberEncapsulate()`/`await kyberDecapsulate()` selbst. Diese Datei
// deckt zwei benachbarte, eigenstaendige Fenster ab:
//
//   Fenster 2 (Persistierung): `RTCStore.sharedSecrets.set(chatId, secret)`
//   laeuft SYNCHRON, direkt bevor `await EncryptedStorage.setItem(...)`
//   (nativ) / `await setItem(...)` (web) beginnt. Schliesst
//   clearContact()/resetAll() GENAU waehrend dieses zweiten awaiteten
//   Schreibvorgangs (statt waehrend des Kyber-Bridge-Aufrufs davor), ist der
//   RTCStore-Eintrag zu diesem Zeitpunkt bereits wiederhergestellt, und der
//   Hidden-Bug-Hunt-Fix (der nur VOR diesem Block prueft) sieht das nicht
//   mehr - ohne eine zweite Pruefung NACH dem Schreibvorgang bliebe sowohl
//   der RAM-Eintrag als auch der frisch geschriebene Disk-Eintrag fuer einen
//   gerade geloeschten/gewipeten Kontakt bestehen.
//
//   Fenster (Nachrichtenpuffer): `close()` nullte bisher `this.onMessage`
//   nicht. `rtc.onMessage` ist die von RTCStore.setConnection() gesetzte
//   Closure, die bei fehlendem Listener `this.buffer.set(chatId, [])` NEU
//   ANLEGT statt nur zu pruefen. System-Kontrollnachrichten
//   (secret_start/secret_end/delete_chat/transfer_ready) haben auf dem
//   nativen Live-Pfad einen echten await-Punkt
//   (`await isNewerThanLastAcceptedSystemTs(...)`) zwischen Entschluesselung
//   und dem abschliessenden `this.onMessage?.(original)`-Aufruf. Laeuft
//   clearContact()/resetAll() waehrend dieses awaits, wuerde der
//   fortgesetzte Handler ohne den onMessage-Fix den Buffer-Eintrag des
//   gerade geloeschten Kontakts wiederherstellen und die Systemnachricht
//   hineinschreiben - direkt nach dem vermeintlich vollstaendigen
//   Loeschen/Wipe.
//
// Beide Fixes liegen in WebRTCManager.js/.ts selbst (siehe dortige
// Kommentare "Konkurrenz-Review-Fund"), diese Datei beweist ihre Wirkung
// gegen echten Produktionscode (RTCStore.setConnection/clearContact/
// resetAll, echte encryptMsg/decryptMsg, gegateter echter Disk-Write).

const crypto = require('crypto');

// installKyberModuleMock() ERSETZT NativeModules.KyberModule komplett
// (siehe helpers/nativeBridgeMock.js) - MUSS deshalb genau EINMAL, vor jedem
// require() von WebRTCManager/HybridCrypto/MessageCrypto in dieser Datei
// laufen. MessageCrypto.js liest `const { KyberModule } = NativeModules;`
// als EINMALIGE Destrukturierung beim allerersten Modul-Laden - ein spaeterer
// erneuter installKyberModuleMock()-Aufruf (der das Objekt ERSETZT statt nur
// einzelne Methoden zu UEBERSCHREIBEN) wuerde diese bereits gezogene
// Referenz von der neu zugewiesenen trennen. Deshalb: nur dieser eine Aufruf
// hier oben, jede weitere Anpassung (generateKeypair/encapsulate) mutiert
// danach nur noch Felder auf demselben Objekt.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');

function makeAsyncChannel() {
  return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null };
}

describe('Konkurrenz-Review (nativ) - Fenster 2: close() waehrend der Secret-Persistierung selbst (nach RTCStore.sharedSecrets.set, waehrend await EncryptedStorage.setItem)', () => {
  const RTCStore = require('../../RTCStore').default;
  const { WebRTCManager } = require('../../WebRTCManager');
  const EncryptedStorage = require('react-native-encrypted-storage').default;

  beforeEach(() => {
    // Nur Felder auf dem bereits einmalig installierten NativeModules.KyberModule
    // MUTIEREN, nicht das Objekt erneut ersetzen (siehe Kommentar oben).
    NativeModules.KyberModule.generateKeypair = async () => ({
      publicKey: 'pub_' + crypto.randomBytes(8).toString('hex'),
      secretKey: 'sec_' + crypto.randomBytes(8).toString('hex'),
    });
    NativeModules.KyberModule.encapsulate = async () => {
      const sharedSecret = crypto.randomBytes(32).toString('base64');
      return { sharedSecret, cipherText: Buffer.from(sharedSecret).toString('base64') };
    };
    RTCStore.resetAll();
  });

  test('Responder-Seite (kyber_pubkey): clearContact() waehrend await EncryptedStorage.setItem() entfernt den RAM- UND den frisch geschriebenen Disk-Eintrag wieder', async () => {
    const originalSetItem = EncryptedStorage.setItem;
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const setItemSpy = jest.spyOn(EncryptedStorage, 'setItem').mockImplementation(
      (key, value) => gate.then(() => originalSetItem(key, value)),
    );
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
      chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactRaceWindow2';
      // Realistisch eingebunden, wie im Produktionscode (App.tsx ruft
      // RTCStore.setConnection() nach onConnected auf, lange bevor der
      // Kyber-Austausch abgeschlossen ist).
      RTCStore.setConnection(rtcResp.chatId, rtcResp);
      rtcResp._setupDataChannel(chResp);

      // kyberEncapsulate() selbst ist NICHT gegatet - laeuft durch, setzt
      // this.sharedSecret/keyExchangeDone und RTCStore.sharedSecrets.set()
      // SYNCHRON, dann haengt der awaitete Disk-Write.
      const handlerPromise = chResp.onmessage({ data: sentByInitiator[0] });
      await new Promise((r) => setTimeout(r, 0));

      // Zwischenzustand bestaetigen: das Secret ist schon im RAM UND im
      // RTCStore gesetzt (Fenster 1 ist hier absichtlich schon vorbei),
      // aber der Disk-Write haengt noch.
      expect(rtcResp.keyExchangeDone).toBe(true);
      expect(RTCStore.sharedSecrets.has('contactRaceWindow2')).toBe(true);
      expect(setItemSpy).toHaveBeenCalledWith('shared_secret_contactRaceWindow2', rtcResp.sharedSecret);

      // GENAU JETZT: Nutzer loescht den Chat (oder 5-Fail-Wipe laeuft) -
      // RTCStore.clearContact() ruft rtc.close() auf GENAU dieser Instanz,
      // waehrend deren Disk-Write noch unterwegs ist.
      RTCStore.clearContact('contactRaceWindow2');
      expect(rtcResp._closed).toBe(true);
      expect(RTCStore.sharedSecrets.has('contactRaceWindow2')).toBe(false); // clearContact() selbst raeumt sofort auf

      // Der (verspaetete) Disk-Write laeuft jetzt durch.
      releaseWrite();
      await handlerPromise;

      // DER FIX: der fortgesetzte Handler darf den gerade geloeschten
      // Eintrag NICHT wiederherstellen - weder im RTCStore noch auf der
      // (jetzt tatsaechlich geschriebenen) Platte.
      expect(RTCStore.sharedSecrets.has('contactRaceWindow2')).toBe(false);
      // removeItem wird vom Fix aufgerufen, um den gerade geschriebenen
      // Disk-Eintrag wieder zu entfernen - direkt per getItem nachpruefen,
      // dass er tatsaechlich weg ist (nicht nur, dass removeItem aufgerufen
      // wurde).
      const stillOnDisk = await EncryptedStorage.getItem('shared_secret_contactRaceWindow2');
      expect(stillOnDisk).toBeNull();
      expect(
        warnSpy.mock.calls.some((args) => String(args[0]).includes('Secret-Persistierung geschlossen')),
      ).toBe(true);

      rtcInit.close();
    } finally {
      EncryptedStorage.setItem = originalSetItem;
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('Konkurrenz-Review (nativ) - Nachrichtenpuffer: close() waehrend eines laufenden System-Kontrollpaket-Checks darf RTCStore.buffer/listeners fuer einen geloeschten Kontakt nicht wiederherstellen', () => {
  // installKyberModuleMock() bereits einmalig oben im Datei-Kopf gelaufen -
  // hier NICHT erneut aufrufen (siehe dortiger Kommentar).
  const RTCStore = require('../../RTCStore').default;
  const { WebRTCManager } = require('../../WebRTCManager');
  const MessageCrypto = require('../../MessageCrypto');
  const EncryptedStorage = require('react-native-encrypted-storage').default;

  beforeEach(() => {
    RTCStore.resetAll();
  });

  test('delete_chat via Live-P2P: clearContact() waehrend await isNewerThanLastAcceptedSystemTs() (EncryptedStorage-Zugriff - teilt sich jetzt denselben Speicher wie die App.tsx-Kopie, siehe Konkurrenz-Review-Fund in WebRTCManager.js) darf den Buffer nicht wieder anlegen', async () => {
    const originalGetItem = EncryptedStorage.getItem.bind(EncryptedStorage);
    let releaseGetItem;
    const gate = new Promise((resolve) => { releaseGetItem = resolve; });
    // Nur der Hochwasserstand des Replay-Checks wird angehalten: seit dem
    // Double Ratchet liest der Empfangspfad vorher (Downgrade-Schutz) auch den
    // Ratchet-Zustand des Kontakts - der soll hier ungehindert durchlaufen,
    // damit der Handler genau im Replay-Check haengt.
    const getItemSpy = jest.spyOn(EncryptedStorage, 'getItem').mockImplementation(
      (key) => (String(key).startsWith('system_ts_hwm_') ? gate.then(() => originalGetItem(key)) : originalGetItem(key)),
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const chatId = 'contactBufferRace';
      const secret = crypto.randomBytes(32).toString('base64');

      const rtc = new WebRTCManager(() => {}, () => {}, () => {});
      rtc.chatId = chatId;
      rtc.sharedSecret = secret;
      rtc.keyExchangeDone = true;
      // Realistisch ueber RTCStore.setConnection eingebunden - das ist die
      // Produktions-Closure, die bei fehlendem Listener this.buffer neu
      // anlegt statt nur zu pruefen (genau der Mechanismus, den dieser
      // Test absichert).
      RTCStore.setConnection(chatId, rtc);
      const channel = makeAsyncChannel();
      channel.send = () => {};
      rtc._setupDataChannel(channel);
      expect(RTCStore.connections.get(chatId)).toBe(rtc);

      const deleteChatEnc = await MessageCrypto.encryptMsg(
        JSON.stringify({ type: 'system', subtype: 'delete_chat', ts: Date.now() }),
        secret,
      );

      // Eingehende (Live-P2P) delete_chat-Nachricht verarbeiten - haengt im
      // sequenzbewussten Replay-Check (AsyncStorage.getItem gegatet).
      const handlerPromise = channel.onmessage({
        data: JSON.stringify({ type: 'encrypted', data: deleteChatEnc }),
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(getItemSpy).toHaveBeenCalledWith('system_ts_hwm_' + chatId);

      // GENAU JETZT: Nutzer loescht denselben Kontakt lokal (oder der
      // 5-Fail-Wipe laeuft) - RTCStore.clearContact() schliesst rtc UND
      // entfernt buffer/listeners/sharedSecrets-Eintraege fuer chatId.
      RTCStore.clearContact(chatId);
      expect(rtc._closed).toBe(true);
      expect(rtc.onMessage).toBeNull(); // DER FIX
      expect(RTCStore.buffer.has(chatId)).toBe(false);
      expect(RTCStore.connections.has(chatId)).toBe(false);

      releaseGetItem();
      await handlerPromise;

      // DER FIX: der fortgesetzte Handler darf RTCStore.buffer/listeners
      // fuer den gerade geloeschten Kontakt NICHT wiederherstellen - ohne
      // den Fix wuerde die delete_chat-Nachricht hier landen, obwohl der
      // Kontakt (aus Nutzersicht) laengst weg ist.
      expect(RTCStore.buffer.has(chatId)).toBe(false);
      expect(RTCStore.listeners.has(chatId)).toBe(false);
    } finally {
      getItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('Kontrollgruppe: OHNE gleichzeitiges clearContact() wird dieselbe delete_chat-Nachricht ganz normal gepuffert (bestaetigt, dass der Fix keine legitime Zustellung unterdrueckt)', async () => {
    const chatId = 'contactBufferRaceControl';
    const secret = crypto.randomBytes(32).toString('base64');

    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    rtc.chatId = chatId;
    rtc.sharedSecret = secret;
    rtc.keyExchangeDone = true;
    RTCStore.setConnection(chatId, rtc);
    const channel = makeAsyncChannel();
    channel.send = () => {};
    rtc._setupDataChannel(channel);

    const deleteChatEnc = await MessageCrypto.encryptMsg(
      JSON.stringify({ type: 'system', subtype: 'delete_chat', ts: Date.now() }),
      secret,
    );
    await channel.onmessage({ data: JSON.stringify({ type: 'encrypted', data: deleteChatEnc }) });

    const buffered = RTCStore.getBuffered(chatId);
    expect(buffered.some((m) => m.subtype === 'delete_chat')).toBe(true);

    rtc.close();
  });
});

describe('Konkurrenz-Review (web) - Fenster 2: resetAll()/clearContact() waehrend der Secret-Persistierung selbst', () => {
  function makeChannel() {
    return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null };
  }

  test('Responder-Seite (kyber_pubkey): resetAll() waehrend await setItem() (Storage.ts) entfernt den RAM- UND den frisch geschriebenen Eintrag wieder', async () => {
    jest.resetModules();
    const RTCStore = require('../../web/src/lib/RTCStore.ts').default;
    RTCStore.resetAll();
    const HybridCrypto = require('../../web/src/lib/HybridCrypto.ts');
    const Storage = require('../../web/src/lib/Storage.ts');

    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const storageBacking = new Map();
    const setItemSpy = jest.spyOn(Storage, 'setItem').mockImplementation(
      (key, value) => gate.then(() => { storageBacking.set(key, value); }),
    );
    const removeItemSpy = jest.spyOn(Storage, 'removeItem').mockImplementation(
      async (key) => { storageBacking.delete(key); },
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
      chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactRaceWindow2Web';
      RTCStore.setConnection(rtcResp.chatId, rtcResp);
      rtcResp._setupDataChannel(chResp);

      const handlerPromise = chResp.onmessage({ data: sentByInitiator[0] });
      await new Promise((r) => setTimeout(r, 0));

      expect(rtcResp.keyExchangeDone).toBe(true);
      expect(RTCStore.sharedSecrets.has('contactRaceWindow2Web')).toBe(true);
      expect(setItemSpy).toHaveBeenCalledWith('shared_secret_contactRaceWindow2Web', rtcResp.sharedSecret);

      // GENAU JETZT: der Pepper-Wipe (5 Fehlversuche) ruft RTCStore.resetAll() auf.
      RTCStore.resetAll();
      expect(rtcResp._closed).toBe(true);
      expect(RTCStore.sharedSecrets.size).toBe(0);

      releaseWrite();
      await handlerPromise;

      expect(RTCStore.sharedSecrets.has('contactRaceWindow2Web')).toBe(false);
      expect(storageBacking.has('shared_secret_contactRaceWindow2Web')).toBe(false);
      expect(
        warnSpy.mock.calls.some((args) => String(args[0]).includes('Secret-Persistierung geschlossen')),
      ).toBe(true);
    } finally {
      setItemSpy.mockRestore();
      removeItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
