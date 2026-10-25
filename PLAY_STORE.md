# Malachi im Google Play Store

**Stand:** 19. Oktober 2026 · **Gilt für:** Flavor `play` (Google Play) neben Flavor `web` (eigene Website)

> **Keine Rechtsberatung.** Die Hinweise zu Richtlinien, Steuern und Exportkontrolle sind eine sorgfältige Zusammenstellung nach bestem Wissen (Stand siehe oben). Google ändert Richtlinien und Formulare regelmäßig – vor dem Absenden jeder Erklärung den aktuellen Text in der Play Console bzw. der verlinkten Hilfe lesen.

---

## 0. Auf einen Blick

| | **Website-Variante** (`web`) | **Play-Variante** (`play`) |
|---|---|---|
| App-ID (Paketname) | `com.securecommapp` – **unverändert** | eigener Name `de.malachiapp` (festgelegt 2026-10-20) – **vom Inhaber festzulegen, danach endgültig** (Abschnitt 3) |
| Signatur | bisheriger Release-Schlüssel (`android/keystore.properties`), **nie an Google** | eigener Upload-Schlüssel (`android/keystore-play.properties`); den App-Signaturschlüssel erzeugt und verwahrt Google („Play App Signing“) |
| Vollversion | Shop (Monero/Bitcoin über Tor), signierte Lizenz | **nur** Google Play Billing, Einmalkauf `malachi_pro` |
| Updates | signierte Updates von der Website (`website/UPDATE_FORMAT.md`) | ausschließlich über Google Play |
| Bauen | `cd android; .\gradlew assembleWebRelease` | `cd android; .\gradlew bundlePlayRelease` |
| Ergebnis | `android/app/build/outputs/apk/web/release/app-web-<abi>-release.apk` | `android/app/build/outputs/bundle/playRelease/app-play-release.aab` |
| Debug/Entwicklung | `npm run android` (= `--mode webDebug`) | `npm run android:play` (= `--mode playDebug`) |

**Wichtig:** Beide Varianten sind getrennte Apps, sprechen aber **exakt dasselbe Protokoll** – Kopplung, Chats, Gruppen, Anrufe und Siegel funktionieren zwischen einer Play-Installation und einer Website-Installation (Abschnitt 13). Die Flavors unterscheiden sich nur in Vertrieb und Kauf, nie in Verschlüsselung oder Protokoll.

Die Demo-Variante bleibt erhalten: `.\gradlew assembleWebRelease -PmalachiDemo` (bzw. `assemblePlayDebug -PmalachiDemo`) hängt `.demo` an die App-ID – **Demo-Builds nie hochladen.**

---

## 1. Was der Inhaber in der Play Console tun muss (Kurzfassung)

1. **Paketnamen endgültig festlegen** (Abschnitt 3) und in `android/gradle.properties` eintragen.
2. **Entwicklerkonto als Organisation** mit D-U-N-S-Nummer anlegen und verifizieren lassen (Abschnitt 2), Zahlungsprofil (Händlerkonto) einrichten.
3. **Upload-Schlüssel erzeugen** (Abschnitt 4), offline sichern, `android/keystore-play.properties` anlegen.
4. **App anlegen**, Play App Signing mit **von Google erzeugtem** App-Signaturschlüssel wählen.
5. Erstes AAB in den **internen Test** hochladen (Abschnitt 6) – erst danach lässt sich das In-App-Produkt anlegen.
6. **In-App-Produkt `malachi_pro`** anlegen und aktivieren, **Lizenzschlüssel** (Base64-RSA) kopieren und in `AppConfig.js` → `PLAY_LICENSE_PUBLIC_KEY` eintragen, neu bauen und hochladen (Abschnitt 5).
7. **Lizenztester** eintragen, Testkauf, Erstattung und „Käufe wiederherstellen“ durchspielen.
8. **App-Inhalte** ausfüllen: Datenschutzerklärung, App-Zugriff, Werbung (Nein), Inhaltsbewertung, Zielgruppe, Datensicherheit, Werbe-ID (Nein), **Foreground-Service-Erklärung** und **Vollbild-Intent-Erklärung** (Abschnitte 7–10).
9. **Store-Eintrag** (Abschnitt 11), Grafiken, Länderauswahl, Exportkontroll-Bestätigung (Abschnitt 12).
10. Release-Checkliste (Abschnitt 14) abarbeiten, dann Produktions-Release.

---

## 2. Entwicklerkonto: Organisation mit D-U-N-S

**Warum Organisation statt Privatperson:**
- Neue **private** Konten müssen vor dem ersten Produktions-Release einen **geschlossenen Test mit mindestens 12 Testern über 14 Tage** durchführen. Organisationskonten sind davon ausgenommen.
- Wer In-App-Käufe anbietet, muss ohnehin eine Anschrift angeben, die Google öffentlich im Store zeigt. Bei einer Organisation ist das die Geschäftsanschrift.
- Zum Geschäftsmodell (Kleinunternehmer/Gewerbe) passt ein Organisationskonto ohnehin besser.

**Voraussetzungen:**
- Gewerbeanmeldung bzw. eingetragene Firma (auch Einzelunternehmen möglich).
- **D-U-N-S-Nummer** – kostenlos bei Dun & Bradstreet (Deutschland: über die D&B-Website „D-U-N-S-Nummer beantragen“). Dauer: einige Tage bis etwa 30 Tage. Name und Anschrift müssen **exakt** mit den Angaben in der Play Console übereinstimmen.
- Website der Organisation (die Clearnet-Adresse der Malachi-Website genügt), in der Play Console bzw. Google Search Console bestätigt.
- Kontakt-E-Mail und Telefonnummer der Organisation (werden verifiziert), Ausweis der vertretenden Person.
- Einmalige Registrierungsgebühr (25 US-Dollar).

**Ablauf:** `play.google.com/console/signup` → „Organisation“ → D-U-N-S eingeben → Angaben prüfen lassen → Zahlungsprofil (Händlerkonto) für Verkäufe einrichten: Bankverbindung, Steuerangaben (USt-IdNr. falls vorhanden; US-Steuerformular W-8BEN-E für Organisationen).

