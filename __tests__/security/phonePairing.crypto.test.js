/* eslint-env node */
// Telefonnummer-Kopplung (PhonePairing.js, PHONE_PAIRING_DESIGN.md) - reine
// Kryptografie und Protokoll, ohne Tor:
//   - Normalisierung auf E.164, Rollen, Zeitfenster,
//   - deterministische Ableitung (beide Seiten: gleiche Onion-Adresse, gleicher
//     Tor-Schluessel, gleicher Anmeldeschluessel; anderes Paar/andere Stunde
//     -> alles anders), Onion-Format nach rend-spec-v3, Schluessel passt zur
//     Adresse, Argon2id-Parameter,
//   - Handshake zwischen zwei Partnern im Speicher (gleicher Code, gleiche
//     Kontakt-ID, Tunnel), falsche Nummer -> Anmeldung scheitert,
//   - Mann in der Mitte, der BEIDE Nummern kennt: verschiedene Codes - der
//     Pflicht-Vergleich faengt ihn ab; Festlegung (commit) bindet.
// ML-KEM-768 ist echt (@noble/post-quantum), Argon2id echt (Node/OpenSSL).
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');
const { realKyber, kdfNode, rng, nativeArgon2idMock, b64 } = require('./helpers/phonePairingHelpers');
const { argon2id: nobleArgon2id } = require('@noble/hashes/argon2');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { bytesToNumberLE } = require('@noble/curves/utils.js');
const PP = require('../../PhonePairing');
const { ONION_RE } = require('../../TorTransport');

const A = '+4917612345678';
const B = '+4915198765432';
const kyber = realKyber();
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const wire = (obj) => JSON.parse(JSON.stringify(obj));
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

describe('Nummern normalisieren (E.164)', () => {
  test.each([
    ['0176 12345678', '+4917612345678'],
    ['+49 176 12345678', '+4917612345678'],
    ['0049 176 1234-5678', '+4917612345678'],
    ['+49 (0)176 / 123 456 78', '+4917612345678'],
    ['+49 0176 12345678', '+4917612345678'],
    ['(0176) 123.456.78', '+4917612345678'],
    ['  0176 12345678 ', '+4917612345678'],
    ['+43 664 1234567', '+436641234567'],
    ['+1 (415) 555-0100', '+14155550100'],
    ['0030 210 1234567', '+302101234567'],
  ])('%p -> %p', (raw, e164) => {
    expect(PP.normalizePhoneNumber(raw)).toBe(e164);
  });

  test.each([
    [''], ['   '], ['17612345678'], ['0176'], ['+49 176'], ['+0176 1234567'], ['++49176123456'],
    ['+49176+12345'], ['0176 1234 abc'], ['+49 176 1234567890123'], ['00'], ['0'.repeat(41)],
    [null], [undefined], [17612345678],
  ])('ungueltig: %p', (raw) => {
    expect(PP.normalizePhoneNumber(raw)).toBeNull();
  });

  test('gleiche Nummer in verschiedenen Schreibweisen ergibt dasselbe Ergebnis (beide Seiten muessen identisch rechnen)', () => {
    const forms = ['0176 12345678', '+4917612345678', '0049-176-12345678', '+49 (0) 176 1234 5678'];
    expect(new Set(forms.map((f) => PP.normalizePhoneNumber(f))).size).toBe(1);
  });
});

describe('Rollen und Zeitfenster', () => {
  test('genau eine Seite betreibt den Treffpunkt - beide rechnen ohne Absprache gleich', () => {
    const lo = A < B ? A : B;
    const hi = A < B ? B : A;
    expect(PP.phoneRole(lo, hi)).toBe('host');
    expect(PP.phoneRole(hi, lo)).toBe('client');
  });

  test('aktuelle und vorige Stunde; kurz vor und kurz nach dem Stundenwechsel ueberlappen die Fenster', () => {
    const t = Date.UTC(2026, 9, 19, 13, 59, 50);
    const [b0, b1] = PP.phoneBuckets(t);
    expect(b1).toBe(b0 - 1);
    const after = PP.phoneBuckets(t + 20000);           // 14:00:10
    expect(after[0]).toBe(b0 + 1);
    expect(after).toContain(b0);
    // Auch 55 min Abstand (innerhalb des 10-Minuten-Fensters reicht das locker).
    expect(PP.phoneBuckets(t + 55 * 60000)).toContain(b0);
  });
});

