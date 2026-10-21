// Zahlungsweg Monero (XMR) ueber ein VIEW-ONLY-Wallet in monero-wallet-rpc.
//
// Das Wallet kennt nur Hauptadresse + privaten View-Key: Es sieht eingehende
// Zahlungen, kann aber nichts ausgeben. monero-wallet-rpc laeuft als eigener
// Dienst, lauscht nur auf 127.0.0.1 und verbindet sich ueber Tor mit einem
// Remote-Node. Der Shop spricht es per JSON-RPC mit Digest-Login an.

import crypto from 'node:crypto';
import { digestPost } from './digest.js';

const STILL = { info() {}, warnung() {}, fehler() {} };

export class WalletRpcFehler extends Error {
  constructor(nachricht, code) {
    super(nachricht);
    this.code = code;
  }
}

const istAtomar = (n) => Number.isSafeInteger(n) && n >= 0;
const HAUPTADRESSE = /^4[1-9A-HJ-NP-Za-km-z]{94}$/;
const SUBADRESSE = /^8[1-9A-HJ-NP-Za-km-z]{94}$/;

export function istMoneroHauptadresse(a) {
  return typeof a === 'string' && HAUPTADRESSE.test(a);
}

/** Transport: JSON-RPC 2.0 an monero-wallet-rpc (lokal, Digest-Login). */
export function walletRpcTransport({ url, benutzer, passwort, timeoutMs = 30_000 }) {
  let id = 0;
  // Drittes Argument: { timeoutMs } fuer einzelne lange Aufrufe (z. B. refresh).
  return async (methode, params = {}, { timeoutMs: zeitlimit = timeoutMs } = {}) => {
    const koerper = JSON.stringify({ jsonrpc: '2.0', id: String(++id), method: methode, params });
    let r;
    try {
      r = await digestPost({ url, koerper, benutzer, passwort, timeoutMs: zeitlimit });
    } catch (e) {
      throw new WalletRpcFehler('wallet-rpc nicht erreichbar: ' + e.message);
    }
    if (r.status !== 200) throw new WalletRpcFehler(`wallet-rpc: HTTP ${r.status}`);
    let antwort;
    try {
      antwort = JSON.parse(r.body.toString('utf8'));
    } catch {
      throw new WalletRpcFehler('wallet-rpc: ungueltige Antwort');
    }
    if (antwort.error) throw new WalletRpcFehler(`wallet-rpc: ${antwort.error.message || 'Fehler'}`, antwort.error.code);
    if (!antwort.result || typeof antwort.result !== 'object') throw new WalletRpcFehler('wallet-rpc: Antwort ohne Ergebnis');
    return antwort.result;
  };
}

export class MoneroZahlungsweg {
  /**
   * @param {object} o
   * @param {(methode: string, params?: object) => Promise<object>} o.rpc
   * @param {string} o.hauptadresse  oeffentliche Hauptadresse des Shop-Wallets (4...)
   * @param {number} [o.kontoIndex]
   * @param {string[]} [o.ersatzKnoten]  Onion-Knoten (host:port), auf die umgeschaltet wird,
   *                                     wenn der Knoten aus wallet-rpc.conf nicht antwortet
   */
  constructor({ rpc, hauptadresse, kontoIndex = 0, ersatzKnoten = [], log = STILL }) {
    this.rpc = rpc;
    this.hauptadresse = hauptadresse;
    this.kontoIndex = kontoIndex;
    this.ersatzKnoten = ersatzKnoten;
    this.knotenIndex = -1; // -1 = Knoten aus wallet-rpc.conf
    this.log = log;
    this.art = 'adresse'; // eigenes Wallet: eine Subadresse je Bestellung
    this.waehrung = 'XMR';
    this.name = 'Monero';
    this.einheit = 1e12; // Piconero je XMR
    this.stellen = 12;
    this.anzeigeStellen = 6;
    this.rundung = 1e6; // Betraege auf 0,000001 XMR aufrunden
    this.fingerabdruck = crypto.createHash('sha256').update('XMR|' + hauptadresse).digest('hex').slice(0, 16);
  }

  /** Startpruefung: richtiges Wallet und wirklich view-only. */
  async pruefen() {
    const a = await this.rpc('get_address', { account_index: this.kontoIndex, address_index: [0] });
    if (a.address !== this.hauptadresse) {
      throw new WalletRpcFehler('Das geoeffnete Wallet gehoert nicht zur konfigurierten Hauptadresse (monero.hauptadresse).');
    }
    let ausgabeSchluessel = null;
    try {
      const k = await this.rpc('query_key', { key_type: 'spend_key' });
      ausgabeSchluessel = typeof k.key === 'string' ? k.key : null;
    } catch {
      ausgabeSchluessel = null; // erwartet: view-only-Wallets verweigern die Herausgabe
    }
    if (ausgabeSchluessel && !/^0+$/.test(ausgabeSchluessel)) {
      ausgabeSchluessel = null;
      throw new WalletRpcFehler('Das Wallet ist NICHT view-only (es kennt den privaten Spend-Key). Auf dem Server ist nur ein View-only-Wallet erlaubt!');
    }
    const h = await this.rpc('get_height');
    return { hoehe: h.height };
  }

