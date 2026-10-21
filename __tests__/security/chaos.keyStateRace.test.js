// CHAOS/RESILIENCE PASS - "Process/state chaos": Client-Crash / App-Kill
// waehrend eines kryptografischen Vorgangs (siehe Task-Mandat, deckt sich mit
// SECURITY_STATE_MACHINES.md §4 Finding 11 / §5 - "unterschiedliche Secrets
// nach Neustart", dort beschrieben aber bisher ohne dedizierten Test).
//
// Kernidee: this.sharedSecret wird SOFORT synchron im RAM gesetzt (RAM ist
// sofort "wahr"), die Persistierung auf Disk ist ein fire-and-forget
// Seitenschritt (WebRTCManager.js:334-338 / web .ts:270-272 -
// `import('react-native-encrypted-storage').then(...)` bzw. `setItem(...)
// .catch(()=>{})`), den der Handler NICHT awaitet. Stirbt der Prozess in
// genau diesem Fenster, bleibt auf der Platte der ALTE oder GAR KEIN Wert
// stehen, waehrend die Gegenseite (die ihr eigenes Fenster ueberlebt hat)
// bereits mit dem NEUEN Secret weiterlaeuft.
//
// Testaufbau: echte WebRTCManager-Instanzen (nativ + web), echter
// Kyber-Handshake ueber zwei manuell verdrahtete Faelschungs-DataChannels
// (kein Netzwerk noetig - reiner In-Process-Nachrichtenaustausch, exakt wie
// im bestehenden stateMachine.keyExchangeDuplicate.test.js). Die
// Persistierung selbst wird NICHT ueber den echten (gemeinsamen,
// Modul-weiten) EncryptedStorage-Mock simuliert, weil beide Seiten in der
// Realitaet UNABHAENGIGE Geraete mit unabhaengigen Storages sind - ein
// gemeinsamer Mock wuerde die beiden Seiten kuenstlich zusammenfallen
// lassen. Stattdessen: zwei separate, einfache Map-basierte "Geraete-Disks",
// die exakt denselben fire-and-forget-Charakter nachbilden (das echte
// this.sharedSecret-Setzen und der echte Handshake laufen unveraendert ueber
// den echten Code; nur der Disk-Schreibvorgang selbst - "wurde er vor dem
// Absturz fertig oder nicht" - wird pro simuliertem Geraet gezielt
// gesteuert).

const crypto = require('crypto');

function makeAsyncChannel() {
  return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null };
}

