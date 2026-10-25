// Verbindungsweg (ConnectionMode.js) - seit dem STUN-Ausstieg zwei Stufen:
//   2 "Direkt, wenn moeglich" (Standard, ohne STUN),
//   3 "Maximal anonym (nur Tor)" (Vollversion).
// (Die fruehere Stufe 1 "Schnell (mit STUN)" gibt es nicht mehr - ihre
// Umstellung prueft connectionMode.migration.test.js.)
// Geprueft wird der echte Produktionscode (ConnectionMode, WebRTCManager-
// Konfiguration, DirectUpgrade, RTCStore, TorTransport-Reserve,
// LicenseManager-Regel); nur die WebRTC-Direktverbindung selbst ist durch eine
// Attrappe ersetzt (kein natives WebRTC unter Jest):
//   - ICE-Server: keine (kein STUN, kein TURN), Stufe 3 baut gar keine
//     PeerConnection, ausfallsicher bei unlesbarer Einstellung,
//   - Pro-Regel: Stufe 3 neu waehlen nur mit Vollversion, eine aktive Stufe 3
//     bleibt auch ohne Lizenz aktiv (wie die Duress-PIN),
//   - Stufe 3 verhindert jedes Direkt-Upgrade (eigene Versuche, Angebote und
//     Bitten der Gegenseite, ICE-Neustarts),
//   - Stufenwechsel wirkt ohne Neustart: Direktverbindungen werden sofort auf
//     Tor zurueckgestuft, laufende Versuche abgebrochen; zurueck auf "Direkt,
//     wenn moeglich" wird sofort wieder direkt versucht.
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
  test('"Direkt, wenn moeglich": keine ICE-Server (kein STUN, kein TURN); Stufe 3 baut keine PeerConnection', () => {
    expect(CM.CONNECTION_MODES).toEqual([CM.MODE_DIRECT, CM.MODE_TOR_ONLY]);
    expect(CM.DEFAULT_CONNECTION_MODE).toBe(CM.MODE_DIRECT);
    expect(CM.iceServersForMode).toBeUndefined();
    const cfg = pcConfigForMode(CM.MODE_DIRECT);
    expect(cfg).toEqual({ iceServers: [], iceTransportPolicy: 'all', tcpCandidatePolicy: 'enabled' });
    // Auch ein (frueherer) Wert 1 oder Unsinn bekommt nie einen ICE-Server.
    expect(pcConfigForMode(1).iceServers).toEqual([]);
    expect(pcConfigForMode(undefined).iceServers).toEqual([]);
    expect(() => pcConfigForMode(CM.MODE_TOR_ONLY)).toThrow(/nur Tor/);
  });

  test('ohne gespeicherte Einstellung gilt "Direkt, wenn moeglich"; die gespeicherte Stufe gilt sofort und nach einem Neustart', async () => {
    expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
    expect((await pcConfigForCalls()).iceServers).toEqual([]);
    // Nichts wird nur wegen des Standards gespeichert.
    expect(await EncryptedStorage.getItem(CM.CONNECTION_MODE_STORAGE_KEY)).toBeNull();
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await expect(pcConfigForCalls()).rejects.toMatchObject({ name: 'TorOnlyModeError' });
    expect(await restartApp()).toBe(CM.MODE_TOR_ONLY);
    expect(await CM.setConnectionMode(CM.MODE_DIRECT)).toEqual({ ok: true, mode: CM.MODE_DIRECT });
    expect(await EncryptedStorage.getItem(CM.CONNECTION_MODE_STORAGE_KEY)).toBe('2');
    expect(await restartApp()).toBe(CM.MODE_DIRECT);
    expect((await pcConfigForCalls()).iceServers).toEqual([]);
  });

  test('die fruehere Stufe 1 "Schnell (mit STUN)" ist nicht mehr waehlbar', async () => {
    expect(CM.canSelectConnectionMode(1)).toBe(false);
    expect(await CM.setConnectionMode(1)).toMatchObject({ ok: false, reason: 'ungueltig' });
    expect(await EncryptedStorage.getItem(CM.CONNECTION_MODE_STORAGE_KEY)).toBeNull();
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
    expect(await CM.connectionModeForDecision()).toBe(CM.MODE_DIRECT);
  });

  test('statisch: WebRTCManager hat fest keine ICE-Server (kein STUN-Eintrag, keine STUN-Rotation)', () => {
    const src = readSrc('WebRTCManager.js');
    expect(src).toMatch(/iceServers: \[\],/);
    expect(src).not.toMatch(/iceServersForMode|STUN_POOL|STUN_URL/);
    expect(readSrc('ConnectionMode.js')).not.toMatch(/STUN_POOL|STUN_PER_CONNECTION|stunRotation/);
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
    expect(r).toEqual({ ok: false, mode: CM.MODE_DIRECT, reason: 'pro' });
    expect(CM.getConnectionMode()).toBe(CM.MODE_DIRECT);
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
    expect((await CM.setConnectionMode(CM.MODE_DIRECT, { pro: false })).ok).toBe(true);
    expect(await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: false })).toMatchObject({ ok: false, reason: 'pro' });
  });

  test('ConnectionMode liest den Lizenzzustand nie selbst (eine Lizenzpruefung kann Stufe 3 nicht abschalten)', () => {
    const src = readSrc('ConnectionMode.js');
    expect(src).not.toMatch(/from '\.\/LicenseManager'|require\('\.\/LicenseManager'\)|isPro(Verified)?\(/);
    expect(src.match(/^import .*$/gm)).toEqual([
      "import EncryptedStorage from 'react-native-encrypted-storage';",
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
    await CM.setConnectionMode(CM.MODE_DIRECT);
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

  test('zurueck auf "Direkt, wenn moeglich": sofort neuer Versuch (Wartezeiten aufgehoben); als Nicht-Anbieter mit Bitte an die Gegenseite', async () => {
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await CM.setConnectionMode(CM.MODE_DIRECT);
    await tick(30);
    expect(tor.sent.some((m) => m.subtype === 'direct_offer')).toBe(true);

    DU._resetDirectUpgradeForTests();
    tor.sent.length = 0;
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });   // jetzt bietet die Gegenseite an
    await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
    await CM.setConnectionMode(CM.MODE_DIRECT);
    await tick(30);
    expect(tor.sent.find((m) => m.subtype === 'direct_request')).toBeTruthy();
  });

  test('"Direkt, wenn moeglich" erneut bestaetigen: bestehende Direktverbindung bleibt unberuehrt (kein Neustart, keine neue Konfiguration)', async () => {
    // Frueher zog der Wechsel Stufe 1 -> 2 Direktverbindungen per ICE-Neustart
    // auf Kandidaten ohne STUN um. Ohne STUN-Stufe gibt es diesen Fall nicht
    // mehr - jede Direktverbindung entsteht schon ohne STUN.
    const direct = await promotedDirect();
    expect(await CM.setConnectionMode(CM.MODE_DIRECT)).toEqual({ ok: true, mode: CM.MODE_DIRECT });
    await tick(30);
    expect(direct.createIceRestartOffer).not.toHaveBeenCalled();
    expect(direct.close).not.toHaveBeenCalled();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    expect(readSrc('DirectUpgrade.js')).not.toMatch(/applyConnectionModeConfig|MODE_FAST|MODE_PRIVATE/);
    expect(readSrc('WebRTCManager.js')).not.toMatch(/applyConnectionModeConfig/);
  });
});

describe('Entwickler-Testschalter "nur Tor" (getrennt von Stufe 3)', () => {
  test('wirkt wie bisher ohne Vollversion, aendert den Verbindungsweg nicht', async () => {
    await Tor.saveTorSettings({ bridgeMode: 'auto', forceTorTest: true });
    try {
      expect(CM.getConnectionMode()).toBe(CM.MODE_DIRECT);
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
    // STUN-Ausstieg (L5/L6): der Kontakt sieht die Adressen schon beim
    // Verbindungsversuch; der Tor-Eintrittsknoten sieht die IP immer.
    const de = readSrc('locales/de.js');
    expect(de).toMatch(/'connMode\.torOnly\.who': 'Deine IP-Adresse sehen weder Kontakte noch ein Server – nur der Tor-Eintrittsknoten, der nicht weiß, mit wem du sprichst\.'/);
    expect(de).toMatch(/'connMode\.direct\.who': 'Deine IP-Adresse sieht dein Kontakt – schon wenn eure Geräte versuchen, sich direkt zu verbinden\. Kein STUN-Dienst und kein Malachi-Server ist beteiligt\./);
    expect(de).not.toMatch(/'connMode\.(fast|private)\./);
    expect(de).not.toMatch(/solange ihr direkt verbunden seid|Deine IP-Adresse sieht niemand|STUN-Dienste deutscher Anbieter/);
    expect(de).not.toMatch(/STUN-Server von Malachi|eigener STUN-Server/);
  });
});
