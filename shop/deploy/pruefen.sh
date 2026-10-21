#!/usr/bin/env bash
# Prueft Konfiguration, Lizenzschluessel, Buchhaltung, wallet-rpc (view-only?) und
# Kursquellen ueber Tor - mit denselben Rechten und Geheimnissen wie der Dienst.
# Ist Kraken angebunden, zusaetzlich den API-Schluessel (kein Auszahlungsrecht?).
#
#   sudo bash /opt/malachi-shop/deploy/pruefen.sh

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren (sudo)." >&2; exit 1; }

EXTRA=()
[ -f /etc/malachi-shop/kraken-api.json ] && EXTRA+=(-p "LoadCredential=kraken-api:/etc/malachi-shop/kraken-api.json")

systemd-run --quiet --pipe --wait --collect \
  -p User=malachi-shop -p Group=malachi-shop \
  -p StateDirectory=malachi-shop -p UMask=0077 \
  -p "LoadCredential=lizenz-schluessel:/etc/malachi-shop/lizenz-privat.pem" \
  -p "LoadCredential=wallet-rpc-login:/etc/malachi-shop/wallet-rpc.login" \
  "${EXTRA[@]}" \
  /usr/bin/node /opt/malachi-shop/src/server.js --config /etc/malachi-shop/config.json --pruefen

echo
echo "Hash-Ketten der Buchhaltung:"
# runuser statt sudo: sudo fehlt auf minimalen Debian-Installationen.
runuser -u malachi-shop -- node /opt/malachi-shop/src/werkzeuge/buchhaltung.js pruefen --daten /var/lib/malachi-shop

if [ -f /etc/malachi-shop/kraken-api.json ]; then
  echo
  echo "Kraken-Anbindung:"
  systemd-run --quiet --pipe --wait --collect     -p User=malachi-shop -p Group=malachi-shop -p UMask=0077     -p "LoadCredential=kraken-api:/etc/malachi-shop/kraken-api.json"     /usr/bin/node /opt/malachi-shop/src/werkzeuge/kraken-pruefen.js --zugang credential:kraken-api --config /etc/malachi-shop/config.json || true
fi

echo
echo "Widerrufe:"
runuser -u malachi-shop -- node /opt/malachi-shop/src/werkzeuge/widerrufe.js liste --daten /var/lib/malachi-shop || true
