# PIN-Tresor und Sprachnachrichten ohne Klartext-Datei (Stand 25.10.2026)

Ziel (Nutzerwunsch, Audit 2026-10-25 E1/E2): Wer das Handy samt App-Daten in
die Hände bekommt – auch entsperrt, auch mit forensischen Werkzeugen –, soll
ohne die **App-PIN** keine Chats lesen können. Und keine andere App soll
Sprachnachrichten mitschneiden oder als Datei finden können.

## 1. Was vorher war

- Alle Daten lagen in `EncryptedStorage` (Android Keystore). Diese
  Verschlüsselung öffnet das **Gerät** selbst – ohne App-PIN. Die App-PIN war
  nur ein Sperrbildschirm, und sie lag selbst (wie die Notfall-PIN) in
  diesem Speicher.
- Sprachnachrichten wurden als lesbare `.mp4`-Datei im Cache aufgenommen und
  zum Abspielen wieder als Datei entschlüsselt. Beide wurden zwar kurz danach
  gelöscht, lagen aber ungeschützt im Speicher, und bei einem Absturz blieben
  sie liegen.

## 2. PIN-Tresor (`PinVault.js`, `vault/MalachiPinKeyModule.kt`)

```
kek   = HMAC-SHA256_Chip( Argon2id(PIN, Salz, 32 MiB, t=3) )   nativ, Schlüssel "malachi_pin_v1"
wrap  = XChaCha20-Poly1305(kek, DEK)                            im Tresor-Datensatz
priv  = XChaCha20-Poly1305(DEK, X25519-Privatschlüssel)         im Tresor-Datensatz
pub   = X25519-öffentlicher Schlüssel                           im Tresor-Datensatz (offen)
Wert  = "pv1:d:" XChaCha20-Poly1305(DEK, Wert, AD = Schlüsselname)
```

- **DEK** (Tresorschlüssel, 32 Byte Zufall) liegt nur im Arbeitsspeicher –
  nach PIN- oder Fingerabdruck-Eingabe – und wird beim Sperren überschrieben.
- **Chip:** Ohne den nicht exportierbaren HMAC-Schlüssel (StrongBox, sonst
  TEE) dieses Geräts ist kein einziger Rateversuch möglich. Eine kopierte
  App-Datei lässt sich nirgends durchprobieren.
- **Die PIN wird nicht mehr gespeichert.** Geprüft wird, ob sie den DEK
  öffnet. Die Notfall-PIN liegt nur als Prüfwert
  `HMAC(kek_notfall, "duress")` vor. Eine Ableitung pro Eingabe prüft beides.
- **Fingerabdruck:** eine Kopie des DEK, verschlüsselt mit einem AES-GCM-
  Schlüssel im Keystore. Dieser ist nur nach starker Biometrie im
  Systemdialog nutzbar (CryptoObject, jede Nutzung einzeln) und wird
  ungültig, sobald ein neuer Fingerabdruck hinzukommt. Ein reiner
  „Ja/Nein“-Dialog wie bisher öffnet nichts mehr.
- **Sperren:** beim Sperrbildschirm sofort, im Hintergrund nach derselben
  Frist wie der Sperrbildschirm (60 s, bei Systemdialogen 10 min).
- **Löschen** (Alles löschen, Notfall-PIN, 5 Fehlversuche mit Pro):
  Tresor-Datensatz und Chip-Schlüssel werden vernichtet. Damit sind alle
  verschlüsselten Verläufe sofort unlesbar, auch Reste.

### Was PIN-gebunden ist

| Daten | Schutz |
|---|---|
| Chatverläufe 1:1 (`chat_<id>`) und Gruppen (`gchat_<id>`) | DEK |
| Schlüssel der Medien-Dateien (stehen in den Verläufen) | DEK (indirekt) |
| Vorschautexte der Chatliste (`last`) | versiegelt (siehe 3) |
| Schlüssel der Empfangs-Ablage (`rx_inbox`) | versiegelt |
| App-PIN, Notfall-PIN | nicht mehr gespeichert bzw. nur Prüfwert |

