// Krypto-Review 2026-10-25, K-09: aeussere Schicht v2 - Schluessel je
// Richtung (i2r/r2i) und AAD "malachi-conn-v2|<richtung>|<zweck>",
// ausgehandelt ueber "ol: 2" im Kyber-Handshake. Aeltere Gegenseiten bleiben
// bei v1; nach der ersten v2-Verbindung eines Kontakts wird v1 abgelehnt.
// Teil 1: MessageCrypto direkt. Teil 2: zwei vollstaendige Geraete ueber echte
// Verbindungen (wie ratchet.integration.test.js).
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

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + what);
    await tick(10);
  }
}

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
installKyberBridge();

describe('Teil 1: Kryptografie der Schicht v2', () => {
  let MC;
  beforeAll(() => {
    global.__mockDevice = 'krypto';
    jest.isolateModules(() => { installKyberBridge(); MC = require('../../MessageCrypto'); });
    global.__mockDevice = undefined;
  });
  const K = crypto.randomBytes(32).toString('base64');

  test('Hin und zurueck je Richtung; Richtungen und Initiator-Rolle passen zusammen', async () => {
    expect(MC.outerDirection(true, true)).toBe('i2r');
    expect(MC.outerDirection(false, false)).toBe('i2r');
    expect(MC.outerDirection(false, true)).toBe('r2i');
    expect(MC.outerDirection(true, false)).toBe('r2i');
    const c = await MC.encryptOuterV2('hallo', K, 'i2r');
    expect(MC.decryptOuterV2(c, K, 'i2r')).toBe('hallo');
  });

  test('Spiegelung (andere Richtung), anderer Zweck, altes Format und Bitfehler: nicht entschluesselbar', async () => {
    const c = await MC.encryptOuterV2('geheim', K, 'i2r');
    expect(MC.decryptOuterV2(c, K, 'r2i')).toBeNull();
    expect(MC.decryptOuterV2(c, K, 'i2r', 'call-signal')).toBeNull();
    expect(MC.decryptMsg(c, K)).toBeNull();
    const raw = Buffer.from(c, 'base64');
    for (const pos of [0, 30, raw.length - 1]) {
      const t = Buffer.from(raw); t[pos] ^= 1;
      expect(MC.decryptOuterV2(t.toString('base64'), K, 'i2r')).toBeNull();
    }
    const v1 = await MC.encryptMsg('alt', K);
    expect(MC.decryptOuterV2(v1, K, 'i2r')).toBeNull();
    expect(MC.decryptOuterV2(v1, K, 'r2i')).toBeNull();
    expect(MC.decryptOuterV2(c, K, 'x2y')).toBeNull();
  });

  test('ohne AAD unveraendert zum bisherigen Format (1.0/1.1 lesen es weiter)', async () => {
    const c = await MC.encryptMsg('wie bisher', K);
    expect(MC.decryptMsg(c, K)).toBe('wie bisher');
    expect(MC.decryptMsg(c, K, 'message', undefined)).toBe('wie bisher');
    // Die AAD ist wirklich gebunden: gleicher Schluessel, andere AAD -> Fehler.
    const enc = (s) => Uint8Array.from(Buffer.from(s, 'utf8'));
    const withAad = await MC.encryptMsg('x', K, 'message', enc('a'));
    expect(MC.decryptMsg(withAad, K, 'message', enc('b'))).toBeNull();
    expect(MC.decryptMsg(withAad, K, 'message', enc('a'))).toBe('x');
  });
});

// ─── Teil 2: Geraete ────────────────────────────────────────────────────────
const A_ID = 'c_alice';
const B_ID = 'c_bob';
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');

function loadDevice(name, peerId, role, { oldApp = false } = {}) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    installKyberBridge();
    dev = {
      name, peerId, role, oldApp,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      MC: require('../../MessageCrypto'),
      ConnCaps: require('../../ConnCaps'),
      ES: require('react-native-encrypted-storage').default,
    };
  });
  global.__mockDevice = undefined;
  dev.ready = (async () => {
    if (!(await dev.ES.getItem('contacts'))) await dev.ES.setItem('contacts', JSON.stringify([{ id: peerId, name: peerId, role }]));
    if (!(await dev.ES.getItem('shared_secret_' + peerId))) await dev.ES.setItem('shared_secret_' + peerId, PAIR_SECRET);
    dev.RTCStore.sharedSecrets.set(peerId, await dev.ES.getItem('shared_secret_' + peerId));
    await dev.BG.loadPreviousSecret(peerId);
    await dev.RTCStore.preloadContact(peerId);
  })();
  return dev;
}

