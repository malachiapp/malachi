// Verkauf eingegangener Coins gegen EUR - austauschbares Modul.
//
// WICHTIG: Der Server besitzt keine privaten Wallet-Schluessel (view-only bzw.
// watch-only). Er kann eingegangene Coins daher NICHT selbst zu einer Boerse
// schicken. Moeglich ist:
//   - modus "manuell" (Standard): Bestand anzeigen; Verkaeufe, die der Betreiber
//     selbst durchfuehrt, per Befehl nachtragen (werkzeuge/buchhaltung.js).
//   - modus "kraken": Coins, die der Betreiber selbst auf sein Kraken-Konto
//     eingezahlt hat, werden nach Schwellenwert oder taeglichem Zeitplan
//     automatisch per Market-Order verkauft und gebucht. Nur fuer Paare, die
//     Kraken fuer Kunden im EWR anbietet (BTC/EUR; Monero ist dort nicht handelbar).
//     API-Schluessel NUR mit den Rechten "Query Funds", "Query Open/Closed Orders"
//     und "Create & Modify Orders" - NIEMALS "Withdraw Funds".
//
// Siehe VERKAUF_UND_STEUER.md.

import crypto from 'node:crypto';
import path from 'node:path';
import { JsonSpeicher } from './speicher.js';
import { dezimalZuAtomar, atomarZuDezimal } from './dezimal.js';
import { geheimnisLesen } from './geheimnisse.js';

const STILL = { info() {}, warnung() {}, fehler() {} };

/** Kraken-Signatur: HMAC-SHA512(pfad + SHA256(nonce + postdaten), base64dekodiert(secret)). */
export function krakenSignatur(pfad, nonce, postdaten, secretB64) {
  const hash = crypto.createHash('sha256').update(String(nonce) + postdaten).digest();
  return crypto.createHmac('sha512', Buffer.from(secretB64, 'base64')).update(Buffer.concat([Buffer.from(pfad), hash])).digest('base64');
}

export class KrakenClient {
  /**
   * @param {object} o
   * @param {(url: string, opts: object) => Promise<{status:number, body:Buffer}>} o.anfrage  HTTP ueber Tor (POST)
   * @param {string} o.apiKey
   * @param {string} o.apiSecret
   */
  constructor({ anfrage, apiKey, apiSecret, basis = 'https://api.kraken.com', jetzt = Date.now }) {
    this.anfrage = anfrage;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.basis = basis;
    this.jetzt = jetzt;
    this.letzteNonce = 0;
  }

  async privat(methode, params = {}) {
    const pfad = `/0/private/${methode}`;
    const nonce = Math.max(this.jetzt(), this.letzteNonce + 1);
    this.letzteNonce = nonce;
    const post = new URLSearchParams({ nonce: String(nonce), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) }).toString();
    const { status, body } = await this.anfrage(this.basis + pfad, {
      methode: 'POST',
      kopf: {
        'API-Key': this.apiKey,
        'API-Sign': krakenSignatur(pfad, nonce, post, this.apiSecret),
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      koerper: post,
    });
    if (status !== 200) throw new Error(`Kraken: HTTP ${status}`);
    const d = JSON.parse(body.toString('utf8'));
    if (Array.isArray(d.error) && d.error.length) throw new Error('Kraken: ' + d.error.join(', '));
    return d.result;
  }
}

/** Waehrungskennungen bei Kraken. */
const KRAKEN = { BTC: { asset: 'XXBT', paar: 'XBTEUR', stellen: 8 } };

export class Verkaufsmodul {
  /**
   * @param {object} o
   * @param {object} o.konfig      Abschnitt "verkauf" der Konfiguration
   * @param {string} o.datenVerzeichnis
   * @param {object} o.buchhaltung
   * @param {KrakenClient} [o.kraken]
   */
  constructor({ konfig, datenVerzeichnis, buchhaltung, kraken = null, jetzt = Date.now, log = STILL }) {
    this.k = konfig;
    this.buchhaltung = buchhaltung;
    this.kraken = kraken;
    this.jetzt = jetzt;
    this.log = log;
    this.speicher = new JsonSpeicher(path.join(datenVerzeichnis, 'verkauf-status.json'));
    this.status = { offeneAuftraege: [], letzterLauf: 0, letzterTagesverkauf: '' };
  }

  async laden() {
    this.status = (await this.speicher.laden()) || this.status;
  }

