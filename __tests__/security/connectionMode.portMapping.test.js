// Portfreigabe am Heimrouter mit Ersatzprotokollen (native Seite
// MalachiPcpModule.kt: PCP, dann NAT-PMP, dann UPnP-IGD - hier gemockt) und
// Verbindungsweg (ConnectionMode.js):
//   - NAT-PMP- und UPnP-Ergebnisse werden wie PCP zu srflx-Kandidaten,
//   - Freigaben werden erneuert und beim Schliessen geloescht (das native
//     Modul nimmt dafuer dasselbe Protokoll); spaet eintreffende Freigaben
//     werden nie verwaist,
//   - "Direkt, wenn moeglich" (seit dem STUN-Ausstieg die einzige Stufe mit
//     Direktverbindungen): keine ICE-Server; der Router ist die einzige Quelle
//     der oeffentlichen IPv4. Kurz gewartet - was spaeter kommt, wird ueber
//     onLateCandidates nachgereicht (Luecke L3), auch beim ICE-Neustart
//     nach einem Netzwechsel (Luecke L2),
//   - nachgereichte Kandidaten der Gegenseite werden erst angewendet, wenn
//     deren Beschreibung fuer GENAU diese Aushandlung gesetzt ist,
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
    async setLocalDescription(d) {
      global.__events.push('setLocalDescription:' + d.type);
      this.localDescription = d;
      // Sammeln sofort fertig (wie ohne STUN): auch fuer den ICE-Neustart.
      setTimeout(() => { this.onicegatheringstatechange?.(); }, 5);
    }
    async setRemoteDescription(d) { global.__events.push('setRemoteDescription:' + d.type); this.remoteDescription = d; }
    async addIceCandidate(c) { global.__events.push('addIceCandidate'); (this.added = this.added || []).push(c); }
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
const PM = require('../../PortMapping');

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
    expect(rtc._portMap.mappings).toEqual([
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
    expect(rtc._portMap.mappings).toBeNull();
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

describe('Ohne STUN: ICE-Server und Warten auf den Router', () => {
  test('keine ICE-Server; antwortet der Router rechtzeitig, steht seine Adresse im Angebot (IPv6-Host bleibt)', async () => {
    W.PORT_MAPPING_MAX_WAIT_MS.offer = 400;
    installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 30 });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    const offer = JSON.parse(await rtc.createOffer()).sdp.sdp;
    expect(pcs()[0].config.iceServers).toEqual([]);
    expect(pcs()[0].config.iceTransportPolicy).toBe('all');
    expect(offer).toMatch(/a=candidate:natpmp0 .* typ srflx/);
    // IPv6-Host-Kandidat bleibt im Angebot (Weg ohne STUN und ohne Router-NAT).
    expect(offer).toMatch(/2001:db8:1:2::61 50002 typ host/);
    rtc.close();
  });

  test('Wartezeit ohne STUN kurz (1,5 s, Neustart 1 s) - Spaeteres wird nachgereicht statt laenger zu warten', () => {
    expect(PM.PORT_MAPPING_MAX_WAIT_MS).toBe(W.PORT_MAPPING_MAX_WAIT_MS);
    expect(ORIGINAL_WAIT).toEqual({ offer: 1500, restart: 1000 });
  });

  test('L3: Router zu langsam - Angebot ohne Router-Adresse, die spaete Freigabe wird gemerkt und unter der Aushandlungs-ID nachgereicht', async () => {
    W.PORT_MAPPING_MAX_WAIT_MS.offer = 40;
    installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 120 });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    const late = [];
    rtc.onLateCandidates = (cands, id) => late.push({ cands, id });
    const offer = JSON.parse(await rtc.createOffer({ negotiationId: 'a1b2c3d4e5f60718' })).sdp.sdp;
    expect(offer).not.toMatch(/typ srflx/);
    expect(late).toEqual([]);
    await tick(150);
    // Spaet eingetroffen: gemerkt (Erneuern/Loeschen), nie verwaist ...
    expect(rtc._portMap.mappings).toHaveLength(2);
    // ... und nachgereicht: nur srflx mit oeffentlicher IPv4, gueltig gepruefte Form.
    expect(late).toHaveLength(1);
    expect(late[0].id).toBe('a1b2c3d4e5f60718');
    expect(late[0].cands.map((c) => c.candidate)).toEqual([
      'candidate:natpmp10 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 192.168.178.61 rport 50001',
      'candidate:upnp11 1 tcp 1686052607 203.0.113.9 50005 typ srflx raddr 192.168.178.61 rport 50005 tcptype passive',
    ]);
    for (const c of late[0].cands) expect(PM.isValidMappedCandidate(c)).toBe(true);
    rtc.close();
  });

  test('L3: ohne Aushandlungs-ID (z. B. alte Kopplung ueber createAnswer) wird nichts nachgereicht, aber trotzdem nie verwaist', async () => {
    W.PORT_MAPPING_MAX_WAIT_MS.offer = 20;
    installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 60 });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    const late = jest.fn();
    rtc.onLateCandidates = late;
    await rtc.createOffer();
    await tick(100);
    expect(late).not.toHaveBeenCalled();
    expect(rtc._portMap.mappings).toHaveLength(2);
    rtc.close();
  });

  test('spaete Freigabe nach dem Schliessen wird sofort wieder geloescht (und nicht mehr nachgereicht)', async () => {
    W.PORT_MAPPING_MAX_WAIT_MS.offer = 20;
    const calls = installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 80 });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    const late = jest.fn();
    rtc.onLateCandidates = late;
    await rtc.createOffer({ negotiationId: 'b1b2c3d4e5f60718' });
    rtc.close();
    expect(calls.some((c) => c.lifetime === 0)).toBe(false);
    await tick(120);
    const del = calls.find((c) => c.lifetime === 0);
    expect(del.mappings).toEqual([
      { protocol: 'udp', address: '192.168.178.61', port: 50001 },
      { protocol: 'tcp', address: '192.168.178.61', port: 50005 },
    ]);
    expect(late).not.toHaveBeenCalled();
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

