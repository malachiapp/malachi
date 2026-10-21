// QR-Codes: SVG und PNG werden erzeugt und mit einem unabhaengigen Decoder (jsQR) gelesen.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import jsQR from 'jsqr';
import { qrMatrix, qrSvg, qrPng, bip21 } from '../src/qr.js';
import { testAdresse } from './hilfen.js';

const MONERO_URI = `monero:${testAdresse('8', 'qr')}?tx_amount=0.006149`;
const LIZENZ =
  'ML1.eyJkZXYiOiJMSjVIUlRGRVVEMkNCV040TUs1V05IQjRFNU02SEgzU0UzIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDAwMDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.Q471nF3EL1ZPeX2ChkgpVXay44Nix0C3DWrnUxc83a02Xphim5y-KFqbNvI7aZVaVpCkMsEQX_G6Dp_mQLEuBQ';

/** Rendert eine Modulmatrix als RGBA-Bild (mit Ruhezone) und dekodiert sie. */
function dekodieren(matrix, skala = 4) {
  const n = matrix.length + 8;
  const b = n * skala;
  const daten = new Uint8ClampedArray(b * b * 4).fill(255);
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!matrix[r][c]) continue;
      for (let y = 0; y < skala; y++) {
        for (let x = 0; x < skala; x++) {
          const i = ((r + 4) * skala + y) * b * 4 + ((c + 4) * skala + x) * 4;
          daten[i] = daten[i + 1] = daten[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(daten, b, b)?.data;
}

/** Liest unser 8-Bit-Graustufen-PNG (Filter 0) und dekodiert es. */
function pngDekodieren(png) {
  assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  const breite = png.readUInt32BE(16);
  let o = 8;
  const idat = [];
  while (o < png.length) {
    const laenge = png.readUInt32BE(o);
    const typ = png.subarray(o + 4, o + 8).toString('ascii');
    if (typ === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + laenge));
    o += 12 + laenge;
  }
  const roh = zlib.inflateSync(Buffer.concat(idat));
  const rgba = new Uint8ClampedArray(breite * breite * 4);
  for (let y = 0; y < breite; y++) {
    for (let x = 0; x < breite; x++) {
      const g = roh[y * (breite + 1) + 1 + x];
      rgba.set([g, g, g, 255], (y * breite + x) * 4);
    }
  }
  return jsQR(rgba, breite, breite)?.data;
}

describe('QR-Code', () => {
  it('Zahlungs-URI (Monero) und Lizenz lassen sich dekodieren', () => {
    assert.equal(dekodieren(qrMatrix(MONERO_URI)), MONERO_URI);
    assert.equal(dekodieren(qrMatrix(LIZENZ), 3), LIZENZ);
  });

  it('SVG ist eigenstaendig: kein Skript, keine externen Verweise', () => {
    const svg = qrSvg(MONERO_URI);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
    assert.ok(!/<script|href=|xlink|<image|<foreignObject/i.test(svg));
    assert.match(svg, /<path fill="#000000" d="M\d/);
  });

  it('PNG (Ausweichloesung fuer die Sicherheitsstufe "Am sichersten") ist lesbar', () => {
    assert.equal(pngDekodieren(qrPng(MONERO_URI)), MONERO_URI);
    assert.equal(pngDekodieren(qrPng(LIZENZ, { skala: 5 })), LIZENZ);
  });

  it('nur kurzer ASCII-Text', () => {
    assert.throws(() => qrMatrix(''));
    assert.throws(() => qrMatrix('ä'));
    assert.throws(() => qrMatrix('x'.repeat(501)));
  });

  it('BIP21-URI ohne ueberfluessige Nullen', () => {
    assert.equal(bip21('bc1qtest', '0.00004087'), 'bitcoin:bc1qtest?amount=0.00004087');
    assert.equal(bip21('bc1qtest', '0.00010000'), 'bitcoin:bc1qtest?amount=0.0001');
  });
});
