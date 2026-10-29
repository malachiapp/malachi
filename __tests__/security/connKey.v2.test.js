// Krypto-Review 2026-10-25, V5 (K-07, K-08): Verbindungsschluessel v2 -
// X25519 + ML-KEM-768 nach X-Wing-Art, Transkript-Bindung (oeffentliche
// Schluessel, Chiffrat, Rollen, Version, Kette), Kette an das Anmelde-
// Geheimnis bzw. den PSK, nur abgeleitete Teilschluessel; ausgehandelt ueber
// "kx: 2", klebrig (danach keine Rueckstufung). ML-KEM ist hier ECHT
// (@noble/post-quantum - steht nur fuer die native Bruecke).
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

const { realKyber } = require('./helpers/phonePairingHelpers');
require('./helpers/nativeBridgeMock').installKyberModuleMock();

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + what);
    await tick(10);
  }
}
const b64 = (u8) => Buffer.from(u8).toString('base64');

// Alle ML-KEM-Geheimnisse, die die "native Bruecke" je geliefert hat - sie
// duerfen nirgends gespeichert oder als Schluessel benutzt werden.
const rawSecrets = new Set();
function installRealKyber() {
  require('./helpers/nativeBridgeMock').installKyberModuleMock();
  const { NativeModules } = require('react-native');
  const k = realKyber();
  NativeModules.KyberModule.generateKeypair = k.generateKeypair;
  NativeModules.KyberModule.encapsulate = async (pk) => { const r = await k.encapsulate(pk); rawSecrets.add(r.sharedSecret); return r; };
  NativeModules.KyberModule.decapsulate = async (ct, sk) => { const s = await k.decapsulate(ct, sk); rawSecrets.add(s); return s; };
}

