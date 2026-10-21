// Bestellablauf mit gemocktem wallet-rpc: offen, unterzahlt, im Pool, bestaetigt,
// abgelaufen; Lizenz, Buchung, Wiederverwendung von Subadressen, externer
// Zahlungsdienst (Mock) und optionaler Bitcoin-Weg.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STATUS, ShopFehler, bewerteZahlung, betragBerechnen, betragText, Bestellverwaltung } from '../src/bestellungen.js';
import { pruefeLizenz } from '../src/lizenzpruefer.js';
import { lizenzSignieren } from '../src/lizenz.js';
import { testShop, STUNDE, TAG, GERAET_A, GERAET_B, TEST_OEFFENTLICH, TEST_PRIVAT, TestZahlungsdienst, FakeMempool, BTC_TESTKONTO } from './hilfen.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';

const BETRAG = 6_149_000_000; // 2,99 EUR bei 486,27 EUR/XMR, aufgerundet auf 0,000001 XMR
const pruefe = (v, id) => v.aktualisieren(id, { mindestAbstandMs: 0 });
const neu = (v, extra = {}) => v.erstellen({ geraetecode: GERAET_A, zustimmung: true, ...extra });
const lizenzOk = (l, dev = GERAET_A) => pruefeLizenz(l, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: dev }).gueltig;

describe('Hilfsfunktionen', () => {
  it('bewerteZahlung', () => {
    const b = { betrag: 1000 };
    assert.equal(bewerteZahlung({ ...b, empfangen: 0, bestaetigt: 0 }), STATUS.OFFEN);
    assert.equal(bewerteZahlung({ ...b, empfangen: 999, bestaetigt: 999 }), STATUS.UNTERZAHLT);
    assert.equal(bewerteZahlung({ ...b, empfangen: 1000, bestaetigt: 0 }), STATUS.UNBESTAETIGT);
    assert.equal(bewerteZahlung({ ...b, empfangen: 1500, bestaetigt: 1000 }), STATUS.BEZAHLT);
    assert.equal(bewerteZahlung({ ...b, empfangen: 990, bestaetigt: 990, toleranz: 10 }), STATUS.BEZAHLT);
  });

  it('Betrag in XMR (aufgerundet) und Anzeige', () => {
    const xmr = { einheit: 1e12, rundung: 1e6, stellen: 12, anzeigeStellen: 6 };
    assert.equal(betragBerechnen(2.99, 486.27, xmr), BETRAG);
    assert.equal(betragText(BETRAG, xmr), '0.006149');
    assert.equal(betragText(1_500_000_000_000, xmr), '1.500000');
    const btc = { einheit: 1e8, rundung: 1, stellen: 8, anzeigeStellen: 8 };
    assert.equal(betragBerechnen(2.99, 73_174, btc), 4087);
    assert.equal(betragText(4087, btc), '0.00004087');
  });
});

