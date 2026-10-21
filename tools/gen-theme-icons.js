#!/usr/bin/env node
/**
 * Malachi - App-Icon-Varianten erzeugen ("App-Icon passend zum Design",
 * THEMES.md, Abschnitt "App-Icon").
 *
 * Liest die Farben aus Themes.js und die Variantenliste aus AppIconVariants.js
 * und schreibt deterministisch (gleiche Eingabe -> byte-gleiche Dateien):
 *
 *   res/drawable/ic_appicon_<id>_fg.xml      Vordergrund = drawable/ic_launcher_fg.xml,
 *                                           NUR die Farben getauscht (Geometrie und
 *                                           66dp-Sicherheitszone exakt wie das Original)
 *   res/drawable/ic_appicon_<id>_bg.xml      Hintergrund = drawable/ic_launcher_bg.xml mit
 *                                           Verlauf aus der Designfarbe (nur Design-Themen;
 *                                           Standard-Akzente behalten den Marken-Hintergrund)
 *   res/mipmap-anydpi-v26/ic_appicon_<id>.xml  adaptives Icon, einfarbige Ebene
 *                                           (Android 13 "Designte Symbole") unveraendert
 *   res/mipmap-anydpi/ic_appicon_<id>.xml   Ebenenliste fuer Android 7.x (API 24/25)
 *   AndroidManifest.xml                     die <activity-alias>-Eintraege zwischen den
 *                                           Markern APP-ICON-ALIASES:BEGIN/END
 *   java/.../AppIconVariants.kt             feste Id-Liste fuer AppIconModule.setIcon
 *
 * Die Variante "klassik" (Voreinstellung) ist das bestehende Marken-Icon
 * (@mipmap/ic_launcher) - dafuer wird nichts erzeugt.
 *
 * Farben (wie das Malachi-Zeichen in der Kopfleiste, brandColors in App.tsx):
 * Hintergrund = Kopfleiste des Designs (bei fast weisser Kopfleiste der
 * getoente App-Hintergrund), Zeichen = Akzent -> Partner-Ton (Akzent 35 % in
 * Richtung Schrift) -> Akzent (hebt sich der Akzent von der Kopfleiste nicht
 * ab: Symbolfarbe der Kopfleiste -> Akzent), Schloss = Hintergrundfarbe wie
 * im Original.
 * Jede Farbe des Zeichens hat auf JEDEM Verlaufston des Hintergrunds
 * mindestens 3:1 (ensureContrast aus Themes.js); das Schluesselloch 3:1 auf
 * dem Schloss.
 *
 * Aufruf:  node tools/gen-theme-icons.js           schreibt/aktualisiert alles
 *          node tools/gen-theme-icons.js --check   prueft nur (Exit 1, wenn veraltet)
 *          node tools/gen-theme-icons.js --table   Farbtabelle fuer THEMES.md
 * Nach jeder Aenderung an Themes.js (neues Thema, andere Akzentfarbe) neu laufen
 * lassen - __tests__/themes/appIcon.generator.test.js schlaegt sonst fehl.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = 'android/app/src/main/res';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const KOTLIN = 'android/app/src/main/java/com/securecommapp/AppIconVariants.kt';
const BUILD_GRADLE = 'android/app/build.gradle';
const FG_TEMPLATE = RES + '/drawable/ic_launcher_fg.xml';
const BG_TEMPLATE = RES + '/drawable/ic_launcher_bg.xml';
const MONO = '@drawable/ic_launcher_mono';
const FILE_PREFIX = 'ic_appicon_';
const BEGIN = '<!-- APP-ICON-ALIASES:BEGIN';
const END = '<!-- APP-ICON-ALIASES:END -->';
const GENERATED = 'GENERIERT von tools/gen-theme-icons.js - nicht von Hand aendern.';

// Marken-Hintergrund des Originals (drawable/ic_launcher_bg.xml)
const BRAND_BG = { light: '#101E4A', mid: '#071433', dark: '#02060F' };
// Marken-Farben des Originals (drawable/ic_launcher_fg.xml), nur fuer die Tabelle
const BRAND_MARK = { c1: '#36E0FF', c2: '#7C8CFF', keyhole: '#7FEFFF' };

// ── Farbrechnung ───────────────────────────────────────────────────────────

/**
 * Farben eines Icons aus dem aufgeloesten Design. T = Themes.js-Modul,
 * variant = Eintrag aus ICON_VARIANTS.
 */
