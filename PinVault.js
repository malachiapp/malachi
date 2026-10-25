/**
 * Malachi – PinVault.js  (PIN-Tresor, Audit 2026-10-25 E1)
 *
 * Bisher war die App-PIN nur ein Sperrbildschirm: alle Daten lagen im
 * verschluesselten Speicher (Android Keystore), den das Geraet aber OHNE PIN
 * oeffnen kann - wer an die App-Daten kam (Forensik am entsperrten Geraet,
 * Root), konnte alle Chats lesen, und die PIN lag selbst dort.
 *
 * Jetzt sind Chatverlaeufe ('chat_<id>', 'gchat_<id>'), die Vorschautexte
 * der Chatliste und die Schluessel der Empfangs-Ablage zusaetzlich mit einem
 * Tresorschluessel (DEK) verschluesselt, der NUR nach PIN oder Fingerabdruck
 * im Arbeitsspeicher liegt:
 *
 *   kek  = HMAC_Chip(Argon2id(PIN, Salz))            nativ, MalachiPinKeyModule
 *   wrap = XChaCha20-Poly1305(kek, DEK)               im Speicher abgelegt
 *   Werte: "pv1:d:" XChaCha20-Poly1305(DEK, Wert, AD = Schluesselname)
 *
 * Ohne den Chip DIESES Geraets ist kein Rateversuch moeglich; am Geraet
 * bremsen Argon2id, der Chip und die Fehlversuchssperre der App. Die PIN
 * selbst wird nicht mehr gespeichert; die Notfall-PIN nur als Pruefwert.
 *
 * Empfangen bei gesperrter App: der Hintergrunddienst muss Nachrichten
 * ablegen koennen, ohne die PIN zu kennen. Dafuer gibt es ein X25519-
 * Schluesselpaar: der oeffentliche Teil liegt offen im Tresor-Datensatz, der
 * private nur mit dem DEK verschluesselt. Gesperrt geschriebene Werte und
 * Aenderungen werden damit "versiegelt" ("pv1:s:", Sealed Box: X25519 +
 * HKDF-SHA256 + XChaCha20-Poly1305) - lesen kann sie erst die entsperrte App.
 * Aenderungen an einem gesperrten Verlauf (neue Gruppennachricht, Haekchen,
 * Loeschung) landen als versiegelte Eintraege in einem Journal ('vj_<key>')
 * und werden beim naechsten Lesen nach dem Entsperren eingearbeitet
 * (registerMerger - die Zusammenfuehrung muss idempotent sein).
 *
 * Bewusst NICHT PIN-gebunden (der Hintergrunddienst braucht sie ohne PIN):
 * Kontakte (Name, Adresse), Verbindungsschluessel, die Sende-Warteschlange
 * (noch nicht zugestellte eigene Nachrichten), Einstellungen. Sie bleiben wie
 * bisher im verschluesselten Speicher des Geraets.
 *
 * Ohne Tresor (Alt-Installation vor dem ersten Entsperren nach dem Update,
 * fehlendes natives Modul) verhalten sich alle Funktionen exakt wie vorher.
 */
import { NativeModules } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { Buffer } from 'buffer';
import { secureRandomBytes } from './MessageCrypto';

export const RECORD_KEY = 'pin_vault_v1';
export const RECORD_BAK_KEY = 'pin_vault_v1_bak';
export const JOURNAL_PREFIX = 'vj_';
export const VAULT_PREFIXES = ['chat_', 'gchat_'];
export const ENC_PREFIX = 'pv1:';
const SYM_PREFIX = 'pv1:d:';
const SEALED_PREFIX = 'pv1:s:';
export const KDF = { alg: 'argon2id+chip-hmac', memKiB: 32 * 1024, iterations: 3 };
export const JOURNAL_MAX = 3000;
const LABEL = 'malachi-pin-vault-v1';

const enc = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const dec = (u8) => Buffer.from(u8).toString('utf8');
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => Uint8Array.from(Buffer.from(String(s), 'base64'));
const native = () => NativeModules.MalachiPinKey;

