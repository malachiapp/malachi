/* eslint-env node */
// Telefonnummer-Kopplung (PhonePairing.js) im Zusammenspiel mit TorTransport,
// WebRTCManager und RTCStore. Tor selbst ist gemockt (wie in
// tor.transport.test.js): Zeilen kommen ueber DeviceEventEmitter, gesendete
// Zeilen landen in `sent`. Die Gegenseite spielt dieser Test mit den echten
// Protokoll-Bausteinen (Host-/ClientHandshake, Tunnel, WebRTCManager).
// Geprueft:
//   - Gastgeber und Gast komplett: Treffpunkt (ADD_ONION mit dem abgeleiteten
//     Schluessel) bzw. Verbindung dorthin, Handshake, Code, beidseitige
//     Bestaetigung, normale Kopplung IM Tunnel -> normaler Kontakt,
//   - "Stimmt nicht", Abbruch der Gegenseite, falsche Nummer, Flut
//     fehlerhafter Anmeldungen, manipulierte Tunnelzeile,
//   - Aufraeumen bei Abbruch, Zeitablauf, Hintergrund, Wipe: Treffpunkt weg
//     (DEL_ONION), Verbindungen zu, nichts gespeichert,
//   - keine Nummer (in keiner Schreibweise) in Logs oder im Speicher.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, DeviceEventEmitter } = require('react-native');
const H = require('./helpers/phonePairingHelpers');
Object.assign(NativeModules.KyberModule, H.realKyber());

const MY_ONION = 'a'.repeat(56) + '.onion';
const PEER_ONION = 'b'.repeat(56) + '.onion';
const LO = '+4915198765432';      // kleinere Nummer -> Gastgeber
const HI = '+4917612345678';
const LO_INPUT = '0151 98765432';
const HI_INPUT = '+49 (0)176 1234 5678';

const sent = [];
const closed = [];
const peers = new Map();          // connId -> Zeilen-Empfaenger der Gegenseite
NativeModules.MalachiTor = {
  addListener() {},
  removeListeners() {},
  start: jest.fn(),
  stop: jest.fn(async () => {}),
  connectWithTimeout: jest.fn(),
  send: jest.fn(async (connId, line) => {
    sent.push({ connId, line });
    const p = peers.get(connId);
    if (p) setTimeout(() => p(line), 1);
  }),
  close: jest.fn((connId) => { closed.push(connId); }),
  addRendezvousOnion: jest.fn(async (blob, onion) => onion),
  removeRendezvousOnion: jest.fn(async () => true),
  argon2id: jest.fn(H.nativeArgon2idMock),
  refetchDescriptor: jest.fn(async () => true),
  refreshCircuits: jest.fn(async () => true),
};

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const { WebRTCManager } = require('../../WebRTCManager');
const Tor = require('../../TorTransport');
const PP = require('../../PhonePairing');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await tick(10);
  }
  throw new Error('waitFor: Zeitlimit');
}
const feed = (connId, line) => DeviceEventEmitter.emit('MalachiTorLine', { connId, line });
const linesFor = (connId) => sent.filter((x) => x.connId === connId).map((x) => x.line);

// Gegenseite an einer Verbindung: Handshake-Zeilen, dann Tunnel, dann WebRTCManager.
function makePeer(connId) {
  const q = [];
  let waiter = null;
  const peer = {
    tunnel: null,
    channel: null,
    control: [],
    onControlLine: null,
    rtcMessages: [],
    rtc: null,
    next() { return q.length ? Promise.resolve(q.shift()) : new Promise((r) => { waiter = r; }); },
    async nextJson() { return JSON.parse(await this.next()); },
    sendJson(obj) { feed(connId, JSON.stringify(obj)); },
    sendSealed(obj) { feed(connId, this.tunnel.seal(JSON.stringify(obj))); },
    // Ab jetzt laeuft auf beiden Seiten die normale Kopplung im Tunnel.
    attachRtc(isInitiator) {
      const ch = {
        readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
        send: (d) => feed(connId, peer.tunnel.seal(d)),
        close() { this.readyState = 'closed'; this.onclose?.(); },
      };
      peer.channel = ch;
      peer.rtc = new WebRTCManager((m) => peer.rtcMessages.push(m), () => {}, () => {});
      peer.rtc.attachTorChannel(ch, isInitiator);
    },
  };
  peers.set(connId, (line) => {
    if (peer.tunnel && peer.tunnelMode) {
      const text = peer.tunnel.open(line);
      if (text === null) throw new Error('Gegenseite: Tunnelzeile nicht entschluesselbar');
      if (text.startsWith('{"t":')) {
        const m = JSON.parse(text);
        peer.control.push(m);
        peer.onControlLine?.(m);
        return;
      }
      peer.channel?.onmessage?.({ data: text });
      return;
    }
    if (waiter) { const w = waiter; waiter = null; w(line); } else q.push(line);
  });
  return peer;
}

