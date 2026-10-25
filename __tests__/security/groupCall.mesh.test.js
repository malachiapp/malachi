// Gruppen-Sprachanrufe (GroupCallManager.js, GROUP_CALL_DESIGN.md).
//
// Vier "Geraete" (Alice, Bob, Carol, Dave), jedes mit eigener Modul-Instanz
// (jest.isolateModules) und eigenem Speicher. Gruppe "Projekt Falke" =
// Alice, Bob, Carol. Kopplungen (Standard): Alice-Bob, Alice-Carol, Bob-Dave -
// Bob und Carol sind NICHT miteinander gekoppelt (ihr Paar laeuft ueber den
// Host), Dave ist kein Gruppenmitglied. Die 1:1-Kanaele sind Attrappen im
// Speicher (zugestellt wird die entschluesselte Nachricht an
// RTCStore._onIncoming, wie es WebRTCManager tut); die Gruppenanruf-Signale
// selbst sind echt verschluesselt ('gcall-signal'). RTCPeerConnection ist eine
// Attrappe, die zwei Seiten verbindet, sobald beide Beschreibungen gesetzt
// sind (oder - "NAT" - scheitert).
const crypto = require('crypto');

jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      setItem: async (k, v) => { (global.__esWrites || []).push({ dev, k, v: String(v) }); store.set(k, String(v)); },
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      removeItem: async (k) => { (global.__esWrites || []).push({ dev, k, v: null }); store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

jest.mock('react-native-webrtc', () => {
  const dev = global.__mockDevice || 'default';
  let seq = 0;
  class FakePC {
    constructor(config) {
      this.config = config;
      this.dev = dev;
      this.id = dev + '-pc' + (++seq) + '-' + Math.floor(Math.random() * 1e9).toString(16);
      this.iceConnectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.tracks = [];
      this.added = [];
      this.closed = false;
      this.peer = null;
      (global.__fakePcs = global.__fakePcs || []).push(this);
    }
    addTrack(t) { this.tracks.push(t); }
    _sdp() {
      return 'v=0\r\no=- ' + this.id + ' 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
        + 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;stereo=1\r\na=fingerprint:sha-256 AB:CD:' + this.id + '\r\n';
    }
    async createOffer() { return { type: 'offer', sdp: this._sdp() }; }
    async createAnswer() { return { type: 'answer', sdp: this._sdp() }; }
    async setLocalDescription(d) {
      this.localDescription = d;
      setTimeout(() => {
        if (this.closed || !this.onicecandidate) return;
        this.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 198.51.100.' + (seq % 250) + ' 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        this.onicecandidate({ candidate: null });
      }, 0);
      this._maybeConnect();
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d;
      const m = /o=- (\S+) /.exec(d.sdp || '');
      this.peer = (global.__fakePcs || []).find((p) => p.id === (m && m[1])) || null;
      this._maybeConnect();
    }
    async addIceCandidate(c) { this.added.push(c); }
    _maybeConnect() {
      const p = this.peer;
      if (!p || p.peer !== this || !this.localDescription || !this.remoteDescription || !p.localDescription || !p.remoteDescription) return;
      const blocked = (global.__blockedPairs || new Set()).has([this.dev, p.dev].sort().join('|'));
      setTimeout(() => {
        for (const x of [this, p]) {
          if (x.closed) continue;
          x.iceConnectionState = blocked ? 'failed' : 'connected';
          if (x.oniceconnectionstatechange) x.oniceconnectionstatechange();
        }
      }, 5);
    }
    close() { this.closed = true; this.iceConnectionState = 'closed'; }
  }
  return {
    RTCPeerConnection: FakePC,
    RTCSessionDescription: class { constructor(i) { Object.assign(this, i); } },
    RTCIceCandidate: class {},
    MediaStream: class {},
    MediaStreamTrack: class {},
    mediaDevices: {
      getUserMedia: async (c) => {
        const track = { kind: 'audio', dev, enabled: true, stopped: false, stop() { this.stopped = true; } };
        (global.__tracks = global.__tracks || []).push({ track, constraints: c });
        return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
      },
    },
    registerGlobals: () => {},
  };
});

const NAMES = { alice: 'Alice', bob: 'Bob', carol: 'Carol', dave: 'Dave' };
const MID = { alice: 'm_' + 'a'.repeat(32), bob: 'm_' + 'b'.repeat(32), carol: 'm_' + 'c'.repeat(32), dave: 'm_' + 'd'.repeat(32) };
const ID = { alice: 'c_alice', bob: 'c_bob', carol: 'c_carol', dave: 'c_dave' };
const GID = 'g_' + 'e'.repeat(24);
const FAST = {
  ringMs: 1500, hostRingSlackMs: 200, nobodyMs: 3000, joinTimeoutMs: 1500, pairConnectMs: 1500, iceGraceMs: 100,
  endedLingerMs: 20, connectViaTorMs: 50, statsMs: 0, terminalRetryMs: 10, reinviteGapMs: 0,
};
const DEFAULT_PAIRS = [['alice', 'bob'], ['alice', 'carol'], ['bob', 'dave']];
const PAIR_SECRETS = {};
function pairSecret(a, b) {
  const k = [a, b].sort().join('|');
  if (!PAIR_SECRETS[k]) PAIR_SECRETS[k] = crypto.randomBytes(32).toString('base64');
  return PAIR_SECRETS[k];
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung: ' + (what || fn.toString().slice(0, 160)));
    await tick(10);
  }
}

