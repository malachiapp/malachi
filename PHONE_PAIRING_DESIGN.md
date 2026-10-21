# Kopplung per Telefonnummer – serverlos über einen Tor-Treffpunkt

Stand: Okt. 2026 · Code: `PhonePairing.js`, `PhonePairingPanel.tsx`,
`TorTransport.js` (Rohverbindungen, Tunnel-Kanal), nativ
`MalachiTorModule.kt` (`argon2id`, `addRendezvousOnion`,
`removeRendezvousOnion`) · Tests: `__tests__/security/phonePairing.*.test.js`

## 1. Worum es geht

Zwei Menschen, die die Nummer des anderen kennen (typisch: sie telefonieren
gerade miteinander), wollen ohne QR-Code Kontakte werden. Beide öffnen
„Verbinden → Telefon“, geben **die eigene und die Nummer des anderen** ein und
tippen gleichzeitig auf „Verbinden“. Beide Apps finden sich über einen
**einmaligen Tor-Treffpunkt**, der nur aus den beiden Nummern und der
aktuellen Stunde ableitbar ist. Danach zeigen beide Handys einen
**6-stelligen Code**, den die beiden am Telefon vergleichen. Erst nach
„Stimmt überein“ auf **beiden** Handys läuft die ganz normale Kopplung – das
Ergebnis ist ein normaler Malachi-Kontakt (gleiche Schlüssel, gleiche
Onion-Adressen, Tor-Reserve, Direkt-Upgrade usw. wie nach dem QR-Code).

Die frühere Variante (Commit 57d6fa3) schickte einen SHA-256 der Nummern an
den eigenen Relay-Server, der die Partner zusammenführte. Sie ist mit dem
Server verschwunden (b16181e). Übernommen wurden nur Bedienideen (zwei
Nummernfelder, Telefon-Tastatur).

## 2. Warum kein Server

- Ein Treffpunkt-Server sähe, **wer wann mit wem** koppelt (Hash zweier
  Telefonnummern ist kein Schutz: der Nummernraum ist klein, ein Server kann
  ihn durchprobieren). Genau das soll nach der Vorgabe „nur P2P/Tor, nichts
  über den Server“ niemand sehen.
- Der Tor-Treffpunkt ist ein gewöhnlicher, flüchtiger v3-Onion-Dienst auf
  einem der beiden Handys. Die Tor-Verzeichnisse (HSDirs) speichern nur eine
  verschlüsselte Beschreibung unter einem **verblendeten** Schlüssel
  (rend-spec-v3) – ohne die Onion-Adresse können sie weder den Dienst noch
  die Nummern zuordnen.
- Es gibt keinen Betreiber, der abgeschaltet, gezwungen oder gehackt werden
  kann, und keine Infrastrukturkosten.

## 3. Ableitung des Treffpunkts

**Normalisierung (E.164):** Leerzeichen, Bindestriche, Klammern, Punkte,
Schrägstriche werden entfernt, „(0)“ fällt weg; Präfix `+` oder `00`; eine
führende `0` bedeutet Deutschland (`+49`). Bei +49/+43/+41 wird eine
fälschlich mitgetippte Vorwahl-Null entfernt (`+49 0176…`). Ohne Präfix ist
eine Nummer mehrdeutig und wird abgelehnt; Länge 8–15 Ziffern. Beide Seiten
müssen dieselbe Zeichenkette erhalten – daher strenge, deterministische Regeln.

```
pw     = "malachi-phone-rendezvous-v1|" + kleinere + "|" + größere Nummer   (E.164, sortiert)
salt   = SHA-256("malachi-phone-rendezvous-v1|bucket|" + floor(UTC-ms / 3 600 000))
master = Argon2id(pw, salt; m = 64 MiB, t = 3, p = 1, 32 Byte)
seed   = HKDF-SHA256(master, salt, "malachi-phone-rendezvous-v1|onion-ed25519", 32)
auth   = HKDF-SHA256(master, salt, "malachi-phone-rendezvous-v1|auth", 32)
onion  = v3-Adresse von Ed25519(seed)        (Prüfsumme nach rend-spec-v3)
key    = "ED25519-V3:" + Base64(clamp(SHA-512(seed)))   (64-Byte-Form, die tor erwartet)
```