// ─── Teil 1: Ableitung ──────────────────────────────────────────────────────
describe('Teil 1: Ableitung (ConnKeyV2.js)', () => {
  let K;
  beforeAll(() => {
    global.__mockDevice = 'ableitung';
    jest.isolateModules(() => { K = require('../../ConnKeyV2'); });
    global.__mockDevice = undefined;
  });
  const fixed = () => ({
    ssM: Uint8Array.from(Buffer.alloc(32, 1)), ssX: Uint8Array.from(Buffer.alloc(32, 2)),
    ek: Buffer.alloc(1184, 3).toString('base64'), ct: Buffer.alloc(1088, 4).toString('base64'),
    xI: Buffer.alloc(32, 5).toString('base64'), xR: Buffer.alloc(32, 6).toString('base64'),
    chain: Buffer.alloc(32, 7).toString('base64'), ol: 2,
  });

  // Unabhaengige Gegenprobe mit Nodes OpenSSL (SHA-256, HKDF).
  function reference(i) {
    const lp = (buf) => { const h = Buffer.alloc(4); h.writeUInt32BE(buf.length); return Buffer.concat([h, buf]); };
    const s = (x) => Buffer.from(x, 'utf8');
    const d = (x) => Buffer.from(x, 'base64');
    const chainId = Buffer.from(crypto.hkdfSync('sha256', d(i.chain), Buffer.alloc(0), s('malachi-kx-v2|chain-id'), 16)).toString('base64');
    const T = crypto.createHash('sha256').update(Buffer.concat([
      lp(s('malachi-kx-v2')), lp(s('i-ek')), lp(d(i.ek)), lp(s('r-ct')), lp(d(i.ct)), lp(s('i-x')), lp(d(i.xI)),
      lp(s('r-x')), lp(d(i.xR)), lp(s('ck')), lp(s(chainId)), lp(s('ol')), lp(s(String(i.ol))),
    ])).digest();
    const C = Buffer.from(crypto.hkdfSync('sha256', d(i.chain), Buffer.alloc(0), s('malachi-kx-v2|chain'), 32));
    const ikm = Buffer.concat([Buffer.from(i.ssM), Buffer.from(i.ssX), C]);
    const out = (p) => Buffer.from(crypto.hkdfSync('sha256', ikm, T, s('malachi-kx-v2|' + p), 32)).toString('base64');
    return { outer: out('outer'), kem: out('ratchet-kem'), code: out('legacy-code'), transcript: T.toString('base64') };
  }

  test('Testvektor: identisch mit der unabhaengigen Gegenprobe; Teilschluessel paarweise verschieden, nie das rohe Geheimnis', () => {
    const r = K.deriveConnKeysV2(fixed());
    expect(r).toEqual(reference(fixed()));
    expect(new Set([r.outer, r.kem, r.code]).size).toBe(3);
    for (const v of [r.outer, r.kem, r.code]) {
      expect(v).not.toBe(b64(Buffer.alloc(32, 1)));
      expect(v).not.toBe(b64(Buffer.alloc(32, 2)));
    }
  });

  test.each(['ek', 'ct', 'xI', 'xR', 'chain', 'ol', 'ssM', 'ssX'])('Transkript/Eingabe "%s" geaendert -> alle Teilschluessel anders', (field) => {
    const base = K.deriveConnKeysV2(fixed());
    const i = fixed();
    if (field === 'ol') i.ol = 1;
    else if (field === 'ssM' || field === 'ssX') i[field] = Uint8Array.from(Buffer.alloc(32, 9));
    else if (field === 'chain') i.chain = Buffer.alloc(32, 8).toString('base64');
    else { const buf = Buffer.from(i[field], 'base64'); buf[buf.length - 1] ^= 1; i[field] = buf.toString('base64'); }
    const r = K.deriveConnKeysV2(i);
    expect(r.outer).not.toBe(base.outer);
    expect(r.kem).not.toBe(base.kem);
    expect(r.code).not.toBe(base.code);
  });

  test('ohne Kette: eigener, eindeutiger Wert (nicht gleich mit Kette)', () => {
    const withChain = K.deriveConnKeysV2(fixed());
    const without = K.deriveConnKeysV2({ ...fixed(), chain: null });
    expect(without.outer).not.toBe(withChain.outer);
  });

  test('Rollen nicht vertauschbar: xI und xR getauscht -> anderer Schluessel', () => {
    const i = fixed();
    const swapped = K.deriveConnKeysV2({ ...i, xI: i.xR, xR: i.xI });
    expect(swapped.outer).not.toBe(K.deriveConnKeysV2(i).outer);
  });

  test('X25519: Punkte kleiner Ordnung und kaputte Schluessel werden abgelehnt; Kettenkennung stabil', async () => {
    const me = await K.newX25519(async (n) => Uint8Array.from(crypto.randomBytes(n)));
    expect(() => K.x25519Shared(me.sk, b64(Buffer.alloc(32, 0)))).toThrow();
    expect(() => K.x25519Shared(me.sk, 'kaputt')).toThrow();
    const other = await K.newX25519(async (n) => Uint8Array.from(crypto.randomBytes(n)));
    expect(b64(K.x25519Shared(me.sk, other.pk))).toBe(b64(K.x25519Shared(other.sk, me.pk)));
    const c = Buffer.alloc(32, 7).toString('base64');
    expect(K.chainIdOf(c)).toBe(K.chainIdOf(c));
    expect(K.isChainId(K.chainIdOf(c))).toBe(true);
    expect(K.chainIdOf(c)).not.toBe(K.chainIdOf(Buffer.alloc(32, 8).toString('base64')));
    await expect(K.newX25519(async () => new Uint8Array(5))).rejects.toThrow();
  });
});

// ─── Teil 2: zwei Geraete mit echtem ML-KEM ─────────────────────────────────
const A_ID = 'c_alice';
const B_ID = 'c_bob';
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');

function loadDevice(name, peerId, role, { oldApp = false } = {}) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    installRealKyber();
    dev = {
      name, peerId, role, oldApp,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      ConnCaps: require('../../ConnCaps'),
      ES: require('react-native-encrypted-storage').default,
    };
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

