// Buchhaltung: Hash-Kette, Rechnungsnummern, Idempotenz, Sperre zwischen Prozessen,
// CSV-Exporte, Jahresuebersicht (FIFO), Storno, verschluesselte Sicherung.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Buchhaltung, ketteVerifizieren, genesis, BuchhaltungsFehler } from '../src/buchhaltung.js';
import { einnahmenCsv, verkaeufeCsv, gebuehrenCsv, jahresuebersicht, jahresuebersichtCsv, csv } from '../src/auswertung.js';
import { sicherungsSchluesselErzeugen, verschluesseln, entschluesseln, packen, auspacken, taeglicheSicherung } from '../src/sicherung.js';
import { tempVerzeichnis, testUhr } from './hilfen.js';

const einnahme = (bh, bestellung, extra = {}) =>
  bh.einnahmeBuchen({
    bestellung,
    lizenz: 'L' + bestellung,
    zahlungsweg: 'xmr',
    anbieter: 'Monero',
    verwahrung: 'eigenes-wallet',
    betragEur: '2.99',
    waehrung: 'XMR',
    betragCoin: '0.006149000000',
    empfangenCoin: '0.006149000000',
    ueberzahlungCoin: '0.000000000000',
    kurs: { eurProCoin: 486.27, quellen: [{ name: 'kraken', wert: 485.23 }, { name: 'coingecko', wert: 487.3 }], abgerufen: '2026-10-15T12:00:00.000Z', methode: 'Median aus 2 Quellen' },
    kursBeiZahlung: null,
    txids: ['aa'.repeat(32)],
    subadresseIndex: 1,
    anbieterReferenz: null,
    umsatzsteuer: { kleinunternehmer: true, satz: 0 },
    ...extra,
  });

function neueBuchhaltung(uhr = testUhr()) {
  const dir = tempVerzeichnis();
  return { bh: new Buchhaltung({ verzeichnis: path.join(dir, 'buchhaltung'), jetzt: uhr.jetzt }), dir, uhr };
}

