# Post-Release Feature Backlog — Malachi

Produkt-/UX-Features, die bewusst NICHT vor dem ersten Release umgesetzt
werden, sondern für eine spätere Version vorgemerkt sind. Anders als
`SECURITY_ARCHITECTURE_BACKLOG.md` (kryptografische/protokoll-bezogene
Sicherheitsfragen) geht es hier um Funktionsumfang.

## Vorgemerkt

- **Gruppenchats** — benötigt vorher einen eigenen kryptografischen Entwurf
  (Gruppen-Schlüsselaustausch skaliert nicht trivial vom aktuellen 1:1-KEM-
  Modell). Sicherheitsseitig bereits als eigener Punkt erfasst: siehe
  `SECURITY_ARCHITECTURE_BACKLOG.md` Abschnitt A4 (Group messaging /
  MLS-style group ratchet, P2 — braucht unabhängige Kryptografie-Review vor
  jeder Umsetzung).
- **Storys** — zeitlich befristete Status-/Story-Updates, sichtbar für
  Kontakte. Noch kein Entwurf, wie das mit dem bestehenden reinen 1:1-P2P-
  Modell (kein Server-seitiges Fan-out) zusammenpasst.
- **Bilder zur Einmalansicht** — Foto verschwindet nach einmaligem Öffnen
  (View-once), analog zu bestehenden verschwindenden Text-Nachrichten
  (Timer-Funktion), aber als expliziter Einmal-Öffnen-Modus statt
  zeitbasiert.
- **Sprachnachrichten zur Einmalansicht** — dieselbe Einmal-Öffnen-Logik wie
  oben, angewendet auf Sprachnachrichten statt Fotos.

## Hinweis

Diese Liste ist eine Merkliste, kein Implementierungsplan. Vor Beginn jeder
einzelnen Position: eigene Aufwandsschätzung und (wo kryptografisch relevant)
Abgleich mit dem Security-Backlog.
