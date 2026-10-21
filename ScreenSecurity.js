// ScreenSecurity.js - Bildschirmschutz (Android FLAG_SECURE): sperrt
// Screenshots und Bildschirmaufnahmen der App.
//
// Nutzerwunsch 2026-10-19: der Schutz soll an- und abschaltbar sein, die
// Option nur in der Vollversion. Deshalb:
//   - Standard "an" fuer alle (MainActivity setzt ihn schon vor dem Start von JS).
//   - Abschalten nur mit Vollversion. Endet sie (Widerruf, Wipe), gilt sofort
//     wieder "an" - die gespeicherte Einstellung wirkt erst mit erneuter
//     Vollversion.
//   - Secret Chat und Siegel sind immer geschuetzt (forceScreenProtection).
//   - Die Vorschau in der App-Uebersicht bleibt ab Android 13 immer leer
//     (MainActivity), auch bei "aus".
import { NativeModules } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import { getLicenseState, subscribeLicense } from './LicenseManager';

export const SCREEN_PROTECTION_KEY = 'screen_protection';

let userOff = false;          // gespeicherte Wahl "Screenshots erlauben"
const forced = new Set();     // Bereiche, die immer schuetzen (Secret Chat, Siegel)
const listeners = new Set();
let applied = null;           // zuletzt an den nativen Teil gemeldet

const isPro = () => getLicenseState()?.pro === true;

/** Ist der Schutz gerade wirksam? */
export function isScreenProtectionActive() {
  return !(userOff && isPro()) || forced.size > 0;
}

/** Einstellung fuer die Anzeige: an, solange nicht (mit Vollversion) abgeschaltet. */
export function screenProtectionSetting() {
  return !(userOff && isPro());
}

function apply() {
  const secure = isScreenProtectionActive();
  if (secure !== applied) {
    applied = secure;
    try { NativeModules.MalachiScreenSecurity?.setSecure?.(secure); } catch {}
  }
  for (const l of [...listeners]) { try { l(); } catch {} }
}

export async function loadScreenProtection() {
  try { userOff = (await EncryptedStorage.getItem(SCREEN_PROTECTION_KEY)) === 'off'; } catch { userOff = false; }
  apply();
}

/** on=false (Screenshots erlauben) nur mit Vollversion. Rueckgabe: uebernommen? */
export async function setScreenProtection(on) {
  if (!on && !isPro()) return false;
  userOff = !on;
  try {
    if (userOff) await EncryptedStorage.setItem(SCREEN_PROTECTION_KEY, 'off');
    else await EncryptedStorage.removeItem(SCREEN_PROTECTION_KEY);
  } catch {}
  apply();
  return true;
}

/** Bereich, der unabhaengig von der Einstellung schuetzt (an/aus je Kennung). */
export function forceScreenProtection(tag, on) {
  if (on) forced.add(tag); else forced.delete(tag);
  apply();
}

export function subscribeScreenProtection(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Wipe: Einstellung vergessen, Schutz an. */
export function resetScreenProtectionAfterWipe() {
  userOff = false;
  forced.clear();
  applied = null;
  apply();
}

// Vollversion endet/beginnt: sofort neu bewerten.
subscribeLicense(() => apply());

export function _resetScreenSecurityForTests() {
  userOff = false;
  forced.clear();
  listeners.clear();
  applied = null;
}
