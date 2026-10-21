// Release-Builds entfernen console.log/info/debug/trace (keine Metadaten in
// logcat); warn/error bleiben. Nur im babel-env "production" aktiv.
const babel = require('@babel/core');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', '..', 'tools', 'babel-plugin-release-console.js');
const umwandeln = (code) => babel.transformSync(code, { babelrc: false, configFile: false, plugins: [PLUGIN] }).code;

test('log/info/debug/trace verschwinden, warn/error bleiben', () => {
  const aus = umwandeln(`
    console.log('[Tor] Kontakt', id);
    console.info('x'); console.debug('y'); console.trace('z');
    console.warn('w'); console.error('e');
    const f = () => console.log('pfeil');
    if (a) console.log('if');
  `);
  expect(aus).not.toMatch(/console\.(log|info|debug|trace)/);
  expect(aus).toMatch(/console\.warn\('w'\)/);
  expect(aus).toMatch(/console\.error\('e'\)/);
  expect(aus).toMatch(/const f = \(\) => void 0/);
});

test('Babel-Konfiguration nutzt das Plugin nur im Release (env production)', () => {
  const konfig = require('../../babel.config.js');
  expect(konfig.plugins).toBeUndefined();
  expect(konfig.env.production.plugins).toEqual(['./tools/babel-plugin-release-console']);
});
