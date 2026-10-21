# Masterplan: Immer erreichbar – dauerhafte P2P-Verbindung im Hintergrund

Stand: 2026-09-29 · Grundlage: Nur-P2P-Architektur (kein TURN, keine Server-Zustellung), siehe `WebRTCManager.js` / `BackgroundSync.js`.
Baut auf `FOREGROUND_SERVICE_PLAN.md` auf (Foreground Service, HeadlessJS-Task, Alarm-Wecker, Boot-Receiver und Wake-WebSocket existieren bereits).

## Ziel

Solange beide Geräte Netz haben, besteht zwischen ihnen **ständig ein offener, verschlüsselter P2P-Kanal** – auch bei ausgeschaltetem Bildschirm und geschlossener App. Nachrichten kommen in Echtzeit an, die Sende-Warteschlange wird zum seltenen Ausnahmefall (Gerät aus, kein Netz).

**Messbare Abnahmekriterien** (Pixel 8 + Pixel 7a, Nacht-Dauertest 8 h, Bildschirm aus):

| Kennzahl | Ziel |
|---|---|
| Zeitanteil „direkt verbunden“, wenn beide Geräte Netz haben | ≥ 99 % |
| Zustellzeit einer Nachricht bei bestehender Verbindung | < 1 s |
| Wiederverbindung nach Netzwechsel (WLAN ↔ Mobilfunk) | < 3 s |
| Wiederverbindung nach Abbruch ohne Netzwechsel | < 2 s |
| Akkuverbrauch durch Malachi im Leerlauf | ≤ 1 % pro Stunde (erst messen, dann festlegen) |

## Was wir heute gemessen haben (Ausgangslage)

- Verbindungsaufbau Angebot → Kanal offen: **~0,5 s**. Kyber-Schlüsseltausch: **< 100 ms**.
- Pfad: direkt im WLAN, erst IPv6, nach ~5 s Wechsel auf lokales IPv4. **Einmal Abbruch ~10 s nach Aufbau** (nach dem Pfadwechsel), Neuaufbau nach 5 s; danach stabil.
- Behoben heute: Verbindung konnte ohne fertigen Schlüsseltausch ewig „hängen“ (jetzt 8-s-Wachhund).
- Schwachstelle Treffpunkt: Relay ist nur per IPv6 erreichbar; verliert ein Handy seine IPv6-Route (FritzBox-Präfixwechsel), findet es seine Kontakte nicht mehr neu.
- Cover-Traffic läuft fest alle **2 s** pro Verbindung – im Vordergrund gut, im Dauerbetrieb im Hintergrund zu teuer für den Akku.

## Phase 0 – Messbar machen (Voraussetzung für alles Weitere)

1. **Verbindungs-Logbuch** pro Kontakt (nur lokal, verschlüsselt, ohne IP-Adressen): verbunden seit, Abbrüche + Grund (ICE failed/disconnected, Zombie, Schlüsseltausch-Timeout, Netzwechsel), gewählter Pfad (Typ/IP-Version/Netz), Wiederverbindungsdauer.
2. **Diagnose-Ansicht** in den Einstellungen (Demo-Schalter): pro Kontakt grüner Punkt + „seit 3 h direkt verbunden, 2 Abbrüche“.
3. **Automatisierter Dauertest** per `adb` auf beiden Pixels: Nacht-Lauf mit Bildschirm aus, Doze erzwingen (`dumpsys deviceidle force-idle`), WLAN-Wechsel, Neustart – Auswertung der Kennzahlen oben aus dem Logbuch.

## Phase 1 – Die Verbindung selbst stabil halten

