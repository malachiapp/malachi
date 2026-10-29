/**
 * Malachi – VoiceDraft.tsx
 *
 * Sprachnachricht aufnehmen, anhalten, anhoeren, weiter aufnehmen, senden -
 * EINE Logik und EIN Aussehen fuer 1:1-Chat, Gruppenchat und Siegel
 * (Nutzerwunsch 29.10.2026: "Weiter aufnehmen soll ueberall kommen").
 *
 *  - Aufnahme nur im Arbeitsspeicher (SecureAudio.js). "Weiter aufnehmen"
 *    nimmt einen weiteren Abschnitt auf und haengt ihn an (ADTS laesst sich
 *    aneinanderhaengen) - es entsteht keine Datei. Der Rueckfallweg ohne
 *    natives Modul (MP4) kann nicht verbinden: dort gibt es kein
 *    Weiter-Aufnehmen, Anhalten zeigt trotzdem die Vorschau.
 *  - Anhalten = Vorschau: der Entwurf (base64, Dauer, Pegel) bleibt im State,
 *    bis er gesendet oder verworfen wird. Verlassen des Bildschirms verwirft
 *    ihn und gibt das Mikrofon sofort frei.
 *  - Audio-Fokus (AppFocus.claimAudio): braucht eine andere Stelle Mikrofon
 *    oder Spieler, wird eine laufende Aufnahme zur Vorschau (nichts geht
 *    verloren) - yieldAudio().
 *
 * Darstellung: VoiceRecordingBar (waehrend der Aufnahme) und VoiceDraftBar
 * (Vorschau) - beide ersetzen das Eingabefeld, wie bei WhatsApp.
 */
import React from 'react';
import { View, Text, TouchableOpacity, useWindowDimensions } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { t } from './i18n';
import { getVoicePlayer, appendAdtsBase64, canAppendRecording } from './SecureAudio';
import { createLevelFeed, encodeWave, parseWave, fallbackLevels } from './VoiceWave';
import { releaseAudio } from './AppFocus';
import VoiceWaveView, { LiveRecordingWave } from './VoiceWaveView';

const voice = () => getVoicePlayer();

/**
 * Bisherigen Entwurf und neuen Abschnitt verbinden. Ist der neue Abschnitt
 * leer oder nicht verbindbar, bleibt der bisherige Entwurf.
 * -> { base64, durationMs }
 */
export function joinSegments(base, seg) {
  if (!base) return { base64: seg?.base64 || '', durationMs: seg?.durationMs || 0 };
  const joined = seg?.base64 ? appendAdtsBase64(base.base64, seg.base64) : null;
  if (!joined) return { base64: base.base64, durationMs: base.durationMs };
  return { base64: joined, durationMs: base.durationMs + (seg.durationMs || 0) };
}

export function canResumeDraft(draft, maxMs) {
  return !!draft && canAppendRecording(draft.base64) && draft.durationMs < maxMs;
}

/**
 * opts:
 *  owner          AppFocus-Kennung ('chat' | 'group' | 'siegel')
 *  claim          async () => void   - claimAudio(owner, <stop des Bildschirms>)
 *  maxMs          Obergrenze der ganzen Sprachnachricht
 *  tempHelpers    nur Rueckfallweg (Datei-Ablage, z.B. Siegel-Cache)
 *  ensurePermission async () => bool
 *  beforeUse      () => void        - eigene Wiedergaben des Bildschirms stoppen
 *  onTick         () => void        - z.B. Siegel-Tresor offen halten
 *  onError        (e) => void
 */
