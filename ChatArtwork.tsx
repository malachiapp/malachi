/**
 * Malachi – ChatArtwork.tsx
 *
 * Dekorative Ebene hinter dem Chatverlauf fuer Designs mit `artwork`
 * (Themes.js): "Malachi Artwork" (Tintenkleckse und Spritzer im Comic-Stil)
 * und seit Okt. 2026 neun weitere Muster (ARTWORK_KINDS) - Sternbild,
 * Synthwave, Papierschnitt, Bauhaus, Tiefsee, Kintsugi, Pixel-Tarn Wald und
 * Stadt, Leopard.
 *
 *  - Deterministisch: alle Formen werden EINMAL beim Laden des Moduls aus
 *    einem festen Startwert berechnet - kein Zufall pro Rendern, auf jedem
 *    Geraet dasselbe Bild.
 *  - Guenstig: eine einzige SVG mit einigen Dutzend bis gut 200 Formen (das
 *    Pixel-Tarnmuster: drei Pfade),
 *    React.memo - Tippen, neue Nachrichten und Scrollen zeichnen sie nicht neu
 *    (sie liegt ausserhalb der Liste, nur Thema/Farben aendern sie).
 *  - Nicht bedienbar: pointerEvents="none", fuer Screenreader ausgeblendet.
 *  - Kontrastarm: die Farben sind artworkFills (Themes.buildTheme) = Tinte nur
 *    zu ARTWORK_INK_SHARE in chatBg gemischt. Die Chatblasen bleiben deckend,
 *    ihre Schrift wird vom Muster nicht beruehrt.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';

/** Zeichenflaeche (Hochformat); "slice" skaliert sie deckend auf jede Bildschirmgroesse. */
export const ARTWORK_VIEWBOX = { width: 360, height: 760 };

// Kleiner deterministischer Zufallsgenerator (mulberry32) - nur fuer die
// einmalige Formberechnung beim Laden, fester Startwert.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (v) => Math.round(v * 10) / 10;

/** Geschlossene, weiche Kurve durch alle Punkte (Catmull-Rom -> kubische Bezier). */
function smoothClosedPath(pts) {
  const n = pts.length;
  let d = 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += 'C' + r1(c1x) + ' ' + r1(c1y) + ' ' + r1(c2x) + ' ' + r1(c2y) + ' ' + r1(p2[0]) + ' ' + r1(p2[1]);
  }
  return d + 'Z';
}

/** Punkte im Uhrzeigersinn (Bildschirm) - alle Teilpfade eines Kleckses gleich herum, sonst entstehen Loecher. */
function clockwise(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area >= 0 ? pts : pts.slice().reverse();
}

/**
 * Klecks-Muster: 8 Kleckse auf einem versetzten Raster (3 Spalten x 5 Zeilen,
 * schachbrettartig). Jeder Klecks = welliger Koerper + 3-5 Finger mit runder
 * Spitze (alles EIN Pfad), vor manchen Fingern ein Tropfen, dazu einzelne
 * Spritzer. Ergebnis: { blobs: [{ d, ink }], drops: [{ cx, cy, r, ink }] } -
 * ink ist der Index in die Tintenliste des Themas.
 */
