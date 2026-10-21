// FUZZING-KAMPAGNE, Teil 4: Attachment-Metadaten (Prioritaet 7 des Mandats) -
// ImageCrypto.js/AudioCrypto.js's processImageChunk/processAudioChunk (ECHTE
// Produktionsfunktionen, siehe App.tsx:1912 - "normales Bild waehrend Chat
// offen") und RTCStore.js's inline Chunk-Puffer-Logik in setConnection()
// (ECHTE Produktionslogik fuer den Hintergrund-Puffer-Pfad, wenn kein Chat-
// Screen offen ist) - beide bauen `chunks: new Array(msg.total)` aus
// attacker-/peer-kontrollierten Metadaten (imageId/audioId, index, total,
// mimeType, realLen) OHNE vorherige Validierung.
//
// ABGRENZUNG: chunkBinding.test.js/chunkPadding.test.js decken bereits (mit
// FESTEN Einzelfaellen): falsche imageId, out-of-range Index (99), fehlender
// Chunk, doppelter Index 0, falsches total im End-Marker, fehlendes realLen.
// Diese Datei fuzzt (a) die BOUNDARY-INTEGER-Dimension aus dem Mandat
// systematisch (0, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER,
// nicht-ganzzahlige Werte, riesige aber gueltige Ganzzahlen) fuer `total`
// UND `index`, sowie (b) zwei urspruenglich hier gefundene Bugs in der
// PRODUKTIONSLOGIK selbst, MITTLERWEILE BEHOBEN (siehe ImageCrypto.js/
// AudioCrypto.js/RTCStore.js/App.tsx, Fund 7a/7b): `new Array(msg.total)`
// warf vorher eine synchrone RangeError, wenn total negativ/NaN/Infinity/
// nicht-ganzzahlig war - jetzt validiert und sauber verworfen. `buf.received++`
// zaehlte vorher jede eingehende Nachricht statt jedes EINDEUTIGEN Index,
// wodurch doppelte/out-of-range Indizes eine VERFRUEHTE, unvollstaendige
// "Fertigstellung" ausloesen konnten - jetzt nur beim ersten Befuellen eines
// Index gezaehlt. Die Tests unten belegen das FIXIERTE Verhalten.
const fc = require('fast-check');
const crypto = require('crypto');

const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const { processImageChunk } = require('../../ImageCrypto');
const { processAudioChunk } = require('../../AudioCrypto');

const SEED = 20260101;

const boundaryIntegers = fc.oneof(
  fc.constant(0),
  fc.constant(-1),
  fc.constant(-1000000),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(1.5),
  fc.constant(0.1),
  fc.constant(Number.MAX_SAFE_INTEGER),
  fc.constant(Number.MAX_SAFE_INTEGER + 1),
  fc.integer({ min: -100, max: 100 }),
);