let logs;
let stored;
let states;
let paired;
const fakeAppState = () => {
  const handlers = [];
  return { handlers, addEventListener: (ev, fn) => { handlers.push(fn); return { remove: () => handlers.splice(handlers.indexOf(fn), 1) }; } };
};

beforeEach(async () => {
  logs = H.captureConsole();
  sent.length = 0;
  closed.length = 0;
  peers.clear();
  jest.clearAllMocks();
  Tor._resetTorTransportForTests();
  RTCStore.resetAll();
  await EncryptedStorage.clear();
  Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
  stored = [];
  const origSet = EncryptedStorage.setItem;
  jest.spyOn(EncryptedStorage, 'setItem').mockImplementation((k, v) => { stored.push([k, v]); return origSet(k, v); });
  states = [];
  paired = [];
});

afterEach(() => {
  for (const c of ctrls.splice(0)) { try { c.cancel(); } catch {} }
  for (const rtc of RTCStore.connections.values()) { try { rtc.close(); } catch {} }
  for (const p of peerList.splice(0)) { try { p.rtc?.close(); } catch {} }
  logs.restore();
  EncryptedStorage.setItem.mockRestore?.();
});
const peerList = [];
const ctrls = [];

function start(own, other, extra = {}) {
  const ctrl = PP.startPhonePairing({
    ownNumber: own,
    otherNumber: other,
    onState: (s) => states.push(s),
    onPaired: (contact, rtc) => {
      paired.push({ contact, rtc });
      RTCStore.setConnection(contact.id, rtc);   // wie App.handlePaired
    },
    appState: fakeAppState(),
    ...extra,
  });
  ctrls.push(ctrl);
  return ctrl;
}
const lastState = () => states[states.length - 1] || {};
const phases = () => states.map((s) => s.phase);

async function expectedRendezvous(now = Date.now()) {
  return Promise.all(PP.phoneBuckets(now).map((b) => PP.deriveRendezvous(LO, HI, b, { kdf: H.kdfNode })));
}

function expectNoNumbersAnywhere(extraSecrets = []) {
  expect(logs.lines.length).toBeGreaterThan(2);          // die Pruefung laeuft nicht ins Leere
  const forms = [...H.numberForms(LO), ...H.numberForms(HI), LO_INPUT, HI_INPUT];
  const haystack = logs.lines.join('\n') + '\n' + JSON.stringify(stored);
  for (const f of forms) expect(haystack).not.toContain(f);
  for (const s of extraSecrets) expect(logs.lines.join('\n')).not.toContain(s);
}

// Gegenseite als Gast: Handshake bis zum Code (Gastgeber = Geraet im Test).
async function peerAsClient(connId, rv) {
  const peer = makePeer(connId);
  peerList.push(peer);
  DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId, onion: rv.onion });
  const hs = new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng: H.rng, kyber: H.realKyber() });
  peer.sendJson(await hs.onHello(await peer.nextJson()));
  const { reply, result } = await hs.onKeys(await peer.nextJson());
  peer.sendJson(reply);
  peer.tunnel = PP.createTunnel(result.tx, result.rx);
  const ready = JSON.parse(peer.tunnel.open(await peer.next()));
  expect(ready).toEqual({ t: 'ready' });
  peer.tunnelMode = true;
  peer.result = result;
  return peer;
}

