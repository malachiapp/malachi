// Lizenzpruefung der Vollversion ("Pro") - App-Kopie der Referenz
// shop/src/lizenzpruefer.js (Spezifikation: shop/LIZENZ_FORMAT.md).
//
// 1:1 uebernommen. Einzige Abweichungen (rein technisch, keine Logikaenderung -
// __tests__/license.format.test.js vergleicht beide Dateien und schlaegt bei
// jeder anderen Abweichung fehl):
//   - Importpfade mit ".js": die App nutzt @noble/curves 2.x / @noble/hashes 2.x,
//     deren "exports"-Map nur Pfade mit Endung kennt (Metro und Jest loesen sie
//     so ohne Sonderregel auf). Der Shop nutzt noble 1.x - die hier genutzte API
//     (ed25519.verify mit zip215:false, sha256) ist in beiden Versionen gleich.
//   - Zahlen ohne Ziffern-Trennzeichen (1_600_000_000 -> 1600000000), damit
//     nichts von der Hermes-/Babel-Unterstuetzung dafuer abhaengt.
// Nicht direkt aus shop/ importiert: Metro wuerde sonst @noble/* aus
// shop/node_modules (noble 1.x) mit ins App-Bundle ziehen.
//
// ------------------------------------------------------------------ Referenz:
// Referenz-Implementierung der Lizenzpruefung (siehe LIZENZ_FORMAT.md).
//
// Diese Datei ist bewusst OHNE Node-spezifische APIs geschrieben (kein Buffer,
// kein node:crypto), damit sie 1:1 in die App (React Native, @noble/curves)
// uebernommen werden kann. Abhaengigkeiten: @noble/curves (ed25519) und
// @noble/hashes (sha256).

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const LIZENZ_PRAEFIX = 'ML1';
export const LIZENZ_VERSION = 1;
export const GERAETECODE_LAENGE = 34;
export const MAX_LIZENZ_LAENGE = 1024;

const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ID_MUSTER = /^[0-9A-HJKMNP-TV-Z]{16}$/; // Crockford-Base32, 16 Zeichen
const FEATURE_MUSTER = /^[a-z][a-z0-9_-]{0,31}$/;

// ------------------------------------------------------------------ Kodierungen

/** Bytes aus einem reinen ASCII-Text (andere Zeichen sind ein Fehler). */
export function asciiBytes(text) {
  const b = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7e || c < 0x20) throw new Error('Nur druckbares ASCII erlaubt');
    b[i] = c;
  }
  return b;
}

export function bytesAlsAscii(bytes) {
  let s = '';
  for (const c of bytes) {
    if (c > 0x7e || c < 0x20) throw new Error('Nur druckbares ASCII erlaubt');
    s += String.fromCharCode(c);
  }
  return s;
}

