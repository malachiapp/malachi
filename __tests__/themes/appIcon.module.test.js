// "App-Icon passend zum Design": JS-Huelle des nativen Moduls (AppIcon.js),
// Zuordnung Design -> Icon (AppIconVariants.js), Umschalten nur beim
// Verlassen der App (entprellt), Speichern des Schalters in 'settings' und der
// Schalter in den Design-Einstellungen (DesignSection.tsx / SettingsScreen).
const React = require('react');
const renderer = require('react-test-renderer');
const { Text, NativeModules, Switch } = require('react-native');

const mockConfig = { STUN_HOST: 'stun.invalid', STUN_URL: 'stun:stun.invalid:3478', LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const T = require('../../Themes');
const V = require('../../AppIconVariants');
const AI = require('../../AppIcon');
const AppFocus = require('../../AppFocus');
const DesignSection = require('../../DesignSection').default;
const { SettingsScreen } = require('../../App');
const { SafeAreaProvider } = require('react-native-safe-area-context');

const storage = { getItem: (k) => EncryptedStorage.getItem(k), setItem: (k, v) => EncryptedStorage.setItem(k, v) };
const stored = async () => JSON.parse(await EncryptedStorage.getItem('settings'));
const textOf = (tree) => JSON.stringify(tree.toJSON());
const Badge = () => React.createElement(Text, null, 'PRO');
const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function installNative(impl = {}) {
  const native = {
    setIcon: jest.fn(async (id) => id),
    getIcon: jest.fn(async () => 'klassik'),
    ...impl,
  };
  NativeModules.MalachiAppIcon = native;
  return native;
}
function fakeAppState() {
  const s = { handler: null, removed: false };
  s.addEventListener = jest.fn((ev, fn) => { if (ev === 'change') s.handler = fn; return { remove: () => { s.removed = true; } }; });
  s.emit = (state) => s.handler && s.handler(state);
  return s;
}

let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });
beforeEach(async () => {
  delete NativeModules.MalachiAppIcon;
  await EncryptedStorage.clear();
  T._resetThemesForTests();
  AppFocus._resetAppFocusForTests();
});
afterEach(() => { delete NativeModules.MalachiAppIcon; });

describe('Zuordnung Design -> Icon', () => {
  test('jedes Pro-Design hat sein Icon, jede kostenlose Akzentfarbe ihres, Cyan = Marken-Icon', () => {
    for (const p of T.PRO_THEMES) expect(V.iconVariantForTheme(T.resolveTheme({ themeId: p.id }, true))).toBe(p.id);
    for (const a of T.FREE_ACCENTS) {
      const want = a.key === 'cyan' ? 'klassik' : 'klassik_' + a.key;
      expect(V.iconVariantForTheme(T.resolveTheme({ themeId: 'klassik', accentKey: a.key }))).toBe(want);
      // "Kopfleiste und Menue einfaerben" aendert das Icon nicht
      expect(V.iconVariantForTheme(T.resolveTheme({ themeId: 'klassik', accentKey: a.key, tintChrome: true }))).toBe(want);
    }
  });

  test('Pro-Design ohne Lizenz -> Standard-Icon (mit der kostenlosen Akzentfarbe), nie ein Pro-Icon', () => {
    expect(V.iconVariantForTheme(T.resolveTheme({ themeId: 'bordeaux', accentKey: 'gold' }, false))).toBe('klassik_gold');
    expect(V.iconVariantForTheme(T.resolveTheme({ themeId: 'bordeaux' }, false))).toBe('klassik');
  });

  test('Schalter aus -> immer das Standard-Icon; Unbekanntes faellt auf Standard zurueck', () => {
    const th = T.resolveTheme({ themeId: 'graphit' }, true);
    expect(V.desiredIconVariant({ appIcon: false }, th)).toBe('klassik');
    expect(V.desiredIconVariant({}, th)).toBe('klassik');
    expect(V.desiredIconVariant({ appIcon: true }, th)).toBe('graphit');
    expect(V.iconVariantForTheme({ id: 'gibtsnicht' })).toBe('klassik');
    expect(V.iconVariantForTheme(null)).toBe('klassik');
  });
});

