// FUZZING-KAMPAGNE, Teil 2: Schluesselmaterial (Prioritaet 4 des Mandats) -
// Kyber Public-Key/Ciphertext-Felder, wie sie ueber kyber_pubkey/
// kyber_ciphertext auf dem DataChannel ankommen: kyberEncapsulate(msg.
// publicKey) / kyberDecapsulate(msg.cipherText, secretKey).
//
// WICHTIGE ASYMMETRIE (bewusst so belassen, nicht ausgeglichen): web/src/
// lib/HybridCrypto.ts nutzt ECHTES @noble/post-quantum ml-kem768 (laueft
// vollstaendig unter Node/Jest) - Fuzzing hier deckt die tatsaechliche,
// produktiv genutzte ML-KEM-768-Implementierung ab, mit echten Laengen-/
// Formatpruefungen. HybridCrypto.js (nativ) delegiert an NativeModules.
// KyberModule, das nur auf einem echten Android-Geraet/Emulator existiert -
// unter Jest wird es (wie in jedem bestehenden Test dieser Suite, siehe
// helpers/nativeBridgeMock.js) durch einen simplen SHA-256/SecureRandom-
// Mock ersetzt, der KEINE Laengen-/Formatvalidierung durchfuehrt (die echte
// BouncyCastle-ML-KEM-768-Validierung lebt ausschliesslich in Kotlin, siehe
// "Nicht fuzzbar unter Jest" im Abschlussbericht). Fuzzing gegen den Mock
// wuerde nur das Mock selbst pruefen, nicht die echte Kryptografie - deshalb
// liegt der Schwerpunkt hier auf der WEB-Seite (echte Kryptografie) plus dem
// gemeinsamen WebRTCManager-Dispatch-Pfad (State-Konsistenz bei einer
// throwenden kyberEncapsulate/kyberDecapsulate, unabhaengig davon ob nativ
// oder web).
const fc = require('fast-check');
const crypto = require('crypto');

const webHC = require('../../web/src/lib/HybridCrypto.ts');

const SEED = 20260101;

describe('FUZZ: web HybridCrypto (echtes ML-KEM-768) - malformed publicKey/cipherText, niemals uncaught throw eskalieren lassen', () => {
  test('kyberEncapsulate mit beliebigem Base64-Muell als publicKey wirft NUR eine normale, synchron fangbare Exception (kein Absturz/Hang) - dokumentiert das erwartete "Bibliothek wirft bei falscher Laenge" Verhalten', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), async (garbage) => {
        // ml_kem768.encapsulate() validiert die Public-Key-Laenge strikt
        // (1184 Bytes fuer ML-KEM-768) und wirft synchron bei falscher
        // Laenge/ungueltigem Format - erwartetes, dokumentiertes Verhalten
        // einer auditierten Kryptobibliothek, kein Bug. Wichtig ist NUR:
        // es wird kein Promise, das nie resolved/rejected (Hang), und keine
        // andere als eine normale JS-Exception erzeugt.
        try {
          await webHC.kyberEncapsulate(garbage);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { seed: SEED, numRuns: 150 },
    );
  });

  test('kyberEncapsulate mit leerem String / extrem oversized String als publicKey wirft kontrolliert, nie ein Hang/Absturz', async () => {
    const cases = ['', 'A'.repeat(100000), Buffer.alloc(1184 * 100, 0xff).toString('base64')];
    for (const c of cases) {
      try {
        const r = await webHC.kyberEncapsulate(c);
        // Kein Wurf ist nur akzeptabel, wenn trotzdem ein wohlgeformtes
        // Ergebnis zurueckkommt (kein halbfertiges/undefined-Objekt).
        expect(typeof r.cipherText).toBe('string');
        expect(typeof r.sharedSecret).toBe('string');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  test('kyberDecapsulate mit fuzzed cipherText UND fuzzed secretKey wirft kontrolliert (nie Hang, immer eine normale Error-Instanz)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 300 }),
        fc.string({ maxLength: 300 }),
        async (cipherGarbage, secretGarbage) => {
          try {
            await webHC.kyberDecapsulate(cipherGarbage, secretGarbage);
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
          }
        },
      ),
      { seed: SEED, numRuns: 150 },
    );
  });

  test('ein aus einem ECHTEN Schluesselpaar gewonnener, aber auf falsche Laenge TRUNKIERTER cipherText fuehrt bei kyberDecapsulate NIE zu einer stillen Falsch-Akzeptanz (entweder wirft es, oder das Ergebnis unterscheidet sich vom echten sharedSecret)', async () => {
    const kp = await webHC.generateKyberKeypair();
    const { cipherText, sharedSecret: realSharedSecret } = await webHC.kyberEncapsulate(kp.publicKey);
    const raw = Buffer.from(cipherText, 'base64');
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: raw.length - 1 }), async (cutLen) => {
        const truncated = raw.slice(0, cutLen).toString('base64');
        try {
          const result = await webHC.kyberDecapsulate(truncated, kp.secretKey);
          // Kein Wurf ist nur akzeptabel, wenn das Ergebnis NICHT zufaellig
          // das echte sharedSecret trifft (ML-KEM ist bei falscher Laenge
          // deterministisch implizit fail-closed ueber die Laengenpruefung
          // der Bibliothek - dieser Zweig sollte in der Praxis nie erreicht
          // werden, siehe Assertion unten).
          expect(result).not.toBe(realSharedSecret);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { seed: SEED, numRuns: 40 },
    );
  });
});

