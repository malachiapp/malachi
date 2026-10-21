// Oberflaeche der In-App-Updates (UpdateUI.tsx): Einstellungen "UPDATES",
// Hinweis auf der Startseite, Dialog mit Download/Installieren - und dass in
// der Play-Version nichts davon erscheint.
const React = require('react');
const renderer = require('react-test-renderer');
const { act } = renderer;
const { NativeModules, Platform, Alert, Text, Switch } = require('react-native');
const { Buffer } = require('buffer');
const VEKTOR = require('../../website/werkzeuge/test/update-testvektor.json');

const ONION = 'p75bcu4mna6lik35occlsoeoyke46zyikfuq2ugu3wdvu44e5c4wanyd.onion';
const mockConfig = {
  STUN_POOL: [], STUN_PER_CONNECTION: 2, LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99',
  UPDATE_PUBLIC_KEYS: [], UPDATE_ONION: ONION, UPDATE_PATH: '/updates/',
};
jest.mock('../../AppConfig', () => mockConfig);

const NetInfo = require('@react-native-community/netinfo');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const U = require('../../AppUpdater');
const { UpdateSettingsSection, UpdateBanner } = require('../../UpdateUI');
const { getTheme } = require('../../Themes');

const P = getTheme();
const files = {
  '/updates/manifest.json': Buffer.from(VEKTOR.manifest, 'utf8'),
  '/updates/manifest.json.sig': Buffer.from(VEKTOR.signaturDatei, 'utf8'),
};
function installNative({ versionCode = 11, canInstall = true } = {}) {
  const nat = {
    versionCode, versionName: '1.1.0', applicationId: 'com.securecommapp', supportedAbis: 'arm64-v8a,armeabi-v7a',
    fetchSmall: jest.fn(async (h, path) => ({ status: 200, bodyB64: files[path].toString('base64') })),
    download: jest.fn(async (h, p, max, sha) => ({ path: '/c/malachi_update/update-1.apk', size: max, sha256: sha })),
    cancelDownload: jest.fn(async () => true),
    cleanup: jest.fn(async () => 0),
    inspectApk: jest.fn(async () => ({ packageName: 'com.securecommapp', versionCode: 12, signers: [], installedSigners: [] })),
    canRequestPackageInstalls: jest.fn(async () => canInstall),
    openInstallPermissionSettings: jest.fn(async () => true),
    install: jest.fn(async () => 'started'),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  NativeModules.MalachiUpdater = nat;
  return nat;
}

const textOf = (tree) => tree.root.findAllByType(Text).map((t) => {
  const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(flat).join('') : c && c.props ? flat(c.props.children) : '');
  return flat(t.props.children);
}).join('\n');
const pressByText = (tree, label) => {
  const t = tree.root.findAllByType(Text).find((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : n.props.children) === label);
  if (!t) throw new Error('Nicht gefunden: ' + label);
  let n = t;
  while (n && !n.props.onPress) n = n.parent;
  return n.props.onPress();
};
async function render(el) {
  let tree;
  await act(async () => { tree = renderer.create(el); });
  await act(async () => {});
  return tree;
}

beforeEach(async () => {
  Platform.OS = 'android';
  delete NativeModules.MalachiBuild;
  mockConfig.UPDATE_PUBLIC_KEYS = [VEKTOR.oeffentlich];
  await EncryptedStorage.clear();
  U._resetUpdaterForTests();
});

test('Play-Version: weder Einstellungen noch Hinweis', async () => {
  NativeModules.MalachiBuild = { distribution: 'play' };
  installNative();
  const a = await render(React.createElement(UpdateSettingsSection, { palette: P, accent: P.accent }));
  const b = await render(React.createElement(UpdateBanner, { palette: P, accent: P.accent }));
  expect(a.toJSON()).toBeNull();
  expect(b.toJSON()).toBeNull();
});

test('ohne Schluessel: "Updates werden eingerichtet", kein Schalter, kein "Jetzt prüfen"', async () => {
  mockConfig.UPDATE_PUBLIC_KEYS = [];
  installNative();
  const tree = await render(React.createElement(UpdateSettingsSection, { palette: P, accent: P.accent }));
  const txt = textOf(tree);
  expect(txt).toContain('Updates werden eingerichtet');
  expect(txt).not.toContain('Jetzt prüfen');
  expect(tree.root.findAllByType(Switch)).toHaveLength(0);
});

