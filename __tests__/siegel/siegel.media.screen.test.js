// Darstellungstest Siegel-Anhaenge (SiegelScreen.tsx): Bild/Datei/Sprach-
// nachricht verschluesseln (teilen bzw. in den Malachi-Chat), Siegel-Datei
// oeffnen (Chat-Blase bzw. Dateiauswahl), Anzeige nur aus dem Arbeitsspeicher,
// Temp-Dateien nur kurz und im Siegel-Cache-Ordner, Sperren verwirft alles.
// Gemockt sind nur die nativen Bruecken (Bildauswahl, Dateiauswahl,
// Rekorder/Spieler, Dateisystem, FileShareModule) - die Kryptografie ist echt.
const React = require('react');
const renderer = require('react-test-renderer');
const { fakeKyber, fakeSiegelKey, rng } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, Text, TextInput, Image, Alert, AppState } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
NativeModules.MalachiSiegelKey = fakeSiegelKey();
const shared = [];
NativeModules.FileShareModule = {
  shareFile: jest.fn(async (path, mime, title) => { shared.push({ path, mime, title, b64: mockFs.get(path) }); return true; }),
};

// Dateisystem im Speicher (Pfad -> Base64).
const mockFs = new Map();
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  DocumentDirectoryPath: '/docs',
  mkdir: jest.fn(async () => {}),
  exists: jest.fn(async (p) => [...mockFs.keys()].some((k) => k === p || k.startsWith(p + '/'))),
  writeFile: jest.fn(async (p, data) => { mockFs.set(p, data); }),
  readFile: jest.fn(async (p) => { if (!mockFs.has(p)) throw new Error('ENOENT ' + p); return mockFs.get(p); }),
  unlink: jest.fn(async (p) => {
    const keys = [...mockFs.keys()].filter((k) => k === p || k.startsWith(p + '/'));
    if (!keys.length) throw new Error('ENOENT ' + p);
    for (const k of keys) mockFs.delete(k);
  }),
}));
let mockImageResult = null;
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(async () => mockImageResult()),
}));
let mockPicked = null;
jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(async () => mockPicked()),
  isErrorWithCode: (e) => !!e?.code,
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
}));
const mockAudio = { listener: null, recorded: null };
jest.mock('react-native-audio-recorder-player', () => {
  class FakePlayer {
    constructor() {
      this.startRecorder = jest.fn(async (p) => { mockAudio.recPath = p; mockFs.set(p, mockAudio.recorded); return p; });
      this.stopRecorder = jest.fn(async () => mockAudio.recPath);
      this.startPlayer = jest.fn(async (p) => { mockAudio.playPath = p; mockAudio.playedB64 = mockFs.get(p); return p; });
      this.stopPlayer = jest.fn(async () => 'stopped');
      this.addPlayBackListener = jest.fn((cb) => { mockAudio.listener = cb; });
      this.removePlayBackListener = jest.fn(() => { mockAudio.listener = null; });
      mockAudio.instance = this;
    }
  }
  return {
    __esModule: true,
    default: FakePlayer,
    AudioSourceAndroidType: { MIC: 1 },
    OutputFormatAndroidType: { MPEG_4: 2 },
    AudioEncoderAndroidType: { AAC: 3 },
  };
});

const EncryptedStorage = require('react-native-encrypted-storage').default;
const V = require('../../SiegelVault');
const S = require('../../SiegelCrypto');
const SiegelScreen = require('../../SiegelScreen').default;
const { SafeAreaProvider } = require('react-native-safe-area-context');
const appStateHandler = AppState.addEventListener.mock.calls.find((c) => c[0] === 'change')?.[1];

const PASS = 'Kerze-Berg-Fluss-42';
const kyber = NativeModules.KyberModule;
const tick = () => new Promise((r) => setTimeout(r, 0));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const bytesOf = (n, seed = 5) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (i * 13 + seed) & 255; return o; };

