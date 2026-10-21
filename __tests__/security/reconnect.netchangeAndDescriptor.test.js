// Live-Test 2026-10-17, zweite Runde (Neustart Pixel 8: wieder 66 s):
//   1. Netzwechsel startete tor jedes Mal komplett neu - ein frisches tor
//      braucht 24 s nur fuer die Onion-Beschreibung des Kontakts. Jetzt: erst
//      nur das Netz neu (resetNetwork, Beschreibungen bleiben), Neustart nur,
//      wenn tor im neuen Netz keine Kreise baut.
//   2. Versuche, die waehrend des Beschreibungs-Abrufs liefen, hingen bis zum
//      Zeitlimit; ein danach gestarteter stand in 3 s. Jetzt: kommt die
//      Beschreibung an (nativ HS_DESC RECEIVED), sofort ein frischer Versuch.
//   3. Veraltete Kontakte wurden bei jedem Netzwechsel bis zu 12x abgelehnt -
//      ab 10 pro Minute sperrt die Gegenseite ALLE Anmeldungen. Jetzt: nach
//      einer Ablehnung 5 min Ruhe, auch ueber Netzwechsel/Neustart hinweg.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, DeviceEventEmitter } = require('react-native');

const MY_ONION = 'a'.repeat(56) + '.onion';
const PEER_ONION = 'b'.repeat(56) + '.onion';
let health = { running: true, freshCircuits: 0 };
NativeModules.MalachiTor = {
  addListener() {},
  removeListeners() {},
  start: jest.fn(async () => ({ onion: MY_ONION, socksPort: 9050 })),
  stop: jest.fn(async () => {}),
  connect: jest.fn(async () => 'out-x'),
  send: jest.fn(async () => {}),
  close: jest.fn(),
  refreshCircuits: jest.fn(async () => true),
  resetNetwork: jest.fn(async () => true),
  health: jest.fn(async () => health),
};

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const Tor = require('../../TorTransport');
const BG = require('../../BackgroundSync');

const SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_net', name: 'Kev', role: 'responder', torOnion: PEER_ONION };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const feed = (connId, obj) => DeviceEventEmitter.emit('MalachiTorLine', { connId, line: JSON.stringify(obj) });
const nonce = () => crypto.randomBytes(24).toString('base64url');

beforeEach(async () => {
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  jest.clearAllMocks();
  health = { running: true, freshCircuits: 0 };
  Tor._resetTorTransportForTests();
  BG._resetTorFallbackForTests();
  RTCStore.resetAll();
  await EncryptedStorage.clear();
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
  await EncryptedStorage.setItem('shared_secret_' + CONTACT.id, SECRET);
  RTCStore.sharedSecrets.set(CONTACT.id, SECRET);
  Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
});
afterEach(() => { delete NativeModules.MalachiTor.connectWithTimeout; });

