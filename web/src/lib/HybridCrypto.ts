// Malachi Web - HybridCrypto.ts
// Browser-Gegenstueck zu HybridCrypto.js (native KyberModule.kt).
// Nutzt @noble/post-quantum's ml_kem768 - dasselbe finale, NIST-
// standardisierte ML-KEM-768 (FIPS 203), das die native App seit dem
// BouncyCastle-1.80-Upgrade ebenfalls verwendet. Byte-kompatibel: ein
// hier erzeugter Public Key kann von der nativen App encapsulated werden
// und umgekehrt.
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { Buffer } from 'buffer';

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

export async function generateKyberKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { publicKey: toB64(publicKey), secretKey: toB64(secretKey) };
}

export async function kyberEncapsulate(
  publicKeyB64: string,
): Promise<{ cipherText: string; sharedSecret: string }> {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromB64(publicKeyB64));
  return { cipherText: toB64(cipherText), sharedSecret: toB64(sharedSecret) };
}

export async function kyberDecapsulate(cipherTextB64: string, secretKeyB64: string): Promise<string> {
  const shared = ml_kem768.decapsulate(fromB64(cipherTextB64), fromB64(secretKeyB64));
  return toB64(shared);
}

export const ENCRYPTION_STATUS = {
  layers: ['AES-256-GCM', 'ChaCha20-Poly1305', 'XSalsa20-Poly1305'],
  keyEx: ['ML-KEM-768 (KEM)'],
  standard: 'NIST FIPS 203 (2024)',
  pqSafe: true,
};
