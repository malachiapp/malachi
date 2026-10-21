// SECURITY_CHAOS_TESTING.md §3/§8, Fix 4: checkOutgoing/checkIncoming (nativ,
// App.tsx) und checkOfflinePackets (web, web/src/App.tsx) feuerten bisher
// unbedingt auf jedem Interval-Tick, egal ob der vorherige Zyklus (dessen
// fetch()-Aufrufe an den Relay) noch lief - nur der einzelne WebRTC-
// Verbindungsversuch PRO KONTAKT war ueber initiatorAttempting/
// responderConnecting abgesichert, nicht der aeussere Poll-Zyklus selbst.
// Gegen einen Relay, der eine Verbindung annimmt aber nie antwortet, haetten
// sich so pro Tick weitere haengende Requests aufsummieren koennen.
//
// Dieser Fund ist per SECURITY_CHAOS_TESTING.md's eigener "Not testable
// under Jest"-Einordnung nicht ueber eine echte <App/>-Rendering-Sitzung
// pruefbar (screen==='home' liegt hinter dem vollen PIN-Entsperr-Flow, ein
// voller Render wurde dort explizit als unverhaeltnismaessig fuer einen
// einzelnen Fund bewertet - siehe Bericht). Der Fix selbst wurde direkt am
// Code vorgenommen (Ref-basierte Zyklus-Sperre, im finally zurueckgesetzt,
// damit ein einzelner Fehler die Sperre nicht dauerhaft haengen laesst) und
// wird hier - als Ersatz fuer einen unverhaeltnismaessig teuren Full-Render-
// Test - ueber eine Quelltext-Struktur-Pruefung verifiziert: existiert die
// Sperr-Ref, wird sie VOR dem eigentlichen Poll-Rumpf geprueft/gesetzt, und
// wird sie in einem finally (nicht nur im Erfolgsfall) wieder zurueckgesetzt?
const fs = require('fs');
const path = require('path');

// Zeilenenden vereinheitlichen: unter Windows (core.autocrlf) liegen die
// Quellen mit CRLF im Arbeitsverzeichnis, die Muster unten erwarten '\n'.
function readSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8').replace(/\r\n/g, '\n');
}

