# Lizenzformat „ML1“ – Spezifikation (Shop ↔ App)

Stand: Oktober 2026 · Referenzimplementierung: `src/lizenzpruefer.js` (Prüfung, ohne Node-APIs, 1:1 in die App übernehmbar), `src/lizenz.js` (Signieren auf dem Server), Tests mit allen Testvektoren: `test/lizenz.test.js`.

Diese Spezifikation ist verbindlich für die App-Seite (Kotlin-Keystore-Modul + Prüfung in JavaScript mit `@noble/curves`). Alle Beispiele unten sind **Testvektoren mit öffentlich bekannten Testschlüsseln** – niemals produktiv verwenden.

---

## 1. Ziel und ehrliche Grenzen

- Die App ist kostenlos. Die Vollversion (Feature `pro`) wird mit einem **signierten Lizenznachweis** freigeschaltet.
- Die App prüft den Nachweis **lokal und offline** mit eingebauten öffentlichen Schlüsseln. Beim Prüfen gibt es **keinen** Kontakt zum Shop.
- Die Lizenz gilt **für ein Gerät** (Gerätebindung über einen Schlüssel im Android Keystore).
- **Grenzen (bewusst):**
  - Offline gibt es keinen Widerruf. Eine einmal ausgestellte Lizenz bleibt auf dem Gerät gültig, für das sie ausgestellt wurde – auch nach einem Umzug auf ein neues Gerät.
  - Da die App quelloffen werden soll, lässt sich die Prüfung durch Umbau der App entfernen. Ziel ist **Fairness** (ehrliche Nutzer zahlen einfach), kein unknackbarer Kopierschutz.
  - Die Gerätebindung verhindert das bloße Weitergeben einer Lizenzdatei, nicht aber ein gerootetes/umgebautes Gerät.

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| Shop-Lizenzschlüssel | Ed25519-Schlüsselpaar. Privat nur auf dem Server, öffentlich (32 Byte) in der App. |
| Geräteschlüssel | EC-P-256-Schlüsselpaar im Android Keystore, nicht exportierbar, einmal pro Installation erzeugt. |
| Gerätecode | Aus dem öffentlichen Geräteschlüssel abgeleitete Kennung (34 Zeichen). Nur er wird an den Shop übertragen. |
| Bestellnummer (`ord`) | 16 Zeichen Crockford-Base32 (`0-9A-HJKMNP-TV-Z`), 80 Bit Zufall. |
| Lizenz-ID (`lic`) | 16 Zeichen Crockford-Base32, 80 Bit Zufall; bleibt bei einem Umzug gleich. |
| Wiederherstellungscode | 20 Zeichen Crockford-Base32 (100 Bit), nur einmal bei der Bestellung angezeigt; der Shop speichert nur einen Hash. |

## 3. Geräteschlüssel (App, Kotlin)

1. Alias `malachi_geraet_v1` im `AndroidKeyStore`. Existiert er, wird er wiederverwendet; sonst einmalig erzeugen:
   ```kotlin
   val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
   kpg.initialize(
       KeyGenParameterSpec.Builder("malachi_geraet_v1", KeyProperties.PURPOSE_SIGN)
           .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
           .setDigests(KeyProperties.DIGEST_SHA256)
           .build()  // nicht exportierbar (Keystore), keine Nutzer-Authentifizierung noetig
   )
   kpg.generateKeyPair()
   ```
2. Öffentlicher Schlüssel als **SubjectPublicKeyInfo (DER)**: `keyStore.getCertificate("malachi_geraet_v1").publicKey.encoded`. Für P-256 sind das 91 Byte:
   `3059301306072a8648ce3d020106082a8648ce3d030107034200` ‖ `04` ‖ X (32 Byte) ‖ Y (32 Byte).
   (Unkomprimierter Punkt. WebCrypto `exportKey("spki")` liefert dieselben Bytes.)
