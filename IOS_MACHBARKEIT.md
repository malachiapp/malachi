# Malachi auf dem iPhone – Machbarkeit, Wege und Aufwand

*Stand: 15. Oktober 2026. Grundlage: Code-Stand `8a51482` (Branch `claude/audit-ui-sicherheit`) und die verlinkten Quellen. Wo etwas nicht sicher belegt ist, steht das dabei.*

---

## Kurzfassung

1. Ein Flutter-Neubau ist **nicht sinnvoll**: Malachi ist bereits in React Native geschrieben, das genau wie Flutter Android *und* iOS bedient, und rund 12 500 Zeilen App-Logik samt 43 Testdateien können auf dem iPhone weitgehend unverändert weiterlaufen.
2. Neu entstehen müssen nur die Android-Spezialteile (28 Kotlin-Dateien, ca. 2 700 Zeilen) als iOS-Gegenstücke in Swift; das müsste man bei Flutter genauso, dort aber zusätzlich zum Neuschreiben der ganzen übrigen App.
3. Die eigentliche Hürde ist nicht die Programmiersprache, sondern Apple: iOS lässt keine App dauerhaft im Hintergrund laufen, ein ständig erreichbarer Onion-Dienst wie unter Android ist auf dem iPhone nicht möglich – genau deshalb gibt es weder Briar noch Cwtch (eine Flutter-App!) für iOS.
4. Ohne Server läuft Malachi auf dem iPhone daher im **„Abholmodus“**: alles funktioniert bei geöffneter App, sonst holt die App Nachrichten nur ab, wenn iOS sie gelegentlich kurz weckt (unvorhersehbar, nach dem Wegwischen aus der App-Übersicht gar nicht mehr), und Anrufe klingeln nur bei geöffneter App.
5. Sofortige Zustellung und Klingeln bei geschlossener App gibt es auf iOS ausschließlich über Apples Push-Dienst, der zwingend einen eigenen Server voraussetzt und Apple wie diesem Server Metadaten zeigt – das widerspräche dem Grundsatz „serverlos“ und wäre eine bewusste Ausnahmeentscheidung.
6. Praktisch nötig sind ein Mac (Xcode läuft nur auf macOS, auch für Flutter), mindestens ein Test-iPhone und das Apple Developer Program für 99 US-$ im Jahr.
7. Grober Aufwand für eine erfahrene Person: iOS-Port mit React Native ca. **50–90 Personentage**, Flutter-Neubau beider Plattformen ca. **150–250 Personentage** bei deutlich höherem Risiko.
8. **Empfehlung:** zuerst Android wie geplant komplett serverfrei machen, dann 1–2 Wochen Prototyp auf einem echten iPhone (Tor, Onion-Dienst, Abholen im Hintergrund), danach Schritt für Schritt mit React Native portieren.

---

## 1. Flutter-Neubau oder iOS-Port mit React Native?

### 1.1 Was heute in Malachi steckt

| Schicht | Umfang | Auf iOS nutzbar? |
|---|---|---|
| App-Logik in JavaScript/TypeScript: App.tsx (6 026 Zeilen), BackgroundSync.js (1 707), WebRTCManager.js (1 163), TorTransport.js (944), CallManager.js (832), RTCStore.js (703), Krypto-Module (≈ 600), RelayClient.js (451) u. a. | ≈ 12 500 Zeilen | **Ja.** React Native läuft auf iOS. Anzupassen sind ca. 20 Android-spezifische Stellen in App.tsx (z. B. `PermissionsAndroid`, Zurück-Taste) und ca. 9 Aufrufe eigener Android-Module. |
| Verschlüsselung (AES-GCM, ChaCha20-Poly1305, XSalsa20-Poly1305, HKDF über `@noble/*`) | in JS | **Ja**, reines JavaScript |
| Fremdbibliotheken (react-native-webrtc, Kamera, Dateiauswahl, verschlüsselter Speicher, Biometrie, QR, NetInfo …) | 25 Pakete | **Ja.** Alle bieten iOS-Unterstützung; bei der Einrichtung einzeln prüfen. Zwei vorhandene Patches (`patches/`) prüfen. |
| Eigene native Android-Teile (Kotlin) | 28 Dateien, ≈ 2 700 Zeilen | **Nein**, iOS-Gegenstück nötig (siehe Abschnitt 2) |
| Automatische Tests (Jest) | 43 Dateien | **Ja**, sie laufen unabhängig vom Gerät |
| `ios/`-Ordner | Projektvorlage | Veraltet: stammt aus einer React-Native-Version vor 0.74 (enthält noch „Flipper“). Muss für RN 0.86 **neu erzeugt** werden. |

### 1.2 Der Denkfehler hinter „Flutter-Apps laufen auf Android und iOS“

Der Satz stimmt, gilt aber genauso für React Native. Malachi ist also schon in einer plattformübergreifenden Technik geschrieben. Was *nicht* auf iOS läuft, sind die nativen Spezialteile: Tor, Dauerbetrieb im Hintergrund, Telefonie-Anbindung, Opus-Audio und Portfreigabe. Diese Teile muss man **in jedem Fall** in Swift für iOS schreiben, egal ob die Oberfläche in React Native oder Flutter gebaut ist. Flutter würde die Arbeit also nicht verkleinern, sondern um den kompletten Neubau der übrigen 12 500 Zeilen vergrößern.

