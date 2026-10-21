// SECURITY_SECRETS_LIFECYCLE.md, Fund S-1 (hoechste aber eine Prioritaet nach
// S-4) und Fund S-3: der 5-Fehlversuche-Wipe (nativ) bzw. der Pepper-Wipe
// (web) sowie das lokale Loeschen eines einzelnen Kontakts raeumten den
// In-Memory-Zustand des RTCStore-Singletons bisher NICHT auf - weder offene
// WebRTCManager-Verbindungen (die nach einem "vollstaendigen Wipe" munter
// weiter Cover-Traffic senden und neue Nachrichten entschluesseln/puffern
// koennten) noch gecachte Shared Secrets noch bereits gepufferte
// Klartext-Nachrichten/Bild-/Audio-Chunks.
//
// Fix: RTCStore.resetAll() (kompletter Wipe, alle Kontakte) und
// RTCStore.clearContact(chatId) (einzelner Kontakt, z.B. beim Chat-Loeschen)
// auf beiden Plattformen. Dieser Test beweist beides rein ueber den echten
// Produktionscode von RTCStore.js/.ts (keine App.tsx-Rendering noetig - die
// eigentliche Verdrahtung in den Wipe-/Delete-Handlern selbst wird per
// Quelltext-Pruefung am Ende mit abgedeckt, analog zu
// stateMachine.pollCycleGuard.test.js).

const fs = require('fs');
const path = require('path');

function readSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

describe('Fix S-1/S-3 (nativ): RTCStore.js resetAll()/clearContact() raeumen den kompletten In-Memory-Zustand auf', () => {
  let RTCStore;
  beforeEach(() => {
    jest.resetModules();
    RTCStore = require('../../RTCStore').default;
  });

  function populate(chatId, suffix) {
    const closeSpy = jest.fn();
    const fakeRtc = { chatId, close: closeSpy, onConnected: null, onSharedSecretSet: null };
    RTCStore.setConnection(chatId, fakeRtc);
    RTCStore.sharedSecrets.set(chatId, 'secret_' + suffix);
    RTCStore.buffer.set(chatId, [{ type: 'text', text: 'geheime Nachricht ' + suffix }]);
    if (!RTCStore.audioBuffer) RTCStore.audioBuffer = new Map();
    RTCStore.audioBuffer.set(chatId + '_audio' + suffix, { chunks: ['a'], total: 1, received: 1 });
    if (!RTCStore.imgBuffer) RTCStore.imgBuffer = new Map();
    RTCStore.imgBuffer.set(chatId + '_img' + suffix, { chunks: ['b'], total: 1, received: 1 });
    RTCStore.imgBuffer.set('avatar_' + chatId + '_img' + suffix, { chunks: ['c'], total: 1, received: 1, isAvatar: true });
    if (!RTCStore.pendingAvatars) RTCStore.pendingAvatars = new Map();
    RTCStore.pendingAvatars.set(chatId, { imageId: 'i' + suffix, base64: 'xx', mimeType: 'image/jpeg' });
    if (!RTCStore.pendingAvatarExpected) RTCStore.pendingAvatarExpected = new Set();
    RTCStore.pendingAvatarExpected.add(chatId);
    return { fakeRtc, closeSpy };
  }

  test('resetAll(): schliesst jede offene Verbindung und leert wirklich jede Map (connections/listeners/buffer/sharedSecrets/audioBuffer/imgBuffer/pendingAvatars/pendingAvatarExpected)', () => {
    const { closeSpy: closeA } = populate('contactA', 'A');
    const { closeSpy: closeB } = populate('contactB', 'B');
    RTCStore.setMessageListener('contactA', () => {});

    RTCStore.resetAll();

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(RTCStore.connections.size).toBe(0);
    expect(RTCStore.listeners.size).toBe(0);
    expect(RTCStore.buffer.size).toBe(0);
    expect(RTCStore.sharedSecrets.size).toBe(0);
    expect(RTCStore.audioBuffer.size).toBe(0);
    expect(RTCStore.imgBuffer.size).toBe(0);
    expect(RTCStore.pendingAvatars.size).toBe(0);
    expect(RTCStore.pendingAvatarExpected.size).toBe(0);
  });

  test('resetAll(): ein werfendes close() auf einer Verbindung darf das Aufraeumen der anderen nicht verhindern', () => {
    const throwingRtc = { chatId: 'contactThrows', close: () => { throw new Error('kaputte Verbindung'); } };
    RTCStore.setConnection('contactThrows', throwingRtc);
    const { closeSpy } = populate('contactOk', 'OK');

    expect(() => RTCStore.resetAll()).not.toThrow();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(RTCStore.connections.size).toBe(0);
    expect(RTCStore.sharedSecrets.size).toBe(0);
  });

  test('resetAll() ohne jemals befuellte audioBuffer/imgBuffer/pendingAvatars (nur connections/sharedSecrets/buffer) wirft nicht (optional chaining)', () => {
    RTCStore.sharedSecrets.set('bare', 's');
    expect(() => RTCStore.resetAll()).not.toThrow();
    expect(RTCStore.sharedSecrets.size).toBe(0);
  });

  test('clearContact(chatId): loescht NUR den einen Kontakt (Verbindung geschlossen, Secret/Buffer/Audio-/Bild-Chunks/Avatar weg) und laesst andere Kontakte vollstaendig unangetastet', () => {
    const { closeSpy: closeA } = populate('contactA', 'A');
    const { closeSpy: closeB } = populate('contactB', 'B');

    RTCStore.clearContact('contactA');

    // contactA vollstaendig weg
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(RTCStore.connections.has('contactA')).toBe(false);
    expect(RTCStore.sharedSecrets.has('contactA')).toBe(false);
    expect(RTCStore.buffer.has('contactA')).toBe(false);
    expect(RTCStore.pendingAvatars.has('contactA')).toBe(false);
    expect(RTCStore.pendingAvatarExpected.has('contactA')).toBe(false);
    expect([...RTCStore.audioBuffer.keys()].some(k => k.startsWith('contactA_'))).toBe(false);
    expect([...RTCStore.imgBuffer.keys()].some(k => k.startsWith('contactA_') || k.startsWith('avatar_contactA_'))).toBe(false);

    // contactB komplett unberuehrt
    expect(closeB).not.toHaveBeenCalled();
    expect(RTCStore.connections.has('contactB')).toBe(true);
    expect(RTCStore.sharedSecrets.get('contactB')).toBe('secret_B');
    expect(RTCStore.buffer.get('contactB')).toEqual([{ type: 'text', text: 'geheime Nachricht B' }]);
    expect(RTCStore.pendingAvatars.has('contactB')).toBe(true);
    expect(RTCStore.pendingAvatarExpected.has('contactB')).toBe(true);
    expect([...RTCStore.audioBuffer.keys()].some(k => k.startsWith('contactB_'))).toBe(true);
    expect([...RTCStore.imgBuffer.keys()].some(k => k.startsWith('contactB_'))).toBe(true);
    expect([...RTCStore.imgBuffer.keys()].some(k => k.startsWith('avatar_contactB_'))).toBe(true);
  });

  test('clearContact() fuer einen unbekannten Kontakt (keine Verbindung/keine Daten) wirft nicht', () => {
    expect(() => RTCStore.clearContact('nieExistiert')).not.toThrow();
  });
});

