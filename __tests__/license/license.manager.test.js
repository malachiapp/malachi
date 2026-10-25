// LicenseManager.js: Geraetebindung, lokale Pruefung mit eingebautem Schluessel,
// Speicherung, Kauf/Statusabfrage/Umzug ueber den (gemockten) Tor-HTTP-Weg,
// Persistenz der laufenden Bestellung und die Freischaltregeln (Gating).
const fs = require('fs');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519.js');
const F = require('../security/helpers/licenseFixtures');

const mockConfig = { LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const L = require('../../LicenseFormat');
const LM = require('../../LicenseManager');
const { ShopError } = require('../../ShopClient');

const roh = (text) => F.signRaw(text, { ed25519, asciiBytes: L.asciiBytes, base64urlKodieren: L.base64urlKodieren });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let deviceKey;
let tor;
let ensureTor;

beforeEach(async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  await EncryptedStorage.clear();
  LM._resetLicenseManagerForTests();
  ({ deviceKey, tor } = F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 }));
  ensureTor = jest.fn(async () => true);
  LM.configureLicenseManager({ ensureTor });
});

async function expectRejectCode(promise, code) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(err.code).toBe(code);
  return err;
}

describe('Lizenzpruefung mit den Testvektoren', () => {
  test.each([
    ['gueltig (Lizenz A, Geraet A)', F.LIZENZ_A, F.GERAET_A, true, undefined],
    ['falsches Geraet', F.LIZENZ_A, F.GERAET_B, false, 'anderes-geraet'],
    ['manipulierte Nutzlast', (() => {
      const [p, , s] = F.LIZENZ_A.split('.');
      return `${p}.${L.base64urlKodieren(L.asciiBytes(F.JSON_A.replace('"iat":1790000000', '"iat":1790000001')))}.${s}`;
    })(), F.GERAET_A, false, 'signatur'],
    ['falsches Praefix', 'ML2.' + F.LIZENZ_A.slice(4), F.GERAET_A, false, 'format'],
    ['fehlendes "pro"', roh(F.JSON_A.replace('["pro"]', '["basis"]')), F.GERAET_A, false, 'feature'],
    ['Leerraum am Rand ist erlaubt', '  ' + F.LIZENZ_A + '\n', F.GERAET_A, true, undefined],
  ])('%s', (_n, text, dev, gueltig, grund) => {
    const r = LM.verifyLicense(text, dev);
    expect(r.gueltig).toBe(gueltig);
    if (!gueltig) expect(r.grund).toBe(grund);
  });

  test('falscher Schluessel eingebaut -> signatur', () => {
    mockConfig.LICENSE_PUBLIC_KEY = L.base64urlKodieren(ed25519.getPublicKey(F.hexToBytes('22'.repeat(32))));
    expect(LM.verifyLicense(F.LIZENZ_A, F.GERAET_A)).toEqual({ gueltig: false, grund: 'signatur' });
  });

  test('Schluesselliste (Schluesselwechsel): einer muss passen; ungueltige Eintraege werden ignoriert', () => {
    const other = L.base64urlKodieren(ed25519.getPublicKey(F.hexToBytes('22'.repeat(32))));
    mockConfig.LICENSE_PUBLIC_KEY = ['kaputt', other, F.TEST_PUBLIC_B64URL, 42];
    expect(LM.builtinLicenseKeys()).toHaveLength(2);
    expect(LM.verifyLicense(F.LIZENZ_A, F.GERAET_A).gueltig).toBe(true);
  });

  test('ohne eingebauten Schluessel ist keine Lizenz gueltig', () => {
    mockConfig.LICENSE_PUBLIC_KEY = null;
    expect(LM.verifyLicense(F.LIZENZ_A, F.GERAET_A)).toEqual({ gueltig: false, grund: 'nicht-konfiguriert' });
  });

  test('ohne Geraetecode wird NIE ohne Geraetebindung geprueft', () => {
    expect(LM.verifyLicense(F.LIZENZ_A, undefined)).toEqual({ gueltig: false, grund: 'kein-geraeteschluessel' });
    expect(LM.verifyLicense(F.LIZENZ_A, '')).toEqual({ gueltig: false, grund: 'kein-geraeteschluessel' });
    expect(LM.verifyLicense(F.LIZENZ_A, 'lj5hrtfeud2cbwn4mk5wnhb4e5m6hh3se3')).toEqual({ gueltig: false, grund: 'kein-geraeteschluessel' });
  });
});

