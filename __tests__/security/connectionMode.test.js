// Verbindungsweg (ConnectionMode.js) - drei Stufen:
//   1 "Schnell (mit STUN)", 2 "Privat (ohne STUN)",
//   3 "Maximal anonym (nur Tor)" (Vollversion).
// Geprueft wird der echte Produktionscode (ConnectionMode, WebRTCManager-
// Konfiguration, DirectUpgrade, RTCStore, TorTransport-Reserve,
// LicenseManager-Regel); nur die WebRTC-Direktverbindung selbst ist durch eine
// Attrappe ersetzt (kein natives WebRTC unter Jest):
//   - ICE-Server je Stufe (nur Stufe 1 fragt STUN, Stufe 3 baut gar keine
//     PeerConnection), ausfallsicher bei unlesbarer Einstellung,
//   - Pro-Regel: Stufe 3 neu waehlen nur mit Vollversion, eine aktive Stufe 3
//     bleibt auch ohne Lizenz aktiv (wie die Duress-PIN),
//   - Stufe 3 verhindert jedes Direkt-Upgrade (eigene Versuche, Angebote und
//     Bitten der Gegenseite, ICE-Neustarts),
//   - Stufenwechsel wirkt ohne Neustart: Direktverbindungen werden sofort auf
//     Tor zurueckgestuft, laufende Versuche abgebrochen; zurueck auf Stufe 1/2
//     wird sofort wieder direkt versucht; 1 -> 2 zieht bestehende
//     Direktverbindungen per ICE-Neustart auf Kandidaten ohne STUN um.
const fs = require('fs');
const path = require('path');
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
      this._lastActivity = 0;
      this.pendingMsgs = [];
      this.dataChannel = { readyState: 'open', send: jest.fn() };
      this.pc = { iceConnectionState: 'connected' };
      this.sent = [];
      this.sendMessage = jest.fn((raw) => { this.sent.push(JSON.parse(raw)); return 'sent'; });
      this.createOffer = jest.fn(async () => JSON.stringify({ sdp: { type: 'offer', sdp: 'v=0 angebot' }, type: 'offer' }));
      this.createAnswerDirect = jest.fn(async () => JSON.stringify({ sdp: { type: 'answer', sdp: 'v=0 antwort' } }));
      this.handleAnswer = jest.fn(async () => {});
      this.createIceRestartOffer = jest.fn(async () => ({ type: 'offer', sdp: 'v=0 neustart' }));
      this.acceptIceRestartOffer = jest.fn(async () => ({ type: 'answer', sdp: 'v=0 neustart-antwort' }));
      this.acceptIceRestartAnswer = jest.fn(async () => true);
      this.applyConnectionModeConfig = jest.fn(async () => true);
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
const LM = require('../../LicenseManager');
const { STUN_POOL } = require('../../AppConfig');
const POOL_URLS = STUN_POOL.map((s) => s.url);
// Stufe 1: zwei verschiedene, oeffentliche STUN-Dienste aus dem Pool.
const expectTwoPoolStuns = (servers) => {
  expect(servers).toHaveLength(2);
  for (const s of servers) expect(POOL_URLS).toContain(s.urls);
  expect(servers[0].urls).not.toBe(servers[1].urls);
};
const { pcConfigForCalls, pcConfigForMode } = require('../../WebRTCManager');

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ONION_A = 'a'.repeat(56) + '.onion';   // kleinste -> wir bieten an
const ONION_B = 'b'.repeat(56) + '.onion';
const ONION_C = 'c'.repeat(56) + '.onion';
const CONTACT = { id: 'c_modus', name: 'Peer', role: 'responder', torOnion: ONION_B };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
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
// Wie nach einem Neustart der App: Zwischenspeicher weg, Einstellung neu lesen.
async function restartApp() {
  CM._resetConnectionModeForTests();
  return CM.loadConnectionMode();
}

