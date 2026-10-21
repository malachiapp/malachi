// Gemeinsame Test-Hilfen: Konfiguration, kuenstliche Uhr, Attrappen fuer
// monero-wallet-rpc, Kursquellen, mempool.space und einen externen Zahlungsdienst.
// Es werden ausschliesslich oeffentliche Testschluessel verwendet.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pruefeKonfiguration } from '../src/config.js';
import { TESTSCHLUESSEL, privatAusSeed, lizenzSignieren } from '../src/lizenz.js';
import { geraetecodeAusSpki } from '../src/lizenzpruefer.js';
import { Kursdienst } from '../src/kurs.js';
import { MoneroZahlungsweg } from '../src/zahlung/monero.js';
import { BitcoinZahlungsweg } from '../src/zahlung/bitcoin.js';
import { MempoolApi } from '../src/mempool.js';
import { Buchhaltung } from '../src/buchhaltung.js';
import { Bestellverwaltung } from '../src/bestellungen.js';
import { ladeKontoSchluessel } from '../src/bip84.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';

export const STUNDE = 3_600_000;
export const TAG = 24 * STUNDE;
export const ONION = 'http://' + 'a'.repeat(56) + '.onion';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Formal gueltig aussehende (aber erfundene) Monero-Adresse - nur fuer Tests. */
export function testAdresse(praefix, saat) {
  const h = crypto.createHash('sha512').update(String(saat)).digest();
  let s = praefix;
  for (let i = 0; s.length < 95; i++) s += B58[h[i % h.length] % 58];
  return s;
}
export const TEST_HAUPTADRESSE = testAdresse('4', 'hauptadresse');

// Testvektoren aus LIZENZ_FORMAT.md (P-256-Testschluessel aus RFC 6979 bzw. Skalar 1)
export const GERAET_A = 'LJ5HRTFEUD2CBWN4MK5WNHB4E5M6HH3SE3';
export const GERAET_B = 'LTJFF6YM5CJSINX27DGNCBAJQG4J5ZFNLQ';
export const zufallsGeraet = () => geraetecodeAusSpki(new Uint8Array(crypto.randomBytes(91)));

export const TEST_PRIVAT = privatAusSeed(TESTSCHLUESSEL.privatSeedHex);
export const TEST_OEFFENTLICH = Uint8Array.from(Buffer.from(TESTSCHLUESSEL.oeffentlichHex, 'hex'));

export function tempVerzeichnis() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'malachi-shop-test-'));
}

export function testSchluesselDatei(verzeichnis) {
  const datei = path.join(verzeichnis, 'lizenz-test.pem');
  fs.writeFileSync(datei, TEST_PRIVAT.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return datei;
}

export function testKonfig(verzeichnis, ueberschreiben = {}) {
  const basis = {
    preisEur: 2.99,
    datenVerzeichnis: path.join(verzeichnis, 'daten'),
    lizenz: { schluesselDatei: path.join(verzeichnis, 'lizenz-test.pem') },
    zahlungswege: { xmr: { aktiv: true, hauptadresse: TEST_HAUPTADRESSE } },
  };
  // Tiefes Zusammenfuehren; undefined-Werte werden ignoriert.
  const mischen = (a, b) => {
    const aus = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      const objekt = (x) => x && typeof x === 'object' && !Array.isArray(x);
      aus[k] = objekt(v) && objekt(a[k]) ? mischen(a[k], v) : v;
    }
    return aus;
  };
  const roh = mischen(basis, ueberschreiben);
  const { konfig, btcKonto } = pruefeKonfiguration(roh, { basisVerzeichnis: verzeichnis, erlaubeTestwerte: true });
  fs.mkdirSync(konfig.datenVerzeichnis, { recursive: true });
  return { konfig, btcKonto };
}

export function testUhr(start = Date.UTC(2026, 9, 15, 12, 0, 0)) {
  const uhr = {
    t: start,
    jetzt: () => uhr.t,
    vor(ms) {
      uhr.t += ms;
    },
  };
  return uhr;
}

