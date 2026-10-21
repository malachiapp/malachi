# ZERO_KNOWLEDGE_RELAY_PLAN.md — Umsetzungsplan

## 0. Bestandsaufnahme (verifiziert, nicht nur übernommen)

Der bereits erledigte Text-Umbau (`queueOffline()`/`flushQueue()`, `App.tsx` Z.153–229, ausgelöst über `rtc._onReady = () => flushQueue(...)` in `checkOutgoing` Z.662 und `checkIncoming` Z.1029, getriggert aus `rtc._onKeyExchange` in `RTCStore.js` Z.233–303) ist real und korrekt verdrahtet — kein toter Code mehr, wie es beim `'system'/'ready'`-Signal der Fall war (der jetzt entfernte Kommentar in `RTCStore.js` Z.220–232 bestätigt das explizit).

Aber der Umbau ist **unvollständiger als die Aufgabenbeschreibung suggeriert**. Vier Lücken, die ich zusätzlich gefunden habe:

1. **Web-Client hat gar keine lokale Queue.** `web/src/App.tsx` `send()` (Z.1430–1481) versucht 10× alle 3s (`RTCStore.sendMessage`) und schickt danach den **Nachrichtentext weiterhin live** per `POST /packet` an den Relay (`sendPacket`, Z.1474–1476) — verschlüsselt und gepolstert (`padToBlock`), aber echter Content, kein Signalisierungs-Metadatum. Es gibt kein Äquivalent zu `queueOffline`/`flushQueue` im Web-Client. Die Aussage „für Text bereits erledigt" gilt also nur für die native App, nicht für den Web-Begleitclient.
2. **Bild/Audio haben zusätzlich zur neuen lokalen Queue noch einen zweiten, älteren Relay-Fallback**, der nicht Teil der Aufgabenbeschreibung war, aber aktiv Content über den Relay schickt: der `useEffect` „Relay-Transfer für lange Offline-Zeiten" in `App.tsx` Z.449–551 (`checkRelayQueue`) läuft 30s nach Start und danach alle 10 Minuten, und ruft für `item.type==='image'|'audio'` `sendEncryptedImageOffline`/`sendEncryptedAudioOffline` (`ImageCrypto.js` Z.23, `AudioCrypto.js` Z.23) auf. Diese chunk-verschlüsseln das Bild/Audio (mit dem Shared Secret) und laden es über `sendTransferChunk` → `POST /transfer/:token/chunk/:index` beim Relay hoch (`relay.js` Z.429–451). Text-/System-Items werden von dieser Schleife explizit übersprungen (fallen in `remaining`), aber Bild/Audio eben nicht.
3. **`delete_chat`, `clear_chat`, `device_wiped` laufen NICHT nur als Fallback, sondern unbedingt und sofort** über `POST /packet` — unabhängig vom Verbindungsstatus (`deleteContactCleanup` Z.1150–1164, `clearChatMessages` Z.1182–1192, Wipe-Pfad Z.1430–1449). Das ist kein Bug, sondern hat einen strukturellen Grund (siehe Abschnitt 2c) — aber es ist eben kein reiner „Fallback, nur wenn P2P nicht klappt", wie die Aufgabenbeschreibung es einordnet.
4. **`contact.id` ist nicht nur der Relay-Routing-Key, sondern zugleich der lokale Primärschlüssel** für Chatverlauf (`chat_+id`), Shared Secret (`shared_secret_+id`), Timer, RTCStore-Maps usw. Das ist für Abschnitt 2 relevant: Rotation darf diese lokale ID nicht anfassen, sonst reißt man halb App auseinander für nichts.

Zusätzlicher, im Auftrag nicht erwähnter, aber sicherheitsrelevanter Fund:

