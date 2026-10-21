// Zustell-Garantie (Outbox-Prinzip, 2026-10): KEINE Nachricht darf verloren
// gehen - auch nicht bei Netzwechsel (WLAN <-> Mobilfunk), bei Kanaelen, die
// noch "open" melden, aber tot sind, bei App-Ende mitten im Senden oder bei
// gleichzeitigen Flushes. Siehe BackgroundSync.js (Absender: Warteschlange)
// und RTCStore.js (Empfaenger: zentrale Bestaetigung, persistente Dedup,
// verschluesselte Empfangs-Ablage).
//
// Aufbau: ZWEI vollstaendige "Geraete" (Alice, Bob) mit je eigener
// Modul-Instanz (jest.isolateModules - eigenes RTCStore, eigene
// BackgroundSync-Warteschlange, eigener WebRTCManager) und je eigenem,
// dauerhaftem Speicher (EncryptedStorage/RNFS-Mock pro Geraet, ueberlebt
// einen simulierten App-Neustart = neue Modul-Instanz). Verbunden ueber ein
// Kanalpaar im Speicher, dessen "Netz" sich gezielt toeten laesst, waehrend
// beide Seiten weiter readyState 'open' sehen. Echte Verschluesselung
// (MessageCrypto), echte Frische-/Replay-Pruefung (WebRTCManager).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Speicher pro Geraet (global, damit er jest.isolateModules/Neustarts ueberlebt).
jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: async (k, v) => { store.set(k, String(v)); },
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      removeItem: async (k) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});
jest.mock('react-native-fs', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockFiles = global.__mockFiles || {};
  const files = (global.__mockFiles[dev] = global.__mockFiles[dev] || new Map());
  return {
    __files: files,
    DocumentDirectoryPath: '/mock/' + dev,
    CachesDirectoryPath: '/mock/caches/' + dev,
    writeFile: async (p, d) => { files.set(p, d); },
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    unlink: async (p) => { files.delete(p); },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    readDir: async () => [...files.keys()].map((p) => ({ name: p.split('/').pop(), path: p, isFile: () => true })),
  };
});
// Die App hat keinen Server-Client mehr (RelayClient.js entfernt, Okt. 2026) -
// nichts zu mocken.

const A_ID = 'c_alice'; // so heisst Alice auf Bobs Geraet
const B_ID = 'c_bob';   // so heisst Bob auf Alices Geraet
const PAIR_SECRET = crypto.randomBytes(32).toString('base64');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + (what || fn.toString().slice(0, 140)));
    await tick(10);
  }
}

// Laedt ein "Geraet" (= App-Start). Gleicher Name = gleicher Speicher.
function loadDevice(name, peerId) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    dev = {
      name,
      peerId,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      MC: require('../../MessageCrypto'),
      ES: require('react-native-encrypted-storage').default,
      RNFS: require('react-native-fs'),
    };
  });
  global.__mockDevice = undefined;
  // Wie App.tsx beim Start: Secret des Kontakts laden (loadPreviousSecret
  // laedt dabei Dedup-Liste/Faehigkeiten/Empfangs-Ablage mit).
  dev.RTCStore.sharedSecrets.set(peerId, PAIR_SECRET);
  dev.ready = dev.BG.loadPreviousSecret(peerId).then(() => dev.RTCStore.preloadContact(peerId));
  return dev;
}

// Kanalpaar im Speicher. net.dead: Pakete verschwinden spurlos, beide Seiten
// sehen weiterhin readyState 'open' (Netzwechsel/Zombie-Verbindung).
// net.dropBtoA: nur die Rueckrichtung (z.B. Bestaetigungen) geht verloren.
function makeLink() {
  const net = { dead: false, dropBtoA: false, aToB: [], bToA: [] };
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; } });
  const a = mk();
  const b = mk();
  a.send = (d) => {
    if (a.readyState !== 'open') throw new Error('Kanal zu');
    net.aToB.push(d);
    if (!net.dead) setTimeout(() => b.onmessage?.({ data: d }), 0);
  };
  b.send = (d) => {
    if (b.readyState !== 'open') throw new Error('Kanal zu');
    net.bToA.push(d);
    if (!net.dead && !net.dropBtoA) setTimeout(() => a.onmessage?.({ data: d }), 0);
  };
  return { a, b, net };
}

function attach(dev, ch, sessionSecret) {
  const rtc = new dev.WebRTCManager(() => {}, () => {}, () => {});
  rtc.chatId = dev.peerId;
  rtc.sharedSecret = sessionSecret;
  rtc.keyExchangeDone = true;
  rtc.dataChannel = ch;
  rtc.pc = { iceConnectionState: 'connected', close() {} };
  rtc._setupDataChannel(ch);
  rtc._lastActivity = Date.now();
  dev.RTCStore.sharedSecrets.set(dev.peerId, sessionSecret);
  dev.RTCStore.setConnection(dev.peerId, rtc);
  // Wie BackgroundSync/TorTransport beim Verbindungsaufbau.
  rtc._onReady = () => dev.BG.flushQueue(dev.peerId, rtc);
  return rtc;
}

// Neue Verbindung inkl. "Schluesseltausch fertig" (_onKeyExchange: Profil +
// Faehigkeiten senden, danach Warteschlange abarbeiten) auf beiden Seiten.
async function connect(alice, bob, { handshake = true } = {}) {
  const session = crypto.randomBytes(32).toString('base64');
  const link = makeLink();
  const rtcA = attach(alice, link.a, session);
  const rtcB = attach(bob, link.b, session);
  if (handshake) {
    await Promise.all([rtcA._onKeyExchange(), rtcB._onKeyExchange()]);
    await waitFor(() => alice.RTCStore.getPeerCaps(B_ID) !== 'unknown' && bob.RTCStore.getPeerCaps(A_ID) !== 'unknown',
      3000, 'Faehigkeiten ausgetauscht');
  }
  return { rtcA, rtcB, link, session };
}

