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
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import * as DR from './DoubleRatchet';
import { secureRandomBytes } from './MessageCrypto';
import { generateKyberKeypair, kyberEncapsulate, kyberDecapsulate } from './HybridCrypto';

// Hauptschalter (nur fuer Notfaelle): false = keine NEUEN Sitzungen. Bestehende
// Sitzungen laufen weiter (sonst waere das ein Downgrade).
export const RATCHET_ENABLED = true;
// Faehigkeit im profile_name (caps.ratchet): 1 = Double Ratchet (1.0/1.1),
// 2 = zusaetzlich regelmaessiges ML-KEM-Nachmischen (V6, siehe unten). Aeltere
// Gegenseiten pruefen ">= 1" - fuer sie aendert sich nichts.
export const RATCHET_CAP_VERSION = 2;
export const RATCHET_PQ_VERSION = 2;

const KEY_PREFIX = 'ratchet_';
const RECORD_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const HELD_MAX_WITH_SESSION = 32;
const POOL_MAX_WITHOUT_SESSION = 8;
const OWN_MAX = 8;
// Eigene KEM-Geheimnisse nur mischen, solange sie juenger sind als das - die
// Gegenseite haelt ihre Kopie laenger (siehe unten), auch bei verstellten
// Uhren bleibt so Abstand. Gilt so auch in 1.0/1.1 (Gegenseiten im Umlauf).
const OWN_MIX_MAX_AGE_MS = 7 * DAY_MS;
// ─── Aufbewahrung des KEM-Vorrats "held" (Krypto-Review 2026-10-25, V4/K-08) ─
// Ein held-Eintrag ist das rohe Verbindungsgeheimnis einer frueheren
// Verbindung (bei v1-Verbindungen zugleich ihr Schluessel der aeusseren
// Schicht). Er wird nur gebraucht, bis die Gegenseite ihn in einen DH-Schritt
// eingemischt hat UND diese Kette hier angekommen ist. Bisher galten pauschal
// 30 Tage bzw. die 32 juengsten Eintraege. Beides war in beide Richtungen
// falsch: zu lang fuer Eintraege, die nie mehr gebraucht werden, und zu kurz
// fuer den einen Fall, in dem ein Eintrag noch gebraucht wird (die Gegenseite
// hat ihn schon eingemischt, ihre Nachricht ist aber noch nicht da - z.B.
// Handy laenger aus). Dann haette die Gegenseite in ihrer Richtung dauerhaft
// "kem-unknown" bekommen: Kontakt halb entkoppelt.
//
// Jetzt (Begruendung ausfuehrlich in RATCHET_DESIGN.md, Abschnitt 4):
//  - Die Gegenseite mischt ein Geheimnis nur in eine Kette, die sie NACH dem
//    Empfang unseres aktuellen Ratchet-Schluessels anlegt (Ketten wechseln
//    streng abwechselnd), und nur, solange es bei ihr hoechstens
//    OWN_MIX_MAX_AGE_MS alt ist. Unser aktueller Schluessel kann sie fruehestens
//    erreichen, wenn wir damit zum ersten Mal gesendet haben (Zeitpunkt "sa"
//    im Zustand) - bzw. noch gar nicht, solange wir damit nichts gesendet
//    haben (ns = 0, Grenze = jetzt).
//  - Eintraege, die aelter sind als (Grenze - 7 Tage - 1 Tag Uhren-Spielraum),
//    kann die Gegenseite also in keine noch ausstehende Kette mehr mischen ->
//    sofort weg. Im laufenden Gespraech heisst das: nach rund 8 Tagen.
//  - Alles andere bleibt, auch ueber HELD_MAX_AGE_MS hinaus, bis die
//    ausstehende Kette ankommt (dann wird es verbraucht und geloescht) -
//    begrenzt auf HELD_NEEDED_MAX Eintraege. Das betrifft nur Kontakte, mit
//    denen seither keine Verbindung zustande kam; jede neue Verbindung bringt
//    die ausstehende Kette (profile_name laeuft durch den Ratchet).
//  - Zustaende ohne "sa" (aus 1.0/1.1, bis zum naechsten eigenen DH-Schritt
//    bzw. Senden) behalten das bisherige Verhalten (30 Tage, 32 Eintraege) -
//    ein Update verkuerzt also nichts, was noch gebraucht werden koennte.
const HELD_MAX_AGE_MS = 14 * DAY_MS;          // ohne Sitzung (nur Startgeheimnisse)
const HELD_LEGACY_MAX_AGE_MS = 30 * DAY_MS;   // Zustand ohne "sa" (Altbestand)
const HELD_NEEDED_MAX = 64;
const CLOCK_SKEW_MARGIN_MS = DAY_MS;

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
    // V6 (additiv; 1.0/1.1 lassen die Felder beim Lesen weg): Ratchet-Version
    // der Gegenseite (klebrig) und Zustand des ML-KEM-Nachmischens.
    ...(r.rv === RATCHET_PQ_VERSION ? { rv: r.rv } : {}),
    ...(normalizePq(r.pq) ? { pq: normalizePq(r.pq) } : {}),
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

