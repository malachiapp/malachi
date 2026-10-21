#!/bin/bash
# Malachi Relay - coturn IPv6-Updater
#
# Grund: identisches Problem wie bei duckdns-ipv6-update.sh (siehe dortiger
# Kommentar) - der Anschluss laeuft ueber DS-Lite/CGNAT, keine eigene
# oeffentliche IPv4, nur die globale IPv6 ist von aussen erreichbar. Die
# IPv6 aendert sich per kurzlebigem DHCPv6-Lease relativ haeufig (an zwei
# aufeinanderfolgenden Tagen live beobachtet, 2026-09-24/25) - coturn bindet
# beim Start fest an die zum Startzeitpunkt aktuelle Adresse
# (listening-ip/relay-ip in /etc/turnserver.conf) und wird bei einer
# Aenderung NICHT automatisch nachgezogen. Der DuckDNS-Eintrag selbst
# aktualisiert sich zwar automatisch (siehe duckdns-ipv6-update.sh), aber
# coturns eigene Konfigurationsdatei ist davon unabhaengig und blieb bisher
# manuell nachzuziehen (musste an zwei Tagen in Folge per Hand gefixt
# werden) - TURN wird dadurch fuer jeden Client, der iceTransportPolicy:
# 'relay' erzwingt (Standard in dieser App), unbemerkt unerreichbar, ohne
# dass coturn selbst abstuerzt oder einen offensichtlichen Fehler zeigt.
#
# Laeuft per systemd-Timer alle 5 Minuten (siehe coturn-ipv6-update.timer) -
# aktualisiert NUR, wenn sich die Adresse tatsaechlich geaendert hat, und
# NUR, wenn coturn danach auch wirklich sauber neu startet (sonst waere ein
# fehlerhafter automatischer Neustart schlimmer als der manuelle Status quo).
#
# Muss als root laufen (schreibt /etc/turnserver.conf, startet den
# coturn-Systemdienst neu) - deshalb systemd-Timer statt User-Crontab wie
# beim DuckDNS-Updater, der keine root-Rechte braucht.

set -euo pipefail

CONF_FILE="/etc/turnserver.conf"
STATE_FILE="/opt/malachi/.coturn-last-ipv6"
LOG_TAG="coturn-ipv6-update"

if [ ! -f "$CONF_FILE" ]; then
  logger -t "$LOG_TAG" "Config-Datei $CONF_FILE fehlt - Abbruch"
  exit 1
fi

# Siehe identische Begruendung/Filterung in duckdns-ipv6-update.sh - nur
# global geroutete Adressen (2xxx:.../3), keine Unique-Local-Address.
CURRENT_IPV6=$(ip -6 addr show scope global dynamic 2>/dev/null | \
  grep -oP '(?<=inet6\s)[0-9a-f:]+(?=/)' | \
  grep -E '^[23]' | \
  head -n1)

if [ -z "$CURRENT_IPV6" ]; then
  logger -t "$LOG_TAG" "Keine globale IPv6-Adresse gefunden - Abbruch"
  exit 1
fi

mkdir -p "$(dirname "$STATE_FILE")"
LAST_IPV6=""
[ -f "$STATE_FILE" ] && LAST_IPV6=$(cat "$STATE_FILE")

if [ "$CURRENT_IPV6" = "$LAST_IPV6" ]; then
  exit 0
fi

# Aktuell in der Config eingetragene IPv6 ermitteln (statt sich blind auf
# LAST_IPV6 zu verlassen - falls STATE_FILE und tatsaechliche Config je
# auseinanderlaufen, z.B. nach einem manuellen Fix ohne State-Update).
OLD_CONF_IPV6=$(grep -oP '(?<=^listening-ip=)[0-9a-f:]+' "$CONF_FILE" | grep -E '^[23]' | head -n1)

if [ -z "$OLD_CONF_IPV6" ]; then
  # Noch nie eine IPv6-Zeile eingetragen (frischer Server nach coturn-setup.sh
  # ohne erkannte IPv6 zum Setup-Zeitpunkt) - neu anhaengen statt ersetzen.
  cat >> "$CONF_FILE" <<EOF
listening-ip=${CURRENT_IPV6}
relay-ip=${CURRENT_IPV6}
EOF
  logger -t "$LOG_TAG" "Erste IPv6-Zeilen ergaenzt: $CURRENT_IPV6"
else
  sed -i "s/${OLD_CONF_IPV6}/${CURRENT_IPV6}/g" "$CONF_FILE"
  logger -t "$LOG_TAG" "IPv6 in Config aktualisiert: $OLD_CONF_IPV6 -> $CURRENT_IPV6"
fi

if systemctl restart coturn && systemctl is-active --quiet coturn; then
  echo "$CURRENT_IPV6" > "$STATE_FILE"
  logger -t "$LOG_TAG" "coturn erfolgreich mit neuer IPv6 neu gestartet: $CURRENT_IPV6"
else
  # Neustart fehlgeschlagen (z.B. defekte Config) - State-Datei NICHT
  # aktualisieren, damit der naechste Lauf in 5 Minuten erneut versucht statt
  # den Fehlschlag stillschweigend als "erledigt" zu markieren.
  logger -t "$LOG_TAG" "FEHLER: coturn-Neustart nach IPv6-Update fehlgeschlagen (Config evtl. defekt)"
  exit 1
fi
