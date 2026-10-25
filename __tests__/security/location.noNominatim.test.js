// STUN-Ausstieg, Entscheidung E5: Ortsnamen ueber Nominatim sind immer aus.
// Die Rueckwaertssuche (bis 1.1.0 im Verbindungsweg "Schnell") ist komplett
// entfernt - beim Senden eines Standorts gibt es keine Netzwerkanfrage an
// OpenStreetMap oder einen anderen Dritten mehr; die Koordinaten gehen nur
// Ende-zu-Ende verschluesselt an den Kontakt. Ortsnamen aelterer Absender
// werden weiter angezeigt (reiner Text, keine Anfrage). Die Kartenansicht
// laedt keine Kacheln: "Oeffnen" uebergibt nur eine geo:-Adresse an eine
// Karten-App des Nutzers (im Secret Chat nicht einmal das).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.tsx');

function appSources() {
  const files = fs.readdirSync(ROOT).filter((f) => /\.(js|ts|tsx)$/.test(f));
  for (const d of ['locales', path.join('web', 'src'), path.join('web', 'src', 'lib')]) {
    if (!fs.existsSync(path.join(ROOT, d))) continue;
    for (const f of fs.readdirSync(path.join(ROOT, d))) if (/\.(js|ts|tsx)$/.test(f)) files.push(path.join(d, f));
  }
  return files;
}

test('kein Nominatim, kein OpenStreetMap, keine Rueckwaertssuche - nirgends im App-Code', () => {
  const hits = [];
  for (const f of appSources()) {
    const src = read(f);
    // Kommentare duerfen die Geschichte erklaeren - Code und Texte nicht.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    if (/nominatim|openstreetmap\.org|reverseGeocode|geocod/i.test(code)) hits.push(f);
  }
  expect(hits).toEqual([]);
});

test('App.tsx stellt ueberhaupt keine HTTP-Anfrage mehr (fetch war nur fuer Nominatim)', () => {
  expect(APP).not.toMatch(/\bfetch\(/);
  expect(APP).not.toMatch(/https?:\/\/(?!…)/);
});

test('Standort senden: nur Koordinaten im verschluesselten Text-Umschlag, kein Ortsname', () => {
  const start = APP.indexOf('const sendLocationMessage = (lat, lng) => {');
  expect(start).toBeGreaterThan(0);
  const send = APP.slice(start, APP.indexOf('const sendLocation = async () => {', start));
  expect(send).toMatch(/type: 'text', text: t\('preview\.location'\), isLocation: true, lat, lng,\n/);
  expect(send).not.toMatch(/address/);
  expect(send).toMatch(/sendViaOutbox\(chat\?\.id, 'text', payload, msgId, \{/);
  const loc = APP.slice(APP.indexOf('const sendLocation = async () => {'), APP.indexOf('const sendLocation = async () => {') + 1500);
  expect(loc).toMatch(/\(pos\) => \{\s*const \{ latitude, longitude \} = pos\.coords;\s*sendLocationMessage\(latitude, longitude\);\s*\}/);
});

test('Anzeige: Ortsname aelterer Absender bleibt sichtbar, sonst Koordinaten; Oeffnen nur per geo: (nicht im Secret Chat)', () => {
  expect(APP).toMatch(/\{item\.address \|\| coordsText\}/);
  expect(APP).toMatch(/Linking\.openURL\(`geo:\$\{item\.lat\},\$\{item\.lng\}\?q=\$\{item\.lat\},\$\{item\.lng\}`\)/);
  expect(APP).toMatch(/onPress=\{\(\) => \(secretLocation\s*\? Alert\.alert\(t\('common\.location'\), t\('app\.imSecretChatLassenSich'/);
  // keine Karten-Komponente, die selbst Kacheln laedt
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  expect(deps.filter((d) => /maps|mapbox|leaflet|webview/i.test(d))).toEqual([]);
});

test('Laufzeit: fetch wird beim Laden der Standort-relevanten Module nie aufgerufen', () => {
  global.fetch = jest.fn(async () => { throw new Error('kein Netzzugriff erlaubt'); });
  jest.isolateModules(() => {
    require('../../ConnectionMode');
    require('../../PortMapping');
    require('../../ConnectionStats');
  });
  expect(global.fetch).not.toHaveBeenCalled();
});
