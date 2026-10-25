// Shop-Client der Vollversion (ShopClient.js) gegen ein gemocktes natives
// NativeModules.MalachiTor.httpRequest: Bestellung, Statusabfrage, Bestaetigung,
// Umzug, Shop nicht erreichbar, ungueltige Antworten und Fuzzing.
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const F = require('../security/helpers/licenseFixtures');

const mockConfig = { LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const Shop = require('../../ShopClient');
let tor;

beforeEach(() => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL;
  mockConfig.SHOP_ONION = F.ONION;
  mockConfig.SHOP_PORT = 80;
  ({ tor } = F.installLicenseNativeMocks());
});

async function expectShopError(promise, code) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Shop.ShopError);
  expect(err.code).toBe(code);
  expect(typeof err.message).toBe('string');
  return err;
}

describe('Bestellung anlegen (POST /api/v1/orders)', () => {
  test('geht nur ueber Tor an die eingebaute Onion-Adresse, mit Geraetecode, Zustimmung und Monero', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
    const o = await Shop.createOrder({ deviceCode: F.GERAET_A, consent: true });
    expect(tor.httpRequest).toHaveBeenCalledTimes(1);
    const [host, port, method, p, body, timeout] = tor.httpRequest.mock.calls[0];
    expect(host).toBe(F.ONION);
    expect(port).toBe(80);
    expect(method).toBe('POST');
    expect(p).toBe('/api/v1/orders');
    expect(JSON.parse(body)).toEqual({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'xmr' });
    expect(timeout).toBe(Shop.TIMEOUT_CREATE_MS);
    expect(o).toMatchObject({ orderId: F.ORDER_ID, status: 'pending', address: F.XMR_ADDRESS, amount: '0.006149', recoveryCode: F.RECOVERY_CODE, eurPrice: '2.99' });
    // Nichts Ungeprueftes aus der Antwort wird durchgereicht.
    expect(o.paymentUri).toBeUndefined();
    expect(o.rateMethod).toBeUndefined();
  });

  test('ohne Zustimmung oder mit ungueltigem Geraetecode: keine Anfrage', async () => {
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: false }), 'consent_required');
    await expectShopError(Shop.createOrder({ deviceCode: 'lj5h-rtfe', consent: true }), 'invalid_device_code');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Antwort ohne Wiederherstellungscode oder nicht "pending" wird abgewiesen', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, F.apiOrder()));
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true }), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder({ status: 'paid' }), recoveryCode: F.RECOVERY_CODE }));
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true }), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: 'abc' }));
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true }), 'antwort-ungueltig');
  });

  test('Shop ohne Konfiguration: "Kauf derzeit nicht verfuegbar", kein Netzverkehr', async () => {
    mockConfig.SHOP_ONION = null;
    expect(Shop.isShopConfigured()).toBe(false);
    const e = await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true }), 'nicht-konfiguriert');
    expect(e.message).toMatch(/Kauf derzeit nicht verfügbar/);
    mockConfig.SHOP_ONION = 'shop.example.com';           // keine Onion-Adresse -> nie benutzt
    await expectShopError(Shop.getOrder(F.ORDER_ID), 'nicht-konfiguriert');
    mockConfig.SHOP_ONION = 'A'.repeat(56) + '.onion';    // Grossbuchstaben: keine v3-Adresse
    await expectShopError(Shop.getOrder(F.ORDER_ID), 'nicht-konfiguriert');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });
});