export class VaultLockedError extends Error {
  constructor() { super('PIN-Tresor ist gesperrt'); this.code = 'VAULT_LOCKED'; }
}
export class VaultCorruptError extends Error {
  constructor(what) { super('PIN-Tresor: ' + what + ' nicht lesbar'); this.code = 'VAULT_CORRUPT'; }
}
export const isVaultLocked = (e) => e?.code === 'VAULT_LOCKED';
export const isVaultError = (e) => e?.code === 'VAULT_LOCKED' || e?.code === 'VAULT_CORRUPT';

// ─── Zustand ────────────────────────────────────────────────────────────────
let rec;              // undefined = noch nicht geladen, null = kein Tresor, sonst Datensatz
let loading = null;
let session = null;   // { dek: Uint8Array, priv: Uint8Array }
let lockTimer = null;
const previewCache = new Map();
const listeners = new Set();
const mergers = new Map();   // Praefix -> async (value|null, ops[], key) => value|null
const keyChains = new Map();

function notify() { for (const l of listeners) { try { l(isUnlocked()); } catch {} } }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const isVaultKey = (key) => typeof key === 'string' && VAULT_PREFIXES.some((p) => key.startsWith(p));
export function isUnlocked() { return !!session; }
// true = Tresor eingerichtet, aber gesperrt (nur nach ready() verlaesslich).
export function isLockedVault() { return !!rec && !session; }
export function hasVault() { return !!rec; }

function validRecord(r) {
  return !!r && r.v === 1 && typeof r.salt === 'string' && r.kdf && r.wrap?.n && r.wrap?.c
    && typeof r.pub === 'string' && r.priv?.n && r.priv?.c;
}

async function loadRecord() {
  let raw = await EncryptedStorage.getItem(RECORD_KEY);   // Lesefehler: werfen, nie "kein Tresor"
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!validRecord(parsed)) {
    const bak = await EncryptedStorage.getItem(RECORD_BAK_KEY);
    let pb = null;
    try { pb = bak ? JSON.parse(bak) : null; } catch { pb = null; }
    if (validRecord(pb)) {
      parsed = pb;
      await EncryptedStorage.setItem(RECORD_KEY, bak).catch(() => {});
    } else if (raw || bak) {
      // Datensatz vorhanden, aber unlesbar: NIE als "kein Tresor" behandeln -
      // sonst wuerde ein neuer angelegt und der Chip-Schluessel ersetzt.
      throw new VaultCorruptError('Tresor-Datensatz');
    }
  }
  return parsed;
}

// Laedt den Tresor-Datensatz (einmal; bei einem Lesefehler beim naechsten Aufruf erneut).
export function ready() {
  if (rec !== undefined) return Promise.resolve(rec);
  if (!loading) {
    loading = loadRecord().then((r) => { rec = r; return r; }).finally(() => { loading = null; });
  }
  return loading;
}

async function saveRecord(r) {
  const s = JSON.stringify(r);
  await EncryptedStorage.setItem(RECORD_KEY, s);
  await EncryptedStorage.setItem(RECORD_BAK_KEY, s);
  rec = r;
}

// ─── Kryptografie ───────────────────────────────────────────────────────────
function aead(key, nonce, ad) { return xchacha20poly1305(key, nonce, enc(ad)); }

function open(key, box, ad) {
  try { return aead(key, unb64(box.n), ad).decrypt(unb64(box.c)); } catch { return null; }
}

async function seal(key, plain, ad) {
  const n = await secureRandomBytes(24);
  return { n: b64(n), c: b64(aead(key, n, ad).encrypt(plain)) };
}

function sealKey(shared, ephPub, pub, ctx) {
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(pub, 32);
  return hkdf(sha256, shared, salt, enc(LABEL + '|seal|' + ctx), 32);
}

// Versiegelt Text fuer den Tresor (nur mit dem oeffentlichen Schluessel -
// klappt auch gesperrt). ctx bindet den Inhalt an seinen Zweck/Schluessel.
async function sealString(text, ctx) {
  if (!rec) throw new Error('kein Tresor');
  const pub = unb64(rec.pub);
  const rnd = await secureRandomBytes(56);
  const eph = rnd.slice(0, 32);
  const nonce = rnd.slice(32);
  const ephPub = x25519.getPublicKey(eph);
  const k = sealKey(x25519.getSharedSecret(eph, pub), ephPub, pub, ctx);
  eph.fill(0);
  const ct = xchacha20poly1305(k, nonce, enc(ctx)).encrypt(enc(text));
  k.fill(0);
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return SEALED_PREFIX + b64(out);
}

