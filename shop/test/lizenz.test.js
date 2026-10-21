// Lizenzformat (LIZENZ_FORMAT.md): Testvektoren, Pruefung mit @noble/curves
// (wie in der App), Manipulationen, Geraetecode, Schluesselverwaltung.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import {
  pruefeLizenz,
  geraetecodeAusSpki,
  geraetecodeNormalisieren,
  geraetecodeGruppieren,
  kanonischesJson,
  base64urlKodieren,
  base64urlDekodieren,
  base32,
  asciiBytes,
} from '../src/lizenzpruefer.js';
import { lizenzSignieren, lizenzschluesselLaden, schluesselpaarErzeugen, oeffentlichRoh, TESTSCHLUESSEL, LizenzSchluesselFehler } from '../src/lizenz.js';
import { TEST_PRIVAT, TEST_OEFFENTLICH, GERAET_A, GERAET_B, tempVerzeichnis } from './hilfen.js';

// ---- Testvektoren (identisch in LIZENZ_FORMAT.md) ----
const SPKI_PRAEFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const SPKI_A =
  SPKI_PRAEFIX + '0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299';
const SPKI_B =
  SPKI_PRAEFIX + '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const DATEN_A = { v: 1, lic: 'MA1ACH1TEST00001', dev: GERAET_A, feat: ['pro'], iat: 1790000000, ord: 'BEST2026TEST0001' };
const JSON_A = '{"dev":"LJ5HRTFEUD2CBWN4MK5WNHB4E5M6HH3SE3","feat":["pro"],"iat":1790000000,"lic":"MA1ACH1TEST00001","ord":"BEST2026TEST0001","v":1}';
const LIZENZ_A =
  'ML1.eyJkZXYiOiJMSjVIUlRGRVVEMkNCV040TUs1V05IQjRFNU02SEgzU0UzIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDAwMDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.Q471nF3EL1ZPeX2ChkgpVXay44Nix0C3DWrnUxc83a02Xphim5y-KFqbNvI7aZVaVpCkMsEQX_G6Dp_mQLEuBQ';
const LIZENZ_B =
  'ML1.eyJkZXYiOiJMVEpGRjZZTTVDSlNJTlgyN0RHTkNCQUpRRzRKNVpGTkxRIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDg2NDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.3DUwgiHysO8J3cHsSTGyhQXmDefG6YuUqUvk23KQI60j9E-n-wwjyy3JHk57hrggXZBpgpulUWW7rth6klBgCA';

const schluessel = [TEST_OEFFENTLICH];
const pruefe = (l, dev = GERAET_A) => pruefeLizenz(l, { oeffentlicheSchluessel: schluessel, geraetecode: dev });

/** Signiert beliebige Bytes als "ML1."-Lizenz (fuer Manipulationstests). */
function roh(nutzdatenText) {
  const teil = 'ML1.' + base64urlKodieren(asciiBytes(nutzdatenText));
  return teil + '.' + base64urlKodieren(crypto.sign(null, Buffer.from(teil), TEST_PRIVAT));
}

