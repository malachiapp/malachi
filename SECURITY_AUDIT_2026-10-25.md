# Sicherheitsaudit 25.10.2026 – neue Funktionen, Daten auf dem Gerät, Updates, EU-Haftung

Branch `claude/features-okt26`. Der Audit läuft nach dieser Funktionsrunde:
- Lautsprecher im Anruf
- Sprachnachrichten mit Wellenform
- Siegel-Knopf auf dem Startbildschirm
- Kopplung per Kennung
- Vorstellen über die Gruppe
- Kanal-Modus

Die Funktionen sind in Abschnitt 1 einzeln bewertet. Der Audit ergänzt [SECURITY_AUDIT_2026-10-19.md](SECURITY_AUDIT_2026-10-19.md). Was dort geprüft und behoben ist, wird hier nicht wiederholt.

**Vorgehen:**
- Jede neue oder geänderte Datei wurde gelesen.
- Jeder Befund wurde am Code nachvollzogen, behobene Befunde haben einen Test.
- Am Ende lief die komplette Jest-Suite (100 Dateien, über 1.600 Tests, alle grün) und ein Android-Build (`assembleWebDebug`) ohne Fehler.

**Prioritäten:** P1 = vor dem nächsten Release beheben · P2 = bald · P3 = dokumentiert, später.

**Status:**
- ✅ behoben bzw. erfüllt (mit Test)
- 📝 dokumentiert (bewusst so bzw. Empfehlung)
- ⏳ offen

> **Hinweis:** Abschnitt 5 fasst öffentlich zugängliche Informationen zur Rechtslage zusammen. Er ist **keine Rechtsberatung**. Bitte vor dem nächsten Release von einer Anwältin oder einem Anwalt (IT-/Produkthaftungsrecht) prüfen lassen.

---

## 1. Neue Funktionen

