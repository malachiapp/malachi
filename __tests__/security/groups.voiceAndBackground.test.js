// Gruppenchat (GroupChatScreen.tsx), Nutzerwunsch 29.10.2026:
//  1. Chat-Hintergrund wie im 1:1-Chat - eigenes Hintergrundbild und die
//     gewaehlte Hintergrundfarbe fehlten bisher in Gruppen.
//  2. Sprachnachricht: Anhalten -> Vorschau, Weiter aufnehmen haengt an,
//     Senden schickt alles (VoiceDraft.tsx), Zurueck-Taste wie im 1:1-Chat.
const { Buffer } = require('buffer');
const React = require('react');
const renderer = require('react-test-renderer');
const EncryptedStorage = require('react-native-encrypted-storage').default;
require('./helpers/nativeBridgeMock').installKyberModuleMock();
require('../../BackgroundSync');
const GM = require('../../GroupMessaging');
const { NativeModules, PermissionsAndroid, FlatList, Image } = require('react-native');
const GroupChatScreen = require('../../GroupChatScreen').default;
const BS = require('../../BackStack');

const SELF = 'm_' + '0'.repeat(32);
const BOB = 'm_' + '1'.repeat(32);
const GID = 'g_' + 'e'.repeat(24);
const contacts = [{ id: 'c_bob', name: 'Bob', groupMemberId: BOB, initials: 'B', color: '#123', tc: '#fff' }];
const group = {
  v: 1, groupId: GID, name: 'Familie', selfMid: SELF, amAdmin: true,
  members: [{ mid: SELF, name: 'Ich' }, { mid: BOB, name: 'Bob' }], admins: [SELF], rev: 1, unread: 0, removed: false,
};
const palette = { bg: '#F6F2EA', surface: '#FFFDF8', surfaceAlt: '#EFE9DE', border: '#E2D9CA', text: '#1F1A14', textMuted: '#675E52',
  chatBg: '#F1ECE3', bubbleMine: '#0E6B6B', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFDF8', bubbleTheirsBorder: '#E2D9CA',
  bubbleTheirsText: '#1F1A14', accent: '#0E6B6B', onAccent: '#FFFFFF', accentFg: '#0E6B6B', danger: '#B42318' };

function adtsFrame(payload) {
  const len = payload.length + 7;
  return Buffer.concat([Buffer.from([0xFF, 0xF1, (1 << 6) | (8 << 2), (1 << 6) | (len >> 11), (len & 0x7FF) >> 3, ((len & 7) << 5) | 0x1F, 0xFC]), payload]);
}
const A = adtsFrame(Buffer.from('gruppe-eins'));
const B = adtsFrame(Buffer.from('gruppe-zwei'));
const tick = () => new Promise((r) => setTimeout(r, 0));

let native, segments, permSpy, sendSpy, logSpy;
beforeAll(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => { logSpy.mockRestore(); });
beforeEach(async () => {
  await EncryptedStorage.clear();
  BS._resetBackStackForTests();
  segments = [{ base64: A.toString('base64'), durationMs: 1500 }, { base64: B.toString('base64'), durationMs: 1000 }];
  native = {
    startRecording: jest.fn(async () => true), stopRecording: jest.fn(async () => segments.shift()),
    cancelRecording: jest.fn(async () => true), play: jest.fn(async () => 0), pause: jest.fn(async () => true),
    resume: jest.fn(async () => true), seek: jest.fn(async () => true), setSpeed: jest.fn(async () => true), stop: jest.fn(async () => true),
  };
  NativeModules.MalachiSecureAudio = native;
  permSpy = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  sendSpy = jest.spyOn(GM, 'sendGroupMedia').mockResolvedValue({ ok: true });
});
afterEach(() => { permSpy.mockRestore(); sendSpy.mockRestore(); delete NativeModules.MalachiSecureAudio; });

