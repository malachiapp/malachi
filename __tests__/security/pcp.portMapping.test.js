// Automatische Portfreigabe per PCP (WebRTCManager.hostCandidatesForMapping /
// addMappedCandidates, native Seite MalachiPcpModule.kt). Geprueft wird die
// Auswahl der Kandidaten (nur sinnvolle, nie link-lokal/ULA/oeffentlich-IPv4)
// und dass nur echte oeffentliche IPv4-Weiterleitungen ins Angebot kommen.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { hostCandidatesForMapping, addMappedCandidates } = require('../../WebRTCManager');

const SDP = [
  'v=0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=candidate:1 1 udp 2122260223 192.168.178.61 50001 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 2001:db8:1:2::61 50002 typ host generation 0',
  'a=candidate:3 1 udp 2122129151 fe80::1 50003 typ host generation 0',
  'a=candidate:4 1 udp 2122063615 fd20:e30b::61 50004 typ host generation 0',
  'a=candidate:5 1 tcp 1518280447 192.168.178.61 9 typ host tcptype active generation 0',
  'a=candidate:6 1 tcp 1518214911 192.168.178.61 50005 typ host tcptype passive generation 0',
  'a=candidate:7 1 udp 1686052607 203.0.113.5 50001 typ srflx raddr 192.168.178.61 rport 50001',
  'a=candidate:8 1 udp 2122260223 198.51.100.7 50006 typ host generation 0',
  'a=candidate:9 1 udp 2122260223 192.168.178.61 50001 typ host generation 0',
  'a=end-of-candidates',
  '',
].join('\r\n');

test('nur sinnvolle Host-Kandidaten: private IPv4, globale IPv6, passive TCP - keine link-lokalen/ULA, keine oeffentlichen IPv4, keine Duplikate', () => {
  expect(hostCandidatesForMapping(SDP)).toEqual([
    { protocol: 'udp', address: '192.168.178.61', port: 50001 },
    { protocol: 'udp', address: '2001:db8:1:2::61', port: 50002 },
    { protocol: 'tcp', address: '192.168.178.61', port: 50005 },
  ]);
});

test('erfolgreiche IPv4-Weiterleitung mit oeffentlicher Adresse wird als srflx-Kandidat vor a=end-of-candidates eingefuegt', () => {
  const out = addMappedCandidates(SDP, [
    { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'SUCCESS', externalAddress: '203.0.113.9', externalPort: 40001 },
  ]);
  const lines = out.split('\r\n');
  const added = lines.indexOf('a=candidate:pcp0 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 192.168.178.61 rport 50001');
  expect(added).toBeGreaterThan(-1);
  expect(lines[added + 1]).toBe('a=end-of-candidates');
});

test('nichts eingefuegt fuer IPv6-Pinholes, Fehlschlaege, private/Carrier-NAT-Adressen oder kaputte Ports', () => {
  const results = [
    { protocol: 'udp', address: '2001:db8:1:2::61', port: 50002, result: 'SUCCESS', externalAddress: '2001:db8:1:2::61', externalPort: 50002 },
    { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'NOT_AUTHORIZED' },
    { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'SUCCESS', externalAddress: '100.64.1.2', externalPort: 40001 },
    { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'SUCCESS', externalAddress: '10.0.0.5', externalPort: 40001 },
    { protocol: 'udp', address: '192.168.178.61', port: 50001, result: 'SUCCESS', externalAddress: '203.0.113.9', externalPort: 0 },
  ];
  expect(addMappedCandidates(SDP, results)).toBe(SDP);
});