  /**
   * Antwortet der Monero-Knoten? (wallet-rpc "refresh" holt neue Bloecke.)
   * Ohne Antwort wird der Reihe nach auf die Ersatzknoten umgeschaltet
   * (set_daemon, weiterhin ueber den Tor-Proxy von wallet-rpc, untrusted).
   * Ist wallet-rpc selbst nicht erreichbar, wird nicht umgeschaltet.
   * @returns {Promise<{ok: boolean, gewechselt: boolean}>}
   */
  async knotenPruefen() {
    if ((await this._knotenAntwortet()) === true) return { ok: true, gewechselt: false };
    const n = this.ersatzKnoten.length;
    for (let i = 0; i < n; i++) {
      this.knotenIndex = (this.knotenIndex + 1) % n;
      try {
        await this.rpc('set_daemon', { address: this.ersatzKnoten[this.knotenIndex], trusted: false });
      } catch (e) {
        this.log.warnung(`Monero: Umschalten auf Ersatzknoten ${this.knotenIndex + 1} fehlgeschlagen: ${e.message}`);
        continue;
      }
      if ((await this._knotenAntwortet()) === true) {
        this.log.info(`Monero: auf Ersatzknoten ${this.knotenIndex + 1} von ${n} umgeschaltet.`);
        return { ok: true, gewechselt: true };
      }
    }
    this.log.warnung(`Monero: kein Knoten erreichbar${n ? ` (auch keiner der ${n} Ersatzknoten)` : ' (keine Ersatzknoten eingetragen)'} - neue Monero-Zahlungen werden erst danach erkannt.`);
    return { ok: false, gewechselt: false };
  }

  /** true = Knoten antwortet; false = Knotenproblem; wirft, wenn wallet-rpc selbst nicht erreichbar ist. */
  async _knotenAntwortet() {
    try {
      await this.rpc('refresh', {}, { timeoutMs: 180_000 });
      return true;
    } catch (e) {
      if (e.code === -38 || /no connection to daemon|Zeitueberschreitung/i.test(e.message)) return false;
      throw e;
    }
  }

  /** Neue Subadresse im Wallet anlegen. */
  async frischeAdresse() {
    const r = await this.rpc('create_address', { account_index: this.kontoIndex, label: 'malachi-shop' });
    if (!Number.isSafeInteger(r.address_index) || r.address_index < 1 || !SUBADRESSE.test(r.address)) {
      throw new WalletRpcFehler('wallet-rpc: unerwartete Antwort auf create_address');
    }
    return { index: r.address_index, adresse: r.address };
  }

  async adresseVon(index) {
    let r;
    try {
      r = await this.rpc('get_address', { account_index: this.kontoIndex, address_index: [index] });
    } catch (e) {
      // z. B. nach Neuanlage des Wallets: Index existiert im Wallet (noch) nicht
      if (/out of bound/i.test(e.message)) throw Object.assign(new WalletRpcFehler('wallet-rpc: Subadresse unbekannt'), { unbekannt: true });
      throw e;
    }
    const e = Array.isArray(r.addresses) && r.addresses.find((x) => x.address_index === index);
    if (!e || !SUBADRESSE.test(e.address)) throw Object.assign(new WalletRpcFehler('wallet-rpc: Subadresse unbekannt'), { unbekannt: true });
    return { adresse: e.address, benutzt: e.used === true };
  }

  /** Eine Subadresse ist wiederverwendbar, wenn das Wallet nie einen Eingang auf ihr gesehen hat. */
  async istUnbenutzt(index) {
    const { benutzt } = await this.adresseVon(index);
    if (benutzt) return false;
    const r = await this.rpc('get_transfers', { in: true, pool: true, account_index: this.kontoIndex, subaddr_indices: [index] });
    return !(r.in && r.in.length) && !(r.pool && r.pool.length);
  }

  /**
   * Zahlungsstand einer Subadresse (Betraege in Piconero).
   * Ausgaenge mit unlock_time != 0 (zeitgesperrt) zaehlen nicht; Pool-Eintraege mit
   * erkanntem Double-Spend ebenfalls nicht.
   */
  async zahlungsstand(index, _adresse, minBestaetigungen) {
    const r = await this.rpc('get_transfers', { in: true, pool: true, account_index: this.kontoIndex, subaddr_indices: [index] });
    const stand = { empfangen: 0, bestaetigt: 0, gesperrt: 0, txids: [], bestaetigungen: null };
    const passt = (t) => t && t.subaddr_index && t.subaddr_index.major === this.kontoIndex && t.subaddr_index.minor === index;
    const txids = new Set();
    for (const [liste, imPool] of [[r.in || [], false], [r.pool || [], true]]) {
      if (!Array.isArray(liste)) throw new WalletRpcFehler('wallet-rpc: unerwartetes Format (get_transfers)');
      for (const t of liste.slice(0, 500)) {
        if (!passt(t) || !istAtomar(t.amount) || typeof t.txid !== 'string' || !/^[0-9a-f]{64}$/.test(t.txid)) continue;
        if (imPool && t.double_spend_seen) continue;
        if (t.unlock_time && t.unlock_time !== 0) {
          stand.gesperrt += t.amount;
          continue;
        }
        stand.empfangen += t.amount;
        txids.add(t.txid);
        const best = imPool ? 0 : Number(t.confirmations) || 0;
        if (!imPool && best >= minBestaetigungen) stand.bestaetigt += t.amount;
        stand.bestaetigungen = stand.bestaetigungen === null ? best : Math.min(stand.bestaetigungen, best);
      }
    }
    stand.txids = [...txids];
    return stand;
  }

  /** Zahlungs-URI (monero:ADRESSE?tx_amount=0.006166). */
  uri(adresse, betragText) {
    return `monero:${adresse}?tx_amount=${betragText}`;
  }
}