### Was bewusst NICHT PIN-gebunden ist

Der Hintergrunddienst muss ohne PIN Verbindungen halten und Nachrichten
annehmen und zustellen. Er braucht deshalb:

- Kontakte (Name, Onion-Adresse, Gruppen-ID),
- Verbindungs- und Ratchet-Schlüssel,
- die **Sende-Warteschlange**, also noch nicht zugestellte eigene
  Nachrichten (nach Zustellung gelöscht),
- Gruppen-Stammdaten (Name, Mitglieder) und Einstellungen.

Diese Daten bleiben wie bisher geräteverschlüsselt. Wer sie lesen kann, sieht,
**mit wem** man Kontakt hat, aber keine Inhalte – außer noch nicht
zugestellten eigenen Nachrichten.

### Chip-Schlüssel „nur bei entsperrtem Gerät“ (Krypto-Review 2026-10-25, V3)

- Neue Tresore nutzen den HMAC-Schlüssel `malachi_pin_v2`, angelegt mit
  `setUnlockedDeviceRequired(true)` (ab Android 9; StrongBox, sonst TEE). Der
  Chip rechnet damit nur, solange das **Gerät** entsperrt ist: Wer ein gesperrtes
  Gerät (auch gerootet) in die Hände bekommt, kann über den Chip keine
  PIN-Versuche anstoßen. Nimmt ein Gerät das Merkmal nicht an, wird ohne
  erzeugt (Datensatz `keyFlags.unlockedRequired = false`).
- Bestehende Tresore (`malachi_pin_v1`) werden beim nächsten Entsperren **mit
  PIN** umgestellt – ohne Nutzeraktion und ohne dass je ein Wert verloren gehen
  kann:
  1. neuen Schlüssel anlegen, DEK neu wickeln (gleiches Salz), Chip zweimal
     rechnen lassen und vergleichen, Wickel probeweise öffnen;
  2. Datensatz **und** Sicherung schreiben, beide zurücklesen und prüfen; der
     alte Wickel bleibt als `prevKey` im Datensatz; schlägt die Probe fehl, wird
     der alte Stand wiederhergestellt;
  3. erst bei einem **späteren** Entsperren, das nachweislich über den neuen
     Schlüssel lief, fällt `prevKey` weg (wieder zurückgelesen) und danach der
     alte Chip-Schlüssel.
  Lässt sich der neue Schlüssel zwischen 1 und 3 nicht nutzen, öffnet `prevKey`
  den Tresor und die Umstellung wird zurückgenommen (erneuter Versuch nach 30
  Tagen). Ein Abbruch an jeder Stelle hinterlässt einen Datensatz, den ein
  vorhandener Schlüssel öffnet (Tests: `pinVault.keyUpgrade.test.js`, Absturz
  nach 0/1/2 Schreibvorgängen in beiden Schritten, Rückleseprobe, kaputter
  Schlüssel).
- **Notfall-PIN:** Ihr Prüfwert hängt am Chip-Schlüssel, die Notfall-PIN ist
  beim Entsperren aber nicht bekannt. Deshalb bleibt der alte Schlüssel nach der
  Umstellung nur noch dafür erhalten (`duressKey`), bis die Notfall-PIN neu
  gesetzt oder entfernt wird. Eine Eingabe prüft weiterhin beides mit **einer**
  Argon2id-Rechnung (`deriveKeys`: Argon2id einmal, HMAC je Schlüssel).
- Fingerabdruck: unverändert (eigener Keystore-Schlüssel, wickelt den DEK).
  Die Umstellung braucht die PIN; wer nur den Fingerabdruck nutzt, wird beim
  nächsten PIN-Entsperren umgestellt.