let D = {};
let logs = [];
const snap = (d) => d.GCM.getGroupCallSnapshot();
const pcsOf = (name) => (global.__fakePcs || []).filter((p) => p.dev === name);
const livePcsOf = (name) => pcsOf(name).filter((p) => !p.closed);
const tracksOf = (name) => (global.__tracks || []).filter((t) => t.track.dev === name).map((t) => t.track);

function groupState(members = ['alice', 'bob', 'carol']) {
  return {
    v: 1, groupId: GID, name: 'Projekt Falke', description: '', members: members.map((n) => ({ mid: MID[n], name: NAMES[n] })),
    admins: [MID.alice], createdBy: MID.alice, createdAt: 1, rev: 1, updatedAt: 1, removed: false, leftMembers: {}, unread: 0,
  };
}

async function bootDevice(name, peers, { groupMembers, timeouts }) {
  global.__mockDevice = name;
  let d;
  // Achtung: react-native exportiert NativeModules/DeviceEventEmitter ueber
  // Getter, die erst beim Zugriff "require"n - ausserhalb dieses Callbacks
  // liefern sie das Standard-Register. Deshalb hier festhalten (bridge/audio/
  // DEE) und in den Tests nur diese Referenzen benutzen.
  jest.isolateModules(() => {
    const RN = require('react-native');
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    const bridge = {
      addListener() {}, removeListeners() {},
      reportIncomingCall: jest.fn(), reportOutgoingCall: jest.fn(), reportCallActive: jest.fn(), reportCallEnded: jest.fn(),
    };
    const audio = {
      addListener() {}, removeListeners() {}, setSpeaker: jest.fn(), setMuted: jest.fn(),
      isSupported: jest.fn(async () => true), start: jest.fn(async () => true), stop: jest.fn(async () => true), play: jest.fn(),
    };
    RN.NativeModules.CallBridgeModule = bridge;
    RN.NativeModules.MalachiCallAudio = audio;
    d = {
      name, bridge, audio, DEE: RN.DeviceEventEmitter, sent: [], conns: {}, notices: [],
      ES: require('react-native-encrypted-storage').default,
      RTCStore: require('../../RTCStore').default,
      CM: require('../../ConnectionMode'),
      MC: require('../../MessageCrypto'),
      CallManagerMod: require('../../CallManager'),
      GCM: require('../../GroupCallManager'),
    };
  });
  global.__mockDevice = undefined;
  await d.ES.clear();
  await d.ES.setItem('contacts', JSON.stringify(peers.map((p) => ({ id: ID[p], name: NAMES[p], theirName: NAMES[p], groupMemberId: MID[p] }))));
  await d.ES.setItem('group_self_id', MID[name]);
  await d.ES.setItem('username', NAMES[name]);
  if (groupMembers.includes(name)) await d.ES.setItem('groups', JSON.stringify([groupState(groupMembers)]));
  for (const p of peers) d.RTCStore.sharedSecrets.set(ID[p], pairSecret(name, p));
  d.GCM.configureGroupCall({ timeouts: { ...FAST, ...(timeouts || {}) }, isPro: () => !!d.pro });
  d.GCM.setGroupCallNoticeHandler((t) => d.notices.push(t));
  return d;
}

function link(x, y) {
  const mk = (from, to) => ({
    transport: 'direct', sharedSecret: pairSecret(from.name, to.name), keyExchangeDone: true,
    dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' }, pendingMsgs: [], close() {},
    sendMessage: jest.fn((raw) => {
      from.sent.push({ to: to.name, raw });
      if (!(global.__deadLinks || new Set()).has(from.name + '>' + to.name)) {
        setTimeout(() => to.RTCStore._onIncoming(ID[from.name], to.conns[from.name], JSON.parse(raw)), 0);
      }
      return 'sent';
    }),
  });
  x.conns[y.name] = mk(x, y);
  y.conns[x.name] = mk(y, x);
  x.RTCStore.connections.set(ID[y.name], x.conns[y.name]);
  y.RTCStore.connections.set(ID[x.name], y.conns[x.name]);
}

async function setup({ pairs = DEFAULT_PAIRS, groupMembers = ['alice', 'bob', 'carol'], pro = ['alice'], timeouts } = {}) {
  global.__fakePcs = [];
  global.__tracks = [];
  global.__esWrites = [];
  global.__blockedPairs = new Set();
  global.__deadLinks = new Set();
  D = {};
  for (const name of ['alice', 'bob', 'carol', 'dave']) {
    const peers = pairs.filter((p) => p.includes(name)).map((p) => (p[0] === name ? p[1] : p[0]));
    D[name] = await bootDevice(name, peers, { groupMembers, timeouts });
    D[name].pro = pro.includes(name);
  }
  // Jedes Geraet braucht EIGENEN Speicher (siehe Hinweis bei 'strenge Pruefung').
  if (D.alice.ES === D.bob.ES || D.alice.RTCStore === D.bob.RTCStore) throw new Error('Geraete teilen Modul-Instanzen');
  for (const [a, b] of pairs) link(D[a], D[b]);
  return D;
}

