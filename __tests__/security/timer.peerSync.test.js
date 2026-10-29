// Chat-Timer gilt fuer beide Seiten - Nebenfund 1 vom 28.10.2026: Der
// Timer-Dialog schickte bis 1.2.0 ein secret_start ohne mins, das die
// Gegenseite verwarf. Sie uebernahm den Timer nie, ihre Antworten gingen ohne
// Timer raus und blieben auf beiden Seiten dauerhaft gespeichert.
// Jetzt: {subtype:'timer', mode, ts} ueber die Warteschlange (zugestellt, sobald
// eine Verbindung steht), bei geschlossenem Chat zentral uebernommen
// (BackgroundSync.applyControlSignal), bei gleichzeitigen Aenderungen gewinnt
// die juengere.
//
// Aufbau wie outbox.deliveryGuarantee.test.js: zwei "Geraete" mit eigener
// Modul-Instanz und eigenem Speicher, verbunden ueber ein Kanalpaar im
// Speicher, echte Verschluesselung.
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

const A_ID = 'c_alice'; // so heisst Alice auf Bobs Geraet
const B_ID = 'c_bob';   // so heisst Bob auf Alices Geraet
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + (what || fn.toString().slice(0, 140)));
    await tick(10);
  }
}

function loadDevice(name, peerId) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    dev = {
      name,
      peerId,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      MC: require('../../MessageCrypto'),
      ES: require('react-native-encrypted-storage').default,
    };
  });
  global.__mockDevice = undefined;
  dev.RTCStore.sharedSecrets.set(peerId, PAIR_SECRET);
  dev.ready = dev.BG.loadPreviousSecret(peerId).then(() => dev.RTCStore.preloadContact(peerId));
  return dev;
}

function makeLink() {
  const net = { aToB: [], bToA: [] };
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; } });
  const a = mk();
  const b = mk();
  a.send = (d) => {
    if (a.readyState !== 'open') throw new Error('Kanal zu');
    net.aToB.push(d);
    setTimeout(() => b.onmessage?.({ data: d }), 0);
  };
  b.send = (d) => {
    if (b.readyState !== 'open') throw new Error('Kanal zu');
    net.bToA.push(d);
    setTimeout(() => a.onmessage?.({ data: d }), 0);
  };
  return { a, b, net };
}

function attach(dev, ch, sessionSecret) {
  const rtc = new dev.WebRTCManager(() => {}, () => {}, () => {});
  rtc.chatId = dev.peerId;
  rtc.sharedSecret = sessionSecret;
  rtc.keyExchangeDone = true;
  rtc.dataChannel = ch;
  rtc.pc = { iceConnectionState: 'connected', close() {} };
  rtc._setupDataChannel(ch);
  rtc._lastActivity = Date.now();
  dev.RTCStore.sharedSecrets.set(dev.peerId, sessionSecret);
  dev.RTCStore.setConnection(dev.peerId, rtc);
  rtc._onReady = () => dev.BG.flushQueue(dev.peerId, rtc);
  return rtc;
}

async function connect(alice, bob) {
  const session = crypto.randomBytes(32).toString('base64');
  const link = makeLink();
  attach(alice, link.a, session);
  attach(bob, link.b, session);
  await Promise.all([alice.RTCStore.connections.get(B_ID)._onKeyExchange(), bob.RTCStore.connections.get(A_ID)._onKeyExchange()]);
  await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown',
    3000, 'Faehigkeiten ausgetauscht');
  return { link, session };
}

async function queueOf(dev) {
  const raw = await dev.ES.getItem('queue_' + dev.peerId);
  return raw ? JSON.parse(raw) : [];
}

// Genau wie der Timer-Dialog in App.tsx (ChatScreen, timerModal).
async function setTimerLikeDialog(dev, mode) {
  const ts = await dev.BG.setOwnTimer(dev.peerId, mode);
  await dev.BG.dropFromQueue(dev.peerId, (item) => item.type === 'system' && item.subtype === 'timer');
  await dev.BG.sendViaOutbox(dev.peerId, 'system', { type: 'system', subtype: 'timer', mode, ts }, 'timer_' + ts);
  return ts;
}

const timerOf = (dev) => dev.ES.getItem('timer_' + dev.peerId);

