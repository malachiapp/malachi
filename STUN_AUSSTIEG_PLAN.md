# STUN-Ausstieg – Machbarkeitsanalyse und Implementierungsplan

Stand: 25.10.2026 · Grundlage: Worktree `features-okt26` (Branch `claude/features-okt26`), nur gelesen.
Es wurde nichts gebaut, nichts am Gerät gemessen und nichts am Server geprüft. Alle Erfolgsquoten
stammen aus Fachliteratur oder sind Schätzungen. Schätzungen, die vor einer Entscheidung gemessen
werden müssen, sind mit **[Annahme – messen]** markiert.

---

## 0. Begriffe in einfachen Worten

| Begriff | Bedeutung |
|---|---|
| **IP-Adresse, Port** | Die Adresse eines Geräts im Internet und die „Hausnummer“ des Programms darauf. |
| **NAT** (Network Address Translation) | Der Router übersetzt die privaten Adressen im Heimnetz (z. B. `192.168.178.20`) auf seine eine öffentliche IPv4-Adresse. Von außen kommt nur etwas durch, wenn vorher von innen ein Paket an genau diese Gegenstelle ging. |
| **CGNAT** (Carrier-Grade NAT) | Ein zweites NAT beim Netzbetreiber. Viele Kunden teilen sich eine öffentliche IPv4. Typisch im Mobilfunk und bei **DS-Lite** (Kabel/Glasfaser: echtes IPv6, IPv4 nur über das CGNAT des Anbieters). |
| **Mapping-Verhalten** | „Endpunkt-unabhängig“ (EIM): Ein Socket bekommt nach außen immer dieselbe Adresse:Port, egal wohin er sendet. „Symmetrisch“: Für jede Gegenstelle eine andere Adresse:Port. Symmetrisch ist der schwierige Fall. |
| **IPv6** | Neues Adressformat. Jedes Gerät hat eine weltweit eindeutige Adresse, **kein NAT**. Router haben meist trotzdem eine Firewall, die Unaufgefordertes abweist. |
| **ICE** | Das Verfahren in WebRTC, das alle möglichen Wege zwischen zwei Geräten sammelt („Kandidaten“) und paarweise ausprobiert. |
| **Kandidat `host`** | Eine Adresse, die das Gerät selbst hat (private IPv4, öffentliche IPv6). |
| **Kandidat `srflx`** (server-reflexiv) | Die öffentliche Adresse:Port, unter der das Internet das Gerät sieht. Ermittelt per **STUN** – oder in Malachi zusätzlich per Router-Portfreigabe. |
| **Kandidat `prflx`** (peer-reflexiv) | Eine Adresse, die ICE erst während der Prüfung lernt: Ein Prüfpaket der Gegenseite kommt von einer bisher unbekannten Adresse an. Dafür braucht es **keinen Server**. |
| **STUN** | Ein Dienst, der nur antwortet: „Ich sehe dich unter Adresse X, Port Y.“ Er leitet keine Daten weiter. |
| **TURN** | Ein Server, der alle Daten weiterleitet, wenn direkt nichts geht. In Malachi bewusst verboten. |
| **Hole-Punching** | Beide Seiten senden gleichzeitig aneinander. Dadurch öffnet jeder Router „ein Loch“ für die Gegenseite, und die Pakete kommen durch. |
| **PCP, NAT-PMP, UPnP-IGD** | Protokolle, mit denen eine App den eigenen Router bittet, einen Port freizugeben. Der Router nennt dabei auch seine öffentliche IPv4-Adresse. In der FritzBox heißt das „Selbstständige Portfreigaben erlauben“ (pro Gerät). |
| **Pinhole** | Ein freigegebenes „Loch“ in der IPv6-Firewall des Routers. |
| **SDP, Angebot/Antwort** | Die Beschreibung einer WebRTC-Verbindung inklusive aller Kandidaten. Malachi tauscht sie verschlüsselt über Tor aus. |
| **Trickle-ICE** | Kandidaten werden einzeln nachgereicht statt alle auf einmal. Malachi nutzt es bei Anrufen, nicht beim Chat-Upgrade. |
| **Onion-Dienst** | Ein über Tor erreichbarer Dienst. Jedes Malachi-Gerät betreibt einen; so finden sich Kontakte ohne Server. |
| **Jitter** | Schwankung der Laufzeit von Paketen. Für Sprache ist sie oft schlimmer als eine gleichmäßige Verzögerung. |
| **Opus** | Sprach-Codec. Der Malachi-Tor-Rückfall nutzt Opus mit 16 kHz und etwa 16 kbit/s. |

---

## 1. Kurzfazit

1. **Machbar: ja.** Der Weg ohne STUN ist schon eingebaut: Das ist Stufe 2 „Privat (ohne STUN)“.
   Der Ausstieg heißt also: Stufe 2 wird Standard, die Lücken darin werden geschlossen, es wird
   gemessen, und danach fliegt der STUN-Code ganz heraus.
2. **Korrektur zum Ist-Zustand:** Die App nutzt **keinen eigenen coturn mehr**, seit Commit
   `d26d32e` vom 19.10.2026. Schon Version 1.0.0 (`170cc54`) fragt in Stufe 1 je Verbindung
   **zwei von vier öffentlichen deutschen STUN-Diensten**: Nextcloud, sipgate, 1&1 und Telekom.
   `STUN_HOST` und `STUN_URL` gibt es in `AppConfig.js` nicht mehr; ein Test prüft das sogar.
   Den coturn auf dem Server nutzt keine veröffentlichte Version.
3. **Der Preis:** STUN hilft nur in einem Fall: Beide Geräte sprechen nur über IPv4 miteinander,
   beide sitzen hinter NAT, keiner hat eine Router-Portfreigabe, und sie sind nicht im selben WLAN.
   Bei IPv6 auf beiden Seiten braucht es nie STUN. Geschätzt kommen ohne STUN **etwa 9 bis 23
   Prozentpunkte weniger Direktverbindungen** zustande, je nach IPv6-Lage, realistisch etwa 15
   **[Annahme – messen]**. Diese Kontakte bleiben auf Tor:
   - Nachrichten und Medien kommen etwas langsamer an.
   - 1:1-Anrufe laufen nur als Sprache über Tor, mit etwa 0,3 bis 0,6 s Verzögerung und ohne Video.
   - Paare in Gruppenanrufen zeigen „nicht erreichbar“, weil es dort heute keinen Tor-Rückfall gibt.
4. **Der Gewinn:**
   - Kein Dritter sieht mehr IP-Adresse, Uhrzeit und Dauer jeder Direktverbindung. Heute sind das
     Nextcloud, sipgate, 1&1 und Telekom; über WLAN sehen sie die Dauer sogar laufend, weil
     libwebrtc ihnen Lebenszeichen schickt.
   - Kein typisches „Malachi-Muster“ aus zwei bestimmten STUN-Abfragen im Netz und im DNS.
   - Keine Abhängigkeit von fremden Diensten.
   - Die Datenschutzerklärung wird einfacher.
5. **Empfohlene Variante:** IPv6 + Host-Kandidaten + Router-Portfreigabe, Austausch über Tor, sonst
   Tor (Ersatzweg a). Umsetzung in **zwei Releases**:
   - **Release N:** Standard ohne STUN, STUN nur noch als verstecktes Übergangs-Opt-in. Dazu drei
     Lücken schließen: Portfreigabe auch für Anrufe und ICE-Neustarts, spät eintreffende
     Freigaben nachreichen, ehrliche Texte.
   - **Release N+1:** STUN-Code vollständig entfernen.
   - **Optional, nach der Messung:** Weiterleitung über den Gastgeber in Gruppenanrufen und das
     Experiment „öffentliche IPv4 vom Tor-Wächter + Portbeibehaltung“.
6. **Nicht empfohlen:**
   - Port-Vorhersage im Birthday-Verfahren: großer Aufwand, sieht nach Portscan aus, geht nicht
     mit WebRTC.
   - Peer-STUN über Gruppenmitglieder.
   - Eigener Server: ausgeschlossen, nur als Vergleich genannt.
7. **Aufwand:** Der Kern braucht etwa **2 bis 3 Wochen Entwicklung** und **2 bis 4 Wochen
   Messphase** mit Testern. Die Gruppenanruf-Weiterleitung kostet bei Bedarf 1 bis 2 Wochen mehr.
8. **Rest-STUN außerhalb von Malachi:** Kommt Tor ohne Bridge nicht durch, nutzt die Tor-Bridge
   **Snowflake** eigene STUN-Server (`TorBridges.js`). Wie damit umgegangen wird, muss
   entschieden werden (E7).

---

## 2. Ist-Zustand

### 2.1 Wer fragt welchen STUN-Server?

| Stufe (`ConnectionMode.js`) | ICE-Server | Wer sieht die IP? (heute) |
|---|---|---|
| 1 „Schnell (mit STUN)“ – **Standard** | 2 von 4 aus `AppConfig.STUN_POOL`, reihum (`iceServersForMode`, `ConnectionMode.js:97`). Nur `stun:`, nie TURN. | 2 STUN-Betreiber, der Kontakt, der Tor-Eintrittsknoten |
| 2 „Privat (ohne STUN)“ | `[]` (keine) | der Kontakt, der Tor-Eintrittsknoten |
| 3 „Maximal anonym (nur Tor)“ (Pro) | gar keine PeerConnection (`pcConfigForMode` wirft `TorOnlyModeError`, `WebRTCManager.js:365`) | nur der Tor-Eintrittsknoten (er weiß nicht, mit wem man spricht) |

`STUN_POOL` (`AppConfig.js:25–30`):

- `stun:stun.nextcloud.com:443` (Nextcloud GmbH)
- `stun:stun.sipgate.net:3478` (sipgate)
- `stun:stun.1und1.de:3478` (1&1)
- `stun:stun.t-online.de:3478` (Telekom)

`STUN_PER_CONNECTION = 2`.

**Verlauf:**

- **Bis 19.10.2026:** Eigener coturn als STUN (`STUN_URL = stun:malachii.duckdns.org:3478`,
  `server/hetzner/turnserver.conf`, `stun-only`).
- **19.10.2026, `d26d32e`:** Öffentlicher Pool aus Cloudflare, Google, Nextcloud und sipgate.
- **19.10.2026, `d67d17e`:** Nur noch deutsche Betreiber.
- **v1.0.0 (`170cc54`, 20.10.2026):** Enthält den deutschen Pool.

Damit nutzt **keine veröffentlichte Version den eigenen coturn**.

**Welche Verbindungen fragen STUN (nur in Stufe 1)?** Jede neue `RTCPeerConnection`:

- **Chat-Direktverbindung:** `DirectUpgrade.startOffer` und `onOffer` erzeugen sie über
  `WebRTCManager.createOffer()` bzw. `createAnswerDirect()`.
- **ICE-Neustart nach Netzwechsel:** Die bestehende PC sammelt neu.
- **1:1-Anruf:** `CallManager._createPeerConnection`, `CallManager.js:346`, eine eigene PC je Anruf.
- **Gruppenanruf:** `GroupCallManager.createPc`, `GroupCallManager.js:967`, je Teilnehmerpaar eine PC.

**Nebenbefunde:**

- **Web-App:** `web/src/lib/AppConfig.ts` zeigt noch `STUN_URL = stun:${RELAY_HOST}:3478`. Die
  Web-App ist offline. Wenn sie zurückkommt, muss sie derselben Regel folgen.
- **Snowflake:** `TorBridges.js:17–18` hat je 8 STUN-Server, darunter `stun.epygi.com`,
  `stun.telnyx.com` und `stun.fitauto.ru`. Die Tor-Automatik (`TorTransport.js`, `AUTO_SEQUENCE`)
  probiert zuerst ohne Bridge (60 s), dann **Snowflake**, dann obfs4, dann meek. In Netzen, die
  Tor sperren, fragt also Snowflake STUN-Server, und Snowflake-Freiwillige sehen die IP. Das ist
  das Verhalten des Tor-Projekts, nicht Malachis eigenes ICE.

### 2.2 Was STUN in Malachi leistet

So läuft der Verbindungsaufbau (`BackgroundSync.js`, `TorTransport.js`, `DirectUpgrade.js`):

```
1. Tor-Verbindung zum Onion-Dienst des Kontakts, gegenseitige Anmeldung, Kyber-Schlüssel
2. DirectUpgrade: das Gerät mit der kleineren Onion-Adresse bietet an
      createOffer(): Kandidaten sammeln
         host:  private IPv4 (192.168.x), globale IPv6, TCP-passiv
         srflx: öffentliche IPv4:Port per STUN            <- nur Stufe 1
         srflx: per PCP/NAT-PMP/UPnP freigegebene IPv4     <- _withPortMappings
      Angebot (SDP mit allen Kandidaten) verschlüsselt ÜBER TOR an den Kontakt
3. Kontakt: createAnswerDirect() -> beginnt sofort mit ICE-Prüfungen, Antwort über Tor zurück
4. ICE prüft alle Paare (beide Seiten senden gleichzeitig = Hole-Punching)
      prflx-Kandidaten entstehen von selbst, wenn Prüfpakete ankommen
5. Kanal offen -> eigener Kyber-Tausch -> Direktverbindung aktiv, Tor bleibt Reserve
   Scheitert es (Zeitlimit 35 s): weiter über Tor, neuer Versuch nach 15 s ... 5 min
```

**Wofür STUN tatsächlich gebraucht wird:**

- **IPv6:** Nie. Die Host-Adresse ist schon öffentlich. Beide Seiten senden sich gegenseitig
  Prüfpakete, dadurch öffnen sich die Firewalls (Hole-Punching ohne NAT). Ein
  PCP-Pinhole hilft zusätzlich, ist aber nicht zwingend.