// Gesendete Gruppenanruf-Signale von -> an (entschluesselt).
function gcallSent(fromName, toName) {
  const from = D[fromName];
  return from.sent.filter((s) => s.to === toName).map((s) => JSON.parse(s.raw))
    .filter((m) => m.subtype === 'gcall_signal')
    .map((m) => JSON.parse(from.MC.decryptMsg(m.enc, pairSecret(fromName, toName), 'gcall-signal')));
}
// Vom Test gebautes Signal "fromName -> toDev" ueber deren Kanal einspielen.
async function inject(fromName, toDev, inner) {
  const enc = await toDev.MC.encryptMsg(JSON.stringify({ v: 1, ...inner }), pairSecret(fromName, toDev.name), 'gcall-signal');
  toDev.RTCStore._onIncoming(ID[fromName], toDev.conns[fromName] || {}, { type: 'system', subtype: 'gcall_signal', enc });
  await tick(40);
}

function joinedLinks(d) {
  return snap(d).participants.filter((p) => !p.isSelf && p.status === 'joined');
}
async function threeWayCall() {
  expect(await D.alice.GCM.startGroupCall(GID)).toEqual({ ok: true });
  await waitFor(() => snap(D.bob).state === 'ringing' && snap(D.carol).state === 'ringing', 4000, 'Klingeln');
  expect(await D.bob.GCM.acceptGroupCall()).toBe(true);
  expect(await D.carol.GCM.acceptGroupCall()).toBe(true);
  await waitFor(() => ['alice', 'bob', 'carol'].every((n) => snap(D[n]).state === 'active'
    && joinedLinks(D[n]).length === 2 && joinedLinks(D[n]).every((p) => p.link === 'connected')), 4000, 'Vollvermaschung');
}

