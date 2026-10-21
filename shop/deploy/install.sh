#!/usr/bin/env bash
# Installiert bzw. aktualisiert den Malachi-Onion-Shop auf Debian 13 (trixie)
# oder Ubuntu 24.04.
#
#   sudo bash deploy/install.sh
#   sudo MONERO_NODE=<onion-adresse>.onion:18089 bash deploy/install.sh   (Remote-Node gleich setzen)
#   sudo OHNE_NPM=1 bash deploy/install.sh   (kein npm installieren - dann muss node_modules
#                                              lokal mit 'npm ci --omit=dev --ignore-scripts'
#                                              erzeugt und mitkopiert worden sein)
#
# Pakete kommen ausschliesslich aus den Paketquellen der Distribution (Debian
# bzw. Ubuntu): tor, nodejs (Debian 13: Node.js 20), npm. Begruendung fuer tor
# aus Debian statt aus dem Tor-Project-Repository: signiert mit den ohnehin
# vertrauten Archivschluesseln, Sicherheitsupdates ueber debian-security und
# unattended-upgrades, kein zusaetzlicher Fremdschluessel; die 0.4.8-Reihe
# kann alles, was der Shop braucht (v3-Onion-Dienst, Intro-DoS-Schutz, PoW
# sofern mitgebaut). Das Tor-Project-Repository bleibt eine Option, wenn eine
# neuere Tor-Version gebraucht wird (ANLEITUNG.md).
#
# Idempotent: Kann nach jeder Aenderung (Konfiguration, neue Version) erneut
# ausgefuehrt werden. Bestehende Schluessel, Konfigurationen und Daten werden
# nie ueberschrieben. Dienste werden erst gestartet, wenn alles eingerichtet ist.
#
# Ergebnis:
#   /opt/malachi-shop            Programm (root, nur lesbar)
#   /etc/malachi-shop/           config.json (root:malachi-shop 0640), Geheimnisse (root 0600)
#   /var/lib/malachi-shop/       Bestellungen, Buchhaltung, Sicherungen (malachi-shop 0700)
#   /etc/malachi-wallet/         wallet-rpc.conf, wallet.pass (root 0600)
#   /var/lib/malachi-wallet/     View-only-Wallet (malachi-wallet 0700)
#   /var/lib/tor/malachi-shop/   Onion-Dienst-Schluessel (debian-tor)

set -euo pipefail

QUELLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIEL=/opt/malachi-shop
NUTZER=malachi-shop
WNUTZER=malachi-wallet
KONF=/etc/malachi-shop
WKONF=/etc/malachi-wallet
HS_DIR=/var/lib/tor/malachi-shop

info() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
fehler() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fehler "Bitte als root ausfuehren (sudo)."
grep -q $'\r' "$0" && fehler "Dieses Skript hat Windows-Zeilenenden. Bitte: sed -i 's/\\r\$//' deploy/*.sh"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  debian:13 | ubuntu:24.04) ;;
  *)
    case " ${ID:-} ${ID_LIKE:-} " in
      *" debian "* | *" ubuntu "*) warn "Getestet ist dieses Skript fuer Debian 13 und Ubuntu 24.04 (gefunden: ${PRETTY_NAME:-unbekannt}) - weiter auf eigenes Risiko." ;;
      *) fehler "Nur Debian 13 (trixie) und Ubuntu 24.04 werden unterstuetzt (gefunden: ${PRETTY_NAME:-unbekannt})." ;;
    esac
    ;;
esac
# sudo fehlt auf minimalen Debian-Installationen - fuer Befehle als anderer
# Nutzer wird deshalb runuser (util-linux, immer vorhanden) verwendet.
command -v runuser >/dev/null 2>&1 || fehler "runuser fehlt (Paket util-linux)."

# ------------------------------------------------------------------ Pakete
PAKETE=(tor nodejs gnupg curl bzip2 ca-certificates openssl)
[ "${OHNE_NPM:-0}" = "1" ] || PAKETE+=(npm)
info "Pakete installieren (${PAKETE[*]})"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q "${PAKETE[@]}"
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=19)?0:1)' \
  || fehler "Node.js >= 18.19 benoetigt (gefunden: $NODE_VERSION)."

# ------------------------------------------------------------------ Nutzer
info "Systemnutzer anlegen"
for n in "$NUTZER" "$WNUTZER"; do
  id "$n" >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$n"
done

