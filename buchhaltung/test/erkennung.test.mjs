import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { erkennen, betragAusText, datumFinden, summeFinden } from '../lib/erkennung.mjs';
import { pdfText } from '../lib/pdftext.mjs';
import { pdfMitText, tmpOrdner, HETZNER_ZEILEN } from './hilfen.mjs';

test('Hetzner-Rechnung (Text) wird vollstaendig und sicher erkannt', () => {
  const e = erkennen(HETZNER_ZEILEN.join('\n').replace(/ EUR/g, ' €'));
  assert.equal(e.anbieter, 'Hetzner Online GmbH');
  assert.equal(e.kategorie, 'server');
  assert.equal(e.rechnungsnummer, 'R0012345678');
  assert.equal(e.datum, '2026-10-01');
  assert.equal(e.betrag, '4.51');
  assert.equal(e.waehrung, 'EUR');
  assert.equal(e.sicher, true);
});

test('Netto- und Steuerzeilen werden nicht als Summe genommen', () => {
  assert.equal(summeFinden('Summe netto 10,00 €\nUSt 19 % 1,90 €'), null);
  assert.equal(summeFinden('Gesamtbetrag inkl. MwSt. 11,90 €').betrag, '11.90');
});

test('unbekannter Anbieter in USD ist nie "sicher"', () => {
  const e = erkennen('Some Vendor Inc.\nInvoice number: INV-2026-0042\nInvoice date: 2026-11-03\nTotal amount: $25.00');
  assert.equal(e.anbieter, null);
  assert.equal(e.rechnungsnummer, 'INV-2026-0042');
  assert.equal(e.datum, '2026-11-03');
  assert.equal(e.betrag, '25.00');
  assert.equal(e.waehrung, 'USD');
  assert.equal(e.sicher, false);
});

test('Betraege und Datumsformate', () => {
  assert.equal(betragAusText('1.234,56'), '1234.56');
  assert.equal(betragAusText('1,234.56'), '1234.56');
  assert.equal(datumFinden('vom 3. Oktober 2026'), '2026-10-03');
  assert.equal(datumFinden('31.02.2026 und 01.03.2026'), '2026-03-01'); // ungueltiges Datum uebersprungen
  assert.equal(datumFinden('kein Datum'), null);
});

test('Text aus einer echten PDF-Datei lesen und erkennen', async () => {
  const d = tmpOrdner();
  const f = path.join(d, 'rechnung.pdf');
  fs.writeFileSync(f, pdfMitText(HETZNER_ZEILEN));
  const text = await pdfText(f);
  assert.match(text, /Hetzner Online GmbH/);
  assert.match(text, /Gesamtbetrag 4,51 EUR/);
  const e = erkennen(text);
  assert.equal(e.sicher, true);
  assert.equal(e.betrag, '4.51');
});