1. **Pfadwechsel ohne Abbruch:** Ursache des Abbruchs nach dem IPv6→IPv4-Wechsel klären (Logbuch). Kandidaten: Handy mit WLAN + Mobilfunk gleichzeitig (Pixel 7a), temporäre IPv6-Adressen, die rotieren. Lösungen je nach Befund: bevorzugtes Netz festlegen, kurzlebige IPv6-Privacy-Adressen meiden, „continual gathering“ aktivieren.
2. **ICE-Restart statt Neuaufbau:** Bei „disconnected“ oder Netzwechsel nur den Netzwerkpfad neu aushandeln. DataChannel und Sitzungsschlüssel bleiben erhalten, das dauert typischerweise < 1 s statt 5 s.
3. **Ereignisgesteuert statt Abfrage:** Abbruch erkannt → sofort neues (verschlüsseltes) Angebot + Wecksignal an die Gegenseite, nicht auf den nächsten Poll-Zyklus warten.
4. **Netzwechsel vorausschauend:** NetInfo meldet WLAN ↔ Mobilfunk → sofort ICE-Restart anstoßen, bevor die alte Leitung tot ist.

## Phase 2 – Dauerbetrieb im Hintergrund

1. **Foreground Service als Anker** (existiert, Typ `remoteMessaging` – unterliegt nicht dem 6-h-Tageslimit von `dataSync` unter Android 15). Verifizieren: Verbindungen in `RTCStore` überleben das Wegwischen aus „Zuletzt verwendet“; sonst übernimmt der HeadlessJS-Pfad den Neuaufbau.
2. **Akku-Optimierung ausnehmen:** beim Einrichten erklärter Dialog „Immer erreichbar“ (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). Für einen Messenger ohne Google-Push ist das ein legitimer Play-Store-Anwendungsfall – vorher die Richtlinie prüfen.
3. **Sparsamer Herzschlag im Hintergrund:** Cover-Traffic im Hintergrund von 2 s auf einen festen, längeren Takt (z. B. 20 s), kurz genug, um Router-/Mobilfunk-Firewalls offen zu halten (Timeouts dort typischerweise 30–120 s). Weiterhin gleich groß und gleichmäßig, damit „Nachricht“ und „nichts“ nicht unterscheidbar sind. Zombie-Erkennung passend dazu (z. B. 4 fehlende Herzschläge). Takt per Messung festlegen, nicht raten.
4. **Doze & Schlafmodus:** Prozesse mit Foreground Service dürfen laut Android-Quellcode auch im Doze ins Netz, JS-Timer können aber pausieren, wenn die CPU schläft. Ankommende Pakete wecken das Gerät. Der eigene Herzschlag wird bei Bedarf über den vorhandenen Alarm-Wecker (`setExactAndAllowWhileIdle`) abgesichert. Keine dauerhafte Wakelock (Akku).
5. **Nach Neustart und App-Update** automatisch wieder verbinden (Boot-Receiver existiert; `MY_PACKAGE_REPLACED` ergänzen).

## Phase 3 – Treffpunkt ausfallsicher (Geräte finden sich immer neu)

1. **Mietserver zum Launch mit IPv4 + IPv6** (Treffpunkt + STUN). Das behebt das Routenproblem und liefert zusätzlich öffentliche IPv4-Kandidaten, also mehr direkte Pfade.
2. **App erkennt „keine IPv6-Route“** und zeigt einen verständlichen Hinweis statt stiller Fehler, bis der Dual-Stack-Server live ist.
3. **Lokale Erkennung im selben WLAN (optional, später):** Kontakte im gleichen Netz finden sich auch ganz ohne Server (verschlüsselte Ankündigung im LAN).

## Phase 4 – Sicherheit bei Dauerverbindungen

1. **Regelmäßiger Neu-Schlüsseltausch (Rekey)** über den offenen Kanal, z. B. stündlich oder alle 1 000 Nachrichten, mit frischem Kyber. Sonst lebt ein Sitzungsschlüssel bei Dauerverbindung tagelang, und die Forward Secrecy wird schwächer.
2. **Sicherheitscode bleibt aussagekräftig:** Rekey darf keine falschen „Code hat sich geändert“-Warnungen auslösen. Der Code muss an die Identität gebunden sein, nicht an den Sitzungsschlüssel.
3. **Jede längere Laufzeit ist Angriffsfläche:** Replay-Schutz, Reihenfolge-Prüfung und Wachhunde bleiben aktiv, dazu Tests für Rekey-Rennen (Nachricht unterwegs während Rekey).

## Phase 5 – Viele Kontakte

