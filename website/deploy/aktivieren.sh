#!/usr/bin/env bash
# Hochgeladene Website-Version pruefen und atomar aktivieren.
# Installiert als /usr/local/sbin/malachi-web-aktivieren (website/deploy/install.sh).
#
#   sudo malachi-web-aktivieren <stempel>   Upload aus /var/lib/malachi-web/eingang/<stempel> aktivieren
#   sudo malachi-web-aktivieren --zurueck   vorherige Version wieder aktivieren
#   sudo malachi-web-aktivieren --liste     vorhandene Versionen anzeigen
#
# Der Upload kommt vom PC des Betreibers (website/werkzeuge/veroeffentlichen.mjs
# --hochladen). Geprueft wird: nur normale Dateien und Ordner (keine Links),
# nur erlaubte Dateitypen, Groesse, SHA256SUMS, Manifest <-> APKs, Signatur
# des Manifests (wenn /etc/malachi-web/update-schluessel.b64u existiert) und
# dass die Version nicht aelter ist als die aktive (ERZWINGEN=1 uebergeht das).
# Danach wird der Symlink /var/www/malachi/aktuell in einem Schritt umgestellt.

set -euo pipefail

EINGANG=/var/lib/malachi-web/eingang
WURZEL=/var/www/malachi
RELEASES="$WURZEL/releases"
AKTUELL="$WURZEL/aktuell"
SCHLUESSEL=/etc/malachi-web/update-schluessel.b64u
NUTZER=malachi-web
BEHALTEN="${BEHALTEN:-3}"
MAX_MB="${MAX_MB:-2048}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
fehler() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fehler "Bitte mit sudo ausfuehren."
command -v jq >/dev/null || fehler "jq fehlt (apt-get install jq)."

aktive_version() {
  local ziel
  ziel="$(readlink "$AKTUELL" 2>/dev/null || true)"
  printf '%s' "${ziel#releases/}"
}

umschalten() {
  local name="$1"
  [ -d "$RELEASES/$name" ] || fehler "Version $name gibt es nicht."
  ln -sfn "releases/$name" "$WURZEL/.aktuell.neu"
  mv -Tf "$WURZEL/.aktuell.neu" "$AKTUELL"   # rename(2): atomar, keine Luecke
  info "Aktiv: $name"
}

liste() {
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort
}

case "${1:-}" in
  --liste)
    AKTIV="$(aktive_version)"
    liste | while read -r v; do
      [ "$v" = "$AKTIV" ] && printf '* %s (aktiv)\n' "$v" || printf '  %s\n' "$v"
    done
    exit 0
    ;;
  --zurueck)
    AKTIV="$(aktive_version)"
    VORHER="$(liste | awk -v a="$AKTIV" '$0 == a { print v; exit } { v = $0 }')"
    [ -n "$VORHER" ] || fehler "Keine aeltere Version vorhanden (aktiv: ${AKTIV:-keine})."
    umschalten "$VORHER"
    exit 0
    ;;
  ''|-*)
    echo "Verwendung: malachi-web-aktivieren <stempel> | --zurueck | --liste" >&2
    exit 2
    ;;
esac

STEMPEL="$1"
[[ "$STEMPEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || fehler "Ungueltiger Name: $STEMPEL"
Q="$EINGANG/$STEMPEL"
[ -d "$Q" ] && [ ! -L "$Q" ] || fehler "Kein Upload unter $Q."
[ ! -e "$RELEASES/$STEMPEL" ] || fehler "Version $STEMPEL ist bereits vorhanden."

info "Pruefe Upload $Q"
# 1. Nur normale Dateien und Ordner
SONDER="$(find "$Q" -mindepth 1 ! -type f ! -type d -print -quit)"
[ -z "$SONDER" ] || fehler "Nicht erlaubt (Link/Sonderdatei): ${SONDER#"$Q"/}"

# 2. Groesse
GROESSE="$(du -sm "$Q" | awk '{print $1}')"
[ "$GROESSE" -le "$MAX_MB" ] || fehler "Upload ist ${GROESSE} MB gross (erlaubt: ${MAX_MB} MB)."

# 3. Erlaubte Namen und Dateitypen
while IFS= read -r -d '' f; do
  rel="${f#"$Q"/}"
  [[ "$rel" =~ ^[A-Za-z0-9._/-]+$ ]] || fehler "Unerlaubte Zeichen im Dateinamen: $rel"
  case "/$rel" in
    */.well-known/*) ;;
    */.*) fehler "Versteckte Datei nicht erlaubt: $rel" ;;
  esac
  case "$rel" in
    *.html|*.css|*.svg|*.png|*.ico|*.webp|*.txt|*.json|*.sig|*.pem|*.apk|updates/SHA256SUMS) ;;
    *) fehler "Dateityp nicht erlaubt: $rel" ;;
  esac
done < <(find "$Q" -mindepth 1 -type f -print0)

# 4. Pflichtdateien
for p in index.html 404.html assets/style.css updates/manifest.json updates/manifest.json.sig updates/SHA256SUMS; do
  [ -f "$Q/$p" ] || fehler "Pflichtdatei fehlt: $p"
done