describe('Start: gespeicherte Lizenz wird vollstaendig geprueft', () => {
  test('keine Lizenz -> Gratis', async () => {
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ loaded: true, pro: false, reason: 'keine-lizenz', deviceCode: F.GERAET_A, deviceKeyLevel: 'tee' });
    expect(LM.isPro()).toBe(false);
  });

  test('Lizenz A auf Geraet A -> Pro aktiv', async () => {
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ pro: true, reason: 'aktiv', licenseInfo: { lic: 'MA1ACH1TEST00001', ord: 'BEST2026TEST0001', iat: 1790000000 } });
    expect(LM.isPro()).toBe(true);
    expect(await LM.isProVerified()).toBe(true);
  });

  test('kopierte Lizenz A auf Geraet B -> gesperrt (anderes-geraet)', async () => {
    deviceKey._spki = F.SPKI_B_B64;
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ pro: false, reason: 'anderes-geraet', deviceCode: F.GERAET_B });
  });

  test('Keystore nicht verfuegbar -> gesperrt, kein Absturz (ein Wiederholversuch)', async () => {
    deviceKey.getOrCreatePublicKey.mockRejectedValue(new Error('Keystore kaputt'));
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ pro: false, reason: 'kein-geraeteschluessel', deviceCode: null });
    expect(deviceKey.getOrCreatePublicKey).toHaveBeenCalledTimes(2);
  });

  test('natives Modul fehlt ganz (z. B. Jest/iOS) -> gesperrt', async () => {
    const { NativeModules } = require('react-native');
    delete NativeModules.MalachiDeviceKey;
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'kein-geraeteschluessel' });
  });

  test('Schluessel/Shop-Adresse noch nicht eingetragen -> "Kauf derzeit nicht verfuegbar", Pro gesperrt', async () => {
    mockConfig.LICENSE_PUBLIC_KEY = null;
    mockConfig.SHOP_ONION = null;
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ pro: false, reason: 'nicht-konfiguriert', purchaseAvailable: false, licenseCheckAvailable: false });
    await expectRejectCode(LM.startPurchase({ consent: true }), 'nicht-konfiguriert');
    await expectRejectCode(LM.transferToThisDevice({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE }), 'nicht-konfiguriert');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('nur die Shop-Adresse fehlt: Kauf nicht verfuegbar, vorhandene Lizenz bleibt gueltig', async () => {
    mockConfig.SHOP_ONION = null;
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    expect(await LM.refreshLicense()).toMatchObject({ pro: true, purchaseAvailable: false });
  });

  test('Abo: Zuhoerer bekommen sofort und bei jeder Aenderung den Zustand', async () => {
    const seen = [];
    const off = LM.subscribeLicense((s) => seen.push(s.pro));
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    await LM.refreshLicense();
    off();
    await LM.refreshLicense();
    expect(seen).toEqual([false, true]);
  });
});

describe('Lizenz eingeben', () => {
  test('gueltig -> gespeichert und aktiv; Leerraum wird entfernt', async () => {
    const r = await LM.installLicense('\n ' + F.LIZENZ_A + ' \n');
    expect(r).toEqual({ ok: true });
    expect(await EncryptedStorage.getItem(LM.LICENSE_STORAGE_KEY)).toBe(F.LIZENZ_A);
    expect(LM.isPro()).toBe(true);
  });

  test.each([
    ['anderes Geraet', F.LIZENZ_B, 'anderes-geraet'],
    ['Muell', 'hallo', 'format'],
    ['leer', '', 'format'],
    ['fehlendes pro', roh(F.JSON_A.replace('["pro"]', '["basis"]')), 'feature'],
  ])('%s -> abgewiesen, NICHT gespeichert, verstaendliche Meldung', async (_n, text, grund) => {
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    await LM.refreshLicense();
    const r = await LM.installLicense(text);
    expect(r).toMatchObject({ ok: false, grund });
    expect(r.message.length).toBeGreaterThan(10);
    // Die vorhandene gueltige Lizenz bleibt unangetastet.
    expect(await EncryptedStorage.getItem(LM.LICENSE_STORAGE_KEY)).toBe(F.LIZENZ_A);
    expect(LM.isPro()).toBe(true);
  });
});