describe('Geraetecode', () => {
  it('Testvektoren A und B (P-256-SPKI -> Geraetecode)', () => {
    assert.equal(geraetecodeAusSpki(Uint8Array.from(Buffer.from(SPKI_A, 'hex'))), GERAET_A);
    assert.equal(geraetecodeAusSpki(Uint8Array.from(Buffer.from(SPKI_B, 'hex'))), GERAET_B);
    assert.equal(geraetecodeGruppieren(GERAET_A), 'LJ5H-RTFE-UD2C-BWN4-MK5W-NHB4-E5M6-HH3S-E3');
  });

  it('SPKI-Bytes entsprechen dem, was Android/WebCrypto liefern (DER, unkomprimierter Punkt)', () => {
    const pub = p256.getPublicKey('c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721', false);
    assert.equal(SPKI_PRAEFIX + Buffer.from(pub).toString('hex'), SPKI_A);
    const k = crypto.createPublicKey({ key: Buffer.from(SPKI_A, 'hex'), format: 'der', type: 'spki' });
    assert.equal(k.asymmetricKeyDetails.namedCurve, 'prime256v1');
  });

  it('Normalisieren: Bindestriche, Leerzeichen, Kleinbuchstaben; Tippfehler werden erkannt', () => {
    assert.equal(geraetecodeNormalisieren('lj5h-rtfe-ud2c-bwn4-mk5w-nhb4-e5m6-hh3s-e3'), GERAET_A);
    assert.equal(geraetecodeNormalisieren(' LJ5H RTFE UD2C BWN4 MK5W NHB4 E5M6 HH3S E3 '), GERAET_A);
    assert.equal(geraetecodeNormalisieren(GERAET_A.slice(0, 5) + 'X' + GERAET_A.slice(6)), null); // ein Zeichen falsch
    assert.equal(geraetecodeNormalisieren(GERAET_A.slice(0, 33)), null);
    assert.equal(geraetecodeNormalisieren(GERAET_A.replace('5', '1')), null); // 1 nicht im Alphabet
    assert.equal(geraetecodeNormalisieren(null), null);
  });

  it('Base32 (RFC 4648) und Base64url (streng)', () => {
    assert.equal(base32(asciiBytes('foobar')), 'MZXW6YTBOI');
    assert.equal(base64urlKodieren(asciiBytes('foob')), 'Zm9vYg');
    assert.deepEqual([...base64urlDekodieren('Zm9vYg')], [...asciiBytes('foob')]);
    assert.throws(() => base64urlDekodieren('Zm9vYg=='));
    assert.throws(() => base64urlDekodieren('Zm9vYh')); // nicht-kanonische Endbits
    assert.throws(() => base64urlDekodieren('Zm9v+g'));
  });
});

describe('Lizenz: Testvektoren und Pruefung', () => {
  it('kanonisches JSON und exakte Lizenz-Zeichenkette', () => {
    assert.equal(kanonischesJson(DATEN_A), JSON_A);
    assert.equal(lizenzSignieren(TEST_PRIVAT, DATEN_A), LIZENZ_A);
    assert.equal(lizenzSignieren(TEST_PRIVAT, { ...DATEN_A, dev: GERAET_B, iat: 1790086400 }), LIZENZ_B);
    assert.equal(Buffer.from(oeffentlichRoh(TEST_PRIVAT)).toString('hex'), TESTSCHLUESSEL.oeffentlichHex);
  });

  it('gueltig fuer das richtige Geraet (Pruefung mit @noble/curves wie in der App)', () => {
    const r = pruefe(LIZENZ_A);
    assert.equal(r.gueltig, true);
    assert.deepEqual(r.daten, DATEN_A);
    assert.equal(pruefe(LIZENZ_B, GERAET_B).gueltig, true);
    // zusaetzlich direkt mit noble gegen die signierten Bytes
    const [p, n, s] = LIZENZ_A.split('.');
    assert.ok(ed25519.verify(Buffer.from(s, 'base64url'), asciiBytes(p + '.' + n), TEST_OEFFENTLICH));
  });

  it('eine kopierte Lizenz nuetzt auf einem anderen Geraet nichts', () => {
    assert.deepEqual(pruefe(LIZENZ_A, GERAET_B), { gueltig: false, grund: 'anderes-geraet' });
  });

  it('Manipulationen werden erkannt', () => {
    const [p, n, s] = LIZENZ_A.split('.');
    // anderes Geraet in die Nutzdaten geschrieben, Signatur behalten
    const fremd = base64urlKodieren(asciiBytes(JSON_A.replace(GERAET_A, GERAET_B)));
    assert.equal(pruefe(`${p}.${fremd}.${s}`, GERAET_B).grund, 'signatur');
    // ein Bit in der Signatur
    const sig = Buffer.from(s, 'base64url');
    sig[10] ^= 1;
    assert.equal(pruefe(`${p}.${n}.${sig.toString('base64url')}`).grund, 'signatur');
    // falscher Schluessel
    const anderer = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
    assert.equal(pruefeLizenz(LIZENZ_A, { oeffentlicheSchluessel: [anderer], geraetecode: GERAET_A }).grund, 'signatur');
    // Format
    assert.equal(pruefe('ML2.' + n + '.' + s).grund, 'format');
    assert.equal(pruefe(LIZENZ_A + '.x').grund, 'format');
    assert.equal(pruefe(`${p}.${n}=.${s}`).grund, 'kodierung');
    assert.equal(pruefe('x'.repeat(2000)).grund, 'format');
    assert.equal(pruefe(42).grund, 'format');
  });

  it('auch korrekt signierte, aber nicht-kanonische oder unvollstaendige Daten werden abgewiesen', () => {
    const umsortiert = '{"v":1,"dev":"' + GERAET_A + '","feat":["pro"],"iat":1790000000,"lic":"MA1ACH1TEST00001","ord":"BEST2026TEST0001"}';
    assert.equal(pruefe(roh(umsortiert)).grund, 'nicht-kanonisch');
    assert.equal(pruefe(roh(JSON_A.replace(':1790000000', ': 1790000000'))).grund, 'nicht-kanonisch');
    assert.equal(pruefe(roh(JSON_A.replace(',"v":1}', ',"v":1,"x":1}'))).grund, 'inhalt');
    assert.equal(pruefe(roh(JSON_A.replace('"v":1', '"v":2'))).grund, 'inhalt');
    assert.equal(pruefe(roh(JSON_A.replace('["pro"]', '["basis"]'))).grund, 'feature');
    assert.equal(pruefe(roh('kein json')).grund, 'inhalt');
  });

  it('Signieren verweigert ungueltige Daten', () => {
    assert.throws(() => lizenzSignieren(TEST_PRIVAT, { ...DATEN_A, dev: 'FALSCH' }));
    assert.throws(() => lizenzSignieren(TEST_PRIVAT, { ...DATEN_A, lic: 'IIII0000OOOO0000' }));
    assert.throws(() => lizenzSignieren(TEST_PRIVAT, { ...DATEN_A, feat: ['pro', 'basis'] }));
  });
});

