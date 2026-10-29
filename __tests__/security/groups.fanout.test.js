// Gruppenchats (GroupMessaging.js, GROUP_CHAT_DESIGN.md): Fan-out ueber die
// bestehenden verschluesselten 1:1-Kanaele und die Sende-Warteschlange - kein
// Server, kein Weiterleiten ueber andere Mitglieder.
//
// Aufbau wie outbox.deliveryGuarantee.test.js, aber mit DREI "Geraeten"
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
      I18N: require('../../i18n'),
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

describe('Mitglieds-Identitaet ueber Geraete hinweg', () => {
  test('zufaellige Mitglieds-ID wird ueber den verschluesselten 1:1-Kanal ausgetauscht, am Kontakt gespeichert und uebersteht einen Neustart', async () => {
    const alice = await boot('alice', ['bob']);
    const bob = await boot('bob', ['alice']);
    await connect(alice, bob);
    const aMid = await alice.GM.getSelfMemberId();
    const bMid = await bob.GM.getSelfMemberId();
    expect(aMid).toMatch(/^m_[0-9a-f]{32}$/);
    expect(aMid).not.toBe(bMid);
    expect((await contactOf(bob, ID.alice)).groupMemberId).toBe(aMid);
    expect((await contactOf(alice, ID.bob)).groupMemberId).toBe(bMid);
    // Keine Onion-Adresse/kein Schluessel als ID.
    expect(aMid).not.toMatch(/onion/);
    const alice2 = await boot('alice', ['bob']);
    expect(await alice2.GM.getSelfMemberId()).toBe(aMid);
  });

  test('ein Kontakt kann weder eine fremde noch die eigene ID des Empfaengers uebernehmen; die erste ID pro Kontakt gilt', async () => {
    const { alice, bob } = await trio();
    await connect(alice, bob);
    const bMid = await bob.GM.getSelfMemberId();
    const aMid = await alice.GM.getSelfMemberId();
    // Carols Kanal (noch ohne ID) behauptet Bobs bzw. Alices ID -> verworfen.
    expect(await alice.GM.rememberPeerMemberId(ID.carol, bMid)).toBe(false);
    expect(await alice.GM.rememberPeerMemberId(ID.carol, aMid)).toBe(false);
    expect(await alice.GM.rememberPeerMemberId(ID.carol, 'm_' + 'c'.repeat(32))).toBe(true);
    expect(await alice.GM.rememberPeerMemberId(ID.carol, 'm_' + 'd'.repeat(32))).toBe(false);
    expect(await alice.GM.rememberPeerMemberId(ID.carol, 'kein-gueltiges-format')).toBe(false);
    expect((await contactOf(alice, ID.bob)).groupMemberId).toBe(bMid);
    await waitFor(async () => (await contactOf(alice, ID.carol)).groupMemberId === 'm_' + 'c'.repeat(32));
  });
});

describe('Lebenszyklus: Erstellen/Einladen ueber die Warteschlange', () => {
  test('Einladung geht write-ahead verschluesselt an JEDES Mitglied; Offline-Mitglied bekommt sie spaeter; nicht gekoppelte Mitglieder sind als solche erkennbar', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    const ac = await connect(alice, carol);
    ac.close(); // Carol geht offline
    const res = await alice.GM.createGroup({ name: 'Projekt Falke', description: 'Nur fuer uns', memberContactIds: [ID.bob, ID.carol] });
    const gid = res.group.groupId;
    const aMid = await alice.GM.getSelfMemberId();
    // Carols Eintrag wartet verschluesselt in der Warteschlange (Gruppenname nicht im Klartext).
    const qc = await queueOf(alice, 'carol');
    expect(qc).toHaveLength(1);
    expect(qc[0]).toMatchObject({ type: 'system', subtype: 'group_state', groupId: gid });
    expect(alice.RNFS.__files.get(qc[0].path)).not.toContain('Projekt Falke');
    // Bob (verbunden) hat sie sofort - und Alices Warteschlange ist nach der Bestaetigung leer.
    await waitFor(async () => !!(await groupOf(bob, gid)));
    await waitFor(async () => (await queueOf(alice, 'bob')).length === 0);
    const gb = await groupOf(bob, gid);
    expect(gb).toMatchObject({ name: 'Projekt Falke', description: 'Nur fuer uns', admins: [aMid], amAdmin: false, removed: false, rev: 1 });
    expect(gb.members).toHaveLength(3);
    expect(gb.unread).toBe(1);
    // Bob und Carol haben sich nie verbunden: Carol ist fuer Bob nicht direkt erreichbar.
    expect(gb.memberContactIds).toEqual([ID.alice]);
    const bobContacts = JSON.parse(await bob.ES.getItem('contacts'));
    expect(bob.GM.unreachableMembers(gb, bobContacts).map((m) => m.name)).toEqual(['Carol']);
    // Carol kommt online -> Einladung wird zugestellt.
    expect(await groupOf(carol, gid)).toBeNull();
    await connect(alice, carol);
    await waitFor(async () => !!(await groupOf(carol, gid)));
    await waitFor(async () => (await queueOf(alice, 'carol')).length === 0);
    expect(textsOf(await chatOf(carol, gid))).toEqual([]);
    expect((await chatOf(carol, gid)).some((m) => m.sys && /hinzugefügt/.test(m.text))).toBe(true);
  });

  test('Kontakt ohne Mitglieds-ID kann nicht eingeladen werden (klare Fehlermeldung statt halber Gruppe)', async () => {
    const { alice } = await trio();
    const res = await alice.GM.createGroup({ name: 'X', memberContactIds: [ID.bob] });
    expect(res).toMatchObject({ error: 'missing_member_id', missing: ['Bob'] });
    expect(await groupsOf(alice)).toEqual([]);
  });
});

