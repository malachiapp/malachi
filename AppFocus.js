// Malachi – AppFocus.js
//
// Kleine, gemeinsame Koordination zwischen App-Teilen, die sich sonst nicht
// kennen (App.tsx/ChatScreen und SiegelScreen):
//
// 1. App-Sperre waehrend Systemdialogen: Galerie, Dateiauswahl oder
//    Berechtigungsdialog schicken die App in den Hintergrund. Solange so ein
//    Dialog offen ist, gilt fuer die App-PIN-Sperre eine laengere Gnadenfrist
//    (siehe AppInner in App.tsx). Vorher kannte nur App.tsx diesen Zaehler -
//    eine lange Bildsuche in Siegel endete auf dem PIN-Bildschirm.
//
// 2. Audio-Fokus: der native Spieler/Rekorder (react-native-audio-recorder-
//    player) existiert nur EINMAL. Spielt der Chat eine Sprachnachricht und
//    Siegel startet eine (oder umgekehrt), stoppt der zuletzt Startende den
//    anderen sauber - statt dass dessen Wiedergabe mit einem Fehler abbricht.

let autoLockSuspendCount = 0;

export function withAutoLockSuspended(fn) {
  autoLockSuspendCount++;
  let p;
  try { p = Promise.resolve(fn()); } catch (e) { autoLockSuspendCount = Math.max(0, autoLockSuspendCount - 1); throw e; }
  return p.finally(() => { autoLockSuspendCount = Math.max(0, autoLockSuspendCount - 1); });
}

export function isAutoLockSuspended() {
  return autoLockSuspendCount > 0;
}

let audioOwner = null;   // { id, stop }

// Vor jeder Wiedergabe/Aufnahme aufrufen: stoppt einen anderen Besitzer.
export async function claimAudio(id, stop) {
  const prev = audioOwner;
  audioOwner = { id, stop };
  if (prev && prev.id !== id) {
    try { await prev.stop(); } catch {}
  }
}

// Nach dem Ende der eigenen Wiedergabe/Aufnahme aufrufen.
export function releaseAudio(id) {
  if (audioOwner && audioOwner.id === id) audioOwner = null;
}

export function _resetAppFocusForTests() {
  autoLockSuspendCount = 0;
  audioOwner = null;
}
