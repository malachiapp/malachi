// website/seite.json lesen und pruefen. Die Datei enthaelt nur OEFFENTLICHE
// Angaben (Onion-Adressen, Fingerabdruecke, oeffentlicher Update-Schluessel,
// SSH-Ziel) - keine Geheimnisse. Unbekannte Schluessel sind ein Fehler
// (Tippfehlerschutz); Schluessel mit _ am Anfang sind Kommentare.

import fs from 'node:fs';
import { base64urlDekodieren } from './krypto.mjs';
import { ABIS } from './manifest.mjs';

export class KonfigFehler extends Error {}

const ONION = /^[a-z2-7]{56}\.onion$/;
const SHA256 = /^[0-9a-f]{64}$/;

const STANDARD = {
  onionAdresse: '',
  shopOnion: '',
  applicationId: 'com.securecommapp',
  apkZertifikatSha256: '',
  updateSchluessel: '',
  minSupportedVersionCode: 1,
  abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
  hochladen: {
    ziel: 'malachiztrl@192.168.178.130',
    sshSchluessel: '~/.ssh/malachi_relay',
    eingang: '/var/lib/malachi-web/eingang',
    aktivieren: '/usr/local/sbin/malachi-web-aktivieren',
  },
};

function ohneKommentare(o) {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
}

export function konfigPruefen(roh) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new KonfigFehler('seite.json: Objekt erwartet.');
  const k = ohneKommentare(roh);
  for (const s of Object.keys(k)) if (!(s in STANDARD)) throw new KonfigFehler(`seite.json: unbekannter Schluessel "${s}".`);
  const h = ohneKommentare(k.hochladen || {});
  for (const s of Object.keys(h)) if (!(s in STANDARD.hochladen)) throw new KonfigFehler(`seite.json: unbekannter Schluessel "hochladen.${s}".`);
  const e = { ...STANDARD, ...k, hochladen: { ...STANDARD.hochladen, ...h } };

  for (const f of ['onionAdresse', 'shopOnion']) {
    e[f] = String(e[f] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (e[f] && !ONION.test(e[f])) throw new KonfigFehler(`seite.json: ${f} muss eine v3-Onion-Adresse sein (56 Zeichen + .onion).`);
  }
  e.apkZertifikatSha256 = String(e.apkZertifikatSha256 || '').replace(/[:\s]/g, '').toLowerCase();
  if (e.apkZertifikatSha256 && !SHA256.test(e.apkZertifikatSha256)) throw new KonfigFehler('seite.json: apkZertifikatSha256 muss 64 Hex-Zeichen haben.');
  e.updateSchluessel = String(e.updateSchluessel || '').trim();
  if (e.updateSchluessel) {
    try {
      base64urlDekodieren(e.updateSchluessel, 32);
    } catch (err) {
      throw new KonfigFehler(`seite.json: updateSchluessel ist kein Ed25519-Schluessel in Base64url (${err.message}).`);
    }
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(e.applicationId)) throw new KonfigFehler('seite.json: applicationId ungueltig.');
  if (!Number.isSafeInteger(e.minSupportedVersionCode) || e.minSupportedVersionCode < 1) throw new KonfigFehler('seite.json: minSupportedVersionCode muss eine ganze Zahl >= 1 sein.');
  if (!Array.isArray(e.abis) || e.abis.length === 0 || e.abis.some((a) => !ABIS.includes(a)) || new Set(e.abis).size !== e.abis.length) {
    throw new KonfigFehler(`seite.json: abis muss eine Liste aus ${ABIS.join(', ')} sein.`);
  }
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.:\[\]-]+$/.test(e.hochladen.ziel)) throw new KonfigFehler('seite.json: hochladen.ziel muss die Form nutzer@rechner haben.');
  for (const f of ['eingang', 'aktivieren']) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(e.hochladen[f])) throw new KonfigFehler(`seite.json: hochladen.${f} muss ein absoluter Pfad sein.`);
  }
  return e;
}

export function konfigLaden(datei) {
  let roh;
  try {
    roh = JSON.parse(fs.readFileSync(datei, 'utf8'));
  } catch (err) {
    throw new KonfigFehler(`${datei} kann nicht gelesen werden: ${err.message}`);
  }
  return konfigPruefen(roh);
}
