// GroupIntroPairing.js - Kopplung zweier Gruppenmitglieder, nachdem der Admin
// sie einander vorgestellt hat und BEIDE zugestimmt haben (GroupMessaging:
// group_intro). Technisch dieselbe Kopplung wie per QR-Code
// (TorTransport.registerPairingInvite / pairViaTor, danach Kyber-Schluessel-
// tausch im Kanal): Einmal-Token + Einmal-Geheimnis + Onion-Adresse des
// Einladenden - nur reist die Einladung nicht im QR-Code, sondern verschluesselt
// ueber die 1:1-Kanaele mit dem Admin.
//
// Weil der andere nicht gleichzeitig online sein muss, gilt eine solche
// Einladung bis zu drei Tage (statt 30 Minuten), einmalig. Bis dahin liegt sie
// nur verschluesselt (EncryptedStorage) und wird nach einem Neustart wieder
// angemeldet; der Beitretende versucht es regelmaessig, solange die App laeuft.
// Ergebnis ist ein normaler Kontakt mit dem Vermerk "vorgestellt von ..." -
// der Sicherheitscode-Vergleich wird empfohlen (der Admin haette die Einladung
// lesen koennen).
import { Buffer } from 'buffer';
import { NativeModules } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import RTCStore from './RTCStore';
import {
  registerPairingInvite, pairViaTor, ensureTorRunning, getTorState, getOwnOnion, onTorState, onDescriptorReceived,
  PAIRING_INVITE_MAX_TTL_MS,
} from './TorTransport';
import { deriveContactId } from './PairingIds';
import { onIntroPaired, onIntroFailed } from './GroupMessaging';
import { cleanDisplayName } from './TextSafety';
import { t } from './i18n';

const INVITES_KEY = 'group_intro_invites';   // eigene Einladungen (ich lade ein)
const JOINS_KEY = 'group_intro_joins';       // erhaltene Einladungen (ich trete bei)
export const INTRO_INVITE_TTL_MS = PAIRING_INVITE_MAX_TTL_MS;
const MAX_OPEN = 8;                          // je Richtung
const RETRY_MS = 60 * 1000;
const TOR_WAIT_MS = 60 * 1000;
const KEY_EXCHANGE_WAIT_MS = 45 * 1000;

let deps = {
  updateContacts: null,    // (mutator) => Promise
  uiContacts: null,        // (updater) => void
};
export function configureGroupIntroPairing(d) {
  deps = { ...deps, ...(d || {}) };
}

// ─── Speicher ───────────────────────────────────────────────────────────────
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}
async function readMap(key) {
  const raw = await EncryptedStorage.getItem(key).catch(() => null);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
async function writeMap(key, map) {
  if (Object.keys(map).length) await EncryptedStorage.setItem(key, JSON.stringify(map));
  else await EncryptedStorage.removeItem(key).catch(() => {});
}
function pruneExpired(map, now = Date.now()) {
  const expired = [];
  for (const [token, rec] of Object.entries(map)) {
    if (!rec || !Number.isFinite(rec.expires) || rec.expires <= now) { expired.push(rec); delete map[token]; }
  }
  return expired;
}

const unregister = new Map();   // token -> Abmelden der Einladung (TorTransport)
const joining = new Set();      // tokens mit laufendem Versuch
const retryTimers = new Map();  // token -> Timer
const finished = new Set();     // abgeschlossene tokens (gegen Doppelanlage)

async function randomHex(bytes) {
  return Buffer.from(await NativeModules.KyberModule.randomBytes(bytes), 'base64').toString('hex');
}

async function torReady(maxWaitMs = TOR_WAIT_MS) {
  if (getTorState().status === 'ON' && getOwnOnion()) return true;
  ensureTorRunning();
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); resolve(false); }, maxWaitMs);
    off = onTorState((s) => {
      if (s?.status === 'ON' && getOwnOnion()) { clearTimeout(timer); off(); resolve(true); }
    });
  });
}

