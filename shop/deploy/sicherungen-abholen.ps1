# Malachi: verschluesselte Shop-Sicherungen (Bestellungen + Buchhaltung) vom
# Server auf diesen PC holen. Laeuft taeglich als geplante Aufgabe
# "Malachi Shop-Sicherungen abholen". Die Dateien sind mit dem oeffentlichen
# Sicherungsschluessel verschluesselt; lesbar nur mit
# %USERPROFILE%\.malachi\buchhaltung-sicherung-privat.pem.
# Der Server behaelt 30 Tage, hier bleiben alle liegen. Zielordner anpassen:
$ErrorActionPreference = 'Stop'
$ziel = Join-Path $env:USERPROFILE 'Malachi-Backups\shop-sicherungen'
$protokoll = Join-Path $ziel 'abholen.log'
$scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
$schluessel = Join-Path $env:USERPROFILE '.ssh\malachi_hetzner'
New-Item -ItemType Directory -Force $ziel | Out-Null
try {
  & $scp -q -B -i $schluessel -o ConnectTimeout=30 'root@46.225.2.50:/var/lib/malachi-shop/sicherungen/malachi-sicherung-*.bin' $ziel
  if ($LASTEXITCODE -ne 0) { throw "scp beendet mit Code $LASTEXITCODE" }
  $anzahl = @(Get-ChildItem $ziel -Filter 'malachi-sicherung-*.bin').Count
  $neueste = (Get-ChildItem $ziel -Filter 'malachi-sicherung-*.bin' | Sort-Object Name | Select-Object -Last 1).Name
  Add-Content -Encoding utf8 $protokoll ('{0:yyyy-MM-dd HH:mm} OK - {1} Sicherungen lokal, neueste: {2}' -f (Get-Date), $anzahl, $neueste)
} catch {
  Add-Content -Encoding utf8 $protokoll ('{0:yyyy-MM-dd HH:mm} FEHLER: {1}' -f (Get-Date), $_)
  exit 1
}
