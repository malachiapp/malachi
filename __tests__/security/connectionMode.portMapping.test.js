// Portfreigabe am Heimrouter mit Ersatzprotokollen (native Seite
// MalachiPcpModule.kt: PCP, dann NAT-PMP, dann UPnP-IGD - hier gemockt) und
// Verbindungsweg (ConnectionMode.js):
//   - NAT-PMP- und UPnP-Ergebnisse werden wie PCP zu srflx-Kandidaten,
//   - Freigaben werden erneuert und beim Schliessen geloescht (das native
//     Modul nimmt dafuer dasselbe Protokoll); spaet eintreffende Freigaben
//     werden nie verwaist,
//   - Stufe 2 "Privat (ohne STUN)": keine ICE-Server, laengeres Warten auf den
//     Router (er ist dort die einzige Quelle der oeffentlichen IPv4),
//   - Stufe 3: keine PeerConnection, keine Anfrage an den Router,
//   - Hole Punching: die Antwortseite startet ihre ICE-Pruefungen (Angebot und
//     eigene Beschreibung angewendet) BEVOR sie auf den Router wartet und
//     antwortet; die Anbieterseite wendet die Antwort sofort an.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');

jest.mock('react-native-webrtc', () => {
  class MockPC {
    constructor(config) {
      this.config = config;
      this.iceGatheringState = 'complete';
      this.iceConnectionState = 'new';
      this.signalingState = 'stable';
      this.localDescription = null;
      this.remoteDescription = null;
      (global.__pcs = global.__pcs || []).push(this);
    }
    createDataChannel() { return { readyState: 'connecting', send() {}, close() {} }; }
    async createOffer() { return { type: 'offer', sdp: global.__localSdp }; }
    async createAnswer() { return { type: 'answer', sdp: global.__localSdp }; }
    async setLocalDescription(d) { global.__events.push('setLocalDescription:' + d.type); this.localDescription = d; }
    async setRemoteDescription(d) { global.__events.push('setRemoteDescription:' + d.type); this.remoteDescription = d; }
    async addIceCandidate() {}
    close() { this.closed = true; }
  }
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

const EncryptedStorage = require('react-native-encrypted-storage').default;
const W = require('../../WebRTCManager');
const CM = require('../../ConnectionMode');
const { STUN_POOL } = require('../../AppConfig');

const SDP = [
  'v=0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=candidate:1 1 udp 2122260223 192.168.178.61 50001 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 2001:db8:1:2::61 50002 typ host generation 0',
  'a=candidate:6 1 tcp 1518214911 192.168.178.61 50005 typ host tcptype passive generation 0',
  'a=end-of-candidates',
  '',
].join('\r\n');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const pcs = () => global.__pcs || [];
const ORIGINAL_WAIT = { ...W.PORT_MAPPING_MAX_WAIT_MS };

// Natives Modul: liefert je Anfrage die vorgegebenen Zeilen (optional verzoegert).
function installPcpMock({ rows, delayMs = 0 } = {}) {
  const calls = [];
  NativeModules.MalachiPcp = {
    map: jest.fn((mappings, lifetime) => {
      calls.push({ mappings, lifetime });
      global.__events.push('pcp.map:' + lifetime);
      const out = lifetime === 0
        ? mappings.map((m) => ({ ...m, result: 'SUCCESS' }))
        : mappings.map((m, i) => ({ ...m, ...(typeof rows === 'function' ? rows(m, i) : (rows?.[i] || { result: 'TIMEOUT' })) }));
      return new Promise((r) => setTimeout(() => r(out), lifetime === 0 ? 0 : delayMs));
    }),
  };
  return calls;
}

const NATPMP_UPNP_ROWS = [
  { result: 'SUCCESS', method: 'natpmp', externalAddress: '203.0.113.9', externalPort: 40001, lifetime: 3600, attempts: 'pcp:TIMEOUT' },
  { result: 'NOT_AUTHORIZED', attempts: 'pcp:NOT_AUTHORIZED' },
  { result: 'SUCCESS', method: 'upnp', externalAddress: '203.0.113.9', externalPort: 50005, lifetime: 3600, attempts: 'pcp:TIMEOUT,natpmp:TIMEOUT' },
];

beforeEach(async () => {
  global.__pcs = [];
  global.__events = [];
  global.__localSdp = SDP;
  await EncryptedStorage.clear();
  CM._resetConnectionModeForTests();
  Object.assign(W.PORT_MAPPING_MAX_WAIT_MS, ORIGINAL_WAIT);
});
afterAll(() => {
  delete NativeModules.MalachiPcp;
});

describe('NAT-PMP-/UPnP-Ergebnisse werden zu Kandidaten', () => {
  test('addMappedCandidates: gleiche Ergebnisform wie PCP, Kennung je Protokoll; IPv6/Fehlschlag/private Adressen nicht', () => {
    const out = W.addMappedCandidates(SDP, [
      { protocol: 'udp', address: '192.168.178.61', port: 50001, ...NATPMP_UPNP_ROWS[0] },
      { protocol: 'udp', address: '2001:db8:1:2::61', port: 50002, ...NATPMP_UPNP_ROWS[1] },
      { protocol: 'tcp', address: '192.168.178.61', port: 50005, ...NATPMP_UPNP_ROWS[2] },
      { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'SUCCESS', method: 'upnp', externalAddress: '100.64.0.9', externalPort: 40002 },
      { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'SUCCESS', method: 'natpmp', externalAddress: 'evil.example', externalPort: 40003 },
    ]);
    const lines = out.split('\r\n');
    expect(lines).toContain('a=candidate:natpmp0 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 192.168.178.61 rport 50001');
    expect(lines).toContain('a=candidate:upnp2 1 tcp 1686052607 203.0.113.9 50005 typ srflx raddr 192.168.178.61 rport 50005 tcptype passive');
    expect(out).not.toMatch(/100\.64\.0\.9|evil\.example/);
    expect(lines[lines.indexOf('a=end-of-candidates') - 1]).toMatch(/^a=candidate:upnp2 /);
  });

  test('Angebot enthaelt die Router-Kandidaten; Status nennt das Protokoll; Erneuern und Loeschen beim Schliessen', async () => {
    const calls = installPcpMock({ rows: NATPMP_UPNP_ROWS });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    const { sdp } = JSON.parse(await rtc.createOffer());
    expect(sdp.sdp).toMatch(/a=candidate:natpmp0 1 udp 1686052607 203\.0\.113\.9 40001 typ srflx/);
    expect(sdp.sdp).toMatch(/a=candidate:upnp1 1 tcp 1686052607 203\.0\.113\.9 50005 typ srflx .* tcptype passive/);
    expect(W.getPortMappingStatus()).toMatchObject({ result: 'SUCCESS', method: 'natpmp' });
    expect(calls[0].mappings).toEqual([
      { protocol: 'udp', address: '192.168.178.61', port: 50001 },
      { protocol: 'udp', address: '2001:db8:1:2::61', port: 50002 },
      { protocol: 'tcp', address: '192.168.178.61', port: 50005 },
    ]);
    expect(rtc._pcpMappings).toEqual([
      { protocol: 'udp', address: '192.168.178.61', port: 50001 },
      { protocol: 'tcp', address: '192.168.178.61', port: 50005 },
    ]);
    rtc.close();
    await tick(10);
    // Geloescht wird genau das Freigegebene (das native Modul waehlt dafuer
    // NAT-PMP bzw. UPnP - wie beim Anlegen).
    const del = calls.find((c) => c.lifetime === 0);
    expect(del.mappings).toEqual([
      { protocol: 'udp', address: '192.168.178.61', port: 50001 },
      { protocol: 'tcp', address: '192.168.178.61', port: 50005 },
    ]);
    expect(rtc._pcpMappings).toBeNull();
  });

  test('Router meldet "nicht erlaubt" (FritzBox ohne Selbststaendige Portfreigaben): Status NOT_AUTHORIZED, kein Kandidat', async () => {
    installPcpMock({ rows: () => ({ result: 'NOT_AUTHORIZED', attempts: 'pcp:NOT_AUTHORIZED,upnp:NOT_AUTHORIZED' }) });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    const { sdp } = JSON.parse(await rtc.createOffer());
    expect(sdp.sdp).not.toMatch(/typ srflx/);
    expect(W.getPortMappingStatus()).toMatchObject({ result: 'NOT_AUTHORIZED', method: null });
    rtc.close();
  });
});

describe('Stufen: ICE-Server und Warten auf den Router', () => {
  test('Stufe 1: STUN; Stufe 2: keine ICE-Server - und laengeres Warten, damit die Router-Adresse ins Angebot kommt', async () => {
    W.PORT_MAPPING_MAX_WAIT_MS[CM.MODE_FAST] = 40;
    W.PORT_MAPPING_MAX_WAIT_MS[CM.MODE_PRIVATE] = 400;
    installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 120 });

    const fast = new W.WebRTCManager(() => {}, () => {}, () => {});
    const offerFast = JSON.parse(await fast.createOffer()).sdp.sdp;
    expect(pcs()[0].config.iceServers).toHaveLength(2);
    for (const s of pcs()[0].config.iceServers) expect(STUN_POOL.map((p) => p.url)).toContain(s.urls);
    expect(offerFast).not.toMatch(/typ srflx/);           // Router zu langsam fuer Stufe 1
    await tick(150);
    // Spaet eingetroffen: trotzdem gemerkt (Erneuern/Loeschen), nie verwaist.
    expect(fast._pcpMappings).toHaveLength(2);
    fast.close();

    await CM.setConnectionMode(CM.MODE_PRIVATE);
    const priv = new W.WebRTCManager(() => {}, () => {}, () => {});
    const offerPriv = JSON.parse(await priv.createOffer()).sdp.sdp;
    expect(pcs()[1].config.iceServers).toEqual([]);
    expect(pcs()[1].config.iceTransportPolicy).toBe('all');
    expect(offerPriv).toMatch(/a=candidate:natpmp0 .* typ srflx/);
    // IPv6-Host-Kandidat bleibt im Angebot (Weg ohne STUN und ohne Router-NAT).
    expect(offerPriv).toMatch(/2001:db8:1:2::61 50002 typ host/);
    priv.close();
  });

  test('spaete Freigabe nach dem Schliessen wird sofort wieder geloescht', async () => {
    W.PORT_MAPPING_MAX_WAIT_MS[CM.MODE_FAST] = 20;
    const calls = installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 80 });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    await rtc.createOffer();
    rtc.close();
    expect(calls.some((c) => c.lifetime === 0)).toBe(false);
    await tick(120);
    const del = calls.find((c) => c.lifetime === 0);
    expect(del.mappings).toEqual([
      { protocol: 'udp', address: '192.168.178.61', port: 50001 },
      { protocol: 'tcp', address: '192.168.178.61', port: 50005 },
    ]);
  });

  test('Stufe 3: keine PeerConnection, keine Anfrage an den Router', async () => {
    const calls = installPcpMock({ rows: NATPMP_UPNP_ROWS });
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    await expect(rtc.createOffer()).rejects.toMatchObject({ name: 'TorOnlyModeError' });
    await expect(rtc.createAnswerDirect(JSON.stringify({ sdp: { type: 'offer', sdp: SDP } }))).rejects.toMatchObject({ name: 'TorOnlyModeError' });
    expect(pcs()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('Hole Punching ohne Zeitabstimmung', () => {
  test('Antwortseite: ICE startet (Angebot + eigene Beschreibung angewendet) bevor auf den Router gewartet wird', async () => {
    await CM.setConnectionMode(CM.MODE_PRIVATE);
    installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 30 });
    const answerer = new W.WebRTCManager(() => {}, () => {}, () => {});
    const answerJSON = await answerer.createAnswerDirect(JSON.stringify({ sdp: { type: 'offer', sdp: SDP } }));
    const ev = global.__events;
    expect(ev.indexOf('setRemoteDescription:offer')).toBeGreaterThan(-1);
    expect(ev.indexOf('setLocalDescription:answer')).toBeGreaterThan(ev.indexOf('setRemoteDescription:offer'));
    expect(ev.indexOf('pcp.map:3600')).toBeGreaterThan(ev.indexOf('setLocalDescription:answer'));
    // Die Antwort traegt die Router-Adresse trotzdem (vollstaendig, kein Trickle noetig).
    expect(JSON.parse(answerJSON).sdp.sdp).toMatch(/typ srflx/);
    answerer.close();
  });

  test('Anbieterseite: die Antwort wird ohne weiteres Warten angewendet (ICE startet sofort)', async () => {
    installPcpMock({ rows: [] });
    const offerer = new W.WebRTCManager(() => {}, () => {}, () => {});
    await offerer.createOffer();
    global.__events.length = 0;
    await offerer.handleAnswer(JSON.stringify({ sdp: { type: 'answer', sdp: SDP } }));
    expect(global.__events).toEqual(['setRemoteDescription:answer']);
    offerer.close();
  });
});