/** Attrappe fuer monero-wallet-rpc (JSON-RPC-Methoden des View-only-Wallets). */
export class FakeWallet {
  constructor(hauptadresse = TEST_HAUPTADRESSE) {
    this.hauptadresse = hauptadresse;
    this.adressen = [hauptadresse];
    this.transfers = []; // { index, amount, txid, hoehe|null, unlock_time, double_spend_seen }
    this.hoehe = 3_500_000;
    this.viewOnly = true;
    this.ausfall = false;
    this.aufrufe = [];
  }

  zahlung(index, amount, { hoehe = null, unlock_time = 0, double_spend_seen = false } = {}) {
    const t = { index, amount, txid: crypto.randomBytes(32).toString('hex'), hoehe, unlock_time, double_spend_seen };
    this.transfers.push(t);
    return t;
  }

  bestaetigen(t, hoehe = this.hoehe) {
    t.hoehe = hoehe;
  }

  _eintrag(t) {
    return {
      address: this.adressen[t.index],
      amount: t.amount,
      amounts: [t.amount],
      confirmations: t.hoehe === null ? 0 : this.hoehe - t.hoehe + 1,
      double_spend_seen: t.double_spend_seen,
      fee: 30_000_000,
      height: t.hoehe ?? 0,
      locked: true,
      payment_id: '0000000000000000',
      subaddr_index: { major: 0, minor: t.index },
      subaddr_indices: [{ major: 0, minor: t.index }],
      timestamp: 1_790_000_000,
      txid: t.txid,
      type: t.hoehe === null ? 'pool' : 'in',
      unlock_time: t.unlock_time,
    };
  }

  rpc = async (methode, params = {}) => {
    this.aufrufe.push(methode);
    if (this.ausfall) throw new Error('wallet-rpc nicht erreichbar: ECONNREFUSED');
    switch (methode) {
      case 'get_address': {
        const liste = (params.address_index || this.adressen.map((_, i) => i))
          .filter((i) => i < this.adressen.length)
          .map((i) => ({ address: this.adressen[i], address_index: i, label: '', used: this.transfers.some((t) => t.index === i) }));
        return { address: this.hauptadresse, addresses: liste };
      }
      case 'create_address': {
        const index = this.adressen.length;
        this.adressen.push(testAdresse('8', 'sub' + index));
        return { address: this.adressen[index], address_index: index, address_indices: [index], addresses: [this.adressen[index]] };
      }
      case 'get_transfers': {
        const idx = params.subaddr_indices && params.subaddr_indices.length ? params.subaddr_indices : null;
        const passend = this.transfers.filter((t) => !idx || idx.includes(t.index));
        const r = {};
        const ein = passend.filter((t) => t.hoehe !== null).map((t) => this._eintrag(t));
        const pool = passend.filter((t) => t.hoehe === null).map((t) => this._eintrag(t));
        if (params.in && ein.length) r.in = ein;
        if (params.pool && pool.length) r.pool = pool;
        return r;
      }
      case 'get_height':
        return { height: this.hoehe };
      case 'query_key':
        if (this.viewOnly) throw Object.assign(new Error('The wallet is watch-only. Cannot retrieve spend key.'), { code: -29 });
        return { key: 'ab'.repeat(32) };
      default:
        throw new Error('Unbekannte Methode ' + methode);
    }
  };
}

/** Attrappe fuer die Kursquellen (Kraken- und CoinGecko-Format). */
export class FakeKurse {
  constructor() {
    this.xmr = { kraken: 485.23, coingecko: 487.3 };
    this.btc = { kraken: 73_000, coingecko: 73_348 };
    this.ausfall = new Set();
    this.aufrufe = [];
  }

