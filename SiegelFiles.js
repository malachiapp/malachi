/**
 * Malachi – SiegelFiles.js
 *
 * Dateien rund um Siegel-Anhaenge (SIEGEL_DESIGN.md, "Anhaenge").
 *
 * Zero Trace: entschluesselte Inhalte leben im Arbeitsspeicher. Eine Datei
 * entsteht nur, wo es technisch nicht anders geht - Aufnahme und Wiedergabe
 * einer Sprachnachricht, Uebergabe an eine andere App (FileShareModule) -
 * und zwar ausschliesslich im Cache-Ordner malachi_siegel/. Geloescht wird so
 * frueh wie moeglich, spaetestens beim Schliessen bzw. naechsten Oeffnen von
 * Siegel, beim App-Start (cleanupSiegelTemp) und beim Wipe der App
 * (performWipe raeumt alle malachi_*-Eintraege im Cache).
 */
import RNFS from 'react-native-fs';
import { Buffer } from 'buffer';
import { secureRandomToken } from './MessageCrypto';

export const SIEGEL_FILE_EXT = '.sgl';
export const SIEGEL_FILE_MIME = 'application/octet-stream';
export const siegelTmpDir = () => RNFS.CachesDirectoryPath + '/malachi_siegel';

// Siegel-Datei im Malachi-Chat (Dateiname "siegel-<zufall>.sgl").
export function isSiegelFileName(name) {
  return /\.sgl$/i.test(String(name || ''));
}
export async function newSiegelFileName() {
  return 'siegel-' + (await secureRandomToken(8)) + SIEGEL_FILE_EXT;
}

export function safeFileName(name) {
  const n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 100);
  return n && n !== '.' && n !== '..' ? n : 'Datei';
}

// Je Datei ein eigener Unterordner mit Zufallsnamen - der Dateiname selbst
// bleibt so, wie ihn die Ziel-App anzeigen soll.
export async function tempPath(fileName) {
  const dir = siegelTmpDir() + '/' + (await secureRandomToken(8));
  await RNFS.mkdir(dir);
  return dir + '/' + safeFileName(fileName);
}

export async function writeTemp(fileName, b64) {
  const path = await tempPath(fileName);
  try {
    await RNFS.writeFile(path, b64, 'base64');
  } catch (e) {
    await removeTemp(path);
    throw e;
  }
  return path;
}

// Loescht eine mit tempPath() angelegte Datei samt Unterordner.
export async function removeTemp(path) {
  if (!path) return;
  const p = String(path);
  const dir = p.slice(0, p.lastIndexOf('/'));
  const inTmp = dir.startsWith(siegelTmpDir() + '/') && !dir.includes('/../');
  await RNFS.unlink(inTmp ? dir : p).catch(() => {});
}

export async function cleanupSiegelTemp() {
  try {
    if (await RNFS.exists(siegelTmpDir())) await RNFS.unlink(siegelTmpDir());
  } catch {}
}

// Kopie einer Systemauswahl im App-Cache (z.B. react-native-image-picker legt
// das verkleinerte Bild dort ab) - nur Dateien IM Cache, nie die Originale.
export async function removeIfInCache(uri) {
  let p = String(uri || '').replace(/^file:\/\//, '');
  try { p = decodeURIComponent(p); } catch {}
  if (!p || p.includes('/../') || !p.startsWith(RNFS.CachesDirectoryPath + '/')) return;
  await RNFS.unlink(p).catch(() => {});
}

// Liest eine ausgewaehlte Datei (content:// oder Pfad) als Base64.
export function readB64(uriOrPath) {
  return RNFS.readFile(String(uriOrPath), 'base64');
}

export function b64ToBytes(b64) {
  const b = Buffer.from(String(b64 || ''), 'base64');
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}
export function bytesToB64(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
}

// Text (UTF-8) -> Base64, z.B. fuer den Export einer Siegel-Nachricht als .txt.
export function textToB64(text) {
  return Buffer.from(String(text || ''), 'utf8').toString('base64');
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.', ',') + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
}