describe('Statusabfrage und Bestaetigung (GET /api/v1/orders/:id)', () => {
  test('offen, unterzahlt, unbestaetigt', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder()));
    expect((await Shop.getOrder(F.ORDER_ID)).status).toBe('pending');
    const [, , method, p, body, timeout] = tor.httpRequest.mock.calls[0];
    expect([method, p, body, timeout]).toEqual(['GET', '/api/v1/orders/' + F.ORDER_ID, null, Shop.TIMEOUT_STATUS_MS]);

    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'underpaid', received: '0.003000', missing: '0.003149' })));
    const u = await Shop.getOrder(F.ORDER_ID);
    expect(u).toMatchObject({ status: 'underpaid', missing: '0.003149' });
    expect(Shop.moneroPaymentUri(u)).toBe('monero:' + F.XMR_ADDRESS + '?tx_amount=0.003149');

    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'unconfirmed', confirmations: 0 })));
    expect(await Shop.getOrder(F.ORDER_ID)).toMatchObject({ status: 'unconfirmed', confirmations: 0 });
  });

  test('bezahlt: mit Lizenz', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ status: 'paid', license: F.LIZENZ_A, licenseId: 'MA1ACH1TEST00001', activations: 1, maxActivations: 3 })));
    const o = await Shop.getOrder(F.ORDER_ID);
    expect(o).toMatchObject({ status: 'paid', license: F.LIZENZ_A, activations: 1, maxActivations: 3 });
    expect(Shop.moneroPaymentUri({ ...o, address: null })).toBeNull();
  });

  test('Bestellnummer wird normalisiert (Kleinbuchstaben, Bindestriche, O/I/L)', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder()));
    await Shop.getOrder('best-2O26-test-OOOl');
    expect(tor.httpRequest.mock.calls[0][3]).toBe('/api/v1/orders/BEST2026TEST0001');
    await expectShopError(Shop.getOrder('zu-kurz'), 'not_found');
    await expectShopError(Shop.getOrder('../../etc/passwd'), 'not_found');
    expect(tor.httpRequest).toHaveBeenCalledTimes(1);
  });

  test('Antwort zu einer ANDEREN Bestellnummer wird abgewiesen', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ orderId: 'AAAAAAAAAAAAAAAA' })));
    await expectShopError(Shop.getOrder(F.ORDER_ID), 'antwort-ungueltig');
  });

  test('404 not_found (Bestellung abgelaufen und geloescht)', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(404, 'not_found'));
    const e = await expectShopError(Shop.getOrder(F.ORDER_ID), 'not_found');
    expect(e.httpStatus).toBe(404);
  });
});

describe('Umzug (POST /api/v1/transfer)', () => {
  test('Bestellnummer + Wiederherstellungscode + Geraetecode -> Lizenz', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, { orderId: F.ORDER_ID, license: F.LIZENZ_B, licenseId: 'MA1ACH1TEST00001', activations: 2, maxActivations: 3, newActivation: true }));
    const r = await Shop.transferLicense({ orderId: 'best-2026-test-0001', recoveryCode: 'abcd efgh jkmn pqrs tvwx', deviceCode: F.GERAET_B });
    expect(JSON.parse(tor.httpRequest.mock.calls[0][4])).toEqual({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B });
    expect(tor.httpRequest.mock.calls[0][3]).toBe('/api/v1/transfer');
    expect(r).toEqual({ orderId: F.ORDER_ID, license: F.LIZENZ_B, activations: 2, maxActivations: 3, newActivation: true });
  });

  test('falscher Code / Limit / Sperre: verstaendliche Fehler', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(403, 'invalid_order_or_recovery_code'));
    await expectShopError(Shop.transferLicense({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B }), 'invalid_order_or_recovery_code');
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(409, 'activation_limit_reached'));
    await expectShopError(Shop.transferLicense({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B }), 'activation_limit_reached');
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(429, 'temporarily_locked', { retryAfter: '300' }));
    const e = await expectShopError(Shop.transferLicense({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B }), 'temporarily_locked');
    expect(e.retryAfterSec).toBe(300);
  });

  test('ungueltige Eingaben werden lokal abgewiesen (keine Anfrage)', async () => {
    await expectShopError(Shop.transferLicense({ orderId: 'x', recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B }), 'invalid_order_or_recovery_code');
    await expectShopError(Shop.transferLicense({ orderId: F.ORDER_ID, recoveryCode: 'UUUUUUUUUUUUUUUUUUUU', deviceCode: F.GERAET_B }), 'invalid_order_or_recovery_code');
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Antwort ohne/mit fremder Lizenz bzw. Bestellnummer wird abgewiesen', async () => {
    const call = () => Shop.transferLicense({ orderId: F.ORDER_ID, recoveryCode: F.RECOVERY_CODE, deviceCode: F.GERAET_B });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, { orderId: F.ORDER_ID }));
    await expectShopError(call(), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, { orderId: 'AAAAAAAAAAAAAAAA', license: F.LIZENZ_B }));
    await expectShopError(call(), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, { orderId: F.ORDER_ID, license: 'ML1.' + 'x'.repeat(2000) }));
    await expectShopError(call(), 'antwort-ungueltig');
  });
});

