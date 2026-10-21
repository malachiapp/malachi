// Produktionsreife-Review ("100.000 Nutzer, EIN relay.js-Prozess, RAM-only
// pepperStore" - siehe PRODUCTION_READINESS_GATE.md): relay.js haelt
// pepperStore ausschliesslich im RAM (Kopfkommentar "Nur RAM, kein Disk").
// Jeder Neustart des Relay-Prozesses (Deploy/Crash/OOM - bei einem einzigen
// zentralen, im Client fest verdrahteten RELAY_URL trifft das ALLE
// Web-Client-Nutzer gleichzeitig, die zu diesem Zeitpunkt einen PIN
// eingerichtet haben) loescht dabei ALLE registrierten Pepper. Der naechste
// pepperRequest() fuer ein zuvor gueltiges deviceId liefert dann vom Server
// exakt dieselbe Antwort ('unknown'/404) wie fuer ein deviceId, das nie
// existiert hat - Storage.ts konnte das bisher nicht von einem ECHTEN
// 5-Fehlversuche-Wipe unterscheiden und meldete beides identisch als
// reason:'wiped', was web/src/App.tsx als "Zu viele Fehlversuche" anzeigte -
// obwohl der Nutzer nicht einen einzigen falschen PIN eingegeben hat und kein
// einziger Versuch gegen irgendeinen Zaehler gewertet wurde.
//
// Fix: ein eigener UnlockResult-Grund 'lost_state' fuer genau diesen Fall
// (Storage.ts, _unlockEncryptionInner). Dieser Test belegt:
//  1. Die Unterscheidung existiert tatsaechlich (nicht 'wiped').
//  2. Kein einziger Fehlversuch wird dabei verbraucht (pepperFail() wird gar
//     nicht erst aufgerufen - es gab ja nie ein gueltiges attemptToken).
//  3. localStorage wird trotzdem geleert (die alten Daten sind ohnehin fuer
//     immer unentschluesselbar, ohne das haenge der Nutzer sonst fuer immer
//     im Lock-Screen fest, siehe web/src/App.tsx setHasExistingPin(false)).
//
// Gleicher localStorage-Proxy-Shim wie stateMachine.storageUnlockRace.test.js
// (Node-testEnvironment bringt kein echtes localStorage/btoa/atob mit).
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

describe('web/src/lib/Storage.ts - Relay-Neustart waehrend eine PIN-Sitzung besteht (pepperStore verloren)', () => {
  let Storage;
  let RelayClient;

  beforeEach(() => {
    jest.resetModules();
    localStorageBackingStore.clear();
    RelayClient = require('../../web/src/lib/RelayClient');
    Storage = require('../../web/src/lib/Storage.ts');
  });

  test("relay.js kennt das deviceId nach einem Neustart nicht mehr ('unknown') -> reason:'lost_state', NICHT 'wiped'", async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-vor-dem-neustart' });
    await Storage.setupEncryption('1234');
    await Storage.setItem('chatverlauf', 'geheime-nachrichten');
    Storage.lock();

    // Simuliert relay.js nach einem Neustart: pepperStore ist leer, das
    // deviceId ist dem (neuen) Prozess unbekannt - relay.js liefert dafuer
    // 404, RelayClient.ts bildet das auf reason:'unknown' ab (siehe dort,
    // Zeile ~246).
    RelayClient.pepperRequest.mockResolvedValue({ ok: false, reason: 'unknown' });

    const result = await Storage.unlockEncryption('1234'); // korrekter PIN!
    expect(result).toEqual({ ok: false, reason: 'lost_state' });

    // Kein Fehlversuch wurde verbraucht - es gab nie ein attemptToken, gegen
    // das ein Fehlversuch haette gezaehlt werden koennen.
    expect(RelayClient.pepperFail).not.toHaveBeenCalled();
    expect(RelayClient.pepperSuccess).not.toHaveBeenCalled();
  });

  test("nach 'lost_state' ist hasPinSetup() false - der Nutzer haengt nicht fuer immer im Lock-Screen fest, sondern kann den PIN neu einrichten", async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'pepper-vor-dem-neustart' });
    await Storage.setupEncryption('1234');
    Storage.lock();

    expect(Storage.hasPinSetup()).toBe(true);

    RelayClient.pepperRequest.mockResolvedValue({ ok: false, reason: 'unknown' });
    const result = await Storage.unlockEncryption('1234');
    expect(result).toEqual({ ok: false, reason: 'lost_state' });

    // localStorage wurde geleert (wie beim echten Wipe-Pfad) - SALT_KEY ist
    // weg, hasPinSetup() faellt korrekt auf false zurueck. Ohne diesen Fix
    // bliebe SALT_KEY erhalten, hasPinSetup() bliebe true, und jeder weitere
    // Entsperrversuch liefe unveraendert wieder in genau dasselbe
    // 'lost_state'-Ergebnis - eine endlose Sackgasse ohne Weg zurueck zu
    // einer neuen Einrichtung.
    expect(Storage.hasPinSetup()).toBe(false);
  });

  test('Kontrolle: ein ECHTER 5-Fehlversuche-Wipe (Server meldet explizit wiped:true auf einen falschen PIN) liefert weiterhin reason:"wiped", nicht "lost_state"', async () => {
    RelayClient.pepperRegister.mockResolvedValue({ ok: true, pepper: 'p' });
    await Storage.setupEncryption('1234');
    Storage.lock();

    RelayClient.pepperRequest.mockResolvedValue({ ok: true, pepper: 'p', attemptToken: 'tok' });
    RelayClient.pepperFail.mockResolvedValue({ wiped: true });

    const result = await Storage.unlockEncryption('FALSCHER_PIN');
    expect(result).toEqual({ ok: false, reason: 'wiped' });
    expect(RelayClient.pepperFail).toHaveBeenCalledTimes(1);
  });
});
