// Pruefung eines Google-Play-Kaufs OHNE Server (nur Play-Variante, siehe
// PLAY_STORE.md und LicenseManager.js).
//
// Google Play signiert die Kaufdaten ("originalJson" des Billing-Library-
// Objekts Purchase) mit dem privaten Schluessel der App; den oeffentlichen
// RSA-Schluessel zeigt die Play Console (Base64, X.509 SubjectPublicKeyInfo)
// - eingetragen in AppConfig.PLAY_LICENSE_PUBLIC_KEY. Verfahren:
// RSASSA-PKCS1-v1_5 (RFC 8017, Abschnitt 8.2) mit SHA-1 (so signiert Google
// Play seit jeher, "SHA1withRSA"); SHA-256 wird zusaetzlich angenommen, falls
// Google das Verfahren spaeter umstellt. Die Pruefung kodiert die erwartete
// Nachricht vollstaendig neu und vergleicht Byte fuer Byte (kein Parsen der
// entschluesselten Signatur - damit sind die bekannten Faelschungen gegen
// nachlaessige PKCS#1-Parser ausgeschlossen).
//
// Ein Kauf zaehlt nur, wenn ALLES stimmt:
//   - Signatur gueltig fuer genau diese Bytes (UTF-8 des originalJson),
//   - packageName == eigener Paketname der App,
//   - Produkt == AppConfig.PLAY_PRODUCT_ID ("malachi_pro"),
//   - purchaseState == 0 (gekauft) - ausstehende Zahlungen (4) schalten NIE frei,
//   - Kauf-Token vorhanden.
// Vertraut wird nur dem signierten JSON - nie den unsignierten Feldern, die
// das native Modul daneben liefert.
//
// Grenzen (bewusst, serverlos): Ein Kauf ist an das Google-Konto gebunden,
// nicht an das Geraet. Ohne Server laesst sich nicht pruefen, ob signierte
// Kaufdaten wirklich vom angemeldeten Konto stammen; eine gerootete App laesst
// sich ohnehin umbauen. Die Pruefung schuetzt vor gefaelschten Kaeufen durch
// manipulierte Billing-Dienste ("Freikauf-Apps"), nicht vor einem Angreifer
// mit voller Kontrolle ueber das eigene Geraet.
//
// Keine React-Native-Abhaengigkeit - laeuft so auch in Jest. BigInt: Hermes
// (RN >= 0.70) und Node; RSA-Rechnung mit 2048-Bit-Zahlen dauert Millisekunden.

/* global BigInt */
import { Buffer } from 'buffer';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

const BIG0 = BigInt(0);
const BIG1 = BigInt(1);

// OID 1.2.840.113549.1.1.1 (rsaEncryption), DER-kodiert samt Kopf.
const RSA_ENCRYPTION_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
// DigestInfo-Koepfe aus RFC 8017, Abschnitt 9.2, Anmerkung 1.
const DIGEST_INFOS = [
  { name: 'sha1', prefix: hexToBytes('3021300906052b0e03021a05000414'), hash: sha1 },
  { name: 'sha256', prefix: hexToBytes('3031300d060960864801650304020105000420'), hash: sha256 },
];
// Play-Schluessel sind RSA-2048; kleinere Schluessel werden nicht akzeptiert.
const MIN_MODULUS_BITS = 2048;
const MAX_MODULUS_BITS = 8192;
const MAX_JSON_CHARS = 16384;
const MAX_TOKEN_CHARS = 4096;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// purchaseState im signierten JSON (Werte der Play-Kaufdaten, NICHT die
// Konstanten Purchase.PurchaseState der Billing Library):
export const JSON_STATE_PURCHASED = 0;
export const JSON_STATE_PENDING = 4;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToBigInt(bytes) {
  let hex = '';
  for (const b of bytes) hex += (b < 16 ? '0' : '') + b.toString(16);
  return hex ? BigInt('0x' + hex) : BIG0;
}

function bigIntToBytes(value, length) {
  let hex = value.toString(16);
  if (hex.length > length * 2) return null;
  hex = hex.padStart(length * 2, '0');
  return hexToBytes(hex);
}

function bitLength(bytes) {
  // bytes ohne fuehrende Null
  let top = bytes[0];
  let bits = 0;
  while (top > 0) { bits++; top >>= 1; }
  return (bytes.length - 1) * 8 + bits;
}

/** Base64 (Standard-Alphabet) streng dekodieren; null bei Fehler. */
function decodeBase64Strict(text, maxChars) {
  if (typeof text !== 'string' || text.length === 0 || text.length > maxChars) return null;
  // Zeilenumbrueche (z. B. beim Kopieren aus der Play Console) sind erlaubt, sonst nichts.
  const t = text.replace(/[\r\n]/g, '');
  if (t.length % 4 !== 0 || !BASE64_RE.test(t)) return null;
  const bytes = Uint8Array.from(Buffer.from(t, 'base64'));
  // Rundlauf: nur kanonisches Base64 akzeptieren.
  if (Buffer.from(bytes).toString('base64') !== t) return null;
  return bytes;
}

