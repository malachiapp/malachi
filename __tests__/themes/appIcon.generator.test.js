// "App-Icon passend zum Design" (THEMES.md, Abschnitt "App-Icon"): der
// Generator tools/gen-theme-icons.js erzeugt je Design ein adaptives Icon.
// Geprueft wird unabhaengig von der Farbrechnung des Generators: Anzahl und
// Vollstaendigkeit der Varianten, gueltiges XML, identische Geometrie wie das
// Marken-Icon, Kontrast des Zeichens >= 3:1 auf jedem Verlaufston des
// Hintergrunds, und dass die eingecheckten Dateien aktuell sind.
const fs = require('fs');
const path = require('path');
const T = require('../../Themes');
const V = require('../../AppIconVariants');
const G = require('../../tools/gen-theme-icons');

const ROOT = path.join(__dirname, '..', '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (rel) => lf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const FG_TEMPLATE = read(G.FG_TEMPLATE);
const BG_TEMPLATE = read(G.BG_TEMPLATE);

const { files } = G.generate({ T, V, root: ROOT });
const others = V.ICON_VARIANTS.filter(v => v.id !== V.DEFAULT_ICON_VARIANT);
const resPath = (dir, name) => 'android/app/src/main/res/' + dir + '/' + name + '.xml';
const fgOf = (id) => files.get(resPath('drawable', 'ic_appicon_' + id + '_fg'));
const adaptiveOf = (id) => files.get(resPath('mipmap-anydpi-v26', 'ic_appicon_' + id));
const layerOf = (id) => files.get(resPath('mipmap-anydpi', 'ic_appicon_' + id));

/** Drawable-Verweis -> Inhalt (erzeugt oder eingecheckt). */
function drawable(ref) {
  const m = /^@drawable\/([a-z0-9_]+)$/.exec(ref);
  if (!m) throw new Error('kein Drawable-Verweis: ' + ref);
  const rel = resPath('drawable', m[1]);
  if (files.has(rel)) return files.get(rel);
  return read(rel);
}

/** Minimaler XML-Wohlgeformtheits-Check: Prolog, Kommentare, ausbalancierte Tags. */
function assertWellFormed(xml, label) {
  expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
  const body = xml.replace(/^<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  expect(body).not.toMatch(/--/);
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:]+="[^"<>]*")*)\s*(\/?)>/g;
  let m; let roots = 0; let rest = body;
  while ((m = re.exec(body))) {
    const [, close, name, , self] = m;
    if (close) { expect([label, stack.pop()]).toEqual([label, name]); }
    else if (!self) { if (!stack.length) roots++; stack.push(name); }
    else if (!stack.length) roots++;
  }
  rest = body.replace(re, '').trim();
  expect([label, stack]).toEqual([label, []]);
  expect([label, roots]).toEqual([label, 1]);
  expect([label, rest]).toEqual([label, '']);   // kein Text ausserhalb von Tags
}

