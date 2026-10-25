# Gruppenchats – Design (umgesetzt)

Stand: 2026-10-18 · Dateien: `GroupMessaging.js` (Protokoll, Speicher),
`GroupChatScreen.tsx` (Chat), `GroupScreens.tsx` (Liste, „Neue Gruppe“,
Gruppeninfo), Anbindung in `RTCStore.js`, `BackgroundSync.js`, `App.tsx` ·
Tests: `__tests__/security/groups.fanout.test.js`, `groups.screens.test.js`

Dieses Dokument beschreibt, was **tatsächlich gebaut** ist. Die Analyse in
`GROUP_CHAT_CRYPTO_PLAN.md` bleibt als Hintergrund gültig (Option A: paarweises
Fan-out), ihre Infrastruktur-Teile (relay.js, `/packet`, TURN,
`FORCE_RELAY_ONLY`) sind aber überholt – es gibt keinen Server mehr.

## Leitprinzipien

1. **Kein Server, kein Relay, keine Weiterleitung.** Eine Gruppe ist nur eine
   lokale Überlagerung der bestehenden 1:1-Verbindungen (Tor, dann direkt per
   WebRTC). Jede Gruppen-Nachricht geht **einzeln** an jedes Mitglied, mit dem
   dieses Gerät **direkt gekoppelt** ist. Andere Mitglieder leiten nichts weiter.
2. **Keine neue Kryptografie.** Kein Gruppenschlüssel, keine Gruppen-Ratchet.
   Jede Kopie ist mit der Verbindung zum jeweiligen Mitglied geschützt (ML-KEM-
   Schlüsseltausch pro Verbindung, Double Ratchet, dreifache Verschlüsselung).
   Wer aus der Gruppe entfernt wird, bekommt einfach keine Kopien mehr –
   Schlüsselrotation ist nicht nötig.
3. **Zustell-Garantie wie im 1:1-Chat.** Alles läuft über die write-ahead-
   Sende-Warteschlange (`sendViaOutbox` → `queueOffline` → `flushQueue`): erst
   verschlüsselt einreihen, dann senden, entfernen erst nach
   Empfangsbestätigung, Wiederholung bei jeder neuen Verbindung. Offline-
   Mitglieder bekommen alles beim nächsten Verbindungsaufbau.
4. **Zero Trace.** Alles Persistente liegt in EncryptedStorage; keine Inhalte,
   Gruppennamen oder Beschreibungen in Logs (per Test geprüft). Verlassen bzw.
   lokales Löschen entfernt Verlauf und noch nicht zugestellte eigene Texte.

## Mitglieds-Identität über Geräte hinweg

Lokale Kontakt-IDs (`c_…`) gibt es nur auf dem jeweiligen Gerät – Bob heißt bei
Alice anders als bei Carol. Deshalb:

- Jedes Gerät erzeugt einmalig eine **zufällige Mitglieds-ID** `m_` + 32 Hex
  (16 Byte aus `KyberModule.randomBytes`), gespeichert unter `group_self_id`.
- Sie wird jedem Kontakt bei **jedem Schlüsseltausch** über den bereits
  verschlüsselten 1:1-Kanal mitgeteilt (`{type:'system', subtype:'group_id',
  gid}`, `RTCStore._onKeyExchange`, direkt nach `tor_address`). Der Empfänger
  speichert sie am Kontakt (`contact.groupMemberId`).
- Gruppen-Metadaten referenzieren Mitglieder **nur** über diese IDs. Bewusst
  **nicht** über Onion-Adressen (die dürfen laut TorTransport nur zwischen
  gekoppelten Kontakten ausgetauscht werden und würden nicht gekoppelten
  Mitgliedern eine Kontaktmöglichkeit verraten) und nie mit Schlüsselmaterial.
  Die ID ist kein Geheimnis und keine Fähigkeit.
- Jede Gruppen-Nachricht trägt zusätzlich `fromMid`. Fehlt am Kontakt noch eine
  ID (Reihenfolge `group_id`/Warteschlange), gilt sie als Erstkontakt-Wert;
  widerspricht sie einer gespeicherten ID, wird die Nachricht verworfen.
