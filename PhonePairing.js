/**
 * Malachi – PhonePairing.js
 *
 * Kopplung per Telefonnummer - ohne Server, nur ueber Tor. Design und
 * Bedrohungsmodell: PHONE_PAIRING_DESIGN.md.
 *
 * Zwei Menschen, die (typischerweise gerade miteinander telefonierend) die
 * Nummer des anderen kennen, geben jeweils die eigene und die des anderen ein.
 * Beide Apps leiten daraus DENSELBEN voruebergehenden Tor-Treffpunkt ab:
 *   pw     = "malachi-phone-rendezvous-v1|" + kleinere Nummer + "|" + groessere
 *            (E.164, z.B. +4917612345678)
 *   salt   = SHA-256("malachi-phone-rendezvous-v1|bucket|" + Stunde seit 1970 (UTC))
 *   master = Argon2id(pw, salt; 64 MiB, t=3, p=1)     (nativ, BouncyCastle)
 *   seed   = HKDF(master, salt, "…|onion-ed25519")    -> Ed25519 -> v3-Onion-Adresse
 *   auth   = HKDF(master, salt, "…|auth")             -> Anmeldeschluessel
 * Das Geraet mit der kleineren Nummer betreibt den Treffpunkt (nativ
 * addRendezvousOnion: ADD_ONION mit genau diesem Schluessel), das andere
 * verbindet sich ueber Tor dorthin. Beide nehmen die aktuelle UND die vorige
 * Stunde (Uhrabweichung, Start kurz vor/nach dem Stundenwechsel).
 *
 * Handshake auf dem Tor-Strom (H = Gastgeber, C = Gast), Felder Base64:
 *   H -> C  hello  nH, pkH          frischer ML-KEM-768-Schluessel
 *   C -> H  auth   nC, commit, mac  commit = SHA-256(Label | xC | ctC | rC)
 *   H -> C  keys   xH, rH, mac      erst NACHDEM C sich festgelegt hat
 *   C -> H  open   xC, ctC, rC      muss zu commit passen
 *   mac = HMAC(auth, Rolle | alles bisher)  - beweist Kenntnis beider Nummern
 *   ikm = X25519(xH, xC) || ML-KEM-Geheimnis  (hybrid: beide muessten brechen)
 *   T   = SHA-256(Label | alle Felder)
 *   Tunnelschluessel je Richtung, 6-stelliger Code, Kontakt-ID = HKDF(ikm, T, …)
 * Danach spricht H "ready" im Tunnel (Schluesselbestaetigung).
 *
 * Wer BEIDE Nummern kennt, kann den Treffpunkt ebenfalls ableiten und sich
 * dazwischensetzen. Deshalb zeigen beide Handys danach den Code; die Nutzer
 * vergleichen ihn am Telefon. Erst wenn BEIDE "Stimmt ueberein" getippt haben,
 * laeuft IM Tunnel die ganz normale Kopplung (Kyber-Schluesseltausch von
 * WebRTCManager, Profil, Onion-Adresse - TorTransport.attachPairingChannel).
 * Das Ergebnis ist ein normaler Kontakt. Wegen der Festlegung (commit vor xH/rH)
 * kann ein Mann in der Mitte die beiden Codes nicht passend machen - je Versuch
 * trifft er hoechstens mit 1 : 1.000.000, und jeder Versuch faellt auf.
 *
 * Kennung statt Nummer (Nutzerwunsch 2026-10-25): Statt zweier Telefonnummern
 * koennen beide auch zwei frei gewaehlte Kennungen eingeben (Spitzname,
 * E-Mail, Benutzername ...), je mindestens ID_MIN_LEN Zeichen. Sie werden
 * vereinheitlicht (NFKC, Leerraum zusammengefasst, Kleinschreibung) und als
 * "id:<kennung>" in dieselbe Ableitung gegeben - Nummern bleiben unveraendert
 * E.164, d.h. die Telefon-Kopplung ist mit aelteren Versionen identisch. Eine
 * Kennung beginnt nie mit "+", Nummer und Kennung koennen also nie denselben
 * Treffpunkt ergeben. Gegen einen Mann in der Mitte schuetzt in beiden Faellen
 * der Code-Vergleich. Wer beide Kennungen erraet, kann nur sehen, DASS gerade
 * gekoppelt wird, oder die Kopplung stoeren - deshalb die Mindestlaenge und der
 * Hinweis, etwas zu waehlen, das nur die beiden kennen.
 *
 * Datenschutz: die Nummern leben nur im Arbeitsspeicher (Eingabefelder,
 * Funktionsumfang dieser Sitzung bis zur Ableitung). Sie werden nie geloggt,
 * nie gespeichert, nie gesendet. Abgeleitete Schluessel werden nach Gebrauch
 * ueberschrieben (JS-Strings lassen sich nicht ueberschreiben - sie werden
 * sofort losgelassen). Der Treffpunkt wird beim ersten erfolgreichen
 * Handshake, beim Abbruch, nach Ablauf, beim Wechsel in den Hintergrund und
 * beim Wipe entfernt (DEL_ONION), alle uebrigen Verbindungen geschlossen.
 */
