// Darstellungstest Siegel-Modus (SiegelScreen.tsx): Einrichten, Kontakt,
// Verschluesseln & Teilen, Entschluesseln aus der Zwischenablage (danach
// geleert), Sperren verwirft den Klartext (Zero Trace).
const React = require('react');
const renderer = require('react-test-renderer');
const { fakeKyber, fakeSiegelKey, rng } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, Share, Text, TextInput } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
NativeModules.MalachiSiegelKey = fakeSiegelKey();

let mockClip = '';
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { getString: jest.fn(async () => mockClip), setString: jest.fn((s) => { mockClip = s; }) },
}));

const EncryptedStorage = require('react-native-encrypted-storage').default;
const V = require('../../SiegelVault');
const S = require('../../SiegelCrypto');
const SiegelScreen = require('../../SiegelScreen').default;
const { SafeAreaProvider } = require('react-native-safe-area-context');

const PASS = 'Kerze-Berg-Fluss-42';
const kyber = NativeModules.KyberModule;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function render() {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
        React.createElement(SiegelScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4' })),
    );
  });
  await renderer.act(async () => { await tick(); });
  return tree;
}
const allText = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join('')).join(' | ');
async function press(tree, label) {
  // Text-Knoepfe ueber ihre Beschriftung, Symbol-Knoepfe (Eingabefeld: Anhang,
  // Senden, Sprachnachricht ...) ueber accessibilityLabel.
  const node = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function'
    && (n.props.accessibilityLabel === label
      || n.findAllByType(Text).some((t) => [].concat(t.props.children).join('') === label)))[0];
  if (!node) throw new Error('Knopf nicht gefunden: ' + label + '\n' + allText(tree));
  await renderer.act(async () => { await node.props.onPress(); await tick(); await tick(); });
}
async function type(tree, placeholderPart, value) {
  const input = tree.root.findAllByType(TextInput).find((i) => String(i.props.placeholder || '').includes(placeholderPart));
  if (!input) throw new Error('Feld nicht gefunden: ' + placeholderPart);
  await renderer.act(async () => { input.props.onChangeText(value); });
}

beforeEach(async () => {
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
  mockClip = '';
});

test('ohne Tresor: Einrichten mit Erklaerung; danach Liste', async () => {
  const tree = await render();
  expect(allText(tree)).toMatch(/eigenen Tresor mit eigener Passphrase/);
  await type(tree, 'Passphrase (mind.', PASS);
  await type(tree, 'wiederholen', PASS + 'x');
  await press(tree, 'Tresor einrichten');
  expect(allText(tree)).toMatch(/stimmen nicht überein/);
  await type(tree, 'wiederholen', PASS);
  await press(tree, 'Tresor einrichten');
  expect(allText(tree)).toMatch(/Nachricht entschlüsseln/);
  expect(V.isUnlocked()).toBe(true);
  await renderer.act(async () => tree.unmount());
});

test('Verschluesseln & teilen, Entschluesseln aus der Zwischenablage, Sperren verwirft den Klartext', async () => {
  await V.setup(PASS);
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  await V.finishInvite(peer.qr, 'Alex');
  const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });

  const tree = await render();
  expect(allText(tree)).toMatch(/Alex/);
  await press(tree, 'Alex');
  await type(tree, 'Was möchtest du Alex schreiben?', 'Treffen um 8');
  await press(tree, 'Senden');
  expect(shareSpy).toHaveBeenCalledTimes(1);
  const sent = shareSpy.mock.calls[0][0].message;
  expect(sent.startsWith('MS1:')).toBe(true);
  expect(allText(tree)).not.toMatch(/Treffen um 8/);       // Eingabe nach dem Verschluesseln geleert
  const o = await S.openText(peer.contact.ratchet, sent, { rng });
  expect(o.text).toBe('Treffen um 8');

  // Antwort des Peers: im Messenger kopiert -> Entschluesseln-Reiter
  const reply = await S.sealText(o.ratchet, 'Passt, bis dann', { rng });
  mockClip = 'Alex: ' + reply.message;
  await press(tree, 'Entschlüsseln');
  await press(tree, 'Aus Zwischenablage entschlüsseln');
  expect(allText(tree)).toMatch(/Passt, bis dann/);
  expect(mockClip).toBe('');                                    // Zwischenablage geleert

  await renderer.act(async () => { V.lock(); await tick(); });
  expect(allText(tree)).not.toMatch(/Passt, bis dann/);
  expect(allText(tree)).toMatch(/gesperrt/);
  shareSpy.mockRestore();
  await renderer.act(async () => tree.unmount());
});

test('falsche Passphrase: Hinweis mit Restversuchen', async () => {
  await V.setup(PASS);
  V.lock();
  const tree = await render();
  await type(tree, 'Siegel-Passphrase', 'falsch-falsch');
  await press(tree, 'Entsperren');
  expect(allText(tree)).toMatch(/Noch 9 Versuche/);
  await renderer.act(async () => tree.unmount());
});

