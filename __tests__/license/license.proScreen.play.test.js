// Darstellungstest der Vollversion-Seite in der GOOGLE-PLAY-Variante
// (ProScreen in App.tsx -> PlayProScreen.tsx) und der Einstellungszeile.
// Google-Play-Zahlungsrichtlinie: nirgends ein anderer Zahlungsweg - kein
// Monero, kein Bitcoin, kein Onion-Shop, kein Geraetecode, kein Lizenz-Umzug.
// Die Website-Variante testet weiterhin license.proScreen.test.js (unveraendert).
const React = require('react');
const renderer = require('react-test-renderer');
const G = require('../security/helpers/playFixtures');

const mockConfig = {
  STUN_HOST: 'stun.invalid', STUN_URL: 'stun:stun.invalid:3478', LICENSE_PUBLIC_KEY: null, SHOP_ONION: null,
  SHOP_PORT: 80, PRO_PRICE_EUR: '2,99', PLAY_LICENSE_PUBLIC_KEY: null, PLAY_PRODUCT_ID: 'malachi_pro',
};
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const LM = require('../../LicenseManager');
const T = require('../../Themes');
const { ProScreen, SettingsScreen } = require('../../App');
const { SafeAreaProvider } = require('react-native-safe-area-context');

// Alles, was auf einen Zahlungsweg an Google Play vorbei hinweisen koennte.
const FORBIDDEN = /monero|bitcoin|onion|shop|wallet|tor-browser|gerätecode|wiederherstellungscode|bestellnummer|lizenz eingeben|umziehen|\bxmr\b|\bbtc\b/i;
const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const textOf = (tree) => JSON.stringify(tree.toJSON());
const flat = (tree) => textOf(tree).replace(/","/g, '');

let KEY;
let billing;
let warnSpy;
beforeAll(() => {
  KEY = G.makeRsaKey(2048);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { warnSpy.mockRestore(); G.removePlayNativeMocks(); });

beforeEach(async () => {
  await EncryptedStorage.clear();
  T._resetThemesForTests();
  mockConfig.PLAY_LICENSE_PUBLIC_KEY = KEY.pubB64;
  billing = G.installPlayNativeMocks();
  LM._resetLicenseManagerForTests();
});

async function renderPro() {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: metrics },
        React.createElement(ProScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4' })),
    );
  });
  await renderer.act(async () => { await G.flush(); });
  return tree;
}

/** Element mit genau diesem Text antippen (naechster Vorfahre mit onPress). */
async function press(tree, text) {
  const hits = tree.root.findAll((n) => typeof n.type === 'string' && n.props && n.props.children === text);
  expect(hits.length).toBeGreaterThan(0);
  let node = hits[0];
  while (node && !(node.props && typeof node.props.onPress === 'function')) node = node.parent;
  expect(node).toBeTruthy();
  await renderer.act(async () => {
    await node.props.onPress();
    await G.flush();
  });
}

test('Play-Schluessel fehlt: "Kauf derzeit nicht verfügbar", keine fremden Zahlungswege', async () => {
  mockConfig.PLAY_LICENSE_PUBLIC_KEY = null;
  LM._resetLicenseManagerForTests();
  await LM.refreshLicense();
  const tree = await renderPro();
  const t = flat(tree);
  expect(t).toContain('Kauf derzeit nicht verfügbar');
  expect(t).toContain('Gratis-Version');
  expect(t).toContain('Notfall-PIN');
  expect(t).not.toMatch(FORBIDDEN);
  expect(t).not.toContain('Vollversion kaufen');
  await renderer.act(async () => tree.unmount());
});

