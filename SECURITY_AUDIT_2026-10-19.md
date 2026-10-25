# Release-Audit 1.0.0 (19.10.2026)

Sechs unabhängige, nur lesende Prüfdurchläufe:
- Krypto/Siegel
- Netz/Tor/Kopplung
- Gruppen/Anrufe
- Shop/Server/Website
- Datenschutz/Logs/Löschen
- Android-Plattform

Jeder Befund wurde vor dem Fix am Code nachvollzogen.

**Priorität:**
- **P1** – vor dem Release beheben
- **P2** – möglichst vor dem Release
- **P3** – dokumentiert, später

**Status:**
- ✅ behoben (mit Test)
- 🔧 in Arbeit
- ⏳ offen
- ❌ verworfen (mit Begründung)
- 📝 dokumentiert (bewusst so bzw. nach dem Release)

## Gruppen und Anrufe
| ID | Befund | Prio | Status |
|---|---|---|---|
| G1 | Bilder/Sprachnachrichten als Base64 in EncryptedStorage (eine SharedPreferences-Datei) – auch im 1:1-Chat. Viele Medien: Speicher bläht sich auf, OOM bis zum Startabbruch. Gruppen-Medien von Nicht-Mitgliedern landen in `groups_pending`. | P1 | ✅ Medien als einzeln verschlüsselte Dateien (MediaVault.js), im Verlauf nur Verweis+Schlüssel, Altbestand wird ausgelagert; Gruppen-Rückstand für Medien nur im RAM; Bild-Limit 6 MB |
| G2 | Gruppenanruf: eingeladenes, nicht beigetretenes Mitglied kann per eigenem Angebot mithören | P1 | ✅ |
| G3 | 1:1-Videoanruf über System-Benachrichtigung angenommen → Kamera ohne Hinweis | P1 | ✅ |
| G4 | Verlassene Gruppe kehrt durch verspäteten Admin-Stand zurück („Zombie“) | P2 | ✅ Einladung nur durch ausdrückliches Hinzufügen (`change.mids`) bzw. Erstellen durch den Ersteller |
| G5 | Mitglied kann im Einladungs-Wettlauf Admin-Rolle bei Dritten übernehmen | P2 | ✅ Ersteller fest (`createdBy`), Widerspruch verworfen; der Ersteller holt eine angeeignete Admin-Rolle zurück (mit Hinweis im Verlauf) |
| G6 | Admin kann Änderungen anderen Mitgliedern zuschreiben (`change.by`) | P2 | ✅ Hinweise nennen immer den tatsächlichen Absender |
| G7 | Unbegrenzte Gruppen-Einladungen je Kontakt | P2 | ✅ höchstens 64 Gruppen, 16 je einladendem Kontakt |
| G8 | Entfernte Mitglieder bekommen noch eingereihte Inhalte | P2 | ✅ Austritt/Entfernen verwirft wartende Texte/Medien an dieses Mitglied |
| G9 | Klartext-Audio im Cache nach Abbruch; Bidi-/Nullbreiten-Zeichen in Namen | P2 | ✅ Klartext-Reste beim Start entfernt (P12); Namen ohne Bidi-/Nullbreiten-Zeichen (TextSafety.js) |

