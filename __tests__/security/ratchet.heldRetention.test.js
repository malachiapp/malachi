// Krypto-Review 2026-10-25, V4/K-08: Aufbewahrung des KEM-Vorrats "held"
// (RatchetSession.js, heldNeededSince/pruneHeld). Ein held-Eintrag ist das
// rohe Verbindungsgeheimnis einer frueheren Verbindung - er soll so kurz wie
// moeglich liegen bleiben (Normalfall: rund 8 Tage statt bisher 30), darf
// aber NIE verschwinden, solange die Gegenseite ihn schon in eine Kette
// eingemischt haben kann, die hier noch nicht angekommen ist (sonst bekaeme
// diese Richtung dauerhaft "kem-unknown" - Kontakt halb entkoppelt).
//
// Zwei "Geraete" mit eigenem Speicher (wie ratchet.doubleRatchet.test.js,
// Teil 2), die Uhr ist per Date.now steuerbar.
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

const DR = require('../../DoubleRatchet');

const DAY = 24 * 60 * 60 * 1000;
const ALICE_ID = 'c_bob';  // so heisst Bob bei Alice
const BOB_ID = 'c_alice';  // so heisst Alice bei Bob
const kemSecret = () => crypto.randomBytes(32).toString('base64');

let clock = 0;
beforeEach(() => {
  clock = Date.UTC(2026, 9, 25, 12, 0, 0);
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  global.__mockStores = {};
});
afterEach(() => { jest.restoreAllMocks(); });

function loadSession(device, peerId, role) {
  global.__mockDevice = device;
  let mod;
  let ES;
  jest.isolateModules(() => {
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    mod = require('../../RatchetSession');
    ES = require('react-native-encrypted-storage').default;
  });
  global.__mockDevice = undefined;
  return { RS: mod, ES, peerId, role, async setup() {
    await ES.setItem('contacts', JSON.stringify([{ id: peerId, name: 'x', role }]));
  } };
}

async function twoDevices() {
  const a = loadSession('alice', ALICE_ID, 'initiator');
  const b = loadSession('bob', BOB_ID, 'responder');
  await a.setup();
  await b.setup();
  await a.RS.notePeerCaps(ALICE_ID, true);
  await b.RS.notePeerCaps(BOB_ID, true);
  return { a, b, conn: kemSecret() };
}

const sealText = (d, text, conn) => d.RS.seal(d.peerId, JSON.stringify({ t: text }), { connSecret: conn });
const openText = async (d, env, conn = 'keine-kandidaten') => JSON.parse(await d.RS.open(d.peerId, env, { candidates: [conn] })).t;
const record = (d) => JSON.parse(d.ES.__store.get('ratchet_' + d.peerId));
const heldKids = (d) => record(d).held.map((e) => e.kid);

// Neue Verbindung: Alice entkapselt (own), Bob kapselt (held) - wie in
// WebRTCManager, Alice ist Initiator der Verbindung.
async function newConnection(a, b) {
  const kem = kemSecret();
  await b.RS.noteConnectionKem(BOB_ID, kem, 'encap');
  await a.RS.noteConnectionKem(ALICE_ID, kem, 'decap');
  return { kem, kid: DR.kemId(kem) };
}

// Sitzung steht, Alice hat zuletzt einen DH-Schritt gemacht und das Geheimnis
// einer neuen Verbindung in ihre neue Kette gemischt - die erste Nachricht
// dieser Kette ist aber noch nicht bei Bob.
async function pendingChainWithKem() {
  const { a, b, conn } = await twoDevices();
  await openText(b, await sealText(a, 'start', conn), conn);
  await openText(a, await sealText(b, 'ok', conn), conn);
  await openText(b, await sealText(a, 'a2', conn), conn);       // Bob: neuer Schluessel
  const { kid } = await newConnection(a, b);
  const fromBob = await sealText(b, 'b2', conn);                 // Bob sendet mit dem neuen Schluessel
  await openText(a, fromBob, conn);                              // Alice: DH-Schritt, mischt kid ein
  const pending = await sealText(a, 'ausstehend', conn);
  expect(pending.h.k).toEqual([kid]);
  expect(heldKids(b)).toContain(kid);
  return { a, b, conn, kid, pending };
}