**Steuern (Hinweis, mit Steuerberater klären):** Bei Verkäufen über Google Play an Verbraucher in der EU führt Google die Umsatzsteuer ab (Google gilt als leistender Unternehmer gegenüber dem Kunden). Der Inhaber rechnet mit Google Ireland ab. Die Servicegebühr beträgt für die ersten 1 Mio. US-Dollar Umsatz im Jahr 15 %.

---

## 3. Paketname (App-ID) – endgültig!

- Der Paketname der Play-Variante lässt sich **nach dem ersten hochgeladenen App Bundle nie mehr ändern** und auch nie wieder für eine andere App verwenden. Eine Änderung hieße: neue App, alle Nutzer müssten neu installieren.
- Festgelegt (2026-10-20): `de.malachiapp` (eigene Domain `malachiapp.de`, gekauft bei Strato), eingetragen in `android/gradle.properties`. Der zuerst geplante Name `app.malachi` wurde verworfen, weil die Domain `malachi.app` einem anderen Unternehmen gehört.
- Regeln (vom Build geprüft): nur Kleinbuchstaben, Ziffern, `_` und Punkte, mindestens zwei Teile, jeder Teil beginnt mit einem Buchstaben, **nicht** `com.securecommapp` (gehört der Website-Variante).
- Regel: umgekehrte eigene Domain, hier `malachiapp.de` → `de.malachiapp`. Vorher prüfen, ob `https://play.google.com/store/apps/details?id=<name>` frei ist.
- **Festlegen:** in `android/gradle.properties` die vorbereitete Zeile einkommentieren:
  ```properties
  playApplicationId=de.malachiapp
  ```
  Ohne diese Zeile **brechen Release-Builds der Play-Variante bewusst ab** (`bundlePlayRelease`, `assemblePlayRelease`, auch `assembleRelease`, das beide Varianten baut). Debug-Builds laufen mit dem Platzhalter.
- Wird ein anderer Name gewählt: zusätzlich in `package.json` beim Skript `android:play` das `--appId` anpassen.

---

## 4. Signatur: Play App Signing und Upload-Schlüssel

**Prinzip:**
- Google erzeugt und verwahrt den **App-Signaturschlüssel** der Play-Variante („Play App Signing“, beim Anlegen der App die Option *„Von Google generierten Schlüssel verwenden“* wählen). Mit ihm signiert Google die an Nutzer ausgelieferten APKs.
- Hochgeladen wird mit einem eigenen **Upload-Schlüssel**. Geht er verloren, kann er über die Play Console zurückgesetzt werden (Support-Anfrage, einige Tage Wartezeit).
- Der **Website-Release-Schlüssel wird nie an Google gegeben und nie für die Play-Variante benutzt.** Damit kann Google (oder wer Google zu etwas zwingt) keine Updates für die Website-Variante erzeugen. Der Build bricht ab, wenn `keystore-play.properties` auf denselben Schlüsselspeicher oder ein Zertifikat mit demselben SHA-256-Fingerabdruck zeigt wie `keystore.properties`.

**Upload-Schlüssel erzeugen** (einmal, auf dem eigenen PC – JDK-`keytool`, z. B. aus Android Studio `jbr\bin`):

```powershell
keytool -genkeypair -v `
  -keystore D:\malachi-schluessel\malachi-play-upload.jks `
  -storetype PKCS12 `
  -alias malachi-play-upload `
  -keyalg RSA -keysize 4096 `
  -validity 10000 `
  -dname "CN=Malachi Play Upload, O=<Firmenname>, C=DE"
```

- Passwort lang und zufällig (Passwortmanager). Bei PKCS12 sind Speicher- und Schlüsselpasswort gleich.
- Gültigkeit 10 000 Tage (> 27 Jahre) erfüllt Googles Vorgabe (gültig über 2033 hinaus).

**`android/keystore-play.properties`** (steht in `.gitignore`, nie committen; gleiches Format wie `keystore.properties`):

```properties
# Pfad absolut oder relativ zu android/app
storeFile=D:/malachi-schluessel/malachi-play-upload.jks
storePassword=<passwort>
keyAlias=malachi-play-upload
keyPassword=<passwort>
```

Fehlt die Datei, wird die Play-Variante **debug-signiert** und der Build warnt – die Play Console lehnt so ein Bundle ab, ein Versehen fällt also spätestens beim Hochladen auf.

**Offline halten und sichern:**
- Schlüsseldatei auf einem verschlüsselten USB-Stick (z. B. VeraCrypt) aufbewahren, **zweite Kopie** an einem anderen Ort, Passwort im Passwortmanager und zusätzlich auf Papier im Tresor.
- Den Stick nur zum Bauen eines Releases einstecken; danach `keystore-play.properties` wieder entfernen oder den Pfad unerreichbar lassen.
- Nie in Cloud-Ordner, Mails oder Chats.
- Das Upload-Zertifikat kann für die Unterlagen exportiert werden (öffentlich, unkritisch):
  `keytool -export -rfc -keystore D:\malachi-schluessel\malachi-play-upload.jks -alias malachi-play-upload -file upload_certificate.pem`

**Fingerabdrücke veröffentlichen:** Auf der Website beide Zertifikate nennen – Website-Variante (wie bisher, `seite.json` → `apkZertifikatSha256`) und Play-Variante (Play Console → *Testen und veröffentlichen → App-Integrität → App-Signatur*, SHA-256 des **App-Signaturschlüssels**, nicht des Upload-Schlüssels). So können Nutzer jede Installation prüfen.

---

## 5. Vollversion als Einmalkauf über Google Play Billing

### 5.1 Produkt anlegen

Erst möglich, **nachdem ein App Bundle mit der Billing Library hochgeladen wurde** (interner Test genügt, Abschnitt 6).

Play Console → *Monetarisieren mit Play → Produkte → Einmalkaufprodukte* (früher „In-App-Produkte“) → *Produkt erstellen*:

