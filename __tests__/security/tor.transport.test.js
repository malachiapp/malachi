// Tor-Ausweichweg (TorTransport.js + WebRTCManager.attachTorChannel +
// BackgroundSync-Steuerung). Das native Modul (Tor selbst) ist gemockt - hier
// wird die gesamte Sicherheitslogik darueber tatsaechlich ausgefuehrt:
//   - gegenseitige Anmeldung (HMAC ueber das Kontakt-Geheimnis, frische Nonces,
//     an die Onion-Adresse gebunden), Ablehnung Unbekannter/Falscher,
//     keine globale Sperre (Audit A2/T3), Obergrenze unangemeldeter Verbindungen,
//   - kompletter Kyber-Schluesseltausch + verschluesselte Nachricht ueber den
//     Tor-Kanal (identisches Protokoll wie direkt),
//   - automatische Bridge-Stufen, Pruefung eigener Bridges,
//   - wann Tor einspringt, Speicherung empfangener Onion-Adressen.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, DeviceEventEmitter } = require('react-native');
NativeModules.KyberModule.generateKeypair = async () => {
  const sk = crypto.randomBytes(16).toString('hex');
  return { publicKey: 'pub_' + sk, secretKey: sk };
};
NativeModules.KyberModule.encapsulate = async () => {
  const ss = crypto.randomBytes(32).toString('base64');
  return { sharedSecret: ss, cipherText: Buffer.from(ss).toString('base64') };
};
NativeModules.KyberModule.decapsulate = async (ct) => Buffer.from(ct, 'base64').toString('utf8');

const MY_ONION = 'a'.repeat(56) + '.onion';
const PEER_ONION = 'b'.repeat(56) + '.onion';
const sent = [];
const closed = [];
NativeModules.MalachiTor = {
  addListener() {},
  removeListeners() {},
  start: jest.fn(),
  stop: jest.fn(async () => {}),
  connect: jest.fn(async () => 'out-1'),
  send: jest.fn(async (connId, line) => { sent.push({ connId, line }); }),
  close: jest.fn((connId) => { closed.push(connId); }),
};

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const { WebRTCManager } = require('../../WebRTCManager');
const Tor = require('../../TorTransport');
const BG = require('../../BackgroundSync');

const SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_kev', name: 'Kev', role: 'initiator', torOnion: PEER_ONION };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const linesFor = (connId) => sent.filter((x) => x.connId === connId).map((x) => JSON.parse(x.line));
const feed = (connId, obj) => DeviceEventEmitter.emit('MalachiTorLine', { connId, line: JSON.stringify(obj) });

