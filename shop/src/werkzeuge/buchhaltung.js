#!/usr/bin/env node
// Buchhaltung auf der Kommandozeile (auf dem Server als Dienstnutzer ausfuehren:
//   sudo -u malachi-shop node /opt/malachi-shop/src/werkzeuge/buchhaltung.js <befehl> ...)
//
// Befehle:
//   pruefen                                   Hash-Ketten aller Journale pruefen
//   bestand [--kurs XMR=486.27]               Bestand und Jahresuebersicht des laufenden Jahres
//   verkauf --datum JJJJ-MM-TT --waehrung XMR --menge 0.5 --erloes 240.10 [--gebuehr 1.20]
//           --dienst "Name" [--referenz ...] [--notiz ...]
//   gebuehr --datum ... --waehrung EUR|XMR|BTC --betrag ... --betrag-eur ... --dienst ... [--referenz] [--notiz]
//   auszahlung --datum ... --waehrung EUR|XMR|BTC --betrag ... --betrag-eur ... --dienst ... [--referenz]
//   storno --journal verkaeufe|gebuehren|auszahlungen|einnahmen|sonstige --seq N --notiz "Grund"
//   export --jahr 2026 --ziel ./export [--kurs XMR=486.27]   CSV-Dateien schreiben
//   sicherungsschluessel --ausgabe privat.pem  Schluesselpaar fuer Sicherungen (privat bleibt offline)
//   entschluesseln --schluessel privat.pem --sicherung datei.bin --ziel ordner
//
// Datenverzeichnis: --daten <ordner> oder aus der Konfiguration (--config, MALACHI_SHOP_CONFIG,
// Standard /etc/malachi-shop/config.json).

import fs from 'node:fs';
import path from 'node:path';
import { Buchhaltung, JOURNALE } from '../buchhaltung.js';
import { einnahmenCsv, verkaeufeCsv, gebuehrenCsv, sonstigeCsv, jahresuebersicht, jahresuebersichtCsv } from '../auswertung.js';
import { sicherungsSchluesselErzeugen, entschluesseln, auspacken } from '../sicherung.js';
import { ladeKonfiguration } from '../config.js';

