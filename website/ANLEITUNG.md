# Malachi-Website – Anleitung

Die Website verteilt die Android-App (APK), erklärt Malachi und verlinkt den Onion-Shop. Sie läuft auf dem Debian-13-Laptop zu Hause (Hostname `malachi`, LAN `192.168.178.130`) – **gleichzeitig als Tor-Onion-Dienst (Hauptweg) und als normale HTTPS-Seite**, aus denselben Dateien. Außerdem liefert sie **signierte In-App-Updates** unter `/updates/` aus (Format: `UPDATE_FORMAT.md`).

Weitere Dokumente:
- `UPDATE_FORMAT.md` – Format und Prüfregeln der signierten Updates (Vertrag für die App)
- `../shop/ANLEITUNG.md` – der Onion-Shop für die Vollversion (läuft auf demselben Laptop)

---

## 0. Kurzfassung

1. Laptop als Server vorbereiten (Abschnitt 3).
2. Altes Relay und coturn stilllegen (Abschnitt 4).
3. FRITZ!Box: IPv6-Portfreigabe 80/443 für den Laptop (Abschnitt 5, Variante A) – nur für die Clearnet-Seite nötig.
4. Auf dem Laptop: `sudo DOMAIN=malachii.duckdns.org LE_AGB=ja bash deploy/install.sh` (Abschnitt 6).
5. Auf dem PC: Update-Signierschlüssel erzeugen, den öffentlichen Schlüssel in `website/seite.json` **und** `AppConfig.js` (`UPDATE_PUBLIC_KEYS`) eintragen, Rechtstexte ausfüllen (Abschnitte 8 und 12).
6. Auf dem PC: `website\werkzeuge\veroeffentlichen.ps1 -Hochladen` (Abschnitt 9).
7. Auf dem Laptop: `sudo malachi-web-pruefen` – und **Onion-Schlüssel sichern** (Abschnitt 10).

## 1. Aufbau

```
 Besucher mit Tor-Browser                      Besucher im normalen Internet (nur IPv6, s. Abschnitt 5)
        │ http://<website>.onion                          │ https://malachii.duckdns.org
        ▼                                                 ▼
 Tor-Netz ──► tor@default (Onion-Dienst malachi-web)   FRITZ!Box (IPv6-Freigabe 80/443)
                │ 127.0.0.1:8090 + PROXY-Zeile                │
                ▼                                             ▼
        nginx (Onion-Server, ohne TLS)          nginx (Clearnet-Server, TLS, HSTS, Onion-Location)
                └──────────────┬──────────────────────────────┘
                               ▼
                /var/www/malachi/aktuell  ──►  releases/<Version>/   (Besitzer malachi-web, nur lesbar)
                               ▲
                malachi-web-aktivieren (prüft Upload, schaltet atomar um)
                               ▲  scp + ssh (sudo)
 PC des Betreibers (Windows): APK bauen ─► veroeffentlichen.ps1 ─► Seite bauen, Manifest mit Ed25519 signieren
                              (APK-Signaturschlüssel und Update-Signierschlüssel bleiben NUR hier)
```

Der Onion-Shop (`../shop/`) läuft daneben mit eigenem Onion-Dienst (`/var/lib/tor/malachi-shop/`, Port 8085). Beide nutzen denselben Tor-Dienst.

| Datei im Repo | Wohin auf dem Laptop | Zweck |
|---|---|---|
| `site/` | (wird auf dem PC gebaut) | Quelltext der Seiten, `_teile/` = gemeinsame Kopf-/Fußteile |
| `seite.json` | – | öffentliche Angaben: Onion-Adressen, Fingerabdrücke, Update-Schlüssel, SSH-Ziel |
| `werkzeuge/veroeffentlichen.mjs`, `.ps1` | – | bauen, signieren, hochladen (PC) |
| `werkzeuge/update-schluessel.mjs` | – | Update-Signierschlüssel erzeugen/anzeigen, Manifest prüfen (PC) |
| `deploy/install.sh` | – | Installation (idempotent) |
| `deploy/aktivieren.sh` | `/usr/local/sbin/malachi-web-aktivieren` | Upload prüfen und freischalten |
| `deploy/pruefen.sh` | `/usr/local/sbin/malachi-web-pruefen` | Gesamtprüfung |
| `deploy/nginx/*` | `/etc/nginx/conf.d/`, `snippets/`, `sites-available/` | Onion- und Clearnet-Server |
| `deploy/torrc-malachi-web.conf` | `/etc/tor/torrc.d/malachi-web.conf` | Onion-Dienst der Website |
| `deploy/nftables.conf` | `/etc/nftables.conf` | Firewall |
| `deploy/duckdns/*` | `/usr/local/lib/malachi-web/`, `/etc/systemd/system/` | DuckDNS-IPv6-Aktualisierung |
| `deploy/certbot/*` | `/usr/local/lib/malachi-web/`, `/etc/letsencrypt/renewal-hooks/deploy/` | Let's Encrypt über DuckDNS-TXT |
| `deploy/52malachi-unattended-upgrades` | `/etc/apt/apt.conf.d/` | automatische Updates |
| `deploy/altes-relay-stilllegen.sh` | – | relay.js/coturn sichern und abschalten |
| `deploy/tunnel/*.beispiel` | – | Variante B (WireGuard-Tunnel über einen VPS) |

## 2. Voraussetzungen

**Laptop:** Debian 13 „trixie“, per LAN-Kabel an der FRITZ!Box (WLAN geht, ist aber unzuverlässiger), SSH-Zugang mit Schlüssel (`ssh -i ~/.ssh/malachi_relay malachiztrl@192.168.178.130`), `sudo`. Alle Pakete kommen aus Debian: `nginx`, `tor`, `certbot`, `nftables`, `jq`, `unattended-upgrades`.

