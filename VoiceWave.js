// VoiceWave.js - Wellenform fuer Sprachnachrichten: Daten, Geometrie, Stil.
//
// Beim Aufnehmen meldet der Recorder alle 100 ms den Pegel (dBFS, -160..0;
// react-native-audio-recorder-player mit meteringEnabled). Daraus entstehen
// WAVE_BARS Stufen 0..31, kodiert als kurzer Text aus "0".."9","A".."V". Der
// Text reist im (Ratchet-)verschluesselten End-Marker der Sprachnachricht
// (AudioCrypto.js) und wird mit der Nachricht gespeichert - er verraet nur den
// Lautstaerkeverlauf, und auch den nur dem Empfaenger.
//
// Aeltere Nachrichten ohne Wellenform bekommen eine feste Ersatzform aus der
// Nachrichten-ID (gleiche Nachricht = gleiche Form).
//
// Zwei Darstellungen (VoiceWaveView.tsx), Nutzerwunsch 2026-10-25:
//   'bars'  - Balken aus dem echten Pegel (wie bei anderen Messengern)
//   'pixel' - eine Welle im Pixel-Look, deren Ausschlag dem Pegel folgt und die
//             sich beim Abspielen bewegt
// Beide verhalten sich gleich: abgespielter Teil in Akzentfarbe, Antippen
// springt an die Stelle. Der zweite Stil ist (vorerst) Teil der Vollversion.
import EncryptedStorage from 'react-native-encrypted-storage';

export const WAVE_BARS = 48;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUV';   // 32 Stufen
const WAVE_RE = /^[0-9A-V]{8,64}$/;
// Unterhalb davon gilt der Pegel als Stille (Raumrauschen am Handy-Mikrofon).
const SILENCE_DB = -50;

/** Pegel (dBFS) -> 0..1. */
export function levelFromDb(db) {
  const v = Number(db);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, (v - SILENCE_DB) / -SILENCE_DB));
}

/**
 * Pegelfolge (dBFS) -> Wellenform-Text mit `bars` Stufen. Normiert auf den
 * lautesten Abschnitt (leise Aufnahmen sind sonst kaum zu sehen); jeder Balken
 * hat mindestens Stufe 1. Ohne Messwerte: null.
 */
export function encodeWave(dbSamples, bars = WAVE_BARS) {
  const lv = (Array.isArray(dbSamples) ? dbSamples : []).map(levelFromDb);
  if (!lv.length) return null;
  const n = Math.max(8, Math.min(64, bars | 0));
  const pooled = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * lv.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * lv.length) / n));
    let m = 0;
    for (let j = a; j < b && j < lv.length; j++) m = Math.max(m, lv[j]);
    pooled.push(m);
  }
  const peak = Math.max(...pooled);
  return pooled.map((v) => ALPHABET[peak > 0 ? Math.max(1, Math.round((v / peak) * 31)) : 1]).join('');
}

/** Gueltiger Wellenform-Text oder undefined (fuer Empfang und Speicherung). */
export function sanitizeWave(text) {
  return typeof text === 'string' && WAVE_RE.test(text) ? text : undefined;
}

/** Wellenform-Text -> Stufen 0..1, oder null. */
export function parseWave(text) {
  if (!sanitizeWave(text)) return null;
  return [...text].map((c) => ALPHABET.indexOf(c) / 31);
}

/** Feste Ersatzform fuer Nachrichten ohne Wellenform. */
export function fallbackLevels(seed, bars = WAVE_BARS) {
  let h = 2166136261;
  for (const ch of String(seed || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [];
  let prev = 0.5;
  for (let i = 0; i < bars; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    const r = ((h >>> 0) % 1000) / 1000;
    prev = prev * 0.45 + (0.25 + r * 0.6) * 0.55;   // geglaettet wie Sprache
    out.push(prev);
  }
  return out;
}

/** Stufen einer Nachricht (echte Wellenform oder Ersatzform). */
export function levelsFor(item) {
  return parseWave(item?.wave) || fallbackLevels(String(item?.id ?? ''));
}

/** Auf n Werte bringen (Maximum je Abschnitt bzw. Wiederholung). */
export function resample(levels, n) {
  const src = Array.isArray(levels) && levels.length ? levels : [0];
  const count = Math.max(1, n | 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * src.length) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * src.length) / count));
    let m = 0;
    for (let j = a; j < b && j < src.length; j++) m = Math.max(m, src[j]);
    out.push(m);
  }
  return out;
}

// ── Geometrie (SVG-Pfade, je Farbe ein Pfad) ─────────────────────────────────