export function useVoiceDraft({ owner, claim, maxMs = 5 * 60 * 1000, tempHelpers, ensurePermission, beforeUse, onTick, onError } = {}) {
  const [recording, setRecording] = React.useState(false);
  const [recSecs, setRecSecs] = React.useState(0);
  const [draft, setDraft] = React.useState(null);           // { base64, durationMs, wave, levels, id }
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState({ position: 0, duration: 0 });
  const feedRef = React.useRef(null);
  if (!feedRef.current) feedRef.current = createLevelFeed();
  const activeRef = React.useRef(false);
  const baseRef = React.useRef(null);
  const startRef = React.useRef(0);
  const timerRef = React.useRef(null);
  const playRef = React.useRef(null);
  const busyRef = React.useRef(false);
  const draftRef = React.useRef(null);
  draftRef.current = draft;
  const opts = React.useRef({});
  opts.current = { owner, claim, ensurePermission, beforeUse, onTick, onError, tempHelpers, maxMs };

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  const stopPreview = () => {
    if (playRef.current) { playRef.current = null; voice().stop().catch(() => {}); }
    setPlaying(false);
    setPos({ position: 0, duration: 0 });
  };

  // Aufnahme beenden -> { base64, durationMs, wave, levels } (mit bisherigem Teil) | null
  const stopRaw = async () => {
    stopTimer();
    if (!activeRef.current) return null;
    activeRef.current = false;
    const base = baseRef.current;
    baseRef.current = null;
    const elapsed = Date.now() - startRef.current;
    let rec = null;
    try { rec = await voice().stopRecording(); } catch {}
    setRecording(false);
    setRecSecs(0);
    const seg = rec?.base64 ? { base64: rec.base64, durationMs: rec.durationMs || elapsed } : null;
    const { base64, durationMs } = joinSegments(base, seg);
    const levels = feedRef.current.samples();
    feedRef.current.clear();
    if (!base64) return null;
    return { base64, durationMs, wave: encodeWave(levels) || undefined, levels };
  };

  // Anhalten: laufende Aufnahme wird zur Vorschau.
  const pause = async () => {
    const r = await stopRaw();
    if (r) setDraft({ ...r, id: 'rec_' + Date.now() });
    else releaseAudio(owner);
    return r;
  };

  // Fuer den Audio-Fokus: Aufnahme -> Vorschau, Vorschau-Wiedergabe aus.
  const yieldAudio = async () => {
    stopPreview();
    if (activeRef.current) await pause();
  };

  const start = async (base = null) => {
    if (activeRef.current || busyRef.current) return false;
    busyRef.current = true;
    try {
      const o = opts.current;
      if (o.ensurePermission && !(await o.ensurePermission())) return false;
      o.beforeUse?.();
      stopPreview();
      await o.claim?.();
      if (base?.levels) feedRef.current.load(base.levels);
      else feedRef.current.clear();
      await voice().startRecording((db) => feedRef.current?.push(db), o.tempHelpers);
      activeRef.current = true;
      baseRef.current = base;
      const baseMs = base?.durationMs || 0;
      startRef.current = Date.now();
      setRecSecs(Math.floor(baseMs / 1000));
      setRecording(true);
      timerRef.current = setInterval(() => {
        const total = baseMs + Date.now() - startRef.current;
        setRecSecs(Math.floor(total / 1000));
        try { opts.current.onTick?.(); } catch {}
        if (total >= opts.current.maxMs) pause();
      }, 500);
      return true;
    } catch (e) {
      activeRef.current = false;
      baseRef.current = null;
      try { opts.current.onError?.(e); } catch {}
      return false;
    } finally {
      busyRef.current = false;
    }
  };

  // Vorschau -> weiter aufnehmen (neuer Abschnitt wird angehaengt).
  const resume = async () => {
    const base = draftRef.current;
    if (!canResumeDraft(base, opts.current.maxMs) || activeRef.current) return false;
    stopPreview();
    setDraft(null);
    const ok = await start(base);
    if (!ok) setDraft(base);      // Mikrofon nicht verfuegbar: Vorschau bleibt
    return ok;
  };

  // Zum Senden: laufende Aufnahme beenden bzw. Vorschau nehmen; leert den Entwurf.
  const take = async () => {
    if (activeRef.current) {
      const r = await stopRaw();
      releaseAudio(owner);
      return r;
    }
    const d = draftRef.current;
    stopPreview();
    setDraft(null);
    releaseAudio(owner);
    return d;
  };

  // Alles verwerfen (Aufnahme samt bisherigem Teil bzw. Vorschau).
  const cancel = async () => {
    stopTimer();
    const was = activeRef.current;
    activeRef.current = false;
    baseRef.current = null;
    feedRef.current.clear();
    setRecording(false);
    setRecSecs(0);
    stopPreview();
    setDraft(null);
    if (was) { try { await voice().cancelRecording(); } catch {} }
    releaseAudio(owner);
  };

  const togglePreview = async () => {
    const d = draftRef.current;
    if (!d) return;
    if (playRef.current === d.id && playing) { stopPreview(); return; }
    try {
      opts.current.beforeUse?.();
      await opts.current.claim?.();
      await voice().stop();
      const id = d.id;
      playRef.current = id;
      setPlaying(true);
      await voice().play(d.base64, (e) => {
        if (playRef.current !== id) return;
        if (e.finished) { playRef.current = null; setPlaying(false); setPos({ position: 0, duration: 0 }); }
        else setPos({ position: e.position, duration: e.duration });
        try { opts.current.onTick?.(); } catch {}
      }, { tempHelpers: opts.current.tempHelpers });
    } catch (e) {
      playRef.current = null;
      setPlaying(false);
      try { opts.current.onError?.(e); } catch {}
    }
  };

  // Wellenform angetippt: an diese Stelle (startet die Wiedergabe, falls noetig).
  const seekPreview = async (fraction) => {
    const d = draftRef.current;
    if (!d) return;
    const f = Math.max(0, Math.min(1, fraction));
    if (!playRef.current) {
      await togglePreview();
      if (f < 0.02 || !d.durationMs) return;
    }
    const total = pos.duration || d.durationMs || 0;
    if (!total) return;
    await voice().seek(f * total);
    setPos((p) => ({ ...p, position: f * total }));
  };

  // Bildschirm verlassen: Mikrofon sofort frei, Entwurf verworfen.
  React.useEffect(() => () => {
    stopTimer();
    if (activeRef.current) { activeRef.current = false; voice().cancelRecording().catch(() => {}); }
    if (playRef.current) { playRef.current = null; voice().stop().catch(() => {}); }
    baseRef.current = null;
    releaseAudio(opts.current.owner);
  }, []);

  return {
    recording, recSecs, draft, playing, position: pos.position, duration: pos.duration, feed: feedRef.current,
    canResume: canResumeDraft(draft, maxMs),
    isActive: () => activeRef.current,
    start, pause, resume, take, cancel, discard: () => { stopPreview(); setDraft(null); releaseAudio(owner); },
    togglePreview, seekPreview, stopPreview, yieldAudio,
  };
}