function openSealed(s, ctx) {
  if (!session) throw new VaultLockedError();
  const raw = unb64(s.slice(SEALED_PREFIX.length));
  if (raw.length < 56 + 16) return null;
  const ephPub = raw.slice(0, 32);
  try {
    const pub = x25519.getPublicKey(session.priv);
    const k = sealKey(x25519.getSharedSecret(session.priv, ephPub), ephPub, pub, ctx);
    const plain = xchacha20poly1305(k, raw.slice(32, 56), enc(ctx)).decrypt(raw.slice(56));
    k.fill(0);
    return dec(plain);
  } catch {
    return null;
  }
}

async function encSym(key, text) {
  const n = await secureRandomBytes(24);
  const ct = aead(session.dek, n, LABEL + '|data|' + key).encrypt(enc(text));
  const out = new Uint8Array(24 + ct.length);
  out.set(n, 0);
  out.set(ct, 24);
  return SYM_PREFIX + b64(out);
}

// Entschluesselt einen gespeicherten Wert (Altbestand im Klartext unveraendert).
function decodeValue(key, raw) {
  if (raw == null) return null;
  if (!raw.startsWith(ENC_PREFIX)) return raw;
  if (!session) throw new VaultLockedError();
  if (raw.startsWith(SYM_PREFIX)) {
    const u = unb64(raw.slice(SYM_PREFIX.length));
    try {
      return dec(aead(session.dek, u.slice(0, 24), LABEL + '|data|' + key).decrypt(u.slice(24)));
    } catch {
      throw new VaultCorruptError(key);
    }
  }
  if (raw.startsWith(SEALED_PREFIX)) {
    const v = openSealed(raw, 'value|' + key);
    if (v == null) throw new VaultCorruptError(key);
    return v;
  }
  throw new VaultCorruptError(key);
}

// ─── Einrichten / Entsperren ────────────────────────────────────────────────
// 'present' | 'absent' | 'unknown' (Speicher nicht lesbar)
export async function vaultState() {
  try { return (await ready()) ? 'present' : 'absent'; } catch { return 'unknown'; }
}

export function isAvailable() {
  const n = native();
  return !!(n && typeof n.createKey === 'function' && typeof n.deriveKey === 'function');
}

function deriveKek(pin, r) {
  return native().deriveKey(String(pin), r.salt, r.kdf.memKiB, r.kdf.iterations).then(unb64);
}

function duressTag(kek) {
  return b64(hmac(sha256, kek, enc(LABEL + '|duress')));
}

function ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Legt den Tresor mit dieser PIN an (Ersteinrichtung oder erstes Entsperren
 * nach dem Update) und entsperrt ihn. duressPin: bisherige Notfall-PIN im
 * Klartext (Altbestand) - wird nur noch als Pruefwert abgelegt.
 * Wirft, wenn es schon einen Tresor gibt oder der Speicher nicht lesbar ist.
 */
export async function create(pin, { duressPin = null } = {}) {
  if (!isAvailable()) throw new Error('PIN-Tresor nicht verfuegbar');
  const state = await vaultState();
  if (state === 'present') throw new Error('PIN-Tresor existiert bereits');
  if (state !== 'absent') throw new Error('Speicher nicht lesbar');
  const security = await native().createKey();
  const salt = await secureRandomBytes(16);
  const r = { v: 1, kdf: { ...KDF }, salt: b64(salt), security };
  const kek = await deriveKek(pin, r);
  if (kek.length !== 32) throw new Error('Schluessel ungueltig');
  const dek = await secureRandomBytes(32);
  const priv = await secureRandomBytes(32);
  r.wrap = await seal(kek, dek, LABEL + '|wrap');
  r.pub = b64(x25519.getPublicKey(priv));
  r.priv = await seal(dek, priv, LABEL + '|priv');
  if (duressPin && String(duressPin) !== String(pin)) {
    const dk = await deriveKek(duressPin, r);
    r.duress = duressTag(dk);
    dk.fill(0);
  }
  // Probe: mit derselben Ableitung wieder oeffnen, bevor irgendetwas davon abhaengt.
  const check = open(await deriveKek(pin, r), r.wrap, LABEL + '|wrap');
  if (!check || b64(check) !== b64(dek)) throw new Error('Tresor-Probe fehlgeschlagen');
  check.fill(0);
  kek.fill(0);
  await saveRecord(r);
  session = { dek, priv };
  previewCache.clear();
  notify();
  return { security };
}

