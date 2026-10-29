// Einstellungen > Sicherheit: App-PIN aendern und Duress-PIN festlegen/
// aendern/entfernen ueber SecurityPinModal - echter PIN-Tresor, nur der Chip
// ist eine Attrappe. Ohne richtige aktuelle App-PIN geht nichts; der dritte
// Fehlversuch sperrt die App, mit Vollversion loescht der fuenfte.
const React = require('react');
const renderer = require('react-test-renderer');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKey } = require('./helpers/pinVaultTestHelpers');
const { NativeModules, Text, TextInput } = require('react-native');
NativeModules.MalachiPinKey = fakePinKey();

let mockPro = true;
jest.mock('../../LicenseManager', () => {
  const actual = jest.requireActual('../../LicenseManager');
  return { ...actual, isProVerified: jest.fn(async () => mockPro) };
});

const ES = require('react-native-encrypted-storage').default;
const PV = require('../../PinVault');
const PC = require('../../PinChange');
const SecurityPinModal = require('../../SecurityPinModal').default;
const { setLanguage } = require('../../i18n');

const PIN = '482913';
const P = { overlay: '#0008', surface: '#fff', surfaceAlt: '#eee', text: '#000', textSub: '#333', textMuted: '#666',
  border: '#ccc', danger: '#c00', warning: '#a60', onAccent: '#fff' };
const tick = () => new Promise((r) => setTimeout(r, 0));

let props;
async function render(mode) {
  props = { onClose: jest.fn(), onDone: jest.fn(), onLockNow: jest.fn(), onWipe: jest.fn(), onNeedPro: jest.fn() };
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SecurityPinModal, { mode, palette: P, accent: '#0A7EA4', ...props }));
  });
  await renderer.act(async () => { await tick(); await tick(); });
  return tree;
}
const texts = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join('')).join(' | ');
async function enter(tree, value) {
  const input = tree.root.findAllByType(TextInput).find((i) => i.props.testID === 'security-pin-input');
  await renderer.act(async () => { input.props.onChangeText(value); });
  const btn = tree.root.findAll((n) => n.props && n.props.testID === 'security-pin-submit' && typeof n.props.onPress === 'function')[0];
  await renderer.act(async () => { await btn.props.onPress(); await tick(); await tick(); await tick(); });
}

beforeAll(() => setLanguage('de'));
beforeEach(async () => {
  PV._resetPinVaultForTests();
  await ES.clear();
  mockPro = true;
  await PV.create(PIN);
});

test('App-PIN aendern: aktuelle PIN, neue (4-stellig), wiederholen -> neue PIN gilt', async () => {
  const tree = await render('changePin');
  expect(texts(tree)).toContain('Aktuelle App-PIN');
  await enter(tree, PIN);
  expect(texts(tree)).toContain('Neue App-PIN');
  const four = tree.root.findAll((n) => n.props && n.props.testID === 'pin-len-4' && typeof n.props.onPress === 'function')[0];
  await renderer.act(async () => { four.props.onPress(); });
  await enter(tree, '1234');        // Wiederholen-Schritt
  expect(texts(tree)).toContain('Neue App-PIN wiederholen');
  await enter(tree, '1234');
  expect(props.onDone).toHaveBeenCalledWith('pinChanged');
  PV._resetPinVaultForTests();
  expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'wrong' });
  expect(await PV.unlockWithPin('1234')).toEqual({ ok: true });
  expect(await PC.currentPinLength()).toBe(4);
});

test('Wiederholung stimmt nicht: zurueck zur neuen PIN, nichts geaendert', async () => {
  const tree = await render('changePin');
  await enter(tree, PIN);
  await enter(tree, '111111');
  await enter(tree, '222222');
  expect(texts(tree)).toContain('PINs stimmen nicht überein');
  expect(texts(tree)).toContain('Neue App-PIN');
  expect(props.onDone).not.toHaveBeenCalled();
  expect(await PV.verifyPin(PIN)).toBe('ok');
});

test('falsche aktuelle PIN: Hinweis; der dritte Fehlversuch sperrt die App', async () => {
  const tree = await render('changePin');
  await enter(tree, '000000');
  expect(texts(tree)).toMatch(/PIN/);
  expect(props.onLockNow).not.toHaveBeenCalled();
  await enter(tree, '000001');
  await enter(tree, '000002');
  expect(props.onLockNow).toHaveBeenCalledTimes(1);
  expect(props.onDone).not.toHaveBeenCalled();
  expect(parseInt(await ES.getItem('pin_locked_until'), 10)).toBeGreaterThan(Date.now());
});

test('Vollversion: fuenfter Fehlversuch -> Loeschen wie am Sperrbildschirm', async () => {
  await ES.setItem('pin_attempts', '4');
  const tree = await render('changePin');
  await enter(tree, '000000');
  expect(props.onWipe).toHaveBeenCalledTimes(1);
});

test('Duress-PIN festlegen: nur nach App-PIN, zweimal eingeben; danach wirkt sie am Sperrbildschirm', async () => {
  const tree = await render('setDuress');
  await enter(tree, PIN);
  expect(texts(tree)).toContain('Neue Duress-PIN');
  await enter(tree, '1234');                                   // falsche Laenge
  expect(texts(tree)).toContain('6');
  await enter(tree, '765432');
  await enter(tree, '765432');
  expect(props.onDone).toHaveBeenCalledWith('duressSet');
  PV._resetPinVaultForTests();
  expect(await PV.unlockWithPin('765432')).toEqual({ ok: false, duress: true });
});

test('Duress-PIN festlegen ohne gueltige Vollversion: zur Vollversion-Seite, nichts gespeichert', async () => {
  mockPro = false;
  const tree = await render('setDuress');
  await enter(tree, PIN);
  await enter(tree, '765432');
  await enter(tree, '765432');
  expect(props.onNeedPro).toHaveBeenCalledTimes(1);
  expect(PV.hasDuressPin()).toBe(false);
});

test('Duress-PIN entfernen: nur mit der App-PIN - die Duress-PIN selbst zaehlt als falsch', async () => {
  await PV.setDuressPin('765432');
  const tree = await render('removeDuress');
  await enter(tree, '765432');
  expect(PV.hasDuressPin()).toBe(true);
  expect(await PV.vaultState()).toBe('present');               // nichts geloescht
  await enter(tree, PIN);
  expect(props.onDone).toHaveBeenCalledWith('duressRemoved');
  expect(PV.hasDuressPin()).toBe(false);
});

test('Laengenwechsel mit Duress-PIN: Hinweis, danach entfernt', async () => {
  await PV.setDuressPin('765432');
  const tree = await render('changePin');
  await enter(tree, PIN);
  const four = tree.root.findAll((n) => n.props && n.props.testID === 'pin-len-4' && typeof n.props.onPress === 'function')[0];
  await renderer.act(async () => { four.props.onPress(); });
  expect(texts(tree)).toContain('Die Duress-PIN muss so lang sein wie die App-PIN');
  await enter(tree, '9070');
  await enter(tree, '9070');
  expect(props.onDone).toHaveBeenCalledWith('pinChangedDuressRemoved');
  expect(PV.hasDuressPin()).toBe(false);
});

test('Zurueck-Taste (onRequestClose) bricht ab', async () => {
  const tree = await render('changePin');
  const { Modal } = require('react-native');
  const modal = tree.root.findByType(Modal);
  await renderer.act(async () => { modal.props.onRequestClose(); });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});