beforeEach(async () => {
  sent.length = 0;
  closed.length = 0;
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

afterEach(() => {
  for (const rtc of RTCStore.connections.values()) { try { rtc.close(); } catch {} }
});

describe('Anmeldung eingehender Tor-Verbindungen (Serverseite)', () => {
  async function challenge(connId) {
    await Tor._handleIncomingForTests(connId);
    const c = linesFor(connId)[0];
    expect(c).toMatchObject({ t: 'malachi-tor', step: 'challenge' });
    return c.nonce;
  }

  test('richtiger Kontakt mit richtigem Geheimnis: angemeldet, Gegenbestaetigung korrekt, Sitzung als Tor-Verbindung registriert', async () => {
    const nonceS = await challenge('in-1');
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('in-1', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nonceC,
      mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, nonceS, nonceC, CONTACT.id]) });
    await tick(50);
    const ok = linesFor('in-1').find((m) => m.step === 'ok');
    expect(ok.mac).toBe(Tor._authMacForTests(SECRET, 'server', [MY_ONION, nonceS, nonceC, CONTACT.id]));
    const rtc = RTCStore.connections.get(CONTACT.id);
    expect(rtc.transport).toBe('tor');
    expect(rtc.isInitiator).toBe(false);
    expect(closed).not.toContain('in-1');
  });

  test('falsches Geheimnis: abgelehnt, Verbindung geschlossen, keine Sitzung', async () => {
    const nonceS = await challenge('in-2');
    const nonceC = crypto.randomBytes(24).toString('hex');
    const wrong = crypto.randomBytes(32).toString('base64');
    feed('in-2', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nonceC,
      mac: Tor._authMacForTests(wrong, 'client', [MY_ONION, nonceS, nonceC, CONTACT.id]) });
    await tick(50);
    expect(closed).toContain('in-2');
    expect(linesFor('in-2').some((m) => m.step === 'ok')).toBe(false);
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
  });

  test('Anmeldung an eine ANDERE Onion-Adresse gebunden (weitergeleitete Anmeldung) wird abgelehnt', async () => {
    const nonceS = await challenge('in-3');
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('in-3', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nonceC,
      mac: Tor._authMacForTests(SECRET, 'client', [PEER_ONION, nonceS, nonceC, CONTACT.id]) });
    await tick(50);
    expect(closed).toContain('in-3');
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
  });

  test('unbekannter Kontakt und kaputte Zeilen werden abgelehnt', async () => {
    const nonceS = await challenge('in-4');
    feed('in-4', { t: 'malachi-tor', step: 'auth', id: 'c_unbekannt', nonce: 'x'.repeat(32),
      mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, nonceS, 'x'.repeat(32), 'c_unbekannt']) });
    await challenge('in-5');
    DeviceEventEmitter.emit('MalachiTorLine', { connId: 'in-5', line: 'kein json' });
    await tick(50);
    expect(closed).toEqual(expect.arrayContaining(['in-4', 'in-5']));
    expect(RTCStore.connections.size).toBe(0);
  });

  test('Audit A2/T3: keine globale Sperre - nach vielen Fehlversuchen (z.B. fremde App ueber 127.0.0.1) meldet sich der echte Kontakt trotzdem an', async () => {
    for (let i = 0; i < 25; i++) {
      await challenge('bad-' + i);
      DeviceEventEmitter.emit('MalachiTorLine', { connId: 'bad-' + i, line: '{}' });
    }
    await tick(50);
    expect(closed).toEqual(expect.arrayContaining(['bad-0', 'bad-24']));
    const nonceS = await challenge('echt');
    const nonceC = crypto.randomBytes(24).toString('hex');
    feed('echt', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nonceC,
      mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, nonceS, nonceC, CONTACT.id]) });
    await tick(50);
    expect(linesFor('echt').some((m) => m.step === 'ok')).toBe(true);
    expect(RTCStore.connections.get(CONTACT.id)?.transport).toBe('tor');
  });

  test('Audit A2/T3: hoechstens 12 gleichzeitig unangemeldete Verbindungen; nach Abbau ist wieder Platz', async () => {
    for (let i = 0; i < 12; i++) await challenge('idle-' + i);
    await Tor._handleIncomingForTests('zuviel');
    expect(closed).toContain('zuviel');
    expect(linesFor('zuviel')).toHaveLength(0);
    // Eine der haengenden Verbindungen schliesst - neue werden wieder angenommen.
    DeviceEventEmitter.emit('MalachiTorClosed', { connId: 'idle-0' });
    await tick(10);
    await challenge('wieder');
  });

  test('Audit A2/T3: erst nach gueltiger Anmeldung volles Zeilenlimit (trustConnection), vor der Gegenbestaetigung', async () => {
    const order = [];
    NativeModules.MalachiTor.trustConnection = jest.fn((id) => order.push(['trust', id]));
    const origSend = NativeModules.MalachiTor.send;
    NativeModules.MalachiTor.send = jest.fn(async (connId, line) => { order.push(['send', connId, JSON.parse(line).step]); sent.push({ connId, line }); });
    try {
      const nonceS = await challenge('in-t');
      const wrongC = crypto.randomBytes(24).toString('hex');
      await challenge('in-f');
      feed('in-f', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: wrongC, mac: 'falsch' });
      const nonceC = crypto.randomBytes(24).toString('hex');
      feed('in-t', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nonceC,
        mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, nonceS, nonceC, CONTACT.id]) });
      await tick(50);
      expect(NativeModules.MalachiTor.trustConnection.mock.calls).toEqual([['in-t']]);
      const iTrust = order.findIndex((o) => o[0] === 'trust');
      const iOk = order.findIndex((o) => o[0] === 'send' && o[1] === 'in-t' && o[2] === 'ok');
      expect(iTrust).toBeGreaterThan(-1);
      expect(iTrust).toBeLessThan(iOk);
    } finally {
      NativeModules.MalachiTor.send = origSend;
      delete NativeModules.MalachiTor.trustConnection;
    }
  });
});