- **Rollen:** Die Seite mit der lexikografisch kleineren E.164-Nummer ist
  **Gastgeber** (betreibt den Treffpunkt, im Kontakt später Rolle
  `initiator` wie der Einladende beim QR-Code), die andere ist **Gast**.
- **Zeitfenster:** Beide leiten die aktuelle **und** die vorige Stunde ab; der
  Gastgeber betreibt beide Dienste, der Gast probiert beide Adressen. Damit
  treffen sich zwei Geräte, deren Startzeit bzw. Uhr bis zu ~1 Stunde
  auseinanderliegt (Start kurz vor/nach dem Stundenwechsel). Pro Stunde ein
  neues Salz: Vorberechnungen gelten nur eine Stunde.
- **Argon2id statt scrypt:** Die App hat mit BouncyCastle 1.80 bereits eine
  native Argon2id-Implementierung (genutzt vom Siegel-Tresor). In JS wäre
  Argon2id auf Hermes (Interpreter) unbrauchbar langsam (Minuten), scrypt aus
  `@noble/hashes` mit sinnvollen Parametern (N=2^15, r=8) ebenfalls viele
  Sekunden und nur 32 MiB speicherhart. Deshalb ein **natives**
  `MalachiTor.argon2id` (eigener Thread, Läufe nacheinander, Eingaben werden
  danach überschrieben, OOM wird abgefangen). Ohne natives Modul bricht die
  Kopplung ab („unsupported“) – **kein** schwacher Ersatz, denn verschiedene
  KDFs auf beiden Seiten würden sich ohnehin nie treffen.
- **Parameter 64 MiB / t=3 / p=1** (RFC 9106, zweite Empfehlung, p=1 weil
  BouncyCastle ohnehin einfädig rechnet). Gemessen: BouncyCastle 1.80 auf der
  Desktop-JVM 214–253 ms je Lauf (Known-Answer-Test identisch zu
  Node/OpenSSL, siehe Test „Known-Answer“). Erwartung auf dem Handy (ART,
  langsamere Kerne): ~0,7–1,5 s je Lauf, also 1,5–3 s für beide Stunden –
  am oberen Rand des Ziels 0,5–2 s. **Am Gerät messen** (Logcat
  `MalachiTor: Argon2id (Treffpunkt): … ms`). Die Parameter sind Teil des
  Protokolls; eine Änderung braucht ein neues Label (`…-v2`), sonst finden
  sich alte und neue App-Versionen nicht.

## 4. Der Treffpunkt im Tor-Netz (nativ)

`addRendezvousOnion(keyBlob, expectedOnion)`:

- `ADD_ONION ED25519-V3:<key> Flags=DiscardPK Port=7777,127.0.0.1:<port>` –
  **ohne** `Detach`: der Dienst gehört der Steuerverbindung und verschwindet
  spätestens mit ihr bzw. mit dem tor-Prozess (App-Absturz, Tor-Neustart).
- Der Schlüssel wird vorher streng geprüft (`^ED25519-V3:[A-Za-z0-9+/]{86}==$`)
  – er landet in einer Zeile des Steuerprotokolls; ein Zeilenumbruch wäre eine
  Befehlsinjektion.
- tor muss genau die in JS berechnete Adresse melden, sonst wird der Dienst
  sofort entfernt. Bei „collision“ (dieselbe Adresse noch aus einem früheren
  Versuch) einmal entfernen und neu anlegen.
- Eigener Server-Socket nur auf `127.0.0.1`, höchstens 2 Treffpunkte und 16
  Verbindungen je Treffpunkt. Verbindungen kommen als
  `MalachiTorRendezvousIncoming {connId, onion}` – **nicht** als normale
  eingehende Verbindung (die normale Anmeldung von Kontakten sieht sie nie).
- `removeRendezvousOnion(onion)`: Server-Socket sofort zu, dann `DEL_ONION`.
  Bereits angenommene Verbindungen bleiben bestehen (tor schließt beim
  Entfernen eines flüchtigen Dienstes nur die Einführungskreise, nicht die
  Treffpunkt-Kreise) – JS schließt alles Überzählige selbst.
