# Verkauf eingegangener Coins und Daten für die Steuer – technische Recherche

Stand: 16. Oktober 2026. Dieses Dokument beschreibt **nur technische Integrationsmöglichkeiten** (welche Dienste/APIs gibt es, wie würde man sie anbinden, was der Shop dafür bereits mitbringt). Die **rechtliche und steuerliche Bewertung** (MiCA, EU-Geldwäscheverordnung AMLR ab 2027, ausländische Zahlungsdienstleister, Steuer, Verbraucherrecht) steht in **`RECHT_KRYPTOZAHLUNG.md`** (eigenes Dokument, wird separat erstellt). Keine Rechtsberatung.

---

## 1. Ausgangslage und technische Grundbedingung

- Kunden zahlen 2,99 € in **Monero (XMR)** an eine eigene Subadresse des Shop-Wallets. Der Server betreibt nur ein **View-only-Wallet** (sieht Eingänge, kann nichts ausgeben). Optional (abgeschaltet) gibt es einen **Bitcoin-Weg** mit Watch-only-zpub.
- **Folge:** Der Server kann eingegangene Coins **nicht selbst** zu einer Börse oder einem Tauschdienst schicken. Jeder „automatische Verkauf“ setzt voraus, dass die Coins **bereits beim Verkaufsdienst liegen** – entweder weil der Betreiber sie dorthin überweist (mit seinem eigenen Wallet), oder weil der Kunde direkt an einen Dienst zahlt (externer Zahlungsdienstleister).
- Einen Spend-Key auf den Server zu legen, wäre technisch möglich, widerspricht aber der Sicherheitsvorgabe dieses Projekts (Server-Kompromittierung = Verlust aller Einnahmen) und ist daher **nicht vorgesehen**.

## 2. Befund: Wo lässt sich XMR technisch gegen EUR verkaufen?

| Weg | Stand Okt. 2026 | Quelle |
|---|---|---|
| Kraken (EU-reguliert, MiCA-Lizenz der irischen Zentralbank seit Juni 2025) | XMR-Handel und -Einzahlung für Kunden im EWR seit 31.10.2024 eingestellt; Restbestände Anfang 2025 in BTC umgewandelt. Die öffentlichen XMR-Kursdaten (`XMREUR`) sind weiterhin abrufbar (der Shop nutzt sie als Kursquelle). | Cointelegraph, The Block, Kraken-Support |
| Binance | XMR weltweit seit 20.02.2024 delistet | Decrypt |
| OKX | XMR-Paare seit Januar 2024 entfernt | Decrypt |
| Bitpanda, Bitvavo, Coinbase, Bitstamp, Gate.io | kein XMR-Paar (Prüfung der Marktlisten am 05.10.2026) | CryptoTicker |
| KuCoin | XMR-Paare, aber kein EUR-Markt und keine Zulassung für Deutschland | CryptoTicker |
| LocalMonero / AgoraDesk (P2P) | eingestellt (Mai 2024) | FXStreet, AlternativeTo |
| Haveno (dezentrale P2P-Börse über Tor, Multisig-Treuhand, auch XMR↔EUR per SEPA) | existiert; Handel mit Einzelpersonen, manuell, keine Börsen-API im üblichen Sinn | Privacy-Guides-Forum |
| Atomic Swaps XMR↔BTC (z. B. BasicSwap DEX; eigenwallet/UnstoppableSwap nur BTC→XMR als „Taker“) | nicht-verwahrend, technisch aufwendig, Gegenpartei-Liquidität schwankt | Projektseiten/Guides (nicht vollständig verifiziert) |
| „Instant-Swap“-Dienste ohne Konto | technisch verfügbar, aber Verwahrungs-/Sperrrisiko und Herkunftsfragen beim späteren Einzahlen an eine regulierte Börse | → `RECHT_KRYPTOZAHLUNG.md` |
| Gehostete Zahlungsdienstleister mit XMR (z. B. NOWPayments, CoinPayments, Plisio …) | bieten XMR-Annahme, teils Auszahlung in EUR über Partner; ob das für EU-Händler zulässig/angeboten ist, ist eine Rechts-/Vertragsfrage | Anbieterseiten; → `RECHT_KRYPTOZAHLUNG.md` |

Hintergrund (Details im Rechtsdokument): MiCA Art. 76 Abs. 3 (Handelsplattformen und Coins mit eingebauter Anonymisierung) und Art. 79 der EU-Geldwäscheverordnung (EU) 2024/1624, das nach den Quellen ab **10. Juli 2027** Konten mit anonymisierenden Coins bei Krypto-Dienstleistern untersagt.

**Technisches Fazit:** Eine **API-gestützte, regulierte XMR→EUR-Anbindung gibt es derzeit nicht**. Automatisierbar ist der Verkauf nur für **Bitcoin** bei einer regulierten Börse mit API – und auch dort nur für Coins, die der Betreiber selbst eingezahlt hat.

