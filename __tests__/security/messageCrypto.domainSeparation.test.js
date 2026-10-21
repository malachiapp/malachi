// Sicherheitsreview 4 - Testet die purpose-basierte HKDF-Domain-Trennung
// (Sicherheitsreview Review 2): eine mit purpose='reconnect' verschluesselte
// Nachricht darf sich NICHT mit einem anderen purpose entschluesseln lassen,
// und umgekehrt. Zusaetzlich ein Cross-Implementation-Check: native und web
// muessen fuer denselben purpose wire-kompatibel sein (das behauptet Review 2
// - dieser Test ist der Regressions-Check dafuer).
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const native = require('../../MessageCrypto');
const web = require('../../web/src/lib/MessageCrypto.ts');

const PURPOSES = ['message', 'reconnect', 'call-signal', 'arbitrary-purpose'];

function randomSecretB64() {
  return require('crypto').randomBytes(32).toString('base64');
}

describe.each([
  ['native', native],
  ['web', web],
])('%s MessageCrypto - Domain Separation (purpose)', (name, impl) => {
  const secret = randomSecretB64();
  const plaintext = 'Domain-Separation-Testnachricht';

  test.each(PURPOSES)('purpose=%s rundtrip erfolgreich unter demselben purpose', async (purpose) => {
    const enc = await impl.encryptMsg(plaintext, secret, purpose);
    expect(enc).not.toBeNull();
    expect(impl.decryptMsg(enc, secret, purpose)).toBe(plaintext);
  });

  test('jede Off-Diagonale (encrypt unter A, decrypt unter B != A) schlaegt fehl', async () => {
    for (const purposeA of PURPOSES) {
      const enc = await impl.encryptMsg(plaintext, secret, purposeA);
      for (const purposeB of PURPOSES) {
        if (purposeA === purposeB) continue;
        expect(impl.decryptMsg(enc, secret, purposeB)).toBeNull();
      }
    }
  });

  test('default purpose (kein drittes Argument) verhaelt sich identisch zu purpose="message"', async () => {
    const encDefault = await impl.encryptMsg(plaintext, secret);
    // Mit explizitem 'message' entschluesselbar, weil default === 'message'
    expect(impl.decryptMsg(encDefault, secret, 'message')).toBe(plaintext);
    const encExplicit = await impl.encryptMsg(plaintext, secret, 'message');
    expect(impl.decryptMsg(encExplicit, secret)).toBe(plaintext); // umgekehrt
  });
});

describe('Cross-Implementation (native <-> web) - gleicher purpose muss kompatibel sein', () => {
  const secret = require('crypto').randomBytes(32).toString('base64');
  const plaintext = 'Cross-Plattform-Testnachricht 🔐';

  test.each(PURPOSES)('purpose=%s: native verschluesselt, web entschluesselt', async (purpose) => {
    const enc = await native.encryptMsg(plaintext, secret, purpose);
    expect(enc).not.toBeNull();
    expect(web.decryptMsg(enc, secret, purpose)).toBe(plaintext);
  });

  test.each(PURPOSES)('purpose=%s: web verschluesselt, native entschluesselt', async (purpose) => {
    const enc = await web.encryptMsg(plaintext, secret, purpose);
    expect(enc).not.toBeNull();
    expect(native.decryptMsg(enc, secret, purpose)).toBe(plaintext);
  });

  test('native-verschluesselt/purpose=X entschluesselt NICHT auf web/purpose=Y!=X', async () => {
    const enc = await native.encryptMsg(plaintext, secret, 'reconnect');
    expect(web.decryptMsg(enc, secret, 'message')).toBeNull();
    expect(web.decryptMsg(enc, secret, 'call-signal')).toBeNull();
  });
});
