// EUR-Referenzkurs: Median aus mehreren konfigurierbaren Quellen, abgerufen ueber Tor.
// Jede Quelle ist { name, url, pfad }, wobei `pfad` den Wert im JSON adressiert
// (z. B. "result.XXMRZEUR.c.0" oder "monero.eur").

export class KursFehler extends Error {}

/** Wert an einem Punkt-Pfad aus einem JSON-Objekt lesen. */
export function wertAnPfad(objekt, pfad) {
  let w = objekt;
  for (const teil of pfad.split('.')) {
    if (w === null || typeof w !== 'object') return undefined;
    w = Array.isArray(w) ? w[Number(teil)] : Object.hasOwn(w, teil) ? w[teil] : undefined;
  }
  return w;
}

export function median(werte) {
  if (!werte.length) throw new KursFehler('Keine Werte');
  const s = [...werte].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Ermittelt den Kurs aus den Einzelwerten: Median, Ausreisser (> maxAbweichungProzent
 * vom Median) werden verworfen, danach muessen noch mindestens `mindestQuellen` Werte
 * uebrig sein.
 */
export function kursAusWerten(einzelwerte, { mindestQuellen = 2, maxAbweichungProzent = 5 } = {}) {
  const gueltig = einzelwerte.filter((q) => q.ok);
  if (gueltig.length < mindestQuellen) {
    throw new KursFehler(`Nur ${gueltig.length} von mindestens ${mindestQuellen} Kursquellen erreichbar`);
  }
  const m1 = median(gueltig.map((q) => q.wert));
  for (const q of gueltig) {
    if (Math.abs(q.wert - m1) / m1 > maxAbweichungProzent / 100) {
      q.ok = false;
      q.fehler = `weicht mehr als ${maxAbweichungProzent} % vom Median ab`;
    }
  }
  const rest = gueltig.filter((q) => q.ok);
  if (rest.length < mindestQuellen) throw new KursFehler('Kursquellen weichen zu stark voneinander ab');
  return median(rest.map((q) => q.wert));
}

export class Kursdienst {
  /**
   * @param {object} o
   * @param {(url: string) => Promise<{status:number, body:Buffer}>} o.holen  HTTP-GET ueber Tor
   * @param {Record<string, {quellen: Array<{name:string,url:string,pfad:string}>, min: number, max: number}>} o.waehrungen
   * @param {number} [o.mindestQuellen]
   * @param {number} [o.maxAbweichungProzent]
   * @param {number} [o.cacheSek]
   * @param {() => number} [o.jetzt]
   */
  constructor({ holen, waehrungen, mindestQuellen = 2, maxAbweichungProzent = 5, cacheSek = 300, jetzt = Date.now, log }) {
    this.holen = holen;
    this.waehrungen = waehrungen;
    this.mindestQuellen = mindestQuellen;
    this.maxAbweichungProzent = maxAbweichungProzent;
    this.cacheMs = cacheSek * 1000;
    this.jetzt = jetzt;
    this.log = log;
    this.cache = new Map();
    this.laufend = new Map();
  }

  async _quelle(q, grenzen) {
    try {
      const { status, body } = await this.holen(q.url);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const w = Number(wertAnPfad(JSON.parse(body.toString('utf8')), q.pfad));
      if (!Number.isFinite(w) || w < grenzen.min || w > grenzen.max) throw new Error('unplausibler Wert');
      return { name: q.name, ok: true, wert: w };
    } catch (e) {
      return { name: q.name, ok: false, fehler: String(e.message || e).slice(0, 200) };
    }
  }

  /**
   * Aktueller Kurs EUR je Coin (zwischengespeichert).
   * @returns {Promise<{eurProCoin: number, quellen: Array, abgerufen: string, methode: string}>}
   */
  async kurs(waehrung, { frisch = false } = {}) {
    const c = this.cache.get(waehrung);
    if (!frisch && c && this.jetzt() - c.zeit < this.cacheMs) return c.ergebnis;
    if (this.laufend.has(waehrung)) return this.laufend.get(waehrung);
    const lauf = this._abrufen(waehrung).finally(() => this.laufend.delete(waehrung));
    this.laufend.set(waehrung, lauf);
    return lauf;
  }

  async _abrufen(waehrung) {
    const w = this.waehrungen[waehrung];
    if (!w) throw new KursFehler(`Keine Kursquellen fuer ${waehrung}`);
    const zeit = this.jetzt();
    const einzel = await Promise.all(w.quellen.map((q) => this._quelle(q, w)));
    let eurProCoin;
    try {
      eurProCoin = kursAusWerten(einzel, { mindestQuellen: this.mindestQuellen, maxAbweichungProzent: this.maxAbweichungProzent });
    } catch (e) {
      if (this.log) this.log.warnung(`Kurs ${waehrung}: ${e.message} (${einzel.map((q) => `${q.name}: ${q.ok ? q.wert : q.fehler}`).join('; ')})`);
      throw e;
    }
    const ergebnis = {
      eurProCoin: Math.round(eurProCoin * 100) / 100,
      quellen: einzel.map((q) => (q.ok ? { name: q.name, wert: q.wert } : { name: q.name, fehler: q.fehler })),
      abgerufen: new Date(zeit).toISOString(),
      methode: `Median aus ${einzel.filter((q) => q.ok).length} Quellen`,
    };
    this.cache.set(waehrung, { zeit, ergebnis });
    return ergebnis;
  }
}