  holen = async (url) => {
    this.aufrufe.push(url);
    const json = (o) => ({ status: 200, body: Buffer.from(JSON.stringify(o)) });
    const quelle = url.includes('kraken') ? 'kraken' : 'coingecko';
    if (this.ausfall.has(quelle) || this.ausfall.has('alle')) throw new Error('Tor-SOCKS nicht erreichbar');
    if (url.includes('XMREUR')) return json({ error: [], result: { XXMRZEUR: { c: [String(this.xmr.kraken), '1.0'] } } });
    if (url.includes('XBTEUR')) return json({ error: [], result: { XXBTZEUR: { c: [String(this.btc.kraken), '0.1'] } } });
    if (url.includes('ids=monero')) return json({ monero: { eur: this.xmr.coingecko } });
    if (url.includes('ids=bitcoin')) return json({ bitcoin: { eur: this.btc.coingecko } });
    return { status: 404, body: Buffer.from('{}') };
  };
}

/** Attrappe fuer mempool.space (Bitcoin-Zahlungsweg). */
export class FakeMempool {
  constructor() {
    this.txs = [];
    this.hoehe = 900_000;
    this.ausfall = false;
  }

  zahlung(adresse, sats, { hoehe = null } = {}) {
    const tx = { txid: crypto.randomBytes(32).toString('hex'), adresse, sats, hoehe };
    this.txs.push(tx);
    return tx;
  }

  holen = async (url) => {
    if (this.ausfall) throw new Error('Tor-SOCKS nicht erreichbar');
    const u = new URL(url);
    const json = (o) => ({ status: 200, body: Buffer.from(JSON.stringify(o)) });
    if (u.pathname === '/api/blocks/tip/height') return { status: 200, body: Buffer.from(String(this.hoehe)) };
    const m = /^\/api\/address\/([a-z0-9]+)(\/txs)?$/.exec(u.pathname);
    if (!m) return { status: 404, body: Buffer.from('Not found') };
    const eigene = this.txs.filter((t) => t.adresse === m[1]);
    if (m[2]) {
      return json(
        eigene.map((t) => ({
          txid: t.txid,
          vout: [{ scriptpubkey_address: t.adresse, value: t.sats }],
          status: t.hoehe === null ? { confirmed: false } : { confirmed: true, block_height: t.hoehe },
        })),
      );
    }
    const kette = eigene.filter((t) => t.hoehe !== null);
    const pool = eigene.filter((t) => t.hoehe === null);
    const summe = (l) => l.reduce((s, t) => s + t.sats, 0);
    return json({
      chain_stats: { funded_txo_sum: summe(kette), tx_count: kette.length },
      mempool_stats: { funded_txo_sum: summe(pool), tx_count: pool.length },
    });
  };
}

/** Gemockter externer Zahlungsdienst (Rechnungsmodell, siehe src/zahlung/extern.js). */
export class TestZahlungsdienst {
  constructor({ geheimnis = 'test-geheimnis' } = {}) {
    this.art = 'rechnung';
    this.name = 'Testdienst';
    this.waehrung = 'XMR';
    this.einheit = 1e12;
    this.stellen = 12;
    this.anzeigeStellen = 6;
    this.rundung = 1e6;
    this.fingerabdruck = 'testdienst-konto';
    this.geheimnis = geheimnis;
    this.rechnungen = new Map();
    this.auszahlungsliste = [];
    this.ausfall = false;
    this.n = 0;
  }

  async pruefen() {
    return {};
  }

  async rechnungErstellen({ bestellnummer, preisEur }) {
    if (this.ausfall) throw new Error('Dienst nicht erreichbar');
    const referenz = 'R' + ++this.n;
    const betrag = Math.ceil((preisEur * 1e12) / 480 / 1e6) * 1e6;
    this.rechnungen.set(referenz, { bestellnummer, betrag, empfangen: 0, bestaetigt: 0, status: 'waiting' });
    return { referenz, adresse: testAdresse('8', 'extern' + referenz), betrag, gueltigBis: null, kurs: { eurProCoin: 480, quellen: [{ name: 'testdienst', wert: 480 }], abgerufen: new Date(0).toISOString(), methode: 'Kurs des Zahlungsdienstes' } };
  }

