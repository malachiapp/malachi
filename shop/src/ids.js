// Zufaellige Kennungen (Bestellnummer, Lizenz-ID, Wiederherstellungscode) aus dem CSPRNG.
// Crockford-Base32: gut abschreibbar (kein I, L, O, U), Gross-/Kleinschreibung egal.

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const BESTELLNUMMER_LAENGE = 16; // 80 Bit

function base32(bytes) {
  let bits = 0;
  let wert = 0;
  let aus = '';
  for (const b of bytes) {
    wert = (wert << 8) | b;
    bits += 8;
    while (bits >= 5) {
      aus += ALPHABET[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
    wert &= (1 << bits) - 1;
  }
  if (bits > 0) aus += ALPHABET[(wert << (5 - bits)) & 31];
  return aus;
}

export function bestellnummerErzeugen(zufall = randomBytes) {
  return base32(zufall(10));
}

/**
 * Normalisiert eine Eingabe (Bindestriche/Leerzeichen entfernen, Grossbuchstaben,
 * Crockford-Verwechslungen O->0, I/L->1). Gibt null zurueck, wenn die Eingabe
 * nicht exakt die erwartete Laenge und nur erlaubte Zeichen hat.
 */
export function normalisieren(eingabe, laenge) {
  if (typeof eingabe !== 'string' || eingabe.length > 64) return null;
  const s = eingabe
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== laenge) return null;
  for (const z of s) if (!ALPHABET.includes(z)) return null;
  return s;
}

/** "ABCDEFGH..." -> "ABCD-EFGH-..." zum Abschreiben. */
export function gruppieren(s) {
  return String(s).match(/.{1,4}/g).join('-');
}