// ─────────────────────────────────────────────────────────────────────────
// A) processImageChunk/processAudioChunk (ImageCrypto.js/AudioCrypto.js,
// ECHTE Produktionsfunktionen) mit fuzzed `total` - RangeError aus
// `new Array(total)` MUSS entweder abgefangen werden oder als klar
// definierter, dokumentierter Fehlerfall gelten (aktuell: wirft uncaught,
// siehe Regressionstest unten, der den GENAUEN minimalen Fall festhaelt).
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: processImageChunk/processAudioChunk mit fuzzed `total` (boundary integers)', () => {
  test('fuzzed total-Werte werfen bei processImageChunk NIE mehr - ungueltige Werte werden verworfen statt eine RangeError auszuloesen (Fund 7a, behoben)', () => {
    fc.assert(
      fc.property(boundaryIntegers, fc.string({ minLength: 1, maxLength: 20 }), (total, imageId) => {
        expect(() => processImageChunk({ type: 'img_chunk', imageId: 'img_' + imageId, index: 0, total, data: 'AAAA', mimeType: 'image/jpeg' }))
          .not.toThrow();
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  test('fuzzed total-Werte werfen bei processAudioChunk NIE mehr (Fund 7a, behoben)', () => {
    fc.assert(
      fc.property(boundaryIntegers, fc.string({ minLength: 1, maxLength: 20 }), (total, audioId) => {
        expect(() => processAudioChunk({ type: 'audio_chunk', audioId: 'audio_' + audioId, index: 0, total, data: 'AAAA' }))
          .not.toThrow();
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  // MINIMALER, KONKRETER REGRESSIONSTEST (Mandat: "jeder gefundene Fehler
  // bekommt eine dauerhafte, minimale, reproduzierbare Regression, extrahiert
  // aus dem konkreten fehlschlagenden Input"). Fund 7a wurde in ImageCrypto.js/
  // AudioCrypto.js/RTCStore.js/App.tsx behoben (Bounds-/Typ-Check auf `total`
  // vor `new Array(total)`) - diese Tests belegen jetzt das FIXIERTE Verhalten
  // (kein Wurf mehr, ungueltiger Chunk wird sauber verworfen) statt den
  // vorherigen Bug zu dokumentieren.
  test('REGRESSION: total=-1 wirft keine RangeError mehr in processImageChunk, sondern wird sauber verworfen (Fund 7a, behoben)', () => {
    expect(() => processImageChunk({ type: 'img_chunk', imageId: 'x', index: 0, total: -1, data: 'AAAA', mimeType: 'image/jpeg' }))
      .not.toThrow();
    // Kein Puffer wurde angelegt - ein nachfolgendes img_end fuer dieselbe
    // imageId findet nichts und liefert null, statt jemals "fertig" zu werden.
    expect(processImageChunk({ type: 'img_end', imageId: 'x' })).toBeNull();
  });

  test('REGRESSION: total=NaN wirft keine RangeError mehr in processAudioChunk (Fund 7a, behoben)', () => {
    expect(() => processAudioChunk({ type: 'audio_chunk', audioId: 'x', index: 0, total: NaN, data: 'AAAA' }))
      .not.toThrow();
    expect(processAudioChunk({ type: 'audio_end', audioId: 'x' })).toBeNull();
  });

  test('REGRESSION: total=1.5 (nicht-ganzzahlig) wirft keine RangeError mehr in processImageChunk (Fund 7a, behoben)', () => {
    expect(() => processImageChunk({ type: 'img_chunk', imageId: 'x', index: 0, total: 1.5, data: 'AAAA', mimeType: 'image/jpeg' }))
      .not.toThrow();
    expect(processImageChunk({ type: 'img_end', imageId: 'x' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// B) Diese RangeError erreicht sie den PROZESS uncaught, wenn sie ueber den
// echten Live-Empfangspfad ausgeloest wird (App.tsx:1912, "await import
// ('./ImageCrypto').then(({processImageChunk}) => {...})")? Gefuzzt gegen
// den echten WebRTCManager-Kanal (die aeussere try/catch in channel.onmessage
// faengt NUR synchrone Fehler INNERHALB des img_chunk/img_end-Zweigs selbst
// ab, nicht Fehler, die App.tsx erst NACH onMessage(original) in einem
// eigenen .then() ausloest - siehe Kommentar im Test).
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: fuzzed total ueber den echten WebRTCManager-Live-Pfad bis zu onMessage', () => {
  const { WebRTCManager } = require('../../WebRTCManager');
  const { encryptMsg } = require('../../MessageCrypto');
  function fakeChannel() { return { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null }; }

  // Wichtige Praezisierung, waehrend dieser Test entstand: `JSON.stringify()`
  // serialisiert NaN/Infinity/-Infinity selbst als `null` (JSON kennt diese
  // Werte nicht) - ein Angreifer, der rohe JSON-BYTES ueber die Leitung
  // schickt (nicht ueber JSON.stringify(irgendein JS-Objekt) erzeugt), kann
  // `NaN` ueberhaupt nicht als gueltiges JSON senden (kein Token dafuer),
  // wohl aber +/-Infinity NAEHERUNGSWEISE ueber ueberlaufende Zahlenliteral-
  // Syntax wie `1e400`/`-1e400` (syntaktisch gueltiges JSON, das JS beim
  // Parsen zu Infinity/-Infinity ueberlaufen laesst). Deshalb wird das
  // Rohpaket hier bewusst per Hand als JSON-TEXT gebaut, nicht ueber
  // JSON.stringify(total) - das simuliert den tatsaechlichen Angreifer-
  // Freiheitsgrad korrekt (er schreibt Bytes, kein JS-Objekt).
  function rawTotalToJsonLiteral(total) {
    if (Number.isNaN(total)) return null; // NaN ist nicht sendbar - siehe oben, wird separat nicht getestet
    if (total === Infinity) return '1e400';
    if (total === -Infinity) return '-1e400';
    return String(total);
  }

  test('ein fuzzed `total` (als rohes JSON-Zahlenliteral, inkl. ueberlaufender +/-Infinity-Syntax) kommt unveraendert/ungeprueft bei onMessage an - WebRTCManager selbst validiert `total` nicht, bevor es an den Aufrufer weitergereicht wird', async () => {
    await fc.assert(
      fc.asyncProperty(boundaryIntegers, async (total) => {
        const literal = rawTotalToJsonLiteral(total);
        fc.pre(literal !== null); // NaN ueberspringen - nicht als gueltiges JSON sendbar, siehe Kommentar oben

        const secret = crypto.randomBytes(32).toString('base64');
        const rtc = new WebRTCManager(() => {}, () => {}, () => {});
        rtc.sharedSecret = secret;
        rtc.keyExchangeDone = true;
        const channel = fakeChannel();
        rtc._setupDataChannel(channel);
        const received = [];
        rtc.onMessage = (m) => received.push(m);

        const chunkPayload = `{"type":"img_chunk","imageId":"fuzz","index":0,"total":${literal},"data":"AAAA","mimeType":"image/jpeg"}`;
        expect(() => JSON.parse(chunkPayload)).not.toThrow(); // bestaetigt: syntaktisch gueltiges JSON
        const enc = await encryptMsg(chunkPayload, secret);
        await expect(channel.onmessage({ data: JSON.stringify({ type: 'encrypted', data: enc }) })).resolves.not.toThrow();

        expect(received.length).toBe(1);
        // WebRTCManager reicht img_chunk/img_end OHNE jede Validierung durch
        // (siehe WebRTCManager.js:438-442, "img_chunk und img_end direkt an
        // RTCStore ohne Log") - `total` kommt 1:1 (inkl. Infinity/negativ)
        // beim Aufrufer an. Das ist der Punkt, an dem ein nachgelagerter
        // Aufrufer (RTCStore.js/App.tsx-Inline-Logik, siehe Beschreibung
        // unten) `new Array(total)` ungeprueft ausfuehrt.
        expect(received[0].total).toBe(total);
        rtc.close();
      }),
      { seed: SEED, numRuns: 60 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C) RTCStore.js's eigene, GETRENNTE inline Chunk-Puffer-Implementierung
// (Hintergrundpfad, wenn kein Chat-Listener registriert ist) - dieselbe
// `new Array(msg.total)`-Konstruktion, aber ein KOMPLETT SEPARATER
// Code-Pfad von ImageCrypto.js/AudioCrypto.js (Copy-Paste-Duplikation,
// siehe RTCStore.js:41,80,112). Bestaetigt: derselbe Bug existiert doppelt,
// unabhaengig voneinander behebbar/uebersehbar.
// ─────────────────────────────────────────────────────────────────────────
describe('FUZZ: RTCStore.js Hintergrund-Puffer-Pfad (separate Implementierung) - dieselbe `new Array(total)`-Schwachstelle, unabhaengig von ImageCrypto.js', () => {
  const RTCStore = require('../../RTCStore').default;
  const { WebRTCManager } = require('../../WebRTCManager');

  afterEach(() => {
    RTCStore.resetAll();
  });

  test('REGRESSION: ein img_chunk mit total=-1, ueber den echten RTCStore.setConnection()-Puffer-Pfad (kein Listener registriert) zugestellt, wirft eine RangeError INNERHALB des rtc.onMessage-Callbacks - abgefangen von WebRTCManagers aeusserer try/catch (kein Prozessabsturz), aber die Nachricht wird komplett verworfen statt eine Fehlerbehandlung auszuloesen', async () => {
    const secret = crypto.randomBytes(32).toString('base64');
    const chatId = 'rtcstore_fuzz_' + crypto.randomBytes(4).toString('hex');
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    rtc.sharedSecret = secret;
    rtc.keyExchangeDone = true;
    RTCStore.setConnection(chatId, rtc); // installiert den echten Produktions-onMessage-Handler
    // Bewusst KEIN setMessageListener() - das erzwingt den Hintergrund-
    // Pufferpfad (RTCStore.js:75-92 fuer img_chunk), nicht den Listener-Pfad.

    const channel = { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null };
    rtc._setupDataChannel(channel);
    const { encryptMsg } = require('../../MessageCrypto');
    const chunkPayload = JSON.stringify({ type: 'img_chunk', imageId: 'x', index: 0, total: -1, data: 'AAAA', mimeType: 'image/jpeg' });
    const enc = await encryptMsg(chunkPayload, secret);

    // Die WebRTCManager-eigene try/catch um den gesamten onmessage-Body
    // faengt den synchronen Wurf aus RTCStore's onMessage-Callback ab (er
    // wird SYNCHRON innerhalb desselben try-Blocks aufgerufen, kein await
    // dazwischen) - deshalb hier "resolves.not.toThrow()", nicht "rejects".
    await expect(channel.onmessage({ data: JSON.stringify({ type: 'encrypted', data: enc }) })).resolves.not.toThrow();

    // Die Nachricht selbst ist verloren - kein Buffer-Eintrag fuer imageId
    // 'x', obwohl der Chunk gueltig verschluesselt/authentifiziert war.
    expect(RTCStore.imgBuffer?.has(chatId + '_x')).toBeFalsy();
    RTCStore.clearContact(chatId);
    rtc.close();
  });

  test('doppelter Index (zwei img_chunk-Nachrichten fuer denselben Index) fuehrt im Hintergrund-Puffer-Pfad NICHT MEHR zu einer verfruehten Fertigstellung - der fehlende Index bleibt erkennbar unvollstaendig (Fund 7b, behoben)', async () => {
    const secret = crypto.randomBytes(32).toString('base64');
    const chatId = 'rtcstore_dup_' + crypto.randomBytes(4).toString('hex');
    const rtc = new WebRTCManager(() => {}, () => {}, () => {});
    rtc.sharedSecret = secret;
    rtc.keyExchangeDone = true;
    RTCStore.setConnection(chatId, rtc);
    // Bewusst KEIN setMessageListener() - der image_complete-Synthese-Code
    // (RTCStore.js:93-127) laeuft NUR im Hintergrund-Pufferpfad (kein
    // Listener registriert). Mit einem Listener wuerde cb(msg) jedes rohe
    // img_chunk/img_end 1:1 durchreichen, OHNE die Zusammensetzungslogik
    // (und damit auch ohne den hier untersuchten Bug) je zu durchlaufen.

    const channel = { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null };
    rtc._setupDataChannel(channel);
    const { encryptMsg } = require('../../MessageCrypto');

    async function send(payload) {
      const enc = await encryptMsg(JSON.stringify(payload), secret);
      await channel.onmessage({ data: JSON.stringify({ type: 'encrypted', data: enc }) });
    }

    // total=2, aber Index 0 wird ZWEIMAL geschickt, Index 1 NIE.
    await send({ type: 'img_chunk', imageId: 'dup', index: 0, total: 2, data: 'AAAA', mimeType: 'image/jpeg' });
    await send({ type: 'img_chunk', imageId: 'dup', index: 0, total: 2, data: 'BBBB', mimeType: 'image/jpeg' });
    await send({ type: 'img_end', imageId: 'dup', total: 2, mimeType: 'image/jpeg' });

    // Fix bestaetigt: `received` zaehlt jetzt nur noch EINDEUTIGE, erstmals
    // befuellte Indizes (RTCStore.js: `if (!alreadyFilled) buf.received++`).
    // Zwei Nachrichten fuer denselben Index 0 zaehlen also nur einmal -
    // `buf.received` (1) erreicht `buf.total` (2) NIE, image_end erkennt die
    // Luecke korrekt und liefert nichts, statt eine korrupte "Fertigstellung"
    // zu synthetisieren.
    const buffered = RTCStore.getBuffered(chatId);
    const completed = buffered.find((m) => m.type === 'image_complete' && m.imageId === 'dup');
    expect(completed).toBeUndefined();
    RTCStore.clearContact(chatId);
    rtc.close();
  });
});
