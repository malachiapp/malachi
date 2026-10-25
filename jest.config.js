const path = require('path');

// Malachi-Open-Source/ ist der oeffentliche Export (eigenes Git-Repo ohne
// node_modules, per .gitignore ausgeschlossen) - ohne Ausschluss laeuft jede
// Suite doppelt und die Kopie scheitert an fehlenden Modulen (z.B.
// @noble/post-quantum). <rootDir> taugt dafuer nicht: Jest 29 setzt den Pfad
// unescaped in die Regex ein, in Worktrees unter .claude\worktrees\ wird "\."
// dann als escapter Punkt gelesen und das Muster greift nie. Deshalb der Name
// des Repo-Ordners davor statt eines nackten [\/]Malachi-Open-Source[\/] -
// sonst wuerde der Export, dessen Ordner selbst so heisst und der diese Datei
// mitbekommt, alle eigenen Tests ausblenden.
const OSS_EXPORT = '[\\/]' + path.basename(__dirname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\/]Malachi-Open-Source[\\/]';

module.exports = {
  preset: '@react-native/jest-preset',
  // Eigene setupFiles ERSETZEN die des Presets, statt sie zu ergaenzen - der
  // Preset-eigene Eintrag muss deshalb explizit mit aufgefuehrt werden
  // (gleiche Falle wie bei transformIgnorePatterns oben).
  setupFiles: [
    require.resolve('@react-native/jest-preset/jest/setup.js'),
    '<rootDir>/jest.setup.js',
  ],
  // @noble/* (auch die Kopie unter web/node_modules, die die Sicherheitstests
  // unter __tests__/security importieren, um den Web-Client gegen den
  // nativen mitzutesten) und react-native-vector-icons liefern reines ESM
  // aus - Jest transformiert node_modules per Default nicht, das ESM-`import`
  // schlaegt sonst fehl (vorbestehende Luecke seit dem RN-0.86-Upgrade, hier
  // mit erledigt statt separat offen gelassen).
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble|react-native-.*|@react-native-.*)/)'],
  // Native Quellen (z.B. MessageCrypto.js) importieren @noble/* ohne
  // Dateiendung ("@noble/ciphers/aes") - Metro (RN-Bundler) loest das
  // grosszuegig auf, Node/Jest respektiert dagegen @noble's strikte
  // "exports"-Map im package.json, die nur ".js"-Endungen kennt. Betrifft nur
  // die Sicherheitstests unter __tests__/security, die diese Dateien direkt
  // (ausserhalb von Metro) importieren.
  moduleNameMapper: {
    '^@noble/(ciphers|hashes)/([^.]+)$': '@noble/$1/$2.js',
  },
  // Jests Default-testMatch greift jede .js-Datei unter __tests__/ - die
  // Shared-Helper unter __tests__/security/helpers/ enthalten aber keine
  // eigenen Tests und sollen nicht als leere Testsuiten durchfallen.
  // .claude/worktrees/ enthaelt Kopien des Repos aus Agent-Sitzungen (teils
  // mit veralteten Abhaengigkeiten) - ohne Ausschluss laeuft jede Suite
  // mehrfach und die Kopien schlagen mit fremden Fehlern fehl.
  // Malachi-Open-Source/: siehe OSS_EXPORT oben.
  // Pfadtrenner unter Windows: \ statt /, deshalb ohne <rootDir> und mit [\/].
  // shop/ hat eigene Tests mit node:test (cd shop && npm test) - nicht unter
  // Jest. __tests__/license/license.kaufSimulation.test.js startet
  // shop/test/simulation.js als eigenen Prozess.
  testPathIgnorePatterns: ['/node_modules/', '[\\/]__tests__[\\/]security[\\/]helpers[\\/]', '<rootDir>/.claude/', OSS_EXPORT, '[\\/]shop[\\/]test[\\/]'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/', OSS_EXPORT],
};
