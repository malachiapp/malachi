# Malachi Onion-Shop – Anleitung

Kleiner, eigenständiger Shop als **Tor-Onion-Dienst**, über den die **Vollversion** von Malachi (einmalig 2,99 €) gekauft wird. Die App bleibt kostenlos; der Shop verkauft einen **signierten, gerätegebundenen Lizenznachweis**, den die App offline prüft. Bezahlt wird mit **Monero (XMR)** über ein **View-only-Wallet** und/oder mit **Bitcoin (BTC, on-chain)** über einen **Watch-only-Kontoschlüssel (zpub)** – der Käufer wählt. Auf dem Server liegt in beiden Fällen nichts, womit sich Geld ausgeben ließe.

Weitere Dokumente:
- `LIZENZ_FORMAT.md` – Lizenzformat, Gerätecode, JSON-API für den In-App-Kauf, Testvektoren (Grundlage für die App-Seite)
- `VERKAUF_UND_STEUER.md` – technische Möglichkeiten zum Verkauf eingegangener Coins, Buchhaltungsdaten
- `RECHT_KRYPTOZAHLUNG.md` – rechtliche/steuerliche Einordnung (separates Dokument, keine Rechtsberatung)

---

## 1. Überblick

```
 Käufer (Tor-Browser "Am sichersten", ohne JS)      App (eigener Tor-Prozess)
            │  http://<onion>.onion                        │  JSON-API /api/v1/...
            └──────────────────────┬───────────────────────┘
                                   ▼
                     tor (Onion-Dienst, Port 80 -> 127.0.0.1:8085)
                                   ▼
        malachi-shop.service (Node.js, Nutzer malachi-shop, nur 127.0.0.1)
          ├─ Lizenz signieren (Ed25519, Schlüssel nur auf dem Server)
          ├─ Buchhaltung (JSONL + Hash-Kette, tägliche verschlüsselte Sicherung)
          ├─ Kurse (Median aus ≥ 2 Quellen) ──► Tor-SOCKS 127.0.0.1:9050 ──► Internet
          ├─ JSON-RPC (Digest-Login) ──► malachi-wallet-rpc.service (127.0.0.1:18082)
          │                                 View-only-Wallet (Hauptadresse + privater View-Key)
          │                                 └─► Tor-SOCKS ──► Monero-Remote-Node (.onion)
          └─ Bitcoin (optional): bc1q-Adressen lokal aus der zpub ──► Tor-SOCKS ──► mempool.space (.onion)
```

Ablauf eines Kaufs:
1. In der App (Bereich „Vollversion“) den **Gerätecode** kopieren – oder direkt in der App kaufen (API).
2. Zahlungsweg wählen (Monero oder Bitcoin, falls beide aktiv) und Bestellung anlegen → frische **Subadresse** (Monero) bzw. frische **bc1q-Adresse** (Bitcoin), Betrag in XMR bzw. BTC (2,99 € zum Median-Kurs), QR-Code, **Wiederherstellungscode** (nur einmal angezeigt).
3. Zahlungseingang wird über das View-only-Wallet (Monero) bzw. über mempool.space per Tor (Bitcoin) geprüft (Betrag, Adresse, Bestätigungen; Unter-/Überzahlung).
4. Nach Bestätigung: Rechnung (fortlaufende Nummer) + **Lizenznachweis** (Text/QR) für genau dieses Gerät.
5. Gerätewechsel: Bestellnummer + Wiederherstellungscode + neuer Gerätecode → neue Lizenz (max. 3 Aktivierungen).

Unbezahlte Bestellungen verfallen nach 24 h; ihre (Sub-)Adresse wird nach 72 h wiederverwendet, sofern nie ein Eingang darauf gesehen wurde.

## 2. Was du liefern bzw. entscheiden musst

- [ ] **Eigenes Monero-Wallet nur für den Shop** (empfohlen: neues Wallet, z. B. in Feather) und daraus **Hauptadresse** + **privater View-Key** (Abschnitt 3). Niemals Seed oder Spend-Key!
- [ ] **Remote-Node als Onion-Adresse** (z. B. aus einer Node-Liste wie monero.fail mit Filter „onion“, oder ein eigener Node an anderer Stelle). Format `xxxxxxxx.onion:18089`.
- [ ] Optional für Bitcoin: **eigenes Bitcoin-Wallet nur für den Shop** (Native SegWit, z. B. Sparrow oder Hardware-Wallet) und daraus der **Konto-zpub** (Abschnitt 3a). Niemals Seed, zprv/xprv oder private Schlüssel!
- [ ] **Bestätigung des Preises** (Standard 2,99 €, `preisEur`) und der Umsatzsteuer-Einstellung (`umsatzsteuer.kleinunternehmer`).
- [ ] **Rechtstexte**: Anbieter (Name, Anschrift) für Rechnungen, Impressum, Widerrufsbelehrung, ggf. Datenschutz-Ergänzungen (siehe `RECHT_KRYPTOZAHLUNG.md`).
- [ ] **Öffentlichen Lizenzschlüssel in die App einbauen** (wird bei der Installation ausgegeben).
- [ ] Optional: **Sicherungsschlüssel** erzeugen (Abschnitt 7.2).

## 3. Monero-Wallet vorbereiten (auf deinem eigenen Rechner)

