// STUN-Ausstieg WP3a: Sprache ueber die bestehende Direktverbindung in einem
// eigenen DataChannel 'malachi-audio' (ungeordnet, ohne Neusenden).
//   - eingehende Kanaele werden nach Label getrennt: der Sprachkanal ersetzt
//     nie den Chat-Kanal (vorher uebernahm JEDER weitere Kanal den Chat),
//   - geoeffnet wird er nur, wenn die Gegenseite ihn angekuendigt hat (ach: 1)
//     und die Verbindung direkt ist (nie ueber Tor), sonst Rueckfall auf den
//     normalen Weg,
//   - Pakete sind verschluesselt wie jede Nachricht; auf dem Sprachkanal
//     wird nur verschluesseltes 'call_audio' angenommen,
//   - sein Ende beendet nicht die Verbindung; close() schliesst ihn mit.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

jest.mock('react-native-webrtc', () => {
  class Chan {
    constructor(label, opts) { this.label = label; this.opts = opts; this.readyState = 'open'; this.sent = []; }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 'closed'; this.onclose?.(); }
  }
  class MockPC {
    constructor(config) {
      this.config = config;
      this.iceGatheringState = 'complete';
      this.iceConnectionState = 'new';
      this.channels = [];
      (global.__pcs = global.__pcs || []).push(this);
    }
    createDataChannel(label, opts) { const c = new Chan(label, opts); this.channels.push(c); return c; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=mid:0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=mid:0\r\n' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {}
    close() { this.closed = true; }
  }
  global.__Chan = Chan;
  return {
    RTCPeerConnection: MockPC,
    RTCSessionDescription: class { constructor(i) { Object.assign(this, i); } },
    RTCIceCandidate: class {},
    MediaStream: class {},
    MediaStreamTrack: class {},
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    registerGlobals: () => {},
  };
});

const { decryptMsg } = require('../../MessageCrypto');
const W = require('../../WebRTCManager');
const RTCStore = require('../../RTCStore').default;

const SECRET = crypto.randomBytes(32).toString('base64');
const OTHER = crypto.randomBytes(32).toString('base64');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const pcs = () => global.__pcs || [];

beforeEach(() => { global.__pcs = []; RTCStore.resetAll(); });

async function answerer(received = []) {
  const rtc = new W.WebRTCManager((m) => received.push(m), () => {}, () => {});
  await rtc.createAnswerDirect(JSON.stringify({ sdp: { type: 'offer', sdp: 'v=0\r\n' } }), { negotiationId: 'a1b2c3d4e5f60718' });
  return rtc;
}

test('Antwortseite: Chat-Kanal wie bisher, der Sprachkanal ersetzt ihn nie', async () => {
  const rtc = await answerer();
  const pc = pcs()[0];
  const chat = new global.__Chan('malachi');
  pc.ondatachannel({ channel: chat });
  expect(rtc.dataChannel).toBe(chat);
  const audio = new global.__Chan(W.AUDIO_CHANNEL_LABEL);
  pc.ondatachannel({ channel: audio });
  expect(rtc.dataChannel).toBe(chat);
  expect(rtc.audioChannel).toBe(audio);
  rtc.close();
});

test('Anbieterseite: von der Gegenseite geoeffnete Kanaele - nur der Sprachkanal zaehlt, ein fremder ersetzt den Chat nicht', async () => {
  const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
  await rtc.createOffer({ negotiationId: 'b1b2c3d4e5f60718' });
  const pc = pcs()[0];
  const chat = rtc.dataChannel;
  expect(chat.label).toBe('malachi');
  pc.ondatachannel({ channel: new global.__Chan('malachi') });
  expect(rtc.dataChannel).toBe(chat);
  const audio = new global.__Chan(W.AUDIO_CHANNEL_LABEL);
  pc.ondatachannel({ channel: audio });
  expect(rtc.audioChannel).toBe(audio);
  rtc.close();
});

test('Senden: nur direkt, mit Schluessel und Ankuendigung der Gegenseite - sonst Rueckfall (false)', async () => {
  const rtc = await answerer();
  const pkt = { type: 'call_audio', s: 1, f: ['QUJD', 'REVG', 'R0hJ'] };
  expect(rtc.sendCallAudio(pkt)).toBe(false);                 // kein Schluessel
  rtc.sharedSecret = SECRET;
  expect(rtc.sendCallAudio(pkt)).toBe(false);                 // Gegenseite ohne ach (z. B. 1.1.0)
  expect(pcs()[0].channels).toEqual([]);                      // dann wird auch kein Kanal geoeffnet
  rtc.setPeerAudioChannel(true);
  expect(rtc.sendCallAudio({ type: 'text', text: 'hallo' })).toBe(false);   // nur Sprachpakete
  expect(rtc.sendCallAudio(pkt)).toBe(true);
  const ch = pcs()[0].channels[0];
  expect(ch.label).toBe(W.AUDIO_CHANNEL_LABEL);
  expect(ch.opts).toEqual({ ordered: false, maxRetransmits: 0 });
  await tick();
  expect(ch.sent).toHaveLength(1);
  const wire = JSON.parse(ch.sent[0]);
  expect(wire.type).toBe('encrypted');
  expect(ch.sent[0]).not.toMatch(/call_audio|QUJD/);           // nichts im Klartext
  const inner = JSON.parse(decryptMsg(wire.data, SECRET));
  expect(inner).toMatchObject(pkt);
  // feste Groesse wie jede Nachricht (Uniformitaet)
  expect(inner.p).toBeDefined();
  rtc.close();
  expect(rtc.sendCallAudio(pkt)).toBe(false);

  const tor = new W.WebRTCManager(() => {}, () => {}, () => {});
  tor.attachTorChannel({ readyState: 'open', send() {}, close() {} }, true);
  tor.sharedSecret = SECRET;
  tor.setPeerAudioChannel(true);
  expect(tor.sendCallAudio(pkt)).toBe(false);                 // ueber Tor bleibt es beim Chat-Kanal
  tor.close();
});

