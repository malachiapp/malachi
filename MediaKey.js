/**
 * Malachi – MediaKey.js
 * Dateischluessel fuer Medien (Bild, Sprachnachricht, Datei) bei aktivem
 * Double Ratchet - nach dem Vorbild von Signals Anhaengen:
 *   - pro Medium (und pro Sendeversuch) ein frischer, zufaelliger 256-Bit-
 *     Schluessel,
 *   - jeder Chunk einzeln mit XChaCha20-Poly1305 unter diesem Schluessel
 *     verschluesselt (nur die Verbindungsschicht liegt aussen herum, NICHT der
 *     Ratchet - sonst kostete jeder 64-KB-Chunk einen Ratchet-Schritt samt
 *     Speichervorgang),
 *   - der Schluessel selbst reist im End-Marker, und NUR der geht durch den
 *     Ratchet (WebRTCManager.sealForConnection). Ohne den authentifizierten
 *     End-Marker ist kein Chunk lesbar.
 * Nonce = Chunk-Index (eindeutig, weil der Schluessel pro Uebertragung neu
 * ist); associated data bindet Art, Medien-ID, Index, Gesamtzahl und echte
 * Laenge - Chunks lassen sich weder vertauschen noch zwischen Medien
 * verschieben noch kuerzen (die Gesamtzahl kommt aus dem End-Marker).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { Buffer } from 'buffer';
import { secureRandomBytes } from './MessageCrypto';

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export async function newFileKey() {
  return secureRandomBytes(32);
}

export function fileKeyToB64(key) {
  return Buffer.from(key).toString('base64');
}

export function fileKeyFromB64(s) {
  if (typeof s !== 'string' || !KEY_RE.test(s)) return null;
  const key = Uint8Array.from(Buffer.from(s, 'base64'));
  return key.length === 32 ? key : null;
}

function chunkNonce(index) {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setUint32(20, index, false); // Index 0..10000 (RTCStore prueft)
  return n;
}

function chunkAd(kind, id, index, total, realLen) {
  return Uint8Array.from(Buffer.from(`malachi-media-v1|${kind}|${id}|${index}|${total}|${realLen}`, 'utf8'));
}

// text: der (aufgepolsterte) Base64-Abschnitt des Mediums.
export function sealMediaChunk(key, kind, id, index, total, realLen, text) {
  const ct = xchacha20poly1305(key, chunkNonce(index), chunkAd(kind, id, index, total, realLen))
    .encrypt(Uint8Array.from(Buffer.from(String(text), 'utf8')));
  return Buffer.from(ct).toString('base64');
}

// Wirft bei Manipulation/falschem Schluessel.
export function openMediaChunk(key, kind, id, index, total, realLen, dataB64) {
  if (typeof dataB64 !== 'string') throw new Error('Chunk fehlt');
  const pt = xchacha20poly1305(key, chunkNonce(index), chunkAd(kind, id, index, total, realLen))
    .decrypt(Uint8Array.from(Buffer.from(dataB64, 'base64')));
  return Buffer.from(pt).toString('utf8');
}
