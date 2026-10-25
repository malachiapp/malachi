// PIN-Tresor (PinVault.js, Audit 2026-10-25 E1): Chatverlaeufe, Vorschau-
// texte und Schluessel der Empfangs-Ablage sind an die App-PIN gebunden.
// Geprueft wird der echte Produktionscode; nur der Chip (Argon2id + HMAC im
// Keystore, Fingerabdruck-Dialog) ist durch eine Attrappe ersetzt.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { fakePinKey } = require('./helpers/pinVaultTestHelpers');
const { NativeModules } = require('react-native');
const pinKey = fakePinKey();
NativeModules.MalachiPinKey = pinKey;

const ES = require('react-native-encrypted-storage').default;
const PV = require('../../PinVault');
const BG = require('../../BackgroundSync');

const PIN = '482913';
const BIO = { title: 'Malachi entsperren', cancel: 'PIN eingeben' };

// Alles, was im (Geraete-)Speicher liegt, als ein Text - fuer "steht nirgends im Klartext".
async function storageDump() {
  const store = ES.__store;
  if (!store) throw new Error('Speicher-Attrappe ohne __store');
  return [...store.entries()].map(([k, v]) => k + '=' + v).join('\n');
}

beforeEach(async () => {
  PV._resetPinVaultForTests();
  await ES.clear();
  pinKey.bioMode = 'ok';
  pinKey.createKey.mockClear();
  pinKey.destroyKey.mockClear();
});

describe('Einrichten und Entsperren', () => {
  test('PIN oeffnet den Tresor, falsche PIN nicht; die PIN selbst wird nirgends gespeichert', async () => {
    expect(await PV.vaultState()).toBe('absent');
    await PV.create(PIN);
    expect(PV.isUnlocked()).toBe(true);
    expect(await PV.vaultState()).toBe('present');
    expect(await ES.getItem('app_pin')).toBeNull();
    const rec = JSON.parse(await ES.getItem(PV.RECORD_KEY));
    expect(JSON.stringify(rec)).not.toContain(PIN);
    expect(rec.security).toBe('strongbox');
    expect(await ES.getItem(PV.RECORD_BAK_KEY)).toBe(await ES.getItem(PV.RECORD_KEY));

    PV.lock();
    expect(PV.isUnlocked()).toBe(false);
    expect(await PV.unlockWithPin('000000')).toEqual({ ok: false, reason: 'wrong' });
    expect(PV.isUnlocked()).toBe(false);
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: true });
    expect(PV.isUnlocked()).toBe(true);
  });

  test('Neustart: Tresor wird aus dem Speicher geladen, gesperrt', async () => {
    await PV.create(PIN);
    PV._resetPinVaultForTests();
    expect(PV.isUnlocked()).toBe(false);
    expect(await PV.vaultState()).toBe('present');
    expect(PV.isLockedVault()).toBe(true);
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
  });

  test('Kein zweiter Tresor ueber einen bestehenden (Chip-Schluessel wuerde ersetzt)', async () => {
    await PV.create(PIN);
    pinKey.createKey.mockClear();
    await expect(PV.create('111111')).rejects.toThrow(/existiert bereits/);
    expect(pinKey.createKey).not.toHaveBeenCalled();
  });

  test('Unlesbarer Datensatz gilt nie als "kein Tresor"; Sicherungskopie springt ein', async () => {
    await PV.create(PIN);
    await ES.setItem(PV.RECORD_KEY, '{kaputt');
    PV._resetPinVaultForTests();
    expect(await PV.vaultState()).toBe('present');                 // aus der Sicherung
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
    expect(JSON.parse(await ES.getItem(PV.RECORD_KEY)).v).toBe(1); // wiederhergestellt
    await ES.setItem(PV.RECORD_KEY, '{kaputt');
    await ES.setItem(PV.RECORD_BAK_KEY, '{auch kaputt');
    PV._resetPinVaultForTests();
    expect(await PV.vaultState()).toBe('unknown');
    pinKey.createKey.mockClear();
    await expect(PV.create(PIN)).rejects.toThrow(/nicht lesbar/);
    expect(pinKey.createKey).not.toHaveBeenCalled();
  });

  test('Chip-Schluessel fehlt: technischer Fehler, kein Fehlversuch', async () => {
    await PV.create(PIN);
    PV.lock();
    await pinKey.destroyKey();
    expect(await PV.unlockWithPin(PIN)).toEqual({ ok: false, reason: 'nokey' });
  });
});

