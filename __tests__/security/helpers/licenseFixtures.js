// Testdaten fuer die Vollversion (LicenseManager.js / ShopClient.js /
// LicenseFormat.js) - ausschliesslich die oeffentlich bekannten Testvektoren
// aus shop/LIZENZ_FORMAT.md Abschnitt 10. Niemals produktiv verwenden.
const { NativeModules } = require('react-native');

// RFC 8032, Abschnitt 7.1, TEST 1
const TEST_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const TEST_PUBLIC_B64URL = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const SPKI_A_HEX = SPKI_PREFIX + '0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299';
const SPKI_B_HEX = SPKI_PREFIX + '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const SPKI_A_B64 = Buffer.from(SPKI_A_HEX, 'hex').toString('base64');
const SPKI_B_B64 = Buffer.from(SPKI_B_HEX, 'hex').toString('base64');
const GERAET_A = 'LJ5HRTFEUD2CBWN4MK5WNHB4E5M6HH3SE3';
const GERAET_B = 'LTJFF6YM5CJSINX27DGNCBAJQG4J5ZFNLQ';

const LIZENZ_A = 'ML1.eyJkZXYiOiJMSjVIUlRGRVVEMkNCV040TUs1V05IQjRFNU02SEgzU0UzIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDAwMDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.Q471nF3EL1ZPeX2ChkgpVXay44Nix0C3DWrnUxc83a02Xphim5y-KFqbNvI7aZVaVpCkMsEQX_G6Dp_mQLEuBQ';
const LIZENZ_B = 'ML1.eyJkZXYiOiJMVEpGRjZZTTVDSlNJTlgyN0RHTkNCQUpRRzRKNVpGTkxRIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDg2NDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.3DUwgiHysO8J3cHsSTGyhQXmDefG6YuUqUvk23KQI60j9E-n-wwjyy3JHk57hrggXZBpgpulUWW7rth6klBgCA';
const JSON_A = '{"dev":"LJ5HRTFEUD2CBWN4MK5WNHB4E5M6HH3SE3","feat":["pro"],"iat":1790000000,"lic":"MA1ACH1TEST00001","ord":"BEST2026TEST0001","v":1}';

const ORDER_ID = 'BEST2026TEST0001';
const RECOVERY_CODE = 'ABCDEFGHJKMNPQRSTVWX';
const ONION = 'a'.repeat(56) + '.onion';
// Formal gueltige, erfundene Monero-Unteradresse (95 Zeichen Base58).
const XMR_ADDRESS = '8' + 'A1b2C3d4E5'.repeat(10).slice(0, 94);

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Signiert beliebige Nutzdaten (Text) als ML1-Lizenz mit dem RFC-8032-Testschluessel. */
function signRaw(payloadText, { ed25519, asciiBytes, base64urlKodieren }) {
  const teil = 'ML1.' + base64urlKodieren(asciiBytes(payloadText));
  const sig = ed25519.sign(asciiBytes(teil), hexToBytes(TEST_SEED_HEX));
  return teil + '.' + base64urlKodieren(sig);
}

/** Bestellung, wie der Shop sie liefert (shop/src/app.js apiBestellung). */
function apiOrder(overrides = {}) {
  return {
    orderId: ORDER_ID,
    status: 'pending',
    paymentMethod: 'xmr',
    currency: 'XMR',
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    minConfirmations: 1,
    address: XMR_ADDRESS,
    amount: '0.006149',
    amountAtomic: '6149000000',
    amountXmr: '0.006149',
    paymentUri: 'monero:' + XMR_ADDRESS + '?tx_amount=0.006149',
    eurPrice: '2.99',
    eurRate: '486.27',
    rateMethod: 'Median aus 2 Quellen',
    rateFetchedAt: new Date().toISOString(),
    received: '0.000000',
    missing: '0.006149',
    confirmations: null,
    ...overrides,
  };
}

// Bitcoin: Adressen aus dem oeffentlichen BIP84-Testvektor ("abandon ... about",
// m/84'/0'/0'/0/0 und /1) - jeder kennt den Schluessel, nie echt bezahlen.
const BTC_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const BTC_ADDRESS_2 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';

/** Bitcoin-Bestellung, wie der Shop sie liefert (shop/test/bitcoin.test.js). */
function apiOrderBtc(overrides = {}) {
  return apiOrder({
    paymentMethod: 'btc',
    currency: 'BTC',
    address: BTC_ADDRESS,
    amount: '0.00004087',
    amountAtomic: '4087',
    amountXmr: undefined,
    paymentUri: 'bitcoin:' + BTC_ADDRESS + '?amount=0.00004087',
    eurRate: '73174.00',
    received: '0.00000000',
    missing: '0.00004087',
    ...overrides,
  });
}

/** GET /api/v1/info (shop/src/app.js). */
function apiInfo(paymentMethods = [{ id: 'xmr', currency: 'XMR', name: 'Monero' }, { id: 'btc', currency: 'BTC', name: 'Bitcoin' }], extra = {}) {
  return {
    product: 'Malachi Vollversion', priceEur: '2.99', paymentMethods, defaultPaymentMethod: 'xmr',
    minConfirmations: 1, maxActivations: 3, consentRequired: true, consentText: 'x', licenseFormat: 'ML1', licensePublicKeys: [],
    ...extra,
  };
}

/** Antwort des nativen httpRequest. */
const httpOk = (status, obj) => ({ status, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const httpErr = (status, code, extra = {}) => ({ status, body: JSON.stringify({ error: { code, message: 'Meldung vom Shop' } }), ...extra });

/** Natives Geraeteschluessel-Modul (Keystore) und Tor-HTTP mocken. */
function installLicenseNativeMocks({ spki = SPKI_A_B64 } = {}) {
  const deviceKey = { getOrCreatePublicKey: jest.fn(async () => ({ spki: deviceKey._spki, security: 'tee' })), _spki: spki };
  NativeModules.MalachiDeviceKey = deviceKey;
  const tor = { httpRequest: jest.fn(async () => { throw Object.assign(new Error('nicht gemockt'), { code: 'HTTP_FAILED' }); }) };
  NativeModules.MalachiTor = tor;
  return { deviceKey, tor };
}

module.exports = {
  TEST_SEED_HEX, TEST_PUBLIC_B64URL, SPKI_PREFIX, SPKI_A_HEX, SPKI_B_HEX, SPKI_A_B64, SPKI_B_B64,
  GERAET_A, GERAET_B, LIZENZ_A, LIZENZ_B, JSON_A, ORDER_ID, RECOVERY_CODE, ONION, XMR_ADDRESS,
  BTC_ADDRESS, BTC_ADDRESS_2,
  hexToBytes, signRaw, apiOrder, apiOrderBtc, apiInfo, httpOk, httpErr, installLicenseNativeMocks,
};
