/**
 * Malachi – SafetyNumber.js  (stabiler Sicherheitscode, Krypto-Review 2026-10-25 V1)
 *
 * Bisher war der Sicherheitscode SHA-256 des Geheimnisses der AKTUELLEN
 * Verbindung (WebRTCManager._computeSafetyCode): Er aenderte sich bei jedem
 * Neuaufbau, Tor-Reserve und Direkt-Upgrade, die App meldete staendig "Code
 * geaendert", und einen dauerhaften "verifiziert"-Zustand gab es nicht. Damit
 * war die einzige Erkennung eines Manns in der Mitte praktisch stumpf
 * (Befunde K-01, K-03, K-10; entschaerft K-02).
 *
 * Jetzt: Der Code haengt an der Double-Ratchet-SITZUNG des Kontakts, nicht an
 * der Verbindung:
 *
 *   SN = HKDF-SHA256(ikm = AD_s, salt = "malachi-safety-number-v2",
 *                    info = "malachi-safety-v2|digits", 30 Byte)
 *        -> 6 Gruppen zu je 5 Ziffern (je 5 Byte als Zahl mod 100000)
 *
 * AD_s (DoubleRatchet.deriveInit) entsteht beim Sitzungsaufbau aus dem
 * ML-KEM-Geheimnis der Verbindung, auf der die Sitzung entstand, ist auf
 * beiden Geraeten gleich und unabhaengig von der Rolle - und bleibt fuer die
 * ganze Sitzung gleich. Bei einem Mann in der Mitte gibt es zwei Sitzungen mit
 * zwei verschiedenen AD_s: Er kann keine der beiden Seiten auf dasselbe
 * Geheimnis zwingen (ML-KEM bindet das Geheimnis an den oeffentlichen Schluessel
 * des Empfaengers), und 30 Ziffern (~100 bit) lassen sich nicht durchprobieren.
 * Der Code zeigt nur einen HKDF-Wert von AD_s - nichts, woraus sich ein
 * Schluessel ableiten liesse (AD_s ist ohnehin nur "associated data").
 *
 * Gegenseiten 1.0/1.1 kennen das nicht und zeigen weiter den alten,
 * verbindungsbezogenen 16-stelligen Code. Deshalb meldet jede Seite im
 * profile_name caps.sn = 2; ist das von der Gegenseite (noch) nicht bekannt,
 * zeigt die App den alten Code mit dem Hinweis, dass er nur fuer diese
 * Verbindung gilt (mode 'legacy').
 *
 * Gespeichert pro Kontakt (EncryptedStorage 'safety_v2_<id>', nur Anzeige-
 * Zustand, keine Schluessel):
 *   { v:1, peer: 0|2, sn, verified, changed, prev, legacy }
 *   sn        zuletzt gesehener Code (Grundlage fuer "geaendert")
 *   verified  Code, den der Nutzer ausdruecklich als "stimmt ueberein"
 *             bestaetigt hat (gilt nur, solange er dem aktuellen entspricht)
 *   changed   die Sitzung (und damit der Code) hat sich seit dem letzten Mal
 *             geaendert - echter Neuaufbau (Zuruecksetzen, Neu-Kopplung),
 *             NICHT eine neue Verbindung
 *   legacy    bestaetigter alter Verbindungscode (nur fuer die Verbindung, in
 *             der er bestaetigt wurde)
 * Migration: bestehende Kontakte haben keinen Eintrag; der erste berechnete
 * Code wird ohne Warnung zur Grundlage (wie bei einer neuen Kopplung).
 */
import EncryptedStorage from 'react-native-encrypted-storage';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { Buffer } from 'buffer';
import * as RatchetSession from './RatchetSession';

export const SAFETY_CAP_VERSION = 2;
export const SAFETY_KEY_PREFIX = 'safety_v2_';
export const SAFETY_GROUPS = 6;
const GROUP_BYTES = 5;
const RECORD_VERSION = 1;

