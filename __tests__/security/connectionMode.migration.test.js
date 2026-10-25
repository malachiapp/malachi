// STUN-Ausstieg: Umstellung der gespeicherten Stufe (ConnectionMode.js,
// STUN_AUSSTIEG_PLAN.md E3/E4).
//   - Gespeichertes '1' ("Schnell (mit STUN)") gilt sofort als "Direkt, wenn
//     moeglich" ('2'), wird einmal umgeschrieben (Ruecklese-Pruefung) und
//     loest genau einmal einen Hinweis aus.
//   - Bisherige Nutzer ohne gespeicherte Stufe (bis 1.1.0 = Stufe 1) bekommen
//     den Hinweis ebenfalls einmal - es wird dafuer nichts umgeschrieben.
//   - '2' und '3' bleiben unveraendert, ohne Hinweis; '3' bleibt auch ohne
//     Lizenz aktiv.
//   - Neu eingerichtete Apps bekommen keinen Hinweis.
//   - Ein Speicherfehler beim Umstellen lockert nie den Schutz und verliert
//     nichts; ein gleichzeitig gewaehltes "nur Tor" wird nie ueberschrieben.
const fs = require('fs');
const path = require('path');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const CM = require('../../ConnectionMode');

const KEY = CM.CONNECTION_MODE_STORAGE_KEY;
const NOTICE = CM.CONNECTION_MODE_NOTICE_KEY;
const restart = () => CM._resetConnectionModeForTests();

beforeEach(async () => {
  jest.restoreAllMocks();
  await EncryptedStorage.clear();
  restart();
});

test('Stufe 1 -> "Direkt, wenn moeglich": sofort wirksam, einmal umgeschrieben, Hinweis genau einmal', async () => {
  await EncryptedStorage.setItem(KEY, '1');
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(CM.getConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await EncryptedStorage.getItem(KEY)).toBe('2');
  expect(await EncryptedStorage.getItem(NOTICE)).toBe('pending');

  // Hinweis kommt nach dem Entsperren - einmal.
  expect(await CM.shouldShowStunRemovalNotice()).toBe(true);
  await CM.markStunRemovalNoticeShown();
  expect(await EncryptedStorage.getItem(NOTICE)).toBe('shown');
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);

  // Neustart: bleibt '2', kein zweiter Hinweis, nichts wird erneut geschrieben.
  restart();
  const spy = jest.spyOn(EncryptedStorage, 'setItem');
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});

test('auch der Hinweis-Aufruf allein (ohne vorheriges Laden) stellt um und meldet den Hinweis', async () => {
  await EncryptedStorage.setItem(KEY, '1');
  expect(await CM.shouldShowStunRemovalNotice()).toBe(true);
  expect(await EncryptedStorage.getItem(KEY)).toBe('2');
});

test('ohne gespeicherte Stufe (bisheriger Standard = Stufe 1): Hinweis einmal, Stufe bleibt ungespeichert', async () => {
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await CM.shouldShowStunRemovalNotice()).toBe(true);
  expect(await EncryptedStorage.getItem(KEY)).toBeNull();
  await CM.markStunRemovalNoticeShown();
  restart();
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);
  expect(await EncryptedStorage.getItem(KEY)).toBeNull();
});

test('neu eingerichtete App: kein Hinweis (SetupScreen vermerkt "none")', async () => {
  await CM.markStunRemovalNoticeShown({ fresh: true });
  expect(await EncryptedStorage.getItem(NOTICE)).toBe('none');
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const setup = app.slice(app.indexOf('function SetupScreen('), app.indexOf('function SetupScreen(') + 1200);
  expect(setup).toMatch(/await AsyncStorage\.setItem\('setup_done', 'true'\);\s*\/\/[^\n]*\n[^\n]*\n\s*await markStunRemovalNoticeShown\(\{ fresh: true \}\);/);
});

test('Stufe 2 bleibt ohne Hinweis; Stufe 3 bleibt erhalten - auch ohne Lizenz, ohne Hinweis', async () => {
  await EncryptedStorage.setItem(KEY, '2');
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);
  expect(await EncryptedStorage.getItem(NOTICE)).toBeNull();

  await EncryptedStorage.clear();
  restart();
  await EncryptedStorage.setItem(KEY, '3');
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_TOR_ONLY);
  expect(CM.isTorOnlyMode()).toBe(true);
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);
  expect(await EncryptedStorage.getItem(KEY)).toBe('3');
  expect(await EncryptedStorage.getItem(NOTICE)).toBeNull();
  // Bestaetigen ohne Lizenz: bleibt aktiv.
  expect(await CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: false })).toEqual({ ok: true, mode: CM.MODE_TOR_ONLY });
});

