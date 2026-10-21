// Widerruf ("Vertrag widerrufen", § 356a BGB): bis zur Bereitstellung der
// Lizenz moeglich; danach eingehende Zahlungen werden erfasst, aber NIE in eine
// Lizenz umgewandelt; Rueckzahlungsadressen werden mit Pruefsumme geprueft;
// Aufraeumen erst nach Ende der Reservierung bzw. nach gebuchter Rueckzahlung.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, ShopFehler, WIDERRUFSFRIST_MS } from '../src/bestellungen.js';
import { istMoneroAdresse, istBitcoinAdresse, moneroAdressArt, rueckzahlAdresseGueltig } from '../src/rueckzahlung.js';
import { testShop, STUNDE, GERAET_A, FakeMempool } from './hilfen.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';

const BETRAG = 6_149_000_000;
// Testvektoren: Monero General Fund (oeffentlich) sowie aus gueltigen Kurvenpunkten
// erzeugte Standard-/Sub-/integrierte Adressen - alle vier von monero-wallet-rpc
// v0.18.5.4 (validate_address) als gueltig bestaetigt.
const XMR = {
  standard: '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A',
  standard2: '4AW4ki8RKpM2oFSbgYs2xCikGbeiLCjpeRTtY9DL2m2H8XSsi6RBZDYGHeAYabCowvdPhr9DJ9F3AQtj6k172E6y3mA33mH',
  sub: '8BLD65nFvEm2oFSbgYs2xCikGbeiLCjpeRTtY9DL2m2H8XSsi6RBZDYGHeAYabCowvdPhr9DJ9F3AQtj6k172E6y3nUq6vG',
  integriert: '4LCjmWwuw5s2oFSbgYs2xCikGbeiLCjpeRTtY9DL2m2H8XSsi6RBZDYGHeAYabCowvdPhr9DJ9F3AQtj6k172E6y51sMpMDNd421xNKRYu',
};

const neu = (v, extra = {}) => v.erstellen({ geraetecode: GERAET_A, zustimmung: true, ...extra });
const pruefe = (v, id) => v.aktualisieren(id, { mindestAbstandMs: 0 });

