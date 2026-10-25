# Malachi für iOS – Umsetzungsplan

*Stand: 20. Oktober 2026. Grundlage: Code-Stand `d93bd1c` (Branch `claude/release-i18n`), `IOS_MACHBARKEIT.md` (15.10.2026), `MASTERPLAN_DAUERVERBINDUNG.md`, `FOREGROUND_SERVICE_PLAN.md`, `PLAY_STORE.md`, `SIEGEL_DESIGN.md`, Ordner `web/` sowie die Quellen am Ende. Nichts davon wurde auf einem Mac oder iPhone gebaut oder getestet. Was nur geschätzt oder nicht belegt ist, steht dabei.*

Dieses Dokument baut auf `IOS_MACHBARKEIT.md` auf. Die dortigen Hintergrundtabellen (Vergleich mit Briar, Cwtch, Session, SimpleX, Quiet usw.) werden hier nicht wiederholt.

---

## 0. Kurzfassung

1. **Empfehlung: die bestehende React-Native-App um iOS erweitern, nicht in Flutter neu schreiben.** Das Protokoll und die Kryptografie liegen heute in rund 30 000 Zeilen JavaScript/TypeScript, die bereits mehrfach geprüft wurden (Red-Team, Fuzzing, Invarianten, Nebenläufigkeit, Audit 19.10.). Dieser Code läuft auf iOS unverändert weiter. Damit ist die Protokollgleichheit mit Android automatisch gegeben. Ein Flutter-Neubau müsste alles in Dart nachbauen und neu prüfen, und er löst kein einziges der eigentlichen iOS-Probleme.
2. **Die eigentliche Hürde ist Apples Hintergrundregel, nicht das Framework.** Ohne eigenen Server gibt es auf dem iPhone keine Sofortzustellung und kein Klingeln bei geschlossener App. Der iOS-Messenger arbeitet deshalb im **„Abholmodus“**: Bei geöffneter App funktioniert alles. Sonst holt die App Nachrichten nur ab, wenn iOS sie gelegentlich kurz weckt. Das muss in der App und im Store offen gesagt werden.
3. **Schnellster sinnvoller Weg in zwei Etappen:**
   - **Etappe A – Siegel für iPhone:** Der Siegel-Modus braucht kein Netz, keinen Hintergrundbetrieb, kein Tor und kein CallKit. Er passt deshalb ohne Abstriche zu iOS. Er kann nach etwa **8–10 Wochen** im App Store sein, und iPhone-Nutzer können damit sofort mit Android-Nutzern verschlüsselt über WhatsApp & Co. schreiben.
   - **Etappe B/C – der Messenger:** TestFlight mit Chat, Kopplung und Tor bei geöffneter App nach etwa **12 Wochen**. Mit Anrufen, Abholmodus und Härtung im App Store nach etwa **18–22 Wochen**.
4. **Gesamtaufwand:** etwa **70–95 Personentage** (eine erfahrene Person in Vollzeit mit KI-Unterstützung, Unsicherheit ±30 %). Den größten Teil kosten Tests auf echten Geräten und Apples Prüfung, nicht das Schreiben von Code.
5. **Vorab muss der Inhaber** einen Mac mit Apple-Chip und ein iPhone besorgen, das Apple Developer Program abschließen (99 US-$ pro Jahr) und ein dauerhaft laufendes Android-Testgerät für Apples Prüfer bereitstellen. Außerdem stehen einige Grundsatzentscheidungen an (Abschnitt 8).

---

## 1. Was sich seit der Machbarkeitsnotiz geändert hat

| Thema | Stand 15.10. (`IOS_MACHBARKEIT.md`) | Stand heute | Folge für iOS |
|---|---|---|---|
| Server | Relay/Treffpunkt noch im Einsatz, Abschaltung geplant | **Kein eigener Server mehr** (`AppConfig.js`). Kopplung, Verbindungsaufbau, Anrufsignale und Nachrichten laufen über die Onion-Dienste der Geräte, danach direkt per WebRTC. STUN kommt aus einem Pool öffentlicher deutscher Anbieter. | Ohne Tor kann das iPhone keinen Kontakt finden. Tor ist auf iOS deshalb Pflicht, nicht nur Ausweichweg. |
| Native Android-Teile | 28 Dateien, ca. 2 700 Zeilen | 39 Kotlin-Dateien, **4 913 Zeilen** in `src/main`, dazu ca. 950 Zeilen in den Varianten `play` (Billing) und `web` (Updater) | mehr iOS-Gegenstücke: Siegel-Schlüssel, Geräteschlüssel, Zwischenablage, App-Symbol, Router-Portfreigabe, Argon2id |
| JS-Logik | ca. 12 500 Zeilen | ca. **30 300 Zeilen** (App.tsx allein 6 895), **99** Testdateien | höherer Wiederverwendungswert, Flutter wird noch teurer |
| Vertrieb | nur Website-APK | Website-APK **und** Google Play (`de.malachiapp`, Play Billing, serverlose Kaufprüfung) | Das Muster „eigene Vertriebsvariante, gleiches Protokoll“ gibt es schon und lässt sich für den App Store übernehmen. |
| Neue Funktionen | – | Siegel-Modus, Gruppen, Gruppenanrufe, Telefonnummer-Kopplung (Rendezvous-Onion + Argon2id), 18 Sprachen, schaltbarer Bildschirmschutz | alles in JS; nativ betroffen sind nur Argon2id, die Rendezvous-Onions und der Bildschirmschutz |
| Web-App (`web/`) | – | Offline (Entscheidung 07.10.). Der Code nutzt noch den alten `RelayClient` und kein Tor. | **Kein Weg für iOS** (siehe 2.3) |
| Warteschlange | „Protokollerweiterung für den Abholmodus nötig“ | `TorTransport.js` setzt `flushQueue` **auf beiden Seiten**, sobald eine Verbindung angemeldet ist. Das gilt auch für eingehende Verbindungen. | Der Kern des Abholmodus ist schon da: Baut das iPhone eine Verbindung zu einem Android-Kontakt auf, liefert dieser seine Warteschlange aus. Es fehlen nur Ergänzungen (Abschnitt 3.1.4). |

---

## 2. Entscheidung: React Native erweitern oder Flutter?

### 2.1 Vergleich