describe('Kauf ueber Tor', () => {
  const created = () => F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE });

  test('Bestellung: Geraetecode geht an den Shop, Wiederherstellungscode wird sofort gespeichert', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    const p = await LM.startPurchase({ consent: true });
    expect(ensureTor).toHaveBeenCalled();
    expect(JSON.parse(tor.httpRequest.mock.calls[0][4]).deviceCode).toBe(F.GERAET_A);
    expect(p).toMatchObject({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, done: false, recoveryAcknowledged: false });
    expect(p.order.status).toBe('pending');
    const stored = JSON.parse(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY));
    expect(stored).toMatchObject({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE });
    expect(LM.isPurchaseOpen(LM.getLicenseState().purchase)).toBe(true);
  });

  test('ohne Zustimmung keine Bestellung', async () => {
    await LM.refreshLicense();
    await expectRejectCode(LM.startPurchase({ consent: false }), 'consent_required');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Tor nicht startbar -> verstaendlicher Fehler, keine Anfrage', async () => {
    ensureTor.mockResolvedValueOnce(false);
    await LM.refreshLicense();
    await expectRejectCode(LM.startPurchase({ consent: true }), 'tor-aus');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Shop nicht erreichbar -> Fehler, nichts gespeichert', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockRejectedValueOnce({ code: 'HTTP_TIMEOUT' });
    const e = await expectRejectCode(LM.startPurchase({ consent: true }), 'nicht-erreichbar');
    expect(e.message).toBe('Shop über Tor gerade nicht erreichbar - später erneut versuchen.');
    expect(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY)).toBeNull();
    expect(LM.getLicenseState().purchase).toBeNull();
  });

  test('laeuft schon eine Bestellung, wird keine zweite angelegt', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    const again = await LM.startPurchase({ consent: true });
    expect(again.orderId).toBe(F.ORDER_ID);
    expect(tor.httpRequest).toHaveBeenCalledTimes(1);
  });

  test('Statusabfrage: offen -> unbestaetigt -> bezahlt; Lizenz wird lokal geprueft und gespeichert', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });

    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'unconfirmed', confirmations: 0 })));
    let p = await LM.checkPurchase();
    expect(p.order.status).toBe('unconfirmed');
    expect(LM.isPro()).toBe(false);

    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'paid', license: F.LIZENZ_A, activations: 1, maxActivations: 3 })));
    p = await LM.checkPurchase();
    expect(p.done).toBe(true);
    expect(p.order.license).toBeUndefined();          // Lizenz liegt separat, nicht in der Bestellung
    expect(LM.isPro()).toBe(true);
    expect(await EncryptedStorage.getItem(LM.LICENSE_STORAGE_KEY)).toBe(F.LIZENZ_A);
    // Bestellnummer + Wiederherstellungscode bleiben fuer einen spaeteren Umzug gespeichert.
    expect(JSON.parse(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY))).toMatchObject({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, done: true });
    // Fertig -> keine weiteren Abfragen.
    await LM.checkPurchase();
    expect(tor.httpRequest).toHaveBeenCalledTimes(3);
  });

  test('bezahlt, aber Lizenz fuer ein anderes Geraet: NICHT freigeschaltet, Fehler sichtbar, Bestellung bleibt', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'paid', license: F.LIZENZ_B })));
    const p = await LM.checkPurchase();
    expect(LM.isPro()).toBe(false);
    expect(p.done).toBe(false);
    expect(p.error).toMatch(/anderen Gerät/);
    expect(await EncryptedStorage.getItem(LM.LICENSE_STORAGE_KEY)).toBeNull();
    expect(LM.canDismissPurchase(p)).toBe(false);
    await expectRejectCode(LM.startPurchase({ consent: true }), 'bestellung-vorhanden');
  });

  test('Shop kennt die Bestellung nicht mehr (404) -> abgelaufen, darf verworfen werden', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    expect(await LM.dismissPurchase()).toBe(false);             // offen: nicht verwerfbar
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(404, 'not_found'));
    const p = await LM.checkPurchase();
    expect(p.gone).toBe(true);
    expect(LM.isPurchaseOpen(p)).toBe(false);
    expect(await LM.dismissPurchase()).toBe(true);
    expect(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY)).toBeNull();
  });

  test('abgelaufene Bestellung: neue Bestellung ersetzt sie', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'expired' })));
    await LM.checkPurchase();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder({ orderId: 'NEW0000000000001' }), recoveryCode: 'ZZZZZZZZZZZZZZZZZZZZ' }));
    const p = await LM.startPurchase({ consent: true });
    expect(p.orderId).toBe('NEW0000000000001');
    expect(JSON.parse(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY))).toMatchObject({ orderId: 'NEW0000000000001', recoveryCode: 'ZZZZZZZZZZZZZZZZZZZZ' });
  });

  test('Fehler bei der Statusabfrage: Bestellung bleibt unveraendert, Fehler wird angezeigt', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    tor.httpRequest.mockRejectedValueOnce({ code: 'HTTP_FAILED' });
    await expectRejectCode(LM.checkPurchase(), 'nicht-erreichbar');
    const p = LM.getLicenseState().purchase;
    expect(p.order.status).toBe('pending');
    expect(p.error).toMatch(/nicht erreichbar/);
    expect(LM.isPurchaseOpen(p)).toBe(true);
  });

  test('gleichzeitige Abfragen teilen sich EINE Anfrage', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    let release;
    tor.httpRequest.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const a = LM.checkPurchase();
    const b = LM.checkPurchase();
    await tick(5);
    release(F.httpOk(200, F.apiOrder()));
    await Promise.all([a, b]);
    expect(tor.httpRequest).toHaveBeenCalledTimes(2);   // 1x Anlage + 1x Status
  });

  test('Wiederherstellungscode als aufgeschrieben markieren (bleibt gespeichert)', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(created());
    await LM.startPurchase({ consent: true });
    await LM.acknowledgeRecoveryCode();
    expect(JSON.parse(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY))).toMatchObject({ recoveryAcknowledged: true, recoveryCode: F.RECOVERY_CODE });
  });
});