export function buildSplatArt(seed = 0x5EA1A7) {
  const rnd = seeded(seed);
  const { width: W, height: H } = ARTWORK_VIEWBOX;
  const cols = 3, rows = 5, cw = W / cols, ch = H / rows;
  const cells = [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [1, 3], [0, 4], [2, 4]];
  const blobs = [];
  const drops = [];
  cells.forEach(([cx, cy], i) => {
    const x = cx * cw + cw / 2 + (rnd() - 0.5) * cw * 0.5;
    const y = cy * ch + ch / 2 + (rnd() - 0.5) * ch * 0.45;
    const r = 22 + rnd() * 16;
    // Koerper: welliger Kreis
    const n = 12;
    const body = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
      const rr = r * (0.82 + rnd() * 0.26);
      body.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
    }
    let d = smoothClosedPath(clockwise(body));
    // Finger: von innen nach aussen schmaler werdend, runde Spitze
    const fingers = 3 + Math.floor(rnd() * 3);
    const rot = rnd() * Math.PI * 2;
    for (let f = 0; f < fingers; f++) {
      const a = rot + (f / fingers) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
      const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
      const len = r * (1.35 + rnd() * 0.55);           // Abstand Mitte -> Spitze
      const tip = r * (0.16 + rnd() * 0.12);           // Radius der Spitze
      const base = r * (0.34 + rnd() * 0.12);          // halbe Breite am Koerper
      const bx = x + ux * r * 0.5, by = y + uy * r * 0.5;
      const tx = x + ux * len, ty = y + uy * len;
      const pts = [
        [bx + px * base, by + py * base],
        [x + ux * (len * 0.7) + px * tip * 1.05, y + uy * (len * 0.7) + py * tip * 1.05],
      ];
      for (let s = 0; s <= 4; s++) {                   // Halbkreis um die Spitze
        const t = Math.PI / 2 - (s / 4) * Math.PI;
        pts.push([tx + (ux * Math.cos(t) + px * Math.sin(t)) * tip, ty + (uy * Math.cos(t) + py * Math.sin(t)) * tip]);
      }
      pts.push([x + ux * (len * 0.7) - px * tip * 1.05, y + uy * (len * 0.7) - py * tip * 1.05]);
      pts.push([bx - px * base, by - py * base]);
      d += smoothClosedPath(clockwise(pts));
      // Tropfen vor dem Finger (nicht bei jedem)
      if (rnd() < 0.6) {
        const dist = len + tip + r * (0.25 + rnd() * 0.3);
        drops.push({ cx: r1(x + ux * dist), cy: r1(y + uy * dist), r: r1(tip * (0.6 + rnd() * 0.4)), ink: i });
      }
    }
    blobs.push({ d, ink: i });
  });
  // einzelne Spritzer zwischen den Klecksen
  for (let s = 0; s < 8; s++) {
    drops.push({ cx: r1(rnd() * W), cy: r1(rnd() * H), r: r1(2.5 + rnd() * 4.5), ink: Math.floor(rnd() * 5) });
  }
  // Graffiti-Laufnasen (Nutzerwunsch "die Tropfen"): von der Unterseite jedes
  // Kleckses 1-3 senkrecht herunterlaufende Farbstreifen mit rundem Ende und
  // einem abgeloesten Tropfen darunter - in der Tinte des Kleckses.
  const drips = [];
  blobs.forEach((b, i) => {
    const [cx, cy] = cells[i];
    const x0 = cx * cw + cw / 2, y0 = cy * ch + ch / 2;
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const w = 5 + rnd() * 6;                                   // Breite des Streifens
      const x = r1(x0 + (rnd() - 0.5) * 50);
      const top = r1(y0 + 10 + rnd() * 10);                     // beginnt im Klecks
      const bottom = r1(top + 40 + rnd() * 70);
      const hw = r1(w / 2);
      drips.push({ d: 'M' + r1(x - hw) + ' ' + top + 'L' + r1(x - hw) + ' ' + bottom
        + 'A' + hw + ' ' + hw + ' 0 0 0 ' + r1(x + hw) + ' ' + bottom + 'L' + r1(x + hw) + ' ' + top + 'Z', ink: b.ink });
      if (rnd() < 0.75) drops.push({ cx: x, cy: r1(bottom + w * 1.6 + rnd() * 8), r: r1(hw * (0.8 + rnd() * 0.3)), ink: b.ink });
    }
  });
  return { blobs, drops, drips };
}

/** Das Muster - einmal beim Laden berechnet, danach unveraendert. */
export const SPLAT_ART = buildSplatArt();

// ── Weitere Artwork-Muster (Okt. 2026, Nutzerwunsch "alle Designs") ─────────
//
// Gemeinsames Format: Liste von Formen, jede mit ink (Index in die Tinten des
// Themas) und genau einer Geometrie:
//   { d }          Pfad (gefuellt; mit sw: nur Kontur dieser Breite)
//   { c: [x,y,r] } Kreis (gefuellt; mit sw: Ring)
// optional o (Deckkraft 0..1). Alles einmal beim Laden berechnet.

