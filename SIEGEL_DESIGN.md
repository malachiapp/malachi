# Siegel-Modus – Design

Stand: 2026-10-18 · Dateien: `SiegelCrypto.js`, `SiegelVault.js`, `SiegelScreen.tsx`, `SiegelFiles.js`,
`android/.../siegel/MalachiSiegelKeyModule.kt` · Tests: `__tests__/siegel/`

## Zweck

Texte, die über einen **fremden Messenger** (WhatsApp, Signal, SMS …) laufen,
Ende-zu-Ende verschlüsseln. Der Messenger sieht nur Geheimtext. Pro-Funktion.

## Leitprinzipien

1. **Unabhängig vom Rest der App.** Wer in Malachi hineinkommt – App-PIN bekannt,
   entsperrtes Gerät, Kopie der App-Daten, Forensik –, kann Siegel-Nachrichten
   trotzdem nicht entschlüsseln. Eigene Passphrase, eigene Kontakte, eigene
   Schlüssel; nichts wird aus Malachi-Geheimnissen abgeleitet.
2. **Zero Trace.** Es gibt keinen Verlauf. Gespeichert werden nur Schlüssel und
   der Ratchet-Zustand, nie Klartext. Entschlüsselter Text lebt nur im
   Arbeitsspeicher des Siegel-Fensters und wird beim Sperren oder Schließen
   verworfen. Eine Nachricht lässt sich nur **einmal** entschlüsseln.
3. **Nichts übers Netz.** Gekoppelt wird persönlich per QR-Code. Transportiert
   werden die Nachrichten vom fremden Messenger.

## Tresor (SiegelVault.js + MalachiSiegelKeyModule.kt)

- Der Tresorschlüssel entsteht so: `HMAC-SHA256_Chip( Argon2id(Passphrase, Salz; 32 MiB, t=3) )`.
  - Der HMAC-Schlüssel liegt im AndroidKeyStore (StrongBox, sonst TEE) und ist
    nicht exportierbar. Damit braucht jeder Rateversuch den Chip **dieses**
    Geräts; eine Datenkopie lässt sich nirgends sonst durchprobieren.
  - Argon2id (BouncyCastle) ist speicherhart und bremst das Raten auch auf
    Spezialhardware.
- Der Inhalt wird mit XChaCha20-Poly1305 verschlüsselt und liegt zusätzlich im
  verschlüsselten Speicher der App (`siegel_vault_v1`).
- Fehlversuche:
  - Nach dem 4. Fehlversuch gelten Wartezeiten von 30 s, 1 min, 5 min,
    15 min und 1 h.
  - Beim **10. Fehlversuch** wird gelöscht, samt Chip-Schlüssel.
- Der Tresor sperrt sich, sobald die App in den Hintergrund geht, und nach
  60 s ohne Bedienung. Während ein Kopplungscode angezeigt wird, bleibt er bis
  zu 5 min offen.
- „Alles löschen“ und die Duress-PIN der App vernichten den Siegel-Tresor mit
  (`performWipe` → `siegelWipe()`).
- Mindestlänge der Passphrase: 8 Zeichen, empfohlen sind 4 Wörter. Eine
  vergessene Passphrase ist nicht wiederherstellbar. Dann ist nur der
  Siegel-Tresor weg, Malachi bleibt.

## Kopplung (SiegelCrypto.js)

1. A zeigt die **Einladung**: `MSI1:` + base32(`01 | nonce16 | X25519-pub | ML-KEM-768-pub`).
2. B scannt sie und rechnet Folgendes:
   - `ct, ss = Encaps(kemPk)`
   - `dh = X25519`
   - `T = SHA-256(Label | nonce | xA | kemPkA | xB | ct)`
   - `root = HKDF(dh‖ss, salt=T)`

   B wird „Alice“ des Double Ratchet und legt seine erste (leere) Nachricht
   gleich in die Antwort. Dadurch kann danach **jede** Seite zuerst schreiben.
