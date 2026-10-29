/**
 * Malachi – PinChange.js
 *
 * App-PIN und Notfall-PIN in den Einstellungen aendern (Nutzerwunsch
 * 29.10.2026: "nur wenn man die alten Passwoerter richtig eingibt").
 *
 * Wer das entsperrte Handy kurz in die Hand bekommt, soll weder die PIN
 * aendern (Besitzer aussperren) noch die Notfall-PIN setzen, aendern oder
 * entfernen koennen. Deshalb verlangt jede dieser Aenderungen zuerst die
 * aktuelle App-PIN (confirmAppPin).
 *
 * Fehlversuche zaehlen in DENSELBEN Zaehler wie am Sperrbildschirm
 * ('pin_attempts', 'pin_locked_until', LicenseManager.failedPinPolicy) -
 * sonst liesse sich die PIN hier in Ruhe durchprobieren, waehrend der
 * Sperrbildschirm nach dem dritten Versuch bremst (und mit Vollversion nach
 * dem fuenften loescht). Laeuft eine Sperrfrist, wird gar nicht erst
 * geprueft.
 *
 * Die Notfall-PIN loest hier NICHTS aus - sie wirkt nur am Sperrbildschirm.
 * Hier zaehlt sie wie eine falsche PIN: ein Vertipper beim Aendern der
 * Notfall-PIN ("alte PIN" verwechselt) soll nicht alle Daten loeschen, und
 * wer zuschaut, erfaehrt dadurch nicht, dass es eine Notfall-PIN gibt.
 */
import EncryptedStorage from 'react-native-encrypted-storage';
import * as PinVault from './PinVault';
import { failedPinPolicy, isProVerified } from './LicenseManager';

export const ATTEMPTS_KEY = 'pin_attempts';
export const LOCKED_UNTIL_KEY = 'pin_locked_until';
export const LENGTH_KEY = 'pin_length';
const LEGACY_PIN_KEY = 'app_pin';
const LEGACY_DURESS_KEY = 'duress_pin';

function ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function isValidPin(pin) {
  return typeof pin === 'string' && /^(\d{4}|\d{6})$/.test(pin);
}

/** Laenge der aktuellen App-PIN: Tresor-Datensatz, sonst 'pin_length' (Standard 6). */
export async function currentPinLength() {
  try {
    if (await PinVault.ready()) {
      const n = PinVault.pinLength();
      if (n) return n;
    }
  } catch {}
  const legacy = await EncryptedStorage.getItem(LEGACY_PIN_KEY).catch(() => null);
  if (legacy) return legacy.length;
  return parseInt(await EncryptedStorage.getItem(LENGTH_KEY).catch(() => null), 10) || 6;
}

/** Restliche Sperrfrist (ms) aus dem gemeinsamen Zaehler, 0 = keine. */
export async function lockedForMs() {
  const u = parseInt(await EncryptedStorage.getItem(LOCKED_UNTIL_KEY).catch(() => null), 10) || 0;
  return Math.max(0, u - Date.now());
}

// -> 'ok' | 'wrong' | 'error'
async function checkPin(pin) {
  const state = await PinVault.vaultState();
  if (state === 'present') {
    const r = await PinVault.verifyPin(pin);
    if (r === 'ok') return 'ok';
    if (r === 'wrong' || r === 'duress') return 'wrong';
    return 'error';
  }
  if (state !== 'absent') return 'error';
  // Altbestand ohne Tresor (Chip nicht nutzbar): PIN im verschluesselten Speicher.
  const saved = await EncryptedStorage.getItem(LEGACY_PIN_KEY).catch(() => null);
  if (!saved) return 'error';
  return ctEqual(saved, pin) ? 'ok' : 'wrong';
}

async function resetAttempts() {
  await EncryptedStorage.removeItem(ATTEMPTS_KEY).catch(() => {});
  await EncryptedStorage.removeItem(LOCKED_UNTIL_KEY).catch(() => {});
}

/**
 * Aktuelle App-PIN bestaetigen.
 * -> { ok:true }
 *  | { ok:false, reason:'locked', waitMs }                  Sperrfrist laeuft
 *  | { ok:false, reason:'wrong', attempts, wipe, lockMs, message }
 *  | { ok:false, reason:'error' }                           Chip/Speicher - kein Fehlversuch
 * Bei lockMs > 0 bzw. wipe muss der Aufrufer die App sperren bzw. loeschen
 * (wie der Sperrbildschirm).
 */
