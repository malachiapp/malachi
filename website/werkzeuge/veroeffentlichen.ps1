<#
.SYNOPSIS
  Malachi-Website bauen, Update-Manifest signieren und auf den Laptop hochladen.

.DESCRIPTION
  Bequemer Aufruf von veroeffentlichen.mjs unter Windows (Windows PowerShell 5.1
  oder PowerShell 7). Braucht Node.js >= 18 und fuer -Hochladen den OpenSSH-Client
  von Windows (ssh, scp). Ablauf und Hintergrund: website\ANLEITUNG.md.

  Der private Update-Signierschluessel bleibt auf diesem PC (Standard:
  $HOME\.malachi\update-signierschluessel.json); hochgeladen werden nur fertig
  signierte Dateien.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File website\werkzeuge\veroeffentlichen.ps1 -Entwurf -Vorschau

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File website\werkzeuge\veroeffentlichen.ps1 -Hochladen
#>
[CmdletBinding()]
param(
  # Vorschau: fehlende Angaben als Platzhalter, keine Signatur, kein Hochladen.
  [switch]$Entwurf,
  # Nach dem Bauen per scp hochladen und per ssh (sudo) aktivieren.
  [switch]$Hochladen,
  # Nach dem Bauen die Startseite im Browser oeffnen.
  [switch]$Vorschau,
  # Ordner mit app-web-<abi>-release.apk (Standard: android\app\build\outputs\apk\web\release,
  # gebaut mit .\gradlew assembleWebRelease - nie die Play-Variante).
  [string]$ApkOrdner,
  [string]$Version,
  [int]$VersionCode = 0,
  [int]$MinVersionCode = 0,
  # Versionshinweise (Standard: website\versionshinweise\<version>.txt).
  [string]$Hinweise,
  # Privater Update-Signierschluessel.
  [string]$Schluessel,
  [string]$SshZiel,
  [string]$SshSchluessel,
  [string]$Apksigner,
  [switch]$OhneApksigner,
  [switch]$PlatzhalterErlauben
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'FEHLER: Node.js wurde nicht gefunden. Bitte Node.js (>= 18) installieren.' -ForegroundColor Red
  exit 1
}
if ($Hochladen) {
  foreach ($p in @('ssh', 'scp')) {
    if (-not (Get-Command $p -ErrorAction SilentlyContinue)) {
      Write-Host "FEHLER: $p fehlt. Windows-Einstellungen > Apps > Optionale Features > OpenSSH-Client installieren." -ForegroundColor Red
      exit 1
    }
  }
}

$skript = Join-Path $PSScriptRoot 'veroeffentlichen.mjs'
$liste = New-Object System.Collections.Generic.List[string]
if ($Entwurf) { $liste.Add('--entwurf') }
if ($Hochladen) { $liste.Add('--hochladen') }
if ($ApkOrdner) { $liste.Add('--apk-ordner'); $liste.Add($ApkOrdner) }
if ($Version) { $liste.Add('--version'); $liste.Add($Version) }
if ($VersionCode -gt 0) { $liste.Add('--version-code'); $liste.Add([string]$VersionCode) }
if ($MinVersionCode -gt 0) { $liste.Add('--min-version-code'); $liste.Add([string]$MinVersionCode) }
if ($Hinweise) { $liste.Add('--hinweise'); $liste.Add($Hinweise) }
if ($Schluessel) { $liste.Add('--schluessel'); $liste.Add($Schluessel) }
if ($SshZiel) { $liste.Add('--ssh-ziel'); $liste.Add($SshZiel) }
if ($SshSchluessel) { $liste.Add('--ssh-schluessel'); $liste.Add($SshSchluessel) }
if ($Apksigner) { $liste.Add('--apksigner'); $liste.Add($Apksigner) }
if ($OhneApksigner) { $liste.Add('--ohne-apksigner') }
if ($PlatzhalterErlauben) { $liste.Add('--platzhalter-erlauben') }

& $node.Source $skript @liste
$code = $LASTEXITCODE

if ($code -eq 0 -and $Vorschau) {
  $start = Join-Path $PSScriptRoot '..\build\seite\index.html'
  if (Test-Path $start) { Start-Process (Resolve-Path $start).Path }
}
exit $code
