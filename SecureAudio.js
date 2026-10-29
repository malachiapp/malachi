/**
 * Malachi – SecureAudio.js
 *
 * Sprachnachrichten aufnehmen und abspielen, OHNE dass eine lesbare
 * Audiodatei entsteht (Audit 2026-10-25, Restrisiko "Klartext im Cache").
 *
 * Nativ (vault/MalachiSecureAudioModule.kt):
 *  - Aufnahme direkt in den Arbeitsspeicher (AAC/ADTS, 16 kHz mono, wie
 *    bisher 32 kbit/s), Mikrofon ab Android 11 "privacy sensitive" - keine
 *    andere App kann waehrenddessen mitschneiden.
 *  - Wiedergabe aus dem Arbeitsspeicher (MediaDataSource), auch fuer alte
 *    .mp4-Nachrichten; der Puffer wird danach ueberschrieben.
 *
 * Fehlt das native Modul (Jest, aeltere Bauweise), faellt alles auf den
 * bisherigen Weg zurueck: react-native-audio-recorder-player mit kurz
 * lebender Cache-Datei (Praefixe malachi_/play_, vom Wipe erfasst).
 *
 * Eine gemeinsame Instanz fuer Chat, Gruppenchat und Siegel - es gibt nur
 * EIN Mikrofon und einen Spieler; wer gerade spielt/aufnimmt, regelt
 * AppFocus.claimAudio().
 *
 *   const vp = getVoicePlayer();
 *   await vp.startRecording((db) => feed.push(db));
 *   const { base64, durationMs } = await vp.stopRecording();
 *   await vp.play(base64, (e) => ..., { startMs, speed });  // e: { position, duration, finished, error }
 */
import { NativeModules, DeviceEventEmitter } from 'react-native';
import RNFS from 'react-native-fs';
import { Buffer } from 'buffer';

const LEVEL_EVENT = 'MalachiSecureAudioLevel';
const PLAYBACK_EVENT = 'MalachiSecureAudioPlayback';

const native = () => NativeModules.MalachiSecureAudio;

export function isSecureAudioAvailable() {
  const n = native();
  return !!(n && typeof n.startRecording === 'function' && typeof n.play === 'function');
}

let libCache = null;
function lib() {
  if (!libCache) {
    const l = require('react-native-audio-recorder-player');
    libCache = { types: l, player: new l.default() };
  }
  return libCache;
}

const defaultTemp = {
  recordPath: async () => `${RNFS.CachesDirectoryPath}/malachi_${Date.now()}.mp4`,
  playPath: async () => `${RNFS.CachesDirectoryPath}/play_${Date.now()}.mp4`,
  write: async (path, b64) => { await RNFS.writeFile(path, b64, 'base64'); return path; },
  read: (path) => RNFS.readFile(path, 'base64'),
  remove: (path) => RNFS.unlink(path).catch(() => {}),
};

