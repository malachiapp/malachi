/* eslint-env node */
// Bildschirmschutz (ScreenSecurity.js, Nutzerwunsch 2026-10-19): an/aus,
// Abschalten nur mit Vollversion; Secret Chat und Siegel immer geschuetzt;
// Ende der Vollversion oder Wipe -> sofort wieder an.
const fs = require('fs');
const path = require('path');

jest.mock('../../LicenseManager', () => {
  const subs = new Set();
  let state = { pro: false };
  return {
    getLicenseState: () => state,
    subscribeLicense: (fn) => { subs.add(fn); try { fn(state); } catch {} return () => subs.delete(fn); },
    __setPro: (pro) => { state = { ...state, pro }; for (const f of subs) f(state); },
  };
});

const { NativeModules } = require('react-native');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const LM = require('../../LicenseManager');
const SS = require('../../ScreenSecurity');

let calls;
beforeEach(async () => {
  calls = [];
  NativeModules.MalachiScreenSecurity = { setSecure: jest.fn((v) => calls.push(v)) };
  await EncryptedStorage.clear();
  LM.__setPro(false);
  SS._resetScreenSecurityForTests();
});
const last = () => calls[calls.length - 1];

test('Standard: an; ohne Vollversion laesst er sich nicht abschalten', async () => {
  await SS.loadScreenProtection();
  expect(last()).toBe(true);
  expect(await SS.setScreenProtection(false)).toBe(false);
  expect(SS.isScreenProtectionActive()).toBe(true);
  expect(SS.screenProtectionSetting()).toBe(true);
  expect(await EncryptedStorage.getItem(SS.SCREEN_PROTECTION_KEY)).toBeNull();
  expect(calls.every((v) => v === true)).toBe(true);
});

test('mit Vollversion: aus und wieder an, gespeichert', async () => {
  LM.__setPro(true);
  await SS.loadScreenProtection();
  expect(await SS.setScreenProtection(false)).toBe(true);
  expect(last()).toBe(false);
  expect(await EncryptedStorage.getItem(SS.SCREEN_PROTECTION_KEY)).toBe('off');
  // Neustart: gespeicherte Wahl gilt wieder
  SS._resetScreenSecurityForTests();
  calls.length = 0;
  await SS.loadScreenProtection();
  expect(last()).toBe(false);
  expect(await SS.setScreenProtection(true)).toBe(true);
  expect(last()).toBe(true);
  expect(await EncryptedStorage.getItem(SS.SCREEN_PROTECTION_KEY)).toBeNull();
});

test('Secret Chat / Siegel schuetzen immer - auch wenn Screenshots erlaubt sind', async () => {
  LM.__setPro(true);
  await SS.loadScreenProtection();
  await SS.setScreenProtection(false);
  expect(last()).toBe(false);
  SS.forceScreenProtection('secret-chat:c1', true);
  expect(last()).toBe(true);
  SS.forceScreenProtection('siegel', true);
  SS.forceScreenProtection('secret-chat:c1', false);
  expect(SS.isScreenProtectionActive()).toBe(true);     // Siegel noch offen
  SS.forceScreenProtection('siegel', false);
  expect(last()).toBe(false);
  expect(SS.screenProtectionSetting()).toBe(false);
});

test('Vollversion endet (Widerruf) -> sofort an; kommt sie wieder, gilt die gespeicherte Wahl', async () => {
  LM.__setPro(true);
  await SS.loadScreenProtection();
  await SS.setScreenProtection(false);
  LM.__setPro(false);
  expect(last()).toBe(true);
  expect(SS.screenProtectionSetting()).toBe(true);
  LM.__setPro(true);
  expect(last()).toBe(false);
});

test('Wipe: Einstellung vergessen, Schutz an', async () => {
  LM.__setPro(true);
  await SS.loadScreenProtection();
  await SS.setScreenProtection(false);
  SS.forceScreenProtection('siegel', true);
  SS.resetScreenProtectionAfterWipe();
  SS.forceScreenProtection('siegel', false);
  expect(last()).toBe(true);
  expect(SS.isScreenProtectionActive()).toBe(true);
});

test('statisch: nativer Teil - Standard an vor JS, Vorschau in der App-Uebersicht immer leer, Modul registriert', () => {
  const dir = path.join(__dirname, '../../android/app/src/main/java/com/securecommapp');
  const main = fs.readFileSync(path.join(dir, 'MainActivity.kt'), 'utf8');
  const mod = fs.readFileSync(path.join(dir, 'ScreenSecurityModule.kt'), 'utf8');
  const appl = fs.readFileSync(path.join(dir, 'MainApplication.kt'), 'utf8');
  expect(main).toMatch(/@Volatile @JvmStatic var secureWindow = true/);
  expect(main).toMatch(/if \(secureWindow\) \{\s+window\.setFlags\(\s+WindowManager\.LayoutParams\.FLAG_SECURE/);
  expect(main).toMatch(/setRecentsScreenshotEnabled\(false\)/);
  expect(mod).toMatch(/override fun getName\(\) = "MalachiScreenSecurity"/);
  expect(mod).toMatch(/MainActivity\.secureWindow = secure/);
  expect(appl).toMatch(/add\(ScreenSecurityPackage\(\)\)/);
});

test('statisch: App - Laden beim Start, Wipe, Secret Chat, Siegel, Einstellung nur mit Vollversion', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
  const siegel = fs.readFileSync(path.join(__dirname, '../../SiegelScreen.tsx'), 'utf8');
  expect(app).toMatch(/loadScreenProtection\(\)\.catch/);
  expect(app).toMatch(/resetLicenseStateAfterWipe\(\);[\s\S]{0,200}resetScreenProtectionAfterWipe\(\);/);
  expect(app).toMatch(/forceScreenProtection\(tag, !!secretActive\);/);
  expect(app).toMatch(/const onScreenProtPress = async \(\) => \{\s+if \(!pro\) \{ setProOpen\(true\); return; \}/);
  expect(siegel).toMatch(/forceScreenProtection\('siegel', !!visible\);/);
});