## Shop / Server / Website
| ID | Befund | Prio | Status |
|---|---|---|---|
| S1 | `monero-installieren.sh`: GPG-Prüfung umgehbar (unsignierter Text nach der Signatur, `sha256sum -c` ohne `--strict`), Binary läuft als root | P1 | ✅ Signatur nur über den signierten Block, `sha256sum --strict`, Binary nicht als root |
| S2 | Globale Ratenbegrenzung: anonymer Client blockiert Bestellung/Widerruf/Umzug | P1 (Widerruf/Umzug) / P2 (pro Tor-Kreis) | ✅ Grenzen je Tor-Kreis (PROXY-Protokoll), Zählung erst nach gültiger Bestellung |
| S3 | `set_daemon` ohne Proxy verliert Tor (Verdacht) | – | ❌ Live mit v0.18.5.4 geprüft: globaler `--proxy` bleibt aktiv, eigener Proxy je Knoten wird sogar abgelehnt; zusätzlich `IPAddressDeny` in der Unit. |
| S4 | Widerruf nach Bereitstellung (nur bei abweichender Konfiguration): Beleg behauptet „Lizenz ungültig“ | P2 | ✅ Beleg unterscheidet „Lizenz ausgestellt“ / „keine Lizenz“ |
| S5 | Kraken-Prüfwerkzeug läuft als root | P2 | ✅ Prüfung per `systemd-run` als malachi-shop mit `LoadCredential` |

## Datenschutz / Logs / Löschen
| ID | Befund | Prio | Status |
|---|---|---|---|
| P1 | Secret-Chat-Inhalte werden beim Empfänger dauerhaft gespeichert (Medien ohne `secret`, Puffer nach `secret_end`) | P1 | ✅ Medien/Texte als `secret` markiert, nie gespeichert; RAM-Puffer endet mit `secret_end`; abgelaufene Secret-Inhalte verworfen |
| P2 | Benachrichtigungen überstehen Duress/Wipe | P1 | ✅ `cancelAll` beim Wipe, nur „Neue Nachricht“ |
| P3 | Klartext-Bildkopien des Image-Pickers im Cache überstehen den Wipe | P1 | ✅ Cache beim Wipe komplett geleert |
| P4 | Onion-Identität (laufender Tor, Einladungen im RAM, torrc/state) überlebt den Wipe | P1 | ✅ Tor-Wipe (Dienst, Einladungen, Daten) |
| P5 | Logcat: SecretTrace im Release aktiv (Kontakt-ID-Präfixe, Wipe-Spur), Kontaktname in Warnung | P1 | ✅ SecretTrace nur in Debug, keine Namen/IDs in Warnungen, Release ohne Konsolenausgaben |
| P6 | Kontaktname auf dem Sperrbildschirm (Nachricht, Anruf, Telecom) | P1 | ✅ neutrale Texte („Neue Nachricht“, „Malachi-Anruf“) |
| P7 | „Alle Daten löschen“ lässt Kontakte/Gruppen/Avatare im UI-Zustand bis zum Neustart | P1 | ✅ `resetUiAfterWipe` für beide Lösch-Wege |
| P8 | Secret Chat: Galerie-Speichern, Koordinaten, Datei öffnen nicht gesperrt | P2 | ✅ Galerie, Karten-App, Koordinaten kopieren und Datei öffnen im Secret Chat gesperrt |
| P9 | Nominatim auch in „Privat“/„Nur Tor“ und im Secret Chat; eindeutiger User-Agent | P1 | ✅ Ortsauflösung nur in „Schnell“, nie im Secret Chat |
| P10 | Tastatur lernt Chat-Eingaben | P3 | ✅ Secret Chat: keine Vorschläge/Autokorrektur/Autofill (Android: NO_SUGGESTIONS). Ein vollständiges „Inkognito-Tastatur“-Flag bietet React Native nicht – dokumentiert |
| P11 | Einladungscode/Zahlungsdaten ohne geschützte Zwischenablage; Wipe leert Zwischenablage nicht | P2 | ✅ Einladungscode, Zahlungsdaten, Gerätecode nur geschützt (sensibel, 60 s); Wipe leert die Zwischenablage |
| P12 | Temp-Dateien (`play_*`, `malachi_*`) nur teilweise beim Start aufgeräumt | P2 | ✅ Start räumt `play_*`, `malachi_*`, Bildauswahl-Kopien auf |
| P13 | App-Icon nach Duress erst beim nächsten Hintergrundwechsel zurückgesetzt | P3 | 📝 bewusst: Android beendet die App, wenn der aktive Starter-Eintrag umgeschaltet wird – direkt nach der Notfall-PIN wäre das auffällig. Umschalten beim nächsten Wechsel in den Hintergrund |
| P14 | Fernlöschung: Reste beim Empfänger (`theirName`, `safety_code_seen_*`) | P3 | ✅ vom zurückgesetzten Kontakt bleibt nur „Wiped Kontakt“ – Name, Profilbild, Onion-Adresse, Gruppen-ID, Sicherheitscode entfernt |