test('statisch: nativer Teil - 8-KB-Zeilenlimit fuer eingehende Verbindungen bis zur Freigabe', () => {
  const fs = require('fs');
  const path = require('path');
  const kt = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/com/securecommapp/tor/MalachiTorModule.kt'), 'utf8');
  expect(kt).toMatch(/PRE_AUTH_MAX_LINE_BYTES = 8 \* 1024/);
  expect(kt).toMatch(/@Volatile var maxLine = if \(inbound\) PRE_AUTH_MAX_LINE_BYTES else MAX_LINE_BYTES/);
  expect(kt).toMatch(/fun trustConnection\(connId: String\) \{\s+conns\[connId\]\?\.maxLine = MAX_LINE_BYTES/);
  expect(kt).toMatch(/if \(buf\.size\(\) > conn\.maxLine\) throw/);
});

describe('Verbinden ueber Tor (Clientseite)', () => {
  test('vollstaendige gegenseitige Anmeldung: Client beweist Kenntnis des Geheimnisses, prueft die Gegenseite und bekommt eine Tor-Sitzung als Initiator', async () => {
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    expect(NativeModules.MalachiTor.connect).toHaveBeenCalledWith(PEER_ONION, 7777);
    const nonceS = crypto.randomBytes(24).toString('hex');
    feed('out-1', { t: 'malachi-tor', v: 1, step: 'challenge', nonce: nonceS });
    await tick();
    const auth = linesFor('out-1')[0];
    expect(auth).toMatchObject({ step: 'auth', id: CONTACT.id });
    expect(auth.mac).toBe(Tor._authMacForTests(SECRET, 'client', [PEER_ONION, nonceS, auth.nonce, CONTACT.id]));
    feed('out-1', { t: 'malachi-tor', step: 'ok', mac: Tor._authMacForTests(SECRET, 'server', [PEER_ONION, nonceS, auth.nonce, CONTACT.id]) });
    const rtc = await p;
    expect(rtc).toBeTruthy();
    expect(rtc.transport).toBe('tor');
    expect(rtc.isInitiator).toBe(true);
  });

  test('Gegenseite ohne gueltige Bestaetigung (falsche Onion/fremder Dienst): abgebrochen, keine Sitzung', async () => {
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    feed('out-1', { t: 'malachi-tor', step: 'challenge', nonce: 'n'.repeat(32) });
    await tick();
    feed('out-1', { t: 'malachi-tor', step: 'ok', mac: 'gefaelscht' });
    expect(await p).toBeNull();
    expect(closed).toContain('out-1');
  });

  test('ohne eigene Tor-Verbindung oder ohne gueltige Onion des Kontakts wird gar nicht erst verbunden', async () => {
    expect(await Tor.connectViaTor({ ...CONTACT, torOnion: 'kaputt.onion' })).toBeNull();
    Tor._setTorStateForTests({ status: 'OFF', onion: null });
    expect(await Tor.connectViaTor(CONTACT)).toBeNull();
    expect(NativeModules.MalachiTor.connect).not.toHaveBeenCalled();
  });
});

describe('Ueber den Tor-Kanal laeuft dasselbe Protokoll wie direkt', () => {
  // Zwei verbundene Kanaele im Speicher, Nachrichten asynchron wie ueber das Netz.
  function linkedPair() {
    const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
      close() { this.readyState = 'closed'; this.onclose?.(); } });
    const a = mk(); const b = mk();
    a.send = (d) => setTimeout(() => b.onmessage?.({ data: d }), 1);
    b.send = (d) => setTimeout(() => a.onmessage?.({ data: d }), 1);
    return [a, b];
  }

  test('frischer Kyber-Schluesseltausch, dann verschluesselte Nachricht - kein Klartext auf dem Kanal', async () => {
    const [chA, chB] = linkedPair();
    const onWire = [];
    const origSend = chA.send;
    chA.send = (d) => { onWire.push(d); origSend(d); };
    const received = [];
    const a = new WebRTCManager(() => {}, () => {}, () => {});
    const b = new WebRTCManager(() => {}, () => {}, () => {});
    b.onMessage = (m) => received.push(m);
    a.attachTorChannel(chA, true);
    b.attachTorChannel(chB, false);
    for (let i = 0; i < 100 && !(a.keyExchangeDone && b.keyExchangeDone); i++) await tick(10);
    expect(a.keyExchangeDone && b.keyExchangeDone).toBe(true);
    expect(a.sharedSecret).toBe(b.sharedSecret);
    expect(a.sharedSecret).not.toBe(SECRET);          // pro Verbindung frisch
    a.sendMessage(JSON.stringify({ type: 'text', text: 'Hallo ueber Tor', msgId: 'm1', time: Date.now() }));
    for (let i = 0; i < 100 && !received.some((m) => m.type === 'text'); i++) await tick(10);
    expect(received.find((m) => m.type === 'text')).toMatchObject({ text: 'Hallo ueber Tor', msgId: 'm1' });
    expect(onWire.join('\n')).not.toMatch(/Hallo ueber Tor/);
    a.close(); b.close();
  });

  test('Tor-Sitzung zaehlt als verbunden; geschlossener Kanal nicht mehr', () => {
    const [chA] = linkedPair();
    const a = new WebRTCManager(() => {}, () => {}, () => {});
    a.attachTorChannel(chA, true);
    RTCStore.connections.set('c_test', a);
    expect(RTCStore.isConnected('c_test')).toBe(true);
    a.close();
    expect(RTCStore.isConnected('c_test')).toBe(false);
  });
});

describe('Tor-Start mit Bridges', () => {
  test('Automatik: ohne Bridges scheitert -> Snowflake klappt; Onion-Schluessel und funktionierende Stufe werden gemerkt', async () => {
    Tor._resetTorTransportForTests();
    NativeModules.MalachiTor.start
      .mockRejectedValueOnce(new Error('blockiert'))
      .mockResolvedValueOnce({ onion: MY_ONION, onionKey: 'ED25519-V3:geheim', socksPort: 9050 });
    expect(await Tor.ensureTorRunning()).toBe(true);
    const calls = NativeModules.MalachiTor.start.mock.calls.map((c) => c[0]);
    expect(calls[0].bridges).toEqual([]);
    expect(calls[1].bridges.length).toBeGreaterThan(0);
    expect(calls[1].bridges.every((l) => l.startsWith('snowflake '))).toBe(true);
    expect(Tor.getTorState()).toMatchObject({ status: 'ON', onion: MY_ONION, mode: 'snowflake' });
    expect(await EncryptedStorage.getItem('tor_onion_key')).toBe('ED25519-V3:geheim');

    // Neustart: gespeicherter Schluessel wird wiederverwendet, Snowflake zuerst probiert.
    Tor._resetTorTransportForTests();
    NativeModules.MalachiTor.start.mockClear();
    NativeModules.MalachiTor.start.mockResolvedValueOnce({ onion: MY_ONION, socksPort: 9050 });
    await Tor.ensureTorRunning();
    const again = NativeModules.MalachiTor.start.mock.calls[0][0];
    expect(again.onionKey).toBe('ED25519-V3:geheim');
    expect(again.bridges.every((l) => l.startsWith('snowflake '))).toBe(true);
  });

  test('Tor laesst sich nicht mehr ausschalten (einziger Weg zu Kontakten, kein Server): ein gespeichertes "aus" wird ignoriert', async () => {
    Tor._resetTorTransportForTests();
    await EncryptedStorage.setItem('tor_settings', JSON.stringify({ enabled: false, bridgeMode: 'none' }));
    expect((await Tor.loadTorSettings()).enabled).toBe(true);
    expect((await Tor.saveTorSettings({ enabled: false, bridgeMode: 'none' })).enabled).toBe(true);
    NativeModules.MalachiTor.start.mockResolvedValueOnce({ onion: MY_ONION, socksPort: 9050 });
    expect(await Tor.ensureTorRunning()).toBe(true);
    expect(NativeModules.MalachiTor.start).toHaveBeenCalled();
    // SOCKS-Port bleibt fuer spaetere Onion-HTTP-Anfragen abrufbar.
    expect(Tor.getTorSocksPort()).toBe(9050);
  });

  test('eigene Bridges: nur bekannte Transporte, "Bridge "-Praefix wird akzeptiert, Muell und Steuerzeichen fliegen raus', () => {
    const text = [
      'Bridge webtunnel [2001:db8::1]:443 ABCDEF url=https://example.org/pfad ver=0.0.1',
      'obfs4 192.0.2.1:443 FINGERPRINT cert=abc iat-mode=0',
      'rm -rf /',
      'meek_lite\u0007 192.0.2.2:80',
      '',
    ].join('\n');
    expect(Tor.parseCustomBridges(text)).toEqual([
      'webtunnel [2001:db8::1]:443 ABCDEF url=https://example.org/pfad ver=0.0.1',
      'obfs4 192.0.2.1:443 FINGERPRINT cert=abc iat-mode=0',
    ]);
    expect(Tor.bridgesForMode('none')).toEqual([]);
    expect(Tor.bridgesForMode('obfs4').length).toBeGreaterThan(0);
  });
});