async function queueOf(dev) {
  const raw = await dev.ES.getItem('queue_' + dev.peerId);
  return raw ? JSON.parse(raw) : [];
}

// Status-Mitschnitt des Absender-Chats (wie ChatScreen: Receipts -> Status).
function trackStatuses(dev) {
  const st = new Map();
  dev.RTCStore.setMessageListener(dev.peerId, (m) => {
    if (m.type === 'receipt') st.set(m.msgId, dev.BG.mergeSendStatus(st.get(m.msgId), m.status));
  });
  return st;
}

function receivedTexts(list) {
  return list.filter((m) => m.type === 'text').map((m) => m.text);
}

let alice;
let bob;
beforeAll(() => {
  if (process.env.OUTBOX_TEST_LOGS) return; // zur Fehlersuche: Protokoll sichtbar lassen
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.warn.mockRestore?.();
});
beforeEach(async () => {
  global.__mockStores = {};
  global.__mockFiles = {};
  alice = loadDevice('alice', B_ID);
  bob = loadDevice('bob', A_ID);
  await Promise.all([alice.ready, bob.ready]);
});
afterEach(() => {
  for (const d of [alice, bob]) {
    d.BG._resetOutboxForTests();
    for (const rtc of d.RTCStore.connections.values()) { try { rtc.close(); } catch {} }
  }
});

describe('Absender: write-ahead, Entfernen erst nach Bestaetigung, ehrlicher Status', () => {
  test('Text bei bestehender Verbindung: erst verschluesselt eingereiht (🕐), dann ✓, erst mit Bestaetigung ✓✓ und aus der Warteschlange', async () => {
    const statuses = trackStatuses(alice);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const { link } = await connect(alice, bob);

    let queuedSnapshot = null;
    const ok = await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'Hallo Bob', time: Date.now(), msgId: 't1' }, 't1', {
      onQueued: () => { queuedSnapshot = alice.ES.__store.get('queue_' + B_ID); },
    });
    expect(ok).toBe(true);
    // write-ahead: im Moment der Meldung "eingereiht" liegt der Eintrag
    // schon (verschluesselt) im Speicher - vor dem ersten Sendeversuch.
    const q0 = JSON.parse(queuedSnapshot);
    expect(q0).toEqual([expect.objectContaining({ type: 'text', msgId: 't1', encrypted: true })]);
    expect(alice.RNFS.__files.get(q0[0].path)).not.toMatch(/Hallo Bob/);
    expect(link.net.aToB.join('\n')).not.toMatch(/Hallo Bob/); // auch auf der Leitung nur verschluesselt

    await waitFor(() => statuses.get('t1') === 'delivered', 4000, '✓✓');
    expect(receivedTexts(bobSeen)).toEqual(['Hallo Bob']);
    await waitFor(async () => (await queueOf(alice)).length === 0, 2000, 'Warteschlange leer');
    expect([...alice.RNFS.__files.keys()].filter((p) => p.includes('queue_'))).toEqual([]);
  });

  test('ohne Verbindung: 🕐 (pending), kein ✓/✓✓; Zustellung erst mit der naechsten Verbindung', async () => {
    const statuses = trackStatuses(alice);
    const onQueued = jest.fn();
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'offline verfasst', time: Date.now(), msgId: 'o1' }, 'o1', { onQueued });
    expect(onQueued).toHaveBeenCalledWith(true); // -> UI 🕐
    await tick(30);
    expect(statuses.has('o1')).toBe(false);       // kein falsches ✓ oder ✓✓
    expect(await queueOf(alice)).toHaveLength(1);

    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    await connect(alice, bob);
    await waitFor(() => statuses.get('o1') === 'delivered', 4000, '✓✓ nach Verbindung');
    expect(receivedTexts(bobSeen)).toEqual(['offline verfasst']);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('ohne Shared Secret: nichts unverschluesselt einreihen, Status ❌', async () => {
    alice.RTCStore.sharedSecrets.delete(B_ID);
    await alice.ES.removeItem('shared_secret_' + B_ID);
    const onQueued = jest.fn();
    expect(await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'x', msgId: 'n1' }, 'n1', { onQueued })).toBe(false);
    expect(onQueued).toHaveBeenCalledWith(false);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('mergeSendStatus: ✓✓ wird nie auf ✓/🕐 zurueckgestuft, ✓ darf auf 🕐 zurueck (erneut wartend)', () => {
    const { mergeSendStatus } = alice.BG;
    expect(mergeSendStatus('delivered', 'sent')).toBe('delivered');
    expect(mergeSendStatus('delivered', 'pending')).toBe('delivered');
    expect(mergeSendStatus('delivered', 'read')).toBe('read');
    expect(mergeSendStatus('read', 'delivered')).toBe('read');
    expect(mergeSendStatus('sent', 'pending')).toBe('pending');
    expect(mergeSendStatus('pending', 'sent')).toBe('sent');
    expect(mergeSendStatus(undefined, 'pending')).toBe('pending');
  });

  test('Chat geschlossen: Status wird im gespeicherten Verlauf nachgezogen (nach Neustart kein veraltetes ✓)', async () => {
    await alice.ES.setItem('chat_' + B_ID, JSON.stringify([{ id: 'h1', text: 'hi', mine: true, status: 'pending' }]));
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'hi', time: Date.now(), msgId: 'h1' }, 'h1');
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'bestaetigt');
    await alice.BG.flushChatStatusWrites(B_ID);
    expect(JSON.parse(await alice.ES.getItem('chat_' + B_ID))[0].status).toBe('delivered');
  });
});