- **Gleiches WLAN:** Nie, die privaten Host-Adressen reichen.
- **IPv4, eine Seite erreichbar** (Portfreigabe oder echte öffentliche IPv4 am Gerät): Nicht
  nötig. Die erreichbare Seite empfängt die Prüfung der anderen und lernt deren Adresse als
  `prflx`. Ihre „getriggerte“ Gegenprüfung geht durch das NAT der anderen Seite, weil dort gerade
  ein Paket hinausging. Das klappt **sogar bei symmetrischem NAT** auf der anderen Seite.
- **IPv4, beide hinter NAT ohne Freigabe:** **Hier und nur hier hilft STUN.** Jede Seite kennt
  dann ihre öffentliche Adresse:Port und kann gezielt dorthin senden. Bei symmetrischem NAT nützt
  auch STUN nichts, weil die Adresse für jede Gegenstelle anders ist.

**Anrufe:**

- **1:1:** Eine eigene PC wird **nur dann versucht, wenn der Chat schon direkt läuft.** Läuft der
  Chat über Tor, geht der Anruf sofort auf „Sprache über den Kanal“:
  - `CHANNEL_AUDIO_AFTER_MS_VIA_TOR = 0`, `CallManager.js:58–59`
  - `acceptCall`: `_viaTor()` → `_acceptViaChannel`, `CallManager.js:755`

  STUN hilft Anrufen also fast nur indirekt, über eine geglückte Chat-Direktverbindung.
- **Gruppen:** Jedes Paar baut eine eigene PC auf, in Stufe 1 mit STUN. Kommt sie nicht zustande,
  heißt das „nicht erreichbar“. Es gibt **keinen Tor-Rückfall** (`GroupCallManager.js:30–34`,
  `GROUP_CALL_DESIGN.md` Abschnitt „Kein direkter Weg (NAT)“).

### 2.3 Welche Metadaten der STUN-Betreiber heute bekommt

Er bekommt keine Inhalte, keine Kontakte und keine Signale. Er bekommt aber:

- **IP-Adresse und Quellport** des Geräts (IPv4, bei IPv6-fähigen Diensten auch IPv6).
- **Zeitpunkt jedes Verbindungsaufbaus.** Das ist jeder Direkt-Versuch. Klappt direkt nie, kommt
  wegen der Wartezeit-Logik (15 s bis 5 min) **pro Kontakt mindestens alle 5 min eine Abfrage**,
  also ein „Malachi läuft“-Herzschlag. Dazu kommen jeder ICE-Neustart, jeder Anruf und jedes
  Gruppenpaar.
- **Dauer der Verbindung:** libwebrtc hält srflx-Bindungen mit **STUN-Lebenszeichen** frisch.
  - In „günstigen“ Netzen (WLAN) ist die Lebensdauer **unbegrenzt**, im Mobilfunk 2 Minuten
    (`stun_port.h`: `HIGH_COST_PORT_KEEPALIVE_LIFETIME = 2 min`, sonst `INFINITE_LIFETIME`).
  - Über WLAN sieht der Betreiber also, wie lange eine Direktverbindung besteht. Abstand der
    Lebenszeichen nach libwebrtc-Standard etwa 10 s **[Annahme – im Mitschnitt prüfen]**.
- **Wer mit wem:** Fragen zwei Geräte im selben Moment, lassen sich Kontaktpaare zeitlich
  zuordnen (Audit 2026-10-19, Punkt T7). Jeder Betreiber sieht etwa die Hälfte aller
  Verbindungen, weil je Verbindung 2 von 4 gefragt werden.
- **Fingerabdruck:** Die feste Kombination zweier bestimmter STUN-Dienste in derselben
  Millisekunde, unverschlüsselt (STUN ist Klartext), ist ein Erkennungsmuster für Malachi. Das
  sehen auch Netzbetreiber und DNS-Resolver über die Abfragen nach `stun.*`.

### 2.4 Was passiert heute in Stufe 2 (ohne STUN)?

- `iceServers: []`, `iceTransportPolicy: 'all'`, TCP-Kandidaten an (`pcConfigForMode`).
- **Kandidaten:**
  - IPv6-Host (öffentlich)
  - private IPv4-Host
  - freigegebene IPv4 als `srflx`, wenn der Router zustimmt (`_withPortMappings`,
    `WebRTCManager.js:459`; nativ `MalachiPcpModule.kt`: PCP, dann NAT-PMP, dann UPnP; NAT-PMP
    und UPnP nur im WLAN, `MalachiPcpModule.kt:262`)
  - `prflx` von selbst
- Malachi wartet bis zu **4 s** auf den Router (`PORT_MAPPING_MAX_WAIT_MS[MODE_PRIVATE]`,
  `WebRTCManager.js:48`; Stufe 1: 1,5 s). Was der Router kann, wird 10 min gemerkt.
- Wechsel von Stufe 1 auf 2: Bestehende Direktverbindungen machen einen ICE-Neustart ohne STUN,
  damit die Lebenszeichen an STUN aufhören (`DirectUpgrade.applyConnectionMode`, Zeile 563).
- Die Einstellungen zeigen den Status der Portfreigabe und einen Hinweis „kein funktionierendes
  IPv6“ (`App.tsx:5905–5935`, `MalachiPcp.ipv6Status`).

**Lücken, die beim Lesen aufgefallen sind (wichtig für den Ausstieg):**

| # | Lücke | Stelle | Folge ohne STUN |
|---|---|---|---|
| L1 | Anruf-PCs (1:1 und Gruppe) fragen **den Router nie um eine Portfreigabe** | `CallManager._createPeerConnection`, `GroupCallManager.createPc` (kein `_withPortMappings`) | Läuft der Chat direkt nur dank IPv4-Freigabe, scheitert die Anruf-PC. Nach 5 s geht es auf Kanal-Audio über die Chat-Verbindung, ohne Video. Gruppenpaare: „nicht erreichbar“. |
| L2 | **ICE-Neustart** nach Netzwechsel ohne Portfreigabe | `createIceRestartOffer` / `acceptIceRestartOffer` (`WebRTCManager.js:947`) liefern `_plainLocalDescription()` | Ein Pfad, der von der Freigabe abhing, überlebt den Netzwechsel nicht. Dann Tor, danach neuer Upgrade-Versuch. |
| L3 | Spät eintreffende Freigabe wird erneuert, aber **nie an die Gegenseite gemeldet** | `_withPortMappings`, Zweig `pending.then(... 'spaet')` | Antwortet der Router langsamer als die Wartezeit, ist der Versuch ohne IPv4-Weg. Deshalb die langen 4 s. |
| L4 | Ortsname per Nominatim nur in Stufe 1 | `App.tsx:3836–3837` (`if (mode !== MODE_FAST) return null`) | Wird Stufe 2 Standard, sind Ortsnamen still für alle aus. Das widerspricht der Entscheidung „Nominatim bleibt“. |
| L5 | Text „… dein Kontakt, **solange ihr direkt verbunden seid**“ ist ungenau | `locales/*.js` (`connMode.fast.who`, `connMode.private.who`), Website | Der Kontakt bekommt die Kandidaten (IP-Adressen) **schon mit jedem Angebot**, auch wenn die Direktverbindung dann scheitert. Anrufe schicken sie ebenfalls (Trickle). |
| L6 | „Kein Server erfährt deine IP“ (Stufe 2) bzw. „sieht niemand“ (Stufe 3) | `connMode.private.desc`, `connMode.torOnly.who` | Der Tor-Eintrittsknoten (oder die Bridge) sieht die IP immer, aber nicht, mit wem man spricht. Präziser formulieren. |
| L7 | Veraltete Kommentare und Testdaten | `WebRTCManager.js:327–330, 352` („eigener STUN-Server“, „coturn stun-only“), `server/hetzner/turnserver.conf` („STUN_URL“), `mockConfig` mit `STUN_HOST/STUN_URL` in 10 Testdateien | Verwirrt Leser und Auditoren. Beim Aufräumen mit erledigen. |

---

## 3. Netztypen-Matrix

### 3.1 Grundregel ohne STUN

Eine Direktverbindung entsteht ohne STUN, wenn **eine** dieser Bedingungen gilt:

1. **Beide** haben funktionierendes IPv6 (Adresse **und** Standardroute).
2. Beide sind im **selben lokalen Netz** (ohne Client-Isolation).
3. Es geht über IPv4, und **mindestens eine Seite ist erreichbar**: Der Router hat einen Port
   freigegeben (PCP, NAT-PMP oder UPnP), oder das Gerät hat selbst eine öffentliche IPv4.

In allen anderen Fällen bleibt es bei Tor.

### 3.2 Belastbare Zahlen aus Quellen

| Thema | Zahl | Quelle |
|---|---|---|
| IPv6-fähige Nutzer in Deutschland | **73,5 %** fähig, 70,8 % bevorzugt (22.10.2026) | APNIC Labs, Länderdaten DE |
| Mobilfunk IPv6 | Telekom Dual-Stack seit 2015; O2 für alle Kunden seit Mitte 2021 (je nach Gerät manuell); Vodafone: laut Nutzerforen vorhanden, aber teils fehlerhaft und nicht als reines IPv6 nutzbar | mobiflip, WinFuture, Vodafone-Forum |
| CGNAT im Mobilfunk | **> 90 %** der Mobilfunk-Netze (AS) nutzen CGNAT. Bei Festnetz-Anbietern 17–18 % | Richter u. a., IMC 2016 |
| Symmetrisches CGNAT | Mobilfunk: **~40 %** symmetrisch, ~20 % „full cone“. Festnetz-CGNAT: 11 %. Heimrouter: < 2 % symmetrisch | Richter u. a. 2016 |
| Portbeibehaltung bei CGNAT | Festnetz 41 %, Mobilfunk 28 %; zufällige Ports 36 % bzw. 45 % | Richter u. a. 2016 |
| UDP-Zustand im NAT | 74 % verfallen nach ≤ 60 s Ruhe; Median 65 s (Mobilfunk-CGNAT), 35 s (Festnetz-CGNAT) | Richter u. a. 2016 |
| UDP-Hole-Punching (mit Adressermittlung) | ~**82 %** der getesteten NATs (2005); **70 % ± 7 %** in 4,4 Mio. Versuchen, 167 Länder (2025) | Ford/Srisuresh/Kegel 2005; Trautwein u. a. 2025 |
| WebRTC ohne Relay | Je nach Quelle brauchen ~10–25 % der Verbindungen TURN, also 75–90 % gelingen mit STUN direkt. Herstellerangaben, nicht begutachtet | 100ms, NoJitter/callstats |
| Router-Portfreigabe FritzBox | Pro Gerät: „Selbstständige Portfreigaben erlauben“ (UPnP/PCP). Ob ab Werk an, nennt AVM nicht; im Projekt wurde NOT_AUTHORIZED beobachtet | AVM-Wissensdatenbank; `direct.notAuthorized` |

### 3.3 Netztypen eines Geräts (Deutschland, typisch)

| Kürzel | Netz | Beispiele | IPv6 | IPv4 |
|---|---|---|---|---|
| N1 | Heim-WLAN, IPv6 funktioniert | FritzBox an Telekom-DSL/Glasfaser, DS-Lite (Kabel/Glasfaser) | ja | öffentlich (Telekom) oder CGNAT (DS-Lite) |
| N2 | Heim-WLAN, öffentliche IPv4, **Portfreigabe erlaubt** | Router mit UPnP/NAT-PMP an, FritzBox mit Häkchen | egal | erreichbar |
| N3 | Heim-WLAN, öffentliche IPv4, Portfreigabe aus, **kein IPv6** | ältere Router, IPv6 abgeschaltet | nein | Heim-NAT (meist endpunkt-unabhängig) |
| N4 | Heim-WLAN mit DS-Lite, aber **IPv6-Route verloren** | bekannter FritzBox-Fehler nach Präfixwechsel (siehe Gedächtnis `phone_ipv6_default_route`) | kaputt | nur CGNAT |
| N5 | Mobilfunk mit IPv6 | Telekom, O2, Vodafone (wo aktiv) | ja | CGNAT |
| N6 | Mobilfunk ohne IPv6 | APN nur „IPv4“, manche Discounter/Reseller | nein | CGNAT (~40 % symmetrisch) |
| N7 | Fremd-WLAN | Hotel, Café, Zug, Firma: oft nur IPv4, Client-Isolation, teils UDP gesperrt | oft nein | NAT, teils restriktiv |
| N8 | Beide im selben WLAN | zuhause, Büro | – | – |

### 3.4 Paar-Matrix: Chance auf Direktverbindung mit und ohne STUN

Alle Prozentwerte sind Schätzungen aus den Quellen oben, **[Annahme – messen]**.

| Paar | Mit STUN | Ohne STUN | Begründung |
|---|---|---|---|
| **P1** beide IPv6 (N1/N5 × N1/N5) | ~95 % | **~95 % (gleich)** | IPv6 braucht kein STUN. Beide senden, die Firewalls öffnen. |
| **P2** gleiches WLAN (N8) | ~98 % | **~98 % (gleich)** | Private Host-Adressen. Ausnahme: Gäste-WLAN mit Client-Isolation. |
| **P3a** eine Seite IPv4-erreichbar (N2) × beliebig mit IPv4 | ~90 % | **~85–90 %** | Freigegebene Adresse + `prflx`. Klappt auch bei symmetrischem NAT der anderen Seite. |
| **P3b** IPv4 auf beiden Seiten, Heim-NAT (N3 × N3/N1 ohne IPv6 bei der Gegenseite) | ~75–85 % | **~0 % → Tor** | Klassisches STUN-Hole-Punching. Ohne STUN kennt niemand das Ziel. |
| **P3c** CGNAT beteiligt (N4/N6 × N3/N4/N6) | ~40–65 % | **~0 % → Tor** | CGNAT ist oft symmetrisch. Selbst mit STUN klappt es nur teilweise. |
| **P4** Fremd-WLAN restriktiv (N7, UDP gesperrt/Proxy) | ~0–20 % | ~0–10 % | Ohne TURN ohnehin meist Tor. TCP-Kandidaten helfen nur mit Freigabe. |
| Mobilfunk mit IPv6 ↔ Heim mit IPv6 (häufigster Fall) | ~95 % | **~95 %** | wie P1 |
| Mobilfunk ohne IPv6 ↔ Heim ohne IPv6/Freigabe | ~40–60 % | **~0 % → Tor** | wie P3c |