// ─── Kontakt anlegen (beide Seiten) ─────────────────────────────────────────
async function finish(token, rec, rtc, role, storeKey) {
  if (finished.has(token)) { try { rtc?.close?.(); } catch {} return; }
  finished.add(token);
  clearTimeout(retryTimers.get(token));
  retryTimers.delete(token);
  try { unregister.get(token)?.(); } catch {}
  unregister.delete(token);
  await withLock(async () => {
    const map = await readMap(storeKey);
    delete map[token];
    await writeMap(storeKey, map);
  });
  const name = cleanDisplayName(rec.peerName, 64) || t('connect.newContact');
  const admin = cleanDisplayName(rec.adminName, 64) || t('groups.unknown');
  const contact = {
    id: rec.contactId, name, initials: Array.from(name)[0]?.toUpperCase() || '?', color: '#0A2340', tc: '#0A7EA4',
    last: t('groups.intro.contactLast', { admin }), time: t('connect.now'), unread: 0, role,
    ...(role === 'responder' ? { torOnion: rec.onion } : {}),
    // Vorgestellt - der Chat empfiehlt den Sicherheitscode-Vergleich.
    introducedBy: { groupId: rec.groupId, admin, at: Date.now() },
  };
  try {
    await deps.updateContacts?.(cs => (cs.some(x => x.id === contact.id) ? null : [...cs, contact]));
    deps.uiContacts?.(cs => (cs.some(x => x.id === contact.id) ? cs : [...cs, contact]));
  } catch (e) {
    console.warn('[Vorstellen] Kontakt nicht gespeichert:', e?.message || e);
  }
  if (rtc) RTCStore.setConnection(contact.id, rtc);
  console.log('[Vorstellen] ✅ Gekoppelt (' + role + ')');
  try { await onIntroPaired(rec.groupId, rec.peerMid); } catch {}
  if (typeof global !== 'undefined' && typeof global.showMalachiNotification === 'function') {
    try { global.showMalachiNotification(contact.id); } catch {}
  }
}

// ─── Einladender ────────────────────────────────────────────────────────────
function registerInvite(token, rec) {
  try { unregister.get(token)?.(); } catch {}
  const off = registerPairingInvite(token, {
    pskB64: rec.pskB64, contactId: rec.contactId, expiresAt: rec.expires,
    onPaired: (rtc) => { finish(token, rec, rtc, 'initiator', INVITES_KEY).catch(() => {}); },
  });
  unregister.set(token, off);
}

/**
 * Einladung fuer ein Mitglied erzeugen (GroupMessaging: match als Einladender).
 * Ergebnis { token, psk (hex), onion } oder null (Tor nicht bereit, zu viele offen).
 */
export async function createIntroInvite({ groupId, groupName, peerMid, peerName, adminName }) {
  if (!await torReady()) return null;
  const own = getOwnOnion();
  const onion = own ? (own.endsWith('.onion') ? own : own + '.onion') : null;
  if (!onion) return null;
  const token = (await randomHex(4)).toUpperCase();
  const pskHex = await randomHex(16);
  const pskB64 = Buffer.from(pskHex, 'hex').toString('base64');
  const contactId = await deriveContactId(token, pskHex);
  const rec = {
    pskB64, contactId, groupId, groupName: cleanDisplayName(groupName, 80), peerMid,
    peerName: cleanDisplayName(peerName, 64), adminName: cleanDisplayName(adminName, 64),
    expires: Date.now() + INTRO_INVITE_TTL_MS,
  };
  const ok = await withLock(async () => {
    const map = await readMap(INVITES_KEY);
    for (const r of pruneExpired(map)) if (r) await onIntroFailed(r.groupId, r.peerMid).catch(() => {});
    // Hoechstens eine offene Einladung je Mitglied und Gruppe - die alte ersetzen.
    for (const [tk, r] of Object.entries(map)) {
      if (r?.groupId === groupId && r?.peerMid === peerMid) {
        delete map[tk];
        try { unregister.get(tk)?.(); } catch {}
        unregister.delete(tk);
      }
    }
    if (Object.keys(map).length >= MAX_OPEN) return false;
    map[token] = rec;
    await writeMap(INVITES_KEY, map);
    return true;
  });
  if (!ok) return null;
  registerInvite(token, rec);
  return { token, psk: pskHex, onion };
}

// ─── Beitretender ───────────────────────────────────────────────────────────
function scheduleRetry(token, ms = RETRY_MS) {
  clearTimeout(retryTimers.get(token));
  const timer = setTimeout(() => { retryTimers.delete(token); attemptJoin(token).catch(() => {}); }, ms);
  timer?.unref?.();
  retryTimers.set(token, timer);
}

