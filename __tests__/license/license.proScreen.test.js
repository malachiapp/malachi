// Darstellungstest der Vollversion-Seite (ProScreen in App.tsx): rendert in
// allen Zustaenden ohne Fehler und zeigt die geforderten Inhalte
// (Kauf nicht verfuegbar, Kaufknopf mit Zustimmung, offene Bestellung mit
// Adresse/Betrag/QR und GROSSEM Wiederherstellungscode, Vollversion aktiv).
const React = require('react');
const renderer = require('react-test-renderer');
const F = require('../security/helpers/licenseFixtures');

const mockConfig = { STUN_HOST: 'stun.invalid', STUN_URL: 'stun:stun.invalid:3478', LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const LM = require('../../LicenseManager');
const { ProScreen } = require('../../App');
const { SafeAreaProvider } = require('react-native-safe-area-context');

let tor;
const textOf = (tree) => JSON.stringify(tree.toJSON());

async function render() {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(
      React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
        React.createElement(ProScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4' })),
    );
  });
  return tree;
}

// SecretTrace.js (von App.tsx geladen) meldet jedes EncryptedStorage.clear()
// per console.warn - hier nur Rauschen.
let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });

beforeEach(async () => {
  await EncryptedStorage.clear();
  LM._resetLicenseManagerForTests();
  ({ tor } = F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 }));
  LM.configureLicenseManager({ ensureTor: async () => true });
});

test('vor dem Shop-Deployment: "Kauf derzeit nicht verfuegbar"', async () => {
  mockConfig.LICENSE_PUBLIC_KEY = null;
  mockConfig.SHOP_ONION = null;
  await LM.refreshLicense();
  const tree = await render();
  const t = textOf(tree);
  expect(t).toContain('Kauf derzeit nicht verfügbar');
  expect(t).toContain('Gratis-Version');
  expect(t).toContain('Notfall-PIN');
  await renderer.act(async () => tree.unmount());
});

test('Shop eingerichtet: Zustimmung + Kaufknopf mit Preis', async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  await LM.refreshLicense();
  const tree = await render();
  const t = textOf(tree);
  expect(t).toContain('Mit Monero kaufen · 2,99 EUR');
  expect(t).toContain('Widerrufsrecht');
  await renderer.act(async () => tree.unmount());
});

test('offene Bestellung: Adresse, Betrag, QR-Code und grosser Wiederherstellungscode', async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  await LM.refreshLicense();
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
  await LM.startPurchase({ consent: true });
  tor.httpRequest.mockResolvedValue(F.httpOk(200, F.apiOrder()));
  const tree = await render();
  const t = textOf(tree);
  expect(t).toContain(F.XMR_ADDRESS);
  expect(t).toContain('0.006149');
  expect(t).toContain('ABCD-EFGH-JKMN-PQRS-TVWX');
  expect(t).toContain('aufschreiben');
  expect(t).toContain('Warte auf deine Zahlung');
  await renderer.act(async () => tree.unmount());
});

test('Vollversion aktiv', async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
  await LM.refreshLicense();
  const tree = await render();
  const t = textOf(tree);
  expect(t).toContain('Vollversion aktiv');
  expect(t).toContain('MA1A-CH1T-EST0-0001');
  expect(t).not.toContain('Mit Monero kaufen');
  await renderer.act(async () => tree.unmount());
});

// ── Bitcoin als zweite Zahlungsart ─────────────────────────────────────────

const { CONSENT_TEXT } = require('../../ShopClient');
const tick = () => new Promise((r) => setTimeout(r, 0));
// Benachbarte Textteile zusammenfuegen ("AN DIESE ","BITCOIN","-ADRESSE" -> ein Text).
const flat = (tree) => textOf(tree).replace(/","/g, '');

/** Element mit genau diesem Text antippen (naechster Vorfahre mit onPress). */
async function press(tree, text) {
  const hits = tree.root.findAll((n) => typeof n.type === 'string' && n.props && n.props.children === text);
  expect(hits.length).toBeGreaterThan(0);
  let node = hits[0];
  while (node && !(node.props && typeof node.props.onPress === 'function')) node = node.parent;
  expect(node).toBeTruthy();
  await renderer.act(async () => {
    await node.props.onPress();
    await tick();
  });
}

const shopReady = async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  await LM.refreshLicense();
};

test('Shop bietet Monero und Bitcoin: Auswahl, neutraler Hinweis, Kauf mit Bitcoin zeigt Betrag, Adresse und QR-Code', async () => {
  await shopReady();
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo()));
  await LM.loadShopPaymentMethods();
  const tree = await render();
  let t = flat(tree);
  expect(t).toContain('BEZAHLEN MIT');
  expect(t).toContain('Mit Monero kaufen · 2,99 EUR');          // Vorgabe des Shops: Monero
  expect(t).toContain('Bezahlt wird mit Monero oder Bitcoin direkt in der App über Tor');
  expect(t).not.toContain('öffentlich sichtbar');

  await press(tree, 'Bitcoin');
  t = flat(tree);
  expect(t).toContain('Mit Bitcoin kaufen · 2,99 EUR');
  expect(t).toContain('Zahlungen sind in der Bitcoin-Blockchain öffentlich sichtbar; Monero ist privater.');

  await press(tree, CONSENT_TEXT);
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrderBtc(), recoveryCode: F.RECOVERY_CODE }));
  await press(tree, 'Mit Bitcoin kaufen · 2,99 EUR');
  const call = tor.httpRequest.mock.calls[tor.httpRequest.mock.calls.length - 1];
  expect(call[3]).toBe('/api/v1/orders');
  expect(JSON.parse(call[4])).toEqual({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' });

  t = flat(tree);
  expect(t).toContain(F.BTC_ADDRESS);
  expect(t).toContain('0.00004087 BTC');
  expect(t).toContain('AN DIESE BITCOIN-ADRESSE');
  expect(t).toContain('Adresse kopieren');
  expect(t).toContain('Betrag kopieren');
  expect(t).toContain('Warte auf deine Zahlung');
  expect(t).not.toContain('XMR');
  const qr = tree.root.findAll((n) => n.props && n.props.value === 'bitcoin:' + F.BTC_ADDRESS + '?amount=0.00004087');
  expect(qr.length).toBeGreaterThan(0);
  await renderer.act(async () => tree.unmount());
});