describe('Netzwechsel / tote Kanaele, die noch "open" melden', () => {
  test('Kanal tot beim Senden: ✓ (uebergeben), aber kein ✓✓ und Eintrag bleibt; neue Verbindung stellt genau einmal zu', async () => {
    const statuses = trackStatuses(alice);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    first.link.net.dead = true; // Netzwechsel: Pakete verschwinden, readyState bleibt 'open'

    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'ins Leere', time: Date.now(), msgId: 'z1' }, 'z1');
    await waitFor(() => statuses.get('z1') === 'sent', 2000, '✓');
    await tick(50);
    expect(statuses.get('z1')).toBe('sent'); // ehrlich: kein ✓✓
    expect(await queueOf(alice)).toHaveLength(1);
    expect(receivedTexts(bobSeen)).toHaveLength(0);

    // Zombie wird erkannt, neue Verbindung (z.B. Mobilfunk) steht.
    first.rtcA.close(); first.rtcB.close();
    await connect(alice, bob);
    await waitFor(() => statuses.get('z1') === 'delivered', 4000, '✓✓ ueber neue Verbindung');
    expect(receivedTexts(bobSeen)).toEqual(['ins Leere']);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('Netzwechsel mitten im Senden: Original kam an, nur die Bestaetigung ging verloren -> Wiederholung wird verworfen, aber bestaetigt', async () => {
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    first.link.net.dropBtoA = true; // Rueckweg weg - Bestaetigung geht verloren
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'einmal bitte', time: Date.now(), msgId: 'd1' }, 'd1');
    await waitFor(() => receivedTexts(bobSeen).length === 1, 3000, 'Original bei Bob');
    await tick(50);
    expect(await queueOf(alice)).toHaveLength(1); // ohne Bestaetigung nicht entfernt

    first.rtcA.close(); first.rtcB.close();
    const second = await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'Bestaetigung der Wiederholung');
    // Wiederholung kam an (zweite Uebergabe auf der Leitung) ...
    expect(second.link.net.aToB.length).toBeGreaterThan(0);
    // ... wurde aber nicht ein zweites Mal angezeigt.
    expect(receivedTexts(bobSeen)).toEqual(['einmal bitte']);
  });

  test('gleiche Verbindung ohne Bestaetigung: Wiederholung erst nach Ablauf der Wartezeit, dann mit wachsendem Abstand (keine Schleife im Sekundentakt)', async () => {
    const { link } = await connect(alice, bob);
    link.net.dead = true;
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'warte', time: Date.now(), msgId: 'b1' }, 'b1');
    await waitFor(() => alice.BG._outboxRecordForTests(B_ID, 'b1'), 2000, 'erste Uebergabe');
    const rtcA = alice.RTCStore.connections.get(B_ID);
    const sentBefore = link.net.aToB.length;
    // Sofortiger erneuter Flush (z.B. weitere Nachricht/Zyklus) sendet NICHT erneut.
    await alice.BG.flushQueue(B_ID, rtcA);
    await alice.BG.flushQueue(B_ID, rtcA);
    expect(link.net.aToB.length).toBe(sentBefore);
    const rec1 = alice.BG._outboxRecordForTests(B_ID, 'b1');
    const firstWait = rec1.waitUntil - rec1.sentAt;
    expect(firstWait).toBeGreaterThanOrEqual(20000);

    // Frist abgelaufen -> genau eine Wiederholung, naechste Frist doppelt so lang.
    rec1.waitUntil = 0;
    await alice.BG.flushQueue(B_ID, rtcA);
    expect(link.net.aToB.length).toBe(sentBefore + 1);
    const rec2 = alice.BG._outboxRecordForTests(B_ID, 'b1');
    expect(rec2.waitUntil - rec2.sentAt).toBe(2 * firstWait);
    expect((await queueOf(alice))[0].attempts).toBe(2);
    // Ein Weck-Timer ist fuer genau diese Frist geplant (kein Polling).
    await alice.BG.flushQueue(B_ID, rtcA);
    expect(link.net.aToB.length).toBe(sentBefore + 1);
  });
});

describe('App-Neustart', () => {
  test('Absender beendet direkt nach dem Einreihen (vor dem Senden): nach Neustart zugestellt', async () => {
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'vor dem Absturz', time: Date.now(), msgId: 'r1' }, 'r1');
    // "App beendet": neue Modul-Instanz, gleicher Speicher.
    alice = loadDevice('alice', B_ID);
    await alice.ready;
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    await connect(alice, bob);
    await waitFor(() => receivedTexts(bobSeen).length === 1, 4000, 'Zustellung nach Neustart');
    await waitFor(async () => (await queueOf(alice)).length === 0, 3000, 'bestaetigt');
  });

  test('Absender beendet waehrend des Sendens (Kanal tot, keine Bestaetigung): nach Neustart erneut gesendet, kommt genau einmal an', async () => {
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    first.link.net.dropBtoA = true;
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'mitten drin', time: Date.now(), msgId: 'r2' }, 'r2');
    await waitFor(() => receivedTexts(bobSeen).length === 1, 3000, 'Original');
    first.rtcB.close();
    alice = loadDevice('alice', B_ID); // App-Ende + Neustart
    await alice.ready;
    expect(await queueOf(alice)).toHaveLength(1);
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'bestaetigt nach Neustart');
    expect(receivedTexts(bobSeen)).toEqual(['mitten drin']);
  });

  test('Empfaenger-Neustart: Dedup-Liste ist persistent - eine nach dem Neustart wiederholte Nachricht erscheint nicht doppelt', async () => {
    let bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    first.link.net.dropBtoA = true; // Bestaetigung geht verloren
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'nur einmal', time: Date.now(), msgId: 'p1' }, 'p1');
    await waitFor(() => receivedTexts(bobSeen).length === 1, 3000, 'Original bei Bob');
    await waitFor(async () => (await bob.ES.getItem('rx_seen_' + A_ID) || '').includes('p1'), 2000, 'Dedup-Liste gespeichert');
    first.rtcA.close(); first.rtcB.close();

    bob = loadDevice('bob', A_ID); // Empfaenger-Neustart
    await bob.ready;
    bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'Wiederholung bestaetigt');
    expect(receivedTexts(bobSeen)).toEqual([]); // Duplikat verworfen
  });

  test('Empfaenger-Chat geschlossen: Nachricht liegt verschluesselt in der Empfangs-Ablage, wird erst danach bestaetigt und uebersteht einen Neustart', async () => {
    await connect(alice, bob);
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'im Hintergrund', time: Date.now(), msgId: 'i1' }, 'i1');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'bestaetigt');
    // Bestaetigt -> muss dauerhaft abgelegt sein, verschluesselt.
    const index = JSON.parse(await bob.ES.getItem('rx_inbox'));
    expect(index).toHaveLength(1);
    const blob = bob.RNFS.__files.get(index[0].path);
    expect(blob).toBeTruthy();
    expect(blob).not.toMatch(/im Hintergrund/);

    bob = loadDevice('bob', A_ID); // App beendet, bevor der Chat geoeffnet wurde
    await bob.ready;
    const buffered = await bob.RTCStore.takeBuffered(A_ID);
    expect(receivedTexts(buffered)).toEqual(['im Hintergrund']);
    // Abgeholt -> Ablage geraeumt (Index + Datei).
    await waitFor(async () => !(await bob.ES.getItem('rx_inbox')), 2000, 'Ablage geraeumt');
    expect([...bob.RNFS.__files.keys()].filter((p) => p.includes('inbox_'))).toEqual([]);
  });
});

