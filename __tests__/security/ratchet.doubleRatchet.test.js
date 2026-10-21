// Double Ratchet mit Post-Quanten-Schritt (DoubleRatchet.js, RatchetSession.js)
// - spezifikationsnahe Tests nach https://signal.org/docs/specifications/
// doubleratchet/ (Abschnitte 3.2-3.5, 4) plus die Malachi-Erweiterungen
// (KEM-Geheimnisse im Root Key, Initialisierung aus dem Verbindungs-
// Geheimnis, gleichzeitiger Aufbau, Downgrade-Schutz, Loeschen).
//
// Teil 1 prueft den reinen Algorithmus (Zustand im Speicher), Teil 2 die
// Sitzungsverwaltung mit Speicher/Sperre (zwei "Geraete" mit eigenem
// EncryptedStorage, wie in outbox.deliveryGuarantee.test.js).
const crypto = require('crypto');
const { Buffer } = require('buffer');

jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: async (k, v) => {
        if (global.__failSetItem?.(dev, k)) throw new Error('Speicher voll (simuliert)');
        // Haelt einen Schreibvorgang an (Operation "mitten im Speichern").
        const gate = global.__setItemGate;
        if (gate && gate.dev === dev && String(k).startsWith('ratchet_')) {
          gate.hit();
          await gate.promise;
        }
        store.set(k, String(v));
      },
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      removeItem: async (k) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

const DR = require('../../DoubleRatchet');

const rng = async (n) => Uint8Array.from(crypto.randomBytes(n));
const kemSecret = () => crypto.randomBytes(32).toString('base64');
const txt = (s) => Uint8Array.from(Buffer.from(s, 'utf8'));
const str = (u8) => Buffer.from(u8).toString('utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));

// Deterministische Zufallsquelle (fuer Vergleichslaeufe "mit/ohne KEM").
function seededRng(seed) {
  let ctr = 0;
  return async (n) => {
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const block = crypto.createHash('sha256').update(seed + '|' + (ctr++)).digest();
      block.copy(out, off);
      off += block.length;
    }
    return Uint8Array.from(out);
  };
}

// Zwei Parteien im Speicher. kemsA/kemsB: eigene (entkapselte) KEM-Geheimnisse,
// die beim naechsten eigenen DH-Schritt eingemischt werden; known: was die
// jeweilige Seite nachschlagen kann (Kennung -> Geheimnis).
async function pair({ rngA = rng, rngB = rng, secret = kemSecret() } = {}) {
  const now = Date.now();
  const A = { s: await DR.initAlice(secret, { now, rng: rngA }), rng: rngA, own: [], known: new Map() };
  const B = { s: DR.initBob(secret, { now }), rng: rngB, own: [], known: new Map() };
  return { A, B, secret };
}

async function send(P, text) {
  const work = clone(P.s);
  const env = await DR.encrypt(work, txt(text), { rng: P.rng });
  P.s = work;
  return env;
}