describe('Kauf mit Bitcoin', () => {
  const createdBtc = (o = {}) => F.httpOk(201, { ...F.apiOrderBtc(o), recoveryCode: F.RECOVERY_CODE });

  test('Bestellung mit Bitcoin: Zahlungsart geht an den Shop und bleibt in der gespeicherten Bestellung', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(createdBtc());
    const p = await LM.startPurchase({ consent: true, paymentMethod: 'btc' });
    expect(JSON.parse(tor.httpRequest.mock.calls[0][4])).toEqual({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' });
    expect(p.order).toMatchObject({ paymentMethod: 'btc', currency: 'BTC', address: F.BTC_ADDRESS, amount: '0.00004087' });
    const stored = JSON.parse(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY));
    expect(stored.order).toMatchObject({ paymentMethod: 'btc', address: F.BTC_ADDRESS });
  });

  test('unbekannte Zahlungsart: Fehler ohne Tor-Start und ohne Anfrage', async () => {
    await LM.refreshLicense();
    await expectRejectCode(LM.startPurchase({ consent: true, paymentMethod: 'ltc' }), 'invalid_payment_method');
    expect(ensureTor).not.toHaveBeenCalled();
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Statusabfrage: unterzahlt -> bezahlt, Lizenz wird lokal geprueft', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(createdBtc());
    await LM.startPurchase({ consent: true, paymentMethod: 'btc' });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'underpaid', received: '0.00002000', missing: '0.00002087' })));
    let p = await LM.checkPurchase();
    expect(p.order).toMatchObject({ status: 'underpaid', missing: '0.00002087', paymentMethod: 'btc' });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'paid', license: F.LIZENZ_A, activations: 1, maxActivations: 3 })));
    p = await LM.checkPurchase();
    expect(p.done).toBe(true);
    expect(LM.isPro()).toBe(true);
  });

  test.each([
    ['Wechsel auf Monero', () => F.apiOrder()],
    ['andere Bitcoin-Adresse', () => F.apiOrderBtc({ address: F.BTC_ADDRESS_2 })],
    ['Testnet-Adresse', () => F.apiOrderBtc({ address: 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0' })],
  ])('boeswillige Statusantwort (%s): abgewiesen, gespeicherte Bestellung bleibt', async (_n, answer) => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(createdBtc());
    await LM.startPurchase({ consent: true, paymentMethod: 'btc' });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, answer()));
    await expectRejectCode(LM.checkPurchase(), 'antwort-ungueltig');
    const p = LM.getLicenseState().purchase;
    expect(p.order).toMatchObject({ paymentMethod: 'btc', address: F.BTC_ADDRESS, status: 'pending' });
    expect(JSON.parse(await EncryptedStorage.getItem(LM.PURCHASE_STORAGE_KEY)).order.address).toBe(F.BTC_ADDRESS);
  });

  test('alte gespeicherte Monero-Bestellung (ohne paymentMethod): Wechsel auf Bitcoin wird abgewiesen', async () => {
    const order = { orderId: F.ORDER_ID, status: 'pending', currency: 'XMR', expiresAt: Date.now() + 3600000, address: F.XMR_ADDRESS, amount: '0.006149' };
    await EncryptedStorage.setItem(LM.PURCHASE_STORAGE_KEY, JSON.stringify({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, createdAt: 1, order, done: false, gone: false, lastCheckedAt: 1 }));
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc()));
    await expectRejectCode(LM.checkPurchase(), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'unconfirmed' })));
    expect((await LM.checkPurchase()).order).toMatchObject({ status: 'unconfirmed', paymentMethod: 'xmr' });
  });

  test('angebotene Zahlungsarten: einmal ueber Tor abgefragt, Fehler werden beim naechsten Mal erneut versucht', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockRejectedValueOnce({ code: 'HTTP_TIMEOUT' });
    await expectRejectCode(LM.loadShopPaymentMethods(), 'nicht-erreichbar');
    expect(LM.getLicenseState().shopMethods).toBeNull();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo(undefined, { defaultPaymentMethod: 'btc' })));
    expect(await LM.loadShopPaymentMethods()).toEqual({ methods: ['xmr', 'btc'], defaultMethod: 'btc' });
    expect(LM.getLicenseState().shopMethods).toEqual({ methods: ['xmr', 'btc'], defaultMethod: 'btc' });
    await LM.loadShopPaymentMethods();
    expect(tor.httpRequest).toHaveBeenCalledTimes(2);
    expect(ensureTor).toHaveBeenCalled();
  });

  test('angebotene Zahlungsarten: nichts Bekanntes -> kein Zustand; ohne Shop keine Anfrage', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo([{ id: 'extern', currency: 'XMR' }])));
    expect(await LM.loadShopPaymentMethods()).toBeNull();
    expect(LM.getLicenseState().shopMethods).toBeNull();
    mockConfig.SHOP_ONION = null;
    expect(await LM.loadShopPaymentMethods()).toBeNull();
    expect(tor.httpRequest).toHaveBeenCalledTimes(1);
  });
});

