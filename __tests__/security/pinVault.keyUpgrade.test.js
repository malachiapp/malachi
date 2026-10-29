// Krypto-Review 2026-10-25, V3/K-05: PIN-Tresor mit Chip-Schluessel, der nur
// bei entsperrtem Geraet rechnet (setUnlockedDeviceRequired), und sichere
// Umstellung bestehender Tresore (PinVault.js advanceKeyMigration).
// Echter Produktionscode; nur der Chip ist eine Attrappe (fakePinKeyMulti:
// mehrere Keystore-Schluessel, gesperrtes Geraet, kaputter Schluessel).
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKeyMulti } = require('./helpers/pinVaultTestHelpers');
const { NativeModules } = require('react-native');

const ES = require('react-native-encrypted-storage').default;
const PV = require('../../PinVault');

const PIN = '4829';          // 4 Stellen bleiben eine normale Wahl
const DURESS = '9911';
const CHAT = JSON.stringify([{ text: 'geheim', id: 'm1' }]);
let pinKey;

// Sicht eines Builds/einer Version, die nur den alten Schluessel kennt (1.1).
const legacyView = (m) => ({
  createKey: m.createKey, hasKey: m.hasKey, destroyKey: m.destroyKey, deriveKey: m.deriveKey,
  bioAvailable: m.bioAvailable, bioEnroll: m.bioEnroll, bioUnwrap: m.bioUnwrap, bioRemove: m.bioRemove,
});

const restart = () => PV._resetPinVaultForTests();
const record = async () => JSON.parse(await ES.getItem(PV.RECORD_KEY));
const dump = () => new Map(ES.__store);

// Tresor wie von 1.1 angelegt (nur malachi_pin_v1), mit Verlauf und optional Notfall-PIN.
async function v11Vault({ duress = false } = {}) {
  NativeModules.MalachiPinKey = legacyView(pinKey);
  restart();
  await PV.create(PIN);
  await PV.setItem('chat_c_x', CHAT);
  if (duress) expect(await PV.setDuressPin(DURESS)).toBe('ok');
  PV.lock();
  NativeModules.MalachiPinKey = pinKey;          // Update auf die neue Version
  restart();
  expect((await record()).key).toBeUndefined();
}

async function readChat() {
  return PV.getItem('chat_c_x');
}

beforeEach(async () => {
  restart();
  await ES.clear();
  pinKey = fakePinKeyMulti();
  NativeModules.MalachiPinKey = pinKey;
  jest.restoreAllMocks();
});

describe('neuer Tresor', () => {
  test('nutzt den Schluessel mit "nur bei entsperrtem Geraet"; 4-stellige PIN funktioniert wie bisher', async () => {
    await PV.create(PIN);
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: false, unlockedRequired: true });
    expect(pinKey.keys.get(PV.KEY_V2).unlockedRequired).toBe(true);
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);
    await PV.setItem('chat_c_x', CHAT);
    PV.lock();
    expect(await PV.unlockWithPin('0000')).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(await readChat()).toBe(CHAT);
  });

  test('gesperrtes Geraet: der Chip rechnet nicht - technischer Fehler, KEIN Fehlversuch', async () => {
    await PV.create(PIN);
    PV.lock();
    pinKey.deviceLocked = true;
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'nokey' });
    expect(await PV.unlockWithPin('0000')).toEqual({ ok: false, reason: 'nokey' });
    pinKey.deviceLocked = false;
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
  });

  test('Geraet ohne das Merkmal (aeltere Android-Version): Tresor funktioniert, Merkmal ehrlich als nicht gesetzt', async () => {
    pinKey.supportsUnlocked = false;
    await PV.create(PIN);
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, unlockedRequired: false });
    PV.lock();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
  });

  test('Notfall-PIN und Fehlversuch-Logik unveraendert; eine Ableitung (Argon2id einmal) je Eingabe', async () => {
    await PV.create(PIN);
    expect(await PV.setDuressPin(DURESS)).toBe('ok');
    expect(await PV.setDuressPin(PIN)).toBe('same');
    PV.lock();
    pinKey.argon = 0;
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect(pinKey.argon).toBe(1);
    expect(await PV.unlockWithPin('1234')).toEqual({ ok: false, reason: 'wrong' });
    expect(pinKey.argon).toBe(2);
  });

  test('Loeschen vernichtet alle Chip-Schluessel (alt und neu) und den Fingerabdruck-Schluessel', async () => {
    await PV.create(PIN);
    await pinKey.createKey();                    // Rest eines alten Schluessels
    await PV.wipe();
    expect(pinKey.keys.size).toBe(0);
    expect(await ES.getItem(PV.RECORD_KEY)).toBeNull();
  });
});