// Wie RatchetSession.open: auf einer Kopie, bei Fehler bleibt der Zustand.
async function recv(P, env, now = Date.now()) {
  const work = clone(P.s);
  const res = await DR.decrypt(work, env, {
    now, rng: P.rng,
    lookupKem: (kid) => P.known.get(kid) || null,
    takeOwnKems: () => P.own.splice(0),
  });
  P.s = work;
  P.s.active = true;
  return str(res.plaintext);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('Teil 1: Double Ratchet (Spezifikation 3.2-3.5)', () => {
  test('Grundablauf in beide Richtungen', async () => {
    const { A, B } = await pair();
    expect(await recv(B, await send(A, 'Hallo Bob'))).toBe('Hallo Bob');
    expect(await recv(A, await send(B, 'Hallo Alice'))).toBe('Hallo Alice');
    expect(await recv(B, await send(A, 'Wie geht es?'))).toBe('Wie geht es?');
  });

  test('viele Nachrichten in Folgen beider Seiten, jede mit eigenem Schluessel', async () => {
    const { A, B } = await pair();
    const seenCiphertexts = new Set();
    for (let round = 0; round < 15; round++) {
      const [S, R] = round % 2 ? [B, A] : [A, B];
      for (let i = 0; i < 1 + (round % 4); i++) {
        const env = await send(S, `r${round}-m${i}`);
        expect(seenCiphertexts.has(env.c)).toBe(false);
        seenCiphertexts.add(env.c);
        expect(await recv(R, env)).toBe(`r${round}-m${i}`);
      }
    }
  });

  test('Sprecherwechsel: jeder Wechsel bringt einen neuen Ratchet-Schluessel und einen neuen Root Key', async () => {
    const { A, B } = await pair();
    const keys = [];
    const roots = [];
    let S = A;
    let R = B;
    for (let i = 0; i < 6; i++) {
      const e1 = await send(S, 'a' + i);
      const e2 = await send(S, 'b' + i);
      expect(e1.h.d).toBe(e2.h.d); // innerhalb einer Kette gleicher Schluessel
      expect([e1.h.n, e2.h.n]).toEqual([0, 1]);
      keys.push(e1.h.d);
      await recv(R, e1);
      await recv(R, e2);
      roots.push(R.s.rk);
      [S, R] = [R, S];
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(roots).size).toBe(roots.length);
  });

  test('Nachrichten ausser der Reihe (auch ueber Kettengrenzen hinweg) werden alle genau einmal entschluesselt', async () => {
    const { A, B } = await pair();
    const envs = [];
    for (let i = 0; i < 5; i++) envs.push([await send(A, 'a1-' + i), 'a1-' + i]);
    expect(await recv(B, envs[0][0])).toBe('a1-0');      // Bob braucht eine Nachricht fuer seinen ersten Schritt
    expect(await recv(A, await send(B, 'b1'))).toBe('b1');
    for (let i = 0; i < 5; i++) envs.push([await send(A, 'a2-' + i), 'a2-' + i]);
    const rest = shuffle(envs.slice(1));
    for (const [env, expected] of rest) expect(await recv(B, env)).toBe(expected);
    expect(DR.skippedCount(B.s)).toBe(0); // alle gespeicherten Schluessel verbraucht und geloescht
  });

  test('verlorene Nachrichten: spaetere werden gelesen, die Luecke bleibt als begrenzter gespeicherter Schluessel', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    await send(A, 'verloren 1');
    await send(A, 'verloren 2');
    expect(await recv(B, await send(A, 'kommt an'))).toBe('kommt an');
    expect(DR.skippedCount(B.s)).toBe(2);
    // Gespraech laeuft weiter - auch nach mehreren Sprecherwechseln.
    expect(await recv(A, await send(B, 'antwort'))).toBe('antwort');
    expect(await recv(B, await send(A, 'weiter'))).toBe('weiter');
  });

  test('Limit fuer uebersprungene Schluessel: mehr als MAX_SKIP pro Nachricht wird abgelehnt, ohne den Zustand zu veraendern', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    const before = clone(B.s);
    const env = await send(A, 'x');
    const forged = { ...env, h: { ...env.h, n: DR.MAX_SKIP + 5 } };
    await expect(recv(B, forged)).rejects.toMatchObject({ code: 'too-many-skipped' });
    expect(B.s).toEqual(before);
    expect(await recv(B, env)).toBe('x');
  });

  test('Gesamtvorrat gespeicherter Schluessel ist begrenzt (aelteste fallen weg) und laeuft ab', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    // Viermal 400 verlorene Nachrichten, jeweils gefolgt von einer, die ankommt.
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 400; i++) await send(A, 'weg');
      await recv(B, await send(A, 'da' + k));
      expect(DR.skippedCount(B.s)).toBeLessThanOrEqual(DR.MAX_SKIPPED_KEYS);
    }
    expect(DR.skippedCount(B.s)).toBe(DR.MAX_SKIPPED_KEYS);
    // Ablauf: beim naechsten Empfang nach der Frist ist der Vorrat leer.
    const later = Date.now() + DR.SKIPPED_KEY_MAX_AGE_MS + 1000;
    await recv(B, await send(A, 'spaeter'), later);
    expect(DR.skippedCount(B.s)).toBe(0);
  });

  test('Forward Secrecy: ein benutzter Nachrichtenschluessel ist danach nicht mehr im Zustand - wer den Zustand spaeter stiehlt, liest frueheres nicht', async () => {
    const { A, B } = await pair();
    const recorded = [];
    for (let i = 0; i < 4; i++) {
      const e = await send(A, 'vergangen ' + i);
      recorded.push(e);
      await recv(B, e);
      if (i === 1) await recv(A, await send(B, 'zwischendurch'));
    }
    // Angreifer erbeutet Bobs kompletten aktuellen Zustand ...
    const stolen = { s: clone(B.s), rng, own: [], known: new Map() };
    // ... und versucht die mitgeschnittenen, bereits gelesenen Nachrichten.
    for (const e of recorded) await expect(recv(stolen, e)).rejects.toBeTruthy();
    // Bob selbst kann sie auch nicht noch einmal oeffnen (Schluessel geloescht).
    for (const e of recorded) await expect(recv(B, e)).rejects.toBeTruthy();
    // Im gespeicherten Zustand steht kein Nachrichtenschluessel einer gelesenen Nachricht.
    expect(DR.skippedCount(B.s)).toBe(0);
  });

  test('Post-Compromise Security: nach Diebstahl des Zustands und einem DH-Schritt in beide Richtungen liest der Angreifer nicht mehr mit', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'vorher'));
    await recv(A, await send(B, 'vorher zurueck'));
    await recv(B, await send(A, 'noch vorher'));
    // Angreifer kopiert Bobs kompletten Zustand (z.B. Geraet kurz in fremder
    // Hand) und hoert danach passiv mit: er bekommt jede Nachricht, die an
    // Bob geht, und fuehrt seine Kopie damit weiter, so gut er kann.
    const eve = { s: clone(B.s), rng, own: [], known: new Map() };
    const eveReads = async (env) => { try { return await recv(eve, clone(env)); } catch { return null; } };
    // Unmittelbar danach liest er mit (unvermeidbar - er hat den Zustand) ...
    const e1 = await send(A, 'noch lesbar (gleiche Kette)');
    expect(await eveReads(e1)).toBe('noch lesbar (gleiche Kette)');
    await recv(B, e1);
    // ... auch Alices naechste Kette, solange Bob seinen (gestohlenen)
    // privaten Ratchet-Schluessel noch nicht ersetzt hat.
    await recv(A, await send(B, 'Bob antwortet'));
    const e2 = await send(A, 'Alice, neue Kette gegen Bobs alten Schluessel');
    expect(await eveReads(e2)).toBe('Alice, neue Kette gegen Bobs alten Schluessel');
    await recv(B, e2); // Bob erzeugt hier ein frisches Schluesselpaar
    // Heilung: ab Bobs frischem Schluessel fehlt Eve ein privater Schluessel.
    const e3 = await send(B, 'Bob, nach der Heilung');
    await recv(A, e3);
    const e4 = await send(A, 'Alice, nach der Heilung');
    expect(await eveReads(e4)).toBeNull();
    await recv(B, e4);
    const e5 = await send(A, 'Alice, weiter');
    expect(await eveReads(e5)).toBeNull();
    expect(await recv(B, e5)).toBe('Alice, weiter');
  });

  test('gleichzeitiges Senden beider Seiten (Nachrichten kreuzen sich)', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    const fromA = [];
    const fromB = [];
    for (let i = 0; i < 3; i++) {
      fromA.push(await send(A, 'A' + i));
      fromB.push(await send(B, 'B' + i));
    }
    // Zustellung verschraenkt, jeweils bevor die andere Seite etwas gelesen hat.
    for (let i = 0; i < 3; i++) {
      expect(await recv(B, fromA[i])).toBe('A' + i);
      expect(await recv(A, fromB[i])).toBe('B' + i);
    }
    // Danach geht es normal weiter, in beide Richtungen.
    for (let i = 0; i < 3; i++) {
      fromA.push(await send(A, 'A2-' + i));
      fromB.push(await send(B, 'B2-' + i));
    }
    for (let i = 3; i < 6; i++) {
      expect(await recv(A, fromB[i])).toBe('B2-' + (i - 3));
      expect(await recv(B, fromA[i])).toBe('A2-' + (i - 3));
    }
  });

  test('Manipulation: jedes Header-Feld und jedes Chiffrat-Bit ist authentifiziert, der Zustand bleibt unveraendert', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    await recv(A, await send(B, 'zurueck'));
    const env = await send(A, 'echt');
    const before = clone(B.s);
    const otherKey = Buffer.from(crypto.randomBytes(32)).toString('base64');
    const variants = [
      { ...env, h: { ...env.h, n: env.h.n + 1 } },
      { ...env, h: { ...env.h, pn: env.h.pn + 1 } },
      { ...env, h: { ...env.h, d: otherKey } },
      { ...env, h: { ...env.h, k: [DR.kemId(kemSecret())] } },
      { ...env, h: { ...env.h, i: DR.kemId(kemSecret()) } },
      { ...env, v: 2 },
      { ...env, c: (() => { const b = Buffer.from(env.c, 'base64'); b[b.length - 1] ^= 1; return b.toString('base64'); })() },
      { ...env, c: (() => { const b = Buffer.from(env.c, 'base64'); b[30] ^= 0x80; return b.toString('base64'); })() },
      { ...env, c: (() => { const b = Buffer.from(env.c, 'base64'); b[3] ^= 1; return b.toString('base64'); })() }, // Nonce
      { ...env, c: Buffer.from(env.c, 'base64').subarray(0, Buffer.from(env.c, 'base64').length - 3).toString('base64') }, // gekuerzt
      { ...env, c: Buffer.concat([Buffer.from(env.c, 'base64'), Buffer.from([0])]).toString('base64') },                   // verlaengert
    ];
    for (const v of variants) {
      await expect(recv(B, v)).rejects.toBeTruthy();
      expect(B.s).toEqual(before);
    }
    expect(await recv(B, env)).toBe('echt');
  });

  test('Replay: eine bereits gelesene Nachricht wird abgelehnt - in der laufenden wie in einer abgeschlossenen Kette', async () => {
    const { A, B } = await pair();
    const e1 = await send(A, 'einmal');
    await recv(B, e1);
    await expect(recv(B, e1)).rejects.toMatchObject({ code: 'replay' });
    await recv(A, await send(B, 'wechsel'));
    await recv(B, await send(A, 'neue Kette'));
    await expect(recv(B, e1)).rejects.toMatchObject({ code: 'replay' });
  });

  test('ungueltige Umschlaege werden vor jeder Rechnung abgelehnt', () => {
    expect(() => DR.validateEnvelope(null)).toThrow();
    expect(() => DR.validateEnvelope({ type: 'ratchet', v: 1, h: { d: 'x', pn: 0, n: 0 }, c: 'A'.repeat(80) })).toThrow();
    const d = Buffer.alloc(32, 7).toString('base64');
    expect(() => DR.validateEnvelope({ type: 'ratchet', v: 1, h: { d, pn: -1, n: 0 }, c: 'A'.repeat(80) })).toThrow();
    expect(() => DR.validateEnvelope({ type: 'ratchet', v: 1, h: { d, pn: 0, n: 1.5 }, c: 'A'.repeat(80) })).toThrow();
    expect(() => DR.validateEnvelope({ type: 'ratchet', v: 1, h: { d, pn: 0, n: 0, k: Array(5).fill(DR.kemId(kemSecret())) }, c: 'A'.repeat(80) })).toThrow();
    expect(() => DR.validateEnvelope({ type: 'ratchet', v: 1, h: { d, pn: 0, n: 0 }, c: 'A'.repeat(20) })).toThrow();
    expect(DR.validateEnvelope({ type: 'ratchet', v: 1, h: { d, pn: 0, n: 0, x: 'ignoriert' }, c: 'A'.repeat(80) })).toEqual({ d, pn: 0, n: 0 });
  });
});