  /** Ist ein Verkaufslauf faellig (Schwellenwert: bei jedem Lauf; taeglich: einmal ab der eingestellten Stunde UTC)? */
  _faellig() {
    const d = new Date(this.jetzt());
    if (this.k.zeitplan === 'taeglich') {
      const tag = d.toISOString().slice(0, 10);
      return d.getUTCHours() >= this.k.stundeUtc && this.status.letzterTagesverkauf !== tag;
    }
    return this.jetzt() - this.status.letzterLauf >= this.k.mindestAbstandMinuten * 60_000;
  }

  /** Ein Durchlauf (vom Server periodisch aufgerufen). */
  async lauf() {
    if (this.k.modus !== 'kraken' || !this.kraken) return null;
    await this._auftraegeAbschliessen();
    if (!this._faellig()) return null;
    this.status.letzterLauf = this.jetzt();
    const w = this.k.kraken.waehrung;
    const info = KRAKEN[w];
    const bestand = await this.kraken.privat('Balance');
    const vorhanden = dezimalZuAtomar(bestand[info.asset] || '0', info.stellen + 2) / 100n; // Kraken liefert bis zu 10 Stellen
    const reserve = dezimalZuAtomar(this.k.kraken.reserve, info.stellen);
    const schwelle = dezimalZuAtomar(this.k.kraken.schwellenwert, info.stellen);
    const menge = vorhanden - reserve;
    if (this.k.zeitplan === 'taeglich') this.status.letzterTagesverkauf = new Date(this.jetzt()).toISOString().slice(0, 10);
    if (menge <= 0n || menge < schwelle) {
      await this.speicher.speichern(this.status);
      return { verkauft: false, grund: 'unter Schwellenwert', bestand: atomarZuDezimal(vorhanden, info.stellen) };
    }
    const volumen = atomarZuDezimal(menge, info.stellen);
    const r = await this.kraken.privat('AddOrder', {
      pair: info.paar,
      type: 'sell',
      ordertype: 'market',
      volume: volumen,
      ...(this.k.kraken.nurProbelauf ? { validate: 'true' } : {}),
    });
    if (this.k.kraken.nurProbelauf) {
      this.log.info(`Verkauf (Probelauf): wuerde ${volumen} ${w} verkaufen - ${r && r.descr ? r.descr.order : ''}`);
      await this.speicher.speichern(this.status);
      return { verkauft: false, grund: 'probelauf', volumen };
    }
    const txid = r && Array.isArray(r.txid) ? r.txid[0] : null;
    if (!txid) throw new Error('Kraken: keine Auftragsnummer erhalten');
    this.status.offeneAuftraege.push({ txid, waehrung: w, erstellt: this.jetzt() });
    await this.speicher.speichern(this.status);
    this.log.info(`Verkaufsauftrag ueber ${volumen} ${w} erteilt (${txid}).`);
    await this._auftraegeAbschliessen();
    return { verkauft: true, txid, volumen };
  }

  /** Bucht ausgefuehrte Auftraege (idempotent ueber die Auftragsnummer). */
  async _auftraegeAbschliessen() {
    if (!this.status.offeneAuftraege.length) return;
    const ids = this.status.offeneAuftraege.map((a) => a.txid);
    const r = await this.kraken.privat('QueryOrders', { txid: ids.join(','), trades: 'false' });
    const rest = [];
    for (const a of this.status.offeneAuftraege) {
      const o = r[a.txid];
      if (!o || o.status !== 'closed') {
        if (o && (o.status === 'canceled' || o.status === 'expired')) this.log.warnung(`Verkaufsauftrag ${a.txid}: ${o.status}`);
        else rest.push(a);
        continue;
      }
      const datum = new Date((Number(o.closetm) || this.jetzt() / 1000) * 1000).toISOString().slice(0, 10);
      await this.buchhaltung.verkaufBuchen({
        datum,
        waehrung: a.waehrung,
        mengeCoin: o.vol_exec,
        erloesEur: Number(o.cost).toFixed(2),
        gebuehrEur: Number(o.fee).toFixed(2),
        dienst: 'Kraken',
        referenz: a.txid,
        notiz: `Market-Order ${o.descr ? o.descr.pair : ''}`,
        quelle: 'kraken',
      });
    }
    this.status.offeneAuftraege = rest;
    await this.speicher.speichern(this.status);
  }
}

/** Liest die Kraken-Zugangsdaten (JSON {"apiKey": "...", "apiSecret": "..."}). */
export function krakenZugangLesen(angabe) {
  const d = JSON.parse(geheimnisLesen(angabe));
  if (typeof d.apiKey !== 'string' || typeof d.apiSecret !== 'string') throw new Error('Kraken-Zugang: apiKey/apiSecret fehlen');
  const fehler = krakenZugangFehler(d.apiKey, d.apiSecret);
  if (fehler) throw new Error('Kraken-Zugang: ' + fehler);
  return d;
}