describe('Medien: Bestaetigung erst nach vollstaendigem Zusammensetzen', () => {
  const IMG = crypto.randomBytes(150 * 1024).toString('base64'); // > 3 Chunks

  test('Bild: Empfaenger bestaetigt per msgId erst nach dem letzten Chunk, Bild unverfaelscht (ohne Fuellzeichen)', async () => {
    const statuses = trackStatuses(alice);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    await connect(alice, bob);
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG, mimeType: 'image/jpeg' }, 'img1');
    await waitFor(() => statuses.get('img1') === 'delivered', 6000, '✓✓ Bild');
    const imgs = bobSeen.filter((m) => m.type === 'image_complete');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].msgId).toBe('img1');
    expect(imgs[0].base64).toBe(IMG);
    // Rohe Chunks erreichen den Chat-Bildschirm nicht mehr.
    expect(bobSeen.some((m) => m.type === 'img_chunk' || m.type === 'img_end')).toBe(false);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('Abbruch mitten im Transfer (Kanal geht zu): Eintrag bleibt ohne ✓, naechste Verbindung schickt das Bild KOMPLETT neu, es erscheint genau einmal', async () => {
    const statuses = trackStatuses(alice);
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    // Nach dem ersten Chunk reisst die Verbindung ab.
    const origSend = first.link.a.send;
    let n = 0;
    first.link.a.send = (d) => { if (++n === 2) first.link.a.readyState = 'closed'; return origSend(d); };
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG, mimeType: 'image/png' }, 'img2');
    await waitFor(() => n >= 2, 3000, 'Abbruch');
    await tick(100);
    expect(statuses.get('img2')).not.toBe('sent');
    expect(statuses.get('img2')).not.toBe('delivered');
    expect(await queueOf(alice)).toHaveLength(1);
    expect(bobSeen.filter((m) => m.type === 'image_complete')).toHaveLength(0);
    // Teilstueck liegt beim Empfaenger (wird nach STALE_TRANSFER_MS verworfen).
    expect(bob.RTCStore.imgBuffer.size).toBe(1);

    first.rtcB.close();
    await connect(alice, bob);
    await waitFor(() => statuses.get('img2') === 'delivered', 6000, '✓✓ nach Neuversand');
    const imgs = bobSeen.filter((m) => m.type === 'image_complete');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].base64).toBe(IMG);
  });

  test('Medium kam an, Bestaetigung verloren: der komplette Neuversand (neue imageId) wird per msgId verworfen und bestaetigt', async () => {
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    first.link.net.dropBtoA = true;
    await alice.BG.sendViaOutbox(B_ID, 'file', { base64: IMG, fileName: 'a.pdf', mimeType: 'application/pdf', size: 1 }, 'f1');
    await waitFor(() => bobSeen.some((m) => m.type === 'file_complete'), 6000, 'Datei bei Bob');
    first.rtcA.close(); first.rtcB.close();
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 6000, 'Wiederholung bestaetigt');
    expect(bobSeen.filter((m) => m.type === 'file_complete')).toHaveLength(1);
  });

  test('Sprachnachricht bei geschlossenem Chat: erst nach Zusammensetzen + Ablage bestaetigt; Einmal-Nachricht erscheint nach dem Abspielen auch bei Wiederholung nicht erneut', async () => {
    const first = await connect(alice, bob);
    first.link.net.dropBtoA = true; // Bestaetigung geht verloren
    await alice.BG.sendViaOutbox(B_ID, 'audio', { base64: IMG, durationMs: 1200, viewOnce: true }, 'a1');
    await waitFor(async () => !!(await bob.ES.getItem('rx_inbox')), 6000, 'Audio abgelegt');
    // Bob oeffnet den Chat, hoert die Einmal-Nachricht ab (danach geloescht).
    const taken = await bob.RTCStore.takeBuffered(A_ID);
    expect(taken.filter((m) => m.type === 'audio_complete')).toEqual([expect.objectContaining({ msgId: 'a1', viewOnce: true })]);

    // Alice wiederholt (neue Verbindung) - darf nicht wieder auftauchen.
    first.rtcA.close(); first.rtcB.close();
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 6000, 'Wiederholung bestaetigt');
    expect((bob.RTCStore.buffer.get(A_ID) || []).filter((m) => m.type === 'audio_complete')).toHaveLength(0);
  });
});