// Fruehester Zeitpunkt (eigene Uhr), ab dem ein held-Eintrag noch in eine
// ausstehende Kette der Gegenseite eingemischt sein koennte - siehe
// HELD_MAX_AGE_MS oben. null = unbekannt (Altbestand ohne "sa").
export function heldNeededSince(s, now) {
  if (!s) return null;
  if (s.ns === 0) return now - OWN_MIX_MAX_AGE_MS - CLOCK_SKEW_MARGIN_MS;
  if (Number.isFinite(s.sa)) return Math.min(s.sa, now) - OWN_MIX_MAX_AGE_MS - CLOCK_SKEW_MARGIN_MS;
  return null;
}

function pruneHeld(work, now) {
  const byAge = (a, b) => a.t - b.t;
  if (!work.s) {
    work.held = work.held
      .filter((e) => now - e.t <= HELD_MAX_AGE_MS)
      .sort(byAge)
      .slice(-POOL_MAX_WITHOUT_SESSION);
    return;
  }
  const since = heldNeededSince(work.s, now);
  if (since === null) {
    // Altbestand: unveraendert wie in 1.0/1.1.
    work.held = work.held
      .filter((e) => now - e.t <= HELD_LEGACY_MAX_AGE_MS)
      .sort(byAge)
      .slice(-HELD_MAX_WITH_SESSION);
    return;
  }
  work.held = work.held
    .filter((e) => e.t >= since)
    .sort(byAge)
    .slice(-HELD_NEEDED_MAX);
}