describe('Steuerung in BackgroundSync', () => {
  test('Onion-Adresse eines Kontakts wird nur in gueltiger Form gespeichert', async () => {
    RTCStore.torAddressHandler(CONTACT.id, 'ungueltig');
    await BG.updateContacts(() => null);
    expect(JSON.parse(await EncryptedStorage.getItem('contacts'))[0].torOnion).toBe(PEER_ONION);
    const neu = 'c'.repeat(56) + '.onion';
    RTCStore.torAddressHandler(CONTACT.id, neu);
    await BG.updateContacts(() => null);
    expect(JSON.parse(await EncryptedStorage.getItem('contacts'))[0].torOnion).toBe(neu);
  });

  test('ohne Server ist Tor der erste Weg: der Einladende (initiator) baut sofort auf, ohne auf einen Direktversuch zu warten', () => {
    const now = Date.now();
    expect(BG.shouldTryTor(CONTACT, now)).toBe(true);
    expect(BG.shouldTryTor({ ...CONTACT, torOnion: null }, now)).toBe(false);    // Onion unbekannt
    expect(BG.shouldTryTor({ ...CONTACT, wiped: true }, now)).toBe(false);
    Tor._setTorStateForTests({ status: 'OFF', onion: null });
    expect(BG.shouldTryTor(CONTACT, now)).toBe(false);                 // eigenes Tor aus
  });

  test('Testmodus "nur Tor" wird gespeichert und gelesen (verhindert den Wechsel auf direkt, siehe DirectUpgrade)', async () => {
    await Tor.saveTorSettings({ enabled: true, bridgeMode: 'auto', forceTorTest: true });
    expect(Tor.isForceTorTestMode()).toBe(true);
    await Tor.saveTorSettings({ enabled: true, bridgeMode: 'auto', forceTorTest: false });
    expect(Tor.isForceTorTestMode()).toBe(false);
  });
});