| Kriterium | **(a) React Native um iOS erweitern** | **(b) Neubau in Flutter** |
|---|---|---|
| Wiederverwendung | Das gesamte JS-Bundle (Protokoll, Double Ratchet, ML-KEM-Hybrid, Gruppen, Siegel, Warteschlange, Oberfläche, 18 Sprachen). Neu entstehen nur die nativen Module (Abschnitt 4). | Nichts aus JS (Dart ist eine andere Sprache). Aus Kotlin lassen sich höchstens die Konzepte übernehmen. |
| Protokollgleichheit mit Android (Pflicht) | Automatisch, weil es **derselbe Code** ist. Zu prüfen sind nur die wenigen nativen Bausteine, die Daten auf der Leitung erzeugen (ML-KEM, Argon2id der Telefon-Kopplung, Opus-Pakete), und zwar per Testvektoren. | Jede Nachricht, jeder Schlüsseltausch, jede Anmeldung und jeder Ratchet-Schritt müsste Byte für Byte nachgebaut werden. Das ist die fehleranfälligste Art von Arbeit, die es gibt. |
| Bisherige Sicherheitsprüfungen | bleiben für den JS-Kern gültig; neu zu prüfen sind nur die Swift-Module | müssten für die gesamte App wiederholt werden |
| Krypto-Bibliotheken | `@noble/*` (vorhanden, in Web und App erprobt) | ML-KEM in Dart nur über Bindungen an liboqs oder über junge Pakete; `sk_pqc` bezeichnet sich selbst als „experimental, pre-1.0“ und ungeprüft ([pub.dev](https://pub.dev/documentation/sk_pqc/latest/), [liboqs für Dart](https://pub.dev/documentation/liboqs/latest/)) |
| Tor | Tor.framework direkt aus Swift | ebenfalls natives Plugin nötig. Die Flutter-Tor-Pakete sind unreif (siehe `IOS_MACHBARKEIT.md` 1.3). |
| iOS-Hintergrundproblem | ungelöst (Apple-Regel) | **genauso** ungelöst |
| Mac/Xcode nötig | ja | ja |
| Android-Folgen | keine | Entweder Android ebenfalls neu schreiben, oder zwei Codebasen auf Dauer synchron halten. Beides ist für ein kleines Team kaum tragbar. |
| Grober Aufwand | 70–95 PT (inkl. Siegel-Etappe) | 180–280 PT für beide Plattformen, plus Wiederholung der Audits (Fortschreibung der Schätzung aus `IOS_MACHBARKEIT.md` auf den heutigen Codeumfang) |
| Wartung mit kleinem Team | eine Codebasis, zwei dünne native Schichten | zwei Welten oder eine ganz neue |

### 2.2 Ergebnis

**React Native erweitern.** Flutter brächte nur dann einen Vorteil, wenn die App ohnehin neu geschrieben werden müsste, und dafür gibt es keinen Anlass. Die Aussage „Flutter läuft auf Android und iOS“ trifft auf React Native genauso zu. Was auf iOS fehlt, sind die nativen Spezialteile, und die müssen in **beiden** Fällen in Swift geschrieben werden.

### 2.3 Weitere Wege geprüft und verworfen

- **Native Swift-App (SwiftUI):** Das wäre ein Neubau mit denselben Nachteilen wie Flutter, und das Protokoll gäbe es dann ein zweites Mal.
- **Web-App/PWA auf dem iPhone:** Safari kann kein Tor und keinen Onion-Dienst betreiben, und die Web-App ist ohne Server bewusst offline (`MASTERPLAN_DAUERVERBINDUNG.md`, Phase 8). Hintergrund-Push für Web-Apps liefe ebenfalls über Apples Push-Server.
- **Alternative EU-Marktplätze statt App Store:** Sie ändern nichts an den Hintergrundregeln, weil es dasselbe iOS ist (Abschnitt 3.7).

---

## 3. Die iOS-Hürden – konkrete Antworten

### 3.1 Hintergrundbetrieb: Wie kommen Nachrichten und Anrufe an?

#### 3.1.1 Was iOS erlaubt

iOS friert eine App wenige Sekunden nach dem Verlassen oder Sperren ein. Ab dann laufen weder Tor noch der Onion-Dienst noch WebRTC weiter. Einen dauerhaften Vordergrunddienst wie `MalachiService` auf Android gibt es nicht. Erlaubt sind nur die von Apple festgelegten Wege ([Apple: Choosing Background Strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app); Details in `IOS_MACHBARKEIT.md` 3.1):

- `beginBackgroundTask`: kurze Nachlaufzeit nach dem Verlassen der App, in der Praxis etwa eine halbe Minute.
- `BGAppRefreshTask`: iOS weckt die App gelegentlich für höchstens etwa 30 s. Den Zeitpunkt bestimmt allein das System. Nach dem Wegwischen aus der App-Übersicht geschieht das gar nicht mehr ([Apple-Forum](https://developer.apple.com/forums/thread/721584)), im Stromsparmodus ebenfalls nicht, denn er *„Turns off Background App Refresh“* ([Apple-Support](https://support.apple.com/en-us/101604)).
- Audio-Hintergrundmodus: nur, solange wirklich ein Gespräch läuft. Stilles Audio, nur um wach zu bleiben, verstößt gegen Richtlinie 2.5.4 (*„only use background services for their intended purposes“*).
- Push (APNs, PushKit/VoIP, Notification Service Extension): Jede dieser Varianten setzt voraus, dass ein Server mit dem geheimen APNs-Schlüssel des Entwicklers die Weck-Nachricht an Apple schickt ([Apple PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)). Diesen Schlüssel in die App einzubauen, damit sich Geräte direkt gegenseitig wecken, ist ausgeschlossen: Wer ihn ausliest, kann allen Nutzern Pushs schicken.

#### 3.1.2 Optionen im Abgleich mit „nichts über einen Server“

| Option | Wirkung | Server? | Passt zum Grundsatz? | Bewertung |
|---|---|---|---|---|
| **A – Abholmodus** (BGAppRefreshTask + Nachlaufzeit + lokale Benachrichtigung) | Nachrichten kommen verzögert an, wenn iOS weckt. Anrufe klingeln nur bei geöffneter App. | nein | **ja** | **v1-Lösung** |
| **B – Briefkasten-Gerät** (eigenes Dauergerät des Nutzers, z. B. altes Android-Handy am Ladekabel, nimmt verschlüsselte Nachrichten für das iPhone an) | verbessert die Zustellung, besonders zwischen zwei iPhones; Anrufe klingeln trotzdem nicht | kein fremder Server, aber ein immer laufender eigener Knoten | ja | **später, optional.** Braucht eine Protokollerweiterung (Ablage von Chiffretext für Dritte, eigene Anmeldung zwischen Briefkasten und iPhone, Missbrauchsschutz) mit eigenem Sicherheitsreview. Grob 15–25 PT. |
| **C – Local Push Connectivity im Heim-WLAN** (eine Netzwerk-Erweiterung hält im eingetragenen WLAN eine Verbindung zu einem lokalen Gerät, etwa dem Briefkasten, und kann einen Anruf an CallKit melden) | zu Hause Sofortzustellung und Klingeln, unterwegs nicht | nein (lokales eigenes Gerät) | ja | **Forschungsoption.** Läuft nur in festgelegten WLANs, braucht eine Sonderberechtigung von Apple, ist für „restricted networks“ gedacht und deshalb mit Prüfrisiko verbunden. Die Erweiterung müsste einen Teil des Protokolls nativ sprechen ([Apple: Local Push Connectivity](https://developer.apple.com/documentation/networkextension/local-push-connectivity), [NEAppPushProvider](https://developer.apple.com/documentation/networkextension/neapppushprovider)). |
| **D – Weck-Gateway** (inhaltsleerer Push über APNs bzw. PushKit) | Sofortbenachrichtigung und Klingeln bei geschlossener App | **ja, eigener Server** mit dem APNs-Schlüssel; nur der Entwickler kann ihn betreiben | **nein** | Apple sieht Gerät, App und Zeitpunkt, das Gateway sieht Token und Zeitpunkte. Es widerspricht „nichts über den Server“, dem Server-Ausstieg und dem Ziel „Selbstläufer“. **Nicht in v1**, nur nach ausdrücklicher Entscheidung (Abschnitt 8). |
| **E – CloudKit-Abos** (Apples Datenbank verschickt bei neuen Datensätzen einen Push, ohne eigenen Server) | Benachrichtigung bei geschlossener App möglich | Apples Server | **nein** | Apple sähe über iCloud-Konten, wer wen weckt, also den Kontaktgraphen. Das ist schlimmer als D. Dazu kommen Berichte über unzuverlässige Zustellung ([Apple-Forum](https://developer.apple.com/forums/thread/820562)). Verworfen. |
| **F – Tor als „VPN“-Netzwerkerweiterung** (läuft weiter, solange das VPN aktiv ist) | Onion-Dienst wäre dauerhaft erreichbar | nein | formal ja | **Nicht für v1.** Speichergrenze der Erweiterung, an der schon Orbot kämpft; belegt den einzigen VPN-Platz des Nutzers; VPN-Apps nur mit Organisations-Konto (Richtlinie 5.4). Vor allem müsste die Erweiterung Anmeldung und Schlüsseltausch nativ nachbauen, denn das JS-Protokoll läuft dort nicht. Damit gäbe es das Protokoll zweimal. |
| **G – Tricks** (stilles Audio, Standort-Hintergrundmodus, VoIP-Modus ohne PushKit) | – | – | – | Ablehnung nach 2.5.4. Verworfen. |
| **H – Wachmodus am Ladekabel** (App bleibt im Vordergrund, Bildschirm dunkel, automatische Sperre aus über `isIdleTimerDisabled`) | voll erreichbar, solange das iPhone so daliegt, auch für Anrufe | nein | ja | **Optional, später.** Nachteil: Das Gerät bleibt entsperrt. Das lässt sich durch die App-PIN-Sperre und den „Geführten Zugriff“ von iOS mildern. Gedacht für Nutzer, die nachts erreichbar sein wollen. |

**Empfehlung:** v1 nur mit **A**. **B** und **H** als spätere Erweiterungen, **C** nur als Forschung. **D** ist keine technische, sondern eine Grundsatzfrage und bleibt bis zu einer ausdrücklichen Entscheidung draußen.

#### 3.1.3 So verhält sich Malachi auf dem iPhone (Abholmodus)

| Zustand | Was passiert |
|---|---|
| App geöffnet und entsperrt | Volle Funktion. Tor läuft, der eigene Onion-Dienst ist erreichbar, Wechsel auf direkt per WebRTC, Anrufe in beide Richtungen, Warteschlangen werden in beide Richtungen ausgeliefert. |
| App gerade verlassen oder Bildschirm gesperrt | Über `beginBackgroundTask` werden offene Sendungen noch abgeschlossen. Danach friert iOS die App ein und das iPhone ist für Kontakte **nicht erreichbar**. |
| Eingefroren, iOS weckt (`BGAppRefreshTask`) | Das iPhone arbeitet als reiner Tor-*Client*: Tor anlaufen lassen, Verbindungen zu den Onion-Diensten der Kontakte aufbauen (zuerst zu denen mit kürzlicher Aktivität), deren Warteschlangen empfangen, die eigene Warteschlange ausliefern, eine **lokale** Benachrichtigung ohne Inhalt zeigen. Der Zeitrahmen liegt bei etwa 25 s. |
| Weggewischt oder Stromsparmodus | Bis zum nächsten Öffnen passiert nichts. |
| Eingehender Anruf bei geschlossener App | Kommt nicht an. Der Anrufer bekommt „nicht erreichbar“, und ein Hinweis „verpasster Anruf“ wandert in seine Warteschlange. |
| iPhone ↔ iPhone | Nachrichten fließen nur, wenn beide Apps zufällig gleichzeitig offen sind oder geweckt werden. Abhilfe ohne fremden Server bietet nur Option B oder H. |
| iPhone ↔ Android | Funktioniert gut, weil das Android-Gerät dauerhaft erreichbar ist: Das iPhone holt ab, sobald es offen ist oder geweckt wird. |

Nach jedem Öffnen muss Tor zuerst wieder Kreise aufbauen, und erst danach fließen Nachrichten. Wie lange das dauert, muss der Prototyp messen. Erwartung (nicht gemessen): einige Sekunden bei frischem Tor-Zwischenspeicher, bis zu einer Minute bei langsamen Netzen oder Bridges.

#### 3.1.4 Nötige Ergänzungen im gemeinsamen JS-Code

Die folgenden Punkte nützen auch Android. Sie müssen rückwärtskompatibel sein, und Android muss sie **vor** dem iOS-Start ausliefern (vgl. `PLAY_STORE.md` Abschnitt 13):

1. **Erreichbarkeits-Hinweis:** ein optionales Feld im verschlüsselten Profil-Systempaket, etwa „zeitweise erreichbar“. Vorher prüfen, ob ältere Versionen unbekannte Felder still ignorieren.
2. **Android-Verhalten gegenüber zeitweise erreichbaren Kontakten:** seltener selbst verbinden (spart Akku und Tor-Kreise), stattdessen darauf warten, dass das iPhone sich meldet. Die Warteschlange bleibt dafür länger erhalten.
3. **„Verpasster Anruf“** als Systempaket in die Warteschlange legen, wenn ein Anruf mangels Verbindung scheitert.
4. **Abhol-Zyklus** als eigene, zeitbegrenzte Funktion in `BackgroundSync.js` (`runPickupCycle(deadlineMs)`): Kontakte priorisieren, parallel verbinden, die Frist sauber einhalten.
5. **Statusanzeige:** auf Android beim iPhone-Kontakt „erreichbar, wenn geöffnet“, auf dem iPhone „zuletzt abgeholt vor …“.

### 3.2 Tor auf iOS: geht ein eigener Onion-Dienst?

**Ja, aber nur solange die App läuft.** Grundlage:

- **Tor.framework (iCepa), Version 409.6.1 vom 1. April 2026:** enthält tor 0.4.9.6 und OpenSSL 3.6.1, setzt iOS 15 und Xcode 26 voraus und wird über CocoaPods eingebunden. Die Programmierschnittstelle gilt laut Projekt als *„not stable yet“* ([Swift Package Registry](https://swiftpackageregistry.com/iCepa/Tor.framework)). Android nutzt C-Tor 0.4.8/0.4.9; das Onion-Protokoll ist dasselbe.
- **Tor läuft im App-Prozess,** denn iOS-Apps dürfen keine Unterprozesse starten. Den eigenen Onion-Dienst und die Rendezvous-Onions der Telefon-Kopplung legt das Modul wie auf Android über den Steuerkanal per `ADD_ONION` an (Android: `MalachiTorModule.kt`, `control.addOnion`).
- **Kein Neustart im selben Prozess:** Die Tor-Einbettungsschnittstelle kennt das einmalige Starten pro Prozess als bekannte Schwäche; Neustart-Unterstützung gilt als unvollständig ([Tor-Commit zu #24581](https://git-crysp.uwaterloo.ca/piros/tor/commit/05ac3d0458466bd8ffc69339a4bf8e34088d9d80?lang=en-US)). Das Android-Konzept „Tor-Prozess jederzeit neu starten“ (`MalachiTorProcessService`) wird auf iOS deshalb durch **Umkonfigurieren** ersetzt: `SETCONF` für Bridges, `DisableNetwork` umschalten, `SIGNAL NEWNYM`/`ACTIVE` nach Netzwechsel oder Rückkehr aus dem Hintergrund.
- **Bridges:** IPtProxy gibt es für iOS über Swift Package Manager, mit Lyrebird (obfs4 und weitere) und Snowflake ([IPtProxy](https://github.com/tladesignz/IPtProxy)). Android nutzt dieselbe Bibliothek.
- **Arti (Tor in Rust):** Für Onion-*Dienste* weiterhin nicht geeignet. Die Arti-Dokumentation warnt noch 2025 vor *„many serious problems“*, und `tor-hsservice` nennt fehlende Schutzfunktionen wie DoS-Abwehr ([Arti OnionService.md](https://gitlab.torproject.org/tpo/core/arti/-/raw/main/doc/OnionService.md), [tor-hsservice](https://docs.rs/tor-hsservice)). Also C-Tor verwenden.
- **Orbot als VPN:** nicht nötig, denn Malachi bringt sein Tor selbst mit.
- **Lokaler Angriffsweg (Audit A2/T3):** Auf Android endet der Onion-Dienst auf `127.0.0.1`. Auf iOS prüfen, ob als Ziel ein Unix-Socket im App-Container möglich ist (in der torrc per `HiddenServicePort … unix:` dokumentiert, bei `ADD_ONION` zu verifizieren). Andere Apps kämen dann gar nicht heran. Andernfalls gelten die vorhandenen Vor-Anmelde-Grenzen.
- **IPv6-only-Netze:** Apple prüft Apps in einem IPv6-only-Netz mit NAT64 ([Apple: IPv6 DNS64/NAT64](https://developer.apple.com/library/ios/documentation/NetworkingInternetWeb/Conceptual/NetworkingOverview/UnderstandingandPreparingfortheIPv6Transition/UnderstandingandPreparingfortheIPv6Transition.html)). Tor verbindet sich mit IP-Adressen von Relays und muss dort über IPv6-Relays starten können (`ClientUseIPv6`, `ClientPreferIPv6ORPort`). Unbedingt mit der NAT64-Netzwerkfreigabe des Macs testen, sonst droht die Ablehnung, weil „nichts verbindet“.

### 3.3 CallKit und PushKit

- **PushKit-Regel:** Jeder VoIP-Push muss sofort als Anruf an CallKit gemeldet werden, sonst beendet iOS die App und stellt VoIP-Pushs irgendwann ganz ein. Da Malachi in v1 keinen Push-Server hat, gibt es **kein PushKit** und keinen Hintergrundmodus `voip`.
- **CallKit trotzdem nutzen:** für den System-Anrufbildschirm bei geöffneter App, für ausgehende Anrufe, für laufende Gespräche im Hintergrund (Hintergrundmodus `audio`) und für Gruppenanrufe. Die Brücke heißt in JS weiter `CallBridgeModule` und meldet dieselben Ereignisse.
- **Zero Trace:** `CXProviderConfiguration.includesCallsInRecents = false` setzen. Sonst landen Malachi-Anrufe in der Anrufliste der Telefon-App und unter Umständen in iCloud ([Apple](https://developer.apple.com/documentation/callkit/cxproviderconfiguration/includescallsinrecents)).
- **China:** CallKit-Apps sind im chinesischen App Store nicht zulässig ([TechCrunch 2018](https://techcrunch.com/2018/05/25/googles-duo-and-ciscos-webex-teams-among-the-voip-apps-pulled-from-the-china-app-store)). China wird ohnehin ausgenommen (Tor).

### 3.4 WebRTC auf iOS

- `react-native-webrtc` (eingebunden 124.0.8) unterstützt iOS samt DataChannel. Hier ist kein Neubau nötig.
- Mit CallKit muss die Audio-Sitzung von WebRTC manuell gesteuert und erst im CallKit-Rückruf `didActivate` eingeschaltet werden. Das ist bekannt und machbar, aber fehleranfällig (Teil von Modul 15).
- Verbindungswege („Direkt, wenn möglich“ ohne STUN, „nur Tor“) und das Direkt-Upgrade sind JS und bleiben gleich. Seit dem STUN-Ausstieg gibt es keinen STUN-Pool mehr.
- iOS fragt beim ersten Zugriff ins lokale Netz nach („Lokales Netzwerk“). WebRTC-Hostkandidaten können diese Frage auslösen, deshalb braucht es einen erklärenden Text `NSLocalNetworkUsageDescription`.
- „Direkt, wenn möglich“ (ohne STUN): Die Portfreigabe am Router per PCP und NAT-PMP ist Unicast und geht. UPnP-IGD nutzt SSDP-Multicast und braucht dafür eine eigene Apple-Berechtigung `com.apple.developer.networking.multicast` ([Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), [Apple-Forum](https://developer.apple.com/forums/thread/663875)). Für v1 deshalb ohne UPnP; ohne Portfreigabe bleiben IPv6 und Tor.

### 3.5 Screenshot-Schutz (kein FLAG_SECURE auf iOS)

Ein gleichwertiges Verbot wie `FLAG_SECURE` gibt es auf iOS nicht. Möglich ist eine Kombination:

1. **Secure-Text-Field-Trick:** Die Bildschirminhalte werden in die Ebene eines `UITextField` mit `isSecureTextEntry` gelegt. Screenshots und Aufnahmen zeigen diese Fläche dann leer. Die Methode ist undokumentiert und kann mit jedem iOS-Update brechen. Im August 2026 wurde sie noch beschrieben ([Daring Fireball](https://daringfireball.net/linked/2026/08/20/bluesky-threads-sneak-logo-into-screenshots)), es gibt aber auch einen Bericht, dass sie unter iOS 26 nicht wirkte ([B4X-Forum](https://www.b4x.com/android/forum/threads/prevent-screenshot-ios.170927/)). Im Prototyp prüfen.
2. **Aufnahme und Spiegelung erkennen** (`UIScreen.isCaptured`, ab iOS 17 [`sceneCaptureState`](https://developer.apple.com/documentation/uikit/uitraitcollection/scenecapturestate)) und den Inhalt dann sofort verdecken.
3. **Screenshot erkennen** (`userDidTakeScreenshotNotification`). Das geht erst nachträglich, eignet sich also nur für einen Hinweis, im Secret Chat optional auch an den Kontakt.
4. **Schnappschuss für die App-Übersicht:** iOS speichert beim Verlassen der App ein Bild der Oberfläche **auf dem Gerät**. Vorher muss ein Abdeckbild eingeblendet werden. Das ist gleichzeitig ein Zero-Trace-Punkt.

Im Store und in der App darf daher nur „erschwert Screenshots und Aufnahmen“ stehen, nicht „verhindert“. Die Logik in `ScreenSecurity.js` (Standard an, Abschalten nur mit Pro, Secret Chat und Siegel immer geschützt) bleibt gleich.

### 3.6 Zero Trace auf iOS – eigene Fallstricke

| Fallstrick | Maßnahme |
|---|---|
| `react-native-encrypted-storage` speichert auf iOS **jeden Wert als eigenen Schlüsselbund-Eintrag**, ohne `ThisDeviceOnly` und mit Standard-Zugriffsklasse (`ios/RNEncryptedStorage.m`). Folgen: Einträge können per verschlüsseltem Backup auf ein anderes Gerät wandern; im gesperrten Zustand sind sie oft nicht lesbar, sodass das Abholen im Hintergrund scheitert; große Chatverläufe (`chat_<id>`) im Schlüsselbund sind langsam. | iOS-Teil der Bibliothek per `patch-package` ersetzen: Werte als verschlüsselte Dateien (AES-GCM oder ChaCha20-Poly1305) ablegen. Nur ein Hauptschlüssel liegt im Schlüsselbund, mit `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Die JS-Schnittstelle bleibt gleich. |
| Schlüsselbund-Einträge **überleben das Löschen der App**. Das ist kein zugesichertes Verhalten, aber Praxis ([Apple-Forum](https://developer.apple.com/forums/thread/36442)). | Beim ersten Start nach einer Installation (Markierungsdatei im Container fehlt) alle eigenen Schlüsselbund-Einträge und Secure-Enclave-Schlüssel löschen. |
| Documents und Library landen standardmäßig im iCloud- bzw. Finder-Backup (Android: `allowBackup=false`). Betroffen sind die Warteschlange (`queue_*.enc`), Medien (`media/`) und der Eingang (`inbox*.enc`). | `isExcludedFromBackup` für alle App-Daten setzen ([Apple](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup)). Gerätewechsel heißt dann wie auf Android: neu koppeln. |
| Schnappschuss in der App-Übersicht | Abdeckbild vor `willResignActive` (3.5) |
| Anrufliste der Telefon-App | `includesCallsInRecents = false` (3.3) |
| Benachrichtigungen landen in der Datenbank der Mitteilungszentrale | nie Nachrichteninhalt in Benachrichtigungen, beim Löschen alle zugestellten Benachrichtigungen entfernen |
| Fremde Tastaturen können Eingaben mitlesen oder lernen | Tastaturen von Drittanbietern über `application(_:shouldAllowExtensionPointIdentifier:)` sperren; Autokorrektur im Secret Chat ist schon aus (`App.tsx`) |
| Zwischenablage wird per Universal Clipboard auf andere Apple-Geräte übertragen | `UIPasteboard` mit `.localOnly` und `.expirationDate` (60 s) |
| Siri und Spotlight lernen aus „Spenden“ (`NSUserActivity`, `INSendMessageIntent`) | nichts spenden |
| Entschlüsselte Abspieldateien im Cache (`malachi_*.mp4`) | wie auf Android aufräumen, dazu Dateischutz `complete` |

### 3.7 App-Store-Prüfung

**Kryptografie und Exportangaben**
- In der `Info.plist` steht `ITSAppUsesNonExemptEncryption = YES`. Malachi nutzt Standardverfahren, die nicht von iOS stammen (X25519, ML-KEM, AES-GCM, ChaCha20 in JS, dazu Tor/OpenSSL). Nach Apples Tabelle ist dafür **keine CCATS-Einstufung** nötig, aber für den Vertrieb in **Frankreich** eine **französische Verschlüsselungserklärung** ([Apple: Export Compliance](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/)). Alternativ nimmt man Frankreich aus.
- US-Recht: Die BIS-Änderung von 2021 hat die meisten Meldepflichten für Massenmarkt-Verschlüsselung abgeschafft. Ob für „executable software“ dennoch ein jährlicher Selbsteinstufungsbericht nötig ist, wird unterschiedlich dargestellt ([Jones Day](https://www.jonesday.com/en/insights/2021/04/commerce-reduces-requirements-relating-to-massmarket-encryption-items-and-publicly-available-software)). Das bleibt wie in `PLAY_STORE.md` Abschnitt 12 offen und muss fachkundig bestätigt werden.

**Vollversion: nur In-App-Kauf**
- Richtlinie 3.1.1: *„If you want to unlock features or functionality within your app … you must use in-app purchase“*. Ausdrücklich verboten sind eigene Freischaltwege wie *„license keys … cryptocurrencies“* ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)). Der Monero/Bitcoin-Shop und die ML1-Lizenzen sind auf iOS damit ausgeschlossen.
- Lösung wie bei Google Play: **Einmalkauf über StoreKit 2** (`malachi_pro`, 2,99 €). StoreKit 2 prüft die von Apple signierten Kaufdaten (JWS) selbst auf dem Gerät, ein eigener Server ist dafür nicht nötig ([Apple: VerificationResult](https://developer.apple.com/documentation/storekit/verificationresult)).
- Nach 3.1.3(b) wäre es zwar zulässig, anderswo erworbene Freischaltungen anzuerkennen, wenn derselbe Kauf auch als In-App-Kauf angeboten wird. Shop-Lizenzen sind aber an das Android-Gerät gebunden, und die App dürfte außerhalb der USA ohnehin nicht auf den Shop hinweisen. **Empfehlung:** getrennt halten wie bei Play, also Shop-Lizenz nur in der Website-Variante.
- **Code-Gefahr:** `Distribution.js` behandelt ein fehlendes Modul und unbekannte Werte als `web`, zeigt also den Shop. Auf iOS führt das zur sicheren Ablehnung. Deshalb eine Variante `appstore` einführen und auf iOS **nie** auf `web` zurückfallen. Jest-Test analog `license.proScreen.play.test.js`.
- **Anti-Steering:** Für den US-Store sind externe Kauf-Links seit Mai 2025 erlaubt, und die Provisionsfrage liegt beim Supreme Court ([Michael Tsai 2025](https://mjtsai.com/blog/2025/05/02/app-review-guidelines-updated-for-epic-anti-steering), [TNW 2026](https://thenextweb.com/news/supreme-court-apple-epic-contempt-stay-denial)). In der EU gelten seit 1. Oktober 2026 neue Bedingungen mit gestaffelten Provisionen und erlaubten Link-outs ([Michael Tsai 2026](https://mjtsai.com/blog/2026/08/18/new-eu-app-store-terms-to-comply-with-dma/), [Phiture](https://phiture.com/blog/apple-new-app-store-terms-2026/)). **Empfehlung:** keinerlei externe Kaufhinweise in App und Store-Eintrag, wie bei Play. Das ist überall zulässig und am einfachsten. Die genauen EU-Provisionssätze vor der Preisfestlegung in App Store Connect prüfen; die Sekundärquellen widersprechen sich.

**Weitere Prüfpunkte**
- **2.1 Prüfbarkeit:** Prüfer brauchen einen erreichbaren Gegenpart. Dafür ein dauerhaft laufendes Android-Gerät mit Malachi als Demo-Kontakt bereithalten, dazu eine Kopplungsanleitung oder ein Video in den Prüfnotizen. Den Siegel-Modus können Prüfer allein testen, wenn ein vorbereiteter Einladungs-QR-Code beiliegt.
- **1.2 Nutzerinhalte:** Bei Kommunikations-Apps kann Apple Melde- und Blockierfunktionen verlangen. Eine Funktion „Kontakt blockieren“ fehlt bisher (`PLAY_STORE.md` 15.5). Sie sollte vor der Messenger-Einreichung kommen, in gemeinsamem JS.
- **2.5.2:** keine In-App-Updates. `MalachiUpdater` entfällt, und `AppUpdater.js` bleibt ohne Modul schon heute aus.
- **2.5.4:** nur Hintergrundmodi angeben, die wirklich genutzt werden: `audio` für laufende Gespräche, `fetch` bzw. BGTask für das Abholen.
- **Datenschutzangaben und Datenschutz-Manifest:** Die App-Privacy-Angaben entsprechen der Play-Datensicherheit: seit dem STUN-Ausstieg nichts erhoben (kein Nominatim, kein STUN). Dazu kommt `PrivacyInfo.xcprivacy` für die „Required Reason APIs“ der App und der Bibliotheken.
- **DSA-Händlerstatus:** Wer mit der App Geld verdient, gilt in der Regel als Händler. Adresse, Telefonnummer und E-Mail werden dann in den EU-Stores **öffentlich** angezeigt ([Apple](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-compliance-information)).
- **Länder:** China ausnehmen (CallKit, Tor). Den Iran erreicht der App Store offiziell ohnehin nicht. In Russland hat Apple 2024 auf Behördenverlangen VPN-Apps entfernt ([TechCrunch](https://techcrunch.com/2024/07/08/apple-removes-vpn-apps-at-request-of-russian-authorities-say-app-makers)). Gerade in den Sprachräumen Farsi, Chinesisch und Russisch bleibt die Android-APK oft der einzige Weg.
- **EU-Alternativen:** Alternative Marktplätze wie AltStore PAL und der Webvertrieb verlangen ebenfalls die Apple-Mitgliedschaft und Apples Notarisierung. Webvertrieb setzt dazu über 1 Mio. Erstinstallationen voraus ([Apple: Apps in der EU](https://developer.apple.com/support/apps-in-the-eu/)). Für Malachi bringt das keinen Vorteil, denn es gelten dieselben iOS-Regeln. **Erst App Store.**

### 3.8 Apple-Entwicklerkonto

- **99 US-$ pro Mitgliedsjahr**, abgerechnet in Landeswährung ([Apple: Enroll](https://developer.apple.com/programs/enroll/)).
- **Einzelunternehmen:** Apple führt *„individual or sole proprietor/single person business“* als **Einzelperson**. Der bürgerliche Name erscheint dann als Verkäufer im Store. Ein Organisations-Konto setzt eine eigene Rechtsperson voraus, die Verträge schließen kann (z. B. UG oder GmbH), dazu eine **D-U-N-S-Nummer**, eine Domain-E-Mail und eine echte Website. Handelsnamen und DBAs akzeptiert Apple nicht. Anders als bei Google genügt das Einzelunternehmen hier also nicht für ein Organisations-Konto. *Ob Apple einen eingetragenen Kaufmann (e. K.) als Organisation annimmt, ist nicht geklärt und muss im Zweifel beim Apple-Support erfragt werden.*
- Ein Organisations-Konto ist für Malachi **nicht zwingend**. Es wäre nur für Option F (VPN) nötig.
- Voraussetzung ist eine Apple-ID mit Zwei-Faktor-Anmeldung, am besten eine eigene geschäftliche.

### 3.9 Mac und Xcode (Inhaber hat einen Windows-PC)

Bauen, Signieren und nativ Debuggen geht nur mit Xcode auf macOS. App Store Connect nimmt seit April 2026 nur Builds mit Xcode 26 / iOS-26-SDK an (`IOS_MACHBARKEIT.md` 4.1).

| Option | Kosten (Stand Okt. 2026) | Eignung |
|---|---|---|
| **Eigener Mac mini mit Apple-Chip** (mind. 16 GB RAM, besser 512 GB SSD, weil Xcode und die Simulatoren viel Platz brauchen) | neues Einstiegsmodell M6 16 GB/256 GB: UVP 1 049 €, im Handel ab ca. 950 € ([Macwelt](https://www.macwelt.de/article/3246007/apple-mac-mini-mit-m6-chip-angebot-bei-amazon-zum-tiefstpreis-10-prozent-rabatt.html)); gebraucht oder generalüberholt M1–M4 deutlich günstiger *(Preise nicht geprüft)* | **empfohlen.** Das iPhone hängt per USB daran, so lassen sich Tor, CallKit und Hintergrund debuggen. Vom Windows-PC aus per Bildschirmfreigabe oder SSH bedienbar. |
| Gemieteter Mac (z. B. Scaleway Mac mini M4) | 0,22 €/h, mindestens 24 h, Dauerbetrieb ca. 149 €/Monat ([Scaleway](https://scaleway.com/en/news/apple-mac-mini-m4-as-a-service-with-scaleway), [Vergleichsseite](https://www.greenmini.nl/compare/scaleway-alternative/)) | Für einige Monate brauchbar, aber kein USB-iPhone: Installiert wird per TestFlight oder Ad-hoc, natives Debuggen ist mühsam. Nach ca. 7 Monaten teurer als ein eigener Mac. |
| Codemagic, EAS Build, GitHub Actions (macOS) | Gratiskontingente laut `IOS_MACHBARKEIT.md` 4.1 | gut für automatische Release-Builds und TestFlight-Uploads, **kein Ersatz** für Debugging am Gerät |

**Arbeitsweise:** JS-Code, Jest-Tests und Android bleiben auf Windows. Metro kann auf dem Windows-PC laufen und das JS-Bundle über das WLAN an die iPhone-Debug-App liefern. JS-Änderungen gehen so ohne Mac-Neubau. Den Mac braucht man für Swift-Module, Signierung und Geräte-Logs.

### 3.10 TestFlight

Bis zu 100 interne Tester ohne Prüfung und bis zu 10 000 externe Tester nach einer Beta-Prüfung. Builds laufen nach 90 Tagen ab ([Apple TestFlight](https://developer.apple.com/testflight/)). Für Familie und Freunde reicht zunächst TestFlight. Eine Geschenk-Lizenz wie beim Shop gibt es auf iOS nicht; möglich wären Apple-Angebotscodes für In-App-Käufe (*nicht geprüft*).

---

## 4. Native Module: Android → iOS

Grundsatz: Jedes iOS-Modul bekommt **denselben Namen, dieselben Methoden und dieselben Ereignisse** wie das Android-Modul, z. B. `NativeModules.MalachiTor`. Der JS-Code bleibt dann unverändert. Die Module können als klassische Module über die Interop-Schicht der neuen Architektur laufen, wie die Kotlin-Module heute auch, oder als TurboModule bzw. über die Expo Modules API.

| # | Android (Zeilen) | Aufgabe | iOS-Umsetzung | PT | Etappe |
|---|---|---|---|---|---|
| 1 | `tor/MalachiTorModule.kt` (1 262) + `MalachiTorProcessService` (21) | Tor, Bridges, eigener Onion-Dienst, Rendezvous-Onions, SOCKS-Verbindungen, Zeilentransport, Status, Netzwechsel, `httpRequest` (Shop/Updater) | Swift-Modul mit Tor.framework im Prozess, Steuerung per Control-Port (`ADD_ONION`, `SETCONF`, `SIGNAL`), Empfang über `NWListener` auf `127.0.0.1` (oder Unix-Socket, 3.2), IPtProxy per SwiftPM. `httpRequest` entfällt (kein Shop, kein Updater). | 10–15 | Spike in Phase 1, fertig in B |
| 2 | Argon2id in Tor- und Siegel-Modul (BouncyCastle, v1.3, Parallelität 1) | Telefon-Kopplung (64 MiB, t=3) **muss byte-gleich** sein; Siegel-Tresor (32 MiB) | libsodium `crypto_pwhash` (Argon2id v1.3, Parallelität fest 1, passt also) als xcframework oder die Referenz-C-Implementierung; Testvektoren aus BouncyCastle in Jest und als Selbsttest auf dem Gerät. In reinem JS wären 64 MiB unter Hermes zu langsam (*Annahme, nicht gemessen*). | 1–2 | A |
| 3 | `KyberModule.kt` (78) | ML-KEM-768, Zufall, SHA-256 | **Ohne nativen Code:** kleiner JS-Ersatz mit gleicher Schnittstelle auf Basis von `@noble/post-quantum` (wie in der Web-App), `react-native-get-random-values` und `@noble/hashes`. Läuft ab iOS 15. Kreuztests mit BouncyCastle-Vektoren (öffentlicher Schlüssel 1 184 Byte, Chiffrat 1 088 Byte). Private Schlüssel bleiben lokal, ihr Format darf abweichen. Alternative: CryptoKit `MLKEM768`, aber erst ab iOS 26 ([Apple](https://developer.apple.com/documentation/cryptokit/mlkem768)). | 1–2 | A |
| 4 | `siegel/MalachiSiegelKeyModule.kt` (183) | gerätegebundener HMAC-Schlüssel im Chip + Argon2id | Die Secure Enclave kennt **keine HMAC-Schlüssel**, nur P-256. Vorschlag: ein P-256-Schlüssel in der Secure Enclave; aus dem Argon2id-Ergebnis wird ein Kurvenpunkt abgeleitet (hash-to-curve, `@noble/curves`), ECDH mit dem Enclave-Schlüssel, danach HKDF. Das ergibt eine gerätegebundene Funktion wie auf Android. Rückfall: Zufallsschlüssel im Schlüsselbund mit `ThisDeviceOnly` (schwächer). Das Tresorformat ist lokal und muss nicht Android-gleich sein; es braucht aber ein eigenes kurzes Review. | 3–4 | A |
| 5 | `license/MalachiDeviceKeyModule.kt` (166) | Gerätecode für die Shop-Lizenz | entfällt (iOS ohne Shop) | 0 | – |
| 6 | `play/…/PlayBillingModule.kt` (334) | Einmalkauf | Swift-Modul mit StoreKit 2: Produkt laden, kaufen, `Transaction.currentEntitlements` und `Transaction.updates`, „Käufe wiederherstellen“ (`AppStore.sync`), Erstattung über `revocationDate`. Dazu JS `AppStorePurchase.js` analog `PlayPurchase.js`. Gleiche Regeln: kein Entzug bei fehlender Antwort, nach dem Löschen nur per „Wiederherstellen“. | 3–4 | A |
| 7 | `web/…/MalachiUpdaterModule.kt` (581) | Selbst-Update | entfällt (2.5.2) | 0 | – |
| 8 | `MalachiBuildModule.kt` (35) | Variante, Paketname | Konstanten `distribution = 'appstore'` und Bundle-ID | 0,5 | A |
| 9 | `ScreenSecurityModule.kt` (46) + `MainActivity` | FLAG_SECURE, leere Vorschau in der App-Übersicht | Kombination aus 3.5 (Secure-Field-Ebene, Aufnahme erkennen, Abdeckbild) | 2–4 | A |
| 10 | `clipboard/MalachiClipboardModule.kt` (71) | sensibel markieren, nach 60 s leeren | `UIPasteboard.setItems` mit `.localOnly` und `.expirationDate` | 0,5 | A |
| 11 | `FileShareModule.kt` (48) | Datei teilen | `UIActivityViewController` | 0,5–1 | A |
| 12 | `AppIconModule.kt` + `AppIconVariants.kt` (147) | App-Symbol passend zum Design | `setAlternateIconName`, Symbole im Asset-Katalog, Generator `tools/gen-theme-icons.js` um iOS erweitern. iOS zeigt dabei immer einen Systemhinweis. | 1–2 | B |
| 13 | `MalachiNotificationModule.kt` (117) | lokale Benachrichtigungen | `UNUserNotificationCenter`, lokal und ohne Inhalt, Badge, alles löschen | 1–2 | B |
| 14 | `MalachiService`, `-ServiceModule`, `HeadlessTaskService`, `BootReceiver`, `SyncAlarmReceiver` (≈ 576) | Dauerbetrieb | **kein Gegenstück.** `BGTaskScheduler` (App-Refresh) und `beginBackgroundTask` rufen `runPickupCycle` in JS auf und melden das Ende fristgerecht. Die JS-Aufrufe `MalachiService?.start()` sind schon heute mit `?.` abgesichert. | 5–8 | C |
| 15 | `calling/*` (563) | System-Anrufoberfläche | CallKit (`CXProvider`, `CXCallController`), `includesCallsInRecents = false`, manuelle Audio-Sitzung mit WebRTC, Gruppenanrufe | 5–8 | C |
| 16 | `tor/MalachiCallAudioModule.kt` (310) | Sprache über den Kanal: Opus 16 kHz, 20-ms-Pakete | `AVAudioEngine` mit Voice-Processing (Echo-Unterdrückung) und libopus (BSD-Lizenz) für **dieselben Rohpakete**; Gegentest mit Android | 4–6 | C |
| 17 | `net/MalachiPcpModule.kt` + `NatPmp.kt` + `UpnpIgd.kt` (1 094) | Portfreigabe am Router (Stufe „Privat“) | v1: PCP und NAT-PMP mit Network.framework (Unicast), Gateway aus der Routingtabelle; **kein UPnP** (Multicast-Berechtigung). Alternativ in v1 ganz weglassen. | 0–5 | B (optional) |
| 18 | `MainActivity`, `MainApplication` | Start | neues `ios/`-Projekt für RN 0.86. Das vorhandene stammt aus dem ersten Commit und enthält noch Flipper, `armv7` und Bundle-Name `SecureCommApp`. Dazu Info.plist mit Berechtigungstexten in 18 Sprachen, Entitlements, Datenschutz-Manifest, URL-Schema `malachi://` | 3–4 | Phase 1 |

**Anpassungen im gemeinsamen JS** (Regel wie bei Play: **keine** Protokoll- oder Krypto-Weichen nach Plattform):

| Punkt | Inhalt | PT |
|---|---|---|
| Vertriebsweiche | `appstore` in `Distribution.js`, `LicenseManager.js`, Pro-Bildschirm; auf iOS nie der Shop | 1–2 |
| Berechtigungen | 3 ungeschützte `PermissionsAndroid`-Aufrufe in `App.tsx` (Sprachnachricht, Standort, QR-Scanner) würden auf iOS als „abgelehnt“ enden; dazu kommt eine kleine Plattformschicht für Berechtigungen | 1–2 |
| Speicher | iOS-Ersatz für `react-native-encrypted-storage` und Backup-Ausschluss (3.6) | 2–4 |
| Abholmodus | Erreichbarkeits-Hinweis, Android-Verhalten, verpasster Anruf, `runPickupCycle` (3.1.4) | 3–5 |
| Kontakt blockieren | für Richtlinie 1.2, nützt auch Play | 2–3 |
| Texte | neue Hinweise und Berechtigungstexte in 18 Sprachen | 1–2 |
| Tests | Jest für die Weichen, Testvektoren für ML-KEM und Argon2id, Selbsttest auf dem Gerät | 2–3 |

Fremdbibliotheken: Alle 25 Pakete in `package.json` bieten iOS-Unterstützung. Die drei Patches in `patches/` betreffen nur Android. `firebase-admin` und `ws` stehen in den Abhängigkeiten, werden im App-Code aber nicht verwendet; beim Aufräumen entfernen.

**Werkzeug-Risiko CocoaPods:** Das zentrale CocoaPods-Verzeichnis wird am **2. Dezember 2026** schreibgeschützt. Vorhandene Versionen bleiben installierbar ([Courier](https://www.courier.com/blog/cocoapods-end-of-life-heres-what-to-do), [Firebase](https://firebase.google.com/docs/ios/cocoapods-deprecation)). React Native und die RN-Bibliotheken bringen ihre Podspecs lokal aus `node_modules` mit. Betroffen sind nur Fremd-Pods wie Tor.framework und das WebRTC-Paket. Spätere Tor.framework-Versionen werden notfalls als fertiges xcframework aus den GitHub-Releases eingebunden, IPtProxy gibt es schon über SwiftPM.

---

## 5. Phasenplan mit Meilensteinen

*Annahmen: eine erfahrene Person in Vollzeit mit KI-Unterstützung; Mac, iPhone und Entwicklerkonto liegen ab Woche 3 vor; Prüfzeiten bei Apple normal (Stunden bis wenige Tage pro Runde). Unsicherheit ±30 %, am größten bei Tor und dem Hintergrundverhalten.*

| Phase | Wochen | Inhalt | Ergebnis / Meilenstein | PT |
|---|---|---|---|---|
| **0 – Vorbereitung** (Windows) | 1–2 | JS-Weichen (`appstore`, Berechtigungen), `KyberModule`-Ersatz in JS mit Kreuztests, Argon2id-Testvektoren, Konzept für den iOS-Speicher, Abholmodus-Ergänzungen (3.1.4) inkl. Android-Verhalten, „Kontakt blockieren“. **Parallel beim Inhaber:** Mac, iPhone, Entwicklerkonto, Bundle-ID. | Android-Release mit den neuen, rückwärtskompatiblen Feldern | 7–9 |
| **1 – Gerüst und Tor-Spike** | 3–4 | neues `ios/`-Projekt, App startet, Signierung; Tor.framework + `ADD_ONION`; Kopplung und eine Nachricht mit einem Android-Gerät in beide Richtungen; BGAppRefresh-Test. Messen: Tor-Kaltstart, Rückkehr aus dem Hintergrund, Erreichbarkeit nach dem Öffnen, Abholzeit, Absturzfreiheit, IPv6-only/NAT64. | **Go/No-Go für den Messenger** (Kriterien unten) | 6–9 |
| **A – Siegel für iPhone** | 5–7 | Siegel-Oberfläche als eigener Einstieg (`SiegelScreen.tsx`, `SiegelCrypto.js`, `SiegelVault.js` unverändert), Module 2, 3, 4, 6, 8–11, Bildschirmschutz, StoreKit, Store-Eintrag, Exportangaben, Prüfanleitung | **M-A1:** TestFlight intern (Woche 6). **M-A2:** Einreichung (Ende Woche 7), live in Woche 8–10 | 12–16 |
| **B – Messenger bei geöffneter App** | 8–12 | Tor-Modul fertig, iOS-Speicher, Chats, Gruppen, Medien, Siegel im Messenger, Direkt-Upgrade, Benachrichtigungen, App-Symbol, ggf. PCP; Interop-Tests mit `web`- und `play`-Variante | **M-B1:** TestFlight intern mit dem Messenger (Woche 12) | 22–30 |
| **C – Anrufe, Abholmodus, Härtung** | 13–18 | CallKit, WebRTC-Audio, Opus über Tor, Gruppenanrufe, Abholmodus, Zero-Trace-Punkte (3.6), **Sicherheitsreview der Swift-Module**, Datenschutzangaben, Store-Texte in 18 Sprachen, Prüfrunden | **M-C1:** externe TestFlight-Beta (Woche 15). **M-C2:** Einreichung (Woche 17–18), live in **Woche 18–22** | 24–31 |
| **Summe** | | | | **≈ 71–95 PT** |

**Go/No-Go-Kriterien am Ende von Phase 1** (Zielwerte vorgeschlagen, endgültig nach den ersten Messungen festlegen):
1. Onion-Dienst auf dem iPhone ist vom Android-Malachi erreichbar; Anmeldung, Kyber-Schlüsseltausch und Nachricht klappen in beide Richtungen.
2. Vom Öffnen bis „erreichbar über Tor“: Median ≤ 30 s, 90 % ≤ 60 s (WLAN und Mobilfunk).
3. Rückkehr nach 1 h im Hintergrund bis zur ersten Verbindung zu einem Android-Kontakt: Median ≤ 15 s.
4. 100 Wechsel zwischen Vordergrund und Hintergrund sowie 20 Netzwechsel ohne Absturz und ohne hängendes Tor.
5. Ein Abholvorgang (Tor-Start + 3 Kontakte) passt in ≥ 70 % der Weckungen in 25 s. Dazu eine Woche Alltagstest: Wie oft weckt iOS wirklich?
6. Tor startet im IPv6-only-Netz (NAT64).

Scheitern die Punkte 1 oder 4, wird der Messenger gestoppt und Etappe A trotzdem veröffentlicht. Scheitert Punkt 5, kommt der Messenger nur als „Vordergrund-Version“, und das muss neu entschieden werden.

**Beschleunigung:** Ohne Etappe A wäre der Messenger etwa 2 Wochen früher fertig, denn vieles davon (Projekt, Krypto-Ersatz, StoreKit, Store-Einrichtung) braucht er ohnehin. Eine zweite Person für CallKit und Opus spart etwa 3–4 Wochen.

---

## 6. Funktionen, die auf iOS eingeschränkt sind

Für die Store-Beschreibung, die App und die Website. Ehrlich formuliert und nicht beschönigt:

1. **Erreichbarkeit:** Nachrichten und Anrufe kommen sofort an, **solange Malachi geöffnet ist**. Ist die App geschlossen oder das iPhone gesperrt, holt Malachi neue Nachrichten nur ab, wenn iOS die App kurz aufweckt. Wann das passiert, entscheidet iOS. Nach dem Wegwischen aus der App-Übersicht und im Stromsparmodus geschieht es nicht.
2. **Anrufe:** Eingehende Anrufe klingeln nur bei geöffneter App. Verpasste Anrufe werden beim nächsten Abholen angezeigt. Ausgehende Anrufe gehen jederzeit.
3. **Zwischen zwei iPhones** werden Nachrichten nur zugestellt, wenn beide Apps gleichzeitig geöffnet sind. Mit Android-Kontakten klappt es besser, weil Android dauerhaft erreichbar ist.
4. **Verbindungsaufbau nach dem Öffnen** dauert einige Sekunden bis etwa eine Minute (Tor).
5. **Bildschirmschutz** erschwert Screenshots und Bildschirmaufnahmen, kann sie aber anders als auf Android nicht garantiert verhindern.
6. **Vollversion** nur als In-App-Kauf über Apple. Lizenzen aus dem Website-Shop gelten nicht, Kryptozahlung gibt es nicht.
7. **Updates** nur über den App Store.
8. **Verbindungsweg „Privat“:** Die Portfreigabe am Router geht nur per PCP/NAT-PMP, nicht per UPnP (oder fehlt in v1 ganz). Direktverbindungen gelingen dann seltener, sonst bleibt Tor.
9. **Telefonnummer-Kopplung und Gruppenanrufe** funktionieren nur, wenn das iPhone dabei geöffnet ist.
10. **Benachrichtigungen** zeigen nie den Inhalt einer Nachricht.
11. **Kein Backup:** Malachi-Daten kommen nicht in iCloud- oder Computer-Backups. Bei einem Gerätewechsel müssen Kontakte neu gekoppelt werden (wie bei Android).
12. **App-Symbol wechseln:** iOS zeigt dabei einen Systemhinweis.
13. **Länder:** nicht verfügbar in China; in einigen Ländern mit Tor-Sperren ist der App Store selbst eingeschränkt.

Vorschlag für den Hinweistext im Store (de):
> *Hinweis für iPhone: Malachi hat keinen Server und keinen Push-Dienst. Solange die App geöffnet ist, kommen Nachrichten und Anrufe sofort an. Ist sie geschlossen, holt Malachi neue Nachrichten ab, sobald iOS die App kurz aufweckt – das kann dauern. Anrufe klingeln nur bei geöffneter App.*

---

## 7. Was der Inhaber vorab erledigen bzw. kaufen muss

| # | Was | Kosten (ca.) | Wann |
|---|---|---|---|
| 1 | **Apple Developer Program** als Einzelperson mit geschäftlicher Apple-ID und Zwei-Faktor-Anmeldung. Der bürgerliche Name erscheint als Verkäufer. Wer das nicht möchte, braucht eine eigene Rechtsform (UG/GmbH) samt D-U-N-S-Nummer. | 99 US-$/Jahr | Woche 1 |
| 2 | **Mac mit Apple-Chip** (mind. 16 GB RAM, besser 512 GB SSD), alternativ einige Monate Miet-Mac | ca. 950–1 100 € neu, gebraucht weniger; Miete ca. 149 €/Monat | bis Woche 3 |
| 3 | **Mindestens ein iPhone**, das iOS 26 kann (iPhone 11 oder neuer). Für iPhone-zu-iPhone-Tests ein zweites (gebraucht oder geliehen). | gebraucht je einige hundert € *(nicht geprüft)* | bis Woche 3 |
| 4 | **Bundle-ID festlegen.** Vorschlag `de.malachiapp` wie bei Play. Ist nach dem ersten Upload endgültig. App-Namen in App Store Connect reservieren (der Name muss im Store frei sein). | – | Woche 1–2 |
| 5 | **App Store Connect:** Vertrag für kostenpflichtige Apps, Bankverbindung, Steuerformulare; DSA-Händlerangaben (Adresse, Telefon, E-Mail werden in der EU öffentlich); In-App-Produkt `malachi_pro` (2,99 €, einmalig); ggf. Antrag auf das Small Business Program | – | vor Etappe A |
| 6 | **Französische Verschlüsselungserklärung** einreichen oder Frankreich ausnehmen; US-Exportfrage fachkundig klären lassen (wie `PLAY_STORE.md` 12) | ggf. Beratung | vor der ersten Einreichung |
| 7 | **Dauerhaft laufendes Android-Testgerät** mit Malachi als Demo-Kontakt für Apples Prüfer, dazu Prüfnotizen bzw. Video | vorhandenes Altgerät | vor M-C2 |
| 8 | **Datenschutzerklärung** um iOS ergänzen (StoreKit, keine Backups; Nominatim und STUN-Betreiber entfallen seit dem STUN-Ausstieg); Support-URL | – | vor Etappe A |
| 9 | **Steuerberater:** Apple-Auszahlungen und Provisionsabrechnung (Reverse-Charge auch für Kleinunternehmer), Einbindung in die Buchhaltungs-Automatik | – | vor dem ersten Verkauf |
| 10 | **Grundsatzentscheidungen** aus Abschnitt 8, vor allem Nr. 1–3 | – | Woche 1 |

---

## 8. Offene Entscheidungen

| # | Frage | Empfehlung |
|---|---|---|
| 1 | Ist ein iOS-Messenger im **Abholmodus** akzeptabel (kein Klingeln und keine Sofortzustellung bei geschlossener App)? | **Ja**, mit klarer Kennzeichnung. Die Alternative wäre „kein iOS-Messenger“. |
| 2 | Soll es jemals ein **Weck-Gateway** (APNs/PushKit) geben, als Ausnahme vom Grundsatz „nichts über den Server“? | **Nein für v1.** Neu bewerten, wenn echte Nutzerzahlen und Rückmeldungen vorliegen. Falls doch: inhaltsleer, über Tor, abschaltbar, Standard „aus“, eigener Server mit Betriebsaufwand. |
| 3 | **Etappe A (Siegel für iPhone) zuerst** veröffentlichen? | **Ja.** Schneller Nutzen, prüft den ganzen Apple-Weg (Konto, Signierung, In-App-Kauf, Exportangaben, Prüfung) mit wenig Risiko. Kostet den Messenger etwa 2 Wochen. |
| 4 | **Mindest-iOS-Version?** | **iOS 18.** Gleiche Geräte wie iOS 17 (ab iPhone XS/XR), aber weniger Versionen zu testen. Bei iOS 26 als Minimum wäre CryptoKit-ML-KEM möglich, ältere Geräte (XS/XR) fielen dann weg. |
| 5 | **ML-KEM auf iOS:** JS (`@noble/post-quantum`) oder CryptoKit? | **JS**, gleich wie die Web-App, läuft auf allen Versionen, gegen BouncyCastle kreuzgetestet. |
| 6 | **Router-Portfreigabe** (Stufe „Privat“) in v1? | **Weglassen** oder nur PCP/NAT-PMP. UPnP erst mit Multicast-Berechtigung. |
| 7 | **Frankreich** mit Erklärung bedienen oder ausnehmen? | Erklärung einreichen (Formsache), sonst ausnehmen. |
| 8 | **Konto:** Einzelperson (Name öffentlich) oder erst eine UG/GmbH gründen? | Für einen schnellen Start: Einzelperson. Ein späterer Wechsel zu einer Organisation ist über Apple möglich, aber aufwendig *(Ablauf nicht geprüft)*. |
| 9 | **Briefkasten-Modus** (Option B) oder **Wachmodus am Ladekabel** (Option H) nach v1? | Nach v1 anhand der Rückmeldungen entscheiden. H ist billig (wenige PT), B ist eine Protokollerweiterung mit Sicherheitsreview. |
| 10 | **iPad** unterstützen? | Nein für v1, nur iPhone (weniger Prüf- und Screenshot-Aufwand). |

---

## 9. Die größten Risiken

| Risiko | Wahrscheinlichkeit | Auswirkung | Gegenmaßnahme |
|---|---|---|---|
| Nutzer empfinden den Abholmodus als „Malachi ist kaputt“, schlechte Bewertungen | hoch | hoch | Hinweis in Store und App, Statusanzeige auf beiden Seiten, Etappe A zuerst |
| Tor im App-Prozess: Hänger nach Hintergrund oder Netzwechsel, kein sauberer Neustart möglich | mittel | hoch | Phase-1-Spike mit Go/No-Go, Umkonfigurieren statt Neustart, Selbstheilung über den Control-Port |
| Ablehnung bei der Prüfung (2.1 nicht testbar, 1.2 Blockieren fehlt, IPv6-only-Netz, Hintergrundmodi, Shop sichtbar) | mittel | mittel (Wochen) | Demo-Android, Prüfnotizen, NAT64-Test, nur echte Hintergrundmodi, `appstore`-Weiche mit Test, Blockieren vor der Einreichung |
| Abholen passt nicht in 30 s oder iOS weckt zu selten | mittel | mittel | messen; nach Priorität verbinden; ehrlich kommunizieren; Option B/H |
| Screenshot-Trick bricht mit einem iOS-Update | mittel | niedrig–mittel | nur als „erschwert“ bewerben, Erkennung und Abdeckung als zweite Linie |
| Zero-Trace-Lücken durch iOS-Eigenheiten (Schlüsselbund nach dem Löschen, Backups, Schnappschüsse, Anrufliste) | mittel | hoch | Checkliste 3.6 als Pflicht vor TestFlight extern, Sicherheitsreview |
| Abweichende Protokollbausteine (Argon2id, ML-KEM, Opus) | niedrig | hoch | Testvektoren in Jest, Selbsttest auf dem Gerät, Interop-Matrix (iPhone ↔ web, ↔ play, ↔ iPhone) |
| CocoaPods-Abschaltung, instabile Tor.framework-API | mittel | niedrig–mittel | Versionen festschreiben, notfalls xcframework direkt einbinden |
| Mac-Engpass, falls nur gemietet | mittel | mittel | eigener Mac (Abschnitt 3.9) |

---

## 10. Quellen (abgerufen im Oktober 2026)

**Apple – Richtlinien, Konto, Store**
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (1.2, 2.1, 2.5.2, 2.5.4, 3.1.1, 3.1.3(b), 3.1.5, 5.4)
- [Apple Developer Program – Enroll](https://developer.apple.com/programs/enroll/)
- [DSA-Händlerangaben](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-compliance-information)
- [Export Compliance](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/)
- [Apps in der EU](https://developer.apple.com/support/apps-in-the-eu/) · [TestFlight](https://developer.apple.com/testflight/)
- [IPv6 DNS64/NAT64](https://developer.apple.com/library/ios/documentation/NetworkingInternetWeb/Conceptual/NetworkingOverview/UnderstandingandPreparingfortheIPv6Transition/UnderstandingandPreparingfortheIPv6Transition.html)

**Apple – Technik**
- [Choosing Background Strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app) · [Forum: BGAppRefresh nach Wegwischen](https://developer.apple.com/forums/thread/721584) · [Stromsparmodus](https://support.apple.com/en-us/101604)
- [PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit) · [CallKit includesCallsInRecents](https://developer.apple.com/documentation/callkit/cxproviderconfiguration/includescallsinrecents)
- [Local Push Connectivity](https://developer.apple.com/documentation/networkextension/local-push-connectivity) · [NEAppPushProvider](https://developer.apple.com/documentation/networkextension/neapppushprovider)
- [CloudKit-Abos: Forumsbericht](https://developer.apple.com/forums/thread/820562)
- [TN3179 Local Network Privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) · [Forum: Multicast-Berechtigung](https://developer.apple.com/forums/thread/663875)
- [sceneCaptureState](https://developer.apple.com/documentation/uikit/uitraitcollection/scenecapturestate) · [iCloud-Backup-Ausschluss](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup) · [Forum: Schlüsselbund nach dem Löschen](https://developer.apple.com/forums/thread/36442)
- [StoreKit VerificationResult](https://developer.apple.com/documentation/storekit/verificationresult) · [CryptoKit MLKEM768](https://developer.apple.com/documentation/cryptokit/mlkem768)

**Tor**
- [Tor.framework 409.6.1](https://swiftpackageregistry.com/iCepa/Tor.framework) · [IPtProxy](https://github.com/tladesignz/IPtProxy)
- [Arti: OnionService.md](https://gitlab.torproject.org/tpo/core/arti/-/raw/main/doc/OnionService.md) · [tor-hsservice](https://docs.rs/tor-hsservice)
- [Tor-Einbettung: Neustart im selben Prozess (Ticket 24581)](https://git-crysp.uwaterloo.ca/piros/tor/commit/05ac3d0458466bd8ffc69339a4bf8e34088d9d80?lang=en-US)

**Markt und Recht**
- [Neue EU-Bedingungen ab 1.10.2026 (Michael Tsai)](https://mjtsai.com/blog/2026/08/18/new-eu-app-store-terms-to-comply-with-dma/) · [Phiture](https://phiture.com/blog/apple-new-app-store-terms-2026/)
- [US-Anti-Steering, Richtlinien Mai 2025](https://mjtsai.com/blog/2025/05/02/app-review-guidelines-updated-for-epic-anti-steering) · [Supreme Court, Mai 2026 (TNW)](https://thenextweb.com/news/supreme-court-apple-epic-contempt-stay-denial)
- [BIS-Verschlüsselungsregeln 2021 (Jones Day)](https://www.jonesday.com/en/insights/2021/04/commerce-reduces-requirements-relating-to-massmarket-encryption-items-and-publicly-available-software)
- [CallKit in China (TechCrunch 2018)](https://techcrunch.com/2018/05/25/googles-duo-and-ciscos-webex-teams-among-the-voip-apps-pulled-from-the-china-app-store) · [VPN-Entfernungen in Russland (TechCrunch 2024)](https://techcrunch.com/2024/07/08/apple-removes-vpn-apps-at-request-of-russian-authorities-say-app-makers)

**Screenshot-Schutz**
- [Daring Fireball, Aug. 2026](https://daringfireball.net/linked/2026/08/20/bluesky-threads-sneak-logo-into-screenshots) · [B4X-Forum (iOS 26)](https://www.b4x.com/android/forum/threads/prevent-screenshot-ios.170927/)

**Werkzeuge und Hardware**
- [Mac mini M6 (Macwelt)](https://www.macwelt.de/article/3246007/apple-mac-mini-mit-m6-chip-angebot-bei-amazon-zum-tiefstpreis-10-prozent-rabatt.html) · [Scaleway Mac mini M4](https://scaleway.com/en/news/apple-mac-mini-m4-as-a-service-with-scaleway) · [Scaleway-Vergleich](https://www.greenmini.nl/compare/scaleway-alternative/)
- [CocoaPods-Abschaltung (Courier)](https://www.courier.com/blog/cocoapods-end-of-life-heres-what-to-do) · [Firebase zu CocoaPods](https://firebase.google.com/docs/ios/cocoapods-deprecation)
- Codemagic, EAS Build, GitHub Actions: siehe Quellen in `IOS_MACHBARKEIT.md`

**Flutter**
- [sk_pqc](https://pub.dev/documentation/sk_pqc/latest/) · [liboqs für Dart](https://pub.dev/documentation/liboqs/latest/)

**Nicht abschließend verifiziert** (bewusst offen gelassen):
- ob `ADD_ONION` einen Unix-Socket als Ziel annimmt
- Tor-Startzeiten und BGAppRefresh-Häufigkeit auf echten iPhones (klärt Phase 1)
- Wirksamkeit des Secure-Field-Tricks unter iOS 26
- ob Apple einen e. K. als Organisation akzeptiert, und der Ablauf eines späteren Kontowechsels
- genaue EU-Provisionssätze seit 1.10.2026
- US-Selbsteinstufungsbericht für Massenmarkt-Software
- Gebrauchtpreise für Mac und iPhone, Apple-Angebotscodes als Ersatz für Geschenk-Lizenzen
- Leistung von ML-KEM und Argon2id unter Hermes auf iOS (Annahme: ML-KEM in JS reicht, Argon2id nativ)
