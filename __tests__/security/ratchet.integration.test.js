// Double Ratchet - Ende-zu-Ende mit zwei vollstaendigen "Geraeten" (eigene
// Modul-Instanzen von WebRTCManager/RTCStore/BackgroundSync/RatchetSession,
// eigener Speicher), verbunden ueber ein Kanalpaar im Speicher. Der Kyber-
// Schluesseltausch laeuft durch die echten Handler in WebRTCManager.js (nur
// die native Bruecke ist nachgebildet), sodass auch der KEM-Vorrat und der
// Post-Quanten-Schritt ueber echte Verbindungswechsel geprueft werden.
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

const A_ID = 'c_alice'; // so heisst Alice auf Bobs Geraet
const B_ID = 'c_bob';   // so heisst Bob auf Alices Geraet
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + (what || fn.toString().slice(0, 140)));
    await tick(10);
  }
}

// Native Kyber-Bruecke: nur nachgebildet (ML-KEM selbst laeuft nativ) - der
// Ciphertext transportiert das Geheimnis, gebunden an den oeffentlichen
// Schluessel; mit falschem Schluessel kommt ein anderes Geheimnis heraus
// (wie die implizite Ablehnung bei ML-KEM).
function installKyberBridge() {
  require('./helpers/nativeBridgeMock').installKyberModuleMock();
  const { NativeModules } = require('react-native');
  NativeModules.KyberModule.generateKeypair = async () => {
    const k = crypto.randomBytes(32).toString('base64');
    return { publicKey: k, secretKey: k };
  };
  NativeModules.KyberModule.encapsulate = async (publicKey) => {
    const sharedSecret = crypto.randomBytes(32).toString('base64');
    return { sharedSecret, cipherText: Buffer.from(JSON.stringify({ ss: sharedSecret, pk: publicKey })).toString('base64') };
  };
  NativeModules.KyberModule.decapsulate = async (cipherText, secretKey) => {
    const { ss, pk } = JSON.parse(Buffer.from(cipherText, 'base64').toString('utf8'));
    return pk === secretKey ? ss : crypto.randomBytes(32).toString('base64');
  };
}

// "Alte App-Version" ohne Double Ratchet: RatchetSession komplett ersetzt.
function oldAppRatchetStub() {
  return {
    RATCHET_ENABLED: false,
    RATCHET_CAP_VERSION: 1,
    preload: async () => {},
    hasSession: async () => false,
    isActive: async () => false,
    notePeerCaps: async () => {},
    noteConnectionKem: async () => {},
    seal: async () => null,
    open: async () => { throw new Error('alte Version kennt keinen Ratchet'); },
    purgeSkippedKeys: async () => {},
    resetSession: async () => {},
    forget: async () => {},
    forgetFromMemory: () => {},
    forgetAll: () => {},
  };
}

function loadDevice(name, peerId, role, { oldApp = false } = {}) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    installKyberBridge();
    if (oldApp) jest.doMock('../../RatchetSession', oldAppRatchetStub);
    dev = {
      name, peerId, role,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      sealForConnection: require('../../WebRTCManager').sealForConnection,
      MC: require('../../MessageCrypto'),
      RS: require('../../RatchetSession'),
      ES: require('react-native-encrypted-storage').default,
      RNFS: require('react-native-fs'),
    };
    if (oldApp) jest.dontMock('../../RatchetSession');
  });
  global.__mockDevice = undefined;
  dev.ready = (async () => {
    if (!(await dev.ES.getItem('contacts'))) {
      await dev.ES.setItem('contacts', JSON.stringify([{ id: peerId, name: peerId, role }]));
    }
    if (!(await dev.ES.getItem('shared_secret_' + peerId))) await dev.ES.setItem('shared_secret_' + peerId, PAIR_SECRET);
    const s = await dev.ES.getItem('shared_secret_' + peerId);
    dev.RTCStore.sharedSecrets.set(peerId, s);
    await dev.BG.loadPreviousSecret(peerId);
    await dev.RTCStore.preloadContact(peerId);
  })();
  return dev;
}