3. Das Kotlin-Modul gibt der JS-Seite die SPKI-Bytes (z. B. base64) oder direkt den Gerätecode (Abschnitt 4) zurück. Der private Geräteschlüssel wird für die Lizenzprüfung **nicht** benutzt.

**Warum Keystore statt einer gespeicherten Zufalls-ID (Begründung):** Keystore-Schlüssel werden von Android-Backups und Geräteumzügen nicht mitkopiert und bei Deinstallation/„Daten löschen“ entfernt. Eine kopierte App-Sicherung (inkl. gespeicherter Lizenz) wird auf einem anderen Gerät daher nicht stillschweigend gültig. Folge: Nach Neuinstallation entsteht ein neuer Gerätecode – die Lizenz muss mit dem Wiederherstellungscode umgezogen werden (zählt als Aktivierung, siehe Abschnitt 8).

## 4. Gerätecode

```
h     = SHA-256(SPKI-DER)                                   (32 Byte)
kern  = BASE32(h[0..20])                                    (20 Byte -> 32 Zeichen)
pruef = BASE32(SHA-256(ASCII("MALACHI-GERAET|" + kern))[0..5])[0..2]   (2 Zeichen)
code  = kern + pruef                                        (34 Zeichen)
```
- `BASE32` = RFC 4648, Alphabet `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`, Großbuchstaben, **ohne** `=`.
- Anzeige in Vierergruppen mit Bindestrich: `LJ5H-RTFE-UD2C-BWN4-MK5W-NHB4-E5M6-HH3S-E3`.
- Eingabe-Normalisierung (Shop und App): Leerzeichen und `-` entfernen, in Großbuchstaben wandeln, Länge 34 und Alphabet prüfen, Prüfzeichen neu berechnen und vergleichen. Bei Abweichung: ungültig (Tippfehler).

**Verbesserungen gegenüber dem Entwurf (begründet):**
1. *Kürzung auf 160 Bit (32 Zeichen) statt 256 Bit (52 Zeichen):* Wer eine fremde Lizenz nutzen will, bräuchte einen Geräteschlüssel mit gleichem Code – ein zweites Urbild für 160 Bit (≈2^160 Versuche) ist unerreichbar. Kürzere Codes lassen sich im Tor-Browser leichter abtippen/prüfen.
2. *Zwei Prüfzeichen:* Ein Tippfehler im Gerätecode würde sonst eine Lizenz an ein nicht existierendes Gerät binden (Kauf verloren bzw. Aktivierung verbraucht). Mit Prüfzeichen lehnt der Shop fehlerhafte Codes vor der Bestellung ab (Fehlerkennung ≈ 1 − 1/1024).
3. *Domänen-Präfix in der Signatur* (`ML1.` ist Teil der signierten Bytes, Abschnitt 5.3): verhindert, dass eine Signatur des Lizenzschlüssels in einem anderen Zusammenhang wiederverwendet werden kann, und erlaubt spätere Formatversionen.

## 5. Lizenz

### 5.1 Nutzdaten

Ein JSON-Objekt mit **genau** diesen Feldern:

| Feld | Typ | Inhalt |
|---|---|---|
| `v` | Ganzzahl | Formatversion, immer `1` |
| `lic` | Text | Lizenz-ID, 16 Zeichen Crockford-Base32 (`[0-9A-HJKMNP-TV-Z]{16}`) |
| `dev` | Text | Gerätecode (34 Zeichen, gültige Prüfzeichen) |
| `feat` | Liste von Texten | Feature-Kennungen, jede `[a-z][a-z0-9_-]{0,31}`, **aufsteigend sortiert, eindeutig**, 1–16 Einträge; derzeit `["pro"]` |
| `iat` | Ganzzahl | Ausstellungszeit, Unix-Sekunden (1600000000 ≤ iat ≤ 9999999999) |
| `ord` | Text | Bestellnummer, 16 Zeichen Crockford-Base32 |

