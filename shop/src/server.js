#!/usr/bin/env node
// Einstiegspunkt des Malachi-Onion-Shops.
//
//   node src/server.js [--config /etc/malachi-shop/config.json]
//   node src/server.js --pruefen   (Konfiguration, Schluessel, Wallet, Kurse pruefen, dann beenden)
//
// Der Server lauscht ausschliesslich auf 127.0.0.1; erreichbar ist er nur ueber
// den Tor-Onion-Dienst. Alle ausgehenden Abfragen laufen ueber Tor (SOCKS5);
// monero-wallet-rpc wird lokal angesprochen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladeKonfiguration } from './config.js';
import { lizenzschluesselLaden, oeffentlichRoh, lizenzSignieren, lizenzPruefenMitSchluessel } from './lizenz.js';
import { base64urlKodieren, geraetecodeAusSpki } from './lizenzpruefer.js';
import { holeUeberTor } from './tor.js';
import { Kursdienst } from './kurs.js';
import { MempoolApi } from './mempool.js';
import { empfangsAdresse } from './bip84.js';
import { MoneroZahlungsweg, walletRpcTransport, WalletRpcFehler } from './zahlung/monero.js';
import { BitcoinZahlungsweg } from './zahlung/bitcoin.js';
import { pruefeAdapter } from './zahlung/extern.js';
import { Buchhaltung } from './buchhaltung.js';
import { Bestellverwaltung } from './bestellungen.js';
import { Verkaufsmodul, KrakenClient, krakenZugangLesen } from './verkauf.js';
import { taeglicheSicherung } from './sicherung.js';
import { geheimnisLesen } from './geheimnisse.js';
import { erstelleHandler, erstelleServer, lauschen } from './app.js';

const SHOP_VERZEICHNIS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Protokoll nur mit Meldungen - keine Anfragedaten, keine IP-Adressen, keine Bestellnummern.
const log = {
  info: (m) => console.log('[info] ' + m),
  warnung: (m) => console.warn('[warnung] ' + m),
  fehler: (m) => console.error('[fehler] ' + m),
};

const testwerte = process.env.MALACHI_SHOP_TESTWERTE_ERLAUBT === '1';

function argumenteLesen(argv) {
  const a = { config: null, pruefen: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') a.config = argv[++i];
    else if (argv[i] === '--pruefen') a.pruefen = true;
    else throw new Error(`Unbekanntes Argument: ${argv[i]}`);
  }
  return a;
}

const warten = (ms) => new Promise((r) => setTimeout(r, ms));

