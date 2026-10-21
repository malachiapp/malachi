// Shop-Client fuer den In-App-Kauf der Vollversion ("Pro").
// JSON-API des Onion-Shops: shop/LIZENZ_FORMAT.md Abschnitt 9 (Server: shop/src/app.js).
//
// Datenschutz (verbindlich):
//  - Jede Anfrage geht AUSSCHLIESSLICH ueber den Tor-Prozess der App an die
//    eingebaute Onion-Adresse (AppConfig.SHOP_ONION) - NativeModules.MalachiTor.
//    httpRequest lehnt alles ab, was keine v3-Onion-Adresse ist. Kein Klartext-
//    Internet, kein DNS, keine Cookies, kein User-Agent, keine Analytics.
//  - Uebertragen werden nur: der Geraetecode (Kauf, Umzug), die gewaehlte
//    Zahlungsart ("xmr" oder "btc"), Bestellnummer und Wiederherstellungscode
//    (Statusabfrage bzw. Umzug).
//  - Nichts davon wird geloggt - weder Lizenzen noch Wiederherstellungscodes
//    noch Bestellnummern oder Zahlungsadressen.
//
// Jede Antwort wird streng geprueft (Felder, Formate, Laengen). Eine
// unerwartete Antwort fuehrt zu ShopError('antwort-ungueltig'), nie zu einem
// halb uebernommenen Zustand. Fehlermeldungen fuer die Anzeige kommen aus der
// eigenen Tabelle unten, nicht aus dem Text der Shop-Antwort.
//
// Zahlungsarten: Monero ("xmr") und Bitcoin ("btc", on-chain, nur native
// SegWit bc1q... im Mainnet, Pruefsumme nach BIP173 selbst geprueft). Andere
// Kennungen aus der Shop-Antwort werden ignoriert bzw. abgewiesen. Zahlungs-
// URIs (monero:/bitcoin:) baut die App selbst aus gepruefter Adresse und
// gepruefem Betrag - "paymentUri" des Shops wird nie benutzt.

import { NativeModules } from 'react-native';
import { SHOP_ONION, SHOP_PORT } from './AppConfig';
import { t } from './i18n';

export const ONION_V3_RE = /^[a-z2-7]{56}\.onion$/;
// Bestellnummer/Lizenz-ID: 16 Zeichen Crockford-Base32; Wiederherstellungscode: 20.
export const ORDER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;
export const RECOVERY_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
// Monero-Adresse (Base58, 95 Zeichen; integrierte Adresse 106 Zeichen).
const XMR_ADDRESS_RE = /^(?:[1-9A-HJ-NP-Za-km-z]{95}|[1-9A-HJ-NP-Za-km-z]{106})$/;
const DECIMAL_RE = /^\d{1,12}(?:\.\d{1,12})?$/;
// Bitcoin: nur P2WPKH im Mainnet (bc1q + 38 Zeichen, nur Kleinbuchstaben wie
// vom Shop erzeugt). Die Pruefsumme prueft isBtcAddress() zusaetzlich.
const BTC_ADDRESS_RE = /^bc1q[02-9ac-hj-np-z]{38}$/;
// Betrag in BTC: Dezimaltext, hoechstens 8 Nachkommastellen, ohne fuehrende Nullen.
const BTC_DECIMAL_RE = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/;
// Obergrenze fuer einen ZU ZAHLENDEN Bitcoin-Betrag: 0,001 BTC (100.000 sat).
// Der Preis ist 2,99 EUR (rund 4.100 sat bei 73.000 EUR/BTC) - ein Vielfaches
// davon verlangt nur ein fehlerhafter oder boeswilliger Shop. Erst unter rund
// 3.000 EUR/BTC muesste die Grenze angehoben werden.
export const BTC_MAX_PAY_SATS = 100000;
const BTC_TOTAL_SATS = 2100000000000000; // 21 Mio. BTC - Obergrenze fuer "received"

