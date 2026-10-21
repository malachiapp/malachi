// Zweiter Zahlungsweg Bitcoin (on-chain, BIP84 native SegWit, watch-only zpub).
// Standardmaessig abgeschaltet. Adressen werden lokal aus der zpub abgeleitet,
// Zahlungseingaenge ueber die mempool.space-API (ueber Tor) geprueft. Der Server
// kennt keinen privaten Schluessel und kann nichts ausgeben.

import { empfangsAdresse } from '../bip84.js';
import { bip21 } from '../qr.js';

/** Staubgrenze in sat: kleinere Ausgaenge lehnen Wallets/Knoten ab (546 = sicher fuer alle Adresstypen). */
export const BTC_STAUBGRENZE_SATS = 546;

/** Gap-Limit, mit dem Sparrow, Electrum und die meisten Hardware-Wallet-Apps standardmaessig arbeiten. */
export const BTC_STANDARD_GAP_LIMIT = 20;

export class BitcoinZahlungsweg {
  /**
   * @param {object} o
   * @param {object} o.konto      Ergebnis von ladeKontoSchluessel()
   * @param {object} o.mempool    MempoolApi
   * @param {number} [o.startIndex]
   * @param {number} [o.gapLimit] Gap-Limit des Betreiber-Wallets (Sparrow/Electrum: 20)
   */
  constructor({ konto, mempool, startIndex = 0, gapLimit = BTC_STANDARD_GAP_LIMIT }) {
    this.konto = konto;
    this.mempool = mempool;
    this.startIndex = startIndex;
    this.art = 'adresse'; // eigenes Wallet: eine Adresse je Bestellung
    this.waehrung = 'BTC';
    this.name = 'Bitcoin';
    this.einheit = 1e8;
    this.stellen = 8;
    this.anzeigeStellen = 8;
    this.rundung = 1;
    this.mindestBetrag = BTC_STAUBGRENZE_SATS;
    // Hoechstens gapLimit - 1 unbenutzte Adressen in Folge: Unbezahlte Indizes werden
    // wiederverwendet, ein frischer Index kommt nur, wenn kein freier mehr da ist.
    // Damit liegen nie mehr unbenutzte Adressen hintereinander, als gerade reserviert
    // sind - und das Wallet des Betreibers findet jede Zahlung.
    this.maxUnbenutzt = Math.max(1, Math.trunc(gapLimit) - 1);
    this.fingerabdruck = konto.fingerabdruck;
  }

  async pruefen() {
    return { hoehe: await this.mempool.blockhoehe() };
  }

  /** Naechste Adresse aus dem eigenen Zaehler (die Ableitung ist deterministisch). */
  async frischeAdresse(zaehler) {
    if (zaehler.naechster < this.startIndex) zaehler.naechster = this.startIndex;
    const index = zaehler.naechster++;
    return { index, adresse: empfangsAdresse(this.konto, index) };
  }

  async adresseVon(index) {
    return { adresse: empfangsAdresse(this.konto, index), benutzt: false };
  }

  /** Wiederverwendbar nur, wenn die Adresse nie eine Transaktion hatte (auch nicht im Mempool). */
  async istUnbenutzt(index) {
    return !(await this.mempool.hatHistorie(empfangsAdresse(this.konto, index)));
  }

  async zahlungsstand(_index, adresse, minBestaetigungen) {
    const s = await this.mempool.zahlungsstand(adresse, minBestaetigungen);
    return { empfangen: s.empfangenSats, bestaetigt: s.bestaetigtSats, gesperrt: 0, txids: s.txids, bestaetigungen: s.bestaetigungen ?? null };
  }

  /** BIP21-URI (bitcoin:bc1q...?amount=0.00004087). */
  uri(adresse, betragText) {
    return bip21(adresse, betragText);
  }
}