/**
 * Entsperrt mit der PIN. -> { ok:true } | { ok:false, duress:true }
 *   | { ok:false, reason: 'wrong' | 'none' | 'nokey' | 'error' }
 */
export async function unlockWithPin(pin) {
  let r;
  try { r = await ready(); } catch { return { ok: false, reason: 'error' }; }
  if (!r) return { ok: false, reason: 'none' };
  let kek;
  try {
    kek = await deriveKek(pin, r);
  } catch (e) {
    return { ok: false, reason: e?.code === 'PIN_NO_KEY' ? 'nokey' : 'error' };
  }
  try {
    if (r.duress && ctEqual(duressTag(kek), r.duress)) return { ok: false, duress: true };
    const dek = open(kek, r.wrap, LABEL + '|wrap');
    if (!dek) return { ok: false, reason: 'wrong' };
    return unlockWithDek(dek) ? { ok: true } : { ok: false, reason: 'error' };
  } finally {
    kek.fill(0);
  }
}

function unlockWithDek(dek) {
  const priv = open(dek, rec.priv, LABEL + '|priv');
  if (!priv) { dek.fill(0); return false; }
  if (session) lock();
  session = { dek, priv };
  previewCache.clear();
  notify();
  return true;
}

export function hasBiometrics() { return !!rec?.bio?.iv; }

// Fingerabdruck: nur moeglich, wenn er nach einem PIN-Entsperren eingerichtet wurde.
// -> { ok } | { ok:false, reason: 'none' | 'cancel' | 'invalidated' | 'error' }
export async function unlockWithBiometrics(texts) {
  let r;
  try { r = await ready(); } catch { return { ok: false, reason: 'error' }; }
  if (!r?.bio?.iv || !native()?.bioUnwrap) return { ok: false, reason: 'none' };
  let dekB64;
  try {
    dekB64 = await native().bioUnwrap(r.bio.iv, r.bio.ct, texts.title, texts.subtitle || '', texts.cancel);
  } catch (e) {
    if (e?.code === 'BIO_CANCEL') return { ok: false, reason: 'cancel' };
    if (e?.code === 'BIO_INVALIDATED' || e?.code === 'BIO_NO_KEY') {
      const { bio, ...rest } = rec;
      await saveRecord(rest).catch(() => {});
      return { ok: false, reason: 'invalidated' };
    }
    return { ok: false, reason: 'error' };
  }
  const dek = unb64(dekB64);
  if (dek.length !== 32) return { ok: false, reason: 'error' };
  return unlockWithDek(dek) ? { ok: true } : { ok: false, reason: 'error' };
}

export async function biometricsAvailable() {
  try { return !!(await native()?.bioAvailable?.()); } catch { return false; }
}

// Richtet den Fingerabdruck ein (Systemdialog). Nur entsperrt.
export async function enrollBiometrics(texts) {
  if (!session || !rec) return false;
  try {
    const res = await native().bioEnroll(b64(session.dek), texts.title, texts.subtitle || '', texts.cancel);
    if (!res?.iv || !res?.ct) return false;
    await saveRecord({ ...rec, bio: { iv: res.iv, ct: res.ct } });
    return true;
  } catch {
    return false;
  }
}

export async function removeBiometrics() {
  if (!rec?.bio) return;
  const { bio, ...rest } = rec;
  await saveRecord(rest);
  try { await native()?.bioRemove?.(); } catch {}
}

export function hasDuressPin() { return !!rec?.duress; }

// Notfall-PIN setzen (nur entsperrt). -> 'ok' | 'same' (ist die echte PIN) | 'error'
export async function setDuressPin(pin) {
  if (!session || !rec) return 'error';
  let kek;
  try { kek = await deriveKek(pin, rec); } catch { return 'error'; }
  try {
    const dek = open(kek, rec.wrap, LABEL + '|wrap');
    if (dek) { dek.fill(0); return 'same'; }
    await saveRecord({ ...rec, duress: duressTag(kek) });
    return 'ok';
  } finally {
    kek.fill(0);
  }
}