1. Neues Wallet nur für den Shop anlegen (Feather, Cake Wallet oder Monero GUI). Seed sicher offline aufbewahren – **er kommt nie auf den Server**.
2. Aktuelle **Blockhöhe** notieren (wird beim Einrichten als Wiederherstellungshöhe gebraucht; z. B. in Feather unten in der Statuszeile oder über einen Block-Explorer im Tor-Browser).
3. **Hauptadresse** (beginnt mit `4`, 95 Zeichen) und **privaten View-Key** (`secret view key`, 64 Hex-Zeichen) heraussuchen:
   - **Feather:** Menü *Wallet → Keys*: „Primary address“ und „Secret view key“.
   - **Monero GUI:** *Settings → Seed & Keys*: „Primary address“ und „Secret view key“.
   - **Cake Wallet:** *Menü → Security and backup → Show seed/keys → Keys*: „View key (private)“; Hauptadresse im Empfangsbildschirm (Hauptadresse, keine Subadresse).
   - **monero-wallet-cli:** Befehle `address` (Index 0) und `viewkey`.
   (Menünamen können je nach Version abweichen.) **Nicht** kopieren: „Secret spend key“, „Seed“, „Mnemonic“.
4. Mit dem View-Key kann jeder alle Eingänge dieses Wallets sehen, aber nichts ausgeben. Daher ein eigenes Wallet nur für den Shop verwenden.

**Subadressen im eigenen Wallet:** Der Shop vergibt Subadressen (Konto 0, Index 1, 2, 3 …) und verwendet unbezahlte wieder; es sind höchstens 100 gleichzeitig reserviert (`bestellung.maxReservierteAdressen`). Monero-Wallets prüfen standardmäßig einen Vorrat („Lookahead“) von 200 Subadressen je Konto über die höchste benutzte hinaus – das reicht im Normalfall. Fehlt im eigenen Wallet eine Zahlung, die der Shop gesehen hat: im Wallet weitere Subadressen bis zum betreffenden Index erzeugen bzw. in monero-wallet-cli den Vorrat erhöhen (`set subaddress-lookahead 50:1000`) und neu scannen. Der Bestand laut Buchhaltung (`buchhaltung.js bestand`) sollte regelmäßig mit dem Wallet abgeglichen werden.

## 3a. Bitcoin-Wallet vorbereiten (optional, auf deinem eigenen Rechner)

Der Shop braucht für Bitcoin nur den **öffentlichen Konto-Schlüssel** („zpub“, Ebene `m/84'/0'/0'`) eines Native-SegWit-Wallets (BIP84, Adressen `bc1q…`). Daraus leitet er je Bestellung eine eigene Empfangsadresse ab und prüft Eingänge über mempool.space (über Tor). Mit der zpub lässt sich **nichts ausgeben** – der Seed bleibt offline bei dir.

**Wichtig – Datenschutz:** Die zpub verrät **alle** Adressen dieses Wallets und damit alle Ein- und Ausgänge, Kontostände und künftige Zahlungen. Wer den Server übernimmt (oder die zpub sieht), kann das Wallet vollständig beobachten. Deshalb:
- ein **eigenes Wallet nur für den Shop** anlegen (bzw. bei einer Hardware-Wallet ein eigenes Konto, z. B. `m/84'/0'/1'`) – nichts anderes darauf empfangen,
- beim späteren Ausgeben/Verkaufen die Shop-Coins nicht mit privaten Coins zusammen ausgeben (Coin-Control), sonst werden auch diese mit dem Shop verknüpft,
- Bitcoin-Zahlungen sind in der Blockchain grundsätzlich öffentlich einsehbar (Beträge, Adressen); Monero-Zahlungen nicht. Darauf weisen Shop-Seite und App neutral hin.

### Wallet anlegen und zpub exportieren

Variante A – **Sparrow Wallet** (empfohlen, Desktop):
1. *File → New Wallet*, Name z. B. „Malachi-Shop“.
2. *Policy Type* „Single Signature“, *Script Type* „Native Segwit (P2WPKH)“.
3. Keystore: *New or Imported Software Wallet* → *Generate New* (12 oder 24 Wörter) → Seed **auf Papier** notieren und prüfen lassen → *Create Keystore* → Ableitungspfad `m/84'/0'/0'` übernehmen → *Apply*.
4. Im Reiter *Settings* steht beim Keystore der Konto-Schlüssel (Feld „xpub“; je nach Version als `xpub…` oder `zpub…` angezeigt). **Beides** akzeptiert der Shop, solange es ein Native-SegWit-Konto auf Ebene `m/84'/0'/n'` ist. Diesen Wert kopieren.
5. Im Reiter *Settings → Advanced…* das **Gap limit** prüfen (Standard 20, siehe unten).

Variante B – **Hardware-Wallet** (Trezor, Ledger, BitBox, Coldcard, Jade …), angeschlossen an Sparrow:
1. *File → New Wallet* → *Script Type* „Native Segwit (P2WPKH)“ → *Connected Hardware Wallet* (bzw. *Airgapped Hardware Wallet* per Datei/QR) → *Import Keystore*.
2. Für den Shop ein **eigenes Konto** wählen (in Sparrow beim Import „Account“, z. B. 1 → `m/84'/0'/1'`), damit die zpub deine übrigen Coins nicht offenlegt.
3. zpub wie in Variante A, Schritt 4, ablesen. Der private Schlüssel verlässt das Gerät nie.

Variante C – **Electrum**:
- Mit Hardware-Wallet: *Datei → Neu/Wiederherstellen* → *Standard-Wallet* → *Hardware-Gerät* → Skripttyp „native segwit (p2wpkh)“, Pfad `m/84'/0'/0'` (oder eigenes Konto). Die zpub steht unter *Wallet → Informationen* („Master Public Key“).
- Mit Software-Seed nur als **BIP39-Seed** (bei der Seed-Eingabe *Optionen → BIP39-Seed*, Skripttyp native segwit, Pfad `m/84'/0'/0'`). **Achtung:** Electrums eigene Seeds (Standard) leiten auf einer anderen Ebene ab (`m/0'`); diese zpub lehnt der Shop mit „Erwartet wird der Konto-Schlüssel auf Ebene m/84'/0'/0' (Tiefe 3)“ ab.

