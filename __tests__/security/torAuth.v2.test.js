// Krypto-Review 2026-10-25, K-11: Tor-Anmeldung mit eindeutig kodiertem MAC
// (Laengenpraefixe, eigenes Label, Hex-Nonces), ausgehandelt ueber "av: 2" in
// der Challenge; aeltere Gegenseiten bleiben bei v1; nach der ersten
// v2-Anmeldung eines Kontakts wird v1 fuer ihn abgelehnt (ConnCaps.js).
// Tor selbst ist gemockt (wie tor.transport.test.js); die Anmeldelogik laeuft echt.
const crypto = require('crypto');
const { Buffer } = require('buffer');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, DeviceEventEmitter } = require('react-native');
NativeModules.KyberModule.generateKeypair = async () => {
  const sk = crypto.randomBytes(16).toString('hex');
  return { publicKey: 'pub_' + sk, secretKey: sk };
};
NativeModules.KyberModule.encapsulate = async () => {
  const ss = crypto.randomBytes(32).toString('base64');
  return { sharedSecret: ss, cipherText: Buffer.from(ss).toString('base64') };
};
NativeModules.KyberModule.decapsulate = async (ct) => Buffer.from(ct, 'base64').toString('utf8');

const MY_ONION = 'a'.repeat(56) + '.onion';
const PEER_ONION = 'b'.repeat(56) + '.onion';
const sent = [];
const closed = [];
NativeModules.MalachiTor = {
  addListener() {},
  removeListeners() {},
  start: jest.fn(),
  stop: jest.fn(async () => {}),
  connect: jest.fn(async () => 'out-1'),
  send: jest.fn(async (connId, line) => { sent.push({ connId, line }); }),
  close: jest.fn((connId) => { closed.push(connId); }),
};

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const Tor = require('../../TorTransport');
const BG = require('../../BackgroundSync');
const ConnCaps = require('../../ConnCaps');

const SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_kev', name: 'Kev', role: 'initiator', torOnion: PEER_ONION };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const linesFor = (connId) => sent.filter((x) => x.connId === connId).map((x) => JSON.parse(x.line));
const feed = (connId, obj) => DeviceEventEmitter.emit('MalachiTorLine', { connId, line: JSON.stringify(obj) });
const mac = (s, role, parts, v) => Tor._authMacForTests(s, role, parts, v);

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(async () => {
  sent.length = 0;
  closed.length = 0;
  Tor._resetTorTransportForTests();
  BG._resetTorFallbackForTests();
  RTCStore.resetAll();
  await EncryptedStorage.clear();
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
  await EncryptedStorage.setItem('shared_secret_' + CONTACT.id, SECRET);
  RTCStore.sharedSecrets.set(CONTACT.id, SECRET);
  Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
});
afterEach(() => {
  for (const rtc of RTCStore.connections.values()) { try { rtc.close(); } catch {} }
});

describe('Kodierung', () => {
  test('Testvektor v2 mit unabhaengiger Gegenprobe (Node: HKDF + HMAC ueber laengenpraefixierte Felder)', () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const parts = [MY_ONION, '00'.repeat(24), 'ff'.repeat(24), 'c_kev'];
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(32, 7), Buffer.alloc(0), Buffer.from('malachi-tor-auth-v2'), 32));
    const lp = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
    const expected = crypto.createHmac('sha256', key).update(Buffer.concat([lp('malachi-tor-auth-v2'), lp('client'), ...parts.map(lp)])).digest('base64');
    expect(mac(secret, 'client', parts, 2)).toBe(expected);
    // v1 unveraendert (Kompatibilitaet mit 1.0/1.1)
    const key1 = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(32, 7), Buffer.alloc(0), Buffer.from('malachi-tor-auth-v1'), 32));
    expect(mac(secret, 'client', parts, 1)).toBe(crypto.createHmac('sha256', key1).update(['client', ...parts].join('|')).digest('base64'));
  });

  test('v1 ist mehrdeutig ("a|b","c" == "a","b|c"), v2 nicht', () => {
    expect(mac(SECRET, 'client', ['a|b', 'c'], 1)).toBe(mac(SECRET, 'client', ['a', 'b|c'], 1));
    expect(mac(SECRET, 'client', ['a|b', 'c'], 2)).not.toBe(mac(SECRET, 'client', ['a', 'b|c'], 2));
    expect(mac(SECRET, 'client', ['ab', 'c'], 2)).not.toBe(mac(SECRET, 'client', ['a', 'bc'], 2));
    // und keine Verwechslung der Versionen
    expect(mac(SECRET, 'client', ['x'], 2)).not.toBe(mac(SECRET, 'client', ['x'], 1));
  });
});

