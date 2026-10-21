// Lizenzformat "ML1" in der App (LicenseFormat.js, @noble/curves 2.x):
//  - die App-Kopie ist bis auf Importpfade/Zahlenschreibweise identisch mit
//    der Shop-Referenz shop/src/lizenzpruefer.js,
//  - alle Testvektoren aus shop/LIZENZ_FORMAT.md Abschnitt 10,
//  - Geraetecode aus dem SPKI, wie ihn das native Keystore-Modul liefert.
const fs = require('fs');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519.js');
const F = require('../security/helpers/licenseFixtures');
const L = require('../../LicenseFormat');
const { deviceCodeFromSpkiBase64, formatDeviceCode } = require('../../LicenseManager');

const KEYS = [L.base64urlDekodieren(F.TEST_PUBLIC_B64URL)];
const pruefe = (lizenz, dev = F.GERAET_A, schluessel = KEYS) =>
  L.pruefeLizenz(lizenz, { oeffentlicheSchluessel: schluessel, geraetecode: dev });
const roh = (text) => F.signRaw(text, { ed25519, asciiBytes: L.asciiBytes, base64urlKodieren: L.base64urlKodieren });

describe('App-Kopie == Shop-Referenz', () => {
  test('LicenseFormat.js weicht von shop/src/lizenzpruefer.js nur in Importpfaden und Zahlenschreibweise ab', () => {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const app = norm(fs.readFileSync(path.join(__dirname, '../../LicenseFormat.js'), 'utf8'));
    const ref = norm(fs.readFileSync(path.join(__dirname, '../../shop/src/lizenzpruefer.js'), 'utf8'));
    const marker = '// ------------------------------------------------------------------ Referenz:\n';
    expect(app.indexOf(marker)).toBeGreaterThan(0);
    const body = app.slice(app.indexOf(marker) + marker.length);
    const expected = ref
      .replace("from '@noble/curves/ed25519';", "from '@noble/curves/ed25519.js';")
      .replace("from '@noble/hashes/sha2';", "from '@noble/hashes/sha2.js';")
      .replace('1_600_000_000', '1600000000')
      .replace('9_999_999_999', '9999999999');
    expect(body).toBe(expected);
  });
});

