// Verbindungs-Diagnose (ConnectionStats.js, STUN_AUSSTIEG_PLAN.md WP0, E10):
// nur lokale Zaehlwerte - keine IP-Adressen, keine Kontakt-IDs, keine
// Onion-Adressen, keine Zeitstempel einzelner Ereignisse, keine Telemetrie.
//   - Gespeichertes JSON besteht nur aus festen Kategorien mit Ganzzahlen,
//   - freie Werte (Adressen, IDs ...) koennen gar nicht hineingeraten,
//   - Pfad-Klassen aus getStats unterscheiden Router-Freigabe, STUN der
//     Gegenseite (aeltere Version) und peer-reflexiv - ohne Adressen,
//   - waehrend eines Anrufs wird nichts gespeichert,
//   - "Alle Daten loeschen" leert die Zaehler (Speicher und Arbeitsspeicher),
//   - kein Netzzugriff, keine Logzeile mit Werten.
const fs = require('fs');
const path = require('path');
const { NativeModules } = require('react-native');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const CS = require('../../ConnectionStats');

const ROOT = path.join(__dirname, '..', '..');
const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/;
const IPV6 = /\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/i;
const ONION = /[a-z2-7]{56}\.onion/;
const CONTACT_ID = /c_[A-Za-z0-9]{3,}/;
const TIMESTAMP = /\b1[6-9]\d{11}\b/;     // Millisekunden seit 1970 (2020-2033)

beforeEach(async () => {
  CS._resetConnectionStatsForTests();
  await EncryptedStorage.clear();
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  delete NativeModules.MalachiPcp;
});

async function storedJson() {
  await CS.flushConnectionStats();
  return EncryptedStorage.getItem(CS.CONNECTION_STATS_KEY);
}

test('gespeichert werden nur feste Kategorien mit Ganzzahlen - keine Adressen, IDs, Onion-Adressen, Zeitstempel', async () => {
  await CS.loadConnectionStats();
  // Realistischer Ablauf: Versuche, Pfade (mit Adressen in den Rohdaten!), Anrufe.
  CS.bump('direct', 'started');
  CS.bump('direct', 'ok');
  CS.noteDirectSetup(1234);
  CS.bump('path', CS.classifyPath(
    { candidateType: 'host', address: '2001:db8::5', protocol: 'udp' },
    { candidateType: 'host', address: '2001:db8::9', protocol: 'udp' }));
  CS.bump('path', CS.classifyPath(
    { candidateType: 'srflx', address: '203.0.113.9', foundation: 'natpmp0' },
    { candidateType: 'prflx', address: '198.51.100.7' }));
  CS.bump('calls', 'channelTor');
  CS.noteCallSetup(2500);
  CS.bump('channelAudio', 'frames', 750);
  CS.bump('minutes', 'direct', 5);
  const raw = await storedJson();
  expect(raw).toBeTruthy();
  for (const re of [IPV4, IPV6, ONION, CONTACT_ID, TIMESTAMP]) expect(raw).not.toMatch(re);
  const parsed = JSON.parse(raw);
  expect(Object.keys(parsed).sort()).toEqual(['v', ...Object.keys(CS.SCHEMA)].sort());
  for (const [cat, keys] of Object.entries(CS.SCHEMA)) {
    expect(Object.keys(parsed[cat])).toEqual(keys);
    for (const k of keys) expect(Number.isInteger(parsed[cat][k])).toBe(true);
  }
  expect(parsed.path).toMatchObject({ ipv6Host: 1, mapping: 1 });
  expect(parsed.directSetup.lt2s).toBe(1);
  expect(parsed.calls).toMatchObject({ channelTor: 1, setupLt5s: 1 });
});

test('freie Werte koennen nicht hineingeraten: unbekannte Kategorien/Schluessel und Unsinn werden verworfen', async () => {
  await CS.loadConnectionStats();
  CS.bump('direct', '203.0.113.9');
  CS.bump('c_kontakt42', 'ok');
  CS.bump('path', 'x'.repeat(56) + '.onion');
  CS.bump('direct', 'ok', '2001:db8::1');
  CS.bump('direct', 'ok', -5);
  CS.bump('direct', 'ok', Infinity);
  CS.bump('__proto__', 'polluted');
  CS.bump('constructor', 'prototype');
  CS.noteDirectSetup('203.0.113.9');
  CS.noteCallSetup(-1);
  expect(CS.getConnectionStats().direct.ok).toBe(0);
  expect({}.polluted).toBeUndefined();
  const raw = await storedJson();
  expect(raw).toBeNull();                       // es gab nichts Gueltiges zu speichern
});