import { NativeModules, AppState } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { sha3_256 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import RTCStore from './RTCStore';
import { generateKyberKeypair, kyberEncapsulate, kyberDecapsulate } from './HybridCrypto';
import { secureRandomBytes } from './MessageCrypto';
import { t as tr } from './i18n';   // this.t ist hier der Tor-Zugang
import {
  ONION_RE, TorChannel, ensureTorRunning, getTorState, getOwnOnion, onTorState, onDescriptorReceived,
  claimTorConnection, setRendezvousIncomingHandler, connectRendezvous, attachPairingChannel, trustTorConnection,
} from './TorTransport';

// ── Konstanten ──────────────────────────────────────────────────────────────
export const PHONE_RENDEZVOUS_LABEL = 'malachi-phone-rendezvous-v1';
// Teil des Protokolls (beide Seiten MUESSEN gleich rechnen) - Aenderung nur mit
// neuem Label (v2). Ziel am Geraet 0,5-2 s je Lauf (Dauer steht im Logcat:
// "Argon2id (Treffpunkt): … ms").
export const PHONE_KDF = Object.freeze({ memKiB: 64 * 1024, iterations: 3, outLen: 32 });
export const PHONE_BUCKET_MS = 60 * 60 * 1000;
export const PHONE_PAIR_WINDOW_MS = 10 * 60 * 1000;
export const PHONE_COMPARE_MS = 3 * 60 * 1000;
const STEP_TIMEOUT_MS = 45000;            // je Handshake-Schritt (Tor-Rundlauf 1-5 s)
const PAIRING_TIMEOUT_MS = 45000;         // normale Kopplung im Tunnel
const CONNECT_TIMEOUT_MS = 60000;         // ein Verbindungsversuch zum Treffpunkt
const RETRY_GAP_MS = 4000;
const RETRY_GAP_NOT_FOUND_MS = 8000;      // Beschreibung (noch) nicht veroeffentlicht
const HEDGE_AFTER_MS = 20000;             // haengender Versuch: parallel einen zweiten
const TICK_MS = 1000;
const PING_MS = 10000;                    // Lebenszeichen waehrend des Code-Vergleichs
const SILENCE_MS = 45000;
const MAX_PARALLEL_HANDSHAKES = 4;
const MAX_FAILED_HANDSHAKES = 12;
const MAX_HS_LINE = 8192;
const MAX_TUNNEL_LINE = 2900000;          // < 2 MiB nativ, als Base64
const KEM_PK_LEN = 1184;
const KEM_CT_LEN = 1088;
const HS = 'malachi-phone';               // Protokollkennung der Handshake-Zeilen

export class PhonePairingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Bytes ───────────────────────────────────────────────────────────────────
const utf8 = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const hex = (u8) => Buffer.from(u8).toString('hex');
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
// Laengenpraefix: keine Mehrdeutigkeit beim Aneinanderhaengen.
function lp(u8) {
  const n = u8.length;
  return concat(Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255), u8);
}
function wipe(...arrs) {
  for (const a of arrs) { try { if (a && typeof a.fill === 'function') a.fill(0); } catch {} }
}
function equalCt(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function b64Field(value, len) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(len / 3) || !B64_RE.test(value)) return null;
  const u = Uint8Array.from(Buffer.from(value, 'base64'));
  return u.length === len ? u : null;
}
function field(msg, key, len) {
  const u = b64Field(msg?.[key], len);
  if (!u) throw new PhonePairingError('protocol', 'Ungueltiges Feld im Handshake');
  return u;
}

// ── Nummern ─────────────────────────────────────────────────────────────────
const E164_RE = /^\+[1-9][0-9]{7,14}$/;
// Laender, deren nationale Vorwahl-Null nie Teil der Nummer ist: "+49 0176 …"
// (haeufiger Tippfehler) wird zu "+49 176 …".
const TRUNK_ZERO_CC = ['49', '43', '41'];

/**
 * Telefonnummer -> E.164 ("+4917612345678") oder null.
 * Erlaubt: Leerzeichen, Bindestriche, Klammern, Punkte, Schraegstriche,
 * "+49 (0)176 …", Praefix "+" oder "00"; eine fuehrende 0 bedeutet Deutschland
 * (+49). Ohne jedes Praefix ist die Nummer mehrdeutig -> ungueltig.
 */
export function normalizePhoneNumber(raw, defaultCountryCode = '49') {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 40) return null;
  s = s.replace(/\(0\)/g, '');
  if (!/^[0-9+\s\-()./ ]+$/.test(s)) return null;
  s = s.replace(/[\s\-()./ ]/g, '');
  let digits;
  if (s.startsWith('+')) digits = s.slice(1);
  else if (s.startsWith('00')) digits = s.slice(2);
  else if (s.startsWith('0')) digits = defaultCountryCode + s.slice(1);
  else return null;
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  for (const cc of TRUNK_ZERO_CC) {
    if (digits.startsWith(cc + '0')) { digits = cc + digits.slice(cc.length + 1); break; }
  }
  const e164 = '+' + digits;
  return E164_RE.test(e164) ? e164 : null;
}

// ── Kennungen (statt Telefonnummern) ────────────────────────────────────────
export const ID_MIN_LEN = 8;
export const ID_MAX_LEN = 64;
const ID_PREFIX = 'id:';
// Steuer- und unsichtbare Formatzeichen (Bidi-Steuerung, Null-Breite, BOM ...):
// abgelehnt statt still entfernt - zwei Geraete muessen exakt dasselbe sehen.
// eslint-disable-next-line no-control-regex -- Steuerzeichen werden hier absichtlich erkannt
const ID_FORBIDDEN_RE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\uD800-\uDFFF]/;

/**
 * Freie Kennung -> "id:<vereinheitlicht>" oder null. Vereinheitlicht: NFKC,
 * Leerraum am Rand weg und innen zu einem Leerzeichen, Kleinschreibung.
 * Laenge (in Zeichen, nicht Bytes) ID_MIN_LEN..ID_MAX_LEN.
 */
export function normalizeIdentifier(raw) {
  if (typeof raw !== 'string' || raw.length > 4 * ID_MAX_LEN) return null;
  let s = typeof raw.normalize === 'function' ? raw.normalize('NFKC') : raw;
  // eslint-disable-next-line no-control-regex -- Leerraum-Steuerzeichen werden hier absichtlich zusammengefasst
  s = s.replace(/[\t\n\r\u000B\u000C\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000 ]+/g, ' ').trim();
  // Unpaarige Surrogate sind ungueltig, gepaarte (Emoji) erlaubt.
  const unpaired = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
  if (ID_FORBIDDEN_RE.test(unpaired)) return null;
  s = s.toLowerCase();
  const len = [...s].length;
  if (len < ID_MIN_LEN || len > ID_MAX_LEN) return null;
  return ID_PREFIX + s;
}

/** Eingabe je nach Art ('phone' | 'id') -> kanonische Form oder null. */
export function normalizePairingId(raw, mode = 'phone') {
  return mode === 'id' ? normalizeIdentifier(raw) : normalizePhoneNumber(raw);
}

/** Kanonische Nummer (E.164) oder kanonische Kennung ("id:..."). */
export function isPairingId(v) {
  if (typeof v !== 'string') return false;
  if (E164_RE.test(v)) return true;
  return v.startsWith(ID_PREFIX) && normalizeIdentifier(v.slice(ID_PREFIX.length)) === v;
}

/** Wer betreibt den Treffpunkt? Die kleinere Nummer (beide Seiten rechnen gleich). */
export function phoneRole(ownE164, otherE164) {
  return ownE164 < otherE164 ? 'host' : 'client';
}

/** Zeitfenster: aktuelle und vorige Stunde (UTC). */
export function phoneBuckets(now = Date.now()) {
  const b = Math.floor(now / PHONE_BUCKET_MS);
  return [b, b - 1];
}

// ── Onion-Adresse (rend-spec-v3) ────────────────────────────────────────────
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}
const ONION_CHECKSUM_LABEL = utf8('.onion checksum');

