#!/usr/bin/env bash
# Prueft die Malachi-Website auf dem Laptop: Dienste, Onion-Dienst, Clearnet
# (Zertifikat, Header), signierte Updates, Datenschutz (keine Zugriffsprotokolle),
# Firewall und Systemzustand.
# Installiert als /usr/local/sbin/malachi-web-pruefen (website/deploy/install.sh).
#
#   sudo malachi-web-pruefen          lokale Pruefung (wenige Sekunden)
#   sudo malachi-web-pruefen --tor    zusaetzlich die Onion-Adresse ueber das Tor-Netz abrufen (bis 2 min)
#
# Rueckgabe: 0 = alles in Ordnung (Hinweise moeglich), 1 = mindestens ein Fehler.

set -uo pipefail

KONF=/etc/malachi-web
HS=/var/lib/tor/malachi-web
WURZEL=/var/www/malachi/aktuell
FEHLER=0
HINWEISE=0
ok() { printf '  [OK]      %s\n' "$*"; }
schlecht() { printf '  [FEHLER]  %s\n' "$*"; FEHLER=$((FEHLER + 1)); }
hinweis() { printf '  [HINWEIS] %s\n' "$*"; HINWEISE=$((HINWEISE + 1)); }
abschnitt() { printf '\n%s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
MIT_TOR=0
[ "${1:-}" = "--tor" ] && MIT_TOR=1

DOMAIN=""
DUCKDNS_UPDATER=0
FIREWALL=1
if [ -f "$KONF/web.env" ]; then
  DOMAIN="$(sed -n 's/^DOMAIN=//p' "$KONF/web.env")"
  DUCKDNS_UPDATER="$(sed -n 's/^DUCKDNS_UPDATER=//p' "$KONF/web.env")"
  FW="$(sed -n 's/^FIREWALL=//p' "$KONF/web.env")"
  [ -n "$FW" ] && FIREWALL="$FW"
fi

kopf() { # kopf <url> [curl-optionen ...] -> Antwort-Header
  local url="$1"; shift
  curl -sS -o /dev/null -D - --max-time 15 "$@" "$url" 2>/dev/null | tr -d '\r'
}
hat_header() { grep -i "^$1:" <<<"$2" >/dev/null; }

signatur_pruefen() { # signatur_pruefen <manifest> <sig> <base64url-schluessel>
  local tmp b64 sig rc
  tmp="$(mktemp -d)"
  b64="$(printf '%s=' "$3" | tr '_-' '/+')"
  { echo '-----BEGIN PUBLIC KEY-----'
    { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; printf '%s' "$b64" | base64 -d; } | base64 -w0
    echo; echo '-----END PUBLIC KEY-----'; } > "$tmp/k.pem"
  sig="$(tr -d '\r\n' < "$2")"
  printf '%s' "$sig" | base64 -d > "$tmp/s.bin" 2>/dev/null
  openssl pkeyutl -verify -pubin -inkey "$tmp/k.pem" -rawin -in "$1" -sigfile "$tmp/s.bin" >/dev/null 2>&1
  rc=$?
  rm -rf "$tmp"
  return $rc
}

# ------------------------------------------------------------------ Dienste
abschnitt "Dienste"
DIENSTE="nginx tor@default"
[ "$FIREWALL" = "1" ] && DIENSTE="$DIENSTE nftables"   # FIREWALL=0: Server hat eine eigene Firewall (z. B. ufw)
for d in $DIENSTE; do
  if systemctl is-active --quiet "$d"; then ok "$d laeuft"; else schlecht "$d laeuft nicht (systemctl status $d)"; fi
done
if nginx -t -q 2>/dev/null; then ok "nginx-Konfiguration gueltig"; else schlecht "nginx -t meldet Fehler"; fi
systemctl is-active --quiet apt-daily-upgrade.timer && ok "automatische Updates (apt-daily-upgrade.timer) aktiv" || schlecht "apt-daily-upgrade.timer nicht aktiv"
grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null && ok "unattended-upgrades eingeschaltet" || schlecht "unattended-upgrades ist nicht eingeschaltet"
if [ -n "$DOMAIN" ]; then
  systemctl is-active --quiet certbot.timer && ok "certbot.timer (Zertifikat verlaengern) aktiv" || hinweis "certbot.timer nicht aktiv"
fi
if [ -f "$KONF/duckdns.env" ] && [ "$DUCKDNS_UPDATER" = "1" ]; then
  systemctl is-active --quiet malachi-duckdns.timer && ok "DuckDNS-Aktualisierung aktiv" || schlecht "malachi-duckdns.timer nicht aktiv"
  systemctl is-failed --quiet malachi-duckdns.service && schlecht "letzte DuckDNS-Aktualisierung fehlgeschlagen (journalctl -u malachi-duckdns)"
fi

# ------------------------------------------------------------------ Onion
abschnitt "Onion-Dienst"
ONION=""
if [ -s "$HS/hostname" ]; then
  ONION="$(tr -d '[:space:]' < "$HS/hostname")"
  ok "Onion-Adresse: http://$ONION/"
  # 700, unter Ubuntu 2700 (setgid auf Tor-Ordnern) - beides nur fuer debian-tor
  case "$(stat -c '%U %a' "$HS")" in "debian-tor 700"|"debian-tor 2700") true ;; *) false ;; esac && ok "Schluesselordner nur fuer debian-tor lesbar" || schlecht "Rechte von $HS falsch (erwartet debian-tor 700)"
