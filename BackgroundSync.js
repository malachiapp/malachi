// BackgroundSync.js - Stufe 2 aus FOREGROUND_SERVICE_PLAN.md (Abschnitt 3a).
//
// Die storage-getriebene Kernlogik der beiden Auto-Reconnect-/Empfangs-Poll-
// Zyklen, bisher als checkIncoming/checkOutgoing direkt in App.tsx's
// useEffect-Bloecken. Hierher ausgelagert, damit sie auch OHNE gemountete
// React-Root laufen kann: Live-Spike 2026-09-27 hat bestaetigt, dass ein
// HeadlessJS-Task (MalachiHeadlessTaskService, ausgeloest von MalachiService)
// unabhaengig davon ausgefuehrt wird, ob MainActivity/App() noch existiert -
// die useEffect-Timer in App.tsx sterben dagegen mit der Activity (App aus
// "Zuletzt verwendet" gewischt).
//
// Keine Logikaenderung gegenueber dem vorherigen App.tsx-Code - reine
// Verschiebung. Beim Merge in den Haupt-Checkout aus dem NEUEREN App.tsx-
// Stand neu extrahiert, d.h. inklusive der dort inzwischen live-getesteten
// Review-Funde 2026-09-27 "H1" (Zeitstempel beim Flush neu setzen), "H2"
// (synthetischer 'sent'-Receipt nach Flush), "H3" (onDisc loescht nur die
// eigene Instanz), "M1" (withQueueLock), "M3" (wipeQueueForContact) und
// "M5" (Reconnect-Backoff + kein Offer-Polling bei stehender Verbindung) -
// siehe jeweilige Markierungen unten. Mechanisch ersetzt wurde nur:
//   - setContacts(...)      -> onContactsChanged(...)  (Callback, s.u.)
//   - xyzRef.current         -> Modul-Variable (s.u. "Zyklus-Zustand")
//   - GLOBAL_RTC = rtc       -> onRtcConnected(contact.id, rtc) (Callback)
//   - checkIncoming()/checkOutgoing() (Selbstaufruf nach Verbindungsverlust)
//                            -> runIncomingCycle(options)/runOutgoingCycle(options)
//
// Callbacks (alle optional, Default = No-op fuer den Headless-Fall):
//   - onContactsChanged(updater): bekommt dieselbe reine Updater-Funktion
//     (prev => next), die bisher direkt an setContacts() ging. Die
//     PERSISTENZ laeuft unabhaengig davon immer hier ueber updateContacts() -
//     der Callback spiegelt die Aenderung nur in den React-State (App.tsx
//     reicht setContacts durch). Headless: kein React-State vorhanden, No-op.
//   - (onNotifyMessage entfaellt: es gibt keinen Relay-Empfangspfad mehr,
//     Benachrichtigungen kommen ueber RTCStore wie bei jeder P2P-Nachricht.)
//   - onRtcConnected(contactId, rtc): Verbindung steht (Tor oder direkt). App.tsx
//     setzt darueber sein modulweites GLOBAL_RTC (UI-Fallback in ChatScreen),
//     genau wie vorher inline.
//
// Serverlos (Okt. 2026): Es gibt keinen Treffpunkt-/Relay-Server mehr.
// runOutgoingCycle() ist jetzt der Verbindungszyklus: jeder Kontakt wird
// ueber Tor verbunden (TorTransport.connectViaTor), danach wird ueber die
// Tor-Verbindung eine Direktverbindung ausgehandelt (DirectUpgrade.js).
// runIncomingCycle() erledigt nur noch lokale Wartung (endgueltiges Entfernen
// nie zustellbarer Loeschungen) - es gibt keine Server-Pakete mehr abzuholen.
import EncryptedStorage from 'react-native-encrypted-storage';
import RNFS from 'react-native-fs';
import { configureTorTransport, connectViaTor, getOwnOnion, ONION_RE, loadTorSettings,
  isTorReserveEnabled, hasTorReserve, promoteTorReserve, dropAllTorReserves, ensureTorRunning, onTorState } from './TorTransport';
import { sealForConnection, mediaSealerFor } from './WebRTCManager';
import { encryptMsg, decryptMsg, randomKeyB64, secureRandomToken } from './MessageCrypto';
import * as RatchetSession from './RatchetSession';
import { sendEncryptedImage } from './ImageCrypto';
import { sendEncryptedAudio } from './AudioCrypto';
import { sendEncryptedFile } from './FileCrypto';
import { removeMedia, removeScope as removeMediaScope } from './MediaVault';
import RTCStore from './RTCStore';
import * as PinVault from './PinVault';
import { configureDirectUpgrade, maybeStartUpgrade, onLocalNetworkChange as upgradeOnNetworkChange, resetUpgradeBackoff } from './DirectUpgrade';
import { loadConnectionMode } from './ConnectionMode';
import { configureGroupMessaging, onGroupReceipt, isGroupAckId } from './GroupMessaging';
import { configureGroupIntroPairing, createIntroInvite, joinIntroInvite, resumeIntroPairings } from './GroupIntroPairing';
import { t } from './i18n';

const noop = () => {};

// AsyncStorage-kompatibler Wrapper um EncryptedStorage - identisch zu dem in
// App.tsx (dort unveraendert, weil weiterhin von der UI genutzt). Hier nur
// getItem/setItem, mehr brauchen die ausgelagerten Zyklen nicht.
const AsyncStorage = {
  getItem: (key) => EncryptedStorage.getItem(key),
  setItem: (key, value) => EncryptedStorage.setItem(key, value),
};

// Serialisiert JEDEN Lese-Aendere-Schreibe-Zyklus auf den 'contacts'-
// Schluessel (State-Machine-/Konkurrenz-Review-Fund - siehe
// SECURITY_CONCURRENCY_REVIEW.md §5, identisch als Redundanz-Fund B1 in
// SIMPLIFICATION_PASS.md dokumentiert, dort wie hier zuvor bewusst
// zurueckgestellt): ohne das konnten zwei gleichzeitige Aktualisierungen fuer
// VERSCHIEDENE Kontakte (z.B. eine eingehende Nachricht erhoeht den
// Unread-Counter von Kontakt B, waehrend der Nutzer Kontakt A umbenennt)
// beide von derselben veralteten Liste ausgehen - wer zuletzt schreibt,
// verwirft die Aenderung des anderen stillschweigend. Jeder Aufruf wartet
// jetzt auf den vorherigen, bevor er selbst liest.
//
// `mutator(current)` bekommt die aktuell gespeicherte Kontaktliste (leeres
// Array, falls noch keine gespeichert ist) und gibt entweder die neue Liste
// zurueck (wird geschrieben) oder null/undefined, wenn es nichts zu
// aendern gab (Schreibvorgang wird uebersprungen - vermeidet einen
// unnoetigen Schreibvorgang, der pointless mit einem echten Schreibvorgang
// eines anderen Aufrufers ueberlappen koennte).
//
// Aus App.tsx hierher verschoben (Stufe 2): es darf genau EINE Schreibkette
// geben, die App-UI UND Headless-Task gemeinsam benutzen - zwei getrennte
// Ketten (eine pro Datei) wuerden den Lost-Update-Schutz zwischen den beiden
// Pfaden wieder aufheben. App.tsx exportiert weiterhin updateContacts() (als
// duenne Weiterleitung hierher), u.a. fuer __tests__/security/
// concurrency.contactsStorageLostUpdate*.test.js.
let contactsWriteChain = Promise.resolve();
export async function updateContacts(mutator) {
  const run = contactsWriteChain.then(async () => {
    const saved = await AsyncStorage.getItem('contacts');
    const current = saved ? JSON.parse(saved) : [];
    const updated = await mutator(current);
    // PIN-Tresor: Vorschautexte ('last') werden versiegelt gespeichert -
    // auch aus dem Hintergrund bei gesperrter App (PinVault.sealPreviewsIn).
    if (updated != null) await AsyncStorage.setItem('contacts', JSON.stringify(await PinVault.sealPreviewsIn(updated)));
    return updated;
  });
  // Muss auch bei einem Fehler weiterlaufen - sonst wuerde ein einziger
  // fehlgeschlagener Aufruf die Kette dauerhaft blockieren.
  contactsWriteChain = run.catch(() => {});
  return run;
}

// Gruppenchats Phase 0 (GROUP_CHAT_CRYPTO_PLAN.md §7) - eigener 'groups'-
// Schluessel, exakt dieselbe serialisierte Lese-Aendere-Schreibe-Kette wie
// updateContacts() oben und aus demselben Grund: App-UI und (spaeter, ab
// Phase 2) der Headless-Task teilen sich diese Funktion, zwei getrennte
// Ketten wuerden denselben Lost-Update-Schutz wieder aufheben.
// Eintragsform: {groupId, name, description, avatarUri, memberContactIds,
// admins, amAdmin, createdBy, createdAt} - memberContactIds/admins
// enthalten NUR die ID der jeweils ANDEREN Mitglieder (analog zu 'contacts',
// das "mich selbst" auch nie auflistet); amAdmin haelt separat fest, ob
// dieses Geraet selbst Admin ist.
let groupsWriteChain = Promise.resolve();
export async function updateGroups(mutator) {
  const run = groupsWriteChain.then(async () => {
    const saved = await AsyncStorage.getItem('groups');
    const current = saved ? JSON.parse(saved) : [];
    const updated = await mutator(current);
    if (updated != null) await AsyncStorage.setItem('groups', JSON.stringify(await PinVault.sealPreviewsIn(updated)));
    return updated;
  });
  groupsWriteChain = run.catch(() => {});
  return run;
}

// Review-Fund 2026-09-27 ("M1"): queueOffline() und flushQueue() machten
// beide ein ungesichertes Lese-Aendere-Schreibe auf denselben
// 'queue_<contactId>'-Schluessel. Lief z.B. ein flushQueue() (liest die Queue
// beim Verbindungsaufbau) zeitgleich mit einem queueOffline() (eine neue
// Nachricht wird genau in diesem Moment eingereiht, z.B. durch den
// Zustellungs-Timeout), konnte der zuletzt schreibende Aufruf den anderen
// stillschweigend ueberschreiben - die neu eingereihte Nachricht verschwand
// spurlos, oder ein Item wurde doppelt zugestellt. Gleiches Muster wie
// updateContacts() oben (SECURITY_CONCURRENCY_REVIEW.md), hier aber PRO
// KONTAKT statt global - Warteschlangen verschiedener Kontakte sind
// voneinander unabhaengig und sollen sich nicht gegenseitig blockieren.
//
// Hier (statt in App.tsx) definiert und exportiert, aus demselben Grund wie
// updateContacts(): App.tsx's queueOffline() (UI-Sendepfad) und flushQueue()
// unten (App-Zyklen UND Headless-Task) muessen sich GENAU EINE Kette pro
// Kontakt teilen - zwei getrennte Maps wuerden den Schutz aufheben.
const queueWriteChains = new Map(); // contactId -> Promise-Kette
export async function withQueueLock(contactId, fn) {
  const prev = queueWriteChains.get(contactId) || Promise.resolve();
  const run = prev.then(fn);
  // Muss auch bei einem Fehler weiterlaufen - siehe identischer Kommentar
  // bei updateContacts() oben.
  queueWriteChains.set(contactId, run.catch(() => {}));
  return run;
}

// Duenner Wrapper (siehe "M1" oben) - serialisiert die komplette Queue-
// Verarbeitung gegen jeden gleichzeitigen queueOffline()-Aufruf FUER
// DENSELBEN KONTAKT. Ohne das konnte eine Nachricht, die genau waehrend
// eines laufenden Flush neu eingereiht wurde, durch dessen abschliessendes
// Zurueckschreiben von `remaining` wieder verschwinden.
// (Aus App.tsx hierher verschoben - das Gegenstueck queueOffline(), das die
// Eintraege schreibt, steht weiter unten. Format-Vertrag zwischen beiden:
// siehe Kommentar dort.)
export async function flushQueue(contactId, rtc) {
  return withQueueLock(contactId, () => flushQueueInner(contactId, rtc));
}