let tor;
const directLost = jest.fn();
beforeEach(async () => {
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  global.__fakeDirect = [];
  directLost.mockClear();
  DU.configureDirectUpgrade({ onDirectLost: directLost });
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
afterEach(() => {
  DU._resetDirectUpgradeForTests();
});

describe('ICE-Server je Stufe', () => {
  test('Stufe 1 fragt zwei oeffentliche STUN-Dienste (reihum), Stufe 2 keinen, Stufe 3 baut keine PeerConnection', () => {
    const a = CM.iceServersForMode(CM.MODE_FAST);
    const b = CM.iceServersForMode(CM.MODE_FAST);
    expectTwoPoolStuns(a);
    expectTwoPoolStuns(b);
    expect(a).not.toEqual(b);                                    // im Wechsel
    expect(CM.iceServersForMode(CM.MODE_PRIVATE)).toEqual([]);
    expect(CM.iceServersForMode(CM.MODE_TOR_ONLY)).toEqual([]);
    const cfg = pcConfigForMode(CM.MODE_FAST);
    expect(cfg).toMatchObject({ iceTransportPolicy: 'all', tcpCandidatePolicy: 'enabled' });
    expectTwoPoolStuns(cfg.iceServers);
    expect(JSON.stringify(cfg.iceServers)).not.toMatch(/turn:/);
    expect(pcConfigForMode(CM.MODE_PRIVATE)).toMatchObject({ iceServers: [], iceTransportPolicy: 'all' });
    expect(() => pcConfigForMode(CM.MODE_TOR_ONLY)).toThrow(/nur Tor/);
  });

  test('ohne gespeicherte Einstellung gilt Stufe 1; die gespeicherte Stufe gilt sofort und nach einem Neustart', async () => {
    expect(await CM.loadConnectionMode()).toBe(CM.MODE_FAST);
    expectTwoPoolStuns((await pcConfigForCalls()).iceServers);
    expect(await CM.setConnectionMode(CM.MODE_PRIVATE)).toEqual({ ok: true, mode: CM.MODE_PRIVATE });
    expect((await pcConfigForCalls()).iceServers).toEqual([]);
    expect(await EncryptedStorage.getItem(CM.CONNECTION_MODE_STORAGE_KEY)).toBe('2');
    expect(await restartApp()).toBe(CM.MODE_PRIVATE);
    expect((await pcConfigForCalls()).iceServers).toEqual([]);
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await expect(pcConfigForCalls()).rejects.toMatchObject({ name: 'TorOnlyModeError' });
  });

  test('unlesbare Einstellung: ausfallsicher wie "nur Tor" - keine PeerConnection, kein Upgrade', async () => {
    const spy = jest.spyOn(EncryptedStorage, 'getItem').mockImplementation(async (key) => {
      if (key === CM.CONNECTION_MODE_STORAGE_KEY) throw new Error('Speicher gesperrt');
      return null;
    });
    try {
      expect(await CM.connectionModeForDecision()).toBe(CM.MODE_TOR_ONLY);
      await expect(pcConfigForCalls()).rejects.toMatchObject({ name: 'TorOnlyModeError' });
      expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('nur-tor');
    } finally {
      spy.mockRestore();
    }
    // Lesbar geworden: wieder normal.
    expect(await CM.connectionModeForDecision()).toBe(CM.MODE_FAST);
  });

  test('statisch: WebRTCManager nimmt STUN nur noch ueber den Verbindungsweg (kein fester STUN-Eintrag mehr)', () => {
    const src = readSrc('WebRTCManager.js');
    expect(src).not.toMatch(/iceServers:\s*\[\{\s*urls:\s*STUN_URL/);
    expect(src).toMatch(/iceServers: iceServersForMode\(mode\)/);
  });
});

describe('Vollversion: Stufe 3 waehlen, aktive Stufe 3 bleibt', () => {
  test('Regel in LicenseManager: nur mit Pro', () => {
    expect(LM.canSelectTorOnlyMode(true)).toBe(true);
    expect(LM.canSelectTorOnlyMode(false)).toBe(false);
    expect(LM.canSelectTorOnlyMode(undefined)).toBe(false);
    expect(LM.canSelectTorOnlyMode('true')).toBe(false);
  });

  test('ohne Vollversion: Stufe 3 wird abgelehnt, nichts gespeichert, nichts geschlossen', async () => {
    const r = await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: false });
    expect(r).toEqual({ ok: false, mode: CM.MODE_FAST, reason: 'pro' });
    expect(CM.getConnectionMode()).toBe(CM.MODE_FAST);
    expect(await EncryptedStorage.getItem(CM.CONNECTION_MODE_STORAGE_KEY)).toBeNull();
    expect(tor.close).not.toHaveBeenCalled();
  });

  test('mit Vollversion gewaehlt - nach Lizenzverlust (Neustart, keine Lizenz) bleibt Stufe 3 aktiv', async () => {
    expect(await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true })).toEqual({ ok: true, mode: CM.MODE_TOR_ONLY });
    expect(await restartApp()).toBe(CM.MODE_TOR_ONLY);
    expect(CM.isTorOnlyMode()).toBe(true);
    // Erneut bestaetigen ohne Lizenz: bleibt aktiv (nie still abschalten).
    expect(await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: false })).toEqual({ ok: true, mode: CM.MODE_TOR_ONLY });
    expect(CM.canSelectConnectionMode(CM.MODE_TOR_ONLY, { pro: false, current: CM.MODE_TOR_ONLY })).toBe(true);
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('nur-tor');
    // Verlassen geht immer - danach ohne Lizenz kein Zurueck.
    expect((await CM.setConnectionMode(CM.MODE_PRIVATE, { pro: false })).ok).toBe(true);
    expect(await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: false })).toMatchObject({ ok: false, reason: 'pro' });
  });

  test('ConnectionMode liest den Lizenzzustand nie selbst (eine Lizenzpruefung kann Stufe 3 nicht abschalten)', () => {
    const src = readSrc('ConnectionMode.js');
    expect(src).not.toMatch(/from '\.\/LicenseManager'|require\('\.\/LicenseManager'\)|isPro(Verified)?\(/);
    expect(src.match(/^import .*$/gm)).toEqual([
      "import EncryptedStorage from 'react-native-encrypted-storage';",
      "import { STUN_POOL, STUN_PER_CONNECTION } from './AppConfig';",
    ]);
  });
});

