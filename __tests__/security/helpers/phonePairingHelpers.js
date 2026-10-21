/* eslint-env node */
// Test-Attrappen fuer die Telefonnummer-Kopplung (PhonePairing.js).
//
// Was hier NICHT nachgebaut wird: Kryptografie. ML-KEM-768 ist echtes
// @noble/post-quantum (dieselbe Bibliothek wie der Web-Client), Argon2id ist
// Nodes eingebautes crypto.argon2Sync (OpenSSL, RFC 9106) - beides steht nur
// fuer die nativen Bruecken (KyberModule.kt bzw. MalachiTorModule.argon2id,
// beide BouncyCastle). Tor selbst ist gemockt: Zeilen, Verbindungen und der
// Treffpunkt-Dienst werden im Speicher nachgestellt.
const crypto = require('crypto');
const { ml_kem768 } = require('../../../web/node_modules/@noble/post-quantum/ml-kem.js');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

function realKyber() {
  return {
    generateKeypair: async () => {
      const { publicKey, secretKey } = ml_kem768.keygen();
      return { publicKey: b64(publicKey), secretKey: b64(secretKey) };
    },
    encapsulate: async (pkB64) => {
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(unb64(pkB64));
      return { cipherText: b64(cipherText), sharedSecret: b64(sharedSecret) };
    },
    decapsulate: async (ctB64, skB64) => b64(ml_kem768.decapsulate(unb64(ctB64), unb64(skB64))),
  };
}

// Gleiche Schnittstelle wie MalachiTorModule.argon2id (Base64 rein/raus).
async function nativeArgon2idMock(passwordB64, saltB64, memKiB, iterations, outLen) {
  const out = crypto.argon2Sync('argon2id', {
    message: Buffer.from(passwordB64, 'base64'),
    nonce: Buffer.from(saltB64, 'base64'),
    parallelism: 1,
    tagLength: outLen,
    memory: memKiB,
    passes: iterations,
  });
  return out.toString('base64');
}

// Dasselbe als kdf-Funktion fuer deriveRendezvous (Uint8Array rein/raus).
async function kdfNode(password, salt, p) {
  return unb64(await nativeArgon2idMock(b64(password), b64(salt), p.memKiB, p.iterations, p.outLen));
}

const rng = async (n) => new Uint8Array(crypto.randomBytes(n));

// Sammelt alles, was ueber console.* ausgegeben wird.
function captureConsole() {
  const lines = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((k) =>
    jest.spyOn(console, k).mockImplementation((...args) => {
      lines.push(args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' '));
    }));
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

// Alle Schreibweisen einer Nummer, nach denen in Logs/Speicher gesucht wird.
function numberForms(e164) {
  const digits = e164.slice(1);
  const national = '0' + digits.slice(2);
  return [e164, digits, national, digits.slice(2), national.slice(0, 4) + ' ' + national.slice(4)];
}

module.exports = { realKyber, nativeArgon2idMock, kdfNode, rng, captureConsole, numberForms, b64, unb64 };