describe('Gleichzeitige Flushes / Einreihen waehrend eines Flush', () => {
  test('drei Flushes gleichzeitig: jede Nachricht genau einmal auf der Leitung, nichts verloren', async () => {
    const { link, rtcA } = await connect(alice, bob);
    link.net.dead = true; // keine Bestaetigungen - es soll nur gezaehlt werden
    for (const id of ['c1', 'c2', 'c3']) {
      await alice.BG.queueOffline(B_ID, 'text', { type: 'text', text: id, time: Date.now(), msgId: id }, PAIR_SECRET, id);
    }
    const before = link.net.aToB.length;
    await Promise.all([alice.BG.flushQueue(B_ID, rtcA), alice.BG.flushQueue(B_ID, rtcA), alice.BG.flushQueue(B_ID, rtcA)]);
    expect(link.net.aToB.length - before).toBe(3);
    expect((await queueOf(alice)).map((i) => i.msgId)).toEqual(['c1', 'c2', 'c3']);
  });

  test('Einreihen waehrend eines laufenden Flush geht nicht verloren (withQueueLock)', async () => {
    const { link, rtcA } = await connect(alice, bob);
    link.net.dead = true;
    await alice.BG.queueOffline(B_ID, 'image', { base64: IMG_SMALL(), mimeType: 'image/jpeg' }, PAIR_SECRET, 'm1');
    const flushing = alice.BG.flushQueue(B_ID, rtcA); // Medium braucht etwas
    const queued = alice.BG.queueOffline(B_ID, 'text', { type: 'text', text: 'dazwischen', time: Date.now(), msgId: 'm2' }, PAIR_SECRET, 'm2');
    await Promise.all([flushing, queued]);
    expect((await queueOf(alice)).map((i) => i.msgId).sort()).toEqual(['m1', 'm2']);
  });
});
function IMG_SMALL() { return crypto.randomBytes(70 * 1024).toString('base64'); }

describe('Steuersignale (clear_chat, delete_message, secret_start/end, delete_chat)', () => {
  test('Wiederholtes secret_start (gleicher ts, Bestaetigung war verloren): Empfaenger verwirft es (Replay-Schutz), bestaetigt aber - keine Endloswiederholung', async () => {
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    const first = await connect(alice, bob);
    first.link.net.dropBtoA = true;
    const sig = { type: 'system', subtype: 'secret_start', mins: 5, endsAt: Date.now() + 300000, ts: Date.now() };
    await alice.BG.sendViaOutbox(B_ID, 'system', sig, 'secretstart_' + sig.ts);
    await waitFor(() => bobSeen.some((m) => m.subtype === 'secret_start'), 3000, 'secret_start bei Bob');
    first.rtcA.close(); first.rtcB.close();
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'Wiederholung bestaetigt');
    expect(bobSeen.filter((m) => m.subtype === 'secret_start')).toHaveLength(1);
  });

  test('clear_chat-Wiederholung loescht keine NEUEREN Nachrichten (Dedup per ackId)', async () => {
    await bob.ES.setItem('chat_' + A_ID, JSON.stringify([{ id: 'alt', text: 'alt' }]));
    const first = await connect(alice, bob); // Bob: Chat geschlossen -> zentrale Verarbeitung
    first.link.net.dropBtoA = true;
    const ts = Date.now();
    await alice.BG.sendViaOutbox(B_ID, 'system', { type: 'system', subtype: 'clear_chat', ts }, 'clear_' + ts);
    await waitFor(async () => !(await bob.ES.getItem('chat_' + A_ID)), 3000, 'Verlauf geleert');
    // Danach neue Nachricht im Verlauf.
    await bob.ES.setItem('chat_' + A_ID, JSON.stringify([{ id: 'neu', text: 'nach dem Leeren' }]));
    first.rtcA.close(); first.rtcB.close();
    await connect(alice, bob);
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'Wiederholung bestaetigt');
    expect(JSON.parse(await bob.ES.getItem('chat_' + A_ID))).toEqual([{ id: 'neu', text: 'nach dem Leeren' }]);
  });

  test('delete_message traegt eigenen Zustell-Schluessel (ackId) - msgId bleibt die zu loeschende Nachricht', async () => {
    const { link } = await connect(alice, bob);
    await bob.ES.setItem('chat_' + A_ID, JSON.stringify([{ id: 'x1' }, { id: 'x2' }]));
    await alice.BG.sendViaOutbox(B_ID, 'system', { type: 'system', subtype: 'delete_message', msgId: 'x1', ts: Date.now() }, 'delmsg_x1');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'bestaetigt');
    expect(JSON.parse(await bob.ES.getItem('chat_' + A_ID))).toEqual([{ id: 'x2' }]);
    const session = alice.RTCStore.connections.get(B_ID).sharedSecret;
    const wire = link.net.aToB.map((d) => JSON.parse(d)).filter((m) => m.type === 'encrypted')
      .map((m) => JSON.parse(alice.MC.decryptMsg(m.data, session) || 'null'))
      .find((m) => m && m.subtype === 'delete_message');
    expect(wire).toMatchObject({ msgId: 'x1', ackId: 'delmsg_x1' });
  });

  test('Chat loeschen: noch nicht zugestellte Nachrichten verworfen, Kontakt erst nach Bestaetigung des Hinweises entfernt (beidseitig)', async () => {
    await alice.ES.setItem('contacts', JSON.stringify([{ id: B_ID, name: 'Bob' }]));
    await bob.ES.setItem('contacts', JSON.stringify([{ id: A_ID, name: 'Alice' }]));
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'nie zugestellt', time: Date.now(), msgId: 'k1' }, 'k1');
    await alice.BG.requestContactDeletion(B_ID);
    const q = await queueOf(alice);
    expect(q.map((i) => i.subtype || i.type)).toEqual(['delete_chat']);
    expect([...alice.RNFS.__files.keys()].filter((p) => p.includes('queue_text_'))).toEqual([]);

    // Handshake -> Warteschlange wird abgearbeitet (die Faehigkeiten werden
    // dabei mit dem Kontakt wieder entfernt, deshalb nicht darauf warten).
    const c = await connect(alice, bob, { handshake: false });
    await Promise.all([c.rtcA._onKeyExchange(), c.rtcB._onKeyExchange()]);
    await waitFor(async () => !(await alice.ES.getItem('queue_' + B_ID)) && !alice.RTCStore.connections.has(B_ID), 4000, 'Alice: Hinweis bestaetigt, Kontakt entfernt');
    await waitFor(() => !bob.RTCStore.connections.has(A_ID), 4000, 'Bob: Kontakt entfernt');
    await alice.BG.updateContacts(() => null);
    await bob.BG.updateContacts(() => null);
    expect(JSON.parse(await alice.ES.getItem('contacts'))).toEqual([]);
    expect(JSON.parse(await bob.ES.getItem('contacts'))).toEqual([]);
    expect([...alice.RNFS.__files.keys()].filter((p) => p.includes('queue_'))).toEqual([]);
    await waitFor(async () => !(await bob.ES.getItem('peer_caps_' + A_ID)), 2000, 'Faehigkeiten entfernt');
  });

  test('Kontakt entfernen / Geraet-Wipe der Gegenseite raeumt Empfangs-Ablage (Index + Dateien) und Dedup-Liste', async () => {
    await connect(alice, bob); // Bob: Chat geschlossen -> Ablage
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'abgelegt', time: Date.now(), msgId: 'w1' }, 'w1');
    await waitFor(async () => (await queueOf(alice)).length === 0, 4000, 'bestaetigt');
    expect(JSON.parse(await bob.ES.getItem('rx_inbox'))).toHaveLength(1);
    expect(await bob.ES.getItem('rx_seen_' + A_ID)).toMatch(/w1/);

    bob.BG.removeContactLocally(A_ID);
    await waitFor(async () => !(await bob.ES.getItem('rx_inbox')) && !(await bob.ES.getItem('rx_seen_' + A_ID)), 2000, 'geraeumt');
    expect([...bob.RNFS.__files.keys()].filter((p) => p.includes('inbox_'))).toEqual([]);
  });
});

