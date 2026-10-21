// GroupMessaging.js - Gruppenchats ueber die bestehenden 1:1-Kanaele
// (GROUP_CHAT_DESIGN.md, Option A aus GROUP_CHAT_CRYPTO_PLAN.md: paarweises
// Fan-out, KEIN Gruppenschluessel, KEIN Server, KEIN Weiterleiten ueber andere
// Mitglieder).
//
// Grundsatz: Eine Gruppe ist nur eine lokale Ueberlagerung der vorhandenen
// paarweisen Verbindungen. Jede Gruppen-Nachricht (Text wie Steuersignal) geht
// einzeln ueber die verschluesselte Sende-Warteschlange (BackgroundSync.
// sendViaOutbox) an JEDES Mitglied, mit dem dieses Geraet direkt gekoppelt ist -
// write-ahead, mit Empfangsbestaetigung, Wiederholung bei jeder neuen
// Verbindung. Offline-Mitglieder bekommen alles beim naechsten Verbindungs-
// aufbau. Mitglieder ohne direkte Kopplung erreicht der Absender NICHT (die UI
// sagt das deutlich).
//
// Mitglieds-Identitaet ueber Geraete hinweg: jedes Geraet erzeugt einmalig eine
// zufaellige Mitglieds-ID ('m_' + 32 Hex, EncryptedStorage 'group_self_id') und
// teilt sie jedem Kontakt bei jedem Schluesseltausch ueber den bereits
// verschluesselten 1:1-Kanal mit (system/group_id, RTCStore._onKeyExchange).
// Der Empfaenger speichert sie am Kontakt (groupMemberId). Gruppen-Metadaten
// referenzieren Mitglieder ausschliesslich ueber diese IDs - nie ueber lokale
// Kontakt-IDs (die gibt es nur auf dem jeweiligen Geraet), nie ueber Onion-
// Adressen oder sonstige Netz-Kennungen, nie mit Schluesselmaterial. Die ID ist
// kein Geheimnis und keine Faehigkeit: wer sie kennt, kann damit niemanden
// erreichen. Jede Gruppen-Nachricht traegt zusaetzlich fromMid (Erstkontakt-
// Vertrauen, falls group_id noch nicht verarbeitet war); weicht sie von der
// gespeicherten ID des Kanals ab, wird sie verworfen. Der ABSENDER einer
// Gruppen-Nachricht ist immer der Kontakt, ueber dessen authentifizierten
// Kanal sie kam - eine Absender-Behauptung im Inhalt zaehlt nie.
//
// Rechte (weich, wie alle Steuersignale der App - es gibt keine Signatur-
// Primitive): nur Admins aendern Mitglieder, Namen und Beschreibung; ein
// Mitglied kann jederzeit austreten; niemand kann die Gruppe fuer alle
// loeschen. In v1 ist der Ersteller der einzige Admin; tritt der letzte Admin
// aus, uebergibt er die Rolle an das naechste Mitglied.
//
// Speicher (alles EncryptedStorage): 'groups' (Liste, ueber BackgroundSync.
// updateGroups serialisiert), 'gchat_<groupId>' (Verlauf), 'groups_left'
// (Grabsteine verlassener/geloeschter Gruppen), 'groups_pending' (noch nicht
// zuordenbare Texte, begrenzt). Bilder/Sprachnachrichten liegen als eigene
// verschluesselte Dateien in MediaVault.js (im Verlauf nur Verweis+Schluessel),
// noch nicht zuordenbare Medien nur im RAM (Audit G1). Keine Inhalte in Logs.
import EncryptedStorage from 'react-native-encrypted-storage';
import RTCStore, { GROUP_ACK_PREFIX, GROUP_SUBTYPES, isGroupMedia } from './RTCStore';
import { secureRandomToken } from './MessageCrypto';
import { putMedia, removeMedia, removeScope as removeMediaScope } from './MediaVault';
import { cleanDisplayName, cleanDisplayText } from './TextSafety';
import { t } from './i18n';

export const GROUP_MAX_MEMBERS = 8;           // inkl. mir selbst (Plan §6)
export const GROUP_FORMAT = 1;
const SELF_ID_KEY = 'group_self_id';
const LEFT_KEY = 'groups_left';
const PENDING_KEY = 'groups_pending';
export const GROUP_CHAT_PREFIX = 'gchat_';
const MID_RE = /^m_[0-9a-f]{32}$/;
const GROUP_ID_RE = /^g_[0-9a-f]{16,64}$/;
const MSG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TEXT_MAX = 4000;
const NAME_MAX = 80;
const MEMBER_NAME_MAX = 64;
const DESC_MAX = 500;
const CHAT_MAX = 3000;                        // gespeicherte Nachrichten pro Gruppe
const PREVIEW_MAX = 200;
const PENDING_MAX_PER_GROUP = 50;
const PENDING_MAX_GROUPS = 10;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LEFT_MAX = 200;
// Audit G7: Obergrenzen gegen Einladungs-Flut (Speicher/Uebersicht).
const GROUPS_MAX = 64;                        // Gruppen auf diesem Geraet
const INVITES_PER_CONTACT_MAX = 16;           // davon von einem Kontakt eingeladen
const LEFT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const CHANGE_KINDS = new Set(['create', 'add', 'remove', 'rename', 'leave']);
// Gruppen-Medien (Bild, Sprachnachricht): Groesse als Base64-Laenge. Jedes
// Mitglied bekommt eine eigene verschluesselte Kopie (paarweises Fan-out).
const MEDIA_KINDS = new Set(['image', 'audio']);
// Bilder kommen verkleinert (max. 1600 px, GroupChatScreen) - 6 MB Base64
// reichen auch fuer PNG-Bildschirmfotos (Audit G1: vorher 14 MB).
const MEDIA_MAX_B64 = { image: 6 * 1024 * 1024, audio: 8 * 1024 * 1024 };
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif|heic|heif)$/;
const AUDIO_MAX_MS = 10 * 60 * 1000;
const PENDING_MEDIA_MAX_PER_GROUP = 3;      // zurueckgestellte Medien sind gross

// Von BackgroundSync.js gesetzt (vermeidet einen Import-Zyklus, gleiches
// Muster wie configureTorTransport/configureDirectUpgrade).
let deps = {
  sendViaOutbox: null,     // (contactId, type, payload, msgId, opts) => Promise<bool>
  updateGroups: null,      // (mutator) => Promise<list|null>
  updateContacts: null,    // (mutator) => Promise<list|null>
  dropFromQueue: null,     // (contactId, predicate) => Promise<number>
  uiContacts: null,        // (updater) => void  (setContacts der App, sonst No-op)
};
export function configureGroupMessaging(d) {
  deps = { ...deps, ...(d || {}) };
}

// Gruppenliste der gemounteten App (setGroups). Headless: No-op.
let uiGroupsListener = null;
export function setUiGroupsListener(fn) {
  uiGroupsListener = typeof fn === 'function' ? fn : null;
}
function notifyUiGroups(list) {
  if (!uiGroupsListener || !Array.isArray(list)) return;
  try { uiGroupsListener(list); } catch {}
}

// ─── Eigene Mitglieds-ID ────────────────────────────────────────────────────
let selfIdPromise = null;
export function getSelfMemberId() {
  if (!selfIdPromise) {
    selfIdPromise = (async () => {
      const saved = await EncryptedStorage.getItem(SELF_ID_KEY).catch(() => null);
      if (typeof saved === 'string' && MID_RE.test(saved)) return saved;
      const id = 'm_' + await secureRandomToken(16);
      await EncryptedStorage.setItem(SELF_ID_KEY, id);
      return id;
    })();
    selfIdPromise.catch(() => { selfIdPromise = null; });
  }
  return selfIdPromise;
}

// ─── Mitglieds-IDs der Kontakte ─────────────────────────────────────────────
// contactId -> Mitglieds-ID, schon bevor sie am Kontakt gespeichert ist (z.B.
// waehrend der Kopplung, wenn der Kontakt noch gar nicht angelegt ist).
const peerIds = new Map();
const persistRetries = new Map();

async function readContacts() {
  const raw = await EncryptedStorage.getItem('contacts').catch(() => null);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(c => c && typeof c === 'object') : []; } catch { return []; }
}

