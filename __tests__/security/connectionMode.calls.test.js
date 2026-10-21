// Verbindungsweg "Maximal anonym (nur Tor)" (ConnectionMode.js, Stufe 3) und
// Anrufe (CallManager.js): es entsteht NIE eine RTCPeerConnection - schon
// ihre Kandidaten wuerden die IP-Adresse an den Kontakt verraten.
//   - ausgehender Sprachanruf: Angebot ohne SDP (channelOnly), Sprache ueber
//     den Kanal; Videoanruf wird mit klarem Hinweis abgelehnt,
//   - eingehender Anruf (auch normales Angebot mit Video): Antwort ohne SDP,
//     Sprache ueber den Kanal, Video mit Hinweis aus,
//   - Gegenseite in Stufe 3: unsere WebRTC-Verbindung wird verworfen, Sprache
//     ueber den Kanal,
//   - Wechsel auf Stufe 3 mitten im WebRTC-Anruf: sofort auf den Kanal.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');

jest.mock('react-native-webrtc', () => {
  class MockPC {
    constructor(config) {
      this.config = config;
      this.iceConnectionState = 'new';
      this.remoteDescription = null;
      this.closed = false;
      (global.__callPcs = global.__callPcs || []).push(this);
    }
    addTrack() {}
    getSenders() { return []; }
    async createOffer() { return { type: 'offer', sdp: 'v=0 anruf-angebot' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0 anruf-antwort' }; }
    async setLocalDescription() {}
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {}
    close() { this.closed = true; }
  }
  return {
    RTCPeerConnection: MockPC,
    RTCSessionDescription: class { constructor(i) { Object.assign(this, i); } },
    RTCIceCandidate: class {},
    MediaStream: class {},
    MediaStreamTrack: class {},
    mediaDevices: {
      getUserMedia: jest.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] })),
    },
    registerGlobals: () => {},
  };
});

NativeModules.MalachiCallAudio = {
  addListener() {}, removeListeners() {},
  isSupported: jest.fn(async () => true),
  start: jest.fn(async () => true),
  stop: jest.fn(async () => true),
  play: jest.fn(),
  setMuted: jest.fn(),
};
global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });

const EncryptedStorage = require('react-native-encrypted-storage').default;
const { mediaDevices } = require('react-native-webrtc');
const RTCStore = require('../../RTCStore').default;
const CallManager = require('../../CallManager').default;
const { CallState, torOnlyVideoNotice } = require('../../CallManager');
const CM = require('../../ConnectionMode');
const { encryptMsg, decryptMsg } = require('../../MessageCrypto');

const CONTACT = 'c_anruf';
const SECRET = crypto.randomBytes(32).toString('base64');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const pcs = () => global.__callPcs || [];

function torConnection() {
  return {
    transport: 'tor', sharedSecret: SECRET, keyExchangeDone: true,
    dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' },
    pendingMsgs: [], close: jest.fn(),
    sendMessage: jest.fn(() => 'sent'),
  };
}
// Gesendete Anruf-Signale (entschluesselt) einer Verbindung.
function sentSignals(conn) {
  return conn.sendMessage.mock.calls
    .map((c) => JSON.parse(c[0]))
    .filter((m) => m.subtype === 'call_signal')
    .map((m) => ({ type: m.signal.type, payload: JSON.parse(decryptMsg(m.signal.payload.enc, SECRET, 'call-signal')) }));
}
async function signal(type, payload) {
  return { type, payload: { enc: await encryptMsg(JSON.stringify(payload), SECRET, 'call-signal') } };
}
function newCall(extra = {}) {
  const notices = [];
  const states = [];
  const cm = new CallManager({
    contactId: CONTACT, peerName: 'Kim',
    onNotice: (t) => notices.push(t), onStateChange: (s) => states.push(s), ...extra,
  });
  return { cm, notices, states };
}

let conn;
beforeEach(async () => {
  jest.clearAllMocks();
  global.__callPcs = [];
  RTCStore.resetAll();
  RTCStore.sharedSecrets.set(CONTACT, SECRET);
  await EncryptedStorage.clear();
  CM._resetConnectionModeForTests();
  conn = torConnection();
  RTCStore.connections.set(CONTACT, conn);
});

