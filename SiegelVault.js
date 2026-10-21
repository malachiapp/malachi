/**
 * Malachi – SiegelVault.js
 *
 * Tresor des Siegel-Modus (SIEGEL_DESIGN.md) - bewusst UNABHAENGIG vom Rest
 * der App: wer in die App kommt (App-PIN bekannt, entsperrtes Geraet, Kopie
 * der App-Daten), kann Siegel-Nachrichten trotzdem nicht entschluesseln.
 *
 *  - Eigene Passphrase (nicht die App-PIN). Tresorschluessel =
 *    HMAC_Chip(Argon2id(Passphrase, Salz)) - nativ, MalachiSiegelKeyModule.
 *    Ohne den Schluessel im Sicherheitschip DIESES Geraets ist kein
 *    Rateversuch moeglich; am Geraet bremsen Argon2id, der Chip und die
 *    Fehlversuchssperre hier. Nach MAX_FAILS Fehlversuchen wird geloescht.
 *  - Inhalt (Siegel-Kontakte mit Ratchet-Zustand) XChaCha20-Poly1305-
 *    verschluesselt, zusaetzlich im verschluesselten Speicher der App.
 *  - Zero Trace: es werden NUR Schluessel gespeichert, nie Klartext.
 *    Entschluesselter Text geht an den Aufrufer und nirgends sonst hin.
 *  - Offen nur kurz: sperrt sich, sobald die App in den Hintergrund geht, und
 *    nach IDLE_LOCK_MS ohne Bedienung. Der Schluessel liegt nur im RAM.
 */
import { AppState, NativeModules } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { Buffer } from 'buffer';
import { secureRandomBytes } from './MessageCrypto';
import { withAutoLockSuspended } from './AppFocus';
import { createInvite, acceptInvite, completeInvite, sealText, openText, sealMedia, openMedia, SiegelError } from './SiegelCrypto';
import { t } from './i18n';

const VAULT_KEY = 'siegel_vault_v1';
const FAILS_KEY = 'siegel_vault_fails';
const NEXT_TRY_KEY = 'siegel_vault_next_try';
export const MAX_FAILS = 10;
export const MIN_PASSPHRASE_LEN = 8;
export const IDLE_LOCK_MS = 60 * 1000;
// Systemdialoge (Galerie, Dateiauswahl, Mikrofon-Berechtigung) schicken die
// App kurz in den Hintergrund. Waehrend eines solchen Dialogs sperrt der
// Tresor nicht sofort, sondern spaetestens nach HOLD_MAX_MS.
export const HOLD_MAX_MS = 3 * 60 * 1000;
export const MAX_CONTACTS = 200;
// Offene Einladungen (Geheimteil) liegen IM Tresor - eine per Chat
// verschickte Einladung wird oft erst Stunden spaeter beantwortet.
export const PENDING_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_INVITES = 5;
// Wartezeit nach n Fehlversuchen (Index n-1); ab MAX_FAILS wird geloescht.
const FAIL_DELAYS_MS = [0, 0, 0, 30e3, 60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 60 * 60e3];
const KDF = { alg: 'argon2id+chip-hmac', memKiB: 32 * 1024, iterations: 3 };
const AD = Uint8Array.from(Buffer.from('malachi-siegel-vault-v1', 'utf8'));

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => Uint8Array.from(Buffer.from(String(s), 'base64'));
const rng = (n) => secureRandomBytes(n);
const native = () => NativeModules.MalachiSiegelKey;
const kyber = () => NativeModules.KyberModule;

let session = null;       // { key: Uint8Array, header, data: { v, contacts } }
let idleTimer = null;
let chain = Promise.resolve();
let holds = 0;
const listeners = new Set();

// Alle Aenderungen nacheinander - zwei gleichzeitige Speichervorgaenge
// duerften sonst einen Ratchet-Zustand ueberschreiben.
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
function notify() { for (const l of listeners) { try { l(isUnlocked()); } catch {} } }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function isUnlocked() { return !!session; }