describe('FUZZ: WebRTCManager (web) Kyber-Handler - throw in kyberEncapsulate/kyberDecapsulate laesst Key-State konsistent zurueck (kein Teilzustand)', () => {
  const { WebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');
  function fakeChannel() { return { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null }; }

  test('kyber_pubkey mit einem publicKey, der die ECHTE ML-KEM-768-Laengenpruefung nicht besteht, wirft nicht uncaught aus dem DataChannel-Handler und laesst keyExchangeDone/sharedSecret unveraendert (fuzzed ueber viele Laengen)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2000 }).map((n) => crypto.randomBytes(n).toString('base64')),
        async (fuzzedPublicKey) => {
          const rtc = new WebRTCManager(() => {}, () => {}, () => {});
          const channel = fakeChannel();
          rtc._setupDataChannel(channel);
          await expect(channel.onmessage({
            data: JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: fuzzedPublicKey }),
          })).resolves.not.toThrow();
          // Bei falscher Laenge (der ueberwiegenden Mehrheit der fuzzed Werte,
          // da ML-KEM-768 exakt 1184 Bytes erwartet) MUSS der Zustand
          // vollstaendig unveraendert (kein Teilerfolg) bleiben.
          if (Buffer.from(fuzzedPublicKey, 'base64').length !== 1184) {
            expect(rtc.keyExchangeDone).toBe(false);
            expect(rtc.sharedSecret).toBeNull();
          }
          rtc.close();
        },
      ),
      { seed: SEED, numRuns: 40 },
    );
  });

  test('kyber_ciphertext mit fuzzed cipherText (myKyberKeys nie gesetzt, Initiator-Rolle nie angenommen) wirft nicht uncaught, Zustand bleibt konsistent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 500 }), async (fuzzedCipherText) => {
        const rtc = new WebRTCManager(() => {}, () => {}, () => {});
        const channel = fakeChannel();
        rtc._setupDataChannel(channel);
        await expect(channel.onmessage({
          data: JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: fuzzedCipherText }),
        })).resolves.not.toThrow();
        expect(rtc.keyExchangeDone).toBe(false);
        expect(rtc.sharedSecret).toBeNull();
        rtc.close();
      }),
      { seed: SEED, numRuns: 40 },
    );
  });

  test('publicKey/cipherText mit type confusion (Zahl, Array, Objekt, null statt String) wirft nicht uncaught aus dem DataChannel-Handler', async () => {
    const typeConfusedValues = fc.oneof(
      fc.integer(),
      fc.array(fc.integer(), { maxLength: 20 }),
      fc.object(),
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
    );
    await fc.assert(
      fc.asyncProperty(typeConfusedValues, async (weirdValue) => {
        const rtc = new WebRTCManager(() => {}, () => {}, () => {});
        const channel = fakeChannel();
        rtc._setupDataChannel(channel);
        // JSON.stringify(undefined) liefert undefined (kein gueltiges JSON) -
        // in dem Fall stattdessen 'null' im Roh-Payload verwenden, das ist
        // selbst schon einer der zu testenden Faelle.
        const raw = JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: weirdValue }) ?? 'null';
        await expect(channel.onmessage({ data: raw })).resolves.not.toThrow();
        expect(rtc.keyExchangeDone).toBe(false);
        rtc.close();
      }),
      { seed: SEED, numRuns: 60 },
    );
  });
});