test('aus dem Malachi-Chat geoeffnet (initialMessage): nach dem Entsperren direkt entschluesselt, ohne Zwischenablage', async () => {
  await V.setup(PASS);
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  await V.finishInvite(peer.qr, 'Alex');
  const m = await S.sealText(peer.contact.ratchet, 'Direkt aus dem Chat', { rng });
  V.lock();
  mockClip = 'unberuehrt';
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
        React.createElement(SiegelScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4', initialMessage: m.message })),
    );
  });
  await renderer.act(async () => { await tick(); });
  await type(tree, 'Siegel-Passphrase', PASS);
  await press(tree, 'Entsperren');
  await renderer.act(async () => { await tick(); await tick(); });
  expect(allText(tree)).toMatch(/Direkt aus dem Chat/);
  expect(mockClip).toBe('unberuehrt');
  await renderer.act(async () => tree.unmount());
});

test('statisch: Siegel-Nachrichten im Malachi-Chat werden kompakt angezeigt und direkt geoeffnet', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/const sKind = siegelKind\(item\.text\);/);
  expect(app).toMatch(/<SiegelScreen visible=\{!!siegelMsg\} initialMessage=\{siegelMsg\?\.msg \|\| null\}/);
  // Entscheidung 2026-10-19: Entschluesseln kostenlos, Schreiben Vollversion.
  const open = app.slice(app.indexOf('const openSiegel = '), app.indexOf('const toggleSiegelMode = '));
  expect(open).not.toMatch(/getLicenseState/);
  const toggle = app.slice(app.indexOf('const toggleSiegelMode = '), app.indexOf('const siegelMessageMenu = '));
  expect(toggle).toMatch(/if \(getLicenseState\(\)\.pro !== true\) \{\s*Alert\.alert\(t\('app\.siegelNachrichtenSchreiben'\)/);
  expect(app).toMatch(/canSeal=\{getLicenseState\(\)\.pro === true\}/);
  expect(app).toMatch(/<SiegelScreen visible=\{siegelOpen\} onClose=\{\(\) => setSiegelOpen\(false\)\} canSeal=\{pro\}/);
  // Siegel-Menue im App-Design statt System-Dialog
  expect(app).toMatch(/const siegelMessageMenu = \(msgId, text, mine\) => setSiegelMenu\(/);
  expect(app).not.toMatch(/Alert\.alert\(t\('chat\.siegelMessage'\), mine/);
});

test('ohne Vollversion: Siegel-Nachricht entschluesseln und exportieren geht, Antworten/Verschluesseln/Einladen nicht', async () => {
  await V.setup(PASS);
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  await V.finishInvite(peer.qr, 'Kanzlei');
  const m = await S.sealText(peer.contact.ratchet, 'Ihr Termin ist bestaetigt', { rng });
  const sentToChat = [];
  let tree;
  const el = (p) => React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
    React.createElement(SiegelScreen, { visible: true, onClose: () => {}, canSeal: false, initialMessage: m.message, onSendCipher: (c) => sentToChat.push(c), chatId: 'c1', chatName: 'Kanzlei', ...p }));
  await renderer.act(async () => { tree = renderer.create(el({})); });
  await renderer.act(async () => { await tick(); await tick(); });
  const text = allText(tree);
  expect(text).toMatch(/Ihr Termin ist bestaetigt/);                  // entschluesselt
  expect(text).toMatch(/Exportieren …/);                              // Export frei
  expect(text).toMatch(/Mit Siegel antworten ist Teil der Vollversion/);
  expect(tree.root.findAll((n) => n.props && n.props.accessibilityLabel === 'Senden')).toHaveLength(0);
  expect(sentToChat).toHaveLength(0);
  await renderer.act(async () => tree.unmount());
});

test('ohne Vollversion: neue Kopplung nur durch Scannen einer Einladung, kein eigenes Einladen; Kontakt oeffnet auf Entschluesseln', async () => {
  await V.setup(PASS);
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  await V.finishInvite(peer.qr, 'Bea');
  const opened = [];
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
      React.createElement(SiegelScreen, { visible: true, onClose: () => {}, canSeal: false, onOpenPro: () => opened.push(1) })));
  });
  await renderer.act(async () => { await tick(); await tick(); });
  await press(tree, '+ Neuer Siegel-Kontakt');
  expect(allText(tree)).toMatch(/Ich scanne die Einladung/);
  expect(allText(tree)).not.toMatch(/Ich zeige die Einladung/);
  expect(allText(tree)).toMatch(/Eine Einladung zeigen ist Teil der Vollversion/);
  await press(tree, 'Vollversion ansehen');
  expect(opened).toHaveLength(1);
  await renderer.act(async () => tree.unmount());
});