/** onion = base32(pub | SHA3-256(".onion checksum" | pub | 03)[0..2] | 03) + ".onion" */
export function onionFromPublicKey(pub) {
  if (!(pub instanceof Uint8Array) || pub.length !== 32) throw new PhonePairingError('internal', 'Ungueltiger Schluessel');
  const ver = Uint8Array.of(3);
  const chk = sha3_256(concat(ONION_CHECKSUM_LABEL, pub, ver)).slice(0, 2);
  return base32(concat(pub, chk, ver)) + '.onion';
}

/** Oeffentlicher Schluessel aus einer v3-Adresse (Pruefsumme wird geprueft) oder null. */
export function publicKeyFromOnion(onion) {
  if (!ONION_RE.test(onion || '')) return null;
  const raw = base32Decode(onion.slice(0, 56));
  if (!raw || raw.length !== 35 || raw[34] !== 3) return null;
  const pub = raw.slice(0, 32);
  return onionFromPublicKey(pub) === onion ? pub : null;
}

/**
 * Schluessel fuer tors ADD_ONION: "ED25519-V3:" + Base64 der 64-Byte-
 * "erweiterten" Form (SHA-512 des Seeds, Skalar geklemmt) - genau die Form, die
 * tor selbst speichert. Daraus rechnet tor denselben oeffentlichen Schluessel
 * wie ed25519.getPublicKey(seed).
 */
export function torKeyBlobFromSeed(seed) {
  const h = sha512(seed);
  h[0] &= 248;
  h[31] &= 63;
  h[31] |= 64;
  const blob = 'ED25519-V3:' + b64(h);
  wipe(h);
  return blob;
}

// ── Treffpunkt ableiten ─────────────────────────────────────────────────────
async function nativeArgon2id(password, salt, p) {
  const T = NativeModules.MalachiTor;
  if (typeof T?.argon2id !== 'function') throw new PhonePairingError('unsupported', 'Argon2id nicht verfuegbar');
  const out = await T.argon2id(b64(password), b64(salt), p.memKiB, p.iterations, p.outLen);
  const u = Uint8Array.from(Buffer.from(String(out || ''), 'base64'));
  if (u.length !== p.outLen) throw new PhonePairingError('internal', 'Ableitung ungueltig');
  return u;
}

/**
 * Treffpunkt fuer ein Nummernpaar und eine Stunde. Reihenfolge der Nummern
 * egal (beide Seiten erhalten dasselbe). Ergebnis:
 *   { bucket, onion, keyBlob (fuer ADD_ONION), authKey (Uint8Array) }
 * kdf(password, salt, PHONE_KDF) -> Uint8Array (Standard: nativ Argon2id).
 */
export async function deriveRendezvous(numberA, numberB, bucket, { kdf = nativeArgon2id } = {}) {
  if (!isPairingId(numberA) || !isPairingId(numberB) || numberA === numberB) {
    throw new PhonePairingError('invalid-number', 'Ungueltige Nummern');
  }
  if (!Number.isSafeInteger(bucket)) throw new PhonePairingError('internal', 'Ungueltiges Zeitfenster');
  const [lo, hi] = numberA < numberB ? [numberA, numberB] : [numberB, numberA];
  const password = utf8(PHONE_RENDEZVOUS_LABEL + '|' + lo + '|' + hi);
  const salt = sha256(utf8(PHONE_RENDEZVOUS_LABEL + '|bucket|' + bucket));
  let master = null;
  let seed = null;
  try {
    master = await kdf(password, salt, PHONE_KDF);
    if (!(master instanceof Uint8Array) || master.length < 32) throw new PhonePairingError('internal', 'Ableitung ungueltig');
    seed = hkdf(sha256, master, salt, utf8(PHONE_RENDEZVOUS_LABEL + '|onion-ed25519'), 32);
    const authKey = hkdf(sha256, master, salt, utf8(PHONE_RENDEZVOUS_LABEL + '|auth'), 32);
    const onion = onionFromPublicKey(ed25519.getPublicKey(seed));
    const keyBlob = torKeyBlobFromSeed(seed);
    return { bucket, onion, keyBlob, authKey };
  } finally {
    wipe(password, master, seed);
  }
}

// ── Handshake ───────────────────────────────────────────────────────────────
const LABEL_HS = utf8(PHONE_RENDEZVOUS_LABEL + '|handshake');
const LABEL_COMMIT = utf8(PHONE_RENDEZVOUS_LABEL + '|commit');
const ROLE_C = utf8('c-auth');
const ROLE_H = utf8('h-auth');

function commitOf(xC, ct, rC) {
  return sha256(concat(LABEL_COMMIT, lp(xC), lp(ct), lp(rC)));
}
function macC(authKey, onionB, nH, pkHash, nC, commit) {
  return hmac(sha256, authKey, concat(ROLE_C, lp(onionB), lp(nH), lp(pkHash), lp(nC), lp(commit)));
}
function macH(authKey, onionB, nH, pkHash, nC, commit, xH, rH) {
  return hmac(sha256, authKey, concat(ROLE_H, lp(onionB), lp(nH), lp(pkHash), lp(nC), lp(commit), lp(xH), lp(rH)));
}
function transcriptOf(parts) {
  return sha256(concat(LABEL_HS, ...parts.map(lp)));
}
function dhOf(sk, pk) {
  let out;
  try { out = x25519.getSharedSecret(sk, pk); } catch { throw new PhonePairingError('protocol', 'Ungueltiger Schluessel'); }
  if (out.every((b) => b === 0)) throw new PhonePairingError('protocol', 'Ungueltiger Schluessel');
  return out;
}

/** Code aus 5 Byte: 6 Ziffern "123 456" (Verzerrung durch mod < 1e-6). */
export function sasFromBytes(b) {
  let v = 0;
  for (let i = 0; i < 5; i++) v = v * 256 + b[i];
  const s = String(v % 1000000).padStart(6, '0');
  return s.slice(0, 3) + ' ' + s.slice(3);
}

function deriveSession(ikm, T) {
  const k = (info, len) => hkdf(sha256, ikm, T, utf8(PHONE_RENDEZVOUS_LABEL + '|' + info), len);
  const h2c = k('tunnel-h2c', 32);
  const c2h = k('tunnel-c2h', 32);
  const sasBytes = k('sas', 5);
  const idBytes = k('contact-id', 16);
  const code = sasFromBytes(sasBytes);
  const contactId = 'c_' + hex(idBytes);
  wipe(sasBytes, idBytes);
  return { h2c, c2h, code, contactId };
}

function expectStep(msg, step) {
  if (!msg || typeof msg !== 'object' || msg.t !== HS || msg.step !== step) {
    throw new PhonePairingError('protocol', 'Unerwarteter Handshake-Schritt');
  }
}

async function rngBytes(rng, n) {
  const r = await rng(n);
  const u = r instanceof Uint8Array ? r : Uint8Array.from(r || []);
  if (u.length !== n) throw new PhonePairingError('internal', 'Zufallsquelle ungueltig');
  return u;
}

