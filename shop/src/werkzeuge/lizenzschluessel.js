#!/usr/bin/env node
// Lizenz-Signierschluessel erzeugen bzw. den oeffentlichen Schluessel anzeigen.
//
//   node src/werkzeuge/lizenzschluessel.js erzeugen --ausgabe /etc/malachi-shop/lizenz-privat.pem
//   node src/werkzeuge/lizenzschluessel.js anzeigen --datei /etc/malachi-shop/lizenz-privat.pem
//
// Der private Schluessel wird mit Dateirechten 0600 geschrieben und nie ueberschrieben.
// Ausgegeben wird der OEFFENTLICHE Schluessel zum Einbau in die App.

import fs from 'node:fs';
import path from 'node:path';
import { schluesselpaarErzeugen, lizenzschluesselLaden, oeffentlichRoh } from '../lizenz.js';
import { base64urlKodieren } from '../lizenzpruefer.js';

function ausgeben(roh) {
  const b64 = base64urlKodieren(roh);
  const hex = Buffer.from(roh).toString('hex');
  console.log('\nOeffentlicher Lizenzschluessel (Ed25519, 32 Byte) - zum Einbau in die App:\n');
  console.log(`  base64url: ${b64}`);
  console.log(`  hex:       ${hex}\n`);
  console.log('JavaScript (App):');
  console.log(`  export const LIZENZ_SCHLUESSEL = ['${b64}'];\n`);
  console.log('Kotlin:');
  console.log(`  val LIZENZ_SCHLUESSEL = listOf("${b64}")\n`);
}

function main() {
  const [befehl, ...rest] = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];

  if (befehl === 'erzeugen') {
    const ziel = opt.ausgabe;
    if (!ziel) throw new Error('--ausgabe <datei> fehlt');
    if (fs.existsSync(ziel)) throw new Error(`${ziel} existiert bereits - wird nicht ueberschrieben. Ein neuer Schluessel wuerde alle bisherigen Lizenzen ungueltig machen, solange die App ihn nicht kennt.`);
    fs.mkdirSync(path.dirname(path.resolve(ziel)), { recursive: true });
    const { privatPem, oeffentlichRoh: roh } = schluesselpaarErzeugen();
    fs.writeFileSync(ziel, privatPem, { mode: 0o600, flag: 'wx' });
    console.log(`Privater Lizenzschluessel geschrieben: ${ziel} (Rechte 600).`);
    console.log('SICHERN: verschluesselt und offline aufbewahren (siehe ANLEITUNG.md). Geht er verloren, koennen keine neuen Lizenzen mehr ausgestellt werden, die bestehende App-Versionen akzeptieren.');
    ausgeben(roh);
  } else if (befehl === 'anzeigen') {
    if (!opt.datei) throw new Error('--datei <datei> fehlt');
    ausgeben(oeffentlichRoh(lizenzschluesselLaden(opt.datei, { erlaubeTestschluessel: true })));
  } else {
    console.log('Verwendung:\n  lizenzschluessel.js erzeugen --ausgabe <datei>\n  lizenzschluessel.js anzeigen --datei <datei>');
    process.exitCode = 2;
  }
}

try {
  main();
} catch (e) {
  console.error('Fehler: ' + e.message);
  process.exit(2);
}
