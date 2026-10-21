# Erzeugt den Upload-Schluessel der Play-Variante und android\keystore-play.properties.
#
#   powershell -ExecutionPolicy Bypass -File android\play-upload-schluessel-erzeugen.ps1
#
# Das Passwort gibst du selbst verdeckt ein. Es landet nur im Schluesselspeicher und in
# keystore-play.properties (steht in .gitignore, wird nie committet). Danach Schluesseldatei
# und Passwort getrennt sichern (USB-Stick / Passwortmanager). Geht der Upload-Schluessel
# verloren, laesst er sich ueber die Play Console zuruecksetzen (PLAY_STORE.md, Abschnitt 4).
# Der Website-Schluessel (keystore.properties) wird hier nicht angefasst.
param(
  [string]$Ziel = (Join-Path $env:USERPROFILE '.malachi\malachi-play-upload.jks'),
  [string]$Organisation = 'Malachi'
)
$ErrorActionPreference = 'Stop'
$props = Join-Path $PSScriptRoot 'keystore-play.properties'
if (Test-Path $Ziel) { throw "$Ziel existiert schon - wird nicht ueberschrieben." }
if (Test-Path $props) { throw "$props existiert schon - wird nicht ueberschrieben." }

$kandidaten = @()
if ($env:JAVA_HOME) { $kandidaten += (Join-Path $env:JAVA_HOME 'bin\keytool.exe') }
$kandidaten += 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe'
$keytool = $kandidaten | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $keytool) { $c = Get-Command keytool -ErrorAction SilentlyContinue; if ($c) { $keytool = $c.Source } }
if (-not $keytool) { throw 'keytool nicht gefunden (JDK oder Android Studio installieren).' }

function Klartext([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

Write-Host 'Neuen Upload-Schluessel fuer Google Play anlegen.'
Write-Host 'Passwort: mindestens 16 Zeichen, nur normale Zeichen (A-Z, a-z, 0-9, Satzzeichen, keine Umlaute) - am besten im Passwortmanager erzeugen und dort speichern.'
$p1 = Klartext (Read-Host 'Passwort' -AsSecureString)
$p2 = Klartext (Read-Host 'Passwort wiederholen' -AsSecureString)
if ($p1 -ne $p2) { throw 'Die Passwoerter stimmen nicht ueberein - nichts angelegt.' }
if ($p1.Length -lt 16) { throw 'Bitte mindestens 16 Zeichen - nichts angelegt.' }
if ($p1 -notmatch '^[\x21-\x7E]+$') { throw 'Bitte nur normale Zeichen ohne Leerzeichen und Umlaute - nichts angelegt.' }

New-Item -ItemType Directory -Force (Split-Path $Ziel) | Out-Null
$env:MALACHI_PLAY_PW = $p1
try {
  & $keytool -genkeypair -keystore $Ziel -storetype PKCS12 -alias malachi-play-upload -keyalg RSA -keysize 4096 -validity 10000 `
    -dname "CN=Malachi Play Upload, O=$Organisation, C=DE" -storepass:env MALACHI_PLAY_PW -keypass:env MALACHI_PLAY_PW
  if ($LASTEXITCODE -ne 0) { throw "keytool beendet mit Code $LASTEXITCODE" }
  # Java-Properties: Backslash maskieren; Datei als ASCII schreiben
  $pw = $p1.Replace('\', '\\')
  $pfad = $Ziel.Replace('\', '/')
  @(
    '# Upload-Schluessel der Play-Variante (PLAY_STORE.md, Abschnitt 4). Nie committen.',
    "storeFile=$pfad",
    "storePassword=$pw",
    'keyAlias=malachi-play-upload',
    "keyPassword=$pw"
  ) | Set-Content -Encoding ASCII $props
  Write-Host ''
  Write-Host "Angelegt: $Ziel"
  Write-Host "          $props"
  $liste = & $keytool -list -v -keystore $Ziel -storepass:env MALACHI_PLAY_PW -alias malachi-play-upload
  $fp = ($liste | Select-String 'SHA256:' | Select-Object -First 1).ToString().Trim()
  Write-Host "Fingerabdruck des Upload-Zertifikats: $fp"
} finally {
  Remove-Item Env:\MALACHI_PLAY_PW -ErrorAction SilentlyContinue
  $p1 = $null; $p2 = $null; $pw = $null
}
Write-Host ''
Write-Host 'Jetzt sichern: die .jks-Datei auf den USB-Stick, das Passwort in den Passwortmanager.'
