// Serverlos (Okt. 2026): Wechsel von Tor auf eine Direktverbindung, ausgehandelt
// ueber die bestehende, angemeldete Tor-Verbindung (DirectUpgrade.js).
// Geprueft wird der echte Produktionscode (DirectUpgrade, RTCStore,
// TorTransport-Reserve, BackgroundSync-Verdrahtung); nur die WebRTC-
// PeerConnection selbst ist durch eine Attrappe ersetzt (kein natives WebRTC
// unter Jest):
//   - Aushandlung: Angebot/Antwort laufen als verschluesselte System-Nachricht
//     ueber die Tor-Verbindung, nie ueber einen Server,
//   - Glare-Vermeidung: nur die kleinere Onion-Adresse bietet an; bei
//     gleichzeitigen Angeboten gewinnt auf beiden Seiten dasselbe,
//   - erst nach fertigem Schluesseltausch wird direkt aktiv, Tor wird Reserve;
//     ein scheiternder Versuch stoert die Tor-Verbindung nicht,
//   - Rueckfall: bricht direkt weg, uebernimmt die Reserve sofort, danach
//     neuer Versuch mit Wartezeit,
//   - Netzwechsel: Direktverbindung wird per ICE-Neustart (ueber sich selbst)
//     gerettet statt geschlossen; liefert sie nichts mehr, wird sie geschlossen.
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

const ONION_A = 'a'.repeat(56) + '.onion';   // kleinste
const ONION_B = 'b'.repeat(56) + '.onion';
const ONION_C = 'c'.repeat(56) + '.onion';
const CONTACT = { id: 'c_peer', name: 'Peer', role: 'responder', torOnion: ONION_B };
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
// Nachricht der Gegenseite ueber die aktive Verbindung (wie nach dem
// Entschluesseln in WebRTCManager) - RTCStore routet sie.
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
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
  Tor._setTorStateForTests({ status: 'ON', onion: ONION_A });
  tor = torConn();
  RTCStore.setConnection(CONTACT.id, tor);
});
afterEach(() => {
  DU._resetDirectUpgradeForTests();
});

describe('Wer bietet an? (Glare-Vermeidung ohne Absprache)', () => {
  test('beide Seiten kommen zum selben Ergebnis: genau eine Seite bietet an - die kleinere Onion-Adresse', () => {
    for (const [x, y] of [[ONION_A, ONION_B], [ONION_C, ONION_A], [ONION_B, ONION_C]]) {
      for (const roleX of ['initiator', 'responder']) {
        const roleY = roleX === 'initiator' ? 'responder' : 'initiator';
        expect(DU.decideOfferer(x, y, roleX)).not.toBe(DU.decideOfferer(y, x, roleY));
        expect(DU.decideOfferer(x, y, roleX)).toBe(x < y);
      }
    }
  });
  test('Onion-Adresse unbekannt: die Rolle aus der Kopplung entscheidet (Einladender bietet an)', () => {
    expect(DU.decideOfferer(ONION_A, null, 'initiator')).toBe(true);
    expect(DU.decideOfferer(null, ONION_A, 'responder')).toBe(false);
  });
});