/** Bekannte Zahlungsarten (Kennung der Shop-API -> Waehrung, Anzeigename). */
export const PAYMENT_METHODS = Object.freeze({
  xmr: Object.freeze({ id: 'xmr', currency: 'XMR', name: 'Monero' }),
  btc: Object.freeze({ id: 'btc', currency: 'BTC', name: 'Bitcoin' }),
});
export const PAYMENT_METHOD_IDS = Object.freeze(['xmr', 'btc']);
export const isPaymentMethod = (id) => typeof id === 'string' && PAYMENT_METHOD_IDS.includes(id);
const EUR_RE = /^\d{1,6}\.\d{2}$/;
const ERROR_CODE_RE = /^[a-z_]{1,64}$/;
export const ORDER_STATUSES = ['pending', 'underpaid', 'unconfirmed', 'paid', 'expired', 'withdrawn'];
// Eingangsbestaetigung eines Widerrufs (Text vom Shop) - Obergrenze fuer Anzeige/Speicher.
const MAX_RECEIPT_CHARS = 8000;
const MAX_BODY_CHARS = 256 * 1024;   // gleiche Grenze wie im nativen Modul
const MAX_LICENSE_CHARS = 1024;      // LIZENZ_FORMAT.md 5.3

// Tor-Onion-Verbindungen brauchen beim ersten Mal oft 10-30 s (Deskriptor,
// Rendezvous); die Statusabfrage wartet im Shop bis zu 8 s auf die Wallet.
export const TIMEOUT_CREATE_MS = 120000;
export const TIMEOUT_STATUS_MS = 90000;

// Zustimmung zum vorzeitigen Erloeschen des Widerrufsrechts (digitale Inhalte).
// Wortgleich mit "consentText" aus GET /api/v1/info (shop/src/app.js) - der
// Test __tests__/license.shopClient.test.js prueft das. Eingebaut statt
// abgefragt: spart vor dem Kauf eine Tor-Anfrage; mit "consent": true
// bestaetigt die App genau diesen Text.
// Bleibt deshalb deutsch und wird NICHT uebersetzt: in anderen Sprachen zeigt
// die App (ProScreen) eine Uebersetzung (pro.consentText) und darunter diesen
// rechtlich verbindlichen deutschen Wortlaut.
export const CONSENT_TEXT = 'Ich verlange ausdrücklich, dass mit der Bereitstellung des Lizenznachweises vor Ablauf der Widerrufsfrist begonnen wird. Mir ist bekannt, dass ich mit Beginn der Bereitstellung mein Widerrufsrecht verliere.';

export class ShopError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ShopError';
    this.code = code;
    this.httpStatus = extra.httpStatus ?? null;
    this.retryAfterSec = extra.retryAfterSec ?? null;
  }
}

// Verstaendliche Texte fuer die Anzeige - eigene Tabelle statt des Textes
// aus der Shop-Antwort (eine Antwort ist nie Quelle fuer Anzeigetexte).
// Texte in locales/*.js (shop.err.*), angezeigt in der aktiven Sprache.
const MESSAGE_KEYS = {
  'nicht-konfiguriert': 'shop.err.nicht-konfiguriert',
  'tor-aus': 'shop.err.tor-aus',
  'nicht-erreichbar': 'shop.err.nicht-erreichbar',
  'antwort-ungueltig': 'shop.err.antwort-ungueltig',
  consent_required: 'shop.err.consent_required',
  invalid_device_code: 'shop.err.invalid_device_code',
  invalid_payment_method: 'shop.err.invalid_payment_method',
  invalid_json: 'shop.err.invalid_json',
  invalid_order_or_recovery_code: 'shop.err.invalid_order_or_recovery_code',
  not_found: 'shop.err.not_found',
  activation_limit_reached: 'shop.err.activation_limit_reached',
  rate_limited: 'shop.err.rate_limited',
  temporarily_locked: 'shop.err.temporarily_locked',
  exchange_rate_unavailable: 'shop.err.exchange_rate_unavailable',
  payment_backend_unavailable: 'shop.err.payment_backend_unavailable',
  busy: 'shop.err.busy',
  internal_error: 'shop.err.internal_error',
  payload_too_large: 'shop.err.rejected',
  unsupported_media_type: 'shop.err.rejected',
  withdrawal_expired: 'shop.err.withdrawal_expired',
  invalid_refund_address: 'shop.err.invalid_refund_address',
  already_refunded: 'shop.err.already_refunded',
};
export function shopErrorMessage(code) {
  return t(Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, code) ? MESSAGE_KEYS[code] : MESSAGE_KEYS['antwort-ungueltig']);
}
const fail = (code, extra) => new ShopError(code, shopErrorMessage(code), extra);

export function isShopConfigured() {
  return typeof SHOP_ONION === 'string' && ONION_V3_RE.test(SHOP_ONION)
    && Number.isInteger(SHOP_PORT) && SHOP_PORT > 0 && SHOP_PORT < 65536;
}

