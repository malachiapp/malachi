// Nur-P2P-Umstellung 2026-09-29 (Produktvorgabe: "ausschliesslich P2P-
// Verbindung und Sende-Warteschlangen, nichts ueber den Server - sonst ist
// es kein echter P2P-Messenger").
//
// Vorher gingen "Chat geloescht", "Geraet zurueckgesetzt" und "Secret Chat
// gestartet/beendet" zusaetzlich verschluesselt per POST /packet ueber den
// Relay, und WebRTC durfte ueber TURN (Relay-Server im Datenpfad) laufen.
// Diese Datei prueft das neue Verhalten TATSAECHLICH (nicht nur statisch):
//   - Loesch-Hinweis wartet in der lokalen Warteschlange, kein Server-Aufruf,
//     Kontakt erst nach P2P-Zustellung endgueltig entfernt,
//   - Steuersignale wirken auch ohne offenen Chat (RTCStore -> BackgroundSync),
//   - der Live-Pfad nimmt verspaetet (aus der Warteschlange) zugestellte
//     Steuersignale an, verwirft Replays aber weiterhin ueber die Reihenfolge,
//   - kein TURN mehr in der ICE-Konfiguration (nativ + web).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

// Zustandsbehaftetes RNFS (der globale Mock vergisst geschriebene Dateien) -
// die Warteschlange legt ihre verschluesselten Eintraege als Dateien ab.
jest.mock('react-native-fs', () => {
  const files = new Map();
  return {
    __files: files,
    DocumentDirectoryPath: '/mock/documents',
    CachesDirectoryPath: '/mock/caches',
    writeFile: async (p, d) => { files.set(p, d); },
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    unlink: async (p) => { files.delete(p); },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    readDir: async () => [],
  };
});

// Seit Okt. 2026 gibt es gar keinen Server-Client mehr (RelayClient.js
// entfernt). Jeder Netzzugriff waere ein Verstoss gegen die Vorgabe - fetch
// wird hier als Spion ersetzt und muss unberuehrt bleiben.
const RelayClient = { fetchWithTimeout: jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); }) };
global.fetch = RelayClient.fetchWithTimeout;

const RNFS = require('react-native-fs');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const { encryptMsg, decryptMsg } = require('../../MessageCrypto');
const BG = require('../../BackgroundSync');
const { WebRTCManager, isPlausibleControlTimestamp } = require('../../WebRTCManager');

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OLD_SECRET = crypto.randomBytes(32).toString('base64');
const SESSION_SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_bob', name: 'Bob', role: 'initiator', unread: 0, last: 'hi' };
const OTHER = { id: 'c_carol', name: 'Carol', role: 'responder', unread: 0, last: '' };

async function flushContactWrites() {
  await BG.updateContacts(() => null);
}
async function storedContacts() {
  return JSON.parse(await EncryptedStorage.getItem('contacts'));
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeRtc(secret = SESSION_SECRET) {
  return {
    sharedSecret: secret,
    dataChannel: { readyState: 'open', send: jest.fn() },
    pc: { iceConnectionState: 'connected' },
    pendingMsgs: [],
    close: jest.fn(),
    sendMessage: jest.fn(() => 'sent'),
  };
}

let uiUpdates;
beforeEach(async () => {
  await EncryptedStorage.clear();
  RNFS.__files.clear();
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT, OTHER]));
  await EncryptedStorage.setItem('shared_secret_' + CONTACT.id, OLD_SECRET);
  await EncryptedStorage.setItem('chat_' + CONTACT.id, JSON.stringify([{ id: 'm1', text: 'hallo' }]));
  RTCStore.resetAll();
  RTCStore.sharedSecrets.set(CONTACT.id, OLD_SECRET);
  RelayClient.fetchWithTimeout.mockClear();
  uiUpdates = [];
  let uiState = [CONTACT, OTHER];
  BG.setUiContactsListener((updater) => { uiState = updater(uiState); uiUpdates.push(uiState); });
});

afterAll(() => BG.setUiContactsListener(null));