async function renderScreen(props = {}) {
  let tree;
  const element = (p) => React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } },
    React.createElement(SiegelScreen, { visible: true, onClose: () => {}, accent: '#0A7EA4', ...p }));
  await renderer.act(async () => { tree = renderer.create(element(props)); });
  await renderer.act(async () => { await tick(); await tick(); });
  tree.rerenderWith = async (p) => { await renderer.act(async () => { tree.update(element({ ...props, ...p })); await tick(); await tick(); }); };
  return tree;
}
const allText = (tree) => tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join('')).join(' | ');
async function press(tree, label) {
  // Text-Knoepfe ueber ihre Beschriftung, Symbol-Knoepfe (Eingabefeld: Anhang,
  // Senden, Sprachnachricht ...) ueber accessibilityLabel.
  const node = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function'
    && (n.props.accessibilityLabel === label
      || n.findAllByType(Text).some((t) => [].concat(t.props.children).join('') === label)))[0];
  if (!node) throw new Error('Knopf nicht gefunden: ' + label + '\n' + allText(tree));
  await renderer.act(async () => { await node.props.onPress(); await tick(); await tick(); });
}
async function type(tree, placeholderPart, value) {
  const input = tree.root.findAllByType(TextInput).find((i) => String(i.props.placeholder || '').includes(placeholderPart));
  if (!input) throw new Error('Feld nicht gefunden: ' + placeholderPart);
  await renderer.act(async () => { input.props.onChangeText(value); });
}
async function settle() { await renderer.act(async () => { for (let i = 0; i < 5; i++) await tick(); }); }
const shownImages = (tree) => tree.root.findAllByType(Image).map((i) => i.props.source?.uri || '');

async function pairWithPeer(name = 'Alex') {
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  const c = await V.finishInvite(peer.qr, name);
  return { id: c.id, peer: peer.contact };
}

beforeEach(async () => {
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
  mockFs.clear();
  shared.length = 0;
  NativeModules.FileShareModule.shareFile.mockClear();
  mockAudio.listener = null;
});
afterEach(() => { jest.restoreAllMocks(); });

test('Bild ausserhalb eines Chats: Systemauswahl sperrt nicht, Siegel-Datei wird geteilt, Auswahl-Kopie geloescht', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const img = bytesOf(3000);
  mockFs.set('/cache/rn_image_picker_lib_temp_1.jpg', b64(img));
  mockImageResult = () => {
    appStateHandler('background');                         // Galerie schickt die App in den Hintergrund
    return { assets: [{ base64: b64(img), type: 'image/jpeg', uri: 'file:///cache/rn_image_picker_lib_temp_1.jpg', fileName: 'rn_image_picker_lib_temp_1.jpg' }] };
  };
  const tree = await renderScreen();
  await press(tree, 'Alex');
  await press(tree, 'Anhang');
  await press(tree, 'Bild');
  expect(V.isUnlocked()).toBe(true);
  expect(shared).toHaveLength(1);
  expect(shared[0].path).toMatch(/^\/cache\/malachi_siegel\/[0-9a-f]{16}\/siegel-[0-9a-f]{16}\.sgl$/);
  expect(shared[0].mime).toBe('application/octet-stream');
  expect(mockFs.has('/cache/rn_image_picker_lib_temp_1.jpg')).toBe(false);
  const o = await S.openMedia(peer.ratchet, unb64(shared[0].b64), { rng });
  expect(o).toMatchObject({ kind: 'image', mime: 'image/jpeg', name: 'Bild.jpg' });
  expect(Buffer.from(o.bytes).equals(Buffer.from(img))).toBe(true);
  expect(allText(tree)).toMatch(/Noch einmal teilen/);
  // Schliessen raeumt den Siegel-Cache-Ordner.
  await tree.rerenderWith({ visible: false });
  await settle();
  expect([...mockFs.keys()].filter((k) => k.startsWith('/cache/malachi_siegel'))).toEqual([]);
  await renderer.act(async () => tree.unmount());
});

test('Datei im Malachi-Chat: geht als siegel-<zufall>.sgl in den Chat, danach gesperrt und geschlossen', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  await V.linkChat(id, 'chat-1');
  const pdf = bytesOf(5000, 9);
  mockFs.set('content://docs/vertrag.pdf', b64(pdf));
  mockPicked = () => [{ uri: 'content://docs/vertrag.pdf', name: 'Vertrag.pdf', type: 'application/pdf', size: pdf.length }];
  const files = [];
  const onClose = jest.fn();
  const tree = await renderScreen({ chatId: 'chat-1', chatName: 'Alex', onSendCipher: () => {}, onSendFile: (...a) => files.push(a), onClose });
  expect(allText(tree)).toMatch(/alles geht verschlüsselt in diesen Chat/);
  await press(tree, 'Anhang');
  await press(tree, 'Datei');
  expect(files).toHaveLength(1);
  const [fileB64, fileName, mime] = files[0];
  expect(fileName).toMatch(/^siegel-[0-9a-f]{16}\.sgl$/);
  expect(mime).toBe('application/octet-stream');
  expect(V.isUnlocked()).toBe(false);
  expect(onClose).toHaveBeenCalled();
  expect(shared).toHaveLength(0);                           // nichts ausserhalb geteilt
  const o = await S.openMedia(peer.ratchet, unb64(fileB64), { rng });
  expect(o).toMatchObject({ kind: 'file', mime: 'application/pdf', name: 'Vertrag.pdf' });
  expect(Buffer.from(o.bytes).equals(Buffer.from(pdf))).toBe(true);
  await renderer.act(async () => tree.unmount());
});

