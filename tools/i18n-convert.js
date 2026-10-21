#!/usr/bin/env node
/* eslint-env node */
// Hilfswerkzeug (Entwicklung, nicht in der App): sichtbare deutsche Texte einer
// Oberflaechen-Datei auf t('schluessel') umstellen.
//
//   node tools/i18n-convert.js <datei> --prefix app [--t tr] [--keys neu.json] [--dry]
//
// - Gleicher deutscher Text wie in locales/de.js -> vorhandener Schluessel.
// - Sonst neuer Schluessel <prefix>.<kurzform>; Liste in --keys (JSON
//   {schluessel: deutscher Text}) - Uebersetzungen folgen separat.
// - Sichtbar ist: JSX-Text, Text-Props (placeholder, title, ...), Alert-Texte,
//   Werte von text/title/label/desc/message/a11y/summary - jeweils auch in
//   Bedingungen (a ? 'x' : 'y'). Sonst nur deutsch aussehende Literale.
// - Template-Strings und Verkettungen werden zu t('k', { name: ausdruck }),
//   gemischter JSX-Text ("Nichts gefunden für „{search}“") zu einem Schluessel.
// - Modulebene (beim Laden ausgewertet, wechselt die Sprache nicht mit) und
//   bedingte Textteile werden nur gemeldet.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const args = process.argv.slice(2);
const file = args[0];
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PREFIX = opt('--prefix', 'ui');
const TNAME = opt('--t', 't');
const KEYS_OUT = opt('--keys', null);
const DRY = args.includes('--dry');
const ROOT = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
const ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] });

// Vorhandene Texte -> Schluessel (nur einfache Zeichenketten).
const deSrc = fs.readFileSync(path.join(ROOT, 'locales/de.js'), 'utf8');
const existing = new Map();
const allKeys = new Set();
for (const m of deSrc.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',\s*$/gm)) {
  const text = m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  if (!existing.has(text)) existing.set(text, m[1]);
}
for (const m of deSrc.matchAll(/^\s*'([^']+)':/gm)) allKeys.add(m[1]);
const created = new Map();   // key -> text
const createdByText = new Map();
if (KEYS_OUT && fs.existsSync(KEYS_OUT)) {
  const prev = JSON.parse(fs.readFileSync(KEYS_OUT, 'utf8'));
  for (const [k, v] of Object.entries(prev)) { created.set(k, v); createdByText.set(v, k); allKeys.add(k); }
}

const LETTERS = /[A-Za-zÄÖÜäöüß]{2,}/;
const GERMAN = /[ÄÖÜäöüß]|\b(der|die|das|und|nicht|ist|mit|für|fuer|ein|eine|einen|kein|keine|noch|bitte|wird|werden|wurde|du|dein|deine|dich|dir|auf|zu|von|vom|zum|zur|bei|nach|oder|aber|jetzt|hier|alle|Datei|Gruppe|Kontakt|Nachricht|Nachrichten|Fehler|Abbrechen|Speichern|Verbinden|Einstellungen)\b/;
const UI_PROPS = new Set(['placeholder', 'title', 'label', 'accessibilityLabel', 'accessibilityHint', 'subtitle', 'hint', 'message', 'summary', 'teaser']);
const UI_KEYS = new Set(['text', 'title', 'label', 'desc', 'message', 'a11y', 'summary', 'hint', 'notice', 'warning', 'sub']);
const ALLOWED = new Set(['Malachi ©', 'WebRTC · DTLS-SRTP', 'TOR', 'PRO', 'XMR', 'BTC', 'Malachi', 'ML1.…', 'Tor', 'Siegel', 'Secret Chat',
  'webtunnel [2001:db8::1]:443 … url=https://…', 'Datei', 'kein-geraeteschluessel', 'keine-lizenz', 'P2P', 'STUN',
  'Malachi-Messenger/1.0 (selbst-gehosteter Messenger, kein Tracking)', 'Malachi User', 'Monero', 'Bitcoin', 'Snowflake', 'obfs4', 'meek']);

