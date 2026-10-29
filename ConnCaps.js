/**
 * Malachi – ConnCaps.js  (Krypto-Review 2026-10-25: Downgrade-Schutz)
 *
 * Merkt sich pro Kontakt, welche neueren Verfahren er nachweislich schon
 * benutzt hat - "klebrig" wie die Ratchet-Faehigkeit (RatchetSession.js):
 *   tor  Tor-Anmeldung mit eindeutig kodiertem MAC (TorTransport.js, K-11)
 *   ol   aeussere Schicht v2: Schluessel je Richtung + AAD (MessageCrypto.js, K-09)
 *   kx   Verbindungsschluessel v2: X25519 + ML-KEM-768, Transkript- und
 *        Kettenbindung (WebRTCManager.js, V5)
 * Hat ein Kontakt ein Verfahren einmal benutzt, wird eine Verbindung bzw.
 * Anmeldung ohne es abgelehnt - ein Angreifer, der Transport/Tor bricht, kann
 * so nicht auf das alte Verfahren zurueckstufen. (Kehrseite wie beim Ratchet:
 * wer die App auf eine aeltere Version zuruecksetzt, kommt mit diesem Kontakt
 * nicht mehr ins Gespraech, bis er wieder aktualisiert.)
 *
 * Gespeichert: EncryptedStorage 'conn_caps_<id>' = {"tor":2,"ol":2,"kx":2}.
 * Gesetzt wird erst nach einer erfolgreich benutzten Verbindung/Anmeldung.
 */
import EncryptedStorage from 'react-native-encrypted-storage';

export const CONN_CAPS_PREFIX = 'conn_caps_';
const KNOWN = ['tor', 'ol', 'kx'];

const cache = new Map();
const locks = new Map();
let epoch = 0;

function normalize(raw) {
  let r = null;
  try { r = raw ? JSON.parse(raw) : null; } catch { r = null; }
  const out = {};
  if (r && typeof r === 'object') {
    for (const k of KNOWN) if (Number.isInteger(r[k]) && r[k] >= 2 && r[k] <= 9) out[k] = r[k];
  }
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
  // Lesefehler: lieber "nichts bekannt" als die Verbindung zu blockieren -
  // der Schutz greift dann beim naechsten erfolgreichen Lesen wieder.
  const raw = await EncryptedStorage.getItem(CONN_CAPS_PREFIX + chatId).catch(() => null);
  const rec = normalize(raw);
  cache.set(chatId, rec);
  return rec;
}

/** Bekannte Verfahren des Kontakts ({} = keine). */
export function getConnCaps(chatId) {
  if (!chatId) return Promise.resolve({});
  if (cache.has(chatId)) return Promise.resolve({ ...cache.get(chatId) });
  return withLock(chatId, () => load(chatId)).then((r) => ({ ...r }), () => ({}));
}

export function preload(chatId) {
  return getConnCaps(chatId).then(() => {});
}

/** Verfahren nachweislich benutzt - klebrig (nur aufwaerts). */
export function noteConnCap(chatId, key, version) {
  if (!chatId || !KNOWN.includes(key) || !Number.isInteger(version) || version < 2) return Promise.resolve();
  const myEpoch = epoch;
  return withLock(chatId, async () => {
    const rec = await load(chatId);
    if ((rec[key] || 0) >= version) return;
    const next = { ...rec, [key]: version };
    if (myEpoch !== epoch) return;
    await EncryptedStorage.setItem(CONN_CAPS_PREFIX + chatId, JSON.stringify(next));
    if (myEpoch !== epoch) {
      await EncryptedStorage.removeItem(CONN_CAPS_PREFIX + chatId).catch(() => {});
      return;
    }
    cache.set(chatId, next);
  }).catch(() => {});
}

export function forget(chatId) {
  if (!chatId) return Promise.resolve();
  cache.delete(chatId);
  return withLock(chatId, async () => {
    cache.delete(chatId);
    await EncryptedStorage.removeItem(CONN_CAPS_PREFIX + chatId);
  }).catch(() => {});
}

export function forgetFromMemory(chatId) { cache.delete(chatId); }

export function forgetAll() {
  epoch++;
  cache.clear();
}

export function _resetConnCapsForTests() {
  forgetAll();
  locks.clear();
}
