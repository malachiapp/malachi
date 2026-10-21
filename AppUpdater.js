// Signierte In-App-Updates der Web-Version.
// Gegenstueck: android/app/src/main/java/com/securecommapp/update/MalachiUpdaterModule.kt
// Format und Pruefregeln (verbindlich): website/UPDATE_FORMAT.md, Abschnitt 5.
//
// Ablauf:
//  1. manifest.json (hoechstens 64 KiB) und manifest.json.sig (hoechstens
//     1 KiB) per GET von der eingebauten Onion-Adresse der Website laden -
//     AUSSCHLIESSLICH ueber den Tor-Prozess der App (eigene Kreise je Abruf).
//     Gesendet wird nur "GET /updates/<datei>" mit Host - keine Geraetedaten,
//     keine App-Version, kein User-Agent, keine Cookies.
//  2. Ed25519-Signatur ueber die UNVERAENDERTEN Bytes pruefen (RFC 8032 streng,
//     zip215: false) - gegen die eingebauten Schluessel (AppConfig.
//     UPDATE_PUBLIC_KEYS), nie gegen einen vom Server gelieferten.
//  3. Erst dann: UTF-8 streng (kein BOM), JSON, jedes Feld nach Abschnitt 4,
//     unbekannte Felder = Fehler, App-ID muss passen (Demo-Builds nie).
//  4. Rueckfallschutz: hoechstes bisher gueltiges (versionCode, published).
//  5. Angeboten wird nur versionCode > installierte versionCode; installierte
//     Version < minSupportedVersionCode -> "Dieses Update ist wichtig".
//  6. APK fuer die erste passende ABI aus Build.SUPPORTED_ABIS.
//  7. Laden nur auf Nutzerwunsch; Groesse und SHA-256 aus dem signierten
//     Manifest prueft das native Modul beim Laden UND diese Datei danach noch
//     einmal. Danach Paketname, versionCode und Signaturzertifikat der APK
//     (gegen signingCertSha256 und gegen die installierte App).
//  8. Installation ueber den Android-Installer - der Nutzer bestaetigt.
//     Android lehnt eine mit fremdem Schluessel signierte APK zusaetzlich
//     selbst ab; darauf verlassen wir uns aber nicht allein (Schritte 2-7).
//
// Zeitplan: "Automatisch nach Updates suchen" (Standard an) prueft hoechstens
// einmal je 24 h plus Zufallsversatz (0-6 h), nur bei laufendem Tor und erst
// einige Minuten nach dem Tor-Start (nicht mit dem App-Start verknuepfbar).
// Die APK wird nie automatisch geladen.
//
// Play-Version: Google Play verbietet Selbst-Updates. isUpdaterAvailable() ist
// die EINE Stelle, die das entscheidet (NativeModules.MalachiBuild.distribution;
// fehlt das Modul, gilt 'web').
//
// Gespeichert (nur EncryptedStorage, Schluessel 'update_state_v1'):
// Schalter, Zeitpunkte der letzten/naechsten Pruefung, Rueckfallschutz,
// das zuletzt gueltige Manifest (Bytes + Signatur, wird beim Laden erneut
// geprueft) und die ausgeblendete Version. Geloggt wird nichts davon.

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { rawDistribution } from './Distribution';
import EncryptedStorage from 'react-native-encrypted-storage';
import NetInfo from '@react-native-community/netinfo';
import { Buffer } from 'buffer';
import { ed25519 } from '@noble/curves/ed25519.js';
import { UPDATE_PUBLIC_KEYS, UPDATE_ONION, UPDATE_PATH } from './AppConfig';
import { base64urlDekodieren } from './LicenseFormat';
import { t as tr } from './i18n';   // t ist hier oft eine lokale Variable

export const APPLICATION_ID = 'com.securecommapp';
export const MANIFEST_FORMAT = 'malachi-update-manifest';
export const MANIFEST_MAX_BYTES = 65536;
export const SIG_MAX_BYTES = 1024;
export const APK_MAX_BYTES = 1024 * 1024 * 1024;
export const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_JITTER_MS = 6 * 60 * 60 * 1000;
// Erste Pruefung frühestens so lange nach "Tor laeuft" (Zufall dazwischen).
export const CHECK_START_DELAY_MIN_MS = 60 * 1000;
export const CHECK_START_DELAY_MAX_MS = 10 * 60 * 1000;
export const SCHEDULER_TICK_MS = 30 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 120000;
export const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000;
const STORAGE_KEY = 'update_state_v1';
const ONION_V3_RE = /^[a-z2-7]{56}\.onion$/;
const DATEINAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const APP_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ZEITSTEMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_HINWEISE = 4000;
const MANIFEST_FIELDS = ['format', 'formatVersion', 'applicationId', 'versionName', 'versionCode', 'minSupportedVersionCode',
  'published', 'signingCertSha256', 'releaseNotesLang', 'releaseNotes', 'apks'];

