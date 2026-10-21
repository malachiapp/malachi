// Einfacher Token-Bucket. Da ueber Tor alle Anfragen von 127.0.0.1 kommen,
// ist eine Begrenzung pro IP sinnlos - die Grenzen gelten global.

export class TokenEimer {
  /**
   * @param {number} kapazitaet  maximale Anzahl auf einmal (Stoss)
   * @param {number} proStunde   Nachfuellrate
   * @param {() => number} jetzt Uhr (ms)
   */
  constructor(kapazitaet, proStunde, jetzt = Date.now) {
    this.kapazitaet = kapazitaet;
    this.rateProMs = proStunde / 3_600_000;
    this.jetzt = jetzt;
    this.stand = kapazitaet;
    this.zuletzt = jetzt();
  }

  _nachfuellen() {
    const t = this.jetzt();
    const vergangen = Math.max(0, t - this.zuletzt);
    this.zuletzt = t;
    this.stand = Math.min(this.kapazitaet, this.stand + vergangen * this.rateProMs);
  }

  /** Verbraucht ein Token, falls vorhanden. */
  versuchen() {
    this._nachfuellen();
    if (this.stand >= 1) {
      this.stand -= 1;
      return true;
    }
    return false;
  }

  /** Gibt ein Token zurueck (z. B. wenn die Aktion vor dem eigentlichen Verbrauch scheiterte). */
  zurueckgeben() {
    this.stand = Math.min(this.kapazitaet, this.stand + 1);
  }
}

/** Begrenzt die Anzahl gleichzeitig laufender Vorgaenge. */
export class Begrenzer {
  constructor(max) {
    this.max = max;
    this.aktiv = 0;
    this.warteschlange = [];
  }

  async ausfuehren(fn) {
    // Ein freiwerdender Platz wird direkt an den naechsten Wartenden uebergeben.
    if (this.aktiv >= this.max) await new Promise((r) => this.warteschlange.push(r));
    else this.aktiv++;
    try {
      return await fn();
    } finally {
      const naechster = this.warteschlange.shift();
      if (naechster) naechster();
      else this.aktiv--;
    }
  }

}

/**
 * Token-Eimer je Schluessel (z. B. je Tor-Kreis), begrenzt in der Anzahl
 * gemerkter Schluessel. Mit Schluessel null (unbekannter Kreis) gilt nur der
 * gemeinsame Eimer des Aufrufers.
 */
export class EimerJeSchluessel {
  constructor(kapazitaet, proStunde, jetzt = Date.now, maxSchluessel = 5000) {
    this.kapazitaet = kapazitaet;
    this.proStunde = proStunde;
    this.jetzt = jetzt;
    this.maxSchluessel = maxSchluessel;
    this.eimer = new Map();
  }

  versuchen(schluessel) {
    if (schluessel == null) return true;
    let e = this.eimer.get(schluessel);
    if (!e) {
      if (this.eimer.size >= this.maxSchluessel) this.eimer.delete(this.eimer.keys().next().value);   // aeltesten vergessen
      e = new TokenEimer(this.kapazitaet, this.proStunde, this.jetzt);
      this.eimer.set(schluessel, e);
    }
    return e.versuchen();
  }

  zurueckgeben(schluessel) {
    if (schluessel != null) this.eimer.get(schluessel)?.zurueckgeben();
  }
}
