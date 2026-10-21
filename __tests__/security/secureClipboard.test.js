// SecureClipboard.js: Chat-Nachrichten/Siegel-Geheimtexte werden "sensibel"
// kopiert und nach 60 s geleert - aber nur, wenn noch genau unser Inhalt in
// der Zwischenablage liegt. Im Hintergrund (nicht lesbar) wird beim naechsten
// Oeffnen der App erneut versucht.
let SC;
let RN;
let Clipboard;
let listeners;
let native;
const clipboardModul = () => {
  const m = require('@react-native-clipboard/clipboard');
  return m.default || m;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  // Nach resetModules frische Instanzen holen - dieselben, die SecureClipboard.js sieht.
  RN = require('react-native');
  Clipboard = clipboardModul();
  listeners = [];
  jest.spyOn(RN.AppState, 'addEventListener').mockImplementation((ev, fn) => {
    listeners.push(fn);
    return { remove: () => { listeners = listeners.filter((f) => f !== fn); } };
  });
  native = {
    inhalt: null,
    lesbar: true,
    setSensitive: jest.fn(async (t) => { native.inhalt = t; return true; }),
    clearIfEquals: jest.fn(async (t) => {
      if (!native.lesbar || native.inhalt == null) return 'unklar';
      if (native.inhalt !== t) return 'anders';
      native.inhalt = null;
      return 'geleert';
    }),
  };
  RN.NativeModules.MalachiClipboard = native;
  SC = require('../../SecureClipboard');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete RN.NativeModules.MalachiClipboard;
});

const ablauf = async () => {
  jest.advanceTimersByTime(SC.CLEAR_AFTER_MS);
  await Promise.resolve();
  await Promise.resolve();
};

test('kopiert sensibel ueber das native Modul, nicht ueber die einfache Zwischenablage', async () => {
  const spy = jest.spyOn(Clipboard, 'setString');
  expect(await SC.copySensitive('Hallo')).toBe(true);
  expect(native.setSensitive).toHaveBeenCalledWith('Hallo');
  expect(spy).not.toHaveBeenCalled();
});

test('nach 60 s geleert, wenn noch unser Inhalt drinsteht', async () => {
  await SC.copySensitive('geheim');
  expect(native.clearIfEquals).not.toHaveBeenCalled();
  await ablauf();
  expect(native.clearIfEquals).toHaveBeenCalledWith('geheim');
  expect(native.inhalt).toBeNull();
  expect(listeners).toHaveLength(0);   // erledigt - kein Nachfassen mehr
});

test('inzwischen etwas anderes kopiert: wird nicht angetastet', async () => {
  await SC.copySensitive('geheim');
  native.inhalt = 'fremd';
  await ablauf();
  expect(native.inhalt).toBe('fremd');
  expect(listeners).toHaveLength(0);
});

test('App im Hintergrund (nicht lesbar): beim naechsten Oeffnen geleert', async () => {
  await SC.copySensitive('geheim');
  native.lesbar = false;
  await ablauf();
  expect(native.inhalt).toBe('geheim');
  expect(listeners).toHaveLength(1);
  native.lesbar = true;
  listeners[0]('active');
  await Promise.resolve();
  await Promise.resolve();
  expect(native.inhalt).toBeNull();
  expect(listeners).toHaveLength(0);
});

test('ohne natives Modul (z. B. aelterer Build): einfache Zwischenablage, ebenfalls nach 60 s geleert', async () => {
  delete RN.NativeModules.MalachiClipboard;
  const Cb = Clipboard;
  let ablage = '';
  jest.spyOn(Cb, 'setString').mockImplementation((t) => { ablage = t; });
  jest.spyOn(Cb, 'getString').mockImplementation(async () => ablage);
  expect(await SC.copySensitive('Hallo')).toBe(false);
  expect(ablage).toBe('Hallo');
  await ablauf();
  await Promise.resolve();
  expect(ablage).toBe('');
});
