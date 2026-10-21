// Serverseitiges Signieren von Lizenznachweisen (Ed25519, siehe LIZENZ_FORMAT.md).
// Der private Lizenzschluessel liegt nur auf dem Server; die App kennt nur den
// oeffentlichen Schluessel und prueft lokal.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { signierterTeil, base64urlKodieren, base64urlDekodieren, pruefeLizenz } from './lizenzpruefer.js';
import { geheimnisPfad, rechteEngGenug } from './geheimnisse.js';

/** RFC 8032, Abschnitt 7.1, TEST 1 - allgemein bekannt, NUR fuer Tests und Testvektoren. */
export const TESTSCHLUESSEL = Object.freeze({
  privatSeedHex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  oeffentlichHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
});

const PKCS8_ED25519_PRAEFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class LizenzSchluesselFehler extends Error {}

/** Privater Schluessel aus einem 32-Byte-Seed (nur fuer Tests/Testvektoren). */
export function privatAusSeed(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) throw new Error('Seed muss 32 Byte haben');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PRAEFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Rohe 32 Byte des oeffentlichen Schluessels. */
export function oeffentlichRoh(privaterSchluessel) {
  const jwk = crypto.createPublicKey(privaterSchluessel).export({ format: 'jwk' });
  return Uint8Array.from(base64urlDekodieren(jwk.x));
}

/** Erzeugt ein neues Schluesselpaar. Rueckgabe: { privatPem, oeffentlichRoh } */
export function schluesselpaarErzeugen() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    oeffentlichRoh: oeffentlichRoh(privateKey),
  };
}

/**
 * Laedt den privaten Lizenzschluessel (PKCS#8-PEM). Prueft Typ und Dateirechte
 * (unter Linux: keine Rechte fuer Gruppe/andere) und weist den RFC-8032-Testschluessel
 * im Normalbetrieb ab.
 */
export function lizenzschluesselLaden(angabe, { erlaubeTestschluessel = false } = {}) {
  const pfad = geheimnisPfad(angabe);
  let st;
  try {
    st = fs.statSync(pfad);
  } catch (e) {
    throw new LizenzSchluesselFehler(`Lizenzschluessel nicht lesbar: ${pfad} (${e.code || e.message})`);
  }
  if (!rechteEngGenug(pfad, st)) {
    throw new LizenzSchluesselFehler(`Lizenzschluessel ${pfad} hat zu weite Dateirechte (${(st.mode & 0o777).toString(8)}). Erlaubt: 600 oder 400.`);
  }
  let schluessel;
  try {
    schluessel = crypto.createPrivateKey(fs.readFileSync(pfad));
  } catch {
    throw new LizenzSchluesselFehler('Lizenzschluessel ist kein gueltiger privater Schluessel (PKCS#8-PEM erwartet).');
  }
  if (schluessel.asymmetricKeyType !== 'ed25519') throw new LizenzSchluesselFehler('Lizenzschluessel muss vom Typ Ed25519 sein.');
  const roh = oeffentlichRoh(schluessel);
  if (Buffer.from(roh).toString('hex') === TESTSCHLUESSEL.oeffentlichHex && !erlaubeTestschluessel) {
    throw new LizenzSchluesselFehler('Das ist der oeffentlich bekannte RFC-8032-Testschluessel. Bitte mit "npm run lizenzschluessel" einen eigenen erzeugen.');
  }
  return schluessel;
}

/** Signiert eine Lizenz. */
export function lizenzSignieren(privaterSchluessel, { lic, dev, ord, iat, feat = ['pro'] }) {
  const teil = signierterTeil({ v: 1, lic, dev, feat, iat, ord });
  const signatur = crypto.sign(null, Buffer.from(teil, 'ascii'), privaterSchluessel);
  return teil + '.' + base64urlKodieren(signatur);
}

/** Pruefung auf dem Server (z. B. Selbsttest beim Start). */
export function lizenzPruefenMitSchluessel(lizenz, privaterSchluessel, geraetecode) {
  return pruefeLizenz(lizenz, { oeffentlicheSchluessel: [oeffentlichRoh(privaterSchluessel)], geraetecode });
}
