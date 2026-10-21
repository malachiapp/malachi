// Audit 2026-10-19 (T5): Einstiegsknoten (Wachen) nur selten neu waehlen -
// nie automatisch in "Maximal anonym", sonst hoechstens alle 30 Tage und erst
// nach wiederholten Warnungen.
const { NativeModules } = require('react-native');

function laden({ warnungen, modus, letzterReset = 0 }) {
  NativeModules.MalachiTor = {
    addListener() {}, removeListeners() {},
    resetGuards: jest.fn(async () => true),
    health: jest.fn(async () => ({ guardWarnings: warnungen })),
  };
  let T, CM, ES;
  jest.isolateModules(() => {
    ES = require('react-native-encrypted-storage').default;
    CM = require('../../ConnectionMode');
    T = require('../../TorTransport');
  });
  return { T, CM, ES, setup: async () => {
    await ES.clear();
    if (letzterReset) await ES.setItem('tor_guard_reset_at', String(letzterReset));
    await ES.setItem('connection_mode', String(modus));
    CM._resetConnectionModeForTests?.();
  } };
}

async function entscheidung(opts) {
  const { T, setup } = laden(opts);
  await setup();
  T._setTorStateForTests?.({ status: 'ON' });
  return T._shouldResetGuardsForTests();
}

test('eine einzelne Warnung reicht nicht mehr', async () => {
  expect(await entscheidung({ warnungen: 1, modus: 1 })).toBe(false);
});
test('"Maximal anonym": nie automatisch', async () => {
  expect(await entscheidung({ warnungen: 50, modus: 3 })).toBe(false);
});
test('sonst hoechstens alle 30 Tage', async () => {
  expect(await entscheidung({ warnungen: 5, modus: 1, letzterReset: Date.now() - 2 * 24 * 3600 * 1000 })).toBe(false);
  expect(await entscheidung({ warnungen: 5, modus: 1, letzterReset: Date.now() - 31 * 24 * 3600 * 1000 })).toBe(true);
});
