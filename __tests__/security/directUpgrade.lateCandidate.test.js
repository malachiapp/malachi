// STUN-Ausstieg, Luecke L3 (DirectUpgrade.js): spaet eintreffende Router-
// Freigaben werden als 'direct_cand' { id, cand } nachgereicht.
//   - eigene Seite: nur gueltige srflx-Router-Kandidaten, hoechstens 8, nur
//     unter der Aushandlungs-ID, nie in Stufe 3,
//   - Gegenseite: nur fuer die laufende Aushandlung mit derselben ID (Versuch
//     oder Neustart der Direktverbindung), nur gepruefte Kandidaten, nie in
//     Stufe 3; kommt der Kandidat vor dem Angebot an, wird er kurz gemerkt,
//   - RTCStore reicht das Signal nur an DirectUpgrade (nie an Chat/Puffer),
//   - aeltere Gegenseiten: unbekannte Signale brechen nichts,
//   - Sprachkanal (WP3a): Angebot und Antwort kuendigen ihn an (ach: 1).
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

jest.mock('../../WebRTCManager', () => {
  const actual = jest.requireActual('../../WebRTCManager');
  class FakeDirectRtc {
    constructor(onMessage, onConnected, onDisc) {
      this.onMessage = onMessage;
      this.onConnected = onConnected;
      this.onDisc = onDisc;
      this.transport = 'direct';
      this.keyExchangeDone = false;
      this._closed = false;
      this.pendingMsgs = [];
      this.dataChannel = { readyState: 'open', send: jest.fn() };
      this.pc = { iceConnectionState: 'connected' };
      this.sent = [];
      this.late = [];
      this.peerAudio = null;
      this.sendMessage = jest.fn((raw) => { this.sent.push(JSON.parse(raw)); return 'sent'; });
      this.createOffer = jest.fn(async () => JSON.stringify({ sdp: { type: 'offer', sdp: 'v=0 angebot' }, type: 'offer' }));
      this.createAnswerDirect = jest.fn(async () => JSON.stringify({ sdp: { type: 'answer', sdp: 'v=0 antwort' } }));
      this.handleAnswer = jest.fn(async () => {});
      this.createIceRestartOffer = jest.fn(async () => ({ type: 'offer', sdp: 'v=0 neustart' }));
      this.acceptIceRestartOffer = jest.fn(async () => ({ type: 'answer', sdp: 'v=0 neustart-antwort' }));
      this.acceptIceRestartAnswer = jest.fn(async () => true);
      this.addLateRemoteCandidate = jest.fn(async (id, cand) => { this.late.push({ id, cand }); return true; });
      this.setPeerAudioChannel = jest.fn((v) => { this.peerAudio = v; });
      this.close = jest.fn(() => { this._closed = true; this.dataChannel.readyState = 'closed'; });
      this._fireDisc = () => { if (!this._discFired) { this._discFired = true; this.onDisc?.(); } };
      (global.__fakeDirect = global.__fakeDirect || []).push(this);
    }
  }
  return { ...actual, WebRTCManager: FakeDirectRtc };
});

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const Tor = require('../../TorTransport');
const BG = require('../../BackgroundSync');
const DU = require('../../DirectUpgrade');
const CM = require('../../ConnectionMode');

const ONION_A = 'a'.repeat(56) + '.onion';   // kleinste -> wir bieten an
const ONION_B = 'b'.repeat(56) + '.onion';
const ONION_C = 'c'.repeat(56) + '.onion';
const CONTACT = { id: 'c_spaet', name: 'Peer', role: 'responder', torOnion: ONION_B };
const CAND = { candidate: 'candidate:natpmp10 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 192.168.178.61 rport 50001', sdpMid: '0', sdpMLineIndex: 0 };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const fakes = () => global.__fakeDirect || [];

function torConn() {
  const c = {
    transport: 'tor', keyExchangeDone: true, _closed: false, _lastActivity: Date.now(),
    dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' }, pendingMsgs: [], sent: [],
  };
  c.sendMessage = jest.fn((raw) => { c.sent.push(JSON.parse(raw)); return 'sent'; });
  c.close = jest.fn(() => { c._closed = true; c.dataChannel.readyState = 'closed'; });
  return c;
}
async function fromPeer(conn, msg) {
  conn.onMessage({ type: 'system', v: 1, ...msg });
  await tick(20);
}