Der Shop weist ab: private Schlüssel (`zprv`/`xprv`/…), Master-Schlüssel (Tiefe 0), `ypub` (BIP49, Adressen `3…`), Multisig (`Zpub`/`Ypub`) und Testnet-Schlüssel (`vpub`/`tpub`).

### Adressen vergleichen (vor dem Livegang!)

Lokal im Ordner `shop/` (nach `npm ci`):
```bash
npm run adressen -- --zpub zpub6r… --anzahl 5
```
Die ausgegebenen Adressen `m/0/0 … m/0/4` müssen exakt den ersten Empfangsadressen in deinem Wallet entsprechen (Sparrow: Reiter *Addresses*, Bereich „Receive“). Auf dem Server zeigt `pruefen.sh` zusätzlich die erste Adresse ab `startIndex`. Stimmen sie nicht überein: falsches Konto/falscher Skripttyp – **nicht** live schalten.

### Konfiguration (`zahlungswege.btc`)

```json
"btc": {
  "aktiv": true,
  "zpub": "zpub6r…",
  "startIndex": 0,
  "gapLimit": 20,
  "mempoolOnion": "http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion",
  "mempoolClearnet": "https://mempool.space",
  "clearnetFallback": false
}
```
- `zahlungswege.standard` legt fest, welcher Weg vorausgewählt ist (`xmr` oder `btc`); beide Wege können gleichzeitig aktiv sein.
- `startIndex`: erste Empfangsadresse `m/0/<startIndex>`, die der Shop vergibt. Neues Wallet: `0`. Hat das Wallet schon Adressen benutzt, den **nächsten unbenutzten** Index eintragen (nicht größer – sonst entsteht am Anfang eine Lücke, siehe Gap-Limit). Adressen, die schon einmal etwas empfangen haben, überspringt der Shop ohnehin.
- `kurs.quellen.BTC`: mindestens zwei Kursquellen (Standard Kraken und CoinGecko, über Tor); der Betrag ist der Median, aufgerundet auf ganze Satoshi, mindestens 546 sat (Staubgrenze).
- `mempoolOnion`: Onion-Adresse von mempool.space (Standard) oder einer **eigenen mempool-Instanz** als Onion-Dienst. mempool.space erfährt so, welche Adressen abgefragt werden (nicht aber die IP des Servers) und könnte sie einem gemeinsamen Besitzer zuordnen. `clearnetFallback: true` nutzt bei Ausfall zusätzlich `mempoolClearnet` – ebenfalls über Tor.
- `mindestBestaetigungen` gilt für beide Wege. Bei Bitcoin dauert eine Bestätigung im Mittel etwa 10 Minuten, oft länger. Zahlungen im Mempool (unbestätigt) zählen nie als bezahlt.

### Gap-Limit (wichtig für HD-Wallets)

Wallets wie Sparrow und Electrum suchen nach der letzten benutzten Adresse nur eine begrenzte Zahl **unbenutzter Adressen in Folge** ab („Gap-Limit“, Standard 20). Eine Zahlung an eine Adresse dahinter zeigt das Wallet nicht an (das Geld ist nicht verloren, aber unsichtbar, bis das Gap-Limit erhöht wird). Der Shop verhindert das:
- Er vergibt freie (nie benutzte) Adressindizes zuerst wieder und nimmt erst dann einen neuen Index.
- Er hält höchstens `gapLimit − 1` **unbezahlte Bitcoin-Bestellungen** gleichzeitig offen (Standard: 19). Darüber hinaus lehnt er neue Bitcoin-Bestellungen vorübergehend ab („ausgelastet“) – Monero bleibt möglich.
- So liegen nie `gapLimit` oder mehr unbenutzte Adressen hintereinander.

Erwartest du mehr gleichzeitig offene Bitcoin-Bestellungen: im Wallet das Gap-Limit erhöhen (Sparrow: *Settings → Advanced… → Gap limit*; Electrum: Konsole `wallet.change_gap_limit(100)`) und **denselben Wert** als `gapLimit` eintragen. Zusätzlich gilt weiterhin `bestellung.maxReservierteAdressen` für alle Wege zusammen. Fehlt im Wallet trotzdem eine Zahlung, die der Shop gesehen hat: Gap-Limit vorübergehend erhöhen und neu synchronisieren.

## 4. Server installieren (Debian 13 – Laptop „malachi“)

Hauptweg ist der Debian-13-Laptop („trixie“, Hostname `malachi`, im LAN `192.168.178.130`), auf dem auch die Website läuft (`../website/ANLEITUNG.md`). Ubuntu 24.04 (z. B. Hetzner) funktioniert mit denselben Schritten, siehe Ende dieses Abschnitts.

Voraussetzungen:
- Debian 13, **x86_64** (die Monero-Programme gibt es hier nur für x86_64), Zugang per SSH mit `sudo` (oder als root per `su -`).
- Ca. 1 GB RAM frei, wenige GB Platte (kein voller Monero-Node nötig).
- Der Laptop ist als Dauerläufer vorbereitet (Deckel zu ≠ Standby, LAN-Kabel, Uhrzeit synchron) – siehe `../website/ANLEITUNG.md`, Abschnitt „Laptop als Server vorbereiten“.
- Alle Pakete kommen aus Debian selbst: `nodejs` (Node.js 20) und `npm`, `tor` (0.4.8). **Warum `tor` aus Debian und nicht aus dem Tor-Project-Repository:** Die Pakete sind mit den ohnehin vertrauten Debian-Archivschlüsseln signiert, Sicherheitsupdates kommen über `debian-security` automatisch per `unattended-upgrades`, und es wird kein zusätzlicher Fremdschlüssel eingebunden. Die 0.4.8-Reihe kann alles, was der Shop braucht (v3-Onion-Dienst, Intro-DoS-Schutz, PoW-Schutz sofern mitgebaut). Das Repository `deb.torproject.org` bleibt eine Option, falls einmal eine neuere Tor-Version nötig wird (dann dessen Anleitung folgen; die Shop-Skripte funktionieren unverändert, Nutzer `debian-tor` und Dienst `tor@default` sind dort gleich).
- Debian-Besonderheiten, die das Skript berücksichtigt: Es prüft das System (`/etc/os-release`: Debian 13 oder Ubuntu 24.04), nutzt `runuser` statt `sudo -u` (auf minimalen Debian-Installationen fehlt `sudo`), richtet `%include /etc/tor/torrc.d/*.conf` ein, falls Debians `torrc` es noch nicht enthält, und legt den Onion-Schlüssel unter `/var/lib/tor/` ab (das erlaubt Debians AppArmor-Profil für Tor). systemd 257 kennt alle verwendeten Härtungs- und Credential-Optionen (`LoadCredential=`).