describe('Bombensicher: Waechter, Selbsttest, Netzwechsel, doppelte Kanaele', () => {
  test('Selbsttest: Begruessung des eigenen Onion-Dienstes kommt an -> als erreichbar markiert', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => 'self-1');
    const p = Tor.runSelfTest();
    await tick();
    expect(NativeModules.MalachiTor.connectWithTimeout).toHaveBeenCalledWith(MY_ONION, 7777, expect.any(Number));
    feed('self-1', { t: 'malachi-tor', v: 1, step: 'challenge', nonce: 'n'.repeat(48) });
    expect(await p).toBe(true);
    expect(Tor.getTorState().reachable).toBe(true);
    expect(closed).toContain('self-1');
    delete NativeModules.MalachiTor.connectWithTimeout;
  });

  test('Selbsttest scheitert zweimal -> Tor wird frisch gestartet (eigener Prozess, gefahrlos), danach Kontakte neu verbunden', async () => {
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Connect timed out'); });
    NativeModules.MalachiTor.start.mockResolvedValue({ onion: MY_ONION, socksPort: 9050 });
    expect(await Tor.runSelfTest()).toBe(false);
    expect(NativeModules.MalachiTor.stop).not.toHaveBeenCalled();
    expect(await Tor.runSelfTest()).toBe(false);
    await tick(1200);
    expect(NativeModules.MalachiTor.stop).toHaveBeenCalled();
    expect(NativeModules.MalachiTor.start).toHaveBeenCalled();
    expect(Tor.getTorState().status).toBe('ON');
    delete NativeModules.MalachiTor.connectWithTimeout;
    NativeModules.MalachiTor.start.mockReset();
  });

  test('Netzwechsel: Tor wird EINMAL frisch gestartet (mehrere Ereignisse gebuendelt), gleiches Netz = nichts', async () => {
    NativeModules.MalachiTor.start.mockResolvedValue({ onion: MY_ONION, socksPort: 9050 });
    NativeModules.MalachiTor.stop.mockClear();
    Tor.handleNetworkChange({ type: 'wifi', isConnected: true, details: { ipAddress: '192.168.178.61' } });
    await tick(1000);
    expect(NativeModules.MalachiTor.stop).not.toHaveBeenCalled();   // erster Zustand = kein Wechsel
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.1.2.3' } });
    expect(Tor.getTorState().reachable).toBe(false);
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.1.2.4' } });
    await tick(1200);
    expect(NativeModules.MalachiTor.stop).toHaveBeenCalledTimes(1);
    expect(Tor.getTorState().status).toBe('ON');
    Tor.handleNetworkChange({ type: 'cellular', isConnected: true, details: { ipAddress: '10.1.2.4' } });
    await tick(1000);
    expect(NativeModules.MalachiTor.stop).toHaveBeenCalledTimes(1);   // gleiches Netz = nichts
    NativeModules.MalachiTor.start.mockReset();
  });

  test('zwei Tor-Kanaele zum selben Kontakt: es bleibt der, dessen aufbauende Seite die kleinere Onion-Adresse hat', async () => {
    // Eingehend: Kontakt (PEER_ONION 'bbb…') baut auf. Bestehend: eigener ausgehender Kanal (MY_ONION 'aaa…' baut auf).
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    const nonceS = 'c'.repeat(48);
    feed('out-1', { t: 'malachi-tor', step: 'challenge', nonce: nonceS });
    await tick();
    const auth = linesFor('out-1')[0];
    feed('out-1', { t: 'malachi-tor', step: 'ok', mac: Tor._authMacForTests(SECRET, 'server', [PEER_ONION, nonceS, auth.nonce, CONTACT.id]) });
    const outgoing = await p;
    await tick(20);
    expect(RTCStore.connections.get(CONTACT.id)).toBe(outgoing);
    outgoing.keyExchangeDone = true;   // bestehender Kanal voll einsatzbereit

    await Tor._handleIncomingForTests('in-dup');
    const ns = linesFor('in-dup')[0].nonce;
    const nc = 'd'.repeat(48);
    feed('in-dup', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nc, mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, ns, nc, CONTACT.id]) });
    await tick(50);
    // 'aaa…' < 'bbb…' -> der eigene ausgehende Kanal bleibt, der eingehende wird geschlossen.
    expect(RTCStore.connections.get(CONTACT.id)).toBe(outgoing);
    expect(closed).toContain('in-dup');
  });

  test('auch die Gegenseite (responder) baut per Tor auf - etwas spaeter (5 s), damit meist nur EIN Kanal entsteht; ein Anruf (force) wartet nicht', () => {
    const responder = { ...CONTACT, role: 'responder' };
    const now = Date.now();
    expect(BG.shouldTryTor(responder, now)).toBe(false);
    BG._markNotConnectedSinceForTests(responder.id, now - 3000);
    expect(BG.shouldTryTor(responder, now)).toBe(false);
    expect(BG.shouldTryTor(responder, now, { force: true })).toBe(true);
    BG._markNotConnectedSinceForTests(responder.id, now - 6000);
    expect(BG.shouldTryTor(responder, now)).toBe(true);
  });
});

describe('Onion-Adressen reisen nur ueber den angemeldeten, verschluesselten Kanal', () => {
  test('Direkt-Signale (DirectUpgrade) tragen die Onion-Adresse des Absenders - RTCStore reicht sie an die Speicherung weiter, nie an den Chat', async () => {
    require('../../DirectUpgrade');   // registriert RTCStore.upgradeSignalHandler
    const rtc = { transport: 'tor', keyExchangeDone: true, dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' },
      pendingMsgs: [], close: jest.fn(), sendMessage: jest.fn(() => 'sent') };
    RTCStore.setConnection(CONTACT.id, rtc);
    const seen = [];
    RTCStore.setMessageListener(CONTACT.id, (m) => seen.push(m));
    const neu = 'e'.repeat(56) + '.onion';
    rtc.onMessage({ type: 'system', subtype: 'direct_reject', reason: 'tor_only', onion: neu });
    await tick(20);
    await BG.updateContacts(() => null);
    expect(JSON.parse(await EncryptedStorage.getItem('contacts'))[0].torOnion).toBe(neu);
    expect(seen).toEqual([]);
    expect(RTCStore.buffer.has(CONTACT.id)).toBe(false);
    RTCStore.setMessageListener(CONTACT.id, null);
  });

  test('rememberContactOnion speichert nur gueltige Adressen', async () => {
    const neu = 'd'.repeat(56) + '.onion';
    BG.rememberContactOnion(CONTACT.id, 'javascript:alert(1)');
    BG.rememberContactOnion(CONTACT.id, undefined);
    await BG.updateContacts(() => null);
    expect(JSON.parse(await EncryptedStorage.getItem('contacts'))[0].torOnion).toBe(PEER_ONION);
    BG.rememberContactOnion(CONTACT.id, neu);
    await BG.updateContacts(() => null);
    expect(JSON.parse(await EncryptedStorage.getItem('contacts'))[0].torOnion).toBe(neu);
  });
});