function iconPalette(T, variant) {
  const theme = T.resolveTheme({ themeId: variant.themeId, accentKey: variant.accentKey || T.DEFAULT_ACCENT_KEY }, true);
  const klassik = variant.themeId === T.DEFAULT_THEME_ID;
  let bg;
  if (klassik) {
    // Standard-Design: Marken-Hintergrund bleibt, nur das Zeichen nimmt den Akzent an
    bg = { ...BRAND_BG };
  } else {
    // Kopfleiste = "Gesicht" des Designs; ist sie fast weiss, traegt der
    // App-Hintergrund die Toenung (Pergament, Kirschbluete, Elfenbein, Platin)
    const head = T.flatten(theme.headerBg, '#000000');
    const base = T.luminance(head) > 0.9 ? T.flatten(theme.bg, '#000000') : head;
    bg = T.luminance(base) < 0.18
      ? { light: T.mix(base, '#FFFFFF', 0.06), mid: base, dark: T.mix(base, '#000000', 0.45) }
      : { light: T.mix(base, '#FFFFFF', 0.4), mid: base, dark: T.mix(base, '#000000', 0.07) };
  }
  // ensureContrast mischt Richtung Weiss/Schwarz je nach ERSTEM Hintergrund
  const stops = [bg.mid, bg.light, bg.dark];
  const darkBg = T.luminance(bg.mid) < 0.18;
  const reaches = (c) => stops.every(b => T.contrastRatio(c, b) >= 3);
  let c1, c2;
  if (!klassik && !reaches(theme.accent) && bg.mid === T.flatten(theme.headerBg, '#000000') && reaches(theme.headerIcon)) {
    // Akzent hebt sich von der Kopfleiste nicht ab (Gletscher, Lagune,
    // Champagner, Malachi Artwork): Symbolfarbe der Kopfleiste als
    // Hauptfarbe, der Akzent wird zum Partner-Ton - statt eines blassen,
    // nur auf 3:1 aufgehellten Akzents.
    c1 = T.flatten(theme.headerIcon, '#000000');
    c2 = T.ensureContrast(theme.accent, stops, 3);
  } else {
    // wie das Malachi-Zeichen in der Kopfleiste (brandColors in App.tsx)
    c1 = T.ensureContrast(theme.accent, stops, 3);
    c2 = T.ensureContrast(T.mix(theme.accent, theme.text, 0.35), stops, 3);
  }
  const nodeHi = T.mix(c1, '#FFFFFF', darkBg ? 0.85 : 0.55);
  const nodeMid = T.ensureContrast(darkBg ? T.mix(c1, '#FFFFFF', 0.2) : c1, stops, 3);
  const nodeLo = darkBg ? T.mix(T.mix(c1, c2, 0.3), '#000000', 0.3) : T.mix(c1, '#000000', 0.35);
  const lockFill = bg.mid;
  const keyhole = T.ensureContrast(darkBg ? T.mix(c1, '#FFFFFF', 0.5) : c1, [lockFill], 3);
  return { id: variant.id, bg, ownBackground: !klassik, darkBg, c1, c2, nodeHi, nodeMid, nodeLo, lockFill, keyhole };
}

/** Kleinste Kontraste eines Icons: Zeichen auf allen Hintergrundtoenen, Schluesselloch auf dem Schloss. */
function paletteContrast(T, pal) {
  const stops = [pal.bg.light, pal.bg.mid, pal.bg.dark];
  const mark = Math.min(...[pal.c1, pal.c2, pal.nodeMid].flatMap(c => stops.map(b => T.contrastRatio(c, b))));
  return { mark, keyhole: T.contrastRatio(pal.keyhole, pal.lockFill) };
}

