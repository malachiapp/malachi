// Live-Test 2026-10-17: Anrufe brachen "wegen Mikrofon/Kamera" sofort ab.
//   1. Ohne Mikrofon-Berechtigung endete der Anruf kommentarlos (media_error) -
//      jetzt wird vorher gefragt; bei Ablehnung gibt es einen klaren Hinweis.
//   2. Annehmen, waehrend die Verbindung ueber Tor lief: der sofortige Wechsel
//      auf "Sprache ueber den Kanal" schloss die PeerConnection, waehrend das
//      Annehmen ihr noch das Mikrofon hinzufuegen wollte (addTrack of null) -
//      der laufende Anruf wurde dadurch beendet. Jetzt: ueber Tor direkt per
//      Kanal annehmen, ohne PeerConnection.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, PermissionsAndroid, Platform } = require('react-native');
NativeModules.MalachiCallAudio = {
  addListener() {}, removeListeners() {},
  isSupported: jest.fn(async () => true),
  start: jest.fn(async () => true),
  stop: jest.fn(async () => true),
  play: jest.fn(),
  setMuted: jest.fn(),
};
global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });

const RTCStore = require('../../RTCStore').default;
const CallManager = require('../../CallManager').default;
const { CallState } = require('../../CallManager');

const CONTACT = 'c_perm';
const SECRET = crypto.randomBytes(32).toString('base64');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function torConnection() {
  return {
    transport: 'tor', sharedSecret: SECRET, keyExchangeDone: true,
    dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' },
    pendingMsgs: [], close: jest.fn(),
    sendMessage: jest.fn(() => 'sent'),
  };
}

let checkSpy;
let requestSpy;
beforeEach(() => {
  jest.clearAllMocks();
  RTCStore.resetAll();
  RTCStore.sharedSecrets.set(CONTACT, SECRET);
  Platform.OS = 'android';
  checkSpy = jest.spyOn(PermissionsAndroid, 'check');
  requestSpy = jest.spyOn(PermissionsAndroid, 'request');
});
afterEach(() => {
  checkSpy.mockRestore();
  requestSpy.mockRestore();
});

test('Mikrofon fehlt und wird abgelehnt: Anruf startet nicht, klarer Hinweis statt stillem Abbruch', async () => {
  checkSpy.mockResolvedValue(false);
  requestSpy.mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
  RTCStore.connections.set(CONTACT, torConnection());
  const notices = [];
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev', onNotice: (t) => notices.push(t) });
  await cm.startCall();
  expect(requestSpy).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, expect.any(Object));
  expect(notices.join(' ')).toMatch(/Mikrofon/);
  expect([CallState.IDLE, CallState.ENDED]).toContain(cm.state);
  const sent = RTCStore.connections.get(CONTACT).sendMessage.mock.calls.map((c) => JSON.parse(c[0]));
  expect(sent.some((m) => m.subtype === 'call_signal' && m.signal?.type === 'offer')).toBe(false);
});

test('Videoanruf ohne Kamera-Berechtigung: laeuft als Sprachanruf weiter (mit Hinweis)', async () => {
  checkSpy.mockImplementation(async (p) => p === PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  requestSpy.mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
  const notices = [];
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev', video: true, onNotice: (t) => notices.push(t) });
  expect(await cm._ensureCallPermissions()).toBe(true);
  expect(cm.video).toBe(false);
  expect(notices.join(' ')).toMatch(/Kamera/);
});

test('Annehmen, waehrend die Verbindung ueber Tor laeuft: direkt per Kanal, keine PeerConnection, kein Abbruch', async () => {
  checkSpy.mockResolvedValue(true);
  const conn = torConnection();
  RTCStore.connections.set(CONTACT, conn);
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
  cm.role = 'callee';
  cm.state = CallState.INCOMING_RINGING;
  cm._incomingOffer = 'v=0';
  const createPc = jest.spyOn(cm, '_createPeerConnection');
  await cm.acceptCall();
  await tick();
  expect(createPc).not.toHaveBeenCalled();
  expect(cm.viaChannelAudio).toBe(true);
  expect(cm.state).toBe(CallState.ACTIVE);
  const sent = conn.sendMessage.mock.calls.map((c) => JSON.parse(c[0]));
  const answer = sent.find((m) => m.subtype === 'call_signal' && m.signal?.type === 'answer');
  expect(answer).toBeTruthy();
  expect(sent.some((m) => m.subtype === 'call_signal' && m.signal?.type === 'end')).toBe(false);
  cm.endCall('user_hangup');
});

test('Wettlauf: hat der Kanal waehrend des Annehmens uebernommen, beendet ein spaeterer Fehler den Anruf nicht', async () => {
  checkSpy.mockResolvedValue(true);
  const conn = { ...torConnection(), transport: 'direct' };
  RTCStore.connections.set(CONTACT, conn);
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
  cm.role = 'callee';
  cm.state = CallState.INCOMING_RINGING;
  cm._incomingOffer = 'v=0';
  jest.spyOn(cm, '_createPeerConnection').mockResolvedValue({ addTrack() {}, close() {} });
  jest.spyOn(cm, '_getLocalStream').mockImplementation(async () => {
    // Waehrenddessen uebernimmt der Kanal (wie der 0-ms-Timer ueber Tor).
    cm.viaChannelAudio = true;
    cm.pc = null;
    return { getTracks: () => [{ kind: 'audio' }] };
  });
  const endSpy = jest.spyOn(cm, 'endCall');
  await cm.acceptCall();
  expect(endSpy).not.toHaveBeenCalled();
});

// Audit 2026-10-19: Die System-Benachrichtigung zeigt nicht, dass ein Anruf ein
// Videoanruf ist - wer dort "Annehmen" tippt, darf nicht ungefragt die Kamera
// senden. In der App angenommen bleibt es ein Videoanruf.
describe('Videoanruf annehmen: Kamera nur, wenn in der App angenommen', () => {
  async function annehmen(fromNative) {
    checkSpy.mockResolvedValue(true);
    RTCStore.connections.set(CONTACT, { ...torConnection(), transport: 'direct' });
    const states = [];
    const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev', onVideoStateChange: (eigen, gegen) => states.push([eigen, gegen]) });
    cm.role = 'callee';
    cm.state = CallState.INCOMING_RINGING;
    cm._incomingOffer = 'v=0';
    cm.video = true;
    cm.remoteVideo = true;
    jest.spyOn(cm, '_createPeerConnection').mockResolvedValue({ addTrack() {}, close() {}, setRemoteDescription: async () => {}, createAnswer: async () => ({ sdp: 'a' }), setLocalDescription: async () => {} });
    const lokal = jest.spyOn(cm, '_getLocalStream').mockImplementation(async () => ({ getTracks: () => [] }));
    jest.spyOn(cm, '_sendSignal').mockResolvedValue(true);
    await cm.acceptCall(fromNative);
    return { cm, lokal, states };
  }

  test('ueber die System-Benachrichtigung: ohne eigene Kamera, Bild der Gegenseite bleibt', async () => {
    const { cm, lokal, states } = await annehmen(true);
    expect(lokal).toHaveBeenCalled();
    expect(cm.video).toBe(false);
    expect(cm.remoteVideo).toBe(true);
    expect(states[0]).toEqual([false, true]);
    await cm.endCall('test', true);
  });

  test('in der App angenommen: Videoanruf mit Kamera', async () => {
    const { cm } = await annehmen(false);
    expect(cm.video).toBe(true);
    await cm.endCall('test', true);
  });
});
