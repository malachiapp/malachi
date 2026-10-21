/**
 * Malachi – RatchetSession.js
 * Ratchet-Zustand PRO KONTAKT (nicht pro Verbindung): direkte Verbindung,
 * Tor-Reserve und Tor-Verbindung benutzen denselben Zustand. Kern-Algorithmus
 * in DoubleRatchet.js; hier: Speichern, Sperren, Initialisierung, KEM-Vorrat,
 * Downgrade-Schutz, Loeschen. Ausfuehrlich: RATCHET_DESIGN.md.
 *
 * Speicher: EncryptedStorage 'ratchet_<kontaktId>' - EIN Eintrag (Zustand +
 * KEM-Vorrat + Faehigkeit der Gegenseite), damit jede Aenderung atomar ist.
 * Jede Operation laeuft unter einer Sperre pro Kontakt auf einer KOPIE; erst
 * wenn die Kopie gespeichert ist, wird sie zum aktuellen Zustand. Scheitert
 * irgendetwas (Manipulation, Speicherfehler), bleibt der alte Zustand
 * unveraendert - eine Nachricht geht dann nicht raus bzw. wird nicht
 * verarbeitet, nie "halb".
 *
 * Rollen: die Seite mit Kontakt-Rolle 'initiator' (Einladende) baut die
 * Sitzung auf (Alice), sobald die Gegenseite Ratchet-Faehigkeit gemeldet hat;
 * die andere (Bob) erst beim Empfang der ersten Ratchet-Nachricht. Stimmen die
 * Rollen beider Geraete nicht (beide 'initiator'), loest eine feste
 * Reihenfolge den Zusammenstoss auf (siehe open()).
 *
 * KEM-Vorrat (Post-Quanten-Schritt): jedes Verbindungs-Geheimnis (ML-KEM-768,
 * WebRTCManager) wird hier eingetragen:
 *   held  - von UNS gekapselt (Responder). Die Gegenseite (Decapsulator) mischt
 *           es in ihren naechsten DH-Schritt und nennt die Kennung im Header;
 *           wir brauchen es dann zum Nachrechnen. WebRTCManager reiht den
 *           Eintrag in die Sperre dieses Kontakts ein, BEVOR der Ciphertext
 *           rausgeht - jede Nachricht, die sich darauf bezieht, wird damit
 *           erst danach geoeffnet.
 *   own   - von UNS entkapselt (Initiator der Verbindung). Wir mischen es in
 *           unseren naechsten eigenen DH-Schritt. Die Gegenseite hat es sicher
 *           (sie hat es beim Kapseln eingetragen).
 * Verbrauchte Eintraege werden sofort entfernt, der Rest altert heraus.
 */
import EncryptedStorage from 'react-native-encrypted-storage';
import { Buffer } from 'buffer';
import * as DR from './DoubleRatchet';
import { secureRandomBytes } from './MessageCrypto';

// Hauptschalter (nur fuer Notfaelle): false = keine NEUEN Sitzungen. Bestehende
// Sitzungen laufen weiter (sonst waere das ein Downgrade).
export const RATCHET_ENABLED = true;
export const RATCHET_CAP_VERSION = 1;

const KEY_PREFIX = 'ratchet_';
const RECORD_VERSION = 1;
const HELD_MAX_WITH_SESSION = 32;
const POOL_MAX_WITHOUT_SESSION = 8;
const OWN_MAX = 8;
const HELD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Eigene KEM-Geheimnisse nur mischen, solange sie juenger sind als das - die
// Gegenseite haelt ihre Kopie deutlich laenger (HELD_MAX_AGE_MS), auch bei
// verstellten Uhren bleibt so Abstand.
const OWN_MIX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const rng = (n) => secureRandomBytes(n);
const utf8 = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const fromUtf8 = (u8) => Buffer.from(u8).toString('utf8');

const cache = new Map();      // kontaktId -> gespeicherter (zuletzt bestaetigter) Eintrag
const locks = new Map();      // kontaktId -> Promise-Kette
const generations = new Map(); // kontaktId -> Zaehler; steigt beim Loeschen
const roleCache = new Map();  // kontaktId -> 'initiator' | 'responder'
let epoch = 0;                // steigt beim Wipe (alle Kontakte)

function emptyRecord() {
  return { v: RECORD_VERSION, s: null, held: [], own: [] };
}