test('Sprachnachricht: Aufnahme in den Siegel-Cache, beim Stoppen gelesen und sofort geloescht, verschluesselt geteilt', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const voice = bytesOf(4000, 3);
  mockAudio.recorded = b64(voice);
  const realNow = Date.now;
  let offset = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  const tree = await renderScreen();
  await press(tree, 'Alex');
  await press(tree, 'Sprachnachricht');
  expect(mockAudio.recPath).toMatch(/^\/cache\/malachi_siegel\/[0-9a-f]{16}\/aufnahme\.mp4$/);
  // Aufnahme-Leiste wie in den Chats (VoiceDraft.tsx): Zeit sichtbar, "● Aufnahme" fuer den Screenreader
  const time = tree.root.findAll((n) => n.props && n.props.testID === 'siegel-rec-time' && typeof n.type !== 'string')[0];
  expect(time.props.accessibilityLabel).toMatch(/● Aufnahme/);
  offset += 3000;
  await press(tree, 'Sprachnachricht senden');
  await settle();
  expect(mockFs.has(mockAudio.recPath)).toBe(false);
  expect(shared).toHaveLength(1);
  const o = await S.openMedia(peer.ratchet, unb64(shared[0].b64), { rng });
  expect(o).toMatchObject({ kind: 'audio', mime: 'audio/mp4' });
  expect(Buffer.from(o.bytes).equals(Buffer.from(voice))).toBe(true);
  await renderer.act(async () => tree.unmount());
});

test('Sprachnachricht verwerfen bzw. Sperren waehrend der Aufnahme: Datei weg, nichts verschluesselt', async () => {
  await V.setup(PASS);
  await pairWithPeer();
  mockAudio.recorded = b64(bytesOf(100));
  const tree = await renderScreen();
  await press(tree, 'Alex');
  await press(tree, 'Sprachnachricht');
  await press(tree, 'Aufnahme verwerfen');
  await settle();
  expect(mockFs.has(mockAudio.recPath)).toBe(false);
  await press(tree, 'Sprachnachricht');
  const second = mockAudio.recPath;
  await renderer.act(async () => { V.lock(); await tick(); });
  await settle();
  expect(mockFs.has(second)).toBe(false);
  expect(shared).toHaveLength(0);
  expect(allText(tree)).toMatch(/gesperrt/);
  await renderer.act(async () => tree.unmount());
});

test('Siegel-Anhang aus dem Chat (initialMedia): nach dem Entsperren Bild nur aus dem Arbeitsspeicher, Sperren verwirft es', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const img = bytesOf(2500, 1);
  const m = await S.sealMedia(peer.ratchet, { kind: 'image', mime: 'image/png', name: 'foto.png', bytes: img }, { rng });
  V.lock();
  const tree = await renderScreen({ initialMedia: b64(m.file), chatId: 'chat-1', chatName: 'Alex', onSendCipher: () => {}, onSendFile: () => {} });
  await type(tree, 'Siegel-Passphrase', PASS);
  await press(tree, 'Entsperren');
  await settle();
  const imgs = shownImages(tree);
  expect(imgs).toHaveLength(1);
  expect(imgs[0]).toBe('data:image/png;base64,' + b64(img));
  expect(allText(tree)).toMatch(/Von Alex/);
  expect(mockFs.size).toBe(0);                              // keine Datei, nirgends
  await renderer.act(async () => { V.lock(); await tick(); });
  expect(shownImages(tree)).toHaveLength(0);
  expect(allText(tree)).toMatch(/gesperrt/);
  // Erneut oeffnen geht nicht (Zero Trace).
  await V.unlock(PASS);
  await expect(V.openMediaAny(m.file)).rejects.toMatchObject({ code: 'used' });
  await renderer.act(async () => tree.unmount());
});

