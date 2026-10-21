// Testhilfen fuer die Google-Play-Variante (PlayPurchase.js, LicenseManager.js,
// PlayProScreen.tsx): Test-RSA-Schluesselpaar wie aus der Play Console
// (Base64 eines X.509 SubjectPublicKeyInfo), von "Google Play" signierte
// Kaufdaten und Mocks der nativen Module MalachiBuild / MalachiPlayBilling.
// Die Schluessel werden in jedem Testlauf frisch erzeugt - nichts davon ist
// ein echter Schluessel.
const crypto = require('crypto');
const { Buffer } = require('buffer');
const { NativeModules } = require('react-native');

const PKG = 'app.malachi.messenger';
const PRODUCT = 'malachi_pro';
const TOKEN = 'opaque-token-' + 'x'.repeat(40) + '.AO-J1Oz_test';

/** RSA-Schluesselpaar; pubB64 im Format der Play Console. */
function makeRsaKey(bits = 2048) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
  return { pubB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey, publicKey };
}

function purchaseJson(fields = {}) {
  return JSON.stringify({
    orderId: 'GPA.3374-1234-5678-90123',
    packageName: PKG,
    productId: PRODUCT,
    purchaseTime: 1792000000000,
    purchaseState: 0,
    purchaseToken: TOKEN,
    quantity: 1,
    acknowledged: false,
    ...fields,
  });
}

/**
 * Kauf so, wie ihn das native Modul liefert: originalJson + Signatur
 * (SHA1withRSA wie Google Play) + unsignierte Begleitfelder.
 */
function signedPurchase(privateKey, fields = {}, { hash = 'sha1', native = {}, json } = {}) {
  const originalJson = json !== undefined ? json : purchaseJson(fields);
  const signature = crypto.sign(hash, Buffer.from(originalJson, 'utf8'), privateKey).toString('base64');
  let parsed = {};
  try { parsed = JSON.parse(originalJson); } catch {}
  return {
    originalJson,
    signature,
    purchaseState: parsed.purchaseState === 4 ? 'pending' : 'purchased',
    acknowledged: parsed.acknowledged === true,
    purchaseToken: parsed.purchaseToken,
    ...native,
  };
}

/** NativeModules fuer die Play-Variante einrichten. Rueckgabe: Billing-Mock. */
function installPlayNativeMocks({ purchases = [], product, applicationId = PKG } = {}) {
  NativeModules.MalachiBuild = { distribution: 'play', applicationId };
  const billing = {
    _purchases: purchases,
    connect: jest.fn(async () => true),
    queryProduct: jest.fn(async (id) => (product === null ? null
      : { productId: id, title: 'Vollversion', price: '2,99 €', priceMicros: '2990000', currency: 'EUR', ...(product || {}) })),
    queryPurchases: jest.fn(async () => ({ purchases: billing._purchases })),
    launchPurchase: jest.fn(async () => ({ responseCode: 'OK' })),
    acknowledge: jest.fn(async () => true),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  NativeModules.MalachiPlayBilling = billing;
  return billing;
}

/** Zurueck zur Website-Variante (wie ohne natives Modul). */
function removePlayNativeMocks() {
  delete NativeModules.MalachiBuild;
  delete NativeModules.MalachiPlayBilling;
}

/** Kauf-Aktualisierung so senden, wie sie PlayBillingModule.onPurchasesUpdated schickt. */
function emitPurchasesUpdated(responseCode, purchases = []) {
  const { DeviceEventEmitter } = require('react-native');
  DeviceEventEmitter.emit('MalachiPlayPurchases', { responseCode, purchases });
}

/** Alle sofort aufgeloesten Promises/Timer abarbeiten lassen. */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

module.exports = {
  PKG, PRODUCT, TOKEN,
  makeRsaKey, purchaseJson, signedPurchase, installPlayNativeMocks, removePlayNativeMocks, emitPurchasesUpdated, flush,
};
