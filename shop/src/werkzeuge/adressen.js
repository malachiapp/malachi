#!/usr/bin/env node
// Nur fuer den optionalen Bitcoin-Zahlungsweg: zeigt die ersten Empfangsadressen,
// die der Shop aus der zpub ableitet, damit sie VOR dem Livegang mit dem Wallet
// (Sparrow, Electrum, ...) verglichen werden koennen.
//
//   node src/werkzeuge/adressen.js --zpub zpub6r... [--anzahl 10] [--start 0]

import { ladeKontoSchluessel, empfangsAdresse } from '../bip84.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../config.js';

function main() {
  const argv = process.argv.slice(2);
  let zpub = null;
  let anzahl = 10;
  let start = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zpub') zpub = argv[++i];
    else if (argv[i] === '--anzahl') anzahl = Number(argv[++i]);
    else if (argv[i] === '--start') start = Number(argv[++i]);
    else throw new Error(`Unbekanntes Argument: ${argv[i]}`);
  }
  if (!zpub) throw new Error('--zpub fehlt');
  if (!Number.isInteger(anzahl) || anzahl < 1 || anzahl > 1000) throw new Error('--anzahl: 1 bis 1000');
  if (!Number.isInteger(start) || start < 0) throw new Error('--start: ganze Zahl >= 0');
  const konto = ladeKontoSchluessel(zpub);
  if (zpub.trim() === BIP84_TESTVEKTOR_ZPUB) console.log('ACHTUNG: oeffentlicher BIP84-Testvektor - NIEMALS echte Zahlungen dorthin!\n');
  console.log(`Schluesseltyp ${konto.art}, Konto ${konto.kontoNummer}', Ableitung m/84'/0'/${konto.kontoNummer}'/0/i (native SegWit)\n`);
  for (let i = start; i < start + anzahl; i++) console.log(`m/0/${i}\t${empfangsAdresse(konto, i)}`);
}

try {
  main();
} catch (e) {
  console.error('Fehler: ' + e.message);
  process.exit(2);
}
