// Update auf den PIN-Tresor (Audit 2026-10-25 E1) - der wichtigste Pfad fuer
// alle, die 1.0 installiert haben: Nach dem Update liegen PIN, Notfall-PIN,
// Verlaeufe, Vorschautexte und Empfangs-Ablage noch im alten Format vor. Beim
// ersten Entsperren mit der ALTEN PIN (echter Sperrbildschirm) entsteht der
// Tresor; danach wird der Altbestand verschluesselt (afterVaultUnlock).
// Muss gelten: kein einziger Verlauf geht verloren oder aendert sich, nichts
// davon liegt danach noch im Klartext, PIN und Notfall-PIN funktionieren
// weiter, auch nach einem Neustart.
const React = require('react');
const renderer = require('react-test-renderer');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKey } = require('./helpers/pinVaultTestHelpers');
const { NativeModules, TouchableOpacity, Text } = require('react-native');
const pinKey = fakePinKey();
NativeModules.MalachiPinKey = pinKey;

jest.mock('react-native-biometrics', () => ({
  __esModule: true,
  default: class {
    async isSensorAvailable() { return { available: false }; }
    async simplePrompt() { return { success: false }; }
  },
}));
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
const RTCStore = require('../../RTCStore').default;
const { encryptMsg } = require('../../MessageCrypto');
const { LockScreen, afterVaultUnlock } = require('../../App');

const OLD_PIN = '135790';
const OLD_DURESS = '975310';
const MID = (c) => 'm_' + c.repeat(32);
const GID = 'g_' + '1'.repeat(24);
const CHAT_BOB = JSON.stringify([
  { id: '1760000000001', text: 'Hi Bob, Schluessel liegt unter der Matte', mine: true, time: '10:00', status: 'delivered' },
  { id: '1760000000002', type: 'audio', mine: false, mref: 'a'.repeat(32), mk: 'S0VZ', durationMs: 4000, time: '10:01' },
]);
const CHAT_GROUP = JSON.stringify([{ id: 'x1', from: MID('b'), mine: false, text: 'Familienrat Sonntag', time: 1760000000400 }]);

async function seed10() {
  await ES.clear();
  mockFiles.clear();
  await ES.setItem('app_pin', OLD_PIN);
  await ES.setItem('duress_pin', OLD_DURESS);
  await ES.setItem('pin_length', '6');
  await ES.setItem('username', 'Alice');
  await ES.setItem('contacts', JSON.stringify([
    { id: 'c_bob', name: 'Bob', last: 'Bis morgen am Bahnhof', unread: 1 },
    { id: 'c_carol', name: 'Carol', last: '' },
  ]));
  await ES.setItem('groups', JSON.stringify([{ v: 1, groupId: GID, name: 'Familie', members: [], last: 'Bob: Familienrat Sonntag', rev: 1 }]));
  await ES.setItem('chat_c_bob', CHAT_BOB);
  await ES.setItem('gchat_' + GID, CHAT_GROUP);
  // Empfangs-Ablage aus 1.0: Datei + Schluessel im Klartext-Index
  const k = Buffer.alloc(32, 7).toString('base64');
  const enc = await encryptMsg(JSON.stringify({ type: 'text', text: 'Noch ungelesen: ruf mich an', msgId: 'u1' }), k, 'inbox');
  mockFiles.set('/docs/inbox_aa.enc', enc);
  await ES.setItem('rx_inbox', JSON.stringify([{ id: 'aa', chatId: 'c_carol', path: '/docs/inbox_aa.enc', k, at: 1 }]));
}

const dump = () => [...ES.__store.entries()].map(([key, v]) => key + '=' + v).join('\n');

