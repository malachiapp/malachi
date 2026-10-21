#!/usr/bin/env bash
# Installiert bzw. aktualisiert die Malachi-Website auf Debian 13 (trixie):
# nginx (Onion + Clearnet aus denselben Dateien), eigener Tor-Onion-Dienst,
# Let's-Encrypt-Zertifikat, DuckDNS-Aktualisierung (IPv6), nftables-Firewall,
# automatische Sicherheitsupdates.
#
#   sudo bash deploy/install.sh                                   nur Onion
#   sudo DOMAIN=malachii.duckdns.org LE_AGB=ja bash deploy/install.sh   Onion + Clearnet
#
# Einstellungen (Umgebungsvariablen). Sie werden in /etc/malachi-web/web.env
# gemerkt - ein spaeterer Aufruf ohne Variablen nutzt dieselben Werte.
#   DOMAIN            Clearnet-Name, z. B. malachii.duckdns.org (leer = nur Onion)
#   ZERTIFIKAT        dns01  = DNS-Pruefung ueber DuckDNS-TXT, braucht keinen offenen Port 80 (Standard)
#                     http01 = HTTP-Pruefung ueber Port 80 (IPv6-Portfreigabe noetig)
#                     keins  = kein Zertifikat holen (z. B. eigenes Verfahren)
#   LE_EMAIL          E-Mail-Adresse NUR fuer die Let's-Encrypt-Registrierung (optional)
#   LE_AGB=ja         Du stimmst den Nutzungsbedingungen von Let's Encrypt zu
#                     (https://letsencrypt.org/repository/) - ohne das wird kein Zertifikat geholt.
#   LE_TEST=1         Test-Zertifikat (Staging) statt echtem - zum Ausprobieren
#   DUCKDNS_UPDATER   1 = IPv6-Adresse bei DuckDNS eintragen (Standard bei *.duckdns.org),
#                     0 = nicht (z. B. im Tunnel-Betrieb, wenn der Name auf den VPS zeigt)
#   DUCKDNS_TOKEN_DATEI  Datei mit dem DuckDNS-Token (sonst wird er verdeckt abgefragt)
#   DEPLOY_NUTZER     SSH-Nutzer, der neue Versionen hochlaedt (Standard: wer sudo aufruft)
#   LAN_V4, LAN_V6    Heimnetz, aus dem SSH erlaubt ist (Standard: 192.168.178.0/24 bzw. "fe80::/10, fd00::/8")
#   SSH_PORT          Standard: Port aus "sshd -T", sonst 22
#   FIREWALL=0        Firewall nicht anfassen
#   UFW_ABLOESEN=1    aktive ufw-Firewall sichern, abschalten und durch nftables ersetzen
#   FIREWALL_TROTZDEM=1  Firewall auch setzen, wenn die SSH-Sitzung nicht aus dem LAN kommt
#   UPDATE_SCHLUESSEL oeffentlicher Update-Signierschluessel (Base64url, aus website/seite.json):
#                     dann aktiviert malachi-web-aktivieren nur korrekt signierte Uploads
#
# Idempotent: kann jederzeit erneut laufen. Onion-Schluessel, Zertifikate und
# hochgeladene Versionen werden nie ueberschrieben.

set -euo pipefail

QUELLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KONF=/etc/malachi-web
WURZEL=/var/www/malachi
DATEN=/var/lib/malachi-web
LIB=/usr/local/lib/malachi-web
HS_DIR=/var/lib/tor/malachi-web
NUTZER=malachi-web
STEMPEL_JETZT="$(date +%Y%m%d-%H%M%S)"
SICHERUNG=/root/backups

info() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
fehler() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fehler "Bitte als root ausfuehren (sudo)."
grep -q $'\r' "$0" && fehler "Dieses Skript hat Windows-Zeilenenden. Bitte: sed -i 's/\\r\$//' deploy/*.sh deploy/*/*.sh"
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}:${VERSION_ID:-}" != "debian:13" ]; then
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*) warn "Gebaut fuer Debian 13 (trixie), gefunden: ${PRETTY_NAME:-unbekannt} - weiter auf eigenes Risiko." ;;
    *) fehler "Nur fuer Debian 13 (trixie) (gefunden: ${PRETTY_NAME:-unbekannt})." ;;
  esac