describe('V4: KEM-Vorrat "held" - so kurz wie moeglich, aber nie zu kurz', () => {
  test('20 Tage Funkstille: die bereits eingemischte, noch ausstehende Kette der Gegenseite bleibt lesbar', async () => {
    const { a, b, conn, kid, pending } = await pendingChainWithKem();
    clock += 20 * DAY;
    // Neue Verbindungen nach der Pause (jede raeumt den Vorrat auf).
    for (let i = 0; i < 3; i++) await newConnection(a, b);
    expect(heldKids(b)).toContain(kid);
    expect(await openText(b, pending, conn)).toBe('ausstehend');
    // verbraucht -> weg
    expect(heldKids(b)).not.toContain(kid);
    // Gespraech laeuft in beide Richtungen weiter.
    expect(await openText(a, await sealText(b, 'weiter', conn), conn)).toBe('weiter');
    expect(await openText(b, await sealText(a, 'und weiter', conn), conn)).toBe('und weiter');
  });

  test('viele Verbindungen ohne Nachricht der Gegenseite: der benoetigte Eintrag wird nicht verdraengt (vorher: nur die 32 juengsten)', async () => {
    const { a, b, conn, kid, pending } = await pendingChainWithKem();
    for (let i = 0; i < 40; i++) {
      clock += 60 * 60 * 1000;
      await newConnection(a, b);
    }
    expect(heldKids(b)).toContain(kid);
    expect(record(b).held.length).toBeLessThanOrEqual(64);
    expect(await openText(b, pending, conn)).toBe('ausstehend');
  });

  test('nicht mehr benoetigte Eintraege verschwinden nach rund 8 Tagen (Gegenseite mischt nur bis 7 Tage)', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await openText(a, await sealText(b, 'ok', conn), conn);
    // Verbindung, deren Geheimnis Alice NICHT bekommt (z.B. Ciphertext verloren).
    const lost = kemSecret();
    await b.RS.noteConnectionKem(BOB_ID, lost, 'encap');
    const lostKid = DR.kemId(lost);
    clock += 7 * DAY;
    await openText(b, await sealText(a, 'nach 7 Tagen', conn), conn);   // Bob: DH-Schritt, ns = 0
    expect(heldKids(b)).toContain(lostKid);                            // noch innerhalb 7 Tage + Spielraum
    clock += 1.5 * DAY;
    await newConnection(a, b);
    expect(heldKids(b)).not.toContain(lostKid);                        // 8,5 Tage -> weg
  });

  test('laufendes Gespraech ueber 30 Tage mit taeglichen Verbindungen: kein held-Eintrag wird aelter als 9 Tage', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await openText(a, await sealText(b, 'ok', conn), conn);
    let maxAge = 0;
    for (let day = 0; day < 30; day++) {
      clock += DAY;
      await newConnection(a, b);
      // Manche Verbindungen erreichen Alice nicht (nur Bob traegt ein).
      if (day % 3 === 0) await b.RS.noteConnectionKem(BOB_ID, kemSecret(), 'encap');
      await openText(b, await sealText(a, 'a' + day, conn), conn);
      await openText(a, await sealText(b, 'b' + day, conn), conn);
      for (const e of record(b).held) maxAge = Math.max(maxAge, clock - e.t);
    }
    expect(maxAge).toBeLessThanOrEqual(9 * DAY);
    expect(maxAge).toBeLessThan(14 * DAY);
  });

  test('Altbestand aus 1.0/1.1 (Zustand ohne Sendeketten-Zeitpunkt): bisheriges Verhalten (30 Tage), nichts geht durch das Update verloren', async () => {
    const { a, b, conn, kid, pending } = await pendingChainWithKem();
    // Speicherabbild wie von 1.1 geschrieben: kein "sa" im Zustand.
    const rec = record(b);
    expect(rec.s.ns).toBeGreaterThan(0);
    delete rec.s.sa;
    b.ES.__store.set('ratchet_' + BOB_ID, JSON.stringify(rec));
    const b2 = loadSession('bob', BOB_ID, 'responder');           // Neustart mit neuer Version
    clock += 20 * DAY;
    await b2.RS.noteConnectionKem(BOB_ID, kemSecret(), 'encap');
    expect(heldKids(b2)).toContain(kid);                            // 20 Tage: bleibt wie in 1.1
    expect(await openText(b2, pending, conn)).toBe('ausstehend');
    // Nach dem DH-Schritt gilt die neue Regel.
    expect(record(b2).s.sa).toBeUndefined();
    expect(record(b2).s.ns).toBe(0);
    expect(await openText(a, await sealText(b2, 'antwort', conn), conn)).toBe('antwort');
    expect(Number.isFinite(record(b2).s.sa)).toBe(true);
  });

  test('Altbestand: aelter als 30 Tage faellt wie bisher weg', async () => {
    const { b } = await pendingChainWithKem();
    const old = kemSecret();
    await b.RS.noteConnectionKem(BOB_ID, old, 'encap');
    const rec = record(b);
    delete rec.s.sa;
    b.ES.__store.set('ratchet_' + BOB_ID, JSON.stringify(rec));
    const b2 = loadSession('bob', BOB_ID, 'responder');
    clock += 31 * DAY;
    await b2.RS.noteConnectionKem(BOB_ID, kemSecret(), 'encap');
    expect(heldKids(b2)).not.toContain(DR.kemId(old));
  });

  test('ohne Sitzung (nur Startgeheimnisse): hoechstens 14 Tage und 8 Eintraege', async () => {
    const b = loadSession('bob', BOB_ID, 'responder');
    await b.setup();
    await b.RS.notePeerCaps(BOB_ID, true);
    const first = kemSecret();
    await b.RS.noteConnectionKem(BOB_ID, first, 'encap');
    clock += 13 * DAY;
    await b.RS.noteConnectionKem(BOB_ID, kemSecret(), 'encap');
    expect(heldKids(b)).toContain(DR.kemId(first));
    clock += 2 * DAY;
    await b.RS.noteConnectionKem(BOB_ID, kemSecret(), 'encap');
    expect(heldKids(b)).not.toContain(DR.kemId(first));
    for (let i = 0; i < 12; i++) await b.RS.noteConnectionKem(BOB_ID, kemSecret(), 'encap');
    expect(record(b).held.length).toBe(8);
  });

  test('Sendeketten-Zeitpunkt: wird mit der ersten Nachricht einer Kette gesetzt und beim DH-Schritt geloescht', async () => {
    const { a, b, conn } = await twoDevices();
    const t0 = clock;
    const env = await sealText(a, 'start', conn);
    expect(record(a).s.sa).toBe(t0);
    clock += 1000;
    await sealText(a, 'zweite', conn);
    expect(record(a).s.sa).toBe(t0);                       // nicht verschoben
    await openText(b, env, conn);
    expect(record(b).s.sa).toBeUndefined();                // Bob hat noch nichts gesendet
    expect(record(b).s.ns).toBe(0);
    expect(DR.PROTOCOL_VERSION).toBe(1);                   // Leitungsformat unveraendert
  });
});
