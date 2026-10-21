// Vollversion ("Pro"): Geraetebindung, lokale Lizenzpruefung, Kauf ueber Tor
// und die Freischaltregeln der Pro-Funktionen.
//
// Spezifikation: shop/LIZENZ_FORMAT.md. Pruefung: LicenseFormat.js (1:1-Kopie
// der Shop-Referenz). Shop-Anfragen: ShopClient.js (nur ueber Tor).
//
// Ablauf:
//  - Geraetecode: aus dem oeffentlichen P-256-Schluessel im Android Keystore
//    (NativeModules.MalachiDeviceKey, Alias "malachi_geraet_v1", nicht
//    exportierbar). Deinstallation loescht den Schluessel - gewollt: eine
//    kopierte App-Sicherung wird auf einem anderen Geraet nicht gueltig, der
//    Umzug laeuft ueber Bestellnummer + Wiederherstellungscode.
//  - Lizenz ("ML1.<nutzdaten>.<signatur>") liegt im verschluesselten Speicher
//    und wird beim Start und bei jeder Aenderung komplett neu geprueft:
//    Ed25519-Signatur mit einem EINGEBAUTEN Schluessel (AppConfig.
//    LICENSE_PUBLIC_KEY) UND dev == eigener Geraetecode UND feat enthaelt
//    "pro". Offline, ohne Kontakt zum Shop.
//  - Es gibt KEINE Hintertuer und keine Entwickler-Freischaltung: Pro ist
//    ausschliesslich mit einer gueltigen, signierten Lizenz fuer genau dieses
//    Geraet aktiv. Ohne eingebauten Schluessel (vor dem Shop-Deployment) ist
//    Pro immer gesperrt.
//
// Datenschutz: Lizenzen, Wiederherstellungscodes, Bestellnummern und
// Zahlungsadressen werden NIE geloggt.
//
// Google-Play-Variante (Distribution.isPlay(), PLAY_STORE.md): dort gibt es
// keinen Shop, keinen Geraetecode und keine Lizenztexte. Pro kommt
// ausschliesslich aus einem Google-Play-Kauf (In-App-Produkt
// AppConfig.PLAY_PRODUCT_ID), der OHNE Server auf dem Geraet geprueft wird
// (PlayPurchase.verifyPlayPurchase: Signatur mit AppConfig.
// PLAY_LICENSE_PUBLIC_KEY, eigener Paketname, Produkt, Status "gekauft").
//  - Ausstehende Zahlungen schalten nie frei.
//  - Ein frischer Kauf wird lokal vermerkt (nur SHA-256 des Kauf-Tokens,
//    PLAY_STORAGE_KEY) und danach bei Google Play bestaetigt
//    (acknowledge - sonst erstattet Google ihn nach drei Tagen).
//  - Bei jedem Start werden die eigenen Kaeufe neu abgefragt. Fehlt der Kauf
//    in einer ECHTEN Antwort von Google Play (Erstattung, Rueckbuchung), wird
//    Pro lokal entzogen. Keine Antwort (Play Store aus, kein Netz) entzieht
//    nichts - ein eingerichteter Schutz faellt nie wegen eines Funklochs weg.
//  - Ohne lokalen Vermerk (Neuinstallation, "Alle Daten loeschen", Duress-
//    Loeschung) wird ein alter Kauf NICHT von selbst wieder aktiv, sondern
//    erst mit "Kaeufe wiederherstellen" - eine frisch geloeschte App verraet
//    so nicht von allein, dass es Pro gab.
// Die oeffentliche Schnittstelle (getLicenseState, subscribeLicense, isPro,
// isProVerified, refreshLicense, Gating-Regeln) ist in beiden Varianten gleich.

import { NativeModules } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import { Buffer } from 'buffer';
import { LICENSE_PUBLIC_KEY, PRO_PRICE_EUR, PLAY_LICENSE_PUBLIC_KEY, PLAY_PRODUCT_ID } from './AppConfig';
import { pruefeLizenz, geraetecodeAusSpki, geraetecodeGruppieren, base64urlDekodieren } from './LicenseFormat';
import * as Shop from './ShopClient';
import { isPlay, getApplicationId, DISTRIBUTION_PLAY, DISTRIBUTION_WEB } from './Distribution';
import * as PlayBilling from './PlayBilling';
import { verifyPlayPurchase, purchaseTokenHash, parseRsaPublicKey } from './PlayPurchase';
import { t } from './i18n';

export const LICENSE_STORAGE_KEY = 'pro_license_v1';
export const PURCHASE_STORAGE_KEY = 'pro_purchase_v1';
// Play-Variante: Vermerk eines geprueften Google-Play-Kaufs (nur Hash des Tokens).
export const PLAY_STORAGE_KEY = 'pro_play_v1';

// SubjectPublicKeyInfo-Kopf fuer P-256 mit unkomprimiertem Punkt (LIZENZ_FORMAT.md 3.2).
const SPKI_P256_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const SPKI_P256_LENGTH = 91;
const DEVICE_CODE_RE = /^[A-Z2-7]{34}$/;
// Abfrageintervall der UI waehrend einer offenen Bestellung (Shop empfiehlt 30-60 s).
export const PURCHASE_POLL_MS = 20000;
// Status, bei denen noch eine Zahlung erwartet bzw. bestaetigt wird.
const OPEN_STATUSES = ['pending', 'underpaid', 'unconfirmed'];

// ── Hilfen ─────────────────────────────────────────────────────────────────

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

/**
 * Geraetecode aus dem oeffentlichen Geraeteschluessel (SPKI-DER, base64 wie
 * vom nativen Modul geliefert). Nur echte P-256-SPKI werden akzeptiert.
 */
export function deviceCodeFromSpkiBase64(spkiBase64) {
  if (typeof spkiBase64 !== 'string' || spkiBase64.length < 100 || spkiBase64.length > 200
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(spkiBase64)) {
    throw new Error('Geraeteschluessel: unerwartetes Format');
  }
  const spki = Uint8Array.from(Buffer.from(spkiBase64, 'base64'));
  if (spki.length !== SPKI_P256_LENGTH
      || bytesToHex(spki.subarray(0, SPKI_P256_PREFIX_HEX.length / 2)) !== SPKI_P256_PREFIX_HEX
      || spki[SPKI_P256_PREFIX_HEX.length / 2] !== 0x04) {
    throw new Error('Geraeteschluessel: kein P-256-SPKI');
  }
  return geraetecodeAusSpki(spki);
}

/** "ABCD-EFGH-..." zur Anzeige. */
export function formatDeviceCode(code) {
  return typeof code === 'string' && DEVICE_CODE_RE.test(code) ? geraetecodeGruppieren(code) : '';
}
/** Bestellnummer/Wiederherstellungscode in Vierergruppen. */
export function formatGroups(s) {
  return typeof s === 'string' && s ? s.match(/.{1,4}/g).join('-') : '';
}