describe('Aushandlung ueber die Tor-Verbindung', () => {
  test('Anbieter: Angebot geht als System-Nachricht ueber die Tor-Verbindung (mit eigener Onion-Adresse), nichts ueber einen Server', async () => {
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('angebot');
    await tick(20);
    const offer = tor.sent.find((m) => m.subtype === 'direct_offer');
    expect(offer).toMatchObject({ type: 'system', sdp: { type: 'offer', sdp: 'v=0 angebot' }, onion: ONION_A });
    expect(offer.id).toMatch(/^[0-9a-f]{16}$/);
    expect(fakes()).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
    // Tor bleibt bis zum fertigen Schluesseltausch die aktive Verbindung.
    expect(RTCStore.connections.get(CONTACT.id)).toBe(tor);
  });

  test('Antwort mit falscher Kennung wird ignoriert, mit richtiger an die neue Verbindung uebergeben', async () => {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const { id } = tor.sent.find((m) => m.subtype === 'direct_offer');
    const direct = fakes()[0];
    await fromPeer(tor, { subtype: 'direct_answer', id: 'f'.repeat(16), sdp: { type: 'answer', sdp: 'v=0 fremd' } });
    expect(direct.handleAnswer).not.toHaveBeenCalled();
    await fromPeer(tor, { subtype: 'direct_answer', id, sdp: { type: 'answer', sdp: 'v=0 echt' } });
    expect(direct.handleAnswer).toHaveBeenCalledTimes(1);
    expect(JSON.parse(direct.handleAnswer.mock.calls[0][0]).sdp).toEqual({ type: 'answer', sdp: 'v=0 echt' });
  });

  test('erst nach fertigem Schluesseltausch wird direkt aktiv: Tor wird Reserve, frueh eingetroffene Nachrichten werden zugestellt', async () => {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const direct = fakes()[0];
    const seen = [];
    RTCStore.setMessageListener(CONTACT.id, (m) => seen.push(m));
    // Gegenseite war schneller fertig und sendet schon direkt:
    direct.onMessage({ type: 'system', subtype: 'profile_name', name: 'Peer' });
    expect(seen).toEqual([]);
    direct.keyExchangeDone = true;
    await direct._onKeyExchange();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);
    expect(tor.close).not.toHaveBeenCalled();
    expect(seen.map((m) => m.subtype)).toContain('profile_name');
    expect(DU.isUpgradeInProgress(CONTACT.id)).toBe(false);
    RTCStore.setMessageListener(CONTACT.id, null);
  });

  test('ein scheiternder Versuch stoert die funktionierende Tor-Verbindung nicht und wartet danach (Backoff)', async () => {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const direct = fakes()[0];
    direct._fireDisc();                                   // ICE scheitert
    expect(direct.close).toHaveBeenCalled();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(tor);
    expect(tor.close).not.toHaveBeenCalled();
    expect(DU._getBackoffForTests(CONTACT.id).nextAt - Date.now()).toBeGreaterThan(10000);
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'zyklus' })).toBe('wartet');
  });

  test('Kontakt loeschen/Wipe waehrend eines Versuchs: Versuch und Tor-Reserve werden mit Grund "wipe" geschlossen (kein Secret-Wiederherstellen danach)', async () => {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const direct = fakes()[0];
    // Zusaetzlich eine Tor-Reserve (ausserhalb von RTCStore.connections).
    const reserve = torConn();
    RTCStore.connections.set(CONTACT.id, reserve);
    Tor.demoteActiveTorToReserve(CONTACT.id);
    RTCStore.connections.set(CONTACT.id, tor);
    RTCStore.clearContact(CONTACT.id);
    expect(direct.close).toHaveBeenCalledWith('wipe');
    expect(reserve.close).toHaveBeenCalledWith('wipe');
    expect(DU.isUpgradeInProgress(CONTACT.id)).toBe(false);
    // Ein verspaeteter Schluesseltausch des Versuchs aktiviert nichts mehr.
    direct.keyExchangeDone = true;
    await direct._onKeyExchange();
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
  });

  test('Antworten-Seite: beantwortet ein Angebot ueber die Tor-Verbindung', async () => {
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });   // jetzt ist die Gegenseite (B) Anbieter
    await fromPeer(tor, { subtype: 'direct_offer', id: '1'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 x' }, onion: ONION_B });
    const direct = fakes()[0];
    expect(direct.createAnswerDirect).toHaveBeenCalled();
    expect(tor.sent.find((m) => m.subtype === 'direct_answer')).toMatchObject({ id: '1'.repeat(16), sdp: { type: 'answer', sdp: 'v=0 antwort' } });
  });
});

