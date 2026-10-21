// Darstellungstest des Abschnitts "DESIGN" in den Einstellungen
// (DesignSection.tsx, eingebunden in SettingsScreen in App.tsx): Themen-
// Vorschau, PRO-Hinweis und Sperre fuer Gratis-Nutzer, Akzentfarben,
// "Kopfleiste und Menü einfärben" - plus Einbindung in die echten Einstellungen.
const React = require('react');
const renderer = require('react-test-renderer');
const { Text } = require('react-native');

const mockConfig = { STUN_HOST: 'stun.invalid', STUN_URL: 'stun:stun.invalid:3478', LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const T = require('../../Themes');
const DesignSection = require('../../DesignSection').default;
const { SettingsScreen, ProScreen } = require('../../App');
const { SafeAreaProvider } = require('react-native-safe-area-context');

const textOf = (tree) => JSON.stringify(tree.toJSON());
const Badge = () => React.createElement(Text, null, 'PRO');
const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });
beforeEach(async () => {
  await EncryptedStorage.clear();
  T._resetThemesForTests();
});

async function renderSection(props) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(DesignSection, { ProBadge: Badge, ...props }));
  });
  return tree;
}
const press = async (tree, testID) => {
  await renderer.act(async () => { tree.root.findByProps({ testID }).props.onPress(); });
};

test('Gratis: alle Themen als Vorschau, 21x PRO, Akzentfarben und Einfaerben-Schalter', async () => {
  const tree = await renderSection({ pro: false, onChoose: jest.fn(), onOpenPro: jest.fn() });
  const t = textOf(tree);
  expect(t).toContain('DESIGN');
  expect(t).toContain('Standard');
  for (const p of T.PRO_THEMES) expect(t).toContain(p.name);
  expect(T.PRO_THEMES).toHaveLength(21);
  expect(t.match(/"PRO"/g)).toHaveLength(T.PRO_THEMES.length);
  expect(t).toContain('21 Design-Themen mit Vollversion');
  expect(t).toContain('Akzentfarbe');
  expect(t).toContain('Kopfleiste und Menü einfärben');
  for (const a of T.FREE_ACCENTS) expect(tree.root.findAllByProps({ testID: 'design-accent-' + a.key }).length).toBeGreaterThan(0);
  await renderer.act(async () => tree.unmount());
});

test('Gratis: Antippen eines Pro-Themas oeffnet die Vollversion-Seite und waehlt NICHTS', async () => {
  const onChoose = jest.fn(async () => ({ ok: true }));
  const onOpenPro = jest.fn();
  const tree = await renderSection({ pro: false, onChoose, onOpenPro });
  for (const p of T.PRO_THEMES) await press(tree, 'design-theme-' + p.id);
  expect(onOpenPro).toHaveBeenCalledTimes(T.PRO_THEMES.length);
  expect(onChoose).not.toHaveBeenCalled();
  await renderer.act(async () => tree.unmount());
});