// ── Fehler (Anzeigetexte aus eigener Tabelle, nie aus Server-Antworten) ───

export class UpdateError extends Error {
  constructor(code) {
    super(updateErrorMessage(code));
    this.name = 'UpdateError';
    this.code = code;
  }
}

// Texte in locales/*.js (update.err.*), angezeigt in der aktiven Sprache.
const MESSAGE_KEYS = {
  'nicht-verfuegbar': 'update.err.nicht-verfuegbar',
  'nicht-eingerichtet': 'update.err.nicht-eingerichtet',
  'tor-aus': 'update.err.tor-aus',
  'nicht-erreichbar': 'update.err.nicht-erreichbar',
  'nicht-veroeffentlicht': 'update.err.nicht-veroeffentlicht',
  'signatur-ungueltig': 'update.err.signatur-ungueltig',
  'manifest-ungueltig': 'update.err.manifest-ungueltig',
  'falsche-app': 'update.err.falsche-app',
  rueckfall: 'update.err.rueckfall',
  'keine-abi': 'update.err.keine-abi',
  'download-fehler': 'update.err.download-fehler',
  zeitueberschreitung: 'update.err.zeitueberschreitung',
  pruefsumme: 'update.err.pruefsumme',
  'zu-gross': 'update.err.zu-gross',
  'apk-ungueltig': 'update.err.apk-ungueltig',
  'apk-signatur': 'update.err.apk-signatur',
  'andere-signatur': 'update.err.andere-signatur',
  installation: 'update.err.installation',
};
export function updateErrorMessage(code) {
  return tr(Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, code) ? MESSAGE_KEYS[code] : MESSAGE_KEYS['download-fehler']);
}
const fail = (code) => new UpdateError(code);

// ── Verfuegbarkeit (EINE Stelle fuer Play/Web) ─────────────────────────────

/**
 * Vertriebsweg laut nativem Build-Modul (Play-Flavor). Fehlt das Modul,
 * gilt 'web'. Unbekannte Werte gelten NICHT als 'web' (lieber kein
 * Selbst-Update als eines im falschen Kanal).
 */
export function getDistribution() {
  // Gemeinsamer Helfer (Distribution.js) - liest die Konstanten auch ueber
  // getConstants() der neuen Architektur.
  const d = rawDistribution();
  if (d === null || d === 'web') return 'web';
  return d || 'unbekannt';
}

/** Gibt es In-App-Updates in diesem Build? Nur Web-Version, nur Android, nur mit nativem Modul. */
export function isUpdaterAvailable() {
  if (getDistribution() !== 'web') return false;
  if (Platform.OS !== 'android') return false;
  const u = NativeModules.MalachiUpdater;
  return !!u && typeof u.fetchSmall === 'function' && typeof u.download === 'function' && typeof u.install === 'function';
}

/** Eingebaute Schluessel als 32-Byte-Arrays (ungueltige Eintraege fallen weg). */
export function decodePublicKeys(list = UPDATE_PUBLIC_KEYS) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const k of list.slice(0, 8)) {
    try {
      const b = k instanceof Uint8Array ? k : base64urlDekodieren(k);
      if (b.length === 32) out.push(new Uint8Array(b));
    } catch {}
  }
  return out;
}

/** Schluessel und Onion-Adresse eingetragen? Sonst: "Updates werden eingerichtet". */
export function isUpdaterConfigured() {
  return decodePublicKeys().length > 0
    && typeof UPDATE_ONION === 'string' && ONION_V3_RE.test(UPDATE_ONION)
    && UPDATE_PATH === '/updates/';
}

