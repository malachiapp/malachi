// Bestell-Logik: Zahlungsanfrage anlegen, Zahlungseingang pruefen, signierte
// Lizenz ausstellen, Umzug auf ein neues Geraet, Ablauf und Aufraeumen.
//
// Zustaende einer Bestellung:
//   offen         - noch keine Zahlung gesehen
//   unterzahlt    - Zahlung(en) gesehen, Summe reicht nicht (Rest kann nachgezahlt werden)
//   unbestaetigt  - Betrag vollstaendig, aber im Pool bzw. noch zu wenige Bestaetigungen
//   bezahlt       - Betrag mit Mindestbestaetigungen eingegangen -> Lizenz
//   abgelaufen    - nach Ablauf der Frist ohne jede Zahlung
//   widerrufen    - Vertrag vor der Bereitstellung widerrufen ("Vertrag widerrufen",
//                   § 356a BGB). Danach eingehende Zahlungen werden weiter erfasst,
//                   aber NIE mehr in eine Lizenz umgewandelt - nur zurueckgezahlt.
//
// Zahlungswege (austauschbar):
//   art 'adresse'  - eigenes Wallet (Monero view-only ueber wallet-rpc, optional Bitcoin watch-only):
//                    pro Bestellung eine eigene (Sub-)Adresse; unbezahlte Indizes werden wiederverwendet
//   art 'rechnung' - externer Zahlungsdienst (Adapter, siehe zahlung/extern.js)

import path from 'node:path';
import crypto from 'node:crypto';
import { bestellnummerErzeugen, normalisieren, BESTELLNUMMER_LAENGE } from './ids.js';
import { JsonSpeicher } from './speicher.js';
import { TokenEimer, Begrenzer, EimerJeSchluessel } from './ratenbegrenzung.js';
import { geraetecodeNormalisieren } from './lizenzpruefer.js';
import { atomarZuDezimal, kuerzen } from './dezimal.js';
import { rueckzahlAdresseGueltig } from './rueckzahlung.js';

const MINUTE = 60_000;
const STUNDE = 60 * MINUTE;
const TAG = 24 * STUNDE;

export const STATUS = Object.freeze({
  OFFEN: 'offen',
  UNTERZAHLT: 'unterzahlt',
  UNBESTAETIGT: 'unbestaetigt',
  BEZAHLT: 'bezahlt',
  ABGELAUFEN: 'abgelaufen',
  WIDERRUFEN: 'widerrufen',
});

const OHNE_ZAHLUNG = new Set([STATUS.OFFEN, STATUS.ABGELAUFEN]);
const ZU_PRUEFEN = new Set([STATUS.OFFEN, STATUS.UNTERZAHLT, STATUS.UNBESTAETIGT, STATUS.ABGELAUFEN, STATUS.WIDERRUFEN]);
/** Widerrufsfrist (§ 355 Abs. 2 BGB) - nur relevant, wenn ohne Zustimmung zur sofortigen Bereitstellung bezahlt wurde. */
export const WIDERRUFSFRIST_MS = 14 * 24 * 3_600_000;
const NAME_MAX = 100;
const WH_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const WIEDERHERSTELLUNGSCODE_LAENGE = 20; // 100 Bit

/** Fehler mit Code fuer Anzeige und API. */
export class ShopFehler extends Error {
  constructor(code, nachricht) {
    super(nachricht);
    this.code = code;
  }
}

/** Reine Bewertung eines Zahlungsstands (Betraege atomar). */
export function bewerteZahlung({ betrag, empfangen, bestaetigt, toleranz = 0 }) {
  const ziel = Math.max(1, betrag - toleranz);
  if (bestaetigt >= ziel) return STATUS.BEZAHLT;
  if (empfangen >= ziel) return STATUS.UNBESTAETIGT;
  if (empfangen > 0) return STATUS.UNTERZAHLT;
  return STATUS.OFFEN;
}

/** EUR-Preis -> atomarer Betrag, aufgerundet auf die Rundung des Zahlungswegs. */
export function betragBerechnen(preisEur, eurProCoin, weg) {
  const cent = Math.round(preisEur * 100);
  const roh = (cent * (weg.einheit / 100)) / eurProCoin;
  return Math.ceil(roh / weg.rundung - 1e-9) * weg.rundung;
}

/** Atomarer Betrag -> Text fuer Anzeige/URI (z. B. "0.006163"). */
export function betragText(atomar, weg) {
  return kuerzen(atomarZuDezimal(BigInt(Math.max(0, Math.trunc(atomar))), weg.stellen), weg.anzeigeStellen);
}

const WAEHRUNGEN = Object.freeze({
  XMR: Object.freeze({ waehrung: 'XMR', einheit: 1e12, stellen: 12, anzeigeStellen: 6 }),
  BTC: Object.freeze({ waehrung: 'BTC', einheit: 1e8, stellen: 8, anzeigeStellen: 8 }),
});

/** Einheit/Nachkommastellen fuer eine Bestellung - auch wenn ihr Zahlungsweg inzwischen abgeschaltet ist. */
export function waehrungsDaten(b, weg) {
  return weg || WAEHRUNGEN[b.waehrung] || WAEHRUNGEN.XMR;
}

/**
 * Noch zu zahlender Betrag (atomar) einer offenen bzw. unterzahlten Bestellung, sonst 0.
 * Hat der Zahlungsweg einen Mindestbetrag (Bitcoin: Staubgrenze), wird ein kleinerer
 * Rest auf diesen angehoben - einen Rest unter der Staubgrenze koennte kein Wallet
 * senden. Der Ueberschuss gilt dann als (akzeptierte) Ueberzahlung.
 */