function withLock(chatId, fn) {
  const prev = locks.get(chatId) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(chatId, tail);
  tail.then(() => { if (locks.get(chatId) === tail) locks.delete(chatId); });
  return run;
}

const clone = (rec) => JSON.parse(JSON.stringify(rec));

function isPoolEntry(e) {
  return e && typeof e.kid === 'string' && typeof e.k === 'string' && Number.isFinite(e.t);
}

// Minimale Strukturpruefung - ein unlesbarer Eintrag fuehrt NICHT zu einem
// leeren (das waere ein Downgrade auf das alte Verfahren), sondern sperrt den
// Ratchet fuer diesen Kontakt (corrupt), bis er neu aufgebaut wird.
function normalizeRecord(raw) {
  const r = JSON.parse(raw);
  if (!r || typeof r !== 'object' || r.v !== RECORD_VERSION) throw new Error('Unbekanntes Format');
  const s = r.s;
  if (s !== null && s !== undefined) {
    if (typeof s !== 'object' || s.v !== DR.PROTOCOL_VERSION || typeof s.rk !== 'string' || typeof s.ad !== 'string'
        || !s.dhs || typeof s.dhs.sk !== 'string' || typeof s.dhs.pk !== 'string' || !Array.isArray(s.skipped)) {
      throw new Error('Ungueltiger Zustand');
    }
  }
  return {
    v: RECORD_VERSION,
    s: s || null,
    held: Array.isArray(r.held) ? r.held.filter(isPoolEntry) : [],
    own: Array.isArray(r.own) ? r.own.filter(isPoolEntry) : [],
    ...(r.cap === 0 || r.cap === 1 ? { cap: r.cap } : {}),
  };
}

async function loadRecord(chatId) {
  if (cache.has(chatId)) return cache.get(chatId);
  const raw = await EncryptedStorage.getItem(KEY_PREFIX + chatId);
  let rec;
  if (!raw) {
    rec = emptyRecord();
  } else {
    try {
      rec = normalizeRecord(raw);
    } catch (e) {
      console.error('[Ratchet] Gespeicherter Zustand unlesbar - Ratchet fuer diesen Kontakt gesperrt:', e?.message || e);
      rec = { ...emptyRecord(), corrupt: true };
    }
  }
  cache.set(chatId, rec);
  return rec;
}

function snapshot(chatId) {
  return { gen: generations.get(chatId) || 0, epoch };
}

function stillValid(chatId, snap) {
  return (generations.get(chatId) || 0) === snap.gen && epoch === snap.epoch;
}

// Schreibt die Arbeitskopie; erst danach gilt sie. Wurde der Kontakt waehrend
// der Operation geloescht (Kontakt loeschen, Wipe), wird nichts gespeichert -
// bzw. ein bereits geschriebener Eintrag sofort wieder entfernt.
async function commit(chatId, work, snap) {
  if (!stillValid(chatId, snap)) throw new DR.RatchetError('deleted', 'Kontakt waehrend der Ratchet-Operation geloescht');
  await EncryptedStorage.setItem(KEY_PREFIX + chatId, JSON.stringify(work));
  if (!stillValid(chatId, snap)) {
    await EncryptedStorage.removeItem(KEY_PREFIX + chatId).catch(() => {});
    throw new DR.RatchetError('deleted', 'Kontakt waehrend der Ratchet-Operation geloescht');
  }
  cache.set(chatId, work);
}

async function contactRole(chatId) {
  if (roleCache.has(chatId)) return roleCache.get(chatId);
  let role = null;
  try {
    const raw = await EncryptedStorage.getItem('contacts');
    const list = raw ? JSON.parse(raw) : [];
    const c = Array.isArray(list) ? list.find((x) => x && x.id === chatId) : null;
    if (c && (c.role === 'initiator' || c.role === 'responder')) role = c.role;
  } catch {}
  if (role) roleCache.set(chatId, role);
  return role;
}

function dropKid(work, kid) {
  work.held = work.held.filter((e) => e.kid !== kid);
  work.own = work.own.filter((e) => e.kid !== kid);
}

function prunePools(work, now) {
  const heldMax = work.s ? HELD_MAX_WITH_SESSION : POOL_MAX_WITHOUT_SESSION;
  work.held = work.held
    .filter((e) => now - e.t <= HELD_MAX_AGE_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-heldMax);
  work.own = work.own
    .filter((e) => now - e.t <= OWN_MIX_MAX_AGE_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-OWN_MAX);
}