// ── Ausgabe ────────────────────────────────────────────────────────────────

const hex6 = (c) => {
  const m = /^#([0-9A-F]{6})$/i.exec(c);
  if (!m) throw new Error('Deckende Farbe (#RRGGBB) erwartet: ' + c);
  return m[1].toUpperCase();
};
/** Android-Farbe #AARRGGBB */
const argb = (alpha, c) => '#' + alpha + hex6(c);

/** Rolle jeder Farbe im Original-Vordergrund -> Farbe der Variante. */
const FG_ROLES = {
  '#2A36E0FF': p => argb('2A', p.c1),       // feine Umlaufbahn
  '#3336E0FF': p => argb('33', p.c1),       // Leuchten unter dem M
  '#FF36E0FF': p => argb('FF', p.c1),       // Verlauf M / Schlossring: Rand
  '#FF7C8CFF': p => argb('FF', p.c2),       // Verlauf M / Schlossring: Mitte
  '#7336E0FF': p => argb('73', p.c1),       // Halo innen
  '#0036E0FF': p => argb('00', p.c1),       // Halo aussen (transparent)
  '#FFE9FDFF': p => argb('FF', p.nodeHi),   // Knoten: Glanzpunkt
  '#FF5DE6FF': p => argb('FF', p.nodeMid),  // Knoten: Koerper
  '#FF0A7FD0': p => argb('FF', p.nodeLo),   // Knoten: Rand
  '#FF071433': p => argb('FF', p.lockFill), // Schloss-Flaeche
  '#FF7FEFFF': p => argb('FF', p.keyhole),  // Schluesselloch
};
const BG_ROLES = {
  '#FF101E4A': p => argb('FF', p.bg.light),
  '#FF071433': p => argb('FF', p.bg.mid),
  '#FF02060F': p => argb('FF', p.bg.dark),
};

function recolor(template, roles, pal, what) {
  return template.replace(/#[0-9A-Fa-f]{8}\b/g, (c) => {
    const role = roles[c.toUpperCase()];
    if (!role) throw new Error(what + ': unbekannte Farbe ' + c + ' in der Vorlage - Rolle in FG_ROLES/BG_ROLES ergaenzen');
    return role(pal);
  });
}

/** Umlaute fuer Kommentare (Dateien bleiben ASCII, wie die Vorlage). */
function ascii(s) {
  return String(s)
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/é/g, 'e')
    .replace(/[^\x20-\x7E]/g, '');
}

function replaceHeaderComment(template, comment, what) {
  if (!/<!--[\s\S]*?-->/.test(template)) throw new Error(what + ': Kopfkommentar fehlt in der Vorlage');
  return template.replace(/<!--[\s\S]*?-->/, comment);
}

function renderForeground(fgTemplate, pal, variant) {
  const out = recolor(lf(fgTemplate), FG_ROLES, pal, 'Vordergrund');
  return replaceHeaderComment(out,
    '<!-- ' + GENERATED + '\n' +
    '     App-Icon "' + ascii(variant.name) + '" (' + variant.id + '), Vordergrund: Geometrie exakt\n' +
    '     wie drawable/ic_launcher_fg.xml (66dp-Sicherheitszone), nur die Farben\n' +
    '     kommen aus dem Design (Themes.js). -->', 'Vordergrund');
}

function renderBackground(bgTemplate, pal, variant) {
  const out = recolor(lf(bgTemplate), BG_ROLES, pal, 'Hintergrund');
  return replaceHeaderComment(out,
    '<!-- ' + GENERATED + '\n' +
    '     App-Icon "' + ascii(variant.name) + '" (' + variant.id + '), Hintergrund: Verlauf aus der\n' +
    '     Designfarbe ' + pal.bg.mid + ', Geometrie wie drawable/ic_launcher_bg.xml. -->', 'Hintergrund');
}

const bgRef = (pal) => (pal.ownBackground ? '@drawable/' + FILE_PREFIX + pal.id + '_bg' : '@drawable/ic_launcher_bg');
const fgRef = (pal) => '@drawable/' + FILE_PREFIX + pal.id + '_fg';