describe('Persistenz der laufenden Bestellung (App-Neustart)', () => {
  test('nach dem Neustart wird die Bestellung geladen und weiter abgefragt', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
    await LM.startPurchase({ consent: true });

    // "Neustart": Arbeitsspeicher weg, verschluesselter Speicher bleibt.
    LM._resetLicenseManagerForTests();
    ({ deviceKey, tor } = F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 }));
    LM.configureLicenseManager({ ensureTor: async () => true });
    expect(LM.getLicenseState().purchase).toBeNull();

    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'paid', license: F.LIZENZ_A })));
    await LM.refreshLicense();
    expect(LM.getLicenseState().purchase).toMatchObject({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE });
    expect(await LM.resumePendingPurchase()).toBe(true);
    expect(tor.httpRequest.mock.calls[0][3]).toBe('/api/v1/orders/' + F.ORDER_ID);
    expect(LM.isPro()).toBe(true);
  });

  test('Kaufknopf direkt nach dem Neustart (vor dem ersten Laden) ueberschreibt keine offene Bestellung', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
    await LM.startPurchase({ consent: true });
    LM._resetLicenseManagerForTests();
    ({ deviceKey, tor } = F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 }));
    const p = await LM.startPurchase({ consent: true });
    expect(p).toMatchObject({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE });
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('ohne offene Bestellung fragt der Start nichts beim Shop an', async () => {
    expect(await LM.resumePendingPurchase()).toBe(false);
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('kaputter Speicherinhalt wird verworfen statt uebernommen', async () => {
    await EncryptedStorage.setItem(LM.PURCHASE_STORAGE_KEY, JSON.stringify({ orderId: '../x', recoveryCode: 'y' }));
    await LM.refreshLicense();
    expect(LM.getLicenseState().purchase).toBeNull();
    await EncryptedStorage.setItem(LM.PURCHASE_STORAGE_KEY, '{kein json');
    LM._resetLicenseManagerForTests();
    F.installLicenseNativeMocks();
    await LM.refreshLicense();
    expect(LM.getLicenseState().purchase).toBeNull();
  });
});