export async function confirmAppPin(pin) {
  const waitMs = await lockedForMs();
  if (waitMs > 0) return { ok: false, reason: 'locked', waitMs };
  const r = await checkPin(String(pin || ''));
  if (r === 'ok') { await resetAttempts(); return { ok: true }; }
  if (r !== 'wrong') return { ok: false, reason: 'error' };
  const n = (parseInt(await EncryptedStorage.getItem(ATTEMPTS_KEY).catch(() => null), 10) || 0) + 1;
  // Sofort speichern - ein Beenden der App darf den Versuch nicht "vergessen".
  try { await EncryptedStorage.setItem(ATTEMPTS_KEY, String(n)); } catch {}
  let pro = false;
  try { pro = await isProVerified(); } catch {}
  const policy = failedPinPolicy(n, pro);
  if (policy.lockMs > 0) {
    try { await EncryptedStorage.setItem(LOCKED_UNTIL_KEY, String(Date.now() + policy.lockMs)); } catch {}
  }
  return { ok: false, reason: 'wrong', attempts: n, wipe: !!policy.wipe, lockMs: policy.lockMs, message: policy.message };
}

/** Gibt es eine Notfall-PIN? (Tresor: Pruefwert; Altbestand: Klartext im Speicher) */
export async function hasDuress() {
  try {
    if (await PinVault.ready()) return PinVault.hasDuressPin();
  } catch { return false; }
  return !!(await EncryptedStorage.getItem(LEGACY_DURESS_KEY).catch(() => null));
}

/**
 * App-PIN aendern. oldPin muss vorher mit confirmAppPin bestaetigt worden
 * sein (wird hier vom Tresor trotzdem erneut geprueft). Andere Laenge als
 * bisher: eine Notfall-PIN wird entfernt (sie muss gleich lang sein, sonst
 * wertet der Sperrbildschirm sie nie aus).
 * -> { result: 'ok' | 'wrong' | 'same' | 'duress' | 'invalid' | 'error', duressRemoved? }
 */
export async function changeAppPin(oldPin, newPin) {
  if (!isValidPin(newPin)) return { result: 'invalid' };
  const oldLen = await currentPinLength();
  const dropDuress = newPin.length !== oldLen;
  const hadDuress = await hasDuress();
  const state = await PinVault.vaultState();
  if (state === 'present') {
    const r = await PinVault.changePin(oldPin, newPin, { dropDuress });
    if (r !== 'ok') return { result: r };
    // Nur noch fuer Altpfade (Tresor-Datensatz fuehrt die Laenge selbst).
    await EncryptedStorage.setItem(LENGTH_KEY, String(newPin.length)).catch(() => {});
    return { result: 'ok', duressRemoved: dropDuress && hadDuress };
  }
  if (state !== 'absent') return { result: 'error' };
  const saved = await EncryptedStorage.getItem(LEGACY_PIN_KEY).catch(() => null);
  if (!saved || !ctEqual(saved, String(oldPin))) return { result: 'wrong' };
  if (saved === newPin) return { result: 'same' };
  const duress = await EncryptedStorage.getItem(LEGACY_DURESS_KEY).catch(() => null);
  if (duress && !dropDuress && duress === newPin) return { result: 'duress' };
  try {
    // Altbestand: der Sperrbildschirm nimmt die Laenge aus der gespeicherten PIN.
    await EncryptedStorage.setItem(LEGACY_PIN_KEY, newPin);
  } catch {
    return { result: 'error' };
  }
  if (dropDuress && duress) await EncryptedStorage.removeItem(LEGACY_DURESS_KEY).catch(() => {});
  await EncryptedStorage.setItem(LENGTH_KEY, String(newPin.length)).catch(() => {});
  return { result: 'ok', duressRemoved: dropDuress && !!duress };
}

/**
 * Notfall-PIN setzen oder aendern (Lizenz prueft der Aufrufer, App-PIN wurde
 * vorher bestaetigt). -> 'ok' | 'length' | 'same' (= App-PIN) | 'error'
 */
export async function setDuress(duressPin) {
  const len = await currentPinLength();
  if (typeof duressPin !== 'string' || !/^\d+$/.test(duressPin) || duressPin.length !== len) return 'length';
  if (await PinVault.ready().then((r) => !!r).catch(() => false)) {
    const r = await PinVault.setDuressPin(duressPin);
    if (r === 'ok') await EncryptedStorage.removeItem(LEGACY_DURESS_KEY).catch(() => {});
    return r;
  }
  const realPin = await EncryptedStorage.getItem(LEGACY_PIN_KEY).catch(() => null);
  if (!realPin) return 'error';
  if (realPin === duressPin) return 'same';
  try { await EncryptedStorage.setItem(LEGACY_DURESS_KEY, duressPin); } catch { return 'error'; }
  return 'ok';
}

/** Notfall-PIN entfernen (App-PIN wurde vorher bestaetigt). */
export async function removeDuress() {
  await PinVault.clearDuressPin().catch(() => {});
  await EncryptedStorage.removeItem(LEGACY_DURESS_KEY).catch(() => {});
}
