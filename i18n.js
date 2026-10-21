/**
 * Malachi - Uebersetzungen (i18n)
 *
 * Kleiner, eigener Uebersetzungs-Helfer ohne Fremdbibliothek, ohne Netz und
 * ohne nativen Teil: alle Texte liegen als JS-Module unter locales/<code>.js
 * und werden erst beim ersten Gebrauch geladen (require in LOADERS).
 *
 *   t('home.title')                      -> Text in der aktiven Sprache
 *   t('home.selected', { count: 3 })     -> Platzhalter {count}; ist der Eintrag
 *                                           ein Objekt { one, few, many, other },
 *                                           waehlt `count` die Pluralform
 *
 * Rueckfall: gewaehlte Sprache -> Englisch -> Deutsch (Quelle, locales/de.js)
 * -> der Schluessel selbst. Deutsch ist die Quelle der Wahrheit; alle anderen
 * Sprachen sind maschinell uebersetzt (siehe Kopf der jeweiligen Datei).
 *
 * Sprachwahl: 'system' (Standard, Geraetesprache) oder ein Sprachcode aus
 * LANGUAGES. Gespeichert wird sie in 'settings' (EncryptedStorage) unter
 * `language` - per Lesen-Zusammenfuehren-Schreiben (Themes.saveSettings),
 * aeltere Einstellungen ohne den Schluessel bedeuten 'system'.
 *
 * Wechsel: subscribeLanguage() meldet jede Aenderung, AppInner rendert dann
 * neu (wie bei den Design-Themen). Arabisch und Persisch laufen von rechts
 * nach links - der Wechsel der Leserichtung braucht einen Neustart der App
 * (I18nManager.forceRTL wirkt erst beim naechsten Start), siehe
 * syncLayoutDirection()/restartApp().
 */
import { NativeModules, I18nManager } from 'react-native';

export const SYSTEM_LANGUAGE = 'system';
export const SOURCE_LANGUAGE = 'de';
export const FALLBACK_LANGUAGE = 'en';

/**
 * Angebotene Sprachen, jeweils mit ihrem eigenen Namen (so findet man die
 * eigene Sprache auch in einer fremden Oberflaeche). rtl: Leserichtung
 * rechts nach links. Reihenfolge = Anzeige in den Einstellungen.
 */
export const LANGUAGES = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'fa', name: 'فارسی', rtl: true },
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'id', name: 'Bahasa Indonesia' },
];
export const LANGUAGE_CODES = LANGUAGES.map(l => l.code);

// Statische require-Aufrufe (Metro/Jest brauchen feste Pfade); geladen wird
// eine Sprache erst, wenn sie gebraucht wird.
const LOADERS = {
  de: () => require('./locales/de').default,
  en: () => require('./locales/en').default,
  es: () => require('./locales/es').default,
  fr: () => require('./locales/fr').default,
  it: () => require('./locales/it').default,
  'pt-BR': () => require('./locales/pt-BR').default,
  nl: () => require('./locales/nl').default,
  pl: () => require('./locales/pl').default,
  tr: () => require('./locales/tr').default,
  ru: () => require('./locales/ru').default,
  uk: () => require('./locales/uk').default,
  ar: () => require('./locales/ar').default,
  fa: () => require('./locales/fa').default,
  'zh-Hans': () => require('./locales/zh-Hans').default,
  ja: () => require('./locales/ja').default,
  ko: () => require('./locales/ko').default,
  hi: () => require('./locales/hi').default,
  id: () => require('./locales/id').default,
};

const tables = {};
/** Uebersetzungstabelle einer Sprache (oder null, falls nicht vorhanden). */
export function getTable(code) {
  if (!Object.prototype.hasOwnProperty.call(tables, code)) {
    let tbl = null;
    try { tbl = LOADERS[code] ? LOADERS[code]() : null; } catch { tbl = null; }
    tables[code] = tbl && typeof tbl === 'object' ? tbl : null;
  }
  return tables[code];
}

export function isRTLLanguage(code) {
  return !!LANGUAGES.find(l => l.code === code)?.rtl;
}
export function languageName(code) {
  return LANGUAGES.find(l => l.code === code)?.name || code;
}

// ── Geraetesprache ─────────────────────────────────────────────────────────