Bester Praxisbeleg: Der Tor-Messenger **Cwtch** hat eine Flutter-Oberfläche ([AUR-Paket „Flutter based Cwtch UI“](https://aur.archlinux.org/packages/cwtch-ui-bin)). Trotzdem gibt es ihn nicht für iOS, weil Onion-Dienste auf Mobilsystemen nicht dauerhaft laufen dürfen ([Cwtch: Platform Support](https://docs.cwtch.im/blog/cwtch-platform-support), [Cwtch-Downloadseite](https://git.openprivacy.ca/cwtch.im/website-new/raw/branch/trunk/content/download.md)).

### 1.3 Vergleich

| | **(a) iOS-Port mit React Native** | **(b) Neubau mit Flutter** |
|---|---|---|
| Wiederverwendung | ca. 85–90 % (alles außer Kotlin) | praktisch nichts aus JS (Dart ist eine andere Sprache); Kotlin-Teile nur teilweise |
| Neu zu schreiben | iOS-Gegenstücke der nativen Teile | gesamte App in Dart, dazu die nativen Teile für **beide** Plattformen neu anbinden |
| Bisherige Sicherheitsprüfungen (Red-Team, Fuzzing, Invarianten-Katalog, Nebenläufigkeit …) | bleiben für die JS-Logik gültig | müssten komplett wiederholt werden |
| Verträglichkeit mit bestehenden Android-Nutzern | automatisch, gleicher Code | Verschlüsselung und Protokoll müssten Byte für Byte nachgebaut werden, eine große Fehlerquelle |
| Daten bestehender Nutzer (Schlüssel, Chats) | unberührt | Umzug aus dem React-Native-Speicher nötig, mit Risiko von Datenverlust |
| Mac nötig? | ja | ja ([Flutter baut iOS nur auf macOS](https://startdebugging.net/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)) |
| iOS-Hintergrundproblem | ungelöst (Apple-Regel) | **genauso** ungelöst |
| Tor-Bausteine | Tor.framework direkt aus Swift nutzbar | Flutter-Pakete sind unreif: [`tor`](https://pub.dev/packages/tor) (Foundation Devices, Arti) ist nur Proxy/Client; das Hosting-Paket [`tor_hidden_service`](https://pub.dev/documentation/tor_hidden_service/latest/) stammt von einem Einzelanbieter, iOS-Tauglichkeit unklar |
| Grober Aufwand | 50–90 Personentage | 150–250 Personentage |

**Klare Empfehlung: iOS-Port mit React Native.** Einen Flutter-Neubau würde ich nur erwägen, wenn die App aus anderen Gründen ohnehin neu geschrieben werden müsste. Dafür gibt es im Code keinen Anlass.

---

## 2. Welche nativen Teile für iOS neu entstehen müssen

| Android-Teil (Kotlin, Zeilen) | Aufgabe | iOS-Ersatz | Schwierigkeit |
|---|---|---|---|
| `KyberModule` (78) | ML-KEM-768, Zufallszahlen, SHA-256 | **Am besten gar kein nativer Code:** [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) in JS. Die Web-Version nutzt es schon; laut Code-Kommentar in `KyberModule.kt` ist es byte-kompatibel mit dem BouncyCastle-ML-KEM. Zufall über das schon vorhandene `react-native-get-random-values`, das auf iOS die System-Zufallsquelle nutzt. Alternative: Apple CryptoKit hat [`MLKEM768` erst ab iOS 26](https://developer.apple.com/documentation/cryptokit/mlkem768), was iPhones älter als iPhone 11 ausschließt ([Geräteliste iOS 26](https://9to5mac.com/2025/09/15/ios-26-supports-these-recent-iphones-but-drops-three-models/)). liboqs ist unnötig. | gering |
| `MalachiTorModule` (641) + `MalachiTorProcessService` | Tor starten, eigener Onion-Dienst, ausgehende .onion-Verbindungen, Bridges, Neustart nach Netzwechsel | [Tor.framework (iCepa)](https://github.com/iCepa/Tor.framework): C-Tor 0.4.9.x, ab iOS 15, Installation per CocoaPods; die Schnittstelle gilt laut Projekt als „not stable yet“. Bridges: [IPtProxy](https://github.com/tladesignz/IPtProxy) gibt es auch für iOS (obfs4/Lyrebird, Snowflake). **Wichtig:** iOS-Apps dürfen keine Unterprozesse starten, Tor läuft daher *im App-Prozess* ([Onion-Browser-README](https://raw.github.com/mtigas/iOS-OnionBrowser/master/README.markdown), [Tor-Blog](https://blog.torproject.org/tor-heart-onion-browser-and-more-ios-tor)). Das Android-Konzept „Tor im eigenen Prozess, jederzeit neu startbar“ lässt sich nicht übertragen. Ob ein kompletter Tor-Neustart im selben Prozess zuverlässig klappt, muss der Prototyp zeigen. Dass ein Onion-Dienst auf iOS grundsätzlich gehostet werden kann, belegt [OnionShare für iOS](https://apps.apple.com/gb/app/onionshare/id1601890129), allerdings nur bei geöffneter App (Abschnitt 3). **Arti** (Tor in Rust) ist auf Mobilgeräten laut Guardian Project noch „quite experimental“ ([Arti on iOS](https://tordev.guardianproject.info/tor-on-ios/arti-and-onionmasq-on-ios)). Für Onion-Dienste gab es zuletzt (Arti 1.2.0) ausdrücklich keine Empfehlung für den Produktiveinsatz ([Tor-Forum](https://forum.torproject.org/t/arti-1-2-0-is-released-onion-services-development/11787)). Ob Arti 2.x (Feb. 2026) das geändert hat, konnte ich nicht verifizieren, daher **C-Tor verwenden**. | **hoch** |
| `MalachiService`, `MalachiHeadlessTaskService`, `BootReceiver`, `MalachiSyncAlarmReceiver`, `MalachiServicePackage` (≈ 500) | Dauerbetrieb: Vordergrunddienst, Headless-JS, 8-Sekunden-Takt, Start nach Neustart | **Kein Gegenstück möglich.** Ersatz: `beginBackgroundTask` (kurze Nachlaufzeit) und `BGAppRefreshTask` (gelegentliches Wecken, max. 30 s), siehe Abschnitt 3 | mittel (Technik), **hoch** (Produktfolgen) |
| `calling/*`: ConnectionService, TelecomHelper, CallBridge, Benachrichtigungen (≈ 550) | System-Anrufoberfläche, Klingeln | **CallKit** (`CXProvider`): System-Anrufbildschirm bei geöffneter App und für laufende Gespräche. Klingeln bei geschlossener App ginge nur mit PushKit, und das braucht einen Server (Abschnitt 3) | mittel |
| `MalachiFirebaseMessagingService` (41) | FCM-Wecksignal | **Entfällt.** Laut Kommentar in `BackgroundSync.js` ist es serverseitig ohnehin ohne Funktion | – |
| `MalachiCallAudioModule` (310) | Opus-Sprachkanal über Tor (MediaCodec) | AVAudioEngine plus Opus. Apple unterstützt das Opus-Format seit iOS 11 im System; das *Kodieren* über `AVAudioConverter` ist aber schlecht dokumentiert ([Apple-Forum](https://developer.apple.com/forums/thread/127317)). Sicherer Weg: libopus selbst einbinden | mittel |
| `MalachiPcpModule` (221) | Portfreigabe am Router (PCP), IPv6-Status | Swift mit Network.framework (UDP). iOS fragt beim ersten Zugriff ins lokale Netz eine Erlaubnis ab („Lokales Netzwerk“) | gering–mittel |
| `MalachiNotificationModule` (100) | lokale Benachrichtigungen | `UNUserNotificationCenter` (oder Bibliothek, z. B. Notifee). Lokale Benachrichtigungen brauchen **keinen** Server | gering |
| `FileShareModule` (48) | Dateien teilen | iOS-Teilen-Menü (`UIActivityViewController`) | gering |
| WebRTC | Direktverbindung, DataChannel, Audio | **Kein Neubau:** [`react-native-webrtc`](https://www.npmjs.com/package/react-native-webrtc) unterstützt iOS inklusive DataChannel | – |

Zusätzliche Punkte:
- **Neue React-Native-Architektur:** Seit RN 0.82/0.83 ist sie Pflicht. Eigene iOS-Module schreibt man daher als TurboModule oder bequemer über die Expo Modules API in Swift ([Vergleich 2026](https://reactnativerelay.com/article/building-native-modules-2026-turbo-expo-nitro-compared)).
- **Werkzeug-Risiko CocoaPods:** Das zentrale CocoaPods-Verzeichnis wird am **2. Dezember 2026** schreibgeschützt ([Analyse](https://nesbitt.io/2026/06/23/sunsetting-a-package-manager.html), [CocoaPods-Blog](https://blog.cocoapods.org/CocoaPods-Specs-Repo/)). React Native nutzt aber noch CocoaPods, und Tor.framework dokumentiert nur CocoaPods. Bestehende Versionen bleiben installierbar. Es ist trotzdem ein Baustein, den man im Auge behalten muss.

---

## 3. Die zentrale Hürde: iOS-Hintergrundbeschränkungen

### 3.1 Was iOS erlaubt – und was davon für Malachi taugt

Grundregel: Verlässt man eine iOS-App, wird sie nach kurzer Zeit **eingefroren**. Netzwerkverbindungen, Tor und ein Onion-Dienst laufen dann nicht weiter. Eine App kann nur über die folgenden, von Apple festgelegten Wege Rechenzeit im Hintergrund bekommen ([Apple: Choosing Background Strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app)):

| Mechanismus | Was er leistet | Braucht Server? | Taugt für Malachi? |
|---|---|---|---|
| `beginBackgroundTask` | kurze Nachlaufzeit nach dem Verlassen der App („begrenzte Zeit“) | nein | **ja**, um laufende Sendungen abzuschließen |
| `BGAppRefreshTask` | iOS weckt die App gelegentlich für **bis zu 30 s**; *wann*, entscheidet das System | nein | **ja, als „Abholmodus“**, aber unzuverlässig: nur bei regelmäßig genutzten Apps, **nie nach dem Wegwischen** durch den Nutzer ([Apple-Entwickler-Support](https://developer.apple.com/forums/thread/721584)), im Stromsparmodus eingeschränkt |
| `BGProcessingTask` | längere Arbeiten, typischerweise nachts beim Laden | nein | nein, für Wartung gedacht und nicht für Erreichbarkeit |
| `BGContinuedProcessingTask` (iOS 26) | vom Nutzer gestartete Aufgabe läuft mit Fortschrittsanzeige weiter | nein | nein, nur für endliche Aufgaben wie Export/Upload ([Überblick](https://dev.to/arshtechpro/wwdc-2025-ios-26-background-apis-explained-bgcontinuedprocessingtask-changes-everything-9b5)) |
| Hintergrund-Push (`content-available`) | weckt App für bis zu 30 s; mehr als ~3 pro Stunde werden gedrosselt | **ja (APNs)** | nur mit Server |
| **PushKit (VoIP-Push)** + CallKit | weckt die App zuverlässig für eingehende Anrufe | **ja (APNs)**; laut Apple muss *„your server“* den Push an APNs schicken, und jeder VoIP-Push muss als Anruf an CallKit gemeldet werden ([Apple PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)) | nur mit Server |
| Notification Service Extension | entschlüsselt eine eingegangene Push-Nachricht | **ja (APNs)** | nur mit Server |
| Local Push Connectivity | Dauerverbindung **nur in festgelegten WLANs (SSID)** ohne Internetzugang, Sonderberechtigung von Apple nötig ([Apple](https://developer.apple.com/documentation/networkextension/local-push-connectivity)) | ja (lokaler Server) | nein |
| Audio-Hintergrundmodus | App läuft weiter, solange Audio spielt | nein | **nur während eines laufenden Gesprächs**. „Stilles Audio“, um wach zu bleiben, verstößt gegen Richtlinie 2.5.4 (*„only use background services for their intended purposes“*, [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)) |
| Network Extension (VPN, wie Orbot) | läuft dauerhaft, solange das „VPN“ aktiv ist | nein | theoretisch denkbar, praktisch **nicht empfehlenswert**: Speicherlimit ca. 50 MB, an dem schon Orbot scheitert ([Onion-Browser-FAQ](https://onionbrowser.com/faqs), [Orbot iOS](https://github.com/guardianproject/orbot-ios)); belegt den einzigen VPN-Platz des Nutzers; VPN-Apps nur mit Organisations-Konto (Richtlinie 5.4); Zweckentfremdung riskiert Ablehnung |

### 3.2 Wie andere Projekte das lösen

| Projekt | iOS? | Lösung / Aussage |
|---|---|---|
| **Briar** (Tor, P2P) | nein | FAQ: iOS-Version „probably not“. Grund: Apple erlaubt keine lang laufenden Hintergrundverbindungen; Push würde Metadaten an Apple und an ein Push-Gateway geben ([Briar-FAQ](https://code.briarproject.org/briar/briar/-/wikis/FAQ), [Machbarkeitsstudie](https://code.briarproject.org/briar/briar/-/issues/2282)). Für Erreichbarkeit gibt es die **Briar Mailbox** auf einem Zweitgerät ([F-Droid](https://f-droid.org/packages/org.briarproject.mailbox/)). |
| **Cwtch** (Tor, Flutter) | nein | „no way around the need to have an active process managing such services“ ([Cwtch-Blog](https://docs.cwtch.im/blog/cwtch-platform-support)); für iOS sei evtl. ein anderes Anonymisierungsnetz nötig ([Issue #13](https://git.openprivacy.ca/cwtch.im/cwtch-ui/issues/13)) |
| **Quiet** (Tor, P2P) | nur TestFlight | iOS-App „without notifications“; Benachrichtigungen geplant „with help from a service Apple requires to be centralized“ ([README](https://github.com/TryQuiet/quiet)) |
| **Session** | ja | wahlweise „langsamer Modus“ (gelegentliches Abholen im Hintergrund, verzögert) oder „schneller Modus“ über APNs plus eigenen Push-Server; Apple sieht IP-Adresse und Push-Token ([Session-FAQ](https://getsession.org/faq)) |
| **SimpleX** | ja | eigener Benachrichtigungsserver, weil Apple pro App nur einen Push-Schlüssel ausgibt; daneben ein Abholmodus ohne Push ([SimpleX-Blog](https://simplex.chat/blog/20220711-simplex-chat-v3-released-ios-notifications-audio-video-calls-database-export-import-protocol-improvements.html)) |
| **Berty** | ja | eigene Push-Komponente „Zero-Push“ (Server ohne zentrale Token-Liste) ([Berty-Doku](https://berty.tech/docs/zeropush)); Details zum iOS-Hintergrund nicht dokumentiert gefunden |
| **Onion Browser / Orbot** | ja | Tor im App-Prozess bzw. als VPN-Erweiterung (50-MB-Problem); beide sind reine *Clients* und bieten keinen dauerhaft erreichbaren Dienst |
| **OnionShare** | ja | hostet Onion-Dienste auf dem iPhone ([App Store](https://apps.apple.com/gb/app/onionshare/id1601890129)); Hintergrundbetrieb nicht belegt, nach iOS-Regeln nur bei geöffneter App zu erwarten |
| **Ricochet Refresh** | nein | nur Desktop |
| Tor-Projekt selbst | – | offenes Arti-Ticket „User should be able to run an onion service in the background on iOS“; dort heißt es, es gebe dafür „no obvious way“ ([Arti #461](https://gitlab.torproject.org/tpo/core/arti/-/issues/461)) |

**Ergebnis:** Kein bekanntes Projekt hat einen dauerhaft erreichbaren Onion-Dienst auf iOS oder sofortige Zustellung ohne Push-Server. Alle iOS-fähigen Messenger nutzen entweder APNs mit eigenem Server oder einen verzögerten Abholmodus.

### 3.3 Gibt es einen serverlosen Weg?

**Ja, aber nur mit spürbaren Einschränkungen.** So sähe der serverlose „Abholmodus“ konkret aus:

1. **App geöffnet:** volle Funktion. Tor läuft, der eigene Onion-Dienst ist erreichbar, WebRTC-Direktverbindungen und Anrufe funktionieren wie auf Android.
2. **App gerade verlassen:** über `beginBackgroundTask` noch kurz Zeit, um offene Sendungen abzuschließen. Danach friert iOS die App ein und der Onion-Dienst ist nicht mehr erreichbar.
3. **Gelegentliches Wecken (`BGAppRefreshTask`, max. 30 s):** Das iPhone arbeitet als reiner Tor-*Client*. Es verbindet sich zu den Onion-Diensten seiner Kontakte (Android-Geräte sind dauerhaft online) und meldet sich. Die Kontakte liefern daraufhin ihre Sende-Warteschlange über diese Verbindung aus. Neue Nachrichten zeigt die App per **lokaler** Benachrichtigung an, ganz ohne Server. Offen ist, ob Tor-Start plus Abholen zuverlässig in 30 s passt; das muss der Prototyp messen. Dafür ist eine Protokollerweiterung nötig: Die Warteschlange muss auch dann ausgeliefert werden, wenn die *Gegenseite* die Verbindung aufbaut. Sie gehört in den gemeinsamen JS-Code (`TorTransport.js`/`BackgroundSync.js`) und nützt damit auch Android.
4. **Wann geweckt wird, bestimmt allein iOS.** Bei regelmäßig genutzten Apps kann das öfter am Tag sein, sonst selten. Hat der Nutzer die App weggewischt, passiert es **gar nicht**, bis er sie wieder öffnet. Im Stromsparmodus seltener.
5. **Anrufe:** klingeln nur bei geöffneter App. Bei geschlossener App ist der iPhone-Nutzer „nicht erreichbar“. Der Anrufer kann einen Hinweis „verpasster Anruf“ in die Warteschlange legen, der beim nächsten Abholen ankommt.
6. **iPhone ↔ iPhone:** Beide sind meist eingefroren, Nachrichten fließen also nur, wenn zufällig beide gleichzeitig aktiv sind. Das ist genau das „Briar-Problem“. Abhilfe ohne fremden Server wäre ein **„Briefkasten“** nach dem Vorbild der Briar Mailbox: ein eigenes, dauerhaft laufendes Gerät des Nutzers, etwa ein altes Android-Handy mit Malachi im Briefkasten-Modus am Ladekabel. Es nimmt verschlüsselte Nachrichten entgegen, das iPhone holt sie ab. Das ist kein Server eines Dritten, aber ehrlicherweise ein immer laufender Knoten. Und auch damit klingelt kein Anruf bei geschlossener App.

**Was es serverlos nicht gibt:** sofortige Benachrichtigung und Klingeln bei geschlossener App. Dafür braucht iOS zwingend Apples Push-Dienst (APNs). Um ihn zu nutzen, muss ein Server mit dem geheimen APNs-Schlüssel des Entwicklers die Weck-Nachricht an Apple schicken. Diesen Schlüssel in jede App einzubauen, damit Geräte sich direkt gegenseitig wecken, wäre unsicher: Wer ihn ausliest, könnte alle Nutzer anpushen. Deshalb betreiben Session, SimpleX, Berty und künftig Quiet eigene Push-Server.

**Was ein solches „Weck-Gateway“ sehen würde,** selbst bei inhaltsleerem Push:
- **Apple** sieht, welche App welches Gerät (und damit welche Apple-ID) wann weckt, und die IP-Adresse des iPhones.
- **Das Gateway** sieht Push-Token und Zeitpunkte. Es kann durch Tor-Zugriff und verschlüsselte Token minimiert, aber nicht auf null gebracht werden.
- Dass Regierungen Push-Daten bei Apple und Google abfragen, ist dokumentiert ([Brief von Senator Wyden, Dez. 2023](https://www.wyden.senate.gov/imo/media/doc/wyden_smartphone_push_notification_surveillance_letter.pdf)).

### 3.4 Ehrliche Konsequenz für den Grundsatz „serverlos“

- Eine iOS-Version **kann** serverlos sein (nur P2P, WebRTC und Tor, ohne Push, ohne Steuersignale über Server). Sie ist dann aber ein **„Messenger mit Abholung“**, kein ständig erreichbares Telefon. Das muss man in der App und in der Werbung klar sagen.
- Ein iOS-Malachi mit Sofort-Benachrichtigung und klingelnden Anrufen bei geschlossener App ist **ohne Server technisch unmöglich**. Das ist keine Frage von Aufwand oder Framework.
- Denkbare Mittelwege, die jeweils eine bewusste Entscheidung brauchen:
  - **Briefkasten-Gerät:** eigenes Gerät, kein Dritter; verbessert die Zustellung, nicht das Klingeln.
  - **Optionales Weck-Gateway nur für iOS:** inhaltslos, abschaltbar, Standard „aus“. Das wäre eine Ausnahme vom Grundsatz und bräuchte wieder einen Server.

---

## 4. Praktische Voraussetzungen

### 4.1 Mac und Xcode

- Bauen, Signieren und Debuggen von iOS-Apps geht nur mit **Xcode auf macOS**. Das gilt für React Native wie für Flutter.
- Seit **28. April 2026** nimmt App Store Connect nur noch Builds an, die mit **Xcode 26 / iOS-26-SDK** erstellt wurden ([Apple: SDK-Anforderungen](https://developer.apple.com/news/upcoming-requirements/)). Der Mac muss Xcode 26 oder neuer ausführen können.
- Für die geplanten Swift-Teile (Tor, CallKit, Hintergrund) braucht man **Debugging am echten Gerät**. Reine Cloud-Builds reichen zum Ausliefern, aber kaum zum Entwickeln dieser Teile.

| Option | Kosten (grob) | Eignung |
|---|---|---|
| Eigener Mac mini (Apple Silicon) | einmalig, Größenordnung ab ~700 € *(aktuellen Preis prüfen)* | **empfohlen** für die native Entwicklung; vom Windows-PC aus per Bildschirmfreigabe/SSH nutzbar |
| Gemieteter Cloud-Mac | monatlich, Anbieter vergleichen *(Preise nicht geprüft)* | brauchbar; ein iPhone per USB anzuschließen ist dort aber umständlich |
| [Codemagic](https://docs.codemagic.io/getting-started/about-codemagic/) | 500 Build-Minuten/Monat auf Mac M2 gratis | gut für automatische Builds/TestFlight-Upload |
| [GitHub Actions macOS](https://docs.github.com/en/billing/concepts/product-billing/github-actions) | macOS-Minuten zählen 10-fach (privates Repo) | brauchbar für CI |
| [Expo EAS Build](https://expo.dev/pricing) | 15 iOS-Builds/Monat gratis, auch für „bare“ React Native, Start von Windows aus | gut zum Ausliefern, nicht zum nativen Debuggen |

Der Alltag kann auf Windows bleiben, denn JS-Code, Tests und Android laufen dort weiter. Für die iOS-Teile braucht man aber regelmäßig Zugriff auf einen Mac.

### 4.2 Testgeräte

Mindestens **ein echtes iPhone**, idealerweise eines, das iOS 26 kann (iPhone 11 oder neuer). Hintergrundverhalten, CallKit und Tor-Stabilität lassen sich im Simulator nicht aussagekräftig prüfen. Für Kreuztests braucht man zusätzlich die vorhandenen Android-Geräte.

### 4.3 Apple Developer Program

- **99 US-$ pro Jahr**, in Landeswährung abgerechnet ([Apple](https://developer.apple.com/support/enrollment/)). Eine Anmeldung als Einzelperson genügt. Ein Organisations-Konto (mit D-U-N-S-Nummer) wäre nur für Sonderfälle wie VPN-Apps nötig.
- Ohne Bezahlkonto lassen sich Apps nur aufs eigene Gerät spielen. Sie laufen dann nach etwa **7 Tagen** ab, mit Begrenzung auf wenige Apps und Geräte ([Apple-Forum](https://developer.apple.com/forums/thread/724896)). Für mehr als Experimente reicht das nicht.

### 4.4 App-Store-Prüfung bei Tor- und Verschlüsselungs-Apps

- **Tor-Apps sind grundsätzlich zugelassen:** Onion Browser, Orbot und OnionShare stehen im App Store. Das größere Prüfrisiko liegt bei Hintergrundmodi (Richtlinie 2.5.4). Deshalb nur verwenden, was echt genutzt wird: Audio/VoIP für laufende Gespräche, Background Fetch für das Abholen.
- **Verschlüsselung/Exportkontrolle:** Malachi nutzt Standardalgorithmen, die *nicht* von iOS bereitgestellt werden (AES-GCM, ChaCha20, XSalsa20 und ML-KEM in JS). Nach Apples Tabelle heißt das: **keine** US-CCATS-Klassifizierung nötig. Bei Vertrieb in Frankreich ist aber eine **französische Verschlüsselungserklärung** hochzuladen ([Apple: Export Compliance](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/)). Alternativ nimmt man Frankreich aus den Vertriebsländern heraus. In der `Info.plist` ist `ITSAppUsesNonExemptEncryption` korrekt zu setzen ([Apple](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)). *Ob zusätzlich US-Meldepflichten (jährlicher Selbstklassifizierungsbericht) greifen, hängt von der genauen Einstufung ab. Das bitte vor der Einreichung prüfen, ich habe es nicht abschließend klären können.*
- **Prüfbarkeit:** Apple verlangt, dass Prüfer alle Funktionen testen können (Richtlinie 2.1). Bei einer serverlosen P2P-App braucht es dafür einen erreichbaren Gegenpart, etwa ein dauerhaft laufendes Test-Android-Gerät als „Demo-Kontakt“, plus eine klare Anleitung oder ein Video in den Prüfnotizen.

### 4.5 TestFlight und Verteilung an kleine Kreise

- **TestFlight:** bis zu 100 interne Tester ohne Prüfung und bis zu 10 000 externe Tester. Der erste Build einer Version braucht eine Beta-Prüfung, und jeder Build läuft nach **90 Tagen** ab ([Apple TestFlight](https://developer.apple.com/testflight/)).
- **Ad-hoc:** bis zu 100 registrierte iPhones pro Mitgliedsjahr, ohne App-Store-Prüfung ([Apple](https://developer.apple.com/help/account/devices/devices-overview)).

### 4.6 EU-Sonderwege (Digital Markets Act)

- **Alternative Marktplätze** (z. B. AltStore PAL) sind in der EU möglich. Auch dort braucht es aber das Apple Developer Program, und jede App muss Apples **Notarisierung** durchlaufen ([Apple: Apps in der EU](https://developer.apple.com/support/apps-in-the-eu/)). Seit 1. Oktober 2026 gelten neue EU-Bedingungen ([Zusammenfassung](https://mjtsai.com/blog/2026/08/18/new-eu-app-store-terms-to-comply-with-dma/)). Die 5 %-„Core Technology Commission“ betrifft nur digitale Verkäufe und wäre bei einer kostenlosen App ohne Käufe praktisch null.
- **Direkter Vertrieb über die eigene Website** setzt u. a. zwei Jahre Mitgliedschaft und über **1 Mio.** Erstinstallationen im Vorjahr voraus ([Apple: Web Distribution](https://developer.apple.com/support/web-distribution-eu/)). Für Malachi ist das nicht erreichbar.
- **Wichtig:** Kein EU-Weg ändert etwas an den Hintergrundregeln. Es ist dasselbe iOS.

---

## 5. Aufwand und empfohlene Reihenfolge

*Annahmen: eine erfahrene Person in Vollzeit. Angaben in Personentagen (PT, 5 PT ≈ 1 Woche). Unsicherheit ±50 %, vor allem bei Tor und Hintergrund. KI-Unterstützung beschleunigt das Schreiben, nicht aber das Testen auf echten Geräten und die Apple-Prüfung.*

### (a) iOS-Port mit React Native

| Posten | PT |
|---|---|
| `ios/`-Projekt für RN 0.86 neu erzeugen, Abhängigkeiten, Signierung, Berechtigungstexte (Kamera, Mikrofon, Fotos, lokales Netz) | 3–5 |
| JS-Anpassungen (Android-Stellen in App.tsx, Berechtigungen, Benachrichtigungs-Ablauf, Oberflächendetails) | 5–10 |
| ML-KEM auf `@noble/post-quantum` umstellen, inkl. Testvektoren gegen BouncyCastle | 1–2 |
| Tor-Modul in Swift (Tor.framework, Onion-Dienst, SOCKS-Verbindungen, Bridges, Netzwechsel) | 10–20 |
| Abholmodus (BGAppRefreshTask, Nachlaufzeit, Protokollerweiterung, lokale Benachrichtigungen) | 5–10 |
| CallKit-Anbindung inkl. Audio-Sitzung mit WebRTC | 5–10 |
| Opus-Sprachkanal über Tor (AVAudioEngine/libopus) | 4–8 |
| Kleinteile: Benachrichtigungen, Teilen, PCP | 3–6 |
| Tests auf echten Geräten (iPhone ↔ Android), Fehlerbehebung, Sicherheitsreview der neuen Swift-Teile | 10–15 |
| App-Store-/TestFlight-Vorbereitung, Exportangaben, Datenschutzangaben, Prüfrunden | 3–5 |
| **Summe** | **≈ 50–90 PT (ca. 10–18 Wochen)** |

### (b) Flutter-Neubau beider Plattformen

| Posten | PT |
|---|---|
| Oberfläche neu (App.tsx allein hat über 6 000 Zeilen) | 30–50 |
| Logik neu: WebRTC, Hintergrundsync, Warteschlange, Anrufsteuerung, Tor-Protokoll | 30–50 |
| Verschlüsselung in Dart byte-kompatibel nachbauen, mit Testvektoren | 10–15 |
| Android-Nativteile an Flutter neu anbinden | 10–20 |
| iOS-Nativteile (wie bei a) | 25–45 |
| Datenumzug für bestehende Nutzer (Schlüssel, Chats) | 5–10 |
| Projekt, CI, Signierung für beide Plattformen | 5–10 |
| Tests und **Wiederholung der Sicherheitsprüfungen** für den gesamten neuen Code | 30–50 |
| **Summe** | **≈ 150–250 PT (ca. 7–12 Monate)** |

Weg (b) kostet etwa das Dreifache. Am Ende stünde dieselbe Funktion mit denselben iOS-Grenzen, aber ungeprüftem neuem Code.

### Empfohlene Reihenfolge

| Phase | Inhalt | Wo? |
|---|---|---|
| **0 – jetzt** | Android wie beschlossen **komplett serverfrei** machen (Kopplung, Verbindungsaufbau, Anrufsignale über Tor). Sonst portiert man Relay-Code, der ohnehin verschwindet. Parallel den JS-Kern iOS-fähig machen: ML-KEM auf `@noble/post-quantum`, Android-Aufrufe hinter eine kleine Plattform-Schnittstelle, Warteschlangen-Auslieferung bei eingehender Verbindung (Abholmodus). Das alles nützt auch Android. | Windows |
| **1 – Prototyp (1–2 Wochen)** | Mac, iPhone und Developer-Konto besorgen. Neues `ios/`-Projekt, App startet, Tor.framework läuft, Onion-Dienst ist vom Android-Malachi erreichbar. Im `BGAppRefreshTask` messen: Tor-Start, Abholzeit, wie oft iOS weckt. **Danach Go/No-Go.** | Mac + iPhone |
| **2 – Vordergrund-Version** | Chat, Kopplung, WebRTC und Tor bei geöffneter App; TestFlight intern | Mac |
| **3 – Anrufe & Komfort** | CallKit, Opus über Tor, Benachrichtigungen, Teilen, PCP | Mac |
| **4 – Abholmodus & Härtung** | Hintergrund-Abholen, Fehlerfälle, Sicherheitsreview der Swift-Teile; Entscheidung Briefkasten/Weck-Gateway | Mac |
| **5 – Veröffentlichung** | TestFlight extern, dann App Store (Exportangaben, Datenschutzangaben, Prüfanleitung mit Demo-Kontakt) | Mac/CI |

---

## 6. Was der Nutzer entscheiden bzw. besorgen muss

**Entscheiden:**
1. **Ist der „Abholmodus“ auf dem iPhone akzeptabel?** Er bedeutet keine Sofortzustellung und kein Klingeln bei geschlossener App. Wenn nein: Gibt es eine bewusste Ausnahme in Form eines optionalen, inhaltslosen Weck-Gateways (also wieder ein Server, mit Metadaten bei Apple)? Oder bleibt es bei „kein iOS“?
2. **Soll es einen „Briefkasten-Modus“ geben,** also ein eigenes Dauergerät (z. B. altes Android-Handy), damit iPhone-Nutzer auch untereinander zuverlässiger Nachrichten bekommen?
3. **Vertriebsweg:** öffentlich im App Store, oder nur TestFlight bzw. Ad-hoc für einen kleinen Kreis?
4. **Frankreich:** mit Verschlüsselungserklärung vertreiben oder ausnehmen?
5. **Mindest-iOS-Version:** z. B. iOS 15 (Grenze von Tor.framework) oder iOS 26 (nur iPhone 11 und neuer).
6. **Zeitpunkt:** erst nach Abschluss der serverfreien Android-Version beginnen (empfohlen).

**Besorgen:**
1. **Mac** mit Xcode 26 oder neuer, z. B. ein Mac mini; alternativ einen dauerhaften Cloud-Mac-Zugang.
2. **Mindestens ein iPhone** zum Testen (iPhone 11 oder neuer).
3. **Apple Developer Program** (99 US-$/Jahr) mit einer Apple-ID mit Zwei-Faktor-Anmeldung.
4. Später für die App-Prüfung: ein **dauerhaft laufendes Test-Android-Gerät** als Demo-Kontakt für Apples Prüfer.

---

## Quellen (Auswahl, abgerufen Oktober 2026)

**Apple**
- [Choosing Background Strategies for Your App](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app)
- [Responding to VoIP Notifications from PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)
- [Local Push Connectivity](https://developer.apple.com/documentation/networkextension/local-push-connectivity)
- [Apple-Forum: BGAppRefreshTask nach Wegwischen](https://developer.apple.com/forums/thread/721584)
- [App Review Guidelines (2.1, 2.5.4, 5.4)](https://developer.apple.com/app-store/review/guidelines/)
- [CryptoKit MLKEM768](https://developer.apple.com/documentation/cryptokit/mlkem768)
- [Export Compliance](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/) · [Encryption Export Regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
- [SDK-Anforderungen](https://developer.apple.com/news/upcoming-requirements/) · [Developer Program](https://developer.apple.com/support/enrollment/) · [TestFlight](https://developer.apple.com/testflight/) · [Geräteregistrierung](https://developer.apple.com/help/account/devices/devices-overview)
- [Apps in der EU](https://developer.apple.com/support/apps-in-the-eu/) · [Web Distribution EU](https://developer.apple.com/support/web-distribution-eu/)

**Tor auf iOS**
- [Tor.framework](https://github.com/iCepa/Tor.framework) · [IPtProxy](https://github.com/tladesignz/IPtProxy) · [Orbot iOS](https://github.com/guardianproject/orbot-ios) · [Onion-Browser-FAQ](https://onionbrowser.com/faqs) · [Onion-Browser-README](https://raw.github.com/mtigas/iOS-OnionBrowser/master/README.markdown)
- [Guardian Project: Arti und Onionmasq auf iOS](https://tordev.guardianproject.info/tor-on-ios/arti-and-onionmasq-on-ios) · [Arti 1.2.0 (Onion-Dienste)](https://forum.torproject.org/t/arti-1-2-0-is-released-onion-services-development/11787) · [Arti-Ticket #461](https://gitlab.torproject.org/tpo/core/arti/-/issues/461)
- [Tor-Blog: Onion Browser und Tor auf iOS](https://blog.torproject.org/tor-heart-onion-browser-and-more-ios-tor) · [OnionShare im App Store](https://apps.apple.com/gb/app/onionshare/id1601890129)

**Andere Messenger**
- [Briar-FAQ](https://code.briarproject.org/briar/briar/-/wikis/FAQ) · [Briar iOS-Machbarkeitsstudie](https://code.briarproject.org/briar/briar/-/issues/2282) · [Briar Mailbox](https://f-droid.org/packages/org.briarproject.mailbox/)
- [Cwtch Platform Support](https://docs.cwtch.im/blog/cwtch-platform-support) · [Cwtch iOS-Issue](https://git.openprivacy.ca/cwtch.im/cwtch-ui/issues/13)
- [Quiet](https://github.com/TryQuiet/quiet) · [Session-FAQ](https://getsession.org/faq) · [SimpleX v3](https://simplex.chat/blog/20220711-simplex-chat-v3-released-ios-notifications-audio-video-calls-database-export-import-protocol-improvements.html) · [Berty Zero-Push](https://berty.tech/docs/zeropush)
- [Wyden-Brief zu Push-Überwachung](https://www.wyden.senate.gov/imo/media/doc/wyden_smartphone_push_notification_surveillance_letter.pdf)

**Werkzeuge**
- [Codemagic](https://docs.codemagic.io/getting-started/about-codemagic/) · [GitHub-Actions-Abrechnung](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [Expo-Preise](https://expo.dev/pricing)
- [CocoaPods wird schreibgeschützt](https://nesbitt.io/2026/06/23/sunsetting-a-package-manager.html) · [react-native-webrtc](https://www.npmjs.com/package/react-native-webrtc) · [@noble/post-quantum](https://github.com/paulmillr/noble-post-quantum)
- Flutter-Tor-Pakete: [`tor`](https://pub.dev/packages/tor), [`tor_hidden_service`](https://pub.dev/documentation/tor_hidden_service/latest/)

**Nicht abschließend verifiziert** (bewusst offen gelassen):
- Status von Arti-Onion-Diensten nach Version 2.0
- Zuverlässigkeit des Opus-*Kodierens* über `AVAudioConverter`
- Möglicher US-Selbstklassifizierungsbericht
- Aktuelle Mac- und Cloud-Mac-Preise
- Ob ein vollständiger Tor-Neustart im App-Prozess zuverlässig funktioniert (klärt der Prototyp)