### 5.2 Kanonisierung

- Schlüssel lexikographisch sortiert (alle Schlüssel sind ASCII): `dev, feat, iat, lic, ord, v`.
- Keine Leerzeichen oder Zeilenumbrüche; Trennzeichen genau `,` und `:`.
- Zahlen: nicht-negative Ganzzahlen in Dezimalschreibweise ohne führende Nullen, ohne Exponent.
- Texte: nur druckbares ASCII ohne `"` und `\` – es kommen daher **nie** Escape-Sequenzen vor.
- Listen in gegebener Reihenfolge (für `feat`: sortiert).
- Kodierung der JSON-Bytes: ASCII (= UTF-8).

Beispiel: `{"dev":"LJ5HRTFEUD2CBWN4MK5WNHB4E5M6HH3SE3","feat":["pro"],"iat":1790000000,"lic":"MA1ACH1TEST00001","ord":"BEST2026TEST0001","v":1}`

### 5.3 Kodierung und Signatur

```
nutzdaten = BASE64URL(kanonisches JSON)
signiert  = ASCII("ML1." + nutzdaten)
signatur  = Ed25519-Signatur (RFC 8032, rein, ohne Prehash) über signiert
LIZENZ    = "ML1." + nutzdaten + "." + BASE64URL(signatur)
```
- `BASE64URL` = RFC 4648 Abschnitt 5 (`A-Z a-z 0-9 - _`), **ohne** `=`. Prüfer akzeptieren nur kanonische Kodierungen (erneutes Kodieren muss exakt denselben Text ergeben).
- Typische Länge ≈ 240 Zeichen, Höchstlänge für Prüfer: 1024 Zeichen.
- Übertragung als Text (Kopieren/Einfügen), QR-Code (Byte-Modus), Datei `malachi-lizenz-<Bestellnummer>.txt` oder Feld `license` der API.

## 6. Prüfung in der App (verbindliche Reihenfolge)

Eingabe vorher mit `trim()` von Leerraum am Rand befreien.

1. Länge ≤ 1024, genau zwei `.`, erster Teil exakt `ML1` → sonst **format**.
2. Teil 2 und 3 streng Base64url-dekodieren; Signatur muss 64 Byte lang sein → sonst **kodierung**.
3. Ed25519-Signatur über die ASCII-Bytes `"ML1." + Teil2` mit jedem eingebauten öffentlichen Schlüssel prüfen; gültig, wenn **einer** passt → sonst **signatur**.
   - `@noble/curves`: `ed25519.verify(signatur, nachricht, oeffentlicherSchluessel, { zip215: false })` (strenge RFC-8032-Prüfung).
4. Nutzdaten als ASCII lesen und als JSON parsen; genau die Felder aus 5.1 mit gültigen Formaten, `v === 1` → sonst **inhalt**.
5. Erneut kanonisch serialisieren; muss byte-genau den Nutzdaten entsprechen → sonst **nicht-kanonisch**.
6. `dev` muss dem eigenen Gerätecode (aus dem Keystore-Schlüssel berechnet) entsprechen → sonst **anderes-geraet**.
7. `feat` muss `"pro"` enthalten → sonst **feature**.

Dann gilt die Lizenz. `iat` wird **nicht** gegen die Uhr geprüft (offline, Uhren unzuverlässig). Unbekannte Features in `feat` werden ignoriert.

Weitere Regeln für die App:
- Öffentliche Schlüssel als Liste einbauen (`LIZENZ_SCHLUESSEL = ['<base64url>']`), damit ein Schlüsselwechsel später möglich ist (alter und neuer Schlüssel gleichzeitig).
- Die Lizenz ist kein Geheimnis, sollte aber im verschlüsselten App-Speicher liegen. Bei jedem Start erneut prüfen (Schritte 1–7).
- Die Referenzimplementierung `src/lizenzpruefer.js` (Funktionen `pruefeLizenz`, `geraetecodeAusSpki`, `geraetecodeNormalisieren`, `geraetecodeGruppieren`) nutzt nur `@noble/curves/ed25519` und `@noble/hashes/sha2` und kann unverändert übernommen werden.

## 7. Feature-Kennungen

- `pro` = Vollversion. **Welche Funktionen „pro“ umfasst, entscheidet ausschließlich die App.** Der Shop kennt keine Funktionsliste.
- Derzeit geplant für `pro`: Duress-PIN/Notfall-PIN mit Löschung und weitere „Extra-Sicherheitsfunktionen“.
- Ausdrücklich **gratis** bleiben: App-PIN, Verschlüsselung, Tor, Gruppen, Dateien, Designs.
- Neue Kennungen nur für künftige, getrennt käufliche Pakete; die App ignoriert ihr unbekannte Kennungen.

## 8. Umzug auf ein neues Gerät

- Beim Kauf erhält der Käufer Bestellnummer + Wiederherstellungscode (Web: einmalige Anzeige; API: Feld `recoveryCode` nur in der Antwort auf die Bestellanlage). Die App sollte den Code lokal speichern **und** dem Nutzer zum Aufschreiben anzeigen (nach Neuinstallation ist der App-Speicher weg).
- Umzug: Bestellnummer + Wiederherstellungscode + neuer Gerätecode → neue Lizenz mit **gleicher** `lic`/`ord`, neuem `dev` und `iat`.
- Höchstens **3 Aktivierungen insgesamt** (konfigurierbar). Ein bereits aktiviertes Gerät erhält seine vorhandene Lizenz erneut, ohne Zählung.
- Nach 5 falschen Codes ist die Bestellung 15 Minuten gesperrt; zusätzlich globale Ratenbegrenzung.

## 9. JSON-API für den In-App-Kauf (über Tor)

Basis-URL: `http://<onion-adresse>.onion` – Aufruf über den Tor-Prozess der App (SOCKS5, Hostname an Tor übergeben, keine lokale DNS-Auflösung). Anfragen und Antworten: `Content-Type: application/json`, UTF-8, Körper ≤ 2 KB. Fehler immer als `{"error":{"code":"…","message":"…"}}` (deutsche Meldung) ohne interne Details.