fi
command -v runuser >/dev/null 2>&1 || fehler "runuser fehlt (Paket util-linux)."

# ------------------------------------------------------------------ Einstellungen
GEMERKT=(DOMAIN ZERTIFIKAT LE_EMAIL DUCKDNS_UPDATER DEPLOY_NUTZER LAN_V4 LAN_V6 SSH_PORT FIREWALL)
if [ -f "$KONF/web.env" ]; then
  while IFS='=' read -r schluessel wert; do
    for g in "${GEMERKT[@]}"; do
      if [ "$schluessel" = "$g" ] && [ -z "${!g+x}" ]; then printf -v "$g" '%s' "$wert"; fi
    done
  done < "$KONF/web.env"
fi
DOMAIN="${DOMAIN:-}"
DOMAIN="${DOMAIN,,}"
ZERTIFIKAT="${ZERTIFIKAT:-dns01}"
LE_EMAIL="${LE_EMAIL:-}"
DEPLOY_NUTZER="${DEPLOY_NUTZER:-${SUDO_USER:-}}"
LAN_V4="${LAN_V4:-192.168.178.0/24}"
LAN_V6="${LAN_V6:-fe80::/10, fd00::/8}"
FIREWALL="${FIREWALL:-1}"
if [ -z "${SSH_PORT:-}" ]; then
  SSH_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)"
  SSH_PORT="${SSH_PORT:-22}"
fi
case "$DOMAIN" in *.duckdns.org) DUCKDNS_UPDATER="${DUCKDNS_UPDATER:-1}" ;; *) DUCKDNS_UPDATER="${DUCKDNS_UPDATER:-0}" ;; esac

if [ -n "$DOMAIN" ]; then
  [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || fehler "DOMAIN ist kein gueltiger Name: $DOMAIN"
fi
case "$ZERTIFIKAT" in dns01|http01|keins) ;; *) fehler "ZERTIFIKAT muss dns01, http01 oder keins sein." ;; esac
if [ -n "$DOMAIN" ] && [ "$ZERTIFIKAT" = "dns01" ]; then
  case "$DOMAIN" in *.duckdns.org) ;; *) fehler "ZERTIFIKAT=dns01 geht hier nur mit *.duckdns.org - sonst ZERTIFIKAT=http01." ;; esac
fi
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || fehler "SSH_PORT ungueltig."
[[ "$LAN_V4" =~ ^[0-9./,\ ]+$ ]] || fehler "LAN_V4 ungueltig: $LAN_V4"
[[ "$LAN_V6" =~ ^[0-9a-fA-F:./,\ ]+$ ]] || fehler "LAN_V6 ungueltig: $LAN_V6"
if [ -n "${UPDATE_SCHLUESSEL:-}" ]; then
  [[ "$UPDATE_SCHLUESSEL" =~ ^[A-Za-z0-9_-]{43}$ ]] || fehler "UPDATE_SCHLUESSEL ist kein Ed25519-Schluessel in Base64url (43 Zeichen)."
fi

# ------------------------------------------------------------------ Ports frei?
PORTFILTER='( sport = :8090 )'
[ -n "$DOMAIN" ] && PORTFILTER='( sport = :80 or sport = :443 or sport = :8090 )'
BELEGT="$(ss -Hltnp "$PORTFILTER" 2>/dev/null | grep -v '"nginx"' || true)"
if [ -n "$BELEGT" ]; then
  printf '%s\n' "$BELEGT" >&2
  fehler "Ein anderes Programm belegt Port 80/443/8090 (oben). Das alte Relay (relay.js) und coturn zuerst stilllegen: sudo bash $QUELLE/altes-relay-stilllegen.sh (siehe ANLEITUNG.md)."