/** Angaben zur installierten App aus dem nativen Modul (verlassen nie das Geraet). */
export function getInstalledInfo() {
  const u = NativeModules.MalachiUpdater;
  if (!u) return null;
  let c = u;
  if (typeof u.versionCode !== 'number' && typeof u.getConstants === 'function') {
    try { c = u.getConstants() || {}; } catch { c = {}; }
  }
  const versionCode = Number.isSafeInteger(c.versionCode) && c.versionCode > 0 ? c.versionCode : 0;
  const abis = String(c.supportedAbis || '').split(',').map((s) => s.trim()).filter((a) => ABIS.includes(a));
  return {
    versionCode,
    versionName: typeof c.versionName === 'string' ? c.versionName.slice(0, 64) : '',
    applicationId: typeof c.applicationId === 'string' ? c.applicationId : '',
    abis,
  };
}

// ── Pruefung des Manifests (reine Funktionen) ──────────────────────────────

/** Strenges UTF-8: keine ueberlangen Formen, keine Surrogate, nichts ueber U+10FFFF. */
export function isStrictUtf8(b) {
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    let need;
    let min;
    let cp;
    if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; cp = c & 0x1f; }
    else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; cp = c & 0x0f; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; cp = c & 0x07; }
    else return false;
    if (i + need >= n) return false;
    for (let k = 1; k <= need; k++) {
      const x = b[i + k];
      if ((x & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (x & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/** manifest.json.sig: 88 Zeichen Standard-Base64 (64 Byte), danach hoechstens ein LF bzw. CRLF. */
export function parseSignatureFile(text) {
  if (typeof text !== 'string' || text.length > SIG_MAX_BYTES) throw fail('signatur-ungueltig');
  const core = text.replace(/\r?\n$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(core)) throw fail('signatur-ungueltig');
  const sig = Buffer.from(core, 'base64');
  if (sig.length !== 64 || sig.toString('base64') !== core) throw fail('signatur-ungueltig');
  return new Uint8Array(sig);
}

const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** Feldregeln aus UPDATE_FORMAT.md Abschnitt 4 (wie website/werkzeuge/lib/manifest.mjs). */
export function validateManifestFields(m) {
  const bad = () => { throw fail('manifest-ungueltig'); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad();
  for (const k of Object.keys(m)) if (!MANIFEST_FIELDS.includes(k)) bad();
  if (m.format !== MANIFEST_FORMAT) bad();
  if (m.formatVersion !== 1) bad();
  if (typeof m.applicationId !== 'string' || !APP_ID.test(m.applicationId)) bad();
  if (typeof m.versionName !== 'string' || !VERSION_NAME.test(m.versionName)) bad();
  if (!isInt(m.versionCode, 1, 2100000000)) bad();
  if (!isInt(m.minSupportedVersionCode, 1, m.versionCode)) bad();
  if (typeof m.published !== 'string' || !ZEITSTEMPEL.test(m.published) || Number.isNaN(Date.parse(m.published))) bad();
  if (typeof m.signingCertSha256 !== 'string' || !SHA256_RE.test(m.signingCertSha256)) bad();
  if (m.releaseNotesLang !== 'de') bad();
  // eslint-disable-next-line no-control-regex
  if (typeof m.releaseNotes !== 'string' || m.releaseNotes.length > MAX_HINWEISE || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(m.releaseNotes)) bad();
  if (!Array.isArray(m.apks) || m.apks.length < 1 || m.apks.length > ABIS.length) bad();
  const seen = new Set();
  for (const a of m.apks) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) bad();
    for (const k of Object.keys(a)) if (!['abi', 'file', 'size', 'sha256'].includes(k)) bad();
    if (!ABIS.includes(a.abi) || seen.has(a.abi)) bad();
    seen.add(a.abi);
    if (typeof a.file !== 'string' || !DATEINAME.test(a.file)) bad();
    if (!isInt(a.size, 1, APK_MAX_BYTES)) bad();
    if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256)) bad();
  }
  return m;
}

/** Bytes -> Manifest (Signatur muss VORHER ueber genau diese Bytes geprueft sein). */
export function parseManifest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MANIFEST_MAX_BYTES) throw fail('manifest-ungueltig');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw fail('manifest-ungueltig');
  if (!isStrictUtf8(bytes)) throw fail('manifest-ungueltig');
  let m;
  try {
    m = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw fail('manifest-ungueltig');
  }
  return validateManifestFields(m);
}

/**
 * Signatur pruefen (gegen JEDEN der eingebauten Schluessel), dann parsen.
 * keys: Liste base64url-Texte oder 32-Byte-Arrays (Standard: AppConfig).
 */