describe('Stufe 3 verhindert jedes Direkt-Upgrade', () => {
  beforeEach(async () => {
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
  });

  test('kein eigenes Angebot (auch nicht "manuell"), keine WebRTC-Verbindung', async () => {
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('nur-tor');
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'manuell', force: true })).toBe('nur-tor');
    await tick(20);
    expect(fakes()).toHaveLength(0);
    expect(tor.sent).toEqual([]);
  });

  test('Angebot, Bitte und ICE-Neustart der Gegenseite werden mit tor_only abgelehnt - keine eigenen Kandidaten', async () => {
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });
    await fromPeer(tor, { subtype: 'direct_offer', id: '1'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 x' }, onion: ONION_B });
    await fromPeer(tor, { subtype: 'direct_request', onion: ONION_B });
    await fromPeer(tor, { subtype: 'direct_offer', restart: true, id: '2'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 r' }, onion: ONION_B });
    const rejects = tor.sent.filter((m) => m.subtype === 'direct_reject');
    expect(rejects).toEqual([
      expect.objectContaining({ id: '1'.repeat(16), reason: 'tor_only' }),
      expect.objectContaining({ reason: 'tor_only' }),
      expect.objectContaining({ id: '2'.repeat(16), reason: 'tor_only' }),
    ]);
    expect(tor.sent.some((m) => m.subtype === 'direct_answer' || m.subtype === 'direct_offer')).toBe(false);
    expect(fakes()).toHaveLength(0);
  });

  test('Gegenseite in Stufe 3: unser Versuch endet mit langer Wartezeit (10 min)', async () => {
    await CM.setConnectionMode(CM.MODE_FAST);
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const { id } = tor.sent.find((m) => m.subtype === 'direct_offer');
    await fromPeer(tor, { subtype: 'direct_reject', id, reason: 'tor_only' });
    expect(fakes()[0].close).toHaveBeenCalled();
    expect(DU._getBackoffForTests(CONTACT.id).nextAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);
  });
});