export function memberIdOfContact(c) {
  if (!c) return null;
  const mem = peerIds.get(c.id);
  if (mem) return mem;
  return typeof c.groupMemberId === 'string' && MID_RE.test(c.groupMemberId) ? c.groupMemberId : null;
}

async function midOfContactId(contactId, contacts = null) {
  if (peerIds.has(contactId)) return peerIds.get(contactId);
  const list = contacts || await readContacts();
  return memberIdOfContact(list.find(c => c.id === contactId));
}

function persistPeerId(contactId, mid, attempt = 0) {
  if (typeof deps.updateContacts !== 'function') return;
  deps.updateContacts(cs => {
    const c = cs.find(x => x && x.id === contactId);
    if (!c) return null;
    if (c.groupMemberId === mid) return null;
    return cs.map(x => (x && x.id === contactId ? { ...x, groupMemberId: mid } : x));
  }).then(async () => {
    const saved = (await readContacts()).find(c => c.id === contactId);
    if (saved && saved.groupMemberId === mid) {
      persistRetries.delete(contactId);
      try { deps.uiContacts?.(cs => cs.map(x => (x && x.id === contactId ? { ...x, groupMemberId: mid } : x))); } catch {}
      return;
    }
    // Kontakt noch nicht angelegt (Kopplung laeuft) - kurz spaeter erneut.
    if (attempt >= 8 || peerIds.get(contactId) !== mid) return;
    const t = setTimeout(() => persistPeerId(contactId, mid, attempt + 1), 2500);
    t?.unref?.();
    persistRetries.set(contactId, t);
  }).catch(() => {});
}

// group_id ueber den 1:1-Kanal empfangen (RTCStore.groupIdHandler) bzw.
// fromMid einer Gruppen-Nachricht (Erstkontakt). Erste ID pro Kontakt gilt;
// eine ID darf nur EINEM Kontakt (und nie mir selbst) gehoeren.
export async function rememberPeerMemberId(contactId, mid) {
  if (!contactId || typeof mid !== 'string' || !MID_RE.test(mid)) return false;
  const selfMid = await getSelfMemberId().catch(() => null);
  if (mid === selfMid) {
    console.warn('[Gruppen] Kontakt meldet die eigene Mitglieds-ID - ignoriert');
    return false;
  }
  const contacts = await readContacts();
  const known = await midOfContactId(contactId, contacts);
  if (known && known !== mid) {
    console.warn('[Gruppen] Kontakt meldet abweichende Mitglieds-ID - ignoriert');
    return false;
  }
  const clash = contacts.some(c => c.id !== contactId && memberIdOfContact(c) === mid)
    || [...peerIds.entries()].some(([cid, m]) => cid !== contactId && m === mid);
  if (clash) {
    console.warn('[Gruppen] Mitglieds-ID gehoert bereits einem anderen Kontakt - ignoriert');
    return false;
  }
  const isNew = peerIds.get(contactId) !== mid;
  peerIds.set(contactId, mid);
  const c = contacts.find(x => x.id === contactId);
  if (!c || c.groupMemberId !== mid) persistPeerId(contactId, mid);
  if (isNew && !known) console.log('[Gruppen] Mitglieds-ID eines Kontakts gespeichert');
  return true;
}

// ─── Gruppenliste ───────────────────────────────────────────────────────────
async function readGroups() {
  const raw = await EncryptedStorage.getItem('groups').catch(() => null);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(g => g && typeof g === 'object') : []; } catch { return []; }
}
// Einladung in eine (fuer dieses Geraet) neue Gruppe angenommen - die App
// oeffnet den Gruppenchat, wenn die Einladung kurz nach einer frischen
// Kopplung mit dem Einladenden kommt ("koppeln und gleich in die Gruppe").
let inviteListener = null;
export function setGroupInviteListener(fn) {
  inviteListener = typeof fn === 'function' ? fn : null;
}

// Gruppe oben anheften (nur lokal, wie bei Chats).
export async function setGroupPinned(groupId, pinned) {
  const updated = await mutateGroups((groups) => {
    const g = findGroup(groups, groupId);
    if (!g || !!g.pinned === !!pinned) return null;
    return groups.map(x => (x === g ? { ...g, pinned: !!pinned } : x));
  });
  return !!updated;
}

async function mutateGroups(mutator) {
  const updated = await deps.updateGroups(mutator);
  if (updated) notifyUiGroups(updated);
  return updated;
}
function findGroup(groups, groupId) {
  return groups.find(g => g && g.groupId === groupId) || null;
}

// Abgeleitete Felder (lokal): amAdmin und memberContactIds (Kontakt-IDs der
// direkt gekoppelten Mitglieder - nur Anzeige/Kompatibilitaet, gesendet wird
// immer frisch aufgeloest).
function withDerived(g, selfMid, contacts) {
  const members = Array.isArray(g.members) ? g.members : [];
  const memberContactIds = [];
  for (const m of members) {
    if (m.mid === selfMid) continue;
    const c = contacts.find(x => memberIdOfContact(x) === m.mid && !x.pendingDelete);
    if (c) memberContactIds.push(c.id);
  }
  return { ...g, selfMid, amAdmin: (g.admins || []).includes(selfMid), memberContactIds };
}

// Mitglieder fuer UI und Versand: Name (lokaler Kontaktname, sonst der aus den
// Gruppendaten), Kontakt-ID falls direkt gekoppelt, Admin-Kennzeichen.
export function resolveGroupMembers(group, contacts, selfMid = group?.selfMid) {
  const list = Array.isArray(contacts) ? contacts : [];
  return (Array.isArray(group?.members) ? group.members : []).map((m) => {
    const isSelf = !!selfMid && m.mid === selfMid;
    const c = isSelf ? null : list.find(x => x && memberIdOfContact(x) === m.mid && !x.pendingDelete) || null;
    return {
      mid: m.mid,
      name: isSelf ? t('common.you') : (c?.name || m.name || t('groups.unknown')),
      contactId: c?.id || null,
      isSelf,
      isAdmin: (group.admins || []).includes(m.mid),
      wiped: !!c?.wiped,
    };
  });
}
// Mitglieder, die dieses Geraet NICHT direkt erreicht (keine Kopplung).
export function unreachableMembers(group, contacts) {
  return resolveGroupMembers(group, contacts).filter(m => !m.isSelf && (!m.contactId || m.wiped));
}

// Nur fuer Anzeige/Hinweise (aktive Sprache). Namen in den Gruppendaten, die
// an andere gehen (displayNameForState/ownName), bleiben unuebersetzt.
function memberName(group, mid, contacts, selfMid, { self = t('common.you') } = {}) {
  if (mid === selfMid) return self;
  const c = contacts.find(x => memberIdOfContact(x) === mid);
  if (c?.name) return c.name;
  return (group?.members || []).find(m => m.mid === mid)?.name || t('groups.unknown');
}

