// Kopieren mit Schutz - fuer Chat-Nachrichten und Siegel-Geheimtexte.
//
// Die Zwischenablage ist eine Spur ausserhalb von Malachi (andere Apps,
// Tastatur-Verlauf). Deshalb:
//  - Android 13+: Inhalt als "sensibel" markiert (natives Modul
//    MalachiClipboard) - keine Vorschau, kein Zwischenablage-Verlauf der
//    Tastatur.
//  - Nach CLEAR_AFTER_MS wird geleert, aber nur, wenn noch genau unser
//    Inhalt drinsteht. Liegt die App dann im Hintergrund (Android laesst
//    sie die Zwischenablage nicht lesen), wird beim naechsten Oeffnen der
//    App erneut versucht.
// Der kopierte Text bleibt nur im Arbeitsspeicher (fuer den Vergleich) und
// wird nie gespeichert oder geloggt.

import { NativeModules, AppState } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';

export const CLEAR_AFTER_MS = 60000;
// "unklar" (App im Hintergrund, Zwischenablage nicht lesbar): bis zu einem
// Tag lang beim Oeffnen der App erneut versuchen.
const MAX_RETRY_MS = 24 * 3600 * 1000;

let pending = null;   // { text, at }
let timer = null;
let appStateSub = null;

function nativeModule() {
  const m = NativeModules.MalachiClipboard;
  return m && typeof m.setSensitive === 'function' && typeof m.clearIfEquals === 'function' ? m : null;
}

async function clearIfStillOurs() {
  const p = pending;
  if (!p) return false;
  let cleared = false;
  let stillOurs = true;
  try {
    const m = nativeModule();
    if (m) {
      const r = await m.clearIfEquals(p.text);   // 'geleert' | 'anders' | 'unklar'
      cleared = r === 'geleert';
      stillOurs = r !== 'anders';
      if (r === 'unklar') {
        if (Date.now() - p.at >= MAX_RETRY_MS) forget(p);   // aufgeben
        return false;                                       // sonst beim naechsten Oeffnen erneut
      }
    } else {
      const current = await Clipboard.getString();
      stillOurs = current === p.text;
      if (stillOurs) { Clipboard.setString(''); cleared = true; }
    }
  } catch {
    // Zwischenablage nicht lesbar - beim naechsten Oeffnen erneut versuchen.
    return false;
  }
  // Geleert, oder (lesbar) inzwischen etwas anderes kopiert: nichts mehr zu tun.
  if (cleared || !stillOurs) forget(p);
  return cleared;
}

function forget(p) {
  if (pending !== p) return;
  pending = null;
  if (timer) { clearTimeout(timer); timer = null; }
  if (appStateSub) { appStateSub.remove(); appStateSub = null; }
}

/**
 * Text geschuetzt kopieren. Rueckgabe: true, wenn als "sensibel" markiert
 * (natives Modul vorhanden), sonst false (einfaches Kopieren).
 */
export async function copySensitive(text) {
  const s = String(text ?? '');
  const m = nativeModule();
  let sensitive = false;
  if (m) {
    try { sensitive = (await m.setSensitive(s)) === true; } catch { sensitive = false; }
  }
  if (!sensitive) Clipboard.setString(s);
  if (pending) forget(pending);
  const p = { text: s, at: Date.now() };
  pending = p;
  timer = setTimeout(() => { clearIfStillOurs(); }, CLEAR_AFTER_MS);
  // Lag die App beim Ablauf im Hintergrund: beim naechsten Oeffnen leeren.
  appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active' && pending === p && Date.now() - p.at >= CLEAR_AFTER_MS) clearIfStillOurs();
  });
  return sensitive;
}

/** Nur fuer Tests: wartende Leerung sofort ausfuehren. */
export function _flushForTests() {
  return clearIfStillOurs();
}
