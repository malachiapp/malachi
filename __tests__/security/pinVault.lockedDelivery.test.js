// PIN-Tresor, Ende zu Ende (Audit 2026-10-25 E1): Bobs App ist gesperrt
// (Tresorschluessel nicht im Speicher), waehrend Alice ihm schreibt - 1:1 und
// in einer Gruppe. Bobs Speicher darf danach keinen dieser Inhalte im
// Klartext enthalten; nach einem Neustart und dem Entsperren muss alles da
// sein (Empfangs-Ablage, Gruppenverlauf, Vorschau).
// Harness wie groups.intro.test.js: echte Verschluesselung, Warteschlange,
// Bestaetigungen; Kanaele im Speicher, "Chip" durch eine Attrappe ersetzt.
const crypto = require('crypto');

jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: async (k, v) => { store.set(k, String(v)); },
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      removeItem: async (k) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});
jest.mock('react-native-fs', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockFiles = global.__mockFiles || {};
  const files = (global.__mockFiles[dev] = global.__mockFiles[dev] || new Map());
  return {
    __files: files,
    DocumentDirectoryPath: '/mock/' + dev,
    CachesDirectoryPath: '/mock/caches/' + dev,
    writeFile: async (p, d) => { files.set(p, d); },
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    // Ordner: alles darunter (wie RNFS.unlink auf einen Ordner).
    unlink: async (p) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    readDir: async (d) => [...files.keys()]
      .filter((p) => !d || (p.startsWith(d + '/') && !p.slice(d.length + 1).includes('/')))
      .map((p) => ({ name: p.split('/').pop(), path: p, isFile: () => true })),
  };
});

const NAMES = { alice: 'Alice', bob: 'Bob', carol: 'Carol' };
const ID = { alice: 'c_alice', bob: 'c_bob', carol: 'c_carol' }; // so heisst X auf den anderen Geraeten
const PAIR_SECRETS = {};
function pairSecret(a, b) {
  const k = [a, b].sort().join('|');
  if (!PAIR_SECRETS[k]) PAIR_SECRETS[k] = crypto.randomBytes(32).toString('base64');
  return PAIR_SECRETS[k];
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('Zeitueberschreitung beim Warten auf: ' + (what || fn.toString().slice(0, 160)));
    await tick(10);
  }
}

const openRtcs = [];
const devices = [];

function loadDevice(name, peers) {
  global.__mockDevice = name;
  let dev;
  jest.isolateModules(() => {
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    const { NativeModules } = require('react-native');
    global.__pinKeys = global.__pinKeys || {};
    if (!global.__pinKeys[name]) global.__pinKeys[name] = require('./helpers/pinVaultTestHelpers').fakePinKey();
    NativeModules.MalachiPinKey = global.__pinKeys[name];   // "Chip" des Geraets bleibt ueber Neustarts
    dev = {
      name,
      peers,
      RTCStore: require('../../RTCStore').default,
      BG: require('../../BackgroundSync'),
      GM: require('../../GroupMessaging'),
      MV: require('../../MediaVault'),
      WebRTCManager: require('../../WebRTCManager').WebRTCManager,
      ES: require('react-native-encrypted-storage').default,
      RNFS: require('react-native-fs'),
      PV: require('../../PinVault'),
    };

  });
  global.__mockDevice = undefined;
  // PinVault liest das native Modul erst beim Aufruf - nach isolateModules
  // landet das im Haupt-Registry von 'react-native'. Nur EIN Geraet je Test
  // richtet einen Tresor ein (Bob), dessen "Chip" gilt dort.
  if (name === 'bob') require('react-native').NativeModules.MalachiPinKey = global.__pinKeys[name];
  devices.push(dev);
  return dev;
}

// "App-Start": Kontakte (nur beim ersten Mal), Secrets laden.
async function boot(name, peers) {
  const dev = loadDevice(name, peers);
  if (!(await dev.ES.getItem('contacts'))) {
    await dev.ES.setItem('contacts', JSON.stringify(peers.map((p) => ({ id: ID[p], name: NAMES[p], theirName: NAMES[p] }))));
    await dev.ES.setItem('username', NAMES[name]);
    for (const p of peers) await dev.ES.setItem('shared_secret_' + ID[p], pairSecret(name, p));
  }
  for (const p of peers) {
    dev.RTCStore.sharedSecrets.set(ID[p], pairSecret(name, p));
    await dev.BG.loadPreviousSecret(ID[p]);
    await dev.RTCStore.preloadContact(ID[p]);
  }
  return dev;
}

function makeLink() {
  const net = { dead: false, dropBtoA: false };
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
    close() { this.readyState = 'closed'; } });
  const a = mk();
  const b = mk();
  a.send = (d) => {
    if (a.readyState !== 'open') throw new Error('Kanal zu');
    if (!net.dead) setTimeout(() => b.onmessage?.({ data: d }), 0);
  };
  b.send = (d) => {
    if (b.readyState !== 'open') throw new Error('Kanal zu');
    if (!net.dead && !net.dropBtoA) setTimeout(() => a.onmessage?.({ data: d }), 0);
  };
  return { a, b, net };
}

