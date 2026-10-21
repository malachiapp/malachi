// Taegliche verschluesselte Sicherung von Bestellungen und Buchhaltung.
//
// Verschluesselung mit oeffentlichem Schluessel (X25519 + HKDF-SHA256 + AES-256-GCM):
// Auf dem Server liegt nur der OEFFENTLICHE Sicherungsschluessel. Entschluesseln kann
// nur, wer den privaten Schluessel hat (offline beim Betreiber). Ein Angreifer mit
// Zugriff auf den Server kann alte Sicherungen also nicht lesen.
//
// Dateiformat: "MALBAK1\n" | ephemerer oeffentlicher Schluessel (32) | Nonce (12) |
//              Tag (16) | Chiffrat( gzip( JSON {format, erstellt, dateien{name: base64}} ) )

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIE = Buffer.from('MALBAK1\n', 'ascii');
const INFO = Buffer.from('malachi-sicherung-v1', 'ascii');

const rohOeffentlich = (schluessel) =>
  Buffer.from((schluessel.type === 'public' ? schluessel : crypto.createPublicKey(schluessel)).export({ format: 'jwk' }).x, 'base64url');
const oeffentlichAusRoh = (roh) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(roh).toString('base64url') }, format: 'jwk' });

/** Neues Schluesselpaar fuer Sicherungen. */
export function sicherungsSchluesselErzeugen() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { privatPem: privateKey.export({ format: 'pem', type: 'pkcs8' }), oeffentlich: rohOeffentlich(publicKey).toString('base64url') };
}

function schluesselAbleiten(geteilt, ephemer, empfaenger) {
  return Buffer.from(crypto.hkdfSync('sha256', geteilt, Buffer.concat([ephemer, empfaenger]), INFO, 32));
}

/** Verschluesselt `daten` fuer den Empfaenger (oeffentlicher X25519-Schluessel, base64url). */
export function verschluesseln(daten, empfaengerB64) {
  const empfaengerRoh = Buffer.from(empfaengerB64, 'base64url');
  if (empfaengerRoh.length !== 32) throw new Error('Sicherungsschluessel: 32 Byte (base64url) erwartet');
  const empfaenger = oeffentlichAusRoh(empfaengerRoh);
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRoh = rohOeffentlich(eph.publicKey);
  const geteilt = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: empfaenger });
  const schluessel = schluesselAbleiten(geteilt, ephRoh, empfaengerRoh);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel, nonce);
  c.setAAD(Buffer.concat([MAGIE, ephRoh]));
  const chiffrat = Buffer.concat([c.update(daten), c.final()]);
  return Buffer.concat([MAGIE, ephRoh, nonce, c.getAuthTag(), chiffrat]);
}

/** Entschluesselt eine Sicherung mit dem privaten Schluessel (PEM). */
export function entschluesseln(datei, privatPem) {
  if (datei.length < MAGIE.length + 60 || !datei.subarray(0, MAGIE.length).equals(MAGIE)) throw new Error('Keine Malachi-Sicherung');
  const privat = crypto.createPrivateKey(privatPem);
  const empfaengerRoh = rohOeffentlich(privat);
  let o = MAGIE.length;
  const ephRoh = datei.subarray(o, (o += 32));
  const nonce = datei.subarray(o, (o += 12));
  const tag = datei.subarray(o, (o += 16));
  const chiffrat = datei.subarray(o);
  const geteilt = crypto.diffieHellman({ privateKey: privat, publicKey: oeffentlichAusRoh(ephRoh) });
  const d = crypto.createDecipheriv('aes-256-gcm', schluesselAbleiten(geteilt, ephRoh, empfaengerRoh), nonce);
  d.setAAD(Buffer.concat([MAGIE, ephRoh]));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(chiffrat), d.final()]);
}

/** Packt Dateien (relativ zu `basis`) in ein gzip-komprimiertes JSON. */
export function packen(basis, dateien, jetzt = Date.now()) {
  const inhalt = { format: 1, erstellt: new Date(jetzt).toISOString(), dateien: {} };
  for (const rel of dateien) {
    const p = path.join(basis, rel);
    if (fs.existsSync(p)) inhalt.dateien[rel] = fs.readFileSync(p).toString('base64');
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(inhalt), 'utf8'));
}

export function auspacken(gepackt) {
  const inhalt = JSON.parse(zlib.gunzipSync(gepackt).toString('utf8'));
  if (inhalt.format !== 1) throw new Error('Unbekanntes Sicherungsformat');
  return inhalt;
}

/**
 * Erstellt die Sicherung des Tages (falls noch nicht vorhanden) und behaelt die letzten `behalten`.
 * @returns {Promise<string|null>} Pfad der neuen Sicherung oder null
 */
export async function taeglicheSicherung({ datenVerzeichnis, zielVerzeichnis, empfaenger, behalten = 30, jetzt = Date.now() }) {
  await fsp.mkdir(zielVerzeichnis, { recursive: true, mode: 0o700 });
  const tag = new Date(jetzt).toISOString().slice(0, 10);
  const ziel = path.join(zielVerzeichnis, `malachi-sicherung-${tag}.bin`);
  if (fs.existsSync(ziel)) return null;
  const bhVerzeichnis = path.join(datenVerzeichnis, 'buchhaltung');
  const journale = fs.existsSync(bhVerzeichnis) ? fs.readdirSync(bhVerzeichnis).filter((d) => d.endsWith('.jsonl')) : [];
  const dateien = ['bestellungen.json', 'verkauf-status.json', ...journale.map((d) => 'buchhaltung/' + d)];
  const daten = verschluesseln(packen(datenVerzeichnis, dateien, jetzt), empfaenger);
  const tmp = ziel + '.tmp';
  await fsp.writeFile(tmp, daten, { mode: 0o600 });
  await fsp.rename(tmp, ziel);
  const alle = fs.readdirSync(zielVerzeichnis).filter((d) => /^malachi-sicherung-\d{4}-\d{2}-\d{2}\.bin$/.test(d)).sort();
  for (const alt of alle.slice(0, Math.max(0, alle.length - behalten))) await fsp.unlink(path.join(zielVerzeichnis, alt)).catch(() => {});
  return ziel;
}
