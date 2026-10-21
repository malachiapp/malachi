#!/usr/bin/env bash
# Altes Relay (relay.js unter PM2, /opt/malachi) und coturn auf dem Laptop
# sicher stilllegen - mit Sicherung vorher, ohne etwas zu loeschen.
#
#   sudo bash deploy/altes-relay-stilllegen.sh              Probelauf: zeigt nur, was passieren wuerde
#   sudo bash deploy/altes-relay-stilllegen.sh --ausfuehren  wirklich sichern und stilllegen
#
# Ablauf:
#   1. Sicherung: /opt/malachi und die zugehoerige Konfiguration (coturn, TLS,
#      systemd-Units, Crontabs, PM2-Liste) nach /root/backups/ (tar.gz, root 0600),
#      Archiv wird geprueft und mit SHA-256 ausgegeben.
#   2. relay.js aus PM2 entfernen (pm2 delete + pm2 save) - Dateien bleiben liegen.
#   3. coturn und coturn-ipv6-update.timer stoppen und abschalten.
#   4. Den alten DuckDNS-Cronjob auskommentieren - NUR wenn die neue
#      DuckDNS-Aktualisierung (malachi-duckdns.timer) bereits laeuft.
# Geloescht wird nichts. Endgueltiges Aufraeumen nach einigen Wochen: ANLEITUNG.md.

set -euo pipefail

AUSFUEHREN=0
[ "${1:-}" = "--ausfuehren" ] && AUSFUEHREN=1
STEMPEL="$(date +%Y%m%d-%H%M%S)"
SICHERUNG=/root/backups
ALT=/opt/malachi

info() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
fehler() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
aktiv_oder_an() { # Unit laeuft gerade oder startet beim Booten
  systemctl is-active --quiet "$1" 2>/dev/null || [ "$(systemctl is-enabled "$1" 2>/dev/null || true)" = "enabled" ]
}
tun() { # tun <beschreibung> <befehl...>
  local was="$1"; shift
  if [ "$AUSFUEHREN" = "1" ]; then echo "  -> $was"; "$@"; else echo "  [Probelauf] $was"; fi
}

[ "$(id -u)" -eq 0 ] || fehler "Bitte als root ausfuehren (sudo)."
[ "$AUSFUEHREN" = "1" ] || echo "PROBELAUF - es wird nichts veraendert. Wirklich ausfuehren mit: --ausfuehren"

# ------------------------------------------------------------------ Bestandsaufnahme
info "Bestandsaufnahme"
[ -d "$ALT" ] && echo "  $ALT vorhanden ($(du -sh "$ALT" 2>/dev/null | cut -f1))" || echo "  $ALT nicht vorhanden"
RELAY_PIDS="$(pgrep -f 'relay\.js' || true)"
PM2_NUTZER=""
if [ -n "$RELAY_PIDS" ]; then
  PM2_NUTZER="$(ps -o user= -p "$(head -n1 <<<"$RELAY_PIDS")" | tr -d ' ')"
  echo "  relay.js laeuft (PID $(tr '\n' ' ' <<<"$RELAY_PIDS")) als Nutzer $PM2_NUTZER"
else
  echo "  relay.js laeuft nicht"
fi
for d in coturn coturn-ipv6-update.timer; do
  printf '  %-28s %s / %s\n' "$d" "$(systemctl is-active "$d" 2>/dev/null || true)" "$(systemctl is-enabled "$d" 2>/dev/null || true)"
done
ss -Hltnp '( sport = :80 or sport = :443 or sport = :3478 or sport = :5349 )' 2>/dev/null | sed 's/^/  lauscht: /' || true
CRON_NUTZER=()
for u in root ${SUDO_USER:-} ${PM2_NUTZER:-}; do
  [ -n "$u" ] || continue
  case " ${CRON_NUTZER[*]:-} " in *" $u "*) continue ;; esac
  if crontab -l -u "$u" 2>/dev/null | grep -E '/opt/malachi|duckdns' >/dev/null; then
    CRON_NUTZER+=("$u")
    crontab -l -u "$u" 2>/dev/null | grep -E '/opt/malachi|duckdns' | sed "s/^/  Cron ($u): /"
  fi
done

# ------------------------------------------------------------------ 1. Sicherung
info "1. Sicherung nach $SICHERUNG"
ARCHIV="$SICHERUNG/malachi-opt-$STEMPEL.tar.gz"
KONFIG_ARCHIV="$SICHERUNG/malachi-alt-konfig-$STEMPEL.tar.gz"
EXTRA=()
for p in /etc/turnserver.conf /etc/default/coturn /etc/malachi /etc/systemd/system/coturn-ipv6-update.service /etc/systemd/system/coturn-ipv6-update.timer /etc/ufw/user.rules /etc/ufw/user6.rules; do
  [ -e "$p" ] && EXTRA+=("${p#/}")
