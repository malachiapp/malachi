// Gruppenanrufe in der Oberflaeche (GroupCallScreen.tsx, GroupChatScreen.tsx,
// Verdrahtung in App.tsx): Knopf "Gruppenanruf" im Gruppenchat (ohne
// Vollversion nur ein Hinweis), Anrufbildschirm mit Kacheln und Zustaenden,
// Navigation (auch ueber der Sperre), Farben nur aus dem Design.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const React = require('react');
const renderer = require('react-test-renderer');
const { NativeModules, Alert } = require('react-native');
require('./helpers/nativeBridgeMock').installKyberModuleMock();
// Vor dem Laden des Managers (haelt die nativen Module beim Laden fest).
NativeModules.MalachiCallAudio = { addListener() {}, removeListeners() {}, setSpeaker: jest.fn(), setMuted: jest.fn() };
const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const { encryptMsg, decryptMsg } = require('../../MessageCrypto');
const GCM = require('../../GroupCallManager');
const GroupCallScreenMod = require('../../GroupCallScreen');
const GroupCallScreen = GroupCallScreenMod.default;
const { participantLabel, useGroupCallRouting } = GroupCallScreenMod;
const GroupChatScreen = require('../../GroupChatScreen').default;
const T = require('../../Themes');

const SELF = 'm_' + '0'.repeat(32);
const BOB = 'm_' + '1'.repeat(32);
const CAROL = 'm_' + '2'.repeat(32);
const GID = 'g_' + 'f'.repeat(24);
const SECRET = crypto.randomBytes(32).toString('base64');
const contacts = [{ id: 'c_bob', name: 'Bob', groupMemberId: BOB }];
const group = {
  v: 1, groupId: GID, name: 'Projekt Falke', description: '', selfMid: SELF, amAdmin: true,
  members: [{ mid: SELF, name: 'Ich' }, { mid: BOB, name: 'Bob' }, { mid: CAROL, name: 'Carol' }],
  admins: [SELF], rev: 1, removed: false, unread: 0,
};
const palette = T.resolveTheme({}, false);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error('Zeitueberschreitung'); await tick(10); }
}
function textOf(tree) {
  const out = [];
  const walk = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    (n.children || []).forEach(walk);
  };
  walk(tree.toJSON());
  return out.join(' | ');
}
const labels = (tree) => tree.root.findAll((n) => n.props && typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel);
const press = async (tree, label) => {
  const node = tree.root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  if (!node) throw new Error('Knopf fehlt: ' + label);
  await renderer.act(async () => { node.props.onPress(); await tick(30); });
};
async function render(el) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(el); });
  await renderer.act(async () => { await tick(20); });
  return tree;
}

let conn;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await EncryptedStorage.clear();
  await EncryptedStorage.setItem('group_self_id', SELF);
  await EncryptedStorage.setItem('groups', JSON.stringify([group]));
  await EncryptedStorage.setItem('contacts', JSON.stringify(contacts));
  RTCStore.resetAll();
  RTCStore.sharedSecrets.set('c_bob', SECRET);
  conn = {
    dataChannel: { readyState: 'open' }, pc: { iceConnectionState: 'connected' }, pendingMsgs: [], close() {},
    sendMessage: jest.fn(() => 'sent'),
  };
  RTCStore.connections.set('c_bob', conn);
  GCM._resetGroupCallForTests();
  GCM.configureGroupCall({ timeouts: { endedLingerMs: 10, statsMs: 0, terminalRetryMs: 5 } });
});
afterEach(async () => {
  GCM.leaveGroupCall();
  await tick(30);
  GCM._resetGroupCallForTests();
  Alert.alert.mockRestore();
});
const sentGcall = () => conn.sendMessage.mock.calls.map((c) => JSON.parse(c[0])).filter((m) => m.subtype === 'gcall_signal')
  .map((m) => JSON.parse(decryptMsg(m.enc, SECRET, 'gcall-signal')));

test('Zustandstexte der Kacheln', () => {
  const self = { isSelf: true, muted: false };
  expect(participantLabel(self, 'ringing')).toBe('klingelt');
  expect(participantLabel(self, 'outgoing')).toBe('wartet auf Antwort …');
  expect(participantLabel(self, 'connecting')).toBe('verbindet …');
  expect(participantLabel(self, 'active')).toBe('verbunden');
  expect(participantLabel({ ...self, muted: true }, 'active')).toBe('stumm');
  const p = (status, link = null, muted = false) => participantLabel({ isSelf: false, status, link, muted }, 'active');
  expect(p('joined', 'connecting')).toBe('verbindet …');
  expect(p('joined', 'connected')).toBe('verbunden');
  expect(p('joined', 'connected', true)).toBe('stumm');
  expect(p('joined', 'failed')).toBe('nicht erreichbar');
  expect(p('invited')).toBe('wird angerufen …');
  expect(p('ringing')).toBe('klingelt …');
  expect(p('declined')).toBe('abgelehnt');
  expect(p('missed')).toBe('nicht angenommen');
  expect(p('left')).toBe('aufgelegt');
  expect(p('busy')).toBe('besetzt');
  expect(p('tor_only')).toBe('nur Tor – nicht möglich');
  expect(p('unpaired')).toBe('nicht gekoppelt');
  expect(p('unreachable')).toBe('nicht erreichbar');
});