export function verifyManifest(bytes, sigText, keys = UPDATE_PUBLIC_KEYS) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MANIFEST_MAX_BYTES) throw fail('manifest-ungueltig');
  const pubs = decodePublicKeys(keys);
  if (!pubs.length) throw fail('nicht-eingerichtet');
  const sig = parseSignatureFile(sigText);
  const msg = new Uint8Array(bytes);
  const ok = pubs.some((pub) => {
    try { return ed25519.verify(sig, msg, pub, { zip215: false }) === true; } catch { return false; }
  });
  if (!ok) throw fail('signatur-ungueltig');
  return parseManifest(msg);
}

/** Erste ABI aus Build.SUPPORTED_ABIS (Reihenfolge des Geraets), die im Manifest vorkommt. */
export function selectApk(m, deviceAbis) {
  for (const abi of deviceAbis || []) {
    const a = m.apks.find((x) => x.abi === abi);
    if (a) return { abi: a.abi, file: a.file, size: a.size, sha256: a.sha256 };
  }
  return null;
}

/** Rueckfallschutz (Abschnitt 5, Schritt 4). */
export function checkRollback(m, seen) {
  if (!seen) return;
  if (m.versionCode < seen.versionCode) throw fail('rueckfall');
  if (m.versionCode === seen.versionCode && m.published < seen.published) throw fail('rueckfall');
}

/**
 * Gepruftes Manifest gegen die installierte App:
 * { update: null | {...}, reason: null | 'keine-abi' }. Wirft 'falsche-app'.
 */
export function evaluateManifest(m, installed) {
  if (!installed || installed.applicationId !== APPLICATION_ID || m.applicationId !== installed.applicationId) throw fail('falsche-app');
  if (!(m.versionCode > installed.versionCode)) return { update: null, reason: null };
  const apk = selectApk(m, installed.abis);
  if (!apk) return { update: null, reason: 'keine-abi' };
  return {
    reason: null,
    update: {
      versionName: m.versionName,
      versionCode: m.versionCode,
      minSupportedVersionCode: m.minSupportedVersionCode,
      published: m.published,
      signingCertSha256: m.signingCertSha256,
      releaseNotes: m.releaseNotes,
      important: installed.versionCode < m.minSupportedVersionCode,
      apk,
    },
  };
}

// ── Anzeige-Helfer ─────────────────────────────────────────────────────────

/** 41234567 -> "41,2 MB" (wie die Website, ohne Intl). */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1e6) return Math.max(1, Math.round(bytes / 1e3)) + ' kB';
  return (bytes / 1e6).toFixed(1).replace('.', ',') + ' MB';
}

/** "2026-10-19T12:00:00Z" -> "19.10.2026" */
export function formatDate(published) {
  const t = Date.parse(published);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Versionshinweise -> Absaetze/Listenpunkte (nur Text, nie HTML/Links). */
export function releaseNoteBlocks(text) {
  const out = [];
  for (const para of String(text || '').split(/\n\s*\n/)) {
    for (const line of para.split('\n')) {
      const t = line.trimEnd();
      if (!t.trim()) continue;
      if (t.startsWith('- ')) out.push({ kind: 'bullet', text: t.slice(2).trim() });
      else out.push({ kind: 'text', text: t.trim() });
    }
    out.push({ kind: 'gap' });
  }
  while (out.length && out[out.length - 1].kind === 'gap') out.pop();
  return out;
}

/** Getaktetes Netz (Mobilfunk)? Dann fragt die Oberflaeche vor dem Download extra nach. */
export async function isMeteredConnection() {
  try {
    const s = await NetInfo.fetch();
    return !!(s && (s.type === 'cellular' || s.details?.isConnectionExpensive === true));
  } catch {
    return false;
  }
}

// ── Zustand ────────────────────────────────────────────────────────────────

const DL_IDLE = Object.freeze({ status: 'idle', received: 0, total: 0, error: null, file: null, installStarted: false });
const initialState = () => ({
  loaded: false,
  autoCheck: true,
  lastCheckAt: 0,
  checking: false,
  checkError: null,
  upToDate: false,
  update: null,
  bannerDismissed: false,
  dl: DL_IDLE,
});
let state = initialState();
const listeners = new Set();
function setState(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) { try { l(state); } catch {} }
}
export function getUpdateState() { return state; }
export function subscribeUpdate(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const DEFAULT_PERSIST = { autoCheck: true, lastCheckAt: 0, nextCheckAt: 0, seen: null, manifestB64: null, sigText: null, dismissed: 0 };
let persist = { ...DEFAULT_PERSIST };
let loadPromise = null;
let saveChain = Promise.resolve();

function sanitizePersist(raw) {
  let p = null;
  try { p = raw ? JSON.parse(raw) : null; } catch { p = null; }
  if (!p || typeof p !== 'object') return { ...DEFAULT_PERSIST };
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const seen = p.seen && isInt(p.seen.versionCode, 1, 2100000000) && typeof p.seen.published === 'string' && ZEITSTEMPEL.test(p.seen.published)
    ? { versionCode: p.seen.versionCode, published: p.seen.published } : null;
  return {
    autoCheck: p.autoCheck !== false,
    lastCheckAt: num(p.lastCheckAt),
    nextCheckAt: num(p.nextCheckAt),
    seen,
    manifestB64: typeof p.manifestB64 === 'string' && p.manifestB64.length <= 90000 ? p.manifestB64 : null,
    sigText: typeof p.sigText === 'string' && p.sigText.length <= SIG_MAX_BYTES ? p.sigText : null,
    dismissed: num(p.dismissed),
  };
}

function savePersist() {
  const snapshot = JSON.stringify(persist);
  saveChain = saveChain.then(() => EncryptedStorage.setItem(STORAGE_KEY, snapshot)).catch(() => {});
  return saveChain;
}

/** Gespeichertes Manifest erneut pruefen (Schluessel, Felder, installierte Version). */
function restoreStoredUpdate() {
  if (!persist.manifestB64 || !persist.sigText || !isUpdaterConfigured()) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(persist.manifestB64, 'base64'));
    const m = verifyManifest(bytes, persist.sigText);
    return evaluateManifest(m, getInstalledInfo()).update;
  } catch {
    return null;
  }
}

