// State-Machine-Sicherheitsreview Fund 6b (web/src/lib/Storage.ts): unlockEncryption()
// braucht einen echten Netzwerk-Roundtrip (pepperRequest/pepperSuccess) PLUS
// einen kompletten Re-Verschluesselungsdurchlauf ueber ganz localStorage,
// bevor `dek` gesetzt wird. Fuer den Nutzer galt die PIN da schon als richtig
// (der Marker war schon erfolgreich entschluesselt) - ein waehrenddessen
// laufender getItem()/setItem()-Aufruf schlug bisher trotzdem fehl (getItem:
// null, setItem: wirft) und ging beim dominanten Fire-and-Forget-Muster
// (`.catch(()=>{})`) lautlos verloren. Fix: getItem()/setItem() warten jetzt
// auf ein bereits laufendes unlockEncryption(), statt sofort anzunehmen, der
// Storage sei (noch) gesperrt - kein neuer Netzwerk-Schritt, nur lokales
// Warten auf ein bereits vorhandenes Promise.
//
// Browser-Globals (localStorage/btoa/atob), die Storage.ts direkt benutzt,
// aber die node-testEnvironment nicht mitbringt, minimal geshimmt.
// `crypto.subtle` braucht keinen Shim - Node stellt WebCrypto seit v19 global
// bereit, das nutzen bereits andere Tests in dieser Suite unveraendert
// (z.B. WebRTCManager.ts ueber stateMachine.sendStatusHonesty.test.js).
// Object.keys(localStorage) wird in Storage.ts direkt benutzt (Pepper-
// Rotation) - ein einfacher Map-Wrapper reicht deshalb nicht, der Shim muss
// echte, aufzaehlbare Objekt-Properties liefern. Eine einzige, ueber die
// gesamte Testdatei stabile Map dahinter, damit kein `beforeEach` versehentlich
// die Referenz verliert, auf die der Proxy zeigt.
const localStorageBackingStore = new Map();
function makeLocalStorageProxy(store) {
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'getItem') return (k) => (store.has(k) ? store.get(k) : null);
      if (prop === 'setItem') return (k, v) => { store.set(k, String(v)); };
      if (prop === 'removeItem') return (k) => { store.delete(k); };
      if (prop === 'clear') return () => store.clear();
      return Reflect.get(t, prop);
    },
    ownKeys() { return Array.from(store.keys()); },
    getOwnPropertyDescriptor(t, prop) {
      if (store.has(prop)) return { enumerable: true, configurable: true, value: store.get(prop) };
      return undefined;
    },
  });
}

beforeAll(() => {
  global.localStorage = makeLocalStorageProxy(localStorageBackingStore);
  if (!global.btoa) global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  if (!global.atob) global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
});

jest.mock('../../web/src/lib/RelayClient', () => ({
  pepperRegister: jest.fn(),
  pepperRequest: jest.fn(),
  pepperFail: jest.fn(),
  pepperSuccess: jest.fn(),
}));