let alice;
let bob;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.warn.mockRestore?.();
});
beforeEach(async () => {
  global.__mockStores = {};
  global.__mockFiles = {};
  alice = loadDevice('alice', B_ID);
  bob = loadDevice('bob', A_ID);
  await Promise.all([alice.ready, bob.ready]);
});
afterEach(() => {
  for (const d of [alice, bob]) {
    d.BG._resetOutboxForTests();
    for (const rtc of d.RTCStore.connections.values()) { try { rtc.close(); } catch {} }
  }
});

describe('Chat-Timer auf beiden Seiten', () => {
  test('Bobs Chat geschlossen: Timer wird zentral uebernommen und erst danach bestaetigt', async () => {
    const { link, session } = await connect(alice, bob);
    const ts = await setTimerLikeDialog(alice, 'read');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'Signal bestaetigt');
    expect(await timerOf(bob)).toBe('read');
    expect(await bob.ES.getItem('timer_ts_' + A_ID)).toBe(String(ts));
    // Auf der Leitung: das neue Signal (plus Polsterung p), kein secret_start.
    const wire = link.net.aToB.map((d) => JSON.parse(d)).filter((m) => m.type === 'encrypted')
      .map((m) => JSON.parse(alice.MC.decryptMsg(m.data, session) || 'null')).filter(Boolean);
    const timers = wire.filter((m) => m.subtype === 'timer');
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ type: 'system', subtype: 'timer', mode: 'read', ts, ackId: 'timer_' + ts });
    expect(wire.some((m) => m.subtype === 'secret_start')).toBe(false);
  });

  test('Bobs Chat offen: der Listener bekommt das Signal (ChatScreen uebernimmt es dort)', async () => {
    const seen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => seen.push(m));
    await connect(alice, bob);
    await setTimerLikeDialog(alice, '7d');
    await waitFor(() => seen.some((m) => m.subtype === 'timer'), 3000, 'Signal bei Bob');
    expect(seen.find((m) => m.subtype === 'timer')).toMatchObject({ mode: '7d' });
  });

  test('ohne Verbindung gesetzt: wartet in der Warteschlange, nur die letzte Aenderung geht raus', async () => {
    await setTimerLikeDialog(alice, 'read');
    await setTimerLikeDialog(alice, '1h');
    const ts = await setTimerLikeDialog(alice, '24h');
    expect((await queueOf(alice)).map((i) => [i.subtype, i.msgId])).toEqual([['timer', 'timer_' + ts]]);
    const { link, session } = await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'Signal bestaetigt');
    expect(await timerOf(bob)).toBe('24h');
    const modes = link.net.aToB.map((d) => JSON.parse(d)).filter((m) => m.type === 'encrypted')
      .map((m) => JSON.parse(alice.MC.decryptMsg(m.data, session) || 'null'))
      .filter((m) => m && m.subtype === 'timer').map((m) => m.mode);
    expect(modes).toEqual(['24h']);
  });

  test('beide aendern offline: am Ende haben beide die juengere Einstellung', async () => {
    await setTimerLikeDialog(alice, 'read');
    await tick(3);
    await setTimerLikeDialog(bob, '24h');
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0 && (await queueOf(bob)).length === 0, 4000, 'beide bestaetigt');
    expect(await timerOf(alice)).toBe('24h');
    expect(await timerOf(bob)).toBe('24h');
  });

  test('ungueltige oder unvollstaendige Signale aendern nichts', async () => {
    await bob.ES.setItem('timer_' + A_ID, '1h');
    for (const msg of [
      { type: 'system', subtype: 'timer', mode: 'immer', ts: Date.now() },
      { type: 'system', subtype: 'timer', mode: 'off' },
      { type: 'system', subtype: 'timer', ts: Date.now() },
    ]) {
      expect(await bob.BG.applyControlSignal(A_ID, msg)).toBe(msg.mode === 'off');
    }
    expect(await timerOf(bob)).toBe('1h');
  });

  test('Kontakt loeschen bzw. Geraet zurueckgesetzt: auch der Timer-Zeitstempel verschwindet', async () => {
    await setTimerLikeDialog(alice, 'read');
    alice.BG.removeContactLocally(B_ID);
    await tick(5);
    expect(await alice.ES.getItem('timer_' + B_ID)).toBeNull();
    expect(await alice.ES.getItem('timer_ts_' + B_ID)).toBeNull();
    await setTimerLikeDialog(bob, 'read');
    bob.BG.wipeContactLocally(A_ID);
    await tick(5);
    expect(await bob.ES.getItem('timer_ts_' + A_ID)).toBeNull();
  });
});