describe('JS-Huelle des nativen Moduls', () => {
  test('ohne natives Modul: alles No-op, kein Fehler', async () => {
    expect(AI.isAppIconSupported()).toBe(false);
    expect(await AI.setAppIcon('graphit')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await AI.getAppIcon()).toBeNull();
    const app = fakeAppState();
    const stop = AI.startAppIconSync({ appState: app });
    expect(typeof stop).toBe('function');
    expect(app.addEventListener).not.toHaveBeenCalled();
    await stop.flush();
    stop();
  });

  test('prueft Ids gegen die feste Liste - Unbekanntes erreicht das native Modul nie', async () => {
    const native = installNative();
    for (const bad of ['gibtsnicht', '', null, undefined, 42, 'KLASSIK', 'klassik_cyan', '../MainActivity', 'com.securecommapp.MainActivity']) {
      expect(await AI.setAppIcon(bad)).toEqual({ ok: false, reason: 'unknown' });
    }
    expect(native.setIcon).not.toHaveBeenCalled();
    expect(await AI.setAppIcon('lagune')).toEqual({ ok: true, icon: 'lagune' });
    expect(native.setIcon).toHaveBeenCalledWith('lagune');
  });

  test('Fehler im Modul -> { ok:false, reason:"native" }; getIcon liefert nur bekannte Ids', async () => {
    installNative({ setIcon: jest.fn(async () => { throw new Error('boom'); }), getIcon: jest.fn(async () => 'fremd') });
    expect(await AI.setAppIcon('onyx')).toEqual({ ok: false, reason: 'native' });
    expect(await AI.getAppIcon()).toBeNull();
    installNative({ getIcon: jest.fn(async () => 'marine') });
    expect(await AI.getAppIcon()).toBe('marine');
  });
});

