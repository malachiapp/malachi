// Erkennt Anbieter, Rechnungsnummer, Datum und Betrag in Rechnungstexten.
// Bekannte Anbieter (z. B. Hetzner) werden ohne Rueckfrage gebucht, wenn alle
// Pflichtangaben eindeutig gefunden wurden; alles andere fragt das Werkzeug nach.

const BETRAG_DE = /(-?\d{1,3}(?:\.\d{3})+,\d{2}|-?\d+,\d{2})(?!\d)/g;
const BETRAG_EN = /(-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2})(?!\d)/g;
const SUMMEN_WORTE = /(gesamtbetrag|rechnungsbetrag|gesamtsumme|endbetrag|zu zahlen|zahlbetrag|summe brutto|bruttobetrag|total amount|amount due|grand total|\btotal\b|\bgesamt\b|\bsumme\b)/i;

/** '1.234,56' oder '1,234.56' -> '1234.56' */
export function betragAusText(t) {
  const s = String(t).trim();
  if (/,\d{2}$/.test(s)) return s.replace(/\./g, '').replace(',', '.');
  return s.replace(/,/g, '');
}

function waehrungIn(zeile) {
  if (/€|\bEUR\b/i.test(zeile)) return 'EUR';
  if (/\$|\bUSD\b/i.test(zeile)) return 'USD';
  return null;
}

/** Betrag auf einer Zeile mit Summenwort (letzte solche Zeile, letzter Betrag darauf). */
export function summeFinden(text) {
  const zeilen = String(text).split('\n');
  for (let i = zeilen.length - 1; i >= 0; i--) {
    const z = zeilen[i];
    if (!SUMMEN_WORTE.test(z) || /netto|net amount|subtotal|zwischensumme|ust|mwst|vat|steuer/i.test(z) && !/brutto|gesamtbetrag|total amount/i.test(z)) continue;
    const de = [...z.matchAll(BETRAG_DE)].map((m) => m[1]);
    const en = de.length ? [] : [...z.matchAll(BETRAG_EN)].map((m) => m[1]);
    const treffer = de.length ? de : en;
    if (treffer.length) return { betrag: betragAusText(treffer[treffer.length - 1]), waehrung: waehrungIn(z) || waehrungIn(text) || 'EUR' };
  }
  return null;
}

const MONATE = { januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12, january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12 };

function isoAus(j, m, t) {
  const d = `${j}-${String(m).padStart(2, '0')}-${String(t).padStart(2, '0')}`;
  const p = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(p.getTime()) && p.toISOString().slice(0, 10) === d ? d : null;
}

/** Erstes Datum (bevorzugt nach "Rechnungsdatum"/"Datum"/"Invoice date"). */
export function datumFinden(text) {
  const t = String(text);
  // [Muster, Jahr zuerst?] - Reihenfolge = Vorrang; je Muster gewinnt das erste GUELTIGE Datum
  const muster = [
    [/(?:rechnungsdatum|invoice date|datum|date)\s*:?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/gi, false],
    [/(?:rechnungsdatum|invoice date|datum|date)\s*:?\s*(\d{4})-(\d{2})-(\d{2})/gi, true],
    [/(\d{1,2})\.(\d{1,2})\.(\d{4})/g, false],
    [/(\d{4})-(\d{2})-(\d{2})/g, true],
  ];
  for (const [r, jahrZuerst] of muster) {
    for (const m of t.matchAll(r)) {
      const d = jahrZuerst ? isoAus(m[1], m[2], m[3]) : isoAus(m[3], m[2], m[1]);
      if (d) return d;
    }
  }
  const w = /(\d{1,2})\.?\s+([A-Za-zäÄ]+)\s+(\d{4})/.exec(t);
  if (w && MONATE[w[2].toLowerCase()]) return isoAus(w[3], MONATE[w[2].toLowerCase()], w[1]);
  return null;
}

export function rechnungsnummerFinden(text) {
  const t = String(text);
  const m =
    /(?:rechnungs?-?\s?(?:nr\.?|nummer)|rechnung\s+nr\.?|invoice\s+(?:no\.?|number|#))\s*:?\s*([A-Z0-9][A-Z0-9/_-]{3,40})/i.exec(t) ||
    /\b(R\d{8,12})\b/.exec(t);
  return m ? m[1] : null;
}

const ANBIETER = [
  { muster: /Hetzner Online GmbH/i, anbieter: 'Hetzner Online GmbH', kategorie: 'server', beschreibung: 'Server (Hetzner)', automatisch: true },
  { muster: /Google (?:Commerce|Payment|Ireland|Play)/i, anbieter: 'Google', kategorie: 'software', beschreibung: 'Google (Play Console o. Ä.)', automatisch: false },
  { muster: /Kraken|Payward/i, anbieter: 'Kraken (Payward)', kategorie: 'gebuehren', beschreibung: 'Kraken', automatisch: false },
];

/**
 * @returns {{anbieter: string|null, kategorie: string|null, beschreibung: string, rechnungsnummer: string|null,
 *            datum: string|null, betrag: string|null, waehrung: string|null, sicher: boolean}}
 * `sicher` = bekannter Anbieter mit eindeutig erkannten Pflichtangaben in EUR -> darf ohne Rueckfrage gebucht werden.
 */
export function erkennen(text) {
  const a = ANBIETER.find((x) => x.muster.test(text));
  const summe = summeFinden(text);
  const ergebnis = {
    anbieter: a?.anbieter || null,
    kategorie: a?.kategorie || null,
    beschreibung: a?.beschreibung || '',
    rechnungsnummer: rechnungsnummerFinden(text),
    datum: datumFinden(text),
    betrag: summe?.betrag || null,
    waehrung: summe?.waehrung || null,
    sicher: false,
  };
  ergebnis.sicher = Boolean(a?.automatisch && ergebnis.rechnungsnummer && ergebnis.datum && ergebnis.betrag && ergebnis.waehrung === 'EUR' && Number(ergebnis.betrag) > 0);
  return ergebnis;
}