describe('Shop nicht erreichbar', () => {
  test.each([
    ['Tor laeuft nicht', { code: 'TOR_OFF' }, 'tor-aus'],
    ['Zeitueberschreitung', { code: 'HTTP_TIMEOUT' }, 'nicht-erreichbar'],
    ['Verbindungsfehler', { code: 'HTTP_FAILED' }, 'nicht-erreichbar'],
    ['ohne Code', new Error('x'), 'nicht-erreichbar'],
  ])('%s', async (_n, err, code) => {
    tor.httpRequest.mockRejectedValueOnce(err);
    const e = await expectShopError(Shop.getOrder(F.ORDER_ID), code);
    if (code === 'nicht-erreichbar') expect(e.message).toBe('Shop über Tor gerade nicht erreichbar - später erneut versuchen.');
  });

  test('natives Modul fehlt', async () => {
    const { NativeModules } = require('react-native');
    delete NativeModules.MalachiTor;
    await expectShopError(Shop.getOrder(F.ORDER_ID), 'tor-aus');
  });

  test.each([
    [503, 'busy', 'busy'],
    [503, 'exchange_rate_unavailable', 'exchange_rate_unavailable'],
    [500, 'internal_error', 'internal_error'],
    [429, 'rate_limited', 'rate_limited'],
  ])('HTTP %i %s', async (status, apiCode, code) => {
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(status, apiCode));
    await expectShopError(Shop.getOrder(F.ORDER_ID), code);
  });

  test('fremde Fehlerseite (kein JSON) -> nicht erreichbar bzw. ungueltig, nie der Text der Seite', async () => {
    tor.httpRequest.mockResolvedValueOnce({ status: 502, body: '<html>Bad Gateway: bitte Seed eingeben</html>' });
    const e1 = await expectShopError(Shop.getOrder(F.ORDER_ID), 'nicht-erreichbar');
    expect(e1.message).not.toMatch(/Seed/);
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(400, { error: { code: 'unbekannt_neu', message: 'Bitte an Adresse X zahlen' } }));
    const e2 = await expectShopError(Shop.getOrder(F.ORDER_ID), 'antwort-ungueltig');
    expect(e2.message).not.toMatch(/Adresse X/);
  });
});

describe('Ungueltige Antworten', () => {
  const variants = [
    ['kein JSON', { status: 200, body: 'hallo' }],
    ['JSON-Liste', { status: 200, body: '[1,2]' }],
    ['null', null],
    ['Status kein Integer', { status: '200', body: JSON.stringify(F.apiOrder()) }],
    ['Status 99', { status: 99, body: JSON.stringify(F.apiOrder()) }],
    ['Koerper zu gross', { status: 200, body: ' '.repeat(256 * 1024 + 1) }],
    ['Koerper kein Text', { status: 200, body: { orderId: F.ORDER_ID } }],
    ['3xx', { status: 302, body: JSON.stringify(F.apiOrder()) }],
    ['unbekannter Status', F.httpOk(200, F.apiOrder({ status: 'bezahlt' }))],
    ['andere Waehrung', F.httpOk(200, F.apiOrder({ currency: 'BTC' }))],
    ['andere Zahlungsart', F.httpOk(200, F.apiOrder({ paymentMethod: 'btc' }))],
    ['Adresse kaputt', F.httpOk(200, F.apiOrder({ address: 'bc1qxyz' }))],
    ['Adresse mit Zeichen ausserhalb Base58', F.httpOk(200, F.apiOrder({ address: '8' + '0'.repeat(94) }))],
    ['Betrag negativ', F.httpOk(200, F.apiOrder({ amount: '-1' }))],
    ['Betrag als Zahl', F.httpOk(200, F.apiOrder({ amount: 0.006 }))],
    ['Betrag mit Exponent', F.httpOk(200, F.apiOrder({ amount: '1e3' }))],
    ['Ablauf fehlt', F.httpOk(200, F.apiOrder({ expiresAt: undefined }))],
    ['Ablauf kein Datum', F.httpOk(200, F.apiOrder({ expiresAt: 'morgen' }))],
    ['bezahlt ohne Lizenz', F.httpOk(200, F.apiOrder({ status: 'paid' }))],
    ['bezahlt mit Lizenz-Muell', F.httpOk(200, F.apiOrder({ status: 'paid', license: '<script>' }))],
    ['Bestellnummer kaputt', F.httpOk(200, F.apiOrder({ orderId: 'ILOU000000000000' }))],
  ];
  test.each(variants)('%s -> antwort-ungueltig', async (_n, res) => {
    tor.httpRequest.mockResolvedValueOnce(res);
    await expectShopError(Shop.getOrder(F.ORDER_ID), 'antwort-ungueltig');
  });

  test('optionale Felder mit Muell werden verworfen statt uebernommen', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ missing: 'viel', received: { x: 1 }, eurPrice: '2,99€', confirmations: -5, minConfirmations: 1.5 })));
    const o = await Shop.getOrder(F.ORDER_ID);
    expect(o).toMatchObject({ missing: null, received: null, eurPrice: null, confirmations: null, minConfirmations: null });
  });
});

