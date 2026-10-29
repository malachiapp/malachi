// App-PIN und Notfall-PIN aendern (PinChange.js, PinVault.changePin/verifyPin;
// Nutzerwunsch 29.10.2026): nur mit der richtigen aktuellen PIN, Fehlversuche
// im selben Zaehler wie am Sperrbildschirm, Daten/Fingerabdruck/Notfall-PIN
// bleiben gueltig. Echter Produktionscode, nur der Chip ist eine Attrappe.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKey } = require('./helpers/pinVaultTestHelpers');
const { NativeModules } = require('react-native');
const pinKey = fakePinKey();
NativeModules.MalachiPinKey = pinKey;

let mockProNow = false;
jest.mock('../../LicenseManager', () => {
  const actual = jest.requireActual('../../LicenseManager');
  return { ...actual, isProVerified: jest.fn(async () => mockProNow) };
});

const ES = require('react-native-encrypted-storage').default;
const PV = require('../../PinVault');
const PC = require('../../PinChange');

const PIN = '482913';
const NEW = '730155';
const DURESS = '111222';
const BIO = { title: 'Malachi entsperren', cancel: 'PIN eingeben' };

beforeEach(async () => {
  PV._resetPinVaultForTests();
  await ES.clear();
  mockProNow = false;
  pinKey.bioMode = 'ok';
});

describe('PinVault.verifyPin', () => {
  test('prueft, ohne zu entsperren, zu sperren oder zu loeschen', async () => {
    await PV.create(PIN);
    await PV.setDuressPin(DURESS);
    expect(await PV.verifyPin(PIN)).toBe('ok');
    expect(await PV.verifyPin('000000')).toBe('wrong');
    expect(await PV.verifyPin(DURESS)).toBe('duress');
    expect(PV.isUnlocked()).toBe(true);           // offen geblieben
    PV.lock();
    expect(await PV.verifyPin(PIN)).toBe('ok');
    expect(PV.isUnlocked()).toBe(false);          // gesperrt geblieben
    expect(await PV.vaultState()).toBe('present');
  });
});

describe('PinVault.changePin', () => {
  test('alte PIN noetig; danach oeffnet nur noch die neue - Verlauf bleibt lesbar', async () => {
    await PV.create(PIN);
    await PV.setItem('chat_abc', JSON.stringify([{ id: 1, text: 'Hallo' }]));
    expect(await PV.changePin('000000', NEW)).toBe('wrong');
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    PV._resetPinVaultForTests();                  // wie ein Neustart
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
    expect(JSON.parse(await PV.getItem('chat_abc'))[0].text).toBe('Hallo');
    // Datensatz und Sicherungskopie gleich, PIN steht nirgends im Klartext
    const raw = await ES.getItem(PV.RECORD_KEY);
    expect(await ES.getItem(PV.RECORD_BAK_KEY)).toBe(raw);
    expect(raw).not.toContain(NEW);
    expect(JSON.parse(raw).len).toBe(6);
  });

  test('nur entsperrt; gleiche PIN wird abgelehnt', async () => {
    await PV.create(PIN);
    expect(await PV.changePin(PIN, PIN)).toBe('same');
    PV.lock();
    expect(await PV.changePin(PIN, NEW)).toBe('error');
    PV._resetPinVaultForTests();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
  });

  test('Notfall-PIN bleibt gueltig; neue PIN darf nicht die Notfall-PIN sein', async () => {
    await PV.create(PIN);
    expect(await PV.setDuressPin(DURESS)).toBe('ok');
    expect(await PV.changePin(PIN, DURESS)).toBe('duress');
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    PV._resetPinVaultForTests();
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
  });

  test('andere Laenge mit dropDuress: Notfall-PIN entfernt, Laenge im Datensatz', async () => {
    await PV.create(PIN);
    await PV.setDuressPin(DURESS);
    expect(await PV.changePin(PIN, '4821', { dropDuress: true })).toBe('ok');
    expect(PV.hasDuressPin()).toBe(false);
    expect(PV.pinLength()).toBe(4);
    PV._resetPinVaultForTests();
    await PV.ready();
    expect(PV.pinLength()).toBe(4);
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin('4821')).toEqual({ ok: true });
  });

  test('Fingerabdruck bleibt nach dem PIN-Wechsel gueltig', async () => {
    await PV.create(PIN);
    expect(await PV.enrollBiometrics(BIO)).toBe(true);
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    PV._resetPinVaultForTests();
    expect(await PV.unlockWithBiometrics(BIO)).toEqual({ ok: true });
  });
});