// Kanalpaar. net.dropBtoA: Rueckrichtung (z.B. Bestaetigungen) geht verloren.
function makeLink() {
  const net = { dead: false, dropBtoA: false, aToB: [], bToA: [] };
  // Geschlossener Kanal stellt nichts mehr zu (auch keine noch unterwegs befindlichen Pakete).
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; this.onmessage = null; } });
  const a = mk();
  const b = mk();
  a.send = (d) => {
    if (a.readyState !== 'open') throw new Error('Kanal zu');
    net.aToB.push(d);
    if (!net.dead) setTimeout(() => b.onmessage?.({ data: d }), 0);
  };
  b.send = (d) => {
    if (b.readyState !== 'open') throw new Error('Kanal zu');
    net.bToA.push(d);
    if (!net.dead && !net.dropBtoA) setTimeout(() => a.onmessage?.({ data: d }), 0);
  };
  return { a, b, net };
}

// Neue Verbindung MIT echtem Kyber-Ablauf (Alice ist Initiator dieser
// Verbindung, Bob kapselt) - danach Profil/Faehigkeiten und Warteschlange wie
// in der App (RTCStore._onKeyExchange, rtc._onReady).
async function connect(alice, bob) {
  const link = makeLink();
  const rtcA = new alice.WebRTCManager(() => {}, () => {}, () => {});
  const rtcB = new bob.WebRTCManager(() => {}, () => {}, () => {});
  for (const [dev, rtc, ch, initiator] of [[alice, rtcA, link.a, true], [bob, rtcB, link.b, false]]) {
    rtc.isInitiator = initiator;
    rtc.pc = { iceConnectionState: 'connected', close() {} };
    rtc.dataChannel = ch;
    dev.RTCStore.setConnection(dev.peerId, rtc);
    rtc._onReady = () => dev.BG.flushQueue(dev.peerId, rtc);
    rtc._setupDataChannel(ch);
  }
  link.b.onopen();
  link.a.onopen();
  await waitFor(() => rtcA.keyExchangeDone && rtcB.keyExchangeDone, 3000, 'Schluesseltausch');
  expect(rtcA.sharedSecret).toBe(rtcB.sharedSecret);
  await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown',
    3000, 'Faehigkeiten ausgetauscht');
  return { rtcA, rtcB, link, session: rtcA.sharedSecret };
}

function closeAll(...devs) {
  for (const d of devs) for (const rtc of d.RTCStore.connections.values()) { try { rtc.close(); } catch {} }
}

// Innere Schicht der Leitungs-Pakete (Verbindungsschicht mit dem Session-
// Secret geoeffnet - das kann nur, wer die Verbindung kennt).
function innerOf(dev, raw, session) {
  const msg = JSON.parse(raw);
  if (msg.type !== 'encrypted') return { type: msg.subtype || msg.type, plain: true };
  return JSON.parse(dev.MC.decryptMsg(msg.data, session));
}

async function queueOf(dev) {
  const raw = await dev.ES.getItem('queue_' + dev.peerId);
  return raw ? JSON.parse(raw) : [];
}
const record = async (dev) => JSON.parse(await dev.ES.getItem('ratchet_' + dev.peerId) || 'null');
const sendText = (dev, text, msgId) => dev.BG.sendViaOutbox(dev.peerId, 'text', { type: 'text', text, time: Date.now(), msgId }, msgId);

// Aktivierung: nach dem Faehigkeitsaustausch baut Alice (Rolle initiator) die
// Sitzung mit ihrer naechsten Nachricht auf; Bobs Bestaetigung aktiviert sie.
async function activate(alice, bob) {
  const conn = await connect(alice, bob);
  const bobSeen = [];
  bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
  await sendText(alice, 'Aktivierung', 'act1');
  await waitFor(async () => (await queueOf(alice)).length === 0, 5000, 'Aktivierung bestaetigt');
  await waitFor(async () => (await alice.RS.isActive(B_ID)) && (await bob.RS.isActive(A_ID)), 3000, 'beide aktiv');
  return { ...conn, bobSeen };
}