fi

# ------------------------------------------------------------------ Pakete
PAKETE=(nginx tor curl jq openssl ca-certificates nftables unattended-upgrades apt-listchanges)
[ -n "$DOMAIN" ] && [ "$ZERTIFIKAT" != "keins" ] && PAKETE+=(certbot)
info "Pakete aus Debian installieren (${PAKETE[*]})"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q "${PAKETE[@]}"

# ------------------------------------------------------------------ Nutzer und Verzeichnisse
info "Systemnutzer $NUTZER und Verzeichnisse"
id "$NUTZER" >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$NUTZER"
if [ -n "$DEPLOY_NUTZER" ] && [ "$DEPLOY_NUTZER" != "root" ]; then
  id "$DEPLOY_NUTZER" >/dev/null 2>&1 || fehler "DEPLOY_NUTZER $DEPLOY_NUTZER existiert nicht."
  if ! id -nG "$DEPLOY_NUTZER" | tr ' ' '\n' | grep -x "$NUTZER" >/dev/null; then
    usermod -aG "$NUTZER" "$DEPLOY_NUTZER"
    echo "Nutzer $DEPLOY_NUTZER ist jetzt in der Gruppe $NUTZER (gilt ab der naechsten Anmeldung)."
  fi
else
  warn "Kein DEPLOY_NUTZER - Uploads gehen nur als root (DEPLOY_NUTZER=<name> setzen)."
fi
install -d -o root -g root -m 0755 "$KONF" "$WURZEL" "$WURZEL/releases" "$DATEN" "$DATEN/acme" "$LIB" "$SICHERUNG"
chmod 0700 "$SICHERUNG"
install -d -o "$NUTZER" -g "$NUTZER" -m 2770 "$DATEN/eingang"

if [ ! -e "$WURZEL/aktuell" ]; then
  info "Platzhalter-Seite anlegen (bis zur ersten Veroeffentlichung)"
  P="$WURZEL/releases/0-platzhalter"
  install -d -o "$NUTZER" -g "$NUTZER" -m 0755 "$P"
  for seite in index.html 404.html; do
    cat > "$P/$seite" <<'HTML'