function findKem(work, kid, candidates) {
  for (const e of [...work.held, ...work.own]) if (e.kid === kid) return e.k;
  for (const s of candidates || []) {
    if (typeof s !== 'string' || !s) continue;
    try { if (DR.kemId(s) === kid) return s; } catch {}
  }
  return null;
}

// Eigene KEM-Geheimnisse fuer den naechsten eigenen DH-Schritt: nur solche,
// die NACH dem Entstehen der eigenen Sitzung entkapselt wurden (dann hatte die
// Gegenseite sie sicher schon im Vorrat), juengste zuerst, hoechstens 4.
function takeOwnKems(work, now) {
  const s = work.s;
  const eligible = work.own
    .filter((e) => e.t >= s.createdAt && now - e.t <= OWN_MIX_MAX_AGE_MS && e.kid !== s.initKid)
    .sort((a, b) => b.t - a.t)
    .slice(0, DR.MAX_HEADER_KEMS);
  for (const e of eligible) dropKid(work, e.kid);
  return eligible.map((e) => ({ kid: e.kid, secret: e.k }));
}

// ─── Oeffentliche Schnittstelle ─────────────────────────────────────────────

// Laedt den Eintrag vorab in den Speicher (z.B. beim App-Start).
export function preload(chatId) {
  if (!chatId) return Promise.resolve();
  return withLock(chatId, () => loadRecord(chatId)).then(() => {}, () => {});
}

// Besteht fuer den Kontakt eine Sitzung (= Senden nur noch per Ratchet)?
export async function hasSession(chatId) {
  if (!chatId) return false;
  const rec = cache.has(chatId) ? cache.get(chatId) : await withLock(chatId, () => loadRecord(chatId));
  return !!(rec.s || rec.corrupt);
}

// Downgrade-Schutz: hat die Gegenseite nachweislich per Ratchet gesendet (bzw.
// ist der Zustand unlesbar), werden Nachrichten ohne Ratchet abgelehnt. Laeuft
// unter der Sperre, damit eine vorher angekommene Ratchet-Nachricht, die die
// Sitzung gerade aktiviert, beruecksichtigt ist.
export function isActive(chatId) {
  if (!chatId) return Promise.resolve(false);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    return !!(rec.corrupt || (rec.s && rec.s.active));
  });
}

// Faehigkeit der Gegenseite (profile_name/handshake caps.ratchet). "Faehig"
// ist klebrig: ein spaeteres Paket ohne die Angabe nimmt sie nicht zurueck.
export function notePeerCaps(chatId, capable) {
  if (!chatId) return Promise.resolve();
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt) return;
    if (capable) {
      if (rec.cap === 1) return;
      const work = clone(rec);
      work.cap = 1;
      await commit(chatId, work, snap);
      console.log('[Ratchet] Gegenseite unterstuetzt den Double Ratchet');
    } else {
      if (rec.cap === 1 || rec.cap === 0 || rec.s) return;
      const work = clone(rec);
      work.cap = 0;
      work.held = [];
      work.own = [];
      await commit(chatId, work, snap);
    }
  });
}

// Neues ML-KEM-Geheimnis einer Verbindung eintragen. role: 'encap' (wir haben
// gekapselt -> held) oder 'decap' (wir haben entkapselt -> own).
export function noteConnectionKem(chatId, secretB64, role) {
  if (!chatId || typeof secretB64 !== 'string' || !secretB64) return Promise.resolve();
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt) return;
    // Bekannt alte Gegenseite ohne Sitzung: nichts aufheben (dort sind die
    // Verbindungsgeheimnisse der eigentliche Inhaltsschluessel).
    if (!rec.s && rec.cap === 0) return;
    let kid;
    try {
      kid = DR.kemId(secretB64);
    } catch {
      console.warn('[Ratchet] Verbindungsgeheimnis hat kein gueltiges Format - nicht in den KEM-Vorrat aufgenommen');
      return;
    }
    const work = clone(rec);
    if (work.held.some((e) => e.kid === kid) || work.own.some((e) => e.kid === kid)) return;
    const now = Date.now();
    (role === 'decap' ? work.own : work.held).push({ kid, k: secretB64, t: now });
    prunePools(work, now);
    try {
      await commit(chatId, work, snap);
    } catch (e) {
      if (e?.code === 'deleted') throw e;
      // Speicherfehler: im Arbeitsspeicher behalten (der naechste erfolgreiche
      // Ratchet-Speichervorgang schreibt den Eintrag mit) - wie beim
      // Verbindungs-Secret selbst ist ein Speicherfehler nicht fatal.
      if (stillValid(chatId, snap)) cache.set(chatId, work);
      console.warn('[Ratchet] KEM-Vorrat nur im Arbeitsspeicher (Speicherfehler):', e?.message || e);
    }
  });
}

