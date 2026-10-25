// STUN-Ausstieg, Luecke L1: Anruf-PeerConnections (1:1 und Gruppe) fragen den
// eigenen Router um eine Portfreigabe - ohne STUN ist er die einzige Quelle
// einer oeffentlichen IPv4-Adresse. (Bis 1.1.0 nutzten nur Chat-
// Verbindungen die Freigabe; lief der Chat nur dank ihr direkt, scheiterte
// die Anruf-PC und Gruppenpaare waren "nicht erreichbar".)
//   - Nach dem Sammeln (Kandidat null) bzw. spaetestens nach 3 s wird der
//     Router fuer die Host-Kandidaten gefragt; erfolgreiche IPv4-Freigaben
//     gehen als normale Trickle-Kandidaten an die Gegenseite - auch wenn der
//     Router spaet antwortet.
//   - Beim Auflegen/Schliessen werden die Freigaben geloescht, auch eine,
//     die erst danach eintrifft (dann wird auch nichts mehr gesendet).
//   - Stufe 3 ("nur Tor"): der Router wird nie gefragt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const { CallPortMapper } = require('../../PortMapping');
const CM = require('../../ConnectionMode');
const RTCStore = require('../../RTCStore').default;
const CallManager = require('../../CallManager').default;
const { CallState } = require('../../CallManager');