let alice;
let bob;
beforeAll(() => {
  if (process.env.RATCHET_TEST_LOGS) return;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.warn.mockRestore?.();
  console.error.mockRestore?.();
});
beforeEach(async () => {
  global.__mockStores = {};
  global.__mockFiles = {};
  alice = loadDevice('alice', B_ID, 'initiator');
  bob = loadDevice('bob', A_ID, 'responder');
  await Promise.all([alice.ready, bob.ready]);
});
afterEach(() => {
  for (const d of [alice, bob]) d.BG._resetOutboxForTests();
  closeAll(alice, bob);
});

describe('Aktivierung und Grundablauf ueber echte Verbindungen', () => {
  test('Faehigkeit ausgetauscht -> Alice baut auf, Inhalte gehen nur noch per Ratchet ueber die Leitung, beide Seiten aktiv', async () => {
    const { link, session, bobSeen } = await activate(alice, bob);
    expect(bobSeen.filter((m) => m.type === 'text').map((m) => m.text)).toEqual(['Aktivierung']);
    // Auf der Leitung: der Text liegt (innen) nur als Ratchet-Umschlag vor.
    const inner = link.net.aToB.map((r) => innerOf(alice, r, session));
    const textCarrier = inner.filter((m) => m.type === 'ratchet');
    expect(textCarrier.length).toBeGreaterThan(0);
    expect(inner.some((m) => m.type === 'text')).toBe(false);
    expect(link.net.aToB.join('\n')).not.toMatch(/Aktivierung/);
    // Bobs Bestaetigung kam ebenfalls per Ratchet.
    expect(link.net.bToA.map((r) => innerOf(bob, r, session)).some((m) => m.type === 'ratchet')).toBe(true);
    const rb = await record(bob);
    expect(rb.s).toMatchObject({ role: 'bob', active: true });
    expect((await record(alice)).s).toMatchObject({ role: 'alice', active: true });
  });

  test('Fuellpakete sind bei Ratchet-Kontakten genauso gross wie kurze echte Nachrichten (1024er-Block)', async () => {
    const { link, session } = await activate(alice, bob);
    const before = link.net.aToB.length;
    await sendText(alice, 'kurz', 'k1');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000);
    const textLen = link.net.aToB.slice(before).map((r) => JSON.parse(r))
      .filter((m) => m.type === 'encrypted').map((m) => m.data.length);
    expect(textLen.length).toBeGreaterThan(0);
    // Fuellpaket auf demselben Weg wie der feste Takt (_startCoverTraffic).
    const rtcA = alice.RTCStore.connections.get(B_ID);
    const dummyWire = JSON.parse(await alice.sealForConnection(rtcA, { type: 'dummy' }));
    expect(new Set([...textLen, dummyWire.data.length]).size).toBe(1);
    expect(innerOf(alice, JSON.stringify(dummyWire), session).type).toBe('dummy');
    // Zum Vergleich: ohne Ratchet (alte Gegenseite) bleibt es beim 512er-Block.
    const legacyDummy = JSON.parse(await alice.sealForConnection({ sharedSecret: session }, { type: 'dummy' }));
    expect(legacyDummy.data.length).toBeLessThan(dummyWire.data.length);
  });
});