function optionen(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unerwartetes Argument: ${argv[i]}`);
    o[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return o;
}

function datenVerzeichnis(o) {
  if (o.daten) return path.resolve(o.daten);
  const datei = o.config || process.env.MALACHI_SHOP_CONFIG || '/etc/malachi-shop/config.json';
  return ladeKonfiguration(datei, { erlaubeTestwerte: true }).konfig.datenVerzeichnis;
}

function kurse(o) {
  const k = {};
  for (const teil of String(o.kurs || '').split(',').filter(Boolean)) {
    const [w, wert] = teil.split('=');
    k[w] = wert;
  }
  return k;
}

const pflicht = (o, ...namen) => {
  for (const n of namen) if (o[n] === undefined) throw new Error(`--${n} fehlt`);
};

async function main() {
  const [befehl, ...rest] = process.argv.slice(2);
  const o = optionen(rest);

  if (befehl === 'sicherungsschluessel') {
    pflicht(o, 'ausgabe');
    const { privatPem, oeffentlich } = sicherungsSchluesselErzeugen();
    fs.writeFileSync(o.ausgabe, privatPem, { mode: 0o600, flag: 'wx' });
    console.log(`Privater Sicherungsschluessel: ${o.ausgabe} (offline aufbewahren, NICHT auf dem Server lassen).`);
    console.log(`In config.json eintragen: "buchhaltung": { "sicherungSchluessel": "${oeffentlich}" }`);
    return;
  }
  if (befehl === 'entschluesseln') {
    pflicht(o, 'schluessel', 'sicherung', 'ziel');
    const inhalt = auspacken(entschluesseln(fs.readFileSync(o.sicherung), fs.readFileSync(o.schluessel)));
    for (const [rel, b64] of Object.entries(inhalt.dateien)) {
      if (rel.includes('..') || path.isAbsolute(rel)) throw new Error('Unzulaessiger Pfad in der Sicherung');
      const ziel = path.join(o.ziel, rel);
      fs.mkdirSync(path.dirname(ziel), { recursive: true });
      fs.writeFileSync(ziel, Buffer.from(b64, 'base64'), { mode: 0o600 });
      console.log(`  ${rel}`);
    }
    console.log(`Sicherung vom ${inhalt.erstellt} nach ${o.ziel} entpackt.`);
    return;
  }

  const bh = new Buchhaltung({ verzeichnis: path.join(datenVerzeichnis(o), 'buchhaltung') });
  const alle = () => Object.fromEntries(JOURNALE.map((n) => [n, bh.lesen(n)]));

  switch (befehl) {
    case 'pruefen': {
      let ok = true;
      for (const [n, r] of Object.entries(bh.pruefen())) {
        console.log(`${n.padEnd(13)} ${r.ok ? `OK  ${r.anzahl} Eintraege, Kopf ${r.kopf}` : `FEHLER: ${r.fehler}`}`);
        ok &&= r.ok;
      }
      if (!ok) process.exitCode = 1;
      break;
    }
    case 'bestand': {
      const jahr = Number(o.jahr) || new Date().getUTCFullYear();
      console.log(JSON.stringify(jahresuebersicht(alle(), jahr, kurse(o)), null, 2));
      break;
    }
    case 'verkauf':
      pflicht(o, 'datum', 'waehrung', 'menge', 'erloes', 'dienst');
      console.log(await bh.verkaufBuchen({ datum: o.datum, waehrung: o.waehrung, mengeCoin: o.menge, erloesEur: o.erloes, gebuehrEur: o.gebuehr || '0', dienst: o.dienst, referenz: o.referenz, notiz: o.notiz }) || 'Bereits gebucht (gleiche Referenz).');
      break;
    case 'gebuehr':
      pflicht(o, 'datum', 'waehrung', 'betrag', 'betrag-eur', 'dienst');
      console.log(await bh.gebuehrBuchen({ datum: o.datum, waehrung: o.waehrung, betrag: o.betrag, betragEur: o['betrag-eur'], dienst: o.dienst, referenz: o.referenz, notiz: o.notiz }) || 'Bereits gebucht.');
      break;
    case 'auszahlung':
      pflicht(o, 'datum', 'waehrung', 'betrag', 'betrag-eur', 'dienst');
      console.log(await bh.auszahlungBuchen({ datum: o.datum, waehrung: o.waehrung, betrag: o.betrag, betragEur: o['betrag-eur'], dienst: o.dienst, referenz: o.referenz, notiz: o.notiz }) || 'Bereits gebucht.');
      break;
    case 'storno':
      pflicht(o, 'journal', 'seq', 'notiz');
      console.log(await bh.stornoBuchen(o.journal, Number(o.seq), o.notiz));
      break;
    case 'export': {
      pflicht(o, 'jahr', 'ziel');
      const jahr = Number(o.jahr);
      const j = alle();
      fs.mkdirSync(o.ziel, { recursive: true });
      const dateien = {
        [`einnahmen-${jahr}.csv`]: einnahmenCsv(j.einnahmen, jahr),
        [`verkaeufe-${jahr}.csv`]: verkaeufeCsv(j.verkaeufe, jahr),
        [`gebuehren-${jahr}.csv`]: gebuehrenCsv(j.gebuehren, jahr),
        [`auszahlungen-${jahr}.csv`]: gebuehrenCsv(j.auszahlungen, jahr, 'Auszahlung'),
        [`sonstige-eingaenge-${jahr}.csv`]: sonstigeCsv(j.sonstige, jahr),
        [`jahresuebersicht-${jahr}.csv`]: jahresuebersichtCsv(jahresuebersicht(j, jahr, kurse(o))),
      };
      for (const [name, inhalt] of Object.entries(dateien)) {
        fs.writeFileSync(path.join(o.ziel, name), inhalt);
        console.log(`  ${name}`);
      }
      break;
    }
    default:
      console.log('Befehle: pruefen, bestand, verkauf, gebuehr, auszahlung, storno, export, sicherungsschluessel, entschluesseln (Details im Dateikopf)');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('Fehler: ' + e.message);
  process.exit(2);
});