export async function clearDuressPin() {
  if (!rec?.duress) return;
  const { duress, ...rest } = rec;
  await saveRecord(rest);
}

// Sperrt: Tresorschluessel aus dem Arbeitsspeicher.
export function lock() {
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  previewCache.clear();
  if (!session) return;
  try { session.dek.fill(0); session.priv.fill(0); } catch {}
  session = null;
  notify();
}

// App im Hintergrund: nach ms sperren (gleiche Frist wie der Sperrbildschirm).
export function scheduleLock(ms) {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { lockTimer = null; lock(); }, Math.max(0, ms));
  lockTimer?.unref?.();
}
export function cancelScheduledLock() {
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}

// Loeschen (Wipe, Notfall-PIN): Datensatz und Chip-Schluessel vernichten -
// danach sind alle verschluesselten Werte unwiederbringlich unlesbar.
export async function wipe() {
  lock();
  rec = null;
  await EncryptedStorage.removeItem(RECORD_KEY).catch(() => {});
  await EncryptedStorage.removeItem(RECORD_BAK_KEY).catch(() => {});
  try { await native()?.destroyKey?.(); } catch {}
  rec = undefined;
}

// ─── Speicher-Schnittstelle fuer Tresor-Schluessel ─────────────────────────
function withKeyLock(key, fn) {
  const prev = keyChains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  keyChains.set(key, tail);
  tail.then(() => { if (keyChains.get(key) === tail) keyChains.delete(key); });
  return run;
}

export function registerMerger(prefix, fn) { mergers.set(prefix, fn); }
function mergerFor(key) {
  for (const [p, fn] of mergers) if (key.startsWith(p)) return fn;
  return null;
}