/**
 * Eingebaute oeffentliche Lizenzschluessel (AppConfig.LICENSE_PUBLIC_KEY:
 * base64url-Text oder Liste davon, je 32 Byte). Ungueltige Eintraege werden
 * ignoriert. Leere Liste = Lizenzpruefung nicht moeglich = Pro gesperrt.
 */
export function builtinLicenseKeys() {
  const cfg = LICENSE_PUBLIC_KEY;
  const list = Array.isArray(cfg) ? cfg : (cfg == null ? [] : [cfg]);
  const keys = [];
  for (const k of list) {
    if (typeof k !== 'string') continue;
    try {
      const b = base64urlDekodieren(k);
      if (b.length === 32) keys.push(b);
    } catch { /* ungueltiger Eintrag - ignorieren */ }
  }
  return keys;
}

/**
 * Kann ueberhaupt eine Lizenz geprueft werden (Schluessel eingebaut)?
 * Website-Variante: Shop-Lizenzschluessel; Play-Variante: RSA-Schluessel aus
 * der Play Console.
 */
export function isLicenseCheckAvailable() {
  return isPlay() ? isPlayCheckAvailable() : builtinLicenseKeys().length > 0;
}
/** Shop-Kauf moeglich (nur Website-Variante: Schluessel UND Shop-Adresse eingebaut)? */
function isShopPurchaseAvailable() {
  return !isPlay() && builtinLicenseKeys().length > 0 && Shop.isShopConfigured();
}
/**
 * Ist der Kauf in der App moeglich? Website-Variante: Shop eingerichtet.
 * Play-Variante: Play-Schluessel eingetragen und Google Play Billing vorhanden.
 */
export function isPurchaseAvailable() {
  return isPlay() ? isPlayPurchaseAvailable() : isShopPurchaseAvailable();
}

/** Play-Variante: gueltiger oeffentlicher RSA-Schluessel in AppConfig eingetragen? */
let playKeyChecked = { key: undefined, ok: false };
export function isPlayCheckAvailable() {
  const key = PLAY_LICENSE_PUBLIC_KEY;
  if (typeof key !== 'string' || !key) return false;
  if (playKeyChecked.key !== key) {
    let ok = false;
    try { parseRsaPublicKey(key); ok = true; } catch { ok = false; }
    playKeyChecked = { key, ok };
  }
  return playKeyChecked.ok;
}
/** Play-Variante: Kauf ueber Google Play moeglich (Schluessel, Billing-Modul, eigener Paketname)? */
export function isPlayPurchaseAvailable() {
  return isPlay() && isPlayCheckAvailable() && PlayBilling.isBillingModuleAvailable() && getApplicationId() !== null;
}
function playProductId() {
  return typeof PLAY_PRODUCT_ID === 'string' && PLAY_PRODUCT_ID ? PLAY_PRODUCT_ID : 'malachi_pro';
}

/**
 * Prueft einen Lizenztext vollstaendig lokal (LIZENZ_FORMAT.md Abschnitt 6):
 * Signatur mit eingebautem Schluessel, Bindung an DIESES Geraet, Feature "pro".
 * Ohne gueltigen Geraetecode wird NIE geprueft (die Referenzfunktion wuerde
 * die Geraetebindung sonst ueberspringen).
 */
export function verifyLicense(text, deviceCode) {
  const keys = builtinLicenseKeys();
  if (keys.length === 0) return { gueltig: false, grund: 'nicht-konfiguriert' };
  if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) {
    return { gueltig: false, grund: 'kein-geraeteschluessel' };
  }
  if (typeof text !== 'string') return { gueltig: false, grund: 'format' };
  return pruefeLizenz(text.trim(), { oeffentlicheSchluessel: keys, geraetecode: deviceCode, feature: 'pro' });
}

// Anzeigetexte zu den Pruefergebnissen: Schluessel fuer die Uebersetzung
// (locales/*.js, license.err.*), Text in der aktiven Sprache.
const LICENSE_MESSAGE_KEYS = {
  'format': 'license.err.format',
  'kodierung': 'license.err.kodierung',
  'signatur': 'license.err.signatur',
  'inhalt': 'license.err.inhalt',
  'nicht-kanonisch': 'license.err.inhalt',
  'anderes-geraet': 'license.err.anderes-geraet',
  'feature': 'license.err.feature',
  'nicht-konfiguriert': 'license.err.nicht-konfiguriert',
  'kein-geraeteschluessel': 'license.err.kein-geraeteschluessel',
  // Play-Variante (Gruende aus PlayPurchase.verifyPlayPurchase mit Praefix "play-")
  'play-format': 'license.err.play-format',
  'play-signatur': 'license.err.play-signatur',
  'play-paket': 'license.err.play-paket',
  'play-produkt': 'license.err.feature',
  'play-ausstehend': 'license.err.play-ausstehend',
  'play-status': 'license.err.play-status',
  'play-nicht-konfiguriert': 'play.err.unavailable',
  'play-widerrufen': 'license.err.play-widerrufen',
};
export function licenseErrorMessage(grund) {
  if (Object.prototype.hasOwnProperty.call(LICENSE_MESSAGE_KEYS, grund)) return t(LICENSE_MESSAGE_KEYS[grund]);
  return t(isPlay() ? 'license.err.playDefault' : 'license.err.default');
}

// Meldungen zu Google-Play-Antworten (BillingResponseCode, PlayBilling.js).
const PLAY_RESPONSE_KEYS = {
  'USER_CANCELED': 'play.err.canceled',
  'SERVICE_UNAVAILABLE': 'play.err.offline',
  'NETWORK_ERROR': 'play.err.offline',
  'SERVICE_DISCONNECTED': 'play.err.disconnected',
  'SERVICE_TIMEOUT': 'play.err.timeout',
  'BILLING_UNAVAILABLE': 'play.err.billingUnavailable',
  'ITEM_UNAVAILABLE': 'play.err.itemUnavailable',
  'ITEM_ALREADY_OWNED': 'play.err.alreadyOwned',
  'DEVELOPER_ERROR': 'play.err.unavailable',
  'FEATURE_NOT_SUPPORTED': 'play.err.notSupported',
  'nicht-verfuegbar': 'play.err.unavailable',
  'nicht-konfiguriert': 'play.err.unavailable',
};
export function playErrorMessage(code) {
  return t(Object.prototype.hasOwnProperty.call(PLAY_RESPONSE_KEYS, code) ? PLAY_RESPONSE_KEYS[code] : 'play.err.default');
}

// ── Zustand ────────────────────────────────────────────────────────────────

