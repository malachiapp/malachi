// Serverlos (Okt. 2026): kein Relay-/Treffpunkt-Server mehr.
//   - statisch: kein Server-Client, keine Server-Adresse ausser STUN, Kopplung
//     nur ueber Tor (auch per Telefonnummer: Tor-Treffpunkt statt Server-
//     Suche, siehe phonePairing.*.test.js), kein Server-Angebot,
//   - Anruf-Signale nur ueber eine bestehende Verbindung; steht keine, wird
//     zuerst eine ueber Tor aufgebaut - scheitert das, endet der Anruf mit
//     klarem Hinweis (CallManager),
//   - eingehende Anrufe ohne laufende App: RTCStore puffert das Angebot und
//     laesst nativ klingeln (ersetzt den frueheren Server-Poll),
//   - BackgroundSync.ensureConnection baut die Tor-Verbindung sofort auf.
const fs = require('fs');
const path = require('path');
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
  connect: jest.fn(async () => 'out-call'),
  send: jest.fn(async () => {}),
  close: jest.fn(),
};

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const Tor = require('../../TorTransport');
const BG = require('../../BackgroundSync');
const CallManager = require('../../CallManager').default;
const { CallState } = require('../../CallManager');

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_ruf', name: 'Rufus', role: 'initiator', torOnion: PEER_ONION };

function usableConn(transport = 'tor') {
  return {
    transport, keyExchangeDone: true, sharedSecret: SECRET, _closed: false,
    dataChannel: { readyState: 'open', send() {} }, pc: { iceConnectionState: 'connected' },
    pendingMsgs: [], close: jest.fn(), sendMessage: jest.fn(() => 'sent'),
  };
}

beforeEach(async () => {
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  jest.clearAllMocks();
  Tor._resetTorTransportForTests();
  BG._resetTorFallbackForTests();
  RTCStore.resetAll();
  RTCStore.callSignalHandler = null;
  RTCStore.connectionEnsurer = BG.ensureConnection;   // einzelne Tests ersetzen ihn
  await EncryptedStorage.clear();
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
  await EncryptedStorage.setItem('shared_secret_' + CONTACT.id, SECRET);
  RTCStore.sharedSecrets.set(CONTACT.id, SECRET);
  Tor._setTorStateForTests({ status: 'ON', onion: MY_ONION });
});

