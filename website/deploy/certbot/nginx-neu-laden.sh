#!/usr/bin/env bash
# certbot deploy-hook: nach jeder erfolgreichen Verlaengerung nginx neu laden,
# damit das neue Zertifikat sofort gilt (Neuladen ist auch fuer andere
# Zertifikate auf diesem Rechner harmlos).
# Installiert nach /etc/letsencrypt/renewal-hooks/deploy/malachi-web-nginx.sh

set -euo pipefail
if nginx -t -q; then
  systemctl reload nginx
else
  echo "nginx -t fehlgeschlagen - nginx wurde NICHT neu geladen." >&2
  exit 1
fi
