// Manueller Jest-Mock (siehe react-native-webrtc.js fuer die Begruendung).
module.exports = {
  DocumentDirectoryPath: '/mock/documents',
  CachesDirectoryPath: '/mock/caches',
  writeFile: () => Promise.resolve(),
  readFile: () => Promise.resolve(''),
  unlink: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  mkdir: () => Promise.resolve(),
  readDir: () => Promise.resolve([]),
};