// ─── Verlauf 'gchat_<groupId>' ──────────────────────────────────────────────
const chatChains = new Map();
function withChatLock(groupId, fn) {
  const prev = chatChains.get(groupId) || Promise.resolve();
  const run = prev.then(fn);
  chatChains.set(groupId, run.catch(() => {}));
  return run;
}
async function readChat(groupId) {
  const raw = await EncryptedStorage.getItem(GROUP_CHAT_PREFIX + groupId).catch(() => null);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(m => m && typeof m === 'object') : []; } catch { return []; }
}
export const groupMediaScope = (groupId) => 'grp_' + groupId;
// Speichert den Verlauf; Medien mit Inhalt werden dabei als verschluesselte
// Datei abgelegt (auch Altbestand), aus dem Verlauf fallende Medien geloescht.
// Liefert den gespeicherten Stand (ohne Base64).
async function writeChat(groupId, list) {
  const scope = groupMediaScope(groupId);
  const out = [];
  for (const m of list) {
    if ((m.type === 'image' || m.type === 'audio') && typeof m.base64 === 'string' && m.base64) {
      try {
        const ref = await putMedia(scope, m.base64);
        const { base64, ...rest } = m;
        out.push({ ...rest, mref: ref.mref, mk: ref.mk });
        continue;
      } catch (e) {
        // Lieber wie bisher eingebettet als verloren.
        console.warn('[Gruppen] Medium nicht ablegbar:', e?.message || e);
      }
    }
    out.push(m);
  }
  const kept = out.slice(-CHAT_MAX);
  await EncryptedStorage.setItem(GROUP_CHAT_PREFIX + groupId, JSON.stringify(kept));
  for (const m of out.slice(0, out.length - kept.length)) {
    if (typeof m.mref === 'string') await removeMedia(scope, m.mref);
  }
  return kept;
}
const chatListeners = new Map();   // groupId -> Set(cb)
export function subscribeGroupChat(groupId, cb) {
  if (!groupId || typeof cb !== 'function') return () => {};
  if (!chatListeners.has(groupId)) chatListeners.set(groupId, new Set());
  chatListeners.get(groupId).add(cb);
  return () => {
    const set = chatListeners.get(groupId);
    if (!set) return;
    set.delete(cb);
    if (!set.size) chatListeners.delete(groupId);
  };
}
export function isGroupChatOpen(groupId) {
  return !!chatListeners.get(groupId)?.size;
}
function emitChat(groupId, list) {
  const set = chatListeners.get(groupId);
  if (!set) return;
  for (const cb of [...set]) { try { cb(list); } catch {} }
}
const msgKey = (m) => (m.from || '') + '|' + m.id;

// Haengt Eintraege an (Dedup nach Absender+ID) - liefert die tatsaechlich neuen.
async function appendToChat(groupId, entries) {
  return withChatLock(groupId, async () => {
    const list = await readChat(groupId);
    const seen = new Set(list.map(msgKey));
    const added = [];
    for (const e of entries) {
      const k = msgKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(e);
      added.push(e);
    }
    if (added.length) {
      emitChat(groupId, await writeChat(groupId, list));
    }
    return added;
  });
}
export function loadGroupChat(groupId) {
  if (!groupId) return Promise.resolve([]);
  return withChatLock(groupId, () => readChat(groupId));
}

// Zustand einer eigenen Nachricht ueber alle erreichbaren Empfaenger:
// 'sending' (wird eingereiht), 'failed' (mind. einer nicht einreihbar),
// 'queued' (✓ bei allen eingereiht), 'delivered' (✓✓ alle bestaetigt),
// 'none' (niemand direkt erreichbar - bleibt nur lokal).
export function computeGroupStatus(recipients) {
  const vals = Object.values(recipients || {});
  if (!vals.length) return 'none';
  if (vals.some(v => v === 'sending')) return 'sending';
  if (vals.every(v => v === 'delivered')) return 'delivered';
  if (vals.some(v => v === 'failed')) return 'failed';
  return 'queued';
}
export function deliveredCount(recipients) {
  const vals = Object.values(recipients || {});
  return { delivered: vals.filter(v => v === 'delivered').length, total: vals.length };
}

async function updateOwnMessage(groupId, msgId, fn) {
  return withChatLock(groupId, async () => {
    const list = await readChat(groupId);
    const i = list.findIndex(m => m.mine && m.id === msgId);
    if (i === -1) return false;
    const m = { ...list[i], recipients: { ...(list[i].recipients || {}) } };
    if (fn(m) === false) return false;
    m.status = computeGroupStatus(m.recipients);
    list[i] = m;
    emitChat(groupId, await writeChat(groupId, list));
    return true;
  });
}

let sysSeq = 0;
function sysNotice(text, time = Date.now()) {
  sysSeq = (sysSeq + 1) % 1e6;
  return { id: 'sys_' + time.toString(36) + '_' + sysSeq, from: 'sys', sys: true, text, time };
}

// ─── Grabsteine / Warteschlange unzuordenbarer Nachrichten ───────────────────
let leftChain = Promise.resolve();
function withLeftLock(fn) {
  const run = leftChain.then(fn);
  leftChain = run.catch(() => {});
  return run;
}
async function readLeft() {
  const raw = await EncryptedStorage.getItem(LEFT_KEY).catch(() => null);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function setLeft(groupId, ts) {
  return withLeftLock(async () => {
    const left = await readLeft();
    left[groupId] = ts;
    const now = Date.now();
    const entries = Object.entries(left)
      .filter(([, t]) => Number.isFinite(t) && now - t < LEFT_MAX_AGE_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LEFT_MAX);
    await EncryptedStorage.setItem(LEFT_KEY, JSON.stringify(Object.fromEntries(entries)));
  });
}
function clearLeft(groupId) {
  return withLeftLock(async () => {
    const left = await readLeft();
    if (!(groupId in left)) return;
    delete left[groupId];
    await EncryptedStorage.setItem(LEFT_KEY, JSON.stringify(left));
  });
}

let pendingChain = Promise.resolve();
function withPendingLock(fn) {
  const run = pendingChain.then(fn);
  pendingChain = run.catch(() => {});
  return run;
}
async function readPending() {
  const raw = await EncryptedStorage.getItem(PENDING_KEY).catch(() => null);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
async function writePending(p) {
  if (Object.keys(p).length) await EncryptedStorage.setItem(PENDING_KEY, JSON.stringify(p));
  else await EncryptedStorage.removeItem(PENDING_KEY);
}
function prunePending(p, now = Date.now()) {
  for (const gid of Object.keys(p)) {
    const items = Array.isArray(p[gid]) ? p[gid].filter(it => it && now - (it.at || 0) < PENDING_MAX_AGE_MS) : [];
    // Audit G1: Medien nie (mehr) im gespeicherten Rueckstand - Altbestand faellt hier heraus.
    const kept = items.filter(it => !isGroupMedia(it.msg)).slice(-PENDING_MAX_PER_GROUP);
    if (kept.length) p[gid] = kept;
    else delete p[gid];
  }
  const gids = Object.keys(p);
  if (gids.length > PENDING_MAX_GROUPS) {
    gids.sort((a, b) => Math.max(...p[b].map(i => i.at || 0)) - Math.max(...p[a].map(i => i.at || 0)));
    for (const gid of gids.slice(PENDING_MAX_GROUPS)) delete p[gid];
  }
  return p;
}
// Nachricht fuer eine (noch) unbekannte Gruppe bzw. von einem (noch) nicht
// eingetragenen Mitglied - z.B. kam die Nachricht eines Mitglieds vor der
// Einladung des Admins an. Begrenzt (Anzahl, Alter), verfaellt sonst.
function addPending(groupId, contactId, msg, at = Date.now()) {
  return withPendingLock(async () => {
    const p = await readPending();
    const items = Array.isArray(p[groupId]) ? p[groupId] : [];
    if (items.some(it => it.contactId === contactId && it.msg?.msgId === msg.msgId)) return;
    items.push({ contactId, msg, at });
    p[groupId] = items;
    await writePending(prunePending(p));
  });
}
// Noch nicht zuordenbare Gruppen-MEDIEN (Audit G1): nur im RAM, wenige je
// Gruppe. Bestaetigt werden sie trotzdem (sonst endlose Wiederholung beim
// Absender); kommt die Einladung erst nach einem Neustart, fehlt das Medium.
// Der Rueckstand fuer Texte bleibt gespeichert (klein).
const pendingMediaRam = new Map();   // groupId -> [{ contactId, msg, at }]
function addPendingMedia(groupId, contactId, msg, at = Date.now()) {
  const now = Date.now();
  for (const [gid, items] of [...pendingMediaRam]) {
    const fresh = items.filter(it => now - it.at < PENDING_MAX_AGE_MS);
    if (fresh.length) pendingMediaRam.set(gid, fresh); else pendingMediaRam.delete(gid);
  }
  const items = pendingMediaRam.get(groupId) || [];
  if (items.some(it => it.contactId === contactId && it.msg?.msgId === msg.msgId)) return;
  items.push({ contactId, msg, at });
  pendingMediaRam.set(groupId, items.slice(-PENDING_MEDIA_MAX_PER_GROUP));
  while (pendingMediaRam.size > PENDING_MAX_GROUPS) pendingMediaRam.delete(pendingMediaRam.keys().next().value);
}
function takePendingMedia(groupId) {
  const items = pendingMediaRam.get(groupId) || [];
  pendingMediaRam.delete(groupId);
  return items;
}
export function _pendingMediaCountForTests(groupId) {
  return (pendingMediaRam.get(groupId) || []).length;
}
function takePending(groupId) {
  return withPendingLock(async () => {
    const p = prunePending(await readPending());
    const items = Array.isArray(p[groupId]) ? p[groupId] : [];
    delete p[groupId];
    await writePending(p);
    return items;
  });
}
function dropPending(groupId) {
  return withPendingLock(async () => {
    const p = await readPending();
    if (!(groupId in p)) return;
    delete p[groupId];
    await writePending(p);
  });
}

// ─── Zustell-Schluessel ─────────────────────────────────────────────────────
export function isGroupAckId(id) {
  return typeof id === 'string' && id.startsWith(GROUP_ACK_PREFIX);
}
function ackFor(kind, groupId, ref) {
  return GROUP_ACK_PREFIX + kind + '|' + groupId + '|' + ref;
}
function parseAck(id) {
  if (!isGroupAckId(id)) return null;
  const parts = id.split('|');
  if (parts.length !== 4) return null;
  return { kind: parts[1], groupId: parts[2], ref: parts[3] };
}

// ─── Eingangsvalidierung ────────────────────────────────────────────────────
function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max) : '';
}
// Audit G9: Namen/Beschreibungen ohne Bidi-/Nullbreiten-Zeichen (TextSafety.js).
// Nachrichtentexte behalten Richtungsmarken (RTL-Sprachen) - nur cleanText.
const safeName = (v, max) => cleanDisplayName(v, max);
const safeDesc = (v, max) => cleanDisplayText(v, max);
function parseState(msg) {
  if (!GROUP_ID_RE.test(msg.groupId || '')) return null;
  const name = safeName(msg.name, NAME_MAX);
  if (!name) return null;
  if (!Array.isArray(msg.members) || msg.members.length < 1 || msg.members.length > GROUP_MAX_MEMBERS) return null;
  const members = [];
  const seen = new Set();
  for (const m of msg.members) {
    if (!m || typeof m !== 'object' || !MID_RE.test(m.mid || '') || seen.has(m.mid)) return null;
    seen.add(m.mid);
    members.push({ mid: m.mid, name: safeName(m.name, MEMBER_NAME_MAX) });
  }
  if (!Array.isArray(msg.admins) || msg.admins.length > GROUP_MAX_MEMBERS) return null;
  const admins = [...new Set(msg.admins.filter(a => typeof a === 'string' && seen.has(a)))];
  const rev = msg.rev;
  if (!Number.isInteger(rev) || rev < 1 || rev > 1e9) return null;
  if (!Number.isFinite(msg.ts)) return null;
  let change = null;
  if (msg.change && typeof msg.change === 'object' && CHANGE_KINDS.has(msg.change.kind)) {
    change = { kind: msg.change.kind, by: MID_RE.test(msg.change.by || '') ? msg.change.by : null };
    // Audit G4: bei 'add' die neu hinzugefuegten Mitglieder - nur sie gelten als eingeladen.
    if (Array.isArray(msg.change.mids)) {
      change.mids = msg.change.mids.filter(m => typeof m === 'string' && MID_RE.test(m)).slice(0, GROUP_MAX_MEMBERS);
    }
  }
  return {
    groupId: msg.groupId, name, description: safeDesc(msg.description, DESC_MAX), members, admins,
    createdBy: MID_RE.test(msg.createdBy || '') ? msg.createdBy : null,
    createdAt: Number.isFinite(msg.createdAt) ? msg.createdAt : msg.ts,
    rev, ts: msg.ts, change,
  };
}