5. **`FORCE_RELAY_ONLY = true`** (`WebRTCManager.js` Z.161, `iceTransportPolicy:'relay'`) ist der **Standard**. Das bedeutet: die als „P2P" bezeichnete WebRTC-DataChannel-Verbindung läuft in der Praxis fast immer durch **coturn auf demselben Server/Betreiber wie relay.js** — coturn kann die DTLS/SRTP-verschlüsselten Bytes zwar nicht lesen, relayt aber in Echtzeit jedes einzelne Byte, inklusive Timing und Volumen, für die gesamte Dauer jedes Chats. Das ist etwas grundsätzlich anderes als „Relay nur als Fallback bei Signalisierung" — der Betreiber-Prozess (bzw. dessen coturn-Instanz) ist aktuell dauerhaft Transport-Relay für den kompletten Datenverkehr, nicht nur für Verbindungsaufbau. Das wird in Abschnitt 4 als eigener, nicht trivialer Zielkonflikt behandelt.

---

## 1. Vollständige Elimination von Nachrichteninhalten

### 1a. Web-Client: Text-Fallback auf lokale Queue umstellen — Stufe 1

- **Betroffen:** `web/src/App.tsx` (`send()` Z.1430–1481), `web/src/lib/RTCStore.ts`, `web/src/lib/RelayClient.ts`.
- **Problem:** Web hat kein Dateisystem wie RNFS, aber `localStorage`/`IndexedDB` genügt für eine analoge Queue (Payload ist ohnehin klein, verschlüsselt).
- **Skizze:** Portiere `queueOffline()`/`flushQueue()` 1:1 nach `web/src/App.tsx` bzw. eine neue `web/src/lib/Queue.ts`, ersetze `RNFS.writeFile`/`readFile` durch `localStorage.setItem`/`getItem` (Key `queue_<contactId>`, Wert als JSON-Array analog zur nativen Struktur, `item.path` entfällt, Payload direkt im Eintrag). `trySend()` ruft bei `attempts===0` statt `sendPacket(...)` künftig `queueOffline(...)`. `rtc._onReady` muss in `web/src/lib/RTCStore.ts` beim Reconnect genauso gesetzt werden wie nativ (dort fehlt das aktuell komplett — das ist der eigentliche Grund, warum Web nie in eine lokale Queue geflusht hat).
- **Kompromiss:** Web-Client hat typischerweise kürzere Lebensdauer (Tab kann jederzeit geschlossen werden) — eine rein lokale Queue kann dort öfter „für immer" hängen bleiben als auf einem Handy mit Hintergrunddienst. Das ist real und sollte dem Nutzer im UI kommuniziert werden (z. B. „Nachricht wird zugestellt, sobald Empfänger online ist — Tab offen lassen oder später erneut öffnen").

### 1b. Bild/Audio: alten Relay-Chunk-Fallback abschalten — Stufe 1