## 3. Umgesetzte Bausteine im Shop

### 3.1 Verkaufsmodul (`src/verkauf.js`), austauschbar, mit Schwellenwert oder Zeitplan

| Modus | Was passiert | Konfiguration (`verkauf`) |
|---|---|---|
| `manuell` (**Standard**) | Nichts automatisch. Bestand wird aus der Buchhaltung berechnet; Verkäufe, Gebühren und Auszahlungen trägt der Betreiber per Befehl nach. | `"modus": "manuell"` |
| `kraken` | Prüft das Kraken-Guthaben in **BTC**; liegt es über `schwellenwert` (bzw. einmal täglich ab `stundeUtc`), wird `Guthaben − reserve` per **Market-Order XBT/EUR** verkauft und nach Ausführung automatisch als Verkauf gebucht (Erlös, Gebühr, Auftragsnummer). Standard ist ein **Probelauf** (`validate=true`, nichts wird ausgeführt). | `"modus": "kraken"`, `zeitplan` = `schwellenwert` / `taeglich`, `kraken.nurProbelauf`, `kraken.schwellenwert`, `kraken.reserve` |

Kraken-Anbindung (technisch):
- REST `https://api.kraken.com/0/private/{Balance,AddOrder,QueryOrders}`, Signatur `API-Sign = Base64(HMAC-SHA512(URI-Pfad + SHA256(nonce + POST-Daten), Base64-dekodiertes Secret))`, Nonce = streng steigende Millisekunden. Die Implementierung ist mit dem Beispiel aus der Kraken-Dokumentation getestet (`test/verkauf.test.js`).
- Alle Aufrufe laufen **über Tor** (SOCKS5). Der systemd-Dienst darf ohnehin nur Loopback erreichen.
- **API-Schlüssel nur mit den Rechten** „Funds – Query“, „Orders and trades – Query open/closed orders & trades“ und „Orders and trades – Create & modify orders“. **Niemals „Withdraw Funds“** (dann kann ein Angreifer mit Serverzugriff höchstens handeln, aber nichts abziehen). Das Kraken-Konto selbst zusätzlich mit Zwei-Faktor-Anmeldung schützen; die Sicherheitsoptionen des Kontos für Auszahlungen nutzen, soweit angeboten.
- Zugangsdaten als Datei `/etc/malachi-shop/kraken-api.json` (`{"apiKey":"…","apiSecret":"…"}`, root, 0600), Einbindung als systemd-Credential (Zeile in `deploy/malachi-shop.service` einkommentieren).
- Hinweis: Kraken kann Zugriffe über Tor zusätzlich prüfen oder drosseln.

Warum **nur** Kraken als automatischer Adapter: Nach der Recherche ist es der einzige der geprüften Dienste, der gleichzeitig (a) EU-reguliert ist, (b) für Kunden in Deutschland BTC/EUR anbietet und (c) eine dokumentierte API mit fein einstellbaren Schlüsselrechten hat. Für XMR gibt es keinen solchen Dienst (Abschnitt 2). Andere Börsen können als weiterer Adapter nach demselben Muster ergänzt werden.

### 3.2 Zusätzlicher Bitcoin-Zahlungsweg (optional, standardmäßig aus)

`zahlungswege.btc` (BIP84, Watch-only-zpub, Zahlungsprüfung über mempool.space-Onion). Wer Einnahmen schneller in Euro tauschen möchte, kann BTC zusätzlich anbieten: Kunden wählen dann zwischen XMR und BTC. BTC landet im eigenen Wallet; der Betreiber überweist gesammelt an Kraken; das Verkaufsmodul verkauft automatisch. **Lightning** ist nicht umgesetzt (bräuchte einen eigenen Lightning-Knoten oder einen weiteren Dienst – mehr Angriffsfläche und Wartung; ggf. später als eigener Zahlungsweg).

### 3.3 Schnittstelle für einen externen Zahlungsdienstleister (`src/zahlung/extern.js`)

Für den Fall, dass ein gehosteter Dienst (Rechnung per API, Zahlungsannahme beim Dienst, Auszahlung an den Betreiber) genutzt werden soll. Es ist **kein** Anbieter fest verdrahtet; getestet wird mit einem Mock (`test/hilfen.js`, `TestZahlungsdienst`).

Ein Adapter (`src/zahlung/anbieter/<name>.js`, Export `erstelleAdapter({ einstellungen, holen, log })`) implementiert:
- `rechnungErstellen({ bestellnummer, preisEur })` → Adresse, Betrag, Referenz, ggf. Kurs des Dienstes
- `rechnungsstatus(referenz)` → empfangen/bestätigt, Transaktions-IDs, **Gebühren** (werden automatisch ins Gebührenjournal gebucht)
- optional `webhookPruefen(kopf, rohKoerper)` (signierte Benachrichtigung; wird nur als Auslöser für eine sofortige Statusabfrage benutzt, dem Inhalt wird nicht vertraut)
- optional `auszahlungen(seit)` → Auszahlungen an den Betreiber (werden stündlich abgeholt und ins Auszahlungsjournal gebucht)