export function offenerBetrag(b, toleranzProzent, weg) {
  let rest = 0;
  if (b.status === STATUS.OFFEN) rest = b.betrag;
  else if (b.status === STATUS.UNTERZAHLT) rest = Math.max(0, b.betrag - Math.floor((b.betrag * toleranzProzent) / 100) - b.empfangen);
  const min = weg && Number.isSafeInteger(weg.mindestBetrag) ? weg.mindestBetrag : 0;
  return rest > 0 && rest < min ? min : rest;
}

function wiederherstellungscodeErzeugen(zufall) {
  const b = zufall(13);
  let bits = 0;
  let wert = 0;
  let s = '';
  for (const x of b) {
    wert = ((wert << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5 && s.length < WIEDERHERSTELLUNGSCODE_LAENGE) {
      s += WH_ALPHABET[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return s;
}

const hashCode = (code) => crypto.createHash('sha256').update('MALACHI-WIEDERHERSTELLUNG|' + code).digest('hex');

const STILL = { info() {}, warnung() {}, fehler() {} };

export class Bestellverwaltung {
  /**
   * @param {object} o
   * @param {object} o.konfig      gepruefte Konfiguration
   * @param {Record<string, object>} o.wege  Zahlungswege nach Kennung ('xmr', 'btc', 'extern')
   * @param {object} o.kursdienst  Kursdienst (Median ueber Tor)
   * @param {object} o.buchhaltung Buchhaltung
   * @param {(daten: object) => string} o.signieren  Lizenz signieren
   */
  constructor({ konfig, wege, kursdienst, buchhaltung, signieren, jetzt = Date.now, zufall = crypto.randomBytes, log = STILL }) {
    this.k = konfig;
    this.wege = wege;
    this.kursdienst = kursdienst;
    this.buchhaltung = buchhaltung;
    this.signieren = signieren;
    this.jetzt = jetzt;
    this.zufall = zufall;
    this.log = log;
    this.speicher = new JsonSpeicher(path.join(konfig.datenVerzeichnis, 'bestellungen.json'));
    this.eimer = new TokenEimer(konfig.bestellung.stoss, konfig.bestellung.proStunde, jetzt);
    this.umzugEimer = new TokenEimer(10, konfig.lizenz.umzuegeProStunde, jetzt);
    this.widerrufEimer = new TokenEimer(20, 60, jetzt);
    // Je Tor-Kreis (Audit S2): ein Kreis allein erschoepft die gemeinsamen
    // Grenzen nicht mehr. Ohne Kreis-Kennung gelten nur die gemeinsamen.
    this.bestellEimerJeKreis = new EimerJeSchluessel(3, 6, jetzt);
    this.umzugEimerJeKreis = new EimerJeSchluessel(5, 10, jetzt);
    this.widerrufEimerJeKreis = new EimerJeSchluessel(5, 10, jetzt);
    this.netz = new Begrenzer(3);
    this.inArbeit = 0;
    this.inArbeitJeWeg = new Map(); // Zahlungsweg -> Anzahl gerade zugeteilter Adressen
    this.pruefungen = new Map();
    this.daten = null;
    this.letzteAuszahlungsabfrage = 0;
  }

  // ---------------------------------------------------------------- Laden/Speichern

  async laden() {
    const gespeichert = await this.speicher.laden();
    const d = gespeichert || { format: 2, zaehler: {}, bestellungen: {}, auszahlungenSeit: {} };
    if (d.format !== 2 || typeof d.bestellungen !== 'object' || typeof d.zaehler !== 'object') {
      throw new Error('bestellungen.json hat ein unbekanntes Format');
    }
    d.auszahlungenSeit ||= {};
    for (const [id, weg] of Object.entries(this.wege)) {
      if (weg.art !== 'adresse') continue;
      const z = (d.zaehler[id] ||= { schluessel: weg.fingerabdruck, naechster: 0, freie: [] });
      if (z.schluessel !== weg.fingerabdruck) {
        this.log.warnung(`Zahlungsweg ${id}: anderes Wallet/anderer Schluessel konfiguriert - freie Adressindizes werden verworfen. Bestehende Bestellungen behalten ihre Adressen.`);
        d.zaehler[id] = { schluessel: weg.fingerabdruck, naechster: 0, freie: [] };
      }
      d.zaehler[id].freie = [...new Set(d.zaehler[id].freie)].filter(Number.isInteger).sort((a, b) => a - b);
    }
    this.daten = d;
    if (!gespeichert) await this._speichern();
  }

  _speichern() {
    return this.speicher.speichern(this.daten);
  }

  // ---------------------------------------------------------------- Hilfen

  /**
   * Anzahl der Adressen, die gerade ohne Zahlung reserviert sind (Gap-Limit/Lookahead) -
   * insgesamt oder nur fuer einen Zahlungsweg.
   */
  reservierteAnzahl(wegId = null, { nurOffene = false } = {}) {
    let n = wegId === null ? this.inArbeit : this.inArbeitJeWeg.get(wegId) || 0;
    for (const b of Object.values(this.daten.bestellungen)) {
      const ohneZahlung = nurOffene
        ? b.status === STATUS.OFFEN
        : OHNE_ZAHLUNG.has(b.status) || (b.status === STATUS.WIDERRUFEN && b.empfangen === 0);
      if (b.art === 'adresse' && ohneZahlung && (wegId === null || b.zahlungsweg === wegId)) n++;
    }
    return n;
  }

  _inArbeit(wegId, delta) {
    this.inArbeit += delta;
    this.inArbeitJeWeg.set(wegId, (this.inArbeitJeWeg.get(wegId) || 0) + delta);
  }

  _reserviertBis(b) {
    return b.erstellt + this.k.bestellung.adresseReserviertStunden * STUNDE;
  }

  _indexFreigeben(wegId, index) {
    const z = this.daten.zaehler[wegId];
    if (!z || !Number.isInteger(index) || z.freie.includes(index)) return;
    z.freie.push(index);
    z.freie.sort((a, b) => a - b);
  }

  _toleranz(b) {
    return Math.floor((b.betrag * this.k.toleranzProzent) / 100);
  }

  async _kurs(waehrung) {
    try {
      return await this.netz.ausfuehren(() => this.kursdienst.kurs(waehrung));
    } catch (e) {
      this.log.warnung(`Kursabruf ${waehrung} fehlgeschlagen: ${e.message}`);
      throw new ShopFehler('kurs', 'Der Wechselkurs kann gerade nicht zuverlässig ermittelt werden. Bitte in ein paar Minuten erneut versuchen.');
    }
  }

  /** Teilt eine (Sub-)Adresse zu, die nachweislich noch nie einen Eingang hatte. */
  async _adresseZuteilen(wegId) {
    const weg = this.wege[wegId];
    const z = this.daten.zaehler[wegId];
    for (let versuch = 0; versuch < 10; versuch++) {
      const ausPool = z.freie.length > 0;
      let index = ausPool ? z.freie.shift() : undefined;
      let adresse;
      try {
        if (ausPool) {
          ({ adresse } = await this.netz.ausfuehren(() => weg.adresseVon(index)));
        } else {
          ({ index, adresse } = await this.netz.ausfuehren(() => weg.frischeAdresse(z)));
          z.naechster = Math.max(z.naechster, index + 1);
        }
        const frei = await this.netz.ausfuehren(() => weg.istUnbenutzt(index, adresse));
        if (frei) return { index, adresse };
        this.log.warnung(`Zahlungsweg ${wegId}: Adressindex ${index} hatte bereits Eingaenge und wird nie wieder vergeben.`);
      } catch (e) {
        if (ausPool && e.unbekannt) {
          // Index existiert im (z. B. neu angelegten) Wallet nicht mehr -> aus dem Pool streichen
          this.log.warnung(`Zahlungsweg ${wegId}: freier Index ${index} ist im Wallet unbekannt und wird verworfen.`);
          continue;
        }
        if (index !== undefined) this._indexFreigeben(wegId, index);
        this.log.warnung(`Adresszuteilung (${wegId}) fehlgeschlagen: ${e.message}`);
        throw new ShopFehler('netz', 'Die Zahlungsprüfung ist gerade nicht erreichbar. Bitte in ein paar Minuten erneut versuchen.');
      }
    }
    throw new ShopFehler('netz', 'Es konnte keine unbenutzte Empfangsadresse gefunden werden.');
  }

  // ---------------------------------------------------------------- Bestellungen

  /**
   * Legt eine Bestellung (Zahlungsanfrage) an.
   * @returns {Promise<{bestellung: object, wiederherstellungscode: string}>}
   */
  async erstellen({ geraetecode, zahlungsweg, zustimmung = false, kreis = null } = {}) {
    if (this.k.widerrufsZustimmungErforderlich && zustimmung !== true) {
      throw new ShopFehler('zustimmung', 'Bitte die Zustimmung zur sofortigen Bereitstellung bestätigen.');
    }
    const dev = geraetecodeNormalisieren(geraetecode);
    if (!dev) throw new ShopFehler('geraetecode', 'Der Gerätecode ist ungültig. Bitte genau so übernehmen, wie die App ihn anzeigt.');
    const wegId = zahlungsweg || this.k.zahlungswege.standard;
    // Nur eigene Eintraege (kein "__proto__"/"constructor" aus der Anfrage).
    const weg = typeof wegId === 'string' && Object.hasOwn(this.wege, wegId) ? this.wege[wegId] : null;
    if (!weg) throw new ShopFehler('zahlungsweg', 'Dieser Zahlungsweg ist nicht verfügbar.');
    if (weg.bereit === false) {
      // Netz zum Wallet/Knoten bzw. mempool gestoert (server.js prueft im Hintergrund weiter).
      const andere = Object.values(this.wege).filter((w) => w !== weg && w.bereit !== false).map((w) => w.name);
      throw new ShopFehler('netz', `${weg.name} ist gerade nicht verfügbar. Bitte in einigen Minuten erneut versuchen${andere.length ? ` oder mit ${andere.join(' oder ')} bezahlen` : ''}.`);
    }
    // Obergrenze nur fuer OFFENE Bestellungen (Audit S2): abgelaufene ohne
    // Zahlung halten ihre Adresse zwar weiter frei (spaete Zahlung), blockieren
    // aber keine neuen Bestellungen mehr - sonst konnte ein einzelner Client
    // mit gueltigen Geraetecodes den Shop fuer Tage sperren. Fuer Bitcoin
    // zaehlen weiter alle (Gap-Limit des Betreiber-Wallets, unten).
    if (weg.art === 'adresse' && this.reservierteAnzahl(null, { nurOffene: true }) >= this.k.bestellung.maxReservierteAdressen) {
      throw new ShopFehler('voll', 'Gerade sind sehr viele Bestellungen offen. Bitte später erneut versuchen.');
    }
    // Bitcoin (HD-Wallet): nie mehr unbenutzte Adressen in Folge als das Gap-Limit
    // des Betreiber-Wallets erlaubt - sonst saehe dessen Wallet spaetere Zahlungen nicht.
    if (weg.art === 'adresse' && Number.isInteger(weg.maxUnbenutzt) && this.reservierteAnzahl(wegId) >= weg.maxUnbenutzt) {
      const andere = Object.keys(this.wege).length > 1 ? ' oder einen anderen Zahlungsweg wählen' : '';
      throw new ShopFehler('voll', `Gerade sind sehr viele ${weg.name}-Bestellungen offen. Bitte später erneut versuchen${andere}.`);
    }
    if (!this.bestellEimerJeKreis.versuchen(kreis)) {
      throw new ShopFehler('rate', 'Gerade werden zu viele Bestellungen angelegt. Bitte in einigen Minuten erneut versuchen.');
    }
    if (!this.eimer.versuchen()) {
      this.bestellEimerJeKreis.zurueckgeben(kreis);
      throw new ShopFehler('rate', 'Gerade werden zu viele Bestellungen angelegt. Bitte in einigen Minuten erneut versuchen.');
    }

    const t0 = this.jetzt();
    let id;
    do id = bestellnummerErzeugen(this.zufall);
    while (this.daten.bestellungen[id]);
    const code = wiederherstellungscodeErzeugen(this.zufall);

    let zahlung;
    if (weg.art === 'adresse') this._inArbeit(wegId, 1);
    try {
      if (weg.art === 'adresse') {
        const kurs = await this._kurs(weg.waehrung);
        const { index, adresse } = await this._adresseZuteilen(wegId);
        // Nie unter dem Mindestbetrag des Zahlungswegs (Bitcoin: Staubgrenze).
        const betrag = Math.max(betragBerechnen(this.k.preisEur, kurs.eurProCoin, weg), Number.isSafeInteger(weg.mindestBetrag) ? weg.mindestBetrag : 0);
        zahlung = { index, adresse, referenz: null, kurs, betrag, gueltigBis: null };
      } else {
        let r;
        try {
          r = await this.netz.ausfuehren(() => weg.rechnungErstellen({ bestellnummer: id, preisEur: this.k.preisEur, beschreibung: `${this.k.texte.produkt} (Lizenz)` }));
        } catch (e) {
          this.log.warnung(`Zahlungsdienst ${weg.name}: Rechnung fehlgeschlagen: ${e.message}`);
          throw new ShopFehler('netz', 'Der Zahlungsdienst ist gerade nicht erreichbar. Bitte später erneut versuchen.');
        }
        if (!Number.isSafeInteger(r.betrag) || r.betrag <= 0 || typeof r.adresse !== 'string' || typeof r.referenz !== 'string') {
          throw new ShopFehler('netz', 'Der Zahlungsdienst hat eine ungültige Antwort geliefert.');
        }
        const kurs = r.kurs || (await this._kurs(weg.waehrung).catch(() => null));
        zahlung = { index: null, adresse: r.adresse, referenz: r.referenz, kurs, betrag: r.betrag, gueltigBis: r.gueltigBis || null };
      }
    } catch (e) {
      this.eimer.zurueckgeben();
      this.bestellEimerJeKreis.zurueckgeben(kreis);
      throw e;
    } finally {
      if (weg.art === 'adresse') this._inArbeit(wegId, -1);
    }

    const t = this.jetzt();
    const b = {
      id,
      erstellt: t0,
      gueltigBis: zahlung.gueltigBis || t + this.k.bestellung.gueltigStunden * STUNDE,
      zahlungsweg: wegId,
      art: weg.art,
      waehrung: weg.waehrung,
      schluessel: weg.fingerabdruck,
      index: zahlung.index,
      adresse: zahlung.adresse,
      referenz: zahlung.referenz,
      preisEur: this.k.preisEur,
      kurs: zahlung.kurs,
      betrag: zahlung.betrag,
      status: STATUS.OFFEN,
      empfangen: 0,
      bestaetigt: 0,
      gesperrt: 0,
      bestaetigungen: null,
      zuletztGeprueft: t,
      txids: [],
      zustimmungWiderruf: zustimmung === true,
      geraetecode: dev,
      wiederherstellungHash: hashCode(code),
      fehlversuche: 0,
      sperreBis: 0,
      bezahlt: null,
      rechnungsnummer: null,
      lizenzId: null,
      lizenzen: [],
    };
    this.daten.bestellungen[id] = b;
    await this._speichern();
    return { bestellung: b, wiederherstellungscode: code };
  }

  /** Bestellung (mit zeitbasiertem Ablauf, ohne Netzabfrage) oder null. */
  holen(id) {
    const n = normalisieren(id, BESTELLNUMMER_LAENGE);
    const b = n && this.daten.bestellungen[n];
    if (!b) return null;
    if (b.status === STATUS.OFFEN && this.jetzt() > b.gueltigBis) {
      b.status = STATUS.ABGELAUFEN;
      this._speichern().catch((e) => this.log.fehler('Speichern fehlgeschlagen: ' + e.message));
    }
    return b;
  }

  /** Aktuell gueltige Lizenz (zuletzt ausgestellte) einer bezahlten Bestellung. */
  aktuelleLizenz(b) {
    return b && b.lizenzen.length ? b.lizenzen[b.lizenzen.length - 1] : null;
  }

  /** Prueft den Zahlungsstand, wenn die letzte Pruefung aelter als `mindestAbstandMs` ist. */
  async aktualisieren(id, { mindestAbstandMs = 30_000 } = {}) {
    const b = this.holen(id);
    if (!b || !ZU_PRUEFEN.has(b.status)) return b;
    if (b.zuletztGeprueft && this.jetzt() - b.zuletztGeprueft < mindestAbstandMs) return b;
    await this._pruefenEinmal(b);
    return this.daten.bestellungen[b.id] || null;
  }

  _pruefenEinmal(b) {
    let lauf = this.pruefungen.get(b.id);
    if (!lauf) {
      lauf = this._pruefen(b).finally(() => this.pruefungen.delete(b.id));
      this.pruefungen.set(b.id, lauf);
    }
    return lauf;
  }

  async _pruefen(b) {
    const weg = this.wege[b.zahlungsweg];
    if (!weg) return; // Zahlungsweg inzwischen abgeschaltet
    const min = this.k.mindestBestaetigungen;
    const stand =
      b.art === 'adresse'
        ? await this.netz.ausfuehren(() => weg.zahlungsstand(b.index, b.adresse, min))
        : await this.netz.ausfuehren(() => weg.rechnungsstatus(b.referenz));
    if (this.daten.bestellungen[b.id] !== b || b.status === STATUS.BEZAHLT) return;
    for (const f of ['empfangen', 'bestaetigt']) {
      if (!Number.isSafeInteger(stand[f]) || stand[f] < 0) throw new Error('Ungueltiger Zahlungsstand');
    }
    const t = this.jetzt();
    b.zuletztGeprueft = t;
    b.empfangen = stand.empfangen;
    b.bestaetigt = stand.bestaetigt;
    b.gesperrt = stand.gesperrt || 0;
    b.bestaetigungen = stand.bestaetigungen ?? null;
    b.txids = (stand.txids || []).slice(0, 20);
    if (b.status === STATUS.WIDERRUFEN) {
      // Zahlungsstand weiter erfassen (fuer die Rueckzahlung) - aber nie eine Lizenz.
      await this._speichern();
      return;
    }
    const bewertung = bewerteZahlung({ betrag: b.betrag, empfangen: b.empfangen, bestaetigt: b.bestaetigt, toleranz: this._toleranz(b) });
    if (bewertung === STATUS.BEZAHLT) {
      await this._alsBezahlt(b, t, stand);
    } else if (bewertung === STATUS.OFFEN) {
      b.status = t > b.gueltigBis || stand.endgueltig ? STATUS.ABGELAUFEN : STATUS.OFFEN;
    } else {
      b.status = bewertung;
    }
    await this._speichern();
  }

  async _alsBezahlt(b, t, stand) {
    const weg = this.wege[b.zahlungsweg];
    let kursBeiZahlung = null;
    try {
      kursBeiZahlung = await Promise.race([
        this.kursdienst.kurs(b.waehrung),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitueberschreitung')), 20_000).unref?.()),
      ]);
    } catch {
      kursBeiZahlung = null; // Buchung trotzdem; Referenzkurs der Bestellung bleibt massgeblich
    }
    // Zusatzschutz: widerrufen() wartet laufende Pruefungen ab - sollte sich der
    // Status trotzdem waehrend des Kursabrufs geaendert haben, keine Lizenz.
    if (b.status === STATUS.WIDERRUFEN || this.daten.bestellungen[b.id] !== b) return;
    const lizenzIdNeu = bestellnummerErzeugen(this.zufall);
    const ueberzahlung = Math.max(0, b.empfangen - b.betrag);
    // Buchung zuerst (idempotent je Bestellung). Schlaegt sie fehl, bleibt die
    // Bestellung unbezahlt und wird beim naechsten Durchlauf erneut versucht.
    const eintrag = await this.buchhaltung.einnahmeBuchen({
      bestellung: b.id,
      lizenz: lizenzIdNeu,
      zahlungsweg: b.zahlungsweg,
      anbieter: weg ? weg.name : b.zahlungsweg,
      verwahrung: b.art === 'rechnung' ? 'zahlungsdienst' : 'eigenes-wallet',
      betragEur: this.k.preisEur.toFixed(2),
      waehrung: b.waehrung,
      betragCoin: atomarZuDezimal(BigInt(b.betrag), waehrungsDaten(b, weg).stellen),
      empfangenCoin: atomarZuDezimal(BigInt(b.empfangen), waehrungsDaten(b, weg).stellen),
      ueberzahlungCoin: atomarZuDezimal(BigInt(ueberzahlung), waehrungsDaten(b, weg).stellen),
      kurs: b.kurs,
      kursBeiZahlung,
      txids: b.txids,
      subadresseIndex: b.index,
      anbieterReferenz: b.referenz,
      umsatzsteuer: { kleinunternehmer: this.k.umsatzsteuer.kleinunternehmer, satz: this.k.umsatzsteuer.kleinunternehmer ? 0 : this.k.umsatzsteuer.steuersatz },
    });
    // Gebuehren eines externen Zahlungsdienstes mitbuchen
    for (const g of (stand && stand.gebuehren) || []) {
      await this.buchhaltung.gebuehrBuchen({
        datum: new Date(t).toISOString().slice(0, 10),
        waehrung: g.waehrung,
        betrag: g.betrag,
        betragEur: g.betragEur,
        dienst: weg ? weg.name : b.zahlungsweg,
        referenz: g.referenz || `${b.referenz}-gebuehr`,
        notiz: `Bestellung ${b.id}`,
        quelle: 'zahlungsdienst',
      });
    }
    const lic = eintrag.lizenz;
    const iat = Math.floor(t / 1000);
    const lizenz = this.signieren({ lic, dev: b.geraetecode, ord: b.id, iat, feat: this.k.lizenz.features });
    b.status = STATUS.BEZAHLT;
    b.bezahlt = t;
    b.rechnungsnummer = eintrag.rechnungsnummer;
    b.lizenzId = lic;
    b.lizenzen = [{ dev: b.geraetecode, iat, lizenz }];
    this.log.info(`Zahlung bestaetigt, Lizenz ausgestellt (${eintrag.rechnungsnummer}).`);
  }

  // ---------------------------------------------------------------- Umzug auf ein neues Geraet

  /**
   * Stellt die Lizenz fuer ein neues Geraet aus (begrenzt auf maxAktivierungen insgesamt).
   * @returns {Promise<{bestellung: object, lizenz: string, aktivierungen: number, neu: boolean}>}
   */
  async umziehen({ bestellnummer, wiederherstellungscode, geraetecode, kreis = null }) {
    const falsch = () => new ShopFehler('code', 'Bestellnummer oder Wiederherstellungscode stimmt nicht.');
    const b = this.holen(String(bestellnummer || ''));
    if (!b || b.status !== STATUS.BEZAHLT) throw falsch();
    // Grenzen erst fuer eine existierende Bestellung belasten (Audit S2) -
    // sinnlose Anfragen sperrten sonst den Umzug fuer alle. Fehlversuche je
    // Bestellung begrenzt _codePruefen.
    if (!this.umzugEimerJeKreis.versuchen(kreis) || !this.umzugEimer.versuchen()) throw new ShopFehler('rate', 'Zu viele Anfragen. Bitte später erneut versuchen.');
    const t = this.jetzt();
    await this._codePruefen(b, wiederherstellungscode, falsch);
    const dev = geraetecodeNormalisieren(geraetecode);
    if (!dev) throw new ShopFehler('geraetecode', 'Der Gerätecode ist ungültig.');
    // Schon einmal fuer dieses Geraet ausgestellt -> dieselbe Lizenz, keine weitere Aktivierung
    const vorhanden = b.lizenzen.find((l) => l.dev === dev);
    if (vorhanden) {
      await this._speichern();
      return { bestellung: b, lizenz: vorhanden.lizenz, aktivierungen: b.lizenzen.length, neu: false };
    }
    if (b.lizenzen.length >= this.k.lizenz.maxAktivierungen) {
      await this._speichern();
      throw new ShopFehler('limit', `Die Lizenz wurde bereits auf ${b.lizenzen.length} Geräten aktiviert (Höchstzahl erreicht).`);
    }
    const iat = Math.floor(t / 1000);
    const lizenz = this.signieren({ lic: b.lizenzId, dev, ord: b.id, iat, feat: this.k.lizenz.features });
    b.lizenzen.push({ dev, iat, lizenz });
    await this._speichern();
    this.log.info(`Lizenz umgezogen (Aktivierung ${b.lizenzen.length} von ${this.k.lizenz.maxAktivierungen}).`);
    return { bestellung: b, lizenz, aktivierungen: b.lizenzen.length, neu: true };
  }

  /** Wiederherstellungscode pruefen (konstante Zeit); 5 Fehlversuche -> 15 min Sperre. Wirft falsch(). */
  async _codePruefen(b, wiederherstellungscode, falsch) {
    const t = this.jetzt();
    if (b.sperreBis > t) throw new ShopFehler('gesperrt', 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
    const code = normalisieren(String(wiederherstellungscode || ''), WIEDERHERSTELLUNGSCODE_LAENGE);
    const ok = code !== null && crypto.timingSafeEqual(Buffer.from(hashCode(code), 'hex'), Buffer.from(b.wiederherstellungHash, 'hex'));
    if (!ok) {
      b.fehlversuche = (b.fehlversuche || 0) + 1;
      if (b.fehlversuche >= 5) {
        b.fehlversuche = 0;
        b.sperreBis = t + 15 * MINUTE;
      }
      await this._speichern();
      throw falsch();
    }
    b.fehlversuche = 0;
  }

  // ---------------------------------------------------------------- Widerruf ("Vertrag widerrufen", § 356a BGB)

  /**
   * Kann diese Bestellung (noch) widerrufen werden? Bis zur Bereitstellung der
   * Lizenz immer. Danach nur, wenn ohne ausdrueckliche Zustimmung zur
   * sofortigen Bereitstellung bezahlt wurde - dann innerhalb von 14 Tagen.
   * @returns {{ok: true} | {ok: false, grund: string}}
   */
  widerrufMoeglich(b) {
    if (b.status !== STATUS.BEZAHLT) return { ok: true };
    if (!b.zustimmungWiderruf && this.jetzt() <= b.erstellt + WIDERRUFSFRIST_MS) return { ok: true };
    return { ok: false, grund: 'erloschen' };
  }

  /**
   * Widerruf erklaeren. Mit nurPruefen=true wird nur geprueft (Vorschau vor
   * "Widerruf bestaetigen"), nichts geaendert. Ein erneuter Aufruf fuer eine
   * schon widerrufene Bestellung ergaenzt bzw. aendert Name und
   * Rueckzahlungsadresse (solange noch nicht zurueckgezahlt); Zeitpunkt und
   * Inhalt der Erklaerung bleiben.
   * @returns {Promise<{bestellung: object, neu: boolean}>}
   */
  async widerrufen({ bestellnummer, wiederherstellungscode, name = '', rueckzahlAdresse = '', nurPruefen = false, quelle = 'shop', kreis = null } = {}) {
    const falsch = () => new ShopFehler('code', 'Bestellnummer oder Wiederherstellungscode stimmt nicht.');
    let b = this.holen(String(bestellnummer || ''));
    if (!b) throw falsch();
    // Grenzen erst fuer eine existierende Bestellung (Audit S2): sinnlose
    // Anfragen sperrten sonst das gesetzliche Widerrufsrecht fuer alle.
    if (!this.widerrufEimerJeKreis.versuchen(kreis) || !this.widerrufEimer.versuchen()) throw new ShopFehler('rate', 'Zu viele Anfragen. Bitte später erneut versuchen.');
    // Eine laufende Zahlungspruefung erst abschliessen lassen: entweder wird
    // die Bestellung dabei bezahlt (dann gilt das unten) oder sie bleibt offen.
    // Danach laeuft alles bis zum Setzen des Status ohne Unterbrechung - eine
    // spaeter startende Pruefung sieht "widerrufen" und stellt keine Lizenz aus.
    while (this.pruefungen.has(b.id)) await this.pruefungen.get(b.id).catch(() => {});
    b = this.daten.bestellungen[b.id];
    if (!b) throw falsch();
    await this._codePruefen(b, wiederherstellungscode, falsch);
    if (this.daten.bestellungen[b.id] !== b) throw falsch();

    const sauber = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const adresse = String(rueckzahlAdresse || '').trim();
    if (adresse && !rueckzahlAdresseGueltig(b.waehrung, adresse)) {
      throw new ShopFehler('rueckzahlung', `Die Rückzahlungsadresse ist keine gültige ${b.waehrung === 'BTC' ? 'Bitcoin' : 'Monero'}-Adresse (Prüfsumme stimmt nicht). Bitte genau kopieren.`);
    }

    if (b.status === STATUS.WIDERRUFEN) {
      if (nurPruefen) return { bestellung: b, neu: false };
      if (this._erstatteteBestellungen().has(b.id)) throw new ShopFehler('erstattet', 'Für diese Bestellung wurde bereits zurückgezahlt.');
      let geaendert = false;
      if (sauber && sauber !== b.widerruf.name) { b.widerruf.name = sauber; geaendert = true; }
      if (adresse && adresse !== b.widerruf.rueckzahlAdresse) { b.widerruf.rueckzahlAdresse = adresse; geaendert = true; }
      if (geaendert) await this._speichern();
      return { bestellung: b, neu: false };
    }

    const moeglich = this.widerrufMoeglich(b);
    if (!moeglich.ok) {
      throw new ShopFehler(
        'erloschen',
        `Für diese Bestellung ist das Widerrufsrecht erloschen: Die Lizenz wurde am ${new Date(b.bezahlt).toISOString().slice(0, 10).split('-').reverse().join('.')} bereitgestellt, nachdem der sofortigen Bereitstellung ausdrücklich zugestimmt wurde. Bei Fragen bitte an die Kontaktadresse im Impressum wenden.`,
      );
    }
    if (nurPruefen) return { bestellung: b, neu: false };

    b.widerruf = {
      zeit: this.jetzt(),
      quelle: quelle === 'app' ? 'app' : 'shop',
      name: sauber || null,
      rueckzahlAdresse: adresse || null,
      statusVorher: b.status,
      empfangenBeiWiderruf: b.empfangen,
      lizenzAusgestellt: b.status === STATUS.BEZAHLT,
    };
    b.status = STATUS.WIDERRUFEN;
    await this._speichern();
    this.log.info('Widerruf eingegangen' + (b.empfangen > 0 ? ' (mit Zahlungseingang - Rueckzahlung noetig).' : '.'));
    return { bestellung: b, neu: true };
  }

  /** Widerrufene Bestellungen mit Zahlungseingang, deren Rueckzahlung noch nicht gebucht ist. */
  offeneErstattungen() {
    const erstattet = this._erstatteteBestellungen();
    return Object.values(this.daten.bestellungen).filter((b) => b.status === STATUS.WIDERRUFEN && b.empfangen > 0 && !erstattet.has(b.id));
  }

  /** Bestellnummern mit gebuchter Rueckzahlung (Buchhaltung, Journal "sonstige", art "erstattung", nicht storniert). */
  _erstatteteBestellungen() {
    let eintraege = [];
    try {
      eintraege = this.buchhaltung.lesen('sonstige');
    } catch {
      return new Set();
    }
    const storniert = new Set(eintraege.filter((e) => e.typ === 'storno').map((e) => e.stornoVon));
    return new Set(eintraege.filter((e) => e.art === 'erstattung' && !storniert.has(e.seq)).map((e) => e.bestellung));
  }


  // ---------------------------------------------------------------- Externe Benachrichtigung

  /** Benachrichtigung eines Zahlungsdienstes: nur Ausloeser fuer eine sofortige Abfrage. */
  async benachrichtigung(wegId, kopfzeilen, rohKoerper) {
    const weg = this.wege[wegId];
    if (!weg || weg.art !== 'rechnung' || typeof weg.webhookPruefen !== 'function') throw new ShopFehler('unbekannt', 'Nicht verfügbar');
    let referenz;
    try {
      referenz = weg.webhookPruefen(kopfzeilen, rohKoerper);
    } catch {
      throw new ShopFehler('signatur', 'Ungültige Signatur');
    }
    const b = Object.values(this.daten.bestellungen).find((x) => x.zahlungsweg === wegId && x.referenz === referenz);
    if (b && ZU_PRUEFEN.has(b.status)) await this._pruefenEinmal(b);
    return true;
  }

  // ---------------------------------------------------------------- Hintergrund

  async aufraeumen() {
    const t = this.jetzt();
    let geaendert = false;
    let erstattet = null; // erst bei Bedarf aus der Buchhaltung lesen
    for (const b of Object.values(this.daten.bestellungen)) {
      if (this.pruefungen.has(b.id)) continue;
      if (b.status === STATUS.OFFEN && t > b.gueltigBis) {
        b.status = STATUS.ABGELAUFEN;
        geaendert = true;
      }
      if (b.status === STATUS.ABGELAUFEN) {
        const bis = this._reserviertBis(b);
        // Erst loeschen, wenn nach Ende der Reservierung noch einmal geprueft wurde.
        if (t > bis && b.zuletztGeprueft > bis && b.empfangen === 0) {
          delete this.daten.bestellungen[b.id];
          if (b.art === 'adresse' && this.daten.zaehler[b.zahlungsweg]?.schluessel === b.schluessel) this._indexFreigeben(b.zahlungsweg, b.index);
          geaendert = true;
        }
      } else if (b.status === STATUS.UNTERZAHLT || b.status === STATUS.UNBESTAETIGT) {
        if (t > b.erstellt + this.k.bestellung.unvollstaendigAufbewahrenTage * TAG) {
          const weg = this.wege[b.zahlungsweg];
          await this.buchhaltung.sonstigesBuchen({
            art: 'unvollstaendige_bestellung',
            bestellung: b.id,
            waehrung: b.waehrung,
            betragCoin: atomarZuDezimal(BigInt(b.empfangen), waehrungsDaten(b, weg).stellen),
            wertEur: b.kurs ? ((b.empfangen / waehrungsDaten(b, weg).einheit) * b.kurs.eurProCoin).toFixed(2) : null,
            txids: b.txids,
            notiz: `Bestellung nicht abgeschlossen (${b.status}); ggf. Erstattung auf Anfrage`,
          });
          delete this.daten.bestellungen[b.id];
          geaendert = true;
        }
      } else if (b.status === STATUS.BEZAHLT) {
        if (t > b.bezahlt + this.k.bestellung.bezahlteAufbewahrenTage * TAG) {
          delete this.daten.bestellungen[b.id];
          geaendert = true;
        }
      } else if (b.status === STATUS.WIDERRUFEN) {
        // Nach Ende der Reservierung und einer letzten Pruefung: ohne Zahlung
        // loeschen (Adresse wieder frei); mit Zahlung erst, wenn die
        // Rueckzahlung gebucht ist (werkzeuge/widerrufe.js) - Name und
        // Rueckzahlungsadresse verschwinden dann mit.
        const bis = this._reserviertBis(b);
        if (t > bis && b.zuletztGeprueft > bis) {
          if (b.empfangen === 0) {
            delete this.daten.bestellungen[b.id];
            if (b.art === 'adresse' && this.daten.zaehler[b.zahlungsweg]?.schluessel === b.schluessel) this._indexFreigeben(b.zahlungsweg, b.index);
            geaendert = true;
          } else {
            erstattet ||= this._erstatteteBestellungen();
            if (erstattet.has(b.id)) {
              delete this.daten.bestellungen[b.id];
              geaendert = true;
            }
          }
        }
      }
    }
    if (geaendert) await this._speichern();
  }

  _faellig(b, t) {
    if (!ZU_PRUEFEN.has(b.status)) return false;
    const alter = t - (b.zuletztGeprueft || 0);
    if (b.status === STATUS.ABGELAUFEN || b.status === STATUS.WIDERRUFEN) {
      const bis = this._reserviertBis(b);
      if (t > bis && b.zuletztGeprueft <= bis) return true; // letzte Pruefung vor dem Loeschen
      if (b.status === STATUS.WIDERRUFEN && t > bis) return false; // danach nur noch Rueckzahlung
      return alter >= 15 * MINUTE;
    }
    return alter >= this.k.zahlungswege.pruefIntervallSek * 1000;
  }

  async _auszahlungenAbholen() {
    const t = this.jetzt();
    if (t - this.letzteAuszahlungsabfrage < STUNDE) return;
    this.letzteAuszahlungsabfrage = t;
    for (const [id, weg] of Object.entries(this.wege)) {
      if (weg.art !== 'rechnung' || typeof weg.auszahlungen !== 'function') continue;
      try {
        const seit = this.daten.auszahlungenSeit[id] || 0;
        const liste = await this.netz.ausfuehren(() => weg.auszahlungen(seit));
        for (const a of liste) {
          await this.buchhaltung.auszahlungBuchen({ ...a, dienst: weg.name, quelle: 'zahlungsdienst' });
        }
        this.daten.auszahlungenSeit[id] = t;
        await this._speichern();
      } catch (e) {
        this.log.warnung(`Auszahlungen von ${weg.name} nicht abrufbar: ${e.message}`);
      }
    }
  }

  /** Ein Durchlauf der Hintergrundpruefung (vom Server periodisch aufgerufen). */
  async hintergrundLauf() {
    await this.aufraeumen();
    const t = this.jetzt();
    const faellig = Object.values(this.daten.bestellungen).filter((b) => this._faellig(b, t));
    for (const b of faellig) {
      try {
        await this._pruefenEinmal(b);
      } catch (e) {
        this.log.warnung('Zahlungspruefung fehlgeschlagen: ' + e.message);
        break; // Netz gestoert - naechster Durchlauf versucht es erneut
      }
    }
    await this._auszahlungenAbholen();
    await this.aufraeumen();
  }
}