describe('Erstkopplung ueber Tor (QR-Code/Einladungslink)', () => {
  const PSK = crypto.randomBytes(16).toString('base64');
  const TOKEN = 'A1B2C3D4';

  test('Onion-Adresse wird aus dem Einladungslink gelesen; alte Links ohne Onion bleiben gueltig (null)', () => {
    const host = 'e'.repeat(56);
    expect(Tor.onionFromInvite(`malachi://connect/${TOKEN}.${'f'.repeat(32)}.${host}`)).toBe(host + '.onion');
    expect(Tor.onionFromInvite(`malachi://connect/${TOKEN}.${'f'.repeat(32)}`)).toBeNull();
    expect(Tor.onionFromInvite(`malachi://connect/${TOKEN}.${'f'.repeat(32)}.kurz`)).toBeNull();
  });

  async function pairAttempt(connId, psk, token = TOKEN) {
    await Tor._handleIncomingForTests(connId);
    const nonceS = linesFor(connId)[0].nonce;
    const nonceC = 'a'.repeat(48);
    feed(connId, { t: 'malachi-tor', step: 'pair', token, nonce: nonceC, mac: Tor._authMacForTests(psk, 'pair-client', [MY_ONION, nonceS, nonceC, token]) });
    await tick(50);
    return { nonceS, nonceC };
  }

  test('richtiges Einmal-Geheimnis: Kopplung angenommen, Gegenbestaetigung korrekt - Sitzung erst NACH dem Schluesseltausch an den Bildschirm uebergeben', async () => {
    const paired = [];
    Tor.registerPairingInvite(TOKEN, { pskB64: PSK, contactId: 'c_neu', onPaired: (rtc) => paired.push(rtc) });
    const { nonceS, nonceC } = await pairAttempt('p-1', PSK);
    const ok = linesFor('p-1').find((m) => m.step === 'pair-ok');
    expect(ok.mac).toBe(Tor._authMacForTests(PSK, 'pair-server', [MY_ONION, nonceS, nonceC, TOKEN]));
    await tick(100);
    // Kanal offen, aber noch kein Schluessel: noch KEIN Kontakt (sonst
    // bliebe bei einem Abbruch ein "Neuer Kontakt" ohne Schluessel zurueck).
    expect(paired).toHaveLength(0);
    feed('p-1', { type: 'system', subtype: 'kyber_pubkey', publicKey: 'pub_test' });
    for (let i = 0; i < 50 && !paired.length; i++) await tick(10);
    expect(paired).toHaveLength(1);
    expect(paired[0].transport).toBe('tor');
    expect(paired[0].chatId).toBe('c_neu');
    expect(paired[0].keyExchangeDone).toBe(true);
    paired[0].close();
  });

  test('bricht die Kopplungssitzung VOR dem Schluesseltausch ab, bleibt die Einladung gueltig (erneuter Versuch moeglich, kein Geister-Kontakt)', async () => {
    const paired = [];
    Tor.registerPairingInvite(TOKEN, { pskB64: PSK, contactId: 'c_neu', onPaired: (rtc) => paired.push(rtc) });
    await pairAttempt('p-6', PSK);
    expect(linesFor('p-6').some((m) => m.step === 'pair-ok')).toBe(true);
    DeviceEventEmitter.emit('MalachiTorClosed', { connId: 'p-6' });
    await tick(50);
    expect(paired).toHaveLength(0);
    await pairAttempt('p-7', PSK);                       // zweiter Versuch mit derselben Einladung
    expect(linesFor('p-7').some((m) => m.step === 'pair-ok')).toBe(true);
    expect(closed).not.toContain('p-7');
    for (const rtc of [...RTCStore.connections.values()]) { try { rtc.close(); } catch {} }
  });

  test('falsches Geheimnis oder unbekannter Token: abgelehnt; jede Einladung funktioniert nur einmal', async () => {
    Tor.registerPairingInvite(TOKEN, { pskB64: PSK, contactId: 'c_neu', onPaired: () => {} });
    await pairAttempt('p-2', crypto.randomBytes(16).toString('base64'));
    expect(closed).toContain('p-2');
    await pairAttempt('p-3', PSK, 'FFFFFFFF');
    expect(closed).toContain('p-3');
    await pairAttempt('p-4', PSK);                       // gueltig -> verbraucht die Einladung
    expect(linesFor('p-4').some((m) => m.step === 'pair-ok')).toBe(true);
    await pairAttempt('p-5', PSK);                       // zweites Mal -> abgelehnt
    expect(closed).toContain('p-5');
    for (const rtc of [...RTCStore.connections.values()]) { try { rtc.close(); } catch {} }
  });

  test('Client-Seite: koppelt nur, wenn der Einladende das Geheimnis beweist', async () => {
    const p = Tor.pairViaTor({ onion: PEER_ONION, token: TOKEN, pskB64: PSK, contactId: 'c_neu', onPaired: () => {} });
    await tick();
    feed('out-1', { t: 'malachi-tor', step: 'challenge', nonce: 'b'.repeat(48) });
    await tick();
    const req = linesFor('out-1')[0];
    expect(req).toMatchObject({ step: 'pair', token: TOKEN });
    expect(req.mac).toBe(Tor._authMacForTests(PSK, 'pair-client', [PEER_ONION, 'b'.repeat(48), req.nonce, TOKEN]));
    feed('out-1', { t: 'malachi-tor', step: 'pair-ok', mac: 'gefaelscht' });
    expect(await p).toBeNull();
    expect(closed).toContain('out-1');
  });
});

