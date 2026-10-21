// Darstellung der Gruppen-Bildschirme (GroupScreens.tsx, GroupChatScreen.tsx):
// Liste mit letzter Nachricht + Ungelesen-Zahl, Gruppenchat mit Absendernamen,
// Haekchen (✓ / ✓✓ / x/n) und dem deutlichen Hinweis auf nicht direkt
// gekoppelte Mitglieder, Gruppeninfo mit Admin-Kennzeichen.
const React = require('react');
const renderer = require('react-test-renderer');
const EncryptedStorage = require('react-native-encrypted-storage').default;
require('./helpers/nativeBridgeMock').installKyberModuleMock();
require('../../BackgroundSync'); // verdrahtet GroupMessaging (wie in der App)
const GM = require('../../GroupMessaging');
const { GroupsScreen, GroupDetailScreen, GroupCreateScreen } = require('../../GroupScreens');
const GroupChatScreen = require('../../GroupChatScreen').default;

const SELF = 'm_' + '0'.repeat(32);
const BOB = 'm_' + '1'.repeat(32);
const CAROL = 'm_' + '2'.repeat(32);
const GID = 'g_' + 'f'.repeat(24);
const contacts = [
  { id: 'c_bob', name: 'Bob', groupMemberId: BOB, initials: 'B', color: '#123', tc: '#fff' },
  { id: 'c_dave', name: 'Dave' }, // noch ohne Mitglieds-ID
];
const group = {
  v: 1, groupId: GID, name: 'Projekt Falke', description: 'Beschreibung', selfMid: SELF, amAdmin: true,
  members: [{ mid: SELF, name: 'Ich' }, { mid: BOB, name: 'Bob' }, { mid: CAROL, name: 'Carol' }],
  admins: [SELF], rev: 3, unread: 4, last: 'Bob: Hallo', lastTime: Date.now(), removed: false,
};
// Nur die sichtbaren Texte (FlatList-Props enthalten Zyklen).
function textOf(tree) {
  const out = [];
  const walk = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props && typeof n.props.placeholder === 'string') out.push(n.props.placeholder);
    (n.children || []).forEach(walk);
  };
  walk(tree.toJSON());
  return out.map(s => '"' + s + '"').join(' ');
}

let logSpy;
beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { logSpy.mockRestore(); console.warn.mockRestore?.(); });
beforeEach(async () => {
  await EncryptedStorage.clear();
  await EncryptedStorage.setItem('group_self_id', SELF);
  await EncryptedStorage.setItem('groups', JSON.stringify([group]));
  await EncryptedStorage.setItem('gchat_' + GID, JSON.stringify([
    { id: 'sys_1', from: 'sys', sys: true, text: 'Du hast die Gruppe erstellt', time: Date.now() },
    { id: 'm1', from: BOB, fromContactId: 'c_bob', mine: false, text: 'Hallo von Bob', time: Date.now() },
    { id: 'm2', from: SELF, mine: true, text: 'Alle da?', time: Date.now(), recipients: { [BOB]: 'delivered' }, status: 'delivered' },
    { id: 'm3', from: SELF, mine: true, text: 'Zweite', time: Date.now(), recipients: { [BOB]: 'queued', [CAROL]: 'delivered' }, status: 'queued' },
  ]));
});

async function render(el) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(el); });
  await renderer.act(async () => { await new Promise(r => setTimeout(r, 20)); });
  return tree;
}

test('Gruppenliste: Name, letzte Nachricht, Ungelesen-Zahl', async () => {
  const tree = await render(React.createElement(GroupsScreen, { groups: [group], onBack() {}, onCreate() {}, onOpenGroup() {} }));
  const t = textOf(tree);
  expect(t).toContain('Projekt Falke');
  expect(t).toContain('Bob: Hallo');
  expect(t).toContain('"4"');
  await renderer.act(async () => tree.unmount());
});