describe('Treffpunkt ableiten', () => {
  let x;
  let y;
  beforeAll(async () => {
    x = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode });
    y = await PP.deriveRendezvous(B, A, 493000, { kdf: kdfNode });
  });

  test('beide Seiten (eigene/fremde Nummer vertauscht) erhalten dieselbe Onion-Adresse, denselben Tor-Schluessel und Anmeldeschluessel', () => {
    expect(x.onion).toBe(y.onion);
    expect(x.keyBlob).toBe(y.keyBlob);
    expect(same(x.authKey, y.authKey)).toBe(true);
    expect(x.onion).toMatch(ONION_RE);
    expect(x.keyBlob).toMatch(/^ED25519-V3:[A-Za-z0-9+/]{86}==$/);
    expect(x.authKey).toHaveLength(32);
  });

  test('anderes Paar, eine andere Ziffer oder eine andere Stunde: Adresse und Schluessel komplett verschieden', async () => {
    const variants = await Promise.all([
      PP.deriveRendezvous(A, '+4915198765433', 493000, { kdf: kdfNode }),
      PP.deriveRendezvous('+4917612345679', B, 493000, { kdf: kdfNode }),
      PP.deriveRendezvous(A, B, 493001, { kdf: kdfNode }),
      PP.deriveRendezvous(A, B, 492999, { kdf: kdfNode }),
    ]);
    for (const v of variants) {
      expect(v.onion).not.toBe(x.onion);
      expect(v.keyBlob).not.toBe(x.keyBlob);
      expect(same(v.authKey, x.authKey)).toBe(false);
    }
    expect(new Set(variants.map((v) => v.onion)).size).toBe(variants.length);
  });

  test('Tor-Schluessel passt zur Adresse: geklemmter Skalar mal Basispunkt = oeffentlicher Schluessel der Onion-Adresse', () => {
    const raw = Buffer.from(x.keyBlob.slice('ED25519-V3:'.length), 'base64');
    expect(raw).toHaveLength(64);
    expect(raw[0] & 7).toBe(0);
    expect(raw[31] & 128).toBe(0);
    expect(raw[31] & 64).toBe(64);
    const a = bytesToNumberLE(new Uint8Array(raw.subarray(0, 32))) % L;
    const pub = ed25519.Point.BASE.multiply(a).toBytes();
    expect(same(pub, PP.publicKeyFromOnion(x.onion))).toBe(true);
  });

  test('Onion-Pruefsumme nach rend-spec-v3 (oeffentlich bekannte v3-Adressen) - eine geaenderte Stelle faellt auf', () => {
    for (const known of [
      'duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion',
      '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion',
    ]) {
      const pub = PP.publicKeyFromOnion(known);
      expect(pub).not.toBeNull();
      expect(PP.onionFromPublicKey(pub)).toBe(known);
      const broken = (known[0] === 'a' ? 'b' : 'a') + known.slice(1);
      expect(PP.publicKeyFromOnion(broken)).toBeNull();
    }
  });

  test('Argon2id: 64 MiB, t=3, 32 Byte; Eingabe = Domain-Label + sortiertes Paar; Salz je Stunde verschieden', async () => {
    const calls = [];
    const kdf = async (pw, salt, p) => {
      calls.push({ pw: Buffer.from(pw).toString('utf8'), salt: b64(salt), p: { ...p } });
      return kdfNode(pw, salt, p);
    };
    await PP.deriveRendezvous(B, A, 7, { kdf });
    await PP.deriveRendezvous(A, B, 8, { kdf });
    expect(calls[0].p).toEqual({ memKiB: 65536, iterations: 3, outLen: 32 });
    const [lo, hi] = [A, B].sort();
    expect(calls[0].pw).toBe('malachi-phone-rendezvous-v1|' + lo + '|' + hi);
    expect(calls[1].pw).toBe(calls[0].pw);
    expect(calls[0].salt).not.toBe(calls[1].salt);
  });

  test('Standard-Ableitung laeuft ueber die native Bruecke (Base64, feste Parameter) - fehlt sie, Abbruch statt schwachem Ersatz', async () => {
    const saved = NativeModules.MalachiTor;
    try {
      NativeModules.MalachiTor = { argon2id: jest.fn(nativeArgon2idMock) };
      const viaNative = await PP.deriveRendezvous(A, B, 493000);
      expect(viaNative.onion).toBe(x.onion);
      const [pwB64, saltB64, mem, it, len] = NativeModules.MalachiTor.argon2id.mock.calls[0];
      expect([mem, it, len]).toEqual([65536, 3, 32]);
      expect(Buffer.from(pwB64, 'base64').toString('utf8')).toContain('malachi-phone-rendezvous-v1|');
      expect(Buffer.from(saltB64, 'base64')).toHaveLength(32);
      NativeModules.MalachiTor = {};
      await expect(PP.deriveRendezvous(A, B, 493000)).rejects.toMatchObject({ code: 'unsupported' });
    } finally {
      NativeModules.MalachiTor = saved;
    }
  });

  test('Known-Answer: Argon2id wie BouncyCastle 1.80 (auf der JVM mit denselben Aufrufen wie MalachiTorModule.argon2id gerechnet) - und die daraus festgelegte Treffpunkt-Adresse', async () => {
    const pw = new TextEncoder().encode('malachi-phone-rendezvous-v1|+4915198765432|+4917612345678');
    const salt = crypto.createHash('sha256').update('malachi-phone-rendezvous-v1|bucket|493000').digest();
    expect(b64(await kdfNode(pw, new Uint8Array(salt), PP.PHONE_KDF))).toBe('UhANneUT7DEXUoBlqkiaG9A1Pq4fZzBZIIT0nRI4AEg=');
    const rv = await PP.deriveRendezvous('+4917612345678', '+4915198765432', 493000, { kdf: kdfNode });
    // Festgelegt (Regression): aendert sich die Ableitung, finden sich alte und
    // neue App-Versionen nicht mehr - dann nur mit neuem Label (v2).
    expect(rv.onion).toBe('qvorjhlkad3httmv5t63f3wwcpy5nsu6dk33sz7edue6fpm2ff5q3hyd.onion');
  });

  test('die Testattrappe ist echtes Argon2id (Node/OpenSSL stimmt mit @noble/hashes ueberein)', async () => {
    const pw = new TextEncoder().encode('malachi-phone-rendezvous-v1|+491|+492');
    const salt = new Uint8Array(32).fill(7);
    const viaNode = Buffer.from(await nativeArgon2idMock(b64(pw), b64(salt), 64, 2, 32), 'base64');
    const viaNoble = nobleArgon2id(pw, salt, { t: 2, m: 64, p: 1, dkLen: 32 });
    expect(same(viaNode, viaNoble)).toBe(true);
  });

  test('gleiche oder ungueltige Nummern werden abgelehnt', async () => {
    await expect(PP.deriveRendezvous(A, A, 1, { kdf: kdfNode })).rejects.toMatchObject({ code: 'invalid-number' });
    await expect(PP.deriveRendezvous('0176 12345678', B, 1, { kdf: kdfNode })).rejects.toMatchObject({ code: 'invalid-number' });
  });
});