describe('Secret Chat / Einmal-Nachrichten', () => {
  test('abgelaufene Secret-Nachricht wird nie mehr zugestellt (expiresAt)', async () => {
    const bobSeen = [];
    bob.RTCStore.setMessageListener(A_ID, (m) => bobSeen.push(m));
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'geheim', time: Date.now(), msgId: 's1', secret: true }, 's1',
      { ephemeral: true, expiresAt: Date.now() - 1 });
    await connect(alice, bob);
    await tick(100);
    expect(bobSeen.filter((m) => m.type === 'text')).toHaveLength(0);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('Gegenseite beendet den Secret Chat: noch wartende Secret-Nachrichten verfallen sofort, normale bleiben', async () => {
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'geheim', time: Date.now(), msgId: 's2', secret: true }, 's2',
      { ephemeral: true, expiresAt: Date.now() + 600000 });
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'normal', time: Date.now(), msgId: 'n2' }, 'n2');
    const { rtcA, link } = await connect(alice, bob, { handshake: false });
    link.net.dead = true; // nichts zustellen - nur der Effekt von secret_end zaehlt
    rtcA.onMessage({ type: 'system', subtype: 'secret_end', ts: Date.now(), ackId: 'secretend_1' });
    await waitFor(async () => (await queueOf(alice)).map((i) => i.msgId).join() === 'n2', 2000, 'Secret-Eintrag verworfen');
  });

  test('Empfaenger: Secret-Nachricht bei geschlossenem Chat nur im RAM (keine Ablage, nicht in der persistenten Dedup-Liste), Duplikat trotzdem verworfen', async () => {
    const { rtcB } = await connect(alice, bob, { handshake: false });
    rtcB.sendMessage = jest.fn(() => 'sent');
    const msg = { type: 'text', text: 'pst', time: Date.now(), msgId: 'sec1', secret: true };
    rtcB.onMessage(msg);
    rtcB.onMessage({ ...msg });
    await waitFor(() => rtcB.sendMessage.mock.calls.length === 2, 2000, 'beide bestaetigt');
    expect(bob.RTCStore.buffer.get(A_ID).filter((m) => m.type === 'text')).toHaveLength(1);
    expect(await bob.ES.getItem('rx_inbox')).toBeNull();
    expect(await bob.ES.getItem('rx_seen_' + A_ID) || '[]').not.toMatch(/sec1/);
    expect(rtcB.sendMessage.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { type: 'receipt', msgId: 'sec1', status: 'delivered' },
      { type: 'receipt', msgId: 'sec1', status: 'delivered' },
    ]);
  });

  test('Audit P1: Secret-Medien tragen das Kennzeichen bis zum Empfaenger - bei geschlossenem Chat nur im RAM, nie in der Empfangs-Ablage', async () => {
    const IMG = crypto.randomBytes(60 * 1024).toString('base64');
    const AUD = crypto.randomBytes(20 * 1024).toString('base64');
    const statuses = trackStatuses(alice);
    await connect(alice, bob);
    const meta = { ephemeral: true, expiresAt: Date.now() + 600000 };
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG, mimeType: 'image/jpeg' }, 'simg', meta);
    await alice.BG.sendViaOutbox(B_ID, 'audio', { base64: AUD, durationMs: 1200, viewOnce: false }, 'saud', meta);
    await alice.BG.sendViaOutbox(B_ID, 'file', { base64: AUD, fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1 }, 'sfil', meta);
    await waitFor(() => ['simg', 'saud', 'sfil'].every((id) => statuses.get(id) === 'delivered'), 8000, '✓✓ Secret-Medien');
    const buffered = bob.RTCStore.buffer.get(A_ID).filter((m) => /_complete$/.test(m.type));
    expect(buffered.map((m) => [m.type, m.msgId, m.secret])).toEqual([
      ['image_complete', 'simg', true], ['audio_complete', 'saud', true], ['file_complete', 'sfil', true],
    ]);
    expect(buffered[0].base64).toBe(IMG);
    expect(await bob.ES.getItem('rx_inbox')).toBeNull();
    expect([...bob.RNFS.__files.keys()].filter((p) => p.includes('inbox_'))).toEqual([]);
    expect(await bob.ES.getItem('rx_seen_' + A_ID) || '[]').not.toMatch(/simg|saud|sfil/);
  }, 15000);

  test('Audit P1: normales Medium bleibt ohne Kennzeichen und wird abgelegt', async () => {
    const statuses = trackStatuses(alice);
    await connect(alice, bob);
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: crypto.randomBytes(30 * 1024).toString('base64'), mimeType: 'image/jpeg' }, 'nimg');
    await waitFor(() => statuses.get('nimg') === 'delivered', 6000, '✓✓ Bild');
    const img = bob.RTCStore.buffer.get(A_ID).find((m) => m.type === 'image_complete');
    expect(img.secret).toBeUndefined();
    expect(await bob.ES.getItem('rx_inbox')).toMatch(/nimg|inbox_/);
  }, 10000);

  test('Audit P1: secret_end bei geschlossenem Chat raeumt wartende Secret-Inhalte aus dem RAM-Puffer, normale bleiben', async () => {
    const { rtcB } = await connect(alice, bob, { handshake: false });
    rtcB.sendMessage = jest.fn(() => 'sent');
    rtcB.onMessage({ type: 'text', text: 'geheim', time: Date.now(), msgId: 'sx1', secret: true });
    rtcB.onMessage({ type: 'text', text: JSON.stringify({ text: 'auch geheim', secret: true }), time: Date.now(), msgId: 'sx2' });
    rtcB.onMessage({ type: 'text', text: 'normal', time: Date.now(), msgId: 'nx1' });
    await waitFor(() => (bob.RTCStore.buffer.get(A_ID) || []).filter((m) => m.type === 'text').length === 3, 2000, 'gepuffert');
    rtcB.onMessage({ type: 'system', subtype: 'secret_end', ts: Date.now(), ackId: 'secretend_x' });
    await waitFor(() => (bob.RTCStore.buffer.get(A_ID) || []).filter((m) => m.type === 'text').length === 1, 2000, 'Secret-Inhalte weg');
    expect(bob.RTCStore.buffer.get(A_ID).filter((m) => m.type === 'text').map((m) => m.msgId)).toEqual(['nx1']);
    const taken = await bob.RTCStore.takeBuffered(A_ID);
    expect(taken.some((m) => /geheim/.test(JSON.stringify(m)))).toBe(false);
  });

  test('Audit P1: ChatScreen speichert keine Secret-Eintraege und verwirft abgelaufene aus dem Puffer (Quelltext-Pruefung)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
    expect(src).toMatch(/if \(m\.secret\) return false;\s+\/\/ Audit P1/);
    expect(src).toMatch(/if \(isSecretContent && !secretLive\) \{ secretDropped\+\+; return; \}/);
    // Eingehende Secret-Inhalte (live) werden gekennzeichnet - ueber die Ref, nicht den veralteten State.
    expect(src).toMatch(/secret: \(parsedMsg\.secret \|\| secretActiveRef\.current\) \? true : undefined/);
    expect(src).toMatch(/if \(msg\.secret \|\| secretActiveRef\.current\) entry\.secret = true;/);
    // Eigene Nachrichten waehrend des Secret Chats ebenso (Text, Bild, Audio, Datei, Standort).
    expect((src.match(/secret: +secretActive \|\| undefined/g) || []).length).toBeGreaterThanOrEqual(6);
  });
});