async function render(props = {}) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(GroupChatScreen, { group, contacts, palette, onBack() {}, onOpenDetail() {}, ...props }));
  });
  await renderer.act(async () => { await tick(); });
  return tree;
}
const listBg = (tree) => [].concat(tree.root.findAllByType(FlatList)[0].props.style).find((s) => s && s.backgroundColor)?.backgroundColor;
const byId = (tree, id) => tree.root.findAll((n) => n.props && n.props.testID === id && typeof n.props.onPress === 'function')[0];
const byLabel = (tree, label) => tree.root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
const press = async (node) => { await renderer.act(async () => { await node.props.onPress(); await tick(); await tick(); }); };

describe('Hintergrund', () => {
  test('eigenes Hintergrundbild erscheint auch im Gruppenchat, Liste ist dann durchsichtig', async () => {
    const tree = await render({ customBg: 'file:///daten/hintergrund.jpg' });
    const img = tree.root.findAll((n) => n.props && n.props.testID === 'group-custom-bg' && n.type === Image)[0];
    expect(img.props.source).toEqual({ uri: 'file:///daten/hintergrund.jpg' });
    expect(listBg(tree)).toBe('transparent');
    await renderer.act(async () => tree.unmount());
  });

  test('gewaehlte Hintergrundfarbe gilt auch im Gruppenchat; sonst die Farbe des Designs', async () => {
    let tree = await render({ palette: { ...palette, chatBgPreset: '#DCEFE4' } });
    expect(listBg(tree)).toBe('#DCEFE4');
    await renderer.act(async () => tree.unmount());
    tree = await render();
    expect(listBg(tree)).toBe('#F1ECE3');
    await renderer.act(async () => tree.unmount());
  });
});

describe('Sprachnachricht', () => {
  test('aufnehmen, anhalten (Vorschau), weiter aufnehmen, senden: beide Teile in einer Nachricht', async () => {
    const tree = await render();
    await press(byLabel(tree, 'Sprachnachricht aufnehmen'));
    expect(native.startRecording).toHaveBeenCalledTimes(1);
    await press(byId(tree, 'group-rec-pause'));
    expect(byId(tree, 'group-preview-send')).toBeTruthy();
    await press(byId(tree, 'group-preview-resume'));
    expect(native.startRecording).toHaveBeenCalledTimes(2);
    await press(byId(tree, 'group-rec-pause'));
    await press(byId(tree, 'group-preview-send'));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [gid, media] = sendSpy.mock.calls[0];
    expect(gid).toBe(GID);
    expect(media.kind).toBe('audio');
    expect(media.durationMs).toBe(2500);
    expect(Buffer.from(media.base64, 'base64').equals(Buffer.concat([A, B]))).toBe(true);
    await renderer.act(async () => tree.unmount());
  });

  test('Zurueck-Taste: Aufnahme -> Vorschau, Vorschau -> verworfen; nichts gesendet', async () => {
    const tree = await render();
    await press(byLabel(tree, 'Sprachnachricht aufnehmen'));
    await renderer.act(async () => { expect(BS.handleBack()).toBe(true); await tick(); await tick(); });
    expect(byId(tree, 'group-preview-send')).toBeTruthy();
    await renderer.act(async () => { expect(BS.handleBack()).toBe(true); await tick(); });
    expect(byId(tree, 'group-preview-send')).toBeFalsy();
    expect(BS.handleBack()).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    await renderer.act(async () => tree.unmount());
  });

  test('Verwerfen waehrend der Aufnahme und Verlassen geben das Mikrofon frei', async () => {
    const tree = await render();
    await press(byLabel(tree, 'Sprachnachricht aufnehmen'));
    await press(byId(tree, 'group-rec-discard'));
    expect(native.cancelRecording).toHaveBeenCalledTimes(1);
    await press(byLabel(tree, 'Sprachnachricht aufnehmen'));
    await renderer.act(async () => tree.unmount());
    expect(native.cancelRecording).toHaveBeenCalledTimes(2);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
