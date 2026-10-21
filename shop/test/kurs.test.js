import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { median, kursAusWerten, wertAnPfad, Kursdienst, KursFehler } from '../src/kurs.js';
import { STANDARD_KURSQUELLEN } from '../src/config.js';
import { FakeKurse, testUhr } from './hilfen.js';

const ok = (name, wert) => ({ name, ok: true, wert });

describe('Kursmedian', () => {
  it('Median fuer gerade und ungerade Anzahl', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([485.23, 487.3]), 486.265);
    assert.throws(() => median([]), KursFehler);
  });

  it('verwirft Ausreisser und verlangt Mindestanzahl', () => {
    assert.equal(kursAusWerten([ok('a', 100), ok('b', 101), ok('c', 300)], { mindestQuellen: 2 }), 100.5);
    assert.throws(() => kursAusWerten([ok('a', 100), { name: 'b', ok: false }], { mindestQuellen: 2 }), /Nur 1 von mindestens 2/);
    assert.throws(() => kursAusWerten([ok('a', 100), ok('b', 130)], { mindestQuellen: 2, maxAbweichungProzent: 5 }), /weichen zu stark/);
    assert.equal(kursAusWerten([ok('a', 100)], { mindestQuellen: 1 }), 100);
  });

  it('liest Werte ueber Punkt-Pfade', () => {
    const d = { result: { XXMRZEUR: { c: ['485.23', '1.0'] } }, monero: { eur: 487.3 } };
    assert.equal(wertAnPfad(d, 'result.XXMRZEUR.c.0'), '485.23');
    assert.equal(wertAnPfad(d, 'monero.eur'), 487.3);
    assert.equal(wertAnPfad(d, 'monero.usd'), undefined);
    assert.equal(wertAnPfad(d, '__proto__.x'), undefined);
  });
});

describe('Kursdienst', () => {
  const dienst = (kurse, uhr = testUhr(), mindestQuellen = 2) =>
    new Kursdienst({
      holen: kurse.holen,
      waehrungen: { XMR: { quellen: STANDARD_KURSQUELLEN.XMR, min: 1, max: 100_000 }, BTC: { quellen: STANDARD_KURSQUELLEN.BTC, min: 1000, max: 10_000_000 } },
      mindestQuellen,
      cacheSek: 300,
      jetzt: uhr.jetzt,
    });

  it('Median aus Kraken und CoinGecko, mit Quellenangabe und Abrufzeit', async () => {
    const k = await dienst(new FakeKurse()).kurs('XMR');
    assert.equal(k.eurProCoin, 486.27);
    assert.deepEqual(k.quellen, [{ name: 'kraken', wert: 485.23 }, { name: 'coingecko', wert: 487.3 }]);
    assert.equal(k.abgerufen, '2026-10-15T12:00:00.000Z');
    assert.match(k.methode, /Median aus 2 Quellen/);
  });

  it('faellt eine Quelle aus, scheitert der Abruf bei mindestQuellen=2', async () => {
    const kurse = new FakeKurse();
    kurse.ausfall.add('kraken');
    await assert.rejects(dienst(kurse).kurs('XMR'), KursFehler);
    const k = await dienst(kurse, testUhr(), 1).kurs('XMR');
    assert.equal(k.eurProCoin, 487.3);
    assert.equal(k.quellen[0].fehler.includes('Tor'), true);
  });

  it('unplausible Werte werden verworfen', async () => {
    const kurse = new FakeKurse();
    kurse.xmr.coingecko = 0;
    await assert.rejects(dienst(kurse).kurs('XMR'), /Nur 1/);
  });

  it('zwischengespeichert fuer cacheSek', async () => {
    const kurse = new FakeKurse();
    const uhr = testUhr();
    const d = dienst(kurse, uhr);
    await d.kurs('XMR');
    await d.kurs('XMR');
    assert.equal(kurse.aufrufe.length, 2);
    uhr.vor(301_000);
    await d.kurs('XMR');
    assert.equal(kurse.aufrufe.length, 4);
  });
});
