/**
 * Malachi – ConnKeyV2.js  (Verbindungsschluessel v2, Krypto-Review 2026-10-25 V5)
 *
 * Bis 1.1 war das Geheimnis K jeder Verbindung das rohe ML-KEM-768-Geheimnis:
 * reines ML-KEM (kein X25519-Anteil), nicht an die Anmeldung gebunden (K-07),
 * und dasselbe rohe K diente als aeusserer Schluessel, Tor-Anmeldeschluessel,
 * Ratchet-Start, KEM-Beitrag im Root Key und Eingabe des Sicherheitscodes
 * (K-08). v2 (ausgehandelt ueber "kx: 2" im Kyber-Handshake):
 *
 *   T     = SHA-256( lp("malachi-kx-v2") ‖ lp("i-ek") ‖ lp(ek) ‖ lp("r-ct") ‖ lp(ct)
 *                    ‖ lp("i-x") ‖ lp(xI) ‖ lp("r-x") ‖ lp(xR)
 *                    ‖ lp("ck") ‖ lp(chainId) ‖ lp("ol") ‖ lp(ol) )
 *   C     = HKDF(chain, info = "malachi-kx-v2|chain", 32)   bzw. 32 Nullbytes ohne Kette
 *   ikm   = ss_MLKEM ‖ ss_X25519 ‖ C                          (je 32 Byte, feste Laengen)
 *   K_x   = HKDF-SHA256(ikm, salt = T, info = "malachi-kx-v2|" + zweck, 32)
 *           zweck: "outer" (aeussere Schicht, Tor-Anmeldung der naechsten
 *           Verbindung, Kettenglied), "ratchet-kem" (Ratchet-Start und
 *           KEM-Beitrag im Root Key), "legacy-code" (alter Verbindungscode)
 *
 * - X-Wing-artig: ein Angreifer muss ML-KEM-768 UND X25519 brechen; das
 *   Transkript bindet beide oeffentlichen Schluessel, das Chiffrat, die Rollen
 *   (Feldnamen), die Version und die Kette.
 * - Kette: chain = Geheimnis, mit dem sich diese Verbindung angemeldet hat
 *   (Tor-Anmeldung), das Geheimnis der Verbindung, ueber die sie ausgehandelt
 *   wurde (Direkt-Upgrade), bzw. der PSK der Einladung (Kopplung). Wer Tor/DTLS
 *   in Echtzeit bricht (kuenftiger Quantencomputer) und pk/ct austauscht, kennt
 *   C nicht und kommt nicht an K. chainId = HKDF(chain, "...|chain-id", 16)
 *   reist im Handshake, damit beide Seiten sicher dasselbe Kettenglied nehmen.
 * - Nur abgeleitete Teilschluessel werden benutzt und gespeichert, nie das
 *   rohe Geheimnis: wer den gespeicherten aeusseren Schluessel erbeutet, kennt
 *   den KEM-Beitrag des Ratchet nicht (behebt den Widerspruch in K-08).
 *
 * Nur geprueften Bibliotheken (@noble/curves, @noble/hashes); keine eigenen
 * Primitive. Reine Funktionen - Zustand und Aushandlung: WebRTCManager.js.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { Buffer } from 'buffer';

export const KX_V2 = 2;
const LABEL = 'malachi-kx-v2';
const utf8 = (s) => Uint8Array.from(Buffer.from(String(s), 'utf8'));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => Uint8Array.from(Buffer.from(String(s || ''), 'base64'));
const B64_32_RE = /^[A-Za-z0-9+/]{43}=$/;
const B64_16_RE = /^[A-Za-z0-9+/]{22}==$/;

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function lp(u8) {
  const n = u8.length;
  return concat(Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255), u8);
}

export const isX25519Pub = (s) => typeof s === 'string' && B64_32_RE.test(s);
export const isChainId = (s) => typeof s === 'string' && B64_16_RE.test(s);

/** Kennung eines Kettenglieds (Base64, 16 Byte) - gibt nichts ueber es preis. */
export function chainIdOf(chainB64) {
  const raw = unb64(chainB64);
  if (raw.length < 16) throw new Error('Kettenglied ungueltig');
  return b64(hkdf(sha256, raw, undefined, utf8(LABEL + '|chain-id'), 16));
}

/** Frisches X25519-Paar (rng: sichere Quelle, fail-closed). */
export async function newX25519(rng) {
  const sk = await rng(32);
  if (!(sk instanceof Uint8Array) || sk.length !== 32) throw new Error('Zufallsquelle ungueltig');
  return { sk, pk: b64(x25519.getPublicKey(sk)) };
}

/** X25519 - wirft bei Punkten kleiner Ordnung (noble) bzw. Nullergebnis. */
export function x25519Shared(sk, peerPkB64) {
  if (!isX25519Pub(peerPkB64)) throw new Error('X25519-Schluessel ungueltig');
  const out = x25519.getSharedSecret(sk, unb64(peerPkB64));
  if (out.every((b) => b === 0)) throw new Error('X25519-Ergebnis ungueltig');
  return out;
}

/**
 * Leitet die Teilschluessel einer v2-Verbindung ab. Alle Eingaben Base64
 * (ssM, ssX als Uint8Array); chain optional. -> { outer, kem, code, transcript }
 */
export function deriveConnKeysV2({ ssM, ssX, ek, ct, xI, xR, chain = null, ol = 1 }) {
  const m = ssM instanceof Uint8Array ? ssM : unb64(ssM);
  const x = ssX instanceof Uint8Array ? ssX : unb64(ssX);
  if (m.length !== 32 || x.length !== 32) throw new Error('Geheimnis ungueltig');
  const chainId = chain ? chainIdOf(chain) : '';
  const T = sha256(concat(
    lp(utf8(LABEL)),
    lp(utf8('i-ek')), lp(unb64(ek)),
    lp(utf8('r-ct')), lp(unb64(ct)),
    lp(utf8('i-x')), lp(unb64(xI)),
    lp(utf8('r-x')), lp(unb64(xR)),
    lp(utf8('ck')), lp(utf8(chainId)),
    lp(utf8('ol')), lp(utf8(String(ol))),
  ));
  const C = chain ? hkdf(sha256, unb64(chain), undefined, utf8(LABEL + '|chain'), 32) : new Uint8Array(32);
  const ikm = concat(m, x, C);
  const out = (purpose) => b64(hkdf(sha256, ikm, T, utf8(LABEL + '|' + purpose), 32));
  const res = { outer: out('outer'), kem: out('ratchet-kem'), code: out('legacy-code'), transcript: b64(T) };
  ikm.fill(0);
  C.fill(0);
  return res;
}
