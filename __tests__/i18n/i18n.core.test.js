// Kern des Uebersetzungs-Helfers (i18n.js): Rueckfallkette, Platzhalter,
// Pluralformen (auch Russisch/Arabisch/Polnisch), Erkennung der
// Geraetesprache, Speichern/Laden der Wahl in 'settings', Benachrichtigung
// beim Wechsel, Uhrzeitformat und Leserichtung (RTL).
// Die Geraetesprache ist in jest.setup.js fest auf de_DE gestellt.
jest.mock('react-native-restart', () => ({ __esModule: true, default: { restart: jest.fn() } }));

const EncryptedStorage = require('react-native-encrypted-storage').default;
const NativeI18n = require('react-native/Libraries/ReactNative/NativeI18nManager').default;
const T = require('../../Themes');
const I = require('../../i18n');
const { t } = I;

beforeEach(async () => {
  I._resetI18nForTests();
  await EncryptedStorage.clear();
  NativeI18n.forceRTL.mockClear();
  NativeI18n.allowRTL.mockClear();
});
afterAll(() => { I._resetI18nForTests(); });

describe('Standard und Rueckfall', () => {
  test('ohne Wahl gilt die Geraetesprache (Tests: de_DE) -> deutsche Texte unveraendert', () => {
    expect(I.getLanguageChoice()).toBe('system');
    expect(I.getLanguage()).toBe('de');
    expect(t('home.title')).toBe('Nachrichten');
    expect(t('settings.wipeAll')).toBe('⚠  Alle Daten sofort löschen');
  });

  test('unbekannter Schluessel -> Schluessel selbst', () => {
    expect(t('gibt.es.nicht')).toBe('gibt.es.nicht');
    I.setLanguage('ja');
    expect(t('gibt.es.nicht')).toBe('gibt.es.nicht');
  });

  test('Kette: gewaehlte Sprache -> Englisch -> Deutsch -> Schluessel', () => {
    jest.isolateModules(() => {
      jest.doMock('../../locales/ja', () => ({ __esModule: true, default: { a: 'JA-a' } }));
      jest.doMock('../../locales/en', () => ({ __esModule: true, default: { a: 'EN-a', b: 'EN-b' } }));
      jest.doMock('../../locales/de', () => ({ __esModule: true, default: { a: 'DE-a', b: 'DE-b', c: 'DE-c {x}' } }));
      const J = require('../../i18n');
      J.setLanguage('ja');
      expect(J.t('a')).toBe('JA-a');
      expect(J.t('b')).toBe('EN-b');
      expect(J.t('c', { x: 1 })).toBe('DE-c 1');
      expect(J.t('d')).toBe('d');
    });
    // doMock gilt ueber isolateModules hinaus - fuer die folgenden Tests aufheben
    ['ja', 'en', 'de'].forEach(c => jest.dontMock('../../locales/' + c));
  });

  test('defekte/fehlende Tabelle bricht nichts', () => {
    jest.isolateModules(() => {
      jest.doMock('../../locales/fr', () => { throw new Error('kaputt'); });
      const J = require('../../i18n');
      J.setLanguage('fr');
      expect(J.getTable('fr')).toBeNull();
      expect(J.t('home.title')).toBe('Messages');
    });
    jest.dontMock('../../locales/fr');
  });
});

describe('Platzhalter', () => {
  test('werden ersetzt, fehlende bleiben stehen', () => {
    expect(t('home.selected', { count: 3 })).toBe('3 ausgewählt');
    expect(t('home.selected', { count: 0 })).toBe('0 ausgewählt');
    expect(t('home.selected')).toBe('{count} ausgewählt');
    expect(t('call.end.noAnswer', { name: 'Bob' })).toBe('Bob hat nicht geantwortet.');
    expect(t('call.end.noAnswer', { name: null })).toBe('{name} hat nicht geantwortet.');
    I.setLanguage('ar');
    expect(t('call.end.noAnswer', { name: 'Bob' })).toBe('لم يرد Bob.');
  });

  test('mehrere Platzhalter in einem Text', () => {
    expect(t('home.status.mixed', { n: 2, total: 5, tor: 1 })).toBe(
      I.rawMessage('de', 'home.status.mixed').replace('{n}', '2').replace('{total}', '5').replace('{tor}', '1'));
  });
});