async function aufbauen(konfig, btcKonto) {
  fs.mkdirSync(konfig.datenVerzeichnis, { recursive: true, mode: 0o700 });
  fs.accessSync(konfig.datenVerzeichnis, fs.constants.W_OK);

  const lizenzSchluessel = lizenzschluesselLaden(konfig.lizenz.schluesselDatei, { erlaubeTestschluessel: testwerte });
  const lizenzOeffentlich = base64urlKodieren(oeffentlichRoh(lizenzSchluessel));
  const signieren = (d) => lizenzSignieren(lizenzSchluessel, d);

  const holen = (url, optionen = {}) =>
    holeUeberTor(url, { socksHost: konfig.tor.socksHost, socksPort: konfig.tor.socksPort, timeoutMs: konfig.tor.timeoutSek * 1000, ...optionen });

  const kursdienst = new Kursdienst({
    holen,
    waehrungen: {
      XMR: { quellen: konfig.kurs.quellen.XMR || [], min: 1, max: 100_000 },
      BTC: { quellen: konfig.kurs.quellen.BTC || [], min: 1000, max: 10_000_000 },
    },
    mindestQuellen: konfig.kurs.mindestQuellen,
    maxAbweichungProzent: konfig.kurs.maxAbweichungProzent,
    cacheSek: konfig.kurs.cacheSek,
    log,
  });

  const wege = {};
  const zw = konfig.zahlungswege;
  if (zw.xmr.aktiv) {
    const login = geheimnisLesen(zw.xmr.walletRpcLogin);
    const trenn = login.indexOf(':');
    if (trenn < 1) throw new Error('wallet-rpc-Login muss die Form benutzer:passwort haben');
    const rpc = walletRpcTransport({ url: zw.xmr.walletRpcUrl, benutzer: login.slice(0, trenn), passwort: login.slice(trenn + 1) });
    wege.xmr = new MoneroZahlungsweg({ rpc, hauptadresse: zw.xmr.hauptadresse, kontoIndex: zw.xmr.kontoIndex, ersatzKnoten: zw.xmr.ersatzKnoten, log });
  }
  if (zw.btc.aktiv) {
    const mempool = new MempoolApi({ holen, onionUrl: zw.btc.mempoolOnion, clearnetUrl: zw.btc.mempoolClearnet, clearnetFallback: zw.btc.clearnetFallback, log });
    wege.btc = new BitcoinZahlungsweg({ konto: btcKonto, mempool, startIndex: zw.btc.startIndex, gapLimit: zw.btc.gapLimit });
  }
  if (zw.extern.aktiv) {
    const datei = path.join(SHOP_VERZEICHNIS, 'src', 'zahlung', 'anbieter', `${zw.extern.adapter}.js`);
    if (!fs.existsSync(datei)) throw new Error(`Zahlungsdienst-Adapter ${zw.extern.adapter} nicht gefunden (${datei})`);
    const modul = await import(new URL(`./zahlung/anbieter/${zw.extern.adapter}.js`, import.meta.url));
    wege.extern = pruefeAdapter(await modul.erstelleAdapter({ einstellungen: zw.extern.einstellungen, holen, log }));
  }

  const buchhaltung = new Buchhaltung({ verzeichnis: path.join(konfig.datenVerzeichnis, 'buchhaltung'), rechnungsPraefix: konfig.buchhaltung.rechnungsPraefix });
  await buchhaltung.initialisieren();

  const verwaltung = new Bestellverwaltung({ konfig, wege, kursdienst, buchhaltung, signieren, log });
  await verwaltung.laden();

  let kraken = null;
  if (konfig.verkauf.modus === 'kraken') {
    const zugang = krakenZugangLesen(konfig.verkauf.kraken.zugang);
    kraken = new KrakenClient({ anfrage: holen, apiKey: zugang.apiKey, apiSecret: zugang.apiSecret });
  }
  const verkauf = new Verkaufsmodul({ konfig: konfig.verkauf, datenVerzeichnis: konfig.datenVerzeichnis, buchhaltung, kraken, log });
  await verkauf.laden();

  return { lizenzSchluessel, lizenzOeffentlich, kursdienst, wege, buchhaltung, verwaltung, verkauf };
}

/** Sicherheitsfehler (falsches Wallet, nicht view-only) beenden den Dienst - Netzprobleme nicht. */
const istHarterFehler = (e) => e instanceof WalletRpcFehler && /NICHT view-only|gehoert nicht/.test(e.message);

/** Ein Zahlungsweg ist bereit, wenn seine Pruefung klappt und (Monero) ein Knoten antwortet. */
async function wegBereitPruefen(weg) {
  const r = await weg.pruefen();
  if (typeof weg.knotenPruefen === 'function' && !(await weg.knotenPruefen()).ok) throw new Error('kein Monero-Knoten erreichbar');
  return r;
}

/**
 * Prueft die Zahlungswege beim Start. Ein Weg, der wegen Netzproblemen nicht
 * bereit wird (wallet-rpc startet noch, Knoten/mempool ueber Tor gestoert),
 * haelt den Shop NICHT auf: er bleibt "nicht bereit" (keine neuen Bestellungen
 * dafuer) und wird im Hintergrund weiter geprueft. Seiten, Lizenzabruf, Umzug
 * und die anderen Zahlungswege laufen weiter.
 */
async function wegePruefen(wege, { versuche = 6, mitKnoten = false } = {}) {
  // Parallel je Zahlungsweg. Ohne mitKnoten (Dienststart) nur die schnelle
  // Pruefung; die Knotenpruefung (kann Minuten dauern) folgt im Hintergrund -
  // bis dahin gilt ein Weg mit Knoten (Monero) noch als nicht bereit.
  await Promise.all(Object.entries(wege).map(async ([id, weg]) => {
    weg.bereit = false;
    for (let i = 1; i <= versuche; i++) {
      try {
        const r = mitKnoten ? await wegBereitPruefen(weg) : await weg.pruefen();
        const knotenFolgt = !mitKnoten && typeof weg.knotenPruefen === 'function';
        weg.bereit = !knotenFolgt;
        log.info(`Zahlungsweg ${id} (${weg.name}) ${knotenFolgt ? 'Wallet geprueft, Knotenpruefung folgt' : 'bereit'}${r && r.hoehe ? `, Blockhoehe ${r.hoehe}` : ''}.`);
        return;
      } catch (e) {
        if (istHarterFehler(e)) throw e;
        if (i < versuche) {
          log.warnung(`Zahlungsweg ${id} noch nicht bereit (${e.message}) - neuer Versuch in 5 s`);
          await warten(5000);
        } else {
          log.warnung(`Zahlungsweg ${id} (${weg.name}) nicht bereit (${e.message}) - der Shop startet ohne ihn und prueft im Hintergrund weiter.`);
        }
      }
    }
  }));
}

