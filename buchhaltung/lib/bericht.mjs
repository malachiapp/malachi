// Quartals- und Jahresbericht mit EUeR-Entwurf. Ergebnis: eine eigenstaendige
// HTML-Seite (ohne Skripte, ohne externe Dateien) und CSV-Dateien fuer Excel.
// Alles ist ein ENTWURF als Arbeitsgrundlage - keine Steuerberatung.
import { zeitraumuebersicht, ohneStornos, csv, einnahmenCsv, verkaeufeCsv, gebuehrenCsv, sonstigeCsv } from '../../shop/src/auswertung.js';
import { dezimalZuAtomar, atomarZuDezimal } from '../../shop/src/dezimal.js';
import { KATEGORIEN, EUER_EINNAHMEN, EUER_SHOP_GEBUEHREN } from './kategorien.mjs';
import { imZeitraum, lesbar, deutschesDatum } from './zeitraum.mjs';

const cent = (t) => dezimalZuAtomar(t || '0', 2);
const eur = (c) => atomarZuDezimal(c, 2);

/** '1234.5' -> '1.234,50 €' */
export function euro(t) {
  const c = typeof t === 'bigint' ? t : cent(t);
  const neg = c < 0n;
  const [ganz, nach] = eur(neg ? -c : c).split('.');
  return `${neg ? '−' : ''}${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${nach} €`;
}

const kommaZahl = (t) => String(t ?? '').replace('.', ',');
const html = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MUENZE = { XMR: 'Monero', BTC: 'Bitcoin' };

function ausgabenIm(ausgaben, zr) {
  return ausgaben.filter((a) => imZeitraum(a.bezahltAm || a.datum, zr)).sort((a, b) => (a.bezahltAm < b.bezahltAm ? -1 : 1));
}

function summe(liste, feld = 'betragEur') {
  return liste.reduce((s, x) => s + cent(x[feld]), 0n);
}

/**
 * Rechnet alles fuer einen Zeitraum (und das Jahr bis zu dessen Ende).
 * @param {object} o
 * @param {Record<string, object[]>} o.journale   Shop-Journale aus der Sicherung
 * @param {object[]} o.ausgaben                   gueltige Ausgaben (ohne Stornos)
 * @param {{name: string, von: string, bis: string, jahr: number}} o.zeitraum
 * @param {Record<string, string>} [o.erinnerung] EUR-Grenzen je Coin (Buchwert), z. B. { XMR: '100' }
 */
export function berechnen({ journale, ausgaben, zeitraum, erinnerung = {} }) {
  const jahrBisEnde = { von: `${zeitraum.jahr}-01-01`, bis: zeitraum.bis };
  const shopQ = zeitraumuebersicht(journale, zeitraum);
  const shopJ = zeitraumuebersicht(journale, jahrBisEnde);
  const ausgQ = ausgabenIm(ausgaben, zeitraum);
  const ausgJ = ausgabenIm(ausgaben, jahrBisEnde);

  const teil = (u, ausg) => {
    const einnahmen = cent(u.einnahmenEur) + cent(u.sonstigeEingaengeEur);
    const veraeusserung = cent(u.veraeusserungsergebnisEur);
    const gewinnShop = cent(u.gewinnVereinfachtEur);
    const kostenShop = einnahmen + veraeusserung - gewinnShop; // Verkaufs- und Netzwerkgebuehren (Coin-Gebuehren zum Buchwert)
    const ausgabenSumme = summe(ausg);
    const ausgabenOhneAnlage = summe(ausg.filter((a) => KATEGORIEN[a.kategorie]?.euer));
    return { u, einnahmen, veraeusserung, kostenShop, ausgabenSumme, ausgabenOhneAnlage, ergebnis: gewinnShop - ausgabenOhneAnlage };
  };
  const q = teil(shopQ, ausgQ);
  const j = teil(shopJ, ausgJ);

  // EUeR-Entwurf (Jahr bis Zeitraumende), Felder als Vorschlag
  const felder = new Map();
  const dazu = (feld, betrag, herkunft) => {
    if (betrag === 0n) return;
    const f = felder.get(feld) || { feld, betrag: 0n, herkunft: [] };
    f.betrag += betrag;
    f.herkunft.push(herkunft);
    felder.set(feld, f);
  };
  dazu(EUER_EINNAHMEN, j.einnahmen, `Lizenzverkäufe ${euro(shopJ.einnahmenEur)}` + (cent(shopJ.sonstigeEingaengeEur) ? ` + sonstige Eingänge ${euro(shopJ.sonstigeEingaengeEur)}` : ''));
  dazu(EUER_SHOP_GEBUEHREN, j.kostenShop, 'Börsen- und Netzwerkgebühren aus dem Shop');
  for (const [schluessel, k] of Object.entries(KATEGORIEN)) {
    if (!k.euer) continue;
    const betrag = summe(ausgJ.filter((a) => a.kategorie === schluessel));
    dazu(k.euer, betrag, `Belege: ${k.name}`);
  }
  const ausgabenFelder = [...felder.values()].filter((f) => f.feld !== EUER_EINNAHMEN);

  const klaerung = [];
  if (cent(shopJ.verkaufErloesEur) || cent(shopJ.verkaufBuchwertEur)) {
    klaerung.push(`Coin-Verkäufe: Erlös ${euro(shopJ.verkaufErloesEur)}, Buchwert ${euro(shopJ.verkaufBuchwertEur)}, Ergebnis ${euro(shopJ.veraeusserungsergebnisEur)}. Ist im Ergebnis unten enthalten - in welches EÜR-Feld das gehört, bitte klären.`);
  }
  const anlage = ausgJ.filter((a) => !KATEGORIEN[a.kategorie]?.euer);
  if (anlage.length) klaerung.push(`${anlage.length} Anschaffung(en) über 800 € netto (${euro(summe(anlage))}) sind NICHT im Ergebnis - ${KATEGORIEN.anlage.klaerung}`);
  if (ausgJ.some((a) => a.waehrung && a.waehrung !== 'EUR')) klaerung.push('Ausgaben in Fremdwährung: gebucht ist der Euro-Betrag laut Kontoauszug bzw. Abrechnung - bitte mit dem Kontoauszug abgleichen.');

  // Bestand und Erinnerungen
  const bestand = shopQ.bestandEnde || {};
  const erinnerungen = [];
  for (const [w, b] of Object.entries(bestand)) {
    const grenze = erinnerung[w];
    if (!grenze || cent(b.buchwertEur) < cent(grenze)) continue;
    erinnerungen.push({ waehrung: w, menge: b.menge, buchwertEur: b.buchwertEur, grenzeEur: grenze });
  }
  const warnungen = [];
  for (const [w, m] of Object.entries(shopJ.fehlbestandCoin || {})) warnungen.push(`Fehlbestand ${w}: Es wurde ${m} ${w} mehr verkauft/abgegeben als eingegangen - Buchungen prüfen.`);

  return { zeitraum, jahrBisEnde, q, j, ausgQ, ausgJ, felder: [...felder.values()], ausgabenFelder, klaerung, bestand, erinnerungen, warnungen };
}

