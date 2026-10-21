// HTML-Seiten (serverseitig, ohne JavaScript, ohne externe Ressourcen; funktioniert
// im Tor-Browser in der Sicherheitsstufe "Am sichersten").
// Alle dynamischen Werte laufen durch h() (HTML-Escaping).

import { STATUS, betragText, offenerBetrag } from './bestellungen.js';
import { gruppieren } from './ids.js';
import { geraetecodeGruppieren } from './lizenzpruefer.js';
import { qrSvg } from './qr.js';

export function h(wert) {
  return String(wert ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const zwei = (n) => String(n).padStart(2, '0');

/** "15.10.2026, 14:03 UTC" */
export function datumZeit(ms) {
  const d = new Date(ms);
  return `${zwei(d.getUTCDate())}.${zwei(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}, ${zwei(d.getUTCHours())}:${zwei(d.getUTCMinutes())} UTC`;
}

export function datum(ms) {
  const d = new Date(ms);
  return `${zwei(d.getUTCDate())}.${zwei(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** 2.99 -> "2,99 €" */
export function euro(betrag) {
  const [ganz, rest] = Number(betrag).toFixed(2).split('.');
  return `${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${rest} €`;
}

const absaetze = (liste) => liste.filter((z) => z !== '').map((z) => `<p>${h(z)}</p>`).join('\n');

function rahmen({ titel, inhalt, aktualisieren = 0, konfig }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${aktualisieren ? `<meta http-equiv="refresh" content="${Number(aktualisieren)}">\n` : ''}<title>${h(titel)} · ${h(konfig.texte.name)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="kopf"><a class="marke" href="/">${h(konfig.texte.name)}</a><span class="etikett">Onion-Shop</span></header>
<main>
${inhalt}
</main>
<footer class="fuss">
<nav><a class="widerrufen" href="/widerrufen">Vertrag widerrufen</a> · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/widerruf">Widerrufsbelehrung</a> · <a href="/bestellung">Bestellung abrufen</a> · <a href="/umzug">Gerät wechseln</a></nav>
<p>Kein JavaScript, keine Cookies, keine Zugriffsprotokolle.</p>
</footer>
</body>
</html>
`;
}

function wegName(weg) {
  return `${weg.name} (${weg.waehrung})`;
}

// ---------------------------------------------------------------- Startseite

export function startseite({ konfig, wege, fehler = '', geraetecode = '' }) {
  const k = konfig;
  const auswahl = Object.entries(wege);
  // Vorauswahl: Standardweg, wenn angeboten - sonst der erste angebotene.
  const vorauswahl = Object.hasOwn(wege, k.zahlungswege.standard) ? k.zahlungswege.standard : auswahl[0][0];
  const inhalt = `
<section class="held">
<h1>${h(k.texte.produkt)}</h1>
<p class="unter">${h(k.texte.untertitel)}</p>
${absaetze(k.texte.beschreibung)}
</section>

<section class="karte preis">
<p class="betrag">${h(euro(k.preisEur))}</p>
<p>Einmalig. Bezahlung mit ${h(auswahl.map(([, w]) => w.name).join(' oder '))}. Der Betrag in ${h(auswahl.map(([, w]) => w.waehrung).join('/'))} wird beim Anlegen der Bestellung zum aktuellen Kurs festgelegt.</p>
${k.umsatzsteuer.kleinunternehmer ? `<p class="klein">${h(k.umsatzsteuer.hinweisText)}</p>` : `<p class="klein">Endpreis inkl. ${h(k.umsatzsteuer.steuersatz)} % USt.</p>`}
</section>

<section class="karte">
<h2>Bitte vor dem Kauf lesen</h2>
<ul class="hinweise">
${k.texte.hinweise.map((z) => `<li>${h(z)}</li>`).join('\n')}
</ul>
</section>

<section class="karte">
<h2>So funktioniert es</h2>
<ol>
<li>Öffne in der App den Bereich „Vollversion“ und kopiere deinen <strong>Gerätecode</strong>. (Schneller geht es direkt in der App – sie nutzt dieselbe Bestellung über Tor.)</li>
<li>Füge ihn unten ein und lege die Bestellung an. Du erhältst eine nur dafür erzeugte Zahlungsadresse, den Betrag und einen <strong>Wiederherstellungscode</strong>.</li>
<li>Nach ${k.mindestBestaetigungen === 1 ? 'einer Bestätigung' : `${h(k.mindestBestaetigungen)} Bestätigungen`} der Zahlung erscheint auf der Bestellseite dein Lizenznachweis (Text und QR-Code) zum Einfügen in die App.</li>
</ol>
</section>

<section class="karte">
<h2>Kaufen</h2>
${fehler ? `<p class="fehler">${h(fehler)}</p>` : ''}
<form method="post" action="/bestellung">
<p class="zeile"><label for="geraet">Gerätecode aus der App</label>
<input id="geraet" name="geraetecode" type="text" autocomplete="off" spellcheck="false" maxlength="60" required placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX" value="${h(geraetecode)}"></p>
${
  auswahl.length > 1
    ? `<fieldset class="wege"><legend>Zahlungsweg</legend>${auswahl
        .map(([id, w]) => `<label><input type="radio" name="zahlungsweg" value="${h(id)}"${id === vorauswahl ? ' checked' : ''}> ${h(wegName(w))}</label>`)
        .join('\n')}${
        wege.btc && wege.xmr ? '\n<p class="klein">Bitcoin-Zahlungen sind in der Bitcoin-Blockchain öffentlich sichtbar; Monero ist privater.</p>' : ''
      }</fieldset>`
    : `<input type="hidden" name="zahlungsweg" value="${h(auswahl[0][0])}">`
}
${
  k.widerrufsZustimmungErforderlich
    ? `<label class="zustimmung"><input type="checkbox" name="zustimmung" value="ja" required>
<span>Ich verlange ausdrücklich, dass mit der Bereitstellung des Lizenznachweises vor Ablauf der Widerrufsfrist begonnen wird. Mir ist bekannt, dass ich mit Beginn der Bereitstellung mein Widerrufsrecht verliere. (<a href="/widerruf">Widerrufsbelehrung</a>)</span></label>`
    : ''
}
<button type="submit">Zahlungspflichtig bestellen</button>
</form>
</section>

<section class="karte">
<h2>Bestellung abrufen</h2>
<form method="get" action="/bestellung" class="zeile">
<label for="nr">Bestellnummer</label>
<input id="nr" name="nr" type="text" autocomplete="off" spellcheck="false" maxlength="40" placeholder="XXXX-XXXX-XXXX-XXXX">
<button type="submit">Abrufen</button>
</form>
<p class="klein">Neues Gerät oder App neu installiert? <a href="/umzug">Lizenz umziehen</a></p>
</section>`;
  return rahmen({ titel: 'Vollversion kaufen', inhalt, konfig: k });
}

// ---------------------------------------------------------------- Bestellung angelegt (einmalig: Wiederherstellungscode)

export function bestellungAngelegt({ konfig, bestellung: b, wiederherstellungscode }) {
  const inhalt = `<h1>Bestellung angelegt</h1>
<section class="karte merken">
<h2>Jetzt notieren – wird nur dieses eine Mal angezeigt</h2>
<dl class="daten">
<dt>Bestellnummer</dt><dd class="mono nummer">${h(gruppieren(b.id))}</dd>
<dt>Wiederherstellungscode</dt><dd class="mono nummer">${h(gruppieren(wiederherstellungscode))}</dd>
</dl>
<p class="hinweis">Mit Bestellnummer und Wiederherstellungscode kannst du die Lizenz später auf ein neues Gerät umziehen (z. B. nach Neuinstallation). Der Code wird nicht gespeichert und kann nicht wiederhergestellt werden. Bitte aufschreiben oder ein Bildschirmfoto an einem sicheren Ort ablegen.</p>
</section>
<p><a class="knopf" href="/bestellung/${h(b.id)}">Notiert – weiter zur Zahlung</a></p>`;
  return rahmen({ titel: 'Bestellung angelegt', inhalt, konfig });
}

// ---------------------------------------------------------------- Bestellseite

function zahlungsBlock(b, weg, offen) {
  const betrag = betragText(offen, weg);
  const uri = weg.uri(b.adresse, betrag);
  return `<div class="zahlung">
<div class="qrbox">${qrSvg(uri, { titel: 'QR-Code für die Zahlung' })}</div>
<details class="ausweich"><summary>QR-Code wird nicht angezeigt?</summary>
<p class="klein">In der Sicherheitsstufe „Am sichersten“ blendet der Tor-Browser SVG-Grafiken aus. Hier derselbe Code als PNG:</p>
<p><img src="/bestellung/${h(b.id)}/qr.png" alt="QR-Code für die Zahlung (PNG)" class="qrpng" loading="lazy"></p>
</details>
<dl class="daten">
<dt>Betrag</dt><dd class="mono gross">${h(betrag)} ${h(weg.waehrung)}</dd>
<dt>Adresse (${h(weg.name)})</dt><dd class="mono umbruch">${h(b.adresse)}</dd>
</dl>
<p><a class="knopf zweit" href="${h(uri)}">In Wallet-App öffnen</a></p>
<p class="klein">Bitte genau diesen Betrag an genau diese Adresse senden. Wird weniger gesendet (z. B. weil eine Börse Gebühren abzieht), bleibt die Bestellung „unvollständig“, bis der Rest eingeht.</p>
${b.kurs ? `<p class="klein">Preis ${h(euro(b.preisEur))} zum Referenzkurs 1 ${h(weg.waehrung)} = ${h(euro(b.kurs.eurProCoin))} (${h(b.kurs.methode)}, ${h(datumZeit(Date.parse(b.kurs.abgerufen)))}).</p>` : ''}
</div>`;
}

function lizenzBlock(b, k) {
  const aktuell = b.lizenzen[b.lizenzen.length - 1];
  return `<section class="karte merken">
<h2>Dein Lizenznachweis</h2>
<p>Füge diesen Text in der App unter „Vollversion“ ein oder scanne den QR-Code. Er gilt nur für das Gerät mit dem Gerätecode <span class="mono">${h(geraetecodeGruppieren(aktuell.dev))}</span>.</p>
<textarea class="lizenz mono" readonly rows="5" aria-label="Lizenznachweis">${h(aktuell.lizenz)}</textarea>
<div class="qrbox gross">${qrSvg(aktuell.lizenz, { titel: 'QR-Code des Lizenznachweises' })}</div>
<details class="ausweich"><summary>QR-Code wird nicht angezeigt?</summary>
<p><img src="/bestellung/${h(b.id)}/lizenz-qr.png" alt="QR-Code des Lizenznachweises (PNG)" class="qrpng" loading="lazy"></p>
</details>
<p><a href="/bestellung/${h(b.id)}/lizenz.txt">Lizenznachweis als Textdatei speichern</a></p>
<p class="klein">Lizenz-ID ${h(b.lizenzId)} · Aktivierungen: ${h(b.lizenzen.length)} von ${h(k.lizenz.maxAktivierungen)}</p>
</section>`;
}

export function bestellseite({ konfig, bestellung: b, weg, pruefFehler = false }) {
  const k = konfig;
  let inhalt;
  let aktualisieren = 0;
  const hinweisPruefung = pruefFehler
    ? '<p class="warnung">Der Zahlungsstatus konnte gerade nicht abgefragt werden. Die Seite versucht es automatisch erneut.</p>'
    : '';
  const gesperrt = b.gesperrt > 0 ? `<p class="warnung">Ein Teil der Zahlung (${h(betragText(b.gesperrt, weg))} ${h(weg.waehrung)}) ist zeitgesperrt und wird nicht angerechnet.</p>` : '';
  const bestaetigungen = k.mindestBestaetigungen === 1 ? 'einer Bestätigung' : `${k.mindestBestaetigungen} Bestätigungen`;
  const kopf = `<p class="klein">Bestellnummer</p><p class="nummer mono">${h(gruppieren(b.id))}</p>`;
  const widerrufLink = `<p class="klein">Doch nicht kaufen? <a href="/widerrufen?nr=${h(b.id)}">Vertrag widerrufen</a></p>`;
  const aktualisierenHinweis = `<p class="klein">Diese Seite aktualisiert sich jede Minute automatisch. <a href="/bestellung/${h(b.id)}">Jetzt aktualisieren</a></p>
${widerrufLink}`;

  switch (b.status) {
    case STATUS.OFFEN:
      aktualisieren = 60;
      inhalt = `<h1>Bitte bezahlen</h1>
${kopf}
${hinweisPruefung}
<section class="karte">
${zahlungsBlock(b, weg, b.betrag)}
<p>Gültig bis <strong>${h(datumZeit(b.gueltigBis))}</strong>. Ohne Zahlungseingang verfällt die Bestellung danach.</p>
</section>
${aktualisierenHinweis}`;
      break;

    case STATUS.UNTERZAHLT: {
      aktualisieren = 60;
      const fehlt = Math.max(0, b.betrag - Math.floor((b.betrag * k.toleranzProzent) / 100) - b.empfangen);
      const zahlbar = offenerBetrag(b, k.toleranzProzent, weg); // ggf. auf die Staubgrenze angehoben
      const angehoben = zahlbar > fehlt
        ? `<p class="klein">Kleinere Beträge als ${h(betragText(zahlbar, weg))} ${h(weg.waehrung)} lassen sich nicht senden. Bitte diesen Mindestbetrag zahlen – der Überschuss gilt als Überzahlung.</p>`
        : '';
      inhalt = `<h1>Zahlung unvollständig</h1>
${kopf}
${hinweisPruefung}
<section class="karte">
<p class="warnung">Bisher eingegangen: <strong>${h(betragText(b.empfangen, weg))} ${h(weg.waehrung)}</strong> von ${h(betragText(b.betrag, weg))} ${h(weg.waehrung)}. Es fehlen <strong>${h(betragText(fehlt, weg))} ${h(weg.waehrung)}</strong>.</p>
${gesperrt}
<p>Bitte den fehlenden Betrag an <strong>dieselbe Adresse</strong> senden:</p>
${angehoben}
${zahlungsBlock(b, weg, zahlbar)}
<p class="klein">Unvollständige Bestellungen bleiben ${h(k.bestellung.unvollstaendigAufbewahrenTage)} Tage bestehen. Für eine Erstattung wende dich mit deiner Bestellnummer an die Adresse im <a href="/impressum">Impressum</a>.</p>
</section>
${aktualisierenHinweis}`;
      break;
    }

    case STATUS.UNBESTAETIGT:
      aktualisieren = 60;
      inhalt = `<h1>Zahlung eingegangen</h1>
${kopf}
${hinweisPruefung}
<section class="karte">
<p class="erfolg">Deine Zahlung über ${h(betragText(b.empfangen, weg))} ${h(weg.waehrung)} wurde gesehen${b.bestaetigungen ? ` (${h(b.bestaetigungen)} Bestätigung${b.bestaetigungen === 1 ? '' : 'en'})` : ' (noch im Pool)'}.</p>
<p>Der Lizenznachweis erscheint hier, sobald die Zahlung mit ${h(bestaetigungen)} bestätigt ist. Das dauert meist nur wenige Minuten.</p>
</section>
${aktualisierenHinweis}`;
      break;

    case STATUS.BEZAHLT: {
      const ueber = Math.max(0, b.empfangen - b.betrag);
      inhalt = `<h1>Bezahlt – vielen Dank!</h1>
${kopf}
${lizenzBlock(b, k)}
${ueber > 0 ? `<p class="hinweis">Du hast ${h(betragText(ueber, weg))} ${h(weg.waehrung)} mehr als nötig gezahlt. Für eine Erstattung wende dich mit deiner Bestellnummer an die Adresse im <a href="/impressum">Impressum</a>.</p>` : ''}
<section class="karte">
<h2>Rechnung</h2>
<p>Rechnungsnummer ${h(b.rechnungsnummer)} · <a href="/bestellung/${h(b.id)}/rechnung">ansehen</a> · <a href="/bestellung/${h(b.id)}/rechnung?speichern=1">als HTML-Datei speichern</a></p>
</section>
<section class="karte">
<h2>Neues Gerät?</h2>
<p>Mit Bestellnummer und Wiederherstellungscode kannst du die Lizenz auf ein anderes Gerät umziehen: <a href="/umzug?nr=${h(b.id)}">Lizenz umziehen</a></p>
</section>`;
      break;
    }

    case STATUS.WIDERRUFEN: {
      const w = b.widerruf;
      inhalt = `<h1>Vertrag widerrufen</h1>
${kopf}
<section class="karte">
<p class="warnung"><strong>Bitte nichts mehr an die Adresse dieser Bestellung zahlen.</strong> Der Widerruf ist am ${h(datumZeit(w.zeit))} eingegangen.</p>
<p>${b.empfangen > 0 ? `Bisher eingegangen: <strong>${h(betragText(b.empfangen, weg))} ${h(weg.waehrung)}</strong>. Wir zahlen diesen Betrag zurück${w.rueckzahlAdresse ? ' an die hinterlegte Rückzahlungsadresse.' : ' – dafür fehlt noch eine Rückzahlungsadresse.'}` : 'Es ist keine Zahlung eingegangen.'}</p>
<p><a href="/widerrufen?nr=${h(b.id)}">Eingangsbestätigung abrufen${b.empfangen > 0 && !w.rueckzahlAdresse ? ' bzw. Rückzahlungsadresse nachtragen' : ''}</a> (mit Wiederherstellungscode)</p>
</section>`;
      break;
    }

    default:
      inhalt = `<h1>Bestellung abgelaufen</h1>
${kopf}
<section class="karte">
<p class="warnung"><strong>Bitte nicht mehr an die Adresse dieser Bestellung zahlen.</strong> Bis ${h(datumZeit(b.gueltigBis))} ist keine Zahlung eingegangen.</p>
<p>Falls du gerade doch bezahlt hast, wird die Zahlung noch kurze Zeit erkannt – lade die Seite in ein paar Minuten neu. Ansonsten lege einfach eine neue Bestellung an.</p>
<p><a class="knopf" href="/">Neue Bestellung</a></p>
${widerrufLink}
</section>`;
  }
  return rahmen({ titel: 'Bestellung', inhalt, aktualisieren, konfig: k });
}

export function abrufseite({ konfig, fehler = '' }) {
  const inhalt = `<h1>Bestellung abrufen</h1>
<section class="karte">
${fehler ? `<p class="fehler">${h(fehler)}</p>` : ''}
<form method="get" action="/bestellung" class="zeile">
<label for="nr">Bestellnummer</label>
<input id="nr" name="nr" type="text" autocomplete="off" spellcheck="false" maxlength="40" placeholder="XXXX-XXXX-XXXX-XXXX">
<button type="submit">Abrufen</button>
</form>
</section>`;
  return rahmen({ titel: 'Bestellung abrufen', inhalt, konfig });
}

// ---------------------------------------------------------------- Umzug

export function umzugseite({ konfig, fehler = '', nr = '', geraetecode = '', ergebnis = null }) {
  let inhalt;
  if (ergebnis) {
    const b = ergebnis.bestellung;
    inhalt = `<h1>Lizenz für das neue Gerät</h1>
<section class="karte merken">
<p>${ergebnis.neu ? 'Neue Aktivierung' : 'Für dieses Gerät wurde bereits eine Lizenz ausgestellt'} – Aktivierungen: ${h(ergebnis.aktivierungen)} von ${h(konfig.lizenz.maxAktivierungen)}.</p>
<textarea class="lizenz mono" readonly rows="5" aria-label="Lizenznachweis">${h(ergebnis.lizenz)}</textarea>
<div class="qrbox gross">${qrSvg(ergebnis.lizenz, { titel: 'QR-Code des Lizenznachweises' })}</div>
<p class="klein">Bestellnummer ${h(gruppieren(b.id))} · Lizenz-ID ${h(b.lizenzId)}</p>
</section>`;
  } else {
    inhalt = `<h1>Lizenz auf ein neues Gerät umziehen</h1>
<section class="karte">
<p>Die Lizenz ist an ein Gerät gebunden. Nach einem Gerätewechsel oder einer Neuinstallation stellt der Shop mit deinem Wiederherstellungscode eine neue Lizenz für das neue Gerät aus – insgesamt höchstens ${h(konfig.lizenz.maxAktivierungen)} Aktivierungen.</p>
${fehler ? `<p class="fehler">${h(fehler)}</p>` : ''}
<form method="post" action="/umzug">
<p class="zeile"><label for="nr">Bestellnummer</label><input id="nr" name="nr" type="text" autocomplete="off" spellcheck="false" maxlength="40" required value="${h(nr)}"></p>
<p class="zeile"><label for="code">Wiederherstellungscode</label><input id="code" name="code" type="text" autocomplete="off" spellcheck="false" maxlength="40" required></p>
<p class="zeile"><label for="geraet">Gerätecode des neuen Geräts</label><input id="geraet" name="geraetecode" type="text" autocomplete="off" spellcheck="false" maxlength="60" required value="${h(geraetecode)}"></p>
<button type="submit">Lizenz ausstellen</button>
</form>
</section>`;
  }
  return rahmen({ titel: 'Lizenz umziehen', inhalt, konfig });
}

// ---------------------------------------------------------------- Rechnung (Kleinbetragsrechnung)

export function rechnungHtml({ konfig, bestellung: b, weg, eigenstaendig = false }) {
  const k = konfig;
  const brutto = Number(b.preisEur);
  let steuer;
  if (k.umsatzsteuer.kleinunternehmer) {
    steuer = `<p>${h(k.umsatzsteuer.hinweisText)}</p>`;
  } else {
    const satz = k.umsatzsteuer.steuersatz;
    const ust = Math.round((brutto - brutto / (1 + satz / 100)) * 100) / 100;
    steuer = `<p>Im Gesamtbetrag sind ${h(satz)} % Umsatzsteuer (${h(euro(ust))}) enthalten.</p>`;
  }
  const anbieter = k.rechtliches.anbieter.length
    ? `<p>${k.rechtliches.anbieter.map(h).join('<br>\n')}</p>`
    : '<p class="warnung">Anbieterangaben (Name und Anschrift) fehlen in der Konfiguration.</p>';
  const stil = eigenstaendig
    ? `<style>body{font-family:system-ui,Arial,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:.4rem;text-align:left}.r{text-align:right}.mono{font-family:monospace;word-break:break-all}.klein{font-size:.85rem;color:#444}</style>`
    : '<link rel="stylesheet" href="/static/rechnung.css">';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rechnung ${h(b.rechnungsnummer)}</title>
${stil}
</head>
<body>
<h1>Rechnung</h1>
<h2>Leistender Unternehmer</h2>
${anbieter}
<table>
<tr><th>Rechnungsnummer</th><td>${h(b.rechnungsnummer)}</td></tr>
<tr><th>Ausstellungsdatum</th><td>${h(datum(b.bezahlt))}</td></tr>
<tr><th>Leistungsdatum</th><td>${h(datum(b.bezahlt))}</td></tr>
<tr><th>Bestellnummer</th><td>${h(gruppieren(b.id))}</td></tr>
</table>
<h2>Leistung</h2>
<table>
<tr><th>Menge</th><th>Bezeichnung</th><th class="r">Betrag</th></tr>
<tr><td>1</td><td>${h(k.texte.produkt)} – Lizenz zur Freischaltung der Premium-Funktionen für ein Gerät (digitale Leistung), Lizenz-ID ${h(b.lizenzId)}</td><td class="r">${h(euro(brutto))}</td></tr>
<tr><th></th><th>Gesamtbetrag</th><th class="r">${h(euro(brutto))}</th></tr>
</table>
${steuer}
<h2>Zahlung</h2>
<p>Bezahlt mit ${h(weg ? weg.name : b.waehrung)}: ${h(weg ? betragText(b.empfangen, weg) : b.empfangen)} ${h(b.waehrung)}${b.kurs ? ` (Referenzkurs 1 ${h(b.waehrung)} = ${h(euro(b.kurs.eurProCoin))})` : ''}.</p>
${b.txids.length ? `<p class="klein">Transaktion(en): <span class="mono">${b.txids.map(h).join(', ')}</span></p>` : ''}
${b.zustimmungWiderruf ? '<p class="klein">Der Käufer hat ausdrücklich verlangt, dass mit der Bereitstellung vor Ablauf der Widerrufsfrist begonnen wird, und bestätigt, dass er mit Beginn der Bereitstellung sein Widerrufsrecht verliert.</p>' : ''}
<p class="klein">Kleinbetragsrechnung. Der Käufer bleibt anonym.</p>
</body>
</html>
`;
}

// ---------------------------------------------------------------- Widerruf ("Vertrag widerrufen", § 356a BGB)

const WIDERRUF_INFO = 'Bis zur Bereitstellung des Lizenznachweises kannst du den Vertrag hier widerrufen – also auch zwischen Bestellung und Zahlungseingang. Nach der Bereitstellung ist das Widerrufsrecht erloschen, weil du ihr vor dem Kauf ausdrücklich zugestimmt hast.';

function widerrufFelder({ nr = '', name = '', adresse = '' }) {
  return `<p class="zeile"><label for="nr">Bestellnummer</label><input id="nr" name="nr" type="text" autocomplete="off" spellcheck="false" maxlength="40" required value="${h(nr)}" placeholder="XXXX-XXXX-XXXX-XXXX"></p>
<p class="zeile"><label for="code">Wiederherstellungscode</label><input id="code" name="code" type="text" autocomplete="off" spellcheck="false" maxlength="40" required placeholder="20 Zeichen"></p>
<p class="zeile"><label for="name">Name <span class="klein">(freiwillig)</span></label><input id="name" name="name" type="text" autocomplete="off" maxlength="100" value="${h(name)}"></p>
<p class="zeile"><label for="adresse">Rückzahlungsadresse <span class="klein">(nur nötig, wenn du schon etwas gezahlt hast oder noch etwas eingehen könnte)</span></label><input id="adresse" name="adresse" type="text" autocomplete="off" spellcheck="false" maxlength="120" value="${h(adresse)}" placeholder="Monero- bzw. Bitcoin-Adresse – passend zur Bestellung"></p>`;
}

/** Schritt 1: Angaben. */
export function widerrufFormular({ konfig, fehler = '', nr = '', name = '', adresse = '' }) {
  const inhalt = `<h1>Vertrag widerrufen</h1>
<section class="karte">
<p>${h(WIDERRUF_INFO)}</p>
${fehler ? `<p class="fehler">${h(fehler)}</p>` : ''}
<form method="post" action="/widerrufen">
<input type="hidden" name="schritt" value="pruefen">
${widerrufFelder({ nr, name, adresse })}
<button type="submit">Weiter</button>
</form>
<p class="klein">Ohne Wiederherstellungscode kannst du auch formlos per E-Mail oder Brief widerrufen (Adresse im <a href="/impressum">Impressum</a>, Muster in der <a href="/widerruf">Widerrufsbelehrung</a>).</p>
</section>`;
  return rahmen({ titel: 'Vertrag widerrufen', inhalt, konfig });
}

/** Schritt 2: Zusammenfassung und "Widerruf bestaetigen". */
export function widerrufPruefseite({ konfig, bestellung: b, weg, code, name = '', adresse = '' }) {
  const bereits = b.status === STATUS.WIDERRUFEN;
  const eingang = b.empfangen > 0 ? `${betragText(b.empfangen, weg)} ${weg.waehrung}` : 'noch keine Zahlung';
  const inhalt = `<h1>${bereits ? 'Angaben zum Widerruf ergänzen' : 'Widerruf prüfen'}</h1>
<section class="karte">
<dl class="daten">
<dt>Vertrag</dt><dd>${h(konfig.texte.produkt)}, Bestellnummer <span class="mono">${h(gruppieren(b.id))}</span>, bestellt am ${h(datum(b.erstellt))}</dd>
<dt>Bisher eingegangen</dt><dd>${h(eingang)}</dd>
<dt>Name</dt><dd>${name ? h(name) : '<span class="klein">nicht angegeben</span>'}</dd>
<dt>Rückzahlungsadresse</dt><dd class="mono umbruch">${adresse ? h(adresse) : '<span class="klein">nicht angegeben</span>'}</dd>
</dl>
${b.empfangen > 0 && !adresse ? '<p class="warnung">Es ist schon eine Zahlung eingegangen. Ohne Rückzahlungsadresse können wir sie nicht zurückzahlen – du kannst sie aber auch später noch hier ergänzen.</p>' : ''}
<form method="post" action="/widerrufen">
<input type="hidden" name="schritt" value="bestaetigen">
<input type="hidden" name="nr" value="${h(b.id)}">
<input type="hidden" name="code" value="${h(code)}">
<input type="hidden" name="name" value="${h(name)}">
<input type="hidden" name="adresse" value="${h(adresse)}">
<button type="submit">${bereits ? 'Angaben speichern' : 'Widerruf bestätigen'}</button>
</form>
<p class="klein"><a href="/widerrufen?nr=${h(b.id)}">Zurück und ändern</a></p>
</section>`;
  return rahmen({ titel: 'Widerruf prüfen', inhalt, konfig });
}

/** Inhalt der Eingangsbestaetigung (fuer Seite, Datei und App). */
export function widerrufBelegDaten({ konfig, bestellung: b, weg }) {
  const w = b.widerruf;
  const eingang = w.empfangenBeiWiderruf > 0 ? `${betragText(w.empfangenBeiWiderruf, weg)} ${weg.waehrung}` : 'keine Zahlung';
  const seither = b.empfangen > w.empfangenBeiWiderruf ? `${betragText(b.empfangen, weg)} ${weg.waehrung}` : null;
  return {
    titel: 'Eingangsbestätigung Ihres Widerrufs',
    anbieter: konfig.rechtliches.anbieter,
    eingangZeit: datumZeit(w.zeit),
    erklaerung: `Hiermit widerrufe ich den von mir abgeschlossenen Vertrag über die Bereitstellung der folgenden digitalen Inhalte: ${konfig.texte.produkt}, Bestellnummer ${gruppieren(b.id)}, bestellt am ${datum(b.erstellt)}.`,
    zeilen: [
      ['Eingang der Widerrufserklärung', datumZeit(w.zeit)],
      ['Bestellnummer', gruppieren(b.id)],
      ['Bestellt am', datum(b.erstellt)],
      ['Name', w.name || 'nicht angegeben'],
      ['Zahlungseingang bis zum Widerruf', eingang],
      ...(seither ? [['Zahlungseingang insgesamt (bis jetzt)', seither]] : []),
      ['Rückzahlungsadresse', w.rueckzahlAdresse || 'nicht angegeben'],
    ],
    folgen: [
      'Bitte zahle nichts mehr an die Zahlungsadresse dieser Bestellung.',
      w.lizenzAusgestellt ? 'Mit dem Widerruf endet das Recht, die zu dieser Bestellung ausgestellte Lizenz zu nutzen. Bitte entferne sie aus der App (die Lizenz wird offline geprüft und lässt sich technisch nicht zurückrufen).' : 'Es wird keine Lizenz ausgestellt – auch nicht für Zahlungen, die noch eingehen.',
      `Bereits eingegangene oder noch eingehende Beträge zahlen wir unverzüglich, spätestens 14 Tage nach Eingang dieses Widerrufs, in derselben Kryptowährung (${weg.name}) an die Rückzahlungsadresse zurück; die Netzwerkgebühr tragen wir.${w.rueckzahlAdresse ? '' : ' Dafür brauchen wir eine Rückzahlungsadresse – du kannst sie unter „Vertrag widerrufen“ mit Bestellnummer und Wiederherstellungscode nachtragen.'}`,
    ],
  };
}

/** Eingangsbestaetigung als Text (API/App). */
export function widerrufBelegText({ konfig, bestellung, weg }) {
  const d = widerrufBelegDaten({ konfig, bestellung, weg });
  return [d.titel, '', ...d.anbieter, '', `Ihre Widerrufserklärung ist am ${d.eingangZeit} bei uns eingegangen.`, '', 'Inhalt der Erklärung:', d.erklaerung, '', ...d.zeilen.map(([k, v]) => `${k}: ${v}`), '', ...d.folgen].join('\n');
}

/** Eingangsbestaetigung als HTML (Seite bzw. eigenstaendige Datei zum Speichern). */
export function widerrufBelegHtml({ konfig, bestellung, weg, eigenstaendig = false }) {
  const d = widerrufBelegDaten({ konfig, bestellung, weg });
  const koerper = `<h1>${h(d.titel)}</h1>
<p>${d.anbieter.map(h).join('<br>\n')}</p>
<p>Ihre Widerrufserklärung ist am <strong>${h(d.eingangZeit)}</strong> bei uns eingegangen.</p>
<h2>Inhalt der Erklärung</h2>
<p>${h(d.erklaerung)}</p>
<table>
${d.zeilen.map(([k, v]) => `<tr><th>${h(k)}</th><td class="umbruch">${h(v)}</td></tr>`).join('\n')}
</table>
<h2>Wie es weitergeht</h2>
<ul>
${d.folgen.map((z) => `<li>${h(z)}</li>`).join('\n')}
</ul>`;
  if (!eigenstaendig) return koerper;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(d.titel)} ${h(gruppieren(bestellung.id))}</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:.4rem;text-align:left;vertical-align:top}.umbruch{word-break:break-all}</style>
</head>
<body>
${koerper}
</body>
</html>
`;
}

/** Schritt 3: Bestaetigung mit Eingangsbestaetigung und Speichern-Knopf. */
export function widerrufBestaetigt({ konfig, bestellung: b, weg, code, neu }) {
  const inhalt = `<section class="karte merken">
${widerrufBelegHtml({ konfig, bestellung: b, weg })}
</section>
<form method="post" action="/widerrufen">
<input type="hidden" name="schritt" value="beleg">
<input type="hidden" name="nr" value="${h(b.id)}">
<input type="hidden" name="code" value="${h(code)}">
<button type="submit">Eingangsbestätigung speichern</button>
</form>
<p class="klein">${neu ? 'Bitte speichere die Eingangsbestätigung – wir können sie dir nicht zuschicken, da der Shop keine Kontaktdaten kennt.' : 'Deine Angaben wurden aktualisiert.'} Du kannst sie jederzeit mit Bestellnummer und Wiederherstellungscode unter „Vertrag widerrufen“ erneut abrufen.</p>`;
  return rahmen({ titel: 'Widerruf eingegangen', inhalt, konfig });
}

// ---------------------------------------------------------------- Rechtliches & Fehler

export function impressumseite({ konfig }) {
  const zeilen = konfig.rechtliches.impressum;
  const inhalt = `<h1>Impressum</h1>
<section class="karte">
${zeilen.length ? `<p>${zeilen.map(h).join('<br>\n')}</p>` : '<p class="warnung">Das Impressum wurde noch nicht hinterlegt.</p>'}
</section>`;
  return rahmen({ titel: 'Impressum', inhalt, konfig });
}

export function widerrufseite({ konfig }) {
  const zeilen = konfig.rechtliches.widerrufsbelehrung;
  const inhalt = `<h1>Widerrufsbelehrung</h1>
<section class="karte">
${zeilen.length ? absaetze(zeilen) : '<p class="warnung">Die Widerrufsbelehrung wurde noch nicht hinterlegt.</p>'}
</section>`;
  return rahmen({ titel: 'Widerrufsbelehrung', inhalt, konfig });
}

export function datenschutzseite({ konfig }) {
  const k = konfig;
  const inhalt = `<h1>Datenschutz</h1>
<section class="karte">
<h2>Was dieser Shop technisch tut</h2>
<ul>
<li>Der Shop ist ausschließlich als Tor-Onion-Dienst erreichbar. Alle Verbindungen kommen über den lokalen Tor-Dienst; IP-Adressen sind für den Shop nicht sichtbar.</li>
<li>Es werden keine Zugriffsprotokolle geführt, keine Cookies gesetzt, kein JavaScript und keine externen Ressourcen verwendet. Es gibt keine Konten, keine Namen und keine E-Mail-Adressen.</li>
<li>Pro Bestellung werden gespeichert: Bestellnummer, Zeitpunkte, Gerätecode (ein aus einem Geräteschlüssel abgeleiteter Prüfwert, kein Gerätename und keine Seriennummer), die für die Bestellung erzeugte Zahlungsadresse, Preis, Kurs und Betrag, eingegangene Beträge mit Transaktions-IDs, die Zustimmung zur sofortigen Bereitstellung, ein Prüfwert (Hash) des Wiederherstellungscodes sowie die ausgestellten Lizenzen.</li>
<li>Unbezahlte Bestellungen werden nach etwa ${h(k.bestellung.adresseReserviertStunden)} Stunden gelöscht, unvollständig bezahlte nach ${h(k.bestellung.unvollstaendigAufbewahrenTage)} Tagen. Bezahlte Bestellungen bleiben ${h(Math.round(k.bestellung.bezahlteAufbewahrenTage / 365))} Jahre gespeichert, damit ein Geräteumzug möglich bleibt.</li>
<li>Bei einem Widerruf („Vertrag widerrufen“) speichert der Shop zur Bestellung zusätzlich den Zeitpunkt, den Namen (nur wenn du ihn angibst) und die Rückzahlungsadresse. Ohne Zahlungseingang wird die Bestellung samt diesen Angaben nach Ende der Reservierung gelöscht, mit Zahlungseingang, sobald die Rückzahlung erledigt ist; in der Buchführung bleibt nur die Rückzahlung (Betrag, Transaktions-ID, Bestellnummer).</li>
<li>Für die gesetzlich vorgeschriebene Buchführung wird bei jedem Kauf ein Eintrag ohne Namen oder Kontaktdaten gespeichert (Rechnungsnummer, Zeitpunkt, Beträge, Kurs, Transaktions-ID, Lizenz-ID).</li>
<li>Wechselkurse werden über Tor bei öffentlichen Kursdiensten abgefragt.${
    k.zahlungswege.xmr.aktiv ? ' Monero-Zahlungseingänge prüft der Shop über ein eigenes Wallet, das nur Eingänge sehen kann; es verbindet sich über Tor mit dem Monero-Netz.' : ''
  }</li>
${
  k.zahlungswege.btc.aktiv
    ? `<li>Bitcoin-Zahlungseingänge prüft der Shop über Tor beim öffentlichen Dienst mempool.space; abgefragt werden nur die Zahlungsadressen der Bestellungen. Bitcoin-Zahlungen (Beträge und Adressen) sind in der Bitcoin-Blockchain für jeden öffentlich einsehbar${k.zahlungswege.xmr.aktiv ? ', Monero-Zahlungen nicht' : ''}.</li>`
    : ''
}
<li>Die App prüft den Lizenznachweis offline; dabei werden keine Daten an den Shop gesendet.</li>
</ul>
</section>
${k.rechtliches.datenschutzZusatz.length ? `<section class="karte">${absaetze(k.rechtliches.datenschutzZusatz)}</section>` : ''}`;
  return rahmen({ titel: 'Datenschutz', inhalt, konfig: k });
}

export function fehlerseite({ konfig, titel, text, zurueck = true }) {
  const inhalt = `<h1>${h(titel)}</h1>
<section class="karte">
<p>${h(text)}</p>
${zurueck ? '<p><a href="/">Zur Startseite</a></p>' : ''}
</section>`;
  return rahmen({ titel, inhalt, konfig });
}
