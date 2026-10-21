# Double Ratchet mit Post-Quanten-Schritt – Entwurf und Begründung

Stand: Oktober 2026 · Dateien: `DoubleRatchet.js` (Algorithmus), `RatchetSession.js`
(Zustand pro Kontakt), `MediaKey.js` (Dateischlüssel), Einbindung in
`WebRTCManager.js`, `RTCStore.js`, `BackgroundSync.js`, `ImageCrypto.js`,
`AudioCrypto.js`, `FileCrypto.js`. Tests: `__tests__/security/ratchet.*.test.js`.

## 1. Ziel

Bisher verschlüsselte jede Verbindung (direkt oder Tor) alle Nachrichten mit
**einem** ML-KEM-768-Geheimnis, das zudem dauerhaft gespeichert wurde
(`shared_secret_<id>`, Tor-Anmeldung) und in der Sende-Warteschlange neben jedem
Eintrag stand (`secretUsed`). Wer dieses Geheimnis später erbeutet, konnte
mitgeschnittenen Verkehr dieser Verbindung nachträglich lesen.

Jetzt gilt für jeden Kontakt mit neuer App-Version:

* **Forward Secrecy pro Nachricht** – jede Nachricht hat einen eigenen Schlüssel,
  der nach Gebrauch gelöscht wird.
* **Post-Compromise Security** – wurde der Zustand eines Geräts kopiert, heilt
  sich die Sitzung mit dem nächsten Sprecherwechsel (frische X25519-Schlüssel).
* **Post-Quanten-Schritt** – jedes neue ML-KEM-Geheimnis einer Verbindung fließt
  in den Root Key; ein Angreifer, der X25519 bricht (Quantencomputer), kommt ohne
  das KEM-Geheimnis nicht weiter.

## 2. Aufbau

```
Nachricht (Objekt)
  └─ innen:  Double Ratchet  (pro Kontakt, persistent; XChaCha20-Poly1305,
  │          eigener Nachrichtenschlüssel, Header als associated data,
  │          Inhalt auf 64 Byte gepolstert)
  └─ außen:  Verbindungsschicht wie bisher (AES-256-GCM → ChaCha20-Poly1305 →
             XSalsa20-Poly1305 mit dem ML-KEM-Geheimnis DIESER Verbindung,
             padToBlock auf 1024 Byte bei Ratchet-Kontakten, sonst 512)
```

* **Ein Zustand pro Kontakt**, unabhängig vom Transport: direkte Verbindung,
  Tor-Reserve und Tor nutzen denselben (`ratchet_<kontaktId>` in EncryptedStorage).
* **Nie durch den Ratchet**, nur Verbindungsschicht: Füllpakete (`dummy`),
  Sprachpakete eines Anrufs (`call_audio`, viele pro Sekunde) und Medien-Chunks
  (eigener Dateischlüssel, §7). Alles andere – Text, Steuersignale (`clear_chat`,
  `delete_chat`, `secret_*`, `device_wiped` …), Bestätigungen, Profil,
  Onion-Adresse, `direct_*`, Anruf-Signale – läuft durch den Ratchet.
* Zentrale Stelle: `sealForConnection(rtc, obj)` (Senden) und
  `WebRTCManager._openRatchetLayer()` (Empfang inkl. Downgrade-Schutz).

### Warum keine Header-Verschlüsselung im Ratchet?

Signal beschreibt eine Variante mit verschlüsseltem Header (Abschnitt 4). Hier
liegt der Ratchet-Header (X25519-Public-Key, Zähler, KEM-Kennungen) **innerhalb**
der Verbindungsschicht, deren Schlüssel ein frisches ML-KEM-Geheimnis ist. Ein
Netzbeobachter – auch einer, der DTLS/Tor später mit einem Quantencomputer
bricht – sieht den Header also nicht; über Tor kommt Tors eigene Verschlüsselung
hinzu. Sehen kann ihn nur, wer das Verbindungsgeheimnis hat, also faktisch das
Gerät kompromittiert hat. Die HE-Variante hätte dafür Versuchs-Entschlüsselung
mit mehreren Header-Schlüsseln und deutlich komplexere Verwaltung übersprungener
Schlüssel gekostet – mehr Fehlerfläche ohne Gewinn gegen das reale Modell.