test('Sprachnachricht abspielen: Cache-Datei nur waehrend der Wiedergabe', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const voice = bytesOf(1800, 7);
  const m = await S.sealMedia(peer.ratchet, { kind: 'audio', mime: 'audio/mp4', name: 'Sprachnachricht.mp4', bytes: voice }, { rng });
  const tree = await renderScreen({ initialMedia: b64(m.file) });
  expect(allText(tree)).toMatch(/Sprachnachricht/);
  await press(tree, '▶ Abspielen');
  expect(mockAudio.playPath).toMatch(/^\/cache\/malachi_siegel\/[0-9a-f]{16}\/wiedergabe\.mp4$/);
  expect(mockAudio.playedB64).toBe(b64(voice));
  expect(mockFs.has(mockAudio.playPath)).toBe(true);
  await renderer.act(async () => { mockAudio.listener({ isFinished: true, currentPosition: 1000, duration: 1000 }); await tick(); });
  await settle();
  expect(mockFs.has(mockAudio.playPath)).toBe(false);
  // Noch einmal abspielen, dann sperren: Datei ebenfalls sofort weg.
  await press(tree, '▶ Abspielen');
  const again = mockAudio.playPath;
  expect(mockFs.has(again)).toBe(true);
  await renderer.act(async () => { V.lock(); await tick(); });
  await settle();
  expect(mockFs.has(again)).toBe(false);
  await renderer.act(async () => tree.unmount());
});

test('Datei oeffnen/teilen nur nach Warnung; die Kopie verschwindet beim Schliessen', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const doc = bytesOf(900, 2);
  const m = await S.sealMedia(peer.ratchet, { kind: 'file', mime: 'application/pdf', name: 'Befund.pdf', bytes: doc }, { rng });
  const alerts = [];
  jest.spyOn(Alert, 'alert').mockImplementation((...a) => { alerts.push(a); });
  const tree = await renderScreen({ initialMedia: b64(m.file) });
  expect(allText(tree)).toMatch(/Befund\.pdf/);
  await press(tree, 'Öffnen/Exportieren …');
  expect(shared).toHaveLength(0);                           // erst nach Bestaetigung
  expect(alerts[0][0]).toBe('Exportieren – verlässt Siegel');
  const go = alerts[0][2].find((b) => b.text === 'Exportieren');
  await renderer.act(async () => { await go.onPress(); await tick(); await tick(); });
  expect(shared).toHaveLength(1);
  expect(shared[0].path).toMatch(/^\/cache\/malachi_siegel\/[0-9a-f]{16}\/Befund\.pdf$/);
  expect(shared[0].mime).toBe('application/pdf');
  expect(shared[0].b64).toBe(b64(doc));
  await tree.rerenderWith({ visible: false });
  await settle();
  expect(mockFs.size).toBe(0);
  await renderer.act(async () => tree.unmount());
});

// Nutzerwunsch: Siegel-Nachrichten und -Dateien muessen sich unabhaengig vom
// Absender exportieren lassen (z.B. Kanzlei <-> Mandant, Ablage in der Akte).
test('Export: Bild und Sprachnachricht lassen sich nach Warnung exportieren; Abbrechen exportiert nichts', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const alerts = [];
  jest.spyOn(Alert, 'alert').mockImplementation((...a) => { alerts.push(a); });
  for (const [kind, mime, name, bytes] of [
    ['image', 'image/jpeg', 'Foto.jpg', bytesOf(2500, 9)],
    ['audio', 'audio/mp4', 'Sprachnachricht.mp4', bytesOf(1600, 3)],
  ]) {
    alerts.length = 0;
    shared.length = 0;
    if (!V.isUnlocked()) await V.unlock(PASS);            // Schliessen sperrt den Tresor
    const m = await S.sealMedia(peer.ratchet, { kind, mime, name, bytes }, { rng });
    peer.ratchet = m.ratchet;                             // Absender-Kette weiterschreiben
    const tree = await renderScreen({ initialMedia: b64(m.file) });
    await press(tree, 'Exportieren …');
    expect(alerts[0][0]).toBe('Exportieren – verlässt Siegel');
    expect(alerts[0][2].find((b) => b.text === 'Abbrechen').style).toBe('cancel');
    expect(shared).toHaveLength(0);                          // ohne Bestaetigung nichts
    const go = alerts[0][2].find((b) => b.text === 'Exportieren');
    await renderer.act(async () => { await go.onPress(); await tick(); await tick(); });
    expect(shared).toHaveLength(1);
    expect(shared[0].mime).toBe(mime);
    expect(shared[0].title).toBe(name);
    expect(shared[0].path).toMatch(/^\/cache\/malachi_siegel\/[0-9a-f]{16}\//);
    expect(shared[0].b64).toBe(b64(bytes));
    await tree.rerenderWith({ visible: false });
    await settle();
    expect(mockFs.size).toBe(0);                             // Zero Trace: Kopie weg
    await renderer.act(async () => tree.unmount());
  }
});

