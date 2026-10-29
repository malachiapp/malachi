// Neue Design-Themen (Okt. 2026): 7 hellere/freundliche (darunter "Malachi
// Artwork" mit Klecks-Muster hinter dem Chat) und 7 Business-Themen, Gruppen
// im Picker (THEME_CATEGORIES) und die Artwork-Ebene (ChatArtwork.tsx).
// Kontrast aller Themen prueft themes.contrast.test.js (iteriert PRO_THEMES).
const fs = require('fs');
const path = require('path');
const React = require('react');
const renderer = require('react-test-renderer');

const mockConfig = { LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const T = require('../../Themes');
const ChatArtworkModule = require('../../ChatArtwork');
const ChatArtwork = ChatArtworkModule.default;
const { chatArtworkVisible, buildSplatArt, SPLAT_ART } = ChatArtworkModule;

const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

const OLD_IDS = ['graphit', 'wald', 'amethyst', 'bernstein', 'bordeaux', 'pergament', 'gletscher'];
const BRIGHT_IDS = ['kirschbluete', 'lavendel', 'pistazie', 'sonnenschein', 'lagune', 'pfirsich', 'artwork'];
const BUSINESS_IDS = ['onyx', 'marine', 'schiefer', 'rauchquarz', 'elfenbein', 'champagner', 'platin'];
// Artwork, zweite Runde (Okt. 2026): je ein eigenes Muster (ChatArtwork.tsx ART)
const ART2_IDS = ['sternbild', 'synthwave', 'papierschnitt', 'bauhaus', 'tiefsee', 'kintsugi', 'tarnwald', 'tarnstadt', 'leopard'];
const ART_IDS = ['artwork', ...ART2_IDS];

let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });
beforeEach(async () => {
  await EncryptedStorage.clear();
  T._resetThemesForTests();
});