3. B zeigt die **Antwort**: `MSA1:` + base32(`02 | xB | ct | conf16 | erste Nachricht`).
4. A scannt die Antwort, prüft die Bestätigung, initialisiert „Bob“ und öffnet
   die erste Nachricht.
5. Beide sehen den **Sicherheitscode** (6 × 5 Ziffern aus T) zum Vergleichen.

Nur base32 (A-Z2-7) und `:` → der QR-Code nutzt den kompakten alphanumerischen
Modus (~2000 Zeichen).

## Nachrichten

- Format: `MS1:` + base64url(`01 | d32 | pn u32 | n u32 | nonce24 | Chiffrat`).
- Ratchet: DoubleRatchet.js mit X25519, HKDF und XChaCha20-Poly1305. Die
  Header-Felder sind authentifiziert.
- Länge: Der Klartext wird vor dem Verschlüsseln auf feste Größen
  (64/256/1024/4096/16384/65536 Byte) aufgefüllt. Sichtbar ist nur die
  Größenklasse.
- Senden: Der neue Ratchet-Zustand wird **vor** der Herausgabe des Geheimtexts
  gespeichert. Danach geht der Geheimtext über „Teilen“ direkt in den
  Messenger, ohne Zwischenablage. „Kopieren“ leert die Zwischenablage nach 60 s.
- Empfangen:
  - Die Nachricht wird aus der Zwischenablage gelesen; danach wird die
    Zwischenablage geleert.
  - Die Nachricht wird auch mit Begleittext oder Zeilenumbrüchen gefunden.
  - Wurde die Nachricht schon einmal entschlüsselt, kommt der Hinweis „bereits
    entschlüsselt“.
  - Eine veränderte Nachricht oder eine für einen anderen Kontakt wird
    abgelehnt; der Zustand bleibt dabei unverändert.

## Anhänge (Bild, Sprachnachricht, Datei)

- Format der Siegel-Datei (`.sgl`):
  `MSF1` (4 Byte) | u32 Kopflänge | Kopf | Blob.
  - **Kopf** = Ratchet-Umschlag genau wie der MS1-Rumpf (`01 | d32 | pn | n | nonce24 | Chiffrat`).
    Klartext ist aufgefülltes JSON
    `{ t:'media', k:'image'|'audio'|'file', m:MIME, n:Name (≤ 100 Zeichen), s:Größe, key:Dateischlüssel, h:SHA-256(Blob) }`.
  - **Blob** = `nonce24 | XChaCha20-Poly1305(Dateischlüssel, Inhalt, AD "malachi-siegel-media-v1")`.
    Der Dateischlüssel (32 Byte) ist für jede Datei neu und zufällig.
  - Art, MIME-Typ und Name stehen nur im verschlüsselten Kopf.
  - `h` bindet den Blob an den Kopf: ein fremder Blob wird abgelehnt.
- Höchstens **16 MB** Inhalt.
- Wie bei Text arbeitet die Krypto auf einer Kopie des Ratchet-Zustands:
  - Senden (`sealMediaFor`): Der Zustand wird gespeichert, **bevor** die Datei herausgegeben wird.
  - Öffnen (`openMediaAny`): Alle Kontakte werden nacheinander probiert.
  - Fehlercodes: `format`, `used` (nur einmal zu öffnen), `auth` (fremd oder verändert), `too-long`.
  - Bei einem Fehler bleibt der Zustand unverändert.
- Ein Anhang-Kopf, der als `MS1:`-Text eingefügt wird, wird nicht als
  Nachricht angezeigt.
- **In Malachi:**
  - Aus dem Chat geöffnet (`onSendFile`), geht der Anhang als Datei
    `siegel-<Zufall>.sgl` (`application/octet-stream`) über den normalen,
    verschlüsselten Dateiversand (`sendFileNow`) in den Chat. Danach sperrt sich Siegel.
  - Im Chat erscheint die Datei als kompakte Blase „Siegel-Anhang“. Wer sie antippt,
    öffnet Siegel (`initialMedia`). Nach dem Entsperren wird der Anhang entschlüsselt.
