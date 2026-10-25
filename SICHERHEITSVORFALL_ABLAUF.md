# Ablauf bei Sicherheitslücken und Sicherheitsvorfällen (CRA-Meldepflicht)

Stand: 25.10.2026 · Grundlage: Cyber Resilience Act (Verordnung (EU)
2024/2847), Art. 14. Die Meldepflicht gilt seit dem **11.09.2026**.
Keine Rechtsberatung; der Wortlaut ist am Gesetzestext geprüft (Quellen
unten).

## 0. Vorher einmal erledigen (ohne Ernstfall)

- [ ] **EU-Login-Konto anlegen** (macht der Nutzer selbst). Darüber läuft
      die Registrierung auf der Meldeplattform der ENISA (Single Reporting
      Platform, SRP). Registrieren erst, wenn etwas zu melden ist; das
      Konto kann vorher angelegt werden.
- [ ] Die Adresse der SRP von der ENISA-Seite holen und hier eintragen:
      `__________________`
- [ ] Prüfen, welches CSIRT in Deutschland als Koordinator benannt ist
      (voraussichtlich das BSI), und hier eintragen: `__________________`
- [ ] `SECURITY.md` im Repo und auf der Website: Kontakt
      **MalachiApp@proton.me**, außerdem „Private vulnerability reporting“
      auf GitHub einschalten.
- [ ] Vorlage `sicherheitsvorfall-log.md` (Abschnitt 6) im Betriebshandbuch
      bereitlegen.

## 1. Meldung kommt rein → Uhr läuft

**Zeitpunkt notieren.** Die Frist beginnt, sobald nach erster Prüfung
*hinreichende Gewissheit* besteht, dass eine Schwachstelle **aktiv
ausgenutzt** wird oder ein **schwerwiegender Vorfall** vorliegt. Nicht schon
beim ersten Hinweis.

Fragen zur ersten Prüfung (höchstens wenige Stunden):

1. Ist die Lücke echt? Lässt sie sich nachvollziehen?
2. **Wird sie bereits ausgenutzt?** Etwa Berichte von Betroffenen, Code im
   Umlauf, Spuren auf dem Server.
3. Was ist betroffen: Nachrichteninhalte, Schlüssel, Update-Signatur,
   Lizenzen, Server/Website/Shop?

| Ergebnis | Weiter mit |
|---|---|
| Echt, aber **nicht** ausgenutzt | Abschnitt 4 (keine Meldepflicht, trotzdem schnell beheben) |
| **Aktiv ausgenutzt** | Abschnitte 2, 3 und 4 |
| **Schwerwiegender Vorfall** (z. B. Update-Signierschlüssel kompromittiert, manipuliertes Update verteilt, Server/Shop übernommen) | Abschnitte 2, 3 und 4; Abschlussbericht nach 1 Monat |

## 2. Melden: drei Stufen

Gemeldet wird über die **Single Reporting Platform** der ENISA. Die Meldung
geht damit gleichzeitig an das koordinierende CSIRT und an die ENISA.

| Stufe | Frist | Inhalt |
|---|---|---|
| **Frühwarnung** | unverzüglich, spätestens **24 h** | Was ist los (1–3 Sätze), in welchen EU-Ländern Malachi bereitgestellt ist (Website: weltweit; Play: Ländereinstellung) |
| **Meldung** | spätestens **72 h** | Produkt und Version, Art der Ausnutzung, ergriffene Maßnahmen, was Nutzer selbst tun können, wie vertraulich die Angaben sind |
| **Abschlussbericht** | spätestens **14 Tage**, nachdem die Korrektur verfügbar ist (bei schwerwiegendem Vorfall: **1 Monat** nach der Meldung) | Beschreibung, Schweregrad, Auswirkungen, bekannte Täter, bereitgestelltes Update |

> Für Kleinst- und Kleinunternehmen gibt es **keine Geldbuße** für das
> Verpassen der 24-h-Frist (Art. 64 Abs. 10). Die Pflicht zu melden bleibt.
> Lieber kurz und unvollständig melden als zu spät.

