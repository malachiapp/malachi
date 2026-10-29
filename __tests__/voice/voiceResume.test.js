// Sprachnachricht: Aufnahme fortsetzen + Vorschau im Eingabefeld (Nutzerwunsch
// 29.10.2026). Die sichere Aufnahme liefert ADTS (AAC) - ein weiterer
// Abschnitt wird im Arbeitsspeicher angehaengt, es entsteht keine Datei.
// Ausserdem: Zurueck-Taste (Aufnahme -> Vorschau, Vorschau -> verwerfen) und
// Mikrofon frei beim Verlassen des Chats.
const { Buffer } = require('buffer');
const React = require('react');
const renderer = require('react-test-renderer');

const mockConfig = { LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);
const mockSent = [];
jest.mock('../../BackgroundSync', () => {
  const actual = jest.requireActual('../../BackgroundSync');
  return { ...actual, sendViaOutbox: jest.fn(async (chatId, kind, payload, id) => { mockSent.push({ chatId, kind, payload, id }); }) };
});

const { NativeModules, PermissionsAndroid, Text } = require('react-native');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const SA = require('../../SecureAudio');
const VW = require('../../VoiceWave');
const BS = require('../../BackStack');

// Ein ADTS-Rahmen (AAC-LC, 16 kHz, mono) mit beliebigem Inhalt.
function adtsFrame(payload) {
  const len = payload.length + 7;
  return Buffer.concat([Buffer.from([0xFF, 0xF1, (1 << 6) | (8 << 2), (1 << 6) | (len >> 11), (len & 0x7FF) >> 3, ((len & 7) << 5) | 0x1F, 0xFC]), payload]);
}
const A = adtsFrame(Buffer.from('erster-abschnitt'));
const B = adtsFrame(Buffer.from('zweiter-abschnitt'));

describe('ADTS anhaengen (SecureAudio.js)', () => {
  test('erkennt ADTS, haengt zwei Aufnahmen byte-genau aneinander', () => {
    expect(SA.isAdtsBase64(A.toString('base64'))).toBe(true);
    expect(SA.isAdtsBase64(Buffer.from('ftypmp42xxxxxxxx').toString('base64'))).toBe(false);
    expect(SA.isAdtsBase64('')).toBe(false);
    const joined = SA.appendAdtsBase64(A.toString('base64'), B.toString('base64'));
    expect(Buffer.from(joined, 'base64').equals(Buffer.concat([A, B]))).toBe(true);
  });

  test('MP4 (Rueckfallweg) laesst sich nicht verbinden -> null', () => {
    const mp4 = Buffer.from('....ftypmp42 rest').toString('base64');
    expect(SA.appendAdtsBase64(A.toString('base64'), mp4)).toBeNull();
    expect(SA.appendAdtsBase64(mp4, A.toString('base64'))).toBeNull();
  });

  test('Pegel-Verteiler: load() setzt den bisherigen Verlauf (fuer die Live-Welle)', () => {
    const feed = VW.createLevelFeed(5);
    const seen = [];
    feed.subscribe((s) => seen.push(s.length));
    feed.load([-10, -20, 'x', -30, -40, -50, -60]);
    expect(feed.samples()).toEqual([-20, -30, -40, -50, -60]);
    expect(seen).toEqual([5]);
    feed.push(-5);
    expect(feed.samples()).toEqual([-30, -40, -50, -60, -5]);
  });
});

