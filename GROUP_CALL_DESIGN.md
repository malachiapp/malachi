# Gruppen-Sprachanrufe – Design (umgesetzt)

Stand: 2026-10-19 · Dateien: `GroupCallManager.js` (Protokoll, Zustand,
Verbindungen), `GroupCallScreen.tsx` (Anrufbildschirm + Navigation),
Anbindung in `RTCStore.js` (Weiche), `CallManager.js` („besetzt“),
`GroupChatScreen.tsx` (Knopf „Gruppenanruf“, Beitreten), `App.tsx` (nur
Verdrahtung) · Tests: `__tests__/security/groupCall.mesh.test.js`,
`__tests__/security/groupCall.screens.test.js`

Dieses Dokument beschreibt, was **tatsächlich gebaut** ist.

## Regeln (Vorgaben des Inhabers)

1. **Nur die Vollversion startet** einen Gruppenanruf. **Jeder** (auch ohne
   Vollversion) kann eingeladen werden, annehmen und teilnehmen.
2. **Kein Server** – kein SFU, kein TURN, kein Relay-Server. Nur P2P wie der
   Rest der App.
3. Nur **Sprache**, höchstens **8 Teilnehmer** (= Gruppengröße).
4. **Nur ein Anruf gleichzeitig** (1:1 oder Gruppe).
5. Im Verbindungsweg **„Maximal anonym (nur Tor)“ keine Gruppenanrufe**.

## Topologie: Vollvermaschung („full mesh“)

- Jedes Paar von Teilnehmern hat eine **eigene RTCPeerConnection nur für
  Audio** (eigene DTLS-SRTP-Verbindung, eigener Schlüssel). Bei n Teilnehmern
  hat jedes Gerät n−1 Verbindungen, insgesamt n·(n−1)/2 Paare (8 → 28 Paare,
  7 je Gerät).
- **Opus mono, niedrige Bitrate:** Die eigene SDP-Beschreibung wird vor
  `setLocalDescription` angepasst (`tuneOpusSdp`): `stereo=0;
  sprop-stereo=0; maxaveragebitrate=20000; useinbandfec=1`. Die
  fmtp-Parameter einer Beschreibung sagen der Gegenseite, wie sie senden
  soll – beide Seiten tun es, also senden beide mono mit ≤ 20 kbit/s und FEC.
- Bandbreite bei 8 Teilnehmern: 7 × ~20 kbit/s hoch und runter (+ RTP/SRTP-
  Overhead) ≈ 0,2–0,3 Mbit/s je Richtung – auch im Mobilfunk tragbar. CPU:
  libwebrtc kodiert je Verbindung – auf Geräten zu prüfen (siehe unten).
- ICE-Konfiguration wie bei 1:1-Anrufen (`pcConfigForCalls`): Stufe 1 nur
  STUN (deutsche Betreiber, kein TURN), Stufe 2 ohne ICE-Server, Stufe 3 wirft
  (`TorOnlyModeError`) – es entsteht dann gar keine PeerConnection.

## Signalisierung

Alles reist als `{ type: 'system', subtype: 'gcall_signal', enc }` über die
**bestehende, verschlüsselte 1:1-Verbindung** zum jeweiligen Kontakt (Tor oder
direkt). `enc` ist zusätzlich mit einem eigenen Unterschlüssel
(`encryptMsg(…, 'gcall-signal')`) verschlüsselt – Domain-Separation wie
`'call-signal'` bei 1:1-Anrufen. `RTCStore._onIncoming` leitet diese
Nachrichten **vor allem anderen** an `GroupCallManager` weiter: nie in einen
Chat, nie in den Puffer, keine Empfangsbestätigung, keine Dedup-Liste, kein
Speicher.

Innerer Inhalt: `{ v: 1, t, callId: 'gc_' + 32 Hex, groupId, … }`.