// ─── Zustell-Garantie: Warteschlange nach dem Outbox-Prinzip (2026-10) ──────
// Vorher: Text blieb bis zur Empfangsbestaetigung stehen, Bild/Audio/Datei und
// Steuersignale wurden direkt nach dataChannel.send() geloescht, und der
// Live-Sendeweg der UI lief ganz an der Warteschlange vorbei (10-s-Timeout,
// danach erst einreihen). Ein Kanal, der beim Netzwechsel noch "open" meldet,
// aber tot ist, oder ein App-Ende mitten im Senden verlor so Nachrichten.
//
// Jetzt gilt fuer JEDE ausgehende Nachricht mit msgId (Text/Standort, Bild,
// Sprachnachricht, Datei, clear_chat/delete_message/delete_chat/
// secret_start/secret_end):
//   1. write-ahead: ZUERST verschluesselt eingereiht (sendViaOutbox ->
//      queueOffline), erst dann - falls verbunden - gesendet (flushQueue).
//   2. Entfernt wird ein Eintrag erst, wenn die Gegenseite den Empfang
//      bestaetigt ('receipt' delivered, onQueueReceipt). Medien bestaetigt
//      die Gegenseite erst nach vollstaendigem Zusammensetzen (RTCStore.js).
//   3. Ohne Bestaetigung: erneut senden bei JEDER neuen Verbindung (sofort)
//      und auf derselben Verbindung nach Ablauf der Wartezeit - die waechst
//      pro Versuch (Backoff bis RETRY_BACKOFF_MAX_MS), keine Schleife im
//      Sekundentakt.
//   4. Der Empfaenger verwirft Wiederholungen (gleiche msgId/ackId, auch nach
//      einem Neustart) und bestaetigt sie trotzdem.
// UI-Status: 🕐 'pending' = eingereiht/nicht uebergeben, ✓ 'sent' = an einen
// offenen Kanal uebergeben, ✓✓ 'delivered' = Gegenseite hat bestaetigt.
//
// Rueckwaertskompatibilitaet: aeltere App-Versionen bestaetigen nur Text,
// keine Medien/Steuersignale, und verwerfen keine Medien-Duplikate. Ob die
// Gegenseite bestaetigt, meldet sie im profile_name (caps, RTCStore.
// getPeerCaps). Bei 'old'/'unknown' gilt ein Medium/Steuersignal nach EINER
// Uebergabe ueber eine nachweislich lebende Verbindung (nach dem Senden kam
// noch etwas von der Gegenseite an) als gesendet (✓) und wird entfernt - wie
// bisher, ohne Duplikate beim alten Empfaenger. Text nach
// LEGACY_TEXT_MAX_LIVE_ATTEMPTS solchen Versuchen.
const QUEUE_ACK_WAIT_MS = 20000;
const ACK_WAIT_PER_MB_MS = 4000;          // Medien: Zeit zum Zusammensetzen/Ablegen
const ACK_WAIT_MAX_MS = 3 * 60 * 1000;
const RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;
const LEGACY_TEXT_MAX_LIVE_ATTEMPTS = 3;
const MEDIA_TYPES = new Set(['image', 'audio', 'file']);

export function ackWaitFor(item) {
  const mb = (Number(item?.size) || 0) / (1024 * 1024);
  return Math.min(ACK_WAIT_MAX_MS, QUEUE_ACK_WAIT_MS + Math.ceil(mb * ACK_WAIT_PER_MB_MS));
}
function waitAfterAttempt(item) {
  const n = Math.max(0, (item.attempts || 1) - 1);
  return Math.min(Math.max(RETRY_BACKOFF_MAX_MS, ackWaitFor(item)), ackWaitFor(item) * Math.pow(2, n));
}

// Nur im Speicher: auf welcher Verbindung ein Eintrag zuletzt uebergeben wurde
// und bis wann auf dessen Bestaetigung gewartet wird. Nach einem Neustart
// leer - dann wird beim ersten Verbindungsaufbau einfach erneut gesendet.
const sendRecords = new Map();   // contactId|msgId -> { rtc, sentAt, waitUntil }
const recKey = (contactId, msgId) => contactId + '|' + msgId;
function dropRecordsFor(contactId) {
  for (const k of [...sendRecords.keys()]) if (k.startsWith(contactId + '|')) sendRecords.delete(k);
}

// Weckt die Warteschlange, sobald die naechste Bestaetigungsfrist ablaeuft.
const outboxTimers = new Map();  // contactId -> { at, t }
function scheduleOutboxWake(contactId, at) {
  const cur = outboxTimers.get(contactId);
  if (cur && cur.at <= at) return;
  if (cur) clearTimeout(cur.t);
  const t = setTimeout(() => {
    outboxTimers.delete(contactId);
    flushQueue(contactId, RTCStore.connections.get(contactId) || null).catch(() => {});
  }, Math.max(0, at - Date.now()) + 250);
  t?.unref?.();
  outboxTimers.set(contactId, { at, t });
}
function clearOutboxWake(contactId) {
  const cur = outboxTimers.get(contactId);
  if (cur) clearTimeout(cur.t);
  outboxTimers.delete(contactId);
}

export function _resetOutboxForTests() {
  sendRecords.clear();
  for (const id of [...outboxTimers.keys()]) clearOutboxWake(id);
  for (const t of chatStatusTimers.values()) clearTimeout(t);
  chatStatusTimers.clear();
  pendingChatStatus.clear();
}
export function _outboxRecordForTests(contactId, msgId) {
  return sendRecords.get(recKey(contactId, msgId)) || null;
}

async function readQueue(contactId) {
  const raw = await EncryptedStorage.getItem('queue_' + contactId).catch(() => null);
  if (!raw) return null;
  try {
    const q = JSON.parse(raw);
    return Array.isArray(q) ? q : null;
  } catch { return null; }
}
async function writeQueue(contactId, queue) {
  if (queue.length) await EncryptedStorage.setItem('queue_' + contactId, JSON.stringify(queue));
  else await EncryptedStorage.removeItem('queue_' + contactId);
}

// ─── Warteschlange im Ruhezustand (Double Ratchet, 2026-10) ─────────────────
// Ein Eintrag wird erst beim TATSAECHLICHEN Senden fuer die Gegenseite
// verschluesselt (sendQueueItem -> sealForConnection; bei Ratchet-Kontakten
// mit dem dann aktuellen Nachrichtenschluessel, bei jeder Wiederholung neu).
// Bis dahin liegt er mit einem zufaelligen, nur lokalen Schluessel pro
// Eintrag verschluesselt (k im Index, der selbst in EncryptedStorage liegt) -
// wie die Empfangs-Ablage (RTCStore.js). Vorher stand hier das Verbindungs-
// Secret selbst im Index (secretUsed): es blieb damit so lange erhalten wie
// der aelteste Eintrag und haette mitgeschnittene Verbindungen nachtraeglich
// lesbar gemacht.
const QUEUE_PURPOSE = 'queue';

async function sealAtRest(payload) {
  const k = await randomKeyB64(32);
  const enc = await encryptMsg(JSON.stringify(payload), k, QUEUE_PURPOSE);
  if (!enc) throw new Error('Verschluesselung fehlgeschlagen');
  return { k, enc };
}

async function readQueuePayload(item, rtc) {
  const blob = await RNFS.readFile(item.path, 'utf8');
  let plain = null;
  if (item.k) {
    plain = decryptMsg(blob, item.k, QUEUE_PURPOSE);
  } else {
    // Altbestand: mit dem Secret, das beim Einreihen aktiv war (bzw. - noch
    // aelter - dem der aktuellen Verbindung).
    const legacy = item.secretUsed || rtc?.sharedSecret;
    if (legacy) plain = decryptMsg(blob, legacy);
  }
  if (!plain) throw new Error('Entschluesselung fehlgeschlagen');
  return JSON.parse(plain);
}

// Stellt Altbestand-Eintraege (ohne k) auf einen lokalen Schluessel um: neue
// Datei schreiben, Eintrag umbiegen (k statt secretUsed). Die ALTEN Dateien
// loescht der Aufrufer erst, nachdem der Index gespeichert ist - stirbt die
// App dazwischen, zeigt der gespeicherte Index noch auf die alte, lesbare
// Datei. Liefert [{ oldPath, newPath }]. Nicht lesbare Eintraege bleiben
// unveraendert (z.B. ganz alte ohne secretUsed, solange keine Verbindung steht).
async function migrateQueueItems(queue, rtc) {
  const migrated = [];
  for (const item of queue) {
    if (!item || !item.encrypted || item.k || !item.path) continue;
    if (!item.secretUsed && !rtc?.sharedSecret) continue;
    try {
      const payload = await readQueuePayload(item, rtc);
      const { k, enc } = await sealAtRest(payload);
      const newPath = item.path.replace(/\.enc$/, '') + '_l.enc';
      await RNFS.writeFile(newPath, enc, 'utf8');
      migrated.push({ oldPath: item.path, newPath });
      item.path = newPath;
      item.k = k;
      item.v = 2;
      delete item.secretUsed;
    } catch {}
  }
  if (migrated.length) console.log('[Queue] Altbestand auf lokale Speicherschluessel umgestellt:', migrated.length);
  return migrated;
}

// Beim Start (loadPreviousSecret): Altbestand eines Kontakts sofort umstellen,
// damit kein Verbindungs-Secret im Warteschlangen-Index liegen bleibt.
export function migrateQueueAtRest(contactId) {
  return withQueueLock(contactId, async () => {
    const queue = await readQueue(contactId);
    if (!queue || !queue.some((i) => i && i.encrypted && !i.k && i.secretUsed)) return 0;
    const migrated = await migrateQueueItems(queue, null);
    if (!migrated.length) return 0;
    await writeQueue(contactId, queue);
    for (const m of migrated) await RNFS.unlink(m.oldPath).catch(() => {});
    return migrated.length;
  });
}

// Status einer eigenen Nachricht an den offenen Chat melden; ist er zu, im
// Puffer vormerken UND im gespeicherten Verlauf nachziehen (sonst stuende nach
// einem Neustart z.B. ein laengst zugestelltes ✓✓ als ✓ da).
const SEND_STATUS_FINAL = new Set(['delivered', 'read']);
export function mergeSendStatus(current, next) {
  if (current === 'read') return 'read';
  if (current === 'delivered') return next === 'read' ? 'read' : 'delivered';
  return next;
}
function notifyStatus(contactId, msgId, status) {
  const open = RTCStore.listeners.has(contactId);
  try { RTCStore.deliverLocal(contactId, { type: 'receipt', msgId, status }); } catch {}
  if (!open) queueChatStatus(contactId, msgId, status);
}

// Serialisiert Lese-Aendere-Schreibe-Zyklen auf 'chat_<id>' aus dem
// Hintergrund (Status-Nachtrag, clear_chat/delete_message ohne offenen Chat).
const chatWriteChains = new Map();
function withChatLock(contactId, fn) {
  const prev = chatWriteChains.get(contactId) || Promise.resolve();
  const run = prev.then(fn);
  chatWriteChains.set(contactId, run.catch(() => {}));
  return run;
}
// Status-Nachtraege gebuendelt schreiben - der Verlauf kann Medien enthalten,
// ein Schreibvorgang pro Haekchen waere bei einer langen Warteschlange teuer.
const pendingChatStatus = new Map();   // contactId -> Map(msgId -> status)
const chatStatusTimers = new Map();
function queueChatStatus(contactId, msgId, status) {
  let m = pendingChatStatus.get(contactId);
  if (!m) { m = new Map(); pendingChatStatus.set(contactId, m); }
  m.set(msgId, m.has(msgId) ? mergeSendStatus(m.get(msgId), status) : status);
  if (chatStatusTimers.has(contactId)) return;
  const t = setTimeout(() => {
    chatStatusTimers.delete(contactId);
    writeChatStatuses(contactId).catch(() => {});
  }, 400);
  t?.unref?.();
  chatStatusTimers.set(contactId, t);
}
export function flushChatStatusWrites(contactId) {
  const t = chatStatusTimers.get(contactId);
  if (t) clearTimeout(t);
  chatStatusTimers.delete(contactId);
  return writeChatStatuses(contactId);
}
async function writeChatStatuses(contactId) {
  const updates = pendingChatStatus.get(contactId);
  pendingChatStatus.delete(contactId);
  if (!updates || !updates.size) return withChatLock(contactId, async () => {});
  // Ueber den PIN-Tresor: entsperrt sofort, gesperrt versiegelt ins Journal
  // (eingearbeitet beim naechsten Lesen, siehe applyChatOps).
  return withChatLock(contactId, () => PinVault.update('chat_' + contactId, { op: 'status', u: [...updates] }).catch(() => {}));
}