describe('web/src/lib/Storage.ts - Entsperr-Zeitfenster (dek noch null waehrend Netzwerk-Roundtrip laeuft)', () => {
  let Storage;
  let RelayClient;

  beforeEach(() => {
    jest.resetModules();
    localStorageBackingStore.clear();
    RelayClient = require('../../web/src/lib/RelayClient');
    Storage = require('../../web/src/lib/Storage.ts');
  });

  test('getItem()/setItem() waehrend eines laufenden unlockEncryption() warten auf dessen Ergebnis, statt sofort "gesperrt" zu melden', async () => {
    const pin = '1234';
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-initial' });
    await Storage.setupEncryption(pin);
    await Storage.setItem('vor_dem_sperren', 'wert_a');
    Storage.lock();

    // pepperRequest kuenstlich verzoegern - simuliert den echten
    // Netzwerk-Roundtrip, waehrend dessen `dek` noch null ist.
    let releasePepperRequest;
    const pepperRequestGate = new Promise((resolve) => { releasePepperRequest = resolve; });
    RelayClient.pepperRequest.mockImplementation(async () => {
      await pepperRequestGate;
      return { ok: true, pepper: 'pepper-initial', attemptToken: 'tok-1' };
    });
    // Keine Pepper-Rotation in diesem Test noetig - haelt den Testfall auf
    // das Kernverhalten (Warten auf das Freischalten) fokussiert.
    RelayClient.pepperSuccess.mockResolvedValue(null);

    const unlockPromise = Storage.unlockEncryption(pin);

    // Waehrend das Entsperren noch haengt (dek === null): ein getItem()- und
    // ein setItem()-Aufruf, wie sie ein fire-and-forget-Callsite im echten
    // Code jederzeit ausloesen koennte.
    const getDuringUnlock = Storage.getItem('vor_dem_sperren');
    const setDuringUnlock = Storage.setItem('waehrend_dem_sperren', 'wert_b');

    // Kurz warten, um sicherzustellen, dass beide Aufrufe tatsaechlich im
    // Warte-Zweig haengen (nicht schon vorher synchron fehlgeschlagen sind).
    await new Promise((r) => setTimeout(r, 20));

    releasePepperRequest();
    const unlockResult = await unlockPromise;
    expect(unlockResult).toEqual({ ok: true });

    // Beide waehrenddessen gestarteten Aufrufe sind NICHT verloren gegangen,
    // sondern haben auf das fertige Entsperren gewartet und danach korrekt
    // funktioniert.
    await expect(getDuringUnlock).resolves.toBe('wert_a');
    await expect(setDuringUnlock).resolves.toBeUndefined();
    await expect(Storage.getItem('waehrend_dem_sperren')).resolves.toBe('wert_b');
  });

  test('ohne laufendes unlockEncryption() bleibt das Verhalten wie vorher: getItem() -> null, setItem() -> wirft', async () => {
    Storage.lock();
    await expect(Storage.getItem('irgendwas')).resolves.toBeNull();
    await expect(Storage.setItem('irgendwas', 'x')).rejects.toThrow();
  });

  test('schlaegt das Entsperren fehl (falscher PIN), warten getItem()/setItem() trotzdem nur bis zu diesem Fehlschlag, bleiben danach im gesperrten Zustand', async () => {
    const pin = '1234';
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-initial' });
    await Storage.setupEncryption(pin);
    Storage.lock();

    let releasePepperRequest;
    const gate = new Promise((resolve) => { releasePepperRequest = resolve; });
    RelayClient.pepperRequest.mockImplementation(async () => {
      await gate;
      return { ok: true, pepper: 'pepper-initial', attemptToken: 'tok-2' };
    });
    RelayClient.pepperFail.mockResolvedValue({ wiped: false, lockedUntil: null });

    const unlockPromise = Storage.unlockEncryption('FALSCHE_PIN');
    const getDuringFailedUnlock = Storage.getItem('irgendwas');
    await new Promise((r) => setTimeout(r, 20));
    releasePepperRequest();

    const result = await unlockPromise;
    expect(result).toEqual({ ok: false, reason: 'wrong_pin' });
    await expect(getDuringFailedUnlock).resolves.toBeNull();
    await expect(Storage.getItem('irgendwas')).resolves.toBeNull();
  });
});

// Fix 3 (SECURITY_CHAOS_TESTING.md §10): zwei verwandte Befunde in
// _unlockEncryptionInner() -
//   (a) ein nicht valider Base64-SALT_KEY liess fromB64()/atob() unbehandelt
//       werfen statt ein strukturiertes UnlockResult zu liefern.
//   (b) lokale Speicherkorruption (egal ob SALT_KEY oder MARKER_KEY) rief
//       trotzdem immer pepperRequest() auf und stellte damit ein echtes,
//       30s gueltiges attemptToken aus - das relay.js selbst (siehe dortiger
//       Kommentar zu /pepper/request, C-3) bei Verfall UNGELOEST als
//       impliziten Fehlversuch gegen den 5-Versuche-Wipe-Zaehler zaehlt.
//       "einfach pepperFail() nicht aufrufen" haette daran nichts geaendert -
//       der einzige Weg, wirklich keinen Versuch zu verbrauchen, ist eine
//       lokale Vorpruefung VOR dem allerersten pepperRequest()-Aufruf.
// Fix: eine reine Wohlgeformtheitspruefung (gueltiges Base64 in plausibler
// AES-GCM-Mindestlaenge) auf SALT_KEY UND MARKER_KEY, bevor pepperRequest()
// je aufgerufen wird - schlaegt sie fehl, liefert unlockEncryption() sofort
// { ok:false, reason:'corrupted' } ohne jeden Netzwerk-Kontakt.
describe('web/src/lib/Storage.ts - Fix 3: lokale Speicherkorruption erkannt VOR pepperRequest(), kein verbrauchter Versuch', () => {
  let Storage;
  let RelayClient;

  beforeEach(() => {
    jest.resetModules();
    localStorageBackingStore.clear();
    RelayClient = require('../../web/src/lib/RelayClient');
    Storage = require('../../web/src/lib/Storage.ts');
  });

  test('korrupter SALT_KEY (kein gueltiges Base64): unlockEncryption() wirft NICHT, liefert {ok:false, reason:"corrupted"}, und pepperRequest() wird NIE aufgerufen', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-initial' });
    await Storage.setupEncryption('1234');
    // SALT_KEY nachtraeglich mit einem strukturell unmoeglichen Wert
    // ueberschreiben - modelliert Disk-/Speicherkorruption, kein Angriff auf
    // den PIN selbst.
    localStorageBackingStore.set('malachi___pin_salt', 'DAS-IST-KEIN-BASE64-!!!###');
    Storage.lock();

    let thrown = null;
    let result;
    try {
      result = await Storage.unlockEncryption('1234');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull(); // FIX: keine ungefangene Exception mehr
    expect(result).toEqual({ ok: false, reason: 'corrupted' });
    expect(RelayClient.pepperRequest).not.toHaveBeenCalled(); // FIX: kein Token, kein verbrauchter Versuch
  });

  test('korrupter MARKER_KEY, strukturell unmoeglich (kein gueltiges Base64 / zu kurz fuer IV+Tag): ebenfalls {ok:false, reason:"corrupted"} VOR jedem pepperRequest()', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-initial' });
    await Storage.setupEncryption('1234');
    localStorageBackingStore.set('malachi___pin_marker', 'zu-kurz');
    Storage.lock();

    const result = await Storage.unlockEncryption('1234');
    expect(result).toEqual({ ok: false, reason: 'corrupted' });
    expect(RelayClient.pepperRequest).not.toHaveBeenCalled();
  });

  test('MARKER_KEY strukturell PLAUSIBEL (gueltiges Base64, plausible AES-GCM-Laenge) aber inhaltlich falsch: verhaelt sich WEITERHIN wie vor Fix 3 - echter pepperRequest()/pepperFail()-Roundtrip, reason "wrong_pin", ein Versuch wird verbraucht. Das ist ABSICHTLICH so: an dieser Stelle ist "korrupt" kryptografisch nicht mehr von "falscher PIN" unterscheidbar, sobald ein echter Entschluesselungsversuch gelaufen ist, und darf es auch nicht sein (sonst liesse sich per Antwortunterschied auf den lokalen Speicherzustand schliessen)', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-initial' });
    await Storage.setupEncryption('1234');
    // Gueltiges Base64, plausible Laenge (IV 12 + Tag 16 + etwas Ciphertext),
    // aber garantiert nicht die echte Verschluesselung des Markers.
    const crypto = require('crypto');
    localStorageBackingStore.set('malachi___pin_marker', Buffer.from(crypto.randomBytes(40)).toString('base64'));
    Storage.lock();

    RelayClient.pepperRequest.mockResolvedValue({ ok: true, pepper: 'pepper-initial', attemptToken: 'tok-marker-wrong' });
    RelayClient.pepperFail.mockResolvedValue({ wiped: false, lockedUntil: null });

    const result = await Storage.unlockEncryption('1234');
    expect(result).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(RelayClient.pepperRequest).toHaveBeenCalled();
    expect(RelayClient.pepperFail).toHaveBeenCalledTimes(1); // wie vor Fix 3 - ein echter Versuch wird verbraucht
  });
});

