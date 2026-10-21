/**
 * Malachi - Design-Themen und Akzentfarben (Einstellungen -> "Design")
 *
 * Ein Thema ist ein VOLLSTAENDIGER Satz Farb-Tokens (siehe TOKEN_KEYS) - die
 * Oberflaeche (App.tsx, DesignSection.tsx) liest nur noch Tokens, keine festen
 * Hex-Werte mehr. App.tsx haelt dafuer weiter die globale Palette `P` und den
 * Akzent `AC` und gleicht beide bei jedem Themenwechsel ab (subscribeTheme).
 *
 *   "Standard" (klassik)  - kostenlos, das bisherige Nachtblau. Akzentfarbe frei
 *                           waehlbar (FREE_ACCENTS), Kopfleiste und Menue auf
 *                           Wunsch mit dem Akzent eingefaerbt (abgedunkelt).
 *   21 Design-Themen      - Vollversion (PRO_THEMES), je eine eigene Palette,
 *                           Akzent und Kopfleiste fest abgestimmt. In vier
 *                           Gruppen (THEME_CATEGORIES): Dunkel, Hell,
 *                           Business (schlicht, hell und dunkel) und Artwork
 *                           ("Malachi Artwork": knallige Comic-Tinte mit
 *                           Klecks-Muster hinter dem Chat, ChatArtwork.tsx).
 *
 * Kontrast (WCAG 2.1 AA): jede Kombination aus CONTRAST_RULES - Text 4.5:1,
 * grosse Schrift/Symbole/bedeutungstragende Raender 3:1 - gilt fuer jedes
 * Thema und jede Akzentfarbe (mit und ohne Einfaerben), geprueft in
 * __tests__/themes/themes.contrast.test.js. Einzige Ausnahme: das
 * UNVERAENDERTE Standard-Design (Cyan, nicht eingefaerbt) behaelt exakt die
 * bisherigen Farben, damit sich fuer niemanden etwas aendert, der kein Thema
 * waehlt - die dort bekannten Unterschreitungen stehen in LEGACY_EXCEPTIONS.
 * Sobald der Nutzer das Standard-Design anpasst (andere Akzentfarbe oder
 * Einfaerben), gilt die kontrastgepruefte Fassung (KLASSIK_AA).
 *
 * Vollversion: Ein Pro-Thema wird nur angezeigt, solange die Lizenz gueltig
 * ist (setThemeProUnlocked, aus subscribeLicense). Ohne Lizenz faellt die
 * Anzeige auf "Standard" zurueck, die gespeicherte Wahl bleibt aber erhalten
 * und greift wieder, sobald die Lizenz (wieder) gueltig ist. Auswaehlen ohne
 * Lizenz lehnt setThemeSelection ab (reason 'pro').
 *
 * Gespeichert in 'settings' (EncryptedStorage), rueckwaertskompatibel:
 *   accentColor (Hex, wie bisher), themeId (neu), tintChrome (neu),
 *   lockDesign/appIcon (Schalter), bgColor/fontSize/customBgUri (unveraendert).
 *   saveSettings() schreibt per Lesen-Zusammenfuehren-Schreiben, damit kein
 *   Schluessel verloren geht.
 */

// ── Farbrechnung (sRGB, WCAG 2.1) ──────────────────────────────────────────

const NAMED = { white: '#FFFFFF', black: '#000000' };

