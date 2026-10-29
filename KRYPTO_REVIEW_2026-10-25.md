# Krypto-Review „Dreifach-Verschlüsselung mit Kyber“ – 25.10.2026

**Geprüfter Stand:** Worktree `features-okt26` (Branch `claude/features-okt26`), nur lesend.
Es wurde nichts am Code geändert, nichts gebaut, kein Test ausgeführt (reine Code- und Dokumentenanalyse).
Einzige neue Datei ist dieser Bericht.

**Gelesen (Auswahl):** `MessageCrypto.js`, `HybridCrypto.js`, `WebRTCManager.js`, `DoubleRatchet.js`, `RatchetSession.js`,
`MediaKey.js`, `ImageCrypto.js`, `AudioCrypto.js`, `FileCrypto.js`, `RTCStore.js` (Ausschnitte), `BackgroundSync.js` (Ausschnitte),
`TorTransport.js` (Anmeldung, Kopplung), `PairingIds.js`, `PhonePairing.js` (Handshake, Tunnel), `GroupIntroPairing.js`,
`GroupMessaging.js` (Rechte, Vorstellen), `GroupCallManager.js`/`CallManager.js` (Kopf, Signalisierung), `SiegelCrypto.js`,
`SiegelVault.js` (KDF), `PinVault.js`, `KyberModule.kt`, `vault/MalachiPinKeyModule.kt`, `App.tsx` (Sicherheitscode, Kopplung),
Design-/Audit-Dokumente (`RATCHET_DESIGN.md`, `PIN_VAULT_DESIGN.md`, `PHONE_PAIRING_DESIGN.md`, `SECURITY_AUDIT_2026-10-19.md`,
`SECURITY_AUDIT_2026-10-25.md`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`, `SECURITY_REVIEW_2_CRYPTO.md`), Website `website/site/*.html`,
`locales/de.js`, `package.json`/`package-lock.json`, `android/app/build.gradle`.

**Markierungen:** *(Vermutung)* = nicht am Gerät oder in Quellen belegt, sondern begründete Annahme.

---

## Kleines Glossar (für den Einstieg)

| Begriff | Kurz erklärt |
|---|---|
| **KEM** (Key Encapsulation Mechanism) | Verfahren, mit dem eine Seite für den öffentlichen Schlüssel der anderen ein gemeinsames Geheimnis „einpackt“ (Kapseln, liefert *Chiffrat ct* + Geheimnis) und die andere es „auspackt“ (Entkapseln). ML-KEM-768 (früher „Kyber“) ist der NIST-Standard FIPS 203 und gilt als quantensicher. |
| **X25519** | Klassischer Diffie-Hellman-Schlüsseltausch auf Curve25519. Schnell, bewährt, aber von einem großen Quantencomputer brechbar. |
| **Hybrid / Combiner** | Man kombiniert ein klassisches (X25519) und ein PQ-Verfahren (ML-KEM), sodass ein Angreifer **beide** brechen muss. Der *Combiner* ist die Formel, die beide Geheimnisse zu einem Schlüssel verrührt. |
| **HKDF** | Standard-Funktion (RFC 5869), die aus einem Geheimnis mehrere unabhängige Schlüssel ableitet. Das „info“-Label trennt Verwendungszwecke (*Domänentrennung*). |
| **AEAD** | Verschlüsselung mit eingebauter Echtheitsprüfung (z. B. ChaCha20-Poly1305). **AAD** (associated data) sind Zusatzdaten, die nicht verschlüsselt, aber mitgeprüft werden. |
| **Nonce** | Zahl, die pro Schlüssel nur einmal vorkommen darf. Wiederholung kann je nach Verfahren katastrophal sein. |
| **Forward Secrecy (FS)** | Wer heute einen Schlüssel stiehlt, kann **frühere** Nachrichten nicht lesen. |
| **Post-Compromise Security (PCS)** | Nach einem Diebstahl „heilt“ sich die Sitzung, **spätere** Nachrichten sind wieder geschützt. |
| **HNDL** („harvest now, decrypt later“) | Heute mitschneiden, später mit einem Quantencomputer entschlüsseln. Dagegen hilft nur PQ-Schutz der *Vertraulichkeit*. |
| **MITM** | „Mann in der Mitte“: Angreifer sitzt unbemerkt zwischen zwei Geräten. Erkennbar nur über einen Vergleich auf einem zweiten Weg (Sicherheitscode). |
| **SAS** | Kurzer Vergleichscode (Short Authentication String), den beide Seiten vorlesen. |
| **Double Ratchet** | Signals Verfahren: jede Nachricht eigener Schlüssel (FS), bei jedem Sprecherwechsel frischer DH-Schritt (PCS). |

---

## 1. Kurzfazit

**Gesamturteil: solide, sorgfältig implementiert, keine kritischen oder hohen Befunde.** Die eigentliche Stärke liegt nicht in der
„Dreifach-Verschlüsselung“, sondern im **Double Ratchet mit ML-KEM-Beitrag**, der Write-Ahead-Persistenz, den
Downgrade-Sperren und in den beiden sauber gebauten Hybrid-Handshakes (**Siegel** und **Telefon-/Kennungs-Kopplung**,
beide X-Wing-artig mit Transkript-Bindung und Schlüsselbestätigung bzw. SAS).

Was „Dreifach-Verschlüsselung mit Kyber“ tatsächlich ist:
1. **Pro Verbindung** (Tor-Strom oder WebRTC-DataChannel) ein frischer **ML-KEM-768**-Schlüsseltausch → Geheimnis `K`.
2. Aus `K` per HKDF drei Schlüssel für die **Kaskade AES-256-GCM → ChaCha20-Poly1305 → XSalsa20-Poly1305** (äußere Schicht).
3. Darin (seit 1.0) der **Double Ratchet** (X25519 + XChaCha20-Poly1305), in dessen Root-Key die `K` der Verbindungen
   einfließen. Außen herum zusätzlich DTLS bzw. Tor (klassisch).

Die Kaskade ist **korrekt gebaut, aber wenig wert**: alle drei Schlüssel hängen am selben `K`. Sie schützt nur gegen den
(unwahrscheinlichen) Bruch eines einzelnen Algorithmus, nicht gegen Schlüsselverlust oder einen ML-KEM-Bruch. Echte
X25519+ML-KEM-Hybridität gibt es im Chat erst im Ratchet, nicht beim Verbindungs-Schlüsseltausch.

**Wichtigste Schwächen (alle „Mittel“):**
- **Sicherheitscode** wird aus dem *Verbindungs*geheimnis berechnet und ändert sich bei jeder Verbindung → ständige
  „Code geändert“-Hinweise, kein stabiler „verifiziert“-Zustand. Damit ist die einzige MITM-Erkennung praktisch stumpf (K-01).
- **Einladungslink** (Token + PSK + Onion) wird aktiv zum Teilen über fremde Apps angeboten; wer ihn liest, kann sich
  zuerst koppeln, wer ihn ändern kann, sitzt dauerhaft dazwischen (K-02). Bei **Vorstellen über den Admin** gilt dasselbe für
  den Admin (K-03).
- **WebRTC-Anrufe** (1:1 und Gruppe) sind nur klassisch per DTLS-SRTP geschützt, also **nicht** post-quanten-sicher, obwohl
  App und Teilen-Text pauschal „Post-Quanten-verschlüsselt“ sagen (K-04).
- **PIN-Tresor:** Argon2id läuft *vor* dem Chip-HMAC und lässt sich deshalb vom Angreifer vorab auslagern; seriell bleibt nur
  der (schnelle) Chip-Aufruf. Die dokumentierte Schätzung „6 Stellen = Tage“ ist vermutlich zu optimistisch (K-05).

**Sinnvollste Verbesserungen:** stabile Sicherheitsnummer aus der Ratchet-Sitzung (V1), ehrlichere Texte (V2),
`setUnlockedDeviceRequired` + Passphrase für den PIN-Tresor (V3), Verbindungsschlüssel v2 mit X-Wing-Combiner und
Kettenbindung (V5), regelmäßiges PQ-Nachmischen im Ratchet (V6).

---

## 2. Wie die Verschlüsselung aufgebaut ist

### 2.1 Schaubild – eine Chat-Nachricht

```
                ┌───────────────────────────── Gerät A ─────────────────────────────┐
  {type:'text'} │  padToBlock(64 B)                                                  │
        │       │  [1] DOUBLE RATCHET  (pro Kontakt, dauerhaft gespeichert)          │
        └──────▶│      XChaCha20-Poly1305, 24-Byte-Zufallsnonce,                     │
                │      AAD = "malachi-dr-v1" ‖ AD_s ‖ JSON[v,d,pn,n,k,i]             │
                │      Root-Key ← HKDF(salt=rk, ikm = X25519-DH ‖ KEM_1 … KEM_n)     │
                │  padToBlock(1024 B)                                                │
                │  [2] VERBINDUNGSSCHICHT = „Dreifach“ (pro Verbindung)              │
                │      AES-256-GCM → ChaCha20-Poly1305 → XSalsa20-Poly1305           │
                │      k1,k2,k3 = HKDF(K, info="malachi-layerN-…-message")           │
                │      K = ML-KEM-768-Geheimnis DIESER Verbindung                    │
                └────────────────────────────────┬───────────────────────────────────┘
                                                 │ [3] TRANSPORT (klassisch)
                       Tor-Onion-Strom (ntor/X25519)  oder  WebRTC-DataChannel (DTLS 1.2/ECDHE)
```

Nie durch den Ratchet, nur Schicht [2]: Füllpakete (`dummy`), `call_audio` (Sprache über den Kanal), Medien-Chunks
(diese aber mit eigenem Dateischlüssel, der nur im Ratchet-geschützten End-Marker reist) – `WebRTCManager.js:189-201`.

### 2.2 Schaubild – Schlüssel und Vertrauenskette

```
 Kopplung per QR/Link:  malachi://connect/TOKEN.PSK.ONION   (PSK = 128 bit Zufall)
   └─ Tor zum Onion des Einladenden, gegenseitige HMAC-Anmeldung mit PSK (an Onion + Nonces gebunden)
        └─ im Tor-Strom:  Initiator ── pk (ML-KEM) ──▶ Responder
                          Initiator ◀── ct ────────── Responder      ⇒ K1  (reines ML-KEM, kein X25519)

 Jede weitere Verbindung:
   Tor:    HMAC-Anmeldung mit K_n (bzw. K_{n-1})  ──▶  neues ML-KEM im Strom  ⇒ K_{n+1}
   Direkt: SDP mit DTLS-Fingerabdruck reist DURCH den verschlüsselten Kanal ──▶ DTLS ──▶ ML-KEM ⇒ K'

 K wird verwendet als:  äußere Dreifach-Schlüssel │ Tor-Anmeldeschlüssel der nächsten Verbindung │
                        Sicherheitscode (SHA-256) │ Ratchet-Start (SK, AD_s, Bob-DH) │ KEM-Beitrag im Root-Key
```

### 2.3 Schlüsselableitungen im Überblick

| Wert | Ableitung | Fundstelle |
|---|---|---|
| `K` (Verbindung) | ML-KEM-768 (BouncyCastle 1.80, nativ) – Kapseln beim Responder, Entkapseln beim Initiator | `KyberModule.kt:30-69`, `WebRTCManager.js:1029-1036, 1111-1144, 1215-1231` |
| Dreifach-Schlüssel | `HKDF-SHA256(K, salt=–, info="malachi-layer{1,2,3}-<alg>-<zweck>")`, Zweck `message`/`call-signal`/`gcall-signal`/`queue`/`inbox` | `MessageCrypto.js:90-96` |
| Tor-Anmeldung | `HMAC(HKDF(K, info="malachi-tor-auth-v1"), role|onion|nonceS|nonceC|id)` | `TorTransport.js:390-393` |
| Ratchet-Start | `SK, AD_s, Bob-DH = HKDF(K, salt="malachi-dr-v1-init", info=…)` | `DoubleRatchet.js:119-126` |
| KDF_RK (Combiner) | `HKDF(ikm = DH ‖ KEM_1…KEM_n, salt = rk, info="malachi-dr-v1-rk", 64)` | `DoubleRatchet.js:131-134` |
| Nachrichtenschlüssel | `mk = HMAC(ck,0x01)`, AEAD-Key `= HKDF(mk, "malachi-dr-v1-msg")` | `DoubleRatchet.js:137-143` |
| Sicherheitscode | `SHA-256(Base64(K))` → nur Dezimalziffern → 16 Ziffern | `WebRTCManager.js:1512-1524`, `KyberModule.kt:70-78` |
| Medien | Zufallsschlüssel je Medium, Nonce = Chunk-Index, AAD `malachi-media-v1|art|id|index|gesamt|länge` | `MediaKey.js:39-62` |
| Siegel | `root = HKDF(X25519 ‖ ML-KEM, salt = SHA-256(Label‖nonce‖xA‖pkA‖xB‖ct))` + Bestätigungs-Tag + 30-stelliger Code | `SiegelCrypto.js:151-170, 209-210` |
| Telefon/Kennung | Commitment-SAS, `ikm = X25519 ‖ ML-KEM`, `salt = Transkript`, Tunnel mit Zählernonce | `PhonePairing.js:340-377, 527-560` |
| PIN-Tresor | `kek = HMAC_Chip(Argon2id(PIN, 32 MiB, t=3, p=1))`, Sealed Box X25519+HKDF(salt=eph‖pub)+XChaCha | `PinVault.js:58, 149-174`, `MalachiPinKeyModule.kt:99-121` |

### 2.4 Ist das ein korrekter KEM-Combiner? (Vergleich mit X-Wing / IETF-Entwurf)

- **X-Wing** rechnet `SHA3-256(ss_M ‖ ss_X ‖ ct_X ‖ pk_X ‖ Label)`: beide Geheimnisse **plus** X25519-Chiffrat und -Schlüssel;
  das ML-KEM-Chiffrat darf (nur speziell für ML-KEM-768) wegfallen. Der IETF-Entwurf `draft-irtf-cfrg-hybrid-kems` nennt das
  „C2PRICombiner“; der vorsichtigere „UniversalCombiner“ hasht zusätzlich PQ-Chiffrat und PQ-Schlüssel.
- **Verbindungsschicht (Chat):** **kein Combiner**, reines ML-KEM-768. Die klassische Absicherung kommt nur durch
  *Schachtelung* (DTLS bzw. Tor außen). Gegen einen passiven Netz-Angreifer ist das „hybrid genug“ (er muss Tor/DTLS **und**
  ML-KEM brechen); gegen jemanden, der Tor/DTLS bereits durchschaut, hängt die äußere Schicht allein an ML-KEM.
- **Ratchet (KDF_RK):** PQXDH-artige Verkettung `HKDF(salt=rk, DH ‖ KEM…)`. Unter der üblichen Annahme, dass HMAC/HKDF ein
  „dual-PRF“ ist, bleibt das Ergebnis geheim, solange **eine** Eingabe geheim ist – akzeptabel. DH-Public-Keys sind (wie bei
  Signal) über die AAD des Headers gebunden; ML-KEM-Chiffrate und -Schlüssel der Verbindung fließen nirgends ein, was für
  ML-KEM-768 nach X-Wing-Argument vertretbar ist. Alle Teile haben feste Länge (32 Byte) – die Verkettung ist eindeutig.
- **Siegel und Telefon-Kopplung:** **ja**, X-Wing-artig mit vollständigem Transkript (inkl. ML-KEM-pk und -ct), Schlüssel-
  bestätigung bzw. SAS. Das ist die Messlatte, an der sich die Verbindungsschicht orientieren sollte (V5).

### 2.5 Authentifizierung – wer bestätigt wen?

| Weg | Wie | MITM-Fenster |
|---|---|---|
| QR persönlich | Scanner kennt Onion (Tor beweist den Besitz des Onion-Schlüssels) + PSK; Einladender prüft PSK-HMAC | praktisch keins |
| **Link/Code geteilt** | wie oben, aber über WhatsApp & Co. (`App.tsx:5392, 5569`, Text `connect.shareMessage`) | Mitleser kann 25–30 min lang zuerst koppeln; wer den Link **ändert**, sitzt dauerhaft dazwischen (K-02) |
| Telefon/Kennung | Commitment + 6-stelliger SAS, Pflichtvergleich per Telefon | 1 : 10^6 je sichtbarem Versuch – gut |
| Vorstellen über Admin | Einladung (Token/PSK/Onion) läuft über den Admin | Admin kann MITM bzw. Phantom-Kontakt einsetzen (K-03) |
| Folgeverbindungen | Tor: HMAC mit vorherigem `K`; direkt: DTLS-Fingerabdruck im verschlüsselten Kanal | sicher, solange `K` geheim ist; der ML-KEM-Tausch selbst ist **nicht** an diese Anmeldung gebunden (K-07) |
| Sicherheitscode | `SHA-256(K)` der **aktuellen Verbindung**, wechselt bei jeder Verbindung | Vergleich nur „im Moment“, ständige Änderungshinweise (K-01) |

Es gibt **keine Langzeit-Identitätsschlüssel** (wie bei Signal); Identität = Kette der Verbindungsgeheimnisse + Ratchet-Zustand.
Das ist in `RATCHET_DESIGN.md §11` ehrlich benannt.

### 2.6 Double Ratchet – Prüfung

| Prüfpunkt | Ergebnis |
|---|---|
| Nonce-Wiederverwendung | **Keine.** Je Nachricht eigener Schlüssel *und* 24-Byte-Zufallsnonce (`DoubleRatchet.js:250-252`); Zustand wird vor dem Senden gespeichert (Write-Ahead, `RatchetSession.js:314-316`). |
| Übersprungene Schlüssel | Rechengrenze 10 000, Speichergrenze 1 000 (älteste fallen weg), Ablauf 72 h (Siegel 90 d); nach Gebrauch gelöscht (`DoubleRatchet.js:53-55, 262-275, 302-307`). DoS nur durch die authentische Gegenseite und harmlos (≤10 000 HMACs). |
| Fehlerbehandlung | Arbeit auf Kopie, bei jedem Fehler verworfen (Spez. 3.5) – korrekt. |
| Replay | Zähler, `prevDhr` (8 Ketten), Löschen benutzter Schlüssel, zusätzlich `msgId`-Dedup – gut. |
| Header-Verschlüsselung | Keine; Header liegt in der ML-KEM-Verbindungsschicht. Begründung nachvollziehbar; sichtbar nur für Besitzer von `K` (Info K-16). |
| Forward Secrecy | Ja für Inhalte. Die äußere Schicht hat dagegen kaum FS: `K` bleibt gespeichert (aktuell, vorherig, `held` bis 30 Tage) (K-08). |
| PCS | Klassisch (X25519) bei jedem Sprecherwechsel. Gegen aktive Angreifer mit gestohlenem Zustand nicht (wie Signal; dokumentiert). |
| PQ-Nachmischen | Nur die **entkapselnde** Seite, nur beim **nächsten eigenen DH-Schritt**, nur KEMs ≤ 7 Tage, höchstens 4, und nur **ein ML-KEM pro Verbindung** (`RatchetSession.js:188-196`, `WebRTCManager.js:1099-1110`). Bei Dauerverbindungen über Tage keine PQ-Auffrischung (K-06). |
| Vergleich PQXDH | Signal: PQXDH bindet ML-KEM an signierte Prekeys und Identitäten in **einen** Start-KDF. Malachi: Start rein aus ML-KEM-`K`, ohne Identitätsbindung. |
| Vergleich SPQR/Triple Ratchet (Signal, Okt. 2025) | Signal führt einen **eigenen** ML-KEM-Ratchet („ML-KEM Braid“) mit Epochen und mischt dessen Schlüssel **pro Nachricht** per KDF mit dem DH-Ratchet. Malachi nutzt stattdessen die Verbindungs-KEMs – einfacher, aber seltener und von der Verbindungsdauer abhängig. |
| Downgrade | Fähigkeit `ratchet` klebrig, `active` klebrig, unlesbarer Zustand sperrt statt zurückzufallen, Senden fällt nie zurück, fremder Neuaufbau abgelehnt (`RatchetSession.js:85-105, 227-250, 336-366`; `WebRTCManager.js:1408-1438`). Restfenster nur bis zur ersten Ratchet-Antwort – braucht Transportzugang. Gut. |

**Implementierungsfehler im Ratchet habe ich nicht gefunden.**

### 2.7 AEAD-Nutzung, Replay, Padding, Medien, Downgrade

- **Äußere Schicht** (`MessageCrypto.js:98-127`): zufällige Nonces 12/12/24 Byte, **keine AAD**, dieselben Schlüssel in beide
  Richtungen, AES in `@noble/ciphers` mit T-Tabellen (Cache-Timing). Ausnutzbar nur, wenn der Transport schon gebrochen ist
  (Reflexion/Umsortierung), Inhalte schützt der Ratchet (K-09).
- **Ratchet:** AAD bindet Protokoll, Sitzung (`AD_s`) und kanonischen Header – gut. Richtung/Absender ergeben sich aus den
  DH-Schlüsseln.
- **Medien** (`MediaKey.js`): frischer Schlüssel je Medium und Versuch, Index-Nonce eindeutig, AAD bindet Art, ID, Index,
  Gesamtzahl, echte Länge; Gesamtzahl und MIME-Typ kommen aus dem Ratchet-End-Marker (`RTCStore.js:196-211, 866`). Gut.
- **Replay:** Ratchet + `msgId`-Dedup + Zeitstempel-Hochwasser für Steuersignale (`WebRTCManager.js:317-324, 1358-1380`).
- **Padding:** innen 64 B, außen 512/1024 B, Medien-Chunks 64 KB; Cover-Traffic alle 2 s (Tor 5 s). Größere Nachrichten sind
  an ihrer Blockzahl erkennbar (Info, V10).
- **Downgrade `peerCaps` 'old'/'new':** betrifft die Zustellbestätigung, nicht die Krypto; `cap=0` ist nicht klebrig und wird
  durch eine spätere Ratchet-Fähigkeit überschrieben (`RatchetSession.js:241-248`). Kein Downgrade-Pfad gefunden.

### 2.8 Zufall und Nebenkanäle

- Zufall ausschließlich aus `KyberModule.randomBytes` (`java.security.SecureRandom`), in JS **fail-closed** mit Längenprüfung
  (`MessageCrypto.js:46-73`). Einziger Rückfall auf `Math.random()` in `generateContactId` (`App.tsx:268-284`) – der Wert
  `my_id` wird aber nirgends verwendet (Info K-18).
- Konstante Zeit: MAC-Vergleiche mit `safeEqual`/`equalCt`/`ctEqual`; Tags in noble konstant. X25519 in reinem JS (BigInt,
  Hermes) ist nur „algorithmisch“ konstant – bei flüchtigen Schlüsseln und Netzabstand unkritisch.
- KyberSlash (Division durch q bei der Entkapselung) betrifft BouncyCastle 1.73–1.77, **nicht 1.80**; zudem wird jeder
  ML-KEM-Schlüssel nur einmal entkapselt – Timing-Angriffe auf den Schlüssel sind damit ohnehin praktisch ausgeschlossen.
- Löschen: `Uint8Array`-Schlüssel werden genullt; `K`, Ratchet-Zustand und ML-KEM-Geheimschlüssel liegen aber als
  Base64-**Strings** (nicht löschbar) im JS-Speicher (Info K-19, bekannt als C5).
- Fehlermeldungen: Entschlüsselungsfehler werden still verworfen und nur lokal geloggt – **kein Orakel** gegenüber der
  Gegenseite. Tor-Anmeldung schließt bei jedem Fehler gleich.

### 2.9 Gruppen

- **Paarweises Fan-out** über die 1:1-Ratchet-Kanäle; Absender = Kanal, `fromMid` muss passen, keine Weiterleitung über
  Dritte – Inhalte sind so gut wie der 1:1-Chat. Gut.
- **Admin-Fälschung durch Mitglieder:** verhindert (nur aktueller Admin laut eigenem Stand, Ersteller kann zurückholen,
  `GroupMessaging.js:773-802`).
- **Konsistenz:** keine Prüfung, dass alle denselben Gruppenstand sehen – ein Admin kann verschiedenen Mitgliedern
  verschiedene Listen/Namen schicken („weiche Rechte“, `GroupMessaging.js:30-34`) (Info K-21).
- **`group_intro`:** Der Admin reicht die Einladung unverändert weiter (`GroupMessaging.js:1541-1548, 1572-1573`) – er
  könnte sie ebenso gut durch eine eigene ersetzen und einen **MITM oder einen Phantom-Kontakt mit fremdem Namen**
  einsetzen. Abmilderung heute: Hinweis „Vorgestellt von …“, der aber schon beim **Öffnen** des Dialogs als erledigt gilt
  (`App.tsx:4446-4456`), und ein Code, der sich bei jeder Verbindung ändert (K-03).
- **Gruppenanrufe:** Host bürgt für DTLS-Fingerabdrücke nicht gekoppelter Paare (`GroupCallManager.js:16-21`) – dokumentiert.

### 2.10 Siegel-Modus und PIN-Tresor (kurz)

- **Siegel:** vorbildlicher Hybrid-Handshake (siehe 2.4), 30-stelliger Code aus dem Transkript, danach klassischer Ratchet
  (dokumentiert). Tresor: `HMAC_Chip(Argon2id(Passphrase ≥ 8 Zeichen, 32 MiB, t=3))`.
- **PIN-Tresor:** Sealed Box korrekt (beide Public Keys im HKDF-Salz, Kontext im Info und als AAD, Zufallsnonce). Werte mit AAD
  = Schlüsselname, Duress als Prüfwert `HMAC(kek, …)` – gut. Schwäche ist der Rateaufwand am gerooteten Gerät (K-05) und
  der unauthentisierte öffentliche Tresorschlüssel (Info K-20).

### 2.11 Bibliotheken

| Bibliothek | Version | Befund |
|---|---|---|
| `@noble/curves` | 2.4.0 (exakt) | keine veröffentlichten Advisories; X25519 lehnt Punkte kleiner Ordnung ab |
| `@noble/ciphers` / `@noble/hashes` | Lock 2.4.0, `package.json` `^2.3.0` | keine Advisories; Versionsbereich statt exakter Pin (Info) |
| BouncyCastle `bcprov-jdk18on` | 1.80 (`build.gradle:245`) | KyberSlash (CVE-2024-14041) erst ab 1.78 behoben → **nicht betroffen**. Kapseln prüft Typ und Modulus des Public Keys (FIPS 203 §7.2). Viele CVEs 2025/2026 (Sammel-Fix in 1.85) betreffen GOST, FrodoKEM, CMS, OpenPGP, Keystores – **nicht** die genutzten Klassen; CVE-2026-59648 (Argon2 mit fremden Parametern) greift nicht, weil `MalachiPinKeyModule` die Parameter begrenzt. Update trotzdem empfehlenswert. |
| `react-native-webrtc` | 124.0.8 → `org.jitsi:webrtc:124` | libwebrtc-Stand ~2024, DTLS 1.2 mit klassischem ECDHE; *(Vermutung)* zahlreiche spätere Sicherheitskorrekturen im Medienstack fehlen |
| `@noble/post-quantum` | 0.7.1 | nur im (abgeschalteten) Web-Client |

---

## 3. Befunde

Schwere: **kritisch / hoch / mittel / niedrig / Info**. Kritische oder hohe Befunde gab es nicht.

| ID | Schwere | Bereich | Befund | Fundstelle | Ausnutzbarkeit | Empfehlung |
|---|---|---|---|---|---|---|
| K-01 | **Mittel** | Authentifizierung | Sicherheitscode = SHA-256 des **Verbindungs**geheimnisses; ändert sich bei jedem Reconnect, Tor-Reserve, Direkt-Upgrade. Die App meldet dann „Code geändert … erneut vergleichen“ und bei Abweichung „Beende den Chat sofort!“. Es gibt keinen dauerhaften „verifiziert“-Zustand; beide Handys müssen gleichzeitig dieselbe Verbindung anzeigen *(Vermutung: zeitweise Fehlalarme, wenn die Seiten unterschiedliche Verbindungen anzeigen)*. | `WebRTCManager.js:1512-1524`, `App.tsx:2686-2707, 4060-4090`, `locales/de.js:259-261` | Indirekt: macht den MITM-Schutz bei K-02/K-03 praktisch wirkungslos (Gewöhnung an Warnungen). | Stabile Sicherheitsnummer aus der Ratchet-Sitzung (`AD_s`), ≥ 30 Ziffern, „verifiziert“-Haken, Warnung nur bei echtem Sitzungswechsel (V1). |
| K-02 | **Mittel** | Kopplung | Einladungslink `TOKEN.PSK.ONION` wird per „Link teilen“/„Code kopieren“ für fremde Apps angeboten; gültig bis 25–30 min und wiederverwendbar. Der PSK fließt nicht in den Schlüssel ein. | `App.tsx:261, 5338-5374, 5392, 5560-5597`, `TorTransport.js:455-485, 874, 900` | Wer mitliest (z. B. Betreiber des Transport-Messengers), kann sich zuerst koppeln (Übernahme, für das Opfer sichtbar als Fehlschlag). Wer den Link verändert, setzt eine eigene Einladung ein → **dauerhafter MITM**, nur per Codevergleich erkennbar. | Beim Teilen deutlich auf Pflichtvergleich hinweisen; bei Link-Kopplung SAS wie bei der Telefon-Kopplung erzwingen; flüchtige Onion je Einladung (T4); V1. |
| K-03 | **Mittel** | Gruppen / Vorstellen | Admin reicht Einladungen durch und liefert den Namen des Gegenübers; er kann MITM oder einen Phantom-Kontakt („Alice“, tatsächlich der Admin) einsetzen. Hinweisbanner verschwindet schon beim Öffnen des Code-Dialogs (`checked: true`), nicht nach einem Vergleich. | `GroupIntroPairing.js:140-173, 217-240, 91-124`, `GroupMessaging.js:1541-1573, 1597-1619`, `App.tsx:4446-4456` | Erfordert bösartigen Admin; technisch einfach. Bewusst akzeptiert (Audit F5a). | „Nicht verifiziert“ dauerhaft am Kontakt, bis der Vergleich bestätigt wurde; optional SAS per Anruf direkt nach der Vorstellung; V1. |
| K-04 | **Mittel** | Anrufe / Versprechen | 1:1-Anrufe (WebRTC) und Gruppenanrufe laufen nur über DTLS-SRTP mit klassischem ECDHE (libwebrtc M124) – **kein PQ-Schutz**, kein Ratchet. App-Texte sagen pauschal „Post-Quanten-verschlüsselt“. | `CallManager.js:14-17`, `GroupCallManager.js:3-5`, `node_modules/react-native-webrtc` 124.0.8, `locales/de.js:311, 433` | HNDL: wer heute Anrufverkehr mitschneidet, kann ihn mit einem künftigen Quantencomputer entschlüsseln. Signalisierung/Fingerabdrücke sind PQ-geschützt, die Mediendaten nicht. | Texte präzisieren (V2); mittelfristig Frame-Verschlüsselung mit Ratchet-Schlüssel oder PQ-DTLS (V9). |
| K-05 | **Mittel** | PIN-Tresor | `kek = HMAC_Chip(Argon2id(PIN))`: Argon2id hängt nur von PIN und (lesbarem) Salz ab und lässt sich auf fremder Hardware für alle 10^6 PINs vorab rechnen; seriell am Gerät bleiben nur die Chip-HMACs (TEE *(Vermutung)* wenige ms je Aufruf). Chip-Schlüssel ohne `setUnlockedDeviceRequired`. Doku: „4 Stellen Stunden, 6 Stellen Tage“. | `MalachiPinKeyModule.kt:99-121, 280-302`, `PinVault.js:58, 233-235`, `PIN_VAULT_DESIGN.md:131-136`, `SECURITY_AUDIT_2026-10-25.md:75` | Nur mit Root/Code-Ausführung als App. *(Vermutung)* 6-stellige PIN eher Stunden (TEE) bis ~1 Tag (StrongBox), 4-stellig Minuten. | `setUnlockedDeviceRequired(true)` für neue Chip-Schlüssel, Passphrase-Option, ehrliche Zahl nach Messung (V3). |
| K-06 | Niedrig | Ratchet / PQ | PQ-Beitrag nur bei neuem Verbindungs-ML-KEM, nur durch die entkapselnde Seite beim nächsten eigenen DH-Schritt, max. 4, ≤ 7 Tage. Dauerverbindungen → tagelang keine PQ-Auffrischung; PQ-PCS erst nach einer *nach* der Kompromittierung neu ausgehandelten Verbindung. | `RatchetSession.js:50-54, 188-196`, `WebRTCManager.js:1099-1110`, `RATCHET_DESIGN.md:118-139` | Braucht Zustandsdiebstahl **und** Quantencomputer. | In-band-KEM-Erneuerung (SPQR-light) z. B. alle 24 h / 100 Nachrichten (V6). |
| K-07 | Niedrig | Verbindungs-Schlüsseltausch | ML-KEM-Tausch je Verbindung ist in sich unauthentisiert, nicht an das vorherige Geheimnis/PSK/Onions gekettet und ohne X25519-Anteil. Echtheit kommt nur vom Transport (Tor-HMAC am Anfang des Stroms, DTLS-Fingerabdruck). | `WebRTCManager.js:1029-1036, 1111-1144, 1215-1231`, `TorTransport.js:598-616` | Künftiger Angreifer, der Tor/DTLS **in Echtzeit** bricht (Quantencomputer), könnte pk/ct austauschen. Heute nicht praktisch. | Verbindungsschlüssel v2: X-Wing-Combiner + Transkript + `K_vorher`/PSK im Salz (V5). |
| K-08 | Niedrig | Schlüsseltrennung / FS außen | Rohes `K` dient zugleich als äußerer Schlüssel, Tor-Anmeldeschlüssel, Ratchet-Start, KEM-Beitrag (roh in KDF_RK) und Code-Eingabe. `held` bewahrt `K`s bis 30 Tage, obwohl die Gegenseite nur ≤ 7 Tage alte mischt. Das Sicherheitsargument (b) in `RATCHET_DESIGN.md` („wer die Verbindungsschicht hat … braucht das KEM-Geheimnis“) widerspricht sich, weil KEM-Beitrag = Verbindungsschlüssel. | `RatchetSession.js:47-54, 164-174`, `DoubleRatchet.js:131-134`, `WebRTCManager.js:1160, 1240`, `RATCHET_DESIGN.md:229-236` | Gerätezugriff innerhalb von 30 Tagen + Mitschnitt → äußere Schicht alter Verbindungen lesbar (Header, Füllpakete, **„Sprache über den Kanal“**). Inhalte bleiben durch den Ratchet geschützt. | `HELD_MAX_AGE_MS` auf ~10–14 Tage (kompatibel, V4); in v2 nur abgeleitete Teilschlüssel speichern (V5). |
| K-09 | Niedrig | Äußere Schicht | Keine AAD (Richtung, Version, Typ), gleiche Schlüssel beide Richtungen, Zufallsnonces 96 bit, AES-T-Tabellen in noble. | `MessageCrypto.js:90-155` | Nur bei gebrochenem Transport (Reflexion/Umsortierung von Füll-/Sprachpaketen); Cache-Timing nur lokal. | In v2 Richtung+Version als AAD; Kaskade ggf. durch eine AEAD ersetzen (V7). |
| K-10 | Niedrig | Sicherheitscode | `SHA-256(Base64(K))` ohne Domänentrennung, Ziffern aus Hex gefiltert, 16 Ziffern (~53 bit). | `WebRTCManager.js:1512-1524`, `KyberModule.kt:70-78` | Keine praktische Schwäche, aber unsauber (Hash eines aktiven Schlüssels wird angezeigt). | HKDF-Label; erledigt sich mit V1. |
| K-11 | Niedrig | Tor-Anmeldung | MAC-Eingabe `[role, …parts].join('|')`; Nonce-Zeichensatz ungeprüft, `id` frei bis 128 Zeichen → Kodierung nicht eindeutig. *(Vermutung: nicht ausnutzbar, da Rollen-Präfix und frische Server-Nonce)* | `TorTransport.js:390-393, 425, 486-497` | Nicht gefunden. | Längenpräfix wie `PhonePairing.js` `lp()` (mit V5). |
| K-12 | Niedrig | Bibliothek | libwebrtc M124 (`org.jitsi:webrtc:124`) ist alt; verarbeitet Daten der Gegenseite nativ. | `node_modules/react-native-webrtc/android/build.gradle` | Gegenseite ist authentisch, daher begrenzt; *(Vermutung)* bekannte Chromium-WebRTC-Fehler seit 2024. | Update prüfen (V8). |
| K-13 | Info | Bibliothek | BouncyCastle 1.80: nicht von KyberSlash betroffen; 2026-CVEs (Sammel-Fix 1.85) betreffen ungenutzte Komponenten. Entkapseln prüft die Chiffratlänge nicht (Implicit Rejection/Exception, folgenlos). | `android/app/build.gradle:245`, BC `MLKEMEngine` (r1rv80) | Keine. | Auf 1.85 (oder 1.80.2-Zweig) heben, SBOM (V8). |
| K-14 | Info | Lieferkette | `@noble/ciphers`/`@noble/hashes` mit `^`-Bereich, `@noble/curves` exakt. | `package.json` | Lockfile pinnt 2.4.0. | Exakt pinnen. |
| K-15 | Info | „Dreifach“ | Kaskade aus drei AEADs mit HKDF-getrennten Schlüsseln aus **einem** `K`; schützt gegen Bruch eines einzelnen Algorithmus, nicht gegen Schlüsselverlust/ML-KEM-Bruch; 96 Byte Overhead je Paket. | `MessageCrypto.js:1-9, 90-127` | – | Ehrlich als „Algorithmen-Vielfalt“ beschreiben, nicht als Mehrfachschutz. |
| K-16 | Info | Ratchet-Header | Header (DH-Schlüssel, Zähler, KEM-Kennungen) nur durch äußere Schicht verdeckt; wer `K` (gespeichert) hat, sieht Nachrichtenzahlen. | `DoubleRatchet.js:148-154`, `RATCHET_DESIGN.md:48-58` | Metadaten nach Gerätezugriff. | Bewusste Entscheidung; bei V7 neu bewerten. |
| K-17 | Info | Doku-Drift | `RATCHET_DESIGN.md:113-114` nennt „höchstens 1000 pro Nachricht“, Code hat `MAX_SKIP = 10000`; Argument (b) siehe K-08; README spricht von „Per-contact safety code“ (tatsächlich pro Verbindung). | `DoubleRatchet.js:53`, `README.md:33` | – | Doku angleichen. |
| K-18 | Info | Altlasten | `ENCRYPTION_STATUS` veraltet und ungenutzt; `generateContactId` mit `Math.random`-Rückfall (Wert ungenutzt); `web/` ohne Ratchet (offline), `web/index.html` wirbt mit „Dreifach verschlüsselt“. | `HybridCrypto.js:17-25`, `App.tsx:268-284, 1382-1383`, `web/` | – | Entfernen bzw. als veraltet kennzeichnen. |
| K-19 | Info | Speicher | Geheimnisse als Base64-Strings/JSON (nicht löschbar); ML-KEM-Geheimschlüssel reist als String über die Bridge. | `KyberModule.kt:36-41`, `RatchetSession.js:79` | Nur bei Speicherauslese des laufenden Prozesses. | Bekannt (C5); langfristig Schlüsseloperationen nativ halten. |
| K-20 | Info | PIN-Tresor | Öffentlicher Tresorschlüssel `pub` liegt unauthentisiert im Speicher; wer schreiben kann (Root), könnte ihn austauschen → gesperrt empfangene Werte würden an den Angreifer versiegelt. | `PinVault.js:96-99, 156-174` | Erfordert Root-Schreibzugriff (dann gibt es einfachere Wege). | Beim Entsperren `pub` gegen MAC(DEK) prüfen, bei Abweichung warnen. |
| K-21 | Info | Gruppen | Kein Konsistenznachweis des Gruppenstands; Gruppenanruf-Host bürgt für Fingerabdrücke. | `GroupMessaging.js:30-34`, `GroupCallManager.js:16-21` | Bösartiger Admin/Host. | Hash des Gruppenstands zwischen direkt gekoppelten Mitgliedern abgleichen (V12). |

**Ausdrücklich positiv (keine Befunde):** Nonce-Handhabung überall; Write-Ahead und Kopie-Semantik im Ratchet; Grenzen
für übersprungene Schlüssel; Replay- und Downgrade-Schutz; Medien-AAD; fail-closed Zufall; konstante Vergleiche;
Siegel- und Telefon-Handshake (Transkript, Commitment, Schlüsselbestätigung, 30- bzw. 6-stellige Codes); kleine-Ordnung-
Prüfung in noble; Modulus-Prüfung in BouncyCastle; begrenzte Argon2-Parameter im nativen Modul.

---

## 4. Verbesserungsvorschläge (priorisiert)

Kompatibilität: 1.0 (und 1.1) sind im Umlauf und sprechen Ratchet v1 (`DoubleRatchet.PROTOCOL_VERSION = 1`, Fähigkeit
`caps.ratchet = 1`). Alles, was das Leitungsformat ändert, braucht eine neue Fähigkeit (z. B. `caps.kx = 2`, `caps.ratchet = 2`)
mit Rückfall für alte Gegenseiten und „klebriger“ Hochstufung wie bisher.

### Priorität 1 – bald (hoher Nutzen, geringes Risiko)

| # | Vorschlag | Behebt | Aufwand | Risiko | Kompatibilität |
|---|---|---|---|---|---|
| **V1** | **Stabile Sicherheitsnummer** wie bei Signal: `SN = HKDF(AD_s, info="malachi-safety-v2")`, 6×5 oder 12×5 Ziffern (wie Siegel). `AD_s` ist pro Ratchet-Sitzung stabil und bei einem MITM auf beiden Seiten verschieden (der Angreifer kann wegen `H(ek)` im ML-KEM-Schlüssel nicht beide Sitzungen auf dasselbe `K` zwingen; 30+ Ziffern verhindern Durchprobieren). Dazu „Als verifiziert markieren“, Warnung **nur** bei Sitzungswechsel (Neu-Kopplung, Reset), Banner bei Vorstellung bleibt bis zur Bestätigung. Optional QR-Scan zum Vergleichen. | K-01, K-03, K-10, (K-02) | 1–2 Tage | gering (nur Anzeige) | rein lokal; Version per `caps.sn = 2` mitsenden – solange die Gegenseite alt ist, alten Code zeigen und „Gegenseite aktualisieren“ anzeigen. |
| **V2** | **Texte ehrlich präzisieren:** „Nachrichten, Bilder, Dateien: Ende-zu-Ende und post-quanten-geschützt. Anrufe: Ende-zu-Ende (DTLS-SRTP), noch nicht post-quanten-sicher.“ – in `pro.freeIntro`, `connect.shareMessage`, FAQ. PIN-Rateaufwand realistisch angeben; README „pro Verbindung“. | K-04, K-05, K-17 | Stunden | keins | – |
| **V3** | **PIN-Tresor härten:** neuen Chip-Schlüssel mit `setUnlockedDeviceRequired(true)` (API 28+) anlegen und den DEK beim nächsten Entsperren neu einpacken; optionale alphanumerische Passphrase; Chip-Latenz am Gerät messen und Doku anpassen. | K-05 | ½–1 Tag | gering (Fallback ohne Flag auf alten Geräten) | Datenformat unverändert, nur neuer Keystore-Alias |
| **V4** | `HELD_MAX_AGE_MS` von 30 auf ~10–14 Tage senken (Gegenseite mischt ohnehin nur ≤ 7 Tage). | K-08 | Minuten | gering (bei > 1 Woche Uhrabweichung `kem-unknown` möglich → lieber 14 Tage) | voll kompatibel |
| **V2b** | Beim Teilen eines Einladungslinks: Hinweis „Nur über einen vertrauenswürdigen Weg senden – danach Sicherheitsnummer vergleichen“; mittelfristig flüchtige Onion je Einladung (Audit T4). | K-02 | ½ Tag | keins | – |

### Priorität 2 – mittelfristig

| # | Vorschlag | Behebt | Aufwand | Risiko | Kompatibilität |
|---|---|---|---|---|---|
| **V5** | **Verbindungsschlüssel v2** (X-Wing-artig + Kettenbindung): im `kyber_pubkey` zusätzlich X25519-Share senden; `K_neu = HKDF(ikm = ss_MLKEM ‖ ss_X25519, salt = SHA-256(Label ‖ pk ‖ ct ‖ xI ‖ xR ‖ OnionServer ‖ Rollen) , info = …)` und zusätzlich `K_vorher` (bzw. PSK bei der Kopplung) als zweites Salz/IKM. Danach nur **abgeleitete** Teilschlüssel nutzen und speichern: `K_outer`, `K_torauth`, `K_ratchet_init`, `K_kem_mix`, `K_safety`. Explizite Schlüsselbestätigung (MAC über Transkript) in der ersten Nachricht. | K-07, K-08, K-11 | 3–5 Tage inkl. Tests | mittel: Kettenfehler können aussperren → Kandidatenlogik (aktuell/vorher) beibehalten | Aushandlung im Handshake: `{subtype:'kyber_pubkey', kx:2, x:…}`; alte Gegenseite antwortet ohne `kx` → v1. Nach erstem v2 klebrig. |
| **V6** | **Regelmäßiges PQ-Nachmischen im Ratchet** („SPQR-light“, ohne Stückelung, da P2P): Steuersignal `kem_offer {pk}` durch den Ratchet, Antwort `kem_ct {ct}`; Ergebnis landet im bestehenden `held`/`own`-Vorrat und fließt beim nächsten DH-Schritt ein. Auslöser: alle 24 h oder 100 Nachrichten; auch die kapselnde Seite darf mischen, wenn die Bestätigung angekommen ist. | K-06 | 2–4 Tage | gering–mittel | `caps.ratchet = 2`; alte Versionen ignorieren unbekannte Subtypes *(prüfen)*. |
| **V7** | **Äußere Schicht v2:** AAD = `"malachi-conn-v2" ‖ Richtung ‖ Typ`; Kaskade auf **eine** AEAD (XChaCha20-Poly1305) reduzieren *oder* beibehalten, aber AAD ergänzen. Ehrlich: die Kaskade schützt nicht vor den realen Risiken (Schlüssel, Authentisierung). | K-09, K-15 | 1–2 Tage | gering | Format-Version im `encrypted`-Umschlag (`v:2`), Aushandlung wie V5. |
| **V8** | **Abhängigkeiten:** BouncyCastle ≥ 1.85, noble exakt pinnen, libwebrtc-Update prüfen, SBOM je Release (Audit R3). | K-12–K-14 | ½–3 Tage (WebRTC aufwendiger) | mittel bei WebRTC | – |

### Priorität 3 – später

| # | Vorschlag | Behebt | Aufwand | Kompatibilität |
|---|---|---|---|---|
| V9 | **PQ für Anrufe:** Frame-Verschlüsselung (SFrame-artig) mit aus dem Ratchet abgeleitetem Anrufschlüssel *(Vermutung: in react-native-webrtc 124 sind Encoded-Transforms nicht nutzbar → native Erweiterung nötig)* oder Umstieg auf eine libwebrtc-Version mit hybridem DTLS *(Vermutung)*. Bis dahin Nur-Tor-Modus als PQ-Option nennen. | K-04 | groß | Fähigkeit `caps.callpq` |
| V10 | Längen-Buckets (Padmé wie Siegel) für Nachrichten > 1 KB und für Medien statt fester 64-KB-Klassen. | Info | 1 Tag | innen kompatibel (Padding wird entfernt) |
| V11 | Längenpräfix-Kodierung für Tor-MACs (zusammen mit V5). | K-11 | Stunden | `v:2` im Tor-Protokoll |
| V12 | Gruppen: Hash des Gruppenstands bei Direktkopplung vergleichen; Vorstellung optional mit SAS per Anruf. | K-03, K-21 | 1–2 Tage | neue Steuersignale |
| V13 | Header-Verschlüsselung nur nötig, falls die äußere Schicht wegfällt. | K-16 | – | – |
| V14 | Doku/Altlasten bereinigen (`ENCRYPTION_STATUS`, `my_id`-Rückfall, `RATCHET_DESIGN.md` Grenzen und Argument (b)). | K-17, K-18 | Stunden | – |
| V15 | `pub` des PIN-Tresors per MAC(DEK) absichern. | K-20 | Stunden | additiv |

---

## 5. Ehrlichkeit der Versprechen

| Aussage | Wo | Bewertung | Vorschlag |
|---|---|---|---|
| „Der Schlüsseltausch kombiniert das bewährte X25519 mit ML-KEM-768“ | `website/site/faq.html:34`, `index.html:35` (+ en) | **Im Kern zutreffend, aber vereinfacht.** Siegel und Telefon-Kopplung sind echt hybrid. Im Chat ist der Verbindungs-Schlüsseltausch reines ML-KEM; die Kombination mit X25519 passiert im Double Ratchet. | „Jede Verbindung handelt ein ML-KEM-768-Geheimnis aus; der Double Ratchet verbindet es mit X25519.“ |
| „Jede Nachricht bekommt einen eigenen Schlüssel, der nach Gebrauch gelöscht wird“ | FAQ | **Zutreffend** für Ratchet-Nachrichten. Ausnahmen (Füllpakete, Sprache über den Kanal) sind keine Nutzerinhalte im engeren Sinn; Schlüssel übersprungener Nachrichten bleiben bis 72 h. | ok |
| „Wird ein Gerät kurzzeitig ausgespäht, erholt sich die Verbindung“ | FAQ | **Zutreffend gegen passive Angreifer**; ein aktiver Angreifer mit gestohlenem Zustand kann sich dauerhaft dazwischenschalten (in `RATCHET_DESIGN.md` korrekt). | „… sofern der Angreifer nicht aktiv eingreift; dafür gibt es die Sicherheitsnummer.“ |
| „Ende-zu-Ende- und Post-Quanten-verschlüsselt“ | App `pro.freeIntro` (`de.js:433`), Teilen-Text `connect.shareMessage` (`de.js:311`) | **Teilweise zu weit:** gilt für Nachrichten/Medien, **nicht** für WebRTC-Anrufe und Gruppenanrufe (klassisches DTLS-SRTP). | Anrufe ausnehmen (V2). |
| „Anrufe sind Ende-zu-Ende verschlüsselt“ | `datenschutz.html:67` | **Zutreffend** (Fingerabdrücke über den E2E-Kanal); bei Gruppenanrufen bürgt der Host für nicht gekoppelte Paare. | Gruppenanruf-Einschränkung erwähnen. |
| „nicht von einer unabhängigen Stelle geprüft“ | FAQ | **Ehrlich.** | beibehalten |
| „Dreischicht Post-Quantum Verschlüsselung“ | Code-Kommentare `MessageCrypto.js:3`, `WebRTCManager.js:4`, alter Web-Client `web/index.html:44, 153` | Kaskade ist real, bringt aber kaum Mehrschutz (ein Schlüssel). Auf der aktuellen Website **nicht** mehr beworben – gut. | Kommentare anpassen, `web/` als veraltet kennzeichnen. |
| „Per-contact safety code against MITM“ | `README.md:33` | **Ungenau:** Code ist pro Verbindung und wechselt ständig. | Nach V1 korrekt; bis dahin „pro Verbindung“. |
| „PIN … 4 Stellen Stunden, 6 Stellen Tage“ | `PIN_VAULT_DESIGN.md:131-136`, `SECURITY_AUDIT_2026-10-25.md:75` | *(Vermutung)* **zu optimistisch** (Argon2 vorab auslagerbar). | Messen, Zahl anpassen, Passphrase empfehlen. |
| `ENCRYPTION_STATUS` („keyEx: Kyber-768“, „pqSafe: true“) | `HybridCrypto.js:20-25` | Veraltet (kein Ratchet/X25519), aber nirgends angezeigt. | Entfernen. |

Fazit: Die **Website ist überwiegend ehrlich** (inkl. „nicht unknackbar“, „nicht geprüft“). Nachbessern sollten vor allem die
**App-Texte** („Post-Quanten“ pauschal) und die **PIN-Zahlen**.

---

## 6. Quellen

- Signal: The Double Ratchet Algorithm – https://signal.org/docs/specifications/doubleratchet/
- Signal: The PQXDH Key Agreement Protocol – https://signal.org/docs/specifications/pqxdh/
- Signal Blog (02.10.2025): „Signal Protocol and Post-Quantum Ratchets“ (SPQR/Triple Ratchet) – https://signal.org/blog/spqr/
- PQShield: „Diving into Signal’s New Post-Quantum Protocol“ – https://pqshield.com/?p=9081
- X-Wing KEM, `draft-connolly-cfrg-xwing-kem` – https://datatracker.ietf.org/doc/draft-connolly-cfrg-xwing-kem/
- Hybrid PQ/T KEMs, `draft-irtf-cfrg-hybrid-kems` – https://datatracker.ietf.org/doc/draft-irtf-cfrg-hybrid-kems/
- NIST FIPS 203 (ML-KEM) – https://csrc.nist.gov/pubs/fips/203/final
- Cremers, Dax, Medinger: „Keeping Up with the KEMs“ – https://eprint.iacr.org/2023/1933
- Schmieg: „Unbindable Kemmy Schmidt: ML-KEM is neither MAL-BIND-K-CT nor MAL-BIND-K-PK“ – https://eprint.iacr.org/2024/523
- KyberSlash – https://kyberslash.cr.yp.to/
- BouncyCastle: CVE-2024-14041 (KyberSlash in BC 1.73–1.77) – https://github.com/bcgit/bc-java/wiki/CVE%E2%80%902024%E2%80%9014041
- BouncyCastle: CVE-Übersicht 1.85 – https://github.com/bcgit/bc-java/wiki/CVE-summary-1.85
- BouncyCastle-Quelltext `MLKEMEngine`/`MLKEMGenerator` (Tag r1rv80) – https://github.com/bcgit/bc-java/tree/r1rv80/core/src/main/java/org/bouncycastle/pqc/crypto/mlkem
- OSV: CVE-2025-14813 – https://osv.dev/vulnerability/ROOT-APP-MAVEN-CVE-2025-14813 ; CVE-2026-5598 – https://osv.dev/vulnerability/ROOT-APP-MAVEN-CVE-2026-5598
- noble Security Advisories (keine veröffentlicht): https://github.com/paulmillr/noble-curves/security/advisories , https://github.com/paulmillr/noble-ciphers/security/advisories , https://github.com/paulmillr/noble-hashes/security/advisories
- noble-ciphers README, Abschnitt „Constant-timeness“ (AES-T-Tabellen) – https://github.com/paulmillr/noble-ciphers#constant-timeness
- Cure53-Audit der noble-Bibliotheken – https://cure53.de/audit-report_noble-crypto-libs.pdf
- Bernstein: Cache-timing attacks on AES – https://cr.yp.to/antiforgery/cachetiming-20050414.pdf
- Tor Proposal 355 (PQ-Circuit-Handshakes, Stand Entwurf) – https://spec.torproject.org/proposals/355-revisiting-pq.html
- RFC 5869 (HKDF) – https://www.rfc-editor.org/rfc/rfc5869
- RFC 9106 (Argon2) – https://www.rfc-editor.org/rfc/rfc9106
- OWASP Password Storage Cheat Sheet – https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Android `KeyGenParameterSpec.Builder#setUnlockedDeviceRequired` – https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setUnlockedDeviceRequired(boolean)
- NIST SP 800-38D (GCM, Nonce-Grenzen) – https://csrc.nist.gov/pubs/sp/800/38/d/final

---

## 7. Umsetzung (Stand 25.10.2026)

Branch `claude/krypto-haertung` (Basis `f0cfc02`, 1.1.0 + Tor 0.4.9.14), ein Commit je Punkt mit Tests. Alles Neue wird
über Fähigkeiten ausgehandelt und ist danach je Kontakt **klebrig** (kein Downgrade): `caps.sn = 2`, `caps.ratchet = 2`,
Tor-Anmeldung `av: 2`, äußere Schicht `ol: 2`, Verbindungsschlüssel `kx: 2`. Geräte mit 1.0/1.1 senden diese Felder
nicht und werden unverändert bedient (Kopplung, Gruppen, Anrufe). Gespeicherte Daten werden nur additiv erweitert.

| Commit | Punkt | Inhalt |
|---|---|---|
| `61919e9` | V4 | `held`-Vorrat ohne Sitzung 14 Tage; mit Sitzung nach Gleichschritt-Regel (`heldNeededSince`, neues Feld `sa`) – nur, was die Gegenseite noch brauchen kann; alte Zustände ohne `sa` weiter 30 Tage. Dabei gefunden: die 1.1-Regel (30 Tage / 32 Einträge) konnte bei langen Funkpausen ein noch benötigtes KEM-Geheimnis löschen (dauerhaft `kem-unknown`) – behoben, Test mit 20 Tagen Pause. |
| `380be2a` | V2 | Anrufe (1:1 und Gruppe) ausdrücklich ohne PQ-Versprechen in App (18 Sprachen), Teilen-Text, Website (de/en), `PLAY_STORE.md`, README; Hinweis beim Teilen des Einladungslinks (Code vergleichen); PIN-Rateaufwand ehrlich (`PIN_VAULT_DESIGN.md` §6, Audit-Text). |
| `eccfaff` | V1 | Sicherheitsnummer 30 Ziffern = HKDF(`AD_s`, Salz „malachi-safety-number-v2“), beide Seiten gleich, rollenunabhängig, stabil über Reconnects/Tor/Direkt-Upgrade; lokaler „verifiziert“-Zustand; Warnung nur bei echtem Sitzungswechsel; „Vorgestellt von …“-Banner erst nach „stimmt überein“ weg. Alte Gegenseite: alter Code mit Hinweis. |
| `79ada50` | V3 | Neue Chip-Schlüssel mit `setUnlockedDeviceRequired(true)` (API 28+, StrongBox/TEE mit Rückfall); bestehende Tresore beim nächsten Entsperren zweiphasig umgezogen (neuer Alias, neu einpacken, zurücklesen, prüfen, erst dann alt löschen; Abbruch an jeder Stelle getestet; Notfall-PIN behält ihren Schlüssel bis zum Neusetzen). Argon2id unverändert (begründet), Zeitmessung nur im Debug-Build. 4/6-stellig bleibt frei wählbar, nur ein kleines „i“. |
| `7cacde1` | K-11, K-09 | Tor-Anmelde-MAC v2 mit Längenpräfixen (`av: 2`); äußere Schicht v2 mit Schlüssel je Richtung und AAD (Version, Richtung, Zweck) (`ol: 2`). |
| `a92e440` | V5 | Verbindungsschlüssel v2: X25519 + ML-KEM-768 (X-Wing-artig), Transkript (ek, ct, beide X25519-Werte, Rollen, Version, Kettenkennung) als Salz, Kette an Anmelde-/Vorgänger-Geheimnis bzw. Einladungs-PSK; nur abgeleitete Teilschlüssel (`outer`, `ratchet-kem`, `legacy-code`). Schlüsselbestätigung implizit: scheitern die ersten drei Pakete, wird die Verbindung verworfen. |
| `084155e` | V6 | ML-KEM-Nachmischen im Ratchet alle 24 h / 100 Nachrichten (`pq_offer`/`pq_ct` nur durch den Ratchet, Bestätigung per `kid`, Write-Ahead, Verfall, Ratenbegrenzung). |
| `97cfacc` | V8 | BouncyCastle 1.80 → 1.86 (ML-KEM-Paket umgezogen, `KyberModule.kt` angepasst); Byte-Gleichheit für ML-KEM-768 und alle drei Argon2id-Verwendungen per JVM-Testvektoren belegt (gegen @noble, Node/RFC 9106 und BC 1.80); `@noble/*` exakt gepinnt; libwebrtc-Version in der APK exakt festgehalten. |

| Befund | Stand | Anmerkung |
|---|---|---|
| K-01 | erledigt | V1 (`eccfaff`). |
| K-02 | teilweise | Hinweis beim Teilen (V2), stabile Sicherheitsnummer (V1), PSK fließt über `kx: 2` in den Schlüssel (V5). Offen: Pflicht-Vergleich bei Link-Kopplung, flüchtige Onion je Einladung (Audit T4) – größerer Umbau der Kopplung. |
| K-03 | erledigt | Banner/„nicht verifiziert“ bis zur Bestätigung (V1). SAS per Anruf nach Vorstellung: mit V12. |
| K-04 | teilweise | Texte (V2). PQ für Anrufe (V9) offen – braucht Frame-Verschlüsselung oder PQ-DTLS. |
| K-05 | erledigt (ohne Passphrase) | V3. Passphrase zurückgestellt: es gibt keinen „PIN ändern“-Ablauf, die Notfall-PIN-Längenregel und die Fehlversuchssperre müssten mitwachsen, ein Downgrade würde aussperren (Begründung in `PIN_VAULT_DESIGN.md`). Chip-Latenz am Gerät messen (Debug-Log). Nachtrag 29.10.2026: „App-PIN ändern“ gibt es seit 1.3.0 (`PinChange.js`, `PinVault.changePin`, inkl. altem Wickel während der Umstellung); Passphrase weiterhin zurückgestellt. |
| K-06 | erledigt | V6. |
| K-07 | erledigt | V5. |
| K-08 | erledigt | V4 + V5 (nur abgeleitete Teilschlüssel, Argument (b) in `RATCHET_DESIGN.md` korrigiert). |
| K-09 | erledigt | `ol: 2`. Kaskade selbst beibehalten (V7 nur zur Hälfte, siehe K-15). |
| K-10 | erledigt | V1 (HKDF mit Label; alter Code nur noch für 1.0/1.1-Gegenseiten). |
| K-11 | erledigt | `av: 2` (= V11). |
| K-12 | teilweise | `org.jitsi:webrtc` exakt 124.0.0 (bisher dynamisch „124.+“). Update zurückgestellt, siehe unten. |
| K-13 | erledigt | 1.86 (enthält die 1.85-Fixe, verzweigungsfreies Entkapseln, Schlüssel-/Längenprüfung). |
| K-14 | erledigt | App und Web-Client exakt. |
| K-15 | offen | Kaskade unverändert; Website wirbt nicht mehr mit „dreifach“, nur der alte, abgeschaltete `web/`-Client (V14). |
| K-16 | bewusst offen | Wie im Bericht. |
| K-17 | erledigt | `MAX_SKIP`, Argument (b), README. |
| K-18 | offen | V14 (Altlasten) – kein Sicherheitsgewinn, nicht in dieser Runde. |
| K-19 | teilweise | `KyberModule` zerstört private Schlüssel nach Gebrauch (Java-Seite); Strings über die Bridge bleiben (C5). |
| K-20 | offen | V15. |
| K-21 | offen | V12. |

**libwebrtc-Update (K-12) – geprüft, zurückgestellt.** react-native-webrtc 155.0.0 (M155) erschien am 14.10.2026, 155.0.1
am 20.10.; `org.jitsi:webrtc` 155.0.1 am 22.10. Technisch machbar: gleiche Modulstruktur (Bridge-Module, laufen wie 124 über
die Interop-Schicht – die App läuft mit RN 0.86 bereits auf der Neuen Architektur, `newArchEnabled=true`), einzige
Build-Änderung `org.jitsi:webrtc:155.+`. Zurückgestellt, weil 31 Chromium-Versionen Sprung jede Verbindung und jeden Anruf
betreffen (DTLS/SCTP/ICE alt↔neu) und das nur auf echten Geräten geprüft werden kann. Plan: (1) nach ≥ 4 Wochen ohne neue
Fehlerwelle `react-native-webrtc` exakt auf 155.0.x heben und den Pin in `android/app/build.gradle` mitziehen (der Test
`supplyChain.cryptoPins` erzwingt die passende Hauptversion); (2) JS-Änderungen gegen `CallManager`/`GroupCallManager`/
`WebRTCManager` prüfen; (3) 16-KB-Ausrichtung der neuen `.so` prüfen (124: arm64/x86_64 ausgerichtet); (4) Gerätematrix
neu↔1.1 (M124) und neu↔neu: Kopplung über Tor, Direkt-Upgrade, Nachrichten/Medien, 1:1-Audio/Video, Gruppenanruf,
Netzwechsel, Hintergrund. SBOM je Release (Audit R3) gehört in die Release-Checkliste (`npm sbom`, CycloneDX für Gradle).

**Datenerhalt.** Keine Änderung entfernt gespeicherte Werte: neue Felder (`sa`, `rv`, `pq`, `safety_v2_*`, `conn_caps_*`,
`key`/`prevKey`/`duressKey` im PIN-Tresor) sind additiv; ein 1.1-Speicherabbild wird in den Tests unverändert gelesen und
weiterbenutzt; der PIN-Tresor zieht nur mit Rücklese-Probe um; BouncyCastle 1.86 rechnet byte-gleich zu 1.80.