describe('Fix 4: Poll-Zyklus-Sperre fuer checkOutgoing/checkIncoming (nativ) und checkOfflinePackets (web)', () => {
  // Seit Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3a) steht der Zyklus-Rumpf von
  // checkOutgoing/checkIncoming unveraendert in BackgroundSync.js
  // (runOutgoingCycle/runIncomingCycle), damit ihn auch der Headless-Task
  // nutzen kann; die Sperren sind dort modulweite Variablen statt useRef().
  // Dieselben Invarianten wie vorher, nur in der neuen Datei geprueft.
  test('BackgroundSync.js (nativ): runOutgoingCycle (ex checkOutgoing) hat eine Zyklus-Sperre, geprueft/gesetzt vor dem eigentlichen Poll-Rumpf, und im finally zurueckgesetzt', () => {
    const src = readSrc('BackgroundSync.js');
    expect(src).toMatch(/let outgoingCycleRunning = false;/);
    // App.tsx ruft weiterhin genau diesen Zyklus auf.
    expect(readSrc('App.tsx')).toMatch(/const checkOutgoing = \(\) => \{\s*runOutgoingCycle\(/);

    const fnStart = src.indexOf('export function runOutgoingCycle(options = {}) {');
    expect(fnStart).toBeGreaterThan(-1);
    // Bis zur naechsten exportierten Funktion - schliesst die Funktions-
    // definition sauber ab, ohne auf exaktes Klammer-Balancing angewiesen zu sein.
    const fnEnd = src.indexOf('export async function runIncomingCycle', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnSrc = src.slice(fnStart, fnEnd);

    // Guard-Check + Set MUSS vor dem ersten echten Poll-Schritt
    // (AsyncStorage.getItem) stehen, sonst schuetzt er nichts.
    const guardCheckIdx = fnSrc.indexOf('if (outgoingCycleRunning) return Promise.resolve();');
    const guardSetIdx = fnSrc.indexOf('outgoingCycleRunning = true;');
    const pollStartIdx = fnSrc.indexOf("AsyncStorage.getItem('contacts')");
    expect(guardCheckIdx).toBeGreaterThan(-1);
    expect(guardSetIdx).toBeGreaterThan(guardCheckIdx);
    expect(pollStartIdx).toBeGreaterThan(guardSetIdx);

    // Zuruecksetzen MUSS in einem .finally() passieren (nicht nur am Ende des
    // Erfolgspfads) - sonst haengt die Sperre nach dem ersten Fehler fuer
    // immer.
    const finallyIdx = fnSrc.indexOf('.finally(() => {');
    expect(finallyIdx).toBeGreaterThan(pollStartIdx);
    const resetInFinally = fnSrc.slice(finallyIdx).indexOf('outgoingCycleRunning = false;');
    expect(resetInFinally).toBeGreaterThan(-1);
  });

  test('BackgroundSync.js (nativ): runIncomingCycle (ex checkIncoming) hat dieselbe Zyklus-Sperre, geprueft/gesetzt vor dem Poll-Rumpf, im finally zurueckgesetzt', () => {
    const src = readSrc('BackgroundSync.js');
    expect(src).toMatch(/let incomingCycleRunning = false;/);
    expect(readSrc('App.tsx')).toMatch(/const checkIncoming = \(\) => runIncomingCycle\(/);

    const fnStart = src.indexOf('export async function runIncomingCycle(options = {}) {');
    expect(fnStart).toBeGreaterThan(-1);
    // runIncomingCycle ist die letzte Funktion der Datei.
    const fnSrc = src.slice(fnStart);

    const guardCheckIdx = fnSrc.indexOf('if (incomingCycleRunning) return;');
    const guardSetIdx = fnSrc.indexOf('incomingCycleRunning = true;');
    const pollStartIdx = fnSrc.indexOf("AsyncStorage.getItem('contacts')");
    expect(guardCheckIdx).toBeGreaterThan(-1);
    expect(guardSetIdx).toBeGreaterThan(guardCheckIdx);
    expect(pollStartIdx).toBeGreaterThan(guardSetIdx);

    // Reset muss in einem finally-Block liegen (try { ... } catch(e) {}
    // finally { ... }), nicht nur am Ende des try-Blocks - sonst uebersteht
    // ein geworfener Fehler die Sperre nicht.
    const finallyIdx = fnSrc.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(pollStartIdx);
    const resetInFinally = fnSrc.slice(finallyIdx).indexOf('incomingCycleRunning = false;');
    expect(resetInFinally).toBeGreaterThan(-1);
    expect(resetInFinally).toBeLessThan(500); // liegt im finally-Block selbst, nicht irgendwo weit dahinter
  });

  test('web/src/App.tsx: checkOfflinePackets hat dieselbe Ref-Sperre, geprueft/gesetzt vor dem Poll-Rumpf, im finally zurueckgesetzt', () => {
    const src = readSrc('web/src/App.tsx');
    expect(src).toMatch(/const offlinePacketsCycleRunning = useRef\(false\)/);

    const fnStart = src.indexOf('const checkOfflinePackets = async () => {');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('checkOfflinePackets();\n    const interval = setInterval(checkOfflinePackets, 8000);', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnSrc = src.slice(fnStart, fnEnd);

    const guardCheckIdx = fnSrc.indexOf('if (offlinePacketsCycleRunning.current) return;');
    const guardSetIdx = fnSrc.indexOf('offlinePacketsCycleRunning.current = true;');
    const pollStartIdx = fnSrc.indexOf("await import('./lib/RelayClient')");
    expect(guardCheckIdx).toBeGreaterThan(-1);
    expect(guardSetIdx).toBeGreaterThan(guardCheckIdx);
    expect(pollStartIdx).toBeGreaterThan(guardSetIdx);

    const finallyIdx = fnSrc.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(pollStartIdx);
    const resetInFinally = fnSrc.slice(finallyIdx).indexOf('offlinePacketsCycleRunning.current = false;');
    expect(resetInFinally).toBeGreaterThan(-1);
    expect(resetInFinally).toBeLessThan(500);
  });

  // Ergaenzend: reine Verhaltens-Pruefung der Sperr-LOGIK selbst, isoliert
  // von React/App.tsx (kein Full-Render noetig) - beweist, dass das Muster
  // "Guard pruefen -> setzen -> Arbeit -> im finally zuruecksetzen, auch bei
  // einem Fehler" tatsaechlich verhindert, dass zwei "Zyklen" gleichzeitig
  // laufen, und sich nach einem Fehler wieder selbst entsperrt. Testet exakt
  // dasselbe Muster, das oben als im Quelltext vorhanden nachgewiesen wurde.
  test('Verhaltens-Nachweis des Sperr-Musters: ueberlappender zweiter Aufruf wird uebersprungen, ein Fehler haengt die Sperre nicht dauerhaft', async () => {
    const cycleRunning = { current: false };
    let started = 0;
    let skipped = 0;

    async function poll(shouldThrow, gate) {
      if (cycleRunning.current) { skipped++; return; }
      cycleRunning.current = true;
      started++;
      try {
        if (gate) await gate;
        if (shouldThrow) throw new Error('simulierter Fehler mitten im Zyklus');
      } catch (e) {
        // wie im echten Code (catch(e) {}): Fehler werden geschluckt - relevant
        // fuer DIESEN Test ist nur, ob die Sperre danach zuverlaessig wieder
        // frei ist, nicht die Fehlerbehandlung selbst.
      } finally {
        cycleRunning.current = false;
      }
    }

    // Zwei "Ticks" waehrend der erste Zyklus noch haengt (Gate offen) - der
    // zweite muss uebersprungen werden, nicht zusaetzlich draufsatteln.
    let release;
    const gate = new Promise((r) => { release = r; });
    const firstCall = poll(false, gate);
    await poll(false, null); // "naechster Tick" waehrend der erste noch laeuft
    expect(started).toBe(1);
    expect(skipped).toBe(1);
    release();
    await firstCall;
    expect(cycleRunning.current).toBe(false); // Sperre nach Abschluss wieder frei

    // Ein Zyklus, der wirft, darf die Sperre nicht dauerhaft haengen lassen -
    // der naechste Tick danach muss wieder normal laufen.
    await expect(poll(true, null)).resolves.toBeUndefined();
    expect(cycleRunning.current).toBe(false);
    await poll(false, null);
    expect(started).toBe(3);
  });
});
