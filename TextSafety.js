// TextSafety.js - Namen der Gegenseite (Kontakt-/Gruppen-/Mitgliedsnamen)
// ohne unsichtbare oder richtungsaendernde Zeichen (Audit 2026-10-19, G9).
//
// Bidi-Steuerzeichen (z.B. U+202E "rechts nach links") drehen die Anzeige um,
// Nullbreiten-Zeichen machen gleich aussehende, aber verschiedene Namen
// moeglich ("Alice" mit unsichtbarem Zeichen). Beides taugt zum Taeuschen.
// Der Unicode-Bidi-Algorithmus zeigt arabische/hebraeische Namen auch ohne
// diese Zeichen richtig an.

// Steuerzeichen, Bidi-Marken/-Overrides/-Isolates, Nullbreiten, Fuellzeichen.
// U+200D (ZWJ) wird gesondert behandelt: in Emoji-Folgen (👨‍👩‍👧) erlaubt.
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F­؜ᅟᅠ᠎​‌‎‏‪-‮⁠-⁩ㅤ﻿ﾠ]/g;

function stripLooseZwj(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '‍') {
      const prev = s.charCodeAt(i - 1);
      const next = s.charCodeAt(i + 1);
      const afterEmoji = (prev >= 0xDC00 && prev <= 0xDFFF) || prev === 0xFE0F || (prev >= 0x2600 && prev <= 0x27BF);
      const beforeEmoji = (next >= 0xD800 && next <= 0xDBFF) || (next >= 0x2600 && next <= 0x27BF);
      if (!(afterEmoji && beforeEmoji)) continue;
    }
    out += ch;
  }
  return out;
}

export function cleanDisplayName(v, max = 64) {
  if (typeof v !== 'string') return '';
  // Erst Leerraum (auch Zeilenumbruch/Tab) zu einem Leerzeichen, dann Unsichtbares weg.
  return stripLooseZwj(v.replace(/\s+/g, ' ').replace(INVISIBLE_RE, '')).replace(/ +/g, ' ').trim().slice(0, max);
}

// Fuer laengere Texte (Gruppenbeschreibung): Zeilenumbrueche bleiben.
export function cleanDisplayText(v, max = 500) {
  if (typeof v !== 'string') return '';
  return stripLooseZwj(v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ')
    .split('\n').map((l) => l.replace(INVISIBLE_RE, '')).join('\n')).trim().slice(0, max);
}