function prunePools(work, now) {
  pruneHeld(work, now);
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

// ─── Regelmaessiges ML-KEM-Nachmischen (Krypto-Review 2026-10-25, V6/K-06) ──
// Bisher kam frisches ML-KEM-Material nur mit einer NEUEN Verbindung in den
// Ratchet - bei Dauerverbindungen tagelang nicht. Jetzt (nur mit Gegenseiten,
// die caps.ratchet >= 2 melden; klebrig) bietet jede Seite spaetestens alle
// 24 h bzw. 100 eigene Nachrichten einen frischen ML-KEM-768-Schluessel an
// (SPQR-artig, aber ungestueckelt - P2P-Pakete sind gross genug):
//   A -> B  pq_offer {id, pk}            (durch den Ratchet)
//   B       kapselt, leitet das Geheimnis ab, traegt es in "held" ein und
//           SPEICHERT, erst danach:
//   B -> A  pq_ct {id, ct, kid}          (durch den Ratchet)
//   A       entkapselt, leitet ab, prueft kid (Schluesselbestaetigung) und
//           traegt es in "own" ein -> fliesst in A's naechsten DH-Schritt ein
//           (wie ein Verbindungs-Geheimnis, gleiche Regeln, gleiche Pruefung).
// Geheimnis = HKDF(ss, salt = SHA-256(lp: Label, id, SHA-256(pk), SHA-256(ct),
// AD_s), info = "...|secret") - an Angebot, Chiffrat und Sitzung gebunden.
// Robust: verlorenes Angebot/Antwort -> nach PQ_PENDING_MAX_AGE_MS neues
// Angebot; passt kid nicht (anderer Sitzungsstand, Manipulation), wird nichts
// eingemischt - die Gegenseite kaeme sonst nicht mehr mit (kem-unknown).
// Write-Ahead: offener ML-KEM-Schluessel bzw. held-Eintrag sind gespeichert,
// bevor die jeweilige Nachricht hinausgeht. Nachrichten pq_* werden nur
// angenommen, wenn sie durch den Ratchet kamen (WebRTCManager).
export const PQ_REFRESH_MS = 24 * 60 * 60 * 1000;
export const PQ_REFRESH_MSGS = 100;
export const PQ_PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const PQ_PENDING_MAX = 2;
const PQ_ACCEPTED_MAX = 16;
const PQ_ACCEPT_MIN_GAP_MS = 60 * 1000;
const PQ_LABEL = 'malachi-dr-v2-pq';
const PQ_ID_RE = /^[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function normalizePq(p) {
  if (!p || typeof p !== 'object') return null;
  const pending = Array.isArray(p.pending)
    ? p.pending.filter((e) => e && PQ_ID_RE.test(e.id) && typeof e.sk === 'string' && typeof e.ph === 'string' && Number.isFinite(e.t)).slice(-PQ_PENDING_MAX)
    : [];
  const acc = Array.isArray(p.acc) ? p.acc.filter((x) => typeof x === 'string' && PQ_ID_RE.test(x)).slice(-PQ_ACCEPTED_MAX) : [];
  return {
    pending,
    acc,
    last: Number.isFinite(p.last) ? p.last : 0,
    n: Number.isInteger(p.n) && p.n >= 0 ? p.n : 0,
    la: Number.isFinite(p.la) ? p.la : 0,
  };
}

function lpBuf(u8) {
  const out = new Uint8Array(4 + u8.length);
  out[0] = (u8.length >>> 24) & 255; out[1] = (u8.length >>> 16) & 255; out[2] = (u8.length >>> 8) & 255; out[3] = u8.length & 255;
  out.set(u8, 4);
  return out;
}
function joinBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const b64u = (s) => Uint8Array.from(Buffer.from(String(s), 'base64'));
const b64s = (u8) => Buffer.from(u8).toString('base64');

// Abgeleitetes Nachmisch-Geheimnis (Base64). ad: AD_s der Sitzung (Base64).
export function derivePqSecret(ssB64, { id, pkHash, ct, ad }) {
  const salt = sha256(joinBytes([
    lpBuf(utf8(PQ_LABEL)), lpBuf(utf8(id)), lpBuf(b64u(pkHash)), lpBuf(sha256(b64u(ct))), lpBuf(b64u(ad)),
  ]));
  return b64s(hkdf(sha256, b64u(ssB64), salt, utf8(PQ_LABEL + '|secret'), 32));
}

function ctEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function pqState(work, now) {
  if (!work.pq) work.pq = { pending: [], acc: [], last: now, n: 0, la: 0 };
  work.pq.pending = work.pq.pending.filter((e) => now - e.t <= PQ_PENDING_MAX_AGE_MS && e.t <= now + DAY_MS);
  return work.pq;
}

const pqActive = (rec) => !!(rec && !rec.corrupt && rec.rv === RATCHET_PQ_VERSION && rec.s && rec.s.active);

/** Faellig: Gegenseite v2, Sitzung bestaetigt, 24 h bzw. 100 Nachrichten seit dem letzten Mal, kein offenes Angebot. */
export function pqRefreshDue(chatId) {
  if (!chatId) return Promise.resolve(false);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (!pqActive(rec)) return false;
    const now = Date.now();
    const pq = rec.pq ? normalizePq(rec.pq) : null;
    if (!pq) return false;           // Zaehlung beginnt mit dem naechsten Senden (seal)
    if (pq.pending.some((e) => now - e.t <= PQ_PENDING_MAX_AGE_MS)) return false;
    return now - pq.last >= PQ_REFRESH_MS || pq.n >= PQ_REFRESH_MSGS;
  }).catch(() => false);
}

