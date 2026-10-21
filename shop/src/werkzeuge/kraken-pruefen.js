#!/usr/bin/env node
// Prueft einen Kraken-API-Schluessel ueber Tor, bevor der Shop ihn benutzt
// (verkauf.krakenSchluesselPruefen): Guthaben/Auftraege muessen gehen,
// Auszahlen darf NICHT gehen. Bewegt kein Geld (AddOrder nur mit validate).
//
//   node src/werkzeuge/kraken-pruefen.js --zugang /etc/malachi-shop/kraken-api.json [--config /etc/malachi-shop/config.json]
//
// Gibt weder Schluessel noch Guthaben aus. Rueckgabewert 0 = bestanden, 3 = nicht bestanden.

import fs from 'node:fs';
import { holeUeberTor } from '../tor.js';
import { KrakenClient, krakenZugangLesen, krakenSchluesselPruefen } from '../verkauf.js';

async function main() {
  const argv = process.argv.slice(2);
  let zugang = null;
  let config = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zugang') zugang = argv[++i];
    else if (argv[i] === '--config') config = argv[++i];
    else throw new Error(`Unbekanntes Argument: ${argv[i]}`);
  }
  if (!zugang) throw new Error('--zugang fehlt');

  let tor = { socksHost: '127.0.0.1', socksPort: 9050, timeoutSek: 60 };
  if (config) {
    const k = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (k.tor) tor = { ...tor, ...k.tor };
  }
  const { apiKey, apiSecret } = krakenZugangLesen(zugang);
  const holen = (url, optionen = {}) =>
    holeUeberTor(url, { socksHost: tor.socksHost, socksPort: tor.socksPort, timeoutMs: tor.timeoutSek * 1000, ...optionen });
  const kraken = new KrakenClient({ anfrage: holen, apiKey, apiSecret });

  console.log('Pruefe den Kraken-Schluessel ueber Tor (es wird nichts gekauft, verkauft oder ausgezahlt) ...');
  const { ok, meldungen } = await krakenSchluesselPruefen(kraken);
  for (const m of meldungen) console.log('  ' + m);
  console.log(ok ? 'Ergebnis: bestanden.' : 'Ergebnis: NICHT bestanden.');
  process.exitCode = ok ? 0 : 3;
}

main().catch((e) => {
  console.error('Fehler: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 2;
});