describe('Fuzzing', () => {
  const allowedKeys = new Set(['orderId', 'status', 'paymentMethod', 'currency', 'expiresAt', 'minConfirmations', 'confirmations', 'address', 'amount',
    'missing', 'received', 'eurPrice', 'recoveryCode', 'license', 'activations', 'maxActivations']);

  function checkResult(o) {
    for (const k of Object.keys(o)) expect(allowedKeys.has(k)).toBe(true);
    expect(o.orderId).toMatch(Shop.ORDER_ID_RE);
    expect(Shop.ORDER_STATUSES).toContain(o.status);
    expect([['xmr', 'XMR'], ['btc', 'BTC']]).toContainEqual([o.paymentMethod, o.currency]);
    if (o.address !== null && o.paymentMethod === 'xmr') expect(o.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{95}$|^[1-9A-HJ-NP-Za-km-z]{106}$/);
    if (o.address !== null && o.paymentMethod === 'btc') {
      expect(Shop.isBtcAddress(o.address)).toBe(true);
      expect(Shop.isBtcPayAmount(o.amount)).toBe(true);
      expect(Shop.paymentUri(o)).toMatch(/^bitcoin:bc1q[02-9ac-hj-np-z]{38}\?amount=0\.\d{1,8}$/);
    }
    if (o.license !== undefined) expect(o.license.length).toBeLessThanOrEqual(1024);
  }

  test('beliebige Antwortkoerper: nur ShopError oder eine vollstaendig gepruefte Bestellung', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 700 }),
      fc.oneof(fc.string(), fc.json(), fc.jsonValue().map((v) => JSON.stringify(v))),
      async (status, body) => {
        tor.httpRequest.mockResolvedValueOnce({ status, body });
        try {
          checkResult(await Shop.getOrder(F.ORDER_ID));
        } catch (e) {
          expect(e).toBeInstanceOf(Shop.ShopError);
        }
      }), { numRuns: 300 });
  });

  test('gueltige Bestellung mit einem zufaellig ersetzten Feld', async () => {
    const keys = Object.keys(F.apiOrder()).concat(['license', 'recoveryCode', '__proto__', 'constructor']);
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...keys),
      fc.oneof(fc.anything(), fc.string({ maxLength: 300 }), fc.constant(null)),
      fc.constantFrom('pending', 'underpaid', 'unconfirmed', 'paid', 'expired'),
      async (key, value, status) => {
        const obj = F.apiOrder({ status, ...(status === 'paid' ? { license: F.LIZENZ_A } : {}) });
        obj[key] = value;
        let body;
        try { body = JSON.stringify(obj); } catch { return; }
        tor.httpRequest.mockResolvedValueOnce({ status: 200, body });
        try {
          checkResult(await Shop.getOrder(F.ORDER_ID));
        } catch (e) {
          expect(e).toBeInstanceOf(Shop.ShopError);
          expect(e.code).toBe('antwort-ungueltig');
        }
      }), { numRuns: 400 });
  });
});

test('eingebauter Zustimmungstext ist wortgleich mit dem des Shops', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../shop/src/app.js'), 'utf8');
  const m = /consentText:\s*\n?\s*'([^']+)'/.exec(app);
  expect(m).not.toBeNull();
  expect(Shop.CONSENT_TEXT).toBe(m[1]);
});

test('Normalisierung von Crockford-Eingaben', () => {
  expect(Shop.normalizeOrderId(' best-2026-test-0001 ')).toBe(F.ORDER_ID);
  expect(Shop.normalizeOrderId('BEST2026TEST000')).toBeNull();
  expect(Shop.normalizeOrderId('BEST2026TEST000U')).toBeNull();
  expect(Shop.normalizeRecoveryCode('abcd-efgh-jkmn-pqrs-tvwx')).toBe(F.RECOVERY_CODE);
  expect(Shop.normalizeRecoveryCode(null)).toBeNull();
  expect(Shop.normalizeRecoveryCode('x'.repeat(100))).toBeNull();
});

// ── Bitcoin (zweite Zahlungsart) ──────────────────────────────────────────