export function loadUpdateState() {
  if (!loadPromise) {
    loadPromise = (async () => {
      let raw = null;
      try { raw = await EncryptedStorage.getItem(STORAGE_KEY); } catch {}
      persist = sanitizePersist(raw);
      const update = restoreStoredUpdate();
      if (!update && (persist.manifestB64 || persist.sigText)) {
        persist.manifestB64 = null;
        persist.sigText = null;
        await savePersist();
      }
      setState({
        loaded: true,
        autoCheck: persist.autoCheck,
        lastCheckAt: persist.lastCheckAt,
        update,
        bannerDismissed: !!update && !update.important && persist.dismissed === update.versionCode,
      });
    })();
  }
  return loadPromise;
}

// ── Hooks (Tor-Zustand, Zeit, Zufall - von App.tsx bzw. Tests gesetzt) ─────

let hooks = { isTorUp: () => true, onTorState: null, now: () => Date.now(), random: () => Math.random() };

/** App.tsx: { isTorUp, onTorState } aus TorTransport.js (vermeidet einen Import-Zyklus). */
export function configureUpdater(h = {}) {
  hooks = {
    ...hooks,
    ...Object.fromEntries(Object.entries(h).filter(([, v]) => typeof v === 'function')),
  };
}

// ── Pruefen ────────────────────────────────────────────────────────────────

async function fetchFile(name, max) {
  const u = NativeModules.MalachiUpdater;
  let res;
  try {
    res = await u.fetchSmall(UPDATE_ONION, UPDATE_PATH + name, max, FETCH_TIMEOUT_MS);
  } catch (e) {
    // Keine Fehlerdetails weiterreichen (koennten Adressen enthalten).
    throw fail(e && e.code === 'TOR_OFF' ? 'tor-aus' : 'nicht-erreichbar');
  }
  if (!res || res.status !== 200 || typeof res.bodyB64 !== 'string') {
    throw fail(res && res.status === 404 ? 'nicht-veroeffentlicht' : 'nicht-erreichbar');
  }
  if (res.bodyB64.length > Math.ceil(max / 3) * 4 + 4) throw fail(name.endsWith('.sig') ? 'signatur-ungueltig' : 'manifest-ungueltig');
  const bytes = new Uint8Array(Buffer.from(res.bodyB64, 'base64'));
  if (bytes.length === 0 || bytes.length > max) throw fail(name.endsWith('.sig') ? 'signatur-ungueltig' : 'manifest-ungueltig');
  return bytes;
}

