// Text aus einer PDF-Rechnung lesen (pdf.js, ohne Ausfuehrung von Skripten).
import fs from 'node:fs';

const MAX_SEITEN = 10;
const MAX_BYTES = 30 * 1024 * 1024;

/** Liefert den Text der PDF zeilenweise (Zeilen grob nach der Position rekonstruiert). */
export async function pdfText(datei) {
  const groesse = fs.statSync(datei).size;
  if (groesse > MAX_BYTES) throw new Error(`${datei}: groesser als 30 MB - bitte von Hand erfassen`);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const aufgabe = getDocument({
    data: new Uint8Array(fs.readFileSync(datei)),
    isEvalSupported: false, // keine dynamische Codeausfuehrung (Schutz vor praeparierten PDFs)
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await aufgabe.promise;
  try {
    const seiten = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_SEITEN); i++) {
      const seite = await doc.getPage(i);
      const inhalt = await seite.getTextContent();
      const zeilen = new Map();
      for (const teil of inhalt.items) {
        if (typeof teil.str !== 'string' || !teil.str.trim()) continue;
        const y = Math.round(teil.transform[5] / 2) * 2; // kleine Hoehenunterschiede zusammenfassen
        if (!zeilen.has(y)) zeilen.set(y, []);
        zeilen.get(y).push({ x: teil.transform[4], t: teil.str });
      }
      const text = [...zeilen.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, teile]) => teile.sort((a, b) => a.x - b.x).map((t) => t.t).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
      seiten.push(text);
    }
    return seiten.join('\n');
  } finally {
    await doc.destroy();
  }
}
