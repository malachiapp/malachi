// Krypto-Review 2026-10-25, V6/K-06: regelmaessiges ML-KEM-Nachmischen im
// Double Ratchet (RatchetSession.js pqRefreshDue/preparePqOffer/acceptPqOffer/
// completePqOffer, WebRTCManager _maybePqRefresh/_handlePq). ML-KEM ist echt
// (@noble/post-quantum, steht fuer die native Bruecke).
// Teil 1: Sitzungsebene, zwei Geraete mit eigenem Speicher, steuerbare Uhr.
// Teil 2: zwei vollstaendige Geraete ueber echte Verbindungen.
const crypto = require('crypto');
const { Buffer } = require('buffer');

jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: async (k, v) => {
        if (global.__failSetItem?.(dev, k)) throw new Error('Speicher voll (simuliert)');
        store.set(k, String(v));
      },
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
require('./helpers/nativeBridgeMock').installKyberModuleMock();
function installRealKyber() {
  require('./helpers/nativeBridgeMock').installKyberModuleMock();
  const { NativeModules } = require('react-native');
  Object.assign(NativeModules.KyberModule, realKyber());
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const kemSecret = () => crypto.randomBytes(32).toString('base64');
let clock = 0;
let realNow;

// ─── Teil 1 ─────────────────────────────────────────────────────────────────
function loadSession(device, peerId, role) {
  global.__mockDevice = device;
  let RS;
  let ES;
  let DR;
  jest.isolateModules(() => {
    installRealKyber();
    RS = require('../../RatchetSession');
    DR = require('../../DoubleRatchet');
    ES = require('react-native-encrypted-storage').default;
  });
  global.__mockDevice = undefined;
  return { RS, ES, DR, peerId, role, async setup(version = 2) {
    await ES.setItem('contacts', JSON.stringify([{ id: peerId, name: 'x', role }]));
    await RS.notePeerCaps(peerId, true, version);
  } };
}
const sealText = (d, text, conn) => d.RS.seal(d.peerId, JSON.stringify({ t: text }), { connSecret: conn });
const openText = async (d, env, conn = 'x') => JSON.parse(await d.RS.open(d.peerId, env, { candidates: [conn] })).t;
const record = (d) => JSON.parse(d.ES.__store.get('ratchet_' + d.peerId));

async function twoDevices(version = 2) {
  const a = loadSession('alice', 'c_bob', 'initiator');
  const b = loadSession('bob', 'c_alice', 'responder');
  await a.setup(version);
  await b.setup(version);
  const conn = kemSecret();
  await openText(b, await sealText(a, 'start', conn), conn);
  await openText(a, await sealText(b, 'ok', conn), conn);
  return { a, b, conn };
}
// Ein vollstaendiger Nachmisch-Vorgang A -> B -> A.
async function refresh(a, b) {
  const offer = await a.RS.preparePqOffer(a.peerId);
  const ans = await b.RS.acceptPqOffer(b.peerId, offer);
  const ok = await a.RS.completePqOffer(a.peerId, ans);
  return { offer, ans, ok };
}

describe('Teil 1: Sitzungsebene', () => {
  beforeEach(() => {
    global.__mockStores = {};
    global.__failSetItem = null;
    realNow = realNow || Date.now();
    clock = realNow;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => { jest.restoreAllMocks(); global.__failSetItem = null; });

  test('faellig erst nach 24 h oder 100 eigenen Nachrichten; nie mit Gegenseite v1; nicht waehrend ein Angebot offen ist', async () => {
    const { a, b, conn } = await twoDevices();                       // 'start' = Nachricht 1
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(false);
    for (let i = 0; i < 98; i++) await sealText(a, 'n' + i, conn);
    expect(record(a).pq.n).toBe(99);
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(false);
    await sealText(a, 'hundert', conn);
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(true);
    const offer = await a.RS.preparePqOffer(a.peerId);
    expect(offer.id).toMatch(/^[0-9a-f]{16}$/);
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(false);          // Angebot offen
    clock += HOUR + 1000;
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(true);           // abgelaufen -> neues Angebot
    // nach erfolgreichem Vorgang wieder 24 h Ruhe
    const r = await refresh(a, b);
    expect(r.ok).toBe(true);
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(false);
    clock += DAY + 1000;
    expect(await a.RS.pqRefreshDue(a.peerId)).toBe(true);
    // Gegenseite v1 (1.0/1.1): nie
    global.__mockStores = {};
    const v1 = await twoDevices(1);
    for (let i = 0; i < 150; i++) await sealText(v1.a, 'x', v1.conn);
    clock += 3 * DAY;
    expect(await v1.a.RS.pqRefreshDue(v1.a.peerId)).toBe(false);
    expect(await v1.a.RS.preparePqOffer(v1.a.peerId)).toBeNull();
    expect(await v1.b.RS.acceptPqOffer(v1.b.peerId, { id: '0123456789abcdef', pk: 'AAAA' })).toBeNull();
  });

  test('ein Vorgang: das neue Geheimnis fliesst in den naechsten DH-Schritt (Header-Kennung), wird nachgerechnet und verbraucht', async () => {
    const { a, b, conn } = await twoDevices();
    const { ans, ok } = await refresh(a, b);
    expect(ok).toBe(true);
    expect(record(b).held.map((e) => e.kid)).toContain(ans.kid);
    expect(record(a).own.map((e) => e.kid)).toContain(ans.kid);
    // A spricht, B antwortet mit neuem Ratchet-Schluessel -> A macht einen
    // DH-Schritt und mischt dabei ein.
    await openText(b, await sealText(a, 'von A', conn), conn);
    await openText(a, await sealText(b, 'von B', conn), conn);
    const env = await sealText(a, 'mit PQ', conn);
    expect(env.h.k).toEqual([ans.kid]);
    expect(await openText(b, env, conn)).toBe('mit PQ');
    expect(record(b).held.map((e) => e.kid)).not.toContain(ans.kid);
    expect(await openText(a, await sealText(b, 'weiter', conn), conn)).toBe('weiter');
  });

  test('beide Richtungen: jede Seite bietet selbst an', async () => {
    const { a, b, conn } = await twoDevices();
    const ra = await refresh(a, b);
    const rb = await refresh(b, a);
    expect(ra.ok && rb.ok).toBe(true);
    // Ketten wechseln abwechselnd: B's naechster DH-Schritt kommt mit A's
    // neuem Schluessel, A's mit dem danach folgenden von B.
    await openText(b, await sealText(a, 'a0', conn), conn);
    const eb = await sealText(b, 'b1', conn);
    expect(eb.h.k).toContain(rb.ans.kid);
    await openText(a, eb, conn);
    const ea = await sealText(a, 'a1', conn);
    expect(ea.h.k).toContain(ra.ans.kid);
    expect(await openText(b, ea, conn)).toBe('a1');
  });

  test('verlorenes Angebot: nichts passiert; nach Ablauf neues Angebot', async () => {
    const { a, b } = await twoDevices();
    await a.RS.preparePqOffer(a.peerId);                             // geht verloren
    const before = record(b);
    clock += HOUR + 1000;
    const r = await refresh(a, b);
    expect(r.ok).toBe(true);
    expect(before.held.length).toBe(record(b).held.length - 1);
    expect(record(a).pq.pending).toEqual([]);
  });

  test('verlorene Antwort: nichts wird eingemischt, Gespraech laeuft ohne kem-unknown weiter; der unbenutzte Eintrag verfaellt (V4)', async () => {
    const { a, b, conn } = await twoDevices();
    const offer = await a.RS.preparePqOffer(a.peerId);
    const ans = await b.RS.acceptPqOffer(b.peerId, offer);           // Antwort geht verloren
    for (let i = 0; i < 5; i++) {
      expect(await openText(b, await sealText(a, 'a' + i, conn), conn)).toBe('a' + i);
      expect(await openText(a, await sealText(b, 'b' + i, conn), conn)).toBe('b' + i);
    }
    expect(record(b).held.map((e) => e.kid)).toContain(ans.kid);
    clock += 9 * DAY;
    await openText(b, await sealText(a, 'spaeter', conn), conn);
    expect(record(b).held.map((e) => e.kid)).not.toContain(ans.kid);
  });

  test('umsortierte Nachrichten nach dem Einmischen: beide lesbar', async () => {
    const { a, b, conn } = await twoDevices();
    const { ok } = await refresh(a, b);
    expect(ok).toBe(true);
    await openText(a, await sealText(b, 'neuer Schluessel', conn), conn);
    const m1 = await sealText(a, 'eins', conn);
    const m2 = await sealText(a, 'zwei', conn);
    expect(await openText(b, m2, conn)).toBe('zwei');
    expect(await openText(b, m1, conn)).toBe('eins');
  });

  test('manipuliertes Chiffrat oder falsche Kennung: nichts eingemischt (Schluesselbestaetigung), Gespraech laeuft weiter', async () => {
    for (const tamper of ['ct', 'kid']) {
      global.__mockStores = {};
      const { a, b, conn } = await twoDevices();
      const offer = await a.RS.preparePqOffer(a.peerId);
      const ans = await b.RS.acceptPqOffer(b.peerId, offer);
      const bad = { ...ans };
      if (tamper === 'ct') { const buf = Buffer.from(ans.ct, 'base64'); buf[10] ^= 1; bad.ct = buf.toString('base64'); }
      else bad.kid = a.DR.kemId(kemSecret());
      expect(await a.RS.completePqOffer(a.peerId, bad)).toBe(false);
      expect(record(a).own.map((e) => e.kid)).not.toContain(ans.kid);
      expect(record(a).pq.pending).toEqual([]);
      await openText(a, await sealText(b, 'weiter', conn), conn);
      expect(await openText(b, await sealText(a, 'ohne PQ', conn), conn)).toBe('ohne PQ');
    }
  });

  test('doppeltes Angebot (Wiederholung) und Flut: nur einmal beantwortet, hoechstens eins pro Minute', async () => {
    const { a, b } = await twoDevices();
    const offer = await a.RS.preparePqOffer(a.peerId);
    expect(await b.RS.acceptPqOffer(b.peerId, offer)).toBeTruthy();
    clock += 2 * 60 * 1000;
    expect(await b.RS.acceptPqOffer(b.peerId, offer)).toBeNull();
    const second = await a.RS.preparePqOffer(a.peerId);
    expect(await b.RS.acceptPqOffer(b.peerId, second)).toBeTruthy();
    const third = await a.RS.preparePqOffer(a.peerId);
    expect(await b.RS.acceptPqOffer(b.peerId, third)).toBeNull();    // < 1 Minute
    expect(await b.RS.acceptPqOffer(b.peerId, { id: 'nicht-hex', pk: 'AAAA' })).toBeNull();
  });

  test('Sitzung wechselt zwischen Angebot und Antwort: Kennung passt nicht, nichts eingemischt (keine Gefahr fuer die neue Sitzung)', async () => {
    const { a, b } = await twoDevices();
    const offer = await a.RS.preparePqOffer(a.peerId);
    await a.RS.resetSession(a.peerId);
    await b.RS.resetSession(b.peerId);
    const conn = kemSecret();
    await openText(b, await sealText(a, 'neu', conn), conn);
    await openText(a, await sealText(b, 'neu ok', conn), conn);
    const ans = await b.RS.acceptPqOffer(b.peerId, offer);
    expect(await a.RS.completePqOffer(a.peerId, ans)).toBe(false);
    await openText(a, await sealText(b, 'weiter', conn), conn);
    expect(await openText(b, await sealText(a, 'laeuft', conn), conn)).toBe('laeuft');
  });

  test('Write-Ahead: Speicherfehler beim Annehmen bzw. Anbieten -> keine Antwort bzw. kein Angebot, Zustand unveraendert', async () => {
    const { a, b } = await twoDevices();
    const offer = await a.RS.preparePqOffer(a.peerId);
    const before = b.ES.__store.get('ratchet_' + b.peerId);
    global.__failSetItem = (dev, k) => dev === 'bob' && k.startsWith('ratchet_');
    await expect(b.RS.acceptPqOffer(b.peerId, offer)).rejects.toBeTruthy();
    expect(b.ES.__store.get('ratchet_' + b.peerId)).toBe(before);
    global.__failSetItem = (dev, k) => dev === 'alice' && k.startsWith('ratchet_');
    clock += HOUR + 1000;
    await expect(a.RS.preparePqOffer(a.peerId)).rejects.toBeTruthy();
    global.__failSetItem = null;
  });

  test('Faehigkeit v2 ist klebrig; Speicherabbild 1.1 (ohne rv/pq) bleibt lesbar und wird erst mit der Faehigkeit erweitert', async () => {
    const { a, conn } = await twoDevices(1);
    const rec11 = record(a);
    expect(rec11.rv).toBeUndefined();
    expect(rec11.pq).toBeUndefined();
    const a2 = loadSession('alice', a.peerId, 'initiator');          // Update
    expect(await a2.RS.isActive(a2.peerId)).toBe(true);
    await sealText(a2, 'nach Update', conn);
    expect(record(a2).pq).toBeUndefined();                          // Gegenseite noch 1.1
    const sessionBefore = record(a2).s;
    await a2.RS.notePeerCaps(a2.peerId, true, 2);
    expect(record(a2).rv).toBe(2);
    await a2.RS.notePeerCaps(a2.peerId, true, 1);                   // spaeteres Paket "1" nimmt nichts zurueck
    expect(record(a2).rv).toBe(2);
    expect(record(a2).s).toEqual(sessionBefore);                    // Sitzung unberuehrt
    expect(record(a2).cap).toBe(1);
  });
});

// ─── Teil 2: zwei vollstaendige Geraete ─────────────────────────────────────
const A_ID = 'c_alice';
const B_ID = 'c_bob';
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');

function loadDevice(name, peerId, role, { ratchetV1 = false } = {}) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    installRealKyber();
    if (ratchetV1) {
      jest.doMock('../../RatchetSession', () => ({ ...jest.requireActual('../../RatchetSession'), RATCHET_CAP_VERSION: 1 }));
    }
    dev = {
      name, peerId, role,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      MC: require('../../MessageCrypto'),
      ES: require('react-native-encrypted-storage').default,
    };
    if (ratchetV1) jest.dontMock('../../RatchetSession');
  });
  global.__mockDevice = undefined;
  dev.ready = (async () => {
    await dev.ES.setItem('contacts', JSON.stringify([{ id: peerId, name: peerId, role }]));
    await dev.ES.setItem('shared_secret_' + peerId, PAIR_SECRET);
    dev.RTCStore.sharedSecrets.set(peerId, PAIR_SECRET);
    await dev.BG.loadPreviousSecret(peerId);
    await dev.RTCStore.preloadContact(peerId);
  })();
  return dev;
}

