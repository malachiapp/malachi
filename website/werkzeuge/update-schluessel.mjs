#!/usr/bin/env node
// Update-Signierschluessel (Ed25519) verwalten - nur auf dem eigenen PC, OFFLINE.
//
//   node website/werkzeuge/update-schluessel.mjs erzeugen  [--datei <pfad>]
//   node website/werkzeuge/update-schluessel.mjs anzeigen  [--datei <pfad>]
//   node website/werkzeuge/update-schluessel.mjs pruefen   --manifest <manifest.json> [--signatur <datei>] [--schluessel <base64url>]
//
// Standard-Pfad der Schluesseldatei: ~/.malachi/update-signierschluessel.json
// (unter Windows C:\Users\<name>\.malachi\...). Empfehlung: auf einem
// verschluesselten USB-Stick ablegen und nur zum Signieren einstecken.
// Format und Pruefregeln: website/UPDATE_FORMAT.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  schluesseldateiErzeugen, schluesseldateiSchreiben, schluesseldateiLesen, passphraseLesen, MIN_PASSPHRASE,
  base64urlDekodieren, oeffentlichPem, pruefen, signaturDateiLesen,
} from './lib/krypto.mjs';
import { manifestLesen } from './lib/manifest.mjs';

const STANDARD = path.join(os.homedir(), '.malachi', 'update-signierschluessel.json');

function ausgeben(b64url) {
  const roh = base64urlDekodieren(b64url, 32);
  console.log('\nOeffentlicher Update-Schluessel (Ed25519, 32 Byte):\n');
  console.log(`  base64url: ${b64url}`);
  console.log(`  hex:       ${roh.toString('hex')}\n`);
  console.log('website/seite.json:');
  console.log(`  "updateSchluessel": "${b64url}"\n`);
  console.log('App (AppConfig.js), Liste fuer spaeteren Schluesselwechsel:');
  console.log(`  export const UPDATE_PUBLIC_KEYS = ['${b64url}'];\n`);
  console.log('PEM (fuer openssl):');
  console.log(oeffentlichPem(roh));
}

function optionen(rest) {
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--') || rest[i + 1] === undefined) throw new Error(`Ungueltiges Argument: ${k}`);
    o[k.slice(2)] = rest[++i];
  }
  return o;
}

async function main() {
  const [befehl, ...rest] = process.argv.slice(2);
  const o = optionen(rest);
  if (befehl === 'erzeugen') {
    const datei = path.resolve(o.datei || STANDARD);
    if (fs.existsSync(datei)) throw new Error(`${datei} existiert bereits - wird nie ueberschrieben. Ein neuer Schluessel braucht ein App-Update, bevor er gilt.`);
    console.log(`Neuer Update-Signierschluessel: ${datei}`);
    console.log(`Passphrase: mindestens ${MIN_PASSPHRASE} Zeichen, am besten 5-6 zufaellige Woerter. Ohne sie ist der Schluessel unbrauchbar.`);
    const p1 = await passphraseLesen('Passphrase: ');
    const p2 = process.env.MALACHI_UPDATE_PASSPHRASE ? p1 : await passphraseLesen('Passphrase wiederholen: ');
    if (p1 !== p2) throw new Error('Die Passphrasen stimmen nicht ueberein.');
    const { text } = schluesseldateiErzeugen(p1);
    schluesseldateiSchreiben(datei, text);
    console.log(`\nGeschrieben: ${datei}`);
    console.log('SICHERN: Datei + Passphrase getrennt aufbewahren (z. B. zwei USB-Sticks, Passphrase auf Papier). NIE auf den Laptop/Server kopieren.');
    ausgeben(schluesseldateiLesen(text).oeffentlich);
  } else if (befehl === 'anzeigen') {
    const datei = path.resolve(o.datei || STANDARD);
    ausgeben(schluesseldateiLesen(fs.readFileSync(datei, 'utf8')).oeffentlich);
  } else if (befehl === 'pruefen') {
    if (!o.manifest) throw new Error('--manifest <datei> fehlt');
    let schluessel = o.schluessel;
    if (!schluessel) {
      const konfig = JSON.parse(fs.readFileSync(new URL('../seite.json', import.meta.url), 'utf8'));
      schluessel = konfig.updateSchluessel;
    }
    if (!schluessel) throw new Error('Kein oeffentlicher Schluessel (--schluessel oder website/seite.json "updateSchluessel").');
    const bytes = fs.readFileSync(o.manifest);
    const sig = signaturDateiLesen(fs.readFileSync(o.signatur || `${o.manifest}.sig`, 'utf8'));
    if (!pruefen(base64urlDekodieren(schluessel, 32), bytes, sig)) {
      console.error('UNGUELTIG: Die Signatur passt nicht zu diesem Manifest und Schluessel.');
      process.exitCode = 1;
      return;
    }
    const m = manifestLesen(bytes);
    console.log(`GUELTIG: ${m.applicationId} ${m.versionName} (versionCode ${m.versionCode}, mindestens ${m.minSupportedVersionCode}), veroeffentlicht ${m.published}`);
    for (const a of m.apks) console.log(`  ${a.abi.padEnd(12)} ${a.file}  ${a.size} Byte  ${a.sha256}`);
  } else {
    console.log('Verwendung:\n  update-schluessel.mjs erzeugen [--datei <pfad>]\n  update-schluessel.mjs anzeigen [--datei <pfad>]\n  update-schluessel.mjs pruefen --manifest <manifest.json> [--signatur <datei>] [--schluessel <base64url>]');
    process.exitCode = 2;
  }
}

try {
  await main();
} catch (e) {
  console.error(`FEHLER: ${e.message}`);
  process.exit(1);
}