| ID | Prüfung | Prio | Status |
|---|---|---|---|
| F1 | **Lautsprecher (1:1 und Gruppe):** Das Umschalten läuft über Telecom (Android 14+: CallEndpoints, davor `setAudioRoute`), ohne Telecom über den AudioManager. Es werden keine Daten verarbeitet. Beim Anrufende wird zurückgesetzt. | – | ✅ `__tests__/calls/speaker.test.js` |
| F2 | **Wellenform:** 48 Stufen (Text aus 32 Zeichen) reisen nur im (Ratchet-)verschlüsselten End-Marker und werden beim Empfang streng geprüft (Regex, 8–64 Zeichen). Gespeichert werden sie nur im verschlüsselten Verlauf. Die Wellenform verrät dem Empfänger nichts, was er nicht ohnehin hört; Dritte sehen sie nie. Ungültige oder gefälschte Werte werden verworfen. | – | ✅ `__tests__/voice/*` |
| F3 | **Siegel vom Startbildschirm:** reine Oberfläche. Versiegeln braucht weiter die Vollversion, Entsiegeln ist frei – wie in den Einstellungen. | – | ✅ |
| F4 | **Kopplung per Kennung statt Telefonnummer:** <ul><li>Kennungen werden vereinheitlicht (NFKC, Leerraum, Kleinschreibung).</li><li>Mindestens 8 Zeichen.</li><li>Unsichtbare und Bidi-Zeichen werden abgelehnt, nicht still entfernt.</li><li>Domänentrennung zu Nummern (`id:` gegenüber `+`).</li><li>Die Telefon-Kopplung ist unverändert und kompatibel mit 1.0.</li><li>Kennungen werden nie gespeichert oder gesendet.</li></ul> | – | ✅ `phonePairing.identifier.test.js` |
| F4a | Rest-Risiko: Wer **beide** Kennungen errät, kann sehen, dass gerade gekoppelt wird, oder die Kopplung stören. Mitlesen kann er nicht, das verhindert der Pflicht-Vergleich des 6-stelligen Codes. Bei schwachen Kennungen wie Vornamen ist dieser Vergleich über einen zweiten Weg (Anruf, persönlich) unverzichtbar; die App weist darauf hin. | P3 | 📝 Stärke-Anzeige (E5) |
| F5 | **Vorstellen über die Gruppe:** <ul><li>Zustimmung beider wird auf dem jeweiligen Gerät erzwungen: Ohne eigenes „Verbinden“ wird nie eine Einladung erzeugt oder benutzt.</li><li>Admin-Nachrichten zählen nur vom aktuellen Admin.</li><li>Ablehnen ist still.</li><li>Höchstens 30 Wünsche je Mitglied und Tag.</li><li>Einladungen sind einmalig, höchstens 3 Tage gültig und liegen nur verschlüsselt vor (EncryptedStorage, Warteschlange des Admins). Sie werden beim Wipe verworfen.</li><li>Ältere App-Versionen ignorieren die neuen Nachrichten.</li></ul> | – | ✅ `groups.intro.test.js`, `groupIntroPairing.test.js` (21 Tests) |
| F5a | **Vertrauensmodell:** Der Admin reicht die Einladung weiter und könnte sich – wie bei jeder Vorstellung über Dritte – aktiv dazwischensetzen. Er erfährt außerdem, wer mit wem in Kontakt treten möchte. Gegenmaßnahme: Der neue Chat zeigt „Vorgestellt von …“ und empfiehlt den Vergleich des Sicherheitscodes, bis er einmal geöffnet wurde. | P3 | 📝 bewusst so (Nutzerwunsch: Austausch über den Admin) |
| F6 | **Kanal:** <ul><li>Jeder Abonnent bekommt einen eigenen Stand (Admins und er selbst, dazu nur die Anzahl). Im Test steht auf einem Abonnenten-Gerät nirgends die Mitglieds-ID eines anderen.</li><li>„Nur Admins schreiben“ setzen Admin und Abonnenten durch.</li><li>Austritte gehen nur an den Admin.</li><li>Verlässt der letzte Admin den Kanal, wird er geschlossen.</li><li>Höchstens 250 Abonnenten.</li></ul> | – | ✅ `groups.intro.test.js` |
| F6a | Rest: Auf dem Admin-Gerät sind alle Abonnenten Kontakte. Jede Kanal-Nachricht geht einzeln an jeden Abonnenten; bei vielen Abonnenten dauert die Zustellung entsprechend und braucht Akku. | P3 | 📝 |

## 2. Fehler mit Datenverlust (gefunden und behoben)

| ID | Befund | Prio | Status |
|---|---|---|---|
| D1 | **Eigene Sprachnachricht ohne Inhalt im Verlauf:** Die gesendete Sprachnachricht stand nur mit Dauer und Status im Verlauf, ihr Inhalt fehlte. Sie wurde deshalb nie (verschlüsselt) abgelegt, war beim Absender nicht abspielbar und nach einem Neustart weg. Bilder und Dateien waren nicht betroffen. | P1 | ✅ Inhalt im Eintrag, Ablage über MediaVault; Test |
| D2 | **Verlauf und Medien beim Öffnen eines Chats verloren (beide Seiten):** <ul><li>Kamen beim Öffnen neue Nachrichten an, bevor der gespeicherte Verlauf geladen war, wurde dieser unvollständige Stand gespeichert.</li><li>Das Aufräumen verwaister Dateien löschte danach **die verschlüsselten Dateien aller älteren Sprachnachrichten und Bilder** dieses Chats, weil der unvollständige Stand nicht auf sie zeigte.</li></ul> | P1 | ✅ `MediaVault.persistChatHistory`: Gespeichert und aufgeräumt wird nur noch ein Stand, der den geladenen Verlauf enthält. Tests stellen genau diesen Ablauf nach. |
| D2a | Bereits gelöschte Dateien lassen sich nicht wiederherstellen; der Verlaufseintrag bleibt, ist aber nicht mehr abspielbar. | – | 📝 im Release-Hinweis erwähnen |
| A1 | **Eigenes Profilbild verschwand „manchmal“ (Startbildschirm, Einstellungen):** Gespeichert war nur der Pfad der Klartext-Kopie aus der Bildauswahl im Cache. Die Bereinigung beim Start löscht genau diese Kopien, und Android darf den Cache jederzeit leeren. | P2 | ✅ `OwnAvatar.js`: Das Bild wird verkleinert und verschlüsselt über MediaVault abgelegt, in EncryptedStorage stehen nur Verweis und Schlüssel. Alte Einträge werden ohne Verlust übernommen. Tests in `profile.ownAvatar.test.js` |
| A2 | **Folgefehler zu A1:** Fehlte die Bilddatei, warf der Profilversand beim Verbindungsaufbau eine Ausnahme. Danach wurde **die Warteschlange dieses Kontakts nicht gesendet** – wartende Nachrichten konnten bis zur nächsten Verbindung hängen bleiben. | P1 | ✅ Ein fehlendes Bild bricht nichts mehr ab; Test schlägt mit dem alten Code fehl |

