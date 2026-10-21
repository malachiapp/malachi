/* eslint-env node */
// Oberflaeche der Telefonnummer-Kopplung (PhonePairingPanel.tsx im
// Verbinden-Bildschirm). Die Sitzung selbst (PhonePairing.startPhonePairing)
// ist hier ersetzt - geprueft wird nur, was die Oberflaeche mit den Nummern
// macht: kein Autofill, sofort aus dem Zustand entfernt, Pflicht-Vergleich des
// Codes, Abbruch bei Hintergrund und beim Verlassen, Hinweise sichtbar.
const React = require('react');
const renderer = require('react-test-renderer');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { Text, TextInput, AppState } = require('react-native');

const mockCtrl = { cancel: jest.fn(), confirm: jest.fn() };
let mockOpts = null;
jest.mock('../../PhonePairing', () => {
  const actual = jest.requireActual('../../PhonePairing');
  return { ...actual, startPhonePairing: jest.fn((o) => { mockOpts = o; return mockCtrl; }) };
});
const PP = require('../../PhonePairing');
const PhonePairingPanel = require('../../PhonePairingPanel').default;

const tick = () => new Promise((r) => setTimeout(r, 0));
const allText = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join('')).join(' | ');
const byId = (tree, id) => tree.root.findAll((n) => n.props && n.props.testID === id && typeof n.type !== 'string')[0]
  || tree.root.findAll((n) => n.props && n.props.testID === id)[0];
const inputs = (tree) => tree.root.findAllByType(TextInput);

const trees = [];
async function render(onPaired = jest.fn()) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(PhonePairingPanel, { onPaired })); });
  trees.push(tree);
  return tree;
}
afterEach(async () => {
  for (const t of trees.splice(0)) { await renderer.act(async () => { try { t.unmount(); } catch {} }); }
});
async function typeNumbers(tree, own, other) {
  const [a, b] = inputs(tree);
  await renderer.act(async () => { a.props.onChangeText(own); b.props.onChangeText(other); });
}
async function pressId(tree, id) {
  await renderer.act(async () => { byId(tree, id).props.onPress(); await tick(); });
}
async function setState(s) {
  await renderer.act(async () => { mockOpts.onState(s); await tick(); });
}

beforeEach(() => {
  mockOpts = null;
  mockCtrl.cancel.mockClear();
  mockCtrl.confirm.mockClear();
  PP.startPhonePairing.mockClear();
  AppState.addEventListener.mockClear();
});

test('Eingabefelder ohne Autofill/Autokorrektur, Datenschutz-Hinweise sichtbar', async () => {
  const tree = await render();
  const fields = inputs(tree);
  expect(fields).toHaveLength(2);
  for (const f of fields) {
    expect(f.props).toMatchObject({ keyboardType: 'phone-pad', autoComplete: 'off', importantForAutofill: 'no', autoCorrect: false });
  }
  const text = allText(tree);
  expect(text).toMatch(/Per Telefonnummer verbinden/);
  expect(text).toMatch(/nicht gespeichert und nicht gesendet/);
  expect(text).toMatch(/gleichzeitig starten/);
  expect(text).toMatch(/Code – vergleicht ihn am Telefon/);
});

test('ungueltige Nummer: Hinweis, keine Kopplung gestartet', async () => {
  const tree = await render();
  await typeNumbers(tree, '12345', '0176 12345678');
  await pressId(tree, 'phone-start');
  expect(PP.startPhonePairing).not.toHaveBeenCalled();
  expect(allText(tree)).toMatch(/Deine Nummer ist ungültig/);
  await typeNumbers(tree, '0176 12345678', '+49 176 12345678');
  await pressId(tree, 'phone-start');
  expect(PP.startPhonePairing).not.toHaveBeenCalled();
  expect(allText(tree)).toMatch(/zweimal dieselbe Nummer/);
});

