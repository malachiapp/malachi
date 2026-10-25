// PairingIds.js - Kontakt-ID einer Kopplung per Einladung (QR-Code, Link oder
// ueber einen Gruppen-Admin): SHA-256 ueber Token und Einmal-Geheimnis. Das
// Geheimnis kennen nur die beiden koppelnden Geraete - das Ergebnis ist voll-
// entropisch und fuer Dritte nicht vorhersagbar (Sicherheitsreview 3). Beide
// Seiten muessen exakt dieselbe ID erhalten (Schluessel liegen darunter).
import { NativeModules } from 'react-native';

export async function deriveContactId(token, pskHex) {
  if (!NativeModules.KyberModule?.sha256) {
    throw new Error('SHA-256-Modul nicht verfügbar - Pairing kann sich gerade nicht sicher aufbauen.');
  }
  const hex = await NativeModules.KyberModule.sha256('malachi_2026_pairing_' + token + '|' + pskHex);
  return 'c_' + hex.slice(0, 32);
}
