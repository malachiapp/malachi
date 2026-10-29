/**
 * Malachi – GroupChatScreen.tsx
 *
 * Gruppenchat (GroupMessaging.js, GROUP_CHAT_DESIGN.md): Verlauf aus
 * 'gchat_<groupId>', Senden per Fan-out ueber die Sende-Warteschlange an jedes
 * direkt gekoppelte Mitglied. Eingehende Nachrichten legt GroupMessaging
 * zentral ab (auch bei geschlossenem Chat bzw. im Hintergrund) - dieser
 * Bildschirm liest nur und abonniert Aenderungen.
 *
 * Haekchen eigener Nachrichten: ⏳ wird eingereiht, ✓ bei allen erreichbaren
 * Mitgliedern verschluesselt eingereiht, ✓✓ von allen bestaetigt (dazwischen
 * "x/n"), ❌ bei mindestens einem nicht einreihbar, – niemand direkt erreichbar.
 *
 * Bilder und Sprachnachrichten (2026-10-19): gleicher verschluesselter
 * Medienweg wie im 1:1-Chat, je Mitglied eine eigene Kopie
 * (GroupMessaging.sendGroupMedia). Rohe Aufnahme- und Wiedergabedateien liegen
 * nur kurz im Cache und werden sofort danach geloescht.
 */
import React from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Alert, KeyboardAvoidingView,
  Dimensions, Image, Modal, PermissionsAndroid, I18nManager, StyleSheet,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import RNFS from 'react-native-fs';
import RTCStore from './RTCStore';
import {
  loadGroupChat, subscribeGroupChat, sendGroupText, sendGroupMedia, markGroupRead,
  resolveGroupMembers, unreachableMembers, deliveredCount, groupMediaScope,
  isReadOnlyChannel, incomingIntroCount,
} from './GroupMessaging';
import { getLicenseState, subscribeLicense } from './LicenseManager';
import { levelsFor, effectiveWaveStyle, subscribeWaveStyle } from './VoiceWave';
import VoiceWaveView from './VoiceWaveView';
// Aufnehmen, Anhalten/Vorschau, Weiter aufnehmen, Senden - wie im 1:1-Chat.
import { useVoiceDraft, VoiceRecordingBar, VoiceDraftBar } from './VoiceDraft';
import { useBackHandler } from './BackStack';
import { mediaData } from './MediaVault';
import { GroupAvatar, DEFAULT_PALETTE, gs } from './GroupScreens';
import { ensureContrast } from './Themes';
import { withAutoLockSuspended, claimAudio, releaseAudio } from './AppFocus';
import { getVoicePlayer } from './SecureAudio';
import ChatArtwork, { chatArtworkVisible } from './ChatArtwork';
import { copySensitive } from './SecureClipboard';
import {
  getGroupCallSnapshot, subscribeGroupCall, startGroupCall, runningGroupCallFor, joinRunningGroupCall,
  canStartGroupCall, GroupCallState, groupCallProNotice, groupCallTorOnlyNotice, groupCallBusyNotice,
} from './GroupCallManager';
import { t, formatTime } from './i18n';

const { width: W } = Dimensions.get('window');
const WARN = '#E0A33A';
const SENDER_COLORS = ['#8FD9F0', '#F5B971', '#B5E48C', '#F28FAD', '#C3A6FF', '#7FDBCA', '#FFD166'];
const MAX_RECORD_MS = 5 * 60 * 1000;

// Native Bibliotheken erst bei Bedarf laden (wie SiegelScreen). Der native
// Spieler/Rekorder ist nur EINER - Konflikte regelt AppFocus.claimAudio.
const imagePicker = () => require('react-native-image-picker');
// Sprachnachrichten nur im Arbeitsspeicher (SecureAudio.js) - keine
// Klartext-Datei mehr im Cache, weder beim Aufnehmen noch beim Abspielen.
const voice = () => getVoicePlayer();
const GROUP_TEMP = {
  recordPath: async () => `${RNFS.CachesDirectoryPath}/malachi_grp_rec_${Date.now()}.mp4`,
  playPath: async () => `${RNFS.CachesDirectoryPath}/malachi_grp_play_${Date.now()}.mp4`,
};