### 3.5 Grobe Gesamtschätzung

Rechenweg: Sei *p* der Anteil der Situationen, in denen ein Handy funktionierendes IPv6 hat.
Dann haben etwa *p²* der Paare beidseitig IPv6 (vereinfacht unabhängig).

Für die übrigen Paare werden folgende Erfolgsquoten angenommen:

- **mit STUN:** etwa 60 %
- **ohne STUN:** etwa 15 %, über Freigaben und gleiches WLAN

Beidseitige IPv6-Paare gelingen in beiden Fällen zu etwa 95 %.

| Szenario | *p* | beide IPv6 | direkt **mit** STUN | direkt **ohne** STUN | Verlust |
|---|---|---|---|---|---|
| pessimistisch | 0,70 | 49 % | ~77 % | ~54 % | **~23 Prozentpunkte** |
| realistisch | 0,80 | 64 % | ~82 % | ~66 % | **~16 Prozentpunkte** |
| optimistisch | 0,90 | 81 % | ~88 % | ~80 % | **~9 Prozentpunkte** |

- **Zur Plausibilität:** Die „mit STUN“-Werte (77–88 %) passen zu den Herstellerangaben (75–90 %
  ohne Relay).
- **Warum *p* bei Android-Handys in DE eher über den 73,5 % von APNIC liegt:** Telekom und O2
  liefern im Mobilfunk Dual-Stack, und FritzBoxen haben IPv6 meist an.
- **Was *p* senkt:** der FritzBox-Routen-Fehler, Fremd-WLANs und Vodafone-Mobilfunk.
  **[Annahme – messen]**, das ist die wichtigste Messgröße von WP0.

**Wo der Verlust anfällt:** fast nur bei Paaren mit einer Seite **ohne funktionierendes IPv6**.

- Fremd-WLAN
- Mobilfunk ohne IPv6
- FritzBox-Routen-Fehler
- alte Router

**Die größten Hebel dagegen** (alle ohne Dritte):

- Router-Portfreigabe erlauben (Hinweis gibt es schon)
- den IPv6-Routen-Fehler erkennen und erklären
- Lücken L1–L3 schließen

### 3.6 Aufbauzeit

- **Ohne STUN ist das Sammeln schneller:** Nur Host-Kandidaten, `iceGatheringState` ist sofort
  „complete“, das 1,5-s-Fenster in `_waitForICE` (`WebRTCManager.js:1622`) entfällt praktisch.
- **Langsamer wird es durch die Router-Wartezeit von bis zu 4 s,** wenn der Router zum ersten Mal
  im Netz gefragt wird. Nach Lücke L3 (nachreichen) kann sie auf etwa 1,5 s sinken.
- **Erwartung:** Tor-bereit → direkt im Median gleich oder schneller als heute, im p90 eventuell
  1–2 s langsamer **[Annahme – messen]**.

---

## 4. Ersatzwege mit Bewertung

### a) IPv6 + Host-Kandidaten + Router-Portfreigabe, Austausch über Tor (= heutige Stufe 2)

- **Machbarkeit:** vorhanden. Es fehlen nur die Lücken L1–L3.
- **Aufwand:** M für die Lücken und die Umstellung (siehe WP1/WP2).
- **Datenschutz:** bestmöglich für eine Direktverbindung. Die IP sieht nur der Kontakt; der eigene
  Router vergibt die Freigabe lokal. Ohne STUN steht im Angebot **keine öffentliche IPv4 mehr**,
  außer bei einer Freigabe. Der Kontakt lernt also weniger.
- **Erfolgsquote:** siehe 3.5; Verlust gegenüber STUN etwa 9–23 Prozentpunkte.
- **Urteil:** **Empfohlen als Grundlage.**

### b) „Peer-STUN“: ein Kontakt meldet die beobachtete Adresse

Varianten:

- **b1 – Gegenstelle B meldet A dessen Adresse aus der bestehenden Verbindung.** Nutzlos für A↔B.
  Steht die Verbindung, braucht es kein STUN mehr. Steht sie über IPv6, sieht B nur A's IPv6.
- **b2 – Ein dritter Kontakt C als STUN-Reflektor.** C hat eine erreichbare IPv4 (Freigabe) und
  beantwortet auf einem Port STUN-Binding-Anfragen. A trägt `stun:<C-IP>:<Port>` als ICE-Server
  ein, nur für die Verbindung zu B. So bekommt A eine **echte** srflx-Adresse für genau den
  richtigen Socket.
  - **Machbarkeit:** möglich. Nativer STUN-Antworter in Kotlin (~150 Zeilen) + Freigabe +
    Absprache über Tor („öffne den Reflektor für 30 s“).
  - **Aufwand:** M–L.
  - **Erfolgsquote:** hilft nur in P3b/P3c, nur wenn gerade ein geeigneter Kontakt online ist, und
    bei symmetrischem CGNAT gar nicht. Geschätzt +2–5 Prozentpunkte **[Annahme – messen]**.
- **Privatsphäre und Vertrauen:**
  - C erfährt A's öffentliche IPv4 und **wann A Verbindungen aufbaut** (nicht mit wem). Das ist
    ein neuer Aktivitäts-Metadatenstrom an einen Kontakt.
  - Ein bösartiger C kann eine falsche Adresse melden. Folge: nur ein gescheiterter Versuch, oder
    winzige ICE-Prüfpakete an eine fremde Adresse. Unkritisch, weil libwebrtc das begrenzt.
  - libwebrtc kann STUN-Server **nicht authentisieren**. C's Port antwortet also jedem im
    Internet; das ist ein kleiner öffentlicher Reflektor.
  - **Gruppen:** Mitglieder sind nicht automatisch Kontakte. Ein Gruppenmitglied als Reflektor
    würde **IP und Online-Zeiten an Nicht-Kontakte** geben. Ein bösartiges Mitglied könnte so
    Anwesenheitsprofile aller Mitglieder sammeln. **Ausschließen.**
- **Urteil:** **Nicht für den Start.** Höchstens später als Opt-in-Experiment (beide Seiten
  zustimmen), nur mit eigenen, schon direkt verbundenen Kontakten, und nur wenn die Messung
  großen IPv4-Verlust zeigt.

### c) Hole-Punching mit Port-Vorhersage bei symmetrischem NAT (Birthday-Ansatz)

- **Prinzip** (Tailscale): Die „harte“ Seite öffnet ~256 Sockets, die „leichte“ probiert
  zufällige Ziel-Ports. Nach ~1024 Proben besteht ~98 % Trefferchance. Das setzt voraus, dass die
  öffentliche IP **beider** Seiten bekannt ist (ohne STUN fraglich) und **mindestens eine** Seite
  vorhersagbar ist. Bei zwei harten NATs scheitert auch das.
- **Machbarkeit mit WebRTC:** **nein.** libwebrtc öffnet pro Verbindung nur wenige Sockets und
  kann keine Port-Sprays. Nötig wäre ein eigener UDP-Transport mit eigener Verschlüsselung neben
  WebRTC. **Aufwand: XL.**
- **Netzbetreiber-Risiko:**
  - Hunderte Pakete an zufällige Ports einer CGNAT-Adresse sehen aus wie ein **Portscan**.
    Missbrauchserkennung und vorübergehende Sperren sind möglich.
  - Bei CGNAT mit Port-Blöcken (oft 512–1024 Ports je Kunde) können 256 offene Sockets das
    **Port-Kontingent erschöpfen** und andere Apps stören.
  - **Rechtlich** ist kein spezielles Verbot bekannt; das Ziel ist ein einwilligender Kontakt.
    Viele Nutzungsbedingungen von Anbietern untersagen aber Portscans. (Keine Rechtsberatung.)
- **Urteil:** **Nicht empfohlen.**

### c-light / d) Öffentliche IPv4 ohne Dritten ermitteln + „Portbeibehaltung“ raten

- **Idee:** Viele NATs behalten den lokalen Port bei: Heimrouter häufig, Festnetz-CGNAT zu 41 %,
  Mobilfunk-CGNAT zu 28 %. Kennt ein Gerät seine öffentliche IPv4, kann es zusätzlich einen
  **geratenen** Kandidaten `öffentliche-IP:lokaler-Port` (Typ srflx, niedrige Priorität) ins
  Angebot setzen. Tun das **beide** Seiten, gelingt Hole-Punching zwischen zwei
  endpunkt-unabhängigen, portbewahrenden NATs ganz ohne STUN.
- **Woher die IPv4, ohne Dritte?**
  1. **Router:** NAT-PMP-„external address“ oder UPnP `GetExternalIPAddress`. Das Modul fragt das
     schon (`NatPmp.externalAddress`, `UpnpIgd.discover`). Bei der FritzBox gehen
     Statusinformationen per UPnP oft auch ohne Freigabe-Recht **[Annahme – prüfen]**. Bei CGNAT
     meldet der Router nur eine 100.64-Adresse, das ist dann nutzlos.
  2. **Tor-Wächter:** Laut Tor-Spezifikation trägt jede NETINFO-Zelle die beobachtete Adresse der
     Gegenseite („OTHERADDR“). Clients **dürfen** daraus ihre Adresse lernen, und tor nutzt das
     seit 2020 als Vorschlag. Malachi hat schon eine Control-Verbindung zu tor
     (`MalachiTorModule.kt`, jtorctl). Ob `GETINFO address` bei tor 0.4.8 **als reiner Client**
     etwas liefert, ist offen; vermutlich nur im Relay-Modus **[Annahme – prüfen]**. Mit Bridges
     (obfs4/Snowflake/meek) ist der Wert unzuverlässig.
- **Datenschutz:** kein neuer Beteiligter. Der Wächter kennt die IP sowieso, und der Kontakt
  bekäme sie mit STUN ebenfalls. Ein lügender Wächter verursacht nur einen Fehlversuch.
- **Aufwand:** M. Größtes Risiko: Die Quelle der IP liefert nichts.
- **Erfolgsquote:** könnte einen Teil von P3b retten, kaum P3c. Geschätzt +3–8 Prozentpunkte
  **[Annahme – messen]**.
- **Urteil:** **Interessantes Experiment nach der Messung (WP7)**, nicht Teil des Kerns.

### e) Mehr auf Tor setzen

- **Text, Bilder, Dateien:** laufen schon heute über Tor, wenn direkt nicht geht. Folge: höhere
  Latenz, bei großen Medien langsamer, mehr Akku (Tor-Lebenszeichen alle 5 s,
  `TOR_COVER_INTERVAL_MS`).
- **1:1-Anrufe:** Der Tor-Rückfall existiert schon (Abschnitt 5). Die Qualität ist der Preis.
- **Gruppenanrufe:** heute kein Tor-Rückfall.
- **Messdaten Tor-Laufzeit:** Tor-Metrics/OnionPerf misst die Hin-und-zurück-Zeit über einen
  **Onion-Dienst**. Für den deutschen Messpunkt `op-de8a` im Aug./Sep. 2026:
  - Median **240–350 ms**
  - oberes Quartil 320–490 ms
  - Ausreißergrenze 530–870 ms

  Daraus folgt eine Einweg-Laufzeit von etwa 120–175 ms im Median, bei Spitzen 300–450 ms. Für
  zwei Handys kommen Funknetz und Malachis Puffer dazu (Abschnitt 5.3).
- **Studie (PoPETs 2020)**, VoIP über Tor, allerdings über Exit-Kreise, nicht Onion-Dienste:
  - mehr als 0,5 Mio. Messungen
  - in **> 85 %** der Fälle gute Qualität (PESQ > 3, Einweg < 400 ms)
- **Rohdaten aus Malachi:** Im Code und in den Dokumenten gibt es **keine Messung** der
  Anrufqualität über Tor. Es gibt nur den Live-Test „5G gegen WLAN: Verbindung über Tor nach
  ~7 s“ (`MASTERPLAN_DAUERVERBINDUNG.md`, Phase 7). **[Annahme – messen]**
- **Urteil:** Tor ist der **richtige Rückfall** und schon da. Lohnend sind Verbesserungen am
  Tor-Audio (WP3b) und eventuell Gruppen-Rückfälle (WP4).

### f) Eigener, selbst gehosteter STUN-Server (nur Vergleich)

- **Technisch:** trivial; so war es bis 19.10.2026 (coturn `stun-only`).
- **Datenschutz:** Man selbst wird zum Dritten, der IP, Zeit und Dauer sieht. Hinzu kommen
  Auftragsverarbeitung, Herausgabe-Anfragen und Betrieb.
- **Ausgeschlossen** durch die Vorgaben „nichts über den Server“ und „Server leeren“. Damit ist
  auch die offene Frage aus `project_server_exit_plan` („STUN winzig auf Coachbay
  weiterbetreiben?“) mit **Nein** beantwortet.

### g) Zusätzlich: Weiterleitung über den Gastgeber im Gruppenanruf

- **Idee:** Erreichen sich zwei Mitglieder B und C nicht direkt, aber beide den Gastgeber A, leitet
  A die Sprache weiter. A ist ohnehin im Anruf und hört beide, lernt also **nichts Neues**.