| Typ | Richtung | Inhalt / Bedeutung |
|---|---|---|
| `invite` | Host → Mitglied | `host`, `participants` (Mitglieds-IDs, inkl. Host), `ts` |
| `ringing` | Mitglied → Host | klingelt |
| `decline` | Mitglied → Host | `reason`: user, busy, tor_only, timeout, mic, error |
| `join` | Mitglied → Host | angenommen bzw. später beigetreten |
| `leave` | Mitglied → Host | aufgelegt |
| `mute` | Mitglied → Host | `mu` (stumm ja/nein) |
| `roster` | Host → Beigetretene | `members: [{ mid, st, mu }]` (Status aller Eingeladenen) |
| `end` | Host → alle Eingeladenen | Anruf vorbei (Host hat aufgelegt) |
| `offer`/`answer`/`ice` | Paar | `to`, `from`, `sdp` bzw. `c` (Kandidat) |

**Ablauf:** Host lädt jedes direkt gekoppelte Mitglied ein → Mitglied klingelt
(`ringing`) → Annehmen (`join`) → Host verteilt die Teilnehmerliste
(`roster`) an alle Beigetretenen → jedes Paar baut seine Verbindung auf.
**Wer bietet an?** Immer der Teilnehmer mit der **kleineren Mitglieds-ID**
(String-Vergleich) – eindeutig, ohne Absprache, kein gleichzeitiges Anbieten.

**Wege der Paar-Signale (offer/answer/ice):**

- Paar **direkt gekoppelt** → **nur direkt** über dessen eigenen Kanal. Vom
  Host „weitergeleitete“ Signale für ein gekoppeltes Paar werden verworfen –
  der Host kann solche Paare also nicht manipulieren.
- Paar **nicht gekoppelt** (beide aber mit dem Host) → über den **Host**: der
  Absender schickt an den Host mit `to`, der Host prüft (beide beigetreten,
  Absender = authentifizierter Kanal) und leitet mit `from` = Absender über
  seinen Kanal zum Ziel weiter. Weitergeleitet werden nur `offer`/`answer`/
  `ice`, nie `invite`/`roster`/`end`.
- **Mitglieder leiten nie weiter.** Ein Signal mit fremdem `to` wird bei
  Mitgliedern verworfen. Nie über ein anderes Mitglied, nie über einen Server.

**Später beitreten („late join“):** Wer eingeladen war (abgelehnt, verpasst,
aufgelegt, besetzt), sieht im Gruppenchat „Gruppenanruf läuft – tippen zum
Beitreten“ und schickt `join`. Der Host nimmt jeden eingeladenen Teilnehmer
wieder auf. Der Host kann außerdem „Erneut anrufen“ (bis zu 3×, frühestens
nach 10 s). Das Wissen „Anruf läuft“ liegt nur im Arbeitsspeicher und
verschwindet mit `end`, nach 4 h oder wenn ein Beitritt scheitert.

**Ende:**

- **Host legt auf → Ende für alle** (einfach und vorhersehbar). Kommt `end`
  nicht an, merken die Mitglieder es spätestens, wenn alle ihre Paare
  abreißen (siehe unten).
- Mitglied legt auf → `leave` → Host verteilt neue Liste → die anderen
  schließen ihre Verbindung zu ihm, der Rest telefoniert weiter.
- **Weniger als 2 Personen → Ende:** Bleibt nur der Host übrig (nachdem
  jemand drin war), endet der Anruf („Alle anderen haben aufgelegt“). Hat
  niemand angenommen und klingelt niemand mehr → Ende („Niemand hat …
  angenommen“).
- Zu **keinem** anderen Beigetretenen eine Verbindung → Ende mit Hinweis
  (kein Server-Umweg). Beim Host bedeutet das: Ende für alle.

## Vertrauensmodell

- **Kanal = Identität.** Absender eines Signals ist immer der Kontakt, über
  dessen authentifizierten 1:1-Kanal es kam (Mitglieds-ID aus
  `contact.groupMemberId`, wie `GroupMessaging.senderMidFor` – hier ohne
  „Erstkontakt“-Übernahme: unbekannte IDs zählen nicht).
- **Einladung** nur, wenn Absender = angegebener Host, Absender **und** ich
  Mitglieder **dieser** Gruppe sind (nicht entfernt) und ich in der
  Teilnehmerliste stehe. Teilnehmer, die in meinem Stand der Gruppe fehlen,
  werden ignoriert.
