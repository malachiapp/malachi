// Prueft nur, ob die Passphrase des Update-Signierschluessels stimmt.
// Gibt weder die Passphrase noch den Schluessel aus; bei falscher Eingabe nur
// die Anzahl der eingelesenen Zeichen (zum Vergleich mit dem, was du getippt hast).
//
//   node website/werkzeuge/passphrase-test.mjs [--datei <pfad>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { passphraseLesen, schluesseldateiOeffnen } from './lib/krypto.mjs';

const i = process.argv.indexOf('--datei');
const datei = i > 0 ? process.argv[i + 1] : path.join(os.homedir(), '.malachi', 'update-signierschluessel.json');
const text = fs.readFileSync(datei, 'utf8');
if (process.env.MALACHI_UPDATE_PASSPHRASE) {
  console.log('Hinweis: MALACHI_UPDATE_PASSPHRASE ist gesetzt und wird statt einer Eingabe verwendet.');
}

for (let versuch = 1; versuch <= 5; versuch++) {
  const p = await passphraseLesen(`Versuch ${versuch}/5 - Passphrase: `);
  try {
    schluesseldateiOeffnen(text, p);
    console.log('RICHTIG - die Passphrase stimmt. Jetzt veroeffentlichen.ps1 erneut starten.');
    process.exit(0);
  } catch {
    console.log(`falsch (eingelesen wurden ${[...p].length} Zeichen)`);
    if (process.env.MALACHI_UPDATE_PASSPHRASE) process.exit(1);
  }
}
process.exit(1);