describe('Themen-Liste und Gruppen', () => {
  test('genau 30 Pro-Themen: die bisherigen 7 (ids unveraendert) + 7 hellere + 7 Business + 9 Artwork', () => {
    expect(T.PRO_THEMES).toHaveLength(30);
    const ids = T.PRO_THEMES.map(p => p.id);
    expect(ids).toEqual([...OLD_IDS, ...BRIGHT_IDS, ...BUSINESS_IDS, ...ART2_IDS]);
    expect(new Set(ids).size).toBe(30);
    expect(new Set(T.PRO_THEMES.map(p => p.name)).size).toBe(30);
    expect(T.THEME_IDS).toEqual(['klassik', ...ids]);
    for (const p of T.PRO_THEMES) {
      expect(p.id).toMatch(/^[a-z]+$/);              // stabil, ASCII (wird als themeId gespeichert)
      expect(typeof p.desc).toBe('string');
      expect(p.desc.length).toBeGreaterThan(8);
      expect(p.name).not.toBe('Standard');
    }
  });

  test('jede Gruppe hat ihre Themen, jedes Thema genau eine bekannte Gruppe', () => {
    expect(T.THEME_CATEGORIES.map(c => c.key)).toEqual(['dunkel', 'hell', 'business', 'artwork']);
    expect(T.THEME_CATEGORIES.map(c => c.label)).toEqual(['Dunkel', 'Hell', 'Business', 'Artwork']);
    const keys = T.THEME_CATEGORIES.map(c => c.key);
    for (const p of T.PRO_THEMES) expect(keys).toContain(p.category);
    expect(T.KLASSIK_META.category).toBe('dunkel');
    const groups = T.themesByCategory();
    expect(groups.map(g => [g.key, g.themes.map(t => t.id)])).toEqual([
      ['dunkel', ['graphit', 'wald', 'amethyst', 'bernstein', 'bordeaux']],
      ['hell', ['pergament', 'gletscher', 'kirschbluete', 'lavendel', 'pistazie', 'sonnenschein', 'lagune', 'pfirsich']],
      ['business', BUSINESS_IDS],
      ['artwork', ART_IDS],
    ]);
  });

  test('die neuen hellen Themen sind wirklich hell, Business ist gemischt hell/dunkel', () => {
    for (const id of BRIGHT_IDS) {
      const p = T.PRO_THEMES.find(x => x.id === id);
      expect(p.dark).toBe(false);
      expect(T.luminance(p.bg)).toBeGreaterThan(0.8);
      expect(T.luminance(p.chatBg)).toBeGreaterThan(0.75);
    }
    const biz = T.PRO_THEMES.filter(p => p.category === 'business');
    const dark = biz.filter(p => p.dark), light = biz.filter(p => !p.dark);
    expect(dark.length).toBeGreaterThanOrEqual(3);
    expect(light.length).toBeGreaterThanOrEqual(3);
    for (const p of dark) expect(T.luminance(p.bg)).toBeLessThan(0.05);
    for (const p of light) expect(T.luminance(p.bg)).toBeGreaterThan(0.7);
  });

  test('Statusleiste passt zur Kopfleiste, Profilbild-Platzhalter lesbar - fuer alle neuen Themen', () => {
    for (const id of [...BRIGHT_IDS, ...BUSINESS_IDS, ...ART2_IDS]) {
      const t = T.resolveTheme({ themeId: id }, true);
      expect(t.statusBar).toBe(T.statusBarFor(t.headerBg));
      const icon = t.statusBar === 'light-content' ? '#FFFFFF' : '#000000';
      expect(T.contrastRatio(icon, t.headerBg)).toBeGreaterThanOrEqual(4.5);
      expect(T.contrastRatio(t.avatarText, t.avatarBg)).toBeGreaterThanOrEqual(4.5);
      expect(T.contrastRatio(t.headerAvatarText, t.headerAvatarBg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('gespeicherte Auswahl: alte ids gelten weiter, neue werden verstanden, Unbekanntes faellt auf Standard', () => {
    for (const id of [...OLD_IDS, ...BRIGHT_IDS, ...BUSINESS_IDS, ...ART2_IDS]) {
      expect(T.selectionFromSettings(JSON.stringify({ themeId: id })).themeId).toBe(id);
    }
    expect(T.selectionFromSettings({ themeId: 'splatoon' }).themeId).toBe('klassik');
    T.restoreThemeSelection({ themeId: 'gibtsnicht' });
    expect(T.getThemeSelection().themeId).toBe('klassik');
    T.restoreThemeSelection({ themeId: 'artwork' });
    expect(T.getTheme().id).toBe('klassik');          // ohne Lizenz angezeigt: Standard
    T.setThemeProUnlocked(true);
    expect(T.getTheme().id).toBe('artwork');
    expect(T.getTheme().artwork).toBe('splat');
  });
});

describe('Malachi Artwork', () => {
  const art = () => T.resolveTheme({ themeId: 'artwork' }, true);

  test('nur die Artwork-Themen haben ein Muster', () => {
    const withArt = T.PRO_THEMES.filter(p => p.artwork).map(p => p.id);
    expect(withArt).toEqual(ART_IDS);
    for (const p of T.PRO_THEMES) {
      const t = T.resolveTheme({ themeId: p.id }, true);
      if (ART_IDS.includes(p.id)) expect(Array.isArray(t.artworkFills)).toBe(true);
      else expect(t.artworkFills).toBeUndefined();
    }
    expect(T.resolveTheme({}, false).artwork).toBeUndefined();
  });

  test('Muster ist kontrastarm, Schrift direkt auf dem Hintergrund bleibt darauf lesbar, Blasen deckend', () => {
    const t = art();
    expect(t.artworkFills).toHaveLength(t.artworkInks.length);
    expect(t.artworkInks.length).toBeGreaterThanOrEqual(4);
    for (const c of t.artworkFills) {
      expect(c).toMatch(/^#[0-9A-F]{6}$/);                                   // deckend, kein Alpha
      expect(T.contrastRatio(c, t.chatBg)).toBeLessThanOrEqual(3);            // kein Vordergrund
      expect(T.contrastRatio(c, t.chatBg)).toBeGreaterThan(1.2);              // deutlich sichtbar (Nutzerwunsch)
      expect(T.contrastRatio(t.textMuted, c)).toBeGreaterThanOrEqual(4.5);    // Zeit unter Bildern
      expect(T.contrastRatio(t.text, c)).toBeGreaterThanOrEqual(7);
    }
    for (const k of ['bubbleMine', 'bubbleTheirs', 'surface', 'chatBg']) expect(T.parseColor(t[k]).a).toBe(1);
    // die Tinten selbst sind knallig (gesaettigt) - das Thema soll "komplett anders" sein
    const sat = (hex) => { const { r, g, b } = T.parseColor(hex); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
    for (const c of t.artworkInks) expect(sat(c)).toBeGreaterThan(0.75);
    expect(sat(t.bubbleMine)).toBeGreaterThan(0.6);
    expect(sat(t.accent)).toBeGreaterThan(0.9);
  });

  test('Formen deterministisch (fester Startwert), wenige Dutzend Elemente, alle Koordinaten endlich', () => {
    expect(buildSplatArt()).toEqual(SPLAT_ART);
    expect(buildSplatArt(1)).not.toEqual(SPLAT_ART);
    const n = SPLAT_ART.blobs.length + SPLAT_ART.drops.length + SPLAT_ART.drips.length;
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(110);
    // Graffiti-Laufnasen: mindestens eine je Klecks, senkrecht nach unten
    expect(SPLAT_ART.drips.length).toBeGreaterThanOrEqual(SPLAT_ART.blobs.length);
    for (const p of SPLAT_ART.drips) {
      expect(p.d).toMatch(/^M[-\d. ]+L[-\d. ]+A[-\d. ]+L[-\d. ]+Z$/);
      expect(p.d).not.toMatch(/NaN|Infinity/);
    }
    for (const b of SPLAT_ART.blobs) {
      expect(b.d).toMatch(/^M[-\d. ]+(C[-\d. ]+)+Z(M[-\d. ]+(C[-\d. ]+)+Z)*$/);
      expect(b.d).not.toMatch(/NaN|Infinity/);
    }
    for (const c of SPLAT_ART.drops) for (const v of [c.cx, c.cy, c.r]) expect(Number.isFinite(v)).toBe(true);
  });

  test('chatArtworkVisible: nur mit Artwork-Design, automatisch (auch mit frueherer Farb-Voreinstellung), nicht ueber eigenem Bild, nie im Secret Chat', () => {
    const t = art();
    expect(chatArtworkVisible(t)).toBe(true);
    expect(chatArtworkVisible(t, { secretActive: true })).toBe(false);
    expect(chatArtworkVisible(t, { customBg: 'file:///bg.jpg' })).toBe(false);
    expect(chatArtworkVisible(T.resolveTheme({ themeId: 'artwork', chatBgPreset: '#FFFFFF' }, true))).toBe(true);
    expect(chatArtworkVisible(T.resolveTheme({ themeId: 'artwork' }, false))).toBe(false);   // ohne Lizenz: Standard
    expect(chatArtworkVisible(T.resolveTheme({}, false))).toBe(false);
    for (const p of T.PRO_THEMES.filter(x => !x.artwork)) {
      expect(chatArtworkVisible(T.resolveTheme({ themeId: p.id }, true))).toBe(false);
    }
    expect(chatArtworkVisible(null)).toBe(false);
  });

  test('Ebene: eine SVG, nicht bedienbar (pointerEvents="none"), fuer Screenreader ausgeblendet', async () => {
    const t = art();
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(ChatArtwork, { kind: t.artwork, fills: t.artworkFills, bg: t.chatBg }));
    });
    const layer = tree.root.findAll(n => n.props.testID === 'chat-artwork' && typeof n.type === 'string');
    expect(layer).toHaveLength(1);
    expect(layer[0].props.pointerEvents).toBe('none');
    expect(layer[0].props.importantForAccessibility).toBe('no-hide-descendants');
    expect(JSON.stringify(tree.toJSON())).toContain(t.chatBg);
    // genau die vorberechneten Formen, gefuellt nur mit den kontrastarmen artworkFills
    const svgs = tree.root.findAll(n => typeof n.type === 'string' && /Svg/.test(n.type) && /View/.test(n.type));
    expect(svgs).toHaveLength(1);
    expect(svgs[0].props.meetOrSlice).toBe(1);                       // "slice": deckt jede Bildschirmgroesse ab
    const { Path, Circle } = require('react-native-svg');
    const paths = tree.root.findAllByType(Path);
    const circles = tree.root.findAllByType(Circle);
    expect(paths).toHaveLength(SPLAT_ART.blobs.length + SPLAT_ART.drips.length);   // Kleckse + Laufnasen
    expect(circles).toHaveLength(SPLAT_ART.drops.length);
    const used = new Set([...paths, ...circles].map(n => n.props.fill));
    for (const c of used) expect(t.artworkFills).toContain(c);
    expect(used.size).toBe(t.artworkFills.length);                   // jede Tinte kommt vor
    await renderer.act(async () => tree.unmount());
  });

  test('Ebene rendert nichts ohne Artwork (andere Themen, Standard, fehlende Farben)', async () => {
    const cases = [
      ...T.PRO_THEMES.filter(p => !p.artwork).map(p => T.resolveTheme({ themeId: p.id }, true)),
      T.resolveTheme({}, false),
    ];
    for (const t of cases) {
      let tree;
      await renderer.act(async () => {
        tree = renderer.create(React.createElement(ChatArtwork, { kind: t.artwork, fills: t.artworkFills, bg: t.chatBg }));
      });
      expect(tree.toJSON()).toBeNull();
      await renderer.act(async () => tree.unmount());
    }
    let tree;
    await renderer.act(async () => { tree = renderer.create(React.createElement(ChatArtwork, { kind: 'splat', fills: [] })); });
    expect(tree.toJSON()).toBeNull();
    await renderer.act(async () => tree.unmount());
  });

  test('statisch: Chat legt die Ebene hinter die Liste und macht die Liste nur dann durchsichtig', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/import ChatArtwork, \{ chatArtworkVisible \} from '\.\/ChatArtwork';/);
    const i = app.indexOf('<FlatList ref={ref} data={msgs}');
    const before = app.slice(i - 400, i);
    expect(before).toMatch(/<View style=\{\{ flex:1 \}\}>\s*\{chatArtworkVisible\(P, \{ secretActive, customBg \}\) && <ChatArtwork kind=\{P\.artwork\} fills=\{P\.artworkFills\} glints=\{P\.artworkGlints\} bg=\{P\.chatBg\} \/>\}\s*$/);
    const style = app.slice(i, app.indexOf('\n', app.indexOf('style=', i)));
    expect(style).toMatch(/secretActive \? '#0E0A06' : customBg \|\| chatArtworkVisible\(P, \{ secretActive, customBg \}\) \? 'transparent'/);
    // Wrapper wird direkt nach der Liste geschlossen
    const end = app.indexOf('{chat?.wiped ? (', i);
    expect(app.slice(end - 40, end)).toMatch(/\/>\s*<\/View>\s*$/);
  });
});

describe('Chat-Bildschirm mit Artwork-Design', () => {
  const { ChatScreen } = require('../../App');
  const { SafeAreaProvider } = require('react-native-safe-area-context');
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  const chat = { id: 'artwork-test', name: 'Anna Meyer' };
  const messages = [
    { id: '1', text: 'Hallo!', mine: false, time: '10:41' },
    { id: '2', text: 'Neues Design', mine: true, time: '10:42', status: 'read' },
  ];

  async function renderChat() {
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(SafeAreaProvider, { initialMetrics: metrics },
        React.createElement(ChatScreen, { chat, messages, onBack() {}, backInterceptRef: { current: null }, onCall() {},
          rtc: null, fontSize: 15, customBg: null, onRename() {}, onDelete() {}, onRemoteDelete() {}, onWipe() {}, onLastMessage() {} })));
    });
    return tree;
  }
  const { FlatList } = require('react-native');
  const layers = (tree) => tree.root.findAll(n => n.props.testID === 'chat-artwork' && typeof n.type === 'string');
  // die Liste des Chatverlaufs (enthaelt die Testnachrichten)
  const listBg = (tree) => tree.root.findAllByType(FlatList)
    .find(n => Array.isArray(n.props.data) && n.props.data.some(m => m && m.text === 'Hallo!'))?.props.style.backgroundColor;

  let logSpy;
  beforeAll(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterAll(() => { logSpy.mockRestore(); });

  test('Artwork gewaehlt: Chat rendert ohne Fehler, Muster liegt nicht bedienbar hinter den Nachrichten', async () => {
    T.setThemeSelection({ themeId: 'artwork' }, { pro: true });
    const tree = await renderChat();
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Hallo!');
    expect(json).toContain('Neues Design');
    const l = layers(tree);
    expect(l).toHaveLength(1);
    expect(l[0].props.pointerEvents).toBe('none');
    // Liste durchsichtig (Muster scheint durch), Blasen deckend in den Theme-Farben
    const t = T.getTheme();
    expect(listBg(tree)).toBe('transparent');
    expect(json).toContain(t.bubbleMine);
    expect(json).toContain(t.bubbleTheirs);
    await renderer.act(async () => tree.unmount());
  });

  test('anderes Design: keine Artwork-Ebene, Liste wie bisher in chatBg', async () => {
    T.setThemeSelection({ themeId: 'lagune' }, { pro: true });
    const tree = await renderChat();
    expect(layers(tree)).toHaveLength(0);
    expect(listBg(tree)).toBe(T.getTheme().chatBg);
    await renderer.act(async () => tree.unmount());
  });

  test('Artwork + frueher gewaehlte Hintergrundfarbe: Muster kommt trotzdem (automatisch mit dem Design)', async () => {
    T.setThemeSelection({ themeId: 'artwork', chatBgPreset: '#F5EFE6' }, { pro: true });
    const tree = await renderChat();
    expect(layers(tree)).toHaveLength(1);
    expect(listBg(tree)).toBe('transparent');
    await renderer.act(async () => tree.unmount());
  });
});