describe('Gruppen-Nachrichten: Fan-out, Zustellstatus, Empfang', () => {
  test('ein sendViaOutbox-Eintrag pro erreichbarem Mitglied; ✓ wenn bei allen eingereiht, ✓✓ erst wenn alle bestaetigt; Offline-Mitglied erhaelt die Nachricht spaeter', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    const ac = await connect(alice, carol);
    await connect(bob, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const aMid = await alice.GM.getSelfMemberId();
    ac.close();

    const r = await alice.GM.sendGroupText(gid, 'Treffen um acht');
    expect(r.reached).toBe(2);
    expect(r.unreachable).toEqual([]);
    // Bob bestaetigt, Carol ist offline: ✓ (queued), 1/2 zugestellt.
    const bMid = await bob.GM.getSelfMemberId();
    const cMid = await carol.GM.getSelfMemberId();
    await waitFor(async () => (await chatOf(alice, gid)).find((m) => m.id === r.msgId)?.recipients?.[bMid] === 'delivered');
    let mine = (await chatOf(alice, gid)).find((m) => m.id === r.msgId);
    expect(mine.recipients[cMid]).toBe('queued');
    expect(mine.status).toBe('queued');
    expect(alice.GM.deliveredCount(mine.recipients)).toEqual({ delivered: 1, total: 2 });
    const qc = await queueOf(alice, 'carol');
    expect(qc.filter((i) => i.subtype === 'group_text')).toHaveLength(1);
    expect(qc.find((i) => i.subtype === 'group_text').groupId).toBe(gid);

    // Bob: Verlauf, Absender, Ungelesen-Zaehler, Vorschau.
    const bChat = await chatOf(bob, gid);
    const got = bChat.find((m) => m.id === r.msgId);
    expect(got).toMatchObject({ text: 'Treffen um acht', from: aMid, fromContactId: ID.alice, mine: false });
    const gb = await groupOf(bob, gid);
    expect(gb.unread).toBe(2); // Einladung + Nachricht
    expect(gb.last).toBe('Alice: Treffen um acht');

    // Carol kommt wieder -> zugestellt, Alice sieht ✓✓.
    await connect(alice, carol);
    await waitFor(async () => (await chatOf(alice, gid)).find((m) => m.id === r.msgId)?.status === 'delivered');
    expect(textsOf(await chatOf(carol, gid))).toEqual(['Treffen um acht']);
    // Bestaetigungen landen nicht im 1:1-Chat.
    expect((alice.RTCStore.buffer.get(ID.bob) || []).some((m) => m.type === 'receipt' && String(m.msgId).startsWith('grp|'))).toBe(false);
  });

  test('offener Gruppenchat: Listener bekommt den Verlauf, kein Ungelesen-Zaehler; der offene 1:1-Chat desselben Kontakts bekommt NICHTS', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    await bob.GM.markGroupRead(gid);
    const seen = [];
    const unsub = bob.GM.subscribeGroupChat(gid, (list) => seen.push(list));
    const oneToOne = [];
    bob.RTCStore.setMessageListener(ID.alice, (m) => oneToOne.push(m));
    await alice.GM.sendGroupText(gid, 'Hallo Gruppe');
    await waitFor(() => seen.some((l) => l.some((m) => m.text === 'Hallo Gruppe')));
    await tick(50);
    expect((await groupOf(bob, gid)).unread).toBe(0);
    expect(oneToOne.some((m) => m.type === 'system' && String(m.subtype).startsWith('group_'))).toBe(false);
    expect(oneToOne.some((m) => m.type === 'receipt' && String(m.msgId).startsWith('grp|'))).toBe(false);
    unsub();
    bob.RTCStore.setMessageListener(ID.alice, null);
    // Geschlossen: zaehlt wieder.
    await alice.GM.sendGroupText(gid, 'Noch eine');
    await waitFor(async () => (await groupOf(bob, gid)).unread === 1);
    // Weder Gruppen-Nachrichten noch deren Bestaetigungen im 1:1-Puffer.
    const buffered = bob.RTCStore.buffer.get(ID.alice) || [];
    expect(buffered.some((m) => String(m.subtype || '').startsWith('group_') || String(m.msgId || '').startsWith('grp|'))).toBe(false);
  });

  test('Dedup: verlorene Bestaetigung -> Warteschlange sendet erneut, Empfaenger speichert nur einmal (auch nach Neustart)', async () => {
    const alice = await boot('alice', ['bob']);
    let bob = await boot('bob', ['alice']);
    const ab = await connect(alice, bob);
    const gid = await createAndDistribute(alice, ['bob'], [bob]);
    await waitFor(async () => (await queueOf(alice, 'bob')).length === 0);
    ab.link.net.dropBtoA = true; // Bestaetigungen gehen verloren
    const r = await alice.GM.sendGroupText(gid, 'Einmal bitte');
    await waitFor(async () => textsOf(await chatOf(bob, gid)).includes('Einmal bitte'));
    await tick(50);
    expect((await queueOf(alice, 'bob')).some((i) => i.subtype === 'group_text')).toBe(true);
    ab.close();
    // Bob startet neu (Dedup-Liste persistent), neue Verbindung -> erneuter Versand.
    bob = await boot('bob', ['alice']);
    await connect(alice, bob);
    await waitFor(async () => (await chatOf(alice, gid)).find((m) => m.id === r.msgId)?.status === 'delivered');
    expect(textsOf(await chatOf(bob, gid)).filter((t) => t === 'Einmal bitte')).toHaveLength(1);
    // Auch direkt doppelt eingespielt (andere Zustellschluessel): nur einmal.
    const aMid = await alice.GM.getSelfMemberId();
    const dup = { type: 'system', subtype: 'group_text', groupId: gid, msgId: r.msgId, text: 'Einmal bitte', time: Date.now(), fromMid: aMid };
    await bob.GM.handleGroupMessage(ID.alice, dup);
    await bob.GM.handleGroupMessage(ID.alice, dup);
    expect(textsOf(await chatOf(bob, gid)).filter((t) => t === 'Einmal bitte')).toHaveLength(1);
  });

  test('Neustart/Hintergrund: bei geschlossener App empfangene Nachrichten liegen im verschluesselten Speicher und sind nach dem Neustart da', async () => {
    const alice = await boot('alice', ['bob']);
    const bob = await boot('bob', ['alice']);
    await connect(alice, bob);
    const gid = await createAndDistribute(alice, ['bob'], [bob]);
    await alice.GM.sendGroupText(gid, 'Im Hintergrund');
    await waitFor(async () => textsOf(await chatOf(bob, gid)).includes('Im Hintergrund'));
    const bob2 = await boot('bob', ['alice']);
    expect(textsOf(await bob2.GM.loadGroupChat(gid))).toEqual(['Im Hintergrund']);
    expect((await bob2.GM.loadGroups()).find((g) => g.groupId === gid).unread).toBe(2);
  });
});