else
  schlecht "keine Onion-Adresse in $HS/hostname"
fi
H="$(kopf http://127.0.0.1:8090/ --haproxy-protocol -H "Host: ${ONION:-localhost}")"
if grep -q '^HTTP/[0-9.]* 200' <<<"$H"; then ok "Onion-Server (127.0.0.1:8090) liefert die Startseite"; else schlecht "Onion-Server antwortet nicht mit 200"; fi
hat_header Content-Security-Policy "$H" && ok "CSP gesetzt" || schlecht "Content-Security-Policy fehlt"
hat_header Onion-Location "$H" && schlecht "Onion-Location darf auf der Onion-Seite nicht stehen" || ok "kein Onion-Location auf der Onion-Seite"
hat_header Strict-Transport-Security "$H" && schlecht "HSTS darf auf der Onion-Seite (HTTP) nicht stehen" || ok "kein HSTS auf der Onion-Seite"
grep -qi '^Server: nginx$' <<<"$H" && ok "Server-Header ohne Versionsnummer" || hinweis "Server-Header: $(grep -i '^Server:' <<<"$H")"
if curl -s -o /dev/null --max-time 5 http://127.0.0.1:8090/; then
  schlecht "Onion-Server antwortet auch ohne PROXY-Zeile (proxy_protocol fehlt?)"
else
  ok "Onion-Server verlangt die PROXY-Zeile von Tor"
fi
if [ -n "$ONION" ] && [ -f "$WURZEL/index.html" ]; then
  if grep -q "$ONION" "$WURZEL/index.html"; then
    ok "veroeffentlichte Seite nennt diese Onion-Adresse"
  elif grep -q 'Die Website wird gerade eingerichtet' "$WURZEL/index.html"; then
    hinweis "noch die Platzhalter-Seite aktiv - erste Version vom PC hochladen"
  else
    schlecht "veroeffentlichte Seite nennt eine ANDERE Onion-Adresse (website/seite.json \"onionAdresse\" pruefen)"
  fi
fi
if [ "$MIT_TOR" = "1" ] && [ -n "$ONION" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 --socks5-hostname 127.0.0.1:9050 "http://$ONION/" || true)"
  [ "$CODE" = "200" ] && ok "ueber das Tor-Netz erreichbar" || schlecht "ueber Tor nicht erreichbar (HTTP $CODE) - journalctl -u tor@default"
fi

