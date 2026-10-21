// Diagnose (Live-Test 2026-10-04): auf einem Testgeraet verschwand der
// Verbindungsschluessel eines Kontakts (RAM + verschluesselter Speicher), ohne
// dass Kontakt-Loeschen/Wipe im Log stand. Jede Entfernung eines Schluessels
// wird hier mit Aufrufstelle protokolliert - nur Kontakt-ID-Praefix und Stack,
// nie der Schluessel selbst.
import EncryptedStorage from 'react-native-encrypted-storage';

const SECRET_KEY_RE = /^shared_secret_(prev_)?/;

function where() {
  const stack = String(new Error().stack || '').split('\n').slice(2, 7).map(s => s.trim()).join(' <- ');
  return stack;
}

// Nur in Entwicklungs-Builds (Audit 2026-10-19): im Release landeten sonst
// Kontakt-ID-Praefixe (auf beiden Geraeten gleich - verknuepft Kontakte) und
// eine Spur des Wipes samt Aufrufstelle (z. B. performWipe) in logcat.
const AKTIV = typeof __DEV__ !== 'undefined' && __DEV__ === true;

export function traceSecretMap(map, label) {
  if (!AKTIV) return map;
  const origDelete = map.delete.bind(map);
  const origClear = map.clear.bind(map);
  map.delete = (key) => {
    if (map.has(key)) console.warn('[Secret] ' + label + ' entfernt fuer', String(key).slice(0, 10), '|', where());
    return origDelete(key);
  };
  map.clear = () => {
    if (map.size) console.warn('[Secret] ' + label + ' komplett geleert (' + map.size + ') |', where());
    return origClear();
  };
  return map;
}

let storageTraced = false;
export function traceSecretStorage() {
  if (!AKTIV) return;
  if (storageTraced || !EncryptedStorage?.removeItem) return;
  storageTraced = true;
  const origRemove = EncryptedStorage.removeItem.bind(EncryptedStorage);
  EncryptedStorage.removeItem = (key) => {
    if (SECRET_KEY_RE.test(String(key))) {
      console.warn('[Secret] Speicher-Eintrag entfernt:', String(key).replace(SECRET_KEY_RE, (m) => m).slice(0, 24), '|', where());
    }
    return origRemove(key);
  };
  if (EncryptedStorage.clear) {
    const origClear = EncryptedStorage.clear.bind(EncryptedStorage);
    EncryptedStorage.clear = () => {
      console.warn('[Secret] Verschluesselter Speicher komplett geleert |', where());
      return origClear();
    };
  }
}