async function renderLock(props) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(LockScreen, props)); });
  await renderer.act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  return tree;
}
async function typePin(tree, pin) {
  for (const d of pin) {
    const key = tree.root.findAllByType(TouchableOpacity).find((n) => n.findAllByType(Text).some((tx) => tx.props.children === d));
    await renderer.act(async () => { key.props.onPress(); });
  }
  // 150-ms-Pause im Sperrbildschirm + Ableitung abwarten
  await renderer.act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

beforeEach(async () => {
  PV._resetPinVaultForTests();
  RTCStore.resetAll?.();
  await seed10();
});

test('Erstes Entsperren mit der alten PIN: Tresor entsteht, alles bleibt lesbar, nichts mehr im Klartext', async () => {
  const onUnlock = jest.fn();
  const tree = await renderLock({ onUnlock, onWipe: jest.fn() });
  await typePin(tree, OLD_PIN);
  expect(onUnlock).toHaveBeenCalledTimes(1);
  expect(PV.isUnlocked()).toBe(true);
  expect(await ES.getItem('app_pin')).toBeNull();
  expect(await ES.getItem('duress_pin')).toBeNull();
  await afterVaultUnlock();
  expect(await ES.getItem('pin_vault_migrated')).toBe('1');

  // Inhalte identisch
  expect(await PV.getItem('chat_c_bob')).toBe(CHAT_BOB);
  expect(await PV.getItem('gchat_' + GID)).toBe(CHAT_GROUP);
  const contacts = JSON.parse(await ES.getItem('contacts'));
  expect(contacts.map((c) => c.name)).toEqual(['Bob', 'Carol']);
  expect(contacts[0].unread).toBe(1);
  expect(PV.previewText(contacts[0].last)).toBe('Bis morgen am Bahnhof');
  expect(contacts[1].last).toBe('');
  expect(PV.previewText(JSON.parse(await ES.getItem('groups'))[0].last)).toBe('Bob: Familienrat Sonntag');
  // Empfangs-Ablage: Schluessel versiegelt, Nachricht weiter abholbar
  const inbox = JSON.parse(await ES.getItem('rx_inbox'));
  expect(inbox[0].ks).toBeTruthy();
  expect(inbox[0].k).toBeUndefined();
  const waiting = await RTCStore.takeBuffered('c_carol');
  expect(waiting.map((m) => m.text)).toEqual(['Noch ungelesen: ruf mich an']);

  // Nichts mehr im Klartext (weder Inhalte noch PINs)
  const all = dump();
  for (const s of ['Matte', 'Familienrat', 'Bahnhof', OLD_PIN, OLD_DURESS]) expect(all).not.toContain(s);
});

test('Nach dem Neustart: alte PIN oeffnet, Notfall-PIN loescht, falsche PIN zaehlt als Fehlversuch', async () => {
  let tree = await renderLock({ onUnlock: jest.fn(), onWipe: jest.fn() });
  await typePin(tree, OLD_PIN);
  await afterVaultUnlock();
  PV._resetPinVaultForTests();            // Prozess beendet

  const onUnlock = jest.fn();
  tree = await renderLock({ onUnlock, onWipe: jest.fn() });
  await typePin(tree, '000000');
  expect(onUnlock).not.toHaveBeenCalled();
  expect(await ES.getItem('pin_attempts')).toBe('1');
  await typePin(tree, OLD_PIN);
  expect(onUnlock).toHaveBeenCalledTimes(1);
  expect(await ES.getItem('pin_attempts')).toBeNull();
  expect(await PV.getItem('chat_c_bob')).toBe(CHAT_BOB);

  // Notfall-PIN (aus 1.0 uebernommen) wird weiter erkannt
  PV.lock();
  expect((await PV.unlockWithPin(OLD_DURESS)).duress).toBe(true);
});

// Notfall-PIN ueber den ECHTEN Sperrbildschirm bis zum Loeschen - mit der
// aus 1.0 uebernommenen und mit einer nach dem Update neu gesetzten.
async function duressWipesEverything(duress) {
  PV._resetPinVaultForTests();            // Neustart, Tresor gesperrt
  pinKey.destroyKey.mockClear();
  const onUnlock = jest.fn();
  const onWipe = jest.fn();
  const tree = await renderLock({ onUnlock, onWipe });
  await typePin(tree, duress);
  // Wipe laeuft im Hintergrund (Tor/Siegel mit Zeitgrenzen) - abwarten.
  for (let i = 0; i < 100 && !onWipe.mock.calls.length; i++) {
    await renderer.act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  }
  expect(onWipe).toHaveBeenCalledTimes(1);
  expect(onUnlock).not.toHaveBeenCalled();
  // Kein Shake, keine Fehlermeldung: sieht aus wie ein normales Entsperren.
  expect(JSON.stringify(tree.toJSON())).not.toMatch(/falsch|wrong|Versuch/i);
  expect(pinKey.destroyKey).toHaveBeenCalled();        // Chip-Schluessel vernichtet
  expect(await ES.getItem(PV.RECORD_KEY)).toBeNull();
  expect(await ES.getItem('chat_c_bob')).toBeNull();
  expect(await ES.getItem('contacts')).toBeNull();
  expect(await ES.getItem('pin_attempts')).toBeNull();
  expect(await PV.vaultState()).toBe('absent');
}

test('Notfall-PIN aus 1.0: nach dem Update am Sperrbildschirm eingegeben, wird alles geloescht', async () => {
  const tree = await renderLock({ onUnlock: jest.fn(), onWipe: jest.fn() });
  await typePin(tree, OLD_PIN);
  await afterVaultUnlock();
  await duressWipesEverything(OLD_DURESS);
}, 30000);

test('Notfall-PIN nach dem Update neu gesetzt (Einstellungen): loescht ebenfalls alles', async () => {
  await ES.removeItem('duress_pin');
  const tree = await renderLock({ onUnlock: jest.fn(), onWipe: jest.fn() });
  await typePin(tree, OLD_PIN);
  await afterVaultUnlock();
  expect(await PV.setDuressPin('246802')).toBe('ok');
  await duressWipesEverything('246802');
}, 30000);

test('Scheitert das Anlegen des Tresors (kein Chip), bleibt alles beim Alten - Entsperren klappt trotzdem', async () => {
  pinKey.createKey.mockImplementationOnce(async () => { throw new Error('kein Keystore'); });
  const onUnlock = jest.fn();
  const tree = await renderLock({ onUnlock, onWipe: jest.fn() });
  await typePin(tree, OLD_PIN);
  expect(onUnlock).toHaveBeenCalledTimes(1);
  expect(await ES.getItem('app_pin')).toBe(OLD_PIN);
  expect(await ES.getItem('chat_c_bob')).toBe(CHAT_BOB);
  expect(await PV.vaultState()).toBe('absent');
});

test('Neuinstallation: PIN festlegen legt den Tresor an, ohne die PIN zu speichern', async () => {
  await ES.clear();
  const onUnlock = jest.fn();
  const tree = await renderLock({ onUnlock, onWipe: jest.fn() });
  await typePin(tree, '112233');   // festlegen
  await typePin(tree, '112233');   // bestaetigen
  expect(onUnlock).toHaveBeenCalledTimes(1);
  expect(await PV.vaultState()).toBe('present');
  expect(await ES.getItem('app_pin')).toBeNull();
  expect(dump()).not.toContain('112233');
});