/** Alle CSV-Dateien des Berichts. */
export function csvDateien(journale, b) {
  const im = (liste, zr) => ohneStornos(liste).filter((e) => imZeitraum(e.zeit || e.datum, zr));
  const zr = b.zeitraum;
  const z = (u) => [
    ['Verkaufte Lizenzen', u.u.anzahlLizenzen],
    ['Einnahmen (Lizenzen + sonstige Eingänge) EUR', kommaZahl(eur(u.einnahmen))],
    ['Ergebnis Coin-Verkäufe EUR', kommaZahl(eur(u.veraeusserung))],
    ['Gebühren aus dem Shop EUR', kommaZahl(eur(u.kostenShop))],
    ['Ausgaben laut Belegen EUR (ohne Anschaffungen > 800 €)', kommaZahl(eur(u.ausgabenOhneAnlage))],
    ['Ergebnis (Entwurf) EUR', kommaZahl(eur(u.ergebnis))],
  ];
  const q = z(b.q);
  const j = z(b.j);
  return {
    'uebersicht.csv': csv(['Position', `${zr.name}`, `Jahr ${zr.jahr} bis ${deutschesDatum(new Date(Date.parse(zr.bis + 'T00:00:00Z') - 86_400_000).toISOString())}`], q.map((zeile, i) => [zeile[0], zeile[1], j[i][1]])),
    'einnahmen.csv': einnahmenCsv(im(journale.einnahmen || [], zr), 0),
    'coin-verkaeufe.csv': verkaeufeCsv(im(journale.verkaeufe || [], zr), 0),
    'gebuehren.csv': gebuehrenCsv(im(journale.gebuehren || [], zr), 0),
    'sonstige-eingaenge.csv': sonstigeCsv(im(journale.sonstige || [], zr), 0),
    'ausgaben.csv': csv(
      ['Lfd. Nr.', 'Rechnungsdatum', 'Bezahlt am', 'Anbieter', 'Rechnungsnummer', 'Beschreibung', 'Kategorie', 'Betrag EUR', 'Originalwährung', 'Originalbetrag', 'Beleg', 'SHA-256 Beleg', 'Hash'],
      b.ausgQ.map((a) => [a.seq, a.datum, a.bezahltAm, a.anbieter, a.rechnungsnummer, a.beschreibung, KATEGORIEN[a.kategorie]?.name || a.kategorie, kommaZahl(a.betragEur), a.waehrung, a.betragOriginal, a.beleg?.datei || '', a.beleg?.sha256 || '', a.hash]),
    ),
    'euer-entwurf.csv': csv(['Feld der Anlage EÜR (Vorschlag)', `Betrag EUR (Jahr ${zr.jahr} bis Zeitraumende)`, 'Herkunft'], b.felder.map((f) => [f.feld, kommaZahl(eur(f.betrag)), f.herkunft.join(' | ')])),
  };
}