/**
 * Crockford-Base32-Eingabe normalisieren (wie shop/src/ids.js normalisieren):
 * Leerzeichen/Bindestriche weg, Grossbuchstaben, O->0, I/L->1. null, wenn
 * Laenge oder Zeichen nicht passen.
 */
export function normalizeCrockford(input, length) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== length || !/^[0-9A-HJKMNP-TV-Z]+$/.test(s)) return null;
  return s;
}
export const normalizeOrderId = (s) => normalizeCrockford(s, 16);
export const normalizeRecoveryCode = (s) => normalizeCrockford(s, 20);

function parseRetryAfter(v) {
  const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Eine Anfrage an den Shop ueber Tor. Rueckgabe: { status, json } (nur 2xx). */
async function request(method, path, body, timeoutMs) {
  if (!isShopConfigured()) throw fail('nicht-konfiguriert');
  const tor = NativeModules.MalachiTor;
  if (!tor || typeof tor.httpRequest !== 'function') throw fail('tor-aus');
  let res;
  try {
    res = await tor.httpRequest(SHOP_ONION, SHOP_PORT, method, path,
      body === undefined ? null : JSON.stringify(body), timeoutMs);
  } catch (e) {
    // Keine Fehlerdetails weiterreichen/loggen (koennten Adressen enthalten).
    throw fail(e && e.code === 'TOR_OFF' ? 'tor-aus' : 'nicht-erreichbar');
  }
  const status = res && res.status;
  const text = res && res.body;
  if (!Number.isInteger(status) || status < 100 || status > 599
      || typeof text !== 'string' || text.length > MAX_BODY_CHARS) {
    throw fail('antwort-ungueltig');
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (status >= 400) {
    const extra = { httpStatus: status, retryAfterSec: parseRetryAfter(res.retryAfter) };
    const code = json && typeof json === 'object' && json.error && typeof json.error === 'object'
      && typeof json.error.code === 'string' && ERROR_CODE_RE.test(json.error.code) ? json.error.code : null;
    if (code && MESSAGE_KEYS[code]) throw fail(code, extra);
    // Unbekannter Fehler (z. B. Tor-Fehlerseite, Proxy): Server-/Lastfehler
    // als "nicht erreichbar", alles andere als ungueltige Antwort.
    throw fail(status >= 500 || status === 429 ? 'nicht-erreichbar' : 'antwort-ungueltig', extra);
  }
  if (status < 200 || status > 299 || !json || typeof json !== 'object' || Array.isArray(json)) {
    throw fail('antwort-ungueltig', { httpStatus: status });
  }
  return { status, json };
}

const isDecimal = (v) => typeof v === 'string' && DECIMAL_RE.test(v);
const smallInt = (v) => (Number.isInteger(v) && v >= 0 && v < 1000000 ? v : null);

// ── Bitcoin: Adresse (BIP173 bech32) und Betraege ─────────────────────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GENERATOR[i];
  }
  return chk >>> 0;
}

/**
 * Gueltige Bitcoin-Mainnet-Adresse vom Typ P2WPKH (bc1q..., Witness-Version 0,
 * 20 Byte Programm) mit korrekter bech32-Pruefsumme (BIP173, Konstante 1 -
 * also NICHT bech32m). Abgewiesen werden u. a. Testnet (tb1...), Taproot
 * (bc1p...), P2WSH (bc1q... mit 32 Byte), Legacy (1.../3...), Grossschreibung
 * und jede falsche Pruefsumme.
 */
export function isBtcAddress(addr) {
  if (typeof addr !== 'string' || !BTC_ADDRESS_RE.test(addr)) return false;
  const values = [3, 3, 0, 2, 3]; // hrp "bc" erweitert: [b>>5, c>>5, 0, b&31, c&31]
  for (const c of addr.slice(3)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) return false;
    values.push(v);
  }
  // 1 (Version) + 32 (160 Bit Programm = genau 20 Byte, keine Fuellbits) + 6 (Pruefsumme)
  if (values.length !== 5 + 39 || values[5] !== 0) return false;
  return bech32Polymod(values) === 1;
}