describe('Umzug auf dieses Geraet', () => {
  test('Bestellnummer + Code (Tippvarianten) -> neue Lizenz fuer dieses Geraet', async () => {
    deviceKey._spki = F.SPKI_B_B64;
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, { orderId: F.ORDER_ID, license: F.LIZENZ_B, activations: 2, maxActivations: 3, newActivation: true }));
    const r = await LM.transferToThisDevice({ orderId: 'best-2O26-test-OOOl', recoveryCode: 'abcd-efgh-jkmn-pqrs-tvwx' });
    expect(JSON.parse(tor.httpRequest.mock.calls[0][4])).toEqual({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B });
    expect(r).toEqual({ activations: 2, maxActivations: 3, newActivation: true });
    expect(LM.isPro()).toBe(true);
    expect(LM.getLicenseState().purchase).toMatchObject({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, done: true });
  });

  test('Shop liefert Lizenz fuer ein anderes Geraet -> nicht freigeschaltet', async () => {
    await LM.refreshLicense();   // Geraet A
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, { orderId: F.ORDER_ID, license: F.LIZENZ_B, newActivation: true }));
    await expectRejectCode(LM.transferToThisDevice({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE }), 'lizenz-ungueltig');
    expect(LM.isPro()).toBe(false);
    expect(await EncryptedStorage.getItem(LM.LICENSE_STORAGE_KEY)).toBeNull();
  });

  test('Eingabefehler werden ohne Anfrage gemeldet', async () => {
    await LM.refreshLicense();
    await expectRejectCode(LM.transferToThisDevice({ orderId: '123', recoveryCode: F.RECOVERY_CODE }), 'eingabe-bestellnummer');
    await expectRejectCode(LM.transferToThisDevice({ orderId: F.ORDER_ID, recoveryCode: '123' }), 'eingabe-code');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Limit erreicht -> verstaendlicher Fehler', async () => {
    await LM.refreshLicense();
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(409, 'activation_limit_reached'));
    const e = await expectRejectCode(LM.transferToThisDevice({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE }), 'activation_limit_reached');
    expect(e).toBeInstanceOf(ShopError);
    expect(e.message).toMatch(/Höchstzahl/);
  });
});

describe('Wipe', () => {
  test('nach dem Loeschen zeigt die App keine Vollversion mehr an (Geraetecode bleibt)', async () => {
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_A);
    await LM.refreshLicense();
    expect(LM.isPro()).toBe(true);
    await EncryptedStorage.clear();
    LM.resetLicenseStateAfterWipe();
    expect(LM.getLicenseState()).toMatchObject({ pro: false, purchase: null, licenseInfo: null, deviceCode: F.GERAET_A });
    expect(await LM.isProVerified()).toBe(false);
  });
});

