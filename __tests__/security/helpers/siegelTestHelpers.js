// Gemeinsame Test-Attrappen fuer den Siegel-Modus.
//
// fakeKyber: steht NUR fuer die Bruecke zum nativen ML-KEM-768 (KyberModule.kt,
// BouncyCastle) - der echte KEM laeuft unter Jest nicht. Gleiche Groessen und
// dieselbe Schnittstelle; das gemeinsame Geheimnis ist SHA-256(sk || ct), damit
// Kapselung/Entkapselung zueinander passen und ein falsches Chiffrat (wie bei
// ML-KEMs impliziter Ablehnung) ein ANDERES Geheimnis liefert. Getestet wird
// die Protokoll-Logik darueber, nicht ML-KEM selbst.
//
// fakeSiegelKey: steht fuer MalachiSiegelKeyModule.kt (Chip-HMAC ueber
// Argon2id) - hier HMAC(geheimer Testschluessel, scrypt(Passphrase, Salz)).
const crypto = require('crypto');

function fakeKyber() {
  return {
    generateKeypair: async () => {
      const pk = crypto.randomBytes(1184);
      return { publicKey: pk.toString('base64'), secretKey: pk.toString('base64') };
    },
    encapsulate: async (pkB64) => {
      const ct = crypto.randomBytes(1088);
      const ss = crypto.createHash('sha256').update(Buffer.from(pkB64, 'base64')).update(ct).digest();
      return { cipherText: ct.toString('base64'), sharedSecret: ss.toString('base64') };
    },
    decapsulate: async (ctB64, skB64) =>
      crypto.createHash('sha256').update(Buffer.from(skB64, 'base64')).update(Buffer.from(ctB64, 'base64')).digest().toString('base64'),
  };
}

function fakeSiegelKey() {
  let key = null;
  const m = {
    calls: [],
    createKey: jest.fn(async () => { key = crypto.randomBytes(32); return 'strongbox'; }),
    hasKey: jest.fn(async () => key !== null),
    destroyKey: jest.fn(async () => { key = null; return true; }),
    deriveVaultKey: jest.fn(async (pass, saltB64, memKiB, iterations) => {
      m.calls.push({ memKiB, iterations });
      if (!key) { const e = new Error('Siegel-Schluessel fehlt'); e.code = 'SIEGEL_NO_KEY'; throw e; }
      const pw = crypto.scryptSync(String(pass), Buffer.from(saltB64, 'base64'), 32, { N: 1024 });
      return crypto.createHmac('sha256', key).update(pw).digest('base64');
    }),
    _forgetKeyForTests: () => { key = null; },
  };
  return m;
}

const rng = async (n) => new Uint8Array(crypto.randomBytes(n));

module.exports = { fakeKyber, fakeSiegelKey, rng };