**PC (Windows):**
- Node.js ≥ 18 (für React Native ohnehin vorhanden). Die Website-Werkzeuge haben **keine** npm-Abhängigkeiten.
- Android SDK Build-Tools (`apksigner`, `aapt2`; liegen nach einer Android-Studio-Installation unter `%LOCALAPPDATA%\Android\Sdk\build-tools\…` und werden automatisch gefunden) und Java (für `apksigner`).
- OpenSSH-Client von Windows (`ssh`, `scp`; Einstellungen → Apps → Optionale Features).

**Für die Clearnet-Seite:** ein DuckDNS-Konto mit Subdomain (bisher `malachii.duckdns.org`) und dessen Token.

## 3. Laptop als Server vorbereiten

Ein Laptop geht von sich aus schlafen. Einmalig auf dem Laptop:

```bash
# Deckel zuklappen = nichts tun
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' \
  | sudo tee /etc/systemd/logind.conf.d/malachi-server.conf
# Ruhezustand ganz abschalten (auch wenn eine Desktop-Umgebung es versucht)
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
# Uhrzeit muss stimmen (Tor und Zertifikate brauchen sie)
timedatectl            # "System clock synchronized: yes"
sudo reboot            # damit logind die neue Einstellung sicher übernimmt
```

Hinweise:
- Der Akku wirkt als kleine USV. Kann das BIOS die Ladung begrenzen (z. B. auf 80 %), schont das den Akku im Dauerbetrieb.
- **Festplattenverschlüsselung (LUKS):** Nach jedem Neustart wartet der Laptop auf die Passphrase – bis dahin sind Website und Shop offline. Deshalb starten automatische Updates den Rechner **nicht** selbst neu; `malachi-web-pruefen` meldet, wenn ein Neustart nötig ist.
- SSH nur mit Schlüssel: in `/etc/ssh/sshd_config.d/malachi.conf` `PasswordAuthentication no` setzen, dann `sudo systemctl reload ssh` (vorher prüfen, dass der Schlüssel-Login klappt). Die Firewall lässt SSH ohnehin nur aus dem Heimnetz zu.

## 4. Altes Relay und coturn stilllegen

Auf dem Laptop laufen noch `relay.js` (PM2, `/opt/malachi`, Port 443) und coturn. Die App braucht beide nicht mehr (serverlos über Tor), und nginx braucht Port 443. Das Skript sichert zuerst alles und löscht nichts.

1. Website-Dateien auf den Laptop bringen (PowerShell im Repo-Ordner; `git archive` liefert die eingecheckten Dateien mit LF-Zeilenenden):
   ```powershell
   git archive --format=tar -o website.tar HEAD website
   scp -i $HOME\.ssh\malachi_relay website.tar malachiztrl@192.168.178.130:~/
   ```
   Auf dem Laptop:
   ```bash
   rm -rf ~/malachi-website && mkdir ~/malachi-website
   tar -xf ~/website.tar -C ~/malachi-website --strip-components=1 && rm ~/website.tar
   cd ~/malachi-website
   ```
2. Probelauf – zeigt, was gefunden wurde und was passieren würde:
   ```bash
   sudo bash deploy/altes-relay-stilllegen.sh
   ```
3. Ausführen:
   ```bash
   sudo bash deploy/altes-relay-stilllegen.sh --ausfuehren
   ```
   - Sicherung: `/root/backups/malachi-opt-<Zeit>.tar.gz` (ganz `/opt/malachi`, inkl. `secrets.local.js`) und `/root/backups/malachi-alt-konfig-<Zeit>.tar.gz` (coturn-, TLS-, systemd- und ufw-Konfiguration, Crontabs, PM2-Liste). Beide werden auf Lesbarkeit geprüft, die SHA-256 wird angezeigt.
   - Danach: `pm2 delete malachi-relay && pm2 save`, coturn und `coturn-ipv6-update.timer` abgeschaltet.
   - Der **alte DuckDNS-Cronjob bleibt zunächst aktiv**, solange die neue DuckDNS-Aktualisierung noch nicht läuft – sonst würde der DNS-Eintrag veralten.
4. Sicherungen zusätzlich auf den PC holen (sie enthalten Geheimnisse – verschlüsselt aufbewahren):
   ```bash
   sudo sh -c 'install -o malachiztrl -m 600 /root/backups/malachi-opt-*.tar.gz /root/backups/malachi-alt-konfig-*.tar.gz ~malachiztrl/'
   ```
   ```powershell
   scp -i $HOME\.ssh\malachi_relay "malachiztrl@192.168.178.130:~/malachi-*.tar.gz" C:\SecureCommApp\Malachi-Backups\
   ```
   danach auf dem Laptop `rm ~/malachi-*.tar.gz`.
5. Website installieren (Abschnitt 6) – das richtet die neue DuckDNS-Aktualisierung ein.
6. Stilllegungsskript **noch einmal** mit `--ausfuehren` starten: Jetzt wird auch der alte DuckDNS-Cronjob auskommentiert.
7. In der FRITZ!Box alte Freigaben für coturn (3478, 5349, Relay-Portbereich) entfernen.
8. **Nach einigen Wochen** ohne Probleme endgültig aufräumen: `sudo apt-get purge coturn && sudo rm -rf /opt/malachi` (und ggf. `pm2 unstartup`, falls PM2 sonst nichts mehr verwaltet).

Rückweg, falls nötig: `sudo systemctl enable --now coturn`; als PM2-Nutzer `cd /opt/malachi && pm2 start ecosystem.config.js && pm2 save` (nie `pm2 start relay.js` direkt – dann fehlen die TLS-Variablen).

## 5. Erreichbarkeit von außen: IPv6, DS-Lite und die Varianten

**Ehrlich vorweg:** Der Heimanschluss hat keine nutzbare öffentliche IPv4-Adresse (DS-Lite/CGNAT). Von außen erreichbar ist der Laptop nur über **IPv6**. Die Clearnet-Seite von zu Hause erreichen deshalb nur Besucher mit IPv6 – das sind in Deutschland die meisten Mobilfunk- und viele Festnetzanschlüsse, aber längst nicht alle (manche Firmennetze, öffentliche WLANs, ältere Router). Die **Onion-Adresse funktioniert für alle**, die Tor nutzen, unabhängig davon – sie braucht keinen offenen Port.