describe('Netzwechsel ohne tor-Neustart', () => {
  test('nur das Netz wird neu verbunden; sobald neue Kreise stehen, werden alle Kontakte angewaehlt - kein Neustart', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise(() => {}));
    Tor.handleNetworkChange({ type: 'wifi', isConnected: true, details: { ipAddress: '192.168.1.5' } });
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.0.0.7' } });
    expect(NativeModules.MalachiTor.resetNetwork).toHaveBeenCalledTimes(1);
    await tick(700);
    expect(NativeModules.MalachiTor.connectWithTimeout).not.toHaveBeenCalled();   // noch keine neuen Kreise
    health = { running: true, freshCircuits: 2 };
    await tick(700);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledWith(PEER_ONION, 7777, expect.any(Number));
    expect(NativeModules.MalachiTor.stop).not.toHaveBeenCalled();
    expect(NativeModules.MalachiTor.refreshCircuits).not.toHaveBeenCalled();     // Beschreibungen bleiben
  });

  test('baut tor im neuen Netz keine Kreise: wie bisher frisch starten', async () => {
    Tor._setLightResetGiveUpForTests(600);
    Tor.handleNetworkChange({ type: 'wifi', isConnected: true, details: { ipAddress: '192.168.1.5' } });
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.0.0.7' } });
    await tick(2500);
    expect(NativeModules.MalachiTor.stop).toHaveBeenCalledTimes(1);
    expect(Tor.getTorState().status).toBe('ON');
  });

  test('kurz nach dem Wechsel loest schon eine gescheiterte Einfuehrung das Zuruecksetzen aus (einmal)', async () => {
    NativeModules.MalachiTor.resetNetwork.mockImplementation(async () => true);
    Tor.handleNetworkChange({ type: 'wifi', isConnected: true, details: { ipAddress: '192.168.1.5' } });
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.0.0.7' } });
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Tor: Einfuehrung gescheitert'); });
    await Tor.connectViaTor(CONTACT);
    expect(NativeModules.MalachiTor.refreshCircuits).toHaveBeenCalledTimes(1);
    await Tor.connectViaTor(CONTACT);
    expect(NativeModules.MalachiTor.refreshCircuits).toHaveBeenCalledTimes(1);
  });

  test('ohne Netzwechsel zaehlt eine gescheiterte Einfuehrung nicht (tor loest das selbst)', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Tor: Einfuehrung gescheitert'); });
    for (let i = 0; i < 3; i++) await Tor.connectViaTor(CONTACT);
    expect(NativeModules.MalachiTor.refreshCircuits).not.toHaveBeenCalled();
  });
});

