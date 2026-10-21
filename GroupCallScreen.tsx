/**
 * Malachi – GroupCallScreen.tsx
 *
 * Bildschirm fuer Gruppen-Sprachanrufe (GroupCallManager.js,
 * GROUP_CALL_DESIGN.md): Kacheln je Teilnehmer (Profilbild, Name, Zustand,
 * Sprech-Anzeige), Stumm, Lautsprecher/Hoerer (sofern das native Modul es
 * kann), Auflegen; beim Klingeln Annehmen/Ablehnen. Farben ausschliesslich aus
 * dem Design (palette = P aus App.tsx) - keine festen Farbwerte.
 *
 * useGroupCallRouting(): die einzige Verdrahtung in App.tsx - zeigt den
 * Bildschirm, sobald ein Gruppenanruf klingelt oder startet, und fuehrt danach
 * zurueck (Gruppenchat bzw. Sperre, wie beim 1:1-Anruf).
 */
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, Dimensions } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { t } from './i18n';
import {
  GroupCallState, getGroupCallSnapshot, subscribeGroupCall, setGroupCallNoticeHandler,
  acceptGroupCall, declineGroupCall, leaveGroupCall, setGroupCallMuted, setGroupCallSpeaker, ringAgain,
  isGroupCallBusy, groupCallBusyNotice,
} from './GroupCallManager';
import { MemberAvatar, DEFAULT_PALETTE } from './GroupScreens';
import { bestOn } from './Themes';

// Fuer App.tsx (ein Import statt zwei): "nur ein Anruf gleichzeitig".
export { isGroupCallBusy, groupCallBusyNotice };

const { width: W } = Dimensions.get('window');

export function useGroupCallSnapshot() {
  const [snap, setSnap] = React.useState(getGroupCallSnapshot());
  React.useEffect(() => subscribeGroupCall(setSnap), []);
  return snap;
}

// Hardware-Zurueck auf dem Anrufbildschirm: wie beim 1:1-Anruf auflegen
// (beim Klingeln: ablehnen), damit kein Anruf unsichtbar weiterlaeuft.
export function groupCallBackPress() {
  const s = getGroupCallSnapshot();
  if (s.state === GroupCallState.RINGING) declineGroupCall();
  else if (s.state !== GroupCallState.IDLE && s.state !== GroupCallState.ENDED) leaveGroupCall('user_hangup');
  return true;
}