1. **Dateien auf den Laptop bringen** (Zeilenenden müssen LF sein – `git archive` liefert genau die eingecheckten Dateien mit LF, ohne `node_modules` und ohne lokale Konfiguration). Auf dem Windows-PC im Repo-Ordner (PowerShell):
   ```powershell
   git archive --format=tar -o shop.tar HEAD shop
   scp -i $HOME\.ssh\malachi_relay shop.tar malachiztrl@192.168.178.130:~/
   ```
   Auf dem Laptop:
   ```bash
   rm -rf ~/malachi-shop-quelle && mkdir ~/malachi-shop-quelle
   tar -xf ~/shop.tar -C ~/malachi-shop-quelle --strip-components=1 && rm ~/shop.tar
   ```
   Falls Skripte trotzdem mit Windows-Zeilenenden ankommen: `sed -i 's/\r$//' ~/malachi-shop-quelle/deploy/*.sh`
2. **Installation** (legt Nutzer, Verzeichnisse, Schlüssel, Dienste und den Onion-Dienst an; startet die Dienste noch nicht, solange etwas fehlt):
   ```bash
   cd ~/malachi-shop-quelle
   sudo MONERO_NODE=xxxxxxxxxxxxxxxx.onion:18089 bash deploy/install.sh
   ```
   Das Skript
   - installiert `tor`, `nodejs`, `npm`, `gnupg`, `curl`, `bzip2` aus den Paketquellen der Distribution (mit `OHNE_NPM=1` ohne `npm` – dann muss `node_modules` lokal per `npm ci --omit=dev --ignore-scripts` erzeugt und mitkopiert werden) und installiert die Abhängigkeiten exakt nach `package-lock.json` (`npm ci --omit=dev --ignore-scripts`),
   - legt die Nutzer `malachi-shop` und `malachi-wallet` an,
   - kopiert das Programm nach `/opt/malachi-shop` (root, nur lesbar),
   - erzeugt den **Lizenz-Signierschlüssel** `/etc/malachi-shop/lizenz-privat.pem` (root, 0600) und **gibt den öffentlichen Schlüssel aus** → in die App einbauen,
   - erzeugt den RPC-Zugang (`/etc/malachi-shop/wallet-rpc.login`, `/etc/malachi-wallet/wallet-rpc.conf`) und das Wallet-Passwort,
   - lädt die offiziellen **Monero-Programme** (nur `monero-wallet-rpc`, `monero-wallet-cli`) und prüft GPG-Signatur (Schlüssel von binaryFate, Fingerabdruck `81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92`) und SHA-256 (`deploy/monero-installieren.sh`, Version über `MONERO_VERSION`),
   - richtet `/etc/tor/torrc.d/malachi-shop.conf` ein (HiddenServiceDir `/var/lib/tor/malachi-shop`, PoW-Schutz automatisch, wenn `tor --list-modules` „pow: yes“ meldet) und **gibt die Onion-Adresse aus**.
3. **Konfiguration** `/etc/malachi-shop/config.json` bearbeiten (mindestens `zahlungswege.xmr.hauptadresse`, `rechtliches.*`), siehe Abschnitt 5.
4. **View-only-Wallet anlegen** (interaktiv; Hauptadresse und privaten View-Key eingeben, danach `exit`):
   ```bash
   sudo bash /opt/malachi-shop/deploy/wallet-einrichten.sh
   ```
5. **Installation erneut ausführen** – jetzt werden die Dienste gestartet:
   ```bash
   sudo bash ~/malachi-shop-quelle/deploy/install.sh
   sudo bash /opt/malachi-shop/deploy/pruefen.sh     # Konfiguration, Wallet (view-only?), Kurse über Tor
   ```
   Der Shop verweigert den Start, wenn das Wallet einen Spend-Key kennt oder nicht zur konfigurierten Hauptadresse gehört.
6. Im **Tor-Browser** (Sicherheitsstufe „Am sichersten“) die Onion-Adresse öffnen und eine Testbestellung anlegen (nicht bezahlen; sie verfällt nach 24 h).
7. **Sofort sichern:** Lizenz-Signierschlüssel und Onion-Schlüssel (Abschnitt 7.1) – vor allem, wenn auf demselben Laptop auch die Website läuft.

Die erste Synchronisation des Wallets über Tor kann je nach Wiederherstellungshöhe dauern (`journalctl -u malachi-wallet-rpc -f`).

**Variante Ubuntu 24.04 (z. B. Hetzner):** Dieselben Schritte; statt `malachiztrl@192.168.178.130` den eigenen Server (`root@SERVER`) verwenden. Node.js 18.19 aus Ubuntu genügt.

