// Anrufbildschirm, Siegel und Statusleisten-Streifen im gewaehlten Design
// (Nutzerwunsch 2026-10-19: Pro-Nutzer zahlen fuer die Designs - auch der
// Anruf und Siegel muessen dazu passen).
const fs = require('fs');
const path = require('path');
const T = require('../../Themes');
const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

const block = (src, start, end) => { const i = src.indexOf(start); return src.slice(i, src.indexOf(end, i + 1)); };

test('statisch: Anrufbildschirm ohne feste Farben (ausser Weiss ueber dem Video)', () => {
  const call = block(read('App.tsx'), 'function CallScreen(', '\nfunction CollapsibleNotice');
  expect(call).not.toMatch(/#0A2340|#C0392B|#8FD9F0|#F7F5F2|color="white"/);
  expect(call).toMatch(/backgroundColor:P\.surfaceAlt/);
  expect(call).toMatch(/backgroundColor:P\.dangerFill/);
  expect(call).toMatch(/const onSuccess = bestOn\(P\.success\)/);
  expect(call.match(/'#FFFFFF'/g).length).toBe(3);                // nur overVideo-Zweige
  expect(call.match(/overVideo \? '#FFFFFF'/g).length).toBe(3);
});

test('Anrufbildschirm: Annehmen-Symbol auf Erfolgsfarbe in jedem Design lesbar', () => {
  const sels = [{}, ...T.FREE_ACCENTS.map((a) => ({ accentKey: a.key })), ...T.PRO_THEMES.map((p) => ({ themeId: p.id }))];
  for (const s of sels) {
    const t = T.resolveTheme(s, true);
    expect(T.contrastRatio(T.bestOn(t.success), t.success)).toBeGreaterThanOrEqual(3);
  }
});

test('statisch: Statusleisten-Streifen folgt dem, was darunter beginnt', () => {
  const app = read('App.tsx');
  expect(app).toMatch(/const topStripColor = screen === 'lock' \|\| screen === 'setup' \? getLockTheme\(\)\.bg\s*: screen === 'call' \? P\.surfaceAlt : P\.headerBg;/);
  expect(app).toMatch(/<StatusBar barStyle=\{statusBarFor\(topStripColor\)\} backgroundColor=\{topStripColor\} \/>/);
  // Gletscher: helle App, dunkle Kopfleiste -> helle Symbole auf dunklem Streifen
  const g = T.resolveTheme({ themeId: 'gletscher' }, true);
  expect(T.statusBarFor(g.headerBg)).toBe('light-content');
  expect(T.statusBarFor(g.surfaceAlt)).toBe('dark-content');
});

test('statisch: Siegel nutzt die Design-Farben (keine feste Palette mehr)', () => {
  const s = read('SiegelScreen.tsx');
  expect(s).toMatch(/subscribeTheme\(syncColors\)/);
  expect(s).not.toMatch(/bg: '#04182F'/);
  expect(s).not.toMatch(/color="white"/);
  expect(s).toMatch(/backgroundColor: C\.headerBg/);
});