function renderAdaptive(pal, variant) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!-- ' + GENERATED + '\n' +
    '     App-Icon "' + ascii(variant.name) + '" (' + variant.id + '); die einfarbige Ebene\n' +
    '     (Android 13+ "Designte Symbole") ist fuer alle Varianten dieselbe. -->\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="' + bgRef(pal) + '"/>\n' +
    '    <foreground android:drawable="' + fgRef(pal) + '"/>\n' +
    '    <monochrome android:drawable="' + MONO + '"/>\n' +
    '</adaptive-icon>\n';
}

function renderLayerList(pal, variant) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!-- ' + GENERATED + '\n' +
    '     Android 7.x (API 24/25, kein adaptives Icon): App-Icon "' + ascii(variant.name) + '"\n' +
    '     (' + variant.id + ') als einfache Ebenenliste. Ab Android 8 gilt mipmap-anydpi-v26. -->\n' +
    '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <item android:drawable="' + bgRef(pal) + '" />\n' +
    '    <item android:drawable="' + fgRef(pal) + '" />\n' +
    '</layer-list>\n';
}

function iconResource(V, variant) {
  return variant.id === V.DEFAULT_ICON_VARIANT ? '@mipmap/ic_launcher' : '@mipmap/' + FILE_PREFIX + variant.id;
}
function roundIconResource(V, variant) {
  return variant.id === V.DEFAULT_ICON_VARIANT ? '@mipmap/ic_launcher_round' : '@mipmap/' + FILE_PREFIX + variant.id;
}

/** Block mit allen activity-alias-Eintraegen (eingerueckt wie <application>-Kinder). */
function renderManifestBlock(V, namespace) {
  const lines = [
    '      ' + BEGIN + ' - ' + GENERATED,
    '           "App-Icon passend zum Design" (THEMES.md, Abschnitt "App-Icon"):',
    '           der Launcher-Eintrag liegt auf diesen Aliasen von MainActivity, genau',
    '           einer ist aktiv - im Manifest nur ' + V.ICON_ALIAS_PREFIX + V.DEFAULT_ICON_VARIANT + ' (bisheriges Icon).',
    '           AppIconModule.kt schaltet um (erst das neue an, dann das alte aus).',
    '           Deep Links, Benachrichtigungen und Anrufe zielen weiter direkt auf',
    '           MainActivity und haengen nicht vom gewaehlten Icon ab. -->',
  ];
  for (const v of V.ICON_VARIANTS) {
    const on = v.id === V.DEFAULT_ICON_VARIANT;
    lines.push(
      '      <!-- ' + ascii(v.name) + ' -->',
      '      <activity-alias',
      '          android:name="' + namespace + '.' + V.ICON_ALIAS_PREFIX + v.id + '"',
      // voll qualifiziert: die Demo-App hat eine andere applicationId als der Namespace
      '          android:targetActivity="' + namespace + '.MainActivity"',
      '          android:enabled="' + (on ? 'true' : 'false') + '"',
      '          android:exported="true"',
      '          android:label="${appLabel}"',
      '          android:icon="' + iconResource(V, v) + '"',
      '          android:roundIcon="' + roundIconResource(V, v) + '">',
      '          <intent-filter>',
      '              <action android:name="android.intent.action.MAIN" />',
      '              <category android:name="android.intent.category.LAUNCHER" />',
      '          </intent-filter>',
      '      </activity-alias>',
    );
  }
  lines.push('      ' + END);
  return lines.join('\n');
}

/** Block zwischen den Markern ersetzen (Zeilen inklusive der Marker selbst). */
function applyManifestBlock(manifest, block) {
  const text = lf(manifest);
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e < 0 || e < b) throw new Error('AndroidManifest.xml: Marker APP-ICON-ALIASES:BEGIN/END fehlen');
  const lineStart = text.lastIndexOf('\n', b) + 1;
  const lineEnd = text.indexOf('\n', e);
  return text.slice(0, lineStart) + block + (lineEnd < 0 ? '' : text.slice(lineEnd));
}