/** Signaturdatei: nur druckbares ASCII plus CR/LF. */
function asciiText(bytes) {
  let s = '';
  for (const c of bytes) {
    if ((c < 0x20 || c > 0x7e) && c !== 0x0a && c !== 0x0d) throw fail('signatur-ungueltig');
    s += String.fromCharCode(c);
  }
  return s;
}

let checkPromise = null;

/**
 * Nach einem Update fragen (manuell: "Jetzt pruefen"; auto: Zeitplan).
 * Wirft nie - das Ergebnis steht im Zustand (update / upToDate / checkError).
 */
export function checkForUpdate(opts = {}) {
  if (!checkPromise) {
    checkPromise = doCheck(opts).finally(() => { checkPromise = null; });
  }
  return checkPromise;
}

async function doCheck({ auto = false } = {}) {
  if (!isUpdaterAvailable()) return state;
  await loadUpdateState();
  if (!isUpdaterConfigured()) {
    if (!auto) setState({ checkError: 'nicht-eingerichtet' });
    return state;
  }
  const installed = getInstalledInfo();
  if (!installed || installed.versionCode < 1 || installed.applicationId !== APPLICATION_ID) {
    if (!auto) setState({ checkError: 'nicht-verfuegbar' });
    return state;
  }
  if (!hooks.isTorUp()) {
    // Ohne Tor wird nichts abgerufen - auch kein Rueckfall auf Klartext.
    if (!auto) setState({ checkError: 'tor-aus' });
    return state;
  }
  const t = hooks.now();
  // Zeitplan sofort fortschreiben: jeder Abruf zaehlt (hoechstens 1x je 24 h + Zufall).
  persist.lastCheckAt = t;
  persist.nextCheckAt = t + CHECK_INTERVAL_MS + Math.floor(Math.min(Math.max(hooks.random(), 0), 0.999999) * CHECK_JITTER_MS);
  setState({ checking: true, checkError: null, lastCheckAt: t });
  try {
    const bytes = await fetchFile('manifest.json', MANIFEST_MAX_BYTES);
    const sigText = asciiText(await fetchFile('manifest.json.sig', SIG_MAX_BYTES));
    const m = verifyManifest(bytes, sigText);
    const { update, reason } = evaluateManifest(m, installed);
    checkRollback(m, persist.seen);
    if (!persist.seen || m.versionCode > persist.seen.versionCode
        || (m.versionCode === persist.seen.versionCode && m.published > persist.seen.published)) {
      persist.seen = { versionCode: m.versionCode, published: m.published };
    }
    if (update) {
      persist.manifestB64 = Buffer.from(bytes).toString('base64');
      persist.sigText = sigText;
    } else {
      persist.manifestB64 = null;
      persist.sigText = null;
    }
    // Anderes (oder kein) Update: frueher geladene Datei bzw. Fehler verwerfen.
    const prevSha = state.update && state.update.apk ? state.update.apk.sha256 : null;
    if ((state.dl.status === 'ready' || state.dl.status === 'error') && (!update || update.apk.sha256 !== prevSha)) {
      if (state.dl.file) cleanupFiles();
      setState({ dl: DL_IDLE });
    }
    setState({
      checking: false,
      checkError: reason,
      update,
      upToDate: !update && !reason,
      bannerDismissed: !!update && !update.important && persist.dismissed === update.versionCode,
    });
  } catch (e) {
    // Ein bereits gepruftes Update bleibt bekannt (ein Angreifer, der Muell
    // ausliefert, soll es nicht "verschwinden" lassen).
    setState({ checking: false, checkError: e instanceof UpdateError ? e.code : 'nicht-erreichbar' });
  } finally {
    await savePersist();
  }
  return state;
}

// ── Laden, Pruefen, Installieren ───────────────────────────────────────────

function cleanupFiles() {
  try {
    const p = NativeModules.MalachiUpdater?.cleanup?.();
    if (p && typeof p.catch === 'function') return p.catch(() => 0);
  } catch {}
  return Promise.resolve(0);
}

function mapDownloadError(e) {
  switch (e && e.code) {
    case 'TOR_OFF': return 'tor-aus';
    case 'UPDATE_SHA256': return 'pruefsumme';
    case 'UPDATE_TOO_LARGE': return 'zu-gross';
    case 'UPDATE_CANCELLED': return 'abgebrochen';
    case 'UPDATE_TIMEOUT': return 'zeitueberschreitung';
    default: return 'download-fehler';
  }
}

