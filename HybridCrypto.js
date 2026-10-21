import { NativeModules } from 'react-native';

const { KyberModule } = NativeModules;

export async function generateKyberKeypair() {
  return await KyberModule.generateKeypair();
}

export async function kyberEncapsulate(publicKeyB64) {
  return await KyberModule.encapsulate(publicKeyB64);
}

export async function kyberDecapsulate(cipherTextB64, secretKeyB64) {
  return await KyberModule.decapsulate(cipherTextB64, secretKeyB64);
}

// Spiegelt exakt, was in MessageCrypto.js/WebRTCManager.js tatsächlich läuft -
// vorher wurden hier zusätzlich "X25519"/"ECDH-384" behauptet, die es im Code
// nirgendwo gibt. Der Schlüsselaustausch ist ausschließlich Kyber-768 (KEM).
export const ENCRYPTION_STATUS = {
  layers:   ['AES-256-GCM', 'ChaCha20-Poly1305', 'XSalsa20-Poly1305'],
  keyEx:    ['Kyber-768 (KEM)'],
  standard: 'NIST FIPS 203 (2024)',
  pqSafe:   true,
};