## Android-Plattform
| ID | Befund | Prio | Status |
|---|---|---|---|
| A1 | Geräteumzug kopiert App-Daten trotz `allowBackup=false` (keine `dataExtractionRules`) → EncryptedStorage fällt still auf Klartext-SharedPreferences zurück | P1 | ✅ `dataExtractionRules`, EncryptedStorage ohne Klartext-Rückfall (patch-package) |
| A2 | Onion-Dienst/Treffpunkt auf 127.0.0.1-TCP: andere Apps können die globale Sperre auslösen/Plätze belegen | P2 | ✅ keine globale Sperre mehr, höchstens 12 unangemeldete Verbindungen, 8-KB-Zeilenlimit bis zur Anmeldung (nativ). Rest: siehe „Restrisiken“ |
| A3 | Einladungslink `malachi://connect` mit PSK über nicht-exklusives Schema | P3 (App Links brauchen eigene Domain) | 📝 App Links brauchen eine eigene, verifizierte Domain (kommt mit der Website); bis dahin enthält der Link nur ein Einmal-Geheimnis mit 30 min Gültigkeit |
| A5 | Unbehandelte Exceptions in Telecom-/Dienst-Aufrufen → Absturz bei eingehendem Anruf möglich; Benachrichtigungs-Trampolin | P1 | ✅ Telecom-/Dienst-Aufrufe abgefangen |
| A6 | `taskAffinity` (Task-Hijacking auf alten Android-Versionen) | P2 | ✅ `taskAffinity=""` |
| A7 | Ungenutzte Berechtigung `READ_MEDIA_IMAGES`, ungenutzter `MediaProjectionService` | P2 | ✅ entfernt |

## Krypto / Siegel
| ID | Befund | Prio | Status |
|---|---|---|---|
| C1 | Ratchet: Senderichtung fällt dauerhaft aus, wenn > MAX_SKIP Schlüssel ungeöffnet verbraucht | P1 | ✅ `MAX_SKIP` 10000, alte übersprungene Schlüssel verfallen |
| C2 | Siegel: nach 72 h außer der Reihe unlesbar, Meldung „bereits entschlüsselt“ irreführend | P2 | ✅ Siegel 90 Tage außer der Reihe, klare Meldung |
| C3 | Profilbild/Chatbild-Kennung nicht authentifiziert | P2 | ✅ Kennzeichen nur innen (verschlüsselt), End-Marker entscheidet, mit Ratchet eigene Art `avatar` in den Zusatzdaten; nur außen gekennzeichnete Teile werden verworfen |
| C4 | Siegel-Wipe kann Duress-Wipe blockieren (OOM in Argon2 → Promise hängt) | P1 | ✅ Wipe mit Zeitlimit + direktes Löschen des Schlüssels |
| C5 | Tresorschlüssel/Passphrase als nicht löschbare Strings im Speicher | P3 | 📝 JavaScript kennt kein sicheres Überschreiben von Strings; Schlüssel als Uint8Array werden genullt, Tresor sperrt bei Hintergrund |
| C6 | `setup()` kann bei Lesefehler einen bestehenden Tresor vernichten | P2 | ✅ `vaultState()` dreiwertig, Einrichten/Entsperren bei Lesefehler verweigert |
| C7 | Play-Käufe übertragbar (Play-Variante noch inaktiv) | P3 | 📝 Play-Variante ist im Release nicht aktiv; vor Aktivierung serverlose Bindung prüfen |