describe('Bitcoin: Adresspruefung (bech32, BIP173)', () => {
  test.each([
    ['BIP84-Testvektor m/0/0', F.BTC_ADDRESS],
    ['BIP84-Testvektor m/0/1', F.BTC_ADDRESS_2],
    ['BIP84-Testvektor Wechselgeld m/1/0', 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'],
    ['BIP173-Beispiel P2WPKH', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
  ])('gueltig: %s', (_n, a) => {
    expect(Shop.isBtcAddress(a)).toBe(true);
  });

  test.each([
    ['Testnet (tb1)', 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0'],
    ['Regtest (bcrt1)', 'bcrt1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx'],
    ['Taproot (bc1p, bech32m)', 'bc1ppyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysd7rjmy'],
    ['Version 1 mit 20 Byte (bc1p)', 'bc1pcr8te4kr609gcawutmrza0j4xv80jy8z63dzfh'],
    ['P2WSH (bc1q, 32 Byte)', 'bc1qqurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurs6mww0q'],
    ['Version 0 mit bech32m-Pruefsumme', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zyn29p7'],
    ['Legacy P2PKH (1...)', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'],
    ['P2SH (3...)', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
    ['Pruefsumme falsch (letztes Zeichen)', F.BTC_ADDRESS.slice(0, -1) + 'v'],
    ['Pruefsumme falsch (vertauschte Zeichen)', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fuy'],
    ['Grossbuchstaben (vom Shop nie erzeugt)', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'],
    ['gemischte Schreibung', 'bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['Zeichen ausserhalb bech32 (b, i, o, 1)', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyb'],
    ['Leerzeichen am Ende', F.BTC_ADDRESS + ' '],
    ['Zeilenumbruch', F.BTC_ADDRESS + '\n'],
    ['zu lang', F.BTC_ADDRESS + 'q'],
    ['zu kurz', F.BTC_ADDRESS.slice(0, -1)],
    ['Monero-Adresse', F.XMR_ADDRESS],
    ['URI statt Adresse', 'bitcoin:' + F.BTC_ADDRESS],
    ['riesig', 'bc1q' + 'q'.repeat(100000)],
    ['keine Zeichenkette', 12345],
    ['null', null],
  ])('ungueltig: %s', (_n, a) => {
    expect(Shop.isBtcAddress(a)).toBe(false);
  });
});

describe('Bitcoin: Betraege', () => {
  test('Umrechnung und Grenzen', () => {
    expect(Shop.btcToSats('0.00004087')).toBe(4087);
    expect(Shop.btcToSats('0.001')).toBe(100000);
    expect(Shop.btcToSats('1')).toBe(100000000);
    expect(Shop.btcToSats('0.00000001')).toBe(1);
    expect(Shop.isBtcPayAmount('0.00004087')).toBe(true);
    expect(Shop.isBtcPayAmount('0.00000546')).toBe(true);
    expect(Shop.isBtcPayAmount('0.001')).toBe(true);           // Obergrenze BTC_MAX_PAY_SATS
    expect(Shop.BTC_MAX_PAY_SATS).toBe(100000);
  });

  test.each([
    ['9 Nachkommastellen', '0.000040871'],
    ['ueber der Obergrenze', '0.00100001'],
    ['ein ganzer Bitcoin', '1'],
    ['21 Mio. BTC', '21000000'],
    ['null', '0'],
    ['null mit Stellen', '0.00000000'],
    ['negativ', '-0.00004087'],
    ['Exponent', '4.087e-5'],
    ['Komma', '0,00004087'],
    ['fuehrende Null', '00.00004087'],
    ['ohne Vorkommastelle', '.00004087'],
    ['Punkt am Ende', '0.'],
    ['Leerzeichen', ' 0.00004087'],
    ['Zeilenumbruch', '0.00004087\n'],
    ['Zahl statt Text', 0.00004087],
    ['riesig', '0.' + '1'.repeat(10000)],
  ])('kein zahlbarer Betrag: %s', (_n, v) => {
    expect(Shop.isBtcPayAmount(v)).toBe(false);
  });
});

describe('Bitcoin: Bestellung und Status', () => {
  const createdBtc = (o = {}) => F.httpOk(201, { ...F.apiOrderBtc(o), recoveryCode: F.RECOVERY_CODE });

  test('Bestellung mit paymentMethod "btc"; Zahlungs-URI wird lokal gebaut', async () => {
    tor.httpRequest.mockResolvedValueOnce(createdBtc());
    const o = await Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' });
    expect(JSON.parse(tor.httpRequest.mock.calls[0][4])).toEqual({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' });
    expect(o).toMatchObject({ paymentMethod: 'btc', currency: 'BTC', address: F.BTC_ADDRESS, amount: '0.00004087', missing: '0.00004087', received: '0.00000000', recoveryCode: F.RECOVERY_CODE });
    expect(o.paymentUri).toBeUndefined();
    expect(Shop.paymentAmount(o)).toBe('0.00004087');
    expect(Shop.paymentUri(o)).toBe('bitcoin:' + F.BTC_ADDRESS + '?amount=0.00004087');
    expect(Shop.orderPaymentMethod(o)).toBe('btc');
  });

  test('der vom Shop gelieferte paymentUri wird nie benutzt', async () => {
    tor.httpRequest.mockResolvedValueOnce(createdBtc({ paymentUri: 'bitcoin:bc1qangreifer?amount=1' }));
    const o = await Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' });
    expect(Shop.paymentUri(o)).toBe('bitcoin:' + F.BTC_ADDRESS + '?amount=0.00004087');
  });

  test('unterzahlt: URI mit dem fehlenden Betrag; unbestaetigt; bezahlt mit Lizenz', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'underpaid', received: '0.00002000', missing: '0.00002087' })));
    const u = await Shop.getOrder(F.ORDER_ID, { paymentMethod: 'btc', address: F.BTC_ADDRESS });
    expect(u).toMatchObject({ status: 'underpaid', missing: '0.00002087', received: '0.00002000' });
    expect(Shop.paymentUri(u)).toBe('bitcoin:' + F.BTC_ADDRESS + '?amount=0.00002087');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'unconfirmed', confirmations: 0, missing: '0.00000000' })));
    expect(await Shop.getOrder(F.ORDER_ID, { paymentMethod: 'btc' })).toMatchObject({ status: 'unconfirmed', confirmations: 0 });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'paid', license: F.LIZENZ_A, activations: 1, maxActivations: 3 })));
    expect(await Shop.getOrder(F.ORDER_ID, { paymentMethod: 'btc' })).toMatchObject({ status: 'paid', license: F.LIZENZ_A, paymentMethod: 'btc' });
  });

  test('unbekannte Zahlungsart: Fehler ohne Anfrage', async () => {
    for (const m of ['ltc', 'BTC', 'extern', '', null, 1, '__proto__']) {
      await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: m }), 'invalid_payment_method');
    }
    expect(tor.httpRequest).not.toHaveBeenCalled();
  });

  test('Shop lehnt die Zahlungsart ab (invalid_payment_method)', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(400, 'invalid_payment_method'));
    const e = await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' }), 'invalid_payment_method');
    expect(e.message).toBe('Diese Zahlungsart bietet der Shop gerade nicht an.');
    tor.httpRequest.mockResolvedValueOnce(F.httpErr(503, 'exchange_rate_unavailable'));
    const k = await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' }), 'exchange_rate_unavailable');
    expect(k.message).not.toMatch(/Monero/);
  });

  const boese = [
    // Adresse
    ['Testnet-Adresse', { address: 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0' }],
    ['Taproot-Adresse (bc1p)', { address: 'bc1ppyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysd7rjmy' }],
    ['P2WSH-Adresse', { address: 'bc1qqurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurs6mww0q' }],
    ['Legacy-Adresse', { address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }],
    ['P2SH-Adresse', { address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }],
    ['Pruefsumme kaputt', { address: F.BTC_ADDRESS.slice(0, -1) + 'v' }],
    ['bech32m statt bech32', { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zyn29p7' }],
    ['Grossbuchstaben', { address: F.BTC_ADDRESS.toUpperCase() }],
    ['Monero-Adresse bei BTC', { address: F.XMR_ADDRESS }],
    ['Adresse mit Zeilenumbruch', { address: F.BTC_ADDRESS + '\n' }],
    ['Adresse riesig', { address: 'bc1q' + 'q'.repeat(200000) }],
    ['Adresse fehlt', { address: undefined }],
    // Betrag
    ['zu viele Nachkommastellen', { amount: '0.000040871' }],
    ['Betrag zu hoch', { amount: '0.5' }],
    ['Betrag 1 BTC', { amount: '1' }],
    ['Betrag null', { amount: '0.00000000' }],
    ['Betrag negativ', { amount: '-0.00004087' }],
    ['Betrag mit Exponent', { amount: '4.087e-5' }],
    ['Betrag als Zahl', { amount: 0.00004087 }],
    ['Betrag riesig', { amount: '0.' + '1'.repeat(300000) }],
    // Zahlungsart / Waehrung
    ['Waehrung XMR bei btc', { currency: 'XMR' }],
    ['paymentMethod fehlt bei BTC', { paymentMethod: undefined }],
    ['paymentMethod xmr bei BTC', { paymentMethod: 'xmr' }],
    ['paymentMethod gross', { paymentMethod: 'BTC' }],
    ['unbekannte Waehrung', { currency: 'LTC', paymentMethod: 'ltc' }],
    // uebergrosse Felder
    ['Ablauf riesig', { expiresAt: 'x'.repeat(100000) }],
    ['Bestellnummer riesig', { orderId: 'A'.repeat(100000) }],
  ];
  test.each(boese)('boeswilliger Shop: %s -> antwort-ungueltig', async (_n, over) => {
    tor.httpRequest.mockResolvedValueOnce(createdBtc(over));
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' }), 'antwort-ungueltig');
  });

  test('Wechsel der Zahlungsart in der Antwort wird abgewiesen', async () => {
    // Bitcoin bestellt, Monero-Bestellung zurueck
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(201, { ...F.apiOrder(), recoveryCode: F.RECOVERY_CODE }));
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true, paymentMethod: 'btc' }), 'antwort-ungueltig');
    // Monero bestellt, Bitcoin-Bestellung zurueck
    tor.httpRequest.mockResolvedValueOnce(createdBtc());
    await expectShopError(Shop.createOrder({ deviceCode: F.GERAET_A, consent: true }), 'antwort-ungueltig');
    // Statusabfrage einer Monero-Bestellung liefert Bitcoin (und umgekehrt)
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc()));
    await expectShopError(Shop.getOrder(F.ORDER_ID, { paymentMethod: 'xmr' }), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder()));
    await expectShopError(Shop.getOrder(F.ORDER_ID, { paymentMethod: 'btc' }), 'antwort-ungueltig');
  });

  test('geaenderte Zahlungsadresse in der Statusabfrage wird abgewiesen', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ address: F.BTC_ADDRESS_2 })));
    await expectShopError(Shop.getOrder(F.ORDER_ID, { paymentMethod: 'btc', address: F.BTC_ADDRESS }), 'antwort-ungueltig');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrder({ address: '8' + 'Z9y8X7w6V5'.repeat(10).slice(0, 94) })));
    await expectShopError(Shop.getOrder(F.ORDER_ID, { paymentMethod: 'xmr', address: F.XMR_ADDRESS }), 'antwort-ungueltig');
  });

  test('optionale BTC-Felder mit Muell werden verworfen; URI faellt auf den Gesamtbetrag zurueck', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiOrderBtc({ status: 'underpaid', missing: '0.5', received: '0.000000001' })));
    const o = await Shop.getOrder(F.ORDER_ID);
    expect(o).toMatchObject({ missing: null, received: null });
    expect(Shop.paymentUri(o)).toBe('bitcoin:' + F.BTC_ADDRESS + '?amount=0.00004087');
  });

  test('paymentUri/paymentAmount pruefen auch gespeicherte Bestellungen erneut', () => {
    const ok = { orderId: F.ORDER_ID, status: 'pending', paymentMethod: 'btc', currency: 'BTC', address: F.BTC_ADDRESS, amount: '0.00004087' };
    expect(Shop.paymentUri(ok)).toBe('bitcoin:' + F.BTC_ADDRESS + '?amount=0.00004087');
    expect(Shop.paymentUri({ ...ok, address: 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0' })).toBeNull();
    expect(Shop.paymentUri({ ...ok, amount: '1' })).toBeNull();
    expect(Shop.paymentAmount({ ...ok, amount: '0.5' })).toBeNull();
    expect(Shop.paymentUri({ ...ok, paymentMethod: undefined })).toBe('bitcoin:' + F.BTC_ADDRESS + '?amount=0.00004087');
    // Monero (auch alte gespeicherte Bestellungen ohne paymentMethod) unveraendert
    const xmr = { orderId: F.ORDER_ID, status: 'pending', currency: 'XMR', address: F.XMR_ADDRESS, amount: '0.006149' };
    expect(Shop.orderPaymentMethod(xmr)).toBe('xmr');
    expect(Shop.paymentUri(xmr)).toBe(Shop.moneroPaymentUri(xmr));
    expect(Shop.paymentAmount({ ...xmr, status: 'underpaid', missing: '0.003149' })).toBe('0.003149');
    expect(Shop.paymentUri(null)).toBeNull();
    expect(Shop.orderPaymentMethod(null)).toBeNull();
  });

  test('Fuzzing: gueltige Bitcoin-Bestellung mit einem zufaellig ersetzten Feld', async () => {
    const keys = Object.keys(F.apiOrderBtc()).concat(['license', 'recoveryCode', '__proto__', 'constructor']);
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...keys),
      fc.oneof(fc.anything(), fc.string({ maxLength: 300 }), fc.constant(null),
        fc.constantFrom('tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0', F.BTC_ADDRESS_2, '0.1', '0.000000001', 'xmr', 'XMR', 'btc', 'BTC')),
      fc.constantFrom('pending', 'underpaid', 'unconfirmed', 'paid', 'expired'),
      async (key, value, status) => {
        const obj = F.apiOrderBtc({ status, ...(status === 'paid' ? { license: F.LIZENZ_A } : {}) });
        obj[key] = value;
        let body;
        try { body = JSON.stringify(obj); } catch { return; }
        tor.httpRequest.mockResolvedValueOnce({ status: 200, body });
        try {
          const o = await Shop.getOrder(F.ORDER_ID, { paymentMethod: 'btc', address: F.BTC_ADDRESS });
          expect(o.paymentMethod).toBe('btc');
          if (o.address !== null) expect(o.address).toBe(F.BTC_ADDRESS);
          const uri = Shop.paymentUri(o);
          if (uri !== null) expect(uri).toMatch(/^bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu\?amount=0\.\d{1,8}$/);
        } catch (e) {
          expect(e).toBeInstanceOf(Shop.ShopError);
          expect(e.code).toBe('antwort-ungueltig');
        }
      }), { numRuns: 400 });
  });
});

