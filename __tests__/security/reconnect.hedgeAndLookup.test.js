// Live-Test 2026-10-17 (Neustart des Pixel 8): 60 s bis zur Wiederverbindung.
//   1. Der erste Tor-Versuch kam nach 29 s an - war aber nach 25 s schon
//      abgebrochen, danach 15 s Pause. Jetzt: laengeres Zeitlimit und nach
//      12 s ein paralleler Zusatzversuch (nativ mit eigenen Tor-Kreisen).
//   2. Das Zuruecksetzen der Onion-Suche (NEWNYM leert die Beschreibungen
//      ALLER Kontakte) loesten veraltete Kontakte jede Minute aus. Jetzt nur
//      bei tors "Onion-Beschreibung nicht gefunden", je Onion einmal bis zum
//      naechsten Erfolg und hoechstens alle 3 min.
//   3. Kaltstart: sobald Tor steht, sofort alle Kontakte anwaehlen.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');

const MY_ONION = 'a'.repeat(56) + '.onion';
const PEER_ONION = 'b'.repeat(56) + '.onion';
NativeModules.MalachiTor = {
  addListener() {},
  removeListeners() {},
  start: jest.fn(),
  stop: jest.fn(async () => {}),
  connect: jest.fn(async () => 'out-x'),
  send: jest.fn(async () => {}),
  close: jest.fn(),
  refreshCircuits: jest.fn(async () => true),
};

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const Tor = require('../../TorTransport');
const BG = require('../../BackgroundSync');

const SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_hedge', name: 'Kev', role: 'responder', torOnion: PEER_ONION };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const NOT_FOUND = 'Tor: Onion-Beschreibung nicht gefunden';

beforeEach(async () => {
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  jest.clearAllMocks();
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

describe('Zusatzversuch bei haengendem Tor-Aufbau', () => {
  test('erster Versuch haengt: nach der Frist startet ein zweiter zum selben Kontakt; laengeres Zeitlimit je Versuch', async () => {
    const calls = [];
    NativeModules.MalachiTor.connectWithTimeout = jest.fn((onion, port, timeoutMs) => {
      calls.push({ onion, port, timeoutMs, at: Date.now() });
      return new Promise(() => {});                        // haengt
    });
    BG._setTorHedgeAfterForTests(80);
    await BG.connectAllNow();
    await tick(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ onion: PEER_ONION, port: 7777 });
    expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(40000);
    await tick(120);
    expect(calls).toHaveLength(2);
    expect(calls[1].onion).toBe(PEER_ONION);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(70);
    expect(BG._getTorAttemptForTests(CONTACT.id).running).toBe(true);
  });

  test('scheitert der erste Versuch vor der Frist: kein Zusatzversuch, normale Wartezeit', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Connect timed out'); });
    BG._setTorHedgeAfterForTests(60);
    await BG.connectAllNow();
    await tick(150);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledTimes(1);
    const t = BG._getTorAttemptForTests(CONTACT.id);
    expect(t.running).toBe(false);
    expect(t.nextAt).toBeGreaterThan(Date.now());
  });

  test('erst wenn auch der Zusatzversuch scheitert, greift die Wartezeit', async () => {
    let n = 0;
    const rejects = [];
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise((_, rej) => { n++; rejects.push(rej); }));
    BG._setTorHedgeAfterForTests(40);
    await BG.connectAllNow();
    await tick(100);
    expect(n).toBe(2);
    rejects[0](new Error('Connect timed out'));
    await tick(20);
    expect(BG._getTorAttemptForTests(CONTACT.id).running).toBe(true);   // Zusatzversuch laeuft noch
    rejects[1](new Error('Connect timed out'));
    await tick(20);
    const t = BG._getTorAttemptForTests(CONTACT.id);
    expect(t.running).toBe(false);
    expect(t.nextAt).toBeGreaterThan(Date.now());
  });
});

describe('Onion-Suche zuruecksetzen (NEWNYM) nur gezielt', () => {
  test('Zeitueberschreitungen loesen es nie aus', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Connect timed out'); });
    for (let i = 0; i < 4; i++) await Tor.connectViaTor(CONTACT);
    expect(NativeModules.MalachiTor.refreshCircuits).not.toHaveBeenCalled();
  });

  test('zweimal "nicht gefunden": einmal zuruecksetzen; dieselbe Onion danach erst wieder nach einem Erfolg', async () => {
    const realNow = Date.now;
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error(NOT_FOUND); });
      await Tor.connectViaTor(CONTACT);
      expect(NativeModules.MalachiTor.refreshCircuits).not.toHaveBeenCalled();
      await Tor.connectViaTor(CONTACT);
      expect(NativeModules.MalachiTor.refreshCircuits).toHaveBeenCalledTimes(1);
      // Viel spaeter, weiter "nicht gefunden" (z.B. dort deinstalliert): kein weiteres NEWNYM.
      offset += 10 * 60 * 1000;
      for (let i = 0; i < 3; i++) await Tor.connectViaTor(CONTACT);
      expect(NativeModules.MalachiTor.refreshCircuits).toHaveBeenCalledTimes(1);
      // Ein Erfolg setzt den Merker zurueck.
      NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => 'out-ok');
      Tor.connectViaTor(CONTACT).catch(() => {});        // Anmeldung laeuft ins Leere - egal
      await tick(20);
      NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error(NOT_FOUND); });
      offset += 10 * 60 * 1000;
      await Tor.connectViaTor(CONTACT);
      await Tor.connectViaTor(CONTACT);
      expect(NativeModules.MalachiTor.refreshCircuits).toHaveBeenCalledTimes(2);
    } finally {
      Date.now.mockRestore();
    }
  });

  test('hoechstens alle 3 min - auch fuer verschiedene Kontakte', async () => {
    const OTHER = { ...CONTACT, id: 'c_other', torOnion: 'c'.repeat(56) + '.onion' };
    await EncryptedStorage.setItem('shared_secret_' + OTHER.id, SECRET);
    RTCStore.sharedSecrets.set(OTHER.id, SECRET);
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error(NOT_FOUND); });
    await Tor.connectViaTor(CONTACT);
    await Tor.connectViaTor(CONTACT);
    await Tor.connectViaTor(OTHER);
    await Tor.connectViaTor(OTHER);
    expect(NativeModules.MalachiTor.refreshCircuits).toHaveBeenCalledTimes(1);
  });
});