describe('Nachfuehren (startAppIconSync)', () => {
  test('wechselt erst beim Verlassen der App, entprellt: nur die letzte Wahl zaehlt', async () => {
    const native = installNative();
    const app = fakeAppState();
    const stop = AI.startAppIconSync({ appState: app });
    // vor dem Laden der gespeicherten Wahl: nichts
    app.emit('background'); await stop.flush();
    expect(native.setIcon).not.toHaveBeenCalled();

    T.restoreThemeSelection({ appIcon: true, accentKey: 'coral' });
    T.setThemeSelection({ accentKey: 'mint' });
    T.setThemeSelection({ accentKey: 'gold' });
    app.emit('active'); await stop.flush();
    expect(native.setIcon).not.toHaveBeenCalled();     // im Vordergrund nie
    app.emit('background'); await stop.flush();
    expect(native.setIcon.mock.calls).toEqual([['klassik_gold']]);
    // unveraendert -> kein erneuter Aufruf
    app.emit('active'); app.emit('background'); await stop.flush();
    expect(native.setIcon).toHaveBeenCalledTimes(1);

    T.setThemeSelection({ themeId: 'artwork' }, { pro: true });
    app.emit('background'); await stop.flush();
    expect(native.setIcon).toHaveBeenLastCalledWith('artwork');

    // Schalter aus -> zurueck auf das Standard-Icon
    T.setThemeSelection({ appIcon: false });
    app.emit('background'); await stop.flush();
    expect(native.setIcon).toHaveBeenLastCalledWith('klassik');
    expect(native.setIcon).toHaveBeenCalledTimes(3);

    stop();
    expect(app.removed).toBe(true);
  });

  test('gespeichertes Pro-Design: wartet auf die Lizenzpruefung statt kurz auf Standard zu springen', async () => {
    const native = installNative();
    const app = fakeAppState();
    let loaded = false;
    const stop = AI.startAppIconSync({ appState: app, licenseLoaded: () => loaded });
    T.restoreThemeSelection(T.selectionFromSettings({ themeId: 'bordeaux', appIcon: true }));
    app.emit('background'); await stop.flush();
    expect(native.setIcon).not.toHaveBeenCalled();
    loaded = true; T.setThemeProUnlocked(true);
    app.emit('background'); await stop.flush();
    expect(native.setIcon.mock.calls).toEqual([['bordeaux']]);
    // Lizenz ungueltig geworden -> App zeigt Standard, Icon folgt
    T.setThemeProUnlocked(false);
    app.emit('background'); await stop.flush();
    expect(native.setIcon).toHaveBeenLastCalledWith('klassik');
    stop();
  });

  test('Loeschen aller Daten (Wipe) setzt Design und Schalter zurueck -> Standard-Icon', async () => {
    const native = installNative();
    const app = fakeAppState();
    const stop = AI.startAppIconSync({ appState: app });
    T.restoreThemeSelection(T.selectionFromSettings({ themeId: 'onyx', appIcon: true }));
    T.setThemeProUnlocked(true);
    app.emit('background'); await stop.flush();
    expect(native.setIcon).toHaveBeenLastCalledWith('onyx');
    // wie wipeAllLocalData in App.tsx
    T.restoreThemeSelection(T.selectionFromSettings(null));
    expect(T.getThemeSelection().appIcon).toBe(false);
    app.emit('background'); await stop.flush();
    expect(native.setIcon).toHaveBeenLastCalledWith('klassik');
    stop();
  });

  test('nicht waehrend eines Systemdialogs (Galerie/Dateiauswahl) oder Anrufs - dann beim naechsten Verlassen', async () => {
    const native = installNative();
    const app = fakeAppState();
    let inCall = false;
    const stop = AI.startAppIconSync({ appState: app, busy: () => inCall });
    T.restoreThemeSelection({ appIcon: true, accentKey: 'lilac' });
    let release;
    const picker = AppFocus.withAutoLockSuspended(() => new Promise(r => { release = r; }));
    app.emit('background'); await stop.flush();
    expect(native.setIcon).not.toHaveBeenCalled();
    release(); await picker;
    inCall = true;
    app.emit('active'); app.emit('background'); await stop.flush();
    expect(native.setIcon).not.toHaveBeenCalled();
    inCall = false;
    app.emit('active'); app.emit('background'); await stop.flush();
    expect(native.setIcon.mock.calls).toEqual([['klassik_lilac']]);
    stop();
  });

  test('fehlgeschlagener Wechsel wird beim naechsten Verlassen wiederholt', async () => {
    let fail = true;
    const native = installNative({ setIcon: jest.fn(async (id) => { if (fail) throw new Error('x'); return id; }) });
    const app = fakeAppState();
    const stop = AI.startAppIconSync({ appState: app });
    T.restoreThemeSelection({ appIcon: true, accentKey: 'rose' });
    app.emit('background'); await stop.flush();
    fail = false;
    app.emit('background'); await stop.flush();
    expect(native.setIcon.mock.calls).toEqual([['klassik_rose'], ['klassik_rose']]);
    stop();
  });
});

describe('Schalter speichern (settings)', () => {
  test('Voreinstellung aus; an/aus wird gespeichert und nach "Neustart" wiederhergestellt', async () => {
    expect(T.getThemeSelection().appIcon).toBe(false);
    expect(T.selectionFromSettings(null).appIcon).toBe(false);
    for (const junk of ['ja', 1, 'true', null]) expect(T.selectionFromSettings({ appIcon: junk }).appIcon).toBe(false);

    await EncryptedStorage.setItem('settings', JSON.stringify({ fontSize: 18, lockDesign: false }));
    T.restoreThemeSelection(T.selectionFromSettings(await EncryptedStorage.getItem('settings')));   // App-Start
    expect(T.getThemeSelection().appIcon).toBe(false);   // fehlt in alten Einstellungen -> aus
    expect((await T.chooseDesign({ appIcon: true }, { storage, isProVerified: async () => false })).ok).toBe(true);
    expect(await stored()).toEqual({ fontSize: 18, themeId: 'klassik', accentColor: '#0A7EA4', tintChrome: false, lockDesign: false, appIcon: true });

    T._resetThemesForTests();
    expect(T.isThemeSelectionSettled()).toBe(false);
    T.restoreThemeSelection(T.selectionFromSettings(await EncryptedStorage.getItem('settings')));
    expect(T.isThemeSelectionSettled()).toBe(true);
    expect(T.getThemeSelection().appIcon).toBe(true);
    expect(T.getThemeSelection().lockDesign).toBe(false);

    await T.chooseDesign({ appIcon: false }, { storage, isProVerified: async () => false });
    expect((await stored()).appIcon).toBe(false);
  });
});