describe('Chat: Vorschau im Eingabefeld, weiter aufnehmen', () => {
  const { ChatScreen } = require('../../App');
  const { SafeAreaProvider } = require('react-native-safe-area-context');
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  const chat = { id: 'voice-resume-test', name: 'Anna' };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let native, segments, logSpy, warnSpy, permSpy;

  beforeAll(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(() => { logSpy.mockRestore(); warnSpy.mockRestore(); });
  beforeEach(async () => {
    await EncryptedStorage.clear();
    BS._resetBackStackForTests();
    mockSent.length = 0;
    segments = [{ base64: A.toString('base64'), durationMs: 1500 }, { base64: B.toString('base64'), durationMs: 2500 }];
    native = {
      startRecording: jest.fn(async () => true),
      stopRecording: jest.fn(async () => segments.shift()),
      cancelRecording: jest.fn(async () => true),
      play: jest.fn(async () => 0), pause: jest.fn(async () => true), resume: jest.fn(async () => true),
      seek: jest.fn(async () => true), setSpeed: jest.fn(async () => true), stop: jest.fn(async () => true),
    };
    NativeModules.MalachiSecureAudio = native;
    permSpy = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  });
  afterEach(() => { permSpy.mockRestore(); delete NativeModules.MalachiSecureAudio; });

  let lastPreview;
  async function renderChat() {
    lastPreview = jest.fn();
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
        React.createElement(ChatScreen, { chat, messages: [], onBack() {}, backInterceptRef: { current: null }, onCall() {},
          rtc: null, fontSize: 15, customBg: null, onRename() {}, onDelete() {}, onRemoteDelete() {}, onWipe() {}, onLastMessage: lastPreview })));
    });
    return tree;
  }
  const byId = (tree, id) => tree.root.findAll((n) => n.props && n.props.testID === id && typeof n.props.onPress === 'function')[0];
  // Mikrofon-Knopf: der einzige mit 1,5-s-Halten (Umschalten auf Siegel)
  const mic = (tree) => tree.root.findAll((n) => n.props && n.props.delayLongPress === 1500 && typeof n.props.onPress === 'function')[0];
  const press = async (node) => { await renderer.act(async () => { await node.props.onPress(); await tick(); await tick(); }); };
  const texts = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join('')).join(' | ');

  test('aufnehmen, stoppen, weiter aufnehmen, senden: eine Nachricht mit beiden Abschnitten', async () => {
    const tree = await renderChat();
    await press(mic(tree));                                  // Aufnahme 1
    expect(native.startRecording).toHaveBeenCalledTimes(1);
    await press(mic(tree));                                  // stoppen -> Vorschau
    expect(byId(tree, 'voice-preview-send')).toBeTruthy();
    expect(byId(tree, 'voice-preview-resume')).toBeTruthy();
    // Vorschau ersetzt das Textfeld (kein zweites Eingabefeld darunter)
    expect(tree.root.findAll((n) => n.props && n.props.placeholder !== undefined && n.props.multiline).length).toBe(0);
    expect(texts(tree)).toContain('0:01');

    await press(byId(tree, 'voice-preview-resume'));         // Aufnahme 2 haengt an
    expect(native.startRecording).toHaveBeenCalledTimes(2);
    expect(byId(tree, 'voice-preview-send')).toBeFalsy();    // waehrend der Aufnahme keine Vorschau
    expect(texts(tree)).toContain('00:01');                  // Zeit laeuft ab dem bisherigen Teil weiter
    await press(mic(tree));                                  // stoppen -> Vorschau mit allem
    expect(texts(tree)).toContain('0:04');

    await press(byId(tree, 'voice-preview-send'));
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].kind).toBe('audio');
    expect(mockSent[0].payload.durationMs).toBe(4000);
    expect(Buffer.from(mockSent[0].payload.base64, 'base64').equals(Buffer.concat([A, B]))).toBe(true);
    expect(native.cancelRecording).not.toHaveBeenCalled();
    // Chatliste: neutrale Vorschau "Sprachnachricht" statt der vorherigen Nachricht
    expect(lastPreview).toHaveBeenCalledWith(chat.id, require('../../i18n').t('preview.voice'));
    await renderer.act(async () => tree.unmount());
  });

  test('"loescht sich nach Anhoeren" bleibt beim Weiter-Aufnehmen und Sofort-Senden erhalten', async () => {
    const tree = await renderChat();
    await press(mic(tree));
    await press(mic(tree));
    await press(byId(tree, 'voice-preview-viewonce'));
    await press(byId(tree, 'voice-preview-resume'));
    // waehrend der Aufnahme: Senden-Knopf (Pfeil) schickt direkt (ohne Vorschau)
    const send = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function'
      && n.findAllByType(Text).some((t) => t.props.children === '→'))[0];
    expect(send).toBeTruthy();
    await press(send);
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].payload.viewOnce).toBe(true);
    expect(mockSent[0].payload.durationMs).toBe(4000);
    await renderer.act(async () => tree.unmount());
  });

  test('Zurueck-Taste: Aufnahme -> Vorschau (nichts verloren), Vorschau -> verworfen', async () => {
    const tree = await renderChat();
    await press(mic(tree));
    await renderer.act(async () => { expect(BS.handleBack()).toBe(true); await tick(); await tick(); });
    expect(byId(tree, 'voice-preview-send')).toBeTruthy();
    expect(native.stopRecording).toHaveBeenCalledTimes(1);
    await renderer.act(async () => { expect(BS.handleBack()).toBe(true); await tick(); });
    expect(byId(tree, 'voice-preview-send')).toBeFalsy();
    expect(BS.handleBack()).toBe(false);                    // nichts mehr offen -> Bildschirmwechsel
    expect(mockSent).toHaveLength(0);
    await renderer.act(async () => tree.unmount());
  });

  test('Chat verlassen waehrend der Aufnahme: Mikrofon sofort frei', async () => {
    const tree = await renderChat();
    await press(mic(tree));
    await renderer.act(async () => tree.unmount());
    expect(native.cancelRecording).toHaveBeenCalledTimes(1);
  });

  test('nicht verbindbare Aufnahme (kein ADTS): kein Weiter-Aufnehmen-Knopf', async () => {
    segments = [{ base64: Buffer.from('....ftypmp42 rest').toString('base64'), durationMs: 1000 }];
    const tree = await renderChat();
    await press(mic(tree));
    await press(mic(tree));
    expect(byId(tree, 'voice-preview-send')).toBeTruthy();
    expect(byId(tree, 'voice-preview-resume')).toBeFalsy();
    await renderer.act(async () => tree.unmount());
  });
});