describe('Rueckwaertskompatibilitaet: Gegenseite mit aelterer App-Version (ohne caps)', () => {
  // Alte Gegenseite: bestaetigt nur Text, Medien/Steuersignale nie.
  function oldPeer() {
    const sent = [];
    const ch = { readyState: 'open', send: (d) => sent.push(d), close() { this.readyState = 'closed'; } };
    const rtc = attach(alice, ch, crypto.randomBytes(32).toString('base64'));
    // profile_name OHNE caps -> 'old'
    rtc.onMessage({ type: 'system', subtype: 'profile_name', name: 'Alt' });
    return { rtc, sent };
  }

  test('profile_name ohne caps wird als aeltere Version erkannt und gespeichert', async () => {
    oldPeer();
    expect(alice.RTCStore.getPeerCaps(B_ID)).toBe('old');
    await waitFor(async () => (await alice.ES.getItem('peer_caps_' + B_ID)) === 'old', 1000);
  });

  test('Medium: nach EINER Uebergabe ueber eine nachweislich lebende Verbindung gilt es als gesendet (✓), keine Wiederholung (alter Empfaenger wuerde es doppelt zeigen)', async () => {
    const statuses = trackStatuses(alice);
    const { rtc, sent } = oldPeer();
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG_SMALL(), mimeType: 'image/jpeg' }, 'old1');
    await waitFor(() => alice.BG._outboxRecordForTests(B_ID, 'old1'), 3000, 'uebergeben');
    const sentCount = sent.length;
    const rec = alice.BG._outboxRecordForTests(B_ID, 'old1');
    rtc._lastActivity = rec.sentAt + 1;  // Gegenseite lebte nach dem Senden (Fuellverkehr)
    rec.waitUntil = 0;                   // Frist ohne Bestaetigung abgelaufen
    await alice.BG.flushQueue(B_ID, rtc);
    expect(await queueOf(alice)).toHaveLength(0);
    expect(sent.length).toBe(sentCount);  // kein zweiter Versand
    expect(statuses.get('old1')).toBe('sent'); // ✓, ehrlich kein ✓✓
  });

  test('Medium ueber eine TOTE Verbindung (nach dem Senden kam nichts mehr): bleibt und geht ueber die naechste Verbindung erneut raus', async () => {
    const { rtc } = oldPeer();
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG_SMALL(), mimeType: 'image/jpeg' }, 'old2');
    await waitFor(() => alice.BG._outboxRecordForTests(B_ID, 'old2'), 3000, 'uebergeben');
    const rec = alice.BG._outboxRecordForTests(B_ID, 'old2');
    rtc._lastActivity = rec.sentAt - 1;  // seitdem Funkstille
    rtc.close();
    const next = oldPeer();
    next.rtc._lastActivity = Date.now();
    await alice.BG.flushQueue(B_ID, next.rtc);
    expect(next.sent.length).toBeGreaterThan(0);  // erneut gesendet
    expect(await queueOf(alice)).toHaveLength(1);
  });

  test('Steuersignal (clear_chat) an alte Gegenseite: nach einer Uebergabe ueber lebende Verbindung erledigt - nie erneut (wuerde dort neuere Nachrichten loeschen)', async () => {
    const { rtc, sent } = oldPeer();
    const ts = Date.now();
    await alice.BG.sendViaOutbox(B_ID, 'system', { type: 'system', subtype: 'clear_chat', ts }, 'clear_' + ts);
    await waitFor(() => sent.length === 1, 2000);
    const rec = alice.BG._outboxRecordForTests(B_ID, 'clear_' + ts);
    rtc._lastActivity = rec.sentAt + 1;
    rec.waitUntil = 0;
    await alice.BG.flushQueue(B_ID, rtc);
    expect(sent).toHaveLength(1);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('Text an alte Gegenseite ohne Bestaetigung: hoechstens 3 Versuche ueber lebende Verbindungen, dann ✓ statt Endlosschleife', async () => {
    const { rtc, sent } = oldPeer();
    await alice.BG.sendViaOutbox(B_ID, 'text', { type: 'text', text: 'alt', time: Date.now(), msgId: 'ot1' }, 'ot1');
    await waitFor(() => alice.BG._outboxRecordForTests(B_ID, 'ot1'), 2000, 'erste Uebergabe');
    for (let i = 0; i < 5; i++) {
      const rec = alice.BG._outboxRecordForTests(B_ID, 'ot1');
      if (!rec) break;
      rtc._lastActivity = rec.sentAt + 1;
      rec.waitUntil = 0;
      await alice.BG.flushQueue(B_ID, rtc);
    }
    expect(sent).toHaveLength(3);
    expect(await queueOf(alice)).toHaveLength(0);
  });

  test('neue Gegenseite (caps) gibt NIE auf: auch nach vielen unbestaetigten Versuchen bleibt das Medium in der Warteschlange', async () => {
    const sent = [];
    const ch = { readyState: 'open', send: (d) => sent.push(d), close() {} };
    const rtc = attach(alice, ch, crypto.randomBytes(32).toString('base64'));
    rtc.onMessage({ type: 'system', subtype: 'profile_name', name: 'Neu', caps: { ack: 1 } });
    expect(alice.RTCStore.getPeerCaps(B_ID)).toBe('new');
    await alice.BG.sendViaOutbox(B_ID, 'image', { base64: IMG_SMALL(), mimeType: 'image/jpeg' }, 'nw1');
    for (let i = 0; i < 4; i++) {
      await waitFor(() => alice.BG._outboxRecordForTests(B_ID, 'nw1'), 2000);
      const rec = alice.BG._outboxRecordForTests(B_ID, 'nw1');
      rtc._lastActivity = Date.now() + 1;
      rec.waitUntil = 0;
      await alice.BG.flushQueue(B_ID, rtc);
    }
    const q = await queueOf(alice);
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(5);
  });
});