describe('Mitgliedschaft und Admin-Regeln', () => {
  test('nur der Admin fuegt hinzu/entfernt/benennt um; Entfernte erfahren es und koennen nicht mehr senden', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    await connect(bob, carol);
    const gid = await createAndDistribute(alice, ['bob'], [bob]);
    const cMid = await carol.GM.getSelfMemberId();

    // Nicht-Admin darf nichts aendern.
    expect(await bob.GM.addGroupMembers(gid, [ID.carol])).toMatchObject({ error: 'not_allowed' });
    expect(await bob.GM.updateGroupInfo(gid, { name: 'Gekapert' })).toMatchObject({ error: 'not_allowed' });
    expect(await bob.GM.removeGroupMember(gid, await alice.GM.getSelfMemberId())).toMatchObject({ error: 'not_allowed' });

    // Admin fuegt Carol hinzu -> Carol bekommt die Einladung, Bob den neuen Stand.
    const add = await alice.GM.addGroupMembers(gid, [ID.carol]);
    expect(add.group.rev).toBe(2);
    await waitFor(async () => !!(await groupOf(carol, gid)));
    await waitFor(async () => (await groupOf(bob, gid))?.members.length === 3);
    expect((await chatOf(bob, gid)).some((m) => m.sys && m.text === 'Alice hat Carol hinzugefügt')).toBe(true);

    // Umbenennen.
    await alice.GM.updateGroupInfo(gid, { name: 'Falke 2', description: 'neu' });
    await waitFor(async () => (await groupOf(bob, gid))?.name === 'Falke 2' && (await groupOf(carol, gid))?.name === 'Falke 2');

    // Entfernen.
    await alice.GM.removeGroupMember(gid, cMid);
    await waitFor(async () => (await groupOf(carol, gid))?.removed === true);
    await waitFor(async () => (await groupOf(bob, gid))?.members.length === 2);
    expect((await chatOf(carol, gid)).some((m) => m.sys && m.text === 'Du wurdest aus der Gruppe entfernt')).toBe(true);
    expect(await carol.GM.sendGroupText(gid, 'Ich bin noch da')).toEqual({ error: 'not_member' });
    // Selbst eine direkt eingespielte Nachricht des Entfernten wird nicht angezeigt.
    await bob.GM.handleGroupMessage(ID.carol, { type: 'system', subtype: 'group_text', groupId: gid, msgId: 'zzzzzzzzzz01', text: 'Ich bin noch da', time: Date.now(), fromMid: cMid });
    expect(textsOf(await chatOf(bob, gid))).not.toContain('Ich bin noch da');
  });

  test('gefaelschter Gruppenstand eines Nicht-Admins (hoehere rev, sich selbst als Admin) wird ueberall verworfen', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    await connect(bob, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const bMid = await bob.GM.getSelfMemberId();
    const cMid = await carol.GM.getSelfMemberId();
    const forged = {
      type: 'system', subtype: 'group_state', groupId: gid, name: 'Bobs Gruppe', description: '',
      members: [{ mid: bMid, name: 'Bob' }, { mid: cMid, name: 'Carol' }], admins: [bMid],
      createdBy: bMid, createdAt: Date.now(), rev: 99, ts: Date.now(), change: { kind: 'remove', by: bMid }, fromMid: bMid,
    };
    await bob.BG.sendViaOutbox(ID.carol, 'system', forged, 'grp|s|' + gid + '|99');
    await bob.BG.sendViaOutbox(ID.alice, 'system', forged, 'grp|s|' + gid + '|99');
    await waitFor(async () => (await queueOf(bob, 'carol')).length === 0 && (await queueOf(bob, 'alice')).length === 0);
    for (const d of [alice, carol]) {
      const g = await groupOf(d, gid);
      expect(g.name).toBe('Projekt Falke');
      expect(g.rev).toBe(1);
      expect(g.members).toHaveLength(3);
    }
    // Absender-Behauptung im Inhalt zaehlt nicht: Bob gibt sich als Alice aus.
    const aMid = await alice.GM.getSelfMemberId();
    await carol.GM.handleGroupMessage(ID.bob, { ...forged, fromMid: aMid, admins: [aMid], rev: 100 });
    expect((await groupOf(carol, gid)).rev).toBe(1);
  });

  test('Austreten: jederzeit erlaubt, alle entfernen das Mitglied, Verlauf und noch nicht zugestellte eigene Texte sind weg, Grabstein verhindert Wiederauferstehung', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    const bc = await connect(bob, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const bMid = await bob.GM.getSelfMemberId();
    // Ein noch nicht zugestellter Text von Bob an Carol (Carol offline fuer Bob).
    bc.close();
    await bob.GM.sendGroupText(gid, 'Unzugestellt');
    expect((await queueOf(bob, 'carol')).some((i) => i.subtype === 'group_text')).toBe(true);

    await bob.GM.leaveGroup(gid);
    expect(await groupOf(bob, gid)).toBeNull();
    expect(await chatOf(bob, gid)).toEqual([]);
    expect((await queueOf(bob, 'carol')).some((i) => i.subtype === 'group_text')).toBe(false);
    expect((await queueOf(bob, 'carol')).some((i) => i.subtype === 'group_leave')).toBe(true);
    await waitFor(async () => !(await groupOf(alice, gid)).members.some((m) => m.mid === bMid));
    // Alice (Admin) verteilt den verbindlichen neuen Stand.
    await waitFor(async () => (await groupOf(carol, gid)).rev === 2 && !(await groupOf(carol, gid)).members.some((m) => m.mid === bMid));
    expect((await chatOf(alice, gid)).some((m) => m.sys && m.text === 'Bob hat die Gruppe verlassen')).toBe(true);
    // Verspaetete Nachricht/alter Stand an Bob: keine Wiederauferstehung, nichts zurueckgestellt.
    const aMid = await alice.GM.getSelfMemberId();
    await bob.GM.handleGroupMessage(ID.alice, { type: 'system', subtype: 'group_text', groupId: gid, msgId: 'late00000001', text: 'Zu spaet', time: Date.now(), fromMid: aMid });
    const old = (await groupOf(alice, gid));
    await bob.GM.handleGroupMessage(ID.alice, {
      type: 'system', subtype: 'group_state', groupId: gid, name: old.name, description: '', members: [...old.members, { mid: bMid, name: 'Bob' }],
      admins: old.admins, createdBy: aMid, createdAt: old.createdAt, rev: 1, ts: Date.now() - 60000, fromMid: aMid,
    });
    expect(await groupOf(bob, gid)).toBeNull();
    expect(await pendingOf(bob)).toEqual({});
  });

  test('letzter Admin tritt aus -> naechstes Mitglied wird ueberall Admin', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    await connect(bob, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const bMid = await bob.GM.getSelfMemberId();
    await alice.GM.leaveGroup(gid);
    await waitFor(async () => (await groupOf(bob, gid))?.amAdmin === true);
    await waitFor(async () => (await groupOf(carol, gid))?.admins?.[0] === bMid);
    expect((await groupOf(carol, gid)).members).toHaveLength(2);
    expect((await chatOf(bob, gid)).some((m) => m.sys && m.text === 'Du bist jetzt Admin dieser Gruppe')).toBe(true);
    expect((await chatOf(carol, gid)).some((m) => m.sys && m.text === 'Alice hat die Gruppe verlassen')).toBe(true);
    // Der neue Admin darf jetzt aendern.
    expect((await bob.GM.updateGroupInfo(gid, { name: 'Ohne Alice' })).error).toBeUndefined();
    await waitFor(async () => (await groupOf(carol, gid))?.name === 'Ohne Alice');
  });
});

