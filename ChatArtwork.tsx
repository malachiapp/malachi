/**
 * Malachi – ChatArtwork.tsx
 *
 * Dekorative Ebene hinter dem Chatverlauf fuer Designs mit `artwork`
 * (Themes.js) - bisher nur 'splat' ("Malachi Artwork"): Tintenkleckse und
 * Spritzer im Comic-Stil.
 *
 *  - Deterministisch: alle Formen werden EINMAL beim Laden des Moduls aus
 *    einem festen Startwert berechnet - kein Zufall pro Rendern, auf jedem
 *    Geraet dasselbe Bild.
 *  - Guenstig: eine einzige SVG mit rund 40 Formen (8 Pfade, gut 30 Kreise),
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

/**
 * Soll die Artwork-Ebene im Chat erscheinen? Nur bei einem Design mit
 * Artwork - nicht ueber einem eigenen Hintergrundbild, nicht bei gewaehlter
 * Chat-Hintergrund-Voreinstellung (Nutzerwahl geht vor) und nie im Secret Chat.
 */
export function chatArtworkVisible(theme, { secretActive = false, customBg = null } = {}) {
  // Das Muster kommt mit dem Design automatisch (Nutzerwunsch: "soll was
  // Besonderes sein") - eine frueher gewaehlte Hintergrund-FARBE wird dabei
  // ignoriert; nur ein eigenes Foto geht vor.
  return !!(theme && theme.artwork === 'splat' && Array.isArray(theme.artworkFills) && theme.artworkFills.length > 0
    && !secretActive && !customBg);
}

/**
 * Props: kind ('splat'), fills (artworkFills des Themas), bg (optional:
 * deckende Grundfarbe darunter, sonst durchsichtig), testID.
 */
function ChatArtworkLayer({ kind, fills, bg, testID }) {
  if (kind !== 'splat' || !Array.isArray(fills) || fills.length === 0) return null;
  const { width, height } = ARTWORK_VIEWBOX;
  return (
    <View pointerEvents="none" testID={testID || 'chat-artwork'}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, bg ? { backgroundColor: bg } : null]}>
      <Svg width="100%" height="100%" viewBox={'0 0 ' + width + ' ' + height} preserveAspectRatio="xMidYMid slice">
        {(SPLAT_ART.drips || []).map((p, i) => <Path key={'r' + i} d={p.d} fill={fills[p.ink % fills.length]} />)}
        {SPLAT_ART.blobs.map((b, i) => <Path key={'b' + i} d={b.d} fill={fills[b.ink % fills.length]} />)}
        {SPLAT_ART.drops.map((c, i) => <Circle key={'d' + i} cx={c.cx} cy={c.cy} r={c.r} fill={fills[c.ink % fills.length]} />)}
      </Svg>
    </View>
  );
}

const sameLayer = (a, b) => a.kind === b.kind && a.bg === b.bg && a.testID === b.testID
  && (a.fills || []).join('|') === (b.fills || []).join('|');

const ChatArtwork = React.memo(ChatArtworkLayer, sameLayer);
export default ChatArtwork;