/** Alle #AARRGGBB-Farben in Reihenfolge. */
const colors = (xml) => xml.match(/#[0-9A-Fa-f]{8}\b/g) || [];
/** Vorlage <-> Erzeugnis Farbe fuer Farbe zuordnen; dieselbe Vorlagenfarbe muss immer gleich ersetzt sein. */
function colorMap(template, generated) {
  const a = colors(template); const b = colors(generated);
  expect(b).toHaveLength(a.length);
  const map = {};
  a.forEach((c, i) => {
    const k = c.toUpperCase();
    if (map[k] !== undefined) expect(map[k]).toBe(b[i].toUpperCase());
    map[k] = b[i].toUpperCase();
  });
  return map;
}
const rgb = (argb) => '#' + argb.slice(3);
/** Geometrie = alles ausser Farben und Kopfkommentar. */
const geometry = (xml) => xml.replace(/<!--[\s\S]*?-->/, '').replace(/#[0-9A-Fa-f]{8}\b/g, '#COLOR');

describe('Varianten', () => {
  test('eine Variante je Design (21) + je kostenlose Akzentfarbe (11) + Marken-Standard', () => {
    expect(V.ICON_VARIANTS).toHaveLength(1 + (T.FREE_ACCENTS.length - 1) + T.PRO_THEMES.length);
    expect(V.ICON_VARIANTS).toHaveLength(33);
    expect(new Set(V.ICON_VARIANT_IDS).size).toBe(V.ICON_VARIANT_IDS.length);
    expect(V.ICON_VARIANT_IDS[0]).toBe('klassik');
    expect(V.DEFAULT_ICON_VARIANT).toBe('klassik');
    for (const p of T.PRO_THEMES) expect(V.ICON_VARIANT_IDS).toContain(p.id);
    for (const a of T.FREE_ACCENTS) {
      expect(V.ICON_VARIANT_IDS).toContain(a.key === T.DEFAULT_ACCENT_KEY ? 'klassik' : 'klassik_' + a.key);
    }
    // Android-Ressourcennamen
    for (const id of V.ICON_VARIANT_IDS) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test('Standard-Icon bleibt das bestehende Marken-Icon (nichts erzeugt)', () => {
    for (const rel of files.keys()) expect(rel).not.toMatch(/ic_appicon_klassik(_fg|_bg)?\.xml$/);
    expect(fs.existsSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'))).toBe(true);
  });
});

describe('erzeugte Icons', () => {
  test('je Variante: adaptives Icon (v26) + Ebenenliste (API 24/25) + Vordergrund, alles gueltiges XML', () => {
    for (const v of others) {
      const ad = adaptiveOf(v.id); const ll = layerOf(v.id); const fg = fgOf(v.id);
      expect([v.id, !!ad, !!ll, !!fg]).toEqual([v.id, true, true, true]);
      assertWellFormed(ad, v.id + ' adaptive');
      assertWellFormed(ll, v.id + ' layer-list');
      assertWellFormed(fg, v.id + ' fg');
      expect(ad).toMatch(/<adaptive-icon xmlns:android="http:\/\/schemas.android.com\/apk\/res\/android">/);
      const bgRef = /<background android:drawable="([^"]+)"\/>/.exec(ad)[1];
      const fgRef = /<foreground android:drawable="([^"]+)"\/>/.exec(ad)[1];
      // einfarbige Ebene (Android 13 "Designte Symbole") unveraendert
      expect(/<monochrome android:drawable="([^"]+)"\/>/.exec(ad)[1]).toBe('@drawable/ic_launcher_mono');
      expect(fgRef).toBe('@drawable/ic_appicon_' + v.id + '_fg');
      // Pro-Designs: eigener Hintergrund; Standard-Akzente: Marken-Hintergrund
      expect(bgRef).toBe(v.pro ? '@drawable/ic_appicon_' + v.id + '_bg' : '@drawable/ic_launcher_bg');
      // Ebenenliste nutzt dieselben Ebenen
      expect(ll).toContain('<item android:drawable="' + bgRef + '" />');
      expect(ll).toContain('<item android:drawable="' + fgRef + '" />');
      assertWellFormed(drawable(bgRef), v.id + ' bg');
    }
  });

  test('Geometrie identisch mit dem Marken-Icon (66dp-Sicherheitszone), nur Farben getauscht', () => {
    const fgGeo = geometry(FG_TEMPLATE);
    const bgGeo = geometry(BG_TEMPLATE);
    // gleiche Leinwand wie die Vorlage (108dp, Sicherheitszone = Kreis r=33 um 54/54)
    expect(FG_TEMPLATE).toContain('android:viewportWidth="108"');
    for (const v of others) {
      expect(geometry(fgOf(v.id))).toBe(fgGeo);
      if (v.pro) expect(geometry(drawable('@drawable/ic_appicon_' + v.id + '_bg'))).toBe(bgGeo);
      const pathData = (x) => (x.match(/android:pathData="[^"]*"/g) || []);
      expect(pathData(fgOf(v.id))).toEqual(pathData(FG_TEMPLATE));
    }
  });

  test('Farben passen zum Design und unterscheiden sich vom Marken-Icon', () => {
    const brandBg = colors(BG_TEMPLATE).map(rgb);
    const seen = new Set();
    for (const v of others) {
      const map = colorMap(FG_TEMPLATE, fgOf(v.id));
      const theme = T.resolveTheme({ themeId: v.themeId, accentKey: v.accentKey || 'cyan' }, true);
      const [light, mid, dark] = v.pro ? colors(drawable('@drawable/ic_appicon_' + v.id + '_bg')).map(rgb) : brandBg;
      // Hintergrund = Kopfleiste des Designs (fast weisse Kopfleiste: App-Hintergrund)
      if (v.pro) expect([v.id, [T.flatten(theme.headerBg, '#000000'), T.flatten(theme.bg, '#000000')].includes(mid)]).toEqual([v.id, true]);
      const mark = [rgb(map['#FF36E0FF']), rgb(map['#FF7C8CFF'])];
      // der Akzent des Designs (nur so weit angepasst, dass er 3:1 erreicht) steckt im Zeichen
      expect([v.id, mark.includes(T.ensureContrast(theme.accent, [mid, light, dark], 3))]).toEqual([v.id, true]);
      seen.add(mark.join());
    }
    // jede Variante sieht anders aus
    expect(seen.size).toBe(others.length);
    expect(seen.has(['#36E0FF', '#7C8CFF'].join())).toBe(false);
  });

  test('Kontrast: Zeichen (Verlauf, Knoten) >= 3:1 auf JEDEM Hintergrundton, Schluesselloch >= 3:1 auf dem Schloss', () => {
    const brandBg = colors(BG_TEMPLATE).map(rgb);
    expect(brandBg).toEqual(['#101E4A', '#071433', '#02060F']);
    let weakest = Infinity;
    for (const v of others) {
      const map = colorMap(FG_TEMPLATE, fgOf(v.id));
      const bgStops = v.pro
        ? colors(drawable('@drawable/ic_appicon_' + v.id + '_bg')).map(rgb)
        : brandBg;
      expect(bgStops).toHaveLength(3);
      const mark = ['#FF36E0FF', '#FF7C8CFF', '#FF5DE6FF'].map(k => rgb(map[k]));
      for (const c of mark) {
        for (const b of bgStops) {
          const r = T.contrastRatio(c, b);
          weakest = Math.min(weakest, r);
          expect([v.id, c, b, r >= 3]).toEqual([v.id, c, b, true]);
        }
      }
      const keyhole = rgb(map['#FF7FEFFF']);
      const lock = rgb(map['#FF071433']);
      expect([v.id, T.contrastRatio(keyhole, lock) >= 3]).toEqual([v.id, true]);
      // deckende Farben bleiben deckend, transparente transparent (nur RGB getauscht)
      for (const [from, to] of Object.entries(map)) expect(to.slice(0, 3)).toBe(from.slice(0, 3));
    }
    expect(weakest).toBeGreaterThanOrEqual(3);
  });

  test('Generator lehnt unbekannte Vorlagenfarben ab (keine stillen Reste der Markenfarbe)', () => {
    const pal = G.iconPalette(T, others[0]);
    expect(() => G.renderForeground(FG_TEMPLATE.replace('#FF7FEFFF', '#FF123456'), pal, others[0])).toThrow(/unbekannte Farbe/);
  });
});

describe('Eingecheckte Dateien', () => {
  test('aktuell: identisch mit einem frischen Generatorlauf (sonst: node tools/gen-theme-icons.js)', () => {
    for (const [rel, content] of files) {
      const abs = path.join(ROOT, rel);
      expect([rel, fs.existsSync(abs)]).toEqual([rel, true]);
      expect([rel, read(rel) === content]).toEqual([rel, true]);
    }
    expect(G.staleFiles(ROOT, files)).toEqual([]);
  });

  test('deterministisch: zweiter Lauf liefert byte-gleiche Inhalte', () => {
    const again = G.generate({ T, V, root: ROOT }).files;
    expect([...again.entries()]).toEqual([...files.entries()]);
  });

  test('Farbtabelle in THEMES.md (Abschnitt "App-Icon") ist aktuell (node tools/gen-theme-icons.js --table)', () => {
    const { palettes } = G.generate({ T, V, root: ROOT });
    expect(read('THEMES.md')).toContain(G.paletteTable(T, V, palettes));
  });

  test('AppIconVariants.kt enthaelt genau die Varianten-Liste', () => {
    const kt = read(G.KOTLIN);
    expect(/const val DEFAULT = "([^"]+)"/.exec(kt)[1]).toBe(V.DEFAULT_ICON_VARIANT);
    expect(/const val ALIAS_PREFIX = "([^"]+)"/.exec(kt)[1]).toBe('com.securecommapp.' + V.ICON_ALIAS_PREFIX);
    const ids = [...kt.slice(kt.indexOf('listOf(')).matchAll(/"([a-z0-9_]+)"/g)].map(m => m[1]);
    expect(ids).toEqual([...V.ICON_VARIANT_IDS]);
  });
});