describe('Teil 1b: Post-Quanten-Schritt (KEM-Geheimnisse im Root Key)', () => {
  test('das KEM-Geheimnis fliesst in den naechsten eigenen DH-Schritt, die Gegenseite rechnet es nach und es wird danach verbraucht', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    await recv(A, await send(B, 'Bob vor dem KEM-Schritt'));
    // Neue Verbindung: Alice hat entkapselt (own), Bob hat gekapselt (known).
    const kem = kemSecret();
    const kid = DR.kemId(kem);
    A.own.push({ kid, secret: kem });
    B.known.set(kid, kem);
    // Alices naechster EIGENER Schritt kommt erst mit Bobs naechstem neuen
    // Ratchet-Schluessel - und den erzeugt Bob, sobald er Alices aktuelle
    // Kette sieht (Wechsel der Sprecher).
    expect((await send(A, 'aktuelle Kette')).h.k).toBeUndefined();
    await recv(B, await send(A, 'Alice, noch ohne KEM'));
    await recv(A, await send(B, 'loest Alices naechsten Schritt aus'));
    const env = await send(A, 'nach dem KEM-Schritt');
    expect(env.h.k).toEqual([kid]);
    const res = await (async () => {
      const work = clone(B.s);
      const r = await DR.decrypt(work, env, { now: Date.now(), rng, lookupKem: (k) => B.known.get(k) || null, takeOwnKems: () => [] });
      B.s = work;
      return r;
    })();
    expect(str(res.plaintext)).toBe('nach dem KEM-Schritt');
    expect(res.consumedKids).toEqual([kid]);
    // Weitere Nachrichten derselben Kette tragen dieselbe Kennung.
    expect((await send(A, 'gleiche Kette')).h.k).toEqual([kid]);
  });

  test('der KEM-Schritt veraendert den Root Key (Vergleichslauf mit identischer Zufallsquelle ohne KEM)', async () => {
    const secret = kemSecret();
    const kem = kemSecret();
    const run = async (withKem) => {
      const { A, B } = await pair({ rngA: seededRng('a'), rngB: seededRng('b'), secret });
      await recv(B, await send(A, 'start'));
      if (withKem) {
        A.own.push({ kid: DR.kemId(kem), secret: kem });
        B.known.set(DR.kemId(kem), kem);
      }
      await recv(A, await send(B, 'antwort'));          // Alices Schritt (mit KEM)
      const rkA = A.s.rk;
      expect(await recv(B, await send(A, 'schritt'))).toBe('schritt'); // Bob rechnet nach
      expect(await recv(A, await send(B, 'weiter'))).toBe('weiter');
      return { rkA, rkB: B.s.rk };
    };
    const without = await run(false);
    const withK = await run(true);
    // Gleiche Zufallsquelle, einziger Unterschied ist das KEM-Geheimnis: der
    // Root Key beider Seiten unterscheidet sich ab Alices Schritt - und beide
    // Seiten kommen trotzdem miteinander klar (siehe recv oben).
    expect(withK.rkA).not.toBe(without.rkA);
    expect(withK.rkB).not.toBe(without.rkB);
  });

  test('ohne das KEM-Geheimnis kommt man nicht weiter - selbst mit allen privaten DH-Schluesseln (Modell: Angreifer bricht X25519)', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    const kem = kemSecret();
    const kid = DR.kemId(kem);
    A.own.push({ kid, secret: kem });
    B.known.set(kid, kem);
    await recv(A, await send(B, 'antwort'));
    // "Quantencomputer"-Angreifer: kennt Bobs kompletten Zustand inklusive
    // aller privaten DH-Schluessel, aber nicht das ML-KEM-Geheimnis.
    const eve = { s: clone(B.s), rng, own: [], known: new Map() };
    const env = await send(A, 'nach dem KEM-Schritt');
    await expect(recv(eve, clone(env))).rejects.toMatchObject({ code: 'kem-unknown' });
    eve.known.set(kid, kemSecret()); // falsch geraten
    await expect(recv(eve, clone(env))).rejects.toMatchObject({ code: 'auth' });
    expect(await recv(B, env)).toBe('nach dem KEM-Schritt');
  });

  test('Initialisierung: beide Seiten leiten aus demselben Verbindungsgeheimnis dieselbe Sitzung ab, ein anderes Geheimnis passt nicht', async () => {
    const secret = kemSecret();
    const A = { s: await DR.initAlice(secret, { now: Date.now(), rng }), rng, own: [], known: new Map() };
    const wrong = { s: DR.initBob(kemSecret(), { now: Date.now() }), rng, own: [], known: new Map() };
    const env = await send(A, 'hallo');
    expect(env.h.i).toBe(DR.kemId(secret));
    await expect(recv(wrong, env)).rejects.toBeTruthy();
    const B = { s: DR.initBob(secret, { now: Date.now() }), rng, own: [], known: new Map() };
    expect(await recv(B, env)).toBe('hallo');
    // Nach der ersten Antwort sendet Alice die Initialisierungs-Kennung nicht mehr.
    await recv(A, await send(B, 'antwort'));
    expect((await send(A, 'weiter')).h.i).toBeUndefined();
  });
});