// Zusammenfuehrung fuer 'chat_<id>' (PIN-Tresor-Journal und direkte
// Aenderungen): Haekchen nachtragen, Nachrichten loeschen. Idempotent - ein
// Eintrag darf mehrfach angewendet werden.
export async function applyChatOps(value, ops, key) {
  let list = [];
  if (value) {
    try { list = JSON.parse(value); } catch { return value; }
    if (!Array.isArray(list)) return value;
  }
  const contactId = String(key).slice('chat_'.length);
  let changed = false;
  for (const op of ops || []) {
    if (op?.op === 'status' && Array.isArray(op.u)) {
      const updates = new Map(op.u);
      list = list.map((m) => {
        if (!m || !m.mine || !updates.has(m.id)) return m;
        const st = mergeSendStatus(m.status, updates.get(m.id));
        if (st === m.status) return m;
        changed = true;
        return { ...m, status: st };
      });
    } else if (op?.op === 'delete' && op.id) {
      const same = (m) => m && m.id != null && String(m.id) === String(op.id);
      const hit = list.filter(same);
      if (!hit.length) continue;
      list = list.filter((m) => !same(m));
      changed = true;
      // Audit G1: Datei des geloeschten Mediums gleich mit entfernen.
      for (const m of hit) if (typeof m.mref === 'string') await removeMedia(contactId, m.mref);
    } else if (op?.op === 'expire' && Number.isFinite(op.now)) {
      const gone = list.filter((m) => isExpiredEntry(m, op.now));
      if (!gone.length) continue;
      list = list.filter((m) => !isExpiredEntry(m, op.now));
      changed = true;
      for (const m of gone) if (typeof m.mref === 'string') await removeMedia(contactId, m.mref);
    }
  }
  return changed ? JSON.stringify(list) : value;
}
PinVault.registerMerger('chat_', applyChatOps);

// Gleiche Regel wie beim Laden/Speichern in ChatScreen (App.tsx).
function isExpiredEntry(m, now) {
  if (!m || !m.expireAt) return false;
  return m.expireAt === 'read' || !(m.expireAt > now);
}

// Abgelaufene Timer-Nachrichten verschwanden bisher erst beim naechsten
// Oeffnen des Chats aus dem gespeicherten Verlauf - wer den Chat danach nie
// mehr oeffnete, behielt sie (im Tresor, mit der PIN lesbar) auf dem Geraet.
// Laeuft nach jedem Entsperren (App.tsx, afterVaultUnlock) ueber alle Chats.
export async function sweepExpiredChats(now = Date.now()) {
  let contacts = [];
  try { contacts = JSON.parse((await AsyncStorage.getItem('contacts')) || '[]'); } catch {}
  if (!Array.isArray(contacts)) return;
  for (const c of contacts) {
    if (!c?.id) continue;
    await withChatLock(c.id, () => PinVault.update('chat_' + c.id, { op: 'expire', now }))
      .catch((e) => console.warn('[Timer] Verlauf nicht bereinigt:', e?.code || e?.message || e));
  }
}

export async function onQueueReceipt(contactId, msgId) {
  let removed = null;
  await withQueueLock(contactId, async () => {
    sendRecords.delete(recKey(contactId, msgId));
    const queue = await readQueue(contactId);
    if (!queue) return;
    const hit = queue.find(i => i && i.msgId === msgId);
    if (!hit) return;
    if (hit.path) await RNFS.unlink(hit.path).catch(() => {});
    await writeQueue(contactId, queue.filter(i => i !== hit));
    removed = hit;
    console.log('[Queue] ✅ Empfang bestaetigt, aus Warteschlange entfernt:', msgId);
  });
  // Gruppen-Nachricht (GroupMessaging.js): Haekchen im Gruppenverlauf, nicht
  // im 1:1-Chat dieses Kontakts.
  if (isGroupAckId(msgId)) {
    await onGroupReceipt(contactId, msgId).catch(() => {});
    return;
  }
  // Die Haekchen-Anzeige im offenen Chat erledigt RTCStore (Receipt wird
  // dorthin weitergereicht) - bei geschlossenem Chat hier nachziehen.
  if (!RTCStore.listeners.has(contactId)) queueChatStatus(contactId, msgId, 'delivered');
  if (removed?.subtype === 'delete_chat') {
    // Siehe requestContactDeletion(): Loesch-Hinweis nachweislich angekommen.
    console.log('[Queue] ✅ Loesch-Hinweis bestaetigt - Kontakt wird entfernt');
    removeContactLocally(contactId);
  }
}
RTCStore.receiptHandler = (contactId, msgId) => { onQueueReceipt(contactId, msgId).catch(() => {}); };

function connectionIsFresh(rtc) {
  const window = rtc?.transport === 'tor' ? 12000 : 5000;
  return Date.now() - (rtc?._lastActivity || 0) <= window;
}

function channelUsable(rtc) {
  return !!(rtc && !rtc._closed && rtc.sharedSecret && rtc.dataChannel?.readyState === 'open');
}

// Eigentliches Senden eines Eintrags. Wirft, wenn der Kanal unterwegs zugeht
// oder ein Medium nicht vollstaendig hinausging - der Eintrag bleibt dann
// unveraendert fuer den naechsten Versuch stehen.
async function sendQueueItem(item, payload, rtc) {
  const send = (raw) => {
    if (rtc._closed || rtc.dataChannel?.readyState !== 'open') throw new Error('DataChannel nicht offen');
    rtc.dataChannel.send(raw);
  };
  // Double Ratchet: Medien mit eigenem Dateischluessel, der im Ratchet-
  // verschluesselten End-Marker reist (MediaKey.js) - bei jedem Versuch ein
  // neuer. Ohne Ratchet-Sitzung (aeltere Gegenseite) wie bisher.
  const sealer = MEDIA_TYPES.has(item.type) ? await mediaSealerFor(rtc) : null;
  if (item.type === 'image') {
    const id = await sendEncryptedImage(payload.base64, payload.mimeType, rtc.sharedSecret, send, { msgId: item.msgId, sealer, secret: !!item.ephemeral });
    if (!id) throw new Error('Bild-Uebertragung abgebrochen');
    console.log('[Queue] Bild uebergeben:', item.msgId);
  } else if (item.type === 'audio') {
    const id = await sendEncryptedAudio(payload.base64, rtc.sharedSecret, send, payload.durationMs, payload.viewOnce, { msgId: item.msgId, sealer, secret: !!item.ephemeral, wave: payload.wave });
    if (!id) throw new Error('Audio-Uebertragung abgebrochen');
    console.log('[Queue] Audio uebergeben:', item.msgId);
  } else if (item.type === 'file') {
    const id = await sendEncryptedFile(payload.base64, payload.fileName, payload.mimeType, rtc.sharedSecret, send, { msgId: item.msgId, sealer, secret: !!item.ephemeral });
    if (!id) throw new Error('Datei-Uebertragung abgebrochen');
    console.log('[Queue] Datei uebergeben:', item.msgId);
  } else if (item.type === 'text' || item.type === 'system') {
    // War ein echter Bug (Live-Test entdeckt: clear_chat kam nie beim
    // Empfaenger an): schickte den entschluesselten Klartext bisher roh
    // und ungewrappt ueber den DataChannel. Jetzt identisch zum Live-Pfad
    // (WebRTCManager.js sendMessage()): verschluesseln+polstern, dann senden.
    let out = payload;
    if (item.type === 'text') {
      // Review-Fund 2026-09-27 ("H1"): payload.time ist der Zeitpunkt des
      // Verfassens - lag der Kontakt laenger als 15 Minuten offline, verwirft
      // die Frische-Pruefung beim Empfaenger (isFreshTimestamp) die Nachricht
      // als moeglichen Replay. Bei jedem Zustellversuch neu stempeln. Nur fuer
      // 'text' - 'system'-Pakete haben ihre eigene, sequenzbewusste Pruefung
      // (isNewerThanLastAcceptedSystemTs) und behalten ihren echten ts.
      out = { ...payload, time: Date.now() };
    } else {
      // Zustell-Schluessel fuer Steuersignale (msgId bedeutet bei
      // delete_message bereits "die zu loeschende Nachricht").
      out = { ...payload, ackId: item.msgId };
    }
    // Erst JETZT (beim tatsaechlichen Senden) verschluesseln - bei Ratchet-
    // Kontakten mit dem naechsten Nachrichtenschluessel; jede Wiederholung
    // bekommt so einen neuen (der Empfaenger dedupliziert nach msgId/ackId).
    const wire = await sealForConnection(rtc, out);
    if (!wire) throw new Error('Verschluesselung fehlgeschlagen');
    send(wire);
    console.log('[Queue] Nachricht uebergeben:', item.msgId);
  } else {
    throw new Error('Unbekannter Eintragstyp');
  }
}

// Wird bei jeder frischen Verbindung (rtc._onReady), nach jedem neuen
// Eintrag (sendViaOutbox) und bei Ablauf einer Bestaetigungsfrist
// (scheduleOutboxWake, dann ggf. mit rtc = null) aufgerufen.
async function flushQueueInner(contactId, rtc) {
  const queue = await readQueue(contactId);
  if (!queue || queue.length === 0) return;
  // Altbestand (mit einem Verbindungs-Secret verschluesselt) auf lokale
  // Speicherschluessel umstellen, siehe migrateQueueItems().
  const migrated = await migrateQueueItems(queue, rtc);
  const usable = channelUsable(rtc);
  const caps = RTCStore.getPeerCaps(contactId);
  const remaining = [];
  const statusUpdates = [];
  const silent = new Set();
  const dispatchStatus = () => {
    for (const [id, st] of statusUpdates) if (!silent.has(id)) notifyStatus(contactId, id, st);
  };
  let dirty = false;
  let deleteChatDone = false;
  let stopSending = false;
  let nextWake = Infinity;
  for (const item of queue) {
    if (!item || !item.encrypted) {
      // Alter, unverschluesselter Eintrag von vor dem Fix - verwerfen.
      if (item?.path) await RNFS.unlink(item.path).catch(() => {});
      dirty = true;
      continue;
    }
    const now = Date.now();
    const rk = recKey(contactId, item.msgId);
    if (item.expiresAt && item.expiresAt <= now) {
      // Secret Chat inzwischen abgelaufen - darf nicht mehr zugestellt werden.
      console.log('[Queue] Secret-Chat-Nachricht abgelaufen, verworfen:', item.msgId);
      await RNFS.unlink(item.path).catch(() => {});
      sendRecords.delete(rk);
      dirty = true;
      continue;
    }
    let decided = false;
    const rec = sendRecords.get(rk);
    const showsStatus = item.type !== 'system'; // Steuersignale haben keine Blase
    if (!showsStatus) silent.add(item.msgId);
    if (rec) {
      if (now < rec.waitUntil && (rec.rtc === rtc || !usable)) {
        // Auf genau dieser Verbindung uebergeben (bzw. keine andere nutzbare
        // da), Bestaetigung steht noch aus.
        remaining.push(item);
        nextWake = Math.min(nextWake, rec.waitUntil);
        if (item.subtype === 'delete_chat') stopSending = true;
        continue;
      }
      // Frist abgelaufen oder inzwischen eine neue Verbindung: keine
      // Bestaetigung. Lebte die alte Verbindung nach dem Senden noch
      // (danach kam noch etwas an), war die Uebergabe echt.
      sendRecords.delete(rk);
      decided = true;
      dirty = true;
      const live = (rec.rtc?._lastActivity || 0) > rec.sentAt;
      if (live) item.liveAttempts = (item.liveAttempts || 0) + 1;
      if (caps !== 'new' && live
          && (item.type !== 'text' || item.liveAttempts >= LEGACY_TEXT_MAX_LIVE_ATTEMPTS)) {
        console.log('[Queue] Gegenseite bestaetigt nicht (aeltere App-Version) - nach Uebergabe ueber lebende Verbindung als gesendet gewertet:', item.msgId);
        await RNFS.unlink(item.path).catch(() => {});
        statusUpdates.push([item.msgId, 'sent']);
        if (item.subtype === 'delete_chat') deleteChatDone = true;
        continue;
      }
    }
    if (stopSending || !usable) {
      if (decided) statusUpdates.push([item.msgId, 'pending']);
      remaining.push(item);
      continue;
    }
    let payload;
    try {
      // Lokaler Speicherschluessel des Eintrags (siehe queueOffline()); nur
      // noch nicht umgestellter Altbestand faellt auf secretUsed bzw.
      // rtc.sharedSecret zurueck.
      payload = await readQueuePayload(item, rtc);
    } catch (e) {
      console.warn('[Queue] Eintrag nicht lesbar/entschluesselbar, bleibt fuer spaeter');
      if (decided) statusUpdates.push([item.msgId, 'pending']);
      remaining.push(item);
      continue;
    }
    // Audit 2026-09-28: Medien nur ueber eine Verbindung, die gerade
    // nachweislich Daten liefert - ein grosses Medium in einen toten Kanal zu
    // schieben kostet nur Zeit. (Die Bestaetigung oben ist die eigentliche
    // Absicherung.)
    if (MEDIA_TYPES.has(item.type) && !connectionIsFresh(rtc)) {
      if (decided) statusUpdates.push([item.msgId, 'pending']);
      remaining.push(item);
      // Gleich noch einmal pruefen (Fuellverkehr der Gegenseite kommt alle
      // 2-5 s) - sonst bliebe das Medium bis zum naechsten Anlass liegen.
      nextWake = Math.min(nextWake, Date.now() + 5000);
      continue;
    }
    try {
      await sendQueueItem(item, payload, rtc);
    } catch (e) {
      console.warn('[Queue] Senden fehlgeschlagen, bleibt fuer den naechsten Versuch');
      if (decided) statusUpdates.push([item.msgId, 'pending']);
      remaining.push(item);
      continue;
    }
    const sentAt = Date.now();
    item.attempts = (item.attempts || 0) + 1;
    item.sentAt = sentAt;
    const waitUntil = sentAt + waitAfterAttempt(item);
    sendRecords.set(rk, { rtc, sentAt, waitUntil });
    nextWake = Math.min(nextWake, waitUntil);
    dirty = true;
    remaining.push(item);
    // UI: ✓ (uebergeben) - das ✓✓ kommt erst mit der Bestaetigung.
    if (showsStatus) notifyStatus(contactId, item.msgId, 'sent');
    // Nach einem Loesch-Hinweis nichts mehr hinterherschicken.
    if (item.subtype === 'delete_chat') stopSending = true;
  }
  if (deleteChatDone) {
    // Aeltere Gegenseite: Loesch-Hinweis gilt als zugestellt - Kontakt samt
    // Warteschlange entfernen (raeumt auch alle uebrigen Eintraege ab).
    console.log('[Queue] ✅ Loesch-Hinweis zugestellt - Kontakt wird entfernt');
    for (const m of migrated) await RNFS.unlink(m.newPath).catch(() => {});
    removeContactLocally(contactId);
    return;
  }
  if (dirty || migrated.length) await writeQueue(contactId, remaining);
  // Erst nachdem der Index auf die neuen Dateien zeigt, die alten loeschen.
  for (const m of migrated) await RNFS.unlink(m.oldPath).catch(() => {});
  dispatchStatus();
  if (nextWake !== Infinity) scheduleOutboxWake(contactId, nextWake);
  if (remaining.length) console.log('[Queue] Verarbeitet -', remaining.length, 'Eintrag/Eintraege warten noch auf Bestaetigung bzw. Verbindung');
}

