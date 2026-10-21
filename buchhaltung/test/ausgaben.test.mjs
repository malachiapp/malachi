import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ausgabenbuch, eurNormalisieren } from '../lib/ausgaben.mjs';
import { tmpOrdner } from './hilfen.mjs';

const neu = () => new Ausgabenbuch(path.join(tmpOrdner(), 'ausgaben.jsonl'), { jetzt: () => Date.parse('2026-10-20T10:00:00Z') });
const hetzner = { datum: '2026-10-01', anbieter: 'Hetzner Online GmbH', rechnungsnummer: 'R1', kategorie: 'server', betragEur: '4,51' };

test('Betraege normalisieren', () => {
  assert.equal(eurNormalisieren('4,51'), '4.51');
  assert.equal(eurNormalisieren('1.234,5'), '1234.50');
  assert.equal(eurNormalisieren('12 €'), '12.00');
  assert.throws(() => eurNormalisieren('-3'));
  assert.throws(() => eurNormalisieren('abc'));
  assert.throws(() => eurNormalisieren('1,234'));
});

test('buchen, Kette pruefen, Zahlungstag standardmaessig = Rechnungsdatum', () => {
  const b = neu();
  const e = b.buchen(hetzner);
  assert.equal(e.seq, 1);
  assert.equal(e.betragEur, '4.51');
  assert.equal(e.bezahltAm, '2026-10-01');
  const e2 = b.buchen({ ...hetzner, rechnungsnummer: 'R2', bezahltAm: '2026-10-03' });
  assert.equal(e2.bezahltAm, '2026-10-03');
  assert.deepEqual(b.pruefen(), { ok: true, kopf: e2.hash, anzahl: 2 });
});

test('doppelte Rechnung oder gleicher Beleg werden abgelehnt', () => {
  const b = neu();
  b.buchen({ ...hetzner, beleg: { datei: 'x.pdf', sha256: 'a'.repeat(64) } });
  assert.throws(() => b.buchen(hetzner), /bereits gebucht/);
  assert.throws(() => b.buchen({ ...hetzner, rechnungsnummer: 'R9', beleg: { datei: 'y.pdf', sha256: 'a'.repeat(64) } }), /gleicher Dateiinhalt/);
});

test('ungueltige Angaben werden abgelehnt', () => {
  const b = neu();
  assert.throws(() => b.buchen({ ...hetzner, kategorie: 'urlaub' }), /Unbekannte Kategorie/);
  assert.throws(() => b.buchen({ ...hetzner, datum: '01.10.2026' }), /Rechnungsdatum/);
  assert.throws(() => b.buchen({ ...hetzner, anbieter: ' ' }), /Anbieter/);
  assert.throws(() => b.buchen({ ...hetzner, betragEur: '0' }), /0/);
});

test('Storno nimmt die Ausgabe heraus, doppeltes Storno nicht moeglich', () => {
  const b = neu();
  b.buchen(hetzner);
  b.storno(1, 'falsch erfasst');
  assert.equal(b.gueltige().length, 0);
  assert.throws(() => b.storno(1, 'nochmal'), /bereits storniert/);
  assert.throws(() => b.storno(2, 'x'), /nicht gefunden/);
  assert.equal(b.pruefen().ok, true);
  // nach Storno darf dieselbe Rechnung neu gebucht werden
  assert.equal(b.buchen(hetzner).seq, 3);
});

test('veraenderte Datei wird erkannt und blockiert weitere Buchungen', () => {
  const b = neu();
  b.buchen(hetzner);
  b.buchen({ ...hetzner, rechnungsnummer: 'R2' });
  const text = fs.readFileSync(b.datei, 'utf8').replace('"4.51"', '"0.51"');
  fs.writeFileSync(b.datei, text);
  const p = b.pruefen();
  assert.equal(p.ok, false);
  assert.match(p.fehler, /Inhalt veraendert/);
  assert.throws(() => b.buchen({ ...hetzner, rechnungsnummer: 'R3' }), /beschaedigt/);
});
