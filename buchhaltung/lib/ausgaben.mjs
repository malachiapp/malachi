// Ausgabenbuch: append-only JSONL mit derselben Hash-Kette wie die Shop-Journale
// (shop/src/buchhaltung.js, Kettenname "ausgaben"). Korrekturen nur per Storno.
import fs from 'node:fs';
import path from 'node:path';
import { eintragsHash, ketteVerifizieren } from '../../shop/src/buchhaltung.js';
import { ohneStornos } from '../../shop/src/auswertung.js';
import { dezimalZuAtomar, atomarZuDezimal } from '../../shop/src/dezimal.js';
import { kategorie } from './kategorien.mjs';

export const KETTE = 'ausgaben';
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

/** '12,50' / '12.5' / '1.234,56' -> '12.50' (2 Nachkommastellen, positiv). */
export function eurNormalisieren(wert) {
  let t = String(wert ?? '').trim().replace(/\s|€|EUR/gi, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`Betrag "${wert}" ungueltig (z. B. 12,50)`);
  return atomarZuDezimal(dezimalZuAtomar(t, 2), 2);
}

function datumPruefen(d, feld) {
  if (!DATUM.test(String(d)) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) throw new Error(`${feld} "${d}" ungueltig (Format JJJJ-MM-TT)`);
  return d;
}

const text = (t, max = 200) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export class Ausgabenbuch {
  constructor(datei, { jetzt = Date.now } = {}) {
    this.datei = datei;
    this.jetzt = jetzt;
  }

  lesen() {
    let inhalt;
    try {
      inhalt = fs.readFileSync(this.datei, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return inhalt.split('\n').filter((z) => z.trim()).map((z, i) => {
      try {
        return JSON.parse(z);
      } catch {
        throw new Error(`${path.basename(this.datei)} Zeile ${i + 1} ist kein gueltiges JSON`);
      }
    });
  }

  pruefen() {
    return ketteVerifizieren(KETTE, this.lesen());
  }

  /** Gueltige Ausgaben (ohne stornierte und ohne Storno-Eintraege). */
  gueltige() {
    return ohneStornos(this.lesen());
  }

  _anhaengen(daten) {
    const eintraege = this.lesen();
    const p = ketteVerifizieren(KETTE, eintraege);
    if (!p.ok) throw new Error(`Ausgabenbuch beschaedigt: ${p.fehler} - nichts gebucht.`);
    const eintrag = { ...daten, seq: eintraege.length + 1, gebucht: new Date(this.jetzt()).toISOString(), vorherigerHash: p.kopf };
    eintrag.hash = eintragsHash(eintrag);
    fs.mkdirSync(path.dirname(this.datei), { recursive: true });
    const fd = fs.openSync(this.datei, 'a', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(eintrag) + '\n', null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return eintrag;
  }

  /**
   * Bucht eine Ausgabe. Massgeblich fuer die EUeR ist der Zahlungstag (bezahltAm,
   * Abflussprinzip); ohne Angabe wird das Rechnungsdatum angenommen.
   */
  buchen({ datum, bezahltAm, anbieter, rechnungsnummer = '', beschreibung = '', kategorie: kat, betragEur, waehrung = 'EUR', betragOriginal = '', beleg = null, quelle = 'manuell' }) {
    datumPruefen(datum, 'Rechnungsdatum');
    datumPruefen(bezahltAm || datum, 'Zahlungsdatum');
    kategorie(kat);
    if (!text(anbieter)) throw new Error('Anbieter fehlt');
    const eur = eurNormalisieren(betragEur);
    if (eur === '0.00') throw new Error('Betrag ist 0');
    const nr = text(rechnungsnummer, 80);
    if (nr && this.gueltige().some((e) => e.anbieter === text(anbieter) && e.rechnungsnummer === nr)) {
      throw new Error(`Rechnung ${nr} von ${text(anbieter)} ist bereits gebucht`);
    }
    if (beleg?.sha256 && this.gueltige().some((e) => e.beleg?.sha256 === beleg.sha256)) {
      throw new Error('Dieser Beleg (gleicher Dateiinhalt) ist bereits gebucht');
    }
    return this._anhaengen({
      typ: 'ausgabe',
      datum,
      bezahltAm: bezahltAm || datum,
      anbieter: text(anbieter),
      rechnungsnummer: nr,
      beschreibung: text(beschreibung),
      kategorie: kat,
      betragEur: eur,
      waehrung: text(waehrung, 3).toUpperCase() || 'EUR',
      betragOriginal: text(betragOriginal, 30),
      beleg: beleg ? { datei: text(beleg.datei, 300), sha256: text(beleg.sha256, 64) } : null,
      quelle,
    });
  }

  storno(seq, notiz) {
    const eintraege = this.lesen();
    const ziel = eintraege.find((e) => e.seq === Number(seq));
    if (!ziel || ziel.typ === 'storno') throw new Error(`Eintrag ${seq} nicht gefunden oder selbst ein Storno`);
    if (eintraege.some((e) => e.typ === 'storno' && e.stornoVon === ziel.seq)) throw new Error(`Eintrag ${seq} ist bereits storniert`);
    if (!text(notiz)) throw new Error('Bitte einen Grund angeben (--notiz)');
    return this._anhaengen({ typ: 'storno', stornoVon: ziel.seq, datum: new Date(this.jetzt()).toISOString().slice(0, 10), notiz: text(notiz) });
  }
}
