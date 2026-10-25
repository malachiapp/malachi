// Test-Attrappe fuer vault/MalachiPinKeyModule.kt (PIN-Tresor).
//
// deriveKey: steht fuer HMAC_Chip(Argon2id(PIN, Salz)) - hier
// HMAC(geheimer Testschluessel, scrypt(PIN, Salz)). Ohne "Chip-Schluessel"
// (destroyKey) wirft sie PIN_NO_KEY wie das Original.
// bioEnroll/bioUnwrap: stehen fuer den Systemdialog + AES-GCM-Schluessel im
// Keystore; mit bioMode = 'cancel' | 'invalidated' laesst sich der Dialog
// abbrechen bzw. ein neu hinzugefuegter Fingerabdruck nachstellen.
const crypto = require('crypto');

function fakePinKey() {
  let key = null;
  let bioKey = null;
  const m = {
    bioMode: 'ok',
    derives: 0,
    createKey: jest.fn(async () => { key = crypto.randomBytes(32); return 'strongbox'; }),
    hasKey: jest.fn(async () => key !== null),
    destroyKey: jest.fn(async () => { key = null; bioKey = null; return true; }),
    deriveKey: jest.fn(async (pin, saltB64) => {
      m.derives++;
      if (!key) { const e = new Error('PIN-Schluessel fehlt'); e.code = 'PIN_NO_KEY'; throw e; }
      const pw = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64'), 32, { N: 1024 });
      return crypto.createHmac('sha256', key).update(pw).digest('base64');
    }),
    bioAvailable: jest.fn(async () => true),
    bioEnroll: jest.fn(async (secretB64) => {
      if (m.bioMode === 'cancel') { const e = new Error('abgebrochen'); e.code = 'BIO_CANCEL'; throw e; }
      bioKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', bioKey, iv);
      const ct = Buffer.concat([c.update(Buffer.from(secretB64, 'base64')), c.final(), c.getAuthTag()]);
      return { iv: iv.toString('base64'), ct: ct.toString('base64') };
    }),
    bioUnwrap: jest.fn(async (ivB64, ctB64) => {
      if (m.bioMode === 'cancel') { const e = new Error('abgebrochen'); e.code = 'BIO_CANCEL'; throw e; }
      if (m.bioMode === 'invalidated' || !bioKey) {
        bioKey = null;
        const e = new Error('ungueltig'); e.code = 'BIO_INVALIDATED'; throw e;
      }
      const raw = Buffer.from(ctB64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', bioKey, Buffer.from(ivB64, 'base64'));
      d.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('base64');
    }),
    bioRemove: jest.fn(async () => { bioKey = null; return true; }),
  };
  return m;
}

module.exports = { fakePinKey };
