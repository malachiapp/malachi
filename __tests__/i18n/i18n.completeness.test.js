// Vollstaendigkeit der Uebersetzungen: jede Sprache aus LANGUAGES hat eine
// Datei unter locales/, jeden Schluessel aus der Quelle (locales/de.js) und
// keinen zusaetzlichen, dieselben Platzhalter, die noetigen Pluralformen und
// im Dateikopf den Hinweis auf die maschinelle Uebersetzung.
const fs = require('fs');
const path = require('path');
const I = require('../../i18n');

const ROOT = path.join(__dirname, '..', '..');
const de = I.getTable('de');
const others = I.LANGUAGE_CODES.filter(c => c !== 'de');

// Pluralformen, die eine Sprache mindestens braucht (CLDR, ganze Zahlen) -
// passend zu pluralCategory() in i18n.js.
const REQUIRED_FORMS = {
  ru: ['one', 'few', 'many'], uk: ['one', 'few', 'many'], pl: ['one', 'few', 'many'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  'zh-Hans': ['other'], ja: ['other'], ko: ['other'], id: ['other'],
};
const requiredForms = (c) => REQUIRED_FORMS[c] || ['one', 'other'];

const placeholders = (v) => {
  const texts = typeof v === 'string' ? [v] : Object.values(v);
  const set = new Set();
  for (const s of texts) for (const m of String(s).match(/\{\w+\}/g) || []) set.add(m);
  return set;
};
// {count} darf in Pluralformen fehlen ("eine Minute") - es steckt in der Form selbst.
const withoutCount = (set) => [...set].filter(p => p !== '{count}').sort();

test('Quelle (de) ist geladen und gross genug', () => {
  expect(de).toBeTruthy();
  expect(Object.keys(de).length).toBeGreaterThan(700);
});

test('jede Sprache hat eine eigene Datei, die Liste und LOADERS passen zusammen', () => {
  for (const c of I.LANGUAGE_CODES) {
    expect(fs.existsSync(path.join(ROOT, 'locales', c + '.js'))).toBe(true);
    expect(I.getTable(c)).toBeTruthy();
  }
  const files = fs.readdirSync(path.join(ROOT, 'locales')).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
  expect(files.sort()).toEqual([...I.LANGUAGE_CODES].sort());
});

describe.each(others)('%s', (code) => {
  const tbl = I.getTable(code);

  test('alle Schluessel vorhanden, keine zusaetzlichen', () => {
    const missing = Object.keys(de).filter(k => !(k in tbl));
    const extra = Object.keys(tbl).filter(k => !(k in de));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('keine leeren Texte, nur Text oder Pluralobjekt', () => {
    const bad = [];
    for (const [k, v] of Object.entries(tbl)) {
      if (typeof v === 'string') { if (!v.trim()) bad.push(k); continue; }
      if (!v || typeof v !== 'object' || !Object.values(v).every(s => typeof s === 'string' && s.trim())) bad.push(k);
    }
    expect(bad).toEqual([]);
  });

  test('gleiche Platzhalter wie im deutschen Original', () => {
    const bad = [];
    for (const k of Object.keys(de)) {
      if (!(k in tbl)) continue;
      const a = withoutCount(placeholders(de[k])).join(',');
      const b = withoutCount(placeholders(tbl[k])).join(',');
      if (a !== b) bad.push(`${k}: ${a} != ${b}`);
    }
    expect(bad).toEqual([]);
  });

  test('Pluralobjekte haben alle Formen der Sprache', () => {
    const need = requiredForms(code);
    const bad = Object.entries(tbl)
      .filter(([, v]) => v && typeof v === 'object')
      .filter(([, v]) => !need.every(f => typeof v[f] === 'string' || (f === 'other' && typeof v.many === 'string')))
      .map(([k, v]) => `${k}: ${Object.keys(v).join('/')}`);
    expect(bad).toEqual([]);
  });

  test('deutsche Pluralobjekte bleiben auch hier zaehlbar', () => {
    // Jede Pluralform der Quelle muss in der Uebersetzung {count} oder eine
    // Pluralform haben - sonst stuende z.B. "{count} Minuten" fest im Text.
    const bad = Object.keys(de)
      .filter(k => typeof de[k] === 'object')
      .filter(k => typeof tbl[k] === 'string' && !tbl[k].includes('{count}'));
    expect(bad).toEqual([]);
  });

  test('Dateikopf nennt die maschinelle Uebersetzung', () => {
    const head = fs.readFileSync(path.join(ROOT, 'locales', code + '.js'), 'utf8').split('export default')[0];
    expect(head).toMatch(/Machine translation/);
    expect(head).toMatch(/no warranty/);
  });

  test('Rechtstext: Hinweis auf den verbindlichen deutschen Wortlaut vorhanden', () => {
    expect(tbl['pro.consentText']).toBeTruthy();
    expect(tbl['pro.consentBinding']).toBeTruthy();
    expect(tbl['settings.language.disclaimer']).toBeTruthy();
  });
});

test('Quelle: Pluralobjekte haben one und other', () => {
  const bad = Object.entries(de)
    .filter(([, v]) => v && typeof v === 'object')
    .filter(([, v]) => typeof v.one !== 'string' || typeof v.other !== 'string')
    .map(([k]) => k);
  expect(bad).toEqual([]);
});