describe('Warteschlange: erst beim Senden verschluesselt, jede Wiederholung neu', () => {
  test('Bestaetigung verloren -> Wiederholung mit NEUEM Nachrichtenschluessel, beim Empfaenger genau einmal angezeigt', async () => {
    const { link, session, rtcA, rtcB, bobSeen } = await activate(alice, bob);
    link.net.dropBtoA = true; // Bestaetigung geht verloren
    const n0 = link.net.aToB.length;
    await sendText(alice, 'genau einmal', 'once1');
    await waitFor(() => bobSeen.filter((m) => m.text === 'genau einmal').length === 1, 4000, 'Original');
    const firstEnvs = link.net.aToB.slice(n0).map((r) => innerOf(alice, r, session)).filter((m) => m.type === 'ratchet');
    expect((await queueOf(alice))).toHaveLength(1);
    // Im Ruhezustand: lokaler Schluessel, kein Verbindungs-Secret im Index.
    const [item] = await queueOf(alice);
    expect(item.k).toEqual(expect.any(String));
    expect(item.secretUsed).toBeUndefined();
    expect(alice.RNFS.__files.get(item.path)).not.toMatch(/genau einmal/);

    rtcA.close(); rtcB.close();
    const second = await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 5000, 'Wiederholung bestaetigt');
    const secondEnvs = second.link.net.aToB.map((r) => innerOf(alice, r, second.session)).filter((m) => m.type === 'ratchet');
    // Neu verschluesselt: kein Umschlag der zweiten Verbindung gleicht einem der ersten.
    const firstKeys = new Set(firstEnvs.map((e) => e.h.d + '|' + e.h.n));
    expect(secondEnvs.some((e) => firstKeys.has(e.h.d + '|' + e.h.n))).toBe(false);
    expect(new Set(firstEnvs.map((e) => e.c)).has(secondEnvs[0].c)).toBe(false);
    expect(bobSeen.filter((m) => m.text === 'genau einmal')).toHaveLength(1);
  });

  test('Neustart beider Geraete: Ratchet-Zustand bleibt, Gespraech laeuft weiter', async () => {
    const { rtcA, rtcB } = await activate(alice, bob);
    rtcA.close(); rtcB.close();
    alice = loadDevice('alice', B_ID, 'initiator');
    bob = loadDevice('bob', A_ID, 'responder');
    await Promise.all([alice.ready, bob.ready]);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const conn = await connect(alice, bob);
    await sendText(alice, 'nach dem Neustart', 'r1');
    await waitFor(() => bobSeen.some((m) => m.text === 'nach dem Neustart'), 5000, 'Zustellung');
    // Gleiche Sitzung (kein Neuaufbau): Bob ist weiterhin "bob", Leitung nur Ratchet.
    expect((await record(bob)).s.role).toBe('bob');
    expect(conn.link.net.aToB.map((r) => innerOf(alice, r, conn.session)).some((m) => m.type === 'text')).toBe(false);
  });

  test('Migration: Altbestand der Warteschlange (Verbindungs-Secret im Index) wird beim Start auf einen lokalen Schluessel umgestellt und zugestellt', async () => {
    // Eintrag im alten Format (vor dem Ratchet-Umbau) anlegen.
    const legacyPath = '/mock/alice/queue_text_old1.enc';
    const payload = { type: 'text', text: 'aus dem Altbestand', time: Date.now(), msgId: 'old1' };
    alice.RNFS.__files.set(legacyPath, await alice.MC.encryptMsg(JSON.stringify(payload), PAIR_SECRET));
    await alice.ES.setItem('queue_' + B_ID, JSON.stringify([
      { type: 'text', path: legacyPath, encrypted: true, msgId: 'old1', secretUsed: PAIR_SECRET, createdAt: Date.now(), attempts: 0 },
    ]));
    alice = loadDevice('alice', B_ID, 'initiator'); // App-Start -> loadPreviousSecret -> Migration
    await alice.ready;
    await waitFor(async () => !!(await queueOf(alice))[0]?.k, 3000, 'Migration');
    const [item] = await queueOf(alice);
    expect(item.secretUsed).toBeUndefined();
    expect(alice.RNFS.__files.has(legacyPath)).toBe(false);
    expect(alice.MC.decryptMsg(alice.RNFS.__files.get(item.path), PAIR_SECRET)).toBeFalsy();
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    await connect(alice, bob);
    await waitFor(() => bobSeen.some((m) => m.text === 'aus dem Altbestand'), 5000, 'Zustellung');
  });
});

