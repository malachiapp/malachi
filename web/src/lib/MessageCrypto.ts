// Malachi Web - MessageCrypto.ts
// Portiert 1:1 aus MessageCrypto.js - identische Dreischicht-Verschluesselung
// (AES-256-GCM -> ChaCha20-Poly1305 -> XSalsa20-Poly1305) mit HKDF-Ableitung,
// byte-kompatibel mit der nativen App. Einziger Unterschied: Zufallszahlen
// kommen aus der Web Crypto API (crypto.getRandomValues) statt aus dem
// nativen KyberModule.randomBytes - beides ist ein kryptographisch sicherer
// Zufallszahlengenerator des jeweiligen Betriebssystems.
import { gcm } from '@noble/ciphers/aes.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { Buffer } from 'buffer';

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// purpose trennt zusaetzlich nach Verwendungszweck, nicht nur nach Schicht
// (Sicherheitsreview Review 2) - siehe ausfuehrlicher Kommentar in der
// nativen MessageCrypto.js. Muss auf beiden Seiten (native/web) fuer denselben
// Zweck identisch sein, sonst schlaegt die Entschluesselung fehl.
function deriveKeys(sharedSecretBase64: string, purpose: string = 'message') {
  const raw = b64ToBytes(sharedSecretBase64);
  const k1 = hkdf(sha256, raw, undefined, encode('malachi-layer1-aes256gcm-' + purpose), 32);
  const k2 = hkdf(sha256, raw, undefined, encode('malachi-layer2-chacha20poly1305-' + purpose), 32);
  const k3 = hkdf(sha256, raw, undefined, encode('malachi-layer3-xsalsa20poly1305-' + purpose), 32);
  return { k1, k2, k3 };
}

export async function encryptMsg(plaintext: string, sharedSecretBase64: string, purpose: string = 'message'): Promise<string | null> {
  try {
    const { k1, k2, k3 } = deriveKeys(sharedSecretBase64, purpose);
    const msgBytes = encode(plaintext);

    const n1 = randomBytes(12);
    const c1 = gcm(k1, n1).encrypt(msgBytes);
    const l1 = new Uint8Array(n1.length + c1.length);
    l1.set(n1);
    l1.set(c1, n1.length);

    const n2 = randomBytes(12);
    const c2 = chacha20poly1305(k2, n2).encrypt(l1);
    const l2 = new Uint8Array(n2.length + c2.length);
    l2.set(n2);
    l2.set(c2, n2.length);

    const n3 = randomBytes(24);
    const c3 = xsalsa20poly1305(k3, n3).encrypt(l2);
    const l3 = new Uint8Array(n3.length + c3.length);
    l3.set(n3);
    l3.set(c3, n3.length);

    return bytesToB64(l3);
  } catch (e) {
    // Fehlerbehandlungs-Review: native MessageCrypto.js bekam diese
    // Sanitisierung bereits (SECURITY_SECRETS_LIFECYCLE_FIXES.md Fix 8), die
    // Web-Entsprechung hier wurde dabei uebersehen - loggte bislang weiterhin
    // das volle Error-Objekt (inkl. Stacktrace) statt nur die Meldung.
    console.error('[MessageCrypto] Verschlüsselung fehlgeschlagen:', e instanceof Error ? e.message : e);
    return null;
  }
}

export function decryptMsg(ciphertextB64: string, sharedSecretBase64: string, purpose: string = 'message'): string | null {
  try {
    const { k1, k2, k3 } = deriveKeys(sharedSecretBase64, purpose);
    const l3 = b64ToBytes(ciphertextB64);

    const n3 = l3.slice(0, 24);
    const c3 = l3.slice(24);
    const l2 = xsalsa20poly1305(k3, n3).decrypt(c3);

    const n2 = l2.slice(0, 12);
    const c2 = l2.slice(12);
    const l1 = chacha20poly1305(k2, n2).decrypt(c2);

    const n1 = l1.slice(0, 12);
    const c1 = l1.slice(12);
    const msgBytes = gcm(k1, n1).decrypt(c1);

    return decode(msgBytes);
  } catch (e) {
    // Siehe Kommentar im encryptMsg-Catch-Block oben.
    console.error('[MessageCrypto] Entschlüsselung fehlgeschlagen:', e instanceof Error ? e.message : e);
    return null;
  }
}
