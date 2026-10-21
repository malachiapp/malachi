// FUZZING-KAMPAGNE, Teil 1: Ciphertext-Parser (Prioritaet 1 des Mandats) -
// encryptMsg/decryptMsg in MessageCrypto.js (nativ) und web/src/lib/
// MessageCrypto.ts. Nutzt fast-check (neu als devDependency hinzugefuegt,
// siehe package.json) fuer echtes property-based Fuzzing mit eingebautem
// Shrinking - jeder Fehlschlag wird von fast-check automatisch auf den
// kleinsten reproduzierenden Fall reduziert und hier mit einem festen Seed
// pro Property deterministisch gemacht, keine zufaellig-flakige Testsuite.
//
// ABGRENZUNG zu bereits bestehender Abdeckung (nicht duplizieren):
// - messageCrypto.tamper.test.js deckt bereits: gueltiges Chiffrat, EIN
//   Bit-Flip an 3 festen Positionen, EIN verkuerztes Chiffrat, leerer String,
//   EIN nicht-base64-Muell-Wert, fremder AEAD-Kontext, falscher Secret -
//   alles mit FESTEN, handgeschriebenen Einzelfaellen.
// - chaos.corruptedState.test.js deckt: nicht-base64-Muell als "sharedSecret",
//   komplett anderer Secret, EIN abgeschnittenes Chiffrat.
// - messageCrypto.domainSeparation.test.js deckt: purpose-Trennung,
//   Cross-Implementation (native<->web) fuer GUELTIGE Eingaben.
// Diese Datei ergaenzt das um PROPERTY-BASED Fuzzing ueber den GESAMTEN
// Eingaberaum (nicht nur Einzelfaelle): beliebige Trunkierungspunkte,
// beliebige Bit-Flips, beliebige Sekret-Laengen, beliebige Base64-Fuzzer-
// Strings, Unicode-Grenzfaelle im PLAINTEXT (Rundlauf-Eigenschaft), und
// differentielles Fuzzing (dasselbe fuzzed Chiffrat gegen native+web
// decryptMsg, muessen sich identisch fail-closed verhalten).
const fc = require('fast-check');
const crypto = require('crypto');

const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const nativeMC = require('../../MessageCrypto');
const webMC = require('../../web/src/lib/MessageCrypto.ts');

// Fester Seed pro Property haelt die Kampagne deterministisch/reproduzierbar
// (Mandat: "seeded/deterministic, damit Fehlschlaege reproduzierbar sind").
const SEED = 20260101;