describe('Umstellung bestehender Tresore (1.1 -> neu)', () => {
  test('Schritt 1 beim ersten Entsperren, Schritt 2 erst beim naechsten; Speicherabbild bleibt bis auf den Tresor-Datensatz erhalten', async () => {
    await v11Vault();
    const before = dump();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: true });
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(true);           // alter Schluessel bleibt vorerst
    expect(await ES.getItem(PV.RECORD_BAK_KEY)).toBe(await ES.getItem(PV.RECORD_KEY));
    for (const [k, v] of before) {
      if (k === PV.RECORD_KEY || k === PV.RECORD_BAK_KEY) continue;
      expect([k, ES.__store.get(k)]).toEqual([k, v]);
    }
    expect(await readChat()).toBe(CHAT);
    PV.lock();
    restart();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);    // laeuft ueber den neuen Schluessel
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: false });
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);           // jetzt erst geloescht
    expect((await record()).prevKey).toBeUndefined();
    expect(await readChat()).toBe(CHAT);
    PV.lock();
    expect(await PV.unlockWithPin('0000')).toEqual({ ok: false, reason: 'wrong' });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
  });

  test('mit Notfall-PIN: Pruefwert bleibt am alten Schluessel, funktioniert durchgehend; neu gesetzt -> alter Schluessel frei', async () => {
    await v11Vault({ duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: true, duressKey: PV.KEY_V1 });
    PV.lock();
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);    // Schritt 2
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: false, duressKey: PV.KEY_V1 });
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(true);           // noch fuer den Pruefwert noetig
    PV.lock();
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(await PV.setDuressPin(DURESS)).toBe('ok');        // neu setzen
    expect(PV.keyInfo().duressKey).toBe(PV.KEY_V2);
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);
    PV.lock();
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(await readChat()).toBe(CHAT);
  });

  test('Notfall-PIN entfernen gibt den alten Schluessel ebenfalls frei', async () => {
    await v11Vault({ duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    PV.lock();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    await PV.clearDuressPin();
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);
    PV.lock();
    expect((await PV.unlockWithPin(DURESS)).reason).toBe('wrong');
  });

  test('Fingerabdruck bleibt waehrend und nach der Umstellung gueltig', async () => {
    await v11Vault();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(await PV.enrollBiometrics({ title: 'x', cancel: 'y' })).toBe(true);
    PV.lock();
    expect((await PV.unlockWithBiometrics({ title: 'x', cancel: 'y' })).ok).toBe(true);
    PV.lock();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);      // Schritt 2
    PV.lock();
    expect((await PV.unlockWithBiometrics({ title: 'x', cancel: 'y' })).ok).toBe(true);
    expect(await readChat()).toBe(CHAT);
  });
});