test('Gruppenchat ohne Vollversion: Knopf "Gruppenanruf" zeigt nur den Hinweis, es passiert nichts', async () => {
  GCM.configureGroupCall({ isPro: () => false });
  const tree = await render(React.createElement(GroupChatScreen, { group, contacts, palette, onBack() {}, onOpenDetail() {} }));
  expect(labels(tree)).toContain('Gruppenanruf');
  await press(tree, 'Gruppenanruf');
  expect(Alert.alert).toHaveBeenCalledWith('Vollversion', 'Gruppenanrufe starten ist Teil der Vollversion – teilnehmen kann jeder.');
  expect(GCM.getGroupCallSnapshot().state).toBe('idle');
  expect(conn.sendMessage).not.toHaveBeenCalled();
  await renderer.act(async () => tree.unmount());
});

test('Gruppenchat mit Vollversion: Knopf startet den Anruf (Einladung an gekoppelte Mitglieder)', async () => {
  GCM.configureGroupCall({ isPro: () => true });
  const tree = await render(React.createElement(GroupChatScreen, { group, contacts, palette, onBack() {}, onOpenDetail() {} }));
  await press(tree, 'Gruppenanruf');
  await waitFor(() => GCM.getGroupCallSnapshot().state === 'outgoing' && sentGcall().length > 0);
  const [invite] = sentGcall();
  expect(invite).toMatchObject({ v: 1, t: 'invite', groupId: GID, host: SELF });
  expect(invite.participants).toEqual([SELF, BOB]);   // Carol nicht gekoppelt -> nicht eingeladen
  expect(Alert.alert).not.toHaveBeenCalled();
  await renderer.act(async () => tree.unmount());
});

test('Anrufbildschirm (Host): Kacheln mit Zustaenden, Stumm, Lautsprecher, Auflegen', async () => {
  GCM.configureGroupCall({ isPro: () => true });
  expect(await GCM.startGroupCall(GID)).toEqual({ ok: true });
  const tree = await render(React.createElement(GroupCallScreen, { contacts, palette }));
  const t = textOf(tree);
  expect(t).toContain('Projekt Falke');
  expect(t).toContain('Ruft die Gruppe an …');
  expect(t).toContain('Du');
  expect(t).toContain('Bob');
  expect(t).toMatch(/wird angerufen …|klingelt …/);
  expect(t).toContain('Carol');
  expect(t).toContain('nicht gekoppelt');
  expect(t).toContain('Ende-zu-Ende verschlüsselt');
  expect(labels(tree)).toEqual(expect.arrayContaining(['Stummschalten', 'Lautsprecher', 'Auflegen']));
  await press(tree, 'Stummschalten');
  expect(GCM.getGroupCallSnapshot().muted).toBe(true);
  expect(labels(tree)).toContain('Mikrofon an');
  await press(tree, 'Lautsprecher');
  expect(NativeModules.MalachiCallAudio.setSpeaker).toHaveBeenCalledWith(true);
  await press(tree, 'Auflegen');
  await waitFor(() => GCM.getGroupCallSnapshot().state === 'idle');
  expect(sentGcall().some((m) => m.t === 'end')).toBe(true);
  await renderer.act(async () => tree.unmount());
});

test('Anrufbildschirm (Mitglied, ohne Vollversion): eingehender Gruppenanruf mit Annehmen/Ablehnen', async () => {
  GCM.configureGroupCall({ isPro: () => false });
  const callId = 'gc_' + crypto.randomBytes(16).toString('hex');
  const enc = await encryptMsg(JSON.stringify({ v: 1, t: 'invite', callId, groupId: GID, host: BOB, participants: [BOB, SELF, CAROL], ts: Date.now() }), SECRET, 'gcall-signal');
  RTCStore._onIncoming('c_bob', conn, { type: 'system', subtype: 'gcall_signal', enc });
  await waitFor(() => GCM.getGroupCallSnapshot().state === 'ringing');
  const tree = await render(React.createElement(GroupCallScreen, { contacts, palette }));
  expect(textOf(tree)).toContain('Gruppenanruf von Bob');
  expect(textOf(tree)).toContain('Gastgeber');
  expect(labels(tree)).toEqual(expect.arrayContaining(['Annehmen', 'Ablehnen']));
  await press(tree, 'Ablehnen');
  await waitFor(() => GCM.getGroupCallSnapshot().state === 'idle');
  expect(sentGcall().map((m) => m.t)).toEqual(['ringing', 'decline']);
  // Laeuft noch: im Gruppenchat "Gruppenanruf laeuft – tippen zum Beitreten".
  const chat = await render(React.createElement(GroupChatScreen, { group, contacts, palette, onBack() {}, onOpenDetail() {} }));
  expect(textOf(chat)).toContain('Gruppenanruf läuft – tippen zum Beitreten');
  await renderer.act(async () => { tree.unmount(); chat.unmount(); });
});