describe('Gastgeber (eigene Nummer ist die kleinere)', () => {
  test('kompletter Ablauf: Treffpunkt, Handshake, gleicher Code, beidseitige Bestaetigung, normale Kopplung im Tunnel -> normaler Kontakt', async () => {
    const ctrl = start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => NativeModules.MalachiTor.addRendezvousOnion.mock.calls.length === 2);
    // ADD_ONION genau mit den abgeleiteten Schluesseln, aktuelle + vorige Stunde.
    expect(NativeModules.MalachiTor.addRendezvousOnion.mock.calls).toEqual(rvs.map((r) => [r.keyBlob, r.onion]));
    expect(NativeModules.MalachiTor.argon2id).toHaveBeenCalledTimes(2);
    await waitFor(() => lastState().phase === 'waiting');
    expect(lastState().role).toBe('host');

    const peer = await peerAsClient('rv-1', rvs[0]);
    await waitFor(() => lastState().phase === 'compare');
    expect(lastState().code).toBe(peer.result.code);
    // Treffpunkt sofort entfernt, sobald jemand mit gueltigem Handshake da ist.
    await waitFor(() => NativeModules.MalachiTor.removeRendezvousOnion.mock.calls.length >= 2);
    expect(NativeModules.MalachiTor.removeRendezvousOnion.mock.calls.map((c) => c[0]).sort()).toEqual(rvs.map((r) => r.onion).sort());
    // Weitere Verbindungen am (alten) Treffpunkt werden sofort geschlossen.
    DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: 'rv-spaet', onion: rvs[0].onion });
    expect(closed).toContain('rv-spaet');

    // Geraet bestaetigt zuerst: wartet auf die Gegenseite.
    ctrl.confirm(true);
    await waitFor(() => peer.control.some((m) => m.t === 'confirm'));
    expect(peer.control.find((m) => m.t === 'confirm').onion).toBe(MY_ONION);
    expect(lastState().phase).toBe('confirm-wait');
    // Gegenseite bestaetigt und startet ihre normale Kopplung (Gast = Initiator).
    peer.sendSealed({ t: 'confirm', onion: PEER_ONION });
    peer.attachRtc(true);
    await waitFor(() => paired.length === 1, 8000);

    const { contact, rtc } = paired[0];
    expect(contact).toMatchObject({ id: peer.result.contactId, role: 'initiator', torOnion: PEER_ONION, name: 'Neuer Kontakt' });
    expect(rtc.transport).toBe('tor');
    expect(rtc.keyExchangeDone).toBe(true);
    await waitFor(() => peer.rtc.keyExchangeDone);
    expect(rtc.sharedSecret).toBe(peer.rtc.sharedSecret);
    expect(await EncryptedStorage.getItem('shared_secret_' + contact.id)).toBe(rtc.sharedSecret);
    expect(lastState().phase).toBe('done');
    expect(phases()).toEqual(expect.arrayContaining(['preparing', 'waiting', 'handshake', 'compare', 'confirm-wait', 'pairing', 'done']));
    // Normale Kopplung tauscht wie immer die echte Onion-Adresse aus (verschluesselt).
    await waitFor(() => peer.rtcMessages.some((m) => m.subtype === 'tor_address'));
    expect(peer.rtcMessages.find((m) => m.subtype === 'tor_address').onion).toBe(MY_ONION);
    // Nach dem Handshake geht auf dieser Verbindung nichts mehr im Klartext.
    const afterHandshake = linesFor('rv-1').slice(2);
    expect(afterHandshake.length).toBeGreaterThan(3);
    for (const l of afterHandshake) {
      expect(l).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(l).not.toMatch(/kyber|tor_address|profile/);
    }
    // Text-Nachricht ueber die neue Verbindung.
    rtc.sendMessage(JSON.stringify({ type: 'text', text: 'Hallo per Nummer', msgId: 'm1', time: Date.now() }));
    await waitFor(() => peer.rtcMessages.some((m) => m.type === 'text'));
    // Verbindung bleibt als normale Kontaktverbindung bestehen.
    expect(closed).not.toContain('rv-1');
    expect(stored.some(([k]) => k === 'shared_secret_' + contact.id)).toBe(true);
    expectNoNumbersAnywhere([...rvs.map((r) => r.onion), peer.result.code]);
  }, 20000);

  test('"Stimmt nicht": Abbruch an die Gegenseite, nichts gespeichert, Verbindung zu, Treffpunkt weg', async () => {
    const ctrl = start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    const peer = await peerAsClient('rv-2', rvs[1]);
    await waitFor(() => lastState().phase === 'compare');
    ctrl.confirm(false);
    expect(lastState()).toMatchObject({ phase: 'error', error: 'mismatch', code: null });
    await waitFor(() => peer.control.some((m) => m.t === 'abort'));
    await waitFor(() => closed.includes('rv-2'), 2000);
    expect(paired).toHaveLength(0);
    expect(stored.filter(([k]) => /shared_secret|contacts/.test(k))).toEqual([]);
    expect(NativeModules.MalachiTor.removeRendezvousOnion).toHaveBeenCalled();
    // Danach ist die Bestaetigung wirkungslos.
    ctrl.confirm(true);
    expect(lastState().error).toBe('mismatch');
    expectNoNumbersAnywhere();
  }, 15000);

  test('Gegenseite sagt "Stimmt nicht": Abbruch, kein Kontakt', async () => {
    start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    const peer = await peerAsClient('rv-3', rvs[0]);
    await waitFor(() => lastState().phase === 'compare');
    peer.sendSealed({ t: 'abort', why: 'mismatch' });
    await waitFor(() => lastState().phase === 'error');
    expect(lastState().error).toBe('peer-abort');
    expect(closed).toContain('rv-3');
    expect(paired).toHaveLength(0);
  }, 15000);

  test('Gast mit falscher Nummer: abgewiesen, Treffpunkt bleibt fuer den richtigen Kontakt offen - der kommt danach durch', async () => {
    start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    const wrong = await PP.deriveRendezvous(LO, '+4917612345679', PP.phoneBuckets()[0], { kdf: H.kdfNode });
    const bad = makePeer('rv-bad');
    DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: 'rv-bad', onion: rvs[0].onion });
    const hs = new PP.ClientHandshake({ onion: rvs[0].onion, authKey: wrong.authKey, rng: H.rng, kyber: H.realKyber() });
    bad.sendJson(await hs.onHello(await bad.nextJson()));
    await waitFor(() => closed.includes('rv-bad'));
    expect(states.some((s) => s.phase === 'compare')).toBe(false);
    await waitFor(() => lastState().phase === 'waiting');
    expect(NativeModules.MalachiTor.removeRendezvousOnion).not.toHaveBeenCalled();
    const peer = await peerAsClient('rv-good', rvs[0]);
    await waitFor(() => lastState().phase === 'compare');
    expect(lastState().code).toBe(peer.result.code);
  }, 15000);

  test('Audit T2: gueltige Anmeldung legt fest - weitere Verbindungen abgewiesen, Abbruch vor dem Code beendet die Sitzung sichtbar', async () => {
    start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    // Jemand mit gueltigem Schluessel (Mann in der Mitte) meldet sich an und bekommt
    // die Schluessel des Gastgebers - damit kennt er den Code.
    const mitm = makePeer('rv-mitm');
    peerList.push(mitm);
    DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: 'rv-mitm', onion: rvs[0].onion });
    const hs = new PP.ClientHandshake({ onion: rvs[0].onion, authKey: rvs[0].authKey, rng: H.rng, kyber: H.realKyber() });
    mitm.sendJson(await hs.onHello(await mitm.nextJson()));
    const keys = await mitm.nextJson();
    expect(keys.step).toBeDefined();
    // Ab jetzt ist der Treffpunkt vergeben: eine zweite Verbindung (auch mit
    // gueltigem Schluessel) wird sofort geschlossen, ohne Handshake.
    DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: 'rv-zweit', onion: rvs[0].onion });
    expect(closed).toContain('rv-zweit');
    expect(linesFor('rv-zweit')).toEqual([]);
    // Der Angreifer bricht ab, statt "open" zu schicken (er wollte nur den Code sehen).
    DeviceEventEmitter.emit('MalachiTorClosed', { connId: 'rv-mitm' });
    await waitFor(() => lastState().phase === 'error');
    expect(lastState()).toMatchObject({ phase: 'error', error: 'interrupted', code: null });
    expect(states.some((s) => s.phase === 'compare')).toBe(false);
    // Kein stilles Weiterwarten: Treffpunkt weg, spaetere Verbindungen zu, nichts gespeichert.
    await waitFor(() => NativeModules.MalachiTor.removeRendezvousOnion.mock.calls.length >= 2);
    DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: 'rv-danach', onion: rvs[0].onion });
    expect(closed).toContain('rv-danach');
    expect(paired).toHaveLength(0);
    expect(stored.filter(([k]) => /shared_secret|contacts/.test(k))).toEqual([]);
    try { hs.dispose?.(); } catch {}
  }, 15000);

  test('Flut fehlerhafter Anmeldungen (jemand kennt den Treffpunkt, aber nicht den Schluessel): nach 12 Fehlversuchen Abbruch', async () => {
    start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    for (let i = 0; i < 12; i++) {
      const id = 'rv-flood-' + i;
      const p = makePeer(id);
      DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: id, onion: rvs[0].onion });
      await p.next();
      p.sendJson({ t: 'malachi-phone', step: 'auth', n: H.b64(crypto.randomBytes(32)), commit: H.b64(crypto.randomBytes(32)), mac: H.b64(crypto.randomBytes(32)) });
      await waitFor(() => closed.includes(id));
    }
    await waitFor(() => lastState().phase === 'error');
    expect(lastState().error).toBe('auth-flood');
    expect(NativeModules.MalachiTor.removeRendezvousOnion).toHaveBeenCalledTimes(2);
  }, 20000);

  test('manipulierte Tunnelzeile waehrend des Vergleichs: Abbruch, Verbindung zu', async () => {
    start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    const peer = await peerAsClient('rv-4', rvs[0]);
    await waitFor(() => lastState().phase === 'compare');
    const line = Buffer.from(peer.tunnel.seal('{"t":"ping"}'), 'base64');
    line[5] ^= 0xff;
    feed('rv-4', line.toString('base64'));
    await waitFor(() => lastState().phase === 'error');
    expect(lastState().error).toBe('connection');
    expect(closed).toContain('rv-4');
  }, 15000);

  test('Abbruch durch den Nutzer: Treffpunkt entfernt, Nummern/Schluessel weg, spaetere Verbindungen sofort geschlossen', async () => {
    const ctrl = start(LO_INPUT, HI_INPUT);
    const rvs = await expectedRendezvous();
    await waitFor(() => NativeModules.MalachiTor.addRendezvousOnion.mock.calls.length === 2);
    ctrl.cancel();
    expect(lastState()).toMatchObject({ phase: 'error', error: 'cancelled' });
    await waitFor(() => NativeModules.MalachiTor.removeRendezvousOnion.mock.calls.length === 2);
    DeviceEventEmitter.emit('MalachiTorRendezvousIncoming', { connId: 'rv-nach', onion: rvs[0].onion });
    expect(closed).toContain('rv-nach');
    expect(Tor.isTorInUse()).toBe(false);
    expectNoNumbersAnywhere(rvs.map((r) => r.onion));
  });

  test('Zeitablauf (Fenster abgelaufen, niemand kam): Abbruch "timeout", Treffpunkt entfernt', async () => {
    start(LO_INPUT, HI_INPUT, { windowMs: 1500 });
    await waitFor(() => lastState().phase === 'waiting');
    await waitFor(() => lastState().phase === 'error', 3000);
    expect(lastState().error).toBe('timeout');
    await waitFor(() => NativeModules.MalachiTor.removeRendezvousOnion.mock.calls.length === 2);
    expectNoNumbersAnywhere();
  });

  test('App geht in den Hintergrund: sofortiger Abbruch und Aufraeumen (auch mitten im Code-Vergleich)', async () => {
    const appState = fakeAppState();
    start(LO_INPUT, HI_INPUT, { appState });
    const rvs = await expectedRendezvous();
    await waitFor(() => lastState().phase === 'waiting');
    await peerAsClient('rv-5', rvs[0]);
    await waitFor(() => lastState().phase === 'compare');
    appState.handlers.forEach((h) => h('background'));
    expect(lastState()).toMatchObject({ phase: 'error', error: 'background', code: null });
    expect(closed).toContain('rv-5');
    expect(appState.handlers).toHaveLength(0);
    expect(paired).toHaveLength(0);
  }, 15000);

  test('Wipe (z.B. PIN-Fehlversuche) waehrend der Suche: Abbruch', async () => {
    start(LO_INPUT, HI_INPUT);
    await waitFor(() => lastState().phase === 'waiting');
    RTCStore.resetAll();
    expect(lastState()).toMatchObject({ phase: 'error', error: 'wipe' });
    await waitFor(() => NativeModules.MalachiTor.removeRendezvousOnion.mock.calls.length === 2);
  });

  test('ohne native Unterstuetzung (alte App-Version): klare Meldung, nichts gestartet', async () => {
    const saved = NativeModules.MalachiTor.addRendezvousOnion;
    delete NativeModules.MalachiTor.addRendezvousOnion;
    try {
      start(LO_INPUT, HI_INPUT);
      await waitFor(() => lastState().phase === 'error');
      expect(lastState().error).toBe('unsupported');
      expect(NativeModules.MalachiTor.argon2id).not.toHaveBeenCalled();
    } finally {
      NativeModules.MalachiTor.addRendezvousOnion = saved;
    }
  });

  test('ungueltige oder gleiche Nummern: Abbruch vor jeder Ableitung', async () => {
    start('12345', HI_INPUT);
    await waitFor(() => lastState().phase === 'error');
    expect(lastState().error).toBe('invalid-number');
    start(HI_INPUT, '0176 12345678');
    await waitFor(() => lastState().error === 'same-number');
    expect(NativeModules.MalachiTor.argon2id).not.toHaveBeenCalled();
  });
});