/**
 * Rohe Locale-Angabe vereinheitlichen: 'de_DE' -> 'de-DE',
 * 'zh_CN_#Hans' (Android, Locale.toString) -> 'zh-Hans-CN'.
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const script = (s.match(/#([A-Za-z]{4})/) || [])[1];
  const parts = s.replace(/#.*$/, '').replace(/@.*$/, '').split(/[-_]/).filter(Boolean);
  if (!parts.length || !/^[A-Za-z]{2,3}$/.test(parts[0])) return null;
  const out = [parts[0].toLowerCase()];
  const rest = parts.slice(1);
  const scr = script || rest.find(p => /^[A-Za-z]{4}$/.test(p));
  if (scr) out.push(scr[0].toUpperCase() + scr.slice(1).toLowerCase());
  const region = rest.find(p => /^([A-Za-z]{2}|\d{3})$/.test(p));
  if (region) out.push(region.toUpperCase());
  return out.join('-');
}

/** Locale-Tag -> unterstuetzte Sprache (Code aus LANGUAGES) oder null. */
export function matchLanguage(tag) {
  const norm = normalizeTag(tag);
  if (!norm) return null;
  const parts = norm.split('-');
  let lang = parts[0];
  if (lang === 'in') lang = 'id';                     // alter Android-Code fuer Indonesisch
  const script = parts.find(p => p.length === 4);
  const region = parts.find(p => p.length === 2 && p === p.toUpperCase() && p !== lang.toUpperCase());
  if (lang === 'zh') {
    // Nur vereinfachtes Chinesisch vorhanden - traditionelles (Taiwan,
    // Hongkong, Macau) faellt auf Englisch zurueck statt auf Kurzzeichen.
    if (script === 'Hant' || (!script && ['TW', 'HK', 'MO'].includes(region))) return null;
    return 'zh-Hans';
  }
  if (lang === 'pt') return 'pt-BR';
  return LANGUAGE_CODES.includes(lang) ? lang : null;
}