// Bedienung haelt den Tresor offen; sonst sperrt er sich nach IDLE_LOCK_MS.
export function touch() {
  if (!session) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lock(), holds > 0 ? HOLD_MAX_MS : IDLE_LOCK_MS);
  idleTimer?.unref?.();
}

// Fuehrt fn (z.B. Bild-/Dateiauswahl) aus, ohne dass der Wechsel in den
// Systemdialog den Tresor sofort sperrt - laenger als HOLD_MAX_MS bleibt er
// dabei nie offen. Danach gilt wieder die normale Sperre nach IDLE_LOCK_MS.
export async function holdOpen(fn) {
  holds++;
  touch();
  try {
    // Auch die App-PIN-Sperre wartet laenger (AppFocus), sonst endete eine
    // lange Bildsuche aus Siegel heraus auf dem PIN-Bildschirm.
    return await withAutoLockSuspended(fn);
  } finally {
    holds = Math.max(0, holds - 1);
    touch();
  }
}

function onAppStateChange(s) {
  if (s !== 'active' && holds === 0) lock();
}

export function lock() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // Auch ein noch "offener" Systemdialog (holdOpen) haelt nach dem Sperren
  // nichts mehr offen - sonst bliebe die Hintergrund-Sperre fuer spaetere
  // Sitzungen ausgehebelt, falls dessen Promise nie zurueckkommt.
  holds = 0;
  if (!session) return;
  try { session.key.fill(0); } catch {}
  session = null;
  notify();
}

try {
  AppState?.addEventListener?.('change', (s) => { if (s !== 'active') onAppStateChange(s); });
} catch {}

// 'present' | 'absent' | 'unknown' (Speicher nicht lesbar). Audit C6: ein
// Lesefehler darf nie als "kein Tresor" gelten - sonst bot die App die
// Einrichtung an, und createKey() ersetzte den Schluessel des bestehenden
// Tresors im Sicherheitschip (Tresor unwiederbringlich verloren).
export async function vaultState() {
  try { return (await EncryptedStorage.getItem(VAULT_KEY)) ? 'present' : 'absent'; } catch { return 'unknown'; }
}

export async function exists() {
  return (await vaultState()) === 'present';
}

export function passphraseProblem(p) {
  const s = String(p || '');
  if (s.length < MIN_PASSPHRASE_LEN) return t('siegel.pass.min', { n: MIN_PASSPHRASE_LEN });
  if (/^(.)\1+$/.test(s)) return t('siegel.pass.repeat');
  return null;
}

async function persist() {
  const nonce = await rng(24);
  const plain = Uint8Array.from(Buffer.from(JSON.stringify(session.data), 'utf8'));
  const box = xchacha20poly1305(session.key, nonce, AD).encrypt(plain);
  plain.fill(0);
  await EncryptedStorage.setItem(VAULT_KEY, JSON.stringify({ ...session.header, nonce: b64(nonce), box: b64(box) }));
}

export function setup(passphrase) {
  return serial(async () => {
    const problem = passphraseProblem(passphrase);
    if (problem) throw new SiegelError('passphrase', problem);
    const state = await vaultState();
    if (state === 'present') throw new SiegelError('exists', 'Siegel-Tresor ist bereits eingerichtet');
    if (state !== 'absent') throw new SiegelError('storage', 'Speicher nicht lesbar');
    const n = native();
    if (!n?.createKey || !n?.deriveVaultKey) throw new SiegelError('unavailable', 'Sicherheitschip nicht verfuegbar');
    const security = await n.createKey();
    const salt = await rng(16);
    const key = unb64(await n.deriveVaultKey(String(passphrase), b64(salt), KDF.memKiB, KDF.iterations));
    if (key.length !== 32) throw new SiegelError('unavailable', 'Tresorschluessel ungueltig');
    session = { key, header: { v: 1, salt: b64(salt), kdf: KDF, security }, data: { v: 1, contacts: [] } };
    await persist();
    await EncryptedStorage.removeItem(FAILS_KEY).catch(() => {});
    await EncryptedStorage.removeItem(NEXT_TRY_KEY).catch(() => {});
    touch();
    notify();
    return { security };
  });
}

