#!/usr/bin/env node
// Widerrufe mit Zahlungseingang: anzeigen und die Rueckzahlung buchen.
//
// Der Server kann kein Geld senden (View-/Watch-only). Du zahlst selbst aus
// deinem Wallet (Feather/Sparrow) an die Rueckzahlungsadresse zurueck und
// buchst das hier - danach verschwinden Name und Adresse mit der Bestellung.
//
//   sudo runuser -u malachi-shop -- node /opt/malachi-shop/src/werkzeuge/widerrufe.js liste --daten /var/lib/malachi-shop
//   sudo runuser -u malachi-shop -- node /opt/malachi-shop/src/werkzeuge/widerrufe.js erstattet --daten /var/lib/malachi-shop \
//        --bestellung ABCD-EFGH-JKMN-PQRS --menge 0.006149 --txid <Transaktions-ID der Rueckzahlung>
//
// Frist: spaetestens 14 Tage nach Eingang des Widerrufs zurueckzahlen.

import fs from 'node:fs';
import path from 'node:path';
import { Buchhaltung } from '../buchhaltung.js';
import { normalisieren, BESTELLNUMMER_LAENGE, gruppieren } from '../ids.js';
import { atomarZuDezimal } from '../dezimal.js';

const STELLEN = { XMR: 12, BTC: 8 };
const TAG = 24 * 3_600_000;

function argumente(argv) {
  const [befehl, ...rest] = argv;
  const o = { befehl };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--') || i + 1 >= rest.length) throw new Error(`Unerwartetes Argument: ${rest[i]}`);
    o[rest[i].slice(2)] = rest[++i];
  }
  if (!o.daten) throw new Error('--daten <Datenverzeichnis> fehlt (meist /var/lib/malachi-shop)');
  return o;
}

function widerrufene(daten) {
  const d = JSON.parse(fs.readFileSync(path.join(daten, 'bestellungen.json'), 'utf8'));
  return Object.values(d.bestellungen || {}).filter((b) => b.status === 'widerrufen');
}

function erstatteteBestellungen(bh) {
  const e = bh.lesen('sonstige');
  const storniert = new Set(e.filter((x) => x.typ === 'storno').map((x) => x.stornoVon));
  return new Map(e.filter((x) => x.art === 'erstattung' && !storniert.has(x.seq)).map((x) => [x.bestellung, x]));
}

const menge = (b, atomar) => `${atomarZuDezimal(BigInt(atomar), STELLEN[b.waehrung] ?? 12)} ${b.waehrung}`;

async function main() {
  const o = argumente(process.argv.slice(2));
  const bh = new Buchhaltung({ verzeichnis: path.join(o.daten, 'buchhaltung') });

  if (o.befehl === 'liste') {
    const erstattet = erstatteteBestellungen(bh);
    const alle = widerrufene(o.daten).sort((a, b) => a.widerruf.zeit - b.widerruf.zeit);
    const offen = alle.filter((b) => b.empfangen > 0 && !erstattet.has(b.id));
    if (!alle.length) return console.log('Keine widerrufenen Bestellungen.');
    console.log(`${alle.length} widerrufene Bestellung(en), davon ${offen.length} mit offener Rueckzahlung.\n`);
    for (const b of alle) {
      const w = b.widerruf;
      const frist = new Date(w.zeit + 14 * TAG).toISOString().slice(0, 10);
      let stand;
      if (b.empfangen === 0) stand = 'kein Zahlungseingang - nichts zurueckzuzahlen';
      else if (erstattet.has(b.id)) stand = `zurueckgezahlt (${erstattet.get(b.id).betragCoin} ${b.waehrung})`;
      else stand = `RUECKZAHLUNG OFFEN: ${menge(b, b.empfangen)} bis ${frist}`;
      console.log(`${gruppieren(b.id)}  widerrufen ${new Date(w.zeit).toISOString().slice(0, 16).replace('T', ' ')} UTC  ${stand}`);
      if (b.empfangen > 0 && !erstattet.has(b.id)) {
        console.log(`    an: ${w.rueckzahlAdresse || '(noch keine Rueckzahlungsadresse - der Kunde kann sie im Shop nachtragen)'}`);
        if (b.txids?.length) console.log(`    eingegangen mit: ${b.txids.join(', ')}`);
      }
    }
    return;
  }

  if (o.befehl === 'erstattet') {
    const id = normalisieren(o.bestellung || '', BESTELLNUMMER_LAENGE);
    if (!id) throw new Error('--bestellung: Bestellnummer (16 Zeichen) fehlt oder ist ungueltig');
    const b = widerrufene(o.daten).find((x) => x.id === id);
    if (!b) throw new Error('Keine widerrufene Bestellung mit dieser Nummer');
    if (!(b.empfangen > 0)) throw new Error('Zu dieser Bestellung ist nichts eingegangen - nichts zurueckzuzahlen');
    if (!o.menge || !/^\d{1,6}(\.\d{1,12})?$/.test(o.menge)) throw new Error('--menge: zurueckgezahlter Betrag, z. B. 0.006149');
    if (!o.txid || !/^[0-9a-fA-F]{64}$/.test(o.txid)) throw new Error('--txid: Transaktions-ID der Rueckzahlung (64 Hex-Zeichen)');
    const eintrag = await bh.sonstigesBuchen({
      art: 'erstattung',
      bestellung: b.id,
      waehrung: b.waehrung,
      betragCoin: o.menge,
      txids: [o.txid.toLowerCase()],
      notiz: `Rueckzahlung nach Widerruf (eingegangen ${menge(b, b.empfangen)})${o.notiz ? ' - ' + o.notiz : ''}`,
    });
    console.log(eintrag ? `Gebucht (sonstige #${eintrag.seq}). Der Shop loescht die Bestellung samt Name und Rueckzahlungsadresse beim naechsten Aufraeumen.` : 'Bereits gebucht.');
    return;
  }
  throw new Error('Befehl: liste | erstattet');
}

main().catch((e) => {
  console.error('Fehler: ' + e.message);
  process.exitCode = 1;
});
