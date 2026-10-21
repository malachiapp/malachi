#!/usr/bin/env bash
# certbot --manual-cleanup-hook fuer DNS-01 ueber DuckDNS (TXT-Eintrag leeren).
# Installiert nach /usr/local/lib/malachi-web/certbot-duckdns-cleanup.sh

set -euo pipefail

DOMAIN="${CERTBOT_DOMAIN:?CERTBOT_DOMAIN fehlt}"
SUB="${DOMAIN%.duckdns.org}"
SUB="${SUB##*.}"
[[ "$SUB" =~ ^[a-z0-9-]+$ ]] || exit 0
TOKEN="$(tr -d '[:space:]' < /etc/malachi-web/duckdns.token)"
printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&txt=removed&clear=true"\n' "$SUB" "$TOKEN" \
  | curl -fsS --max-time 30 --proto '=https' --tlsv1.2 -K - >/dev/null || true