const W0 = ARTWORK_VIEWBOX.width;
const H0 = ARTWORK_VIEWBOX.height;
const P = (pts) => 'M' + pts.map((q) => r1(q[0]) + ' ' + r1(q[1])).join('L');

// Vierzackiger Funkelstern (Kurven zur Mitte).
function sparkle(x, y, r) {
  const m = r1(x) + ' ' + r1(y);
  return 'M' + r1(x) + ' ' + r1(y - r) + 'Q' + m + ' ' + r1(x + r) + ' ' + r1(y)
    + 'Q' + m + ' ' + r1(x) + ' ' + r1(y + r)
    + 'Q' + m + ' ' + r1(x - r) + ' ' + r1(y)
    + 'Q' + m + ' ' + r1(x) + ' ' + r1(y - r) + 'Z';
}

/** Sternbild: Sternenstaub, Sternbilder (Knoten + Linien), Funkeln - eines ist das Malachi-M. */
export function buildStarsArt(seed = 0x5741A5) {
  const rnd = seeded(seed);
  const out = [];
  for (let i = 0; i < 70; i++) out.push({ c: [r1(rnd() * W0), r1(rnd() * H0), r1(0.5 + rnd() * 0.9)], ink: 3, o: r1(0.45 + rnd() * 0.55), g: 1 });
  const groups = [[40, 70], [215, 150], [30, 330], [200, 455], [50, 600], [215, 680]];
  groups.forEach(([gx, gy], g) => {
    const nodes = [];
    if (g === 3) {
      // Das Malachi-Zeichen: ein M aus Knoten und Linien (wie das Logo in der Kopfleiste)
      [[0, 46], [26, 0], [52, 34], [78, 0], [104, 46]].forEach(([x, y]) => nodes.push([gx + x, gy + y]));
    } else {
      const n = 4 + Math.floor(rnd() * 3);
      let x = gx, y = gy;
      for (let k = 0; k < n; k++) { nodes.push([x, y]); x += 16 + rnd() * 26; y += (rnd() - 0.45) * 56; }
    }
    const ink = g % 2;
    out.push({ d: P(nodes), ink, sw: 0.9, o: 0.75 });
    nodes.forEach(([x, y], k) => {
      out.push({ c: [r1(x), r1(y), r1(4.5 + rnd() * 2)], ink, o: 0.3 });            // Schein
      out.push({ c: [r1(x), r1(y), r1(1.7 + (k % 2) * 0.7 + rnd() * 0.6)], ink, g: 1 });
    });
  });
  for (let i = 0; i < 7; i++) out.push({ d: sparkle(14 + rnd() * (W0 - 28), 14 + rnd() * (H0 - 28), 4 + rnd() * 4), ink: 2, g: 1 });
  return out;
}

/** Synthwave: Sterne, gestreifte Sonne, Bergkette, perspektivisches Neon-Raster. */
export function buildSynthArt(seed = 0x5A7E77) {
  const rnd = seeded(seed);
  const out = [];
  const HZ = 420;                       // Horizont
  for (let i = 0; i < 45; i++) out.push({ c: [r1(rnd() * W0), r1(rnd() * (HZ - 160)), r1(0.5 + rnd() * 1)], ink: 1, o: r1(0.5 + rnd() * 0.5), g: 1 });
  // Sonne: waagerechte Scheiben, nach unten immer groessere Luecken
  const cx = 180, cy = HZ - 70, R = 100;
  const slice = (ya, yb) => {
    const pts = [];
    for (let s = 0; s <= 8; s++) { const yy = ya + ((yb - ya) * s) / 8; pts.push([cx + Math.sqrt(Math.max(0, R * R - (yy - cy) ** 2)), yy]); }
    for (let s = 8; s >= 0; s--) { const yy = ya + ((yb - ya) * s) / 8; pts.push([cx - Math.sqrt(Math.max(0, R * R - (yy - cy) ** 2)), yy]); }
    return P(pts) + 'Z';
  };
  out.push({ d: slice(cy - R, cy - 34), ink: 2 });
  out.push({ d: slice(cy - 30, cy - 8), ink: 2 });
  let y = cy - 4, k = 0;
  while (y < HZ - 6) {
    const h = Math.max(3, 12 - k * 1.5);
    const y2 = Math.min(y + h, HZ - 6);
    out.push({ d: slice(y, y2), ink: 0 });
    y = y2 + 3 + k * 1.6;
    k++;
  }
  // Bergkette am Horizont
  const ridge = [[-10, HZ]];
  for (let x = -10; x <= W0 + 10; x += 24) ridge.push([x, HZ - 18 - rnd() * 46]);
  ridge.push([W0 + 10, HZ]);
  out.push({ d: P(ridge) + 'Z', ink: 3 });
  out.push({ d: P([[-10, HZ], [W0 + 10, HZ]]), ink: 1, sw: 1.6 });
  // Raster: Waagerechte mit wachsendem Abstand, Strahlen aus dem Fluchtpunkt
  for (let i = 1; HZ + i * i * 5.5 < H0 + 10; i++) {
    const yy = HZ + i * i * 5.5;
    out.push({ d: P([[-10, yy], [W0 + 10, yy]]), ink: i % 2 ? 1 : 0, sw: 1 });
  }
  for (let x = -540; x <= W0 + 540; x += 60) out.push({ d: P([[cx, HZ], [x, H0 + 10]]), ink: 1, sw: 1 });
  return out;
}

