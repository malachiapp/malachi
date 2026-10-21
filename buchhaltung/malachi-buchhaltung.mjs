#!/usr/bin/env node
// Malachi-Buchhaltung auf dem PC des Betreibers.
//
//   node malachi-buchhaltung.mjs einrichten              Ordner und einstellungen.json anlegen
//   node malachi-buchhaltung.mjs belege [--automatisch]  PDF-Rechnungen aus Belege\Eingang erfassen
//   node malachi-buchhaltung.mjs ausgabe --datum JJJJ-MM-TT --betrag 12,50 --anbieter "Name" --kategorie server
//                                [--bezahlt-am JJJJ-MM-TT] [--rechnungsnummer ...] [--beschreibung ...]
//                                [--waehrung USD --betrag-original 25,00]
//   node malachi-buchhaltung.mjs storno --seq N --notiz "Grund"
//   node malachi-buchhaltung.mjs bericht [--quartal 2026-Q4] [--automatisch]
//   node malachi-buchhaltung.mjs euer --jahr 2026
//   node malachi-buchhaltung.mjs status
//   node malachi-buchhaltung.mjs kategorien
//
// Datenordner: --ordner <pfad>, sonst MALACHI_BUCHHALTUNG, sonst %USERPROFILE%\Malachi-Buchhaltung.
// Alles bleibt auf diesem PC. Shop-Daten kommen aus den verschluesselten Tagessicherungen und
// werden nur im Arbeitsspeicher entschluesselt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { Ausgabenbuch, eurNormalisieren } from './lib/ausgaben.mjs';
import { KATEGORIEN, KATEGORIE_SCHLUESSEL } from './lib/kategorien.mjs';
import { erkennen } from './lib/erkennung.mjs';
import { neuesteSicherung, sicherungLesen } from './lib/sicherungen.mjs';
import { berechnen, csvDateien, htmlSeite, euro } from './lib/bericht.mjs';
import { quartal, jahr as jahrZeitraum, letztesAbgeschlossenesQuartal, laufendesQuartal, deutschesDatum } from './lib/zeitraum.mjs';

const STANDARD_EINSTELLUNGEN = {
  _hinweis: 'Einstellungen der Malachi-Buchhaltung. Erinnerung: EUR-Grenze (Eingangswert) je Coin, ab der der Bericht an einen Verkauf erinnert.',
  sicherungsOrdner: path.join(os.homedir(), 'Malachi-Backups', 'shop-sicherungen'),
  privaterSchluessel: path.join(os.homedir(), '.malachi', 'buchhaltung-sicherung-privat.pem'),
  erinnerung: { XMR: '100', BTC: '50' },
  serverBefehl: 'ssh -i %USERPROFILE%\\.ssh\\malachi_hetzner root@46.225.2.50 sudo -u malachi-shop node /opt/malachi-shop/src/werkzeuge/buchhaltung.js',
};