| Feld | Wert |
|---|---|
| Produkt-ID | `malachi_pro` (**endgültig**, entspricht `AppConfig.PLAY_PRODUCT_ID`) |
| Name | Vollversion |
| Beschreibung | Notfall-PIN, Löschen nach 5 Fehlversuchen, Fernlöschung, Modus „Maximal anonym“, Siegel-Modus und 21 Design-Themen. Einmalig, kein Abo. |
| Kaufoption | Standard-Kaufoption „Kaufen“, nicht mehrfach kaufbar |
| Preis | 2,99 EUR (Google rechnet Landespreise um; die App zeigt immer den Preis von Google Play in der Währung des Nutzers) |
| Status | Aktiv |

### 5.2 Lizenzschlüssel eintragen

Play Console → *Monetarisieren mit Play → Monetarisierung einrichten* → Abschnitt **„Lizenzierung“** → *Base64-codierter öffentlicher RSA-Schlüssel* kopieren (eine lange Zeile, beginnt mit `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA`).

In `AppConfig.js` eintragen:

```js
export const PLAY_LICENSE_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…';
```

Der Schlüssel ist öffentlich (kein Geheimnis) und darf ins Repository. Solange er `null` ist, zeigt die Play-Variante „Kauf derzeit nicht verfügbar“ und Pro bleibt gesperrt. Ein falscher oder zu kurzer Schlüssel (< 2048 Bit) wird wie „nicht eingetragen“ behandelt.

### 5.3 So prüft die App einen Kauf – ohne Server

(`PlayPurchase.js`, `LicenseManager.js`, nativ `android/app/src/play/java/com/securecommapp/billing/PlayBillingModule.kt`)

- Google Play signiert die Kaufdaten (`originalJson`) mit dem privaten Schlüssel der App. Die App prüft die Signatur **auf dem Gerät** (RSASSA-PKCS1-v1_5 mit SHA-1, wie Google Play signiert; SHA-256 wird zusätzlich akzeptiert) mit `PLAY_LICENSE_PUBLIC_KEY`.
- Pro wird nur freigeschaltet, wenn **alles** stimmt: Signatur, `packageName` = eigener Paketname, Produkt = `malachi_pro`, Status „gekauft“. **Ausstehende Zahlungen** (z. B. Barzahlung im Laden) schalten nie frei – erst wenn Google Play sie als bezahlt meldet.
- Danach wird der Kauf bei Google **bestätigt** (acknowledge). Unbestätigte Käufe erstattet Google nach drei Tagen automatisch.
- Gespeichert wird nur ein Vermerk im verschlüsselten Speicher: **SHA-256 des Kauf-Tokens**, Produkt-ID, Kaufzeit. Nie das Token selbst, nie Bestellnummer oder Signatur.
- **Bei jedem App-Start** fragt die App ihre Käufe bei Google Play neu ab (`queryPurchases`, funktioniert auch offline aus dem Cache des Play Store). Fehlt der Kauf in einer **echten Antwort** (Erstattung, Rückbuchung), wird Pro lokal entzogen. Antwortet Google Play gar nicht (Play Store deaktiviert, kein Netz), wird **nichts** entzogen – ein eingerichteter Schutz fällt nie wegen eines Funklochs weg.
- Kein Server, keine Google Play Developer API, keine Kontodaten.
- Nach einer Neuinstallation, auf einem neuen Gerät oder nach „Alle Daten löschen“ (auch Duress-Löschung) wird ein alter Kauf **nicht von selbst** wieder aktiv, sondern erst mit **„Käufe wiederherstellen“** (gleiches Google-Konto). So verrät eine frisch gelöschte App nicht von allein, dass es Pro gab. Ein frischer, noch unbestätigter Kauf wird dagegen immer sofort übernommen.

**Bewusste Grenze:** Ohne Server lässt sich nicht prüfen, ob signierte Kaufdaten wirklich zum angemeldeten Google-Konto gehören. Die Prüfung schützt gegen gefälschte Käufe durch manipulierte Billing-Dienste („Freikauf-Apps“), nicht gegen jemanden mit voller Kontrolle über das eigene, gerootete Gerät. Bei 2,99 EUR ist das vertretbar.

### 5.4 Testen

- Play Console → *Einstellungen → Lizenztests*: Google-Konten der Tester eintragen, Lizenzantwort „RESPOND_NORMALLY“.
- Tester installieren die App über den Opt-in-Link des internen Tests (Abschnitt 6) und kaufen mit den Testzahlungsmitteln („Testkarte, immer genehmigt“, „… immer abgelehnt“, „… langsam“ für eine **ausstehende** Zahlung) – es wird nichts abgebucht.
- Durchspielen:
  1. Kauf → „Vollversion aktiv“, Notfall-PIN einrichtbar.
  2. Kauf abbrechen → „Kauf abgebrochen.“
  3. „langsame“ Testkarte → „Zahlung ausstehend“, **kein** Pro; nach Abschluss → Pro.
  4. Play Console → *Bestellungen* → Kauf **erstatten** (mit „Berechtigung entziehen“) → App neu starten → Pro weg, Hinweis „erstattet“.
  5. App deinstallieren/neu installieren → Gratis-Version → „Käufe wiederherstellen“ → Pro.
  6. Flugmodus beim Start mit aktivem Pro → Pro bleibt.

---

## 6. Interner Test

1. Bauen: `cd android; .\gradlew bundlePlayRelease` (mit `playApplicationId` in `gradle.properties` und `keystore-play.properties`).
2. Play Console → *Testen und veröffentlichen → Testen → Interner Test* → Release erstellen → `app-play-release.aab` hochladen.
3. Tester-Liste (bis 100 Google-Konten) anlegen, Opt-in-Link an die Tester geben.
4. `versionCode` in `android/app/build.gradle` muss bei **jedem** Upload steigen (gilt für beide Varianten – am besten dieselbe Version für beide aus demselben Commit).
5. Der Pre-Launch-Bericht (automatische Tests auf Google-Geräten) startet die App; dass Tor dort teils nicht verbindet, ist kein Fehler der App.

---

## 7. Berechtigungen und Erklärungen in der Play Console

Geprüft gegen `android/app/src/main/AndroidManifest.xml`, `src/play/AndroidManifest.xml` und die Manifeste der Bibliotheken.

