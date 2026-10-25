// "Profilbild bugt im Startbildschirm und im Menue" (Nutzer, 2026-10-25):
// Unter 'avatar' stand der Pfad einer Cache-Kopie der Bildauswahl
// (rn_image_picker_lib_temp_*), die der App-Start (cleanupSharedFileCache)
// nach zwei Minuten loescht - danach ein leerer Kreis, und RTCStore brach beim
// Profilversand ab (samt Senden der Warteschlange). Jetzt: OwnAvatar.js legt
// das Bild verschluesselt in MediaVault ab, Altbestand wird uebernommen.
jest.mock('react-native-fs', () => {
  const files = new Map();
  return {
    __files: files,
    DocumentDirectoryPath: '/mock/documents',
    CachesDirectoryPath: '/mock/caches',
    writeFile: async (p, d) => { files.set(p, d); },
    readFile: async (p, enc) => {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      const v = files.get(p);
      return enc === 'base64' && v.__raw ? Buffer.from(v.__raw).toString('base64') : v;
    },
    unlink: async (p) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    readDir: async (d) => [...files.keys()].filter((p) => p.startsWith(d + '/')).map((p) => ({ name: p.split('/').pop(), path: p, isFile: () => true })),
  };
});

const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const RNFS = require('react-native-fs');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const MV = require('../../MediaVault');
const OA = require('../../OwnAvatar');

const PICKED = Buffer.from('JPEG-BILD-INHALT ' + 'x'.repeat(200));
const PICKED_B64 = PICKED.toString('base64');
const PICKER_COPY = '/mock/caches/rn_image_picker_lib_temp_1234.jpg';
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const allStored = () => [
  ...[...RNFS.__files.values()].map((v) => (typeof v === 'string' ? v : '')),
];

async function freshStart() {
  // "App-Neustart": RAM-Zustand weg, Speicher bleibt.
  OA.resetOwnAvatarAfterWipe();
  MV.clearMediaCache();
}

beforeEach(async () => {
  await EncryptedStorage.clear();
  RNFS.__files.clear();
  OA.resetOwnAvatarAfterWipe();
  MV.clearMediaCache();
});

describe('Altbestand (Version 1.0: Pfad der Cache-Kopie unter "avatar")', () => {
  test('Kopie noch da: wird verschluesselt uebernommen, Klartext-Kopie und alter Verweis verschwinden', async () => {
    RNFS.__files.set(PICKER_COPY, { __raw: PICKED });
    await EncryptedStorage.setItem('avatar', 'file://' + PICKER_COPY);
    const uri = await OA.loadOwnAvatar();
    expect(uri).toBe('data:image/jpeg;base64,' + PICKED_B64);
    expect(await EncryptedStorage.getItem('avatar')).toBeNull();
    const ref = JSON.parse(await EncryptedStorage.getItem('avatar_ref'));
    expect(ref).toMatchObject({ mime: 'image/jpeg' });
    await tick();
    expect(RNFS.__files.has(PICKER_COPY)).toBe(false);          // Klartext weg
    // Abgelegt nur verschluesselt
    const vault = [...RNFS.__files.keys()].filter((p) => p.startsWith(MV.scopeDir(OA.PROFILE_SCOPE)));
    expect(vault).toHaveLength(1);
    expect(allStored().join('')).not.toContain(PICKED_B64.slice(0, 40));
    // Nach einem Neustart (der Start-Sweep haette die Kopie laengst geloescht)
    await freshStart();
    expect(await OA.loadOwnAvatar()).toBe('data:image/jpeg;base64,' + PICKED_B64);
  });

  test('Kopie schon vom Start-Sweep geloescht: kein toter Verweis mehr (Initialen statt leerem Kreis)', async () => {
    await EncryptedStorage.setItem('avatar', 'file://' + PICKER_COPY);
    expect(await OA.loadOwnAvatar()).toBeNull();
    expect(await EncryptedStorage.getItem('avatar')).toBeNull();
    expect(await EncryptedStorage.getItem('avatar_ref')).toBeNull();
  });

  test('Kopie da, aber gerade nicht lesbar: nichts loeschen, spaeter erneut versuchen', async () => {
    RNFS.__files.set(PICKER_COPY, { __raw: PICKED });
    const read = RNFS.readFile;
    RNFS.readFile = async () => { throw new Error('EIO'); };
    try {
      expect(await OA.loadOwnAvatar()).toBeNull();
    } finally { RNFS.readFile = read; }
    // Noch nicht verwendet - erst jetzt den Altbestand anlegen und erneut lesen
    await EncryptedStorage.setItem('avatar', 'file://' + PICKER_COPY);
    RNFS.readFile = async () => { throw new Error('EIO'); };
    try {
      expect(await OA.loadOwnAvatar()).toBeNull();
      expect(await EncryptedStorage.getItem('avatar')).toBe('file://' + PICKER_COPY);
      expect(RNFS.__files.has(PICKER_COPY)).toBe(true);
    } finally { RNFS.readFile = read; }
    expect(await OA.loadOwnAvatar()).toBe('data:image/jpeg;base64,' + PICKED_B64);
  });

  test('Start-Sweep laesst ein noch nicht uebernommenes altes Profilbild liegen', async () => {
    await EncryptedStorage.setItem('avatar', 'file://' + PICKER_COPY);
    expect(await OA.pendingLegacyAvatarPath()).toBe(PICKER_COPY);
    RNFS.__files.set(PICKER_COPY, { __raw: PICKED });
    await OA.loadOwnAvatar();   // erfolgreich uebernommen -> nichts mehr zu schonen
    expect(await OA.pendingLegacyAvatarPath()).toBeNull();
    await EncryptedStorage.setItem('avatar', 'data:image/jpeg;base64,QUJD');
    expect(await OA.pendingLegacyAvatarPath()).toBeNull();
    const fs = require('fs');
    const path = require('path');
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/const keepAvatar = await pendingLegacyAvatarPath\(\)/);
    expect(app).toMatch(/if \(keepAvatar && f\.path === keepAvatar\) continue;/);
  });

  test('aelteres data:-URI wird ebenfalls uebernommen', async () => {
    await EncryptedStorage.setItem('avatar', 'data:image/png;base64,' + PICKED_B64);
    expect(await OA.loadOwnAvatar()).toBe('data:image/png;base64,' + PICKED_B64);
    expect(await EncryptedStorage.getItem('avatar')).toBeNull();
    await freshStart();
    expect(await OA.loadOwnAvatar()).toBe('data:image/png;base64,' + PICKED_B64);
  });
});

