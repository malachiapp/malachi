// Anrufe ohne Server und ohne TURN (CallManager.js + RTCStore.js):
//   - Signalisierung laeuft ueber die bestehende, verschluesselte Verbindung
//     zum Kontakt, sobald eine steht (der Server erfaehrt nichts vom Anruf),
//   - empfangene Kanal-Signale/-Audiopakete werden richtig weitergereicht,
//   - klappt die WebRTC-Medienverbindung nicht, wechselt der Anruf auf
//     "Sprache ueber den Kanal" (nativ: MalachiCallAudioModule.kt).
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');
NativeModules.MalachiCallAudio = {
  addListener() {}, removeListeners() {},
  isSupported: jest.fn(async () => true),
  start: jest.fn(async () => true),
  stop: jest.fn(async () => true),
  play: jest.fn(),
  setMuted: jest.fn(),
};

// Kein Server-Client mehr: jeder Netzzugriff waere ein Fehler.
global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });

const RTCStore = require('../../RTCStore').default;
const CallManager = require('../../CallManager').default;
const { CallState } = require('../../CallManager');

const CONTACT = 'c_call';
const SECRET = crypto.randomBytes(32).toString('base64');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeChannelConnection() {
  return {
    transport: 'tor', sharedSecret: SECRET, keyExchangeDone: true,
    dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' },
    pendingMsgs: [], close: jest.fn(),
    sendMessage: jest.fn(() => 'sent'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  RTCStore.resetAll();
  RTCStore.sharedSecrets.set(CONTACT, SECRET);
});

test('steht eine Verbindung zum Kontakt, geht das Anruf-Signal ueber sie - nicht ueber den Server', async () => {
  const conn = fakeChannelConnection();
  RTCStore.connections.set(CONTACT, conn);
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
  cm.role = 'caller';
  expect(await cm._sendSignal({ type: 'cancel', payload: {} })).toBe(true);
  expect(conn.sendMessage).toHaveBeenCalledTimes(1);
  const msg = JSON.parse(conn.sendMessage.mock.calls[0][0]);
  expect(msg).toMatchObject({ type: 'system', subtype: 'call_signal', signal: { type: 'cancel' } });
  expect(typeof msg.signal.payload.enc).toBe('string');          // Inhalt zusaetzlich Ende-zu-Ende verschluesselt
  expect(global.fetch).not.toHaveBeenCalled();
});

test('ohne Verbindung zum Kontakt: ICE-/Ende-Signal geht nirgendwohin (kein Server-Umweg)', async () => {
  RTCStore.connectionEnsurer = jest.fn(async () => null);
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
  cm.role = 'caller';
  expect(await cm._sendSignal({ type: 'ice', payload: { candidate: {} } })).toBe(false);
  expect(await cm._sendSignal({ type: 'cancel', payload: {} }, { connect: false })).toBe(false);
  expect(RTCStore.connectionEnsurer).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  RTCStore.connectionEnsurer = null;
});

test('RTCStore reicht Kanal-Signale und Audiopakete weiter; ein Angebot ohne bereite App wird gepuffert', () => {
  const conn = fakeChannelConnection();
  RTCStore.setConnection(CONTACT, conn);
  const signals = [];
  const audio = [];
  RTCStore.callSignalHandler = (id, s) => signals.push([id, s.type]);
  RTCStore.callAudioHandler = (id, m) => audio.push([id, m.f.length]);
  conn.onMessage({ type: 'system', subtype: 'call_signal', signal: { type: 'answer', payload: {} } });
  conn.onMessage({ type: 'call_audio', s: 1, f: ['AAA', 'BBB', 'CCC'] });
  expect(signals).toEqual([[CONTACT, 'answer']]);
  expect(audio).toEqual([[CONTACT, 3]]);
  expect(RTCStore.buffer.has(CONTACT)).toBe(false);            // nichts davon landet im Chat

  RTCStore.callSignalHandler = null;
  conn.onMessage({ type: 'system', subtype: 'call_signal', signal: { type: 'offer', payload: {} } });
  const buffered = RTCStore.takeBufferedCallSignal(CONTACT);
  expect(buffered.signals.map((s) => s.type)).toEqual(['offer']);
  RTCStore.callAudioHandler = null;
});

test('Medienverbindung scheitert -> Sprache ueber den Kanal: Mikrofon nativ, Pakete gebuendelt und verschluesselt ueber die Verbindung, Gegenseite wird informiert', async () => {
  const conn = fakeChannelConnection();
  RTCStore.connections.set(CONTACT, conn);
  const states = [];
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev', onStateChange: (s) => states.push(s) });
  cm.role = 'caller';
  cm.state = CallState.CONNECTING;
  expect(await cm._switchToChannelAudio(true)).toBe(true);
  expect(NativeModules.MalachiCallAudio.start).toHaveBeenCalled();
  expect(cm.viaChannelAudio).toBe(true);
  expect(states).toContain(CallState.ACTIVE);
  const sent = conn.sendMessage.mock.calls.map((c) => JSON.parse(c[0]));
  expect(sent.some((m) => m.subtype === 'call_signal' && m.signal.type === 'channel_audio')).toBe(true);

  // Empfangene Pakete werden abgespielt
  RTCStore.callAudioHandler(CONTACT, { type: 'call_audio', f: ['QUJD', 'REVG'] });
  expect(NativeModules.MalachiCallAudio.play).toHaveBeenCalledTimes(2);
  // fremder Kontakt -> ignoriert
  RTCStore.callAudioHandler('c_fremd', { type: 'call_audio', f: ['QUJD'] });
  expect(NativeModules.MalachiCallAudio.play).toHaveBeenCalledTimes(2);

  cm.toggleMute(true);
  expect(NativeModules.MalachiCallAudio.setMuted).toHaveBeenCalledWith(true);
  cm.endCall('user_hangup');
  expect(NativeModules.MalachiCallAudio.stop).toHaveBeenCalled();
  expect(RTCStore.callAudioHandler).toBeNull();
});

test('ohne Verbindung zum Kontakt kein Wechsel (Anruf endet regulaer)', async () => {
  const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
  cm.state = CallState.CONNECTING;
  expect(await cm._switchToChannelAudio(true)).toBe(false);
  expect(NativeModules.MalachiCallAudio.start).not.toHaveBeenCalled();
});

test('laeuft die Verbindung schon ueber Tor, wechselt der Anruf sofort beim Verbinden (kein Warten)', async () => {
  jest.useFakeTimers();
  try {
    const conn = fakeChannelConnection();
    RTCStore.connections.set(CONTACT, conn);
    const cm = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
    const spy = jest.spyOn(cm, '_switchToChannelAudio').mockResolvedValue(true);
    cm.state = CallState.CONNECTING;
    cm._startConnectTimeout();
    jest.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledWith(true);

    const direct = { ...fakeChannelConnection(), transport: 'direct' };
    RTCStore.connections.set(CONTACT, direct);
    const cm2 = new CallManager({ contactId: CONTACT, peerName: 'Kev' });
    const spy2 = jest.spyOn(cm2, '_switchToChannelAudio').mockResolvedValue(true);
    cm2.state = CallState.CONNECTING;
    cm2._startConnectTimeout();
    jest.advanceTimersByTime(4000);
    expect(spy2).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1100);
    expect(spy2).toHaveBeenCalled();
    clearTimeout(cm.connectTimer); clearTimeout(cm2.connectTimer);
  } finally {
    jest.useRealTimers();
  }
});