describe('Hash-Kette', () => {
  it('fortlaufende Rechnungsnummern je Jahr, Kette intakt', async () => {
    const { bh, uhr } = neueBuchhaltung();
    const a = await einnahme(bh, 'B1');
    const b = await einnahme(bh, 'B2');
    assert.equal(a.rechnungsnummer, 'MAL-2026-000001');
    assert.equal(b.rechnungsnummer, 'MAL-2026-000002');
    assert.equal(a.vorherigerHash, genesis('einnahmen'));
    assert.equal(b.vorherigerHash, a.hash);
    uhr.t = Date.UTC(2027, 0, 1, 0, 5);
    assert.equal((await einnahme(bh, 'B3')).rechnungsnummer, 'MAL-2027-000001');
    assert.equal(bh.pruefen().einnahmen.ok, true);
    // idempotent je Bestellung
    const nochmal = await einnahme(bh, 'B1');
    assert.equal(nochmal.rechnungsnummer, 'MAL-2026-000001');
    assert.equal(bh.lesen('einnahmen').length, 3);
  });

  it('erkennt Aenderung, Loeschung und Vertauschung', async () => {
    const { bh } = neueBuchhaltung();
    await einnahme(bh, 'B1');
    await einnahme(bh, 'B2');
    await einnahme(bh, 'B3');
    const datei = bh.datei('einnahmen');
    const zeilen = fs.readFileSync(datei, 'utf8').trim().split('\n');
    const geaendert = zeilen.map((z, i) => (i === 1 ? z.replace('"2.99"', '"0.99"') : z));
    assert.match(ketteVerifizieren('einnahmen', geaendert.map((z) => JSON.parse(z))).fehler, /Eintrag 2: Inhalt veraendert/);
    assert.match(ketteVerifizieren('einnahmen', [zeilen[0], zeilen[2]].map((z) => JSON.parse(z))).fehler, /Eintrag 2/);
    assert.match(ketteVerifizieren('einnahmen', [zeilen[1], zeilen[0], zeilen[2]].map((z) => JSON.parse(z))).fehler, /Eintrag 1/);
    fs.writeFileSync(datei, geaendert.join('\n') + '\n');
    await assert.rejects(bh.initialisieren(), BuchhaltungsFehler);
    await assert.rejects(einnahme(bh, 'B4'), /Inhalt veraendert/);
  });

  it('zwei Instanzen (Dienst und Kommandozeile) schreiben ohne Kettenbruch', async () => {
    const { bh } = neueBuchhaltung();
    const zweite = new Buchhaltung({ verzeichnis: bh.verzeichnis });
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => einnahme(bh, 'X' + i)),
      ...Array.from({ length: 10 }, (_, i) => zweite.verkaufBuchen({ datum: '2026-10-16', waehrung: 'XMR', mengeCoin: '0.001', erloesEur: '0.48', dienst: 'Test', referenz: 'R' + i })),
      ...Array.from({ length: 10 }, (_, i) => einnahme(zweite, 'Y' + i)),
    ]);
    const p = bh.pruefen();
    assert.equal(p.einnahmen.ok, true);
    assert.equal(p.einnahmen.anzahl, 20);
    assert.equal(p.verkaeufe.anzahl, 10);
    const nummern = bh.lesen('einnahmen').map((e) => e.rechnungsnummer);
    assert.equal(new Set(nummern).size, 20);
    assert.equal(nummern.at(-1), 'MAL-2026-000020');
  });

  it('Verkaeufe, Gebuehren, Auszahlungen: Pruefung der Eingaben, Idempotenz ueber Referenz, Storno', async () => {
    const { bh } = neueBuchhaltung();
    await assert.rejects(async () => bh.verkaufBuchen({ datum: '16.10.2026', waehrung: 'XMR', mengeCoin: '1', erloesEur: '1', dienst: 'x' }), /Datum/);
    await assert.rejects(async () => bh.verkaufBuchen({ datum: '2026-10-16', waehrung: 'DOGE', mengeCoin: '1', erloesEur: '1', dienst: 'x' }), /Waehrung/);
    await assert.rejects(async () => bh.verkaufBuchen({ datum: '2026-10-16', waehrung: 'XMR', mengeCoin: '1.0000000000001', erloesEur: '1', dienst: 'x' }), /Nachkommastellen/);
    const v = await bh.verkaufBuchen({ datum: '2026-10-16', waehrung: 'XMR', mengeCoin: '0.5', erloesEur: '240,10', gebuehrEur: '1.2', dienst: 'Haveno', referenz: 'T1' });
    assert.equal(v.mengeCoin, '0.500000000000');
    assert.equal(v.erloesEur, '240.10');
    assert.equal(await bh.verkaufBuchen({ datum: '2026-10-16', waehrung: 'XMR', mengeCoin: '0.5', erloesEur: '240.10', dienst: 'Haveno', referenz: 'T1' }), null);
    await bh.gebuehrBuchen({ datum: '2026-10-16', waehrung: 'XMR', betrag: '0.00003', betragEur: '0.01', dienst: 'Netzwerk' });
    await bh.auszahlungBuchen({ datum: '2026-10-16', waehrung: 'EUR', betrag: '10', betragEur: '10', dienst: 'Dienst', referenz: 'P1' });
    await assert.rejects(bh.stornoBuchen('verkaeufe', 1, ''), /Begruendung/);
    const s = await bh.stornoBuchen('verkaeufe', 1, 'Falscher Betrag');
    assert.equal(s.stornoVon, 1);
    await assert.rejects(bh.stornoBuchen('verkaeufe', 1, 'nochmal'), /bereits storniert/);
    assert.ok(Object.values(bh.pruefen()).every((r) => r.ok));
  });
});