describe('Medien mit Dateischluessel', () => {
  const IMG = () => crypto.randomBytes(110000).toString('base64'); // ~147 KB -> 3 Chunks

  test('Chunks nur mit Dateischluessel + Verbindungsschicht, Schluessel im Ratchet-End-Marker; Bild kommt exakt an', async () => {
    const { link, session } = await activate(alice, bob);
    const images = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => { if (m.type === 'image_complete') images.push(m); });
    const base64 = IMG();
    const n0 = link.net.aToB.length;
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64, mimeType: 'image/png' }, 'img1');
    await waitFor(() => images.length === 1, 8000, 'Bild');
    expect(images[0].base64).toBe(base64);
    expect(images[0].mimeType).toBe('image/png');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'bestaetigt');
    const inner = link.net.aToB.slice(n0).map((r) => innerOf(alice, r, session));
    const chunks = inner.filter((m) => m.type === 'img_chunk');
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.fk).toBe(1);
      expect(base64.includes(c.data.slice(0, 200))).toBe(false); // nicht der Klartext-Abschnitt
    }
    // Kein End-Marker ohne Ratchet auf der Leitung.
    expect(inner.some((m) => m.type === 'img_end')).toBe(false);
  });

  test('manipulierter Chunk (Angreifer kennt den Verbindungsschluessel): Medium verworfen, keine Bestaetigung; die naechste Uebertragung kommt an', async () => {
    const { link, session, rtcA, rtcB } = await activate(alice, bob);
    const images = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => { if (m.type === 'image_complete') images.push(m); });
    // Angreifer mit Verbindungsschluessel: oeffnet die Verbindungsschicht,
    // kippt ein Bit im (dateischluessel-verschluesselten) Chunk 1 und
    // verschluesselt neu.
    let tampered = 0;
    const origSend = link.a.send;
    link.a.send = (d) => {
      const msg = JSON.parse(d);
      if (!tampered && msg.type === 'encrypted') {
        const inner = JSON.parse(alice.MC.decryptMsg(msg.data, session));
        if (inner.type === 'img_chunk' && inner.index === 1) {
          tampered++;
          const ct = Buffer.from(inner.data, 'base64');
          ct[100] ^= 1;
          alice.MC.encryptMsg(JSON.stringify({ ...inner, data: ct.toString('base64') }), session)
            .then((data) => origSend.call(link.a, JSON.stringify({ type: 'encrypted', data })));
          return undefined;
        }
      }
      return origSend.call(link.a, d);
    };
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG(), mimeType: 'image/jpeg' }, 'img2');
    await waitFor(async () => !!alice.BG._outboxRecordForTests(B_ID, 'img2'), 8000, 'uebergeben');
    await tick(300);
    expect(tampered).toBe(1);
    expect(images).toHaveLength(0);
    expect(await queueOf(alice)).toHaveLength(1); // keine Bestaetigung
    link.a.send = origSend;
    rtcA.close(); rtcB.close();
    await connect(alice, bob);
    await waitFor(() => images.length === 1, 8000, 'Wiederholung');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000);
  });
});