test('Start: normalisierte Nummern an die Sitzung, Eingaben sofort geleert; Status, Code-Vergleich und Bestaetigung', async () => {
  const onPaired = jest.fn();
  const tree = await render(onPaired);
  await typeNumbers(tree, '0151 98765432', '0176 1234 5678');
  await pressId(tree, 'phone-start');
  expect(PP.startPhonePairing).toHaveBeenCalledTimes(1);
  expect(mockOpts).toMatchObject({ ownNumber: '+4915198765432', otherNumber: '+4917612345678' });
  // Nummern stehen nicht mehr im Zustand der Oberflaeche.
  expect(JSON.stringify(tree.toJSON())).not.toMatch(/98765432|12345678|1234 5678/);

  await setState({ phase: 'preparing', role: 'host' });
  expect(allText(tree)).toMatch(/Treffpunkt wird vorbereitet/);
  await setState({ phase: 'waiting', role: 'host', startedAt: Date.now() });
  expect(allText(tree)).toMatch(/warte auf deinen Kontakt \(…78\)/);
  await setState({ phase: 'compare', role: 'host', code: '123 456' });
  expect(allText(tree)).toMatch(/Verbunden – Code vergleichen/);
  expect(allText(tree)).toMatch(/123 456/);
  await pressId(tree, 'phone-confirm');
  expect(mockCtrl.confirm).toHaveBeenCalledWith(true);
  await setState({ phase: 'confirm-wait', role: 'host' });
  expect(allText(tree)).toMatch(/Warte auf die Bestätigung/);
  await setState({ phase: 'pairing', role: 'host' });
  expect(allText(tree)).toMatch(/Kontakt wird eingerichtet/);
  // Uebergabe an den Verbinden-Bildschirm.
  await renderer.act(async () => { mockOpts.onPaired({ id: 'c_x' }, { r: 1 }); mockOpts.onState({ phase: 'done' }); });
  expect(onPaired).toHaveBeenCalledWith({ id: 'c_x' }, { r: 1 });
  expect(allText(tree)).toMatch(/Verbunden!/);
  // Nach Erfolg kein Abbruch beim Verlassen (die Verbindung gehoert jetzt dem Kontakt).
  await renderer.act(async () => { tree.unmount(); });
  expect(mockCtrl.cancel).not.toHaveBeenCalled();
});

test('"Stimmt nicht" wird weitergegeben; Fehler werden verstaendlich angezeigt', async () => {
  const tree = await render();
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  await pressId(tree, 'phone-start');
  await setState({ phase: 'compare', code: '654 321' });
  await pressId(tree, 'phone-reject');
  expect(mockCtrl.confirm).toHaveBeenCalledWith(false);
  await setState({ phase: 'error', error: 'mismatch', code: null });
  expect(allText(tree)).toMatch(/Codes stimmten nicht überein/);
  expect(allText(tree)).not.toMatch(/654 321/);
  for (const [code, re] of [['timeout', /10 Minuten/], ['peer-abort', /Kontakt hat abgebrochen/], ['background', /Hintergrund/]]) {
    await setState({ phase: 'error', error: code });
    expect(allText(tree)).toMatch(re);
  }
});

test('App geht in den Hintergrund: laufende Kopplung abgebrochen, eingegebene Nummern geleert', async () => {
  const tree = await render();
  const handler = AppState.addEventListener.mock.calls.find((c) => c[0] === 'change')[1];
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  // Noch nicht gestartet: nur leeren.
  await renderer.act(async () => { handler('background'); });
  expect(inputs(tree).map((i) => i.props.value)).toEqual(['', '']);
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  await pressId(tree, 'phone-start');
  await setState({ phase: 'waiting', role: 'client', startedAt: Date.now() });
  await renderer.act(async () => { handler('background'); });
  expect(mockCtrl.cancel).toHaveBeenCalledWith('background');
});

test('Bildschirm verlassen waehrend der Suche: Abbruch', async () => {
  const tree = await render();
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  await pressId(tree, 'phone-start');
  await setState({ phase: 'waiting', role: 'host', startedAt: Date.now() });
  await renderer.act(async () => { tree.unmount(); });
  expect(mockCtrl.cancel).toHaveBeenCalledTimes(1);
});

test('Abbrechen-Knopf waehrend der Suche', async () => {
  const tree = await render();
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  await pressId(tree, 'phone-start');
  await setState({ phase: 'waiting', role: 'host', startedAt: Date.now() });
  await pressId(tree, 'phone-cancel');
  expect(mockCtrl.cancel).toHaveBeenCalled();
});

test('sofortiger Fehler (z.B. nicht unterstuetzt): Meldung, und "Erneut verbinden" startet wirklich neu', async () => {
  const tree = await render();
  PP.startPhonePairing.mockImplementationOnce((o) => { mockOpts = o; o.onState({ phase: 'error', error: 'unsupported' }); return { ...mockCtrl, finished: true }; });
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  await pressId(tree, 'phone-start');
  expect(allText(tree)).toMatch(/aktuelle Malachi-Version/);
  await typeNumbers(tree, '0151 98765432', '0176 12345678');
  await pressId(tree, 'phone-start');
  expect(PP.startPhonePairing).toHaveBeenCalledTimes(2);
});