- **Vertrauen:** Für ungekoppelte Paare bürgt A schon heute für die DTLS-Fingerabdrücke. Für
  gekoppelte Paare wäre es neu, denn A könnte Sprache verfälschen. Deshalb Kachel-Kennzeichen
  „über Gastgeber“.
- **Kosten:** Last beim Gastgeber (bis zu 7 Teilnehmer).
- **Aufwand:** L. Offen ist, ob react-native-webrtc empfangene Audiospuren an eine andere PC
  weitergeben kann **[Annahme – prüfen]**; sonst wäre ein nativer Mischer nötig.
- **Urteil:** Gute Option für WP4, wenn die Messung viele „nicht erreichbar“-Paare zeigt.

### h) Zusätzlich: Anruf-Sprache über die bestehende Direktverbindung

- **Heute:** Scheitert die Anruf-PC, obwohl der Chat direkt läuft (zum Beispiel wegen L1), geht
  Kanal-Audio über den **zuverlässigen, geordneten** Chat-DataChannel. Bei Paketverlust führt das
  zu Rucklern (Head-of-line-Blocking).
- **Besser:** Ein zweiter DataChannel `ordered:false, maxRetransmits:0` auf derselben
  PeerConnection. Er braucht keine Neuverhandlung und verhält sich bei Verlust wie RTP.
- **Achtung:** `pc.ondatachannel` in `createAnswerDirect` überschreibt heute `this.dataChannel`
  mit **jedem** eingehenden Kanal. Es muss nach Label unterschieden werden.
- **Aufwand:** M.
- **Urteil:** Teil von WP3a.

### Übersicht

| Weg | Machbar | Aufwand | Datenschutz | Erfolgsbeitrag | Empfehlung |
|---|---|---|---|---|---|
| a IPv6 + Host + Portfreigabe + Tor | ja (vorhanden) | M (Lücken) | sehr gut | Basis | **ja** |
| b2 Kontakt als STUN-Reflektor | ja | M–L | mäßig (Aktivität an Kontakt) | +2–5 Pp | später, Opt-in |
| b in Gruppen | ja | M–L | schlecht | gering | **nein** |
| c Birthday | nicht mit WebRTC | XL | neutral | gering | **nein** |
| c-light/d geratener srflx | wahrscheinlich | M | gut | +3–8 Pp | Experiment |
| e mehr Tor | ja (vorhanden) | M–L (Qualität) | sehr gut | fängt alles auf | **ja, verbessern** |
| f eigener Server | ja | S | schlecht | wie heute | **ausgeschlossen** |
| g Gastgeber-Weiterleitung | wahrscheinlich | L | gut | Gruppenpaare | nach Messung |
| h Audio-DataChannel | ja | M | gut | Anrufqualität | **ja** |

---

## 5. Anrufe

### 5.1 Ablauf heute (1:1)

1. Es steht keine Verbindung: Sie wird zuerst über Tor aufgebaut, „Verbinde über Tor …“, bis 45 s
   (`CALL_CONNECT_VIA_TOR_TIMEOUT_MS`).
2. **Chat läuft über Tor:** sofort „Sprache über den Kanal“. Der Anrufer schaltet mit Verzögerung
   0 um, der Angerufene nimmt per `_acceptViaChannel` an.
3. **Chat läuft direkt:** Es wird eine eigene WebRTC-PC mit Trickle-ICE aufgebaut. Ist nach
   **5 s** keine Medienverbindung da (oder ICE meldet „failed“), wird auf Kanal-Audio gewechselt;
   das läuft dann über den direkten DataChannel. Notbremse nach 20 s.
4. Wird der Chat während eines Kanal-Anrufs direkt, laufen die Sprachpakete automatisch über die
   Direktverbindung, denn `RTCStore.sendMessage` nutzt die aktive Verbindung.

### 5.2 Der vorhandene Tor-Rückfall

`MalachiCallAudioModule.kt`:

- Mikrofon im Sprachmodus mit Echo- und Rauschunterdrückung, dann **Opus 16 kHz, ~16 kbit/s,
  20-ms-Pakete**.
- In JS je **3 Pakete gebündelt** (60 ms) und verschlüsselt wie eine Nachricht (`call_audio`).
- **Wiedergabepuffer** höchstens 20 Pakete (~400 ms). Darüber wird das Älteste verworfen
  (`MAX_PLAY_QUEUE`, Zeile 54/244).
- **Kein Video**, Android 10+ nötig.

Weitere Beobachtungen:

- **Bandbreite:**
  - `call_audio` wird als Transportpaket auf 512 Byte gepolstert, bei Kontakten mit
    Ratchet-Sitzung auf **1024 Byte** (`sealForConnection`). Danach folgt die dreifache
    Verschlüsselung.
  - Gesamt grob **100–200 kbit/s je Richtung** statt 16 kbit/s **[Annahme – messen]**. Für Tor
    ist das tragbar (die PoPETs-Studie nennt < 120 kbit/s als typisch), aber verschwenderisch.
- **Ohne Paketverlust-Verdeckung (PLC/FEC) und ohne anpassbaren Puffer:** Hängt der TCP-Strom
  über Tor kurz, läuft der Puffer leer und danach über; das wird hörbar als Lücke und Sprung.

### 5.3 Erwartete Verzögerung (Mund zu Ohr)

| Anteil | Direkt (WebRTC) | Über Tor (Kanal-Audio) |
|---|---|---|
| Netzlaufzeit einweg | 10–60 ms (DE) | ~120–175 ms Median, Spitzen 300–450 ms (OnionPerf) |
| Funknetz (Mobilfunk) | 20–60 ms | 20–60 ms |
| Kodierung + Bündelung | 20–40 ms | 20 + bis 60 ms (3er-Bündel) |
| Puffer beim Empfänger | 40–80 ms (adaptiv) | 0–400 ms (fest begrenzt) |
| **Summe typisch** | **~80–200 ms** | **~300–500 ms, bei Spitzen mehr** **[Annahme – messen]** |

Einordnung nach ITU-T G.114:

- bis 150 ms einweg: unauffällig
- 150–400 ms: akzeptabel, man merkt es
- über 400 ms: Gespräche werden mühsam, man redet sich ins Wort

Sprache über Tor ist also **nutzbar, aber spürbar verzögert**.

### 5.4 Ohne STUN: was geht direkt, was fällt auf Tor zurück, was bricht

| Lage | 1:1 Sprache | 1:1 Video | Gruppe |
|---|---|---|---|
| beide IPv6 / gleiches WLAN | direkt (WebRTC), unverändert | ja | Paar direkt |
| Chat direkt nur über IPv4-Freigabe | **heute:** Anruf-PC scheitert (L1) → nach 5 s Kanal-Audio über den direkten DataChannel (gute Latenz). **Nach WP1:** direkt per WebRTC | **heute nein, nach WP1 ja** | **heute „nicht erreichbar“**, nach WP1 direkt |
| kein Direktweg (P3b/P3c) | **Tor-Kanal-Audio** (~0,3–0,6 s) | **nein** (Hinweis vorhanden) | **„nicht erreichbar“** (bricht für dieses Paar) |
| Stufe 3 (nur Tor) | Tor-Kanal-Audio (unverändert) | nein | keine Gruppenanrufe (unverändert) |

**Es bricht also nichts komplett.** 1:1-Anrufe haben immer einen Weg, solange Tor geht. Was
schlechter wird:

- (1) Verzögerung bei den Paaren aus 3.4 P3b/P3c
- (2) kein Video dort
- (3) Gruppenpaare ohne Direktweg

### 5.5 Gruppenanrufe genauer

- Vollvermaschung, eine PC je Paar, Opus mono 20 kbit/s, bis 8 Teilnehmer.
- Ohne STUN sind die Paare aus P3b/P3c „nicht erreichbar“; das Design hat bewusst keinen
  Tor-Rückfall (`GROUP_CALL_DESIGN.md:154–162`).
- **Folge:** In einer Gruppe mit einem Mitglied im Mobilfunk ohne IPv6 hört dieses Mitglied nur
  die, die eine IPv4-Freigabe haben oder mit ihm im selben Netz sind.
- **Gegenmittel** (WP4, nach Messung):
  - (g) Weiterleitung über den Gastgeber
  - oder Kanal-Audio je Paar mit nativem Mischer für bis zu 4 Teilnehmer

---

## 6. Datenschutz

### 6.1 Was wegfällt

- **STUN-Betreiber** (Nextcloud, sipgate, 1&1, Telekom) erfahren nichts mehr:
  - keine IP
  - keine Zeitpunkte von Verbindungsaufbau, Anrufen und Gruppenpaaren
  - keine Verbindungsdauer über Lebenszeichen
  - kein 5-Minuten-Herzschlag bei scheiternden Versuchen
- **Keine zeitliche Zuordnung von Kontaktpaaren** über STUN-Logs (Audit T7 entfällt).
- **Kein Erkennungsmuster** „zwei bestimmte STUN-Dienste gleichzeitig“ für Netzbetreiber und
  DNS-Resolver. Auch keine DNS-Abfragen nach `stun.*`.
- **Keine öffentliche IPv4 im Angebot an den Kontakt,** solange keine Portfreigabe besteht. Der
  Kontakt sieht dann nur IPv6 und private LAN-Adressen.
- **Rechtlich und organisatorisch** (keine Rechtsberatung): ein Empfänger weniger in
  Datenschutzerklärung, Play-„Datensicherheit“ und FAQ. Die Liste der Betreiber muss nicht
  mehr gepflegt werden.

### 6.2 Restrisiken, die bleiben und erklärt werden müssen

1. **Der Kontakt sieht die IP-Adressen, schon beim Versuch.** Jedes Angebot (Chat) und jede
   Anruf-Kandidatenmeldung enthält die Adressen, auch wenn die Direktverbindung danach scheitert.
   Bei Erfolg sieht er sie zusätzlich als Absender der Pakete. Das ist bei jeder
   Direktverbindung unvermeidbar. Heute steht in den Texten „solange ihr direkt verbunden seid“;
   das ist zu korrigieren (L5).
2. **IPv6 verrät den Anschluss.** Das /64-Präfix gehört zum Haushalt bzw. zur Mobilfunk-Sitzung
   und bleibt oft tage- bis wochenlang gleich. Android nutzt zwar wechselnde „Privacy-Adressen“,
   das Präfix bleibt aber.
3. **Private LAN-Adressen** (z. B. `192.168.178.x`) stehen im Angebot. Das ist ein geringes
   Risiko; es verrät grob den Router-Typ.
4. **Netzbetreiber auf beiden Seiten** sehen bei Direktverbindungen, welche IP mit welcher IP
   spricht. Über Tor sehen sie nur „nutzt Tor“.
5. **Der Tor-Eintrittsknoten** (bzw. die Bridge) sieht die IP immer, in **jeder** Stufe, aber
   nicht, mit wem man spricht. Die Texte „kein Server erfährt …“ und „sieht niemand“ sind zu
   präzisieren (L6).
6. **Snowflake:** Muss Tor über Snowflake laufen, sehen STUN-Server und Snowflake-Freiwillige die
   IP. Das ist Tor-Projekt-Technik, kein Malachi-STUN. Es muss ehrlich benannt werden (E7).
7. **Gruppen:** Der Gastgeber sieht schon heute das SDP (also die IPs) nicht gekoppelter Paare,
   weil er es weiterleitet. Das bleibt.
8. **Router-Portfreigabe:** Am eigenen Router ist ein Port offen. Dahinter nimmt nur WebRTC
   authentisierte STUN- und DTLS-Pakete an. Die Lebensdauer beträgt 1 h, beim Schließen wird die
   Freigabe gelöscht. Das ist vorhanden und unverändert.

### 6.3 Textvorschläge (Deutsch als Quelle, `locales/de.js`)

- **Stufe „Direkt, wenn möglich“ – `who`:** „Deine IP-Adresse sieht dein Kontakt – schon wenn
  eure Geräte versuchen, sich direkt zu verbinden. Kein STUN-Dienst und kein Malachi-Server ist
  beteiligt. Der Tor-Eintrittsknoten sieht sie wie bei jeder Tor-Nutzung, aber nicht, mit wem du
  sprichst.“
- **`cost`:** „Preis: In manchen Netzen (nur IPv4, Mobilfunk ohne IPv6, Hotel-WLAN) klappt direkt
  nicht – dann läuft alles über Tor: langsamer, Anrufe nur als Sprache mit Verzögerung, kein
  Video, im Gruppenanruf ist diese Person evtl. nicht erreichbar.“
- **Stufe 3 – `who`:** „Deine IP-Adresse sehen weder Kontakte noch ein Server – nur der
  Tor-Eintrittsknoten, der nicht weiß, mit wem du sprichst.“

---

## 7. Migration und Server

### 7.1 Mischbetrieb alte (mit STUN) und neue (ohne STUN) Versionen

- **Protokoll:** **vollständig kompatibel.** Die ICE-Konfiguration ist rein lokal. Ein Angebot
  ohne STUN-Kandidaten ist gültiges SDP, und alte wie neue Versionen verarbeiten es gleich.
- **Verbindungschance im Mischbetrieb:**
  - Die alte Seite hat einen srflx-Kandidaten, die neue nicht.
  - Die neue Seite sendet Prüfpakete an die srflx-Adresse der alten. Sie kommen nur durch, wenn
    das NAT der alten Seite **endpunkt-unabhängig filtert** („full cone“): bei Mobilfunk-CGNAT
    ~20 %, bei Heimroutern unterschiedlich **[Annahme – messen]**.
  - Sonst ist es wie ohne STUN auf beiden Seiten. Der Mischbetrieb liegt also **zwischen** den
    beiden Werten aus 3.5.