describe('Stufe 3: keine WebRTC-Medien', () => {
  beforeEach(async () => {
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
  });

  test('ausgehender Sprachanruf: Angebot ohne SDP, keine PeerConnection, kein Mikrofon ueber WebRTC', async () => {
    const { cm } = newCall();
    await cm.startCall();
    expect(cm.state).toBe(CallState.OUTGOING_RINGING);
    expect(pcs()).toHaveLength(0);
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const [offer] = sentSignals(conn);
    expect(offer).toEqual({ type: 'offer', payload: { channelOnly: true, video: false } });
    // Antwort der Gegenseite -> Sprache ueber den Kanal, ohne Zusatzsignal.
    await cm.handleSignal(await signal('answer', { channelOnly: true }));
    expect(cm.viaChannelAudio).toBe(true);
    expect(cm.state).toBe(CallState.ACTIVE);
    expect(NativeModules.MalachiCallAudio.start).toHaveBeenCalled();
    expect(sentSignals(conn).map((s) => s.type)).toEqual(['offer']);
    expect(pcs()).toHaveLength(0);
    cm.endCall('user_hangup');
  });

  test('Videoanruf wird mit klarem Hinweis abgelehnt - nichts gesendet, keine PeerConnection', async () => {
    const { cm, notices, states } = newCall({ video: true });
    await cm.startCall();
    expect(notices).toEqual([torOnlyVideoNotice()]);
    expect(notices[0]).toMatch(/Maximal anonym \(nur Tor\)/);
    expect(states).toContain(CallState.ENDED);
    expect(conn.sendMessage).not.toHaveBeenCalled();
    expect(pcs()).toHaveLength(0);
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  test('eingehender (Video-)Anruf mit normalem Angebot: Antwort ohne SDP, Sprache ueber den Kanal, Video mit Hinweis aus', async () => {
    const { cm, notices } = newCall();
    await cm.handleSignal(await signal('offer', { sdp: 'v=0 fremdes-angebot', video: true }));
    expect(cm.state).toBe(CallState.INCOMING_RINGING);
    // Kandidaten des Anrufers werden nie angewendet.
    await cm.handleSignal(await signal('ice', { candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.7 4000 typ host' } }));
    await cm.acceptCall();
    expect(pcs()).toHaveLength(0);
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const answer = sentSignals(conn).find((s) => s.type === 'answer');
    expect(answer.payload).toEqual({ channelOnly: true });
    expect(cm.viaChannelAudio).toBe(true);
    expect(cm.video).toBe(false);
    expect(notices.join(' ')).toMatch(/Video ist ausgeschaltet/);
    // Video einschalten geht nicht - mit Hinweis.
    await cm.toggleVideo();
    expect(notices[notices.length - 1]).toMatch(/nicht möglich/);
    expect(pcs()).toHaveLength(0);
    cm.endCall('user_hangup');
  });
});

describe('Gegenseite in Stufe 3', () => {
  test('Anrufer (Stufe 1) bekommt eine Antwort ohne SDP: eigene PeerConnection wird verworfen, Sprache ueber den Kanal', async () => {
    const { cm } = newCall();
    await cm.startCall();
    // Bei bestehender Verbindung klingelt es (vorher brach startCall hier
    // faelschlich ab, weil der Zustand noch IDLE war).
    expect(cm.state).toBe(CallState.OUTGOING_RINGING);
    expect(sentSignals(conn)[0]).toEqual({ type: 'offer', payload: { sdp: 'v=0 anruf-angebot', video: false } });
    expect(pcs()).toHaveLength(1);
    const pc = pcs()[0];
    await cm.handleSignal(await signal('answer', { channelOnly: true }));
    expect(pc.closed).toBe(true);
    expect(pc.remoteDescription).toBeNull();
    expect(cm.pc).toBeNull();
    expect(cm.viaChannelAudio).toBe(true);
    expect(sentSignals(conn).map((s) => s.type)).toEqual(['offer']);   // kein 'channel_audio' noetig
    cm.endCall('user_hangup');
  });

  test('Angerufener (Stufe 1) bekommt ein Angebot ohne SDP: nimmt ohne PeerConnection an', async () => {
    const { cm } = newCall();
    await cm.handleSignal(await signal('offer', { channelOnly: true, video: false }));
    await cm.acceptCall();
    expect(pcs()).toHaveLength(0);
    expect(sentSignals(conn).find((s) => s.type === 'answer').payload).toEqual({ channelOnly: true });
    expect(cm.viaChannelAudio).toBe(true);
    cm.endCall('user_hangup');
  });
});

describe('Wechsel auf Stufe 3 waehrend eines Anrufs', () => {
  test('laufender WebRTC-Anruf wechselt sofort auf den Kanal und sagt es der Gegenseite', async () => {
    const { cm } = newCall();
    await cm.startCall();
    const pc = pcs()[0];
    await cm.handleSignal(await signal('answer', { sdp: 'v=0 antwort' }));
    expect(cm.state).toBe(CallState.CONNECTING);
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange();
    expect(cm.state).toBe(CallState.ACTIVE);
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await tick(30);
    expect(pc.closed).toBe(true);
    expect(cm.viaChannelAudio).toBe(true);
    expect(sentSignals(conn).map((s) => s.type)).toContain('channel_audio');
    cm.endCall('user_hangup');
  });

  test('Wechsel mitten im Anrufaufbau: entstandene PeerConnection wird verworfen, Angebot geht ohne SDP raus', async () => {
    const { cm } = newCall();
    const realGetStream = cm._getLocalStream.bind(cm);
    jest.spyOn(cm, '_getLocalStream').mockImplementation(async () => {
      await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
      return realGetStream();
    });
    await cm.startCall();
    expect(pcs()).toHaveLength(1);
    expect(pcs()[0].closed).toBe(true);
    expect(cm.pc).toBeNull();
    expect(sentSignals(conn)).toEqual([{ type: 'offer', payload: { channelOnly: true, video: false } }]);
    expect(cm.state).toBe(CallState.OUTGOING_RINGING);
    cm.endCall('user_hangup');
  });

  test('nach Anrufende kein Abo mehr (ein spaeterer Wechsel beruehrt den beendeten Anruf nicht)', async () => {
    const { cm } = newCall();
    await cm.startCall();
    cm.endCall('user_hangup');
    const spy = jest.spyOn(cm, '_switchToChannelAudio');
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await tick(10);
    expect(spy).not.toHaveBeenCalled();
  });
});