### Zahlungswege

| `paymentMethod` | `currency` | Zahlung | Adresse | `amount` |
|---|---|---|---|---|
| `xmr` | `XMR` | Monero, View-only-Wallet (eigene Subadresse je Bestellung) | Subadresse `8…` (95 Zeichen) | Dezimaltext, mind. 6 Nachkommastellen (`0.006149`) |
| `btc` | `BTC` | Bitcoin on-chain, Watch-only-zpub (BIP84) | native SegWit P2WPKH, Mainnet: `bc1q…` (42 Zeichen, Kleinbuchstaben) | Dezimaltext mit **genau 8** Nachkommastellen (`0.00004087`) |

Beide Wege können gleichzeitig aktiv sein; der Käufer wählt (Webseite: Auswahlfeld, App: „Bezahlen mit“). Ein abgeschalteter Weg erscheint nicht in `/api/v1/info` und wird bei `POST /api/v1/orders` mit `invalid_payment_method` abgelehnt. Ein externer Zahlungsdienst (`extern`, siehe `src/zahlung/extern.js`) kann zusätzlich auftauchen – die App ignoriert ihr unbekannte Kennungen.

**Bitcoin im Shop (verbindliches Verhalten):**
- Je Bestellung eine eigene Empfangsadresse `m/84'/0'/k'/0/i` (k = Konto der zpub), lokal aus der zpub abgeleitet. Der Server kennt keinen privaten Schlüssel.
- Betrag = 2,99 € geteilt durch den Median-Kurs (≥ 2 Quellen über Tor), **aufgerundet auf ganze Satoshi**, mindestens 546 sat (Staubgrenze). Der Kurs wird bei der Anlage festgeschrieben (`eurRate`, `rateFetchedAt`).
- Zahlungseingänge: mempool.space-API über Tor (Onion-Adresse). Gezählt werden alle Ausgänge an die Adresse (mehrere Teilzahlungen erlaubt). `paid` erst, wenn die Summe mit mindestens `minConfirmations` Bestätigungen den Betrag erreicht; Zahlungen im Mempool ergeben höchstens `unconfirmed`.
- `missing` ist der noch zu zahlende Rest; liegt er unter 546 sat, nennt der Shop **0.00000546** (kleinere Beträge lassen sich nicht senden; der Überschuss gilt als Überzahlung). Überzahlung wird akzeptiert und gebucht.
- `confirmations`: `0`, solange etwas im Mempool liegt; sonst die kleinste Bestätigungszahl, wenn der Shop die Blockhöhe kennt (`minConfirmations` > 1), andernfalls `null`.
- Adressen: Eine Adresse, die je eine Transaktion hatte (auch nur im Mempool), wird **nie** wieder vergeben. Eine unbezahlte Adresse wird nach `bestellung.adresseReserviertStunden` (Standard 72 h) und einer letzten Prüfung für eine neue Bestellung wiederverwendet.
- Gap-Limit: Es sind höchstens `zahlungswege.btc.gapLimit − 1` unbezahlte Bitcoin-Bestellungen gleichzeitig offen (Standard 19), damit das Wallet des Betreibers jede Zahlung findet. Darüber hinaus antwortet der Shop mit `503 busy` – Monero bleibt dann möglich.