test('Export: entschluesselte Textnachricht als .txt (mit Absender), nur nach Warnung, Kopie danach geloescht', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer('Kanzlei Weber');
  const m = await S.sealText(peer.ratchet, 'Termin am Landgericht: Donnerstag 9 Uhr – Ü ä ß', { rng });
  const alerts = [];
  jest.spyOn(Alert, 'alert').mockImplementation((...a) => { alerts.push(a); });
  const tree = await renderScreen({ initialMessage: m.message });
  expect(allText(tree)).toMatch(/Termin am Landgericht/);
  await press(tree, 'Exportieren …');
  expect(alerts[0][0]).toBe('Exportieren – verlässt Siegel');
  expect(shared).toHaveLength(0);
  const go = alerts[0][2].find((b) => b.text === 'Exportieren');
  await renderer.act(async () => { await go.onPress(); await tick(); await tick(); });
  expect(shared).toHaveLength(1);
  expect(shared[0].mime).toBe('text/plain');
  expect(shared[0].title).toMatch(/^Siegel-Nachricht Kanzlei Weber .*\.txt$/);
  expect(shared[0].path).toMatch(/^\/cache\/malachi_siegel\/[0-9a-f]{16}\/Siegel-Nachricht /);
  const body = Buffer.from(shared[0].b64, 'base64').toString('utf8');
  expect(body).toMatch(/^Von: Kanzlei Weber\n/);
  expect(body).toContain('Termin am Landgericht: Donnerstag 9 Uhr – Ü ä ß');
  await tree.rerenderWith({ visible: false });
  await settle();
  expect(mockFs.size).toBe(0);
  await renderer.act(async () => tree.unmount());
});

test('Siegel-Datei aus WhatsApp & Co. oeffnen (Dateiauswahl): erkennt den Kontakt; fremde Datei und zweiter Versuch klar abgelehnt', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer('Bea');
  const doc = bytesOf(700, 4);
  const m = await S.sealMedia(peer.ratchet, { kind: 'file', mime: 'text/plain', name: 'notiz.txt', bytes: doc }, { rng });
  mockFs.set('content://wa/siegel-1.sgl', b64(m.file));
  mockFs.set('content://wa/foto.jpg', b64(bytesOf(500)));
  const tree = await renderScreen();
  await press(tree, 'Nachricht entschlüsseln');
  mockPicked = () => [{ uri: 'content://wa/foto.jpg', name: 'foto.jpg', type: 'image/jpeg', size: 500 }];
  await press(tree, 'Siegel-Datei öffnen');
  expect(allText(tree)).toMatch(/keine Siegel-Datei/);
  mockPicked = () => [{ uri: 'content://wa/siegel-1.sgl', name: 'siegel-1.sgl', type: 'application/octet-stream', size: m.file.length }];
  await press(tree, 'Siegel-Datei öffnen');
  expect(allText(tree)).toMatch(/Von Bea/);
  expect(allText(tree)).toMatch(/notiz\.txt/);
  await press(tree, 'Gelesen – verwerfen');
  expect(allText(tree)).not.toMatch(/notiz\.txt/);
  await press(tree, 'Siegel-Datei öffnen');
  expect(allText(tree)).toMatch(/schon geöffnet/);
  // Abbruch der Auswahl: kein Fehler.
  mockPicked = () => { const e = new Error('abgebrochen'); e.code = 'OPERATION_CANCELED'; throw e; };
  await press(tree, 'Siegel-Datei öffnen');
  expect(allText(tree)).not.toMatch(/nicht geklappt/);
  await renderer.act(async () => tree.unmount());
});