describe('Artwork, zweite Runde: neun weitere Muster', () => {
  const { ART, ARTWORK_KINDS, buildStarsArt, buildSynthArt, buildPaperArt, buildBauhausArt, buildDeepSeaArt, buildKintsugiArt, buildPixelCamoArt, buildLeopardArt } = ChatArtworkModule;
  const themes = ART2_IDS.map((id) => T.resolveTheme({ themeId: id }, true));

  test('jedes Thema hat sein eigenes Muster; alle Arten bekannt', () => {
    const kinds = themes.map((t) => t.artwork);
    expect(new Set(kinds).size).toBe(ART2_IDS.length);
    for (const k of kinds) { expect(ARTWORK_KINDS).toContain(k); expect(Array.isArray(ART[k])).toBe(true); }
    expect(ARTWORK_KINDS).toEqual(['splat', ...kinds]);
  });

  test.each(ART2_IDS)('%s: Muster kontrastarm, Zeitstempel und Schrift darauf lesbar, Blasen deckend', (id) => {
    const t = T.resolveTheme({ themeId: id }, true);
    expect(t.artworkInks.length).toBeGreaterThanOrEqual(3);
    expect(t.artworkFills).toHaveLength(t.artworkInks.length);
    let visible = 0;
    for (const c of t.artworkFills) {
      expect(c).toMatch(/^#[0-9A-F]{6}$/);
      expect(T.contrastRatio(c, t.chatBg)).toBeLessThanOrEqual(3);
      if (T.contrastRatio(c, t.chatBg) > 1.15) visible++;
      expect(T.contrastRatio(t.textMuted, c)).toBeGreaterThanOrEqual(4.5);
      expect(T.contrastRatio(t.text, c)).toBeGreaterThanOrEqual(4.5);
    }
    expect(visible).toBeGreaterThanOrEqual(2);                       // man sieht das Muster
    for (const k of ['bubbleMine', 'bubbleTheirs', 'surface', 'chatBg']) expect(T.parseColor(t[k]).a).toBe(1);
    expect(chatArtworkVisible(t)).toBe(true);
    expect(chatArtworkVisible(t, { customBg: 'file:///bg.jpg' })).toBe(false);
    expect(chatArtworkVisible(T.resolveTheme({ themeId: id }, false))).toBe(false);   // ohne Lizenz: Standard
  });

  test('Formen deterministisch, endlich, Tinten-Index im Bereich, Umfang begrenzt', () => {
    expect(buildStarsArt()).toEqual(ART.stars);
    expect(buildSynthArt()).toEqual(ART.synth);
    expect(buildPaperArt()).toEqual(ART.paper);
    expect(buildBauhausArt()).toEqual(ART.bauhaus);
    expect(buildDeepSeaArt()).toEqual(ART.deepsea);
    expect(buildKintsugiArt()).toEqual(ART.kintsugi);
    expect(buildPixelCamoArt(0xF0E57, 8)).toEqual(ART.pixelwood);
    expect(buildLeopardArt()).toEqual(ART.leopard);
    expect(buildStarsArt(1)).not.toEqual(ART.stars);
    for (const t of themes) {
      const shapes = ART[t.artwork];
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes.length).toBeLessThanOrEqual(260);
      for (const sh of shapes) {
        expect(sh.ink).toBeGreaterThanOrEqual(0);
        expect(sh.ink).toBeLessThan(t.artworkFills.length);
        expect(!!sh.d !== !!sh.c).toBe(true);                       // genau eine Geometrie
        if (sh.d) expect(sh.d).not.toMatch(/NaN|Infinity|undefined/);
        if (sh.c) for (const v of sh.c) expect(Number.isFinite(v)).toBe(true);
        if (sh.o !== undefined) { expect(sh.o).toBeGreaterThan(0); expect(sh.o).toBeLessThanOrEqual(1); }
      }
    }
  });

  test('Glanzpunkte: nur winzige Formen, Zeitstempel darauf noch 3:1, sonst die normalen Musterfarben', () => {
    for (const t of themes) {
      expect(t.artworkGlints).toHaveLength(t.artworkInks.length);
      for (const c of t.artworkGlints) {
        expect(c).toMatch(/^#[0-9A-F]{6}$/);
        expect(T.contrastRatio(t.textMuted, c)).toBeGreaterThanOrEqual(3);
      }
      for (const sh of ART[t.artwork].filter((x) => x.g)) {
        if (sh.c) expect(sh.c[2]).toBeLessThanOrEqual(3.5);
        else {
          const nums = sh.d.match(/-?[\d.]+/g).map(Number);
          const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
          expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(20);
          expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  test('Sternbild enthaelt das Malachi-M (vier Linien zwischen fuenf Knoten)', () => {
    expect(ART.stars.some((s) => s.d === 'M200 501L226 455L252 489L278 455L304 501')).toBe(true);
  });

  test('Pixel-Tarn: nur achsenparallele Rechtecke auf dem Raster, je Ton ein Pfad, etwa 70 % bedeckt', () => {
    for (const [kind, cell] of [['pixelwood', 8], ['pixelurban', 7]]) {
      const shapes = ART[kind];
      expect(shapes).toHaveLength(3);
      let area = 0;
      for (const sh of shapes) {
        expect(sh.d).toMatch(/^(M\d+ \d+h\d+v\d+h-\d+Z)+$/);
        for (const m of sh.d.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)/g)) {
          const [x, y, w, h] = m.slice(1).map(Number);
          expect(x % cell).toBe(0); expect(y % cell).toBe(0); expect(w % cell).toBe(0); expect(h).toBe(cell);
          area += w * h;
        }
      }
      const total = Math.ceil(360 / cell) * cell * Math.ceil(760 / cell) * cell;
      expect(area / total).toBeGreaterThan(0.6);
      expect(area / total).toBeLessThan(0.8);
    }
  });

  test.each(ART2_IDS)('%s: Ebene rendert nicht bedienbar, nur mit den Musterfarben, jede Tinte kommt vor', async (id) => {
    const t = T.resolveTheme({ themeId: id }, true);
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(ChatArtwork, { kind: t.artwork, fills: t.artworkFills, glints: t.artworkGlints, bg: t.chatBg }));
    });
    const layer = tree.root.findAll(n => n.props.testID === 'chat-artwork' && typeof n.type === 'string');
    expect(layer).toHaveLength(1);
    expect(layer[0].props.pointerEvents).toBe('none');
    const { Path, Circle } = require('react-native-svg');
    const els = [...tree.root.findAllByType(Path), ...tree.root.findAllByType(Circle)];
    expect(els).toHaveLength(ART[t.artwork].length);
    const used = new Set(els.map(n => (n.props.fill && n.props.fill !== 'none' ? n.props.fill : n.props.stroke)));
    for (const c of used) expect([...t.artworkFills, ...t.artworkGlints]).toContain(c);
    await renderer.act(async () => tree.unmount());
  });
});
