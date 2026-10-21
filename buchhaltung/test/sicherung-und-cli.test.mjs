import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buchhaltung } from '../../shop/src/buchhaltung.js';
import { sicherungsSchluesselErzeugen, taeglicheSicherung } from '../../shop/src/sicherung.js';
import { neuesteSicherung, sicherungLesen } from '../lib/sicherungen.mjs';
import { letztesAbgeschlossenesQuartal } from '../lib/zeitraum.mjs';
import { tmpOrdner, pdfMitText, HETZNER_ZEILEN } from './hilfen.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'malachi-buchhaltung.mjs');

/** Shop-Datenordner mit echter Hash-Kette + verschluesselte Tagessicherung. */
async function shopMitSicherung() {
  const daten = tmpOrdner('shop');
  const bh = new Buchhaltung({ verzeichnis: path.join(daten, 'buchhaltung'), jetzt: () => Date.parse('2026-08-10T12:00:00Z') });
  await bh.einnahmeBuchen({ bestellung: 'B1', lizenzId: 'L1', zahlungsweg: 'xmr', betragEur: '2.99', waehrung: 'XMR', betragCoin: '0.01', empfangenCoin: '0.01', ueberzahlungCoin: '0', kursEur: '299', kursQuelle: 'test', kursZeit: '2026-08-10T12:00:00Z', txids: ['t1'], umsatzsteuer: { kleinunternehmer: true } });
  fs.writeFileSync(path.join(daten, 'bestellungen.json'), '{}');
  const { privatPem, oeffentlich } = sicherungsSchluesselErzeugen();
  const sicherungen = tmpOrdner('sich');
  await taeglicheSicherung({ datenVerzeichnis: daten, zielVerzeichnis: sicherungen, empfaenger: oeffentlich, jetzt: Date.now() });
  const schluessel = path.join(tmpOrdner('key'), 'privat.pem');
  fs.writeFileSync(schluessel, privatPem);
  return { sicherungen, schluessel };
}

test('verschluesselte Sicherung wird im Speicher gelesen und geprueft', async () => {
  const { sicherungen, schluessel } = await shopMitSicherung();
  const s = neuesteSicherung(sicherungen);
  const d = sicherungLesen(s.pfad, fs.readFileSync(schluessel, 'utf8'));
  assert.equal(d.journale.einnahmen.length, 1);
  assert.equal(d.ketten.einnahmen.ok, true);
  assert.equal(d.journale.einnahmen[0].rechnungsnummer, 'MAL-2026-000001');
  const falsch = sicherungsSchluesselErzeugen().privatPem;
  assert.throws(() => sicherungLesen(s.pfad, falsch), /nicht entschluesseln/);
  assert.throws(() => neuesteSicherung(tmpOrdner('leer')), /Keine Shop-Sicherung/);
});

test('Ende-zu-Ende: einrichten, Hetzner-PDF automatisch buchen, Quartalsbericht, Status, EUeR', async () => {
  const { sicherungen, schluessel } = await shopMitSicherung();
  const ordner = tmpOrdner('buch');
  const lauf = (...args) => execFileSync(process.execPath, [CLI, ...args, '--ordner', ordner], { encoding: 'utf8' });

  assert.match(lauf('einrichten'), /Eingerichtet/);
  const einst = JSON.parse(fs.readFileSync(path.join(ordner, 'einstellungen.json'), 'utf8'));
  fs.writeFileSync(path.join(ordner, 'einstellungen.json'), JSON.stringify({ ...einst, sicherungsOrdner: sicherungen, privaterSchluessel: schluessel, erinnerung: { XMR: '1' } }));

  const eingang = path.join(ordner, 'Belege', 'Eingang');
  fs.writeFileSync(path.join(eingang, 'Hetzner-Rechnung.pdf'), pdfMitText(HETZNER_ZEILEN));
  fs.writeFileSync(path.join(eingang, 'irgendwas.pdf'), pdfMitText(['Unbekannter Laden', 'Total 12,00 EUR']));

  const ausgabe = lauf('bericht', '--automatisch');
  const zr = letztesAbgeschlossenesQuartal();
  assert.match(ausgabe, /GEBUCHT: Nr\. 1 · Hetzner Online GmbH · 4,51 €/);
  assert.match(ausgabe, /OFFEN: irgendwas\.pdf/);
  assert.match(ausgabe, new RegExp(`NEU: Quartalsbericht ${zr.name}`));
  assert.ok(fs.existsSync(path.join(ordner, 'Belege', '2026', '2026-10-01_Hetzner_R0012345678.pdf')));
  assert.ok(fs.existsSync(path.join(eingang, 'irgendwas.pdf')));
  assert.ok(!fs.existsSync(path.join(eingang, 'Hetzner-Rechnung.pdf')));
  const html = fs.readFileSync(path.join(ordner, 'Berichte', zr.name, 'bericht.html'), 'utf8');
  assert.match(html, /irgendwas\.pdf/); // offener Beleg wird im Bericht genannt
  for (const f of ['uebersicht.csv', 'einnahmen.csv', 'ausgaben.csv', 'euer-entwurf.csv']) assert.ok(fs.existsSync(path.join(ordner, 'Berichte', zr.name, f)), f);

  // zweiter Lauf: nichts doppelt
  assert.match(lauf('bericht', '--automatisch'), /existiert bereits/);

  // manuelle Ausgabe + Storno
  assert.match(lauf('ausgabe', '--datum', '2026-10-15', '--betrag', '1,50', '--anbieter', 'Bank', '--kategorie', 'gebuehren'), /GEBUCHT: Nr\. 2/);
  assert.match(lauf('storno', '--seq', '2', '--notiz', 'Test'), /STORNIERT/);

  const st = lauf('status');
  assert.match(st, /Ausgabenbuch: {2}3 Einträge, Kette intakt/);
  assert.match(st, /Belege offen: {2}1/);
  assert.match(st, /Ketten intakt/);

  assert.match(lauf('euer', '--jahr', '2026'), /EÜR-Entwurf 2026/);
  const euer = fs.readFileSync(path.join(ordner, 'Berichte', '2026-EUER-Entwurf', 'euer-entwurf.csv'), 'utf8');
  assert.match(euer, /Kleinunternehmer;2,99/);
  assert.match(euer, /Betriebsausgaben;4,51/); // Hetzner (Bank-Gebuehr storniert)
});