// Absender-ID: die des Kanals. fromMid nur als Erstkontakt-Wert; Widerspruch -> null.
async function senderMidFor(contactId, claimed) {
  const known = await midOfContactId(contactId);
  if (known) {
    if (claimed != null && claimed !== known) {
      console.warn('[Gruppen] Absender-ID passt nicht zum Kanal - verworfen');
      return null;
    }
    return known;
  }
  if (typeof claimed === 'string' && MID_RE.test(claimed) && await rememberPeerMemberId(contactId, claimed)) return claimed;
  return null;
}

// ─── Eingang (RTCStore.groupMessageHandler) ─────────────────────────────────
// Alle eingehenden Gruppen-Nachrichten nacheinander (geringes Aufkommen) -
// verhindert, dass ein Text zwischen "Gruppe gelesen" und "Einladung
// gespeichert" durchrutscht. Das Promise gilt als "dauerhaft abgelegt"
// (RTCStore bestaetigt erst danach).
let incomingChain = Promise.resolve();
export function handleGroupMessage(contactId, msg) {
  const run = incomingChain.then(() => handleGroupMessageInner(contactId, msg));
  incomingChain = run.catch(() => {});
  return run;
}

async function handleGroupMessageInner(contactId, msg) {
  if (contactId && isGroupMedia(msg)) return handleMedia(contactId, msg);
  if (!contactId || !msg || typeof msg !== 'object' || !GROUP_SUBTYPES.has(msg.subtype)) return false;
  if (typeof msg.groupId !== 'string' || !GROUP_ID_RE.test(msg.groupId)) {
    console.warn('[Gruppen] Nachricht mit ungueltiger Gruppen-ID verworfen');
    return false;
  }
  switch (msg.subtype) {
    case 'group_state': return handleState(contactId, msg);
    case 'group_leave': return handleLeave(contactId, msg);
    case 'group_text': return handleText(contactId, msg);
    default: return false;
  }
}