// ── DER (nur das, was ein RSA-SubjectPublicKeyInfo braucht) ───────────────

function readTlv(buf, pos, tag) {
  if (pos + 2 > buf.length || buf[pos] !== tag) throw new Error('der');
  let len = buf[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + n > buf.length) throw new Error('der');
    if (buf[p] === 0) throw new Error('der');           // nicht minimal
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
    if (len < 0x80) throw new Error('der');            // haette in die Kurzform gepasst
  }
  if (p + len > buf.length) throw new Error('der');
  return { start: p, end: p + len };
}

function readPositiveInteger(buf, pos) {
  const t = readTlv(buf, pos, 0x02);
  let bytes = buf.subarray(t.start, t.end);
  if (bytes.length === 0 || (bytes[0] & 0x80)) throw new Error('der');   // negativ/leer
  if (bytes[0] === 0) {
    if (bytes.length === 1 || !(bytes[1] & 0x80)) throw new Error('der'); // nicht minimal
    bytes = bytes.subarray(1);
  }
  return { bytes, end: t.end };
}

/**
 * Oeffentlichen RSA-Schluessel aus der Play Console lesen (Base64 eines
 * X.509 SubjectPublicKeyInfo). Wirft bei jedem Formfehler.
 * Rueckgabe: { n, e, k } (Modulus, Exponent als BigInt; k = Laenge in Byte).
 */
export function parseRsaPublicKey(base64) {
  const der = decodeBase64Strict(base64, 3000);
  if (!der) throw new Error('Schluessel: kein Base64');
  const outer = readTlv(der, 0, 0x30);
  if (outer.end !== der.length) throw new Error('der');
  const alg = readTlv(der, outer.start, 0x30);
  const oid = der.subarray(alg.start, alg.start + RSA_ENCRYPTION_OID.length);
  if (oid.length !== RSA_ENCRYPTION_OID.length || RSA_ENCRYPTION_OID.some((b, i) => oid[i] !== b)) {
    throw new Error('Schluessel: kein RSA');
  }
  const afterOid = alg.start + RSA_ENCRYPTION_OID.length;
  // Parameter: NULL (05 00) oder gar nichts.
  if (!(afterOid === alg.end || (afterOid + 2 === alg.end && der[afterOid] === 0x05 && der[afterOid + 1] === 0x00))) {
    throw new Error('der');
  }
  const bits = readTlv(der, alg.end, 0x03);
  if (bits.end !== outer.end || der[bits.start] !== 0x00) throw new Error('der');
  const seq = readTlv(der, bits.start + 1, 0x30);
  if (seq.end !== bits.end) throw new Error('der');
  const n = readPositiveInteger(der, seq.start);
  const e = readPositiveInteger(der, n.end);
  if (e.end !== seq.end) throw new Error('der');
  const nBits = bitLength(n.bytes);
  if (nBits < MIN_MODULUS_BITS || nBits > MAX_MODULUS_BITS) throw new Error('Schluessel: Laenge');
  // Exponent: ungerade, 3 .. 2^32-1 (Play: 65537) - begrenzt auch die Rechenzeit.
  if (e.bytes.length > 4) throw new Error('Schluessel: Exponent');
  const eBig = bytesToBigInt(e.bytes);
  if (eBig < BigInt(3) || (eBig & BIG1) === BIG0) throw new Error('Schluessel: Exponent');
  const nBig = bytesToBigInt(n.bytes);
  if ((nBig & BIG1) === BIG0) throw new Error('Schluessel: Modulus');
  return { n: nBig, e: eBig, k: n.bytes.length };
}

