// Startseite (Nutzerwunsch 2026-10-19): Chats und Gruppen in einer Liste,
// Filter Alle/Chats/Gruppen, Angeheftetes oben, sonst nach letzter Aktivitaet;
// oben links Profilbild + Malachi-Zeichen + "Malachi" (wie bei Signal).
const React = require('react');
const renderer = require('react-test-renderer');
const { Text } = require('react-native');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const { HomeScreen } = require('../../App');
const { SafeAreaProvider } = require('react-native-safe-area-context');

let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });
beforeEach(async () => { await EncryptedStorage.clear(); });

const now = Date.now();
const contacts = [
  { id: 'c1', name: 'Anna', last: 'alt', lastTs: now - 5 * 3600e3, unread: 0 },
  { id: 'c2', name: 'Bert', last: 'neu', lastTs: now - 60e3, unread: 2 },
  { id: 'c3', name: 'Clara', last: 'angeheftet', lastTs: now - 48 * 3600e3, pinned: true, unread: 0 },
  { id: 'c4', name: 'Dora', last: 'ohne Zeitstempel', time: '09:00', unread: 0 },
];
const groups = [
  { v: 1, groupId: 'g_' + 'a'.repeat(24), name: 'Familie', last: 'Bert: Hallo', lastTime: now - 30 * 60e3, unread: 3, members: [] },
  { v: 1, groupId: 'g_' + 'b'.repeat(24), name: 'Projekt', last: '', lastTime: now - 10 * 3600e3, unread: 0, members: [] },
];

async function render(props = {}) {
  let tree;
  const calls = { pinC: [], pinG: [], openG: [], createG: 0, connect: 0 };
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
      React.createElement(HomeScreen, {
        contacts, groups, username: 'Dave Meyer', onChat() {}, onSettings() {}, onGroups() {}, onDelete() {}, onClearChat() {},
        onConnect: () => { calls.connect++; }, onCreateGroup: () => { calls.createG++; }, onOpenGroup: (g) => calls.openG.push(g.groupId),
        onPinContact: (id, p) => calls.pinC.push([id, p]), onPinGroup: (id, p) => calls.pinG.push([id, p]), onGroupInfo() {}, ...props,
      })));
  });
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { tree, calls };
}
const names = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(''))
  .filter((s) => ['Anna', 'Bert', 'Clara', 'Dora', 'Familie', 'Projekt'].includes(s));
async function press(tree, label) {
  const node = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function'
    && (n.props.accessibilityLabel === label || n.findAllByType(Text).some((t) => [].concat(t.props.children).join('').startsWith(label)))).pop(); // innerster Treffer (nicht der Menue-Hintergrund)
  if (!node) throw new Error('nicht gefunden: ' + label);
  await renderer.act(async () => { node.props.onPress(); await new Promise((r) => setTimeout(r, 10)); });
}

test('Kopf: "Malachi" statt "Nachrichten", Profilbild links (Initialen), Suche rechts', async () => {
  const { tree } = await render();
  const all = tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(''));
  expect(all).toContain('Malachi');
  expect(all).not.toContain('Nachrichten');
  expect(all).toContain('DM');
  const labels = tree.root.findAll((n) => n.props && typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel);
  expect(labels).toEqual(expect.arrayContaining(['Einstellungen und Profil', 'Suchen']));
  await renderer.act(async () => tree.unmount());
});

test('Alle: Angeheftetes zuerst, dann nach letzter Aktivitaet - Chats und Gruppen gemischt', async () => {
  const { tree } = await render();
  expect(names(tree)).toEqual(['Clara', 'Bert', 'Familie', 'Anna', 'Projekt', 'Dora']);
  await renderer.act(async () => tree.unmount());
});

test('Filter Chats/Gruppen; Auswahl bleibt gespeichert; im Gruppen-Filter oben "Neue Gruppe", "+" fuehrt immer zur Kopplung', async () => {
  const { tree, calls } = await render();
  await press(tree, 'Gruppen');
  expect(names(tree)).toEqual(['Familie', 'Projekt']);
  expect(await EncryptedStorage.getItem('home_filter')).toBe('groups');
  await press(tree, 'Neue Gruppe');
  expect(calls.createG).toBe(1);
  await press(tree, 'Kontakt verbinden');
  expect(calls.connect).toBe(1);
  await press(tree, 'Chats');
  expect(names(tree)).toEqual(['Clara', 'Bert', 'Anna', 'Dora']);
  await press(tree, 'Kontakt verbinden');
  expect(calls.connect).toBe(2);
  await renderer.act(async () => tree.unmount());
  const again = await render();
  expect(names(again.tree)).toEqual(['Clara', 'Bert', 'Anna', 'Dora']);   // gespeicherter Filter
  await renderer.act(async () => again.tree.unmount());
});

test('Anheften/Loesen ueber das Kontextmenue - fuer Chats und Gruppen', async () => {
  const { tree, calls } = await render();
  const rowOf = (name) => tree.root.findAll((n) => n.props && typeof n.props.onLongPress === 'function'
    && n.findAllByType(Text).some((t) => [].concat(t.props.children).join('') === name))[0];
  await renderer.act(async () => { rowOf('Bert').props.onLongPress({ nativeEvent: { pageX: 10, pageY: 10 } }); });
  await press(tree, 'Anheften');
  expect(calls.pinC).toEqual([['c2', true]]);
  await renderer.act(async () => { rowOf('Clara').props.onLongPress({ nativeEvent: { pageX: 10, pageY: 10 } }); });
  await press(tree, 'Lösen');
  expect(calls.pinC[1]).toEqual(['c3', false]);
  await renderer.act(async () => { rowOf('Familie').props.onLongPress({ nativeEvent: { pageX: 10, pageY: 10 } }); });
  await press(tree, 'Anheften');
  expect(calls.pinG).toEqual([['g_' + 'a'.repeat(24), true]]);
  await renderer.act(async () => tree.unmount());
});
