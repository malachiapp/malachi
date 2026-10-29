// Siegel-Bildschirm (SiegelScreen.tsx): "Passphrase aendern" ueber die
// Oberflaeche, Hinweis "Passphrase vergessen", uebersetzte Fehlertexte und
// die Zurueck-Taste innerhalb von Siegel (eine Ansicht zurueck statt alles zu).
const React = require('react');
const renderer = require('react-test-renderer');
const { fakeKyber, fakeSiegelKey, rng } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, Text, TextInput, Modal } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
NativeModules.MalachiSiegelKey = fakeSiegelKey();

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { getString: jest.fn(async () => ''), setString: jest.fn() },
}));

const EncryptedStorage = require('react-native-encrypted-storage').default;
const V = require('../../SiegelVault');
const S = require('../../SiegelCrypto');
const SiegelScreen = require('../../SiegelScreen').default;
const { SafeAreaProvider } = require('react-native-safe-area-context');
const { setLanguage } = require('../../i18n');

const OLD = 'Kerze-Berg-Fluss-42';
const NEW = 'Wolke-Tal-Stein-77';
const kyber = NativeModules.KyberModule;
const tick = () => new Promise((r) => setTimeout(r, 0));

let onClose;
async function render() {
  onClose = jest.fn();
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
        React.createElement(SiegelScreen, { visible: true, onClose, accent: '#0A7EA4' })),
    );
  });
  await renderer.act(async () => { await tick(); });
  return tree;
}
const allText = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join('')).join(' | ');
async function press(tree, label) {
  const node = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function'
    && (n.props.accessibilityLabel === label
      || n.findAllByType(Text).some((t) => [].concat(t.props.children).join('') === label)))[0];
  if (!node) throw new Error('Knopf nicht gefunden: ' + label + '\n' + allText(tree));
  await renderer.act(async () => { await node.props.onPress(); await tick(); await tick(); });
}
async function type(tree, placeholder, value) {
  const input = tree.root.findAllByType(TextInput).find((i) => String(i.props.placeholder || '') === placeholder);
  if (!input) throw new Error('Feld nicht gefunden: ' + placeholder);
  await renderer.act(async () => { input.props.onChangeText(value); });
}
const hardwareBack = async (tree) => {
  const m = tree.root.findAllByType(Modal)[0];
  await renderer.act(async () => { m.props.onRequestClose(); await tick(); });
};

beforeEach(async () => {
  setLanguage('de');
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
});

test('Passphrase aendern ueber die Oberflaeche: alte falsch -> Hinweis, richtig -> neue gilt', async () => {
  await V.setup(OLD);
  const tree = await render();
  await press(tree, 'Passphrase ändern');
  expect(allText(tree)).toMatch(/Erst die bisherige Passphrase/);
  await type(tree, 'Bisherige Passphrase', 'falsch-falsch');
  await type(tree, 'Neue Passphrase (mind. 8 Zeichen, besser 4 Wörter)', NEW);
  await type(tree, 'Neue Passphrase wiederholen', NEW);
  await press(tree, 'Speichern');
  expect(allText(tree)).toMatch(/Falsche Passphrase\. Noch 9 Versuche/);

  await type(tree, 'Bisherige Passphrase', OLD);
  await type(tree, 'Neue Passphrase wiederholen', NEW + 'x');
  await press(tree, 'Speichern');
  expect(allText(tree)).toMatch(/stimmen nicht überein/);

  await type(tree, 'Bisherige Passphrase', OLD);
  await type(tree, 'Neue Passphrase wiederholen', NEW);
  await press(tree, 'Speichern');
  expect(allText(tree)).toMatch(/Passphrase geändert/);
  await renderer.act(async () => { V.lock(); await tick(); });
  expect((await V.unlock(OLD)).ok).toBe(false);
  expect((await V.unlock(NEW)).ok).toBe(true);
  await renderer.act(async () => tree.unmount());
});

test('gesperrt: Hinweis "Passphrase vergessen" neben dem Loeschen; Fehlertexte uebersetzt (Englisch)', async () => {
  await V.setup(OLD);
  V.lock();
  const tree = await render();
  expect(allText(tree)).toMatch(/Passphrase vergessen\? Es gibt keine Wiederherstellung/);
  await renderer.act(async () => tree.unmount());

  setLanguage('en');
  const en = await render();
  expect(allText(en)).toMatch(/Forgot your passphrase\? There is no recovery/);
  await type(en, 'Siegel passphrase', 'falsch-falsch');
  await press(en, 'Unlock');
  expect(allText(en)).toMatch(/Wrong passphrase\. 9 attempts left/);
  expect(allText(en)).not.toMatch(/Falsche Passphrase/);
  await renderer.act(async () => en.unmount());
});

test('Zurueck-Taste: Kontakt -> Liste -> Siegel zu; Passphrase-Ansicht -> Liste', async () => {
  await V.setup(OLD);
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  await V.finishInvite(peer.qr, 'Alex');
  const tree = await render();
  await press(tree, 'Alex');
  expect(allText(tree)).toMatch(/Verschlüsseln \| Entschlüsseln/);
  expect(allText(tree)).not.toMatch(/Nachricht entschlüsseln/);
  await hardwareBack(tree);
  expect(allText(tree)).toMatch(/Nachricht entschlüsseln/);     // Liste
  expect(onClose).not.toHaveBeenCalled();
  await press(tree, 'Passphrase ändern');
  await hardwareBack(tree);
  expect(allText(tree)).toMatch(/Nachricht entschlüsseln/);
  await hardwareBack(tree);
  expect(onClose).toHaveBeenCalledTimes(1);
  await renderer.act(async () => tree.unmount());
});