// UI-Sendeweg (write-ahead): verschluesselt einreihen, onQueued(ok) melden
// (-> 🕐), dann sofort zustellen, falls eine nutzbare Verbindung steht.
// Liefert false, wenn nicht eingereiht werden konnte (kein Secret/Speicher).
export async function sendViaOutbox(contactId, type, payload, msgId, opts = {}) {
  let ok = false;
  if (contactId && msgId) {
    const secret = RTCStore.getSharedSecret(contactId)
      || await EncryptedStorage.getItem('shared_secret_' + contactId).catch(() => null);
    if (secret) ok = await queueOffline(contactId, type, payload, secret, msgId, opts);
    else console.warn('[Queue] Kein Shared Secret - Nachricht kann nicht sicher gesendet werden');
  }
  try { opts.onQueued?.(ok); } catch {}
  if (ok) kickOutbox(contactId);
  return ok;
}

// Zustellung anstossen, wenn eine Verbindung mit fertigem Schluesseltausch
// steht (sonst uebernimmt das rtc._onReady der naechsten Verbindung).
export function kickOutbox(contactId) {
  const rtc = RTCStore.connections.get(contactId);
  if (!rtc || !rtc.sharedSecret || rtc.keyExchangeDone === false || !RTCStore.isConnected(contactId)) return false;
  flushQueue(contactId, rtc).catch(() => {});
  return true;
}

// Entfernt Eintraege, auf die `predicate(item)` zutrifft, samt Datei.
export async function dropFromQueue(contactId, predicate) {
  return withQueueLock(contactId, async () => {
    const queue = await readQueue(contactId);
    if (!queue) return 0;
    const keep = [];
    for (const item of queue) {
      if (item && predicate(item)) {
        if (item.path) await RNFS.unlink(item.path).catch(() => {});
        sendRecords.delete(recKey(contactId, item.msgId));
      } else keep.push(item);
    }
    if (keep.length !== queue.length) await writeQueue(contactId, keep);
    return queue.length - keep.length;
  });
}

// Secret Chat beendet/abgelaufen: noch nicht zugestellte Secret-Nachrichten
// duerfen nicht nachtraeglich ankommen.
export function dropEphemeralFromQueue(contactId) {
  // Double Ratchet: auch gespeicherte Schluessel noch nicht angekommener
  // Nachrichten verwerfen - aus dem Secret Chat bleibt nichts entschluesselbar
  // liegen ("keine persistenten Nachrichtenschluessel").
  RatchetSession.purgeSkippedKeys(contactId);
  return dropFromQueue(contactId, (i) => !!i.ephemeral);
}
RTCStore.secretEndedHandler = (contactId) => { dropEphemeralFromQueue(contactId).catch(() => {}); };

// "Chat leeren": noch nicht zugestellte Inhalte gehoeren zum geleerten
// Verlauf und werden nicht mehr zugestellt (Steuersignale bleiben).
export function dropQueuedContent(contactId) {
  return dropFromQueue(contactId, (i) => i.type !== 'system');
}

// Zeitstempel-Frische-Pruefung fuer den Replay-Schutz auf relay-vermittelten
// Nachrichten (Sicherheitsreview 4). Vorher liess sich die Pruefung
// `Date.now() - ts > 15min` mit einem weit in der Zukunft liegenden ts (z.B.
// Infinity) dauerhaft umgehen - Date.now()-ts wurde dann nie > 15min gross,
// die Nachricht galt fuer immer als "frisch" statt als verworfen. Jetzt
// zusaetzlich: ts muss eine endliche Zahl sein und darf hoechstens 5 Minuten
// in der Zukunft liegen (Toleranz fuer echten Geraete-Uhr-Drift, bewusst klar
// kleiner als das 15-Minuten-Fenster, damit sie es nicht wirksam verlaengert).
// (Aus App.tsx hierher verschoben, unveraendert - einziger Aufrufer war
// checkIncoming.)
export function isFreshTimestamp(ts) {
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  if (age > 15 * 60 * 1000) return false;
  if (age < -5 * 60 * 1000) return false;
  return true;
}

// Sequenz-bewusster Replay-Schutz fuer System-Kontrollpakete (State-Machine-
// Review Fund 4) - zusaetzlich zu isFreshTimestamp() oben, das nur das Alter
// prueft, nicht die Reihenfolge. Merkt pro Kontakt den Zeitstempel des
// zuletzt akzeptierten Pakets; ein Paket mit gleichem oder aelterem ts wird
// verworfen, selbst wenn es fuer sich genommen noch innerhalb der 15-Minuten-
// Frische-Grenze liegt. Ohne das koennte ein aufgezeichnetes secret_start
// nach einem legitimen secret_end erneut eingespielt werden und einen
// bereits beendeten Secret Chat unbemerkt reaktivieren.
//
// Bewusst kein Mutex ueber gleichzeitige checkIncoming-Durchlaeufe fuer
// denselben Kontakt (waere ein groesserer Eingriff in eine bestehende,
// vielfach genutzte Poll-Schleife) - das verbleibende Zeitfenster ist eng
// (ein einzelner Poll-Zyklus) und erfordert zusaetzlich zum engen Fenster
// bereits eine einmal beobachtete, gueltig verschluesselte Chiffre.
// (Aus App.tsx hierher verschoben, unveraendert. Seit der Auslagerung teilen
// sich App-UI und Headless-Task zudem dieselbe incomingCycleRunning-Sperre
// weiter unten - ein gleichzeitiger Durchlauf beider Pfade ist damit
// ausgeschlossen, das beschriebene Zeitfenster also nicht groesser geworden.)
export async function isNewerThanLastAcceptedSystemTs(contactId, ts) {
  const key = 'system_ts_hwm_' + contactId;
  const stored = await AsyncStorage.getItem(key).catch(() => null);
  const lastTs = stored ? parseInt(stored, 10) : 0;
  if (!Number.isFinite(ts) || ts <= lastTs) return false;
  await AsyncStorage.setItem(key, String(ts)).catch(() => {});
  return true;
}

// Gemeinsame Tombstone-Logik fuer einen empfangenen device_wiped-Hinweis -
// vorher nur inline in checkIncoming's Relay-Fallback-Pfad dupliziert
// (Rot-Team-Review Fund 2: dieselbe Behandlung fehlte komplett im
// Live-P2P-Pfad in ChatScreen, siehe onWipe-Prop in App.tsx). Anders als
// delete_chat wird der Kontakt NICHT entfernt, sondern als "tombstoned"
// markiert (Nutzer-Fund 3: "chats verschwinden und man sieht nurnoch
// sowas wie Wiped Kontakt"). Chatverlauf UND Shared Secret werden
// geloescht - eine weitere Kommunikation ueber das alte Secret ist
// ohnehin nicht mehr sinnvoll moeglich, das Geraet auf der anderen Seite
// hat es selbst schon verloren.
//
// Aus App.tsx hierher verschoben (Stufe 2), damit ein im Headless-Task
// empfangenes device_wiped genauso vollstaendig (Storage + Secret +
// RTCStore) abgearbeitet wird wie in der App - das Paket ist nach der
// Verarbeitung beim Relay bestaetigt (ack) und kaeme nie wieder. App.tsx's
// wipeContactLocally() (ChatScreen onWipe) ruft diese Funktion mit
// setContacts als onContactsChanged auf.
//
// Review-Fund 2026-09-27 ("M3"): wipeContactLocally() (Duress-/Fernloeschungs-
// Pfad) loeschte bisher die lokale Sende-Warteschlange eines Kontakts gar
// nicht - deren Index enthielt (Altbestand: secretUsed, heute: der lokale
// Schluessel k, siehe queueOffline()) den Schluessel direkt neben dem Verweis
// auf die verschluesselte .enc-Datei, beides blieb nach einem "Wipe"
// unveraendert lesbar liegen.
// deleteContactCleanup() (App.tsx) loeschte zumindest den Index (die .enc-
// Dateien wurden dabei schon bisher nicht mitgeloescht, sind ohne Index aber
// unentschluesselbar und damit unkritisch) - wipeQueueForContact() raeumt
// zusaetzlich die Dateien selbst mit, fuer beide Aufrufer gemeinsam (App.tsx
// importiert es fuer deleteContactCleanup()).
export async function wipeQueueForContact(contactId) {
  // Unter der Warteschlangen-Sperre, damit ein gerade laufender Flush seine
  // Eintraege danach nicht wieder zurueckschreibt (Aufrufer innerhalb der
  // Sperre - flushQueueInner -> removeContactLocally - warten nicht darauf).
  dropRecordsFor(contactId);
  clearOutboxWake(contactId);
  return withQueueLock(contactId, async () => {
    try {
      const queueRaw = await EncryptedStorage.getItem('queue_' + contactId);
      if (queueRaw) {
        const queue = JSON.parse(queueRaw);
        if (Array.isArray(queue)) {
          await Promise.all(queue.map(item => item?.path ? RNFS.unlink(item.path).catch(() => {}) : null));
        }
      }
    } catch {}
    await EncryptedStorage.removeItem('queue_' + contactId).catch(() => {});
    dropRecordsFor(contactId);
  });
}

// Audit 2026-10-19 (P14): vom zurueckgesetzten Kontakt bleibt nur der Eintrag
// "Wiped Kontakt" - kein Name, kein Profilbild, keine Adressen/IDs mehr.
function wipedTombstone(x) {
  const { theirName, theirAvatar, torOnion, theirMyId, ...rest } = x;
  return { ...rest, wiped: true, name: t('contact.wipedName'), last: t('home.wiped.last'), unread: 0 };
}

