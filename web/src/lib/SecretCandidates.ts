// Malachi Web - SecretCandidates.ts
// Gegenstueck zu encryptOfferForCandidates()/offerCiphertexts()/
// decryptWithCandidates() in BackgroundSync.js (nativ, Audit 2026-09-28):
// nach einem im falschen Moment abgerissenen Kyber-Schluesselwechsel haben
// beide Seiten evtl. verschiedene Shared Secrets. Reconnect-Angebote und
// Relay-Pakete werden deshalb gegen ALLE aktuell gueltigen Kandidaten
// (aktuelles + noch unbestaetigtes vorheriges Secret) probiert.
import { encryptMsg, decryptMsg } from './MessageCrypto';

export async function encryptOfferForCandidates(plaintext: string, candidates: string[]): Promise<string | null> {
  const encs: string[] = [];
  for (const secret of candidates) {
    const enc = await encryptMsg(plaintext, secret, 'reconnect');
    if (enc) encs.push(enc);
  }
  if (encs.length === 0) return null;
  // Nur mit echtem zweiten Kandidaten das erweiterte Format - sonst
  // bit-identisch zum alten Einzel-Format (Kompatibilitaet).
  return encs.length === 1 ? encs[0] : JSON.stringify({ v: 2, c: encs });
}

export function offerCiphertexts(raw: string | null): string[] {
  if (typeof raw !== 'string') return [];
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      if (o?.v === 2 && Array.isArray(o.c)) return o.c.filter((x: unknown) => typeof x === 'string').slice(0, 4);
    } catch { /* ungueltig */ }
    return [];
  }
  return [raw];
}

export function decryptWithCandidates(
  ciphertexts: string[],
  candidates: string[],
  purpose?: string,
): { plain: string; secret: string } | null {
  for (const c of ciphertexts) {
    for (const secret of candidates) {
      const plain = decryptMsg(c, secret, purpose);
      if (plain) return { plain, secret };
    }
  }
  return null;
}