| Berechtigung | Wofür | Play Console / Richtlinie |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE` | Tor, WebRTC, Portfreigabe am eigenen Router (PCP/NAT-PMP/UPnP im lokalen Netz) – kein STUN | normal, keine Erklärung |
| `CAMERA` | QR-Code scannen, Videoanrufe, Fotos | Laufzeitberechtigung, keine Erklärung |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Sprachnachrichten, Anrufe | Laufzeitberechtigung, keine Erklärung |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Standort **auf Wunsch** an einen Kontakt senden (nur Koordinaten, Ende-zu-Ende) | nur Vordergrund (kein `ACCESS_BACKGROUND_LOCATION`) → keine Standort-Erklärung (Datensicherheit: Abschnitt 8) |
| `USE_BIOMETRIC`, `USE_FINGERPRINT` | Entsperren per Fingerabdruck | normal |
| `POST_NOTIFICATIONS` | Nachrichten, Anrufe, Dienst-Benachrichtigung | Laufzeitberechtigung |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_REMOTE_MESSAGING` | `MalachiService` hält die P2P-/Tor-Verbindung für den Empfang | **Erklärung „Foreground-Service-Berechtigungen“ nötig** (Text unten, Video verlangt) |
| `USE_FULL_SCREEN_INTENT` | eingehender Anruf auf dem Sperrbildschirm | **Erklärung „Vollbild-Intents“ nötig**, Kernfunktion „Anrufe“ (Text unten). Ab Android 14 gewährt Google sie nur Anruf-/Wecker-Apps. |
| `MANAGE_OWN_CALLS` | eigener ConnectionService (Android-Anrufoberfläche) | normal, keine Erklärung |
| `RECEIVE_BOOT_COMPLETED` | Dienst nach Neustart wieder starten | normal |
| `WAKE_LOCK` | kurze Hintergrund-Syncs | normal |
| `WRITE_EXTERNAL_STORAGE` (nur bis Android 10) | Bild in Galerie speichern auf alten Geräten | keine Erklärung |
| `READ_EXTERNAL_STORAGE` (aus `react-native-camera-kit`) | ab Android 13 wirkungslos | keine Erklärung |
| `READ_MEDIA_IMAGES` | – | **in der Play-Variante entfernt** (`src/play/AndroidManifest.xml`). Die App nutzt die System-Fotoauswahl und fragt die Berechtigung nirgends an; mit ihr wäre die Erklärung „Fotos und Videos“ nötig, die Messenger regelmäßig abgelehnt bekommen. |
| `com.android.vending.BILLING` | Google Play Billing | kommt aus der Billing Library, nur Play-Variante |
| `com.google.android.gms.permission.AD_ID` | – | in der Play-Variante ausdrücklich entfernt → Werbe-ID-Erklärung: **Nein** |
| `REQUEST_INSTALL_PACKAGES` | – | **nicht** in der Play-Variante. Gehört später (Updater) nur nach `src/web/AndroidManifest.xml`. |

**Erklärung Foreground Service (Typ „Remote messaging“)** – Play Console → *App-Inhalte → Foreground-Service-Berechtigungen* (englisch einreichen):

> Malachi is an end-to-end encrypted messenger without any server and without push notifications (no FCM). Messages and calls are delivered directly between the users' devices over the Tor network and WebRTC. The foreground service (type remoteMessaging) keeps the encrypted peer-to-peer connection to the user's contacts open so that incoming messages and calls are received, and queued outgoing messages are delivered, while the app is in the background. It runs only after the user has completed setup and always shows a persistent notification. If the service were deferred or interrupted, messages and calls from contacts would not arrive until the user reopens the app, because there is no server that could store or push them.

Video (Pflicht): kurze Bildschirmaufnahme – App im Hintergrund, Dienst-Benachrichtigung sichtbar, Nachricht von einem zweiten Gerät kommt an.

**Erklärung Vollbild-Intent:** Kernfunktion **„Anrufe (Sprach-/Videoanrufe)“**:

> Malachi offers end-to-end encrypted voice and video calls. USE_FULL_SCREEN_INTENT is used only to show the incoming-call screen on the lock screen (self-managed ConnectionService), so that the user can accept or decline a call.

---

## 8. Datensicherheit (Data safety) – Antworten nach dem, was die App wirklich tut

### 8.1 Was die App tatsächlich überträgt

| Was | Wohin | Bewertung |
|---|---|---|
| Nachrichten, Bilder, Dateien, Sprachnachrichten, Anrufe, Standort (exakt), Gruppen | **direkt an den Kontakt**, Ende-zu-Ende-verschlüsselt (Tor bzw. WebRTC) | Kein Entwickler-Server, niemand dazwischen kann mitlesen. Laut Googles Hilfe zur Datensicherheit müssen Ende-zu-Ende-verschlüsselt übertragene Daten nicht als „erhoben“ angegeben werden; vom Nutzer veranlasste Übertragungen an andere Nutzer zählen nicht als „Weitergabe“. **Vor dem Ausfüllen die aktuelle Formulierung in der Hilfe prüfen.** |
| IP-Adresse | Tor-Eintrittsknoten (bzw. Bridge; die Bridge Snowflake fragt dabei eigene STUN-Server des Tor-Projekts); im Verbindungsweg „Direkt, wenn möglich“ der Kontakt – schon beim Versuch einer Direktverbindung | Technisch nötig für jede Internetverbindung, nichts wird beim Entwickler gespeichert. Die IP-Adresse ist im Formular keine eigene Datenkategorie – in der Datenschutzerklärung nennen. **Seit dem STUN-Ausstieg (Version nach 1.1.0) fragt Malachi selbst keinen STUN-Dienst mehr** (bis 1.1.0: je Verbindung zwei von vier öffentlichen STUN-Diensten im Verbindungsweg „Schnell“). |
| Ungefährer Standort | **– (nicht mehr übertragen)** | Bis 1.1.0 ging beim Senden eines Standorts eine auf ~100 m gerundete Position an OpenStreetMap Nominatim (Ortsname). Seit dem STUN-Ausstieg entfernt: der Standort geht nur noch als Koordinaten Ende-zu-Ende an den Kontakt (Test `location.noNominatim.test.js`). |
| Kaufdaten | Google Play (Zahlung) | Wickelt Google ab; die App sendet nichts an den Entwickler und speichert nur lokal einen Token-Hash. |
| ML-Kit-Nutzungsmetriken | Google (`firebaselogging`) | ML Kit im QR-Scanner (`react-native-camera-kit` → `com.google.mlkit:barcode-scanning`) sendet laut Google Leistungs-/Nutzungsdaten. **In beiden Varianten abgeschaltet** (`src/main/AndroidManifest.xml`: Backend „cct“ entfernt, der Uploader verwirft die Ereignisse). **Nach dem Build prüfen** (8.3). |
| Analyse, Werbung, Absturzberichte, Konto, Kontakte-Upload | – | gibt es nicht |