describe('CHAOS: Key State Race (nativ) - Absturz zwischen Kyber-Abschluss und Disk-Persistierung', () => {
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
  const { encryptMsg, decryptMsg } = require('../../MessageCrypto');

  test('Initiator stirbt NACH Empfang von kyber_ciphertext aber VOR abgeschlossenem Disk-Write; Responder ueberlebt seinen eigenen Write - nach "Neustart" haben beide Seiten unterschiedliche (Initiator: gar keine) Secrets', async () => {
    const sentByInitiator = [];
    const sentByResponder = [];
    const chInit = makeAsyncChannel(); chInit.send = (d) => sentByInitiator.push(d);
    const chResp = makeAsyncChannel(); chResp.send = (d) => sentByResponder.push(d);

    const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
    rtcInit.isInitiator = true;
    rtcInit._setupDataChannel(chInit);
    const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
    rtcResp._setupDataChannel(chResp);

    // Schritt 1: Initiator generiert Schluesselpaar + sendet kyber_pubkey
    // (mirrort exakt den onopen-Zweig, WebRTCManager.js:286-298, ohne den
    // Rest von onopen - der ruft nur zusaetzlich onConnected auf, irrelevant
    // fuer diesen Test).
    rtcInit.myKyberKeys = await NativeModules.KyberModule.generateKeypair();
    chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

    // Schritt 2: Responder verarbeitet es ECHT (produktiver Code-Pfad) -
    // encapsuliert, setzt sharedSecret SOFORT synchron im RAM, sendet
    // kyber_ciphertext zurueck.
    await chResp.onmessage({ data: sentByInitiator[0] });
    expect(rtcResp.keyExchangeDone).toBe(true);
    const responderSecret = rtcResp.sharedSecret;
    expect(responderSecret).toBeTruthy();

    // Schritt 3: Initiator verarbeitet die Antwort ECHT - decapsuliert,
    // setzt sharedSecret SOFORT synchron im RAM. Ab hier funktioniert der
    // Chat fuer BEIDE Seiten in dieser Sitzung normal (beide haben dasselbe
    // Secret im RAM) - das ist der Punkt: der Bug zeigt sich NICHT jetzt,
    // sondern erst nach einem Neustart.
    await chInit.onmessage({ data: sentByResponder[0] });
    expect(rtcInit.keyExchangeDone).toBe(true);
    const initiatorSecretInRam = rtcInit.sharedSecret;
    expect(initiatorSecretInRam).toBe(responderSecret); // beide Seiten synchron, wie erwartet

    // Simulierte Disk-Persistierung - zwei UNABHAENGIGE Geraete-"Platten".
    // Responder: sein Geraet bleibt am Leben, der fire-and-forget-Write
    // (WebRTCManager.js:334-338, in Produktion NIE vom Handler awaitet)
    // "schafft es" vor Prozessende.
    const responderDisk = new Map();
    responderDisk.set('shared_secret_contactX', responderSecret);

    // Initiator: sein Geraet wird GENAU in diesem Fenster (nach dem
    // synchronen sharedSecret-Set in RAM, aber vor dem asynchronen,
    // unawaiteten Disk-Write) hart beendet - der Schreibvorgang findet
    // nie statt. Bewusst KEIN .set()-Aufruf hier.
    const initiatorDisk = new Map();

    // "Neustart" - App.tsx laedt beim naechsten Start
    // EncryptedStorage.getItem('shared_secret_'+id) pro Kontakt
    // (App.tsx:422/445) und befuellt RTCStore.sharedSecrets daraus. Mirrort
    // exakt diesen Lese-Schritt pro simuliertem Geraet.
    function reloadAfterRestart(disk) { return disk.get('shared_secret_contactX') || null; }
    const initiatorSecretAfterRestart = reloadAfterRestart(initiatorDisk);
    const responderSecretAfterRestart = reloadAfterRestart(responderDisk);

    // DER KERNBEFUND: nach dem Neustart hat der Initiator UEBERHAUPT KEIN
    // Secret mehr (nicht einmal das alte, weil es fuer diese Verbindung nie
    // eins vor diesem Handshake gab) - der Responder hat weiterhin das echte,
    // aktuelle Secret. Die beiden Zustaende sind nachweisbar verschieden.
    expect(initiatorSecretAfterRestart).toBeNull();
    expect(responderSecretAfterRestart).toBe(responderSecret);
    expect(initiatorSecretAfterRestart).not.toBe(responderSecretAfterRestart);

    // Konkrete Konsequenz, nicht nur ein abstrakter Zustandsunterschied:
    // eine vom Responder mit seinem (korrekten, persistierten) Secret
    // verschluesselte Nachricht kann der Initiator nach dem Neustart NICHT
    // mehr entschluesseln - aber (Invariante 2/4 aus dem Chaos-Mandat)
    // FAIL-CLOSED: kein Crash, keine falsch akzeptierte Nachricht, einfach
    // `null`.
    const enc = await encryptMsg(JSON.stringify({ type: 'text', text: 'Nachricht nach Neustart' }), responderSecretAfterRestart);
    expect(enc).toBeTruthy();
    expect(() => decryptMsg(enc, initiatorSecretAfterRestart)).not.toThrow();
    expect(decryptMsg(enc, initiatorSecretAfterRestart)).toBeNull();

    rtcInit.close();
    rtcResp.close();
  });

  test('Struktur-Invariante: zwischen dem Setzen von sharedSecret und keyExchangeDone gibt es in BEIDEN Handlern keinen await-Punkt - der Zwischenzustand (keyExchangeDone=true, sharedSecret=null oder umgekehrt) ist ueber einen normalen Prozess-Kill strukturell nicht erreichbar (ein echter Mid-Statement-Kill laesst sich unter Jest nicht simulieren, siehe Bericht)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../WebRTCManager.js'), 'utf8');
    // Beide Handler pruefen: this.sharedSecret = ...; this.keyExchangeDone = true;
    // stehen im Quelltext unmittelbar aufeinanderfolgend (kein 'await'
    // dazwischen) - regex bewusst tolerant gegenueber Kommentaren/Leerzeilen,
    // aber intolerant gegenueber einem 'await' dazwischen. WICHTIG: erst ab
    // "channel.onmessage" suchen - sendMessage() weiter oben im selben File
    // enthaelt dieselben Teilstrings ("subtype === 'kyber_pubkey'") in einem
    // voellig anderen Kontext (Plaintext-Versand-Weiche) und wuerde sonst
    // den falschen Codeblock treffen.
    const onmessageStart = src.indexOf('channel.onmessage = async');
    expect(onmessageStart).toBeGreaterThan(-1);
    const onmessageSrc = src.slice(onmessageStart);
    const pubkeyBlock = onmessageSrc.slice(onmessageSrc.indexOf("subtype === 'kyber_pubkey'"), onmessageSrc.indexOf("subtype === 'kyber_ciphertext'"));
    const ciphertextBlock = onmessageSrc.slice(onmessageSrc.indexOf("subtype === 'kyber_ciphertext'"), onmessageSrc.indexOf("msg.type === 'encrypted'"));
    for (const [name, block] of [['kyber_pubkey', pubkeyBlock], ['kyber_ciphertext', ciphertextBlock]]) {
      // Gezielt die ZUWEISUNG suchen, nicht jede Erwaehnung - beide Handler
      // beginnen mit einer LESENDEN Pruefung `if (this.keyExchangeDone) {
      // ... return; }` (der in dieser Review-Runde ergaenzte
      // Duplikat/Replay-Schutz), die vor der eigentlichen Zuweisung liegt
      // und einen naiven indexOf() sonst in die Irre fuehrt.
      const secretMatch = block.match(/this\.sharedSecret\s*=\s*[^=]/);
      const doneMatch = block.match(/this\.keyExchangeDone\s*=\s*true/);
      expect(secretMatch).not.toBeNull();
      expect(doneMatch).not.toBeNull();
      expect(doneMatch.index).toBeGreaterThan(secretMatch.index);
      // Wichtig: das Statement `this.sharedSecret = await kyberDecapsulate(...)`
      // enthaelt selbst ein 'await' (rechts vom '=', TEIL der Berechnung des
      // zuzuweisenden Werts - der ciphertext-Handler awaitet ja gerade
      // deshalb, weil kyberDecapsulate() asynchron ist). Das ist erwuenscht
      // und kein Gegenbeispiel zur Invariante - relevant ist nur, ob NACH
      // dem Ende DIESES Zuweisungs-Statements (also nach seinem
      // abschliessenden Semikolon) und vor `this.keyExchangeDone = true`
      // noch ein weiterer await-Punkt liegt. Ab dem Semikolon nach
      // secretMatch suchen, nicht ab dem Beginn des Statements.
      const stmtEnd = block.indexOf(';', secretMatch.index);
      expect(stmtEnd).toBeGreaterThan(-1);
      const between = block.slice(stmtEnd, doneMatch.index);
      expect(between).not.toMatch(/\bawait\b/);
    }
  });
});

