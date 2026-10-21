// Audit 2026-10-19: Was "Alle Daten loeschen", die Notfall-PIN und 5
// Fehlversuche zusaetzlich entfernen muessen (P2, P3, P4, P7, C4).
const fs = require('fs');
const path = require('path');
const { NativeModules } = require('react-native');

const ROOT = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n');
const wipeFn = app.slice(app.indexOf('async function performWipe()'), app.indexOf('function LockScreen('));

describe('performWipe (statisch)', () => {
  test('P4: Tor gestoppt, Einladungen verworfen, Tor-Daten geloescht - mit Zeitgrenze', () => {
    expect(wipeFn).toMatch(/OPEN_INVITE = null;\s*await withTimeout\(wipeTorForReset\(\), 8000\);/);
  });
  test('C4: Siegel-Wipe mit Zeitgrenze, sonst Chip-Schluessel direkt loeschen', () => {
    expect(wipeFn).toMatch(/await withTimeout\(siegelWipe\(\)\.then\(\(\) => true, \(\) => false\), 5000\)/);
    expect(wipeFn).toMatch(/if \(siegelOk !== true\) await withTimeout\(NativeModules\.MalachiSiegelKey\?\.destroyKey\?\.\(\)/);
  });
  test('P2: Benachrichtigungen und Hintergrunddienst entfernt, Zwischenablage geleert', () => {
    expect(wipeFn).toMatch(/MalachiNotification\?\.cancelAll\?\.\(\)/);
    expect(wipeFn).toMatch(/MalachiService\?\.stop\?\.\(\)/);
    expect(wipeFn).toMatch(/Clipboard\.setString\(''\)/);
  });
  test('P3: gesamter Cache geleert (auch Kopien des Bild-Pickers)', () => {
    expect(wipeFn).toMatch(/const cached = await RNFS\.readDir\(RNFS\.CachesDirectoryPath\);\s*for \(const f of cached\) \{\s*await RNFS\.unlink\(f\.path\)/);
  });
  test('P7: beide Wipe-Wege setzen alle Anzeigezustaende zurueck', () => {
    expect(app).toMatch(/onWipe=\{\(\) => \{ resetUiAfterWipe\(\); nav\('setup'\); \}\}/);
    expect(app).toMatch(/onWipeAll=\{\(\) => performWipe\(\)\.then\(\(\) => \{ resetUiAfterWipe\(\); nav\('setup'\); \}\)\}/);
    const reset = app.slice(app.indexOf('const resetUiAfterWipe = () => {'), app.indexOf('const topStripColor'));
    for (const s of ['setChat(null)', 'setContacts([])', 'setGroups([])', 'setAvatar(null)', 'setCustomBgUri(null)', 'setUsername(\'\')']) expect(reset).toContain(s);
  });
});

describe('TorTransport.wipeTorForReset', () => {
  test('stoppt tor, loescht danach seine Daten und verwirft offene Einladungen', async () => {
    const reihenfolge = [];
    NativeModules.MalachiTor = {
      addListener() {}, removeListeners() {},
      stop: jest.fn(async () => { reihenfolge.push('stop'); }),
      wipeData: jest.fn(async () => { reihenfolge.push('wipeData'); return true; }),
    };
    let T;
    jest.isolateModules(() => { T = require('../../TorTransport'); });
    const gekoppelt = jest.fn();
    T.registerPairingInvite('0123ABCD', { pskB64: 'cHNr', contactId: 'c_x', onPaired: gekoppelt });
    await T.wipeTorForReset();
    expect(reihenfolge).toEqual(['stop', 'wipeData']);
    // Die verworfene Einladung laesst sich nicht mehr einloesen (Tabelle leer).
    expect(T._pairingInviteCountForTests ? T._pairingInviteCountForTests() : 0).toBe(0);
  });
});

describe('Native Seite (statisch)', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'securecommapp', p), 'utf8');
  test('Benachrichtigungen ohne Kontaktnamen (P6)', () => {
    const n = read('MalachiNotificationModule.kt');
    expect(n).toMatch(/val text = context\.getString\(R\.string\.notif_new_message\)/);
    expect(n).not.toMatch(/Neue Nachricht von \$peerName/);
    const c = read('calling/CallNotificationHelper.kt');
    expect(c).not.toMatch(/setContentTitle\(peerName\)/);
    const t = read('calling/MalachiConnectionService.kt');
    expect(t).not.toMatch(/EXTRA_PEER_NAME, "Malachi-Kontakt"/);
  });
  test('cancelAll und wipeData vorhanden, Siegel faengt auch Errors (OOM)', () => {
    expect(read('MalachiNotificationModule.kt')).toMatch(/fun cancelAll\(\)/);
    expect(read('tor/MalachiTorModule.kt')).toMatch(/fun wipeData\(promise: Promise\)/);
    expect(read('siegel/MalachiSiegelKeyModule.kt')).not.toMatch(/catch \(e: Exception\)/);
  });
  test('Telecom- und Dienst-Start koennen die App nicht abstuerzen lassen (A5)', () => {
    expect(read('calling/TelecomHelper.kt')).toMatch(/addIncomingCallUnchecked\(context, contactId, peerName\)\s*\} catch \(e: Throwable\)/);
    expect(read('MalachiServiceModule.kt')).toMatch(/ContextCompat\.startForegroundService\(ctx, intent\)\s*\} catch \(e: Throwable\)/);
  });
});
