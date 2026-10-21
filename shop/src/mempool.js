// Abfrage der mempool.space-API (Esplora-kompatibel) - standardmaessig ueber
// die Onion-Adresse von mempool.space, optional mit Rueckfall auf die
// Clearnet-Adresse (ebenfalls ueber Tor).

import { istBc1qAdresse } from './bip84.js';

const istSats = (n) => Number.isSafeInteger(n) && n >= 0;

export class MempoolFehler extends Error {}

export class MempoolApi {
  /**
   * @param {object} o
   * @param {(url: string) => Promise<{status: number, body: Buffer}>} o.holen  HTTP-GET (ueber Tor)
   * @param {string} o.onionUrl
   * @param {string} [o.clearnetUrl]
   * @param {boolean} [o.clearnetFallback]
   * @param {{warnung: Function}} [o.log]
   */
  constructor({ holen, onionUrl, clearnetUrl, clearnetFallback = false, log }) {
    this.holen = holen;
    this.basen = [onionUrl];
    if (clearnetFallback && clearnetUrl) this.basen.push(clearnetUrl);
    this.log = log;
  }

  async _abruf(pfad) {
    let letzterFehler;
    for (const basis of this.basen) {
      try {
        const { status, body } = await this.holen(basis + pfad);
        if (status !== 200) throw new MempoolFehler(`HTTP ${status}`);
        return body.toString('utf8');
      } catch (e) {
        letzterFehler = e;
        if (this.basen.length > 1 && this.log) this.log.warnung(`mempool-Abruf ueber ${basis.includes('.onion') ? 'Onion' : 'Clearnet'} fehlgeschlagen: ${e.message}`);
      }
    }
    throw new MempoolFehler('mempool.space nicht erreichbar: ' + (letzterFehler?.message || 'unbekannt'));
  }

  async _json(pfad) {
    const text = await this._abruf(pfad);
    try {
      return JSON.parse(text);
    } catch {
      throw new MempoolFehler('Ungueltige JSON-Antwort von mempool.space');
    }
  }

  /** Aktuelle Blockhoehe. */
  async blockhoehe() {
    const text = (await this._abruf('/api/blocks/tip/height')).trim();
    const h = Number(text);
    if (!/^\d{1,9}$/.test(text) || !Number.isSafeInteger(h) || h < 800_000) throw new MempoolFehler('Unplausible Blockhoehe');
    return h;
  }

  /** Summen fuer eine Adresse: { bestaetigtSats (>=1 Bestaetigung), unbestaetigtSats, txAnzahl } */
  async adressUebersicht(adresse) {
    if (!istBc1qAdresse(adresse)) throw new Error('Ungueltige Adresse');
    const d = await this._json('/api/address/' + adresse);
    const c = d && d.chain_stats;
    const m = d && d.mempool_stats;
    if (!c || !m || !istSats(c.funded_txo_sum) || !istSats(m.funded_txo_sum) || !istSats(c.tx_count) || !istSats(m.tx_count)) {
      throw new MempoolFehler('Unerwartetes Antwortformat (Adresse)');
    }
    return {
      bestaetigtSats: c.funded_txo_sum,
      unbestaetigtSats: m.funded_txo_sum,
      txAnzahlBestaetigt: c.tx_count,
      txAnzahl: c.tx_count + m.tx_count,
    };
  }

  /** Hatte die Adresse jemals eine Transaktion (bestaetigt oder im Mempool)? */
  async hatHistorie(adresse) {
    const u = await this.adressUebersicht(adresse);
    return u.txAnzahl > 0;
  }

  /**
   * Zahlungsstand einer Adresse.
   * empfangenSats: alle eingegangenen Betraege (inkl. unbestaetigt)
   * bestaetigtSats: Betraege mit mindestens `minBestaetigungen` Bestaetigungen
   * bestaetigungen: kleinste Bestaetigungszahl der Eingaenge (0 = noch im Mempool),
   *   null, wenn unbekannt (bei minBestaetigungen <= 1 wird die Blockhoehe nicht abgefragt)
   */
  async zahlungsstand(adresse, minBestaetigungen = 1) {
    const u = await this.adressUebersicht(adresse);
    const ergebnis = {
      empfangenSats: u.bestaetigtSats + u.unbestaetigtSats,
      bestaetigtSats: minBestaetigungen <= 1 ? u.bestaetigtSats : 0,
      txAnzahl: u.txAnzahl,
      txids: [],
      bestaetigungen: u.unbestaetigtSats > 0 ? 0 : null,
    };
    if (u.txAnzahl === 0) return ergebnis;

    const txs = await this._json('/api/address/' + adresse + '/txs');
    if (!Array.isArray(txs)) throw new MempoolFehler('Unerwartetes Antwortformat (Transaktionen)');
    const hoehe = minBestaetigungen > 1 ? await this.blockhoehe() : null;
    let tiefBestaetigt = 0;
    let kleinste = null;
    for (const tx of txs.slice(0, 100)) {
      if (!tx || typeof tx.txid !== 'string' || !/^[0-9a-f]{64}$/.test(tx.txid) || !Array.isArray(tx.vout)) continue;
      let anAdresse = 0;
      for (const out of tx.vout) {
        if (out && out.scriptpubkey_address === adresse && istSats(out.value)) anAdresse += out.value;
      }
      if (anAdresse === 0) continue;
      ergebnis.txids.push(tx.txid);
      if (hoehe === null) continue;
      let bestaetigungen = 0;
      if (tx.status && tx.status.confirmed === true && Number.isSafeInteger(tx.status.block_height)) {
        bestaetigungen = Math.max(0, hoehe - tx.status.block_height + 1);
        if (bestaetigungen >= minBestaetigungen) tiefBestaetigt += anAdresse;
      }
      kleinste = kleinste === null ? bestaetigungen : Math.min(kleinste, bestaetigungen);
    }
    if (hoehe !== null && kleinste !== null) ergebnis.bestaetigungen = kleinste;
    // Bei mehr als einer Seite Transaktionen ist die Liste unvollstaendig - dann
    // wird konservativ nur gezaehlt, was sicher tief genug bestaetigt ist.
    if (hoehe !== null) ergebnis.bestaetigtSats = Math.min(tiefBestaetigt, u.bestaetigtSats);
    return ergebnis;
  }
}