### 8.2 Formular

**Ab der Version nach 1.1.0 (STUN-Ausstieg, Entscheidung E5: Ortsnamen per Nominatim immer aus):** Kein Standort und keine anderen Nutzerdaten verlassen das Gerät mehr unverschlüsselt bzw. an Dritte. **Beim Veröffentlichen dieser Version das Formular in der Play Console umstellen** (das macht der Inhaber; bis 1.1.0 galt die frühere Option A mit „Ungefährer Standort, geteilt mit OpenStreetMap“).

| Frage | Antwort |
|---|---|
| Erhebt oder teilt die App Nutzerdaten der erforderlichen Typen? | **Nein** („Erhebt oder teilt keine Nutzerdaten“) – Nachrichten, Medien, Audio, Dateien und der exakte Standort gehen nur Ende-zu-Ende an Kontakte (zählt nicht als Erhebung/Weitergabe) |
| Daten bei der Übertragung verschlüsselt? | **Ja** (Ende-zu-Ende) |
| Können Nutzer das Löschen ihrer Daten beantragen? | Der Entwickler speichert keine Daten. In der App: *Einstellungen → Alle Daten löschen* löscht alles auf dem Gerät (auch die lokale Verbindungs-Diagnose). |
| Unabhängige Sicherheitsprüfung | Nein (optional) |
| Konto-Erstellung / Kontolöschung | Die App hat **keine Konten** → „Nein“, kein Löschlink nötig |

Vorbehalt ML Kit: gilt nur, wenn die Prüfung in 8.3 bestätigt, dass keine Nutzungsdaten an Google gehen. Die Verbindungs-Diagnose (Einstellungen → Verbindungs-Diagnose) zählt nur lokal und sendet nichts – sie ist keine Erhebung.

### 8.3 ML Kit nachprüfen (einmal nach dem ersten Build)

- In `android/app/build/intermediates/merged_manifests/playRelease/…/AndroidManifest.xml` (und `webRelease`) darf `backend:com.google.android.datatransport.cct.CctBackendFactory` **nicht** mehr vorkommen.
- Gegenprobe am Gerät: QR-Code scannen, dabei mit einer lokalen Firewall (z. B. NetGuard/RethinkDNS im Protokollmodus) prüfen, dass **keine** Verbindung zu `firebaselogging.googleapis.com` / `firebaselogging-pa.googleapis.com` entsteht.
- Falls doch: ML Kit muss im Formular unter *App-Infos und -Leistung → Diagnose* (erhoben, Zweck Analyse, von Google) angegeben werden – oder der QR-Scanner wird auf eine Bibliothek ohne Google-Abhängigkeit (z. B. ZXing) umgestellt.
- Unabhängig davon: Das ebenfalls von `react-native-camera-kit` eingebundene `play-services-mlkit-face-detection` lädt sein Modell über die Google-Play-Dienste nach, **wenn** es genutzt wird. Der QR-Scanner nutzt nur die Barcode-Erkennung (Modell in der APK). Was die Google-Play-Dienste als Systemkomponente selbst protokollieren, kann die App nicht steuern.

### 8.4 Datenschutzerklärung

Pflicht: öffentliche **HTTPS-URL** (Clearnet-Website). Sie muss die Play-Variante abdecken: kein Konto, keine Analyse, P2P/Tor, kein STUN-Dienst (nur die Bridge Snowflake nutzt eigene STUN-Server des Tor-Projekts), kein Kartendienst/Nominatim mehr, Google Play Billing (Zahlung durch Google, lokal nur Token-Hash), ML Kit (abgeschaltet), lokale Speicherung, „Alle Daten löschen“. (Stand der Website-Texte: `website/site/datenschutz.html`, 25.10.2026 – zusammen mit dieser Version veröffentlichen.)

---

## 9. Inhaltsbewertung (IARC-Fragebogen)

- Kategorie: **„Soziale Netzwerke, Foren, Messenger, Kommunikation …“** (bzw. „Kommunikation“).
- Wahrheitsgemäß beantworten: Nutzer können miteinander kommunizieren und Inhalte austauschen (**Ja**), Nutzer können ihren Standort mit anderen teilen (**Ja**), digitale Käufe (**Ja**, In-App-Kauf), keine Gewalt-/Glücksspiel-/Drogen-Inhalte der App selbst, keine Moderation (Ende-zu-Ende-verschlüsselt, keine öffentlichen Inhalte).
- Die Altersfreigabe (USK/PEGI) ergibt sich aus dem Fragebogen; erwartbar sind die interaktiven Hinweise „Nutzer interagieren“, „Standortweitergabe“, „In-App-Käufe“.

## 10. Zielgruppe und weitere App-Inhalte

| Punkt | Antwort |
|---|---|
| Zielgruppe | **18 und älter** (alternativ 16+); nicht für Kinder gestaltet → keine „Familien“-Richtlinie |
| Spricht die App Kinder an? | Nein |
| Werbung | **Nein** |
| Werbe-ID | **Nein** (AD_ID entfernt) |
| App-Zugriff | „Alle Funktionen ohne Anmeldung verfügbar. Beim ersten Start eine App-PIN festlegen. Zum Testen eines Chats zweites Gerät koppeln (Einstellungen/Kontakt verbinden → QR-Code). Die Vollversion kann mit einem Lizenztester-Konto getestet werden.“ |
| Nachrichten-App / Gesundheit / Finanzen / Behörden-App | Nein |
| Konto-Löschung | keine Konten → nicht zutreffend |
| Kinderschutz-Standards (CSAE) | Gilt verpflichtend für die Kategorien „Soziale Netzwerke“ und „Dating“. Kategorie **„Kommunikation“** wählen. Falls Google trotzdem nachfragt: Meldeweg (E-Mail-Adresse für Meldungen), „Chat/Kontakt löschen“ in der App (beendet die Verbindung – eine eigene Blockier-Funktion gibt es noch nicht) und eine kurze Richtlinie auf der Website bereithalten. |

