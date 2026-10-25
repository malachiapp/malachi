// Vorstellen ueber die Gruppe und Kanal-Modus (GroupMessaging.js,
// Nutzerwunsch 2026-10-25): Anfragen nur mit beidseitiger Zustimmung, stilles
// Ablehnen, nur der Admin stellt vor, Kanal-Abonnenten sehen einander nicht.
// Die Tor-Kopplung selbst ist hier ersetzt (eigener Test:
// groupIntroPairing.test.js) - geprueft wird das Protokoll ueber echte Kanaele.
//
// Aufbau wie groups.fanout.test.js: DREI "Geraete"
// (Alice, Bob, Carol), jedes mit eigener Modul-Instanz (jest.isolateModules)
// und eigenem dauerhaften Speicher (EncryptedStorage/RNFS-Mock pro Geraet).
// Jedes Paar wird ueber ein eigenes Kanalpaar im Speicher verbunden - echte
// Verschluesselung (WebRTCManager/MessageCrypto/Ratchet), echte Warteschlange,
// echte Empfangsbestaetigungen und Dedup.
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
    };
  });
  global.__mockDevice = undefined;
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

// Drei Geraete, alle untereinander gekoppelt (Kontaktlisten), Verbindungen
// nach Wunsch.
async function trio() {
  const alice = await boot('alice', ['bob', 'carol']);
  const bob = await boot('bob', ['alice', 'carol']);
  const carol = await boot('carol', ['alice', 'bob']);
  return { alice, bob, carol };
}

async function createAndDistribute(alice, members, receivers, name = 'Projekt Falke') {
  const res = await alice.GM.createGroup({ name, description: 'Nur fuer uns', memberContactIds: members.map((m) => ID[m]) });
  expect(res.error).toBeUndefined();
  const gid = res.group.groupId;
  for (const r of receivers) await waitFor(async () => !!(await groupOf(r, gid)), 5000, 'Einladung bei ' + r.name);
  return gid;
}


// ─── Vorstellen ueber die Gruppe und Kanal (Nutzerwunsch 2026-10-25) ────────
// Alice ist Admin und mit Bob und Carol gekoppelt; Bob und Carol kennen sich
// NICHT (eigene Kontaktlisten nur mit Alice).
async function introTrio() {
  const alice = await boot('alice', ['bob', 'carol']);
  const bob = await boot('bob', ['alice']);
  const carol = await boot('carol', ['alice']);
  await connect(alice, bob);
  await connect(alice, carol);
  return { alice, bob, carol };
}
// Kopplung selbst (Tor) ist hier ersetzt - geprueft wird das Protokoll.
const INVITE = { token: 'ABCD1234', psk: 'a1'.repeat(16), onion: 'b'.repeat(56) + '.onion' };
function fakeIntro(dev, invite = INVITE) {
  const calls = { create: [], join: [] };
  dev.GM.configureGroupMessaging({
    introPairing: {
      createInvite: async (info) => { calls.create.push(info); return invite; },
      joinInvite: (info) => { calls.join.push(info); },
    },
  });
  return calls;
}
async function contactsOf(dev) {
  const raw = await dev.ES.getItem('contacts');
  return raw ? JSON.parse(raw) : [];
}
const status = async (dev, gid, mid) => dev.GM.introStatus(await groupOf(dev, gid), mid);
async function setup() {
  const devs = await introTrio();
  const gid = await createAndDistribute(devs.alice, ['bob', 'carol'], [devs.bob, devs.carol]);
  const mids = {
    alice: await devs.alice.GM.getSelfMemberId(),
    bob: await devs.bob.GM.getSelfMemberId(),
    carol: await devs.carol.GM.getSelfMemberId(),
  };
  return { ...devs, gid, mids, fb: fakeIntro(devs.bob), fc: fakeIntro(devs.carol), fa: fakeIntro(devs.alice) };
}
const introMsg = (gid, op, peer, fromMid, extra = {}) => ({
  type: 'system', subtype: 'group_intro', groupId: gid, op, peer, ts: Date.now(), fromMid, ...extra,
});