test('Picker nach Gruppen: Dunkel (mit Standard vorn), Hell, Business, Artwork - jedes Thema genau einmal in seiner Gruppe', async () => {
  const tree = await renderSection({ pro: false, onChoose: jest.fn(), onOpenPro: jest.fn() });
  const groups = T.themesByCategory();
  expect(groups.map(g => g.label)).toEqual(['Dunkel', 'Hell', 'Business', 'Artwork']);
  const cardIds = (node) => node.findAll(n => typeof n.props.testID === 'string' && n.props.testID.startsWith('design-theme-')
    && typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button').map(n => n.props.testID.slice('design-theme-'.length));
  for (const g of groups) {
    const box = tree.root.find(n => n.props.testID === 'design-group-' + g.key && typeof n.type !== 'string');
    // Ueberschrift der Gruppe
    expect(box.findAll(n => n.props.accessibilityRole === 'header' && n.props.children === g.label).length).toBeGreaterThan(0);
    const ids = [...new Set(cardIds(box))];
    const expected = g.themes.map(th => th.id);
    expect(ids).toEqual(g.key === 'dunkel' ? ['klassik', ...expected] : expected);
  }
  // insgesamt jede Karte genau einmal
  const all = [...new Set(cardIds(tree.root))];
  expect(all.sort()).toEqual(['klassik', ...T.PRO_THEMES.map(p => p.id)].sort());
  await renderer.act(async () => tree.unmount());
});

test('Picker: Klecks-Muster nur in der Vorschau von "Malachi Artwork", nicht bedienbar', async () => {
  const tree = await renderSection({ pro: true, onChoose: jest.fn(), onOpenPro: jest.fn() });
  const layers = tree.root.findAll(n => typeof n.type === 'string' && typeof n.props.testID === 'string' && n.props.testID.startsWith('design-artwork-'));
  expect(layers.map(n => n.props.testID)).toEqual(['design-artwork-artwork']);
  expect(layers[0].props.pointerEvents).toBe('none');
  // Antippen der Artwork-Karte waehlt das Thema (Muster faengt nichts ab)
  const onChoose = jest.fn(async () => ({ ok: true }));
  await renderer.act(async () => tree.update(React.createElement(DesignSection, { ProBadge: Badge, pro: true, onChoose, onOpenPro: jest.fn() })));
  await press(tree, 'design-theme-artwork');
  expect(onChoose).toHaveBeenCalledWith({ themeId: 'artwork' });
  await renderer.act(async () => tree.unmount());
});

test('Gratis: Akzentfarbe und Einfaerben gehen an onChoose', async () => {
  const onChoose = jest.fn(async () => ({ ok: true }));
  const tree = await renderSection({ pro: false, onChoose, onOpenPro: jest.fn() });
  await press(tree, 'design-accent-coral');
  await press(tree, 'design-tint');
  expect(onChoose).toHaveBeenCalledWith({ accentKey: 'coral' });
  expect(onChoose).toHaveBeenCalledWith({ tintChrome: true });
  await renderer.act(async () => tree.unmount());
});

test('Vollversion: keine PRO-Hinweise, Thema waehlen geht an onChoose; Ablehnung oeffnet die Vollversion-Seite', async () => {
  const onChoose = jest.fn(async () => ({ ok: false, reason: 'pro' }));
  const onOpenPro = jest.fn();
  const tree = await renderSection({ pro: true, onChoose, onOpenPro });
  expect(textOf(tree)).not.toContain('"PRO"');
  await press(tree, 'design-theme-bernstein');
  expect(onChoose).toHaveBeenCalledWith({ themeId: 'bernstein' });
  expect(onOpenPro).toHaveBeenCalledTimes(1);   // z. B. Lizenz inzwischen ungueltig
  await renderer.act(async () => tree.unmount());
});

test('aktives Pro-Thema: Hinweis statt Akzentfarben; gemerktes Thema ohne Lizenz wird erklaert', async () => {
  T.setThemeSelection({ themeId: 'gletscher' }, { pro: true });
  let tree = await renderSection({ pro: true, onChoose: jest.fn(), onOpenPro: jest.fn() });
  let t = textOf(tree);
  expect(t).toContain('fest abgestimmte');
  expect(tree.root.findAllByProps({ testID: 'design-tint' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'design-accent-cyan' })).toHaveLength(0);
  await renderer.act(async () => tree.unmount());

  T.setThemeProUnlocked(false);
  tree = await renderSection({ pro: false, onChoose: jest.fn(), onOpenPro: jest.fn() });
  t = textOf(tree);
  expect(t).toContain('Gletscher');
  expect(t).toContain('wird mit gültiger Vollversion wieder aktiv');
  expect(tree.root.findAllByProps({ testID: 'design-tint' }).length).toBeGreaterThan(0);   // angezeigt wird Standard
  await renderer.act(async () => tree.unmount());
});

test('Einstellungen (SettingsScreen): Abschnitt DESIGN eingebunden, Pro-Thema ohne Lizenz oeffnet die Vollversion', async () => {
  const onDesignChange = jest.fn(async () => ({ ok: true }));
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
      React.createElement(SettingsScreen, { onBack: () => {}, onDesignChange, onBgChange: () => {}, onFontChange: () => {},
        currentBg: 'theme', currentFont: 'normal', username: 'Test', onWipeAll: () => {} })));
  });
  // Einstellungen sind nach Kategorien eingeklappt (Nutzerwunsch 2026-10-19).
  const zu = textOf(tree);
  expect(zu).toContain('Einstellungen');
  expect(zu).toContain('Design');
  expect(zu).toContain('Sicherheit');
  expect(zu).toContain('Verbindung & Tor');
  expect(zu).not.toContain('Schriftgröße');
  expect(zu).not.toContain('Duress PIN');
  expect(zu).toContain('Alle Daten sofort löschen');      // Notfall bleibt sichtbar
  await renderer.act(async () => {
    tree.root.find((n) => n.props.testID === 'settings-group-design' && typeof n.props.onPress === 'function').props.onPress();
  });
  const t = textOf(tree);
  expect(t).not.toContain('DESIGN');                        // kein doppelter Titel
  expect(t).toContain('Chat-Hintergrund');
  expect(t).toContain('Wie Design');
  expect(t).toContain('Schriftgröße');
  expect(t).not.toContain('AUSSEHEN');
  expect(t).not.toContain('Duress PIN');                    // immer nur eine Kategorie offen
  // Andere Kategorie oeffnen schliesst Design.
  await renderer.act(async () => {
    tree.root.find((n) => n.props.testID === 'settings-group-security' && typeof n.props.onPress === 'function').props.onPress();
  });
  expect(textOf(tree)).toContain('Duress PIN');
  expect(textOf(tree)).not.toContain('Schriftgröße');
  // Bildschirmschutz: an, Abschalten nur mit Vollversion (ohne -> Vollversion-Seite).
  expect(textOf(tree)).toContain('Screenshots sperren');
  expect(textOf(tree)).toContain('An - abschalten ist Teil der Vollversion');
  expect(textOf(tree)).toContain('Screenshots gesperrt');
  await renderer.act(async () => {
    tree.root.find((n) => n.props.testID === 'settings-group-design' && typeof n.props.onPress === 'function').props.onPress();
  });
  await press(tree, 'design-theme-graphit');
  expect(onDesignChange).not.toHaveBeenCalled();
  // Vollversion-Seite ist jetzt offen und nennt die Design-Themen
  expect(textOf(tree)).toContain('Design-Themen');
  await press(tree, 'design-accent-violet');
  expect(onDesignChange).toHaveBeenCalledWith({ accentKey: 'violet' });
  await renderer.act(async () => tree.unmount());
});

test('Vollversion-Seite listet "Design-Themen"', async () => {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
      React.createElement(ProScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4' })));
  });
  expect(textOf(tree)).toContain('Design-Themen');
  await renderer.act(async () => tree.unmount());
});