/** Neues Angebot: ML-KEM-Paar erzeugen, geheimen Teil speichern (Write-Ahead). -> {id, pk} | null */
export function preparePqOffer(chatId) {
  if (!chatId) return Promise.resolve(null);
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (!pqActive(rec)) return null;
    const kp = await generateKyberKeypair();
    if (!kp || typeof kp.publicKey !== 'string' || typeof kp.secretKey !== 'string') throw new Error('ML-KEM-Schluessel ungueltig');
    const id = Buffer.from(await secureRandomBytes(8)).toString('hex');
    const work = clone(rec);
    const now = Date.now();
    const pq = pqState(work, now);
    pq.pending = [...pq.pending, { id, sk: kp.secretKey, ph: b64s(sha256(b64u(kp.publicKey))), t: now }].slice(-PQ_PENDING_MAX);
    await commit(chatId, work, snap);
    return { id, pk: kp.publicKey };
  });
}

/**
 * Angebot der Gegenseite annehmen: kapseln, ableiten, in "held" eintragen und
 * speichern - erst dann die Antwort liefern (Write-Ahead). -> {id, ct, kid} | null
 */
export function acceptPqOffer(chatId, offer) {
  if (!chatId) return Promise.resolve(null);
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (!pqActive(rec)) return null;
    const id = offer?.id;
    const pk = offer?.pk;
    if (typeof id !== 'string' || !PQ_ID_RE.test(id) || typeof pk !== 'string' || pk.length > 4096 || !B64_RE.test(pk)) return null;
    const now = Date.now();
    const work = clone(rec);
    const pq = pqState(work, now);
    if (pq.acc.includes(id)) return null;                          // schon beantwortet
    if (now - (pq.la || 0) < PQ_ACCEPT_MIN_GAP_MS) return null;    // Flut eines (authentischen) Gegenuebers bremsen
    const enc = await kyberEncapsulate(pk);
    if (!enc || typeof enc.sharedSecret !== 'string' || typeof enc.cipherText !== 'string') return null;
    const secret = derivePqSecret(enc.sharedSecret, { id, pkHash: b64s(sha256(b64u(pk))), ct: enc.cipherText, ad: work.s.ad });
    const kid = DR.kemId(secret);
    if (!work.held.some((e) => e.kid === kid)) work.held.push({ kid, k: secret, t: now });
    pq.acc = [...pq.acc, id].slice(-PQ_ACCEPTED_MAX);
    pq.la = now;
    prunePools(work, now);
    await commit(chatId, work, snap);
    return { id, ct: enc.cipherText, kid };
  });
}

/** Antwort auf das eigene Angebot: entkapseln, ableiten, kid pruefen, in "own" eintragen. -> true | false */
export function completePqOffer(chatId, answer) {
  if (!chatId) return Promise.resolve(false);
  const snap = snapshot(chatId);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (!pqActive(rec) || !rec.pq) return false;
    const id = answer?.id;
    const ct = answer?.ct;
    if (typeof id !== 'string' || !PQ_ID_RE.test(id) || typeof ct !== 'string' || ct.length > 4096 || !B64_RE.test(ct)
        || typeof answer?.kid !== 'string' || !DR.KID_RE.test(answer.kid)) return false;
    const now = Date.now();
    const work = clone(rec);
    const pq = pqState(work, now);
    const p = pq.pending.find((e) => e.id === id);
    if (!p) return false;
    pq.pending = pq.pending.filter((e) => e.id !== id);              // so oder so verbraucht
    let ok = false;
    try {
      const ss = await kyberDecapsulate(ct, p.sk);
      const secret = derivePqSecret(ss, { id, pkHash: p.ph, ct, ad: work.s.ad });
      const kid = DR.kemId(secret);
      if (ctEqualStr(kid, answer.kid)) {
        if (!work.own.some((e) => e.kid === kid)) work.own.push({ kid, k: secret, t: now });
        pq.last = now;
        pq.n = 0;
        ok = true;
      } else {
        console.warn('[Ratchet] ML-KEM-Nachmischen: Kennung passt nicht - nichts eingemischt');
      }
    } catch (e) {
      console.warn('[Ratchet] ML-KEM-Nachmischen: Antwort nicht verwendbar -', e?.message || e);
    }
    prunePools(work, now);
    await commit(chatId, work, snap);
    return ok;
  });
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

