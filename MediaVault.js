// MediaVault.js - Bilder, Sprachnachrichten und Dateien des Verlaufs als
// einzeln verschluesselte Dateien statt als Base64 im Verlauf (Audit
// 2026-10-19, G1).
//
// Vorher lag jedes Medium als Base64 im Chatverlauf in EncryptedStorage -
// alles in EINER SharedPreferences-Datei, die Android beim Start komplett in
// den Speicher laedt. Viele Medien blaehten sie auf bis zum Absturz beim Start.
//
// Jetzt: <Dokumente>/media/<bereich>/<id>.enc, verschluesselt mit einem
// zufaelligen Schluessel je Datei (gleiches Verfahren wie die Empfangs-Ablage
// in RTCStore.js). Im Verlauf (EncryptedStorage, Keystore-geschuetzt) stehen
// nur noch Verweis und Schluessel - die Datei allein ist wertlos.
// bereich = Kontakt-ID (1:1) bzw. 'g_' + Gruppen-ID; Loeschen eines Chats
// entfernt den ganzen Ordner, der Wipe den ganzen media-Ordner.
import RNFS from 'react-native-fs';
import { encryptMsg, decryptMsg, secureRandomToken, randomKeyB64 } from './MessageCrypto';

const PURPOSE = 'media-vault';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Entschluesselte Medien kurz im RAM halten (Scrollen, erneutes Abspielen) -
// klein, damit grosse Verlaeufe den Speicher nicht fuellen.
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_CHARS = 24 * 1024 * 1024;

const cache = new Map();   // pfad -> Klartext (Base64/Data-URI)
let cacheChars = 0;

export function mediaRoot() {
  return `${RNFS.DocumentDirectoryPath}/media`;
}

// Ordnername aus der Kontakt-/Gruppen-ID: nur sichere Zeichen, nie '..'.
export function scopeDir(scope) {
  const s = String(scope || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  if (!s || /^_+$/.test(s)) throw new Error('Ungueltiger Medienbereich');
  return `${mediaRoot()}/${s}`;
}

function pathFor(scope, mref) {
  if (typeof mref !== 'string' || !ID_RE.test(mref)) throw new Error('Ungueltiger Medienverweis');
  return `${scopeDir(scope)}/${mref}.enc`;
}

function cachePut(path, data) {
  if (typeof data !== 'string' || data.length > CACHE_MAX_CHARS) return;
  if (cache.has(path)) { cacheChars -= cache.get(path).length; cache.delete(path); }
  cache.set(path, data);
  cacheChars += data.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheChars > CACHE_MAX_CHARS) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cacheChars -= v.length;
  }
}

function cacheDrop(prefix) {
  for (const [k, v] of [...cache.entries()]) {
    if (k === prefix || k.startsWith(prefix + '/')) { cache.delete(k); cacheChars -= v.length; }
  }
}

// Legt ein Medium ab, liefert { mref, mk } fuer den Verlaufseintrag.
export async function putMedia(scope, data) {
  if (typeof data !== 'string' || !data) throw new Error('Kein Medieninhalt');
  const dir = scopeDir(scope);
  const mref = await secureRandomToken(16);
  const mk = await randomKeyB64(32);
  const enc = await encryptMsg(data, mk, PURPOSE);
  if (!enc) throw new Error('Verschluesselung fehlgeschlagen');
  await RNFS.mkdir(dir).catch(() => {});
  const path = pathFor(scope, mref);
  await RNFS.writeFile(path, enc, 'utf8');
  cachePut(path, data);
  return { mref, mk };
}

// Liest ein Medium (null, wenn die Datei fehlt oder nicht passt).
export async function getMedia(scope, ref) {
  if (!ref || typeof ref.mk !== 'string') return null;
  let path;
  try { path = pathFor(scope, ref.mref); } catch { return null; }
  if (cache.has(path)) {
    const v = cache.get(path);
    cache.delete(path); cache.set(path, v);   // zuletzt benutzt
    return v;
  }
  try {
    const enc = await RNFS.readFile(path, 'utf8');
    const plain = enc ? decryptMsg(enc, ref.mk, PURPOSE) : null;
    if (typeof plain !== 'string') return null;
    cachePut(path, plain);
    return plain;
  } catch {
    return null;
  }
}

export async function removeMedia(scope, mref) {
  let path;
  try { path = pathFor(scope, mref); } catch { return; }
  cacheDrop(path);
  await RNFS.unlink(path).catch(() => {});
}

// Ganzer Chat/ganze Gruppe (Chat geleert/geloescht, Kontakt entfernt).
export async function removeScope(scope) {
  let dir;
  try { dir = scopeDir(scope); } catch { return; }
  cacheDrop(dir);
  await RNFS.unlink(dir).catch(() => {});
}

// Dateien eines Bereichs entfernen, auf die kein Verlaufseintrag mehr zeigt
// (einzeln geloeschte/abgelaufene Nachrichten). keep: Set der mref-Werte.
export async function sweepScope(scope, keep) {
  let dir;
  try { dir = scopeDir(scope); } catch { return 0; }
  let files;
  try { files = await RNFS.readDir(dir); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const m = /^([A-Za-z0-9_-]{8,64})\.enc$/.exec(f.name || '');
    if (m && keep.has(m[1])) continue;
    cacheDrop(f.path);
    await RNFS.unlink(f.path).catch(() => {});
    n++;
  }
  return n;
}

// Wipe: alles weg, auch der RAM-Zwischenspeicher.
export async function wipeAllMedia() {
  clearMediaCache();
  await RNFS.unlink(mediaRoot()).catch(() => {});
}

export function clearMediaCache() {
  cache.clear();
  cacheChars = 0;
}

// Verlaufseintrag mit Medium? (image/audio/file mit Inhalt oder Verweis)
export function isMediaEntry(m) {
  return !!m && (m.type === 'image' || m.type === 'audio' || m.type === 'file')
    && (typeof m.base64 === 'string' || typeof m.mref === 'string');
}

// Fuer das Speichern: Medien ablegen, Eintrag nur mit Verweis zurueckgeben.
// known: Map id -> {mref, mk} (bereits in dieser Sitzung abgelegt), wird
// ergaenzt. Schlaegt das Ablegen fehl (z.B. Speicher voll), bleibt der Inhalt
// wie bisher eingebettet - lieber gross als verloren; der naechste
// Speichervorgang versucht es erneut.
export async function externalizeEntries(scope, entries, known) {
  const out = [];
  for (const m of entries) {
    if (!isMediaEntry(m) || typeof m.mref === 'string') {
      if (isMediaEntry(m) && typeof m.base64 === 'string') {
        const { base64, ...rest } = m;   // Verweis vorhanden: Inhalt nie mitspeichern
        out.push(rest);
      } else {
        out.push(m);
      }
      continue;
    }
    let ref = known.get(m.id);
    if (!ref) {
      try {
        ref = await putMedia(scope, m.base64);
        known.set(m.id, ref);
      } catch (e) {
        console.warn('[Medien] Ablegen fehlgeschlagen:', e?.message || e);
        ref = null;
      }
    }
    if (!ref) { out.push(m); continue; }
    const { base64, ...rest } = m;
    out.push({ ...rest, mref: ref.mref, mk: ref.mk });
  }
  return out;
}

// Inhalt eines Eintrags (aus dem RAM oder der Ablage).
export async function mediaData(scope, m) {
  if (typeof m?.base64 === 'string') return m.base64;
  if (typeof m?.mref === 'string') return getMedia(scope, m);
  return null;
}
