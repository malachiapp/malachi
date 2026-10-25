// Sprachnachrichten ohne Klartext-Datei (SecureAudio.js, Audit 2026-10-25):
// mit dem nativen Modul entsteht beim Aufnehmen und Abspielen KEINE Datei -
// alles laeuft ueber den Arbeitsspeicher. Ohne Modul (aeltere Bauweise)
// bleibt der bisherige Weg mit kurz lebender Cache-Datei.
const fs = require('fs');
const path = require('path');

const mockFiles = new Map();
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  DocumentDirectoryPath: '/docs',
  writeFile: jest.fn(async (p, d) => { mockFiles.set(p, d); }),
  readFile: jest.fn(async (p) => { if (!mockFiles.has(p)) throw new Error('ENOENT'); return mockFiles.get(p); }),
  unlink: jest.fn(async (p) => { mockFiles.delete(p); }),
}));
const mockLib = { rec: null, played: null, listener: null };
jest.mock('react-native-audio-recorder-player', () => {
  class P {
    constructor() {
      this.startRecorder = jest.fn(async (p) => { mockLib.rec = p; mockFiles.set(p, 'QUFD'); });
      this.stopRecorder = jest.fn(async () => mockLib.rec);
      this.startPlayer = jest.fn(async (p) => { mockLib.played = p; });
      this.stopPlayer = jest.fn(async () => {});
      this.addPlayBackListener = jest.fn((cb) => { mockLib.listener = cb; });
      this.removePlayBackListener = jest.fn(() => { mockLib.listener = null; });
      this.setSubscriptionDuration = jest.fn(async () => {});
      this.addRecordBackListener = jest.fn();
      this.removeRecordBackListener = jest.fn();
    }
  }
  return { __esModule: true, default: P, AudioSourceAndroidType: { MIC: 1 }, OutputFormatAndroidType: { MPEG_4: 2 }, AudioEncoderAndroidType: { AAC: 3 } };
});

const { NativeModules, DeviceEventEmitter } = require('react-native');
const RNFS = require('react-native-fs');
const SA = require('../../SecureAudio');

function fakeNative() {
  return {
    startRecording: jest.fn(async () => true),
    stopRecording: jest.fn(async () => ({ base64: 'QURUUw==', durationMs: 4200 })),
    cancelRecording: jest.fn(async () => true),
    play: jest.fn(async () => 4200),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    seek: jest.fn(async () => true),
    setSpeed: jest.fn(async () => true),
    stop: jest.fn(async () => true),
  };
}

beforeEach(() => {
  SA._resetSecureAudioForTests();
  mockFiles.clear();
  jest.clearAllMocks();
  delete NativeModules.MalachiSecureAudio;
});

