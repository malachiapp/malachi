// Timer-Nachrichten ("Nach dem Lesen", 1 h / 24 h / 7 Tage) - Fund vom
// 28.10.2026 (Demo-App 1.2.0): Die Einmal-Nachricht verschwand nach dem Lesen
// korrekt aus dem Chat, ihr Text blieb aber dauerhaft als Vorschau in der
// Chatliste stehen (im PIN-Tresor versiegelt, nach dem Entsperren lesbar).
// Geprueft wird:
//   - Vorschau bei Timer: nie der Inhalt, nur ein neutraler Hinweis - fuer
//     eingehende Nachrichten (offener Chat UND Badge-Pfad bei geschlossenem
//     Chat) und eigene (Text und Standort).
//   - Abgelaufene Timer-Nachrichten verschwinden nach dem Entsperren aus dem
//     gespeicherten Verlauf, auch wenn der Chat nie wieder geoeffnet wird -
//     mit und ohne PIN-Tresor, gesperrt ueber das Tresor-Journal.
//   - Der Timer-Dialog schickt ein echtes timer-Signal, der offene Chat
//     uebernimmt es (zwei Geraete: timer.peerSync.test.js).
const fs = require('fs');
const path = require('path');
const React = require('react');
const renderer = require('react-test-renderer');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKey } = require('./helpers/pinVaultTestHelpers');
const { NativeModules, TextInput, TouchableOpacity, Text } = require('react-native');
const pinKey = fakePinKey();
NativeModules.MalachiPinKey = pinKey;

const mockFiles = new Map();
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  DocumentDirectoryPath: '/docs',
  writeFile: async (p, d) => { mockFiles.set(p, d); },
  readFile: async (p) => { if (!mockFiles.has(p)) throw new Error('ENOENT ' + p); return mockFiles.get(p); },
  unlink: async (p) => { mockFiles.delete(p); },
  exists: async (p) => mockFiles.has(p),
  mkdir: async () => {},
  readDir: async () => [],
}));

const ES = require('react-native-encrypted-storage').default;
const PV = require('../../PinVault');
const BG = require('../../BackgroundSync');
const RTCStoreModule = require('../../RTCStore');
const RTCStore = RTCStoreModule.default;
const { timerPreview } = RTCStoreModule;
const { t } = require('../../i18n');
const { ChatScreen, afterVaultUnlock } = require('../../App');
const { SafeAreaProvider } = require('react-native-safe-area-context');

const PIN = '482913';
const SECRET_TEXT = 'Treffpunkt Hafen 22 Uhr';
const READ_ONCE = t('preview.readOnce');
const TIMED = t('preview.timed');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let logSpy;
let warnSpy;
beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  delete global.incrementBadge;
  delete global.showMalachiNotification;
});
beforeEach(async () => {
  PV._resetPinVaultForTests();
  RTCStore.resetAll();
  await ES.clear();
  mockFiles.clear();
});

describe('timerPreview', () => {
  test('Timer-Modi ergeben einen neutralen Hinweis, sonst null', () => {
    expect(READ_ONCE).toBe('🔥 Einmal lesbare Nachricht');
    expect(TIMED).toBe('⏱ Nachricht mit Timer');
    expect(timerPreview('read')).toBe(READ_ONCE);
    for (const m of ['1h', '24h', '7d']) expect(timerPreview(m)).toBe(TIMED);
    for (const m of ['off', undefined, null, '', 'irgendwas']) expect(timerPreview(m)).toBeNull();
  });

  test('neue Texte in allen Sprachen vorhanden und ohne Platzhalter', () => {
    const I = require('../../i18n');
    for (const code of I.LANGUAGE_CODES) {
      const tbl = I.getTable(code);
      expect(tbl['preview.readOnce']).toMatch(/^🔥 \S/);
      expect(tbl['preview.timed']).toMatch(/^⏱ \S/);
    }
  });
});