describe('Pluralformen', () => {
  test('Deutsch/Englisch: one/other (behebt "1 Mitglieder")', () => {
    expect(t('groups.memberCount', { count: 1 })).toBe('1 Mitglied');
    expect(t('groups.memberCount', { count: 2 })).toBe('2 Mitglieder');
    expect(t('groups.memberCount', { count: 0 })).toBe('0 Mitglieder');
    I.setLanguage('en');
    expect(t('groups.memberCount', { count: 1 })).toBe('1 member');
    expect(t('groups.memberCount', { count: 7 })).toBe('7 members');
  });

  test('Russisch: one/few/many', () => {
    I.setLanguage('ru');
    expect(t('groups.memberCount', { count: 1 })).toBe('1 участник');
    expect(t('groups.memberCount', { count: 3 })).toBe('3 участника');
    expect(t('groups.memberCount', { count: 5 })).toBe('5 участников');
    expect(t('groups.memberCount', { count: 11 })).toBe('11 участников');
    expect(t('groups.memberCount', { count: 21 })).toBe('21 участник');
    expect(t('groups.memberCount', { count: 22 })).toBe('22 участника');
  });

  test('Arabisch: zero/one/two/few/many/other', () => {
    I.setLanguage('ar');
    expect(t('groups.memberCount', { count: 0 })).toBe('لا أعضاء');
    expect(t('groups.memberCount', { count: 1 })).toBe('عضو واحد');
    expect(t('groups.memberCount', { count: 2 })).toBe('عضوان');
    expect(t('groups.memberCount', { count: 3 })).toBe('3 أعضاء');
    expect(t('groups.memberCount', { count: 11 })).toBe('11 عضوًا');
    expect(t('groups.memberCount', { count: 100 })).toBe('100 عضو');
  });

  test('Regeln einzeln (CLDR, ganze Zahlen)', () => {
    const c = I.pluralCategory;
    expect([1, 2, 5, 12, 22, 25].map(n => c('pl', n))).toEqual(['one', 'few', 'many', 'many', 'few', 'many']);
    expect([1, 2, 5, 11, 21, 111].map(n => c('uk', n))).toEqual(['one', 'few', 'many', 'many', 'one', 'many']);
    expect([0, 1, 2].map(n => c('fr', n))).toEqual(['one', 'one', 'other']);
    expect([0, 1, 2].map(n => c('pt-BR', n))).toEqual(['one', 'one', 'other']);
    expect([0, 1, 2].map(n => c('hi', n))).toEqual(['one', 'one', 'other']);
    expect([1, 2].map(n => c('ja', n))).toEqual(['other', 'other']);
    expect([1, 2].map(n => c('zh-Hans', n))).toEqual(['other', 'other']);
    expect(c('de', 1)).toBe('one');
    expect(c('de', undefined)).toBe('other');
    expect(c('ru', 1.5)).toBe('other');
  });

  test('Sprache ohne eigene Form -> other (Japanisch)', () => {
    I.setLanguage('ja');
    expect(t('groups.memberCount', { count: 1 })).toBe('メンバー 1 人');
  });
});