/**
 * Gastgeber-Seite. Ablauf: hello() -> onAuth(msg) -> onOpen(msg).
 * Ergebnis von onOpen: { tx, rx, code, contactId } (tx/rx: Tunnelschluessel).
 */
export class HostHandshake {
  constructor({ onion, authKey, rng, kyber }) {
    this.onionB = utf8(onion);
    this.authKey = authKey;
    this.rng = rng;
    this.kyber = kyber;
    this.step = 'init';
  }
  async hello() {
    if (this.step !== 'init') throw new PhonePairingError('protocol', 'Handshake-Reihenfolge');
    this.step = 'busy';
    this.nH = await rngBytes(this.rng, 32);
    const kp = await this.kyber.generateKeypair();
    this.pkH = b64Field(kp?.publicKey, KEM_PK_LEN);
    if (!this.pkH || typeof kp?.secretKey !== 'string') throw new PhonePairingError('internal', 'ML-KEM-Schluessel ungueltig');
    this.skH = kp.secretKey;
    this.pkHash = sha256(this.pkH);
    this.step = 'hello';
    return { t: HS, v: 1, step: 'hello', n: b64(this.nH), kem: b64(this.pkH) };
  }
  async onAuth(msg) {
    expectStep(msg, 'auth');
    if (this.step !== 'hello') throw new PhonePairingError('protocol', 'Handshake-Reihenfolge');
    this.step = 'busy';
    const nC = field(msg, 'n', 32);
    const commit = field(msg, 'commit', 32);
    const mac = field(msg, 'mac', 32);
    if (!equalCt(macC(this.authKey, this.onionB, this.nH, this.pkHash, nC, commit), mac)) {
      throw new PhonePairingError('auth', 'Anmeldung am Treffpunkt ungueltig');
    }
    this.nC = nC;
    this.commit = commit;
    this.xSk = await rngBytes(this.rng, 32);
    this.xH = x25519.getPublicKey(this.xSk);
    this.rH = await rngBytes(this.rng, 32);
    const m = macH(this.authKey, this.onionB, this.nH, this.pkHash, nC, commit, this.xH, this.rH);
    this.step = 'keys';
    return { t: HS, step: 'keys', x: b64(this.xH), r: b64(this.rH), mac: b64(m) };
  }
  async onOpen(msg) {
    expectStep(msg, 'open');
    if (this.step !== 'keys') throw new PhonePairingError('protocol', 'Handshake-Reihenfolge');
    this.step = 'busy';
    const xC = field(msg, 'x', 32);
    const ct = field(msg, 'ct', KEM_CT_LEN);
    const rC = field(msg, 'r', 32);
    if (!equalCt(commitOf(xC, ct, rC), this.commit)) {
      throw new PhonePairingError('commit', 'Handshake passt nicht zur Festlegung');
    }
    const ss = b64Field(await this.kyber.decapsulate(b64(ct), this.skH), 32);
    this.skH = null;
    if (!ss) throw new PhonePairingError('internal', 'ML-KEM-Entkapselung ungueltig');
    const dh = dhOf(this.xSk, xC);
    const T = transcriptOf([this.onionB, this.nH, this.pkH, this.nC, this.commit, this.xH, this.rH, xC, ct, rC]);
    const ikm = concat(dh, ss);
    const s = deriveSession(ikm, T);
    wipe(dh, ss, ikm, this.xSk);
    this.step = 'done';
    return { tx: s.h2c, rx: s.c2h, code: s.code, contactId: s.contactId };
  }
  dispose() {
    wipe(this.xSk);
    this.skH = null;
    this.authKey = null;
    this.step = 'dead';
  }
}

/**
 * Gast-Seite. Ablauf: onHello(msg) -> onKeys(msg).
 * onKeys liefert { reply (open-Zeile), result: { tx, rx, code, contactId } }.
 */
export class ClientHandshake {
  constructor({ onion, authKey, rng, kyber }) {
    this.onionB = utf8(onion);
    this.authKey = authKey;
    this.rng = rng;
    this.kyber = kyber;
    this.step = 'init';
  }
  async onHello(msg) {
    expectStep(msg, 'hello');
    if (this.step !== 'init' || msg.v !== 1) throw new PhonePairingError('protocol', 'Handshake-Reihenfolge/Version');
    this.step = 'busy';
    this.nH = field(msg, 'n', 32);
    this.pkH = field(msg, 'kem', KEM_PK_LEN);
    this.pkHash = sha256(this.pkH);
    this.nC = await rngBytes(this.rng, 32);
    const enc = await this.kyber.encapsulate(b64(this.pkH));
    this.ct = b64Field(enc?.cipherText, KEM_CT_LEN);
    this.ss = b64Field(enc?.sharedSecret, 32);
    if (!this.ct || !this.ss) throw new PhonePairingError('internal', 'ML-KEM-Kapselung ungueltig');
    this.xSk = await rngBytes(this.rng, 32);
    this.xC = x25519.getPublicKey(this.xSk);
    this.rC = await rngBytes(this.rng, 32);
    this.commit = commitOf(this.xC, this.ct, this.rC);
    const m = macC(this.authKey, this.onionB, this.nH, this.pkHash, this.nC, this.commit);
    this.step = 'auth';
    return { t: HS, step: 'auth', n: b64(this.nC), commit: b64(this.commit), mac: b64(m) };
  }
  async onKeys(msg) {
    expectStep(msg, 'keys');
    if (this.step !== 'auth') throw new PhonePairingError('protocol', 'Handshake-Reihenfolge');
    this.step = 'busy';
    const xH = field(msg, 'x', 32);
    const rH = field(msg, 'r', 32);
    const mac = field(msg, 'mac', 32);
    if (!equalCt(macH(this.authKey, this.onionB, this.nH, this.pkHash, this.nC, this.commit, xH, rH), mac)) {
      throw new PhonePairingError('auth', 'Treffpunkt nicht authentisch');
    }
    const dh = dhOf(this.xSk, xH);
    const T = transcriptOf([this.onionB, this.nH, this.pkH, this.nC, this.commit, xH, rH, this.xC, this.ct, this.rC]);
    const ikm = concat(dh, this.ss);
    const s = deriveSession(ikm, T);
    const reply = { t: HS, step: 'open', x: b64(this.xC), ct: b64(this.ct), r: b64(this.rC) };
    wipe(dh, ikm, this.ss, this.xSk);
    this.step = 'done';
    return { reply, result: { tx: s.c2h, rx: s.h2c, code: s.code, contactId: s.contactId } };
  }
  dispose() {
    wipe(this.xSk, this.ss);
    this.authKey = null;
    this.step = 'dead';
  }
}