async function readJournal(key) {
  const raw = await EncryptedStorage.getItem(JOURNAL_PREFIX + key);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

async function writeValue(key, value) {
  if (value == null) { await EncryptedStorage.removeItem(key); return; }
  if (!rec) { await EncryptedStorage.setItem(key, value); return; }
  if (session) await EncryptedStorage.setItem(key, await encSym(key, value));
  else await EncryptedStorage.setItem(key, await sealString(value, 'value|' + key));
}

// Liest und fuehrt das Journal ein (nur entsperrt; Aufrufer haelt die Sperre).
async function readMerged(key) {
  const raw = await EncryptedStorage.getItem(key);
  if (!rec) return raw;
  let value = decodeValue(key, raw);   // wirft gesperrt/unlesbar
  const journal = await readJournal(key);
  if (journal.length) {
    const merge = mergerFor(key);
    if (!merge) return value;          // ohne Zusammenfuehrung Journal behalten
    const ops = [];
    for (const s of journal) {
      const plain = openSealed(s, 'journal|' + key);
      if (plain == null) continue;
      try { ops.push(JSON.parse(plain)); } catch {}
    }
    value = await merge(value, ops, key);
    await writeValue(key, value);
    await EncryptedStorage.removeItem(JOURNAL_PREFIX + key);
  } else if (raw != null && !raw.startsWith(SYM_PREFIX)) {
    // Altbestand (Klartext) bzw. gesperrt Versiegeltes bei der Gelegenheit
    // auf den schnellen symmetrischen Weg umschreiben.
    await writeValue(key, value);
  }
  return value;
}

export async function getItem(key) {
  await ready();
  if (!rec) return EncryptedStorage.getItem(key);
  if (!session) throw new VaultLockedError();
  return withKeyLock(key, () => readMerged(key));
}

export async function setItem(key, value) {
  await ready();
  return withKeyLock(key, () => writeValue(key, value));
}

export async function removeItem(key) {
  await ready().catch(() => {});
  return withKeyLock(key, async () => {
    await EncryptedStorage.removeItem(key);
    await EncryptedStorage.removeItem(JOURNAL_PREFIX + key);
  });
}

async function appendJournal(key, op) {
  const sealed = await sealString(JSON.stringify(op), 'journal|' + key);
  const list = await readJournal(key);
  list.push(sealed);
  const kept = list.length > JOURNAL_MAX ? list.slice(-JOURNAL_MAX) : list;
  await EncryptedStorage.setItem(JOURNAL_PREFIX + key, JSON.stringify(kept));
}

/**
 * Aendert einen Tresor-Wert ueber die registrierte Zusammenfuehrung.
 * Entsperrt (oder ohne Tresor): sofort lesen-aendern-schreiben.
 * Gesperrt: versiegelt ins Journal. -> { journaled, value }
 */
export async function update(key, op) {
  await ready();
  const merge = mergerFor(key);
  if (!merge) throw new Error('keine Zusammenfuehrung fuer ' + key);
  return withKeyLock(key, async () => {
    if (rec && !session) {
      await appendJournal(key, op);
      return { journaled: true, value: undefined };
    }
    const cur = rec ? await readMerged(key) : await EncryptedStorage.getItem(key);
    const next = await merge(cur, [op], key);
    if (next !== cur) await writeValue(key, next);
    return { journaled: false, value: next };
  }).catch(async (e) => {
    // Zwischen Pruefung und Lesen gesperrt: dann eben ins Journal.
    if (!isVaultLocked(e)) throw e;
    await withKeyLock(key, () => appendJournal(key, op));
    return { journaled: true, value: undefined };
  });
}

// ─── Vorschautexte (Chatliste) ──────────────────────────────────────────────
export function isSealedPreview(v) { return typeof v === 'string' && v.startsWith(ENC_PREFIX); }

// Versiegelt einen Vorschautext (auch gesperrt). Ohne Tresor unveraendert.
export async function sealPreview(text) {
  if (typeof text !== 'string' || !text || isSealedPreview(text)) return text;
  await ready().catch(() => {});
  if (!rec) return text;
  return sealString(text, 'preview');
}

// Versiegelt alle Klartext-Vorschauen ('last') einer Kontakt-/Gruppenliste.
export async function sealPreviewsIn(list) {
  if (!Array.isArray(list)) return list;
  await ready().catch(() => {});
  if (!rec) return list;
  const out = [];
  for (const x of list) {
    if (x && typeof x === 'object' && typeof x.last === 'string' && x.last && !isSealedPreview(x.last)) {
      out.push({ ...x, last: await sealString(x.last, 'preview') });
    } else {
      out.push(x);
    }
  }
  return out;
}

// Anzeige: versiegelte Vorschau oeffnen (gesperrt: leer).
export function previewText(v) {
  if (!isSealedPreview(v)) return v;
  if (!session) return '';
  if (previewCache.has(v)) return previewCache.get(v);
  let out = '';
  try { out = openSealed(v, 'preview') || ''; } catch { out = ''; }
  if (previewCache.size > 500) previewCache.clear();
  previewCache.set(v, out);
  return out;
}

// ─── Empfangs-Ablage (RTCStore) ─────────────────────────────────────────────
// Schluessel einer abgelegten Nachricht versiegeln/oeffnen.
export async function sealSecret(text, ctx) {
  await ready().catch(() => {});
  if (!rec) return null;
  return sealString(text, 'secret|' + ctx);
}
export function openSecret(sealed, ctx) {
  if (!session) throw new VaultLockedError();
  return openSealed(sealed, 'secret|' + ctx);
}

// ─── Altbestand verschluesseln ─────────────────────────────────────────────
/**
 * Verschluesselt vorhandene Klartext-Werte der genannten Schluessel (nach dem
 * ersten Entsperren mit Tresor). Jeder Wert wird nach dem Schreiben gelesen
 * und verglichen - weicht er ab, wird der Klartext wiederhergestellt.
 * -> { migrated, failed }
 */
export async function migrateKeys(keys) {
  let migrated = 0;
  let failed = 0;
  if (!session || !rec) return { migrated, failed };
  for (const key of keys) {
    if (!isVaultKey(key)) continue;
    await withKeyLock(key, async () => {
      const raw = await EncryptedStorage.getItem(key).catch(() => null);
      if (raw == null || raw.startsWith(ENC_PREFIX)) return;
      try {
        await EncryptedStorage.setItem(key, await encSym(key, raw));
        const back = decodeValue(key, await EncryptedStorage.getItem(key));
        if (back !== raw) throw new Error('Abweichung');
        migrated++;
      } catch {
        failed++;
        await EncryptedStorage.setItem(key, raw).catch(() => {});
      }
    });
  }
  return { migrated, failed };
}

export function _resetPinVaultForTests() {
  lock();
  rec = undefined;
  loading = null;
  keyChains.clear();
}