- **Alle weiteren Signale** nur für die angekündigte `callId` und nur von
  direkt gekoppelten Teilnehmern dieses Anrufs; Liste und Ende nur vom Host;
  Antworten der Mitglieder (`join`, `leave`, …) nur beim Host.
- **Der Host bürgt für nicht gekoppelte Paare.** Er sieht deren SDP (inkl.
  DTLS-Fingerabdruck und IP-Kandidaten) und **könnte diese Paare theoretisch
  per Man-in-the-Middle abhören**, indem er eigene Fingerabdrücke einsetzt.
  Das ist akzeptiert: der Host ist selbst Teilnehmer und hört ohnehin alles.
  Gekoppelte Paare kann er nicht angreifen (nur direkt). Gekoppelte Paare
  sehen einander ihre IP-Adressen wie bei 1:1-Anrufen; bei nicht gekoppelten
  Paaren sieht sie zusätzlich der Host.
- **Pro-Regel:** im Manager geprüft (`startGroupCall` → `{error:'pro'}`) und
  in der Oberfläche (Hinweis). Wie alle Pro-Funktionen lokal – ein
  manipulierter Client könnte ohne Lizenz einladen; Empfänger prüfen das
  nicht (können es nicht).

## Grenzen und Prüfungen

- Strikte Eingangsprüfung (`sanitizeGroupCallMessage`): bekannte Typen und
  Felder, Formate (`gc_`+32 Hex, `g_…`, `m_`+32 Hex), 2–8 eindeutige
  Teilnehmer inkl. Host, SDP ≤ 16 KB und beginnt mit `v=0`, Kandidat
  ≤ 1024 Zeichen, `sdpMid` ≤ 64, `sdpMLineIndex` 0–63, Status aus fester
  Liste; unbekannte Felder werden verworfen. Verschlüsseltes Paket ≤ 96 KB,
  Klartext ≤ 48 KB.
- Ratenbegrenzung je Kontakt: 300 Signale / 10 s, 6 Einladungen / Minute;
  je Paar ≤ 128 ICE-Kandidaten (≤ 64 vorgemerkt); Host leitet je Absender
  ≤ 400 Signale weiter.
- Einladungen älter als 2 min (oder > 2 min in der Zukunft) klingeln nicht
  (z.B. spät aus einer Warteschlange zugestellt).
- Zeiten (wie 1:1-Anrufe): Klingeln 30 s; Host wartet 35 s je Mitglied,
  insgesamt 45 s auf den ersten Beitritt; nach dem Annehmen 20 s auf die
  Teilnehmerliste; je Paar 20 s bis zur Verbindung; `disconnected` 6 s
  Gnadenfrist.

## Verbindungsweg „nur Tor“ (Stufe 3)

- Starten: Hinweis, nichts wird gesendet, keine PeerConnection.
- Einladung in Stufe 3: automatisch `decline` mit `tor_only` + Hinweis beim
  Mitglied; der Host sieht „nur Tor – nicht möglich“ und einen Hinweis.
- Wechsel auf Stufe 3 während des Anrufs: sofort auflegen (Hinweis).
- Kein Ausweichen auf „Sprache über den Kanal“ – Gruppen-Audio über Tor wäre
  für 8 Teilnehmer nicht tragbar und bräuchte Weiterleitung von Audio.

## Kein direkter Weg (NAT)

Kommt für ein Paar keine direkte WebRTC-Verbindung zustande (ICE `failed`,
20 s ohne Verbindung, `disconnected` länger als 6 s), gilt **dieses Paar** als
**„nicht erreichbar“** (Kachel). Die anderen Paare laufen weiter. Bewusst
**kein** Ausweichen auf Tor-Kanal-Audio und kein ICE-Neustart (Umfang).

## Nur ein Anruf gleichzeitig

- Gruppenanruf läuft (auch Klingeln) → eingehendes 1:1-Angebot wird in
  `RTCStore` (`callBusyCheck`) sofort als **besetzt** abgelehnt
  (`rejectIncomingCallBusy`, `reject` mit `busy: true`); es klingelt nicht,
  der Anrufer sieht „X telefoniert gerade (besetzt).“
