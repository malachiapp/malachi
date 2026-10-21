const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const fs = require('fs');
const path = require('path');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */
// Nur fuer Arbeitskopien (z.B. .claude/worktrees/*), deren node_modules eine
// Verknuepfung (Junction/Symlink) auf das node_modules des Haupt-Checkouts
// ist: Metro sieht Dateien ausserhalb der watchFolders nicht und findet dann
// kein einziges Paket. Im normalen Checkout ist realpath === eigener Pfad,
// die Zeilen unten aendern dort nichts.
const localModules = path.join(__dirname, 'node_modules');
const realModules = fs.existsSync(localModules) ? fs.realpathSync(localModules) : localModules;
const config = realModules !== localModules
  ? {
      watchFolders: [realModules],
      resolver: { nodeModulesPaths: [realModules] },
    }
  : {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