describe('Rueckzahlungsadressen (offline, mit Pruefsumme)', () => {
  it('Monero: Standard, Subadresse, integriert - Tippfehler fallen auf', () => {
    assert.equal(moneroAdressArt(XMR.standard), 'standard');
    assert.equal(moneroAdressArt(XMR.standard2), 'standard');
    assert.equal(moneroAdressArt(XMR.sub), 'subadresse');
    assert.equal(moneroAdressArt(XMR.integriert), 'integriert');
    assert.equal(istMoneroAdresse(XMR.standard2.slice(0, -1) + 'J'), false, 'ein Zeichen anders');
    assert.equal(istMoneroAdresse(XMR.standard.slice(0, 94)), false, 'zu kurz');
    assert.equal(istMoneroAdresse('9' + XMR.standard.slice(1)), false, 'falsches Netz/Praefix');
    assert.equal(istMoneroAdresse(XMR.standard.replace('A', '0')), false, '0 gibt es in Base58 nicht');
  });

  it('Bitcoin: P2PKH, P2SH, SegWit v0, Taproot - Mainnet, mit Pruefsumme', () => {
    for (const a of [
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
      'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    ]) assert.equal(istBitcoinAdresse(a), true, a);
    for (const a of [
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', // Pruefsumme
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', // Testnet
      'bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', // gemischte Schreibweise
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb',         // Base58-Pruefsumme
      'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',         // Testnet P2PKH
    ]) assert.equal(istBitcoinAdresse(a), false, a);
  });

  it('Adresse passend zur Waehrung der Bestellung', () => {
    assert.equal(rueckzahlAdresseGueltig('XMR', XMR.sub), true);
    assert.equal(rueckzahlAdresseGueltig('BTC', XMR.sub), false);
    assert.equal(rueckzahlAdresseGueltig('BTC', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), true);
    assert.equal(rueckzahlAdresseGueltig('EUR', XMR.sub), false);
  });
});

describe('Widerruf einer Bestellung', () => {
  it('offene Bestellung: Vorschau aendert nichts, Bestaetigung widerruft; QR/Zahlung danach weg', async () => {
    const { verwaltung: v } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    const vorschau = await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, nurPruefen: true });
    assert.equal(vorschau.bestellung.status, STATUS.OFFEN);
    const r = await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, name: '  Max\n Muster ', quelle: 'app' });
    assert.equal(r.neu, true);
    assert.equal(r.bestellung.status, STATUS.WIDERRUFEN);
    assert.equal(r.bestellung.widerruf.name, 'Max Muster');
    assert.equal(r.bestellung.widerruf.quelle, 'app');
    assert.equal(r.bestellung.widerruf.statusVorher, STATUS.OFFEN);
    assert.equal(r.bestellung.widerruf.empfangenBeiWiderruf, 0);
    assert.equal(r.bestellung.widerruf.rueckzahlAdresse, null);
  });

  it('falscher Code: abgelehnt und gezaehlt (Sperre nach 5 Versuchen)', async () => {
    const { verwaltung: v } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: 'A'.repeat(20) }), (e) => e.code === 'code');
    }
    await assert.rejects(() => v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code }), (e) => e.code === 'gesperrt');
    assert.equal(v.holen(b.id).status, STATUS.OFFEN);
    await assert.rejects(() => v.widerrufen({ bestellnummer: 'ZZZZZZZZZZZZZZZZ', wiederherstellungscode: code }), (e) => e.code === 'code');
  });

  it('ungueltige Rueckzahlungsadresse wird abgelehnt, gueltige gespeichert und spaeter aenderbar', async () => {
    const { verwaltung: v } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    await assert.rejects(
      () => v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.sub.slice(0, -1) + 'x' }),
      (e) => e instanceof ShopFehler && e.code === 'rueckzahlung',
    );
    assert.equal(v.holen(b.id).status, STATUS.OFFEN, 'nichts geaendert');
    await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.sub });
    const zeit = v.holen(b.id).widerruf.zeit;
    const r = await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.standard });
    assert.equal(r.neu, false);
    assert.equal(r.bestellung.widerruf.rueckzahlAdresse, XMR.standard);
    assert.equal(r.bestellung.widerruf.zeit, zeit, 'Zeitpunkt der Erklaerung bleibt');
  });

  it('Zahlung NACH dem Widerruf: erfasst, aber keine Lizenz und keine Einnahme', async () => {
    const { verwaltung: v, wallet, buchhaltung } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code });
    wallet.zahlung(b.index, BETRAG, { hoehe: wallet.hoehe });
    const s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.WIDERRUFEN);
    assert.equal(s.empfangen, BETRAG);
    assert.equal(s.lizenzen.length, 0);
    assert.equal(buchhaltung.lesen('einnahmen').length, 0);
    assert.equal(v.offeneErstattungen().length, 1);
  });

  it('Teilzahlung vor dem Widerruf wird festgehalten', async () => {
    const { verwaltung: v, wallet } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    wallet.zahlung(b.index, 1_000_000_000, { hoehe: wallet.hoehe });
    await pruefe(v, b.id);
    const r = await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.sub });
    assert.equal(r.bestellung.widerruf.statusVorher, STATUS.UNTERZAHLT);
    assert.equal(r.bestellung.widerruf.empfangenBeiWiderruf, 1_000_000_000);
  });

  it('bezahlt mit Zustimmung: Widerrufsrecht erloschen, nichts geaendert', async () => {
    const { verwaltung: v, wallet } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    wallet.zahlung(b.index, BETRAG, { hoehe: wallet.hoehe });
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
    await assert.rejects(() => v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code }), (e) => e.code === 'erloschen' && /erloschen/.test(e.message));
    assert.equal(v.holen(b.id).status, STATUS.BEZAHLT);
  });

  it('bezahlt OHNE Zustimmung (Konfiguration): innerhalb von 14 Tagen widerrufbar, danach nicht', async () => {
    const { verwaltung: v, wallet, uhr } = await testShop({ widerrufsZustimmungErforderlich: false });
    const { bestellung: a, wiederherstellungscode: ca } = await v.erstellen({ geraetecode: GERAET_A });
    const { bestellung: b, wiederherstellungscode: cb } = await v.erstellen({ geraetecode: GERAET_A });
    for (const x of [a, b]) wallet.zahlung(x.index, BETRAG, { hoehe: wallet.hoehe });
    await pruefe(v, a.id);
    await pruefe(v, b.id);
    const r = await v.widerrufen({ bestellnummer: a.id, wiederherstellungscode: ca });
    assert.equal(r.bestellung.widerruf.lizenzAusgestellt, true);
    uhr.vor(WIDERRUFSFRIST_MS + 1);
    await assert.rejects(() => v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: cb }), (e) => e.code === 'erloschen');
  });

  it('gleichzeitige Zahlungspruefung und Widerruf: nie Lizenz UND Widerruf', async () => {
    const { verwaltung: v, wallet } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    wallet.zahlung(b.index, BETRAG, { hoehe: wallet.hoehe });
    const pruefung = pruefe(v, b.id);            // laeuft (bezahlt -> Lizenz)
    const widerruf = v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code }).then(() => 'widerrufen', (e) => e.code);
    await pruefung;
    const ergebnis = await widerruf;
    const s = v.holen(b.id);
    if (ergebnis === 'widerrufen') {
      assert.equal(s.status, STATUS.WIDERRUFEN);
      assert.equal(s.lizenzen.length, 0);
    } else {
      assert.equal(ergebnis, 'erloschen');
      assert.equal(s.status, STATUS.BEZAHLT);
    }
    assert.equal(ergebnis, 'erloschen', 'die laufende Pruefung wird abgewartet - sie hat schon bezahlt');
  });

  it('Bitcoin: Rueckzahlungsadresse muss eine Bitcoin-Adresse sein', async () => {
    const mempool = new FakeMempool();
    const { verwaltung: v } = await testShop({ zahlungswege: { btc: { aktiv: true, zpub: BIP84_TESTVEKTOR_ZPUB } } }, { mempool });
    const { bestellung: b, wiederherstellungscode: code } = await neu(v, { zahlungsweg: 'btc' });
    await assert.rejects(() => v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.sub }), (e) => e.code === 'rueckzahlung');
    const r = await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    assert.equal(r.bestellung.status, STATUS.WIDERRUFEN);
  });
});