### Variante A – IPv6 direkt (Standard, kostenlos)

FRITZ!Box (Menünamen je nach FRITZ!OS leicht anders):
1. *Internet → Freigaben → Portfreigaben → Gerät für Freigaben hinzufügen* → Gerät **malachi** wählen.
2. *Neue Freigabe → Portfreigabe*: Anwendung „HTTPS-Server“, Protokoll TCP, Port 443, **„Freigabe aktivieren für IPv6“** anhaken (IPv4 bleibt aus – bei DS-Lite wirkungslos).
3. Dasselbe für „HTTP-Server“, TCP-Port 80 (für die Weiterleitung auf HTTPS und – nur bei `ZERTIFIKAT=http01` – für die Zertifikatsprüfung).
4. Bei der IPv6-Freigabe zeigt die FRITZ!Box die **Interface-ID** des Laptops. Sie muss zur stabilen Adresse des Laptops passen: `ip -6 addr show scope global` – die Adresse **ohne** `temporary`. Ändert sich die Interface-ID mit jedem neuen Präfix (NetworkManager-Standard „stable-privacy“), auf EUI-64 umstellen: `nmcli connection modify "<Verbindungsname>" ipv6.addr-gen-mode eui64`, Verbindung neu aufbauen, Freigabe anpassen. Hat die Freigabe für das alte Relay funktioniert, einfach dieselbe Einstellung weiterverwenden.
5. DuckDNS: Der Name darf **nur einen AAAA-Eintrag** haben, keinen A-Eintrag (eine CGNAT-IPv4 ist für Besucher eine Sackgasse). Die neue Aktualisierung (`malachi-duckdns.timer`) sendet deshalb `ip=` leer und fragt nur über IPv6. Ein alter A-Eintrag lässt sich auf duckdns.org löschen. `malachi-web-pruefen` warnt, wenn einer existiert.

| Vorteile | Nachteile |
|---|---|
| kostenlos, kein Dritter im Weg | nur für IPv6-Besucher erreichbar |
| TLS und Daten nur auf dem Laptop | jeder Besucher (und jeder Scanner) sieht die IPv6-Adresse des Heimanschlusses → Anbieter und grobe Region erkennbar |
| einfach | Last und Angriffe (DoS) treffen direkt den Heimanschluss |
| | ändert der Provider das Präfix, ist die Seite bis zur nächsten DuckDNS-Aktualisierung (≤ 5 min + DNS-Cache) nicht erreichbar |

### Variante B – kleiner Tunnel über einen VPS (IPv4 + IPv6)

Der Laptop baut von innen einen WireGuard-Tunnel zu einem kleinen Server mit öffentlicher IPv4/IPv6 auf (z. B. ein günstiger VPS oder der vorhandene Hetzner-Server). Der VPS reicht nur TCP 443/80 an den Laptop durch – **TLS endet auf dem Laptop**, der VPS sieht keine Inhalte und speichert nichts. Es liegen nur statische Dateien auf dem Laptop, keine Nutzerdaten.

| Vorteile | Nachteile |
|---|---|
| erreichbar über IPv4 **und** IPv6 | kostet (ein paar Euro im Monat) bzw. koppelt die Website an den Hetzner-Server, der für Coachbay frei werden soll |
| Besucher sehen die IP des VPS, nicht die des Heimanschlusses | der VPS-Betreiber sieht die IP-Adressen der Besucher und Zeitpunkt/Menge der Zugriffe (nicht die Inhalte) |
| keine Portfreigabe in der FRITZ!Box nötig | ein Teil mehr, der gewartet und abgesichert werden muss |
| DoS trifft zuerst den VPS | Wer den VPS übernimmt, kann Besucher umleiten und – weil der Name auf den VPS zeigt – per HTTP-01 sogar ein eigenes Zertifikat bekommen. DNS-01 (Token nur auf dem Laptop) verhindert das nicht vollständig. Die Onion-Adresse ist davon nicht betroffen. |

Einrichtung (Beispieldateien in `deploy/tunnel/`):
1. WireGuard auf VPS und Laptop: `wg-vps.conf.beispiel`, `wg-laptop.conf.beispiel` (Schlüssel auf jedem Rechner selbst erzeugen).
2. VPS: `vps-nginx-stream.conf.beispiel` – reine TCP-Weiterleitung mit PROXY-Protokoll.
3. Laptop, `/etc/nginx/sites-available/malachi-web-clearnet` (wird von `install.sh` neu geschrieben – die Zeilen nach jedem `install.sh`-Lauf wieder ergänzen oder die Vorlage `deploy/nginx/malachi-web-clearnet.conf` anpassen):
   - im Port-80-Server zusätzlich `listen 8080 proxy_protocol;`
   - im Port-443-Server zusätzlich `listen 8443 ssl proxy_protocol;`
   
   (Auf allen Adressen lauschen, nicht auf `10.66.0.2` – sonst startet nginx beim Booten nicht, solange der Tunnel noch fehlt.)
4. Laptop-Firewall `/etc/nftables.conf`, in `chain input` ergänzen: `iifname "wg-malachi" tcp dport { 8080, 8443 } accept` – die Ports sind damit nur aus dem Tunnel erreichbar.
5. DNS: Der Name zeigt jetzt auf den VPS (A **und** AAAA des VPS, auf duckdns.org von Hand eintragen). Auf dem Laptop `DUCKDNS_UPDATER=0` setzen (`sudo DUCKDNS_UPDATER=0 bash deploy/install.sh`), sonst überschreibt der Laptop den Eintrag. Die FRITZ!Box-Freigaben aus Variante A entfernen.
6. Zertifikat: `ZERTIFIKAT=dns01` (empfohlen) funktioniert unverändert.

### Variante C – nur Onion

`DOMAIN` leer lassen: kein offener Port, keine Heim-IP sichtbar, kein Zertifikat nötig. Für die meisten Ziele dieses Projekts die privateste Lösung; dann findet nur, wer Tor nutzt.

