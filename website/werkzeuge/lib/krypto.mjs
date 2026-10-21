// Update-Signierschluessel (Ed25519) - erzeugen, verschluesselt speichern,
// laden, signieren, pruefen. Nur Node-Bordmittel (node:crypto), keine
// Abhaengigkeiten: Ed25519 nach RFC 8032 ist deterministisch, die Signaturen
// sind identisch mit denen von @noble/curves (damit prueft die App).
//
// Der private Schluessel bleibt OFFLINE auf dem Rechner des Betreibers und
// kommt nie auf den Server. Er liegt in einer JSON-Datei, verschluesselt mit
// AES-256-GCM; der Schluessel dafuer kommt per scrypt (N=2^17, r=8, p=1 =
// 128 MiB) aus einer Passphrase. Der oeffentliche Schluessel steht im Klartext
// daneben und ist als Zusatzdaten (AAD) an das Chiffrat gebunden.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHLUESSEL_FORMAT = 'malachi-update-signierschluessel';
const SCHLUESSEL_VERSION = 1;
const AAD_PRAEFIX = 'malachi-update-signierschluessel-v1|';
// Feste DER-Vorspaenne fuer Ed25519 (RFC 8410): PKCS#8 (privat) und SPKI (oeffentlich).
const PKCS8_PRAEFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PRAEFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const MIN_PASSPHRASE = 12;
const SCRYPT_STANDARD = { N: 2 ** 17, r: 8, p: 1 };

export class KryptoFehler extends Error {}

// ---------------------------------------------------------------- Kodierungen

export function base64urlKodieren(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Streng: nur A-Z a-z 0-9 - _ , ohne Auffuellung, kanonisch. */
export function base64urlDekodieren(text, erwarteteLaenge) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new KryptoFehler('Kein gueltiges Base64url.');
  const buf = Buffer.from(text, 'base64url');
  if (buf.toString('base64url') !== text) throw new KryptoFehler('Base64url ist nicht kanonisch.');
  if (erwarteteLaenge !== undefined && buf.length !== erwarteteLaenge) {
    throw new KryptoFehler(`Erwartet ${erwarteteLaenge} Byte, erhalten ${buf.length}.`);
  }
  return buf;
}

/** Signaturdatei: Standard-Base64 (RFC 4648 Abschnitt 4, mit '='), danach genau ein LF. */
export function signaturDateiText(signatur) {
  return Buffer.from(signatur).toString('base64') + '\n';
}

export function signaturDateiLesen(text) {
  const kern = String(text).replace(/\r?\n$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(kern)) throw new KryptoFehler('Signaturdatei: erwartet 88 Zeichen Base64 (64 Byte).');
  const buf = Buffer.from(kern, 'base64');
  if (buf.length !== 64 || buf.toString('base64') !== kern) throw new KryptoFehler('Signaturdatei: ungueltiges Base64.');
  return buf;
}

export function oeffentlichPem(roh) {
  const der = Buffer.concat([SPKI_PRAEFIX, Buffer.from(roh)]);
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

// ---------------------------------------------------------------- Ed25519

export function privatAusSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new KryptoFehler('Seed muss 32 Byte lang sein.');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PRAEFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function oeffentlichRohAusPrivat(privat) {
  const der = crypto.createPublicKey(privat).export({ format: 'der', type: 'spki' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PRAEFIX)) throw new KryptoFehler('Unerwartetes Format des oeffentlichen Schluessels.');
  return Buffer.from(der.subarray(12));
}

export function oeffentlichAusRoh(roh) {
  if (!Buffer.isBuffer(roh) || roh.length !== 32) throw new KryptoFehler('Oeffentlicher Schluessel muss 32 Byte lang sein.');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PRAEFIX, roh]), format: 'der', type: 'spki' });
}

export function signieren(privat, daten) {
  return crypto.sign(null, Buffer.from(daten), privat);
}