export const fmtVoice = (ms) => Math.floor((ms || 0) / 60000) + ':' + String(Math.floor(((ms || 0) % 60000) / 1000)).padStart(2, '0');
const fmtRec = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

/*
 * Farben (je Bildschirm aus dem Design): bg, border, surfaceAlt, text, textSub,
 * textMuted, danger, dangerFill, onDanger, accent, onAccent.
 */

const ROUND = 40;

// Waehrend der Aufnahme - Aussehen wie im 1:1-Chat (Nutzer 29.10.2026:
// "Sprachaufnahmen Design passt"): rotes Feld mit Punkt, Zeit und Live-Pegel,
// rotes Stopp-Quadrat (-> Vorschau), Senden. Verwerfen nur, wo der Bildschirm
// es bisher schon hatte (Gruppe, Siegel).
export function VoiceRecordingBar({ colors: c, secs, feed, waveStyle = 'bars', onDiscard = null, onPause, onSend, labels = {}, testPrefix = 'voice' }) {
  const { width: W } = useWindowDimensions();
  const waveW = Math.max(56, Math.round(W - 20 - (onDiscard ? ROUND + 8 : 0) - 2 * ROUND - 2 * 8 - 28 - 16 - 54));
  return (
    <View style={{ flexDirection:'row', alignItems:'center', gap:8 }}>
      {!!onDiscard && (
        <TouchableOpacity testID={testPrefix + '-rec-discard'} accessibilityRole="button" accessibilityLabel={labels.discard || t('voice.discard')}
          onPress={onDiscard} style={{ width:ROUND, height:ROUND, borderRadius:20, backgroundColor:c.surfaceAlt, alignItems:'center', justifyContent:'center' }}>
          <Icon name="trash-2" size={18} color={c.text} />
        </TouchableOpacity>
      )}
      <View style={{ flex:1, flexDirection:'row', alignItems:'center', gap:8, backgroundColor:c.surfaceAlt,
        borderRadius:20, borderWidth:0.5, borderColor:c.danger, paddingHorizontal:14, paddingVertical:6, minHeight:ROUND }}>
        <View style={{ width:8, height:8, borderRadius:4, backgroundColor:c.danger }} />
        <Text testID={testPrefix + '-rec-time'} style={{ fontSize:14, color:c.text, fontVariant:['tabular-nums'] }}
          accessibilityLabel={labels.time ? labels.time(fmtRec(secs)) : t('chat.recording', { time: fmtRec(secs) })}>
          {fmtRec(secs)}
        </Text>
        <View style={{ flex:1, alignItems:'flex-end', overflow:'hidden' }}>
          <LiveRecordingWave testID={testPrefix + '-live-wave'} feed={feed} variant={waveStyle} width={waveW} height={24} color={c.danger} />
        </View>
      </View>
      <TouchableOpacity testID={testPrefix + '-rec-pause'} accessibilityRole="button" accessibilityLabel={labels.pause || t('voice.pauseRecording')}
        onPress={onPause} style={{ width:ROUND, height:ROUND, borderRadius:20, backgroundColor:c.dangerFill || c.danger, alignItems:'center', justifyContent:'center' }}>
        <Icon name="square" size={18} color={c.onDanger || '#FFFFFF'} />
      </TouchableOpacity>
      <TouchableOpacity testID={testPrefix + '-rec-send'} accessibilityRole="button" accessibilityLabel={labels.send || t('voice.send')}
        onPress={onSend} style={{ width:ROUND, height:ROUND, borderRadius:20, backgroundColor:c.accent, alignItems:'center', justifyContent:'center' }}>
        <Icon name="send" size={17} color={c.onAccent} />
      </TouchableOpacity>
    </View>
  );
}