async function handleState(contactId, msg) {
  const st = parseState(msg);
  if (!st) {
    console.warn('[Gruppen] Ungueltiger Gruppenstand verworfen');
    return false;
  }
  const selfMid = await getSelfMemberId();
  const senderMid = await senderMidFor(contactId, msg.fromMid);
  if (!senderMid) return false;
  const left = await readLeft();
  if (Number.isFinite(left[st.groupId]) && st.ts <= left[st.groupId]) {
    console.log('[Gruppen] Stand einer verlassenen Gruppe ignoriert');
    return false;
  }
  const contacts = await readContacts();
  let before = null;
  let after = null;
  let isInvite = false;
  let reclaimed = false;
  await mutateGroups((groups) => {
    const cur = findGroup(groups, st.groupId);
    if (!cur || cur.v !== GROUP_FORMAT) {
      // Einladung: nur von einem Admin, der selbst Mitglied ist, und nur, wenn
      // ich drinstehe.
      if (!st.admins.includes(senderMid) || !st.members.some(m => m.mid === senderMid)) return null;
      if (!st.members.some(m => m.mid === selfMid)) return null;
      // Audit G4: nur ein ausdrueckliches Hinzufuegen (bzw. das Erstellen
      // durch den Ersteller selbst) ist eine Einladung - ein spaeter
      // zugestellter Stand (Umbenennen, Entfernen anderer, ...) holt eine
      // verlassene Gruppe nicht als "Zombie" zurueck.
      const invitesMe = (st.change?.kind === 'create' && st.createdBy === senderMid)
        || (st.change?.kind === 'add' && (st.change.mids || []).includes(selfMid));
      if (!invitesMe) {
        console.log('[Gruppen] Stand einer unbekannten Gruppe ohne Einladung ignoriert');
        return null;
      }
      // Audit G7: Obergrenzen.
      const active = groups.filter(g => g.v === GROUP_FORMAT && !g.removed);
      if (active.length >= GROUPS_MAX || active.filter(g => g.invitedBy === contactId).length >= INVITES_PER_CONTACT_MAX) {
        console.warn('[Gruppen] Einladung ueber der Obergrenze ignoriert');
        return null;
      }
      isInvite = true;
      after = withDerived({
        v: GROUP_FORMAT, groupId: st.groupId, name: st.name, description: st.description,
        avatarUri: cur?.avatarUri || null, members: st.members, admins: st.admins,
        createdBy: st.createdBy, createdAt: st.createdAt, rev: st.rev, updatedAt: st.ts,
        removed: false, leftMembers: {}, unread: 0, last: '', lastTime: null, invitedBy: contactId,
      }, selfMid, contacts);
      return cur ? groups.map(g => (g === cur ? after : g)) : [...groups, after];
    }
    // Audit G5: der Ersteller ist fest - ein Stand mit anderem Ersteller ist ein Widerspruch.
    if (cur.createdBy && st.createdBy && st.createdBy !== cur.createdBy) {
      console.warn('[Gruppen] Gruppenstand mit anderem Ersteller verworfen');
      return null;
    }
    // Audit G5: Hat sich hier ein anderes Mitglied die Admin-Rolle angeeignet
    // (Wettlauf um die Einladung), darf der Ersteller - solange er Mitglied
    // ist - sie zurueckholen; sein Stand gilt dann unabhaengig vom Zaehler.
    const senderIsAdmin = (cur.admins || []).includes(senderMid);
    reclaimed = !senderIsAdmin && !!cur.createdBy && senderMid === cur.createdBy
      && (cur.members || []).some(m => m.mid === senderMid) && st.admins.includes(senderMid);
    if (!senderIsAdmin && !reclaimed) {
      console.warn('[Gruppen] Gruppenstand von Nicht-Admin verworfen');
      return null;
    }
    if (!reclaimed && st.rev <= (cur.rev || 0)) return null;
    // Wer nach dem Stand dieses Pakets ausgetreten ist, bleibt draussen.
    const leftMembers = { ...(cur.leftMembers || {}) };
    let members = st.members.filter(m => !(Number.isFinite(leftMembers[m.mid]) && st.ts <= leftMembers[m.mid]));
    for (const m of members) if (leftMembers[m.mid] != null) delete leftMembers[m.mid];
    let admins = st.admins.filter(a => members.some(m => m.mid === a));
    if (!admins.length && members.length) admins = [members[0].mid];
    before = cur;
    after = withDerived({
      ...cur, name: st.name, description: st.description, members, admins,
      rev: st.rev, updatedAt: st.ts, leftMembers,
      removed: !members.some(m => m.mid === selfMid),
    }, selfMid, contacts);
    return groups.map(g => (g === cur ? after : g));
  });
  if (!after) return false;
  if (reclaimed) {
    await appendToChat(st.groupId, [sysNotice('Achtung: Ein anderes Mitglied hatte sich hier als Admin eingetragen. Der Ersteller der Gruppe hat das korrigiert.')]);
    console.warn('[Gruppen] Admin-Rolle vom Ersteller zurueckgeholt');
  }
  if (isInvite) {
    await clearLeft(st.groupId);
    const by = memberName(after, senderMid, contacts, selfMid);
    const text = t('groups.notice.invited', { by, name: after.name });
    await appendToChat(st.groupId, [sysNotice(text)]);
    await setPreview(st.groupId, text, Date.now(), { bump: !isGroupChatOpen(st.groupId) });
    console.log('[Gruppen] Einladung angenommen');
    try { inviteListener?.(st.groupId, contactId); } catch {}
  } else {
    await appendToChat(st.groupId, diffNotices(before, after, st.change, senderMid, contacts, selfMid));
    console.log('[Gruppen] Gruppenstand aktualisiert');
    // Audit G8: wer nicht mehr dabei ist, bekommt nichts mehr aus der Warteschlange.
    const nowMids = new Set((after.members || []).map(m => m.mid));
    await dropQueuedContentFor(st.groupId, (before.members || []).map(m => m.mid).filter(m => !nowMids.has(m)));
  }
  await reprocessPending(st.groupId);
  return true;
}

function diffNotices(before, after, change, senderMid, contacts, selfMid) {
  const out = [];
  const now = Date.now();
  // Audit G6: Aenderungen immer dem tatsaechlichen Absender zuschreiben -
  // change.by stammt von ihm und koennte ein anderes Mitglied nennen.
  const byMid = senderMid;
  const name = (g, mid) => memberName(g, mid, contacts, selfMid);
  const oldMids = new Set((before.members || []).map(m => m.mid));
  const newMids = new Set((after.members || []).map(m => m.mid));
  const added = [...newMids].filter(m => !oldMids.has(m));
  const removed = [...oldMids].filter(m => !newMids.has(m));
  const by = name(after, byMid) || name(before, byMid);
  if (added.length) {
    const names = added.map(m => (m === selfMid ? t('groups.notice.youObject') : name(after, m))).join(', ');
    out.push(sysNotice(t('groups.notice.added', { by, names }), now));
  }
  for (const m of removed) {
    if (change?.kind === 'leave' && m === change.by) out.push(sysNotice(t('groups.notice.left', { name: name(before, m) }), now));
    else if (m === selfMid) out.push(sysNotice(t('groups.notice.youWereRemoved'), now));
    else out.push(sysNotice(t('groups.notice.removed', { by, name: name(before, m) }), now));
  }
  if (before.name !== after.name) out.push(sysNotice(t('groups.notice.renamed', { by, name: after.name }), now));
  else if ((before.description || '') !== (after.description || '')) out.push(sysNotice(t('groups.notice.descChanged', { by }), now));
  const newAdmins = (after.admins || []).filter(a => !(before.admins || []).includes(a));
  for (const a of newAdmins) out.push(sysNotice(a === selfMid ? t('groups.notice.youAreAdmin') : t('groups.notice.isAdmin', { name: name(after, a) }), now));
  return out;
}

async function handleLeave(contactId, msg) {
  if (!Number.isFinite(msg.ts)) return false;
  const selfMid = await getSelfMemberId();
  const senderMid = await senderMidFor(contactId, msg.fromMid);
  if (!senderMid) return false;
  const contacts = await readContacts();
  let before = null;
  let after = null;
  await mutateGroups((groups) => {
    const cur = findGroup(groups, msg.groupId);
    if (!cur || cur.v !== GROUP_FORMAT || cur.removed) return null;
    if (!(cur.members || []).some(m => m.mid === senderMid)) return null;
    const members = cur.members.filter(m => m.mid !== senderMid);
    let admins = (cur.admins || []).filter(a => a !== senderMid);
    // Letzter Admin ohne Uebergabe ausgetreten: alle Geraete waehlen
    // deterministisch dasselbe naechste Mitglied.
    if (!admins.length && members.length) admins = [members[0].mid];
    before = cur;
    after = withDerived({
      ...cur, members, admins, leftMembers: { ...(cur.leftMembers || {}), [senderMid]: msg.ts },
    }, selfMid, contacts);
    return groups.map(g => (g === cur ? after : g));
  });
  if (!after) return false;
  await appendToChat(msg.groupId, diffNotices(before, after, { kind: 'leave', by: senderMid }, senderMid, contacts, selfMid));
  console.log('[Gruppen] Mitglied ausgetreten');
  await dropQueuedContentFor(msg.groupId, [senderMid]);   // Audit G8
  // Als (einziger) Admin den verbindlichen neuen Stand an alle verteilen -
  // sonst koennte ein aelterer Stand das ausgetretene Mitglied wieder eintragen.
  if (after.admins.includes(selfMid)) {
    const next = await bumpAndStore(msg.groupId, () => ({}));
    if (next) await broadcastState(next, { kind: 'leave', by: senderMid });
  }
  return true;
}