- **Neues Signal `direct_cand`** (WP1, spät nachgereichte Freigabe): Alte Versionen ignorieren
  unbekannte `subtype`s (`handleUpgradeSignal` → `default: return undefined`). Kein Bruch.
- **Gruppenanrufe:** keine Protokolländerung nötig. Trickle-Kandidaten aus Portfreigaben sind
  normale `ice`-Signale.

### 7.2 Was wird aus Stufe 1 und 2 in den Einstellungen?

**Empfehlung: zwei Stufen** (passt auch zur Vorgabe „Einstellungen ausklappbar, Kategorien mit
Kurzstatus“):

| Neu | Gespeicherter Wert | Inhalt |
|---|---|---|
| **„Direkt, wenn möglich“ (Standard)** | `2` (`MODE_PRIVATE`, im Code umbenennen in `MODE_DIRECT`) | Tor zuerst, dann direkt über IPv6, gleiches WLAN oder Router-Portfreigabe. Kein STUN. |
| **„Maximal anonym (nur Tor)“ (Pro)** | `3` | unverändert |
| *nur Release N:* „Erweitert → STUN-Hilfe (Übergang)“ | eigener Schalter `stun_help`, Standard **aus** | fragt wie früher 2 öffentliche STUN-Dienste. Ausgeklappt mit ehrlichem Text; fällt in N+1 weg. |

**Speicher-Migration** (`ConnectionMode.loadConnectionMode`):

- Gespeichertes `'1'` wird zu `2` (bzw. in Release N zu `2` + `stun_help` nach Entscheidung E3).
  Einmal neu speichern und einen einmaligen Hinweis zeigen.
- Ein höherer Schutz darf laut Projektregel ohne Rückfrage gelten. Nur das Lockern muss bewusst
  geschehen.
- `'3'` bleibt `3`, auch ohne Lizenz (bestehende Regel).
- Unlesbarer Wert: weiterhin wie Stufe 3 behandeln (ausfallsicher).
- **Anzeige:** `connMode.level` zeigt heute „Stufe {n}“ mit dem gespeicherten Zahlenwert. Bei nur
  zwei Stufen nach Position nummerieren oder die Nummer weglassen (`App.tsx` `ConnectionModeSection`).
- **`modeShort`** (`App.tsx:6712`) nimmt den Text vor „ (“. Mit den neuen Bezeichnungen prüfen.

**Nominatim entkoppeln (L4):**

- Eigener Schalter „Ortsnamen beim Standort (fragt OpenStreetMap)“.
- Standard so, dass sich für bisherige Stufe-1-Nutzer nichts ändert:
  - an für bisheriges `'1'`/leer
  - aus für bisheriges `'2'`
- Immer aus in Stufe 3 und im Secret Chat (wie heute). Entscheidung E5.

### 7.3 Texte in 18 Sprachen

- **Schlüssel ändern oder ersetzen** (`locales/de.js` als Quelle):
  - `connMode.fast.*` (label/desc/who) entfällt
  - `connMode.private.*` → neu als „Direkt, wenn möglich“
  - `connMode.torOnly.who` präzisieren
  - `connMode.leave.bodyFast` entfällt; `connMode.leave.bodyPrivate` neu formulieren
  - `connMode.intro`
  - `direct.notAuthorizedPrivate`, `direct.unsupportedPrivate`, `direct.notAuthorizedOptional`:
    Die Router-Freigabe wird für alle der wichtigste IPv4-Weg
  - `direct.ipv6Missing` (eventuell mit Hinweis „WLAN kurz aus/an“)
- **Neue Schlüssel:**
  - Einmal-Hinweis zur Umstellung
  - Übergangsschalter „STUN-Hilfe“ (nur N)
  - Nominatim-Schalter
- **Umfang:** etwa 15–20 Schlüssel × 18 Sprachen.
- **Werkzeuge:** `__tests__/i18n/i18n.completeness.test.js` erzwingt Vollständigkeit;
  `i18n.static` prüft Literale.
- **Außerhalb der App** (Deutsch und Englisch):
  - `website/site/index.html` (Tabelle „Wer sieht was“), `faq.html`, `datenschutz.html`
    (Abschnitt „Direktverbindung und STUN“), jeweils `en/`
  - `README.md` (Tabelle Fast/Private)
  - `PLAY_STORE.md` (Datensicherheit: „zwei von vier öffentlichen STUN-Diensten“ streichen)
  - die **Play-Console-Angaben** selbst; das macht der Nutzer
  - `IOS_PLAN.md`, `GROUP_CALL_DESIGN.md`, `MASTERPLAN_DAUERVERBINDUNG.md` (Phase 7 Punkt 4 als
    entschieden markieren)

### 7.4 Server: was kann abgeschaltet werden, in welcher Reihenfolge?

**Stand laut Dokumenten:**

- **Gedächtnis (07.10.):** „Relay und coturn laufen bis zur Umstellung weiter“.
- **Gedächtnis (19.10.):** „altes Relay und coturn dort stillgelegt“.
- **`website/ANLEITUNG.md` Abschnitt 4:** beschreibt das Stilllegen von relay.js und coturn auf
  dem Laptop mit `deploy/altes-relay-stilllegen.sh`.
- **Tatsächlicher Stand:** in dieser Analyse **nicht geprüft** (kein Serverzugriff).

Fest steht: **Keine veröffentlichte App-Version braucht den eigenen coturn.** Betroffen wären nur
Test-APKs vom 16. bis 19.10. mit `malachii.duckdns.org:3478`; sie verhalten sich ohne coturn
einfach wie Stufe 2.

**Reihenfolge (jeder Schritt vom Nutzer per SSH, vorher Backup nach `/root/backups/` und lokale
Kopie, wie in `project_server_exit_plan`):**

1. **Jetzt, unabhängig vom App-Release:** Prüfen, ob coturn noch läuft.
   - Auf dem Server: `systemctl status coturn`, `systemctl list-timers coturn-ipv6-update.timer`.
   - Wenn ja: `/etc/turnserver.conf` sichern, dann `systemctl disable --now coturn
     coturn-ipv6-update.timer`.
   - Firewall-Regeln für 3478/5349 (ufw/nftables) und alte FritzBox-Freigaben entfernen.
2. **Nach einigen Wochen ohne Auffälligkeiten:** `apt-get purge coturn`.
3. **Repo aufräumen** (mit WP5, über `tools/oss-abgleich.sh` auch im öffentlichen Repo):
   - `coturn-setup.sh`, `coturn-ipv6-update.{sh,service,timer}`, `coturn-hardening-2026-09-28.md`
   - `server/hetzner/turnserver.conf`, `run-coturn-hidden.vbs`, `.last-coturn-ip.txt`,
     `coturn-ip-update.log`
   - `update-coturn-ip.ps1`: **in dieser Analyse nicht geöffnet**; vor dem Löschen auf Geheimnisse
     prüfen. Wie `update-duckdns.ps1` darf es nie öffentlich werden.
   - Entweder löschen oder unter `archiv/` verschieben und in `oss-abgleich.sh` ausschließen.
4. **DuckDNS** (`malachii.duckdns.org`) wird für STUN **nicht mehr** gebraucht. Ob es für Website
   oder Zertifikate noch nötig ist, gehört zum Server-Ausstieg, nicht zu diesem Plan.

**Abgleich mit `project_server_exit_plan`:**

- Ziel „App serverfrei, dann Server leeren“: für STUN **schon erfüllt**. Die App nutzt keinen
  eigenen STUN mehr.
- Die offene Frage „STUN weglassen oder winzig weiterbetreiben“ wird mit **weglassen** beantwortet.
- Was danach noch an Fremd-STUN bleibt, beseitigt dieser Plan auf App-Seite.

---

## 8. Implementierungsplan

Größen: **S** ≈ bis 1 Tag, **M** ≈ 2–4 Tage, **L** ≈ 1–2 Wochen, **XL** > 2 Wochen. Jedes Paket
wird im Worktree mit Jest-Tests nach dem Muster `__tests__/security/*` gebaut (echter
Produktionscode, native Teile als Attrappe, statische Quelltext-Wächter). Vor der Übernahme gibt
es einen Gerätetest.

### WP0 – Messbar machen (vor jeder Umstellung) · M

**Ziel:** Die wichtigste offene Zahl ermitteln: Wie viele Direktverbindungen hängen wirklich an
STUN? Ohne Server, ohne Telemetrie.

**Neues Modul `ConnectionStats.js`:** lokale Zähler in EncryptedStorage (`conn_stats_v1`).
**Keine IP-Adressen, keine Kontakt-IDs, keine Zeitstempel einzelner Ereignisse,** nur Zählwerte
je Kategorie:

- **Direkt-Versuche:**
  - gestartet / erfolgreich / gescheitert (Zeitlimit, abgelehnt, Netzwechsel)
  - Aufbauzeit in Klassen (< 2 s, < 5 s, < 10 s, ≥ 10 s)
- **Gewählter Pfad** aus `getStats()` (Logik aus `WebRTCManager._logSelectedPath`, Zeile 890).
  Klassen:
  - `ipv6-host`
  - `lan` (private IPv4 beidseitig)
  - `freigabe` (Kandidat mit Foundation `pcp|natpmp|upnp`)
  - `stun` (srflx nicht aus Freigabe)
  - `prflx`
- **„Schatten-Messung“ in Stufe 1:** 5 s nach dem Verbinden prüfen, ob irgendein Kandidatenpaar
  im Zustand `succeeded` **ohne STUN-Kandidat** existiert (beide Seiten `host` oder Freigabe).
  Das ist eine vorsichtige Untergrenze für „hätte ohne STUN geklappt“. `prflx`-Paare zählen nicht,
  weil sie ursächlich von einem STUN-Paket abhängen können **[Annahme – prüfen, ob libwebrtc
  nicht gewählte Paare lange genug prüft]**.
- **Netzlage beim Versuch:**
  - WLAN/Mobilfunk (aus `MalachiPcp.ipv6Status`)
  - IPv6 ok ja/nein
  - Portfreigabe-Ergebnis
- **Anrufe:**
  - Weg: `webrtc` / `kanal-direkt` / `kanal-tor`
  - Aufbauzeit-Klasse
  - Abbruchgrund
- **Kanal-Audio:** verworfene Pakete und Leerläufe. Dazu ein nativer Zähler in
  `MalachiCallAudioModule.kt` (`play()`/Wiedergabe-Thread) und eine neue Methode `getStats()`.
- **Gruppenanrufe:** Paare verbunden / „nicht erreichbar“.
- **Zeitanteil direkt vs. Tor** je Tag (Summe über alle Kontakte, ohne Zuordnung).

**Diagnose-Ansicht** in den Einstellungen:

- ausklappbar, mit Kurzstatus
- „Zurücksetzen“
- „Als Text kopieren“ über `SecureClipboard`
- Tester schicken den Text bzw. Screenshot selbst. **Kein Upload.**

**Tests:**

- `__tests__/security/connectionStats.privacy.test.js`:
  - Gespeichertes JSON enthält keine IPv4-/IPv6-Muster, keine Kontakt-IDs, keine Onion-Adressen.
  - Release-Builds schreiben nichts in logcat (Muster `releaseConsole.test.js`).
  - „Alle Daten löschen“ leert die Statistik (Muster `wipe.*.test.js`).
- `__tests__/security/connectionStats.classify.test.js`: Klassifizierung aus
  `getStats()`-Attrappen. Insbesondere werden Freigabe-srflx und STUN-srflx unterschieden, und die
  Schatten-Messung zählt `prflx` nicht.

### WP1 – Lücken im STUN-freien Weg schließen · M

1. **Portfreigabe für Anruf-PCs (L1):**
   - Die Freigabe-Logik aus `WebRTCManager` (`_withPortMappings`, `_adoptPortMappings`,
     Erneuern/Löschen) in eine wiederverwendbare Klasse `PortMappingSession` auslagern.
   - `CallManager._createPeerConnection` und `GroupCallManager.createPc`: Nach Ende des Sammelns
     (`onicecandidate` mit `null`) die Host-Kandidaten freigeben lassen. Erfolgreiche Freigaben
     als zusätzliche `ice`-Signale schicken; das ist Trickle und gibt es dort schon.
   - Freigeben in `_closePeerConnection`/`endCall` bzw. `hangup`/`failPeer`.
   - Stufe 3: niemals.
2. **Portfreigabe beim ICE-Neustart (L2):** `createIceRestartOffer` und `acceptIceRestartOffer`
   geben die neue Beschreibung durch `_withPortMappings` (kurze Wartezeit, z. B. 1 s), oder
   reichen sie nach Punkt 3 nach.
3. **Spät eintreffende Freigaben nachreichen (L3):**
   - Neues Signal `direct_cand` `{ id, cand }` in `DirectUpgrade.js`.
   - Nur gültig für den laufenden Versuch bzw. Neustart mit gleicher `id`.
   - Nur `srflx`-Zeilen mit öffentlicher IPv4, Prüfung wie in `addMappedCandidates`.
   - Höchstens 8 je Versuch.
   - In Stufe 3 wird nichts gesendet und Eingehendes ignoriert.
   - Danach `PORT_MAPPING_MAX_WAIT_MS[MODE_PRIVATE]` von 4000 auf ~1500 ms senken.
4. **Kleinkram:**
   - L7 (veraltete Kommentare in `WebRTCManager.js` und `server/hetzner/turnserver.conf`)
   - L5/L6 (Texte, mit WP2)

**Tests:**

- `connectionMode.portMapping.test.js` erweitern: Neustart mit Freigabe, spätes Nachreichen.
- Neu `__tests__/security/call.portMapping.test.js`:
  - 1:1 und Gruppe bekommen Freigabe-Kandidaten per `ice`.
  - Freigaben werden beim Auflegen gelöscht.
  - Stufe 3 fragt den Router nie.
- Neu `__tests__/security/directUpgrade.lateCandidate.test.js`:
  - fremde/alte `id` wird verworfen
  - nur gültige öffentliche IPv4-srflx
  - Obergrenze
  - Stufe 3 sendet nie
  - alte Gegenseite (kein Handler) bricht nichts

### WP2 – Standard „ohne STUN“, Einstellungen, Texte, Nominatim · M

- **`ConnectionMode.js`:**
  - `DEFAULT_CONNECTION_MODE = MODE_PRIVATE` (umbenannt `MODE_DIRECT`, alter Name als Alias)
  - `normalize('1') → 2` plus einmalige Migration (Abschnitt 7.2)
  - in Release N zusätzlich `stun_help` (Standard aus); `iceServersForMode(mode)` liefert STUN
    nur bei `stun_help === true`
  - Bei Wechsel von `stun_help` auf aus: ICE-Neustart wie heute beim Wechsel 1 → 2
    (`DirectUpgrade.applyConnectionMode`).
- **`App.tsx`:**
  - `ConnectionModeSection` mit zwei Stufen und ausklappbarem „Erweitert“
  - Einmal-Hinweis nach Migration
  - `modeShort`
  - Nominatim-Schalter; `reverseGeocode` prüft den Schalter statt `MODE_FAST`
- **Texte:** `locales/*.js` (18), Website de/en, README, PLAY_STORE.md (Abschnitt 7.3).
- **Tests:**
  - `connectionMode.test.js` umbauen: Standard ohne STUN; `stun_help` nur Opt-in; Stufe 3
    unverändert; Lesefehler → Stufe 3.
  - Neu `connectionMode.migration.test.js`:
    - `'1'` → 2 (einmal, mit Hinweis-Merker)
    - `'3'` bleibt ohne Lizenz
    - Speicherfehler beim Migrieren lockert nie den Schutz
  - Neu `location.placeNames.test.js`: Nominatim nur bei eingeschaltetem Schalter, nie in Stufe 3
    oder Secret Chat. Migration aus alter Stufe.
  - `update.dataPreservation.test.js`-Muster: Update von v1.0 mit gespeicherter Stufe 1/2/3
    verliert nichts.
  - i18n-Tests laufen automatisch mit.

### WP3 – Anrufe ohne Direktweg besser machen · a) M, b) L

- **a) Kanal-Audio auf Direktverbindungen über einen unzuverlässigen DataChannel**
  (`malachi-audio`, `ordered:false, maxRetransmits:0`):
  - Erzeugt der Anbieter der Direktverbindung bei Bedarf; es braucht keine Neuverhandlung.
  - `createAnswerDirect`: `ondatachannel` nach Label trennen. **Wichtig:** Heute überschreibt
    jeder neue Kanal `this.dataChannel`.
  - Pakete weiterhin mit `sealForConnection` verschlüsseln.
  - Über Tor bleibt es beim Chat-Kanal.
