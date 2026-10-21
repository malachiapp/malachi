// Sicherheitsreview 4 - Testet, dass die Dreischicht-AEAD-Verschluesselung
// (MessageCrypto.js / web/src/lib/MessageCrypto.ts) manipulierte, verkuerzte
// oder anderweitig ungueltige Chiffrate zuverlaessig ablehnt (gibt null
// zurueck, wirft nie eine ungefangene Exception), statt sie stillschweigend
// falsch oder gar erfolgreich zu entschluesseln.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const native = require('../../MessageCrypto');
const web = require('../../web/src/lib/MessageCrypto.ts');

function randomSecretB64() {
  return require('crypto').randomBytes(32).toString('base64');
}

function flipBit(b64, byteOffset) {
  const buf = Buffer.from(b64, 'base64');
  const idx = ((byteOffset % buf.length) + buf.length) % buf.length;
  buf[idx] = buf[idx] ^ 0x01;
  return buf.toString('base64');
}

describe.each([
  ['native', native],
  ['web', web],
])('%s MessageCrypto - Tamper/Malleability', (name, impl) => {
  const secret = randomSecretB64();
  const plaintext = 'Hallo, das ist eine Testnachricht mit ÄÜÖß 🔐';

  test('gueltiges Chiffrat rundtrip-verschluesselt korrekt', async () => {
    const enc = await impl.encryptMsg(plaintext, secret);
    expect(enc).not.toBeNull();
    expect(impl.decryptMsg(enc, secret)).toBe(plaintext);
  });

  test('Bit-Flip an Start/Mitte/Ende des Chiffrats wird abgelehnt (kein Crash)', async () => {
    const enc = await impl.encryptMsg(plaintext, secret);
    const buf = Buffer.from(enc, 'base64');
    const offsets = [0, 1, Math.floor(buf.length / 2), buf.length - 2, buf.length - 1];
    for (const off of offsets) {
      const tampered = flipBit(enc, off);
      expect(() => impl.decryptMsg(tampered, secret)).not.toThrow();
      expect(impl.decryptMsg(tampered, secret)).toBeNull();
    }
  });

  test('verkuerztes Chiffrat wird abgelehnt', async () => {
    const enc = await impl.encryptMsg(plaintext, secret);
    const truncated = Buffer.from(enc, 'base64').slice(0, 10).toString('base64');
    expect(impl.decryptMsg(truncated, secret)).toBeNull();
  });

  test('leerer String wird abgelehnt', () => {
    expect(impl.decryptMsg('', secret)).toBeNull();
  });

  test('nicht-base64 Muell wird abgelehnt (kein Crash)', () => {
    expect(() => impl.decryptMsg('!!!nicht-base64!!!', secret)).not.toThrow();
    expect(impl.decryptMsg('!!!nicht-base64!!!', secret)).toBeNull();
  });

  test('ein fremdes, aber gueltiges Chiffrat (falscher AEAD-Kontext) wird abgelehnt', async () => {
    const encA = await impl.encryptMsg(plaintext, secret);
    const otherSecret = randomSecretB64();
    const encB = await impl.encryptMsg('andere Nachricht', otherSecret);
    // encB mit dem SCHLUESSEL von A entschluesseln - falscher Schluessel, muss scheitern
    expect(impl.decryptMsg(encB, secret)).toBeNull();
    // Und umgekehrt
    expect(impl.decryptMsg(encA, otherSecret)).toBeNull();
  });

  test('falscher Shared Secret wird abgelehnt', async () => {
    const enc = await impl.encryptMsg(plaintext, secret);
    const wrongSecret = randomSecretB64();
    expect(impl.decryptMsg(enc, wrongSecret)).toBeNull();
  });
});