describe('Notfall-PIN', () => {
  test('Altbestand: Notfall-PIN wird beim Umstellen nur als Pruefwert uebernommen', async () => {
    await PV.create(PIN, { duressPin: '777777' });
    const rec = await ES.getItem(PV.RECORD_KEY);
    expect(rec).not.toContain('777777');
    expect(PV.hasDuressPin()).toBe(true);
    PV.lock();
    expect(await PV.unlockWithPin('777777')).toEqual({ ok: false, duress: true });
    expect(PV.isUnlocked()).toBe(false);
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
  });

  test('Setzen in den Einstellungen: echte PIN wird abgelehnt, Entfernen wirkt', async () => {
    await PV.create(PIN);
    expect(await PV.setDuressPin(PIN)).toBe('same');
    expect(PV.hasDuressPin()).toBe(false);
    expect(await PV.setDuressPin('555555')).toBe('ok');
    PV.lock();
    expect((await PV.unlockWithPin('555555')).duress).toBe(true);
    await PV.unlockWithPin(PIN);
    await PV.clearDuressPin();
    PV.lock();
    expect(await PV.unlockWithPin('555555')).toEqual({ ok: false, reason: 'wrong' });
  });

  test('Gesperrt laesst sich keine Notfall-PIN setzen', async () => {
    await PV.create(PIN);
    PV.lock();
    expect(await PV.setDuressPin('555555')).toBe('error');
  });
});