- 1:1-Anruf läuft (`RTCStore.activeCallContactId`) → Einladung wird mit
  `busy` abgelehnt; Starten geht nicht.
- `App.tsx`: ausgehender 1:1-Anruf während eines Gruppenanrufs → Hinweis.
- Audio-Fokus: `AppFocus.claimAudio('group-call', …)` beim Start/Annehmen
  (stoppt laufende Sprachnachrichten), `releaseAudio` am Ende.

## System-Anzeige (Klingeln im Hintergrund)

`CallBridgeModule` (self-managed ConnectionService) wird **unverändert**
wiederverwendet – mit dem **opaken Schlüssel** `gcall_<callId>` statt einer
Kontakt-ID und dem Titel „Gruppenanruf · <Gruppe>“: Mitglieder
`reportIncomingCall` (CallStyle-Benachrichtigung mit Annehmen/Ablehnen, auch
bei gesperrtem Bildschirm), Host und spätes Beitreten `reportOutgoingCall`,
dann `reportCallActive`/`reportCallEnded`. Native Ereignisse
(`nativeCallAnswered` usw.) werden über diesen Schlüssel zugeordnet. Da immer
nur ein Anruf läuft, gibt es keinen Konflikt mit 1:1-Anrufen. Native Seite
nicht geändert (kein Build), am Gerät zu prüfen.

## Keine Spuren

- Keine SDP, Kandidaten, IDs, Namen oder Gruppennamen in Logs – nur feste
  Texte wie `[GCall] Paar verbunden` (per Test geprüft).
- Nichts wird gespeichert (per Test: kein einziger Schreibzugriff auf
  EncryptedStorage während eines kompletten Anrufs). Kein Verlaufseintrag.
- Lokale Mikrofon-Spuren werden beim Auflegen gestoppt, alle Verbindungen
  geschlossen, Lautsprecher zurückgesetzt.

## Oberfläche

- **Gruppenchat:** Telefon-Symbol „Gruppenanruf“ in der Kopfleiste. Ohne
  Vollversion: „Gruppenanrufe starten ist Teil der Vollversion – teilnehmen
  kann jeder.“ Läuft ein Anruf, an dem man nicht teilnimmt: Leiste
  „Gruppenanruf läuft – tippen zum Beitreten“.
- **GroupCallScreen:** Kacheln je Teilnehmer (Profilbild in
  `avatarBg`/`avatarText`, Name, Zustand: wird angerufen/klingelt/verbindet/
  verbunden/stumm/nicht erreichbar/abgelehnt/nicht angenommen/aufgelegt/
  besetzt/nur Tor/nicht gekoppelt, Sprech-Anzeige über `getStats`-Pegel,
  Kennzeichen „Gastgeber“, beim Host „Erneut anrufen“). Stumm,
  Lautsprecher/Hörer (nur wenn `MalachiCallAudio.setSpeaker` vorhanden),
  Auflegen; beim Klingeln Annehmen/Ablehnen. Nur Design-Farben (`P.*`),
  per Test geprüft.
- **App.tsx** (nur Verdrahtung): Bildschirm `groupCall`,
  `useGroupCallRouting` (zeigt den Anruf, auch über der Sperre – danach
  zurück zur Sperre bzw. in den Gruppenchat/vorherigen Bildschirm),
  Zurück-Taste = auflegen, keine Auto-Sperre im Anruf, Sperre gegen
  gleichzeitigen 1:1-Anruf.

## Tests (jest)

