// Manueller Jest-Mock (siehe react-native-webrtc.js fuer die Begruendung) -
// speichert nur in-memory, kein echtes natives Encrypted-Storage-Modul unter
// Jest verfuegbar.
const store = new Map();

module.exports = {
  __esModule: true,
  default: {
    setItem: (key, value) => { store.set(key, value); return Promise.resolve(); },
    getItem: (key) => Promise.resolve(store.has(key) ? store.get(key) : null),
    removeItem: (key) => { store.delete(key); return Promise.resolve(); },
    clear: () => { store.clear(); return Promise.resolve(); },
  },
};
