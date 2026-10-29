// Filter-Reiter ueber der Chatliste ("Alle / Chats / Gruppen"): standen bis
// 1.2.0 fest auf Deutsch im Quelltext und blieben auch bei englischer (oder
// jeder anderen) App-Sprache deutsch (Fund 28.10.2026 beim Aufnehmen der
// englischen Werbevideos). i18n.static.test.js fand das nicht, weil die
// Woerter als Daten in einem Array standen statt direkt im JSX.
//  1. Im Quelltext kommen die Reiter-Beschriftungen nur noch ueber t().
//  2. Alle drei Schluessel gibt es in jeder Sprache, nicht leer.
//  3. Ueber t(): Deutsch bleibt wie bisher, Englisch u.a. sind uebersetzt.
jest.mock('react-native-restart', () => ({ __esModule: true, default: { restart: jest.fn() } }));
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const I = require('../../i18n');
const { t } = I;

const ROOT = path.join(__dirname, '..', '..');
const KEYS = ['home.tabAll', 'home.tabChats', 'common.groups'];

afterAll(() => { I._resetI18nForTests(); });

// Alle [schluessel, beschriftung, ...]-Tupel der Filterleiste in App.tsx.
function filterTuples() {
  const src = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8').replace(/^﻿/, '');
  const ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const found = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ArrayExpression' && node.elements.length >= 2) {
      const [k, label] = node.elements;
      if (k && k.type === 'StringLiteral' && ['all', 'chats', 'groups'].includes(k.value)) found.push({ key: k.value, label });
    }
    for (const f of Object.keys(node)) {
      if (f === 'loc' || f === 'start' || f === 'end' || f === 'leadingComments' || f === 'trailingComments') continue;
      const v = node[f];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  return found;
}

describe('Filterleiste der Chatliste', () => {
  test('Beschriftungen kommen ueber t() mit den erwarteten Schluesseln', () => {
    const tuples = filterTuples();
    expect(tuples.map(x => x.key).sort()).toEqual(['all', 'chats', 'groups']);
    const erwartet = { all: 'home.tabAll', chats: 'home.tabChats', groups: 'common.groups' };
    for (const { key, label } of tuples) {
      expect(label.type).toBe('CallExpression');
      expect(label.callee.type === 'Identifier' && label.callee.name).toBe('t');
      expect(label.arguments[0].type).toBe('StringLiteral');
      expect(label.arguments[0].value).toBe(erwartet[key]);
    }
  });

  test('alle drei Schluessel in jeder Sprache vorhanden und nicht leer', () => {
    for (const code of I.LANGUAGE_CODES) {
      const table = I.getTable(code);
      for (const k of KEYS) {
        expect(typeof table[k]).toBe('string');
        expect(table[k].trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('Deutsch unveraendert, andere Sprachen uebersetzt', () => {
    I.setLanguage('de');
    expect([t('home.tabAll'), t('home.tabChats'), t('common.groups')]).toEqual(['Alle', 'Chats', 'Gruppen']);
    I.setLanguage('en');
    expect([t('home.tabAll'), t('home.tabChats'), t('common.groups')]).toEqual(['All', 'Chats', 'Groups']);
    I.setLanguage('ru');
    expect([t('home.tabAll'), t('home.tabChats'), t('common.groups')]).toEqual(['Все', 'Чаты', 'Группы']);
    I.setLanguage('ar');
    expect(t('home.tabAll')).toBe('الكل');
  });
});