/** "0.00004087" -> 4087 (sat); null bei ungueltigem Format. */
export function btcToSats(v) {
  if (typeof v !== 'string' || !BTC_DECIMAL_RE.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return parseInt(whole, 10) * 100000000 + parseInt(frac.padEnd(8, '0'), 10);
}
/** Zu zahlender Bitcoin-Betrag: Format ok, mindestens 1 sat, hoechstens BTC_MAX_PAY_SATS. */
export function isBtcPayAmount(v) {
  const sats = btcToSats(v);
  return sats !== null && sats >= 1 && sats <= BTC_MAX_PAY_SATS;
}
const btcField = (v, max) => {
  const sats = btcToSats(v);
  return sats !== null && sats <= max ? v : null;
};

/**
 * Prueft eine Bestellung aus der Shop-Antwort und gibt NUR die gepruften
 * Felder zurueck (nichts aus der Antwort wird ungeprueft durchgereicht).
 * Die Zahlungs-URI fuer den QR-Code wird aus Adresse und Betrag selbst
 * gebaut, nicht aus "paymentUri" der Antwort uebernommen.
 */
export function parseOrder(j, { expectRecoveryCode = false, expectedOrderId = null, expectedMethod = null, expectedAddress = null } = {}) {
  const bad = () => { throw fail('antwort-ungueltig'); };
  if (!j || typeof j !== 'object' || Array.isArray(j)) bad();
  if (typeof j.orderId !== 'string' || !ORDER_ID_RE.test(j.orderId)) bad();
  if (expectedOrderId && j.orderId !== expectedOrderId) bad();
  if (!ORDER_STATUSES.includes(j.status)) bad();
  // Nur Monero oder Bitcoin - Kennung und Waehrung muessen zusammenpassen.
  // ("paymentMethod" darf nur bei Monero fehlen: aeltere Shop-Antworten.)
  let method = null;
  if (j.currency === 'XMR' && (j.paymentMethod === undefined || j.paymentMethod === 'xmr')) method = 'xmr';
  else if (j.currency === 'BTC' && j.paymentMethod === 'btc') method = 'btc';
  else bad();
  // Kein Wechsel der Zahlungsart gegenueber Bestellung bzw. Anfrage.
  if (expectedMethod && method !== expectedMethod) bad();
  const btc = method === 'btc';
  const expiresAt = typeof j.expiresAt === 'string' && j.expiresAt.length <= 40 ? Date.parse(j.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt)) bad();

  const o = {
    orderId: j.orderId,
    status: j.status,
    paymentMethod: method,
    currency: PAYMENT_METHODS[method].currency,
    expiresAt,
    minConfirmations: smallInt(j.minConfirmations),
    confirmations: smallInt(j.confirmations),
    address: null,
    amount: null,
    missing: btc ? btcField(j.missing, BTC_MAX_PAY_SATS) : (isDecimal(j.missing) ? j.missing : null),
    received: btc ? btcField(j.received, BTC_TOTAL_SATS) : (isDecimal(j.received) ? j.received : null),
    eurPrice: typeof j.eurPrice === 'string' && EUR_RE.test(j.eurPrice) ? j.eurPrice : null,
  };
  // Zahlungsdaten: wo noch gezahlt werden soll, zwingend und gueltig; sonst
  // nur uebernommen, wenn gueltig.
  const addressOk = btc ? isBtcAddress(j.address) : (typeof j.address === 'string' && XMR_ADDRESS_RE.test(j.address));
  const amountOk = btc ? isBtcPayAmount(j.amount) : isDecimal(j.amount);
  if ((o.status === 'pending' || o.status === 'underpaid' || expectRecoveryCode) && !(addressOk && amountOk)) bad();
  if (addressOk && amountOk) {
    // Die Zahlungsadresse einer Bestellung aendert sich nie.
    if (expectedAddress && j.address !== expectedAddress) bad();
    o.address = j.address;
    o.amount = j.amount;
  }
  if (expectRecoveryCode) {
    // Nur in der Antwort auf die Bestellanlage (POST /api/v1/orders).
    if (o.status !== 'pending') bad();
    if (typeof j.recoveryCode !== 'string' || !RECOVERY_CODE_RE.test(j.recoveryCode)) bad();
    o.recoveryCode = j.recoveryCode;
  }
  if (o.status === 'withdrawn') {
    const at = typeof j.withdrawnAt === 'string' && j.withdrawnAt.length <= 40 ? Date.parse(j.withdrawnAt) : NaN;
    if (!Number.isFinite(at)) bad();
    o.withdrawnAt = at;
  }
  if (o.status === 'paid') {
    if (typeof j.license !== 'string' || j.license.length > MAX_LICENSE_CHARS || !j.license.startsWith('ML1.')) bad();
    o.license = j.license;
    o.activations = smallInt(j.activations);
    o.maxActivations = smallInt(j.maxActivations);
  }
  return o;
}

