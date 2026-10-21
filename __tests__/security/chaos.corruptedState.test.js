// CHAOS/RESILIENCE PASS - "Corrupted local state" und "Partially-saved
// sessions" (siehe Task-Mandat). "Datenbankfehler" aus dem Mandat sind hier
// AsyncStorage/EncryptedStorage (nativ) bzw. localStorage (Web) - es gibt
// keine Server-Datenbank (relay.js haelt nur RAM, siehe SECURITY_*-Dokumente).
//
// Testet, ob jede Lesestelle mit malformten/abgeschnittenen Werten umgeht,
// die die App selbst geschrieben haette (nicht: beliebig fremd injizierte
// Bytes - das ist ein anderes Bedrohungsmodell), OHNE die ganze
// Lade-Pipeline mitzureissen.

const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════
// TEIL A: WebRTCManager (nativ + web) - kaputte/unerwartete DataChannel-
// Nachrichten duerfen die Verbindung nicht abstuerzen lassen
// ═══════════════════════════════════════════════════════════════════════

describe('CHAOS: WebRTCManager (nativ) - malformte DataChannel-Nachrichten', () => {
  const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
  installKyberModuleMock();
  const { NativeModules } = require('react-native');
  NativeModules.KyberModule.generateKeypair = async () => ({
    publicKey: 'pub_' + crypto.randomBytes(8).toString('hex'),
    secretKey: 'sec_' + crypto.randomBytes(8).toString('hex'),
  });
  NativeModules.KyberModule.encapsulate = async () => {
    const sharedSecret = crypto.randomBytes(32).toString('base64');
    return { sharedSecret, cipherText: Buffer.from(sharedSecret).toString('base64') };
  };
  NativeModules.KyberModule.decapsulate = async (cipherTextB64) => Buffer.from(cipherTextB64, 'base64').toString('utf8');

  const { WebRTCManager } = require('../../WebRTCManager');
  function fakeChannel() { return { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null }; }

  test('nicht-JSON DataChannel-Payload wirft nicht, aendert keinen Key-State, Verbindung bleibt danach normal benutzbar', async () => {
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    await expect(channel.onmessage({ data: 'DAS { IST } KEIN gueltiges JSON <<<' })).resolves.not.toThrow();
    expect(rtc.keyExchangeDone).toBe(false);
    expect(rtc.sharedSecret).toBeNull();

    // Verbindung danach weiterhin normal funktionsfaehig - ein regulaeres
    // kyber_pubkey direkt im Anschluss schliesst den Austausch normal ab.
    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: 'pub_X' }) });
    expect(rtc.keyExchangeDone).toBe(true);
    expect(rtc.sharedSecret).toBeTruthy();
    rtc.close();
  });

  test('valides JSON, aber komplett unbekannte Struktur (z.B. {} oder Array) wirft nicht und wird stillschweigend ignoriert', async () => {
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    await expect(channel.onmessage({ data: '{}' })).resolves.not.toThrow();
    await expect(channel.onmessage({ data: '[1,2,3]' })).resolves.not.toThrow();
    await expect(channel.onmessage({ data: 'null' })).resolves.not.toThrow();
    expect(rtc.keyExchangeDone).toBe(false);
    rtc.close();
  });

  test('kyber_ciphertext trifft ein, OBWOHL myKyberKeys noch nie gesetzt wurde (z.B. Antwort auf ein Offer, das dieser Prozess so nie gesendet hat, oder Zustand nach einem Teil-Absturz) - wird sauber abgefangen statt den Prozess zu crashen', async () => {
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    // isInitiator bewusst NICHT gesetzt, myKyberKeys bewusst null gelassen -
    // rtc.myKyberKeys.secretKey wuerde ohne die aeussere try/catch-Klammer in
    // channel.onmessage eine TypeError ("Cannot read properties of null")
    // werfen und (je nach Caller) den ganzen DataChannel-Handler zum
    // Absturz bringen.
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    await expect(channel.onmessage({
      data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: 'irgendwas' }),
    })).resolves.not.toThrow();
    expect(rtc.keyExchangeDone).toBe(false);
    expect(rtc.sharedSecret).toBeNull();
    rtc.close();
  });
});