### `GET /api/v1/info`
```json
{"product":"Malachi Vollversion","priceEur":"2.99",
 "paymentMethods":[{"id":"xmr","currency":"XMR","name":"Monero"},{"id":"btc","currency":"BTC","name":"Bitcoin"}],
 "defaultPaymentMethod":"xmr","minConfirmations":1,"maxActivations":3,"consentRequired":true,
 "consentText":"Ich verlange ausdrücklich, dass …","licenseFormat":"ML1","licensePublicKeys":["<base64url>"]}
```
`paymentMethods` nennt nur die aktiven Wege, `defaultPaymentMethod` den vorausgewählten. `licensePublicKeys` dient nur der Anzeige/Kontrolle – die App vertraut **ausschließlich** ihren eingebauten Schlüsseln.

### `POST /api/v1/orders`
Anfrage: `{"deviceCode":"LJ5H-RTFE-…","consent":true,"paymentMethod":"xmr"}` bzw. `"paymentMethod":"btc"` (`paymentMethod` optional, Standard ist `defaultPaymentMethod`; unbekannt oder abgeschaltet → `400 invalid_payment_method`; `consent` muss `true` sein, wenn `consentRequired` – die App zeigt dazu `consentText` mit Kontrollkästchen).
Antwort `201` (Monero):
```json
{"orderId":"…16 Zeichen…","status":"pending","paymentMethod":"xmr","currency":"XMR",
 "expiresAt":"2026-10-16T12:00:00.000Z","minConfirmations":1,
 "address":"8…","amount":"0.006149","amountAtomic":"6149000000","amountXmr":"0.006149",
 "paymentUri":"monero:8…?tx_amount=0.006149","eurPrice":"2.99","eurRate":"486.27",
 "rateMethod":"Median aus 2 Quellen","rateFetchedAt":"…","received":"0.000000","missing":"0.006149",
 "confirmations":null,"recoveryCode":"…20 Zeichen…"}
```
Antwort `201` (Bitcoin; Werte des BIP84-Testvektors, nie echt bezahlen):
```json
{"orderId":"…16 Zeichen…","status":"pending","paymentMethod":"btc","currency":"BTC",
 "expiresAt":"2026-10-16T12:00:00.000Z","minConfirmations":1,
 "address":"bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu","amount":"0.00004087","amountAtomic":"4087",
 "paymentUri":"bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.00004087","eurPrice":"2.99","eurRate":"73174.00",
 "rateMethod":"Median aus 2 Quellen","rateFetchedAt":"…","received":"0.00000000","missing":"0.00004087",
 "confirmations":null,"recoveryCode":"…20 Zeichen…"}
```
`amountAtomic`: Piconero (XMR) bzw. Satoshi (BTC). `amountXmr` gibt es nur bei Monero. `paymentUri` (Monero `monero:<adresse>?tx_amount=<betrag>`, Bitcoin BIP21 `bitcoin:<adresse>?amount=<betrag>`) ist für die Webseite gedacht – die App baut die URI selbst.