function optionen(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

function pfade(o) {
  const basis = path.resolve(o.ordner || process.env.MALACHI_BUCHHALTUNG || path.join(os.homedir(), 'Malachi-Buchhaltung'));
  return {
    basis,
    einstellungen: path.join(basis, 'einstellungen.json'),
    ausgaben: path.join(basis, 'ausgaben.jsonl'),
    eingang: path.join(basis, 'Belege', 'Eingang'),
    belege: path.join(basis, 'Belege'),
    berichte: path.join(basis, 'Berichte'),
  };
}

function einstellungenLaden(p) {
  if (!fs.existsSync(p.einstellungen)) throw new Error(`Noch nicht eingerichtet - zuerst: malachi-buchhaltung einrichten (erwartet ${p.einstellungen})`);
  const e = { ...STANDARD_EINSTELLUNGEN, ...JSON.parse(fs.readFileSync(p.einstellungen, 'utf8').replace(/^\uFEFF/, '')) };
  e.erinnerung = { ...STANDARD_EINSTELLUNGEN.erinnerung, ...(e.erinnerung || {}) };
  return e;
}

function einrichten(p) {
  for (const d of [p.basis, p.eingang, p.berichte]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(p.einstellungen)) fs.writeFileSync(p.einstellungen, JSON.stringify(STANDARD_EINSTELLUNGEN, null, 2) + '\n', { flag: 'wx' });
  console.log(`Eingerichtet: ${p.basis}\n  Belege hier ablegen:  ${p.eingang}\n  Berichte:             ${p.berichte}\n  Einstellungen:        ${p.einstellungen}`);
}

function wartendeBelege(p) {
  if (!fs.existsSync(p.eingang)) return [];
  return fs.readdirSync(p.eingang).filter((d) => /\.pdf$/i.test(d) && fs.statSync(path.join(p.eingang, d)).isFile());
}

const sicherName = (t) => String(t || '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Beleg';

/** Freier Ablagepfad Belege\<Jahr>\<Datum>_<Anbieter>_<Nr>.pdf (relativ zum Datenordner, nichts wird ueberschrieben). */
function belegZiel(p, { datum, anbieter, rechnungsnummer }) {
  const ordner = path.join(p.belege, String(datum).slice(0, 4));
  const stamm = `${datum}_${sicherName(String(anbieter).split(' ')[0])}${rechnungsnummer ? '_' + sicherName(rechnungsnummer) : ''}`;
  let ziel = path.join(ordner, stamm + '.pdf');
  for (let i = 2; fs.existsSync(ziel); i++) ziel = path.join(ordner, `${stamm}_${i}.pdf`);
  return path.relative(p.basis, ziel);
}

async function frage(rl, text, vorgabe) {
  const a = (await rl.question(vorgabe ? `${text} [${vorgabe}]: ` : `${text}: `)).trim();
  return a || vorgabe || '';
}

async function belege(p, o) {
  const { pdfText } = await import('./lib/pdftext.mjs');
  const buch = new Ausgabenbuch(p.ausgaben);
  const dateien = wartendeBelege(p);
  if (!dateien.length) { console.log(`Keine neuen Belege in ${p.eingang}.`); return; }
  const rl = o.automatisch ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  let gebucht = 0;
  let offen = 0;
  try {
    for (const name of dateien) {
      const quelle = path.join(p.eingang, name);
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(quelle)).digest('hex');
      let e;
      try {
        e = erkennen(await pdfText(quelle));
      } catch (err) {
        e = { anbieter: null, kategorie: null, beschreibung: '', rechnungsnummer: null, datum: null, betrag: null, waehrung: null, sicher: false };
        console.log(`${name}: Text nicht lesbar (${err.message}) - bitte von Hand eingeben.`);
      }
      if (o.automatisch && !e.sicher) { offen++; console.log(`OFFEN: ${name} (nicht eindeutig erkannt - "belege" von Hand ausfuehren)`); continue; }
      let daten;
      if (e.sicher && o.automatisch) {
        daten = { datum: e.datum, anbieter: e.anbieter, rechnungsnummer: e.rechnungsnummer, beschreibung: e.beschreibung, kategorie: e.kategorie, betragEur: e.betrag, waehrung: 'EUR', quelle: 'automatisch' };
      } else {
        console.log(`\n=== ${name} ===`);
        if (e.anbieter || e.betrag) console.log(`Erkannt: ${e.anbieter || '?'} · Nr. ${e.rechnungsnummer || '?'} · ${e.datum ? deutschesDatum(e.datum) : '?'} · ${e.betrag ? kommaBetrag(e.betrag) + ' ' + (e.waehrung || '') : '?'}`);
        if ((await frage(rl, 'Diesen Beleg jetzt erfassen? (j/n)', 'j')).toLowerCase().startsWith('n')) { offen++; continue; }
        const anbieter = await frage(rl, 'Anbieter', e.anbieter || '');
        const datum = await frage(rl, 'Rechnungsdatum (JJJJ-MM-TT)', e.datum || '');
        const bezahltAm = await frage(rl, 'Bezahlt am (JJJJ-MM-TT, Enter = Rechnungsdatum)', datum);
        const rechnungsnummer = await frage(rl, 'Rechnungsnummer', e.rechnungsnummer || '');
        const waehrung = (await frage(rl, 'Währung der Rechnung (EUR/USD/...)', e.waehrung || 'EUR')).toUpperCase();
        let betragOriginal = '';
        let betragEur;
        if (waehrung === 'EUR') betragEur = await frage(rl, 'Betrag brutto in EUR', e.betrag ? kommaBetrag(e.betrag) : '');
        else {
          betragOriginal = await frage(rl, `Betrag in ${waehrung}`, e.betrag ? kommaBetrag(e.betrag) : '');
          betragEur = await frage(rl, 'Tatsächlich bezahlt in EUR (laut Kontoauszug)', '');
        }
        console.log('Kategorien: ' + KATEGORIE_SCHLUESSEL.map((k, i) => `${i + 1}=${KATEGORIEN[k].name}`).join(' · '));
        const kw = await frage(rl, 'Kategorie (Nummer oder Name)', e.kategorie ? String(KATEGORIE_SCHLUESSEL.indexOf(e.kategorie) + 1) : '');
        const kategorie = /^\d+$/.test(kw) ? KATEGORIE_SCHLUESSEL[Number(kw) - 1] : kw;
        const beschreibung = await frage(rl, 'Beschreibung (optional)', e.beschreibung || '');
        daten = { datum, bezahltAm, anbieter, rechnungsnummer, beschreibung, kategorie, betragEur, waehrung, betragOriginal, quelle: 'beleg' };
      }
      try {
        const abgelegt = belegZiel(p, daten);
        const eintrag = buch.buchen({ ...daten, beleg: { datei: abgelegt, sha256 } });
        fs.mkdirSync(path.dirname(path.join(p.basis, abgelegt)), { recursive: true });
        fs.renameSync(quelle, path.join(p.basis, abgelegt));
        gebucht++;
        console.log(`GEBUCHT: Nr. ${eintrag.seq} · ${eintrag.anbieter} · ${euro(eintrag.betragEur)} · ${KATEGORIEN[eintrag.kategorie].name} -> ${abgelegt}`);
      } catch (err) {
        offen++;
        console.log(`NICHT GEBUCHT: ${name}: ${err.message}`);
      }
    }
  } finally {
    rl?.close();
  }
  console.log(`\n${gebucht} gebucht, ${offen} offen.`);
}

const kommaBetrag = (t) => String(t).replace('.', ',');

function ausgabeManuell(p, o) {
  const buch = new Ausgabenbuch(p.ausgaben);
  const e = buch.buchen({
    datum: o.datum, bezahltAm: o['bezahlt-am'], anbieter: o.anbieter, rechnungsnummer: o.rechnungsnummer || '',
    beschreibung: o.beschreibung || '', kategorie: o.kategorie, betragEur: o.betrag, waehrung: o.waehrung || 'EUR', betragOriginal: o['betrag-original'] || '',
  });
  console.log(`GEBUCHT: Nr. ${e.seq} · ${e.anbieter} · ${euro(e.betragEur)} · ${KATEGORIEN[e.kategorie].name} (bezahlt ${deutschesDatum(e.bezahltAm)})`);
}

/** Erstellt einen Bericht. art = 'quartal' | 'jahr'. Liefert den Zielordner. */
function berichtErstellen(p, einst, zeitraum, art) {
  const s = neuesteSicherung(einst.sicherungsOrdner);
  const pem = fs.readFileSync(einst.privaterSchluessel, 'utf8');
  const daten = sicherungLesen(s.pfad, pem);
  const buch = new Ausgabenbuch(p.ausgaben);
  const ausgabenKette = buch.pruefen();
  const b = berechnen({ journale: daten.journale, ausgaben: buch.gueltige(), zeitraum, erinnerung: einst.erinnerung });
  const warnungen = [];
  for (const [n, k] of Object.entries(daten.ketten)) if (!k.ok) warnungen.push(`Shop-Journal ${n} ist beschädigt: ${k.fehler}`);
  if (!ausgabenKette.ok) warnungen.push(`Ausgabenbuch ist beschädigt: ${ausgabenKette.fehler}`);
  if (s.tag < zeitraum.bis) warnungen.push(`Die neueste Shop-Sicherung ist vom ${deutschesDatum(s.tag)} - Buchungen danach fehlen in diesem Bericht.`);
  const ziel = path.join(p.berichte, art === 'jahr' ? `${zeitraum.jahr}-EUER-Entwurf` : zeitraum.name);
  fs.mkdirSync(ziel, { recursive: true });
  const meta = { art, erstellt: new Date().toISOString(), sicherungTag: s.tag, ketten: daten.ketten, ausgabenKette, warnungen, wartendeBelege: wartendeBelege(p), serverBefehl: einst.serverBefehl };
  fs.writeFileSync(path.join(ziel, 'bericht.html'), htmlSeite(b, meta), 'utf8');
  for (const [name, inhalt] of Object.entries(csvDateien(daten.journale, b))) fs.writeFileSync(path.join(ziel, name), inhalt, 'utf8');
  return { ziel, b, warnungen };
}

function bericht(p, o) {
  const einst = einstellungenLaden(p);
  if (o.automatisch) {
    // Belege bekannter Anbieter (z. B. Hetzner) ohne Rueckfrage buchen, dann den Bericht des
    // letzten abgeschlossenen Quartals erstellen, falls er noch fehlt.
    const zr = letztesAbgeschlossenesQuartal();
    const ziel = path.join(p.berichte, zr.name, 'bericht.html');
    if (fs.existsSync(ziel)) { console.log(`Bericht ${zr.name} existiert bereits.`); return; }
    const { ziel: ordner, b } = berichtErstellen(p, einst, zr, 'quartal');
    console.log(`NEU: Quartalsbericht ${zr.name} -> ${path.join(ordner, 'bericht.html')}`);
    if (zr.quartal === 4) {
      const j = berichtErstellen(p, einst, jahrZeitraum(zr.jahr), 'jahr');
      console.log(`NEU: EÜR-Entwurf ${zr.jahr} -> ${path.join(j.ziel, 'bericht.html')}`);
    }
    for (const e of b.erinnerungen) console.log(`ERINNERUNG: ${e.waehrung} im Bestand, Eingangswert ${euro(e.buchwertEur)}`);
    return;
  }
  const zr = o.quartal ? quartal(o.quartal) : laufendesQuartal();
  const { ziel, warnungen } = berichtErstellen(p, einst, zr, 'quartal');
  console.log(`Bericht ${zr.name}: ${path.join(ziel, 'bericht.html')}`);
  for (const w of warnungen) console.log(`HINWEIS: ${w}`);
}

function euer(p, o) {
  const einst = einstellungenLaden(p);
  const zr = jahrZeitraum(o.jahr || new Date().getUTCFullYear());
  const { ziel, warnungen } = berichtErstellen(p, einst, zr, 'jahr');
  console.log(`EÜR-Entwurf ${zr.jahr}: ${path.join(ziel, 'bericht.html')}`);
  for (const w of warnungen) console.log(`HINWEIS: ${w}`);
}

function status(p) {
  const einst = einstellungenLaden(p);
  const buch = new Ausgabenbuch(p.ausgaben);
  const k = buch.pruefen();
  console.log(`Datenordner:   ${p.basis}`);
  console.log(`Ausgabenbuch:  ${k.ok ? `${k.anzahl} Einträge, Kette intakt` : 'BESCHÄDIGT - ' + k.fehler}`);
  console.log(`Belege offen:  ${wartendeBelege(p).length} in ${p.eingang}`);
  try {
    const s = neuesteSicherung(einst.sicherungsOrdner);
    const alter = Math.floor((Date.now() - Date.parse(s.tag + 'T00:00:00Z')) / 86_400_000);
    const d = sicherungLesen(s.pfad, fs.readFileSync(einst.privaterSchluessel, 'utf8'));
    console.log(`Shop-Sicherung: vom ${deutschesDatum(s.tag)} (${alter} Tag(e) alt), Ketten ${Object.values(d.ketten).every((x) => x.ok) ? 'intakt' : 'BESCHÄDIGT'}`);
    const b = berechnen({ journale: d.journale, ausgaben: buch.gueltige(), zeitraum: laufendesQuartal(), erinnerung: einst.erinnerung });
    console.log(`Laufendes Quartal ${b.zeitraum.name}: ${b.q.u.anzahlLizenzen} Lizenz(en), Einnahmen ${euro(b.q.einnahmen)}, Ausgaben ${euro(b.q.ausgabenSumme)}, Ergebnis ${euro(b.q.ergebnis)}`);
    for (const [w, x] of Object.entries(b.bestand)) console.log(`Bestand ${w}:   ${x.menge} (Eingangswert ${euro(x.buchwertEur)})`);
  } catch (e) {
    console.log(`Shop-Sicherung: ${e.message}`);
  }
}

function storno(p, o) {
  const e = new Ausgabenbuch(p.ausgaben).storno(o.seq, o.notiz);
  console.log(`STORNIERT: Ausgabe Nr. ${e.stornoVon} (${e.notiz})`);
}

async function main() {
  const [befehl, ...rest] = process.argv.slice(2);
  const o = optionen(rest);
  const p = pfade(o);
  switch (befehl) {
    case 'einrichten': return einrichten(p);
    case 'belege': einstellungenLaden(p); return belege(p, o);
    case 'ausgabe': einstellungenLaden(p); eurNormalisieren(o.betrag); return ausgabeManuell(p, o);
    case 'storno': return storno(p, o);
    case 'bericht':
      if (o.automatisch) await belege(p, { automatisch: true });
      return bericht(p, o);
    case 'euer': return euer(p, o);
    case 'status': return status(p);
    case 'kategorien':
      for (const k of KATEGORIE_SCHLUESSEL) console.log(`${k.padEnd(12)} ${KATEGORIEN[k].name}  ->  ${KATEGORIEN[k].euer || 'Klärung (Abschreibung)'}`);
      return;
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((z) => z.replace(/^\/\/ ?/, '')).join('\n'));
      process.exitCode = befehl ? 2 : 0;
  }
}

main().catch((e) => {
  console.error(`FEHLER: ${e.message}`);
  process.exitCode = 1;
});