describe('Chat loeschen: nur P2P + lokale Sende-Warteschlange, nichts ueber den Server', () => {
  test('ohne Verbindung: Chat sofort unsichtbar, Verlauf weg, Hinweis verschluesselt in der Warteschlange, KEIN Relay-Aufruf', async () => {
    const result = await BG.requestContactDeletion(CONTACT.id);
    await flushContactWrites();
    expect(result).toBe('pending');

    // UI: sofort weg
    expect(uiUpdates.at(-1).map((c) => c.id)).toEqual([OTHER.id]);
    // Speicher: vorgemerkt statt geloescht (Secret wird fuer die Zustellung gebraucht)
    const stored = await storedContacts();
    const bob = stored.find((c) => c.id === CONTACT.id);
    expect(bob.pendingDelete).toBe(true);
    expect(typeof bob.pendingDeleteSince).toBe('number');
    expect(await EncryptedStorage.getItem('chat_' + CONTACT.id)).toBeNull();
    expect(await EncryptedStorage.getItem('shared_secret_' + CONTACT.id)).toBe(OLD_SECRET);

    // Warteschlange: genau ein verschluesselter System-Eintrag
    const queue = JSON.parse(await EncryptedStorage.getItem('queue_' + CONTACT.id));
    expect(queue).toHaveLength(1);
    // Double-Ratchet-Umbau: im Ruhezustand mit einem zufaelligen lokalen
    // Schluessel pro Eintrag verschluesselt - das Verbindungs-Secret steht
    // nicht mehr im Index (vorher secretUsed) und oeffnet den Eintrag nicht.
    expect(queue[0]).toMatchObject({ type: 'system', encrypted: true, v: 2 });
    expect(queue[0].secretUsed).toBeUndefined();
    expect(typeof queue[0].k).toBe('string');
    const blob = RNFS.__files.get(queue[0].path);
    expect(blob).not.toMatch(/delete_chat/); // nicht im Klartext abgelegt
    expect(decryptMsg(blob, OLD_SECRET)).toBeFalsy();
    expect(JSON.parse(decryptMsg(blob, queue[0].k, 'queue'))).toMatchObject({ type: 'system', subtype: 'delete_chat' });

    // Der Kern der Vorgabe: kein einziger Server-Aufruf
    expect(RelayClient.fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('naechste direkte Verbindung: Hinweis geht per DataChannel (mit dem NEUEN Session-Secret) raus, nach der Empfangsbestaetigung wird der Kontakt samt Secret/Queue endgueltig entfernt', async () => {
    await BG.requestContactDeletion(CONTACT.id);
    await flushContactWrites();
    const [queued] = JSON.parse(await EncryptedStorage.getItem('queue_' + CONTACT.id));

    const rtc = fakeRtc(SESSION_SECRET);
    await BG.flushQueue(CONTACT.id, rtc);

    expect(rtc.dataChannel.send).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(rtc.dataChannel.send.mock.calls[0][0]);
    expect(wire.type).toBe('encrypted');
    // Auf der Leitung unter dem aktuellen Session-Secret, nicht dem alten
    expect(decryptMsg(wire.data, OLD_SECRET)).toBeFalsy();
    expect(JSON.parse(decryptMsg(wire.data, SESSION_SECRET))).toMatchObject({ type: 'system', subtype: 'delete_chat', ackId: queued.msgId });

    // Zustell-Garantie (2026-10): ohne Bestaetigung bleibt der Kontakt
    // vorgemerkt - der Kanal koennte tot gewesen sein.
    await tick(700);
    await flushContactWrites();
    expect((await storedContacts()).find((c) => c.id === CONTACT.id).pendingDelete).toBe(true);

    // Gegenseite bestaetigt -> endgueltig entfernen.
    await BG.onQueueReceipt(CONTACT.id, queued.msgId);
    await tick(50);
    await flushContactWrites();
    expect((await storedContacts()).map((c) => c.id)).toEqual([OTHER.id]);
    expect(await EncryptedStorage.getItem('shared_secret_' + CONTACT.id)).toBeNull();
    expect(await EncryptedStorage.getItem('queue_' + CONTACT.id)).toBeNull();
    expect(RNFS.__files.size).toBe(0);
    expect(RelayClient.fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('DataChannel nicht offen: Hinweis bleibt in der Warteschlange, Kontakt bleibt vorgemerkt', async () => {
    await BG.requestContactDeletion(CONTACT.id);
    await flushContactWrites();
    const rtc = fakeRtc();
    rtc.dataChannel.readyState = 'connecting';
    await BG.flushQueue(CONTACT.id, rtc);
    await tick(700);
    await flushContactWrites();
    expect(rtc.dataChannel.send).not.toHaveBeenCalled();
    expect(JSON.parse(await EncryptedStorage.getItem('queue_' + CONTACT.id))).toHaveLength(1);
    expect((await storedContacts()).find((c) => c.id === CONTACT.id).pendingDelete).toBe(true);
  });

  test('ohne Secret (nie verbunden): kann niemanden benachrichtigen, wird sofort vollstaendig lokal entfernt', async () => {
    RTCStore.sharedSecrets.delete(CONTACT.id);
    await EncryptedStorage.removeItem('shared_secret_' + CONTACT.id);
    expect(await BG.requestContactDeletion(CONTACT.id)).toBe('removed');
    await flushContactWrites();
    expect((await storedContacts()).map((c) => c.id)).toEqual([OTHER.id]);
    expect(await EncryptedStorage.getItem('queue_' + CONTACT.id)).toBeNull();
    expect(RelayClient.fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('nie zustellbarer Hinweis: nach 30 Tagen wird der vorgemerkte Kontakt trotzdem endgueltig entfernt', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await EncryptedStorage.setItem('contacts', JSON.stringify([
      { ...CONTACT, pendingDelete: true, pendingDeleteSince: old }, OTHER,
    ]));
    await BG.runIncomingCycle({});
    await flushContactWrites();
    expect((await storedContacts()).map((c) => c.id)).toEqual([OTHER.id]);
    expect(await EncryptedStorage.getItem('shared_secret_' + CONTACT.id)).toBeNull();
  });
});

describe('Empfangene Steuersignale wirken auch ohne offenen Chat (RTCStore -> BackgroundSync.applyControlSignal)', () => {
  function connect(id) {
    const rtc = fakeRtc();
    RTCStore.setConnection(id, rtc);
    return rtc;
  }

  test('delete_chat ohne Listener: Kontakt wird sofort lokal entfernt, nichts gepuffert, kein Hinweis zurueck', async () => {
    const rtc = connect(CONTACT.id);
    rtc.onMessage({ type: 'system', subtype: 'delete_chat', ts: Date.now() });
    await tick();
    await flushContactWrites();
    expect((await storedContacts()).map((c) => c.id)).toEqual([OTHER.id]);
    expect(RTCStore.buffer.has(CONTACT.id)).toBe(false);
    expect(await EncryptedStorage.getItem('queue_' + CONTACT.id)).toBeNull();
    expect(rtc.sendMessage).not.toHaveBeenCalled();
    expect(RelayClient.fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('device_wiped ohne Listener: Kontakt wird als "Wiped Kontakt" markiert, Secret weg', async () => {
    // Audit P14: Reste des Kontakts (Name, Profilbild, Adresse, Sicherheitscode) mit entfernen.
    await BG.updateContacts((cs) => cs.map((c) => (c.id === CONTACT.id
      ? { ...c, theirName: 'Bob echt', theirAvatar: 'data:image/jpeg;base64,AAAA', torOnion: 'b'.repeat(56) + '.onion', theirMyId: 'm_' + '1'.repeat(32) } : c)));
    await EncryptedStorage.setItem('safety_code_seen_' + CONTACT.id, '12345 67890');
    await EncryptedStorage.setItem('avatar_hash_' + CONTACT.id, 'abc');
    const rtc = connect(CONTACT.id);
    rtc.onMessage({ type: 'system', subtype: 'device_wiped', ts: Date.now() });
    await tick();
    await flushContactWrites();
    const bob = (await storedContacts()).find((c) => c.id === CONTACT.id);
    expect(bob).toMatchObject({ wiped: true, name: 'Wiped Kontakt' });
    for (const k of ['theirName', 'theirAvatar', 'torOnion', 'theirMyId']) expect(bob[k]).toBeUndefined();
    expect(await EncryptedStorage.getItem('shared_secret_' + CONTACT.id)).toBeNull();
    expect(await EncryptedStorage.getItem('safety_code_seen_' + CONTACT.id)).toBeNull();
    expect(await EncryptedStorage.getItem('avatar_hash_' + CONTACT.id)).toBeNull();
  });

  test('secret_start/secret_end ohne Listener: Zustand wird persistiert, ein laengst abgelaufenes secret_start aber ignoriert', async () => {
    const rtc = connect(CONTACT.id);
    rtc.onMessage({ type: 'system', subtype: 'secret_start', mins: 5, endsAt: Date.now() - 1000, ts: Date.now() });
    await tick();
    expect(await EncryptedStorage.getItem('secret_' + CONTACT.id)).toBeNull();

    const endsAt = Date.now() + 5 * 60 * 1000;
    rtc.onMessage({ type: 'system', subtype: 'secret_start', mins: 5, endsAt, ts: Date.now() });
    await tick();
    expect(JSON.parse(await EncryptedStorage.getItem('secret_' + CONTACT.id))).toEqual({ mins: 5, endsAt });

    rtc.onMessage({ type: 'system', subtype: 'secret_end', ts: Date.now() });
    await tick();
    expect(await EncryptedStorage.getItem('secret_' + CONTACT.id)).toBeNull();
    expect(await EncryptedStorage.getItem('secret_ended_' + CONTACT.id)).toBe('true');
  });

  test('clear_chat/delete_message ohne Listener: Verlauf wird geleert bzw. die eine Nachricht entfernt', async () => {
    await EncryptedStorage.setItem('chat_' + CONTACT.id, JSON.stringify([{ id: 'm1', text: 'a' }, { id: 'm2', text: 'b' }]));
    const rtc = connect(CONTACT.id);
    rtc.onMessage({ type: 'system', subtype: 'delete_message', msgId: 'm1', ts: Date.now() });
    await tick();
    expect(JSON.parse(await EncryptedStorage.getItem('chat_' + CONTACT.id))).toEqual([{ id: 'm2', text: 'b' }]);
    rtc.onMessage({ type: 'system', subtype: 'clear_chat', ts: Date.now() });
    await tick();
    expect(await EncryptedStorage.getItem('chat_' + CONTACT.id)).toBeNull();
  });

  test('offener Chat (Listener gesetzt): Steuersignal geht an den Chat, nicht an den zentralen Handler', async () => {
    const rtc = connect(CONTACT.id);
    const seen = [];
    RTCStore.setMessageListener(CONTACT.id, (m) => seen.push(m));
    rtc.onMessage({ type: 'system', subtype: 'delete_chat', ts: Date.now() });
    await tick();
    await flushContactWrites();
    expect(seen.map((m) => m.subtype)).toEqual(['delete_chat']);
    expect((await storedContacts()).map((c) => c.id)).toEqual([CONTACT.id, OTHER.id]);
  });

  test('normale Nachrichten ohne Listener werden weiterhin gepuffert', () => {
    const rtc = connect(CONTACT.id);
    rtc.onMessage({ type: 'system', subtype: 'profile_name', name: 'Bob' });
    expect(RTCStore.buffer.get(CONTACT.id)).toEqual([{ type: 'system', subtype: 'profile_name', name: 'Bob' }]);
  });
});

describe('Live-Pfad: verspaetet zugestellte Steuersignale (Warteschlange) werden angenommen, Replays weiterhin verworfen', () => {
  function liveRtc(chatId) {
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    rtc.chatId = chatId;
    rtc.sharedSecret = SESSION_SECRET;
    rtc.keyExchangeDone = true;
    const channel = { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null };
    rtc._setupDataChannel(channel);
    const received = [];
    rtc.onMessage = (m) => received.push(m);
    return { rtc, channel, received };
  }
  async function deliver(channel, obj) {
    const data = await encryptMsg(JSON.stringify(obj), SESSION_SECRET);
    await channel.onmessage({ data: JSON.stringify({ type: 'encrypted', data }) });
  }

  test('zwei Tage alter delete_chat (lag in der Warteschlange) wird angenommen', async () => {
    const { rtc, channel, received } = liveRtc('c_live_1');
    await deliver(channel, { type: 'system', subtype: 'delete_chat', ts: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    expect(received.map((m) => m.subtype)).toEqual(['delete_chat']);
    rtc.close();
  });

  test('identischer ts ein zweites Mal (Replay innerhalb der Sitzung) wird verworfen', async () => {
    const { rtc, channel, received } = liveRtc('c_live_2');
    const ts = Date.now() - 60 * 60 * 1000;
    await deliver(channel, { type: 'system', subtype: 'secret_end', ts });
    await deliver(channel, { type: 'system', subtype: 'secret_end', ts });
    await deliver(channel, { type: 'system', subtype: 'secret_start', mins: 5, ts: ts - 1000 });
    expect(received.map((m) => m.subtype)).toEqual(['secret_end']);
    rtc.close();
  });

  test('isPlausibleControlTimestamp: bis 30 Tage alt ok, aelter / weit in der Zukunft / keine Zahl nicht', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(isPlausibleControlTimestamp(Date.now())).toBe(true);
    expect(isPlausibleControlTimestamp(Date.now() - 29 * day)).toBe(true);
    expect(isPlausibleControlTimestamp(Date.now() - 31 * day)).toBe(false);
    expect(isPlausibleControlTimestamp(Date.now() + 10 * 60 * 1000)).toBe(false);
    expect(isPlausibleControlTimestamp(Infinity)).toBe(false);
    expect(isPlausibleControlTimestamp('123')).toBe(false);
  });
});

describe('statisch: kein Server im Datenpfad', () => {
  test('WebRTC (nativ + web): nur STUN, kein TURN-Server, keine Zugangsdaten-Abfrage, keine Relay-Erzwingung', () => {
    for (const rel of ['WebRTCManager.js', 'web/src/lib/WebRTCManager.ts']) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/urls:\s*[`'"]turns?:/);
      expect(src).not.toMatch(/getTurnCredentials\(/);
      expect(src).toMatch(/const FORCE_RELAY_ONLY = false;/);
      expect(src).toMatch(/iceTransportPolicy: 'all'/);
      expect(src).not.toMatch(/iceTransportPolicy: 'relay'/);
    }
  });

  test('App.tsx (nativ): kein einziger Server-Aufruf mehr (auch nicht fuer Kopplung/Telefonnummer) - Steuersignale nur ueber P2P/Tor bzw. die Warteschlange', () => {
    const src = readSrc('App.tsx');
    expect(src).not.toMatch(/RELAY_URL|fetchWithTimeout|RelayClient'|\/packet`|\/phone\/register|phone_connect_offer/);
    // Loeschen/Secret Chat nutzen die Warteschlange
    expect(src).toMatch(/requestContactDeletion\(chatId\)/);
    // Seit der Zustell-Garantie (2026-10) write-ahead ueber sendViaOutbox().
    expect(src).toMatch(/sendViaOutbox\(endChatId, 'system', secretEndSignal, /);
    expect(src).toMatch(/sendViaOutbox\(chat\.id, 'system', secretStartSignal, /);
    expect(src).toMatch(/sendViaOutbox\(chatId, 'system', \{ type: 'system', subtype: 'clear_chat', ts \}/);
  });

  test('web/src/App.tsx: Loeschen ohne Relay (nur Warteschlange/P2P), Steuersignale zentral ueber RTCStore', () => {
    const src = readSrc('web/src/App.tsx');
    const del = src.slice(src.indexOf('const deleteContact = async'), src.indexOf('const markContactWiped'));
    expect(del).toMatch(/queueOffline\(chatId, 'system', \{ type: 'system', subtype: 'delete_chat', ts \}/);
    expect(del).not.toMatch(/RELAY_URL|fetch\(/);
    expect(src).toMatch(/RTCStore\.controlSignalHandler = /);
    expect(readSrc('web/src/lib/RTCStore.ts')).toMatch(/this\.controlSignalHandler\(chatId, msg\)/);
    expect(readSrc('web/src/lib/Queue.ts')).toMatch(/deleteNoticeDeliveredHandler\?\.\(contactId\)/);
  });
});