- Nichts davon wird geloggt außer „Treffpunkt-Dienst aktiv“ und der
  Argon2id-Dauer.

Der Gast verbindet sich über den vorhandenen Tor-Weg
(`TorTransport.connectRendezvous`: eigene SOCKS-Anmeldung = eigene Kreise je
Versuch, bei Fehlschlag `HSFETCH` der Beschreibung, bei „nicht gefunden“
`NEWNYM` – nur wenn kein anderer Kopplungsversuch läuft). Je Adresse ein
Versuch, nach 20 s Hängen ein paralleler zweiter, Pause 4 s bzw. 8 s nach
„nicht gefunden“, sofortiger neuer Versuch, sobald tor die Beschreibung
meldet (`HS_DESC RECEIVED`). Gesamtfenster 10 Minuten, jederzeit abbrechbar.

## 5. Handshake auf dem Tor-Strom

Zeilen-JSON, Kennung `t: "malachi-phone"`, Felder Base64 mit fester Länge.
H = Gastgeber, C = Gast.

| Schritt | Richtung | Inhalt |
|---|---|---|
| hello | H → C | `nH` (32), `pkH` (ML-KEM-768, frisch je Verbindung), `v: 1` |
| auth | C → H | `nC` (32), `commit = SHA-256(Label ‖ xC ‖ ctC ‖ rC)`, `macC` |
| keys | H → C | `xH` (X25519), `rH` (32), `macH` – erst **nach** `commit` |
| open | C → H | `xC`, `ctC = ML-KEM.Encaps(pkH)`, `rC` – muss zu `commit` passen |
| ready | H → C | erste Tunnelzeile (Schlüsselbestätigung) |

- `macC = HMAC(auth, "c-auth" ‖ onion ‖ nH ‖ SHA-256(pkH) ‖ nC ‖ commit)`,
  `macH = HMAC(auth, "h-auth" ‖ … ‖ xH ‖ rH)` – längenpräfixiert, an die
  Treffpunkt-Adresse gebunden, Vergleich in konstanter Zeit. Beweist beiden
  Seiten, dass das Gegenüber **beide** Nummern kennt.
- `ikm = X25519(xH, xC) ‖ ML-KEM-Geheimnis` (hybrid: ein Angreifer müsste
  X25519 **und** ML-KEM-768 brechen), `T = SHA-256(Label ‖ alle Felder)`.
- Aus `HKDF(ikm, salt = T)`: Tunnelschlüssel je Richtung, 5 Byte → **Code**
  (6 Ziffern „123 456“), 16 Byte → **Kontakt-ID** `c_…` (frisch je Kopplung,
  nicht aus den Nummern ableitbar).
- Tunnel: ChaCha20-Poly1305, eigener Schlüssel je Richtung, Nonce = strikt
  fortlaufender Zähler. Wiederholte, umgestellte, ausgelassene oder
  veränderte Zeilen sind nicht entschlüsselbar → Verbindung zu.

## 6. Pflicht-Vergleich des Codes (Schutz vor dem Mann in der Mitte)

Wer **beide** Nummern kennt, kann den Treffpunkt ableiten, sich als Gast beim
Gastgeber und als Gastgeber beim Gast ausgeben (er hat ja den
Anmeldeschlüssel) und beide Handshakes zu Ende führen. Dagegen hilft nur der
Code-Vergleich über einen zweiten Kanal – das laufende Telefonat:

- Beide Handys zeigen den Code aus ihrem Transkript. Bei einem Mann in der
  Mitte gibt es zwei Transkripte → mit überwältigender Wahrscheinlichkeit zwei
  verschiedene Codes.
