// QR-Code serverseitig erzeugen: als SVG (Standard) und als PNG (Ausweichloesung
// fuer den Tor-Browser in der Stufe "Am sichersten", die SVG komplett abschaltet).
// Keine externen Ressourcen, kein JavaScript.

import { deflateSync } from 'node:zlib';
import qrcode from 'qrcode-generator';

const RAND = 4; // Ruhezone in Modulen (laut Norm mindestens 4)

/** Modulmatrix fuer einen ASCII-Text (Fehlerkorrektur M). */
export function qrMatrix(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 500 || !/^[\x20-\x7e]+$/.test(text)) {
    throw new Error('QR: nur kurzer ASCII-Text erlaubt');
  }
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const zeilen = [];
  for (let r = 0; r < n; r++) {
    const zeile = new Array(n);
    for (let c = 0; c < n; c++) zeile[c] = qr.isDark(r, c);
    zeilen.push(zeile);
  }
  return zeilen;
}

/** SVG-Darstellung (schwarz auf weiss, skalierbar, ein einziger Pfad). */
export function qrSvg(text, { titel = 'QR-Code' } = {}) {
  const m = qrMatrix(text);
  const n = m.length;
  const groesse = n + 2 * RAND;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!m[r][c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && m[r][c]) c++;
      d += `M${start + RAND} ${r + RAND}h${c - start}v1h-${c - start}z`;
    }
  }
  const t = String(titel).replace(/[<>&"]/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${groesse} ${groesse}" class="qr" role="img" aria-label="${t}" shape-rendering="crispEdges">` +
    `<title>${t}</title><rect width="${groesse}" height="${groesse}" fill="#ffffff"/><path fill="#000000" d="${d}"/></svg>`
  );
}

// ---------------------------------------------------------------- PNG

const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABELLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngBlock(typ, daten) {
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(daten.length);
  const kopf = Buffer.from(typ, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([kopf, daten])));
  return Buffer.concat([laenge, kopf, daten, crc]);
}

/** Graustufen-PNG (8 Bit) mit `skala` Pixeln pro Modul. */
export function qrPng(text, { skala = 8 } = {}) {
  const m = qrMatrix(text);
  const n = m.length;
  const breite = (n + 2 * RAND) * skala;
  const zeilenLaenge = breite + 1; // + Filter-Byte
  const roh = Buffer.alloc(zeilenLaenge * breite, 0xff);
  for (let y = 0; y < breite; y++) {
    roh[y * zeilenLaenge] = 0; // Filter "None"
    const r = Math.floor(y / skala) - RAND;
    if (r < 0 || r >= n) continue;
    for (let x = 0; x < breite; x++) {
      const c = Math.floor(x / skala) - RAND;
      if (c >= 0 && c < n && m[r][c]) roh[y * zeilenLaenge + 1 + x] = 0x00;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(breite, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 0; // Graustufen
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngBlock('IHDR', ihdr),
    pngBlock('IDAT', deflateSync(roh, { level: 9 })),
    pngBlock('IEND', Buffer.alloc(0)),
  ]);
}

/** BIP21-Zahlungs-URI (Betrag als Dezimalzahl in BTC, ohne ueberfluessige Nullen). */
export function bip21(adresse, btcBetrag) {
  const betrag = String(btcBetrag).includes('.') ? String(btcBetrag).replace(/\.?0+$/, '') : String(btcBetrag);
  return `bitcoin:${adresse}?amount=${betrag}`;
}
