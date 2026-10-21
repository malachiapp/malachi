// Live-Test 2026-10-18: "Kev hat bei mir kein Profilbild". Das Bild kam bei
// geschlossenem Chat an, lag nur im RAM-Puffer und war nach einem App-Neustart
// weg - die Gegenseite hielt es fuer zugestellt (avatar_hash_) und schickte es
// nie wieder. Jetzt: sofort beim Kontakt speichern; fehlt es trotzdem, fordert
// die Empfangsseite es nach dem Handshake an, und die Gegenseite schickt es neu.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
require('../../BackgroundSync');   // setzt avatarReceivedHandler/avatarMissingCheck

const SECRET = crypto.randomBytes(32).toString('base64');
const CONTACT = { id: 'c_av', name: 'Kev', role: 'initiator' };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function conn() {
  return {
    transport: 'direct', keyExchangeDone: true, sharedSecret: SECRET, _closed: false,
    dataChannel: { readyState: 'open', send: jest.fn() }, pc: { iceConnectionState: 'connected' },
    pendingMsgs: [], close: jest.fn(), sendMessage: jest.fn(() => 'sent'),
  };
}
const contacts = async () => JSON.parse(await EncryptedStorage.getItem('contacts'));

beforeEach(async () => {
  jest.useRealTimers();
  RTCStore.resetAll();
  await EncryptedStorage.clear();
  await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
  RTCStore.sharedSecrets.set(CONTACT.id, SECRET);
});

test('Profilbild bei geschlossenem Chat: sofort beim Kontakt gespeichert (ueberlebt einen Neustart)', async () => {
  RTCStore.pendingAvatars = new Map([[CONTACT.id, { imageId: 'i1', base64: 'QUJD', mimeType: 'image/jpeg' }]]);
  RTCStore.handleProfileAvatar(CONTACT.id);
  await tick(30);
  expect((await contacts())[0].theirAvatar).toBe('data:image/jpeg;base64,QUJD');
});

test('Gegenseite hat ein Profilbild, wir keins: nach dem Handshake einmal anfordern', async () => {
  jest.useFakeTimers();
  const c = conn();
  RTCStore.setConnection(CONTACT.id, c);
  c.onMessage({ type: 'system', subtype: 'handshake', name: 'Kev', hasAvatar: true, ready: true });
  c.onMessage({ type: 'system', subtype: 'handshake', name: 'Kev', hasAvatar: true, ready: true });
  jest.advanceTimersByTime(4100);
  jest.useRealTimers();
  await tick(30);
  const reqs = c.sendMessage.mock.calls.map((x) => JSON.parse(x[0])).filter((m) => m.subtype === 'profile_avatar_request');
  expect(reqs).toHaveLength(1);
});

test('haben wir das Bild schon, wird nichts angefordert', async () => {
  await EncryptedStorage.setItem('contacts', JSON.stringify([{ ...CONTACT, theirAvatar: 'data:image/jpeg;base64,QUJD' }]));
  jest.useFakeTimers();
  const c = conn();
  RTCStore.setConnection(CONTACT.id, c);
  c.onMessage({ type: 'system', subtype: 'handshake', name: 'Kev', hasAvatar: true, ready: true });
  jest.advanceTimersByTime(4100);
  jest.useRealTimers();
  await tick(30);
  expect(c.sendMessage.mock.calls.some((x) => JSON.parse(x[0]).subtype === 'profile_avatar_request')).toBe(false);
});

test('Anforderung erhalten: eigenes Profilbild wird erneut gesendet (hoechstens einmal pro Minute)', async () => {
  await EncryptedStorage.setItem('avatar', 'data:image/jpeg;base64,' + Buffer.from('ein kleines bild').toString('base64'));
  await EncryptedStorage.setItem('username', 'Dave');
  const c = conn();
  RTCStore.setConnection(CONTACT.id, c);
  c.onMessage({ type: 'system', subtype: 'profile_avatar_request' });
  await tick(100);
  const chunks = c.dataChannel.send.mock.calls.length;
  expect(chunks).toBeGreaterThan(0);
  const hs = c.sendMessage.mock.calls.map((x) => JSON.parse(x[0])).find((m) => m.subtype === 'handshake');
  expect(hs).toMatchObject({ hasAvatar: true, name: 'Dave' });
  c.onMessage({ type: 'system', subtype: 'profile_avatar_request' });
  await tick(100);
  expect(c.dataChannel.send.mock.calls.length).toBe(chunks);
});

test('statisch: Kontaktaenderungen werden zusammengefuehrt, nicht durch eine veraltete Kopie ersetzt (Profilbild ging verloren)', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/const patch = Object\.fromEntries\(Object\.entries\(updated \|\| \{\}\)\.filter\(\(\[, v\]\) => v !== undefined\)\);/);
  expect(app).toMatch(/const reportContact = \(updatedList, patch\) => \{/);
  // Kein Melden mehr mit der veralteten chat-Kopie aus der Listener-Closure.
  expect(app).not.toMatch(/onRename\?\.\(\{ \.\.\.chat, (name|theirAvatar)/);
});

test('statisch: Chat-Kopfzeile zeigt nur den Zustand DIESES Kontakts (nicht GLOBAL_RTC/alte Verbindung) und "wird wiederhergestellt"', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/const isConnected = connected;/);
  expect(app).not.toMatch(/const isConnected = connected \|\| .*GLOBAL_RTC/);
  expect(app).toMatch(/connStatus === 'reconnecting' \? t\('app\.verbindungWirdWiederhergestellt'\)/);
  const { t } = require('../../i18n');
  expect(t('app.verbindungWirdWiederhergestellt')).toBe('◌ Verbindung wird wiederhergestellt …');
  expect(t('app.verbundenUeberTor')).toBe('● Verbunden über Tor');
});