- **Betroffen:** `App.tsx` (kompletter `useEffect` Z.449–551 „Relay-Transfer für lange Offline-Zeiten"), `ImageCrypto.js` (`sendEncryptedImageOffline`), `AudioCrypto.js` (`sendEncryptedAudioOffline`), `RelayClient.js`/`web/src/lib/RelayClient.ts` (`sendTransferChunk`, `getTransfer`, `deleteTransfer`), `relay.js` (`/transfer/*`-Endpunkte).
- **Skizze:** Die eigentliche Bild/Audio-Queue läuft bereits korrekt über `queueOffline()`/`flushQueue()` (Typen `'image'`/`'audio'` sind in `flushQueue()` Z.201–208 schon abgedeckt). Der `useEffect` bei Z.449–551 ist der **einzige verbliebene relay-content-Pfad** und kann komplett entfernt werden, sobald man akzeptiert, dass Bild/Audio wie Text jetzt unbegrenzt lokal warten, statt nach 10 Minuten auf den Relay „aufzugeben". `sendEncryptedImageOffline`/`sendEncryptedAudioOffline` können danach als toter Code entfernt werden (nur noch `sendEncryptedImage`/`sendEncryptedAudio`, die live-über-DataChannel senden, bleiben). `relay.js`s `/transfer/*`-Routen (Z.428–484) und der zugehörige `transfer_`-Cleanup (Z.1111–1118) können danach ebenfalls entfernt werden — dazu muss `transfer_ready` mitentfernt werden (siehe 1c).
- **Kompromiss (explizit, wie gefordert):** Aktuell ist der Sinn dieses Fallbacks „auch nach sehr langer Offline-Zeit (>10 Min ohne P2P) irgendwann zustellen, notfalls über den Relay". Ohne ihn gilt: **wenn beide Geräte nie gleichzeitig online sind/sich nie erfolgreich reconnecten, wird das Bild/Audio nie zugestellt**, exakt wie bei Text heute schon. Das ist eine bewusste Konsequenz aus der Nutzervorgabe, keine Nebenwirkung — muss aber im Plan stehen, weil es eine Zustellgarantie ist, die es vorher (in Grenzen) gab und die jetzt komplett wegfällt.

### 1c. System-Kontrollnachrichten — differenziert bewerten, Stufe 1/2

Nicht alle vier Typen sind gleich zu behandeln, weil sie strukturell unterschiedlich sind:

- **`clear_chat`** (`App.tsx` Z.1175–1192, `web/src/App.tsx` analog): Kontakt bleibt bestehen, nur der Verlauf wird geleert. Kann **problemlos auf `queueOffline()`/`flushQueue()` umgestellt werden** (Typ `'system'`, wird von `flushQueue()` schon unterstützt, Z.209–212) — Stufe 1, geringer Aufwand.
- **`delete_chat`** (`App.tsx` Z.1116–1169): Hier liegt der eigentliche Grund, warum aktuell sofort über `/packet` gesendet wird: `deleteContactCleanup()` entfernt den Kontakt **im selben Zug** aus der lokalen Kontaktliste (`AsyncStorage`/`updateContacts`), über die `checkOutgoing`/`checkIncoming` iterieren (`cs = JSON.parse(saved).filter(...)`). Eine rein lokale Queue würde nie abgearbeitet, weil der Kontakt, für den sie bestimmt ist, ab dem nächsten Poll-Zyklus gar nicht mehr in der Liste steht, über die `flushQueue()`/Reconnect-Versuche laufen. Um das ohne Relay-Content zu lösen, braucht es eine **separate „Tombstone-Warteschlange"**: eine eigene, von der sichtbaren Kontaktliste getrennte Liste `pending_tombstones` (Key z. B. `EncryptedStorage` unter `tombstone_queue`), die `checkOutgoing`/`checkIncoming` zusätzlich zur normalen Kontaktliste für einen begrenzten Zeitraum (Vorschlag: analog zur bestehenden 33-Tage-Reconnect-TTL in `relay.js`, `EXPIRE_RECONNECT`) weiter versucht zu erreichen und dann verwirft. Das ist **kein Copy-Paste von `queueOffline()`**, sondern echter neuer Code in `checkOutgoing`/`checkIncoming` (Stufe 2, mittlerer Aufwand — Reconnect-Loop muss zwei Quellen kombinieren).
- **`device_wiped`** (`App.tsx` Z.1416–1450, direkt vor `RTCStore.resetAll()` und `AsyncStorage.multiRemove([...])`): Das ist der Fall, bei dem ich **explizit von einer rein lokalen Lösung abrate**. Der Sinn eines Wipes (nach 5 Fehlversuchen oder manuell) ist: „benachrichtige alle Kontakte JETZT, bevor der gesamte lokale Zustand inklusive einer etwaigen Warteschlange gleich unwiederbringlich gelöscht wird". Eine lokale Queue würde hier durch denselben Wipe-Vorgang mitgelöscht, den sie überleben müsste — das widerspricht sich strukturell. Realistische Optionen: (a) so lassen wie jetzt (einzige verbleibende „Content"-artige Relay-Nutzung, aber es ist nur ein True/False-Signal ohne Payload-Inhalt, siehe unten), oder (b) einen sehr kurzlebigen, separaten „Wipe-Notice"-Escrow einführen, der NICHT den vollen App-Zustand teilt, sondern nur die eine verschlüsselte Notiz + Zieladresse für z. B. 24h persistiert, unabhängig vom eigentlichen App-Wipe, und von einem Mini-Hintergrunddienst nachgeliefert wird. (b) ist machbar, aber zusätzlicher Code-Pfad nur für einen seltenen Fall — Stufe 2, mit der offenen Frage, ob der Aufwand lohnt.
- **`transfer_ready`** entfällt automatisch, sobald 1b umgesetzt ist (kein Relay-Transfer mehr, für den ein Zeiger nötig wäre).