describe('Bestellablauf Monero (view-only wallet-rpc)', () => {
  it('offen: frische Subadresse, Betrag aus dem Kursmedian, Wiederherstellungscode', async () => {
    const { verwaltung: v, wallet } = await testShop();
    const { bestellung: b, wiederherstellungscode } = await neu(v);
    assert.match(b.id, /^[0-9A-HJKMNP-TV-Z]{16}$/);
    assert.match(wiederherstellungscode, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assert.equal(b.status, STATUS.OFFEN);
    assert.equal(b.index, 1);
    assert.equal(b.adresse, wallet.adressen[1]);
    assert.equal(b.betrag, BETRAG);
    assert.equal(b.kurs.eurProCoin, 486.27);
    assert.equal(b.kurs.quellen.length, 2);
    assert.equal(b.geraetecode, GERAET_A);
    assert.ok(!JSON.stringify(v.daten).includes(wiederherstellungscode), 'Code wird nur als Hash gespeichert');
    assert.equal((await pruefe(v, b.id)).status, STATUS.OFFEN);
    assert.equal((await neu(v)).bestellung.index, 2);
  });

  it('unterzahlt -> Rest im Pool -> bestaetigt: Lizenz fuer das Geraet und Buchung', async () => {
    const { verwaltung: v, wallet, buchhaltung, uhr } = await testShop();
    const { bestellung: b } = await neu(v);
    const erste = wallet.zahlung(b.index, 4_000_000_000);
    let s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.UNTERZAHLT);
    assert.equal(s.empfangen, 4_000_000_000);
    wallet.bestaetigen(erste);
    uhr.vor(30 * STUNDE); // unterzahlte Bestellungen verfallen nicht nach 24 h
    await v.hintergrundLauf();
    assert.equal(v.holen(b.id).status, STATUS.UNTERZAHLT);
    const rest = wallet.zahlung(b.index, BETRAG - 4_000_000_000);
    s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.UNBESTAETIGT, 'Rest im Pool');
    assert.equal(s.lizenzen.length, 0);
    wallet.bestaetigen(rest);
    s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.BEZAHLT);
    assert.equal(s.rechnungsnummer, 'MAL-2026-000001');
    assert.equal(s.lizenzen.length, 1);
    assert.ok(lizenzOk(s.lizenzen[0].lizenz));
    assert.ok(!lizenzOk(s.lizenzen[0].lizenz, GERAET_B));
    const e = buchhaltung.lesen('einnahmen');
    assert.equal(e.length, 1);
    assert.equal(e[0].betragEur, '2.99');
    assert.equal(e[0].waehrung, 'XMR');
    assert.equal(e[0].betragCoin, '0.006149000000');
    assert.equal(e[0].empfangenCoin, '0.006149000000');
    assert.equal(e[0].kurs.eurProCoin, 486.27);
    assert.equal(e[0].subadresseIndex, 1);
    assert.equal(e[0].lizenz, s.lizenzId);
    assert.deepEqual(e[0].txids.sort(), [erste.txid, rest.txid].sort());
    assert.equal(e[0].verwahrung, 'eigenes-wallet');
  });

  it('Mindestbestaetigungen werden eingehalten', async () => {
    const { verwaltung: v, wallet } = await testShop({ mindestBestaetigungen: 10 });
    const { bestellung: b } = await neu(v);
    wallet.zahlung(b.index, BETRAG, { hoehe: wallet.hoehe - 8 }); // 9 Bestaetigungen
    assert.equal((await pruefe(v, b.id)).status, STATUS.UNBESTAETIGT);
    wallet.hoehe += 1;
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
  });

  it('Ueberzahlung wird akzeptiert und gebucht', async () => {
    const { verwaltung: v, wallet, buchhaltung } = await testShop();
    const { bestellung: b } = await neu(v);
    wallet.zahlung(b.index, BETRAG + 1_000_000_000, { hoehe: wallet.hoehe });
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
    assert.equal(buchhaltung.lesen('einnahmen')[0].ueberzahlungCoin, '0.001000000000');
  });

  it('abgelaufen nach 24 h ohne Zahlung; spaete Zahlung wird noch erkannt', async () => {
    const { verwaltung: v, wallet, uhr } = await testShop();
    const { bestellung: a } = await neu(v);
    const { bestellung: b } = await neu(v);
    uhr.vor(24 * STUNDE + 1);
    assert.equal(v.holen(a.id).status, STATUS.ABGELAUFEN);
    wallet.zahlung(b.index, BETRAG, { hoehe: wallet.hoehe });
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
  });

  it('nach der Reservierung wird die Bestellung geloescht und die Subadresse wiederverwendet', async () => {
    const { verwaltung: v, uhr } = await testShop();
    const { bestellung: a } = await neu(v);
    uhr.vor(72 * STUNDE + 1);
    await v.hintergrundLauf();
    assert.equal(v.holen(a.id), null);
    assert.deepEqual(v.daten.zaehler.xmr.freie, [1]);
    assert.equal((await neu(v)).bestellung.index, 1);
    assert.equal((await neu(v)).bestellung.index, 2);
  });

  it('eine Subadresse mit (spaetem) Eingang wird nie wieder vergeben', async () => {
    const { verwaltung: v, wallet, uhr } = await testShop();
    const { bestellung: a } = await neu(v);
    uhr.vor(72 * STUNDE + 1);
    await v.hintergrundLauf();
    wallet.zahlung(a.index, 1000);
    const { bestellung: b } = await neu(v);
    assert.equal(b.index, 2);
    assert.ok(!v.daten.zaehler.xmr.freie.includes(1));
  });

  it('nach Neuanlage des Wallets werden unbekannte freie Indizes verworfen', async () => {
    const { verwaltung: v, wallet, uhr } = await testShop();
    await neu(v);
    await neu(v);
    uhr.vor(72 * STUNDE + 1);
    await v.hintergrundLauf();
    assert.deepEqual(v.daten.zaehler.xmr.freie, [1, 2]);
    wallet.adressen = [wallet.hauptadresse]; // Wallet neu angelegt: kennt nur die Hauptadresse
    const { bestellung: b } = await neu(v);
    assert.equal(b.index, 1, 'frisch erzeugt, nicht aus dem Pool');
    assert.deepEqual(v.daten.zaehler.xmr.freie, []);
  });

  it('ohne erfolgreiche Abschlusspruefung (wallet-rpc weg) wird nicht geloescht', async () => {
    const { verwaltung: v, wallet, uhr } = await testShop();
    const { bestellung: a } = await neu(v);
    uhr.vor(72 * STUNDE + 1);
    wallet.ausfall = true;
    await v.hintergrundLauf();
    assert.equal(v.holen(a.id).status, STATUS.ABGELAUFEN);
    wallet.ausfall = false;
    await v.hintergrundLauf();
    assert.equal(v.holen(a.id), null);
  });

  it('unvollstaendige Bestellungen werden nach der Frist als sonstiger Eingang gebucht und geloescht', async () => {
    const { verwaltung: v, wallet, uhr, buchhaltung } = await testShop();
    const { bestellung: a } = await neu(v);
    wallet.zahlung(a.index, 1_000_000_000, { hoehe: wallet.hoehe });
    await pruefe(v, a.id);
    uhr.vor(30 * TAG + 1);
    await v.aufraeumen();
    assert.equal(v.holen(a.id), null);
    const s = buchhaltung.lesen('sonstige');
    assert.equal(s.length, 1);
    assert.equal(s[0].art, 'unvollstaendige_bestellung');
    assert.equal(s[0].betragCoin, '0.001000000000');
  });
});