describe('mit nativem Modul: nur Arbeitsspeicher', () => {
  test('Aufnahme: Pegel kommen an, Ergebnis ist Base64 + Dauer, keine Datei', async () => {
    const n = fakeNative();
    NativeModules.MalachiSecureAudio = n;
    const vp = SA.getVoicePlayer();
    expect(vp.secure).toBe(true);
    const levels = [];
    await vp.startRecording((db) => levels.push(db));
    DeviceEventEmitter.emit('MalachiSecureAudioLevel', { db: -12.5 });
    DeviceEventEmitter.emit('MalachiSecureAudioLevel', { db: -40 });
    expect(levels).toEqual([-12.5, -40]);
    expect(await vp.stopRecording()).toEqual({ base64: 'QURUUw==', durationMs: 4200 });
    DeviceEventEmitter.emit('MalachiSecureAudioLevel', { db: -1 });   // nach dem Stoppen nicht mehr
    expect(levels).toHaveLength(2);
    expect(RNFS.writeFile).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
  });

  test('Wiedergabe: Base64 direkt an den Spieler, Ereignisse nur der eigenen Wiedergabe', async () => {
    const n = fakeNative();
    NativeModules.MalachiSecureAudio = n;
    const vp = SA.getVoicePlayer();
    const events = [];
    await vp.play('U1BSQUNI', (e) => events.push(e), { startMs: 1500, speed: 1.5 });
    expect(n.play).toHaveBeenCalledWith('1', 'U1BSQUNI', 1500, 1.5);
    DeviceEventEmitter.emit('MalachiSecureAudioPlayback', { id: '1', position: 2000, duration: 4200, finished: false });
    DeviceEventEmitter.emit('MalachiSecureAudioPlayback', { id: '99', position: 9, duration: 9, finished: true });   // fremd
    DeviceEventEmitter.emit('MalachiSecureAudioPlayback', { id: '1', position: 4200, duration: 4200, finished: true });
    DeviceEventEmitter.emit('MalachiSecureAudioPlayback', { id: '1', position: 1, duration: 1, finished: false });   // nach dem Ende
    expect(events).toEqual([
      { position: 2000, duration: 4200, finished: false, error: false },
      { position: 4200, duration: 4200, finished: true, error: false },
    ]);
    await vp.seek(3000);
    await vp.setSpeed(2);
    expect(n.seek).toHaveBeenCalledWith(3000);
    expect(n.setSpeed).toHaveBeenCalledWith(2);
    expect(RNFS.writeFile).not.toHaveBeenCalled();
  });

  test('neue Wiedergabe stoppt die alte; Abbrechen der Aufnahme', async () => {
    const n = fakeNative();
    NativeModules.MalachiSecureAudio = n;
    const vp = SA.getVoicePlayer();
    await vp.play('QQ==', () => {});
    await vp.play('Qg==', () => {});
    expect(n.stop).toHaveBeenCalledTimes(2);
    await vp.startRecording(() => {});
    await vp.cancelRecording();
    expect(n.cancelRecording).toHaveBeenCalled();
  });
});

describe('ohne natives Modul: bisheriger Weg, Datei nur kurz', () => {
  test('Aufnahme-Datei wird nach dem Lesen geloescht, Wiedergabe-Datei am Ende', async () => {
    const vp = SA.getVoicePlayer();
    expect(vp.secure).toBe(false);
    await vp.startRecording(() => {});
    expect(mockLib.rec).toMatch(/^\/cache\/malachi_\d+\.mp4$/);
    expect(await vp.stopRecording()).toEqual({ base64: 'QUFD', durationMs: null });
    expect(mockFiles.has(mockLib.rec)).toBe(false);
    const ev = [];
    await vp.play('UExBWQ==', (e) => ev.push(e));
    expect(mockLib.played).toMatch(/^\/cache\/play_\d+\.mp4$/);
    expect(mockFiles.get(mockLib.played)).toBe('UExBWQ==');
    mockLib.listener({ isFinished: true, currentPosition: 10, duration: 10 });
    await new Promise((r) => setTimeout(r, 0));
    expect(ev[0].finished).toBe(true);
    expect(mockFiles.size).toBe(0);
  });
});

describe('Verdrahtung (Quelltext): keine Klartext-Audiodatei mehr in Chat, Gruppe, Siegel', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  test.each(['App.tsx', 'GroupChatScreen.tsx', 'SiegelScreen.tsx'])('%s', (f) => {
    const src = read(f);
    expect(src).toMatch(/getVoicePlayer\(\)/);
    expect(src).not.toMatch(/startRecorder\(/);
    expect(src).not.toMatch(/startPlayer\(/);
    expect(src).not.toMatch(/(from |require\()'react-native-audio-recorder-player'/);
  });
  test('natives Modul: Mikrofon "privacy sensitive", Wiedergabe aus dem Speicher', () => {
    const kt = read('android/app/src/main/java/com/securecommapp/vault/MalachiSecureAudioModule.kt');
    expect(kt).toMatch(/setPrivacySensitive\(true\)/);
    expect(kt).toMatch(/MediaDataSource/);
    expect(kt).not.toMatch(/FileOutputStream|File\(/);
  });
});