/** Paketname, versionCode, Signaturzertifikat der geladenen APK (Abschnitt 5, Schritt 8). */
async function checkApkIdentity(path, u, installed) {
  const nat = NativeModules.MalachiUpdater;
  if (typeof nat.inspectApk !== 'function') throw fail('apk-ungueltig');
  let info;
  try { info = await nat.inspectApk(path); } catch { throw fail('apk-ungueltig'); }
  if (!info || info.packageName !== installed.applicationId || info.versionCode !== u.versionCode) throw fail('apk-ungueltig');
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && SHA256_RE.test(x)) : []);
  const signers = list(info.signers);
  const installedSigners = list(info.installedSigners);
  // Liefert ein Geraet keine Zertifikate, bleibt Androids eigene Pruefung
  // beim Installieren (gleicher Schluessel wie die installierte App).
  if (signers.length && !signers.includes(u.signingCertSha256)) throw fail('apk-signatur');
  if (installedSigners.length && !installedSigners.includes(u.signingCertSha256)) throw fail('andere-signatur');
}

let progressSub = null;
function listenProgress(onProgress) {
  const nat = NativeModules.MalachiUpdater;
  try {
    const em = new NativeEventEmitter(nat);
    progressSub = em.addListener('MalachiUpdaterProgress', onProgress);
  } catch {
    progressSub = null;
  }
  return () => {
    try { progressSub?.remove(); } catch {}
    progressSub = null;
  };
}

let dlPromise = null;

/** APK des angebotenen Updates laden (nur auf Nutzerwunsch). Ergebnis: true = bereit zum Installieren. */
export function downloadUpdate() {
  if (!dlPromise) dlPromise = doDownload().finally(() => { dlPromise = null; });
  return dlPromise;
}

async function doDownload() {
  const u = state.update;
  if (!isUpdaterAvailable() || !u || !u.apk || !isUpdaterConfigured()) return false;
  const installed = getInstalledInfo();
  const apk = u.apk;
  const nat = NativeModules.MalachiUpdater;
  setState({ dl: { ...DL_IDLE, status: 'running', total: apk.size } });
  const stop = listenProgress((p) => {
    const received = p && Number.isFinite(p.received) ? Math.min(Math.max(p.received, 0), apk.size) : 0;
    if (state.dl.status === 'running') setState({ dl: { ...state.dl, received } });
  });
  try {
    let res;
    try {
      res = await nat.download(UPDATE_ONION, UPDATE_PATH + apk.file, apk.size, apk.sha256, DOWNLOAD_TIMEOUT_MS);
    } catch (e) {
      throw fail(mapDownloadError(e));
    }
    // Gegenprobe in JS - nie allein auf die native Pruefung verlassen.
    if (!res || typeof res.path !== 'string' || res.size !== apk.size || typeof res.sha256 !== 'string' || res.sha256 !== apk.sha256) {
      throw fail('pruefsumme');
    }
    await checkApkIdentity(res.path, u, installed);
    // Waehrend des Ladens kam ein anderes Update? Dann diese Datei nicht anbieten.
    if (!state.update || !state.update.apk || state.update.apk.sha256 !== apk.sha256) throw fail('abgebrochen');
    setState({ dl: { ...DL_IDLE, status: 'ready', received: res.size, total: res.size, file: { path: res.path, size: res.size, sha256: res.sha256 } } });
    return true;
  } catch (e) {
    const code = e instanceof UpdateError ? e.code : 'download-fehler';
    await cleanupFiles();
    setState({ dl: code === 'abgebrochen' ? DL_IDLE : { ...DL_IDLE, status: 'error', total: apk.size, error: code } });
    return false;
  } finally {
    stop();
  }
}

/** Laufenden Download abbrechen (Teildatei wird geloescht). */
export async function cancelDownload() {
  try { await NativeModules.MalachiUpdater?.cancelDownload?.(); } catch {}
  if (state.dl.status === 'ready' || state.dl.status === 'error') {
    await cleanupFiles();
    setState({ dl: DL_IDLE });
  }
}

/** Darf Malachi den Android-Installer aufrufen ("Unbekannte Apps installieren")? */
export async function canInstallPackages() {
  try { return (await NativeModules.MalachiUpdater?.canRequestPackageInstalls?.()) === true; } catch { return false; }
}

export async function openInstallPermissionSettings() {
  try { return (await NativeModules.MalachiUpdater?.openInstallPermissionSettings?.()) === true; } catch { return false; }
}

/**
 * Geladene, gepruefte APK an den Android-Installer geben.
 * Ergebnis: { started } | { needsPermission } | { error }.
 */
