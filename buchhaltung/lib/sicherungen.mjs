// Liest die neueste verschluesselte Tagessicherung des Shops - nur im Arbeitsspeicher.
// Es wird nie eine entschluesselte Datei geschrieben.
import fs from 'node:fs';
import path from 'node:path';
import { entschluesseln, auspacken } from '../../shop/src/sicherung.js';
import { JOURNALE, ketteVerifizieren } from '../../shop/src/buchhaltung.js';

const NAME = /^malachi-sicherung-(\d{4}-\d{2}-\d{2})\.bin$/;

export function neuesteSicherung(ordner) {
  if (!fs.existsSync(ordner)) throw new Error(`Sicherungsordner fehlt: ${ordner}`);
  const dateien = fs.readdirSync(ordner).filter((d) => NAME.test(d)).sort();
  if (!dateien.length) throw new Error(`Keine Shop-Sicherung in ${ordner} - laeuft die Aufgabe "Malachi Shop-Sicherungen abholen"?`);
  const datei = dateien[dateien.length - 1];
  return { pfad: path.join(ordner, datei), tag: NAME.exec(datei)[1] };
}

/**
 * Entschluesselt eine Sicherung und liefert die Journale samt Kettenpruefung.
 * @returns {{erstellt: string, journale: Record<string, object[]>, ketten: Record<string, object>}}
 */
export function sicherungLesen(pfad, privatPem) {
  let gepackt;
  try {
    gepackt = entschluesseln(fs.readFileSync(pfad), privatPem);
  } catch (e) {
    throw new Error(`Sicherung ${path.basename(pfad)} laesst sich nicht entschluesseln (falscher Schluessel oder Datei beschaedigt): ${e.message}`);
  }
  const inhalt = auspacken(gepackt);
  const journale = {};
  const ketten = {};
  for (const name of JOURNALE) {
    const b64 = inhalt.dateien[`buchhaltung/${name}.jsonl`];
    const text = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
    journale[name] = text.split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
    ketten[name] = ketteVerifizieren(name, journale[name]);
  }
  return { erstellt: inhalt.erstellt, journale, ketten };
}