async function handleText(contactId, msg, { pendingAt = null } = {}) {
  const text = cleanText(msg.text, TEXT_MAX);
  if (!text || typeof msg.msgId !== 'string' || !MSG_ID_RE.test(msg.msgId)) {
    console.warn('[Gruppen] Ungueltige Gruppen-Nachricht verworfen');
    return false;
  }
  const selfMid = await getSelfMemberId();
  const senderMid = await senderMidFor(contactId, msg.fromMid);
  if (!senderMid || senderMid === selfMid) return false;
  const left = await readLeft();
  const groups = await readGroups();
  const g = findGroup(groups, msg.groupId);
  if (!g || g.v !== GROUP_FORMAT) {
    if (Number.isFinite(left[msg.groupId])) {
      console.log('[Gruppen] Nachricht fuer verlassene Gruppe verworfen');
      return false;
    }
    console.log('[Gruppen] Nachricht fuer unbekannte Gruppe zurueckgestellt');
    await addPending(msg.groupId, contactId, msg, pendingAt || Date.now());
    return false;
  }
  if (g.removed) {
    console.log('[Gruppen] Nachricht fuer Gruppe ohne Mitgliedschaft verworfen');
    return false;
  }
  if (!(g.members || []).some(m => m.mid === senderMid)) {
    // Evtl. neues Mitglied, dessen Aufnahme hier noch nicht angekommen ist.
    console.log('[Gruppen] Nachricht eines (noch) nicht eingetragenen Mitglieds zurueckgestellt');
    await addPending(msg.groupId, contactId, msg, pendingAt || Date.now());
    return false;
  }
  const now = Date.now();
  const time = Number.isFinite(msg.time) && msg.time <= now + FUTURE_TOLERANCE_MS ? msg.time : now;
  const added = await appendToChat(msg.groupId, [{
    id: msg.msgId, from: senderMid, fromContactId: contactId, mine: false, text, time, rxAt: now,
  }]);
  if (!added.length) {
    console.log('[Gruppen] Doppelt zugestellte Gruppen-Nachricht verworfen');
    return true;
  }
  const contacts = await readContacts();
  const open = isGroupChatOpen(msg.groupId);
  await setPreview(msg.groupId, `${memberName(g, senderMid, contacts, selfMid)}: ${text}`, time, { bump: !open });
  if (!open && typeof global !== 'undefined' && typeof global.showMalachiNotification === 'function') {
    try { global.showMalachiNotification(contactId); } catch {}
  }
  console.log('[Gruppen] Gruppen-Nachricht abgelegt');
  return true;
}

async function reprocessPending(groupId) {
  const items = [...await takePending(groupId), ...takePendingMedia(groupId)];
  for (const it of items) {
    if (!it || !it.msg) continue;
    if (isGroupMedia(it.msg)) {
      try { await handleMedia(it.contactId, it.msg, { pendingAt: it.at }); } catch {}
      continue;
    }
    if (it.msg.subtype !== 'group_text') continue;
    try { await handleText(it.contactId, it.msg, { pendingAt: it.at }); } catch {}
  }
}

// Bild/Sprachnachricht eines Mitglieds (RTCStore: vollstaendig empfangen,
// entschluesselt, Dateischluessel geprueft). Gruppe und Nachrichten-ID stecken
// in der Zustell-ID; der Absender ist der Kontakt des Kanals - wie bei Texten.
function mediaPreview(kind) {
  return kind === 'image' ? '📷 Bild' : '🎤 Sprachnachricht';
}
async function handleMedia(contactId, msg, { pendingAt = null } = {}) {
  const a = parseAck(msg.msgId);
  const kind = msg.type === 'image_complete' ? 'image' : 'audio';
  if (!a || a.kind !== 'm' || !GROUP_ID_RE.test(a.groupId) || !MSG_ID_RE.test(a.ref)
      || typeof msg.base64 !== 'string' || !msg.base64 || msg.base64.length > MEDIA_MAX_B64[kind]) {
    console.warn('[Gruppen] Ungueltiges Gruppen-Medium verworfen');
    return false;
  }
  const mimeType = kind === 'image' ? String(msg.mimeType || '').toLowerCase() : 'audio/mp4';
  if (kind === 'image' && !IMAGE_MIME_RE.test(mimeType)) {
    console.warn('[Gruppen] Gruppen-Bild mit unerlaubtem Typ verworfen');
    return false;
  }
  const selfMid = await getSelfMemberId();
  const senderMid = await senderMidFor(contactId, null);
  if (!senderMid || senderMid === selfMid) return false;
  const left = await readLeft();
  const groups = await readGroups();
  const g = findGroup(groups, a.groupId);
  if (!g || g.v !== GROUP_FORMAT || !(g.members || []).some(m => m.mid === senderMid)) {
    if (Number.isFinite(left[a.groupId]) || (g && g.removed)) {
      console.log('[Gruppen] Medium fuer verlassene Gruppe verworfen');
      return false;
    }
    console.log('[Gruppen] Medium fuer unbekannte Gruppe/unbekanntes Mitglied zurueckgestellt (nur RAM)');
    addPendingMedia(a.groupId, contactId, msg, pendingAt || Date.now());
    return false;
  }
  if (g.removed) return false;
  const now = Date.now();
  const entry = { id: a.ref, from: senderMid, fromContactId: contactId, mine: false, type: kind, mimeType, base64: msg.base64, time: now, rxAt: now };
  if (kind === 'audio') entry.durationMs = Number.isFinite(msg.durationMs) ? Math.max(0, Math.min(msg.durationMs, AUDIO_MAX_MS)) : 0;
  const added = await appendToChat(a.groupId, [entry]);
  if (!added.length) {
    console.log('[Gruppen] Doppelt zugestelltes Gruppen-Medium verworfen');
    return true;
  }
  const contacts = await readContacts();
  const open = isGroupChatOpen(a.groupId);
  await setPreview(a.groupId, `${memberName(g, senderMid, contacts, selfMid)}: ${mediaPreview(kind)}`, now, { bump: !open });
  if (!open && typeof global !== 'undefined' && typeof global.showMalachiNotification === 'function') {
    try { global.showMalachiNotification(contactId); } catch {}
  }
  console.log('[Gruppen] Gruppen-Medium abgelegt');
  return true;
}

async function setPreview(groupId, text, time, { bump }) {
  const last = text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text;
  await mutateGroups((groups) => {
    const g = findGroup(groups, groupId);
    if (!g) return null;
    const next = { ...g, last, lastTime: time, unread: bump ? (g.unread || 0) + 1 : (g.unread || 0) };
    return groups.map(x => (x === g ? next : x));
  }).catch(() => {});
}

export async function markGroupRead(groupId) {
  await mutateGroups((groups) => {
    const g = findGroup(groups, groupId);
    if (!g || !g.unread) return null;
    return groups.map(x => (x === g ? { ...g, unread: 0 } : x));
  }).catch(() => {});
}

// ─── Empfangsbestaetigung (BackgroundSync.onQueueReceipt) ────────────────────
export async function onGroupReceipt(contactId, ackId) {
  const a = parseAck(ackId);
  if (!a || (a.kind !== 't' && a.kind !== 'm') || !GROUP_ID_RE.test(a.groupId)) return false;
  const mid = await midOfContactId(contactId);
  if (!mid) return false;
  return updateOwnMessage(a.groupId, a.ref, (m) => {
    if (!(mid in m.recipients) || m.recipients[mid] === 'delivered') return false;
    m.recipients[mid] = 'delivered';
    return true;
  });
}

// ─── Versand ────────────────────────────────────────────────────────────────
async function ownName() {
  const n = await EncryptedStorage.getItem('username').catch(() => null);
  return safeName(n || 'Malachi User', MEMBER_NAME_MAX) || 'Malachi User';
}
function displayNameForState(c) {
  return safeName(c?.theirName || c?.name || 'Unbekannt', MEMBER_NAME_MAX) || 'Unbekannt';
}

// Ziele: alle Mitglieder (ausser mir), mit denen ich direkt gekoppelt bin.
async function targetsFor(group, extraMids = []) {
  const contacts = await readContacts();
  const mids = new Set([...(group.members || []).map(m => m.mid), ...extraMids]);
  const selfMid = await getSelfMemberId();
  mids.delete(selfMid);
  const out = [];
  const unreachable = [];
  for (const mid of mids) {
    const c = contacts.find(x => memberIdOfContact(x) === mid && !x.pendingDelete && !x.wiped);
    if (c) out.push({ mid, contactId: c.id });
    else unreachable.push(mid);
  }
  return { targets: out, unreachable, contacts, selfMid };
}

async function fanOut(targets, payload, ackId, opts = {}, type = 'system') {
  const results = {};
  for (const t of targets) {
    let ok = false;
    try { ok = !!(await deps.sendViaOutbox(t.contactId, type, payload, ackId, opts)); } catch {}
    results[t.mid] = ok;
  }
  return results;
}