test('eingerichtet: Play-Preis, "Vollversion kaufen", "Käufe wiederherstellen" - kein Shop, keine Krypto', async () => {
  await LM.refreshLicense();
  const tree = await renderPro();
  const t = flat(tree);
  expect(t).toContain('Vollversion kaufen · 2,99 €');
  expect(t).toContain('Käufe wiederherstellen');
  expect(t).toContain('Einmalig 2,99 €');
  expect(t).toContain('Google Play');
  expect(t).not.toMatch(FORBIDDEN);
  expect(t).not.toContain('Widerrufsrecht');            // Zustimmungstext des Shops gibt es hier nicht
  expect(t).not.toContain('2,99 EUR');                  // kein fester Shop-Preis

  await press(tree, 'Vollversion kaufen · 2,99 €');
  expect(billing.launchPurchase).toHaveBeenCalledWith('malachi_pro');

  // Google Play meldet den Kauf -> Seite zeigt "Vollversion aktiv"
  await renderer.act(async () => {
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
  });
  const t2 = flat(tree);
  expect(t2).toContain('Vollversion aktiv');
  expect(t2).toContain('Über Google Play gekauft am');
  expect(t2).not.toContain('Vollversion kaufen');
  // Knopf "Käufe wiederherstellen" verschwindet (der Hinweistext darf ihn weiter nennen)
  expect(tree.root.findAll((n) => typeof n.type === 'string' && n.props.children === 'Käufe wiederherstellen')).toHaveLength(0);
  expect(t2).not.toMatch(FORBIDDEN);
  await renderer.act(async () => tree.unmount());
});

test('"Käufe wiederherstellen" holt einen alten Kauf zurück', async () => {
  billing._purchases = [G.signedPurchase(KEY.privateKey, { acknowledged: true })];
  await LM.refreshLicense();
  const tree = await renderPro();
  expect(flat(tree)).toContain('Mit diesem Google-Konto wurde die Vollversion schon gekauft');
  await press(tree, 'Käufe wiederherstellen');
  const t = flat(tree);
  expect(t).toContain('Vollversion aktiv');
  expect(t).toContain('Kauf wiederhergestellt');
  await renderer.act(async () => tree.unmount());
});

test('ausstehende Zahlung: Hinweis statt Kaufknopf', async () => {
  billing._purchases = [G.signedPurchase(KEY.privateKey, { purchaseState: 4 })];
  await LM.refreshLicense();
  const tree = await renderPro();
  const t = flat(tree);
  expect(t).toContain('Die Zahlung ist noch nicht abgeschlossen');
  expect(t).toContain('Status jetzt prüfen');
  expect(t).not.toContain('Vollversion kaufen');
  expect(t).not.toMatch(FORBIDDEN);
  await renderer.act(async () => tree.unmount());
});

test('erstatteter Kauf: Hinweis am Status', async () => {
  await EncryptedStorage.setItem(LM.PLAY_STORAGE_KEY, JSON.stringify({ v: 1, tokenHash: 'a'.repeat(64), productId: 'malachi_pro', purchaseTime: 1, verifiedAt: 1 }));
  await LM.refreshLicense();
  const tree = await renderPro();
  expect(flat(tree)).toContain('nicht mehr vorhanden (z. B. erstattet)');
  await renderer.act(async () => tree.unmount());
});

test('Einstellungen: Zeile "Vollversion" mit Play-Preis, nirgends Shop/Krypto', async () => {
  await LM.refreshLicense();
  await G.flush();
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
      React.createElement(SettingsScreen, { onBack: () => {}, onDesignChange: async () => ({ ok: true }), onBgChange: () => {}, onFontChange: () => {},
        currentBg: 'theme', currentFont: 'normal', username: 'Test', onWipeAll: () => {} })));
  });
  const t = flat(tree);
  expect(t).toContain('Vollversion');
  expect(t).toContain('2,99 €');
  expect(t).not.toContain('2,99 EUR');
  expect(t).not.toMatch(/monero|bitcoin|onion-shop|shop|wallet|tor-browser/i);
  // Vollversion-Seite aus den Einstellungen oeffnen: Play-Seite
  await press(tree, 'Vollversion');
  const t2 = flat(tree);
  expect(t2).toContain('Vollversion kaufen · 2,99 €');
  expect(t2).not.toMatch(FORBIDDEN);
  await renderer.act(async () => tree.unmount());
});
