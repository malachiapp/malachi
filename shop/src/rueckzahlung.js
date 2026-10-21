// Pruefung von Rueckzahlungsadressen (Widerruf): Kunden nennen eine eigene
// Adresse, an die der Betreiber bereits eingegangene Betraege zurueckzahlt.
// Geprueft wird offline mit Pruefsumme, damit Tippfehler auffallen, bevor
// jemand Geld an eine ungueltige Adresse schicken muesste.
//
//   Monero  (Mainnet): Standard- (4…), Sub- (8…) und integrierte Adressen (4…, 106 Zeichen);
//                      Monero-Base58 in 8-Byte-Bloecken, Pruefsumme Keccak-256.
//   Bitcoin (Mainnet): P2PKH (1…), P2SH (3…), SegWit v0 (bc1q…, 20/32 Byte, bech32),
//                      Taproot (bc1p…, 32 Byte, bech32m).

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { bech32, bech32m, createBase58check } from '@scure/base';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_WERT = new Map([...B58].map((z, i) => [z, BigInt(i)]));
// Zeichen je Blockgroesse in Byte (0..8) - Monero-Base58.
const BLOCK_ZEICHEN = [0, 2, 3, 5, 6, 7, 9, 10, 11];

/** Monero-Base58 dekodieren (null bei ungueltiger Eingabe). */
export function moneroBase58Dekodieren(text) {
  if (typeof text !== 'string' || !text.length) return null;
  const volle = Math.floor(text.length / 11);
  const restZeichen = text.length % 11;
  const restBytes = BLOCK_ZEICHEN.indexOf(restZeichen);
  if (restBytes < 0) return null;
  const aus = new Uint8Array(volle * 8 + restBytes);
  const block = (teil, bytes, ziel) => {
    let n = 0n;
    for (const z of teil) {
      const w = B58_WERT.get(z);
      if (w === undefined) return false;
      n = n * 58n + w;
    }
    if (n >> BigInt(bytes * 8)) return false; // passt nicht in die Blockgroesse
    for (let i = bytes - 1; i >= 0; i--) {
      aus[ziel + i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return true;
  };
  for (let i = 0; i < volle; i++) if (!block(text.slice(i * 11, i * 11 + 11), 8, i * 8)) return null;
  if (restBytes && !block(text.slice(volle * 11), restBytes, volle * 8)) return null;
  return aus;
}

/** Monero-Base58 kodieren (fuer Tests und Testvektoren). */
export function moneroBase58Kodieren(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8) {
    const teil = bytes.slice(i, i + 8);
    let n = 0n;
    for (const b of teil) n = (n << 8n) | BigInt(b);
    let z = '';
    for (let k = 0; k < BLOCK_ZEICHEN[teil.length]; k++) {
      z = B58[Number(n % 58n)] + z;
      n /= 58n;
    }
    s += z;
  }
  return s;
}

// Mainnet-Praefixe (jeweils ein Byte als varint): 18 Standard, 19 integriert, 42 Subadresse.
const XMR_ARTEN = { 18: { art: 'standard', laenge: 69 }, 19: { art: 'integriert', laenge: 77 }, 42: { art: 'subadresse', laenge: 69 } };

/** Art einer gueltigen Monero-Mainnet-Adresse ('standard' | 'subadresse' | 'integriert') oder null. */
export function moneroAdressArt(adresse) {
  if (typeof adresse !== 'string' || (adresse.length !== 95 && adresse.length !== 106)) return null;
  const d = moneroBase58Dekodieren(adresse);
  if (!d) return null;
  const a = XMR_ARTEN[d[0]];
  if (!a || d.length !== a.laenge) return null;
  const pruef = keccak_256(d.subarray(0, d.length - 4)).subarray(0, 4);
  for (let i = 0; i < 4; i++) if (pruef[i] !== d[d.length - 4 + i]) return null;
  return a.art;
}

export const istMoneroAdresse = (a) => moneroAdressArt(a) !== null;

const base58check = createBase58check(sha256);

/** Gueltige Bitcoin-Mainnet-Adresse (mit Pruefsumme)? */
export function istBitcoinAdresse(adresse) {
  if (typeof adresse !== 'string' || adresse.length < 26 || adresse.length > 90) return false;
  if (/^(bc1|BC1)/.test(adresse)) {
    // bech32 erlaubt keine gemischte Schreibweise; reine Grossschreibung ist gueltig.
    if (adresse !== adresse.toLowerCase() && adresse !== adresse.toUpperCase()) return false;
    const a = adresse.toLowerCase();
    try {
      const { prefix, words } = bech32.decode(a, 90);
      if (prefix !== 'bc' || words[0] !== 0) return false;
      const programm = bech32.fromWords(words.slice(1));
      return programm.length === 20 || programm.length === 32;
    } catch {
      // kein bech32 (v0) - vielleicht bech32m (v1, Taproot)
    }
    try {
      const { prefix, words } = bech32m.decode(a, 90);
      return prefix === 'bc' && words[0] === 1 && bech32m.fromWords(words.slice(1)).length === 32;
    } catch {
      return false;
    }
  }
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(adresse)) return false;
  try {
    const d = base58check.decode(adresse);
    return d.length === 21 && (d[0] === 0x00 || d[0] === 0x05);
  } catch {
    return false;
  }
}

/** Rueckzahlungsadresse fuer eine Waehrung pruefen ('XMR' | 'BTC'). */
export function rueckzahlAdresseGueltig(waehrung, adresse) {
  if (waehrung === 'XMR') return istMoneroAdresse(adresse);
  if (waehrung === 'BTC') return istBitcoinAdresse(adresse);
  return false;
}
