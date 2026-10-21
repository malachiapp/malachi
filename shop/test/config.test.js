import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruefeKonfiguration, ladeKonfiguration, KonfigFehler, BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';
import { tempVerzeichnis, TEST_HAUPTADRESSE } from './hilfen.js';

const BEISPIEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.example.json');
const beispiel = () => {
  const roh = JSON.parse(fs.readFileSync(BEISPIEL, 'utf8'));
  roh.zahlungswege.xmr.hauptadresse = TEST_HAUPTADRESSE;
  return roh;
};

const fehlerMit = (roh, muster, optionen = { erlaubeTestwerte: true }) => {
  assert.throws(
    () => pruefeKonfiguration(roh, optionen),
    (e) => e instanceof KonfigFehler && e.fehler.some((f) => muster.test(f)),
  );
};

describe('Konfiguration', () => {
  it('config.example.json ist mit eingetragener Hauptadresse gueltig', () => {
    const { konfig } = pruefeKonfiguration(beispiel(), { basisVerzeichnis: '/x' });
    assert.equal(konfig.preisEur, 2.99);
    assert.equal(konfig.mindestBestaetigungen, 1);
    assert.equal(konfig.server.host, '127.0.0.1');
    assert.equal(konfig.zahlungswege.standard, 'xmr');
    assert.equal(konfig.zahlungswege.btc.aktiv, false);
    assert.equal(konfig.lizenz.maxAktivierungen, 3);
    assert.deepEqual(konfig.lizenz.features, ['pro']);
    assert.equal(konfig.lizenz.schluesselDatei, 'credential:lizenz-schluessel');
    assert.equal(konfig.verkauf.modus, 'manuell');
    assert.equal(konfig.kurs.quellen.XMR.length, 2);
    assert.ok(konfig.texte.hinweise.length > 3, 'Standardhinweise');
  });

  it('der Platzhalter fuer die Monero-Hauptadresse wird abgewiesen', () => {
    const roh = JSON.parse(fs.readFileSync(BEISPIEL, 'utf8'));
    fehlerMit(roh, /xmr\.hauptadresse/);
  });

  it('meldet unbekannte Schluessel, ignoriert Kommentare mit _', () => {
    const roh = beispiel();
    roh.preisEUR = 5;
    fehlerMit(roh, /preisEUR: unbekannter Schluessel/);
    const ok = beispiel();
    ok._notiz = 'x';
    ok.zahlungswege.xmr._notiz = 'x';
    pruefeKonfiguration(ok);
  });

  it('Sicherheitsregeln: nur Loopback, wallet-rpc nur lokal, mind. zwei Kursquellen', () => {
    let roh = beispiel();
    roh.server.host = '0.0.0.0';
    fehlerMit(roh, /server\.host/);
    roh = beispiel();
    roh.zahlungswege.xmr.walletRpcUrl = 'http://node.example.com:18082/json_rpc';
    fehlerMit(roh, /walletRpcUrl/);
    roh = beispiel();
    roh.kurs.quellen.XMR = roh.kurs.quellen.XMR.slice(0, 1);
    fehlerMit(roh, /mindestens 2 Quellen/);
    roh = beispiel();
    roh.kurs.quellen.XMR[0].url = 'http://unsicher.example.com/kurs';
    fehlerMit(roh, /kurs\.quellen\.XMR\[0\]/);
    roh = beispiel();
    roh.zahlungswege.xmr.ersatzKnoten = ['node.example.com:18089'];
    fehlerMit(roh, /ersatzKnoten/);
    roh = beispiel();
    roh.zahlungswege.xmr.ersatzKnoten = ['b'.repeat(56) + '.onion:18089'];
    assert.deepEqual(pruefeKonfiguration(roh, { erlaubeTestwerte: true }).konfig.zahlungswege.xmr.ersatzKnoten, ['b'.repeat(56) + '.onion:18089']);
  });

  it('Zahlungswege: Standard muss aktiv sein, Bitcoin-zpub wird geprueft', () => {
    let roh = beispiel();
    roh.zahlungswege.standard = 'btc';
    fehlerMit(roh, /standard/);
    roh = beispiel();
    roh.zahlungswege.btc.aktiv = true;
    roh.zahlungswege.btc.zpub = 'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE';
    fehlerMit(roh, /PRIVATER/);
    roh.zahlungswege.btc.zpub = BIP84_TESTVEKTOR_ZPUB;
    fehlerMit(roh, /Testvektor/, {});
    const { btcKonto } = pruefeKonfiguration(roh, { erlaubeTestwerte: true });
    assert.equal(btcKonto.art, 'zpub');
    roh = beispiel();
    roh.zahlungswege.xmr.aktiv = false;
    fehlerMit(roh, /mindestens ein Zahlungsweg/);
  });

  it('Monero und Bitcoin gleichzeitig; Gap-Limit und BTC-Kursquellen werden geprueft', () => {
    let roh = beispiel();
    roh.zahlungswege.btc.aktiv = true;
    roh.zahlungswege.btc.zpub = BIP84_TESTVEKTOR_ZPUB;
    const { konfig, btcKonto } = pruefeKonfiguration(roh, { erlaubeTestwerte: true });
    assert.equal(konfig.zahlungswege.xmr.aktiv, true);
    assert.equal(konfig.zahlungswege.btc.gapLimit, 20, 'Standard wie Sparrow/Electrum');
    assert.equal(konfig.zahlungswege.btc.startIndex, 0);
    assert.ok(btcKonto);
    roh.zahlungswege.btc.gapLimit = 1;
    fehlerMit(roh, /btc\.gapLimit/);
    roh.zahlungswege.btc.gapLimit = 200;
    assert.equal(pruefeKonfiguration(roh, { erlaubeTestwerte: true }).konfig.zahlungswege.btc.gapLimit, 200);
    roh = beispiel();
    roh.zahlungswege.btc.aktiv = true;
    roh.zahlungswege.btc.zpub = BIP84_TESTVEKTOR_ZPUB;
    roh.kurs.quellen.BTC = roh.kurs.quellen.BTC.slice(0, 1);
    fehlerMit(roh, /kurs\.quellen\.BTC: mindestens 2 Quellen/);
    roh = beispiel();
    roh.zahlungswege.btc.aktiv = true;
    roh.zahlungswege.btc.zpub = BIP84_TESTVEKTOR_ZPUB;
    roh.zahlungswege.btc.mempoolOnion = 'https://mempool.space';
    fehlerMit(roh, /mempoolOnion/);
  });

  it('Wertebereiche und Formate', () => {
    let roh = beispiel();
    delete roh.preisEur;
    fehlerMit(roh, /preisEur: Angabe fehlt/);
    roh = beispiel();
    roh.mindestBestaetigungen = 0;
    fehlerMit(roh, /mindestBestaetigungen/);
    roh = beispiel();
    roh.lizenz.features = ['pro', 'basis'];
    fehlerMit(roh, /lizenz\.features/);
    roh = beispiel();
    roh.verkauf.modus = 'binance';
    fehlerMit(roh, /verkauf\.modus/);
    roh = beispiel();
    roh.verkauf.kraken.schwellenwert = '1e-3';
    fehlerMit(roh, /schwellenwert/);
    roh = beispiel();
    roh.buchhaltung.sicherungSchluessel = 'kurz';
    fehlerMit(roh, /sicherungSchluessel/);
    roh = beispiel();
    roh.bestellung.adresseReserviertStunden = 1;
    fehlerMit(roh, /adresseReserviertStunden/);
  });

  it('loest relative Pfade auf, credential:-Angaben bleiben', () => {
    const roh = beispiel();
    roh.lizenz.schluesselDatei = 'geheim/lizenz.pem';
    roh.datenVerzeichnis = 'daten';
    const { konfig } = pruefeKonfiguration(roh, { basisVerzeichnis: path.resolve('/srv/shop') });
    assert.equal(konfig.lizenz.schluesselDatei, path.resolve('/srv/shop/geheim/lizenz.pem'));
    assert.equal(konfig.datenVerzeichnis, path.resolve('/srv/shop/daten'));
    assert.equal(konfig.zahlungswege.xmr.walletRpcLogin, 'credential:wallet-rpc-login');
  });

  it('ladeKonfiguration meldet fehlende Datei und kaputtes JSON verstaendlich', () => {
    const dir = tempVerzeichnis();
    assert.throws(() => ladeKonfiguration(path.join(dir, 'fehlt.json')), /nicht lesbar/);
    fs.writeFileSync(path.join(dir, 'kaputt.json'), '{ "preisEur": ');
    assert.throws(() => ladeKonfiguration(path.join(dir, 'kaputt.json')), /kein gueltiges JSON/);
    fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(beispiel()));
    assert.equal(ladeKonfiguration(path.join(dir, 'ok.json')).konfig.preisEur, 2.99);
  });
});
