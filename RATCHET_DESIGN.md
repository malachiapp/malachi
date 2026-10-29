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
| `K` | ML-KEM-768-Geheimnis der Verbindung, auf der die Sitzung entsteht. **Verbindungen v2** (`kx: 2`, seit Krypto-Review 2026-10-25 V5, siehe unten): statt des rohen Geheimnisses der abgeleitete Teilschlüssel `K_kem` |
| `kid(K)` | `HKDF-SHA256(ikm=K, salt="malachi-dr-v1-init", info="malachi-kem-id-v1", 16)` – Kennung, gibt nichts über `K` preis |
| `SK` | `HKDF(K, salt, info="malachi-dr-v1-sk", 32)` – Start-Root-Key |
| `AD_s` | `HKDF(K, salt, info="malachi-dr-v1-ad", 32)` – Sitzungsbindung |
| Bob-Init-DH | `HKDF(K, salt, info="malachi-dr-v1-bob-dh", 32)` als X25519-Privatschlüssel (Ersatz für Bobs Signed Prekey) |
| `KDF_RK(rk, dh, kems)` | `HKDF-SHA256(ikm = dh ‖ kem₁ ‖ … ‖ kemₙ, salt = rk, info="malachi-dr-v1-rk", 64)` → (rk', ck) |
| `KDF_CK(ck)` | `mk = HMAC-SHA256(ck, 0x01)`, `ck' = HMAC-SHA256(ck, 0x02)` (Spezifikation 5.2) |
| `ENCRYPT(mk, pt, h)` | `key = HKDF(mk, salt=0³², info="malachi-dr-v1-msg", 32)`, Nonce = 24 Zufallsbytes, XChaCha20-Poly1305, `AD = "malachi-dr-v1" ‖ AD_s ‖ JSON([v, d, pn, n, k, i])` |
| Medien | Dateischlüssel 32 Zufallsbytes, XChaCha20-Poly1305, Nonce = Chunk-Index, `AD = "malachi-media-v1|art|id|index|gesamt|länge"` |

**Verbindungsschlüssel v2 (V5, `ConnKeyV2.js`).** Bis 1.1 war `K` das rohe
ML-KEM-Geheimnis und diente zugleich als äußerer Schlüssel, Tor-Anmeldeschlüssel,
Ratchet-Start, KEM-Beitrag und Code-Eingabe (K-08); der Tausch war nicht an die
Anmeldung gebunden und ohne X25519-Anteil (K-07). Zwischen neuen Geräten jetzt:

```
Initiator → {kyber_pubkey, publicKey: ek, kx: 2, x: xI, ck: chainId}
Responder → {kyber_ciphertext, cipherText: ct, kx: 2, x: xR}
T      = SHA-256(lp-kodiert: Label, ek, ct, xI, xR, chainId, ol)   Rollen über Feldnamen
ikm    = ss_MLKEM ‖ X25519(xI, xR) ‖ HKDF(chain, "…|chain")          je 32 Byte
K_outer = HKDF(ikm, salt=T, "malachi-kx-v2|outer")       äußere Schicht, gespeichert, Tor-Anmeldung, Kettenglied
K_kem   = HKDF(ikm, salt=T, "malachi-kx-v2|ratchet-kem") Ratchet-Start und KEM-Beitrag (held/own)
K_code  = HKDF(ikm, salt=T, "malachi-kx-v2|legacy-code") nur alter Verbindungscode
```

* `chain` = Geheimnis, mit dem sich die Verbindung über Tor angemeldet hat, das
  der Verbindung, über die ein Direkt-Upgrade ausgehandelt wurde, bzw. der PSK
  der Einladung (Telefon-Kopplung: keine Kette, der Tunnel ist selbst hybrid und
  per Code geprüft). `ck` = HKDF-Kennung davon; der Responder sucht das passende
  Glied (gesetzt, gespeichert, aktive Verbindung) und lehnt ab, wenn er es nicht
  kennt – nie ein anderer Schlüssel.
* Implizite Schlüsselbestätigung: Passen die Schlüssel nicht (manipuliertes
  Transkript), sind schon die ersten Pakete nicht lesbar; nach drei solchen wird
  die Verbindung verworfen.
* Das rohe ML-KEM-Geheimnis wird nach der Ableitung nirgends benutzt oder
  gespeichert. `K_outer` und `K_kem` sind voneinander unabhängig: wer den
  gespeicherten äußeren Schlüssel erbeutet, kennt den KEM-Beitrag nicht.
* Klebrig wie `ol`: nach der ersten v2-Verbindung eines Kontakts wird eine
  Verbindung ohne `kx`, ohne `x` oder ohne Kettenglied abgelehnt. Gegenseiten
  1.0/1.1 laufen unverändert mit v1 (rohes ML-KEM).

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
höchstens 10 000 werden je Nachricht vorgerechnet (`MAX_SKIP`), gespeichert
bleiben höchstens die 1000 jüngsten (`MAX_SKIPPED_KEYS`, Audit 2026-10-19 C1),
Ablauf nach 72 h. Nachrichten abgelöster Ketten ohne gespeicherten Schlüssel werden sofort
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
* **Aufbewahrung von `held` (seit Krypto-Review 2026-10-25, V4/K-08).** Ein
  `held`-Eintrag ist das Geheimnis einer früheren Verbindung und soll so kurz
  wie möglich liegen – aber nie kürzer, als er gebraucht werden kann, sonst
  bekäme die Gegenseite in ihrer Richtung dauerhaft `kem-unknown`.
  Begründung der Regel:
  1. Ketten wechseln streng abwechselnd: Die Gegenseite legt ihre nächste Kette
     erst an, wenn sie unseren aktuellen Ratchet-Schlüssel empfangen hat; jede
     ihrer früheren Ketten haben wir bereits verarbeitet.
  2. Sie mischt ein Geheimnis nur ein, solange es bei ihr höchstens 7 Tage alt
     ist (auch in 1.0/1.1).
  3. Unseren aktuellen Schlüssel kann sie frühestens erhalten, wenn wir damit
     das erste Mal gesendet haben – Zeitpunkt `sa` im Zustand (bei `ns = 0`:
     frühestens jetzt).
  Also ist jeder Eintrag, der älter als `sa − 7 Tage − 1 Tag Uhren-Spielraum`
  ist, in keiner noch ausstehenden Kette mehr möglich und wird gelöscht. Im
  laufenden Gespräch sind das rund 8 Tage (vorher 30). Jüngere Einträge bleiben
  bis zum Verbrauch, auch länger als 14 Tage – das passiert nur, wenn seither
  keine Verbindung zustande kam (jede Verbindung bringt die ausstehende Kette,
  `profile_name` läuft durch den Ratchet); höchstens 64 Einträge. Ohne Sitzung:
  14 Tage, 8 Einträge. Zustände aus 1.0/1.1 ohne `sa` behalten bis zum nächsten
  eigenen DH-Schritt das alte Verhalten (30 Tage, 32 Einträge), damit ein
  Update nie etwas löscht, das noch gebraucht wird. Hinweis: Die bisherige
  Grenze „32 jüngste Einträge“ konnte bei vielen Verbindungen ohne Nachricht
  der Gegenseite einen noch benötigten Eintrag verdrängen – auch das ist damit
  behoben. Tests: `ratchet.heldRetention.test.js`, `ratchet.integration.test.js`
  („20 Tage keine Verbindung“).
* Vorbild: PQXDH (Hybrid-KDF über DH ‖ KEM) und Signals Triple Ratchet/SPQR
  (laufender PQ-Beitrag). Anders als SPQR transportiert Malachi keine eigenen
  ML-KEM-Schlüssel im Ratchet-Header – die Verbindungs-Schlüsseltausche liefern
  ohnehin regelmäßig frische KEM-Geheimnisse (jede Tor-/Direktverbindung).
* **Regelmäßiges Nachmischen (seit Krypto-Review 2026-10-25, V6/K-06).** Bei
  Dauerverbindungen kam tagelang kein frisches ML-KEM-Material. Jetzt, nur mit
  Gegenseiten, die `caps.ratchet >= 2` melden (klebrig, `rv` im Datensatz),
  bietet jede Seite spätestens alle 24 h bzw. 100 eigene Nachrichten einen
  frischen ML-KEM-768-Schlüssel an (SPQR-artig, aber ungestückelt):
  `pq_offer {id, pk}` → Gegenseite kapselt, leitet ab, trägt in `held` ein und
  **speichert** → `pq_ct {id, ct, kid}` → Anbieter entkapselt, leitet ab, prüft
  `kid` (Schlüsselbestätigung) und trägt in `own` ein; beim nächsten eigenen
  DH-Schritt fließt es ein – gleiche Regeln wie Verbindungsgeheimnisse.
  Geheimnis = `HKDF(ss, salt = SHA-256(lp: Label, id, SHA-256(pk), SHA-256(ct),
  AD_s), "malachi-dr-v2-pq|secret")` – an Angebot, Chiffrat und Sitzung gebunden.
  Beide Nachrichten gehen nur durch den Ratchet und werden nur so angenommen.
  Verlorene Nachrichten: offenes Angebot verfällt nach 1 h, dann neues;
  passt `kid` nicht (Manipulation, Sitzung inzwischen gewechselt), wird nichts
  eingemischt – die Gegenseite käme sonst nicht mehr mit. Höchstens ein
  angenommenes Angebot pro Minute, Wiederholungen werden erkannt. Write-Ahead:
  offener ML-KEM-Schlüssel bzw. `held`-Eintrag sind gespeichert, bevor die
  jeweilige Nachricht hinausgeht. Gegenseiten 1.0/1.1 bekommen nie ein Angebot.

## 5. Speicher, Sperre, Atomizität

* Ein Eintrag `ratchet_<id>` = `{ v, s (Zustand|null), cap, held[], own[] }`,
  seit 2026-10-25 additiv `rv` (Ratchet v2 der Gegenseite) und `pq` (offene
  Angebote, angenommene Kennungen, Zeitpunkt/Zähler des Nachmischens); im
  Zustand `s` additiv `sa` (V4). 1.0/1.1 lesen den Eintrag weiterhin.
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

**Seit Krypto-Review 2026-10-25 (K-11):** Anmelde-MAC v2 – jedes Feld mit
4-Byte-Längenpräfix, eigenes Label in HKDF und MAC, Nonces nur Hex (v1 verkettete
mit `|`, die Kodierung war nicht eindeutig). Ausgehandelt über `av: 2` in der
Challenge, alte Gegenseiten bleiben bei v1; nach der ersten v2-Anmeldung eines
Kontakts wird v1 für ihn abgelehnt (`ConnCaps.js`, `conn_caps_<id>`).

**Äußere Schicht v2 (K-09):** Bis 1.1 nutzten beide Richtungen dieselben drei
Schlüssel ohne associated data. Jetzt, nur nach Aushandlung im Kyber-Handshake
(`ol: 2` in `kyber_pubkey` und `kyber_ciphertext`): Schlüssel je Richtung
(`HKDF(K, "malachi-conn-v2|key|i2r|r2i")`), AAD `"malachi-conn-v2|<richtung>|<zweck>"`
auf AES-GCM und ChaCha20-Poly1305, Leitungsformat `{type:'encrypted', v:2, data}`.
Gespiegelte Pakete (z. B. Füll- oder Sprachpakete, die nicht durch den Ratchet
gehen) sind damit nicht mehr annehmbar. Innerhalb einer Verbindung ist das Format
fest; nach der ersten v2-Verbindung wird eine Verbindung ohne `ol` abgelehnt.
Medien ohne Ratchet-Sitzung (Profilbild direkt nach der Kopplung) gehen auf
v2-Verbindungen über den Dateischlüssel-Weg (`mediaSealer`).

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
später“ scheitert schon dort. (b) Selbst wer X25519 bricht, braucht für jeden
Root-Key-Schritt nach einem KEM-Schritt das zugehörige KEM-Geheimnis (HKDF über
DH ‖ KEM bleibt geheim, solange eine Eingabe geheim ist). *Korrektur (Krypto-
Review K-08):* Bei Verbindungen v1 ist dieses KEM-Geheimnis identisch mit dem
Schlüssel der Verbindungsschicht – wer „die Verbindungsschicht hat“, hat es also
auch; (b) gilt dort nur gegen Angreifer, die die Verbindungsschicht nicht haben.
Bei Verbindungen v2 ist der KEM-Beitrag `K_kem` ein eigener Teilschlüssel, der
sich aus dem äußeren Schlüssel nicht gewinnen lässt – dort gilt (b) wie
formuliert. (c) Grenze: Zwischen zwei KEM-Schritten (eine Verbindung) beruht die
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

## 13a. Sicherheitscode (seit Krypto-Review 2026-10-25, V1)

Bis 1.1 war der Sicherheitscode `SHA-256(Base64(K))` der **aktuellen Verbindung**
(16 Ziffern, ohne Domänentrennung) und wechselte bei jedem Neuaufbau – ständige
„Code geändert“-Hinweise, kein dauerhafter Vergleich (K-01, K-10). Jetzt
(`SafetyNumber.js`):

```
SN = HKDF-SHA256(ikm = AD_s, salt = "malachi-safety-number-v2",
                 info = "malachi-safety-v2|digits", 30 Byte) → 6 × 5 Ziffern
```

* `AD_s` gehört zur **Sitzung** (§3), ist auf beiden Geräten gleich und
  unabhängig von der Rolle; neue Verbindungen, Tor-Reserve und Direkt-Upgrade
  ändern ihn nicht. Er ändert sich nur mit einer neuen Sitzung (Zurücksetzen,
  Neu-Kopplung) – genau dann warnt die App.
* Ein Mann in der Mitte hat zwei Sitzungen mit zwei `AD_s`; er kann keine Seite
  auf dasselbe ML-KEM-Geheimnis zwingen, 30 Ziffern (~100 bit) lassen sich nicht
  durchprobieren.
* Angezeigt wird erst, wenn die Sitzung von der Gegenseite bestätigt ist (beim
  gleichzeitigen Aufbau kann sie vorher noch wechseln).
* „Stimmt überein“ speichert den bestätigten Code (`safety_v2_<id>`, nur
  Anzeigezustand). Der Hinweis „Vorgestellt von …“ verschwindet erst danach
  (K-03), nicht mehr beim Öffnen des Dialogs.
* Kompatibilität: Fähigkeit `caps.sn = 2` im `profile_name`. Ohne sie zeigt die
  Gegenseite (1.0/1.1) den alten Verbindungscode; die App zeigt dann ebenfalls
  diesen, mit dem Hinweis, dass er nur für die aktuelle Verbindung gilt.
  Migration: Der erste berechnete Code eines bestehenden Kontakts wird ohne
  Warnung zur Grundlage.

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
