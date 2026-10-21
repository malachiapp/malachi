#!/usr/bin/env bash
# Bindet dein Kraken-Konto an das Verkaufsmodul des Shops an (interaktiv).
# Der Shop verkauft dann Bitcoin, die DU selbst auf Kraken eingezahlt hast,
# automatisch per Market-Order gegen Euro und bucht jeden Verkauf.
#
#   sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh           Schluessel eingeben + pruefen, Probelauf starten
#   sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh --scharf  echte Verkaeufe einschalten (nach dem Probelauf)
#   sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh --pruefen Schluessel erneut pruefen
#   sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh --aus     Anbindung entfernen, Schluessel loeschen
#
# Der Schluessel wird verdeckt eingegeben (nichts erscheint am Bildschirm, nichts
# landet in der Shell-History) und nur als root-Datei (0600) gespeichert. Der
# Shop erhaelt ihn per systemd-Credential im RAM. Ein Schluessel, der AUSZAHLEN
# darf, wird abgelehnt.

set -euo pipefail

KONF=/etc/malachi-shop
ZIEL=/opt/malachi-shop
DATEI="$KONF/kraken-api.json"
DROPIN_DIR=/etc/systemd/system/malachi-shop.service.d
DROPIN="$DROPIN_DIR/kraken.conf"

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren (sudo)." >&2; exit 1; }
[ -f "$KONF/config.json" ] && [ -f "$ZIEL/src/werkzeuge/kraken-pruefen.js" ] || { echo "Shop nicht installiert - zuerst deploy/install.sh ausfuehren." >&2; exit 1; }

# config.json: verkauf.modus und verkauf.kraken.nurProbelauf setzen (vorher Sicherungskopie).
konfig_setzen() {
  local modus="$1" probelauf="$2"
  cp -p "$KONF/config.json" "$KONF/config.json.vor-kraken-$(date +%Y%m%d-%H%M%S)"
  node -e '
    const fs = require("fs");
    const [datei, modus, probelauf] = process.argv.slice(1);
    const k = JSON.parse(fs.readFileSync(datei, "utf8"));
    k.verkauf = k.verkauf || {};
    k.verkauf.kraken = k.verkauf.kraken || {};
    k.verkauf.modus = modus;
    k.verkauf.kraken.nurProbelauf = probelauf === "ja";
    if (!k.verkauf.kraken.zugang) k.verkauf.kraken.zugang = "credential:kraken-api";
    fs.writeFileSync(datei, JSON.stringify(k, null, 2) + "\n");
  ' "$KONF/config.json" "$modus" "$probelauf"
}

# Pruefung als Dienstnutzer statt root (Audit 2026-10-19, S5): der Schluessel
# kommt per systemd-Credential, die Kraken-Antworten verarbeitet kein root-Prozess.
pruefen() {
  systemd-run --quiet --pipe --wait --collect     -p User=malachi-shop -p Group=malachi-shop -p UMask=0077     -p "LoadCredential=kraken-api:$1"     /usr/bin/node "$ZIEL/src/werkzeuge/kraken-pruefen.js" --zugang credential:kraken-api --config "$KONF/config.json"
}

neu_starten() {
  systemctl daemon-reload
  systemctl restart malachi-shop
  echo "Shop neu gestartet. Protokoll: journalctl -u malachi-shop -f"
}

case "${1:-}" in
  --aus)
    konfig_setzen manuell ja
    rm -f "$DROPIN"
    if [ -f "$DATEI" ]; then shred -u "$DATEI" 2>/dev/null || rm -f "$DATEI"; fi
    neu_starten
    echo "Kraken-Anbindung entfernt. Den API-Schluessel bitte auch bei Kraken loeschen (Einstellungen -> API)."
    exit 0
    ;;
  --pruefen)
    [ -f "$DATEI" ] || { echo "Kein Kraken-Schluessel eingerichtet." >&2; exit 1; }
    pruefen "$DATEI"
    exit $?
    ;;
  --scharf)
    [ -f "$DATEI" ] && [ -f "$DROPIN" ] || { echo "Zuerst ohne Option ausfuehren (Schluessel einrichten, Probelauf)." >&2; exit 1; }
    pruefen "$DATEI" || { echo "Pruefung nicht bestanden - echte Verkaeufe bleiben aus." >&2; exit 1; }
    echo
    echo "Ab jetzt verkauft der Shop BTC-Guthaben auf Kraken ab dem eingestellten Schwellenwert"
    echo "(verkauf.kraken.schwellenwert, abzueglich verkauf.kraken.reserve) per Market-Order gegen EUR."
    read -r -p "Echte Verkaeufe einschalten? Bitte 'ja' eingeben: " ANTWORT
    [ "$ANTWORT" = "ja" ] || { echo "Abgebrochen - nichts geaendert."; exit 0; }
    konfig_setzen kraken nein
    neu_starten
    echo "Echte Verkaeufe sind EIN. Zurueck zum Probelauf: config.json verkauf.kraken.nurProbelauf = true."
    exit 0
    ;;
  "") ;;
  *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
