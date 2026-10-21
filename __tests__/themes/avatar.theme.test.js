// Profilbild-Platzhalter (Initialen / Gruppen-Symbol) folgen dem Design.
// Vorher: fest pro Kontakt gespeichert (Nachtblau '#0A2340' / Tuerkis
// '#0A7EA4', 3.4:1) - in hellen Designs ein dunkler Fleck, nirgends lesbar.
const fs = require('fs');
const path = require('path');
const T = require('../../Themes');

const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

const allSelections = () => {
  const out = [['Standard', {}]];
  for (const a of T.FREE_ACCENTS) {
    out.push([`Standard/${a.key}`, { accentKey: a.key }]);
    out.push([`Standard/${a.key}/eingefaerbt`, { accentKey: a.key, tintChrome: true }]);
  }
  for (const p of T.PRO_THEMES) out.push([p.id, { themeId: p.id }]);
  return out;
};

test.each(allSelections())('%s: Initialen im Profilbild lesbar (>= 4.5:1), auf Flaeche und in der Kopfleiste', (_, sel) => {
  const t = T.resolveTheme(sel, true);
  for (const k of ['avatarBg', 'avatarText', 'headerAvatarBg', 'headerAvatarText']) expect(typeof t[k]).toBe('string');
  expect(T.contrastRatio(t.avatarText, t.avatarBg)).toBeGreaterThanOrEqual(4.5);
  expect(T.contrastRatio(t.headerAvatarText, t.headerAvatarBg)).toBeGreaterThanOrEqual(4.5);
});

test('helle Designs bekommen helle Platzhalter (kein Nachtblau mehr), dunkle Designs dunkle', () => {
  for (const p of T.PRO_THEMES) {
    const t = T.resolveTheme({ themeId: p.id }, true);
    if (p.dark) expect(T.luminance(t.avatarBg)).toBeLessThan(0.18);
    else expect(T.luminance(t.avatarBg)).toBeGreaterThan(0.4);
    expect(t.avatarBg).not.toBe('#0A2340');
  }
});

test('Akzent wechseln aendert die Platzhalter-Farbe mit (Standard-Design)', () => {
  const a = T.resolveTheme({ accentKey: 'teal' }, false);
  const b = T.resolveTheme({ accentKey: 'rose' }, false);
  expect(a.avatarBg).not.toBe(b.avatarBg);
  expect(a.avatarText).not.toBe(b.avatarText);
});

test('statisch: Avatar nutzt Design-Farben statt gespeicherter Kontaktfarben, Initialen aus dem aktuellen Namen', () => {
  const app = read('App.tsx');
  const i = app.indexOf('function Avatar(');
  const block = app.slice(i, app.indexOf('\nfunction AppInner', i));
  expect(block).toMatch(/P\.avatarBg/);
  expect(block).toMatch(/P\.headerAvatarText/);
  expect(block).not.toMatch(/c\.color|c\.tc\b/);
  expect(block).toMatch(/initialsOf\(c\.name\)/);
  // Kopfleisten (Chat, Startseite) nutzen die Kopfleisten-Variante
  expect(app).toMatch(/<Avatar c=\{chat\} size=\{34\} onHeader \/>/);
  expect(app).toMatch(/backgroundColor:P\.headerAvatarBg,\s*alignItems:'center'/);
  expect(app).toMatch(/username \? initialsOf\(username\) : 'M'/);
  const groups = read('GroupScreens.tsx');
  expect(groups).not.toMatch(/contact\?\.color|contact\?\.tc/);
  expect(groups).not.toMatch(/color="white"/);
  expect(read('GroupChatScreen.tsx')).toMatch(/<GroupAvatar group=\{group\} size=\{34\} accent=\{accent\} palette=\{palette\} onHeader \/>/);
});

test('initialsOf: zwei Woerter -> zwei Buchstaben, Umlaute/Emoji heil, leer -> ?', () => {
  // initialsOf ist in App.tsx exportiert; ohne die ganze App zu laden pruefen
  const src = read('App.tsx');
  const m = src.match(/export function initialsOf\(name\) \{[\s\S]*?\n\}/);
  expect(m).toBeTruthy();
  // eslint-disable-next-line no-new-func
  const initialsOf = new Function(m[0].replace('export ', '') + '; return initialsOf;')();
  expect(initialsOf('Kev Meyer')).toBe('KM');
  expect(initialsOf('dave')).toBe('D');
  expect(initialsOf('  Ömer  Ünal Test ')).toBe('ÖÜ');
  expect(initialsOf('😀 Anna')).toBe('😀A');
  expect(initialsOf('')).toBe('?');
  expect(initialsOf(null)).toBe('?');
});