describe('Lizenzschluessel', () => {
  it('Erzeugen, Speichern (0600) und Laden', () => {
    const dir = tempVerzeichnis();
    const { privatPem, oeffentlichRoh: pub } = schluesselpaarErzeugen();
    const datei = path.join(dir, 'lizenz.pem');
    fs.writeFileSync(datei, privatPem, { mode: 0o600 });
    const k = lizenzschluesselLaden(datei);
    assert.deepEqual([...oeffentlichRoh(k)], [...pub]);
    const l = lizenzSignieren(k, DATEN_A);
    assert.equal(pruefeLizenz(l, { oeffentlicheSchluessel: [pub], geraetecode: GERAET_A }).gueltig, true);
    assert.equal(pruefeLizenz(l, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_A }).grund, 'signatur');
  });

  it('weist den bekannten Testschluessel im Normalbetrieb ab', () => {
    const dir = tempVerzeichnis();
    const datei = path.join(dir, 'test.pem');
    fs.writeFileSync(datei, TEST_PRIVAT.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    assert.throws(() => lizenzschluesselLaden(datei), LizenzSchluesselFehler);
    assert.ok(lizenzschluesselLaden(datei, { erlaubeTestschluessel: true }));
  });

  it('weist zu weite Dateirechte und falsche Schluesseltypen ab', { skip: process.platform === 'win32' && 'Dateirechte unter Windows nicht pruefbar' }, () => {
    const dir = tempVerzeichnis();
    const datei = path.join(dir, 'offen.pem');
    fs.writeFileSync(datei, schluesselpaarErzeugen().privatPem, { mode: 0o644 });
    fs.chmodSync(datei, 0o644);
    assert.throws(() => lizenzschluesselLaden(datei), /Dateirechte/);
  });

  it('weist Nicht-Ed25519-Schluessel ab', () => {
    const dir = tempVerzeichnis();
    const datei = path.join(dir, 'ec.pem');
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(datei, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    assert.throws(() => lizenzschluesselLaden(datei), /Ed25519/);
  });
});
