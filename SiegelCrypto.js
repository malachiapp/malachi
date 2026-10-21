/**
 * Malachi – SiegelCrypto.js
 *
 * Siegel-Modus (SIEGEL_DESIGN.md): Ende-zu-Ende-Verschluesselung von Texten,
 * die ueber einen FREMDEN Messenger (WhatsApp & Co.) transportiert werden.
 * Diese Datei enthaelt nur reine Funktionen - Speicherung und Schutz der
 * Schluessel uebernimmt SiegelVault.js. Klartext wird hier nie gespeichert.
 *
 * Kopplung (persoenlich, zwei QR-Codes, nichts laeuft ueber ein Netz):
 *   A zeigt die EINLADUNG
 *     MSI1:<base32( 0x01 | nonceA(16) | xA(32) | kemPkA(1184) )>
 *   B scannt und rechnet
 *     ct, ss = ML-KEM-768.Encaps(kemPkA)            (nativ, KyberModule)
 *     dh     = X25519(xB, xA)
 *     T      = SHA-256("malachi-siegel-v1" | nonceA | xA | kemPkA | xB | ct)
 *     root   = HKDF-SHA256(ikm = dh || ss, salt = T, info = "...-root")
 *   B wird "Alice" des Double Ratchet (DoubleRatchet.js) und legt seine erste
 *   (leere) Nachricht gleich in die ANTWORT - so kann danach JEDE Seite zuerst
 *   schreiben. B zeigt die ANTWORT
 *     MSA1:<base32( 0x02 | xB(32) | ct(1088) | conf(16) | erste Nachricht )>
 *   A scannt: Decaps, dh, T, root, Bestaetigung pruefen, "Bob" initialisieren,
 *   erste Nachricht oeffnen. Hybrid: ein Angreifer muesste X25519 UND
 *   ML-KEM-768 brechen. Sicherheitscode (6 x 5 Ziffern aus T) zum Vergleichen.
 *
 * Nachricht:
 *   MS1:<base64url( 0x01 | d(32) | pn(u32) | n(u32) | nonce(24) | ct )>
 *   Klartext vor dem Verschluesseln: u32 Laenge | UTF-8 | Nullen bis zur
 *   naechsten festen Groesse (64/256/1024/4096/16384/65536 Byte) - die Laenge
 *   verraet nur noch eine grobe Groessenklasse.
 *
 * Anhang (Bild, Sprachnachricht, Datei) - eine Datei statt Text:
 *   'MSF1' | u32 Kopflaenge | Kopf | Blob
 *   Kopf = Ratchet-Umschlag wie der MS1-Rumpf; Klartext = aufgefuelltes JSON
 *          { t:'media', k, m, n, s, key, h } (Art, MIME-Typ, Name, Groesse,
 *          zufaelliger Dateischluessel, SHA-256 des Blobs)
 *   Blob = nonce(24) | XChaCha20-Poly1305(Dateischluessel, Inhalt + Nullen bis
 *          zur naechsten Groessenklasse (Padme), AD "malachi-siegel-media-v1")
 *   Art, Typ und Name stehen nur im verschluesselten Kopf.
 *
 * Grenzen (bewusst, siehe Design): die Ratchet-Schritte nach der Kopplung sind
 * klassisch (X25519) - ML-KEM schuetzt den Startschluessel. Eine entschluesselte
 * Nachricht laesst sich nicht erneut entschluesseln (Zero Trace).
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { Buffer } from 'buffer';
import { initAlice, initBob, encrypt as drEncrypt, decrypt as drDecrypt, PROTOCOL_VERSION } from './DoubleRatchet';

export const INVITE_PREFIX = 'MSI1:';
export const ACK_PREFIX = 'MSA1:';
export const MESSAGE_PREFIX = 'MS1:';
// Gespeicherte Schluessel uebersprungener Siegel-Nachrichten: 90 Tage statt
// der 72 h des Chats - bei WhatsApp & Co. wird oft ausser der Reihe gelesen
// (Audit 2026-10-19, C2).
export const SIEGEL_SKIPPED_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const T_INVITE = 0x01;
const T_ACK = 0x02;
const MSG_VERSION = 0x01;
const NONCE_LEN = 16;
const X_LEN = 32;
const KEM_PK_LEN = 1184;
const KEM_CT_LEN = 1088;
const CONF_LEN = 16;
const INVITE_LEN = 1 + NONCE_LEN + X_LEN + KEM_PK_LEN;
const ENV_FIXED = 1 + 32 + 4 + 4;
const MIN_C_LEN = 24 + 16;
export const PAD_BUCKETS = [64, 256, 1024, 4096, 16384, 65536];
export const MAX_TEXT_BYTES = PAD_BUCKETS[PAD_BUCKETS.length - 1] - 4;
const MAX_MESSAGE_CHARS = 100000;

const utf8 = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => Uint8Array.from(Buffer.from(String(s), 'base64'));
const LABEL = utf8('malachi-siegel-v1');
const INFO_ROOT = utf8('malachi-siegel-v1-root');
const INFO_CONFIRM = utf8('malachi-siegel-v1-confirm');
const SAFETY_LABEL = utf8('malachi-siegel-v1-safety');
const ZERO_SALT = new Uint8Array(32);

export class SiegelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function u32(n) { return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
function readU32(b, off) { return ((b[off] << 24) >>> 0) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3]; }
function wipe(...arrs) { for (const a of arrs) { try { a?.fill?.(0); } catch {} } }
function equalCt(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function randomBytes(rng, n) {
  const r = await rng(n);
  const u = r instanceof Uint8Array ? r : Uint8Array.from(r || []);
  if (u.length !== n) throw new SiegelError('rng', 'Zufallsquelle ungueltig');
  return u;
}

// ─── Base32 (RFC 4648, ohne Auffuellung) - nur A-Z2-7: der QR-Code nutzt dann
// den kompakteren alphanumerischen Modus.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const s = String(text).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z2-7]*$/.test(s)) throw new SiegelError('format', 'Ungueltige Zeichen');
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out[idx++] = (value >>> (bits - 8)) & 255; bits -= 8; }
  }
  return out;
}
const b64url = (u8) => Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new SiegelError('format', 'Ungueltige Zeichen');
  return Uint8Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

// ─── Ableitungen ────────────────────────────────────────────────────────────
function transcript(nonceA, xA, kemPkA, xB, ct) {
  return sha256(concatBytes(LABEL, nonceA, xA, kemPkA, xB, ct));
}
function confirmTag(root) {
  const k = hkdf(sha256, root, ZERO_SALT, INFO_CONFIRM, 32);
  const tag = hmac(sha256, k, utf8('B')).slice(0, CONF_LEN);
  wipe(k);
  return tag;
}
// Sicherheitscode wie bei Signal: 6 Bloecke zu je 5 Ziffern (5 Byte mod 100000).
export function safetyCodeFromTranscript(T) {
  const d = sha256(concatBytes(SAFETY_LABEL, T));
  const groups = [];
  for (let i = 0; i < 6; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 256 + d[i * 5 + j];
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ─── Kopplung ───────────────────────────────────────────────────────────────
// kyber: { generateKeypair, encapsulate, decapsulate } (NativeModules.KyberModule)
export async function createInvite({ rng, kyber }) {
  const nonce = await randomBytes(rng, NONCE_LEN);
  const xSk = await randomBytes(rng, X_LEN);
  const xPk = x25519.getPublicKey(xSk);
  const kp = await kyber.generateKeypair();
  const kemPk = unb64(kp?.publicKey || '');
  if (kemPk.length !== KEM_PK_LEN) throw new SiegelError('kem', 'ML-KEM-Schluessel ungueltig');
  const qr = INVITE_PREFIX + base32Encode(concatBytes(Uint8Array.of(T_INVITE), nonce, xPk, kemPk));
  // Geheimteil bleibt NUR im Arbeitsspeicher, bis die Antwort gescannt ist.
  return { qr, secret: { nonce: b64(nonce), xSk: b64(xSk), xPk: b64(xPk), kemPk: kp.publicKey, kemSk: kp.secretKey } };
}

export function parseInvite(text) {
  const s = String(text || '').trim();
  if (!s.startsWith(INVITE_PREFIX)) throw new SiegelError('format', 'Kein Siegel-Einladungscode');
  const raw = base32Decode(s.slice(INVITE_PREFIX.length));
  if (raw.length !== INVITE_LEN || raw[0] !== T_INVITE) throw new SiegelError('format', 'Einladungscode beschaedigt');
  let off = 1;
  const nonce = raw.slice(off, off += NONCE_LEN);
  const xPk = raw.slice(off, off += X_LEN);
  const kemPk = raw.slice(off, off += KEM_PK_LEN);
  return { nonce, xPk, kemPk };
}

export async function acceptInvite(inviteText, { rng, kyber, now = Date.now() }) {
  const inv = parseInvite(inviteText);
  const xSk = await randomBytes(rng, X_LEN);
  const xPk = x25519.getPublicKey(xSk);
  const enc = await kyber.encapsulate(b64(inv.kemPk));
  const ct = unb64(enc?.cipherText || '');
  const ss = unb64(enc?.sharedSecret || '');
  if (ct.length !== KEM_CT_LEN || ss.length < 32) throw new SiegelError('kem', 'ML-KEM-Kapselung ungueltig');
  let dhOut;
  try { dhOut = x25519.getSharedSecret(xSk, inv.xPk); } catch { throw new SiegelError('format', 'Einladungscode ungueltig'); }
  const T = transcript(inv.nonce, inv.xPk, inv.kemPk, xPk, ct);
  const root = hkdf(sha256, concatBytes(dhOut, ss), T, INFO_ROOT, 32);
  const conf = confirmTag(root);
  const state = await initAlice(b64(root), { now, rng });
  state.initKid = null;   // kein gleichzeitiger Start wie in RatchetSession - Header ohne "i"
  const first = await drEncrypt(state, padText(''), { rng });
  const qr = ACK_PREFIX + base32Encode(concatBytes(Uint8Array.of(T_ACK), xPk, ct, conf, encodeEnvelope(first)));
  const safety = safetyCodeFromTranscript(T);
  wipe(xSk, dhOut, ss, root);
  return { qr, contact: { ratchet: state, safety, createdAt: now } };
}

export async function completeInvite(secret, ackText, { rng, kyber, now = Date.now() }) {
  const s = String(ackText || '').trim();
  if (!s.startsWith(ACK_PREFIX)) throw new SiegelError('format', 'Kein Siegel-Antwortcode');
  const raw = base32Decode(s.slice(ACK_PREFIX.length));
  if (raw.length < 1 + X_LEN + KEM_CT_LEN + CONF_LEN + ENV_FIXED + MIN_C_LEN || raw[0] !== T_ACK) {
    throw new SiegelError('format', 'Antwortcode beschaedigt');
  }
  let off = 1;
  const xB = raw.slice(off, off += X_LEN);
  const ct = raw.slice(off, off += KEM_CT_LEN);
  const conf = raw.slice(off, off += CONF_LEN);
  const firstBin = raw.slice(off);
  const ss = unb64(await kyber.decapsulate(b64(ct), secret.kemSk) || '');
  const xSk = unb64(secret.xSk);
  let dhOut;
  try { dhOut = x25519.getSharedSecret(xSk, xB); } catch { throw new SiegelError('format', 'Antwortcode ungueltig'); }
  const T = transcript(unb64(secret.nonce), unb64(secret.xPk), unb64(secret.kemPk), xB, ct);
  const root = hkdf(sha256, concatBytes(dhOut, ss), T, INFO_ROOT, 32);
  const expected = confirmTag(root);
  wipe(dhOut, ss, xSk);
  if (!equalCt(conf, expected)) {
    wipe(root);
    throw new SiegelError('confirm', 'Antwort passt nicht zu dieser Einladung');
  }
  const state = initBob(b64(root), { now });
  wipe(root);
  try {
    await drDecrypt(state, decodeEnvelope(firstBin), { now, rng, lookupKem: () => null, takeOwnKems: () => [] });
  } catch {
    throw new SiegelError('confirm', 'Antwortcode beschaedigt');
  }
  return { contact: { ratchet: state, safety: safetyCodeFromTranscript(T), createdAt: now } };
}

// ─── Nachrichten ────────────────────────────────────────────────────────────
export function padText(text) {
  const bytes = utf8(text);
  if (bytes.length > MAX_TEXT_BYTES) throw new SiegelError('too-long', 'Text zu lang');
  const size = PAD_BUCKETS.find((b) => b >= bytes.length + 4);
  const out = new Uint8Array(size);
  out.set(u32(bytes.length), 0);
  out.set(bytes, 4);
  wipe(bytes);
  return out;
}
export function unpadText(pt) {
  if (!(pt instanceof Uint8Array) || pt.length < 4 || !PAD_BUCKETS.includes(pt.length)) throw new SiegelError('format', 'Ungueltiger Inhalt');
  const len = readU32(pt, 0);
  if (4 + len > pt.length) throw new SiegelError('format', 'Ungueltiger Inhalt');
  return Buffer.from(pt.subarray(4, 4 + len)).toString('utf8');
}

function encodeEnvelope(env) {
  if (env?.h?.k || env?.h?.i) throw new SiegelError('internal', 'Unerwarteter Ratchet-Header');
  const d = unb64(env.h.d);
  const c = unb64(env.c);
  if (d.length !== 32) throw new SiegelError('internal', 'Ratchet-Schluessel ungueltig');
  return concatBytes(Uint8Array.of(MSG_VERSION), d, u32(env.h.pn), u32(env.h.n), c);
}
function decodeEnvelope(bin) {
  if (!(bin instanceof Uint8Array) || bin.length < ENV_FIXED + MIN_C_LEN || bin[0] !== MSG_VERSION) {
    throw new SiegelError('format', 'Keine gueltige Siegel-Nachricht');
  }
  const d = bin.slice(1, 33);
  const pn = readU32(bin, 33);
  const n = readU32(bin, 37);
  return { type: 'ratchet', v: PROTOCOL_VERSION, h: { d: b64(d), pn, n }, c: b64(bin.slice(ENV_FIXED)) };
}

// Art eines Siegel-Texts (z.B. im Malachi-Chat): 'invite' | 'ack' | 'msg' | null.
export function siegelKind(text) {
  const s = String(text || '').trim();
  if (s.startsWith(INVITE_PREFIX)) return 'invite';
  if (s.startsWith(ACK_PREFIX)) return 'ack';
  return extractMessage(s) ? 'msg' : null;
}

// Sucht eine Siegel-Nachricht in eingefuegtem Text (z.B. mit Zeilenumbruechen
// oder Zusatztext aus dem Messenger). null, wenn keine enthalten ist.
export function extractMessage(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const i = s.indexOf(MESSAGE_PREFIX);
  if (i < 0) return null;
  const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i + MESSAGE_PREFIX.length));
  return m ? MESSAGE_PREFIX + m[0] : null;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// Verschluesselt text fuer den Kontakt. Arbeitet auf einer Kopie: der neue
// Zustand muss gespeichert sein, BEVOR die Nachricht weitergegeben wird.
export async function sealText(ratchet, text, { rng }) {
  const st = clone(ratchet);
  const env = await drEncrypt(st, padText(text), { rng });
  return { message: MESSAGE_PREFIX + b64url(encodeEnvelope(env)), ratchet: st };
}

// Entschluesselt eine Nachricht. Fehler (code): 'format' kein Siegel-Text,
// 'used' bereits entschluesselt (Zero Trace - nicht wiederholbar), 'auth'
// nicht fuer diesen Kontakt oder veraendert.
export async function openText(ratchet, messageText, { rng, now = Date.now() }) {
  const m = extractMessage(messageText);
  if (!m || m.length > MAX_MESSAGE_CHARS) throw new SiegelError('format', 'Keine Siegel-Nachricht gefunden');
  const env = decodeEnvelope(unb64url(m.slice(MESSAGE_PREFIX.length)));
  const st = clone(ratchet);
  let plaintext;
  try {
    ({ plaintext } = await drDecrypt(st, env, { now, rng, lookupKem: () => null, takeOwnKems: () => [], maxSkippedAgeMs: SIEGEL_SKIPPED_MAX_AGE_MS }));
  } catch (e) {
    // Bereits entschluesselt ODER zu alt (Schluessel nach SIEGEL_SKIPPED_MAX_AGE_MS
    // verworfen) - beides sieht der Ratchet gleich (Audit 2026-10-19, C2).
    if (e?.code === 'replay') throw new SiegelError('used', 'Diese Nachricht wurde bereits entschluesselt oder ist zu alt (aeltere Nachrichten lassen sich nach 90 Tagen nicht mehr oeffnen)');
    throw new SiegelError('auth', 'Nachricht passt nicht zu diesem Kontakt oder wurde veraendert');
  }
  const text = unpadText(plaintext);
  wipe(plaintext);
  // Kopf eines Siegel-Anhangs als Text untergeschoben (z.B. vom Messenger
  // umverpackt): nicht als Nachricht anzeigen - der Zustand bleibt unveraendert.
  if (text.startsWith(MEDIA_JSON_START)) throw new SiegelError('format', 'Das ist ein Siegel-Anhang, keine Nachricht');
  return { text, ratchet: st };
}

// ─── Anhaenge (Bild, Sprachnachricht, Datei) ────────────────────────────────
export const MEDIA_MAGIC = 'MSF1';
export const MEDIA_KINDS = ['image', 'audio', 'file'];
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_MEDIA_NAME = 100;
const MEDIA_MAGIC_BYTES = utf8(MEDIA_MAGIC);
const MEDIA_AD = utf8('malachi-siegel-media-v1');
const MEDIA_JSON_START = '{"t":"media"';
const MEDIA_NONCE_LEN = 24;
const MEDIA_TAG_LEN = 16;
const MEDIA_MIN_PAD = 1024;
const MEDIA_PREFIX_LEN = 4 + 4;
const MAX_MEDIA_HEADER = ENV_FIXED + 24 + PAD_BUCKETS[PAD_BUCKETS.length - 1] + 16;

// Groessenklasse des Blob-Inhalts (Padme): hoechstens ~12 % Aufschlag, sichtbar
// bleibt nur noch eine grobe Groesse statt der genauen Byte-Zahl.
export function mediaPadLen(n) {
  if (n <= MEDIA_MIN_PAD) return MEDIA_MIN_PAD;
  let e = 0;
  while (2 ** (e + 1) <= n) e++;
  let s = 1;
  while (2 ** s <= e) s++;
  const step = 2 ** (e - s);
  return Math.ceil(n / step) * step;
}
const MAX_MEDIA_FILE = MEDIA_PREFIX_LEN + MAX_MEDIA_HEADER + MEDIA_NONCE_LEN + mediaPadLen(MAX_MEDIA_BYTES) + MEDIA_TAG_LEN;

function asBytes(b) {
  if (!(b instanceof Uint8Array)) return null;
  // Buffer (Polyfill) ist ein Uint8Array mit anderem slice() - als schlichte Sicht verwenden.
  return b.constructor === Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
// Name/Typ kommen vom Kontakt - nie als Pfad oder Steuerzeichen verwenden.
export function cleanMediaName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f\/\\]/g, '').trim().slice(0, MAX_MEDIA_NAME);
  return n || 'Datei';
}
export function cleanMime(mime) {
  const m = String(mime || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(m) ? m : 'application/octet-stream';
}

// Siegel-Datei (Anhang)? Prueft nur die Kennung - nicht, ob sie zu einem Kontakt passt.
export function isSiegelMedia(bytes) {
  const u = asBytes(bytes);
  if (!u || u.length < MEDIA_PREFIX_LEN + ENV_FIXED + MIN_C_LEN + MEDIA_NONCE_LEN + MEDIA_TAG_LEN) return false;
  for (let i = 0; i < MEDIA_MAGIC_BYTES.length; i++) if (u[i] !== MEDIA_MAGIC_BYTES[i]) return false;
  return true;
}

// Verschluesselt einen Anhang { kind, mime, name, bytes } fuer den Kontakt.
// Wie sealText auf einer Kopie des Zustands: der neue Zustand muss gespeichert
// sein, BEVOR die Datei weitergegeben wird.
export async function sealMedia(ratchet, media, { rng }) {
  const kind = media?.kind;
  if (!MEDIA_KINDS.includes(kind)) throw new SiegelError('format', 'Unbekannte Anhang-Art');
  const bytes = asBytes(media?.bytes);
  if (!bytes) throw new SiegelError('format', 'Kein Inhalt');
  if (bytes.length > MAX_MEDIA_BYTES) throw new SiegelError('too-long', 'Datei zu gross');
  const fileKey = await randomBytes(rng, 32);
  const nonce = await randomBytes(rng, MEDIA_NONCE_LEN);
  const padLen = mediaPadLen(bytes.length);
  const blob = new Uint8Array(MEDIA_NONCE_LEN + padLen + MEDIA_TAG_LEN);
  blob.set(nonce, 0);
  const body = blob.subarray(MEDIA_NONCE_LEN);
  body.set(bytes, 0);                                   // Rest bleibt Null = Auffuellung
  xchacha20poly1305(fileKey, nonce, MEDIA_AD).encrypt(body.subarray(0, padLen), body);
  const meta = JSON.stringify({
    t: 'media', k: kind, m: cleanMime(media.mime), n: cleanMediaName(media.name),
    s: bytes.length, key: b64(fileKey), h: b64(sha256(blob)),
  });
  wipe(fileKey);
  const st = clone(ratchet);
  const env = await drEncrypt(st, padText(meta), { rng });
  const header = encodeEnvelope(env);
  const file = new Uint8Array(MEDIA_PREFIX_LEN + header.length + blob.length);
  file.set(MEDIA_MAGIC_BYTES, 0);
  file.set(u32(header.length), 4);
  file.set(header, MEDIA_PREFIX_LEN);
  file.set(blob, MEDIA_PREFIX_LEN + header.length);
  return { file, ratchet: st };
}

// Entschluesselt einen Anhang -> { kind, mime, name, bytes, ratchet }. Fehler
// wie openText: 'format' keine/kaputte Siegel-Datei, 'used' bereits geoeffnet,
// 'auth' nicht fuer diesen Kontakt oder veraendert, 'too-long' zu gross.
export async function openMedia(ratchet, fileBytes, { rng, now = Date.now() }) {
  const u = asBytes(fileBytes);
  if (!u || !isSiegelMedia(u)) throw new SiegelError('format', 'Keine Siegel-Datei');
  if (u.length > MAX_MEDIA_FILE) throw new SiegelError('too-long', 'Siegel-Datei zu gross');
  const hLen = readU32(u, 4);
  if (hLen < ENV_FIXED + MIN_C_LEN || hLen > MAX_MEDIA_HEADER
    || MEDIA_PREFIX_LEN + hLen + MEDIA_NONCE_LEN + MEDIA_TAG_LEN > u.length) {
    throw new SiegelError('format', 'Siegel-Datei beschaedigt');
  }
  const env = decodeEnvelope(u.slice(MEDIA_PREFIX_LEN, MEDIA_PREFIX_LEN + hLen));
  const st = clone(ratchet);
  let plaintext;
  try {
    ({ plaintext } = await drDecrypt(st, env, { now, rng, lookupKem: () => null, takeOwnKems: () => [], maxSkippedAgeMs: SIEGEL_SKIPPED_MAX_AGE_MS }));
  } catch (e) {
    if (e?.code === 'replay') throw new SiegelError('used', 'Dieser Anhang wurde bereits geoeffnet oder ist zu alt (aeltere Anhaenge lassen sich nach 90 Tagen nicht mehr oeffnen)');
    throw new SiegelError('auth', 'Anhang passt nicht zu diesem Kontakt oder wurde veraendert');
  }
  let meta = null;
  try { meta = JSON.parse(unpadText(plaintext)); } catch {} finally { wipe(plaintext); }
  const key = meta && typeof meta.key === 'string' ? unb64(meta.key) : new Uint8Array(0);
  const h = meta && typeof meta.h === 'string' ? unb64(meta.h) : new Uint8Array(0);
  if (!meta || meta.t !== 'media' || !MEDIA_KINDS.includes(meta.k) || key.length !== 32 || h.length !== 32
    || !Number.isInteger(meta.s) || meta.s < 0 || meta.s > MAX_MEDIA_BYTES) {
    wipe(key);
    throw new SiegelError('format', 'Ungueltiger Anhang');
  }
  const blob = u.subarray(MEDIA_PREFIX_LEN + hLen);
  if (!equalCt(sha256(blob), h)) { wipe(key); throw new SiegelError('auth', 'Anhang wurde veraendert'); }
  const body = blob.subarray(MEDIA_NONCE_LEN);
  if (body.length - MEDIA_TAG_LEN < meta.s) { wipe(key); throw new SiegelError('format', 'Ungueltiger Anhang'); }
  let pt;
  try {
    pt = xchacha20poly1305(key, blob.subarray(0, MEDIA_NONCE_LEN), MEDIA_AD).decrypt(body);
  } catch {
    throw new SiegelError('auth', 'Anhang wurde veraendert');
  } finally {
    wipe(key);
  }
  return { kind: meta.k, mime: cleanMime(meta.m), name: cleanMediaName(meta.n), bytes: pt.subarray(0, meta.s), ratchet: st };
}

// ─── Mehrteilige QR-Anzeige ─────────────────────────────────────────────────
// Live-Test 2026-10-18: die Kamera-Bibliothek analysiert nur ~640x480 Pixel -
// ein einzelner QR-Code mit ~2000 Zeichen war zu dicht. Der Code wird deshalb
// in kleine Teile zerlegt, die nacheinander (animiert) gezeigt und beim
// Scannen eingesammelt werden. Nur Zeichen des alphanumerischen QR-Modus.
//   MSP1:<I|A>:<i>:<n>:<Satz-Kennung>:<Teil>
const PART_PREFIX = 'MSP1:';
const PART_RE = /^MSP1:([IA]):(\d{1,2}):(\d{1,2}):([A-Z2-7]{4}):([A-Z2-7]+)$/;
export const QR_PART_CHARS = 400;
export function splitForQr(code, maxChars = QR_PART_CHARS) {
  const s = String(code || '');
  const kind = s.startsWith(INVITE_PREFIX) ? 'I' : s.startsWith(ACK_PREFIX) ? 'A' : null;
  if (!kind) throw new SiegelError('format', 'Kein Siegel-Code');
  const body = s.slice((kind === 'I' ? INVITE_PREFIX : ACK_PREFIX).length);
  const n = Math.max(1, Math.ceil(body.length / maxChars));
  if (n > 20) throw new SiegelError('format', 'Code zu lang');
  // Satz-Kennung aus dem Inhalt (kein Zufall noetig): Teile verschiedener
  // Codes werden beim Einsammeln nie vermischt.
  const sid = base32Encode(sha256(utf8(s))).slice(0, 4);
  const size = Math.ceil(body.length / n);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(PART_PREFIX + kind + ':' + (i + 1) + ':' + n + ':' + sid + ':' + body.slice(i * size, (i + 1) * size));
  return parts;
}

// Sammelt gescannte Teile; add() liefert { have, total, code? } oder null
// (kein Teil). Ein vollstaendiger einteiliger Code wird direkt durchgereicht.
export class QrAssembler {
  constructor() { this.reset(); }
  reset() { this.sid = null; this.kind = null; this.total = 0; this.parts = new Map(); }
  add(text) {
    const s = String(text || '').trim();
    if (s.startsWith(INVITE_PREFIX) || s.startsWith(ACK_PREFIX)) return { have: 1, total: 1, code: s };
    const m = PART_RE.exec(s);
    if (!m) return null;
    const [, kind, iS, nS, sid, chunk] = m;
    const i = Number(iS);
    const n = Number(nS);
    if (n < 1 || n > 20 || i < 1 || i > n) return null;
    if (sid !== this.sid || kind !== this.kind || n !== this.total) {
      this.reset();
      this.sid = sid; this.kind = kind; this.total = n;
    }
    this.parts.set(i, chunk);
    const res = { have: this.parts.size, total: n };
    if (this.parts.size === n) {
      let body = '';
      for (let k = 1; k <= n; k++) body += this.parts.get(k);
      const code = (kind === 'I' ? INVITE_PREFIX : ACK_PREFIX) + body;
      // Gegenprobe: die Satz-Kennung muss zum zusammengesetzten Code passen.
      if (base32Encode(sha256(utf8(code))).slice(0, 4) !== sid) { this.reset(); return { have: 0, total: n }; }
      res.code = code;
    }
    return res;
  }
}