// Absenderfarbe: fester Farbton je Mitglied, aber auf der Blasenfarbe des
// Designs lesbar gemacht (vorher feste Pastelltoene - in hellen Designs kaum
// zu lesen).
function senderColor(mid, onBg) {
  let h = 0;
  for (const ch of String(mid || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const c = SENDER_COLORS[h % SENDER_COLORS.length];
  try { return onBg ? ensureContrast(c, onBg) : c; } catch { return c; }
}

export function groupStatusIcon(status) {
  switch (status) {
    case 'sending':   return '⏳';
    case 'failed':    return '❌';
    case 'delivered': return '✓✓';
    case 'none':      return '–';
    default:          return '✓';
  }
}

// Gruppenanruf (GroupCallManager.js): warum er nicht startet bzw. der
// Beitritt nicht geht.
export function groupCallErrorText(error) {
  switch (error) {
    case 'pro': return groupCallProNotice();
    case 'tor_only': return groupCallTorOnlyNotice();
    case 'busy': return groupCallBusyNotice();
    case 'no_reachable': return t('groupChatUi.niemandAusDerGruppeIst');
    case 'mic': return t('groupChatUi.fuerGruppenanrufeBrauchtMalachiDas');
    case 'not_member': return t('groupChat.notMember');
    case 'gone': return t('groupChatUi.derGruppenanrufLaeuftNichtMehr');
    default: return t('groupChatUi.derGruppenanrufKonnteNichtGestartet');
  }
}

const fmtTime = (ms) => (Number.isFinite(ms)
  ? formatTime(ms) : '');
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// Audit G1: Gruppen-Bild aus dem Verlauf - Inhalt im RAM oder aus der
// verschluesselten Ablage (MediaVault.js), erst beim Anzeigen geladen.
function groupImageUri(item, data) {
  return data ? `data:${item.mimeType || 'image/jpeg'};base64,${data}` : null;
}
function GroupVaultImage({ scope, item, style, onOpen }) {
  const inline = typeof item?.base64 === 'string' ? item.base64 : null;
  const [loaded, setLoaded] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (inline) return undefined;
    let alive = true;
    setLoaded(null);
    setFailed(false);
    mediaData(scope, item).then((d) => {
      if (!alive) return;
      if (d) setLoaded(d); else setFailed(true);
    });
    return () => { alive = false; };
  }, [scope, item?.id, item?.mref, inline]);
  const uri = groupImageUri(item, inline || loaded);
  if (!uri) {
    return (
      <View style={[style, { alignItems:'center', justifyContent:'center', backgroundColor:'rgba(127,127,127,0.15)' }]}>
        <Icon name={failed ? 'image' : 'loader'} size={22} color="#888" />
      </View>
    );
  }
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={() => onOpen(uri)} accessibilityLabel={t('a11y.enlargeImage')}>
      <Image source={{ uri }} style={style} resizeMode="cover" />
    </TouchableOpacity>
  );
}