**Shop und Website auf demselben Laptop:** Beide nutzen denselben Tor-Dienst (`tor@default`), aber getrennte Onion-Dienste (`/var/lib/tor/malachi-shop/` bzw. `/var/lib/tor/malachi-web/`), getrennte Nutzer und getrennte Ports (Shop 8085, Website 8090). Die Reihenfolge ist egal. Wichtig ist das Bedrohungsmodell: Wer den Laptop übernimmt, hat auch den Lizenz-Signierschlüssel und kann damit beliebige Lizenzen erzeugen – Gegenmaßnahmen stehen in `../website/ANLEITUNG.md`, Abschnitt „Bedrohungsmodell“.

## 5. Konfiguration (`/etc/malachi-shop/config.json`)

Unbekannte Schlüssel sind ein Fehler (Tippfehlerschutz); Schlüssel mit `_` am Anfang sind Kommentare. Nach Änderungen: `sudo systemctl restart malachi-shop`.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `preisEur` | 2.99 | Preis der Vollversion (Endpreis) |
| `mindestBestaetigungen` | 1 | Bestätigungen, ab denen eine Zahlung als bezahlt gilt |
| `toleranzProzent` | 0 | erlaubte Unterzahlung in % (0–5) |
| `widerrufsZustimmungErforderlich` | true | Pflicht-Häkchen „sofortige Bereitstellung / Verlust des Widerrufsrechts“ (Web und API) |
| `bestellung.gueltigStunden` | 24 | Verfall unbezahlter Bestellungen |
| `bestellung.adresseReserviertStunden` | 72 | danach Löschung und Wiederverwendung der Subadresse (nur ohne jeden Eingang) |
| `bestellung.maxReservierteAdressen` | 100 | Obergrenze gleichzeitig reservierter Subadressen |
| `bestellung.proStunde` / `stoss` | 30 / 5 | globale Ratenbegrenzung für neue Bestellungen |
| `bestellung.bezahlteAufbewahrenTage` | 3650 | so lange bleibt eine bezahlte Bestellung für Umzüge gespeichert |
| `lizenz.schluesselDatei` | `credential:lizenz-schluessel` | privater Lizenzschlüssel (über systemd bereitgestellt) |
| `lizenz.maxAktivierungen` | 3 | Geräte insgesamt pro Kauf |
| `zahlungswege.standard` | `xmr` | Standard-Zahlungsweg |
| `zahlungswege.xmr.hauptadresse` | – | öffentliche Hauptadresse des Shop-Wallets |
| `zahlungswege.xmr.walletRpcUrl` / `walletRpcLogin` | lokal / Credential | Zugang zu monero-wallet-rpc (nur 127.0.0.1) |
| `zahlungswege.btc.aktiv` | false | zweiter Zahlungsweg Bitcoin (Abschnitt 3a); kann gleichzeitig mit Monero aktiv sein |
| `zahlungswege.btc.zpub` | – | Konto-zpub (oder xpub) eines Native-SegWit-Wallets nur für den Shop – niemals zprv/Seed |
| `zahlungswege.btc.startIndex` | 0 | erste Empfangsadresse `m/0/<startIndex>` (nächster unbenutzter Index des Wallets) |
| `zahlungswege.btc.gapLimit` | 20 | Gap-Limit des Wallets; höchstens `gapLimit − 1` unbezahlte Bitcoin-Bestellungen gleichzeitig |
| `zahlungswege.btc.mempoolOnion` / `mempoolClearnet` / `clearnetFallback` | mempool.space-Onion / – / false | Abfrage der Zahlungseingänge (immer über Tor) |
| `kurs.quellen.BTC` | Kraken, CoinGecko | Kursquellen für Bitcoin (mindestens `kurs.mindestQuellen`) |
| `zahlungswege.extern.*` | aus | Schnittstelle für einen externen Zahlungsdienst (Adapter nötig) |
| `kurs.quellen.XMR` | Kraken, CoinGecko | Kursquellen (`name`, `url`, `pfad` im JSON), abgerufen über Tor |
| `kurs.mindestQuellen` / `maxAbweichungProzent` | 2 / 5 | Median nur, wenn genug Quellen übereinstimmen |
| `umsatzsteuer.kleinunternehmer` | true | Hinweis nach § 19 UStG auf Seite und Rechnung (Text in `hinweisText`); sonst Steuersatz `steuersatz` |
| `buchhaltung.rechnungsPraefix` | `MAL` | Rechnungsnummern `MAL-2026-000001` |
| `buchhaltung.sicherungSchluessel` | leer | öffentlicher Sicherungsschlüssel (leer = keine Sicherungen) |
| `verkauf.*` | `manuell` | Verkaufsmodul, siehe `VERKAUF_UND_STEUER.md` |
| `texte.*` | – | Produktname, Beschreibung, Hinweise auf der Startseite |
| `rechtliches.anbieter` / `impressum` / `widerrufsbelehrung` / `datenschutzZusatz` | leer | Texte (jede Zeile ein Listeneintrag) |
| `server.port` | 8085 | lokaler Port (Tor leitet Port 80 dorthin) |

## 6. Sicherheit und Isolation (neben Coachbay)