describe('L2: ICE-Neustart nach Netzwechsel fragt den Router', () => {
  async function connectedOfferer() {
    installPcpMock({ rows: [] });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    await rtc.createOffer({ negotiationId: 'c1b2c3d4e5f60718' });
    await rtc.handleAnswer(JSON.stringify({ sdp: { type: 'answer', sdp: SDP } }));
    return rtc;
  }

  test('Neustart-Angebot und Neustart-Antwort enthalten die Router-Freigabe des neuen Netzes', async () => {
    const rtc = await connectedOfferer();
    const calls = installPcpMock({ rows: NATPMP_UPNP_ROWS });
    const offer = await rtc.createIceRestartOffer({ negotiationId: 'd1b2c3d4e5f60718' });
    expect(offer.type).toBe('offer');
    expect(offer.sdp).toMatch(/a=candidate:natpmp0 1 udp 1686052607 203\.0\.113\.9 40001 typ srflx/);
    expect(calls[0].mappings).toHaveLength(3);
    rtc.close();

    const answerer = new W.WebRTCManager(() => {}, () => {}, () => {});
    installPcpMock({ rows: [] });
    await answerer.createAnswerDirect(JSON.stringify({ sdp: { type: 'offer', sdp: SDP } }), { negotiationId: 'e1b2c3d4e5f60718' });
    installPcpMock({ rows: NATPMP_UPNP_ROWS });
    const answer = await answerer.acceptIceRestartOffer({ type: 'offer', sdp: SDP }, { negotiationId: 'f1b2c3d4e5f60718' });
    expect(answer.type).toBe('answer');
    expect(answer.sdp).toMatch(/typ srflx/);
    answerer.close();
  });

  test('Router beim Neustart zu langsam: Neustart wartet hoechstens 1 s, die Freigabe wird unter der Neustart-ID nachgereicht', async () => {
    const rtc = await connectedOfferer();
    W.PORT_MAPPING_MAX_WAIT_MS.restart = 30;
    installPcpMock({ rows: NATPMP_UPNP_ROWS, delayMs: 90 });
    const late = [];
    rtc.onLateCandidates = (cands, id) => late.push(id);
    const t0 = Date.now();
    const offer = await rtc.createIceRestartOffer({ negotiationId: 'a2b2c3d4e5f60718' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(offer.sdp).not.toMatch(/typ srflx/);
    await tick(120);
    expect(late).toEqual(['a2b2c3d4e5f60718']);
    rtc.close();
  });
});

describe('L3: nachgereichte Kandidaten der Gegenseite', () => {
  const CAND = { candidate: 'candidate:pcp10 1 udp 1686052607 203.0.113.77 40100 typ srflx raddr 192.168.1.20 rport 50010', sdpMid: '0', sdpMLineIndex: 0 };

  test('erst nach der Antwort angewendet (Signale laufen nebeneinander); nach dem Schliessen nichts mehr', async () => {
    installPcpMock({ rows: [] });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    await rtc.createOffer({ negotiationId: 'b3b2c3d4e5f60718' });
    const pc = pcs()[0];
    global.__events.length = 0;
    const applied = rtc.addLateRemoteCandidate('b3b2c3d4e5f60718', CAND);
    await tick(10);
    expect(pc.added).toBeUndefined();                       // Antwort noch nicht da
    await rtc.handleAnswer(JSON.stringify({ sdp: { type: 'answer', sdp: SDP } }));
    expect(await applied).toBe(true);
    expect(global.__events).toEqual(['setRemoteDescription:answer', 'addIceCandidate']);
    expect(pc.added).toEqual([CAND]);
    rtc.close();
    // Nach dem Schliessen: nichts mehr.
    expect(await rtc.addLateRemoteCandidate('b3b2c3d4e5f60718', CAND)).toBe(false);
  });

  test('Obergrenze je Aushandlung (8); Tor-Verbindungen nehmen nie Kandidaten an', async () => {
    installPcpMock({ rows: [] });
    const rtc = new W.WebRTCManager(() => {}, () => {}, () => {});
    await rtc.createAnswerDirect(JSON.stringify({ sdp: { type: 'offer', sdp: SDP } }), { negotiationId: 'c3b2c3d4e5f60718' });
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await rtc.addLateRemoteCandidate('c3b2c3d4e5f60718', CAND));
    expect(results.filter(Boolean)).toHaveLength(PM.MAX_LATE_CANDIDATES);
    expect(PM.MAX_LATE_CANDIDATES).toBe(8);
    rtc.close();
    const tor = new W.WebRTCManager(() => {}, () => {}, () => {});
    tor.attachTorChannel({ readyState: 'open', send() {}, close() {} }, true);
    expect(await tor.addLateRemoteCandidate('c3b2c3d4e5f60718', CAND)).toBe(false);
    tor.close();
  });

  test('Pruefung: nur srflx-Router-Kandidaten mit oeffentlicher IPv4 und privater Basisadresse', () => {
    const ok = (candidate, extra = {}) => PM.isValidMappedCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0, ...extra });
    expect(ok(CAND.candidate)).toBe(true);
    expect(ok('candidate:upnp3 1 tcp 1686052607 203.0.113.77 40100 typ srflx raddr 192.168.1.20 rport 50010 tcptype passive')).toBe(true);
    // keine Host-Kandidaten, kein IPv6, kein Carrier-NAT/privat als oeffentliche Adresse
    expect(ok('candidate:1 1 udp 2122260223 192.168.1.20 50010 typ host')).toBe(false);
    expect(ok('candidate:pcp1 1 udp 1686052607 2001:db8::1 40100 typ srflx raddr 192.168.1.20 rport 50010')).toBe(false);
    expect(ok('candidate:pcp1 1 udp 1686052607 100.64.3.4 40100 typ srflx raddr 192.168.1.20 rport 50010')).toBe(false);
    expect(ok('candidate:pcp1 1 udp 1686052607 10.0.0.9 40100 typ srflx raddr 192.168.1.20 rport 50010')).toBe(false);
    // Basisadresse muss privat sein, Ports gueltig, tcp nur passiv
    expect(ok('candidate:pcp1 1 udp 1686052607 203.0.113.77 40100 typ srflx raddr 198.51.100.1 rport 50010')).toBe(false);
    expect(ok('candidate:pcp1 1 udp 1686052607 203.0.113.77 0 typ srflx raddr 192.168.1.20 rport 50010')).toBe(false);
    expect(ok('candidate:pcp1 1 tcp 1686052607 203.0.113.77 40100 typ srflx raddr 192.168.1.20 rport 50010')).toBe(false);
    // fremde Foundation (z. B. ein STUN- oder TURN-Kandidat), Zusatzfelder, falsche Komponente
    expect(ok('candidate:842163049 1 udp 1686052607 203.0.113.77 40100 typ srflx raddr 192.168.1.20 rport 50010')).toBe(false);
    expect(ok('candidate:pcp1 1 udp 1686052607 203.0.113.77 40100 typ relay raddr 192.168.1.20 rport 50010')).toBe(false);
    expect(ok(CAND.candidate + ' generation 0')).toBe(false);
    expect(ok(CAND.candidate.replace(' 1 udp', ' 2 udp'))).toBe(false);
    // sdpMid/Index
    expect(ok(CAND.candidate, { sdpMid: 'x'.repeat(40) })).toBe(false);
    expect(ok(CAND.candidate, { sdpMid: null, sdpMLineIndex: null })).toBe(false);
    expect(PM.isValidMappedCandidate(null)).toBe(false);
    expect(PM.isValidMappedCandidate({ candidate: 5 })).toBe(false);
  });
});

describe('Hole Punching ohne Zeitabstimmung', () => {
  test('Antwortseite: ICE startet (Angebot + eigene Beschreibung angewendet) bevor auf den Router gewartet wird', async () => {
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