describe('CSV-Exporte und Jahresuebersicht', () => {
  it('CSV: BOM, Semikolon, deutsches Dezimalkomma, Schutz vor Formel-Injektion', async () => {
    const { bh } = neueBuchhaltung();
    await einnahme(bh, 'B1');
    const text = einnahmenCsv(bh.lesen('einnahmen'), 2026);
    assert.ok(text.startsWith('﻿Rechnungsnummer;'));
    const zeile = text.split('\r\n')[1].split(';');
    assert.equal(zeile[0], 'MAL-2026-000001');
    assert.equal(zeile[5], '2,99');
    assert.equal(zeile[7], '0,006149000000');
    assert.equal(zeile[10], '486,27');
    assert.match(zeile[11], /Median aus 2 Quellen: kraken=485.23, coingecko=487.3/);
    assert.equal(einnahmenCsv(bh.lesen('einnahmen'), 2025).split('\r\n').length, 2);
    assert.equal(csv(['a'], [['=HYPERLINK("x")'], ['a;b'], ['-5'], ['@SUM']]), '﻿a\r\n"\'=HYPERLINK(""x"")"\r\n"a;b"\r\n-5\r\n\'@SUM\r\n');
  });

  it('Jahresuebersicht: Einnahmen, FIFO-Buchwert, Veraeusserungsergebnis, Bestand, Gewinn', async () => {
    const { bh, uhr } = neueBuchhaltung();
    // zwei Verkaeufe a 2,99 EUR, je 0,006 XMR
    await einnahme(bh, 'B1', { empfangenCoin: '0.006000000000' });
    await einnahme(bh, 'B2', { empfangenCoin: '0.006000000000' });
    // ueber Zahlungsdienst (nicht im eigenen Wallet)
    await einnahme(bh, 'B3', { verwahrung: 'zahlungsdienst', empfangenCoin: '0.006000000000' });
    uhr.vor(86_400_000);
    // 0,009 XMR verkauft fuer 5,00 EUR, Gebuehr 0,10 EUR
    await bh.verkaufBuchen({ datum: '2026-10-16', waehrung: 'XMR', mengeCoin: '0.009', erloesEur: '5.00', gebuehrEur: '0.10', dienst: 'Test', referenz: 'V1' });
    // Netzwerkgebuehr in XMR (Buchwert-Abgang) und eine EUR-Gebuehr
    await bh.gebuehrBuchen({ datum: '2026-10-16', waehrung: 'XMR', betrag: '0.0001', betragEur: '0.05', dienst: 'Netzwerk' });
    await bh.gebuehrBuchen({ datum: '2026-10-16', waehrung: 'EUR', betrag: '1.00', betragEur: '1.00', dienst: 'Server' });
    await bh.auszahlungBuchen({ datum: '2026-10-17', waehrung: 'EUR', betrag: '2.97', betragEur: '2.97', dienst: 'Dienst', referenz: 'P1' });
    const j = Object.fromEntries(['einnahmen', 'verkaeufe', 'gebuehren', 'auszahlungen', 'sonstige'].map((n) => [n, bh.lesen(n)]));
    const u = jahresuebersicht(j, 2026, { XMR: '500.00' });
    assert.equal(u.anzahlLizenzen, 3);
    assert.equal(u.einnahmenEur, '8.97');
    assert.equal(u.einnahmenEigenesWalletEur, '5.98');
    assert.equal(u.einnahmenZahlungsdienstEur, '2.99');
    assert.equal(u.zugangCoin.XMR, '0.012000000000');
    // FIFO: 0,006 (2,99) + 0,003 von 0,006 (1,495 -> 1,50) = 4,49
    assert.equal(u.verkaufBuchwertEur, '4.49');
    assert.equal(u.veraeusserungsergebnisEur, '0.51');
    // Gewinn = 8,97 + 0,51 - 0,10 (Verkaufsgebuehr) - 1,00 (EUR-Gebuehr) - Buchwert 0,0001 XMR (0,05)
    assert.equal(u.gewinnVereinfachtEur, '8.33');
    assert.equal(u.bestandJahresende.XMR.menge, '0.002900000000');
    assert.equal(u.bestandJahresende.XMR.buchwertEur, '1.44');
    assert.equal(u.bestandJahresende.XMR.marktwertEur, '1.45');
    assert.equal(u.auszahlungenZahlungsdienstEur, '2.97');
    assert.deepEqual(u.fehlbestandCoin, {});
    const text = jahresuebersichtCsv(u);
    assert.match(text, /Gewinn vereinfacht EUR;8,33/);
    assert.match(text, /Bestand XMR Jahresende;0,002900000000/);
    // Storno nimmt den Verkauf aus der Rechnung
    await bh.stornoBuchen('verkaeufe', 1, 'Test');
    const u2 = jahresuebersicht(Object.fromEntries(['einnahmen', 'verkaeufe', 'gebuehren', 'auszahlungen', 'sonstige'].map((n) => [n, bh.lesen(n)])), 2026);
    assert.equal(u2.verkaufErloesEur, '0.00');
    assert.match(verkaeufeCsv(bh.lesen('verkaeufe'), 2026), /^﻿Lfd\. Nr\.;[^\r]*\r\n$/);
    assert.match(gebuehrenCsv(bh.lesen('gebuehren'), 2026), /Netzwerk/);
  });

  it('meldet Fehlbestand, wenn mehr verkauft als erfasst wurde', async () => {
    const { bh } = neueBuchhaltung();
    await einnahme(bh, 'B1', { empfangenCoin: '0.006000000000' });
    await bh.verkaufBuchen({ datum: '2026-10-16', waehrung: 'XMR', mengeCoin: '0.01', erloesEur: '5', dienst: 'Test' });
    const u = jahresuebersicht({ einnahmen: bh.lesen('einnahmen'), verkaeufe: bh.lesen('verkaeufe') }, 2026);
    assert.equal(u.fehlbestandCoin.XMR, '0.004000000000');
  });
});

