// Design-Einstellungen (Themes.js): Speichern/Wiederherstellen in 'settings'
// (rueckwaertskompatibel), Vollversion-Regel fuer die Design-Themen und das
// Nachfuehren des angezeigten Themas bei Lizenzaenderungen.
const EncryptedStorage = require('react-native-encrypted-storage').default;
const T = require('../../Themes');

const storage = {
  getItem: (k) => EncryptedStorage.getItem(k),
  setItem: (k, v) => EncryptedStorage.setItem(k, v),
};
const stored = async () => JSON.parse(await EncryptedStorage.getItem('settings'));

beforeEach(async () => {
  await EncryptedStorage.clear();
  T._resetThemesForTests();
});

describe('Speichern und Wiederherstellen', () => {
  test('saveSettings mischt nur die geaenderten Felder hinein - bestehende Schluessel bleiben erhalten', async () => {
    await EncryptedStorage.setItem('settings', JSON.stringify({ accentColor: '#0A7EA4', bgColor: '#F7F5F2', fontSize: 18, customBgUri: 'file:///bg.jpg', fremd: 1 }));
    await T.saveSettings(storage, { tintChrome: true });
    expect(await stored()).toEqual({ accentColor: '#0A7EA4', bgColor: '#F7F5F2', fontSize: 18, customBgUri: 'file:///bg.jpg', fremd: 1, tintChrome: true });
  });

  test('schnelle Folge von Aenderungen geht nicht verloren (nacheinander geschrieben)', async () => {
    await Promise.all([
      T.saveSettings(storage, { accentColor: '#F28C6F' }),
      T.saveSettings(storage, { tintChrome: true }),
      T.saveSettings(storage, { fontSize: 13 }),
    ]);
    expect(await stored()).toEqual({ accentColor: '#F28C6F', tintChrome: true, fontSize: 13 });
  });

  test('kaputtes oder fehlendes JSON -> Standard-Design, Schreiben repariert den Eintrag', async () => {
    expect(T.selectionFromSettings(null)).toEqual({ themeId: 'klassik', accentKey: 'cyan', tintChrome: false, chatBgPreset: null, lockDesign: true, appIcon: false });
    expect(T.selectionFromSettings('{kaputt')).toEqual({ themeId: 'klassik', accentKey: 'cyan', tintChrome: false, chatBgPreset: null, lockDesign: true, appIcon: false });
    await EncryptedStorage.setItem('settings', '{kaputt');
    await T.saveSettings(storage, { fontSize: 15 });
    expect(await stored()).toEqual({ fontSize: 15 });
  });

  test('alte Einstellungen (vor den Design-Themen) werden verstanden', () => {
    // fruehere Akzent-Hexwerte -> gleichnamige Akzentfarbe
    expect(T.selectionFromSettings({ accentColor: '#8B7355' }).accentKey).toBe('brown');
    expect(T.selectionFromSettings({ accentColor: '#4A90D9' }).accentKey).toBe('blue');
    expect(T.selectionFromSettings({ accentColor: '#4A8B46' }).accentKey).toBe('green');
    expect(T.selectionFromSettings({ accentColor: '#9b6b9b' }).accentKey).toBe('lilac');
    expect(T.selectionFromSettings({ accentColor: '#123456' }).accentKey).toBe('cyan');
    // bgColor: Voreinstellung -> nur Chatverlauf; '#FAFAF8' (frueher bei jeder
    // Akzentaenderung mitgeschrieben) ist keine Wahl des Nutzers
    expect(T.selectionFromSettings({ bgColor: '#F7F5F2' }).chatBgPreset).toBe('#F7F5F2');
    expect(T.selectionFromSettings({ bgColor: '#FAFAF8' }).chatBgPreset).toBe(null);
    expect(T.selectionFromSettings({ themeId: 'gibtsnicht' }).themeId).toBe('klassik');
    // altes Format ohne neue Schluessel -> unveraendertes Standard-Design
    const t = T.resolveTheme(T.selectionFromSettings({ accentColor: '#0A7EA4', bgColor: '#FAFAF8', fontSize: 14 }));
    expect(t.legacy).toBe(true);
    expect(t.bg).toBe('#04182F');
  });

  test('Rundreise: Akzent + Einfaerben waehlen, speichern, nach "Neustart" identisch wiederhergestellt', async () => {
    await EncryptedStorage.setItem('settings', JSON.stringify({ fontSize: 18, customBgUri: 'file:///x.jpg' }));
    expect((await T.chooseDesign({ accentKey: 'coral' }, { storage, isProVerified: async () => false })).ok).toBe(true);
    expect((await T.chooseDesign({ tintChrome: true }, { storage, isProVerified: async () => false })).ok).toBe(true);
    const before = T.getTheme();
    const s = await stored();
    expect(s).toEqual({ fontSize: 18, customBgUri: 'file:///x.jpg', themeId: 'klassik', accentColor: '#F28C6F', tintChrome: true, lockDesign: true, appIcon: false });

    T._resetThemesForTests();
    expect(T.getTheme().legacy).toBe(true);
    T.restoreThemeSelection(T.selectionFromSettings(await EncryptedStorage.getItem('settings')));
    const after = T.getTheme();
    for (const k of T.TOKEN_KEYS) expect(after[k]).toBe(before[k]);
    expect(after.accent).toBe('#F28C6F');
    expect(after.headerBg).not.toBe('#0D2A4A');
  });

  test('Pro-Thema mit Lizenz: gespeichert und nach Neustart (mit Lizenz) wieder aktiv', async () => {
    const r = await T.chooseDesign({ themeId: 'pergament' }, { storage, isProVerified: async () => true });
    expect(r).toEqual({ ok: true });
    expect(T.getTheme().id).toBe('pergament');
    expect((await stored()).themeId).toBe('pergament');

    T._resetThemesForTests();
    T.restoreThemeSelection(T.selectionFromSettings(await EncryptedStorage.getItem('settings')));
    expect(T.getTheme().id).toBe('klassik');          // Lizenz noch nicht geprueft
    T.setThemeProUnlocked(true);                       // subscribeLicense: pro === true
    expect(T.getTheme().id).toBe('pergament');
  });
});