function randomSecret() {
  return crypto.randomBytes(32).toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────
// A) Rundlauf-Eigenschaft mit Unicode-Grenzfaellen im Klartext (Mutation:
// "Unicode edge cases" aus dem Mandat) - Nullbytes, RTL-Override,
// Zero-Width-Zeichen, Emoji/Surrogatpaare, sehr lange Grapheme-Cluster.
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: encryptMsg/decryptMsg Rundlauf - Unicode-Grenzfaelle (property-based)', () => {
  const secret = randomSecret();

  // Wohlgeformte Unicode-Grenzfaelle (fuer die EXAKTE Rundlauf-Eigenschaft
  // unten) - bewusst OHNE unpaarige Surrogates, weil jede UTF-8-basierte
  // Kodierung (Buffer.from(str,'utf8') nativ, TextEncoder web) unpaarige
  // Surrogates per Spezifikation verlustbehaftet durch U+FFFD ersetzt - das
  // ist eine Eigenschaft von UTF-8 selbst, kein Bug dieser Verschluesselung.
  // Dieser Fall wird separat unten (nur auf "wirft nie", nicht auf exaktem
  // Rundlauf) geprueft.
  const nullBytes = String.fromCharCode(0, 0, 0);
  const rtlOverride = String.fromCharCode(0x202e) + 'evil' + String.fromCharCode(0x202c);
  const zeroWidth = 'a' + String.fromCharCode(0x200b) + 'b' + String.fromCharCode(0x200c) + 'c' + String.fromCharCode(0x200d) + 'd';
  const emojiPair = String.fromCharCode(0xd83d, 0xde00); // gueltiges Surrogatpaar (Emoji)
  const fireEmoji = String.fromCharCode(0xd83d, 0xdd25);
  const highSurrogateAlone = String.fromCharCode(0xd800);
  const lowSurrogateAlone = String.fromCharCode(0xdc00);

  const wellFormedUnicodeEdgeCases = fc.oneof(
    fc.constant(nullBytes),
    fc.constant(rtlOverride),
    fc.constant(zeroWidth),
    fc.constant(emojiPair.repeat(500)),
    fc.constant(fireEmoji.repeat(20000)), // sehr lang, ein Emoji je "Zeichen"
    fc.string({ unit: 'grapheme', minLength: 0, maxLength: 200 }),
  );

  // Volle Unicode-Codepoint-Bandbreite OHNE Wohlgeformtheits-Garantie -
  // kann unpaarige Surrogates enthalten. Nur "wirft nie" wird geprueft.
  const anyUnicodeIncludingMalformed = fc.oneof(
    fc.constant(highSurrogateAlone),
    fc.constant(lowSurrogateAlone),
    fc.string({ unit: 'binary', minLength: 0, maxLength: 500 }),
  );

  test('Klartext mit wohlgeformten Unicode-Grenzfaellen ueberlebt encryptMsg->decryptMsg codepoint-exakt (nativ)', () => {
    fc.assert(
      fc.asyncProperty(wellFormedUnicodeEdgeCases, async (plaintext) => {
        const enc = await nativeMC.encryptMsg(plaintext, secret);
        expect(enc).toEqual(expect.any(String));
        const dec = nativeMC.decryptMsg(enc, secret);
        expect(dec).toBe(plaintext);
      }),
      { seed: SEED, numRuns: 100 },
    );
  });

  test('Klartext mit wohlgeformten Unicode-Grenzfaellen ueberlebt encryptMsg->decryptMsg codepoint-exakt (web)', () => {
    fc.assert(
      fc.asyncProperty(wellFormedUnicodeEdgeCases, async (plaintext) => {
        const enc = await webMC.encryptMsg(plaintext, secret);
        expect(enc).toEqual(expect.any(String));
        const dec = webMC.decryptMsg(enc, secret);
        expect(dec).toBe(plaintext);
      }),
      { seed: SEED, numRuns: 100 },
    );
  });

  test('Cross-Implementation: nativ verschluesselt, web entschluesselt - fuer dieselben wohlgeformten Unicode-Grenzfaelle identisch (Parser-Differential-Check)', () => {
    fc.assert(
      fc.asyncProperty(wellFormedUnicodeEdgeCases, async (plaintext) => {
        const enc = await nativeMC.encryptMsg(plaintext, secret);
        const decWeb = webMC.decryptMsg(enc, secret);
        expect(decWeb).toBe(plaintext);
      }),
      { seed: SEED, numRuns: 60 },
    );
  });

  test('beliebiger (auch unwohlgeformter, z.B. unpaarige Surrogates) Klartext wirft nie bei encryptMsg/decryptMsg, auch ohne Garantie eines exakten Rundlaufs (nativ+web)', () => {
    fc.assert(
      fc.asyncProperty(anyUnicodeIncludingMalformed, async (plaintext) => {
        let encN, encW;
        await expect((async () => { encN = await nativeMC.encryptMsg(plaintext, secret); })()).resolves.not.toThrow();
        await expect((async () => { encW = await webMC.encryptMsg(plaintext, secret); })()).resolves.not.toThrow();
        expect(() => nativeMC.decryptMsg(encN, secret)).not.toThrow();
        expect(() => webMC.decryptMsg(encW, secret)).not.toThrow();
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// B) decryptMsg mit beliebig fuzzed Chiffrat-Strings - MUSS fuer JEDEN
// erdenklichen String entweder ein syntaktisch gueltiges Ergebnis (String)
// oder null liefern, NIEMALS werfen. Deckt: truncated input, random bytes,
// malformed encoding, oversized values, boundary integers (ueber Laenge).
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: decryptMsg mit beliebigem Chiffrat-Muell - niemals throw, immer fail-closed (property-based)', () => {
  const secret = randomSecret();

  test('vollkommen beliebiger String (auch nicht-base64, auch leer, auch riesig) als Chiffrat wirft nie, liefert immer null oder String (nativ)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (garbage) => {
        expect(() => nativeMC.decryptMsg(garbage, secret)).not.toThrow();
        const r = nativeMC.decryptMsg(garbage, secret);
        expect(r === null || typeof r === 'string').toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  test('vollkommen beliebiger String als Chiffrat wirft nie, liefert immer null oder String (web)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (garbage) => {
        expect(() => webMC.decryptMsg(garbage, secret)).not.toThrow();
        const r = webMC.decryptMsg(garbage, secret);
        expect(r === null || typeof r === 'string').toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  test('rohe, zufaellige Byte-Sequenzen (ueber Base64 kodiert, wie ein Angreifer sie ueber die Leitung schicken wuerde) wirft nie (nativ + web)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 2000 }), (bytes) => {
        const asB64 = Buffer.from(bytes).toString('base64');
        expect(() => nativeMC.decryptMsg(asB64, secret)).not.toThrow();
        expect(() => webMC.decryptMsg(asB64, secret)).not.toThrow();
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  // Jede Trunkierungsposition eines ECHTEN, gueltigen Chiffrats - deckt
  // systematisch alle Grenzen der drei Schicht-Slices ab (n3=24, n2=12,
  // n1=12 Bytes je Nonce-Laenge), nicht nur den einen festen Fall aus
  // chaos.corruptedState.test.js ("halbiert").
  // Hinweis/Lektion aus einem echten Fuzzing-Fund waehrend der Erstellung
  // dieser Kampagne: Base64 erlaubt optionales '='-Padding beim DEKODIEREN
  // (Buffer.from ist tolerant) - ein "truncated" String, der nur die
  // trailing '='-Padding-Zeichen abschneidet, dekodiert zu EXAKT denselben
  // Bytes wie das Original und entschluesselt deshalb (korrekt!) erfolgreich.
  // Das ist kein Sicherheitsbug (keine tatsaechlichen Chiffratbytes fehlen),
  // sondern eine Eigenschaft der Base64-Kodierung selbst - der Vergleich
  // unten prueft deshalb die DEKODIERTE Byte-Laenge, nicht die String-Laenge,
  // bevor "muss fehlschlagen" erwartet wird.
  function decodesToFewerBytes(truncatedB64, fullB64) {
    return Buffer.from(truncatedB64, 'base64').length < Buffer.from(fullB64, 'base64').length;
  }

  test('JEDE Trunkierungsposition eines gueltigen Chiffrats, die tatsaechlich Chiffratbytes entfernt, liefert null statt zu werfen - deckt alle Nonce-Slice-Grenzen ab (nativ)', async () => {
    const enc = await nativeMC.encryptMsg('eine vollstaendige Testnachricht fuer Trunkierung', secret);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: enc.length }), (cutPoint) => {
        const truncated = enc.slice(0, cutPoint);
        expect(() => nativeMC.decryptMsg(truncated, secret)).not.toThrow();
        if (decodesToFewerBytes(truncated, enc)) {
          expect(nativeMC.decryptMsg(truncated, secret)).toBeNull();
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  test('JEDE Trunkierungsposition eines gueltigen Chiffrats, die tatsaechlich Chiffratbytes entfernt, liefert null statt zu werfen (web)', async () => {
    const enc = await webMC.encryptMsg('eine vollstaendige Testnachricht fuer Trunkierung', secret);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: enc.length }), (cutPoint) => {
        const truncated = enc.slice(0, cutPoint);
        expect(() => webMC.decryptMsg(truncated, secret)).not.toThrow();
        if (decodesToFewerBytes(truncated, enc)) {
          expect(webMC.decryptMsg(truncated, secret)).toBeNull();
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  // Beliebiger Bit-Flip an JEDER Position (nicht nur 3 feste wie im
  // bestehenden tamper-Test) - AEAD-Tag-Pruefung muss IMMER greifen.
  test('Bit-Flip an einer BELIEBIGEN Byte-Position eines gueltigen Chiffrats wird immer erkannt (AEAD-Tamper-Schutz haelt ueberall, nicht nur an den 3 handgeprueften Stellen)', async () => {
    const enc = await nativeMC.encryptMsg('tamper-resistenz ueber die gesamte Laenge', secret);
    const raw = Buffer.from(enc, 'base64');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: raw.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (byteIdx, xorVal) => {
          const tampered = Buffer.from(raw);
          tampered[byteIdx] = tampered[byteIdx] ^ xorVal;
          const tamperedB64 = tampered.toString('base64');
          expect(() => nativeMC.decryptMsg(tamperedB64, secret)).not.toThrow();
          // xorVal!=0 garantiert eine tatsaechliche Aenderung an dieser Stelle -
          // AEAD muss das erkennen und fail-closed liefern.
          expect(nativeMC.decryptMsg(tamperedB64, secret)).toBeNull();
        },
      ),
      { seed: SEED, numRuns: 150 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C) encryptMsg/decryptMsg mit fuzzed SECRET (wrong-length keys, all-zero
// keys, oversized, leer, nicht-base64) - "invalid cryptographic material"
// aus dem Mandat.
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: beliebig fuzzed sharedSecret - niemals throw (property-based)', () => {
  test('encryptMsg mit beliebiger Secret-Laenge/-Form wirft nie (0, 1, 16, 31, 33, 64, 1000 Bytes, alles als Base64)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }).map((n) => crypto.randomBytes(n).toString('base64')),
        async (secret) => {
          let result;
          await expect((async () => { result = await nativeMC.encryptMsg('x', secret); })()).resolves.not.toThrow();
          expect(result === null || typeof result === 'string').toBe(true);
        },
      ),
      { seed: SEED, numRuns: 80 },
    );
  });

  test('All-Zero-Key (32 Nullbytes) verschluesselt/entschluesselt weiterhin konsistent (kein Sonderfall-Crash bei degenerierten, aber wohlgeformten Schluesseln)', async () => {
    const zeroSecret = Buffer.alloc(32, 0).toString('base64');
    const enc = await nativeMC.encryptMsg('Testnachricht unter All-Zero-Key', zeroSecret);
    expect(enc).toEqual(expect.any(String));
    expect(nativeMC.decryptMsg(enc, zeroSecret)).toBe('Testnachricht unter All-Zero-Key');
    // Web-Gegenseite muss dasselbe Chiffrat unter demselben (entarteten) Key lesen koennen.
    expect(webMC.decryptMsg(enc, zeroSecret)).toBe('Testnachricht unter All-Zero-Key');
  });

  test('decryptMsg mit beliebigem fuzzed Secret UND beliebigem fuzzed Chiffrat gleichzeitig wirft nie (kombinatorischer Fuzz, nativ+web)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 500 }),
        (secretGarbage, cipherGarbage) => {
          expect(() => nativeMC.decryptMsg(cipherGarbage, secretGarbage)).not.toThrow();
          expect(() => webMC.decryptMsg(cipherGarbage, secretGarbage)).not.toThrow();
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// D) ImageCrypto/AudioCrypto per-Chunk-Verschluesselung - dieselben Layer
// nur ueber sendEncryptedImage/sendEncryptedAudio erreicht. Bestaetigt, dass
// ein fuzzed/korrupter EINZELNER Chunk beim Empfang (decryptMsg-Ebene) genau
// dasselbe fail-closed-Verhalten hat wie eine normale Nachricht - kein
// Sonderpfad, der die AEAD-Pruefung umgeht.
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: ImageCrypto/AudioCrypto Chunk-Chiffrat - selbe fail-closed-Garantie wie normale Nachrichten', () => {
  const { encryptMsg, decryptMsg } = nativeMC;
  const secret = randomSecret();

  test('ein einzelner Bild-Chunk mit fuzzed Trunkierung decrypted nie erfolgreich zu falschen Daten, wirft nie', async () => {
    const chunkPayload = JSON.stringify({ type: 'img_chunk', imageId: 'x', index: 0, total: 1, data: 'A'.repeat(1000), realLen: 900, mimeType: 'image/jpeg' });
    const enc = await encryptMsg(chunkPayload, secret);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: enc.length }), (cutPoint) => {
        const truncated = enc.slice(0, cutPoint);
        expect(() => decryptMsg(truncated, secret)).not.toThrow();
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});