let tor;
beforeEach(async () => {
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  global.__fakeDirect = [];
  DU._resetDirectUpgradeForTests();
  Tor._resetTorTransportForTests();
  BG._resetTorFallbackForTests();
  RTCStore.resetAll();
  await EncryptedStorage.clear();
  CM._resetConnectionModeForTests();
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
  Tor._setTorStateForTests({ status: 'ON', onion: ONION_A });
  tor = torConn();
  RTCStore.setConnection(CONTACT.id, tor);
});
afterEach(() => DU._resetDirectUpgradeForTests());

async function ourOffer() {
  await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
  await tick(20);
  const offer = tor.sent.find((m) => m.subtype === 'direct_offer');
  return { rtc: fakes()[0], offer };
}

describe('eigene Seite: spaete Freigabe nachreichen', () => {
  test('Angebot traegt die Aushandlungs-ID und ach: 1; die spaete Freigabe geht als direct_cand ueber Tor', async () => {
    const { rtc, offer } = await ourOffer();
    expect(rtc.createOffer).toHaveBeenCalledWith({ negotiationId: offer.id });
    expect(offer).toMatchObject({ ach: 1 });
    rtc.onLateCandidates([CAND], offer.id);
    await tick(20);
    expect(tor.sent.filter((m) => m.subtype === 'direct_cand')).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'direct_cand', id: offer.id, cand: CAND }),
    ]);
  });

  test('nur gueltige Router-Kandidaten, hoechstens 8, nur mit gueltiger ID', async () => {
    const { rtc, offer } = await ourOffer();
    const bad = { ...CAND, candidate: 'candidate:1 1 udp 2122260223 192.168.178.61 50001 typ host' };
    rtc.onLateCandidates([bad, ...Array.from({ length: 12 }, () => CAND)], offer.id);
    rtc.onLateCandidates([CAND], 'keine-gueltige-id!');
    await tick(20);
    const sent = tor.sent.filter((m) => m.subtype === 'direct_cand');
    expect(sent.length).toBe(7);                         // 8 geprueft, einer davon ungueltig
    expect(sent.every((m) => m.cand.candidate === CAND.candidate && m.id === offer.id)).toBe(true);
  });

  test('Stufe 3: nichts wird nachgereicht', async () => {
    const { rtc, offer } = await ourOffer();
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    tor.sent.length = 0;
    rtc.onLateCandidates([CAND], offer.id);
    await tick(20);
    expect(tor.sent.filter((m) => m.subtype === 'direct_cand')).toEqual([]);
  });
});