export function wipeContactLocally(contactId, onContactsChanged = noop) {
  onContactsChanged(c => c.map(x => (x.id === contactId ? wipedTombstone(x) : x)));
  updateContacts(cs => cs.map(x => (x.id === contactId ? wipedTombstone(x) : x))).catch(() => {});
  PinVault.removeItem('chat_' + contactId).catch(() => {});
  removeMediaScope(contactId).catch(() => {});   // Audit G1
  EncryptedStorage.removeItem('timer_' + contactId).catch(() => {});
  EncryptedStorage.removeItem('secret_' + contactId).catch(() => {});
  EncryptedStorage.removeItem('shared_secret_' + contactId).catch(() => {});
  EncryptedStorage.removeItem('shared_secret_prev_' + contactId).catch(() => {});
  for (const prefix of ['secret_ended_', 'safety_code_seen_', 'avatar_hash_', 'system_ts_hwm_', 'timer_ts_', 'safety_v2_', 'conn_caps_']) {   // Audit P14
    EncryptedStorage.removeItem(prefix + contactId).catch(() => {});
  }
  wipeQueueForContact(contactId); // "M3"
  // Empfangs-Ablage, Dedup-Liste und Faehigkeiten (Zustell-Garantie) - VOR
  // clearContact(), siehe RTCStore.dropPersistedContactData().
  RTCStore.dropPersistedContactData(contactId).catch(() => {});
  // Gesamten In-Memory-Zustand fuer diesen Kontakt loeschen (schliesst auch
  // dessen Verbindung + raeumt gepufferte Klartexte/Chunks auf,
  // Secrets-Lifecycle-Review Fund S-3).
  RTCStore.clearContact(contactId);
}

// ─── Nur-P2P-Steuersignale (Produktentscheidung 2026-09-29) ─────────────────
// Vorher gingen "Chat geloescht", "Geraet zurueckgesetzt" und "Secret Chat
// gestartet/beendet" zusaetzlich (verschluesselt) ueber den Relay-Server
// (/packet), damit sie auch bei fehlender Verbindung ankamen. Vorgabe jetzt:
// Malachi ist ein reiner P2P-Messenger - auch diese Signale gehen nur noch
// ueber den direkten P2P-Kanal oder warten in der lokalen Sende-Warteschlange.
// Seit Okt. 2026 gibt es gar keinen Server mehr (auch keinen Empfangspfad
// fuer Pakete aelterer App-Versionen).

// Kontaktlisten-Setter der gemounteten App (setContacts), damit Aenderungen
// aus den Funktionen unten sofort in der UI sichtbar werden. Im Headless-Task
// bleibt es beim No-op - dort zaehlt nur der persistierte Stand.
let uiContactsListener = noop;
export function setUiContactsListener(fn) {
  uiContactsListener = typeof fn === 'function' ? fn : noop;
}

// Gruppenchats (GroupMessaging.js): Versand ueber dieselbe Warteschlange,
// dieselben serialisierten Schreibketten fuer 'groups'/'contacts' - fuer App
// UND Headless-Task, weil beide dieses Modul laden.
configureGroupMessaging({
  sendViaOutbox: (...a) => sendViaOutbox(...a),
  updateGroups: (m) => updateGroups(m),
  updateContacts: (m) => updateContacts(m),
  dropFromQueue: (id, p) => dropFromQueue(id, p),
  uiContacts: (u) => uiContactsListener(u),
  // Vorstellen ueber die Gruppe: Einladung erzeugen bzw. damit koppeln
  // (GroupIntroPairing.js - Tor, Kontaktanlage).
  introPairing: {
    createInvite: (info) => createIntroInvite(info),
    joinInvite: (info) => { joinIntroInvite(info).catch(() => {}); },
  },
});
configureGroupIntroPairing({
  updateContacts: (m) => updateContacts(m),
  uiContacts: (u) => uiContactsListener(u),
});
// Offene Vorstellungs-Einladungen nach einem Neustart wieder anmelden bzw.
// Beitritte fortsetzen (App und Headless-Task laden dieses Modul).
setTimeout(() => { resumeIntroPairings().catch(() => {}); }, 0);

// Lokale, verschluesselte Sende-Warteschlange (vorher nur in App.tsx) - hier,
// damit auch requestContactDeletion() (unten) sie benutzen kann. Format-
// Vertrag mit flushQueueInner(): {type, path, encrypted, msgId, k, v: 2}
// plus (Zustell-Garantie, alle optional) createdAt, attempts, liveAttempts,
// sentAt, size (Medien: Base64-Laenge, verlaengert die Bestaetigungsfrist),
// subtype (Steuersignale), ephemeral/expiresAt (Secret Chat - verfaellt mit
// dessen Ende). Inhalt nur verschluesselt in der .enc-Datei, mit dem lokalen
// Schluessel k des Eintrags (siehe "Warteschlange im Ruhezustand" oben); der
// Index liegt in EncryptedStorage. Altbestand traegt statt k noch secretUsed
// und wird beim naechsten Zugriff umgestellt (migrateQueueItems).
// secret: nur noch Voraussetzung (ohne Kontakt-Schluessel ist keine sichere
// Zustellung moeglich -> gar nicht erst einreihen), nicht mehr der Schluessel.
// meta: { ephemeral, expiresAt } (siehe sendViaOutbox).
export async function queueOffline(contactId, type, payload, secret, msgId, meta = {}) {
  if (!secret || !contactId || !msgId) return false;
  let path = null;
  try {
    const { k, enc } = await sealAtRest(payload);
    // Eigener Dateiname pro Eintrag: ein doppelter Aufruf fuer dieselbe
    // Nachricht darf die Datei des bestehenden Eintrags (anderer Schluessel)
    // nicht ueberschreiben.
    path = `${RNFS.DocumentDirectoryPath}/queue_${type}_${msgId}_${await secureRandomToken(6)}.enc`;
    await RNFS.writeFile(path, enc, 'utf8');
    const entry = { type, path, encrypted: true, v: 2, k, msgId, createdAt: Date.now(), attempts: 0 };
    if (MEDIA_TYPES.has(type) && typeof payload?.base64 === 'string') entry.size = payload.base64.length;
    if (type === 'system' && typeof payload?.subtype === 'string') entry.subtype = payload.subtype;
    if (meta?.ephemeral || payload?.secret) entry.ephemeral = true;
    if (Number.isFinite(meta?.expiresAt)) entry.expiresAt = meta.expiresAt;
    // Gruppenchats: Zuordnung im (verschluesselten) Index, damit beim
    // Verlassen/Loeschen einer Gruppe deren noch nicht zugestellte Texte
    // entfernt werden koennen (GroupMessaging.removeGroupData).
    if (typeof meta?.groupId === 'string' && meta.groupId.length <= 80) entry.groupId = meta.groupId;
    // Nur der Index-Lese-Schreibe-Zyklus muss serialisiert werden ("M1").
    let duplicate = false;
    await withQueueLock(contactId, async () => {
      const queueRaw = await EncryptedStorage.getItem('queue_' + contactId);
      const queue = queueRaw ? JSON.parse(queueRaw) : [];
      // Dieselbe Nachricht nie doppelt einreihen.
      if (queue.some(i => i && i.msgId === msgId && i.type === type)) { duplicate = true; return; }
      queue.push(entry);
      await EncryptedStorage.setItem('queue_' + contactId, JSON.stringify(queue));
    });
    if (duplicate) await RNFS.unlink(path).catch(() => {});
    return true;
  } catch (e) {
    console.warn('[Queue] Konnte nicht lokal zwischenspeichern:', e?.message || e);
    if (path) await RNFS.unlink(path).catch(() => {});
    return false;
  }
}

// Entfernt einen Kontakt samt ALLER lokalen Daten (Verlauf, Secrets,
// Warteschlange, In-Memory-Zustand). Benachrichtigt die Gegenseite NICHT -
// das ist Sache des Aufrufers (requestContactDeletion) bzw. entfaellt, wenn
// die Loeschung von der Gegenseite kam.
export function removeContactLocally(contactId) {
  uiContactsListener(c => c.filter(x => x.id !== contactId));
  updateContacts(cs => cs.filter(x => x.id !== contactId)).catch(() => {});
  for (const prefix of ['chat_', 'vj_chat_', 'timer_', 'timer_ts_', 'secret_', 'secret_ended_', 'shared_secret_', 'shared_secret_prev_', 'system_ts_hwm_', 'avatar_hash_', 'safety_code_seen_', 'safety_v2_', 'conn_caps_']) {
    EncryptedStorage.removeItem(prefix + contactId).catch(() => {});
  }
  removeMediaScope(contactId).catch(() => {});   // Audit G1: Verlaufs-Medien
  wipeQueueForContact(contactId);
  // Empfangs-Ablage/Dedup-Liste/Faehigkeiten - VOR clearContact().
  RTCStore.dropPersistedContactData(contactId).catch(() => {});
  RTCStore.clearContact(contactId);
}

// Loeschwunsch des Nutzers ("Chat loeschen"): der Chat verschwindet sofort aus
// der Liste und sein Verlauf wird geloescht. Damit auch die Gegenseite davon
// erfaehrt - ohne Server -, bleibt der Kontakt unsichtbar ("pendingDelete")
// mit seinem Secret bestehen, bis der Loesch-Hinweis bei der naechsten
// direkten Verbindung ueber die Warteschlange zugestellt UND von der
// Gegenseite bestaetigt wurde (onQueueReceipt; aeltere Gegenseite: nach
// Uebergabe ueber eine lebende Verbindung, flushQueueInner); danach wird
// er vollstaendig entfernt. Noch nicht zugestellte Nachrichten an diesen
// Kontakt werden dabei verworfen ("Chat loeschen" raeumt die Warteschlange).
// Kommt innerhalb von
// PENDING_DELETE_MAX_MS keine Verbindung mehr zustande, wird er trotzdem
// endgueltig entfernt (runIncomingCycle).
const PENDING_DELETE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export async function requestContactDeletion(contactId) {
  uiContactsListener(c => c.filter(x => x.id !== contactId));
  for (const prefix of ['chat_', 'vj_chat_', 'timer_', 'timer_ts_', 'secret_', 'secret_ended_']) {
    EncryptedStorage.removeItem(prefix + contactId).catch(() => {});
  }
  removeMediaScope(contactId).catch(() => {});   // Audit G1
  const secret = RTCStore.getSharedSecret(contactId)
    || await EncryptedStorage.getItem('shared_secret_' + contactId).catch(() => null);
  if (!secret) { removeContactLocally(contactId); return 'removed'; }
  await updateContacts(cs => cs.map(x => x.id === contactId
    ? { ...x, pendingDelete: true, pendingDeleteSince: Date.now(), last: '', unread: 0 }
    : x)).catch(() => {});
  await dropFromQueue(contactId, () => true).catch(() => {});
  const ts = Date.now();
  const queued = await queueOffline(contactId, 'system', { type: 'system', subtype: 'delete_chat', ts }, secret, 'delchat_' + ts);
  if (!queued) { removeContactLocally(contactId); return 'removed'; }
  // Steht gerade eine Verbindung, sofort zustellen statt bis zur naechsten zu warten.
  kickOutbox(contactId);
  // Sonst SOFORT eine aufbauen (ueber Tor) - die Warteschlange stellt den
  // Loesch-Hinweis zu, sobald sie steht. Live-Test 2026-10-18: ohne Verbindung
  // blieb der Chat bei der Gegenseite, bis zufaellig wieder eine entstand.
  if (!isUsable(contactId)) ensureConnection(contactId, { timeoutMs: 120000 }).catch(() => {});
  return 'pending';
}