describe('Unbekannte/ungueltige Gruppen', () => {
  test('ungueltige Gruppen-IDs werden verworfen, unbekannte begrenzt zurueckgestellt und bei spaeterer Einladung uebernommen', async () => {
    const { alice, bob, carol } = await trio();
    const ab = await connect(alice, bob);
    await connect(alice, carol);
    await connect(bob, carol);
    ab.close(); // Alices Einladung erreicht Bob erst spaeter
    const res = await alice.GM.createGroup({ name: 'Spaet', memberContactIds: [ID.bob, ID.carol] });
    const gid = res.group.groupId;
    await waitFor(async () => !!(await groupOf(carol, gid)));
    // Carols Nachricht kommt bei Bob VOR der Einladung an.
    await carol.GM.sendGroupText(gid, 'Vor der Einladung');
    await waitFor(async () => (await pendingOf(bob))[gid]?.length === 1);
    expect(await groupOf(bob, gid)).toBeNull();
    // Bestaetigt (keine Endlos-Wiederholung bei Carol).
    await waitFor(async () => !(await queueOf(carol, 'bob')).some((i) => i.subtype === 'group_text'));
    await connect(alice, bob);
    await waitFor(async () => textsOf(await chatOf(bob, gid)).includes('Vor der Einladung'));
    expect((await pendingOf(bob))[gid]).toBeUndefined();

    // Ungueltige IDs / Felder.
    const cMid = await carol.GM.getSelfMemberId();
    for (const groupId of ['../../etc/passwd', 'g_', 'g_XYZ', '', 42, null]) {
      expect(await bob.GM.handleGroupMessage(ID.carol, { type: 'system', subtype: 'group_text', groupId, msgId: 'abcdefgh1234', text: 'boese', time: Date.now(), fromMid: cMid })).toBe(false);
    }
    expect(Object.keys(await pendingOf(bob))).toEqual([]);
    // Einladung von jemandem, der sich nicht als Admin fuehrt -> ignoriert.
    const fakeGid = 'g_' + '1'.repeat(24);
    const bMid = await bob.GM.getSelfMemberId();
    await bob.GM.handleGroupMessage(ID.carol, {
      type: 'system', subtype: 'group_state', groupId: fakeGid, name: 'Fake', members: [{ mid: cMid, name: 'C' }, { mid: bMid, name: 'B' }],
      admins: [], rev: 1, ts: Date.now(), fromMid: cMid,
    });
    expect(await groupOf(bob, fakeGid)).toBeNull();
    // Begrenzung der Rueckstellung: hoechstens 50 pro unbekannter Gruppe.
    const unknown = 'g_' + 'a'.repeat(24);
    for (let i = 0; i < 60; i++) {
      await bob.GM.handleGroupMessage(ID.carol, { type: 'system', subtype: 'group_text', groupId: unknown, msgId: 'spam' + String(i).padStart(8, '0'), text: 'x' + i, time: Date.now(), fromMid: cMid });
    }
    expect((await pendingOf(bob))[unknown].length).toBe(50);
    expect(await groupOf(bob, unknown)).toBeNull();
  });
});