// Liefert { ok:true } oder { ok:false, reason, remaining?, waitMs? }
//   reason: 'none' (kein Tresor) | 'wait' (Sperrzeit) | 'wrong' | 'wiped' | 'nokey'
//           | 'storage' (Speicher nicht lesbar - Tresor evtl. vorhanden, Audit C6)
export function unlock(passphrase) {
  return serial(async () => {
    const now = Date.now();
    const nextTry = Number(await EncryptedStorage.getItem(NEXT_TRY_KEY).catch(() => 0)) || 0;
    if (now < nextTry) return { ok: false, reason: 'wait', waitMs: nextTry - now };
    let raw;
    try { raw = await EncryptedStorage.getItem(VAULT_KEY); } catch { return { ok: false, reason: 'storage' }; }
    if (!raw) return { ok: false, reason: 'none' };
    const hdr = JSON.parse(raw);
    const n = native();
    if (!n?.hasKey || !(await n.hasKey())) return { ok: false, reason: 'nokey' };
    let key;
    try {
      key = unb64(await n.deriveVaultKey(String(passphrase || ''), hdr.salt, hdr.kdf.memKiB, hdr.kdf.iterations));
    } catch (e) {
      if (e?.code === 'SIEGEL_NO_KEY') return { ok: false, reason: 'nokey' };
      throw e;
    }
    let data = null;
    try {
      const plain = xchacha20poly1305(key, unb64(hdr.nonce), AD).decrypt(unb64(hdr.box));
      data = JSON.parse(Buffer.from(plain).toString('utf8'));
      plain.fill(0);
    } catch {
      key.fill(0);
      const fails = (Number(await EncryptedStorage.getItem(FAILS_KEY).catch(() => 0)) || 0) + 1;
      if (fails >= MAX_FAILS) {
        await wipeNow();
        return { ok: false, reason: 'wiped' };
      }
      await EncryptedStorage.setItem(FAILS_KEY, String(fails));
      const waitMs = FAIL_DELAYS_MS[fails - 1] || 0;
      if (waitMs) await EncryptedStorage.setItem(NEXT_TRY_KEY, String(Date.now() + waitMs));
      return { ok: false, reason: 'wrong', remaining: MAX_FAILS - fails, waitMs };
    }
    session = { key, header: { v: hdr.v, salt: hdr.salt, kdf: hdr.kdf, security: hdr.security }, data };
    await EncryptedStorage.removeItem(FAILS_KEY).catch(() => {});
    await EncryptedStorage.removeItem(NEXT_TRY_KEY).catch(() => {});
    touch();
    notify();
    return { ok: true };
  });
}

async function wipeNow() {
  lock();
  await EncryptedStorage.removeItem(VAULT_KEY).catch(() => {});
  await EncryptedStorage.removeItem(FAILS_KEY).catch(() => {});
  await EncryptedStorage.removeItem(NEXT_TRY_KEY).catch(() => {});
  try { await native()?.destroyKey?.(); } catch {}
  notify();
}
// Loescht den Tresor endgueltig (Nutzerwunsch, Duress-PIN, Geraet zuruecksetzen).
export function wipe() { return serial(wipeNow); }

function requireOpen() {
  if (!session) throw new SiegelError('locked', 'Siegel-Tresor ist gesperrt');
  touch();
  return session;
}

// Kontaktliste ohne Schluesselmaterial.
export function listContacts() {
  const s = requireOpen();
  return s.data.contacts.map((c) => ({ id: c.id, name: c.name, safety: c.safety, createdAt: c.createdAt }));
}

async function newId() {
  return Buffer.from(await rng(8)).toString('hex');
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  return n || 'Siegel-Kontakt';
}