describe('Freischaltregeln (Gating)', () => {
  test('Duress-PIN einrichten/aendern nur mit Pro, entfernen immer', () => {
    expect(LM.canConfigureDuressPin(true)).toBe(true);
    expect(LM.canConfigureDuressPin(false)).toBe(false);
    expect(LM.canConfigureDuressPin(undefined)).toBe(false);
    expect(LM.canRemoveDuressPin()).toBe(true);
  });

  test('bestehende Duress-PIN bleibt OHNE Lizenz aktiv (wird weiter ausgewertet)', async () => {
    // Keine bzw. ungueltige Lizenz:
    await EncryptedStorage.setItem(LM.LICENSE_STORAGE_KEY, F.LIZENZ_B);   // fremdes Geraet
    await LM.refreshLicense();
    expect(LM.isPro()).toBe(false);
    expect(LM.isDuressPinEntry('4711', '4711')).toBe(true);
    // Auch wenn gar keine Lizenzpruefung moeglich ist (kein Schluessel/Keystore):
    mockConfig.LICENSE_PUBLIC_KEY = null;
    await LM.refreshLicense();
    expect(LM.isDuressPinEntry('4711', '4711')).toBe(true);
    // Die Regel haengt strukturell nicht vom Lizenzzustand ab.
    expect(LM.isDuressPinEntry.length).toBe(2);
    expect(LM.isDuressPinEntry('4712', '4711')).toBe(false);
    expect(LM.isDuressPinEntry('', '')).toBe(false);
    expect(LM.isDuressPinEntry('4711', null)).toBe(false);
  });

  test('LockScreen wertet die Duress-PIN ohne Lizenzbedingung aus (Regressionsschutz)', () => {
    const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
    const line = app.split(/\r?\n/).find((l) => l.includes('isDuressPinEntry(next'));
    expect(line).toBeDefined();
    expect(line.trim()).toBe('if (isDuressPinEntry(next, duressPin)) {');
    // performWipe benachrichtigt Kontakte nur ueber die Pro-Regel.
    expect(app).toMatch(/notifyContacts = shouldNotifyContactsOnWipe\(await isProVerified\(\)\)/);
    expect(app).toMatch(/if \(notifyContacts\) await notifyOpenConnectionsOfWipe\(\);/);
  });

  test('Fehlversuche: Pro loescht nach dem 5., Gratis nur Sperrfristen', () => {
    const pro = [1, 2, 3, 4, 5].map((n) => LM.failedPinPolicy(n, true));
    expect(pro.map((p) => p.wipe)).toEqual([false, false, false, false, true]);
    expect(pro.map((p) => p.lockMs)).toEqual([0, 0, 30000, 60000, 0]);
    expect(pro[0].message).toMatch(/noch 4 Versuche/);
    expect(pro[3].message).toMatch(/Letzter Versuch/);

    const free = [1, 2, 3, 4, 5, 6, 20].map((n) => LM.failedPinPolicy(n, false));
    expect(free.every((p) => p.wipe === false)).toBe(true);
    // Ab dem 5. Fehlversuch ansteigend (60 s, 5 min, ... bis 24 h), damit
    // eine kurze PIN nicht in wenigen Tagen durchprobierbar ist.
    expect(free.map((p) => p.lockMs)).toEqual([0, 0, 30000, 60000, 60000, 300000, 86400000]);
    expect(free[5].message).toMatch(/5 Minuten/);
    expect(free[6].message).toMatch(/24 Stunden/);
    // Gratis-Texte kuendigen keine Loeschung an.
    for (const p of free) expect(p.message).not.toMatch(/Versuch|zurückgesetzt|gelöscht/);
    expect(LM.lockExpiredMessage(4, true)).toMatch(/Letzter Versuch/);
    expect(LM.lockExpiredMessage(4, false)).toBe('PIN eingeben');
  });

  test('Fernloeschung (Kontakte informieren) nur mit Pro', () => {
    expect(LM.shouldNotifyContactsOnWipe(true)).toBe(true);
    expect(LM.shouldNotifyContactsOnWipe(false)).toBe(false);
  });
});

describe('Datenschutz', () => {
  test('keine Lizenz, kein Wiederherstellungscode, keine Bestellnummer im Log', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      await LM.refreshLicense();
      tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
      await LM.startPurchase({ consent: true });
      tor.httpRequest.mockRejectedValueOnce({ code: 'HTTP_FAILED', message: 'xyz ' + F.ONION });
      await LM.checkPurchase().catch(() => {});
      tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'paid', license: F.LIZENZ_A })));
      await LM.checkPurchase();
      await LM.installLicense(F.LIZENZ_B);
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
      for (const secret of [F.LIZENZ_A, F.LIZENZ_A.split('.')[2], F.RECOVERY_CODE, F.ORDER_ID, F.ONION, F.XMR_ADDRESS]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