- Regeln: erste ID pro Kontakt gilt; eine ID gehört höchstens **einem** Kontakt
  und nie mir selbst (sonst verworfen und gewarnt).
- **Absender** einer Gruppen-Nachricht ist immer der Kontakt, über dessen
  authentifizierten Kanal sie kam. Eine Absender-Behauptung im Inhalt zählt nie.

Grenze (ohne Signatur-Primitive nicht lösbar): Ein **manipulierter** Client
eines Kontakts könnte bei der allerersten Verbindung die Mitglieds-ID eines
Dritten beanspruchen, den der Empfänger noch nicht kennt, und sich in
gemeinsamen Gruppen als dieser ausgeben. Die Eindeutigkeitsregel verhindert
das, sobald der echte Dritte zuerst bekannt ist. Gleiche Vertrauensgrenze wie
bei allen Steuersignalen der App (Plan §4).

## Datenmodell (EncryptedStorage)

| Schlüssel | Inhalt |
|---|---|
| `group_self_id` | eigene Mitglieds-ID |
| `contacts[].groupMemberId` | Mitglieds-ID des Kontakts |
| `groups` | Liste, serialisiert über `BackgroundSync.updateGroups` |
| `gchat_<groupId>` | Verlauf (max. 3000 Einträge) |
| `groups_left` | Grabsteine verlassener/gelöschter Gruppen `{groupId: ts}` (max. 200, 180 Tage) |
| `groups_pending` | noch nicht zuordenbare Texte (max. 50 pro Gruppe, 10 Gruppen, 7 Tage) |
| `queue_<contactId>` | Warteschlangen-Index; Gruppen-Einträge tragen `groupId` (nur Index, Inhalt verschlüsselt) |

Gruppen-Eintrag (`v: 1`): `groupId, name, description, avatarUri (nur lokal),
members [{mid, name}] (inkl. mir), admins [mid], createdBy, createdAt, rev,
updatedAt, removed, leftMembers {mid: ts}, unread, last, lastTime` plus
abgeleitet `selfMid, amAdmin, memberContactIds` (Kontakt-IDs der direkt
gekoppelten Mitglieder – nur Anzeige; gesendet wird immer frisch aufgelöst).
Phase-0-Einträge (nur lokal, ohne `v`) werden beim ersten Laden umgestellt und
verteilt (`loadGroups`).

Verlaufs-Eintrag: `{id, from (mid|'sys'), mine, text, time, sys?,
fromContactId?, recipients? {mid: 'sending'|'queued'|'delivered'|'failed'},
status?}`. Dedup nach `from + id`.

## Protokoll

Alle Nachrichten sind 1:1-Steuersignale (`type:'system'`), Warteschlangen-Typ
`'system'`, Zustell-Schlüssel (`ackId`) mit Präfix `grp|`:

| subtype | Felder | ackId |
|---|---|---|
| `group_state` | `groupId, name, description, members, admins, createdBy, createdAt, rev, ts, change {kind, by}, fromMid` | `grp\|s\|<groupId>\|<rev>` |
| `group_leave` | `groupId, ts, fromMid` | `grp\|l\|<groupId>\|<ts>` |
| `group_text` | `groupId, msgId, text, time, fromMid` | `grp\|t\|<groupId>\|<msgId>` |

- **Voller Stand statt Einzeländerungen.** Jede Admin-Änderung (Erstellen,
  Hinzufügen, Entfernen, Umbenennen, Austritt des Admins) erhöht `rev` und
  verteilt den kompletten Stand an alle Mitglieder (beim Entfernen auch an den
  Entfernten). `change.kind` (`create|add|remove|rename|leave`) dient nur der
  Hinweistext-Formulierung; die Hinweise im Verlauf entstehen aus dem Vergleich
  alt/neu.
- **Annahme eines Stands:** unbekannte Gruppe → nur als Einladung, wenn der
  Absender selbst Admin und Mitglied ist und ich in `members` stehe. Bekannte
  Gruppe → nur vom Admin laut **meinem** Stand und nur mit höherem `rev`.