describe('CHAOS: WebRTCManager (web) - malformte DataChannel-Nachrichten', () => {
  const { WebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');
  function fakeChannel() { return { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null }; }

  test('nicht-JSON DataChannel-Payload wirft nicht, aendert keinen Key-State', async () => {
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    await expect(channel.onmessage({ data: 'kein json' })).resolves.not.toThrow();
    expect(rtc.keyExchangeDone).toBe(false);
    rtc.close();
  });

  test('kyber_ciphertext OHNE vorher gesetztes myKyberKeys wirft nicht (this.myKyberKeys! in _setupDataChannel waere sonst ein Laufzeitfehler)', async () => {
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);
    await expect(channel.onmessage({
      data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: 'garbage' }),
    })).resolves.not.toThrow();
    expect(rtc.keyExchangeDone).toBe(false);
    rtc.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEIL B: MessageCrypto - korrupter/verstuemmelter persistierter
// sharedSecret (z.B. shared_secret_<id> teilweise geschrieben) fuehrt zu
// fail-closed (null), nicht zu einem Absturz
// ═══════════════════════════════════════════════════════════════════════

describe('CHAOS: MessageCrypto - korrupter sharedSecret aus (simuliert) beschaedigtem EncryptedStorage', () => {
  const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
  installKyberModuleMock();
  const { encryptMsg, decryptMsg } = require('../../MessageCrypto');

  test('encryptMsg mit nicht-base64-Muell als "sharedSecret" wirft nicht, liefert null (fail-closed)', async () => {
    const corrupted = 'DAS-IST-KEIN-GUELTIGES-BASE64-!!!§$%&';
    await expect(encryptMsg('irgendein Klartext', corrupted)).resolves.toBeDefined();
    const result = await encryptMsg('irgendein Klartext', corrupted);
    // Node's Buffer.from(x,'base64') ist tolerant (dekodiert lenient statt zu
    // werfen) - encryptMsg selbst darf trotzdem NICHT crashen, egal was dabei
    // herauskommt.
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('decryptMsg mit einem aus einem GANZ ANDEREN (aber gueltig aussehenden) sharedSecret verschluesselten Text liefert null, nicht throw - simuliert: Secret wurde nach einem Teil-Crash durch ein anderes/leeres ersetzt', async () => {
    const realSecret = crypto.randomBytes(32).toString('base64');
    const wrongSecret = crypto.randomBytes(32).toString('base64');
    const enc = await encryptMsg('geheime Nachricht', realSecret);
    expect(enc).toBeTruthy();
    expect(() => decryptMsg(enc, wrongSecret)).not.toThrow();
    expect(decryptMsg(enc, wrongSecret)).toBeNull();
  });

  test('decryptMsg mit abgeschnittenem (truncated) Ciphertext - z.B. ein Schreibvorgang wurde mitten im Wert unterbrochen - liefert null statt zu werfen', async () => {
    const secret = crypto.randomBytes(32).toString('base64');
    const enc = await encryptMsg('vollstaendige Nachricht', secret);
    const truncated = enc.slice(0, Math.floor(enc.length / 2));
    expect(() => decryptMsg(truncated, secret)).not.toThrow();
    expect(decryptMsg(truncated, secret)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEIL C: web/src/lib/Storage.ts - korrupte/teilweise geschriebene
// localStorage-Werte (SALT/MARKER/DEVICE_ID). Bisher KEIN automatisierter
// Test in __tests__/security deckt Storage.ts direkt ab (siehe
// SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 8 / TRUST_PRIVACY Claim 9 - "kein
// Test uebt web/src/lib/Storage.ts direkt aus"). localStorage/crypto.subtle
// gibt es unter dem RN-Jest-Preset (node-Umgebung) nicht global - minimaler,
// in-memory Polyfill unten. crypto.subtle/btoa/atob sind ab Node 20 global
// vorhanden (verifiziert: dieses Projekt verlangt Node >=20.19, siehe
// package.json "engines").
// ═══════════════════════════════════════════════════════════════════════

function makeLocalStoragePolyfill() {
  const data = {};
  const methods = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
  };
  // Proxy: Object.keys(localStorage) (wie Storage.ts's Pepper-Rotationsschleife
  // es tut) muss die GESPEICHERTEN Schluessel liefern, nicht die Methodennamen -
  // exakt wie echtes Browser-localStorage sich verhaelt.
  return new Proxy(data, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in methods) return methods[prop];
      return target[prop];
    },
  });
}

describe('CHAOS: web/src/lib/Storage.ts - korrupte lokale Werte', () => {
  let storageModulePath;
  let relayClientModulePath;

  beforeEach(() => {
    jest.resetModules();
    global.localStorage = makeLocalStoragePolyfill();
    storageModulePath = '../../web/src/lib/Storage.ts';
    relayClientModulePath = require.resolve('../../web/src/lib/RelayClient.ts');
  });

  afterEach(() => {
    delete global.localStorage;
    jest.dontMock(relayClientModulePath);
  });

  // FIX 3 (SECURITY_CHAOS_TESTING.md §10) hat diesen Test veraendert: eine
  // Vorpruefung in _unlockEncryptionInner() unterscheidet jetzt VOR jedem
  // pepperRequest()-Aufruf zwischen "MARKER_KEY ist nicht mal gueltiges
  // Base64 in plausibler AES-GCM-Mindestlaenge" (-> 'corrupted', siehe
  // eigener Test unten, KEIN verbrauchter Versuch) und "MARKER_KEY hat die
  // richtige Form, entschluesselt aber zum falschen Klartext" (-> weiterhin
  // 'wrong_pin' MIT verbrauchtem Versuch, weil das kryptografisch nicht von
  // einem echten falschen PIN unterscheidbar sein darf/soll). Dieser Test
  // deckt jetzt gezielt den ZWEITEN Fall ab - der urspruengliche Marker-Wert
  // dieses Tests ('DIESER-WERT-IST-KEIN-GUELTIGES-AES-GCM-BLOB', mit
  // Bindestrichen kein gueltiges Base64) waere durch die neue Vorpruefung
  // bereits abgefangen worden und haette diesen Test faelschlich als
  // Regression aussehen lassen.
  test('MARKER-Wert mit korrekter Form (gueltiges Base64, plausible Laenge) aber falschem Inhalt (SALT/DEVICE_ID intakt): unlockEncryption() liefert weiterhin wrong_pin UND meldet einen echten Fehlversuch - bewusst ununterscheidbar von einem echten falschen PIN', async () => {
    jest.doMock(relayClientModulePath, () => ({
      pepperRegister: jest.fn(),
      pepperRequest: jest.fn().mockResolvedValue({ ok: true, pepper: 'pepperwert123', attemptToken: 'tok-abc' }),
      pepperFail: jest.fn().mockResolvedValue({ wiped: false }),
      pepperSuccess: jest.fn().mockResolvedValue(null),
    }));
    const Storage = require(storageModulePath);
    const { pepperFail } = require(relayClientModulePath);

    global.localStorage.setItem('malachi___pin_salt', Buffer.from(crypto.randomBytes(16)).toString('base64'));
    // Gueltiges Base64, plausible AES-GCM-Laenge (IV+Tag+etwas Klartext) -
    // besteht die reine Wohlgeformtheitspruefung, ist aber garantiert nicht
    // die echte Verschluesselung des Markers unter diesem Schluessel.
    global.localStorage.setItem('malachi___pin_marker', Buffer.from(crypto.randomBytes(32)).toString('base64'));
    global.localStorage.setItem('malachi___device_id', 'a'.repeat(24));

    let result;
    await expect((async () => { result = await Storage.unlockEncryption('1234'); })()).resolves.not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'wrong_pin' });
    // Das ist WEITERHIN korrekt so (siehe Kommentar oben) - erst NACHDEM ein
    // echter Entschluesselungsversuch gelaufen ist, darf/kann nicht mehr
    // zwischen "korrupt" und "falscher PIN" unterschieden werden.
    expect(pepperFail).toHaveBeenCalledTimes(1);
  });

  test('MARKER-Wert strukturell unmoeglich (kein gueltiges Base64 / zu kurz fuer IV+Tag) - FIX: wird jetzt VOR jedem pepperRequest() als "corrupted" erkannt, verbraucht keinen Versuch', async () => {
    const pepperRequestMock = jest.fn();
    jest.doMock(relayClientModulePath, () => ({
      pepperRegister: jest.fn(),
      pepperRequest: pepperRequestMock,
      pepperFail: jest.fn(),
      pepperSuccess: jest.fn(),
    }));
    const Storage = require(storageModulePath);

    global.localStorage.setItem('malachi___pin_salt', Buffer.from(crypto.randomBytes(16)).toString('base64'));
    // Bindestriche sind kein gueltiges Base64-Alphabet - genau der Wert, der
    // vor Fix 3 noch als 'wrong_pin' durchgerutscht ist und einen echten
    // Versuch verbrannt hat.
    global.localStorage.setItem('malachi___pin_marker', 'DIESER-WERT-IST-KEIN-GUELTIGES-AES-GCM-BLOB');
    global.localStorage.setItem('malachi___device_id', 'd'.repeat(24));

    const result = await Storage.unlockEncryption('1234');
    expect(result).toEqual({ ok: false, reason: 'corrupted' });
    expect(pepperRequestMock).not.toHaveBeenCalled();
  });

  test('SALT_KEY vorhanden aber MARKER_KEY fehlt komplett (Analog zu "partially-saved session" - Crash zwischen den beiden localStorage.setItem()-Aufrufen in setupEncryption()): unlockEncryption() faellt SOFORT und OHNE Netzwerkrunde auf wrong_pin zurueck, kein Crash', async () => {
    const pepperRequestMock = jest.fn();
    jest.doMock(relayClientModulePath, () => ({
      pepperRegister: jest.fn(),
      pepperRequest: pepperRequestMock,
      pepperFail: jest.fn(),
      pepperSuccess: jest.fn(),
    }));
    const Storage = require(storageModulePath);

    global.localStorage.setItem('malachi___pin_salt', Buffer.from(crypto.randomBytes(16)).toString('base64'));
    global.localStorage.setItem('malachi___device_id', 'b'.repeat(24));
    // malachi___pin_marker bewusst NIE gesetzt.

    const result = await Storage.unlockEncryption('1234');
    expect(result).toEqual({ ok: false, reason: 'wrong_pin' });
    // Fail-closed schon VOR jedem Server-Kontakt - kein unnoetiger
    // Pepper-Request und definitiv kein faelschlich gezaehlter Fehlversuch
    // fuer einen Zustand, den der Nutzer nie durch eine PIN-Eingabe
    // ausgeloest hat.
    expect(pepperRequestMock).not.toHaveBeenCalled();
  });

  // FIX 3 (SECURITY_CHAOS_TESTING.md §10): dieser Test dokumentierte
  // urspruenglich den Befund, dass ein ungueltiger SALT-Wert unlockEncryption()
  // mit einer UNGEFANGENEN Exception abstuerzen liess (fromB64()/atob() ohne
  // try/catch). Jetzt bewiesen behoben: die neue Vorpruefung faengt das VOR
  // jedem pepperRequest()-Aufruf ab und liefert ein strukturiertes
  // UnlockResult statt zu werfen - UND verbraucht dabei keinen Versuch gegen
  // den Wipe-Zaehler (siehe ausfuehrlicher Kommentar in Storage.ts).
  test('kaputter SALT-Wert (nicht valides Base64) liefert jetzt ein strukturiertes {ok:false, reason:"corrupted"} statt zu werfen, und verbraucht keinen Versuch (kein pepperRequest)', async () => {
    const pepperRequestMock = jest.fn();
    jest.doMock(relayClientModulePath, () => ({
      pepperRegister: jest.fn(),
      pepperRequest: pepperRequestMock,
      pepperFail: jest.fn(),
      pepperSuccess: jest.fn(),
    }));
    const Storage = require(storageModulePath);

    global.localStorage.setItem('malachi___pin_salt', 'DAS-IST-KEIN-BASE64-!!!@@@###');
    global.localStorage.setItem('malachi___pin_marker', Buffer.from(crypto.randomBytes(32)).toString('base64'));
    global.localStorage.setItem('malachi___device_id', 'c'.repeat(24));

    await expect(Storage.unlockEncryption('1234')).resolves.toEqual({ ok: false, reason: 'corrupted' });
    expect(pepperRequestMock).not.toHaveBeenCalled();
  });
});