describe('Aufraeumen widerrufener Bestellungen', () => {
  it('ohne Zahlung: nach Reservierung + letzter Pruefung geloescht, Subadresse wieder frei', async () => {
    const { verwaltung: v, uhr } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code });
    uhr.vor(71 * STUNDE);
    await v.hintergrundLauf();
    assert.equal(v.holen(b.id).status, STATUS.WIDERRUFEN, 'Reservierung laeuft noch');
    uhr.vor(2 * STUNDE);
    await v.hintergrundLauf();
    assert.equal(v.holen(b.id), null);
    assert.deepEqual(v.daten.zaehler.xmr.freie, [b.index]);
  });

  it('mit Zahlung: bleibt (mit Rueckzahlungsadresse), bis die Rueckzahlung gebucht ist', async () => {
    const { verwaltung: v, wallet, uhr, buchhaltung } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    wallet.zahlung(b.index, BETRAG, { hoehe: null });
    await pruefe(v, b.id);
    await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.sub });
    uhr.vor(30 * 24 * STUNDE);
    await v.hintergrundLauf();
    assert.equal(v.holen(b.id).status, STATUS.WIDERRUFEN);
    assert.equal(v.offeneErstattungen().length, 1);
    await buchhaltung.sonstigesBuchen({ art: 'erstattung', bestellung: b.id, waehrung: 'XMR', betragCoin: '0.006149', txids: ['ab'.repeat(32)], notiz: 'Rueckzahlung' });
    assert.equal(v.offeneErstattungen().length, 0);
    await v.hintergrundLauf();
    assert.equal(v.holen(b.id), null);
    assert.ok(!v.daten.zaehler.xmr.freie.includes(b.index), 'Adresse mit Eingang wird nie wieder vergeben');
  });
});

describe('Betreiber-Werkzeug widerrufe.js', () => {
  it('liste zeigt offene Rueckzahlung samt Adresse; erstattet bucht, danach raeumt der Shop auf', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const werkzeug = fileURLToPath(new URL('../src/werkzeuge/widerrufe.js', import.meta.url));
    const { verwaltung: v, wallet, uhr, konfig } = await testShop();
    const { bestellung: b, wiederherstellungscode: code } = await neu(v);
    wallet.zahlung(b.index, BETRAG, { hoehe: wallet.hoehe });
    await v.widerrufen({ bestellnummer: b.id, wiederherstellungscode: code, rueckzahlAdresse: XMR.sub });
    await pruefe(v, b.id);
    await v.speicher.leeren?.();
    const lauf = (...a) => spawnSync(process.execPath, [werkzeug, ...a, '--daten', konfig.datenVerzeichnis], { encoding: 'utf8' });

    let r = lauf('liste');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RUECKZAHLUNG OFFEN: 0\.006149000000 XMR/);
    assert.ok(r.stdout.includes(XMR.sub));

    r = lauf('erstattet', '--bestellung', b.id, '--menge', '0.006149', '--txid', 'ab'.repeat(32));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Gebucht/);
    assert.match(lauf('erstattet', '--bestellung', b.id, '--menge', '0.006149', '--txid', 'ab'.repeat(32)).stdout, /Bereits gebucht/);
    assert.equal(lauf('erstattet', '--bestellung', b.id, '--menge', 'viel', '--txid', 'ab'.repeat(32)).status, 1);

    assert.equal(v.offeneErstattungen().length, 0);
    uhr.vor(73 * STUNDE);
    await v.hintergrundLauf();
    assert.equal(v.holen(b.id), null, 'nach Rueckzahlung und Reservierungsende geloescht');
  });
});