describe('Fix S-1/S-3 (web): RTCStore.ts resetAll()/clearContact() - vereinfachtes Gegenstueck (nur connections/listeners/buffer/sharedSecrets)', () => {
  let RTCStore;
  beforeEach(() => {
    jest.resetModules();
    RTCStore = require('../../web/src/lib/RTCStore.ts').default;
  });

  function populate(chatId, suffix) {
    const closeSpy = jest.fn();
    const fakeRtc = { chatId, close: closeSpy };
    RTCStore.setConnection(chatId, fakeRtc);
    RTCStore.sharedSecrets.set(chatId, 'secret_' + suffix);
    RTCStore.buffer.set(chatId, [{ type: 'text', text: 'geheime Nachricht ' + suffix }]);
    return { fakeRtc, closeSpy };
  }

  test('resetAll(): schliesst jede offene Verbindung und leert connections/listeners/buffer/sharedSecrets', () => {
    const { closeSpy: closeA } = populate('contactA', 'A');
    const { closeSpy: closeB } = populate('contactB', 'B');
    RTCStore.setMessageListener('contactA', () => {});

    RTCStore.resetAll();

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(RTCStore.connections.size).toBe(0);
    expect(RTCStore.listeners.size).toBe(0);
    expect(RTCStore.buffer.size).toBe(0);
    expect(RTCStore.sharedSecrets.size).toBe(0);
  });

  test('clearContact(chatId): loescht nur den einen Kontakt, laesst andere unangetastet', () => {
    const { closeSpy: closeA } = populate('contactA', 'A');
    const { closeSpy: closeB } = populate('contactB', 'B');

    RTCStore.clearContact('contactA');

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(RTCStore.connections.has('contactA')).toBe(false);
    expect(RTCStore.sharedSecrets.has('contactA')).toBe(false);
    expect(RTCStore.buffer.has('contactA')).toBe(false);

    expect(closeB).not.toHaveBeenCalled();
    expect(RTCStore.connections.has('contactB')).toBe(true);
    expect(RTCStore.sharedSecrets.get('contactB')).toBe('secret_B');
    expect(RTCStore.buffer.get('contactB')).toEqual([{ type: 'text', text: 'geheime Nachricht B' }]);
  });
});

