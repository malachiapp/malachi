// Statische Pruefung der umgestellten Quelltexte (Heuristik, per Babel-AST):
//  1. In den Oberflaechen-Dateien steht kein sichtbarer Text mehr direkt im
//     JSX, in placeholder/title/...-Props oder in Alert.alert - alles laeuft
//     ueber t(). Ausnahmen (Produktnamen, technische Platzhalter) stehen
//     ausdruecklich in einer Liste.
//  2. Deutsch aussehende String-Literale gibt es dort nur noch in Logzeilen,
//     internen Fehlern und Daten/Protokoll-Werten (ebenfalls Liste).
//  3. Jeder feste Schluessel in t('...') existiert in locales/de.js, ebenso
//     die dynamisch gebildeten Schluessel fuer Themen und Akzentfarben.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const T = require('../../Themes');
const de = require('../../locales/de').default;

const ROOT = path.join(__dirname, '..', '..');
const UI_FILES = ['App.tsx', 'SiegelScreen.tsx', 'GroupScreens.tsx', 'GroupChatScreen.tsx', 'DesignSection.tsx',
  'GroupCallScreen.tsx', 'PhonePairingPanel.tsx', 'PlayProScreen.tsx', 'UpdateUI.tsx', 'SafetyNumberDialog.tsx',
  'SecurityPinModal.tsx', 'VoiceDraft.tsx'];
const MODULE_FILES = ['CallManager.js', 'LicenseManager.js', 'ShopClient.js', 'GroupMessaging.js', 'RTCStore.js',
  'BackgroundSync.js', 'TorTransport.js', 'SiegelVault.js', 'index.js', 'GroupCallManager.js', 'AppUpdater.js', 'PhonePairing.js'];
// DesignSection nennt die Uebersetzungsfunktion tr (t ist dort das Theme);
// in einigen Modulen ist t eine lokale Variable (Zeitgeber, Schleifen).
const T_NAMES = { 'DesignSection.tsx': ['tr'], 'GroupCallManager.js': ['tr'], 'AppUpdater.js': ['tr'], 'PhonePairing.js': ['tr'] };

// Bewusst unuebersetzt sichtbar: Produkt-/Technikbegriffe und Eingabebeispiele.
const ALLOWED_UI = new Set([
  'Malachi ©', 'WebRTC · DTLS-SRTP', 'TOR', 'PRO', 'XMR', 'Malachi', 'Secret Chat',
  'webtunnel [2001:db8::1]:443 … url=https://…', 'ML1.…',
]);
// Deutsch aussehende Literale, die Daten bzw. Protokoll sind (keine UI):
// Ersatz-Dateiname, Lizenz-Fehlercodes. (Der User-Agent fuer Nominatim ist
// mit der Ortsnamen-Suche entfallen - STUN-Ausstieg, E5.)
const ALLOWED_DATA = new Set([
  'Datei',
  'kein-geraeteschluessel', 'keine-lizenz',
]);
const UI_PROPS = new Set(['placeholder', 'title', 'label', 'accessibilityLabel', 'accessibilityHint', 'subtitle', 'hint', 'message']);
const LETTERS = /[A-Za-zÄÖÜäöüß]{2,}/;
const GERMAN = /[ÄÖÜäöüß]|\b(der|die|das|und|nicht|ist|mit|für|fuer|ein|eine|einen|kein|keine|noch|bitte|wird|werden|wurde|du|dein|deine|dich|dir|auf|zu|von|vom|zum|zur|bei|nach|oder|aber|jetzt|hier|alle|Datei|Gruppe|Kontakt|Nachricht|Fehler|Abbrechen|Speichern|Verbinden|Einstellungen)\b/;

function parse(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^﻿/, '');
  return parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
}

// Laeuft den AST ab; visit(node, ctx) mit ctx.inLog / ctx.inError / ctx.inT.
function walk(node, visit, ctx = {}, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  let next = ctx;
  if (node.type === 'CallExpression') {
    const c = node.callee;
    if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'console') next = { ...ctx, inLog: true };
    if (c.type === 'Identifier' && ctx.tNames && ctx.tNames.includes(c.name)) next = { ...ctx, inT: true };
  }
  if ((node.type === 'NewExpression' || node.type === 'CallExpression') && node.callee.type === 'Identifier' && /Error$/.test(node.callee.name)) {
    next = { ...ctx, inError: true };
  }
  visit(node, next, parent);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => walk(x, visit, next, node));
    else if (v && typeof v.type === 'string') walk(v, visit, next, node);
  }
}

// Sichtbare Literale: JSX-Text, String-Kinder, UI-Props, Alert.alert.
function uiHits(ast) {
    const hits = [];
    const add = (what, n, s) => { if (LETTERS.test(s) && !ALLOWED_UI.has(s.trim())) hits.push(`${what} Z.${n.loc.start.line}: ${s.trim()}`); };
    walk(ast, (n, ctx, parent) => {
      if (n.type === 'JSXText') add('JSX-Text', n, n.value);
      if (n.type === 'JSXExpressionContainer' && n.expression.type === 'StringLiteral' && parent && parent.type === 'JSXElement') add('JSX-Literal', n, n.expression.value);
      if (n.type === 'JSXAttribute' && n.name && UI_PROPS.has(n.name.name) && n.value) {
        const v = n.value.type === 'StringLiteral' ? n.value
          : n.value.type === 'JSXExpressionContainer' && n.value.expression.type === 'StringLiteral' ? n.value.expression : null;
        if (v) add('Prop ' + n.name.name, n, v.value);
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'Alert' && n.callee.property.name === 'alert') {
        const scan = (a) => {
          if (!a) return;
          if (a.type === 'StringLiteral') add('Alert', a, a.value);
          if (a.type === 'TemplateLiteral') a.quasis.forEach(q => add('Alert', a, q.value.cooked));
          if (a.type === 'ArrayExpression') a.elements.forEach(scan);
          if (a.type === 'ObjectExpression') a.properties.forEach(p => { if (p.key && p.key.name === 'text') scan(p.value); });
        };
        n.arguments.slice(0, 3).forEach(scan);
      }
    });
    return hits;
}

