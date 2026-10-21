// Laden und strenges Pruefen der Konfiguration (config.json).
// Unbekannte Schluessel sind ein Fehler (Tippfehler sollen auffallen).
// Schluessel, die mit "_" beginnen, gelten als Kommentar und werden ignoriert.

import fs from 'node:fs';
import path from 'node:path';
import { ladeKontoSchluessel, SchluesselFehler } from './bip84.js';
import { istMoneroHauptadresse } from './zahlung/monero.js';

/** zpub aus dem offiziellen BIP84-Testvektor ("abandon ... about"). Der private Schluessel ist oeffentlich bekannt! */
export const BIP84_TESTVEKTOR_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

export const MEMPOOL_ONION_STANDARD = 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion';

export const STANDARD_KURSQUELLEN = {
  XMR: [
    { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XMREUR', pfad: 'result.XXMRZEUR.c.0' },
    { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=eur', pfad: 'monero.eur' },
  ],
  BTC: [
    { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTEUR', pfad: 'result.XXBTZEUR.c.0' },
    { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur', pfad: 'bitcoin.eur' },
  ],
};

export const STANDARD_BESCHREIBUNG = [
  'Malachi ist ein privater Peer-to-Peer-Messenger für Android: Nachrichten werden Ende-zu-Ende-verschlüsselt direkt zwischen den Geräten übertragen, bei Bedarf über Tor. Die App ist kostenlos.',
  'Die Vollversion schaltet einmalig die Extra-Sicherheitsfunktionen frei, z. B. die Notfall-PIN (Duress-PIN), die bei Eingabe unter Zwang Daten löscht. App-PIN, Verschlüsselung, Tor, Gruppen, Dateien und Designs bleiben kostenlos.',
];

export const STANDARD_HINWEISE = [
  'Die Lizenz gilt für ein Gerät. Bei Gerätewechsel oder Neuinstallation kannst du sie mit deinem Wiederherstellungscode umziehen (insgesamt bis zu 3 Aktivierungen).',
  'Die App prüft die Lizenz offline mit einer digitalen Signatur – es gibt keine Verbindung zu einem Lizenzserver.',
  'Ehrlich gesagt: Da der Quelltext offen werden soll, lässt sich die Prüfung durch Umbau der App umgehen. Die Lizenz ist eine faire Unterstützung der Entwicklung, kein Kopierschutz.',
  'Testphase: Die App befindet sich noch in Entwicklung. Fehler sind möglich.',
  'Lizenz der App: Die Veröffentlichung des Quelltexts unter der AGPL ist geplant, aber noch nicht erfolgt.',
  'Kein Konto, keine E-Mail: Bestellnummer und Wiederherstellungscode sind dein einziger Nachweis – bitte notieren.',
];

const textListe = (standard = []) => ({ typ: 'textliste', standard });

const SCHEMA = {
  preisEur: { typ: 'zahl', min: 0.5, max: 10_000, pflicht: true },
  mindestBestaetigungen: { typ: 'ganz', min: 1, max: 30, standard: 1 },
  toleranzProzent: { typ: 'zahl', min: 0, max: 5, standard: 0 },
  widerrufsZustimmungErforderlich: { typ: 'bool', standard: true },
  datenVerzeichnis: { typ: 'text', pflicht: true },
  bestellung: {
    typ: 'objekt',
    felder: {
      gueltigStunden: { typ: 'ganz', min: 1, max: 168, standard: 24 },
      adresseReserviertStunden: { typ: 'ganz', min: 1, max: 24 * 60, standard: 72 },
      unvollstaendigAufbewahrenTage: { typ: 'ganz', min: 1, max: 365, standard: 30 },
      bezahlteAufbewahrenTage: { typ: 'ganz', min: 30, max: 36_500, standard: 3650 },
      maxReservierteAdressen: { typ: 'ganz', min: 1, max: 1000, standard: 100 },
      proStunde: { typ: 'ganz', min: 1, max: 10_000, standard: 30 },
      stoss: { typ: 'ganz', min: 1, max: 1000, standard: 5 },
    },
  },
  lizenz: {
    typ: 'objekt',
    felder: {
      schluesselDatei: { typ: 'text', pflicht: true },
      maxAktivierungen: { typ: 'ganz', min: 1, max: 20, standard: 3 },
      features: { typ: 'textliste', standard: ['pro'] },
      umzuegeProStunde: { typ: 'ganz', min: 1, max: 1000, standard: 20 },
    },
  },
  zahlungswege: {
    typ: 'objekt',
    felder: {
      standard: { typ: 'auswahl', werte: ['xmr', 'btc', 'extern'], standard: 'xmr' },
      pruefIntervallSek: { typ: 'ganz', min: 15, max: 3600, standard: 60 },
      xmr: {
        typ: 'objekt',
        felder: {
          aktiv: { typ: 'bool', standard: true },
          hauptadresse: { typ: 'text', standard: '' },
          walletRpcUrl: { typ: 'text', standard: 'http://127.0.0.1:18082/json_rpc' },
          walletRpcLogin: { typ: 'text', standard: 'credential:wallet-rpc-login' },
          kontoIndex: { typ: 'ganz', min: 0, max: 1000, standard: 0 },
          // Onion-Knoten (host:port) als Ersatz, falls der Knoten aus wallet-rpc.conf nicht antwortet.
          ersatzKnoten: { typ: 'textliste', standard: [] },
        },
      },
      btc: {
        typ: 'objekt',
        felder: {
          aktiv: { typ: 'bool', standard: false },
          zpub: { typ: 'text', standard: '' },
          startIndex: { typ: 'ganz', min: 0, max: 1_000_000, standard: 0 },
          gapLimit: { typ: 'ganz', min: 2, max: 10_000, standard: 20 },
          mempoolOnion: { typ: 'text', standard: MEMPOOL_ONION_STANDARD },
          mempoolClearnet: { typ: 'text', standard: 'https://mempool.space' },
          clearnetFallback: { typ: 'bool', standard: false },
        },
      },
      extern: {
        typ: 'objekt',
        felder: {
          aktiv: { typ: 'bool', standard: false },
          adapter: { typ: 'text', standard: '' },
          einstellungen: { typ: 'frei', standard: {} },
        },
      },
    },
  },
  kurs: {
    typ: 'objekt',
    felder: {
      mindestQuellen: { typ: 'ganz', min: 1, max: 10, standard: 2 },
      maxAbweichungProzent: { typ: 'zahl', min: 0.5, max: 50, standard: 5 },
      cacheSek: { typ: 'ganz', min: 30, max: 86_400, standard: 300 },
      quellen: { typ: 'quellen', standard: STANDARD_KURSQUELLEN },
    },
  },
  tor: {
    typ: 'objekt',
    felder: {
      socksHost: { typ: 'text', standard: '127.0.0.1' },
      socksPort: { typ: 'ganz', min: 1, max: 65_535, standard: 9050 },
      timeoutSek: { typ: 'ganz', min: 5, max: 300, standard: 60 },
    },
  },
  server: {
    typ: 'objekt',
    felder: {
      host: { typ: 'text', standard: '127.0.0.1' },
      port: { typ: 'ganz', min: 1024, max: 65_535, standard: 8085 },
    },
  },
  api: {
    typ: 'objekt',
    felder: {
      aktiv: { typ: 'bool', standard: true },
    },
  },
  umsatzsteuer: {
    typ: 'objekt',
    felder: {
      kleinunternehmer: { typ: 'bool', standard: true },
      steuersatz: { typ: 'zahl', min: 0, max: 30, standard: 19 },
      hinweisText: { typ: 'text', standard: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).' },
    },
  },
  buchhaltung: {
    typ: 'objekt',
    felder: {
      rechnungsPraefix: { typ: 'text', standard: 'MAL' },
      sicherungSchluessel: { typ: 'text', standard: '' },
      sicherungenBehalten: { typ: 'ganz', min: 1, max: 3650, standard: 30 },
    },
  },
  verkauf: {
    typ: 'objekt',
    felder: {
      modus: { typ: 'auswahl', werte: ['manuell', 'kraken'], standard: 'manuell' },
      zeitplan: { typ: 'auswahl', werte: ['schwellenwert', 'taeglich'], standard: 'schwellenwert' },
      stundeUtc: { typ: 'ganz', min: 0, max: 23, standard: 3 },
      mindestAbstandMinuten: { typ: 'ganz', min: 5, max: 10_080, standard: 60 },
      kraken: {
        typ: 'objekt',
        felder: {
          zugang: { typ: 'text', standard: 'credential:kraken-api' },
          waehrung: { typ: 'auswahl', werte: ['BTC'], standard: 'BTC' },
          schwellenwert: { typ: 'text', standard: '0.001' },
          reserve: { typ: 'text', standard: '0' },
          nurProbelauf: { typ: 'bool', standard: true },
        },
      },
    },
  },
  texte: {
    typ: 'objekt',
    felder: {
      name: { typ: 'text', standard: 'Malachi' },
      produkt: { typ: 'text', standard: 'Malachi Vollversion' },
      untertitel: { typ: 'text', standard: 'Privater Peer-to-Peer-Messenger mit Tor' },
      beschreibung: textListe(STANDARD_BESCHREIBUNG),
      hinweise: textListe(STANDARD_HINWEISE),
    },
  },
  rechtliches: {
    typ: 'objekt',
    felder: {
      anbieter: textListe(),
      impressum: textListe(),
      widerrufsbelehrung: textListe(),
      datenschutzZusatz: textListe(),
    },
  },
};

export class KonfigFehler extends Error {
  constructor(fehler) {
    super('Konfiguration ungueltig:\n  - ' + fehler.join('\n  - '));
    this.fehler = fehler;
  }
}

function pruefeQuellen(v, p, fehler) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    fehler.push(`${p}: Objekt { "XMR": [...], "BTC": [...] } erwartet`);
    return STANDARD_KURSQUELLEN;
  }
  const aus = {};
  for (const [w, liste] of Object.entries(v)) {
    if (w.startsWith('_')) continue;
    if (!['XMR', 'BTC'].includes(w) || !Array.isArray(liste) || liste.length > 10) {
      fehler.push(`${p}.${w}: Liste von Quellen erwartet (nur XMR, BTC)`);
      continue;
    }
    aus[w] = [];
    for (const [i, q] of liste.entries()) {
      const ok =
        q && typeof q === 'object' &&
        typeof q.name === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(q.name) &&
        typeof q.url === 'string' && (/^https:\/\/[a-z0-9.-]+(:\d+)?\/\S*$/i.test(q.url) || /^http:\/\/[a-z2-7]{56}\.onion(:\d+)?\/\S*$/.test(q.url)) &&
        typeof q.pfad === 'string' && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(q.pfad);
      if (!ok) fehler.push(`${p}.${w}[${i}]: { "name", "url" (https:// oder http://…onion), "pfad" } erwartet`);
      else aus[w].push({ name: q.name, url: q.url, pfad: q.pfad });
    }
  }
  return aus;
}

function pruefeNachSchema(schema, wert, pfad, fehler) {
  const aus = {};
  if (wert === null || typeof wert !== 'object' || Array.isArray(wert)) {
    fehler.push(`${pfad || 'Konfiguration'}: Objekt erwartet`);
    wert = {};
  }
  for (const k of Object.keys(wert)) {
    if (!k.startsWith('_') && !Object.hasOwn(schema, k)) fehler.push(`${pfad}${k}: unbekannter Schluessel (Tippfehler?)`);
  }
  for (const [k, spez] of Object.entries(schema)) {
    const p = pfad + k;
    const v = wert[k];
    if (spez.typ === 'objekt') {
      aus[k] = pruefeNachSchema(spez.felder, v === undefined ? {} : v, p + '.', fehler);
      continue;
    }
    if (v === undefined || v === null) {
      if (spez.pflicht) fehler.push(`${p}: Angabe fehlt`);
      aus[k] = structuredClone(spez.standard);
      continue;
    }
    switch (spez.typ) {
      case 'text':
        if (typeof v !== 'string' || v.length > 2000) fehler.push(`${p}: Text erwartet`);
        else if (spez.pflicht && v.trim() === '') fehler.push(`${p}: darf nicht leer sein`);
        aus[k] = typeof v === 'string' ? v.trim() : spez.standard;
        break;
      case 'auswahl':
        if (!spez.werte.includes(v)) fehler.push(`${p}: erlaubt sind ${spez.werte.join(', ')}`);
        aus[k] = v;
        break;
      case 'bool':
        if (typeof v !== 'boolean') fehler.push(`${p}: true oder false erwartet`);
        aus[k] = v === true;
        break;
      case 'ganz':
      case 'zahl':
        if (typeof v !== 'number' || !Number.isFinite(v) || (spez.typ === 'ganz' && !Number.isInteger(v))) {
          fehler.push(`${p}: ${spez.typ === 'ganz' ? 'ganze Zahl' : 'Zahl'} erwartet`);
        } else if (v < spez.min || v > spez.max) {
          fehler.push(`${p}: muss zwischen ${spez.min} und ${spez.max} liegen`);
        }
        aus[k] = v;
        break;
      case 'textliste':
        if (!Array.isArray(v) || v.length > 60 || v.some((z) => typeof z !== 'string' || z.length > 2000)) {
          fehler.push(`${p}: Liste von Texten erwartet`);
          aus[k] = spez.standard;
        } else aus[k] = v.map((z) => z.trim());
        break;
      case 'frei':
        if (typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > 20_000) fehler.push(`${p}: Objekt erwartet`);
        aus[k] = v;
        break;
      case 'quellen':
        aus[k] = pruefeQuellen(v, p, fehler);
        break;
      default:
        throw new Error('Schemafehler');
    }
  }
  return aus;
}

/**
 * Prueft ein eingelesenes Konfigurationsobjekt.
 * @param {object} roh
 * @param {{ basisVerzeichnis?: string, erlaubeTestwerte?: boolean }} optionen
 * @returns {{ konfig: object, btcKonto: object|null }}
 */
export function pruefeKonfiguration(roh, { basisVerzeichnis = process.cwd(), erlaubeTestwerte = false } = {}) {
  const fehler = [];
  const konfig = pruefeNachSchema(SCHEMA, roh, '', fehler);
  const zw = konfig.zahlungswege;

  if (!['127.0.0.1', '::1', 'localhost'].includes(konfig.server.host)) {
    fehler.push('server.host: Der Shop darf nur auf 127.0.0.1 / ::1 lauschen (Erreichbarkeit ausschliesslich ueber Tor).');
  }

  const aktiv = ['xmr', 'btc', 'extern'].filter((w) => zw[w].aktiv);
  if (!aktiv.length) fehler.push('zahlungswege: mindestens ein Zahlungsweg muss aktiv sein');
  if (!aktiv.includes(zw.standard)) fehler.push(`zahlungswege.standard: "${zw.standard}" ist nicht aktiv`);

  if (zw.xmr.aktiv) {
    if (!istMoneroHauptadresse(zw.xmr.hauptadresse)) {
      fehler.push('zahlungswege.xmr.hauptadresse: Monero-Hauptadresse (95 Zeichen, beginnt mit 4) erwartet');
    }
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/json_rpc$/.test(zw.xmr.walletRpcUrl)) {
      fehler.push('zahlungswege.xmr.walletRpcUrl: nur lokal erlaubt, z. B. http://127.0.0.1:18082/json_rpc');
    }
    if (zw.xmr.ersatzKnoten.length > 20 || zw.xmr.ersatzKnoten.some((k) => !/^[a-z2-7]{56}\.onion:\d{2,5}$/.test(k))) {
      fehler.push('zahlungswege.xmr.ersatzKnoten: hoechstens 20 Onion-Knoten der Form <56 Zeichen>.onion:18089');
    }
  }

  let btcKonto = null;
  if (zw.btc.aktiv) {
    try {
      btcKonto = ladeKontoSchluessel(zw.btc.zpub);
    } catch (e) {
      fehler.push('zahlungswege.btc.zpub: ' + (e instanceof SchluesselFehler ? e.message : 'ungueltig'));
    }
    if (zw.btc.zpub === BIP84_TESTVEKTOR_ZPUB && !erlaubeTestwerte) {
      fehler.push('zahlungswege.btc.zpub: Das ist der oeffentliche BIP84-Testvektor - Zahlungen dorthin waeren verloren.');
    }
    zw.btc.mempoolOnion = zw.btc.mempoolOnion.replace(/\/+$/, '');
    zw.btc.mempoolClearnet = zw.btc.mempoolClearnet.replace(/\/+$/, '');
    if (!/^https?:\/\/[a-z2-7]{56}\.onion(:\d{1,5})?$/.test(zw.btc.mempoolOnion)) fehler.push('zahlungswege.btc.mempoolOnion: http://<56 Zeichen>.onion erwartet');
    if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(zw.btc.mempoolClearnet)) fehler.push('zahlungswege.btc.mempoolClearnet: https://… erwartet');
  }

  if (zw.extern.aktiv && !/^[a-z0-9-]{1,40}$/.test(zw.extern.adapter)) {
    fehler.push('zahlungswege.extern.adapter: Name eines Adapters in src/zahlung/anbieter/ erwartet');
  }

  const waehrungen = new Set([...(zw.xmr.aktiv ? ['XMR'] : []), ...(zw.btc.aktiv ? ['BTC'] : [])]);
  for (const w of waehrungen) {
    const n = (konfig.kurs.quellen[w] || []).length;
    if (n < konfig.kurs.mindestQuellen) fehler.push(`kurs.quellen.${w}: mindestens ${konfig.kurs.mindestQuellen} Quellen noetig (vorhanden: ${n})`);
  }

  const f = konfig.lizenz.features;
  if (!f.length || f.some((x) => !/^[a-z][a-z0-9_-]{0,31}$/.test(x)) || f.some((x, i) => i > 0 && !(f[i - 1] < x))) {
    fehler.push('lizenz.features: sortierte, eindeutige Kleinbuchstaben-Kennungen erwartet, z. B. ["pro"]');
  }
  if (!/^[A-Z0-9]{1,10}$/.test(konfig.buchhaltung.rechnungsPraefix)) fehler.push('buchhaltung.rechnungsPraefix: 1-10 Grossbuchstaben/Ziffern');
  if (konfig.buchhaltung.sicherungSchluessel && !/^[A-Za-z0-9_-]{43}$/.test(konfig.buchhaltung.sicherungSchluessel)) {
    fehler.push('buchhaltung.sicherungSchluessel: oeffentlicher Sicherungsschluessel (43 Zeichen base64url) oder leer');
  }
  for (const feld of ['schwellenwert', 'reserve']) {
    if (!/^\d{1,6}(\.\d{1,8})?$/.test(konfig.verkauf.kraken[feld])) fehler.push(`verkauf.kraken.${feld}: Dezimalzahl erwartet, z. B. "0.001"`);
  }
  if (konfig.bestellung.adresseReserviertStunden < konfig.bestellung.gueltigStunden) {
    fehler.push('bestellung.adresseReserviertStunden darf nicht kleiner als bestellung.gueltigStunden sein');
  }

  if (fehler.length) throw new KonfigFehler(fehler);

  konfig.datenVerzeichnis = path.resolve(basisVerzeichnis, konfig.datenVerzeichnis);
  const geheim = (p) => (p.startsWith('credential:') ? p : path.resolve(basisVerzeichnis, p));
  konfig.lizenz.schluesselDatei = geheim(konfig.lizenz.schluesselDatei);
  zw.xmr.walletRpcLogin = geheim(zw.xmr.walletRpcLogin);
  konfig.verkauf.kraken.zugang = geheim(konfig.verkauf.kraken.zugang);
  return { konfig, btcKonto };
}

/** Liest config.json von der Platte und prueft sie. */
export function ladeKonfiguration(datei, optionen = {}) {
  const absolut = path.resolve(datei);
  let text;
  try {
    const st = fs.statSync(absolut);
    if (st.size > 256 * 1024) throw new KonfigFehler(['Konfigurationsdatei ist zu gross']);
    text = fs.readFileSync(absolut, 'utf8');
  } catch (e) {
    if (e instanceof KonfigFehler) throw e;
    throw new KonfigFehler([`Konfigurationsdatei ${absolut} nicht lesbar (${e.code || e.message})`]);
  }
  let roh;
  try {
    roh = JSON.parse(text);
  } catch (e) {
    throw new KonfigFehler([`Konfigurationsdatei ist kein gueltiges JSON: ${e.message}`]);
  }
  return pruefeKonfiguration(roh, { basisVerzeichnis: path.dirname(absolut), ...optionen });
}