// ── Handshake zwischen zwei Partnern im Speicher ──
async function handshake({ hostAuth, clientAuth, onion }) {
  const host = new PP.HostHandshake({ onion, authKey: hostAuth, rng, kyber });
  const client = new PP.ClientHandshake({ onion, authKey: clientAuth, rng, kyber });
  const auth = wire(await client.onHello(wire(await host.hello())));
  const keys = wire(await host.onAuth(auth));
  const { reply, result } = await client.onKeys(keys);
  const h = await host.onOpen(wire(reply));
  return { h, c: result, host, client };
}

describe('Handshake', () => {
  let rv;
  beforeAll(async () => { rv = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode }); });

  test('beide Seiten: gleicher 6-stelliger Code, gleiche Kontakt-ID, passende Tunnelschluessel', async () => {
    const { h, c } = await handshake({ hostAuth: rv.authKey, clientAuth: rv.authKey, onion: rv.onion });
    expect(h.code).toMatch(/^\d{3} \d{3}$/);
    expect(h.code).toBe(c.code);
    expect(h.contactId).toMatch(/^c_[0-9a-f]{32}$/);
    expect(h.contactId).toBe(c.contactId);
    expect(same(h.tx, c.rx)).toBe(true);
    expect(same(h.rx, c.tx)).toBe(true);
    expect(same(h.tx, h.rx)).toBe(false);
  });

  test('jede Kopplung ist frisch: neuer Code, neue Kontakt-ID, neue Schluessel - nichts davon folgt aus den Nummern allein', async () => {
    const r1 = await handshake({ hostAuth: rv.authKey, clientAuth: rv.authKey, onion: rv.onion });
    const r2 = await handshake({ hostAuth: rv.authKey, clientAuth: rv.authKey, onion: rv.onion });
    expect(r1.h.contactId).not.toBe(r2.h.contactId);
    expect(same(r1.h.tx, r2.h.tx)).toBe(false);
  });

  test('falsche Nummer beim Gast (anderer Anmeldeschluessel): der Gastgeber lehnt ab, kein Code', async () => {
    const wrong = await PP.deriveRendezvous(A, '+4915198765433', 493000, { kdf: kdfNode });
    await expect(handshake({ hostAuth: rv.authKey, clientAuth: wrong.authKey, onion: rv.onion })).rejects.toMatchObject({ code: 'auth' });
  });

  test('falsche Nummer beim Gastgeber: der Gast lehnt dessen Antwort ab, kein Code', async () => {
    const wrong = await PP.deriveRendezvous('+4917612345679', B, 493000, { kdf: kdfNode });
    await expect(handshake({ hostAuth: wrong.authKey, clientAuth: rv.authKey, onion: rv.onion })).rejects.toMatchObject({ code: 'auth' });
  });

  test('Festlegung bindet: veraendertes X25519, ML-KEM-Chiffrat oder Zufallswert in der Aufloesung -> abgelehnt', async () => {
    for (const key of ['x', 'ct', 'r']) {
      const host = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
      const client = new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
      const keys = await host.onAuth(wire(await client.onHello(wire(await host.hello()))));
      const { reply } = await client.onKeys(wire(keys));
      const bytes = Buffer.from(reply[key], 'base64');
      bytes[0] ^= 1;
      await expect(host.onOpen({ ...reply, [key]: bytes.toString('base64') })).rejects.toMatchObject({ code: 'commit' });
    }
  });

  test('Reihenfolge und Format werden erzwungen (kaputte/fremde/vertauschte Zeilen)', async () => {
    const host = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    await expect(host.onAuth({ t: 'malachi-phone', step: 'auth' })).rejects.toMatchObject({ code: 'protocol' });
    const hello = wire(await host.hello());
    const client = new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    await expect(client.onKeys({ t: 'malachi-phone', step: 'keys' })).rejects.toMatchObject({ code: 'protocol' });
    await expect(new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber })
      .onHello({ ...hello, v: 2 })).rejects.toMatchObject({ code: 'protocol' });
    await expect(new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber })
      .onHello({ ...hello, kem: hello.kem.slice(4) })).rejects.toMatchObject({ code: 'protocol' });
    await expect(new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber })
      .onHello({ ...hello, t: 'malachi-tor' })).rejects.toMatchObject({ code: 'protocol' });
    const auth = wire(await client.onHello(hello));
    await expect(host.onOpen(auth)).rejects.toMatchObject({ code: 'protocol' });
  });

  test('an die Treffpunkt-Adresse gebunden: dieselben Schluessel, aber andere Adresse -> Anmeldung ungueltig', async () => {
    const other = await PP.deriveRendezvous(A, B, 493001, { kdf: kdfNode });
    const host = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    const client = new PP.ClientHandshake({ onion: other.onion, authKey: rv.authKey, rng, kyber });
    const auth = wire(await client.onHello(wire(await host.hello())));
    await expect(host.onAuth(auth)).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('Mann in der Mitte, der BEIDE Nummern kennt', () => {
  // M setzt sich zwischen Gastgeber H und Gast C: gegenueber H spielt er den
  // Gast, gegenueber C den Gastgeber - mit dem echten Anmeldeschluessel (er
  // kennt ja beide Nummern). Beide Handshakes gelingen; der Pflicht-Vergleich
  // der Codes muss ihn verraten.
  async function mitm(rv) {
    const H = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    const C = new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    const MasClient = new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    const MasHost = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    // Sitzung H <-> M
    const keysH = wire(await H.onAuth(wire(await MasClient.onHello(wire(await H.hello())))));
    const m1 = await MasClient.onKeys(keysH);
    const atH = await H.onOpen(wire(m1.reply));
    // Sitzung M <-> C (M kennt den Code aus Sitzung 1 bereits)
    const keysC = wire(await MasHost.onAuth(wire(await C.onHello(wire(await MasHost.hello())))));
    const atC = await C.onKeys(keysC);
    const m2 = await MasHost.onOpen(wire(atC.reply));
    return { codeH: atH.code, codeC: atC.result.code, m1: m1.result, m2, idH: atH.contactId, idC: atC.result.contactId };
  }

  test('beide Handshakes gelingen, aber die Codes auf H und C unterscheiden sich (20 Durchlaeufe) - "Stimmt nicht" verwirft alles', async () => {
    const rv = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode });
    for (let i = 0; i < 20; i++) {
      const r = await mitm(rv);
      expect(r.m1.code).toBe(r.codeH);       // M sieht jeweils denselben Code wie sein Opfer ...
      expect(r.m2.code).toBe(r.codeC);
      expect(r.codeH).not.toBe(r.codeC);      // ... aber die Opfer untereinander nicht.
      expect(r.idH).not.toBe(r.idC);
    }
  });

  test('ohne Neuwuerfeln kein Treffer: der Code der Sitzung M<->C haengt vom Zufall ab, den C erst nach Ms Festlegung aufdeckt', async () => {
    // M benutzt in Sitzung M<->C immer dieselben eigenen Werte (feste Zufallsquelle);
    // trotzdem ist Cs Code jedes Mal ein anderer.
    const rv = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode });
    const fixed = crypto.randomBytes(32);
    const fixedRng = async (n) => new Uint8Array(fixed.subarray(0, n));
    const fixedKp = await kyber.generateKeypair();
    const fixedKyber = { ...kyber, generateKeypair: async () => fixedKp };
    const codes = new Set();
    for (let i = 0; i < 8; i++) {
      const MasHost = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng: fixedRng, kyber: fixedKyber });
      const C = new PP.ClientHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
      const keysC = wire(await MasHost.onAuth(wire(await C.onHello(wire(await MasHost.hello())))));
      codes.add((await C.onKeys(keysC)).result.code);
    }
    expect(codes.size).toBe(8);
  });

  test('wer nur EINE Nummer kennt, kommt nicht einmal durch die Anmeldung', async () => {
    const rv = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode });
    const guess = await PP.deriveRendezvous(A, '+4915100000000', 493000, { kdf: kdfNode });
    expect(guess.onion).not.toBe(rv.onion);
    const H = new PP.HostHandshake({ onion: rv.onion, authKey: rv.authKey, rng, kyber });
    const M = new PP.ClientHandshake({ onion: rv.onion, authKey: guess.authKey, rng, kyber });
    await expect(H.onAuth(wire(await M.onHello(wire(await H.hello()))))).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('Tunnel', () => {
  const k1 = crypto.randomBytes(32);
  const k2 = crypto.randomBytes(32);

  test('beide Richtungen; Wiederholung, Umstellung, Veraenderung und falscher Schluessel -> nicht entschluesselbar', () => {
    const a = PP.createTunnel(k1, k2);
    const b = PP.createTunnel(k2, k1);
    const l1 = a.seal('{"type":"system","subtype":"kyber_pubkey"}');
    const l2 = a.seal('zwei');
    expect(l1).not.toContain('kyber');
    expect(b.open(l1)).toBe('{"type":"system","subtype":"kyber_pubkey"}');
    expect(b.open(l1)).toBeNull();                              // Wiederholung
    const c = PP.createTunnel(k2, k1);
    expect(c.open(l2)).toBeNull();                              // Umstellung/Auslassung
    const d = PP.createTunnel(k2, k1);
    const t = Buffer.from(l1, 'base64'); t[3] ^= 1;
    expect(d.open(t.toString('base64'))).toBeNull();            // veraendert
    expect(PP.createTunnel(k1, k2).open(l1)).toBeNull();        // Schluessel der Gegenrichtung
    expect(a.open('kein base64 !')).toBeNull();
    expect(b.open(a.seal('zurueck'))).toBeNull();               // a -> b, aber l2 fehlt dazwischen
    const e = PP.createTunnel(k2, k1);
    expect(e.open(b.seal('x'))).toBeNull();                     // b sendet mit k2 - e erwartet k1
  });

  test('nach wipe(): Schluessel ueberschrieben, nichts geht mehr', () => {
    const tx = Uint8Array.from(k1);
    const a = PP.createTunnel(tx, k2);
    const b = PP.createTunnel(k2, k1);
    const line = a.seal('x');
    b.wipe();
    expect(b.open(line)).toBeNull();
    a.wipe();
    expect(() => a.seal('y')).toThrow();
  });
});