## 3. Schlüsselableitungen

Alle Primitive stammen aus geprüften Bibliotheken (`@noble/curves` 2.4.0 für
X25519, `@noble/hashes`, `@noble/ciphers`). Nichts ist selbst gebaut.

| Name | Ableitung |
|---|---|
| `K` | ML-KEM-768-Geheimnis der Verbindung, auf der die Sitzung entsteht |
| `kid(K)` | `HKDF-SHA256(ikm=K, salt="malachi-dr-v1-init", info="malachi-kem-id-v1", 16)` – Kennung, gibt nichts über `K` preis |
| `SK` | `HKDF(K, salt, info="malachi-dr-v1-sk", 32)` – Start-Root-Key |
| `AD_s` | `HKDF(K, salt, info="malachi-dr-v1-ad", 32)` – Sitzungsbindung |
| Bob-Init-DH | `HKDF(K, salt, info="malachi-dr-v1-bob-dh", 32)` als X25519-Privatschlüssel (Ersatz für Bobs Signed Prekey) |
| `KDF_RK(rk, dh, kems)` | `HKDF-SHA256(ikm = dh ‖ kem₁ ‖ … ‖ kemₙ, salt = rk, info="malachi-dr-v1-rk", 64)` → (rk', ck) |
| `KDF_CK(ck)` | `mk = HMAC-SHA256(ck, 0x01)`, `ck' = HMAC-SHA256(ck, 0x02)` (Spezifikation 5.2) |
| `ENCRYPT(mk, pt, h)` | `key = HKDF(mk, salt=0³², info="malachi-dr-v1-msg", 32)`, Nonce = 24 Zufallsbytes, XChaCha20-Poly1305, `AD = "malachi-dr-v1" ‖ AD_s ‖ JSON([v, d, pn, n, k, i])` |
| Medien | Dateischlüssel 32 Zufallsbytes, XChaCha20-Poly1305, Nonce = Chunk-Index, `AD = "malachi-media-v1|art|id|index|gesamt|länge"` |

**Zufällige Nonce trotz Einmal-Schlüssel:** Die Spezifikation erlaubt eine
abgeleitete IV. Würde ein Zustand aber je doppelt benutzt (z. B. Speicher
zurückgesetzt), entstünde mit fester Nonce eine Schlüsselstrom-Wiederholung –
mit zufälliger Nonce nicht.

**Vereinfachung auf eine AEAD im Ratchet:** Alle drei Schichten der alten
Konstruktion hingen am selben Nachrichtenschlüssel; Schichtung bringt dort keine
Unabhängigkeit, und `XSalsa20-Poly1305` kennt keine associated data. Die
Kaskade (Algorithmen-Vielfalt) bleibt außen in der Verbindungsschicht erhalten.

## 4. Ablauf

### Aktivierung und Rollen
1. Beide Seiten melden im `profile_name` `caps: { ack: 1, ratchet: 1 }`. Die
   Fähigkeit wird pro Kontakt gespeichert und ist **klebrig** (ein späteres Paket
   ohne Angabe nimmt sie nicht zurück).
2. Die Seite mit Kontakt-Rolle `initiator` (Einladende, „Alice“) baut mit ihrer
   nächsten Nachricht die Sitzung auf – aus dem Geheimnis der Verbindung, über
   die sie gerade sendet. Bis zur ersten Antwort trägt jeder Header `i = kid(K)`.
3. Die andere Seite („Bob“) entsteht beim Empfang dieser Nachricht: `K` wird über
   `kid` gesucht (KEM-Vorrat, Geheimnis der Ankunftsverbindung, aktuelles/
   vorheriges Kontakt-Secret). Bob ist damit sofort **aktiv**; Alice wird es mit
   der ersten Ratchet-Antwort.
4. **Gleichzeitiger Aufbau** (Rollen passen nicht, beide `initiator`): Eine Seite,
   deren Sitzung noch nie eine Antwort bekam und eine Nachricht mit `i` erhält,
   vergleicht `kid‖Init-DH-Key` beider Seiten; die kleinere gewinnt auf beiden
   Geräten gleich. Der Verlierer wird Bob. Verlorene Nachrichten holt die
   Warteschlange nach.
5. Eine **bestätigte** Sitzung nimmt keinen Neuaufbau an (`foreign-init`) – sonst
   könnte, wer ein Verbindungsgeheimnis erbeutet, die Sitzung auf eine eigene
   umstellen und z. B. die Warteschlange mitlesen.

### DH-Ratchet (Spezifikation 3.5)
Unverändert nach Signal: bei jedem neuen Ratchet-Key der Gegenseite
`(rk, CKr) = KDF_RK(rk, DH(DHs, DHr), KEMs der Gegenseite)`, neues eigenes Paar,
`(rk, CKs) = KDF_RK(rk, DH(DHs', DHr), eigene KEMs)`. Übersprungene Schlüssel:
höchstens 1000 pro Nachricht und 1000 insgesamt (älteste fallen weg), Ablauf
nach 72 h. Nachrichten abgelöster Ketten ohne gespeicherten Schlüssel werden sofort
als Replay abgelehnt. Jede fehlerhafte Nachricht wird auf einer Kopie verarbeitet
und verworfen – der gespeicherte Zustand bleibt unverändert.

### Post-Quanten-Schritt (KEM-Ratchet)
* Jeder Verbindungs-Schlüsseltausch trägt sein Geheimnis in den **KEM-Vorrat**
  des Kontakts ein: die kapselnde Seite (Responder) unter `held`, die
  entkapselnde (Initiator der Verbindung) unter `own`.
* **Nur die entkapselnde Seite mischt.** Sie weiß sicher, dass die Gegenseite das
  Geheimnis hat – diese hat es eingetragen, bevor der Ciphertext rausging. Beim
  nächsten eigenen DH-Schritt fließen bis zu 4 eigene Geheimnisse (jünger als
  7 Tage, nach Entstehen der eigenen Sitzung entkapselt) in `KDF_RK`; ihre
  Kennungen stehen im authentifizierten Header (`k`) jeder Nachricht dieser Kette.
* Die Gegenseite rechnet mit `held` nach (Rückfall: bekannte Verbindungs-
  geheimnisse) und entfernt verbrauchte Einträge. Ohne passendes Geheimnis wird
  die Nachricht abgelehnt (kein stilles Weglassen = kein PQ-Downgrade).
* Reihenfolge-Garantie: WebRTCManager reiht den `held`-Eintrag in die
  Ratchet-Sperre ein, **bevor** der Ciphertext gesendet wird. Jede Nachricht, die
  sich darauf bezieht, entsteht erst nach dem Ciphertext und wird in derselben
  Sperre erst danach geöffnet. Speicherfehler sind (wie beim Secret selbst)
  nicht fatal: der Eintrag bleibt im Arbeitsspeicher und wird mit dem nächsten
  Ratchet-Speichervorgang geschrieben.
* Vorbild: PQXDH (Hybrid-KDF über DH ‖ KEM) und Signals Triple Ratchet/SPQR
  (laufender PQ-Beitrag). Anders als SPQR transportiert Malachi keine eigenen
  ML-KEM-Schlüssel im Ratchet-Header – die Verbindungs-Schlüsseltausche liefern
  ohnehin regelmäßig frische KEM-Geheimnisse (jede Tor-/Direktverbindung).

## 5. Speicher, Sperre, Atomizität

* Ein Eintrag `ratchet_<id>` = `{ v, s (Zustand|null), cap, held[], own[] }`.
  Jede Operation (Senden, Empfangen, KEM eintragen, Fähigkeit merken) läuft unter
  einer Sperre pro Kontakt auf einer Kopie und wird erst nach erfolgreichem
  `setItem` gültig. Senden ist **write-ahead**: der fortgeschrittene Zustand ist
  gespeichert, bevor die Nachricht den Kanal verlässt (kein doppelter
  Nachrichtenschlüssel nach einem Absturz).
* Unlesbarer Eintrag → Ratchet für den Kontakt **gesperrt** (Senden/Empfangen
  schlagen fehl, Altverfahren bleibt abgelehnt) statt still zurück auf das alte
  Verfahren. Wiederherstellung: `resetSession()` auf beiden Geräten oder neu
  koppeln.
* Löschen erhöht einen Generationszähler: auch eine bereits angeforderte
  Operation speichert danach nichts mehr bzw. entfernt ihr Ergebnis sofort wieder.

## 6. Warteschlange (Outbox)

* Eine Nachricht wird erst beim **tatsächlichen Senden** ratchet-verschlüsselt
  (`sendQueueItem` → `sealForConnection`); jede Wiederholung bekommt einen neuen
  Nachrichtenschlüssel. Der Empfänger dedupliziert weiter nach `msgId`/`ackId`.
* Im Ruhezustand liegt jeder Eintrag mit einem **zufälligen lokalen Schlüssel pro
  Eintrag** verschlüsselt (`k` im Index in EncryptedStorage, Zweck `queue`) – wie
  die Empfangs-Ablage. Das Verbindungs-Secret steht nicht mehr im Index.
* Eindeutiger Dateiname pro Eintrag (ein doppelter Aufruf überschreibt die Datei
  eines bestehenden Eintrags nicht mehr).

## 7. Medien

Pro Medium und Sendeversuch ein frischer Dateischlüssel; jeder 64-KB-Chunk wird
damit verschlüsselt (Index als Nonce, Art/ID/Index/Gesamtzahl/Länge als AD) und
nur mit der Verbindungsschicht gesendet (`fk: 1`). Der End-Marker (`*_end`) trägt
Schlüssel, Gesamtzahl, Typ und `msgId` und geht **durch den Ratchet**. Der
Empfänger puffert die Chunks verschlüsselt und setzt erst mit dem End-Marker
zusammen; jeder Chunk muss sich öffnen lassen, sonst wird das Medium verworfen
(keine Bestätigung → die Warteschlange sendet neu). Profilbilder genauso.

## 8. Kompatibilität und Downgrade-Schutz

* Ohne `ratchet` in den Fähigkeiten der Gegenseite: bisheriges Verfahren
  unverändert (inkl. 512-Byte-Block, Medien-Chunks mit Verbindungs-Secret).
* Versionsfeld: `{ type: 'ratchet', v: 1, h, c }`; unbekannte Versionen werden
  abgelehnt.
* Sobald die Gegenseite nachweislich per Ratchet gesendet hat (`active`,
  gespeichert), werden Nachrichten **ohne** Ratchet abgelehnt – außer Füll- und
  Sprachpaketen und dateischlüssel-verschlüsselten Chunks (deren Schlüssel nur im
  Ratchet kommt). Einmal aktiv, bleibt es dabei (auch nach Neustart).
* Senden: besteht eine Sitzung, wird nie auf das alte Verfahren ausgewichen;
  scheitert der Ratchet, bleibt die Nachricht zurückgehalten.
* Hauptschalter `RATCHET_ENABLED` (RatchetSession.js): `false` verhindert nur
  NEUE Sitzungen; bestehende laufen weiter (alles andere wäre ein Downgrade).

## 9. Tor-Anmeldung

Die HMAC-Anmeldung (TorTransport.js) bleibt unverändert bei den
Verbindungsgeheimnissen (aktuell + vorheriges, Kandidaten-Logik). Begründung: Der
Anmeldeschlüssel muss auf beiden Geräten zum selben Zeitpunkt gleich sein; der
Ratchet-Zustand schreitet dagegen asynchron fort (Nachrichten unterwegs,
verlorene Nachrichten) – eine Kopplung daran würde Aussperrungen erzeugen. Die
Verbindungsgeheimnisse werden ohnehin bei jeder Verbindung per ML-KEM erneuert.
Der Inhalt hängt nicht mehr an ihnen: wer ein Verbindungsgeheimnis erbeutet und
sich damit anmeldet, bekommt nur Ratchet-Chiffrate, die er nicht lesen kann.

## 10. Löschen, Wipe, Secret Chat

* Kontakt löschen / `device_wiped` empfangen (`removeContactLocally`,
  `wipeContactLocally` → `RTCStore.dropPersistedContactData`): Ratchet-Zustand,
  KEM-Vorrat und übersprungene Schlüssel werden gelöscht.
* Wipe/Duress (`RTCStore.resetAll` + `EncryptedStorage.clear`): Arbeitsspeicher
  verworfen, laufende Operationen schreiben nichts zurück. `device_wiped` an
  offene Verbindungen geht über `sendMessageAndWait` (also durch den Ratchet).
* Secret Chat: Nachrichtenschlüssel werden wie immer nach Gebrauch gelöscht; beim
  Ende (lokal oder durch die Gegenseite) werden zusätzlich alle gespeicherten
  Schlüssel übersprungener Nachrichten verworfen.

## 11. Sicherheitsargumente und Grenzen

**Forward Secrecy.** Nachrichtenschlüssel entstehen per Einweg-KDF aus der Kette
und werden nach Gebrauch gelöscht; Kettenschlüssel werden überschrieben. Wer den
aktuellen Zustand stiehlt, kann frühere Nachrichten nicht entschlüsseln
(Ausnahme: gespeicherte Schlüssel noch nicht angekommener Nachrichten, begrenzt
und ablaufend).

**Post-Compromise Security.** Nach einem Diebstahl des Zustands liest der
Angreifer (passiv) nur bis zum nächsten Sprecherwechsel mit, bei dem das
bestohlene Gerät ein frisches X25519-Paar erzeugt (Test „Post-Compromise
Security“). Ein *aktiver* Angreifer mit gestohlenem Zustand kann sich – wie bei
Signal – dauerhaft dazwischenschalten; dagegen hilft nur der Sicherheitscode.

**Post-Quanten.** (a) Der Ratchet-Header und alles darin liegt hinter der
ML-KEM-geschützten Verbindungsschicht – „Mitschneiden jetzt, entschlüsseln
später“ scheitert schon dort. (b) Selbst wer die Verbindungsschicht hat und X25519
bricht, braucht für jeden Root-Key-Schritt nach einem KEM-Schritt das zugehörige
ML-KEM-Geheimnis (HKDF über DH ‖ KEM bleibt geheim, solange eine Eingabe geheim
ist). (c) Grenze: Zwischen zwei KEM-Schritten (eine Verbindung) beruht die
Heilung nur auf X25519; die Initialisierung beruht vollständig auf dem ML-KEM-
Geheimnis der ersten Ratchet-Verbindung.

**Grenzen / bewusst nicht gelöst**
* Authentizität der Gegenseite beruht wie bisher auf der Kopplung (Einmal-PSK im
  QR-Code), der Tor-Anmeldung und dem Sicherheitscode – es gibt keine
  Identitätsschlüssel wie bei X3DH/PQXDH.
* Die ersten Nachrichten nach der Aktivierung (bis zur ersten Antwort) sind nur
  so gut geschützt wie das Verbindungsgeheimnis, aus dem die Sitzung entstand.
* Wer das Verbindungsgeheimnis kennt, sieht innere Längen (Block 64 Byte) und
  Header – nicht aber Inhalte.
* Zustandsverlust auf nur einer Seite (Speicher defekt) heilt nicht automatisch:
  die Gegenseite nimmt absichtlich keinen Neuaufbau an. Abhilfe: `resetSession()`
  auf beiden Seiten (noch ohne Oberfläche) oder neu koppeln.
* Anruf-Sprachpakete über den Kanal haben weiterhin nur die Verbindungsschicht.

## 12. Unterschiede zu Signal

| Signal | Malachi |
|---|---|
| X3DH/PQXDH mit Identitäts- und Prekeys | Start aus dem ML-KEM-Geheimnis einer bereits angemeldeten Verbindung; Bobs erstes Ratchet-Paar daraus abgeleitet |
| Header-Verschlüsselung optional | Header hinter der ML-KEM-Verbindungsschicht (§2) |
| AES-256-CBC + HMAC, IV abgeleitet | XChaCha20-Poly1305, zufällige Nonce |
| SPQR: eigene ML-KEM-Schlüssel im Ratchet (gestückelt) | Verbindungs-Schlüsseltausche liefern die KEM-Geheimnisse; die entkapselnde Seite mischt sie beim nächsten DH-Schritt ein |
| Neue Sitzung per PreKey-Nachricht jederzeit | Bestätigte Sitzung nimmt keinen Neuaufbau an |
| Anhänge: Upload + Pointer | Chunks direkt P2P, Schlüssel im Ratchet-End-Marker |

## 13. Migration

* Bestehende Kontakte laufen weiter im alten Verfahren, bis beide Seiten die neue
  Version haben; dann baut die Initiator-Seite automatisch auf (keine
  Nutzeraktion).
* Warteschlange: Einträge mit `secretUsed` werden beim Start
  (`loadPreviousSecret` → `migrateQueueAtRest`) und bei jedem Abarbeiten auf einen
  lokalen Schlüssel umgestellt: neue Datei, Index umbiegen, erst danach alte Datei
  löschen (absturzsicher). Sehr alte Einträge ohne `secretUsed` werden mit dem
  Secret der nächsten Verbindung umgestellt.
* Neues Paket: `@noble/curves` **2.4.0** (exakt gepinnt). Nach dem Merge
  `npm install` im Haupt-Checkout ausführen.

## 14. Tests

`ratchet.doubleRatchet.test.js` (Algorithmus + Sitzungsverwaltung) und
`ratchet.integration.test.js` (zwei vollständige Geräte, echter Kyber-Ablauf der
Handler, Warteschlange, Medien): Grundablauf, viele Nachrichten, Sprecherwechsel,
außer der Reihe, verlorene Nachrichten, Limits/Ablauf übersprungener Schlüssel,
Forward Secrecy, Post-Compromise Security, KEM-Schritt (Root Key ändert sich,
ohne KEM-Geheimnis kein Weiterkommen), Persistenz über Neustart, gleichzeitiges
Senden, gleichzeitiger Aufbau, fremder Neuaufbau abgelehnt, Speicherfehler,
Manipulation von Header/Chiffrat, Replay, Warteschlange mit neu verschlüsselter
Wiederholung (genau einmal angezeigt), Migration, Medien mit Dateischlüssel inkl.
Manipulation, Kompatibilität mit alter Gegenseite (beide Rollen), kein Downgrade
nach Aktivierung, Löschen/Wipe/Secret Chat.

**Auf echten Geräten prüfen** (nativ: ML-KEM, Hermes-Leistung von X25519):
1. Zwei Geräte mit neuer Version koppeln; im Log `[Ratchet] Neue Sitzung aufgebaut
   (Initiator)` bzw. `Sitzung von der Gegenseite bestätigt`.
2. Text, Bild, Sprachnachricht, Datei in beide Richtungen; Profilbild ändern.
3. Netzwechsel WLAN↔Mobilfunk, Tor-Reserve/Direkt-Upgrade: Nachrichten über alle
   Wege, keine `[Ratchet] Nachricht verworfen`-Warnungen außer Duplikaten.
4. Eine Seite offline Nachrichten verfassen lassen, App beenden, neu starten,
   verbinden: genau einmal angekommen.
5. Alt ↔ neu: ein Gerät mit alter Version – alles funktioniert wie bisher.
6. Secret Chat starten/beenden, Chat löschen, Duress-PIN: danach kein
   `ratchet_*`-Eintrag mehr (Diagnose) bzw. Kontakt sauber entfernt.
7. Laufzeit messen: X25519 (reines JS, BigInt) unter Hermes beim
   Sprecherwechsel – drei Skalarmultiplikationen pro Schritt. Unter Jest/V8 sind es
   wenige Millisekunden; auf Geräten ist der Wert noch nicht gemessen (Zielwert
   unter 100 ms auf Mittelklasse-Geräten, sonst nativen X25519-Weg erwägen).