/** Bevorzugte Sprachen des Geraets (vereinheitlichte Tags, beste zuerst). */
export function deviceLocaleTags() {
  const raw = [];
  try {
    const c = I18nManager?.getConstants?.();
    if (c?.localeIdentifier) raw.push(c.localeIdentifier);
  } catch {}
  try {
    const s = NativeModules?.SettingsManager?.settings;
    if (s?.AppleLocale) raw.push(s.AppleLocale);
    if (Array.isArray(s?.AppleLanguages)) raw.push(...s.AppleLanguages);
  } catch {}
  try {
    const l = Intl.DateTimeFormat().resolvedOptions().locale;
    if (l) raw.push(l);
  } catch {}
  const out = [];
  for (const r of raw) {
    const n = normalizeTag(r);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Wahl ('system' | Code) -> tatsaechlich angezeigte Sprache. */
export function resolveLanguage(choice, tags = deviceLocaleTags()) {
  if (choice && choice !== SYSTEM_LANGUAGE && LANGUAGE_CODES.includes(choice)) return choice;
  for (const tag of tags || []) {
    const m = matchLanguage(tag);
    if (m) return m;
  }
  return FALLBACK_LANGUAGE;
}

// ── Zustand ───────────────────────────────────────────────────────────────

let choice = SYSTEM_LANGUAGE;
let deviceTags = null;
let locale = null;
const listeners = new Set();

function currentDeviceTags() {
  if (!deviceTags) deviceTags = deviceLocaleTags();
  return deviceTags;
}
function ensureLocale() {
  if (!locale) locale = resolveLanguage(choice, currentDeviceTags());
  return locale;
}

/** Aktive Sprache (Code aus LANGUAGES). */
export function getLanguage() { return ensureLocale(); }
/** Gespeicherte Wahl: 'system' oder ein Sprachcode. */
export function getLanguageChoice() { return choice; }
/** fn(code) bei jeder Aenderung (nicht sofort). Rueckgabe: Abmelden. */
export function subscribeLanguage(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function normalizeChoice(c) {
  return typeof c === 'string' && LANGUAGE_CODES.includes(c) ? c : SYSTEM_LANGUAGE;
}

/**
 * Sprache waehlen ('system' oder Code; Unbekanntes -> 'system'). Benachrichtigt
 * alle Abonnenten, wenn sich die angezeigte Sprache aendert.
 * Rueckgabe: { language, changed }.
 */
export function setLanguage(next) {
  const prev = ensureLocale();
  choice = normalizeChoice(next);
  deviceTags = deviceLocaleTags();
  locale = resolveLanguage(choice, deviceTags);
  const changed = locale !== prev;
  if (changed) {
    for (const l of listeners) { try { l(locale); } catch {} }
  }
  return { language: locale, changed };
}

/** Rohes 'settings'-JSON -> Sprachwahl. Fehlertolerant, fehlend = 'system'. */
export function languageFromSettings(raw) {
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { s = null; } }
  return normalizeChoice(s && typeof s === 'object' ? s.language : null);
}

/** Gespeicherte Wahl aus 'settings' uebernehmen (App-Start, Headless-Task). */
export async function loadLanguageSetting(storage) {
  try {
    const raw = await storage.getItem('settings');
    setLanguage(languageFromSettings(raw));
  } catch {}
  return choice;
}

// ── Uebersetzen ───────────────────────────────────────────────────────────

/**
 * Pluralform nach CLDR (vereinfacht, nur ganze Zahlen) - Intl.PluralRules
 * fehlt in Hermes, deshalb eigene Regeln.
 */
export function pluralCategory(lang, n) {
  const num = Math.abs(Number(n));
  if (!Number.isFinite(num)) return 'other';
  const i = Math.floor(num);
  const isInt = i === num;
  const base = String(lang || '').split('-')[0];
  const m10 = i % 10;
  const m100 = i % 100;
  switch (base) {
    case 'ru':
    case 'uk':
      if (!isInt) return 'other';
      if (m10 === 1 && m100 !== 11) return 'one';
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
      return 'many';
    case 'pl':
      if (!isInt) return 'other';
      if (i === 1) return 'one';
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
      return 'many';
    case 'ar':
      if (!isInt) return 'other';
      if (i === 0) return 'zero';
      if (i === 1) return 'one';
      if (i === 2) return 'two';
      if (m100 >= 3 && m100 <= 10) return 'few';
      if (m100 >= 11 && m100 <= 99) return 'many';
      return 'other';
    case 'fr':
    case 'pt':
      return i === 0 || i === 1 ? 'one' : 'other';
    case 'fa':
    case 'hi':
      return i === 0 || num === 1 ? 'one' : 'other';
    case 'zh':
    case 'ja':
    case 'ko':
    case 'id':
      return 'other';
    default:
      return num === 1 ? 'one' : 'other';
  }
}

function interpolate(text, params) {
  if (!params || typeof text !== 'string' || text.indexOf('{') < 0) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

function pick(entry, lang, params) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const cat = pluralCategory(lang, params ? params.count : undefined);
  return entry[cat] ?? entry.other ?? entry.one;
}

/** Rohen Eintrag einer Sprache ohne Rueckfall (fuer Tests/Vollstaendigkeit). */
export function rawMessage(lang, key) {
  const tbl = getTable(lang);
  return tbl && Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key] : undefined;
}

/** Text zum Schluessel in der aktiven Sprache (mit Rueckfall, siehe oben). */
export function t(key, params) {
  const lang = ensureLocale();
  for (const l of [lang, FALLBACK_LANGUAGE, SOURCE_LANGUAGE]) {
    const entry = rawMessage(l, key);
    if (entry !== undefined) {
      const text = pick(entry, l, params);
      if (typeof text === 'string') return interpolate(text, params);
    }
  }
  return key;
}

// ── Datum/Uhrzeit ─────────────────────────────────────────────────────────

/**
 * Locale fuer toLocale*String: die Geraete-Locale, wenn sie zur aktiven
 * Sprache passt (behaelt z.B. das 24-h-Format von en-GB), sonst die Sprache.
 */
export function getDateLocale() {
  const lang = ensureLocale();
  for (const tag of currentDeviceTags()) {
    if (matchLanguage(tag) === lang) return tag;
  }
  return lang === 'de' ? 'de-DE' : lang;
}

function safeLocaleString(d, method, opts) {
  try { return d[method](getDateLocale(), opts); } catch {}
  try { return d[method]('de-DE', opts); } catch {}
  return '';
}
/**
 * Uhrzeit "HH:MM" in der aktiven Sprache (Ersatz fuer
 * new Date(x).toLocaleTimeString('de-DE', { hour, minute })). Ohne Argument:
 * jetzt; ein uebergebenes undefined bleibt wie bei new Date(undefined) ungueltig.
 */
export function formatTime(...args) {
  const v = args[0];
  const d = args.length === 0 ? new Date() : v instanceof Date ? v : new Date(v);
  return safeLocaleString(d, 'toLocaleTimeString', { hour: '2-digit', minute: '2-digit' });
}
/** Datum und Uhrzeit in der aktiven Sprache. */
export function formatDateTime(value, opts) {
  const d = value instanceof Date ? value : new Date(value);
  return safeLocaleString(d, 'toLocaleString', opts);
}
/** Nur Datum in der aktiven Sprache. */
export function formatDate(value, opts) {
  const d = value instanceof Date ? value : new Date(value);
  return safeLocaleString(d, 'toLocaleDateString', opts);
}

// ── Leserichtung (Arabisch, Persisch) ─────────────────────────────────────

/** Soll die Oberflaeche fuer die aktive Sprache von rechts nach links laufen? */
export function wantsRTL() { return isRTLLanguage(ensureLocale()); }

/**
 * Leserichtung fuer den NAECHSTEN Start festlegen (I18nManager speichert sie
 * nativ). Rueckgabe true: die laufende App hat noch die andere Richtung -
 * ein Neustart (restartApp) ist noetig, damit sie greift. Ohne automatischen
 * Neustart, damit nie eine Neustart-Schleife entstehen kann.
 */
export function syncLayoutDirection() {
  const want = wantsRTL();
  try {
    I18nManager.allowRTL(want);
    I18nManager.forceRTL(want);
  } catch {}
  return !!I18nManager.isRTL !== want;
}

/** App neu starten (react-native-restart), z.B. nach einem Wechsel der Leserichtung. */
export function restartApp() {
  try {
    const RNRestart = require('react-native-restart').default;
    RNRestart.restart('i18n-direction');
    return true;
  } catch {
    return false;
  }
}

/** Nur fuer Tests: Modul-Zustand zuruecksetzen. */
export function _resetI18nForTests() {
  choice = SYSTEM_LANGUAGE;
  deviceTags = null;
  locale = null;
}
