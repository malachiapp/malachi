#!/usr/bin/env bash
# Laedt die offiziellen Monero-CLI-Programme herunter, prueft die GPG-Signatur der
# Pruefsummenliste (Schluessel von binaryFate, Fingerabdruck fest hinterlegt) und
# die SHA-256-Pruefsumme, und installiert NUR monero-wallet-rpc und monero-wallet-cli
# nach /opt/monero-<version> (Symlink /opt/monero).
#
#   sudo MONERO_VERSION=v0.18.5.4 bash deploy/monero-installieren.sh
#   sudo NUR_PRUEFEN=1 bash deploy/monero-installieren.sh   (Installierte Programme gegen das signierte Paket pruefen)
#
# Aktuelle Version: https://www.getmonero.org/downloads/ (Monero-Updates/Hardforks beachten!)
#
# Audit 2026-10-19 (S1): Nur der Schluessel mit dem festen Fingerabdruck kommt in
# den Schluesselbund; gpgv muss VALIDSIG fuer genau diesen Schluessel melden; die
# Pruefsumme wird NUR aus dem signierten Teil gelesen (Text vor/nach der Signatur
# prueft gpgv nicht) und muss genau einmal vorkommen; sha256sum --strict; kein
# Programmstart als root.

set -euo pipefail

VERSION="${MONERO_VERSION:-v0.18.5.4}"
FINGERABDRUCK="81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92" # binaryFate
DATEI="monero-linux-x64-${VERSION}.tar.bz2"
URL="https://downloads.getmonero.org/cli/${DATEI}"
HASHES="https://www.getmonero.org/downloads/hashes.txt"
SCHLUESSEL="https://raw.githubusercontent.com/monero-project/monero/master/utils/gpg_keys/binaryfate.asc"
ZIEL="/opt/monero-${VERSION}"

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren (sudo)." >&2; exit 1; }
[ "$(uname -m)" = "x86_64" ] || { echo "Nur fuer x86_64 vorbereitet." >&2; exit 1; }
for p in curl gpg gpgv sha256sum tar bzip2 cmp; do command -v "$p" >/dev/null || { echo "Programm fehlt: $p (apt-get install curl gnupg bzip2 diffutils)" >&2; exit 1; }; done

ARBEIT="$(mktemp -d)"
trap 'rm -rf "$ARBEIT"' EXIT
cd "$ARBEIT"

echo "==> Lade Signaturschluessel, Pruefsummenliste und ${DATEI}"
curl -fsSL --proto '=https' --tlsv1.2 -o binaryfate.asc "$SCHLUESSEL"
curl -fsSL --proto '=https' --tlsv1.2 -o hashes.txt "$HASHES"
curl -fSL --proto '=https' --tlsv1.2 -o "$DATEI" "$URL"

echo "==> Pruefe Fingerabdruck des Signaturschluessels"
if ! gpg --show-keys --with-colons binaryfate.asc 2>/dev/null | awk -F: '/^fpr/{print $10}' | grep -qx "$FINGERABDRUCK"; then
  echo "FEHLER: Schluessel hat nicht den erwarteten Fingerabdruck $FINGERABDRUCK" >&2
  exit 1
fi
# Nur genau diesen Schluessel in den Schluesselbund (die .asc koennte weitere enthalten).
export GNUPGHOME="$ARBEIT/gnupg"
install -d -m 0700 "$GNUPGHOME"
gpg --batch --quiet --import binaryfate.asc 2>/dev/null
gpg --batch --export "$FINGERABDRUCK" > binaryfate.gpg
[ -s binaryfate.gpg ] || { echo "FEHLER: Schluessel $FINGERABDRUCK nicht exportierbar" >&2; exit 1; }

echo "==> Pruefe GPG-Signatur der Pruefsummenliste"
if ! gpgv --status-fd 3 --keyring ./binaryfate.gpg --output hashes.signiert hashes.txt 3>gpgv.status 2>gpgv.log; then
  cat gpgv.log >&2
  echo "FEHLER: Signatur von hashes.txt ungueltig" >&2
  exit 1
fi
if ! grep -qE "^\[GNUPG:\] VALIDSIG .*${FINGERABDRUCK}$" gpgv.status; then
  echo "FEHLER: keine gueltige Signatur von ${FINGERABDRUCK}" >&2
  exit 1
fi

echo "==> Pruefe SHA-256 von ${DATEI} (nur der signierte Teil zaehlt)"
TREFFER="$(grep -cE "^[0-9a-f]{64}  ${DATEI}$" hashes.signiert || true)"
if [ "$TREFFER" != "1" ]; then
  echo "FEHLER: ${DATEI} steht nicht genau einmal im signierten Teil von hashes.txt (${TREFFER}x) - Version pruefen" >&2
  exit 1
fi
ERWARTET="$(grep -E "^[0-9a-f]{64}  ${DATEI}$" hashes.signiert | awk '{print $1}')"
echo "${ERWARTET}  ${DATEI}" | sha256sum --strict -c -

tar -xjf "$DATEI"
QUELLE="$(find . -maxdepth 1 -type d -name 'monero-*' | head -n1)"
[ -n "$QUELLE" ] || { echo "FEHLER: Paket enthaelt kein monero-Verzeichnis" >&2; exit 1; }

if [ "${NUR_PRUEFEN:-0}" = "1" ]; then
  echo "==> Vergleiche die installierten Programme in ${ZIEL} mit dem geprueften Paket"
  FEHLER=0
  for prog in monero-wallet-rpc monero-wallet-cli; do
    if cmp -s "$QUELLE/$prog" "$ZIEL/$prog"; then
      echo "OK          $prog stimmt mit dem signierten Paket ueberein"
    else
      echo "ABWEICHUNG  $prog unterscheidet sich vom signierten Paket!"
      FEHLER=1
    fi
  done
  exit "$FEHLER"
fi

echo "==> Installiere nach ${ZIEL}"
install -d -o root -g root -m 0755 "$ZIEL"
install -o root -g root -m 0755 "$QUELLE/monero-wallet-rpc" "$QUELLE/monero-wallet-cli" "$ZIEL/"
ln -sfn "$ZIEL" /opt/monero
# Kein Programmstart als root - nur die Pruefsummen der Installation zeigen.
sha256sum "$ZIEL/monero-wallet-rpc" "$ZIEL/monero-wallet-cli"
echo "Fertig: /opt/monero -> ${ZIEL}"