describe('Kompatibilitaet und Downgrade-Schutz', () => {
  test('alte Gegenseite (ohne Ratchet-Faehigkeit): alles laeuft wie bisher, nie ein Ratchet-Umschlag auf der Leitung', async () => {
    bob = loadDevice('bob', A_ID, 'responder', { oldApp: true });
    await bob.ready;
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { link, session } = await connect(alice, bob);
    await sendText(alice, 'an die alte Version', 'o1');
    await waitFor(async () => (await queueOf(alice)).length === 0, 5000, 'bestaetigt');
    expect(bobSeen.filter((m) => m.type === 'text').map((m) => m.text)).toEqual(['an die alte Version']);
    const all = [...link.net.aToB.map((r) => innerOf(alice, r, session)), ...link.net.bToA.map((r) => innerOf(alice, r, session))];
    expect(all.some((m) => m.type === 'ratchet')).toBe(false);
    const ra = await record(alice);
    expect(ra.s).toBeNull();
    expect(ra.cap).toBe(0);
    expect(ra.held).toEqual([]);
    // Medien ebenfalls im alten Verfahren.
    const images = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => { if (m.type === 'image_complete') images.push(m); });
    const base64 = crypto.randomBytes(3000).toString('base64');
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64, mimeType: 'image/jpeg' }, 'oi1');
    await waitFor(() => images.length === 1, 5000, 'Bild');
    expect(images[0].base64).toBe(base64);
  });

  test('alte Gegenseite in der Initiator-Rolle: die neue Seite baut nie selbst auf', async () => {
    alice = loadDevice('alice', B_ID, 'initiator', { oldApp: true });
    await alice.ready;
    const aliceSeen = [];
    alice.RTCStore.setMessageListener(B_ID, (m) => aliceSeen.push(m));
    const { link, session } = await connect(alice, bob);
    await sendText(bob, 'von der neuen Seite', 'n1');
    await waitFor(() => aliceSeen.some((m) => m.text === 'von der neuen Seite'), 5000);
    expect(link.net.bToA.map((r) => innerOf(bob, r, session)).some((m) => m.type === 'ratchet')).toBe(false);
    expect((await record(bob)).s).toBeNull();
  });

  test('kein Downgrade nach Aktivierung: Nachrichten ohne Ratchet (auch mit gueltiger Verbindungsschicht) werden abgelehnt; Fuellpakete nicht', async () => {
    const { link, session, bobSeen } = await activate(alice, bob);
    const inject = async (obj) => {
      const data = await alice.MC.encryptMsg(JSON.stringify(obj), session);
      await link.b.onmessage({ data: JSON.stringify({ type: 'encrypted', data }) });
    };
    await inject({ type: 'text', text: 'altes Format', time: Date.now(), msgId: 'dg1' });
    await inject({ type: 'system', subtype: 'clear_chat', ts: Date.now(), ackId: 'dg2' });
    await inject({ type: 'img_chunk', imageId: 'x', index: 0, total: 1, data: 'AAAA', realLen: 4, mimeType: 'image/jpeg' });
    await inject({ type: 'img_end', imageId: 'x', total: 1, mimeType: 'image/jpeg', msgId: 'dg3' });
    await inject({ type: 'receipt', msgId: 'act1', status: 'delivered' });
    await inject({ type: 'dummy' });
    await tick(100);
    expect(bobSeen.filter((m) => ['text', 'image_complete', 'receipt'].includes(m.type) && m.text !== 'Aktivierung')).toEqual([]);
    expect(bobSeen.some((m) => m.subtype === 'clear_chat')).toBe(false);
    // Und es bleibt dabei - auch nach einem Neustart.
    bob = loadDevice('bob', A_ID, 'responder');
    await bob.ready;
    expect(await bob.RS.isActive(A_ID)).toBe(true);
  });

  test('Replay eines mitgeschnittenen Ratchet-Pakets wird abgelehnt', async () => {
    const { link, bobSeen } = await activate(alice, bob);
    const n0 = link.net.aToB.length;
    await sendText(alice, 'nur einmal', 'rp1');
    await waitFor(() => bobSeen.some((m) => m.text === 'nur einmal'), 4000);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000);
    // Bobs Dedup-Liste vergessen lassen (Angreifer will den Ratchet selbst testen).
    bob.RTCStore._seen.clear();
    await bob.ES.removeItem('rx_seen_' + A_ID);
    for (const raw of link.net.aToB.slice(n0)) await link.b.onmessage({ data: raw });
    await tick(100);
    expect(bobSeen.filter((m) => m.text === 'nur einmal')).toHaveLength(1);
  });
});