- **Argon2id-Parameter bleiben** (32 MiB, t = 3): Argon2id hängt nur von PIN
  und lesbarem Salz ab und lässt sich vorab auf fremder Hardware rechnen; höhere
  Werte würden jedes Entsperren verlangsamen, den Angriff aber kaum. Wirksam
  sind der Chip und die PIN-Länge. Messung am Gerät: Debug-Build, Logcat
  `MalachiPinKey: Zeit: Argon2id … ms, Chip-HMAC … ms` (nur Debug).
- **PIN-Länge:** 4 und 6 Stellen bleiben gleichwertige Wahl; bestehende PINs
  funktionieren unverändert. In der Ersteinrichtung erklärt ein kleines „i“ auf
  Antippen kurz den Unterschied – kein Dialog, keine Empfehlung.
- **Passwort statt PIN:** siehe Abschnitt 6.

## 3. Empfangen bei gesperrter App

- Gesperrt geschriebene Werte und Änderungen werden **versiegelt**
  (`"pv1:s:"`: Sealed Box aus X25519 + HKDF-SHA256 + XChaCha20-Poly1305).
  Schreiben geht mit dem öffentlichen Schlüssel, lesen erst entsperrt.
- 1:1-Nachrichten landen wie bisher in der Empfangs-Ablage. Neu: Der
  Dateischlüssel liegt versiegelt (`ks`) im Index. Nach einem Neustart
  bleiben solche Einträge liegen, bis entsperrt wird
  (`RTCStore.ensureInboxRestored`).
- Gruppennachrichten, Häkchen und Löschungen ändern einen gesperrten Verlauf
  nicht direkt. Sie landen als versiegelte Einträge im Journal `vj_<key>`
  (höchstens 3000 je Verlauf). Beim ersten Lesen nach dem Entsperren werden
  sie eingearbeitet (`registerMerger`: `BackgroundSync.applyChatOps`,
  `GroupMessaging.applyGroupChatOps`). Das Einarbeiten ist idempotent:
  doppelt Zugestelltes wird entdoppelt, und Häkchen werden nie
  zurückgestuft.
- **Gesperrt wirft das Lesen eines Verlaufs**, statt „leer“ zu liefern. Sonst
  würde der nächste Schreibvorgang den echten Verlauf überschreiben (die
  Fehlerklasse D2 vom 25.10.).

## 4. Update von 1.0 (Datenerhalt)

1. Nach dem Update liegt noch alles im alten Format vor; die App verhält
   sich bis zum ersten Entsperren exakt wie 1.0.
2. Erstes Entsperren mit der **alten PIN**: Der Tresor entsteht aus dieser
   PIN, eine vorhandene Notfall-PIN wird zum Prüfwert. Erst nach einer
   erfolgreichen Probe werden die Klartext-PIN und die Notfall-PIN entfernt.
   Scheitert das Anlegen (kein nutzbarer Chip), bleibt alles wie in 1.0.
3. Danach (`afterVaultUnlock`) werden alle Verläufe verschlüsselt. **Jeder
   Wert wird zurückgelesen und verglichen**; weicht er ab, bleibt der
   Klartext stehen und es wird beim nächsten Entsperren erneut versucht.
   Vorschautexte und die Empfangs-Ablage werden versiegelt.
4. Fingerabdruck: Nach dem Update muss einmal die PIN eingegeben werden,
   danach wird der Fingerabdruck an den Tresor gebunden.

Abgesichert durch `__tests__/security/update.pinVaultMigration.test.js`. Der
Test geht über den echten Sperrbildschirm: 1.0-Speicher, Entsperren mit der
alten PIN, Neustart, Notfall-PIN, Chip-Ausfall und Neuinstallation.

## 5. Sprachnachrichten (`SecureAudio.js`, `vault/MalachiSecureAudioModule.kt`)

