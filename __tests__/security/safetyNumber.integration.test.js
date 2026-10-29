// Krypto-Review 2026-10-25, V1 - stabiler Sicherheitscode zwischen zwei
// vollstaendigen "Geraeten" (eigene Modul-Instanzen von WebRTCManager/
// RTCStore/BackgroundSync/RatchetSession/SafetyNumber, eigener Speicher) ueber
// echte Verbindungen. ML-KEM-768 ist echtes @noble/post-quantum (dieselbe
// Bibliothek wie der Web-Client) und steht nur fuer die native Bruecke.
// Geprueft: gleicher Code auf beiden Seiten, unveraendert ueber neue
// Verbindungen (frueher wechselte er jedes Mal), und Interop mit 1.1
// (Gegenseite ohne caps.sn: alter Verbindungscode, auf beiden Seiten gleich).
const crypto = require('crypto');

jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: async (k, v) => { store.set(k, String(v)); },
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      removeItem: async (k) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});
jest.mock('react-native-fs', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockFiles = global.__mockFiles || {};
  const files = (global.__mockFiles[dev] = global.__mockFiles[dev] || new Map());
  return {
    __files: files,
    DocumentDirectoryPath: '/mock/' + dev,
    CachesDirectoryPath: '/mock/caches/' + dev,
    writeFile: async (p, d) => { files.set(p, d); },
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    unlink: async (p) => { files.delete(p); },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    readDir: async () => [...files.keys()].map((p) => ({ name: p.split('/').pop(), path: p, isFile: () => true })),
  };
});

const { realKyber } = require('./helpers/phonePairingHelpers');
// WebRTCManager._computeSafetyCode laedt react-native erst zur Laufzeit (nach
// isolateModules = Haupt-Registry) - dort braucht es die Bruecke ebenfalls.
require('./helpers/nativeBridgeMock').installKyberModuleMock();

const A_ID = 'c_alice';
const B_ID = 'c_bob';
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + ((typeof what === 'function' ? what() : what) || fn.toString().slice(0, 140)));
    await tick(10);
  }
}

function installRealKyber() {
  require('./helpers/nativeBridgeMock').installKyberModuleMock();
  const { NativeModules } = require('react-native');
  Object.assign(NativeModules.KyberModule, realKyber());
}

// "1.1": Double Ratchet ja, aber kein stabiler Sicherheitscode (kein caps.sn).
function v11SafetyStub() {
  const actual = jest.requireActual('../../SafetyNumber');
  return { ...actual, SAFETY_CAP_VERSION: undefined };
}

function loadDevice(name, peerId, role, { v11 = false } = {}) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    installRealKyber();
    if (v11) jest.doMock('../../SafetyNumber', v11SafetyStub);
    dev = {
      name, peerId, role,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      RS: require('../../RatchetSession'),
      SN: require('../../SafetyNumber'),
      ES: require('react-native-encrypted-storage').default,
    };
    if (v11) jest.dontMock('../../SafetyNumber');
  });
  global.__mockDevice = undefined;
  dev.v11 = v11;
  dev.ready = (async () => {
    await dev.ES.setItem('contacts', JSON.stringify([{ id: peerId, name: peerId, role }]));
    await dev.ES.setItem('shared_secret_' + peerId, PAIR_SECRET);
    dev.RTCStore.sharedSecrets.set(peerId, PAIR_SECRET);
    await dev.BG.loadPreviousSecret(peerId);
    await dev.RTCStore.preloadContact(peerId);
  })();
  return dev;
}

// 1.1 kennt die neuen Handshake-Felder (ol, kx, x, ck) nicht: sendet sie nicht,
// ignoriert sie beim Empfang.
function stripNew(raw) {
  try {
    const m = JSON.parse(raw);
    if (m?.type === 'system' && /^kyber_/.test(m.subtype)) { for (const f of ['ol', 'kx', 'x', 'ck']) delete m[f]; return JSON.stringify(m); }
  } catch {}
  return raw;
}
function makeLink(bOld = false) {
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; this.onmessage = null; } });
  const a = mk();
  const b = mk();
  const f = (d) => (bOld ? stripNew(d) : d);
  a.send = (d) => { if (a.readyState !== 'open') throw new Error('Kanal zu'); setTimeout(() => b.onmessage?.({ data: f(d) }), 0); };
  b.send = (d) => { if (b.readyState !== 'open') throw new Error('Kanal zu'); setTimeout(() => a.onmessage?.({ data: f(d) }), 0); };
  return { a, b };
}