- **b) Tor-Audio:**
  - **Anpassbarer Wiedergabepuffer:** Zielwert 120–250 ms nach gemessenem Jitter, statt fest bis
    400 ms und dann verwerfen.
  - **Paketverlust verdecken:** Opus-PLC/FEC. Android-MediaCodec bietet das nicht verlässlich,
    deshalb eventuell libopus (BSD) per NDK; das ist auch für die iOS-Pläne nützlich.
  - **Polsterung für `call_audio` prüfen:** Sie werden ohnehin im festen Takt gesendet; die
    Größe ist mit Blick auf die Uniformitätsregel abzuwägen.
  - Eventuell 40-ms-Pakete (weniger Tor-Zellen).
- **Tests:** `call.channelAudio.test.js` erweitern (Kanalwahl nach Label, kein Überschreiben des
  Chat-Kanals, Umschalten Tor → direkt mitten im Anruf). Qualität nur am Gerät messen.

### WP4 – Gruppenanrufe ohne Direktweg (optional, nach Messung) · L

- **Variante g:** Weiterleitung über den Gastgeber.
  - Machbarkeitsprobe zuerst: Kann react-native-webrtc eine empfangene Audiospur einer anderen PC
    hinzufügen? **[Annahme – prüfen]**
  - Kachel „über Gastgeber“; Vertrauensmodell in `GROUP_CALL_DESIGN.md` ergänzen.
- **Alternative:** Kanal-Audio je Paar mit nativem Mischer (mehrere Opus-Decoder) für bis zu 4
  Teilnehmer.
- **Tests:** `groupCall.mesh.test.js` erweitern (Paar nicht erreichbar → Weiterleitung aktiv;
  Gastgeber legt auf → Ende; Stufe 3 unverändert).

### WP5 – STUN-Code entfernen (Release N+1) · S–M

- `AppConfig.js`: `STUN_POOL` und `STUN_PER_CONNECTION` löschen, Kommentar neu.
- `ConnectionMode.js`: `iceServersForMode` → immer `[]` (oder ganz weg); `stun_help` mit
  Migration (Wert ignorieren und löschen).
- `WebRTCManager.js`: Kommentare; `PORT_MAPPING_MAX_WAIT_MS` nur noch ein Wert.
- **Tests umbauen:**
  - `connectionMode.test.js` (`expectTwoPoolStuns` → leer)
  - `connectionMode.portMapping.test.js` (Zeilen 157–175)
  - `serverless.callsAndPairing.test.js` (Zeilen 76–83: jetzt `STUN_POOL` undefined)
  - `mockConfig` in 10 Testdateien bereinigen
- **Neuer Wächter `__tests__/security/noStun.static.test.js`:**
  - kein `stun:`/`turns?:`-URL in App-Quellen (`*.js`, `*.tsx`, `android/**/*.kt`)
  - Ausnahme: `TorBridges.js` (Snowflake-Bridge-Zeilen, ausdrücklich erlaubt)
  - `web/` getrennt behandeln, solange offline
  - `pcConfigForMode` liefert für alle erlaubten Stufen `iceServers: []`
  - `AppConfig` exportiert nichts mit `STUN`
- **Dokumente:** `GROUP_CALL_DESIGN.md`, `MASTERPLAN_DAUERVERBINDUNG.md`, `IOS_PLAN.md`,
  `SECURITY_AUDIT_*`-Nachtrag (T7 erledigt).

### WP6 – Server und Repo aufräumen · S (Nutzer per SSH)

Siehe 7.4. coturn sofort möglich, Repo-Dateien mit WP5.

### WP7 – Experimente (optional, nur wenn die Messung großen IPv4-Verlust zeigt) · je M

- **E-A „geratener srflx“:**
  - Öffentliche IPv4 vom Router (UPnP/NAT-PMP-Status) oder vom Tor-Wächter
    (`GETINFO address`, erst die Machbarkeit prüfen).
  - Kandidat `IP:lokaler-Port` mit niedriger Priorität.
  - Nur wenn die IP öffentlich ist (nicht 100.64/10).
  - Test: `geratenerKandidat.test.js` (nur öffentliche IPv4, nie in Stufe 3, Priorität unter
    echten Kandidaten).
- **E-B „Kontakt als STUN-Reflektor“:**
  - Opt-in auf beiden Seiten, nur direkt verbundene Kontakte, Reflektor nur kurz geöffnet.
  - Nativer Antworter.

### WP8 – Snowflake-Entscheidung · S

Optionen (E7):

- **(1)** lassen wie Tor Browser und ehrlich dokumentieren (empfohlen)
- **(2)** `AUTO_SEQUENCE` umstellen: obfs4 vor Snowflake (weniger STUN, aber obfs4 wird in
  manchen Ländern schneller blockiert)
- **(3)** Snowflake nur nach Rückfrage

Test: bestehende `tor.transport.test.js` anpassen.

### Reihenfolge

```
Woche 1      WP0 (Messen) + WP6 Schritt 1 (coturn prüfen/abschalten, unabhängig)
Woche 1–2    WP1 (Lücken) parallel zu WP2-Vorbereitung (Texte, Migration)
Woche 2–3    Messphase 1: Tester mit Stufe 1 + Schatten-Messung, danach je 1 Woche Stufe 2
Woche 3–4    Release N: WP1 + WP2 + WP3a  (Standard ohne STUN, Übergangs-Opt-in)
Woche 4–8    Messphase 2 (Tester + Rückmeldungen), ggf. WP3b, WP4, WP7 nach Bedarf
danach       Release N+1: WP5 (STUN-Code raus), WP6 Repo-Teil, WP8
```

**Gesamtaufwand Kern** (WP0, WP1, WP2, WP3a, WP5, WP6): etwa **2–3 Wochen** Entwicklung. Dazu
kommt die Messzeit. **Optional:** WP3b (L), WP4 (L), WP7 (je M).

### Gerätetests (verschiedene Netze)

Ausgangslage:

- Geräte: Pixel 8 und Pixel 7a; Emulator, sobald frei (hängt hinter dem NAT des PCs und eignet
  sich für „nicht erreichbar“).
- Der eigene Anschluss ist laut Gedächtnis **DS-Lite**. Schaltet man IPv6 im FritzBox-Heimnetz ab,
  erhält man ein echtes **„nur CGNAT-IPv4“-WLAN**. Ideal für Test T6.
- Im Android-APN lässt sich das Protokoll auf „IPv4“ bzw. „IPv6“ stellen.

| # | Aufbau | Erwartung ohne STUN | Messen |
|---|---|---|---|
| T1 | beide im selben WLAN | direkt (lan/ipv6-host) | Aufbauzeit, Pfad |
| T2 | WLAN (IPv6 ok) ↔ Mobilfunk Telekom (IPv6) | direkt (ipv6-host) | Pfad, Anruf WebRTC, Video |
| T3 | WLAN ↔ Mobilfunk O2 bzw. Vodafone | direkt, falls IPv6 im Mobilfunk geht | IPv6 im Mobilfunk ja/nein |
| T4 | Mobilfunk ↔ Mobilfunk (verschiedene Netze) | direkt über IPv6 | Pfad, Anruf |
| T5 | **IPv4-only:** Handy APN „IPv4“ ↔ WLAN mit IPv6 aus, FritzBox-Freigabe **aus** | **Tor**; Anruf über Tor-Kanal | Zeit bis Tor-Sprache, Verzögerung (Klatschtest/Stoppuhr), Aussetzer |
| T6 | wie T5, FritzBox-Freigabe **an** (öffentliche IPv4 nötig; bei DS-Lite nicht möglich, dann anderer Anschluss) | direkt (freigabe) | Pfad, Anruf WebRTC nach WP1 |
| T7 | **IPv6-only:** Handy APN „IPv6“ (Telekom, 464XLAT) ↔ WLAN dual-stack | direkt über IPv6 | Pfad |
| T8 | FritzBox-Routen-Fehler nachstellen (IPv6-Route weg) | Tor + Hinweis `direct.ipv6Missing` | Hinweis sichtbar? |
| T9 | Netzwechsel WLAN → Mobilfunk während Chat und Anruf | ICE-Neustart oder Tor-Reserve; Anruf läuft weiter (Kanal) | Unterbrechung in s |
| T10 | Gruppenanruf 3 Geräte, eines in T5-Lage | dieses Paar „nicht erreichbar“ (ohne WP4) | Anteil erreichbarer Paare |
| T11 | Mischbetrieb v1.0.0 (STUN) ↔ neue Version | mindestens wie T1–T7, im Fall T5 eventuell besser | Pfad |
| T12 | 8-h-Nachttest Bildschirm aus (Masterplan-Kriterien) | Zeitanteil direkt wie Phase 0 | Diagnose-Zähler |

### Messgrößen für „gut genug“

| Kennzahl | Ziel (Vorschlag) | Quelle |
|---|---|---|
| Zeitanteil „direkt“ bei Testern, wenn beide online | ≥ 80 % **und** höchstens 10 Prozentpunkte unter dem Stufe-1-Wert derselben Tester | WP0-Zähler |
| Schatten-Messung: Anteil Verbindungen, die ohne STUN-Kandidat gingen | ≥ 85 % (sonst WP7 prüfen) | WP0 |
| Tor-bereit → direkt aktiv | Median ≤ 3 s, p90 ≤ 8 s (nicht schlechter als heute) | WP0 |
| Anruf-Aufbau (Annehmen → Sprache) | direkt ≤ 2 s; über Tor-Kanal ≤ 3 s bei bestehender Verbindung | WP0 |
| Sprache über Tor: Mund-zu-Ohr | Median ≤ 400 ms (G.114-Grenze), verworfene Pakete ≤ 3 % | Klatschtest, nativer Zähler |
| Subjektive Qualität (1–5) über Tor | ≥ 3,5 im Mittel | Tester-Bogen |
| Gruppenanruf: Paare „nicht erreichbar“ | ≤ 10 % (sonst WP4) | WP0 |
| Akku im Leerlauf | nicht schlechter als 1 %/h (Masterplan) | Android-Akkustatistik |

---

## 9. Rollout und Risiken

### Stufen

1. **Messbuild** (Release-Kandidat, nur Tester): WP0 aktiv, Stufe 1 bleibt Standard. 1–2 Wochen
   Baseline mit Schatten-Messung, danach Tester bewusst auf Stufe 2. Ergebnis: echte Zahlen statt
   der Schätzung aus 3.5.
2. **Release N:**
   - Standard ohne STUN.
   - Übergangsschalter „STUN-Hilfe“ (aus, unter „Erweitert“).
   - WP1, WP2, WP3a.
   - Web-APK per In-App-Update (24–30 h).
   - Play-Variante als **gestaffelter Rollout** (z. B. 20 % → 50 % → 100 %).
3. **Beobachtung 4 Wochen:** Tester-Diagnosen, Rückmeldungen. Es gibt keine Telemetrie; das ist
   Absicht.
