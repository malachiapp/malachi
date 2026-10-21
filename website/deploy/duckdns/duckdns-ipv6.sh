#!/usr/bin/env bash
# Traegt die aktuelle, STABILE IPv6-Adresse des Laptops bei DuckDNS ein.
# Laeuft als systemd-Dienst malachi-duckdns.service (Timer alle 5 Minuten),
# ersetzt den alten Cronjob /opt/malachi/duckdns-ipv6-update.sh.
#
# Der Heimanschluss hat keine nutzbare oeffentliche IPv4 (DS-Lite/CGNAT).
# Deshalb wird "ip=" ausdruecklich LEER gesendet und die Anfrage nur ueber
# IPv6 gestellt - sonst traegt DuckDNS die (fuer eingehende Verbindungen
# nutzlose) IPv4 automatisch ein.
#
# Token: systemd-Credential "duckdns-token" (/etc/malachi-web/duckdns.token, root 0600).
# Subdomain: DUCKDNS_SUBDOMAIN aus /etc/malachi-web/duckdns.env (z. B. malachii).

set -euo pipefail

SUB="${DUCKDNS_SUBDOMAIN:-}"
[[ "$SUB" =~ ^[a-z0-9-]+$ ]] || { echo "DUCKDNS_SUBDOMAIN fehlt oder ist ungueltig." >&2; exit 1; }
TOKEN_DATEI="${CREDENTIALS_DIRECTORY:-/etc/malachi-web}/duckdns-token"
[ -r "$TOKEN_DATEI" ] || TOKEN_DATEI=/etc/malachi-web/duckdns.token
TOKEN="$(tr -d '[:space:]' < "$TOKEN_DATEI")"
[[ "$TOKEN" =~ ^[0-9a-f-]{36}$ ]] || { echo "DuckDNS-Token hat ein unerwartetes Format." >&2; exit 1; }

# Stabile globale Adresse: keine temporaere (Privacy Extensions), keine
# veraltete, keine ULA (fd00::/8). Die FRITZ!Box-Portfreigabe gilt fuer genau
# diese Adresse (Interface-ID).
ADRESSE="$(ip -6 -o addr show scope global -temporary -deprecated -tentative -dadfailed 2>/dev/null \
  | awk '{print $4}' | cut -d/ -f1 | grep -v -i '^f[cd]' | head -n1 || true)"
[ -n "$ADRESSE" ] || { echo "Keine stabile globale IPv6-Adresse gefunden." >&2; exit 1; }

STAND=/var/lib/malachi-duckdns/letzte-adresse
if [ -f "$STAND" ] && [ "$(cat "$STAND")" = "$ADRESSE" ] && [ "$(find "$STAND" -mmin -60 2>/dev/null)" ]; then
  exit 0   # unveraendert und vor weniger als 60 min gemeldet
fi

# URL (mit Token) ueber stdin an curl - so steht der Token nicht in der Prozessliste.
ANTWORT="$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=&ipv6=%s"\n' "$SUB" "$TOKEN" "$ADRESSE" \
  | curl -6 -fsS --max-time 30 --proto '=https' --tlsv1.2 -K - || true)"
if [ "$ANTWORT" = "OK" ]; then
  printf '%s' "$ADRESSE" > "$STAND"
  echo "DuckDNS: ${SUB}.duckdns.org -> ${ADRESSE}"
else
  echo "DuckDNS-Aktualisierung fehlgeschlagen (Antwort: ${ANTWORT:-keine})." >&2
  exit 1
fi
