// CallAudioRoute.js - Lautsprecher an/aus fuer 1:1- und Gruppenanrufe.
//
// Nativ: CallBridgeModule.setSpeaker -> AudioRouteHelper.kt. Laeuft der Anruf
// ueber Telecom (MalachiConnection), schaltet Telecom um (ab Android 14 ueber
// CallEndpoints), sonst der AudioManager. Aeltere Builds ohne diese Methode:
// Rueckfall auf MalachiCallAudio.setSpeaker.
//
// Die Module werden erst beim Aufruf gelesen (Tests setzen NativeModules erst
// nach dem Import).
import { NativeModules, NativeEventEmitter } from 'react-native';

/** Wert von CallAudioState.ROUTE_SPEAKER (so meldet auch Android 14+ den Ausgang). */
export const AUDIO_ROUTE_SPEAKER = 8;

const bridge = () => NativeModules.CallBridgeModule || null;
const callAudio = () => NativeModules.MalachiCallAudio || null;

export function isCallSpeakerSupported() {
  return typeof bridge()?.setSpeaker === 'function' || typeof callAudio()?.setSpeaker === 'function';
}

/** Lautsprecher schalten. Rueckgabe: true, wenn umgeschaltet wurde. */
export async function setCallSpeaker(on) {
  const value = !!on;
  try {
    const b = bridge();
    if (typeof b?.setSpeaker === 'function') return (await b.setSpeaker(value)) !== false;
    const a = callAudio();
    if (typeof a?.setSpeaker === 'function') { a.setSpeaker(value); return true; }
  } catch {}
  return false;
}

/** Meldungen ueber den tatsaechlichen Audio-Ausgang (auch bei Wechsel ueber das System). */
export function onCallAudioRoute(fn) {
  const b = bridge();
  if (!b || typeof fn !== 'function') return () => {};
  let sub = null;
  try {
    sub = new NativeEventEmitter(b).addListener('nativeCallAudioState', (p) => {
      try { fn(Number(p?.route)); } catch {}
    });
  } catch { return () => {}; }
  return () => { try { sub?.remove(); } catch {} };
}