// Geschlossene Welle zwischen der Wellenlinie bei y0 und dem Rand (oben bzw. unten).
function waveBand(y0, amp, freq, phase, toTop) {
  const pts = [];
  for (let x = -10; x <= W0 + 10; x += 10) pts.push([x, y0 + Math.sin((x / W0) * Math.PI * 2 * freq + phase) * amp]);
  const edge = toTop ? -10 : H0 + 10;
  return P([...pts, [W0 + 10, edge], [-10, edge]]) + 'Z';
}

/** Papierschnitt: Papierwellen oben und unten mit Schattenkante, dazwischen Konfetti. */
export function buildPaperArt(seed = 0x9A9E12) {
  const rnd = seeded(seed);
  const out = [];
  const bands = [
    [118, 14, 1.2, 0.4, true, 4], [78, 12, 1.6, 2.1, true, 2], [44, 10, 2.1, 4.0, true, 0],
    [560, 16, 1.1, 1.0, false, 3], [612, 14, 1.5, 2.6, false, 1], [664, 12, 1.9, 0.3, false, 0], [716, 10, 2.4, 3.3, false, 2],
  ];
  bands.forEach(([y0, amp, freq, phase, toTop, ink]) => {
    out.push({ d: waveBand(y0 + (toTop ? 4 : -4), amp, freq, phase, toTop), ink: 5 });   // Schatten der Papierkante
    out.push({ d: waveBand(y0, amp, freq, phase, toTop), ink });
  });
  for (let i = 0; i < 22; i++) {
    const x = 12 + rnd() * (W0 - 24), yy = 150 + rnd() * 380, r = 2 + rnd() * 3.5;
    out.push({ c: [r1(x), r1(yy), r1(r)], ink: Math.floor(rnd() * 5) });
  }
  return out;
}