**Empfehlung:** Mit Onion + Variante A anfangen (kostet nichts). Variante B nur, wenn IPv4-Besucher wichtig werden.

## 6. Installation auf dem Laptop

Dateien wie in Abschnitt 4, Schritt 1 nach `~/malachi-website` bringen. Dann:

```bash
cd ~/malachi-website
# Onion + Clearnet mit Zertifikat per DNS-01 (DuckDNS-TXT, kein offener Port 80 nötig):
sudo DOMAIN=malachii.duckdns.org LE_EMAIL="${LE_EMAIL}" LE_AGB=ja bash deploy/install.sh
```

- `LE_EMAIL` ist ein Platzhalter: deine E-Mail-Adresse **nur** für die Let's-Encrypt-Registrierung (z. B. `export LE_EMAIL=…` vorher). Leer lassen geht auch (Registrierung ohne E-Mail; Let's Encrypt verschickt ohnehin keine Ablauf-Mails mehr).
- `LE_AGB=ja` bestätigt, dass du die Nutzungsbedingungen von Let's Encrypt (letsencrypt.org/repository) gelesen hast und ihnen zustimmst. Ohne das holt das Skript kein Zertifikat; die Onion-Seite läuft trotzdem.
- Zum ersten Ausprobieren `LE_TEST=1` dazunehmen (Test-Zertifikat, keine Ratenlimits); danach das Test-Zertifikat löschen (`sudo certbot delete --cert-name malachi-web`) und ohne `LE_TEST` neu ausführen.
- Der DuckDNS-Token wird verdeckt abgefragt (oder `DUCKDNS_TOKEN_DATEI=/pfad`) und landet in `/etc/malachi-web/duckdns.token` (root, 0600).
- Ist `ufw` noch aktiv (vom alten coturn-Setup), bricht die Firewall-Einrichtung mit einem Hinweis ab. Mit `UFW_ABLOESEN=1` werden die ufw-Regeln nach `/root/backups/` gesichert, ufw abgeschaltet und durch nftables ersetzt.
- Nur Onion: `sudo bash deploy/install.sh` (ohne `DOMAIN`).
- Weitere Einstellungen stehen oben in `deploy/install.sh`. Alle Werte werden in `/etc/malachi-web/web.env` gemerkt; ein späterer Lauf ohne Variablen nutzt sie wieder.

Was das Skript tut:
1. Prüft das System (Debian 13), dass Port 80/443/8090 frei sind (sonst Verweis auf Abschnitt 4).
2. Installiert die Pakete aus Debian, legt den Systemnutzer `malachi-web` an, nimmt deinen SSH-Nutzer in dessen Gruppe auf (für Uploads; gilt ab der nächsten Anmeldung).
3. Legt `/var/www/malachi/` mit einer Platzhalter-Seite an, `/var/lib/malachi-web/eingang/` (Uploads) und `/var/lib/malachi-web/acme/`.
4. Richtet den Onion-Dienst `/var/lib/tor/malachi-web/` ein (PoW-Schutz, wenn Tor ihn mitbringt) und **gibt die Onion-Adresse aus**.
5. Richtet nginx ein (Onion-Server auf `127.0.0.1:8090`, Clearnet auf 80/443, Auffang-Server für fremde Namen), entfernt Debians Beispielseite.
6. Holt das Zertifikat (`certbot`, DNS-01 über DuckDNS-TXT oder HTTP-01), schaltet danach HTTPS frei; Verlängerung über `certbot.timer`, nginx wird danach automatisch neu geladen.
7. Richtet `malachi-duckdns.timer` ein (stabile IPv6 alle 5 min prüfen, nur bei Änderung melden).
8. Setzt die Firewall (nftables): SSH nur aus `192.168.178.0/24` und link-lokal/ULA-IPv6, 80/443 offen, alles andere eingehend verworfen; ICMPv6 für die IPv6-Grundfunktionen bleibt erlaubt. Kommt deine SSH-Sitzung nicht aus dem Heimnetz, wird die Firewall zur Sicherheit **nicht** gesetzt.
9. Schaltet `unattended-upgrades` ein (Sicherheitsupdates + Debian-Punktversionen, ohne automatischen Neustart).

Danach:
- Onion-Adresse in `website/seite.json` → `"onionAdresse"` eintragen (auf dem PC).
- **Onion-Schlüssel sichern** (Abschnitt 10).
- `sudo malachi-web-pruefen` (oder `--tor`, um die Onion-Adresse über das Tor-Netz abzurufen).

### Let's Encrypt: DNS-01 oder HTTP-01?