// Deutsch aussehende Literale ausserhalb von Logs, Fehlern und t(...).
function germanHits(ast, tNames) {
    const hits = [];
    walk(ast, (n, ctx) => {
      if (ctx.inLog || ctx.inError || ctx.inT) return;
      const check = (s) => { if (GERMAN.test(s) && !ALLOWED_DATA.has(s)) hits.push(`Z.${n.loc.start.line}: ${s}`); };
      if (n.type === 'StringLiteral') check(n.value);
      if (n.type === 'TemplateLiteral') n.quasis.forEach(q => check(q.value.cooked));
      if (n.type === 'JSXText') check(n.value.trim());
    }, { tNames });
    return hits;
}

test('Selbsttest: die Heuristik findet unuebersetzte Texte', () => {
  const snippet = [
    "const a = () => <View><Text>Hallo Welt</Text><Text>{'Noch nicht'}</Text>",
    '  <TextInput placeholder="Name eingeben" /></View>;',
    "Alert.alert('Fehler', 'Nicht gespeichert', [{ text: 'Abbrechen' }]);",
    "console.log('[Log] nicht gefunden'); const e = new Error('Datei kaputt'); t('home.title');",
    "const label = 'Gruppe löschen';",
  ].join('\n');
  const bad = parser.parse(snippet, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  expect(uiHits(bad).map(h => h.replace(/^.*?: /, ''))).toEqual(
    ['Hallo Welt', 'Noch nicht', 'Name eingeben', 'Fehler', 'Nicht gespeichert', 'Abbrechen']);
  const g = germanHits(bad, ['t']).map(h => h.replace(/^Z\.\d+: /, ''));
  // Wortliste/Umlaute: grob, aber genug fuer versehentlich stehengebliebene Literale
  expect(g).toEqual(['Noch nicht', 'Fehler', 'Abbrechen', 'Gruppe löschen']);
  expect(g).not.toContain('[Log] nicht gefunden');
  expect(g).not.toContain('Datei kaputt');
});

describe.each(UI_FILES)('%s', (file) => {
  const ast = parse(file);
  test('kein sichtbarer Text direkt im JSX, in UI-Props oder Alert.alert', () => {
    expect(uiHits(ast)).toEqual([]);
  });
  test('deutsche Literale nur in Logs, internen Fehlern und Daten', () => {
    expect(germanHits(ast, T_NAMES[file] || ['t'])).toEqual([]);
  });
});

test('jeder feste Schluessel in t(...) existiert in locales/de.js', () => {
  const missing = [];
  let count = 0;
  for (const file of [...UI_FILES, ...MODULE_FILES]) {
    const names = T_NAMES[file] || ['t'];
    walk(parse(file), (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || !names.includes(n.callee.name)) return;
      const a = n.arguments[0];
      if (!a || a.type !== 'StringLiteral') return;
      count++;
      if (!Object.prototype.hasOwnProperty.call(de, a.value)) missing.push(`${file} Z.${n.loc.start.line}: ${a.value}`);
    });
  }
  expect(missing).toEqual([]);
  expect(count).toBeGreaterThan(500);
});

test('dynamische Schluessel: Themen, Akzentfarben, Verbindungsmodi', () => {
  const need = [
    ...T.THEME_IDS.flatMap(id => ['theme.' + id + '.name', 'theme.' + id + '.desc']),
    ...T.FREE_ACCENTS.map(a => 'accent.' + a.key),
    // Seit dem STUN-Ausstieg zwei Stufen (App.tsx CONNECTION_MODE_INFO), beide mit "Preis".
    ...['direct', 'torOnly'].flatMap(id => ['connMode.' + id + '.label', 'connMode.' + id + '.desc', 'connMode.' + id + '.who', 'connMode.' + id + '.cost']),
  ];
  expect(need.filter(k => !(k in de))).toEqual([]);
});

test('Kotlin-Quellen: sichtbare Benachrichtigungstexte kommen aus strings.xml', () => {
  // Grobe Heuristik: kein deutscher Text mehr in setContentTitle/-Text,
  // NotificationChannel-Namen oder addAction direkt im Kotlin-Code.
  const dir = path.join(ROOT, 'android', 'app', 'src', 'main', 'java');
  const files = [];
  const scan = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scan(p); else if (p.endsWith('.kt')) files.push(p);
  });
  scan(dir);
  const bad = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/(setContentTitle|setContentText|NotificationChannel\(|addAction\(|setDescription\()[^)]*"[^"]*[A-Za-zÄÖÜäöüß]{3,}[^"]*"/.test(line)
        && GERMAN.test(line)) bad.push(path.basename(f) + ':' + (i + 1));
    });
  }
  expect(bad).toEqual([]);
});