/** Bauhaus: Kreise, Halb- und Viertelkreise, Quadrate, Dreiecke, Ringe, Streifen auf einem Raster. */
export function buildBauhausArt(seed = 0xBA0A05) {
  const rnd = seeded(seed);
  const out = [];
  const cols = 3, rows = 6, cw = W0 / cols, ch = H0 / rows;
  const kinds = ['circle', 'half', 'quarter', 'square', 'triangle', 'ring', 'stripes', 'dots'];
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      if ((cx + ry) % 2 === 1 && rnd() < 0.7) continue;      // luftig: nicht jede Zelle
      const x = cx * cw + cw / 2 + (rnd() - 0.5) * cw * 0.35;
      const y = ry * ch + ch / 2 + (rnd() - 0.5) * ch * 0.35;
      const s = 26 + rnd() * 16;
      const ink = rnd() < 0.15 ? 3 : Math.floor(rnd() * 3);
      const kind = kinds[Math.floor(rnd() * kinds.length)];
      const rot = Math.floor(rnd() * 4) * Math.PI / 2;
      const R = (px, py) => [x + px * Math.cos(rot) - py * Math.sin(rot), y + px * Math.sin(rot) + py * Math.cos(rot)];
      if (kind === 'circle') out.push({ c: [r1(x), r1(y), r1(s)], ink });
      else if (kind === 'ring') out.push({ c: [r1(x), r1(y), r1(s * 0.9)], ink, sw: 7 });
      else if (kind === 'half') {
        const pts = [];
        for (let a = 0; a <= 12; a++) pts.push(R(Math.cos((Math.PI * a) / 12) * s * 1.1, -Math.sin((Math.PI * a) / 12) * s * 1.1));
        out.push({ d: P(pts) + 'Z', ink });
      } else if (kind === 'quarter') {
        const pts = [R(-s, s)];
        for (let a = 0; a <= 8; a++) pts.push(R(-s + Math.cos(((Math.PI / 2) * a) / 8) * s * 2, s - Math.sin(((Math.PI / 2) * a) / 8) * s * 2));
        out.push({ d: P(pts) + 'Z', ink });
      } else if (kind === 'square') out.push({ d: P([R(-s * 0.8, -s * 0.8), R(s * 0.8, -s * 0.8), R(s * 0.8, s * 0.8), R(-s * 0.8, s * 0.8)]) + 'Z', ink });
      else if (kind === 'triangle') out.push({ d: P([R(0, -s), R(s * 0.95, s * 0.7), R(-s * 0.95, s * 0.7)]) + 'Z', ink });
      else if (kind === 'stripes') for (let i = -1; i <= 1; i++) out.push({ d: P([R(-s, i * 13), R(s, i * 13)]), ink, sw: 6 });
      else for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push({ c: [r1(x + i * 14), r1(y + j * 14), 3.2], ink });
    }
  }
  // zwei durchgehende Linien als Gliederung
  out.push({ d: P([[0, H0 * 0.31], [W0, H0 * 0.31]]), ink: 3, sw: 2.5 });
  out.push({ d: P([[W0 * 0.66, 0], [W0 * 0.66, H0]]), ink: 3, sw: 2.5 });
  return out;
}

/** Tiefsee: Leuchtpartikel mit Schein, Quallen mit Tentakeln, Luftblasen, Seegras. */
export function buildDeepSeaArt(seed = 0xDEE95E) {
  const rnd = seeded(seed);
  const out = [];
  for (let i = 0; i < 46; i++) {
    const x = rnd() * W0, y = rnd() * H0, ink = Math.floor(rnd() * 4), r = 0.8 + rnd() * 1.4;
    if (i % 3 === 0) out.push({ c: [r1(x), r1(y), r1(r * 5)], ink, o: 0.2 });
    out.push({ c: [r1(x), r1(y), r1(r)], ink, g: 1 });
  }
  [[78, 120, 26, 0], [262, 250, 20, 2], [110, 430, 22, 3], [270, 560, 28, 0]].forEach(([x, y, r, ink]) => {
    out.push({ c: [x, r1(y + r * 0.2), r1(r * 1.9)], ink, o: 0.14 });                  // Leuchten
    const dome = 'M' + (x - r) + ' ' + y + 'A' + r + ' ' + r1(r * 0.85) + ' 0 0 1 ' + (x + r) + ' ' + y
      + 'Q' + r1(x + r * 0.75) + ' ' + r1(y + r * 0.3) + ' ' + r1(x + r * 0.5) + ' ' + r1(y + r * 0.12)
      + 'Q' + r1(x + r * 0.25) + ' ' + r1(y + r * 0.32) + ' ' + x + ' ' + r1(y + r * 0.14)
      + 'Q' + r1(x - r * 0.25) + ' ' + r1(y + r * 0.32) + ' ' + r1(x - r * 0.5) + ' ' + r1(y + r * 0.12)
      + 'Q' + r1(x - r * 0.75) + ' ' + r1(y + r * 0.3) + ' ' + (x - r) + ' ' + y + 'Z';
    out.push({ d: dome, ink });
    for (let k = 0; k < 4; k++) {
      const tx = x - r * 0.6 + k * r * 0.4, len = r * (2 + rnd() * 1.4), y0 = y + r * 0.2;
      let d = 'M' + r1(tx) + ' ' + r1(y0);
      for (let s = 1; s <= 4; s++) d += 'Q' + r1(tx + (s % 2 ? 6 : -6)) + ' ' + r1(y0 + (len * (s - 0.5)) / 4) + ' ' + r1(tx) + ' ' + r1(y0 + (len * s) / 4);
      out.push({ d, ink, sw: 1.3, o: 0.85 });
    }
  });
  for (let i = 0; i < 12; i++) out.push({ c: [r1(20 + rnd() * (W0 - 40)), r1(200 + rnd() * 480), r1(2.5 + rnd() * 4.5)], ink: 1, sw: 1, o: 0.8 });
  [[30, 150], [70, 110], [330, 170]].forEach(([x, h]) => {
    let d = 'M' + x + ' ' + (H0 + 5);
    for (let s = 1; s <= 6; s++) d += 'Q' + (x + (s % 2 ? 12 : -12)) + ' ' + r1(H0 + 5 - (h * (s - 0.5)) / 6) + ' ' + x + ' ' + r1(H0 + 5 - (h * s) / 6);
    out.push({ d, ink: 0, sw: 3, o: 0.7 });
  });
  return out;
}

