import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berechnen, csvDateien, htmlSeite, euro } from '../lib/bericht.mjs';
import { quartal, jahr, letztesAbgeschlossenesQuartal, lesbar } from '../lib/zeitraum.mjs';
import { EUER_EINNAHMEN, UEBRIGE } from '../lib/kategorien.mjs';

// Beispiel (von Hand nachgerechnet):
//   Q3: Lizenz 2,99 € in XMR (0,01 XMR)
//   Q4: Lizenzen 2,99 € in BTC (0,00005) und 2,99 € in XMR (0,01); BTC verkauft fuer 3,20 € (Gebuehr 0,05 €);
//       Netzwerkgebuehr 0,10 € (EUR)
//   Ausgaben Q4: Hetzner 4,51 €, Laptop 999,00 € (Anlage), Play-Konto 23,40 € (USD)
const journale = {
  einnahmen: [
    { typ: 'einnahme', seq: 1, zeit: '2026-09-15T10:00:00.000Z', betragEur: '2.99', waehrung: 'XMR', empfangenCoin: '0.01' },
    { typ: 'einnahme', seq: 2, zeit: '2026-10-05T10:00:00.000Z', betragEur: '2.99', waehrung: 'BTC', empfangenCoin: '0.00005' },
    { typ: 'einnahme', seq: 3, zeit: '2026-11-01T10:00:00.000Z', betragEur: '2.99', waehrung: 'XMR', empfangenCoin: '0.01' },
  ],
  verkaeufe: [{ typ: 'verkauf', seq: 1, datum: '2026-12-01', waehrung: 'BTC', mengeCoin: '0.00005', erloesEur: '3.20', gebuehrEur: '0.05' }],
  gebuehren: [{ typ: 'gebuehr', seq: 1, datum: '2026-10-06', waehrung: 'EUR', betrag: '0.10', betragEur: '0.10' }],
  auszahlungen: [],
  sonstige: [],
};
const ausgaben = [
  { seq: 1, datum: '2026-10-01', bezahltAm: '2026-10-01', anbieter: 'Hetzner Online GmbH', kategorie: 'server', betragEur: '4.51', waehrung: 'EUR' },
  { seq: 2, datum: '2026-11-10', bezahltAm: '2026-11-10', anbieter: 'Laden', kategorie: 'anlage', betragEur: '999.00', waehrung: 'EUR' },
  { seq: 3, datum: '2026-12-02', bezahltAm: '2026-12-02', anbieter: 'Google', kategorie: 'software', betragEur: '23.40', waehrung: 'USD', betragOriginal: '25.00' },
  { seq: 4, datum: '2026-09-30', bezahltAm: '2027-01-02', anbieter: 'Hetzner Online GmbH', kategorie: 'server', betragEur: '4.51', waehrung: 'EUR' },
];
const c = (t) => BigInt(Math.round(Number(t) * 100));

test('Zeitraeume', () => {
  assert.deepEqual(quartal('2026-q4'), { name: '2026-Q4', jahr: 2026, quartal: 4, von: '2026-10-01', bis: '2027-01-01' });
  assert.equal(quartal('2026-Q1').bis, '2026-04-01');
  assert.equal(letztesAbgeschlossenesQuartal(new Date('2026-10-20T00:00:00Z')).name, '2026-Q3');
  assert.equal(letztesAbgeschlossenesQuartal(new Date('2027-02-01T00:00:00Z')).name, '2026-Q4');
  assert.equal(lesbar(quartal('2026-Q4')), '01.10.2026 bis 31.12.2026');
  assert.throws(() => quartal('2026-Q5'));
});

test('Quartal und Jahr bis Quartalsende werden richtig gerechnet', () => {
  const b = berechnen({ journale, ausgaben, zeitraum: quartal('2026-Q4'), erinnerung: { XMR: '5', BTC: '1' } });
  assert.equal(b.q.u.anzahlLizenzen, 2);
  assert.equal(b.q.einnahmen, c(5.98));
  assert.equal(b.q.veraeusserung, c(0.21)); // 3,20 Erloes - 2,99 Buchwert
  assert.equal(b.q.kostenShop, c(0.15)); // 0,05 Verkauf + 0,10 Netzwerk
  assert.equal(b.q.ausgabenSumme, c(1026.91));
  assert.equal(b.q.ausgabenOhneAnlage, c(27.91));
  assert.equal(b.q.ergebnis, c(-21.87)); // 5,98 + 0,21 - 0,15 - 27,91
  assert.equal(b.j.einnahmen, c(8.97));
  assert.equal(b.j.ergebnis, c(-18.88));
  // Hetzner-Rechnung vom 30.09., bezahlt 2027 -> zaehlt nicht (Abflussprinzip)
  assert.ok(!b.ausgQ.some((a) => a.seq === 4));
});