test('manipulierter Speicher wird beim Laden bereinigt (nur bekannte Felder, nur Ganzzahlen)', async () => {
  await EncryptedStorage.setItem(CS.CONNECTION_STATS_KEY, JSON.stringify({
    v: 1, direct: { ok: 3, started: '7', ip: '203.0.113.9' }, extra: { contact: 'c_abc' }, path: { lan: -1, mapping: 2.5 },
  }));
  const s = await CS.loadConnectionStats();
  expect(s.direct.ok).toBe(3);
  expect(s.direct.started).toBe(7);
  expect(s.direct.ip).toBeUndefined();
  expect(s.extra).toBeUndefined();
  expect(s.path).toMatchObject({ lan: 0, mapping: 0 });
});

test('Text zum Kopieren: nur Zaehler und feste Texte, keine Adressen/IDs', async () => {
  await CS.loadConnectionStats();
  CS.bump('direct', 'started', 4);
  CS.bump('direct', 'ok', 3);
  CS.bump('minutes', 'direct', 30);
  CS.bump('minutes', 'tor', 10);
  const text = CS.statsAsText(CS.getConnectionStats(), {
    tr: (k, p) => k + (p ? ' ' + JSON.stringify(p) : ''), appVersion: '1.2.0 · web', modeLabel: 'Direkt, wenn möglich',
  });
  expect(text).toMatch(/diag\.textShare \{"direct":"75 %","ok":3,"tried":4\}/);
  expect(text).toMatch(/^direct: started=4, ok=3,/m);
  for (const re of [IPV4, IPV6, ONION, CONTACT_ID, TIMESTAMP]) expect(text).not.toMatch(re);
  expect(CS.statsSummary(CS.getConnectionStats(), (k, p) => p.ok + '/' + p.tried + ' ' + p.direct)).toBe('3/4 75 %');
});

test('Pfad-Klassen: Router-Freigabe, STUN nur bei der Gegenseite, peer-reflexiv, IPv6, LAN', () => {
  const c = CS.classifyPath;
  expect(c({ candidateType: 'srflx', foundation: 'pcp0' }, { candidateType: 'host', address: '2001:db8::1' })).toBe('mapping');
  // Eigene srflx-Kandidaten gibt es ohne STUN nur aus der Portfreigabe.
  expect(c({ candidateType: 'srflx', foundation: '1234' }, { candidateType: 'host' })).toBe('mapping');
  expect(c({ candidateType: 'host', address: '192.168.1.2' }, { candidateType: 'srflx', foundation: 'upnp1' })).toBe('mapping');
  // Gegenseite (aeltere Version mit STUN): eigener Kandidat host/prflx, ihrer srflx.
  expect(c({ candidateType: 'host', address: '192.168.1.2' }, { candidateType: 'srflx', foundation: '842163049' })).toBe('peerStun');
  expect(c({ candidateType: 'prflx' }, { candidateType: 'host', address: '10.0.0.2' })).toBe('prflx');
  expect(c({ candidateType: 'host', address: '2001:db8::1' }, { candidateType: 'host', ip: '2001:db8::2' })).toBe('ipv6Host');
  expect(c({ candidateType: 'host', address: '192.168.1.2' }, { candidateType: 'host', address: '192.168.1.3' })).toBe('lan');
  expect(c({ candidateType: 'host', address: '203.0.113.1' }, { candidateType: 'host', address: '192.168.1.3' })).toBe('other');
  expect(c(null, {})).toBe('other');
  for (const v of ['mapping', 'peerStun', 'prflx', 'ipv6Host', 'lan', 'other']) expect(CS.SCHEMA.path).toContain(v);
});

test('Netzlage: nur WLAN/Mobilfunk und IPv6 ja/nein - nie die Adresse', async () => {
  await CS.loadConnectionStats();
  NativeModules.MalachiPcp = { ipv6Status: jest.fn(async () => ({ transport: 'wifi', globalAddress: '2001:db8::77', defaultRoute: false })) };
  await CS.noteNetworkSituation();
  expect(CS.getConnectionStats().net).toMatchObject({ wifi: 1, ipv6Missing: 1, ipv6Ok: 0 });
  expect(await storedJson()).not.toMatch(IPV6);
});