// 1.0/1.1 kennen die neuen Handshake-Felder nicht (senden sie nicht, ignorieren sie).
const strip = (raw, fields) => {
  try {
    const m = JSON.parse(raw);
    if (m?.type === 'system' && /^kyber_/.test(m.subtype)) { for (const f of fields) delete m[f]; return JSON.stringify(m); }
  } catch {}
  return raw;
};
function makeLink({ aOld = false, bOld = false, tamperAtoB = null, tamperBtoA = null } = {}) {
  const net = { aToB: [], bToA: [] };
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; this.onmessage = null; } });
  const a = mk();
  const b = mk();
  const NEW = ['ol', 'kx', 'x', 'ck'];
  a.send = (d) => {
    if (a.readyState !== 'open') throw new Error('Kanal zu');
    let out = aOld ? strip(d, NEW) : d;
    if (tamperAtoB) out = tamperAtoB(out);
    if (bOld) out = strip(out, NEW);
    net.aToB.push(out);
    setTimeout(() => b.onmessage?.({ data: out }), 0);
  };
  b.send = (d) => {
    if (b.readyState !== 'open') throw new Error('Kanal zu');
    let out = bOld ? strip(d, NEW) : d;
    if (tamperBtoA) out = tamperBtoA(out);
    if (aOld) out = strip(out, NEW);
    net.bToA.push(out);
    setTimeout(() => a.onmessage?.({ data: out }), 0);
  };
  return { a, b, net };
}

async function connect(alice, bob, linkOpts = {}, { expectOk = true } = {}) {
  const link = makeLink({ aOld: alice.oldApp, bOld: bob.oldApp, ...linkOpts });
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
  if (expectOk) {
    await waitFor(() => rtcA.keyExchangeDone && rtcB.keyExchangeDone, 3000, 'Schluesseltausch');
    await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown', 3000, 'Faehigkeiten');
  } else {
    await tick(150);
  }
  return { rtcA, rtcB, link };
}

const sendText = (dev, text, msgId) => dev.BG.sendViaOutbox(dev.peerId, 'text', { type: 'text', text, time: Date.now(), msgId }, msgId);
const queueLen = async (dev) => JSON.parse(await dev.ES.getItem('queue_' + dev.peerId) || '[]').length;
const encryptedOf = (list) => list.map((d) => JSON.parse(d)).filter((m) => m.type === 'encrypted');
const kyberOf = (list, sub) => list.map((d) => JSON.parse(d)).find((m) => m.subtype === sub);