test('EUeR-Entwurf, Klaerungspunkte, Bestand und Erinnerung', () => {
  const b = berechnen({ journale, ausgaben, zeitraum: quartal('2026-Q4'), erinnerung: { XMR: '5', BTC: '1' } });
  const feld = (n) => b.felder.find((f) => f.feld === n)?.betrag;
  assert.equal(feld(EUER_EINNAHMEN), c(8.97));
  assert.equal(feld(UEBRIGE), c(28.06)); // 0,15 Shop + 4,51 Hetzner + 23,40 Play
  assert.equal(b.klaerung.length, 3); // Coin-Verkauf, Anlage, Fremdwaehrung
  assert.deepEqual(b.bestand.XMR, { menge: '0.020000000000', buchwertEur: '5.98', marktwertEur: null });
  assert.equal(b.bestand.BTC.menge, '0.00000000');
  assert.deepEqual(b.erinnerungen.map((e) => e.waehrung), ['XMR']);
  const ohne = berechnen({ journale, ausgaben, zeitraum: quartal('2026-Q4'), erinnerung: { XMR: '100' } });
  assert.equal(ohne.erinnerungen.length, 0);
});

test('Jahresbericht = Jahr komplett', () => {
  const b = berechnen({ journale, ausgaben, zeitraum: jahr(2026), erinnerung: {} });
  assert.equal(b.q.einnahmen, c(8.97));
  assert.equal(b.q.ergebnis, b.j.ergebnis);
});

test('HTML und CSV enthalten die Zahlen, keine Skripte, Formel-Injektion entschaerft', () => {
  const b = berechnen({ journale, ausgaben: [...ausgaben, { seq: 5, datum: '2026-10-10', bezahltAm: '2026-10-10', anbieter: '=HYPERLINK("x")', kategorie: 'sonstiges', betragEur: '1.00', waehrung: 'EUR' }], zeitraum: quartal('2026-Q4'), erinnerung: { XMR: '5' } });
  const seite = htmlSeite(b, { art: 'quartal', erstellt: '2027-01-03T12:00:00Z', sicherungTag: '2027-01-03', ketten: { einnahmen: { ok: true, anzahl: 3 } }, ausgabenKette: { ok: true, anzahl: 5 }, warnungen: [], wartendeBelege: ['offen.pdf'], serverBefehl: 'ssh x' });
  assert.ok(!/<script/i.test(seite));
  assert.match(seite, /Quartalsbericht 2026-Q4/);
  assert.match(seite, /Entwurf, keine Steuerberatung/);
  assert.match(seite, /−22,87 €/); // Ergebnis Quartal inkl. 1,00 € sonstiges
  assert.match(seite, /Monero/);
  assert.match(seite, /offen\.pdf/);
  assert.match(seite, /=HYPERLINK\(&quot;x&quot;\)/); // in HTML maskiert
  const dateien = csvDateien(journale, b);
  assert.deepEqual(Object.keys(dateien).sort(), ['ausgaben.csv', 'coin-verkaeufe.csv', 'einnahmen.csv', 'euer-entwurf.csv', 'gebuehren.csv', 'sonstige-eingaenge.csv', 'uebersicht.csv']);
  assert.match(dateien['ausgaben.csv'], /'=HYPERLINK/); // fuer Excel entschaerft
  assert.match(dateien['einnahmen.csv'], /2026-10-05/);
  assert.ok(!/2026-09-15/.test(dateien['einnahmen.csv'])); // Q3-Einnahme nicht im Q4-Export
  assert.match(dateien['euer-entwurf.csv'], /Kleinunternehmer;8,97/);
});

test('euro() formatiert deutsch', () => {
  assert.equal(euro('1234.5'), '1.234,50 €');
  assert.equal(euro(-2187n), '−21,87 €');
  assert.equal(euro('0'), '0,00 €');
});