describe('Abbruch mittendrin - nie Datenverlust', () => {
  // "Absturz": ab dem n-ten Schreibvorgang auf den Tresor-Datensatz schlaegt
  // jedes weitere Schreiben fehl (Prozess tot), danach Neustart.
  function crashAfterRecordWrites(n) {
    let writes = 0;
    const orig = ES.setItem;
    return jest.spyOn(ES, 'setItem').mockImplementation(async (k, v) => {
      if (k === PV.RECORD_KEY || k === PV.RECORD_BAK_KEY) {
        if (writes >= n) throw new Error('Absturz (simuliert)');
        writes++;
      }
      return orig.call(ES, k, v);
    });
  }

  async function afterCrashStillOpens() {
    PV.lock();
    restart();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(await readChat()).toBe(CHAT);
    // Selbst mit kaputtem Haupt-Datensatz oeffnet die Sicherung.
    PV.lock();
    await ES.setItem(PV.RECORD_KEY, '{kaputt');
    restart();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(await readChat()).toBe(CHAT);
  }

  test('Schluessel laesst sich nicht anlegen: Entsperren klappt, Tresor bleibt am alten Schluessel, naechstes Mal erneut', async () => {
    await v11Vault();
    pinKey.failCreate = true;
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V1, pending: false });
    pinKey.failCreate = false;
    PV.lock();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: true });
  });

  test.each([0, 1, 2])('Absturz in Schritt 1 nach %i Datensatz-Schreibvorgaengen', async (n) => {
    await v11Vault();
    const spy = crashAfterRecordWrites(n);
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });   // Entsperren selbst gelingt immer
    spy.mockRestore();
    await afterCrashStillOpens();
  });

  test.each([0, 1, 2])('Absturz in Schritt 2 nach %i Datensatz-Schreibvorgaengen', async (n) => {
    await v11Vault();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    PV.lock();
    restart();
    const spy = crashAfterRecordWrites(n);
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    spy.mockRestore();
    // Der alte Schluessel ist erst nach erfolgreichem Zuruecklesen weg.
    if (n < 2) expect(pinKey.keys.has(PV.KEY_V1)).toBe(true);
    await afterCrashStillOpens();
  });

  test('Rueckleseprobe schlaegt fehl (Speicher liefert anderes zurueck): alter Stand wird wiederhergestellt', async () => {
    await v11Vault();
    const orig = ES.getItem;
    let tamper = true;
    jest.spyOn(ES, 'getItem').mockImplementation(async (k) => {
      const v = await orig.call(ES, k);
      if (tamper && k === PV.RECORD_BAK_KEY && v && v.includes('malachi_pin_v2')) { tamper = false; return v.replace(/"c":"/, '"c":"A'); }
      return v;
    });
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect((await record()).key).toBeUndefined();               // zurueck auf v1
    expect(pinKey.keys.has(PV.KEY_V2)).toBe(false);
    await afterCrashStillOpens();
  });

  test('neuer Schluessel spaeter unbrauchbar (vor Schritt 2): Tresor oeffnet ueber den alten Wickel, Umstellung wird zurueckgenommen', async () => {
    await v11Vault();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    PV.lock();
    pinKey.broken.add(PV.KEY_V2);
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V1, pending: false });
    expect(Number.isFinite((await record()).keyRetryAt)).toBe(true);
    pinKey.broken.clear();
    PV.lock();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(PV.keyInfo().key).toBe(PV.KEY_V1);                     // nicht sofort erneut
    expect(await readChat()).toBe(CHAT);
  });
});