async function main() {
  const args = argumenteLesen(process.argv.slice(2));
  const konfigPfad = args.config || process.env.MALACHI_SHOP_CONFIG || path.join(SHOP_VERZEICHNIS, 'config.json');
  const { konfig, btcKonto } = ladeKonfiguration(konfigPfad, { erlaubeTestwerte: testwerte });
  const s = await aufbauen(konfig, btcKonto);

  if (!konfig.rechtliches.anbieter.length) log.warnung('rechtliches.anbieter ist leer - Rechnungen brauchen Name und Anschrift des Anbieters.');
  if (!konfig.rechtliches.impressum.length) log.warnung('Impressum ist leer - vor dem Livegang ausfuellen (siehe ANLEITUNG.md).');
  if (!konfig.buchhaltung.sicherungSchluessel) log.warnung('buchhaltung.sicherungSchluessel fehlt - es werden KEINE taeglichen Sicherungen erstellt.');
  if (!konfig.widerrufsZustimmungErforderlich) {
    log.warnung('widerrufsZustimmungErforderlich=false: Kaeufer koennen nach Bereitstellung 14 Tage widerrufen - Lizenzen sind offline gueltig und nicht rueckrufbar (Geld zurueck, Lizenz bleibt nutzbar).');
  }
  log.info(`Oeffentlicher Lizenzschluessel (fuer die App): ${s.lizenzOeffentlich}`);
  const koepfe = s.buchhaltung.koepfe();
  log.info('Buchhaltung intakt: ' + Object.entries(koepfe).map(([n, k]) => `${n}=${k.anzahl}/${k.kopf.slice(0, 16)}`).join(' '));

  if (args.pruefen) {
    try {
      await wegePruefen(s.wege, { versuche: 1, mitKnoten: true });
      const nicht = Object.entries(s.wege).filter(([, w]) => !w.bereit).map(([id]) => id);
      if (nicht.length) {
        log.fehler(`Nicht bereit: ${nicht.join(', ')}`);
        process.exitCode = 1;
      }
    } catch (e) {
      log.fehler(e.message);
      process.exitCode = 1;
    }
    if (btcKonto) {
      const i = konfig.zahlungswege.btc.startIndex;
      log.info(`Bitcoin: erste Empfangsadresse des Shops m/0/${i} = ${empfangsAdresse(btcKonto, i)} - muss mit der Adresse in deinem Wallet uebereinstimmen.`);
    }
    for (const w of new Set(Object.values(s.wege).map((x) => x.waehrung))) {
      try {
        const k = await s.kursdienst.kurs(w);
        log.info(`Kurs ${w}: 1 ${w} = ${k.eurProCoin} EUR (${k.methode}: ${k.quellen.map((q) => `${q.name}=${q.wert ?? 'Fehler'}`).join(', ')})`);
      } catch (e) {
        log.fehler(`Kurs ${w}: ${e.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }

  // Selbsttest: Signieren und lokales Pruefen muessen zusammenpassen
  const testGeraet = geraetecodeAusSpki(new Uint8Array(91));
  const probe = lizenzSignieren(s.lizenzSchluessel, { lic: '0000000000000000', dev: testGeraet, ord: '0000000000000000', iat: 1_800_000_000, feat: ['pro'] });
  const selbsttest = lizenzPruefenMitSchluessel(probe, s.lizenzSchluessel, testGeraet);
  if (!selbsttest.gueltig) throw new Error('Selbsttest der Lizenzsignatur fehlgeschlagen: ' + selbsttest.grund);

  const handler = erstelleHandler({ konfig, verwaltung: s.verwaltung, lizenzOeffentlich: s.lizenzOeffentlich, log });
  const server = erstelleServer(handler);
  // PROXY-Protokoll: tor meldet je Verbindung den Kreis (torrc:
  // HiddenServiceExportCircuitID haproxy) - fuer Grenzen je Kreis (Audit S2).
  const netz = lauschen(server, konfig.server.port, konfig.server.host, () => {
    log.info(`Malachi-Shop lauscht auf ${konfig.server.host}:${konfig.server.port} (nur lokal, Zugriff ueber Tor).`);
  });

  // Zahlungswege gelten bis zur bestandenen Pruefung als nicht bereit (keine
  // neuen Bestellungen dafuer); der Shop oeffnet trotzdem sofort - Seiten,
  // Lizenzabruf, Umzug und Rechnungen laufen. Sicherheitsfehler beenden den
  // Dienst auch nachtraeglich.
  for (const weg of Object.values(s.wege)) weg.bereit = false;
  let startFertig = false;
  wegePruefen(s.wege)
    .then(() => {
      startFertig = true;
      return bereitschaft();
    })
    .catch((e) => {
      log.fehler(e.message);
      process.exit(2);
    });

  // Bereitschaft der Zahlungswege: nicht bereite alle 30 s erneut pruefen,
  // bereite alle 5 min (Monero: antwortet der Knoten? sonst Ersatzknoten).
  // Eigene Schleife, damit lange Pruefungen die Zahlungspruefung nicht aufhalten.
  let bereitLaeuft = false;
  let letzteGesundheit = Date.now();
  const bereitschaft = async () => {
    if (bereitLaeuft || !startFertig) return;
    bereitLaeuft = true;
    try {
      const alle = Date.now() - letzteGesundheit >= 5 * 60_000;
      if (alle) letzteGesundheit = Date.now();
      for (const [id, weg] of Object.entries(s.wege)) {
        if (weg.bereit && !alle) continue;
        try {
          await wegBereitPruefen(weg);
          if (!weg.bereit) log.info(`Zahlungsweg ${id} (${weg.name}) ist bereit.`);
          weg.bereit = true;
        } catch (e) {
          if (istHarterFehler(e)) {
            log.fehler(e.message);
            process.exit(2);
          }
          if (weg.bereit) log.warnung(`Zahlungsweg ${id} (${weg.name}) voruebergehend nicht verfuegbar: ${e.message}`);
          weg.bereit = false;
        }
      }
    } finally {
      bereitLaeuft = false;
    }
  };
  const bereitTakt = setInterval(() => bereitschaft().catch((e) => log.fehler('Bereitschaftspruefung: ' + e.message)), 30_000);

  let laeuft = false;
  let letzterVerkauf = 0;
  let letzteErstattungsMeldung = 0;
  const hintergrund = async () => {
    if (laeuft) return;
    laeuft = true;
    try {
      await s.verwaltung.hintergrundLauf();
      if (Date.now() - letzteErstattungsMeldung > 24 * 3_600_000) {
        letzteErstattungsMeldung = Date.now();
        const n = s.verwaltung.offeneErstattungen().length;
        if (n) log.warnung(`${n} Widerruf(e) mit Zahlungseingang warten auf Rueckzahlung (Frist 14 Tage) - Liste: werkzeuge/widerrufe.js liste`);
      }
      if (Date.now() - letzterVerkauf > 5 * 60_000) {
        letzterVerkauf = Date.now();
        await s.verkauf.lauf().catch((e) => log.warnung('Verkaufsmodul: ' + e.message));
      }
      if (konfig.buchhaltung.sicherungSchluessel) {
        const neu = await taeglicheSicherung({
          datenVerzeichnis: konfig.datenVerzeichnis,
          zielVerzeichnis: path.join(konfig.datenVerzeichnis, 'sicherungen'),
          empfaenger: konfig.buchhaltung.sicherungSchluessel,
          behalten: konfig.buchhaltung.sicherungenBehalten,
        });
        if (neu) {
          const k = s.buchhaltung.koepfe();
          log.info(`Sicherung erstellt: ${path.basename(neu)}. Kettenkoepfe: ` + Object.entries(k).map(([n, x]) => `${n}=${x.anzahl}/${x.kopf}`).join(' '));
        }
      }
    } catch (e) {
      log.fehler('Hintergrundlauf: ' + e.message);
    } finally {
      laeuft = false;
    }
  };
  const intervall = setInterval(hintergrund, 30_000);
  setTimeout(hintergrund, 5_000).unref();

  let beendet = false;
  const beenden = (signal) => {
    if (beendet) return;
    beendet = true;
    log.info(`${signal} empfangen - beende.`);
    clearInterval(intervall);
    clearInterval(bereitTakt);
    netz.close();
    server.close();
    setTimeout(() => process.exit(0), 10_000).unref();
    s.verwaltung.speicher.leeren().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => beenden('SIGTERM'));
  process.on('SIGINT', () => beenden('SIGINT'));
}

process.on('unhandledRejection', (e) => {
  log.fehler('Unbehandelter Fehler: ' + (e && e.message ? e.message : String(e)));
});

main().catch((e) => {
  log.fehler(e && e.message ? e.message : String(e));
  process.exit(2);
});