# ------------------------------------------------------------------ Clearnet
if [ -n "$DOMAIN" ]; then
  abschnitt "Clearnet ($DOMAIN)"
  ZERT=/etc/letsencrypt/live/malachi-web/fullchain.pem
  if [ -s "$ZERT" ]; then
    ENDE="$(openssl x509 -enddate -noout -in "$ZERT" | cut -d= -f2)"
    TAGE=$(( ($(date -d "$ENDE" +%s) - $(date +%s)) / 86400 ))
    if [ "$TAGE" -lt 14 ]; then schlecht "Zertifikat laeuft in $TAGE Tagen ab (certbot renew --dry-run pruefen)"
    elif [ "$TAGE" -lt 30 ]; then hinweis "Zertifikat laeuft in $TAGE Tagen ab (Verlaengerung sollte bald laufen)"
    else ok "Zertifikat gueltig, noch $TAGE Tage"; fi
    openssl x509 -noout -issuer -in "$ZERT" | grep -qi 'staging\|fake\|test' && hinweis "TEST-Zertifikat (LE_TEST=1) - Browser vertrauen ihm nicht"
    H="$(kopf "https://$DOMAIN/" -k --resolve "$DOMAIN:443:127.0.0.1")"
    if grep -q '^HTTP/[0-9.]* 200' <<<"$H"; then ok "HTTPS liefert die Startseite"; else schlecht "HTTPS antwortet nicht mit 200"; fi
    hat_header Strict-Transport-Security "$H" && ok "HSTS gesetzt" || schlecht "HSTS fehlt"
    if [ -n "$ONION" ] && grep -qi "^Onion-Location: http://$ONION/" <<<"$H"; then ok "Onion-Location zeigt auf die Onion-Adresse"; else schlecht "Onion-Location fehlt oder falsch"; fi
    hat_header Content-Security-Policy "$H" && ok "CSP gesetzt" || schlecht "Content-Security-Policy fehlt"
    if openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" -groups X25519MLKEM768 </dev/null 2>/dev/null | grep -qi 'X25519MLKEM768'; then
      ok "Post-Quanten-Schluesseltausch X25519MLKEM768 wird angeboten"
    else
      hinweis "X25519MLKEM768 wird nicht angeboten (OpenSSL < 3.5?) - klassisches TLS laeuft trotzdem"
    fi
  else
    schlecht "noch kein Zertifikat ($ZERT) - install.sh mit LE_AGB=ja erneut ausfuehren"
  fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/")"
  [ "$CODE" = "301" ] && ok "HTTP leitet auf HTTPS um" || hinweis "HTTP antwortet mit $CODE (301 erwartet, 503 = noch ohne Zertifikat)"
  if curl -sk -o /dev/null --max-time 5 --resolve "unbekannt.invalid:443:127.0.0.1" https://unbekannt.invalid/; then
    schlecht "unbekannte Hostnamen bekommen eine TLS-Verbindung (Auffang-Server fehlt?)"
  else
    ok "unbekannte Hostnamen werden abgewiesen"
  fi
  if [ "$DUCKDNS_UPDATER" = "1" ]; then
    EIGENE="$(ip -6 -o addr show scope global -temporary -deprecated 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v -i '^f[cd]' || true)"
    DNS6="$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | head -n1)"
    if [ -z "$DNS6" ]; then schlecht "kein AAAA-Eintrag fuer $DOMAIN"
    elif grep -qx "$DNS6" <<<"$EIGENE"; then ok "AAAA-Eintrag zeigt auf diesen Laptop ($DNS6)"
    else hinweis "AAAA-Eintrag ($DNS6) ist keine Adresse dieses Laptops (${EIGENE:-keine}) - DuckDNS/Portfreigabe pruefen"; fi
    DNS4="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | head -n1)"
    [ -n "$DNS4" ] && hinweis "$DOMAIN hat auch eine IPv4 ($DNS4) - bei DS-Lite/CGNAT nutzlos und ein Zeitfresser fuer Besucher; bei DuckDNS entfernen"
  fi
  echo "  Von aussen pruefen: am Handy im Mobilnetz (WLAN aus) https://$DOMAIN/ oeffnen."
fi

# ------------------------------------------------------------------ Updates
abschnitt "Signierte Updates (/updates/)"
M="$WURZEL/updates/manifest.json"
if [ -f "$M" ]; then
  ok "Manifest: Malachi $(jq -r '.versionName' "$M" 2>/dev/null) (versionCode $(jq -r '.versionCode' "$M" 2>/dev/null)), veroeffentlicht $(jq -r '.published' "$M" 2>/dev/null)"
  if [ -s "$KONF/update-schluessel.b64u" ]; then
    if signatur_pruefen "$M" "$M.sig" "$(tr -d '[:space:]' < "$KONF/update-schluessel.b64u")"; then ok "Signatur des Manifests gueltig"; else schlecht "Signatur des Manifests UNGUELTIG"; fi
  else
    hinweis "kein Update-Schluessel hinterlegt - Signatur nicht geprueft (install.sh mit UPDATE_SCHLUESSEL=...)"
  fi
  if (cd "$WURZEL/updates" && sha256sum --quiet --strict -c SHA256SUMS >/dev/null 2>&1); then ok "APK-Pruefsummen stimmen"; else schlecht "APK-Pruefsummen stimmen NICHT"; fi
  APK="$(jq -r '.apks[0].file' "$M" 2>/dev/null)"
  H="$(curl -sS -I --max-time 10 --haproxy-protocol "http://127.0.0.1:8090/updates/$APK" 2>/dev/null | tr -d '\r')"
  grep -qi '^Content-Type: application/vnd.android.package-archive' <<<"$H" && ok "APK mit richtigem MIME-Typ" || schlecht "APK hat nicht den MIME-Typ application/vnd.android.package-archive"
  H="$(curl -sS -I --max-time 10 --haproxy-protocol "http://127.0.0.1:8090/updates/manifest.json" 2>/dev/null | tr -d '\r')"
  grep -qi '^Content-Type: application/json' <<<"$H" && ok "Manifest mit MIME-Typ application/json" || schlecht "Manifest hat falschen MIME-Typ"
