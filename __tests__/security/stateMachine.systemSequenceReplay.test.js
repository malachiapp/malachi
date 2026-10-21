// State-Machine-Sicherheitsreview, Fund 4 - Fix: isFreshTimestamp() allein
// (Sicherheitsreview 4) prueft nur das ALTER eines Zeitstempels, nicht die
// REIHENFOLGE. Ein innerhalb des 15-Minuten-Frische-Fensters aufgezeichnetes
// und danach erneut eingespieltes secret_start koennte einen bereits per
// secret_end beendeten Secret Chat unbemerkt reaktivieren, ohne dass
// isFreshTimestamp das je bemerkt (das replayed Paket ist ja tatsaechlich
// noch "frisch" im Sinne des Alters-Fensters).
//
// isNewerThanLastAcceptedSystemTs() (App.tsx, direkt nach isFreshTimestamp
// definiert; identische Kopie in WebRTCManager.js fuer den Live-Pfad) merkt
// pro Kontakt den Zeitstempel des zuletzt akzeptierten System-Kontrollpakets
// und verwirft alles mit gleichem oder aelterem ts - unabhaengig von dessen
// Alter. Lebt in App.tsx als modul-interne (nicht exportierte) Funktion, wie
// isFreshTimestamp auch - hier woertlich gespiegelt (siehe replayWindow.test.js
// fuer dasselbe Vorgehen und dieselbe Begruendung: App.tsx laesst sich wegen
// RN-Native-Importen nicht direkt unter Jest laden), mit einer echten
// Map als Ersatz fuer AsyncStorage (funktional identisch fuer diese reine
// Zustandslogik).
function makeIsNewerThanLastAcceptedSystemTs() {
  const store = new Map(); // simuliert AsyncStorage synchron+in-memory
  return async function isNewerThanLastAcceptedSystemTs(contactId, ts) {
    const key = 'system_ts_hwm_' + contactId;
    const lastTs = store.has(key) ? parseInt(store.get(key), 10) : 0;
    if (!Number.isFinite(ts) || ts <= lastTs) return false;
    store.set(key, String(ts));
    return true;
  };
}

describe('Sequenz-bewusster Replay-Schutz fuer System-Kontrollpakete', () => {
  test('erstes Paket fuer einen Kontakt wird akzeptiert', async () => {
    const check = makeIsNewerThanLastAcceptedSystemTs();
    expect(await check('contact_A', 1000)).toBe(true);
  });

  test('ein zweites Paket mit spaeterem ts wird akzeptiert (normaler Ablauf: secret_start dann secret_end)', async () => {
    const check = makeIsNewerThanLastAcceptedSystemTs();
    expect(await check('contact_A', 1000)).toBe(true); // secret_start
    expect(await check('contact_A', 2000)).toBe(true); // secret_end, spaeter
  });

  test('Kernfall: ein aufgezeichnetes secret_start mit AELTEREM ts als das bereits verarbeitete secret_end wird verworfen, selbst wenn isFreshTimestamp es noch als "frisch" durchlassen wuerde', async () => {
    const check = makeIsNewerThanLastAcceptedSystemTs();
    const secretStartTs = Date.now() - 5000;   // secret_start vor 5s
    const secretEndTs   = Date.now() - 1000;   // secret_end vor 1s (spaeter, legitim verarbeitet)
    expect(await check('contact_A', secretStartTs)).toBe(true);
    expect(await check('contact_A', secretEndTs)).toBe(true);

    // Angreifer spielt das urspruengliche (immer noch < 15 Min alte, also
    // fuer isFreshTimestamp weiterhin "frisch") secret_start erneut ein -
    // MUSS trotzdem verworfen werden, weil sein ts <= dem zuletzt
    // akzeptierten (secretEndTs) ist.
    expect(await check('contact_A', secretStartTs)).toBe(false);
  });

  test('ein exakt gleicher Zeitstempel (Wiederholung derselben Nachricht) wird verworfen', async () => {
    const check = makeIsNewerThanLastAcceptedSystemTs();
    const ts = Date.now();
    expect(await check('contact_A', ts)).toBe(true);
    expect(await check('contact_A', ts)).toBe(false); // exaktes Duplikat
  });

  test('verschiedene Kontakte haben unabhaengige Hochwasserstaende', async () => {
    const check = makeIsNewerThanLastAcceptedSystemTs();
    expect(await check('contact_A', 5000)).toBe(true);
    // contact_B ist komplett unbeeinflusst vom Stand fuer contact_A
    expect(await check('contact_B', 1000)).toBe(true);
    expect(await check('contact_B', 999)).toBe(false);
  });

  test('ungueltiger Zeitstempel (NaN/Infinity) wird immer verworfen', async () => {
    const check = makeIsNewerThanLastAcceptedSystemTs();
    expect(await check('contact_A', NaN)).toBe(false);
    expect(await check('contact_A', Infinity)).toBe(false);
  });
});