esac

cat <<'TEXT'

==================================================================
 Kraken an den Malachi-Shop anbinden
==================================================================
 Bei Kraken (Einstellungen -> API -> neuen Schluessel erstellen)
 NUR diese Rechte anhaken:
   [x] Funds: Query
   [x] Orders and trades: Query open orders & trades
   [x] Orders and trades: Query closed orders & trades
   [x] Orders and trades: Create & modify orders
 NICHT anhaken: Withdraw, Deposit, Earn, Cancel/close, Ledger, Export.
 IP-Whitelist leer lassen (der Shop geht ueber Tor), Nonce-Fenster 0.

 Gleich wirst du nach "API Key" und "Private Key" gefragt. Die Eingabe
 ist unsichtbar - einfach einfuegen (Rechtsklick) und Enter druecken.
==================================================================

TEXT

read -r -s -p "API Key: " KEY; echo
read -r -s -p "Private Key: " GEHEIM; echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
GEHEIM="$(printf '%s' "$GEHEIM" | tr -d '[:space:]')"

TMP="$(umask 077 && mktemp "$KONF/.kraken-neu.XXXXXX")"
trap 'if [ -f "$TMP" ]; then shred -u "$TMP" 2>/dev/null || rm -f "$TMP"; fi' EXIT
# Ueber stdin statt Argumente: so erscheint der Schluessel nicht in der Prozessliste.
printf '%s\n%s\n' "$KEY" "$GEHEIM" | node --input-type=module -e '
  import fs from "node:fs";
  import { krakenZugangFehler } from "'"$ZIEL"'/src/verkauf.js";
  const [apiKey = "", apiSecret = ""] = fs.readFileSync(0, "utf8").split("\n");
  const fehler = krakenZugangFehler(apiKey, apiSecret);
  if (fehler) { console.error(fehler); process.exit(1); }
  fs.writeFileSync(process.argv[1], JSON.stringify({ apiKey, apiSecret }) + "\n", { mode: 0o600 });
' "$TMP" || { echo "Eingabe verworfen - bitte erneut ausfuehren." >&2; exit 1; }
unset KEY GEHEIM
chown root:root "$TMP"; chmod 0600 "$TMP"

echo
if ! pruefen "$TMP"; then
  echo >&2
  echo "Der Schluessel wurde NICHT gespeichert. Rechte bei Kraken korrigieren (oder neuen Schluessel anlegen) und erneut ausfuehren." >&2
  exit 1
fi

mv -f "$TMP" "$DATEI"
chown root:root "$DATEI"; chmod 0600 "$DATEI"
install -d -o root -g root -m 0755 "$DROPIN_DIR"
printf '[Service]\n# Kraken-API-Schluessel (OHNE Auszahlungsrecht) - von deploy/kraken-einrichten.sh\nLoadCredential=kraken-api:%s\n' "$DATEI" > "$DROPIN"
chmod 0644 "$DROPIN"
konfig_setzen kraken ja
neu_starten

cat <<'TEXT'

==================================================================
 Kraken ist angebunden - im PROBELAUF.
==================================================================
 Der Shop prueft stuendlich dein BTC-Guthaben auf Kraken. Ab dem
 Schwellenwert meldet er im Protokoll nur "Verkauf (Probelauf): wuerde
 ... verkaufen" - es wird noch NICHTS verkauft.

 Wenn der Probelauf passt, echte Verkaeufe einschalten:
   sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh --scharf
==================================================================
TEXT
