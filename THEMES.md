# Design-Themen und Akzentfarben

Einstellungen → **Design**. Code: `Themes.js` (Paletten, Farbrechnung, Regeln, Speichern),
`DesignSection.tsx` (Einstellungs-Abschnitt), `ChatArtwork.tsx` (Klecks-Muster von
„Malachi Artwork“), `App.tsx` (globale Palette `P` / Akzent `AC` werden bei jedem
Themenwechsel abgeglichen). Tests: `__tests__/themes/`.

- **Standard** (kostenlos): das bisherige Nachtblau. 12 Akzentfarben, dazu der Schalter
  **„Kopfleiste und Menü einfärben“** (Akzent abgedunkelt in das Nachtblau gemischt).
- **30 Design-Themen** (Vollversion): vollständige, fest abgestimmte Paletten in vier
  Gruppen – **Dunkel** (5), **Hell** (8, davon 6 neue freundliche/pastellige),
  **Business** (7, schlicht-elegant: 4 dunkel, 3 hell) und **Artwork** (10, je mit eigenem
  Muster hinter dem Chat: „Malachi Artwork“ und seit Okt. 2026 Sternbild, Synthwave,
  Papierschnitt, Bauhaus, Tiefsee, Kintsugi, Digitaltarn Wald, Digitaltarn Stadt, Leopard). Ohne gültige Lizenz zeigt die
  App „Standard“; die Wahl bleibt gespeichert und greift wieder, sobald die Lizenz gültig
  ist. Antippen ohne Vollversion öffnet die Vollversion-Seite („Design-Themen“ steht dort
  in der Funktionsliste).