- **Austritt:** Nicht-Admins senden `group_leave` an alle direkt gekoppelten
  Mitglieder; jeder entfernt sie lokal und merkt `leftMembers[mid] = ts`
  (ein älterer Stand trägt sie so nicht wieder ein). Der Admin verteilt darauf
  den verbindlichen neuen Stand (`rev+1`). Der letzte Admin übergibt die Rolle
  in seinem letzten Stand an das nächste Mitglied; fehlt ein Admin trotzdem,
  wählen alle Geräte deterministisch `members[0]`.
- **Validierung:** Gruppen-ID `g_` + 16–64 Hex, Mitglieds-IDs `m_` + 32 Hex,
  höchstens 8 Mitglieder, Name ≤ 80, Beschreibung ≤ 500, Text ≤ 4000 Zeichen,
  Steuerzeichen entfernt, `rev` ganzzahlig, `time` höchstens 5 min in der
  Zukunft. Ungültiges wird verworfen (aber bestätigt – keine Endlosschleife).
- Kein Frische-Fenster wie bei 1:1-`text` (Gruppen-Texte können Tage in der
  Warteschlange liegen); Replays scheitern an Verbindungsschlüssel/Ratchet und
  an der Dedup (persistente `rx_seen_<contactId>` + Verlaufs-Dedup).

## Empfangsweg

`WebRTCManager` entschlüsselt → `RTCStore._onIncoming` (Dedup nach `ackId`) →
`RTCStore._route`: Gruppen-Subtypen gehen **immer** an
`GroupMessaging.handleGroupMessage` – nie an den 1:1-Chat oder dessen Puffer,
auch wenn der 1:1-Chat des Kontakts offen ist. Alle Gruppen-Eingänge laufen
nacheinander (eine Kette), die Bestätigung geht erst raus, wenn der Eintrag
gespeichert ist. Das funktioniert identisch in der App und im Headless-Task
(BackgroundSync lädt GroupMessaging und verdrahtet es; `index.js` lädt
BackgroundSync).

- Gruppe offen (`subscribeGroupChat`): Listener bekommt den neuen Verlauf,
  Ungelesen bleibt 0. Geschlossen: `unread + 1`, `last = "Name: Text"`,
  Benachrichtigung über `global.showMalachiNotification(contactId)`.
- Text für unbekannte Gruppe bzw. von (noch) nicht eingetragenem Mitglied →
  `groups_pending`; wird beim nächsten angenommenen Stand der Gruppe erneut
  geprüft (z. B. Carols Nachricht kam vor Alices Einladung an). Gruppe
  verlassen (Grabstein) bzw. aus Gruppe entfernt → verworfen.
- Empfangsbestätigungen (`receipt` mit `grp|…`) gehen über
  `BackgroundSync.onQueueReceipt` → `GroupMessaging.onGroupReceipt` und setzen
  den Empfänger im eigenen Verlaufseintrag auf `delivered`; sie landen nicht im
  1:1-Chat.

## Zustellstatus im Gruppenchat

Pro eigener Nachricht über alle **erreichbaren** Mitglieder: ⏳ wird
eingereiht · ✓ bei allen verschlüsselt eingereiht (`queued`) · ✓✓ von allen
bestätigt · dazwischen „x/n“ · ❌ bei mindestens einem nicht einreihbar · – kein
Mitglied direkt erreichbar. Langes Drücken zeigt die Zustellung pro Mitglied
und wer sie mangels Kopplung nicht bekommt.

## Nicht direkt gekoppelte Mitglieder (bewusste Grenze)

Ohne Server und ohne Weiterleitung erreicht ein Absender nur Mitglieder, mit
denen er selbst gekoppelt ist. Ist Bob mit Carol nicht gekoppelt, sehen beide
die Nachrichten des jeweils anderen **nicht** (Alices Nachrichten sehen beide).
Die UI sagt das deutlich: Banner im Gruppenchat und in der Gruppeninfo
„Nicht direkt verbunden: Carol – bitte zuerst koppeln“, Markierung in der
Mitgliederliste, Hinweis beim Erstellen. Ebenso: Nach einer Admin-Übergabe
erreichen Stand-Änderungen des neuen Admins nur die Mitglieder, mit denen er
gekoppelt ist.

## Rechte (weich, ohne Signatur)