Technische Hinweise am Beispiel NOWPayments (laut öffentlich gespiegelter Doku, **vor Umsetzung mit der offiziellen Dokumentation und Sandbox prüfen**): Benachrichtigungen (IPN) sind mit HMAC-SHA512 über das nach Schlüsseln sortierte JSON signiert (Kopfzeile `x-nowpayments-sig`); Zahlungsstatus u. a. `waiting`, `confirming`, `partially_paid`, `finished`, `expired`, `failed`. Abbildung: `finished` → bestätigt; `confirming` → im Pool; `partially_paid` → unterzahlt; `expired`/`failed` → abgelaufen.
Grenzen: (1) Ein reiner Onion-Dienst ist für Clearnet-Webhooks nicht erreichbar → es bleibt beim Abfragen alle 60 s. (2) Viele Dienste sitzen hinter Cloudflare und blockieren Tor-Ausgänge zeitweise. (3) Der Dienst verwahrt die Gelder und verlangt in der Regel eine Händler-Identifizierung. (4) Ob ein solcher Dienst XMR→EUR für einen deutschen Händler anbieten darf, ist in `RECHT_KRYPTOZAHLUNG.md` zu klären.

### 3.4 Weitere technische Alternativen (nicht umgesetzt)

- **XMR → EUR-Stablecoin (z. B. EURC)** über einen Tausch und anschließend Rücktausch bei einer regulierten Stelle: zwei Schritte, Spend-Key nötig (nicht auf dem Server), keine sinnvolle Server-Automatik.
- **Haveno** (XMR↔EUR P2P): manuell im eigenen Haveno-Client; Verkäufe danach per Befehl buchen.
- **XMR→BTC (Atomic Swap)**, dann BTC über das Kraken-Modul verkaufen: Swap manuell (eigenes Wallet), Verkauf automatisch.

## 4. Was die Buchhaltung aufzeichnet (Datengrundlage für Steuerberatung)

Alle Journale liegen unter `/var/lib/malachi-shop/buchhaltung/` als **append-only JSONL mit Hash-Kette** (jeder Eintrag enthält den SHA-256 des Vorgängers; Prüfung mit `buchhaltung.js pruefen`, beim Dienststart automatisch). Korrekturen nur als Storno-Eintrag mit Begründung. Täglich eine **verschlüsselte Sicherung** (X25519 + AES-256-GCM; der private Sicherungsschlüssel liegt nur beim Betreiber) und der Kettenkopf im Systemprotokoll als externer Anker.

| Journal | Inhalt je Eintrag |
|---|---|
| `einnahmen` | fortlaufende Rechnungsnummer (`MAL-2026-000001`, je Jahr neu), Zeitstempel UTC, Bestellnummer, Lizenz-ID, Zahlungsweg/Anbieter, Verwahrung (eigenes Wallet / Zahlungsdienst), Betrag EUR (2,99), Betrag in XMR (berechnet und tatsächlich empfangen, Überzahlung), EUR-Referenzkurs mit **allen Einzelquellen, Median-Methode und Abrufzeit**, Kurs bei Zahlungseingang (falls abrufbar), Transaktions-IDs, Subadress-Index, Referenz des Zahlungsdienstes, Umsatzsteuer-Angabe |
| `verkaeufe` | Datum, Coin, Menge, Erlös EUR, Gebühr EUR, Dienst, Referenz (z. B. Kraken-Auftragsnummer), Notiz, Quelle (manuell/kraken) |
| `gebuehren` | Datum, Währung (EUR/XMR/BTC), Betrag, EUR-Wert, Dienst, Referenz |
| `auszahlungen` | Auszahlungen eines Zahlungsdienstes an den Betreiber |
| `sonstige` | z. B. unvollständig bezahlte, verfallene Bestellungen (Betrag, Wert, Transaktionen) |

Exporte (`buchhaltung.js export --jahr 2026 --ziel ./export [--kurs XMR=…]`): `einnahmen-2026.csv`, `verkaeufe-2026.csv`, `gebuehren-2026.csv`, `auszahlungen-2026.csv`, `sonstige-eingaenge-2026.csv`, `jahresuebersicht-2026.csv` (Einnahmen, Zugänge, Verkäufe, FIFO-Buchwert, Veräußerungsergebnis, Gebühren, vereinfachter Gewinn, Bestand und Buchwert zum Jahresende, optional Marktwert). Format: Semikolon, Dezimalkomma, UTF-8 mit BOM (Excel-tauglich), Formel-Injektion wird entschärft.