const editKyber = (raw, fn) => {
  try {
    const m = JSON.parse(raw);
    if (m?.type === 'system' && /^kyber_/.test(m.subtype)) { fn(m); return JSON.stringify(m); }
  } catch {}
  return raw;
};
const NEW_FIELDS = ['ol', 'kx', 'x', 'ck'];
const asOld = (raw) => editKyber(raw, (m) => { for (const f of NEW_FIELDS) delete m[f]; });

function makeLink({ aOld = false, bOld = false, tamperAtoB = null, tamperBtoA = null } = {}) {
  const net = { aToB: [], bToA: [] };
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; this.onmessage = null; } });
  const a = mk();
  const b = mk();
  a.send = (d) => {
    if (a.readyState !== 'open') throw new Error('Kanal zu');
    let out = aOld ? asOld(d) : d;
    if (tamperAtoB) out = tamperAtoB(out);
    if (bOld) out = asOld(out);
    net.aToB.push(out);
    setTimeout(() => b.onmessage?.({ data: out }), 0);
  };
  b.send = (d) => {
    if (b.readyState !== 'open') throw new Error('Kanal zu');
    let out = bOld ? asOld(d) : d;
    if (tamperBtoA) out = tamperBtoA(out);
    if (aOld) out = asOld(out);
    net.bToA.push(out);
    setTimeout(() => a.onmessage?.({ data: out }), 0);
  };
  return { a, b, net };
}

async function connect(alice, bob, { link: linkOpts = {}, chainA, chainB, expectOk = true } = {}) {
  const link = makeLink({ aOld: alice.oldApp, bOld: bob.oldApp, ...linkOpts });
  const rtcA = new alice.WebRTCManager(() => {}, () => {}, () => {});
  const rtcB = new bob.WebRTCManager(() => {}, () => {}, () => {});
  for (const [dev, rtc, ch, initiator, chain] of [[alice, rtcA, link.a, true, chainA], [bob, rtcB, link.b, false, chainB]]) {
    rtc.isInitiator = initiator;
    rtc.pc = { iceConnectionState: 'connected', close() {} };
    rtc.dataChannel = ch;
    rtc._chainSecret = chain === undefined ? dev.RTCStore.getSharedSecret(dev.peerId) : chain;
    dev.RTCStore.setConnection(dev.peerId, rtc);
    rtc._onReady = () => dev.BG.flushQueue(dev.peerId, rtc);
    rtc._setupDataChannel(ch);
  }
  link.b.onopen();
  link.a.onopen();
  if (expectOk) {
    await waitFor(() => rtcA.keyExchangeDone && rtcB.keyExchangeDone, 5000, 'Schluesseltausch');
    await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown', 5000, 'Faehigkeiten');
  } else {
    await tick(300);
  }
  return { rtcA, rtcB, link };
}

const sendText = (dev, text, msgId) => dev.BG.sendViaOutbox(dev.peerId, 'text', { type: 'text', text, time: Date.now(), msgId }, msgId);
const kyberOf = (list, sub) => list.map((d) => JSON.parse(d)).find((m) => m.subtype === sub);
const storeDump = (dev) => [...dev.ES.__store.values()].join('\n');