describe('Fix S-1/S-3: Verdrahtung in App.tsx / web/src/App.tsx (Quelltext-Pruefung, analog stateMachine.pollCycleGuard.test.js)', () => {
  test('App.tsx (nativ): der 5-Fehlversuche-Wipe-Block ruft RTCStore.resetAll() NACH dem device_wiped-Versand aber VOR dem AsyncStorage/EncryptedStorage-Clear auf', () => {
    const src = readSrc('App.tsx');
    const notifyIdx = src.indexOf("subtype: 'device_wiped'");
    const resetIdx = src.indexOf('RTCStore.resetAll();');
    const asyncClearIdx = src.indexOf("await AsyncStorage.multiRemove(asyncKeys);");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(-1);
    expect(asyncClearIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(notifyIdx);
    expect(asyncClearIdx).toBeGreaterThan(resetIdx);
  });

  // Seit der Nur-P2P-Umstellung (2026-09-29) liegt die eigentliche Loesch-
  // Logik in BackgroundSync.js (removeContactLocally, auch vom Headless-Task
  // und nach zugestelltem Loesch-Hinweis genutzt) - App.tsx ruft sie nur auf.
  test('nativ: das lokale Entfernen eines Kontakts (removeContactLocally) ruft RTCStore.clearContact(contactId) auf, statt Connections/Secrets manuell Feld fuer Feld zu loeschen', () => {
    const src = readSrc('App.tsx');
    expect(src).toMatch(/requestContactDeletion\(chatId\)\.catch\(\(\) => removeContactLocally\(chatId\)\)/);
    const bg = readSrc('BackgroundSync.js');
    const start = bg.indexOf('export function removeContactLocally(contactId) {');
    expect(start).toBeGreaterThan(-1);
    const block = bg.slice(start, bg.indexOf('\n}\n', start));
    expect(block).toMatch(/RTCStore\.clearContact\(contactId\)/);
    expect(block).toMatch(/wipeQueueForContact\(contactId\)/);
    expect(block).toMatch(/'shared_secret_', 'shared_secret_prev_'/);
  });

  test('nativ: die device_wiped-Tombstone-Behandlung (Gegenueber hat sein Geraet zurueckgesetzt) nutzt ebenfalls RTCStore.clearContact(contact.id) - jetzt ueber die gemeinsame wipeContactLocally()-Funktion (Rot-Team-Review Fund 2)', () => {
    // Seit Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3a) stehen checkIncoming's
    // Rumpf (runIncomingCycle) und wipeContactLocally() in BackgroundSync.js,
    // gemeinsam genutzt von App.tsx und dem Headless-Task.
    const src = readSrc('BackgroundSync.js');
    // Serverlos (Okt. 2026): der Relay-Empfangspfad in runIncomingCycle ist
    // entfallen - device_wiped kommt nur noch per P2P/Tor und wird bei
    // geschlossenem Chat zentral in applyControlSignal() verarbeitet, das die
    // gemeinsame Helper-Funktion aufruft statt die Tombstone-Logik zu duplizieren.
    const tombstoneIdx = src.indexOf("case 'device_wiped':");
    expect(tombstoneIdx).toBeGreaterThan(-1);
    const nextBlock = src.slice(tombstoneIdx, tombstoneIdx + 200);
    expect(nextBlock).toMatch(/wipeContactLocally\(contactId, setContacts\)/);
    // wipeContactLocally() selbst enthaelt weiterhin RTCStore.clearContact().
    const helperIdx = src.indexOf('export function wipeContactLocally(contactId, onContactsChanged = noop) {');
    expect(helperIdx).toBeGreaterThan(-1);
    const helperBlock = src.slice(helperIdx, helperIdx + 1500);
    expect(helperBlock).toMatch(/RTCStore\.clearContact\(contactId\)/);
    // ChatScreen's onWipe (App.tsx) laeuft ueber genau diese Funktion.
    expect(readSrc('App.tsx')).toMatch(/const wipeContactLocally = \(contactId\) => \{\s*sharedWipeContactLocally\(contactId, setContacts\);/);
  });

  test("web/src/App.tsx: der 'wiped'-Zweig von onUnlock ruft RTCStore.resetAll() auf", () => {
    const src = readSrc('web/src/App.tsx');
    const wipedIdx = src.indexOf("case 'wiped':");
    expect(wipedIdx).toBeGreaterThan(-1);
    const block = src.slice(wipedIdx, wipedIdx + 500);
    expect(block).toMatch(/RTCStore\.resetAll\(\);/);
  });

  test('web/src/App.tsx: die device_wiped-Tombstone-Behandlung nutzt RTCStore.clearContact(contact.id)', () => {
    const src = readSrc('web/src/App.tsx');
    const tombstoneIdx = src.indexOf("subtype === 'device_wiped'");
    expect(tombstoneIdx).toBeGreaterThan(-1);
    const nextBlock = src.slice(tombstoneIdx, tombstoneIdx + 1100);
    expect(nextBlock).toMatch(/RTCStore\.clearContact\(contact\.id\)/);
  });
});