test('waehrend eines Anrufs wird nichts gespeichert (Waechter), danach schon', async () => {
  await CS.loadConnectionStats();
  let inCall = true;
  CS.setConnectionStatsWriteGuard(() => inCall);
  const spy = jest.spyOn(EncryptedStorage, 'setItem');
  CS.bump('groupPairs', 'connected');
  expect(await CS.flushConnectionStats()).toBe(false);
  expect(spy).not.toHaveBeenCalled();
  inCall = false;
  expect(await CS.flushConnectionStats()).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(await CS.flushConnectionStats()).toBe(false);   // nichts Neues
  spy.mockRestore();
});

test('Zaehlen allein schreibt nie sofort (kein Speicherzugriff je Ereignis)', async () => {
  await CS.loadConnectionStats();
  const spy = jest.spyOn(EncryptedStorage, 'setItem');
  for (let i = 0; i < 50; i++) CS.bump('direct', 'started');
  await new Promise((r) => setTimeout(r, 30));
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('Zeitanteil: Summen je Minute aus den Verbindungen, ohne Zuordnung', async () => {
  jest.useFakeTimers();
  try {
    await CS.loadConnectionStats();
    const conns = new Map([
      ['c_a', { transport: 'direct', keyExchangeDone: true }],
      ['c_b', { transport: 'tor', keyExchangeDone: true }],
      ['c_c', { transport: 'tor', keyExchangeDone: false }],
      ['c_d', { transport: 'direct', keyExchangeDone: true, _closed: true }],
    ]);
    CS.startConnectionTimeSampler(() => conns, 60000);
    jest.advanceTimersByTime(60000 * 3);
    expect(CS.getConnectionStats().minutes).toEqual({ direct: 3, tor: 3 });
    CS.stopConnectionTimeSampler();
  } finally {
    jest.useRealTimers();
  }
  const raw = await storedJson();
  expect(raw).not.toMatch(/c_[abcd]/);
});

test('"Zuruecksetzen" und "Alle Daten loeschen" leeren die Zaehler (Speicher und Arbeitsspeicher)', async () => {
  await CS.loadConnectionStats();
  CS.bump('direct', 'ok', 5);
  await CS.flushConnectionStats();
  expect(await EncryptedStorage.getItem(CS.CONNECTION_STATS_KEY)).toBeTruthy();
  await CS.resetConnectionStats();
  expect(await EncryptedStorage.getItem(CS.CONNECTION_STATS_KEY)).toBeNull();
  expect(CS.getConnectionStats().direct.ok).toBe(0);

  CS.bump('direct', 'ok', 2);
  await CS.flushConnectionStats();
  // Wipe wie in App.tsx: Speicher komplett leeren, dann den Arbeitsspeicher.
  await EncryptedStorage.clear();
  CS.resetConnectionStatsAfterWipe();
  expect(CS.getConnectionStats().direct.ok).toBe(0);
  expect((await CS.loadConnectionStats()).direct.ok).toBe(0);
  expect(await EncryptedStorage.getItem(CS.CONNECTION_STATS_KEY)).toBeNull();
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
  const wipe = app.slice(app.indexOf('try { await EncryptedStorage.clear(); } catch {}'));
  expect(wipe.slice(0, 2000)).toMatch(/resetConnectionStatsAfterWipe\(\);/);
});

test('kein Netzzugriff, keine Logzeile mit Werten', async () => {
  const logs = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) jest.spyOn(console, k).mockImplementation((...a) => logs.push(a.join(' ')));
  await CS.loadConnectionStats();
  CS.bump('direct', 'ok');
  CS.bump('path', CS.classifyPath({ candidateType: 'host', address: '192.168.7.7' }, { candidateType: 'host', address: '192.168.7.8' }));
  await CS.flushConnectionStats();
  const bad = jest.spyOn(EncryptedStorage, 'setItem').mockImplementation(async () => { throw new Error('voll'); });
  CS.bump('direct', 'ok');
  await CS.flushConnectionStats();
  bad.mockRestore();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(logs.join('\n')).not.toMatch(IPV4);
  expect(logs.join('\n')).not.toMatch(/\d/);     // nicht einmal Zaehlerstaende
  jest.restoreAllMocks();
});

test('statisch: das Modul spricht mit niemandem (kein fetch, kein Tor, kein WebSocket) und nennt die Regel', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ConnectionStats.js'), 'utf8');
  expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|TorTransport|sendMessage|RTCStore/);
  expect(src).toMatch(/keine IP-Adressen, keine Ports, keine Kontakt-IDs, keine Onion-Adressen/);
});