// Verschluesselt plaintext (String) fuer den Kontakt. Liefert den Ratchet-
// Umschlag, oder null, wenn (noch) keine Sitzung besteht und auch keine
// aufgebaut werden darf - dann gilt das bisherige Verfahren. Wirft bei
// Fehlern: der Aufrufer darf dann NICHT auf das alte Verfahren ausweichen.
// connSecret: ML-KEM-Geheimnis der Verbindung, ueber die gesendet wird
// (Startwert, falls hier die Sitzung entsteht).
export function seal(chatId, plaintext, { connSecret } = {}) {
  if (!chatId) return Promise.resolve(null);
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt) throw new DR.RatchetError('corrupt', 'Ratchet-Zustand unlesbar');
    const work = clone(rec);
    const now = Date.now();
    if (!work.s) {
      if (!RATCHET_ENABLED || work.cap !== 1 || typeof connSecret !== 'string' || !connSecret) return null;
      if ((await contactRole(chatId)) !== 'initiator') return null;
      work.s = await DR.initAlice(connSecret, { now, rng });
      dropKid(work, work.s.initKid);
      prunePools(work, now);
      console.log('[Ratchet] Neue Sitzung aufgebaut (Initiator)');
    }
    const env = await DR.encrypt(work.s, utf8(plaintext), { rng });
    await commit(chatId, work, snap);
    return env;
  });
}

// Entschluesselt einen Ratchet-Umschlag. Liefert den Klartext (String) oder
// wirft (dann bleibt der Zustand unveraendert). candidates: bekannte
// Verbindungsgeheimnisse (Base64) als Rueckfall fuer KEM-Kennungen, die nicht
// im Vorrat stehen (aktuelle Verbindung, letzte/vorletzte).
export function open(chatId, envelope, { candidates = [] } = {}) {
  if (!chatId) return Promise.reject(new DR.RatchetError('no-contact', 'Kein Kontakt'));
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt) throw new DR.RatchetError('corrupt', 'Ratchet-Zustand unlesbar');
    const h = DR.validateEnvelope(envelope);
    const work = clone(rec);
    const now = Date.now();
    const find = (kid) => findKem(work, kid, candidates);
    if (!work.s) {
      if (!h.i) throw new DR.RatchetError('no-session', 'Ratchet-Nachricht ohne bestehende Sitzung');
      if (!RATCHET_ENABLED) throw new DR.RatchetError('disabled', 'Ratchet abgeschaltet - keine neuen Sitzungen');
      const secret = find(h.i);
      if (!secret) throw new DR.RatchetError('kem-unknown', 'Start-Geheimnis der Sitzung unbekannt');
      work.s = DR.initBob(secret, { now });
      dropKid(work, h.i);
    } else if (h.i && work.s.role === 'alice') {
      // Ein "i" sendet nur, wer selbst als Initiator aufbaut - die Gegenseite
      // hat also gleichzeitig eine Sitzung aufgebaut (Rollen passen nicht
      // zusammen; auch mit derselben Start-Kennung, wenn beide dieselbe
      // Verbindung nahmen). Solange die eigene noch nie eine Antwort bekam,
      // gilt auf beiden Geraeten dieselbe: die mit dem kleineren Kennzeichen.
      if (work.s.active) {
        throw new DR.RatchetError('foreign-init', 'Neuaufbau einer bestaetigten Sitzung abgelehnt');
      }
      if (DR.initTag(h.i, h.d) < DR.initTag(work.s.initKid, work.s.initDh)) {
        const secret = find(h.i);
        if (!secret) throw new DR.RatchetError('kem-unknown', 'Start-Geheimnis der Sitzung unbekannt');
        console.warn('[Ratchet] Beide Seiten haben gleichzeitig eine Sitzung aufgebaut - die der Gegenseite gilt');
        work.s = DR.initBob(secret, { now });
        dropKid(work, h.i);
      } else {
        throw new DR.RatchetError('glare', 'Gleichzeitiger Sitzungsaufbau - die eigene Sitzung gilt, Nachricht verworfen');
      }
    } else if (h.i && h.i !== work.s.initKid) {
      // Eine bestehende Sitzung laesst sich nicht von aussen ersetzen - sonst
      // koennte, wer ein Verbindungsgeheimnis erbeutet, die Sitzung auf eine
      // eigene umstellen (und z.B. die Warteschlange mitlesen).
      throw new DR.RatchetError('foreign-init', 'Neuaufbau einer bestehenden Sitzung abgelehnt');
    }
    const res = await DR.decrypt(work.s, { ...envelope, h }, {
      now, rng, lookupKem: find, takeOwnKems: () => takeOwnKems(work, now),
    });
    for (const kid of res.consumedKids) dropKid(work, kid);
    if (!work.s.active) {
      work.s.active = true;
      console.log('[Ratchet] ✅ Sitzung von der Gegenseite bestaetigt - ab jetzt nur noch Ratchet-Nachrichten');
    }
    prunePools(work, now);
    await commit(chatId, work, snap);
    return fromUtf8(res.plaintext);
  });
}

