// Distribution.js: Vertriebsvariante aus dem nativen Modul MalachiBuild
// (BuildConfig.FLAVOR). Ohne Modul (Jest, iOS) gilt die Website-Variante.
const { NativeModules } = require('react-native');
const D = require('../../Distribution');

afterEach(() => {
  delete NativeModules.MalachiBuild;
});

test('ohne natives Modul: Website-Variante', () => {
  delete NativeModules.MalachiBuild;
  expect(D.getDistribution()).toBe('web');
  expect(D.isWeb()).toBe(true);
  expect(D.isPlay()).toBe(false);
  expect(D.getApplicationId()).toBeNull();
});

test('Konstanten direkt am Modul (Bridge): play', () => {
  NativeModules.MalachiBuild = { distribution: 'play', applicationId: 'app.malachi.messenger' };
  expect(D.getDistribution()).toBe('play');
  expect(D.isPlay()).toBe(true);
  expect(D.isWeb()).toBe(false);
  expect(D.getApplicationId()).toBe('app.malachi.messenger');
});

test('Konstanten ueber getConstants() (Interop der neuen Architektur): web', () => {
  NativeModules.MalachiBuild = { getConstants: () => ({ distribution: 'web', applicationId: 'com.securecommapp' }) };
  expect(D.getDistribution()).toBe('web');
  expect(D.isWeb()).toBe(true);
  expect(D.getApplicationId()).toBe('com.securecommapp');
});

test('getConstants() mit play', () => {
  NativeModules.MalachiBuild = { getConstants: () => ({ distribution: 'play', applicationId: 'app.malachi.messenger.demo' }) };
  expect(D.isPlay()).toBe(true);
  expect(D.getApplicationId()).toBe('app.malachi.messenger.demo');
});

test.each([
  [{ distribution: 'PLAY' }],
  [{ distribution: 'playx' }],
  [{ distribution: 42 }],
  [{}],
  [{ getConstants: () => { throw new Error('kaputt'); } }],
  [{ getConstants: () => null }],
])('unbekannte/kaputte Angaben gelten als web: %j', (mod) => {
  NativeModules.MalachiBuild = mod;
  expect(D.getDistribution()).toBe('web');
  expect(D.isPlay()).toBe(false);
});

test.each([
  ['', null],
  ['ohnepunkt', null],
  ['com..doppelt', null],
  ['1com.securecommapp', null],
  ['com.securecommapp/../x', null],
  ['com.securecommapp', 'com.securecommapp'],
])('Paketname %j wird geprueft', (id, expected) => {
  NativeModules.MalachiBuild = { distribution: 'play', applicationId: id };
  expect(D.getApplicationId()).toBe(expected);
});