## Netz / Tor / Kopplung
| ID | Befund | Prio | Status |
|---|---|---|---|
| T1 | = P9 (Nominatim umgeht „Nur Tor“) | P1 | ✅ siehe P9 |
| T2 | Telefon-Kopplung: Mann in der Mitte kann unsichtbar viele Codes vergleichen | P1 | ✅ Festlegung nach gültiger Anmeldung, weitere Verbindungen abgewiesen, Abbruch → sichtbarer Fehler „interrupted“ (Test phonePairing.flow „Audit T2“) |
| T3 | = A2 (globale Sperre eingehender Tor-Verbindungen) | P2 | ✅ siehe A2 |
| T4 | Dauerhafte Onion-Adresse in jedem Einladungslink; Code in normaler Zwischenablage | P2 (Zwischenablage) / P3 (flüchtiges Onion) | ✅ Zwischenablage geschützt (P11); flüchtige Onion je Einladung: P3, später |
| T5 | Tor-Wachen werden bis zu alle 12 h neu gewählt (Guard-Discovery in „Nur Tor“) | P1 | ✅ frühestens nach 30 Tagen, ab 3 Warnungen, nie in „Nur Tor“ |
| T6 | Uhrabweichung > 15/5 min: Texte werden endlos verworfen, ohne Hinweis | P1 | ✅ Zeitstempel wird lokal ersetzt statt Nachricht zu verwerfen |
| T7 | STUN-Betreiber können Kontaktpaare zeitlich korrelieren (Doku) | P3 | 📝 STUN nur im Verbindungsweg „Schnell“ (Standard), abschaltbar über „Privat“/„Nur Tor“; in Datenschutzerklärung und FAQ genannt |
| T8 | Überlappende Schlüsselbestätigung kann Kontakt unerreichbar machen (Verdacht) | P2 | ✅ Bestätigung nur, wenn das Secret dieser Verbindung das aktuelle ist – der Rückfall der neueren bleibt |

## Restrisiken (nach dem Release)
- **A2/T3 – lokaler Onion-Dienst-Port:** Tor leitet den Onion-Dienst an
  127.0.0.1 weiter; eine bösartige App auf demselben Gerät kann sich dort
  melden. Sie kann nichts lesen oder sich anmelden (gegenseitige HMAC-Anmeldung),
  aber durch viele hängende Verbindungen eingehende Tor-Verbindungen bremsen.
  Gegenmittel jetzt: keine globale Sperre, Obergrenze, 8-KB-Limit. Endgültig:
  Onion-Dienst auf einen Unix-Socket im App-Verzeichnis umstellen.
- **T4 – flüchtige Onion-Adresse je Einladung:** der Einladungslink enthält die
  dauerhafte Onion-Adresse. Später: eigene, kurzlebige Adresse je Einladung.
- **P10 – Tastatur:** React Native bietet kein „Inkognito“-Flag
  (IME_FLAG_NO_PERSONALIZED_LEARNING); im Secret Chat sind Vorschläge aus.

## Nachtrag 25.10.2026 – STUN-Ausstieg (STUN_AUSSTIEG_PLAN.md)
- **T7 erledigt:** Malachi fragt keinen STUN-Dienst mehr (kein Verbindungsweg
  „Schnell“, Stufen nur noch „Direkt, wenn möglich“ und „Maximal anonym“).
  Damit können keine STUN-Betreiber mehr Kontaktpaare zeitlich korrelieren.
  Rest: die Tor-Bridge Snowflake fragt in gesperrten Netzen eigene STUN-Server
  des Tor-Projekts (dokumentiert, `TorBridges.js`, Waechter-Test
  `noStun.static.test.js`).
- **P9/T1 endgültig:** die Ortsauflösung per Nominatim ist komplett entfernt –
  kein Verbindungsweg und keine Stufe fragt mehr OpenStreetMap
  (`location.noNominatim.test.js`).
