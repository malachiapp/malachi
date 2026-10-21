// Test-Hilfen: minimale PDF-Datei mit Textzeilen, temporaere Ordner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpOrdner(name = 'mb') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

/** Erzeugt eine gueltige einseitige PDF (Helvetica, WinAnsi) mit den gegebenen Zeilen. */
export function pdfMitText(zeilen) {
  const esc = (t) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const strom = 'BT /F1 11 Tf 50 800 Td 14 TL\n' + zeilen.map((z) => `(${esc(z)}) Tj T*`).join('\n') + '\nET';
  const objekte = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(strom, 'latin1')} >>\nstream\n${strom}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objekte.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const HETZNER_ZEILEN = [
  'Hetzner Online GmbH',
  'Industriestr. 25, 91710 Gunzenhausen',
  'Rechnung',
  'Rechnungsnr.: R0012345678',
  'Rechnungsdatum: 01.10.2026',
  'Kundennummer: K0987654',
  'Cloud Server CX22 01.09.2026 - 30.09.2026 3,79 EUR',
  'Summe netto 3,79 EUR',
  'USt. 19 % 0,72 EUR',
  'Gesamtbetrag 4,51 EUR',
];