// ─── Teil 2: Sitzungsverwaltung ──────────────────────────────────────────────
const ALICE_ID = 'c_bob';  // so heisst Bob bei Alice
const BOB_ID = 'c_alice';  // so heisst Alice bei Bob

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
  global.__mockStores = {};
  const a = loadSession('alice', ALICE_ID, 'initiator');
  const b = loadSession('bob', BOB_ID, 'responder');
  await a.setup();
  await b.setup();
  await a.RS.notePeerCaps(ALICE_ID, true);
  await b.RS.notePeerCaps(BOB_ID, true);
  return { a, b, conn: kemSecret() };
}

const sealText = (d, text, conn) => d.RS.seal(d.peerId, JSON.stringify({ t: text }), { connSecret: conn });
const openText = async (d, env, conn) => JSON.parse(await d.RS.open(d.peerId, env, { candidates: [conn] })).t;

describe('Teil 2: RatchetSession (Speicher, Sperre, Aufbau, Downgrade-Schutz)', () => {
  afterEach(() => { global.__failSetItem = null; });

  test('Aufbau nur durch den Initiator, nur nach gemeldeter Faehigkeit; Bob entsteht beim ersten Empfang; beide danach aktiv', async () => {
    global.__mockStores = {};
    const a = loadSession('alice', ALICE_ID, 'initiator');
    const b = loadSession('bob', BOB_ID, 'responder');
    await a.setup();
    await b.setup();
    const conn = kemSecret();
    expect(await sealText(a, 'zu frueh', conn)).toBeNull();       // Faehigkeit unbekannt -> altes Verfahren
    await a.RS.notePeerCaps(ALICE_ID, true);
    await b.RS.notePeerCaps(BOB_ID, true);
    expect(await sealText(b, 'Bob baut nie auf', conn)).toBeNull(); // Rolle responder
    const env = await sealText(a, 'erste', conn);
    expect(env.type).toBe('ratchet');
    expect(await a.RS.isActive(ALICE_ID)).toBe(false);             // noch keine Antwort
    expect(await openText(b, env, conn)).toBe('erste');
    expect(await b.RS.isActive(BOB_ID)).toBe(true);
    expect(await openText(a, await sealText(b, 'antwort', conn), conn)).toBe('antwort');
    expect(await a.RS.isActive(ALICE_ID)).toBe(true);
  });

  test('Persistenz ueber einen Neustart beider Geraete', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'eins', conn), conn);
    await openText(a, await sealText(b, 'zwei', conn), conn);
    const pending = await sealText(a, 'unterwegs waehrend des Neustarts', conn);
    // Neustart: neue Modul-Instanzen, gleicher Speicher.
    const a2 = loadSession('alice', ALICE_ID, 'initiator');
    const b2 = loadSession('bob', BOB_ID, 'responder');
    expect(await openText(b2, pending, conn)).toBe('unterwegs waehrend des Neustarts');
    expect(await openText(a2, await sealText(b2, 'nach dem Neustart', conn), conn)).toBe('nach dem Neustart');
    expect(await openText(b2, await sealText(a2, 'und weiter', conn), conn)).toBe('und weiter');
    expect(await b2.RS.isActive(BOB_ID)).toBe(true);
  });

  test('Sperre: gleichzeitige Aufrufe laufen nacheinander - jede Nachricht bekommt eine eigene Nummer, alle lassen sich oeffnen', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await openText(a, await sealText(b, 'ok', conn), conn);
    const envs = await Promise.all(Array.from({ length: 20 }, (_, i) => sealText(a, 'p' + i, conn)));
    expect(new Set(envs.map((e) => e.h.n)).size).toBe(20);
    const opened = await Promise.all(shuffle(envs).map((e) => openText(b, e, conn)));
    expect(opened.sort()).toEqual(Array.from({ length: 20 }, (_, i) => 'p' + i).sort());
  });

  test('gleichzeitiger Aufbau beider Seiten (beide Rolle initiator, gleiche Verbindung): genau eine Sitzung setzt sich durch', async () => {
    global.__mockStores = {};
    const a = loadSession('alice', ALICE_ID, 'initiator');
    const b = loadSession('bob', BOB_ID, 'initiator');
    await a.setup(); await b.setup();
    await a.RS.notePeerCaps(ALICE_ID, true); await b.RS.notePeerCaps(BOB_ID, true);
    const conn = kemSecret();
    const fromA = await sealText(a, 'A1', conn);
    const fromB = await sealText(b, 'B1', conn);
    const results = await Promise.allSettled([openText(b, fromA, conn), openText(a, fromB, conn)]);
    // Genau eine Richtung wird angenommen (die mit dem kleineren Kennzeichen), die andere verworfen.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [winner, loser] = results[0].status === 'fulfilled' ? [a, b] : [b, a];
    // Der Verlierer antwortet in der Sitzung des Gewinners - ab da laeuft alles.
    expect(await openText(winner, await sealText(loser, 'antwort', conn), conn)).toBe('antwort');
    expect(await openText(loser, await sealText(winner, 'weiter', conn), conn)).toBe('weiter');
    expect(await a.RS.isActive(ALICE_ID)).toBe(true);
    expect(await b.RS.isActive(BOB_ID)).toBe(true);
  });

  test('eine bestehende Sitzung laesst sich nicht von aussen neu aufbauen (fremde Initialisierung wird abgelehnt)', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await openText(a, await sealText(b, 'ok', conn), conn);
    // Angreifer mit einem eigenen Verbindungsgeheimnis baut eine zweite "Alice" auf.
    global.__mockStores.mallory = new Map();
    const m = loadSession('mallory', ALICE_ID, 'initiator');
    await m.setup();
    await m.RS.notePeerCaps(ALICE_ID, true);
    const evil = kemSecret();
    const fake = await sealText(m, 'uebernimm die Sitzung', evil);
    await expect(openText(b, fake, evil)).rejects.toMatchObject({ code: 'foreign-init' });
    expect(await openText(b, await sealText(a, 'echte Alice', conn), conn)).toBe('echte Alice');
  });

  test('Speicherfehler beim Senden: keine Nachricht, Zustand unveraendert (kein doppelt benutzter Schluessel nach Neustart)', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await openText(a, await sealText(b, 'ok', conn), conn);
    const stored = a.ES.__store.get('ratchet_' + ALICE_ID);
    global.__failSetItem = (dev, k) => dev === 'alice' && k.startsWith('ratchet_');
    await expect(sealText(a, 'geht nicht raus', conn)).rejects.toBeTruthy();
    expect(a.ES.__store.get('ratchet_' + ALICE_ID)).toBe(stored);
    global.__failSetItem = null;
    const env = await sealText(a, 'danach', conn);
    expect(await openText(b, env, conn)).toBe('danach');
  });

  test('manipulierte Nachricht: abgelehnt, Zustand im Speicher unveraendert', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    const env = await sealText(a, 'echt', conn);
    const before = b.ES.__store.get('ratchet_' + BOB_ID);
    const bad = { ...env, h: { ...env.h, n: env.h.n + 3 } };
    await expect(openText(b, bad, conn)).rejects.toBeTruthy();
    expect(b.ES.__store.get('ratchet_' + BOB_ID)).toBe(before);
    expect(await openText(b, env, conn)).toBe('echt');
  });

  test('unlesbarer gespeicherter Zustand: Ratchet gesperrt, NICHT stillschweigend zurueck auf das alte Verfahren', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await b.ES.setItem('ratchet_' + BOB_ID, '{kaputt');
    const b2 = loadSession('bob', BOB_ID, 'responder');
    expect(await b2.RS.isActive(BOB_ID)).toBe(true);    // Altverfahren bleibt gesperrt
    await expect(sealText(b2, 'x', conn)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(openText(b2, await sealText(a, 'y', conn), conn)).rejects.toMatchObject({ code: 'corrupt' });
  });

  test('Faehigkeit ist klebrig; bekannt alte Gegenseite ohne Sitzung: kein KEM-Vorrat', async () => {
    global.__mockStores = {};
    const a = loadSession('alice', ALICE_ID, 'initiator');
    await a.setup();
    await a.RS.notePeerCaps(ALICE_ID, false);
    await a.RS.noteConnectionKem(ALICE_ID, kemSecret(), 'encap');
    expect(JSON.parse(a.ES.__store.get('ratchet_' + ALICE_ID))).toMatchObject({ cap: 0, held: [], own: [] });
    await a.RS.notePeerCaps(ALICE_ID, true);
    await a.RS.notePeerCaps(ALICE_ID, false); // spaeteres Paket ohne Angabe nimmt sie nicht zurueck
    expect(JSON.parse(a.ES.__store.get('ratchet_' + ALICE_ID)).cap).toBe(1);
  });

  test('KEM-Vorrat ueber die Sitzung: gekapseltes Geheimnis wird referenziert, nachgerechnet und danach aus dem Vorrat entfernt', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await openText(a, await sealText(b, 'ok', conn), conn);
    // Neue Verbindung: Alice ist Initiator (entkapselt), Bob Responder (kapselt).
    const kem = kemSecret();
    await b.RS.noteConnectionKem(BOB_ID, kem, 'encap');
    await a.RS.noteConnectionKem(ALICE_ID, kem, 'decap');
    const kid = require('../../DoubleRatchet').kemId(kem);
    expect(JSON.parse(b.ES.__store.get('ratchet_' + BOB_ID)).held.map((e) => e.kid)).toContain(kid);
    // Sprecherwechsel: Alice (aktuelle Kette) -> Bob (neuer Schluessel) ->
    // Alices naechster eigener Schritt mischt kem ein.
    await openText(b, await sealText(a, 'aktuelle Kette', kem), kem);
    await openText(a, await sealText(b, 'neue Verbindung', kem), kem);
    const env = await sealText(a, 'mit KEM', kem);
    expect(env.h.k).toEqual([kid]);
    expect(JSON.parse(a.ES.__store.get('ratchet_' + ALICE_ID)).own).toEqual([]);
    expect(await openText(b, env, 'nicht-im-vorrat')).toBe('mit KEM');
    expect(JSON.parse(b.ES.__store.get('ratchet_' + BOB_ID)).held.map((e) => e.kid)).not.toContain(kid);
  });

  test('Secret Chat: gespeicherte Schluessel uebersprungener Nachrichten werden verworfen', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    await sealText(a, 'verloren', conn);
    await openText(b, await sealText(a, 'da', conn), conn);
    expect(JSON.parse(b.ES.__store.get('ratchet_' + BOB_ID)).s.skipped).toHaveLength(1);
    await b.RS.purgeSkippedKeys(BOB_ID);
    expect(JSON.parse(b.ES.__store.get('ratchet_' + BOB_ID)).s.skipped).toHaveLength(0);
  });

  function holdNextRatchetWrite(dev) {
    let release;
    let hit;
    const reached = new Promise((r) => { hit = r; });
    global.__setItemGate = { dev, hit, promise: new Promise((r) => { release = r; }) };
    return { reached, release: () => { global.__setItemGate = null; release(); } };
  }

  test('Kontakt loeschen: Zustand samt Vorrat geloescht - auch eine gerade laufende Operation schreibt ihn nicht zurueck', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    expect(b.ES.__store.has('ratchet_' + BOB_ID)).toBe(true);
    const env = await sealText(a, 'laeuft gerade', conn);
    const env2 = await sealText(a, 'angefordert vor dem Loeschen', conn);
    const hold = holdNextRatchetWrite('bob');
    const inFlight = openText(b, env, conn);
    await hold.reached;                          // mitten im Speichern
    const queued = openText(b, env2, conn);      // wartet in der Sperre
    const forgotten = b.RS.forget(BOB_ID);
    hold.release();
    await expect(inFlight).rejects.toMatchObject({ code: 'deleted' });
    await expect(queued).rejects.toMatchObject({ code: 'deleted' });
    await forgotten;
    expect(b.ES.__store.has('ratchet_' + BOB_ID)).toBe(false);
    expect(await b.RS.isActive(BOB_ID)).toBe(false);
  });

  test('Wipe (forgetAll): laufende Operation schreibt nach dem Leeren des Speichers nichts zurueck', async () => {
    const { a, b, conn } = await twoDevices();
    await openText(b, await sealText(a, 'start', conn), conn);
    const env = await sealText(a, 'laeuft gerade', conn);
    const hold = holdNextRatchetWrite('bob');
    const inFlight = openText(b, env, conn);
    await hold.reached;
    b.RS.forgetAll();
    await b.ES.clear();
    hold.release();
    await expect(inFlight).rejects.toMatchObject({ code: 'deleted' });
    expect(b.ES.__store.size).toBe(0);
  });
});