beforeAll(() => {
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
    jest.spyOn(console, k).mockImplementation((...a) => {
      logs.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' '));
    });
  }
});
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(() => { logs = []; });
afterEach(async () => {
  for (const d of Object.values(D)) {
    try { d.GCM.leaveGroupCall('user_hangup'); } catch {}
  }
  await tick(60);
  for (const d of Object.values(D)) d.GCM._resetGroupCallForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Vollversion: nur Pro startet, jeder nimmt teil', () => {
  test('ohne Vollversion startet der Manager selbst keinen Gruppenanruf (nichts gesendet, kein Mikrofon, keine Verbindung)', async () => {
    await setup({ pro: [] });
    expect(D.alice.GCM.canStartGroupCall()).toBe(false);
    expect(await D.alice.GCM.startGroupCall(GID)).toEqual({ error: 'pro' });
    await tick(50);
    expect(D.alice.sent).toHaveLength(0);
    expect(pcsOf('alice')).toHaveLength(0);
    expect(tracksOf('alice')).toHaveLength(0);
    expect(snap(D.alice).state).toBe('idle');
    expect(snap(D.bob).state).toBe('idle');
  });

  test('Host mit Vollversion, Bob und Carol ohne: beide nehmen an, volles Netz aus 3 Paaren (Opus mono, niedrige Bitrate)', async () => {
    await setup({ pro: ['alice'] });
    await threeWayCall();
    // Jedes Geraet: genau zwei verbundene Paar-Verbindungen, nur Audio.
    for (const n of ['alice', 'bob', 'carol']) {
      const live = livePcsOf(n);
      expect(live).toHaveLength(2);
      expect(live.every((p) => p.iceConnectionState === 'connected')).toBe(true);
      expect(live.every((p) => p.tracks.length === 1 && p.tracks[0].kind === 'audio')).toBe(true);
      for (const p of live) {
        expect(p.localDescription.sdp).toMatch(/a=fmtp:111 [^\r\n]*stereo=0/);
        expect(p.localDescription.sdp).toMatch(/maxaveragebitrate=20000/);
        expect(p.localDescription.sdp).not.toMatch(/stereo=1/);
      }
    }
    expect(global.__tracks.find((t) => t.track.dev === 'bob').constraints).toEqual({ audio: true, video: false });
    // Kein TURN/Relay-Server und seit dem STUN-Ausstieg auch kein STUN.
    for (const p of global.__fakePcs) expect(p.config.iceServers).toEqual([]);
    // Dave (kein Mitglied) bekam nichts.
    expect(gcallSent('bob', 'dave')).toHaveLength(0);
    expect(snap(D.dave).state).toBe('idle');
    // Native Anruf-Anzeige: Host ausgehend, Mitglieder eingehend (opaker Schluessel).
    expect(D.alice.bridge.reportOutgoingCall).toHaveBeenCalledWith(expect.stringMatching(/^gcall_gc_[0-9a-f]{32}$/), 'Gruppenanruf · Projekt Falke');
    expect(D.bob.bridge.reportIncomingCall).toHaveBeenCalledWith(expect.stringMatching(/^gcall_/), 'Gruppenanruf · Projekt Falke');
    // Kein Ausweichen auf "Sprache ueber den Kanal".
    expect(D.bob.audio.start).not.toHaveBeenCalled();
  });

  test('Host mit groesster Mitglieds-ID: die Mitglieder bieten dem Host an (Regel "Kleinere ID bietet an")', async () => {
    await setup({ pairs: [['carol', 'alice'], ['carol', 'bob']], pro: ['carol'] });
    expect(await D.carol.GCM.startGroupCall(GID)).toEqual({ ok: true });
    await waitFor(() => snap(D.alice).state === 'ringing' && snap(D.bob).state === 'ringing');
    await D.alice.GCM.acceptGroupCall();
    await D.bob.GCM.acceptGroupCall();
    await waitFor(() => ['alice', 'bob', 'carol'].every((n) => snap(D[n]).state === 'active'
      && joinedLinks(D[n]).every((p) => p.link === 'connected') && joinedLinks(D[n]).length === 2));
    expect(gcallSent('carol', 'alice').some((m) => m.t === 'offer' && m.to === MID.alice)).toBe(false);
    expect(gcallSent('alice', 'carol').some((m) => m.t === 'offer' && m.to === MID.carol)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Signalisierung: Weiterleitung nur ueber den Host', () => {
  test('nicht gekoppeltes Paar (Bob-Carol): Angebot/Antwort/ICE laufen ueber Alice, Absender vom Host gesetzt', async () => {
    await setup();
    await threeWayCall();
    const bobToAlice = gcallSent('bob', 'alice');
    const viaHost = bobToAlice.filter((m) => m.to === MID.carol);
    expect(viaHost.some((m) => m.t === 'offer')).toBe(true);
    expect(viaHost.some((m) => m.t === 'ice')).toBe(true);
    const aliceToCarol = gcallSent('alice', 'carol').filter((m) => m.from === MID.bob);
    expect(aliceToCarol.some((m) => m.t === 'offer' && m.to === MID.carol)).toBe(true);
    const aliceToBob = gcallSent('alice', 'bob').filter((m) => m.from === MID.carol);
    expect(aliceToBob.some((m) => m.t === 'answer' && m.to === MID.bob)).toBe(true);
    // Weitergeleitet werden nur Paar-Signale - nie Einladung/Liste/Ende.
    for (const m of [...aliceToCarol, ...aliceToBob]) expect(['offer', 'answer', 'ice']).toContain(m.t);
    // Mitglieder leiten nie etwas weiter.
    expect(gcallSent('carol', 'alice').filter((m) => m.from && m.from !== MID.carol)).toHaveLength(0);
    expect(gcallSent('bob', 'alice').filter((m) => m.from && m.from !== MID.bob)).toHaveLength(0);
  });

  test('gekoppeltes Paar signalisiert nur direkt; vom Host "weitergeleitete" Signale fuer dieses Paar werden verworfen', async () => {
    await setup({ pairs: [['alice', 'bob'], ['alice', 'carol'], ['bob', 'carol']] });
    await threeWayCall();
    expect(gcallSent('bob', 'carol').some((m) => m.t === 'offer' && m.to === MID.carol)).toBe(true);
    expect(gcallSent('alice', 'carol').filter((m) => m.from === MID.bob)).toHaveLength(0);
    // Angriff des Hosts auf ein gekoppeltes Paar: gefaelschtes "Bob"-Angebot an Carol.
    const before = pcsOf('carol').length;
    const callId = snap(D.carol).callKey.replace(/^gcall_/, '');
    const sentBefore = D.carol.sent.length;
    await inject('alice', D.carol, { t: 'offer', callId, groupId: GID, to: MID.carol, from: MID.bob, sdp: 'v=0\r\no=- boese 2 IN IP4 0.0.0.0\r\n' });
    expect(pcsOf('carol').length).toBe(before);
    expect(D.carol.sent.length).toBe(sentBefore);
    // Mitglied leitet nicht weiter: Bob schickt Carol ein Signal "an Alice".
    await inject('bob', D.carol, { t: 'ice', callId, groupId: GID, to: MID.alice, from: MID.bob, c: { candidate: 'candidate:9 1 udp 1 203.0.113.9 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    expect(D.carol.sent.length).toBe(sentBefore);
    // Absender-Behauptung ueber fremden Kanal: Bob gibt sich als Alice aus.
    await inject('bob', D.carol, { t: 'offer', callId, groupId: GID, to: MID.carol, from: MID.alice, sdp: 'v=0\r\no=- x 2 IN IP4 0.0.0.0\r\n' });
    expect(pcsOf('carol').length).toBe(before);
    expect(D.carol.sent.length).toBe(sentBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Annahme nur von Gruppenmitgliedern fuer angekuendigte Anrufe', () => {
  const freshCallId = () => 'gc_' + crypto.randomBytes(16).toString('hex');

  test('Einladung eines Kontakts, der nicht Mitglied der Gruppe ist (Dave), klingelt nicht', async () => {
    await setup();
    await inject('dave', D.bob, { t: 'invite', callId: freshCallId(), groupId: GID, host: MID.dave, participants: [MID.dave, MID.bob], ts: Date.now() });
    expect(snap(D.bob).state).toBe('idle');
    expect(D.bob.GCM.runningGroupCallFor(GID)).toBeNull();
    expect(gcallSent('bob', 'dave')).toHaveLength(0);
  });

  test('Einladung "im Namen" eines anderen Hosts, fuer fremde Gruppe, ohne mich oder veraltet: verworfen', async () => {
    await setup();
    const base = { t: 'invite', groupId: GID, ts: Date.now() };
    await inject('alice', D.bob, { ...base, callId: freshCallId(), host: MID.carol, participants: [MID.carol, MID.bob] });
    await inject('alice', D.bob, { ...base, callId: freshCallId(), groupId: 'g_' + '1'.repeat(24), host: MID.alice, participants: [MID.alice, MID.bob] });
    await inject('alice', D.bob, { ...base, callId: freshCallId(), host: MID.alice, participants: [MID.alice, MID.carol] });
    await inject('alice', D.bob, { ...base, callId: freshCallId(), host: MID.alice, participants: [MID.alice, MID.bob], ts: Date.now() - 10 * 60 * 1000 });
    expect(snap(D.bob).state).toBe('idle');
    expect(gcallSent('bob', 'alice')).toHaveLength(0);
  });

  test('Signale fuer eine unbekannte callId bzw. von Nicht-Teilnehmern (Dave) werden verworfen', async () => {
    await setup();
    await threeWayCall();
    const callId = snap(D.bob).callKey.replace(/^gcall_/, '');
    const pcsBefore = pcsOf('bob').length;
    const sentBefore = D.bob.sent.length;
    // Unbekannte callId vom echten Host: Liste/Ende/Angebot wirkungslos.
    await inject('alice', D.bob, { t: 'end', callId: freshCallId(), groupId: GID, reason: 'host_hangup' });
    await inject('alice', D.bob, { t: 'roster', callId: freshCallId(), groupId: GID, members: [{ mid: MID.alice, st: 'joined' }] });
    await inject('alice', D.bob, { t: 'offer', callId: freshCallId(), groupId: GID, to: MID.bob, from: MID.alice, sdp: 'v=0\r\n' });
    expect(snap(D.bob).state).toBe('active');
    // Dave kennt die echte callId, ist aber kein Teilnehmer.
    await inject('dave', D.bob, { t: 'offer', callId, groupId: GID, to: MID.bob, from: MID.dave, sdp: 'v=0\r\no=- dave 2 IN IP4 0.0.0.0\r\n' });
    await inject('dave', D.bob, { t: 'end', callId, groupId: GID });
    expect(snap(D.bob).state).toBe('active');
    expect(pcsOf('bob').length).toBe(pcsBefore);
    expect(D.bob.sent.length).toBe(sentBefore);
    // Nur der Host darf die Liste schicken bzw. beenden - nicht Carol.
    await inject('alice', D.carol, { t: 'leave', callId, groupId: GID });   // an ein Mitglied: kein Host-Signal
    expect(snap(D.carol).state).toBe('active');
  });

  test('strenge Pruefung aller Felder und Groessen', async () => {
    // Nur innerhalb eines "Geraets" laden: ein require im Standard-Register
    // wuerde die Speicher-/WebRTC-Attrappen fuer alle folgenden Geraete teilen.
    await setup();
    const { sanitizeGroupCallMessage: s } = D.alice.GCM;
    const callId = 'gc_' + 'f'.repeat(32);
    const ok = { v: 1, t: 'offer', callId, groupId: GID, to: MID.bob, from: MID.alice, sdp: 'v=0\r\n', extra: 'weg' };
    expect(s(ok)).toEqual({ t: 'offer', callId, groupId: GID, to: MID.bob, from: MID.alice, sdp: 'v=0\r\n' });
    expect(s({ ...ok, v: 2 })).toBeNull();
    expect(s({ ...ok, t: 'hack' })).toBeNull();
    expect(s({ ...ok, callId: 'gc_123' })).toBeNull();
    expect(s({ ...ok, groupId: '../x' })).toBeNull();
    expect(s({ ...ok, to: 'm_xyz' })).toBeNull();
    expect(s({ ...ok, sdp: 'x'.repeat(10) })).toBeNull();
    expect(s({ ...ok, sdp: 'v=0' + 'a'.repeat(17000) })).toBeNull();
    const ice = { v: 1, t: 'ice', callId, groupId: GID, to: MID.bob, c: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, boese: 1 } };
    expect(s(ice).c).toEqual({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
    expect(s({ ...ice, c: { candidate: 'x'.repeat(1100) } })).toBeNull();
    expect(s({ ...ice, c: { candidate: 'c', sdpMLineIndex: 99 } })).toBeNull();
    const inv = { v: 1, t: 'invite', callId, groupId: GID, host: MID.alice, participants: [MID.alice, MID.bob], ts: 1 };
    expect(s(inv)).toBeTruthy();
    expect(s({ ...inv, participants: [MID.bob, MID.carol] })).toBeNull();            // Host fehlt
    expect(s({ ...inv, participants: [MID.alice, MID.alice] })).toBeNull();          // doppelt
    expect(s({ ...inv, participants: Array.from({ length: 9 }, (_, i) => 'm_' + String(i).repeat(32)) })).toBeNull();
    expect(s({ v: 1, t: 'roster', callId, groupId: GID, members: [{ mid: MID.bob, st: 'admin' }] })).toBeNull();
    expect(s({ v: 1, t: 'mute', callId, groupId: GID, mu: 'ja' })).toBeNull();
    expect(s({ v: 1, t: 'decline', callId, groupId: GID, reason: '<script>' }).reason).toBe('user');
    expect(s(null)).toBeNull();
    expect(s([])).toBeNull();
  });

  test('zu grosse Pakete und Einladungs-Flut werden verworfen (Ratenbegrenzung)', async () => {
    await setup();
    D.bob.RTCStore._onIncoming(ID.alice, D.bob.conns.alice, { type: 'system', subtype: 'gcall_signal', enc: 'A'.repeat(100 * 1024) });
    await tick(20);
    expect(snap(D.bob).state).toBe('idle');
    for (let i = 0; i < 10; i++) {
      await inject('alice', D.bob, { t: 'invite', callId: 'gc_' + crypto.randomBytes(16).toString('hex'), groupId: GID, host: MID.alice, participants: [MID.alice, MID.bob], ts: Date.now() });
    }
    expect(snap(D.bob).state).toBe('ringing');   // die erste klingelt
    const declines = gcallSent('bob', 'alice').filter((m) => m.t === 'decline');
    expect(declines.length).toBe(5);              // 6 pro Minute angenommen, Rest verworfen
    expect(declines.every((m) => m.reason === 'busy')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Audit 2026-10-19: kein Mithoeren ohne Beitritt', () => {
  test('Mitglied lehnt ab und schickt dann selbst ein Angebot an einen Teilnehmer: keine Verbindung, kein Mikrofon', async () => {
    await setup({ pairs: [...DEFAULT_PAIRS, ['bob', 'carol']] });
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing' && snap(D.carol).state === 'ringing');
    const callId = snap(D.carol).callKey.replace(/^gcall_/, '');
    D.bob.GCM.declineGroupCall();
    await D.carol.GCM.acceptGroupCall();
    await waitFor(() => snap(D.carol).state === 'active'
      && snap(D.carol).participants.find((x) => x.mid === MID.bob)?.status === 'declined', 4000, 'Liste mit Bob abgelehnt');
    const pcsBefore = pcsOf('carol').length;
    const antwortenBefore = gcallSent('carol', 'bob').filter((m) => m.t === 'answer').length;
    // Bob (kleinere ID, direkt mit Carol gekoppelt) bietet trotzdem an - manipulierter Client.
    await inject('bob', D.carol, { t: 'offer', callId, groupId: GID, to: MID.carol, from: MID.bob, sdp: 'v=0 bob-angebot' });
    await inject('bob', D.carol, { t: 'ice', callId, groupId: GID, to: MID.carol, from: MID.bob, c: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    await tick(80);
    expect(pcsOf('carol').length).toBe(pcsBefore);
    expect(gcallSent('carol', 'bob').filter((m) => m.t === 'answer').length).toBe(antwortenBefore);
  });
});

describe('Auflegen, Host-Ende, spaeter Beitritt, Zeitueberschreitungen', () => {
  test('Mitglied legt auf: neue Liste vom Host, die anderen schliessen ihre Verbindung zu ihm, Anruf laeuft weiter', async () => {
    await setup();
    await threeWayCall();
    D.carol.GCM.leaveGroupCall();
    await waitFor(() => snap(D.carol).state === 'idle');
    await waitFor(() => snap(D.alice).participants.find((p) => p.mid === MID.carol).status === 'left'
      && snap(D.bob).participants.find((p) => p.mid === MID.carol).status === 'left');
    expect(livePcsOf('carol')).toHaveLength(0);
    expect(livePcsOf('alice')).toHaveLength(1);
    expect(livePcsOf('bob')).toHaveLength(1);
    expect(tracksOf('carol').every((t) => t.stopped)).toBe(true);
    expect(snap(D.alice).state).toBe('active');
    expect(snap(D.bob).state).toBe('active');
    // Bleibt nur der Host, endet der Anruf (weniger als 2 Personen).
    D.bob.GCM.leaveGroupCall();
    await waitFor(() => snap(D.alice).state === 'idle');
    expect(D.alice.notices.join(' ')).toMatch(/Alle anderen haben aufgelegt/);
    expect(livePcsOf('alice')).toHaveLength(0);
  });

  test('Host legt auf: der Anruf endet fuer alle (Hinweis, alle Verbindungen und Mikrofone zu)', async () => {
    await setup();
    await threeWayCall();
    D.alice.GCM.leaveGroupCall();
    await waitFor(() => ['alice', 'bob', 'carol'].every((n) => snap(D[n]).state === 'idle'));
    for (const n of ['alice', 'bob', 'carol']) {
      expect(livePcsOf(n)).toHaveLength(0);
      expect(tracksOf(n).every((t) => t.stopped)).toBe(true);
    }
    expect(D.bob.notices.join(' ')).toMatch(/Alice hat den Gruppenanruf beendet/);
    expect(D.bob.GCM.runningGroupCallFor(GID)).toBeNull();
    expect(D.bob.bridge.reportCallEnded).toHaveBeenCalled();
  });

  test('Ablehnen, dann spaeter beitreten; Host kann erneut anrufen', async () => {
    await setup();
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing' && snap(D.carol).state === 'ringing');
    D.bob.GCM.declineGroupCall();
    await D.carol.GCM.acceptGroupCall();
    await waitFor(() => snap(D.alice).participants.find((p) => p.mid === MID.bob).status === 'declined'
      && snap(D.carol).state === 'active' && snap(D.bob).state === 'idle');
    // Host: "Erneut anrufen" -> Bob klingelt wieder; Bob lehnt erneut ab.
    expect(snap(D.alice).participants.find((p) => p.mid === MID.bob).canReinvite).toBe(true);
    expect(D.alice.GCM.ringAgain(MID.bob)).toBe(true);
    await waitFor(() => snap(D.bob).state === 'ringing');
    D.bob.GCM.declineGroupCall();
    await waitFor(() => snap(D.bob).state === 'idle');
    // Bob tritt spaeter selbst bei ("Gruppenanruf laeuft - beitreten").
    expect(D.bob.GCM.runningGroupCallFor(GID)).toBeTruthy();
    expect(await D.bob.GCM.joinRunningGroupCall(GID)).toEqual({ ok: true });
    await waitFor(() => ['alice', 'bob', 'carol'].every((n) => snap(D[n]).state === 'active'
      && joinedLinks(D[n]).length === 2 && joinedLinks(D[n]).every((p) => p.link === 'connected')), 4000, 'spaeter Beitritt');
  });

  test('niemand nimmt an: Mitglieder lehnen nach Ablauf ab (verpasst), Host endet mit Hinweis', async () => {
    await setup({ timeouts: { ringMs: 150, hostRingSlackMs: 100, nobodyMs: 2000 } });
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing');
    await waitFor(() => ['alice', 'bob', 'carol'].every((n) => snap(D[n]).state === 'idle'), 3000);
    expect(gcallSent('bob', 'alice').find((m) => m.t === 'decline').reason).toBe('timeout');
    expect(D.alice.notices.join(' ')).toMatch(/Niemand hat den Gruppenanruf angenommen/);
    expect(pcsOf('alice')).toHaveLength(0);
    expect(D.bob.GCM.runningGroupCallFor(GID)).toBeNull();   // Ende des Hosts raeumt auch das auf
  });

  test('Host-Sicherheitsnetz: niemand reagiert ueberhaupt (Einladungen kommen nicht an) -> Ende nach nobodyMs', async () => {
    await setup({ timeouts: { ringMs: 5000, hostRingSlackMs: 5000, nobodyMs: 200 } });
    global.__deadLinks.add('alice>bob');
    global.__deadLinks.add('alice>carol');
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.alice).state === 'idle', 2000);
    expect(D.alice.notices.join(' ')).toMatch(/Niemand hat/);
  });

  test('Host antwortet nicht auf den Beitritt: Mitglied bricht nach joinTimeoutMs ab', async () => {
    await setup({ timeouts: { joinTimeoutMs: 200 } });
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing');
    global.__deadLinks.add('alice>bob');   // Antworten des Hosts gehen verloren
    await D.bob.GCM.acceptGroupCall();
    expect(snap(D.bob).state).toBe('connecting');
    await waitFor(() => snap(D.bob).state === 'idle', 2000);
    expect(D.bob.notices.join(' ')).toMatch(/hat nicht geantwortet/);
  });

  test('Paar ohne direkte Verbindung (NAT): "nicht erreichbar" fuer dieses Paar, kein Ausweichen auf Tor, Rest laeuft', async () => {
    await setup({ timeouts: { pairConnectMs: 3000 } });
    global.__blockedPairs.add('bob|carol');
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing' && snap(D.carol).state === 'ringing');
    await D.bob.GCM.acceptGroupCall();
    await D.carol.GCM.acceptGroupCall();
    await waitFor(() => snap(D.bob).participants.find((p) => p.mid === MID.carol).link === 'failed'
      && snap(D.carol).participants.find((p) => p.mid === MID.bob).link === 'failed');
    // (Anzeige "nicht erreichbar" fuer link 'failed': groupCall.screens.test.js)
    expect(snap(D.bob).participants.find((p) => p.mid === MID.carol).status).toBe('joined');
    expect(snap(D.bob).participants.find((p) => p.mid === MID.alice).link).toBe('connected');
    expect(snap(D.bob).state).toBe('active');
    expect(snap(D.carol).state).toBe('active');
    for (const n of ['bob', 'carol']) {
      expect(D[n].audio.start).not.toHaveBeenCalled();
      expect(D[n].RTCStore.callAudioHandler).toBeNull();
    }
  });

  test('zu niemandem eine Verbindung: Anruf endet mit Hinweis (kein Server-Umweg)', async () => {
    await setup({ pairs: [['alice', 'bob'], ['alice', 'carol']] });
    global.__blockedPairs.add('alice|bob');
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing');
    await D.bob.GCM.acceptGroupCall();
    await waitFor(() => snap(D.bob).state === 'idle', 3000);
    expect(D.bob.notices.join(' ')).toMatch(/keine[nm]? .*direkte Verbindung|Zu keinem anderen Teilnehmer/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Verbindungsweg "Maximal anonym (nur Tor)"', () => {
  test('Host in Stufe 3: kein Gruppenanruf, keine PeerConnection, nichts gesendet', async () => {
    await setup();
    await D.alice.CM.setConnectionMode(D.alice.CM.MODE_TOR_ONLY, { pro: true });
    expect(await D.alice.GCM.startGroupCall(GID)).toEqual({ error: 'tor_only' });
    await tick(30);
    expect(D.alice.sent).toHaveLength(0);
    expect(pcsOf('alice')).toHaveLength(0);
    expect(tracksOf('alice')).toHaveLength(0);
  });

  test('Mitglied in Stufe 3 lehnt automatisch ab (Hinweis bei beiden), Host sieht "nur Tor"', async () => {
    await setup();
    await D.bob.CM.setConnectionMode(D.bob.CM.MODE_TOR_ONLY, { pro: true });
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.alice).participants.find((p) => p.mid === MID.bob).status === 'tor_only');
    expect(gcallSent('bob', 'alice').map((m) => m.t)).toEqual(['decline']);
    expect(gcallSent('bob', 'alice')[0].reason).toBe('tor_only');
    expect(snap(D.bob).state).toBe('idle');
    expect(pcsOf('bob')).toHaveLength(0);
    expect(tracksOf('bob')).toHaveLength(0);
    expect(D.bob.notices.join(' ')).toMatch(/Maximal anonym \(nur Tor\)/);
    expect(D.alice.notices.join(' ')).toMatch(/Bob nutzt den Verbindungsweg/);
  });

  test('Wechsel auf Stufe 3 waehrend des Anrufs: Gruppenanruf endet sofort, Verbindungen zu', async () => {
    await setup();
    await threeWayCall();
    await D.carol.CM.setConnectionMode(D.carol.CM.MODE_TOR_ONLY, { pro: true });
    await waitFor(() => snap(D.carol).state === 'idle');
    expect(livePcsOf('carol')).toHaveLength(0);
    expect(D.carol.notices.join(' ')).toMatch(/nur Tor/);
    await waitFor(() => snap(D.alice).participants.find((p) => p.mid === MID.carol).status === 'left');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Nur ein Anruf gleichzeitig', () => {
  test('waehrend eines Gruppenanrufs wird ein 1:1-Anruf als "besetzt" abgelehnt - klingelt nicht, Anrufer bekommt Hinweis', async () => {
    await setup();
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing');
    const daveNotices = [];
    const CallManager = D.dave.CallManagerMod.default;
    const cm = new CallManager({ contactId: ID.bob, peerName: 'Bob', onNotice: (t) => daveNotices.push(t) });
    D.dave.RTCStore.callSignalHandler = (chatId, signal) => { if (chatId === ID.bob) cm.handleSignal(signal); };
    // Wie App.tsx: nur ein Angebot liesse es klingeln (cancel/ICE ohne Anruf
    // werden dort ignoriert).
    const bobRang = jest.fn();
    D.bob.RTCStore.callSignalHandler = (chatId, signal) => { if (signal.type === 'offer') bobRang(chatId); };
    await cm.startCall();
    await waitFor(() => daveNotices.length > 0);
    expect(daveNotices[0]).toBe('Bob telefoniert gerade (besetzt).');
    expect(bobRang).not.toHaveBeenCalled();
    expect(D.bob.RTCStore.pendingCalls.size).toBe(0);
    expect(snap(D.bob).state).toBe('ringing');   // Gruppenanruf unberuehrt
    await tick(600);                              // CallManager: ENDED -> IDLE
  });

  test('laeuft ein 1:1-Anruf, lehnt ein Mitglied die Einladung als "besetzt" ab; Host kann dann auch nicht starten', async () => {
    await setup();
    D.bob.RTCStore.setActiveCall(ID.dave);
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.alice).participants.find((p) => p.mid === MID.bob).status === 'busy');
    expect(snap(D.bob).state).toBe('idle');
    D.alice.GCM.leaveGroupCall();
    await waitFor(() => snap(D.alice).state === 'idle');
    D.alice.RTCStore.setActiveCall(ID.bob);
    expect(await D.alice.GCM.startGroupCall(GID)).toEqual({ error: 'busy' });
    D.alice.RTCStore.setActiveCall(null);
  });

  test('Annehmen ueber die System-Anzeige (Benachrichtigung) nutzt den opaken Schluessel', async () => {
    await setup();
    await D.alice.GCM.startGroupCall(GID);
    await waitFor(() => snap(D.bob).state === 'ringing');
    const key = snap(D.bob).callKey;
    D.bob.DEE.emit('nativeCallAnswered', { contactId: 'c_alice' });   // fremder Schluessel: nichts
    await tick(20);
    expect(snap(D.bob).state).toBe('ringing');
    D.bob.DEE.emit('nativeCallAnswered', { contactId: key });
    await waitFor(() => snap(D.bob).state === 'active');
    expect(D.bob.bridge.reportCallActive).toHaveBeenCalledWith(key);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Keine Spuren: nichts in Logs, nichts im Speicher', () => {
  test('voller Ablauf (Einladung, Weiterleitung, Stumm, Auflegen): keine SDP/ICE/IDs in Logs, kein Schreibzugriff auf den Speicher', async () => {
    await setup();
    const writesBefore = global.__esWrites.length;
    await threeWayCall();
    D.bob.GCM.setGroupCallMuted(true);
    await waitFor(() => snap(D.carol).participants.find((p) => p.mid === MID.bob).muted === true);
    expect(tracksOf('bob').every((t) => t.enabled === false)).toBe(true);
    D.alice.GCM.setGroupCallSpeaker(true);
    expect(D.alice.audio.setSpeaker).toHaveBeenCalledWith(true);
    const callId = snap(D.alice).callKey.replace(/^gcall_/, '');
    D.carol.GCM.leaveGroupCall();
    await tick(80);
    D.alice.GCM.leaveGroupCall();
    await waitFor(() => ['alice', 'bob', 'carol'].every((n) => snap(D[n]).state === 'idle'));
    expect(D.alice.audio.setSpeaker).toHaveBeenLastCalledWith(false);   // zurueckgesetzt
    // Speicher: kein einziger Schreibzugriff waehrend des Anrufs.
    expect(global.__esWrites.slice(writesBefore)).toEqual([]);
    for (const n of ['alice', 'bob', 'carol']) {
      const store = global.__mockStores[n];
      for (const [k, v] of store) expect(String(k) + String(v)).not.toMatch(/gcall|v=0|candidate:|gc_[0-9a-f]{8}/);
      expect(D[n].RTCStore.buffer.size).toBe(0);
      expect(D[n].RTCStore.pendingCalls.size).toBe(0);
    }
    // Logs: keine SDP, keine Kandidaten, keine callId/Mitglieds-IDs, keine Namen der Gruppe.
    const all = logs.join('\n');
    expect(all).toMatch(/\[GCall\]/);
    expect(all).not.toMatch(/v=0|a=fingerprint|candidate:|198\.51\.100/);
    expect(all).not.toContain(callId);
    for (const n of Object.keys(MID)) expect(all).not.toContain(MID[n]);
    expect(all).not.toContain('Projekt Falke');
  });
});
