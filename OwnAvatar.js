// OwnAvatar.js - eigenes Profilbild: dauerhaft und verschluesselt.
//
// Vorher stand unter 'avatar' der Dateipfad, den die Bildauswahl liefert - eine
// Klartext-Kopie im Cache (rn_image_picker_lib_temp_*). Genau solche Kopien
// raeumt der Start weg (cleanupSharedFileCache in App.tsx, Audit P12/G9: aelter
// als zwei Minuten), und Android darf den Cache ohnehin jederzeit leeren.
// Danach zeigten Startbildschirm und Einstellungen nur noch einen leeren Kreis
// ("Profilbild bugt"), und RTCStore brach beim Profilversand ab (fehlende
// Datei) - samt Senden der Warteschlange fuer diese Verbindung.
//
// Jetzt: das Bild (Bildauswahl verkleinert auf hoechstens 512 px) liegt als
// verschluesselte Datei in MediaVault (eigener Bereich, eigener Schluessel), in
// EncryptedStorage nur Verweis + Schluessel ('avatar_ref'). Die Klartext-Kopie
// der Bildauswahl wird sofort geloescht. Altbestand ('avatar' = Dateipfad oder
// data:-URI) wird beim ersten Laden uebernommen; ist die Datei schon weg, bleibt
// kein toter Verweis zurueck (Initialen statt leerem Kreis).
import EncryptedStorage from 'react-native-encrypted-storage';
import RNFS from 'react-native-fs';
import { putMedia, getMedia, removeMedia, scopeDir } from './MediaVault';

export const PROFILE_SCOPE = 'profil_selbst';
export const AVATAR_REF_KEY = 'avatar_ref';
export const LEGACY_AVATAR_KEY = 'avatar';
const MIME_RE = /^image\/(jpeg|png|webp|gif|heic|heif)$/;
const MREF_RE = /^[A-Za-z0-9_-]{8,64}$/;

let loading = null;               // Promise<data:-URI | null>
const listeners = new Set();

function notify(uri) {
  for (const l of [...listeners]) { try { l(uri); } catch {} }
}

/** Aenderungen (neues Bild, entfernt, Wipe) - z.B. Kopfzeile und Einstellungen. */
export function subscribeOwnAvatar(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const toUri = (base64, mime) => `data:${mime};base64,${base64}`;
const vaultPath = (mref) => `${scopeDir(PROFILE_SCOPE)}/${mref}.enc`;

function mimeOf(type, path = '') {
  const t = String(type || '').toLowerCase();
  if (MIME_RE.test(t)) return t;
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.webp$/i.test(path)) return 'image/webp';
  return 'image/jpeg';
}

async function readRef() {
  const raw = await EncryptedStorage.getItem(AVATAR_REF_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (r && MREF_RE.test(r.mref || '') && typeof r.mk === 'string' && MIME_RE.test(r.mime || '')) return r;
  } catch {}
  return null;
}

// Erst die neue Datei ablegen und den Verweis speichern, dann die alte
// loeschen - bricht etwas ab, bleibt immer ein gueltiges Bild uebrig.
async function store(base64, mime) {
  const old = await readRef();
  const ref = await putMedia(PROFILE_SCOPE, base64);
  await EncryptedStorage.setItem(AVATAR_REF_KEY, JSON.stringify({ mref: ref.mref, mk: ref.mk, mime }));
  if (old && old.mref !== ref.mref) await removeMedia(PROFILE_SCOPE, old.mref);
}