### `GET /api/v1/orders/:orderId`
Gleicher Aufbau ohne `recoveryCode`. `status`: `pending` (offen) · `underpaid` (unterzahlt, `missing` > 0, Rest an dieselbe Adresse) · `unconfirmed` (im Pool bzw. zu wenige Bestätigungen) · `paid` · `expired` (nicht mehr zahlen!). Bei `paid` zusätzlich: `license`, `licenseId`, `licensedDevice`, `invoiceNumber`, `activations`, `maxActivations`. `paymentMethod`, `currency` und `address` einer Bestellung ändern sich nie. Empfohlenes Abfrageintervall: 30–60 s.

### Prüfregeln der App (jede Shop-Antwort gilt als nicht vertrauenswürdig)
- `paymentMethod`/`currency` nur als Paar `xmr`/`XMR` oder `btc`/`BTC` (bei Monero darf `paymentMethod` fehlen); die Antwort muss die angefragte bzw. gespeicherte Zahlungsart haben, die Adresse darf sich zwischen zwei Abfragen nicht ändern.
- Bitcoin-Adresse: genau `bc1q` + 38 Zeichen aus dem bech32-Alphabet, Witness-Version 0 mit 20-Byte-Programm (P2WPKH) und gültiger **bech32**-Prüfsumme nach BIP173 (nicht bech32m). Abgelehnt werden Testnet/Regtest (`tb1…`, `bcrt1…`), Taproot (`bc1p…`), P2WSH, Legacy (`1…`, `3…`), Großschreibung.
- Bitcoin-Betrag: Dezimaltext ohne Exponent und führende Nullen, höchstens 8 Nachkommastellen, zu zahlende Beträge 1 sat bis 0,001 BTC (Plausibilitätsgrenze der App).
- Die Zahlungs-URI für QR-Code und Wallet-App baut die App aus der geprüften Adresse und dem geprüften Betrag; `paymentUri` und Texte aus der Antwort werden nie angezeigt oder geöffnet.

### `POST /api/v1/transfer`
Anfrage: `{"orderId":"…","recoveryCode":"…","deviceCode":"…"}` → `200 {"orderId","license","licenseId","activations","maxActivations","newActivation"}`.