describe('frischer Versuch, sobald die Onion-Beschreibung eintrifft', () => {
  test('laeuft ein Versuch zum Kontakt: sofort ein zweiter; ohne laufenden Versuch oder fuer fremde Adressen: nichts', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise(() => {}));
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: PEER_ONION });
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).not.toHaveBeenCalled();   // kein laufender Versuch
    await BG.connectAllNow();
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(1);
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: 'c'.repeat(56) + '.onion' });
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(1);
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: PEER_ONION });
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(2);
    // Gleich noch einmal: gedrosselt (hoechstens alle 15 s je Kontakt).
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: PEER_ONION });
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(2);
  });

  test('ungueltige Adresse im Ereignis wird ignoriert', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise(() => {}));
    await BG.connectAllNow();
    await tick(30);
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: 'kein-onion' });
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('abgelehnte Kontakte: 5 min Ruhe, auch ueber Netzwechsel und Neustart', () => {
  // Gegenseite nimmt an, schickt ihre Nonce und schliesst nach unserer Anmeldung.
  function rejectingPeer() {
    let n = 0;
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => {
      const id = 'rej-' + (++n);
      setTimeout(() => {
        feed(id, { t: 'malachi-tor', v: 1, step: 'challenge', nonce: nonce() });
        setTimeout(() => DeviceEventEmitter.emit('MalachiTorClosed', { connId: id }), 10);
      }, 5);
      return id;
    });
  }

  test('nach der Ablehnung waehlt der Netzwechsel-Neuaufbau den Kontakt nicht erneut an; der Merker ist gespeichert', async () => {
    rejectingPeer();
    await BG.reconnectAllViaTorNow({});
    await tick(150);
    const first = NativeModules.MalachiTor.connectWithTimeout.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(await EncryptedStorage.getItem('tor_rejected_until'));
    expect(stored[CONTACT.id]).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    // Netzwechsel: Wartezeiten werden aufgehoben - der abgelehnte Kontakt bleibt trotzdem in Ruhe.
    await BG.reconnectAllViaTorNow({});
    await BG.runOutgoingCycle({});
    await tick(150);
    expect(NativeModules.MalachiTor.connectWithTimeout.mock.calls.length).toBe(first);
  });

  test('nach einem Neustart (Merker aus dem Speicher) ebenso; "Jetzt verbinden" versucht es trotzdem', async () => {
    await EncryptedStorage.setItem('tor_rejected_until', JSON.stringify({ [CONTACT.id]: Date.now() + 5 * 60 * 1000 }));
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise(() => {}));
    await BG.reconnectAllViaTorNow({});
    await BG.runOutgoingCycle({});
    await tick(50);
    expect(NativeModules.MalachiTor.connectWithTimeout).not.toHaveBeenCalled();
    await BG.connectAllNow({});
    await tick(50);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('veraltete Kontakte und Loeschen ohne Verbindung (Live-Test 2026-10-18)', () => {
  test('lehnt die Gegenseite WIEDERHOLT ab, wird der Kontakt als "veraltet" markiert; steht wieder eine Verbindung, verschwindet die Markierung', async () => {
    let n = 0;
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => {
      const id = 'st-' + (++n);
      setTimeout(() => {
        feed(id, { t: 'malachi-tor', v: 1, step: 'challenge', nonce: nonce() });
        setTimeout(() => DeviceEventEmitter.emit('MalachiTorClosed', { connId: id }), 10);
      }, 5);
      return id;
    });
    const staleNow = async () => JSON.parse(await EncryptedStorage.getItem('contacts')).find((c) => c.id === CONTACT.id).stale;
    await BG.connectAllNow({});
    await tick(200);
    expect(await staleNow()).not.toBe(true);            // eine Ablehnung reicht nicht (evtl. nur Sperre dort)
    await BG.connectAllNow({});
    await tick(200);
    expect(await staleNow()).toBe(true);
    // Verbindung steht wieder (z.B. von der Gegenseite aufgebaut): Markierung weg.
    RTCStore.connections.set(CONTACT.id, { transport: 'tor', keyExchangeDone: true, dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' }, close() {} });
    await BG.runOutgoingCycle({});
    await tick(50);
    expect(await staleNow()).toBe(false);
  });

  test('Kontakt geloescht, waehrend keine Verbindung besteht: sofort ueber Tor verbinden, damit der Loesch-Hinweis zugestellt wird', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise(() => {}));
    const r = await BG.requestContactDeletion(CONTACT.id);
    expect(r).toBe('pending');
    await tick(100);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledWith(PEER_ONION, 7777, expect.any(Number));
  });
});

describe('ueberlastete Einstiegsknoten (Live-Test 2026-10-18: Pixel 8, ~40 % Kreise verloren)', () => {
  test('Neustart mit Pfad-Bias-Warnungen: neue Wachen waehlen lassen - ab 3 Warnungen, hoechstens alle 30 Tage (Audit T5)', async () => {
    NativeModules.MalachiTor.resetGuards = jest.fn(async () => true);
    health = { running: true, freshCircuits: 1, guardWarnings: 2 };
    await Tor.restartTor();
    expect(NativeModules.MalachiTor.resetGuards).not.toHaveBeenCalled();     // 2 Warnungen reichen nicht
    Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
    health = { running: true, freshCircuits: 1, guardWarnings: 3 };
    await Tor.restartTor();
    expect(NativeModules.MalachiTor.stop).toHaveBeenCalled();
    expect(NativeModules.MalachiTor.resetGuards).toHaveBeenCalledTimes(1);
    expect(Number(await EncryptedStorage.getItem('tor_guard_reset_at'))).toBeGreaterThan(0);
    Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
    await Tor.restartTor();
    expect(NativeModules.MalachiTor.resetGuards).toHaveBeenCalledTimes(1);   // 30-Tage-Sperre
    delete NativeModules.MalachiTor.resetGuards;
  });

  test('ohne Warnungen bleiben die Wachen', async () => {
    NativeModules.MalachiTor.resetGuards = jest.fn(async () => true);
    health = { running: true, freshCircuits: 1, guardWarnings: 0 };
    await Tor.restartTor();
    expect(NativeModules.MalachiTor.resetGuards).not.toHaveBeenCalled();
    delete NativeModules.MalachiTor.resetGuards;
  });
});