/** Eigenstaendige HTML-Seite. */
export function htmlSeite(b, meta) {
  const zr = b.zeitraum;
  const titel = meta.art === 'jahr' ? `EÜR-Entwurf ${zr.jahr}` : `Quartalsbericht ${zr.name}`;
  const zeile = (name, wq, wj, stark = false) => `<tr${stark ? ' class="stark"' : ''}><td>${html(name)}</td><td class="z">${wq}</td>${meta.art === 'jahr' ? '' : `<td class="z">${wj}</td>`}</tr>`;
  const kopf = meta.art === 'jahr' ? `<tr><th></th><th class="z">Jahr ${zr.jahr}</th></tr>` : `<tr><th></th><th class="z">${html(zr.name)}</th><th class="z">Jahr ${zr.jahr} bis Quartalsende</th></tr>`;
  const t = (u) => u;
  const ketten = Object.entries(meta.ketten || {}).map(([n, k]) => `${n}: ${k.ok ? `${k.anzahl} Einträge ✓` : `FEHLER – ${html(k.fehler)}`}`).join(' · ');
  const hinweise = [...(meta.warnungen || []), ...b.warnungen];
  const erinnerungen = b.erinnerungen.map((e) => {
    if (e.waehrung === 'XMR') {
      return `<li><b>Monero:</b> ${html(kommaZahl(e.menge))} XMR im Bestand (Eingangswert ${euro(e.buchwertEur)}, Grenze ${euro(e.grenzeEur)}). Kraken handelt Monero in der EU nicht – wenn du woanders verkaufst, buche den Verkauf danach auf dem Server nach:<br><code>${html(meta.serverBefehl)} verkauf --datum JJJJ-MM-TT --waehrung XMR --menge 0.5 --erloes 240,10 --gebuehr 1,20 --dienst "Name der Börse"</code></li>`;
    }
    if (e.waehrung === 'BTC') {
      return `<li><b>Bitcoin:</b> ${html(kommaZahl(e.menge))} BTC im Bestand (Wallet und Kraken zusammen, Eingangswert ${euro(e.buchwertEur)}). Was noch in Sparrow liegt, an deine Kraken-Einzahlungsadresse schicken – dort verkauft der Shop automatisch und bucht selbst.</li>`;
    }
    return `<li>${html(e.waehrung)}: ${html(e.menge)} (Eingangswert ${euro(e.buchwertEur)})</li>`;
  });
  const bestand = Object.entries(b.bestand).map(([w, x]) => `<tr><td>${html(MUENZE[w] || w)}</td><td class="z">${html(kommaZahl(x.menge))} ${html(w)}</td><td class="z">${euro(x.buchwertEur)}</td></tr>`).join('');
  const ausgaben = b.ausgQ.map((a) => `<tr><td>${deutschesDatum(a.bezahltAm)}</td><td>${html(a.anbieter)}${a.rechnungsnummer ? ` <span class="klein">${html(a.rechnungsnummer)}</span>` : ''}</td><td>${html(KATEGORIEN[a.kategorie]?.name || a.kategorie)}</td><td class="z">${euro(a.betragEur)}</td></tr>`).join('');
  const euer = b.felder.map((f) => `<tr${f.feld === EUER_EINNAHMEN ? ' class="stark"' : ''}><td>${html(f.feld)}</td><td class="z">${euro(f.betrag)}</td><td class="klein">${html(f.herkunft.join(' · '))}</td></tr>`).join('');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Malachi – ${html(titel)}</title>
<style>
:root{--text:#14202b;--leise:#5a6b7b;--rand:#d6dee6;--flaeche:#f4f7fa;--akzent:#0a6e91;--warn:#9a5b00;--warnflaeche:#fff4e0;--fehler:#a3122a}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--text);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px 16px 48px}
main{max-width:920px;margin:0 auto}h1{font-size:24px;margin:0}h2{font-size:17px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--rand)}
.unter{color:var(--leise);margin:2px 0 16px}.entwurf{background:var(--warnflaeche);border:1px solid #f0d19a;border-radius:8px;padding:10px 14px;margin:12px 0}
table{width:100%;border-collapse:collapse;margin:4px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rand);vertical-align:top}
th{font-weight:600;color:var(--leise);font-size:13px}.z{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.stark td{font-weight:700;background:var(--flaeche)}.klein{color:var(--leise);font-size:12.5px}code{background:var(--flaeche);padding:2px 5px;border-radius:4px;font-size:12.5px;word-break:break-all}
ul{padding-left:20px}li{margin:6px 0}.warn li{color:var(--warn)}.fehler{color:var(--fehler);font-weight:600}.leer{color:var(--leise);font-style:italic}
@media print{body{padding:0}.entwurf{break-inside:avoid}}
</style>
</head>
<body>
<main>
<h1>Malachi – ${html(titel)}</h1>
<p class="unter">${html(lesbar(zr))} · erstellt am ${html(deutschesDatum(meta.erstellt))} · Datenstand Shop: Sicherung vom ${html(deutschesDatum(meta.sicherungTag))}</p>
<div class="entwurf"><b>Entwurf, keine Steuerberatung.</b> Kleinunternehmer nach § 19 UStG – Beträge brutto, ohne Vorsteuer. Die Zuordnung zu den Feldern der Anlage EÜR ist ein Vorschlag; maßgeblich ist das Formular des jeweiligen Jahres. Ausgaben zählen nach dem Zahlungstag (Abflussprinzip).</div>
${hinweise.length ? `<h2>Bitte beachten</h2><ul class="warn">${hinweise.map((h) => `<li>${html(h)}</li>`).join('')}</ul>` : ''}
<h2>Übersicht</h2>
<table>${kopf}
${zeile('Verkaufte Lizenzen', t(b.q.u.anzahlLizenzen), b.j.u.anzahlLizenzen)}
${zeile('Einnahmen (Lizenzen und sonstige Eingänge)', euro(b.q.einnahmen), euro(b.j.einnahmen))}
${zeile('Ergebnis aus Coin-Verkäufen', euro(b.q.veraeusserung), euro(b.j.veraeusserung))}
${zeile('Gebühren aus dem Shop (Börse, Netzwerk)', euro(-b.q.kostenShop), euro(-b.j.kostenShop))}
${zeile('Ausgaben laut Belegen', euro(-b.q.ausgabenOhneAnlage), euro(-b.j.ausgabenOhneAnlage))}
${zeile('Ergebnis (Entwurf)', euro(b.q.ergebnis), euro(b.j.ergebnis), true)}
</table>
<h2>Coin-Bestand am Ende des Zeitraums</h2>
${bestand ? `<table><tr><th>Währung</th><th class="z">Menge</th><th class="z">Eingangswert (FIFO)</th></tr>${bestand}</table>` : '<p class="leer">Kein Bestand.</p>'}
${erinnerungen.length ? `<h2>Erinnerung</h2><ul>${erinnerungen.join('')}</ul>` : ''}
<h2>Ausgaben im Zeitraum</h2>
${ausgaben ? `<table><tr><th>Bezahlt</th><th>Anbieter</th><th>Kategorie</th><th class="z">Betrag</th></tr>${ausgaben}<tr class="stark"><td colspan="3">Summe</td><td class="z">${euro(b.q.ausgabenSumme)}</td></tr></table>` : '<p class="leer">Keine Ausgaben gebucht.</p>'}
${meta.wartendeBelege?.length ? `<p class="fehler">${meta.wartendeBelege.length} Beleg(e) im Eingang sind noch nicht erfasst: ${html(meta.wartendeBelege.join(', '))} – <code>malachi-buchhaltung belege</code> ausführen.</p>` : ''}
<h2>EÜR-Entwurf (Jahr ${zr.jahr}${meta.art === 'jahr' ? '' : ' bis Quartalsende'})</h2>
<table><tr><th>Feld der Anlage EÜR (Vorschlag)</th><th class="z">Betrag</th><th>Herkunft</th></tr>${euer || '<tr><td colspan="3" class="leer">Noch keine Beträge.</td></tr>'}
<tr class="stark"><td>Ergebnis (Entwurf)</td><td class="z">${euro(b.j.ergebnis)}</td><td class="klein">Einnahmen ${euro(b.j.einnahmen)} + Coin-Verkäufe ${euro(b.j.veraeusserung)} − Gebühren ${euro(b.j.kostenShop)} − Ausgaben ${euro(b.j.ausgabenOhneAnlage)}</td></tr></table>
${b.klaerung.length ? `<h2>Zu klären</h2><ul>${b.klaerung.map((k) => `<li>${html(k)}</li>`).join('')}</ul>` : ''}
<h2>Prüfung</h2>
<p class="klein">Hash-Ketten der Shop-Buchhaltung: ${ketten || '–'}<br>Ausgabenbuch: ${meta.ausgabenKette?.ok ? `${meta.ausgabenKette.anzahl} Einträge ✓` : `<span class="fehler">FEHLER – ${html(meta.ausgabenKette?.fehler)}</span>`}<br>Einzelaufstellungen: CSV-Dateien in diesem Ordner (Semikolon, für Excel).</p>
</main>
</body>
</html>
`;
}
