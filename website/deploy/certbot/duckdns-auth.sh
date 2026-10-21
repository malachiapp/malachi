#!/usr/bin/env bash
# certbot --manual-auth-hook fuer DNS-01 ueber DuckDNS (TXT-Eintrag setzen).
# Funktioniert ohne eingehenden Port 80 - ideal hinter DS-Lite/CGNAT.
# certbot setzt CERTBOT_DOMAIN und CERTBOT_VALIDATION; bei Verlaengerungen
# (certbot.timer) wird dieser Hook automatisch wieder benutzt.
#
# Installiert nach /usr/local/lib/malachi-web/certbot-duckdns-auth.sh
# Token: /etc/malachi-web/duckdns.token (root 0600)

set -euo pipefail

DOMAIN="${CERTBOT_DOMAIN:?CERTBOT_DOMAIN fehlt}"
WERT="${CERTBOT_VALIDATION:?CERTBOT_VALIDATION fehlt}"
case "$DOMAIN" in
  *.duckdns.org) ;;
  *) echo "Dieser Hook funktioniert nur fuer *.duckdns.org (nicht: $DOMAIN)." >&2; exit 1 ;;
esac
# DuckDNS kennt nur die Subdomain direkt vor .duckdns.org
SUB="${DOMAIN%.duckdns.org}"
SUB="${SUB##*.}"
[[ "$SUB" =~ ^[a-z0-9-]+$ ]] || { echo "Ungueltige Subdomain: $SUB" >&2; exit 1; }
[[ "$WERT" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Unerwarteter Pruefwert." >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < /etc/malachi-web/duckdns.token)"

# URL mit Token ueber stdin an curl (nicht in der Prozessliste sichtbar).
ANTWORT="$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&txt=%s&verbose=true"\n' "$SUB" "$TOKEN" "$WERT" \
  | curl -fsS --max-time 30 --proto '=https' --tlsv1.2 -K -)"
case "$ANTWORT" in
  OK*) ;;
  *) echo "DuckDNS hat den TXT-Eintrag nicht gesetzt (Antwort: ${ANTWORT%%$'\n'*})." >&2; exit 1 ;;
esac

# DuckDNS braucht einen Moment, bis alle Namensserver den Eintrag kennen.
sleep "${DUCKDNS_WARTEZEIT:-60}"