describe('Serverseite (eingehende Anmeldung)', () => {
  async function challenge(connId) {
    await Tor._handleIncomingForTests(connId);
    const c = linesFor(connId)[0];
    expect(c).toMatchObject({ t: 'malachi-tor', step: 'challenge', av: 2 });
    return c.nonce;
  }
  const authLine = (nonceS, nonceC, v, secret = SECRET) => ({
    t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nonceC, ...(v === 2 ? { av: 2 } : {}),
    mac: mac(secret, 'client', [MY_ONION, nonceS, nonceC, CONTACT.id], v),
  });

  test('neuer Client (av 2): angemeldet, Gegenbestaetigung v2, Kontakt als v2 gemerkt', async () => {
    const nonceS = await challenge('in-1');
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('in-1', authLine(nonceS, nonceC, 2));
    await tick(50);
    const ok = linesFor('in-1').find((m) => m.step === 'ok');
    expect(ok).toMatchObject({ av: 2, mac: mac(SECRET, 'server', [MY_ONION, nonceS, nonceC, CONTACT.id], 2) });
    expect(RTCStore.connections.get(CONTACT.id)?.transport).toBe('tor');
    expect((await ConnCaps.getConnCaps(CONTACT.id)).tor).toBe(2);
  });

  test('alter Client (1.0/1.1, ohne av): weiterhin angemeldet (v1)', async () => {
    const nonceS = await challenge('in-2');
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('in-2', authLine(nonceS, nonceC, 1));
    await tick(50);
    const ok = linesFor('in-2').find((m) => m.step === 'ok');
    expect(ok.av).toBeUndefined();
    expect(ok.mac).toBe(mac(SECRET, 'server', [MY_ONION, nonceS, nonceC, CONTACT.id], 1));
    expect((await ConnCaps.getConnCaps(CONTACT.id)).tor).toBeUndefined();
  });

  test('Rueckstufung: nach einer v2-Anmeldung wird v1 desselben Kontakts abgelehnt (auch mit korrektem v1-MAC)', async () => {
    await ConnCaps.noteConnCap(CONTACT.id, 'tor', 2);
    const nonceS = await challenge('in-3');
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('in-3', authLine(nonceS, nonceC, 1));
    await tick(50);
    expect(closed).toContain('in-3');
    expect(linesFor('in-3').some((m) => m.step === 'ok')).toBe(false);
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
  });

  test('Versionen nicht vertauschbar: v2-Anmeldung mit v1-MAC und v1-Anmeldung mit v2-MAC scheitern; Nicht-Hex-Nonce bei v2 abgelehnt', async () => {
    const n1 = await challenge('in-4');
    const c1 = crypto.randomBytes(24).toString('hex');
    feed('in-4', { ...authLine(n1, c1, 1), av: 2 });
    const n2 = await challenge('in-5');
    const c2 = crypto.randomBytes(24).toString('hex');
    const v2 = authLine(n2, c2, 2);
    delete v2.av;
    feed('in-5', v2);
    const n3 = await challenge('in-6');
    const c3 = 'Z'.repeat(48);
    feed('in-6', authLine(n3, c3, 2));
    await tick(50);
    expect(closed).toEqual(expect.arrayContaining(['in-4', 'in-5', 'in-6']));
    expect(RTCStore.connections.size).toBe(0);
  });
});