describe('Badge-Pfad (Chat geschlossen, RTCStore)', () => {
  const CHAT = 'c_badge';
  let previews;
  beforeEach(() => {
    previews = [];
    global.showMalachiNotification = jest.fn();
    global.incrementBadge = jest.fn((chatId, preview) => { previews.push([chatId, preview]); });
  });

  async function receive(msg, chatId = CHAT) {
    const durable = RTCStore._route(chatId, { time: Date.now(), ...msg });
    await durable;
    await RTCStore._badgeChain;
  }

  test.each([
    ['read', READ_ONCE], ['1h', TIMED], ['24h', TIMED], ['7d', TIMED],
  ])('expireMode %s: Hinweis statt Inhalt', async (mode, label) => {
    await receive({ type: 'text', text: SECRET_TEXT, msgId: 'm_' + mode, expireMode: mode });
    expect(previews).toEqual([[CHAT, label]]);
    expect(JSON.stringify(previews)).not.toContain('Hafen');
  });

  test('ohne Timer (off) bleibt die Vorschau wie bisher der Text', async () => {
    await receive({ type: 'text', text: 'Hallo ohne Timer', msgId: 'o1', expireMode: 'off' });
    await receive({ type: 'text', text: 'Hallo Web-App', msgId: 'o2' });
    expect(previews).toEqual([[CHAT, 'Hallo ohne Timer'], [CHAT, 'Hallo Web-App']]);
  });

  test('Nachricht ohne eigenen Timer (Standort 1.2.0, Web-App): es gilt der Timer des Chats', async () => {
    await ES.setItem('timer_' + CHAT, 'read');
    await receive({ type: 'text', text: SECRET_TEXT, msgId: 'w1' });
    await receive({ type: 'text', text: '📍 Standort', isLocation: true, lat: 53.5, lng: 9.9, msgId: 'l1' });
    expect(previews).toEqual([[CHAT, READ_ONCE], [CHAT, READ_ONCE]]);
    // Ein ausdrueckliches 'off' der Nachricht geht vor (wie in ChatScreen).
    await receive({ type: 'text', text: 'ausdruecklich ohne', msgId: 'w2', expireMode: 'off' });
    expect(previews[2]).toEqual([CHAT, 'ausdruecklich ohne']);
  });

  test('aelteres JSON-im-Text-Format mit Timer: ebenfalls kein Inhalt', async () => {
    await receive({ type: 'text', text: JSON.stringify({ text: SECRET_TEXT, expireMode: '24h' }), msgId: 'j1' });
    expect(previews).toEqual([[CHAT, TIMED]]);
  });

  test('Secret Chat und Medien unveraendert', async () => {
    await receive({ type: 'text', text: SECRET_TEXT, msgId: 's1', secret: true, expireMode: 'read' });
    await receive({ type: 'image_complete', base64: 'QUJD', mimeType: 'image/jpeg', msgId: 'i1' });
    expect(previews).toEqual([[CHAT, ''], [CHAT, t('preview.image')]]);
  });

  test('Reihenfolge bleibt erhalten, auch wenn erst der Chat-Timer gelesen werden muss', async () => {
    await ES.setItem('timer_' + CHAT, '7d');
    RTCStore._route(CHAT, { type: 'text', text: 'erste', msgId: 'r1', time: Date.now() });
    RTCStore._route(CHAT, { type: 'text', text: 'zweite', msgId: 'r2', time: Date.now(), expireMode: 'off' });
    await tick(20);
    await RTCStore._badgeChain;
    expect(previews).toEqual([[CHAT, TIMED], [CHAT, 'zweite']]);
  });

  test('der persistente Badge-Ersatz (index.js) bekommt dieselbe Vorschau von RTCStore', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    expect(idx).toMatch(/global\.incrementBadge = \(chatId, preview\) =>/);
    const rtc = fs.readFileSync(path.join(__dirname, '../../RTCStore.js'), 'utf8');
    expect(rtc).not.toMatch(/incrementBadge\(chatId, previewForMessage\(msg\)\)/);
    expect(rtc).toMatch(/badgePreview\(chatId, msg\)/);
  });
});

