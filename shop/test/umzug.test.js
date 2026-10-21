// Umzug der Lizenz auf ein neues Geraet mit Wiederherstellungscode; Aktivierungslimit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../src/bestellungen.js';
import { pruefeLizenz } from '../src/lizenzpruefer.js';
import { gruppieren } from '../src/ids.js';
import { testShop, GERAET_A, GERAET_B, TEST_OEFFENTLICH, zufallsGeraet } from './hilfen.js';

const ok = (l, dev) => pruefeLizenz(l, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: dev });

async function bezahlteBestellung(ueberschreiben = {}) {
  const s = await testShop(ueberschreiben);
  const { bestellung, wiederherstellungscode } = await s.verwaltung.erstellen({ geraetecode: GERAET_A, zustimmung: true });
  s.wallet.zahlung(bestellung.index, bestellung.betrag, { hoehe: s.wallet.hoehe });
  await s.verwaltung.aktualisieren(bestellung.id, { mindestAbstandMs: 0 });
  assert.equal(bestellung.status, STATUS.BEZAHLT);
  return { ...s, b: bestellung, code: wiederherstellungscode };
}

describe('Umzug mit Wiederherstellungscode', () => {
  it('neue Lizenz fuer das neue Geraet; gleiche Lizenz-ID und Bestellnummer', async () => {
    const { verwaltung: v, b, code } = await bezahlteBestellung();
    const r = await v.umziehen({ bestellnummer: gruppieren(b.id).toLowerCase(), wiederherstellungscode: gruppieren(code), geraetecode: GERAET_B });
    assert.equal(r.neu, true);
    assert.equal(r.aktivierungen, 2);
    const p = ok(r.lizenz, GERAET_B);
    assert.equal(p.gueltig, true);
    assert.equal(p.daten.lic, b.lizenzId);
    assert.equal(p.daten.ord, b.id);
    assert.equal(ok(r.lizenz, GERAET_A).grund, 'anderes-geraet');
    assert.equal(v.aktuelleLizenz(b).dev, GERAET_B);
    // Ehrliche Einschraenkung: die alte Lizenz bleibt offline auf dem alten Geraet gueltig
    assert.equal(ok(b.lizenzen[0].lizenz, GERAET_A).gueltig, true);
  });

  it('dasselbe Geraet erneut: dieselbe Lizenz, keine weitere Aktivierung', async () => {
    const { verwaltung: v, b, code } = await bezahlteBestellung();
    const r = await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_A });
    assert.equal(r.neu, false);
    assert.equal(r.aktivierungen, 1);
    assert.equal(r.lizenz, b.lizenzen[0].lizenz);
  });

  it('Aktivierungslimit (Standard 3 insgesamt)', async () => {
    const { verwaltung: v, b, code } = await bezahlteBestellung();
    await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: zufallsGeraet() });
    await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: zufallsGeraet() });
    await assert.rejects(v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: zufallsGeraet() }), (e) => e.code === 'limit');
    assert.equal(b.lizenzen.length, 3);
    // Ein schon aktiviertes Geraet bekommt seine Lizenz weiterhin
    const r = await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_A });
    assert.equal(r.neu, false);
  });

  it('Aktivierungslimit ist konfigurierbar', async () => {
    const { verwaltung: v, b, code } = await bezahlteBestellung({ lizenz: { maxAktivierungen: 1 } });
    await assert.rejects(v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_B }), (e) => e.code === 'limit');
  });

  it('falscher Code: Fehler, nach 5 Fehlversuchen 15 Minuten Sperre', async () => {
    const { verwaltung: v, b, code, uhr } = await bezahlteBestellung();
    const falsch = code.slice(0, 19) + (code[19] === '0' ? '1' : '0');
    for (let i = 0; i < 5; i++) {
      await assert.rejects(v.umziehen({ bestellnummer: b.id, wiederherstellungscode: falsch, geraetecode: GERAET_B }), (e) => e.code === 'code');
    }
    await assert.rejects(v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_B }), (e) => e.code === 'gesperrt');
    uhr.vor(15 * 60_000 + 1);
    const r = await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_B });
    assert.equal(r.neu, true);
  });

  it('unbezahlte oder unbekannte Bestellungen, ungueltiger Geraetecode', async () => {
    const s = await testShop();
    const { bestellung, wiederherstellungscode } = await s.verwaltung.erstellen({ geraetecode: GERAET_A, zustimmung: true });
    await assert.rejects(s.verwaltung.umziehen({ bestellnummer: bestellung.id, wiederherstellungscode, geraetecode: GERAET_B }), (e) => e.code === 'code');
    await assert.rejects(s.verwaltung.umziehen({ bestellnummer: 'NICHTVORHANDEN00', wiederherstellungscode, geraetecode: GERAET_B }), (e) => e.code === 'code');
    const { verwaltung: v, b, code } = await bezahlteBestellung();
    await assert.rejects(v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: 'KAPUTT' }), (e) => e.code === 'geraetecode');
  });

  it('Ratenbegrenzung fuer Umzuege - Anfragen ohne gueltige Bestellung belasten sie nicht (Audit S2)', async () => {
    const { verwaltung: v, b, code } = await bezahlteBestellung({ lizenz: { umzuegeProStunde: 1 } });
    // Sinnlose Anfragen (Bestellung gibt es nicht): nie "rate", sperren also niemanden aus.
    for (let i = 0; i < 30; i++) {
      await assert.rejects(() => v.umziehen({ bestellnummer: 'NICHTVORHANDEN00', wiederherstellungscode: 'x', geraetecode: GERAET_B }), (e) => e.code === 'code');
    }
    // Anfragen fuer eine echte Bestellung zaehlen weiter.
    let begrenzt = false;
    for (let i = 0; i < 15; i++) {
      try {
        await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_A });
      } catch (e) {
        if (e.code === 'rate') begrenzt = true;
      }
    }
    assert.ok(begrenzt);
  });

  it('Grenzen je Tor-Kreis: ein Kreis erschoepft die Umzuege nicht fuer andere', async () => {
    const { verwaltung: v, b, code } = await bezahlteBestellung();
    let begrenzt = 0;
    for (let i = 0; i < 12; i++) {
      try {
        await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_A, kreis: '0:1' });
      } catch (e) {
        if (e.code === 'rate') begrenzt++;
      }
    }
    assert.ok(begrenzt > 0, 'Kreis 0:1 wird begrenzt');
    const r = await v.umziehen({ bestellnummer: b.id, wiederherstellungscode: code, geraetecode: GERAET_A, kreis: '0:2' });
    assert.equal(r.neu, false, 'anderer Kreis kommt durch');
  });
});
