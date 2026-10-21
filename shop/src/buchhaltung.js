// Buchhaltung fuer die Steuer: append-only Journale (JSONL) mit Hash-Kette.
//
// Journale (je eine Datei, je eine eigene Kette):
//   einnahmen    - jeder Verkauf einer Lizenz (fortlaufende Rechnungsnummer)
//   verkaeufe    - spaetere Verkaeufe von Coins gegen EUR (manuell oder automatisch)
//   gebuehren    - Gebuehren (Netzwerk, Boerse, Zahlungsdienst)
//   auszahlungen - Auszahlungen eines externen Zahlungsdienstes an den Shop-Betreiber
//   sonstige     - sonstige Eingaenge (z. B. unvollstaendig bezahlte, verfallene Bestellungen)
//
// Jeder Eintrag enthaelt `vorherigerHash` und `hash` = SHA-256 ueber den Eintrag
// (JSON mit sortierten Schluesseln, ohne das Feld `hash`). Aenderungen oder
// Loeschungen mitten in der Datei fallen beim Pruefen auf. Gegen das Abschneiden
// am Ende helfen die taeglichen verschluesselten Sicherungen und der im Log
// protokollierte Kettenkopf (externe Anker). Korrekturen erfolgen nur durch
// neue Eintraege (Gegenbuchung mit negativem Betrag und Notiz).
//
// Betraege werden als Dezimaltexte gespeichert (keine Gleitkommazahlen).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dezimalZuAtomar, atomarZuDezimal } from './dezimal.js';

export const JOURNALE = ['einnahmen', 'verkaeufe', 'gebuehren', 'auszahlungen', 'sonstige'];
export const STELLEN = { EUR: 2, XMR: 12, BTC: 8 };

export class BuchhaltungsFehler extends Error {}

/** JSON mit rekursiv sortierten Schluesseln (fuer den Hash). */
export function sortiertesJson(w) {
  if (Array.isArray(w)) return '[' + w.map(sortiertesJson).join(',') + ']';
  if (w && typeof w === 'object') {
    return '{' + Object.keys(w).sort().map((k) => JSON.stringify(k) + ':' + sortiertesJson(w[k])).join(',') + '}';
  }
  return JSON.stringify(w === undefined ? null : w);
}

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
export const genesis = (name) => sha256('MALACHI-BUCHHALTUNG|' + name);

export function eintragsHash(eintrag) {
  const { hash, ...rest } = eintrag;
  void hash;
  return sha256(sortiertesJson(rest));
}

/** Prueft eine Liste von Eintraegen auf eine lueckenlose Kette. */
export function ketteVerifizieren(name, eintraege) {
  let vorher = genesis(name);
  for (let i = 0; i < eintraege.length; i++) {
    const e = eintraege[i];
    if (e.seq !== i + 1) return { ok: false, fehler: `Eintrag ${i + 1}: Laufnummer ${e.seq} (erwartet ${i + 1})` };
    if (e.vorherigerHash !== vorher) return { ok: false, fehler: `Eintrag ${i + 1}: Verkettung gebrochen` };
    if (eintragsHash(e) !== e.hash) return { ok: false, fehler: `Eintrag ${i + 1}: Inhalt veraendert (Hash passt nicht)` };
    vorher = e.hash;
  }
  return { ok: true, kopf: vorher, anzahl: eintraege.length };
}

