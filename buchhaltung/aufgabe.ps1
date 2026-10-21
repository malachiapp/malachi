# Taegliche Aufgabe "Malachi Buchhaltung": bucht eindeutig erkannte Belege (z. B. Hetzner)
# aus Belege\Eingang und erstellt nach Quartalsende den Quartalsbericht (nach Q4 auch den
# EUeR-Entwurf). Bei neuen Berichten oder Erinnerungen erscheint eine Windows-Benachrichtigung.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [string]$Programm = (Join-Path $env:USERPROFILE 'Malachi-Buchhaltung\programm\buchhaltung\malachi-buchhaltung.mjs'),
  [string]$Protokoll = (Join-Path $env:USERPROFILE 'Malachi-Buchhaltung\aufgabe.log')
)
$ErrorActionPreference = 'Continue'

function Melden([string]$titel, [string]$text) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $t = $xml.GetElementsByTagName('text')
    $t.Item(0).AppendChild($xml.CreateTextNode($titel)) | Out-Null
    $t.Item(1).AppendChild($xml.CreateTextNode($text)) | Out-Null
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch { }
}

$ausgabe = & $Node $Programm bericht --automatisch 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$zeit = Get-Date -Format 'yyyy-MM-dd HH:mm'
Add-Content -Encoding utf8 $Protokoll ("== $zeit (Code $code)")
$ausgabe | ForEach-Object { Add-Content -Encoding utf8 $Protokoll "   $_" }

$neu = @($ausgabe | Where-Object { $_ -like 'NEU:*' })
$erinnerung = @($ausgabe | Where-Object { $_ -like 'ERINNERUNG:*' })
$gebucht = @($ausgabe | Where-Object { $_ -like 'GEBUCHT:*' })
if ($code -ne 0) { Melden 'Malachi Buchhaltung: Fehler' 'Siehe Malachi-Buchhaltung\aufgabe.log' }
elseif ($neu.Count) { Melden 'Malachi: neuer Bericht' (($neu | ForEach-Object { ($_ -replace '^NEU: ', '') -replace ' ->.*$', '' }) -join ', ') }
if ($erinnerung.Count -and $neu.Count) { Melden 'Malachi: Coins im Bestand' (($erinnerung | ForEach-Object { $_ -replace '^ERINNERUNG: ', '' }) -join '; ') }
if ($gebucht.Count) { Melden 'Malachi: Beleg gebucht' "$($gebucht.Count) Beleg(e) automatisch erfasst" }
exit $code
