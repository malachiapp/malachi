/**
 * Malachi – DoubleRatchet.js
 *
 * Double Ratchet nach der Signal-Spezifikation
 * (https://signal.org/docs/specifications/doubleratchet/, Abschnitte 3.2-3.5),
 * ergaenzt um einen Post-Quanten-Schritt ("KEM-Ratchet"): die ML-KEM-768-
 * Geheimnisse der Verbindungs-Schluesseltausche (WebRTCManager, KyberModule)
 * fliessen beim jeweils naechsten eigenen DH-Schritt in KDF_RK ein - im Stil
 * von PQXDH als zusaetzliche HKDF-Eingabe hinter der DH-Ausgabe
 * (ikm = DH || KEM_1 || ... || KEM_n). Welche KEM-Geheimnisse in einen Schritt
 * eingeflossen sind, steht (als Kennung, nie das Geheimnis selbst) im
 * authentifizierten Header ("k").
 *
 * Diese Datei enthaelt NUR reine Funktionen auf einem serialisierbaren
 * Zustand (alle Binaerwerte Base64, damit er 1:1 als JSON gespeichert werden
 * kann). Persistenz, Sperren, Rollen, KEM-Verwaltung und Downgrade-Schutz:
 * RatchetSession.js. Jede Funktion, die den Zustand veraendert, wirft bei
 * einem Fehler - der Aufrufer arbeitet immer auf einer Kopie und verwirft sie
 * dann vollstaendig (Spezifikation 3.5: "changes to the state object are
 * discarded").
 *
 * Primitive (ausschliesslich aus geprueften Bibliotheken, nichts selbst gebaut):
 *   DH        X25519 (@noble/curves; lehnt Punkte kleiner Ordnung ab)
 *   KDF_RK    HKDF-SHA256, salt = Root Key, ikm = DH-Ausgabe || KEM-Geheimnisse
 *   KDF_CK    HMAC-SHA256 mit Konstante 0x01 (Nachrichtenschluessel) bzw.
 *             0x02 (naechster Kettenschluessel) - Empfehlung der Spezifikation 5.2
 *   ENCRYPT   XChaCha20-Poly1305 (@noble/ciphers). Schluessel per HKDF aus dem
 *             Nachrichtenschluessel, zufaellige 24-Byte-Nonce (siehe encrypt()),
 *             associated data = Protokoll || Sitzungs-AD || kanonischer Header.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { Buffer } from 'buffer';

export const PROTOCOL_VERSION = 1;
// Spezifikation 3.5/4: Obergrenze fuer uebersprungene Schluessel pro
// Nachricht (Schutz gegen "rechne eine Million Schluessel vor") und fuer den
// gesamten Vorrat, dazu ein Ablauf - ein gespeicherter Schluessel einer nie
// angekommenen Nachricht ist sonst dauerhaft angreifbares Material. Verlorene
// Nachrichten schickt die Warteschlange ohnehin mit NEUEM Schluessel erneut
// (BackgroundSync.js), gespeicherte Schluessel decken nur Umsortierung ab
// (z.B. Tor-Reserve und Direktverbindung parallel) - wenige Sekunden.
// Audit 2026-10-19 (C1): Rechen- und Speichergrenze getrennt. Vorher lehnte
// der Empfaenger jede Nachricht ab, sobald der Sender mehr als 1000
// Schluessel einer Kette verbraucht hatte, die hier nie ankamen (z. B. viele
// Wiederholungen aus der Warteschlange, waehrend dieses Geraet nichts oeffnen
// konnte) - die Richtung blieb dann bis zur Neu-Kopplung tot. Jetzt werden bis
// zu MAX_SKIP Schluessel vorgerechnet, gespeichert bleiben hoechstens die
// MAX_SKIPPED_KEYS juengsten.
export const MAX_SKIP = 10000;
export const MAX_SKIPPED_KEYS = 1000;
export const SKIPPED_KEY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Hoechstens so viele KEM-Geheimnisse pro DH-Schritt.
export const MAX_HEADER_KEMS = 4;
// Zuletzt abgeloeste Empfangs-Ratchet-Schluessel: Nachrichten aus diesen
// Ketten ohne gespeicherten Schluessel sind Duplikate/Replays - sofort
// ablehnen, statt einen sinnlosen DH-Schritt zu rechnen.
const MAX_PREV_DHR = 8;
const MAX_COUNTER = 2 ** 31;
// Obergrenze fuer ein Chiffrat (Base64). Ratchet-Nachrichten sind kurz -
// Medien laufen mit eigenem Dateischluessel daneben (MediaKey.js).
const MAX_CIPHERTEXT_B64 = 512 * 1024;

const utf8 = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => Uint8Array.from(Buffer.from(String(s), 'base64'));

function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const INIT_SALT = utf8('malachi-dr-v1-init');
const INFO_SK = utf8('malachi-dr-v1-sk');
const INFO_AD = utf8('malachi-dr-v1-ad');
const INFO_BOB_DH = utf8('malachi-dr-v1-bob-dh');
const INFO_KID = utf8('malachi-kem-id-v1');
const INFO_RK = utf8('malachi-dr-v1-rk');
const INFO_MK = utf8('malachi-dr-v1-msg');
const AD_PREFIX = utf8('malachi-dr-v1');
const ZERO_SALT = new Uint8Array(32);

const B64_32_RE = /^[A-Za-z0-9+/]{43}=$/;
// Kennung eines KEM-Geheimnisses: 16 Byte HKDF-Ausgabe, Base64.
export const KID_RE = /^[A-Za-z0-9+/]{22}==$/;

export class RatchetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ─── Ableitungen ────────────────────────────────────────────────────────────
// Kennung eines KEM-Geheimnisses (Base64 des Geheimnisses). Einweg (HKDF), gibt
// nichts ueber das Geheimnis preis und darf deshalb im Header stehen.
export function kemId(secretB64) {
  const raw = unb64(secretB64);
  if (raw.length < 16) throw new RatchetError('kem-invalid', 'KEM-Geheimnis zu kurz');
  return b64(hkdf(sha256, raw, INIT_SALT, INFO_KID, 16));
}

// Startwerte aus dem ML-KEM-Geheimnis der Verbindung, auf der die Sitzung
// entsteht (Ersatz fuer X3DH/PQXDH - die Gegenseite ist ueber die Kopplung und
// die Tor-Anmeldung bereits authentisch, das KEM-Geheimnis kennen nur beide):
//   SK      Start-Root-Key
//   AD      Sitzungsbindung fuer jede Nachricht (wie AD = IK_A || IK_B bei Signal)
//   Bob-DH  erstes Ratchet-Schluesselpaar der antwortenden Seite (wie Bobs
//           Signed Prekey bei Signal). Beide Seiten koennen es ableiten - es
//           traegt also nichts ueber SK hinaus bei; Bobs erster EIGENER Schritt
//           nutzt dann ein frisches Zufallspaar.
function deriveInit(secretB64) {
  const raw = unb64(secretB64);
  if (raw.length < 32) throw new RatchetError('kem-invalid', 'KEM-Geheimnis zu kurz');
  const sk = hkdf(sha256, raw, INIT_SALT, INFO_SK, 32);
  const ad = hkdf(sha256, raw, INIT_SALT, INFO_AD, 32);
  const bobSk = hkdf(sha256, raw, INIT_SALT, INFO_BOB_DH, 32);
  return { sk, ad, bobSk, bobPk: x25519.getPublicKey(bobSk), kid: kemId(secretB64) };
}

// KDF_RK: HKDF-SHA256 mit dem Root Key als Salt. KEM-Geheimnisse werden hinter
// die DH-Ausgabe gehaengt (PQXDH: KDF(DH1 || ... || SS)). Solange EINE der
// Eingaben dem Angreifer unbekannt ist, bleibt die Ausgabe geheim.
function kdfRk(rk, dhOut, kems) {
  const out = hkdf(sha256, concatBytes(dhOut, ...kems), rk, INFO_RK, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

// KDF_CK: [naechster Kettenschluessel, Nachrichtenschluessel].
function kdfCk(ck) {
  return [hmac(sha256, ck, Uint8Array.of(0x02)), hmac(sha256, ck, Uint8Array.of(0x01))];
}

function aeadKey(mk) {
  return hkdf(sha256, mk, ZERO_SALT, INFO_MK, 32);
}

// Kanonische Kodierung des Headers fuer die associated data. Nur bereits
// gepruefte Felder (validateEnvelope) - JSON.stringify eines Arrays aus
// Strings/Zahlen ist deterministisch.
export function encodeHeader(h) {
  return JSON.stringify([PROTOCOL_VERSION, h.d, h.pn, h.n, h.k || [], h.i || '']);
}

function associatedData(state, h) {
  return concatBytes(AD_PREFIX, unb64(state.ad), utf8(encodeHeader(h)));
}

async function generateDh(rng) {
  const sk = await rng(32);
  if (!(sk instanceof Uint8Array) || sk.length !== 32) throw new RatchetError('rng', 'Zufallsquelle ungueltig');
  return { sk: b64(sk), pk: b64(x25519.getPublicKey(sk)) };
}

function dh(skB64, pkB64) {
  // getSharedSecret wirft bei Punkten kleiner Ordnung (Ergebnis 0).
  return x25519.getSharedSecret(unb64(skB64), unb64(pkB64));
}

// Reihenfolge fuer gleichzeitige Initialisierung beider Seiten (siehe
// RatchetSession.open): kleinere Kennung gewinnt - auf beiden Geraeten gleich.
export function initTag(kid, dhPub) {
  return String(kid) + '|' + String(dhPub);
}

// ─── Initialisierung (Spezifikation 3.3) ────────────────────────────────────
export async function initAlice(secretB64, { now, rng }) {
  const I = deriveInit(secretB64);
  const dhs = await generateDh(rng);
  const bobPk = b64(I.bobPk);
  // Der Startschritt mischt kein weiteres KEM-Geheimnis ein - SK stammt bereits
  // aus einem.
  const [rk, cks] = kdfRk(I.sk, dh(dhs.sk, bobPk), []);
  return {
    v: PROTOCOL_VERSION, role: 'alice', ad: b64(I.ad), rk: b64(rk),
    dhs, dhr: bobPk, cks: b64(cks), ckr: null, ns: 0, nr: 0, pn: 0,
    skipped: [], prevDhr: [], initKid: I.kid, initDh: dhs.pk, sendKids: [],
    active: false, createdAt: now,
  };
}

export function initBob(secretB64, { now }) {
  const I = deriveInit(secretB64);
  return {
    v: PROTOCOL_VERSION, role: 'bob', ad: b64(I.ad), rk: b64(I.sk),
    dhs: { sk: b64(I.bobSk), pk: b64(I.bobPk) }, dhr: null, cks: null, ckr: null,
    ns: 0, nr: 0, pn: 0, skipped: [], prevDhr: [], initKid: I.kid, initDh: null,
    sendKids: [], active: false, createdAt: now,
  };
}

// ─── Umschlag ───────────────────────────────────────────────────────────────
// { type:'ratchet', v:1, h:{ d, pn, n, k?, i? }, c }
//   d   eigener aktueller Ratchet-Public-Key (X25519, Base64)
//   pn  Laenge der vorherigen Sendekette, n Nummer in der aktuellen
//   k   Kennungen der KEM-Geheimnisse, die in den Schritt dieser Kette flossen
//   i   nur waehrend der Initialisierung: Kennung des Start-KEM-Geheimnisses
//   c   Base64(Nonce(24) || Chiffrat || Tag(16))
// Liefert eine gepruefte, kanonische Kopie des Headers.
const isCounter = (x) => Number.isInteger(x) && x >= 0 && x <= MAX_COUNTER;
export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || env.type !== 'ratchet') {
    throw new RatchetError('envelope', 'Kein Ratchet-Umschlag');
  }
  if (env.v !== PROTOCOL_VERSION) throw new RatchetError('version', 'Unbekannte Ratchet-Version');
  const h = env.h;
  if (!h || typeof h !== 'object') throw new RatchetError('header', 'Header fehlt');
  if (typeof h.d !== 'string' || !B64_32_RE.test(h.d)) throw new RatchetError('header', 'Ungueltiger Ratchet-Schluessel');
  if (!isCounter(h.pn) || !isCounter(h.n)) throw new RatchetError('header', 'Ungueltiger Zaehler');
  if (h.k !== undefined) {
    if (!Array.isArray(h.k) || h.k.length === 0 || h.k.length > MAX_HEADER_KEMS
        || !h.k.every((x) => typeof x === 'string' && KID_RE.test(x)) || new Set(h.k).size !== h.k.length) {
      throw new RatchetError('header', 'Ungueltige KEM-Kennungen');
    }
  }
  if (h.i !== undefined && (typeof h.i !== 'string' || !KID_RE.test(h.i))) {
    throw new RatchetError('header', 'Ungueltige Initialisierungs-Kennung');
  }
  if (typeof env.c !== 'string' || env.c.length < 56 || env.c.length > MAX_CIPHERTEXT_B64
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(env.c)) {
    throw new RatchetError('ciphertext', 'Ungueltiges Chiffrat');
  }
  const out = { d: h.d, pn: h.pn, n: h.n };
  if (h.k) out.k = [...h.k];
  if (h.i) out.i = h.i;
  return out;
}

// ─── Senden (RatchetEncrypt) ────────────────────────────────────────────────
// Veraendert state. Die Nonce ist zufaellig, obwohl jeder Nachrichtenschluessel
// nur einmal benutzt wird (die Spezifikation erlaubt eine abgeleitete IV):
// Wuerde ein Zustand je doppelt verwendet (z.B. Speicher zurueckgesetzt),
// entstuende mit fester Nonce eine Schluesselstrom-Wiederholung - so nicht.
export async function encrypt(state, plaintext, { rng }) {
  if (!state?.cks) throw new RatchetError('no-sending-chain', 'Keine Sendekette');
  if (state.ns >= MAX_COUNTER) throw new RatchetError('counter', 'Sendezaehler erschoepft');
  const [ck, mk] = kdfCk(unb64(state.cks));
  const h = { d: state.dhs.pk, pn: state.pn, n: state.ns };
  if (Array.isArray(state.sendKids) && state.sendKids.length) h.k = [...state.sendKids];
  if (state.role === 'alice' && !state.active && state.initKid) h.i = state.initKid;
  state.cks = b64(ck);
  state.ns += 1;
  const nonce = await rng(24);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 24) throw new RatchetError('rng', 'Zufallsquelle ungueltig');
  const ct = xchacha20poly1305(aeadKey(mk), nonce, associatedData(state, h)).encrypt(plaintext);
  mk.fill(0);
  return { type: 'ratchet', v: PROTOCOL_VERSION, h, c: b64(concatBytes(nonce, ct)) };
}

// ─── Empfangen (RatchetDecrypt) ─────────────────────────────────────────────
function pruneSkipped(state, now, maxAlterMs = SKIPPED_KEY_MAX_AGE_MS) {
  state.skipped = (state.skipped || []).filter((s) => s && now - s.t <= maxAlterMs && s.t <= now + 24 * 60 * 60 * 1000);
}

function skipMessageKeys(state, until, now) {
  if (state.nr + MAX_SKIP < until) throw new RatchetError('too-many-skipped', 'Zu viele uebersprungene Nachrichten');
  if (!state.ckr) return;
  let ck = unb64(state.ckr);
  while (state.nr < until) {
    const [next, mk] = kdfCk(ck);
    state.skipped.push({ d: state.dhr, n: state.nr, mk: b64(mk), t: now });
    ck = next;
    state.nr += 1;
  }
  state.ckr = b64(ck);
  // Gesamtvorrat begrenzen - die aeltesten fallen zuerst weg.
  if (state.skipped.length > MAX_SKIPPED_KEYS) state.skipped.splice(0, state.skipped.length - MAX_SKIPPED_KEYS);
}

function openAead(mk, nonce, ct, ad) {
  try {
    return xchacha20poly1305(aeadKey(mk), nonce, ad).decrypt(ct);
  } catch {
    throw new RatchetError('auth', 'Authentifizierung fehlgeschlagen (manipuliert oder falscher Schluessel)');
  }
}

// Veraendert state. Optionen:
//   lookupKem(kid)  -> Base64-Geheimnis oder null (von der Gegenseite referenziert)
//   takeOwnKems()   -> [{ kid, secret }] fuer den eigenen naechsten Schritt
// Liefert { plaintext, consumedKids } (verbrauchte KEM-Kennungen beider Seiten).
// maxSkippedAgeMs: wie lange gespeicherte Schluessel uebersprungener
// Nachrichten gueltig bleiben (Standard 72 h; Siegel nutzt laengere Zeit,
// weil dort oft ausser der Reihe gelesen wird).
export async function decrypt(state, envelope, { now, rng, lookupKem, takeOwnKems, maxSkippedAgeMs = SKIPPED_KEY_MAX_AGE_MS }) {
  const h = validateEnvelope(envelope);
  const raw = unb64(envelope.c);
  if (raw.length < 24 + 16) throw new RatchetError('ciphertext', 'Chiffrat zu kurz');
  const nonce = raw.subarray(0, 24);
  const ct = raw.subarray(24);
  const ad = associatedData(state, h);
  pruneSkipped(state, now, maxSkippedAgeMs);

  // 1. Gespeicherter Schluessel einer uebersprungenen Nachricht?
  const idx = state.skipped.findIndex((s) => s.d === h.d && s.n === h.n);
  if (idx >= 0) {
    const plaintext = openAead(unb64(state.skipped[idx].mk), nonce, ct, ad);
    state.skipped.splice(idx, 1); // nach Gebrauch loeschen
    return { plaintext, consumedKids: [] };
  }
  if (Array.isArray(state.prevDhr) && state.prevDhr.includes(h.d)) {
    throw new RatchetError('replay', 'Nachricht einer abgeschlossenen Kette ohne gespeicherten Schluessel (Duplikat/Replay)');
  }

  const consumedKids = [];
  if (h.d !== state.dhr) {
    // 2. Neuer Ratchet-Schluessel der Gegenseite: DH-Schritt (DHRatchet).
    const peerKems = [];
    for (const kid of h.k || []) {
      const secret = typeof lookupKem === 'function' ? lookupKem(kid) : null;
      if (!secret) throw new RatchetError('kem-unknown', 'KEM-Geheimnis der Gegenseite unbekannt');
      peerKems.push(unb64(secret));
      consumedKids.push(kid);
    }
    skipMessageKeys(state, h.pn, now);
    if (state.dhr) {
      state.prevDhr = [...(state.prevDhr || []), state.dhr].slice(-MAX_PREV_DHR);
    }
    state.pn = state.ns;
    state.ns = 0;
    state.nr = 0;
    state.dhr = h.d;
    const [rk1, ckr] = kdfRk(unb64(state.rk), dh(state.dhs.sk, state.dhr), peerKems);
    state.dhs = await generateDh(rng);
    const own = (typeof takeOwnKems === 'function' ? takeOwnKems() : null) || [];
    const [rk2, cks] = kdfRk(rk1, dh(state.dhs.sk, state.dhr), own.map((o) => unb64(o.secret)));
    state.rk = b64(rk2);
    state.ckr = b64(ckr);
    state.cks = b64(cks);
    state.sendKids = own.map((o) => o.kid);
    for (const o of own) consumedKids.push(o.kid);
  } else if (h.n < state.nr) {
    throw new RatchetError('replay', 'Nachrichtenschluessel bereits verwendet (Duplikat/Replay)');
  }
  if (!state.ckr) throw new RatchetError('no-receiving-chain', 'Keine Empfangskette');
  skipMessageKeys(state, h.n, now);
  const [ck, mk] = kdfCk(unb64(state.ckr));
  state.ckr = b64(ck);
  state.nr += 1;
  const plaintext = openAead(mk, nonce, ct, ad);
  mk.fill(0);
  return { plaintext, consumedKids };
}

// Fuer Tests/Diagnose: Anzahl gespeicherter uebersprungener Schluessel.
export function skippedCount(state) {
  return Array.isArray(state?.skipped) ? state.skipped.length : 0;
}