# 5. Signatur des Manifests (ueber die unveraenderten Bytes)
M="$Q/updates/manifest.json"
if [ -s "$SCHLUESSEL" ]; then
  ARBEIT="$(mktemp -d)"
  trap 'rm -rf "$ARBEIT"' EXIT
  B64U="$(tr -d '[:space:]' < "$SCHLUESSEL")"
  [[ "$B64U" =~ ^[A-Za-z0-9_-]{43}$ ]] || fehler "$SCHLUESSEL enthaelt keinen Base64url-Schluessel (43 Zeichen)."
  B64="$(printf '%s=' "$B64U" | tr '_-' '/+')"
  {
    echo '-----BEGIN PUBLIC KEY-----'
    { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; printf '%s' "$B64" | base64 -d; } | base64 -w0
    echo
    echo '-----END PUBLIC KEY-----'
  } > "$ARBEIT/schluessel.pem"
  SIG="$(tr -d '\r\n' < "$Q/updates/manifest.json.sig")"
  [[ "$SIG" =~ ^[A-Za-z0-9+/]{86}==$ ]] || fehler "manifest.json.sig hat nicht das erwartete Format."
  printf '%s' "$SIG" | base64 -d > "$ARBEIT/sig.bin"
  openssl pkeyutl -verify -pubin -inkey "$ARBEIT/schluessel.pem" -rawin -in "$M" -sigfile "$ARBEIT/sig.bin" >/dev/null 2>&1 \
    || fehler "Signatur des Manifests UNGUELTIG - nicht aktiviert."
  info "Signatur des Manifests gueltig."
else
  warn "Kein oeffentlicher Update-Schluessel in $SCHLUESSEL - Signatur NICHT geprueft."
fi

# 6. Manifest-Inhalt und APKs
[ "$(head -c 3 "$M" | od -An -tx1 | tr -d ' ')" != "efbbbf" ] || fehler "manifest.json beginnt mit BOM."
jq -e '.format == "malachi-update-manifest" and .formatVersion == 1 and (.apks | type == "array" and length > 0)' "$M" >/dev/null \
  || fehler "manifest.json hat nicht das erwartete Format."
NEU_CODE="$(jq -r '.versionCode' "$M")"
[[ "$NEU_CODE" =~ ^[0-9]+$ ]] || fehler "versionCode ungueltig."
while IFS=$'\t' read -r datei groesse hash; do
  [[ "$datei" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$ ]] || fehler "Ungueltiger Dateiname im Manifest: $datei"
  [ -f "$Q/updates/$datei" ] || fehler "Im Manifest genannte Datei fehlt: $datei"
  [ "$(stat -c %s "$Q/updates/$datei")" = "$groesse" ] || fehler "Groesse von $datei passt nicht zum Manifest."
  [ "$(sha256sum "$Q/updates/$datei" | awk '{print $1}')" = "$hash" ] || fehler "SHA-256 von $datei passt nicht zum Manifest."
done < <(jq -r '.apks[] | [.file, (.size | tostring), .sha256] | @tsv' "$M")
(cd "$Q/updates" && sha256sum --quiet --strict -c SHA256SUMS) || fehler "SHA256SUMS stimmt nicht."

# 7. Nicht hinter die aktive Version zurueck
AKTIV="$(aktive_version)"
if [ -n "$AKTIV" ] && [ -f "$RELEASES/$AKTIV/updates/manifest.json" ]; then
  ALT_CODE="$(jq -r '.versionCode' "$RELEASES/$AKTIV/updates/manifest.json")"
  if [[ "$ALT_CODE" =~ ^[0-9]+$ ]] && [ "$NEU_CODE" -lt "$ALT_CODE" ] && [ "${ERZWINGEN:-0}" != "1" ]; then
    fehler "Upload hat versionCode $NEU_CODE, aktiv ist $ALT_CODE. Absicht? Dann mit ERZWINGEN=1."
  fi
fi

# 8. Uebernehmen (Besitzer malachi-web, fuer nginx nur lesbar), dann umschalten
info "Uebernehme nach $RELEASES/$STEMPEL"
cp -r --no-preserve=mode,ownership "$Q" "$RELEASES/.$STEMPEL.neu"
chown -R "$NUTZER:$NUTZER" "$RELEASES/.$STEMPEL.neu"
find "$RELEASES/.$STEMPEL.neu" -type d -exec chmod 0755 {} +
find "$RELEASES/.$STEMPEL.neu" -type f -exec chmod 0644 {} +
mv -T "$RELEASES/.$STEMPEL.neu" "$RELEASES/$STEMPEL"
umschalten "$STEMPEL"
rm -rf "$Q"

# 9. Alte Versionen aufraeumen (die aktive und die neuesten $BEHALTEN bleiben)
AKTIV="$(aktive_version)"
liste | head -n "-$BEHALTEN" | while read -r alt; do
  [ "$alt" = "$AKTIV" ] && continue
  rm -rf "${RELEASES:?}/$alt"
  info "Alte Version entfernt: $alt"
done

VERSION="$(jq -r '.versionName' "$RELEASES/$STEMPEL/updates/manifest.json")"
info "Fertig: Malachi $VERSION (versionCode $NEU_CODE) ist online - Onion und Clearnet."
echo "Zurueck zur vorherigen Version: sudo malachi-web-aktivieren --zurueck"