test('Antworten direkt im Lese-Fenster: aus dem Chat geoeffnet geht die Siegel-Antwort in den Chat zurueck', async () => {
  await V.setup(PASS);
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  await V.finishInvite(peer.qr, 'Alex');
  const m = await S.sealText(peer.contact.ratchet, 'Kommst du heute?', { rng });
  const sentToChat = [];
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
        React.createElement(SiegelScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4', initialMessage: m.message, onSendCipher: (c) => sentToChat.push(c) })),
    );
  });
  await renderer.act(async () => { await tick(); await tick(); });
  expect(allText(tree)).toMatch(/Kommst du heute\?/);
  await type(tree, 'Antwort an Alex', 'Ja, um 8');
  await press(tree, 'Senden');
  expect(sentToChat).toHaveLength(1);
  expect(sentToChat[0].startsWith('MS1:')).toBe(true);
  expect(V.isUnlocked()).toBe(false);                      // danach gesperrt, Klartext verworfen
  expect(allText(tree)).not.toMatch(/Kommst du heute\?/);
  const o = await S.openText(m.ratchet, sentToChat[0], { rng });
  expect(o.text).toBe('Ja, um 8');
  await renderer.act(async () => tree.unmount());
});

test('statisch: Kontaktliste zeigt Siegel-Nachrichten als "🔒 Siegel-Nachricht"', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/sk === 'invite' \? t\('preview\.siegelInvite'\)/);
  expect(require('../../i18n').t('preview.siegelInvite')).toBe('🔒 Siegel-Einladung');
  expect(app).toMatch(/onSendCipher=\{\(cipher\) => sendTextNow\(cipher\)\}/);
  expect(app).toMatch(/onLongPress=\{toggleSiegelMode\} delayLongPress=\{1500\}/);
});

async function renderChat(props) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
        React.createElement(SiegelScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4', chatId: 'chat-1', chatName: 'Alex', ...props })),
    );
  });
  await renderer.act(async () => { await tick(); await tick(); });
  return tree;
}

test('Kopplung ueber den Chat: Einladung geht in den Chat, Antwort-Blase schliesst ab, danach direkt schreiben', async () => {
  await V.setup(PASS);
  const sent = [];
  let tree = await renderChat({ onSendCipher: (c) => sent.push(c) });
  await press(tree, 'Über diesen Chat koppeln');
  expect(sent).toHaveLength(1);
  expect(sent[0].startsWith('MSI1:')).toBe(true);
  expect(allText(tree)).toMatch(/Einladung ist im Chat/);
  await renderer.act(async () => tree.unmount());
  // Gegenseite (Peer) nimmt im Chat an und schickt die Antwort zurueck.
  const peer = await S.acceptInvite(sent[0], { rng, kyber });
  V.lock();                                              // Stunden spaeter: Tresor war zu
  tree = await renderChat({ initialMessage: peer.qr, onSendCipher: (c) => sent.push(c) });
  await type(tree, 'Siegel-Passphrase', PASS);
  await press(tree, 'Entsperren');
  await renderer.act(async () => { await tick(); await tick(); });
  expect(allText(tree)).toMatch(/ist gekoppelt/);
  expect(allText(tree)).toContain(peer.contact.safety);
  await press(tree, 'Jetzt eine Siegel-Nachricht schreiben');
  await type(tree, 'Was möchtest du', 'Hallo ueber Siegel');
  await press(tree, 'Senden');
  const last = sent[sent.length - 1];
  expect(last.startsWith('MS1:')).toBe(true);
  expect((await S.openText(peer.contact.ratchet, last, { rng })).text).toBe('Hallo ueber Siegel');
  await renderer.act(async () => tree.unmount());
  // Naechstes Mal (Mikrofon 1,5 s halten): verknuepfter Kontakt oeffnet sich direkt.
  await V.unlock(PASS);
  tree = await renderChat({ onSendCipher: (c) => sent.push(c) });
  // Schreibfenster des verknuepften Kontakts ist direkt offen (Eingabefeld + Chat-Hinweis).
  expect(allText(tree)).toMatch(/für Bild oder Datei, Mikrofon für eine Sprachnachricht/);
  expect(tree.root.findAllByType(TextInput).some((i) => String(i.props.placeholder || '').includes('Was möchtest du Alex schreiben'))).toBe(true);
  await renderer.act(async () => tree.unmount());
});

test('Einladung im Chat angetippt: annehmen, Antwort geht in den Chat, Sicherheitscode wird gezeigt', async () => {
  await V.setup(PASS);
  const inv = await S.createInvite({ rng, kyber });
  const sent = [];
  const tree = await renderChat({ initialMessage: inv.qr, onSendCipher: (c) => sent.push(c) });
  await renderer.act(async () => { await tick(); await tick(); });
  expect(sent).toHaveLength(1);
  expect(sent[0].startsWith('MSA1:')).toBe(true);
  const done = await S.completeInvite(inv.secret, sent[0], { rng, kyber });
  expect(allText(tree)).toContain(done.contact.safety);
  await renderer.act(async () => tree.unmount());
});
