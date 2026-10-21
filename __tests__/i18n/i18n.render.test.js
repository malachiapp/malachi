// Darstellung in anderen Sprachen (Rauchtest): Einstellungen mit dem neuen
// Abschnitt SPRACHE, Gruppenliste/-anlage und Siegel-Einrichtung werden auf
// Englisch und Arabisch gerendert - ohne deutsche Saetze aus der Quelle.
// Danach zurueck auf die Geraetesprache (Tests: Deutsch).
const React = require('react');
const renderer = require('react-test-renderer');
const { fakeKyber, fakeSiegelKey } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
NativeModules.MalachiSiegelKey = fakeSiegelKey();

const mockConfig = { STUN_HOST: 'stun.invalid', STUN_URL: 'stun:stun.invalid:3478', LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { getString: jest.fn(async () => ''), setString: jest.fn() },
}));

const EncryptedStorage = require('react-native-encrypted-storage').default;
const I = require('../../i18n');
const T = require('../../Themes');
require('../../BackgroundSync'); // verdrahtet GroupMessaging (wie in der App)
const { SettingsScreen } = require('../../App');
const { GroupsScreen, GroupCreateScreen } = require('../../GroupScreens');
const SiegelScreen = require('../../SiegelScreen').default;
const { SafeAreaProvider } = require('react-native-safe-area-context');

const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
// Sichtbare Texte und Platzhalter (FlatList-Props enthalten Zyklen, daher kein JSON).
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
  return out.join(' | ');
}
const de = I.getTable('de');

// Laengere deutsche Quelltexte, die in der Zielsprache anders lauten - keiner
// davon darf im gerenderten Baum auftauchen.
function germanSentences(lang) {
  const tbl = I.getTable(lang);
  return Object.entries(de)
    .filter(([k, v]) => typeof v === 'string' && v.length > 14 && !/[{\n"]/.test(v) && tbl[k] !== v)
    .map(([, v]) => v);
}
function expectNoGerman(tree, lang) {
  const s = textOf(tree);
  const sentences = germanSentences(lang);
  expect(sentences.length).toBeGreaterThan(300);
  expect(sentences.filter(v => s.includes(v))).toEqual([]);
}

async function render(el) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics }, el));
  });
  await renderer.act(async () => { await new Promise(r => setTimeout(r, 10)); });
  return tree;
}
const settings = (onLanguageChange = () => {}) => React.createElement(SettingsScreen, {
  onBack: () => {}, onDesignChange: async () => ({ ok: true }), onBgChange: () => {}, onFontChange: () => {},
  currentBg: 'theme', currentFont: 'normal', username: 'Test', onWipeAll: () => {}, onLanguageChange,
});

let warnSpy, logSpy;
beforeAll(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => { warnSpy.mockRestore(); logSpy.mockRestore(); I._resetI18nForTests(); });
beforeEach(async () => {
  await EncryptedStorage.clear();
  T._resetThemesForTests();
  I._resetI18nForTests();
});

test('Deutsch (Standard): Eintrag "Sprache" zeigt "System · Deutsch"', async () => {
  const tree = await render(settings());
  const s = textOf(tree);
  expect(s).toContain('Einstellungen');
  expect(s).toContain('Sprache');
  expect(s).toContain('System · Deutsch');
  await renderer.act(async () => tree.unmount());
});

describe.each([
  ['en', { settings: 'Settings', section: 'LANGUAGE', groupsEmpty: 'No groups yet.', newGroup: 'New group', siegel: 'Set up Siegel' }],
  ['ar', { settings: 'الإعدادات', section: 'اللغة', groupsEmpty: 'لا توجد مجموعات بعد.', newGroup: 'مجموعة جديدة', siegel: 'إعداد Siegel' }],
])('%s', (lang, exp) => {
  beforeEach(() => { I.setLanguage(lang); });

  test('Einstellungen: uebersetzt, Sprachauswahl mit allen Sprachen und Hinweis', async () => {
    const onLanguageChange = jest.fn();
    const tree = await render(settings(onLanguageChange));
    let s = textOf(tree);
    expect(s).toContain(exp.settings);
    expect(s).toContain(I.t('settings.language'));
    expect(s).toContain(I.languageName(lang));
    expect(s).not.toContain('Einstellungen');
    expectNoGerman(tree, lang);

    await renderer.act(async () => { tree.root.find((n) => n.props.testID === 'settings-language' && typeof n.props.onPress === 'function').props.onPress(); });
    s = textOf(tree);
    for (const l of I.LANGUAGES) expect(s).toContain(l.name);
    expect(s).toContain(I.t('settings.language.system'));
    expect(s).toContain(I.t('settings.language.disclaimer'));
    await renderer.act(async () => { tree.root.findByProps({ testID: 'language-system' }).props.onPress(); });
    expect(onLanguageChange).toHaveBeenCalledWith('system');
    await renderer.act(async () => tree.unmount());
  });

  test('Gruppen: leere Liste und Anlage', async () => {
    let tree = await render(React.createElement(GroupsScreen, { groups: [], onBack() {}, onCreate() {}, onOpenGroup() {} }));
    expect(textOf(tree)).toContain(exp.groupsEmpty);
    expectNoGerman(tree, lang);
    await renderer.act(async () => tree.unmount());

    tree = await render(React.createElement(GroupCreateScreen, { contacts: [{ id: 'c1', name: 'Bob' }], onBack() {}, onCreate() {} }));
    expect(textOf(tree)).toContain(exp.newGroup);
    expectNoGerman(tree, lang);
    await renderer.act(async () => tree.unmount());
  });

  test('Siegel: Einrichtung', async () => {
    const tree = await render(React.createElement(SiegelScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4' }));
    expect(textOf(tree)).toContain(exp.siegel);
    expectNoGerman(tree, lang);
    await renderer.act(async () => tree.unmount());
  });
});