- **Kein Ausprobieren möglich:** In jeder der beiden Sitzungen legt sich der
  Gast fest (`commit`), **bevor** er die Werte des Gastgebers kennt, und der
  Gastgeber sendet `xH`/`rH`, **bevor** er die Werte des Gasts kennt. Damit
  bestimmt in jeder Sitzung ein ehrlicher Teilnehmer Zufall, den der Angreifer
  zum Zeitpunkt seiner eigenen (endgültigen) Wahl nicht kennt. Er trifft je
  Versuch höchstens mit 1 : 1 000 000 – und jeder Fehlversuch ist für die
  Nutzer sichtbar („Stimmt nicht“).
- „Stimmt nicht“ verwirft alles (Tunnel, Schlüssel, Treffpunkt), meldet der
  Gegenseite den Abbruch und speichert **nichts**. Die normale Kopplung (und
  damit jede Speicherung) beginnt erst, wenn **beide** bestätigt haben.
- Frist für den Vergleich: 3 Minuten ab Anzeige.

## 7. Danach: normale Kopplung im Tunnel

Nach beiden Bestätigungen (die eigene Onion-Adresse reist dabei
verschlüsselt im Tunnel mit) übergibt `PhonePairing.js` die Verbindung als
Tunnel-Kanal an `TorTransport.attachPairingChannel` – dieselbe Funktion wie
bei der QR-Kopplung: Kyber-Schlüsseltausch von `WebRTCManager` (Gast =
Initiator wie der Scannende), Speichern des Geheimnisses unter der
Kontakt-ID, danach Profil, Onion-Adresse, Gruppen-ID wie bei jeder
Verbindung. Der Kontakt wird erst nach dem fertigen Schlüsseltausch an die
App übergeben (`onConnected` des Verbinden-Bildschirms). Die Verbindung
bleibt danach – wie nach der QR-Kopplung – als normale Kontaktverbindung
offen (doppelt verschlüsselt: Tunnel + Malachi-Protokoll); bricht sie ab,
verbinden sich die Geräte wie immer über ihre echten Onion-Adressen neu.
Bricht die Kopplung nach Beginn, aber vor der Übergabe ab, wird ein evtl.
schon gespeichertes Geheimnis wieder gelöscht.

## 8. Aufräumen

| Ereignis | Treffpunkt (DEL_ONION) | Verbindungen | Schlüssel/Nummern |
|---|---|---|---|
| erster gültiger Handshake | sofort entfernt | alle anderen zu | Treffpunkt-Schlüssel überschrieben |
| Erfolg | – | Gewinner bleibt als Kontaktverbindung | Tunnelschlüssel leben mit der Verbindung, beim Schließen überschrieben |
| Abbruch, Zeitablauf, „Stimmt nicht“, Abbruch der Gegenseite | entfernt | alle zu | alles überschrieben/verworfen |
| App in den Hintergrund | entfernt | alle zu | Eingabefelder geleert |
| Wipe (PIN-Fehlversuche, Notfall-PIN) | entfernt | alle zu | alles verworfen |
| Bildschirm verlassen / Sperre | entfernt | alle zu | Komponente weg |

Die Nummern stehen nur in den Eingabefeldern (werden beim Start sofort
geleert; angezeigt bleiben zwei Endziffern) und im Funktionsumfang der Sitzung
bis zur Ableitung. Sie werden nie geloggt, gespeichert oder gesendet. JS-
Zeichenketten lassen sich nicht überschreiben – sie werden sofort
losgelassen; alle abgeleiteten Schlüssel liegen in `Uint8Array`s und werden
überschrieben. Eingabefelder: Telefon-Tastatur, kein Autofill
(`importantForAutofill="no"`), keine Autokorrektur.

## 9. Bedrohungsmodell

**Netzbeobachter (Provider, WLAN):** sieht nur Tor-Verkehr (bzw. Bridges),
keine Nummern, keine Adressen.

**Angreifer ohne Nummer:** findet den Treffpunkt nicht (Adresse ist
pseudozufällig), kann ihn nicht betreiben (kein Schlüssel) und nichts
anmelden.

**Angreifer kennt EINE Nummer (A) und will wissen, mit wem A koppelt:**

- Online raten (Beschreibung jeder Kandidaten-Adresse abfragen) skaliert
  nicht: jede Abfrage ist ein Tor-Rundlauf, und vorher steht je Kandidat und
  Stunde ein Argon2id-Lauf.