// chatId: optionale Verknuepfung mit einem Malachi-Chat - steht NUR im
// Tresor (wer in die App kommt, sieht nicht, welcher Chat Siegel nutzt).
async function storeContact(name, contact, chatId = null) {
  const s = requireOpen();
  if (s.data.contacts.length >= MAX_CONTACTS) throw new SiegelError('limit', 'Zu viele Siegel-Kontakte');
  const entry = { id: await newId(), name: cleanName(name), safety: contact.safety, createdAt: contact.createdAt, ratchet: contact.ratchet };
  if (chatId) entry.chatId = String(chatId);
  s.data.contacts.push(entry);
  await persist();
  return { id: entry.id, name: entry.name, safety: entry.safety };
}

function prunePending(s) {
  const now = Date.now();
  s.data.pending = (s.data.pending || []).filter((p) => p && now - p.createdAt < PENDING_INVITE_TTL_MS);
  return s.data.pending;
}

// Kopplung, Seite A: Einladungs-QR erzeugen (Geheimteil nur im RAM).
export function startInvite() {
  return serial(async () => {
    const s = requireOpen();
    const { qr, secret } = await createInvite({ rng, kyber: kyber() });
    const pending = prunePending(s);
    pending.push({ secret, createdAt: Date.now() });
    if (pending.length > MAX_PENDING_INVITES) pending.splice(0, pending.length - MAX_PENDING_INVITES);
    await persist();
    return qr;
  });
}

// Kopplung, Seite B: Einladung gescannt -> Antwort-QR + Kontakt gespeichert.
export function acceptInviteAndStore(inviteText, name, { chatId = null } = {}) {
  return serial(async () => {
    requireOpen();
    const { qr, contact } = await acceptInvite(inviteText, { rng, kyber: kyber() });
    const stored = await storeContact(name, contact, chatId);
    return { qr, contact: stored };
  });
}

// Kopplung, Seite A: Antwort gescannt -> Kontakt gespeichert.
// Antwort auf eine der offenen Einladungen (neueste zuerst).
export function finishInvite(ackText, name, { chatId = null } = {}) {
  return serial(async () => {
    const s = requireOpen();
    const pending = prunePending(s);
    if (!pending.length) throw new SiegelError('no-invite', 'Keine offene Einladung - bitte neu beginnen');
    let lastErr = null;
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        const { contact } = await completeInvite(pending[i].secret, ackText, { rng, kyber: kyber() });
        pending.splice(i, 1);
        return await storeContact(name, contact, chatId);
      } catch (e) {
        lastErr = e;
        if (e?.code === 'format') throw e;
      }
    }
    throw lastErr || new SiegelError('confirm', 'Antwort passt zu keiner offenen Einladung');
  });
}

// Bleibt als Schnittstelle bestehen; offene Einladungen verfallen nach 24 h.
export function cancelInvite() {}

// Siegel-Kontakt, der mit einem Malachi-Chat verknuepft ist (oder null).
export function contactForChat(chatId) {
  const s = requireOpen();
  const c = s.data.contacts.find((x) => chatId && x.chatId === String(chatId));
  return c ? { id: c.id, name: c.name, safety: c.safety } : null;
}

export function linkChat(id, chatId) {
  return serial(async () => {
    const s = requireOpen();
    for (const x of s.data.contacts) if (x.chatId === String(chatId)) delete x.chatId;
    const c = s.data.contacts.find((x) => x.id === id);
    if (!c) throw new SiegelError('unknown', 'Unbekannter Siegel-Kontakt');
    c.chatId = String(chatId);
    await persist();
  });
}

export function renameContact(id, name) {
  return serial(async () => {
    const s = requireOpen();
    const c = s.data.contacts.find((x) => x.id === id);
    if (!c) throw new SiegelError('unknown', 'Unbekannter Siegel-Kontakt');
    c.name = cleanName(name);
    await persist();
  });
}

export function deleteContact(id) {
  return serial(async () => {
    const s = requireOpen();
    s.data.contacts = s.data.contacts.filter((x) => x.id !== id);
    await persist();
  });
}