describe('Vollversion: Gratis-Nutzer koennen keine Design-Themen anwenden', () => {
  test('canUseTheme / resolveTheme: Pro-Thema ohne Lizenz -> Standard', () => {
    for (const p of T.PRO_THEMES) {
      expect(T.canUseTheme(p.id, false)).toBe(false);
      expect(T.canUseTheme(p.id, true)).toBe(true);
      expect(T.resolveTheme({ themeId: p.id }, false).id).toBe('klassik');
      expect(T.resolveTheme({ themeId: p.id }, true).id).toBe(p.id);
    }
    expect(T.canUseTheme('klassik', false)).toBe(true);
  });

  test('setThemeSelection lehnt ein Pro-Thema ohne Lizenz ab und laesst alles unveraendert', () => {
    const seen = [];
    const unsub = T.subscribeTheme(t => seen.push(t.id));
    const r = T.setThemeSelection({ themeId: 'graphit' }, { pro: false });
    unsub();
    expect(r).toEqual({ ok: false, reason: 'pro' });
    expect(T.getTheme().id).toBe('klassik');
    expect(T.getThemeSelection().themeId).toBe('klassik');
    expect(seen).toEqual([]);
  });

  test('chooseDesign prueft die Lizenz frisch: ohne Vollversion weder angewendet noch gespeichert', async () => {
    await EncryptedStorage.setItem('settings', JSON.stringify({ accentColor: '#0A7EA4', fontSize: 15 }));
    const isProVerified = jest.fn(async () => false);
    // auch ein (veralteter) "pro"-Anzeigezustand hilft nicht - entscheidend ist die frische Pruefung
    T.setThemeProUnlocked(true);
    T.setThemeProUnlocked(false);
    for (const p of T.PRO_THEMES) {
      const r = await T.chooseDesign({ themeId: p.id }, { storage, isProVerified });
      expect(r).toEqual({ ok: false, reason: 'pro' });
    }
    expect(isProVerified).toHaveBeenCalledTimes(T.PRO_THEMES.length);
    expect(T.getTheme().id).toBe('klassik');
    expect(await stored()).toEqual({ accentColor: '#0A7EA4', fontSize: 15 });
  });

  test('Pruefung wirft (Keystore-Fehler) -> abgelehnt', async () => {
    const r = await T.chooseDesign({ themeId: 'wald' }, { storage, isProVerified: async () => { throw new Error('keystore'); } });
    expect(r.reason).toBe('pro');
    expect(T.getTheme().id).toBe('klassik');
  });

  test('Lizenz entfaellt: Anzeige faellt auf Standard zurueck, die Wahl bleibt gemerkt', async () => {
    await T.chooseDesign({ themeId: 'amethyst' }, { storage, isProVerified: async () => true });
    expect(T.getTheme().id).toBe('amethyst');
    T.setThemeProUnlocked(false);
    expect(T.getTheme().id).toBe('klassik');
    expect(T.getThemeSelection().themeId).toBe('amethyst');
    expect((await stored()).themeId).toBe('amethyst');
    T.setThemeProUnlocked(true);
    expect(T.getTheme().id).toBe('amethyst');
  });

  test('kostenlose Optionen gehen immer: Akzentfarbe und Einfaerben ohne Lizenzpruefung', async () => {
    const isProVerified = jest.fn(async () => false);
    expect((await T.chooseDesign({ accentKey: 'mint' }, { storage, isProVerified })).ok).toBe(true);
    expect((await T.chooseDesign({ tintChrome: true }, { storage, isProVerified })).ok).toBe(true);
    expect(isProVerified).not.toHaveBeenCalled();
    expect(T.getTheme().accent).toBe('#5ED3A5');
    expect(T.getTheme().tinted).toBe(true);
  });

  test('Sperrbildschirm im gewaehlten Design (einheitlich) - abschaltbar: dann Standard-Design mit kostenloser Akzentfarbe (verraet die Vollversion nicht)', () => {
    T.setThemeSelection({ accentKey: 'rose' });
    T.setThemeSelection({ themeId: 'bordeaux' }, { pro: true });
    expect(T.getTheme().id).toBe('bordeaux');
    expect(T.getLockTheme().id).toBe('bordeaux');
    T.setThemeSelection({ lockDesign: false });
    expect(T.getLockTheme().id).toBe('klassik');
    expect(T.getLockTheme().accent).toBe('#E89AB8');
    // gespeichert und wiederhergestellt
    expect(T.settingsFromSelection(T.getThemeSelection()).lockDesign).toBe(false);
    expect(T.selectionFromSettings(JSON.stringify({ themeId: 'bordeaux', lockDesign: false })).lockDesign).toBe(false);
    expect(T.selectionFromSettings(JSON.stringify({ themeId: 'bordeaux' })).lockDesign).toBe(true);
    T.setThemeSelection({ themeId: 'klassik', accentKey: 'cyan' });
    expect(T.getLockTheme().legacy).toBe(true);
    expect(T.getLockTheme().bg).toBe('#04182F');
  });

  test('unbekannte Werte werden abgelehnt', () => {
    expect(T.setThemeSelection({ themeId: 'x' }, { pro: true }).reason).toBe('unknown');
    expect(T.setThemeSelection({ accentKey: 'neon' }).reason).toBe('unknown');
  });
});

describe('themedStyles / subscribeTheme', () => {
  test('Style-Objekt bleibt dasselbe und traegt nach einem Wechsel die neuen Farben', () => {
    const st = T.themedStyles((t) => ({ header: { backgroundColor: t.headerBg }, title: { color: t.headerText } }));
    const ref = st.header;
    expect(st.header.backgroundColor).toBe('#0D2A4A');
    T.setThemeSelection({ themeId: 'gletscher' }, { pro: true });
    expect(st.header.backgroundColor).toBe(T.getTheme().headerBg);
    expect(st.title.color).toBe(T.getTheme().headerText);
    expect(st.header).not.toBe(ref);
  });
});