describe('Vorstellen ueber die Gruppe', () => {
  test('neue Gruppe bietet Vorstellen an; Mitglieder sehen es, der Admin selbst braucht es nicht', async () => {
    const { alice, bob, gid, mids } = await setup();
    const gb = await groupOf(bob, gid);
    expect(gb.intros).toBe(true);
    expect(gb.mode).toBe('group');
    expect(bob.GM.introsAvailable(gb)).toBe(true);
    expect(bob.GM.introStatus(gb, mids.carol)).toBe('none');
    // Admin: ist mit allen gekoppelt - keine Anfrage moeglich
    expect(await alice.GM.requestIntro(gid, mids.bob)).toEqual({ error: 'not_allowed' });
    // mit sich selbst bzw. Nicht-Mitgliedern: nein
    expect(await bob.GM.requestIntro(gid, mids.bob)).toEqual({ error: 'not_allowed' });
    expect(await bob.GM.requestIntro(gid, 'm_' + 'e'.repeat(32))).toEqual({ error: 'not_allowed' });
  });

  test('beide stimmen zu -> Einladung ueber den Admin; vorher oeffnet sich nichts von selbst', async () => {
    const { alice, bob, carol, gid, mids, fb, fc } = await setup();
    expect(await bob.GM.requestIntro(gid, mids.carol)).toEqual({ ok: true });
    await waitFor(async () => (await status(carol, gid, mids.bob)) === 'incoming', 5000, 'Anfrage bei Carol');
    expect(await status(bob, gid, mids.carol)).toBe('requested');
    // Nichts von selbst: kein Kontakt, keine Kopplung, kein Chat
    expect((await contactsOf(carol)).map((c) => c.id)).toEqual([ID.alice]);
    expect(fb.create.length + fb.join.length + fc.create.length + fc.join.length).toBe(0);
    // Hinweis nur im eigenen Verlauf der Angefragten
    await waitFor(async () => (await chatOf(carol, gid)).some((m) => m.sys && m.text.includes('Bob') && m.text.includes('verbinden')), 3000);
    expect((await chatOf(bob, gid)).some((m) => m.sys && m.text.includes('möchte sich'))).toBe(false);
    expect(carol.GM.incomingIntroCount(await groupOf(carol, gid))).toBe(1);

    expect(await carol.GM.acceptIntro(gid, mids.bob)).toEqual({ ok: true });
    const bobInvites = mids.bob < mids.carol;
    const inviter = bobInvites ? fb : fc;
    const joiner = bobInvites ? fc : fb;
    await waitFor(() => inviter.create.length === 1, 5000, 'Einladung erzeugt');
    await waitFor(() => joiner.join.length === 1, 5000, 'Einladung beim Beitretenden');
    expect(inviter.join).toHaveLength(0);
    expect(joiner.create).toHaveLength(0);
    expect(inviter.create[0]).toMatchObject({ groupId: gid, peerMid: bobInvites ? mids.carol : mids.bob, peerName: bobInvites ? 'Carol' : 'Bob', adminName: 'Alice' });
    expect(joiner.join[0]).toMatchObject({ groupId: gid, peerMid: bobInvites ? mids.bob : mids.carol, adminName: 'Alice' });
    expect(joiner.join[0].invite).toEqual(INVITE);
    expect(await status(bob, gid, mids.carol)).toBe('connecting');
    expect(await status(carol, gid, mids.bob)).toBe('connecting');
    // Die Einladung lag beim Admin nur verschluesselt in der Warteschlange
    for (const k of alice.ES.__store.keys()) expect(String(alice.ES.__store.get(k))).not.toContain(INVITE.psk);

    // Kopplung fertig (GroupIntroPairing meldet) -> Hinweis, Admin vergisst den Eintrag
    await bob.GM.onIntroPaired(gid, mids.carol);
    await carol.GM.onIntroPaired(gid, mids.bob);
    expect(await status(bob, gid, mids.carol)).toBe('done');
    expect((await chatOf(bob, gid)).some((m) => m.sys && m.text.includes('Carol') && m.text.includes('direkt'))).toBe(true);
    await waitFor(async () => Object.keys((await groupOf(alice, gid)).introBook || {}).length === 0, 5000, 'Admin-Eintrag geloescht');
  });

  test('Ablehnen ist still: der Anfragende sieht weiter "angefragt", erneute Anfragen erreichen die Ablehnende nicht', async () => {
    const { alice, bob, carol, gid, mids, fb, fc } = await setup();
    await bob.GM.requestIntro(gid, mids.carol);
    await waitFor(async () => (await status(carol, gid, mids.bob)) === 'incoming');
    await carol.GM.declineIntro(gid, mids.bob);
    expect(await status(carol, gid, mids.bob)).toBe('none');
    const key = [mids.bob, mids.carol].sort().join('|');
    await waitFor(async () => (await groupOf(alice, gid)).introBook?.[key]?.declined?.[mids.carol] === true, 5000, 'Ablehnung beim Admin');
    expect(await status(bob, gid, mids.carol)).toBe('requested');
    // Bob fragt nochmal - Carol bekommt nichts
    await bob.GM.requestIntro(gid, mids.carol);
    await waitFor(async () => ((await groupOf(alice, gid)).introRate?.[mids.bob] || []).length === 2, 5000, 'zweite Anfrage beim Admin');
    await tick(200);
    expect(await status(carol, gid, mids.bob)).toBe('none');
    expect(fb.create.length + fc.create.length).toBe(0);
    // Carol entscheidet sich um und fragt selbst -> jetzt passt es
    await carol.GM.requestIntro(gid, mids.bob);
    await waitFor(() => fb.create.length + fc.create.length === 1, 5000, 'Einladung nach Umentscheidung');
  });

  test('Zurueckziehen entfernt die Anfrage beim anderen', async () => {
    const { bob, carol, gid, mids } = await setup();
    await bob.GM.requestIntro(gid, mids.carol);
    await waitFor(async () => (await status(carol, gid, mids.bob)) === 'incoming');
    await bob.GM.withdrawIntro(gid, mids.carol);
    expect(await status(bob, gid, mids.carol)).toBe('none');
    await waitFor(async () => (await status(carol, gid, mids.bob)) === 'none', 5000, 'Anfrage bei Carol entfernt');
  });

  test('ohne eigene Zustimmung keine Einladung - auch nicht auf Anweisung des Admins', async () => {
    const { carol, gid, mids, fc } = await setup();
    // Admin-Kanal (Alice) schickt Carol ein "match" und eine Einladung, obwohl Carol nie wollte
    const role = mids.carol < mids.bob ? 'inviter' : 'joiner';
    expect(await carol.GM.handleGroupMessage(ID.alice, introMsg(gid, 'match', mids.bob, mids.alice, { role, name: 'Bob' }))).toBe(true);
    if (mids.bob < mids.carol) {
      await carol.GM.handleGroupMessage(ID.alice, introMsg(gid, 'invite', mids.bob, mids.alice, { invite: INVITE, name: 'Bob' }));
    }
    expect(fc.create).toHaveLength(0);
    expect(fc.join).toHaveLength(0);
    expect(await status(carol, gid, mids.bob)).toBe('none');
  });

  test('nur der Admin darf vorstellen; Mitglieder koennen keine Admin-Nachrichten faelschen', async () => {
    const { alice, bob, carol, gid, mids, fb, fc } = await setup();
    // Bob (kein Admin) schickt Alice Admin-Nachrichten -> verworfen, nichts weitergeleitet
    for (const op of ['request', 'match', 'invite', 'cancel']) {
      expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, op, mids.carol, mids.bob, { role: 'inviter', invite: INVITE }))).toBe(false);
    }
    // Wunsch fuer sich selbst / fuer den Admin -> verworfen
    expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'want', mids.bob, mids.bob))).toBe(false);
    expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'want', mids.alice, mids.bob))).toBe(false);
    // Einladung ohne beidseitige Zustimmung -> nicht weitergereicht
    expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'offer', mids.carol, mids.bob, { invite: INVITE }))).toBe(true);
    // Ungueltige Einladung -> nicht weitergereicht
    await tick(200);
    expect(fc.join.length + fb.join.length).toBe(0);
    expect(await status(carol, gid, mids.bob)).toBe('none');
    // Unbekannte Operation / ungueltige ID -> verworfen
    expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'hack', mids.carol, mids.bob))).toBe(false);
    expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'want', 'kein-mid', mids.bob))).toBe(false);
  });

  test('Admin kann Vorstellen abschalten; danach keine Anfragen mehr', async () => {
    const { alice, bob, carol, gid, mids } = await setup();
    const r = await alice.GM.setGroupIntros(gid, false);
    expect(r.error).toBeUndefined();
    await waitFor(async () => (await groupOf(bob, gid)).intros === false, 5000, 'Einstellung bei Bob');
    expect((await chatOf(bob, gid)).some((m) => m.sys && m.text.includes('ausgeschaltet'))).toBe(true);
    expect(await bob.GM.requestIntro(gid, mids.carol)).toEqual({ error: 'not_allowed' });
    // Auch ein direkt geschickter Wunsch wird vom Admin ignoriert
    expect(await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'want', mids.carol, mids.bob))).toBe(false);
    await tick(100);
    expect(await status(carol, gid, mids.bob)).toBe('none');
    // Wieder an
    await alice.GM.setGroupIntros(gid, true);
    await waitFor(async () => (await groupOf(bob, gid)).intros === true, 5000);
    expect(await bob.GM.requestIntro(gid, mids.carol)).toEqual({ ok: true });
  });

  test('Flut-Schutz: hoechstens 30 Wuensche je Mitglied und Tag', async () => {
    const { alice, gid, mids } = await setup();
    for (let i = 0; i < 35; i++) await alice.GM.handleGroupMessage(ID.bob, introMsg(gid, 'want', mids.carol, mids.bob));
    expect((await groupOf(alice, gid)).introRate[mids.bob]).toHaveLength(30);
  });

  test('Gruppe ohne ausdrueckliches Angebot (aeltere Admins) zeigt kein Vorstellen', async () => {
    const { bob, gid, mids } = await setup();
    // Stand ohne "intros" (wie von einer aelteren App-Version)
    const g = await groupOf(bob, gid);
    await bob.ES.setItem('groups', JSON.stringify((await groupsOf(bob)).map((x) => (x.groupId === gid ? { ...x, intros: undefined } : x))));
    expect(bob.GM.introsAvailable({ ...g, intros: undefined })).toBe(false);
    expect(await bob.GM.requestIntro(gid, mids.carol)).toEqual({ error: 'not_allowed' });
  });
});