test('Speicherfehler beim Umschreiben: gilt trotzdem als "Direkt, wenn moeglich", nichts geht verloren, naechster Start versucht es erneut', async () => {
  await EncryptedStorage.setItem(KEY, '1');
  const orig = EncryptedStorage.setItem.bind(EncryptedStorage);
  const spy = jest.spyOn(EncryptedStorage, 'setItem').mockImplementation(async (k, v) => {
    if (k === KEY) throw new Error('Speicher voll');
    return orig(k, v);
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await EncryptedStorage.getItem(KEY)).toBe('1');            // alter Wert unangetastet
  expect(await EncryptedStorage.getItem(NOTICE)).toBe('pending');    // Hinweis trotzdem vorgemerkt
  expect(warn).toHaveBeenCalled();
  // Entscheidungen nutzen die neue Stufe - nie STUN, nie lockerer als vorher.
  expect(await CM.connectionModeForDecision()).toBe(CM.MODE_DIRECT);
  spy.mockRestore();
  restart();
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await EncryptedStorage.getItem(KEY)).toBe('2');
});

test('Ruecklese-Pruefung: steht nach dem Schreiben nicht "2" im Speicher, wird gewarnt und beim naechsten Start wiederholt', async () => {
  await EncryptedStorage.setItem(KEY, '1');
  const spy = jest.spyOn(EncryptedStorage, 'setItem').mockImplementation(async () => {});   // "schreibt" nichts
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(warn.mock.calls.some((c) => /nicht bestaetigt/.test(String(c[0])))).toBe(true);
  spy.mockRestore();
  restart();
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_DIRECT);
  expect(await EncryptedStorage.getItem(KEY)).toBe('2');
});

test('ein waehrend der Umstellung gewaehltes "nur Tor" wird nie ueberschrieben', async () => {
  await EncryptedStorage.setItem(KEY, '1');
  const origGet = EncryptedStorage.getItem.bind(EncryptedStorage);
  let slow = true;
  jest.spyOn(EncryptedStorage, 'getItem').mockImplementation(async (k) => {
    if (k === KEY && slow) { slow = false; await new Promise((r) => setTimeout(r, 20)); }
    return origGet(k);
  });
  const loading = CM.loadConnectionMode();
  const choosing = CM.setConnectionMode(CM.MODE_TOR_ONLY, { pro: true });
  await Promise.all([loading, choosing]);
  expect(CM.getConnectionMode()).toBe(CM.MODE_TOR_ONLY);
  expect(await origGet(KEY)).toBe('3');
  restart();
  expect(await CM.loadConnectionMode()).toBe(CM.MODE_TOR_ONLY);
});

test('Lesefehler: weiterhin ausfallsicher wie Stufe 3, kein Hinweis, nichts geschrieben', async () => {
  const spyGet = jest.spyOn(EncryptedStorage, 'getItem').mockImplementation(async () => { throw new Error('gesperrt'); });
  const spySet = jest.spyOn(EncryptedStorage, 'setItem');
  expect(await CM.connectionModeForDecision()).toBe(CM.MODE_TOR_ONLY);
  expect(await CM.shouldShowStunRemovalNotice()).toBe(false);
  expect(spySet).not.toHaveBeenCalled();
  spyGet.mockRestore();
});

test('App: Hinweis erst nach dem Entsperren (Startbildschirm), einmal je Sitzung, sofort als gezeigt vermerkt', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const i = app.indexOf('const stunNoticeCheckedRef = useRef(false);');
  expect(i).toBeGreaterThan(0);
  const block = app.slice(i, i + 600);
  expect(block).toMatch(/if \(screen !== 'home' \|\| stunNoticeCheckedRef\.current\) return;/);
  expect(block).toMatch(/shouldShowStunRemovalNotice\(\)\.then\(\(show\) => \{\s*if \(!show\) return;\s*markStunRemovalNoticeShown\(\);\s*Alert\.alert\(t\('connMode\.migrated\.title'\), t\('connMode\.migrated\.body'\)\);/);
});