- Ernsthafte Variante: er betreibt selbst HSDirs, sammelt verblendete
  Schlüssel und rechnet offline Kandidaten durch. Dafür muss er **zufällig**
  unter den ~6–8 für genau diese Beschreibung zuständigen HSDirs sein (die
  Auswahl wechselt je Zeitraum) **und** den Nummernraum durchrechnen:
  deutsche Mobilnummern grob 10^8–10^9 Kandidaten, je Kandidat Argon2id mit
  64 MiB (speicherhart; eine starke GPU schafft optimistisch ~10^3 Läufe/s).
  Das sind Stunden bis Tage GPU-Zeit **je Zielnummer und Stunde** – für
  einen einzelnen Neugierigen unrealistisch, für einen gut ausgestatteten
  staatlichen Angreifer mit vielen GPUs und HSDir-Präsenz machbar.
  **Ehrlich gesagt:** Telefonnummern haben wenig Entropie; Argon2id ist eine
  starke Bremse, kein absoluter Schutz der Beziehungs-Metadaten. Inhalte sind
  davon nie betroffen. Wer das nicht möchte, koppelt per QR-Code.
- Durch die Anmeldung kommt er ohne die zweite Nummer nicht (Test).

**Angreifer kennt BEIDE Nummern:**

- Kann die Adresse ableiten und so erkennen, **dass** A und B gerade koppeln
  (Beschreibung existiert in dieser Stunde) – dieses Wissen ist der Preis der
  serverlosen Variante; ohne Kenntnis beider Nummern ist er nicht zu erlangen.
- Kann stören (DoS): selbst eine Beschreibung für dieselbe Adresse
  veröffentlichen, sich als Erster melden oder den Treffpunkt mit Unsinn
  fluten. Begrenzt: 16 Verbindungen je Treffpunkt (nativ), 4 gleichzeitige
  Handshakes, nach 12 fehlerhaften Anmeldungen Abbruch mit Hinweis; jeder
  gültige Handshake beendet den Treffpunkt sofort (ein Angreifer, der zuerst
  da ist, führt zu einem Code nur auf EINEM Handy → die Nutzer sehen es).
- Kann einen Mann in der Mitte versuchen – scheitert am Pflicht-Vergleich
  (Abschnitt 6), Erfolgschance 10^-6 je sichtbarem Versuch.
- Kann **nicht** später einen Kontakt übernehmen: die Kontaktgeheimnisse
  entstehen im Tunnel aus frischen Schlüsseln, unabhängig von den Nummern.

**Tor-Metadaten:** HSDirs sehen Hochladen/Abrufen einer Beschreibung zu einem
verblendeten Schlüssel (Zeitpunkt, Größe), Einführungs- und Treffpunkt-Relais
sehen Kreise ohne Adresse. Wie bei jedem Onion-Dienst; nichts davon enthält
Nummern.

**Gerät:** Nichts auf Platte (nur der normale Kontakt nach Erfolg). Logs
enthalten weder Nummern noch Treffpunkt-Adressen noch Codes (Test durchsucht
alle Konsolen-Ausgaben und alle Speicher-Schreibvorgänge).

**Wiedereinspielung/Herabstufung:** frische Nonces und Schlüssel je
Verbindung, `v: 1` wird geprüft, das Label steckt in KDF, MACs, Transkript
und Tunnel.

## 10. Grenzen und offene Punkte

- Nur Android (Tor-Modul). Beide Handys brauchen diese App-Version.
- Nummern ohne Länderpräfix gelten als deutsch.
- Wird die App während der Kopplung verlassen (z. B. um im Telefon-App etwas
  nachzusehen), bricht sie ab – Hinweis „Lautsprecher nutzen, App offen
  lassen“.
- Am Gerät noch zu prüfen: siehe Abschlussbericht (Argon2id-Dauer und
  Speicher, ADD_ONION mit eigenem Schlüssel, Erreichbarkeit/Dauer bis zur
  Veröffentlichung, DEL_ONION lässt die laufende Verbindung bestehen,
  Verhalten nach Tor-Neustart während der Suche).