describe('statisch: App.tsx nutzt fuer alle Sendewege die Warteschlange', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  test('Text, Standort, Bild, Datei, Sprachnachricht, Loeschen, Leeren, Secret Chat -> sendViaOutbox', () => {
    expect(src).toMatch(/sendViaOutbox\(chat\?\.id, 'text', \{\s*type: 'text', text: msgText/);
    expect(src).toMatch(/sendViaOutbox\(chat\?\.id, 'text', payload, msgId/);
    expect(src).toMatch(/sendViaOutbox\(chat\?\.id, 'image', \{ base64, mimeType \}, msgId/);
    // Datei: sendFileNow (auch fuer Siegel-Anhaenge), aufgerufen aus pickAndSendFile.
    expect(src).toMatch(/sendViaOutbox\(chat\?\.id, 'file', \{ base64, fileName, mimeType, size: bytes \}, msgId/);
    expect(src).toMatch(/await sendFileNow\(base64, fileName, mimeType, picked\.size\);/);
    expect(src).toMatch(/sendViaOutbox\(chat\?\.id, 'audio', \{ base64, durationMs, viewOnce \}, msgId/);
    expect(src).toMatch(/sendViaOutbox\(chatId, 'system', \{ type: 'system', subtype: 'delete_message', msgId, ts \}/);
    // Kein Inhalt mehr am Speicher vorbei direkt in den Kanal.
    expect(src).not.toMatch(/sendEncrypted(Image|Audio|File)\(/);
    expect(src).not.toMatch(/RTCStore\.sendMessage\(chat\?\.id, JSON\.stringify\(\{\s*type: 'text'/);
    expect(src).not.toMatch(/pendingReceipts/);
  });
  test('Statusanzeige: unbekannter/fehlgeschlagener Status nie als ✓✓', () => {
    const fn = src.slice(src.indexOf('function sendStatusIcon(status)'), src.indexOf('function ChatScreen('));
    expect(fn).toMatch(/default:\s*return '✓';/);
    expect(fn).toMatch(/case 'pending':\s*return '🕐';/);
    expect(src).not.toMatch(/item\.status === 'delivered' \? '✓✓' : '✓✓'/);
  });
});