function renderKotlin(V, namespace) {
  return '// ' + GENERATED + '\n' +
    '// Feste Liste der App-Icon-Varianten (AppIconVariants.js, THEMES.md "App-Icon").\n' +
    '// AppIconModule.setIcon nimmt nur diese Ids an; jede hat im Manifest eine\n' +
    '// activity-alias ALIAS_PREFIX + id, aktiviert ist dort nur DEFAULT.\n' +
    'package ' + namespace + '\n' +
    '\n' +
    'object AppIconVariants {\n' +
    '    const val DEFAULT = "' + V.DEFAULT_ICON_VARIANT + '"\n' +
    '    const val ALIAS_PREFIX = "' + namespace + '.' + V.ICON_ALIAS_PREFIX + '"\n' +
    '    val IDS: List<String> = listOf(\n' +
    V.ICON_VARIANTS.map(v => '        "' + v.id + '",\n').join('') +
    '    )\n' +
    '}\n';
}

// ── Gesamtlauf ─────────────────────────────────────────────────────────────

const lf = (s) => String(s).replace(/\r\n/g, '\n');
const readRel = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function readNamespace(root) {
  const m = /^\s*namespace\s+["']([\w.]+)["']/m.exec(readRel(root, BUILD_GRADLE));
  if (!m) throw new Error('namespace in android/app/build.gradle nicht gefunden');
  return m[1];
}

/**
 * Alle erzeugten Dateien: Map relPfad -> Inhalt (LF). T = Themes.js,
 * V = AppIconVariants.js, root = Repo-Wurzel.
 */
function generate({ T, V, root = ROOT }) {
  const fgTemplate = readRel(root, FG_TEMPLATE);
  const bgTemplate = readRel(root, BG_TEMPLATE);
  const namespace = readNamespace(root);
  const files = new Map();
  const palettes = [];
  for (const v of V.ICON_VARIANTS) {
    if (!/^[a-z][a-z0-9_]*$/.test(v.id)) throw new Error('Ungueltige Icon-Id (Android-Ressourcenname): ' + v.id);
    if (v.id === V.DEFAULT_ICON_VARIANT) continue;
    const pal = iconPalette(T, v);
    const c = paletteContrast(T, pal);
    if (c.mark < 3 || c.keyhole < 3) throw new Error('Kontrast unter 3:1 bei ' + v.id + ': ' + JSON.stringify(c));
    palettes.push(pal);
    files.set(RES + '/drawable/' + FILE_PREFIX + v.id + '_fg.xml', renderForeground(fgTemplate, pal, v));
    if (pal.ownBackground) files.set(RES + '/drawable/' + FILE_PREFIX + v.id + '_bg.xml', renderBackground(bgTemplate, pal, v));
    files.set(RES + '/mipmap-anydpi-v26/' + FILE_PREFIX + v.id + '.xml', renderAdaptive(pal, v));
    files.set(RES + '/mipmap-anydpi/' + FILE_PREFIX + v.id + '.xml', renderLayerList(pal, v));
  }
  files.set(KOTLIN, renderKotlin(V, namespace));
  files.set(MANIFEST, applyManifestBlock(readRel(root, MANIFEST), renderManifestBlock(V, namespace)));
  return { files, palettes, namespace };
}

/** Erzeugte ic_appicon_*-Dateien, die zu keiner Variante mehr gehoeren (Thema entfernt). */
function staleFiles(root, files) {
  const out = [];
  for (const dir of ['drawable', 'mipmap-anydpi', 'mipmap-anydpi-v26']) {
    const abs = path.join(root, RES, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const rel = RES + '/' + dir + '/' + name;
      if (name.startsWith(FILE_PREFIX) && !files.has(rel)) out.push(rel);
    }
  }
  return out;
}

/** Zeilenende der Vorlage uebernehmen (Repo: CRLF im Arbeitsverzeichnis). */
function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }

