// VoiceWaveView.tsx - Wellenform einer Sprachnachricht (Blase, Vorschau,
// Live-Anzeige beim Aufnehmen). Daten und Geometrie: VoiceWave.js.
import React from 'react';
import { View, Pressable, AccessibilityInfo } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { barsPaths, pixelPaths, levelFromDb, resample } from './VoiceWave';

// Pixel-Welle: Schrittweite und Takt der Bewegung (nur waehrend Abspielen/
// Aufnehmen, nur in dieser einen Blase - der Chat zeichnet dafuer nicht neu).
const PHASE_STEP = 0.55;
const FRAME_MS = 90;

function useReduceMotion() {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive && v) setReduce(true); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => setReduce(!!v));
    return () => { alive = false; try { sub?.remove?.(); } catch {} };
  }, []);
  return reduce;
}

export default function VoiceWaveView({
  levels, progress = 0, animate = false, variant = 'bars', width = 150, height = 28,
  activeColor, idleColor, onSeek = null, testID, accessibilityLabel,
}) {
  const reduceMotion = useReduceMotion();
  const moving = variant === 'pixel' && animate && !reduceMotion;
  const [phase, setPhase] = React.useState(0);
  React.useEffect(() => {
    if (!moving) { setPhase(0); return undefined; }
    const id = setInterval(() => setPhase((p) => (p + PHASE_STEP) % (Math.PI * 2)), FRAME_MS);
    return () => clearInterval(id);
  }, [moving]);

  const geo = variant === 'pixel'
    ? pixelPaths(levels, width, height, progress, phase)
    : barsPaths(levels, width, height, progress);
  const draw = (d, color) => (!d ? null : variant === 'pixel'
    ? <Path d={d} fill={color} />
    : <Path d={d} stroke={color} strokeWidth={geo.strokeWidth} strokeLinecap="round" fill="none" />);
  const svg = (
    <Svg width={width} height={height}>
      {draw(geo.rest, idleColor)}
      {draw(geo.played, activeColor)}
    </Svg>
  );
  if (!onSeek) {
    return <View testID={testID} style={{ width, height }} accessibilityLabel={accessibilityLabel}>{svg}</View>;
  }
  return (
    <Pressable testID={testID} style={{ width, height }} hitSlop={{ top:8, bottom:8 }}
      accessibilityRole="adjustable" accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min:0, max:100, now: Math.round(Math.max(0, Math.min(1, progress)) * 100) }}
      onPress={(e) => onSeek(Math.max(0, Math.min(1, e.nativeEvent.locationX / width)))}>
      {svg}
    </Pressable>
  );
}

/**
 * Live-Anzeige waehrend der Aufnahme: zeigt die letzten Messwerte (rechts die
 * neuesten). Bekommt die Werte direkt aus dem Pegel-Verteiler (VoiceWave.
 * createLevelFeed), nicht ueber den Chat-State.
 */
export function LiveRecordingWave({ feed, variant = 'bars', width = 150, height = 24, color, testID }) {
  const cols = variant === 'pixel' ? Math.floor(width / 4) : Math.floor((width + 1.5) / 4);
  const [levels, setLevels] = React.useState(() => new Array(cols).fill(0));
  React.useEffect(() => {
    if (!feed) return undefined;
    return feed.subscribe((samples) => {
      const recent = samples.slice(-cols).map(levelFromDb);
      setLevels(new Array(Math.max(0, cols - recent.length)).fill(0).concat(recent));
    });
  }, [feed, cols]);
  return (
    <VoiceWaveView testID={testID} levels={resample(levels, cols)} progress={1} animate variant={variant}
      width={width} height={height} activeColor={color} idleColor={color} />
  );
}