function slug(text) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
  const words = text.replace(/[äöüÄÖÜß]/g, c => map[c]).replace(/\{[^}]*\}/g, ' ').match(/[A-Za-z0-9]+/g) || ['text'];
  return words.slice(0, 5).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}
function keyFor(text) {
  if (existing.has(text)) return existing.get(text);
  if (createdByText.has(text)) return createdByText.get(text);
  const base = PREFIX + '.' + slug(text);
  let k = base;
  let n = 2;
  while (allKeys.has(k)) k = base + n++;
  allKeys.add(k);
  created.set(k, text);
  createdByText.set(text, k);
  return k;
}

const edits = [];
const manual = [];
const line = (n) => n.loc.start.line;
const code = (n) => src.slice(n.start, n.end);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
const visible = (s) => LETTERS.test(s) && !ALLOWED.has(s.trim());
const isT = (c) => c && c.type === 'CallExpression' && c.callee.type === 'Identifier' && (c.callee.name === TNAME || c.callee.name === 't' || c.callee.name === 'tr');

function eachChild(node, fn) {
  for (const k of Object.keys(node)) {
    if (['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'extra', 'innerComments'].includes(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => { if (x && typeof x.type === 'string') fn(x, k); });
    else if (v && typeof v.type === 'string') fn(v, k);
  }
}

// ── Vorlauf: Eltern, Funktions-Kontext, sichtbare Stellen ──────────────────
const parentOf = new Map();
const inFn = new Set();          // Knoten innerhalb einer Funktion
const skip = new Set();          // in console.*, Error, t(...)
(function pre(node, parent, fn, sk) {
  parentOf.set(node, parent);
  if (/Function|ArrowFunction|ClassMethod|ObjectMethod/.test(node.type)) fn = true;
  if (node.type === 'CallExpression') {
    const c = node.callee;
    if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'console') sk = true;
    if (isT(node)) sk = true;
  }
  if ((node.type === 'NewExpression' || node.type === 'CallExpression') && node.callee.type === 'Identifier' && /Error$/.test(node.callee.name)) sk = true;
  if (node.type === 'ImportDeclaration' || node.type === 'TSTypeAnnotation') sk = true;
  if (fn) inFn.add(node);
  if (sk) skip.add(node);
  eachChild(node, (c) => pre(c, node, fn, sk));
})(ast, null, false, false);

const ui = new Set();            // sichtbare Literal-/Template-Knoten
function markText(e) {
  if (!e) return;
  if (e.type === 'StringLiteral' || e.type === 'TemplateLiteral') ui.add(e);
  else if (e.type === 'ConditionalExpression') { markText(e.consequent); markText(e.alternate); }
  else if (e.type === 'LogicalExpression') { markText(e.left); markText(e.right); }
  else if (e.type === 'BinaryExpression' && e.operator === '+') { markText(e.left); markText(e.right); }
}
(function mark(node) {
  if (node.type === 'JSXAttribute' && node.name && UI_PROPS.has(node.name.name) && node.value) {
    markText(node.value.type === 'JSXExpressionContainer' ? node.value.expression : node.value);
  }
  if (node.type === 'JSXExpressionContainer' && parentOf.get(node) && /JSXElement|JSXFragment/.test(parentOf.get(node).type)) markText(node.expression);
  if (node.type === 'ObjectProperty' && !node.computed && node.key && UI_KEYS.has(node.key.name || node.key.value)) markText(node.value);
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 'Alert' && node.callee.property.name === 'alert') {
    node.arguments.slice(0, 2).forEach(markText);
    const btns = node.arguments[2];
    if (btns && btns.type === 'ArrayExpression') btns.elements.forEach(b => {
      if (b && b.type === 'ObjectExpression') b.properties.forEach(p => { if (p.key && p.key.name === 'text') markText(p.value); });
    });
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && /^set(Error|Notice|Info|Hint|Message|Warning)$/.test(node.callee.name)) markText(node.arguments[0]);
  eachChild(node, mark);
})(ast);

