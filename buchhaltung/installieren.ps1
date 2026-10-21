# Installiert die Malachi-Buchhaltung nach %USERPROFILE%\Malachi-Buchhaltung und richtet die
# taegliche Aufgabe "Malachi Buchhaltung" (12:30 Uhr) ein. Erneut ausfuehren = aktualisieren
# (Daten, Belege, Berichte und Einstellungen bleiben unberuehrt).
#
#   powershell -ExecutionPolicy Bypass -File buchhaltung\installieren.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$basis = Join-Path $env:USERPROFILE 'Malachi-Buchhaltung'
$programm = Join-Path $basis 'programm'
$node = (Get-Command node -ErrorAction Stop).Source

# Programm kopieren: buchhaltung (ohne Tests/node_modules) und die benoetigten Shop-Module
$zielBh = Join-Path $programm 'buchhaltung'
$zielShop = Join-Path $programm 'shop\src'
New-Item -ItemType Directory -Force $zielBh, $zielShop | Out-Null
Get-ChildItem $PSScriptRoot -Exclude 'node_modules', 'test' | Copy-Item -Destination $zielBh -Recurse -Force
Copy-Item (Join-Path $repo 'shop\src\*.js') $zielShop -Force
'{ "private": true, "type": "module" }' | Set-Content -Encoding ASCII (Join-Path $programm 'shop\package.json')
Push-Location $zielBh
try {
  & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci fehlgeschlagen ($LASTEXITCODE)" }
} finally { Pop-Location }

& $node (Join-Path $zielBh 'malachi-buchhaltung.mjs') einrichten
if ($LASTEXITCODE -ne 0) { throw 'einrichten fehlgeschlagen' }

$aufgabe = Join-Path $zielBh 'aufgabe.ps1'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$aufgabe`" -Node `"$node`""
$t = New-ScheduledTaskTrigger -Daily -At 12:30
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Malachi Buchhaltung' -Action $a -Trigger $t -Settings $s -Force `
  -Description 'Bucht eindeutig erkannte Belege aus Malachi-Buchhaltung\Belege\Eingang und erstellt nach Quartalsende den Quartalsbericht bzw. EUeR-Entwurf.' | Out-Null
Write-Host "Aufgabe 'Malachi Buchhaltung' eingerichtet (taeglich 12:30, Nachholen nach PC-Start)."

# Befehl 'mbuch' fuer die Konsole (Verknuepfung als .cmd im Datenordner)
$cmd = Join-Path $basis 'mbuch.cmd'
"@echo off`r`n`"$node`" `"$(Join-Path $zielBh 'malachi-buchhaltung.mjs')`" %*`r`n" | Set-Content -Encoding ASCII $cmd
Write-Host "Konsolenbefehl: $cmd  (z. B. `"$cmd belege`")"