`groupCall.mesh.test.js` – vier „Geräte“ mit eigenen Modul-Instanzen, echte
Verschlüsselung der Signale, PeerConnection-Attrappe: Pro-Regel im Manager,
freie Teilnehmer, Vollvermaschung (3 Paare, Opus mono 20 kbit/s, nur STUN),
Anbieter-Regel, Weiterleitung nur über den Host (nicht gekoppelt) bzw. nur
direkt (gekoppelt, Host-Fälschung verworfen), fremde Kontakte/Gruppen/
callIds, Feldprüfung, Ratenbegrenzung, Auflegen/Host-Ende/„nur Host übrig“,
spätes Beitreten + erneut anrufen, Zeitüberschreitungen (Klingeln, Host,
Beitritt), NAT („nicht erreichbar“, kein Kanal-Audio), Stufe 3 (Host,
Mitglied, Wechsel), besetzt in beide Richtungen (echter 1:1-`CallManager`),
Annehmen über die System-Anzeige, keine Spuren in Logs/Speicher.
`groupCall.screens.test.js` – Kachel-Texte, Knopf im Gruppenchat (ohne/mit
Vollversion), Anrufbildschirm (Host, Mitglied), Navigation inkl. Sperre,
Design-Farben, Verdrahtung in App.tsx.

## Gerätetest-Checkliste (3 Geräte: Handy A, Handy B, Emulator C)

Vorbereitung: gleicher Build auf allen drei. **A mit Vollversion**, B und C
ohne. Kopplungen **A–B** und **A–C**, **B–C nicht gekoppelt**. A erstellt die
Gruppe „Test“ mit B und C; alle drei sehen sie. Verbindungsweg überall
„Schnell“. Mikrofon-Berechtigung erteilen. Emulator: Extended Controls →
Microphone → „Virtual microphone uses host audio input“ an. Logs nur über
`adb logcat -s ReactNativeJS` ansehen.

1. **Pro-Regel:** B tippt im Gruppenchat auf das Telefon-Symbol → Hinweis
   „Gruppenanrufe starten ist Teil der Vollversion – teilnehmen kann jeder.“;
   bei A und C klingelt nichts.
2. **Start/Klingeln:** A startet. A: Kacheln B/C „wird angerufen …“ →
   „klingelt …“. B mit **gesperrtem Bildschirm**: System-Anrufbenachrichtigung
   „Gruppenanruf · Test“ mit Annehmen/Ablehnen. C mit offener App:
   Anrufbildschirm „Gruppenanruf von A“.
3. **Annehmen:** B über die Benachrichtigung, C in der App. Alle drei hören
   alle (A „eins“, B „zwei“, C „drei“), Zeit läuft, Kacheln „verbunden“,
   Sprech-Anzeige leuchtet beim Sprechen. **B–C hören sich** (über A
   signalisiert, Audio direkt).
4. **Logs:** nur `[GCall] …`-Zeilen ohne SDP, IP-Adressen, IDs, Namen.
5. **Stumm:** B stumm → A und C sehen bei B „stumm“ und hören B nicht; wieder an.
6. **Lautsprecher/Hörer** auf jedem Gerät umschalten – wechselt der Ton
   wirklich (bei aktiver Telecom-Verbindung)? Optional Bluetooth-Headset.
7. **Mitglied legt auf:** C legt auf → A, B sehen „aufgelegt“, A–B läuft
   weiter. C sieht im Gruppenchat „Gruppenanruf läuft – tippen zum
   Beitreten“ → tippen → wieder drin, alle hören sich.
8. **Ablehnen / Erneut anrufen:** neuer Anruf, C lehnt ab → A sieht
   „abgelehnt“ + „Erneut anrufen“ → C klingelt erneut → annehmen.
9. **Host legt auf:** B und C: Hinweis „A hat den Gruppenanruf beendet.“,
   zurück im Gruppenchat; das Mikrofon-Symbol von Android erlischt auf allen.
10. **Nur Host übrig:** A, B, C im Anruf; B und C legen auf → A: „Alle anderen
    haben aufgelegt …“.
11. **Niemand nimmt an:** A startet, B und C reagieren 30 s nicht → Klingeln
    endet, A: „Niemand hat den Gruppenanruf angenommen.“
12. **Besetzt** (dafür jetzt B–C koppeln): Gruppenanruf A+B läuft (C lehnt
    ab), C ruft B 1:1 an → bei B klingelt nichts, C sieht „B telefoniert
    gerade (besetzt).“ Umgekehrt: B telefoniert 1:1 mit C, A startet den
    Gruppenanruf → B und C lehnen automatisch ab, A sieht bei beiden
    „besetzt“, danach „Niemand hat … angenommen“. Während eines
    Gruppenanrufs bei A auf den 1:1-Anruf-Knopf → Hinweis „Es läuft schon
    ein Anruf …“.