test('Antwort direkt unter einem Anhang: geht als Siegel-Text zurueck in den Chat', async () => {
  await V.setup(PASS);
  const { peer } = await pairWithPeer();
  const m = await S.sealMedia(peer.ratchet, { kind: 'image', mime: 'image/jpeg', name: 'x.jpg', bytes: bytesOf(400) }, { rng });
  const sent = [];
  const tree = await renderScreen({ initialMedia: b64(m.file), chatId: 'chat-1', chatName: 'Alex', onSendCipher: (c) => sent.push(c), onSendFile: () => {} });
  await type(tree, 'Antwort an Alex', 'Schönes Foto');
  await press(tree, 'Senden');
  expect(sent).toHaveLength(1);
  expect(V.isUnlocked()).toBe(false);
  expect(shownImages(tree)).toHaveLength(0);
  expect((await S.openText(m.ratchet, sent[0], { rng })).text).toBe('Schönes Foto');
  await renderer.act(async () => tree.unmount());
});

test('SiegelFiles: nur Dateien im Cache werden geloescht, Namen bereinigt, .sgl erkannt', async () => {
  const SF = require('../../SiegelFiles');
  mockFs.set('/docs/original.jpg', 'x');
  mockFs.set('/cache/rn_image_picker_lib_temp_2.jpg', 'y');
  await SF.removeIfInCache('file:///docs/original.jpg');
  await SF.removeIfInCache('file:///cache/../docs/original.jpg');
  await SF.removeIfInCache('file:///cache/rn_image_picker_lib_temp_2.jpg');
  expect(mockFs.has('/docs/original.jpg')).toBe(true);
  expect(mockFs.has('/cache/rn_image_picker_lib_temp_2.jpg')).toBe(false);
  expect(SF.safeFileName('../../a/b:c*.pdf')).not.toMatch(/[\/\\:*]/);
  expect(SF.safeFileName('..')).toBe('Datei');
  expect(SF.isSiegelFileName('siegel-0011.sgl')).toBe(true);
  expect(SF.isSiegelFileName('bild.jpg')).toBe(false);
  expect(SF.isSiegelFileName(undefined)).toBe(false);
  expect(await SF.newSiegelFileName()).toMatch(/^siegel-[0-9a-f]{16}\.sgl$/);
  expect(SF.siegelTmpDir().startsWith('/cache/malachi_')).toBe(true);  // vom App-Wipe erfasst
});

test('statisch: ChatScreen sendet Siegel-Anhaenge ueber sendFileNow, zeigt sie kompakt und oeffnet sie in Siegel', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/const sendFileNow = async \(base64, fileName, mimeType, size = null\) => \{/);
  expect(app).toMatch(/await sendFileNow\(base64, fileName, mimeType, picked\.size\);/);
  expect(app).toMatch(/onSendFile=\{\(b64, fileName, mime\) => sendFileNow\(b64, fileName, mime\)/);
  expect(app).toMatch(/initialMessage=\{siegelMsg\?\.msg \|\| null\} initialMedia=\{siegelMsg\?\.media \|\| null\}/);
  expect(app).toMatch(/if \(isSiegelFileName\(item\.fileName\)\) \{/);
  expect(app).toMatch(/: openSiegelAttachment\(item\)\)\}/);   // Audit G1: Inhalt aus RAM oder Ablage
  expect(app).toMatch(/mediaData\(chat\?\.id, item\)\.then\(\(d\) => \{\s*if \(d\) openSiegel\(null, d\);/);
  // Texte seit der Uebersetzung (i18n.js) ueber Schluessel; Deutsch bleibt die Quelle.
  expect(app).toMatch(/t\('chat\.siegelOnlyContactIt'\) : t\('chat\.tapToOpen'\)/);
  expect(app).toMatch(/\? t\('preview\.siegelAttachment'\) : preview;/);
  const { t } = require('../../i18n');
  expect(t('chat.siegelOnlyContactIt')).toBe('Nur dein Siegel-Kontakt kann ihn öffnen');
  expect(t('chat.tapToOpen')).toBe('Antippen zum Öffnen');
  expect(t('preview.siegelAttachment')).toBe('🔒 Siegel-Anhang');
  expect(app).toMatch(/cleanupSharedFileCache\(\);\s*\/\/[^\n]*\n\s*cleanupSiegelTemp\(\);/);
  // Wipe der App erfasst den Siegel-Cache-Ordner (malachi_siegel) - seit dem
  // Audit 2026-10-19 (P3) wird der GESAMTE Cache geleert.
  const wipeFn = app.slice(app.indexOf('async function performWipe()'), app.indexOf('function LockScreen('));
  expect(wipeFn).toMatch(/const cached = await RNFS\.readDir\(RNFS\.CachesDirectoryPath\);\s*for \(const f of cached\) \{\s*await RNFS\.unlink\(f\.path\)/);
});