describe('CHAOS: Key State Race (nativ) - Fix 2 verifiziert: Persistierung wird jetzt AWAITED', () => {
  // Beweist die konkrete Wirkung des Fixes (nicht nur den Quelltext): der
  // Disk-Write wird kuenstlich verzoegert (Gate-Promise) und waehrenddessen
  // geprueft, dass _flushPending() - und damit alles, was sich auf eine
  // bereits abgeschlossene, durabel gespeicherte Pairing verlaesst - NOCH
  // NICHT gelaufen ist. Vor dem Fix (fire-and-forget `.then()`) waere
  // _flushPending() zu diesem Zeitpunkt laengst durchgelaufen, weil der
  // Handler nie auf den Schreibvorgang wartete.
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

  test('Responder-Handler (kyber_pubkey): _flushPending laeuft erst NACH abgeschlossenem Disk-Write, nicht schon parallel dazu', async () => {
    const EncryptedStorage = require('react-native-encrypted-storage').default;
    const originalSetItem = EncryptedStorage.setItem;
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const setItemMock = jest.fn((key, value) => gate.then(() => originalSetItem(key, value)));
    EncryptedStorage.setItem = setItemMock;

    try {
      const sentByInitiator = [];
      const chInit = makeAsyncChannel(); chInit.send = (d) => sentByInitiator.push(d);
      const chResp = makeAsyncChannel(); chResp.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit._setupDataChannel(chInit);
      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactFix2Native';
      rtcResp._setupDataChannel(chResp);

      rtcInit.myKyberKeys = await NativeModules.KyberModule.generateKeypair();
      chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

      let flushCalled = false;
      const originalFlush = rtcResp._flushPending.bind(rtcResp);
      rtcResp._flushPending = async (...args) => { flushCalled = true; return originalFlush(...args); };

      const handlerPromise = chResp.onmessage({ data: sentByInitiator[0] });

      // Kurz warten, WAEHREND der simulierte Disk-Write noch haengt (Gate
      // nicht freigegeben).
      await new Promise((r) => setTimeout(r, 20));
      expect(rtcResp.sharedSecret).toBeTruthy(); // RAM-Zustand weiterhin sofort da (unveraendert)
      expect(setItemMock).toHaveBeenCalledWith('shared_secret_contactFix2Native', rtcResp.sharedSecret);
      // DER FIX: _flushPending haengt jetzt HINTER dem awaiteten Schreibvorgang.
      expect(flushCalled).toBe(false);

      releaseWrite();
      await handlerPromise;
      expect(flushCalled).toBe(true); // laeuft, sobald (und erst nachdem) der Write durch ist

      rtcInit.close();
      rtcResp.close();
    } finally {
      EncryptedStorage.setItem = originalSetItem;
    }
  });

  test('scheitert der Disk-Write (z.B. Speicher voll), bricht der Handshake selbst nicht ab - Persistierungsfehler bleiben nicht-fatal', async () => {
    const EncryptedStorage = require('react-native-encrypted-storage').default;
    const originalSetItem = EncryptedStorage.setItem;
    EncryptedStorage.setItem = jest.fn(() => Promise.reject(new Error('Speicher voll (simuliert)')));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sentByInitiator = [];
      const chInit = makeAsyncChannel(); chInit.send = (d) => sentByInitiator.push(d);
      const chResp = makeAsyncChannel(); chResp.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit._setupDataChannel(chInit);
      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactFix2NativeFail';
      rtcResp._setupDataChannel(chResp);

      rtcInit.myKyberKeys = await NativeModules.KyberModule.generateKeypair();
      chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

      await chResp.onmessage({ data: sentByInitiator[0] });

      // Trotz fehlgeschlagenem Schreibvorgang: RAM-Zustand ist korrekt gesetzt,
      // der Handshake ist fuer DIESE Sitzung nutzbar (kein Absturz, kein
      // haengender Handler) - nur die Durabilitaet ueber einen Neustart hinweg
      // fehlt, was ehrlich geloggt statt stillschweigend verschluckt wird.
      expect(rtcResp.keyExchangeDone).toBe(true);
      expect(rtcResp.sharedSecret).toBeTruthy();
      expect(warnSpy).toHaveBeenCalled();

      rtcInit.close();
      rtcResp.close();
    } finally {
      EncryptedStorage.setItem = originalSetItem;
      warnSpy.mockRestore();
    }
  });
});