describe('Schutz vor Missbrauch und Fehlern', () => {
  it('Zustimmung, Geraetecode und Zahlungsweg werden geprueft', async () => {
    const { verwaltung: v } = await testShop();
    await assert.rejects(v.erstellen({ geraetecode: GERAET_A }), (e) => e instanceof ShopFehler && e.code === 'zustimmung');
    await assert.rejects(neu(v, { geraetecode: 'ABC' }), (e) => e.code === 'geraetecode');
    await assert.rejects(neu(v, { geraetecode: GERAET_A.slice(0, 33) + 'A' }), (e) => e.code === 'geraetecode');
    await assert.rejects(neu(v, { zahlungsweg: 'btc' }), (e) => e.code === 'zahlungsweg');
  });

  it('globale Ratenbegrenzung', async () => {
    const { verwaltung: v, uhr } = await testShop({ bestellung: { stoss: 3, proStunde: 6 } });
    for (let i = 0; i < 3; i++) await neu(v);
    await assert.rejects(neu(v), (e) => e.code === 'rate');
    uhr.vor(10 * 60_000);
    await neu(v);
  });

  it('Obergrenze reservierter Subadressen (Lookahead/Gap-Limit)', async () => {
    const { verwaltung: v } = await testShop({ bestellung: { maxReservierteAdressen: 2, stoss: 10 } });
    await neu(v);
    await neu(v);
    await assert.rejects(neu(v), (e) => e.code === 'voll');
  });

  it('Kurs nicht ermittelbar oder wallet-rpc weg: keine Bestellung, kein Index verbraucht', async () => {
    const { verwaltung: v, kurse, wallet } = await testShop({ bestellung: { stoss: 1 } });
    kurse.ausfall.add('kraken');
    await assert.rejects(neu(v), (e) => e.code === 'kurs');
    kurse.ausfall.clear();
    wallet.ausfall = true;
    await assert.rejects(neu(v), (e) => e.code === 'netz');
    wallet.ausfall = false;
    assert.equal((await neu(v)).bestellung.index, 1);
  });

  it('parallele Bestellungen erhalten verschiedene Subadressen', async () => {
    const { verwaltung: v } = await testShop({ bestellung: { stoss: 10 } });
    const alle = await Promise.all(Array.from({ length: 6 }, () => neu(v)));
    assert.deepEqual(alle.map((r) => r.bestellung.index).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });
});

describe('Datenhaltung', () => {
  it('Stand wird atomar gespeichert und beim Neustart geladen; doppelte Buchung ausgeschlossen', async () => {
    const s = await testShop();
    const { bestellung: b } = await neu(s.verwaltung);
    s.wallet.zahlung(b.index, BETRAG, { hoehe: s.wallet.hoehe });
    await pruefe(s.verwaltung, b.id);
    await s.verwaltung.speicher.leeren();
    assert.ok(!fs.readdirSync(s.konfig.datenVerzeichnis).some((d) => d.endsWith('.tmp')));
    const v2 = new Bestellverwaltung({ konfig: s.konfig, wege: s.wege, kursdienst: s.kursdienst, buchhaltung: s.buchhaltung, signieren: (d) => lizenzSignieren(TEST_PRIVAT, d), jetzt: s.uhr.jetzt });
    await v2.laden();
    assert.equal(v2.holen(b.id).status, STATUS.BEZAHLT);
    // erneuter Buchungsversuch fuer dieselbe Bestellung bucht nicht doppelt
    await s.buchhaltung.einnahmeBuchen({ bestellung: b.id, lizenz: 'X' });
    assert.equal(s.buchhaltung.lesen('einnahmen').length, 1);
  });

  it('beschaedigte Datendatei verhindert den Start', async () => {
    const s = await testShop();
    const datei = path.join(s.konfig.datenVerzeichnis, 'bestellungen.json');
    fs.writeFileSync(datei, '{"format":2,"bestell');
    const v2 = new Bestellverwaltung({ konfig: s.konfig, wege: s.wege, kursdienst: s.kursdienst, buchhaltung: s.buchhaltung, signieren: () => '' });
    await assert.rejects(v2.laden(), /beschaedigt/);
  });
});

describe('Externer Zahlungsdienst (Schnittstelle, Mock)', () => {
  it('Rechnung anlegen, Zahlung bestaetigen, Gebuehren und Auszahlungen buchen', async () => {
    const extern = new TestZahlungsdienst();
    const { verwaltung: v, buchhaltung, uhr } = await testShop({ zahlungswege: { standard: 'xmr', xmr: { aktiv: true, hauptadresse: undefined }, extern: { aktiv: true, adapter: 'test' } } }, { extern });
    const { bestellung: b } = await neu(v, { zahlungsweg: 'extern' });
    assert.equal(b.art, 'rechnung');
    assert.equal(b.referenz, 'R1');
    assert.equal(b.index, null);
    assert.equal(b.kurs.methode, 'Kurs des Zahlungsdienstes');
    extern.bezahlen('R1', { bestaetigt: false, anteil: 0.5 });
    assert.equal((await pruefe(v, b.id)).status, STATUS.UNTERZAHLT);
    extern.bezahlen('R1');
    const s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.BEZAHLT);
    assert.ok(lizenzOk(s.lizenzen[0].lizenz));
    const e = buchhaltung.lesen('einnahmen')[0];
    assert.equal(e.verwahrung, 'zahlungsdienst');
    assert.equal(e.anbieterReferenz, 'R1');
    const g = buchhaltung.lesen('gebuehren');
    assert.equal(g.length, 1);
    assert.equal(g[0].betragEur, '0.02');
    assert.equal(g[0].dienst, 'Testdienst');
    extern.auszahlungsliste = [{ datum: '2026-10-15', waehrung: 'EUR', betrag: '2.97', betragEur: '2.97', referenz: 'A1' }];
    uhr.vor(2 * STUNDE);
    await v.hintergrundLauf();
    await v.hintergrundLauf();
    const a = buchhaltung.lesen('auszahlungen');
    assert.equal(a.length, 1, 'Auszahlung genau einmal gebucht');
    assert.equal(a[0].betragEur, '2.97');
  });

  it('Benachrichtigung (Webhook) loest nur eine Abfrage aus und braucht eine gueltige Signatur', async () => {
    const extern = new TestZahlungsdienst();
    const { verwaltung: v } = await testShop({ zahlungswege: { standard: 'extern', xmr: { aktiv: false }, extern: { aktiv: true, adapter: 'test' } } }, { extern });
    const { bestellung: b } = await neu(v);
    extern.bezahlen('R1');
    const roh = Buffer.from(JSON.stringify({ referenz: 'R1', status: 'finished' }));
    await assert.rejects(v.benachrichtigung('extern', { 'x-signatur': 'falsch' }, roh), (e) => e.code === 'signatur');
    assert.equal(v.holen(b.id).status, STATUS.OFFEN);
    const crypto = await import('node:crypto');
    const sig = crypto.createHmac('sha256', 'test-geheimnis').update(roh).digest('hex');
    await v.benachrichtigung('extern', { 'x-signatur': sig }, roh);
    assert.equal(v.holen(b.id).status, STATUS.BEZAHLT);
  });
});