async function connect(alice, bob) {
  const link = makeLink(!!bob.v11);
  const rtcA = new alice.WebRTCManager(() => {}, () => {}, () => {});
  const rtcB = new bob.WebRTCManager(() => {}, () => {}, () => {});
  for (const [dev, rtc, ch, initiator] of [[alice, rtcA, link.a, true], [bob, rtcB, link.b, false]]) {
    rtc.isInitiator = initiator;
    rtc.pc = { iceConnectionState: 'connected', close() {} };
    rtc.dataChannel = ch;
    rtc._chainSecret = dev.RTCStore.getSharedSecret(dev.peerId);   // wie nach der Tor-Anmeldung (V5)
    dev.RTCStore.setConnection(dev.peerId, rtc);
    rtc._onReady = () => dev.BG.flushQueue(dev.peerId, rtc);
    rtc._setupDataChannel(ch);
  }
  link.b.onopen();
  link.a.onopen();
  await waitFor(() => rtcA.keyExchangeDone && rtcB.keyExchangeDone && rtcA.safetyCode && rtcB.safetyCode, 5000, 'Schluesseltausch');
  await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown', 3000, 'Faehigkeiten');
  return { rtcA, rtcB };
}

const sendText = (dev, text, msgId) => dev.BG.sendViaOutbox(dev.peerId, 'text', { type: 'text', text, time: Date.now(), msgId }, msgId);
const queueLen = async (dev) => JSON.parse(await dev.ES.getItem('queue_' + dev.peerId) || '[]').length;

let alice;
let bob;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });
afterEach(() => {
  for (const d of [alice, bob]) {
    d?.BG._resetOutboxForTests();
    for (const rtc of d?.RTCStore.connections.values() || []) { try { rtc.close(); } catch {} }
  }
});

test('neu <-> neu: derselbe 30-stellige Code auf beiden Seiten, unveraendert ueber neue Verbindungen (der alte Code wechselte jedes Mal)', async () => {
  global.__mockStores = {};
  global.__mockFiles = {};
  alice = loadDevice('alice', B_ID, 'initiator');
  bob = loadDevice('bob', A_ID, 'responder');
  await Promise.all([alice.ready, bob.ready]);
  let conn = await connect(alice, bob);
  await sendText(alice, 'hallo', 'm1');
  await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt');
  await waitFor(async () => (await alice.RS.isActive(B_ID)) && (await bob.RS.isActive(A_ID)), 3000, 'aktiv');
  const ia = await alice.SN.getSafetyInfo(B_ID, { legacyCode: conn.rtcA.safetyCode });
  const ib = await bob.SN.getSafetyInfo(A_ID, { legacyCode: conn.rtcB.safetyCode });
  expect(ia.mode).toBe('v2');
  expect(ib.mode).toBe('v2');
  expect(ia.number).toBe(ib.number);
  expect(ia.number.replace(/ /g, '')).toHaveLength(30);
  const legacyCodes = new Set([conn.rtcA.safetyCode]);
  for (let i = 0; i < 3; i++) {
    conn.rtcA.close(); conn.rtcB.close();
    conn = await connect(alice, bob);
    await sendText(bob, 'runde ' + i, 'r' + i);
    await waitFor(async () => (await queueLen(bob)) === 0, 5000, 'zugestellt ' + i);
    legacyCodes.add(conn.rtcA.safetyCode);
    const a2 = await alice.SN.getSafetyInfo(B_ID, { legacyCode: conn.rtcA.safetyCode });
    const b2 = await bob.SN.getSafetyInfo(A_ID, { legacyCode: conn.rtcB.safetyCode });
    expect(a2).toMatchObject({ mode: 'v2', number: ia.number, changed: false });
    expect(b2).toMatchObject({ mode: 'v2', number: ia.number, changed: false });
  }
  expect(legacyCodes.size).toBe(4);   // alter Code: jede Verbindung ein anderer
}, 60000);

test('neu <-> 1.1 (Ratchet, aber kein caps.sn): neue Seite zeigt den alten Verbindungscode - identisch mit dem der 1.1-Seite', async () => {
  global.__mockStores = {};
  global.__mockFiles = {};
  alice = loadDevice('alice', B_ID, 'initiator');
  bob = loadDevice('bob', A_ID, 'responder', { v11: true });
  await Promise.all([alice.ready, bob.ready]);
  const conn = await connect(alice, bob);
  await sendText(alice, 'hallo 1.1', 'v1');
  await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt');
  await waitFor(async () => (await alice.RS.isActive(B_ID)), 3000, 'aktiv');
  const ia = await alice.SN.getSafetyInfo(B_ID, { legacyCode: conn.rtcA.safetyCode });
  expect(ia.mode).toBe('legacy');
  expect(ia.legacyCode).toBe(conn.rtcB.safetyCode);       // genau das zeigt die 1.1-Seite
  expect(ia.legacyCode).toMatch(/^\d{4}-\d{4}-\d{4}-\d{4}$/);
}, 30000);