describe('Post-Quanten-Schritt ueber echte Verbindungswechsel', () => {
  test('das ML-KEM-Geheimnis einer neuen Verbindung fliesst in den Root Key (Header-Kennung) und wird danach aus dem Vorrat entfernt', async () => {
    const first = await activate(alice, bob);
    first.rtcA.close(); first.rtcB.close();
    const second = await connect(alice, bob);
    const kid = require('../../DoubleRatchet').kemId(second.session);
    // Bob hat gekapselt -> Vorrat "held"; Alice hat entkapselt -> "own".
    await waitFor(async () => (await record(bob)).held.some((e) => e.kid === kid) || (await record(alice)).s.sendKids?.includes(kid), 3000, 'KEM eingetragen');
    // Ein paar Sprecherwechsel ueber die Warteschlange.
    for (let i = 0; i < 3; i++) {
      await sendText(alice, 'a' + i, 'pa' + i);
      await waitFor(async () => (await queueOf(alice)).length === 0, 4000);
      await sendText(bob, 'b' + i, 'pb' + i);
      await waitFor(async () => (await queueOf(bob)).length === 0, 4000);
    }
    const aliceEnvs = second.link.net.aToB.map((r) => innerOf(alice, r, second.session)).filter((m) => m.type === 'ratchet');
    expect(aliceEnvs.some((e) => Array.isArray(e.h.k) && e.h.k.includes(kid))).toBe(true);
    expect((await record(bob)).held.some((e) => e.kid === kid)).toBe(false);
    expect((await record(alice)).own.some((e) => e.kid === kid)).toBe(false);
  });
});

describe('Loeschen', () => {
  test('Kontakt loeschen entfernt Ratchet-Zustand, KEM-Vorrat und uebersprungene Schluessel dauerhaft', async () => {
    await activate(alice, bob);
    expect(bob.ES.__store.has('ratchet_' + A_ID)).toBe(true);
    bob.BG.removeContactLocally(A_ID);
    await waitFor(() => !bob.ES.__store.has('ratchet_' + A_ID), 3000, 'geloescht');
    expect(bob.RS._peekRecordForTests(A_ID)).toBeNull();
  });

  test('Gegenseite meldet "Geraet zurueckgesetzt" (device_wiped): Ratchet-Zustand wird mit geloescht', async () => {
    await activate(alice, bob);
    bob.BG.wipeContactLocally(A_ID);
    await waitFor(() => !bob.ES.__store.has('ratchet_' + A_ID), 3000, 'geloescht');
  });

  test('Wipe/Duress (RTCStore.resetAll + Speicher leeren): nichts bleibt, nichts wird nachtraeglich zurueckgeschrieben', async () => {
    await activate(alice, bob);
    bob.RTCStore.resetAll();
    await bob.ES.clear();
    await tick(200);
    expect([...bob.ES.__store.keys()].filter((k) => k.startsWith('ratchet_'))).toEqual([]);
    expect(bob.RS._peekRecordForTests(A_ID)).toBeNull();
  });

  test('Secret Chat beendet: gespeicherte Schluessel uebersprungener Nachrichten werden verworfen', async () => {
    const { rtcA } = await activate(alice, bob);
    // Eine Nachricht geht verloren (wird verschluesselt, aber nie zugestellt) ...
    await alice.RS.seal(B_ID, JSON.stringify({ type: 'dummy-verloren' }), { connSecret: rtcA.sharedSecret });
    // ... die naechste kommt an -> Bob speichert den Schluessel der Luecke.
    await sendText(alice, 'danach', 'sk1');
    await waitFor(async () => (await record(bob)).s.skipped.length === 1, 4000, 'Luecke');
    await bob.BG.dropEphemeralFromQueue(A_ID);
    await waitFor(async () => (await record(bob)).s.skipped.length === 0, 3000, 'verworfen');
  });
});