/** monero:-URI fuer QR-Code/Wallet - aus gepruefter Adresse und Betrag gebaut. */
export function moneroPaymentUri(order) {
  if (!order || !order.address) return null;
  const amount = order.status === 'underpaid' && order.missing ? order.missing : order.amount;
  return 'monero:' + order.address + (amount ? '?tx_amount=' + amount : '');
}

/**
 * Zahlungsart einer (gespeicherten) Bestellung. Bestellungen aus der Zeit vor
 * Bitcoin haben kein "paymentMethod" - sie sind immer Monero.
 */
export function orderPaymentMethod(order) {
  if (!order || typeof order !== 'object') return null;
  if (order.paymentMethod === 'btc' || (order.paymentMethod === undefined && order.currency === 'BTC')) return 'btc';
  return 'xmr';
}

/**
 * Noch zu zahlender Betrag (Text in der Waehrung der Bestellung) oder null.
 * Bitcoin wird hier erneut geprueft (auch gespeicherte Bestellungen).
 */
export function paymentAmount(order) {
  if (!order) return null;
  if (orderPaymentMethod(order) === 'btc') {
    if (order.status === 'underpaid' && isBtcPayAmount(order.missing)) return order.missing;
    return isBtcPayAmount(order.amount) ? order.amount : null;
  }
  return order.status === 'underpaid' && order.missing ? order.missing : order.amount;
}

/**
 * Zahlungs-URI fuer QR-Code/Wallet, aus gepruefter Adresse und Betrag gebaut:
 * monero:<adresse>?tx_amount=<betrag> bzw. bitcoin:<adresse>?amount=<betrag> (BIP21).
 * Bitcoin nur mit gueltiger bc1q-Adresse UND gueltigem Betrag, sonst null.
 */
export function paymentUri(order) {
  if (!order || !order.address) return null;
  if (orderPaymentMethod(order) !== 'btc') return moneroPaymentUri(order);
  const amount = paymentAmount(order);
  if (!isBtcAddress(order.address) || !amount) return null;
  return 'bitcoin:' + order.address + '?amount=' + amount;
}

/**
 * Zahlungsarten aus GET /api/v1/info: nur bekannte Kennungen mit passender
 * Waehrung, ohne Doppelte, in fester eigener Reihenfolge (Monero, Bitcoin).
 * Namen/Texte des Shops werden nicht uebernommen.
 */
export function parsePaymentMethods(list) {
  if (!Array.isArray(list) || list.length > 16) return [];
  const offered = new Set();
  for (const m of list) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || !isPaymentMethod(m.id)) continue;
    if (m.currency === PAYMENT_METHODS[m.id].currency) offered.add(m.id);
  }
  return PAYMENT_METHOD_IDS.filter((id) => offered.has(id));
}

// ── API ────────────────────────────────────────────────────────────────────

/** GET /api/v1/info - nur zur Anzeige/Kontrolle (Schluessel daraus werden NIE verwendet). */
export async function getShopInfo() {
  const { json } = await request('GET', '/api/v1/info', undefined, TIMEOUT_STATUS_MS);
  const paymentMethods = parsePaymentMethods(json.paymentMethods);
  const def = json.defaultPaymentMethod;
  return {
    priceEur: typeof json.priceEur === 'string' && EUR_RE.test(json.priceEur) ? json.priceEur : null,
    consentRequired: json.consentRequired !== false,
    maxActivations: smallInt(json.maxActivations),
    paymentMethods,
    defaultPaymentMethod: isPaymentMethod(def) && paymentMethods.includes(def) ? def : (paymentMethods[0] || null),
    acceptsXmr: paymentMethods.includes('xmr'),
  };
}

/**
 * POST /api/v1/orders - legt eine Bestellung fuer diesen Geraetecode an.
 * paymentMethod: 'xmr' (Standard) oder 'btc'; die Antwort muss genau diese
 * Zahlungsart haben.
 */
export async function createOrder({ deviceCode, consent, paymentMethod = 'xmr' }) {
  if (consent !== true) throw fail('consent_required');
  if (typeof deviceCode !== 'string' || !/^[A-Z2-7]{34}$/.test(deviceCode)) throw fail('invalid_device_code');
  if (!isPaymentMethod(paymentMethod)) throw fail('invalid_payment_method');
  const { status, json } = await request('POST', '/api/v1/orders',
    { deviceCode, consent: true, paymentMethod }, TIMEOUT_CREATE_MS);
  if (status !== 201 && status !== 200) throw fail('antwort-ungueltig');
  return parseOrder(json, { expectRecoveryCode: true, expectedMethod: paymentMethod });
}