// Zentrale Verarbeitung P2P-empfangener Steuersignale, wenn der zugehoerige
// Chat gerade NICHT offen ist (sonst erledigt das der ChatScreen-Listener).
// Vorher landeten sie in diesem Fall nur im Puffer und wirkten erst beim
// naechsten Oeffnen des Chats - ein geloeschter Kontakt blieb z.B. solange in
// der Liste stehen.
export async function applyControlSignal(contactId, msg) {
  const setContacts = uiContactsListener;
  switch (msg?.subtype) {
    case 'delete_chat':
      removeContactLocally(contactId);
      return true;
    case 'device_wiped':
      wipeContactLocally(contactId, setContacts);
      return true;
    case 'clear_chat':
      setContacts(c => c.map(x => x.id === contactId ? { ...x, last: '', unread: 0 } : x));
      updateContacts(cs => cs.map(x => x.id === contactId ? { ...x, last: '', unread: 0 } : x)).catch(() => {});
      await withChatLock(contactId, () => PinVault.removeItem('chat_' + contactId).catch(() => {}));
      await removeMediaScope(contactId).catch(() => {});   // Audit G1
      return true;
    case 'delete_message': {
      if (!msg.msgId) return false;
      // PIN-Tresor: bei gesperrter App versiegelt vorgemerkt (applyChatOps).
      await withChatLock(contactId, () => PinVault.update('chat_' + contactId, { op: 'delete', id: String(msg.msgId) }).catch(() => {}));
      return true;
    }
    case 'secret_start':
      if (!msg.mins) return false;
      // Aus der Warteschlange verspaetet zugestellt und laengst abgelaufen.
      if (msg.endsAt && msg.endsAt <= Date.now()) return true;
      await EncryptedStorage.setItem('secret_' + contactId, JSON.stringify({
        mins: msg.mins, endsAt: msg.endsAt || Date.now() + msg.mins * 60 * 1000,
      })).catch(() => {});
      return true;
    case 'secret_end':
      await EncryptedStorage.removeItem('secret_' + contactId).catch(() => {});
      await EncryptedStorage.setItem('secret_ended_' + contactId, 'true').catch(() => {});
      return true;
    case 'timer':
      if (!TIMER_MODES.has(msg.mode)) return false;
      await adoptPeerTimer(contactId, msg);
      return true;
    default:
      return false;
  }
}
RTCStore.controlSignalHandler = applyControlSignal;

// ─── Nachrichten-Timer eines Chats (gilt fuer beide Seiten) ─────────────────
// Fund 28.10.2026: Der Timer-Dialog schickte bis 1.2.0 ein secret_start ohne
// mins, das die Gegenseite verwarf - sie uebernahm den Timer nie, ihre
// Antworten blieben dauerhaft gespeichert. Jetzt eigenes Signal
// {subtype:'timer', mode, ts} ueber die Warteschlange. Aendern beide Seiten
// den Timer, bevor sie sich wieder erreichen, gewinnt der juengere ts
// (timer_ts_<id>) - sonst behielte jede Seite den Timer der anderen.
export const TIMER_MODES = new Set(['off', 'read', '1h', '24h', '7d']);
const timerChains = new Map();
function withTimerLock(contactId, fn) {
  const prev = timerChains.get(contactId) || Promise.resolve();
  const run = prev.then(fn);
  timerChains.set(contactId, run.catch(() => {}));
  return run;
}
async function lastTimerTs(contactId) {
  return Number(await EncryptedStorage.getItem('timer_ts_' + contactId).catch(() => null)) || 0;
}

// Eigene Aenderung speichern. Liefert den ts fuer das Signal - immer juenger
// als jede bisher uebernommene Aenderung, auch wenn die eigene Uhr nachgeht.
export function setOwnTimer(contactId, mode) {
  return withTimerLock(contactId, async () => {
    const ts = Math.max(Date.now(), (await lastTimerTs(contactId)) + 1);
    await EncryptedStorage.setItem('timer_' + contactId, mode);
    await EncryptedStorage.setItem('timer_ts_' + contactId, String(ts));
    return ts;
  });
}

// Timer der Gegenseite uebernehmen. Liefert den Modus oder null (ungueltig
// bzw. nicht juenger als die zuletzt gesetzte Aenderung).
export function adoptPeerTimer(contactId, msg) {
  if (!TIMER_MODES.has(msg?.mode) || !Number.isFinite(msg.ts)) return Promise.resolve(null);
  return withTimerLock(contactId, async () => {
    if (msg.ts <= await lastTimerTs(contactId)) return null;
    await EncryptedStorage.setItem('timer_' + contactId, msg.mode);
    await EncryptedStorage.setItem('timer_ts_' + contactId, String(msg.ts));
    return msg.mode;
  });
}

// Onion-Adresse eines Kontakts (kam ueber den verschluesselten, angemeldeten
// Kanal, siehe RTCStore) beim Kontakt speichern.
export function rememberContactOnion(contactId, onion) {
  if (typeof onion !== 'string' || !ONION_RE.test(onion)) return;
  updateContacts(cs => {
    if (!cs.some(c => c.id === contactId && c.torOnion !== onion)) return null;
    console.log('[Tor] Onion-Adresse eines Kontakts gespeichert');
    return cs.map(c => (c.id === contactId ? { ...c, torOnion: onion } : c));
  }).catch(() => {});
}
RTCStore.torAddressHandler = rememberContactOnion;
// Profilbild des Kontakts sofort dauerhaft speichern - auch bei geschlossenem
// Chat (vorher nur RAM-Puffer, nach App-Neustart verloren) - und erkennen,
// wenn es fehlt (dann fordert RTCStore es bei der Gegenseite an).
RTCStore.avatarReceivedHandler = (contactId, avatarUri) => {
  try { uiContactsListener(c => c.map(x => (x.id === contactId ? { ...x, theirAvatar: avatarUri } : x))); } catch {}
  updateContacts(cs => {
    if (!cs.some(c => c.id === contactId)) return null;
    return cs.map(c => c.id === contactId ? { ...c, theirAvatar: avatarUri } : c);
  }).catch(() => {});
};
RTCStore.avatarMissingCheck = async (contactId) => {
  const raw = await AsyncStorage.getItem('contacts').catch(() => null);
  let c = null;
  try { c = (raw ? JSON.parse(raw) : []).find(x => x && x.id === contactId) || null; } catch {}
  return !!c && !c.wiped && !c.theirAvatar;
};

// Nach dem Uebernehmen einer Reserve bzw. einer neuen Tor-Verbindung etwas
// warten, bevor der Wechsel auf direkt versucht wird (Onion-Adressen sind dann
// ausgetauscht, siehe RTCStore._onKeyExchange).
const UPGRADE_AFTER_TOR_READY_MS = 600;
const UPGRADE_AFTER_PROMOTION_MS = 4000;

configureTorTransport({
  flushQueue: (contactId, rtc) => flushQueue(contactId, rtc),
  onNetworkChange: () => handleLocalNetworkChange(),
  onDescriptorReceived: (onion) => kickAfterDescriptor(onion),
  onTorReadyAfterNetworkChange: () => {
    // Versuche, die vor "bereit" gestartet wurden, liefen ueber das noch tote
    // Tor und haengen bis zum Zeitlimit - verwerfen und sofort neu verbinden.
    netGeneration++;
    for (const t of torAttempts.values()) { t.running = false; t.nextAt = 0; t.backoff = TOR_RETRY_MIN_MS; }
    reconnectAllViaTorNow();
  },
  onReservePromoted: (contactId, rtc) => {
    notConnectedSince.delete(contactId);
    lastCycleOptions.onRtcConnected?.(contactId, rtc);
    // Laeuft jetzt (wieder) ueber Tor - spaeter erneut direkt versuchen.
    const t = setTimeout(() => maybeStartUpgrade(contactId, { reason: 'direkt-weg' }).catch(() => {}), UPGRADE_AFTER_PROMOTION_MS);
    t?.unref?.();
  },
});
configureDirectUpgrade({
  flushQueue: (contactId, rtc) => flushQueue(contactId, rtc),
  onPromoted: (contactId, rtc) => {
    notConnectedSince.delete(contactId);
    lastCycleOptions.onRtcConnected?.(contactId, rtc);
  },
  // Direktverbindung weg und keine Reserve: sofort ueber Tor neu verbinden -
  // auch als 'responder' ohne die sonstigen 5 s Vorlauf (Live-Test
  // 2026-10-17: so vergingen 14 s bis zum ersten Versuch). Doppelte Kanaele
  // loest TorTransport auf.
  onDirectLost: (contactId, promoted) => {
    if (!promoted) {
      const t = setTimeout(() => { forceNextCycle = true; runOutgoingCycle(lastCycleOptions); }, 300);
      t?.unref?.();
    }
  },
});
// Schluesseltausch einer neuen Tor-Verbindung fertig: Wechsel auf direkt
// anstossen (DirectUpgrade entscheidet, wer anbietet).
RTCStore.connectionReadyHandler = (contactId, rtc) => {
  if (rtc?.transport !== 'tor') return;
  const t = setTimeout(() => {
    if (RTCStore.connections.get(contactId) !== rtc) return;
    maybeStartUpgrade(contactId, { reason: 'tor-bereit' }).catch(() => {});
  }, UPGRADE_AFTER_TOR_READY_MS);
  t?.unref?.();
};
// Einstellungen einmal laden, damit isForceTorTestMode() auch im Headless-Task stimmt.
loadTorSettings().catch(() => {});
// Verbindungsweg ebenso frueh laden (die Entscheidungsstellen warten zwar
// selbst darauf, die synchrone Anzeige stimmt so aber sofort).
loadConnectionMode().catch(() => {});

// ─── Verbindungsaufbau: Tor zuerst, dann direkt ─────────────────────────────
// Ohne Server finden sich die Geraete nur ueber ihre Onion-Adressen. Jeder
// Kontakt ohne nutzbare Verbindung wird ueber Tor verbunden; steht die
// Tor-Verbindung, handelt DirectUpgrade.js darueber eine Direktverbindung aus,
// die Tor dann abloest (Tor bleibt Reserve).
// Fehlgeschlagene Tor-Versuche: haeufig erneut versuchen (max. 60 s Pause) -
// ausser die Gegenseite lehnt die Anmeldung ab (Kontakt dort geloescht oder neu
// gekoppelt): dann 5 min Ruhe, denn jede abgelehnte Anmeldung zaehlt dort als
// Fehlversuch und kann sie fuer ALLE Kontakte kurz sperren.
const TOR_RETRY_MIN_MS = 15000;
// Zusatzversuch, wenn der erste Tor-Aufbau so lange haengt (siehe maybeConnectViaTor).
const TOR_HEDGE_AFTER_MS = 12000;
let torHedgeAfterMs = TOR_HEDGE_AFTER_MS;
export function _setTorHedgeAfterForTests(ms) { torHedgeAfterMs = ms; }
const TOR_RETRY_MAX_MS = 60000;
const TOR_REJECTED_RETRY_MS = 5 * 60 * 1000;
// Beide Seiten bauen per Tor auf; die Seite mit Rolle 'responder' etwas
// spaeter, damit meist nur EIN Kanal entsteht (Doppelte loest TorTransport auf).
const TOR_RESPONDER_AFTER_MS = 5000;
const notConnectedSince = new Map();      // contactId -> ms
const torAttempts = new Map();           // contactId -> { running, nextAt, backoff }

export function isDirectConnected(contactId) {
  return RTCStore.isConnected(contactId) && RTCStore.connections.get(contactId)?.transport !== 'tor';
}
export function isTorConnected(contactId) {
  return RTCStore.isConnected(contactId) && RTCStore.connections.get(contactId)?.transport === 'tor';
}

// Nutzbar = verbunden UND Schluesseltausch fertig. Live-Test 2026-10-03: eine
// Direktverbindung meldete "ICE verbunden", der Schluesseltausch kam aber
// nie durch - weil sie als "verbunden" galt, sprang Tor nie ein.
function isUsable(contactId) {
  return RTCStore.isConnected(contactId) && RTCStore.connections.get(contactId)?.keyExchangeDone !== false;
}

export function shouldTryTor(contact, now = Date.now(), { force = false, ignoreRejected = false } = {}) {
  if (!contact || contact.wiped) return false;
  if (contact.role !== 'initiator' && contact.role !== 'responder') return false;
  if (!getOwnOnion() || !ONION_RE.test(contact.torOnion || '')) return false;
  if (isUsable(contact.id)) return false;
  const t = torAttempts.get(contact.id);
  if (t?.running) return false;
  if (!ignoreRejected && isRejectedNow(contact.id)) return false;
  if (force) return true;
  if (t && now < t.nextAt) return false;
  if (contact.role === 'responder') {
    const since = notConnectedSince.get(contact.id);
    return !!since && now - since >= TOR_RESPONDER_AFTER_MS;
  }
  return true;
}