// Klartext-Kopie der Bildauswahl (nur im eigenen Cache) entfernen.
function dropCacheCopy(uri) {
  if (typeof uri !== 'string') return;
  const path = uri.replace(/^file:\/\//, '');
  if (path.startsWith(RNFS.CachesDirectoryPath + '/')) RNFS.unlink(path).catch(() => {});
}

// Altbestand uebernehmen. Datei sicher weg -> toter Verweis wird entfernt;
// Datei da, aber (gerade) nicht lesbar -> nichts loeschen, spaeter erneut.
async function migrateLegacy() {
  const legacy = await EncryptedStorage.getItem(LEGACY_AVATAR_KEY).catch(() => null);
  if (!legacy) return null;
  let base64 = null;
  let mime = 'image/jpeg';
  if (legacy.startsWith('data:')) {
    const m = /^data:([^;,]+);base64,(.+)$/.exec(legacy);
    if (m) { base64 = m[2]; mime = mimeOf(m[1]); }
  } else if (legacy.startsWith('file://') || legacy.startsWith('/')) {
    const path = legacy.replace(/^file:\/\//, '');
    const exists = await RNFS.exists(path).catch(() => null);
    if (exists === false) {
      await EncryptedStorage.removeItem(LEGACY_AVATAR_KEY).catch(() => {});
      return null;
    }
    try { base64 = await RNFS.readFile(path, 'base64'); } catch { return null; }
    mime = mimeOf(null, path);
  }
  if (!base64) return null;
  await store(base64, mime);
  await EncryptedStorage.removeItem(LEGACY_AVATAR_KEY).catch(() => {});
  dropCacheCopy(legacy);
  return toUri(base64, mime);
}

/** Eigenes Profilbild als data:-URI (nur im Arbeitsspeicher) oder null. */
export function loadOwnAvatar() {
  if (!loading) {
    loading = (async () => {
      const ref = await readRef();
      if (ref) {
        const base64 = await getMedia(PROFILE_SCOPE, ref);
        if (base64) return toUri(base64, ref.mime);
        // Datei sicher weg: Verweis entfernen; sonst (Lesefehler) behalten.
        const exists = await RNFS.exists(vaultPath(ref.mref)).catch(() => null);
        if (exists === false) await EncryptedStorage.removeItem(AVATAR_REF_KEY).catch(() => {});
        else return null;
      }
      return migrateLegacy();
    })();
    // Fehler/kein Bild nicht dauerhaft merken - beim naechsten Aufruf neu.
    const p = loading;
    p.then((v) => { if (v == null && loading === p) loading = null; }, () => { if (loading === p) loading = null; });
  }
  return loading;
}

/**
 * Pfad eines noch nicht uebernommenen alten Profilbilds (Lesefehler) - der
 * Start-Sweep laesst diese Datei liegen, der naechste Start versucht es erneut.
 */
export async function pendingLegacyAvatarPath() {
  const legacy = await EncryptedStorage.getItem(LEGACY_AVATAR_KEY).catch(() => null);
  if (typeof legacy !== 'string' || !(legacy.startsWith('file://') || legacy.startsWith('/'))) return null;
  return legacy.replace(/^file:\/\//, '');
}

/** Fuer den Versand an Kontakte (RTCStore): { base64, mime } oder null. */
export async function ownAvatarForSending() {
  const uri = await loadOwnAvatar().catch(() => null);
  const m = typeof uri === 'string' ? /^data:([^;,]+);base64,(.+)$/.exec(uri) : null;
  return m ? { base64: m[2], mime: m[1] } : null;
}

/** Neues Bild aus der Bildauswahl (mit includeBase64). Ergebnis: data:-URI oder null. */
export async function setOwnAvatarFromPicker(asset) {
  if (!asset || typeof asset.base64 !== 'string' || !asset.base64) {
    dropCacheCopy(asset?.uri);
    return null;
  }
  const mime = mimeOf(asset.type, asset.uri || '');
  dropCacheCopy(asset.uri);
  await store(asset.base64, mime);
  await EncryptedStorage.removeItem(LEGACY_AVATAR_KEY).catch(() => {});
  const uri = toUri(asset.base64, mime);
  loading = Promise.resolve(uri);
  notify(uri);
  return uri;
}

/** Profilbild entfernen. */
export async function removeOwnAvatar() {
  const ref = await readRef();
  await EncryptedStorage.removeItem(AVATAR_REF_KEY).catch(() => {});
  await EncryptedStorage.removeItem(LEGACY_AVATAR_KEY).catch(() => {});
  if (ref) await removeMedia(PROFILE_SCOPE, ref.mref);
  loading = null;
  notify(null);
}

/** Wipe: Speicher leert performWipe (EncryptedStorage + Medienordner), hier den RAM. */
export function resetOwnAvatarAfterWipe() {
  loading = null;
  notify(null);
}