describe('Stufenwechsel wirkt ohne Neustart', () => {
  async function promotedDirect() {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const direct = fakes()[0];
    direct.keyExchangeDone = true;
    await direct._onKeyExchange();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);
    return direct;
  }

  test('Wechsel auf Stufe 3: bestehende Direktverbindung sofort auf die Tor-Reserve zurueckgestuft, Gegenseite erfaehrt "nur Tor"', async () => {
    const direct = await promotedDirect();
    direct.pendingMsgs = ['{"type":"text","text":"wartet"}'];
    expect((await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true })).ok).toBe(true);
    await tick(20);
    expect(RTCStore.connections.get(CONTACT.id)).toBe(tor);
    expect(direct.close).toHaveBeenCalled();
    expect(tor.close).not.toHaveBeenCalled();
    // Wartende Nachrichten der Direktverbindung wandern mit (RTCStore.setConnection).
    expect(tor.pendingMsgs).toContain('{"type":"text","text":"wartet"}');
    expect(tor.sent.find((m) => m.subtype === 'direct_reject')).toMatchObject({ reason: 'tor_only' });
    expect(directLost).toHaveBeenCalledWith(CONTACT.id, tor);
    // Und es bleibt dabei: kein neuer Versuch, auch nicht nach Abbruch-Logik.
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'direkt-weg' })).toBe('nur-tor');
  });

  test('ohne Tor-Reserve: Direktverbindung wird geschlossen, sofort ueber Tor neu verbinden (Hook)', async () => {
    RTCStore.connections.delete(CONTACT.id);
    const FakeRtc = require('../../WebRTCManager').WebRTCManager;
    const direct = new FakeRtc(() => {}, () => {}, () => {});
    direct.keyExchangeDone = true;
    RTCStore.connections.set(CONTACT.id, direct);
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await tick(20);
    expect(direct.close).toHaveBeenCalled();
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
    expect(directLost).toHaveBeenCalledWith(CONTACT.id, null);
  });

  test('laufender Upgrade-Versuch wird abgebrochen', async () => {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    expect(DU.isUpgradeInProgress(CONTACT.id)).toBe(true);
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await tick(20);
    expect(fakes()[0].close).toHaveBeenCalled();
    expect(DU.isUpgradeInProgress(CONTACT.id)).toBe(false);
    expect(RTCStore.connections.get(CONTACT.id)).toBe(tor);
  });

  test('zurueck auf Stufe 1: sofort neuer Versuch (Wartezeiten aufgehoben); als Nicht-Anbieter mit Bitte an die Gegenseite', async () => {
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await CM.setConnectionMode(CM.MODE_FAST);
    await tick(30);
    expect(tor.sent.some((m) => m.subtype === 'direct_offer')).toBe(true);

    DU._resetDirectUpgradeForTests();
    tor.sent.length = 0;
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });   // jetzt bietet die Gegenseite an
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await CM.setConnectionMode(CM.MODE_PRIVATE);
    await tick(30);
    expect(tor.sent.find((m) => m.subtype === 'direct_request')).toBeTruthy();
  });

  test('Stufe 1 -> 2: bestehende Direktverbindung bekommt die neue Konfiguration und zieht per ICE-Neustart um (ohne STUN)', async () => {
    const direct = await promotedDirect();
    await CM.setConnectionMode(CM.MODE_PRIVATE);
    await tick(30);
    expect(direct.applyConnectionModeConfig).toHaveBeenCalled();
    expect(direct.createIceRestartOffer).toHaveBeenCalled();
    expect(direct.sent.find((m) => m.subtype === 'direct_offer')).toMatchObject({ restart: true });
    expect(direct.close).not.toHaveBeenCalled();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    // 2 -> 1: nur neue Konfiguration, kein erzwungener Neustart.
    direct.createIceRestartOffer.mockClear();
    DU._resetDirectUpgradeForTests();
    await CM.setConnectionMode(CM.MODE_FAST);
    await tick(30);
    expect(direct.applyConnectionModeConfig).toHaveBeenCalledTimes(2);
    expect(direct.createIceRestartOffer).not.toHaveBeenCalled();
  });
});

describe('Entwickler-Testschalter "nur Tor" (getrennt von Stufe 3)', () => {
  test('wirkt wie bisher ohne Vollversion, aendert den Verbindungsweg nicht', async () => {
    await Tor.saveTorSettings({ bridgeMode: 'auto', forceTorTest: true });
    try {
      expect(CM.getConnectionMode()).toBe(CM.MODE_FAST);
      expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('nur-tor');
    } finally {
      await Tor.saveTorSettings({ bridgeMode: 'auto', forceTorTest: false });
    }
  });

  test('UI: Schalter nur in Entwickler-Builds (oder solange er noch an ist), Stufe 3 mit Pro-Hinweis und Vollversion-Seite', () => {
    const app = readSrc('App.tsx');
    expect(app).toMatch(/\{\(__DEV__ \|\| !!settings\.forceTorTest\) && \(/);
    expect(app).toMatch(/if \(next === MODE_TOR_ONLY && !canSelectTorOnlyMode\(pro\)\) \{ onOpenPro\?\.\(\); return; \}/);
    expect(app).toMatch(/<TorSettingsSection accent=\{curAC\} pro=\{pro\} onOpenPro=\{\(\) => setProOpen\(true\)\} \/>/);
    // Erklaert, wer die IP sieht (Texte seit der Uebersetzung in locales/de.js,
    // App.tsx liest sie je Stufe ueber connMode.<stufe>.who).
    expect(app).toMatch(/get who\(\) \{ return t\('connMode\.' \+ id \+ '\.who'\); \}/);
    const de = readSrc('locales/de.js');
    expect(de).toMatch(/'connMode\.torOnly\.who': 'Deine IP-Adresse sieht niemand – auch deine Kontakte nicht\.'/);
    expect(de).toMatch(/'connMode\.private\.who': 'Deine IP-Adresse sieht nur dein Kontakt, solange ihr direkt verbunden seid\.'/);
    expect(de).toMatch(/'connMode\.fast\.who': '[^']*zwei öffentliche STUN-Dienste deutscher Anbieter/);
    expect(de).not.toMatch(/STUN-Server von Malachi|eigener STUN-Server/);
  });
});