done
sichern() {
  install -d -o root -g root -m 0700 "$SICHERUNG"
  if [ -d "$ALT" ]; then
    (umask 077 && tar -C / -czf "$ARCHIV" "${ALT#/}")
    tar -tzf "$ARCHIV" >/dev/null || fehler "Sicherung $ARCHIV ist nicht lesbar - Abbruch, nichts stillgelegt."
    echo "  $ARCHIV  $(du -h "$ARCHIV" | cut -f1)  sha256 $(sha256sum "$ARCHIV" | cut -d' ' -f1)"
  fi
  local tmp
  tmp="$(mktemp -d)"
  for u in "${CRON_NUTZER[@]:-}"; do [ -n "$u" ] && crontab -l -u "$u" > "$tmp/crontab-$u.txt" 2>/dev/null || true; done
  if [ -n "$PM2_NUTZER" ]; then
    runuser -l "$PM2_NUTZER" -c 'pm2 jlist 2>/dev/null' > "$tmp/pm2-liste.json" 2>/dev/null || true
  fi
  (umask 077 && tar -C / -czf "$KONFIG_ARCHIV" "${EXTRA[@]}" -C "$tmp" . 2>/dev/null) || (umask 077 && tar -C "$tmp" -czf "$KONFIG_ARCHIV" .)
  rm -rf "$tmp"
  tar -tzf "$KONFIG_ARCHIV" >/dev/null || fehler "Sicherung $KONFIG_ARCHIV ist nicht lesbar."
  echo "  $KONFIG_ARCHIV  $(du -h "$KONFIG_ARCHIV" | cut -f1)"
}
if [ "$AUSFUEHREN" = "1" ]; then sichern; else
  echo "  [Probelauf] tar von $ALT -> $ARCHIV"
  echo "  [Probelauf] tar von ${EXTRA[*]:-(keine weiteren Dateien)} + Crontabs + PM2-Liste -> $KONFIG_ARCHIV"
fi

# ------------------------------------------------------------------ 2. Relay
info "2. relay.js stoppen"
ETWAS=0
if aktiv_oder_an malachi-relay.service; then
  tun "systemctl disable --now malachi-relay.service" systemctl disable --now malachi-relay.service
  ETWAS=1
fi
if [ -n "$PM2_NUTZER" ] && runuser -l "$PM2_NUTZER" -c 'command -v pm2' >/dev/null 2>&1; then
  tun "pm2 delete malachi-relay && pm2 save (als $PM2_NUTZER)" runuser -l "$PM2_NUTZER" -c 'pm2 delete malachi-relay && pm2 save'
  ETWAS=1
elif [ -n "$RELAY_PIDS" ] && [ "$ETWAS" = "0" ]; then
  warn "relay.js laeuft, aber weder PM2 noch malachi-relay.service gefunden - bitte von Hand beenden (PID $(tr '\n' ' ' <<<"$RELAY_PIDS"))."
fi
[ "$ETWAS" = "1" ] || [ -n "$RELAY_PIDS" ] || echo "  nichts zu tun"

# ------------------------------------------------------------------ 3. coturn
info "3. coturn stilllegen"
ETWAS=0
for d in coturn-ipv6-update.timer coturn; do
  if aktiv_oder_an "$d"; then
    tun "systemctl disable --now $d" systemctl disable --now "$d"
    ETWAS=1
  fi
done
[ "$ETWAS" = "1" ] || echo "  nichts zu tun"

# ------------------------------------------------------------------ 4. alter DuckDNS-Cronjob
info "4. alten DuckDNS-Cronjob abschalten"
if [ "${#CRON_NUTZER[@]}" -eq 0 ]; then
  echo "  kein alter Cronjob gefunden"
elif systemctl is-active --quiet malachi-duckdns.timer; then
  for u in "${CRON_NUTZER[@]}"; do
    tun "Cron-Zeilen mit /opt/malachi bzw. duckdns auskommentieren (Nutzer $u)" \
      bash -c "crontab -l -u '$u' | sed -E '/^[^#].*(\/opt\/malachi|duckdns)/ s/^/# stillgelegt $STEMPEL: /' | crontab -u '$u' -"
  done
else
  warn "malachi-duckdns.timer laeuft noch nicht - der alte Cronjob bleibt, sonst wuerde DuckDNS nicht mehr aktualisiert. Erst website/deploy/install.sh mit DOMAIN=... ausfuehren."
fi

# ------------------------------------------------------------------ Ergebnis
info "Ergebnis"
if [ "$AUSFUEHREN" = "1" ]; then
  ss -Hltnp '( sport = :80 or sport = :443 or sport = :3478 or sport = :5349 )' 2>/dev/null | sed 's/^/  lauscht noch: /' || true
  cat <<EOF
  Stillgelegt. Sicherungen: $SICHERUNG (bitte zusaetzlich auf den PC holen, z. B.
    scp malachiztrl@192.168.178.130:/root/backups/... - vorher mit sudo lesbar kopieren).
  Rueckweg: sudo systemctl enable --now coturn; als $PM2_NUTZER: cd $ALT && pm2 start ecosystem.config.js && pm2 save
  Weiter: sudo bash website/deploy/install.sh (Website auf 80/443).
  Nach einigen Wochen ohne Probleme endgueltig aufraeumen (ANLEITUNG.md):
    sudo apt-get purge coturn && sudo rm -rf $ALT
EOF
else
  echo "  Probelauf beendet. Wirklich ausfuehren: sudo bash $0 --ausfuehren"
fi