function initialState() {
  return {
    loaded: false,
    pro: false,
    // 'aktiv' | 'keine-lizenz' | 'nicht-konfiguriert' | 'kein-geraeteschluessel' | Grund aus pruefeLizenz
    reason: 'keine-lizenz',
    deviceCode: null,
    deviceKeyLevel: null,     // 'strongbox' | 'tee' | 'software' | 'unbekannt'
    licenseInfo: null,        // { lic, ord, iat } der gueltigen Lizenz (nur Anzeige)
    purchase: null,           // laufende/abgeschlossene Bestellung, siehe startPurchase()
    shopMethods: null,        // { methods: ['xmr', 'btc'], defaultMethod } laut Shop, siehe loadShopPaymentMethods()
    licenseCheckAvailable: isLicenseCheckAvailable(),
    purchaseAvailable: isPurchaseAvailable(),
    // Vertriebsvariante (Distribution.js) - die Felder play* gibt es nur in "play".
    distribution: isPlay() ? DISTRIBUTION_PLAY : DISTRIBUTION_WEB,
    playProduct: null,        // { productId, title, price, priceMicros, currency } von Google Play
    playProductError: null,   // Text, falls die Produktdetails nicht abrufbar waren
    playPending: false,       // Kauf angestossen, Zahlung bei Google Play noch ausstehend
    playInfo: null,           // { purchaseTime } des geprueften Kaufs (nur Anzeige)
    playError: null,          // letzte Fehlermeldung (Anzeige)
    playNotice: null,         // letzte Hinweismeldung, z. B. "Kauf abgebrochen." (Anzeige)
    playRestorable: false,    // gekauft, aber (noch) nicht wiederhergestellt
  };
}
let state = initialState();
const listeners = new Set();
let hooks = { ensureTor: null };
let cachedDevice = null;      // { code, level } - Keystore-Schluessel ist pro Installation fest

function setState(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) { try { l(state); } catch { /* Anzeige darf nie stoeren */ } }
}

export function getLicenseState() { return state; }
/** Abo fuer die UI: fn(state) sofort und bei jeder Aenderung. Rueckgabe: Abmelden. */
export function subscribeLicense(fn) {
  listeners.add(fn);
  try { fn(state); } catch {}
  return () => { listeners.delete(fn); };
}
/** Synchron, aus dem zuletzt geprueften Zustand. */
export function isPro() { return state.pro === true; }
/** Wie isPro(), prueft aber vorher einmal, falls noch nicht geschehen. */
export async function isProVerified() {
  if (!state.loaded) {
    try { await refreshLicense(); } catch { /* bleibt gesperrt */ }
  }
  return state.pro === true;
}

/** App.tsx reicht ensureTorRunning herein (vermeidet den Import von TorTransport hier). */
export function configureLicenseManager(h) { hooks = { ...hooks, ...h }; }

// ── Geraeteschluessel ──────────────────────────────────────────────────────

async function loadDevice() {
  if (cachedDevice) return cachedDevice;
  const mod = NativeModules.MalachiDeviceKey;
  if (!mod || typeof mod.getOrCreatePublicKey !== 'function') throw new Error('kein-geraeteschluessel');
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await mod.getOrCreatePublicKey();
      const code = deviceCodeFromSpkiBase64(r && r.spki);
      const level = r && typeof r.security === 'string' ? r.security : 'unbekannt';
      cachedDevice = { code, level };
      return cachedDevice;
    } catch (e) {
      lastError = e;
      if (attempt === 0) await new Promise((res) => setTimeout(res, 300));
    }
  }
  throw lastError || new Error('kein-geraeteschluessel');
}

/** Eigener Geraetecode (34 Zeichen, ohne Bindestriche). Wirft, wenn der Keystore nicht verfuegbar ist. */
export async function getDeviceCode() {
  return (await loadDevice()).code;
}

// ── Pruefen und Speichern ─────────────────────────────────────────────────