- Kein Clearnet-Port: Der Shop lauscht nur auf `127.0.0.1:8085`, wallet-rpc nur auf `127.0.0.1:18082`. Zusätzlich verbieten die Dienste per `IPAddressDeny=any`/`IPAddressAllow=localhost` jeden Netzverkehr außer Loopback – alles Ausgehende geht über Tor.
- Eigene Nutzer (`malachi-shop`, `malachi-wallet`), eigene Verzeichnisse (`/opt/malachi-shop`, `/var/lib/malachi-shop`, `/var/lib/malachi-wallet`), gehärtete systemd-Dienste (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies`, Systemaufruf-Filter, `MemoryMax`, `CPUQuota`) – eine spätere zweite Anwendung (Coachbay) bekommt eigene Nutzer/Verzeichnisse/Ports und berührt nichts davon.
- Geheimnisse (`lizenz-privat.pem`, `wallet-rpc.login`, `wallet-rpc.conf`, `wallet.pass`, ggf. `kraken-api.json`) gehören root (0600) und werden per `LoadCredential=` nur dem jeweiligen Dienst im RAM bereitgestellt.
- Kein JavaScript, keine Cookies, keine Zugriffsprotokolle, strenge Sicherheits-Header (CSP `default-src 'self'; script-src 'none'; frame-ancestors 'none'`), keine Serverzeit im `Date`-Header, Größen- und Zeitlimits, Fehler ohne Stacktraces.
- Firewall: Auf dem Debian-Laptop richtet `../website/deploy/install.sh` eine nftables-Firewall ein (SSH nur aus dem Heimnetz, 80/443 für die Website, alles andere eingehend verworfen). Auf einem reinen Shop-Server (Ubuntu): `ufw default deny incoming`, nur SSH (und später die Ports von Coachbay) erlauben. Der Shop selbst braucht keinen offenen Port.
- Der Onion-Dienst soll **Käufer** schützen; der Anbieter ist über Impressum/Rechnung ohnehin namentlich bekannt.

## 7. Sicherungen

### 7.1 Was gesichert werden muss

| Was | Wo | Warum |
|---|---|---|
| **Lizenz-Signierschlüssel** | `/etc/malachi-shop/lizenz-privat.pem` | Ohne ihn keine neuen Lizenzen, die die App akzeptiert (neuer Schlüssel = App-Update nötig). Gelangt er an Dritte, können diese Lizenzen erzeugen. |
| **Onion-Schlüssel** | `/var/lib/tor/malachi-shop/` (`hs_ed25519_secret_key`, `hs_ed25519_public_key`, `hostname`) | Sonst ändert sich die Onion-Adresse (App und Käufer finden den Shop nicht mehr). |
| Konfiguration | `/etc/malachi-shop/config.json`, `/etc/malachi-wallet/wallet-rpc.conf` | Wiederherstellung |
| Bestellungen + Buchhaltung | `/var/lib/malachi-shop/` | Umzüge, Rechnungen, Aufbewahrungspflichten |
| Wallet-Seed | **nur offline beim Betreiber** | Das View-only-Wallet auf dem Server lässt sich jederzeit neu anlegen (Abschnitt 4, Schritt 4). |

Einmalige Sicherung der Schlüssel (verschlüsselt, z. B. mit `gpg --symmetric`, und offline aufbewahren):
```bash
sudo tar -C / -czf /root/malachi-schluessel.tgz etc/malachi-shop/lizenz-privat.pem var/lib/tor/malachi-shop
sudo gpg --symmetric --cipher-algo AES256 -o /root/malachi-schluessel.tgz.gpg /root/malachi-schluessel.tgz
sudo shred -u /root/malachi-schluessel.tgz
# dann /root/malachi-schluessel.tgz.gpg per scp auf einen sicheren Datenträger holen und vom Server löschen
```
Wiederherstellung des Onion-Schlüssels: `systemctl stop tor`, Ordner nach `/var/lib/tor/malachi-shop/` zurückspielen, `chown -R debian-tor:debian-tor /var/lib/tor/malachi-shop && chmod 700 /var/lib/tor/malachi-shop && chmod 600 /var/lib/tor/malachi-shop/*`, `systemctl start tor`.

### 7.2 Tägliche verschlüsselte Sicherung von Bestellungen und Buchhaltung

1. Auf dem **eigenen Rechner** ein Schlüsselpaar erzeugen (der private Teil bleibt dort):
   ```bash
   node src/werkzeuge/buchhaltung.js sicherungsschluessel --ausgabe sicherung-privat.pem
   ```
2. Den ausgegebenen öffentlichen Schlüssel in `buchhaltung.sicherungSchluessel` eintragen, Dienst neu starten.
3. Der Shop legt täglich `/var/lib/malachi-shop/sicherungen/malachi-sicherung-JJJJ-MM-TT.bin` an (die letzten 30 bleiben) und schreibt die Kettenköpfe der Buchhaltung ins Protokoll. Regelmäßig abholen:
   ```bash
   scp root@SERVER:/var/lib/malachi-shop/sicherungen/*.bin ./sicherungen/
   node src/werkzeuge/buchhaltung.js entschluesseln --schluessel sicherung-privat.pem --sicherung sicherungen/<datei>.bin --ziel wiederhergestellt/
   ```
4. Automatisch abholen (Windows): `deploy/sicherungen-abholen.ps1` nach `%USERPROFILE%\.malachi\` kopieren (Pfade oben im Skript anpassen) und als geplante Aufgabe täglich starten:
   ```powershell
   $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%USERPROFILE%\.malachi\sicherungen-abholen.ps1"'
   Register-ScheduledTask -TaskName 'Malachi Shop-Sicherungen abholen' -Action $a -Trigger (New-ScheduledTaskTrigger -Daily -At 12:00) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
   ```
   Das Skript schreibt jeden Lauf nach `abholen.log` im Zielordner.

## 8. Betrieb

| Aufgabe | Befehl |
|---|---|
| Status / Protokoll | `systemctl status malachi-shop malachi-wallet-rpc` · `journalctl -u malachi-shop -f` |
| Gesamtprüfung | `sudo bash /opt/malachi-shop/deploy/pruefen.sh` |
| Hash-Ketten prüfen | `sudo -u malachi-shop node /opt/malachi-shop/src/werkzeuge/buchhaltung.js pruefen --daten /var/lib/malachi-shop` |
| Bestand / Jahresübersicht | `… buchhaltung.js bestand --daten /var/lib/malachi-shop --kurs XMR=486.27` |
| Verkauf nachtragen | `… buchhaltung.js verkauf --daten /var/lib/malachi-shop --datum 2026-10-20 --waehrung XMR --menge 0.05 --erloes 24.10 --gebuehr 0.20 --dienst "Haveno" --referenz "…"` |
| Gebühr / Auszahlung | `… buchhaltung.js gebuehr …` · `… buchhaltung.js auszahlung …` |
| Korrektur | `… buchhaltung.js storno --daten … --journal verkaeufe --seq 3 --notiz "Grund"` |
| CSV-Export fürs Jahr | `… buchhaltung.js export --daten /var/lib/malachi-shop --jahr 2026 --ziel /tmp/export` |
| Programm aktualisieren | neue Version wie in Abschnitt 4, Schritt 1 nach `~/malachi-shop-quelle`, dann `sudo bash ~/malachi-shop-quelle/deploy/install.sh` |
| Monero aktualisieren | `sudo MONERO_VERSION=v0.18.x.y bash /opt/malachi-shop/deploy/monero-installieren.sh && sudo systemctl restart malachi-wallet-rpc` – **bei Monero-Netz-Upgrades (Hardforks) rechtzeitig!** |

Die Kommandozeilenwerkzeuge laufen als `sudo -u malachi-shop …`, damit Dateirechte stimmen; Dienst und Werkzeug können gleichzeitig buchen (Dateisperre).

### 8.1 Kraken anbinden (automatischer Verkauf von Bitcoin gegen Euro)

Der Server kann keine Coins bewegen (nur View-/Watch-only). Ablauf deshalb:
Kunden zahlen BTC in **dein** Wallet (Sparrow) → du schickst gesammelt an deine
**Kraken-Einzahlungsadresse** (Kraken: Funding → Deposit → Bitcoin) → der Shop
verkauft dort automatisch per Market-Order gegen EUR und bucht jeden Verkauf.
Monero ist bei Kraken im EWR nicht handelbar (`VERKAUF_UND_STEUER.md`).

1. Bei Kraken: Einstellungen → API → neuen Schlüssel erstellen. **Nur** anhaken:
   *Funds: Query*, *Orders and trades: Query open orders & trades*, *Query closed
   orders & trades*, *Create & modify orders*. **Nicht** anhaken: Withdraw, Deposit,
   Earn, Cancel/close, Ledger, Export. IP-Whitelist leer (der Shop geht über Tor).
2. Auf dem Server: `sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh` –
   API Key und Private Key **verdeckt** einfügen (nie per Chat/Mail weitergeben).
   Das Skript prüft über Tor: Guthaben- und Auftragsrechte vorhanden, **Auszahlrecht
   nicht vorhanden** (sonst wird der Schlüssel abgelehnt und nicht gespeichert).
   Danach läuft das Modul im **Probelauf** (meldet nur, was es verkaufen würde).
3. Wenn der Probelauf passt: `sudo bash /opt/malachi-shop/deploy/kraken-einrichten.sh --scharf`.

Erneut prüfen: `… kraken-einrichten.sh --pruefen` (läuft auch in `pruefen.sh` mit).
Abschalten und Schlüssel löschen: `… kraken-einrichten.sh --aus` (danach den
Schlüssel auch bei Kraken löschen). Schwellenwert/Reserve: `verkauf.kraken` in
`config.json` (Standard: ab 0,001 BTC, alles verkaufen).

### 8.2 Widerrufe („Vertrag widerrufen“, § 356a BGB)

Kunden können bis zur Bereitstellung der Lizenz im Shop („Vertrag widerrufen“ auf
jeder Seite) oder in der App widerrufen – mit Bestellnummer und
Wiederherstellungscode, optional Name und Rückzahlungsadresse (mit Prüfsumme
geprüft). Sie erhalten sofort eine Eingangsbestätigung zum Speichern. Danach
eingehende Zahlungen erzeugen nie eine Lizenz.

Ist schon Geld eingegangen, zahlst **du** zurück (der Server kann nichts senden),
spätestens 14 Tage nach Eingang, gleiche Währung, Netzwerkgebühr trägst du:

```
sudo runuser -u malachi-shop -- node /opt/malachi-shop/src/werkzeuge/widerrufe.js liste --daten /var/lib/malachi-shop
# Betrag aus Feather/Sparrow an die angezeigte Adresse senden, dann buchen:
sudo runuser -u malachi-shop -- node /opt/malachi-shop/src/werkzeuge/widerrufe.js erstattet --daten /var/lib/malachi-shop --bestellung <Nr> --menge <Betrag> --txid <Transaktions-ID>
```

Offene Rückzahlungen meldet der Dienst einmal täglich im Protokoll und `pruefen.sh`.
Nach der Buchung löscht der Shop die Bestellung samt Name und Adresse.

### 8.2 Monero-Knoten und Ausfallsicherheit

Das View-only-Wallet liest die Blockchain über einen fremden Monero-Knoten (über Tor,
`untrusted`). Fällt dieser Knoten aus, schaltet der Shop selbst um: Er prüft alle
5 Minuten, ob der Knoten antwortet, und wechselt sonst der Reihe nach auf die
`zahlungswege.xmr.ersatzKnoten` (nur Onion, z. B. aus https://monero.fail).
Solange kein Knoten antwortet, nimmt der Shop keine neuen Monero-Bestellungen an
(Hinweis auf Bitcoin); alles andere läuft weiter. Dasselbe gilt für Bitcoin, wenn
mempool.space über Tor nicht erreichbar ist. wallet-rpc startet mit
`--no-initial-sync` und ist dadurch sofort ansprechbar.

## 9. Fehlersuche

- **„Kurs kann nicht ermittelt werden“**: Tor läuft? (`systemctl status tor@default`), Kursquellen über Tor erreichbar? (`pruefen.sh`). Notfalls weitere Quelle in `kurs.quellen.XMR` ergänzen.
- **„Zahlungsprüfung nicht erreichbar“**: `journalctl -u malachi-wallet-rpc`; Remote-Node erreichbar? Anderen Onion-Node in `/etc/malachi-wallet/wallet-rpc.conf` eintragen, `systemctl restart malachi-wallet-rpc`.
- **„Wallet ist NICHT view-only“** / **„gehört nicht zur Hauptadresse“**: falsches Wallet – View-only-Wallet neu anlegen (`wallet-einrichten.sh`, vorher alte Dateien in `/var/lib/malachi-wallet` entfernen).
- **„Buchhaltung beschädigt oder verändert“**: Der Dienst bucht nichts mehr. Mit `buchhaltung.js pruefen` die Stelle finden, Datei aus der letzten Sicherung vergleichen; nichts „reparieren“, sondern dokumentieren und ggf. mit der Steuerberatung klären.
- **Tor-Option unbekannt**: `install.sh` schaltet `HiddenServicePoWDefensesEnabled` nur ein, wenn `tor --list-modules` „pow: yes“ meldet. Meldet `tor --verify-config` trotzdem einen Fehler, die Zeile in `/etc/tor/torrc.d/malachi-shop.conf` wieder mit `#` auskommentieren.
- **`sudo: command not found`** (minimales Debian): als root per `su -` arbeiten oder `apt-get install sudo` und den eigenen Nutzer in die Gruppe `sudo` aufnehmen. Die Skripte selbst brauchen kein `sudo`.
- **Tests unter Windows**: `npm test` kann unter Windows sporadisch im Buchhaltungstest „zwei Instanzen … ohne Kettenbruch“ mit `EPERM` auf `.sperre` scheitern (Windows meldet beim Öffnen einer gerade gelöschten Datei `EPERM` statt `EEXIST`). Das betrifft nur Windows; ein erneuter Lauf ist grün. Auf Linux (Laptop/Server) tritt es nicht auf.
- **Bitcoin: „zpub … Tiefe 3“ / „ypub gehört zu BIP49“ / „PRIVATER SCHLUESSEL“**: falscher Schlüssel exportiert – Abschnitt 3a (Konto-zpub eines Native-SegWit-Kontos; Electrum-eigene Seeds passen nicht). Einen versehentlich auf den Server kopierten privaten Schlüssel als kompromittiert betrachten und Coins in ein neues Wallet verschieben.
- **Bitcoin: „mempool.space nicht erreichbar“**: Tor prüfen; ggf. `clearnetFallback` aktivieren oder eine eigene mempool-Instanz als Onion eintragen.
- **Bitcoin: „Gerade sind sehr viele Bitcoin-Bestellungen offen“**: Gap-Limit erreicht (Abschnitt 3a) – abwarten (unbezahlte Bestellungen verfallen) oder Gap-Limit im Wallet **und** in `gapLimit` erhöhen.
- **Bitcoin-Zahlung im Shop gesehen, aber nicht im Wallet**: Adressen mit `npm run adressen` vergleichen (richtiges Konto?), Gap-Limit im Wallet erhöhen, neu synchronisieren.

## 10. Rechtliches

Die rechtliche Einordnung (Impressum-/Informationspflichten, Widerrufsrecht bei digitalen Inhalten, Preisangaben, Umsatzsteuer/Kleinunternehmer, Rechnungen, Aufbewahrung, Datenschutz, Kryptowerte-Regulierung) steht in **`RECHT_KRYPTOZAHLUNG.md`**. Keine Rechtsberatung. Technisch vorbereitet sind:
- Pflicht-Zustimmung zur sofortigen Bereitstellung (Web und API) und deren Speicherung,
- Kleinbetragsrechnung als HTML (Anbieter aus `rechtliches.anbieter`, Hinweis nach § 19 UStG ein-/ausschaltbar),
- Seiten für Impressum, Widerrufsbelehrung und Datenschutz (Texte aus der Konfiguration),
- Buchhaltung mit Hash-Kette, Exporten und Sicherungen.

## 11. Ehrliche Grenzen

- Die Lizenz ist **kein Kopierschutz**: offline nicht widerrufbar, durch Umbau der (künftig quelloffenen) App umgehbar.
- Der Remote-Node könnte Zahlungen verschweigen oder verzögern (nicht fälschen, da das Wallet die Daten selbst prüft); bei Auffälligkeiten anderen Node wählen.
- Kursquellen und mempool.space/Kraken können Tor-Zugriffe zeitweise blockieren; dann sind keine Bestellungen möglich, bis wieder genug Quellen antworten.
- Wiederverwendete Subadressen: Zahlt jemand Tage nach Ablauf noch an eine alte Adresse, kann diese inzwischen einer neuen Bestellung gehören (der Shop prüft vor der Vergabe, ob je ein Eingang da war, und die Seite einer abgelaufenen Bestellung warnt deutlich).
- Monero-Netz-Upgrades erfordern zeitnahe Updates von `monero-wallet-rpc`.
- Bitcoin: Der Shop verlässt sich auf die Angaben von mempool.space (bzw. der eingetragenen Instanz). Ein manipulierter Dienst könnte Zahlungen verschweigen oder vortäuschen; bei Auffälligkeiten mit dem eigenen Wallet abgleichen oder eine eigene mempool-Instanz verwenden. Unbestätigte Zahlungen zählen nie als bezahlt.
- Bitcoin: Die Netzwerkgebühr zahlt der Käufer zusätzlich; sie kann im Verhältnis zu 2,99 € hoch sein. Wer zu wenig sendet (z. B. Börse zieht Gebühren ab), muss den Rest an dieselbe Adresse nachzahlen – Beträge unter 546 sat lassen sich nicht senden, der Shop verlangt dann mindestens 546 sat.
