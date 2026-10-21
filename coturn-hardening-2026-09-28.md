# coturn-Härtung (Audit 2026-09-28) – manuell auf dem Server anwenden

**Warum:** `GET /turn-credentials` gibt jedem im Internet gültige TURN-Zugangsdaten
(ohne Konto, so ist die App gebaut). coturn blockiert von sich aus nur Loopback,
**private Netze aber nicht**. Wer die Zugangsdaten holt, kann den TURN-Server
dadurch als Sprungbrett ins Heimnetz benutzen, z. B. zur FritzBox-Oberfläche
192.168.178.1, zu SSH auf dem Server oder zu anderen Geräten im WLAN.

Ob die Live-Konfiguration das schon verhindert, ließ sich im Audit nicht
prüfen: `/etc/turnserver.conf` ist nur mit `sudo` lesbar.
`coturn-setup.sh` hat diese Zeilen bisher nicht erzeugt.

## 1. Prüfen

```bash
sudo grep -c denied-peer-ip /etc/turnserver.conf
```

`0` bedeutet: Die Lücke ist offen.

## 2. Anwenden

Die Zeilen unten ans Ende von `/etc/turnserver.conf` anhängen.
`192.168.178.130` ist die LAN-IP des Servers; sie bleibt erlaubt, damit
TURN-zu-TURN weiter funktioniert.

```
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
allowed-peer-ip=192.168.178.130
no-tcp-relay
user-quota=12
total-quota=1200
```

Danach neu starten und einen Anruf zwischen beiden Handys testen:

```bash
sudo systemctl restart coturn
```

**Achtung:** Das Skript `coturn-ipv6-update.sh` ersetzt nur die IPv6-Zeilen.
Die neuen Zeilen bleiben dabei unberührt.

## 3. Rückweg, falls Anrufe danach nicht mehr verbinden

Die Zeilen wieder entfernen und coturn neu starten. Bitte kurz Bescheid geben;
dann liegt die LAN-IP für die TURN-zu-TURN-Verbindung wahrscheinlich anders,
und `allowed-peer-ip` muss angepasst werden.