// Kontakte, die unsere Anmeldung abgelehnt haben (dort geloescht oder neu
// gekoppelt): 5 min Ruhe - auch ueber Netzwechsel und Neustart hinweg. Live-
// Test 2026-10-17: veraltete Doppel-Kontakte wurden bei jedem Netzwechsel bis
// zu 12x abgelehnt; ab 10 Ablehnungen pro Minute sperrt die Gegenseite ALLE
// eingehenden Tor-Anmeldungen fuer eine Minute - auch die des echten Kontakts.
const REJECTED_KEY = 'tor_rejected_until';
const rejectedUntil = new Map();
let rejectedLoaded = null;
function loadRejected() {
  if (!rejectedLoaded) {
    rejectedLoaded = AsyncStorage.getItem(REJECTED_KEY).then((raw) => {
      const obj = raw ? JSON.parse(raw) : {};
      for (const [id, until] of Object.entries(obj)) {
        if (typeof until === 'number' && until > Date.now() && !rejectedUntil.has(id)) rejectedUntil.set(id, until);
      }
    }).catch(() => {});
  }
  return rejectedLoaded;
}
function persistRejected() {
  const obj = {};
  for (const [id, until] of rejectedUntil) if (until > Date.now()) obj[id] = until;
  AsyncStorage.setItem(REJECTED_KEY, JSON.stringify(obj)).catch(() => {});
}
function isRejectedNow(contactId) { return (rejectedUntil.get(contactId) || 0) > Date.now(); }
// "Veraltet" erst nach WIEDERHOLTER Ablehnung (Live-Test 2026-10-19: eine
// einzelne Ablehnung kann auch von der kurzen Sicherheitssperre der Gegenseite
// kommen - der echte Kontakt stand dann faelschlich als "veraltet" da).
const STALE_AFTER_REJECTIONS = 2;
const rejectionCount = new Map();
function markRejected(contactId) {
  rejectedUntil.set(contactId, Date.now() + TOR_REJECTED_RETRY_MS);
  persistRejected();
  const n = (rejectionCount.get(contactId) || 0) + 1;
  rejectionCount.set(contactId, n);
  if (n >= STALE_AFTER_REJECTIONS) setContactStale(contactId, true);
}
function clearRejected(contactId) {
  rejectionCount.delete(contactId);
  if (rejectedUntil.delete(contactId)) persistRejected();
  setContactStale(contactId, false);
}
// "Veraltet" in der Kontaktliste: die Gegenseite lehnt unsere Anmeldung ab
// (dort geloescht oder neu gekoppelt). Live-Test 2026-10-18: bei drei
// gleichnamigen Kontakten wurde beim Aufraeumen der ECHTE geloescht.
function setContactStale(contactId, stale) {
  try { uiContactsListener(c => c.map(x => (x.id === contactId && !!x.stale !== stale ? { ...x, stale } : x))); } catch {}
  updateContacts(cs => (cs.some(x => x.id === contactId && !!x.stale !== stale)
    ? cs.map(x => (x.id === contactId ? { ...x, stale } : x)) : null)).catch(() => {});
}

// Onion-Beschreibung eines Kontakts eingetroffen (TorTransport, nativ aus
// HS_DESC RECEIVED): laeuft gerade ein Versuch zu ihm, sofort einen frischen
// hinterher. Live-Test 2026-10-17: Versuche, die waehrend des Abrufs (frisches
// tor: 24 s) gestartet wurden, hingen bis zum Zeitlimit - ein danach
// gestarteter stand in 3 s.
const DESC_KICK_MIN_GAP_MS = 15000;
const descKickAt = new Map();
function kickAfterDescriptor(onion) {
  return AsyncStorage.getItem('contacts').then((raw) => {
    const cs = (raw ? JSON.parse(raw) : []).filter(c => c && !c.wiped && c.torOnion === onion && !['1','2','3'].includes(c.id));
    for (const contact of cs) {
      if (isUsable(contact.id) || isRejectedNow(contact.id)) continue;
      const t = torAttempts.get(contact.id);
      if (!t?.running) continue;
      if (Date.now() - (descKickAt.get(contact.id) || 0) < DESC_KICK_MIN_GAP_MS) continue;
      descKickAt.set(contact.id, Date.now());
      const gen = netGeneration;
      console.log('[Tor] Adressdaten von', contact.name, 'eingetroffen - frischer Versuch');
      connectViaTor(contact, {
        onConnected: (rtc) => {
          if (gen !== netGeneration) { try { rtc.close(); } catch {} return; }
          t.backoff = TOR_RETRY_MIN_MS;
          clearRejected(contact.id);
          lastCycleOptions.onRtcConnected?.(contact.id, rtc);
          console.log('[Tor] ✅ Ueber Tor verbunden mit:', contact.name, '(nach Adressabruf)');
        },
        onDisc: () => { const tt = setTimeout(() => runOutgoingCycle(lastCycleOptions), 2000); tt?.unref?.(); },
        onFail: (why) => { if (why === 'abgelehnt') markRejected(contact.id); },
      }).catch(() => {});
    }
  }).catch(() => {});
}

const onionMissingLogged = new Set();
const reserveAttempts = new Map();   // contactId -> naechster erlaubter Versuch (ms)
const RESERVE_RETRY_MS = 60000;
// Direkt verbunden, aber keine Tor-Reserve (z.B. nach Netzwechsel: die Reserve
// starb mit dem Tor-Neustart, die Direktverbindung ueberlebte per ICE-
// Neustart): Reserve neu aufbauen - nur eine Seite (Rolle 'initiator').
function maybeBuildTorReserve(contact, options) {
  if (!isTorReserveEnabled() || contact.role !== 'initiator' || !isDirectConnected(contact.id)) return;
  if (!getOwnOnion() || !ONION_RE.test(contact.torOnion || '') || hasTorReserve(contact.id)) return;
  if (Date.now() < (reserveAttempts.get(contact.id) || 0)) return;
  reserveAttempts.set(contact.id, Date.now() + RESERVE_RETRY_MS);
  connectViaTor(contact, {
    onConnected: (rtc) => options.onRtcConnected?.(contact.id, rtc),
    onDisc: () => {},
  }).catch(() => {});
}

function maybeConnectViaTor(contact, options, { force = false, ignoreRejected = false } = {}) {
  if (!isUsable(contact.id)) {
    const promoted = promoteTorReserve(contact.id);
    if (promoted) return;
  }
  if (getOwnOnion() && !RTCStore.isConnected(contact.id) && !ONION_RE.test(contact.torOnion || '')
      && !onionMissingLogged.has(contact.id)) {
    onionMissingLogged.add(contact.id);
    console.log('[Tor] Onion-Adresse von', contact.name, 'unbekannt - Kontakt ist erst nach der naechsten Verbindung von seiner Seite erreichbar');
  }
  if (!shouldTryTor(contact, Date.now(), { force, ignoreRejected })) return;
  const t = torAttempts.get(contact.id) || { running: false, nextAt: 0, backoff: TOR_RETRY_MIN_MS };
  t.running = true;
  torAttempts.set(contact.id, t);
  const gen = netGeneration;
  let failReason = null;
  console.log('[Tor] Verbinde mit', contact.name, 'ueber Tor');
  const failed = () => {
    t.running = false;
    const rejected = failReason === 'abgelehnt';
    if (rejected) markRejected(contact.id);
    t.nextAt = Date.now() + (rejected ? Math.max(t.backoff, TOR_REJECTED_RETRY_MS) : t.backoff);
    t.backoff = Math.min(t.backoff * 2, TOR_RETRY_MAX_MS);
    if (rejected) console.warn('[Tor] Ein Kontakt lehnt die Anmeldung ab (dort geloescht oder neu gekoppelt?) - naechster Versuch in 5 min');
  };
  // Haengt der Aufbau, startet nach TOR_HEDGE_AFTER_MS ein zweiter Versuch
  // mit eigenen Tor-Kreisen (nativ isoliert) - es zaehlt der schnellere, den
  // ueberzaehligen Kanal verwirft TorTransport. Erst wenn ALLE Versuche
  // gescheitert sind, greift die Wartezeit.
  let pending = 0;
  let won = false;
  const settle = (rtc) => {
    if (rtc && !won) { won = true; t.running = false; t.nextAt = 0; }
    if (--pending > 0 || won) return;
    failed();
  };
  const attempt = (extra) => {
    pending++;
    connectViaTor(contact, {
      onConnected: (rtc) => {
        if (gen !== netGeneration) { try { rtc.close(); } catch {} return; }
        t.backoff = TOR_RETRY_MIN_MS;
        clearRejected(contact.id);
        options.onRtcConnected?.(contact.id, rtc);
        console.log('[Tor] ✅ Ueber Tor verbunden mit:', contact.name + (extra ? ' (Zusatzversuch)' : ''));
      },
      onDisc: () => {
        console.log('[Tor] Tor-Verbindung zu', contact.name, 'beendet');
        const tt = setTimeout(() => runOutgoingCycle(options), 2000);
        tt?.unref?.();
      },
      onFail: (why) => { failReason = why; },
    }).then((rtc) => settle(rtc || null), () => settle(null));
  };
  attempt(false);
  const hedge = setTimeout(() => {
    if (won || pending === 0 || gen !== netGeneration || failReason === 'abgelehnt' || isUsable(contact.id)) return;
    console.log('[Tor] Aufbau zu', contact.name, 'dauert - paralleler Zusatzversuch mit eigenen Tor-Kreisen');
    attempt(true);
  }, torHedgeAfterMs);
  hedge?.unref?.();
}

export function _resetTorFallbackForTests() {
  torHedgeAfterMs = TOR_HEDGE_AFTER_MS;
  rejectedUntil.clear();
  rejectionCount.clear();
  rejectedLoaded = null;
  descKickAt.clear();
  reserveAttempts.clear();
  notConnectedSince.clear();
  torAttempts.clear();
}
export function _markNotConnectedSinceForTests(contactId, at) { notConnectedSince.set(contactId, at); }
export function _getTorAttemptForTests(contactId) { return torAttempts.get(contactId) || null; }

// Netzwechsel (aus TorTransport): Wartezeiten fuer Tor-Versuche aufheben.
// Tor-Verbindungen ueberleben den Tor-Neustart nicht und werden sofort
// ersetzt. Direktverbindungen dagegen NICHT mehr pauschal schliessen: sie
// werden per ICE-Neustart auf das neue Netz umgezogen (DirectUpgrade.js) und
// nur geschlossen, wenn danach nichts mehr ankommt.
let netGeneration = 0;
function handleLocalNetworkChange() {
  // Laufende Tor-Versuche gehoeren zum alten Netz: verwerfen (ihr spaetes
  // Ergebnis wird ueber netGeneration erkannt und geschlossen).
  netGeneration++;
  for (const t of torAttempts.values()) { t.running = false; t.nextAt = 0; t.backoff = TOR_RETRY_MIN_MS; }
  reserveAttempts.clear();
  for (const [id, rtc] of [...RTCStore.connections.entries()]) {
    if (!rtc || rtc.transport !== 'tor') continue;
    console.log('[Netz] Netzwechsel - Tor-Verbindung am alten Netz wird ersetzt');
    RTCStore.connections.delete(id);
    try { rtc.close(); } catch {}
  }
  // Reserven ebenso - sonst haelt die Gegenseite eine tote Reserve fuer lebendig.
  dropAllTorReserves();
  upgradeOnNetworkChange();
}