function makeLink() {
  const net = { aToB: [], bToA: [] };
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; this.onmessage = null; } });
  const a = mk();
  const b = mk();
  a.send = (d) => { if (a.readyState !== 'open') throw new Error('Kanal zu'); net.aToB.push(d); setTimeout(() => b.onmessage?.({ data: d }), 0); };
  b.send = (d) => { if (b.readyState !== 'open') throw new Error('Kanal zu'); net.bToA.push(d); setTimeout(() => a.onmessage?.({ data: d }), 0); };
  return { a, b, net };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '') {
  const end = realNowFn() + ms;
  for (;;) {
    if (await fn()) return;
    if (realNowFn() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + what);
    await tick(10);
  }
}
let realNowFn = () => Date.now();

async function connect(alice, bob) {
  const link = makeLink();
  const rtcA = new alice.WebRTCManager(() => {}, () => {}, () => {});
  const rtcB = new bob.WebRTCManager(() => {}, () => {}, () => {});
  for (const [dev, rtc, ch, initiator] of [[alice, rtcA, link.a, true], [bob, rtcB, link.b, false]]) {
    rtc.isInitiator = initiator;
    rtc.pc = { iceConnectionState: 'connected', close() {} };
    rtc.dataChannel = ch;
    rtc._chainSecret = dev.RTCStore.getSharedSecret(dev.peerId);
    dev.RTCStore.setConnection(dev.peerId, rtc);
    rtc._onReady = () => dev.BG.flushQueue(dev.peerId, rtc);
    rtc._setupDataChannel(ch);
  }
  link.b.onopen();
  link.a.onopen();
  await waitFor(() => rtcA.keyExchangeDone && rtcB.keyExchangeDone, 5000, 'Schluesseltausch');
  await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown', 5000, 'Faehigkeiten');
  return { rtcA, rtcB, link };
}
const sendText = (dev, text, msgId) => dev.BG.sendViaOutbox(dev.peerId, 'text', { type: 'text', text, time: Date.now(), msgId }, msgId);
const queueLen = async (dev) => JSON.parse(await dev.ES.getItem('queue_' + dev.peerId) || '[]').length;
function innerOf(dev, raw, session) {
  const msg = JSON.parse(raw);
  if (msg.type !== 'encrypted') return { type: msg.subtype || msg.type, plain: true };
  const p = msg.v === 2
    ? (dev.MC.decryptOuterV2(msg.data, session, 'i2r') || dev.MC.decryptOuterV2(msg.data, session, 'r2i'))
    : dev.MC.decryptMsg(msg.data, session);
  return JSON.parse(p);
}