## 3. Daten auf dem Gerät (Ruhezustand)

| Ort | Inhalt | Schutz | Status |
|---|---|---|---|
| EncryptedStorage (Android Keystore, AES-GCM) | Kontakte, Gruppen, Schlüssel, Ratchet-Zustände, Einstellungen, Warteschlangen-Index, Vorstellungs-Einladungen, Onion-Schlüssel | verschlüsselt, Schlüssel im Keystore | ✅ |
| **PIN-Tresor** (Nachtrag, E1) | Chatverläufe (1:1, Gruppen), Vorschautexte der Chatliste, Schlüssel der Empfangs-Ablage | zusätzlich mit einem Schlüssel, der nur nach PIN/Fingerabdruck im Arbeitsspeicher liegt (Argon2id + Chip). App-PIN nicht mehr gespeichert, Notfall-PIN nur als Prüfwert. [PIN_VAULT_DESIGN.md](PIN_VAULT_DESIGN.md) | ✅ |
| `media/<bereich>/*.enc` | Bilder, Sprachnachrichten, Dateien | je Datei eigener Schlüssel; Schlüssel nur im verschlüsselten Verlauf | ✅ |
| `queue_*.enc`, `inbox_*.enc` | Warteschlange, Empfangs-Ablage | je Eintrag eigener Schlüssel | ✅ |
| Tor | Onion-Schlüssel: nur EncryptedStorage, der Dienst wird flüchtig angelegt (`ADD_ONION`). Netzkonsens und Wächter liegen im App-Ordner. | kein Klartext-Schlüssel auf der Platte | ✅ / 📝 Konsens enthält keine Kontakte oder Inhalte |
| Siegel-Tresor | eigener Tresor | eigenes Passwort (Argon2id) | ✅ |
| Cache: Aufnahme bzw. Wiedergabe | Sprachnachrichten: **keine Datei mehr** (Nachtrag E2: Aufnahme und Wiedergabe im Arbeitsspeicher, Mikrofon „privacy sensitive“). Dateien zum Öffnen oder Teilen weiterhin kurz im Cache | Teilen: Bereinigung beim Start; Wipe leert den Cache | ✅ (Audio) / 📝 Teilen ist eine bewusste Weitergabe |
| Backups | – | Cloud-Sicherung und Geräteumzug ausgeschlossen | ✅ |
| Protokolle | – | Release ohne Konsolenausgaben; Warnungen ohne Inhalte, Namen oder IDs (auch die neuen) | ✅ |
| Sperrbildschirm, Zwischenablage, Bildschirm | – | neutrale Benachrichtigungen; Zwischenablage nach 60 s geleert; Bildschirmschutz (Secret Chat und Siegel immer) | ✅ |

**Grenzen, ehrlich benannt:**
- Die Verschlüsselung im Ruhezustand hängt am Android-Keystore, nicht an der App-PIN. Sie schützt gegen
  - das Auslesen von Dateien,
  - Backups,
  - andere Apps,
  - ein ausgeschaltetes Gerät (zusätzlich Android-Dateiverschlüsselung).