test('Empfang: nur verschluesseltes call_audio mit dem Schluessel dieser Verbindung', async () => {
  const received = [];
  const rtc = await answerer(received);
  rtc.sharedSecret = SECRET;
  const audio = new global.__Chan(W.AUDIO_CHANNEL_LABEL);
  pcs()[0].ondatachannel({ channel: audio });
  const seal = async (obj, secret = SECRET) => W.sealForConnection({ sharedSecret: secret }, obj);

  audio.onmessage({ data: await seal({ type: 'call_audio', s: 7, f: ['QUJD'] }) });
  await tick();
  expect(received).toEqual([{ type: 'call_audio', s: 7, f: ['QUJD'] }]);

  // Alles andere wird verworfen: andere Typen, Klartext, falscher Schluessel, Unsinn.
  audio.onmessage({ data: await seal({ type: 'text', text: 'eingeschleust', time: Date.now() }) });
  audio.onmessage({ data: await seal({ type: 'system', subtype: 'delete_chat', ts: Date.now() }) });
  audio.onmessage({ data: JSON.stringify({ type: 'call_audio', s: 8, f: ['QUJD'] }) });
  audio.onmessage({ data: await seal({ type: 'call_audio', s: 9, f: ['QUJD'] }, OTHER) });
  audio.onmessage({ data: 'kein json' });
  audio.onmessage({ data: 'x'.repeat(20000) });
  await tick();
  expect(received).toHaveLength(1);
  rtc.close();
});

test('Ende des Sprachkanals beendet die Verbindung nicht; close() schliesst ihn mit', async () => {
  const disc = jest.fn();
  const rtc = new W.WebRTCManager(() => {}, () => {}, disc);
  await rtc.createAnswerDirect(JSON.stringify({ sdp: { type: 'offer', sdp: 'v=0\r\n' } }));
  rtc.sharedSecret = SECRET;
  rtc.setPeerAudioChannel(true);
  const chat = new global.__Chan('malachi');
  pcs()[0].ondatachannel({ channel: chat });
  rtc.sendCallAudio({ type: 'call_audio', s: 1, f: ['QUJD'] });
  const own = rtc.audioChannel;
  own.close();
  expect(disc).not.toHaveBeenCalled();
  expect(rtc._closed).toBe(false);
  expect(rtc.audioChannel).toBeNull();
  // Neuer Kanal bei Bedarf, aber begrenzt (kein Endlos-Oeffnen).
  rtc.sendCallAudio({ type: 'call_audio', s: 2, f: ['QUJD'] });
  rtc.audioChannel.close();
  rtc.sendCallAudio({ type: 'call_audio', s: 3, f: ['QUJD'] });
  expect(pcs()[0].channels).toHaveLength(2);
  const remote = new global.__Chan(W.AUDIO_CHANNEL_LABEL);
  pcs()[0].ondatachannel({ channel: remote });
  rtc.close();
  expect(remote.readyState).toBe('closed');
});

test('RTCStore.sendCallAudio: Sprachkanal, sonst wie jede Nachricht; CallManager nutzt es', () => {
  const viaAudio = { sendCallAudio: jest.fn(() => true), sendMessage: jest.fn(() => 'sent'), close() {} };
  RTCStore.connections.set('c_a', viaAudio);
  expect(RTCStore.sendCallAudio('c_a', { type: 'call_audio', s: 1, f: [] })).toBe('audio');
  expect(viaAudio.sendMessage).not.toHaveBeenCalled();
  const fallback = { sendCallAudio: jest.fn(() => false), sendMessage: jest.fn(() => 'sent'), close() {} };
  RTCStore.connections.set('c_b', fallback);
  expect(RTCStore.sendCallAudio('c_b', { type: 'call_audio', s: 1, f: ['QUJD'] })).toBe('sent');
  expect(JSON.parse(fallback.sendMessage.mock.calls[0][0])).toEqual({ type: 'call_audio', s: 1, f: ['QUJD'] });
  const old = { sendMessage: jest.fn(() => 'sent'), close() {} };   // Tor-Kanal ohne Sprachkanal
  RTCStore.connections.set('c_c', old);
  expect(RTCStore.sendCallAudio('c_c', { type: 'call_audio', s: 1, f: [] })).toBe('sent');
  expect(RTCStore.sendCallAudio('c_fehlt', { type: 'call_audio' })).toBe(false);
  const cm = fs.readFileSync(path.join(__dirname, '..', '..', 'CallManager.js'), 'utf8');
  expect(cm).toMatch(/RTCStore\.sendCallAudio\(this\.contactId, \{ type: 'call_audio', s: this\._audioSeq\+\+, f \}\)/);
  expect(cm).not.toMatch(/RTCStore\.sendMessage\(this\.contactId, JSON\.stringify\(\{ type: 'call_audio'/);
});