test('Shop bietet nur Bitcoin: keine Auswahl, Kaufknopf mit Bitcoin', async () => {
  await shopReady();
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo([{ id: 'btc', currency: 'BTC', name: 'Bitcoin' }], { defaultPaymentMethod: 'btc' })));
  await LM.loadShopPaymentMethods();
  const tree = await render();
  const t = flat(tree);
  expect(t).not.toContain('BEZAHLEN MIT');
  expect(t).toContain('Mit Bitcoin kaufen · 2,99 EUR');
  expect(t).toContain('Zahlungen sind in der Bitcoin-Blockchain öffentlich sichtbar.');
  expect(t).not.toContain('Monero ist privater');
  await renderer.act(async () => tree.unmount());
});

test('Zahlungsarten nicht abrufbar: es bleibt bei Monero ohne Auswahl', async () => {
  await shopReady();
  const tree = await render();
  await renderer.act(async () => { await tick(); });
  expect(tor.httpRequest.mock.calls.some((c) => c[3] === '/api/v1/info')).toBe(true);
  const t = flat(tree);
  expect(t).not.toContain('BEZAHLEN MIT');
  expect(t).toContain('Mit Monero kaufen · 2,99 EUR');
  await renderer.act(async () => tree.unmount());
});

test('offene Bitcoin-Bestellung: unterzahlt mit fehlendem Betrag in BTC, unbestaetigt mit Bitcoin-Text', async () => {
  await shopReady();
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrderBtc(), recoveryCode: F.RECOVERY_CODE }));
  await LM.startPurchase({ consent: true, paymentMethod: 'btc' });
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'underpaid', received: '0.00002000', missing: '0.00002087' })));
  await LM.checkPurchase();
  let tree = await render();
  let t = flat(tree);
  expect(t).toContain('Teilzahlung erhalten - es fehlen noch 0.00002087 BTC');
  expect(t).toContain('0.00002087 BTC');
  expect(tree.root.findAll((n) => n.props && n.props.value === 'bitcoin:' + F.BTC_ADDRESS + '?amount=0.00002087').length).toBeGreaterThan(0);
  await renderer.act(async () => tree.unmount());

  tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'unconfirmed', confirmations: 0, missing: '0.00000000' })));
  await LM.checkPurchase();
  tree = await render();
  t = flat(tree);
  expect(t).toContain('Bestätigung im Bitcoin-Netz');
  expect(t).not.toContain('AN DIESE BITCOIN-ADRESSE');      // Zahlung unterwegs: keine Zahlungsdaten mehr
  await renderer.act(async () => tree.unmount());
});

test('Vertrag widerrufen: Knopf -> freiwillige Angaben -> "Widerruf bestaetigen" -> Eingangsbestaetigung', async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  await LM.refreshLicense();
  tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
  await LM.startPurchase({ consent: true });
  await LM.acknowledgeRecoveryCode();
  tor.httpRequest.mockResolvedValue(F.httpOk(200, F.apiOrder()));
  const tree = await render();
  const findText = (s) => tree.root.findAll((n) => n.props && typeof n.props.children === 'string' && n.props.children === s);
  const press = async (s) => {
    const textNode = findText(s).pop();
    expect(textNode).toBeTruthy();
    let n = textNode;
    while (n && !(n.props && typeof n.props.onPress === 'function')) n = n.parent;
    await renderer.act(async () => { n.props.onPress(); });
  };
  expect(textOf(tree)).toContain('Vertrag widerrufen');
  await press('Vertrag widerrufen');
  expect(textOf(tree)).toContain('Widerruf bestätigen');

  const receipt = 'Eingangsbestätigung Ihres Widerrufs\n\nHiermit widerrufe ich ...';
  tor.httpRequest.mockImplementation(async (host, port, method, pfad, body) => {
    if (method === 'POST' && pfad === `/api/v1/orders/${F.ORDER_ID}/withdraw`) {
      const b = JSON.parse(body);
      expect(b).toEqual({ recoveryCode: F.RECOVERY_CODE, confirm: true });   // freiwillige Felder leer -> nicht gesendet
      const { address, amount, amountXmr, paymentUri, ...rest } = F.apiOrder();
      return F.httpOk(200, { ...rest, status: 'withdrawn', withdrawnAt: '2026-10-19T18:00:00.000Z', received: '0.000000', receipt, refundAddress: null, newWithdrawal: true });
    }
    return F.httpOk(200, F.apiOrder());
  });
  await press('Widerruf bestätigen');
  const t = textOf(tree);
  expect(LM.getLicenseState().purchase.order.status).toBe('withdrawn');
  expect(t).toContain('Eingangsbestätigung Ihres Widerrufs');
  expect(t).toContain('Eingangsbestätigung teilen / speichern');
  expect(t).not.toContain('Widerruf bestätigen');
  await renderer.act(async () => tree.unmount());
});