async function readPurchase() {
  try {
    const raw = await EncryptedStorage.getItem(PURCHASE_STORAGE_KEY);
    if (!raw) return null;
    return sanitizePurchase(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Nur bekannte Felder mit gueltigen Formaten aus dem Speicher uebernehmen. */
function sanitizePurchase(p) {
  if (!p || typeof p !== 'object') return null;
  const orderId = Shop.normalizeOrderId(p.orderId);
  if (!orderId) return null;
  const recoveryCode = p.recoveryCode ? Shop.normalizeRecoveryCode(p.recoveryCode) : null;
  let order = null;
  if (p.order && typeof p.order === 'object' && p.order.orderId === orderId
      && Shop.ORDER_STATUSES.includes(p.order.status)) {
    order = { ...p.order };
    delete order.license;
    delete order.recoveryCode;
  }
  return {
    orderId,
    recoveryCode,
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
    order,
    done: p.done === true,
    gone: p.gone === true,
    error: typeof p.error === 'string' ? p.error.slice(0, 300) : null,
    lastCheckedAt: Number.isFinite(p.lastCheckedAt) ? p.lastCheckedAt : 0,
    recoveryAcknowledged: p.recoveryAcknowledged === true,
    withdrawal: sanitizeWithdrawal(p.withdrawal),
  };
}

/** Widerruf einer Bestellung (Zeitpunkt, Eingangsbestaetigung, Rueckzahlungsadresse) - nur gueltige Felder. */
function sanitizeWithdrawal(w) {
  if (!w || typeof w !== 'object') return null;
  if (!Number.isFinite(w.at) || typeof w.receipt !== 'string' || !w.receipt || w.receipt.length > 8000) return null;
  return {
    at: w.at,
    receipt: w.receipt,
    refundAddress: typeof w.refundAddress === 'string' && w.refundAddress.length <= 120 ? w.refundAddress : null,
  };
}

async function savePurchase(rec) {
  if (rec) await EncryptedStorage.setItem(PURCHASE_STORAGE_KEY, JSON.stringify(rec));
  else await EncryptedStorage.removeItem(PURCHASE_STORAGE_KEY);
}

async function evaluateStored() {
  let text = null;
  try { text = await EncryptedStorage.getItem(LICENSE_STORAGE_KEY); } catch { text = null; }
  let device = null;
  try { device = await loadDevice(); } catch { device = null; }
  const base = {
    deviceCode: device ? device.code : null,
    deviceKeyLevel: device ? device.level : null,
    licenseCheckAvailable: isLicenseCheckAvailable(),
    purchaseAvailable: isPurchaseAvailable(),
  };
  if (!text) return { ...base, pro: false, reason: 'keine-lizenz', licenseInfo: null };
  const v = verifyLicense(text, base.deviceCode);
  if (!v.gueltig) return { ...base, pro: false, reason: v.grund, licenseInfo: null };
  return { ...base, pro: true, reason: 'aktiv', licenseInfo: { lic: v.daten.lic, ord: v.daten.ord, iat: v.daten.iat } };
}

// Pruefungen laufen nacheinander (nie parallel), damit eine spaete Pruefung
// nie das Ergebnis einer frueheren mit altem Speicherstand ueberschreibt.
let refreshChain = Promise.resolve();
/** Lizenz aus dem Speicher laden und vollstaendig pruefen (beim Start und nach jeder Aenderung). */
export function refreshLicense() {
  const run = refreshChain.then(async () => {
    if (isPlay()) {
      // Play-Variante: eigene Kaeufe bei Google Play neu abfragen (Abschnitt unten).
      const gen = playGeneration;
      const result = await evaluatePlay({ restore: false });
      if (gen === playGeneration) setState({ ...result, purchase: null, loaded: true });
      if (!state.pro && state.purchaseAvailable && !state.playProduct) loadPlayProduct().catch(() => {});
      return state;
    }
    // Die Bestellung wird nur beim ersten Laden aus dem Speicher geholt -
    // danach aendern sie ausschliesslich die Kauf-Funktionen unten (die sie
    // jeweils selbst speichern), eine spaete Pruefung ueberschreibt sie nie.
    const [result, purchase] = await Promise.all([
      evaluateStored(),
      state.loaded ? Promise.resolve(state.purchase) : readPurchase(),
    ]);
    setState({ ...result, purchase: state.loaded ? state.purchase : purchase, loaded: true });
    return state;
  });
  refreshChain = run.catch(() => {});
  return run;
}

/**
 * Lizenztext pruefen und - nur wenn gueltig fuer DIESES Geraet - speichern.
 * Rueckgabe: { ok: true } oder { ok: false, grund, message }.
 */
export async function installLicense(text) {
  // Play-Variante: keine Lizenztexte - Pro nur ueber einen Google-Play-Kauf.
  if (isPlay()) return { ok: false, grund: 'play', message: t('license.err.playOnly') };
  const licenseText = typeof text === 'string' ? text.trim() : '';
  let deviceCode = null;
  try { deviceCode = await getDeviceCode(); } catch { deviceCode = null; }
  const v = verifyLicense(licenseText, deviceCode);
  if (!v.gueltig) return { ok: false, grund: v.grund, message: licenseErrorMessage(v.grund) };
  try {
    await EncryptedStorage.setItem(LICENSE_STORAGE_KEY, licenseText);
  } catch {
    return { ok: false, grund: 'speicher', message: t('license.saveFailed') };
  }
  // "Bei jeder Aenderung pruefen": Ergebnis kommt aus dem frisch gelesenen Speicher.
  await refreshLicense();
  return state.pro
    ? { ok: true }
    : { ok: false, grund: state.reason, message: licenseErrorMessage(state.reason) };
}

// ── Kauf ueber Tor ─────────────────────────────────────────────────────────

const shopFail = (code, message) => new Shop.ShopError(code, message || Shop.shopErrorMessage(code));

async function ensureTor() {
  if (typeof hooks.ensureTor !== 'function') return;
  let ok = false;
  try { ok = await hooks.ensureTor(); } catch { ok = false; }
  if (ok === false) throw shopFail('tor-aus');
}

async function deviceCodeForShop() {
  try {
    return await getDeviceCode();
  } catch {
    throw shopFail('kein-geraeteschluessel', licenseErrorMessage('kein-geraeteschluessel'));
  }
}

/**
 * Ist die gespeicherte Bestellung noch offen (Zahlung erwartet/unterwegs)?
 * Bewusst unabhaengig von der eigenen Uhr: ob eine Bestellung abgelaufen ist,
 * entscheidet der Shop ("expired" bzw. 404) - eine kurz vor Fristende
 * gesendete Zahlung darf nicht verloren gehen, nur weil lokal die Zeit um ist.
 */
export function isPurchaseOpen(p) {
  return !!(p && !p.done && !p.gone && p.order && OPEN_STATUSES.includes(p.order.status));
}
/** Lokale Anzeige: Zahlungsfrist einer unbezahlten Bestellung laut Uhr vorbei. */
export function isPaymentWindowOver(p, now = Date.now()) {
  return !!(p && p.order && p.order.status === 'pending' && Number.isFinite(p.order.expiresAt) && now > p.order.expiresAt);
}

let methodsPromise = null;
/**
 * Zahlungsarten, die der Shop gerade anbietet (GET /api/v1/info ueber Tor),
 * nur bekannte ('xmr', 'btc'). Ergebnis landet in state.shopMethods (einmal
 * je App-Sitzung; Fehler werden geworfen, der naechste Aufruf versucht es
 * erneut). Ohne Antwort bleibt die UI bei Monero.
 */
export function loadShopPaymentMethods({ force = false } = {}) {
  if (!isShopPurchaseAvailable()) return Promise.resolve(null);
  if (state.shopMethods && !force) return Promise.resolve(state.shopMethods);
  if (methodsPromise) return methodsPromise;
  methodsPromise = (async () => {
    await ensureTor();
    const info = await Shop.getShopInfo();
    if (!info.paymentMethods.length) return null;
    const shopMethods = { methods: info.paymentMethods, defaultMethod: info.defaultPaymentMethod };
    setState({ shopMethods });
    return shopMethods;
  })();
  methodsPromise.then(() => { methodsPromise = null; }, () => { methodsPromise = null; });
  return methodsPromise;
}

/**
 * Neue Bestellung anlegen (POST /api/v1/orders mit dem eigenen Geraetecode
 * und der gewaehlten Zahlungsart 'xmr' (Standard) oder 'btc').
 * Der Wiederherstellungscode kommt nur in DIESER Antwort - er wird sofort
 * im verschluesselten Speicher abgelegt und der UI zum Aufschreiben gezeigt.
 * Laeuft schon eine offene Bestellung, wird sie zurueckgegeben statt eine
 * zweite anzulegen.
 */
export async function startPurchase({ consent, paymentMethod = 'xmr' } = {}) {
  if (!isShopPurchaseAvailable()) throw shopFail('nicht-konfiguriert');
  if (!Shop.isPaymentMethod(paymentMethod)) throw shopFail('invalid_payment_method');
  // Erst den gespeicherten Stand kennen - sonst koennte eine gespeicherte,
  // noch offene Bestellung durch eine zweite ueberschrieben werden.
  if (!state.loaded) await refreshLicense();
  if (state.pro) throw shopFail('schon-aktiv', t('license.alreadyActive'));
  if (consent !== true) throw shopFail('consent_required');
  if (isPurchaseOpen(state.purchase)) return state.purchase;
  // Eine bezahlte Bestellung (samt Wiederherstellungscode) nie durch eine
  // neue ersetzen - dafuer gibt es den Umzug mit den gespeicherten Daten.
  if (state.purchase && !canDismissPurchase(state.purchase)) {
    throw shopFail('bestellung-vorhanden', t('license.orderExists'));
  }
  const deviceCode = await deviceCodeForShop();
  await ensureTor();
  const order = await Shop.createOrder({ deviceCode, consent: true, paymentMethod });
  const { recoveryCode, ...orderFields } = order;
  const now = Date.now();
  const rec = {
    orderId: order.orderId,
    recoveryCode,
    createdAt: now,
    order: orderFields,
    done: false,
    gone: false,
    error: null,
    lastCheckedAt: now,
    recoveryAcknowledged: false,
  };
  // Zuerst speichern (Neustart der App setzt die Abfrage fort), dann anzeigen.
  // Schlaegt das Speichern fehl, wird trotzdem angezeigt - die UI fordert
  // ohnehin auf, Bestellnummer und Code aufzuschreiben.
  let saveError = null;
  try { await savePurchase(rec); } catch { saveError = t('license.orderSaveFailed'); }
  setState({ purchase: saveError ? { ...rec, error: saveError } : rec });
  return state.purchase;
}

let checkPromise = null;
/**
 * Zahlungsstatus der laufenden Bestellung abfragen (GET /api/v1/orders/:id).
 * Bei "paid" wird die Lizenz lokal geprueft und nur bei Gueltigkeit fuer
 * dieses Geraet gespeichert. Gleichzeitige Aufrufe teilen sich eine Abfrage.
 */
export function checkPurchase() {
  if (checkPromise) return checkPromise;
  checkPromise = (async () => {
    const rec = state.purchase;
    if (!rec || rec.done || rec.gone) return rec;
    await ensureTor();
    let next;
    try {
      // Zahlungsart und Adresse der Bestellung duerfen sich nie aendern.
      const order = await Shop.getOrder(rec.orderId, {
        paymentMethod: Shop.orderPaymentMethod(rec.order),
        address: rec.order && typeof rec.order.address === 'string' ? rec.order.address : null,
      });
      const { license, ...orderFields } = order;
      next = { ...rec, order: orderFields, lastCheckedAt: Date.now(), error: null };
      if (order.status === 'paid') {
        const r = await installLicense(license);
        if (r.ok) next.done = true;
        else next.error = t('license.paidMismatch', { message: r.message });
      }
    } catch (e) {
      if (e && e.code === 'not_found') {
        // Unbezahlte Bestellungen loescht der Shop nach Ablauf.
        next = { ...rec, gone: true, lastCheckedAt: Date.now(), error: e.message };
      } else {
        // Bestellung bleibt unveraendert gespeichert; naechste Abfrage versucht es erneut.
        if (state.purchase && state.purchase.orderId === rec.orderId) {
          setState({ purchase: { ...state.purchase, error: e && e.message ? e.message : Shop.shopErrorMessage('nicht-erreichbar') } });
        }
        throw e;
      }
    }
    // Inzwischen verworfen oder ersetzt? Dann nichts ueberschreiben (eine
    // gueltige Lizenz ist oben trotzdem schon gespeichert).
    if (!state.purchase || state.purchase.orderId !== rec.orderId) return state.purchase;
    next.recoveryAcknowledged = state.purchase.recoveryAcknowledged === true;
    try { await savePurchase(next); } catch { /* bleibt im Speicher, naechste Abfrage speichert erneut */ }
    setState({ purchase: next });
    return next;
  })();
  checkPromise.then(() => { checkPromise = null; }, () => { checkPromise = null; });
  return checkPromise;
}

/** Einmalige Abfrage nach dem App-Start, falls eine Bestellung offen ist (Fehler werden ignoriert). */
export async function resumePendingPurchase() {
  if (!state.loaded) await refreshLicense().catch(() => {});
  if (!isShopPurchaseAvailable() || state.pro || !isPurchaseOpen(state.purchase)) return false;
  try { await checkPurchase(); } catch { /* naechster Versuch beim Oeffnen der Vollversion-Seite */ }
  return true;
}

/** Nutzer hat den Wiederherstellungscode aufgeschrieben (UI zeigt ihn dann nur noch auf Wunsch). */
export async function acknowledgeRecoveryCode() {
  const p = state.purchase;
  if (!p) return;
  const next = { ...p, recoveryAcknowledged: true };
  try { await savePurchase(next); } catch {}
  setState({ purchase: next });
}

/**
 * Abgelaufene/geloeschte Bestellung verwerfen (z. B. fuer eine neue). Nur
 * wenn der Shop sie als abgelaufen meldet oder nicht mehr kennt: eine
 * Bestellung, bei der eine Zahlung erwartet wird, unterwegs ist oder schon
 * bezahlt wurde, laesst sich NICHT verwerfen - sonst gingen Zahlung bzw.
 * Wiederherstellungscode verloren.
 */
export function canDismissPurchase(p) {
  return !!(p && !p.done && (p.gone || (p.order && (p.order.status === 'expired' || p.order.status === 'withdrawn'))));
}

/**
 * Kann die laufende Bestellung (noch) widerrufen werden? Bis zur
 * Bereitstellung der Lizenz - also solange nicht bezahlt/abgeschlossen und
 * nicht schon widerrufen (§ 356a BGB, "Vertrag widerrufen").
 */
export function canWithdrawPurchase(p) {
  return !!(p && !p.done && !p.gone && p.recoveryCode && p.order
    && ['pending', 'underpaid', 'unconfirmed', 'expired'].includes(p.order.status));
}

/**
 * "Vertrag widerrufen" fuer die gespeicherte Bestellung (Bestellnummer und
 * Wiederherstellungscode kennt die App). Name und Rueckzahlungsadresse sind
 * freiwillig. Speichert die Eingangsbestaetigung des Shops bei der Bestellung.
 * Auch fuer eine schon widerrufene Bestellung nutzbar, um die
 * Rueckzahlungsadresse nachzutragen.
 */
export async function withdrawPurchase({ refundAddress = '', name = '' } = {}) {
  if (!isShopPurchaseAvailable()) throw shopFail('nicht-konfiguriert');
  if (!state.loaded) await refreshLicense();
  const rec = state.purchase;
  const nachtragen = !!(rec && rec.order && rec.order.status === 'withdrawn' && rec.recoveryCode);
  if (!canWithdrawPurchase(rec) && !nachtragen) {
    throw shopFail('widerruf-nicht-moeglich', 'Für diese Bestellung ist kein Widerruf (mehr) möglich.');
  }
  await ensureTor();
  const r = await Shop.withdrawOrder({
    orderId: rec.orderId,
    recoveryCode: rec.recoveryCode,
    refundAddress,
    name,
    confirm: true,
    expected: { paymentMethod: Shop.orderPaymentMethod(rec.order) },
  });
  const next = {
    ...rec,
    order: r.order,
    lastCheckedAt: Date.now(),
    error: null,
    withdrawal: { at: r.order.withdrawnAt, receipt: r.receipt, refundAddress: r.refundAddress },
  };
  // Inzwischen ersetzt? Dann nicht ueberschreiben (der Widerruf gilt beim Shop trotzdem).
  if (state.purchase && state.purchase.orderId === rec.orderId) {
    try { await savePurchase(next); } catch { /* bleibt im Speicher */ }
    setState({ purchase: next });
  }
  return next.withdrawal;
}
export async function dismissPurchase() {
  const p = state.purchase;
  if (!p) return true;
  if (!canDismissPurchase(p)) return false;
  try { await savePurchase(null); } catch {}
  setState({ purchase: null });
  return true;
}

/**
 * Lizenz auf dieses Geraet umziehen (POST /api/v1/transfer): Bestellnummer +
 * Wiederherstellungscode + eigener Geraetecode. Zaehlt beim Shop als
 * Aktivierung (hoechstens 3); dasselbe Geraet bekommt seine Lizenz erneut,
 * ohne dass gezaehlt wird.
 */
export async function transferToThisDevice({ orderId, recoveryCode } = {}) {
  if (!isShopPurchaseAvailable()) throw shopFail('nicht-konfiguriert');
  if (!state.loaded) await refreshLicense();
  const id = Shop.normalizeOrderId(orderId);
  if (!id) throw shopFail('eingabe-bestellnummer', t('license.orderIdFormat'));
  const code = Shop.normalizeRecoveryCode(recoveryCode);
  if (!code) throw shopFail('eingabe-code', t('license.recoveryFormat'));
  const deviceCode = await deviceCodeForShop();
  await ensureTor();
  const r = await Shop.transferLicense({ orderId: id, recoveryCode: code, deviceCode });
  const inst = await installLicense(r.license);
  if (!inst.ok) throw shopFail('lizenz-ungueltig', inst.message);
  const now = Date.now();
  const rec = {
    orderId: id, recoveryCode: code, createdAt: now, order: null,
    done: true, gone: false, error: null, lastCheckedAt: now, recoveryAcknowledged: true,
  };
  try { await savePurchase(rec); } catch {}
  setState({ purchase: rec });
  return { activations: r.activations, maxActivations: r.maxActivations, newActivation: r.newActivation };
}

/**
 * Nach einem Wipe (performWipe in App.tsx): der verschluesselte Speicher samt
 * Lizenz und Bestellung ist geloescht - den Zustand im Arbeitsspeicher
 * angleichen, damit die frisch eingerichtete App nicht "Vollversion aktiv"
 * zeigt (das wuerde nach einer Duress-Loeschung verraten, dass es Pro gab).
 * Der Keystore-Schluessel (Geraetecode) bleibt - der Umzug mit dem
 * Wiederherstellungscode auf dasselbe Geraet zaehlt beim Shop nicht als neue
 * Aktivierung.
 */
export function resetLicenseStateAfterWipe() {
  if (isPlay()) {
    // Laufende Play-Pruefungen duerfen danach nichts mehr speichern oder
    // freischalten; der Vermerk lag im eben geleerten Speicher (zur
    // Sicherheit trotzdem einzeln entfernen). Der Kauf selbst bleibt beim
    // Google-Konto - wieder aktiv erst mit "Kaeufe wiederherstellen".
    playGeneration++;
    try { Promise.resolve(EncryptedStorage.removeItem(PLAY_STORAGE_KEY)).catch(() => {}); } catch {}
  }
  setState({ ...initialState(), deviceCode: state.deviceCode, deviceKeyLevel: state.deviceKeyLevel, loaded: true });
}

// ── Google-Play-Variante: Kauf ueber Google Play Billing ──────────────────
// Ablauf siehe Kopf dieser Datei und PLAY_STORE.md. Alles hier laeuft nur,
// wenn Distribution.isPlay() - die Website-Variante beruehrt nichts davon.

let playUnsub = null;         // Abo der Kauf-Aktualisierungen (einmal je Prozess)
let playGeneration = 0;       // +1 bei resetLicenseStateAfterWipe: alte Pruefungen verwerfen
let productPromise = null;

const playFail = (code, message) => new PlayBilling.PlayBillingError(code, message || playErrorMessage(code));

function ensurePlayListener() {
  if (playUnsub || !PlayBilling.isBillingModuleAvailable()) return;
  playUnsub = PlayBilling.onPurchasesUpdated((ev) => { handlePlayPurchasesUpdated(ev).catch(() => {}); });
}

async function readPlayRecord() {
  try {
    const raw = await EncryptedStorage.getItem(PLAY_STORAGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || r.v !== 1 || typeof r.tokenHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(r.tokenHash) || r.productId !== playProductId()) return null;
    return {
      v: 1,
      tokenHash: r.tokenHash,
      productId: r.productId,
      purchaseTime: Number.isFinite(r.purchaseTime) ? r.purchaseTime : null,
      verifiedAt: Number.isFinite(r.verifiedAt) ? r.verifiedAt : 0,
    };
  } catch {
    return null;
  }
}

async function savePlayRecord(rec) {
  if (rec) await EncryptedStorage.setItem(PLAY_STORAGE_KEY, JSON.stringify(rec));
  else await EncryptedStorage.removeItem(PLAY_STORAGE_KEY);
}

function playBase() {
  return {
    distribution: DISTRIBUTION_PLAY,
    deviceCode: null,
    deviceKeyLevel: null,
    licenseInfo: null,
    licenseCheckAvailable: isPlayCheckAvailable(),
    purchaseAvailable: isPlayPurchaseAvailable(),
  };
}

/**
 * Kaufliste von Google Play auswerten (rein, ohne Seiteneffekte).
 *   stored: lokaler Vermerk oder null
 *   adopt:  einen schon bestaetigten Kauf auch OHNE Vermerk uebernehmen
 *           ("Kaeufe wiederherstellen" bzw. direkt nach einem Kauf)
 * Rueckgabe: { patch (Zustand), record (speichern | null = loeschen |
 *            undefined = unveraendert), ackToken (zu bestaetigen | null) }
 */
function evaluatePlayPurchases(purchases, { stored, adopt }) {
  const opts = { publicKey: PLAY_LICENSE_PUBLIC_KEY, packageName: getApplicationId(), productId: playProductId() };
  let pending = false;
  let failure = null;
  let found = null;
  for (const p of purchases) {
    const v = verifyPlayPurchase(p, opts);
    if (v.gueltig) { found = v.kauf; break; }
    if (v.grund === 'ausstehend') pending = true;
    else if (v.grund !== 'produkt' && !failure) failure = v.grund;   // andere Produkte gibt es nicht - ignorieren
  }
  if (found) {
    // Noch nicht bestaetigt = frischer Kauf (hoechstens drei Tage alt) -
    // wird immer uebernommen, sonst erstattete Google ihn.
    const fresh = found.acknowledged !== true;
    if (adopt || fresh || stored) {
      return {
        patch: { pro: true, reason: 'aktiv', playPending: false, playRestorable: false, playInfo: { purchaseTime: found.purchaseTime } },
        record: { v: 1, tokenHash: purchaseTokenHash(found.purchaseToken), productId: playProductId(), purchaseTime: found.purchaseTime, verifiedAt: Date.now() },
        ackToken: fresh ? found.purchaseToken : null,
      };
    }
    return {
      patch: { pro: false, reason: 'keine-lizenz', playPending: pending, playRestorable: true, playInfo: null },
      record: undefined,
      ackToken: null,
    };
  }
  const reason = failure ? 'play-' + failure : (pending ? 'play-ausstehend' : (stored ? 'play-widerrufen' : 'keine-lizenz'));
  return {
    patch: { pro: false, reason, playPending: pending, playRestorable: false, playInfo: null },
    // Ein vermerkter Kauf, den Google Play nicht (mehr) gueltig liefert: Vermerk loeschen.
    record: stored ? null : undefined,
    ackToken: null,
  };
}

/** Ergebnis speichern und - nur nach erfolgreichem Speichern - bei Google Play bestaetigen. */
async function applyPlayEvaluation(ev, gen) {
  if (gen !== playGeneration) return;
  if (ev.record !== undefined) {
    try {
      await savePlayRecord(ev.record);
    } catch {
      // Ohne Vermerk nicht bestaetigen: der Kauf bleibt "frisch" und wird beim
      // naechsten Start erneut uebernommen und dann bestaetigt.
      return;
    }
  }
  if (ev.ackToken && gen === playGeneration) {
    try { await PlayBilling.acknowledge(ev.ackToken); } catch { /* naechster Start versucht es erneut */ }
  }
}

/** Eigene Kaeufe abfragen und auswerten. Rueckgabe: Zustands-Patch. */
async function evaluatePlay({ restore }) {
  ensurePlayListener();
  const gen = playGeneration;
  const base = playBase();
  if (!base.licenseCheckAvailable) {
    return { ...base, pro: false, reason: 'nicht-konfiguriert', playPending: false, playInfo: null, playRestorable: false, playError: null };
  }
  const stored = await readPlayRecord();
  const keepStored = (playError) => (stored
    ? { ...base, pro: true, reason: 'aktiv', playInfo: { purchaseTime: stored.purchaseTime }, playError }
    : { ...base, pro: false, reason: 'keine-lizenz', playInfo: null, playError });
  if (!base.purchaseAvailable) return keepStored(restore ? playErrorMessage('nicht-verfuegbar') : null);
  let purchases;
  try {
    await PlayBilling.connect();
    purchases = (await PlayBilling.queryPurchases()).purchases;
  } catch (e) {
    // Keine verlaessliche Antwort: NICHTS entziehen (siehe Kopf der Datei).
    return keepStored(restore ? playErrorMessage(e && e.code) : null);
  }
  const ev = evaluatePlayPurchases(purchases, { stored, adopt: restore });
  await applyPlayEvaluation(ev, gen);
  return { ...base, ...ev.patch, playError: null };
}

/**
 * "Kaeufe wiederherstellen": eigene Kaeufe abfragen und einen gueltigen Kauf
 * der Vollversion auch ohne lokalen Vermerk uebernehmen. Rueckgabe: Zustand.
 */
export function restorePlayPurchases() {
  const run = refreshChain.then(async () => {
    if (!isPlay()) throw playFail('nicht-verfuegbar');
    const gen = playGeneration;
    const result = await evaluatePlay({ restore: true });
    if (gen === playGeneration) {
      setState({
        ...result,
        purchase: null,
        loaded: true,
        playNotice: result.pro ? 'Kauf wiederhergestellt - Vollversion aktiv.'
          : (result.playError || result.playPending ? null : 'Mit diesem Google-Konto wurde kein Kauf der Vollversion gefunden.'),
      });
    }
    return state;
  });
  refreshChain = run.catch(() => {});
  return run;
}

/** Kauf-Aktualisierung von Google Play (Kaufdialog beendet, ausstehende Zahlung abgeschlossen ...). */
function handlePlayPurchasesUpdated({ responseCode, purchases }) {
  const run = refreshChain.then(async () => {
    if (!isPlay()) return state;
    const gen = playGeneration;
    if (responseCode === 'OK') {
      const stored = await readPlayRecord();
      const ev = evaluatePlayPurchases(purchases || [], { stored, adopt: true });
      if (!ev.patch.pro) {
        // Eine Aktualisierung enthaelt nur die geaenderten Kaeufe - sie
        // entzieht nie etwas (das tut nur die vollstaendige Abfrage).
        if (gen === playGeneration && !state.pro) {
          setState({
            playPending: ev.patch.playPending,
            playError: ev.patch.playPending || ev.patch.reason === 'keine-lizenz' ? null : licenseErrorMessage(ev.patch.reason),
            playNotice: ev.patch.playPending ? licenseErrorMessage('play-ausstehend') : null,
          });
        }
        return state;
      }
      await applyPlayEvaluation(ev, gen);
      if (gen === playGeneration) {
        setState({ ...playBase(), ...ev.patch, purchase: null, loaded: true, playError: null, playNotice: 'Danke! Die Vollversion ist jetzt aktiv.' });
      }
      return state;
    }
    if (responseCode === 'ITEM_ALREADY_OWNED') {
      const result = await evaluatePlay({ restore: true });
      if (gen === playGeneration) setState({ ...result, purchase: null, loaded: true });
      return state;
    }
    if (gen === playGeneration) {
      setState(responseCode === 'USER_CANCELED'
        ? { playError: null, playNotice: playErrorMessage('USER_CANCELED') }
        : { playError: playErrorMessage(responseCode), playNotice: null });
    }
    return state;
  });
  refreshChain = run.catch(() => {});
  return run;
}

/**
 * Produktdetails (Preis in der Waehrung des Nutzers) von Google Play holen.
 * Rueckgabe: Produkt oder null (Fehlertext dann in state.playProductError).
 */
export function loadPlayProduct({ force = false } = {}) {
  if (!isPlayPurchaseAvailable()) return Promise.resolve(null);
  if (state.playProduct && !force) return Promise.resolve(state.playProduct);
  if (productPromise) return productPromise;
  productPromise = (async () => {
    try {
      await PlayBilling.connect();
      const product = await PlayBilling.queryProduct(playProductId());
      setState(product ? { playProduct: product, playProductError: null } : { playProductError: playErrorMessage('ITEM_UNAVAILABLE') });
      return product;
    } catch (e) {
      setState({ playProductError: playErrorMessage(e && e.code) });
      return null;
    }
  })();
  productPromise.then(() => { productPromise = null; }, () => { productPromise = null; });
  return productPromise;
}

/**
 * Kaufdialog von Google Play oeffnen. Das Ergebnis (gekauft, ausstehend,
 * abgebrochen) kommt ueber die Kauf-Aktualisierung und landet im Zustand.
 * Rueckgabe: { started: true } bzw. { started: false } (schon gekauft ->
 * wiederhergestellt). Wirft PlayBillingError mit deutscher Meldung.
 */
export async function startPlayPurchase() {
  if (!isPlay()) throw playFail('nicht-verfuegbar');
  if (!state.loaded) await refreshLicense();
  if (!isPlayPurchaseAvailable()) throw playFail('nicht-konfiguriert');
  if (state.pro) throw playFail('schon-aktiv', 'Die Vollversion ist bereits aktiv.');
  ensurePlayListener();
  try {
    await PlayBilling.connect();
  } catch (e) {
    throw playFail(e && e.code);
  }
  const product = state.playProduct || await loadPlayProduct();
  if (!product) throw playFail('ITEM_UNAVAILABLE', state.playProductError || undefined);
  setState({ playError: null, playNotice: null });
  let r;
  try {
    r = await PlayBilling.launchPurchase(playProductId());
  } catch (e) {
    throw playFail(e && e.code);
  }
  if (r.responseCode === 'ITEM_ALREADY_OWNED') {
    await restorePlayPurchases();
    return { started: false };
  }
  if (r.responseCode !== 'OK') throw playFail(r.responseCode);
  return { started: true };
}

/** Hinweis-/Fehlermeldungen der Play-Kaufseite verwerfen (beim Schliessen der Seite). */
export function clearPlayMessages() {
  if (state.playError || state.playNotice) setState({ playError: null, playNotice: null });
}

/**
 * Text fuer die Zeile "Vollversion" in den Einstellungen, solange sie nicht
 * aktiv ist. Website: wie bisher ("Bestellung läuft" bzw. Preis in EUR).
 * Play: Preis laut Google Play (in der Waehrung des Nutzers) - nie ein
 * fester Betrag.
 */
export function proStatusLabel(s = state) {
  if (s && s.pro) return 'Aktiv';
  if (isPlay()) {
    if (s && s.playPending) return 'Zahlung ausstehend';
    return s && s.playProduct && typeof s.playProduct.price === 'string' ? s.playProduct.price : '';
  }
  return isPurchaseOpen(s && s.purchase) ? 'Bestellung läuft' : `${PRO_PRICE_EUR} EUR`;
}

// ── Freischaltregeln (Gating) ──────────────────────────────────────────────
// Gratis bleiben (Entscheidung des Nutzers): App-PIN, Fingerabdruck,
// Verschluesselung, Tor inkl. Bridges, Gruppen, Dateien, Designs,
// selbstloeschende Nachrichten, Einmal-Medien, Sicherheitscode, Secret Chat.
// Pro ("Extra-Sicherheit"):
//   (a) Duress-PIN / Notfall-PIN mit Loeschung    - Einrichten/Aendern
//   (b) Loeschen nach 5 falschen PIN-Eingaben      - sonst nur Sperrfristen
//   (c) Fernloeschung: verbundene Kontakte beim Loeschen informieren
//   (d) Verbindungsweg "Maximal anonym (nur Tor)"  - Auswaehlen

/** (a) Duress-PIN neu einrichten oder aendern: nur mit Pro. */
export function canConfigureDuressPin(pro) {
  return pro === true;
}
/** (a) Entfernen ist immer erlaubt - wer den Schutz abschaltet, tut das bewusst. */
export function canRemoveDuressPin() {
  return true;
}
/**
 * (a) REGEL: Eine bereits eingerichtete Duress-PIN wird IMMER ausgewertet -
 * auch wenn die Lizenz fehlt, ungueltig ist oder (Keystore-Fehler) gerade
 * nicht geprueft werden kann. Ein eingerichteter Schutz darf nie still
 * abgeschaltet werden: wer sich im Ernstfall auf die Notfall-PIN verlaesst,
 * muss sich darauf verlassen koennen. Gesperrt ist ausschliesslich das NEUE
 * Einrichten/Aendern (canConfigureDuressPin). Deshalb nimmt diese Funktion
 * bewusst KEINEN Lizenzzustand entgegen.
 */
export function isDuressPinEntry(entered, duressPin) {
  return typeof duressPin === 'string' && duressPin.length > 0 && entered === duressPin;
}

export const PIN_WIPE_AFTER_ATTEMPTS = 5;
/**
 * (b) Was nach dem n-ten falschen PIN in Folge passiert.
 *   Pro:    3 -> 30 s Sperre, 4 -> 60 s Sperre ("letzter Versuch"), 5 -> Loeschen.
 *   Gratis: gleiche Sperrfristen, ab dem 5. Fehlversuch nach JEDEM weiteren
 *           erneut 60 s Sperre - nie Loeschen. Gratis-Texte kuendigen keine
 *           Loeschung an.
 * Rueckgabe: { wipe, lockMs, message }
 */
// Gratis (ohne Loeschung): ab dem 5. Fehlversuch steigt die Sperrfrist an.
// Eine feste 60-s-Sperre haette eine 4-stellige PIN in wenigen Tagen
// durchprobierbar gemacht; so dauert es Jahre. Grundschutz fuer alle.
const FREE_LOCK_STEPS_MS = [60000, 5 * 60000, 15 * 60000, 60 * 60000, 4 * 60 * 60000, 12 * 60 * 60000, 24 * 60 * 60000];
function fmtLock(ms) {
  if (ms < 60 * 60000) return Math.round(ms / 60000) === 1 ? t('pin.lock.60s') : t('pin.lock.minutes', { count: Math.round(ms / 60000) });
  return t('pin.lock.hours', { count: Math.round(ms / (60 * 60000)) });
}
export function failedPinPolicy(attempts, pro) {
  const n = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  if (n >= PIN_WIPE_AFTER_ATTEMPTS) {
    if (pro === true) return { wipe: true, lockMs: 0, message: t('pin.resetting') };
    const lockMs = FREE_LOCK_STEPS_MS[Math.min(n - PIN_WIPE_AFTER_ATTEMPTS, FREE_LOCK_STEPS_MS.length - 1)];
    return { wipe: false, lockMs, message: t('pin.wrongLocked', { time: fmtLock(lockMs) }) };
  }
  if (n === 4) {
    return { wipe: false, lockMs: 60000, message: pro === true ? t('pin.lastAttempt60') : t('pin.wrong60') };
  }
  if (n === 3) {
    return { wipe: false, lockMs: 30000, message: pro === true ? t('pin.warning30') : t('pin.wrong30') };
  }
  const rest = PIN_WIPE_AFTER_ATTEMPTS - n;
  return { wipe: false, lockMs: 0, message: pro === true ? t('pin.wrongRemaining', { count: rest }) : t('pin.wrong') };
}
/** (b) Text nach Ablauf einer Sperrfrist. */
export function lockExpiredMessage(attempts, pro) {
  return pro === true && attempts >= PIN_WIPE_AFTER_ATTEMPTS - 1 ? t('pin.lastAttempt') : t('lock.enterPin');
}

/** (c) Fernloeschung: verbundene Kontakte beim Wipe per device_wiped informieren - nur mit Pro. */
export function shouldNotifyContactsOnWipe(pro) {
  return pro === true;
}

/**
 * (d) Verbindungsweg "Maximal anonym (nur Tor)" (ConnectionMode.js, Stufe 3)
 * NEU waehlen: nur mit Pro. REGEL wie bei der Duress-PIN: eine bereits aktive
 * Stufe 3 bleibt auch ohne (gueltige) Lizenz aktiv - ConnectionMode.js liest
 * den Lizenzzustand dafuer gar nicht erst (canSelectConnectionMode laesst das
 * Beibehalten immer zu). Verlassen geht immer.
 */
export function canSelectTorOnlyMode(pro) {
  return pro === true;
}

// Nur fuer Tests: Zustand im Arbeitsspeicher zuruecksetzen (aendert keine
// Schluessel und schaltet nichts frei).
export function _resetLicenseManagerForTests() {
  state = initialState();
  listeners.clear();
  hooks = { ensureTor: null };
  cachedDevice = null;
  checkPromise = null;
  methodsPromise = null;
  refreshChain = Promise.resolve();
  if (playUnsub) { try { playUnsub(); } catch {} }
  playUnsub = null;
  playGeneration = 0;
  productPromise = null;
  PlayBilling._resetPlayBillingForTests();
}