// Navigation (App.tsx): solange ein Gruppenanruf laeuft, ist sein Bildschirm
// zu sehen (auch ueber der Sperre - danach zurueck zur Sperre, wie beim
// 1:1-Anruf). Danach zurueck in den Gruppenchat.
export function useGroupCallRouting({ screen, setScreen, nav, lockPendingRef, resumeTargetRef }) {
  const snap = useGroupCallSnapshot();
  const groupRef = React.useRef(null);
  const reasonRef = React.useRef(null);
  const prevScreenRef = React.useRef(null);
  // nav/setScreen entstehen in App.tsx bei jedem Rendern neu - immer die
  // aktuellen benutzen, ohne den Effekt bei jedem Rendern neu auszuloesen.
  const navRef = React.useRef(nav);
  navRef.current = nav;
  const setScreenRef = React.useRef(setScreen);
  setScreenRef.current = setScreen;
  React.useEffect(() => {
    setGroupCallNoticeHandler((text) => Alert.alert(t('groupChatUi.gruppenanruf'), text));
    return () => setGroupCallNoticeHandler(null);
  }, []);
  React.useEffect(() => {
    const show = setScreenRef.current;
    if (snap.state !== GroupCallState.IDLE) {
      groupRef.current = snap.groupId;
      reasonRef.current = snap.endReason;
      if (screen === 'groupCall') return;
      if (screen === 'lock' || screen === 'setup') lockPendingRef.current = true;
      else if (screen !== 'call') prevScreenRef.current = screen;
      show('groupCall');
      return;
    }
    if (screen !== 'groupCall') return;
    const prev = prevScreenRef.current;
    prevScreenRef.current = null;
    if (lockPendingRef.current) {
      lockPendingRef.current = false;
      if (!resumeTargetRef.current) resumeTargetRef.current = { screen: 'groups' };
      show('lock');
      return;
    }
    // Nur geklingelt (abgelehnt/verpasst): dorthin zurueck, wo man war.
    if ((reasonRef.current === 'declined' || reasonRef.current === 'missed') && prev) { show(prev); return; }
    if (groupRef.current) navRef.current('groupChat', { groupId: groupRef.current });
    else navRef.current('groups');
    // lockPendingRef/resumeTargetRef sind stabile Refs aus App.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.state, snap.callKey, snap.groupId, snap.endReason, screen]);
}

// Zustandstext einer Kachel.
export function participantLabel(p, callState) {
  if (p.isSelf) {
    if (callState === GroupCallState.RINGING) return 'klingelt';
    if (callState === GroupCallState.OUTGOING) return t('groupCall.wartetAufAntwort');
    if (p.muted) return 'stumm';
    return callState === GroupCallState.ACTIVE ? 'verbunden' : 'verbindet …';
  }
  switch (p.status) {
    case 'joined':
      if (p.link === 'failed') return t('groupCall.nichtErreichbar');
      if (p.link === 'connected') return p.muted ? 'stumm' : 'verbunden';
      return 'verbindet …';
    case 'invited': return t('groupCall.wirdAngerufen');
    case 'ringing': return 'klingelt …';
    case 'declined': return 'abgelehnt';
    case 'missed': return t('groupCall.nichtAngenommen');
    case 'left': return 'aufgelegt';
    case 'busy': return 'besetzt';
    case 'tor_only': return t('groupCall.nurTorNichtMoeglich');
    case 'unpaired': return t('groupCall.nichtGekoppelt');
    case 'unreachable': return t('groupCall.nichtErreichbar');
    default: return '';
  }
}

function labelColor(text, P) {
  if (text === 'verbunden') return P.online || P.accentFg;
  if (text === t('groupCall.nichtErreichbar') || text === t('groupCall.nurTorNichtMoeglich')) return P.warning || P.danger;
  if (text === 'stumm') return P.danger;
  return P.textMuted;
}

const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

export default function GroupCallScreen({ contacts, palette = DEFAULT_PALETTE, accent }) {
  const snap = useGroupCallSnapshot();
  const P = palette;
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    if (snap.state !== GroupCallState.ACTIVE) return undefined;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [snap.state]);

  if (snap.state === GroupCallState.IDLE) return <View style={{ flex:1, backgroundColor:P.bg }} />;

  const parts = [...snap.participants].sort((a, b) =>
    (b.isSelf ? 2 : b.isHost ? 1 : 0) - (a.isSelf ? 2 : a.isHost ? 1 : 0));
  const connected = parts.filter((p) => !p.isSelf && p.status === 'joined' && p.link === 'connected').length;
  const secs = snap.startedAt ? Math.max(0, Math.floor((Date.now() - snap.startedAt) / 1000)) : 0;
  const status = {
    [GroupCallState.OUTGOING]:   t('groupCall.ruftDieGruppeAn'),
    [GroupCallState.RINGING]:    t('groupCall.gruppenanrufVon', { value: snap.hostName || 'Unbekannt' }),
    [GroupCallState.CONNECTING]: 'Verbinde …',
    [GroupCallState.ACTIVE]:     fmt(secs) + '  ·  ' + connected + ' verbunden',
    [GroupCallState.ENDED]:      'Anruf beendet',
  }[snap.state] || '';
  const ringing = snap.state === GroupCallState.RINGING;
  const tileW = Math.floor((W - 32 - 12) / 2);
  const contactOf = (id) => (id ? (contacts || []).find((c) => c && c.id === id) : null) || null;
  const onSuccess = bestOn(P.success || P.accent);
  const round = { width:56, height:56, borderRadius:28, alignItems:'center', justifyContent:'center' };

  return (
    <View style={{ flex:1, backgroundColor:P.bg }}>
      <View style={{ backgroundColor:P.headerBg || P.surface, borderBottomWidth:0.5, borderBottomColor:P.headerBorder || P.border,
        paddingHorizontal:16, paddingTop:16, paddingBottom:12, flexDirection:'row', alignItems:'center', gap:10 }}>
        <Icon name="users" size={22} color={P.headerIcon || accent || P.accentFg} />
        <View style={{ flex:1 }}>
          <Text style={{ fontSize:17, fontWeight:'600', color:P.headerText || P.text }} numberOfLines={1}>{snap.groupName || t('common.group')}</Text>
          <Text style={{ fontSize:12, color:P.headerSub || P.headerMuted || P.textMuted }} numberOfLines={1}>{status}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding:16, flexDirection:'row', flexWrap:'wrap', gap:12 }}>
        {parts.map((p) => {
          const text = participantLabel(p, snap.state);
          return (
            <View key={p.mid} accessibilityLabel={(p.isSelf ? t('common.you') : p.name) + ': ' + text}
              style={{ width:tileW, backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border,
                padding:12, alignItems:'center' }}>
              <View style={{ borderWidth:3, borderRadius:40, padding:2, borderColor: p.speaking ? (P.online || P.accent) : P.surface }}>
                <MemberAvatar contact={contactOf(p.contactId)} name={p.isSelf ? 'Du' : p.name} size={56} palette={P} />
              </View>
              <View style={{ flexDirection:'row', alignItems:'center', gap:4, marginTop:8, maxWidth:'100%' }}>
                {p.muted && (p.isSelf || p.status === 'joined') ? <Icon name="mic-off" size={12} color={P.danger} /> : null}
                <Text style={{ fontSize:14, fontWeight:'500', color:P.text, flexShrink:1 }} numberOfLines={1}>{p.isSelf ? t('common.you') : p.name}</Text>
              </View>
              {p.isHost && !p.isSelf ? <Text style={{ fontSize:10, color:P.textMuted }}>{t('groupCall.gastgeber')}</Text> : null}
              <Text style={{ fontSize:12, marginTop:2, color:labelColor(text, P) }} numberOfLines={1}>{text}</Text>
              {p.canReinvite ? (
                <TouchableOpacity onPress={() => ringAgain(p.mid)} accessibilityLabel={t('groupCall.erneutAnrufen', { name: p.name })}
                  style={{ marginTop:6, paddingHorizontal:10, paddingVertical:4, borderRadius:10, backgroundColor:P.surfaceAlt }}>
                  <Text style={{ fontSize:11, color:P.accentFg }}>{t('groupCall.erneutAnrufen2')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={{ padding:20, paddingTop:12, gap:12 }}>
        <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border,
          padding:12, paddingHorizontal:16, flexDirection:'row', alignItems:'center', gap:10 }}>
          <View style={{ width:8, height:8, borderRadius:4, backgroundColor:P.online || P.accent }} />
          <View style={{ flex:1 }}>
            <Text style={{ fontSize:11, fontWeight:'500', color:P.accentFg }}>{t('call.e2e')}</Text>
            <Text style={{ fontSize:10, color:P.textMuted }}>{t('groupCall.jeTeilnehmerEineEigeneP2p')}</Text>
          </View>
        </View>

        {ringing ? (
          <View style={{ flexDirection:'row', gap:12 }}>
            <TouchableOpacity accessibilityLabel={t('app.ablehnen')} onPress={() => declineGroupCall()} activeOpacity={0.85}
              style={{ flex:1, height:56, borderRadius:20, backgroundColor:P.dangerFill, alignItems:'center', justifyContent:'center' }}>
              <Icon name="phone-off" size={22} color={P.onDanger} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityLabel={t('app.annehmen')} onPress={() => { acceptGroupCall(); }} activeOpacity={0.85}
              style={{ flex:1, height:56, borderRadius:20, backgroundColor:P.success || P.accent, alignItems:'center', justifyContent:'center' }}>
              <Icon name="phone" size={22} color={onSuccess} />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flexDirection:'row', gap:16, justifyContent:'center' }}>
            <TouchableOpacity accessibilityLabel={snap.muted ? t('app.mikrofonAn') : t('app.stummschalten')}
              onPress={() => setGroupCallMuted(!snap.muted)} activeOpacity={0.85}
              style={[round, { backgroundColor: snap.muted ? P.dangerFill : P.surfaceAlt, borderWidth:0.5,
                borderColor: snap.muted ? P.dangerFill : P.borderStrong }]}>
              <Icon name={snap.muted ? 'mic-off' : 'mic'} size={22} color={snap.muted ? P.onDanger : P.accentFg} />
            </TouchableOpacity>
            {snap.speakerSupported ? (
              <TouchableOpacity accessibilityLabel={snap.speaker ? t('groupCall.hoererStattLautsprecher') : t('groupCall.lautsprecher')}
                onPress={() => setGroupCallSpeaker(!snap.speaker)} activeOpacity={0.85}
                style={[round, { backgroundColor: snap.speaker ? P.accent : P.surfaceAlt, borderWidth:0.5,
                  borderColor: snap.speaker ? P.accent : P.borderStrong }]}>
                <Icon name={snap.speaker ? 'volume-2' : 'volume-1'} size={22} color={snap.speaker ? P.onAccent : P.accentFg} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity accessibilityLabel={t('app.auflegen')} onPress={() => leaveGroupCall('user_hangup')} activeOpacity={0.85}
              style={[round, { backgroundColor:P.dangerFill }]}>
              <Icon name="phone-off" size={22} color={P.onDanger} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}