describe('Kaltstart', () => {
  test('sobald Tor zum ersten Mal steht, werden alle Kontakte sofort angewaehlt (ohne den 8-s-Zyklus)', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(() => new Promise(() => {}));
    Tor._resetTorTransportForTests();                     // Tor aus
    BG.startColdStartReconnect();
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).not.toHaveBeenCalled();
    Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
    await tick(50);
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledWith(PEER_ONION, 7777, expect.any(Number));
    // Spaetere Statuswechsel (z.B. Neustart nach Netzwechsel) loesen es nicht erneut aus.
    NativeModules.MalachiTor.connectWithTimeout.mockClear();
    Tor._setTorStateForTests({ status: 'OFF', onion: null });
    Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
    await tick(30);
    expect(NativeModules.MalachiTor.connectWithTimeout).not.toHaveBeenCalled();
  });
});

describe('statisch', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n');

  test('nativ: jeder Onion-Aufbau mit eigener SOCKS-Anmeldung (eigene Kreise) und tors genauem Fehlergrund', () => {
    const kt = read('android/app/src/main/java/com/securecommapp/tor/MalachiTorModule.kt');
    expect(kt).toMatch(/val socket = openIsolatedSocks\(onion, port, proxyPort/);
    expect(kt).toMatch(/out\.write\(byteArrayOf\(5, 1, 2\)\)/);          // nur Benutzername/Passwort
    expect(kt).toMatch(/SocksPort auto ExtendedErrors/);
    expect(kt).toMatch(/0xF0 -> "Onion-Beschreibung nicht gefunden"/);
  });

  test('Direktverbindung weg ohne Reserve: Zyklus wird erzwungen (auch Rolle responder ohne Vorlauf)', () => {
    const bg = read('BackgroundSync.js');
    expect(bg).toMatch(/onDirectLost: \(contactId, promoted\) => \{\n\s+if \(!promoted\) \{\n\s+const t = setTimeout\(\(\) => \{ forceNextCycle = true; runOutgoingCycle\(lastCycleOptions\); \}, 300\);/);
  });
});

describe('Onion-Beschreibung gezielt neu holen (HSFETCH)', () => {
  test('nach einem Fehlschlag: genau diese Adresse neu holen, hoechstens alle 30 s; kein NEWNYM', async () => {
    NativeModules.MalachiTor.refetchDescriptor = jest.fn(async () => true);
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Connect timed out'); });
    await Tor.connectViaTor(CONTACT);
    await Tor.connectViaTor(CONTACT);
    expect(NativeModules.MalachiTor.refetchDescriptor).toHaveBeenCalledTimes(1);
    expect(NativeModules.MalachiTor.refetchDescriptor).toHaveBeenCalledWith(PEER_ONION);
    expect(NativeModules.MalachiTor.refreshCircuits).not.toHaveBeenCalled();
    delete NativeModules.MalachiTor.refetchDescriptor;
  });
});

describe('Kopplung (scannende Seite)', () => {
  test('Einladender nicht erreichbar: Beschreibung gezielt neu holen, kein NEWNYM bei Zeitueberschreitung', async () => {
    NativeModules.MalachiTor.refetchDescriptor = jest.fn(async () => true);
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Connect timed out'); });
    const r = await Tor.pairViaTor({ onion: PEER_ONION, token: 'ABCD1234', pskB64: Buffer.from('x'.repeat(16)).toString('base64'), contactId: 'c_new', onPaired: () => {} });
    expect(r).toBeNull();
    expect(NativeModules.MalachiTor.refetchDescriptor).toHaveBeenCalledWith(PEER_ONION);
    expect(NativeModules.MalachiTor.refreshCircuits).not.toHaveBeenCalled();
    delete NativeModules.MalachiTor.refetchDescriptor;
  });

  test('eintreffende Beschreibung benachrichtigt wartende Kopplung; Zeitstempel wird gemerkt', () => {
    const { DeviceEventEmitter } = require('react-native');
    const since = Date.now();
    const seen = [];
    const stop = Tor.onDescriptorReceived(PEER_ONION, () => seen.push(1));
    expect(Tor.descriptorReceivedSince(PEER_ONION, since)).toBe(false);
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: PEER_ONION });
    expect(seen).toEqual([1]);
    expect(Tor.descriptorReceivedSince(PEER_ONION, since)).toBe(true);
    stop();
    DeviceEventEmitter.emit('MalachiTorDescReceived', { onion: PEER_ONION });
    expect(seen).toEqual([1]);
  });
});