describe('Teil 2: zwei Geraete, echtes ML-KEM-768', () => {
  let alice;
  let bob;
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => { console.log.mockRestore?.(); console.warn.mockRestore?.(); console.error.mockRestore?.(); });
  beforeEach(() => {
    global.__mockStores = {};
    global.__mockFiles = {};
    rawSecrets.clear();
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

  test('neu <-> neu: kx 2 mit Kette ausgehandelt, gleiche Teilschluessel, das rohe ML-KEM-Geheimnis wird nirgends benutzt oder gespeichert', async () => {
    await devices();
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { rtcA, rtcB, link } = await connect(alice, bob);
    const offer = kyberOf(link.net.aToB, 'kyber_pubkey');
    expect(offer).toMatchObject({ kx: 2, ol: 2 });
    expect(offer.x).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(offer.ck).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(kyberOf(link.net.bToA, 'kyber_ciphertext')).toMatchObject({ kx: 2 });
    expect(rtcA.kxVersion).toBe(2);
    expect(rtcA.sharedSecret).toBe(rtcB.sharedSecret);
    expect(rtcA.kemSecret).toBe(rtcB.kemSecret);
    expect(rtcA.kemSecret).not.toBe(rtcA.sharedSecret);
    expect(rawSecrets.size).toBeGreaterThan(0);
    for (const raw of rawSecrets) {
      expect([rtcA.sharedSecret, rtcA.kemSecret]).not.toContain(raw);
      expect(storeDump(alice)).not.toContain(raw);
      expect(storeDump(bob)).not.toContain(raw);
    }
    expect(await alice.ES.getItem('shared_secret_' + B_ID)).toBe(rtcA.sharedSecret);
    await sendText(alice, 'ueber kx v2', 'k1');
    await waitFor(() => bobSeen.some((m) => m.text === 'ueber kx v2'), 5000, 'zugestellt');
    await waitFor(async () => (await alice.ConnCaps.getConnCaps(B_ID)).kx === 2 && (await bob.ConnCaps.getConnCaps(A_ID)).kx === 2, 3000, 'gemerkt');
    // Folgeverbindung: Kette = das neue gespeicherte Geheimnis (wie die Tor-Anmeldung)
    rtcA.close(); rtcB.close();
    const second = await connect(alice, bob);
    expect(second.rtcA.kxVersion).toBe(2);
    await sendText(bob, 'zweite Verbindung', 'k2');
    const aliceSeen = [];
    alice.RTCStore.setMessageListener(B_ID, (m) => aliceSeen.push(m));
    await waitFor(() => aliceSeen.some((m) => m.text === 'zweite Verbindung'), 5000, 'zweite');
  });

  // Manipulation im Transport (wer Tor/DTLS bricht): Schluessel passen nicht,
  // keine Nachricht wird gelesen, die Verbindung wird verworfen.
  const flipLast = (s) => { const buf = Buffer.from(s, 'base64'); buf[buf.length - 1] ^= 1; return buf.toString('base64'); };
  test.each([
    ['oeffentlicher ML-KEM-Schluessel (ek)', { tamperAtoB: (d) => editKyber(d, (m) => { if (m.publicKey) m.publicKey = flipLast(m.publicKey); }) }],
    ['ML-KEM-Chiffrat (ct)', { tamperBtoA: (d) => editKyber(d, (m) => { if (m.cipherText) m.cipherText = flipLast(m.cipherText); }) }],
    ['X25519-Anteil des Initiators', { tamperAtoB: (d) => editKyber(d, (m) => { if (m.x) m.x = b64(crypto.randomBytes(32)); }) }],
    ['X25519-Anteil des Responders', { tamperBtoA: (d) => editKyber(d, (m) => { if (m.x) m.x = b64(crypto.randomBytes(32)); }) }],
  ])('Manipulation: %s -> nichts lesbar, Verbindung verworfen', async (_, link) => {
    await devices();
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { rtcA, rtcB } = await connect(alice, bob, { link, expectOk: false });
    await sendText(alice, 'darf nicht ankommen', 't1').catch(() => {});
    await tick(500);
    expect(bobSeen.some((m) => m.text === 'darf nicht ankommen')).toBe(false);
    if (rtcA.keyExchangeDone && rtcB.keyExchangeDone) {
      expect(rtcA.sharedSecret).not.toBe(rtcB.sharedSecret);
      expect(rtcA._closed || rtcB._closed).toBe(true);           // Schluesselbestaetigung scheitert
    }
    expect((await bob.ConnCaps.getConnCaps(A_ID)).kx).toBeUndefined();
  });

  test('Direkt-Upgrade: Kette = Geheimnis der Verbindung, ueber die ausgehandelt wurde; die Gegenseite findet es selbst', async () => {
    await devices();
    const tor = await connect(alice, bob);                       // aktive (Tor-)Verbindung
    const link = makeLink();
    const dA = new alice.WebRTCManager(() => {}, () => {}, () => {});
    const dB = new bob.WebRTCManager(() => {}, () => {}, () => {});
    for (const [rtc, ch, initiator, id] of [[dA, link.a, true, B_ID], [dB, link.b, false, A_ID]]) {
      rtc.chatId = id;
      rtc.isInitiator = initiator;
      rtc.pc = { iceConnectionState: 'connected', close() {} };
      rtc.dataChannel = ch;
      rtc._setupDataChannel(ch);
    }
    // wie DirectUpgrade.startOffer; die antwortende Seite setzt nichts
    dA._chainSecret = alice.RTCStore.connections.get(B_ID).sharedSecret;
    link.b.onopen();
    link.a.onopen();
    await waitFor(() => dA.keyExchangeDone && dB.keyExchangeDone, 5000, 'Direkt-Schluesseltausch');
    expect(dA.kxVersion).toBe(2);
    expect(dA.sharedSecret).toBe(dB.sharedSecret);
    expect(dA.sharedSecret).not.toBe(tor.rtcA.sharedSecret);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'DirectUpgrade.js'), 'utf8');
    expect(src).toMatch(/att\.rtc\._chainSecret = RTCStore\.connections\.get\(contactId\)\?\.sharedSecret/);
    dA.close(); dB.close();
  });

  test('falsches/unbekanntes Kettenglied: Responder lehnt ab, statt einen anderen Schluessel zu nehmen', async () => {
    await devices();
    const { rtcB, link } = await connect(alice, bob, { chainA: crypto.randomBytes(32).toString('base64'), expectOk: false });
    expect(rtcB.keyExchangeDone).toBe(false);
    expect(rtcB._closed).toBe(true);
    expect(kyberOf(link.net.bToA, 'kyber_ciphertext')).toBeUndefined();
  });

  test.each([
    ['"kx" aus dem Angebot entfernt', { tamperAtoB: (d) => editKyber(d, (m) => { delete m.kx; delete m.x; delete m.ck; }) }, 'B'],
    ['Kettenglied aus dem Angebot entfernt', { tamperAtoB: (d) => editKyber(d, (m) => { delete m.ck; }) }, 'B'],
    ['"kx" aus der Antwort entfernt', { tamperBtoA: (d) => editKyber(d, (m) => { delete m.kx; delete m.x; }) }, 'A'],
  ])('Rueckstufung nach einer v2-Verbindung: %s -> abgelehnt', async (_, link, side) => {
    await devices();
    const first = await connect(alice, bob);
    await sendText(alice, 'erst', 'r1');
    await sendText(bob, 'und zurueck', 'r2');
    await waitFor(async () => (await alice.ConnCaps.getConnCaps(B_ID)).kx === 2 && (await bob.ConnCaps.getConnCaps(A_ID)).kx === 2, 5000, 'gemerkt');
    first.rtcA.close(); first.rtcB.close();
    const second = await connect(alice, bob, { link, expectOk: false });
    const rejecting = side === 'A' ? second.rtcA : second.rtcB;
    expect(rejecting.keyExchangeDone).toBe(false);
    expect(rejecting._closed).toBe(true);
  });

  test.each([['Alice', { aliceOld: true }], ['Bob', { bobOld: true }]])('Gegenseite 1.1 (%s alt): v1 wie bisher (rohes ML-KEM), Nachrichten kommen an, nichts klebt', async (_, opts) => {
    await devices(opts);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { rtcA, rtcB } = await connect(alice, bob);
    expect(rtcA.kxVersion).toBe(1);
    expect(rtcB.kxVersion).toBe(1);
    expect(rawSecrets.has(rtcA.sharedSecret)).toBe(true);        // Kompatibilitaet: v1 unveraendert
    await sendText(alice, 'an 1.1', 'o1');
    await waitFor(() => bobSeen.some((m) => m.text === 'an 1.1'), 5000, 'zugestellt');
    expect((await alice.ConnCaps.getConnCaps(B_ID)).kx).toBeUndefined();
  });
});