4. **Release N+1:** STUN-Code und Übergangsschalter entfernen (WP5). Texte final.

**Rückfall:**

- Es gibt keinen Server und damit keinen Fernschalter.
- In Release N: Nutzer schalten „STUN-Hilfe“ selbst ein.
- Notfalls ein Hotfix-Release mit `stun_help` als Standard (Web-APK in ~1 Tag, Play-Rollout
  anhalten).
- In N+1 ist der Rückfall nur noch per Update möglich. Deshalb erst nach der Messphase 2.

### Risiken und Gegenmaßnahmen

| Risiko | Wahrscheinlichkeit | Wirkung | Gegenmaßnahme |
|---|---|---|---|
| Deutlich weniger Direktverbindungen in IPv4-only-Netzen | mittel | mehr Tor: langsamer, mehr Akku | Messung vorab; Router-Freigabe-Hinweis; WP7; Opt-in in N |
| Anrufqualität über Tor wird als schlecht empfunden | mittel | Beschwerden | WP3b; ehrlicher Hinweis „läuft über Tor“ (`call.end.viaTor` gibt es) |
| Mehr „nicht erreichbar“ in Gruppenanrufen | mittel | Gruppenanrufe unbrauchbar für Einzelne | WP4; Hinweis mit Grund |
| FritzBox-IPv6-Routen-Fehler wiegt schwerer | mittel | ganzes Heimnetz fällt auf Tor | Hinweis prominenter (auch im Chat-Status), Tipp „WLAN aus/an“ |
| Nominatim still aus (L4) | sicher, wenn vergessen | Funktionsverlust | WP2 entkoppelt |
| Snowflake fragt weiter STUN | sicher in Sperrnetzen | Werbeaussage „kein STUN“ falsch | präzise Formulierung: „Malachi selbst fragt keine STUN-Dienste“; WP8 |
| Werbeaussagen zu IP-Sichtbarkeit ungenau (L5/L6) | heute schon | Vertrauensverlust bei Audits (OTF) | Texte nach 6.3 |
| `ondatachannel` überschreibt Chat-Kanal (WP3a) | hoch, wenn übersehen | Chat bricht | Test vor Merge |
| Tor-Netz überlastet oder angegriffen | gering bis mittel | ohne Direktweg alles langsam | nicht vermeidbar; Bridges-Automatik vorhanden |
| Mischbetrieb verwirrt Tester | gering | falsche Schlüsse | Diagnose zeigt die eigene Einstellung |
| iOS später: UPnP braucht Apple-Multicast-Berechtigung | sicher (iOS) | weniger Freigaben auf iOS | in `IOS_PLAN.md` schon vermerkt; PCP/NAT-PMP gehen |

---

## 10. Offene Entscheidungen (mit Empfehlung)

| # | Frage | Empfehlung |
|---|---|---|
| E1 | Endziel bestätigen: Malachis eigenes ICE ganz ohne STUN? | **Ja**, in zwei Releases mit Messphase dazwischen. |
| E2 | Übergangs-Opt-in „STUN-Hilfe“ für ein Release behalten? | **Ja**, versteckt unter „Erweitert“, Standard aus. Es ist der einzige Rückfall ohne Update. |
| E3 | Bisherige Stufe-1-Nutzer automatisch umstellen? | **Ja**, auf „ohne STUN“, mit einmaligem Hinweis. Mehr Schutz darf ohne Rückfrage gelten. |
| E4 | Zwei oder drei Stufen in den Einstellungen? | **Zwei:** „Direkt, wenn möglich“ und „Maximal anonym (nur Tor, Pro)“. |
| E5 | Nominatim: eigener Schalter oder an die Stufe gekoppelt? | **Eigener Schalter.** Standard wie bisher je Nutzer (an für alte Stufe 1, aus für alte Stufe 2), nie in Stufe 3 oder Secret Chat. |
| E6 | Gruppenanrufe: Gastgeber-Weiterleitung bauen oder „nicht erreichbar“ akzeptieren? | **Erst messen.** Bei > 10 % unerreichbaren Paaren WP4 (Variante g). |
| E7 | Snowflake (fragt STUN) in der Tor-Automatik? | **Behalten wie Tor Browser,** ehrlich dokumentieren. Optional: obfs4 vor Snowflake. |
| E8 | Experimente „geratener srflx“ / „Kontakt als Reflektor“? | **Zurückstellen.** Nur bei > 10 Prozentpunkten Verlust in der Messung, zuerst E-A. |
| E9 | coturn auf dem Server jetzt abschalten? | **Ja, jetzt** (nach Prüfung und Backup). Keine veröffentlichte Version nutzt ihn. |
| E10 | Wie kommen Messdaten von Testern ohne Server? | Diagnose-Ansicht mit „Als Text kopieren“; Tester schicken den Text selbst. Keine Telemetrie. |
| E11 | Texte zur IP-Sichtbarkeit korrigieren (L5/L6), auch unabhängig vom Ausstieg? | **Ja, sofort.** Der Kontakt sieht die Adressen schon beim Versuch, der Tor-Eintrittsknoten immer. |
| E12 | Release N mit den Funktionen aus `features-okt26` bündeln oder getrennt? | **Getrennt.** Die Messung braucht einen stabilen Vergleich. |

---

## 11. Quellen

**Messdaten und Studien**

- APNIC Labs, IPv6-Nutzung Deutschland (Zeitreihe bis 22.10.2026: 73,5 % fähig, 70,8 % bevorzugt):
  https://stats.labs.apnic.net/ipv6/DE · Rohdaten: https://data1.labs.apnic.net/v6stats/v6economy/DE.json
- Richter u. a., „A Multi-perspective Analysis of Carrier-Grade NAT Deployment“, IMC 2016:
  https://arxiv.org/abs/1605.05606 (HTML: https://ar5iv.labs.arxiv.org/html/1605.05606)
- Ford, Srisuresh, Kegel, „Peer-to-Peer Communication Across Network Address Translators“, USENIX 2005:
  https://bford.info/pub/net/p2pnat/
- Trautwein u. a., „Challenging Tribal Knowledge: Large Scale Measurement Campaign on Decentralized NAT
  Traversal“ (2025): https://arxiv.org/abs/2510.27500 · ProbeLab: https://probelab.io/blog/can-libp2p-punch-through-nats/