else
  hinweis "noch keine Version mit Manifest veroeffentlicht"
fi

# ------------------------------------------------------------------ Datenschutz
abschnitt "Datenschutz"
LOG=/var/log/nginx/access.log
VORHER="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
curl -s -o /dev/null --max-time 5 --haproxy-protocol http://127.0.0.1:8090/ || true
[ -n "$DOMAIN" ] && curl -sk -o /dev/null --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true
NACHHER="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
[ "$VORHER" = "$NACHHER" ] && ok "Aufrufe landen in keinem Zugriffsprotokoll" || schlecht "$LOG waechst bei Aufrufen - access_log off pruefen"
if grep -rhoE '^\s*error_log\s+\S+\s+\S+;' /etc/nginx/sites-enabled/malachi-web-* 2>/dev/null | grep -v ' crit;' >/dev/null; then
  hinweis "ein Fehlerprotokoll steht nicht auf 'crit'"
else
  ok "Fehlerprotokoll nur fuer schwere Fehler (crit)"
fi

# ------------------------------------------------------------------ Firewall
abschnitt "Firewall"
if [ "$FIREWALL" != "1" ]; then
  # Eigene Firewall des Servers (FIREWALL=0 bei der Installation), z. B. ufw auf dem Hetzner-Server.
  if command -v ufw >/dev/null 2>&1 && ufw status verbose 2>/dev/null | grep -q '^Status: active' \
     && ufw status verbose 2>/dev/null | grep -qi 'deny (incoming)'; then
    ok "ufw aktiv, eingehend standardmaessig verweigert (eigene Firewall des Servers)"
  else
    schlecht "Keine aktive Firewall erkannt (FIREWALL=0, aber ufw nicht aktiv bzw. nicht restriktiv)"
  fi
elif nft list chain inet malachi_filter input 2>/dev/null | grep -q 'policy drop'; then ok "nftables aktiv, eingehend standardmaessig verworfen"; else schlecht "Firewall-Tabelle malachi_filter fehlt oder ist nicht restriktiv"; fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep 'Status: active' >/dev/null; then hinweis "ufw ist zusaetzlich aktiv"; fi
OFFEN="$(ss -Hltn 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[::ffff:127\.)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' ')"
UNERWARTET="$(for p in $OFFEN; do case "$p" in 22|80|443) ;; *) [ "$p" = "$(sed -n 's/^SSH_PORT=//p' "$KONF/web.env" 2>/dev/null)" ] || printf '%s ' "$p" ;; esac; done)"
[ -z "$UNERWARTET" ] && ok "nur erwartete Ports lauschen nach aussen (${OFFEN:-keine})" || hinweis "weitere Ports lauschen nach aussen: $UNERWARTET(von der Firewall blockiert - Altlasten wie coturn/relay?)"

# ------------------------------------------------------------------ System
abschnitt "System"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && ok "Uhrzeit synchronisiert" || schlecht "Uhrzeit nicht synchronisiert (Tor braucht die richtige Zeit)"
[ "$(systemctl is-enabled sleep.target 2>/dev/null)" = "masked" ] && ok "Ruhezustand abgeschaltet" || hinweis "Ruhezustand ist moeglich - Laptop als Server: sleep/suspend/hibernate maskieren (ANLEITUNG.md)"
if systemd-analyze cat-config systemd/logind.conf 2>/dev/null | grep -E '^HandleLidSwitch=ignore' >/dev/null; then ok "Deckel zuklappen ohne Standby"; else hinweis "Deckel zuklappen koennte Standby ausloesen (HandleLidSwitch=ignore, ANLEITUNG.md)"; fi
[ -f /run/reboot-required ] && hinweis "Neustart noetig (Kernel/Bibliotheken aktualisiert) - zu einer ruhigen Zeit: sudo reboot"
FREI_MB="$(df -Pm /var | awk 'NR==2 {print $4}')"
[ "${FREI_MB:-0}" -ge 2048 ] && ok "freier Platz unter /var: ${FREI_MB} MB" || hinweis "wenig freier Platz unter /var: ${FREI_MB} MB"
if systemctl list-unit-files malachi-shop.service >/dev/null 2>&1 && [ -f /etc/malachi-shop/lizenz-privat.pem ]; then
  hinweis "Shop laeuft auf demselben Rechner: wer ihn uebernimmt, hat den Lizenz-Signierschluessel (ANLEITUNG.md, Bedrohungsmodell)"
fi

printf '\nErgebnis: %d Fehler, %d Hinweise.\n' "$FEHLER" "$HINWEISE"
[ "$FEHLER" -eq 0 ]