async function sperren(datei, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      const fh = await fsp.open(datei, 'wx', 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return async () => fsp.unlink(datei).catch(() => {});
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fsp.stat(datei);
        if (Date.now() - st.mtimeMs > 30_000) await fsp.unlink(datei).catch(() => {}); // verwaiste Sperre
      } catch {
        /* inzwischen weg */
      }
      if (Date.now() - start > timeoutMs) throw new BuchhaltungsFehler('Buchhaltung ist gesperrt (anderer Prozess?)');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export class Buchhaltung {
  /**
   * @param {object} o
   * @param {string} o.verzeichnis
   * @param {string} [o.rechnungsPraefix]
   * @param {() => number} [o.jetzt]
   */
  constructor({ verzeichnis, rechnungsPraefix = 'MAL', jetzt = Date.now }) {
    this.verzeichnis = verzeichnis;
    this.praefix = rechnungsPraefix;
    this.jetzt = jetzt;
    this.sperrDatei = path.join(verzeichnis, '.sperre');
    this._kette = Promise.resolve();
  }

  datei(name) {
    if (!JOURNALE.includes(name)) throw new Error('Unbekanntes Journal');
    return path.join(this.verzeichnis, name + '.jsonl');
  }

  /** Liest ein Journal (ohne Sperre). */
  lesen(name) {
    let text;
    try {
      text = fs.readFileSync(this.datei(name), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const zeilen = text.split('\n').filter((z) => z.trim() !== '');
    return zeilen.map((z, i) => {
      try {
        return JSON.parse(z);
      } catch {
        throw new BuchhaltungsFehler(`${name}.jsonl Zeile ${i + 1} ist kein gueltiges JSON`);
      }
    });
  }

  /** Prueft alle Journale. */
  pruefen() {
    const ergebnis = {};
    for (const n of JOURNALE) {
      try {
        ergebnis[n] = ketteVerifizieren(n, this.lesen(n));
      } catch (e) {
        ergebnis[n] = { ok: false, fehler: e.message };
      }
    }
    return ergebnis;
  }

  /** Beim Start: alle Ketten muessen intakt sein, sonst wird nichts mehr gebucht. */
  async initialisieren() {
    await fsp.mkdir(this.verzeichnis, { recursive: true, mode: 0o700 });
    const p = this.pruefen();
    const kaputt = Object.entries(p).filter(([, r]) => !r.ok);
    if (kaputt.length) {
      throw new BuchhaltungsFehler('Buchhaltung beschaedigt oder veraendert: ' + kaputt.map(([n, r]) => `${n}: ${r.fehler}`).join('; '));
    }
    return p;
  }

  /**
   * Haengt einen Eintrag an (prozessuebergreifend gesperrt, Kette wird vorher neu gelesen).
   * `vorbereiten(eintraege)` darf den Eintrag aus dem aktuellen Stand berechnen und
   * `null` zurueckgeben, wenn nichts zu buchen ist (Idempotenz).
   */
  anhaengen(name, vorbereiten) {
    const lauf = this._kette.then(() => this._anhaengen(name, vorbereiten));
    this._kette = lauf.catch(() => {});
    return lauf;
  }

  async _anhaengen(name, vorbereiten) {
    await fsp.mkdir(this.verzeichnis, { recursive: true, mode: 0o700 });
    const frei = await sperren(this.sperrDatei);
    try {
      const eintraege = this.lesen(name);
      const pruefung = ketteVerifizieren(name, eintraege);
      if (!pruefung.ok) throw new BuchhaltungsFehler(`${name}: ${pruefung.fehler}`);
      const daten = typeof vorbereiten === 'function' ? vorbereiten(eintraege) : vorbereiten;
      if (daten && daten.vorhanden) return daten.vorhanden;
      if (!daten) return null;
      const eintrag = {
        ...daten,
        seq: eintraege.length + 1,
        gebucht: new Date(this.jetzt()).toISOString(),
        vorherigerHash: pruefung.kopf,
      };
      eintrag.hash = eintragsHash(eintrag);
      const fh = await fsp.open(this.datei(name), 'a', 0o600);
      try {
        await fh.writeFile(JSON.stringify(eintrag) + '\n', 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      return eintrag;
    } finally {
      await frei();
    }
  }

  /**
   * Bucht eine Einnahme (Lizenzverkauf). Idempotent je Bestellung: existiert bereits
   * ein Eintrag fuer die Bestellung, wird dieser zurueckgegeben.
   */
  einnahmeBuchen(d) {
    return this.anhaengen('einnahmen', (eintraege) => {
      const vorhanden = eintraege.find((e) => e.typ === 'einnahme' && e.bestellung === d.bestellung);
      if (vorhanden) return { vorhanden };
      const zeit = new Date(this.jetzt());
      const jahr = zeit.getUTCFullYear();
      const imJahr = eintraege.filter((e) => e.typ === 'einnahme' && e.rechnungsnummer.startsWith(`${this.praefix}-${jahr}-`)).length;
      return {
        typ: 'einnahme',
        zeit: zeit.toISOString(),
        rechnungsnummer: `${this.praefix}-${jahr}-${String(imJahr + 1).padStart(6, '0')}`,
        ...d,
      };
    });
  }

  /** Verkauf von Coins gegen EUR. */
  async verkaufBuchen({ datum, waehrung, mengeCoin, erloesEur, gebuehrEur = '0', dienst, referenz = '', notiz = '', quelle = 'manuell' }) {
    pruefeWaehrung(waehrung);
    dezimalZuAtomar(mengeCoin, STELLEN[waehrung]);
    dezimalZuAtomar(erloesEur, 2);
    dezimalZuAtomar(gebuehrEur, 2);
    pruefeDatum(datum);
    return this.anhaengen('verkaeufe', (eintraege) => {
      if (referenz && eintraege.some((e) => e.dienst === dienst && e.referenz === referenz)) return null;
      return { typ: 'verkauf', datum, waehrung, mengeCoin: norm(mengeCoin, waehrung), erloesEur: norm(erloesEur, 'EUR'), gebuehrEur: norm(gebuehrEur, 'EUR'), dienst: text(dienst), referenz: text(referenz), notiz: text(notiz), quelle };
    });
  }

  /** Gebuehr (in EUR oder in Coins; bei Coins bitte den EUR-Wert angeben). */
  async gebuehrBuchen({ datum, waehrung, betrag, betragEur, dienst, referenz = '', notiz = '', quelle = 'manuell' }) {
    if (waehrung !== 'EUR') pruefeWaehrung(waehrung);
    dezimalZuAtomar(betrag, STELLEN[waehrung]);
    dezimalZuAtomar(betragEur, 2);
    pruefeDatum(datum);
    return this.anhaengen('gebuehren', (eintraege) => {
      if (referenz && eintraege.some((e) => e.dienst === dienst && e.referenz === referenz)) return null;
      return { typ: 'gebuehr', datum, waehrung, betrag: norm(betrag, waehrung), betragEur: norm(betragEur, 'EUR'), dienst: text(dienst), referenz: text(referenz), notiz: text(notiz), quelle };
    });
  }

  /** Auszahlung eines externen Zahlungsdienstes an den Betreiber. */
  async auszahlungBuchen({ datum, waehrung, betrag, betragEur, dienst, referenz = '', notiz = '', quelle = 'manuell' }) {
    if (waehrung !== 'EUR') pruefeWaehrung(waehrung);
    dezimalZuAtomar(betrag, STELLEN[waehrung]);
    dezimalZuAtomar(betragEur, 2);
    pruefeDatum(datum);
    return this.anhaengen('auszahlungen', (eintraege) => {
      if (referenz && eintraege.some((e) => e.dienst === dienst && e.referenz === referenz)) return null;
      return { typ: 'auszahlung', datum, waehrung, betrag: norm(betrag, waehrung), betragEur: norm(betragEur, 'EUR'), dienst: text(dienst), referenz: text(referenz), notiz: text(notiz), quelle };
    });
  }

  /** Sonstiger Eingang (z. B. unvollstaendig bezahlte, verfallene Bestellung). */
  async sonstigesBuchen({ art, bestellung, waehrung, betragCoin, wertEur = null, txids = [], notiz = '' }) {
    pruefeWaehrung(waehrung);
    return this.anhaengen('sonstige', (eintraege) => {
      if (bestellung && eintraege.some((e) => e.bestellung === bestellung && e.art === art)) return null;
      return { typ: 'sonstiges', art, zeit: new Date(this.jetzt()).toISOString(), bestellung, waehrung, betragCoin: norm(betragCoin, waehrung), wertEur: wertEur === null ? null : norm(wertEur, 'EUR'), txids, notiz: text(notiz) };
    });
  }

  /** Storno (Korrektur) eines Eintrags: neuer Eintrag, der den alten fuer Auswertungen aufhebt. */
  async stornoBuchen(name, seq, notiz) {
    if (!String(notiz || '').trim()) throw new BuchhaltungsFehler('Ein Storno braucht eine Begruendung (Notiz).');
    return this.anhaengen(name, (eintraege) => {
      const ziel = eintraege.find((e) => e.seq === seq);
      if (!ziel || ziel.typ === 'storno') throw new BuchhaltungsFehler(`Eintrag ${seq} in ${name} nicht gefunden oder selbst ein Storno`);
      if (eintraege.some((e) => e.typ === 'storno' && e.stornoVon === seq)) throw new BuchhaltungsFehler(`Eintrag ${seq} ist bereits storniert`);
      return { typ: 'storno', stornoVon: seq, datum: new Date(this.jetzt()).toISOString().slice(0, 10), notiz: text(notiz) };
    });
  }

  /** Letzte Hashes aller Journale (zum Protokollieren als externer Anker). */
  koepfe() {
    const k = {};
    for (const n of JOURNALE) {
      const e = this.lesen(n);
      k[n] = { anzahl: e.length, kopf: e.length ? e[e.length - 1].hash : genesis(n) };
    }
    return k;
  }
}

function pruefeWaehrung(w) {
  if (!Object.hasOwn(STELLEN, w) || w === 'EUR') throw new BuchhaltungsFehler(`Unbekannte Waehrung: ${w}`);
}
function pruefeDatum(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/.test(d) || Number.isNaN(Date.parse(d))) {
    throw new BuchhaltungsFehler(`Ungueltiges Datum (JJJJ-MM-TT erwartet): ${d}`);
  }
}
const text = (t) => String(t ?? '').slice(0, 500);
const norm = (betrag, waehrung) => atomarZuDezimal(dezimalZuAtomar(betrag, STELLEN[waehrung]), STELLEN[waehrung]);