/** Kintsugi: verzweigte Risse in Gold, feine Haarrisse in Kupfer, kleine Goldtropfen an Knoten. */
export function buildKintsugiArt(seed = 0x6013D) {
  const rnd = seeded(seed);
  const out = [];
  const crack = (x, y, dir, steps, sw, ink, depth) => {
    const pts = [[x, y]];
    for (let s = 0; s < steps; s++) {
      dir += (rnd() - 0.5) * 0.9;
      const len = 14 + rnd() * 18;
      x += Math.cos(dir) * len; y += Math.sin(dir) * len;
      pts.push([x, y]);
      if (depth < 2 && rnd() < 0.28) {
        crack(x, y, dir + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6), 3 + Math.floor(rnd() * 4), sw * 0.55, depth === 0 ? 1 : 2, depth + 1);
        if (rnd() < 0.5) out.push({ c: [r1(x), r1(y), r1(sw * 1.1)], ink: 0 });
      }
    }
    out.push({ d: P(pts), ink, sw: r1(sw) });
  };
  crack(-10, 90, 0.35, 16, 2.4, 0, 0);
  crack(W0 + 10, 300, Math.PI - 0.25, 15, 2.2, 0, 0);
  crack(40, H0 + 10, -1.25, 14, 2.3, 0, 0);
  crack(-10, 520, -0.2, 14, 1.8, 0, 0);
  crack(250, -10, 1.75, 10, 1.6, 0, 0);
  for (let i = 0; i < 6; i++) crack(rnd() * W0, rnd() * H0, rnd() * Math.PI * 2, 3 + Math.floor(rnd() * 3), 0.6, 2, 2);
  return out;
}

// Glattes Wertrauschen (Gitter + Smoothstep), deterministisch.
function valueNoise(seed) {
  const rnd = seeded(seed);
  const N = 64, grid = [];
  for (let i = 0; i < N * N; i++) grid.push(rnd());
  const at = (x, y) => grid[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const sm = (v) => v * v * (3 - 2 * v);
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = sm(x - x0), fy = sm(y - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/**
 * Digitales Tarnmuster (Pixel-Tarn): Rauschen in drei Groessen auf einem groben
 * Pixelraster, in vier Toene geschnitten (der erste bleibt der Chat-
 * Hintergrund). Gleichfarbige Pixel einer Zeile werden zu einem Rechteck
 * zusammengefasst - je Ton EIN Pfad.
 */
export function buildPixelCamoArt(seed, cell = 8) {
  const n1 = valueNoise(seed), n2 = valueNoise(seed ^ 0x55AA), n3 = valueNoise(seed ^ 0x1234);
  const cols = Math.ceil(W0 / cell), rows = Math.ceil(H0 / cell);
  const v = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    v.push(0.55 * n1(x / 7, y / 7) + 0.3 * n2(x / 3.2, y / 3.2) + 0.15 * n3(x / 1.4, y / 1.4));
  }
  const sorted = v.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const cuts = [q(0.3), q(0.56), q(0.8)];
  const tone = (val) => (val < cuts[0] ? -1 : val < cuts[1] ? 0 : val < cuts[2] ? 1 : 2);
  const paths = ['', '', ''];
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      const tn = tone(v[y * cols + x]);
      let e = x + 1;
      while (e < cols && tone(v[y * cols + e]) === tn) e++;
      if (tn >= 0) paths[tn] += 'M' + x * cell + ' ' + y * cell + 'h' + (e - x) * cell + 'v' + cell + 'h-' + (e - x) * cell + 'Z';
      x = e;
    }
  }
  return paths.map((d, ink) => ({ d, ink })).filter((p) => p.d);
}