- Wer auf einem entsperrten, **gerooteten** Gerät oder per Schadsoftware mit Root-Rechten Code als Malachi ausführen kann, kann die Keystore-Schlüssel benutzen. Absoluten Schutz gegen einen solchen Angriff bietet keine App. Ihn deutlich zu erschweren ist Empfehlung E1.
- **Nachtrag (umgesetzt):** E1 ist umgesetzt. Verläufe und Vorschauen brauchen jetzt die App-PIN (bzw. den an den Tresor gebundenen Fingerabdruck). Weiter nur geräteverschlüsselt sind, was der Hintergrund-Empfang ohne PIN braucht: Kontakte, Verbindungsschlüssel, die Sende-Warteschlange (noch nicht zugestellte eigene Nachrichten) und Einstellungen. Rateversuche am gerooteten, entsperrten Gerät: Die frühere Angabe „4 Stellen Stunden, 6 Stellen Tage“ war zu optimistisch (Krypto-Review 2026-10-25, K-05 – Argon2id lässt sich vorab auf fremder Hardware rechnen, seriell bleibt nur der Chip). Grobe, nicht gemessene Schätzung: 4 Stellen eher Minuten, 6 Stellen Stunden (TEE) bis etwa einen Tag (StrongBox); eine längere PIN oder ein Passwort verlängert das entsprechend. Details: `PIN_VAULT_DESIGN.md` Abschnitt 6.

## 4. Updates ohne Datenverlust

| ID | Prüfung | Prio | Status |
|---|---|---|---|
| U1 | **Diese Version ändert kein Speicherformat:** Neue Felder (Gruppenart, Vorstellen, Wellenform, „vorgestellt von“) kommen nur hinzu. Ein nachgestellter Speicher aus 1.0 bleibt beim Start der neuen Version bitgenau erhalten, und es entstehen keine neuen Schlüssel. | – | ✅ `update.dataPreservation.test.js` |
| U2 | **Kein stilles Überschreiben:** Schreibketten für Kontakte und Gruppen brechen bei unlesbaren Daten ab, statt eine leere Liste zu schreiben. Dazu kommen D2 und die Prüfung „Verlauf geladen“. | – | ✅ |
| U3 | **Update-Weg:** Gleiche App-ID und gleiche Signatur bedeuten, dass Android die Daten behält. Website-APK und Play-Version sind **getrennte Apps** (eigene ID und eigener Schlüssel). Ein Wechsel ist eine Neuinstallation; die Daten bleiben in der alten Installation. | P2 | 📝 E3 (verschlüsselter Export/Import), Hinweis auf Website/FAQ |
| U4 | **Release-Regel für jede künftige Formatänderung:** Migration nur additiv oder mit Sicherungskopie. Pflichttest gegen ein Speicherabbild der Vorversion. Kein `clear()` und kein Entfernen außerhalb von Wipe, Löschen oder Ablauf. | – | 📝 als Checkliste übernommen (Abschnitt 6) |
| U5 | **Gewollter Datenverlust ohne Software-Fehler:** Deinstallation, „Alle Daten löschen“, Duress-PIN, 5 Fehlversuche, verlorenes Gerät. Das ist Absicht und muss für Nutzer klar beschrieben sein. | P2 | 📝 FAQ/Website (R6) |

## 5. EU-Haftung und Pflichten (Stand 25.10.2026, keine Rechtsberatung)

### 5.1 Neues Produkthaftungsrecht (Umsetzung der Richtlinie (EU) 2024/2853)
- **Stand des Gesetzes:**
  - Der Bundestag hat das Gesetz zur Modernisierung des Produkthaftungsrechts am **8. Oktober 2026** beschlossen.
  - Anwendung ab dem **9. Dezember 2026** für Produkte, die ab dann in Verkehr gebracht werden. Vorher in Verkehr gebrachte Versionen fallen unter das alte Recht.
  - Eine wesentlich geänderte neue Version gilt als neu in Verkehr gebracht.
- **Software ist ein Produkt.** Ausgenommen ist freie Software nur, wenn sie **außerhalb einer Geschäftstätigkeit** entwickelt oder bereitgestellt wird. Malachi wird mit kostenpflichtiger Vollversion vertrieben und fällt damit voraussichtlich **unter das Gesetz**.
- **Ersatzfähiger Schaden:**
  - Leben, Körper, Gesundheit,
  - Sachen,
  - **Verlust oder Beschädigung privat genutzter Daten**.

  Fehler wie D1 und D2 sind genau diese Art Risiko.