function attach(dev, peerId, ch, sessionSecret) {
  const rtc = new dev.WebRTCManager(() => {}, () => {}, () => {});
  rtc.chatId = peerId;
  rtc.sharedSecret = sessionSecret;
  rtc.keyExchangeDone = true;
  rtc.dataChannel = ch;
  rtc.pc = { iceConnectionState: 'connected', close() {} };
  rtc._setupDataChannel(ch);
  rtc._lastActivity = Date.now();
  dev.RTCStore.sharedSecrets.set(peerId, sessionSecret);
  dev.RTCStore.setConnection(peerId, rtc);
  rtc._onReady = () => dev.BG.flushQueue(peerId, rtc);
  openRtcs.push(rtc);
  return rtc;
}

// Verbindung x <-> y inkl. Schluesseltausch-Abschluss (Profil, Faehigkeiten,
// Mitglieds-ID, danach Warteschlange).
async function connect(x, y) {
  const session = crypto.randomBytes(32).toString('base64');
  const link = makeLink();
  const rx = attach(x, ID[y.name], link.a, session);
  const ry = attach(y, ID[x.name], link.b, session);
  await Promise.all([rx._onKeyExchange(), ry._onKeyExchange()]);
  await waitFor(() => x.RTCStore.getPeerCaps(ID[y.name]) !== 'unknown' && y.RTCStore.getPeerCaps(ID[x.name]) !== 'unknown',
    3000, 'Faehigkeiten ' + x.name + '/' + y.name);
  await waitFor(async () => (await contactOf(x, ID[y.name]))?.groupMemberId && (await contactOf(y, ID[x.name]))?.groupMemberId,
    3000, 'Mitglieds-IDs ' + x.name + '/' + y.name);
  return { rx, ry, link, close() { rx.close(); ry.close(); } };
}

async function contactOf(dev, id) {
  const raw = await dev.ES.getItem('contacts');
  return (raw ? JSON.parse(raw) : []).find((c) => c.id === id) || null;
}
async function groupsOf(dev) {
  const raw = await dev.ES.getItem('groups');
  return raw ? JSON.parse(raw) : [];
}
async function groupOf(dev, gid) {
  return (await groupsOf(dev)).find((g) => g.groupId === gid) || null;
}
async function chatOf(dev, gid) {
  const raw = await dev.ES.getItem('gchat_' + gid);
  return raw ? JSON.parse(raw) : [];
}
async function queueOf(dev, peerName) {
  const raw = await dev.ES.getItem('queue_' + ID[peerName]);
  return raw ? JSON.parse(raw) : [];
}
// Inhalt eines Gruppen-Mediums (Audit G1: verschluesselte Datei, im Verlauf nur Verweis).
async function contentOf(dev, gid, m) {
  return dev.MV.getMedia(dev.GM.groupMediaScope(gid), m);
}
function mediaFilesOf(dev, gid) {
  const dir = dev.MV.scopeDir(dev.GM.groupMediaScope(gid));
  return [...dev.RNFS.__files.keys()].filter((p) => p.startsWith(dir + '/'));
}
async function pendingOf(dev) {
  const raw = await dev.ES.getItem('groups_pending');
  return raw ? JSON.parse(raw) : {};
}
const textsOf = (list) => list.filter((m) => !m.sys).map((m) => m.text);

const logLines = [];
beforeAll(() => {
  const rec = (...args) => { logLines.push(args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ')); };
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) jest.spyOn(console, k).mockImplementation(rec);
});
afterAll(() => {
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) console[k].mockRestore?.();
});
beforeEach(() => {
  global.__mockStores = {};
  global.__mockFiles = {};
  global.__pinKeys = {};
  for (const k of Object.keys(PAIR_SECRETS)) delete PAIR_SECRETS[k];
});
afterEach(async () => {
  for (const rtc of openRtcs.splice(0)) { try { rtc.close(); } catch {} }
  for (const d of devices.splice(0)) {
    d.BG._resetOutboxForTests();
    d.GM._resetGroupMessagingForTests();
  }
  await tick(5);
});


function dumpOf(dev) {
  const st = [...dev.ES.__store.entries()].map(([k, v]) => k + '=' + v).join('\n');
  const files = [...dev.RNFS.__files.entries()].map(([k, v]) => k + '=' + v).join('\n');
  return st + '\n' + files;
}

const PIN_BOB = '246810';