describe('Altbestand und Datenschutz', () => {
  test('lokale Phase-0-Gruppe wird beim Laden umgestellt und an die Mitglieder verteilt', async () => {
    const alice = await boot('alice', ['bob']);
    const bob = await boot('bob', ['alice']);
    await connect(alice, bob);
    const gid = 'g_' + 'b'.repeat(24);
    await alice.ES.setItem('groups', JSON.stringify([{ groupId: gid, name: 'Alt', description: '', avatarUri: null, memberContactIds: [ID.bob], admins: [], amAdmin: true, createdBy: 'me', createdAt: Date.now() }]));
    const list = await alice.GM.loadGroups();
    expect(list[0]).toMatchObject({ v: 1, groupId: gid, amAdmin: true, rev: 1 });
    expect(list[0].members).toHaveLength(2);
    await waitFor(async () => (await groupOf(bob, gid))?.name === 'Alt');
  });

  test('keine Nachrichteninhalte, Gruppennamen oder Beschreibungen in Logs', async () => {
    logLines.length = 0;
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    const res = await alice.GM.createGroup({ name: 'GEHEIMNAME-7Q', description: 'GEHEIMBESCHREIBUNG-7Q', memberContactIds: [ID.bob, ID.carol] });
    const gid = res.group.groupId;
    await waitFor(async () => !!(await groupOf(bob, gid)) && !!(await groupOf(carol, gid)));
    await alice.GM.sendGroupText(gid, 'GEHEIMTEXT-7Q-alpha');
    await bob.GM.sendGroupText(gid, 'GEHEIMTEXT-7Q-beta');
    await waitFor(async () => textsOf(await chatOf(carol, gid)).includes('GEHEIMTEXT-7Q-alpha')
      && textsOf(await chatOf(alice, gid)).includes('GEHEIMTEXT-7Q-beta'));
    await alice.GM.updateGroupInfo(gid, { name: 'GEHEIMNAME2-7Q', description: 'x' });
    await carol.GM.leaveGroup(gid);
    await tick(100);
    const all = logLines.join('\n');
    expect(all).not.toMatch(/GEHEIM/);
    expect(all).toMatch(/\[Gruppen\]/); // es wurde tatsaechlich protokolliert
  });
});