describe('Tor-Reserve: sofortiges Umschalten, wenn die Direktverbindung wegbricht', () => {
  function fakeDirect() {
    return { transport: 'direct', dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' },
      pendingMsgs: [], close: jest.fn(), sendMessage: jest.fn(() => 'sent') };
  }
  async function incomingTor(connId) {
    await Tor._handleIncomingForTests(connId);
    const ns = linesFor(connId)[0].nonce;
    const nc = 'e'.repeat(48);
    feed(connId, { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nc, mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, ns, nc, CONTACT.id]) });
    for (let i = 0; i < 50; i++) { await tick(10); if (Tor.hasTorReserve(CONTACT.id)) break; }
  }

  test('eingehende Tor-Verbindung bei laufender Direktverbindung wird Reserve (nicht geschlossen, nicht aktiv)', async () => {
    const direct = fakeDirect();
    RTCStore.connections.set(CONTACT.id, direct);
    await incomingTor('res-1');
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);
    expect(RTCStore.connections.get(CONTACT.id)).toBe(direct);
    expect(closed).not.toContain('res-1');
  });

  test('Reserve ohne fertigen Schluesseltausch wird NICHT uebernommen (kein unverschluesseltes Fenster)', async () => {
    const direct = fakeDirect();
    RTCStore.connections.set(CONTACT.id, direct);
    await incomingTor('res-2');
    expect(Tor.promoteTorReserve(CONTACT.id)).toBeNull();      // Schluesseltausch noch nicht fertig -> nicht uebernehmen
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);          // Reserve bleibt fuer spaeter
  });

  test('Direktverbindung wieder da -> aktive Tor-Verbindung wird Reserve statt geschlossen; ohne Reserve-Wunsch wird geschlossen', async () => {
    const torRtc = { transport: 'tor', _closed: false, dataChannel: { readyState: 'open' }, close: jest.fn() };
    RTCStore.connections.set(CONTACT.id, torRtc);
    expect(Tor.demoteActiveTorToReserve(CONTACT.id)).toBe(true);
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);
    expect(torRtc.close).not.toHaveBeenCalled();

    await Tor.saveTorSettings({ enabled: true, bridgeMode: 'auto', keepReserve: false });
    const torRtc2 = { transport: 'tor', _closed: false, dataChannel: { readyState: 'open' }, close: jest.fn() };
    RTCStore.connections.set(CONTACT.id, torRtc2);
    expect(Tor.demoteActiveTorToReserve(CONTACT.id)).toBe(false);
  });

  test('Reserve mit fertigem Schluesseltausch wird uebernommen und schickt die Warteschlange los', () => {
    const flush = jest.fn(async () => {});
    Tor.configureTorTransport({ flushQueue: flush });
    const torRtc = { transport: 'tor', _closed: false, keyExchangeDone: true, dataChannel: { readyState: 'open' }, close: jest.fn(),
      sendMessage: jest.fn(), pendingMsgs: [] };
    RTCStore.connections.set(CONTACT.id, torRtc);
    Tor.demoteActiveTorToReserve(CONTACT.id);
    const promoted = Tor.promoteTorReserve(CONTACT.id);
    expect(promoted).toBe(torRtc);
    expect(RTCStore.connections.get(CONTACT.id)).toBe(torRtc);
    expect(flush).toHaveBeenCalledWith(CONTACT.id, torRtc);
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(false);
  });
});

describe('Anmeldung nach schnellen Schluesselwechseln', () => {
  test('Client kennt aktuellen + vorherigen Schluessel, Server nur den vorherigen: Anmeldung klappt trotzdem', async () => {
    const NEU = crypto.randomBytes(32).toString('base64');
    // Server (dieses Geraet) kennt nur SECRET; Client hat schon NEU als aktuell, SECRET als vorherig.
    await Tor._handleIncomingForTests('k-1');
    const ns = linesFor('k-1')[0].nonce;
    const nc = 'f'.repeat(48);
    const parts = [MY_ONION, ns, nc, CONTACT.id];
    feed('k-1', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nc,
      mac: Tor._authMacForTests(NEU, 'client', parts),
      macs: [Tor._authMacForTests(NEU, 'client', parts), Tor._authMacForTests(SECRET, 'client', parts)] });
    await tick(50);
    expect(linesFor('k-1').some((m) => m.step === 'ok')).toBe(true);
    expect(closed).not.toContain('k-1');
  });

  test('mehr als 3 MACs bringen nichts (kein Durchprobieren)', async () => {
    await Tor._handleIncomingForTests('k-2');
    const ns = linesFor('k-2')[0].nonce;
    const nc = 'f'.repeat(48);
    const fakes = Array.from({ length: 5 }, () => crypto.randomBytes(32).toString('base64'));
    const macs = fakes.map((k) => Tor._authMacForTests(k, 'client', [MY_ONION, ns, nc, CONTACT.id]));
    macs.push(Tor._authMacForTests(SECRET, 'client', [MY_ONION, ns, nc, CONTACT.id]));   // richtiger erst an 6. Stelle
    feed('k-2', { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nc, mac: macs[0], macs });
    await tick(50);
    expect(closed).toContain('k-2');
  });
});

