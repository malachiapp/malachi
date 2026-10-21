// State-Machine-Sicherheitsreview (siehe SECURITY_STATE_MACHINES.md, Abschnitt
// "Key State"): WebRTCManager verarbeitete kyber_pubkey/kyber_ciphertext
// bisher OHNE zu pruefen, ob fuer diese Verbindung schon ein
// Schluesselaustausch abgeschlossen war (this.keyExchangeDone). Ein zweites,
// dupliziertes oder auf dem DataChannel wiedereingespieltes kyber_pubkey/
// kyber_ciphertext hat dadurch mitten in einer laufenden Sitzung
// stillschweigend ein KOMPLETT NEUES sharedSecret erzeugt und das alte
// ueberschrieben - ohne jedes Signal an Nutzer oder App, und ohne dass
// Nachrichten, die gerade unter dem alten Secret unterwegs waren, noch
// entschluesselbar blieben.
//
// kyber_pubkey/kyber_ciphertext laufen bewusst als Klartext VOR dem
// Schluesselaustausch (siehe sendMessage() - "Key-Exchange Nachrichten immer
// plain"), und der Live-DataChannel-Pfad hat (anders als der Relay-Fallback)
// keinen allgemeinen Replay-/Frische-Schutz fuer Systempakete. Diese beiden
// Nachrichtentypen sind deshalb die einzigen, die ein aktiver Angreifer mit
// Schreibzugriff auf den DataChannel (z.B. ueber einen kompromittierten TURN-
// Server im Media-/Datenpfad bei NAT-Traversal-Fehlern) beliebig oft
// wiederholen koennte, um eine laufende Sitzung jederzeit auf ein ihm
// bekanntes/beeinflussbares Secret zu zwingen - oder, harmloser aber genauso
// real, ein Bug/eine Race in der Gegenseite (channel.onopen feuert doppelt,
// eine zweite WebRTCManager-Instanz landet versehentlich am selben
// DataChannel) fuehrt zum selben stillen Session-Bruch.
//
// Fix (in derselben Review-Runde angewendet, siehe SECURITY_STATE_MACHINES.md
// "Fixes in dieser Runde"): beide Handler verwerfen jetzt ein erneutes
// kyber_pubkey/kyber_ciphertext, sobald this.keyExchangeDone bereits true ist
// - WebRTCManager.js:311-328 (kyber_pubkey) und :355-360 (kyber_ciphertext),
// web/src/lib/WebRTCManager.ts:257-266 (kyber_pubkey) und :282-287
// (kyber_ciphertext). Diese Tests waeren vor dem Fix fehlgeschlagen (das
// zweite kyber_pubkey/kyber_ciphertext haette sharedSecret klaglos auf einen
// neuen Wert veraendert).

const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const crypto = require('crypto');
const { NativeModules } = require('react-native');

// Erweitert den gemeinsamen Bridge-Mock (der nur randomBytes/sha256 fuer
// MessageCrypto.js abdeckt) um die drei Kyber-KEM-Bruecken-Methoden, die
// WebRTCManager.js zusaetzlich braucht. Simuliert bewusst KEINEN echten
// ML-KEM-Austausch (das laeuft nur nativ in Kotlin/BouncyCastle, siehe
// SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 2 - "lebt komplett nativ ... laeuft
// nicht ausserhalb eines Android-Geraets") - fuer die hier gepruefte
// STATE-MACHINE-Eigenschaft (wird ein zweiter Handshake fuer dieselbe
// Verbindung ignoriert oder ueberschreibt er das Secret?) reicht es, dass
// zwei aufeinanderfolgende encapsulate()-Aufrufe unterscheidbare
// sharedSecret-Werte liefern, exakt wie beim echten ML-KEM-768.
NativeModules.KyberModule.generateKeypair = async () => ({
  publicKey: 'pub_' + crypto.randomBytes(8).toString('hex'),
  secretKey: 'sec_' + crypto.randomBytes(8).toString('hex'),
});
NativeModules.KyberModule.encapsulate = async (_publicKeyB64) => {
  const sharedSecret = crypto.randomBytes(32).toString('base64');
  // Fake-Ciphertext traegt das Secret direkt (Base64-of-Base64) - decapsulate
  // unten liest es einfach wieder aus. Nur fuer diesen Test relevant, keine
  // echte KEM-Eigenschaft.
  return { sharedSecret, cipherText: Buffer.from(sharedSecret).toString('base64') };
};
NativeModules.KyberModule.decapsulate = async (cipherTextB64) => {
  return Buffer.from(cipherTextB64, 'base64').toString('utf8');
};