// Gruppen-Medien (Nutzerwunsch 2026-10-19: Bilder und Sprachnachrichten in
// Gruppen zum Release): gleicher verschluesselter Medienweg wie 1:1, je
// Mitglied eine eigene Kopie ueber dessen Warteschlange, Zuordnung zur Gruppe
// ueber die Zustell-ID.
describe('Gruppen-Medien (Bild, Sprachnachricht)', () => {
  const b64Of = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255)).toString('base64');
  const mediaOf = (list) => list.filter((m) => m.type === 'image' || m.type === 'audio');

  test('Bild und Sprachnachricht kommen bei allen Mitgliedern im GRUPPEN-Verlauf an (nicht im 1:1-Chat), mit ✓✓ beim Absender', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const img = b64Of(30000, 3);
    const voice = b64Of(12000, 9);
    const r1 = await alice.GM.sendGroupMedia(gid, { kind: 'image', base64: img, mimeType: 'image/jpeg' });
    const r2 = await alice.GM.sendGroupMedia(gid, { kind: 'audio', base64: voice, durationMs: 4200 });
    expect(r1.reached).toBe(2);
    expect(r2.reached).toBe(2);
    for (const r of [bob, carol]) {
      await waitFor(async () => mediaOf(await chatOf(r, gid)).length === 2, 8000, 'Medien bei ' + r.name);
      const [m1, m2] = mediaOf(await chatOf(r, gid));
      expect(m1).toMatchObject({ type: 'image', mimeType: 'image/jpeg', mine: false, from: await alice.GM.getSelfMemberId() });
      expect(m2).toMatchObject({ type: 'audio', durationMs: 4200, mine: false });
      // Audit G1: im Verlauf nur Verweis + Schluessel, Inhalt als verschluesselte Datei.
      expect(m1.base64).toBeUndefined();
      expect(typeof m1.mref).toBe('string');
      expect(await r.ES.getItem('gchat_' + gid)).not.toContain(img.slice(0, 64));
      expect(await contentOf(r, gid, m1)).toBe(img);
      expect(await contentOf(r, gid, m2)).toBe(voice);
      const files = mediaFilesOf(r, gid);
      expect(files).toHaveLength(2);
      for (const p of files) expect(r.RNFS.__files.get(p)).not.toContain(img.slice(0, 64));
      r.MV.clearMediaCache();
      expect(await contentOf(r, gid, { ...m1, mk: m2.mk })).toBeNull();   // falscher Schluessel
      // nicht im 1:1-Chat/Empfangspuffer gelandet
      expect(await r.ES.getItem('inbox_' + ID.alice)).toBeNull();
      expect((r.RTCStore.buffer.get(ID.alice) || []).filter((x) => x.type === 'image_complete' || x.type === 'audio_complete')).toHaveLength(0);
      const g = await groupOf(r, gid);
      expect(g.last).toMatch(/Sprachnachricht$/);
    }
    await waitFor(async () => mediaOf(await chatOf(alice, gid)).every((m) => m.status === 'delivered'), 8000, '✓✓ bei Alice');
    // Warteschlangen leer (Empfangsbestaetigung kam an)
    expect(await queueOf(alice, 'bob')).toHaveLength(0);
    expect(await queueOf(alice, 'carol')).toHaveLength(0);
  });

  // Fehler 29.10.2026: die eigene Vorschau stand fest auf Deutsch ("Du: 🎤 Sprachnachricht").
  test('Vorschau in der Chatliste folgt der eingestellten Sprache (eigene und empfangene Medien)', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    alice.I18N.setLanguage('en');
    bob.I18N.setLanguage('en');
    carol.I18N.setLanguage('de');
    await alice.GM.sendGroupMedia(gid, { kind: 'audio', base64: b64Of(3000, 4), durationMs: 1500 });
    expect((await groupOf(alice, gid)).last).toBe('You: 🎤 Voice message');
    await alice.GM.sendGroupMedia(gid, { kind: 'image', base64: b64Of(4000, 6), mimeType: 'image/jpeg' });
    expect((await groupOf(alice, gid)).last).toBe('You: 📷 Image');
    await waitFor(async () => mediaOf(await chatOf(bob, gid)).length === 2, 8000, 'Medien bei Bob');
    await waitFor(async () => mediaOf(await chatOf(carol, gid)).length === 2, 8000, 'Medien bei Carol');
    expect((await groupOf(bob, gid)).last).toMatch(/: 📷 Image$/);
    expect((await groupOf(carol, gid)).last).toMatch(/: 📷 Bild$/);
  });

  test('Offline-Mitglied bekommt das Bild beim naechsten Verbindungsaufbau; Bild in der Warteschlange nur verschluesselt', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    const ac = await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    ac.close();
    const img = b64Of(20000, 5);
    await alice.GM.sendGroupMedia(gid, { kind: 'image', base64: img, mimeType: 'image/png' });
    const q = await queueOf(alice, 'carol');
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ type: 'image', groupId: gid, encrypted: true });
    const file = alice.RNFS.__files.get(q[0].path);
    expect(file).not.toContain(img.slice(0, 64));
    await connect(alice, carol);
    await waitFor(async () => mediaOf(await chatOf(carol, gid)).length === 1, 8000, 'Bild bei Carol');
    expect(await contentOf(carol, gid, mediaOf(await chatOf(carol, gid))[0])).toBe(img);
    // Auch der Absender haelt sein Medium nur als Datei.
    expect(mediaOf(await chatOf(alice, gid))[0].base64).toBeUndefined();
    expect(await contentOf(alice, gid, mediaOf(await chatOf(alice, gid))[0])).toBe(img);
  });

  test('Abwehr: Nicht-Mitglied, fremder Typ, zu gross, kaputte Zustell-ID; Gruppe verlassen entfernt wartende Medien', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(bob, carol);
    // Gruppe nur Alice+Bob
    const gid = await createAndDistribute(alice, ['bob'], [bob]);
    const img = b64Of(1000, 1);
    // Carol (kein Mitglied) schickt Bob ein "Gruppenbild" -> zurueckgestellt, nicht im Verlauf
    expect(await bob.GM.handleGroupMessage(ID.carol, { type: 'image_complete', msgId: 'grp|m|' + gid + '|abcdefgh1234', base64: img, mimeType: 'image/jpeg' })).toBe(false);
    expect(mediaOf(await chatOf(bob, gid))).toHaveLength(0);
    // Alice (Mitglied), aber unerlaubter Typ bzw. zu gross bzw. kaputte ID
    expect(await bob.GM.handleGroupMessage(ID.alice, { type: 'image_complete', msgId: 'grp|m|' + gid + '|abcdefgh1235', base64: img, mimeType: 'text/html' })).toBe(false);
    expect(await bob.GM.handleGroupMessage(ID.alice, { type: 'image_complete', msgId: 'grp|m|' + gid + '|abcdefgh1236', base64: 'A'.repeat(6 * 1024 * 1024 + 4), mimeType: 'image/jpeg' })).toBe(false);
    expect(await bob.GM.handleGroupMessage(ID.alice, { type: 'image_complete', msgId: 'grp|m|../x|abcdefgh1237', base64: img, mimeType: 'image/jpeg' })).toBe(false);
    expect(mediaOf(await chatOf(bob, gid))).toHaveLength(0);
    // gueltig
    expect(await bob.GM.handleGroupMessage(ID.alice, { type: 'image_complete', msgId: 'grp|m|' + gid + '|abcdefgh1238', base64: img, mimeType: 'image/jpeg' })).toBe(true);
    expect(mediaOf(await chatOf(bob, gid))).toHaveLength(1);
    // Rueckstellung: hoechstens 3 Medien je unbekannter Gruppe - nur im RAM,
    // nie im gespeicherten Rueckstand (Audit G1).
    const unknown = 'g_' + 'e'.repeat(24);
    for (let i = 0; i < 6; i++) {
      await bob.GM.handleGroupMessage(ID.carol, { type: 'image_complete', msgId: 'grp|m|' + unknown + '|media' + String(i).padStart(7, '0'), base64: img, mimeType: 'image/jpeg' });
    }
    expect(bob.GM._pendingMediaCountForTests(unknown)).toBe(3);
    expect(await bob.ES.getItem('groups_pending')).toBeNull();
    // Senden an eine Gruppe, deren Mitglied offline ist, dann austreten: Medium verschwindet aus der Warteschlange
    const ac2 = await connect(alice, carol);
    ac2.close();
    const g2 = (await alice.GM.createGroup({ name: 'Zwei', description: '', memberContactIds: [ID.carol] })).group.groupId;
    await alice.GM.sendGroupMedia(g2, { kind: 'audio', base64: b64Of(3000, 2), durationMs: 1000 });
    expect((await queueOf(alice, 'carol')).some((i) => i.type === 'audio' && i.groupId === g2)).toBe(true);
    await alice.GM.leaveGroup(g2);
    await waitFor(async () => !(await queueOf(alice, 'carol')).some((i) => i.type === 'audio' && i.groupId === g2), 3000, 'Medium entfernt');
    // Absender-Seite: ungueltige Eingaben
    expect(await alice.GM.sendGroupMedia(gid, { kind: 'video', base64: img })).toEqual({ error: 'invalid' });
    expect(await alice.GM.sendGroupMedia(gid, { kind: 'image', base64: img, mimeType: 'application/pdf' })).toEqual({ error: 'invalid' });
    expect(await alice.GM.sendGroupMedia(gid, { kind: 'audio', base64: 'A'.repeat(8 * 1024 * 1024 + 4) })).toEqual({ error: 'too_large' });
    expect(await alice.GM.sendGroupMedia(gid, { kind: 'image', base64: 'A'.repeat(6 * 1024 * 1024 + 4), mimeType: 'image/jpeg' })).toEqual({ error: 'too_large' });
  });

  test('Audit G1: Medium vor der Einladung wartet nur im RAM und landet mit der Einladung im Verlauf; Gruppe loeschen entfernt die Dateien', async () => {
    const { alice, bob, carol } = await trio();
    const ab = await connect(alice, bob);
    await connect(alice, carol);
    await connect(bob, carol);
    ab.close(); // Alices Einladung erreicht Bob erst spaeter
    const gid = (await alice.GM.createGroup({ name: 'Spaet', memberContactIds: [ID.bob, ID.carol] })).group.groupId;
    await waitFor(async () => !!(await groupOf(carol, gid)));
    const img = b64Of(5000, 4);
    await carol.GM.sendGroupMedia(gid, { kind: 'image', base64: img, mimeType: 'image/jpeg' });
    await waitFor(() => bob.GM._pendingMediaCountForTests(gid) === 1, 5000, 'Medium bei Bob zurueckgestellt');
    expect(await bob.ES.getItem('groups_pending')).toBeNull();
    // Bestaetigt (keine Endlos-Wiederholung bei Carol).
    await waitFor(async () => !(await queueOf(carol, 'bob')).some((i) => i.type === 'image'), 5000, 'Warteschlange von Carol leer');
    await connect(alice, bob);
    await waitFor(async () => mediaOf(await chatOf(bob, gid)).length === 1, 8000, 'Medium nach Einladung im Verlauf');
    expect(bob.GM._pendingMediaCountForTests(gid)).toBe(0);
    expect(await contentOf(bob, gid, mediaOf(await chatOf(bob, gid))[0])).toBe(img);
    expect(mediaFilesOf(bob, gid)).toHaveLength(1);
    await bob.GM.deleteGroupLocally(gid);
    expect(mediaFilesOf(bob, gid)).toEqual([]);
  });

  test('Audit G1: Altbestand mit eingebettetem Base64 wird beim naechsten Speichern ausgelagert', async () => {
    const { alice, bob } = await trio();
    await connect(alice, bob);
    const gid = await createAndDistribute(alice, ['bob'], [bob]);
    const old = b64Of(4000, 6);
    const aMid = await alice.GM.getSelfMemberId();
    await bob.ES.setItem('gchat_' + gid, JSON.stringify([{ id: 'altbild00001', from: aMid, mine: false, type: 'image', mimeType: 'image/jpeg', base64: old, time: Date.now() }]));
    await alice.GM.sendGroupText(gid, 'neu');
    await waitFor(async () => textsOf(await chatOf(bob, gid)).includes('neu'), 5000, 'Text bei Bob');
    const [m] = mediaOf(await chatOf(bob, gid));
    expect(m.base64).toBeUndefined();
    expect(await contentOf(bob, gid, m)).toBe(old);
    expect(await bob.ES.getItem('gchat_' + gid)).not.toContain(old.slice(0, 64));
  });
});