- **Aufnahme:** `AudioRecord` → AAC-LC (MediaCodec, 16 kHz, mono,
  32 kbit/s) → ADTS-Rahmen in einen Puffer im Arbeitsspeicher. Es entsteht
  keine Datei. Ab Android 11 öffnet die App das Mikrofon als
  „privacy sensitive“: keine andere App, auch kein Assistent und keine
  Bedienungshilfe, kann gleichzeitig mitschneiden. Seit Android 9 bekommen
  Hintergrund-Apps ohnehin nur Stille.
- **Wiedergabe:** `MediaPlayer` mit `MediaDataSource` direkt aus dem
  Arbeitsspeicher, auch für alte `.mp4`-Nachrichten. Danach wird der Puffer
  überschrieben.
- **Kompatibilität:** Ältere Malachi-Versionen spielen ADTS ab, weil
  Androids Spieler das Format am Inhalt erkennt und nicht an der Endung. Das
  muss auf Geräten bestätigt werden (Release-Prüfliste).
- **Rückfallweg** ohne natives Modul (nur Tests): der bisherige Weg mit
  kurzer Cache-Datei.

## 6. Grenzen (ehrlich)

- **Rateversuche am Gerät mit Root:** Wer Code als App auf dem Gerät
  ausführen kann, kann den Chip nutzen. Die frühere Angabe „4 Stellen
  Stunden, 6 Stellen Tage“ (rund 0,5–1 s pro Versuch) war zu optimistisch
  (Krypto-Review 2026-10-25, K-05): Argon2id hängt nur von PIN und Salz ab,
  das Salz ist lesbar – ein Angreifer kann Argon2id für alle PINs vorab auf
  eigener Hardware berechnen. Am Gerät bleibt nur der Chip-HMAC je Versuch
  (TEE: wenige Millisekunden, StrongBox: deutlich mehr; *nicht gemessen*).
  Grobe Schätzung: 4 Stellen eher Minuten, 6 Stellen Stunden (TEE) bis etwa
  einen Tag (StrongBox). Mit Pro wird nach 5 Fehlversuchen gelöscht, aber das
  schützt nur die Oberfläche. Eine längere PIN oder ein Passwort verlängert
  das entsprechend; welche Länge passt, entscheidet jede und jeder selbst.
  Seit V3 rechnet der Chip nur bei entsperrtem Gerät – der Angriff braucht
  also zusätzlich ein entsperrtes Gerät.
- **Passwort statt PIN (optional, zusätzlich zu 4/6 Stellen):** in V3 bewusst
  zurückgestellt. Kryptografisch ist nichts zu tun (der Tresor nimmt jede
  Zeichenkette, Argon2id + Chip). Den Weg zum nachträglichen Ändern gibt es
  seit 1.3.0 („App-PIN ändern“, `PinChange.js` / `PinVault.changePin`:
  alte PIN prüfen, DEK neu wickeln – auch den alten Wickel während der
  Umstellung –, Rücklese-Probe, PIN-Länge im selben Datensatz). Für ein
  Passwort fehlen weiterhin eine Texteingabe im Sperrbildschirm samt
  Fehlversuchszähler und Fingerabdruck, eine neue Regel für die Notfall-PIN
  (bisher „genau so lang wie die PIN“, damit niemand am Bildschirm erkennt,
  welche eingegeben wird), und ein Downgrade auf 1.1 würde mit Passwort
  aussperren (dessen Sperrbildschirm kennt nur Ziffern). Das soll als eigener,
  am Gerät geprüfter Schritt kommen.
- **Laufender Prozess:** Solange die App entsperrt ist, liegt der DEK im
  Arbeitsspeicher. Wer dann den Prozessspeicher liest (Root, Exploit), kommt
  heran.
- **Schadsoftware mit Root** kann das Mikrofon auch auf Systemebene
  abgreifen; `privacy sensitive` schützt nur gegen normale Apps.
- Die Hintergrund-Daten aus Abschnitt 2 bleiben geräteverschlüsselt.
