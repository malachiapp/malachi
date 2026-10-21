#!/usr/bin/env bash
# Malachi – coturn (TURN/STUN) auf einem eigenstaendigen Server einrichten.
#
# Voraussetzung: TURN_SECRET als Umgebungsvariable uebergeben (kein Node.js
# noetig, muss nicht mehr aus secrets.local.js gelesen werden) - derselbe
# Wert wie relay.js's TURN_SECRET, siehe secrets.local.js auf dem Relay-Server:
#   TURN_SECRET=<wert> bash coturn-setup.sh

set -euo pipefail

if [ -z "${TURN_SECRET:-}" ]; then
  echo "FEHLER: TURN_SECRET nicht gesetzt. Aufruf: TURN_SECRET=<wert> bash coturn-setup.sh" >&2
  exit 1
fi
TURN_MIN_PORT=49152
TURN_MAX_PORT=49452
# War vorher 49152-49200 (nur 49 UDP-Relay-Ports) - bei mehreren
# gleichzeitigen Kontakten/Reconnect-Versuchen (jeder aktive P2P-Fallback
# belegt mind. eine Allocation) potenziell ein Engpass, der zu gelegentlichem
# ICE "failed" trotz grundsaetzlich funktionierendem TURN-Pfad fuehren kann.
# Jetzt 300 Ports - deutlich mehr Spielraum fuer eine kleine Nutzergruppe.

echo "== [1/3] coturn installieren und konfigurieren =="
apt-get update -y
apt-get install -y coturn ufw

PUBLIC_IP="$(curl -fsSL https://api.ipify.org)"
echo "Erkannte oeffentliche IP: $PUBLIC_IP"
# Server sitzt hinter Router/CGNAT (DS-Lite) - seine tatsaechlich bindbare
# Adresse ist die LAN-IP, nicht die oeffentliche. relay-ip=PUBLIC_IP (wie
# zuvor hier gesetzt) laesst coturn versuchen, Relay-Sockets an eine IP zu
# binden, die auf keiner eigenen Netzwerkkarte liegt - genau der Bug, der in
# dieser Sitzung schon einmal (direkt auf dem Server) gefixt wurde, aber
# durch ein erneutes Ausfuehren dieses Skripts wieder zurueckkam, weil die
# Korrektur nie hierher zurueckgespielt wurde. LOCAL_IP=bindbare LAN-Adresse
# fuer relay-ip; external-ip bekommt die coturn-eigene NAT-Mapping-Syntax
# "oeffentlich/lokal", damit sowohl Clients im selben LAN (erreichen die
# LAN-IP direkt) als auch externe Clients (sehen die oeffentliche IP als
# Kandidaten-Adresse) funktionieren.
LOCAL_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+')"
if [ -z "$LOCAL_IP" ]; then
  echo "FEHLER: Lokale LAN-IP konnte nicht ermittelt werden (ip route get 1.1.1.1 lieferte nichts)." >&2
  exit 1
fi
echo "Erkannte lokale LAN-IP: $LOCAL_IP"

# Produktions-Fund (Cross-Network-Diagnose, siehe identischer Kommentar bei
# relay.js's server.listen(3333, '::', ...)): dieses Skript war komplett
# IPv4-zentriert - listening-ip=0.0.0.0 lauscht NUR auf IPv4, auf einem
# Anschluss ohne echte oeffentliche IPv4 (DS-Lite/CGNAT) kam von aussen
# folglich NIE ein TURN-Paket beim Server an, obwohl Firewall/Portfreigaben
# korrekt standen - coturn hoerte auf der Adresse, die extern erreichbar
# ist (die eigene globale IPv6), schlicht gar nicht zu. Anders als bei IPv4
# gibt es bei IPv6 kein NAT - die eigene globale Adresse IST bereits die von
# aussen erreichbare, kein external-ip-Mapping noetig, nur eine zusaetzliche
# listening-ip/relay-ip-Zeile fuer sie.
LOCAL_IPV6="$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | grep -oP 'src \K\S+')"
if [ -z "$LOCAL_IPV6" ]; then
  echo "WARNUNG: Keine globale IPv6-Adresse ermittelt (ip -6 route get lieferte nichts) - TURN bleibt reines IPv4-only, auf einem DS-Lite/CGNAT-Anschluss von aussen unerreichbar. Weiter mit IPv4-only." >&2
else
  echo "Erkannte lokale/globale IPv6-Adresse: $LOCAL_IPV6"
fi