describe('Kanal', () => {
  async function channel() {
    const devs = await introTrio();
    const res = await devs.alice.GM.createGroup({ name: 'Malachi News', description: '', memberContactIds: [ID.bob, ID.carol], mode: 'channel', intros: true });
    expect(res.error).toBeUndefined();
    const gid = res.group.groupId;
    for (const r of [devs.bob, devs.carol]) await waitFor(async () => !!(await groupOf(r, gid)), 5000, 'Kanal bei ' + r.name);
    const mids = { alice: await devs.alice.GM.getSelfMemberId(), bob: await devs.bob.GM.getSelfMemberId(), carol: await devs.carol.GM.getSelfMemberId() };
    return { ...devs, gid, mids };
  }

  test('Abonnenten sehen nur den Admin und sich selbst - nirgends auf ihrem Geraet steht ein anderer Abonnent', async () => {
    const { alice, bob, carol, gid, mids } = await channel();
    const ga = await groupOf(alice, gid);
    expect(ga.mode).toBe('channel');
    expect(ga.intros).toBe(false);
    expect(ga.members.map((m) => m.mid).sort()).toEqual([mids.alice, mids.bob, mids.carol].sort());
    for (const [dev, self, other] of [[bob, mids.bob, mids.carol], [carol, mids.carol, mids.bob]]) {
      const g = await groupOf(dev, gid);
      expect(g.mode).toBe('channel');
      expect(g.members.map((m) => m.mid).sort()).toEqual([mids.alice, self].sort());
      expect(g.memberCount).toBe(3);
      expect(dev.GM.introsAvailable(g)).toBe(false);
      for (const k of dev.ES.__store.keys()) expect(String(dev.ES.__store.get(k))).not.toContain(other);
    }
    expect(bob.GM.maxMembersFor('channel')).toBe(250);
    expect(bob.GM.maxMembersFor('group')).toBe(8);
  });

  test('nur Admins schreiben: Abonnenten koennen nicht senden, gefaelschte Abonnenten-Nachrichten werden verworfen', async () => {
    const { alice, bob, carol, gid, mids } = await channel();
    expect(await bob.GM.sendGroupText(gid, 'Hallo alle')).toEqual({ error: 'channel_readonly' });
    expect(await bob.GM.sendGroupMedia(gid, { kind: 'audio', base64: 'QUJD'.repeat(50), durationMs: 900 })).toEqual({ error: 'channel_readonly' });
    expect(bob.GM.isReadOnlyChannel(await groupOf(bob, gid), mids.bob)).toBe(true);
    expect(alice.GM.isReadOnlyChannel(await groupOf(alice, gid), mids.alice)).toBe(false);
    const r = await alice.GM.sendGroupText(gid, 'Ausgabe 1');
    expect(r.reached).toBe(2);
    for (const dev of [bob, carol]) await waitFor(async () => textsOf(await chatOf(dev, gid)).includes('Ausgabe 1'), 5000, 'Ausgabe bei ' + dev.name);
    // Gefaelscht: Bob schickt Alice einen Kanal-Text
    expect(await alice.GM.handleGroupMessage(ID.bob, {
      type: 'system', subtype: 'group_text', groupId: gid, msgId: 'spam1234abcd', text: 'Werbung', time: Date.now(), fromMid: mids.bob,
    })).toBe(false);
    expect(textsOf(await chatOf(alice, gid))).not.toContain('Werbung');
  });

  test('Austritt eines Abonnenten geht nur an den Admin; Admin verlaesst den Kanal -> Kanal geschlossen', async () => {
    const { alice, bob, carol, gid, mids } = await channel();
    await bob.GM.leaveGroup(gid);
    await waitFor(async () => !(await groupOf(alice, gid)).members.some((m) => m.mid === mids.bob), 5000, 'Bob ausgetreten');
    // Carol erfaehrt davon nichts (sieht Bob ohnehin nicht)
    expect((await chatOf(carol, gid)).filter((m) => m.sys).map((m) => m.text).join(' ')).not.toContain('Bob');
    await alice.GM.leaveGroup(gid);
    await waitFor(async () => (await groupOf(carol, gid))?.removed === true, 5000, 'Kanal bei Carol geschlossen');
    expect((await chatOf(carol, gid)).some((m) => m.sys && m.text.includes('geschlossen'))).toBe(true);
  });

  test('Sprachnachricht im Kanal traegt die Wellenform', async () => {
    const { alice, bob, gid } = await channel();
    const wave = 'V'.repeat(10) + '8'.repeat(38);
    await alice.GM.sendGroupMedia(gid, { kind: 'audio', base64: 'QUJD'.repeat(500), durationMs: 2100, wave });
    await waitFor(async () => (await chatOf(bob, gid)).some((m) => m.type === 'audio'), 8000, 'Sprachnachricht bei Bob');
    const m = (await chatOf(bob, gid)).find((x) => x.type === 'audio');
    expect(m.wave).toBe(wave);
    expect(m.durationMs).toBe(2100);
    const own = (await chatOf(alice, gid)).find((x) => x.type === 'audio');
    expect(own.wave).toBe(wave);
  });
});
