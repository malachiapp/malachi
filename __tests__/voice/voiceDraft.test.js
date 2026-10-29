// Gemeinsamer Aufnahme-Baustein (VoiceDraft.tsx) fuer Gruppenchat und Siegel:
// Anhalten -> Vorschau, Weiter aufnehmen haengt im Arbeitsspeicher an,
// Senden nimmt alles, Verwerfen loescht alles, Audio-Fokus macht aus einer
// Aufnahme eine Vorschau, Verlassen gibt das Mikrofon frei.
const { Buffer } = require('buffer');
const React = require('react');
const renderer = require('react-test-renderer');
const { NativeModules } = require('react-native');
const VD = require('../../VoiceDraft');
const { claimAudio, _resetAppFocusForTests } = require('../../AppFocus');

function adtsFrame(payload) {
  const len = payload.length + 7;
  return Buffer.concat([Buffer.from([0xFF, 0xF1, (1 << 6) | (8 << 2), (1 << 6) | (len >> 11), (len & 0x7FF) >> 3, ((len & 7) << 5) | 0x1F, 0xFC]), payload]);
}
const A = adtsFrame(Buffer.from('teil-eins'));
const B = adtsFrame(Buffer.from('teil-zwei'));
const tick = () => new Promise((r) => setTimeout(r, 0));

let native, segments, api, tree, onTick;
function Probe(props) { api = VD.useVoiceDraft(props); return null; }
async function mount(extra = {}) {
  onTick = jest.fn();
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(Probe, { owner: 'group', claim: () => claimAudio('group', () => api.yieldAudio()), onTick, ...extra }));
  });
}
const act = (fn) => renderer.act(async () => { await fn(); await tick(); });

beforeEach(() => {
  _resetAppFocusForTests();
  segments = [{ base64: A.toString('base64'), durationMs: 1200 }, { base64: B.toString('base64'), durationMs: 800 }];
  native = {
    startRecording: jest.fn(async () => true),
    stopRecording: jest.fn(async () => segments.shift()),
    cancelRecording: jest.fn(async () => true),
    play: jest.fn(async () => 0), pause: jest.fn(async () => true), resume: jest.fn(async () => true),
    seek: jest.fn(async () => true), setSpeed: jest.fn(async () => true), stop: jest.fn(async () => true),
  };
  NativeModules.MalachiSecureAudio = native;
});
afterEach(async () => { if (tree) await renderer.act(async () => tree.unmount()); tree = null; delete NativeModules.MalachiSecureAudio; });

test('anhalten -> Vorschau, weiter aufnehmen -> angehaengt, senden nimmt beide Teile', async () => {
  await mount();
  await act(() => api.start());
  expect(api.recording).toBe(true);
  await act(() => api.pause());
  expect(api.recording).toBe(false);
  expect(api.draft.durationMs).toBe(1200);
  expect(api.canResume).toBe(true);
  await act(() => api.resume());
  expect(api.recording).toBe(true);
  expect(api.recSecs).toBe(1);                      // Zeit laeuft ab dem bisherigen Teil
  let r;
  await act(async () => { r = await api.take(); });
  expect(r.durationMs).toBe(2000);
  expect(Buffer.from(r.base64, 'base64').equals(Buffer.concat([A, B]))).toBe(true);
  expect(api.draft).toBeNull();
  expect(native.cancelRecording).not.toHaveBeenCalled();
});

test('verwerfen waehrend der weiter laufenden Aufnahme loescht alles', async () => {
  await mount();
  await act(() => api.start());
  await act(() => api.pause());
  await act(() => api.resume());
  await act(() => api.cancel());
  expect(native.cancelRecording).toHaveBeenCalledTimes(1);
  expect(api.recording).toBe(false);
  expect(api.draft).toBeNull();
});

test('Audio-Fokus: eine andere Stelle braucht das Mikrofon -> Aufnahme wird zur Vorschau', async () => {
  await mount();
  await act(() => api.start());
  await act(() => claimAudio('siegel', async () => {}));
  expect(api.recording).toBe(false);
  expect(api.draft).not.toBeNull();
  expect(native.cancelRecording).not.toHaveBeenCalled();
});

test('Obergrenze: Aufnahme haelt bei maxMs selbst an (Vorschau bleibt)', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  try {
    await mount({ maxMs: 3000 });
    await renderer.act(async () => { await api.start(); });
    await renderer.act(async () => { jest.advanceTimersByTime(3600); });
    await renderer.act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(native.stopRecording).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
  await act(async () => {});
  expect(api.recording).toBe(false);
  expect(api.draft).not.toBeNull();
});

test('ohne verbindbaren Inhalt (Rueckfallweg MP4) kein Weiter-Aufnehmen', async () => {
  segments = [{ base64: Buffer.from('....ftypmp42 rest').toString('base64'), durationMs: 900 }];
  await mount();
  await act(() => api.start());
  await act(() => api.pause());
  expect(api.draft).not.toBeNull();
  expect(api.canResume).toBe(false);
  await act(() => api.resume());
  expect(native.startRecording).toHaveBeenCalledTimes(1);
});

test('Mikrofon verweigert: nichts gestartet', async () => {
  await mount({ ensurePermission: async () => false });
  let ok;
  await act(async () => { ok = await api.start(); });
  expect(ok).toBe(false);
  expect(native.startRecording).not.toHaveBeenCalled();
});

test('Bildschirm verlassen waehrend der Aufnahme: Mikrofon sofort frei', async () => {
  await mount();
  await act(() => api.start());
  await renderer.act(async () => tree.unmount());
  tree = null;
  expect(native.cancelRecording).toHaveBeenCalledTimes(1);
});

test('joinSegments: leerer neuer Abschnitt laesst den Entwurf unveraendert', () => {
  const base = { base64: A.toString('base64'), durationMs: 1200 };
  expect(VD.joinSegments(base, null)).toEqual({ base64: base.base64, durationMs: 1200 });
  expect(VD.joinSegments(null, { base64: 'x', durationMs: 5 })).toEqual({ base64: 'x', durationMs: 5 });
});