- Dauerverbindungen nur für einen **„warmen Kreis“** (z. B. die 10 zuletzt aktiven Kontakte). Alle anderen werden bei Bedarf in < 1 s per Wecksignal verbunden. So bleiben Akku und Netz im Rahmen.
- Gruppenchats (Phase 2 des Gruppen-Plans) profitieren direkt: Jede Gruppennachricht geht einzeln über die bestehenden 1:1-Kanäle.

## Phase 6 – Transparenz für Nutzer

- Pro Kontakt sichtbar: direkt verbunden / verbindet / wartet (Warteschlange).
- Schalter „Immer erreichbar“ mit ehrlicher Akku-Angabe aus Phase-0-Messung.

## Phase 7 – „Tor zuerst“: Treffpunkt-Server überflüssig machen

**Stand 2026-10-03:** Tor-Ausweichweg für Nachrichten und Erstkopplung ist eingebaut und auf den Pixels getestet (5G gegen WLAN: Verbindung über Tor nach ~7 s, Warteschlange zugestellt). Onion-Adressen reisen verschlüsselt im Verbindungsangebot mit.

**Ziel:** Der Server erfährt nicht mehr, wer sich wann mit wem verbindet – und wird im besten Fall ganz verzichtbar (weniger Kosten, kaum noch personenbezogene Verarbeitung bei dir).

1. **Kopplung „privat“ (nur Tor):** QR-Code/Link enthält Token, Einmal-Geheimnis und Onion-Adresse; gekoppelt wird ausschließlich über Tor. Server sieht nichts. Option „Privat koppeln“ → später Standard.
2. **Verbindungsaushandlung über Tor:** Stehen sich zwei Kontakte schon einmal per Tor gegenüber, laufen WebRTC-Angebot/-Antwort für die schnellere Direktverbindung über den Tor-Kanal statt über den Treffpunkt. Danach wechselt die Verbindung auf direkt (wie heute).
3. **Wecksignal entfällt:** Ein laufender Onion-Dienst ist selbst die „Klingel“ – eingehende Tor-Verbindungen wecken die App.
4. **STUN-Entscheidung:** ohne eigenen Server entweder kein STUN (direkt nur IPv6/gleiches WLAN, sonst Tor) oder bewusst gewählter öffentlicher STUN (IP geht an Dritte) – Abwägung dokumentieren, Nutzer entscheiden lassen.
5. **Was ohne Server wegfällt (bewusst entscheiden):** Web-App (kein Tor im Browser), Kopplung per Telefonnummer. Website kann statisch günstig gehostet werden.
6. **Messen vor Abschalten:** Erfolgsquote und Dauer von Tor-Kopplung/-Verbindung über Wochen (Phase-0-Logbuch). Erst bei belastbaren Zahlen den Treffpunkt abschalten bzw. nur noch als Rückfall betreiben.

**Datenschutz-Effekt (keine Rechtsberatung):** ohne eigenen Server keine Verarbeitung von Nutzer-IP-Adressen/Verbindungszeiten durch dich → Auftragsverarbeitung mit dem Hoster, Verarbeitungsbeschreibung für den Server und Herausgabe-Fragen entfallen weitgehend. Bleiben: Datenschutzerklärung, Play-Store-Datenschutzangaben, ggf. Website.

### Entscheidung (2026-10-03)

**Tor kommt fest in Malachi** – nicht nur als Ausweichweg, sondern Schritt für Schritt als Standardweg für Kopplung und Verbindungsaushandlung („Tor zuerst“). Der Hetzner-Server bleibt vorerst stille Rückfallebene, bis die Messungen zeigen, dass Tor im Alltag trägt.

### Vergleich heute ↔ „Tor zuerst / ohne Server“