---

## 11. Store-Eintrag – ohne Hinweis auf andere Zahlungswege

Grundregeln (Zahlungs- und Metadaten-Richtlinie): **kein** Hinweis auf Shop, Website-Kauf, Monero, Bitcoin, Onion-Adressen oder „günstiger woanders“; keine Superlative („sicherster Messenger“, „Nr. 1“); keine fremden Markennamen (im Store **nicht** „WhatsApp“ schreiben – in der App bleibt „für WhatsApp & Co.“ als Beschreibung des Siegel-Modus).

### Deutsch

**App-Name (max. 30):** `Malachi – Privater Messenger`

**Kurzbeschreibung (max. 80):** `Privat schreiben und telefonieren – ohne Server, ohne Telefonnummer, über Tor.`

**Vollständige Beschreibung:**

```
Malachi ist ein Messenger für alle, denen Privatsphäre wichtig ist. Es gibt keinen Malachi-Server, kein Konto und keine Telefonnummer: Nachrichten, Anrufe und Dateien gehen Ende-zu-Ende-verschlüsselt direkt von Gerät zu Gerät.

SO FUNKTIONIERT ES
• Kontakte verbindest du einmalig per QR-Code oder Einladungslink.
• Die Verbindung läuft über das Tor-Netzwerk und – wenn du es erlaubst – direkt per WebRTC.
• Nachrichten, Bilder und Dateien: Ende-zu-Ende-Verschlüsselung mit zusätzlichem Post-Quanten-Schlüsselaustausch.
• Anrufe: Ende-zu-Ende-verschlüsselt (DTLS-SRTP), noch ohne Post-Quanten-Schutz.
• Sicherheitscode zum Abgleichen mit deinem Kontakt.
• Was gerade nicht zugestellt werden kann, wartet verschlüsselt auf deinem Gerät.

KOSTENLOS
• Chats, Gruppen, Bilder, Dateien und Sprachnachrichten
• Verschlüsselte Sprach- und Videoanrufe
• App-PIN und Fingerabdruck
• Tor mit Bridges (obfs4, Snowflake, meek, WebTunnel)
• Selbstlöschende Nachrichten, Einmal-Medien, Secret Chat
• Siegel-Nachrichten öffnen und entschlüsseln

VOLLVERSION – einmaliger In-App-Kauf, kein Abo
• Notfall-PIN: löscht unbemerkt alle Daten, wenn dich jemand zum Entsperren zwingt
• Löschen nach 5 falschen PIN-Eingaben
• Fernlöschung: verbundene Kontakte erfahren, dass dein Chat zurückgesetzt wurde
• „Maximal anonym“: Verbindungen ausschließlich über Tor
• Siegel-Modus: Texte, Bilder und Dateien für andere Messenger und E-Mail verschlüsseln
• 21 Design-Themen

DATENSCHUTZ
• Keine Werbung, keine Analyse-Dienste, kein Tracking
• Kein Konto, keine Telefonnummer, kein Hochladen des Adressbuchs
• Kein Malachi-Server – niemand dazwischen sieht Nachrichten oder Kontakte
• Keine STUN-Dienste: Malachi fragt keinen fremden Server nach deiner Adresse (nur die Tor-Brücke Snowflake nutzt in gesperrten Netzen eigene)

Hinweis: Beide Gesprächspartner brauchen Malachi. Nachrichten werden zugestellt, sobald beide Geräte online sind.
```

### English

**App name (max 30):** `Malachi – Private Messenger`

**Short description (max 80):** `Private messaging and calls – no servers, no phone number, routed over Tor.`

**Full description:**

```
Malachi is a messenger for people who care about privacy. There is no Malachi server, no account and no phone number: messages, calls and files travel end-to-end encrypted directly from device to device.

HOW IT WORKS
• Connect with a contact once by QR code or invitation link.
• Connections run over the Tor network and – if you allow it – directly via WebRTC.
• Messages, photos and files: end-to-end encryption with an additional post-quantum key exchange.
• Calls: end-to-end encrypted (DTLS-SRTP), not yet post-quantum protected.
• Safety code to verify your contact.
• Anything that cannot be delivered right now waits encrypted on your device.

FREE
• Chats, groups, photos, files and voice messages
• Encrypted voice and video calls
• App PIN and fingerprint unlock
• Tor with bridges (obfs4, Snowflake, meek, WebTunnel)
• Disappearing messages, view-once media, secret chat
• Open and decrypt Siegel messages

FULL VERSION – one-time in-app purchase, no subscription
• Duress PIN: silently wipes all data if someone forces you to unlock
• Wipe after 5 wrong PIN attempts
• Remote wipe notice: connected contacts see that your chat was reset
• "Maximum anonymity": connections over Tor only
• Siegel mode: encrypt texts, images and files for other messengers and e-mail
• 21 design themes

PRIVACY
• No ads, no analytics, no tracking
• No account, no phone number, no address book upload
• No Malachi server – nobody in between sees messages or contacts
• No STUN services: Malachi asks no outside server for your address (only the Tor bridge Snowflake uses its own on blocked networks)

Note: both people need Malachi. Messages are delivered as soon as both devices are online.
```

**Grafiken:** App-Symbol 512 × 512 px, Vorstellungsgrafik 1024 × 500 px, mindestens 2 (besser 4–8) Smartphone-Screenshots – auf Screenshots keine Shop-/Krypto-Seiten der Website-Variante zeigen (immer mit der Play-Variante aufnehmen).

**Kategorie:** Kommunikation. **Kontakt:** E-Mail-Adresse (Pflicht), Website.

---

## 12. Exportkontrolle und Verschlüsselung