### Vorlage Frühwarnung

```
Produkt: Malachi (Android-Messenger), Hersteller: <Name/Firma laut Impressum>
Betroffene Versionen: <z. B. 1.0.0–1.1.0>
Art: <aktiv ausgenutzte Schwachstelle | schwerwiegender Sicherheitsvorfall>
Kurzbeschreibung: <ein bis drei Sätze, ohne Ausnutzungsdetails>
Bereitgestellt in: EU-weit (Download über die eigene Website, Google Play)
Kenntnis seit: <Datum, Uhrzeit>
Kontakt: MalachiApp@proton.me
```

## 3. Nutzer informieren (Art. 14 Abs. 8)

So bald wie möglich, spätestens mit dem Update:

- [ ] **Update-Hinweis** in der App (Versionshinweise; der Updater zeigt
      sie an)
- [ ] **Website**: Hinweis auf der Startseite und unter „Sicherheit“
- [ ] Bei Bedarf Social Media
- Inhalt: Was ist passiert? Wer ist betroffen? **Was muss ich tun?**
  (z. B. „Bitte auf Version X aktualisieren“, „Sicherheitscode mit Kontakten
  neu vergleichen“)
- Keine Ausnutzungsdetails, bevor die meisten aktualisiert haben

## 4. Beheben und ausliefern

1. Korrektur in einem eigenen Zweig, mit Test, der die Lücke nachstellt.
2. Komplette Testsuite plus **Update-Datenerhalt-Test**
   (`update.dataPreservation`, `update.pinVaultMigration`).
3. Version erhöhen und bauen (Menü 5), auf eigenen Geräten testen (Menü 6),
   veröffentlichen (Menü 3, Passphrase gibt der Nutzer ein). Play-Bundle
   (Menü 8).
4. Bei kompromittiertem **Update-Signierschlüssel**: ANLEITUNG 9.3 (neuer
   Schlüssel). Bestehende Installationen müssen dann einmal von Hand
   aktualisieren; die Nutzer darüber informieren (Abschnitt 3).
5. Nicht ausgenutzte Lücken: Advisory auf GitHub veröffentlichen, sobald
   das Update draußen ist. Wer gemeldet hat, wird genannt, wenn gewünscht.
   Üblich ist koordinierte Offenlegung nach spätestens 90 Tagen.

## 5. Danach

- Abschlussbericht (Abschnitt 2), Fristen im Log abhaken
- Ursache im Audit-Dokument nachtragen und einen Test, damit es nicht
  wiederkommt
- Bei Datenschutzbezug (personenbezogene Daten auf dem Server, z. B. im
  Shop): **zusätzlich** Meldung an die Datenschutzbehörde innerhalb von 72 h
  (DSGVO Art. 33) prüfen. Das ist eine andere Pflicht als der CRA.

## 6. Vorlage Log (`sicherheitsvorfall-log.md`)

```
Vorfall-Nr.:            2026-__
Eingang (Datum/Uhrzeit): ...      Quelle: ...
Gewissheit "aktiv ausgenutzt" seit: ...   → 24 h bis: ...   72 h bis: ...
Frühwarnung gesendet:   ...   Meldung gesendet: ...
Korrektur verfügbar:    ... (Version ...)   → Abschlussbericht bis: ...
Nutzer informiert:      ... (wie)
Abschlussbericht:       ...
```

## Quellen

- Art. 14 CRA (Meldepflichten), deutscher Wortlaut:
  https://www.springlex.eu/de/packages/cra/cra-regulation/article-14/
- Art. 64 Abs. 10 CRA (keine Geldbußen für Kleinst-/Kleinunternehmen bei
  der 24-h-Frist): https://www.springlex.eu/de/packages/cra/cra-regulation/article-64/
- ENISA, Start der Single Reporting Platform (11.09.2026):
  https://www.enisa.europa.eu/news/the-cra-single-reporting-platform-is-launched
- Registrierung, EU-Login, CSIRT-Prüfung (Sekundärquelle):
  https://www.advisori.de/en/blog/cra-single-reporting-platform-srp-registration
