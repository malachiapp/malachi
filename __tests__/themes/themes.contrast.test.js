// Kontrasttest der Design-Themen (Themes.js): rechnet fuer JEDES Thema und
// JEDE kostenlose Akzentfarbe (mit und ohne "Kopfleiste und Menü einfärben")
// die WCAG-2.1-Kontrastverhaeltnisse aller tatsaechlich benutzten
// Schrift-/Symbol-Kombinationen (Themes.CONTRAST_RULES) nach - unabhaengig
// von der Farbrechnung in Themes.js - und faellt bei Unterschreitung durch:
//   normale Schrift >= 4.5:1, Symbole/grosse Schrift/Raender >= 3:1.
// Einzige Ausnahme: das UNVERAENDERTE Standard-Design (bisherige Farben), dort
// muessen die Unterschreitungen exakt der dokumentierten Liste entsprechen.
const T = require('../../Themes');

// ── Unabhaengige WCAG-Rechnung ────────────────────────────────────────────
function rgba(c) {
  const s = { white: '#FFFFFF', black: '#000000' }[c] || c;
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1].split('').map(x => parseInt(x + x, 16)), 1];
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  throw new Error('Farbe? ' + c);
}
function over(fg, bg) {
  const [r, g, b, a] = rgba(fg);
  const [R, G, B] = Array.isArray(bg) ? bg : rgba(bg);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
}
function lum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg, bgRgb) {
  const a = lum(over(fg, bgRgb)), b = lum(bgRgb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function bgOf(theme, expr) {
  const [top, under] = expr.split('@');
  return under ? over(theme[top], over(theme[under], [0, 0, 0])) : over(theme[top], [0, 0, 0]);
}
const fgOf = (theme, fg) => (fg.startsWith('#') ? fg : theme[fg]);
function failures(theme) {
  const out = [];
  for (const r of T.CONTRAST_RULES) {
    for (const on of r.on) {
      const v = ratio(fgOf(theme, r.fg), bgOf(theme, on));
      if (v < r.min) out.push({ key: r.fg + '@' + on, ratio: +v.toFixed(2), min: r.min });
    }
  }
  return out;
}

// Alle Kombinationen, die ein Nutzer einstellen kann
const combos = [];
for (const a of T.FREE_ACCENTS) {
  for (const tint of [false, true]) {
    combos.push({ label: `Standard/${a.label}${tint ? ' + eingefärbt' : ''}`, legacy: a.key === 'cyan' && !tint,
      theme: T.resolveTheme({ themeId: 'klassik', accentKey: a.key, tintChrome: tint }, false) });
  }
}
for (const p of T.PRO_THEMES) {
  combos.push({ label: p.name, legacy: false, theme: T.resolveTheme({ themeId: p.id }, true) });
}

test('Grundrechnung stimmt (Schwarz/Weiss 21:1, #777 auf Weiss ~4.48:1) und deckt sich mit Themes.contrastRatio', () => {
  expect(ratio('#000000', rgba('#FFFFFF'))).toBeCloseTo(21, 5);
  expect(ratio('#777777', rgba('#FFFFFF'))).toBeCloseTo(4.48, 2);
  expect(T.contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  for (const { theme } of combos) {
    for (const row of T.contrastReport(theme)) {
      // Themes.js rundet halbtransparente Farben nach dem Auflegen auf 8 Bit je
      // Kanal (wie das Display) - daher nur auf etwa 0.05 genau gleich.
      expect(row.ratio).toBeCloseTo(ratio(fgOf(theme, row.fg), bgOf(theme, row.on)), 1);
    }
  }
});

describe.each(combos.filter(c => !c.legacy).map(c => [c.label, c]))('%s', (_label, c) => {
  test('jede benutzte Schrift-/Symbolfarbe erreicht WCAG AA auf ihrem Hintergrund', () => {
    expect(failures(c.theme)).toEqual([]);
  });
  test('vollstaendiger Token-Satz, alle Farben lesbar', () => {
    for (const k of T.TOKEN_KEYS) {
      expect(c.theme[k]).toBeDefined();
      if (k !== 'statusBar') expect(() => rgba(c.theme[k])).not.toThrow();
    }
    expect(['light-content', 'dark-content']).toContain(c.theme.statusBar);
  });
});

test('unveraendertes Standard-Design: exakt die bisherigen Farben (nichts aendert sich ohne Themenwahl)', () => {
  const t = T.resolveTheme({}, false);
  expect(t.id).toBe('klassik');
  expect(t.legacy).toBe(true);
  // bisherige Palette P / AC aus App.tsx
  expect({ bg: t.bg, surface: t.surface, surfaceAlt: t.surfaceAlt, border: t.border, text: t.text, textSub: t.textSub,
    textMuted: t.textMuted, accent: t.accent, online: t.online, accentSoft: t.accentSoft }).toEqual({
    bg: '#04182F', surface: '#0D2A4A', surfaceAlt: '#0A2340', border: '#1B3A5C', text: '#F0F6FA', textSub: '#9FB8CC',
    textMuted: '#6E93AE', accent: '#0A7EA4', online: '#0A7EA4', accentSoft: 'rgba(10,126,164,0.16)' });
  // Kopfleiste, Menue, Blasen wie bisher
  expect([t.headerBg, t.headerText, t.headerIcon, t.menuBg, t.menuText, t.bubbleMine, t.bubbleMineText, t.bubbleTheirs, t.chatBg])
    .toEqual(['#0D2A4A', '#F0F6FA', '#0A7EA4', '#0D2A4A', '#F0F6FA', '#0A7EA4', '#FFFFFF', '#0D2A4A', '#061F3A']);
});

test('unveraendertes Standard-Design: Unterschreitungen exakt wie dokumentiert (LEGACY_EXCEPTIONS)', () => {
  const legacy = combos.find(c => c.legacy).theme;
  const keys = failures(legacy).map(f => f.key).sort();
  expect(keys).toEqual([...T.LEGACY_EXCEPTIONS].sort());
  // ... und keine davon ist schlimmer als 2:1 (Orientierung fuer THEMES.md)
  for (const f of failures(legacy)) expect(f.ratio).toBeGreaterThanOrEqual(2);
});

test('21 Design-Themen der Vollversion: eigene deutsche Namen, viele helle, verschiedene Paletten', () => {
  // Wachposten: genau 21 (7 urspruengliche + 7 hellere + 7 Business, Okt. 2026) -
  // ein neues Thema muss hier bewusst nachgezogen werden.
  expect(T.PRO_THEMES).toHaveLength(21);
  const N = T.PRO_THEMES.length;
  const names = T.PRO_THEMES.map(p => p.name);
  expect(new Set(names).size).toBe(N);
  expect(new Set(T.PRO_THEMES.map(p => p.id)).size).toBe(N);
  expect(names).not.toContain('Standard');
  const light = combos.filter(c => !c.legacy && c.theme.pro && lum(rgba(c.theme.bg)) > 0.5);
  expect(light.length).toBeGreaterThanOrEqual(10);
  // Statusleiste folgt der KOPFLEISTE (Gletscher: helle App, dunkle Leiste -> helle Symbole).
  for (const c of light) expect(c.theme.statusBar).toBe(require('../../Themes').statusBarFor(c.theme.headerBg));
  // verschiedene Paletten: Hintergruende und Akzente paarweise klar unterscheidbar
  const hue = (hex) => {
    const [r, g, b] = rgba(hex).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const accents = T.PRO_THEMES.map(p => p.accent);
  expect(new Set(accents).size).toBe(N);
  const bgs = T.PRO_THEMES.map(p => p.bg);
  expect(new Set(bgs).size).toBe(N);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dh = Math.abs(hue(accents[i]) - hue(accents[j]));
      const dist = Math.min(dh, 360 - dh);
      const sameBg = Math.abs(lum(rgba(bgs[i])) - lum(rgba(bgs[j]))) < 0.002 && Math.abs(hue(bgs[i]) - hue(bgs[j])) < 15;
      expect(dist > 12 || !sameBg).toBe(true);
    }
  }
});

test('kostenlose Akzentfarben: 10 bis 12, eindeutig, Schrift auf dem Akzent >= 4.5:1, als Symbol >= 3:1', () => {
  expect(T.FREE_ACCENTS.length).toBeGreaterThanOrEqual(10);
  expect(T.FREE_ACCENTS.length).toBeLessThanOrEqual(12);
  expect(new Set(T.FREE_ACCENTS.map(a => a.key)).size).toBe(T.FREE_ACCENTS.length);
  expect(new Set(T.FREE_ACCENTS.map(a => a.color.toUpperCase())).size).toBe(T.FREE_ACCENTS.length);
  const base = T.KLASSIK_AA;
  for (const a of T.FREE_ACCENTS) {
    const on = T.bestOn(a.color);
    expect(ratio(on, rgba(a.color))).toBeGreaterThanOrEqual(4.5);
    for (const bg of [base.bg, base.surface, base.surfaceAlt]) expect(ratio(a.color, rgba(bg))).toBeGreaterThanOrEqual(3);
  }
});

test('Einfaerben: Kopfleiste und Menue tragen den (abgedunkelten) Akzent und bleiben gut lesbar', () => {
  for (const a of T.FREE_ACCENTS) {
    const plain = T.resolveTheme({ themeId: 'klassik', accentKey: a.key, tintChrome: false });
    const tinted = T.resolveTheme({ themeId: 'klassik', accentKey: a.key, tintChrome: true });
    expect(tinted.headerBg).not.toBe(plain.headerBg);
    expect(tinted.menuBg).not.toBe(plain.menuBg);
    // abgedunkelt: dunkler als der Akzent selbst, Schrift darauf >= 7:1 (AAA) bzw. mind. 4.5:1
    expect(lum(rgba(tinted.headerBg))).toBeLessThan(lum(rgba(a.color)));
    expect(ratio(tinted.headerText, rgba(tinted.headerBg))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tinted.menuText, rgba(tinted.menuBg))).toBeGreaterThanOrEqual(4.5);
  }
});

describe('Statusleiste passt zur Kopfleiste (Live-Test 2026-10-19)', () => {
  const T = require('../../Themes');
  test('helle Symbole auf dunkler Kopfleiste, dunkle auf heller - fuer jedes Thema und jede Akzent-Toenung', () => {
    expect(T.statusBarFor('#0D2A4A')).toBe('light-content');
    expect(T.statusBarFor('#FFFDF8')).toBe('dark-content');
    expect(T.statusBarFor('#1E3A5F')).toBe('light-content');      // Gletscher: helle App, dunkle Kopfleiste
    expect(T.KLASSIK_LEGACY.statusBar).toBe('light-content');      // vorher dunkle Symbole auf Nachtblau
  });
});