// Secret Chat beendet: gespeicherte Schluessel uebersprungener (noch nicht
// angekommener) Nachrichten verwerfen - nichts aus dem Secret Chat bleibt
// entschluesselbar liegen.
export function purgeSkippedKeys(chatId) {
  if (!chatId) return Promise.resolve();
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt || !rec.s || !rec.s.skipped.length) return;
    const work = clone(rec);
    work.s.skipped = [];
    await commit(chatId, work, snap);
  }).catch(() => {});
}

// Manueller Neuaufbau (z.B. nach Zustandsverlust auf einer Seite): verwirft die
// Sitzung, behaelt die bekannte Faehigkeit. Muss auf BEIDEN Geraeten erfolgen
// - eine bestehende Sitzung der Gegenseite nimmt keinen Neuaufbau an.
export function resetSession(chatId) {
  if (!chatId) return Promise.resolve();
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    let rec = null;
    try { rec = await loadRecord(chatId); } catch {}
    const work = emptyRecord();
    if (rec && !rec.corrupt && rec.cap === 1) work.cap = 1;
    await commit(chatId, work, snap);
    console.warn('[Ratchet] Sitzung manuell zurueckgesetzt');
  });
}

// Kontakt geloescht / Geraet der Gegenseite zurueckgesetzt: Zustand samt
// KEM-Vorrat und uebersprungenen Schluesseln dauerhaft loeschen. Laufende
// Operationen speichern danach nichts mehr (Generationszaehler).
export function forget(chatId) {
  if (!chatId) return Promise.resolve();
  generations.set(chatId, (generations.get(chatId) || 0) + 1);
  cache.delete(chatId);
  roleCache.delete(chatId);
  return withLock(chatId, async () => {
    cache.delete(chatId);
    await EncryptedStorage.removeItem(KEY_PREFIX + chatId);
  }).catch(() => {});
}

// Nur den Arbeitsspeicher eines Kontakts leeren (RTCStore.clearContact) - der
// gespeicherte Zustand bleibt und wird beim naechsten Zugriff neu geladen.
export function forgetFromMemory(chatId) {
  cache.delete(chatId);
  roleCache.delete(chatId);
}

// Wipe/Duress (RTCStore.resetAll): alles im Arbeitsspeicher verwerfen; laufende
// Operationen speichern nichts mehr. Den Speicher selbst leert der Wipe
// (EncryptedStorage.clear in App.tsx performWipe).
export function forgetAll() {
  epoch++;
  cache.clear();
  roleCache.clear();
}

export const STORAGE_KEY_PREFIX = KEY_PREFIX;

// Fuer Tests.
export function _resetRatchetSessionForTests() {
  forgetAll();
  locks.clear();
  generations.clear();
}
export function _peekRecordForTests(chatId) {
  return cache.has(chatId) ? clone(cache.get(chatId)) : null;
}