- Beim Anlegen der App bestätigt man in der Play Console, dass die App **US-Exportgesetzen** entspricht – Google verteilt aus den USA, deshalb gelten die US Export Administration Regulations (EAR) zusätzlich zum EU-Recht.
- Malachi nutzt Verschlüsselung (u. a. X25519, ML-KEM/Kyber, AES-GCM, HKDF; Tor). Es handelt sich um **standardisierte** Verfahren in einer frei erhältlichen Verbraucher-App. Nach Einschätzung fällt das unter **„Mass Market“** (US: ECCN 5D992.c, License Exception ENC § 740.17(b)(1); seit der BIS-Änderung von 2021 für solche Apps in der Regel **ohne** jährlichen Self-Classification-Report). Ist der Quellcode öffentlich zugänglich, kann er zudem nach § 742.15(b) EAR außerhalb der EAR liegen (Meldepflicht nur bei nicht-standardisierter Kryptografie).
- EU/Deutschland: Dual-Use-Verordnung (EU) 2021/821, Anhang I Kategorie 5 Teil 2 – **Kryptotechnik-Anmerkung (Anm. 3, Massenmarkt)** bzw. **Allgemeine Software-Anmerkung** für öffentlich zugängliche Software → nach Einschätzung keine Genehmigungspflicht. Sanktionen beachten: Google sperrt embargierte Gebiete selbst; Länderauswahl in der Play Console bewusst prüfen.
- Frankreich verlangt für manche Verschlüsselungsprodukte eine Erklärung bei der ANSSI (Apple fragt danach, Google nicht).
- **Vor dem Start einmal fachkundig bestätigen lassen** (siehe auch `RECHT_KRYPTOZAHLUNG.md`, offene Punkte zur Exportkontrolle).

---

## 13. Website- und Play-Version sprechen miteinander

- **Gleiches Protokoll:** Kopplung (QR/Einladungslink `malachi://connect/…`), Tor-Onion-Dienste, Direkt-Upgrade per WebRTC, Ende-zu-Ende-Verschlüsselung, Gruppen, Anrufe, Siegel-Nachrichten und der Sicherheitscode sind in beiden Varianten Code-identisch (`src/main` und dasselbe JS-Bundle). Nur Vertrieb und Kauf unterscheiden sich (`Distribution.js`, `LicenseManager.js`, `PlayProScreen.tsx`, Flavor-Ordner `src/web` / `src/play`).
- **Regel für Entwickler:** Nie eine Protokoll- oder Krypto-Änderung hinter `isPlay()`/`isWeb()` oder in einen Flavor-Ordner legen. `__tests__/license/*.play*` prüft nur Kauf/Anzeige.
- **Beide Varianten aus demselben Commit veröffentlichen** (gleiche `versionName`/`versionCode`). Weil die Play-Prüfung Stunden bis Tage dauern kann, müssen Protokolländerungen rückwärtskompatibel sein (alte und neue Version verstehen sich), bis beide Varianten ausgeliefert sind.
- **Vollversion je Variante:** Eine Shop-Lizenz gilt nur in der Website-Variante, ein Play-Kauf nur in der Play-Variante. Pro-Funktionen wirken nur lokal (Notfall-PIN, Sperren, Designs, Siegel verschlüsseln, „Maximal anonym“) – mit wem man schreibt, hängt nie davon ab. Siegel-Nachrichten **entschlüsseln** ist in beiden Varianten gratis.
- **Beide auf einem Gerät:** möglich (verschiedene App-IDs, getrennte Daten und Schlüssel, zwei Identitäten). Beim Öffnen eines Einladungslinks fragt Android dann, welche App ihn öffnen soll.
- **Wechsel Website → Play:** Daten werden nicht übernommen (getrennte Apps, Schlüssel verlassen das Gerät nie). In der neuen App die Kontakte neu koppeln, danach die alte App löschen („Alle Daten löschen“).
- **Fingerabdrücke:** zwei verschiedene Signaturzertifikate (Abschnitt 4) – beide auf der Website veröffentlichen.

---

## 14. Release-Checkliste (Play-Variante)

- [ ] `playApplicationId` in `android/gradle.properties` gesetzt und **bestätigt** (endgültig).
- [ ] `android/keystore-play.properties` vorhanden, zeigt auf den Upload-Schlüssel (nie auf den Website-Schlüssel – der Build prüft das).
- [ ] `AppConfig.PLAY_LICENSE_PUBLIC_KEY` eingetragen (aus *Monetarisierung einrichten → Lizenzierung*), `PLAY_PRODUCT_ID` = `malachi_pro`.
- [ ] `versionCode`/`versionName` erhöht (gleich wie Website-Variante).
- [ ] Billing Library aktuell: Google verlangt für neue Apps und Updates ab 31.08.2026 mindestens Version 8 (eingebunden: `8.0.0`, `android/app/build.gradle` → `playImplementation`). Vor jedem Release prüfen, ob eine neuere stabile Version Pflicht ist.
- [ ] `targetSdkVersion` erfüllt die aktuelle Play-Vorgabe (derzeit 36 in `android/build.gradle`).
- [ ] `npx jest __tests__` grün.
- [ ] `cd android; .\gradlew bundlePlayRelease` → `app-play-release.aab`.
- [ ] Gemergtes Manifest geprüft: kein `READ_MEDIA_IMAGES`, kein `AD_ID`, kein `REQUEST_INSTALL_PACKAGES`, kein ML-Kit-„cct“-Backend; `BILLING` vorhanden.
- [ ] Interner Test: Kauf, Abbruch, ausstehende Zahlung, Erstattung, Wiederherstellen, Offline-Start (Abschnitt 5.4).
- [ ] Interop-Test: Play-Installation ↔ Website-Installation koppeln, Chat, Gruppe, Anruf, Siegel-Nachricht in beide Richtungen.
- [ ] Vollversion-Seite und Einstellungen der Play-Variante zeigen nirgends Shop, Monero, Bitcoin, Onion, Gerätecode oder Lizenz-Umzug (automatisch geprüft in `__tests__/license/license.proScreen.play.test.js`).
- [ ] App-Inhalte vollständig (Datenschutzerklärung, Datensicherheit, Foreground-Service-, Vollbild-Intent-Erklärung, Zielgruppe, Inhaltsbewertung, Werbe-ID, App-Zugriff).
- [ ] Store-Eintrag de/en ohne externe Zahlungswege, Screenshots aus der Play-Variante.
- [ ] Zertifikats-Fingerabdruck der Play-Variante auf der Website veröffentlicht.
- [ ] Erst dann: Produktion (gestaffelte Einführung, z. B. 20 %).

