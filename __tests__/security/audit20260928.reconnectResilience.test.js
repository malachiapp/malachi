// Audit 2026-09-28 ("App verursacht staendig Verbindungsprobleme") - prueft die
// App-seitigen Fixes gegen echten Produktionscode (WebRTCManager.js,
// RTCStore.js, echte MessageCrypto-Verschluesselung):
//   B. Ein normaler Verbindungsabbruch waehrend der Secret-Persistierung
//      loescht das neue Secret nicht mehr komplett (nur ein echter Wipe).
//   C. Vorheriges Secret wird nach Bestaetigung durch die Gegenseite verworfen.
//
// Die frueheren Teile A (Reconnect-Angebote ueber den Server mit vorherigem
// Secret), D (Versuchsverwaltung der Server-Angebote) und E (Server-Poll fuer
// Anruf-Signale) sind mit der serverlosen Umstellung (Okt. 2026) entfallen.
// Ersatz: Anmeldung mit vorherigem Secret ueber Tor (tor.transport.test.js,
// "Anmeldung nach schnellen Schluesselwechseln") und die Anruf-Pufferung in
// RTCStore (serverless.callsAndPairing.test.js).
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const crypto = require('crypto');
const { NativeModules } = require('react-native');

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const { encryptMsg } = require('../../MessageCrypto');
const { WebRTCManager: RealWebRTCManager } = require('../../WebRTCManager');

const OLD = crypto.randomBytes(32).toString('base64');
const NEW = crypto.randomBytes(32).toString('base64');

beforeEach(async () => {
  await EncryptedStorage.clear();
  RTCStore.resetAll();
  jest.clearAllMocks();
});

describe('B/C. Secret-Wechsel in WebRTCManager (echte Klasse)', () => {
  const CHAT = 'c_kyber';
  function channel() {
    return { readyState: 'open', send: null, onopen: null, onmessage: null, onclose: null };
  }
  beforeEach(() => {
    NativeModules.KyberModule.generateKeypair = async () => ({ publicKey: 'pub', secretKey: 'sec' });
    NativeModules.KyberModule.encapsulate = async () => ({ sharedSecret: NEW, cipherText: 'ct' });
  });

  async function runResponderExchange({ closeDuringPersist }) {
    RTCStore.sharedSecrets.set(CHAT, OLD);
    const originalSetItem = EncryptedStorage.setItem;
    let release;
    const gate = new Promise((r) => { release = r; });
    const spy = jest.spyOn(EncryptedStorage, 'setItem').mockImplementation((k, v) =>
      (k === 'shared_secret_' + CHAT ? gate : Promise.resolve()).then(() => originalSetItem(k, v)));
    const rtc = new RealWebRTCManager(() => {}, () => {}, () => {});
    rtc.chatId = CHAT;
    const ch = channel();
    ch.send = () => {};
    rtc._setupDataChannel(ch);
    const handler = ch.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: 'pub' }) });
    await new Promise((r) => setTimeout(r, 0));
    if (closeDuringPersist) rtc.close(); // normaler Verbindungsabbruch, KEIN Wipe
    release();
    await handler;
    spy.mockRestore();
    return { rtc, ch };
  }

  test('B: Verbindungsabbruch waehrend der Persistierung laesst neues UND vorheriges Secret bestehen', async () => {
    await runResponderExchange({ closeDuringPersist: true });
    expect(RTCStore.sharedSecrets.get(CHAT)).toBe(NEW);
    expect(RTCStore.previousSecrets.get(CHAT)).toBe(OLD);
    expect(await EncryptedStorage.getItem('shared_secret_' + CHAT)).toBe(NEW);
    expect(await EncryptedStorage.getItem('shared_secret_prev_' + CHAT)).toBe(OLD);
    expect(RTCStore.getSecretCandidates(CHAT)).toEqual([NEW, OLD]);
  });

  test('B (Gegenprobe): ein echter Wipe waehrend der Persistierung entfernt weiterhin alles', async () => {
    RTCStore.sharedSecrets.set(CHAT, OLD);
    const originalSetItem = EncryptedStorage.setItem;
    let release;
    const gate = new Promise((r) => { release = r; });
    const spy = jest.spyOn(EncryptedStorage, 'setItem').mockImplementation((k, v) =>
      (k === 'shared_secret_' + CHAT ? gate : Promise.resolve()).then(() => originalSetItem(k, v)));
    const rtc = new RealWebRTCManager(() => {}, () => {}, () => {});
    rtc.chatId = CHAT;
    RTCStore.setConnection(CHAT, rtc);
    const ch = channel();
    ch.send = () => {};
    rtc._setupDataChannel(ch);
    const handler = ch.onmessage({ data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: 'pub' }) });
    await new Promise((r) => setTimeout(r, 0));
    RTCStore.clearContact(CHAT);
    release();
    await handler;
    spy.mockRestore();
    expect(RTCStore.sharedSecrets.has(CHAT)).toBe(false);
    expect(RTCStore.previousSecrets.has(CHAT)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(await EncryptedStorage.getItem('shared_secret_' + CHAT)).toBeNull();
    expect(await EncryptedStorage.getItem('shared_secret_prev_' + CHAT)).toBeNull();
  });

  test('C: erste Nachricht der Gegenseite unter dem neuen Secret bestaetigt den Wechsel - vorheriges Secret wird verworfen', async () => {
    const { rtc, ch } = await runResponderExchange({ closeDuringPersist: false });
    expect(RTCStore.previousSecrets.get(CHAT)).toBe(OLD);
    const enc = await encryptMsg(JSON.stringify({ type: 'dummy', p: '' }), NEW);
    await ch.onmessage({ data: JSON.stringify({ type: 'encrypted', data: enc }) });
    expect(RTCStore.previousSecrets.has(CHAT)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(await EncryptedStorage.getItem('shared_secret_prev_' + CHAT)).toBeNull();
    rtc.close();
  });

  test('Audit 2026-10-19 T8: ueberlappender Wechsel - die aeltere Verbindung verwirft den Rueckfall der neueren nicht', async () => {
    const { rtc: older, ch } = await runResponderExchange({ closeDuringPersist: false });
    // Eine zweite Verbindung (z.B. Direkt neben Tor) hat inzwischen NEUER2 ausgehandelt.
    const NEWER = crypto.randomBytes(32).toString('base64');
    RTCStore.rememberPreviousSecret(CHAT, NEW, NEWER);
    RTCStore.sharedSecrets.set(CHAT, NEWER);
    await EncryptedStorage.setItem('shared_secret_prev_' + CHAT, NEW);
    // Die Gegenseite antwortet auf der ALTEN Verbindung unter deren Secret.
    const enc = await encryptMsg(JSON.stringify({ type: 'dummy', p: '' }), NEW);
    await ch.onmessage({ data: JSON.stringify({ type: 'encrypted', data: enc }) });
    expect(older._awaitingKeyConfirm).toBe(false);
    expect(RTCStore.previousSecrets.get(CHAT)).toBe(NEW);           // Rueckfall bleibt
    expect(RTCStore.getSecretCandidates(CHAT)).toEqual([NEWER, NEW]);
    expect(await EncryptedStorage.getItem('shared_secret_prev_' + CHAT)).toBe(NEW);
    older.close();
  });
});
