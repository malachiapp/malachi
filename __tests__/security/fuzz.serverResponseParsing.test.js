// FUZZING-KAMPAGNE, Teil 6: Server-Antworten (Prioritaet 6 des Mandats,
// explizit als "bisher unterbeleuchtet" markiert - fast alle bisherigen
// Tests fuzzen Client->Server, dies ist die Rueckrichtung) - was passiert,
// wenn ein kompromittierter/MITM-positionierter Relay der APP selbst
// malformte, falsch-typisierte oder unerwartet geformte JSON-Antworten
// zurueckgibt? Getestet wird nur noch web/src/lib/RelayClient.ts (Web, vorerst
// unveraendert ausgeklammert) - die native App ist seit Okt. 2026 serverlos,
// RelayClient.js gibt es nicht mehr. Der Web-Client ruft `fetch(...)` auf und
// verarbeiten `await res.json()`. `global.fetch` wird hier per Mock durch
// fuzzed Antworten ersetzt (KEIN echter Netzwerkzugriff, erst recht nicht
// gegen den echten Produktions-Relay - Sicherheitsvorgabe des Mandats).
//
// Bedrohungsmodell: ein boesartiger/kompromittierter Relay-Betreiber, ein
// aktiver MITM (relevant nur ohne TLS oder bei akzeptierten ungueltigen
// Zertifikaten) oder schlicht ein fehlerhafter Relay-Prozess.
const fc = require('fast-check');

const SEED = 20260101;

// Arbitrary fuer "beliebig fuzzed Server-Antwortkoerper" (auch strukturell
// unerwartete Formen: packets/offer/answer als Zahl/String/Objekt statt des
// erwarteten Arrays/Strings).
const fuzzedJsonBody = fc.oneof(
  { maxDepth: 3 },
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.string({ maxLength: 100 }),
  fc.boolean(),
  fc.array(fc.anything({ maxDepth: 2 }), { maxLength: 10 }),
  fc.dictionary(fc.string({ maxLength: 10 }), fc.anything({ maxDepth: 2 }), { maxKeys: 8 }),
);

function mockFetchJsonOnce(bodyValue, { ok = true, status = 200 } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => bodyValue,
  });
}

function mockFetchRejects() {
  global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
}

function mockFetchJsonThrows() {
  // Simuliert eine Antwort, die res.json() nicht als gueltiges JSON
  // parsen kann (z.B. ein abgeschnittener/kaputter Response-Body).
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
  });
}

describe('FUZZ: web RelayClient.ts - fuzzed Server-Antworten wirft nie uncaught (Parser-Differential-Check gegen die native Seite oben)', () => {
  let WebRelayClient;
  beforeEach(() => {
    jest.resetModules();
    WebRelayClient = require('../../web/src/lib/RelayClient.ts');
  });
  afterEach(() => {
    delete global.fetch;
  });

  test('getPackets liefert bei fuzzed Antwortkoerper nie throw (identisches `data.packets || []`-Muster wie nativ receiveFromRelay)', async () => {
    await fc.assert(
      fc.asyncProperty(fuzzedJsonBody, async (body) => {
        mockFetchJsonOnce(body);
        await expect(WebRelayClient.getPackets('x')).resolves.not.toThrow();
      }),
      { seed: SEED, numRuns: 100 },
    );
  });

  test('REGRESSION (symmetrisch zum nativen Fix oben): web getPackets liefert jetzt ebenfalls [] statt eines Nicht-Array-Werts, wenn der Relay {packets: "text"} liefert (Fund behoben)', async () => {
    mockFetchJsonOnce({ packets: 'text' });
    const result = await WebRelayClient.getPackets('x');
    expect(result).toEqual([]);
  });

  test('pepperRequest liefert bei fuzzed 200er-Antwortkoerper nie throw, und bei fuzzed 423er-Antwortkoerper (lockedUntil fehlt/falscher Typ) ebenfalls nie throw', async () => {
    await fc.assert(
      fc.asyncProperty(fuzzedJsonBody, fc.boolean(), async (body, is423) => {
        mockFetchJsonOnce(body, is423 ? { ok: false, status: 423 } : { ok: true, status: 200 });
        let result;
        await expect((async () => { result = await WebRelayClient.pepperRequest('device123456789012'); })()).resolves.not.toThrow();
        expect(result).toHaveProperty('ok');
      }),
      { seed: SEED, numRuns: 100 },
    );
  });

  test('pepperFail/pepperSuccess liefern bei fuzzed Antwortkoerper nie throw', async () => {
    await fc.assert(
      fc.asyncProperty(fuzzedJsonBody, async (body) => {
        mockFetchJsonOnce(body);
        await expect(WebRelayClient.pepperFail('d', 't')).resolves.not.toThrow();
        mockFetchJsonOnce(body);
        await expect(WebRelayClient.pepperSuccess('d', 't')).resolves.not.toThrow();
      }),
      { seed: SEED, numRuns: 80 },
    );
  });

  test('ein Netzwerkfehler (fetch rejects) fuehrt bei JEDER Funktion zum dokumentierten Fail-Closed-Default, nie zu einer unhandled rejection', async () => {
    mockFetchRejects();
    await expect(WebRelayClient.getSignalOffer('x')).resolves.toBeNull();
    await expect(WebRelayClient.getPackets('x')).resolves.toEqual([]);
    await expect(WebRelayClient.pollCallSignals('x', 'to-callee')).resolves.toEqual([]);
    await expect(WebRelayClient.pepperRequest('d')).resolves.toEqual({ ok: false, reason: 'network' });
    await expect(WebRelayClient.pepperFail('d', 't')).resolves.toEqual({ wiped: false });
    await expect(WebRelayClient.getTurnCredentials()).resolves.toBeNull();
  });

  // Siehe Kommentar im nativen Block oben - identischer Fund/Fix, symmetrisch
  // auf der Web-Seite.
  const webSendFunctionsCheckOk = [
    ['sendSignalOffer', ['offer-data', 'token-x']],
    ['sendSignalAnswer', ['answer-data', 'token-x']],
    ['sendReconnectOffer', ['offer-data', 'contact-x']],
    ['sendReconnectAnswer', ['answer-data', 'contact-x']],
  ];

  test.each(webSendFunctionsCheckOk)('REGRESSION: web %s gibt jetzt false zurueck, wenn der Relay einen 4xx/5xx-Status liefert (vorher: true trotz Fehlerstatus)', async (fnName, args) => {
    mockFetchJsonOnce({ error: 'ungueltige_anfrage' }, { ok: false, status: 400 });
    await expect(WebRelayClient[fnName](...args)).resolves.toBe(false);
  });

  test.each(webSendFunctionsCheckOk)('web %s gibt weiterhin true zurueck bei einer echten 200er-Antwort (unveraendertes Verhalten)', async (fnName, args) => {
    mockFetchJsonOnce({ ok: true }, { ok: true, status: 200 });
    await expect(WebRelayClient[fnName](...args)).resolves.toBe(true);
  });
});