describe('Chat geoeffnet (ChatScreen)', () => {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  let tree;
  afterEach(async () => {
    if (tree) await renderer.act(async () => { tree.unmount(); });
    tree = null;
  });

  async function openChat(chat, onLastMessage) {
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
        React.createElement(ChatScreen, { chat, messages: [], onBack() {}, backInterceptRef: { current: null }, onCall() {},
          rtc: null, fontSize: 15, customBg: null, onRename() {}, onDelete() {}, onRemoteDelete() {}, onWipe() {}, onLastMessage })));
    });
    await renderer.act(async () => { for (let i = 0; i < 5; i++) await tick(0); });
  }

  async function typeAndSend(text) {
    const input = tree.root.findAllByType(TextInput).find((n) => n.props.placeholder === t('chat.placeholder'));
    await renderer.act(async () => { input.props.onChangeText(text); });
    const send = tree.root.findAllByType(TouchableOpacity).find((n) => React.isValidElement(n.props.children)
      && n.props.children.type === Text && n.props.children.props.children === '→');
    await renderer.act(async () => { send.props.onPress(); await tick(0); });
  }

  // Text antippen: naechster Vorfahr mit onPress (Kopfzeile, Menue, Dialog).
  async function pressText(label) {
    const node = tree.root.findAllByType(Text).find((n) => n.props.children === label);
    if (!node) throw new Error('Nicht gefunden: ' + label);
    let p = node;
    while (p && typeof p.props.onPress !== 'function') p = p.parent;
    await renderer.act(async () => { p.props.onPress(); await tick(0); });
  }

  async function waitFor(fn, what) {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return;
      await renderer.act(async () => { await tick(5); });
    }
    throw new Error('Zeitueberschreitung: ' + what);
  }

  // Eingereihte Eintraege samt (lokal versiegeltem) Inhalt.
  async function queued(chatId) {
    const MC = require('../../MessageCrypto');
    const q = JSON.parse((await ES.getItem('queue_' + chatId)) || '[]');
    return q.map((i) => ({ msgId: i.msgId, subtype: i.subtype,
      payload: JSON.parse(MC.decryptMsg(mockFiles.get(i.path), i.k, 'queue')) }));
  }

  const shown = (fn) => fn.mock.calls.map((c) => c[1]);

  test('eingehende Einmal-Nachricht: Vorschau neutral, eigene Antwort danach ebenfalls', async () => {
    const chat = { id: 'c_open', name: 'Tim' };
    const onLastMessage = jest.fn();
    await openChat(chat, onLastMessage);
    const listener = RTCStore.listeners.get(chat.id);
    expect(typeof listener).toBe('function');
    await renderer.act(async () => {
      listener({ type: 'text', text: SECRET_TEXT, expireMode: 'read', msgId: 'in1', time: Date.now() });
    });
    expect(onLastMessage).toHaveBeenLastCalledWith(chat.id, READ_ONCE);
    // Der Chat uebernimmt den Timer der Gegenseite - die eigene Antwort ist
    // damit ebenfalls einmalig lesbar und landet nicht in der Vorschau.
    await renderer.act(async () => { await tick(5); });
    expect(await ES.getItem('timer_' + chat.id)).toBe('read');
    await typeAndSend('Antwort mit Adresse Elbchaussee 1');
    expect(onLastMessage).toHaveBeenLastCalledWith(chat.id, READ_ONCE);
    expect(shown(onLastMessage).join('|')).not.toMatch(/Hafen|Elbchaussee/);
  });

  test('eigene Nachricht mit eingestelltem 24-h-Timer: Hinweis statt Inhalt', async () => {
    const chat = { id: 'c_own', name: 'Ute' };
    await ES.setItem('timer_' + chat.id, '24h');
    const onLastMessage = jest.fn();
    await openChat(chat, onLastMessage);
    await typeAndSend(SECRET_TEXT);
    expect(shown(onLastMessage)).toEqual([TIMED]);
  });

  test('ohne Timer bleibt alles wie bisher (Text als Vorschau)', async () => {
    const chat = { id: 'c_plain', name: 'Ole' };
    const onLastMessage = jest.fn();
    await openChat(chat, onLastMessage);
    await typeAndSend('Bis morgen');
    await renderer.act(async () => {
      RTCStore.listeners.get(chat.id)({ type: 'text', text: 'Gern!', expireMode: 'off', msgId: 'in2', time: Date.now() });
    });
    expect(shown(onLastMessage)).toEqual(['Bis morgen', 'Gern!']);
  });

  // Nebenfund 1 (28.10.2026): Der Dialog schickte bis 1.2.0 ein secret_start
  // ohne mins, das die Gegenseite verwarf - ihre Antworten blieben dauerhaft.
  test('Timer-Dialog: timer-Signal ueber die Warteschlange statt secret_start, aelteres ungesendetes wird ersetzt', async () => {
    const chat = { id: 'c_dlg', name: 'Dora' };
    await ES.setItem('shared_secret_' + chat.id, 'dGVzdA==');
    const direct = jest.spyOn(RTCStore, 'sendMessage');
    await openChat(chat, jest.fn());

    await pressText(chat.name);
    await pressText(t('chatInfo.timer'));
    await pressText(t('timer.read'));
    await waitFor(async () => (await queued(chat.id)).length === 1, 'erstes Signal eingereiht');
    const ts1 = Number(await ES.getItem('timer_ts_' + chat.id));
    expect(await ES.getItem('timer_' + chat.id)).toBe('read');
    expect(await queued(chat.id)).toEqual([{ msgId: 'timer_' + ts1, subtype: 'timer',
      payload: { type: 'system', subtype: 'timer', mode: 'read', ts: ts1 } }]);

    await pressText(chat.name);
    await pressText(t('chatInfo.timerActive'));
    await pressText(t('timer.24h'));
    await waitFor(async () => (await queued(chat.id))[0]?.payload.mode === '24h', 'Signal ersetzt');
    const ts2 = Number(await ES.getItem('timer_ts_' + chat.id));
    expect(ts2).toBeGreaterThan(ts1);
    expect(await queued(chat.id)).toEqual([{ msgId: 'timer_' + ts2, subtype: 'timer',
      payload: { type: 'system', subtype: 'timer', mode: '24h', ts: ts2 } }]);
    expect(JSON.stringify(direct.mock.calls)).not.toContain('secret_start');
    direct.mockRestore();
  });

  test('Timer-Signal der Gegenseite bei offenem Chat: uebernommen; aelteres oder ungueltiges danach ignoriert', async () => {
    const chat = { id: 'c_peer', name: 'Pia' };
    const onLastMessage = jest.fn();
    await openChat(chat, onLastMessage);
    const listener = RTCStore.listeners.get(chat.id);
    const now = Date.now();
    await renderer.act(async () => { listener({ type: 'system', subtype: 'timer', mode: 'read', ts: now }); await tick(5); });
    expect(await ES.getItem('timer_' + chat.id)).toBe('read');
    await renderer.act(async () => {
      listener({ type: 'system', subtype: 'timer', mode: 'off', ts: now - 1 });
      listener({ type: 'system', subtype: 'timer', mode: '1y', ts: now + 5 });
      listener({ type: 'system', subtype: 'timer', mode: 'off' });
      await tick(5);
    });
    expect(await ES.getItem('timer_' + chat.id)).toBe('read');
    // Der offene Chat hat den Timer uebernommen: die eigene Antwort ist
    // ebenfalls einmal lesbar.
    await typeAndSend('Antwort mit Adresse Elbchaussee 1');
    expect(shown(onLastMessage)).toEqual([READ_ONCE]);
  });

  test('Standort: Timer gilt auch hier (Vorschau, Ablauf im eigenen Verlauf, Umschlag an die Gegenseite)', () => {
    const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
    const start = app.indexOf('const sendLocationMessage = (lat, lng) => {');
    const send = app.slice(start, app.indexOf('const sendLocation = async () => {', start));
    expect(send).toMatch(/const mode = expireModeRef\.current;/);
    expect(send).toMatch(/expireAt: expireModeToExpireAt\(mode\),/);
    expect(send).toMatch(/onLastMessage\?\.\(chat\?\.id, timerPreview\(mode\) \|\| t\('preview\.location'\)\)/);
    expect(send).toMatch(/expireMode: mode,/);
  });
});