/** RFC 4648 Base32, Grossbuchstaben, ohne Auffuellzeichen. */
export function base32(bytes) {
  let bits = 0;
  let wert = 0;
  let aus = '';
  for (const b of bytes) {
    wert = ((wert << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      aus += RFC4648[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) aus += RFC4648[(wert << (5 - bits)) & 31];
  return aus;
}

/** Base64url (RFC 4648 Abschnitt 5) ohne Auffuellzeichen. */
export function base64urlKodieren(bytes) {
  let aus = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    aus += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    aus += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    aus += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return aus;
}

/** Strenges Base64url-Dekodieren: nur kanonische Kodierungen ohne Auffuellzeichen werden akzeptiert. */
export function base64urlDekodieren(text) {
  if (typeof text !== 'string' || text.length % 4 === 1) throw new Error('Ungueltiges Base64url');
  const werte = [];
  for (const z of text) {
    const v = B64URL.indexOf(z);
    if (v < 0) throw new Error('Ungueltiges Base64url');
    werte.push(v);
  }
  const aus = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < werte.length; i += 4) {
    const n = (werte[i] << 18) | (werte[i + 1] << 12) | ((werte[i + 2] ?? 0) << 6) | (werte[i + 3] ?? 0);
    aus[o++] = (n >> 16) & 255;
    if (i + 2 < werte.length) aus[o++] = (n >> 8) & 255;
    if (i + 3 < werte.length) aus[o++] = n & 255;
  }
  if (base64urlKodieren(aus) !== text) throw new Error('Nicht-kanonisches Base64url');
  return aus;
}

// ------------------------------------------------------------------ Geraetecode

/**
 * Geraetecode aus dem oeffentlichen Geraeteschluessel (SubjectPublicKeyInfo, DER).
 *   kern  = base32(SHA-256(spki)[0..20])                    -> 32 Zeichen
 *   pruef = base32(SHA-256("MALACHI-GERAET|" + kern)[0..5])[0..2] -> 2 Zeichen
 *   code  = kern + pruef                                     -> 34 Zeichen
 */
export function geraetecodeAusSpki(spkiDer) {
  if (!(spkiDer instanceof Uint8Array) || spkiDer.length < 32) throw new Error('SPKI erwartet');
  const kern = base32(sha256(spkiDer).subarray(0, 20));
  return kern + pruefzeichen(kern);
}

function pruefzeichen(kern) {
  return base32(sha256(asciiBytes('MALACHI-GERAET|' + kern)).subarray(0, 5)).slice(0, 2);
}

/**
 * Normalisiert eine Eingabe (Leerzeichen/Bindestriche weg, Grossbuchstaben) und prueft die Pruefzeichen.
 * Base32 kennt keine 0, 1 und 8 - abgetippte Verwechslungen (0/O, 1/I, 8/B) werden
 * zurueckgefuehrt; die Pruefzeichen sichern das Ergebnis ab.
 */
export function geraetecodeNormalisieren(eingabe) {
  if (typeof eingabe !== 'string' || eingabe.length > 80) return null;
  const s = eingabe.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (!/^[A-Z2-7]{34}$/.test(s)) return null;
  return pruefzeichen(s.slice(0, 32)) === s.slice(32) ? s : null;
}

/** "ABCD-EFGH-...-XY" zur Anzeige. */
export function geraetecodeGruppieren(code) {
  return code.match(/.{1,4}/g).join('-');
}

// ------------------------------------------------------------------ Kanonisches JSON

/**
 * Kanonische JSON-Serialisierung fuer Lizenzdaten:
 * Objekte mit lexikographisch sortierten Schluesseln, keine Leerzeichen,
 * nur nicht-negative ganze Zahlen (<= 2^53-1), Texte nur aus druckbarem
 * ASCII ohne " und \ (dadurch nie Escape-Sequenzen), Arrays in gegebener Reihenfolge.
 */
export function kanonischesJson(wert) {
  if (typeof wert === 'string') {
    if (!/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(wert)) throw new Error('Text mit unerlaubten Zeichen');
    return '"' + wert + '"';
  }
  if (typeof wert === 'number') {
    if (!Number.isSafeInteger(wert) || wert < 0) throw new Error('Nur nicht-negative ganze Zahlen');
    return String(wert);
  }
  if (Array.isArray(wert)) return '[' + wert.map(kanonischesJson).join(',') + ']';
  if (wert && typeof wert === 'object') {
    const schluessel = Object.keys(wert).sort();
    return '{' + schluessel.map((k) => kanonischesJson(k) + ':' + kanonischesJson(wert[k])).join(',') + '}';
  }
  throw new Error('Nicht unterstuetzter Wert');
}

/** Prueft die Lizenzdaten auf exakt die erwarteten Felder und Formate. */
export function lizenzdatenPruefen(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'kein Objekt';
  const felder = Object.keys(d).sort().join(',');
  if (felder !== 'dev,feat,iat,lic,ord,v') return 'falsche Felder';
  if (d.v !== LIZENZ_VERSION) return 'unbekannte Version';
  if (typeof d.lic !== 'string' || !ID_MUSTER.test(d.lic)) return 'lic ungueltig';
  if (typeof d.ord !== 'string' || !ID_MUSTER.test(d.ord)) return 'ord ungueltig';
  if (typeof d.dev !== 'string' || geraetecodeNormalisieren(d.dev) !== d.dev) return 'dev ungueltig';
  if (!Number.isSafeInteger(d.iat) || d.iat < 1600000000 || d.iat > 9999999999) return 'iat ungueltig';
  if (!Array.isArray(d.feat) || d.feat.length < 1 || d.feat.length > 16) return 'feat ungueltig';
  for (let i = 0; i < d.feat.length; i++) {
    if (typeof d.feat[i] !== 'string' || !FEATURE_MUSTER.test(d.feat[i])) return 'feat ungueltig';
    if (i > 0 && !(d.feat[i - 1] < d.feat[i])) return 'feat nicht sortiert/eindeutig';
  }
  return null;
}

// ------------------------------------------------------------------ Pruefung

/** Signierter Teil einer Lizenz: "ML1." + base64url(kanonisches JSON). */
export function signierterTeil(daten) {
  const fehler = lizenzdatenPruefen(daten);
  if (fehler) throw new Error('Lizenzdaten: ' + fehler);
  return LIZENZ_PRAEFIX + '.' + base64urlKodieren(asciiBytes(kanonischesJson(daten)));
}

/**
 * Prueft eine Lizenz vollstaendig lokal.
 * @param {string} lizenz  "ML1.<payload>.<signatur>"
 * @param {object} o
 * @param {Uint8Array[]} o.oeffentlicheSchluessel  eingebaute Ed25519-Schluessel (je 32 Byte)
 * @param {string} [o.geraetecode]  eigener Geraetecode; ohne Angabe wird die Bindung nicht geprueft
 * @param {string} [o.feature]      benoetigtes Feature (Standard "pro")
 * @returns {{gueltig: true, daten: object} | {gueltig: false, grund: string}}
 */
export function pruefeLizenz(lizenz, { oeffentlicheSchluessel, geraetecode, feature = 'pro' }) {
  const nein = (grund) => ({ gueltig: false, grund });
  if (typeof lizenz !== 'string' || lizenz.length > MAX_LIZENZ_LAENGE) return nein('format');
  const text = lizenz.trim();
  const teile = text.split('.');
  if (teile.length !== 3 || teile[0] !== LIZENZ_PRAEFIX) return nein('format');
  let nutzdaten;
  let signatur;
  try {
    nutzdaten = base64urlDekodieren(teile[1]);
    signatur = base64urlDekodieren(teile[2]);
  } catch {
    return nein('kodierung');
  }
  if (signatur.length !== 64) return nein('kodierung');

  // 1. Signatur ueber die exakt uebertragenen Bytes "ML1.<payload>"
  const nachricht = asciiBytes(teile[0] + '.' + teile[1]);
  let signaturOk = false;
  for (const schluessel of oeffentlicheSchluessel) {
    try {
      if (ed25519.verify(signatur, nachricht, schluessel, { zip215: false })) {
        signaturOk = true;
        break;
      }
    } catch {
      /* naechsten Schluessel versuchen */
    }
  }
  if (!signaturOk) return nein('signatur');

  // 2. Inhalt: gueltiges, kanonisches JSON mit genau den erwarteten Feldern
  let daten;
  let json;
  try {
    json = bytesAlsAscii(nutzdaten);
    daten = JSON.parse(json);
  } catch {
    return nein('inhalt');
  }
  if (lizenzdatenPruefen(daten)) return nein('inhalt');
  if (kanonischesJson(daten) !== json) return nein('nicht-kanonisch');

  // 3. Bindung an dieses Geraet und Feature
  if (geraetecode !== undefined && daten.dev !== geraetecode) return nein('anderes-geraet');
  if (!daten.feat.includes(feature)) return nein('feature');
  return { gueltig: true, daten };
}