// ── Tunnel ──────────────────────────────────────────────────────────────────
// ChaCha20-Poly1305 je Richtung mit eigenem Schluessel; Nonce = Zaehler (strikt
// fortlaufend: Wiederholung, Umstellung, Auslassung oder Veraenderung einer
// Zeile -> nicht entschluesselbar -> Verbindung zu).
const TUNNEL_AD = utf8(PHONE_RENDEZVOUS_LABEL + '|tunnel');
function counterNonce(n) {
  const b = new Uint8Array(12);
  let v = n;
  for (let i = 11; i >= 4; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
  return b;
}
export function createTunnel(txKey, rxKey) {
  const tx = Uint8Array.from(txKey);
  const rx = Uint8Array.from(rxKey);
  let txN = 0;
  let rxN = 0;
  let dead = false;
  return {
    seal(text) {
      if (dead) throw new Error('Tunnel geschlossen');
      const ct = chacha20poly1305(tx, counterNonce(txN), TUNNEL_AD).encrypt(utf8(text));
      txN++;
      return b64(ct);
    },
    open(line) {
      if (dead || typeof line !== 'string' || line.length < 24 || line.length > MAX_TUNNEL_LINE || !B64_RE.test(line)) return null;
      try {
        const pt = chacha20poly1305(rx, counterNonce(rxN), TUNNEL_AD).decrypt(Uint8Array.from(Buffer.from(line, 'base64')));
        rxN++;
        return Buffer.from(pt).toString('utf8');
      } catch {
        return null;
      }
    },
    wipe() {
      dead = true;
      wipe(tx, rx);
    },
  };
}

// ── Sitzung ─────────────────────────────────────────────────────────────────
const defaultKyber = { generateKeypair: generateKyberKeypair, encapsulate: kyberEncapsulate, decapsulate: kyberDecapsulate };

// Alles, was die Sitzung von Tor braucht - in Tests ersetzbar.
function defaultTransport() {
  const T = () => NativeModules.MalachiTor;
  return {
    available: () => typeof T()?.addRendezvousOnion === 'function' && typeof T()?.argon2id === 'function',
    ensureTor: () => ensureTorRunning(),
    torOn: () => getTorState().status === 'ON',
    ownOnion: () => getOwnOnion(),
    onTorState: (fn) => onTorState(fn),
    addRendezvous: (keyBlob, onion) => T().addRendezvousOnion(keyBlob, onion),
    removeRendezvous: (onion) => Promise.resolve(T()?.removeRendezvousOnion?.(onion)),
    onIncoming: (fn) => setRendezvousIncomingHandler(fn),
    connect: (onion, timeoutMs) => connectRendezvous(onion, timeoutMs),
    claim: (connId, handlers) => claimTorConnection(connId, handlers),
    send: (connId, line) => T().send(connId, line),
    close: (connId) => { try { T()?.close(connId); } catch {} },
    trust: (connId) => trustTorConnection(connId),
    onDescriptor: (onion, fn) => onDescriptorReceived(onion, fn),
    attachPairing: (connId, tunnel, contactId, isInitiator, onPaired, onFail) =>
      attachPairingChannel(new TorChannel(connId, tunnel), contactId, isInitiator, onPaired, onFail),
  };
}

const TERMINAL = new Set(['done', 'error']);

class PhonePairingSession {
  constructor(opts) {
    this.onStateCb = typeof opts.onState === 'function' ? opts.onState : () => {};
    this.onPairedCb = typeof opts.onPaired === 'function' ? opts.onPaired : () => {};
    this.t = opts.transport || defaultTransport();
    this.kdf = opts.kdf || null;
    this.rng = opts.rng || secureRandomBytes;
    this.kyber = opts.kyber || defaultKyber;
    this.now = opts.now || (() => Date.now());
    this.windowMs = opts.windowMs || PHONE_PAIR_WINDOW_MS;
    this.compareMs = opts.compareMs || PHONE_COMPARE_MS;
    this.appState = opts.appState === undefined ? AppState : opts.appState;
    this.mode = opts.mode === 'id' ? 'id' : 'phone';   // Telefonnummern oder freie Kennungen
    this.state = { phase: 'preparing', role: null, code: null, error: null, startedAt: this.now() };
    this.finished = false;
    this.rvs = [];
    this.conns = new Map();
    this.timers = new Set();
    this.intervals = new Set();
    this.unsubs = [];
    this.failedHandshakes = 0;
    this.winner = null;
    this.localConfirmed = false;
    this.peerConfirmed = false;
    this.peerOnion = null;
    this.rtc = null;
  }

  emit(patch) {
    this.state = { ...this.state, ...patch };
    try { this.onStateCb({ ...this.state }); } catch {}
  }
  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }
  every(fn, ms) {
    const t = setInterval(fn, ms);
    this.intervals.add(t);
    return t;
  }

  async run(ownRaw, otherRaw) {
    let own = normalizePairingId(ownRaw, this.mode);
    let other = normalizePairingId(otherRaw, this.mode);
    if (!own || !other) return this.fail(this.mode === 'id' ? 'invalid-id' : 'invalid-number');
    if (own === other) return this.fail('same-number');
    this.role = phoneRole(own, other);
    this.emit({ phase: 'preparing', role: this.role });
    this.windowTimer = this.later(() => this.fail('timeout'), this.windowMs);
    if (this.appState?.addEventListener) {
      const sub = this.appState.addEventListener('change', (s) => { if (s === 'background') this.fail('background'); });
      this.unsubs.push(() => { try { sub?.remove?.(); } catch {} });
    }
    this.unsubs.push(RTCStore.onWipe((chatId) => { if (chatId == null) this.fail('wipe'); }));
    try {
      if (!this.t.available()) return this.fail('unsupported');
      const ok = await this.t.ensureTor();
      if (this.finished) return;
      if (!ok || !this.t.torOn() || !this.t.ownOnion()) return this.fail('tor');
      for (const bucket of phoneBuckets(this.now())) {
        const t0 = Date.now();
        const rv = await deriveRendezvous(own, other, bucket, this.kdf ? { kdf: this.kdf } : undefined);
        if (this.finished) { wipe(rv.authKey); return; }
        console.log('[Telefon] Treffpunkt abgeleitet (' + (Date.now() - t0) + ' ms)');
        this.rvs.push({ ...rv, up: false, inFlight: 0, handshaking: 0, lastLaunch: 0, nextAt: 0, notFound: false });
      }
    } catch (e) {
      return this.fail(e?.code === 'unsupported' ? 'unsupported' : 'internal');
    } finally {
      // Ab hier braucht die Sitzung die Nummern nicht mehr.
      own = null;
      other = null;
    }
    if (this.role === 'host') this.startHost();
    else this.startClient();
  }

  // ── Gastgeber ──
  startHost() {
    if (this.finished) return;
    this.unsubs.push(this.t.onIncoming((connId, onion) => this.onIncoming(connId, onion)));
    this.unsubs.push(this.t.onTorState((st) => { if (st?.status !== 'ON') for (const rv of this.rvs) rv.up = false; }));
    this.emit({ phase: 'waiting', startedAt: this.now() });
    console.log('[Telefon] Warte als Gastgeber am Treffpunkt');
    this.ensureServices();
    this.every(() => this.ensureServices(), TICK_MS);
  }

  async ensureServices() {
    if (this.finished || this.winner || this.adding || !this.t.torOn()) return;
    this.adding = true;
    try {
      for (const rv of this.rvs) {
        if (rv.up || !rv.keyBlob) continue;
        const got = await this.t.addRendezvous(rv.keyBlob, rv.onion);
        if (this.finished || this.winner) { this.t.removeRendezvous(rv.onion).catch(() => {}); return; }
        if (got !== rv.onion) {
          if (typeof got === 'string') this.t.removeRendezvous(got).catch(() => {});
          return this.fail('internal');
        }
        rv.up = true;
      }
    } catch (e) {
      // Naechster Versuch beim naechsten Takt (z.B. Tor startet gerade neu).
      console.warn('[Telefon] Treffpunkt noch nicht bereit:', e?.code || 'Fehler');
    } finally {
      this.adding = false;
    }
  }

  onIncoming(connId, onion) {
    const rv = this.rvs.find((r) => r.onion === onion);
    if (this.finished || this.winner || this.committed || !rv || this.conns.size >= MAX_PARALLEL_HANDSHAKES) {
      this.t.close(connId);
      return;
    }
    const hs = new HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng: this.rng, kyber: this.kyber });
    const c = this.track(connId, hs);
    this.emit({ phase: 'handshake' });
    (async () => {
      try {
        this.sendRaw(c, await hs.hello());
        const keys = await hs.onAuth(await this.nextMsg(c));
        // Audit 2026-10-19 (T2): Die Anmelde-MAC war gueltig - ab hier kennt das
        // Gegenueber den Code. Der Treffpunkt ist damit vergeben: keine weiteren
        // Handshakes, und bricht GENAU diese Verbindung ab, endet die Sitzung
        // sichtbar (sonst konnte ein Mann in der Mitte unsichtbar viele Codes
        // sammeln und nur das passende Paar zu Ende fuehren).
        this.commit(c);
        this.sendRaw(c, keys);
        const res = await hs.onOpen(await this.nextMsg(c));
        const tunnel = createTunnel(res.tx, res.rx);
        wipe(res.tx, res.rx);
        if (this.finished || this.winner || c.closed) { tunnel.wipe(); throw new PhonePairingError('late', 'zu spaet'); }
        // Schluesselbestaetigung fuer den Gast, dann Code zeigen. Ab hier ist
        // die Verbindung angemeldet: volles Zeilenlimit (Audit A2/T3).
        try { this.t.trust?.(c.connId); } catch {}
        Promise.resolve(this.t.send(c.connId, tunnel.seal(JSON.stringify({ t: 'ready' })))).catch(() => {});
        this.win(c, tunnel, res);
      } catch (e) {
        this.dropConn(c, e);
      }
    })();
  }

  // ── Gast ──
  startClient() {
    if (this.finished) return;
    for (const rv of this.rvs) {
      this.unsubs.push(this.t.onDescriptor(rv.onion, () => {
        if (!this.finished && !this.winner && rv.inFlight < 2 && !rv.handshaking) this.launch(rv);
      }));
    }
    this.emit({ phase: 'waiting', startedAt: this.now() });
    console.log('[Telefon] Suche den Treffpunkt im Tor-Netz');
    this.tickClient();
    this.every(() => this.tickClient(), TICK_MS);
  }

  tickClient() {
    if (this.finished || this.winner || !this.t.torOn()) return;
    const now = this.now();
    for (const rv of this.rvs) {
      if (rv.handshaking) continue;
      if (rv.inFlight === 0 && now >= rv.nextAt) this.launch(rv);
      else if (rv.inFlight === 1 && !rv.notFound && now - rv.lastLaunch > HEDGE_AFTER_MS) this.launch(rv);
    }
  }

  launch(rv) {
    if (this.committed) return;
    rv.inFlight++;
    rv.lastLaunch = this.now();
    Promise.resolve().then(() => this.t.connect(rv.onion, CONNECT_TIMEOUT_MS)).then((connId) => {
      rv.inFlight--;
      if (this.finished || this.winner || this.committed || rv.handshaking) { this.t.close(connId); return; }
      rv.notFound = false;
      this.runClient(connId, rv);
    }, (e) => {
      rv.inFlight--;
      rv.notFound = /nicht gefunden/.test(String(e?.message || ''));
      rv.nextAt = this.now() + (rv.notFound ? RETRY_GAP_NOT_FOUND_MS : RETRY_GAP_MS);
    });
  }

  runClient(connId, rv) {
    const hs = new ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng: this.rng, kyber: this.kyber });
    const c = this.track(connId, hs);
    rv.handshaking++;
    (async () => {
      try {
        const hello = await this.nextMsg(c);
        if (!this.winner) this.emit({ phase: 'handshake' });
        this.sendRaw(c, await hs.onHello(hello));
        const { reply, result } = await hs.onKeys(await this.nextMsg(c));
        // Audit T2: mit "open" kennt der Treffpunkt meinen Code - festgelegt.
        this.commit(c);
        this.sendRaw(c, reply);
        const tunnel = createTunnel(result.tx, result.rx);
        wipe(result.tx, result.rx);
        // Schluesselbestaetigung des Gastgebers abwarten.
        let ready = null;
        try { ready = JSON.parse(tunnel.open(await this.nextRaw(c)) || 'null'); } catch {}
        if (ready?.t !== 'ready') { tunnel.wipe(); throw new PhonePairingError('protocol', 'Keine Bestaetigung vom Treffpunkt'); }
        if (this.finished || this.winner || c.closed) { tunnel.wipe(); throw new PhonePairingError('late', 'zu spaet'); }
        this.win(c, tunnel, result);
      } catch (e) {
        // Kein sofortiger Neuversuch an derselben Adresse.
        rv.nextAt = this.now() + RETRY_GAP_MS;
        this.dropConn(c, e);
      } finally {
        rv.handshaking--;
      }
    })();
  }

  // ── Verbindungen ──
  track(connId, hs) {
    const c = { connId, hs, queue: [], waiter: null, closed: false, mode: 'handshake' };
    c.release = this.t.claim(connId, {
      onLine: (line) => this.onLine(c, line),
      onClose: () => this.onConnClosed(c),
    });
    this.conns.set(connId, c);
    return c;
  }

  onLine(c, line) {
    if (c.mode === 'tunnel') return this.onTunnelLine(line);
    if (c.waiter) { const w = c.waiter; c.waiter = null; w.resolve(line); return; }
    if (c.queue.length < 4) { c.queue.push(line); return; }
    this.dropConn(c, new PhonePairingError('protocol', 'Zu viele Zeilen'));
  }

  onConnClosed(c) {
    if (c.closed) return;
    c.closed = true;
    if (c.waiter) { const w = c.waiter; c.waiter = null; w.reject(new PhonePairingError('closed', 'Verbindung geschlossen')); }
    if (this.winner?.c === c && !this.finished) this.fail('connection');
  }

  nextRaw(c, ms = STEP_TIMEOUT_MS) {
    if (c.queue.length) return Promise.resolve(c.queue.shift());
    if (c.closed) return Promise.reject(new PhonePairingError('closed', 'Verbindung geschlossen'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.waiter = null; reject(new PhonePairingError('step-timeout', 'Zeitlimit')); }, ms);
      c.waiter = {
        resolve: (l) => { clearTimeout(timer); resolve(l); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  async nextMsg(c) {
    const line = await this.nextRaw(c);
    if (typeof line !== 'string' || line.length > MAX_HS_LINE) throw new PhonePairingError('protocol', 'Zeile zu lang');
    let msg;
    try { msg = JSON.parse(line); } catch { throw new PhonePairingError('protocol', 'Kein JSON'); }
    if (!msg || typeof msg !== 'object' || msg.t !== HS) throw new PhonePairingError('protocol', 'Fremdes Protokoll');
    return msg;
  }

  sendRaw(c, obj) {
    if (c.closed) throw new PhonePairingError('closed', 'Verbindung geschlossen');
    Promise.resolve(this.t.send(c.connId, JSON.stringify(obj))).catch(() => {});
  }

  // Ab hier gilt diese Verbindung als das Gegenueber (Audit T2): alle anderen
  // Handshakes verwerfen, keine neuen mehr annehmen bzw. starten.
  commit(c) {
    if (this.committed && this.committed !== c) throw new PhonePairingError('late', 'zu spaet');
    this.committed = c;
    for (const other of [...this.conns.values()]) if (other !== c) this.dropConn(other, null);
  }

  dropConn(c, err) {
    if (!this.conns.has(c.connId)) return;
    const warFestgelegt = this.committed === c && this.winner?.c !== c;
    this.conns.delete(c.connId);
    try { c.release?.(); } catch {}
    if (c.waiter) { const w = c.waiter; c.waiter = null; w.reject(new PhonePairingError('closed', 'verworfen')); }
    if (!c.closed) { c.closed = true; this.t.close(c.connId); }
    try { c.hs?.dispose(); } catch {}
    const code = err?.code;
    if (warFestgelegt && !this.finished) {
      // Die Verbindung, die den Code schon kennt, ist vor dem Vergleich
      // abgebrochen - nicht still neu versuchen (Audit T2).
      this.fail('interrupted');
      return;
    }
    if (code && code !== 'late' && !this.finished) {
      console.log('[Telefon] Verbindung am Treffpunkt verworfen (' + code + ')');
      if (code === 'auth' || code === 'commit' || code === 'protocol') {
        this.failedHandshakes++;
        if (this.failedHandshakes >= MAX_FAILED_HANDSHAKES) { this.fail('auth-flood'); return; }
      }
      if (!this.winner && this.conns.size === 0 && this.state.phase === 'handshake') this.emit({ phase: 'waiting' });
    }
  }

  // ── Treffer: Code vergleichen ──
  win(c, tunnel, res) {
    if (this.finished || this.winner) { tunnel.wipe(); this.dropConn(c, null); return; }
    this.winner = { c, tunnel, code: res.code, contactId: res.contactId };
    // Das Suchfenster ist erfuellt - ab jetzt gilt die Frist fuer den Vergleich.
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.timers.delete(this.windowTimer); this.windowTimer = null; }
    try { c.hs?.dispose(); } catch {}
    c.hs = null;
    for (const other of [...this.conns.values()]) if (other !== c) this.dropConn(other, null);
    // Treffpunkt sofort weg - niemand soll sich mehr dort melden koennen.
    this.removeServices();
    this.wipeRendezvous();
    c.mode = 'tunnel';
    this.lastRx = this.now();
    const queued = c.queue.splice(0);
    console.log('[Telefon] Gegenueber gefunden - Code vergleichen');
    this.emit({ phase: 'compare', code: res.code });
    this.later(() => {
      if (!this.finished && (this.state.phase === 'compare' || this.state.phase === 'confirm-wait')) this.fail('compare-timeout');
    }, this.compareMs);
    this.pingTimer = this.every(() => {
      if (this.now() - this.lastRx > SILENCE_MS) { this.fail('connection'); return; }
      this.sendTunnel({ t: 'ping' });
    }, PING_MS);
    for (const line of queued) this.onTunnelLine(line);
  }

  sendTunnel(obj) {
    const w = this.winner;
    if (!w || w.c.closed) return false;
    try {
      Promise.resolve(this.t.send(w.c.connId, w.tunnel.seal(JSON.stringify(obj)))).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  onTunnelLine(line) {
    const w = this.winner;
    if (!w || this.finished) return;
    const text = w.tunnel.open(line);
    if (text === null) { this.fail('connection'); return; }
    let m = null;
    try { m = JSON.parse(text); } catch {}
    this.lastRx = this.now();
    switch (m?.t) {
      case 'ping':
      case 'ready':
        return;
      case 'confirm':
        if (this.peerConfirmed) return;
        if (!ONION_RE.test(m.onion || '') || m.onion === this.t.ownOnion()) { this.fail('protocol'); return; }
        this.peerConfirmed = true;
        this.peerOnion = m.onion;
        if (this.localConfirmed) this.startNormalPairing();
        else this.emit({ peerConfirmed: true });
        return;
      case 'abort':
        this.fail('peer-abort');
        return;
      default:
        this.fail('protocol');
    }
  }

  /** Nutzer hat verglichen: true = "Stimmt ueberein", false = "Stimmt nicht". */
  confirm(match) {
    if (this.finished || !this.winner || this.localConfirmed || this.state.phase !== 'compare') return;
    if (match !== true) {
      this.sendTunnel({ t: 'abort', why: 'mismatch' });
      this.fail('mismatch');
      return;
    }
    const own = this.t.ownOnion();
    if (!ONION_RE.test(own || '')) { this.fail('tor'); return; }
    this.localConfirmed = true;
    // Lebenszeichen laufen weiter, bis beide bestaetigt haben (die Gegenseite
    // wartet evtl. noch auf ihren Nutzer); ein danach noch eintreffendes
    // verwirft der Tunnel-Kanal (siehe startNormalPairing).
    this.sendTunnel({ t: 'confirm', onion: own });
    if (this.peerConfirmed) this.startNormalPairing();
    else this.emit({ phase: 'confirm-wait' });
  }

  // ── Beide bestaetigt: normale Kopplung im Tunnel ──
  startNormalPairing() {
    if (this.finished || this.state.phase === 'pairing') return;
    const w = this.winner;
    if (!w || w.c.closed) { this.fail('connection'); return; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.intervals.delete(this.pingTimer); this.pingTimer = null; }
    this.emit({ phase: 'pairing' });
    console.log('[Telefon] Code bestaetigt - Kontakt wird eingerichtet');
    // Zeilen gehen ab jetzt an den Tunnel-Kanal (TorTransport.channels). Ein
    // spaetes Lebenszeichen/Abbruch der Gegenseite ist kein Kopplungsinhalt.
    w.c.mode = 'channel';
    try { w.c.release?.(); } catch {}
    const tunnel = w.tunnel;
    const filtered = {
      seal: (text) => tunnel.seal(text),
      open: (line) => {
        const text = tunnel.open(line);
        if (text !== null && text.startsWith('{"t":')) return undefined;
        return text;
      },
      wipe: () => tunnel.wipe(),
    };
    w.channelOwnsTunnel = true;
    this.later(() => { if (!this.finished) this.fail('connection'); }, PAIRING_TIMEOUT_MS);
    const isInitiator = this.role === 'client';
    try {
      this.rtc = this.t.attachPairing(w.c.connId, filtered, w.contactId, isInitiator,
        (rtc) => this.onNormalPaired(rtc),
        () => { if (!this.finished) this.fail('connection'); });
    } catch {
      this.fail('internal');
    }
  }

  onNormalPaired(rtc) {
    if (this.finished) { try { rtc?.close?.(); } catch {} return; }
    const w = this.winner;
    const contact = {
      id: w.contactId, name: tr('connect.newContact'), initials: 'N', color: '#0A2340', tc: '#0A7EA4',
      last: tr('connect.connectedViaTor'), time: tr('connect.now'), unread: 0,
      // Wie bei der Einladung: der Gastgeber entspricht dem Einladenden.
      role: this.role === 'host' ? 'initiator' : 'responder',
      torOnion: this.peerOnion,
    };
    this.finished = true;
    this.succeeded = true;
    this.cleanup();
    this.emit({ phase: 'done', code: null });
    console.log('[Telefon] ✅ Kopplung per Telefonnummer abgeschlossen');
    try { this.onPairedCb(contact, rtc); } catch (e) { console.warn('[Telefon] Uebergabe fehlgeschlagen:', e?.message || e); }
  }

  // ── Ende ──
  fail(code) {
    if (this.finished) return;
    this.finished = true;
    this.cleanup(code);
    this.emit({ phase: 'error', error: code, code: null });
    console.log('[Telefon] Kopplung beendet (' + code + ')');
  }

  cancel(reason = 'cancelled') {
    this.fail(reason === 'background' || reason === 'wipe' ? reason : 'cancelled');
  }

  removeServices() {
    if (this.role !== 'host') return;
    for (const rv of this.rvs) {
      rv.up = false;
      Promise.resolve().then(() => this.t.removeRendezvous(rv.onion)).catch(() => {});
    }
  }

  wipeRendezvous() {
    for (const rv of this.rvs) {
      wipe(rv.authKey);
      rv.authKey = null;
      rv.keyBlob = null;
    }
  }

  cleanup(failCode = null) {
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.intervals) clearInterval(t);
    this.timers.clear();
    this.intervals.clear();
    this.pingTimer = null;
    for (const u of this.unsubs.splice(0)) { try { u?.(); } catch {} }
    this.removeServices();
    this.wipeRendezvous();
    const w = this.winner;
    for (const c of [...this.conns.values()]) {
      if (this.succeeded && w && c === w.c) { this.conns.delete(c.connId); continue; }
      if (w && c === w.c && failCode === 'mismatch') {
        // Abbruchzeile noch rausgehen lassen, dann schliessen.
        this.conns.delete(c.connId);
        try { c.release?.(); } catch {}
        setTimeout(() => { if (!c.closed) { c.closed = true; this.t.close(c.connId); } }, 500);
        continue;
      }
      this.dropConn(c, null);
    }
    if (w && !this.succeeded) {
      if (this.rtc) {
        try { this.rtc.close('wipe'); } catch {}
        this.discardOrphan(w.contactId);
      } else if (!w.channelOwnsTunnel) {
        w.tunnel.wipe();
      }
      if (!w.c.closed && failCode !== 'mismatch') { w.c.closed = true; this.t.close(w.c.connId); }
    }
    this.rvs = [];
  }

  // Abbruch NACH Beginn der normalen Kopplung, aber vor der Uebergabe: ein evtl.
  // schon gespeichertes Geheimnis gehoert zu keinem Kontakt - weg damit.
  discardOrphan(contactId) {
    try { RTCStore.sharedSecrets.delete(contactId); RTCStore.previousSecrets?.delete(contactId); } catch {}
    EncryptedStorage.removeItem('shared_secret_' + contactId).catch(() => {});
    EncryptedStorage.removeItem('shared_secret_prev_' + contactId).catch(() => {});
    Promise.resolve().then(() => RTCStore.dropPersistedContactData(contactId)).catch(() => {});
  }
}

/**
 * Startet eine Kopplung per Telefonnummer.
 *   ownNumber, otherNumber  Eingaben (werden hier normalisiert, nie gespeichert)
 *   onState(state)          { phase, role, code, error, startedAt }
 *                           phase: preparing | waiting | handshake | compare |
 *                                  confirm-wait | pairing | done | error
 *   onPaired(contact, rtc)  fertiger, normaler Kontakt + laufende Verbindung
 * Rueckgabe: { cancel(), confirm(match) }.
 * Optionen fuer Tests: transport, kdf, rng, kyber, now, windowMs, compareMs, appState.
 */
export function startPhonePairing({ ownNumber, otherNumber, onState, onPaired, ...opts } = {}) {
  const s = new PhonePairingSession({ onState, onPaired, ...opts });
  s.run(ownNumber, otherNumber).catch(() => s.fail('internal'));
  return {
    cancel: (reason) => s.cancel(reason),
    confirm: (match) => s.confirm(match),
    get phase() { return s.state.phase; },
    get finished() { return s.finished || TERMINAL.has(s.state.phase); },
  };
}