async function attemptJoin(token) {
  if (joining.has(token) || finished.has(token)) return;
  const map = await readMap(JOINS_KEY);
  const rec = map[token];
  if (!rec) return;
  if (!Number.isFinite(rec.expires) || rec.expires <= Date.now()) {
    await withLock(async () => { const m = await readMap(JOINS_KEY); delete m[token]; await writeMap(JOINS_KEY, m); });
    await onIntroFailed(rec.groupId, rec.peerMid).catch(() => {});
    return;
  }
  if (getTorState().status !== 'ON') { scheduleRetry(token); return; }
  joining.add(token);
  try {
    const pskB64 = Buffer.from(rec.psk, 'hex').toString('base64');
    let done = false;
    const session = await pairViaTor({
      onion: rec.onion, token, pskB64, contactId: rec.contactId,
      onPaired: (rtc) => { done = true; finish(token, rec, rtc, 'responder', JOINS_KEY).catch(() => {}); },
    });
    if (session) {
      // Angemeldet - der Schluesseltausch laeuft; kurz darauf warten.
      const until = Date.now() + KEY_EXCHANGE_WAIT_MS;
      while (!done && !session._closed && Date.now() < until) await new Promise(r => setTimeout(r, 250));
      if (!done) { try { session.close(); } catch {} }
    }
    if (!done) scheduleRetry(token);
  } catch {
    scheduleRetry(token);
  } finally {
    joining.delete(token);
  }
}

/** Erhaltene Einladung (GroupMessaging: invite) - koppeln, sobald moeglich. */
export async function joinIntroInvite({ groupId, groupName, peerMid, peerName, adminName, invite }) {
  if (!invite?.token || !invite?.psk || !invite?.onion) return false;
  const contactId = await deriveContactId(invite.token, invite.psk);
  const rec = {
    token: invite.token, psk: invite.psk, onion: invite.onion, contactId, groupId,
    groupName: cleanDisplayName(groupName, 80), peerMid, peerName: cleanDisplayName(peerName, 64),
    adminName: cleanDisplayName(adminName, 64), expires: Date.now() + INTRO_INVITE_TTL_MS,
  };
  const ok = await withLock(async () => {
    const map = await readMap(JOINS_KEY);
    pruneExpired(map);
    for (const [tk, r] of Object.entries(map)) if (r?.groupId === groupId && r?.peerMid === peerMid) delete map[tk];
    if (Object.keys(map).length >= MAX_OPEN) return false;
    map[invite.token] = rec;
    await writeMap(JOINS_KEY, map);
    return true;
  });
  if (!ok) return false;
  // Erscheint die Beschreibung des Einladenden im Tor-Netz: sofort versuchen.
  const off = onDescriptorReceived(rec.onion, () => { if (!finished.has(invite.token)) attemptJoin(invite.token).catch(() => {}); });
  setTimeout(() => { try { off?.(); } catch {} }, INTRO_INVITE_TTL_MS)?.unref?.();
  attemptJoin(invite.token).catch(() => {});
  return true;
}

// ─── Start: offene Einladungen wieder anmelden, Beitritte fortsetzen ────────
let resumed = false;
export async function resumeIntroPairings() {
  if (resumed) return;
  resumed = true;
  const invites = await withLock(async () => {
    const map = await readMap(INVITES_KEY);
    const expired = pruneExpired(map);
    await writeMap(INVITES_KEY, map);
    for (const r of expired) if (r) await onIntroFailed(r.groupId, r.peerMid).catch(() => {});
    return map;
  });
  for (const [token, rec] of Object.entries(invites)) registerInvite(token, rec);
  const joins = await readMap(JOINS_KEY);
  const tokens = Object.keys(joins);
  if (!tokens.length) return;
  const start = () => { for (const tk of tokens) attemptJoin(tk).catch(() => {}); };
  if (getTorState().status === 'ON') start();
  else {
    const off = onTorState((s) => { if (s?.status === 'ON') { off(); start(); } });
  }
}

// Wipe: Speicher leert performWipe - hier nur den Arbeitsspeicher.
RTCStore.onWipe((chatId) => {
  if (chatId != null) return;
  for (const off of unregister.values()) { try { off(); } catch {} }
  unregister.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  joining.clear();
  finished.clear();
  resumed = false;
});

export function _resetGroupIntroPairingForTests() {
  for (const off of unregister.values()) { try { off(); } catch {} }
  unregister.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  joining.clear();
  finished.clear();
  resumed = false;
}