export default function GroupChatScreen({ group, contacts, onBack, onOpenDetail, fontSize, palette = DEFAULT_PALETTE, accent = DEFAULT_PALETTE.green, customBg = null }) {
  const groupId = group?.groupId || null;
  const mediaScope = groupId ? groupMediaScope(groupId) : null;   // Audit G1 (MediaVault.js)
  const [msgs, setMsgs] = React.useState([]);
  const [text, setText] = React.useState('');
  const [, tick] = React.useReducer(x => x + 1, 0);
  const [viewer, setViewer] = React.useState(null);        // data:-URI des vergroesserten Bildes
  const [playingId, setPlayingId] = React.useState(null);
  const [playPos, setPlayPos] = React.useState({ position: 0, duration: 0 });
  // Sprachnachrichten wie im 1:1-Chat (VoiceWave.js): Wellenform in der
  // Blase, Stil aus den Einstellungen.
  const [waveStyle, setWaveStyle] = React.useState(() => effectiveWaveStyle(getLicenseState().pro === true));
  React.useEffect(() => {
    const update = () => setWaveStyle(effectiveWaveStyle(getLicenseState().pro === true));
    const offStyle = subscribeWaveStyle(update);
    const offLicense = subscribeLicense(update);
    return () => { offStyle(); try { offLicense?.(); } catch {} };
  }, []);
  const listRef = React.useRef(null);
  const playPath = React.useRef(null);
  // Gruppenanruf: eigener Zustand bzw. laufender Anruf dieser Gruppe.
  const [callSnap, setCallSnap] = React.useState(getGroupCallSnapshot());
  React.useEffect(() => subscribeGroupCall(setCallSnap), []);

  // Menue einer Nachricht (lange druecken): Kopieren (nur Text, geschuetzt -
  // SecureClipboard.js) und bei eigenen Nachrichten die Zustellung.
  const [menu, setMenu] = React.useState(null);   // Nachricht
  const [copied, setCopied] = React.useState(false);
  const copiedTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const isText = (item) => !!item && typeof item.text === 'string' && item.text.length > 0 && (!item.type || item.type === 'text');
  const copyText = (text) => {
    copySensitive(text).catch(() => {});
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2500);
  };

  // Farben (Design-Tokens; DEFAULT_PALETTE der Gruppen-Bildschirme als Rueckfall)
  const C = {
    mine: palette.bubbleMine || accent, mineText: palette.bubbleMineText || '#FFFFFF',
    mineMeta: palette.bubbleMineMeta || 'rgba(255,255,255,0.7)',
    theirs: palette.bubbleTheirs || palette.surface, theirsBorder: palette.bubbleTheirsBorder || palette.border,
    theirsText: palette.bubbleTheirsText || palette.text, theirsMeta: palette.bubbleTheirsMeta || palette.textMuted,
    accent: palette.accent || accent, onAccent: palette.onAccent || '#FFFFFF', accentFg: palette.accentFg || accent,
    danger: palette.danger || '#E74C3C', dangerFill: palette.dangerFill || '#C0392B', onDanger: palette.onDanger || '#FFFFFF',
    menuBg: palette.menuBg || palette.surface, menuBorder: palette.menuBorder || palette.border,
    menuText: palette.menuText || palette.text, menuIcon: palette.menuIcon || palette.textMuted,
    overlay: palette.overlay || 'rgba(0,0,0,0.45)',
  };

  React.useEffect(() => {
    if (!groupId) return undefined;
    let alive = true;
    const unsub = subscribeGroupChat(groupId, (list) => { if (alive) setMsgs(list); });
    loadGroupChat(groupId).then((list) => { if (alive) setMsgs(list); }).catch(() => {});
    markGroupRead(groupId);
    return () => { alive = false; unsub(); };
  }, [groupId]);

  // Ungelesen-Zaehler bleibt bei offenem Chat 0 (GroupMessaging zaehlt dann
  // nicht hoch) - nur der Stand vom Oeffnen wird oben zurueckgesetzt.
  React.useEffect(() => {
    if (groupId && group?.unread) markGroupRead(groupId);
  }, [groupId, group?.unread]);

  // Verbindungsanzeige im Kopf (rein lesend).
  React.useEffect(() => {
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  // ── Wiedergabe / Aufnahme ────────────────────────────────────────────────
  const stopPlayback = () => {
    const playing = playPath.current;
    playPath.current = null;
    setPlayingId(null);
    setPlayPos({ position: 0, duration: 0 });
    if (!playing) return;
    voice().stop().catch(() => {});
    releaseAudio('group');
  };
  // Aufnahme (VoiceDraft.tsx): nur im Arbeitsspeicher; Anhalten zeigt die
  // Vorschau, dort weiter aufnehmen oder senden. Braucht eine andere Stelle
  // (Siegel, 1:1-Chat) Mikrofon oder Spieler, wird die Aufnahme zur Vorschau.
  const stopGroupAudio = async () => { stopPlayback(); await rec.yieldAudio(); };
  const rec = useVoiceDraft({
    owner: 'group',
    claim: () => claimAudio('group', stopGroupAudio),
    maxMs: MAX_RECORD_MS,
    tempHelpers: GROUP_TEMP,
    beforeUse: () => stopPlayback(),
    ensurePermission: async () => {
      const granted = await withAutoLockSuspended(() => PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        { title: t('common.microphone'), message: t('groupChatUi.malachiBenoetigtMikrofonZugriffFuer'), buttonPositive: 'OK' },
      ));
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert(t('common.microphone'), t('groupChatUi.ohneMikrofonZugriffKeineSprachnachricht'));
        return false;
      }
      return true;
    },
    onError: () => Alert.alert(t('common.voiceMessage'), t('groupChatUi.dieAufnahmeKonnteNichtGestartet')),
  });
  React.useEffect(() => () => { stopPlayback(); }, []);   // beim Verlassen: nichts liegen lassen (Aufnahme: VoiceDraft)
  // Zurueck-Taste (BackStack.js): Aufnahme -> Vorschau, Vorschau -> verwerfen,
  // erst danach zurueck zur Liste.
  useBackHandler(rec.recording, () => { rec.pause(); });
  useBackHandler(!!rec.draft && !rec.recording, () => { rec.discard(); });

  const togglePlay = async (item, startMs = 0) => {
    if (playingId === item.id) { stopPlayback(); return; }
    stopPlayback();
    await rec.yieldAudio();      // laufende Aufnahme -> Vorschau, Vorschau-Wiedergabe aus
    try {
      await claimAudio('group', stopGroupAudio);
      const data = await mediaData(mediaScope, item);   // Audit G1: RAM oder Ablage
      if (!data) throw new Error('nicht verfuegbar');
      const token = item.id + '|' + Date.now();
      playPath.current = token;
      setPlayingId(item.id);
      setPlayPos({ position: startMs, duration: item.durationMs || 0 });
      await voice().play(data, (e) => {
        if (playPath.current !== token) return;
        if (e.finished) stopPlayback();
        else setPlayPos({ position: e.position || 0, duration: e.duration || item.durationMs || 0 });
      }, { startMs, tempHelpers: GROUP_TEMP });
    } catch {
      stopPlayback();
      Alert.alert(t('common.voiceMessage'), t('groupChatUi.dieSprachnachrichtKonnteNichtAbgespielt'));
    }
  };

  // Wellenform angetippt: an diese Stelle springen (startet die Wiedergabe).
  const seekVoice = async (item, f) => {
    if (playingId !== item.id) {
      await togglePlay(item, item.durationMs && f >= 0.02 ? f * item.durationMs : 0);
      return;
    }
    const total = playPos.duration || item.durationMs || 0;
    if (!total) return;
    await voice().seek(f * total);
    setPlayPos((p) => ({ ...p, position: f * total }));
  };

  const startRecording = () => { if (!readOnly) rec.start(); };

  // Senden - waehrend der Aufnahme direkt, sonst die Vorschau (samt
  // weiter aufgenommener Abschnitte).
  const sendRecording = async () => {
    const r = await rec.take();
    if (!r || !r.base64 || r.durationMs < 600) return;  // versehentlich angetippt
    const res = await sendGroupMedia(groupId, { kind: 'audio', base64: r.base64, durationMs: r.durationMs, wave: r.wave }).catch(() => ({ error: 'send' }));
    reportSendError(res);
    setTimeout(() => listRef.current?.scrollToEnd({ animated:true }), 100);
  };

  const pickImage = async () => {
    if (readOnly) return;
    try {
      const res = await withAutoLockSuspended(() => imagePicker().launchImageLibrary({
        mediaType: 'photo', includeBase64: true, quality: 0.7, maxWidth: 1600, maxHeight: 1600, selectionLimit: 1,
      }));
      const asset = res?.assets?.[0];
      // Kopie der Bildauswahl im App-Cache sofort entfernen (nur der
      // verschluesselte Versand bleibt).
      if (asset?.uri && asset.uri.startsWith('file://') && asset.uri.includes(RNFS.CachesDirectoryPath)) {
        RNFS.unlink(asset.uri.replace('file://', '')).catch(() => {});
      }
      if (res?.didCancel || !asset?.base64) return;
      const r = await sendGroupMedia(groupId, { kind: 'image', base64: asset.base64, mimeType: asset.type || 'image/jpeg' });
      reportSendError(r);
      setTimeout(() => listRef.current?.scrollToEnd({ animated:true }), 100);
    } catch {
      Alert.alert(t('common.image'), t('groupChatUi.dasBildKonnteNichtGesendet'));
    }
  };

  const reportSendError = (r) => {
    if (!r?.error) return;
    if (r.error === 'not_member') Alert.alert(t('common.group'), t('groupChat.notMember'));
    else if (r.error === 'channel_readonly') Alert.alert(t('channel.title'), t('channel.readOnlyBar'));
    else if (r.error === 'too_large') Alert.alert(t('groupChatUi.zuGross'), t('groupChatUi.dasIstFuerEineGruppe'));
    else Alert.alert(t('common.group'), t('groupChatUi.dasKonnteNichtGesendetWerden'));
  };

  if (!group) return null;
  const members = resolveGroupMembers(group, contacts);
  const unreachable = unreachableMembers(group, contacts);
  const others = members.filter(m => !m.isSelf);
  const reachable = others.filter(m => m.contactId && !m.wiped);
  const connected = reachable.filter(m => RTCStore.isConnected(m.contactId)).length;
  const nameOf = (mid, fallbackContactId) => {
    const m = members.find(x => x.mid === mid);
    if (m) return m.name;
    const c = fallbackContactId ? (contacts || []).find(x => x.id === fallbackContactId) : null;
    return c?.name || t('groupChat.formerMember');
  };
  // Kanal (GroupMessaging): nur Admins schreiben; Abonnenten lesen nur.
  const channel = group.mode === 'channel';
  const channelReader = isReadOnlyChannel(group, group.selfMid);
  const readOnly = !!group.removed || channelReader;
  const introRequests = incomingIntroCount(group);
  const runningCall = callSnap.state === GroupCallState.IDLE ? runningGroupCallFor(groupId) : null;
  const joinCall = () => {
    joinRunningGroupCall(groupId).then((r) => {
      if (r?.error && r.error !== 'failed') Alert.alert(t('groupChatUi.gruppenanruf'), groupCallErrorText(r.error));
    }).catch(() => {});
  };
  // "Gruppenanruf": starten nur mit Vollversion, teilnehmen/beitreten kann jeder.
  const onGroupCall = () => {
    if (readOnly) return;
    if (callSnap.state !== GroupCallState.IDLE) { Alert.alert(t('groupChatUi.gruppenanruf'), groupCallBusyNotice()); return; }
    if (runningCall) { joinCall(); return; }
    if (!canStartGroupCall()) { Alert.alert(t('common.fullVersion'), groupCallProNotice()); return; }
    startGroupCall(groupId).then((r) => {
      if (r?.error) Alert.alert(t('groupChatUi.gruppenanruf'), groupCallErrorText(r.error));
    }).catch(() => Alert.alert(t('groupChatUi.gruppenanruf'), groupCallErrorText('error')));
  };

  const send = () => {
    const msgText = text.trim();
    if (!msgText || readOnly) return;
    setText('');
    sendGroupText(groupId, msgText).then((r) => {
      if (r?.error) Alert.alert(t('common.group'), t('groupChat.notMember'));
    }).catch(() => Alert.alert(t('common.group'), t('groupChat.sendFailed')));
    setTimeout(() => listRef.current?.scrollToEnd({ animated:true }), 100);
  };

  const showDelivery = (item) => {
    const rec = item.recipients || {};
    const lines = Object.entries(rec).map(([mid, st]) => {
      const label = st === 'delivered' ? t('groupChat.st.delivered') : st === 'queued' ? t('groupChat.st.queued')
        : st === 'failed' ? t('groupChat.st.failed') : t('groupChat.st.sending');
      return `${nameOf(mid)}: ${label}`;
    });
    const notReached = unreachable.map(m => m.name);
    Alert.alert(t('groupChat.delivery'),
      (lines.length ? lines.join('\n') : t('groupChat.nobody'))
      + (notReached.length ? '\n\n' + t('groupChat.notReached', { names: notReached.join(', ') }) : ''));
  };

  const fs = typeof fontSize === 'number' ? fontSize : 15;
  const statusLine = group.removed ? t('groupChat.noLongerMember')
    : channel ? (channelReader ? t('channel.statusReader', { count: group.memberCount || members.length }) : t('channel.statusAdmin', { count: members.length - 1, connected }))
    : t('groupChat.status', { count: members.length, connected, total: reachable.length });

  // Inhalt einer Blase: Text, Bild oder Sprachnachricht.
  const body = (item, mine) => {
    const fg = mine ? C.mineText : C.theirsText;
    const hasMedia = typeof item.base64 === 'string' || typeof item.mref === 'string';
    if (item.type === 'image' && hasMedia) {
      return <GroupVaultImage scope={mediaScope} item={item} onOpen={setViewer}
        style={{ width: W * 0.6, height: W * 0.6, borderRadius: 10 }} />;
    }
    if (item.type === 'audio' && hasMedia) {
      // Wie im 1:1-Chat: Wellenform (Balken oder Pixel-Welle), antippen springt.
      const playing = playingId === item.id;
      const total = (playing && playPos.duration) || item.durationMs || 0;
      const frac = playing && total ? Math.min(1, playPos.position / total) : 0;
      return (
        <View style={{ minWidth: W * 0.45 }}>
          <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
            <TouchableOpacity onPress={() => togglePlay(item)} accessibilityLabel={playing ? t('voice.pause') : t('voice.play')}
              style={{ width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center',
                backgroundColor: mine ? 'rgba(0,0,0,0.15)' : C.accent }}>
              <Icon name={playing ? 'pause' : 'play'} size={16} color={mine ? fg : C.onAccent} style={playing ? undefined : { marginLeft:2 }} />
            </TouchableOpacity>
            <VoiceWaveView testID={'group-voice-wave-' + item.id} levels={levelsFor(item)} progress={frac} animate={playing}
              variant={waveStyle} width={Math.max(110, Math.round(W * 0.4))} height={28}
              activeColor={mine ? fg : C.accentFg} idleColor={mine ? 'rgba(127,127,127,0.45)' : C.theirsBorder}
              onSeek={(f) => seekVoice(item, f)} accessibilityLabel={t('voice.seek')} />
          </View>
          <Text style={{ fontSize:fs - 3, color:fg, marginLeft:46, marginTop:2, fontVariant:['tabular-nums'] }}>
            {fmtDur(playing ? playPos.position : item.durationMs)}
          </Text>
        </View>
      );
    }
    return <Text style={{ fontSize:fs, color:fg, lineHeight:fs + 7 }}>{item.text}</Text>;
  };

  const hasText = !!text.trim();
  const round = { width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center' };
  const voiceColors = { surfaceAlt: palette.surfaceAlt, border: palette.border, text: palette.text, textSub: palette.textSub || palette.textMuted,
    danger: C.danger, dangerFill: C.dangerFill, onDanger: C.onDanger, accent: C.accent, onAccent: C.onAccent };

  return (
    <KeyboardAvoidingView style={{ flex:1 }} behavior="height">
      <View style={{ flex:1, backgroundColor:palette.bg }}>
        <View style={[gs.header, { backgroundColor:palette.headerBg || palette.surface, borderBottomColor:palette.headerBorder || palette.border, justifyContent:'flex-start' }]}>
          <TouchableOpacity onPress={onBack} style={{ marginRight:8, padding:4 }}>
            <Icon name={I18nManager.isRTL ? 'arrow-right' : 'arrow-left'} size={22} color={palette.headerText || palette.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenDetail} style={{ flexDirection:'row', alignItems:'center', flex:1 }}>
            <GroupAvatar group={group} size={34} accent={accent} palette={palette} onHeader />
            <View style={{ marginLeft:10, flex:1 }}>
              <Text style={{ fontSize:15, fontWeight:'500', color:palette.headerText || palette.text }} numberOfLines={1}>{group.name}</Text>
              <Text style={{ fontSize:11, color: connected ? (palette.headerOnline || palette.green) : (palette.headerMuted || palette.textMuted) }} numberOfLines={1}>{statusLine}</Text>
            </View>
          </TouchableOpacity>
          {readOnly || channel ? null : (
            <TouchableOpacity onPress={onGroupCall} style={{ padding:6 }} accessibilityLabel={t('groupChatUi.gruppenanruf')}>
              <Icon name="phone" size={20} color={palette.headerIcon || accent} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onOpenDetail} style={{ padding:6 }}>
            <Icon name="info" size={20} color={palette.headerIcon || accent} />
          </TouchableOpacity>
        </View>

        {!readOnly && runningCall ? (
          <TouchableOpacity onPress={joinCall} activeOpacity={0.8} accessibilityLabel={t('groupChatUi.gruppenanrufBeitreten')}
            style={{ padding:10, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8,
              backgroundColor:palette.surfaceAlt, borderBottomWidth:0.5, borderBottomColor:palette.border }}>
            <Icon name="phone-call" size={14} color={C.accentFg} />
            <Text style={{ fontSize:12, color:palette.text }}>{t('groupChatUi.gruppenanrufLaeuftTippenZumBeitreten')}</Text>
          </TouchableOpacity>
        ) : null}

        {group.removed ? (
          <View style={{ padding:10, backgroundColor:palette.surfaceAlt, borderBottomWidth:0.5, borderBottomColor:palette.border }}>
            <Text style={{ fontSize:12, color:palette.warning || WARN, textAlign:'center' }}>{t('groupChat.readOnly')}</Text>
          </View>
        ) : introRequests > 0 ? (
          <TouchableOpacity testID="intro-requests-banner" onPress={onOpenDetail} activeOpacity={0.8}
            style={{ padding:10, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8,
              backgroundColor:palette.surfaceAlt, borderBottomWidth:0.5, borderBottomColor:palette.border }}>
            <Icon name="user-plus" size={14} color={C.accentFg} />
            <Text style={{ fontSize:12, color:palette.text }}>{t('groups.intro.banner', { count: introRequests })}</Text>
          </TouchableOpacity>
        ) : channel ? null : unreachable.length > 0 ? (
          <TouchableOpacity onPress={onOpenDetail} activeOpacity={0.8}
            style={{ padding:10, backgroundColor:palette.surfaceAlt, borderBottomWidth:0.5, borderBottomColor:palette.border }}>
            <Text style={{ fontSize:12, color:palette.text, textAlign:'center' }}>
              {t('groupChat.notConnected', { names: unreachable.map(m => m.name).join(', ') })}
            </Text>
            <Text style={{ fontSize:11, color:palette.textMuted, textAlign:'center', marginTop:2 }}>
              {t('groupChat.noCoupling')}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Chat-Hintergrund wie im 1:1-Chat (Fehler bis 29.10.2026: eigenes
            Hintergrundbild und gewaehlte Hintergrundfarbe fehlten in Gruppen):
            eigenes Bild > Artwork-Muster des Designs > gewaehlte Farbe > Design */}
        <View style={{ flex:1 }}>
        {!!customBg && <Image testID="group-custom-bg" source={{ uri: customBg }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
        {chatArtworkVisible(palette, { customBg }) && <ChatArtwork kind={palette.artwork} fills={palette.artworkFills} glints={palette.artworkGlints} bg={palette.chatBg} />}
        <FlatList ref={listRef} data={msgs} keyExtractor={(i) => (i.from || '') + '|' + i.id}
          style={{ backgroundColor: customBg || chatArtworkVisible(palette, { customBg }) ? 'transparent' : (palette.chatBgPreset || palette.chatBg || palette.bg) }}
          contentContainerStyle={{ padding:14 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd()}
          ListEmptyComponent={
            <Text style={{ color:palette.textMuted, fontSize:13, textAlign:'center', marginTop:24 }}>
              {t('groupChat.empty')}
            </Text>
          }
          renderItem={({ item }) => {
            if (item.sys) return (
              <View style={{ alignSelf:'center', marginVertical:8, backgroundColor:palette.surface,
                paddingHorizontal:12, paddingVertical:4, borderRadius:10, maxWidth:W * 0.85 }}>
                <Text style={{ fontSize:11, color:palette.textMuted, textAlign:'center' }}>{item.text}</Text>
              </View>
            );
            if (item.mine) {
              const { delivered, total } = deliveredCount(item.recipients);
              const partial = total > 1 && item.status !== 'delivered' && item.status !== 'sending' ? `  ${delivered}/${total}` : '';
              return (
                <TouchableOpacity activeOpacity={0.9} onLongPress={() => setMenu(item)}
                  style={{ maxWidth:W*0.74, marginVertical:3, padding: item.type === 'image' ? 4 : 10, alignSelf:'flex-end',
                    backgroundColor:C.mine, borderRadius:16, borderBottomRightRadius:4 }}>
                  {body(item, true)}
                  <Text style={{ fontSize:11, marginTop:4, marginRight: item.type === 'image' ? 6 : 0, textAlign:'right', color:C.mineMeta }}>
                    {fmtTime(item.time)}{'  '}{groupStatusIcon(item.status)}{partial}
                  </Text>
                </TouchableOpacity>
              );
            }
            return (
              <TouchableOpacity activeOpacity={0.9} onLongPress={isText(item) ? () => setMenu(item) : undefined}
                style={{ maxWidth:W*0.74, marginVertical:3, padding: item.type === 'image' ? 4 : 10, alignSelf:'flex-start',
                backgroundColor:C.theirs, borderRadius:16, borderBottomLeftRadius:4,
                borderWidth:0.5, borderColor:C.theirsBorder }}>
                <Text style={{ fontSize:12, fontWeight:'600', color:senderColor(item.from, C.theirs), marginBottom:2, marginLeft: item.type === 'image' ? 6 : 0 }}>
                  {nameOf(item.from, item.fromContactId)}
                </Text>
                {body(item, false)}
                <Text style={{ fontSize:11, marginTop:4, marginRight: item.type === 'image' ? 6 : 0, textAlign:'right', color:C.theirsMeta }}>{fmtTime(item.time)}</Text>
              </TouchableOpacity>
            );
          }}
        />
        </View>

        {channelReader && !group.removed ? (
          <View testID="channel-readonly" style={{ padding:12, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8,
            backgroundColor:palette.surface, borderTopWidth:0.5, borderTopColor:palette.border }}>
            <Icon name="radio" size={14} color={palette.textMuted} />
            <Text style={{ fontSize:12, color:palette.textMuted }}>{t('channel.readOnlyBar')}</Text>
          </View>
        ) : readOnly ? null : rec.recording ? (
          <View style={{ padding:10, backgroundColor:palette.surface, borderTopWidth:0.5, borderTopColor:palette.border }}>
            <VoiceRecordingBar colors={voiceColors} secs={rec.recSecs} feed={rec.feed} waveStyle={waveStyle} testPrefix="group"
              onDiscard={rec.cancel} onPause={rec.pause} onSend={sendRecording}
              labels={{ discard: t('siegel.discardRecording'), send: t('siegelUi.sprachnachrichtSenden'),
                time: (v) => t('groupChatUi.aufnahme', { value: v }) }} />
          </View>
        ) : rec.draft ? (
          <View style={{ padding:10, backgroundColor:palette.surface, borderTopWidth:0.5, borderTopColor:palette.border }}>
            <VoiceDraftBar colors={voiceColors} draft={rec.draft} playing={rec.playing} position={rec.position} duration={rec.duration}
              waveStyle={waveStyle} canResume={rec.canResume} testPrefix="group"
              onDiscard={rec.discard} onPlay={rec.togglePreview} onSeek={rec.seekPreview} onResume={rec.resume} onSend={sendRecording}
              labels={{ discard: t('siegel.discardRecording'), send: t('siegelUi.sprachnachrichtSenden') }} />
          </View>
        ) : (
          <View style={{ flexDirection:'row', padding:10, gap:8, alignItems:'center',
            backgroundColor:palette.surface, borderTopWidth:0.5, borderTopColor:palette.border }}>
            <TouchableOpacity onPress={pickImage} accessibilityLabel={t('groupChatUi.bildSenden')}
              style={[round, { backgroundColor:palette.surfaceAlt }]}>
              <Icon name="image" size={18} color={C.accentFg} />
            </TouchableOpacity>
            <TextInput
              style={{ flex:1, backgroundColor:palette.surfaceAlt, borderRadius:20, borderWidth:0.5,
                borderColor:palette.border, paddingHorizontal:14, paddingVertical:8, fontSize:15, color:palette.text }}
              value={text} onChangeText={setText}
              placeholder={reachable.length ? t('groupChat.placeholder') : t('groupChat.placeholderNobody')}
              placeholderTextColor={palette.textMuted}
              multiline maxLength={2000} />
            {hasText ? (
              <TouchableOpacity onPress={send} activeOpacity={0.8} accessibilityLabel={t('a11y.send')}
                style={[round, { backgroundColor:C.accent }]}>
                <Icon name="send" size={18} color={C.onAccent} style={I18nManager.isRTL ? { transform:[{ scaleX:-1 }] } : null} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={startRecording} activeOpacity={0.8} accessibilityLabel={t('a11y.recordVoice')}
                style={[round, { backgroundColor:C.accent }]}>
                <Icon name="mic" size={18} color={C.onAccent} />
              </TouchableOpacity>
            )}
          </View>
        )}

        <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
          <TouchableOpacity style={{ flex:1, backgroundColor:C.overlay, justifyContent:'center', padding:32 }} activeOpacity={1} onPress={() => setMenu(null)}>
            {!!menu && (
              <View style={{ backgroundColor:C.menuBg, borderRadius:14, borderWidth:0.5, borderColor:C.menuBorder, overflow:'hidden', elevation:6 }}>
                {isText(menu) && (
                  <>
                    <Text numberOfLines={3} style={{ fontSize:13, lineHeight:18, color:C.menuText, opacity:0.8, paddingVertical:12, paddingHorizontal:16 }}>{menu.text}</Text>
                    <View style={{ height:0.5, backgroundColor:C.menuBorder }} />
                    <TouchableOpacity accessibilityRole="button" style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                      onPress={() => { const t = menu.text; setMenu(null); copyText(t); }}>
                      <Icon name="copy" size={16} color={C.menuIcon} />
                      <Text style={{ fontSize:14, color:C.menuText }}>{t('siegel.copy')}</Text>
                    </TouchableOpacity>
                  </>
                )}
                {menu.mine && (
                  <>
                    {isText(menu) && <View style={{ height:0.5, backgroundColor:C.menuBorder }} />}
                    <TouchableOpacity accessibilityRole="button" style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                      onPress={() => { const m = menu; setMenu(null); showDelivery(m); }}>
                      <Icon name="check-circle" size={16} color={C.menuIcon} />
                      <Text style={{ fontSize:14, color:C.menuText }}>{t('groupChat.delivery')}</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}
          </TouchableOpacity>
        </Modal>
        {copied && (
          <View pointerEvents="none" accessibilityLiveRegion="polite" style={{ position:'absolute', left:24, right:24, bottom:96, alignItems:'center' }}>
            <Text style={{ backgroundColor:C.menuBg, color:C.menuText, borderWidth:0.5, borderColor:C.menuBorder, borderRadius:12,
              paddingVertical:8, paddingHorizontal:14, fontSize:13, overflow:'hidden' }}>
              {t('app.kopiertWirdNach60S')}
            </Text>
          </View>
        )}

        <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setViewer(null)}
            style={{ flex:1, backgroundColor:'rgba(0,0,0,0.92)', alignItems:'center', justifyContent:'center' }}>
            {!!viewer && <Image source={{ uri: viewer }} style={{ width:'100%', height:'80%' }} resizeMode="contain" />}
          </TouchableOpacity>
        </Modal>
      </View>
    </KeyboardAvoidingView>
  );
}
