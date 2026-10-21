/**
 * Malachi - "App-Icon passend zum Design" (THEMES.md, Abschnitt "App-Icon")
 *
 * JS-Seite des nativen Moduls MalachiAppIcon (AppIconModule.kt). Welche Icons
 * es gibt und welches zu welchem Design gehoert: AppIconVariants.js.
 *
 * Umgeschaltet wird NUR, wenn die App in den Hintergrund geht: manche
 * Launcher nehmen das Symbol beim Wechsel kurz vom Startbildschirm, auf
 * manchen Geraeten schliesst Android dabei die Activity. So bleibt das
 * Durchblaettern der Designs ruhig - es zaehlt nur die letzte Wahl
 * (entprellt), und bei ausgeschaltetem Schalter geht es aufs Standard-Icon
 * zurueck. Nicht umgeschaltet wird, solange ein Systemdialog offen ist
 * (Galerie, Dateiauswahl, Berechtigung - AppFocus.js; die App kommt gleich
 * zurueck und darf ihre Activity nicht verlieren) oder ein Anruf laeuft;
 * dann beim naechsten Verlassen. Bewusst ohne Zeitverzoegerung: JS-Timer
 * stehen unter Android still, solange die App im Hintergrund ist.
 * Ohne natives Modul (iOS, Tests, alter Build) ist alles ein No-op.
 */
import { NativeModules, AppState } from 'react-native';
import { getTheme, getThemeSelection, isThemeSelectionSettled, isProTheme } from './Themes';
import { isIconVariant, desiredIconVariant } from './AppIconVariants';
import { isAutoLockSuspended } from './AppFocus';

function nativeModule() {
  const m = NativeModules && NativeModules.MalachiAppIcon;
  return m && typeof m.setIcon === 'function' ? m : null;
}

/** Gibt es das native Modul (Android-Build mit AppIconModule)? */
export function isAppIconSupported() {
  return nativeModule() !== null;
}

/**
 * Icon sofort umschalten. Unbekannte Id -> { ok:false, reason:'unknown' }
 * (natives Modul wird gar nicht erst gefragt), kein Modul -> 'unavailable',
 * Fehler im Modul -> 'native'.
 */
export async function setAppIcon(id) {
  if (!isIconVariant(id)) return { ok: false, reason: 'unknown' };
  const m = nativeModule();
  if (!m) return { ok: false, reason: 'unavailable' };
  try {
    await m.setIcon(id);
    return { ok: true, icon: id };
  } catch {
    return { ok: false, reason: 'native' };
  }
}

/** Aktuell aktives Icon laut System, oder null (kein Modul, Fehler, Unbekanntes). */
export async function getAppIcon() {
  const m = nativeModule();
  if (!m || typeof m.getIcon !== 'function') return null;
  try {
    const id = await m.getIcon();
    return isIconVariant(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Icon, das jetzt aktiv sein sollte - oder null, solange das noch nicht
 * feststeht: vor dem Laden der gespeicherten Wahl, und bei gespeichertem
 * Pro-Design, solange die Lizenz noch nicht geprueft ist (sonst sprang das
 * Icon bei jedem Start kurz auf Standard). Ohne gueltige Lizenz zeigt
 * Themes.js "Standard" an - dann gilt auch das Standard-Icon.
 */
export function pendingAppIcon({ licenseLoaded = () => true } = {}) {
  if (!isThemeSelectionSettled()) return null;
  const sel = getThemeSelection();
  if (sel.appIcon === true && isProTheme(sel.themeId) && !licenseLoaded()) return null;
  return desiredIconVariant(sel, getTheme());
}

/**
 * Icon dem Design nachfuehren (App.tsx, einmal beim Start). Rueckgabe:
 * Abmelden; stop.flush() wartet auf einen laufenden Wechsel (Tests).
 * opts: { appState (AppState), licenseLoaded: () => boolean,
 *         busy: () => boolean (z. B. Anruf aktiv - dann nicht jetzt) }
 */
export function startAppIconSync({ appState = AppState, licenseLoaded = () => true, busy = () => false } = {}) {
  const noop = () => {};
  noop.flush = () => Promise.resolve();
  if (!nativeModule()) return noop;
  let applied = null;          // in dieser Sitzung erfolgreich gesetzt
  let chain = Promise.resolve();
  const apply = () => {
    chain = chain.then(async () => {
      if (isAutoLockSuspended() || busy()) return;   // Systemdialog/Anruf: beim naechsten Verlassen
      const want = pendingAppIcon({ licenseLoaded });
      if (!want || want === applied) return;
      const r = await setAppIcon(want);
      if (r.ok) applied = want;
    }).catch(() => {});
    return chain;
  };
  const sub = appState.addEventListener('change', (s) => { if (s === 'background') apply(); });
  const stop = () => { try { sub && sub.remove && sub.remove(); } catch {} };
  stop.flush = () => chain;
  return stop;
}