describe('Audit 2026-10-19 (C1): Rechen- und Speichergrenze getrennt', () => {
  test('mehr als 1000 nie angekommene Nachrichten: die naechste wird trotzdem gelesen (Richtung bleibt am Leben)', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    for (let i = 0; i < 1500; i++) await send(A, 'nie angekommen');
    expect(await recv(B, await send(A, 'kommt an'))).toBe('kommt an');
    // gespeichert bleiben hoechstens MAX_SKIPPED_KEYS (die juengsten)
    expect(DR.skippedCount(B.s)).toBeLessThanOrEqual(DR.MAX_SKIPPED_KEYS);
    expect(await recv(A, await send(B, 'antwort'))).toBe('antwort');
  });

  test('Rechengrenze bleibt: mehr als MAX_SKIP wird weiter abgelehnt', () => {
    expect(DR.MAX_SKIP).toBeGreaterThan(DR.MAX_SKIPPED_KEYS);
    expect(DR.MAX_SKIP).toBeLessThanOrEqual(20000);
  });

  test('Lebensdauer gespeicherter Schluessel je Aufruf einstellbar (Siegel: 90 Tage)', async () => {
    const { A, B } = await pair();
    await recv(B, await send(A, 'start'));
    const verspaetet = await send(A, 'ausser der Reihe');
    await recv(B, await send(A, 'danach'));
    const in80Tagen = Date.now() + 80 * 24 * 3600 * 1000;
    // Standard (72 h): abgelaufen -> wie ein Replay abgelehnt
    const work = clone(B.s);
    await expect(DR.decrypt(work, verspaetet, { now: in80Tagen, rng: B.rng, lookupKem: () => null, takeOwnKems: () => [] })).rejects.toMatchObject({ code: 'replay' });
    // mit 90 Tagen: noch lesbar
    const work2 = clone(B.s);
    const r = await DR.decrypt(work2, verspaetet, { now: in80Tagen, rng: B.rng, lookupKem: () => null, takeOwnKems: () => [], maxSkippedAgeMs: 90 * 24 * 3600 * 1000 });
    expect(Buffer.from(r.plaintext).toString('utf8')).toBe('ausser der Reihe');
  });
});