describe('CHAOS: Key State Race (web) - Absturz zwischen Kyber-Abschluss und Disk-Persistierung', () => {
  const { WebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');
  const { generateKyberKeypair } = require('../../web/src/lib/HybridCrypto.ts');
  const { encryptMsg, decryptMsg } = require('../../web/src/lib/MessageCrypto.ts');

  function makeChannel() { return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null }; }

  test('dieselbe Divergenz mit echtem ML-KEM-768 (@noble/post-quantum) statt Bridge-Mock', async () => {
    const sentByInitiator = [];
    const sentByResponder = [];
    const chInit = makeChannel(); chInit.send = (d) => sentByInitiator.push(d);
    const chResp = makeChannel(); chResp.send = (d) => sentByResponder.push(d);

    const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
    rtcInit.isInitiator = true;
    rtcInit._setupDataChannel(chInit);
    const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
    rtcResp._setupDataChannel(chResp);

    rtcInit.myKyberKeys = await generateKyberKeypair();
    chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

    await chResp.onmessage({ data: sentByInitiator[0] });
    const responderSecret = rtcResp.sharedSecret;
    expect(responderSecret).toBeTruthy();

    await chInit.onmessage({ data: sentByResponder[0] });
    expect(rtcInit.sharedSecret).toBe(responderSecret);

    const responderDisk = new Map();
    responderDisk.set('shared_secret_contactX', responderSecret);
    const initiatorDisk = new Map(); // Initiator-Geraet "stirbt" vor dem Write

    function reloadAfterRestart(disk) { return disk.get('shared_secret_contactX') || null; }
    const initiatorAfter = reloadAfterRestart(initiatorDisk);
    const responderAfter = reloadAfterRestart(responderDisk);

    expect(initiatorAfter).toBeNull();
    expect(responderAfter).toBe(responderSecret);

    const enc = await encryptMsg(JSON.stringify({ type: 'text', text: 'hallo' }), responderAfter);
    expect(() => decryptMsg(enc, initiatorAfter)).not.toThrow();
    expect(decryptMsg(enc, initiatorAfter)).toBeNull();

    rtcInit.close();
    rtcResp.close();
  });

  test('Struktur-Invariante (web): kein await zwischen sharedSecret- und keyExchangeDone-Zuweisung in beiden Handlern', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../web/src/lib/WebRTCManager.ts'), 'utf8');
    // Siehe Kommentar in der nativen Variante oben - ab channel.onmessage
    // suchen, sonst trifft es sendMessage()'s gleichlautende Teilstrings.
    const onmessageStart = src.indexOf('channel.onmessage = async');
    expect(onmessageStart).toBeGreaterThan(-1);
    const onmessageSrc = src.slice(onmessageStart);
    const pubkeyBlock = onmessageSrc.slice(onmessageSrc.indexOf("subtype === 'kyber_pubkey'"), onmessageSrc.indexOf("subtype === 'kyber_ciphertext'"));
    const ciphertextBlock = onmessageSrc.slice(onmessageSrc.indexOf("subtype === 'kyber_ciphertext'"), onmessageSrc.indexOf("msg.type === 'encrypted'"));
    for (const block of [pubkeyBlock, ciphertextBlock]) {
      const secretMatch = block.match(/this\.sharedSecret\s*=\s*[^=]/);
      const doneMatch = block.match(/this\.keyExchangeDone\s*=\s*true/);
      expect(secretMatch).not.toBeNull();
      expect(doneMatch).not.toBeNull();
      expect(doneMatch.index).toBeGreaterThan(secretMatch.index);
      // Siehe ausfuehrlicher Kommentar in der nativen Variante oben - ab dem
      // Ende DES Zuweisungs-Statements messen, nicht ab seinem Anfang (das
      // Statement selbst darf rechts vom '=' awaiten).
      const stmtEnd = block.indexOf(';', secretMatch.index);
      expect(stmtEnd).toBeGreaterThan(-1);
      const between = block.slice(stmtEnd, doneMatch.index);
      expect(between).not.toMatch(/\bawait\b/);
    }
  });
});