// Stabiler Sicherheitscode (SafetyNumber.js, Krypto-Review V1): Sitzungs-
// bindung AD_s und ob die Gegenseite die Sitzung schon bestaetigt hat. Vorher
// (Sitzung noch im Aufbau, z.B. gleichzeitiger Aufbau beider Seiten) kann sie
// sich noch aendern - der Code wird erst danach angezeigt. AD_s ist kein
// Schluessel (nur associated data jeder Nachricht). null = keine Sitzung.
export function safetySession(chatId) {
  if (!chatId) return Promise.resolve(null);
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt || !rec.s || typeof rec.s.ad !== 'string') return null;
    return { ad: rec.s.ad, active: !!rec.s.active };
  }).catch(() => null);
}

// Faehigkeit der Gegenseite (profile_name/handshake caps.ratchet). "Faehig"
// ist klebrig: ein spaeteres Paket ohne die Angabe nimmt sie nicht zurueck.
export function notePeerCaps(chatId, capable, version = 1) {
  if (!chatId) return Promise.resolve();
  // Loeschstand zum Zeitpunkt des AUFRUFS: auch eine schon angeforderte, aber
  // erst danach laufende Operation speichert nach forget()/forgetAll() nichts.
  const snap = snapshot(chatId);
  const pqCapable = capable && Number(version) >= RATCHET_PQ_VERSION;
  return withLock(chatId, async () => {
    const rec = await loadRecord(chatId);
    if (rec.corrupt) return;
    if (capable) {
      if (rec.cap === 1 && (!pqCapable || rec.rv === RATCHET_PQ_VERSION)) return;
      const work = clone(rec);
      work.cap = 1;
      // V6: Ratchet v2 der Gegenseite - klebrig wie cap (nie zurueck auf 1).
      if (pqCapable) work.rv = RATCHET_PQ_VERSION;
      await commit(chatId, work, snap);
      console.log('[Ratchet] Gegenseite unterstuetzt den Double Ratchet' + (work.rv ? ' (v2, ML-KEM-Nachmischen)' : ''));
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
    // V4: Zeitpunkt des ersten Sendens mit dem aktuellen Ratchet-Schluessel
    // (Grenze fuer den KEM-Vorrat, siehe heldNeededSince). Nur bei der ersten
    // Nachricht einer Kette setzen - ein spaeterer Zeitpunkt waere zu spaet.
    if (env.h.n === 0) work.s.sa = now;
    // V6: eigene Nachrichten seit dem letzten ML-KEM-Nachmischen zaehlen.
    if (work.rv === RATCHET_PQ_VERSION) {
      const pq = pqState(work, now);
      pq.n = Math.min((pq.n || 0) + 1, 1e6);
    }
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
    const dhsBefore = work.s.dhs?.pk;
    const res = await DR.decrypt(work.s, { ...envelope, h }, {
      now, rng, lookupKem: find, takeOwnKems: () => takeOwnKems(work, now),
    });
    // DH-Schritt: neue eigene Sendekette, noch nichts damit gesendet (V4).
    if (work.s.dhs?.pk !== dhsBefore) delete work.s.sa;
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
    if (rec && !rec.corrupt && rec.rv === RATCHET_PQ_VERSION) work.rv = rec.rv;
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