/**
 * Formpruefung eines Kraken-Schluesselpaars (ohne Netz): API-Key ist ein
 * Base64-Text, der private Schluessel Base64 von genau 64 Byte.
 * @returns {string|null} Fehlerbeschreibung oder null
 */
export function krakenZugangFehler(apiKey, apiSecret) {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9+/]{20,120}={0,2}$/.test(apiKey)) return 'API-Key hat ein unerwartetes Format';
  if (typeof apiSecret !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(apiSecret) || Buffer.from(apiSecret, 'base64').length !== 64) {
    return 'Private Key hat ein unerwartetes Format (erwartet: 88 Zeichen Base64)';
  }
  return null;
}

/**
 * Prueft einen Kraken-API-Schluessel, bevor der Shop ihn benutzt.
 * Muss gehen:  Guthaben abfragen, Auftraege abfragen, Auftraege anlegen.
 * Darf NICHT:  Auszahlen. Geprueft mit WithdrawMethods - der Aufruf liest nur
 *              die Auszahlungswege, verlangt bei Kraken aber das Recht
 *              "Funds - Withdraw". Klappt er, wird der Schluessel abgelehnt.
 * Nichts davon bewegt Geld: AddOrder laeuft mit validate=true (Kraken prueft
 * nur die Eingaben), alle anderen Aufrufe sind rein lesend.
 * Unklare Antworten (Netz, Tor-Sperre, ungueltiger Schluessel) gelten als
 * nicht bestanden.
 * @param {{privat: (methode: string, params?: object) => Promise<object>}} kraken
 * @returns {Promise<{ok: boolean, meldungen: string[]}>}
 */
export async function krakenSchluesselPruefen(kraken) {
  const meldungen = [];
  let ok = true;
  const verweigert = (e) => /EGeneral:Permission denied/.test(e.message);
  // Fehler, die zeigen, dass Kraken die Anfrage mit Recht angenommen und nur inhaltlich beanstandet hat.
  const inhaltlich = (e) => /EOrder:|EGeneral:Invalid arguments/.test(e.message);

  try {
    await kraken.privat('Balance');
    meldungen.push('OK      Guthaben abfragen (Funds: Query)');
  } catch (e) {
    return { ok: false, meldungen: [`FEHLER  Guthaben abfragen: ${e.message}`, 'Weitere Pruefungen uebersprungen (Schluessel ungueltig, Recht fehlt oder Kraken ueber Tor nicht erreichbar).'] };
  }

  try {
    await kraken.privat('WithdrawMethods', { asset: 'XBT' });
    ok = false;
    meldungen.push('GEFAHR  Der Schluessel darf AUSZAHLEN (Funds: Withdraw). Bei Kraken loeschen und ohne dieses Recht neu anlegen.');
  } catch (e) {
    if (verweigert(e)) meldungen.push('OK      kein Auszahlungsrecht');
    else {
      ok = false;
      meldungen.push(`UNKLAR  Auszahlungsrecht nicht sicher pruefbar: ${e.message}`);
    }
  }

  try {
    await kraken.privat('QueryOrders', { txid: 'OAAAAA-AAAAA-AAAAAA', trades: 'false' });
    meldungen.push('OK      Auftraege abfragen (Orders: Query closed orders)');
  } catch (e) {
    if (inhaltlich(e)) meldungen.push('OK      Auftraege abfragen (Orders: Query closed orders)');
    else {
      ok = false;
      meldungen.push(`FEHLT   Auftraege abfragen: ${e.message}`);
    }
  }

  try {
    await kraken.privat('AddOrder', { pair: 'XBTEUR', type: 'sell', ordertype: 'market', volume: '0.0001', validate: 'true' });
    meldungen.push('OK      Verkaufsauftraege anlegen (nur geprueft, nichts ausgefuehrt)');
  } catch (e) {
    if (inhaltlich(e)) meldungen.push(`OK      Verkaufsauftraege anlegen (nur geprueft, nichts ausgefuehrt; Kraken: ${e.message.replace(/^Kraken: /, '')})`);
    else {
      ok = false;
      meldungen.push(`FEHLT   Verkaufsauftraege anlegen (Orders: Create & modify orders): ${e.message}`);
    }
  }
  return { ok, meldungen };
}