// API-Vertrags-/Fehlerbehandlungs-Review (dieser Durchgang): setupEncryption()
// klassifizierte einen 409 "bereits registriert" von /pepper/register bisher
// identisch zu einem echten Netzwerkfehler ("Relay nicht erreichbar") - eine
// irrefuehrende Fehlermeldung fuer einen konkret erreichbaren Fall (die erste
// Registrierung war serverseitig bereits erfolgreich, nur ihre Antwort ging
// verloren; ein erneuter Versuch mit demselben, bereits lokal persistierten
// deviceId trifft dann auf den 409). pepperRegister() liefert jetzt ein
// diskriminiertes Ergebnis (gleiches Muster wie PepperRequestResult), diese
// Tests belegen, dass setupEncryption() die beiden Faelle nun tatsaechlich
// unterscheidet statt sie auf dieselbe Fehlermeldung abzubilden.
describe('web/src/lib/Storage.ts - setupEncryption() Fehlerklassifizierung (pepperRegister conflict vs. network)', () => {
  let Storage;
  let RelayClient;

  beforeEach(() => {
    jest.resetModules();
    localStorageBackingStore.clear();
    RelayClient = require('../../web/src/lib/RelayClient');
    Storage = require('../../web/src/lib/Storage.ts');
  });

  test('409 (conflict) von /pepper/register wirft eine eigene, unterscheidbare Fehlermeldung statt "Relay nicht erreichbar"', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: false, reason: 'conflict' });
    await expect(Storage.setupEncryption('1234')).rejects.toThrow(/bereits einen Pepper/);
    // Muss sich klar von der Netzwerkfehler-Meldung unterscheiden, sonst ist
    // die Unterscheidung fuer den Aufrufer wertlos.
    await expect(Storage.setupEncryption('1234')).rejects.not.toThrow(/nicht erreichbar/);
  });

  test('echter Netzwerkfehler von /pepper/register wirft weiterhin die bestehende "Relay nicht erreichbar"-Meldung (unveraendertes Verhalten)', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: false, reason: 'network' });
    await expect(Storage.setupEncryption('1234')).rejects.toThrow(/nicht erreichbar/);
  });

  test('Erfolgsfall bleibt unveraendert: setupEncryption() schliesst normal ab und dek ist danach nutzbar', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-xyz' });
    await expect(Storage.setupEncryption('1234')).resolves.toBeUndefined();
    await expect(Storage.setItem('k', 'v')).resolves.toBeUndefined();
  });
});
