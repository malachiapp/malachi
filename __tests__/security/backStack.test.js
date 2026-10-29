// Hardware-Zurueck-Taste (BackStack.js, Nutzerwunsch 29.10.2026: "manchmal
// kann man nicht mit der Zurueck-Taste zurueck"):
//  1. zuletzt Geoeffnetes zuerst (Auswahl, Suche, Aufnahme, Ansicht in der Ansicht)
//  2. Dialoge mit "Abbrechen" lassen sich per Zurueck schliessen - Wirkung wie der Knopf
//  3. jedes Modal setzt onRequestClose (sonst schluckt es die Taste stumm)
const fs = require('fs');
const path = require('path');
const React = require('react');
const renderer = require('react-test-renderer');
const BS = require('../../BackStack');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

beforeEach(() => BS._resetBackStackForTests());

describe('Reihenfolge', () => {
  test('neuester Handler zuerst; false reicht weiter; leer -> false', () => {
    const calls = [];
    const offA = BS.pushBack(() => { calls.push('A'); });
    const offB = BS.pushBack(() => { calls.push('B'); return false; });
    expect(BS.handleBack()).toBe(true);
    expect(calls).toEqual(['B', 'A']);
    offA(); offB();
    expect(BS.handleBack()).toBe(false);
  });

  test('Abmelden entfernt genau diesen Eintrag', () => {
    const calls = [];
    const offA = BS.pushBack(() => calls.push('A'));
    BS.pushBack(() => calls.push('B'));
    offA();
    BS.handleBack();
    expect(calls).toEqual(['B']);
  });

  test('useBackHandler: nur solange aktiv, immer der aktuelle Handler', async () => {
    const seen = [];
    function Probe({ on, label }) { BS.useBackHandler(on, () => seen.push(label)); return null; }
    let tree;
    await renderer.act(async () => { tree = renderer.create(React.createElement(Probe, { on: false, label: 'x' })); });
    expect(BS.handleBack()).toBe(false);
    await renderer.act(async () => { tree.update(React.createElement(Probe, { on: true, label: 'eins' })); });
    await renderer.act(async () => { tree.update(React.createElement(Probe, { on: true, label: 'zwei' })); });
    expect(BS.handleBack()).toBe(true);
    expect(seen).toEqual(['zwei']);
    await renderer.act(async () => { tree.unmount(); });
    expect(BS.handleBack()).toBe(false);
  });
});

describe('Dialoge (Alert.alert)', () => {
  test('mit Abbrechen-Knopf: per Zurueck schliessbar, Wirkung wie Abbrechen', () => {
    const onCancel = jest.fn();
    const opts = BS.alertOptionsWithBack([{ text: 'Abbrechen', style: 'cancel', onPress: onCancel }, { text: 'Loeschen', style: 'destructive', onPress() {} }]);
    expect(opts.cancelable).toBe(true);
    opts.onDismiss();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('reiner Hinweis (OK ohne Wirkung) ist schliessbar; ein einzelner Knopf MIT Wirkung nicht', () => {
    expect(BS.alertOptionsWithBack(undefined).cancelable).toBe(true);
    expect(BS.alertOptionsWithBack([{ text: 'OK' }]).cancelable).toBe(true);
    expect(BS.alertOptionsWithBack([{ text: 'Neu starten', onPress() {} }]).cancelable).toBeUndefined();
    expect(BS.alertOptionsWithBack([{ text: 'A', onPress() {} }, { text: 'B', onPress() {} }]).cancelable).toBeUndefined();
  });

  test('ausdrueckliche Angaben des Aufrufers gehen vor', () => {
    const o = { cancelable: false };
    expect(BS.alertOptionsWithBack([{ text: 'x', style: 'cancel' }], o)).toBe(o);
  });

  test('installAlertBack: Alert.alert bekommt die Optionen automatisch', () => {
    const { Alert } = require('react-native');
    const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    BS.installAlertBack();
    Alert.alert('T', 'M', [{ text: 'Abbrechen', style: 'cancel' }, { text: 'OK', onPress() {} }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][3]).toMatchObject({ cancelable: true });
    spy.mockRestore();
  });
});

describe('Quelltext', () => {
  const UI = ['App.tsx', 'SiegelScreen.tsx', 'GroupScreens.tsx', 'GroupChatScreen.tsx', 'GroupCallScreen.tsx',
    'PlayProScreen.tsx', 'UpdateUI.tsx', 'SecurityPinModal.tsx', 'DesignSection.tsx', 'PhonePairingPanel.tsx'];

  test('jedes <Modal> setzt onRequestClose', () => {
    const missing = [];
    for (const f of UI) {
      const src = read(f);
      const re = /<Modal\b([^>]*)>/g;
      let m;
      while ((m = re.exec(src))) {
        if (!/onRequestClose=/.test(m[1])) missing.push(f + ':' + src.slice(0, m.index).split('\n').length);
      }
    }
    expect(missing).toEqual([]);
  });

  test('App.tsx: Hardware-Zurueck fragt zuerst den BackStack, Dialog-Zurueck ist installiert', () => {
    const app = read('App.tsx');
    const i = app.indexOf('const onHardwareBack = () => {');
    expect(i).toBeGreaterThan(0);
    const body = app.slice(i, app.indexOf("if (screen === 'chat')", i));
    expect(body).toMatch(/handleBackStack\(\)\) return true;/);
    expect(app).toMatch(/\ninstallAlertBack\(\);/);
  });
});