<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Malachi</title></head>
<body><main><h1>Malachi</h1><p>Die Website wird gerade eingerichtet. Bitte später noch einmal vorbeischauen.</p></main></body>
</html>
HTML
  done
  chown "$NUTZER:$NUTZER" "$P"/*.html && chmod 0644 "$P"/*.html
  ln -sfn releases/0-platzhalter "$WURZEL/aktuell"
fi

# ------------------------------------------------------------------ Programme
info "Hilfsprogramme installieren"
install -o root -g root -m 0755 "$QUELLE/aktivieren.sh" /usr/local/sbin/malachi-web-aktivieren
install -o root -g root -m 0755 "$QUELLE/pruefen.sh" /usr/local/sbin/malachi-web-pruefen
install -o root -g root -m 0755 "$QUELLE/duckdns/duckdns-ipv6.sh" "$LIB/duckdns-ipv6.sh"
install -o root -g root -m 0755 "$QUELLE/certbot/duckdns-auth.sh" "$LIB/certbot-duckdns-auth.sh"
install -o root -g root -m 0755 "$QUELLE/certbot/duckdns-cleanup.sh" "$LIB/certbot-duckdns-cleanup.sh"
if [ -n "${UPDATE_SCHLUESSEL:-}" ]; then
  printf '%s\n' "$UPDATE_SCHLUESSEL" > "$KONF/update-schluessel.b64u"
  chmod 0644 "$KONF/update-schluessel.b64u"
fi
[ -s "$KONF/update-schluessel.b64u" ] || warn "Kein UPDATE_SCHLUESSEL hinterlegt - Uploads werden ohne Signaturpruefung aktiviert (siehe ANLEITUNG.md)."

# ------------------------------------------------------------------ Tor
info "Tor-Onion-Dienst der Website einrichten"
install -d -o root -g root -m 0755 /etc/tor/torrc.d
install -o root -g root -m 0644 "$QUELLE/torrc-malachi-web.conf" /etc/tor/torrc.d/malachi-web.conf
TOR_MODULE="$(tor --list-modules 2>/dev/null || true)"
if grep -qx 'pow: yes' <<<"$TOR_MODULE"; then
  sed -i 's/^#HiddenServicePoWDefensesEnabled 1$/HiddenServicePoWDefensesEnabled 1/' /etc/tor/torrc.d/malachi-web.conf
fi
if ! grep -Eq '^%include /etc/tor/torrc\.d/?(\*\.conf)?' /etc/tor/torrc; then
  printf '\n%%include /etc/tor/torrc.d/*.conf\n' >> /etc/tor/torrc
fi
runuser -u debian-tor -- tor --verify-config -f /etc/tor/torrc >/dev/null || fehler "Tor-Konfiguration ungueltig (tor --verify-config)."
systemctl enable --now tor >/dev/null 2>&1 || true
systemctl reload tor@default 2>/dev/null || systemctl restart tor@default
for _ in $(seq 1 60); do [ -s "$HS_DIR/hostname" ] && break; sleep 1; done
[ -s "$HS_DIR/hostname" ] || fehler "Onion-Adresse wurde nicht erzeugt (journalctl -u tor@default)."
ONION="$(tr -d '[:space:]' < "$HS_DIR/hostname")"
[[ "$ONION" =~ ^[a-z2-7]{56}\.onion$ ]] || fehler "Unerwartete Onion-Adresse: $ONION"

# ------------------------------------------------------------------ nginx
info "nginx einrichten"
install -o root -g root -m 0644 "$QUELLE/nginx/malachi-web-http.conf" /etc/nginx/conf.d/malachi-web.conf
install -d -o root -g root -m 0755 /etc/nginx/snippets
for s in header orte tls; do
  install -o root -g root -m 0644 "$QUELLE/nginx/malachi-web-$s.conf" "/etc/nginx/snippets/malachi-web-$s.conf"
done
install -o root -g root -m 0644 "$QUELLE/nginx/malachi-web-onion.conf" /etc/nginx/sites-available/malachi-web-onion
ln -sfn ../sites-available/malachi-web-onion /etc/nginx/sites-enabled/malachi-web-onion
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "Debians Beispielseite (sites-enabled/default) deaktiviert."
fi

ZERT=/etc/letsencrypt/live/malachi-web/fullchain.pem
clearnet_schreiben() {
  local vorlage="$1"
  sed -e "s/@@DOMAIN@@/${DOMAIN}/g" -e "s/@@ONION@@/${ONION}/g" "$QUELLE/nginx/$vorlage" > /etc/nginx/sites-available/malachi-web-clearnet
  # nginx < 1.25.1 (z. B. Ubuntu 24.04: 1.24) kennt "http2 on;" noch nicht -
  # dort die alte Schreibweise "listen ... ssl http2;" verwenden.
  local nv; nv="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
  if [ -n "$nv" ] && [ "$(printf '%s\n%s\n' "$nv" 1.25.1 | sort -V | head -1)" != "1.25.1" ]; then
    sed -i -e '/^[[:space:]]*http2 on;/d' -e 's/^\([[:space:]]*listen \(\[::\]:\)\{0,1\}443 ssl\);/\1 http2;/' /etc/nginx/sites-available/malachi-web-clearnet
  fi
  chmod 0644 /etc/nginx/sites-available/malachi-web-clearnet
  ln -sfn ../sites-available/malachi-web-clearnet /etc/nginx/sites-enabled/malachi-web-clearnet
}
if [ -n "$DOMAIN" ]; then
  install -o root -g root -m 0644 "$QUELLE/nginx/malachi-web-standard.conf" /etc/nginx/sites-available/malachi-web-standard
  ln -sfn ../sites-available/malachi-web-standard /etc/nginx/sites-enabled/malachi-web-standard
  if [ -s "$ZERT" ]; then clearnet_schreiben malachi-web-clearnet.conf; else clearnet_schreiben malachi-web-clearnet-acme.conf; fi
else
  rm -f /etc/nginx/sites-enabled/malachi-web-clearnet /etc/nginx/sites-enabled/malachi-web-standard
fi
nginx -t -q || fehler "nginx-Konfiguration ungueltig (nginx -t)."
systemctl enable --now nginx >/dev/null
systemctl reload nginx

# ------------------------------------------------------------------ DuckDNS-Token
if [ -n "$DOMAIN" ] && { [ "$ZERTIFIKAT" = "dns01" ] || [ "$DUCKDNS_UPDATER" = "1" ]; } && [ ! -s "$KONF/duckdns.token" ]; then
  if [ -n "${DUCKDNS_TOKEN_DATEI:-}" ]; then
    TOKEN="$(tr -d '[:space:]' < "$DUCKDNS_TOKEN_DATEI")"
  elif [ -t 0 ]; then
    read -r -s -p "DuckDNS-Token (von duckdns.org, wird nicht angezeigt): " TOKEN
    echo
  else
    TOKEN=""
  fi
  if [[ "${TOKEN:-}" =~ ^[0-9a-f-]{36}$ ]]; then
    (umask 077 && printf '%s\n' "$TOKEN" > "$KONF/duckdns.token")
    echo "DuckDNS-Token gespeichert: $KONF/duckdns.token (root, 0600)."
  else
    warn "Kein gueltiger DuckDNS-Token - DNS-01-Zertifikat und DuckDNS-Aktualisierung werden uebersprungen."
  fi
  unset TOKEN
fi
[ -f "$KONF/duckdns.token" ] && chown root:root "$KONF/duckdns.token" && chmod 0600 "$KONF/duckdns.token"

# ------------------------------------------------------------------ Zertifikat
if [ -n "$DOMAIN" ] && [ "$ZERTIFIKAT" != "keins" ] && [ ! -s "$ZERT" ]; then
  info "Let's-Encrypt-Zertifikat fuer $DOMAIN holen ($ZERTIFIKAT)"
  if [ "${LE_AGB:-}" != "ja" ]; then
    warn "Kein Zertifikat geholt: Bitte die Nutzungsbedingungen von Let's Encrypt lesen und mit LE_AGB=ja erneut ausfuehren."
  elif [ "$ZERTIFIKAT" = "dns01" ] && [ ! -s "$KONF/duckdns.token" ]; then
    warn "Kein Zertifikat geholt: DuckDNS-Token fehlt (DUCKDNS_TOKEN_DATEI=... oder interaktiv ausfuehren)."
  else
    CB=(certbot certonly --non-interactive --agree-tos --cert-name malachi-web -d "$DOMAIN" --key-type ecdsa)
    if [ -n "$LE_EMAIL" ]; then CB+=(--email "$LE_EMAIL" --no-eff-email); else CB+=(--register-unsafely-without-email); fi
    [ "${LE_TEST:-0}" = "1" ] && CB+=(--test-cert)
    if [ "$ZERTIFIKAT" = "dns01" ]; then
      CB+=(--manual --preferred-challenges dns
           --manual-auth-hook "$LIB/certbot-duckdns-auth.sh"
           --manual-cleanup-hook "$LIB/certbot-duckdns-cleanup.sh")
    else
      CB+=(--webroot -w "$DATEN/acme")
    fi
    if "${CB[@]}"; then
      echo "Zertifikat erhalten."
    else
      warn "Zertifikat konnte nicht geholt werden (siehe oben, /var/log/letsencrypt/letsencrypt.log). Die Onion-Seite laeuft trotzdem."
    fi
  fi
fi
if [ -n "$DOMAIN" ] && [ -s "$ZERT" ]; then
  install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  install -o root -g root -m 0755 "$QUELLE/certbot/nginx-neu-laden.sh" /etc/letsencrypt/renewal-hooks/deploy/malachi-web-nginx.sh
  clearnet_schreiben malachi-web-clearnet.conf
  nginx -t -q || fehler "nginx-Konfiguration mit Zertifikat ungueltig (nginx -t)."
  systemctl reload nginx
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------------ DuckDNS-Aktualisierung
if [ -n "$DOMAIN" ] && [ "$DUCKDNS_UPDATER" = "1" ] && [ -s "$KONF/duckdns.token" ]; then
  info "DuckDNS-Aktualisierung (IPv6) einrichten"
  SUB="${DOMAIN%.duckdns.org}"; SUB="${SUB##*.}"
  printf 'DUCKDNS_SUBDOMAIN=%s\n' "$SUB" > "$KONF/duckdns.env"
  chmod 0644 "$KONF/duckdns.env"
  install -o root -g root -m 0644 "$QUELLE/duckdns/malachi-duckdns.service" /etc/systemd/system/malachi-duckdns.service
  install -o root -g root -m 0644 "$QUELLE/duckdns/malachi-duckdns.timer" /etc/systemd/system/malachi-duckdns.timer
  systemctl daemon-reload
  systemctl enable --now malachi-duckdns.timer >/dev/null
  systemctl start malachi-duckdns.service || warn "DuckDNS-Aktualisierung fehlgeschlagen (journalctl -u malachi-duckdns)."
  if crontab -l 2>/dev/null | grep duckdns >/dev/null || { [ -n "${SUDO_USER:-}" ] && crontab -l -u "$SUDO_USER" 2>/dev/null | grep duckdns >/dev/null; }; then
    warn "Es gibt noch einen alten DuckDNS-Cronjob - nach dem Stilllegen des alten Relays entfernen (altes-relay-stilllegen.sh)."
  fi
elif [ -n "$DOMAIN" ] && [ "$DUCKDNS_UPDATER" = "0" ]; then
  systemctl disable --now malachi-duckdns.timer >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------------ Firewall
ip4_im_netz() { # ip4_im_netz <adresse> <netz/praefix>
  local ip="$1" netz="${2%/*}" laenge="${2#*/}" a b c d e f g h
  IFS=. read -r a b c d <<<"$ip"; IFS=. read -r e f g h <<<"$netz"
  [[ "$laenge" =~ ^[0-9]+$ ]] && [ "$laenge" -le 32 ] || return 1
  local maske=$(( laenge == 0 ? 0 : (0xFFFFFFFF << (32 - laenge)) & 0xFFFFFFFF ))
  [ $(( ((a<<24)|(b<<16)|(c<<8)|d) & maske )) -eq $(( ((e<<24)|(f<<16)|(g<<8)|h) & maske )) ]
}
if [ "$FIREWALL" = "1" ]; then
  info "Firewall (nftables)"
  SETZEN=1
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep 'Status: active' >/dev/null; then
    if [ "${UFW_ABLOESEN:-0}" = "1" ]; then
      ufw status verbose > "$SICHERUNG/ufw-regeln-$STEMPEL_JETZT.txt" 2>&1 || true
      ufw --force disable >/dev/null
      systemctl disable --now ufw >/dev/null 2>&1 || true
      echo "ufw abgeschaltet (Regeln gesichert: $SICHERUNG/ufw-regeln-$STEMPEL_JETZT.txt)."
    else
      warn "ufw ist aktiv. nftables wird NICHT eingerichtet. Mit UFW_ABLOESEN=1 ersetzen (ANLEITUNG.md)."
      SETZEN=0
    fi
  fi
  if [ "$SETZEN" = "1" ] && [ -n "${SSH_CONNECTION:-}" ] && [ "${FIREWALL_TROTZDEM:-0}" != "1" ]; then
    CLIENT="${SSH_CONNECTION%% *}"
    IM_LAN=0
    if [[ "$CLIENT" == *:* ]]; then
      case "${CLIENT,,}" in fe8*|fe9*|fea*|feb*|fd*) IM_LAN=1 ;; esac
    else
      IFS=', ' read -r -a NETZE <<<"$LAN_V4"
      for n in "${NETZE[@]}"; do [ -n "$n" ] && ip4_im_netz "$CLIENT" "$n" && IM_LAN=1; done
    fi
    if [ "$IM_LAN" = "0" ]; then
      warn "Deine SSH-Sitzung kommt von $CLIENT - nicht aus LAN_V4/LAN_V6. Firewall NICHT gesetzt (sonst sperrst du dich aus). LAN_V4/LAN_V6 anpassen oder FIREWALL_TROTZDEM=1."
      SETZEN=0
    fi
  fi
  if [ "$SETZEN" = "1" ]; then
    if [ -n "$DOMAIN" ]; then WEB_PORTS='tcp dport { 80, 443 } accept'; else WEB_PORTS='# keine (nur Onion)'; fi
    NEU="$(mktemp)"
    sed -e "s|@@LAN_V4@@|${LAN_V4}|" -e "s|@@LAN_V6@@|${LAN_V6}|" -e "s|@@SSH_PORT@@|${SSH_PORT}|g" -e "s|@@WEB_PORTS@@|${WEB_PORTS}|" \
      "$QUELLE/nftables.conf" > "$NEU"
    nft -c -f "$NEU" || { rm -f "$NEU"; fehler "nftables-Regeln ungueltig (nft -c)."; }
    if [ -f /etc/nftables.conf ] && ! cmp -s "$NEU" /etc/nftables.conf; then
      cp -p /etc/nftables.conf "$SICHERUNG/nftables.conf.$STEMPEL_JETZT"
    fi
    install -o root -g root -m 0644 "$NEU" /etc/nftables.conf
    rm -f "$NEU"
    systemctl enable nftables >/dev/null 2>&1
    nft -f /etc/nftables.conf
    echo "Firewall aktiv: SSH (Port $SSH_PORT) nur aus $LAN_V4 / $LAN_V6${DOMAIN:+, 80/443 offen}, alles andere eingehend verworfen."
  fi
