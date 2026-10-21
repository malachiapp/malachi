// Zentrale Netz-Konfiguration der App.
//
// Malachi braucht keinen eigenen Server mehr: Kopplung, Verbindungsaufbau,
// Anruf-Signalisierung und Nachrichten laufen direkt zwischen den Geraeten -
// zuerst ueber Tor (Onion-Dienste der Geraete, siehe TorTransport.js), danach
// nach Moeglichkeit direkt per WebRTC (Aushandlung ueber die Tor-Verbindung,
// siehe DirectUpgrade.js).
//
// STUN beantwortet nur die Frage "unter welcher oeffentlichen Adresse sieht
// mich das Internet?" - der Dienst sieht dabei die IP-Adresse, aber keine
// Inhalte, keine Kontakte und keine Signale.
//
// KEIN eigener Server mehr (Nutzerwunsch Okt. 2026: die App soll ein
// Selbstlaeufer sein, nichts muss betrieben werden): oeffentliche, kostenlose
// STUN-Dienste verschiedener, unabhaengiger Betreiber. Pro Verbindung werden
// nur ZWEI davon gefragt (im Wechsel, siehe ConnectionMode.iceServersForMode) -
// faellt einer aus, reicht der andere, und kein Betreiber sieht alle
// Verbindungen. Im Verbindungsweg "Privat" und "Nur Tor" wird kein STUN
// gefragt. Nur reine stun:-Adressen - nie TURN (nichts laeuft ueber Fremde).
// Nur deutsche Betreiber (DSGVO, kein US-Konzern/CLOUD Act) - Vergleich der
// Datenschutzbedingungen Okt. 2026: Nextcloud loescht Server-Logs nach
// spaetestens 7 Tagen und wertet sie nicht fuer Marketing aus; Cloudflare/
// Google (USA) nutzen Netzdaten auch fuer Analysen. Alle vier per
// STUN-Binding-Anfrage geprueft (antworten in ~35-50 ms).
export const STUN_POOL = [
  { url: 'stun:stun.nextcloud.com:443', operator: 'Nextcloud GmbH (Stuttgart)' },
  { url: 'stun:stun.sipgate.net:3478', operator: 'sipgate GmbH (Duesseldorf)' },
  { url: 'stun:stun.1und1.de:3478', operator: '1&1 (Montabaur)' },
  { url: 'stun:stun.t-online.de:3478', operator: 'Deutsche Telekom (Bonn)' },
];
// Wie viele STUN-Dienste je Verbindung gefragt werden.
export const STUN_PER_CONNECTION = 2;

// ── Vollversion ("Pro", siehe LicenseManager.js und shop/LIZENZ_FORMAT.md) ──
// Oeffentlicher Ed25519-Lizenzschluessel des Shops (base64url, 32 Byte, z. B.
// '11qYAYKx...') und Onion-Adresse des Shops ('<56 Zeichen>.onion'). Beide
// werden erst nach dem Deployment des Shops eingetragen. Solange einer davon
// null ist, zeigt die App "Kauf derzeit nicht verfuegbar" und die Pro-
// Funktionen bleiben gesperrt (ohne Schluessel laesst sich keine Lizenz
// pruefen). Fuer einen spaeteren Schluesselwechsel darf LICENSE_PUBLIC_KEY
// auch eine Liste sein (alter und neuer Schluessel gleichzeitig gueltig).
// Die App vertraut AUSSCHLIESSLICH diesen eingebauten Schluesseln - nie einem
// Schluessel, den der Shop (z. B. in /api/v1/info) mitschickt.
// Eingerichtet am 2026-10-19 auf dem Shop-Server (shop/deploy/install.sh).
export const LICENSE_PUBLIC_KEY = ['XPM_Y7B_fBSpH9j2T2slspH9UsKDcfoGFV33foSagrc'];
export const SHOP_ONION = '42bajzhrmwmi2hlmohje7nloyp3zbxzpzk4atcgt4cesogatnvbxn5ad.onion';
// Virtueller Port des Onion-Dienstes (shop/deploy/torrc-malachi-shop.conf:
// "HiddenServicePort 80 127.0.0.1:8085").
export const SHOP_PORT = 80;
// Nur fuer die Anzeige - den verbindlichen Betrag nennt der Shop pro Bestellung.
export const PRO_PRICE_EUR = '2,99';

// ── Vollversion in der Google-Play-Variante (Flavor "play", PLAY_STORE.md) ──
// Dort wird NICHT ueber den Shop verkauft, sondern ueber Google Play Billing
// (Einmalkauf, In-App-Produkt PLAY_PRODUCT_ID). Geprueft wird jeder Kauf
// ohne Server direkt auf dem Geraet (PlayPurchase.js): Signatur der
// Kaufdaten mit dem oeffentlichen RSA-Schluessel der App aus der Play
// Console ("Monetarisierung einrichten" -> "Lizenzierung", Base64 - beginnt
// mit "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"). Solange er null ist,
// zeigt die Play-Variante "Kauf derzeit nicht verfuegbar" und Pro bleibt
// gesperrt. In der Website-Variante werden beide Werte nicht benutzt.
export const PLAY_LICENSE_PUBLIC_KEY = null;
// Produkt-ID des Einmalkaufs in der Play Console (In-App-Produkt, nicht Abo).
// Laesst sich nach dem Anlegen in der Play Console nicht mehr aendern.
export const PLAY_PRODUCT_ID = 'malachi_pro';

// ── In-App-Updates (NUR Web-Version, siehe AppUpdater.js) ──────────────────
// Format und Pruefregeln: website/UPDATE_FORMAT.md. Die Play-Version
// aktualisiert sich nie selbst (AppUpdater.isUpdaterAvailable()).
//
// Oeffentliche Ed25519-Update-Signierschluessel (base64url ohne Auffuellung,
// 32 Byte). Ausgabe von "node website/werkzeuge/update-schluessel.mjs
// erzeugen" (bzw. "anzeigen"); derselbe Wert steht in website/seite.json
// bei "updateSchluessel". Eine LISTE fuer einen spaeteren Schluesselwechsel
// (alter und neuer gleichzeitig gueltig, UPDATE_FORMAT.md Abschnitt 7). Ein
// Manifest gilt, wenn EINER davon passt; die App vertraut nie einem
// Schluessel, den der Server mitschickt.
// Leer = Update-Pruefung aus, die Einstellungen zeigen "Updates werden
// eingerichtet" (es wird nichts abgerufen).
export const UPDATE_PUBLIC_KEYS = ['ETAIGUc3F9MDfCh79kCJk4FhnxSLifZqdBwqA6WZ0OM'];
// Onion-Adresse der WEBSITE (website/seite.json "onionAdresse") - Manifest und
// APKs kommen ausschliesslich von hier, ausschliesslich ueber Tor.
export const UPDATE_ONION = 'p75bcu4mna6lik35occlsoeoyke46zyikfuq2ugu3wdvu44e5c4wanyd.onion';
// Verzeichnis auf der Website (manifest.json, manifest.json.sig, APKs).
export const UPDATE_PATH = '/updates/';