- Nur Admins ändern Mitglieder, Name und Beschreibung (abweichend vom Plan §5,
  der „jedes Mitglied“ vorschlug: die bisherige UI war schon Admin-only, und ein
  einzelner Schreiber vermeidet Konflikte; das Feld `change.by` erlaubt eine
  spätere Lockerung ohne Formatänderung).
- v1: der Ersteller ist der einzige Admin; Admin-Übergabe nur beim Austritt.
- Austreten ist immer erlaubt. „Für alle löschen“ gibt es nicht; lokal löschen
  geht (nach Entfernung bzw. durch Austritt).
- Durchsetzung ist clientseitig (wie bei allen Steuersignalen): ein Gerät nimmt
  Stände nur vom Admin laut eigenem Stand an. Ein manipulierter Client kann nur
  seine eigene Sicht verfälschen.

## Bewusst (noch) nicht umgesetzt

- **Bilder/Sprachnachrichten/Dateien in Gruppen.** Die Medien-Pipeline
  (`ImageCrypto`/`AudioCrypto`/`FileCrypto` → `img_end` → `RTCStore._assemble`)
  trägt keine Gruppen-Zuordnung; zusammengesetzte Medien würden im 1:1-Chat
  landen. Nächster Schritt: `groupId` im (Ratchet-geschützten) End-Marker
  mitgeben, in `_assemble` durchreichen und in `_route` wie Gruppen-Texte
  verteilen; Speicherung als Datei statt im JSON-Verlauf. Bis dahin: nur Text.
- Gruppenbild-Verteilung (das Gruppenbild ist lokal pro Gerät).
- Mehrere Admins/Admin ernennen, Abstimmungs-Löschung (Plan §4), Lesebestätigungen,
  Gruppenanrufe, zeitversetztes Fan-out gegen Zeitkorrelation (Plan §2).
- Ältere Gegenstellen ohne Empfangsbestätigung (`caps` ≠ `new`): Steuersignale
  gelten dort nach einer Übergabe als erledigt – der Gruppenstatus bleibt dann
  bei ✓. Beide Testgeräte laufen mit derselben Version, daher ohne Belang.

## Auf echten Geräten zu prüfen

Siehe Abschlussbericht des Agenten; Kurzfassung: Mitglieds-ID-Austausch nach
dem Update, Gruppe mit 2 Geräten erstellen, Texte in beide Richtungen bei
offenem/geschlossenem Chat und im Hintergrund, Offline-Zustellung,
Umbenennen, Entfernen/Wieder-Hinzufügen, Austreten, Neustart.

## Vorstellen ueber die Gruppe und Kanal (2026-10-25)

Ausfuehrlich im Kopfkommentar von `GroupMessaging.js` (Abschnitt "Vorstellen")
und in `GroupIntroPairing.js`; Sicherheitsbewertung in
`SECURITY_AUDIT_2026-10-25.md` (F5/F6).

- **Vorstellen** (`group_intro`, nur Art "Gruppe", nur wenn der Admin
  `intros: true` anbietet): Mitglieder ohne direkte Kopplung koennen sich ueber
  den Admin verbinden. Beide muessen zustimmen; vorher oeffnet sich nichts.
  Ablehnen ist still. Die kleinere Mitglieds-ID laedt ein: Einmal-Einladung wie
  beim QR-Code (Token, Geheimnis, Onion-Adresse), bis 3 Tage gueltig, reist
  verschluesselt ueber die beiden 1:1-Kanaele mit dem Admin; danach koppeln
  sich die beiden direkt ueber Tor. Neuer Kontakt mit "vorgestellt von ...",
  Sicherheitscode-Vergleich empfohlen.
- **Kanal** (`mode: 'channel'`, bis 250 Abonnenten): nur Admins schreiben;
  jeder Abonnent bekommt einen eigenen Stand (Admins + er selbst, `memberCount`),
  sieht die anderen also nie; kein Vorstellen; Austritte gehen nur an den Admin;
  verlaesst der letzte Admin den Kanal, wird er geschlossen (`change.kind: close`).
- Beide Felder (`mode`, `intros`) sind optional - aeltere Versionen ignorieren
  sie und die neue Nachricht `group_intro`.