const utf8 = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const SALT = utf8('malachi-safety-number-v2');
const INFO = utf8('malachi-safety-v2|digits');
const SN_RE = /^\d{5}( \d{5}){5}$/;

const cache = new Map();   // kontaktId -> Eintrag
const locks = new Map();
let epoch = 0;

/** Sicherheitscode (6 x 5 Ziffern, durch Leerzeichen getrennt) aus AD_s (Base64). */
export function safetyNumberFromAd(adB64) {
  const ad = Uint8Array.from(Buffer.from(String(adB64 || ''), 'base64'));
  if (ad.length !== 32) throw new Error('Sitzungsbindung ungueltig');
  const out = hkdf(sha256, ad, SALT, INFO, SAFETY_GROUPS * GROUP_BYTES);
  const groups = [];
  for (let g = 0; g < SAFETY_GROUPS; g++) {
    let v = 0;
    // 40 bit passen exakt in eine JS-Zahl; mod 100000 verzerrt um < 2^-23.
    for (let i = 0; i < GROUP_BYTES; i++) v = v * 256 + out[g * GROUP_BYTES + i];
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  out.fill(0);
  return groups.join(' ');
}

export const isSafetyNumber = (s) => typeof s === 'string' && SN_RE.test(s);

function emptyRecord() {
  return { v: RECORD_VERSION, peer: 0, sn: null, verified: null, changed: false, prev: null, legacy: null };
}

function normalize(raw) {
  let r = null;
  try { r = raw ? JSON.parse(raw) : null; } catch { r = null; }
  const out = emptyRecord();
  if (!r || typeof r !== 'object') return out;
  if (r.peer === SAFETY_CAP_VERSION) out.peer = r.peer;
  if (isSafetyNumber(r.sn)) out.sn = r.sn;
  if (isSafetyNumber(r.verified)) out.verified = r.verified;
  if (isSafetyNumber(r.prev)) out.prev = r.prev;
  out.changed = r.changed === true;
  if (typeof r.legacy === 'string' && r.legacy.length <= 32) out.legacy = r.legacy;
  return out;
}

function withLock(chatId, fn) {
  const prev = locks.get(chatId) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(chatId, tail);
  tail.then(() => { if (locks.get(chatId) === tail) locks.delete(chatId); });
  return run;
}

async function load(chatId) {
  if (cache.has(chatId)) return cache.get(chatId);
  const rec = normalize(await EncryptedStorage.getItem(SAFETY_KEY_PREFIX + chatId));
  cache.set(chatId, rec);
  return rec;
}

// Liest-aendert-schreibt unter der Sperre des Kontakts; mutate liefert false,
// wenn nichts zu tun ist.
function update(chatId, mutate) {
  const myEpoch = epoch;
  return withLock(chatId, async () => {
    const rec = { ...(await load(chatId)) };
    if (mutate(rec) === false) return rec;
    if (myEpoch !== epoch) return rec;
    await EncryptedStorage.setItem(SAFETY_KEY_PREFIX + chatId, JSON.stringify(rec));
    if (myEpoch !== epoch) {
      await EncryptedStorage.removeItem(SAFETY_KEY_PREFIX + chatId).catch(() => {});
      return rec;
    }
    cache.set(chatId, rec);
    return rec;
  });
}

/** Faehigkeit der Gegenseite aus profile_name/handshake (caps.sn). Klebrig. */
export function notePeerSafetyCap(chatId, version) {
  if (!chatId || !(Number(version) >= SAFETY_CAP_VERSION)) return Promise.resolve();
  return update(chatId, (r) => {
    if (r.peer === SAFETY_CAP_VERSION) return false;
    r.peer = SAFETY_CAP_VERSION;
    return true;
  }).then(() => {}, () => {});
}

/**
 * Anzeige-Zustand fuer den Kontakt.
 * legacyCode: 16-stelliger Code der aktuellen Verbindung (rtc.safetyCode) -
 * nur fuer Gegenseiten ohne caps.sn und solange die Sitzung noch entsteht.
 * -> { mode: 'v2' | 'legacy' | 'pending', number, verified, changed,
 *      legacyCode, legacyVerified }
 */
export async function getSafetyInfo(chatId, { legacyCode = null } = {}) {
  if (!chatId) return null;
  const sess = await RatchetSession.safetySession(chatId);
  let rec = await withLock(chatId, () => load(chatId));
  let number = null;
  if (sess && sess.active) {
    try { number = safetyNumberFromAd(sess.ad); } catch { number = null; }
  }
  // Grundlage bzw. echter Sitzungswechsel - auch waehrend die Gegenseite noch
  // eine aeltere Version hat, damit ein Wechsel spaeter nicht unbemerkt bleibt.
  if (number && rec.sn !== number) {
    rec = await update(chatId, (r) => {
      if (r.sn === number) return false;
      if (r.sn) {
        r.prev = r.sn;
        r.changed = true;
        r.verified = null;
      }
      r.sn = number;
      return true;
    });
  }
  const legacy = typeof legacyCode === 'string' && legacyCode ? legacyCode : null;
  const base = { legacyCode: legacy, legacyVerified: !!legacy && rec.legacy === legacy };
  if (rec.peer >= SAFETY_CAP_VERSION && number) {
    return { ...base, mode: 'v2', number, verified: rec.verified === number, changed: !!rec.changed };
  }
  if (rec.peer >= SAFETY_CAP_VERSION) return { ...base, mode: 'pending', number: null, verified: false, changed: false };
  return { ...base, mode: 'legacy', number: null, verified: false, changed: false };
}

/** Nutzer bestaetigt: "stimmt ueberein". Nur fuer den aktuellen Code. -> bool */
export async function markVerified(chatId, number) {
  if (!chatId || !isSafetyNumber(number)) return false;
  const sess = await RatchetSession.safetySession(chatId);
  if (!sess || !sess.active) return false;
  let current = null;
  try { current = safetyNumberFromAd(sess.ad); } catch { return false; }
  if (current !== number) return false;
  await update(chatId, (r) => {
    r.sn = current;
    r.verified = current;
    r.changed = false;
    return true;
  });
  return true;
}

/** Bestaetigung zuruecknehmen (z.B. versehentlich getippt). */
export function unverify(chatId) {
  if (!chatId) return Promise.resolve();
  return update(chatId, (r) => {
    if (!r.verified) return false;
    r.verified = null;
    return true;
  }).then(() => {});
}

/** Hinweis "Code hat sich geaendert" gesehen. */
export function acknowledgeChange(chatId) {
  if (!chatId) return Promise.resolve();
  return update(chatId, (r) => {
    if (!r.changed) return false;
    r.changed = false;
    return true;
  }).then(() => {});
}

/** Alter Verbindungscode (Gegenseite 1.0/1.1) fuer diese Verbindung bestaetigt. */
export function markLegacyVerified(chatId, code) {
  if (!chatId || typeof code !== 'string' || !code || code.length > 32) return Promise.resolve(false);
  return update(chatId, (r) => {
    r.legacy = code;
    return true;
  }).then(() => true);
}

/** Kontakt geloescht: Eintrag weg. */
export function forget(chatId) {
  if (!chatId) return Promise.resolve();
  cache.delete(chatId);
  return withLock(chatId, async () => {
    cache.delete(chatId);
    await EncryptedStorage.removeItem(SAFETY_KEY_PREFIX + chatId);
  }).catch(() => {});
}

export function forgetFromMemory(chatId) { cache.delete(chatId); }

/** Wipe: Arbeitsspeicher leeren; laufende Schreibvorgaenge speichern nichts mehr. */
export function forgetAll() {
  epoch++;
  cache.clear();
}

export function _resetSafetyNumberForTests() {
  forgetAll();
  locks.clear();
}