const BAR_W = 2.5;
const BAR_GAP = 1.5;
/** Balken: Pfade fuer den abgespielten und den restlichen Teil (Strich, runde Enden). */
export function barsPaths(levels, width, height, progress = 0) {
  const n = Math.max(1, Math.floor((width + BAR_GAP) / (BAR_W + BAR_GAP)));
  const lv = resample(levels, n);
  const cut = Math.round(Math.max(0, Math.min(1, progress)) * n);
  let played = '';
  let rest = '';
  const r = BAR_W / 2;
  for (let i = 0; i < n; i++) {
    const x = (i * (BAR_W + BAR_GAP) + r).toFixed(2);
    const h = Math.max(0, lv[i] * (height - BAR_W));
    const y1 = ((height - h) / 2).toFixed(2);
    const y2 = ((height + h) / 2).toFixed(2);
    const seg = `M${x} ${y1}V${y2}`;
    if (i < cut) played += seg; else rest += seg;
  }
  return { played, rest, strokeWidth: BAR_W };
}

const CELL = 4;   // Pixelraster: 3 px Quadrat + 1 px Abstand
/**
 * Pixel-Welle: je Spalte eine Sinus-Welle, deren Ausschlag dem Pegel folgt,
 * gerastert auf Quadrate (Mittellinie bleibt immer sichtbar). phase > 0
 * verschiebt die Welle (Animation beim Abspielen und Aufnehmen).
 */
export function pixelWaveColumns(levels, cols, rows, phase = 0, wavelength = 9) {
  const half = Math.floor(Math.max(1, rows) / 2);
  const lv = resample(levels, cols);
  const out = [];
  for (let x = 0; x < cols; x++) {
    const amp = Math.max(0.15, lv[x]);
    out.push(Math.round(half * amp * Math.sin((2 * Math.PI * x) / wavelength + phase)));
  }
  return out;
}

export function pixelPaths(levels, width, height, progress = 0, phase = 0) {
  const cols = Math.max(1, Math.floor(width / CELL));
  let rows = Math.max(3, Math.floor(height / CELL));
  if (rows % 2 === 0) rows -= 1;
  const half = Math.floor(rows / 2);
  const top = Math.floor((height - rows * CELL) / 2);
  const values = pixelWaveColumns(levels, cols, rows, phase);
  const cut = Math.round(Math.max(0, Math.min(1, progress)) * cols);
  const s = CELL - 1;
  let played = '';
  let rest = '';
  values.forEach((v, x) => {
    const from = Math.min(half, half - v);
    const to = Math.max(half, half - v);
    for (let row = from; row <= to; row++) {
      const cell = `M${x * CELL} ${top + row * CELL}h${s}v${s}h-${s}z`;
      if (x < cut) played += cell; else rest += cell;
    }
  });
  return { played, rest };
}

// ── Pegel waehrend der Aufnahme (fuer die Live-Anzeige) ──────────────────────
// Nur die Live-Anzeige bekommt die Messwerte zu sehen (eigener kleiner
// Verteiler statt React-State im Chat: der Chat muesste sonst 10x je Sekunde
// komplett neu zeichnen).
export function createLevelFeed(limit = 6000) {
  let samples = [];
  const listeners = new Set();
  return {
    push(db) {
      if (!Number.isFinite(Number(db))) return;
      samples.push(Number(db));
      if (samples.length > limit) samples = samples.slice(-limit);
      for (const l of [...listeners]) { try { l(samples); } catch {} }
    },
    samples() { return samples.slice(); },
    clear() { samples = []; for (const l of [...listeners]) { try { l(samples); } catch {} } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ── Gewaehlter Stil ──────────────────────────────────────────────────────────

export const WAVE_STYLES = ['bars', 'pixel'];
export const DEFAULT_WAVE_STYLE = 'bars';
export const WAVE_STYLE_KEY = 'voice_wave_style';
let stored = DEFAULT_WAVE_STYLE;
const styleListeners = new Set();
const notify = () => { for (const l of [...styleListeners]) { try { l(stored); } catch {} } };

export async function loadWaveStyle() {
  try {
    const v = await EncryptedStorage.getItem(WAVE_STYLE_KEY);
    stored = WAVE_STYLES.includes(v) ? v : DEFAULT_WAVE_STYLE;
  } catch { stored = DEFAULT_WAVE_STYLE; }
  notify();
  return stored;
}

export async function setWaveStyle(style) {
  if (!WAVE_STYLES.includes(style)) return false;
  stored = style;
  try {
    if (style === DEFAULT_WAVE_STYLE) await EncryptedStorage.removeItem(WAVE_STYLE_KEY);
    else await EncryptedStorage.setItem(WAVE_STYLE_KEY, style);
  } catch {}
  notify();
  return true;
}

/** Gespeicherte Wahl (fuer die Einstellungen). */
export function waveStyleSetting() { return stored; }

/** Tatsaechlich angezeigter Stil: ohne Vollversion immer der Standard. */
export function effectiveWaveStyle(pro) { return pro === true ? stored : DEFAULT_WAVE_STYLE; }

export function subscribeWaveStyle(fn) {
  styleListeners.add(fn);
  return () => { styleListeners.delete(fn); };
}

/** Wipe: Einstellung vergessen. */
export function resetWaveStyleAfterWipe() {
  stored = DEFAULT_WAVE_STYLE;
  notify();
}