test('Gruppenchat: Absendername, ✓✓/✓ mit x/n, Hinweis auf nicht gekoppelte Mitglieder', async () => {
  const tree = await render(React.createElement(GroupChatScreen, { group, contacts, onBack() {}, onOpenDetail() {} }));
  const t = textOf(tree);
  expect(t).toContain('Hallo von Bob');
  expect(t).toContain('"Bob"');
  expect(t).toContain('✓✓');
  expect(t).toContain('1/2');
  expect(t).toContain('Nicht direkt verbunden: ');
  expect(t).toContain('Carol');
  expect(t).toContain('bitte zuerst koppeln');
  expect(t).toContain('Du hast die Gruppe erstellt');
  // Oeffnen setzt den Ungelesen-Zaehler zurueck.
  await renderer.act(async () => { await new Promise(r => setTimeout(r, 30)); });
  const saved = JSON.parse(await EncryptedStorage.getItem('groups'));
  expect(saved[0].unread).toBe(0);
  expect(GM.isGroupChatOpen(GID)).toBe(true);
  await renderer.act(async () => tree.unmount());
  expect(GM.isGroupChatOpen(GID)).toBe(false);
});

test('Gruppeninfo: Admin-Kennzeichen, nicht gekoppeltes Mitglied markiert, Austreten statt "fuer alle loeschen"', async () => {
  const tree = await render(React.createElement(GroupDetailScreen, { group, contacts, onBack() {}, onLeft() {} }));
  const t = textOf(tree);
  expect(t).toContain('Admin');
  expect(t).toContain('Nicht direkt verbunden – bitte zuerst koppeln');
  expect(t).toContain('Gruppe verlassen');
  expect(t).not.toContain('für alle löschen"');
  await renderer.act(async () => tree.unmount());
});

test('Neue Gruppe: Kontakt ohne Mitglieds-ID ist gesperrt und erklaert', async () => {
  const tree = await render(React.createElement(GroupCreateScreen, { contacts, onBack() {}, onCreate: async () => ({}) }));
  const t = textOf(tree);
  expect(t).toContain('Noch keine Gruppen-ID – einmal verbinden');
  expect(t).toContain('inkl. dir');
  await renderer.act(async () => tree.unmount());
});

test('Gruppenchat: Bild und Sprachnachricht werden angezeigt; Eingabe hat Bild- und Mikrofon-Knopf; Farben aus dem Design', async () => {
  const PIX = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  await EncryptedStorage.setItem('gchat_' + GID, JSON.stringify([
    { id: 'i1', from: BOB, fromContactId: 'c_bob', mine: false, type: 'image', mimeType: 'image/jpeg', base64: PIX, time: Date.now() },
    { id: 'a1', from: BOB, fromContactId: 'c_bob', mine: false, type: 'audio', base64: PIX, durationMs: 4200, time: Date.now() },
    { id: 'a2', from: SELF, mine: true, type: 'audio', base64: PIX, durationMs: 61000, time: Date.now(), recipients: { [BOB]: 'delivered' }, status: 'delivered' },
  ]));
  const palette = { bg: '#F6F2EA', surface: '#FFFDF8', surfaceAlt: '#EFE9DE', border: '#E2D9CA', text: '#1F1A14', textMuted: '#675E52',
    bubbleMine: '#0E6B6B', bubbleMineText: '#FFFFFF', bubbleMineMeta: '#D0E6E6', bubbleTheirs: '#FFFDF8', bubbleTheirsBorder: '#E2D9CA',
    bubbleTheirsText: '#1F1A14', bubbleTheirsMeta: '#675E52', accent: '#0E6B6B', onAccent: '#FFFFFF', accentFg: '#0E6B6B' };
  const tree = await render(React.createElement(GroupChatScreen, { group, contacts, palette, onBack() {}, onOpenDetail() {} }));
  const labels = tree.root.findAll((n) => n.props && typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel);
  expect(labels).toContain('Bild vergrößern');
  expect(labels).toContain('Sprachnachricht abspielen');
  expect(labels).toContain('Bild senden');
  expect(labels).toContain('Sprachnachricht aufnehmen');
  const t = textOf(tree);
  expect(t).toContain('0:04');
  expect(t).toContain('1:01');
  // Absendername auf heller Blase lesbar (nicht mehr feste Pastellfarbe)
  const { contrastRatio } = require('../../Themes');
  const nameNode = tree.root.findAll((n) => n.type === 'Text' && [].concat(n.props.children).join('') === 'Bob')[0]
    || tree.root.findAll((n) => n.props && n.props.children === 'Bob')[0];
  const color = [].concat(nameNode.props.style).find((s) => s && s.color).color;
  expect(contrastRatio(color, '#FFFDF8')).toBeGreaterThanOrEqual(4.5);
  await renderer.act(async () => tree.unmount());
});