// Verschluesseln: neuer Ratchet-Zustand wird gespeichert, BEVOR die Nachricht
// zurueckkommt - sonst koennte nach einem Absturz derselbe Zaehler zweimal
// verwendet werden.
export function seal(id, text) {
  return serial(async () => {
    const s = requireOpen();
    const c = s.data.contacts.find((x) => x.id === id);
    if (!c) throw new SiegelError('unknown', 'Unbekannter Siegel-Kontakt');
    const { message, ratchet } = await sealText(c.ratchet, text, { rng });
    const prev = c.ratchet;
    c.ratchet = ratchet;
    try { await persist(); } catch (e) { c.ratchet = prev; throw e; }
    return message;
  });
}

// Entschluesseln fuer einen bestimmten Kontakt. Der Klartext wird NUR
// zurueckgegeben - nie gespeichert.
export function open(id, messageText) {
  return serial(async () => {
    const s = requireOpen();
    const c = s.data.contacts.find((x) => x.id === id);
    if (!c) throw new SiegelError('unknown', 'Unbekannter Siegel-Kontakt');
    const { text, ratchet } = await openText(c.ratchet, messageText, { rng });
    const prev = c.ratchet;
    c.ratchet = ratchet;
    try { await persist(); } catch (e) { c.ratchet = prev; throw e; }
    return text;
  });
}

// Entschluesseln ohne Kontaktwahl: probiert alle Kontakte (je auf einer Kopie).
export function openAny(messageText) {
  return serial(async () => {
    const s = requireOpen();
    let used = false;
    for (const c of s.data.contacts) {
      try {
        const { text, ratchet } = await openText(c.ratchet, messageText, { rng });
        const prev = c.ratchet;
        c.ratchet = ratchet;
        try { await persist(); } catch (e) { c.ratchet = prev; throw e; }
        return { id: c.id, name: c.name, text };
      } catch (e) {
        if (e?.code === 'format') throw e;
        if (e?.code === 'used') used = true;
      }
    }
    if (used) throw new SiegelError('used', 'Diese Nachricht wurde bereits entschluesselt');
    throw new SiegelError('auth', 'Nachricht passt zu keinem Siegel-Kontakt oder wurde veraendert');
  });
}

// Anhang verschluesseln (Bild, Sprachnachricht, Datei): wie seal() - der
// neue Ratchet-Zustand ist gespeichert, BEVOR die Datei zurueckkommt.
// media: { kind: 'image'|'audio'|'file', mime, name, bytes }
export function sealMediaFor(id, media) {
  return serial(async () => {
    const s = requireOpen();
    const c = s.data.contacts.find((x) => x.id === id);
    if (!c) throw new SiegelError('unknown', 'Unbekannter Siegel-Kontakt');
    const { file, ratchet } = await sealMedia(c.ratchet, media, { rng });
    const prev = c.ratchet;
    c.ratchet = ratchet;
    try { await persist(); } catch (e) { c.ratchet = prev; throw e; }
    return file;
  });
}

// Anhang oeffnen ohne Kontaktwahl (wie openAny): probiert alle Kontakte, je
// auf einer Kopie. Der Inhalt geht NUR an den Aufrufer - nie in den Speicher.
// -> { id, name, media: { kind, mime, name, bytes } }
export function openMediaAny(fileBytes) {
  return serial(async () => {
    const s = requireOpen();
    let used = false;
    for (const c of s.data.contacts) {
      let r;
      try {
        r = await openMedia(c.ratchet, fileBytes, { rng });
      } catch (e) {
        if (e?.code === 'format' || e?.code === 'too-long') throw e;
        if (e?.code === 'used') used = true;
        continue;
      }
      const prev = c.ratchet;
      c.ratchet = r.ratchet;
      try { await persist(); } catch (e) { c.ratchet = prev; throw e; }
      return { id: c.id, name: c.name, media: { kind: r.kind, mime: r.mime, name: r.name, bytes: r.bytes } };
    }
    if (used) throw new SiegelError('used', 'Dieser Anhang wurde bereits geoeffnet');
    throw new SiegelError('auth', 'Anhang passt zu keinem Siegel-Kontakt oder wurde veraendert');
  });
}

export function _resetSiegelVaultForTests() {
  lock();
  holds = 0;
  chain = Promise.resolve();
  listeners.clear();
}
