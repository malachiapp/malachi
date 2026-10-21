// Auswertungen der Buchhaltung: CSV-Exporte und vereinfachte Jahresuebersicht
// (Gewinn, Bestand, FIFO-Buchwerte). Ersetzt keine Buchfuehrung - Grundlage fuer
// die Steuerberatung.

import { JOURNALE, STELLEN } from './buchhaltung.js';
import { dezimalZuAtomar, atomarZuDezimal } from './dezimal.js';

const BOM = '﻿';

/** Ein CSV-Feld (Semikolon-getrennt, fuer deutsches Excel). */
function feld(w) {
  const s = w === null || w === undefined ? '' : Array.isArray(w) ? w.join(' ') : String(w);
  // Formel-Injektion in Tabellenprogrammen verhindern
  const sicher = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? "'" + s : s;
  return /[;"\n\r]/.test(sicher) ? '"' + sicher.replace(/"/g, '""') + '"' : sicher;
}

export function csv(kopf, zeilen) {
  return BOM + [kopf, ...zeilen].map((z) => z.map(feld).join(';')).join('\r\n') + '\r\n';
}

const komma = (t) => (t === null || t === undefined || t === '' ? '' : String(t).replace('.', ','));

/** Entfernt stornierte Eintraege und die Storno-Eintraege selbst. */
export function ohneStornos(eintraege) {
  const storniert = new Set(eintraege.filter((e) => e.typ === 'storno').map((e) => e.stornoVon));
  return eintraege.filter((e) => e.typ !== 'storno' && !storniert.has(e.seq));
}

const jahrVon = (e) => Number(String(e.zeit || e.datum).slice(0, 4));

// ---------------------------------------------------------------- CSV-Exporte

export function einnahmenCsv(eintraege, jahr) {
  const zeilen = ohneStornos(eintraege)
    .filter((e) => !jahr || jahrVon(e) === jahr)
    .map((e) => [
      e.rechnungsnummer,
      e.zeit,
      e.bestellung,
      e.lizenz,
      e.anbieter,
      komma(e.betragEur),
      e.waehrung,
      komma(e.betragCoin),
      komma(e.empfangenCoin),
      komma(e.ueberzahlungCoin),
      komma(e.kurs?.eurProCoin),
      e.kurs?.methode + ': ' + (e.kurs?.quellen || []).map((q) => (q.wert !== undefined ? `${q.name}=${q.wert}` : `${q.name} (Fehler)`)).join(', '),
      e.kurs?.abgerufen,
      komma(e.kursBeiZahlung?.eurProCoin),
      e.kursBeiZahlung?.abgerufen,
      e.txids,
      e.subadresseIndex,
      e.anbieterReferenz,
      e.umsatzsteuer?.kleinunternehmer ? 'Kleinunternehmer (§ 19 UStG)' : `${e.umsatzsteuer?.satz ?? ''} %`,
      e.hash,
    ]);
  return csv(
    ['Rechnungsnummer', 'Zeitpunkt (UTC)', 'Bestellnummer', 'Lizenz-ID', 'Zahlungsweg', 'Betrag EUR', 'Währung', 'Betrag Coin (berechnet)', 'Empfangen Coin', 'Überzahlung Coin', 'Kurs EUR je Coin', 'Kursquelle', 'Kursabruf (UTC)', 'Kurs bei Zahlungseingang', 'Kursabruf bei Zahlungseingang', 'Transaktionen', 'Subadress-Index', 'Referenz Zahlungsdienst', 'Umsatzsteuer', 'Hash'],
    zeilen,
  );
}

export function verkaeufeCsv(eintraege, jahr) {
  const zeilen = ohneStornos(eintraege)
    .filter((e) => !jahr || jahrVon(e) === jahr)
    .map((e) => {
      const netto = atomarZuDezimal(dezimalZuAtomar(e.erloesEur, 2) - dezimalZuAtomar(e.gebuehrEur, 2), 2);
      return [e.seq, e.datum, e.waehrung, komma(e.mengeCoin), komma(e.erloesEur), komma(e.gebuehrEur), komma(netto), e.dienst, e.referenz, e.notiz, e.quelle, e.gebucht, e.hash];
    });
  return csv(['Lfd. Nr.', 'Datum', 'Währung', 'Menge', 'Erlös EUR', 'Gebühr EUR', 'Netto EUR', 'Dienst', 'Referenz', 'Notiz', 'Quelle', 'Gebucht (UTC)', 'Hash'], zeilen);
}

export function gebuehrenCsv(eintraege, jahr, titel = 'Gebühr') {
  const zeilen = ohneStornos(eintraege)
    .filter((e) => !jahr || jahrVon(e) === jahr)
    .map((e) => [e.seq, e.datum, e.waehrung, komma(e.betrag), komma(e.betragEur), e.dienst, e.referenz, e.notiz, e.quelle, e.gebucht, e.hash]);
  return csv(['Lfd. Nr.', 'Datum', 'Währung', titel, `${titel} EUR`, 'Dienst', 'Referenz', 'Notiz', 'Quelle', 'Gebucht (UTC)', 'Hash'], zeilen);
}

export function sonstigeCsv(eintraege, jahr) {
  const zeilen = ohneStornos(eintraege)
    .filter((e) => !jahr || jahrVon(e) === jahr)
    .map((e) => [e.seq, e.zeit, e.art, e.bestellung, e.waehrung, komma(e.betragCoin), komma(e.wertEur), e.txids, e.notiz, e.hash]);
  return csv(['Lfd. Nr.', 'Zeitpunkt (UTC)', 'Art', 'Bestellnummer', 'Währung', 'Betrag Coin', 'Wert EUR', 'Transaktionen', 'Notiz', 'Hash'], zeilen);
}

// ---------------------------------------------------------------- Jahresuebersicht

/** Anteiliger Wert (Cent) fuer `teil` von `ganz` bei Gesamtwert `wert` - exakt gerundet. */
function anteil(wert, teil, ganz) {
  if (ganz === 0n) return 0n;
  return (wert * teil + ganz / 2n) / ganz;
}

/**
 * Vereinfachte Uebersicht fuer einen Zeitraum [von, bis) - z. B. ein Quartal.
 * Bestand: Zugaenge ins eigene Wallet (Einnahmen ueber eigenes Wallet, sonstige Eingaenge)
 * minus Verkaeufe minus in Coins bezahlte Gebuehren. Buchwert nach FIFO; Zugangswert einer
 * Einnahme = Rechnungsbetrag in EUR.
 * Ereignisse vor `von` zaehlen nur fuer den Bestand (FIFO-Buchwerte), nicht fuer die Summen.
 * @param {Record<string, object[]>} journale  Eintraege je Journal
 * @param {{von: string, bis: string}} zeitraum  ISO-Daten JJJJ-MM-TT, `bis` ausschliesslich
 * @param {Record<string, string>} [marktkurse]  optional: EUR je Coin zum Ende des Zeitraums
 */
export function zeitraumuebersicht(journale, { von, bis }, marktkurse = {}) {
  const ereignisse = [];
  const sortSchluessel = (zeit, j, seq) => `${zeit}|${j}|${String(seq).padStart(9, '0')}`;
  const sauber = Object.fromEntries(JOURNALE.map((n) => [n, ohneStornos(journale[n] || [])]));
  for (const e of sauber.einnahmen) ereignisse.push({ k: sortSchluessel(e.zeit, 0, e.seq), art: 'einnahme', e });
  for (const e of sauber.sonstige) ereignisse.push({ k: sortSchluessel(e.zeit, 1, e.seq), art: 'sonstiges', e });
  for (const e of sauber.verkaeufe) ereignisse.push({ k: sortSchluessel(e.datum, 2, e.seq), art: 'verkauf', e });
  for (const e of sauber.gebuehren) ereignisse.push({ k: sortSchluessel(e.datum, 3, e.seq), art: 'gebuehr', e });
  for (const e of sauber.auszahlungen) ereignisse.push({ k: sortSchluessel(e.datum, 4, e.seq), art: 'auszahlung', e });
  ereignisse.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

  const lose = {}; // waehrung -> [{menge, wert}]
  const s = {
    anzahlLizenzen: 0,
    einnahmenEur: 0n,
    einnahmenEigenesWalletEur: 0n,
    einnahmenZahlungsdienstEur: 0n,
    sonstigeEur: 0n,
    verkaufErloesEur: 0n,
    verkaufGebuehrEur: 0n,
    verkaufBuchwertEur: 0n,
    gebuehrenEur: 0n,
    gebuehrenCoinBuchwertEur: 0n,
    auszahlungenEur: 0n,
    zugang: {},
    abgang: {},
    fehlbestand: {},
  };
  const add = (obj, w, n) => (obj[w] = (obj[w] || 0n) + n);

  const verbrauchen = (w, menge) => {
    let rest = menge;
    let buchwert = 0n;
    const l = lose[w] || [];
    while (rest > 0n && l.length) {
      const los = l[0];
      if (los.menge <= rest) {
        buchwert += los.wert;
        rest -= los.menge;
        l.shift();
      } else {
        const w2 = anteil(los.wert, rest, los.menge);
        buchwert += w2;
        los.wert -= w2;
        los.menge -= rest;
        rest = 0n;
      }
    }
    return { buchwert, fehlt: rest };
  };

  for (const { art, e } of ereignisse) {
    const zeitpunkt = String(e.zeit || e.datum);
    if (zeitpunkt >= bis) break;
    const imJahr = zeitpunkt >= von;
    if (art === 'einnahme') {
      const cent = dezimalZuAtomar(e.betragEur, 2);
      const eigen = e.verwahrung !== 'zahlungsdienst';
      if (eigen) {
        const menge = dezimalZuAtomar(e.empfangenCoin, STELLEN[e.waehrung]);
        (lose[e.waehrung] ||= []).push({ menge, wert: cent });
        if (imJahr) add(s.zugang, e.waehrung, menge);
      }
      if (imJahr) {
        s.anzahlLizenzen++;
        s.einnahmenEur += cent;
        if (eigen) s.einnahmenEigenesWalletEur += cent;
        else s.einnahmenZahlungsdienstEur += cent;
      }
    } else if (art === 'sonstiges') {
      const menge = dezimalZuAtomar(e.betragCoin, STELLEN[e.waehrung]);
      const wert = e.wertEur ? dezimalZuAtomar(e.wertEur, 2) : 0n;
      (lose[e.waehrung] ||= []).push({ menge, wert });
      if (imJahr) {
        add(s.zugang, e.waehrung, menge);
        s.sonstigeEur += wert;
      }
    } else if (art === 'verkauf') {
      const menge = dezimalZuAtomar(e.mengeCoin, STELLEN[e.waehrung]);
      const { buchwert, fehlt } = verbrauchen(e.waehrung, menge);
      if (imJahr) {
        add(s.abgang, e.waehrung, menge);
        if (fehlt > 0n) add(s.fehlbestand, e.waehrung, fehlt);
        s.verkaufErloesEur += dezimalZuAtomar(e.erloesEur, 2);
        s.verkaufGebuehrEur += dezimalZuAtomar(e.gebuehrEur, 2);
        s.verkaufBuchwertEur += buchwert;
      }
    } else if (art === 'gebuehr') {
      const eur = dezimalZuAtomar(e.betragEur, 2);
      if (e.waehrung !== 'EUR') {
        const menge = dezimalZuAtomar(e.betrag, STELLEN[e.waehrung]);
        const { buchwert, fehlt } = verbrauchen(e.waehrung, menge);
        if (imJahr) {
          add(s.abgang, e.waehrung, menge);
          if (fehlt > 0n) add(s.fehlbestand, e.waehrung, fehlt);
          s.gebuehrenCoinBuchwertEur += buchwert;
        }
      }
      if (imJahr) s.gebuehrenEur += eur;
    } else if (art === 'auszahlung') {
      if (imJahr) s.auszahlungenEur += dezimalZuAtomar(e.betragEur, 2);
    }
  }

  // Gewinn (vereinfacht) = Einnahmen + sonstige Eingaenge + (Verkaufserloese - Buchwert)
  //   - Verkaufsgebuehren - in EUR bezahlte Gebuehren - Buchwert der als Gebuehr abgegebenen Coins.
  const veraeusserung = s.verkaufErloesEur - s.verkaufBuchwertEur;
  const gewinn =
    s.einnahmenEur + s.sonstigeEur + veraeusserung - s.verkaufGebuehrEur - eurGebuehrenOhneCoin(sauber.gebuehren, von, bis) - s.gebuehrenCoinBuchwertEur;

  const bestand = {};
  for (const [w, l] of Object.entries(lose)) {
    const menge = l.reduce((a, x) => a + x.menge, 0n);
    const buchwert = l.reduce((a, x) => a + x.wert, 0n);
    const markt = marktkurse[w] ? (menge * dezimalZuAtomar(marktkurse[w], 2) + 10n ** BigInt(STELLEN[w]) / 2n) / 10n ** BigInt(STELLEN[w]) : null;
    bestand[w] = { menge: atomarZuDezimal(menge, STELLEN[w]), buchwertEur: atomarZuDezimal(buchwert, 2), marktwertEur: markt === null ? null : atomarZuDezimal(markt, 2) };
  }
  const eur = (c) => atomarZuDezimal(c, 2);
  const coinListe = (o) => Object.fromEntries(Object.entries(o).map(([w, n]) => [w, atomarZuDezimal(n, STELLEN[w])]));
  return {
    von,
    bis,
    anzahlLizenzen: s.anzahlLizenzen,
    einnahmenEur: eur(s.einnahmenEur),
    einnahmenEigenesWalletEur: eur(s.einnahmenEigenesWalletEur),
    einnahmenZahlungsdienstEur: eur(s.einnahmenZahlungsdienstEur),
    sonstigeEingaengeEur: eur(s.sonstigeEur),
    zugangCoin: coinListe(s.zugang),
    verkauftCoin: coinListe(s.abgang),
    verkaufErloesEur: eur(s.verkaufErloesEur),
    verkaufGebuehrEur: eur(s.verkaufGebuehrEur),
    verkaufBuchwertEur: eur(s.verkaufBuchwertEur),
    veraeusserungsergebnisEur: eur(veraeusserung),
    gebuehrenEur: eur(s.gebuehrenEur),
    auszahlungenZahlungsdienstEur: eur(s.auszahlungenEur),
    gewinnVereinfachtEur: eur(gewinn),
    bestandEnde: bestand,
    fehlbestandCoin: coinListe(s.fehlbestand),
  };
}

/** Vereinfachte Jahresuebersicht (Zeitraum 1.1. bis 31.12.), Ausgabe wie bisher. */
export function jahresuebersicht(journale, jahr, marktkurse = {}) {
  const { von, bis, bestandEnde, fehlbestandCoin, ...summen } = zeitraumuebersicht(journale, { von: `${jahr}-01-01`, bis: `${jahr + 1}-01-01` }, marktkurse);
  void von;
  void bis;
  return { jahr, ...summen, bestandJahresende: bestandEnde, fehlbestandCoin };
}

/** Summe der in EUR bezahlten Gebuehren im Zeitraum [von, bis). */
function eurGebuehrenOhneCoin(gebuehren, von, bis) {
  let summe = 0n;
  for (const e of gebuehren) if (e.waehrung === 'EUR' && e.datum >= von && e.datum < bis) summe += dezimalZuAtomar(e.betragEur, 2);
  return summe;
}

export function jahresuebersichtCsv(u) {
  const z = [
    ['Jahr', u.jahr],
    ['Anzahl verkaufte Lizenzen', u.anzahlLizenzen],
    ['Einnahmen EUR (Rechnungsbeträge)', komma(u.einnahmenEur)],
    ['  davon über eigenes Wallet', komma(u.einnahmenEigenesWalletEur)],
    ['  davon über Zahlungsdienst', komma(u.einnahmenZahlungsdienstEur)],
    ['Sonstige Eingänge (Wert EUR)', komma(u.sonstigeEingaengeEur)],
    ...Object.entries(u.zugangCoin).map(([w, m]) => [`Zugang ${w}`, komma(m)]),
    ...Object.entries(u.verkauftCoin).map(([w, m]) => [`Abgang ${w} (Verkäufe und Coin-Gebühren)`, komma(m)]),
    ['Verkaufserlöse EUR', komma(u.verkaufErloesEur)],
    ['Verkaufsgebühren EUR', komma(u.verkaufGebuehrEur)],
    ['Buchwert verkaufte Coins EUR (FIFO)', komma(u.verkaufBuchwertEur)],
    ['Veräußerungsergebnis EUR', komma(u.veraeusserungsergebnisEur)],
    ['Gebühren EUR (Gebührenjournal)', komma(u.gebuehrenEur)],
    ['Auszahlungen Zahlungsdienst EUR', komma(u.auszahlungenZahlungsdienstEur)],
    ['Gewinn vereinfacht EUR', komma(u.gewinnVereinfachtEur)],
    ...Object.entries(u.bestandJahresende).flatMap(([w, b]) => [
      [`Bestand ${w} Jahresende`, komma(b.menge)],
      [`Buchwert Bestand ${w} EUR (FIFO)`, komma(b.buchwertEur)],
      ...(b.marktwertEur !== null ? [[`Marktwert Bestand ${w} EUR`, komma(b.marktwertEur)]] : []),
    ]),
    ...Object.entries(u.fehlbestandCoin).map(([w, m]) => [`ACHTUNG Fehlbestand ${w} (mehr verkauft als erfasst)`, komma(m)]),
  ];
  return csv(['Kennzahl', 'Wert'], z);
}