test('Gesperrt empfangen: nichts im Klartext gespeichert, nach Neustart + Entsperren alles da', async () => {
  const alice = await boot('alice', ['bob']);
  let bob = await boot('bob', ['alice']);
  await bob.PV.create(PIN_BOB);
  bob.PV.lock();                                         // App im Hintergrund, Frist abgelaufen
  const conn = await connect(alice, bob);

  const res = await alice.GM.createGroup({ name: 'Runde', description: '', memberContactIds: [ID.bob] });
  const gid = res.group.groupId;
  await waitFor(async () => !!(await groupOf(bob, gid)), 5000, 'Gruppe bei Bob');
  await alice.BG.sendViaOutbox(ID.bob, 'text', { type: 'text', text: 'Treffen am Leuchtturm', time: Date.now(), msgId: 't1' }, 't1');
  await alice.GM.sendGroupText(gid, 'Bringt Taschenlampen mit');
  await waitFor(async () => (await queueOf(alice, 'bob')).length === 0, 5000, 'Zustellung an Bob');
  await waitFor(async () => !!(await bob.ES.getItem('vj_gchat_' + gid)), 3000, 'Gruppen-Journal');

  // Bobs Geraet: kein Inhalt im Klartext, alles versiegelt.
  const dump = dumpOf(bob);
  expect(dump).toContain('Runde');                       // Gruppenname liegt bewusst offen (Hintergrund braucht ihn)
  expect(dump).not.toContain('Leuchtturm');
  expect(dump).not.toContain('Taschenlampen');
  const inbox = JSON.parse(await bob.ES.getItem('rx_inbox'));
  expect(inbox.length).toBeGreaterThan(0);
  expect(inbox.every((e) => e.ks && !e.k)).toBe(true);
  const g = await groupOf(bob, gid);
  expect(g.last.startsWith('pv1:s:')).toBe(true);
  expect(await bob.ES.getItem('gchat_' + gid)).toBeNull();   // Verlauf erst beim Entsperren
  expect(JSON.parse(await bob.ES.getItem('vj_gchat_' + gid)).every((s) => s.startsWith('pv1:s:'))).toBe(true);

  // Neustart des Geraets (Prozess beendet), gesperrt.
  conn.close();
  bob.BG._resetOutboxForTests();
  bob.GM._resetGroupMessagingForTests();
  bob = await boot('bob', ['alice']);
  expect(bob.PV.isUnlocked()).toBe(false);
  await bob.RTCStore.ensureInboxRestored();
  expect(bob.RTCStore.buffer.get(ID.alice) || []).toEqual([]);   // gesperrt: nichts entschluesselt
  await expect(bob.GM.loadGroupChat(gid)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

  // Entsperren: alles da.
  expect((await bob.PV.unlockWithPin(PIN_BOB)).ok).toBe(true);
  const buffered = await bob.RTCStore.takeBuffered(ID.alice);
  expect(buffered.map((m) => m.text)).toContain('Treffen am Leuchtturm');
  const chat = await bob.GM.loadGroupChat(gid);
  expect(textsOf(chat)).toEqual(['Bringt Taschenlampen mit']);
  expect(bob.PV.previewText((await groupOf(bob, gid)).last)).toContain('Taschenlampen');
  // Journal eingearbeitet, Verlauf jetzt symmetrisch verschluesselt.
  expect(await bob.ES.getItem('vj_gchat_' + gid)).toBeNull();
  expect((await bob.ES.getItem('gchat_' + gid)).startsWith('pv1:d:')).toBe(true);
  expect(dumpOf(bob)).not.toContain('Taschenlampen');
});

test('Entsperrt: Gruppennachrichten direkt (kein Journal), doppelte Zustellung nur einmal im Verlauf', async () => {
  const alice = await boot('alice', ['bob']);
  const bob = await boot('bob', ['alice']);
  await bob.PV.create(PIN_BOB);
  await connect(alice, bob);
  const res = await alice.GM.createGroup({ name: 'Runde', description: '', memberContactIds: [ID.bob] });
  const gid = res.group.groupId;
  await waitFor(async () => !!(await groupOf(bob, gid)), 5000, 'Gruppe bei Bob');
  await alice.GM.sendGroupText(gid, 'Eins');
  await waitFor(async () => textsOf(await bob.GM.loadGroupChat(gid)).includes('Eins'), 5000, 'Eins bei Bob');
  expect(await bob.ES.getItem('vj_gchat_' + gid)).toBeNull();
  expect((await bob.ES.getItem('gchat_' + gid)).startsWith('pv1:d:')).toBe(true);
  // Gesperrt erneut zugestellte (gleiche) Nachricht: im Journal, beim Einarbeiten entdoppelt.
  const chat = await bob.GM.loadGroupChat(gid);
  const own = chat.find((m) => m.text === 'Eins');
  bob.PV.lock();
  await bob.PV.update('gchat_' + gid, { op: 'append', entries: [own] });
  await bob.PV.unlockWithPin(PIN_BOB);
  expect(textsOf(await bob.GM.loadGroupChat(gid)).filter((x) => x === 'Eins')).toHaveLength(1);
});
