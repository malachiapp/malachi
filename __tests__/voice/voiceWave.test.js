// Wellenform fuer Sprachnachrichten (VoiceWave.js): Kodierung, Pruefung beim
// Empfang, Geometrie beider Stile, Stil-Einstellung.
import {
  WAVE_BARS, levelFromDb, encodeWave, sanitizeWave, parseWave, fallbackLevels, levelsFor, resample,
  barsPaths, pixelPaths, pixelWaveColumns, createLevelFeed,
  loadWaveStyle, setWaveStyle, waveStyleSetting, effectiveWaveStyle, resetWaveStyleAfterWipe,
  subscribeWaveStyle, WAVE_STYLE_KEY, DEFAULT_WAVE_STYLE,
} from '../../VoiceWave';
import EncryptedStorage from 'react-native-encrypted-storage';

describe('Pegel und Kodierung', () => {
  test('dBFS -> 0..1 mit Stille-Schwelle', () => {
    expect(levelFromDb(-160)).toBe(0);
    expect(levelFromDb(-50)).toBe(0);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(-25)).toBeCloseTo(0.5);
    expect(levelFromDb('kaputt')).toBe(0);
    expect(levelFromDb(12)).toBe(1);
  });

  test('Aufnahme -> 48 Stufen, normiert, jede mindestens 1', () => {
    const samples = Array.from({ length: 123 }, (_, i) => (i % 10 === 0 ? -5 : -40));
    const w = encodeWave(samples);
    expect(w).toHaveLength(WAVE_BARS);
    expect(w).toMatch(/^[1-9A-V]+$/);
    expect(w).toContain('V');                 // lautester Abschnitt = Stufe 31
  });

  test('kurze Aufnahmen (weniger Messwerte als Balken) werden gestreckt', () => {
    const w = encodeWave([-10, -30, -45]);
    expect(w).toHaveLength(WAVE_BARS);
    expect(parseWave(w)).toHaveLength(WAVE_BARS);
  });

  test('ohne Messwerte: keine Wellenform', () => {
    expect(encodeWave([])).toBeNull();
    expect(encodeWave(null)).toBeNull();
  });

  test('stille Aufnahme bleibt sichtbar (Stufe 1)', () => {
    expect(encodeWave(new Array(40).fill(-160))).toBe('1'.repeat(WAVE_BARS));
  });

  test('Empfang: nur gueltige Wellenformen werden uebernommen', () => {
    expect(sanitizeWave('0123456789ABCDEFGHIJKLMNOPQRSTUV')).toBe('0123456789ABCDEFGHIJKLMNOPQRSTUV');
    for (const bad of [undefined, null, 42, '', 'abc', 'W'.repeat(20), '0'.repeat(65), '0'.repeat(7),
      '<script>alert(1)</script>', '0123456789\n0123456789', { length: 20 }, ['A', 'B']]) {
      expect(sanitizeWave(bad)).toBeUndefined();
      expect(parseWave(bad)).toBeNull();
    }
  });

  test('Stufen 0..1 aus dem Text', () => {
    const lv = parseWave('0V' + 'G'.repeat(10));
    expect(lv[0]).toBe(0);
    expect(lv[1]).toBe(1);
    expect(lv[2]).toBeCloseTo(16 / 31);
  });

  test('Ersatzform: stabil je Nachricht, verschieden je Nachricht, im Bereich 0..1', () => {
    const a = fallbackLevels('m1');
    expect(fallbackLevels('m1')).toEqual(a);
    expect(fallbackLevels('m2')).not.toEqual(a);
    expect(a).toHaveLength(WAVE_BARS);
    for (const v of a) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(levelsFor({ id: 'm1' })).toEqual(a);
    expect(levelsFor({ id: 'm1', wave: 'V'.repeat(48) })).toEqual(new Array(48).fill(1));
  });

  test('resample: Maximum je Abschnitt bzw. Wiederholung', () => {
    expect(resample([0, 1, 0, 0.5], 2)).toEqual([1, 0.5]);
    expect(resample([0.2, 0.8], 4)).toEqual([0.2, 0.2, 0.8, 0.8]);
    expect(resample([], 3)).toEqual([0, 0, 0]);
  });
});