13. **Gekoppeltes Paar:** B–C jetzt gekoppelt → neuer Gruppenanruf, B–C
    hören sich wie zuvor (jetzt direkt signalisiert).
14. **Nur Tor:** C stellt „Maximal anonym (nur Tor)“ ein → A startet → C
    lehnt automatisch ab (Hinweis bei C), A sieht „nur Tor – nicht möglich“
    + Hinweis. A in Stufe 3 → Start nur mit Hinweis. Laufender Anruf, B
    wechselt auf Stufe 3 → B fliegt mit Hinweis raus, A/C sehen „aufgelegt“.
15. **NAT:** B im Mobilfunk (WLAN aus), A und C im WLAN: Paare, die nicht
    direkt zusammenkommen, zeigen nach ≤ 20 s „nicht erreichbar“, die anderen
    laufen weiter, kein Ausweichen auf Tor. Kommt ein Gerät zu niemandem
    durch: Hinweis + Ende. (Der Emulator hängt hinter der NAT des Rechners –
    gut geeignet, „nicht erreichbar“ zu sehen.)
16. **Hintergrund/Sperre:** 5 min telefonieren, alle Bildschirme aus → Anruf
    hält; die App-Sperre (PIN) kommt erst nach dem Auflegen. Zurück-Taste
    auf dem Anrufbildschirm legt auf.
17. **Kaltstart:** B wischt Malachi aus „Zuletzt verwendet“, A ruft an → B
    klingelt nativ → Annehmen öffnet die App direkt im Anrufbildschirm
    (über der Sperre), nach dem Auflegen kommt die Sperre.
18. **Dauer/Akku:** 15 min zu dritt, Akku und Wärme beobachten (8 Teilnehmer
    = 7 Kodierungen je Gerät – mit 3 Geräten nicht prüfbar, siehe offene
    Punkte).
19. **Keine Spuren:** nach dem Anruf kein Eintrag im Gruppen- oder 1:1-
    Verlauf, keine „Neue Nachricht“-Benachrichtigung.

## Offene Punkte

- **Lautsprecher:** `MalachiCallAudio.setSpeaker` setzt
  `AudioManager.isSpeakerphoneOn`. Bei aktiver self-managed Telecom-Verbindung
  kann Android das überstimmen; dann bräuchte es `Connection.setAudioRoute`
  (nativ, hier bewusst nicht geändert).
- **Native Anzeige** mit opakem Schlüssel ist ungeprüft am Gerät (Telecom
  akzeptiert `tel:gcall_…` wie die bisherigen Kontakt-IDs vermutlich).
- **Kein ICE-Neustart:** ein gescheitertes Paar bleibt „nicht erreichbar“;
  ein Netzwechsel (WLAN ↔ Mobilfunk) länger als 6 s kostet die Paare des
  wechselnden Geräts. Wiederbeitreten geht über „tippen zum Beitreten“.
- **Host als Dreh- und Angelpunkt:** kein Host-Wechsel; Mitglieder ohne
  Kopplung zum Host können nicht teilnehmen; der Host sieht das SDP nicht
  gekoppelter Paare (siehe Vertrauensmodell).
- **Asymmetrische Kopplung** (eine Seite hat den Kontakt gelöscht): die eine
  Seite signalisiert direkt, die andere über den Host → dieses Paar bleibt
  „nicht erreichbar“.
- **8 Teilnehmer** (7 Verbindungen je Gerät) nur mit mehr Geräten testbar –
  CPU/Akku auf älteren Geräten offen.
- **Ältere App-Versionen** und die Web-App kennen `gcall_signal` nicht: sie
  klingeln nicht, der Host sieht „nicht angenommen“.
- Kein Verlaufseintrag/keine Benachrichtigung für verpasste Gruppenanrufe
  (bewusst: keine Speicherung von Anrufdaten).
- Pro-Regel ist (wie alle Pro-Funktionen) nur lokal durchgesetzt.