describe('Glare: beide bieten gleichzeitig an', () => {
  test('eigene Onion kleiner: fremdes Angebot wird abgelehnt (glare), eigenes laeuft weiter', async () => {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    await fromPeer(tor, { subtype: 'direct_offer', id: '2'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 y' }, onion: ONION_B });
    expect(tor.sent.find((m) => m.subtype === 'direct_reject')).toMatchObject({ id: '2'.repeat(16), reason: 'glare' });
    expect(fakes()).toHaveLength(1);
    expect(fakes()[0].close).not.toHaveBeenCalled();
    expect(DU.isUpgradeInProgress(CONTACT.id)).toBe(true);
  });

  test('eigene Onion groesser: eigenes Angebot wird verworfen (ohne Strafwartezeit), das der Gegenseite beantwortet', async () => {
    // Wir halten uns (Onion unbekannt -> Rolle 'initiator') faelschlich fuer den Anbieter.
    await EncryptedStorage.setItem('contacts', JSON.stringify([{ ...CONTACT, torOnion: null, role: 'initiator' }]));
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('angebot');
    await tick(20);
    await fromPeer(tor, { subtype: 'direct_offer', id: '3'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 z' }, onion: ONION_B });
    expect(fakes()[0].close).toHaveBeenCalled();
    expect(fakes()[1].createAnswerDirect).toHaveBeenCalled();
    expect(tor.sent.find((m) => m.subtype === 'direct_answer')).toMatchObject({ id: '3'.repeat(16) });
    expect(DU._getBackoffForTests(CONTACT.id)).toBeNull();
  });
});

describe('Nicht-Anbieter, Bitten, Testmodus', () => {
  beforeEach(() => { Tor._setTorStateForTests({ status: 'ON', onion: ONION_C }); });

  test('Routinezyklus: Nicht-Anbieter sendet nichts; nach Abbruch der Direktverbindung bittet er um ein Angebot', async () => {
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'zyklus' })).toBe('gegenseite');
    expect(tor.sent).toEqual([]);
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'direkt-weg' })).toBe('angefragt');
    expect(tor.sent[0]).toMatchObject({ subtype: 'direct_request', onion: ONION_C });
  });

  test('Anbieter startet auf eine Bitte hin sofort ein Angebot', async () => {
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_A });
    await fromPeer(tor, { subtype: 'direct_request', onion: ONION_B });
    expect(tor.sent.some((m) => m.subtype === 'direct_offer')).toBe(true);
  });

  test('Testmodus "nur Tor": kein Upgrade, fremde Angebote werden abgelehnt', async () => {
    await Tor.saveTorSettings({ bridgeMode: 'auto', forceTorTest: true });
    expect(await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' })).toBe('nur-tor');
    await fromPeer(tor, { subtype: 'direct_offer', id: '4'.repeat(16), sdp: { type: 'offer', sdp: 'v=0' }, onion: ONION_B });
    expect(tor.sent.find((m) => m.subtype === 'direct_reject')).toMatchObject({ reason: 'tor_only' });
    expect(fakes()).toHaveLength(0);
    await Tor.saveTorSettings({ bridgeMode: 'auto', forceTorTest: false });
  });

  test('ungueltige Signale (falscher Typ, riesiges SDP, kaputte Kennung) werden verworfen', async () => {
    await fromPeer(tor, { subtype: 'direct_offer', id: 'xyz', sdp: { type: 'offer', sdp: 'v=0' } });
    await fromPeer(tor, { subtype: 'direct_offer', id: '5'.repeat(16), sdp: { type: 'answer', sdp: 'v=0' } });
    await fromPeer(tor, { subtype: 'direct_offer', id: '6'.repeat(16), sdp: { type: 'offer', sdp: 'x'.repeat(40000) } });
    expect(fakes()).toHaveLength(0);
    expect(tor.sent).toEqual([]);
  });

  test('Upgrade-Signale erreichen nie die Chat-Oberflaeche oder den Puffer', async () => {
    const seen = [];
    RTCStore.setMessageListener(CONTACT.id, (m) => seen.push(m));
    await fromPeer(tor, { subtype: 'direct_request' });
    await fromPeer(tor, { subtype: 'direct_reject', reason: 'glare' });
    expect(seen).toEqual([]);
    RTCStore.setMessageListener(CONTACT.id, null);
    expect(RTCStore.buffer.has(CONTACT.id)).toBe(false);
  });
});