function paramName(expr, used) {
  let n = expr.type === 'Identifier' ? expr.name
    : (expr.type === 'MemberExpression' || expr.type === 'OptionalMemberExpression') && !expr.computed && expr.property.type === 'Identifier' ? expr.property.name
    : 'value';
  if (!/^[A-Za-z_]\w*$/.test(n)) n = 'value';
  let k = n;
  let i = 2;
  while (used.has(k)) k = n + i++;
  used.add(k);
  return k;
}
function tCall(text, params) {
  const key = keyFor(text);
  const p = params.length ? ', { ' + params.map(([k, v]) => (k === v ? k : k + ': ' + v)).join(', ') + ' }' : '';
  return `${TNAME}('${esc(key)}'${p})`;
}
function containsText(n) {
  let found = false;
  (function w(x) {
    if (found || !x) return;
    if ((x.type === 'StringLiteral' && (GERMAN.test(x.value) || (ui.has(x) && visible(x.value))))
        || (x.type === 'TemplateLiteral' && x.quasis.some(q => GERMAN.test(q.value.cooked)))) { found = true; return; }
    if (isT(x)) return;
    eachChild(x, w);
  })(n);
  return found;
}
function flattenPlus(n, out = []) {
  if (n.type === 'BinaryExpression' && n.operator === '+') { flattenPlus(n.left, out); flattenPlus(n.right, out); }
  else out.push(n);
  return out;
}
function convertParts(parts) {
  let text = '';
  const params = [];
  const used = new Set();
  for (const p of parts) {
    if (p.text != null) text += p.text;
    else {
      if (containsText(p.expr)) return null;
      const name = paramName(p.expr, used);
      params.push([name, code(p.expr)]);
      text += '{' + name + '}';
    }
  }
  return { text, params };
}
const done = new Set();
function overlaps(s, e) { return edits.some(x => s < x.end && e > x.start); }
function addEdit(start, end, text) {
  if (overlaps(start, end)) return false;
  edits.push({ start, end, text });
  return true;
}
function wrapWs(text, params, asJsxAttr) {
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  let rep = tCall(text.trim(), params);
  if (lead) rep = `' ' + ${rep}`;
  if (trail) rep = `${rep} + ' '`;
  return asJsxAttr ? '{' + rep + '}' : rep;
}