describe('Neues Profilbild aus der Bildauswahl', () => {
  test('wird verschluesselt abgelegt, Klartext-Kopie sofort geloescht, Abonnenten (Kopfzeile, Einstellungen) informiert', async () => {
    RNFS.__files.set(PICKER_COPY, { __raw: PICKED });
    const seen = [];
    const off = OA.subscribeOwnAvatar((u) => seen.push(u));
    const uri = await OA.setOwnAvatarFromPicker({ uri: 'file://' + PICKER_COPY, base64: PICKED_B64, type: 'image/jpeg' });
    off();
    expect(uri).toBe('data:image/jpeg;base64,' + PICKED_B64);
    expect(seen).toEqual([uri]);
    await tick();
    expect(RNFS.__files.has(PICKER_COPY)).toBe(false);
    expect(allStored().join('')).not.toContain(PICKED_B64.slice(0, 40));
    expect(await EncryptedStorage.getItem('avatar')).toBeNull();
    await freshStart();
    expect(await OA.loadOwnAvatar()).toBe(uri);
  });

  test('Bild ersetzen: alte verschluesselte Datei wird entfernt', async () => {
    await OA.setOwnAvatarFromPicker({ base64: PICKED_B64, type: 'image/jpeg' });
    const second = Buffer.from('zweites bild').toString('base64');
    await OA.setOwnAvatarFromPicker({ base64: second, type: 'image/png' });
    const vault = [...RNFS.__files.keys()].filter((p) => p.startsWith(MV.scopeDir(OA.PROFILE_SCOPE)));
    expect(vault).toHaveLength(1);
    await freshStart();
    expect(await OA.loadOwnAvatar()).toBe('data:image/png;base64,' + second);
  });

  test('ohne Bildinhalt: nichts gespeichert, Kopie trotzdem weg', async () => {
    RNFS.__files.set(PICKER_COPY, { __raw: PICKED });
    expect(await OA.setOwnAvatarFromPicker({ uri: 'file://' + PICKER_COPY })).toBeNull();
    await tick();
    expect(RNFS.__files.has(PICKER_COPY)).toBe(false);
    expect(await EncryptedStorage.getItem('avatar_ref')).toBeNull();
  });

  test('Entfernen: Verweis und Datei weg, Abonnenten bekommen null', async () => {
    await OA.setOwnAvatarFromPicker({ base64: PICKED_B64, type: 'image/jpeg' });
    const seen = [];
    const off = OA.subscribeOwnAvatar((u) => seen.push(u));
    await OA.removeOwnAvatar();
    off();
    expect(seen).toEqual([null]);
    expect(await EncryptedStorage.getItem('avatar_ref')).toBeNull();
    expect([...RNFS.__files.keys()].filter((p) => p.startsWith(MV.scopeDir(OA.PROFILE_SCOPE)))).toHaveLength(0);
    expect(await OA.loadOwnAvatar()).toBeNull();
  });

  test('verschluesselte Datei fehlt: Verweis wird entfernt; Datei da aber nicht entschluesselbar: Verweis bleibt', async () => {
    await OA.setOwnAvatarFromPicker({ base64: PICKED_B64, type: 'image/jpeg' });
    const ref = JSON.parse(await EncryptedStorage.getItem('avatar_ref'));
    const path = `${MV.scopeDir(OA.PROFILE_SCOPE)}/${ref.mref}.enc`;
    // nicht entschluesselbar
    RNFS.__files.set(path, 'kaputt');
    await freshStart();
    expect(await OA.loadOwnAvatar()).toBeNull();
    expect(await EncryptedStorage.getItem('avatar_ref')).not.toBeNull();
    // Datei fehlt ganz
    RNFS.__files.delete(path);
    await freshStart();
    expect(await OA.loadOwnAvatar()).toBeNull();
    expect(await EncryptedStorage.getItem('avatar_ref')).toBeNull();
  });
});