describe('Clientseite (ausgehend)', () => {
  test('Server bietet v2: Client meldet sich mit v2 an, akzeptiert nur eine v2-Bestaetigung', async () => {
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', v: 1, av: 2, step: 'challenge', nonce: nonceS });
    await tick();
    const auth = linesFor('out-1')[0];
    expect(auth).toMatchObject({ step: 'auth', av: 2 });
    expect(auth.mac).toBe(mac(SECRET, 'client', [PEER_ONION, nonceS, auth.nonce, CONTACT.id], 2));
    feed('out-1', { t: 'malachi-tor', step: 'ok', av: 2, mac: mac(SECRET, 'server', [PEER_ONION, nonceS, auth.nonce, CONTACT.id], 2) });
    expect(await p).toBeTruthy();
    await tick();
    expect((await ConnCaps.getConnCaps(CONTACT.id)).tor).toBe(2);
  });

  test('v2 angeboten, aber Bestaetigung im v1-Format: abgebrochen', async () => {
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', av: 2, step: 'challenge', nonce: nonceS });
    await tick();
    const auth = linesFor('out-1')[0];
    feed('out-1', { t: 'malachi-tor', step: 'ok', mac: mac(SECRET, 'server', [PEER_ONION, nonceS, auth.nonce, CONTACT.id], 1) });
    expect(await p).toBeNull();
  });

  test('alter Server (ohne av): v1 wie bisher', async () => {
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', v: 1, step: 'challenge', nonce: nonceS });
    await tick();
    const auth = linesFor('out-1')[0];
    expect(auth.av).toBeUndefined();
    expect(auth.mac).toBe(mac(SECRET, 'client', [PEER_ONION, nonceS, auth.nonce, CONTACT.id], 1));
    feed('out-1', { t: 'malachi-tor', step: 'ok', mac: mac(SECRET, 'server', [PEER_ONION, nonceS, auth.nonce, CONTACT.id], 1) });
    expect(await p).toBeTruthy();
  });

  test('Rueckstufung: Kontakt kennt v2, Challenge ohne av -> keine Anmeldung', async () => {
    await ConnCaps.noteConnCap(CONTACT.id, 'tor', 2);
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    feed('out-1', { t: 'malachi-tor', v: 1, step: 'challenge', nonce: crypto.randomBytes(24).toString('hex') });
    expect(await p).toBeNull();
    expect(linesFor('out-1').some((m) => m.step === 'auth')).toBe(false);
    expect(closed).toContain('out-1');
  });
});

describe('Kettenglied fuer den Verbindungsschluessel v2 (Krypto-Review V5)', () => {
  test('Server und Client nehmen genau das Geheimnis, mit dem sich die Verbindung angemeldet hat', async () => {
    const OLD = crypto.randomBytes(32).toString('base64');
    RTCStore.previousSecrets.set(CONTACT.id, OLD);              // zweiter Kandidat
    // Server: Client meldet sich mit dem VORHERIGEN Geheimnis an.
    await Tor._handleIncomingForTests('in-k');
    const nonceS = linesFor('in-k')[0].nonce;
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('in-k', { t: 'malachi-tor', step: 'auth', av: 2, id: CONTACT.id, nonce: nonceC,
      mac: mac(OLD, 'client', [MY_ONION, nonceS, nonceC, CONTACT.id], 2) });
    await tick(50);
    const server = RTCStore.connections.get(CONTACT.id);
    expect(server._chainSecret).toBe(OLD);
    server.close();
    // Client: die Gegenseite bestaetigt mit dem vorherigen Geheimnis.
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    const n2 = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', av: 2, step: 'challenge', nonce: n2 });
    await tick();
    const auth = linesFor('out-1').find((m) => m.step === 'auth');
    feed('out-1', { t: 'malachi-tor', step: 'ok', av: 2, mac: mac(OLD, 'server', [PEER_ONION, n2, auth.nonce, CONTACT.id], 2) });
    const client = await p;
    expect(client._chainSecret).toBe(OLD);
  });

  test('Erstkopplung: Kettenglied ist der PSK der Einladung (beide Seiten)', async () => {
    const PSK = Buffer.from(crypto.randomBytes(16)).toString('base64');
    const p = Tor.pairViaTor({ onion: PEER_ONION, token: 'ABCD1234', pskB64: PSK, contactId: 'c_new', onPaired: () => {} });
    await tick();
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', av: 2, step: 'challenge', nonce: nonceS });
    await tick();
    const pair = linesFor('out-1')[0];
    feed('out-1', { t: 'malachi-tor', step: 'pair-ok', av: 2, mac: mac(PSK, 'pair-server', [PEER_ONION, nonceS, pair.nonce, 'ABCD1234'], 2) });
    expect((await p)._chainSecret).toBe(PSK);
    Tor.registerPairingInvite('CCCC3333', { pskB64: PSK, contactId: 'c_inv', onPaired: () => {} });
    await Tor._handleIncomingForTests('pin-k');
    const nS = linesFor('pin-k')[0].nonce;
    const nC = crypto.randomBytes(24).toString('hex');
    feed('pin-k', { t: 'malachi-tor', step: 'pair', av: 2, token: 'CCCC3333', nonce: nC, mac: mac(PSK, 'pair-client', [MY_ONION, nS, nC, 'CCCC3333'], 2) });
    await tick(50);
    const inviter = Tor._channelRtcForTests('pin-k');
    expect(inviter).toBeTruthy();
    expect(inviter.chatId).toBe('c_inv');
    expect(inviter._chainSecret).toBe(PSK);
  });
});