function modPow(base, exp, mod) {
  let result = BIG1;
  let b = base % mod;
  let e = exp;
  while (e > BIG0) {
    if ((e & BIG1) === BIG1) result = (result * b) % mod;
    e >>= BIG1;
    if (e > BIG0) b = (b * b) % mod;
  }
  return result;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** EMSA-PKCS1-v1_5-Kodierung (RFC 8017, 9.2) der Laenge k. */
function emsaPkcs1v15(digestInfo, digest, k) {
  const tLen = digestInfo.length + digest.length;
  if (k < tLen + 11) return null;
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x01;
  em.fill(0xff, 2, k - tLen - 1);
  em[k - tLen - 1] = 0x00;
  em.set(digestInfo, k - tLen);
  em.set(digest, k - digest.length);
  return em;
}

/**
 * RSASSA-PKCS1-v1_5-Signatur pruefen (SHA-1 oder SHA-256).
 * data: Uint8Array, signatureBase64: Text, key: Ergebnis von parseRsaPublicKey.
 */
export function verifyRsaPkcs1v15(data, signatureBase64, key) {
  if (!key || !(data instanceof Uint8Array)) return false;
  const sig = decodeBase64Strict(signatureBase64, 4096);
  if (!sig || sig.length !== key.k) return false;
  const s = bytesToBigInt(sig);
  if (s >= key.n) return false;
  const em = bigIntToBytes(modPow(s, key.e, key.n), key.k);
  if (!em) return false;
  for (const d of DIGEST_INFOS) {
    if (bytesEqual(em, emsaPkcs1v15(d.prefix, d.hash(data), key.k))) return true;
  }
  return false;
}

function utf8Bytes(text) {
  return Uint8Array.from(Buffer.from(text, 'utf8'));
}

/**
 * Einen Kauf vollstaendig pruefen.
 *   purchase: wie vom nativen Modul geliefert ({ originalJson, signature,
 *             purchaseState: 'purchased'|'pending'|'unspecified', ... })
 *   opts:     { publicKey (Base64 aus der Play Console), packageName, productId }
 * Rueckgabe: { gueltig: true, kauf: { purchaseToken, orderId, purchaseTime, acknowledged } }
 *        oder { gueltig: false, grund } mit grund aus
 *        'nicht-konfiguriert' | 'format' | 'signatur' | 'paket' | 'produkt' | 'ausstehend' | 'status'
 */
export function verifyPlayPurchase(purchase, { publicKey, packageName, productId } = {}) {
  if (typeof publicKey !== 'string' || !publicKey) return { gueltig: false, grund: 'nicht-konfiguriert' };
  let key;
  try { key = parseRsaPublicKey(publicKey); } catch { return { gueltig: false, grund: 'nicht-konfiguriert' }; }
  if (typeof packageName !== 'string' || !packageName || typeof productId !== 'string' || !productId) {
    return { gueltig: false, grund: 'nicht-konfiguriert' };
  }
  if (!purchase || typeof purchase !== 'object') return { gueltig: false, grund: 'format' };
  const { originalJson, signature } = purchase;
  if (typeof originalJson !== 'string' || !originalJson || originalJson.length > MAX_JSON_CHARS
      || typeof signature !== 'string' || !signature) {
    return { gueltig: false, grund: 'format' };
  }
  if (!verifyRsaPkcs1v15(utf8Bytes(originalJson), signature, key)) return { gueltig: false, grund: 'signatur' };

  // Ab hier: nur noch Felder aus dem signierten JSON.
  let j;
  try { j = JSON.parse(originalJson); } catch { return { gueltig: false, grund: 'format' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { gueltig: false, grund: 'format' };
  if (j.packageName !== packageName) return { gueltig: false, grund: 'paket' };
  const products = Array.isArray(j.productIds) ? j.productIds : (typeof j.productId === 'string' ? [j.productId] : []);
  if (!products.includes(productId)) return { gueltig: false, grund: 'produkt' };
  if (typeof j.purchaseToken !== 'string' || !j.purchaseToken || j.purchaseToken.length > MAX_TOKEN_CHARS) {
    return { gueltig: false, grund: 'format' };
  }
  // Das native Modul bestaetigt spaeter genau dieses Token - es muss zum signierten passen.
  if (purchase.purchaseToken !== undefined && purchase.purchaseToken !== j.purchaseToken) {
    return { gueltig: false, grund: 'format' };
  }
  // Ausstehend (z. B. Barzahlung/Ueberweisung noch offen): nie freischalten.
  if (j.purchaseState === JSON_STATE_PENDING || purchase.purchaseState === 'pending') {
    return { gueltig: false, grund: 'ausstehend' };
  }
  const purchased = j.purchaseState === JSON_STATE_PURCHASED
    || (j.purchaseState === undefined && purchase.purchaseState === 'purchased');
  if (!purchased || (purchase.purchaseState !== undefined && purchase.purchaseState !== 'purchased')) {
    return { gueltig: false, grund: 'status' };
  }
  return {
    gueltig: true,
    kauf: {
      purchaseToken: j.purchaseToken,
      orderId: typeof j.orderId === 'string' ? j.orderId.slice(0, 100) : null,
      purchaseTime: Number.isFinite(j.purchaseTime) ? j.purchaseTime : null,
      acknowledged: typeof j.acknowledged === 'boolean' ? j.acknowledged : purchase.acknowledged === true,
    },
  };
}

/** SHA-256 eines Kauf-Tokens als Hex (gespeichert wird nur dieser Hash, nie das Token). */
export function purchaseTokenHash(token) {
  const d = sha256(utf8Bytes(String(token)));
  let hex = '';
  for (const b of d) hex += (b < 16 ? '0' : '') + b.toString(16);
  return hex;
}