const ROOT = path.join(__dirname, '..', '..');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const HOSTS = [
  { candidate: 'candidate:1 1 udp 2122260223 192.168.178.61 50001 typ host generation 0 ufrag abcd', sdpMid: '0', sdpMLineIndex: 0 },
  { candidate: 'candidate:2 1 udp 2122194687 2001:db8:1:2::61 50002 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 },
  { candidate: 'candidate:3 1 udp 2122260223 192.168.178.61 50003 typ host generation 0', sdpMid: '1', sdpMLineIndex: 1 },
  { candidate: 'candidate:4 1 udp 2122260223 fe80::1 50004 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 },
];
const ROW = (m) => (m.address.includes(':')
  ? { result: 'SUCCESS', method: 'pcp', externalAddress: m.address, externalPort: m.port }
  : { result: 'SUCCESS', method: 'natpmp', externalAddress: '203.0.113.9', externalPort: 40000 + (m.port % 1000) });

function installPcp({ delayMs = 0, row = ROW } = {}) {
  const calls = [];
  NativeModules.MalachiPcp = {
    map: jest.fn((mappings, lifetime) => {
      calls.push({ mappings, lifetime });
      const out = lifetime === 0 ? mappings.map((m) => ({ ...m, result: 'SUCCESS' })) : mappings.map((m) => ({ ...m, ...row(m) }));
      return new Promise((r) => setTimeout(() => r(out), lifetime === 0 ? 0 : delayMs));
    }),
  };
  return calls;
}

beforeEach(async () => {
  jest.useRealTimers();
  await EncryptedStorage.clear();
  CM._resetConnectionModeForTests();
  RTCStore.resetAll();
});
// endCall setzt nach 500 ms auf IDLE (mit Logzeile) - abwarten.
afterAll(async () => { await tick(600); delete NativeModules.MalachiPcp; });

describe('CallPortMapper (gemeinsam fuer 1:1- und Gruppenanrufe)', () => {
  test('nach dem Sammeln: Router fuer die sinnvollen Host-Kandidaten fragen, IPv4-Freigaben als Trickle-Kandidaten senden', async () => {
    const calls = installPcp();
    const sent = [];
    const m = new CallPortMapper((c) => sent.push(c));
    for (const h of HOSTS) m.onCandidate(h);
    expect(calls).toEqual([]);                 // erst nach dem Sammeln
    m.onCandidate(null);
    await tick(20);
    expect(calls[0].lifetime).toBe(3600);
    expect(calls[0].mappings).toEqual([
      { protocol: 'udp', address: '192.168.178.61', port: 50001 },
      { protocol: 'udp', address: '2001:db8:1:2::61', port: 50002 },
      { protocol: 'udp', address: '192.168.178.61', port: 50003 },
    ]);
    // IPv6-Pinhole: kein eigener Kandidat; IPv4: srflx mit passender sdpMid.
    expect(sent).toEqual([
      { candidate: 'candidate:natpmp0 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 192.168.178.61 rport 50001', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'candidate:natpmp2 1 udp 1686052607 203.0.113.9 40003 typ srflx raddr 192.168.178.61 rport 50003', sdpMid: '1', sdpMLineIndex: 1 },
    ]);
    expect(m.session.mappings).toHaveLength(3);
    m.release();
    await tick(5);
    expect(calls.find((c) => c.lifetime === 0).mappings).toHaveLength(3);
    expect(m.session.mappings).toBeNull();
  });

  test('Router antwortet spaet: der Kandidat wird trotzdem nachgeschickt (Trickle)', async () => {
    installPcp({ delayMs: 1700 });
    const sent = [];
    const m = new CallPortMapper((c) => sent.push(c));
    m.onCandidate(HOSTS[0]);
    m.onCandidate(null);
    await tick(1600);
    expect(sent).toEqual([]);
    await tick(250);
    expect(sent).toHaveLength(1);
    m.release();
  });

  test('Auflegen bevor der Router antwortet: Freigabe wird sofort wieder geloescht, nichts gesendet', async () => {
    const calls = installPcp({ delayMs: 60 });
    const sent = [];
    const m = new CallPortMapper((c) => sent.push(c));
    m.onCandidate(HOSTS[0]);
    m.onCandidate(null);
    await tick(5);
    m.release();
    await tick(100);
    expect(sent).toEqual([]);
    expect(calls.filter((c) => c.lifetime === 0)).toHaveLength(1);
    expect(m.session.mappings).toBeNull();
  });

  test('kommt kein "Sammeln fertig", wird spaetestens nach 3 s gefragt', async () => {
    jest.useFakeTimers();
    const calls = installPcp();
    const m = new CallPortMapper(() => {});
    m.onCandidate(HOSTS[0]);
    jest.advanceTimersByTime(2900);
    expect(calls).toHaveLength(0);
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    m.release();
    jest.useRealTimers();
  });

  test('nicht erlaubt (Stufe 3) oder kein Router-Modul: keine Anfrage, nichts gesendet', async () => {
    const calls = installPcp();
    const sent = [];
    const m = new CallPortMapper((c) => sent.push(c), { isAllowed: async () => false });
    m.onCandidate(HOSTS[0]);
    m.onCandidate(null);
    await tick(20);
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    delete NativeModules.MalachiPcp;
    const m2 = new CallPortMapper((c) => sent.push(c));
    m2.onCandidate(HOSTS[0]);
    m2.onCandidate(null);
    await tick(20);
    expect(sent).toEqual([]);
  });
});

describe('1:1-Anruf (CallManager)', () => {
  const SECRET = crypto.randomBytes(32).toString('base64');
  function setupCall() {
    RTCStore.sharedSecrets.set('c_pm', SECRET);
    const cm = new CallManager({ contactId: 'c_pm', peerName: 'Kev' });
    cm.role = 'caller';
    const signals = [];
    cm._sendSignal = jest.fn(async (s) => { signals.push(s); return true; });
    return { cm, signals };
  }

  test('Router-Freigabe kommt als zusaetzliches "ice"-Signal; beim Auflegen geloescht', async () => {
    const calls = installPcp();
    const { cm, signals } = setupCall();
    const pc = await cm._createPeerConnection();
    cm.pc = pc;
    for (const h of HOSTS.slice(0, 2)) pc.onicecandidate({ candidate: h });
    pc.onicecandidate({ candidate: null });
    await tick(30);
    const ice = signals.filter((s) => s.type === 'ice').map((s) => s.payload.candidate.candidate);
    expect(ice).toEqual([
      HOSTS[0].candidate, HOSTS[1].candidate,
      'candidate:natpmp0 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 192.168.178.61 rport 50001',
    ]);
    cm.state = CallState.CONNECTING;
    cm.endCall('user_hangup');
    await tick(5);
    expect(calls.filter((c) => c.lifetime === 0)).toHaveLength(1);
    expect(cm._portMapper).toBeNull();
  });

  test('nach dem Wechsel auf "Sprache ueber den Kanal" werden keine Router-Kandidaten mehr gesendet', async () => {
    installPcp({ delayMs: 40 });
    const { cm, signals } = setupCall();
    const pc = await cm._createPeerConnection();
    cm.pc = pc;
    pc.onicecandidate({ candidate: HOSTS[0] });
    pc.onicecandidate({ candidate: null });
    cm.viaChannelAudio = true;
    cm._closePeerConnection();
    await tick(80);
    expect(signals.filter((s) => s.type === 'ice').map((s) => s.payload.candidate.candidate)).toEqual([HOSTS[0].candidate]);
  });

  test('Stufe 3 ("nur Tor"): keine PeerConnection, der Router wird nie gefragt', async () => {
    const calls = installPcp();
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    const { cm } = setupCall();
    await expect(cm._createPeerConnection()).rejects.toMatchObject({ name: 'TorOnlyModeError' });
    await tick(20);
    expect(calls).toEqual([]);
  });
});

describe('Gruppenanruf (GroupCallManager) - Verdrahtung', () => {
  test('je Paar ein CallPortMapper (nur ausserhalb von Stufe 3), Freigaben beim Schliessen des Paars geloescht', () => {
    const src = fs.readFileSync(path.join(ROOT, 'GroupCallManager.js'), 'utf8').replace(/\r\n/g, '\n');
    const create = src.slice(src.indexOf('async function createPc(c, p) {'), src.indexOf('function pairError('));
    expect(create).toMatch(/const mapper = new CallPortMapper\(\(candidate\) => \{/);
    expect(create).toMatch(/sendPair\(c, p\.mid, 'ice', \{ c: json \}\)/);
    expect(create).toMatch(/isAllowed: async \(\) => \(await connectionModeForDecision\(\)\) !== MODE_TOR_ONLY/);
    expect(create).toMatch(/mapper\.onCandidate\(event\?\.candidate \|\| null\)/);
    const close = src.slice(src.indexOf('function closePeerConnection(p) {'), src.indexOf('function closePeer(c, mid) {'));
    expect(close).toMatch(/if \(p\.portMapper\) \{ try \{ p\.portMapper\.release\(\); \} catch \{\} p\.portMapper = null; \}/);
  });
});