describe('Verlaeufe', () => {
  const KEY = 'chat_c_bob';
  const HIST = JSON.stringify([{ id: '1', text: 'Geheimes Treffen um acht', mine: true, status: 'sent' }]);

  test('Entsperrt verschluesselt gespeichert, an den Schluesselnamen gebunden', async () => {
    await ES.setItem('probe', 'Geheimes Treffen');                // Gegenprobe: der Dump sieht Klartext
    expect(await storageDump()).toContain('Geheimes Treffen');
    await ES.removeItem('probe');
    await PV.create(PIN);
    await PV.setItem(KEY, HIST);
    const raw = await ES.getItem(KEY);
    expect(raw.startsWith('pv1:d:')).toBe(true);
    expect(await storageDump()).not.toContain('Geheimes Treffen');
    expect(await PV.getItem(KEY)).toBe(HIST);
    // Umhaengen auf einen anderen Kontakt faellt auf (AD = Schluesselname).
    await ES.setItem('chat_c_eve', raw);
    await expect(PV.getItem('chat_c_eve')).rejects.toMatchObject({ code: 'VAULT_CORRUPT' });
  });

  test('Gesperrt: Lesen wirft (nie "leer"), Schreiben versiegelt; nach dem Entsperren lesbar', async () => {
    await PV.create(PIN);
    await PV.setItem(KEY, HIST);
    PV.lock();
    await expect(PV.getItem(KEY)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    const newer = JSON.stringify([...JSON.parse(HIST), { id: '2', text: 'Und zwar am Hafen', mine: false }]);
    await PV.setItem(KEY, newer);
    expect((await ES.getItem(KEY)).startsWith('pv1:s:')).toBe(true);
    expect(await storageDump()).not.toContain('Hafen');
    await PV.unlockWithPin(PIN);
    expect(await PV.getItem(KEY)).toBe(newer);
    expect((await ES.getItem(KEY)).startsWith('pv1:d:')).toBe(true); // beim Lesen umgeschrieben
  });

  test('Gesperrt geaenderte Haekchen und Loeschungen landen versiegelt im Journal und werden eingearbeitet', async () => {
    await PV.create(PIN);
    await PV.setItem(KEY, JSON.stringify([
      { id: 'a', text: 'eins', mine: true, status: 'pending' },
      { id: 'b', text: 'zwei', mine: false },
      { id: 'c', text: 'drei', mine: true, status: 'sent' },
    ]));
    PV.lock();
    expect((await PV.update(KEY, { op: 'status', u: [['a', 'delivered']] })).journaled).toBe(true);
    expect((await PV.update(KEY, { op: 'delete', id: 'b' })).journaled).toBe(true);
    // doppelt zugestellt: idempotent
    await PV.update(KEY, { op: 'delete', id: 'b' });
    const journal = JSON.parse(await ES.getItem('vj_' + KEY));
    expect(journal).toHaveLength(3);
    expect(journal.every((j) => j.startsWith('pv1:s:'))).toBe(true);
    expect(await storageDump()).not.toMatch(/delivered|"delete"/);
    await PV.unlockWithPin(PIN);
    const list = JSON.parse(await PV.getItem(KEY));
    expect(list.map((m) => m.id)).toEqual(['a', 'c']);
    expect(list[0].status).toBe('delivered');
    expect(await ES.getItem('vj_' + KEY)).toBeNull();
  });

  test('Entsperrt wirken Aenderungen sofort; Haekchen werden nie zurueckgestuft', async () => {
    await PV.create(PIN);
    await PV.setItem(KEY, JSON.stringify([{ id: 'a', mine: true, status: 'delivered' }]));
    const r = await PV.update(KEY, { op: 'status', u: [['a', 'sent']] });
    expect(r.journaled).toBe(false);
    expect(JSON.parse(await PV.getItem(KEY))[0].status).toBe('delivered');
    expect(await ES.getItem('vj_' + KEY)).toBeNull();
  });

  test('Entfernen loescht auch das Journal (sonst kaemen alte Eintraege zurueck)', async () => {
    await PV.create(PIN);
    await PV.setItem(KEY, HIST);
    PV.lock();
    await PV.update(KEY, { op: 'delete', id: '1' });
    await PV.removeItem(KEY);
    expect(await ES.getItem(KEY)).toBeNull();
    expect(await ES.getItem('vj_' + KEY)).toBeNull();
  });

  test('Ohne Tresor (vor dem ersten Entsperren nach dem Update) alles wie bisher', async () => {
    await ES.setItem(KEY, HIST);
    expect(await PV.getItem(KEY)).toBe(HIST);
    await PV.update(KEY, { op: 'status', u: [['1', 'delivered']] });
    expect(JSON.parse(await ES.getItem(KEY))[0].status).toBe('delivered');   // Klartext wie in 1.0
    await PV.setItem(KEY, HIST);
    expect(await ES.getItem(KEY)).toBe(HIST);
  });
});

describe('Altbestand umstellen', () => {
  test('Klartext-Verlaeufe werden verschluesselt, Inhalt bleibt identisch, kaputte bleiben unangetastet', async () => {
    const a = JSON.stringify([{ id: '1', text: 'Hallo Alice', mine: false }]);
    const g = JSON.stringify([{ id: 'x', from: 'm_' + 'b'.repeat(32), text: 'Gruppe', time: 1 }]);
    await ES.setItem('chat_c_alice', a);
    await ES.setItem('gchat_g_1', g);
    await ES.setItem('settings', '{"lang":"de"}');
    await PV.create(PIN);
    const res = await PV.migrateKeys(['chat_c_alice', 'gchat_g_1', 'settings', 'chat_fehlt']);
    expect(res).toEqual({ migrated: 2, failed: 0 });
    expect((await ES.getItem('chat_c_alice')).startsWith('pv1:d:')).toBe(true);
    expect(await ES.getItem('settings')).toBe('{"lang":"de"}');      // kein Tresor-Schluessel
    expect(await PV.getItem('chat_c_alice')).toBe(a);
    expect(await PV.getItem('gchat_g_1')).toBe(g);
    expect(await storageDump()).not.toContain('Hallo Alice');
    // zweiter Lauf: nichts mehr zu tun
    expect(await PV.migrateKeys(['chat_c_alice', 'gchat_g_1'])).toEqual({ migrated: 0, failed: 0 });
  });
});

describe('Vorschautexte der Chatliste', () => {
  test('Versiegelt gespeichert (auch gesperrt), Anzeige nur entsperrt', async () => {
    await PV.create(PIN);
    PV.lock();
    const sealed = await PV.sealPreviewsIn([{ id: 'c1', last: 'Bin gleich da' }, { id: 'c2', last: '' }, { id: 'c3' }]);
    expect(sealed[0].last.startsWith('pv1:s:')).toBe(true);
    expect(sealed[1].last).toBe('');
    expect(sealed[2].last).toBeUndefined();
    expect(PV.previewText(sealed[0].last)).toBe('');
    await PV.unlockWithPin(PIN);
    expect(PV.previewText(sealed[0].last)).toBe('Bin gleich da');
    expect(PV.previewText('Klartext aus 1.0')).toBe('Klartext aus 1.0');
    // schon versiegelt: unveraendert
    expect((await PV.sealPreviewsIn(sealed))[0].last).toBe(sealed[0].last);
  });

  test('BackgroundSync.updateContacts/updateGroups versiegeln beim Schreiben', async () => {
    await PV.create(PIN);
    await ES.setItem('contacts', JSON.stringify([{ id: 'c1', name: 'Bob', last: 'alt' }]));
    const ui = await BG.updateContacts((cs) => cs.map((c) => ({ ...c, last: 'Neue Nachricht von Bob: Treffpunkt Bahnhof' })));
    expect(ui[0].last).toBe('Neue Nachricht von Bob: Treffpunkt Bahnhof');          // Anzeige bekommt Klartext
    const stored = JSON.parse(await ES.getItem('contacts'));
    expect(stored[0].name).toBe('Bob');
    expect(stored[0].last.startsWith('pv1:s:')).toBe(true);
    expect(await storageDump()).not.toContain('Bahnhof');
    await ES.setItem('groups', JSON.stringify([{ groupId: 'g1', name: 'Familie', last: 'Bob: Hallo' }]));
    await BG.updateGroups((gs) => gs);
    expect(JSON.parse(await ES.getItem('groups'))[0].last.startsWith('pv1:s:')).toBe(true);
  });
});

describe('Chatverlauf-Journal (BackgroundSync.applyChatOps)', () => {
  test('Haekchen gesperrt nachgetragen, Loeschung entfernt auch die Mediendatei', async () => {
    await PV.create(PIN);
    const KEY = 'chat_c_bob';
    await PV.setItem(KEY, JSON.stringify([
      { id: 'm1', mine: true, status: 'pending', text: 'x' },
      { id: 'm2', mine: false, type: 'audio', mref: 'f'.repeat(32), mk: 'S0VZ' },
    ]));
    PV.lock();
    await PV.update(KEY, { op: 'status', u: [['m1', 'sent']] });
    await PV.update(KEY, { op: 'status', u: [['m1', 'delivered']] });
    await PV.update(KEY, { op: 'delete', id: 'm2' });
    await PV.unlockWithPin(PIN);
    const list = JSON.parse(await PV.getItem(KEY));
    expect(list).toEqual([{ id: 'm1', mine: true, status: 'delivered', text: 'x' }]);
  });
});

describe('Fingerabdruck', () => {
  test('Einrichten nach PIN, danach Entsperren ohne PIN', async () => {
    await PV.create(PIN);
    expect(PV.hasBiometrics()).toBe(false);
    PV.lock();
    expect((await PV.unlockWithBiometrics(BIO)).reason).toBe('none');
    await PV.unlockWithPin(PIN);
    expect(await PV.enrollBiometrics(BIO)).toBe(true);
    expect(PV.hasBiometrics()).toBe(true);
    await PV.setItem('chat_c_x', '[1]');
    PV.lock();
    expect(await PV.unlockWithBiometrics(BIO)).toEqual({ ok: true });
    expect(await PV.getItem('chat_c_x')).toBe('[1]');
  });

  test('Abbrechen entsperrt nicht; neuer Fingerabdruck im System entfernt die Bindung', async () => {
    await PV.create(PIN);
    await PV.enrollBiometrics(BIO);
    PV.lock();
    pinKey.bioMode = 'cancel';
    expect(await PV.unlockWithBiometrics(BIO)).toEqual({ ok: false, reason: 'cancel' });
    expect(PV.isUnlocked()).toBe(false);
    pinKey.bioMode = 'invalidated';
    expect(await PV.unlockWithBiometrics(BIO)).toEqual({ ok: false, reason: 'invalidated' });
    expect(PV.hasBiometrics()).toBe(false);
    expect((await PV.unlockWithPin(PIN)).ok).toBe(true);
  });
});

describe('Sperren und Loeschen', () => {
  test('scheduleLock sperrt nach der Frist, cancelScheduledLock verhindert es', async () => {
    jest.useFakeTimers();
    try {
      await PV.create(PIN);
      PV.scheduleLock(60000);
      jest.advanceTimersByTime(59000);
      PV.cancelScheduledLock();
      jest.advanceTimersByTime(5000);
      expect(PV.isUnlocked()).toBe(true);
      PV.scheduleLock(60000);
      jest.advanceTimersByTime(60001);
      expect(PV.isUnlocked()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('Wipe vernichtet Datensatz und Chip-Schluessel - alte Verlaeufe sind unlesbar', async () => {
    await PV.create(PIN);
    await PV.setItem('chat_c_bob', '["geheim"]');
    const leftover = await ES.getItem('chat_c_bob');
    await PV.wipe();
    expect(pinKey.destroyKey).toHaveBeenCalled();
    expect(await ES.getItem(PV.RECORD_KEY)).toBeNull();
    expect(await ES.getItem(PV.RECORD_BAK_KEY)).toBeNull();
    expect(await PV.vaultState()).toBe('absent');
    // Neu eingerichtet (gleiche PIN!): der alte Rest bleibt unlesbar.
    await PV.create(PIN);
    await ES.setItem('chat_c_bob', leftover);
    await expect(PV.getItem('chat_c_bob')).rejects.toMatchObject({ code: 'VAULT_CORRUPT' });
  });
});