describe('Abgelaufene Timer-Nachrichten verschwinden aus dem gespeicherten Verlauf', () => {
  const NOW = Date.now();
  const MREF = 'b'.repeat(32);
  const HISTORY = [
    { id: 'a', text: 'bleibt fuer immer', mine: false, time: '10:00' },
    { id: 'b', text: 'Code 4711 (abgelaufen)', mine: true, time: '10:01', expireAt: NOW - 1000 },
    { id: 'c', text: 'noch gueltig', mine: false, time: '10:02', expireAt: NOW + 3600000 },
    { id: 'd', text: 'einmal lesbar', mine: false, time: '10:03', expireAt: 'read' },
    { id: 'e', type: 'image', mref: MREF, mk: 'S0VZ', mine: false, time: '10:04', expireAt: NOW - 5 },
  ];
  const ids = (raw) => JSON.parse(raw).map((m) => m.id);
  const mediaPath = '/docs/media/c_one/' + MREF + '.enc';

  async function seed(setItem) {
    await ES.setItem('contacts', JSON.stringify([{ id: 'c_one', name: 'Eins' }, { id: 'c_two', name: 'Zwei' }, { name: 'ohne id' }]));
    await setItem('chat_c_one', JSON.stringify(HISTORY));
    mockFiles.set(mediaPath, 'verschluesseltes Bild');
  }

  test('ohne PIN-Tresor', async () => {
    await seed((k, v) => ES.setItem(k, v));
    await BG.sweepExpiredChats(NOW);
    expect(ids(await ES.getItem('chat_c_one'))).toEqual(['a', 'c']);
    expect(await ES.getItem('chat_c_two')).toBeNull();
    expect(mockFiles.has(mediaPath)).toBe(false);
  });

  test('PIN-Tresor entsperrt: bereinigt und weiter verschluesselt', async () => {
    await PV.create(PIN);
    await seed((k, v) => PV.setItem(k, v));
    await BG.sweepExpiredChats(NOW);
    expect(ids(await PV.getItem('chat_c_one'))).toEqual(['a', 'c']);
    const raw = await ES.getItem('chat_c_one');
    expect(raw.startsWith('pv1:')).toBe(true);
    expect(raw).not.toContain('4711');
  });

  test('PIN-Tresor gesperrt: landet im Journal, wirkt beim Entsperren', async () => {
    await PV.create(PIN);
    await seed((k, v) => PV.setItem(k, v));
    PV.lock();
    await expect(BG.sweepExpiredChats(NOW)).resolves.toBeUndefined();
    expect(await ES.getItem(PV.JOURNAL_PREFIX + 'chat_c_one')).toBeTruthy();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(ids(await PV.getItem('chat_c_one'))).toEqual(['a', 'c']);
  });

  test('laeuft nach jedem Entsperren (afterVaultUnlock), auch wenn der Chat nie geoeffnet wird', async () => {
    await PV.create(PIN);
    await ES.setItem('pin_vault_migrated', '1');
    await seed((k, v) => PV.setItem(k, v));
    await afterVaultUnlock();
    expect(ids(await PV.getItem('chat_c_one'))).toEqual(['a', 'c']);
  });

  test('gleiche Ablauf-Regel wie ChatScreen beim Laden/Speichern', () => {
    const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
    const rule = /if \(!m\.expireAt\) return true;\s*if \(m\.expireAt === 'read'\) return false;\s*return m\.expireAt > now;/g;
    expect(app.match(rule)).toHaveLength(2);
  });
});