| | DNS-01 (Standard) | HTTP-01 |
|---|---|---|
| Wie | certbot setzt über die DuckDNS-API einen TXT-Eintrag (`deploy/certbot/duckdns-auth.sh`) | Let's Encrypt ruft `http://<name>/.well-known/acme-challenge/…` ab (`/var/lib/malachi-web/acme`) |
| Offener Port nötig | nein | Port 80 per IPv6 (Let's Encrypt prüft auch über IPv6) |
| Braucht | DuckDNS-Token auf dem Laptop | Portfreigabe 80 |
| Geeignet | Variante A und B, auch wenn Port 80 zu ist | Variante A mit Freigabe 80, Variante B |

Werkzeug: `certbot` aus Debian mit den eigenen DuckDNS-Hooks (keine Fremdquellen; acme.sh/lego wären nur über zusätzliche Installationswege zu haben). DuckDNS kann nur einen TXT-Wert gleichzeitig – deshalb gibt es ein Zertifikat für genau den einen Namen.

## 7. Onion und Clearnet aus denselben Dateien

Beide nginx-Server binden dieselbe Datei `snippets/malachi-web-orte.conf` ein und liefern `/var/www/malachi/aktuell` aus. Unterschiede:

| | Onion (`127.0.0.1:8090`) | Clearnet (`:443`) |
|---|---|---|
| Verschlüsselung | Tor (Ende-zu-Ende, Adresse = Schlüssel) | TLS 1.2/1.3, Let's Encrypt, hybrider PQ-Schlüsseltausch X25519MLKEM768 (OpenSSL 3.5) |
| HSTS | nein | `max-age=31536000` |
| `Onion-Location` | nein | `http://<onion>/…` – der Tor-Browser bietet die Onion-Adresse an |
| Ratenbegrenzung je | Tor-Circuit (`HiddenServiceExportCircuitID haproxy` → PROXY-Protokoll) | IP-Adresse |
| Zugriffsprotokoll | aus | aus |

Gemeinsam: strenge CSP (`default-src 'none'; style-src 'self'; img-src 'self'; …; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (alles aus), `server_tokens off`, nur GET/HEAD, Fehlerprotokoll nur `crit`, `.apk` als `application/vnd.android.package-archive`, Downloads je Gegenstelle auf 2 gleichzeitige Verbindungen, insgesamt 20 je Weg und 1 MB/s je Verbindung begrenzt. Die Seiten selbst enthalten kein JavaScript, keine Inline-Styles, keine fremden Ressourcen und keine Cookies – das prüft das Bauwerkzeug bei jedem Lauf. Sie funktionieren im Tor-Browser in der Stufe „Am sichersten“ (dort wird nur das SVG-Logo nicht angezeigt).

## 8. Einmalig auf dem PC: Schlüssel und Angaben

### 8.1 Update-Signierschlüssel (Ed25519, bleibt offline)

```powershell
node website\werkzeuge\update-schluessel.mjs erzeugen
```
- Fragt zweimal eine Passphrase ab (mindestens 12 Zeichen; besser 5–6 zufällige Wörter) und schreibt `C:\Users\<du>\.malachi\update-signierschluessel.json` (verschlüsselt: scrypt + AES-256-GCM). Sie wird nie überschrieben.
- Gibt den **öffentlichen** Schlüssel aus → in `website/seite.json` bei `"updateSchluessel"` eintragen, auf dem Laptop hinterlegen (`sudo UPDATE_SCHLUESSEL=<wert> bash deploy/install.sh` – dann aktiviert der Laptop nur korrekt signierte Uploads) und in die App einbauen (Abschnitt 8.4).
- Empfehlung: Datei auf einen verschlüsselten USB-Stick verschieben und nur zum Veröffentlichen einstecken (`-Schluessel E:\update-signierschluessel.json`); eine zweite Kopie an einem anderen Ort, die Passphrase getrennt auf Papier. **Nie auf den Laptop kopieren.**

### 8.2 Fingerabdruck des APK-Signaturzertifikats

Beim ersten `veroeffentlichen`-Lauf mit einer Release-APK misst das Werkzeug den Fingerabdruck und bricht mit dem Wert ab. Vergleiche ihn mit deinem Release-Keystore:
```powershell
keytool -list -v -keystore android\app\<dein-release.keystore>   # Zeile "SHA256:"
```
und trage ihn bei `"apkZertifikatSha256"` ein. Ab dann bricht jede Veröffentlichung ab, wenn eine APK mit einem anderen Schlüssel signiert ist – zum Beispiel, wenn `keystore.properties` beim Bauen fehlte und Gradle still den Debug-Schlüssel genommen hat. Debug-signierte APKs werden immer abgelehnt.

### 8.3 `website/seite.json`

| Feld | Inhalt |
|---|---|
| `onionAdresse` | Onion-Adresse der **Website** (Ausgabe von `install.sh`) |
| `shopOnion` | Onion-Adresse des **Shops** (Ausgabe von `shop/deploy/install.sh`); leer = „Shop geht in Kürze online“ |
| `applicationId` | `com.securecommapp` |
| `apkZertifikatSha256` | siehe 8.2 |
| `updateSchluessel` | siehe 8.1 |
| `minSupportedVersionCode` | älteste noch unterstützte App-Version (siehe `UPDATE_FORMAT.md`) |
| `abis` | welche APKs veröffentlicht werden (Standard: arm64-v8a, armeabi-v7a, x86_64) |
| `hochladen.*` | SSH-Ziel (`malachiztrl@192.168.178.130`), SSH-Schlüssel (`~/.ssh/malachi_relay`) – nur Standardwerte, per `-SshZiel`/`-SshSchluessel` änderbar |

Die Datei enthält nur öffentliche Angaben und darf ins Repo.

### 8.4 Update-Schlüssel in die App einbauen (In-App-Updates der Web-Version)

Die Web-Version der App sucht über ihren eigenen Tor nach Updates, prüft sie gegen den eingebauten Schlüssel und übergibt sie nach Bestätigung an den Android-Installer (Ablauf: `UPDATE_FORMAT.md`, Abschnitt 9). Solange kein Schlüssel eingebaut ist, steht in den Einstellungen „Updates werden eingerichtet“ und die App fragt nichts ab.

1. Schlüssel erzeugen wie in 8.1 (`node website/werkzeuge/update-schluessel.mjs erzeugen`, nur auf dem eigenen PC). Später erneut anzeigen: `node website/werkzeuge/update-schluessel.mjs anzeigen`.
2. Den ausgegebenen **öffentlichen** Schlüssel (base64url, 43 Zeichen) an zwei Stellen eintragen:
   - `AppConfig.js`: `export const UPDATE_PUBLIC_KEYS = ['<schlüssel>'];` (das Werkzeug gibt die Zeile fertig aus),
   - `website/seite.json`: `"updateSchluessel": "<schlüssel>"`.
3. Prüfen, dass `UPDATE_ONION` in `AppConfig.js` gleich `"onionAdresse"` in `website/seite.json` ist (Onion-Adresse der **Website**, nicht des Shops). `UPDATE_PATH` bleibt `'/updates/'`.
4. `versionCode`/`versionName` in `android/app/build.gradle` erhöhen, Release-APK bauen und wie in Abschnitt 9 veröffentlichen.
5. Wichtig: Erst **ab der ersten App-Version mit eingebautem Schlüssel** gibt es In-App-Updates. Diese Version müssen Nutzer einmal von Hand über die Website installieren; danach kommt jedes weitere Update über die App (automatisch gefunden innerhalb von etwa 24–30 Stunden, sofort mit „Jetzt prüfen“).

Nur die Web-Version aktualisiert sich selbst. Die Play-Version (eigener Flavor) tut es nie – Google Play verbietet das; `REQUEST_INSTALL_PACKAGES` gehört dort nicht ins Manifest (siehe Kommentar in `android/app/src/main/AndroidManifest.xml`).

## 9. Neue Version veröffentlichen

1. **Release-APK der Website-Variante bauen** (mit `android/keystore.properties`): `cd android; .\gradlew assembleWebRelease`. Ergebnis: `android/app/build/outputs/apk/web/release/app-web-<abi>-release.apk`. Nie die Play-Variante (`bundlePlayRelease`, eigene App-ID und eigener Schlüssel, siehe `PLAY_STORE.md`) auf die Website stellen – das Werkzeug lehnt sie an App-ID und Zertifikat ab. `versionCode`/`versionName` in `android/app/build.gradle` vorher erhöhen.
2. **Versionshinweise** schreiben: `website/versionshinweise/<versionName>.txt` (Format: `versionshinweise/vorlage.txt`).
3. **Vorschau** (nichts wird signiert oder hochgeladen):
   ```powershell
   powershell -ExecutionPolicy Bypass -File website\werkzeuge\veroeffentlichen.ps1 -Entwurf -Vorschau
   ```
4. **Veröffentlichen:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File website\werkzeuge\veroeffentlichen.ps1 -Hochladen
   ```
   Das Werkzeug
   - liest Version und Paketnamen aus den APKs (`aapt2`) und prüft die Signatur jeder APK (`apksigner`) gegen `apkZertifikatSha256`,
   - kopiert die APKs als `updates/malachi-<version>-<abi>.apk`, berechnet Größe und SHA-256,
   - schreibt `updates/manifest.json`, fragt die Passphrase ab und signiert das Manifest (`manifest.json.sig`), prüft die Signatur sofort gegen,
   - schreibt `updates/SHA256SUMS` und `updates/update-schluessel.pem`,
   - baut alle Seiten (Version, Größe, SHA-256, Fingerabdrücke, Versionshinweise werden eingesetzt) und bricht ab, solange irgendwo `[BITTE AUSFUELLEN …]` steht,
   - lädt per `scp` nach `/var/lib/malachi-web/eingang/<Zeit>-<Version>` hoch und ruft per `ssh -t … sudo malachi-web-aktivieren` die Aktivierung auf (dein sudo-Passwort auf dem Laptop wird abgefragt).
5. `malachi-web-aktivieren` prüft den Upload (keine Links/Sonderdateien, nur erlaubte Dateitypen, Pflichtdateien, Größe ≤ 2 GB, `SHA256SUMS`, jede APK gegen das Manifest, **Signatur des Manifests**, kein Rückschritt hinter die aktive `versionCode`), kopiert ihn nach `/var/www/malachi/releases/<Name>` (Besitzer `malachi-web`, für nginx nur lesbar) und schaltet den Symlink `aktuell` in einem Schritt um. Die letzten 3 Versionen bleiben liegen.
6. Prüfen: `sudo malachi-web-pruefen`. Zurück zur vorherigen Version: `sudo malachi-web-aktivieren --zurueck`; Übersicht: `sudo malachi-web-aktivieren --liste`.

Nur Texte geändert? Genauso veröffentlichen (mit denselben APKs); das Manifest wird dabei neu signiert, `versionCode` bleibt gleich.

Was danach in der App passiert: Installierte Web-Versionen mit eingebautem Schlüssel (8.4) finden das Update beim nächsten automatischen Abruf (höchstens einmal je 24 h plus Zufall) oder sofort über Einstellungen → „Jetzt prüfen“. Die App zeigt einen kleinen Hinweis auf der Startseite („Malachi 1.1 ist da – Was ist neu“), lädt die APK erst, wenn der Nutzer „Über Tor herunterladen“ antippt, und übergibt sie nach allen Prüfungen an den Android-Installer. Eine höhere `minSupportedVersionCode` (Option `--min-version-code` bzw. `seite.json`) lässt ältere Installationen „Dieses Update ist wichtig“ anzeigen.

Ohne PowerShell (Git Bash/Linux): `node website/werkzeuge/veroeffentlichen.mjs --hilfe`.

## 10. Sicherungen

| Was | Wo | Warum |
|---|---|---|
| **Onion-Schlüssel der Website** | Laptop `/var/lib/tor/malachi-web/` | Geht er verloren, gibt es eine **neue Onion-Adresse** – alle Links, Lesezeichen und die Adresse in der App stimmen nicht mehr. |
| Onion-Schlüssel und Lizenzschlüssel des Shops | siehe `../shop/ANLEITUNG.md`, Abschnitt 7 | |
| **Update-Signierschlüssel** + Passphrase | nur PC/USB-Stick | ohne ihn keine signierten Updates mehr (`UPDATE_FORMAT.md`, Abschnitt 7) |
| **APK-Release-Keystore** + Passwörter | nur PC | ohne ihn kann niemand mehr ein Update installieren, das Android annimmt |
| `/etc/malachi-web/` | Laptop | Einstellungen, DuckDNS-Token (lässt sich neu erzeugen) |
| Zertifikate `/etc/letsencrypt/` | Laptop | nicht nötig – werden neu ausgestellt |

Onion-Schlüssel (Website und Shop zusammen) sichern – verschlüsselt, dann vom Laptop holen und dort löschen:
```bash
sudo tar -C / -czf /root/malachi-onion-schluessel.tgz var/lib/tor/malachi-web var/lib/tor/malachi-shop
sudo gpg --symmetric --cipher-algo AES256 -o /root/malachi-onion-schluessel.tgz.gpg /root/malachi-onion-schluessel.tgz
sudo shred -u /root/malachi-onion-schluessel.tgz
sudo install -o malachiztrl -m 600 /root/malachi-onion-schluessel.tgz.gpg ~/ && sudo rm /root/malachi-onion-schluessel.tgz.gpg
```
```powershell
scp -i $HOME\.ssh\malachi_relay malachiztrl@192.168.178.130:~/malachi-onion-schluessel.tgz.gpg C:\SecureCommApp\Malachi-Backups\
```
und auf dem Laptop `rm ~/malachi-onion-schluessel.tgz.gpg`. (Gibt es den Shop noch nicht, `var/lib/tor/malachi-shop` weglassen.)

Wiederherstellen (z. B. neuer Laptop): `sudo systemctl stop tor`, Ordner nach `/var/lib/tor/malachi-web/` zurückspielen, `sudo chown -R debian-tor:debian-tor /var/lib/tor/malachi-web && sudo chmod 700 /var/lib/tor/malachi-web && sudo chmod 600 /var/lib/tor/malachi-web/*`, `sudo systemctl start tor` – **bevor** `install.sh` läuft, sonst erzeugt Tor einen neuen Schlüssel.

## 11. Bedrohungsmodell

**Was auf dem Laptop liegt:** öffentliche Website-Dateien und APKs; die Onion-Schlüssel von Website und Shop; der TLS-Schlüssel; der DuckDNS-Token; beim Shop zusätzlich der **Lizenz-Signierschlüssel**, das View-only-Wallet, Bestellungen und Buchhaltung.
**Was nie auf dem Laptop liegt:** APK-Release-Keystore, Update-Signierschlüssel, Wallet-Seed/Spend-Key.

1. **Heim-IP bei der Clearnet-Seite (Variante A):** Jeder Besucher und jeder Scanner sieht die IPv6-Adresse des Heimanschlusses (Anbieter, grobe Region). Angriffe auf die Seite treffen den Heimanschluss. Die Onion-Adresse verrät nichts davon. Wer das nicht will: Variante B oder C. Da das Impressum Name und Anschrift ohnehin nennt, geht es hier weniger um Anonymität des Betreibers als um Angriffsfläche und Verfügbarkeit.
2. **Zuordnung Onion ↔ Clearnet:** `Onion-Location` verknüpft beide Adressen absichtlich. Liegen auch die Onion-Adresse des Shops und die Clearnet-Seite auf demselben Rechner, lässt sich das über gleichzeitige Ausfälle zuordnen. Das betrifft den (ohnehin bekannten) Betreiber, nicht die Anonymität der Käufer.
3. **Übernahme des Laptops** (z. B. über eine Lücke in nginx, Tor oder SSH): Ein Angreifer könnte
   - die Website verändern und **neuen** Nutzern eine manipulierte APK unterschieben (samt passender Prüfsummen auf der Seite). **Bestehende** Installationen sind geschützt: Android installiert kein Update mit fremdem Signaturschlüssel, und die App prüft das Manifest gegen den eingebauten Update-Schlüssel. Gegenmittel für neue Nutzer: den Zertifikats-Fingerabdruck zusätzlich über einen unabhängigen Weg veröffentlichen (z. B. im Shop, in Beiträgen, auf Papier) und beim Vergleich auf zwei Wege hinweisen (macht die Download-Seite).
   - mit dem **Lizenz-Signierschlüssel des Shops beliebige Vollversion-Lizenzen erzeugen** (Umsatzverlust, keine Gefahr für die Sicherheit der Nutzer), Bestellungen und Zahlungseingänge lesen und die Onion-Adressen übernehmen.
   
   Gegenmaßnahmen, nach Wirkung sortiert:
   - **Shop und öffentlich erreichbare Clearnet-Seite trennen:** Die Clearnet-Seite öffnet Port 443 ins Internet und vergrößert die Angriffsfläche. Am besten läuft der Shop auf einem anderen Rechner (oder zumindest in einer eigenen VM) – oder die Website auf diesem Laptop bleibt „nur Onion“ (Variante C).
   - **Schlüsselwechsel vorbereiten:** Die App kann mehrere Lizenzschlüssel kennen (`LICENSE_PUBLIC_KEY` als Liste). Bei Verdacht: neuen Schlüssel erzeugen, App-Update mit nur dem neuen Schlüssel, bezahlte Lizenzen über „Umzug“ neu ausstellen (Bestellungen liegen im Shop).
   - Angriffsfläche klein halten: nur statische Dateien, kein PHP/CGI, nur GET/HEAD; Firewall (nur 80/443 + SSH aus dem LAN); SSH nur mit Schlüssel; automatische Sicherheitsupdates; regelmäßig `sudo malachi-web-pruefen` und `sudo bash /opt/malachi-shop/deploy/pruefen.sh`.
   - Festplattenverschlüsselung schützt bei Diebstahl des ausgeschalteten Laptops, nicht bei einer Übernahme im Betrieb.
4. **Hochladen:** Wer den SSH-Schlüssel des PCs **und** das sudo-Passwort hat, kann Website-Inhalte austauschen. Mit hinterlegtem Update-Schlüssel (`UPDATE_SCHLUESSEL`) aktiviert der Laptop aber nur korrekt signierte Uploads – ein gestohlener SSH-Schlüssel allein reicht dann nicht für eine gefälschte Versionsliste.
5. **Was der Server über Besucher speichert:** keine Zugriffsprotokolle; IP-Adressen nur kurz im Arbeitsspeicher (Ratenbegrenzung); Fehlerprotokoll nur bei schweren Fehlern (`crit`), 14 Tage. Über Tor sieht der Server keine IP-Adressen.

## 12. Was du eintragen bzw. entscheiden musst

- [ ] **Rechtstexte** in `website/site/impressum.html`, `datenschutz.html`, `widerruf.html`: alle `[BITTE AUSFUELLEN: …]` ersetzen, rechtlich prüfen lassen (siehe `../RECHT_KRYPTOZAHLUNG.md`), Hinweiskästen entfernen. Vorher lässt sich nichts veröffentlichen (außer zum Testen mit `-PlatzhalterErlauben`). Wer Name/Anschrift nicht im Repo haben will, trägt sie nur lokal ein und committet diese Änderungen nicht.
- [ ] `website/seite.json`: `onionAdresse`, `shopOnion`, `apkZertifikatSha256`, `updateSchluessel` (Abschnitt 8).
- [ ] `DOMAIN` (Clearnet-Name) und Variante A/B/C (Abschnitt 5). Prüfen, wohin `malachii.duckdns.org` gerade zeigt (`nslookup malachii.duckdns.org`) – zeigt der Name noch auf den Hetzner-Server, dort erst abbauen oder einen neuen DuckDNS-Namen nehmen.
- [ ] `LE_EMAIL` (optional, nur für Let's Encrypt) und `LE_AGB=ja` (Zustimmung zu den Let's-Encrypt-Bedingungen).
- [ ] DuckDNS-Token bereithalten.
- [ ] FRITZ!Box: IPv6-Freigaben 80/443 für den Laptop, alte coturn-Freigaben entfernen.
- [ ] Versionshinweise je Version (`website/versionshinweise/<version>.txt`).
- [ ] **Aussagen auf der Website gegen die veröffentlichte App prüfen:**
  - „Entschlüsseln ist kostenlos“ (Siegel-Modus, Startseite/FAQ/Vollversion): Im aktuellen Code (`App.tsx`, `openSiegel`) ist der ganze Siegel-Modus – auch das Öffnen – an die Vollversion gebunden. Entweder die App anpassen oder die Sätze ändern.
  - „Monero oder Bitcoin“: Bitcoin ist im Shop optional (`zahlungswege.btc.aktiv`, Standard aus).
  - „Malachi wurde bisher nicht von einer unabhängigen Stelle geprüft“ – aktuell halten.
  - Die App enthält noch das Firebase-Cloud-Messaging-SDK (`google-services.json`, `MalachiFirebaseMessagingService`), das beim Start Verbindungen zu Google aufbauen kann. Die Website behauptet deshalb bewusst nichts über „keine Google-Dienste“; die Datenschutzerklärung hat dafür einen Platzhalter. Empfehlung: SDK entfernen oder Auto-Init abschalten.
- [ ] In-App-Updates: öffentlichen Update-Schlüssel in `AppConfig.js` (`UPDATE_PUBLIC_KEYS`) eintragen und `UPDATE_ONION` mit `onionAdresse` vergleichen (Abschnitt 8.4). Die App-Seite ist gebaut (`AppUpdater.js`, `UpdateUI.tsx`, `MalachiUpdaterModule.kt`); beim Play-Flavor `REQUEST_INSTALL_PACKAGES` und das Updater-Modul nur in den Web-Flavor.

## 13. Betrieb und Fehlersuche

| Aufgabe | Befehl (Laptop) |
|---|---|
| Gesamtprüfung | `sudo malachi-web-pruefen` (mit `--tor` zusätzlich über das Tor-Netz) |
| Versionen / zurück | `sudo malachi-web-aktivieren --liste` · `sudo malachi-web-aktivieren --zurueck` |
| Onion-Adresse | `sudo cat /var/lib/tor/malachi-web/hostname` |
| Protokolle | `journalctl -u nginx -u tor@default -u malachi-duckdns` · `/var/log/nginx/malachi-web-fehler.log` |
| Zertifikat testen | `sudo certbot renew --dry-run` |
| Firewall ansehen | `sudo nft list ruleset` |
| Einstellungen ändern | `sudo VARIABLE=wert bash ~/malachi-website/deploy/install.sh` |
| Skripte aktualisieren | neue Dateien wie in Abschnitt 4, Schritt 1, dann `sudo bash deploy/install.sh` |

- **„Port 80/443 belegt“ bei `install.sh`:** relay.js läuft noch → Abschnitt 4.
- **Onion-Adresse nicht erreichbar:** `systemctl status tor@default`, Uhrzeit (`timedatectl`), `journalctl -u tor@default`. Der erste Start kann einige Minuten dauern.
- **Clearnet von außen nicht erreichbar, lokal schon:** am Handy im Mobilfunknetz (WLAN aus) testen; FRITZ!Box-Freigabe (IPv6 angehakt? richtige Interface-ID?); `getent ahostsv6 <name>` = Adresse des Laptops? Kein A-Eintrag? Das Handy im eigenen WLAN hat manchmal keine IPv6-Standardroute (WLAN aus/an).
- **Zertifikat schlägt fehl (DNS-01):** Token richtig? `DUCKDNS_WARTEZEIT=120` setzen, falls DuckDNS langsam ist. Log: `/var/log/letsencrypt/letsencrypt.log`.
- **Upload: „Permission denied“ in `/var/lib/malachi-web/eingang`:** Der SSH-Nutzer ist erst nach einer neuen Anmeldung in der Gruppe `malachi-web` – einmal ab- und wieder anmelden.
- **Upload: „Signatur des Manifests UNGUELTIG“:** Schlüsseldatei passt nicht zu `/etc/malachi-web/update-schluessel.b64u` – `node website/werkzeuge/update-schluessel.mjs anzeigen` vergleichen.
- **Firewall hat ausgesperrt:** Am Laptop direkt anmelden, `sudo nft flush ruleset` (öffnet alles bis zum nächsten Neustart), `LAN_V4`/`LAN_V6` korrigieren, `install.sh` erneut.
- **fail2ban oder andere Firewall-Werkzeuge:** `/etc/nftables.conf` beginnt mit `flush ruleset` und entfernt beim Laden auch deren Regeln – danach z. B. `sudo systemctl restart fail2ban`.
- **Tests der Werkzeuge** (PC): `cd website; npm test` (keine Abhängigkeiten nötig; mit `node_modules` im Repo- oder Shop-Ordner wird zusätzlich gegen `@noble/curves` geprüft, wie es die App tut).