describe('CHAOS: Key State Race (web) - Fix 2 verifiziert: Persistierung wird jetzt AWAITED', () => {
  // Identischer Beweis wie in der nativen Variante oben, hier gegen
  // web/src/lib/Storage.ts's setItem() (statt EncryptedStorage) - siehe
  // dortiger Kommentar fuer die Begruendung des Testaufbaus.
  const Storage = require('../../web/src/lib/Storage.ts');
  const { WebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');
  const { generateKyberKeypair } = require('../../web/src/lib/HybridCrypto.ts');

  function makeChannel() { return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null }; }

  test('Responder-Handler (kyber_pubkey): _flushPending laeuft erst NACH abgeschlossenem Storage-Write', async () => {
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const setItemSpy = jest.spyOn(Storage, 'setItem').mockImplementation(async () => { await gate; });

    try {
      const sentByInitiator = [];
      const chInit = makeChannel(); chInit.send = (d) => sentByInitiator.push(d);
      const chResp = makeChannel(); chResp.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit._setupDataChannel(chInit);
      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactFix2Web';
      rtcResp._setupDataChannel(chResp);

      rtcInit.myKyberKeys = await generateKyberKeypair();
      chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

      let flushCalled = false;
      const originalFlush = rtcResp._flushPending.bind(rtcResp);
      rtcResp._flushPending = async (...args) => { flushCalled = true; return originalFlush(...args); };

      const handlerPromise = chResp.onmessage({ data: sentByInitiator[0] });

      await new Promise((r) => setTimeout(r, 20));
      expect(rtcResp.sharedSecret).toBeTruthy(); // RAM-Zustand weiterhin sofort da (unveraendert)
      expect(setItemSpy).toHaveBeenCalledWith('shared_secret_contactFix2Web', rtcResp.sharedSecret);
      // DER FIX: _flushPending haengt jetzt HINTER dem awaiteten Schreibvorgang.
      expect(flushCalled).toBe(false);

      releaseWrite();
      await handlerPromise;
      expect(flushCalled).toBe(true);

      rtcInit.close();
      rtcResp.close();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  test('scheitert der Storage-Write, bricht der Handshake selbst nicht ab - Persistierungsfehler bleiben nicht-fatal', async () => {
    const setItemSpy = jest.spyOn(Storage, 'setItem').mockRejectedValue(new Error('Storage voll (simuliert)'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sentByInitiator = [];
      const chInit = makeChannel(); chInit.send = (d) => sentByInitiator.push(d);
      const chResp = makeChannel(); chResp.send = () => {};

      const rtcInit = new WebRTCManager(() => {}, () => {}, () => {});
      rtcInit.isInitiator = true;
      rtcInit._setupDataChannel(chInit);
      const rtcResp = new WebRTCManager(() => {}, () => {}, () => {});
      rtcResp.chatId = 'contactFix2WebFail';
      rtcResp._setupDataChannel(chResp);

      rtcInit.myKyberKeys = await generateKyberKeypair();
      chInit.send(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: rtcInit.myKyberKeys.publicKey }));

      await chResp.onmessage({ data: sentByInitiator[0] });

      expect(rtcResp.keyExchangeDone).toBe(true);
      expect(rtcResp.sharedSecret).toBeTruthy();
      expect(warnSpy).toHaveBeenCalled();

      rtcInit.close();
      rtcResp.close();
    } finally {
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