describe('Geometrie', () => {
  const lv = fallbackLevels('geo');

  test('Balken: Fortschritt teilt in abgespielt und Rest', () => {
    const none = barsPaths(lv, 160, 30, 0);
    const all = barsPaths(lv, 160, 30, 1);
    const half = barsPaths(lv, 160, 30, 0.5);
    const count = (d) => (d.match(/M/g) || []).length;
    expect(count(none.played)).toBe(0);
    expect(count(all.rest)).toBe(0);
    expect(count(none.rest)).toBe(count(all.played));
    expect(count(half.played) + count(half.rest)).toBe(count(none.rest));
    expect(Math.abs(count(half.played) - count(half.rest))).toBeLessThanOrEqual(1);
    // Alle Balken bleiben in der Hoehe
    for (const n of (none.rest.match(/[0-9.]+/g) || []).map(Number)) {
      expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(160);
    }
  });

  test('Pixel-Welle: Ausschlag folgt dem Pegel, Phase bewegt die Welle', () => {
    const loud = pixelWaveColumns(new Array(40).fill(1), 40, 9);
    const quiet = pixelWaveColumns(new Array(40).fill(0), 40, 9);
    const maxAbs = (a) => Math.max(...a.map(Math.abs));
    expect(maxAbs(loud)).toBe(4);              // halbe Hoehe bei vollem Pegel
    expect(maxAbs(quiet)).toBeLessThanOrEqual(1);
    expect(pixelWaveColumns(lv, 40, 9, 1)).not.toEqual(pixelWaveColumns(lv, 40, 9, 0));
    for (const v of pixelWaveColumns(lv, 40, 9, 2.3)) expect(Math.abs(v)).toBeLessThanOrEqual(4);
  });

  test('Pixel-Welle: Quadrate im Raster, Mittellinie immer sichtbar', () => {
    const { played, rest } = pixelPaths(lv, 160, 30, 0.25, 0.7);
    const cells = (played + rest).match(/M\d+ \d+h3v3h-3z/g) || [];
    expect(cells.length).toBe((played + rest).match(/M/g).length);
    const cols = new Set(cells.map((c) => c.match(/M(\d+)/)[1]));
    expect(cols.size).toBe(40);                // jede Spalte hat mindestens ein Quadrat
    for (const c of cells) {
      const [, x, y] = c.match(/M(\d+) (\d+)/).map(Number);
      expect(x % 4).toBe(0); expect(x).toBeLessThan(160);
      expect(y).toBeGreaterThanOrEqual(0); expect(y + 3).toBeLessThanOrEqual(30);
    }
  });
});

describe('Pegel-Verteiler waehrend der Aufnahme', () => {
  test('sammelt gueltige Werte, meldet sie, begrenzt die Menge', () => {
    const feed = createLevelFeed(5);
    const seen = [];
    const off = feed.subscribe((s) => seen.push(s.length));
    [-10, 'x', NaN, -20, -30, -40, -50, -60].forEach((v) => feed.push(v));
    expect(feed.samples()).toEqual([-20, -30, -40, -50, -60]);
    off();
    feed.push(-1);
    expect(seen).toEqual([1, 2, 3, 4, 5, 5]);
    feed.clear();
    expect(feed.samples()).toEqual([]);
  });
});

describe('Stil-Einstellung', () => {
  beforeEach(async () => { await EncryptedStorage.clear?.(); resetWaveStyleAfterWipe(); });

  test('Standard sind Balken; Pixel-Welle nur mit Vollversion wirksam', async () => {
    expect(waveStyleSetting()).toBe(DEFAULT_WAVE_STYLE);
    expect(await setWaveStyle('pixel')).toBe(true);
    expect(waveStyleSetting()).toBe('pixel');
    expect(effectiveWaveStyle(true)).toBe('pixel');
    expect(effectiveWaveStyle(false)).toBe('bars');
    expect(effectiveWaveStyle(undefined)).toBe('bars');
    expect(await EncryptedStorage.getItem(WAVE_STYLE_KEY)).toBe('pixel');
  });

  test('ungueltige Werte werden abgelehnt bzw. beim Laden ignoriert', async () => {
    expect(await setWaveStyle('rainbow')).toBe(false);
    await EncryptedStorage.setItem(WAVE_STYLE_KEY, 'rainbow');
    expect(await loadWaveStyle()).toBe('bars');
    await EncryptedStorage.setItem(WAVE_STYLE_KEY, 'pixel');
    expect(await loadWaveStyle()).toBe('pixel');
  });

  test('Abonnenten werden benachrichtigt; Wipe setzt zurueck', async () => {
    const seen = [];
    const off = subscribeWaveStyle((s) => seen.push(s));
    await setWaveStyle('pixel');
    resetWaveStyleAfterWipe();
    off();
    await setWaveStyle('pixel');
    expect(seen).toEqual(['pixel', 'bars']);
    // Zurueck auf Standard loescht den Eintrag (nichts Unnoetiges gespeichert)
    await setWaveStyle('bars');
    expect(await EncryptedStorage.getItem(WAVE_STYLE_KEY)).toBeNull();
  });
});