describe('Optionaler Zahlungsweg Bitcoin (watch-only zpub)', () => {
  it('BIP84-Adresse, Zahlung ueber mempool.space-Attrappe, Lizenz', async () => {
    const mempool = new FakeMempool();
    const { verwaltung: v, buchhaltung } = await testShop(
      { zahlungswege: { standard: 'xmr', xmr: { aktiv: true, hauptadresse: undefined }, btc: { aktiv: true, zpub: BIP84_TESTVEKTOR_ZPUB } } },
      { mempool },
    );
    void BTC_TESTKONTO;
    const { bestellung: b } = await neu(v, { zahlungsweg: 'btc' });
    assert.equal(b.adresse, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    assert.equal(b.waehrung, 'BTC');
    mempool.zahlung(b.adresse, b.betrag, { hoehe: mempool.hoehe });
    const s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.BEZAHLT);
    assert.equal(buchhaltung.lesen('einnahmen')[0].waehrung, 'BTC');
  });
});

describe('Zahlungsweg voruebergehend nicht bereit', () => {
  it('keine neue Bestellung fuer diesen Weg, Hinweis auf den anderen; danach wieder moeglich', async () => {
    const { verwaltung: v, wege } = await testShop({ zahlungswege: { btc: { aktiv: true, zpub: BIP84_TESTVEKTOR_ZPUB } } });
    wege.xmr.bereit = false;
    await assert.rejects(() => neu(v), (e) => e instanceof ShopFehler && e.code === 'netz' && /Monero ist gerade nicht verfügbar.*mit Bitcoin bezahlen/.test(e.message));
    assert.equal((await neu(v, { zahlungsweg: 'btc' })).bestellung.waehrung, 'BTC');
    wege.xmr.bereit = true;
    assert.equal((await neu(v)).bestellung.waehrung, 'XMR');
  });
});