- **Updates:** Das Produkthaftungsrecht kennt keine allgemeine Update-Pflicht. Beruht ein Fehler aber auf einem Sicherheitsupdate, das der Hersteller hätte liefern können, entlastet das nicht.
- **Kein Ausschluss:** Gegenüber Geschädigten lässt sich die Haftung nicht vertraglich ausschließen.
- **Beweis:**
  - Die Beweislast bleibt beim Geschädigten.
  - Gerichte können die Herausgabe von Unterlagen anordnen.
  - Ein Fehler wird vermutet bei offensichtlicher Fehlfunktion oder bei Verstoß gegen verpflichtende Sicherheitsanforderungen (ab 2027 die des CRA).
- **Fristen:** Verjährung 3 Jahre ab Kenntnis. Erlöschen 10 Jahre nach dem Inverkehrbringen.

### 5.2 Cyber Resilience Act (Verordnung (EU) 2024/2847)
- **Seit 11. September 2026 gelten die Meldepflichten**, auch für schon verkaufte Produkte. Bei aktiv ausgenutzten Schwachstellen und schweren Sicherheitsvorfällen:
  - Frühwarnung innerhalb von **24 Stunden**,
  - Meldung innerhalb von 72 Stunden,
  - Abschlussbericht (Schwachstelle: 14 Tage nach Verfügbarkeit der Korrektur).

  Gemeldet wird über die zentrale Meldeplattform (ENISA) an die nationale Stelle, in Deutschland das BSI.
- **Ab 11. Dezember 2027 gilt alles Übrige:**
  - Sicherheitsanforderungen (Anhang I)
  - Schwachstellenmanagement mit SBOM
  - festgelegter Supportzeitraum (in der Regel mindestens 5 Jahre)
  - kostenlose Sicherheitsupdates
  - technische Dokumentation
  - Konformitätsbewertung und CE-Kennzeichnung

  Messenger-Apps gehören nach unserem Verständnis zur Standardkategorie (Selbstbewertung) – **rechtlich prüfen lassen**.

### 5.3 Was schon erfüllt ist
- Meldeweg für Schwachstellen ([SECURITY.md](SECURITY.md), privates Melden auf GitHub)
- offener Quellcode
- signierte Updates
- Versionsarchiv mit Prüfsummen
- Bedrohungsmodell ([SECURITY_ARCHITECTURE_THREAT_MODEL.md](SECURITY_ARCHITECTURE_THREAT_MODEL.md))
- Invariantenkatalog
- über 1.600 automatisierte Tests
- interne Audits (dieser und der vom 19.10.)
- kein Server mit Nutzerdaten (Datensparsamkeit)