/**
 * Leopard: elliptische Rosetten aus 3-5 sichelfoermigen Fellflecken (in der
 * Mitte dicker, an den Enden spitz, unregelmaessiger Rand), oft mit
 * dunklerer Mitte; dazwischen kleine und mittlere Tupfen.
 */
export function buildLeopardArt(seed = 0x1E0FA2) {
  const rnd = seeded(seed);
  const out = [];
  const cols = 4, rows = 9, cw = W0 / cols, ch = H0 / rows;
  for (let ry = 0; ry < rows; ry++) for (let cx = 0; cx < cols; cx++) {
    const x = cx * cw + cw / 2 + (ry % 2 ? cw / 4 : -cw / 8) + (rnd() - 0.5) * cw * 0.4;
    const y = ry * ch + ch / 2 + (rnd() - 0.5) * ch * 0.4;
    const R = 13 + rnd() * 10;
    const ex = 0.85 + rnd() * 0.35, ey = 0.75 + rnd() * 0.3, tilt = rnd() * Math.PI;
    const at = (a, rr) => {
      const px = Math.cos(a) * rr * ex, py = Math.sin(a) * rr * ey;
      return [x + px * Math.cos(tilt) - py * Math.sin(tilt), y + px * Math.sin(tilt) + py * Math.cos(tilt)];
    };
    if (rnd() < 0.75) {
      const mid = [];
      for (let k = 0; k < 9; k++) mid.push(at((k / 9) * Math.PI * 2, R * (0.55 + rnd() * 0.15)));
      out.push({ d: smoothClosedPath(clockwise(mid)), ink: 1, o: 0.9 });          // Mitte (Tawny)
    }
    const parts = 3 + Math.floor(rnd() * 3);
    const rot = rnd() * Math.PI * 2;
    let a = rot;
    for (let k = 0; k < parts; k++) {
      const span = ((Math.PI * 2) / parts) * (0.55 + rnd() * 0.3);
      const a0 = a, a1 = a + span;
      a += (Math.PI * 2) / parts;
      const thick = 3.5 + rnd() * 4.5;
      const outer = [], inner = [];
      for (let s2 = 0; s2 <= 8; s2++) {
        const tt = s2 / 8, aa = a0 + (a1 - a0) * tt;
        const w = thick * (0.25 + 0.75 * Math.sin(tt * Math.PI)) * (0.85 + rnd() * 0.3);
        outer.push(at(aa, R + w / 2));
        inner.push(at(aa, R - w / 2));
      }
      out.push({ d: smoothClosedPath(clockwise([...outer, ...inner.reverse()])), ink: 0 });
    }
  }
  for (let i = 0; i < 46; i++) {
    const x = rnd() * W0, y = rnd() * H0, r = i < 12 ? 3.5 + rnd() * 3 : 1.4 + rnd() * 2.2;
    const pts = [];
    for (let k = 0; k < 8; k++) { const aa = (k / 8) * Math.PI * 2, rr = r * (0.7 + rnd() * 0.55); pts.push([x + Math.cos(aa) * rr, y + Math.sin(aa) * rr * 0.85]); }
    out.push({ d: smoothClosedPath(clockwise(pts)), ink: 0 });
  }
  return out;
}