const { WebRTCManager: NativeWebRTCManager } = require('../../WebRTCManager');

function fakeChannel() {
  return { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null };
}

describe('WebRTCManager (native) - Key State: dupliziertes kyber_pubkey/kyber_ciphertext', () => {
  test('zweites kyber_pubkey nach abgeschlossenem Austausch wird verworfen statt sharedSecret zu ueberschreiben', async () => {
    const rtc = new NativeWebRTCManager(() => {}, () => {}, () => {});
    // chatId bewusst nicht gesetzt - vermeidet den chatId-gegateten
    // Persistierungszweig (RTCStore/EncryptedStorage), der fuer die hier
    // geprüfte Zustandsmaschinen-Eigenschaft irrelevant ist.
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: 'pub_A' }) });
    expect(rtc.keyExchangeDone).toBe(true);
    const firstSecret = rtc.sharedSecret;
    expect(firstSecret).toBeTruthy();

    // Duplikat/Replay des Handshake-Pakets fuer dieselbe, bereits etablierte
    // Verbindung.
    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: 'pub_B' }) });

    expect(rtc.sharedSecret).toBe(firstSecret); // unveraendert - Duplikat wurde verworfen
    rtc.close(); // Cover-Traffic-/Liveness-Timer wieder abraeumen (Test-Hygiene)
  });

  test('zweites kyber_ciphertext nach abgeschlossenem Austausch wird verworfen (Initiator-Seite)', async () => {
    const rtc = new NativeWebRTCManager(() => {}, () => {}, () => {});
    rtc.isInitiator = true;
    rtc.myKyberKeys = { publicKey: 'pub_self', secretKey: 'sec_self' };
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    await channel.onmessage({
      data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: Buffer.from(crypto.randomBytes(32).toString('base64')).toString('base64') }),
    });
    expect(rtc.keyExchangeDone).toBe(true);
    const firstSecret = rtc.sharedSecret;
    expect(firstSecret).toBeTruthy();

    await channel.onmessage({
      data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: Buffer.from(crypto.randomBytes(32).toString('base64')).toString('base64') }),
    });

    expect(rtc.sharedSecret).toBe(firstSecret);
    rtc.close();
  });
});

describe('WebRTCManager (web) - Key State: dupliziertes kyber_pubkey/kyber_ciphertext', () => {
  // Web nutzt echtes ML-KEM-768 (@noble/post-quantum), keine Bridge-Mocks
  // noetig - reine JS-Kryptografie, laeuft direkt unter Jest.
  const { WebRTCManager: WebWebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');
  const { generateKyberKeypair } = require('../../web/src/lib/HybridCrypto.ts');

  test('zweites kyber_pubkey nach abgeschlossenem Austausch wird verworfen statt sharedSecret zu ueberschreiben', async () => {
    const rtc = new WebWebRTCManager(() => {}, () => {}, () => {});
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    const keysA = await generateKyberKeypair();
    const keysB = await generateKyberKeypair();

    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: keysA.publicKey }) });
    expect(rtc.keyExchangeDone).toBe(true);
    const firstSecret = rtc.sharedSecret;
    expect(firstSecret).toBeTruthy();

    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: keysB.publicKey }) });

    expect(rtc.sharedSecret).toBe(firstSecret);
    rtc.close();
  });

  test('zweites kyber_ciphertext nach abgeschlossenem Austausch wird verworfen (Initiator-Seite)', async () => {
    const { kyberEncapsulate } = require('../../web/src/lib/HybridCrypto.ts');
    const rtc = new WebWebRTCManager(() => {}, () => {}, () => {});
    rtc.isInitiator = true;
    rtc.myKyberKeys = await generateKyberKeypair();
    const channel = fakeChannel();
    rtc._setupDataChannel(channel);

    const enc1 = await kyberEncapsulate(rtc.myKyberKeys.publicKey);
    const enc2 = await kyberEncapsulate(rtc.myKyberKeys.publicKey);

    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: enc1.cipherText }) });
    expect(rtc.keyExchangeDone).toBe(true);
    const firstSecret = rtc.sharedSecret;
    expect(firstSecret).toBeTruthy();

    await channel.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: enc2.cipherText }) });

    expect(rtc.sharedSecret).toBe(firstSecret);
    rtc.close();
  });
});