Zur Einordnung „Inhalt oder Metadatum": `delete_chat`/`clear_chat`/`device_wiped` transportieren selbst **keinen Nachrichteninhalt** (nur ein Steuersignal + Zeitstempel, verschlüsselt), aber sie sind trotzdem klassifizierbare Verkehrsdaten-Ereignisse mit Empfänger-Routing-Key — das ist für Abschnitt 2 (Routing-Anonymität) relevant, nicht für Abschnitt 1 (Inhalts-Elimination). Wenn Stufe 2 aus 1c nicht umgesetzt wird, bleibt genau diese kleine, inhaltlose Signalmenge über den Relay — das sollte man als bewusst akzeptierten Rest-Kompromiss benennen, nicht verschweigen.

---

## 2. Echtes Zero-Knowledge-Relay-Routing

### 2a. Rotierende Rendezvous-Tokens — Kern-Empfehlung, Stufe 1/2

**Kernidee, konkret auf diese Architektur gemünzt:** `deriveContactId()` (`App.tsx` Z.3760–3766) berechnet `SHA-256("malachi_2026_pairing_"+token+"|"+pskHex)` — deterministisch aus Material, das **nur die beiden Geräte kennen** (das PSK geht nie an den Relay). Das bedeutet: beide Seiten können unabhängig, ohne jede Relay-Interaktion, denselben nächsten Rendezvous-Wert ableiten, indem sie zusätzlich zu Token+PSK eine geteilte, aber lokal bekannte Variable einbeziehen — der natürliche Kandidat ist die **Zeit** (Epoche), weil sie beiden Seiten ohne Synchronisation zur Verfügung steht.

Vorschlag: `deriveRendezvousId(pskRoot, epoch) = 'r_' + HMAC-SHA256(pskRoot, "malachi_rendezvous_v1|" + epoch).slice(0,32)`, mit `epoch = floor(Date.now() / EPOCH_MS)`.

- Diese neue Funktion ersetzt `contact.id` **ausschließlich in den Netzwerk-Aufrufen an relay.js** (`/reconnect/offer/:key`, `/reconnect/answer/:key`, `/call/signal/:contactId/:direction`, `/packet/:recipient` für den verbleibenden Rest aus 1c, WS-`subscribe`-Liste). `contact.id` selbst bleibt unverändert als lokaler Primärschlüssel (Chatverlauf, Shared Secret, RTCStore) — das entkoppelt „lokale Identität" von „Relay-sichtbarer Identität" sauber, ohne die App-Datenstruktur anzufassen.
- **Epochenlänge:** Nicht zu kurz wählen. Rotation kostet bei jedem Wechsel einen frischen `POST /reconnect/offer` (nur relevant während der Kontakt offline ist — solange `RTCStore.isConnected()` true ist, sendet `checkOutgoing` ohnehin nichts, Z.629). Empfehlung: 6–24h Rotationsfenster, mit Toleranzfenster beim Abfragen (`epoch-1, epoch, epoch+1` prüfen) — exakt das gleiche Muster, das der Code bei `isFreshTimestamp()` (Z.239–245) schon für Zeitstempel-Toleranz nutzt, hier nur auf Epochengrenzen statt Nachrichtenalter angewendet.
- **Ein Präzedenzfall existiert im Code bereits in Miniaturform:** `dynamicAnswerKey = answerKey + '_' + sessionId` (Z.638, `checkOutgoing`) rotiert schon **pro Verbindungsversuch** zufällig — nur eben nicht für den primären Offer-Kanal selbst, weil dort ein deterministischer Treffpunkt nötig ist (der Responder kann keinen zufälligen Wert erraten, den er nicht mitgeteilt bekommen hat). Die Epochen-Lösung liefert genau diesen deterministischen, aber rotierenden Treffpunkt für den Offer-Kanal, den `dynamicAnswerKey` für den Answer-Kanal schon hat.
- **WS-Subscribe-Problem:** `setWakeSubscriptions(ids)` (`RelayClient.js` Z.316–321, `relay.js` `wakeSubs`) sendet aktuell die **komplette Kontaktliste auf einen Schlag** an den Relay (`relay.js` eigener Kommentar Z.197–208 nennt das schon offen einen Kompromiss). Mit rotierenden IDs muss diese Subscribe-Liste bei jeder Rotation neu gesendet werden — sonst bleibt die alte, stabile ID faktisch das eigentliche Tracking-Merkmal und die ganze HTTP-Rotation ist wirkungslos. Das ist ein Pflicht-Begleitfix, kein optionaler.
- **Aufwand:** mittel. Betroffen: `App.tsx` (6 Aufrufstellen: `checkOutgoing`, `checkIncoming`, `sendReconnectOffer/Answer`-Aufrufe, `CallManager.js`-Aufrufe), `web/src/App.tsx` (gleiche Stellen), `RelayClient.js`/`web/src/lib/RelayClient.ts` (keine Änderung nötig, sie nehmen ja weiterhin nur einen String-Key entgegen), `CallManager.js` (`contactId`-Parameter wird zum rotierenden Wert). `relay.js` selbst braucht **keine Änderung** — er sieht ohnehin nur einen beliebigen String als Routing-Key, ob stabil oder rotierend ist ihm strukturell egal.

