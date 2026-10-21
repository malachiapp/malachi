#!/usr/bin/env bash
# Legt das VIEW-ONLY-Wallet des Shops an (einmalig, interaktiv).
#
# Du gibst NUR ein:
#   - die oeffentliche Hauptadresse (beginnt mit 4)
#   - den PRIVATEN VIEW-KEY (secret view key)
# NIEMALS den Seed (25 Woerter) oder den Spend-Key auf dem Server eingeben!
#
#   sudo bash deploy/wallet-einrichten.sh
#
# Das Wallet wird offline angelegt; synchronisiert wird spaeter durch den
# Dienst malachi-wallet-rpc ueber Tor.

set -euo pipefail

WALLET_NUTZER=malachi-wallet
WALLET_DIR=/var/lib/malachi-wallet
WALLET_DATEI="$WALLET_DIR/shop-view"
WKONF=/etc/malachi-wallet

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren (sudo)." >&2; exit 1; }
[ -x /opt/monero/monero-wallet-cli ] || { echo "monero-wallet-cli fehlt - zuerst deploy/monero-installieren.sh ausfuehren." >&2; exit 1; }
[ -f "$WKONF/wallet.pass" ] || { echo "$WKONF/wallet.pass fehlt - zuerst deploy/install.sh ausfuehren." >&2; exit 1; }
if [ -e "$WALLET_DATEI" ] || [ -e "$WALLET_DATEI.keys" ]; then
  echo "Es gibt bereits ein Wallet unter $WALLET_DATEI - Abbruch (nichts ueberschrieben)." >&2
  exit 1
fi

cat <<'TEXT'

==================================================================
 View-only-Wallet fuer den Malachi-Shop anlegen
==================================================================
 Gleich fragt monero-wallet-cli nach:
   1. "Standard address"  -> die Hauptadresse deines Shop-Wallets (4...)
   2. "Secret view key"   -> der PRIVATE View-Key (64 Hex-Zeichen)
 Danach erscheint die Wallet-Eingabeaufforderung: dort "exit" eingeben.

 NIEMALS Seed oder Spend-Key eingeben. Der Server soll Zahlungen nur
 SEHEN, nicht ausgeben koennen.
==================================================================

TEXT

read -r -p "Wiederherstellungs-Blockhoehe (aktuelle Monero-Blockhoehe, z. B. von einem Block-Explorer; leer = 0, dauert lange): " HOEHE
HOEHE="${HOEHE:-0}"
[[ "$HOEHE" =~ ^[0-9]+$ ]] || { echo "Blockhoehe muss eine Zahl sein." >&2; exit 1; }

install -d -o "$WALLET_NUTZER" -g "$WALLET_NUTZER" -m 0700 "$WALLET_DIR"
PASS_TMP="$(mktemp)"
trap 'shred -u "$PASS_TMP" 2>/dev/null || rm -f "$PASS_TMP"' EXIT
cp "$WKONF/wallet.pass" "$PASS_TMP"
chown "$WALLET_NUTZER:$WALLET_NUTZER" "$PASS_TMP"
chmod 0400 "$PASS_TMP"

cd "$WALLET_DIR"
# runuser statt sudo: sudo fehlt auf minimalen Debian-Installationen.
runuser -u "$WALLET_NUTZER" -- /opt/monero/monero-wallet-cli \
  --generate-from-view-key "$WALLET_DATEI" \
  --password-file "$PASS_TMP" \
  --restore-height "$HOEHE" \
  --offline \
  --log-file /dev/null

if [ -f "$WALLET_DATEI.keys" ]; then
  echo "View-only-Wallet angelegt: $WALLET_DATEI"
  echo "Weiter mit: sudo bash deploy/install.sh   (startet die Dienste, wenn alles konfiguriert ist)"
else
  echo "Wallet wurde nicht angelegt." >&2
  exit 1
fi