describe('Testvektoren (LIZENZ_FORMAT.md Abschnitt 10)', () => {
  test('Testschluessel base64url = hex', () => {
    expect(Buffer.from(KEYS[0]).toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    expect(Buffer.from(ed25519.getPublicKey(F.hexToBytes(F.TEST_SEED_HEX))).toString('hex'))
      .toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  });

  test('Kontrollwerte Base32/Base64url', () => {
    expect(L.base32(L.asciiBytes('foobar'))).toBe('MZXW6YTBOI');
    expect(L.base64urlKodieren(L.asciiBytes('foob'))).toBe('Zm9vYg');
    expect(() => L.base64urlDekodieren('Zm9vYh')).toThrow();
    expect(() => L.base64urlDekodieren('Zm9vYg==')).toThrow();
  });

  test('Geraetecode A und B aus dem SPKI', () => {
    expect(L.geraetecodeAusSpki(F.hexToBytes(F.SPKI_A_HEX))).toBe(F.GERAET_A);
    expect(L.geraetecodeAusSpki(F.hexToBytes(F.SPKI_B_HEX))).toBe(F.GERAET_B);
    expect(L.geraetecodeGruppieren(F.GERAET_A)).toBe('LJ5H-RTFE-UD2C-BWN4-MK5W-NHB4-E5M6-HH3S-E3');
    expect(Buffer.from(require('@noble/hashes/sha2.js').sha256(F.hexToBytes(F.SPKI_A_HEX))).toString('hex'))
      .toBe('5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4');
  });

  test('kanonisches JSON von Lizenz A', () => {
    const d = { v: 1, lic: 'MA1ACH1TEST00001', dev: F.GERAET_A, feat: ['pro'], iat: 1790000000, ord: 'BEST2026TEST0001' };
    expect(L.kanonischesJson(d)).toBe(F.JSON_A);
    expect(roh(F.JSON_A)).toBe(F.LIZENZ_A);   // Ed25519 ist deterministisch
  });

  test.each([
    ['Lizenz A auf Geraet A', () => pruefe(F.LIZENZ_A, F.GERAET_A), true, undefined],
    ['Lizenz B auf Geraet B', () => pruefe(F.LIZENZ_B, F.GERAET_B), true, undefined],
    ['Lizenz A auf Geraet B', () => pruefe(F.LIZENZ_A, F.GERAET_B), false, 'anderes-geraet'],
    ['dev in den Nutzdaten ersetzt, Signatur alt', () => {
      const [p, , s] = F.LIZENZ_A.split('.');
      const fremd = L.base64urlKodieren(L.asciiBytes(F.JSON_A.replace(F.GERAET_A, F.GERAET_B)));
      return pruefe(`${p}.${fremd}.${s}`, F.GERAET_B);
    }, false, 'signatur'],
    ['ein Bit der Signatur gekippt', () => {
      const [p, n, s] = F.LIZENZ_A.split('.');
      const sig = L.base64urlDekodieren(s);
      sig[10] ^= 1;
      return pruefe(`${p}.${n}.${L.base64urlKodieren(sig)}`);
    }, false, 'signatur'],
    ['anderer oeffentlicher Schluessel', () => pruefe(F.LIZENZ_A, F.GERAET_A,
      [ed25519.getPublicKey(F.hexToBytes('11'.repeat(32)))]), false, 'signatur'],
    ['Praefix ML2.', () => pruefe('ML2.' + F.LIZENZ_A.slice(4)), false, 'format'],
    ['= an Teil 2', () => { const [p, n, s] = F.LIZENZ_A.split('.'); return pruefe(`${p}.${n}=.${s}`); }, false, 'kodierung'],
    ['unsortierte Felder (korrekt signiert)', () => pruefe(roh('{"v":1,"dev":"' + F.GERAET_A + '","feat":["pro"],"iat":1790000000,"lic":"MA1ACH1TEST00001","ord":"BEST2026TEST0001"}')), false, 'nicht-kanonisch'],
    ['Leerzeichen (korrekt signiert)', () => pruefe(roh(F.JSON_A.replace(':1790000000', ': 1790000000'))), false, 'nicht-kanonisch'],
    ['zusaetzliches Feld', () => pruefe(roh(F.JSON_A.replace(',"v":1}', ',"v":1,"x":1}'))), false, 'inhalt'],
    ['v = 2', () => pruefe(roh(F.JSON_A.replace('"v":1', '"v":2'))), false, 'inhalt'],
    ['feat ohne "pro"', () => pruefe(roh(F.JSON_A.replace('["pro"]', '["basis"]'))), false, 'feature'],
    ['zu lang', () => pruefe('x'.repeat(2000)), false, 'format'],
    ['kein Text', () => pruefe(42), false, 'format'],
  ])('%s', (_name, run, gueltig, grund) => {
    const r = run();
    expect(r.gueltig).toBe(gueltig);
    if (!gueltig) expect(r.grund).toBe(grund);
  });
});

describe('Geraetecode aus der Antwort des Keystore-Moduls', () => {
  test('base64-SPKI von Geraet A/B ergibt die Testvektor-Codes', () => {
    expect(deviceCodeFromSpkiBase64(F.SPKI_A_B64)).toBe(F.GERAET_A);
    expect(deviceCodeFromSpkiBase64(F.SPKI_B_B64)).toBe(F.GERAET_B);
    expect(formatDeviceCode(F.GERAET_A)).toBe('LJ5H-RTFE-UD2C-BWN4-MK5W-NHB4-E5M6-HH3S-E3');
    expect(formatDeviceCode('kaputt')).toBe('');
  });

  test.each([
    ['leer', ''],
    ['kein Text', null],
    ['zu kurz', Buffer.from(F.SPKI_A_HEX.slice(0, 100), 'hex').toString('base64')],
    ['falsche Kurve (Praefix veraendert)', Buffer.from(F.SPKI_A_HEX.replace('06082a8648ce3d030107', '06082a8648ce3d030108'), 'hex').toString('base64')],
    ['komprimierter Punkt statt 04', Buffer.from(F.SPKI_A_HEX.slice(0, 52) + '02' + F.SPKI_A_HEX.slice(54), 'hex').toString('base64')],
    ['ein Byte zu viel', Buffer.from(F.SPKI_A_HEX + '00', 'hex').toString('base64')],
    ['kein base64', '!'.repeat(124)],
  ])('abgelehnt: %s', (_name, input) => {
    expect(() => deviceCodeFromSpkiBase64(input)).toThrow();
  });
});