function createVoicePlayer() {
  let levelSub = null;
  let playSub = null;
  let playSeq = 0;
  let speed = 1;
  // Rueckfallweg: Pfade der kurz lebenden Klartext-Dateien.
  let recFile = null;
  let playFile = null;
  let temp = defaultTemp;

  const dropLevel = () => { try { levelSub?.remove(); } catch {} levelSub = null; };
  const dropPlay = () => { try { playSub?.remove(); } catch {} playSub = null; };

  return {
    get secure() { return isSecureAudioAvailable(); },

    async startRecording(onLevel, tempHelpers) {
      if (isSecureAudioAvailable()) {
        dropLevel();
        levelSub = DeviceEventEmitter.addListener(LEVEL_EVENT, (e) => { try { onLevel?.(e?.db); } catch {} });
        try {
          await native().startRecording();
        } catch (e) {
          dropLevel();
          throw e;
        }
        return;
      }
      temp = { ...defaultTemp, ...(tempHelpers || {}) };
      const { types, player } = lib();
      recFile = await temp.recordPath();
      await player.setSubscriptionDuration?.(0.1)?.catch?.(() => {});
      try { player.addRecordBackListener?.((e) => { try { onLevel?.(e?.currentMetering); } catch {} }); } catch {}
      try {
        await player.startRecorder(recFile, {
          AudioSourceAndroid: types.AudioSourceAndroidType?.MIC,
          OutputFormatAndroid: types.OutputFormatAndroidType?.MPEG_4,
          AudioEncoderAndroid: types.AudioEncoderAndroidType?.AAC,
          AudioSamplingRateAndroid: 16000,
          AudioEncodingBitRateAndroid: 32000,
          AudioChannelsAndroid: 1,
        }, true);
      } catch (e) {
        const f = recFile;
        recFile = null;
        if (f) temp.remove(f);
        throw e;
      }
    },

    // -> { base64, durationMs } (durationMs nur nativ; sonst null)
    async stopRecording() {
      if (isSecureAudioAvailable()) {
        dropLevel();
        const r = await native().stopRecording();
        return { base64: r?.base64 || '', durationMs: Number.isFinite(r?.durationMs) ? r.durationMs : null };
      }
      const { player } = lib();
      const f = recFile;
      recFile = null;
      try { player.removeRecordBackListener?.(); } catch {}
      player.setSubscriptionDuration?.(0.5)?.catch?.(() => {});
      try {
        await player.stopRecorder();
        return { base64: f ? await temp.read(f) : '', durationMs: null };
      } finally {
        if (f) temp.remove(f);   // rohe Aufnahme sofort weg
      }
    },

    async cancelRecording() {
      if (isSecureAudioAvailable()) {
        dropLevel();
        try { await native().cancelRecording(); } catch {}
        return;
      }
      const { player } = lib();
      const f = recFile;
      recFile = null;
      try { player.removeRecordBackListener?.(); } catch {}
      try { player.setSubscriptionDuration?.(0.5)?.catch?.(() => {}); } catch {}
      try { await player.stopRecorder(); } catch {}
      if (f) temp.remove(f);
    },

    // Startet die Wiedergabe; onEvent({ position, duration, finished, error }).
    // Liefert die Dauer in ms (nativ) bzw. undefined.
    async play(base64, onEvent, { startMs = 0, speed: rate, tempHelpers } = {}) {
      await this.stop();
      if (Number.isFinite(rate) && rate > 0) speed = rate;
      if (isSecureAudioAvailable()) {
        const id = String(++playSeq);
        playSub = DeviceEventEmitter.addListener(PLAYBACK_EVENT, (e) => {
          if (!e || e.id !== id) return;
          if (e.finished) dropPlay();
          try { onEvent?.({ position: e.position || 0, duration: e.duration || 0, finished: !!e.finished, error: !!e.error }); } catch {}
        });
        try {
          return await native().play(id, base64, Math.max(0, startMs || 0), speed);
        } catch (e) {
          dropPlay();
          throw e;
        }
      }
      temp = { ...defaultTemp, ...(tempHelpers || {}) };
      const { player } = lib();
      const f = await temp.write(await temp.playPath(), base64);
      playFile = f;
      player.addPlayBackListener((e) => {
        const finished = !!e?.isFinished || (e?.duration > 0 && e.currentPosition >= e.duration);
        try { onEvent?.({ position: e?.currentPosition || 0, duration: e?.duration || 0, finished, error: false }); } catch {}
        if (finished) this.stop();
      });
      try {
        await player.startPlayer(f);
        if (startMs > 0) await player.seekToPlayer?.(startMs)?.catch?.(() => {});
        if (speed !== 1) await player.setPlaybackSpeed?.(speed)?.catch?.(() => {});
      } catch (e) {
        await this.stop();
        throw e;
      }
      return undefined;
    },

    async stop() {
      if (isSecureAudioAvailable()) {
        dropPlay();
        try { await native().stop(); } catch {}
        return;
      }
      const f = playFile;
      playFile = null;
      if (!libCache && !f) return;
      const { player } = lib();
      try { player.removePlayBackListener(); } catch {}
      try { await player.stopPlayer(); } catch {}
      if (f) temp.remove(f);
    },

    async pause() {
      if (isSecureAudioAvailable()) { try { await native().pause(); } catch {} return; }
      try { await lib().player.pausePlayer?.(); } catch {}
    },

    async resume() {
      if (isSecureAudioAvailable()) { try { await native().resume(); } catch {} return; }
      try { await lib().player.resumePlayer?.(); } catch {}
    },

    async seek(ms) {
      const target = Math.max(0, ms || 0);
      if (isSecureAudioAvailable()) { try { await native().seek(target); } catch {} return; }
      try { await lib().player.seekToPlayer?.(target); } catch {}
    },

    async setSpeed(rate) {
      if (!Number.isFinite(rate) || rate <= 0) return;
      speed = rate;
      if (isSecureAudioAvailable()) { try { await native().setSpeed(rate); } catch {} return; }
      try { await lib().player.setPlaybackSpeed?.(rate); } catch {}
    },
  };
}

// ── Aufnahme fortsetzen (Nutzerwunsch 29.10.2026) ──────────────────────────
// Die sichere Aufnahme liefert AAC als ADTS-Rahmenfolge: jeder Rahmen traegt
// seinen eigenen Kopf, zwei Aufnahmen hintereinandergehaengt sind wieder eine
// gueltige Aufnahme. "Fortsetzen" nimmt deshalb einfach einen weiteren
// Abschnitt auf (ebenfalls nur im Arbeitsspeicher) und haengt ihn an - es
// entsteht dabei keine Datei. Der Rueckfallweg (MP4-Container aus der
// Bibliothek) laesst sich so nicht verbinden: dort gibt es kein Fortsetzen.
const ADTS_MIN = 7;

/** Beginnt der Inhalt mit einem ADTS-Rahmen (Sync 0xFFF, Layer 0)? */
export function isAdtsBase64(b64) {
  if (typeof b64 !== 'string' || b64.length < 12) return false;
  const head = Buffer.from(b64.slice(0, 12), 'base64');
  return head.length >= ADTS_MIN && head[0] === 0xFF && (head[1] & 0xF6) === 0xF0;
}

/** Zwei ADTS-Aufnahmen (base64) aneinanderhaengen -> base64, oder null, wenn eine kein ADTS ist. */
export function appendAdtsBase64(first, second) {
  if (!isAdtsBase64(first) || !isAdtsBase64(second)) return null;
  const a = Buffer.from(first, 'base64');
  const b = Buffer.from(second, 'base64');
  const both = Buffer.concat([a, b]);
  const out = both.toString('base64');
  // Zwischenpuffer gleich ueberschreiben (Strings kann JS nicht loeschen).
  a.fill(0); b.fill(0); both.fill(0);
  return out;
}

/** Laesst sich an diese Aufnahme ein weiterer Abschnitt anhaengen? */
export function canAppendRecording(base64) {
  return isSecureAudioAvailable() && isAdtsBase64(base64);
}

let shared = null;
export function getVoicePlayer() {
  if (!shared) shared = createVoicePlayer();
  return shared;
}

export function _resetSecureAudioForTests() {
  shared = null;
  libCache = null;
}