describe('Erstkopplung ueber Tor (PSK aus dem Einladungslink)', () => {
  const PSK = Buffer.from(crypto.randomBytes(16)).toString('base64');

  test('neu <-> neu: Kopplung mit v2; Bestaetigung in v1 wird abgelehnt', async () => {
    const p = Tor.pairViaTor({ onion: PEER_ONION, token: 'ABCD1234', pskB64: PSK, contactId: 'c_new', onPaired: () => {} });
    await tick();
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', v: 1, av: 2, step: 'challenge', nonce: nonceS });
    await tick();
    const pair = linesFor('out-1')[0];
    expect(pair).toMatchObject({ step: 'pair', av: 2, token: 'ABCD1234' });
    expect(pair.mac).toBe(mac(PSK, 'pair-client', [PEER_ONION, nonceS, pair.nonce, 'ABCD1234'], 2));
    feed('out-1', { t: 'malachi-tor', step: 'pair-ok', mac: mac(PSK, 'pair-server', [PEER_ONION, nonceS, pair.nonce, 'ABCD1234'], 1) });
    expect(await p).toBeNull();
  });

  test('Einladender mit 1.1 (Challenge ohne av): Kopplung mit v1 klappt', async () => {
    const p = Tor.pairViaTor({ onion: PEER_ONION, token: 'ABCD1234', pskB64: PSK, contactId: 'c_new', onPaired: () => {} });
    await tick();
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', v: 1, step: 'challenge', nonce: nonceS });
    await tick();
    const pair = linesFor('out-1')[0];
    expect(pair.av).toBeUndefined();
    feed('out-1', { t: 'malachi-tor', step: 'pair-ok', mac: mac(PSK, 'pair-server', [PEER_ONION, nonceS, pair.nonce, 'ABCD1234'], 1) });
    expect(await p).toBeTruthy();
  });

  test('Einladender (neu) nimmt Scanner mit 1.1 (v1) und mit neuer Version (v2) an', async () => {
    for (const v of [1, 2]) {
      const token = v === 1 ? 'AAAA1111' : 'BBBB2222';
      Tor.registerPairingInvite(token, { pskB64: PSK, contactId: 'c_p' + v, onPaired: () => {} });
      const connId = 'pin-' + v;
      await Tor._handleIncomingForTests(connId);
      const nonceS = linesFor(connId)[0].nonce;
      const nonceC = crypto.randomBytes(24).toString('hex');
      feed(connId, { t: 'malachi-tor', step: 'pair', token, nonce: nonceC, ...(v === 2 ? { av: 2 } : {}),
        mac: mac(PSK, 'pair-client', [MY_ONION, nonceS, nonceC, token], v) });
      await tick(50);
      const ok = linesFor(connId).find((m) => m.step === 'pair-ok');
      expect(ok).toBeTruthy();
      expect(ok.av === 2 ? 2 : 1).toBe(v);
      expect(ok.mac).toBe(mac(PSK, 'pair-server', [MY_ONION, nonceS, nonceC, token], v));
    }
  });
});