describe('Audit 2026-10-19: G4-G8', () => {
  const stateFrom = (g, fromMid, extra = {}) => ({
    type: 'system', subtype: 'group_state', groupId: g.groupId, name: g.name, description: g.description || '',
    members: g.members.map((m) => ({ mid: m.mid, name: m.name })), admins: g.admins, createdBy: g.createdBy,
    createdAt: g.createdAt, rev: (g.rev || 1) + 1, ts: Date.now(), fromMid, ...extra,
  });

  test('G4: verlassene Gruppe kommt durch einen spaeter zugestellten Stand (Umbenennen) nicht zurueck - erneutes Hinzufuegen schon', async () => {
    const { alice, bob, carol } = await trio();
    const ab = await connect(alice, bob);
    await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const bMid = await bob.GM.getSelfMemberId();
    ab.close();
    await bob.GM.leaveGroup(gid);                                    // Austritt wartet bei Bob
    await alice.GM.updateGroupInfo(gid, { name: 'Neuer Name', description: '' });   // Bob steht bei Alice noch drin
    expect((await queueOf(alice, 'bob')).some((i) => i.subtype === 'group_state')).toBe(true);
    await connect(alice, bob);
    await waitFor(async () => !(await groupOf(alice, gid)).members.some((m) => m.mid === bMid), 5000, 'Austritt bei Alice');
    await waitFor(async () => !(await queueOf(alice, 'bob')).some((i) => i.subtype === 'group_state'), 5000, 'Stand zugestellt');
    await tick(50);
    expect(await groupOf(bob, gid)).toBeNull();                      // kein Zombie
    // Ausdrueckliches Hinzufuegen ist eine echte Einladung.
    expect((await alice.GM.addGroupMembers(gid, [ID.bob])).error).toBeUndefined();
    await waitFor(async () => !!(await groupOf(bob, gid)), 5000, 'erneut eingeladen');
    expect((await groupOf(bob, gid)).name).toBe('Neuer Name');
  });

  test('G4: Stand einer unbekannten Gruppe ohne create/add (oder add fuer andere) ist keine Einladung', async () => {
    const { alice, bob } = await trio();
    await connect(alice, bob);
    const aMid = await alice.GM.getSelfMemberId();
    const bMid = await bob.GM.getSelfMemberId();
    const g = { groupId: 'g_' + 'a'.repeat(24), name: 'Fremd', members: [{ mid: aMid, name: 'A' }, { mid: bMid, name: 'B' }], admins: [aMid], createdBy: aMid, createdAt: Date.now(), rev: 3 };
    for (const change of [{ kind: 'rename', by: aMid }, { kind: 'remove', by: aMid }, { kind: 'add', by: aMid, mids: ['m_' + 'f'.repeat(32)] }, { kind: 'add', by: aMid }]) {
      expect(await bob.GM.handleGroupMessage(ID.alice, stateFrom(g, aMid, { change }))).toBe(false);
    }
    expect(await groupOf(bob, g.groupId)).toBeNull();
    expect(await bob.GM.handleGroupMessage(ID.alice, stateFrom(g, aMid, { change: { kind: 'add', by: aMid, mids: [bMid] } }))).toBe(true);
    expect(await groupOf(bob, g.groupId)).not.toBeNull();
  });

  test('G5: Mitglied gibt sich im Einladungs-Wettlauf als Admin aus - der Ersteller holt die Rolle zurueck, mit Hinweis', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, carol);
    await connect(bob, carol);
    const ab = await connect(alice, bob);
    ab.close();                                                      // Alices Einladung erreicht Bob erst spaeter
    const g = (await alice.GM.createGroup({ name: 'Echt', memberContactIds: [ID.bob, ID.carol] })).group;
    await waitFor(async () => !!(await groupOf(carol, g.groupId)), 5000, 'Carol eingeladen');
    const aMid = await alice.GM.getSelfMemberId();
    const bMid = await bob.GM.getSelfMemberId();
    const cMid = await carol.GM.getSelfMemberId();
    // Carol faelscht eine Einladung an Bob mit sich als Admin und hohem Zaehler.
    const forged = stateFrom(g, cMid, { admins: [cMid], rev: 999999, change: { kind: 'add', by: cMid, mids: [bMid] } });
    expect(await bob.GM.handleGroupMessage(ID.carol, forged)).toBe(true);
    expect((await groupOf(bob, g.groupId)).admins).toEqual([cMid]);
    // Anderer Ersteller: Widerspruch, verworfen.
    expect(await bob.GM.handleGroupMessage(ID.carol, stateFrom(g, cMid, { admins: [cMid], rev: 1000000, createdBy: cMid, name: 'Weg' }))).toBe(false);
    // Alices echte Einladung kommt an: Ersteller ist Mitglied -> Rolle zurueck.
    await connect(alice, bob);
    await waitFor(async () => (await groupOf(bob, g.groupId))?.admins?.[0] === aMid, 5000, 'Ersteller wieder Admin');
    expect((await chatOf(bob, g.groupId)).some((m) => m.sys && /Ersteller der Gruppe hat das korrigiert/.test(m.text))).toBe(true);
    // Carol kann jetzt nichts mehr aendern.
    expect(await bob.GM.handleGroupMessage(ID.carol, stateFrom(await groupOf(bob, g.groupId), cMid, { admins: [cMid], rev: 2000000, name: 'Gekapert' }))).toBe(false);
    expect((await groupOf(bob, g.groupId)).name).toBe('Echt');
  });

  test('G6: Aenderungen werden dem tatsaechlichen Absender zugeschrieben, nicht change.by', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const aMid = await alice.GM.getSelfMemberId();
    const cMid = await carol.GM.getSelfMemberId();
    const g = await groupOf(alice, gid);
    expect(await bob.GM.handleGroupMessage(ID.alice, stateFrom(g, aMid, { name: 'Umbenannt', rev: g.rev + 5, change: { kind: 'rename', by: cMid } }))).toBe(true);
    const notes = (await chatOf(bob, gid)).filter((m) => m.sys).map((m) => m.text);
    expect(notes).toContain('Alice hat die Gruppe in „Umbenannt“ umbenannt');
    expect(notes.some((t) => t.startsWith('Carol hat die Gruppe'))).toBe(false);
  });

  test('G7: Einladungen ueber der Obergrenze je Kontakt werden ignoriert', async () => {
    const { alice, bob } = await trio();
    await connect(alice, bob);
    const aMid = await alice.GM.getSelfMemberId();
    const bMid = await bob.GM.getSelfMemberId();
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      const g = { groupId: 'g_' + String(i).padStart(24, '0'), name: 'Flut ' + i, members: [{ mid: aMid, name: 'A' }, { mid: bMid, name: 'B' }], admins: [aMid], createdBy: aMid, createdAt: Date.now(), rev: 0 };
      if (await bob.GM.handleGroupMessage(ID.alice, stateFrom(g, aMid, { change: { kind: 'create', by: aMid } }))) accepted++;
    }
    expect(accepted).toBe(16);
    expect((await groupsOf(bob)).filter((g) => g.groupId.startsWith('g_0000')).length).toBe(16);
  });

  test('G8: entferntes Mitglied bekommt noch wartende Gruppen-Inhalte nicht mehr - die Entfernung selbst schon', async () => {
    const { alice, bob, carol } = await trio();
    await connect(alice, bob);
    const ac = await connect(alice, carol);
    const gid = await createAndDistribute(alice, ['bob', 'carol'], [bob, carol]);
    const cMid = await carol.GM.getSelfMemberId();
    ac.close();
    await alice.GM.sendGroupText(gid, 'Nur fuer Mitglieder');
    await alice.GM.sendGroupMedia(gid, { kind: 'audio', base64: 'QUJD'.repeat(100), durationMs: 500 });
    expect((await queueOf(alice, 'carol')).some((i) => i.subtype === 'group_text')).toBe(true);
    expect((await alice.GM.removeGroupMember(gid, cMid)).error).toBeUndefined();
    const q = await queueOf(alice, 'carol');
    expect(q.some((i) => i.groupId === gid && (i.subtype === 'group_text' || i.type === 'audio'))).toBe(false);
    expect(q.some((i) => i.subtype === 'group_state')).toBe(true);
  });
});