describe('PinChange.confirmAppPin - gemeinsamer Fehlversuchs-Zaehler', () => {
  test('richtige PIN setzt den Zaehler zurueck', async () => {
    await PV.create(PIN);
    await ES.setItem(PC.ATTEMPTS_KEY, '2');
    expect(await PC.confirmAppPin(PIN)).toEqual({ ok: true });
    expect(await ES.getItem(PC.ATTEMPTS_KEY)).toBeNull();
  });

  test('falsche PIN zaehlt hoch; der dritte Versuch sperrt wie am Sperrbildschirm', async () => {
    await PV.create(PIN);
    const a = await PC.confirmAppPin('000000');
    expect(a).toMatchObject({ ok: false, reason: 'wrong', attempts: 1, wipe: false, lockMs: 0 });
    await PC.confirmAppPin('000001');
    const c = await PC.confirmAppPin('000002');
    expect(c).toMatchObject({ ok: false, reason: 'wrong', attempts: 3, lockMs: 30000 });
    expect(await ES.getItem(PC.ATTEMPTS_KEY)).toBe('3');
    expect(parseInt(await ES.getItem(PC.LOCKED_UNTIL_KEY), 10)).toBeGreaterThan(Date.now());
    // Waehrend der Sperre wird nicht einmal geprueft (kein Raten moeglich)
    const before = pinKey.derives;
    const d = await PC.confirmAppPin(PIN);
    expect(d.reason).toBe('locked');
    expect(d.waitMs).toBeGreaterThan(0);
    expect(pinKey.derives).toBe(before);
  });

  test('Notfall-PIN zaehlt hier als falsche PIN und loescht nichts', async () => {
    await PV.create(PIN);
    await PV.setDuressPin(DURESS);
    const r = await PC.confirmAppPin(DURESS);
    expect(r).toMatchObject({ ok: false, reason: 'wrong', attempts: 1, wipe: false });
    expect(await PV.vaultState()).toBe('present');
    expect(PV.isUnlocked()).toBe(true);
  });

  test('Vollversion: der fuenfte Fehlversuch verlangt das Loeschen (wie am Sperrbildschirm)', async () => {
    await PV.create(PIN);
    mockProNow = true;
    await ES.setItem(PC.ATTEMPTS_KEY, '4');
    const r = await PC.confirmAppPin('000000');
    expect(r).toMatchObject({ ok: false, reason: 'wrong', attempts: 5, wipe: true });
  });

  test('ohne Vollversion nie Loeschen, sondern Sperrfrist', async () => {
    await PV.create(PIN);
    await ES.setItem(PC.ATTEMPTS_KEY, '4');
    const r = await PC.confirmAppPin('000000');
    expect(r).toMatchObject({ ok: false, reason: 'wrong', attempts: 5, wipe: false });
    expect(r.lockMs).toBeGreaterThan(0);
  });

  test('Chip-/Speicherfehler ist kein Fehlversuch', async () => {
    await PV.create(PIN);
    pinKey.deriveKey.mockImplementationOnce(async () => { throw new Error('Chip'); });
    expect(await PC.confirmAppPin(PIN)).toEqual({ ok: false, reason: 'error' });
    expect(await ES.getItem(PC.ATTEMPTS_KEY)).toBeNull();
  });
});

describe('PinChange.changeAppPin', () => {
  test('mit Tresor: Laenge 6 -> 4 entfernt die Notfall-PIN und meldet das', async () => {
    await PV.create(PIN);
    await PV.setDuressPin(DURESS);
    expect(await PC.changeAppPin(PIN, '12345')).toEqual({ result: 'invalid' });
    expect(await PC.changeAppPin(PIN, '9070')).toEqual({ result: 'ok', duressRemoved: true });
    expect(await PC.currentPinLength()).toBe(4);
    expect(await ES.getItem(PC.LENGTH_KEY)).toBe('4');
    expect(await PC.hasDuress()).toBe(false);
  });

  test('gleiche Laenge: Notfall-PIN bleibt', async () => {
    await PV.create(PIN);
    await PV.setDuressPin(DURESS);
    expect(await PC.changeAppPin(PIN, NEW)).toEqual({ result: 'ok', duressRemoved: false });
    expect(await PC.hasDuress()).toBe(true);
    expect(await PC.changeAppPin(NEW, DURESS)).toEqual({ result: 'duress' });
  });

  test('Altbestand ohne Tresor: PIN im verschluesselten Speicher wird ersetzt', async () => {
    await ES.setItem('app_pin', '1234');
    await ES.setItem('duress_pin', '9999');
    expect(await PC.confirmAppPin('1234')).toEqual({ ok: true });
    expect(await PC.changeAppPin('0000', '5678')).toEqual({ result: 'wrong' });
    expect(await PC.changeAppPin('1234', '9999')).toEqual({ result: 'duress' });
    expect(await PC.changeAppPin('1234', '5678')).toEqual({ result: 'ok', duressRemoved: false });
    expect(await ES.getItem('app_pin')).toBe('5678');
    expect(await PC.changeAppPin('5678', '567890')).toEqual({ result: 'ok', duressRemoved: true });
    expect(await ES.getItem('duress_pin')).toBeNull();
  });
});

describe('PinChange.setDuress / removeDuress', () => {
  test('Laenge muss passen, App-PIN ist verboten', async () => {
    await PV.create(PIN);
    expect(await PC.setDuress('1234')).toBe('length');
    expect(await PC.setDuress(PIN)).toBe('same');
    expect(await PC.setDuress(DURESS)).toBe('ok');
    expect(await PC.hasDuress()).toBe(true);
    await PC.removeDuress();
    expect(await PC.hasDuress()).toBe(false);
  });
});
