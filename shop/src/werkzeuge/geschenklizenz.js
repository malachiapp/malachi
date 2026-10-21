#!/usr/bin/env node
// Geschenk-Lizenz (Freunde, Familie, Beta-Tester) fuer GENAU EIN Geraet ausstellen.
// Kein Kauf: keine Bestellung, keine Einnahme in der Buchhaltung, kein Umzug
// (ohne Wiederherstellungscode). Nach einer Neuinstallation einfach neu ausstellen.
//
//   sudo node /opt/malachi-shop/src/werkzeuge/geschenklizenz.js --geraet <Geraetecode> [--notiz "Mama"]
//   sudo node /opt/malachi-shop/src/werkzeuge/geschenklizenz.js <Geraetecode> ["Mama"]     (Kurzform)
//   sudo node /opt/malachi-shop/src/werkzeuge/geschenklizenz.js --liste
//
// Ablauf: Der Tester oeffnet in der App "Vollversion" -> "Geraetecode anzeigen"
// und schickt dir den Code (er ist kein Geheimnis). Die hier ausgegebene Lizenz
// (beginnt mit "ML1.") fuegt er unter "Lizenz eingeben" ein.
//
// Protokoll ohne Lizenztext (wer hat wann eine bekommen): standardmaessig
// /etc/malachi-shop/geschenklizenzen.jsonl (root, 0600).

import fs from 'node:fs';
import path from 'node:path';
import { lizenzschluesselLaden, lizenzSignieren, lizenzPruefenMitSchluessel } from '../lizenz.js';
import { geraetecodeNormalisieren, geraetecodeGruppieren } from '../lizenzpruefer.js';
import { bestellnummerErzeugen } from '../ids.js';

const STANDARD_SCHLUESSEL = '/etc/malachi-shop/lizenz-privat.pem';
const STANDARD_PROTOKOLL = '/etc/malachi-shop/geschenklizenzen.jsonl';
const STANDARD_CONFIG = '/etc/malachi-shop/config.json';

function argumente(argv) {
  const o = { geraet: null, notiz: '', schluessel: STANDARD_SCHLUESSEL, protokoll: STANDARD_PROTOKOLL, config: STANDARD_CONFIG, liste: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--liste') o.liste = true;
    else if (['--geraet', '--notiz', '--schluessel', '--protokoll', '--config'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a}: Wert fehlt`);
      o[a.slice(2)] = argv[++i];
    } else if (!a.startsWith('--') && !o.geraet) o.geraet = a; // Kurzform: Geraetecode ohne --geraet ...
    else if (!a.startsWith('--') && !o.notiz) o.notiz = a; // ... und die Notiz dahinter
    else throw new Error(`Unbekanntes Argument: ${a} (Aufruf: geschenklizenz.js --geraet <Geraetecode> --notiz "Name")`);
  }
  return o;
}

/** Features wie bei gekauften Lizenzen (config.json lizenz.features), sonst ["pro"]. */
function features(configDatei) {
  try {
    const f = JSON.parse(fs.readFileSync(configDatei, 'utf8')).lizenz?.features;
    if (Array.isArray(f) && f.length && f.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(x))) return [...f].sort();
  } catch {
    // keine/unlesbare Konfiguration -> Standard
  }
  return ['pro'];
}

function main() {
  const o = argumente(process.argv.slice(2));
  if (o.liste) {
    if (!fs.existsSync(o.protokoll)) return console.log('Noch keine Geschenk-Lizenzen ausgestellt.');
    for (const z of fs.readFileSync(o.protokoll, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(z);
      console.log(`${e.zeit.slice(0, 16).replace('T', ' ')}  Lizenz ${e.lic}  Geraet ${geraetecodeGruppieren(e.dev)}  ${e.notiz || ''}`);
    }
    return;
  }
  const dev = geraetecodeNormalisieren(o.geraet || '');
  if (!dev) throw new Error('--geraet: ungueltiger Geraetecode (34 Zeichen, so wie die App ihn unter "Geraetecode anzeigen" zeigt)');
  const notiz = String(o.notiz).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);

  const schluessel = lizenzschluesselLaden(o.schluessel, { erlaubeTestschluessel: process.env.MALACHI_SHOP_TESTWERTE_ERLAUBT === '1' });
  const lic = bestellnummerErzeugen();
  const iat = Math.floor(Date.now() / 1000);
  const lizenz = lizenzSignieren(schluessel, { lic, dev, ord: bestellnummerErzeugen(), iat, feat: features(o.config) });
  const probe = lizenzPruefenMitSchluessel(lizenz, schluessel, dev);
  if (!probe.gueltig) throw new Error('Selbstpruefung der Lizenz fehlgeschlagen: ' + probe.grund);

  fs.mkdirSync(path.dirname(path.resolve(o.protokoll)), { recursive: true });
  fs.appendFileSync(o.protokoll, JSON.stringify({ zeit: new Date(iat * 1000).toISOString(), lic, dev, notiz }) + '\n', { mode: 0o600 });

  console.log(`\nGeschenk-Lizenz ${lic} fuer Geraet ${geraetecodeGruppieren(dev)}${notiz ? ` (${notiz})` : ''}:\n`);
  console.log(lizenz);
  console.log('\nIn der App: Vollversion -> "Lizenz eingeben" -> einfuegen -> "Pruefen und speichern".');
  console.log('Gilt nur fuer dieses Geraet. Tipp: ueber Malachi selbst verschicken.\n');
}

try {
  main();
} catch (e) {
  console.error('Fehler: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
}