describe('Teil 2: Aushandlung, Kompatibilitaet, Rueckstufung', () => {
  let alice;
  let bob;
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => { console.log.mockRestore?.(); console.warn.mockRestore?.(); console.error.mockRestore?.(); });
  beforeEach(async () => {
    global.__mockStores = {};
    global.__mockFiles = {};
  });
  afterEach(() => {
    for (const d of [alice, bob]) {
      d?.BG._resetOutboxForTests();
      for (const rtc of d?.RTCStore.connections.values() || []) { try { rtc.close(); } catch {} }
    }
  });
  async function devices(opts = {}) {
    alice = loadDevice('alice', B_ID, 'initiator', { oldApp: !!opts.aliceOld });
    bob = loadDevice('bob', A_ID, 'responder', { oldApp: !!opts.bobOld });
    await Promise.all([alice.ready, bob.ready]);
  }

  test('neu <-> neu: ol 2 ausgehandelt, jedes verschluesselte Paket in v2, Nachricht kommt an, Kontakt als v2 gemerkt', async () => {
    await devices();
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { rtcA, rtcB, link } = await connect(alice, bob);
    expect(kyberOf(link.net.aToB, 'kyber_pubkey').ol).toBe(2);
    expect(kyberOf(link.net.bToA, 'kyber_ciphertext').ol).toBe(2);
    expect(rtcA.outerVersion).toBe(2);
    expect(rtcB.outerVersion).toBe(2);
    await sendText(alice, 'ueber v2', 'o1');
    await waitFor(() => bobSeen.some((m) => m.text === 'ueber v2'), 5000, 'zugestellt');
    const enc = [...encryptedOf(link.net.aToB), ...encryptedOf(link.net.bToA)];
    expect(enc.length).toBeGreaterThan(3);
    expect(enc.every((m) => m.v === 2)).toBe(true);
    await waitFor(async () => (await alice.ConnCaps.getConnCaps(B_ID)).ol === 2 && (await bob.ConnCaps.getConnCaps(A_ID)).ol === 2, 3000, 'gemerkt');
  });

  test('gespiegeltes Paket (Bob bekommt sein eigenes zurueck) wird nicht angenommen', async () => {
    await devices();
    const aliceSeen = [];
    alice.RTCStore.setMessageListener(B_ID, (m) => aliceSeen.push(m));
    const { link } = await connect(alice, bob);
    const n0 = link.net.aToB.length;
    await sendText(alice, 'nur einmal', 'r1');
    await waitFor(async () => (await queueLen(alice)) === 0, 5000, 'zugestellt');
    // Ein Angreifer im Transport spiegelt Alices Pakete an Alice zurueck.
    for (const raw of link.net.aToB.slice(n0)) await link.a.onmessage?.({ data: raw });
    await tick(100);
    expect(aliceSeen.some((m) => m.text === 'nur einmal')).toBe(false);
  });

  test('Format innerhalb einer Verbindung fest: v1-Paket auf v2-Verbindung verworfen', async () => {
    await devices();
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { rtcA, rtcB, link } = await connect(alice, bob);
    const body = JSON.stringify({ type: 'text', text: 'altes Format', msgId: 'v1x', time: Date.now() });
    const v1 = { type: 'encrypted', data: await alice.MC.encryptMsg(body, rtcA.sharedSecret) };
    const v2 = { type: 'encrypted', v: 2, data: await alice.MC.encryptOuterV2(body, rtcA.sharedSecret, 'i2r') };
    expect(rtcB._openOuter(v1)).toBeNull();
    expect(rtcB._openOuter({ ...v2, v: undefined })).toBeNull();
    expect(rtcB._openOuter(v2)).toBe(body);
    await link.b.onmessage({ data: JSON.stringify(v1) });
    await tick(50);
    expect(bobSeen.some((m) => m.text === 'altes Format')).toBe(false);
  });

  test.each([['Alice', { aliceOld: true }], ['Bob', { bobOld: true }]])('Gegenseite 1.1 (%s alt): v1 wie bisher, Nachrichten kommen an', async (_, opts) => {
    await devices(opts);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { rtcA, rtcB, link } = await connect(alice, bob);
    expect(rtcA.outerVersion).toBe(1);
    expect(rtcB.outerVersion).toBe(1);
    await sendText(alice, 'an 1.1', 'x1');
    await waitFor(() => bobSeen.some((m) => m.text === 'an 1.1'), 5000, 'zugestellt');
    expect(encryptedOf(link.net.aToB).every((m) => m.v === undefined)).toBe(true);
    expect((await alice.ConnCaps.getConnCaps(B_ID)).ol).toBeUndefined();
  });

  test('Rueckstufung: nach einer v2-Verbindung entfernt ein Angreifer "ol" aus dem Angebot -> Verbindung abgelehnt', async () => {
    await devices();
    const first = await connect(alice, bob);
    await sendText(alice, 'erst', 'd1');
    await waitFor(async () => (await bob.ConnCaps.getConnCaps(A_ID)).ol === 2, 3000, 'gemerkt');
    first.rtcA.close(); first.rtcB.close();
    const second = await connect(alice, bob, { tamperAtoB: (d) => strip(d, ['ol']) }, { expectOk: false });
    expect(second.rtcB.keyExchangeDone).toBe(false);
    expect(second.rtcB._closed).toBe(true);
    expect(kyberOf(second.link.net.bToA, 'kyber_ciphertext')).toBeUndefined();
  });

  test('Rueckstufung: Angreifer entfernt "ol" aus der Antwort -> Initiator lehnt ab', async () => {
    await devices();
    const first = await connect(alice, bob);
    await sendText(bob, 'erst', 'd2');
    await waitFor(async () => (await alice.ConnCaps.getConnCaps(B_ID)).ol === 2, 3000, 'gemerkt');
    first.rtcA.close(); first.rtcB.close();
    const second = await connect(alice, bob, { tamperBtoA: (d) => strip(d, ['ol']) }, { expectOk: false });
    expect(second.rtcA.keyExchangeDone).toBe(false);
    expect(second.rtcA._closed).toBe(true);
  });

  test('ohne Ratchet-Sitzung (z.B. Profilbild direkt nach der Kopplung): Medien gehen ueber v2 (mediaSealer)', async () => {
    await devices();
    const rtc = new alice.WebRTCManager(() => {}, () => {}, () => {});
    rtc.chatId = 'c_ohne_sitzung';
    rtc.sharedSecret = crypto.randomBytes(32).toString('base64');
    rtc.outerVersion = 2;
    expect(await rtc.mediaSealer()).toBeTruthy();
    rtc.outerVersion = 1;
    expect(await rtc.mediaSealer()).toBeNull();
  });
});