// Vorschau: [Verwerfen] [▶ Wellenform Zeit] [extra] [Weiter aufnehmen] [Senden]
export function VoiceDraftBar({ colors: c, draft, playing, position, duration, waveStyle = 'bars', canResume, onDiscard, onPlay, onSeek, onResume, onSend, extra = null, extraWidth = 0, labels = {}, testPrefix = 'voice' }) {
  const { width: W } = useWindowDimensions();
  const total = duration || draft?.durationMs || 0;
  const frac = playing && total ? Math.min(1, position / total) : 0;
  const waveW = Math.max(56, Math.round(W - 20 - 36 - (extraWidth ? extraWidth + 6 : 0) - (canResume ? ROUND + 6 : 0) - ROUND - 18 - 16 - 30 - 12 - 34));
  return (
    <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
      <TouchableOpacity testID={testPrefix + '-preview-discard'} accessibilityRole="button" accessibilityLabel={labels.discard || t('voice.discard')}
        onPress={onDiscard} style={{ width:36, height:ROUND, alignItems:'center', justifyContent:'center' }}>
        <Icon name="trash-2" size={19} color={c.danger} />
      </TouchableOpacity>
      <View style={{ flex:1, flexDirection:'row', alignItems:'center', gap:6, backgroundColor:c.surfaceAlt,
        borderRadius:20, borderWidth:0.5, borderColor:c.border, paddingHorizontal:8, height:ROUND }}>
        <TouchableOpacity testID={testPrefix + '-preview-play'} onPress={onPlay} accessibilityRole="button"
          accessibilityLabel={playing ? t('voice.pause') : t('voice.play')}
          style={{ width:30, height:30, borderRadius:15, backgroundColor:c.accent, alignItems:'center', justifyContent:'center' }}>
          <Icon name={playing ? 'pause' : 'play'} size={15} color={c.onAccent} style={playing ? undefined : { marginLeft:2 }} />
        </TouchableOpacity>
        <View style={{ flex:1, alignItems:'center', overflow:'hidden' }}>
          <VoiceWaveView testID={testPrefix + '-preview-wave'} levels={parseWave(draft?.wave) || fallbackLevels(draft?.id || 'x')}
            progress={frac} animate={playing} variant={waveStyle} width={waveW} height={22}
            activeColor={c.accent} idleColor={c.border} onSeek={onSeek} accessibilityLabel={t('voice.seek')} />
        </View>
        <Text style={{ fontSize:12, color:c.textSub, minWidth:34, textAlign:'right', fontVariant:['tabular-nums'] }}>
          {fmtVoice(playing ? position : total)}
        </Text>
      </View>
      {extra}
      {canResume && (
        <TouchableOpacity testID={testPrefix + '-preview-resume'} onPress={onResume} accessibilityRole="button"
          accessibilityLabel={t('voice.resume')}
          style={{ width:ROUND, height:ROUND, borderRadius:20, backgroundColor:c.surfaceAlt, borderWidth:1,
            borderColor:c.danger, alignItems:'center', justifyContent:'center' }}>
          <Icon name="mic" size={18} color={c.danger} />
        </TouchableOpacity>
      )}
      <TouchableOpacity testID={testPrefix + '-preview-send'} onPress={onSend} accessibilityRole="button" accessibilityLabel={labels.send || t('voice.send')}
        style={{ width:ROUND, height:ROUND, borderRadius:20, backgroundColor:c.accent, alignItems:'center', justifyContent:'center' }}>
        <Icon name="send" size={17} color={c.onAccent} />
      </TouchableOpacity>
    </View>
  );
}