describe('Erkennung der Geraetesprache', () => {
  test('normalizeTag', () => {
    expect(I.normalizeTag('de_DE')).toBe('de-DE');
    expect(I.normalizeTag('zh_CN_#Hans')).toBe('zh-Hans-CN');
    expect(I.normalizeTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(I.normalizeTag('en-US@calendar=gregorian')).toBe('en-US');
    expect(I.normalizeTag('es-419')).toBe('es-419');
    expect(I.normalizeTag('')).toBeNull();
    expect(I.normalizeTag(null)).toBeNull();
    expect(I.normalizeTag('123')).toBeNull();
  });

  test('matchLanguage', () => {
    expect(I.matchLanguage('en_GB')).toBe('en');
    expect(I.matchLanguage('pt_PT')).toBe('pt-BR');
    expect(I.matchLanguage('pt-BR')).toBe('pt-BR');
    expect(I.matchLanguage('zh_CN_#Hans')).toBe('zh-Hans');
    expect(I.matchLanguage('zh-CN')).toBe('zh-Hans');
    expect(I.matchLanguage('zh_TW')).toBeNull();
    expect(I.matchLanguage('zh-Hant-HK')).toBeNull();
    expect(I.matchLanguage('in_ID')).toBe('id');
    expect(I.matchLanguage('fa_IR')).toBe('fa');
    expect(I.matchLanguage('sv_SE')).toBeNull();
  });

  test('resolveLanguage: feste Wahl, erste passende Geraetesprache, sonst Englisch', () => {
    expect(I.resolveLanguage('ja', ['de-DE'])).toBe('ja');
    expect(I.resolveLanguage('system', ['sv-SE', 'fr-FR'])).toBe('fr');
    expect(I.resolveLanguage('system', ['sv-SE'])).toBe('en');
    expect(I.resolveLanguage('system', [])).toBe('en');
    expect(I.resolveLanguage('xx', ['de-DE'])).toBe('de');
  });

  test('deviceLocaleTags liest die native Locale', () => {
    expect(I.deviceLocaleTags()[0]).toBe('de-DE');
  });
});

describe('Wechsel und Benachrichtigung', () => {
  test('setLanguage meldet nur echte Aenderungen; Abmelden wirkt', () => {
    const seen = [];
    const off = I.subscribeLanguage((l) => seen.push(l));
    expect(I.setLanguage('de')).toEqual({ language: 'de', changed: false });
    expect(I.setLanguage('fr')).toEqual({ language: 'fr', changed: true });
    expect(I.getLanguageChoice()).toBe('fr');
    expect(t('home.title')).toBe('Messages');
    expect(I.setLanguage('system')).toEqual({ language: 'de', changed: true });
    off();
    I.setLanguage('es');
    expect(seen).toEqual(['fr', 'de']);
  });

  test('unbekannte Wahl -> System', () => {
    I.setLanguage('xx-YY');
    expect(I.getLanguageChoice()).toBe('system');
    expect(I.getLanguage()).toBe('de');
  });

  test('ein fehlerhafter Abonnent stoert die anderen nicht', () => {
    const ok = jest.fn();
    const off1 = I.subscribeLanguage(() => { throw new Error('x'); });
    const off2 = I.subscribeLanguage(ok);
    I.setLanguage('it');
    expect(ok).toHaveBeenCalledWith('it');
    off1(); off2();
  });
});

describe('Speichern in settings (rueckwaertskompatibel)', () => {
  test('languageFromSettings ist fehlertolerant', () => {
    expect(I.languageFromSettings(null)).toBe('system');
    expect(I.languageFromSettings(undefined)).toBe('system');
    expect(I.languageFromSettings('{}')).toBe('system');
    expect(I.languageFromSettings('kein json')).toBe('system');
    expect(I.languageFromSettings('{"theme":"graphit"}')).toBe('system');
    expect(I.languageFromSettings('{"language":"fr"}')).toBe('fr');
    expect(I.languageFromSettings('{"language":"xx"}')).toBe('system');
    expect(I.languageFromSettings({ language: 'zh-Hans' })).toBe('zh-Hans');
  });

  test('Speichern fuehrt mit bestehenden Einstellungen zusammen, Laden uebernimmt die Wahl', async () => {
    await EncryptedStorage.setItem('settings', JSON.stringify({ theme: 'graphit', accentKey: 'violet', fontSize: 'large' }));
    await T.saveSettings(EncryptedStorage, { language: 'uk' });
    const stored = JSON.parse(await EncryptedStorage.getItem('settings'));
    expect(stored).toEqual({ theme: 'graphit', accentKey: 'violet', fontSize: 'large', language: 'uk' });
    I._resetI18nForTests();
    await expect(I.loadLanguageSetting(EncryptedStorage)).resolves.toBe('uk');
    expect(I.getLanguage()).toBe('uk');
  });

  test('alte Einstellungen ohne Sprache und fehlender Speicher -> System', async () => {
    await EncryptedStorage.setItem('settings', JSON.stringify({ theme: 'klassik' }));
    await expect(I.loadLanguageSetting(EncryptedStorage)).resolves.toBe('system');
    await EncryptedStorage.clear();
    await expect(I.loadLanguageSetting(EncryptedStorage)).resolves.toBe('system');
    await expect(I.loadLanguageSetting({ getItem: async () => { throw new Error('gesperrt'); } })).resolves.toBe('system');
    expect(I.getLanguage()).toBe('de');
  });
});

describe('Datum/Uhrzeit', () => {
  test('Deutsch: HH:MM wie bisher mit de-DE', () => {
    const d = new Date(2026, 0, 2, 9, 5);
    expect(I.getDateLocale()).toBe('de-DE');
    expect(I.formatTime(d)).toBe('09:05');
    expect(I.formatTime(d.getTime())).toBe('09:05');
    expect(I.formatTime()).toMatch(/^\d{2}:\d{2}$/);
  });

  test('undefined bleibt ungueltig wie beim alten toLocaleTimeString-Aufruf', () => {
    const old = new Date(undefined).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    expect(I.formatTime(undefined)).toBe(old);
  });

  test('formatDate/formatDateTime liefern Text', () => {
    const d = new Date(2026, 9, 19, 14, 30);
    expect(I.formatDate(d)).toContain('2026');
    expect(I.formatDateTime(d)).toContain('14:30');
  });
});

describe('Leserichtung', () => {
  test('RTL nur fuer Arabisch und Persisch', () => {
    expect(I.LANGUAGES.filter(l => l.rtl).map(l => l.code)).toEqual(['ar', 'fa']);
    expect(I.isRTLLanguage('ar')).toBe(true);
    expect(I.isRTLLanguage('de')).toBe(false);
  });

  test('syncLayoutDirection merkt RTL fuer den naechsten Start vor und meldet den Neustartbedarf', () => {
    I.setLanguage('ar');
    expect(I.wantsRTL()).toBe(true);
    expect(I.syncLayoutDirection()).toBe(true);
    expect(NativeI18n.allowRTL).toHaveBeenLastCalledWith(true);
    expect(NativeI18n.forceRTL).toHaveBeenLastCalledWith(true);
    I.setLanguage('de');
    expect(I.syncLayoutDirection()).toBe(false);
    expect(NativeI18n.forceRTL).toHaveBeenLastCalledWith(false);
  });

  test('restartApp startet ueber react-native-restart neu', () => {
    const RNRestart = require('react-native-restart').default;
    expect(I.restartApp()).toBe(true);
    expect(RNRestart.restart).toHaveBeenCalledWith('i18n-direction');
  });
});

test('Sprachliste: 18 Sprachen, Namen in der eigenen Sprache', () => {
  expect(I.LANGUAGE_CODES).toEqual(['de', 'en', 'es', 'fr', 'it', 'pt-BR', 'nl', 'pl', 'tr', 'ru', 'uk', 'ar', 'fa', 'zh-Hans', 'ja', 'ko', 'hi', 'id']);
  expect(I.languageName('de')).toBe('Deutsch');
  expect(I.languageName('ja')).toBe('日本語');
  expect(I.languageName('xx')).toBe('xx');
});