describe('Verschluesselte Sicherung', () => {
  it('nur mit dem privaten Schluessel lesbar; Manipulation wird erkannt', () => {
    const { privatPem, oeffentlich } = sicherungsSchluesselErzeugen();
    const daten = Buffer.from('geheime Buchhaltung');
    const chiffrat = verschluesseln(daten, oeffentlich);
    assert.ok(!chiffrat.includes(daten));
    assert.equal(entschluesseln(chiffrat, privatPem).toString(), 'geheime Buchhaltung');
    const kaputt = Buffer.from(chiffrat);
    kaputt[kaputt.length - 1] ^= 1;
    assert.throws(() => entschluesseln(kaputt, privatPem));
    assert.throws(() => entschluesseln(chiffrat, sicherungsSchluesselErzeugen().privatPem));
  });

  it('taegliche Sicherung enthaelt Bestellungen und Journale, alte werden aufgeraeumt', async () => {
    const { bh, dir } = neueBuchhaltung();
    await einnahme(bh, 'B1');
    fs.writeFileSync(path.join(dir, 'bestellungen.json'), '{"format":2}');
    const { privatPem, oeffentlich } = sicherungsSchluesselErzeugen();
    const ziel = path.join(dir, 'sicherungen');
    let t = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 4; i++, t += 86_400_000) {
      assert.ok(await taeglicheSicherung({ datenVerzeichnis: dir, zielVerzeichnis: ziel, empfaenger: oeffentlich, behalten: 3, jetzt: t }));
    }
    assert.equal(await taeglicheSicherung({ datenVerzeichnis: dir, zielVerzeichnis: ziel, empfaenger: oeffentlich, jetzt: t - 86_400_000 }), null);
    const dateien = fs.readdirSync(ziel).sort();
    assert.deepEqual(dateien, ['malachi-sicherung-2026-10-02.bin', 'malachi-sicherung-2026-10-03.bin', 'malachi-sicherung-2026-10-04.bin']);
    const inhalt = auspacken(entschluesseln(fs.readFileSync(path.join(ziel, dateien[2])), privatPem));
    assert.equal(Buffer.from(inhalt.dateien['bestellungen.json'], 'base64').toString(), '{"format":2}');
    assert.ok(Buffer.from(inhalt.dateien['buchhaltung/einnahmen.jsonl'], 'base64').toString().includes('MAL-2026-000001'));
    assert.ok(auspacken(packen(dir, ['gibtsnicht.json'])).dateien);
  });
});