# ------------------------------------------------------------------ Programm
info "Programm nach $ZIEL kopieren"
NEU="$(mktemp -d /opt/.malachi-shop.neu.XXXXXX)"
cp -r "$QUELLE/src" "$QUELLE/static" "$QUELLE/deploy" "$NEU/"
cp "$QUELLE/package.json" "$QUELLE/package-lock.json" "$QUELLE/.npmrc" "$QUELLE/config.example.json" "$NEU/"
for d in ANLEITUNG.md LIZENZ_FORMAT.md VERKAUF_UND_STEUER.md; do [ -f "$QUELLE/$d" ] && cp "$QUELLE/$d" "$NEU/"; done
if command -v npm >/dev/null 2>&1; then
  (cd "$NEU" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
elif [ -d "$QUELLE/node_modules/@scure/bip32" ] && [ -d "$QUELLE/node_modules/@noble/curves" ]; then
  warn "npm nicht installiert - uebernehme vorhandenes node_modules (vorher lokal 'npm ci --omit=dev --ignore-scripts' ausfuehren)."
  cp -r "$QUELLE/node_modules" "$NEU/"
else
  rm -rf "$NEU"
  fehler "Abhaengigkeiten fehlen. Entweder ohne OHNE_NPM=1 ausfuehren (installiert npm) oder lokal 'npm ci --omit=dev --ignore-scripts' ausfuehren und node_modules mitkopieren."
fi
chown -R root:root "$NEU"
chmod -R u=rwX,go=rX "$NEU"
if [ -d "$ZIEL" ]; then rm -rf "$ZIEL.alt"; mv "$ZIEL" "$ZIEL.alt"; fi
mv "$NEU" "$ZIEL"
rm -rf "$ZIEL.alt"

# ------------------------------------------------------------------ Verzeichnisse
info "Verzeichnisse und Rechte"
install -d -o root -g "$NUTZER" -m 0750 "$KONF"
install -d -o root -g root -m 0700 "$WKONF"
install -d -o "$NUTZER" -g "$NUTZER" -m 0700 /var/lib/malachi-shop
install -d -o "$WNUTZER" -g "$WNUTZER" -m 0700 /var/lib/malachi-wallet

# ------------------------------------------------------------------ Konfiguration und Geheimnisse
if [ ! -f "$KONF/config.json" ]; then
  install -o root -g "$NUTZER" -m 0640 "$ZIEL/config.example.json" "$KONF/config.json"
  echo "Neue Konfiguration angelegt: $KONF/config.json (bitte anpassen)"
fi

if [ ! -f "$KONF/lizenz-privat.pem" ]; then
  info "Lizenz-Signierschluessel erzeugen"
  (umask 077 && node "$ZIEL/src/werkzeuge/lizenzschluessel.js" erzeugen --ausgabe "$KONF/lizenz-privat.pem")
  echo ">>> Den oeffentlichen Schluessel oben in die App einbauen und den privaten Schluessel SICHERN (ANLEITUNG.md)."
fi
chown root:root "$KONF/lizenz-privat.pem"; chmod 0600 "$KONF/lizenz-privat.pem"

if [ ! -f "$KONF/wallet-rpc.login" ]; then
  info "Zugang zum wallet-rpc erzeugen"
  PASSWORT="$(openssl rand -hex 24)"
  (umask 077 && printf 'shop:%s\n' "$PASSWORT" > "$KONF/wallet-rpc.login")
  NODE_ADRESSE="${MONERO_NODE:-HIER_ONION_NODE_EINTRAGEN.onion:18089}"
  (umask 077 && cat > "$WKONF/wallet-rpc.conf" <<EOF
# monero-wallet-rpc fuer den Malachi-Shop (geladen als systemd-Credential)
# Remote-Node ueber Tor (Onion-Adresse eines vertrauenswuerdigen Nodes, Port meist 18089):
daemon-address=${NODE_ADRESSE}
proxy=127.0.0.1:9050
untrusted-daemon=1
rpc-bind-ip=127.0.0.1
rpc-bind-port=18082
rpc-login=shop:${PASSWORT}
log-file=/var/lib/malachi-wallet/wallet-rpc.log
log-level=0
max-log-file-size=10000000
max-log-files=2
EOF
  )
  unset PASSWORT
fi
chown root:root "$KONF/wallet-rpc.login" "$WKONF/wallet-rpc.conf"; chmod 0600 "$KONF/wallet-rpc.login" "$WKONF/wallet-rpc.conf"

if [ ! -f "$WKONF/wallet.pass" ]; then
  (umask 077 && openssl rand -hex 32 > "$WKONF/wallet.pass")
fi
chown root:root "$WKONF/wallet.pass"; chmod 0600 "$WKONF/wallet.pass"

# ------------------------------------------------------------------ Monero-Programme
if [ ! -x /opt/monero/monero-wallet-rpc ]; then
  info "Monero-Programme installieren (Signatur wird geprueft)"
  bash "$ZIEL/deploy/monero-installieren.sh"
fi

# ------------------------------------------------------------------ systemd
info "systemd-Dienste einrichten"
install -o root -g root -m 0644 "$ZIEL/deploy/malachi-shop.service" /etc/systemd/system/malachi-shop.service
install -o root -g root -m 0644 "$ZIEL/deploy/malachi-wallet-rpc.service" /etc/systemd/system/malachi-wallet-rpc.service
systemctl daemon-reload

# ------------------------------------------------------------------ Tor
info "Tor-Onion-Dienst einrichten"
install -d -o root -g root -m 0755 /etc/tor/torrc.d
install -o root -g root -m 0644 "$ZIEL/deploy/torrc-malachi-shop.conf" /etc/tor/torrc.d/malachi-shop.conf
# Proof-of-Work-Schutz nur einschalten, wenn dieses Tor ihn mitbringt
# (Tor >= 0.4.8, mit --enable-gpl gebaut; sonst bricht --verify-config ab).
TOR_MODULE="$(tor --list-modules 2>/dev/null || true)"
if grep -qx 'pow: yes' <<<"$TOR_MODULE"; then
  sed -i 's/^#HiddenServicePoWDefensesEnabled 1$/HiddenServicePoWDefensesEnabled 1/' /etc/tor/torrc.d/malachi-shop.conf
fi
if ! grep -Eq '^%include /etc/tor/torrc\.d/?(\*\.conf)?' /etc/tor/torrc; then
  printf '\n%%include /etc/tor/torrc.d/*.conf\n' >> /etc/tor/torrc
fi
runuser -u debian-tor -- tor --verify-config -f /etc/tor/torrc >/dev/null || fehler "Tor-Konfiguration ungueltig (tor --verify-config)."
systemctl enable --now tor >/dev/null 2>&1 || true
systemctl reload tor@default 2>/dev/null || systemctl restart tor
for _ in $(seq 1 60); do [ -s "$HS_DIR/hostname" ] && break; sleep 1; done
[ -s "$HS_DIR/hostname" ] || fehler "Onion-Adresse wurde nicht erzeugt (journalctl -u tor@default)."
ONION="$(cat "$HS_DIR/hostname")"

# ------------------------------------------------------------------ Bereitschaft pruefen
BEREIT=1
grep -q 'HIER_DIE_MONERO_HAUPTADRESSE_EINTRAGEN' "$KONF/config.json" && { warn "In $KONF/config.json fehlt die Monero-Hauptadresse (zahlungswege.xmr.hauptadresse)."; BEREIT=0; }
grep -q 'HIER_ONION_NODE_EINTRAGEN' "$WKONF/wallet-rpc.conf" && { warn "In $WKONF/wallet-rpc.conf fehlt der Remote-Node (daemon-address=...onion:18089)."; BEREIT=0; }
[ -f /var/lib/malachi-wallet/shop-view.keys ] || { warn "Noch kein View-only-Wallet - bitte 'sudo bash $ZIEL/deploy/wallet-einrichten.sh' ausfuehren."; BEREIT=0; }

if [ "$BEREIT" -eq 1 ]; then
  info "Dienste starten"
  systemctl enable malachi-wallet-rpc malachi-shop >/dev/null
  systemctl restart malachi-wallet-rpc
  sleep 5
  systemctl restart malachi-shop
  sleep 3
  systemctl --no-pager --lines=15 status malachi-shop || true
else
  echo
  echo "Dienste wurden NICHT gestartet - bitte obige Punkte erledigen und dieses Skript erneut ausfuehren."
fi

cat <<EOF

==================================================================
 Onion-Adresse des Shops:  http://${ONION}
==================================================================
 Den Onion-Schluessel in ${HS_DIR}/ SICHERN (ANLEITUNG.md, Abschnitt "Sicherungen").
 Protokoll:  journalctl -u malachi-shop -u malachi-wallet-rpc -f
 Pruefung:   sudo bash ${ZIEL}/deploy/pruefen.sh
EOF