### 2b. PIR-artige Batch-Abholung — Kosten/Nutzen realistisch, Stufe 2 (abgespeckt), nicht Stufe 1

Echtes kryptografisches PIR (Private Information Retrieval, z. B. homomorph oder Multi-Server-PIR) ist für dieses Setup **nicht sinnvoll** — das ist Forschungsniveau, braucht entweder mehrere unabhängige, sich nicht absprechende Server (hier: ein einziger Node-Prozess) oder erhebliche Rechenlast pro Abfrage, und bei vermutlich sehr wenigen Nutzern (Familien-/Freundeskreis-Server) ist die Anonymitätsmenge ohnehin winzig — selbst perfektes PIR würde bei z. B. 5 Nutzern nicht viel verschleiern, gegen wen sich der Traffic richtet, weil „wer redet überhaupt mit diesem Server" schon fast alles verrät.

Realistische, günstige Annäherung („Poor-Man's-PIR"): Da nach Stufe 1 kaum noch Content über `/packet` läuft (nur noch die dünnen System-Reste aus 1c, plus `/reconnect/offer`/`/reconnect/answer`-Einträge), ist der Store ohnehin klein. Jeder Client kann bei jedem Poll **den gesamten aktuell gespeicherten Bestand** abholen (ein neuer Endpunkt, z. B. `GET /packet/all` statt `GET /packet/:recipient`) und lokal selbst filtern, was er mit seinen bekannten Shared Secrets entschlüsseln kann. Das entzieht dem Relay die Möglichkeit, aus dem Anfrage-Pfad selbst („wer fragt nach wessen Empfänger-Key") irgendetwas abzuleiten — jede Anfrage sieht identisch aus, unabhängig vom Ziel.

- **Kosten:** Bandbreite pro Poll wächst mit der Gesamtzahl aller wartenden Einträge aller Nutzer, nicht nur der eigenen — bei geschätzt wenigen Dutzend Einträgen im schlimmsten Fall (10-Minuten-TTL, kleine Nutzerzahl) vernachlässigbar.
- **Empfehlung:** für die verbleibenden `/packet`- und `/reconnect/*`-Endpunkte umsetzen (Stufe 2), aber **nicht** für `/call/signal` (dort ist Echtzeit-Latenz für Klingeln wichtig, Batch-Overhead würde das verschlechtern, und Anruf-Metadaten sind ohnehin schon bewusst unvollständig anonymisiert, siehe `relay.js` Kommentar Z.912–918).

### 2c. Padding/Timing-Verschleierung der Polls — Stufe 2, geringe Priorität

- Es gibt bereits ein Padding-Muster im Code für Payload-Länge (`padToBlock()` in `WebRTCManager.js`, genutzt für Nachrichten vor der Verschlüsselung). Das Analogon auf Transportebene fehlt: Poll-Intervalle sind aktuell fixe Werte (`checkIncoming` alle 8000ms, `checkOutgoing` alle 15000ms, `checkRelayQueue` alle 10min, Anruf-Poll alle 2000ms) — ein reines Timing-Fingerprint-Muster, an dem sich (theoretisch) ein Client von einem Server unterscheiden ließe, wenn man den Traffic mitschneidet. Der WS-Reconnect (`RelayClient.js` Z.268–275) hat schon Jitter (`+ Math.random()*500`).
- **Empfehlung:** dieselbe Art Jitter (±10–20 % des Intervalls) auf `checkIncoming`/`checkOutgoing` anwenden — Zweizeiler pro Stelle, kein architektonischer Eingriff. **Kein** aufwendiges Constant-Rate-Cover-Traffic-Schema (würde Akku/Datenvolumen auf Mobilgeräten unverhältnismäßig belasten, für den erwarteten Bedrohungsgrad — ein Heimserver-Betreiber, potenziell zur Herausgabe verpflichtet, nicht ein Traffic-Analyse-Angreifer mit Netz-Zugriff — nicht gerechtfertigt).
- Antwortgrößen (z. B. `{packets:[]}`-Arrays) auf feste Bucket-Größen zu padden ist billig nachrüstbar, aber der Nutzen ist bei ohnehin kleinen, meist leeren Antworten marginal — niedrige Priorität, Stufe 2, „nice to have".

### 2d. Was mit vertretbarem Aufwand geht vs. Mixnet/Tor — konkrete Empfehlung

**Gegen ein Mixnet/Tor-artiges Setup als Kernarchitektur, aus drei konkreten Gründen:**

1. **WebRTC/TURN und Tor vertragen sich strukturell schlecht.** coturn braucht direkt erreichbare UDP-Endpunkte für den eigentlichen Medien-/DataChannel-Transport — das lässt sich durch Tor (das TCP-basiert ist und für Realtime-UDP nicht ausgelegt ist) nicht sinnvoll tunneln, ohne den eigentlichen P2P-/TURN-Pfad separat zu lassen. Man würde am Ende zwei komplett getrennte Transportwege pflegen (Tor nur für die dünne Signalisierung, weiterhin Klartext-IP für TURN) — der größte Teil des IP-Sichtbarkeitsproblems (TURN-Relay, siehe 0.5 und Abschnitt 4) bliebe dabei ohnehin ungelöst.
2. **Anonymitätsmenge ist bei diesem Nutzerkreis strukturell winzig.** Ein Mixnet gewinnt seine Schutzwirkung aus vielen gleichzeitigen, nicht unterscheidbaren Nutzern. Bei einem privaten Heimserver mit vermutlich einstelliger bis niedriger zweistelliger Nutzerzahl ist „wer redet mit diesem Server" bereits fast das ganze Bild — ein Mixnet würde technischen Aufwand in eine Eigenschaft investieren, die durch die Nutzerzahl selbst begrenzt ist, nicht durch fehlende Mix-Technik.
3. **Operativer Aufwand steht in keinem Verhältnis.** Tor-Hidden-Service-Betrieb, Tor-Client-Integration auf Android (kein natives OS-Feature — bräuchte Orbot oder eine eingebettete Tor-Library), höhere Latenz, geringere Zuverlässigkeit — für eine App, die auf schnelle Reconnects und Klingel-Latenz beim Anruf angewiesen ist, ein schlechter Trade.

**Was stattdessen mit vertretbarem Aufwand auf einem einzelnen Node-Prozess machbar ist** (= genau 2a + 2b + 2c): rotierende Rendezvous-Tokens, Batch-Abholung statt gezielter Anfrage, leichtes Timing-Jitter. Das reduziert **Inhalts-Korrelierbarkeit über die Zeit** spürbar (ein Beobachter, der nur gelegentlich reinschaut, sieht keinen stabilen Key mehr, der einen Kontakt über Monate identifiziert) — es beseitigt aber nicht die IP-Ebene (siehe 2e/Abschnitt 4).

**Einzige gezielt sinnvolle „echte Anonymisierungs"-Ergänzung, falls der Nutzer bereit ist, den Aufwand zu tragen:** relay.js zusätzlich (nicht ersetzend) als Tor v3 Hidden Service für die Signalisierungs-/Reconnect-Endpunkte anzubieten (optionaler zweiter Zugang neben der bestehenden DuckDNS-Domain), NUR für den leichten Signalisierungsverkehr, nicht für TURN. Das würde die IP-Sichtbarkeit für den Rendezvous-Anteil des Traffics tatsächlich beseitigen — aber siehe Abschnitt 4, warum das die eigentliche EU-Vorratsdatenspeicherung-Sorge nur teilweise adressiert. Einstufung: Stufe 3, „möglich, aber ich rate mangels Aufwand/Nutzen aktuell davon ab", nicht „unmöglich".

### 2e. IP-Sichtbarkeit — inhärente Grenze, nicht verschweigen

`relay.js` dokumentiert das bereits ehrlich in seinen eigenen Kommentaren (Z.11–24, Z.274–288): jede Anfrage — HTTP wie WebSocket-Upgrade — kommt mit `req.socket.remoteAddress` an, in Echtzeit, für den laufenden Prozess sichtbar, unabhängig davon, wie gut Payload und Routing-Key verschlüsselt/rotiert sind. `hashIp()` ist ausdrücklich nur **Log-Hygiene** (schützt spätere Logdatei-Leser vor einer Rainbow-Table über den 32-Bit-IPv4-Raum), nicht **Echtzeit-Unsichtbarkeit** gegenüber dem laufenden Prozess selbst oder gegenüber jemandem, der genau diesen Prozess (nicht nur seine Logdateien) unter Beobachtung/Auflagen stellt.

Das gilt unverändert für **jede** der oben vorgeschlagenen Maßnahmen (rotierende Tokens, Batch-Abholung, Padding) — sie alle ändern nichts an der Tatsache, dass der Betreiber-Prozess weiß, welche IP wann eine Verbindung aufgebaut hat. Nur ein Tor-Hidden-Service-artiges Setup (oder ein VPN/Proxy außerhalb der eigenen Kontrolle) würde das für den Rendezvous-Anteil ändern — mit den unter 2d genannten Kosten, und ohne den TURN-Anteil zu lösen.

---

## 3. Gestufter Plan im Überblick

| Stufe | Maßnahme | Betroffene Dateien | Aufwand |
|---|---|---|---|
| **1** | Web-Client Text-Fallback → lokale Queue (1a) | `web/src/App.tsx`, `web/src/lib/RTCStore.ts`, neue `web/src/lib/Queue.ts` | mittel |
| **1** | Alten Bild/Audio-Relay-Chunk-Fallback entfernen (1b) | `App.tsx` (Z.449–551 löschen), `ImageCrypto.js`, `AudioCrypto.js`, `RelayClient.js`/`.ts`, `relay.js` (`/transfer/*` entfernen) | gering–mittel |
| **1** | `clear_chat` auf lokale Queue umstellen (1c) | `App.tsx` (Z.1175–1192), `web/src/App.tsx` | gering |
| **2** | `delete_chat` → separate Tombstone-Warteschlange (1c) | `App.tsx` (`checkOutgoing`/`checkIncoming`, neue Tombstone-Liste), `web/src/App.tsx` | mittel–hoch |
| **2** | Rotierende Rendezvous-Tokens (2a) | `App.tsx` (6 Aufrufstellen), `web/src/App.tsx`, `CallManager.js`, `RelayClient.js`/`.ts` (WS-Subscribe-Re-Send bei Rotation) | mittel |
| **2** | Batch-/PIR-lite-Abholung für `/packet`, `/reconnect/*` (2b) | `relay.js` (neuer `GET`-Endpunkt), `RelayClient.js`/`.ts`, `App.tsx`/`web/src/App.tsx` (lokaler Filter) | mittel |
| **2** | Poll-Jitter (2c) | `App.tsx`, `web/src/App.tsx` | gering |
| **3** | `device_wiped` ohne Relay (1c, Variante b) | `App.tsx` | mittel, fraglicher Nutzen |
| **3** | Tor-Hidden-Service als optionaler Zweitzugang (2d) | `relay.js`, Deploy-Skripte, Android-Client (Orbot/Tor-Lib) | hoch, aktuell **nicht empfohlen** |
| **3 (nicht empfohlen)** | Echtes kryptografisches PIR / Mixnet | — | Forschungsniveau, Aufwand/Nutzen bei dieser Nutzerzahl schlecht |

---

## 4. Ehrlichkeits-Sektion — was dieser Plan nicht leisten kann

- **IP-Timing-Korrelation bleibt bestehen.** Auch mit rotierenden Tokens: wenn IP A und IP B wiederholt, über Wochen, in engem zeitlichem Zusammenhang beim selben Server anfragen, ist das ein Korrelationssignal, das praktisch kaum vollständig zu eliminieren ist ohne echtes Anonymitätsnetzwerk (siehe 2d/2e). Rotierende IDs verhindern nur, dass ein **einzelner stabiler String** über die gesamte Kontaktdauer als Tracking-Anker dient — sie verhindern nicht Verkehrsanalyse auf IP-Ebene.
- **TURN-Relay ist schon heute mehr als „Fallback".** `FORCE_RELAY_ONLY=true` bedeutet: der Regelfall ist, dass die komplette „P2P"-Kommunikation durch coturn auf demselben Server/Betreiber läuft — nicht nur der Verbindungsaufbau. Dieser Plan ändert daran nichts automatisch; eine Entscheidung, `FORCE_RELAY_ONLY` zu lockern, hätte den Nebeneffekt, dass Kontakte gegenseitig ihre echten IPs sehen (ein bewusst gewählter Trade-off im bestehenden Code, siehe `WebRTCManager.js` Kommentar Z.136–161) — das ist ein Zielkonflikt, den ich nicht stillschweigend auflöse, sondern dem Nutzer als offene Entscheidung vorlege.
- **Bei kleiner Nutzerzahl ist die Anonymitätsmenge strukturell klein.** Selbst mit allen Stufe-1/2-Maßnahmen bleibt „wer überhaupt mit diesem Server spricht" (schon am reinen Verbindungsaufbau sichtbar) ein aussagekräftiges Signal, wenn nur eine Handvoll Nutzer existiert.
- **Zustellgarantie sinkt spürbar.** Nach 1b/1c gilt für Text, Bild, Audio und `clear_chat`: kommt es nie zu einer erfolgreichen P2P-Reconnect-Verbindung (z. B. weil ein Kontakt monatelang offline ist), wird die Nachricht **nie** zugestellt — es gibt keinen Relay-Fallback mehr, der das auffängt. Das ist eine bewusste, vom Nutzer gewollte Konsequenz, aber eine echte Verschlechterung der Zustellzuverlässigkeit gegenüber heute.
- **EU-Vorratsdatenspeicherung-Risiko wird reduziert, nicht beseitigt.** Selbst im besten Fall (alle Stufe-1/2-Maßnahmen umgesetzt) sieht der laufende Prozess weiterhin: Quell-IP jeder Anfrage, ungefähre Anfragehäufigkeit/-größe, TURN-Allokationspaare samt Byte-Volumen/-Timing. Eine gesetzliche Pflicht zur Verkehrsdatenspeicherung würde sich typischerweise genau auf solche Verbindungsdaten beziehen (wer, wann, mit wem verbunden), nicht nur auf Nachrichteninhalte — und die bleiben, wie in 2e beschrieben, ohne echtes Anonymitätsnetzwerk technisch unvermeidbar sichtbar für den Betreiber-Prozess selbst.
- **Kein selbstentwickeltes Krypto-Protokoll.** Wie an mehreren Stellen im bestehenden Code (`relay.js` Kommentar zu PAKE/OPRF) bereits so gehandhabt, sollte auch hier gelten: HMAC-basierte Rotation aus vorhandenen Primitiven ja, aber kein eigenentwickeltes PIR- oder Mixnet-Protokoll — das wäre über den Kopf des Projekts hinaus und ein eigenes Sicherheitsrisiko.

---

## Kritische Dateien für die Umsetzung

- `App.tsx`
- `web/src/App.tsx`
- `relay.js`
- `RelayClient.js` (und `web/src/lib/RelayClient.ts`)
- `WebRTCManager.js`