  bezahlen(referenz, { bestaetigt = true, anteil = 1 } = {}) {
    const r = this.rechnungen.get(referenz);
    r.empfangen = Math.round(r.betrag * anteil);
    r.bestaetigt = bestaetigt ? r.empfangen : 0;
  }

  async rechnungsstatus(referenz) {
    if (this.ausfall) throw new Error('Dienst nicht erreichbar');
    const r = this.rechnungen.get(referenz);
    return {
      empfangen: r.empfangen,
      bestaetigt: r.bestaetigt,
      txids: r.empfangen ? ['ee'.repeat(32)] : [],
      endgueltig: null,
      gebuehren: r.bestaetigt ? [{ waehrung: 'EUR', betrag: '0.02', betragEur: '0.02', referenz: referenz + '-gebuehr' }] : [],
    };
  }

  webhookPruefen(kopf, roh) {
    const erwartet = crypto.createHmac('sha256', this.geheimnis).update(roh).digest('hex');
    const sig = String(kopf['x-signatur'] || '');
    if (sig.length !== erwartet.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(erwartet))) throw new Error('Signatur');
    return JSON.parse(roh.toString('utf8')).referenz;
  }

  async auszahlungen() {
    return this.auszahlungsliste;
  }

  uri(adresse, betrag) {
    return `monero:${adresse}?tx_amount=${betrag}`;
  }
}

/** Komplettes Test-Setup mit Monero-Wallet-Attrappe (und optional weiteren Zahlungswegen). */
export async function testShop(ueberschreiben = {}, { verzeichnis = tempVerzeichnis(), uhr = testUhr(), wallet = new FakeWallet(), kurse = new FakeKurse(), extern = null, mempool = null } = {}) {
  testSchluesselDatei(verzeichnis);
  const { konfig, btcKonto } = testKonfig(verzeichnis, ueberschreiben);
  const kursdienst = new Kursdienst({
    holen: kurse.holen,
    waehrungen: { XMR: { quellen: konfig.kurs.quellen.XMR, min: 1, max: 100_000 }, BTC: { quellen: konfig.kurs.quellen.BTC, min: 1000, max: 10_000_000 } },
    mindestQuellen: konfig.kurs.mindestQuellen,
    maxAbweichungProzent: konfig.kurs.maxAbweichungProzent,
    cacheSek: konfig.kurs.cacheSek,
    jetzt: uhr.jetzt,
  });
  const wege = {};
  if (konfig.zahlungswege.xmr.aktiv) wege.xmr = new MoneroZahlungsweg({ rpc: wallet.rpc, hauptadresse: konfig.zahlungswege.xmr.hauptadresse });
  if (konfig.zahlungswege.btc.aktiv) {
    const m = mempool || new FakeMempool();
    wege.btc = new BitcoinZahlungsweg({ konto: btcKonto, mempool: new MempoolApi({ holen: m.holen, onionUrl: ONION }), startIndex: konfig.zahlungswege.btc.startIndex, gapLimit: konfig.zahlungswege.btc.gapLimit });
  }
  if (extern) wege.extern = extern;
  const buchhaltung = new Buchhaltung({ verzeichnis: path.join(konfig.datenVerzeichnis, 'buchhaltung'), rechnungsPraefix: konfig.buchhaltung.rechnungsPraefix, jetzt: uhr.jetzt });
  await buchhaltung.initialisieren();
  const verwaltung = new Bestellverwaltung({
    konfig,
    wege,
    kursdienst,
    buchhaltung,
    signieren: (d) => lizenzSignieren(TEST_PRIVAT, d),
    jetzt: uhr.jetzt,
  });
  await verwaltung.laden();
  return { konfig, verwaltung, wallet, kurse, uhr, verzeichnis, buchhaltung, kursdienst, wege };
}

export const BTC_TESTKONTO = () => ladeKontoSchluessel(BIP84_TESTVEKTOR_ZPUB);