# TLS/DTLS fuer den STUN/TURN-Kontrollkanal (Allocate-/Permission-/Channel-
# Bind-Anfragen - Metadaten darueber, welche Peer-IP:Port-Paare gerade
# relayed werden) - vorher stand hier "no-tls"/"no-dtls", also bewusst
# UNVERSCHLUESSELT, nicht nur "nicht konfiguriert" (Sicherheitsaudit,
# SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 7). Das betrifft NICHT die
# eigentlichen Anruf-Mediendaten - die sind unabhaengig davon bereits durch
# WebRTCs eigenes DTLS-SRTP geschuetzt - sondern nur, ob ein Netzwerk-
# Beobachter zwischen Client und TURN-Server mitlesen kann, WER gerade WEN
# per TURN relayed.
#
# Nutzt dasselbe Zertifikat, das setup-tls.sh bereits fuer den Relay unter
# /etc/malachi/tls/ ablegt - kein zusaetzliches Zertifikat noetig, aber das
# Skript muss NACH setup-tls.sh laufen, sonst fehlen die Dateien.
if [ ! -f /etc/malachi/tls/fullchain.pem ] || [ ! -f /etc/malachi/tls/privkey.pem ]; then
  echo "FEHLER: /etc/malachi/tls/{fullchain,privkey}.pem nicht gefunden - erst setup-tls.sh ausfuehren." >&2
  exit 1
fi

cat > /etc/turnserver.conf <<EOF
listening-port=3478
tls-listening-port=5349
cert=/etc/malachi/tls/fullchain.pem
pkey=/etc/malachi/tls/privkey.pem
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=malachi.local
listening-ip=0.0.0.0
relay-ip=${LOCAL_IP}
external-ip=${PUBLIC_IP}/${LOCAL_IP}
min-port=${TURN_MIN_PORT}
max-port=${TURN_MAX_PORT}
no-cli
no-multicast-peers
# ── Audit 2026-09-28: TURN darf NICHT ins eigene Heimnetz relayen ──────────
# /turn-credentials gibt jedem im Internet gueltige TURN-Zugangsdaten (ohne
# Konto - so ist die App gebaut). Ohne die folgenden Zeilen konnte damit
# JEDER diesen TURN-Server als Sprungbrett in das private Netz dahinter
# benutzen (FritzBox-Oberflaeche 192.168.178.1, SSH des Servers, andere
# Geraete im WLAN) - bekanntes TURN-Missbrauchsmuster (vgl. CVE-2020-26262).
# coturn blockiert von sich aus nur Loopback, private Bereiche NICHT.
# Die eigene LAN-IP bleibt erlaubt, damit TURN-zu-TURN-Relaying zwischen
# zwei Clients desselben Servers weiter funktioniert.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
allowed-peer-ip=${LOCAL_IP}
# WebRTC nutzt keine TCP-Relay-Allokationen (RFC 6062) - abschalten verkleinert
# die Angriffsflaeche ohne Funktionsverlust. Quoten begrenzen Missbrauch der
# frei abrufbaren Zugangsdaten als Bandbreiten-Relay.
no-tcp-relay
user-quota=12
total-quota=1200
EOF
# lt-cred-mech (altes Username/Passwort-Verfahren) entfernt - stand bisher
# GLEICHZEITIG mit use-auth-secret in der Config, coturn meldete das beim
# Start selbst als Konfigurationsfehler ("Shared secret overrides
# username/password based auth method. Check your configuration!").
# use-auth-secret ist das tatsaechlich genutzte Verfahren (getTurnCredentials()
# leitet Anmeldedaten per HMAC aus TURN_SECRET ab, TURN-REST-API-Stil) -
# lt-cred-mech war reines totes Vermaechtnis, keine funktionale Aenderung,
# nur die Startup-Warnung beseitigt.
if [ -n "$LOCAL_IPV6" ]; then
  cat >> /etc/turnserver.conf <<EOF
listening-ip=${LOCAL_IPV6}
relay-ip=${LOCAL_IPV6}
EOF
  echo "IPv6 zu turnserver.conf hinzugefuegt (kein NAT bei IPv6 - lokale = oeffentliche Adresse, kein external-ip-Mapping noetig)."
fi

sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || \
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn

systemctl enable coturn
systemctl restart coturn

echo "== [2/3] Firewall (ufw) erweitern =="
ufw allow OpenSSH
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow ${TURN_MIN_PORT}:${TURN_MAX_PORT}/udp
ufw --force enable

echo "== [3/3] Fertig =="
echo "TURN (Klartext-Kontrollkanal, fuer Kompatibilitaet weiter verfuegbar): $PUBLIC_IP:3478"
echo "TURNS (TLS/DTLS-Kontrollkanal, bevorzugt verwenden): $PUBLIC_IP:5349"
echo "Secret ist identisch mit relay.js TURN_SECRET"
echo "Naechster Schritt: TURN_HOST (bevorzugt turns:$PUBLIC_IP:5349) in CallManager.js/WebRTCManager.js umstellen."