describe('Rueckfall auf die Tor-Reserve', () => {
  async function promoted() {
    await DU.maybeStartUpgrade(CONTACT.id, { reason: 'tor-bereit' });
    await tick(20);
    const direct = fakes()[0];
    direct.keyExchangeDone = true;
    await direct._onKeyExchange();
    return direct;
  }

  test('Direktverbindung bricht weg: Reserve uebernimmt sofort, neuer Upgrade-Versuch mit kurzer Wartezeit', async () => {
    const direct = await promoted();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    direct._fireDisc();
    expect(RTCStore.connections.get(CONTACT.id)).toBe(tor);
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(false);
    const b = DU._getBackoffForTests(CONTACT.id);
    expect(b.nextAt - Date.now()).toBeLessThanOrEqual(3000);
    expect(b.nextAt - Date.now()).toBeGreaterThan(1000);
  });

  test('Nachricht auf der Reserve, waehrend direkt nachweislich noch Daten liefert: zugestellt, aber KEIN Rueckwechsel auf Tor', async () => {
    const direct = await promoted();
    direct._lastActivity = Date.now();
    const seen = [];
    RTCStore.setMessageListener(CONTACT.id, (m) => seen.push(m));
    tor.onMessage({ type: 'text', text: 'kam noch ueber Tor', msgId: 'r1', time: Date.now() });
    expect(seen.map((m) => m.text)).toEqual(['kam noch ueber Tor']);
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    expect(direct.close).not.toHaveBeenCalled();
    RTCStore.setMessageListener(CONTACT.id, null);
  });
});

describe('Netzwechsel: Direktverbindung per ICE-Neustart retten statt schliessen', () => {
  jest.setTimeout(15000);

  function liveDirect(id) {
    const FakeRtc = require('../../WebRTCManager').WebRTCManager;
    const d = new FakeRtc(() => {}, () => {}, () => {});
    d.keyExchangeDone = true;
    RTCStore.connections.set(id, d);
    return d;
  }

  test('Anbieter: Neustart-Angebot geht ueber die Direktverbindung selbst; nur die tote Verbindung wird nach 5 s geschlossen', async () => {
    const OTHER = { id: 'c_zweit', name: 'Zweit', role: 'responder', torOnion: ONION_C };
    await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT, OTHER]));
    RTCStore.connections.delete(CONTACT.id);
    const dead = liveDirect(CONTACT.id);
    const alive = liveDirect(OTHER.id);
    BG._resetTorFallbackForTests();
    // Netzwechsel ueber den echten Hook (TorTransport -> BackgroundSync).
    Tor.handleNetworkChange({ type: 'wifi', isConnected: true, details: { ipAddress: '192.168.1.2' } });
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.0.0.2' } });
    await tick(900);                                  // Neustart startet nach kurzer Wartezeit (700 ms)
    expect(dead.close).not.toHaveBeenCalled();
    expect(dead.createIceRestartOffer).toHaveBeenCalled();
    const restart = dead.sent.find((m) => m.subtype === 'direct_offer');
    expect(restart).toMatchObject({ restart: true, sdp: { type: 'offer', sdp: 'v=0 neustart' } });
    // Antwort kommt ueber dieselbe Verbindung zurueck.
    dead.onMessage = null;
    await DU.handleUpgradeSignal(CONTACT.id, { subtype: 'direct_answer', restart: true, id: restart.id, sdp: { type: 'answer', sdp: 'v=0 a' } });
    expect(dead.acceptIceRestartAnswer).toHaveBeenCalledTimes(1);
    // Die andere Verbindung liefert weiter Daten (Lebenszeichen), die erste nicht.
    const keepAlive = setInterval(() => { alive._lastActivity = Date.now(); }, 500);
    await tick(4800);
    clearInterval(keepAlive);
    expect(dead.close).toHaveBeenCalled();
    expect(alive.close).not.toHaveBeenCalled();
  });

  test('Nicht-Anbieter: bittet die Gegenseite ueber die Direktverbindung um den Neustart; die Gegenseite beantwortet ein Neustart-Angebot auf derselben Verbindung', async () => {
    Tor._setTorStateForTests({ status: 'ON', onion: ONION_C });
    RTCStore.connections.delete(CONTACT.id);
    const d = liveDirect(CONTACT.id);
    DU.onLocalNetworkChange();
    await tick(900);
    expect(d.sent[0]).toMatchObject({ subtype: 'direct_request', restart: true });
    await DU.handleUpgradeSignal(CONTACT.id, { subtype: 'direct_offer', restart: true, id: '7'.repeat(16), sdp: { type: 'offer', sdp: 'v=0 n' }, onion: ONION_B });
    expect(d.acceptIceRestartOffer).toHaveBeenCalled();
    expect(d.sent.find((m) => m.subtype === 'direct_answer')).toMatchObject({ restart: true, id: '7'.repeat(16) });
    d._lastActivity = Date.now() + 10000;   // Verbindung traegt -> nicht schliessen
  });
});