// 1.3: "PIN aendern" (PinChange.js) trifft auf die Umstellung. Der Tresor hat
// dann zwei Wickel (neuer + alter Schluessel) und der Notfall-Pruefwert haengt
// ggf. noch am alten Schluessel - beides muss mitziehen, sonst oeffnete ein
// Rueckfall nur mit der ALTEN PIN oder die Notfall-PIN liefe ins Leere.
describe('PIN aendern waehrend der Umstellung', () => {
  const NEW = '5173';

  test('beide Wickel mit der neuen PIN: Rueckfall auf den alten Schluessel oeffnet nur mit ihr, Notfall-PIN wirkt weiter', async () => {
    await v11Vault({ duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);           // Schritt 1
    const before = await record();
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: true, duressKey: PV.KEY_V1 });
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    const after = await record();
    expect(after.prevKey.alias).toBe(PV.KEY_V1);
    expect(after.prevKey.wrap).not.toEqual(before.prevKey.wrap);
    expect(after.wrap).not.toEqual(before.wrap);
    expect([after.duress, after.duressKey]).toEqual([before.duress, PV.KEY_V1]);
    expect(await ES.getItem(PV.RECORD_BAK_KEY)).toBe(await ES.getItem(PV.RECORD_KEY));
    PV.lock();
    restart();
    pinKey.broken.add(PV.KEY_V2);                                   // neuer Schluessel faellt aus
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
    expect(PV.keyInfo().key).toBe(PV.KEY_V1);
    expect(await readChat()).toBe(CHAT);
  });

  test('danach Schritt 2 ueber den neuen Schluessel; alte PIN falsch, alter Schluessel bleibt fuer den Notfall-Pruefwert', async () => {
    await v11Vault({ duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    PV.lock();
    restart();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: false, duressKey: PV.KEY_V1 });
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(true);
    PV.lock();
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
    expect(await readChat()).toBe(CHAT);
  });

  test('Notfall-PIN (am alten Schluessel) als neue oder alte PIN: abgelehnt, Datensatz unveraendert', async () => {
    await v11Vault({ duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    const before = await ES.getItem(PV.RECORD_KEY);
    expect(await PV.changePin(PIN, DURESS)).toBe('duress');
    expect(await PV.changePin(DURESS, NEW)).toBe('wrong');
    expect(await PV.changePin('0000', NEW)).toBe('wrong');
    expect(await ES.getItem(PV.RECORD_KEY)).toBe(before);
    expect(await PV.verifyPin(DURESS)).toBe('duress');
    expect(await PV.verifyPin(PIN)).toBe('ok');
    expect(await PV.verifyPin(NEW)).toBe('wrong');
  });

  test('Laengenwechsel (Notfall-PIN entfaellt) mitten in der Umstellung: alter Schluessel erst nach Schritt 2 frei', async () => {
    await v11Vault({ duress: true });
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(await PV.changePin(PIN, '615243', { dropDuress: true })).toBe('ok');
    expect(PV.hasDuressPin()).toBe(false);
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: true, duressKey: null });
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(true);                 // Rueckfall-Wickel braucht ihn noch
    PV.lock();
    restart();
    expect((await PV.unlockWithPin(DURESS)).reason).toBe('wrong');
    expect(await PV.unlockWithPin('615243')).toEqual({ ok: true });
    expect(PV.keyInfo()).toMatchObject({ key: PV.KEY_V2, pending: false });
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);
    expect(PV.pinLength()).toBe(6);
    expect(await readChat()).toBe(CHAT);
  });

  test('alter Schluessel waehrend der Umstellung verloren: PIN aendern klappt, der wertlose Rueckfall-Wickel entfaellt', async () => {
    await v11Vault();
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    pinKey.broken.add(PV.KEY_V1);
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    expect((await record()).prevKey).toBeUndefined();
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);
    pinKey.broken.clear();
    PV.lock();
    restart();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
    expect(await readChat()).toBe(CHAT);
  });

  test('neuer Tresor (nur neuer Schluessel): PIN aendern ohne Umstellungsreste', async () => {
    await PV.create(PIN);
    await PV.setItem('chat_c_x', CHAT);
    expect(await PV.setDuressPin(DURESS)).toBe('ok');
    expect(await PV.changePin(PIN, NEW)).toBe('ok');
    const r = await record();
    expect([r.key, r.prevKey, r.duressKey]).toEqual([PV.KEY_V2, undefined, undefined]);
    expect(pinKey.keys.has(PV.KEY_V1)).toBe(false);
    PV.lock();
    restart();
    expect(await PV.unlockWithPin(DURESS)).toEqual({ ok: false, duress: true });
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'wrong' });
    expect(await PV.unlockWithPin(NEW)).toEqual({ ok: true });
    expect(await readChat()).toBe(CHAT);
  });
});

describe('Argon2id-Parameter', () => {
  test('bewusst unveraendert (32 MiB, t=3) - begruendet in PinVault.js/PIN_VAULT_DESIGN.md', () => {
    expect(PV.KDF).toEqual({ alg: 'argon2id+chip-hmac', memKiB: 32 * 1024, iterations: 3 });
  });
});