describe('Koppeln und gleich in die Gruppe / Anheften', () => {
  test('Einladung meldet sich beim Eingeladenen (App oeffnet dann den Gruppenchat); Anheften bleibt bei Aenderungen erhalten', async () => {
    const { alice, bob } = await trio();
    await connect(alice, bob);
    const invites = [];
    bob.GM.setGroupInviteListener((gid, contactId) => invites.push([gid, contactId]));
    const gid = await createAndDistribute(alice, ['bob'], [bob]);
    await waitFor(() => invites.length === 1, 3000, 'Einladungs-Meldung');
    expect(invites[0]).toEqual([gid, ID.alice]);
    // Aenderung (Umbenennen) ist keine neue Einladung
    expect(await bob.GM.setGroupPinned(gid, true)).toBe(true);
    await alice.GM.updateGroupInfo(gid, { name: 'Neuer Name', description: '' });
    await waitFor(async () => (await groupOf(bob, gid))?.name === 'Neuer Name');
    expect(invites).toHaveLength(1);
    expect((await groupOf(bob, gid)).pinned).toBe(true);
    expect(await bob.GM.setGroupPinned(gid, false)).toBe(true);
    expect((await groupOf(bob, gid)).pinned).toBe(false);
    expect(await bob.GM.setGroupPinned('g_' + '9'.repeat(24), true)).toBe(false);
  });
});
