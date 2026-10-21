// Schnittstelle fuer externe, gehostete Zahlungsdienstleister ("Zahlungsanbieter
// mit Rechnung"), z. B. Dienste, bei denen der Shop per API eine Rechnung anlegt
// und der Dienst die Zahlung entgegennimmt.
//
// Es ist bewusst KEIN echter Anbieter fest verdrahtet. Ein Adapter ist ein Objekt
// mit folgenden Eigenschaften/Methoden:
//
//   art            = 'rechnung'
//   name           Anzeigename, z. B. "Beispieldienst"
//   waehrung       Coin, in dem der Kunde zahlt (z. B. 'XMR')
//   einheit        Atomare Einheiten je Coin (XMR: 1e12, BTC: 1e8)
//   stellen        Nachkommastellen (XMR: 12, BTC: 8)
//   anzeigeStellen minimale Nachkommastellen in der Anzeige
//   fingerabdruck  stabile Kennung des Kontos beim Anbieter (fuer die Datenhaltung)
//
//   async pruefen()                                   Startpruefung (Zugang, Erreichbarkeit)
//   async rechnungErstellen({ bestellnummer, preisEur, beschreibung })
//        -> { referenz, adresse, betrag (atomar, Number), gueltigBis (ms) | null,
//             kurs: { eurProCoin, quellen, abgerufen, methode } | null }
//   async rechnungsstatus(referenz)
//        -> { empfangen, bestaetigt (atomar), txids: string[],
//             endgueltig: null | 'abgelaufen' | 'fehlgeschlagen',
//             gebuehren: [{ waehrung, betrag (Dezimaltext), betragEur (Dezimaltext), referenz }] }
//   uri(adresse, betragText)                          Zahlungs-URI fuer den QR-Code
//
// Optional:
//   webhookPruefen(kopfzeilen, rohKoerper) -> referenz
//        Prueft die Signatur einer Benachrichtigung (IPN). Der Shop nutzt eine
//        gueltige Benachrichtigung NUR als Ausloeser fuer eine sofortige Abfrage
//        per rechnungsstatus() - dem Inhalt der Benachrichtigung selbst wird nie
//        vertraut. Hinweis: Ein reiner Onion-Dienst ist fuer Clearnet-Dienste
//        meist nicht erreichbar; dann bleibt es beim regelmaessigen Abfragen.
//   async auszahlungen(seitMs)
//        -> [{ datum: 'JJJJ-MM-TT', waehrung, betrag, betragEur, referenz }]
//        Auszahlungen des Dienstes an den Betreiber; werden in die Buchhaltung uebernommen.
//
// Alle ausgehenden Verbindungen eines Adapters muessen ueber Tor laufen (holeUeberTor).

const PFLICHT = ['pruefen', 'rechnungErstellen', 'rechnungsstatus', 'uri'];

export function pruefeAdapter(a) {
  const fehler = [];
  if (!a || a.art !== 'rechnung') fehler.push('art muss "rechnung" sein');
  for (const m of PFLICHT) if (!a || typeof a[m] !== 'function') fehler.push(`Methode ${m} fehlt`);
  if (!a || typeof a.name !== 'string') fehler.push('name fehlt');
  if (!a || !['XMR', 'BTC'].includes(a.waehrung)) fehler.push('waehrung muss XMR oder BTC sein');
  if (!a || !Number.isFinite(a.einheit) || !Number.isInteger(a.stellen)) fehler.push('einheit/stellen fehlen');
  if (!a || typeof a.fingerabdruck !== 'string') fehler.push('fingerabdruck fehlt');
  if (fehler.length) throw new Error('Zahlungsdienst-Adapter ungueltig: ' + fehler.join(', '));
  return a;
}
