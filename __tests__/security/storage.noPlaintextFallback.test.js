// Audit 2026-10-19 (A1): App-Daten verlassen das Geraet nie (auch nicht beim
// Geraeteumzug), und der verschluesselte Speicher faellt nie still auf
// unverschluesselte SharedPreferences zurueck.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

test('Manifest: kein Backup, Regeln fuer Cloud-Sicherung UND Geraeteumzug', () => {
  const m = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  expect(m).toMatch(/android:allowBackup="false"/);
  expect(m).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
  const r = read('android', 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml');
  for (const teil of ['cloud-backup', 'device-transfer']) {
    const block = r.slice(r.indexOf('<' + teil + '>'), r.indexOf('</' + teil + '>'));
    for (const d of ['root', 'file', 'database', 'sharedpref', 'external']) {
      expect(block).toContain(`<exclude domain="${d}" path="." />`);
    }
  }
});

test('EncryptedStorage: Patch verbietet den Klartext-Rueckfall (und ist im Modul aktiv)', () => {
  const patch = read('patches', 'react-native-encrypted-storage+4.0.3.patch');
  expect(patch).toMatch(/^-\s+this\.sharedPreferences = context\.getSharedPreferences/m);
  expect(patch).toMatch(/^\+\s+this\.sharedPreferences = null;/m);
  const modul = read('node_modules', 'react-native-encrypted-storage', 'android', 'src', 'main', 'java', 'com', 'emeraldsanto', 'encryptedstorage', 'RNEncryptedStorageModule.java');
  expect(modul).not.toMatch(/context\.getSharedPreferences\(/);
  expect(read('package.json')).toMatch(/"postinstall": "patch-package"/);
});
