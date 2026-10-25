/* eslint-env node */
// Kopplung mit freien Kennungen statt Telefonnummern (PhonePairing.js,
// Nutzerwunsch 2026-10-25): Vereinheitlichung, Mindestlaenge, verbotene
// Zeichen, Trennung von Nummern, Telefon-Ableitung unveraendert.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { kdfNode } = require('./helpers/phonePairingHelpers');
const PP = require('../../PhonePairing');

describe('Kennung vereinheitlichen', () => {
  test.each([
    ['Anna.Berlin', 'id:anna.berlin'],
    ['  anna.berlin  ', 'id:anna.berlin'],
    ['ANNA   im   Park', 'id:anna im park'],
    ['anna im\tpark', 'id:anna im park'],          // geschuetztes Leerzeichen, Tab
    ['ＡＮＮＡberlin', 'id:annaberlin'], // Vollbreite (NFKC)
    ['café-freunde', 'id:café-freunde'], // kombinierendes Zeichen -> NFC/NFKC
    ['schlüssel-2026', 'id:schlüssel-2026'],
    ['🦊🦊🦊🦊🦊🦊🦊🦊', 'id:🦊🦊🦊🦊🦊🦊🦊🦊'],             // 8 Zeichen (nicht 16 UTF-16-Einheiten)
  ])('%j -> %j', (raw, expected) => {
    expect(PP.normalizeIdentifier(raw)).toBe(expected);
    expect(PP.isPairingId(expected)).toBe(true);
  });

  test('gleiche Kennung in verschiedenen Schreibweisen ergibt dasselbe', () => {
    const forms = ['Max-Mustermann', 'max-mustermann', ' MAX-MUSTERMANN ', 'Max-Mustermann\n'];
    expect(new Set(forms.map(PP.normalizeIdentifier)).size).toBe(1);
  });

  test.each([
    ['zu kurz', 'anna'],
    ['7 Zeichen', 'abcdefg'],
    ['nur Leerraum', '          '],
    ['Null-Breite-Zeichen', 'anna​berlin'],
    ['Bidi-Steuerzeichen', 'anna‮berlin'],
    ['weiches Trennzeichen', 'anna­berlin'],
    ['BOM mitten im Wort', 'anna﻿berlin'],
    ['Steuerzeichen', 'anna\u0007berlin'],
    ['unpaariges Surrogat', 'annaberlin\uD83D'],
    ['zu lang', 'a'.repeat(PP.ID_MAX_LEN + 1)],
    ['kein Text', 12345678],
    ['null', null],
  ])('%s wird abgelehnt', (_label, raw) => {
    expect(PP.normalizeIdentifier(raw)).toBeNull();
  });

  test('Laenge genau an den Grenzen', () => {
    expect(PP.normalizeIdentifier('a'.repeat(PP.ID_MIN_LEN))).toBe('id:' + 'a'.repeat(PP.ID_MIN_LEN));
    expect(PP.normalizeIdentifier('a'.repeat(PP.ID_MAX_LEN))).toBe('id:' + 'a'.repeat(PP.ID_MAX_LEN));
  });

  test('Art der Eingabe entscheidet: Nummer bleibt Nummer, Kennung bleibt Kennung', () => {
    expect(PP.normalizePairingId('0176 12345678', 'phone')).toBe('+4917612345678');
    expect(PP.normalizePairingId('0176 12345678', 'id')).toBe('id:0176 12345678');
    expect(PP.normalizePairingId('anna.berlin', 'phone')).toBeNull();
    expect(PP.normalizePairingId('anna.berlin')).toBeNull();          // Standard: Telefonnummer
    // Eine Kennung kann nie wie eine Nummer aussehen (Praefix "id:", nie "+")
    expect(PP.isPairingId('+4917612345678')).toBe(true);
    expect(PP.isPairingId('id:Anna.Berlin')).toBe(false);             // nicht vereinheitlicht
    expect(PP.isPairingId('id:anna')).toBe(false);                    // zu kurz
    expect(PP.isPairingId('anna.berlin')).toBe(false);
  });
});

describe('Treffpunkt mit Kennungen', () => {
  const A = PP.normalizeIdentifier('Anna.Berlin');
  const B = PP.normalizeIdentifier('Max im Park');

  test('beide Seiten erhalten denselben Treffpunkt, Reihenfolge egal', async () => {
    const x = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode });
    const y = await PP.deriveRendezvous(B, A, 493000, { kdf: kdfNode });
    expect(x.onion).toBe(y.onion);
    expect(x.keyBlob).toBe(y.keyBlob);
    expect(Buffer.from(x.authKey).equals(Buffer.from(y.authKey))).toBe(true);
  });

  test('andere Kennung oder Stunde -> anderer Treffpunkt; Nummer und Kennung nie gleich', async () => {
    const base = await PP.deriveRendezvous(A, B, 493000, { kdf: kdfNode });
    const others = await Promise.all([
      PP.deriveRendezvous(A, PP.normalizeIdentifier('Max im Park!'), 493000, { kdf: kdfNode }),
      PP.deriveRendezvous(A, B, 493001, { kdf: kdfNode }),
      PP.deriveRendezvous('+4917612345678', '+4915198765432', 493000, { kdf: kdfNode }),
    ]);
    for (const o of others) expect(o.onion).not.toBe(base.onion);
  });

  test('Rollen sind auf beiden Seiten gegensaetzlich', () => {
    expect(PP.phoneRole(A, B)).not.toBe(PP.phoneRole(B, A));
  });

  test('nicht vereinheitlichte oder gleiche Kennungen werden nicht abgeleitet', async () => {
    await expect(PP.deriveRendezvous('id:Anna.Berlin', B, 1, { kdf: kdfNode })).rejects.toThrow();
    await expect(PP.deriveRendezvous(A, A, 1, { kdf: kdfNode })).rejects.toThrow();
  });

  test('Sitzung mit zu kurzer Kennung bricht sofort mit "invalid-id" ab (ohne Tor)', async () => {
    const states = [];
    PP.startPhonePairing({
      mode: 'id', ownNumber: 'anna', otherNumber: 'max im park', transport: {}, appState: null,
      onState: (s) => states.push(s),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)).toMatchObject({ phase: 'error', error: 'invalid-id' });
  });
});