fi

# ------------------------------------------------------------------ Automatische Updates
info "Automatische Sicherheitsupdates (unattended-upgrades)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT
install -o root -g root -m 0644 "$QUELLE/52malachi-unattended-upgrades" /etc/apt/apt.conf.d/52malachi-unattended-upgrades
install -o root -g root -m 0644 "$QUELLE/53malachi-neustart" /etc/apt/apt.conf.d/53malachi-neustart
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true

# nginx nach einem Absturz selbst neu starten (tor@default tut das bereits)
install -d -o root -g root -m 0755 /etc/systemd/system/nginx.service.d
install -o root -g root -m 0644 "$QUELLE/systemd-nginx-neustart.conf" /etc/systemd/system/nginx.service.d/malachi-neustart.conf
systemctl daemon-reload

# ------------------------------------------------------------------ Einstellungen merken
{
  for g in "${GEMERKT[@]}"; do printf '%s=%s\n' "$g" "${!g:-}"; done
} > "$KONF/web.env"
chmod 0644 "$KONF/web.env"

# ------------------------------------------------------------------ Ergebnis
CLEAR="(keine - nur Onion)"
if [ -n "$DOMAIN" ]; then
  if [ -s "$ZERT" ]; then CLEAR="https://$DOMAIN/"; else CLEAR="$DOMAIN - NOCH OHNE ZERTIFIKAT (Port 80 antwortet nur der Zertifikatspruefung)"; fi
fi
cat <<EOF

==================================================================
 Onion-Adresse der Website:  http://${ONION}/
 Clearnet:                   ${CLEAR}
==================================================================
 1. Onion-Adresse in website/seite.json ("onionAdresse") eintragen.
 2. Onion-Schluessel SICHERN: ${HS_DIR}/  (ANLEITUNG.md, "Sicherungen")
 3. Erste Version vom PC hochladen:  website/werkzeuge/veroeffentlichen.ps1 -Hochladen
 4. Pruefen:  sudo malachi-web-pruefen
EOF