async function broadcastState(group, change, extraMids = []) {
  const { targets, unreachable, selfMid } = await targetsFor(group, extraMids);
  const payload = {
    type: 'system', subtype: 'group_state', groupId: group.groupId, name: group.name,
    description: group.description || '', members: group.members, admins: group.admins,
    createdBy: group.createdBy, createdAt: group.createdAt, rev: group.rev, ts: Date.now(),
    change: { kind: change.kind, by: change.by || selfMid, ...(Array.isArray(change.mids) ? { mids: change.mids } : {}) },
    fromMid: selfMid,
  };
  const results = await fanOut(targets, payload, ackFor('s', group.groupId, group.rev), { groupId: group.groupId });
  const failed = Object.values(results).filter(ok => !ok).length;
  console.log('[Gruppen] Gruppenstand verteilt:', targets.length - failed, 'eingereiht,', unreachable.length, 'nicht direkt erreichbar');
  return { queued: targets.length - failed, failed, unreachable };
}

export async function sendGroupText(groupId, rawText) {
  const text = cleanText(rawText, TEXT_MAX);
  if (!text) return null;
  const groups = await readGroups();
  const g = findGroup(groups, groupId);
  if (!g || g.v !== GROUP_FORMAT || g.removed) return { error: 'not_member' };
  const { targets, unreachable, selfMid } = await targetsFor(g);
  const msgId = Date.now().toString(36) + await secureRandomToken(8);
  const time = Date.now();
  const recipients = Object.fromEntries(targets.map(t => [t.mid, 'sending']));
  // write-ahead: erst im eigenen Verlauf, dann pro Mitglied verschluesselt in
  // dessen Warteschlange.
  await appendToChat(groupId, [{ id: msgId, from: selfMid, mine: true, text, time, recipients, status: computeGroupStatus(recipients) }]);
  await setPreview(groupId, t('groups.preview.mine', { text }), time, { bump: false });
  const payload = { type: 'system', subtype: 'group_text', groupId, msgId, text, time, fromMid: selfMid };
  const results = await fanOut(targets, payload, ackFor('t', groupId, msgId), { groupId });
  await updateOwnMessage(groupId, msgId, (m) => {
    for (const [mid, ok] of Object.entries(results)) {
      if (m.recipients[mid] !== 'delivered') m.recipients[mid] = ok ? 'queued' : 'failed';
    }
  });
  return { msgId, reached: targets.length, unreachable };
}

// Bild oder Sprachnachricht an die Gruppe: wie ein Text write-ahead, dann
// je Mitglied ueber dessen verschluesselte Warteschlange als normales Medium
// (eigener Dateischluessel pro Kopie) - Zustell-ID ordnet es der Gruppe zu.
export async function sendGroupMedia(groupId, { kind, base64, mimeType, durationMs } = {}) {
  if (!MEDIA_KINDS.has(kind) || typeof base64 !== 'string' || !base64) return { error: 'invalid' };
  if (base64.length > MEDIA_MAX_B64[kind]) return { error: 'too_large' };
  const mime = kind === 'image' ? String(mimeType || 'image/jpeg').toLowerCase() : 'audio/mp4';
  if (kind === 'image' && !IMAGE_MIME_RE.test(mime)) return { error: 'invalid' };
  const groups = await readGroups();
  const g = findGroup(groups, groupId);
  if (!g || g.v !== GROUP_FORMAT || g.removed) return { error: 'not_member' };
  const { targets, unreachable, selfMid } = await targetsFor(g);
  const msgId = Date.now().toString(36) + await secureRandomToken(8);
  const time = Date.now();
  const recipients = Object.fromEntries(targets.map(t => [t.mid, 'sending']));
  const dur = kind === 'audio' && Number.isFinite(durationMs) ? Math.max(0, Math.min(durationMs, AUDIO_MAX_MS)) : undefined;
  const own = { id: msgId, from: selfMid, mine: true, type: kind, mimeType: mime, base64, time, recipients, status: computeGroupStatus(recipients) };
  if (dur !== undefined) own.durationMs = dur;
  await appendToChat(groupId, [own]);
  await setPreview(groupId, 'Du: ' + mediaPreview(kind), time, { bump: false });
  const payload = kind === 'image' ? { base64, mimeType: mime } : { base64, durationMs: dur || 0, viewOnce: false };
  const results = await fanOut(targets, payload, ackFor('m', groupId, msgId), { groupId }, kind);
  await updateOwnMessage(groupId, msgId, (m) => {
    for (const [mid, ok] of Object.entries(results)) {
      if (m.recipients[mid] !== 'delivered') m.recipients[mid] = ok ? 'queued' : 'failed';
    }
  });
  return { msgId, reached: targets.length, unreachable };
}

// Admin-Aenderung: neuer Stand mit rev+1 (serialisiert gespeichert).
async function bumpAndStore(groupId, mutate) {
  const selfMid = await getSelfMemberId();
  const contacts = await readContacts();
  let next = null;
  await mutateGroups((groups) => {
    const g = findGroup(groups, groupId);
    if (!g || g.v !== GROUP_FORMAT || g.removed || !(g.admins || []).includes(selfMid)) return null;
    const patch = mutate(g);
    if (!patch) return null;
    next = withDerived({ ...g, ...patch, rev: (g.rev || 0) + 1, updatedAt: Date.now() }, selfMid, contacts);
    return groups.map(x => (x === g ? next : x));
  });
  return next;
}

export async function createGroup({ name, description, memberContactIds }) {
  const cleanName = safeName(name, NAME_MAX);
  if (!cleanName) return { error: 'name' };
  const selfMid = await getSelfMemberId();
  const contacts = await readContacts();
  const ids = [...new Set(Array.isArray(memberContactIds) ? memberContactIds : [])];
  const picked = ids.map(id => contacts.find(c => c.id === id)).filter(Boolean);
  const missing = picked.filter(c => !memberIdOfContact(c));
  if (missing.length) return { error: 'missing_member_id', missing: missing.map(c => c.name || t('groups.unknown')) };
  if (!picked.length) return { error: 'members' };
  if (picked.length + 1 > GROUP_MAX_MEMBERS) return { error: 'too_many' };
  const now = Date.now();
  const group = withDerived({
    v: GROUP_FORMAT,
    groupId: 'g_' + await secureRandomToken(12),
    name: cleanName, description: safeDesc(description, DESC_MAX), avatarUri: null,
    members: [{ mid: selfMid, name: await ownName() }, ...picked.map(c => ({ mid: memberIdOfContact(c), name: displayNameForState(c) }))],
    admins: [selfMid], createdBy: selfMid, createdAt: now, rev: 1, updatedAt: now,
    removed: false, leftMembers: {}, unread: 0, last: '', lastTime: null,
  }, selfMid, contacts);
  await clearLeft(group.groupId);
  await mutateGroups(gs => [...gs, group]);
  await appendToChat(group.groupId, [sysNotice(t('groups.notice.created'), now)]);
  const res = await broadcastState(group, { kind: 'create', by: selfMid });
  return { group, ...res };
}

export async function addGroupMembers(groupId, contactIds) {
  const contacts = await readContacts();
  const picked = [...new Set(contactIds || [])].map(id => contacts.find(c => c.id === id)).filter(Boolean);
  const missing = picked.filter(c => !memberIdOfContact(c));
  if (missing.length) return { error: 'missing_member_id', missing: missing.map(c => c.name || t('groups.unknown')) };
  let addedMids = [];
  const next = await bumpAndStore(groupId, (g) => {
    const have = new Set(g.members.map(m => m.mid));
    const add = picked.filter(c => !have.has(memberIdOfContact(c)));
    if (!add.length || g.members.length + add.length > GROUP_MAX_MEMBERS) return null;
    addedMids = add.map(c => memberIdOfContact(c));
    const leftMembers = { ...(g.leftMembers || {}) };
    for (const m of addedMids) delete leftMembers[m];
    return { members: [...g.members, ...add.map(c => ({ mid: memberIdOfContact(c), name: displayNameForState(c) }))], leftMembers };
  });
  if (!next) return { error: 'not_allowed' };
  const names = addedMids.map(m => memberName(next, m, contacts, next.selfMid)).join(', ');
  await appendToChat(groupId, [sysNotice(t('groups.notice.youAdded', { names }))]);
  return { group: next, ...(await broadcastState(next, { kind: 'add', mids: addedMids })) };
}