describe('Schalter in den Design-Einstellungen', () => {
  async function renderSection(props) {
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(DesignSection, { ProBadge: Badge, pro: false, onOpenPro: jest.fn(), ...props }));
    });
    return tree;
  }

  test('Zeile mit ehrlichem Hinweis, Voreinstellung aus, Umschalten geht an onChoose', async () => {
    const onChoose = jest.fn(async () => ({ ok: true }));
    const tree = await renderSection({ onChoose, appIconAvailable: true });
    const t = textOf(tree);
    expect(t).toContain('App-Icon passend zum Design');
    expect(t).toContain('Manche Startbildschirme entfernen beim Wechsel kurz das Symbol – dann neu auf den Startbildschirm ziehen.');
    const row = tree.root.find(n => n.props.testID === 'design-app-icon' && typeof n.props.onPress === 'function');
    const sw = row.findByType(Switch);
    expect(sw.props.value).toBe(false);
    await renderer.act(async () => { row.props.onPress(); });
    expect(onChoose).toHaveBeenLastCalledWith({ appIcon: true });
    await renderer.act(async () => { sw.props.onValueChange(true); });
    expect(onChoose).toHaveBeenLastCalledWith({ appIcon: true });
    await renderer.act(async () => tree.unmount());
  });

  test('an: Schalter zeigt an; Hinweis auf Sichtbarkeit nur bei Pro-Design und "Sperrbildschirm im Design" aus', async () => {
    const onChoose = jest.fn(async () => ({ ok: true }));
    T.setThemeSelection({ appIcon: true });
    let tree = await renderSection({ onChoose, appIconAvailable: true });
    const sw = tree.root.find(n => n.props.testID === 'design-app-icon' && typeof n.props.onPress === 'function').findByType(Switch);
    expect(sw.props.value).toBe(true);
    await renderer.act(async () => { sw.props.onValueChange(false); });
    expect(onChoose).toHaveBeenLastCalledWith({ appIcon: false });
    expect(tree.root.findAllByProps({ testID: 'design-app-icon-hint' })).toHaveLength(0);
    await renderer.act(async () => tree.unmount());

    T.setThemeSelection({ themeId: 'marine', lockDesign: false }, { pro: true });
    tree = await renderSection({ onChoose, pro: true, appIconAvailable: true });
    expect(textOf(tree)).toContain('ein Design der Vollversion verrät sie dort');
    await renderer.act(async () => tree.unmount());
  });

  test('ohne natives Modul (iOS, alter Build) keine Zeile', async () => {
    let tree = await renderSection({ onChoose: jest.fn() });
    expect(tree.root.findAllByProps({ testID: 'design-app-icon' })).toHaveLength(0);
    await renderer.act(async () => tree.unmount());
    tree = await renderSection({ onChoose: jest.fn(), appIconAvailable: false });
    expect(tree.root.findAllByProps({ testID: 'design-app-icon' })).toHaveLength(0);
    await renderer.act(async () => tree.unmount());
  });

  test('Einstellungen (SettingsScreen, Android-Build): Schalter sichtbar und wird gespeichert', async () => {
    installNative();
    const onDesignChange = jest.fn((patch) => T.chooseDesign(patch, { storage, isProVerified: async () => false }));
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
        React.createElement(SettingsScreen, { onBack: () => {}, onDesignChange, onBgChange: () => {}, onFontChange: () => {},
          currentBg: 'theme', currentFont: 'normal', username: 'Test', onWipeAll: () => {} })));
    });
    await renderer.act(async () => {
      tree.root.find(n => n.props.testID === 'settings-group-design' && typeof n.props.onPress === 'function').props.onPress();
    });
    expect(textOf(tree)).toContain('App-Icon passend zum Design');
    await renderer.act(async () => {
      tree.root.find(n => n.props.testID === 'design-app-icon' && typeof n.props.onPress === 'function').props.onPress();
    });
    expect(onDesignChange).toHaveBeenCalledWith({ appIcon: true });
    expect((await stored()).appIcon).toBe(true);
    expect(T.getThemeSelection().appIcon).toBe(true);
    await renderer.act(async () => tree.unmount());
  });
});
