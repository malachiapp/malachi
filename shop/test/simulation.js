#!/usr/bin/env node
// Kauf-SIMULATION: der echte Shop (Seiten, API, Bestell- und Lizenzlogik,
// Buchhaltung) laeuft lokal - nur Wallet, Kurse und Blockchain sind simuliert.
// Kein echtes Geld, kein Tor, keine Verbindung zum Server.
//
//   node test/simulation.js [--port 8790]
//
// Shop:       http://127.0.0.1:8790/
// Steuerung:  http://127.0.0.1:8790/__sim   (Zahlung senden, bestaetigen, Teilzahlung)
//
// Lizenzen werden mit dem oeffentlich bekannten TESTSCHLUESSEL signiert - die
// echte App nimmt sie NICHT an (sie kennt nur den echten Shop-Schluessel).
// Nur fuer Vorfuehrung und Tests; wird nicht auf den Server kopiert.

import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { testShop, FakeMempool, TEST_OEFFENTLICH, tempVerzeichnis } from './hilfen.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';
import { erstelleHandler } from '../src/app.js';
import { base64urlKodieren } from '../src/lizenzpruefer.js';
import { STATUS, betragText, waehrungsDaten } from '../src/bestellungen.js';
import { h } from '../src/seiten.js';
import { gruppieren } from '../src/ids.js';

/** Startet den Simulations-Shop; Rueckgabe { server, port, verwaltung, wallet, mempool, schliessen }. */
export async function simulationStarten({ port = 0, pruefTaktMs = 3000, still = false } = {}) {
  const rechtlich = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../rechtliches.entwurf.json', import.meta.url)), 'utf8')).rechtliches;
  const mempool = new FakeMempool();
  const uhr = { jetzt: () => Date.now(), vor() {} };
  const { konfig, verwaltung, wallet, buchhaltung } = await testShop(
    {
      zahlungswege: { standard: 'xmr', pruefIntervallSek: 15, btc: { aktiv: true, zpub: BIP84_TESTVEKTOR_ZPUB } },
      rechtliches: rechtlich,
    },
    { verzeichnis: tempVerzeichnis(), uhr, mempool },
  );
  const log = still ? { info() {}, warnung() {}, fehler() {} } : { info: (m) => console.log('[shop] ' + m), warnung: (m) => console.warn('[shop] ' + m), fehler: (m) => console.error('[shop] ' + m) };
  const shop = erstelleHandler({ konfig, verwaltung, lizenzOeffentlich: base64urlKodieren(TEST_OEFFENTLICH), log, wartezeitPruefungMs: 2000 });

  // ---------------------------------------------------------- Simulation der Zahlung
  const bestellung = (nr) => verwaltung.holen(String(nr || ''));
  function zahlen(b, anteil) {
    const betrag = Math.max(1, Math.floor(b.betrag * anteil));
    if (b.waehrung === 'BTC') mempool.zahlung(b.adresse, betrag);
    else wallet.zahlung(b.index, betrag);
    b.zuletztGeprueft = 0; // sofort neu pruefen
  }
  function bestaetigen(b) {
    if (b.waehrung === 'BTC') {
      for (const t of mempool.txs) if (t.adresse === b.adresse && t.hoehe === null) t.hoehe = mempool.hoehe;
    } else {
      for (const t of wallet.transfers) if (t.index === b.index && t.hoehe === null) wallet.bestaetigen(t);
    }
    b.zuletztGeprueft = 0;
  }

  function steuerseite() {
    const zeilen = Object.values(verwaltung.daten.bestellungen)
      .sort((a, b) => b.erstellt - a.erstellt)
      .map((b) => {
        const w = waehrungsDaten(b, verwaltung.wege[b.zahlungsweg]);
        const knopf = (pfad, text) => `<form method="post" action="/__sim/${pfad}"><input type="hidden" name="nr" value="${h(b.id)}"><button>${h(text)}</button></form>`;
        const offen = b.status !== STATUS.BEZAHLT;
        return `<tr><td><a href="/bestellung/${h(b.id)}">${h(gruppieren(b.id))}</a></td><td>${h(b.waehrung)}</td><td>${h(betragText(b.betrag, w))}</td><td>${h(betragText(b.empfangen, w))}</td><td><b>${h(b.status)}</b></td>
<td>${offen ? knopf('zahlen', 'Volle Zahlung senden') + knopf('teil', 'Teilzahlung (50 %)') + knopf('bestaetigen', 'Im Block bestaetigen') : 'Lizenz ausgestellt'}</td></tr>`;
      })
      .join('\n');
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kauf-Simulation</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#fff8e6;color:#222}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}form{display:inline-block;margin:2px}button{padding:6px 10px}.hinweis{background:#ffe08a;padding:10px;border-radius:8px}</style></head><body>
<p class="hinweis"><b>SIMULATION</b> – Wallet, Kurse und Blockchain sind simuliert. Kein echtes Geld. Lizenzen sind mit einem Testschlüssel signiert und gelten in der echten App nicht.</p>
<h1>Steuerung</h1><p><a href="/" target="_blank">Shop öffnen</a> · Bestellungen hier anlegen, dann Zahlung simulieren.</p>
<table><tr><th>Bestellung</th><th>Währung</th><th>Preis</th><th>Empfangen</th><th>Status</th><th>Simulieren</th></tr>${zeilen || '<tr><td colspan="6">Noch keine Bestellung.</td></tr>'}</table>
</body></html>`;
  }

  async function steuerung(req, res, pfad) {
    if (req.method === 'GET' && pfad === '/__sim') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(steuerseite());
    }
    if (req.method !== 'POST') return false;
    let koerper = '';
    for await (const s of req) koerper += s;
    const b = bestellung(new URLSearchParams(koerper).get('nr'));
    if (!b) {
      res.writeHead(404);
      return res.end('Bestellung unbekannt');
    }
    if (pfad === '/__sim/zahlen') zahlen(b, 1);
    else if (pfad === '/__sim/teil') zahlen(b, 0.5);
    else if (pfad === '/__sim/bestaetigen') bestaetigen(b);
    else return false;
    await verwaltung.aktualisieren(b.id, { mindestAbstandMs: 0 }).catch((e) => log.warnung(e.message));
    res.writeHead(303, { Location: '/__sim' });
    return res.end();
  }

  const server = http.createServer((req, res) => {
    const pfad = req.url.split('?')[0];
    if (pfad === '/__sim' || pfad.startsWith('/__sim/')) {
      steuerung(req, res, pfad).then((erledigt) => {
        if (erledigt === false) {
          res.writeHead(404);
          res.end();
        }
      });
      return;
    }
    shop(req, res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const takt = setInterval(() => verwaltung.hintergrundLauf().catch(() => {}), pruefTaktMs);
  takt.unref();
  return {
    server,
    port: server.address().port,
    konfig,
    verwaltung,
    wallet,
    mempool,
    buchhaltung,
    zahlen: (nr, anteil = 1) => zahlen(bestellung(nr), anteil),
    bestaetigen: (nr) => bestaetigen(bestellung(nr)),
    schliessen: () => new Promise((r) => { clearInterval(takt); server.close(r); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 8790;
  const s = await simulationStarten({ port });
  console.log(`Kauf-Simulation: Shop http://127.0.0.1:${s.port}/  ·  Steuerung http://127.0.0.1:${s.port}/__sim`);
}