Die Jahresübersicht ist **vereinfacht** (Zugangswert eines Coin-Eingangs = Rechnungsbetrag; FIFO). Welche Bewertungs- und Verbrauchsfolge steuerlich anzuwenden ist, gehört in die Steuerberatung (→ `RECHT_KRYPTOZAHLUNG.md`).

### Fragen, die die Daten beantworten können sollen (zur Klärung mit der Steuerberatung)
- [ ] Reicht der gespeicherte Referenzkurs (Median aus ≥ 2 Quellen zum Bestellzeitpunkt) als Wertansatz, oder ist der Kurs bei Zahlungseingang maßgeblich (beide sind gespeichert)?
- [ ] Ist FIFO als Verbrauchsfolge für die Jahresübersicht passend?
- [ ] Wie sind Überzahlungen und verfallene Teilzahlungen (`sonstige`) zu behandeln?
- [ ] Reichen die CSV-Exporte plus verschlüsselte Sicherungen für die Aufbewahrung, oder wird ein anderes Format (z. B. für die Buchhaltungssoftware) benötigt?
- [ ] Wie sind Netzwerkgebühren beim Umbuchen eigener Coins zu erfassen?

## 5. Empfehlung (technisch)

1. **Start mit `manuell`**: XMR annehmen, Bestand regelmäßig mit dem eigenen Wallet abgleichen (`buchhaltung.js bestand`), Verkäufe nachtragen.
2. Wer Euro-Erlöse automatisieren möchte: **Bitcoin-Zahlungsweg zuschalten** und das **Kraken-Modul** zunächst im Probelauf betreiben; Schlüssel ohne Auszahlungsrecht.
3. Einen **externen Zahlungsdienst** erst anbinden, wenn `RECHT_KRYPTOZAHLUNG.md` die Nutzung für den konkreten Anbieter bejaht; dann einen Adapter nach Abschnitt 3.3 schreiben.

## Quellen

- [Kraken beendet Monero-Unterstützung im EWR (Cointelegraph)](https://cointelegraph.com/news/kraken-ends-monero-support-european-economic-area)
- [Kraken: Delisting in Irland und Belgien, Umwandlung in BTC (The Block)](https://www.theblock.co/post/287801/kraken-delist-monero-ireland-belgium-convert-remaining-balances-bitcoin)
- [Kraken-Support: Monero in Europa](https://support.kraken.com/pt/articles/support-for-monero-xmr-in-europe)
- [Kraken erhält MiCA-Lizenz der irischen Zentralbank (Business Wire, Juni 2025)](https://www.businesswire.com/news/home/20250625529871/en/Kraken-Secures-MiCA-License-from-Central-Bank-of-Ireland-Cementing-Leadership-in-Eur)
- [Binance: Monero delistet (Decrypt)](https://decrypt.co/218194/binance-finalizes-monero-delisting)
- [Monero kaufen in Deutschland: sechs große Börsen ohne XMR (CryptoTicker, Prüfung 05.10.2026)](https://cryptoticker.io/de/monero-kaufen-delisting/)
- [LocalMonero schließt (FXStreet)](https://www.fxstreet.com/cryptocurrencies/news/localmonero-exchange-shuts-down-as-crypto-privacy-services-dwindle-202405080605) · [AlternativeTo](https://alternativeto.net/news/2024/5/prominent-no-kyc-crypto-exchanges-localmonero-and-agoradesk-shut-down/)
- [Haveno als Nachfolger (Privacy Guides Forum)](https://discuss.privacyguides.net/t/mention-haveno-now-that-localmonero-is-shutdown/18428)
- [EU: Verbot anonymer Konten/Privacy Coins bei Krypto-Dienstleistern ab 2027 (Cointelegraph)](https://cointelegraph.com/news/eu-crypto-ban-anonymous-privacy-tokens-2027) · [Text Art. 79 AMLR (Better Regulation)](https://service.betterregulation.com/node/975905)
- [Kraken-API: Authentifizierung](https://docs.kraken.com/api/docs/guides/spot-rest-auth/) · [AddOrder](https://docs.kraken.com/api/docs/rest-api/add-order/)
- [NOWPayments: Monero-Annahme (Anbieterblog)](https://nowpayments.io/blog/businesses-that-accept-monero) · [IPN-Signatur (Drittanbieter-Referenz)](https://ledgerline-docs.onrender.com/docs/reference/nowpayments-adapter)
- [Monero-wallet-rpc-Referenz](https://docs.getmonero.org/interacting/monero-wallet-rpc-reference/) · [Wallet-RPC-Methoden](https://docs.getmonero.org/rpc-library/wallet-rpc/) · [Binärdateien prüfen](https://docs.getmonero.org/interacting/verify-monero-binaries/)