test('Nachricht auf der Reserve (Gegenseite hat schon gewechselt) -> Reserve wird sofort aktiv und die Nachricht kommt an', () => {
  const direct = { transport: 'direct', dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' }, pendingMsgs: [], close: jest.fn() };
  const torRtc = { transport: 'tor', _closed: false, keyExchangeDone: true, dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' },
    close: jest.fn(), sendMessage: jest.fn(), pendingMsgs: [] };
  RTCStore.connections.set(CONTACT.id, torRtc);
  Tor.demoteActiveTorToReserve(CONTACT.id);          // torRtc ist jetzt Reserve
  RTCStore.connections.set(CONTACT.id, direct);       // "Zombie"-Direktverbindung
  const seen = [];
  RTCStore.setMessageListener(CONTACT.id, (m) => seen.push(m));
  torRtc.onMessage({ type: 'text', text: 'hallo nach Netzwechsel', msgId: 'n1' });
  expect(RTCStore.connections.get(CONTACT.id)).toBe(torRtc);
  expect(direct.close).toHaveBeenCalled();
  expect(seen.map((m) => m.text)).toEqual(['hallo nach Netzwechsel']);
  RTCStore.setMessageListener(CONTACT.id, null);
});

test('haengende Direktverbindung (ICE verbunden, Schluesseltausch nie fertig) blockiert Tor nicht', () => {
  const stuck = { transport: 'direct', keyExchangeDone: false, dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' }, close: jest.fn() };
  RTCStore.connections.set(CONTACT.id, stuck);
  expect(BG.shouldTryTor(CONTACT)).toBe(true);
  stuck.keyExchangeDone = true;
  expect(BG.shouldTryTor(CONTACT)).toBe(false);
});

describe('Netzwechsel-Feinschliff (Live-Test Okt. 2026)', () => {
  async function incomingAuth(connId, extra = {}) {
    await Tor._handleIncomingForTests(connId);
    const ns = linesFor(connId)[0].nonce;
    const nc = 'g'.repeat(48);
    feed(connId, { t: 'malachi-tor', step: 'auth', id: CONTACT.id, nonce: nc,
      mac: Tor._authMacForTests(SECRET, 'client', [MY_ONION, ns, nc, CONTACT.id]), ...extra });
    await tick(50);
  }

  test('Client meldet beim Anmelden, ob er selbst noch eine Verbindung hat (fresh)', async () => {
    const p = Tor.connectViaTor(CONTACT);
    await tick();
    feed('out-1', { t: 'malachi-tor', step: 'challenge', nonce: 'h'.repeat(48) });
    await tick();
    expect(linesFor('out-1')[0].fresh).toBe(true);
    feed('out-1', { t: 'malachi-tor', step: 'ok', mac: 'falsch' });
    await p;
  });

  test('alte, tote Tor-Verbindung haengt noch: neuer Kanal der Gegenseite mit fresh wird SOFORT aktiv (kein 15-s-Zombie), der alte wartet als Reserve statt den neuen zu verdraengen', async () => {
    await incomingAuth('alt-1');
    const old = RTCStore.connections.get(CONTACT.id);
    expect(old?.transport).toBe('tor');
    old.keyExchangeDone = true;
    old._torEstablishedAt = Date.now() - 5000;        // juenger als 30 s - frueher Grund fuer das Haengen
    await incomingAuth('neu-1', { fresh: true });
    const now = RTCStore.connections.get(CONTACT.id);
    expect(now).not.toBe(old);
    expect(now.transport).toBe('tor');
    expect(closed).not.toContain('neu-1');
    expect(closed).not.toContain('alt-1');
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);
  });

  test('ohne fresh (paralleler Zweitversuch derselben Seite) bleibt der bestehende Kanal, der neue wird geschlossen', async () => {
    await incomingAuth('erst-1');
    const first = RTCStore.connections.get(CONTACT.id);
    first.keyExchangeDone = true;
    await incomingAuth('zweit-1');
    expect(RTCStore.connections.get(CONTACT.id)).toBe(first);
    expect(closed).toContain('zweit-1');
  });

  test('schliesst Tor alle Kanaele (Neustart nach Netzwechsel), werden auch die Verbindungen selbst sofort beendet - keine weiterlaufenden Zombies', async () => {
    await incomingAuth('z-1');
    const rtc = RTCStore.connections.get(CONTACT.id);
    expect(rtc._closed).toBe(false);
    await Tor.stopTor();
    expect(rtc._closed).toBe(true);
    expect(rtc._livenessWatch).toBeNull();
    expect(RTCStore.connections.has(CONTACT.id)).toBe(false);
  });

  test('Selbsttest scheitert, waehrend eine Tor-Reserve/-Verbindung Daten traegt: kein Neustart (vorher zaehlten nur aktive Verbindungen)', async () => {
    const direct = { transport: 'direct', dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' },
      pendingMsgs: [], close: jest.fn(), sendMessage: jest.fn(() => 'sent') };
    RTCStore.connections.set(CONTACT.id, direct);
    await incomingAuth('res-z');                         // wird Reserve neben der Direktverbindung
    expect(Tor.hasTorReserve(CONTACT.id)).toBe(true);
    feed('res-z', { type: 'dummy' });                    // Datenverkehr auf dem Reserve-Kanal
    expect(Tor.isTorInUse()).toBe(true);
    NativeModules.MalachiTor.connectWithTimeout = jest.fn(async () => { throw new Error('Connect timed out'); });
    NativeModules.MalachiTor.stop.mockClear();
    await Tor.runSelfTest();
    await Tor.runSelfTest();
    await tick(1200);
    expect(NativeModules.MalachiTor.stop).not.toHaveBeenCalled();
    delete NativeModules.MalachiTor.connectWithTimeout;
  });
});