test('Einstellungen: Schalter, "Jetzt prüfen" -> Update gefunden', async () => {
  const nat = installNative();
  const tree = await render(React.createElement(UpdateSettingsSection, { palette: P, accent: P.accent }));
  expect(textOf(tree)).toContain('Automatisch nach Updates suchen');
  const sw = tree.root.findByType(Switch);
  expect(sw.props.value).toBe(true);
  await act(async () => { await pressByText(tree, 'Jetzt prüfen'); });
  expect(nat.fetchSmall).toHaveBeenCalledTimes(2);
  expect(textOf(tree)).toContain('Malachi 1.2.0 ist da');
  await act(async () => { await sw.props.onValueChange(false); });
  expect(JSON.parse(await EncryptedStorage.getItem('update_state_v1')).autoCheck).toBe(false);
});

test('Hinweis auf der Startseite: "Malachi 1.2.0 ist da – Was ist neu", ausblendbar', async () => {
  installNative();
  await U.checkForUpdate();
  const tree = await render(React.createElement(UpdateBanner, { palette: P, accent: P.accent }));
  const txt = textOf(tree);
  expect(txt).toContain('Malachi 1.2.0 ist da – Was ist neu');
  expect(txt).not.toContain('Dieses Update ist wichtig');
  await act(async () => { await tree.root.findByProps({ testID: 'update-banner-close' }).props.onPress(); });
  expect(tree.root.findAllByProps({ testID: 'update-banner' })).toHaveLength(0);
});

test('wichtiges Update wird hervorgehoben', async () => {
  installNative({ versionCode: 9 });
  await U.checkForUpdate();
  const tree = await render(React.createElement(UpdateBanner, { palette: P, accent: P.accent }));
  expect(textOf(tree)).toContain('Dieses Update ist wichtig');
});

test('Dialog: Hinweise, Groesse, Download erst nach Rueckfrage im Mobilfunk, dann Installieren', async () => {
  const nat = installNative();
  await U.checkForUpdate();
  const tree = await render(React.createElement(UpdateBanner, { palette: P, accent: P.accent }));
  await act(async () => { await tree.root.findByProps({ testID: 'update-banner-open' }).props.onPress(); });
  const txt = textOf(tree);
  expect(txt).toContain('Malachi 1.2.0');
  expect(txt).toContain('Zweiter Punkt');
  expect(txt).toContain('Über Tor herunterladen (41,2 MB)');
  // Mobilfunk (Standard des NetInfo-Mocks): erst fragen
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await act(async () => { await tree.root.findByProps({ testID: 'update-download' }).props.onPress(); });
  expect(alert).toHaveBeenCalledTimes(1);
  expect(nat.download).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0][2];
  await act(async () => { await buttons.find((b) => b.text === 'Herunterladen').onPress(); });
  await act(async () => {});
  expect(nat.download).toHaveBeenCalledTimes(1);
  expect(textOf(tree)).toContain('Installieren');
  await act(async () => { await tree.root.findByProps({ testID: 'update-install' }).props.onPress(); });
  expect(nat.install).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});

test('Dialog im WLAN: Download ohne Rueckfrage; ohne Installations-Erlaubnis erst Erklaerung', async () => {
  NetInfo.fetch.mockResolvedValueOnce({ type: 'wifi', isConnected: true, details: { isConnectionExpensive: false } });
  const nat = installNative({ canInstall: false });
  await U.checkForUpdate();
  const tree = await render(React.createElement(UpdateBanner, { palette: P, accent: P.accent }));
  await act(async () => { await tree.root.findByProps({ testID: 'update-banner-open' }).props.onPress(); });
  await act(async () => { await tree.root.findByProps({ testID: 'update-download' }).props.onPress(); });
  await act(async () => {});
  expect(nat.download).toHaveBeenCalledTimes(1);
  await act(async () => { await tree.root.findByProps({ testID: 'update-install' }).props.onPress(); });
  expect(nat.install).not.toHaveBeenCalled();
  expect(textOf(tree)).toContain('Unbekannte Apps installieren');
  await act(async () => { await tree.root.findByProps({ testID: 'update-permission' }).props.onPress(); });
  expect(nat.openInstallPermissionSettings).toHaveBeenCalledTimes(1);
});