/** '#rgb' | '#rrggbb' | 'rgba(r,g,b,a)' | 'rgb(r,g,b)' | 'white' | 'black' -> {r,g,b,a} */
export function parseColor(c) {
  if (typeof c !== 'string') throw new Error('Farbe erwartet: ' + c);
  const s = (NAMED[c.toLowerCase()] || c).trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split('').map(x => parseInt(x + x, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error('Unbekanntes Farbformat: ' + c);
}

const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0').toUpperCase();
export function toHex({ r, g, b }) { return '#' + hex2(r) + hex2(g) + hex2(b); }

/** Halbtransparente Farbe auf einen deckenden Hintergrund legen -> deckendes Hex. */
export function flatten(fg, bg) {
  const f = parseColor(fg);
  if (f.a >= 1) return toHex(f);
  const b = parseColor(flatten(bg, '#000000'));
  return toHex({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) });
}

const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
export function luminance(c) {
  const { r, g, b } = parseColor(flatten(c, '#000000'));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** Kontrastverhaeltnis nach WCAG 2.1; fg darf halbtransparent sein (wird auf bg gelegt). */
export function contrastRatio(fg, bg) {
  const b = flatten(bg, '#000000');
  const l1 = luminance(flatten(fg, b));
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Lineare Mischung in sRGB: t=0 -> a, t=1 -> b. */
export function mix(a, b, t) {
  const x = parseColor(flatten(a, '#000000')), y = parseColor(flatten(b, '#000000'));
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
export function withAlpha(c, a) {
  const { r, g, b } = parseColor(c);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * fg so weit Richtung Weiss (dunkler Hintergrund) bzw. Schwarz (heller
 * Hintergrund) mischen, bis es auf ALLEN bgs mindestens `min` erreicht.
 * Bereits ausreichende Farben bleiben unveraendert.
 */
export function ensureContrast(fg, bgs, min = 4.5) {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  const ok = (c) => list.every(b => contrastRatio(c, b) >= min);
  if (ok(fg)) return flatten(fg, list[0]);
  const darkBg = luminance(list[0]) < 0.18;
  const target = darkBg ? '#FFFFFF' : '#000000';
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const c = mix(fg, target, t);
    if (ok(c)) return c;
  }
  return target;
}

/** Lesbarste Schrift auf einer Flaeche: hell oder dunkel (bevorzugt die erste, wenn sie reicht). */
export function bestOn(bg, light = '#FFFFFF', dark = '#04182F', min = 4.5) {
  if (contrastRatio(light, bg) >= min) return light;
  if (contrastRatio(dark, bg) >= min) return dark;
  return contrastRatio(light, bg) >= contrastRatio(dark, bg) ? light : dark;
}

// ── Tokens ────────────────────────────────────────────────────────────────

/** Vollstaendige Token-Liste - jedes aufgeloeste Thema hat genau diese Schluessel (plus Metadaten). */
export const TOKEN_KEYS = [
  // Flaechen und Schrift
  'bg', 'surface', 'surfaceAlt', 'border', 'borderStrong',
  'text', 'textSub', 'textMuted',
  // Akzent
  'accent', 'onAccent', 'accentFg', 'accentSoft', 'codeText', 'accentDeep',
  // Kopfleiste
  'headerBg', 'headerBorder', 'headerText', 'headerSub', 'headerMuted', 'headerIcon', 'headerVerified',
  'headerOnline', 'headerSuccess', 'headerWarning', 'headerDanger',
  // Menues (Dropdown/Kontextmenue)
  'menuBg', 'menuBorder', 'menuText', 'menuIcon', 'menuAccent', 'menuDanger',
  // Chat
  'chatBg', 'bubbleMine', 'bubbleMineText', 'bubbleMineMeta', 'bubbleMineSoft', 'bubbleMineTrack',
  'bubbleTheirs', 'bubbleTheirsBorder', 'bubbleTheirsText', 'bubbleTheirsMeta',
  // Status
  'danger', 'dangerFill', 'onDanger', 'success', 'warning', 'online',
  // Profilbild-Platzhalter (Initialen bzw. Gruppen-Symbol), auf Flaechen und in der Kopfleiste
  'avatarBg', 'avatarText', 'headerAvatarBg', 'headerAvatarText',
  // Sonstiges
  'overlay', 'statusBar',
];

/**
 * Wo welche Schrift-/Symbolfarbe auf welchem Hintergrund benutzt wird - die
 * Grundlage des Kontrasttests. `on` sind Token-Namen; 'x@y' heisst: Token x
 * (halbtransparent) liegt auf Token y.
 *   min 4.5: normale Schrift (WCAG 1.4.3)
 *   min 3.0: Symbole, grosse Schrift, bedeutungstragende Raender (1.4.11)
 */
export const CONTRAST_RULES = [
  { fg: 'text',             on: ['bg', 'surface', 'surfaceAlt'],                 min: 4.5 },
  { fg: 'textSub',          on: ['bg', 'surface', 'surfaceAlt'],                 min: 4.5 },
  { fg: 'textMuted',        on: ['bg', 'surface', 'surfaceAlt', 'chatBg'],       min: 4.5 },
  { fg: 'accentFg',         on: ['bg', 'surface', 'surfaceAlt', 'accentSoft@surface', 'accentSoft@bg'], min: 4.5 },
  { fg: 'codeText',         on: ['accentSoft@surface', 'accentSoft@bg'],         min: 4.5 },
  { fg: 'onAccent',         on: ['accent'],                                      min: 4.5 },
  // accentDeep: Akzent fuer Bildschirme mit eigener Palette und fest weisser
  // Knopfschrift (SiegelScreen.tsx) - Weiss darauf muss lesbar sein.
  { fg: '#FFFFFF',          on: ['accentDeep'],                                  min: 4.5 },
  { fg: 'accent',           on: ['bg', 'surface', 'surfaceAlt', 'bubbleTheirs'], min: 3.0 },
  { fg: 'borderStrong',     on: ['bg', 'surface', 'surfaceAlt'],                 min: 3.0 },
  { fg: 'headerText',       on: ['headerBg'],                                    min: 4.5 },
  { fg: 'headerSub',        on: ['headerBg'],                                    min: 4.5 },
  { fg: 'headerMuted',      on: ['headerBg'],                                    min: 4.5 },
  { fg: 'headerOnline',     on: ['headerBg'],                                    min: 4.5 },
  { fg: 'headerSuccess',    on: ['headerBg'],                                    min: 4.5 },
  { fg: 'headerWarning',    on: ['headerBg'],                                    min: 4.5 },
  { fg: 'headerDanger',     on: ['headerBg'],                                    min: 3.0 },
  { fg: 'headerIcon',       on: ['headerBg'],                                    min: 3.0 },
  { fg: 'headerVerified',   on: ['headerBg'],                                    min: 3.0 },
  { fg: 'menuText',         on: ['menuBg'],                                      min: 4.5 },
  { fg: 'menuDanger',       on: ['menuBg'],                                      min: 4.5 },
  { fg: 'menuIcon',         on: ['menuBg'],                                      min: 3.0 },
  { fg: 'menuAccent',       on: ['menuBg'],                                      min: 3.0 },
  { fg: 'bubbleMineText',   on: ['bubbleMine', 'bubbleMineSoft@bubbleMine'],     min: 4.5 },
  { fg: 'bubbleMineMeta',   on: ['bubbleMine'],                                  min: 4.5 },
  { fg: 'bubbleTheirsText', on: ['bubbleTheirs'],                                min: 4.5 },
  { fg: 'bubbleTheirsMeta', on: ['bubbleTheirs'],                                min: 4.5 },
  { fg: 'danger',           on: ['bg', 'surface', 'surfaceAlt'],                 min: 4.5 },
  { fg: 'success',          on: ['bg', 'surface'],                               min: 4.5 },
  { fg: 'warning',          on: ['bg', 'surface', 'surfaceAlt'],                 min: 4.5 },
  { fg: 'online',           on: ['bg', 'surface'],                               min: 4.5 },
  { fg: 'onDanger',         on: ['dangerFill'],                                  min: 4.5 },
  // Initialen im Profilbild-Platzhalter (Chatliste, Kontaktinfo, Gruppen, Kopfleiste)
  { fg: 'avatarText',       on: ['avatarBg'],                                    min: 4.5 },
  { fg: 'headerAvatarText', on: ['headerAvatarBg'],                              min: 4.5 },
];

/** Vordergrund aus CONTRAST_RULES: Token-Name oder feste Farbe ('#FFFFFF'). */
export function fgOf(theme, fg) {
  return fg.startsWith('#') ? fg : theme[fg];
}

/** Hintergrund-Ausdruck aus CONTRAST_RULES ('x' oder 'x@y') in eine deckende Farbe aufloesen. */
export function resolveBg(theme, expr) {
  const [top, under] = expr.split('@');
  return under ? flatten(theme[top], flatten(theme[under], '#000000')) : flatten(theme[top], '#000000');
}

/** Alle Kombinationen eines aufgeloesten Themas mit ihrem Kontrast (fuer Test und THEMES.md). */
export function contrastReport(theme) {
  const rows = [];
  for (const r of CONTRAST_RULES) {
    for (const on of r.on) {
      const bg = resolveBg(theme, on);
      rows.push({ fg: r.fg, on, min: r.min, ratio: contrastRatio(fgOf(theme, r.fg), bg) });
    }
  }
  return rows;
}

// ── Standard-Design ("klassik") ─────────────────────────────────────────────

/**
 * Exakt die bisherigen Farben (P/AC in App.tsx vor den Design-Themen). Gilt nur,
 * solange das Standard-Design unveraendert ist (Cyan, nicht eingefaerbt).
 */
export const KLASSIK_LEGACY = {
  bg: '#04182F', surface: '#0D2A4A', surfaceAlt: '#0A2340', border: '#1B3A5C', borderStrong: '#3A5A7A',
  text: '#F0F6FA', textSub: '#9FB8CC', textMuted: '#6E93AE',
  accent: '#0A7EA4', onAccent: '#FFFFFF', accentFg: '#0A7EA4', accentSoft: 'rgba(10,126,164,0.16)', codeText: '#8FD9F0',
  accentDeep: '#0A7EA4',
  headerBg: '#0D2A4A', headerBorder: '#1B3A5C', headerText: '#F0F6FA', headerSub: '#9FB8CC', headerMuted: '#6E93AE',
  headerIcon: '#0A7EA4', headerVerified: '#8FD9F0',
  headerOnline: '#0A7EA4', headerSuccess: '#2ECC71', headerWarning: '#E0A33A', headerDanger: '#E74C3C',
  menuBg: '#0D2A4A', menuBorder: '#1B3A5C', menuText: '#F0F6FA', menuIcon: '#F0F6FA', menuAccent: '#0A7EA4', menuDanger: '#E74C3C',
  chatBg: '#061F3A', chatBgLight: '#F7F5F2',
  bubbleMine: '#0A7EA4', bubbleMineText: '#FFFFFF', bubbleMineMeta: 'rgba(255,255,255,0.65)',
  bubbleMineSoft: 'rgba(255,255,255,0.2)', bubbleMineTrack: 'rgba(255,255,255,0.3)',
  bubbleTheirs: '#0D2A4A', bubbleTheirsBorder: '#1B3A5C', bubbleTheirsText: '#F0F6FA', bubbleTheirsMeta: '#6E93AE',
  danger: '#E74C3C', dangerFill: '#E74C3C', onDanger: '#FFFFFF', success: '#2ECC71', warning: '#E0A33A', online: '#0A7EA4',
  overlay: 'rgba(0,0,0,0.5)', statusBar: 'light-content',
  // bisher pro Kontakt fest gespeichert (color/tc: '#0A2340'/'#0A7EA4', nur 3.4:1) -
  // Initialen jetzt minimal heller, damit sie lesbar sind (4.6:1)
  avatarBg: '#0A2340', avatarText: '#3695B4', headerAvatarBg: '#0A2340', headerAvatarText: '#3695B4',
};

/**
 * Bekannte Kontrast-Unterschreitungen des UNVERAENDERTEN Standard-Designs
 * (bewusst beibehalten: "nichts aendert sich fuer Nutzer ohne Thema"). Der
 * Test prueft, dass genau diese - und keine weiteren - Kombinationen darunter
 * liegen. Wer sie beheben will: KLASSIK_AA zeigt die korrigierten Werte.
 */
export const LEGACY_EXCEPTIONS = [
  'textMuted@surface', 'headerMuted@headerBg', 'bubbleTheirsMeta@bubbleTheirs',
  'accentFg@bg', 'accentFg@surface', 'accentFg@surfaceAlt', 'accentFg@accentSoft@surface', 'accentFg@accentSoft@bg',
  'headerOnline@headerBg', 'online@bg', 'online@surface',
  'danger@surface', 'danger@surfaceAlt', 'menuDanger@menuBg', 'onDanger@dangerFill',
  'borderStrong@bg', 'borderStrong@surface', 'borderStrong@surfaceAlt',
  'bubbleMineMeta@bubbleMine', 'bubbleMineText@bubbleMineSoft@bubbleMine',
];

/**
 * Kontrastgepruefte Fassung des Standard-Designs - gilt, sobald der Nutzer es
 * anpasst. Optisch praktisch gleich (nur die zu schwachen Toene minimal heller).
 */
export const KLASSIK_AA = {
  ...KLASSIK_LEGACY,
  textMuted: '#7398B3', headerMuted: '#7398B3', bubbleTheirsMeta: '#7398B3', borderStrong: '#7398B3',
  danger: '#FF7A6B', headerDanger: '#FF7A6B', menuDanger: '#FF7A6B', dangerFill: '#C0392B',
  online: '#4FC3E8', headerOnline: '#4FC3E8',
  statusBar: 'light-content',
};

// ── Kostenlose Akzentfarben (nur Standard-Design) ───────────────────────────

/**
 * 12 Akzentfarben. Schrift auf dem Akzent (Knoepfe, eigene Blasen; bestOn):
 * Weiss nur, wo es 4.5:1 schafft, sonst Nachtblau. Jede ist auf allen
 * Flaechen des Standard-Designs als Symbolfarbe >= 3:1 sichtbar; fuer kleine
 * Schrift in Akzentfarbe wird automatisch eine hellere Variante (accentFg)
 * abgeleitet. key bleibt stabil (gespeichert wird zusaetzlich der Hex-Wert).
 */
export const FREE_ACCENTS = [
  { key: 'cyan',   label: 'Cyan',     color: '#0A7EA4' },
  { key: 'teal',   label: 'Türkis',   color: '#2BB3A8' },
  { key: 'mint',   label: 'Minze',    color: '#5ED3A5' },
  { key: 'green',  label: 'Grün',     color: '#6CC05C' },
  { key: 'brown',  label: 'Sand',     color: '#C9A27C' },
  { key: 'gold',   label: 'Gold',     color: '#D9B44A' },
  { key: 'coral',  label: 'Koralle',  color: '#F28C6F' },
  { key: 'rose',   label: 'Rosé',     color: '#E89AB8' },
  { key: 'lilac',  label: 'Lila',     color: '#B591D9' },
  { key: 'violet', label: 'Violett',  color: '#9AA5F5' },
  { key: 'blue',   label: 'Blau',     color: '#4A90D9' },
  { key: 'silver', label: 'Silber',   color: '#AEBBC8' },
];
export const DEFAULT_ACCENT_KEY = 'cyan';

/** Fruehere Akzent-Hexwerte (vor den Design-Themen) -> heutiger key. */
const LEGACY_ACCENT_HEX = {
  '#0A7EA4': 'cyan', '#8B7355': 'brown', '#4A90D9': 'blue', '#4A8B46': 'green', '#9B6B9B': 'lilac',
};

export function accentByKey(key) {
  return FREE_ACCENTS.find(a => a.key === key) || FREE_ACCENTS.find(a => a.key === DEFAULT_ACCENT_KEY);
}
/** Gespeicherten Hex-Wert (alt oder neu) einer Akzentfarbe zuordnen; Unbekanntes -> Standard. */
export function accentKeyFromHex(hex) {
  if (typeof hex !== 'string') return DEFAULT_ACCENT_KEY;
  const h = hex.trim().toUpperCase();
  const hit = FREE_ACCENTS.find(a => a.color.toUpperCase() === h);
  if (hit) return hit.key;
  return LEGACY_ACCENT_HEX[h] || DEFAULT_ACCENT_KEY;
}

// ── Design-Themen (Vollversion) ─────────────────────────────────────────────

/**
 * Jedes Thema gibt seine Grundfarben vor; was fehlt, leitet buildTheme() ab
 * (immer kontrastgesichert). Namen deutsch, Paletten bewusst verschieden.
 * id bleibt stabil (gespeichert als themeId), category ordnet das Thema einer
 * Gruppe im Picker zu (THEME_CATEGORIES). Optional: artwork ('splat') und
 * artworkInks - dekoratives Muster hinter dem Chatverlauf (ChatArtwork.tsx).
 */
export const PRO_THEMES = [
  {
    id: 'graphit', name: 'Graphit', desc: 'Neutrales Anthrazit mit Eisblau', dark: true, category: 'dunkel',
    bg: '#121417', surface: '#1B1E23', surfaceAlt: '#16191D', border: '#2A2F36', borderStrong: '#6B7480',
    text: '#ECEFF3', textSub: '#B6BEC8', textMuted: '#959EAA',
    accent: '#8AB4F8', onAccent: '#0E1726',
    headerBg: '#1B1E23', menuBg: '#23272D', chatBg: '#0F1114',
    bubbleMine: '#2F4F80', bubbleMineText: '#F2F6FC', bubbleTheirs: '#20242A',
    danger: '#FF8A80', success: '#7DD3A0', warning: '#F2C26B', online: '#7DD3A0',
  },
  {
    id: 'wald', name: 'Waldnacht', desc: 'Tiefes Tannengrün mit Salbei', dark: true, category: 'dunkel',
    bg: '#0D1A14', surface: '#15261D', surfaceAlt: '#112019', border: '#24392D', borderStrong: '#5E8370',
    text: '#EAF2EC', textSub: '#B5C9BC', textMuted: '#91AA9B',
    accent: '#7CC79F', onAccent: '#0A1A12',
    headerBg: '#15261D', menuBg: '#1B2E23', chatBg: '#0B1611',
    bubbleMine: '#2C5A43', bubbleMineText: '#EFF8F2', bubbleTheirs: '#18291F',
    danger: '#FF9488', success: '#8FD6A8', warning: '#E9C46A', online: '#8FD6A8',
  },
  {
    id: 'amethyst', name: 'Amethyst', desc: 'Ruhiges Violett mit Lavendel', dark: true, category: 'dunkel',
    bg: '#16121F', surface: '#201A2C', surfaceAlt: '#1B1626', border: '#332A44', borderStrong: '#75688F',
    text: '#F1EDF7', textSub: '#C6BCD7', textMuted: '#A296B6',
    accent: '#B79CFF', onAccent: '#1A1030',
    headerBg: '#201A2C', menuBg: '#271F35', chatBg: '#130F1B',
    bubbleMine: '#4C3A7A', bubbleMineText: '#F5F1FC', bubbleTheirs: '#241D31',
    danger: '#FF8FA3', success: '#86D9B0', warning: '#F0C674', online: '#86D9B0',
  },
  {
    id: 'bernstein', name: 'Bernstein', desc: 'Warmes Espresso mit Bernstein', dark: true, category: 'dunkel',
    bg: '#17120E', surface: '#221B15', surfaceAlt: '#1C1612', border: '#3A2F25', borderStrong: '#7D6B5A',
    text: '#F5EFE8', textSub: '#CFC1B1', textMuted: '#AB9B8C',
    accent: '#E8B062', onAccent: '#22170C',
    headerBg: '#221B15', menuBg: '#2A221B', chatBg: '#14100C',
    bubbleMine: '#6A4A24', bubbleMineText: '#FCF5EB', bubbleTheirs: '#2A221B',
    danger: '#FF8F7A', success: '#9ED091', warning: '#F2C46D', online: '#9ED091',
  },
  {
    id: 'bordeaux', name: 'Bordeaux', desc: 'Gedecktes Weinrot mit Rosé', dark: true, category: 'dunkel',
    bg: '#1A0F13', surface: '#26161C', surfaceAlt: '#201218', border: '#3E2530', borderStrong: '#80606D',
    text: '#F7ECEF', textSub: '#D8BFC8', textMuted: '#B497A2',
    accent: '#E79BB0', onAccent: '#2A0E18',
    headerBg: '#26161C', menuBg: '#2E1B22', chatBg: '#160C10',
    bubbleMine: '#6C2D43', bubbleMineText: '#FCF0F4', bubbleTheirs: '#2D1A21',
    danger: '#FF9C7A', success: '#93D3A6', warning: '#F0C46E', online: '#93D3A6',
  },
  {
    id: 'pergament', name: 'Pergament', desc: 'Helles Papier mit Petrol', dark: false, category: 'hell',
    bg: '#F6F2EA', surface: '#FFFDF8', surfaceAlt: '#EFE9DE', border: '#E2D9CA', borderStrong: '#8A7F70',
    text: '#1F1A14', textSub: '#4A4238', textMuted: '#675E52',
    accent: '#0E6B6B', onAccent: '#FFFFFF',
    headerBg: '#FFFDF8', menuBg: '#FFFDF8', chatBg: '#EFE8DC',
    bubbleMine: '#0E6B6B', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFDF8', bubbleTheirsBorder: '#E2D9CA',
    danger: '#B3261E', success: '#2C7A4B', warning: '#8A5A00', online: '#2C7A4B',
    overlay: 'rgba(31,26,20,0.45)',
  },
  {
    id: 'gletscher', name: 'Gletscher', desc: 'Kühles Hellgrau mit Königsblau', dark: false, category: 'hell',
    bg: '#F2F5F8', surface: '#FFFFFF', surfaceAlt: '#E8EDF2', border: '#D5DDE5', borderStrong: '#76838F',
    text: '#142130', textSub: '#3B4B5C', textMuted: '#596878',
    accent: '#2457C5', onAccent: '#FFFFFF',
    headerBg: '#1E3A5F', headerBorder: '#1E3A5F', headerText: '#FFFFFF', headerIcon: '#FFFFFF',
    menuBg: '#FFFFFF', chatBg: '#E7ECF2',
    bubbleMine: '#2457C5', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#D5DDE5',
    danger: '#B42318', success: '#1E7A4C', warning: '#8A5300', online: '#1E7A4C',
    overlay: 'rgba(20,33,48,0.45)',
  },

  // ── Hell: freundlich, hell bis pastell (Nutzerwunsch Okt. 2026) ──
  {
    id: 'kirschbluete', name: 'Kirschblüte', desc: 'Zartes Rosa mit Beerenrot', dark: false, category: 'hell',
    bg: '#FFF4F6', surface: '#FFFFFF', surfaceAlt: '#FBE7EC', border: '#F2D3DB', borderStrong: '#9A7480',
    text: '#2B1419', textSub: '#56383F', textMuted: '#74545C',
    accent: '#C2185B', onAccent: '#FFFFFF', accentFg: '#A3124E',
    headerBg: '#FFFFFF', menuBg: '#FFFFFF', chatBg: '#FCEEF2',
    bubbleMine: '#C2185B', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#F2D3DB',
    danger: '#B42318', success: '#2C7A4B', warning: '#8A5300', online: '#2C7A4B',
    overlay: 'rgba(43,20,25,0.45)',
  },
  {
    id: 'lavendel', name: 'Lavendel', desc: 'Helles Flieder mit Violett', dark: false, category: 'hell',
    bg: '#F6F3FC', surface: '#FFFFFF', surfaceAlt: '#ECE6F7', border: '#DDD4EE', borderStrong: '#857A9C',
    text: '#1E1830', textSub: '#463D5C', textMuted: '#655B7C',
    accent: '#6A3FC8', onAccent: '#FFFFFF',
    headerBg: '#EDE6FA', headerBorder: '#DDD4EE', menuBg: '#FFFFFF', chatBg: '#EEE9F8',
    bubbleMine: '#6A3FC8', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#DDD4EE',
    danger: '#B42318', success: '#1E7A4C', warning: '#8A5300', online: '#1E7A4C',
    overlay: 'rgba(30,24,48,0.45)',
  },
  {
    id: 'pistazie', name: 'Pistazie', desc: 'Frisches Hellgrün mit Smaragd', dark: false, category: 'hell',
    bg: '#F3F8EE', surface: '#FFFFFF', surfaceAlt: '#E6F0DD', border: '#D3E3C6', borderStrong: '#768A68',
    text: '#16220F', textSub: '#3A4A30', textMuted: '#56684B',
    accent: '#1B7A50', onAccent: '#FFFFFF',
    headerBg: '#E2F0D5', headerBorder: '#D3E3C6', menuBg: '#FFFFFF', chatBg: '#EAF3E2',
    bubbleMine: '#1B7A50', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#D3E3C6',
    danger: '#B42318', success: '#2B7A2E', warning: '#8A5300', online: '#2B7A2E',
    overlay: 'rgba(22,34,15,0.45)',
  },
  {
    id: 'sonnenschein', name: 'Sonnenschein', desc: 'Buttergelb mit warmem Orange', dark: false, category: 'hell',
    bg: '#FFFAEB', surface: '#FFFFFF', surfaceAlt: '#FFF1CC', border: '#F2E2B3', borderStrong: '#938253',
    text: '#2A2108', textSub: '#53461F', textMuted: '#6C5E30',
    accent: '#B54708', onAccent: '#FFFFFF',
    headerBg: '#FFE38A', headerBorder: '#F2D46A', menuBg: '#FFFFFF', chatBg: '#FFF5D9',
    bubbleMine: '#B54708', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#F2E2B3',
    danger: '#A61B1B', success: '#3B7A1E', warning: '#7F4E00', online: '#3B7A1E',
    overlay: 'rgba(42,33,8,0.45)',
  },
  {
    id: 'lagune', name: 'Lagune', desc: 'Helles Aqua mit Türkis-Kopfleiste', dark: false, category: 'hell',
    bg: '#EEF8F8', surface: '#FFFFFF', surfaceAlt: '#DFF1F1', border: '#C6E3E3', borderStrong: '#6A898B',
    text: '#0E2426', textSub: '#2F4A4D', textMuted: '#4B6668',
    accent: '#0E7490', onAccent: '#FFFFFF',
    headerBg: '#0E7490', headerBorder: '#0E7490', headerText: '#FFFFFF', headerIcon: '#FFFFFF',
    headerSub: '#F0FAFB', headerMuted: '#DDF2F5', headerVerified: '#B9EEF4',
    menuBg: '#FFFFFF', chatBg: '#E2F3F3',
    bubbleMine: '#0E7490', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#C6E3E3',
    danger: '#B42318', success: '#1E7A4C', warning: '#8A5300', online: '#1E7A4C',
    overlay: 'rgba(14,36,38,0.45)',
  },
  {
    id: 'pfirsich', name: 'Pfirsich', desc: 'Warmes Apricot mit Koralle', dark: false, category: 'hell',
    bg: '#FFF3EB', surface: '#FFFFFF', surfaceAlt: '#FFE6D6', border: '#F5D2BD', borderStrong: '#9C7A66',
    text: '#2B1A12', textSub: '#573D30', textMuted: '#76584A',
    accent: '#B83D2A', onAccent: '#FFFFFF',
    headerBg: '#F7A98E', headerBorder: '#F09A7C', menuBg: '#FFFFFF', chatBg: '#FFEBDF',
    bubbleMine: '#B83D2A', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#F5D2BD',
    danger: '#A3121F', success: '#2C7A4B', warning: '#7F4E00', online: '#2C7A4B',
    overlay: 'rgba(43,26,18,0.45)',
  },

  // ── Artwork: "mal etwas komplett anderes" - Comic-Tinte (Splatoon-artig) ──
  // Knallige Tinten (Magenta, Limette, Orange, Tuerkis, Violett) als
  // Klecks-Muster hinter dem Chat (artwork: 'splat', ChatArtwork.tsx). Das
  // Muster wird nur schwach in chatBg gemischt (artworkFills, buildTheme) -
  // die Blasen bleiben deckend, Schrift darauf unberuehrt.
  {
    id: 'artwork', name: 'Malachi Artwork', desc: 'Knallbunte Comic-Tinte mit Klecksen', dark: false, category: 'artwork',
    bg: '#FFF9EC', surface: '#FFFFFF', surfaceAlt: '#F7EEFF', border: '#EADCF5', borderStrong: '#8A6FA6',
    text: '#1F0E3A', textSub: '#45306A', textMuted: '#5E4C84',
    accent: '#D4006E', onAccent: '#FFFFFF',
    headerBg: '#2A0B52', headerBorder: '#2A0B52', headerText: '#FFFFFF', headerSub: '#E6D9FF', headerMuted: '#CDBBF0',
    headerIcon: '#C6F432', headerVerified: '#C6F432', headerOnline: '#C6F432',
    headerSuccess: '#C6F432', headerWarning: '#FFC24D', headerDanger: '#FF7A8A',
    menuBg: '#FFFFFF', chatBg: '#FFF9EC',
    bubbleMine: '#C6F432', bubbleMineText: '#1F0E3A', bubbleMineMeta: '#4A3A6E', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#E9D2F7',
    danger: '#B42318', success: '#1E7A3C', warning: '#8A5300', online: '#1E7A3C',
    overlay: 'rgba(31,14,58,0.5)',
    artwork: 'splat',
    artworkInks: ['#FF2E93', '#8BD100', '#FF7A00', '#00BCC8', '#7B2FF7'],
  },

  // ── Business: schlicht und elegant, dunkel und hell ──
  {
    id: 'onyx', name: 'Onyx', desc: 'Tiefschwarz mit Platin', dark: true, category: 'business',
    bg: '#0A0A0B', surface: '#151517', surfaceAlt: '#101012', border: '#27272B', borderStrong: '#6C6C74',
    text: '#F2F2F3', textSub: '#BDBDC3', textMuted: '#9B9BA3',
    accent: '#C9CED6', onAccent: '#111215',
    headerBg: '#0A0A0B', headerBorder: '#222226', menuBg: '#1B1B1E', chatBg: '#050506',
    bubbleMine: '#2F3137', bubbleMineText: '#F4F5F7', bubbleTheirs: '#18181B', bubbleTheirsBorder: '#27272B',
    danger: '#FF8A80', success: '#8BD3A8', warning: '#E8C37A', online: '#8BD3A8',
  },
  {
    id: 'marine', name: 'Marine', desc: 'Dunkles Marineblau mit Gold', dark: true, category: 'business',
    bg: '#0B1322', surface: '#121D31', surfaceAlt: '#0E182A', border: '#203049', borderStrong: '#5F7192',
    text: '#EEF2F8', textSub: '#B8C3D4', textMuted: '#94A2B7',
    accent: '#D4B06A', onAccent: '#1A1405',
    headerBg: '#121D31', menuBg: '#17243B', chatBg: '#08101D', avatarBg: '#1F2F4D',
    bubbleMine: '#24426E', bubbleMineText: '#F2F5FA', bubbleTheirs: '#162339',
    danger: '#FF8F85', success: '#7FD1A4', warning: '#F0C66E', online: '#7FD1A4',
  },
  {
    id: 'schiefer', name: 'Schiefer', desc: 'Blaugrauer Schiefer mit Kupfer', dark: true, category: 'business',
    bg: '#1A2027', surface: '#232A33', surfaceAlt: '#1E252D', border: '#333C47', borderStrong: '#717D8B',
    text: '#EDF0F3', textSub: '#BEC6CF', textMuted: '#9DA7B2',
    accent: '#D99A6C', onAccent: '#24160C',
    headerBg: '#232A33', menuBg: '#2A323C', chatBg: '#171C22', avatarBg: '#33404D',
    bubbleMine: '#3A4757', bubbleMineText: '#F3F5F8', bubbleTheirs: '#262E38',
    danger: '#FF8F80', success: '#86CFA0', warning: '#EBC170', online: '#86CFA0',
  },
  {
    id: 'rauchquarz', name: 'Rauchquarz', desc: 'Rauchiges Taupe mit Roségold', dark: true, category: 'business',
    bg: '#1C1A1A', surface: '#262323', surfaceAlt: '#211E1E', border: '#3B3534', borderStrong: '#81756F',
    text: '#F4EFEC', textSub: '#CFC5BF', textMuted: '#ADA29B',
    accent: '#E2A99A', onAccent: '#2A1712',
    headerBg: '#262323', menuBg: '#2D2928', chatBg: '#171515',
    bubbleMine: '#5C443D', bubbleMineText: '#FBF3F0', bubbleTheirs: '#2B2726',
    danger: '#FF7B72', success: '#94D1A6', warning: '#EEC373', online: '#94D1A6',
  },
  {
    id: 'elfenbein', name: 'Elfenbein', desc: 'Warmes Elfenbein mit Marineblau', dark: false, category: 'business',
    bg: '#FAF7F0', surface: '#FFFFFF', surfaceAlt: '#F1ECE1', border: '#E3DCCD', borderStrong: '#8C8473',
    text: '#1A1C22', textSub: '#43464F', textMuted: '#61646D',
    accent: '#1F3B66', onAccent: '#FFFFFF',
    headerBg: '#FFFFFF', menuBg: '#FFFFFF', chatBg: '#F3EFE6', avatarBg: '#DDE4EF',
    bubbleMine: '#213D69', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#E3DCCD',
    danger: '#A8251C', success: '#2B6E47', warning: '#85540A', online: '#2B6E47',
    overlay: 'rgba(26,28,34,0.45)',
  },
  {
    id: 'champagner', name: 'Champagner', desc: 'Champagner mit dunklem Mokka', dark: false, category: 'business',
    bg: '#F4EEE4', surface: '#FCF9F4', surfaceAlt: '#ECE3D5', border: '#DFD3C1', borderStrong: '#8E806C',
    text: '#2A211A', textSub: '#51463B', textMuted: '#6B5F52',
    accent: '#8A6A3A', onAccent: '#FFFFFF',
    headerBg: '#3B2F27', headerBorder: '#3B2F27', headerText: '#F6EEDF', headerIcon: '#E3C796',
    menuBg: '#FCF9F4', chatBg: '#EEE6D9',
    bubbleMine: '#5A4636', bubbleMineText: '#FBF5EC', bubbleTheirs: '#FCF9F4', bubbleTheirsBorder: '#DFD3C1',
    danger: '#A8251C', success: '#2E6B45', warning: '#7F5208', online: '#2E6B45',
    overlay: 'rgba(42,33,26,0.45)',
  },
  {
    id: 'platin', name: 'Platin', desc: 'Kühles Platin mit Anthrazit', dark: false, category: 'business',
    bg: '#EEF0F3', surface: '#FFFFFF', surfaceAlt: '#E4E7EB', border: '#D2D6DC', borderStrong: '#7A818B',
    text: '#15181D', textSub: '#3C424B', textMuted: '#5A616B',
    accent: '#3A4452', onAccent: '#FFFFFF',
    headerBg: '#FFFFFF', menuBg: '#FFFFFF', chatBg: '#E6E9ED',
    bubbleMine: '#3A4452', bubbleMineText: '#FFFFFF', bubbleTheirs: '#FFFFFF', bubbleTheirsBorder: '#D2D6DC',
    danger: '#B42318', success: '#1E7A4C', warning: '#8A5300', online: '#1E7A4C',
    overlay: 'rgba(21,24,29,0.45)',
  },
];

/**
 * Gruppen im Design-Picker (DesignSection.tsx), in dieser Reihenfolge. Jedes
 * Thema hat genau eine; "Standard" zaehlt zu Dunkel.
 */
export const THEME_CATEGORIES = [
  { key: 'dunkel',   label: 'Dunkel' },
  { key: 'hell',     label: 'Hell' },
  { key: 'business', label: 'Business' },
  { key: 'artwork',  label: 'Artwork' },
];

export const KLASSIK_META = { id: 'klassik', name: 'Standard', desc: 'Nachtblau mit frei wählbarem Akzent', dark: true, pro: false, category: 'dunkel' };
export const DEFAULT_THEME_ID = 'klassik';
export const THEME_IDS = [DEFAULT_THEME_ID, ...PRO_THEMES.map(t => t.id)];

/** Picker-Gruppen mit ihren Pro-Themen: [{ key, label, themes }] (leere Gruppen fallen weg). */
export function themesByCategory() {
  return THEME_CATEGORIES
    .map(c => ({ ...c, themes: PRO_THEMES.filter(t => t.category === c.key) }))
    .filter(c => c.themes.length > 0);
}

export function isProTheme(themeId) { return PRO_THEMES.some(t => t.id === themeId); }
/** Vollversion-Regel: Pro-Themen nur mit gueltiger Lizenz; Standard immer. */
export function canUseTheme(themeId, pro) {
  if (!isProTheme(themeId)) return themeId === DEFAULT_THEME_ID;
  return pro === true;
}

/**
 * Leichte Flaeche auf einer Blase (Play-Knopf, Tempo-Anzeige): dunkelt hinter
 * heller Schrift ab bzw. hellt hinter dunkler Schrift auf - der Kontrast der
 * Schrift darauf steigt dadurch, statt zu sinken.
 */
/** Akzent so weit abdunkeln, dass weisse Schrift darauf >= 4.5:1 hat. */
export function deepen(accent) {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(accent, '#000000', t);
    if (contrastRatio('#FFFFFF', c) >= 4.5) return c;
  }
  return '#000000';
}

function softOn(textColor) {
  return luminance(textColor) > 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.3)';
}

/** Fehlende Tokens kontrastgesichert ableiten. Explizit gesetzte Werte bleiben. */
export function buildTheme(base) {
  const t = { ...base };
  const d = (k, v) => { if (t[k] === undefined) t[k] = typeof v === 'function' ? v() : v; };
  const dark = t.dark !== false;
  d('borderStrong', () => ensureContrast(t.border, [t.bg, t.surface, t.surfaceAlt], 3));
  d('onAccent', () => bestOn(t.accent));
  d('accentSoft', () => withAlpha(t.accent, dark ? 0.16 : 0.12));
  // accentFg muss auch auf der Akzent-Toenung lesbar sein (Sicherheitscode, Nummern)
  d('accentFg', () => ensureContrast(t.accent, [t.bg, t.surface, t.surfaceAlt,
    flatten(t.accentSoft, t.surface), flatten(t.accentSoft, t.bg)], 4.5));
  d('codeText', () => t.accentFg);
  d('accentDeep', () => deepen(t.accent));
  d('headerBg', t.surface);
  d('headerBorder', t.border);
  d('headerText', () => ensureContrast(t.text, t.headerBg));
  d('headerSub', () => ensureContrast(t.textSub, t.headerBg));
  d('headerMuted', () => ensureContrast(t.textMuted, t.headerBg));
  d('headerIcon', () => ensureContrast(t.accent, t.headerBg, 3));
  d('headerVerified', () => ensureContrast(t.codeText, t.headerBg, 3));
  d('headerOnline', () => ensureContrast(t.online, t.headerBg));
  d('headerSuccess', () => ensureContrast(t.success, t.headerBg));
  d('headerWarning', () => ensureContrast(t.warning, t.headerBg));
  d('headerDanger', () => ensureContrast(t.danger, t.headerBg, 3));
  d('menuBg', t.surface);
  d('menuBorder', t.border);
  d('menuText', () => ensureContrast(t.text, t.menuBg));
  d('menuIcon', () => t.menuText);
  d('menuAccent', () => ensureContrast(t.accent, t.menuBg, 3));
  d('menuDanger', () => ensureContrast(t.danger, t.menuBg));
  d('chatBg', t.bg);
  d('bubbleMine', t.accent);
  d('bubbleMineText', () => bestOn(t.bubbleMine, '#FFFFFF', t.text === undefined ? '#04182F' : (dark ? '#04182F' : t.text)));
  d('bubbleMineMeta', () => ensureContrast(mix(t.bubbleMineText, t.bubbleMine, 0.2), t.bubbleMine));
  d('bubbleMineSoft', () => softOn(t.bubbleMineText));
  d('bubbleMineTrack', () => withAlpha(t.bubbleMineText, 0.3));
  d('bubbleTheirs', t.surface);
  d('bubbleTheirsBorder', t.border);
  d('bubbleTheirsText', () => ensureContrast(t.text, t.bubbleTheirs));
  d('bubbleTheirsMeta', () => ensureContrast(t.textMuted, t.bubbleTheirs));
  d('dangerFill', () => (dark ? '#C0392B' : t.danger));
  d('onDanger', () => bestOn(t.dangerFill));
  d('overlay', 'rgba(0,0,0,0.5)');
  d('statusBar', () => statusBarFor(t.headerBg));
  // Profilbild-Platzhalter: ruhige Akzent-Toenung, Initialen in Akzentfarbe
  // (wie die Kopfzeile des Themas, nicht mehr fest Nachtblau/Tuerkis).
  d('avatarBg', () => mix(t.surfaceAlt, t.accent, dark ? 0.24 : 0.16));
  d('avatarText', () => ensureContrast(t.accentFg, t.avatarBg));
  d('headerAvatarBg', () => mix(t.headerBg, t.accent, luminance(t.headerBg) < 0.18 ? 0.28 : 0.16));
  d('headerAvatarText', () => ensureContrast(luminance(t.headerAvatarBg) < 0.18 ? t.headerText : t.accentFg, t.headerAvatarBg));
  // Artwork-Muster hinter dem Chat (nur Themen mit `artwork`): jede Tinte so
  // kraeftig wie moeglich (hoechstens ARTWORK_INK_SHARE in chatBg gemischt),
  // aber nur so weit, dass Zeitstempel unter Bildern (textMuted, direkt auf
  // dem Hintergrund) darauf >= 4.5:1 lesbar bleiben - helle Tinten (Limette,
  // Orange, Tuerkis) werden dadurch kraeftig, dunkle (Violett) gedaempft.
  // Geprueft in __tests__/themes/themes.artwork.test.js.
  if (t.artwork && Array.isArray(t.artworkInks)) {
    d('artworkFills', () => t.artworkInks.map((c) => {
      for (let s = ARTWORK_INK_SHARE; s > 0.05; s -= 0.02) {
        const f = mix(t.chatBg, c, s);
        if (contrastRatio(t.textMuted, f) >= 4.5) return f;
      }
      return mix(t.chatBg, c, 0.05);
    }));
  }
  return t;
}

/** Hoechster Anteil der Tinte im Artwork-Muster (Rest: chatBg) - Nutzerwunsch: kraeftig, "was Besonderes". */
export const ARTWORK_INK_SHARE = 0.6;

// Statusleisten-Symbole passend zur KOPFLEISTE (die Statusleiste liegt ueber
// ihr, nicht ueber dem App-Hintergrund) - helle Symbole auf dunkler Leiste.
// Vorher: im Standard-Design dunkle Symbole auf Nachtblau, bei 'Gletscher'
// (helle App, dunkle Kopfleiste) ebenso unsichtbar.
export function statusBarFor(headerBg) {
  return contrastRatio('#FFFFFF', headerBg) >= contrastRatio('#000000', headerBg) ? 'light-content' : 'dark-content';
}

/** Akzentfarbe (und ggf. Einfaerben von Kopfleiste/Menue) auf das Standard-Design anwenden. */
export function applyAccent(base, accentColor, tint) {
  const a = accentColor;
  const t = {
    ...base,
    accent: a, onAccent: bestOn(a), accentSoft: withAlpha(a, 0.16),
    headerIcon: a, menuAccent: a, bubbleMine: a,
  };
  t.accentFg = ensureContrast(a, [t.bg, t.surface, t.surfaceAlt, flatten(t.accentSoft, t.surface), flatten(t.accentSoft, t.bg)], 4.5);
  t.codeText = ensureContrast(base.codeText, flatten(t.accentSoft, t.surface), 4.5);
  t.accentDeep = deepen(a);
  t.bubbleMineText = t.onAccent;
  t.bubbleMineMeta = ensureContrast(mix(t.onAccent, a, 0.15), a);
  t.bubbleMineSoft = softOn(t.onAccent);
  t.bubbleMineTrack = withAlpha(t.onAccent, 0.3);
  // Profilbild-Tokens neu aus Akzent/Kopfleiste ableiten (buildTheme)
  delete t.avatarBg; delete t.avatarText; delete t.headerAvatarBg; delete t.headerAvatarText;
  if (tint) {
    // Kopfleiste: Akzent in das Nachtblau gemischt (dunkle, ruhige Toenung),
    // so weit, dass helle Schrift sicher >= 4.5:1 hat.
    let share = 0.5;
    let hb = mix(t.bg, a, share);
    while (share > 0.05 && contrastRatio(t.text, hb) < 7) { share -= 0.05; hb = mix(t.bg, a, share); }
    const mb = mix(t.bg, a, Math.max(0.05, share - 0.1));
    Object.assign(t, {
      headerBg: hb, headerBorder: mix(hb, '#FFFFFF', 0.12),
      headerText: ensureContrast(t.text, hb), headerSub: ensureContrast(mix(t.text, hb, 0.25), hb),
      headerMuted: ensureContrast(mix(t.text, hb, 0.35), hb),
      headerIcon: ensureContrast(t.text, hb, 3), headerVerified: ensureContrast(base.codeText, hb, 3),
      headerOnline: ensureContrast(base.online, hb), headerSuccess: ensureContrast(base.success, hb),
      headerWarning: ensureContrast(base.warning, hb), headerDanger: ensureContrast(base.danger, hb, 3),
      menuBg: mb, menuBorder: mix(mb, '#FFFFFF', 0.12),
      menuText: ensureContrast(t.text, mb), menuIcon: ensureContrast(t.text, mb, 3),
      menuAccent: ensureContrast(a, mb, 3), menuDanger: ensureContrast(base.danger, mb),
    });
  }
  t.statusBar = statusBarFor(t.headerBg);
  return t;
}

/**
 * Auswahl -> vollstaendiges Thema (rein, ohne Seiteneffekte).
 * selection: { themeId, accentKey, tintChrome, chatBgPreset }
 */
export function resolveTheme(selection = {}, pro = false) {
  const themeId = canUseTheme(selection.themeId, pro) ? selection.themeId : DEFAULT_THEME_ID;
  let t;
  if (themeId === DEFAULT_THEME_ID) {
    const accentKey = accentByKey(selection.accentKey).key;
    const untouched = accentKey === DEFAULT_ACCENT_KEY && !selection.tintChrome;
    t = untouched
      ? { ...KLASSIK_LEGACY }
      : applyAccent(KLASSIK_AA, accentByKey(accentKey).color, !!selection.tintChrome);
    t = { ...KLASSIK_META, ...buildTheme(t), accentKey, tinted: !!selection.tintChrome, legacy: untouched };
  } else {
    const base = PRO_THEMES.find(x => x.id === themeId);
    t = { ...buildTheme(base), pro: true, accentKey: null, tinted: false, legacy: false };
    delete t.chatBgLight;
  }
  t.chatBgPreset = selection.chatBgPreset || null;   // Chat-Hintergrund-Voreinstellung (nur Chatverlauf)
  if (t.chatBgLight === undefined) t.chatBgLight = null;
  return t;
}

// ── Aktuelles Thema (Modul-Zustand, wie uiDemoStore in App.tsx) ─────────────

// appIcon: "App-Icon passend zum Design" (AppIcon.js) - Voreinstellung aus
let selection = { themeId: DEFAULT_THEME_ID, accentKey: DEFAULT_ACCENT_KEY, tintChrome: false, chatBgPreset: null, lockDesign: true, appIcon: false };
// Erst nach restoreThemeSelection (gespeicherte Wahl geladen) bzw. einer
// Nutzerwahl "steht" die Auswahl - vorher ist sie nur die Voreinstellung.
// AppIcon.js schaltet das Launcher-Icon erst danach um (sonst kurz Standard).
let selectionSettled = false;
let proUnlocked = false;
let current = resolveTheme(selection, proUnlocked);
let lockTheme = current;
const listeners = new Set();
const sheets = new Set();

function publish() {
  current = resolveTheme(selection, proUnlocked);
  lockTheme = selection.lockDesign === false
    ? resolveTheme({ ...selection, themeId: DEFAULT_THEME_ID }, false)
    : current;
  for (const fill of sheets) { try { fill(); } catch {} }
  for (const l of listeners) { try { l(current); } catch {} }
}

export function getTheme() { return current; }
/**
 * Sperrbildschirm: im gewaehlten Design (Nutzerwunsch 2026-10-19: einheitlich).
 * Abschaltbar (lockDesign: false) - dann immer das Standard-Design mit der
 * kostenlosen Akzentfarbe: ein Pro-Thema verraet sonst schon VOR dem
 * Entsperren, dass die Vollversion und damit womoeglich eine Notfall-PIN
 * eingerichtet ist (vgl. resetLicenseStateAfterWipe in LicenseManager.js).
 */
export function getLockTheme() { return lockTheme; }
export function getThemeSelection() { return { ...selection }; }
/** true, sobald die gespeicherte Auswahl geladen oder etwas gewaehlt wurde. */
export function isThemeSelectionSettled() { return selectionSettled; }
export function isThemeProUnlocked() { return proUnlocked; }
/** fn(theme) bei jeder Aenderung (nicht sofort). Rueckgabe: Abmelden. */
export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Lizenzzustand nachfuehren (App.tsx: subscribeLicense). */
export function setThemeProUnlocked(pro) {
  const next = pro === true;
  if (next === proUnlocked) return;
  proUnlocked = next;
  publish();
}

/**
 * Auswahl aendern. Ein Pro-Thema ohne Vollversion wird abgelehnt
 * ({ ok:false, reason:'pro' }), unbekannte Werte ebenso ('unknown').
 */
export function setThemeSelection(patch = {}, { pro = proUnlocked } = {}) {
  const next = { ...selection };
  if (patch.themeId !== undefined) {
    if (!THEME_IDS.includes(patch.themeId)) return { ok: false, reason: 'unknown' };
    if (!canUseTheme(patch.themeId, pro)) return { ok: false, reason: 'pro' };
    next.themeId = patch.themeId;
  }
  if (patch.accentKey !== undefined) {
    if (!FREE_ACCENTS.some(a => a.key === patch.accentKey)) return { ok: false, reason: 'unknown' };
    next.accentKey = patch.accentKey;
  }
  if (patch.tintChrome !== undefined) next.tintChrome = !!patch.tintChrome;
  if (patch.chatBgPreset !== undefined) next.chatBgPreset = patch.chatBgPreset || null;
  if (patch.lockDesign !== undefined) next.lockDesign = !!patch.lockDesign;
  if (patch.appIcon !== undefined) next.appIcon = !!patch.appIcon;
  selection = next;
  selectionSettled = true;
  if (pro === true && !proUnlocked) proUnlocked = true;
  publish();
  return { ok: true };
}

/**
 * Gespeicherte Auswahl uebernehmen (Start). Anders als setThemeSelection
 * wird ein Pro-Thema hier auch ohne Lizenz gemerkt - angezeigt wird es erst,
 * wenn setThemeProUnlocked(true) kommt (Lizenz geprueft und gueltig).
 */
export function restoreThemeSelection(stored) {
  selection = { ...selection, ...stored };
  if (!THEME_IDS.includes(selection.themeId)) selection.themeId = DEFAULT_THEME_ID;
  if (!FREE_ACCENTS.some(a => a.key === selection.accentKey)) selection.accentKey = DEFAULT_ACCENT_KEY;
  selection.tintChrome = !!selection.tintChrome;
  selection.lockDesign = selection.lockDesign !== false;
  selection.appIcon = selection.appIcon === true;
  selectionSettled = true;
  publish();
}

/**
 * Style-Objekt, das bei jedem Themenwechsel neu befuellt wird (Ersatz fuer
 * StyleSheet.create mit festen Farben). Dasselbe Objekt bleibt erhalten -
 * Komponenten lesen beim naechsten Rendern die neuen Werte.
 */
export function themedStyles(factory) {
  const obj = {};
  const fill = () => {
    const next = factory(current);
    for (const k of Object.keys(obj)) delete obj[k];
    Object.assign(obj, next);
  };
  fill();
  sheets.add(fill);
  return obj;
}

// ── Speichern / Laden ('settings') ─────────────────────────────────────────

/** Rohes 'settings'-JSON -> Auswahl. Fehlertolerant (kaputtes JSON -> Standard). */
export function selectionFromSettings(raw) {
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { s = null; } }
  if (!s || typeof s !== 'object') s = {};
  const themeId = THEME_IDS.includes(s.themeId) ? s.themeId : DEFAULT_THEME_ID;
  return {
    themeId,
    accentKey: accentKeyFromHex(s.accentColor),
    tintChrome: s.tintChrome === true,
    chatBgPreset: CHAT_BG_PRESETS.some(p => p.color === s.bgColor) ? s.bgColor : null,
    lockDesign: s.lockDesign !== false,
    appIcon: s.appIcon === true,
  };
}

/** Auswahl -> Felder fuer 'settings' (accentColor bleibt Hex wie bisher). */
export function settingsFromSelection(sel) {
  return {
    themeId: sel.themeId || DEFAULT_THEME_ID,
    accentColor: accentByKey(sel.accentKey).color,
    tintChrome: !!sel.tintChrome,
    lockDesign: sel.lockDesign !== false,
    appIcon: sel.appIcon === true,
  };
}

/**
 * Chat-Hintergrund-Voreinstellungen (bisheriges Blatt "Chat-Hintergrund").
 * Frueher setzten sie den Hintergrund der GANZEN App (P.bg) - mit heller
 * Schrift darauf unlesbar. Jetzt gelten sie, wie beschriftet, nur fuer den
 * Chatverlauf; der App-Hintergrund gehoert dem Thema.
 */
export const CHAT_BG_PRESETS = [
  { key: 'warm',  color: '#F7F5F2', label: 'Warm'   },
  { key: 'white', color: '#FFFFFF', label: 'Weiß'   },
  { key: 'sage',  color: '#EDF4EC', label: 'Salbei' },
  { key: 'sand',  color: '#F5EFE6', label: 'Sand'   },
  { key: 'dark',  color: '#1C1C1E', label: 'Dunkel' },
];

let saveChain = Promise.resolve();
/**
 * 'settings' lesen, `patch` hineinmischen, schreiben - nacheinander, damit
 * schnelle Aenderungen (Akzent, dann Einfaerben) sich nicht ueberschreiben und
 * unbekannte/aeltere Schluessel erhalten bleiben. storage: getItem/setItem.
 */
export function saveSettings(storage, patch) {
  const run = saveChain.then(async () => {
    let prev = {};
    try {
      const raw = await storage.getItem('settings');
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object') prev = parsed;
    } catch {}
    const next = { ...prev, ...patch };
    await storage.setItem('settings', JSON.stringify(next));
    return next;
  });
  saveChain = run.catch(() => {});
  return run;
}

/**
 * Auswahl aus den Einstellungen uebernehmen und speichern. Fuer ein Pro-Thema
 * wird die Lizenz hier frisch geprueft (wie beim Einrichten der Duress-PIN),
 * nicht nur aus dem Anzeige-Zustand. Rueckgabe wie setThemeSelection.
 * deps: { storage, isProVerified }
 */
export async function chooseDesign(patch, { storage, isProVerified }) {
  let pro = proUnlocked;
  if (patch && patch.themeId !== undefined && isProTheme(patch.themeId)) {
    try { pro = (await isProVerified()) === true; } catch { pro = false; }
    if (!pro) return { ok: false, reason: 'pro' };
  }
  const r = setThemeSelection(patch, { pro });
  if (r.ok && storage) {
    try { await saveSettings(storage, settingsFromSelection(selection)); } catch {}
  }
  return r;
}

/** Nur fuer Tests: Modul-Zustand zuruecksetzen. */
export function _resetThemesForTests() {
  selection = { themeId: DEFAULT_THEME_ID, accentKey: DEFAULT_ACCENT_KEY, tintChrome: false, chatBgPreset: null, appIcon: false };
  selectionSettled = false;
  proUnlocked = false;
  // Abonnenten bleiben (App.tsx gleicht P/AC auf Modulebene ab).
  saveChain = Promise.resolve();
  publish();
}