describe('Zahlungsarten des Shops (GET /api/v1/info)', () => {
  test('Monero und Bitcoin angeboten', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo()));
    const i = await Shop.getShopInfo();
    expect(tor.httpRequest.mock.calls[0].slice(2, 4)).toEqual(['GET', '/api/v1/info']);
    expect(i).toMatchObject({ paymentMethods: ['xmr', 'btc'], defaultPaymentMethod: 'xmr', acceptsXmr: true, priceEur: '2.99' });
  });

  test('Vorgabe des Shops wird nur uebernommen, wenn sie angeboten wird', async () => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo(undefined, { defaultPaymentMethod: 'btc' })));
    expect((await Shop.getShopInfo()).defaultPaymentMethod).toBe('btc');
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo([{ id: 'btc', currency: 'BTC' }], { defaultPaymentMethod: 'xmr' })));
    expect(await Shop.getShopInfo()).toMatchObject({ paymentMethods: ['btc'], defaultPaymentMethod: 'btc', acceptsXmr: false });
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo(undefined, { defaultPaymentMethod: 'extern' })));
    expect((await Shop.getShopInfo()).defaultPaymentMethod).toBe('xmr');
  });

  test.each([
    ['unbekannte Kennungen werden ignoriert', [{ id: 'extern', currency: 'XMR' }, { id: 'ltc', currency: 'LTC' }, { id: 'btc', currency: 'BTC' }], ['btc']],
    ['Waehrung passt nicht zur Kennung', [{ id: 'btc', currency: 'XMR' }, { id: 'xmr', currency: 'BTC' }], []],
    ['Doppelte und feste Reihenfolge', [{ id: 'btc', currency: 'BTC' }, { id: 'xmr', currency: 'XMR' }, { id: 'btc', currency: 'BTC' }], ['xmr', 'btc']],
    ['Muell-Eintraege', ['btc', null, 7, [{ id: 'btc' }], { id: '__proto__', currency: 'BTC' }, { id: 'constructor' }, { id: 'xmr', currency: 'XMR' }], ['xmr']],
    ['keine Liste', { xmr: true }, []],
    ['uebergrosse Liste', Array.from({ length: 1000 }, () => ({ id: 'btc', currency: 'BTC' })), []],
  ])('%s', async (_n, list, expected) => {
    tor.httpRequest.mockResolvedValueOnce(F.httpOk(200, F.apiInfo(list)));
    const i = await Shop.getShopInfo();
    expect(i.paymentMethods).toEqual(expected);
    expect(i.defaultPaymentMethod).toBe(expected.length ? (expected.includes('xmr') ? 'xmr' : expected[0]) : null);
  });
});