/** Alle Artwork-Arten; 'splat' hat sein eigenes (aelteres) Format SPLAT_ART. */
export const ARTWORK_KINDS = ['splat', 'stars', 'synth', 'paper', 'bauhaus', 'deepsea', 'kintsugi', 'pixelwood', 'pixelurban', 'leopard'];

export const ART = {
  stars: buildStarsArt(),
  synth: buildSynthArt(),
  paper: buildPaperArt(),
  bauhaus: buildBauhausArt(),
  deepsea: buildDeepSeaArt(),
  kintsugi: buildKintsugiArt(),
  pixelwood: buildPixelCamoArt(0xF0E57, 8),
  pixelurban: buildPixelCamoArt(0x0B4A2, 7),
  leopard: buildLeopardArt(),
};

/**
 * Soll die Artwork-Ebene im Chat erscheinen? Nur bei einem Design mit
 * Artwork - nicht ueber einem eigenen Hintergrundbild und nie im Secret Chat.
 */
export function chatArtworkVisible(theme, { secretActive = false, customBg = null } = {}) {
  // Das Muster kommt mit dem Design automatisch (Nutzerwunsch: "soll was
  // Besonderes sein") - eine frueher gewaehlte Hintergrund-FARBE wird dabei
  // ignoriert; nur ein eigenes Foto geht vor.
  return !!(theme && ARTWORK_KINDS.includes(theme.artwork) && Array.isArray(theme.artworkFills) && theme.artworkFills.length > 0
    && !secretActive && !customBg);
}

function shapeEl(sh, i, fills, glints) {
  const pal = sh.g && Array.isArray(glints) && glints.length ? glints : fills;
  const col = pal[sh.ink % pal.length];
  const extra = sh.o !== undefined ? { opacity: sh.o } : {};
  if (sh.c) {
    const [cx, cy, r] = sh.c;
    return sh.sw
      ? <Circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={col} strokeWidth={sh.sw} {...extra} />
      : <Circle key={i} cx={cx} cy={cy} r={r} fill={col} {...extra} />;
  }
  return sh.sw
    ? <Path key={i} d={sh.d} fill="none" stroke={col} strokeWidth={sh.sw} strokeLinecap="round" strokeLinejoin="round" {...extra} />
    : <Path key={i} d={sh.d} fill={col} {...extra} />;
}

/**
 * Props: kind (ARTWORK_KINDS), fills (artworkFills des Themas), glints
 * (artworkGlints - hellere Farben nur fuer kleine Glanzpunkte), bg (optional:
 * deckende Grundfarbe darunter, sonst durchsichtig), testID.
 */
function ChatArtworkLayer({ kind, fills, glints, bg, testID }) {
  if (!ARTWORK_KINDS.includes(kind) || !Array.isArray(fills) || fills.length === 0) return null;
  const { width, height } = ARTWORK_VIEWBOX;
  return (
    <View pointerEvents="none" testID={testID || 'chat-artwork'}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, bg ? { backgroundColor: bg } : null]}>
      <Svg width="100%" height="100%" viewBox={'0 0 ' + width + ' ' + height} preserveAspectRatio="xMidYMid slice">
        {kind === 'splat' ? [
          ...(SPLAT_ART.drips || []).map((p, i) => <Path key={'r' + i} d={p.d} fill={fills[p.ink % fills.length]} />),
          ...SPLAT_ART.blobs.map((b, i) => <Path key={'b' + i} d={b.d} fill={fills[b.ink % fills.length]} />),
          ...SPLAT_ART.drops.map((c, i) => <Circle key={'d' + i} cx={c.cx} cy={c.cy} r={c.r} fill={fills[c.ink % fills.length]} />),
        ] : ART[kind].map((sh, i) => shapeEl(sh, i, fills, glints))}
      </Svg>
    </View>
  );
}

const sameLayer = (a, b) => a.kind === b.kind && a.bg === b.bg && a.testID === b.testID
  && (a.fills || []).join('|') === (b.fills || []).join('|') && (a.glints || []).join('|') === (b.glints || []).join('|');

const ChatArtwork = React.memo(ChatArtworkLayer, sameLayer);
export default ChatArtwork;
