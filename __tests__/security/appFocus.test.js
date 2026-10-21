// AppFocus.js: gemeinsame Koordination Chat <-> Siegel.
// 1. Systemdialoge (Galerie, Dateiauswahl) duerfen die App-PIN nicht ausloesen -
//    auch nicht, wenn Siegel sie oeffnet (lange Bildsuche endete vorher auf
//    dem PIN-Bildschirm).
// 2. Es gibt nur EINEN nativen Audio-Spieler: wer startet, stoppt den anderen.
const fs = require('fs');
const path = require('path');
const F = require('../../AppFocus');

beforeEach(() => F._resetAppFocusForTests());

test('withAutoLockSuspended: Zaehler steigt waehrend des Dialogs und faellt danach - auch bei Fehlern', async () => {
  expect(F.isAutoLockSuspended()).toBe(false);
  let release;
  const p = F.withAutoLockSuspended(() => new Promise((r) => { release = r; }));
  expect(F.isAutoLockSuspended()).toBe(true);
  release('ok');
  await expect(p).resolves.toBe('ok');
  expect(F.isAutoLockSuspended()).toBe(false);
  await expect(F.withAutoLockSuspended(async () => { throw new Error('abgebrochen'); })).rejects.toThrow('abgebrochen');
  expect(F.isAutoLockSuspended()).toBe(false);
  expect(() => F.withAutoLockSuspended(() => { throw new Error('sync'); })).toThrow('sync');
  expect(F.isAutoLockSuspended()).toBe(false);
});

test('claimAudio: der neue Besitzer stoppt den alten; derselbe Besitzer stoppt sich nicht selbst', async () => {
  const stopChat = jest.fn();
  const stopSiegel = jest.fn();
  await F.claimAudio('chat', stopChat);
  await F.claimAudio('chat', stopChat);
  expect(stopChat).not.toHaveBeenCalled();
  await F.claimAudio('siegel', stopSiegel);
  expect(stopChat).toHaveBeenCalledTimes(1);
  await F.claimAudio('chat', stopChat);
  expect(stopSiegel).toHaveBeenCalledTimes(1);
  // Nach releaseAudio wird niemand mehr gestoppt.
  F.releaseAudio('chat');
  await F.claimAudio('siegel', stopSiegel);
  expect(stopChat).toHaveBeenCalledTimes(1);
  // Fremdes release ist wirkungslos; ein werfendes stop() blockiert nicht.
  F.releaseAudio('chat');
  await F.claimAudio('chat', async () => { throw new Error('x'); });
  expect(stopSiegel).toHaveBeenCalledTimes(2);
  await expect(F.claimAudio('siegel', stopSiegel)).resolves.toBeUndefined();
});

test('statisch: Chat und Siegel nutzen denselben Audio-Fokus und dieselbe Sperr-Gnadenfrist', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
  const siegel = fs.readFileSync(path.join(__dirname, '../../SiegelScreen.tsx'), 'utf8');
  const vault = fs.readFileSync(path.join(__dirname, '../../SiegelVault.js'), 'utf8');
  expect(app).toMatch(/from '\.\/AppFocus'/);
  expect((app.match(/await claimAudio\('chat', stopChatAudio\)/g) || []).length).toBe(3);   // Aufnahme, Vorschau, Wiedergabe
  expect(siegel).toMatch(/await claimAudio\('siegel', stopSiegelAudio\)/);
  expect(siegel).toMatch(/releaseAudio\('siegel'\)/);
  expect(vault).toMatch(/AppFocus/);
});

test('statisch: Doppelter Kontakt - klare Meldung, nichts wird ohne Nachfrage geloescht', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
  // Texte seit der Uebersetzung ueber Schluessel (locales/de.js).
  const i = app.indexOf("t('app.kontaktDoppeltVorhanden')");
  expect(i).toBeGreaterThan(0);
  const block = app.slice(i, i + 1500);
  expect(block).toMatch(/t\('app\.beideBehalten'\), style: 'cancel'/);
  expect(block).toMatch(/t\('app\.aelterenChatEntfernen'\), style: 'destructive'/);
  const { t } = require('../../i18n');
  expect(t('app.kontaktDoppeltVorhanden')).toBe('Kontakt doppelt vorhanden');
  expect(t('app.aelterenChatEntfernen')).toBe('Älteren Chat entfernen');
});

test('statisch: Siegel-Anhaenge im Dateien-Reiter oeffnen Siegel statt einer fremden App', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
  expect(app).toMatch(/Siegel-Anhang/);
});
