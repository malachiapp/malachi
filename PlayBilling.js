// Duenne Huelle um das native Modul MalachiPlayBilling (nur im Flavor "play",
// android/app/src/play/java/com/securecommapp/billing/PlayBillingModule.kt).
// In der Website-Variante (und unter Jest ohne Mock) fehlt das Modul -
// isBillingModuleAvailable() ist dann false und jeder Aufruf wirft
// PlayBillingError('nicht-verfuegbar').
//
// Hier wird NICHTS geprueft oder freigeschaltet - das macht LicenseManager.js
// mit PlayPurchase.verifyPlayPurchase(). Diese Datei reicht nur Daten durch
// und laesst dabei ausschliesslich bekannte Felder mit plausiblen Typen und
// Laengen passieren. Kauf-Tokens und Kaufdaten werden nie geloggt.

import { NativeModules, NativeEventEmitter } from 'react-native';

/** Ereignisname fuer Kauf-Aktualisierungen (PurchasesUpdatedListener). */
export const PLAY_PURCHASES_EVENT = 'MalachiPlayPurchases';

// BillingResponseCode als Text (vom nativen Modul so geliefert).
export const RESPONSE_CODES = Object.freeze([
  'OK', 'USER_CANCELED', 'SERVICE_UNAVAILABLE', 'BILLING_UNAVAILABLE', 'ITEM_UNAVAILABLE',
  'DEVELOPER_ERROR', 'ERROR', 'ITEM_ALREADY_OWNED', 'ITEM_NOT_OWNED', 'NETWORK_ERROR',
  'SERVICE_DISCONNECTED', 'FEATURE_NOT_SUPPORTED', 'SERVICE_TIMEOUT', 'UNKNOWN',
]);
const PURCHASE_STATES = ['purchased', 'pending', 'unspecified'];

export class PlayBillingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PlayBillingError';
    this.code = code;
  }
}

function mod() {
  const m = NativeModules.MalachiPlayBilling;
  return m && typeof m.queryPurchases === 'function' ? m : null;
}

/** Ist Google Play Billing in diesem Build vorhanden (nur Flavor "play")? */
export function isBillingModuleAvailable() {
  return mod() !== null;
}

function requireMod() {
  const m = mod();
  if (!m) throw new PlayBillingError('nicht-verfuegbar', 'Google Play Billing ist in dieser Version nicht enthalten.');
  return m;
}

function responseCodeOf(e) {
  const c = e && typeof e.code === 'string' ? e.code : '';
  return RESPONSE_CODES.includes(c) ? c : 'ERROR';
}

/** Native Ablehnung in PlayBillingError mit BillingResponseCode umwandeln. */
async function call(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlayBillingError) throw e;
    throw new PlayBillingError(responseCodeOf(e), 'Google Play: ' + responseCodeOf(e));
  }
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Nur bekannte Felder eines Kaufs aus der nativen Antwort uebernehmen. */
export function sanitizeNativePurchase(p) {
  if (!p || typeof p !== 'object') return null;
  const originalJson = str(p.originalJson, 16384);
  const signature = str(p.signature, 4096);
  if (!originalJson || !signature) return null;
  return {
    originalJson,
    signature,
    purchaseState: PURCHASE_STATES.includes(p.purchaseState) ? p.purchaseState : 'unspecified',
    acknowledged: p.acknowledged === true,
    purchaseToken: str(p.purchaseToken, 4096),
  };
}

function sanitizeList(list) {
  return Array.isArray(list) ? list.slice(0, 50).map(sanitizeNativePurchase).filter(Boolean) : [];
}

/** Verbindung zum Play Store herstellen (idempotent). */
export function connect() {
  const m = requireMod();
  return call(() => m.connect());
}

/**
 * Produktdetails (Einmalkauf) abfragen. Rueckgabe: { productId, title, price,
 * priceMicros, currency } oder null, wenn Google Play das Produkt nicht kennt.
 */
export async function queryProduct(productId) {
  const m = requireMod();
  const r = await call(() => m.queryProduct(productId));
  if (!r || typeof r !== 'object' || r.productId !== productId) return null;
  const price = str(r.price, 40);
  if (!price) return null;
  return {
    productId,
    title: str(r.title, 200) || null,
    price,
    priceMicros: str(r.priceMicros, 20) || null,
    currency: str(r.currency, 3) || null,
  };
}

/** Kaufdialog von Google Play oeffnen. Das Ergebnis kommt als Ereignis. */
export async function launchPurchase(productId) {
  const m = requireMod();
  const r = await call(() => m.launchPurchase(productId));
  const code = r && RESPONSE_CODES.includes(r.responseCode) ? r.responseCode : 'ERROR';
  return { responseCode: code };
}

/** Eigene Kaeufe (Einmalkaeufe) aus dem Play Store abfragen - offline aus dessen Cache moeglich. */
export async function queryPurchases() {
  const m = requireMod();
  const r = await call(() => m.queryPurchases());
  if (!r || typeof r !== 'object' || !Array.isArray(r.purchases)) {
    throw new PlayBillingError('ERROR', 'Google Play: unerwartete Antwort');
  }
  return { purchases: sanitizeList(r.purchases) };
}

/** Kauf bei Google Play bestaetigen (sonst erstattet Google ihn nach 3 Tagen). */
export function acknowledge(purchaseToken) {
  const m = requireMod();
  return call(() => m.acknowledge(purchaseToken));
}

let emitter = null;
/**
 * Kauf-Aktualisierungen abonnieren: fn({ responseCode, purchases }).
 * Rueckgabe: Abmelden. Ohne natives Modul: nichts.
 */
export function onPurchasesUpdated(fn) {
  const m = mod();
  if (!m) return () => {};
  if (!emitter) emitter = new NativeEventEmitter(m);
  const sub = emitter.addListener(PLAY_PURCHASES_EVENT, (ev) => {
    const responseCode = ev && RESPONSE_CODES.includes(ev.responseCode) ? ev.responseCode : 'ERROR';
    try { fn({ responseCode, purchases: sanitizeList(ev && ev.purchases) }); } catch { /* Anzeige darf nie stoeren */ }
  });
  return () => { try { sub.remove(); } catch {} };
}

// Nur fuer Tests.
export function _resetPlayBillingForTests() {
  emitter = null;
}