### Fehlercodes
| HTTP | `code` | Bedeutung |
|---|---|---|
| 400 | `consent_required`, `invalid_device_code`, `invalid_payment_method`, `invalid_json` | Eingabe prüfen |
| 403 | `invalid_order_or_recovery_code` | Bestellnummer/Code falsch oder Bestellung nicht bezahlt |
| 404 | `not_found` | Bestellung unbekannt bzw. gelöscht |
| 409 | `activation_limit_reached` | Höchstzahl an Geräten erreicht |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` | Anfrage zu groß / falscher Typ |
| 429 | `rate_limited`, `temporarily_locked` | später erneut (Kopfzeile `Retry-After`) |
| 503 | `exchange_rate_unavailable`, `payment_backend_unavailable`, `busy` | später erneut (`busy` auch: zu viele offene Bitcoin-Bestellungen – Gap-Limit; Monero geht weiter) |
| 500 | `internal_error` | später erneut |

## 10. Testvektoren

**Test-Lizenzschlüssel** (RFC 8032, Abschnitt 7.1, TEST 1 – öffentlich bekannt, nur für Tests):
- privater Seed (hex): `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`
- öffentlich (hex): `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a`
- öffentlich (base64url): `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo`

Der Shop verweigert den Start mit diesem Schlüssel (außer im Testmodus).

**Gerät A** – P-256-Testschlüssel aus RFC 6979 A.2.5 (privat `c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721`):
- SPKI (hex): `3059301306072a8648ce3d020106082a8648ce3d0301070342000460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299`
- SHA-256(SPKI): `5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4`
- Gerätecode: `LJ5HRTFEUD2CBWN4MK5WNHB4E5M6HH3SE3` (Anzeige `LJ5H-RTFE-UD2C-BWN4-MK5W-NHB4-E5M6-HH3S-E3`)

**Gerät B** – P-256 mit privatem Skalar 1 (öffentlicher Punkt = Basispunkt G):
- SPKI (hex): `3059301306072a8648ce3d020106082a8648ce3d030107034200046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5`
- SHA-256(SPKI): `5cd252fb0ce8932436faf8ccd1040981b89ee4ad6b9fe9e2a2b7e71aacb27cd3`
- Gerätecode: `LTJFF6YM5CJSINX27DGNCBAJQG4J5ZFNLQ`

**Lizenz A** (`lic` `MA1ACH1TEST00001`, `ord` `BEST2026TEST0001`, `iat` 1790000000, Gerät A):
```
ML1.eyJkZXYiOiJMSjVIUlRGRVVEMkNCV040TUs1V05IQjRFNU02SEgzU0UzIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDAwMDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.Q471nF3EL1ZPeX2ChkgpVXay44Nix0C3DWrnUxc83a02Xphim5y-KFqbNvI7aZVaVpCkMsEQX_G6Dp_mQLEuBQ
```
**Lizenz B** (Umzug derselben Lizenz auf Gerät B, `iat` 1790086400):
```
ML1.eyJkZXYiOiJMVEpGRjZZTTVDSlNJTlgyN0RHTkNCQUpRRzRKNVpGTkxRIiwiZmVhdCI6WyJwcm8iXSwiaWF0IjoxNzkwMDg2NDAwLCJsaWMiOiJNQTFBQ0gxVEVTVDAwMDAxIiwib3JkIjoiQkVTVDIwMjZURVNUMDAwMSIsInYiOjF9.3DUwgiHysO8J3cHsSTGyhQXmDefG6YuUqUvk23KQI60j9E-n-wwjyy3JHk57hrggXZBpgpulUWW7rth6klBgCA
```

**Erwartete Ergebnisse** (mit Testschlüssel als einzigem eingebauten Schlüssel):
| Fall | Ergebnis |
|---|---|
| Lizenz A auf Gerät A | gültig |
| Lizenz B auf Gerät B | gültig |
| Lizenz A auf Gerät B | `anderes-geraet` |
| Lizenz A, in den Nutzdaten `dev` durch Gerät B ersetzt, Signatur unverändert | `signatur` |
| Lizenz A, ein Bit der Signatur gekippt | `signatur` |
| Lizenz A, geprüft mit einem anderen öffentlichen Schlüssel | `signatur` |
| Präfix `ML2.` | `format` |
| `=` an Teil 2 angehängt | `kodierung` |
| korrekt signiert, aber Felder unsortiert oder mit Leerzeichen | `nicht-kanonisch` |
| korrekt signiert, zusätzliches Feld oder `v`=2 | `inhalt` |
| korrekt signiert, `feat` = `["basis"]` | `feature` |

Weitere Kontrollwerte: `BASE32("foobar")` = `MZXW6YTBOI`; `BASE64URL("foob")` = `Zm9vYg`; `Zm9vYh` ist nicht kanonisch und muss abgelehnt werden.