/** Themes.js / AppIconVariants.js (ES-Module) ohne Bundler laden. */
function loadEsm(file, cache = new Map()) {
  const abs = path.resolve(file);
  if (cache.has(abs)) return cache.get(abs).exports;
  const babel = require('@babel/core');
  const { code } = babel.transformFileSync(abs, {
    babelrc: false, configFile: false, sourceType: 'module',
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  });
  const mod = { exports: {} };
  cache.set(abs, mod);
  const localRequire = (id) => {
    if (!id.startsWith('.')) return require(id);
    const p = path.resolve(path.dirname(abs), id);
    return loadEsm(fs.existsSync(p) ? p : p + '.js', cache);
  };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(mod.exports, localRequire, mod, abs, path.dirname(abs));
  return mod.exports;
}

function paletteTable(T, V, palettes) {
  const rows = ['| Variante | Design | Hintergrund | Zeichen (Akzent → Partner) | kleinster Kontrast Zeichen | Schlüsselloch |',
    '|---|---|---|---|---|---|'];
  const fmt = (x) => x.toFixed(2).replace('.', ',');
  const brand = { bg: BRAND_BG, c1: BRAND_MARK.c1, c2: BRAND_MARK.c2, nodeMid: '#5DE6FF', keyhole: BRAND_MARK.keyhole, lockFill: BRAND_BG.mid };
  for (const v of V.ICON_VARIANTS) {
    const p = v.id === V.DEFAULT_ICON_VARIANT ? brand : palettes.find(x => x.id === v.id);
    const c = paletteContrast(T, p);
    rows.push('| `' + v.id + '` | ' + v.name + (v.pro ? ' (Pro)' : '') + ' | `' + p.bg.mid + '` | `' + p.c1 + '` → `' + p.c2 + '` | ' +
      fmt(c.mark) + ' | ' + fmt(c.keyhole) + ' |');
  }
  return rows.join('\n');
}

function main(argv) {
  const T = loadEsm(path.join(ROOT, 'Themes.js'));
  const V = loadEsm(path.join(ROOT, 'AppIconVariants.js'));
  const { files, palettes } = generate({ T, V, root: ROOT });
  if (argv.includes('--table')) { process.stdout.write(paletteTable(T, V, palettes) + '\n'); return 0; }
  const check = argv.includes('--check');
  const eol = eolOf(readRel(ROOT, FG_TEMPLATE));
  const changed = [];
  for (const [rel, content] of files) {
    const abs = path.join(ROOT, rel);
    const target = rel === MANIFEST ? content.replace(/\n/g, eolOf(readRel(ROOT, MANIFEST))) : content.replace(/\n/g, eol);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (prev !== null && lf(prev) === lf(target)) continue;
    changed.push(rel);
    if (!check) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, target); }
  }
  const stale = staleFiles(ROOT, files);
  if (!check) for (const rel of stale) fs.unlinkSync(path.join(ROOT, rel));
  const variants = V.ICON_VARIANTS.length;
  if (check) {
    if (changed.length || stale.length) {
      process.stderr.write('App-Icons veraltet - bitte "node tools/gen-theme-icons.js" ausfuehren:\n' +
        [...changed, ...stale.map(s => s + ' (veraltet)')].map(s => '  ' + s).join('\n') + '\n');
      return 1;
    }
    process.stdout.write('App-Icons aktuell (' + variants + ' Varianten).\n');
    return 0;
  }
  process.stdout.write(variants + ' Varianten, ' + changed.length + ' Datei(en) geschrieben' +
    (stale.length ? ', ' + stale.length + ' veraltete entfernt' : '') + '.\n');
  return 0;
}

module.exports = {
  BRAND_BG, BRAND_MARK, FG_ROLES, BG_ROLES, FILE_PREFIX, FG_TEMPLATE, BG_TEMPLATE, MANIFEST, KOTLIN, RES, BEGIN, END,
  iconPalette, paletteContrast, renderForeground, renderBackground, renderAdaptive, renderLayerList,
  renderManifestBlock, applyManifestBlock, renderKotlin, generate, staleFiles, paletteTable, loadEsm, lf,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
