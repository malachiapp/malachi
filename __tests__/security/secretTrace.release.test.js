// Audit 2026-10-19 (P5): Die Schluessel-Diagnose (SecretTrace) darf im
// Release-Build nichts protokollieren - sonst landen Kontakt-ID-Praefixe und
// eine Spur des Wipes (Aufrufstelle) in logcat.
afterEach(() => { global.__DEV__ = true; jest.restoreAllMocks(); });

test('Release (__DEV__ = false): Map und Speicher bleiben unveraendert, keine Ausgabe', () => {
  global.__DEV__ = false;
  jest.isolateModules(() => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { traceSecretMap, traceSecretStorage } = require('../../SecretTrace');
    const ES = require('react-native-encrypted-storage').default;
    const vorher = ES.removeItem;
    const m = new Map([['c_kontakt_1234567890', 'x']]);
    const deleteVorher = m.delete;
    expect(traceSecretMap(m, 'test')).toBe(m);
    expect(m.delete).toBe(deleteVorher);
    traceSecretStorage();
    expect(ES.removeItem).toBe(vorher);
    m.delete('c_kontakt_1234567890');
    expect(warn).not.toHaveBeenCalled();
  });
});

test('Entwicklung (__DEV__ = true): Diagnose aktiv', () => {
  global.__DEV__ = true;
  jest.isolateModules(() => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { traceSecretMap } = require('../../SecretTrace');
    const m = traceSecretMap(new Map([['c_x', 'y']]), 'test');
    m.delete('c_x');
    expect(warn).toHaveBeenCalled();
  });
});