| Bereich | Heute (Server vermittelt, Tor als Ausweichweg) | Tor zuerst / ohne Server |
|---|---|---|
| Datenschutz ggü. eigenem Server | sieht IPs, Zeitpunkte, zufällige Kontakt-IDs | sieht nichts / existiert nicht |
| Datenschutz ggü. Kontakt | sieht bei Direktverbindung die IP | über Tor nicht; nach Wechsel auf direkt wieder doch (Option „immer Tor“ möglich, langsamer) |
| Datenschutz ggü. Provider/Staat | sieht, mit welcher IP man direkt spricht | sieht nur „nutzt Tor“ |
| Rechtliche Pflichten | Hoster-Auftragsverarbeitung, Verarbeitungsbeschreibung, Herausgabe-Anfragen | deutlich weniger (Datenschutzerklärung, Play-Store-Angaben, Website) – keine Rechtsberatung |
| Kosten | kleiner Server, wenige €/Monat | Server entfällt, Website günstiger |
| Ausfallsicherheit | Server = zentraler Punkt | kein Zentrum, nichts zu beschlagnahmen |
| Abhängigkeit | eigener Server | Tor-Netz (Sperren: Bridges helfen, aber nicht überall) |
| Geschwindigkeit Aufbau | 1–3 s | 7–60 s (erster Kontakt langsamer); danach Wechsel auf direkt möglich |
| Web-App | funktioniert (direkt + Warteschlange) | ohne Server nicht – siehe Phase 8 |
| Kopplung per Telefonnummer | funktioniert | entfällt ohne Server (QR/Link bleibt) |
| Direktverbindung IPv4 | eigener STUN | kein STUN (nur IPv6/LAN direkt, sonst Tor) oder öffentlicher STUN (IP an Dritte) |
| Angriffsfläche | Server ist Ziel (Web-App-Manipulation, Metadaten) | kein eigenes Ziel |
| Aufwand | läuft | mehrere Umbauschritte + Wochen Messung |

## Phase 8 – Web-App mit Tor im Browser (beobachten, nicht darauf bauen)

**Ziel:** Auch die Web-App nutzt Tor – ohne Brücke über den eigenen Server (die würde Daten über den Server leiten und scheidet aus).

**Weg:** Tor als WebAssembly im Browser (Arti/WASM), Anbindung ans Tor-Netz über Snowflake (läuft im Browser per WebRTC). Damit könnte die Web-App Onion-Adressen erreichen und selbst einen Onion-Dienst anbieten – genau wie die Android-App.

**Heute nicht produktreif** (Stand 2026-10). Kriterien, ab wann umsetzen:
1. Offizielle, gepflegte Arti-WASM-Veröffentlichung des Tor-Projekts mit Sicherheitsaudit.
2. Onion-**Dienste** (nicht nur Client) im Browser unterstützt und stabil.
3. Akzeptable Startzeit (< 30 s) und Speicherbedarf auf Mittelklasse-Geräten.

**Bis dahin:** Web-App = „Light-Version“ (direkt + Warteschlange), klar gekennzeichnet. Optionaler Zwischenschritt: Web-App im Tor Browser kann Handy-Kontakte über deren Onion-Dienst erreichen, wenn der Onion-Dienst zusätzlich WebSocket spricht (nur ausgehend, Browser selbst nicht erreichbar). Langfristig für Nicht-Android-Nutzer: Desktop-App mit eingebautem Tor.

**Regelmäßig prüfen** (z. B. vierteljährlich): Stand Arti/WASM und Snowflake-im-Browser beim Tor-Projekt.

## Grenzen (ehrlich)

- Ist das andere Gerät aus oder ohne Netz, bleibt die Warteschlange nötig – das ist bei echtem P2P prinzipbedingt.
- Hersteller-Energiesparer (Xiaomi, Huawei, teils Samsung) können Prozesse trotz Foreground Service beenden. Auf Pixel/Stock-Android gilt das nicht.
- In sehr restriktiven Netzen (manche Firmen- und Hotel-WLANs, reines IPv4 hinter Carrier-NAT auf beiden Seiten) kommt ohne TURN keine Direktverbindung zustande.
- Dauerbetrieb kostet Akku. Wie viel, entscheidet Phase 0, nicht eine Schätzung.

## Reihenfolge-Empfehlung

Phase 0 → Phase 1 → Phase 2 (Punkte 1–3) → Dauertest → Phase 4 (Rekey, vor Launch Pflicht) → Phase 3 (Mietserver: erledigt 2026-10-03) → Phase 7 (Tor zuerst) → Phase 5/6; Phase 8 (Tor im Browser) laufend beobachten.
Jede Phase im Worktree, mit Tests und einem Geräte-Dauertest vor Übernahme.