export async function removeGroupMember(groupId, mid) {
  const contacts = await readContacts();
  let before = null;
  const next = await bumpAndStore(groupId, (g) => {
    if (mid === g.selfMid || !g.members.some(m => m.mid === mid)) return null;
    before = g;
    return { members: g.members.filter(m => m.mid !== mid), admins: g.admins.filter(a => a !== mid) };
  });
  if (!next) return { error: 'not_allowed' };
  await appendToChat(groupId, [sysNotice(t('groups.notice.youRemoved', { name: memberName(before, mid, contacts, next.selfMid) }))]);
  await dropQueuedContentFor(groupId, [mid]);   // Audit G8
  // Auch an das entfernte Mitglied - es erfaehrt so, dass es draussen ist.
  return { group: next, ...(await broadcastState(next, { kind: 'remove' }, [mid])) };
}

export async function updateGroupInfo(groupId, { name, description }) {
  const cleanName = safeName(name, NAME_MAX);
  const cleanDesc = safeDesc(description, DESC_MAX);
  const next = await bumpAndStore(groupId, (g) => {
    const n = cleanName || g.name;
    if (n === g.name && cleanDesc === (g.description || '')) return null;
    return { name: n, description: cleanDesc };
  });
  if (!next) return { error: 'not_allowed' };
  await appendToChat(groupId, [sysNotice(t('groups.notice.youChangedInfo'))]);
  return { group: next, ...(await broadcastState(next, { kind: 'rename' })) };
}

// Gruppenbild bleibt in v1 lokal (wird nicht verteilt, siehe GROUP_CHAT_DESIGN.md).
export async function setGroupAvatarLocal(groupId, avatarUri) {
  await mutateGroups((groups) => {
    const g = findGroup(groups, groupId);
    if (!g) return null;
    return groups.map(x => (x === g ? { ...g, avatarUri: avatarUri || null } : x));
  });
}

// Austreten: jederzeit erlaubt. Letzter Admin uebergibt die Rolle (neuer Stand
// ohne mich), sonst geht group_leave an alle direkt gekoppelten Mitglieder.
// Danach lokal alles entfernen (Verlauf, noch nicht zugestellte eigene Texte).
export async function leaveGroup(groupId) {
  const selfMid = await getSelfMemberId();
  const g = findGroup(await readGroups(), groupId);
  if (!g) return false;
  if (g.v === GROUP_FORMAT && !g.removed) {
    const others = (g.members || []).filter(m => m.mid !== selfMid);
    const otherAdmins = (g.admins || []).filter(a => a !== selfMid);
    if ((g.admins || []).includes(selfMid) && !otherAdmins.length && others.length) {
      const next = { ...g, members: others, admins: [others[0].mid], rev: (g.rev || 0) + 1 };
      await broadcastState(next, { kind: 'leave', by: selfMid });
    } else if (others.length) {
      const { targets } = await targetsFor(g);
      const ts = Date.now();
      const payload = { type: 'system', subtype: 'group_leave', groupId, ts, fromMid: selfMid };
      await fanOut(targets, payload, ackFor('l', groupId, String(ts)), { groupId });
    }
  }
  await removeGroupData(groupId);
  console.log('[Gruppen] Gruppe verlassen');
  return true;
}

// Nur lokal entfernen (z.B. nachdem man entfernt wurde). Fuer alle loeschen
// gibt es bewusst nicht.
export async function deleteGroupLocally(groupId) {
  await removeGroupData(groupId);
  return true;
}

async function removeGroupData(groupId) {
  await setLeft(groupId, Date.now());
  const g = findGroup(await readGroups(), groupId);
  await mutateGroups(gs => (gs.some(x => x.groupId === groupId) ? gs.filter(x => x.groupId !== groupId) : null));
  await withChatLock(groupId, async () => {
    await EncryptedStorage.removeItem(GROUP_CHAT_PREFIX + groupId).catch(() => {});
    await removeMediaScope(groupMediaScope(groupId)).catch(() => {});   // Audit G1
  });
  emitChat(groupId, []);
  await dropPending(groupId);
  pendingMediaRam.delete(groupId);
  // Noch nicht zugestellte eigene Texte und Medien dieser Gruppe nicht mehr
  // zustellen (Steuersignale wie group_leave bleiben).
  if (g) await dropQueuedContentFor(groupId, (g.members || []).map(m => m.mid));
}

// Noch wartende Texte/Medien dieser Gruppe an die genannten Mitglieder
// verwerfen (Steuersignale bleiben) - Austritt, Entfernen, Gruppe verlassen
// (Audit G8).
async function dropQueuedContentFor(groupId, mids) {
  if (!mids?.length || typeof deps.dropFromQueue !== 'function') return;
  const contacts = await readContacts();
  for (const mid of mids) {
    const c = contacts.find(x => memberIdOfContact(x) === mid);
    if (!c) continue;
    await deps.dropFromQueue(c.id, i => i.groupId === groupId
      && (i.subtype === 'group_text' || i.type === 'image' || i.type === 'audio')).catch(() => {});
  }
}

// ─── Laden / Altbestand ─────────────────────────────────────────────────────
// Gruppen aus Phase 0 (nur lokal, ohne members/rev) werden beim ersten Laden
// auf das Gruppenformat umgestellt und - da nur der Ersteller sie haben kann -
// an die Mitglieder verteilt. Kontakte ohne Mitglieds-ID fallen dabei heraus
// (Hinweis im Verlauf).
export async function loadGroups() {
  const groups = await readGroups();
  if (!groups.some(g => g.v !== GROUP_FORMAT)) return groups;
  const selfMid = await getSelfMemberId();
  const contacts = await readContacts();
  const me = await ownName();
  const upgraded = [];
  const updated = await mutateGroups((gs) => {
    let changed = false;
    const next = gs.map((g) => {
      if (!g || g.v === GROUP_FORMAT || !g.groupId) return g;
      changed = true;
      const picked = (g.memberContactIds || []).map(id => contacts.find(c => c.id === id)).filter(Boolean);
      const ok = picked.filter(c => memberIdOfContact(c));
      const ng = withDerived({
        ...g, v: GROUP_FORMAT,
        name: safeName(g.name, NAME_MAX) || 'Gruppe', description: safeDesc(g.description, DESC_MAX),
        members: [{ mid: selfMid, name: me }, ...ok.slice(0, GROUP_MAX_MEMBERS - 1).map(c => ({ mid: memberIdOfContact(c), name: displayNameForState(c) }))],
        admins: [selfMid], createdBy: selfMid, rev: 1, updatedAt: Date.now(),
        removed: false, leftMembers: {}, unread: g.unread || 0, last: g.last || '', lastTime: g.lastTime || null,
      }, selfMid, contacts);
      upgraded.push({ g: ng, skipped: picked.length - ok.length });
      return ng;
    });
    return changed ? next : null;
  });
  for (const { g, skipped } of upgraded) {
    const notes = [sysNotice(t('groups.notice.upgraded'))];
    if (skipped) notes.push(sysNotice(t('groups.notice.skipped', { count: skipped })));
    await appendToChat(g.groupId, notes);
    if (g.members.length > 1) await broadcastState(g, { kind: 'create' });
  }
  return updated || await readGroups();
}

// ─── Verdrahtung ────────────────────────────────────────────────────────────
RTCStore.groupMessageHandler = handleGroupMessage;
RTCStore.groupIdHandler = (contactId, gid) => { rememberPeerMemberId(contactId, gid).catch(() => {}); };
RTCStore.ownGroupIdProvider = getSelfMemberId;
RTCStore.onWipe((chatId) => {
  if (chatId == null) {
    // Vollstaendiger Wipe: Speicher leert performWipe, hier nur den RAM.
    selfIdPromise = null;
    peerIds.clear();
    pendingMediaRam.clear();
    for (const t of persistRetries.values()) clearTimeout(t);
    persistRetries.clear();
    return;
  }
  peerIds.delete(chatId);
  const t = persistRetries.get(chatId);
  if (t) clearTimeout(t);
  persistRetries.delete(chatId);
});

export function _resetGroupMessagingForTests() {
  selfIdPromise = null;
  peerIds.clear();
  pendingMediaRam.clear();
  for (const t of persistRetries.values()) clearTimeout(t);
  persistRetries.clear();
  chatListeners.clear();
  uiGroupsListener = null;
  inviteListener = null;
}