/**
 * GET /api/v1/orders/:orderId - Zahlungsstatus; bei "paid" mit Lizenz.
 * expected.paymentMethod / expected.address (aus der gespeicherten Bestellung):
 * eine Antwort mit anderer Zahlungsart oder anderer Adresse wird abgewiesen.
 */
export async function getOrder(orderId, expected = {}) {
  const id = normalizeOrderId(orderId);
  if (!id) throw fail('not_found');
  const exp = expected && typeof expected === 'object' ? expected : {};
  const { json } = await request('GET', '/api/v1/orders/' + id, undefined, TIMEOUT_STATUS_MS);
  return parseOrder(json, {
    expectedOrderId: id,
    expectedMethod: isPaymentMethod(exp.paymentMethod) ? exp.paymentMethod : null,
    expectedAddress: typeof exp.address === 'string' && exp.address ? exp.address : null,
  });
}

/**
 * POST /api/v1/orders/:orderId/withdraw - "Vertrag widerrufen" (§ 356a BGB).
 * confirm=false prueft nur (Vorschau), confirm=true erklaert den Widerruf.
 * Rueckgabe: Bestellung (bei Widerruf mit status "withdrawn") plus
 * Eingangsbestaetigung (Text) und gespeicherte Rueckzahlungsadresse.
 * Name und Rueckzahlungsadresse sind freiwillig; die Adresse prueft der Shop
 * mit Pruefsumme.
 */
export async function withdrawOrder({ orderId, recoveryCode, refundAddress = '', name = '', confirm = false, expected = {} }) {
  const id = normalizeOrderId(orderId);
  const code = normalizeRecoveryCode(recoveryCode);
  if (!id || !code) throw fail('invalid_order_or_recovery_code');
  const body = { recoveryCode: code, confirm: confirm === true };
  const addr = typeof refundAddress === 'string' ? refundAddress.trim() : '';
  if (addr) {
    if (addr.length > 120) throw fail('invalid_refund_address');
    body.refundAddress = addr;
  }
  const nm = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  if (nm) body.name = nm;
  const { json } = await request('POST', '/api/v1/orders/' + id + '/withdraw', body, TIMEOUT_CREATE_MS);
  const exp = expected && typeof expected === 'object' ? expected : {};
  const order = parseOrder(json, {
    expectedOrderId: id,
    expectedMethod: isPaymentMethod(exp.paymentMethod) ? exp.paymentMethod : null,
  });
  if (confirm === true && order.status !== 'withdrawn') throw fail('antwort-ungueltig');
  let receipt = null;
  if (order.status === 'withdrawn') {
    if (typeof json.receipt !== 'string' || !json.receipt.length || json.receipt.length > MAX_RECEIPT_CHARS) throw fail('antwort-ungueltig');
    receipt = json.receipt;
  }
  const refund = typeof json.refundAddress === 'string' && json.refundAddress.length <= 120 ? json.refundAddress : null;
  return { order, receipt, refundAddress: refund, newWithdrawal: json.newWithdrawal === true };
}

/** POST /api/v1/transfer - Lizenz mit Bestellnummer + Wiederherstellungscode auf dieses Geraet umziehen. */
export async function transferLicense({ orderId, recoveryCode, deviceCode }) {
  const id = normalizeOrderId(orderId);
  const code = normalizeRecoveryCode(recoveryCode);
  if (!id || !code) throw fail('invalid_order_or_recovery_code');
  if (typeof deviceCode !== 'string' || !/^[A-Z2-7]{34}$/.test(deviceCode)) throw fail('invalid_device_code');
  const { json } = await request('POST', '/api/v1/transfer',
    { orderId: id, recoveryCode: code, deviceCode }, TIMEOUT_CREATE_MS);
  if (typeof json.orderId !== 'string' || json.orderId !== id) throw fail('antwort-ungueltig');
  if (typeof json.license !== 'string' || json.license.length > MAX_LICENSE_CHARS || !json.license.startsWith('ML1.')) {
    throw fail('antwort-ungueltig');
  }
  return {
    orderId: id,
    license: json.license,
    activations: smallInt(json.activations),
    maxActivations: smallInt(json.maxActivations),
    newActivation: json.newActivation === true,
  };
}