export async function installUpdate() {
  const f = state.dl.file;
  const u = state.update;
  if (!isUpdaterAvailable() || state.dl.status !== 'ready' || !f || !u) return { started: false, error: 'installation' };
  if (f.sha256 !== u.apk.sha256 || f.size !== u.apk.size) {
    await cleanupFiles();
    setState({ dl: { ...DL_IDLE, status: 'error', error: 'pruefsumme' } });
    return { started: false, error: 'pruefsumme' };
  }
  if (!(await canInstallPackages())) return { started: false, needsPermission: true };
  try {
    await NativeModules.MalachiUpdater.install(f.path, f.sha256, f.size);
    setState({ dl: { ...state.dl, installStarted: true, error: null } });
    return { started: true };
  } catch (e) {
    if (e && e.code === 'UPDATE_PERMISSION') return { started: false, needsPermission: true };
    if (e && (e.code === 'UPDATE_SHA256' || e.code === 'UPDATE_SIZE' || e.code === 'UPDATE_PATH')) {
      await cleanupFiles();
      setState({ dl: { ...DL_IDLE, status: 'error', error: 'pruefsumme' } });
      return { started: false, error: 'pruefsumme' };
    }
    setState({ dl: { ...state.dl, error: 'installation' } });
    return { started: false, error: 'installation' };
  }
}

// ── Einstellungen ──────────────────────────────────────────────────────────

export async function setAutoCheck(on) {
  await loadUpdateState();
  persist.autoCheck = !!on;
  setState({ autoCheck: persist.autoCheck });
  await savePersist();
  if (persist.autoCheck) schedTick?.();
}

/** Hinweis auf der Startseite ausblenden (wichtige Updates nur bis zum naechsten Start). */
export async function dismissBanner() {
  const u = state.update;
  setState({ bannerDismissed: true });
  if (u && !u.important) {
    persist.dismissed = u.versionCode;
    await savePersist();
  }
}

// ── Zeitplan ───────────────────────────────────────────────────────────────

let sched = null;
let schedTick = null;

/**
 * Automatische Pruefung starten (App.tsx, einmal). opts: { isTorUp, onTorState }
 * (+ now/random fuer Tests). Raeumt beim Start Reste frueherer Downloads weg.
 * Rueckgabe: Stopp-Funktion.
 */
export function startUpdateScheduler(opts = {}) {
  if (sched) return sched.stop;
  if (!isUpdaterAvailable()) return () => {};
  configureUpdater(opts);
  // Reste frueherer Downloads (nach Installation, Abbruch, Absturz) entfernen.
  cleanupFiles();
  let timer = null;
  let stopped = false;
  const due = () => state.loaded && state.autoCheck && isUpdaterConfigured() && hooks.isTorUp() && hooks.now() >= persist.nextCheckAt;
  const tick = () => {
    if (stopped || timer || checkPromise || !due()) return;
    const span = CHECK_START_DELAY_MAX_MS - CHECK_START_DELAY_MIN_MS;
    const delay = CHECK_START_DELAY_MIN_MS + Math.floor(Math.min(Math.max(hooks.random(), 0), 0.999999) * span);
    timer = setTimeout(() => {
      timer = null;
      if (stopped || !due()) return;
      checkForUpdate({ auto: true }).catch(() => {});
    }, delay);
  };
  schedTick = tick;
  loadUpdateState().then(tick).catch(() => {});
  let unsubTor = null;
  if (typeof hooks.onTorState === 'function') {
    try { unsubTor = hooks.onTorState(() => tick()); } catch { unsubTor = null; }
  }
  const interval = setInterval(tick, SCHEDULER_TICK_MS);
  sched = {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      clearInterval(interval);
      try { if (typeof unsubTor === 'function') unsubTor(); } catch {}
      sched = null;
      schedTick = null;
    },
  };
  return sched.stop;
}

/** Nur fuer Tests: Modulzustand zuruecksetzen. */
export function _resetUpdaterForTests() {
  sched?.stop();
  sched = null;
  schedTick = null;
  state = initialState();
  persist = { ...DEFAULT_PERSIST };
  loadPromise = null;
  checkPromise = null;
  dlPromise = null;
  saveChain = Promise.resolve();
  hooks = { isTorUp: () => true, onTorState: null, now: () => Date.now(), random: () => Math.random() };
  listeners.clear();
}