describe('Teil 2: ueber echte Verbindungen', () => {
  let alice;
  let bob;
  let offset = 0;
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => { console.log.mockRestore?.(); console.warn.mockRestore?.(); console.error.mockRestore?.(); });
  beforeEach(() => {
    global.__mockStores = {};
    global.__mockFiles = {};
    offset = 0;
    const real = Date.now.bind(Date);
    realNowFn = real;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  });
  afterEach(() => {
    for (const d of [alice, bob]) {
      d?.BG._resetOutboxForTests();
      for (const rtc of d?.RTCStore.connections.values() || []) { try { rtc.close(); } catch {} }
    }
    Date.now.mockRestore?.();
  });

  test('nach 24 h laeuft das Nachmischen von selbst, nur durch den Ratchet; das Geheimnis landet danach im Header', async () => {
    alice = loadDevice('alice', B_ID, 'initiator');
    bob = loadDevice('bob', A_ID, 'responder');
    await Promise.all([alice.ready, bob.ready]);
    const { rtcA, link } = await connect(alice, bob);
    await sendText(alice, 'hallo', 'h1');
    await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt');
    offset += DAY + 60 * 1000;
    await sendText(alice, 'einen Tag spaeter', 'h2');
    await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt 2');
    // Angebot und Antwort sind gelaufen ...
    await waitFor(async () => {
      const rec = JSON.parse(await alice.ES.getItem('ratchet_' + B_ID));
      return rec?.pq?.last > 0 && rec.own.length > 0;
    }, 5000, 'Nachmischen abgeschlossen');
    // ... und nie im Klartext der Verbindungsschicht: alles, was "pq_" enthaelt, ist ein Ratchet-Umschlag.
    const wire = [...link.net.aToB, ...link.net.bToA].map((r) => innerOf(alice, r, rtcA.sharedSecret));
    expect(wire.some((m) => m.subtype === 'pq_offer' || m.subtype === 'pq_ct')).toBe(false);
    // Beim naechsten DH-Schritt von Alice steht die Kennung im Header (ein
    // paar Wortwechsel, damit die Ketten wechseln).
    const ownKid = JSON.parse(await alice.ES.getItem('ratchet_' + B_ID)).own.at(-1).kid;
    const n0 = link.net.aToB.length;
    for (let i = 0; i < 3; i++) {
      await sendText(bob, 'von Bob ' + i, 'b' + i);
      await waitFor(async () => (await queueLen(bob)) === 0, 5000, 'b' + i);
      await sendText(alice, 'von Alice ' + i, 'a' + i);
      await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'a' + i);
    }
    const envs = link.net.aToB.slice(n0).map((r) => innerOf(alice, r, rtcA.sharedSecret)).filter((m) => m.type === 'ratchet');
    expect(envs.some((e) => Array.isArray(e.h.k) && e.h.k.includes(ownKid))).toBe(true);
    expect(JSON.parse(await bob.ES.getItem('ratchet_' + A_ID)).held.some((e) => e.kid === ownKid)).toBe(false);
  });

  test('Gegenseite mit Ratchet v1 (1.0/1.1): kein Angebot, auch nach Tagen', async () => {
    alice = loadDevice('alice', B_ID, 'initiator');
    bob = loadDevice('bob', A_ID, 'responder', { ratchetV1: true });
    await Promise.all([alice.ready, bob.ready]);
    const { rtcA, link } = await connect(alice, bob);
    await sendText(alice, 'hallo', 'v1');
    await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt');
    offset += 3 * DAY;
    await sendText(alice, 'Tage spaeter', 'v2');
    await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt 2');
    await tick(200);
    const rec = JSON.parse(await alice.ES.getItem('ratchet_' + B_ID));
    expect(rec.rv).toBeUndefined();
    expect(rec.pq).toBeUndefined();
    expect(link.net.aToB.length).toBeGreaterThan(0);
    expect(rtcA.kxVersion).toBe(2);                                // V5 unabhaengig davon
  });
});