- **App-Icon** (optional): Launcher-Icon in den Farben des Designs – siehe [App-Icon](#app-icon).
- **Sperrbildschirm** bleibt immer im Standard-Design (mit der kostenlosen Akzentfarbe wie
  bisher): ein Design-Thema würde dort schon vor dem Entsperren verraten, dass die
  Vollversion – und damit vielleicht eine Notfall-PIN – eingerichtet ist.

## Tokens

Jedes Thema ist ein vollständiger Satz (`TOKEN_KEYS`): Flächen (`bg`, `surface`,
`surfaceAlt`, `border`, `borderStrong`), Schrift (`text`, `textSub`, `textMuted`), Akzent
(`accent`, `onAccent` = Schrift auf dem Akzent, `accentFg` = kleine Schrift in Akzentfarbe,
`accentSoft`, `codeText`, `accentDeep`), Kopfleiste (`headerBg`, `headerText`, `headerSub`,
`headerMuted`, `headerIcon`, `headerOnline` …), Menüs (`menuBg`, `menuText`, `menuIcon`,
`menuAccent`, `menuDanger`), Chat (`chatBg`, `bubbleMine*`, `bubbleTheirs*`), Status
(`danger`, `dangerFill`, `onDanger`, `success`, `warning`, `online`), Profilbild-Platzhalter
(`avatarBg`, `avatarText`, `headerAvatarBg`, `headerAvatarText`), `overlay`, `statusBar`.
Fehlende Werte leitet `buildTheme()` kontrastgesichert ab (`ensureContrast`). Dazu Metadaten:
`id` (stabil, gespeichert), `name`, `desc`, `dark`, `category` und optional `artwork` /
`artworkInks` (daraus abgeleitet `artworkFills`).

## Kontrastregeln (WCAG 2.1 AA)

`CONTRAST_RULES` beschreibt, welche Schrift-/Symbolfarbe auf welchem Hintergrund tatsächlich
benutzt wird – normale Schrift ≥ 4,5 : 1, Symbole/große Schrift/bedeutungstragende Ränder
≥ 3 : 1, inklusive Schrift auf Akzent-Knöpfen, auf beiden Chatblasen, in Kopfleiste und Menüs,
halbtransparente Flächen auf ihrem Untergrund verrechnet. `themes.contrast.test.js` rechnet
alle Kombinationen unabhängig nach: 21 Themen + 12 Akzente × (eingefärbt / nicht eingefärbt).
Ausnahmen gibt es nur beim unveränderten Standard-Design (`LEGACY_EXCEPTIONS`, siehe unten) –
keines der Design-Themen braucht eine.

## Gruppen im Picker

Jedes Thema hat eine `category` (`THEME_CATEGORIES` in `Themes.js`); `DesignSection.tsx`
zeigt je Gruppe eine kleine Überschrift und eine waagerecht wischbare Reihe Vorschaukarten
(Kopfleiste, beide Blasen, Akzent-Knopf – bei „Malachi Artwork“ auch das Muster).
„Standard“ steht vorn in „Dunkel“. Reihenfolge: **Dunkel**, **Hell**, **Business**,
**Artwork**. Ids sind stabil (gespeichert als `themeId`); unbekannte gespeicherte Ids fallen
wie bisher auf „Standard“ zurück.

## Die 21 Design-Themen

| Thema | Gruppe | Hell/Dunkel | Hintergrund | Fläche | Schrift | Akzent | Kopfleiste | Eigene Blase | Fremde Blase |
|---|---|---|---|---|---|---|---|---|---|
| **Graphit** – Neutrales Anthrazit mit Eisblau | Dunkel | dunkel | `#121417` | `#1B1E23` | `#ECEFF3` | `#8AB4F8` | `#1B1E23` | `#2F4F80` | `#20242A` |
| **Waldnacht** – Tiefes Tannengrün mit Salbei | Dunkel | dunkel | `#0D1A14` | `#15261D` | `#EAF2EC` | `#7CC79F` | `#15261D` | `#2C5A43` | `#18291F` |
| **Amethyst** – Ruhiges Violett mit Lavendel | Dunkel | dunkel | `#16121F` | `#201A2C` | `#F1EDF7` | `#B79CFF` | `#201A2C` | `#4C3A7A` | `#241D31` |
| **Bernstein** – Warmes Espresso mit Bernstein | Dunkel | dunkel | `#17120E` | `#221B15` | `#F5EFE8` | `#E8B062` | `#221B15` | `#6A4A24` | `#2A221B` |
| **Bordeaux** – Gedecktes Weinrot mit Rosé | Dunkel | dunkel | `#1A0F13` | `#26161C` | `#F7ECEF` | `#E79BB0` | `#26161C` | `#6C2D43` | `#2D1A21` |
| **Pergament** – Helles Papier mit Petrol | Hell | hell | `#F6F2EA` | `#FFFDF8` | `#1F1A14` | `#0E6B6B` | `#FFFDF8` | `#0E6B6B` | `#FFFDF8` |
| **Gletscher** – Kühles Hellgrau mit Königsblau | Hell | hell | `#F2F5F8` | `#FFFFFF` | `#142130` | `#2457C5` | `#1E3A5F` | `#2457C5` | `#FFFFFF` |
| **Kirschblüte** – Zartes Rosa mit Beerenrot | Hell | hell | `#FFF4F6` | `#FFFFFF` | `#2B1419` | `#C2185B` | `#FFFFFF` | `#C2185B` | `#FFFFFF` |
| **Lavendel** – Helles Flieder mit Violett | Hell | hell | `#F6F3FC` | `#FFFFFF` | `#1E1830` | `#6A3FC8` | `#EDE6FA` | `#6A3FC8` | `#FFFFFF` |
| **Pistazie** – Frisches Hellgrün mit Smaragd | Hell | hell | `#F3F8EE` | `#FFFFFF` | `#16220F` | `#1B7A50` | `#E2F0D5` | `#1B7A50` | `#FFFFFF` |
| **Sonnenschein** – Buttergelb mit warmem Orange | Hell | hell | `#FFFAEB` | `#FFFFFF` | `#2A2108` | `#B54708` | `#FFE38A` | `#B54708` | `#FFFFFF` |
| **Lagune** – Helles Aqua mit Türkis-Kopfleiste | Hell | hell | `#EEF8F8` | `#FFFFFF` | `#0E2426` | `#0E7490` | `#0E7490` | `#0E7490` | `#FFFFFF` |
| **Pfirsich** – Warmes Apricot mit Koralle | Hell | hell | `#FFF3EB` | `#FFFFFF` | `#2B1A12` | `#B83D2A` | `#F7A98E` | `#B83D2A` | `#FFFFFF` |
| **Malachi Artwork** – Knallbunte Comic-Tinte mit Klecksen | Artwork | hell | `#FFF9EC` | `#FFFFFF` | `#1F0E3A` | `#D4006E` | `#2A0B52` | `#C6F432` | `#FFFFFF` |
| **Onyx** – Tiefschwarz mit Platin | Business | dunkel | `#0A0A0B` | `#151517` | `#F2F2F3` | `#C9CED6` | `#0A0A0B` | `#2F3137` | `#18181B` |
| **Marine** – Dunkles Marineblau mit Gold | Business | dunkel | `#0B1322` | `#121D31` | `#EEF2F8` | `#D4B06A` | `#121D31` | `#24426E` | `#162339` |
| **Schiefer** – Blaugrauer Schiefer mit Kupfer | Business | dunkel | `#1A2027` | `#232A33` | `#EDF0F3` | `#D99A6C` | `#232A33` | `#3A4757` | `#262E38` |
| **Rauchquarz** – Rauchiges Taupe mit Roségold | Business | dunkel | `#1C1A1A` | `#262323` | `#F4EFEC` | `#E2A99A` | `#262323` | `#5C443D` | `#2B2726` |
| **Elfenbein** – Warmes Elfenbein mit Marineblau | Business | hell | `#FAF7F0` | `#FFFFFF` | `#1A1C22` | `#1F3B66` | `#FFFFFF` | `#213D69` | `#FFFFFF` |
| **Champagner** – Champagner mit dunklem Mokka | Business | hell | `#F4EEE4` | `#FCF9F4` | `#2A211A` | `#8A6A3A` | `#3B2F27` | `#5A4636` | `#FCF9F4` |
| **Platin** – Kühles Platin mit Anthrazit | Business | hell | `#EEF0F3` | `#FFFFFF` | `#15181D` | `#3A4452` | `#FFFFFF` | `#3A4452` | `#FFFFFF` |

Lagune, Pfirsich, Sonnenschein und Lavendel haben eine farbige (bzw. getönte) Kopfleiste,
Champagner und Malachi Artwork eine dunkle über heller App – die Statusleisten-Symbole
folgen jeweils der Kopfleiste (`statusBarFor`).

Kontrastwerte (Auszug; „kleinster Wert“ = schwächste aller geprüften Kombinationen):

| Thema | Schrift/Hintergrund | Nebenschrift/Fläche | Schrift auf Akzent | Eigene Blase | Fremde Blase | Kopfleiste | kleinster Textwert (≥ 4,5) | kleinster Symbolwert (≥ 3) |
|---|---|---|---|---|---|---|---|---|
| Graphit | 16,00 | 6,17 | 8,52 | 7,59 | 13,51 | 14,49 | 4,55 (Weiß auf accentDeep) | 3,53 (borderStrong auf Fläche) |
| Waldnacht | 15,67 | 6,35 | 9,00 | 7,31 | 13,38 | 13,88 | 4,61 (Weiß auf accentDeep) | 3,74 (borderStrong auf Fläche) |
| Amethyst | 15,96 | 6,08 | 7,94 | 8,60 | 14,05 | 14,61 | 4,64 (Weiß auf accentDeep) | 3,32 (borderStrong auf Fläche) |
| Bernstein | 16,29 | 6,31 | 9,05 | 7,41 | 13,70 | 14,89 | 4,73 (Weiß auf accentDeep) | 3,34 (borderStrong auf Fläche) |
| Bordeaux | 16,23 | 6,50 | 8,27 | 9,03 | 14,20 | 14,99 | 4,68 (Weiß auf accentDeep) | 3,14 (borderStrong auf Fläche) |
| Pergament | 15,47 | 6,26 | 6,30 | 6,30 | 16,99 | 16,99 | 4,54 (Initialen auf Profilbild) | 3,25 (borderStrong auf Fläche 2) |
| Gletscher | 14,88 | 5,71 | 6,47 | 6,47 | 16,28 | 11,50 | 4,52 (Initialen auf Profilbild) | 3,04 (Löschen-Symbol auf Kopfleiste) |
| Kirschblüte | 16,04 | 6,63 | 5,87 | 5,87 | 17,26 | 17,26 | 4,53 (Zeit auf eigener Blase) | 3,42 (borderStrong auf Fläche 2) |
| Lavendel | 15,58 | 6,29 | 6,65 | 6,65 | 17,09 | 14,08 | 4,51 (headerOnline auf Kopfleiste) | 3,27 (borderStrong auf Fläche 2) |
| Pistazie | 15,33 | 6,04 | 5,32 | 5,32 | 16,54 | 13,91 | 4,51 (Zeit auf eigener Blase) | 3,19 (borderStrong auf Fläche 2) |
| Sonnenschein | 15,25 | 6,40 | 5,43 | 5,43 | 15,92 | 12,59 | 4,53 (Initialen auf Profilbild in der Kopfleiste) | 3,37 (borderStrong auf Fläche 2) |
| Lagune | 14,95 | 6,18 | 5,36 | 5,36 | 16,17 | 5,36 | 4,52 (Zeit auf eigener Blase) | 3,06 (Löschen-Symbol auf Kopfleiste) |
| Pfirsich | 15,30 | 6,43 | 5,62 | 5,62 | 16,68 | 8,75 | 4,50 (Zeit auf eigener Blase) | 3,05 (Symbol auf Kopfleiste) |
| Malachi Artwork | 16,93 | 7,39 | 5,22 | 13,86 | 17,76 | 16,56 | 4,61 (Initialen auf Profilbild) | 3,80 (borderStrong auf Fläche 2) |
| Onyx | 17,69 | 6,61 | 11,85 | 11,92 | 15,84 | 17,69 | 4,75 (Weiß auf accentDeep) | 3,50 (borderStrong auf Fläche) |
| Marine | 16,53 | 6,51 | 8,91 | 9,24 | 14,02 | 15,00 | 4,67 (Weiß auf accentDeep) | 3,42 (borderStrong auf Fläche) |
| Schiefer | 14,35 | 5,93 | 7,35 | 8,67 | 12,00 | 12,66 | 4,53 (Initialen auf Profilbild) | 3,45 (borderStrong auf Fläche) |
| Rauchquarz | 15,18 | 6,25 | 8,44 | 8,16 | 12,95 | 13,66 | 4,64 (Weiß auf accentDeep) | 3,49 (borderStrong auf Fläche) |
| Elfenbein | 15,92 | 5,91 | 11,20 | 10,85 | 17,03 | 17,03 | 5,02 (textMuted auf Fläche 2) | 3,15 (borderStrong auf Fläche 2) |
| Champagner | 13,67 | 5,91 | 5,00 | 8,20 | 15,02 | 11,23 | 4,52 (Initialen auf Profilbild) | 3,03 (borderStrong auf Fläche 2) |
| Platin | 15,58 | 6,26 | 9,87 | 9,87 | 17,79 | 17,79 | 4,66 (success auf Hintergrund) | 3,17 (borderStrong auf Fläche 2) |

„Nebenschrift/Fläche“ ist `textMuted` auf `surface` (Zeitstempel, Untertitel), „Fläche 2“
ist `surfaceAlt`. `accentDeep` ist der abgedunkelte Akzent, den `SiegelScreen.tsx` bekommt
(eigene Palette mit fest weißer Knopfschrift).

## Malachi Artwork

„Mal etwas komplett anderes“: knallige Comic-Tinte im Stil von Splatoon – Magenta-Akzent
(`#D4006E`), eigene Blasen in Limette (`#C6F432`) mit tintenvioletter Schrift, dunkelviolette
Kopfleiste mit Limetten-Symbolen, cremefarbener Hintergrund. Dahinter im Chatverlauf ein
**Klecks-Muster** (`artwork: 'splat'`, `ChatArtwork.tsx`):

- **Eine SVG** (`react-native-svg`), absolut hinter der Nachrichtenliste, `pointerEvents="none"`
  und für Screenreader ausgeblendet. 8 Kleckse (welliger Körper + 3–5 Finger mit runder
  Spitze, je ein Pfad) und rund 30 Tropfen/Spritzer.
- **Deterministisch**: die Formen werden einmal beim Laden aus festem Startwert berechnet
  (`SPLAT_ART`), nicht pro Rendern; `React.memo` – Tippen und neue Nachrichten zeichnen das
  Muster nicht neu. `preserveAspectRatio="xMidYMid slice"` deckt jede Bildschirmgröße ab.
- **Kontrastarm**: die Tinten (`artworkInks`) werden nur zu 22 % in `chatBg` gemischt
  (`artworkFills`, `ARTWORK_INK_SHARE`), deckend. Die Blasen bleiben deckend, ihre Schrift
  ist vom Muster unberührt; was direkt auf dem Hintergrund steht (Zeit unter Bildern,
  `textMuted`) bleibt auch auf jedem Klecks ≥ 4,5 : 1:

| Tinte | Muster-Farbe (22 % in `chatBg`) | Kontrast zu `chatBg` | `textMuted` darauf | `text` darauf |
|---|---|---|---|---|
| `#FF2E93` | `#FFCCD8` | 1,34 | 5,23 | 12,59 |
| `#8BD100` | `#E5F0B8` | 1,14 | 6,15 | 14,79 |
| `#FF7A00` | `#FFDDB8` | 1,23 | 5,73 | 13,78 |
| `#00BCC8` | `#C7ECE4` | 1,21 | 5,82 | 14,00 |
| `#7B2FF7` | `#E2CDEE` | 1,41 | 5,00 | 12,01 |

- Das Muster erscheint **nur** mit diesem Design und nicht über einem eigenen
  Hintergrundbild, nicht bei gewählter Chat-Hintergrund-Voreinstellung (Nutzerwahl geht vor)
  und nie im Secret Chat (`chatArtworkVisible`). In der Vorschaukarte des Pickers ist es
  ebenfalls zu sehen.
- Keine eigenen Schriften (keine Font-Dateien im Paket); Blasenform unverändert.

## Artwork, zweite Runde (Okt. 2026)

Neun weitere Designs der Gruppe **Artwork**, jedes mit eigenem Muster aus `ChatArtwork.tsx`
(`ART`, gleiches Prinzip wie das Klecks-Muster: eine SVG, fest berechnet, nicht bedienbar,
nur mit dem Design, nie über eigenem Bild oder im Secret Chat):

| Design | Muster (`artwork`) | Idee |
|---|---|---|
| Sternbild | `stars` | Nachthimmel, Sternbilder aus Knoten und Linien – eines ist das Malachi-M |
| Synthwave | `synth` | gestreifte Achtziger-Sonne, Bergkette, perspektivisches Neon-Raster |
| Papierschnitt | `paper` | Papierwellen oben und unten mit Schattenkante, Konfetti |
| Bauhaus | `bauhaus` | Kreise, Halb-/Viertelkreise, Quadrate, Dreiecke, Ringe, Streifen in Grundfarben |
| Tiefsee | `deepsea` | leuchtende Quallen, Partikel mit Schein, Luftblasen, Seegras |
| Kintsugi | `kintsugi` | verzweigte Goldrisse auf schwarzem Lack, Goldtropfen an den Knoten |
| Digitaltarn Wald | `pixelwood` | Pixel-Tarnmuster (Rauschen in drei Größen, 4 Töne) in Oliv/Erde |
| Digitaltarn Stadt | `pixelurban` | dasselbe in Grau und Weiß, feineres Raster |
| Leopard | `leopard` | elliptische Rosetten aus sichelförmigen Flecken, dunklere Mitte, Tupfen |

- **Lesbarkeit wie bisher**: jede Musterfarbe (`artworkFills`) so kräftig wie möglich, aber
  Zeitstempel (`textMuted`) darauf ≥ 4,5 : 1, `text` ≥ 4,5 : 1. Nur winzige **Glanzpunkte**
  (Sterne, Leuchtpartikel; im Muster mit `g` markiert, ≤ 3,5 Einheiten) nutzen die helleren
  `artworkGlints` mit ≥ 3 : 1 – sie können keine Schrift verdecken.
- Das Pixel-Tarnmuster fasst gleichfarbige Pixel einer Zeile zu Rechtecken zusammen: je Ton
  **ein** Pfad, deshalb trotz tausender Pixel billig zu zeichnen.
- Tests: `__tests__/themes/themes.artwork.test.js` (Kontrast je Musterfarbe, Glanzpunkte,
  Determinismus, Raster des Tarnmusters, das M im Sternbild, Darstellung).

## Kostenlose Akzentfarben (Standard-Design)

Schrift auf dem Akzent: Weiß nur, wo es 4,5 : 1 schafft – sonst Nachtblau `#04182F`.
Kleine Schrift in Akzentfarbe (`accentFg`) wird bei Bedarf automatisch aufgehellt.
Eingefärbte Kopfleiste: Akzent in `#04182F` gemischt, bis die Schrift darauf ≥ 7 : 1 hat;
Menü eine Stufe dunkler.

| Akzent | Hex | Schrift darauf | Kontrast | als Symbol auf Fläche | accentFg | eingefärbte Kopfleiste | Schrift darauf | kleinster Wert gesamt |
|---|---|---|---|---|---|---|---|---|
| Cyan (Standard) | `#0A7EA4` | weiß | 4,63 | 3,13 | `#58A7C1`¹ | `#074B6A` | 8,67 | 4,50 |
| Türkis | `#2BB3A8` | nachtblau | 6,90 | 5,61 | `#38B8AD` | `#14565F` | 7,63 | 4,51 |
| Minze | `#5ED3A5` | nachtblau | 9,63 | 7,83 | `#5ED3A5` | `#245958` | 7,28 | 4,50 |
| Grün | `#6CC05C` | nachtblau | 7,93 | 6,45 | `#6CC05C` | `#2E5B41` | 7,17 | 4,53 |
| Sand | `#C9A27C` | nachtblau | 7,60 | 6,18 | `#C9A27C` | `#534F4E` | 7,42 | 4,51 |
| Gold | `#D9B44A` | nachtblau | 8,99 | 7,31 | `#D9B44A` | `#4F4F38` | 7,68 | 4,52 |
| Koralle | `#F28C6F` | nachtblau | 7,44 | 6,05 | `#F28C6F` | `#634649` | 7,70 | 4,50 |
| Rosé | `#E89AB8` | nachtblau | 8,28 | 6,73 | `#E89AB8` | `#5F4C66` | 7,10 | 4,52 |
| Lila | `#B591D9` | nachtblau | 6,81 | 5,54 | `#B998DB` | `#4B4873` | 7,79 | 4,50 |
| Violett | `#9AA5F5` | nachtblau | 7,71 | 6,27 | `#9AA5F5` | `#40507E` | 7,23 | 4,51 |
| Blau | `#4A90D9` | nachtblau | 5,34 | 4,34 | `#6EA6E1` | `#275484` | 7,17 | 4,50 |
| Silber | `#AEBBC8` | nachtblau | 9,13 | 7,42 | `#AEBBC8` | `#405165` | 7,46 | 4,54 |

¹ Cyan nur eingefärbt; nicht eingefärbt ist Cyan das unveränderte Standard-Design (siehe unten).

Frühere Akzente werden beim Laden übernommen: `#0A7EA4` → Cyan, `#4A90D9` → Blau (gleicher
Wert), `#8B7355` → Sand, `#4A8B46` → Grün, `#9B6B9B` → Lila (die drei letzten erreichten
weder mit weißer noch mit dunkler Schrift 4,5 : 1 und sind deshalb heller abgestimmt).

## Standard-Design unverändert

Wer nichts wählt, sieht exakt die bisherigen Farben (`KLASSIK_LEGACY`). Dort liegen einige
Kombinationen schon heute unter AA – bewusst beibehalten, der Test prüft, dass es **genau
diese** bleiben (`LEGACY_EXCEPTIONS`):

| Kombination | Kontrast | Ziel |
|---|---|---|
| textMuted auf surface (Untertitel in Karten) | 4,46 | 4,50 |
| accentFg auf bg / surface / surfaceAlt (kleine Cyan-Schrift) | 3,85 / 3,13 / 3,42 | 4,50 |
| accentFg auf Akzent-Tönung (Nummern im Willkommens-Bildschirm) | 2,66 / 3,26 | 4,50 |
| borderStrong (Optionsknöpfe, `#3A5A7A`) | 2,02 – 2,48 | 3,00 |
| headerMuted / headerOnline in der Kopfleiste | 4,46 / 3,13 | 4,50 |
| Löschen-Rot `#E74C3C` auf Fläche / Menü | 3,80 – 4,14 | 4,50 |
| Weiß auf Löschen-Knopf `#E74C3C` | 3,82 | 4,50 |
| online `#0A7EA4` („P2P verbunden“) auf bg / surface | 3,85 / 3,13 | 4,50 |
| Zeit auf eigener Blase (Weiß 65 %) | 2,86 | 4,50 |
| Tempo-Anzeige auf eigener Sprachnachricht | 3,31 | 4,50 |
| Zeit auf fremder Blase | 4,46 | 4,50 |

Sobald das Standard-Design angepasst wird (andere Akzentfarbe oder Einfärben), gilt die
kontrastgeprüfte Fassung `KLASSIK_AA` (optisch fast gleich: `textMuted` `#7398B3`, Rot
`#FF7A6B`, Löschen-Knopf `#C0392B`, online `#4FC3E8`, Statusleiste hell). Wer das
Standard-Design selbst AA-konform haben will, übernimmt diese Werte in `KLASSIK_LEGACY`.

Bewusst behobene Fehler (auch im Standard sichtbar): „Abbrechen“-Knöpfe in Dialogen hatten
eine helle Fläche mit hellgrauer Schrift (1,7 : 1) und sind jetzt dunkel; die Lesebestätigung
✓✓✓ auf der eigenen Blase war Akzent auf Akzent (unsichtbar) und ist jetzt weiß.

## App-Icon

Schalter **„App-Icon passend zum Design“** (Design-Einstellungen, Voreinstellung **aus**): das
Launcher-Icon nimmt die Farben des gewählten Designs an. Code: `AppIconVariants.js` (Varianten,
Zuordnung Design → Icon), `AppIcon.js` (Umschalten), `AppIconModule.kt` (natives Modul
`MalachiAppIcon`), Generator `tools/gen-theme-icons.js`. Tests: `__tests__/themes/appIcon.*.test.js`.

- **42 Varianten**: das bisherige Marken-Icon (`klassik` = Standard-Design mit Cyan –
  Voreinstellung und Rückfall), 11 Standard-Akzente (`klassik_<akzent>`: Marken-Nachtblau,
  Zeichen im Akzent) und je eines der 30 Design-Themen. „Kopfleiste und Menü einfärben“ ändert
  das Icon nicht (sonst doppelt so viele Varianten für einen kaum sichtbaren Unterschied).
- **Vollversion**: das Icon folgt dem *angezeigten* Design – ohne gültige Lizenz also dem
  Standard-Design (mit der kostenlosen Akzentfarbe), nie einem Pro-Icon.
- **Farben**: Hintergrund = Kopfleiste des Designs (ist sie fast weiß: der getönte
  App-Hintergrund) als leichter Verlauf. Das M und die Knoten im Verlauf Akzent → Partner-Ton
  (Akzent 35 % Richtung Schrift) → Akzent, wie das Malachi-Zeichen in der Kopfleiste. Wo sich
  der Akzent von der Kopfleiste nicht abhebt (Gletscher, Lagune, Champagner, Malachi Artwork),
  nimmt das Zeichen die Symbolfarbe der Kopfleiste (`headerIcon`), der Akzent wird Partner-Ton.
  Das Schloss hat wie im Original die Hintergrundfarbe. Jede Farbe des Zeichens erreicht auf
  **jedem** Verlaufston ≥ 3 : 1 (`ensureContrast`), das Schlüsselloch ≥ 3 : 1 auf dem Schloss.
- **Geometrie** exakt wie `drawable/ic_launcher_fg.xml` / `ic_launcher_bg.xml` (66-dp-
  Sicherheitszone, jede Launcher-Maske): der Generator tauscht nur Farben und lehnt unbekannte
  Vorlagenfarben ab. Die einfarbige Ebene für „Designte Symbole“ (Android 13+) ist für alle
  Varianten dieselbe. Für Android 7.x (API 24/25) gibt es je eine Ebenenliste in `mipmap-anydpi`.
- **Technik** (Android-Standard, wie Telegrams alternative Icons): der Launcher-Eintrag
  (MAIN/LAUNCHER) liegt auf `<activity-alias>`-Einträgen von `MainActivity`
  (`com.securecommapp.AppIcon_<id>`), genau einer ist aktiv – im Manifest `AppIcon_klassik`.
  `setIcon` nimmt nur Ids aus der festen Liste (`AppIconVariants.kt`), schaltet **erst das
  neue Alias an, dann die anderen aus** (nie ein Moment ohne Launcher-Eintrag), mit
  `DONT_KILL_APP`, und ist idempotent. `MainActivity` selbst bleibt immer aktiviert und
  exportiert: Deep Links (`malachi://connect`), Benachrichtigungen, Anruf-Vollbild und
  „Annehmen“ zielen direkt auf diese Klasse und hängen nicht vom Icon ab.
- **Wann**: umgeschaltet wird nur, wenn die App in den Hintergrund geht – beim Durchblättern
  der Designs zählt nur die letzte Wahl (kein Flackern im Launcher). Erst nachdem die
  gespeicherte Wahl geladen und, bei Pro-Design, die Lizenz geprüft ist (sonst sprang das Icon
  bei jedem Start kurz auf Standard). Schalter aus → zurück zum Marken-Icon. „Alle Daten
  löschen“ setzt Design und Schalter zurück → Marken-Icon. Nicht umgeschaltet wird, solange
  ein Systemdialog offen ist (Galerie, Dateiauswahl, Berechtigung – die App kommt gleich zurück
  und darf ihre Activity nicht verlieren) oder ein Anruf läuft; dann wie auch nach einem
  fehlgeschlagenen Wechsel beim nächsten Verlassen. Bewusst ohne Zeitverzögerung: JS-Timer
  stehen unter Android still, solange die App im Hintergrund ist.
- **Gespeichert** als `appIcon` (true/false) in `settings`; fehlt der Schlüssel: aus.
- **Sichtbarkeit**: das Symbol ist ohne Entsperren zu sehen. Bei Pro-Design und
  ausgeschaltetem „Sperrbildschirm im Design“ weist die Einstellung darauf hin.
- **Neu erzeugen** nach Änderungen an `Themes.js` (neues Thema, andere Akzentfarbe):
  `node tools/gen-theme-icons.js` (`--check` prüft nur, `--table` druckt die Tabelle unten).
  `appIcon.generator.test.js` schlägt fehl, solange die Dateien veraltet sind.

| Variante | Design | Hintergrund | Zeichen (Akzent → Partner) | kleinster Kontrast Zeichen | Schlüsselloch |
|---|---|---|---|---|---|
| `klassik` | Standard | `#071433` | `#36E0FF` → `#7C8CFF` | 5,40 | 13,56 |
| `klassik_teal` | Standard, Akzent Türkis | `#071433` | `#2BB3A8` → `#70CAC5` | 6,21 | 11,37 |
| `klassik_mint` | Standard, Akzent Minze | `#071433` | `#5ED3A5` → `#91DFC3` | 8,68 | 13,32 |
| `klassik_green` | Standard, Akzent Grün | `#071433` | `#6CC05C` → `#9AD393` | 7,14 | 12,33 |
| `klassik_brown` | Standard, Akzent Sand | `#071433` | `#C9A27C` → `#D7BFA8` | 6,84 | 12,24 |
| `klassik_gold` | Standard, Akzent Gold | `#071433` | `#D9B44A` → `#E1CB88` | 8,10 | 13,09 |
| `klassik_coral` | Standard, Akzent Koralle | `#071433` | `#F28C6F` → `#F1B1A0` | 6,70 | 11,92 |
| `klassik_rose` | Standard, Akzent Rosé | `#071433` | `#E89AB8` → `#EBBACF` | 7,46 | 12,63 |
| `klassik_lilac` | Standard, Akzent Lila | `#071433` | `#B591D9` → `#CAB4E5` | 6,14 | 11,63 |
| `klassik_violet` | Standard, Akzent Violett | `#071433` | `#9AA5F5` → `#B8C1F7` | 6,95 | 12,27 |
| `klassik_blue` | Standard, Akzent Blau | `#071433` | `#4A90D9` → `#84B4E5` | 4,81 | 10,44 |
| `klassik_silver` | Standard, Akzent Silber | `#071433` | `#AEBBC8` → `#C5D0DA` | 8,22 | 13,27 |
| `graphit` | Graphit (Pro) | `#1B1E23` | `#8AB4F8` → `#ACC9F6` | 6,66 | 11,78 |
| `wald` | Waldnacht (Pro) | `#15261D` | `#7CC79F` → `#A3D6BA` | 6,66 | 11,36 |
| `amethyst` | Amethyst (Pro) | `#201A2C` | `#B79CFF` → `#CBB8FC` | 6,25 | 11,47 |
| `bernstein` | Bernstein (Pro) | `#221B15` | `#E8B062` → `#EDC691` | 7,40 | 12,39 |
| `bordeaux` | Bordeaux (Pro) | `#26161C` | `#E79BB0` → `#EDB7C6` | 6,81 | 11,97 |
| `pergament` | Pergament (Pro) | `#F6F2EA` | `#0E6B6B` → `#144F4D` | 4,83 | 5,64 |
| `gletscher` | Gletscher (Pro) | `#1E3A5F` | `#FFFFFF` → `#6E90D9` | 3,04 | 11,50 |
| `kirschbluete` | Kirschblüte (Pro) | `#FFF4F6` | `#C2185B` → `#8D1744` | 4,68 | 5,46 |
| `lavendel` | Lavendel (Pro) | `#EDE6FA` | `#6A3FC8` → `#4F3193` | 4,70 | 5,48 |
| `pistazie` | Pistazie (Pro) | `#E2F0D5` | `#1B7A50` → `#195B39` | 3,83 | 4,47 |
| `sonnenschein` | Sonnenschein (Pro) | `#FFE38A` | `#B54708` → `#843A08` | 3,68 | 4,29 |
| `lagune` | Lagune (Pro) | `#0E7490` | `#FFFFFF` → `#B2D3DB` | 3,02 | 5,36 |
| `pfirsich` | Pfirsich (Pro) | `#F7A98E` | `#A23625` → `#873122` | 3,08 | 3,57 |
| `artwork` | Malachi Artwork (Pro) | `#2A0B52` | `#C6F432` → `#D91F7F` | 3,04 | 14,51 |
| `onyx` | Onyx (Pro) | `#0A0A0B` | `#C9CED6` → `#D7DBE0` | 11,11 | 15,95 |
| `marine` | Marine (Pro) | `#121D31` | `#D4B06A` → `#DDC79C` | 6,93 | 12,03 |
| `schiefer` | Schiefer (Pro) | `#232A33` | `#D99A6C` → `#E0B89B` | 5,04 | 9,63 |
| `rauchquarz` | Rauchquarz (Pro) | `#262323` | `#E2A99A` → `#E8C2B7` | 6,46 | 11,16 |
| `elfenbein` | Elfenbein (Pro) | `#FAF7F0` | `#1F3B66` → `#1D304E` | 8,98 | 10,46 |
| `champagner` | Champagner (Pro) | `#3B2F27` | `#E3C796` → `#9F855D` | 3,08 | 10,23 |
| `platin` | Platin (Pro) | `#EEF0F3` | `#3A4452` → `#2D353F` | 7,39 | 8,64 |
| `sternbild` | Sternbild (Pro) | `#070B1D` | `#7C8CFF` → `#A4B0FF` | 5,80 | 11,83 |
| `synthwave` | Synthwave (Pro) | `#10061C` | `#FF4FAE` → `#FE87CA` | 5,84 | 11,04 |
| `papierschnitt` | Papierschnitt (Pro) | `#2E6F8E` | `#FFE2C8` → `#BCD1DB` | 3,08 | 5,01 |
| `bauhaus` | Bauhaus (Pro) | `#1C1C1C` | `#F2C14E` → `#4D76B5` | 3,13 | 13,19 |
| `tiefsee` | Tiefsee (Pro) | `#020B12` | `#20C7B5` → `#66D8CD` | 8,30 | 13,39 |
| `kintsugi` | Kintsugi (Pro) | `#0B0B0B` | `#D4AF5A` → `#DFC68D` | 8,35 | 13,89 |
| `tarnwald` | Digitaltarn Wald (Pro) | `#151912` | `#A9B86E` → `#C2CD99` | 7,07 | 12,48 |
| `tarnstadt` | Digitaltarn Stadt (Pro) | `#2B3138` | `#E3E7EC` → `#7D8895` | 3,04 | 11,81 |
| `leopard` | Leopard (Pro) | `#2E1C10` | `#F0B45C` → `#A26B3B` | 3,06 | 12,12 |

Am echten Gerät zu prüfen (kein Build/Emulator in den Tests):

- **Update** von einer Version ohne Aliase: der Launcher-Eintrag zieht von `MainActivity` auf
  `AppIcon_klassik` um – manche Startbildschirme entfernen dabei einmalig das Symbol vom
  Startbildschirm (in der App-Liste bleibt es).
- **Wechsel**: Symbol kurz weg / neu platziert (Pixel-Launcher, Samsung One UI, Ordner), ob
  Android dabei die im Hintergrund liegende Activity schließt (dann startet die App beim nächsten
  Antippen neu, der Dienst läuft weiter).
- **Deep Links** (`malachi://connect`), **Benachrichtigungen** und **eingehende Anrufe**
  (Vollbild, „Annehmen“) mit einem Nicht-Standard-Icon; Android 7.x (Ebenenliste) und
  Android 13+ mit „Designten Symbolen“.

## Speichern

Im bestehenden Schlüssel `settings` (verschlüsselt), rückwärtskompatibel:
`accentColor` (Hex wie bisher), neu `themeId` und `tintChrome`, die Schalter `lockDesign`
und `appIcon`; `bgColor`, `fontSize`,
`customBgUri` unverändert. `saveSettings()` liest, mischt und schreibt nacheinander – kein
Feld geht mehr durch ein zweites Schreiben in anderem Format verloren. `bgColor` (Chat-
Hintergrund-Voreinstellung) färbte früher die ganze App; es gilt jetzt nur noch für den
Chatverlauf, „Wie Design“ nimmt die Farbe des Themas. Beim Löschen aller Daten springt das
Design auf Standard zurück.

## Grenzen

- `SiegelScreen.tsx`, `CallScreen`, `SetupScreen` und der QR-Scanner behalten ihre eigene
  dunkle Palette (Siegel bekommt den Akzent als `accentDeep`).
- Eigene Chat-Hintergründe (Bild oder Voreinstellung) sind Nutzerwahl und nicht
  kontrastgeprüft – die Blasen haben eigene Flächen, nur Zeitstempel unter Bildern stehen
  direkt auf dem Hintergrund. Der Secret Chat behält seinen fast schwarzen Hintergrund.
- Das Klecks-Muster von „Malachi Artwork“ gibt es bisher nur im Einzelchat (`ChatScreen`),
  noch nicht im Gruppenchat (`GroupChatScreen.tsx` zeigt dort die Farben des Designs ohne
  Muster).
