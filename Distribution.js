// Vertriebsvariante der App (PLAY_STORE.md): "web" (APK von der eigenen
// Website, Vollversion ueber den Shop) oder "play" (Google Play Store,
// Vollversion ueber Google Play Billing).
//
// Die Variante kommt aus dem Gradle-Flavor (android/app/build.gradle,
// Dimension "vertrieb") und wird vom nativen Modul MalachiBuild als Konstante
// geliefert (BuildConfig.FLAVOR). Protokoll, Verschluesselung, Kopplung,
// Chats, Gruppen, Anrufe und Siegel sind in beiden Varianten IDENTISCH -
// hier unterscheiden sich nur Vertrieb und Kauf der Vollversion.
//
// Fehlt das native Modul (Jest, iOS, aeltere Builds), gilt "web" - das ist
// der bisherige Stand der App.

import { NativeModules } from 'react-native';

export const DISTRIBUTION_WEB = 'web';
export const DISTRIBUTION_PLAY = 'play';

// Paketname wie von Android vergeben (mind. zwei Teile, jeder beginnt mit einem Buchstaben).
const APPLICATION_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

function buildConstants() {
  const mod = NativeModules.MalachiBuild;
  if (!mod) return null;
  // Altes Bridge-Modul: Konstanten liegen direkt am Modul; im Interop-Modus
  // der neuen Architektur kommen sie aus getConstants().
  if (typeof mod.distribution === 'string') return mod;
  if (typeof mod.getConstants === 'function') {
    try {
      const c = mod.getConstants();
      return c && typeof c === 'object' ? c : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Rohwert der Variante, wie ihn das native Modul liefert: 'web', 'play',
 * ein anderer String - oder null, wenn das Modul fehlt. Fuer Stellen, die
 * bei unbekannten Werten lieber NICHTS tun (AppUpdater: kein Selbst-Update
 * im falschen Kanal).
 */
export function rawDistribution() {
  const c = buildConstants();
  const d = c && c.distribution;
  return typeof d === 'string' ? d : null;
}

/** 'web' oder 'play'. Unbekannte Werte gelten als 'web'. */
export function getDistribution() {
  const c = buildConstants();
  return c && c.distribution === DISTRIBUTION_PLAY ? DISTRIBUTION_PLAY : DISTRIBUTION_WEB;
}

/** Google-Play-Variante (Kauf nur ueber Google Play Billing, kein Shop). */
export function isPlay() {
  return getDistribution() === DISTRIBUTION_PLAY;
}

/** Website-Variante (Kauf ueber den Shop, signierte Updates von der Website). */
export function isWeb() {
  return !isPlay();
}

/**
 * Eigener Paketname der laufenden App (z. B. "com.securecommapp"), oder null,
 * wenn unbekannt. Die Play-Kaufpruefung vergleicht ihn mit dem signierten
 * "packageName" eines Kaufs.
 */
export function getApplicationId() {
  const c = buildConstants();
  const id = c && c.applicationId;
  return typeof id === 'string' && id.length <= 150 && APPLICATION_ID_RE.test(id) ? id : null;
}