describe('Profilversand (RTCStore)', () => {
  const SECRET = crypto.randomBytes(32).toString('base64');
  const CONTACT = { id: 'c_av2', name: 'Kev', role: 'initiator' };
  function conn() {
    return {
      transport: 'direct', keyExchangeDone: true, sharedSecret: SECRET, _closed: false,
      dataChannel: { readyState: 'open', send: jest.fn() }, pc: { iceConnectionState: 'connected' },
      pendingMsgs: [], close: jest.fn(), sendMessage: jest.fn(() => 'sent'),
    };
  }
  beforeEach(async () => {
    RTCStore.resetAll();
    await EncryptedStorage.setItem('contacts', JSON.stringify([CONTACT]));
    await EncryptedStorage.setItem('username', 'Dave');
    RTCStore.sharedSecrets.set(CONTACT.id, SECRET);
  });

  test('fehlende Cache-Kopie bricht den Profilversand nicht mehr ab - die Warteschlange wird gesendet', async () => {
    await EncryptedStorage.setItem('avatar', 'file://' + PICKER_COPY);   // Kopie existiert nicht mehr
    const c = conn();
    c._onReady = jest.fn(async () => {});
    RTCStore.setConnection(CONTACT.id, c);
    await c._onKeyExchange();
    // Vorher: RNFS.readFile warf -> catch -> _onReady (Warteschlange) nie aufgerufen.
    expect(c._onReady).toHaveBeenCalled();
    const sent = c.sendMessage.mock.calls.map((x) => JSON.parse(x[0]));
    expect(sent.find((m) => m.subtype === 'profile_name')).toMatchObject({ name: 'Dave' });
    expect(await EncryptedStorage.getItem('avatar')).toBeNull();   // toter Verweis entfernt
  });

  test('verschluesselt abgelegtes Profilbild wird an Kontakte gesendet', async () => {
    await OA.setOwnAvatarFromPicker({ base64: PICKED_B64, type: 'image/jpeg' });
    const c = conn();
    RTCStore.setConnection(CONTACT.id, c);
    // Gleicher Weg wie beim Verbindungsaufbau (der nutzt einen dynamischen
    // Import, den Jest nicht ausfuehrt) - hier ueber die Anforderung.
    c.onMessage({ type: 'system', subtype: 'profile_avatar_request' });
    await tick(100);
    expect(c.dataChannel.send.mock.calls.length).toBeGreaterThan(0);
    const hs = c.sendMessage.mock.calls.map((x) => JSON.parse(x[0])).find((m) => m.subtype === 'handshake');
    expect(hs).toMatchObject({ hasAvatar: true, name: 'Dave' });
  });
});

test('statisch: Bildauswahl liefert Base64 und verkleinert; kein Cache-Pfad mehr unter "avatar"; Sweep erst nach der Uebernahme', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/launchImageLibrary\(\{ mediaType:'photo', quality:0\.8, includeBase64:true, maxWidth:512, maxHeight:512 \}/);
  expect(app).not.toMatch(/AsyncStorage\.setItem\('avatar'/);
  expect(app).not.toMatch(/AsyncStorage\.getItem\('avatar'\)/);
  expect(app).toMatch(/async function cleanupSharedFileCache\(\) \{\s*\/\/[^\n]*\n[^\n]*\n[^\n]*\n\s*await loadOwnAvatar\(\)/);
  const rtc = fs.readFileSync(path.join(__dirname, '..', '..', 'RTCStore.js'), 'utf8');
  expect(rtc).not.toMatch(/EncryptedStorage\.getItem\('avatar'\)/);
});