describe('statisch: kein Server mehr', () => {
  test('RelayClient.js, relay.js und pushSender.js sind entfernt; kein nativer Quelltext importiert einen Server-Client', () => {
    for (const f of ['RelayClient.js', 'relay.js', 'pushSender.js']) expect(fs.existsSync(path.join(ROOT, f))).toBe(false);
    for (const f of ['App.tsx', 'BackgroundSync.js', 'CallManager.js', 'TorTransport.js', 'DirectUpgrade.js', 'RTCStore.js',
      'WebRTCManager.js', 'index.js', 'ImageCrypto.js', 'AudioCrypto.js', 'FileCrypto.js']) {
      const src = readSrc(f);
      expect(src).not.toMatch(/from '\.\/RelayClient'|import\('\.\/RelayClient'\)|RELAY_URL/);
    }
  });

  test('AppConfig: kein STUN (auch kein oeffentlicher), kein eigener Server, keine Relay-/TURN-Adresse', () => {
    // STUN-Ausstieg (STUN_AUSSTIEG_PLAN.md): bis 1.1.0 stand hier ein Pool aus
    // vier oeffentlichen STUN-Diensten. Jetzt fragt Malachi keinen mehr.
    const cfg = require('../../AppConfig');
    for (const k of ['STUN_POOL', 'STUN_PER_CONNECTION', 'STUN_URL', 'STUN_HOST', 'RELAY_URL']) expect(cfg[k]).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/stuns?:|turns?:|duckdns/i);
  });

  test('Kopplung nur ueber Tor: ConnectScreen nutzt pairViaTor/registerPairingInvite bzw. den Tor-Treffpunkt (PhonePairingPanel), keine Server-Suche, kein Server-Angebot', () => {
    const app = readSrc('App.tsx');
    const start = app.indexOf('function ConnectScreen(');
    const screen = app.slice(start, app.indexOf('function QRScannerScreen(', start));
    expect(screen).toMatch(/pairViaTor\(\{ onion, token, pskB64, contactId, onPaired: winPairing \}\)/);
    expect(screen).toMatch(/registerPairingInvite\(token, \{/);
    expect(screen).toMatch(/onionFromInvite\(source\)/);
    // Telefonnummer-Kopplung (Okt. 2026) wieder da - aber serverlos: nur ueber
    // PhonePairingPanel/PhonePairing.js (Tor-Treffpunkt), nie ueber /phone/* o.ae.
    expect(screen).not.toMatch(/\/phone\/|phone_connect|hashPhone|SignalOffer|SignalAnswer|createOffer|createAnswer|fetch\(/);
    expect(screen).toMatch(/require\('\.\/PhonePairingPanel'\)\.default/);
    for (const f of ['PhonePairing.js', 'PhonePairingPanel.tsx']) {
      expect(readSrc(f)).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|httpRequest|RELAY_URL|RelayClient|EncryptedStorage\.setItem|AsyncStorage/);
    }
    // Einladung zeigt den QR-Code erst, wenn die eigene Onion-Adresse bekannt UND
    // im Tor-Netz nachweislich auffindbar ist (Selbsttest), notfalls nach 90 s.
    expect(screen).toMatch(/const inviteReady = !!\(invite && onionHost && \(torSt\.reachable \|\| inviteWaitOver\)\);/);
    // Kopplung (Live-Test 2026-10-18): durchgehend bis 3 min, paralleler
    // Versuch nach 15 s, frischer Versuch bei eintreffender Beschreibung,
    // Tor-Neustart, wenn die Beschreibung 60 s ausbleibt; dieselbe Einladung
    // bleibt beim erneuten Oeffnen gueltig und wird beim Verlassen nicht abgemeldet.
    expect(screen).toMatch(/const stopKick = onDescriptorReceived\(onion, \(\) => \{/);
    expect(screen).toMatch(/else if \(inFlight === 1 && !keyExchange && Date\.now\(\) - lastLaunch > PAIR_HEDGE_MS\) launch\(\);/);
    expect(screen).toMatch(/!descriptorReceivedSince\(onion, started\)\) \{\s*torRestarted = true;/);
    expect(screen).toMatch(/OPEN_INVITE && Date\.now\(\) - OPEN_INVITE\.createdAt < OPEN_INVITE_REUSE_MS/);
    expect(screen).toMatch(/return \(\) => \{ cancelled = true; \};/);
    expect(screen).toMatch(/BACKGROUND_PAIRED\?\.\(newContact, torRtc\)/);
  });
});

describe('Anruf-Signale ohne bestehende Verbindung', () => {
  test('Angebot: zuerst Verbindung ueber Tor aufbauen (connectionEnsurer), dann ueber sie senden', async () => {
    const conn = usableConn();
    RTCStore.connectionEnsurer = jest.fn(async (id) => { RTCStore.connections.set(id, conn); return conn; });
    const cm = new CallManager({ contactId: CONTACT.id, peerName: 'Rufus' });
    cm.role = 'caller';
    expect(await cm._sendSignal({ type: 'offer', payload: { sdp: 'v=0' } })).toBe(true);
    expect(RTCStore.connectionEnsurer).toHaveBeenCalledWith(CONTACT.id, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    const msg = JSON.parse(conn.sendMessage.mock.calls[0][0]);
    expect(msg).toMatchObject({ type: 'system', subtype: 'call_signal', signal: { type: 'offer' } });
    expect(typeof msg.signal.payload.enc).toBe('string');
    expect(JSON.stringify(msg)).not.toMatch(/v=0/);              // SDP nur verschluesselt
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Kontakt auch ueber Tor nicht erreichbar: Anruf zeigt "Verbinde ueber Tor", endet dann mit klarem Hinweis - ohne Signal an irgendwen', async () => {
    RTCStore.connectionEnsurer = jest.fn(async () => null);
    const states = [];
    const notices = [];
    const cm = new CallManager({ contactId: CONTACT.id, peerName: 'Rufus', onStateChange: (s) => states.push(s), onNotice: (t) => notices.push(t) });
    await cm.startCall();
    expect(states[0]).toBe(CallState.PREPARING);
    expect(states).toContain(CallState.ENDED);
    expect(notices.join(' ')).toMatch(/nicht erreichbar/);
    expect(cm.pc).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    await tick(600);
    expect(cm.state).toBe(CallState.IDLE);
  });

  test('waehrend "Verbinde ueber Tor" aufgelegt: kein Anruf wird danach noch gestartet', async () => {
    let release;
    const conn = usableConn();
    RTCStore.connectionEnsurer = jest.fn(() => new Promise((r) => { release = () => { RTCStore.connections.set(CONTACT.id, conn); r(conn); }; }));
    const cm = new CallManager({ contactId: CONTACT.id, peerName: 'Rufus' });
    const p = cm.startCall();
    await tick();
    expect(cm.state).toBe(CallState.PREPARING);
    cm.endCall('user_hangup');
    release();
    await p;
    expect(conn.sendMessage).not.toHaveBeenCalled();
    expect(cm.pc).toBeNull();
  });
});

describe('eingehende Anrufe ohne laufende App (ersetzt den Server-Poll)', () => {
  test('Angebot wird gepuffert und klingelt nativ; ICE wird angehaengt; Abbruch des Anrufers beendet das Klingeln', () => {
    const conn = usableConn();
    RTCStore.setConnection(CONTACT.id, conn);
    const ring = [];
    const cancelled = [];
    RTCStore.incomingCallNotifier = (id) => ring.push(id);
    RTCStore.callCancelledNotifier = (id) => cancelled.push(id);
    conn.onMessage({ type: 'system', subtype: 'call_signal', signal: { type: 'offer', payload: { enc: 'x' } } });
    conn.onMessage({ type: 'system', subtype: 'call_signal', signal: { type: 'ice', payload: { enc: 'y' } } });
    expect(ring).toEqual([CONTACT.id]);
    expect(RTCStore.pendingCalls.get(CONTACT.id).signals.map((s) => s.type)).toEqual(['offer', 'ice']);
    expect(typeof RTCStore.pendingCalls.get(CONTACT.id).at).toBe('number');
    conn.onMessage({ type: 'system', subtype: 'call_signal', signal: { type: 'cancel', payload: { enc: 'z' } } });
    expect(cancelled).toEqual([CONTACT.id]);
    expect(RTCStore.pendingCalls.has(CONTACT.id)).toBe(false);
    RTCStore.incomingCallNotifier = null;
    RTCStore.callCancelledNotifier = null;
  });

  test('laeuft die App, gehen Anruf-Signale direkt an sie (kein Puffer, kein natives Klingeln aus dem Hintergrundpfad)', () => {
    const conn = usableConn();
    RTCStore.setConnection(CONTACT.id, conn);
    const ring = jest.fn();
    RTCStore.incomingCallNotifier = ring;
    const got = [];
    RTCStore.callSignalHandler = (id, s) => got.push(s.type);
    conn.onMessage({ type: 'system', subtype: 'call_signal', signal: { type: 'offer', payload: { enc: 'x' } } });
    expect(got).toEqual(['offer']);
    expect(ring).not.toHaveBeenCalled();
    expect(RTCStore.pendingCalls.size).toBe(0);
    RTCStore.callSignalHandler = null;
    RTCStore.incomingCallNotifier = null;
  });
});

describe('BackgroundSync.ensureConnection (fuer Anrufe)', () => {
  test('ohne Verbindung: waehlt sofort ueber Tor (ohne Wartezeiten) und liefert die Verbindung, sobald sie nutzbar ist', async () => {
    const p = BG.ensureConnection(CONTACT.id, { timeoutMs: 3000 });
    await tick(50);
    expect(NativeModules.MalachiTor.connect).toHaveBeenCalledWith(PEER_ONION, 7777);
    const conn = usableConn();
    RTCStore.connections.set(CONTACT.id, conn);
    expect(await p).toBe(conn);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('steht schon eine nutzbare Verbindung, wird sie sofort geliefert', async () => {
    const conn = usableConn('direct');
    RTCStore.connections.set(CONTACT.id, conn);
    expect(await BG.ensureConnection(CONTACT.id, { timeoutMs: 1000 })).toBe(conn);
    expect(NativeModules.MalachiTor.connect).not.toHaveBeenCalled();
  });

  test('RTCStore kennt ensureConnection als connectionEnsurer (CallManager braucht kein BackgroundSync-Import)', () => {
    expect(RTCStore.connectionEnsurer).toBe(BG.ensureConnection);
  });
});