describe('Gegenseite: nur fuer die laufende Aushandlung', () => {
  test('passende ID -> angewendet; fremde ID, kaputter Kandidat -> verworfen; Antwort kuendigt Sprachkanal an', async () => {
    const { rtc, offer } = await ourOffer();
    await fromPeer(tor, { subtype: 'direct_answer', id: offer.id, sdp: { type: 'answer', sdp: 'v=0 x' }, ach: 1 });
    expect(rtc.setPeerAudioChannel).toHaveBeenCalledWith(true);
    await fromPeer(tor, { subtype: 'direct_cand', id: offer.id, cand: CAND });
    await fromPeer(tor, { subtype: 'direct_cand', id: 'f'.repeat(16), cand: CAND });
    await fromPeer(tor, { subtype: 'direct_cand', id: offer.id, cand: { ...CAND, candidate: CAND.candidate.replace('203.0.113.9', '10.0.0.9') } });
    await fromPeer(tor, { subtype: 'direct_cand', id: offer.id, cand: { ...CAND, candidate: CAND.candidate + ' generation 0' } });
    await fromPeer(tor, { subtype: 'direct_cand', id: offer.id, cand: 'candidate:pcp1 ...' });
    expect(rtc.late).toEqual([{ id: offer.id, cand: CAND }]);
    // Nichts davon landet im Chat oder Puffer.
    expect(RTCStore.buffer.has(CONTACT.id)).toBe(false);
  });

  test('alte Gegenseite ohne ach: kein Sprachkanal', async () => {
    const { rtc, offer } = await ourOffer();
    await fromPeer(tor, { subtype: 'direct_answer', id: offer.id, sdp: { type: 'answer', sdp: 'v=0 x' } });
    expect(rtc.setPeerAudioChannel).toHaveBeenCalledWith(false);
  });

  test('Kandidat vor dem Angebot (Signale laufen nebeneinander): kurz gemerkt, nach der Antwort angewendet; Antwort mit ach: 1', async () => {
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });   // Gegenseite bietet an
    const id = '1a2b3c4d5e6f7081';
    await fromPeer(tor, { subtype: 'direct_cand', id, cand: CAND });
    expect(fakes()).toHaveLength(0);
    await fromPeer(tor, { subtype: 'direct_offer', id, sdp: { type: 'offer', sdp: 'v=0 o' }, onion: ONION_B, ach: 1 });
    const rtc = fakes()[0];
    expect(rtc.createAnswerDirect).toHaveBeenCalledWith(JSON.stringify({ sdp: { type: 'offer', sdp: 'v=0 o' } }), { negotiationId: id });
    expect(rtc.setPeerAudioChannel).toHaveBeenCalledWith(true);
    expect(rtc.late).toEqual([{ id, cand: CAND }]);
    expect(tor.sent.find((m) => m.subtype === 'direct_answer')).toMatchObject({ id, ach: 1 });
  });

  test('gemerkter Kandidat einer anderen ID wird nicht auf ein spaeteres Angebot angewendet', async () => {
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });
    await fromPeer(tor, { subtype: 'direct_cand', id: '9'.repeat(16), cand: CAND });
    await fromPeer(tor, { subtype: 'direct_offer', id: '8'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 o' }, onion: ONION_B });
    expect(fakes()[0].late).toEqual([]);
  });

  test('ICE-Neustart: Neustart-Angebot/-Antwort tragen die ID; spaete Kandidaten gehen an die Direktverbindung', async () => {
    const { rtc, offer } = await ourOffer();
    rtc.keyExchangeDone = true;
    await rtc._onKeyExchange();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(rtc);
    // Gegenseite startet einen Neustart -> wir antworten mit ihrer ID.
    await fromPeer(rtc, { subtype: 'direct_offer', restart: true, id: '2'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 r' }, onion: ONION_B });
    expect(rtc.acceptIceRestartOffer).toHaveBeenCalledWith({ type: 'offer', sdp: 'v=0 r' }, { negotiationId: '2'.repeat(16) });
    await fromPeer(rtc, { subtype: 'direct_cand', id: '2'.repeat(16), cand: CAND });
    expect(rtc.late).toEqual([{ id: '2'.repeat(16), cand: CAND }]);
    // Unsere spaete Freigabe zum Neustart geht ueber die Direktverbindung selbst.
    rtc.onLateCandidates([CAND], '2'.repeat(16));
    await tick(20);
    expect(rtc.sent.filter((m) => m.subtype === 'direct_cand')).toHaveLength(1);
    expect(offer.id).not.toBe('2'.repeat(16));
  });

  test('Stufe 3: eingehende Kandidaten werden ignoriert', async () => {
    const { rtc, offer } = await ourOffer();
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await fromPeer(tor, { subtype: 'direct_cand', id: offer.id, cand: CAND });
    expect(rtc.late).toEqual([]);
  });
});

describe('Weiterleitung und Mischbetrieb', () => {
  test('RTCStore reicht direct_cand nur an DirectUpgrade (nie an Chat, Puffer oder Steuersignale)', async () => {
    const seen = [];
    RTCStore.upgradeSignalHandler = (id, m) => { seen.push(m.subtype); };
    RTCStore.setMessageListener(CONTACT.id, () => { throw new Error('darf nicht in den Chat'); });
    tor.onMessage({ type: 'system', subtype: 'direct_cand', id: '3'.repeat(16), cand: CAND });
    await tick(10);
    expect(seen).toEqual(['direct_cand']);
    RTCStore.setMessageListener(CONTACT.id, null);
    RTCStore.upgradeSignalHandler = DU.handleUpgradeSignal;
  });

  test('unbekannte Signale (aeltere/neuere Gegenseite) brechen nichts', async () => {
    expect(await DU.handleUpgradeSignal(CONTACT.id, { type: 'system', subtype: 'direct_unbekannt', id: '4'.repeat(16) })).toBeUndefined();
    expect(await DU.handleUpgradeSignal(CONTACT.id, { type: 'system', subtype: 'direct_cand' })).toBeUndefined();
  });
});
