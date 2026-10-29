// Krypto-Review V3 - Sperrbildschirm (echter LockScreen aus App.tsx):
//  - 4 und 6 Stellen bleiben gleichwertige Wahl; ein kleines "i" erklaert auf
//    Antippen kurz den Unterschied - ohne Dialog, ohne Druck (Vorgabe des
//    Entwicklers).
//  - Eine neue 4-stellige PIN legt den Tresor mit dem neuen Chip-Schluessel an.
//  - Ein bestehender 4-stelliger 1.1-Tresor oeffnet nach dem Update wie gewohnt
//    und wird dabei still umgestellt - keine Aufforderung, die PIN zu aendern.
const React = require('react');
const renderer = require('react-test-renderer');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKeyMulti } = require('./helpers/pinVaultTestHelpers');
const { NativeModules, TouchableOpacity, Text, Alert } = require('react-native');

jest.mock('react-native-biometrics', () => ({
  __esModule: true,
  default: class {
    async isSensorAvailable() { return { available: false }; }
    async simplePrompt() { return { success: false }; }
  },
}));
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  DocumentDirectoryPath: '/docs',
  writeFile: async () => {},
  readFile: async () => { throw new Error('ENOENT'); },
  unlink: async () => {},
  exists: async () => false,
  mkdir: async () => {},
  readDir: async () => [],
}));

let pinKey = fakePinKeyMulti();
NativeModules.MalachiPinKey = pinKey;
const ES = require('react-native-encrypted-storage').default;
const PV = require('../../PinVault');
const { LockScreen } = require('../../App');

const allText = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join(' | ');
const byId = (tree, id) => tree.root.findAll((n) => n.props && n.props.testID === id && typeof n.type !== 'string')[0];

async function renderLock(props) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(LockScreen, props)); });
  await renderer.act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  return tree;
}
async function press(tree, label) {
  const key = tree.root.findAllByType(TouchableOpacity).find((n) => n.findAllByType(Text).some((tx) => [].concat(tx.props.children).join('') === label));
  await renderer.act(async () => { key.props.onPress(); });
}
async function typePin(tree, pin) {
  for (const d of pin) await press(tree, d);
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

const trees = [];
beforeEach(async () => {
  PV._resetPinVaultForTests();
  await ES.clear();
  pinKey = fakePinKeyMulti();
  NativeModules.MalachiPinKey = pinKey;
});
afterEach(async () => {
  for (const t of trees.splice(0)) await renderer.act(async () => { try { t.unmount(); } catch {} });
  jest.restoreAllMocks();
});

test('Ersteinrichtung: 4 und 6 Stellen waehlbar, das "i" zeigt kurz die Erklaerung (kein Dialog)', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const tree = await renderLock({ onUnlock: jest.fn(), onWipe: jest.fn() });
  trees.push(tree);
  const text = allText(tree);
  expect(text).toMatch(/4-stellig/);
  expect(text).toMatch(/6-stellig/);
  expect(text).not.toMatch(/deutlich schwerer durchzuprobieren/);
  await renderer.act(async () => { byId(tree, 'pin-length-info').props.onPress(); });
  expect(allText(tree)).toMatch(/Eine längere PIN \(6 Stellen\) ist deutlich schwerer durchzuprobieren.*4 Stellen reichen für viele Alltagsfälle – du entscheidest\./);
  await renderer.act(async () => { byId(tree, 'pin-length-info').props.onPress(); });
  expect(allText(tree)).not.toMatch(/deutlich schwerer durchzuprobieren/);
  expect(alert).not.toHaveBeenCalled();
});

test('neue 4-stellige PIN: Tresor mit dem neuen Chip-Schluessel, Entsperren ueber den echten Bildschirm', async () => {
  const onUnlock = jest.fn();
  const tree = await renderLock({ onUnlock, onWipe: jest.fn() });
  trees.push(tree);
  await press(tree, '4-stellig');
  await typePin(tree, '2580');
  await typePin(tree, '2580');
  expect(onUnlock).toHaveBeenCalledTimes(1);
  expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, unlockedRequired: true });
  expect(await ES.getItem('pin_length')).toBe('4');
  PV.lock();
  const again = await renderLock({ onUnlock, onWipe: jest.fn() });
  trees.push(again);
  await typePin(again, '2580');
  expect(onUnlock).toHaveBeenCalledTimes(2);
});

test('bestehender 4-stelliger Tresor aus 1.1: oeffnet wie gewohnt, wird still umgestellt, keine Aufforderung', async () => {
  // 1.1: nur der alte Schluessel
  NativeModules.MalachiPinKey = {
    createKey: pinKey.createKey, deriveKey: pinKey.deriveKey, destroyKey: pinKey.destroyKey, hasKey: pinKey.hasKey,
  };
  await PV.create('1357');
  await ES.setItem('pin_length', '4');
  PV.lock();
  PV._resetPinVaultForTests();
  NativeModules.MalachiPinKey = pinKey;          // Update
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const onUnlock = jest.fn();
  const tree = await renderLock({ onUnlock, onWipe: jest.fn() });
  trees.push(tree);
  await typePin(tree, '1357');
  expect(onUnlock).toHaveBeenCalledTimes(1);
  expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: true });
  expect(alert).not.toHaveBeenCalled();
  expect(allText(tree)).not.toMatch(/6 Stellen|ändern|aendern/);
  expect(await ES.getItem('pin_length')).toBe('4');
});
