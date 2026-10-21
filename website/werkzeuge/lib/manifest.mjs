// Update-Manifest (Format siehe website/UPDATE_FORMAT.md).
//
// Signiert werden GENAU die Bytes der Datei manifest.json. Dieses Modul
// erzeugt sie deterministisch (feste Schluesselreihenfolge, 2 Leerzeichen
// Einrueckung, UTF-8 ohne BOM, LF, abschliessendes LF) und prueft ein
// empfangenes Manifest nach denselben Regeln wie die App.

export const MANIFEST_FORMAT = 'malachi-update-manifest';
export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_MAX_BYTES = 65536;
export const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const DATEINAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const APP_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ZEITSTEMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_HINWEISE = 4000;

export class ManifestFehler extends Error {}

function ganzzahl(v, name, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new ManifestFehler(`${name}: ganze Zahl von ${min} bis ${max} erwartet.`);
}

/** Prueft die Felder; wirft ManifestFehler. Gibt das Objekt zurueck. */
export function manifestPruefen(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new ManifestFehler('Manifest ist kein Objekt.');
  const erlaubt = ['format', 'formatVersion', 'applicationId', 'versionName', 'versionCode', 'minSupportedVersionCode',
    'published', 'signingCertSha256', 'releaseNotesLang', 'releaseNotes', 'apks'];
  for (const k of Object.keys(m)) if (!erlaubt.includes(k)) throw new ManifestFehler(`Unbekanntes Feld: ${k}`);
  if (m.format !== MANIFEST_FORMAT) throw new ManifestFehler('format: falscher Wert.');
  if (m.formatVersion !== MANIFEST_FORMAT_VERSION) throw new ManifestFehler('formatVersion: nicht unterstuetzt.');
  if (typeof m.applicationId !== 'string' || !APP_ID.test(m.applicationId)) throw new ManifestFehler('applicationId: ungueltig.');
  if (typeof m.versionName !== 'string' || !VERSION_NAME.test(m.versionName)) throw new ManifestFehler('versionName: ungueltig.');
  ganzzahl(m.versionCode, 'versionCode', 1, 2100000000);
  ganzzahl(m.minSupportedVersionCode, 'minSupportedVersionCode', 1, m.versionCode);
  if (typeof m.published !== 'string' || !ZEITSTEMPEL.test(m.published) || Number.isNaN(Date.parse(m.published))) {
    throw new ManifestFehler('published: UTC-Zeitstempel JJJJ-MM-TTThh:mm:ssZ erwartet.');
  }
  if (typeof m.signingCertSha256 !== 'string' || !SHA256.test(m.signingCertSha256)) throw new ManifestFehler('signingCertSha256: 64 Hex-Zeichen (klein) erwartet.');
  if (m.releaseNotesLang !== 'de') throw new ManifestFehler('releaseNotesLang: "de" erwartet.');
  if (typeof m.releaseNotes !== 'string' || m.releaseNotes.length > MAX_HINWEISE || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(m.releaseNotes)) {
    throw new ManifestFehler(`releaseNotes: Text bis ${MAX_HINWEISE} Zeichen, nur LF als Steuerzeichen.`);
  }
  if (!Array.isArray(m.apks) || m.apks.length < 1 || m.apks.length > ABIS.length) throw new ManifestFehler('apks: 1 bis 4 Eintraege erwartet.');
  const gesehen = new Set();
  for (const a of m.apks) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ManifestFehler('apks: Eintrag ist kein Objekt.');
    for (const k of Object.keys(a)) if (!['abi', 'file', 'size', 'sha256'].includes(k)) throw new ManifestFehler(`apks: unbekanntes Feld ${k}`);
    if (!ABIS.includes(a.abi)) throw new ManifestFehler(`apks: unbekannte ABI ${a.abi}`);
    if (gesehen.has(a.abi)) throw new ManifestFehler(`apks: ABI ${a.abi} doppelt.`);
    gesehen.add(a.abi);
    if (typeof a.file !== 'string' || !DATEINAME.test(a.file)) throw new ManifestFehler('apks: Dateiname ungueltig (nur Name, kein Pfad, Endung .apk).');
    ganzzahl(a.size, 'apks.size', 1, 1024 * 1024 * 1024);
    if (typeof a.sha256 !== 'string' || !SHA256.test(a.sha256)) throw new ManifestFehler('apks.sha256: 64 Hex-Zeichen (klein) erwartet.');
  }
  return m;
}

/** Erzeugt die zu signierenden Bytes (Buffer) in fester Reihenfolge. */
export function manifestBytes(e) {
  const m = {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    applicationId: e.applicationId,
    versionName: e.versionName,
    versionCode: e.versionCode,
    minSupportedVersionCode: e.minSupportedVersionCode,
    published: e.published,
    signingCertSha256: e.signingCertSha256,
    releaseNotesLang: 'de',
    releaseNotes: e.releaseNotes,
    apks: e.apks.map((a) => ({ abi: a.abi, file: a.file, size: a.size, sha256: a.sha256 })),
  };
  manifestPruefen(m);
  const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');
  if (bytes.length > MANIFEST_MAX_BYTES) throw new ManifestFehler('Manifest ist groesser als 64 KiB.');
  return bytes;
}

/**
 * Liest empfangene Bytes so, wie es die App tun soll: Groesse, UTF-8 ohne BOM,
 * JSON, Felder. Die Signatur muss VORHER ueber genau diese Bytes geprueft sein.
 */
export function manifestLesen(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length > MANIFEST_MAX_BYTES) throw new ManifestFehler('Manifest zu gross.');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) throw new ManifestFehler('Manifest beginnt mit BOM.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new ManifestFehler('Manifest ist kein gueltiges JSON.');
  }
  return manifestPruefen(m);
}