(function visit(n) {
  if (skip.has(n)) return;
  const parent = parentOf.get(n);
  // Gemischter JSX-Inhalt
  if ((n.type === 'JSXElement' || n.type === 'JSXFragment') && n.children.length) {
    const ch = n.children;
    let i = 0;
    while (i < ch.length) {
      if (/JSXElement|JSXFragment/.test(ch[i].type)) { i++; continue; }
      let j = i;
      const run = [];
      while (j < ch.length && !/JSXElement|JSXFragment/.test(ch[j].type)) { run.push(ch[j]); j++; }
      const texts = run.filter(x => x.type === 'JSXText' && visible(x.value));
      const exprs = run.filter(x => x.type === 'JSXExpressionContainer' && x.expression.type !== 'JSXEmptyExpression');
      if (texts.length && exprs.length) {
        const parts = [];
        for (const x of run) {
          if (x.type === 'JSXText') parts.push({ text: x.value.replace(/\s*\n\s*/g, ' ') });
          else if (x.expression.type === 'StringLiteral') parts.push({ text: x.expression.value });
          else if (x.expression.type !== 'JSXEmptyExpression') parts.push({ expr: x.expression });
        }
        const r = exprs.some(x => isT(x.expression)) ? null : convertParts(parts);
        if (r) {
          const first = run[0];
          const last = run[run.length - 1];
          const lead = first.type === 'JSXText' ? first.value.match(/^\s*/)[0] : '';
          const trail = last.type === 'JSXText' ? last.value.match(/\s*$/)[0] : '';
          if (addEdit(first.start, last.end, lead + '{' + tCall(r.text.trim(), r.params) + '}' + trail)) run.forEach(x => done.add(x));
        } else {
          texts.forEach(x => { manual.push(`Z.${line(x)}: gemischter JSX-Text mit Bedingung/t(): ${x.value.trim()}`); done.add(x); });
        }
      }
      i = j;
    }
  }
  if (n.type === 'JSXText' && !done.has(n) && visible(n.value)) {
    const v = n.value;
    const lead = v.match(/^\s*/)[0];
    const trail = v.match(/\s*$/)[0];
    addEdit(n.start, n.end, lead + '{' + tCall(v.trim().replace(/\s*\n\s*/g, ' '), []) + '}' + trail);
    return;
  }
  const relevant = (x) => (x.type === 'StringLiteral' && ((ui.has(x) && visible(x.value)) || (GERMAN.test(x.value) && !ALLOWED.has(x.value))))
    || (x.type === 'TemplateLiteral' && (x.quasis.some(q => GERMAN.test(q.value.cooked)) || (ui.has(x) && x.quasis.some(q => visible(q.value.cooked)))));
  if (n.type === 'BinaryExpression' && n.operator === '+' && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+')) {
    const parts = flattenPlus(n);
    if (parts.some(relevant)) {
      if (!inFn.has(n)) { manual.push(`Z.${line(n)}: Modulebene (Verkettung): ${code(n).slice(0, 120)}`); parts.forEach(p => done.add(p)); return; }
      const pp = [];
      for (const p of parts) {
        if (p.type === 'StringLiteral') pp.push({ text: p.value });
        else if (p.type === 'TemplateLiteral') p.quasis.forEach((q, qi) => { pp.push({ text: q.value.cooked }); if (qi < p.expressions.length) pp.push({ expr: p.expressions[qi] }); });
        else pp.push({ expr: p });
      }
      const r = convertParts(pp);
      if (!r) { manual.push(`Z.${line(n)}: Verkettung mit bedingtem Text: ${code(n).slice(0, 160)}`); parts.forEach(p => done.add(p)); return; }
      if (addEdit(n.start, n.end, wrapWs(r.text, r.params, parent && parent.type === 'JSXAttribute'))) parts.forEach(p => done.add(p));
      return;
    }
  }
  if (n.type === 'TemplateLiteral' && !done.has(n) && relevant(n)) {
    if (!inFn.has(n)) { manual.push(`Z.${line(n)}: Modulebene (Template): ${code(n).slice(0, 120)}`); return; }
    const pp = [];
    n.quasis.forEach((q, qi) => { pp.push({ text: q.value.cooked }); if (qi < n.expressions.length) pp.push({ expr: n.expressions[qi] }); });
    const r = convertParts(pp);
    if (!r) { manual.push(`Z.${line(n)}: Template mit bedingtem Text: ${code(n).slice(0, 160)}`); return; }
    addEdit(n.start, n.end, wrapWs(r.text, r.params, false));
    return;
  }
  if (n.type === 'StringLiteral' && !done.has(n) && relevant(n)) {
    if (parent && parent.type === 'ObjectProperty' && parent.key === n) return;
    if (!inFn.has(n)) { manual.push(`Z.${line(n)}: Modulebene: ${n.value.slice(0, 120)}`); return; }
    addEdit(n.start, n.end, wrapWs(n.value, [], parent && parent.type === 'JSXAttribute'));
    return;
  }
  eachChild(n, visit);
})(ast);

edits.sort((a, b) => b.start - a.start);
let out = src;
for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
if (!DRY) fs.writeFileSync(path.join(ROOT, file), out);
if (KEYS_OUT) fs.writeFileSync(KEYS_OUT, JSON.stringify(Object.fromEntries(created), null, 1));
console.log(`${file}: ${edits.length} Ersetzungen, neue Schluessel gesamt ${created.size}, manuell ${manual.length}`);
for (const m of manual) console.log('  MANUELL ' + m);
