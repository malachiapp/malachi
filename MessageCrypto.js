/**
 * Malachi – MessageCrypto.js
 * Dreischicht Post-Quantum Verschlüsselung
 * Layer 1: AES-256-GCM
 * Layer 2: ChaCha20-Poly1305
 * Layer 3: XSalsa20-Poly1305
 * Sichere Zufallszahlen via KyberModule (SecureRandom)
 * ÄÜÖß via Buffer UTF-8 ✅
 */
import { gcm } from '@noble/ciphers/aes';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { Buffer } from 'buffer';
import { NativeModules } from 'react-native';

const { KyberModule } = NativeModules;

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function encode(str) {
  return Buffer.from(str, 'utf8');
}

function decode(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

async function randomBytes(length) {
  const b64 = await KyberModule.randomBytes(length);
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

// Sicherer Zufalls-Token (Hex) fuer Routing-IDs, die bisher mit Math.random()
// erzeugt wurden (Kontakt-/Transfer-IDs) - Math.random() ist kein kryptografisch
// sicherer Zufallsgenerator und macht diese IDs vorhersagbar/kollisionsanfaellig
// (Sicherheitsreview 3). Fail-closed statt auf Math.random() zurueckzufallen,
// gleiches Prinzip wie hashPhone/derivePhonePSK in App.tsx.
export async function secureRandomToken(byteLength = 16) {
  if (!KyberModule?.randomBytes) {
    throw new Error('KyberModule.randomBytes nicht verfügbar - kann keinen sicheren Zufallswert erzeugen.');
  }
  const bytes = await randomBytes(byteLength);
  return Buffer.from(bytes).toString('hex');
}

// Rohe Zufallsbytes (Uint8Array) aus derselben sicheren Quelle, fail-closed -
// fuer den Double Ratchet (X25519-Schluesselpaare, Nonces) und die
// Medien-Dateischluessel (RatchetSession.js, MediaKey.js).
export async function secureRandomBytes(byteLength) {
  if (!KyberModule?.randomBytes) {
    throw new Error('KyberModule.randomBytes nicht verfügbar - kann keine sicheren Zufallsbytes erzeugen.');
  }
  const bytes = await randomBytes(byteLength);
  if (bytes.length !== byteLength) throw new Error('Zufallsquelle lieferte falsche Laenge');
  return bytes;
}

// Zufaelliger, rein lokaler Schluessel (Base64) - z.B. fuer die verschluesselte
// Empfangs-Ablage in RTCStore.js. Gleiche sichere Quelle wie oben, fail-closed.
export async function randomKeyB64(byteLength = 32) {
  if (!KyberModule?.randomBytes) {
    throw new Error('KyberModule.randomBytes nicht verfügbar - kann keinen sicheren Schluessel erzeugen.');
  }
  return bytesToB64(await randomBytes(byteLength));
}

// Standard-HKDF (RFC 5869) statt der vorherigen Ad-hoc-Ableitung
// (sha256(secret), sha256(secret‖1), sha256(secret‖2)). Kryptografisch war
// das nicht gebrochen, aber unueblich/unaudited - HKDF mit domain-getrennten
// "info"-Strings ist der Standardweg, mehrere unabhaengige Schluessel aus
// einem einzigen Shared Secret abzuleiten.
//
// purpose trennt zusaetzlich nach VERWENDUNGSZWECK, nicht nur nach Schicht
// (Sicherheitsreview Review 2): derselbe Kyber-Shared-Secret verschluesselt
// inzwischen sowohl normale Chat-Nachrichten als auch Reconnect-Angebote und
// Call-Signaling. Ohne eigenes Label wuerden alle drei mit identischen
// Unterschluesseln arbeiten - unwahrscheinlich ausnutzbar, aber sauberer,
// jeden Zweck ueber ein eigenes HKDF-info-Label kryptografisch zu trennen.
// Default 'message' haelt alle bestehenden Aufrufstellen (normale Nachrichten,
// Systempakete, Phone-Connect - letzteres nutzt ohnehin schon ein eigenes PSK,
// keine Kollisionsgefahr) unveraendert kompatibel.
function deriveKeys(sharedSecretBase64, purpose = 'message') {
  const raw = b64ToBytes(sharedSecretBase64);
  const k1 = hkdf(sha256, raw, undefined, encode('malachi-layer1-aes256gcm-' + purpose), 32);
  const k2 = hkdf(sha256, raw, undefined, encode('malachi-layer2-chacha20poly1305-' + purpose), 32);
  const k3 = hkdf(sha256, raw, undefined, encode('malachi-layer3-xsalsa20poly1305-' + purpose), 32);
  return { k1, k2, k3 };
}

// aad (optional, Uint8Array): associated data fuer die Schichten 1 und 2
// (AES-GCM und ChaCha20-Poly1305 - XSalsa20-Poly1305 kennt keine). Ohne aad
// exakt wie bisher (Leitungsformat aelterer Gegenseiten).
export async function encryptMsg(plaintext, sharedSecretBase64, purpose = 'message', aad = undefined) {
  try {
    const { k1, k2, k3 } = deriveKeys(sharedSecretBase64, purpose);
    const msgBytes = encode(plaintext);

    // Layer 1: AES-256-GCM
    const n1 = await randomBytes(12);
    const c1 = gcm(k1, n1, aad).encrypt(msgBytes);
    const l1 = new Uint8Array(n1.length + c1.length);
    l1.set(n1); l1.set(c1, n1.length);

    // Layer 2: ChaCha20-Poly1305
    const n2 = await randomBytes(12);
    const c2 = chacha20poly1305(k2, n2, aad).encrypt(l1);
    const l2 = new Uint8Array(n2.length + c2.length);
    l2.set(n2); l2.set(c2, n2.length);

    // Layer 3: XSalsa20-Poly1305
    const n3 = await randomBytes(24);
    const c3 = xsalsa20poly1305(k3, n3).encrypt(l2);
    const l3 = new Uint8Array(n3.length + c3.length);
    l3.set(n3); l3.set(c3, n3.length);

    // (Erfolgs-Log entfernt: lief bei jedem Paket inkl. Fuelltraffic und verdraengte Diagnosedaten)
    return bytesToB64(l3);
  } catch(e) {
    console.error('[MessageCrypto] Verschlüsselung fehlgeschlagen:', e?.message || e);
    return null;
  }
}

export function decryptMsg(ciphertextB64, sharedSecretBase64, purpose = 'message', aad = undefined) {
  try {
    const { k1, k2, k3 } = deriveKeys(sharedSecretBase64, purpose);
    const l3 = b64ToBytes(ciphertextB64);

    // Layer 3: XSalsa20-Poly1305
    const n3 = l3.slice(0, 24);
    const c3 = l3.slice(24);
    const l2 = xsalsa20poly1305(k3, n3).decrypt(c3);

    // Layer 2: ChaCha20-Poly1305
    const n2 = l2.slice(0, 12);
    const c2 = l2.slice(12);
    const l1 = chacha20poly1305(k2, n2, aad).decrypt(c2);

    // Layer 1: AES-256-GCM
    const n1 = l1.slice(0, 12);
    const c1 = l1.slice(12);
    const msgBytes = gcm(k1, n1, aad).decrypt(c1);

    // (Erfolgs-Log entfernt, siehe encryptMsg)
    return decode(msgBytes);
  } catch(e) {
    console.error('[MessageCrypto] Entschlüsselung fehlgeschlagen:', e?.message || e);
    return null;
  }
}

// ─── Aeussere Schicht v2 (Krypto-Review 2026-10-25, K-09) ──────────────────
// Bisher: dieselben drei Schluessel in BEIDE Richtungen, keine associated data
// - wer den Transport bricht, koennte Pakete zurueckspiegeln (Fuell-/Sprach-
// pakete, die nicht durch den Ratchet gehen). v2, nur nach Aushandlung im
// Kyber-Handshake (ol: 2; aeltere Gegenseiten bleiben bei v1):
//   Schluessel je Richtung: HKDF(Verbindungsgeheimnis, info =
//     "malachi-conn-v2|key|<richtung>") -> daraus wie immer k1/k2/k3
//   AAD (Schicht 1 und 2):  "malachi-conn-v2|<richtung>|<zweck>"
//   richtung: 'i2r' (Initiator der Verbindung -> Responder) bzw. 'r2i'
// Ein gespiegeltes oder als anderer Zweck ausgegebenes Paket ist damit nicht
// mehr entschluesselbar. Leitungsformat: {type:'encrypted', v:2, data}.
export const OUTER_V2 = 2;
export const outerDirection = (isInitiator, sending) => ((!!isInitiator === !!sending) ? 'i2r' : 'r2i');

function outerKeyV2(sharedSecretBase64, dir) {
  return bytesToB64(hkdf(sha256, b64ToBytes(sharedSecretBase64), undefined, encode('malachi-conn-v2|key|' + dir), 32));
}
const outerAad = (dir, purpose) => Uint8Array.from(encode('malachi-conn-v2|' + dir + '|' + purpose));

export async function encryptOuterV2(plaintext, sharedSecretBase64, dir, purpose = 'message') {
  if (dir !== 'i2r' && dir !== 'r2i') return null;
  try {
    return await encryptMsg(plaintext, outerKeyV2(sharedSecretBase64, dir), purpose, outerAad(dir, purpose));
  } catch {
    return null;
  }
}

export function decryptOuterV2(ciphertextB64, sharedSecretBase64, dir, purpose = 'message') {
  if (dir !== 'i2r' && dir !== 'r2i') return null;
  try {
    return decryptMsg(ciphertextB64, outerKeyV2(sharedSecretBase64, dir), purpose, outerAad(dir, purpose));
  } catch {
    return null;
  }
}