// Tor ist im neuen Netz bereit: alle Kontakte SOFORT ueber Tor verbinden -
// beide Rollen, ohne Warten (Doppelte loest TorTransport auf). Steht danach
// eine Tor-Verbindung, folgt sofort der Wechsel auf direkt (DirectUpgrade).
// Schlaegt ein Versuch fehl (Tor-Kreise im neuen Netz noch nicht ganz
// stabil), nach 2 s erneut - nicht erst nach dem 15-s-Backoff.
const NETCHANGE_TOR_RETRIES = 4;
// Parallele, zeitversetzte Versuche je Runde (0 s, 6 s, 12 s), je bis 40 s.
const NETCHANGE_PARALLEL_ATTEMPTS = 3;
const NETCHANGE_PARALLEL_STAGGER_MS = 6000;
const NETCHANGE_ATTEMPT_TIMEOUT_MS = 40000;
const NETCHANGE_TOR_RETRY_MS = 2000;
export function reconnectAllViaTorNow(options = lastCycleOptions, round = 0) {
  return loadRejected().then(() => AsyncStorage.getItem('contacts')).then(raw => {
    const cs = (raw ? JSON.parse(raw) : []).filter(c => !['1','2','3'].includes(c.id) && !c.wiped);
    for (const contact of cs) {
      if (RTCStore.isConnected(contact.id) || !ONION_RE.test(contact.torOnion || '')) continue;
      if (isRejectedNow(contact.id)) continue;
      const t = torAttempts.get(contact.id) || { running: false, nextAt: 0, backoff: TOR_RETRY_MIN_MS };
      if (t.running) continue;
      t.running = true;
      torAttempts.set(contact.id, t);
      const gen = netGeneration;
      // Mehrere zeitversetzte Versuche parallel: ein Onion-Aufbau im frischen
      // tor braucht je nach gewaehlten Kreisen 5 bis >25 s (live gemessen) -
      // es zaehlt der schnellste. Spaetere Kanaele verwirft TorTransport.
      let won = false;
      let rejected = false;
      let open = NETCHANGE_PARALLEL_ATTEMPTS;
      const finished = () => {
        if (--open > 0 || gen !== netGeneration) return;
        t.running = false;
        if (won || RTCStore.isConnected(contact.id)) return;
        if (rejected) { t.nextAt = Date.now() + TOR_REJECTED_RETRY_MS; return; }
        if (round + 1 < NETCHANGE_TOR_RETRIES) {
          console.log('[Tor] Neuverbindung zu', contact.name, 'fehlgeschlagen - neuer Versuch in 2 s');
          setTimeout(() => { if (gen === netGeneration) reconnectAllViaTorNow(options, round + 1); }, NETCHANGE_TOR_RETRY_MS);
        } else { t.nextAt = Date.now() + t.backoff; t.backoff = Math.min(t.backoff * 2, TOR_RETRY_MAX_MS); }
      };
      for (let k = 0; k < NETCHANGE_PARALLEL_ATTEMPTS; k++) {
        setTimeout(() => {
          if (gen !== netGeneration || won || rejected || (k > 0 && RTCStore.isConnected(contact.id))) { finished(); return; }
          connectViaTor(contact, {
            timeoutMs: NETCHANGE_ATTEMPT_TIMEOUT_MS,
            onFail: (why) => { if (why === 'abgelehnt') { rejected = true; markRejected(contact.id); } },
            onConnected: (rtc) => {
              if (gen !== netGeneration) { try { rtc.close(); } catch {} return; }
              if (won) return;
              won = true;
              clearRejected(contact.id);
              t.backoff = TOR_RETRY_MIN_MS; options.onRtcConnected?.(contact.id, rtc);
              console.log('[Tor] ✅ Nach Netzwechsel ueber Tor verbunden mit:', contact.name, '(Versuch', k + 1 + ')');
            },
            onDisc: () => setTimeout(() => runOutgoingCycle(options), 2000),
          }).then(finished, finished);
        }, k * NETCHANGE_PARALLEL_STAGGER_MS);
      }
    }
  }).catch(() => {});
}
let lastCycleOptions = {};

// Kaltstart (App oder Hintergrunddienst neu gestartet): sobald Tor zum ersten
// Mal steht, SOFORT alle Kontakte anwaehlen - parallel, zeitversetzt, je mit
// eigenen Tor-Kreisen - statt auf den naechsten 8-s-Zyklus zu warten (Live-
// Test 2026-10-17: 4 s Leerlauf nach "Tor bereit"). Die Gegenseite hat nach
// unserem Neustart nur unsere alte, tote Onion-Beschreibung und findet uns
// erst Minuten spaeter - anwaehlen muss also die neu gestartete Seite.
// Einmal je JS-Kontext; Netzwechsel regelt onTorReadyAfterNetworkChange.
let coldStartWatch = null;
export function startColdStartReconnect() {
  if (coldStartWatch) return;
  let fired = false;
  coldStartWatch = onTorState((s) => {
    if (fired || s.status !== 'ON' || !s.onion) return;
    fired = true;
    console.log('[Tor] Tor bereit nach Start - waehle alle Kontakte sofort an');
    const t = setTimeout(() => reconnectAllViaTorNow(), 0);
    t?.unref?.();
  });
}

// Verbindung zu einem Kontakt JETZT herstellen (z.B. fuer einen Anruf ohne
// bestehende Verbindung, siehe CallManager): Reserve uebernehmen oder sofort
// ueber Tor verbinden (ohne Wartezeiten) und warten, bis der Schluesseltausch
// fertig ist. Liefert die Verbindung oder null (Frist abgelaufen).
const ENSURE_POLL_MS = 250;
export async function ensureConnection(contactId, { timeoutMs = 45000 } = {}) {
  const usable = () => (isUsable(contactId) ? RTCStore.connections.get(contactId) : null);
  if (usable()) return usable();
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise(r => { const tt = setTimeout(r, ms); tt?.unref?.(); });
  if (!getOwnOnion()) {
    // Tor startet evtl. gerade (App-Start, Netzwechsel) - hoechstens bis zur Frist warten.
    await Promise.race([ensureTorRunning().catch(() => false), sleep(timeoutMs)]);
  }
  const raw = await AsyncStorage.getItem('contacts').catch(() => null);
  let contact = null;
  try { contact = (raw ? JSON.parse(raw) : []).find(c => c && c.id === contactId && !c.wiped) || null; } catch {}
  if (!contact) return null;
  // Hoechstens drei Versuche: jede abgelehnte Anmeldung zaehlt bei der
  // Gegenseite als Fehlversuch (siehe TOR_REJECTED_RETRY_MS).
  let kicks = 0;
  while (Date.now() < deadline) {
    const r = usable();
    if (r) return r;
    const t = torAttempts.get(contactId);
    if (kicks === 0 || (kicks < 3 && t && !t.running)) {
      kicks++;
      maybeConnectViaTor(contact, lastCycleOptions, { force: true, ignoreRejected: true });
    }
    await sleep(ENSURE_POLL_MS);
  }
  return usable();
}
RTCStore.connectionEnsurer = ensureConnection;

// "Jetzt verbinden" (UI): alle Wartezeiten aufheben und sofort verbinden.
export function connectAllNow(options = lastCycleOptions) {
  for (const t of torAttempts.values()) { if (!t.running) { t.nextAt = 0; t.backoff = TOR_RETRY_MIN_MS; } }
  reserveAttempts.clear();
  resetUpgradeBackoff();
  forceNextCycle = true;
  forceIgnoresRejected = true;
  return runOutgoingCycle(options);
}
let forceNextCycle = false;
// Nur der Nutzer ("Jetzt verbinden") waehlt auch Kontakte an, die zuletzt abgelehnt haben.
let forceIgnoresRejected = false;

// Shared Secrets aus EncryptedStorage in RTCStore nachladen, soweit dort noch
// keins im Speicher liegt - dasselbe, was App.tsx's "Kontakte laden"-Effekt
// beim Mounten tut. Nur fuer den Headless-Task noetig: startet der JS-
// Kontext OHNE App() (Prozess vom System/Boot/Alarm neu gestartet), ist
// RTCStore.sharedSecrets leer. Ueberschreibt nie ein bereits im Speicher
// liegendes (evtl. neueres, per Kyber-KEM frisch ausgehandeltes) Secret.
export async function loadMissingSharedSecrets() {
  const saved = await AsyncStorage.getItem('contacts').catch(() => null);
  if (!saved) return;
  let cs;
  try { cs = JSON.parse(saved).filter(c => !['1','2','3'].includes(c.id)); } catch { return; }
  await Promise.all(cs.map(async (c) => {
    await loadPreviousSecret(c.id);
    if (RTCStore.sharedSecrets.has(c.id)) return;
    const secret = await EncryptedStorage.getItem('shared_secret_' + c.id).catch(() => null);
    if (secret && !RTCStore.sharedSecrets.has(c.id)) RTCStore.sharedSecrets.set(c.id, secret);
  }));
}

// Unbestaetigtes vorheriges Secret (siehe RTCStore.rememberPreviousSecret)
// nach einem Neustart wieder als Kandidat laden. Auch von App.tsx genutzt.
export async function loadPreviousSecret(contactId) {
  // Zustell-Garantie: Dedup-Liste/Faehigkeiten/Empfangs-Ablage zusammen mit
  // den Secrets laden - also bevor eine Verbindung (und damit eine erneut
  // zugestellte Nachricht) ueberhaupt moeglich ist.
  RTCStore.preloadContact(contactId);
  // Warteschlangen-Altbestand (Verbindungs-Secret im Index) sofort umstellen.
  migrateQueueAtRest(contactId).catch(() => {});
  if (RTCStore.previousSecrets.has(contactId)) return;
  const prev = await EncryptedStorage.getItem('shared_secret_prev_' + contactId).catch(() => null);
  if (prev && !RTCStore.previousSecrets.has(contactId)) RTCStore.previousSecrets.set(contactId, prev);
}

// ─── Zyklus-Zustand ─────────────────────────────────────────────────────────
// Modulweit: App-UI-Timer und Headless-Task laufen (wenn beide aktiv sind) im
// selben JS-Kontext und teilen sich dadurch automatisch dieselben Sperren -
// ein Headless-Tick waehrend eines noch laufenden App-Zyklus (oder umgekehrt)
// wird uebersprungen (Chaos-Test-Fund, SECURITY_CHAOS_TESTING.md §3/§8, Fix 4).
let outgoingCycleRunning = false;
let incomingCycleRunning = false;

// Verbindungszyklus (vorher: Auto-Reconnect ueber den Treffpunkt-Server).
// Fuer jeden Kontakt: aktive Verbindung pruefen, notfalls Tor-Reserve
// uebernehmen oder ueber Tor verbinden; steht nur Tor, den Wechsel auf direkt
// versuchen (DirectUpgrade - mit eigener Wartezeit); steht direkt, die
// Tor-Reserve bereithalten.
//
// Rueckgabewert: Promise, das erfuellt wird, sobald der Zyklus selbst durch
// ist. Gestartete Tor-Verbindungsversuche laufen im Hintergrund weiter (der
// Headless-Task hat nur 15 s Zeit und wartet bewusst nicht auf sie).
export function runOutgoingCycle(options = {}) {
  lastCycleOptions = options;
  if (outgoingCycleRunning) return Promise.resolve();
  outgoingCycleRunning = true;
  const force = forceNextCycle;
  const ignoreRejected = forceIgnoresRejected;
  forceNextCycle = false;
  forceIgnoresRejected = false;
  return loadRejected().then(() => AsyncStorage.getItem('contacts')).then(saved => {
    if (!saved) return;
    try {
      // pendingDelete-Kontakte bewusst eingeschlossen: ihr Loesch-Hinweis
      // braucht noch eine Verbindung (siehe requestContactDeletion).
      const cs = JSON.parse(saved).filter(c => !['1','2','3'].includes(c.id) && !c.wiped);
      for (const contact of cs) {
        if (isUsable(contact.id)) {
          notConnectedSince.delete(contact.id);
          // Verbindung steht (egal ob von uns oder der Gegenseite aufgebaut,
          // Tor oder direkt): Ablehnungs-Merker und "veraltet" aufheben.
          if (contact.stale || rejectedUntil.has(contact.id)) clearRejected(contact.id);
        }
        else if (!notConnectedSince.has(contact.id)) notConnectedSince.set(contact.id, Date.now());
        maybeConnectViaTor(contact, options, { force, ignoreRejected });
        maybeBuildTorReserve(contact, options);
        if (isTorConnected(contact.id)) {
          maybeStartUpgrade(contact.id, { reason: force ? 'manuell' : 'zyklus', force }).catch(() => {});
        }
      }
    } catch(e) { console.warn('[Verbindung] Fehler im Verbindungszyklus:', e?.message || e); }
  }).finally(() => {
    // Muss auch bei einem Fehler mitten im Zyklus zurueckgesetzt werden -
    // siehe identischer Kommentar bei runIncomingCycle (Fix 4).
    outgoingCycleRunning = false;
  });
}

// Wartungszyklus (vorher zusaetzlich: Reconnect-Angebote und Pakete vom
// Server abholen - entfaellt ersatzlos). Loesch-Hinweise, die innerhalb von
// PENDING_DELETE_MAX_MS nie per P2P zugestellt werden konnten: Kontakt
// trotzdem endgueltig entfernen (siehe requestContactDeletion()).
export async function runIncomingCycle(options = {}) {
  if (incomingCycleRunning) return;
  incomingCycleRunning = true;
  try {
    const saved = await AsyncStorage.getItem('contacts');
    if (!saved) return;
    const cs = JSON.parse(saved).filter(c => !['1','2','3'].includes(c.id));
    for (const c of cs) {
      if (c.pendingDelete && Date.now() - (c.pendingDeleteSince || 0) > PENDING_DELETE_MAX_MS) {
        removeContactLocally(c.id);
      }
    }
  } catch(e) {
    console.warn('[Wartung] Fehler:', e?.message || e);
  } finally {
    // Muss auch bei einem Fehler/Absturz mitten im Zyklus zurueckgesetzt
    // werden - sonst wuerde ein einziger geworfener Fehler die Sperre
    // dauerhaft haengen lassen und JEDEN weiteren Zyklus fuer immer
    // blockieren.
    incomingCycleRunning = false;
  }
}