- Tailscale, „How NAT traversal works“ (Birthday-Ansatz): https://tailscale.com/blog/how-nat-traversal-works
  (Zusammenfassung bei APNIC: https://blog.apnic.net/2022/04/26/how-nat-traversal-works-nat-notes-for-nerds/)
- Sharma u. a., „The Road Not Taken: Re-thinking the Feasibility of Voice Calling Over Tor“, PoPETs 2020:
  https://petsymposium.org/popets/2020/popets-2020-0063.php · https://arxiv.org/abs/2007.04673
- Tor Metrics, OnionPerf-Laufzeiten (Onion-Server, CSV Aug.–Sep. 2026):
  https://metrics.torproject.org/onionperf-latencies.html ·
  https://metrics.torproject.org/onionperf-latencies.csv?start=2026-08-01&end=2026-09-21&server=onion
- Anteil WebRTC-Verbindungen mit TURN (Herstellerangaben): https://www.100ms.live/blog/webrtc-turn-server ·
  https://www.nojitter.com/video-conferencing/know-where-to-turn-when-deploying-webrtc

**Netzbetreiber und Router**

- Telekom startet IPv6 im Mobilfunk (Dual-Stack, 2015): https://www.mobiflip.de/telekom-startet-ipv6-im-mobilfunknetz/
- O2 IPv6 für alle Mobilfunkkunden (2021): https://winfuture.de/news,122546.html
- Vodafone-Forum, IPv6-only im LTE/5G-Netz: https://forum.vodafone.de/t5/Feedback/IPv6-only-im-LTE-5G-Netz/td-p/3214646
- AVM/FRITZ!, automatische Portfreigaben (UPnP/PCP, pro Gerät):
  https://fritz.com/en/apps/knowledge-base/FRITZ-Box-4020/894_Setting-up-automatic-port-sharing

**Standards und Spezifikationen**

- RFC 8445 (ICE, inkl. peer-reflexive Kandidaten): https://www.rfc-editor.org/rfc/rfc8445
- RFC 8489 (STUN): https://www.rfc-editor.org/rfc/rfc8489
- RFC 8656 (TURN): https://www.rfc-editor.org/rfc/rfc8656
- RFC 4787 (NAT-Verhalten für UDP, Endpunkt-unabhängiges Mapping): https://www.rfc-editor.org/rfc/rfc4787
- RFC 6888 (Anforderungen an CGNAT): https://www.rfc-editor.org/rfc/rfc6888
- RFC 6887 (PCP): https://www.rfc-editor.org/rfc/rfc6887 · RFC 6886 (NAT-PMP): https://www.rfc-editor.org/rfc/rfc6886
- RFC 6092 (IPv6-Firewall in Heimroutern): https://www.rfc-editor.org/rfc/rfc6092
- RFC 6333 (DS-Lite): https://www.rfc-editor.org/rfc/rfc6333
- RFC 8981 (temporäre IPv6-Adressen): https://www.rfc-editor.org/rfc/rfc8981
- ITU-T G.114 (Einweg-Verzögerung): https://www.itu.int/rec/T-REC-G.114
- Tor-Spezifikation, NETINFO-Zelle (OTHERADDR): https://spec.torproject.org/tor-spec/negotiating-channels.html
- Tor-Commit „channel: Consider NETINFO other address as ours“ (2020):
  https://lists.torproject.org/mailman3/hyperkitty/list/tor-commits@lists.torproject.org/thread/CB5DWVVOHGZ6LRO5YGALQRYLYQ5G2TBA/
- libwebrtc `stun_port.h` (STUN-Lebenszeichen, Lebensdauer 2 min bei teuren Netzen, sonst unbegrenzt):
  https://webrtc.googlesource.com/src/+/refs/branch-heads/m77/p2p/base/stun_port.h
- Snowflake (Tor Pluggable Transport): https://snowflake.torproject.org/

**Projektinterne Quellen (gelesen)**

- `ConnectionMode.js`, `AppConfig.js`, `WebRTCManager.js`, `DirectUpgrade.js`, `CallManager.js`,
  `GroupCallManager.js`, `TorTransport.js`, `TorBridges.js`, `BackgroundSync.js`, `App.tsx` (Ausschnitte),
  `android/.../net/MalachiPcpModule.kt`, `android/.../tor/MalachiCallAudioModule.kt`
- `__tests__/security/connectionMode.test.js`, `connectionMode.portMapping.test.js`, `pcp.portMapping.test.js`,
  `p2pOnly.controlSignals.test.js`, `serverless.callsAndPairing.test.js`, `connectionMode.calls.test.js`
- `MASTERPLAN_DAUERVERBINDUNG.md`, `GROUP_CALL_DESIGN.md`, `SECURITY_AUDIT_2026-10-19.md` (T7),
  `SECURITY_AUDIT_2026-10-25.md`, `SECURITY_REVIEW_5_METADATA_PRIVACY.md` (Relay-Zeit, weitgehend überholt),
  `server/hetzner/turnserver.conf`, `coturn-hardening-2026-09-28.md`, `website/ANLEITUNG.md`,
  `website/deploy/altes-relay-stilllegen.sh`, `PLAY_STORE.md`, `README.md`, `I18N.md`
- Git: `d26d32e` (kein eigener STUN mehr), `d67d17e` (deutsche Betreiber), `170cc54` = v1.0.0

---

## 12. Umsetzung (Stand 25.10.2026)

Branch `claude/stun-ausstieg` (Worktree `.claude/worktrees/stun-ausstieg`), abgezweigt von 1.1.0
(`b45626c`). Umgesetzt nach den Entscheidungen E1–E12 – **ein** Release, **keine** Übergangsoption
(E2): WP2 und WP5 sind zusammengelegt. Version (`versionCode`/`versionName`) bewusst unverändert;
die setzt der Release.

### 12.1 Umgesetzt

| Paket | Was | Wo |
|---|---|---|
| WP2+WP5 (E1–E4) | Nur noch zwei Stufen: „Direkt, wenn möglich“ (gespeichert `'2'`, Standard) und „Maximal anonym (nur Tor)“ (`'3'`, Pro, bleibt ohne Lizenz aktiv). `STUN_POOL`, `STUN_PER_CONNECTION`, `iceServersForMode`, `MODE_FAST/MODE_PRIVATE` und der 1→2-ICE-Neustart (`applyConnectionModeConfig`) sind entfernt; `pcConfigForMode` liefert fest `iceServers: []` für jede PeerConnection (Chat, 1:1, Gruppe). Web-App (offline): ebenfalls keine ICE-Server mehr. | `ConnectionMode.js`, `AppConfig.js`, `WebRTCManager.js`, `DirectUpgrade.js`, `web/src/lib/*` |
| Migration (E3/E4) | Gespeichertes `'1'` gilt sofort als `'2'`, wird einmal umgeschrieben (erst Hinweis-Merker `connection_mode_notice='pending'` anlegen, dann `'2'` schreiben und zurücklesen; Schreibzugriffe serialisiert, ein gleichzeitig gewähltes „nur Tor“ wird nie überschrieben). Einmaliger Hinweis nach dem Entsperren – auch für bisherige Nutzer ohne gespeicherte Stufe (bis 1.1.0 = Stufe 1); neu eingerichtete Apps vermerken `'none'`. Speicherfehler: es gilt trotzdem `'2'`, `'1'` bleibt stehen und wird beim nächsten Start erneut umgestellt. | `ConnectionMode.js`, `App.tsx` (SetupScreen, Effekt auf `screen === 'home'`) |
| Wächter (E2) | `noStun.static.test.js`: keine `stun:`/`turn:`-Adresse und kein STUN-Hostname im App-Code (Wurzel, `locales`, Web-App, Android-Quellen/-Manifest/-Ressourcen, `build.gradle`, iOS). Einzige Ausnahme: Snowflake-Zeilen in `TorBridges.js` (E7). | `__tests__/security/noStun.static.test.js` |
| L1 | Anruf-PCs (1:1 und je Gruppenpaar) fragen nach dem Sammeln (bzw. spätestens nach 3 s) den Router; Freigaben gehen als normale `ice`-Kandidaten raus – auch wenn der Router spät antwortet. Löschen beim Auflegen/Paar-Ende, auch wenn die Freigabe erst danach eintrifft; nie in Stufe 3; nach dem Wechsel auf Kanal-Audio wird nichts mehr gesendet. Portfreigabe-Logik dafür aus `WebRTCManager` in `PortMapping.js` ausgelagert (`PortMappingSession`, `CallPortMapper`). | `PortMapping.js`, `CallManager.js`, `GroupCallManager.js` |
| L2 | ICE-Neustart (Angebot und Antwort) nimmt die Freigabe des neuen Netzes mit (höchstens 1 s Wartezeit, Rest wird nachgereicht). Neustart-Frist 6 → 8 s, Gnadenfrist 8 → 10 s. | `WebRTCManager.js`, `DirectUpgrade.js` |
| L3 | Neues Signal `direct_cand { id, cand }`: nur für die laufende Aushandlung (Versuch oder Neustart), nur geprüfte srflx-Zeilen mit öffentlicher IPv4 und privater Basisadresse, höchstens 8 je Aushandlung, nie in Stufe 3. Angewendet erst, wenn die Gegenseiten-Beschreibung genau dieser Aushandlung gesetzt ist (Signale laufen nebeneinander); vor dem Angebot eintreffende Kandidaten werden 20 s gemerkt. Wartezeit auf den Router dadurch 4 s → 1,5 s. Ältere Versionen ignorieren das Signal (nur RAM-Puffer, keine Anzeige). | `DirectUpgrade.js`, `WebRTCManager.js`, `RTCStore.js` |
| WP3a | Eigener DataChannel `malachi-audio` (`ordered:false, maxRetransmits:0`) für Kanal-Audio über die Direktverbindung. **Nur** wenn die Gegenseite ihn im Angebot/in der Antwort ankündigt (`ach: 1`) – 1.1.0 hätte jeden weiteren Kanal als Chat-Kanal übernommen. Eingehende Kanäle werden nach Label getrennt, der Chat-Kanal wird nie mehr ersetzt; auf dem Sprachkanal zählt nur verschlüsseltes `call_audio`; sein Ende beendet die Verbindung nicht. Sonst (Tor, alte Gegenseite, Kanal noch nicht offen) wie bisher über den Chat-Kanal. | `WebRTCManager.js`, `RTCStore.sendCallAudio`, `CallManager.js` |
| WP0 (E10) | `ConnectionStats.js`: nur lokale Zähler je fester Kategorie (Direkt-Versuche und Ausgang, Aufbauzeit-Klassen, Pfad-Klasse aus `getStats` – IPv6/LAN/Freigabe/peer-reflexiv/STUN der Gegenseite –, Netzlage, Portfreigabe-Ergebnis, ICE-Neustarts, Anrufweg und -aufbau, Kanal-Audio-Pakete/Verwerfungen/Leerläufe, Gruppenpaare, Minuten direkt/Tor). Keine IPs, IDs, Onion-Adressen, Zeitpunkte; freie Werte technisch unmöglich. Gespeichert höchstens je Minute bzw. beim Wechsel in den Hintergrund, **nie während eines Anrufs**. Einstellungen → „Verbindungs-Diagnose“ mit Kurzstatus, „Als Text kopieren“ (SecureClipboard) und „Zurücksetzen“; „Alle Daten löschen“ leert alles. Nativ liefert `MalachiCallAudio.stop()` die drei Kanal-Audio-Zähler. | `ConnectionStats.js`, `App.tsx`, `MalachiCallAudioModule.kt` |
| E5 | Nominatim-Rückwärtssuche komplett entfernt – keine Anfrage mehr, `App.tsx` ohne `fetch`. Ortsnamen älterer Absender werden weiter angezeigt (reiner Text). | `App.tsx`, `location.noNominatim.test.js` |
| E7/E11 (L5/L6) | Texte in 18 Sprachen: Kontakt sieht die Adressen schon beim Verbindungsversuch, der Tor-Eintrittsknoten sieht die IP immer; Snowflake nutzt eigene STUN-Server. Website (de/en), `PLAY_STORE.md`, README, Design-Doku angepasst. | `locales/*.js`, `website/site/**`, `PLAY_STORE.md` |
| WP6 (E9, Repo-Teil) | `coturn-ipv6-update.{sh,service,timer}`, `turnserver.conf`, `.last-coturn-ip.txt`, `coturn-ip-update.log` → `archiv/coturn/`. `tools/oss-abgleich.sh` schließt `archiv/`, `coturn-setup.sh`, `coturn-hardening-2026-09-28.md` und die Laufzeitdateien vom öffentlichen Export aus; `.gitignore` hält neu geschriebene Laufzeitdateien aus dem Repo. | `archiv/coturn/`, `tools/oss-abgleich.sh`, `.gitignore` |

**Kontrollen:** `npx jest` komplett grün; `assembleWebDebug` und `assemblePlayDebug` gebaut; Release-JS-Bundle
(`react-native bundle --dev false`) enthält kein `nominatim` und als einzige `stun:`-Adressen die acht
Snowflake-Server aus `TorBridges.js`. Die Play-Variante teilt den kompletten JS-Code und die Kotlin-Quellen
(`src/main`); `Distribution.js` unterscheidet nur Vertrieb und Kauf – sie ist also genauso ohne STUN und
Nominatim (vom Wächter-Test mit abgedeckt).

### 12.2 Abweichungen vom Plan

- **Kein Übergangsschalter „STUN-Hilfe“** (E2) – damit gibt es auch keine Rückfalloption ohne Update.
- **Kein Ortsnamen-Schalter** (E5): statt L4 zu „entkoppeln“ ist die Ortsauflösung ganz entfernt.
- **Schatten-Messung entfällt:** ohne STUN-Stufe gibt es keine STUN-Kandidaten mehr, deren Wegfall man
  vorab schätzen könnte. Ersatz: Pfad-Klasse `peerStun` zählt im Mischbetrieb Verbindungen, die nur über
  den STUN-Kandidaten einer 1.1.0-Gegenseite zustande kamen.
- **Nativer Zähler** über das Ergebnis von `stop()` statt einer eigenen Methode `getStats()` (eine
  Brückenrunde weniger, das Mikrofon wird nicht später freigegeben).
- **Diagnose speichert nicht sofort**, sondern minütlich/beim Wechsel in den Hintergrund und nie während
  eines Anrufs – sonst wäre die Regel „Gruppenanrufe hinterlassen keinen Schreibzugriff“
  (GROUP_CALL_DESIGN.md) verletzt.

### 12.3 Zurückgestellt (mit Grund)

- **WP4 Gruppenanruf-Weiterleitung über den Gastgeber** (E6): erst messen (Diagnose `groupPairs`).
- **WP7 Experimente** (E8): geratener srflx, Kontakt als Reflektor – nicht gebaut.
- **WP3b Tor-Audio** (anpassbarer Puffer, PLC/FEC, Paketgröße): nicht Teil des Auftrags; die neuen Zähler
  (`channelAudio.dropped/underruns`) liefern die Grundlage für die Entscheidung.
- **Web-App:** offline; nur die ICE-Server wurden entfernt, keine L1–L3/WP0-Portierung.
- **Server (WP6 Schritt 1/2):** coturn abschalten macht der Inhaber per SSH (E9), nicht Teil dieses Branches.

### 12.4 Offene Punkte für den Inhaber

- `coturn-setup.sh` (17 Zeilen mit „secret/password“-Stichworten) und `coturn-hardening-2026-09-28.md`
  (1 Zeile) wurden **nicht geöffnet und nicht verschoben** – selbst prüfen und archivieren/löschen.
  `update-coturn-ip.ps1`, `update-duckdns.ps1`, `run-coturn-hidden.vbs`, `run-duckdns-hidden.vbs` und
  `secrets.local.js` unangetastet. Die geplante Windows-Aufgabe zu `run-coturn-hidden.vbs` /
  `update-coturn-ip.ps1` abschalten, sobald coturn aus ist.
- **Öffentliches Repo prüfen:** `coturn-setup.sh`, `.last-coturn-ip.txt` und `coturn-ip-update.log` waren
  bisher nicht vom Export ausgeschlossen. Ob sie in früheren Exporten enthalten waren (und ob darin
  Geheimnisse oder IP-Adressen stehen), bitte im öffentlichen Repo nachsehen; ab dem nächsten Abgleich
  fallen sie heraus (die Historie bleibt).
- **Play Console:** Datensicherheit erst mit dieser Version auf „Erhebt oder teilt keine Nutzerdaten“
  umstellen (PLAY_STORE.md 8.2/15.3).
- **Website** (Datenschutz, FAQ, Startseite) zusammen mit dem Release veröffentlichen.
- **Versionshinweise** für das Release schreiben (Hinweis „Malachi fragt keine STUN-Dienste mehr“,
  Diagnose, Ortsnamen entfallen).

### 12.5 Gerätetest-Checkliste (zwei echte Handys, z. B. Pixel 8 + Pixel 7a)

Vorbereitung: beide mit diesem Build; auf einem Gerät vorher 1.1.0 mit Stufe „Schnell“ installiert lassen
und **darüber** aktualisieren. Diagnose vor jedem Block zurücksetzen und danach „Als Text kopieren“.

| # | Aufbau / Netz | Prüfen |
|---|---|---|
| G1 | Update 1.1.0 („Schnell“) → neu | Einmaliger Hinweis nach dem Entsperren (nicht auf dem Sperrbildschirm, nicht beim zweiten Start); Einstellungen zeigen „Direkt, wenn möglich“; Chats, Kontakte, Gruppen, Medien, Tor-Einstellungen unverändert. Zweites Gerät mit 1.1.0 „Privat“ bzw. „nur Tor“ (ohne Lizenz): kein Hinweis, „nur Tor“ bleibt aktiv. |
| G2 | Beide im selben WLAN (T1) | Direkt in wenigen Sekunden; Diagnose `path: lan` oder `ipv6Host`; 1:1-Anruf mit Video per WebRTC (`calls: webrtc`). |
| G3 | WLAN mit IPv6 ↔ Mobilfunk mit IPv6 (T2/T4) | Direkt über `ipv6Host`; Anruf WebRTC, Video. |
| G4 | **Nur IPv4 ohne Freigabe** (T5): Handy-APN „IPv4“, FritzBox-IPv6 aus, „Selbstständige Portfreigaben“ **aus** | Bleibt Tor (`direct: failTimeout/failIce`); Anruf als Tor-Sprache (`channelTor`), Zeit bis Sprache, Verzögerung (Klatschtest), Aussetzer (`channelAudio.dropped/underruns`). Kein Absturz, Chat läuft weiter. |
| G5 | Wie G4, Freigabe **an** (T6, Anschluss mit echter IPv4) | Direkt über `mapping`; **Anruf jetzt per WebRTC** (L1) statt Kanal-Audio; nach dem Auflegen ist die Freigabe in der FritzBox wieder weg. |
| G6 | Router zum ersten Mal im Netz (Freigabe dauert > 1,5 s) | Diagnose `mapping: late` > 0 und trotzdem `path: mapping` (L3 nachgereicht). |
| G7 | Netzwechsel WLAN → Mobilfunk während Chat und Anruf (T9) | ICE-Neustart (`restart: ok`), bei IPv4-Freigabe im neuen Netz Pfad `mapping` (L2); Unterbrechung in Sekunden; Anruf läuft weiter. |
| G8 | Gruppenanruf zu dritt, ein Gerät in G4-Lage (T10) | Paare mit Freigabe/IPv6 verbunden, dieses Paar „nicht erreichbar“ (`groupPairs`); kein Hänger. |
| G9 | Mischbetrieb neu ↔ 1.1.0 (T11) | Direktverbindung, Anrufe, Kanal-Audio funktionieren; auf 1.1.0 keine merkwürdigen Nachrichten (direct_cand wird ignoriert), kein zweiter DataChannel (`viaAudioChannel` bleibt 0). Pfad `peerStun` möglich. |
| G10 | Kanal-Audio über Direktverbindung (WP3a), wenn es sich ergibt | Chat direkt, Anruf-PC scheitert (z. B. Gegenseite hinter restriktiver Firewall) → Diagnose `channelAudio.viaAudioChannel` > 0, Sprache ohne Ruckler bei Paketverlust. |
| G11 | „Maximal anonym“ an/aus | Keine Direktverbindung, kein Router-Zugriff (FritzBox: keine neue Freigabe), Anrufe nur Sprache über Tor; zurück auf „Direkt, wenn möglich“ → sofort neuer Versuch. |
| G12 | Netzmitschnitt (PCAPdroid o. ä.) / DNS-Protokoll des Routers | Keine Anfragen an `stun.*`, keine an `nominatim.openstreetmap.org` (Standort senden!). Nur bei erzwungenem Snowflake erscheinen dessen STUN-Server. |
| G13 | Diagnose-Ansicht | Kurzstatus stimmt; kopierter Text enthält keine IP, keine Namen/IDs; „Zurücksetzen“ leert; nach „Alle Daten löschen“ leer. |
| G14 | 8-h-Nachttest, Bildschirm aus (T12) | Zeitanteil `minutes.direct/tor`, Akku ≤ 1 %/h. |