---

## 15. Offene Richtlinien-Risiken

1. **Foreground-Service-Typ `remoteMessaging`:** Google beschreibt den Typ als „Nachrichten zwischen Geräten übertragen / Fortsetzen auf einem anderen Gerät“. Eine dauerhafte Empfangsverbindung ohne Push-Server passt nur bedingt; Google empfiehlt für Nachrichten sonst FCM (für Malachi bewusst ausgeschlossen). Möglich ist eine Ablehnung der Erklärung. Ausweg ohne Protokolländerung: nur in `src/play/AndroidManifest.xml` den Dienst auf `specialUse` umstellen (`tools:replace="android:foregroundServiceType"`, Berechtigung `FOREGROUND_SERVICE_SPECIAL_USE`, Property `android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE` mit Begründung) und die Erklärung entsprechend einreichen. `MalachiService` ruft `startForeground` ohne festen Typ auf und bräuchte dafür keine Code-Änderung.
2. **`USE_FULL_SCREEN_INTENT`:** wird nur für echte Anruf-/Wecker-Apps gewährt. Malachi hat echte Anrufe (ConnectionService) – sollte passen. Ohne Gewährung erscheint ein eingehender Anruf auf dem Sperrbildschirm nur als Benachrichtigung.
3. **Datensicherheit/Nominatim:** mit dem STUN-Ausstieg erledigt – die Adressanzeige per OpenStreetMap ist entfernt. Wichtig ist nur die Reihenfolge: das Formular erst dann auf „keine Daten“ umstellen, wenn diese Version im Store ist (solange 1.1.0 ausgeliefert wird, gilt dort noch „Ungefährer Standort“).
4. **ML Kit:** die Abschaltung der Telemetrie ist eingebaut, aber erst nach dem Build am gemergten Manifest bzw. per Netzwerkmitschnitt zu bestätigen (8.3).
5. **Nutzergenerierte Inhalte / Kinderschutz:** Google kann bei Kommunikations-Apps Melde- und Blockierfunktionen sowie eine veröffentlichte Kinderschutz-Richtlinie verlangen (Abschnitt 10). Eine Blockier-Funktion fehlt bisher (nur „Chat löschen“).
6. **Tor:** Apps mit Tor sind im Play Store zulässig (z. B. Orbot, Tor Browser). Die Tor-Binärdateien sind in der App enthalten und werden nicht nachgeladen (Richtlinie „Missbrauch von Geräten und Netzwerken“ erfüllt). Reviewer können ohne zweites Gerät keinen Chat testen – App-Zugriff gut beschreiben.
7. **JS-Bundle enthält den Shop-Code:** Die Play-Variante zeigt ihn nie (Weiche `ProScreen` → `PlayProScreen`), der Code liegt aber im gemeinsamen JS-Bundle (auch `SHOP_ONION`, sobald eingetragen). Für die Zahlungsrichtlinie zählt die sichtbare Steuerung der Nutzer; ein Entfernen per Metro-Konfiguration wäre möglich, wenn Google je nachfragt.
8. **Serverlose Kaufprüfung:** siehe 5.3 (bewusste Grenze). Google empfiehlt Server-Prüfung, verlangt sie aber nicht.
9. **Billing-Library-Version:** fest `8.0.0`; Google hebt die Mindestversion jährlich an (Checkliste).

---

## 16. Technische Umsetzung (Dateien)

| Datei | Inhalt |
|---|---|
| `android/app/build.gradle` | Flavors `web`/`play` (Dimension `vertrieb`), App-ID der Play-Variante aus `playApplicationId`, Signatur je Flavor, Schutz gegen gleichen Schlüssel, Abbruch ohne bestätigten Paketnamen, `bundle {}`, `playImplementation` Billing, `debuggableVariants` für React Native |
| `android/gradle.properties` | vorbereitete Zeile `playApplicationId=…` |
| `android/app/src/main/AndroidManifest.xml` | ML-Kit-Telemetrie-Backend entfernt (beide Varianten) |
| `android/app/src/play/AndroidManifest.xml` | `READ_MEDIA_IMAGES` und `AD_ID` entfernt |
| `android/app/src/web/AndroidManifest.xml` | Platz für `REQUEST_INSTALL_PACKAGES` (später, Updater) |
| `android/app/src/main/java/com/securecommapp/MalachiBuildModule.kt` | Konstanten `distribution` (BuildConfig.FLAVOR), `applicationId` |
| `android/app/src/{web,play}/java/com/securecommapp/FlavorPackages.kt` | Flavor-eigene native Module (play: Billing) |
| `android/app/src/play/java/com/securecommapp/billing/PlayBillingModule.kt` | connect, queryProduct, launchPurchase, queryPurchases, acknowledge, Ereignis `MalachiPlayPurchases` |
| `Distribution.js` | `isPlay()`, `isWeb()`, `getApplicationId()` (ohne Modul: web) |
| `PlayBilling.js` | JS-Hülle um das native Modul |
| `PlayPurchase.js` | serverlose Kaufprüfung (RSA-PKCS#1-v1.5, Paket, Produkt, Status) |
| `LicenseManager.js` | Pro in der Play-Variante aus geprüftem Kauf; Web unverändert; gleiche öffentliche Schnittstelle |
| `PlayProScreen.tsx` | Vollversion-Seite der Play-Variante |
| `App.tsx` | Weiche `ProScreen` → `PlayProScreen`/`ShopProScreen`, Preiszeile in den Einstellungen |
| `AppConfig.js` | `PLAY_LICENSE_PUBLIC_KEY`, `PLAY_PRODUCT_ID` |
| `__tests__/license/distribution.test.js`, `license.play.test.js`, `license.proScreen.play.test.js` | Tests (Test-RSA-Schlüssel wird im Test erzeugt) |