test('Navigation: Anruf erscheint (auch ueber der Sperre) und fuehrt danach zurueck', async () => {
  const calls = [];
  let setScreenOuter;
  const lockPendingRef = { current: false };
  const resumeTargetRef = { current: null };
  function Harness({ initial }) {
    const [screen, setScreen] = React.useState(initial);
    setScreenOuter = setScreen;
    const nav = (s, d) => { calls.push(['nav', s, d]); setScreen(s); };
    useGroupCallRouting({ screen, setScreen: (s) => { calls.push(['screen', s]); setScreen(s); }, nav, lockPendingRef, resumeTargetRef });
    return React.createElement('View', { screen });
  }
  GCM.configureGroupCall({ isPro: () => true });
  // 1) Gruppenchat -> Anruf -> zurueck in den Gruppenchat.
  let tree = await render(React.createElement(Harness, { initial: 'groupChat' }));
  await renderer.act(async () => { await GCM.startGroupCall(GID); await tick(20); });
  expect(calls).toContainEqual(['screen', 'groupCall']);
  await renderer.act(async () => { GCM.leaveGroupCall(); await tick(60); });
  expect(calls).toContainEqual(['nav', 'groupChat', { groupId: GID }]);
  await renderer.act(async () => tree.unmount());
  // 2) Klingeln auf dem Sperrbildschirm -> Anruf, danach zurueck zur Sperre.
  calls.length = 0;
  tree = await render(React.createElement(Harness, { initial: 'lock' }));
  const callId = 'gc_' + crypto.randomBytes(16).toString('hex');
  const enc = await encryptMsg(JSON.stringify({ v: 1, t: 'invite', callId, groupId: GID, host: BOB, participants: [BOB, SELF], ts: Date.now() }), SECRET, 'gcall-signal');
  await renderer.act(async () => { RTCStore._onIncoming('c_bob', conn, { type: 'system', subtype: 'gcall_signal', enc }); await tick(60); });
  expect(calls).toContainEqual(['screen', 'groupCall']);
  expect(lockPendingRef.current).toBe(true);
  await renderer.act(async () => { GCM.declineGroupCall(); await tick(60); });
  expect(calls[calls.length - 1]).toEqual(['screen', 'lock']);
  expect(lockPendingRef.current).toBe(false);
  expect(typeof setScreenOuter).toBe('function');
  await renderer.act(async () => tree.unmount());
});

test('statisch: Anrufbildschirm nur mit Design-Farben (keine festen Farbwerte)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../GroupCallScreen.tsx'), 'utf8');
  expect(src).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  expect(src).not.toMatch(/'(white|black|red|green|transparent)'|rgba?\(/);
  expect(src).toMatch(/backgroundColor:P\.dangerFill/);
  expect(src).toMatch(/color=\{P\.onDanger\}/);
  expect(src).toMatch(/bestOn\(P\.success/);
  expect(src).toMatch(/palette=\{P\}/);   // Profilbilder: avatarBg/avatarText des Designs
  // Annehmen-Symbol auf der Erfolgsfarbe in jedem Design lesbar.
  for (const s of [{}, ...T.PRO_THEMES.map((x) => ({ themeId: x.id }))]) {
    const th = T.resolveTheme(s, true);
    expect(T.contrastRatio(T.bestOn(th.success), th.success)).toBeGreaterThanOrEqual(3);
  }
});

test('statisch: App.tsx verdrahtet nur (Bildschirm, Zurueck-Taste, keine Sperre im Anruf, ein Anruf gleichzeitig)', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
  expect(app).toMatch(/groupCall: <GroupCallScreen contacts=\{contacts\} palette=\{P\} accent=\{AC\} \/>/);
  expect(app).toMatch(/if \(screen === 'groupCall'\) return groupCallBackPress\(\);/);
  expect(app).toMatch(/useGroupCallRouting\(\{ screen, setScreen, nav, lockPendingRef, resumeTargetRef \}\);/);
  expect(app).toMatch(/screenRef\.current === 'call' \|\| screenRef\.current === 'groupCall'\) \{ lockPendingRef\.current = true; return; \}/);
  expect(app).toMatch(/if \(isGroupCallBusy\(\)\) \{ Alert\.alert\(t\('call\.title'\), groupCallBusyNotice\(\)\); return; \}/);
  // Keine Gruppenanruf-Logik in App.tsx selbst.
  expect(app).not.toMatch(/gcall_signal|startGroupCall|RTCPeerConnection\(/);
});