### 5.4 Was noch fehlt (Empfehlungen)
| ID | Maßnahme | Wann | Wer |
|---|---|---|---|
| R1 | ✅ **Meldeablauf** steht in [SICHERHEITSVORFALL_ABLAUF.md](SICHERHEITSVORFALL_ABLAUF.md) (Fristen am Gesetzestext geprüft). Offen sind nur die Vorbereitungen in Abschnitt 0: EU-Login und Plattform-Adresse. | sofort | **Nutzer** (Konto) |
| R2 | ✅ **Entschieden (25.10.):** Sicherheitsupdates, solange Malachi angeboten wird, mindestens bis 31.12.2031, rollierend +1 Jahr pro Jahr, 12 Monate Vorankündigung. Siehe [SICHERHEITSUPDATES.md](SICHERHEITSUPDATES.md). Noch auf Website, Shop und Play veröffentlichen. | vor dem nächsten Release | Texte Claude, Veröffentlichung Nutzer |
| R3 | **SBOM je Release** (CycloneDX für npm und Gradle) automatisch im Release-Ordner ablegen. | bis Release | Claude |
| R4 | **Risikobewertung je Release** datieren: Bedrohungsmodell plus dieser Bericht. | je Release | Claude |
| R5 | **Release-Dokumentation**: Version, Datum, Artefakte mit Prüfsummen, Testlauf. Teilweise vorhanden; ergänzen. | je Release | Claude |
| R6 | **Nutzerinformation zu Grenzen**: Datenverlust bei Deinstallation, Duress, Root-Geräte, Website- und Play-Version getrennt. | bis Release | Claude (Texte), Nutzer (Freigabe) |
| R7 | **Versicherung prüfen** (Produkt- bzw. IT-Haftpflicht, die Software abdeckt). | bald | **Nutzer** |
| R8 | **Anwalt**: Einordnung (ProdHaftG/CRA), Bedingungen der Vollversion, Haftungsbegrenzung gegenüber Käufern (soweit zulässig). Stand 25.10.: kein Budget. Günstige Wege: Gründungsberatung der IHK (Erstberatung), Beratung über den Prototype Fund, Law Clinics an Hochschulen. | vor 9.12.2026 | **Nutzer** |
| R9 | **Unabhängiges Audit** beantragen (OTF Security Lab). | bald | Nutzer, Claude hilft |

## 6. Technische Empfehlungen und Release-Checkliste

| ID | Empfehlung | Prio |
|---|---|---|
| E1 | ✅ **Umgesetzt (Nachtrag 25.10.):** PIN-Tresor mit Migration ohne Datenverlust und Hintergrund-Empfang über versiegelte Einträge, siehe [PIN_VAULT_DESIGN.md](PIN_VAULT_DESIGN.md). Tests: `pinVault`, `pinVault.lockedDelivery`, `update.pinVaultMigration`. | – |
| E2 | ✅ **Umgesetzt:** Aufnahme und Wiedergabe nur im Arbeitsspeicher (`SecureAudio.js`, `MalachiSecureAudioModule.kt`), Mikrofon „privacy sensitive“. Test: `secureAudio`. | – |
| E3 | Verschlüsselter Export und Import (Gerätewechsel, Website ↔ Play) | P2 |
| E4 | Empfangs-Ablage erst freigeben, wenn der Chat den Verlauf gespeichert hat. Bisher gibt es ein kleines Zeitfenster beim Öffnen. | P3 |
| E5 | Kennungs-Kopplung: Stärke-Anzeige und Warnung bei sehr häufigen Kennungen | P3 |

**Checkliste vor jedem Release (neu):**
1. Komplette Testsuite und Update-Test gegen das Speicherabbild der Vorversion sind grün.
2. Keine Änderung entfernt oder überschreibt gespeicherte Daten außerhalb von Wipe, Löschen oder Ablauf.
3. Sicherheitsrelevante Änderungen werden in einem datierten Auditbericht festgehalten.
4. SBOM, Prüfsummen und Versionshinweis liegen im Release-Ordner.
5. Bekannt ausgenutzte Schwachstellen? Dann gilt der Meldeablauf R1.
6. Update auf echten Geräten: alte Version mit Daten → neue Version per Updater installieren → alte PIN → Verläufe, Sprachnachrichten (alt und neu, auch zwischen alter und neuer Version) und Gruppen prüfen.
7. Supportzeitraum-Datum (SICHERHEITSUPDATES.md) überall aktuell.

## Quellen
- Deutscher Bundestag, „Bundestag beschließt Modernisierung des Produkthaftungsrechts“ (KW 41/2026): https://www.bundestag.de/dokumente/textarchiv/2026/kw41-de-produkthaftungsrecht-1222456
- ITMR Legal, „Neues Produkthaftungsgesetz: Software, SaaS, KI ab 9.12.2026“: https://itmr-legal.de/blog/produkthaftungsgesetz-software-saas-ki
- Finite State, „Cyber Resilience Act Timeline: What Actually Happens in 2026 and 2027“: https://finitestate.io/blog/cyber-resilience-act-timeline-2026-2027
- DataGuard, „The Cyber Resilience Act timeline“: https://www.dataguard.com/cyber-resilience-act/timeline/