- **Außerhalb (WhatsApp & Co.):**
  - „Teilen“ schreibt die Siegel-Datei in den Cache und übergibt sie mit
    `FileShareModule.shareFile`.
  - Empfangen: Die Datei im Messenger speichern, dann in Siegel „Siegel-Datei öffnen“ wählen (Dateiauswahl).
- **Schreiben (Reiter „Verschlüsseln“):**
  - „Bild“: Bildauswahl mit höchstens 2048 px und Qualität 0,8. Dabei wird das Bild neu kodiert,
    EXIF-Daten wie der Ort gehen verloren. Die Kopie der Auswahl im Cache wird sofort gelöscht.
  - „Datei“: Dateiauswahl.
  - „Sprachnachricht“: Aufnahme in den Cache, höchstens 5 min. Beim Stoppen wird die Datei gelesen
    und sofort gelöscht.
- **Zero Trace bei der Anzeige:**
  - Ein Bild steht nur im Arbeitsspeicher (data:-URI).
  - Eine Sprachnachricht liegt nur während der Wiedergabe als Cache-Datei vor. Sie wird
    beim Ende, beim Stoppen, beim Sperren und beim Schließen gelöscht.
  - Eine sonstige Datei zeigt nur Name und Größe. „Öffnen/Teilen“ gibt es erst nach einer Warnung,
    denn damit verlässt die Datei Siegel.
  - Beim Sperren und Schließen wird alles aus dem Speicher des Fensters verworfen.
- **Temporäre Dateien** liegen nur in `<Cache>/malachi_siegel/`, jede in einem
  eigenen Unterordner mit Zufallsnamen. Geleert wird der Ordner:
  - beim Schließen und beim nächsten Öffnen von Siegel,
  - beim App-Start (`cleanupSiegelTemp`),
  - beim Wipe der App (`performWipe` entfernt `malachi_*` im Cache).
- **Systemdialoge** (Galerie, Dateiauswahl, Mikrofon-Berechtigung) schicken die
  App in den Hintergrund. Währenddessen sperrt der Tresor nicht sofort
  (`holdOpen`), aber spätestens nach 3 min.
- **Abweichung vom ersten Entwurf:** Der Blob-Inhalt wird vor dem Verschlüsseln
  mit Nullen auf eine Größenklasse aufgefüllt (Padmé, mindestens 1 KiB, höchstens etwa 12 % Aufschlag).
  `s` im Kopf gibt die echte Länge an. So ist wie bei Text nur eine grobe
  Größenklasse sichtbar statt der genauen Byte-Zahl.

## Bewusste Grenzen

- Ab der Kopplung sind die Ratchet-Schritte klassisch (X25519). ML-KEM schützt
  den Startschlüssel; ein späterer Angreifer mit Quantenrechner bräuchte
  zusätzlich einen kompromittierten Zwischenzustand.
- Der Messenger sieht weiterhin, wer wann mit wem schreibt. Nur der Inhalt und
  die genaue Länge sind geschützt.
- Gegen Schadsoftware, die im Moment des Entschlüsselns mitliest (Root/Implantat),
  hilft keine App.
- Ein Angreifer mit Codeausführung in der App könnte den App-seitigen Zähler
  der Fehlversuche umgehen. Das Raten bleibt dann an den Chip und an Argon2id
  gebunden.
- Tastatur: Das Eingabefeld nutzt `visible-password`; gängige Tastaturen lernen
  dabei keine Wörter. Eine vollständige Inkognito-Kennung (IME-Flag) folgt bei
  Bedarf nativ.
- Anhänge:
  - Der Messenger sieht, dass eine `.sgl`-Datei verschickt wird, und ihre ungefähre Größe.
  - Für Wiedergabe und „Öffnen/Teilen“ braucht Android einen Dateipfad. Diese Datei liegt kurz
    im Cache der App und wird so früh wie möglich gelöscht.
  - Was eine fremde App mit einer geteilten Datei macht, liegt außerhalb von Siegel.
  - Androids Bildanzeige (Fresco) kann das entschlüsselte Bild noch eine Weile im
    Arbeitsspeicher-Cache halten. Auf den Datenträger kommt es nicht.