describe('Gast (eigene Nummer ist die groessere)', () => {
  test('kompletter Ablauf: sucht beide Treffpunkte, "nicht gefunden" -> Beschreibung neu holen, Versuch bei eintreffender Beschreibung, Code, normale Kopplung', async () => {
    const rvs = await expectedRendezvous();
    let attempt = 0;
    NativeModules.MalachiTor.connectWithTimeout.mockImplementation(async (onion) => {
      if (onion === rvs[1].onion) throw new Error('Tor: Onion-Beschreibung nicht gefunden');
      attempt++;
      if (attempt === 1) throw new Error('Tor: Onion-Beschreibung nicht gefunden');
      return 'out-1';
    });
    const ctrl = start(HI_INPUT, LO_INPUT);
    await waitFor(() => NativeModules.MalachiTor.connectWithTimeout.mock.calls.length >= 2);
    expect(new Set(NativeModules.MalachiTor.connectWithTimeout.mock.calls.map((c) => c[0]))).toEqual(new Set(rvs.map((r) => r.onion)));
    expect(NativeModules.MalachiTor.connectWithTimeout.mock.calls[0][1]).toBe(7777);
    await waitFor(() => NativeModules.MalachiTor.refetchDescriptor.mock.calls.length >= 1);
    expect(lastState()).toMatchObject({ phase: 'waiting', role: 'client' });
    // Gegenseite (Gastgeber) ist bereit: Beschreibung trifft ein -> sofort neuer Versuch.
    const peer = makePeer('out-1');
    peerList.push(peer);
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: rvs[0].onion });
    const hs = new PP.HostHandshake({ onion: rvs[0].onion, authKey: rvs[0].authKey, rng: H.rng, kyber: H.realKyber() });
    await waitFor(() => attempt >= 2);
    peer.sendJson(await hs.hello());
    peer.sendJson(await hs.onAuth(await peer.nextJson()));
    const res = await hs.onOpen(await peer.nextJson());
    peer.tunnel = PP.createTunnel(res.tx, res.rx);
    peer.tunnelMode = true;
    peer.sendSealed({ t: 'ready' });
    await waitFor(() => lastState().phase === 'compare');
    expect(lastState().code).toBe(res.code);
    // Gegenseite bestaetigt zuerst; sobald unser "confirm" kommt, startet sie ihre Kopplung.
    peer.onControlLine = (m) => { if (m.t === 'confirm' && !peer.rtc) peer.attachRtc(false); };
    peer.sendSealed({ t: 'confirm', onion: PEER_ONION });
    await waitFor(() => lastState().peerConfirmed === true);
    expect(lastState().phase).toBe('compare');
    ctrl.confirm(true);
    await waitFor(() => paired.length === 1, 8000);
    const { contact, rtc } = paired[0];
    expect(contact).toMatchObject({ id: res.contactId, role: 'responder', torOnion: PEER_ONION });
    expect(rtc.isInitiator).toBe(true);
    await waitFor(() => peer.rtc.keyExchangeDone);
    expect(rtc.sharedSecret).toBe(peer.rtc.sharedSecret);
    expect(lastState().phase).toBe('done');
    expectNoNumbersAnywhere([...rvs.map((r) => r.onion), res.code]);
  }, 20000);

  test('Abbruch waehrend ein Verbindungsversuch laeuft: die spaet aufgebaute Verbindung wird sofort geschlossen', async () => {
    let release;
    NativeModules.MalachiTor.connectWithTimeout.mockImplementation(() => new Promise((r) => { release = release || r; }));
    const ctrl = start(HI_INPUT, LO_INPUT);
    await waitFor(() => NativeModules.MalachiTor.connectWithTimeout.mock.calls.length >= 1);
    ctrl.cancel();
    expect(lastState().error).toBe('cancelled');
    release('out-spaet');
    await waitFor(() => closed.includes('out-spaet'));
    expect(NativeModules.MalachiTor.addRendezvousOnion).not.toHaveBeenCalled();
    expectNoNumbersAnywhere();
  });

  test('Zeitablauf ohne Treffpunkt: "timeout", keine Verbindung offen', async () => {
    NativeModules.MalachiTor.connectWithTimeout.mockImplementation(async () => { throw new Error('Tor: Onion-Beschreibung nicht gefunden'); });
    start(HI_INPUT, LO_INPUT, { windowMs: 1200 });
    await waitFor(() => lastState().phase === 'error', 3000);
    expect(lastState().error).toBe('timeout');
    const calls = NativeModules.MalachiTor.connectWithTimeout.mock.calls.length;
    await tick(1200);
    expect(NativeModules.MalachiTor.connectWithTimeout.mock.calls.length).toBe(calls);   // keine weiteren Versuche
  });

  test('Treffpunkt antwortet nicht authentisch (falscher Anmeldeschluessel): Verbindung verworfen, Suche geht weiter', async () => {
    const rvs = await expectedRendezvous();
    let n = 0;
    NativeModules.MalachiTor.connectWithTimeout.mockImplementation(async (onion) => {
      if (onion !== rvs[0].onion) throw new Error('Tor: Onion-Beschreibung nicht gefunden');
      n++;
      return 'out-fake-' + n;
    });
    start(HI_INPUT, LO_INPUT);
    const fake = makePeer('out-fake-1');
    await waitFor(() => n >= 1);
    const wrong = await PP.deriveRendezvous(LO, '+4917612345679', PP.phoneBuckets()[0], { kdf: H.kdfNode });
    const hs = new PP.HostHandshake({ onion: rvs[0].onion, authKey: wrong.authKey, rng: H.rng, kyber: H.realKyber() });
    fake.sendJson(await hs.hello());
    const auth = await fake.nextJson();
    // Der falsche Gastgeber kann die Anmeldung des Gasts nicht pruefen und raet.
    await expect(hs.onAuth(auth)).rejects.toMatchObject({ code: 'auth' });
    fake.sendJson({ t: 'malachi-phone', step: 'keys', x: H.b64(crypto.randomBytes(32)), r: H.b64(crypto.randomBytes(32)), mac: H.b64(crypto.randomBytes(32)) });
    await waitFor(() => closed.includes('out-fake-1'));
    expect(states.some((s) => s.phase === 'compare')).toBe(false);
    await waitFor(() => n >= 2, 8000);   // naechster Versuch
  }, 15000);
});