export function pruefen(oeffentlichRoh, daten, signatur) {
  if (!Buffer.isBuffer(signatur) || signatur.length !== 64) return false;
  try {
    return crypto.verify(null, Buffer.from(daten), oeffentlichAusRoh(oeffentlichRoh), signatur);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Schluesseldatei

function kdf(passphrase, salz, { N, r, p }) {
  return crypto.scryptSync(Buffer.from(passphrase.normalize('NFC'), 'utf8'), salz, 32, {
    N, r, p, maxmem: 256 * N * r + 1024 * 1024,
  });
}

/**
 * Erzeugt ein neues Schluesselpaar und gibt den Inhalt der Schluesseldatei zurueck.
 * @param {string} passphrase
 * @param {{ seed?: Buffer, scrypt?: {N:number,r:number,p:number} }} [opt] - nur fuer Tests
 */
export function schluesseldateiErzeugen(passphrase, opt = {}) {
  if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) {
    throw new KryptoFehler(`Die Passphrase muss mindestens ${MIN_PASSPHRASE} Zeichen lang sein.`);
  }
  const seed = opt.seed || crypto.randomBytes(32);
  const roh = oeffentlichRohAusPrivat(privatAusSeed(seed));
  const parameter = opt.scrypt || SCRYPT_STANDARD;
  const salz = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const oeffentlich = base64urlKodieren(roh);
  const chiffre = crypto.createCipheriv('aes-256-gcm', kdf(passphrase, salz, parameter), nonce);
  chiffre.setAAD(Buffer.from(AAD_PRAEFIX + oeffentlich, 'utf8'));
  const daten = Buffer.concat([chiffre.update(seed), chiffre.final(), chiffre.getAuthTag()]);
  const inhalt = {
    format: SCHLUESSEL_FORMAT,
    version: SCHLUESSEL_VERSION,
    hinweis: 'Privater Update-Signierschluessel fuer Malachi. Offline aufbewahren, nie auf den Server kopieren.',
    oeffentlich,
    kdf: { name: 'scrypt', N: parameter.N, r: parameter.r, p: parameter.p, salz: base64urlKodieren(salz) },
    chiffre: { name: 'aes-256-gcm', nonce: base64urlKodieren(nonce), daten: base64urlKodieren(daten) },
  };
  return { text: JSON.stringify(inhalt, null, 2) + '\n', oeffentlichRoh: roh };
}

export function schluesseldateiLesen(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new KryptoFehler('Schluesseldatei ist kein gueltiges JSON.');
  }
  if (!d || d.format !== SCHLUESSEL_FORMAT || d.version !== SCHLUESSEL_VERSION) throw new KryptoFehler('Unbekanntes Format der Schluesseldatei.');
  if (!d.kdf || d.kdf.name !== 'scrypt' || !d.chiffre || d.chiffre.name !== 'aes-256-gcm') throw new KryptoFehler('Unbekannte Verfahren in der Schluesseldatei.');
  const { N, r, p } = d.kdf;
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 ** 14 || (N & (N - 1)) !== 0 || r < 1 || p < 1) {
    throw new KryptoFehler('Ungueltige scrypt-Parameter in der Schluesseldatei.');
  }
  return {
    oeffentlich: d.oeffentlich,
    oeffentlichRoh: base64urlDekodieren(d.oeffentlich, 32),
    salz: base64urlDekodieren(d.kdf.salz, 16),
    nonce: base64urlDekodieren(d.chiffre.nonce, 12),
    daten: base64urlDekodieren(d.chiffre.daten, 48),
    scrypt: { N, r, p },
  };
}

/** Entschluesselt die Schluesseldatei und gibt den privaten Schluessel (KeyObject) zurueck. */
export function schluesseldateiOeffnen(text, passphrase) {
  const s = schluesseldateiLesen(text);
  const entschl = crypto.createDecipheriv('aes-256-gcm', kdf(passphrase, s.salz, s.scrypt), s.nonce);
  entschl.setAAD(Buffer.from(AAD_PRAEFIX + s.oeffentlich, 'utf8'));
  entschl.setAuthTag(s.daten.subarray(32));
  let seed;
  try {
    seed = Buffer.concat([entschl.update(s.daten.subarray(0, 32)), entschl.final()]);
  } catch {
    throw new KryptoFehler('Falsche Passphrase oder beschaedigte Schluesseldatei.');
  }
  const privat = privatAusSeed(seed);
  seed.fill(0);
  if (!oeffentlichRohAusPrivat(privat).equals(s.oeffentlichRoh)) {
    throw new KryptoFehler('Schluesseldatei ist inkonsistent (oeffentlicher Schluessel passt nicht).');
  }
  return { privat, oeffentlichRoh: s.oeffentlichRoh };
}

export function schluesseldateiSchreiben(datei, text) {
  fs.mkdirSync(path.dirname(path.resolve(datei)), { recursive: true });
  fs.writeFileSync(datei, text, { mode: 0o600, flag: 'wx' });
}

// ---------------------------------------------------------------- Passphrase

/**
 * Liest eine Passphrase ohne Echo vom Terminal. Fuer Automatisierung (und
 * Tests) kann sie in MALACHI_UPDATE_PASSPHRASE stehen - das ist weniger
 * sicher (Umgebungsvariablen koennen in Prozesslisten/Protokollen landen).
 */
export async function passphraseLesen(frage) {
  if (process.env.MALACHI_UPDATE_PASSPHRASE) return process.env.MALACHI_UPDATE_PASSPHRASE;
  const ein = process.stdin;
  if (!ein.isTTY) throw new KryptoFehler('Keine Konsole fuer die Passphrase-Eingabe (oder MALACHI_UPDATE_PASSPHRASE setzen).');
  process.stderr.write(frage);
  return await new Promise((resolve, reject) => {
    let wert = '';
    ein.setRawMode(true);
    ein.resume();
    ein.setEncoding('utf8');
    const ende = (fehler) => {
      ein.setRawMode(false);
      ein.pause();
      ein.removeListener('data', weiter);
      process.stderr.write('\n');
      if (fehler) reject(fehler); else resolve(wert);
    };
    const weiter = (stueck) => {
      for (const z of stueck) {
        if (z === '\r' || z === '\n') return ende();
        if (z === '\u0003') return ende(new KryptoFehler('Abgebrochen.'));
        if (z === '\u0008' || z === '\u007f') wert = [...wert].slice(0, -1).join('');
        else if (z >= ' ') wert += z;
      }
    };
    ein.on('data', weiter);
  });
}
