// react-native-get-random-values nicht kompatibel mit RN 0.73
import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Image,
  StyleSheet, Animated, Dimensions, StatusBar, Alert,
  ScrollView, Modal, Switch, BackHandler, KeyboardAvoidingView,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import QRCode from 'react-native-qrcode-svg';
import { launchImageLibrary as rawLaunchImageLibrary } from 'react-native-image-picker';

// Automatische Sperre (siehe AppInner, "Automatische Sperre"): System-Auswahl-
// dialoge (Galerie, Dateien) schicken die App ebenfalls in den Hintergrund.
// Waehrend einer solchen Auswahl gilt eine laengere Gnadenfrist, damit man
// nach laengerem Suchen nicht mitten im Senden auf dem Sperrbildschirm landet.
const AUTO_LOCK_AFTER_MS = 60 * 1000;
const AUTO_LOCK_DURING_PICKER_MS = 10 * 60 * 1000;
// Zaehler jetzt in AppFocus.js - auch SiegelScreen meldet dort seine Dialoge an.
import { withAutoLockSuspended, isAutoLockSuspended, claimAudio, releaseAudio } from './AppFocus';
const launchImageLibrary = (...args) => withAutoLockSuspended(() => rawLaunchImageLibrary(...args));
// Kein Server-Client mehr (RelayClient.js entfernt, Okt. 2026): Kopplung,
// Verbindungsaufbau und Anruf-Signale laufen ueber Tor bzw. direkt P2P.
import { padToBlock, getPortMappingStatus } from './WebRTCManager';
import { encryptMsg, secureRandomToken } from './MessageCrypto';
import CallManager, { CallState } from './CallManager';
import { isCallSpeakerSupported, onCallAudioRoute, AUDIO_ROUTE_SPEAKER } from './CallAudioRoute';
import { deriveContactId as deriveSharedContactId } from './PairingIds';
import { sanitizeWave, encodeWave, levelsFor, parseWave, createLevelFeed, effectiveWaveStyle, subscribeWaveStyle, loadWaveStyle, waveStyleSetting, setWaveStyle, resetWaveStyleAfterWipe, fallbackLevels } from './VoiceWave';
import VoiceWaveView, { LiveRecordingWave } from './VoiceWaveView';
import { VoiceDraftBar } from './VoiceDraft';
import { RTCView } from 'react-native-webrtc';
// @react-native-community/audio-toolkit ersetzt (per Live-Test entdeckt:
// nach dem RN-0.86-Upgrade landete dessen natives Modul nachweislich nie im
// fertigen Release-Build - Klassen kompilieren zwar, fehlen aber komplett in
// allen finalen .dex-Dateien, dadurch scheiterte jeder Aufnahme-Start
// lautlos). react-native-audio-recorder-player bewusst auf Version 3.6.12
// gepinnt: ab 4.1.0 verlangt das Paket react-native-nitro-modules (Neue
// Architektur) - inkompatibel mit diesem Projekt (newArchEnabled=false,
// siehe react-native-webrtc/eigene native Module, die weiterhin auf der
// alten Architektur basieren).
// Seit 2026-10-25 nur noch als Rueckfallweg in SecureAudio.js: Aufnahme und
// Wiedergabe laufen nativ im Arbeitsspeicher, ohne Klartext-Datei im Cache.
import { getVoicePlayer, appendAdtsBase64, canAppendRecording } from './SecureAudio';
const voicePlayer = getVoicePlayer();
import EncryptedStorage from 'react-native-encrypted-storage';
import RNFS from 'react-native-fs';
import * as PinVault from './PinVault';
import NetInfo from '@react-native-community/netinfo';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import Clipboard from '@react-native-clipboard/clipboard';
import { copySensitive } from './SecureClipboard';
import { Camera } from 'react-native-camera-kit';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

// AsyncStorage-kompatibler Wrapper um EncryptedStorage. Chatverlaeufe
// ('chat_<id>', 'gchat_<id>') laufen ueber den PIN-Tresor (PinVault.js):
// zusaetzlich mit dem nur nach PIN/Fingerabdruck verfuegbaren Schluessel
// verschluesselt; gesperrt wirft das Lesen (VAULT_LOCKED).
const AsyncStorage = {
  getItem: (key) => (PinVault.isVaultKey(key) ? PinVault.getItem(key) : EncryptedStorage.getItem(key)),
  setItem: (key, value) => (PinVault.isVaultKey(key) ? PinVault.setItem(key, value) : EncryptedStorage.setItem(key, value)),
  removeItem: (key) => (PinVault.isVaultKey(key) ? PinVault.removeItem(key) : EncryptedStorage.removeItem(key)),
  multiGet: async (keys) => {
    const results = await Promise.all(keys.map(async (key) => {
      const value = await AsyncStorage.getItem(key);
      return [key, value];
    }));
    return results;
  },
  multiSet: async (pairs) => {
    await Promise.all(pairs.map(([key, value]) => AsyncStorage.setItem(key, value)));
  },
  multiRemove: async (keys) => {
    await Promise.all(keys.map(key => AsyncStorage.removeItem(key)));
  },
};

// Serialisiert JEDEN Lese-Aendere-Schreibe-Zyklus auf den 'contacts'-
// Schluessel (Konkurrenz-Review §5) - Implementierung und ausfuehrliche
// Begruendung stehen seit Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3a) in
// BackgroundSync.js: es darf genau EINE Schreibkette geben, die diese UI UND
// der Headless-Task (index.js) gemeinsam benutzen - eine eigene Kette hier
// wuerde den Lost-Update-Schutz zwischen beiden Pfaden wieder aufheben.
//
// Zusaetzlich zum Default-Export von App als benannter Export verfuegbar,
// ausschliesslich damit __tests__/security/
// concurrency.contactsStorageLostUpdate.test.js den echten Mechanismus
// direkt pruefen kann statt ihn nur nachzubauen.
export async function updateContacts(mutator) {
  return sharedUpdateContacts(mutator);
}
export async function updateGroups(mutator) {
  return sharedUpdateGroups(mutator);
}

import { NativeModules, Linking, Share, AppState, PermissionsAndroid, Platform, I18nManager } from 'react-native';
const { MalachiService, MalachiNotification } = NativeModules;
import ReactNativeBiometrics from 'react-native-biometrics';
import RTCStore, { isEphemeral, timerPreview } from './RTCStore';
import { SafetyNumberDialog, useSafetyInfo, hasSafetyDisplay } from './SafetyNumberDialog';
import { persistChatHistory, mediaData, removeMedia, removeScope as removeMediaScope, wipeAllMedia } from './MediaVault';
import { loadOwnAvatar, subscribeOwnAvatar, setOwnAvatarFromPicker, removeOwnAvatar, resetOwnAvatarAfterWipe, pendingLegacyAvatarPath } from './OwnAvatar';
import {
  ensureTorRunning, getTorState, onTorState, loadTorSettings, saveTorSettings, runSelfTest, refreshOnionLookups,
  restartTor, isTorAvailable, parseCustomBridges, TOR_BRIDGE_MODES, DEFAULT_TOR_SETTINGS,
  registerPairingInvite, pairViaTor, onionFromInvite, onDescriptorReceived, descriptorReceivedSince, restartTorForPairing,
  wipeTorForReset,
} from './TorTransport';
import {
  MODE_DIRECT, MODE_TOR_ONLY, CONNECTION_MODES, getConnectionMode, loadConnectionMode,
  setConnectionMode, onConnectionModeChange, isTorOnlyMode,
  shouldShowStunRemovalNotice, markStunRemovalNoticeShown,
} from './ConnectionMode';
import {
  loadConnectionStats, getConnectionStats, onConnectionStatsChange, resetConnectionStats,
  resetConnectionStatsAfterWipe, startConnectionTimeSampler, statsAsText, statsSummary,
  setConnectionStatsWriteGuard,
} from './ConnectionStats';
import { demoteAllDirectToTor } from './DirectUpgrade';
import {
  runIncomingCycle, runOutgoingCycle, connectAllNow,
  updateContacts as sharedUpdateContacts,
  updateGroups as sharedUpdateGroups,
  wipeContactLocally as sharedWipeContactLocally,
  withQueueLock, wipeQueueForContact,
  loadPreviousSecret,
  queueOffline, requestContactDeletion, removeContactLocally, setUiContactsListener,
  sendViaOutbox, dropEphemeralFromQueue, dropQueuedContent, dropFromQueue, mergeSendStatus,
  startColdStartReconnect, sweepExpiredChats, setOwnTimer, adoptPeerTimer,
} from './BackgroundSync';
import {
  configureLicenseManager, refreshLicense, resumePendingPurchase, subscribeLicense, getLicenseState,
  isProVerified, installLicense, startPurchase, checkPurchase, dismissPurchase, canDismissPurchase,
  transferToThisDevice, acknowledgeRecoveryCode, isPurchaseOpen, isPaymentWindowOver,
  canWithdrawPurchase, withdrawPurchase,
  formatDeviceCode, formatGroups, getDeviceCode, resetLicenseStateAfterWipe, PURCHASE_POLL_MS,
  licenseErrorMessage, loadShopPaymentMethods, proStatusLabel,
  canConfigureDuressPin, isDuressPinEntry, failedPinPolicy, lockExpiredMessage, shouldNotifyContactsOnWipe,
  canSelectTorOnlyMode,
  LICENSE_STORAGE_KEY, PURCHASE_STORAGE_KEY,
} from './LicenseManager';
import { wipe as siegelWipe } from './SiegelVault';
// Zurueck-Taste: zuerst das zuletzt Geoeffnete schliessen, Dialoge mit
// "Abbrechen" per Zurueck schliessbar (BackStack.js).
import { useBackHandler, handleBack as handleBackStack, installAlertBack } from './BackStack';
import SecurityPinModal from './SecurityPinModal';
import SiegelScreen from './SiegelScreen';
import { extractMessage as extractSiegelMessage, siegelKind } from './SiegelCrypto';
import { cleanupSiegelTemp, isSiegelFileName } from './SiegelFiles';
import { paymentUri, paymentAmount, orderPaymentMethod, PAYMENT_METHODS, CONSENT_TEXT } from './ShopClient';
import { PRO_PRICE_EUR, SHOP_ONION } from './AppConfig';
// Google-Play-Variante (Distribution.js, PLAY_STORE.md): eigene Vollversion-
// Seite mit Kauf ueber Google Play - ohne Shop, Kryptowaehrung und Geraetecode.
import { isPlay, getDistribution, getVersionName } from './Distribution';
import PlayProScreen from './PlayProScreen';
// Gruppenchats (Fan-out ueber die 1:1-Kanaele, GROUP_CHAT_DESIGN.md) -
// Obergrenze GROUP_MAX_MEMBERS steht jetzt in GroupMessaging.js.
import { createGroup as createGroupShared, loadGroups, setUiGroupsListener, setGroupInviteListener, setGroupPinned, addGroupMembers, memberIdOfContact } from './GroupMessaging';
import { GroupsScreen, GroupCreateScreen, GroupDetailScreen, GroupAvatar } from './GroupScreens';
import GroupChatScreen from './GroupChatScreen';
// Gruppen-Sprachanrufe (GroupCallManager.js, GROUP_CALL_DESIGN.md).
import GroupCallScreen, { useGroupCallRouting, groupCallBackPress, isGroupCallBusy, groupCallBusyNotice } from './GroupCallScreen';
import {
  getTheme, subscribeTheme, setThemeProUnlocked, restoreThemeSelection, selectionFromSettings,
  setThemeSelection, saveSettings, chooseDesign, themedStyles, getThemeSelection, CHAT_BG_PRESETS, getLockTheme,
  statusBarFor, bestOn, ensureContrast, mix as mixColor,
} from './Themes';
import DesignSection from './DesignSection';
import { startAppIconSync } from './AppIcon';
// In-App-Updates (nur Web-Version): AppUpdater.js (Logik), UpdateUI.tsx (Oberflaeche).
import { startUpdateScheduler, isUpdaterAvailable } from './AppUpdater';
import {
  loadScreenProtection, setScreenProtection, screenProtectionSetting, subscribeScreenProtection,
  forceScreenProtection, resetScreenProtectionAfterWipe,
} from './ScreenSecurity';
import { UpdateBanner, UpdateSettingsSection } from './UpdateUI';
import Svg, { Path, Circle, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import ChatArtwork, { chatArtworkVisible } from './ChatArtwork';
import {
  t, formatTime, formatDate, formatDateTime, getLanguage, getLanguageChoice, setLanguage, subscribeLanguage, languageFromSettings,
  syncLayoutDirection, restartApp, languageName, LANGUAGES, SYSTEM_LANGUAGE,
} from './i18n';

function showNotification() {
  if (AppState.currentState === 'active') return;
  MalachiNotification?.showNotification?.();
}

// Standort-Versand (siehe sendLocation() in ChatScreen): explizit VOR jeder
// Nutzung auf das plattformeigene Android-LocationManager-API festlegen,
// nicht den "auto"-Default - der wuerde bei installierten Google Play
// Services stillschweigend auf FusedLocationProviderClient wechseln. Einmalig
// beim Laden dieses Moduls, kein wiederholter Aufruf pro Sendung noetig.
import('@react-native-community/geolocation').then(({ default: Geolocation }) => {
  Geolocation.setRNConfiguration({ skipPermissionRequests: false, locationProvider: 'android' });
}).catch(() => {});

const { width: W } = Dimensions.get('window');
// Pfeile/Chevrons zeigen bei Arabisch/Persisch (rechts nach links) in die
// Gegenrichtung. I18nManager.isRTL aendert sich nur mit einem Neustart.
const BACK_ARROW = I18nManager.isRTL ? '→' : '←';
const FORWARD_ARROW = I18nManager.isRTL ? '←' : '→';
// ‹ und › sind im Unicode "gespiegelte" Zeichen: allein in einem Text mit
// Leserichtung rechts-nach-links wuerde Android sie ohnehin umdrehen. Die
// LRM-Marken (U+200E) davor und dahinter halten das Zeichen links-nach-rechts,
// damit es genau einmal - hier - gedreht wird.
installAlertBack();

const CHEVRON = I18nManager.isRTL ? '\u200E‹\u200E' : '›';

// Farbpalette = Tokens des aktuellen Design-Themas (Themes.js). Lebendes
// Objekt: wird bei jedem Themenwechsel in place aktualisiert, alle P.xxx-
// Verweise lesen beim naechsten Rendern die neuen Farben (AppInner rendert
// dafuer neu, siehe subscribeTheme dort). Standard-Design unveraendert:
// bg '#04182F', surface '#0D2A4A', surfaceAlt '#0A2340', border '#1B3A5C',
// text '#F0F6FA', textSub '#9FB8CC', textMuted '#6E93AE', Akzent '#0A7EA4'.
// green/greenBg: fruehere Namen fuer Verbindungsstatus bzw. Akzent-Toenung.
const P: any = {};
let AC = '#0A7EA4';
function syncPalette(t) {
  // erst leeren: Schluessel, die nur manche Themen haben (chatBgLight,
  // chatBgPreset), duerfen nicht vom vorherigen Thema stehen bleiben
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, t, { green: t.online, greenBg: t.accentSoft });
  AC = t.accent;
}
syncPalette(getTheme());
subscribeTheme(syncPalette);

// ── UI-VERBESSERUNGEN (Audit 2026-09-28) ───────────────────────────────────
// Waren bis zum Release einzeln schaltbar ("Demo-Funktionen"); fuer 1.0 fest
// eingebaut: Verbindungsstatus, Online-Punkt, Willkommens-Bildschirm,
// Offline-Hinweis, Anruf-Auswahl, dunkler Chat-Hintergrund, groessere
// Tippflaechen. Ein frueher gespeicherter Schalterstand wird geloescht.
EncryptedStorage.removeItem('ui_demo_flags').catch(() => {});
function useUiDemo(_key) { return true; }
const DEMO_HIT = { top: 12, bottom: 12, left: 12, right: 12 };

// Tatsaechlicher Verbindungszustand fuer die Statusanzeigen (Demo
// "liveStatus"/"contactDots"): Netz laut NetInfo, Zustand von Tor (ohne Tor
// koennen sich die Geraete nicht finden - es gibt keinen Server mehr) und
// welche Kontakte gerade verbunden sind. Rein lesend, alle 2s aktualisiert.
function useConnectivity(contacts, enabled) {
  const [state, setState] = React.useState({ online: true, tor: getTorState().status, connected: [], viaTor: 0 });
  React.useEffect(() => {
    if (!enabled) return undefined;
    let online = true;
    const tick = () => {
      const connected = (contacts || []).filter(c => RTCStore.isConnected(c.id)).map(c => c.id);
      const viaTor = connected.filter(id => RTCStore.connections.get(id)?.transport === 'tor').length;
      const tor = getTorState().status;
      setState(prev => (prev.online === online && prev.tor === tor && prev.viaTor === viaTor &&
        prev.connected.join(',') === connected.join(',')) ? prev : { online, tor, connected, viaTor });
    };
    const unsub = NetInfo.addEventListener(s => { online = !!s.isConnected && s.isInternetReachable !== false; tick(); });
    tick();
    const t = setInterval(tick, 2000);
    return () => { clearInterval(t); unsub(); };
  }, [contacts, enabled]);
  return state;
}

// Globaler WebRTC Manager - außerhalb React
let GLOBAL_RTC = null;
// Chat-Kopfzeile: so lange nach dem letzten Kontakt "wird wiederhergestellt".
const RECONNECT_STATUS_MS = 2 * 60 * 1000;
// Audit P1: Nutzerinhalte, die als Secret-Chat-Inhalt markiert sein koennen.
const SECRET_CONTENT_TYPES = new Set(['text', 'image_complete', 'audio_complete', 'file_complete']);
// Kopplung abgeschlossen, waehrend der Einladungs-Bildschirm nicht (mehr)
// offen ist: App legt den Kontakt trotzdem an (siehe ConnectScreen).
let BACKGROUND_PAIRED = null;
// Offene eigene Einladung - bleibt gueltig, auch wenn der Bildschirm
// verlassen und wieder geoeffnet wird (derselbe QR-Code). Nur im RAM.
let OPEN_INVITE = null;
const OPEN_INVITE_REUSE_MS = 25 * 60 * 1000;

// Sichere Kontakt-ID generieren
// War vorher trotz des Namens NICHT sicher: Math.random() ist kein
// kryptographisch sicherer Zufallsgenerator. Jetzt dieselbe native,
// sichere Quelle wie in MessageCrypto.js (KyberModule.randomBytes),
// die schon für die Verschlüsselungs-Nonces verwendet wird.
async function generateContactId() {
  const { NativeModules } = require('react-native');
  const { Buffer } = require('buffer');
  try {
    const b64 = await NativeModules.KyberModule.randomBytes(24);
    const bytes = Buffer.from(b64, 'base64');
    return 'c_' + bytes.toString('hex').slice(0, 32);
  } catch (e) {
    // Sehr unwahrscheinlicher Fallback, falls das native Modul mal fehlt -
    // besser als ein Absturz, aber im Normalfall nie erreicht.
    console.error('[Security] KyberModule.randomBytes fehlgeschlagen, Fallback:', e);
    const timestamp = Date.now().toString(36);
    const random1 = Math.random().toString(36).substring(2, 15);
    const random2 = Math.random().toString(36).substring(2, 15);
    return ('c_' + timestamp + random1 + random2).substring(0, 32);
  }
}

// Lokale, verschluesselte Sende-Warteschlange pro Kontakt: queueOffline()
// steht seit der Nur-P2P-Umstellung (2026-09-29) in BackgroundSync.js, damit
// auch requestContactDeletion() dort sie benutzen kann - siehe Kommentare
// dort (secretUsed, "M1"-Sperre). Seit der Zustell-Garantie (2026-10) laeuft
// JEDER Sendeweg des ChatScreens ueber sendViaOutbox() (write-ahead: erst
// verschluesselt einreihen, dann senden, entfernen erst nach Bestaetigung).

// flushQueue() (Gegenstueck zu queueOffline() oben), isFreshTimestamp() und
// isNewerThanLastAcceptedSystemTs() (Replay-Schutz fuer Relay-Pakete) stehen
// seit Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3a) unveraendert in
// BackgroundSync.js - ihre einzigen Aufrufer waren die dorthin ausgelagerten
// Auto-Reconnect-/Empfangs-Zyklen (runOutgoingCycle/runIncomingCycle).
// Dort auch: flushQueue()'s "M1"-Sperre (withQueueLock, gemeinsam mit
// queueOffline() oben), der "H1"-Zeitstempel-Neustempel beim Flush und die
// synthetischen 'sent'-Receipts nach jedem erfolgreich gesendeten Item.

// Rechnet einen Self-Destruct-Timer-Modus ('read'/'1h'/'24h'/'7d'/'off') in
// den konkreten Ablaufzeitpunkt um. War zuvor an drei Stellen in ChatScreen
// (gepufferte Nachrichten, Live-Empfang, eigenes Senden) identisch dupliziert -
// hier zusammengefasst, keine Verhaltensaenderung (Simplification-Pass).
// Entfernt beim App-Start entschluesselte Klartext-Kopien, die fuers Teilen/
// Oeffnen einer empfangenen Datei im Cache abgelegt wurden (siehe openFile im
// ChatScreen) - die Ziel-App hatte seitdem genug Zeit, sie zu lesen. Alte
// Dateien ohne Praefix (vor dem Fix: "<13-stellige Zeit>_<Name>") mit.
// Audit P12/G9: ebenso Klartext-Reste einer abgebrochenen Sitzung - Wiedergabe
// (play_*, malachi_grp_play_*), Aufnahme (malachi_*, malachi_grp_rec_*) und
// Kopien des Bild-Auswahldialogs (rn_image_picker_lib_temp_*), sobald sie
// nicht mehr in Benutzung sein koennen.
const PLAINTEXT_TEMP_RE = /^(play_|malachi_|rn_image_picker_lib_temp_)/;
async function cleanupSharedFileCache() {
  // Zuerst ein altes Profilbild uebernehmen (OwnAvatar.js): frueher stand
  // dort der Pfad einer Cache-Kopie der Bildauswahl - genau die Dateien, die
  // dieser Durchlauf loescht.
  await loadOwnAvatar().catch(() => {});
  const keepAvatar = await pendingLegacyAvatarPath().catch(() => null);
  try {
    const files = await RNFS.readDir(RNFS.CachesDirectoryPath);
    const now = Date.now();
    for (const f of files) {
      if (!f.isFile()) continue;
      if (keepAvatar && f.path === keepAvatar) continue;   // Uebernahme scheiterte - nicht verlieren
      const isShareCopy = f.name.startsWith('malachi_share_') || /^\d{13}_/.test(f.name);
      const isPlainTemp = !isShareCopy && PLAINTEXT_TEMP_RE.test(f.name);
      if (!isShareCopy && !isPlainTemp) continue;
      const mtime = f.mtime ? new Date(f.mtime).getTime() : 0;
      const minAgeMs = isShareCopy ? 10 * 60 * 1000 : 2 * 60 * 1000;
      if (mtime < now - minAgeMs) await RNFS.unlink(f.path).catch(() => {});
    }
  } catch {}
}

function expireModeToExpireAt(mode) {
  return mode === 'read' ? 'read'
    : mode === '1h'  ? Date.now() + 3600000
    : mode === '24h' ? Date.now() + 86400000
    : mode === '7d'  ? Date.now() + 604800000
    : null;
}
const CONTACTS = [];

// Initialen aus einem Namen ("Kev Meyer" -> "KM", "dave" -> "D").
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const s = parts.slice(0, 2).map(w => Array.from(w)[0] || '').join('').toUpperCase();
  return s || '?';
}

// Profilbild bzw. Platzhalter mit Initialen. Farben kommen aus dem Design
// (P.avatarBg/avatarText, in der Kopfleiste P.headerAvatar*) - frueher fest
// pro Kontakt gespeichert (c.color/c.tc, Nachtblau/Tuerkis), das passte zu
// keinem anderen Design. Initialen aus dem aktuellen Namen (c.initials blieb
// nach dem Umbenennen oft "N" von "Neuer Kontakt").
function Avatar({ c, size=40, onHeader=false }) {
  if (c.theirAvatar) {
    return (
      <Image source={{ uri: c.theirAvatar }}
        style={{ width:size, height:size, borderRadius:size/2, backgroundColor: onHeader ? P.headerAvatarBg : P.avatarBg }}
        resizeMode="cover" />
    );
  }
  return (
    <View style={{ width:size, height:size, borderRadius:size/2,
      backgroundColor: onHeader ? P.headerAvatarBg : P.avatarBg, alignItems:'center', justifyContent:'center' }}>
      <Text style={{ fontSize:size*0.38, fontWeight:'600', color: onHeader ? P.headerAvatarText : P.avatarText }}>{initialsOf(c.name) !== '?' ? initialsOf(c.name) : (c.initials || '?')}</Text>
    </View>
  );
}

// Audit G1: Bild aus dem Verlauf - Inhalt im RAM (frisch empfangen/gesendet)
// oder aus der verschluesselten Ablage (MediaVault.js), erst beim Anzeigen
// geladen statt beim Oeffnen des Chats fuer alle Bilder.
function VaultImage({ scope, item, style, resizeMode = 'cover' }) {
  const inline = typeof item?.base64 === 'string' ? item.base64 : null;
  const [loaded, setLoaded] = useState(null);
  const [failed, setFailed] = useState(false);
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
  const uri = inline || loaded;
  if (uri) return <Image source={{ uri }} style={style} resizeMode={resizeMode} />;
  return (
    <View style={[style, { alignItems:'center', justifyContent:'center', backgroundColor:'rgba(127,127,127,0.15)' }]}>
      <Icon name={failed ? 'image' : 'loader'} size={22} color="#888" />
    </View>
  );
}

function AppInner() {
  const insets = useSafeAreaInsets();
  // Globale Notification-Funktion für RTCStore
  global.showMalachiNotification = showNotification;
  global.incrementBadge = (chatId, preview) => {
    const time = formatTime();
    const bump = x => x.id === chatId
      ? { ...x, unread: (x.unread || 0) + 1, lastTs: Date.now(), ...(preview ? { last: preview.length > 200 ? preview.slice(0, 200) + '…' : preview, time } : {}) }
      : x;
    setContacts(c => c.map(bump));
    // Ueber updateContacts serialisiert (Rot-Team-Review Fund 1 - diese
    // Stelle schrieb bisher direkt aus dem React-State heraus, ohne die
    // Konkurrenz-Review-Serialisierung zu durchlaufen).
    updateContacts(cs => cs.map(bump)).catch(() => {});
  };
  const [screen,   setScreen]   = useState('setup');
  const [username, setUsername] = useState('');
  const [chat,     setChat]     = useState(null);
  const [contacts, setContacts] = useState(CONTACTS);
  // Immer der aktuelle Stand (fuer Rueckrufe, die laenger laufen als ein
  // Render - z.B. die Kopplung ueber Tor, siehe onConnected unten).
  const contactsRef = useRef(contacts);
  contactsRef.current = contacts;
  const [groups,   setGroups]   = useState([]);
  // Gruppenchats: Aenderungen (auch eingehende, aus dem Hintergrund) spiegelt
  // GroupMessaging ueber setUiGroupsListener in diesen State - die offene
  // Gruppe wird deshalb nur per ID gemerkt und immer frisch nachgeschlagen.
  const [activeGroupId, setActiveGroupId] = useState(null);
  const activeGroup = groups.find(g => g.groupId === activeGroupId) || null;
  const groupsUnread = groups.reduce((n, g) => n + (g.unread || 0), 0);

  // "Neuen Kontakt koppeln" aus der Gruppe heraus (Nutzerwunsch 2026-10-19):
  // { groupId } = danach in diese Gruppe aufnehmen, { create: true } = danach
  // zurueck zu "Neue Gruppe" mit dem Kontakt vorausgewaehlt.
  const pendingGroupAddRef = useRef(null);
  const [createPreselect, setCreatePreselect] = useState(null);
  // Frisch gekoppelte Kontakte (nur im Arbeitsspeicher): kommt von einem davon
  // kurz danach eine Gruppen-Einladung, oeffnet sich der Gruppenchat.
  const recentlyPairedRef = useRef(new Map());
  const createGroup = async (input) => {
    const res = await createGroupShared(input).catch(() => ({ error: 'failed' }));
    if (res?.group) { setCreatePreselect(null); nav('groupChat', res.group); }
    return res;
  };
  const togglePinContact = (id, pinned) => {
    setContacts(c => c.map(x => (x.id === id ? { ...x, pinned: !!pinned } : x)));
    updateContacts(cs => cs.map(x => (x.id === id ? { ...x, pinned: !!pinned } : x))).catch(() => {});
  };
  const [bgColor,     setBgColor]     = useState('#FAFAF8');
  const [fontSize,    setFontSize]    = useState(14);
  const [customBgUri, setCustomBgUri] = useState(null);
  const [avatar, setAvatar]           = useState(null);
  const [deepLinkToken, setDeepLinkToken] = useState(null);
  const [callState, setCallState] = useState(CallState.IDLE);
  const [remoteStream, setRemoteStream] = useState(null);
  const [videoOn, setVideoOn] = useState(false);
  const [remoteVideoOn, setRemoteVideoOn] = useState(false);
  const callManagerRef = useRef(null);
  // Siehe "Automatische Sperre" weiter unten - hier schon deklariert, weil die
  // Anruf-Callbacks direkt darunter sie benutzen.
  const afterCallNavRef = useRef((contact) => nav('chat', contact));
  const lockPendingRef = useRef(false);

  // Neuen ausgehenden Anruf starten - vorher landete man beim Tippen auf den
  // Anruf-Button nur auf einem Fake-CallScreen ohne jede echte Signalisierung.
  const startOutgoingCall = (contact, video = false, torChecked = false) => {
    if (!contact || callManagerRef.current) return;
    // Gruppenanruf laeuft: nur ein Anruf gleichzeitig.
    if (isGroupCallBusy()) { Alert.alert(t('call.title'), groupCallBusyNotice()); return; }
    // Verbindungsweg "Maximal anonym (nur Tor)": kein Video (bräuchte eine
    // direkte Verbindung) - klar ablehnen, Sprachanruf anbieten. CallManager
    // lehnt einen Videoanruf in diesem Modus zusaetzlich selbst ab.
    if (video && isTorOnlyMode()) {
      Alert.alert(
        t('call.noVideoTorOnly.title'),
        t('call.noVideoTorOnly.body'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('call.startAsVoice'), onPress: () => startOutgoingCall(contact, false, true) },
        ]
      );
      return;
    }
    // Videoanruf aus einer laufenden Tor-Sitzung: vorher aufklaeren statt
    // einen Anruf zu starten, der als Video ohnehin nicht klappt.
    if (video && !torChecked && RTCStore.isConnected(contact.id)
        && RTCStore.connections.get(contact.id)?.transport === 'tor') {
      Alert.alert(
        t('call.videoViaTor.title'),
        t('call.videoViaTor.body', { name: contact.name }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('call.startAsVoice'), onPress: () => startOutgoingCall(contact, false, true) },
        ]
      );
      return;
    }
    const cm = new CallManager({
      contactId: contact.id,
      peerName: contact.name,
      theirMyId: contact.theirMyId || null,
      video,
      onStateChange: (s) => {
        setCallState(s);
        if (s === CallState.IDLE) {
          callManagerRef.current = null;
          setRemoteStream(null);
          setVideoOn(false);
          setRemoteVideoOn(false);
          afterCallNavRef.current(contact);
        }
      },
      onMissedCall: () => {},
      onRemoteStream: (stream) => setRemoteStream(stream),
      onVideoStateChange: (own, remote) => { setVideoOn(own); setRemoteVideoOn(remote); },
      onNotice: (text) => Alert.alert(t('call.title'), text),
    });
    callManagerRef.current = cm;
    setChat(contact);
    setCallState(cm.state);
    setVideoOn(video);
    setRemoteVideoOn(video);
    setScreen('call');
    cm.startCall();
  };

  // Eingehende Anrufe erkennen: Angebote kommen ueber die Verbindung zum
  // Kontakt (RTCStore.callSignalHandler) bzw. liegen gepuffert bereit, wenn sie
  // ankamen, waehrend die App nicht lief.
  React.useEffect(() => {
    const handleIncomingOffer = async (contact, signals) => {
      if (callManagerRef.current) return; // schon in einem Anruf
      const offerSignal = signals.find(s => s.type === 'offer');
      if (!offerSignal) return;
      console.log('[Call] Eingehender Anruf von:', contact.name);
      const cm = new CallManager({
        contactId: contact.id,
        peerName: contact.name,
        onStateChange: (s) => {
          setCallState(s);
          if (s === CallState.IDLE) {
            callManagerRef.current = null;
            setRemoteStream(null);
            setVideoOn(false);
            setRemoteVideoOn(false);
            afterCallNavRef.current(contact);
          }
        },
        onMissedCall: () => {},
        onRemoteStream: (stream) => setRemoteStream(stream),
        onVideoStateChange: (own, remote) => { setVideoOn(own); setRemoteVideoOn(remote); },
        onNotice: (text) => Alert.alert(t('call.title'), text),
      });
      callManagerRef.current = cm;
      // Anruf kommt auf dem Sperrbildschirm (oder vor der Ersteinrichtung)
      // an: annehmen geht ohne PIN (wie beim Telefon), danach aber zurueck
      // zur Sperre statt ungesperrt in den Chat (Audit 2026-09-28).
      if (screenRef.current === 'lock') lockPendingRef.current = true;
      setChat(contact);
      setScreen('call');
      await cm.handleSignal(offerSignal);
      setCallState(cm.state);
      // handleIncomingOffer() (innerhalb handleSignal fuer 'offer') setzt
      // cm.video/cm.remoteVideo aus dem Offer-Flag - hier erst danach lesbar.
      setVideoOn(cm.video);
      setRemoteVideoOn(cm.remoteVideo);
      for (const s of signals) {
        if (s !== offerSignal) await cm.handleSignal(s);
      }
    };
    // Anruf-Signale kommen ausschliesslich ueber die bestehende Verbindung zum
    // Kontakt (CallManager._sendSignal, es gibt keinen Server mehr):
    // laufender Anruf -> dorthin, neues Angebot -> klingeln lassen.
    const callSignalHandler = async (chatId, signal) => {
      const cm = callManagerRef.current;
      if (cm) {
        if (cm.contactId === chatId) await cm.handleSignal(signal);
        return;
      }
      if (signal.type !== 'offer') return;
      try {
        const saved = await AsyncStorage.getItem('contacts');
        const contact = (saved ? JSON.parse(saved) : []).find(c => c.id === chatId && !c.pendingDelete);
        if (!contact) return;
        await handleIncomingOffer(contact, [signal]);
      } catch (e) { console.warn('[Call] Kanal-Angebot nicht verarbeitbar:', e?.message || e); }
    };
    RTCStore.callSignalHandler = callSignalHandler;
    // Ein Angebot, das ankam, waehrend App() nicht bereit war (Hintergrund/
    // headless - dann hat index.js bereits nativ klingeln lassen), liegt in
    // RTCStore gepuffert. Beim Start abholen, sonst wuerde das native
    // "Annehmen" (MalachiConnection.onAnswer -> startet MainActivity neu) den
    // Anruf nie tatsaechlich verbinden. Zu alte Angebote (Anrufer hat laengst
    // aufgegeben) nicht mehr klingeln lassen.
    const BUFFERED_CALL_MAX_AGE_MS = 60000;
    let draining = false;
    const drainBufferedCalls = async () => {
      if (callManagerRef.current || draining) return;
      draining = true;
      try {
        for (const [chatId, entry] of RTCStore.takeAllBufferedCallSignals()) {
          if (callManagerRef.current) break;
          if (entry.at && Date.now() - entry.at > BUFFERED_CALL_MAX_AGE_MS) continue;
          let contact = null;
          try {
            const saved = await AsyncStorage.getItem('contacts');
            contact = (saved ? JSON.parse(saved) : []).find(c => c.id === chatId && !c.pendingDelete) || null;
          } catch {}
          if (!contact) continue;
          await handleIncomingOffer(contact, entry.signals);
        }
      } catch (e) {
        console.warn('[Call] Gepuffertes Angebot nicht verarbeitbar:', e?.message || e);
      } finally {
        draining = false;
      }
    };
    // Sofort beim Mount - genau der Fall, wenn MainActivity gerade durch
    // MalachiConnection.onAnswer() gestartet wurde. Danach nur noch als
    // Absicherung (rein lokal, kein Netzzugriff).
    drainBufferedCalls();
    const interval = setInterval(drainBufferedCalls, 2000);
    return () => {
      clearInterval(interval);
      if (RTCStore.callSignalHandler === callSignalHandler) RTCStore.callSignalHandler = null;
    };
  }, []);

  // Eigenes Profilbild (OwnAvatar.js): verschluesselt abgelegt, Altbestand
  // wird uebernommen; Aenderungen aus den Einstellungen kommen per Abo.
  React.useEffect(() => {
    loadOwnAvatar().then(setAvatar).catch(() => {});
    return subscribeOwnAvatar(setAvatar);
  }, []);

  // Settings laden
  // Design (Themes.js): Thema, Akzentfarbe, Einfaerben, Chat-Hintergrund.
  // bgColor setzte frueher P.bg fuer die GANZE App (helle Flaeche unter heller
  // Schrift) - gilt jetzt nur noch fuer den Chatverlauf (chatBgPreset).
  React.useEffect(() => {
    AsyncStorage.getItem('settings').then(saved => {
      if (saved) {
        try {
          const s = JSON.parse(saved);
          restoreThemeSelection(selectionFromSettings(s));
          setLanguage(languageFromSettings(s));
          if (s.bgColor)     setBgColor(s.bgColor);
          if (s.fontSize)      setFontSize(s.fontSize);
        } catch {}
      }
      // Leserichtung (Arabisch/Persisch) fuer den naechsten Start festlegen -
      // ohne automatischen Neustart (siehe i18n.syncLayoutDirection).
      syncLayoutDirection();
    });
  }, []);
  // Themenwechsel (Einstellungen, Lizenz) -> neu rendern; P/AC sind dann schon
  // aktualisiert (syncPalette). Pro-Themen nur mit gueltiger Lizenz.
  const [, setThemeTick] = useState(0);
  React.useEffect(() => subscribeTheme(() => setThemeTick(x => x + 1)), []);
  // Sprachwechsel (Einstellungen -> Sprache) -> ebenso neu rendern; alle
  // Texte kommen beim Rendern aus t() (i18n.js).
  React.useEffect(() => subscribeLanguage(() => setThemeTick(x => x + 1)), []);
  React.useEffect(() => subscribeLicense(l => setThemeProUnlocked(l.pro === true)), []);
  // "App-Icon passend zum Design" (AppIcon.js): wechselt beim Verlassen der App
  // (nicht waehrend eines Anrufs)
  React.useEffect(() => startAppIconSync({
    licenseLoaded: () => getLicenseState().loaded === true,
    busy: () => callManagerRef.current != null,
  }), []);

  // Deep Link Handler
  React.useEffect(() => {
    // App war geschlossen → via Link geöffnet
    Linking.getInitialURL().then(url => {
      if (url) handleDeepLink(url);
    });
    // App war offen → Link empfangen
    const sub = Linking.addEventListener('url', ({ url }) => handleDeepLink(url));
    return () => sub.remove();
  }, []);

  const handleDeepLink = (url) => {
    try {
      // malachi://connect/SC1-0A0B-0C0D
      if (!url.startsWith('malachi://connect/')) return;
      const token = url.replace('malachi://connect/', '').trim();
      if (!token) return;
      console.log('[DeepLink] Token empfangen:', token);
      // Direkt zum ConnectScreen mit vorausgefülltem Token
      setDeepLinkToken(token);
      nav('connect');
    } catch(e) {
      console.warn('[DeepLink] Fehler:', e);
    }
  };

  // Frueher: periodischer Relay-Chunk-Upload fuer Bild/Audio, die laenger als
  // ein paar Sekunden offline in der lokalen Warteschlange standen (alle 10
  // Minuten, via sendEncryptedImageOffline/sendEncryptedAudioOffline →
  // /transfer/*-Endpunkte auf dem Relay). Genau der Nachrichteninhalts-Leak
  // zum Server, den Text schon nicht mehr hat (siehe queueOffline()/
  // flushQueue() oben) - Bild/Audio landen jetzt beim Senden direkt in
  // derselben lokalen Warteschlange (pickAndSendImage/sendAudioPreview) und
  // werden ausschliesslich von flushQueue() bei der naechsten echten P2P-
  // Verbindung zugestellt, nie mehr ueber den Relay. Dieser komplette Effekt
  // ist dadurch ueberfluessig geworden.

  // Vollversion: Lizenz beim Start pruefen (LicenseManager.js - Signatur,
  // Geraetebindung, Feature "pro"; offline). Eine noch offene Bestellung wird
  // danach einmal ueber Tor abgefragt, damit eine inzwischen bezahlte Lizenz
  // auch ohne Oeffnen der Vollversion-Seite ankommt.
  React.useEffect(() => {
    configureLicenseManager({ ensureTor: ensureTorRunning });
    refreshLicense().then(() => resumePendingPurchase()).catch(() => {});
    // Bildschirmschutz (ScreenSecurity.js): Standard an; "aus" nur mit Vollversion.
    loadScreenProtection().catch(() => {});
    loadWaveStyle().catch(() => {});   // Sprachnachrichten-Stil (VoiceWave.js)
    // Verbindungs-Diagnose (ConnectionStats.js, nur lokale Zaehler): laden und
    // je Minute den Zeitanteil direkt/Tor zaehlen (ohne Zuordnung).
    loadConnectionStats().catch(() => {});
    // Waehrend eines Anrufs nichts speichern (Anrufe hinterlassen keine Spuren).
    setConnectionStatsWriteGuard(() => !!RTCStore.activeCallContactId || isGroupCallBusy());
    startConnectionTimeSampler(() => RTCStore.connections);
  }, []);

  // In-App-Updates der Web-Version (AppUpdater.js): prueft ueber Tor
  // hoechstens einmal je 24 h (+ Zufall), nur bei laufendem Tor; Laden und
  // Installieren nur auf Nutzerwunsch. In der Play-Version ohne Wirkung.
  React.useEffect(() => startUpdateScheduler({
    isTorUp: () => getTorState().status === 'ON',
    onTorState,
  }), []);

  // Setup check beim Start
  React.useEffect(() => {
    AsyncStorage.getItem('setup_done').then(async done => {
      if (done === 'true') {
        AsyncStorage.getItem('username').then(u => { if (u) setUsername(u); });
        setScreen('lock');
        // Ab Android 13 (API 33) ist POST_NOTIFICATIONS eine Laufzeit-
        // Permission - nur im Manifest deklariert bleiben sowohl die
        // Foreground-Service-Notification als auch MalachiNotification.
        // showNotification() fuer den Nutzer unsichtbar. Bewusst VOR dem
        // Service-Start angefragt, damit dessen Notification schon mit
        // erteilter Permission gepostet wird. Bei Ablehnung trotzdem
        // weiterstarten (anders als bei Mikrofon/Kamera): der Service haelt
        // den Prozess auch ohne sichtbare Notification am Leben.
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          try {
            const granted = await PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
              { title: t('perm.notifications.title'), message: t('perm.notifications.message'), buttonPositive: 'OK' }
            );
            if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
              console.warn('[Notification] Benachrichtigungs-Permission verweigert');
            }
          } catch(e) {
            console.error('[Notification] Permission-Anfrage fehlgeschlagen:', e);
          }
        }
        MalachiService?.start();
        // Tor (siehe TorTransport.js) ist der einzige Weg, Kontakte zu finden -
        // es gibt keinen Server mehr. Laeuft im Hintergrund.
        ensureTorRunning();
        cleanupSharedFileCache();
        // Siegel-Reste (Wiedergabe/Aufnahme/Teilen) einer abgebrochenen Sitzung.
        cleanupSiegelTemp();
        // Live-Test 2026-09-27: Wegwischen der Dienst-Benachrichtigung (oder ein
        // Systemabbruch, den onTaskRemoved() nicht ueberleben konnte) beendete
        // den P2P-Empfang bisher lautlos - weder Popup noch Hinweis. Einmalig
        // beim naechsten Start nachfragen und dem Nutzer sagen, seit wann er
        // nicht mehr erreichbar war.
        MalachiService?.consumeUnexpectedStopTimestamp?.().then((ts: number | null) => {
          if (!ts) return;
          const since = formatDateTime(ts);
          Alert.alert(
            t('service.stopped.title'),
            t('service.stopped.body', { since }),
          );
        }).catch(() => {});
      }
    }).catch((e) => {
      // Audit 2026-10-19 (A1): Der verschluesselte Speicher faellt nie mehr
      // still auf Klartext zurueck - ist er nicht verfuegbar (defekter
      // Keystore, umgezogene Daten), klar sagen, statt die Einrichtung
      // scheitern zu lassen.
      if (/initialize SharedPreferences/i.test(String(e?.message || e))) {
        Alert.alert(t('app.sichererSpeicherNichtVerfuegbar'),
          t('app.derVerschluesselteSpeicherDesGeraets'));
      }
    });
    AsyncStorage.getItem('settings').then(saved => {
      if (saved) { try { const s = JSON.parse(saved); if (s.customBgUri) setCustomBgUri(s.customBgUri); } catch {} }
    });
  }, []);

  // Kontakte laden
  React.useEffect(() => {
    AsyncStorage.getItem('contacts').then(saved => {
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const real = parsed.filter(c => !['1','2','3'].includes(c.id));
          // pendingDelete: vom Nutzer geloescht, Loesch-Hinweis wartet noch
          // auf P2P-Zustellung (requestContactDeletion) - nicht mehr anzeigen,
          // Secret aber weiter laden (wird fuer die Zustellung gebraucht).
          setContacts(real.filter(c => !c.pendingDelete));
          // Shared Secrets aus der letzten Sitzung zurueck in RTCStore laden -
          // sonst ist RTCStore.sharedSecrets nach jedem App-Start leer, bis ein
          // frischer P2P-Reconnect den Schluesseltausch wiederholt hat. In der
          // Zwischenzeit wuerden via Relay wartende Nachrichten zwar als
          // (weiterhin verschlüsseltes) Rohpaket gepuffert (siehe checkIncoming
          // oben), aber mangels Secret nie sauber entschluesselt/angezeigt.
          real.forEach(c => {
            EncryptedStorage.getItem('shared_secret_' + c.id).then(secret => {
              if (secret) RTCStore.sharedSecrets.set(c.id, secret);
            }).catch(() => {});
            // Audit 2026-09-28: unbestaetigtes vorheriges Secret als
            // Rueckfall-Kandidat (siehe RTCStore.rememberPreviousSecret).
            loadPreviousSecret(c.id).catch(() => {});
          });
        } catch {}
      }
    });
  }, []);

  // Gruppen laden (Gruppenchats Phase 0) - analog zum Kontakte-Laden oben,
  // aber ohne Shared-Secret-Wiederherstellung: die brauchen weiterhin nur
  // die einzelnen paarweisen 1:1-Verbindungen zu den Mitgliedern (siehe
  // GROUP_CHAT_CRYPTO_PLAN.md §1, Option A), keine eigene Gruppen-Krypto.
  React.useEffect(() => {
    setUiGroupsListener(setGroups);
    loadGroups().then(list => { if (Array.isArray(list)) setGroups(list); }).catch(() => {});
    return () => setUiGroupsListener(null);
  }, []);
  // Koppeln und gleich in die Gruppe: die Einladung des Gegenuebers kommt
  // Sekunden nach der Kopplung - dann direkt in den Gruppenchat (nur im
  // Vordergrund und nicht mitten in Anruf/Einstellungen).
  const navRef = useRef(null);   // screenRef: siehe Automatische Sperre weiter unten
  React.useEffect(() => {
    setGroupInviteListener((groupId, contactId) => {
      const t = recentlyPairedRef.current.get(contactId);
      if (!t || Date.now() - t > 10 * 60 * 1000) return;
      recentlyPairedRef.current.delete(contactId);
      if (AppState.currentState !== 'active') return;
      if (!['home', 'chat', 'connect', 'groups'].includes(screenRef.current)) return;
      navRef.current?.('groupChat', { groupId });
    });
    return () => setGroupInviteListener(null);
  }, []);

  // Verbindungszyklus (Tor zuerst, dann direkt - siehe BackgroundSync.js
  // runOutgoingCycle/DirectUpgrade.js). Derselbe Code laeuft auch im
  // Headless-Task, wenn diese Komponente nicht gemountet ist; Zyklus-Sperre
  // und Versuchszustand leben dort modulweit. Hier nur die Verdrahtung: Timer
  // und NetInfo. Durchgehend aktiv, unabhaengig vom aktuellen Screen.
  // Netzwechsel selbst (Tor-Neustart, ICE-Neustart der Direktverbindungen,
  // sofortiger Tor-Neuaufbau) erkennt TorTransport.handleNetworkChange.
  React.useEffect(() => {
    const checkOutgoing = () => {
      runOutgoingCycle({
        onContactsChanged: setContacts,
        onRtcConnected: (_contactId, rtc) => { GLOBAL_RTC = rtc; },
      });
    };
    startColdStartReconnect();
    const initialDelay = setTimeout(checkOutgoing, 2000);
    const interval = setInterval(checkOutgoing, 8000);
    // Netz nach einem Ausfall wieder da: sofort pruefen statt auf den
    // naechsten Tick zu warten (kurzer Vorlauf fuer Routing/DNS).
    let wasReachable = true;
    const unsubNet = NetInfo.addEventListener(state => {
      const isUp = !!state.isConnected && state.isInternetReachable !== false;
      if (isUp && !wasReachable) {
        console.log('[Verbindung] Netzwerk wieder da (NetInfo) - pruefe sofort statt auf den naechsten Zyklus zu warten');
        setTimeout(() => checkOutgoing(), 1500);
      }
      wasReachable = isUp;
    });
    return () => { clearTimeout(initialDelay); clearInterval(interval); unsubNet(); };
  }, []);

  // Damit requestContactDeletion()/removeContactLocally()/Steuersignale aus
  // BackgroundSync.js die sichtbare Kontaktliste sofort mitfuehren.
  React.useEffect(() => {
    setUiContactsListener(setContacts);
    return () => setUiContactsListener(null);
  }, []);

  React.useEffect(() => {
    const t = setInterval(() => {
      const st = getTorState().status;
      if (st === 'ERROR' || st === 'OFF') ensureTorRunning();
    }, 120000);
    return () => clearInterval(t);
  }, []);

  // "Jetzt verbinden" (UI-Demo offlineBanner im Chat): alle Wartezeiten
  // aufheben und sofort verbinden (Tor, danach direkt).
  React.useEffect(() => {
    global.malachiReconnectNow = () => {
      connectAllNow({ onContactsChanged: setContacts, onRtcConnected: (_id, rtc) => { GLOBAL_RTC = rtc; } });
    };
    return () => { delete global.malachiReconnectNow; };
  }, []);

  // Wartungszyklus (BackgroundSync.js runIncomingCycle): nur noch lokale
  // Aufraeumarbeiten - es gibt keinen Server mehr, von dem etwas abzuholen waere.
  React.useEffect(() => {
    const checkIncoming = () => runIncomingCycle({
      onContactsChanged: setContacts,
      onRtcConnected: (_contactId, rtc) => { GLOBAL_RTC = rtc; },
    });
    checkIncoming();
    const interval = setInterval(checkIncoming, 60000);
    return () => { clearInterval(interval); };
  }, []);

  // Rot-Team-Review Fund 1: der vorherige pauschale "bei jeder contacts-
  // Aenderung neu speichern"-Effekt schrieb DIREKT aus dem (moeglicherweise
  // veralteten) React-State heraus, ohne jede Serialisierung - und lief
  // damit der eigentlichen Race-Fix-Absicht zuwider, da er bei JEDER
  // setContacts()-Aenderung (auch bei denen, die bereits ueber
  // updateContacts() korrekt serialisiert persistiert wurden) einen
  // zusaetzlichen, konkurrierenden Rohschreibvorgang ausloeste. Jetzt, wo
  // jede tatsaechliche Kontakt-Aenderung an ihrer eigenen Stelle explizit
  // ueber updateContacts() serialisiert persistiert (siehe die Aufrufe
  // weiter oben/unten in dieser Datei), ist dieser pauschale Effekt
  // ueberfluessig geworden - entfernt statt als zusaetzliche, race-
  // eroeffnende Sicherheitsnetz-Kopie stehen gelassen zu werden.
  const globalRTC               = useRef(null);
  // Ref-Weiche fuer die Hardware-Zurueck-Taste (siehe onHardwareBack weiter
  // unten): AppInner navigiert bei Zurueck auf dem Chat-Screen bisher IMMER
  // direkt zu 'home', unabhaengig vom secretActive-Status - der lebt nur als
  // lokaler React-State in ChatScreen, AppInner kennt ihn nicht. Ohne diese
  // Weiche umging die Hardware-/Geste-Zurueck-Navigation den Bestaetigungs-
  // +Aufraeum-Pfad des sichtbaren Zurueck-Pfeils komplett (Nutzer-Fund).
  // ChatScreen setzt/leert diese Ref je nach secretActive; ist sie gesetzt,
  // ruft der Handler sie statt direkt zu navigieren.
  const chatBackInterceptRef    = useRef(null);
  // Gemeinsame Tombstone-Logik fuer einen empfangenen device_wiped-Hinweis
  // (Rot-Team-Review Fund 2, ChatScreen onWipe). Storage-/Secret-/RTCStore-
  // Teil und ausfuehrliche Begruendung stehen seit Stufe 2 in
  // BackgroundSync.js (wipeContactLocally), damit ein vom Headless-Task
  // empfangenes device_wiped exakt gleich vollstaendig abgearbeitet wird -
  // hier wird nur zusaetzlich der React-State (setContacts) mitgefuehrt.
  // Der "M3"-Fix (lokale Sende-Warteschlange samt .enc-Dateien mitloeschen,
  // wipeQueueForContact) laeuft ebenfalls dort, und dieselbe Funktion wird
  // von removeContactLocally() (BackgroundSync.js) genutzt.
  const wipeContactLocally = (contactId) => {
    sharedWipeContactLocally(contactId, setContacts);
  };
  // Aus dem ChatScreen-Loeschen-Button herausgeloest (der jetzt entfaellt,
  // Design-Feedback: Header war ueberladen) - dieselbe Funktion wird jetzt
  // auch von der Kontaktliste per Gedruckthalten aufgerufen (Mehrfachaus-
  // wahl). Navigiert bewusst NICHT selbst zurueck - das entscheidet der
  // Aufrufer (ChatScreen will nach dem Loeschen zu 'home', HomeScreen ist
  // schon dort).
  // Mehrere Kontakte loeschen (Auswahl) - EIN Hinweis, falls die Gegenseite
  // gerade nicht verbunden ist (die Loeschung wird dann nachgereicht).
  const deleteContacts = (ids) => {
    const names = ids.map(id => contactsRef.current.find(x => x.id === id)?.name).filter(Boolean);
    Promise.all(ids.map(id => requestContactDeletion(id).catch(() => { removeContactLocally(id); return 'removed'; })))
      .then((res) => {
        const pending = res.filter(r => r === 'pending').length;
        if (!pending) return;
        Alert.alert(t('home.deleted.title'),
          names.length === 1 ? t('home.deleted.bodyOne', { name: names[0] }) : t('home.deleted.bodyMany'));
      }).catch(() => {});
  };
  const deleteContact = (chatId) => {
    // Nur-P2P-Umstellung 2026-09-29: der Loesch-Hinweis an die Gegenseite
    // ging bisher live UND zusaetzlich verschluesselt ueber den Relay
    // (/packet), dazu ein DELETE /transfer. Jetzt ausschliesslich P2P: der
    // Chat verschwindet sofort, der Hinweis wartet in der lokalen Sende-
    // Warteschlange auf die naechste direkte Verbindung (bzw. geht sofort
    // raus, wenn eine besteht) - siehe requestContactDeletion() in
    // BackgroundSync.js. Erst danach wird der Kontakt samt Secret endgueltig
    // entfernt.
    requestContactDeletion(chatId).catch(() => removeContactLocally(chatId));
  };
  // Loeschung kam von der Gegenseite (delete_chat per P2P) - nur lokal
  // entfernen, NICHT erneut einen Loesch-Hinweis zurueckschicken.
  const removeContactFromRemote = (chatId) => {
    removeContactLocally(chatId);
  };
  // "Chat leeren" - auf Nutzerwunsch ergaenzt: anders als deleteContact()
  // bleiben Kontakt/Pairing/Shared-Secret/Verbindung unangetastet, nur der
  // Nachrichtenverlauf wird auf BEIDEN Seiten geloescht (P2P-Hinweis +
  // verschluesselter Relay-Fallback, identisches Muster zu delete_chat -
  // siehe dortige Kommentare fuer die Frische-/Replay-Pruefung ueber ts).
  const clearChatMessages = (chatId) => {
    PinVault.removeItem('chat_' + chatId).catch(() => {});
    removeMediaScope(chatId).catch(() => {});   // Audit G1: Medien-Dateien mit
    setContacts(c => c.map(x => x.id === chatId ? { ...x, last: '', unread: 0 } : x));
    updateContacts(cs => cs.map(x => x.id === chatId ? { ...x, last: '', unread: 0 } : x)).catch(() => {});
    // Zustell-Garantie (Outbox-Prinzip, siehe BackgroundSync.js): der Hinweis
    // wird ZUERST verschluesselt eingereiht und dann - falls verbunden -
    // sofort gesendet; er bleibt stehen, bis die Gegenseite ihn bestaetigt
    // (vorher: einmal live senden und nur bei sofortigem Fehlschlag
    // einreihen - ein toter, noch "offener" Kanal verlor ihn). Noch nicht
    // zugestellte Inhalte gehoeren zum geleerten Verlauf und entfallen.
    // Nie ueber den Relay (Nur-P2P-Vorgabe).
    const ts = Date.now();
    dropQueuedContent(chatId).catch(() => {}).then(() =>
      sendViaOutbox(chatId, 'system', { type: 'system', subtype: 'clear_chat', ts }, 'clear_' + ts));
  };
  const nav = (s, d=null) => {
    if(s==='chat') {
      setChat(d);
      // Badge zurücksetzen wenn Chat geöffnet wird
      if (d?.id) {
        setContacts(c => c.map(x => x.id === d.id ? {...x, unread: 0} : x));
        // Ueber updateContacts serialisiert (Konkurrenz-Review §5) - ersetzt
        // den frueheren unabhaengigen getItem/setItem-Zyklus.
        updateContacts(cs => cs.map(x => x.id === d.id ? {...x, unread: 0} : x)).catch(() => {});
      }
    }
    if ((s === 'groupDetail' || s === 'groupChat') && d?.groupId) setActiveGroupId(d.groupId);
    setScreen(s);
  };
  navRef.current = nav;
  // Zurueck aus der Kopplung: lief sie fuer eine Gruppe, dorthin zurueck.
  const leaveConnect = () => {
    setDeepLinkToken(null);
    const p = pendingGroupAddRef.current;
    pendingGroupAddRef.current = null;
    if (p?.groupId) nav('groupDetail', { groupId: p.groupId });
    else if (p?.create) nav('groupCreate');
    else nav('home');
  };

  // Hardware-Zurueck-Taste (Android): ohne eigenen Handler beendet ein
  // Zurueck-Druck auf JEDEM Screen sofort die gesamte App (Standard-Android-
  // Verhalten, wenn nichts es abfaengt) - fuehlte sich von Chat/Settings/
  // Connect aus kaputt an, weil es (anders als der sichtbare In-App-Zurueck-
  // Pfeil) nicht zur vorherigen Ansicht zurueckgeht, sondern die App
  // komplett verlaesst. Nur auf den "Wurzel"-Screens (home/setup/lock)
  // bleibt das Standardverhalten (App verlassen) - ueberall sonst loest die
  // Hardware-Taste dieselbe Navigation aus wie der jeweilige In-App-Zurueck-
  // Button. call bekommt eine eigene Behandlung (regulaer auflegen statt nur
  // wegzunavigieren, damit kein Anruf im Hintergrund weiterlaeuft).
  React.useEffect(() => {
    const onHardwareBack = () => {
      // Erst das, was auf dem aktuellen Bildschirm offen ist (Auswahl, Suche,
      // Aufnahme, Ansicht in der Ansicht) - dann erst der Bildschirmwechsel.
      if (screen !== 'lock' && screen !== 'setup' && handleBackStack()) return true;
      if (screen === 'chat') {
        if (chatBackInterceptRef.current) { chatBackInterceptRef.current(); return true; }
        nav('home'); return true;
      }
      if (screen === 'settings') { nav('home'); return true; }
      if (screen === 'connect') { leaveConnect(); return true; }
      if (screen === 'call') { callManagerRef.current?.endCall('user_hangup'); return true; }
      if (screen === 'groupCall') return groupCallBackPress();
      if (screen === 'groups') { nav('home'); return true; }
      if (screen === 'groupCreate') { setCreatePreselect(null); nav('home'); return true; }
      if (screen === 'groupChat') { nav('home'); return true; }
      if (screen === 'groupDetail') { nav(activeGroup ? 'groupChat' : 'home'); return true; }
      return false; // home/setup/lock: Standardverhalten (App verlassen)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    return () => sub.remove();
  }, [screen, activeGroup]);

  // ── Automatische Sperre (Audit 2026-09-28) ─────────────────────────────
  // Der PIN wurde bisher NUR beim Kaltstart abgefragt. Da MalachiService den
  // Prozess absichtlich dauerhaft am Leben haelt, kam praktisch nie wieder ein
  // Kaltstart - wer das entsperrte Handy in die Hand bekam, konnte Malachi
  // jederzeit ohne PIN oeffnen und alle Chats lesen. Jetzt: war die App
  // laenger als AUTO_LOCK_AFTER_MS im Hintergrund, erscheint beim
  // Zurueckkehren wieder der Sperrbildschirm; nach dem Entsperren geht es
  // genau dort weiter, wo man war. Die Gnadenfrist deckt kurze System-Dialoge
  // ab (Bild-/Dateiauswahl, Kamera, Berechtigungsabfragen), die die App
  // ebenfalls kurz in den Hintergrund schicken. Waehrend eines Anrufs wird nie
  // gesperrt - die Sperre folgt dann direkt nach dem Auflegen.
  const backgroundSinceRef = useRef(0);
  const backgroundGraceRef = useRef(AUTO_LOCK_AFTER_MS);
  const resumeTargetRef = useRef(null);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const lockNow = () => {
    // PIN-Tresor: Schluessel sofort aus dem Arbeitsspeicher (PinVault.js).
    PinVault.lock();
    const cur = screenRef.current;
    if (cur === 'lock' || cur === 'setup') return;
    resumeTargetRef.current = { screen: cur, chat: chatRef.current };
    setScreen('lock');
  };
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        if (!backgroundSinceRef.current) {
          backgroundSinceRef.current = Date.now();
          backgroundGraceRef.current = isAutoLockSuspended() ? AUTO_LOCK_DURING_PICKER_MS : AUTO_LOCK_AFTER_MS;
          // Der Tresorschluessel bleibt nicht im Speicher, solange die App
          // im Hintergrund liegt - nach derselben Frist wie der Sperrbildschirm.
          // (Waehrend eines Anrufs auch: der braucht keine Verlaeufe.)
          PinVault.scheduleLock(backgroundGraceRef.current);
        }
        return;
      }
      if (next !== 'active') return;
      const since = backgroundSinceRef.current;
      backgroundSinceRef.current = 0;
      if (!since || Date.now() - since < backgroundGraceRef.current) { PinVault.cancelScheduledLock(); return; }
      if (callManagerRef.current || screenRef.current === 'call' || screenRef.current === 'groupCall') { lockPendingRef.current = true; return; }
      lockNow();
    });
    return () => sub.remove();
  }, []);
  // Nach Anrufende: war waehrenddessen eine Sperre faellig (bzw. kam der Anruf
  // auf dem Sperrbildschirm an), zurueck zur Sperre statt direkt in den Chat.
  afterCallNavRef.current = (contact) => {
    if (lockPendingRef.current) {
      lockPendingRef.current = false;
      if (!resumeTargetRef.current) resumeTargetRef.current = { screen: 'chat', chat: contact };
      setScreen('lock');
      return;
    }
    nav('chat', contact);
  };
  // STUN-Ausstieg (ConnectionMode.js): wer bisher "Schnell (mit STUN)" nutzte
  // (gespeichert oder als frueherer Standard), erfaehrt einmal nach dem
  // Entsperren, dass Malachi keine STUN-Dienste mehr fragt.
  const stunNoticeCheckedRef = useRef(false);
  React.useEffect(() => {
    if (screen !== 'home' || stunNoticeCheckedRef.current) return;
    stunNoticeCheckedRef.current = true;
    shouldShowStunRemovalNotice().then((show) => {
      if (!show) return;
      markStunRemovalNoticeShown();
      Alert.alert(t('connMode.migrated.title'), t('connMode.migrated.body'));
    }).catch(() => {});
  }, [screen]);
  const RESUMABLE_SCREENS = ['home', 'settings', 'connect', 'groups', 'groupCreate', 'groupDetail', 'groupChat'];
  const onUnlocked = () => {
    const target = resumeTargetRef.current;
    resumeTargetRef.current = null;
    if (target?.screen === 'chat' && target.chat) { nav('chat', target.chat); return; }
    if (target?.screen && RESUMABLE_SCREENS.includes(target.screen)) { nav(target.screen); return; }
    nav('home');
  };
  // Gruppenanruf klingelt/laeuft: Bildschirm zeigen, danach zurueck (Logik in GroupCallScreen.tsx).
  useGroupCallRouting({ screen, setScreen, nav, lockPendingRef, resumeTargetRef });

  // Kopplung fertig - aus dem Einladungs-Bildschirm ODER im Hintergrund
  // (Bildschirm schon verlassen, siehe ConnectScreen/BACKGROUND_PAIRED).
  const handlePairedRef = useRef(null);
  handlePairedRef.current = (contact, rtc) => {
    // Duplikat-Schutz (Live-Test entdeckt): deriveContactId() ist
    // deterministisch aus Token+PSK - eine Kollision mit einer bereits
    // bestehenden Kontakt-ID bedeutet fast immer, dass ein und dieselbe
    // Einladung zweimal verbunden wurde (z.B. noch offener alter Chat +
    // erneutes Pairen ueber denselben QR-Code/Deep-Link). Ohne diesen Schutz
    // ueberschreibt die neue Verbindung den alten RTCStore-Eintrag
    // klammheimlich (inkl. ggf. noch aktivem, aber inkonsistentem Shared
    // Secret) - genau das Szenario, das zu dauerhaft haengenden
    // "wird gesendet"-Nachrichten fuehrte. Lieber hart ablehnen und den
    // Nutzer auf einen sauberen Neustart (alten Kontakt zuerst loeschen)
    // verweisen, als mit widerspruechlichem Zustand weiterzumachen.
    // Live-Test Okt. 2026 (doppelte "Neuer Kontakt"-Eintraege): die Pruefung
    // lief gegen den Kontaktstand des Renders, in dem die (bei Tor langsame)
    // Kopplung GESTARTET wurde - ein zweiter Rueckruf derselben Kopplung legte
    // den Kontakt so ein zweites Mal an. Jetzt gegen den aktuellen Stand, und
    // derselbe Rueckruf fuer dieselbe, schon gespeicherte Verbindung ist
    // harmlos (nur zum Chat), statt die frische Verbindung zu zerstoeren.
    if (contact && contactsRef.current.some(x => x.id === contact.id)) {
      if (rtc && RTCStore.connections.get(contact.id) === rtc) {
        nav('chat', contactsRef.current.find(x => x.id === contact.id));
        return;
      }
      try { rtc?.close(); } catch {}
      RTCStore.clearContact(contact.id);
      Alert.alert(
        t('pairing.already.title'),
        t('pairing.already.body')
      );
      nav('home');
      return;
    }
    if (rtc && contact) {
      globalRTC.current = rtc;
      GLOBAL_RTC = rtc;
      RTCStore.setConnection(contact.id, rtc);
    }
    if (contact) {
      setContacts(c => (c.some(x => x.id === contact.id) ? c : [...c, contact]));
      // Ueber updateContacts serialisiert (Rot-Team-Review Fund 1). Nie
      // doppelt anlegen - auch nicht, wenn der Kontakt (z.B. vorgemerkt zum
      // Loeschen, in der Liste unsichtbar) schon gespeichert ist.
      updateContacts(cs => (cs.some(x => x.id === contact.id) ? null : [...cs, contact])).catch(() => {});
      // nav('chat', contact) statt setChat(contact)+nav('chat') getrennt:
      // nav() setzt bei s==='chat' selbst per setChat(d) den chat-State -
      // ohne den Kontakt als zweites Argument faellt d auf seinen Default
      // (null) zurueck und ueberschreibt den gerade gesetzten Kontakt SOFORT
      // wieder mit null. ChatScreen bekam dadurch chat=null: kein Listener
      // (alle Effekte haben ein `if (!chat?.id) return;`-Guard), keine
      // funktionierenden Nachrichten, keine sichtbare Reaktion nach dem
      // Verbinden - wirkte wie "kein neuer Chat" bzw. "falscher/leerer Chat
      // geoeffnet". Exakt derselbe Aufruf-Stil wie HomeScreens
      // onChat={c => nav('chat',c)}, der diesen Bug nie hatte. Per Live-Test
      // entdeckt (der Fund, der diese ganze Debug-Sitzung ausgeloest hat).
      recentlyPairedRef.current.set(contact.id, Date.now());
      const pending = pendingGroupAddRef.current;
      pendingGroupAddRef.current = null;
      if (pending?.create) {
        // Zurueck zu "Neue Gruppe", der neue Kontakt ist schon ausgewaehlt
        // (seine Gruppen-ID kommt Sekunden spaeter ueber den 1:1-Kanal).
        setCreatePreselect([contact.id]);
        nav('groupCreate');
        return;
      }
      if (pending?.groupId) {
        nav('groupChat', { groupId: pending.groupId });
        addContactToGroupWhenReady(pending.groupId, contact);
        return;
      }
      nav('chat', contact);
    } else {
      nav('home');
    }
  };
  BACKGROUND_PAIRED = (contact, rtc) => handlePairedRef.current?.(contact, rtc);
  // Neuer Kontakt in eine bestehende Gruppe: warten, bis seine Mitglieds-ID
  // ueber den 1:1-Kanal da ist (Schluesseltausch), dann aufnehmen - die
  // Einladung oeffnet bei ihm den Gruppenchat (setGroupInviteListener).
  const addContactToGroupWhenReady = async (groupId, contact) => {
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      const c = contactsRef.current.find(x => x.id === contact.id);
      if (c && memberIdOfContact(c)) break;
      await new Promise(r => setTimeout(r, 700));
    }
    const c = contactsRef.current.find(x => x.id === contact.id);
    if (!c || !memberIdOfContact(c)) {
      Alert.alert(t('siegel.paired.title'), t('app.pairedNotReadyForGroups', { name: contact.name || t('app.theContact') }));
      return;
    }
    const r = await addGroupMembers(groupId, [contact.id]).catch(() => ({ error: 'failed' }));
    if (r?.error === 'too_many') Alert.alert(t('common.group'), t('app.dieGruppeIstVoll'));
    else if (r?.error) Alert.alert(t('common.group'), t('app.derNeueKontaktKonnteNicht'));
  };

  // Nach "Alle Daten loeschen", Notfall-PIN oder 5 Fehlversuchen ALLE
  // Anzeigezustaende zuruecksetzen (Audit 2026-10-19, P7) - vorher blieben
  // nach "Alle Daten loeschen" Kontakte, Gruppen, Vorschautexte, Profil- und
  // Hintergrundbild bis zum Neustart der App sichtbar.
  const resetUiAfterWipe = () => {
    resumeTargetRef.current = null;
    pendingGroupAddRef.current = null;
    recentlyPairedRef.current = new Map();
    setChat(null); setContacts([]); setGroups([]); setActiveGroupId(null); setCreatePreselect(null);
    setUsername(''); setAvatar(null); setCustomBgUri(null); setBgColor('#FAFAF8'); setFontSize(14);
    setDeepLinkToken(null);
    resetOwnAvatarAfterWipe();
  };

  const topStripColor = screen === 'lock' || screen === 'setup' ? getLockTheme().bg
    : screen === 'call' ? P.surfaceAlt : P.headerBg;
  // Sprache (i18n.js): sofort umschalten und in 'settings' merken. Wechselt
  // dabei die Leserichtung (Arabisch/Persisch), braucht die App einen
  // Neustart - nur nach ausdruecklicher Bestaetigung.
  const changeLanguage = (code) => {
    setLanguage(code);
    const saved = saveSettings(AsyncStorage, { language: code }).catch(() => {});
    if (syncLayoutDirection()) {
      Alert.alert(t('settings.language.restartTitle'), t('settings.language.restartBody'), [
        { text: t('settings.language.later'), style: 'cancel' },
        { text: t('settings.language.restartNow'), onPress: () => { saved.then(() => restartApp()); } },
      ]);
    }
  };

  const screens = {
    setup:    <SetupScreen    onDone={(n) => { setUsername(n); setScreen('lock'); }} />,
    lock:     <LockScreen     onUnlock={onUnlocked} onWipe={() => { resetUiAfterWipe(); nav('setup'); }} />,
    home:     <HomeScreen     contacts={contacts} groups={groups} avatar={avatar} username={username} groupsUnread={groupsUnread} onChat={c => nav('chat',c)} onConnect={() => nav('connect')} onSettings={() => nav('settings')} onGroups={() => nav('groups')} onDelete={(ids) => deleteContacts(ids)} onClearChat={clearChatMessages}
                onOpenGroup={(g) => nav('groupChat', g)} onGroupInfo={(g) => nav('groupDetail', g)} onCreateGroup={() => { setCreatePreselect(null); nav('groupCreate'); }}
                onPinContact={togglePinContact} onPinGroup={(gid, pinned) => { setGroupPinned(gid, pinned).catch(() => {}); }} />,
    groups:   <GroupsScreen   groups={groups} palette={P} accent={AC} onBack={() => nav('home')} onCreate={() => nav('groupCreate')} onOpenGroup={(g) => nav('groupChat', g)} />,
    groupCreate: <GroupCreateScreen contacts={contacts} palette={P} accent={AC} onBack={() => { setCreatePreselect(null); nav('home'); }} onCreate={createGroup}
                   initialSelected={createPreselect} onPairNew={() => { pendingGroupAddRef.current = { create: true }; nav('connect'); }} />,
    groupDetail: <GroupDetailScreen group={activeGroup} contacts={contacts} palette={P} accent={AC} pickImage={launchImageLibrary} onBack={() => nav(activeGroup ? 'groupChat' : 'home')} onLeft={() => nav('home')}
                   onPairNew={() => { if (activeGroup) { pendingGroupAddRef.current = { groupId: activeGroup.groupId }; nav('connect'); } }} />,
    groupChat: <GroupChatScreen group={activeGroup} contacts={contacts} palette={P} accent={AC} fontSize={fontSize} customBg={customBgUri} onBack={() => nav('home')} onOpenDetail={() => nav('groupDetail')} />,
    groupCall: <GroupCallScreen contacts={contacts} palette={P} accent={AC} />,
chat:     <ChatScreen     chat={chat} rtc={globalRTC} fontSize={fontSize} customBg={customBgUri} onBack={() => nav('home')} backInterceptRef={chatBackInterceptRef} onCall={(video) => startOutgoingCall(chat, video)} onRename={(updated) => {
      // ZUSAMMENFUEHREN statt ersetzen (Live-Test 2026-10-18: "Kevs Profilbild
      // wird nicht uebertragen" - es kam an, aber die naechste Namens-
      // Aktualisierung ersetzte den Kontakt durch eine veraltete Kopie ohne
      // Bild). Felder mit undefined ueberschreiben nichts.
      const patch = Object.fromEntries(Object.entries(updated || {}).filter(([, v]) => v !== undefined));
      setChat(cur => (cur && cur.id === patch.id ? { ...cur, ...patch } : cur));
      setContacts(c => c.map(x => x.id === patch.id ? { ...x, ...patch } : x));
      updateContacts(cs => cs.map(x => x.id === patch.id ? { ...x, ...patch } : x)).catch(() => {});
      // Zweite Schutzschicht gegen dieselbe Grundursache wie die
      // Kontakt-ID-Kollisionspruefung in onConnected() oben - deckt aber den
      // Fall ab, dass zwei VERSCHIEDENE Kontakt-IDs (z.B. weil neu mit
      // frischem Token/PSK gepairt wurde) gleichzeitig aktiv sind, weil eine
      // alte Verbindung beim Loeschen/Neu-Pairen nie sauber geschlossen
      // wurde (genau das vom Nutzer beschriebene Live-Szenario). Name ist
      // KEIN kryptographischer Identitaetsnachweis (zwei echte Kontakte
      // koennten zufaellig gleich heissen) - deshalb nur eine Warnung mit
      // Wahlmoeglichkeit statt automatischem Schliessen.
      if (updated.theirName) {
        // Doppelter Kontakt: dasselbe GERAET (gleiche Onion-Adresse bzw.
        // Gruppen-Kennung) - oder gleicher Name, solange beide gerade verbunden
        // sind. Live-Test 2026-10-19: die alte Meldung ("Möglicherweise doppelte
        // Verbindung … Alten Chat trennen") war unverstaendlich, und "Trennen"
        // half nicht (die Verbindung kam sofort wieder).
        const list = contactsRef.current || contacts;
        const me = list.find(x => x.id === patch.id) || patch;
        const sameDevice = (x) => (me.torOnion && x.torOnion === me.torOnion) || (me.groupMemberId && x.groupMemberId === me.groupMemberId);
        const dupe = list.find(x => x.id !== patch.id && !x.wiped && RTCStore.isConnected(x.id)
          && (sameDevice(x) || x.theirName === updated.theirName));
        if (dupe) {
          // Aelter = weiter vorne in der Liste (Kontakte werden beim Koppeln angehaengt).
          const older = list.findIndex(x => x.id === dupe.id) < list.findIndex(x => x.id === patch.id) ? dupe : me;
          Alert.alert(
            t('app.kontaktDoppeltVorhanden'),
            t('app.stehtZweimalInDeinerKontaktliste', { theirName: updated.theirName }),
            [
              { text: t('app.beideBehalten'), style: 'cancel' },
              { text: t('app.aelterenChatEntfernen'), style: 'destructive', onPress: () => {
                deleteContact(older.id);
                if (chat?.id === older.id) nav('home');
              } },
            ]
          );
        }
      }
    }} onWipe={wipeContactLocally} onDelete={(chatId) => { deleteContact(chatId); nav('home'); }} onRemoteDelete={(chatId) => { removeContactFromRemote(chatId); nav('home'); }} onLastMessage={(chatId, preview) => {
      const time = formatTime();
      const sk = siegelKind(preview);
      const shown = sk === 'invite' ? t('preview.siegelInvite') : sk === 'ack' ? t('preview.siegelAck') : sk ? t('preview.siegelMessage')
        : /^📎 .*\.sgl$/i.test(preview) ? t('preview.siegelAttachment') : preview;
      const last = shown.length > 200 ? shown.slice(0, 200) + '…' : shown;
      const lastTs = Date.now();
      setContacts(c => c.map(x => x.id === chatId ? { ...x, last, time, lastTs } : x));
      updateContacts(cs => cs.map(x => x.id === chatId ? { ...x, last, time, lastTs } : x)).catch(() => {});
    }} />,
    call:     <CallScreen     chat={chat} callManager={callManagerRef.current} callState={callState} remoteStream={remoteStream} videoOn={videoOn} remoteVideoOn={remoteVideoOn} onEnd={() => callManagerRef.current?.endCall('user_hangup')} />,
    connect:  <ConnectScreen  onBack={leaveConnect} deepLinkToken={deepLinkToken} onConnected={(contact, rtc) => handlePairedRef.current(contact, rtc)} />,
    settings: <SettingsScreen 
    onBack={() => nav('home')} 
    currentBg={customBgUri ? 'custom' : (CHAT_BG_PRESETS.find(b => b.color === getThemeSelection().chatBgPreset)?.key || 'theme')}
    currentFont={fontSize === 13 ? 'small' : fontSize === 18 ? 'large' : 'normal'}
    // Audit 2026-09-28: Akzent-/Schriftgroessen-Aenderung schrieb die
    // Einstellungen OHNE customBgUri - ein eigenes Chat-Hintergrundbild war
    // nach dem naechsten App-Start stillschweigend wieder weg. Jetzt schreibt
    // saveSettings (Themes.js) nur die geaenderten Felder in das gespeicherte
    // Objekt (Lesen-Zusammenfuehren-Schreiben) - nichts geht mehr verloren.
    onDesignChange={(patch) => chooseDesign(patch, { storage: AsyncStorage, isProVerified })}
    onBgChange={(color, uri) => {
      if (uri) { setCustomBgUri(uri); saveSettings(AsyncStorage, { customBgUri: uri }).catch(() => {}); return; }
      // color null = "Wie Design" (Chatverlauf in der Farbe des Themas)
      setBgColor(color || '#FAFAF8'); setCustomBgUri(null);
      setThemeSelection({ chatBgPreset: color || null });
      saveSettings(AsyncStorage, { bgColor: color || null, customBgUri: null }).catch(() => {});
    }}
    onFontChange={(size) => { setFontSize(size); saveSettings(AsyncStorage, { fontSize: size }).catch(() => {}); }}
    onLanguageChange={changeLanguage}
    onAvatarChange={(uri) => setAvatar(uri)}
    username={username}
    onUsernameChange={(n) => { setUsername(n); AsyncStorage.setItem('username', n); }}
    onWipeAll={() => performWipe().then(() => { resetUiAfterWipe(); nav('setup'); })}
    onLockNow={() => { resumeTargetRef.current = null; lockNow(); }} />,
  };

  return (
    <View style={{ flex:1, backgroundColor:P.bg, paddingBottom:insets.bottom }}>
      {/* Streifen unter der Statusleiste in der Farbe dessen, was direkt
          darunter beginnt (Kopfleiste, Sperrbildschirm, Anruf) - vorher immer
          der App-Hintergrund: bei "Gletscher" (helle App, dunkle Kopfleiste)
          ein heller Streifen mit unsichtbaren hellen Symbolen. */}
      <View style={{ height:insets.top, backgroundColor:topStripColor }} />
      <StatusBar barStyle={statusBarFor(topStripColor)} backgroundColor={topStripColor} />
      {screens[screen]}
    </View>
  );
}

// Edge-to-Edge ist ab Android 16 (targetSdk 36) zwingend - kann nicht mehr
// abgeschaltet werden (anders als noch bei Android 15). Ohne SafeAreaProvider
// zeichnet der App-Inhalt hinter Status-/Navigationsleiste. useSafeAreaInsets()
// in AppInner braucht einen SafeAreaProvider-Vorfahren, daher dieser duenne
// Wrapper als tatsaechlicher Root-Export statt AppInner direkt zu registrieren.
export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function SetupScreen({ onDone }) {
  const [name, setName] = React.useState('');
  const finish = async () => {
    if (!name.trim()) return;
    await AsyncStorage.setItem('username', name.trim());
    await AsyncStorage.setItem('setup_done', 'true');
    // Neu eingerichtet: der Hinweis zum STUN-Ausstieg (ConnectionMode.js)
    // betrifft nur Apps, die schon vorher liefen.
    await markStunRemovalNoticeShown({ fresh: true });
    const myId = await generateContactId();
    await AsyncStorage.setItem('my_id', myId);
    onDone(name.trim());
  };
  return (
    <View style={{ flex:1, backgroundColor:'#0D2A4A', alignItems:'center', justifyContent:'center', padding:32 }}>
      <Text style={{ fontSize:28, fontWeight:'600', color:'#F7F5F2', textAlign:'center', marginBottom:24 }}>{t('setup.title')}</Text>
      <TextInput value={name} onChangeText={setName} placeholder={t('common.name')} placeholderTextColor="#6E93AE" autoFocus maxLength={32} style={{ width:'100%', backgroundColor:'#0A2340', borderRadius:14, padding:16, fontSize:18, color:'#F7F5F2', borderWidth:1, borderColor:'#1CCCF0', marginBottom:24, textAlign:'center' }}/>
      <TouchableOpacity onPress={finish} disabled={!name.trim()} style={{ backgroundColor: name.trim() ? '#0A7EA4' : '#0A2340', borderRadius:16, padding:18, width:'100%', alignItems:'center' }}>
        <Text style={{ color:'white', fontSize:16, fontWeight:'500' }}>{t('setup.continue')}</Text>
      </TouchableOpacity>
    </View>
  );
}

// Schickt device_wiped ueber jede aktuell offene P2P-Verbindung (siehe
// performWipe()). Verschluesselt wie jede Nachricht der Verbindung (bei
// Ratchet-Kontakten durch den Double Ratchet, sonst mit dem Session-Secret,
// siehe WebRTCManager.sendMessageAndWait) und wartet - begrenzt - bis die
// Pakete den DataChannel verlassen haben, damit das anschliessende resetAll()
// sie nicht mehr abschneidet.
const WIPE_NOTICE_MAX_WAIT_MS = 800;
async function notifyOpenConnectionsOfWipe() {
  const sends = [];
  for (const rtc of RTCStore.connections.values()) {
    if (!rtc?.sharedSecret || rtc.dataChannel?.readyState !== 'open' || typeof rtc.sendMessageAndWait !== 'function') continue;
    sends.push(
      Promise.resolve()
        .then(() => rtc.sendMessageAndWait(JSON.stringify({ type: 'system', subtype: 'device_wiped', ts: Date.now() })))
        .catch(() => {})
    );
  }
  if (sends.length === 0) return;
  await Promise.race([
    Promise.all(sends).then(() => new Promise(r => setTimeout(r, 300))),
    new Promise(r => setTimeout(r, WIPE_NOTICE_MAX_WAIT_MS)),
  ]);
}

// MODULEBENE, nicht in LockScreen (Nutzer-Fund: "Alles loeschen" stuerzte ab
// und loeschte nichts): die Funktion stand vorher als `const` INNERHALB von
// LockScreen, wurde aber zusaetzlich aus AppInner heraus als
// `onWipeAll={() => performWipe()...}` an SettingsScreen durchgereicht. Dort
// war der Name nie gebunden - Tippen auf "Alles loeschen" lief in einen
// ReferenceError, die App stuerzte ab und KEIN einziger Speicher wurde
// angefasst, weshalb man sich danach mit dem alten PIN wieder anmelden
// konnte. Als Funktionsdeklaration auf Modulebene ist sie gehoistet und
// damit von AppInner (weiter oben im Text) wie von LockScreen aus sichtbar.
// Sie schliesst ueber keinerlei LockScreen-Zustand - nur ueber die
// Modul-Importe (AsyncStorage, EncryptedStorage, RTCStore, encryptMsg,
// RNFS) - deshalb ist das Verschieben verhaltensneutral.
//
// Aus dem 5-Fehlversuche-Pfad herausgeloest, damit die Duress-PIN (siehe
// tap() in LockScreen) denselben vollstaendigen Wipe ausloesen kann, OHNE
// die dort bewusst dramatische UI ("Geraet wird zurueckgesetzt...", Sperre,
// 1s Verzoegerung) mitzubekommen - ein stiller Notruf darf fuer eine
// Person, die zur Eingabe zwingt, nach aussen exakt wie eine normale
// Entsperrung wirken. Die eigentliche Wipe-Logik (Kontakte benachrichtigen,
// RTCStore zuruecksetzen, alle Speicher leeren) ist in beiden Faellen
// identisch.
async function performWipe() {
  // Kontakte ueber den Wipe informieren (State-Machine-Review,
  // Nutzer-Fund 3 - explizit gewuenscht: "ja bitte, und diesen Status
  // auch an andere User weitergeben").
  //
  // Nur-P2P-Umstellung 2026-09-29: der Hinweis ging bisher zusaetzlich
  // verschluesselt ueber den Relay (/packet) an ALLE Kontakte. Vorgabe jetzt:
  // nichts ueber den Server. Er geht daher nur noch an Kontakte, mit denen
  // GENAU JETZT eine direkte P2P-Verbindung besteht. In die lokale Sende-
  // Warteschlange kann er nicht - die wird mit dem Wipe ja gerade geloescht.
  // Kontakte ohne offene Verbindung erfahren vom Wipe erst, wenn ihr
  // naechster Verbindungsversuch mangels passenden Secrets scheitert.
  // Bewusst kurz begrenzt (WIPE_NOTICE_MAX_WAIT_MS): ein erzwungener Wipe
  // soll die Daten so schnell wie moeglich loeschen.
  // MUSS vor RTCStore.resetAll() unten laufen (das schliesst die Kanaele).
  //
  // Vollversion: die Benachrichtigung der Kontakte ("Fernloeschung") ist eine
  // Pro-Funktion (LicenseManager.shouldNotifyContactsOnWipe). Der Pro-Status
  // wird VOR dem Loeschen bestimmt - die Lizenz liegt im verschluesselten
  // Speicher, der gleich geleert wird. Das lokale Loeschen selbst laeuft
  // immer vollstaendig, mit und ohne Lizenz.
  let notifyContacts = false;
  try { notifyContacts = shouldNotifyContactsOnWipe(await isProVerified()); } catch {}
  if (notifyContacts) await notifyOpenConnectionsOfWipe();

  // In-Memory-Zustand von RTCStore zurücksetzen (Secrets-Lifecycle-Review,
  // Fund S-1): offene Verbindungen schließen, gepufferte Klartexte und
  // gecachte Shared Secrets entfernen. MUSS nach dem device_wiped-Versand
  // oben stehen (der liest RTCStore.sharedSecrets), sonst würde die
  // Benachrichtigung nie verschickt.
  RTCStore.resetAll();

  // Tor: alte Onion-Identitaet nicht weiter veroeffentlichen, offene
  // Einladungen verwerfen, Wachen/torrc (eigene Bridges)/PT-Zustand loeschen
  // (Audit 2026-10-19, P4). Beim Einrichten entsteht eine neue Identitaet.
  OPEN_INVITE = null;
  await withTimeout(wipeTorForReset(), 8000);

  // Siegel-Tresor samt Schluessel im Sicherheitschip vernichten - der
  // verschluesselte Speicher wird unten ohnehin geleert, der Chip-Schluessel
  // aber nur hier. Mit Zeitgrenze (Audit 2026-10-19, C4): haengt eine
  // laufende Siegel-Operation (z. B. Argon2 ohne Speicher), darf das den
  // Wipe nicht aufhalten - dann den Chip-Schluessel direkt loeschen.
  const siegelOk = await withTimeout(siegelWipe().then(() => true, () => false), 5000);
  if (siegelOk !== true) await withTimeout(NativeModules.MalachiSiegelKey?.destroyKey?.() ?? Promise.resolve(), 3000);

  // PIN-Tresor: Datensatz und Chip-Schluessel vernichten - damit sind alle
  // damit verschluesselten Verlaeufe sofort unlesbar (auch Reste, die das
  // Loeschen unten nicht erwischen sollte). Mit Zeitgrenze, wie oben.
  await withTimeout(PinVault.wipe(), 3000);

  // Kompletter Wipe.
  // Vorher wurden diese Schlüssel nur aus EncryptedStorage entfernt -
  // sie liegen aber in AsyncStorage. Der "Wipe" hat damit faktisch
  // nichts gelöscht: Kontakte, PIN, Name und ID blieben erhalten.
  const asyncKeys = [
    'contacts', 'my_id', 'username', 'avatar', 'avatar_ref',
    'app_pin', 'pin_length', 'bio_enabled', 'setup_done',
    'settings',
  ];
  try { await AsyncStorage.multiRemove(asyncKeys); } catch {}
  // Hinweis: das "AsyncStorage" dieser Datei ist nur ein Wrapper um
  // EncryptedStorage (siehe Definition oben) und hat gar kein clear() -
  // dieser Aufruf wirft und landet im catch. Das ist folgenlos, weil
  // saemtliche Schluessel ohnehin in EncryptedStorage liegen und das
  // EncryptedStorage.clear() weiter unten sie restlos entfernt (am Geraet
  // geprueft: danach stehen in RN_ENCRYPTED_STORAGE_SHARED_PREF.xml nur
  // noch die Keysets der AndroidX-Security-Bibliothek selbst). Bleibt als
  // Absicherung stehen, falls der Wrapper je ein echtes clear() bekommt.
  try { await AsyncStorage.clear(); } catch {}

  // Verschlüsselter Speicher (Shared Secrets, Warteschlangen, PIN, Duress-PIN)
  for (const k of asyncKeys) {
    try { await EncryptedStorage.removeItem(k); } catch {}
  }
  try { await EncryptedStorage.removeItem('pin_attempts'); } catch {}
  try { await EncryptedStorage.removeItem('pin_locked_until'); } catch {}
  try { await EncryptedStorage.removeItem('duress_pin'); } catch {}
  try { await EncryptedStorage.removeItem(LICENSE_STORAGE_KEY); } catch {}
  try { await EncryptedStorage.removeItem(PURCHASE_STORAGE_KEY); } catch {}
  try { await EncryptedStorage.clear(); } catch {}
  // Lizenz und Bestellung lagen im eben geleerten Speicher - auch den Zustand
  // im Arbeitsspeicher angleichen: eine frisch eingerichtete App darf nicht
  // "Vollversion aktiv" zeigen (verriete nach einer Duress-Loeschung, dass es
  // Pro und damit womoeglich eine Notfall-PIN gab).
  resetLicenseStateAfterWipe();
  // Bildschirmschutz wieder an (die Einstellung lag im geloeschten Speicher).
  resetScreenProtectionAfterWipe();
  resetWaveStyleAfterWipe();
  // Verbindungs-Diagnose (ConnectionStats.js): Zaehler lagen im eben
  // geleerten Speicher - auch den Arbeitsspeicher leeren.
  resetConnectionStatsAfterWipe();
  // Ebenso das Design: zurueck auf das unveraenderte Standard-Design (die
  // gespeicherte Wahl lag in 'settings', ein eigenes Thema/Akzent im RAM
  // verriete die vorherige Einrichtung).
  restoreThemeSelection(selectionFromSettings(null));
  // Ebenso die Sprache: 'settings' ist geleert - wieder die Geraetesprache
  // (Leserichtung greift beim naechsten Start).
  setLanguage(SYSTEM_LANGUAGE);
  syncLayoutDirection();

  // Zwischengespeicherte Medien-Dateien (Warteschlange) mit entfernen -
  // die lagen bisher komplett außerhalb des Wipes. Ebenso die verschluesselte
  // Empfangs-Ablage (inbox_*, siehe RTCStore.js).
  try {
    // RNFS kommt aus dem statischen Import oben (Simplification-Pass).
    const files = await RNFS.readDir(RNFS.DocumentDirectoryPath);
    for (const f of files) {
      if (f.name.startsWith('queue_') || f.name.startsWith('inbox_')) {
        await RNFS.unlink(f.path).catch(() => {});
      }
    }
  } catch {}
  // Verlaufs-Medien (MediaVault.js, Audit G1) samt RAM-Zwischenspeicher.
  await wipeAllMedia().catch(() => {});

  // Benachrichtigungen ("Neue Nachricht", Anruf) und den Hintergrunddienst
  // entfernen (Audit 2026-10-19, P2) - sonst stand nach Notfall-PIN/Wipe
  // z. B. noch "Neue Nachricht" bzw. "Verbindung aktiv" in der Leiste.
  try { MalachiNotification?.cancelAll?.(); } catch {}
  try { MalachiService?.stop?.(); } catch {}
  // Zwischenablage leeren (kopierte Nachricht/Einladungscode).
  try { Clipboard.setString(''); } catch {}

  // KLARTEXT-Medien aus dem Cache: play_<id>.mp4 (entschluesselte
  // Sprachnachricht waehrend der Wiedergabe) und malachi_<ts>.* (frisch
  // aufgenommenes Audio bzw. ausgewaehltes Bild vor dem Verschluesseln).
  // Beide raeumen ihre Pfade im Normalfall selbst ab - wird die App aber
  // waehrend Aufnahme/Wiedergabe beendet oder abgeschossen, bleibt eine im
  // Klartext lesbare Mediendatei liegen. Genau die darf einen Wipe nicht
  // ueberleben: der Duress-Pfad existiert fuer den Fall, dass das Geraet
  // gleich in fremde Haende geht. Lag bisher komplett ausserhalb des Wipes,
  // weil nur das Dokumentverzeichnis betrachtet wurde.
  // Audit 2026-10-19 (P3): den GESAMTEN Cache leeren - auch die Kopien, die
  // der Bild-Picker selbst anlegt (rn_image_picker_lib_temp_*: Klartext-
  // Fotos, auch aus dem Secret Chat), Siegel-/Update-Temp-Ordner usw.
  try {
    const cached = await RNFS.readDir(RNFS.CachesDirectoryPath);
    for (const f of cached) {
      await RNFS.unlink(f.path).catch(() => {});
    }
  } catch {}
}

// Wartet hoechstens ms Millisekunden - fuer Schritte des Wipes, die nie
// haengen duerfen (liefert dann undefined).
function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise((r) => { t = setTimeout(() => r(undefined), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Platzhalter fuer "PIN vorhanden" mit PIN-Tresor - keine Ziffernfolge, kann
// also nie mit einer Eingabe uebereinstimmen.
const VAULT_PIN = '\u0000vault';

// Nach jedem Entsperren mit PIN-Tresor: gesperrt abgelegte Empfangs-
// Nachrichten nachholen und den Altbestand EINMAL verschluesseln (Verlaeufe,
// Vorschautexte, Schluessel der Empfangs-Ablage). Jeder Verlauf wird nach dem
// Verschluesseln zurueckgelesen und verglichen (PinVault.migrateKeys); bei
// einer Abweichung bleibt er im Klartext und es wird beim naechsten
// Entsperren erneut versucht - nie ein Datenverlust. Danach abgelaufene
// Timer-Nachrichten aus allen Verlaeufen entfernen (sweepExpiredChats).
let vaultMigration = null;
export function afterVaultUnlock() {
  if (!PinVault.isUnlocked()) return Promise.resolve();
  RTCStore.ensureInboxRestored();
  if (vaultMigration) return vaultMigration;
  vaultMigration = migrateVaultOnce()
    .catch((e) => console.warn('[PIN-Tresor] Umstellung:', e?.message || e))
    .then(() => sweepExpiredChats())
    .catch((e) => console.warn('[Timer] Bereinigung:', e?.message || e))
    .finally(() => { vaultMigration = null; });
  return vaultMigration;
}
async function migrateVaultOnce() {
  if ((await EncryptedStorage.getItem('pin_vault_migrated').catch(() => null)) === '1') return;
  const list = (raw) => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const contacts = list(await EncryptedStorage.getItem('contacts').catch(() => null));
  const groups = list(await EncryptedStorage.getItem('groups').catch(() => null));
  const keys = ['chat_default',
    ...contacts.filter(c => c?.id).map(c => 'chat_' + c.id),
    ...groups.filter(g => g?.groupId).map(g => 'gchat_' + g.groupId)];
  const res = await PinVault.migrateKeys(keys);
  // Vorschautexte werden beim Schreiben versiegelt (BackgroundSync).
  await updateContacts(cs => cs);
  await updateGroups(gs => gs);
  await RTCStore.sealInboxIndex();
  if (!res.failed) await EncryptedStorage.setItem('pin_vault_migrated', '1');
  console.log('[PIN-Tresor] Altbestand verschluesselt:', res.migrated, 'Fehler:', res.failed);
}

export function LockScreen({ onUnlock, onWipe }) {
  const [pin,        setPin]     = useState('');
  const [err,        setErr]     = useState('');
  const [att,        setAtt]     = useState(0);
  const [locked,     setLocked]  = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [pinLen,     setPinLen]  = useState(6);
  const [hasBio,     setHasBio]  = useState(false);
  const [savedPin,   setSaved]   = useState(null);   // Altbestand: PIN im Klartext; mit Tresor nur VAULT_PIN
  const [duressPin,  setDuressPin] = useState(null); // nur Altbestand (mit Tresor: Pruefwert im Tresor)
  const [busy,       setBusy]    = useState(false);
  // PIN-Tresor (PinVault.js): 'present' | 'absent' | 'unknown' | null (laedt)
  const vaultRef = useRef(null);
  const bioEnrollRef = useRef(false);
  const [confirmPin, setConfirm] = useState('');
  const [step,       setStep]    = useState('enter'); // enter | setup | confirm
  const [lenInfo,    setLenInfo] = useState(false);   // kleines "i" bei 4/6 Stellen
  // Vollversion: nur fuer die Texte der Sperrfristen ("noch X Versuche"
  // kuendigt eine Loeschung an, die es ohne Pro nicht gibt). Ob nach dem 5.
  // Fehlversuch geloescht wird, entscheidet tap() mit einer frischen Pruefung.
  const [pro,        setPro]     = useState(getLicenseState().pro === true);
  const shake = useRef(new Animated.Value(0)).current;
  const fade  = useRef(new Animated.Value(0)).current;
  const rnBiometrics = new ReactNativeBiometrics();

  React.useEffect(() => subscribeLicense(s => setPro(s.pro === true)), []);

  React.useEffect(() => {
    Animated.timing(fade, { toValue:1, duration:600, useNativeDriver:true }).start();
    // Gespeicherten PIN laden
    const loadPin = async () => {
      const l = await AsyncStorage.getItem('pin_length').catch(() => null);
      if (l) setPinLen(parseInt(l));
      // PIN-Tresor (seit 2026-10-25): die PIN selbst ist nirgends mehr
      // gespeichert - geprueft wird, ob sie den Tresorschluessel oeffnet.
      const vs = await PinVault.vaultState();
      vaultRef.current = vs;
      if (vs === 'present' || vs === 'unknown') {
        // 'unknown' (Speicher gerade nicht lesbar): NIE die Einrichtung
        // anbieten - die naechste Eingabe versucht es erneut.
        // Laenge aus dem Tresor-Datensatz, falls vorhanden (seit "PIN
        // aendern": steht im selben Datensatz wie die PIN - nie auseinander).
        const vl = PinVault.pinLength();
        if (vl) setPinLen(vl);
        setSaved(VAULT_PIN);
        return;
      }
      // Altbestand (vor dem Update): PIN noch im verschluesselten Speicher.
      // Beim ersten erfolgreichen Entsperren wird daraus der Tresor.
      let p = null;
      try { p = await EncryptedStorage.getItem('app_pin'); } catch {}
      if (!p) setStep('setup');
      else { setSaved(p); setPinLen(p.length); }
      try {
        const dp = await EncryptedStorage.getItem('duress_pin');
        if (dp) setDuressPin(dp);
      } catch {}
    };
    loadPin();

    // Fehlversuche und Sperrfrist überdauern jetzt einen App-Neustart.
    // Vorher lagen beide nur im Arbeitsspeicher: App schließen und neu
    // öffnen setzte den Zähler auf 0 und hob die Sperre auf - die
    // 5-Versuche-Grenze war damit beliebig oft umgehbar.
    const loadLockState = async () => {
      try {
        const a = await EncryptedStorage.getItem('pin_attempts');
        if (a) setAtt(parseInt(a) || 0);
        const u = await EncryptedStorage.getItem('pin_locked_until');
        if (u && parseInt(u) > Date.now()) setLockedUntil(parseInt(u));
      } catch {}
    };
    loadLockState();

    // Biometrie prüfen
    rnBiometrics.isSensorAvailable().then(({ available }) => {
      setHasBio(available);
      if (available) {
        AsyncStorage.getItem('bio_enabled').then(b => {
          if (b === 'true') tryBiometrics();
        });
      }
    });
  }, []);

  const unlockDone = async () => {
    setAtt(0);
    setLockedUntil(0);
    try {
      await EncryptedStorage.removeItem('pin_attempts');
      await EncryptedStorage.removeItem('pin_locked_until');
    } catch {}
    onUnlock();
    afterVaultUnlock();
    // Fingerabdruck wurde gewuenscht, aber war noch nicht an den Tresor
    // gebunden: jetzt einrichten (Systemdialog).
    if (bioEnrollRef.current && PinVault.isUnlocked()) {
      bioEnrollRef.current = false;
      PinVault.enrollBiometrics({ title: t('lock.bioEnrollTitle'), subtitle: t('lock.bioEnrollSub'), cancel: t('common.cancel') }).catch(() => {});
    }
  };

  const tryBiometrics = async () => {
    if (busy) return;
    // Mit PIN-Tresor oeffnet der Fingerabdruck den Tresorschluessel (Chip,
    // CryptoObject) - ein reiner "Ja/Nein"-Dialog reicht nicht mehr.
    if (vaultRef.current === 'present') {
      if (!PinVault.hasBiometrics()) {
        bioEnrollRef.current = true;
        setErr(t('lock.bioSetupHint'));
        return;
      }
      const r = await PinVault.unlockWithBiometrics({ title: t('lock.bioPrompt'), cancel: t('lock.enterPin') });
      if (r.ok) { setPin(''); setErr(''); await unlockDone(); return; }
      if (r.reason === 'invalidated') { bioEnrollRef.current = true; setErr(t('lock.bioInvalidated')); }
      return;
    }
    // Altbestand: nach dem Update einmal mit PIN entsperren (daraus entsteht
    // der Tresor), danach geht der Fingerabdruck wieder.
    if (PinVault.isAvailable()) {
      bioEnrollRef.current = true;
      setErr(t('lock.bioAfterUpdate'));
      return;
    }
    try {
      const { success } = await rnBiometrics.simplePrompt({
        promptMessage: t('lock.bioPrompt'),
        cancelButtonText: t('lock.enterPin'),
      });
      if (success) onUnlock();
    } catch {}
  };

  const doShake = () => Animated.sequence([
    Animated.timing(shake, { toValue:8,  duration:55, useNativeDriver:true }),
    Animated.timing(shake, { toValue:-8, duration:55, useNativeDriver:true }),
    Animated.timing(shake, { toValue:4,  duration:55, useNativeDriver:true }),
    Animated.timing(shake, { toValue:0,  duration:55, useNativeDriver:true }),
  ]).start();

  const tap = async (k) => {
    if (locked || busy) return; // Gesperrt bzw. Pruefung laeuft – keine Eingabe
    if (k === '⌫') { setPin(p => p.slice(0,-1)); return; }
    if (pin.length >= pinLen) return;
    const next = pin + k;
    setPin(next);

    if (next.length === pinLen) {
      await new Promise(r => setTimeout(r, 150));

      if (step === 'setup') {
        // Erste Eingabe im Setup
        setConfirm(next);
        setPin('');
        setStep('confirm');
        setErr(t('lock.confirmPin'));
        return;
      }

      if (step === 'confirm') {
        // Bestätigung im Setup
        if (next === confirmPin) {
          // PIN-Tresor anlegen - die PIN selbst wird nicht gespeichert. Nur
          // wenn das scheitert (kein Sicherheitschip nutzbar), wie bisher.
          setBusy(true);
          setErr(t('lock.unlocking'));
          let created = false;
          try { await PinVault.create(next); created = true; } catch (e) { console.warn('[PIN-Tresor] Einrichten:', e?.message || e); }
          setBusy(false);
          if (!created) await EncryptedStorage.setItem('app_pin', next);
          vaultRef.current = created ? 'present' : 'absent';
          await AsyncStorage.setItem('pin_length', String(pinLen));
          setSaved(created ? VAULT_PIN : next);
          setStep('enter');
          setErr('');
          setPin('');
          onUnlock();
        } else {
          doShake();
          setErr(t('lock.mismatch'));
          setPin('');
          setTimeout(() => { setErr(t('lock.confirmPin')); }, 1000);
          setStep('setup');
          setConfirm('');
        }
        return;
      }

      // Duress-PIN: sieht fuer eine Person, die zur Eingabe zwingt, exakt wie
      // eine normale, erfolgreiche Entsperrung aus (kein Shake, kein Hinweis,
      // keine Verzoegerung) - im Hintergrund laeuft aber der vollstaendige
      // Wipe. Danach zeigt onWipe() den Ersteinrichtungs-Bildschirm, nicht
      // die (jetzt leere) Home-Ansicht - wirkt wie eine frische Installation,
      // nicht wie eine erfolgreiche Anmeldung mit leerem Postfach.
      //
      // Vollversion: das EINRICHTEN der Duress-PIN ist eine Pro-Funktion
      // (SettingsScreen). Eine bereits eingerichtete Duress-PIN wird hier aber
      // IMMER ausgewertet - auch ohne bzw. mit ungueltiger Lizenz (Regel und
      // Begruendung: LicenseManager.isDuressPinEntry). Ein eingerichteter
      // Schutz darf nie still abgeschaltet werden.
      let ok = false;
      if (vaultRef.current === 'present' || vaultRef.current === 'unknown') {
        // PIN-Tresor: eine Ableitung (Argon2id + Chip) prueft Notfall-PIN
        // und echte PIN. Die Notfall-PIN liegt nur als Pruefwert vor.
        setBusy(true);
        setErr(t('lock.unlocking'));
        let r;
        try { r = await PinVault.unlockWithPin(next); } finally { setBusy(false); }
        setErr('');
        if (r.duress) {
          setPin('');
          performWipe().then(() => onWipe?.());
          return;
        }
        if (r.ok) {
          vaultRef.current = 'present';
          ok = true;
        } else if (r.reason !== 'wrong') {
          // Technischer Fehler (Chip/Speicher) - kein Fehlversuch.
          setPin('');
          setErr(t('lock.vaultError'));
          return;
        }
      } else {
        if (isDuressPinEntry(next, duressPin)) {
          setPin('');
          performWipe().then(() => onWipe?.());
          return;
        }
        if (next === savedPin) {
          ok = true;
          // Erstes Entsperren nach dem Update: Tresor aus dieser PIN anlegen,
          // die Klartext-PIN (und Notfall-PIN) danach aus dem Speicher.
          if (PinVault.isAvailable()) {
            setBusy(true);
            setErr(t('lock.unlocking'));
            try {
              await PinVault.create(next, { duressPin });
              vaultRef.current = 'present';
              setSaved(VAULT_PIN);
              setDuressPin(null);
              await EncryptedStorage.removeItem('app_pin').catch(() => {});
              await EncryptedStorage.removeItem('duress_pin').catch(() => {});
            } catch (e) {
              console.warn('[PIN-Tresor] Umstellung:', e?.message || e);
            } finally {
              setBusy(false);
              setErr('');
            }
          }
        }
      }

      // Normales Login
      if (ok) {
        setPin('');
        await unlockDone();
      } else {
        const n = att + 1;
        setAtt(n);
        doShake();
        setPin('');
        // Zähler SOFORT persistieren - vor allem anderen, damit ein sofortiges
        // Beenden der App den Versuch nicht "vergisst".
        try { await EncryptedStorage.setItem('pin_attempts', String(n)); } catch {}

        // Vollversion: Loeschen nach dem 5. Fehlversuch ist eine Pro-Funktion
        // (LicenseManager.failedPinPolicy). Ohne Pro bleibt es bei den
        // Sperrfristen (ab dem 5. Fehlversuch nach jedem weiteren 60 s) und
        // die Texte kuendigen keine Loeschung an. Pro wird hier frisch
        // geprueft (Signatur + Geraetebindung), nicht aus einem alten Stand.
        let proNow = false;
        try { proNow = await isProVerified(); } catch {}
        const policy = failedPinPolicy(n, proNow);
        if (policy.wipe) {
          setLocked(true);
          setErr(policy.message);
          await performWipe();
          setTimeout(() => onWipe?.(), 1000);
        } else if (policy.lockMs > 0) {
          const until = Date.now() + policy.lockMs;
          try { await EncryptedStorage.setItem('pin_locked_until', String(until)); } catch {}
          setLockedUntil(until);
          setErr(policy.message);
        } else {
          setErr(policy.message);
          setTimeout(() => setErr(''), 1500);
        }
      }
    }
  };

  // Sperrfrist läuft gegen einen absoluten Zeitstempel im verschlüsselten
  // Speicher. Dadurch bringt es nichts, die App während der Sperre zu
  // beenden - beim nächsten Start läuft die Restzeit einfach weiter.
  React.useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const rest = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (rest <= 0) {
        setLocked(false);
        setLockedUntil(0);
        setErr(lockExpiredMessage(att, pro));
        EncryptedStorage.removeItem('pin_locked_until').catch(() => {});
      } else {
        setLocked(true);
        // Sperrfristen koennen jetzt bis zu 24 h dauern (ansteigend) -
        // lesbar als h/min/s statt "86400s".
        const h = Math.floor(rest / 3600), m = Math.floor((rest % 3600) / 60), s = rest % 60;
        setErr(t('lock.lockedFor', { time: h ? t('time.hm', { h, m }) : m ? t('time.ms', { m, s }) : t('time.s', { s }) }));
      }
    };
    tick();
    // nicht "t": verdeckte sonst die Uebersetzungsfunktion t() in tick()
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [lockedUntil, att, pro]);

  const changePinLen = async (len) => {
    setPinLen(len);
    setPin('');
  };

  // Gewaehltes Design (abschaltbar, siehe Themes.getLockTheme: dann Standard-
  // Design, damit nichts auf die Vollversion/Notfall-PIN hinweist).
  const L = getLockTheme();
  return (
    <Animated.View style={[lk.screen, { opacity:fade }]}>
      <View style={[lk.logoWrap, { backgroundColor:L.surface, borderWidth:0.5, borderColor:L.border }]}>
        <BrandMark size={36} bg={L.surface} {...brandColors(L)} />
      </View>
      <Text style={lk.sub}>
        {step === 'setup'   ? t('lock.newPin') :
         step === 'confirm' ? t('lock.confirmPin') :
         t('lock.enterPin')}
      </Text>

      {/* PIN Länge wählen (nur im Setup). Das kleine "i" erklaert nur kurz
          den Unterschied - keine Empfehlung, kein Druck: 4 und 6 Stellen sind
          gleichwertige Wahlmoeglichkeiten (Vorgabe des Entwicklers). */}
      {step === 'setup' && (
        <View style={{ alignItems:'center', marginBottom:20 }}>
          <View style={{ flexDirection:'row', gap:8, alignItems:'center' }}>
            {[4,6].map(l => (
              <TouchableOpacity key={l} onPress={() => changePinLen(l)}
                style={{ paddingHorizontal:20, paddingVertical:8, borderRadius:20,
                  backgroundColor: pinLen===l ? L.accent : L.surface,
                  borderWidth:1, borderColor: pinLen===l ? L.accent : L.border }}>
                <Text style={{ fontSize:13, fontWeight:'500',
                  color: pinLen===l ? L.onAccent : L.textSub }}>{t('lock.digits', { n: l })}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity testID="pin-length-info" accessibilityRole="button" accessibilityLabel={t('lock.lengthInfoLabel')}
              onPress={() => setLenInfo(v => !v)} hitSlop={{ top:10, bottom:10, left:10, right:10 }} style={{ padding:4 }}>
              <Icon name="info" size={16} color={L.textMuted} />
            </TouchableOpacity>
          </View>
          {lenInfo ? (
            <Text testID="pin-length-info-text" style={{ fontSize:12, color:L.textMuted, textAlign:'center', lineHeight:17, marginTop:10, maxWidth:280 }}>
              {t('lock.lengthInfo')}
            </Text>
          ) : null}
        </View>
      )}

      {/* Punkte duerfen die erwartete PIN-Laenge NICHT vorab verraten.
          Vorher stand hier eine feste Reihe von pinLen Punkten, leer bis
          gefuellt - wer auf den Bildschirm sah, BEVOR getippt wurde, konnte
          abzaehlen, wie viele Ziffern der PIN hat. Genauso haette man beim
          Mitsehen erkannt, ob gerade der normale oder der (gleich lange,
          siehe PinChange.setDuress) Duress-PIN eingegeben wird, sobald die Laengen
          auseinanderliefen.

          Jetzt waechst die Reihe mit der Eingabe: ein Punkt pro bereits
          getippter Ziffer, keine Platzhalter fuer noch nicht getippte. Vor
          der ersten Ziffer ist die Reihe leer und sagt nichts aus. Die
          Container-Hoehe bleibt fest, damit das Layout nicht springt.

          Ausnahme Setup/Bestaetigen: dort waehlt der Nutzer die Laenge
          gerade selbst ueber die 4-/6-stellig-Schalter direkt darueber, sie
          steht also ohnehin sichtbar auf dem Schirm - hier sind die
          Platzhalter eine echte Eingabehilfe und verraten nichts, was nicht
          schon danebenstuende. */}
      <Animated.View style={[lk.dots, { minHeight:12, transform:[{ translateX:shake }] }]}>
        {step === 'enter'
          ? Array.from({ length:pin.length }).map((_,i) => (
              <View key={i} style={[lk.dot, { backgroundColor:L.accent, borderColor:L.accent }]} />
            ))
          : Array.from({ length:pinLen }).map((_,i) => (
              <View key={i} style={[lk.dot, { borderColor:L.border },
                i < pin.length && { backgroundColor:L.accent, borderColor:L.accent }]} />
            ))}
      </Animated.View>

      {err
        ? <Text style={lk.err}>{err}</Text>
        : <View style={{ height:28 }} />}

      {/* Ziffernblock auch bei Arabisch/Persisch (RTL) in Telefon-Reihenfolge 1-2-3 */}
      <View style={[lk.keypad, { direction:'ltr' }]}>
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k,i) => (
          <TouchableOpacity key={i} activeOpacity={0.6}
            style={[lk.key, { backgroundColor: k ? L.surface : 'transparent',
              borderColor:L.border, borderWidth: k ? 0.5 : 0 }]}
            onPress={() => k && tap(k)}>
            <Text style={[lk.keyTxt, { color: k==='⌫' ? L.textMuted : L.text }]}>{k}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Biometrie Button */}
      {hasBio && step === 'enter' && savedPin && !busy && (
        <TouchableOpacity onPress={tryBiometrics} style={{ marginTop:24, alignItems:'center', gap:6 }}>
          <Icon name="unlock" size={22} color={L.textMuted} />
          <Text style={{ fontSize:12, color:L.textMuted }}>{t('lock.useBiometrics')}</Text>
        </TouchableOpacity>
      )}

      <Text style={lk.footer}>Malachi ©</Text>
    </Animated.View>
  );
}

// Farben: Standard-Design (getLockTheme, siehe LockScreen), bei jedem
// Themen-/Akzentwechsel neu befuellt (themedStyles).
const lk = themedStyles(() => {
  const t = getLockTheme();
  return {
  screen:  { flex:1, alignItems:'center', justifyContent:'center', paddingHorizontal:40, backgroundColor:t.bg },
  logoWrap:{ width:60, height:60, borderRadius:16, alignItems:'center', justifyContent:'center', marginBottom:28 },
  sub:     { fontSize:13, color:t.textMuted, marginBottom:32 },
  dots:    { flexDirection:'row', gap:14, marginBottom:12 },
  dot:     { width:12, height:12, borderRadius:6, borderWidth:1.5, borderColor:t.border },
  // unveraendertes Standard-Design: '#C0392B' wie bisher; angepasst: kontrastgeprueft
  err:     { color: t.legacy ? '#C0392B' : t.danger, fontSize:13, fontWeight:'500', marginBottom:16 },
  keypad:  { flexDirection:'row', flexWrap:'wrap', width:252, gap:3 },
  key:     { width:82, height:60, borderRadius:14, alignItems:'center', justifyContent:'center' },
  keyTxt:  { fontSize:20 },
  footer:  { fontSize:11, color:t.textMuted, marginTop:28, letterSpacing:0.5 },
  };
});

// Malachi-Zeichen (wie das App-Icon, Logo D "Peer-to-Peer"): das M als
// Verbindungslinie zwischen vier Knoten, Verlauf Cyan -> Violett -> Cyan.
// Die Farben werden auf der Kopfleiste des Designs auf >= 3:1 gebracht
// (helle Kopfleisten: dunklere Toene), damit das Zeichen ueberall sichtbar ist.
// Farben des Zeichens zum Design (Nutzerwunsch: "farblich passend, ohne zu
// viel zu werden"): unveraendertes Standard-Design = Markenverlauf Cyan ->
// Violett; sonst Akzent des Designs mit einem ruhigeren Partner-Ton.
function brandColors(t) {
  if (!t || t.legacy) return { c1: '#36E0FF', c2: '#7C8CFF' };
  return { c1: t.accent, c2: mixColor(t.accent, t.text, 0.35) };
}
function BrandMark({ size = 22, bg, c1: base1 = '#36E0FF', c2: base2 = '#7C8CFF' }) {
  const c1 = bg ? ensureContrast(base1, bg, 3) : base1;
  const c2 = bg ? ensureContrast(base2, bg, 3) : base2;
  // Ausschnitt des Icons (Viewbox 108): M von x 33.66..74.34, y 34.2..66.6
  return (
    <Svg width={size} height={size} viewBox="28 28 52 44" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <SvgLinearGradient id="mbrand" x1="33.66" y1="0" x2="74.34" y2="0" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="0.5" stopColor={c2} />
          <Stop offset="1" stopColor={c1} />
        </SvgLinearGradient>
      </Defs>
      <Path d="M33.66,66.6V34.2L54,54L74.34,34.2V66.6" stroke="url(#mbrand)" strokeWidth={5.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx={33.66} cy={66.6} r={4.6} fill={c1} />
      <Circle cx={74.34} cy={66.6} r={4.6} fill={c1} />
      <Circle cx={33.66} cy={34.2} r={3.2} fill={c2} />
      <Circle cx={74.34} cy={34.2} r={3.2} fill={c2} />
    </Svg>
  );
}

// Zeitpunkt der letzten Aktivitaet kurz anzeigen: heute "14:32", sonst "18.10.".
function shortWhen(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? formatTime(d)
    : formatDate(d, { day:'2-digit', month:'2-digit' });
}
const HOME_FILTER_KEY = 'home_filter';

// Startseite: Chats und Gruppen in EINER Liste (Nutzerwunsch 2026-10-19),
// Filter Alle/Chats/Gruppen, angeheftete oben, sonst nach letzter Aktivitaet.
export function HomeScreen({ contacts, groups = [], onChat, onConnect, onSettings, onGroups, onOpenGroup, onGroupInfo, onCreateGroup, onPinContact, onPinGroup, avatar, username = '', onDelete, onClearChat, groupsUnread = 0 }) {
  // Ersetzt das vorherige Einzel-Loeschen nur ueber den (jetzt entfernten)
  // Chat-Header-Papierkorb: Gedruckthalten zeigt ein kleines Menue
  // (Auswaehlen/Loeschen), "Auswaehlen" schaltet Mehrfachauswahl frei
  // (weitere Chats antippen), "Loeschen" dort entfernt sofort nur den
  // gedrueckt gehaltenen - Design-Feedback, macht Platz im Chat-Header.
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState(() => new Set());
  const [menu, setMenu] = React.useState(null); // { id, x, y } | null
  // Kontaktsuche - ausdruecklich NUR lokal innerhalb der bereits gepaarten
  // Kontakte (reiner Client-seitiger Filter auf den vorhandenen Namen).
  // Bewusst KEINE Suche nach neuen/unbekannten Nutzern ueber den Relay -
  // das wuerde eine durchsuchbare Nutzerdatenbank auf dem Server voraussetzen
  // und widerspraeche dem Zero-Knowledge-Prinzip des Projekts.
  const [search, setSearch] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchInputRef = React.useRef(null);
  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };
  // Siegel direkt vom Startbildschirm (Nutzerwunsch 2026-10-25: kleiner Knopf
  // ueber dem "+"). Versiegeln braucht die Vollversion, Entsiegeln nicht -
  // dieselbe Regel wie in den Einstellungen.
  const [siegelOpen, setSiegelOpen] = React.useState(false);
  const [proOpen, setProOpen] = React.useState(false);
  const [isPro, setIsPro] = React.useState(getLicenseState().pro === true);
  React.useEffect(() => subscribeLicense((l) => setIsPro(l.pro === true)), []);
  const [filter, setFilterState] = React.useState('all');   // 'all' | 'chats' | 'groups'
  React.useEffect(() => {
    AsyncStorage.getItem(HOME_FILTER_KEY).then((v) => { if (v === 'chats' || v === 'groups' || v === 'all') setFilterState(v); }).catch(() => {});
  }, []);
  const setFilter = (v) => { setFilterState(v); AsyncStorage.setItem(HOME_FILTER_KEY, v).catch(() => {}); };
  // Eine Liste aus Chats und Gruppen: angeheftete zuerst, dann nach letzter
  // Aktivitaet (Chats: lastTs, Gruppen: lastTime); bei Gleichstand die
  // bisherige Reihenfolge (stabil).
  const rows = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (name) => !q || String(name || '').toLowerCase().includes(q);
    const out = [];
    if (filter !== 'groups') {
      for (const c of (contacts || CONTACTS)) {
        if (!match(c.name)) continue;
        out.push({ kind: 'chat', key: 'c_' + c.id, ts: Number.isFinite(c.lastTs) ? c.lastTs : 0, pinned: !!c.pinned, c });
      }
    }
    if (filter !== 'chats') {
      for (const g of (groups || [])) {
        if (!match(g.name)) continue;
        out.push({ kind: 'group', key: 'g_' + g.groupId, ts: g.lastTime || g.updatedAt || g.createdAt || 0, pinned: !!g.pinned, g });
      }
    }
    return out.map((r, i) => ({ ...r, i }))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.ts - a.ts) || (a.i - b.i));
  }, [contacts, groups, search, filter]);
  const chatsUnread = (contacts || []).reduce((n, c) => n + (c.wiped ? 0 : (c.unread || 0)), 0);

  // UI-Verbesserungen (fest eingebaut, siehe useUiDemo oben)
  const demoLiveStatus = useUiDemo('liveStatus');
  const demoContactDots = useUiDemo('contactDots');
  const demoEmptyState = useUiDemo('emptyState');
  const demoBigTargets = useUiDemo('bigTargets');
  const conn = useConnectivity(contacts, demoLiveStatus || demoContactDots);
  const allContacts = contacts || CONTACTS;
  const statusView = (() => {
    if (!demoLiveStatus) return { color: P.headerOnline, text: t('home.status.secured') };
    if (!conn.online) return { color: P.headerWarning, text: t('app.offlineNachrichtenWarten'), a11y: t('app.offlineNachrichtenWartenSicherAuf') };
    if (allContacts.length === 0) return { color: P.headerOnline, text: t('app.onlineVerschluesselt') };
    // Nutzer-Feedback 2026-09-29: es zaehlen die Chatpartner. Bestehende
    // Verbindungen laufen auch weiter, wenn Tor gerade neu startet.
    const n = conn.connected.length;
    if (n > 0) {
      const tor = conn.viaTor || 0;
      // Kompakt (Nutzerwunsch): "2/2" bzw. "2/2 · 1 Tor" - ausgeschrieben nur fuer Screenreader.
      const all = allContacts.length;
      if (tor === 0) return { color: P.headerSuccess, text: `${n}/${all}`, a11y: t('app.vonKontaktenDirektVerbunden', { n, all }) };
      return { color: P.headerSuccess, text: `${n}/${all} · ${tor} Tor`, a11y: t('app.vonKontaktenVerbundenUeberTor', { n, all, tor }) };
    }
    // Ohne Tor koennen sich die Geraete nicht (neu) finden - es gibt keinen
    // Server. Aus Nutzersicht: Nachrichten warten in der Warteschlange.
    if (conn.tor === 'STARTING') return { color: P.headerWarning, text: t('app.torStartet'), a11y: t('app.torStartetNachrichtenWartenSicher') };
    if (conn.tor !== 'ON') return { color: P.headerWarning, text: t('app.torGetrenntNachrichtenWarten'), a11y: t('app.torNichtVerbundenNachrichtenWarten') };
    return { color: P.headerSub, text: t('app.0Verbinde', { length: allContacts.length }), a11y: t('app.onlineVerbindeUeberTorMit') };
  })();

  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  // Zurueck-Taste: Auswahlmodus bzw. Suche schliessen statt die App zu verlassen.
  useBackHandler(selectMode, exitSelect);
  useBackHandler(searchOpen && !selectMode, () => { setSearch(''); setSearchOpen(false); });
  const toggleSelected = (id) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const confirmDeleteSelected = () => {
    const ids = [...selected];
    if (!ids.length) return;
    Alert.alert(
      ids.length === 1 ? t('home.deleteChat') : t('home.deleteChats', { count: ids.length }),
      t('home.deleteChats.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: () => { onDelete?.(ids); exitSelect(); } },
      ]
    );
  };

  return (
    <View style={{ flex:1, backgroundColor:P.bg }}>
      <View style={hm.header}>
        {selectMode ? (
          <>
            <TouchableOpacity onPress={exitSelect} style={{ padding:4 }}>
              <Icon name="x" size={22} color={P.headerText} />
            </TouchableOpacity>
            <Text style={{ fontSize:15, fontWeight:'500', color:P.headerText }}>{t('home.selected', { count: selected.size })}</Text>
            <TouchableOpacity onPress={confirmDeleteSelected} style={{ padding:4 }} disabled={!selected.size}>
              <Icon name="trash-2" size={20} color={selected.size ? P.headerDanger : P.headerMuted} />
            </TouchableOpacity>
          </>
        ) : searchOpen ? (
          <>
            <Icon name="search" size={16} color={P.headerMuted} />
            {/* Design-Feedback: keine gross umrandete Box mehr - eine schmale,
                randlose Zeile mit nur einer Unterstreichung, erscheint erst
                beim tatsaechlichen Antippen der Lupe (siehe unten). */}
            <TextInput
              ref={searchInputRef}
              value={search}
              onChangeText={setSearch}
              placeholder={t('app.chatsUndGruppenDurchsuchen')}
              placeholderTextColor={P.headerMuted}
              style={{ flex:1, marginLeft:10, paddingVertical:4, borderBottomWidth:1,
                borderBottomColor:P.headerBorder, fontSize:14, color:P.headerText }}
            />
            {/* Design-Feedback: Gruppen ausschliesslich ueber diesen Weg
                erreichbar/erstellbar - erscheint erst, sobald man die Suche
                oeffnet, bleibt reaktiv/aufgeraeumt; kein zweiter Einstieg
                mehr ueber den "+"-FAB. */}
            <TouchableOpacity onPress={() => { setSearch(''); setSearchOpen(false); onCreateGroup?.(); }} style={{ padding:4, marginLeft:2 }} accessibilityLabel={t('groups.new')}>
              <Icon name="users" size={18} color={P.headerIcon} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setSearch(''); setSearchOpen(false); }} style={{ padding:4, marginLeft:2 }}>
              <Icon name="x" size={18} color={P.headerMuted} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={{ flexShrink:1, flex:1 }}>
              <View style={{ flexDirection:'row', alignItems:'center' }}>
                <TouchableOpacity onPress={onSettings} style={{ marginRight:12 }} accessibilityLabel={t('app.einstellungenUndProfil')}>
                  {avatar
                    ? <Image source={{ uri:avatar }} style={{ width:34, height:34, borderRadius:17, backgroundColor:P.headerAvatarBg }} />
                    : <View style={{ width:34, height:34, borderRadius:17, backgroundColor:P.headerAvatarBg,
                        alignItems:'center', justifyContent:'center' }}>
                        <Text style={{ fontSize:13, fontWeight:'600', color:P.headerAvatarText }}>{username ? initialsOf(username) : 'M'}</Text>
                      </View>
                  }
                </TouchableOpacity>
                <View style={{ flexShrink:1 }}>
                  <View style={{ flexDirection:'row', alignItems:'center', gap:7 }}>
                    <BrandMark size={21} bg={P.headerBg} {...brandColors(P)} />
                    <Text accessibilityRole="header" style={[hm.title, { fontSize:21, fontWeight:'700', letterSpacing:0.6 }]}>Malachi</Text>
                  </View>
                  <View style={{ flexDirection:'row', alignItems:'center', gap:5, marginTop:2 }}>
                    <View style={{ width:6, height:6, borderRadius:3, backgroundColor:statusView.color }} />
                    <Text style={{ fontSize:11, color:statusView.color, flexShrink:1 }} numberOfLines={1}
                      accessibilityLabel={statusView.a11y || statusView.text}>{statusView.text}</Text>
                  </View>
                </View>
              </View>
              <View style={{ flexDirection:'row', gap:8, marginTop:12 }}>
                {[['all', t('home.tabAll'), chatsUnread + groupsUnread], ['chats', t('home.tabChats'), chatsUnread], ['groups', t('common.groups'), groupsUnread]].map(([k, label, n]) => {
                  const on = filter === k;
                  return (
                    <TouchableOpacity key={k} onPress={() => setFilter(k)} hitSlop={{ top:6, bottom:6, left:4, right:4 }}
                      accessibilityRole="button" accessibilityState={{ selected: on }}
                      style={{ paddingHorizontal:14, paddingVertical:5, borderRadius:14,
                        backgroundColor: on ? P.accent : 'transparent', borderWidth: on ? 0 : 1, borderColor:P.headerBorder }}>
                      <Text style={{ fontSize:12, fontWeight: on ? '600' : '500', color: on ? P.onAccent : P.headerSub }}>
                        {label}{n > 0 ? ' · ' + (n > 99 ? '99+' : n) : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={{ flexDirection:'row', alignItems:'center' }}>
              {((contacts || CONTACTS).length > 0 || (groups || []).length > 0) && (
                <TouchableOpacity onPress={openSearch} style={{ padding:8 }} hitSlop={DEMO_HIT} accessibilityLabel={t('app.suchen')}>
                  <Icon name="search" size={20} color={P.headerIcon} />
                </TouchableOpacity>
              )}
            </View>
          </>
        )}
      </View>

      {/* In-App-Update verfuegbar (UpdateUI.tsx) - ausblendbar, nur Web-Version. */}
      {!selectMode && !searchOpen && <UpdateBanner palette={P} accent={AC} />}

      <FlatList data={rows} keyExtractor={r => r.key}
        contentContainerStyle={{ paddingVertical:8, paddingBottom:150 }}
        // Im Filter "Gruppen": oben ein Eintrag zum Anlegen (das "+" unten fuehrt
        // immer zur Kopplung - Nutzerwunsch 2026-10-19).
        ListHeaderComponent={filter === 'groups' && !search && (groups || []).length > 0 ? (
          <TouchableOpacity onPress={onCreateGroup} activeOpacity={0.7} accessibilityLabel={t('groups.new')} style={hm.row}>
            <View style={{ width:44, height:44, borderRadius:22, backgroundColor:P.avatarBg, alignItems:'center', justifyContent:'center' }}>
              <Icon name="plus" size={20} color={P.avatarText} />
            </View>
            <Text style={[hm.name, { marginLeft:12, color:P.accentFg }]}>{t('groups.new')}</Text>
          </TouchableOpacity>
        ) : null}
        ListEmptyComponent={search ? (
          <Text style={{ textAlign:'center', color:P.textMuted, marginTop:32, fontSize:13 }}>
            {t('app.nichtsGefundenFuer', { search })}
          </Text>
        ) : filter === 'groups' ? (
          <View style={{ alignItems:'center', paddingHorizontal:32, paddingTop:48, gap:12 }}>
            <Icon name="users" size={32} color={P.accentFg} />
            <Text style={{ fontSize:16, fontWeight:'600', color:P.text, textAlign:'center' }}>{t('app.nochKeineGruppen')}</Text>
            <Text style={{ fontSize:13, color:P.textSub, textAlign:'center', lineHeight:19 }}>
              {t('app.gruppenLaufenOhneServerNachrichten')}
            </Text>
            <TouchableOpacity onPress={onCreateGroup} activeOpacity={0.85}
              style={{ marginTop:8, backgroundColor:P.accent, borderRadius:14, paddingVertical:12, paddingHorizontal:22 }}>
              <Text style={{ color:P.onAccent, fontSize:14, fontWeight:'600' }}>{t('groups.new')}</Text>
            </TouchableOpacity>
          </View>
        ) : demoEmptyState && filter === 'all' && !(groups || []).length ? (
          <View style={{ alignItems:'center', paddingHorizontal:32, paddingTop:48 }}>
            <View style={{ width:72, height:72, borderRadius:22, backgroundColor:P.surface, borderWidth:1,
              borderColor:P.border, alignItems:'center', justifyContent:'center', marginBottom:18 }}>
              <Icon name="shield" size={32} color={AC} />
            </View>
            <Text style={{ fontSize:18, fontWeight:'600', color:P.text, textAlign:'center' }}>{t('home.empty.title')}</Text>
            <Text style={{ fontSize:13, color:P.textSub, textAlign:'center', marginTop:8, lineHeight:19 }}>
              {t('home.empty.body')}
            </Text>
            <View style={{ alignSelf:'stretch', marginTop:22, gap:12 }}>
              {[
                ['1', t('home.empty.step1')],
                ['2', t('home.empty.step2')],
                ['3', t('home.empty.step3')],
              ].map(([n, t]) => (
                <View key={n} style={{ flexDirection:'row', alignItems:'center', gap:12 }}>
                  <View style={{ width:26, height:26, borderRadius:13, backgroundColor:P.greenBg, alignItems:'center', justifyContent:'center' }}>
                    <Text style={{ fontSize:12, fontWeight:'700', color:P.accentFg }}>{n}</Text>
                  </View>
                  <Text style={{ flex:1, fontSize:13, color:P.text }}>{t}</Text>
                </View>
              ))}
            </View>
            <TouchableOpacity onPress={onConnect} activeOpacity={0.85}
              style={{ marginTop:28, backgroundColor:AC, borderRadius:16, paddingVertical:15, alignSelf:'stretch', alignItems:'center' }}>
              <Text style={{ color:P.onAccent, fontSize:15, fontWeight:'600' }}>{t('home.empty.cta')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        renderItem={({ item: row }) => {
          if (row.kind === 'group') {
            const g = row.g;
            return (
              <TouchableOpacity
                style={[hm.row, selectMode && { opacity:0.45 }]}
                disabled={selectMode}
                onPress={() => onOpenGroup?.(g)}
                onLongPress={(e) => {
                  const { pageX, pageY } = e.nativeEvent;
                  setMenu({ kind: 'group', id: g.groupId, g, pinned: row.pinned, x: Math.min(pageX, 230), y: pageY });
                }}
                activeOpacity={0.7}>
                <GroupAvatar group={g} size={44} accent={AC} palette={P} />
                <View style={{ flex:1, marginLeft:12 }}>
                  <View style={{ flexDirection:'row', justifyContent:'space-between', marginBottom:4, gap:8 }}>
                    <View style={{ flexDirection:'row', alignItems:'center', gap:6, flexShrink:1 }}>
                      <Text style={hm.name} numberOfLines={1}>{g.name}</Text>
                      <Icon name={g.mode === 'channel' ? 'radio' : 'users'} size={12} color={P.textMuted} />
                    </View>
                    <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
                      {row.pinned && <Icon name="bookmark" size={12} color={P.textMuted} />}
                      <Text style={{ fontSize:11, color:P.textMuted }}>{shortWhen(g.lastTime)}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center' }}>
                    <Text style={{ fontSize:13, color: g.removed ? P.textMuted : P.textSub, flex:1 }} numberOfLines={1}>
                      {g.removed ? t('groupChat.noLongerMember') : (PinVault.previewText(g.last) || t('app.nochKeineNachrichten'))}
                    </Text>
                    {g.unread > 0 && (
                      <View style={[hm.badge, { backgroundColor:AC }]}>
                        <Text style={{ fontSize:11, color:P.onAccent, fontWeight:'600' }}>{g.unread > 99 ? '99+' : g.unread}</Text>
                      </View>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            );
          }
          const item = row.c;
          return (
          <TouchableOpacity
            style={[hm.row, (item.wiped || item.stale) && { opacity:0.55 }, selected.has(item.id) && { backgroundColor:P.surfaceAlt }]}
            onPress={() => selectMode ? toggleSelected(item.id) : onChat(item)}
            onLongPress={(e) => {
              if (selectMode) return;
              const { pageX, pageY } = e.nativeEvent;
              setMenu({ kind: 'chat', id: item.id, pinned: row.pinned, x: Math.min(pageX, 230), y: pageY });
            }}
            activeOpacity={0.7}>
            {selectMode && (
              <View style={{ marginRight:10 }}>
                <Icon name={selected.has(item.id) ? 'check-circle' : 'circle'}
                  size={22} color={selected.has(item.id) ? AC : P.border} />
              </View>
            )}
            <View>
              <Avatar c={item} size={44} />
              {demoContactDots && !item.wiped && conn.connected.includes(item.id) && (
                <View style={{ position:'absolute', right:-1, bottom:-1, width:14, height:14, borderRadius:7,
                  backgroundColor:P.success, borderWidth:2.5, borderColor:P.bg }} />
              )}
            </View>
            <View style={{ flex:1, marginLeft:12 }}>
              <View style={{ flexDirection:'row', justifyContent:'space-between', marginBottom:4, gap:8 }}>
                <Text style={[hm.name, { flexShrink:1 }]} numberOfLines={1}>{item.wiped ? t('home.wiped.name') : item.name}</Text>
                <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
                  {row.pinned && <Icon name="bookmark" size={12} color={P.textMuted} />}
                  <Text style={{ fontSize:11, color:P.textMuted }}>{Number.isFinite(item.lastTs) ? shortWhen(item.lastTs) : item.time}</Text>
                </View>
              </View>
              <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center' }}>
                <Text style={{ fontSize:13, color: item.wiped ? P.textMuted : item.stale ? P.warning : P.textSub, flex:1, fontStyle: item.wiped ? 'italic' : 'normal' }} numberOfLines={1}>
                  {item.wiped ? t('home.wiped.last') : item.stale ? t('home.stale') : PinVault.previewText(item.last)}
                </Text>
                {item.unread > 0 && !item.wiped && (
                  // Audit 2026-09-28: feste Breite 20 - ab dreistelligen
                  // Zahlen lief die Zahl aus dem Kreis heraus.
                  <View style={[hm.badge, { backgroundColor:AC }]}>
                    <Text style={{ fontSize:11, color:P.onAccent, fontWeight:'600' }}>{item.unread > 99 ? '99+' : item.unread}</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height:0.5, backgroundColor:P.border, marginLeft:68 }} />}
      />

      {/* Kleines Kontextmenue am Gedruckthalten-Punkt */}
      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <TouchableOpacity style={{ flex:1 }} activeOpacity={1} onPress={() => setMenu(null)}>
          {menu && (
            <View style={{ position:'absolute', ...(I18nManager.isRTL ? { right:menu.x } : { left:menu.x }), top:menu.y, backgroundColor:P.menuBg,
              borderRadius:12, borderWidth:0.5, borderColor:P.menuBorder, overflow:'hidden', minWidth:150,
              elevation:6, shadowColor:'#000', shadowOpacity:0.15, shadowRadius:8, shadowOffset:{width:0,height:2} }}>
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:8, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => {
                  const m = menu;
                  setMenu(null);
                  if (m.kind === 'group') onPinGroup?.(m.id, !m.pinned);
                  else onPinContact?.(m.id, !m.pinned);
                }}>
                <Icon name="bookmark" size={15} color={P.menuIcon} />
                <Text style={{ fontSize:13, color:P.menuText }}>{menu.pinned ? t('app.loesen') : t('app.anheften')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              {menu.kind === 'group' ? (
                <TouchableOpacity
                  style={{ flexDirection:'row', alignItems:'center', gap:8, paddingVertical:12, paddingHorizontal:14 }}
                  onPress={() => { const g = menu.g; setMenu(null); onGroupInfo?.(g); }}>
                  <Icon name="info" size={15} color={P.menuIcon} />
                  <Text style={{ fontSize:13, color:P.menuText }}>{t('app.gruppeninfo')}</Text>
                </TouchableOpacity>
              ) : (<>
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:8, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => { setSelectMode(true); setSelected(new Set([menu.id])); setMenu(null); }}>
                <Icon name="check-square" size={15} color={P.menuIcon} />
                <Text style={{ fontSize:13, color:P.menuText }}>{t('home.menu.select')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:8, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => {
                  const id = menu.id;
                  setMenu(null);
                  // Anders als "Löschen" unten: Kontakt/Pairing bleiben bestehen,
                  // nur die Nachrichten verschwinden auf BEIDEN Seiten (Nutzerwunsch).
                  Alert.alert(t('home.clearChat'), t('home.clearChat.body'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('home.clearChat.confirm'), style: 'destructive', onPress: () => onClearChat?.(id) },
                  ]);
                }}>
                <Icon name="x-circle" size={15} color={P.menuIcon} />
                <Text style={{ fontSize:13, color:P.menuText }}>{t('home.clearChat')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:8, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => {
                  const id = menu.id;
                  setMenu(null);
                  Alert.alert(t('home.deleteChat'), t('home.deleteChat.body'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('common.delete'), style: 'destructive', onPress: () => onDelete?.([id]) },
                  ]);
                }}>
                <Icon name="trash-2" size={15} color={P.menuDanger} />
                <Text style={{ fontSize:13, color:P.menuDanger }}>{t('common.delete')}</Text>
              </TouchableOpacity>
              </>)}
            </View>
          )}
        </TouchableOpacity>
      </Modal>

      {/* Design-Feedback: Gruppen lassen sich ausschliesslich ueber die
          Suchleiste erreichen/erstellen (siehe deren "+" oben) - der "+"-FAB
          hier ist wieder ein direkter Knopf zum Connect-Screen, kein
          Dropdown mehr. */}
      {!selectMode && (
        <TouchableOpacity testID="home-siegel" style={hm.fabMini} onPress={() => setSiegelOpen(true)} activeOpacity={0.85}
          accessibilityRole="button" accessibilityLabel={t('common.siegelMode')}>
          <Icon name="lock" size={18} color={AC} />
        </TouchableOpacity>
      )}
      {!selectMode && (
        <TouchableOpacity style={[hm.fab, { backgroundColor:AC }]} onPress={onConnect} activeOpacity={0.85}
          accessibilityLabel={t('app.kontaktVerbinden')}>
          <Text style={{ fontSize:28, color:P.onAccent, fontWeight:'300', marginTop:-2 }}>+</Text>
        </TouchableOpacity>
      )}
      <SiegelScreen visible={siegelOpen} onClose={() => setSiegelOpen(false)} canSeal={isPro} onOpenPro={() => setProOpen(true)} />
      <ProScreen visible={proOpen} onClose={() => setProOpen(false)} accent={AC} />
    </View>
  );
}

// Farben aus dem aktuellen Thema (themedStyles). header: Kopfleiste aller
// Bildschirme (Home, Gruppen, Chat, Kontaktinfo) - Hintergrund/Rand kommen
// jetzt von hier statt als Inline-Ueberschreibung mit P.surface.
const hm = themedStyles((t) => ({
  header: { flexDirection:'row', justifyContent:'space-between', alignItems:'center',
            paddingHorizontal:16, paddingTop:16, paddingBottom:12, borderBottomWidth:0.5,
            backgroundColor:t.headerBg, borderBottomColor:t.headerBorder },
  title:  { fontSize:22, fontWeight:'600', color:t.headerText },
  row:    { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingVertical:12 },
  name:   { fontSize:15, fontWeight:'500', color:t.text },
  badge:  { minWidth:20, height:20, borderRadius:10, paddingHorizontal:5, alignItems:'center', justifyContent:'center' },
  fab:    { position:'absolute', bottom:24, right:24, width:54, height:54, borderRadius:27,
            alignItems:'center', justifyContent:'center', elevation:4 },
  // Siegel-Knopf: klein, ueber dem "+" mittig ausgerichtet, als Nebenknopf
  // (Flaeche statt Akzent), damit "+" die Hauptaktion bleibt.
  fabMini: { position:'absolute', bottom:24 + 54 + 14, right:24 + 6, width:42, height:42, borderRadius:21,
             alignItems:'center', justifyContent:'center', elevation:3,
             backgroundColor:t.surface, borderWidth:0.5, borderColor:t.border },
}));

// Gruppenchats: Liste, "Neue Gruppe", Gruppeninfo und der Gruppenchat selbst
// stehen in GroupScreens.tsx/GroupChatScreen.tsx, Protokoll und Speicher in
// GroupMessaging.js (Fan-out ueber die 1:1-Kanaele, GROUP_CHAT_DESIGN.md).

// Statusanzeige eigener Nachrichten (Zustell-Garantie 2026-10): ⏳ wird
// gerade eingereiht, 🕐 wartet verschluesselt in der Warteschlange (noch
// nicht uebergeben), ✓ an einen offenen Kanal uebergeben, ✓✓ von der
// Gegenseite bestaetigt, ❌ nicht sendbar (kein Schluessel/Speicherfehler).
// Unbekannt/alt (kein Status gespeichert) zeigt ehrlich ✓ statt ✓✓ - vorher
// fiel z.B. ein Bild mit 'failed' auf ein falsches ✓✓ zurueck.
function sendStatusIcon(status) {
  switch (status) {
    case 'sending':   return '⏳';
    case 'pending':   return '🕐';
    case 'failed':    return '❌';
    case 'delivered': return '✓✓';
    case 'read':      return '✓✓✓';
    default:          return '✓';
  }
}

export function ChatScreen({ chat, messages, onBack, backInterceptRef, onCall, rtc, fontSize, customBg, onRename, onDelete, onRemoteDelete, onWipe, onLastMessage }) {
  // UI-Verbesserungen (fest eingebaut, siehe useUiDemo oben)
  const demoOfflineBanner = useUiDemo('offlineBanner');
  const demoCallMenu = useUiDemo('callMenu');
  const demoDarkChat = useUiDemo('darkChat');
  const demoBigTargets = useUiDemo('bigTargets');
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  const [reconnectKick, setReconnectKick] = useState(0);
  const [, rerender] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    if (!reconnectKick) return undefined;
    const t = setTimeout(rerender, 8100); // Knopf nach 8s wieder freigeben
    return () => clearTimeout(t);
  }, [reconnectKick]);
  const [text, setText]         = useState('');
  const [msgs, setMsgs]         = useState(messages || []);
  const [renaming, setRenaming]   = useState(false);
  // Buendelt Umbenennen/Timer/Loeschen, die vorher als einzelne Icons den
  // Header ueberladen haben (Design-Feedback) - erreichbar per Tap auf
  // Name/Status, das Schild-Icon daneben bleibt sein eigenes Tap-Ziel fuer
  // den Sicherheitscode.
  const [chatInfo, setChatInfo]   = useState(false);
  // Kontaktuebersicht (Nutzerwunsch, wie WhatsApp): Medien-Reiter + Bild-Vollansicht
  const insets = useSafeAreaInsets();
  const [infoTab, setInfoTab]     = useState('images');
  const [viewerImage, setViewerImage] = useState(null);
  const [newName, setNewName]     = useState('');
  const [timerModal, setTimer]      = useState(false);
  const [expireMode, setExpire]     = useState('off');
  const [secretModal, setSecretModal] = useState(false);
  const [secretActive, setSecretState] = useState(false);
  // Audit P1: synchron lesbar fuer die Empfangs-Listener - die werden einmal
  // je Chat registriert und saehen sonst nur secretActive vom ersten Rendern.
  const secretActiveRef = useRef(false);
  const setSecret = (v) => { secretActiveRef.current = !!v; setSecretState(!!v); };
  const [secretTimer, setSecretTimer] = useState(null); // 5/15/30/60
  const [secretCountdown, setCountdown] = useState(0);
  const [connected, setConn]    = useState(false);
  // Verbindungszustand DIESES Chats fuer die Kopfzeile: 'direct' | 'tor' |
  // 'reconnecting' (kurz nach einem Abbruch) | 'offline'.
  const [connStatus, setConnStatus] = useState('offline');
  const lastConnectedAt = useRef(0);
  const [recording, setRecording] = useState(false);
  // Pegel waehrend der Aufnahme (VoiceWave.js): fuer die Live-Anzeige und die
  // Wellenform, die verschluesselt mit der Sprachnachricht reist.
  const levelFeedRef = useRef(null);
  if (!levelFeedRef.current) levelFeedRef.current = createLevelFeed();
  // Wellenform-Stil (Einstellungen -> Design); der zweite Stil gehoert zur Vollversion.
  const [waveStyle, setWaveStyleState] = useState(() => effectiveWaveStyle(getLicenseState().pro === true));
  React.useEffect(() => {
    const update = () => setWaveStyleState(effectiveWaveStyle(getLicenseState().pro === true));
    const offStyle = subscribeWaveStyle(update);
    const offLicense = subscribeLicense(update);
    return () => { offStyle(); try { offLicense?.(); } catch {} };
  }, []);
  const [recordSecs, setRecordSecs] = useState(0);
  const [audioPreview, setAudioPreview] = useState(null); // {base64, durationMs, path}
  // Kontaktaenderung an die App melden - mit dem FRISCHEN Stand aus dem
  // Speicher (Rueckgabe von updateContacts) statt der veralteten chat-Prop der
  // Listener-Closure (siehe onRename in AppInner).
  const reportContact = (updatedList, patch) => {
    const fresh = Array.isArray(updatedList) ? updatedList.find(c => c.id === chat?.id) : null;
    onRename?.(fresh || { id: chat?.id, ...patch });
  };
  // Siegel-Fenster fuer diesen Chat: { msg } (Blase angetippt) bzw. { msg: null }
  // (zum Schreiben). siegelMode: Mikrofon-Knopf 1,5 s gehalten -> Schloss; nur
  // im RAM, beim Verlassen des Chats wieder Mikrofon (keine Spur).
  const [siegelMsg, setSiegelMsg] = useState(null);
  const [siegelMode, setSiegelMode] = useState(false);
  const [viewOnceAudio, setViewOnceAudio] = useState(false); // Nutzerwunsch: "Sprachnachrichten, die sich nach Anhören loeschen"
  const [callMode, setCallMode] = useState('audio'); // 'audio' | 'video' - siehe Anruf-Umschalter im Header
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewProgress, setPreviewProgress] = useState({ position: 0, duration: 0 });
  const [playingId, setPlayingId] = useState(null);
  // Fortschritt/Geschwindigkeit fuer die aktuell abspielende Sprachnachricht
  // (playerRef/playingId sind ohnehin schon global - EINE gemeinsame
  // Spieler-Instanz (SecureAudio.js) kann nur eine Wiedergabe gleichzeitig fahren,
  // siehe Kommentar bei playAudio). playbackSpeed bleibt bewusst ueber
  // mehrere Wiedergaben hinweg bestehen (einmal auf 1.5x gestellt, gilt das
  // fuer die naechste Sprachnachricht automatisch weiter - wie bei WhatsApp).
  const [playProgress, setPlayProgress] = useState({ position: 0, duration: 0 });
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [safetyVisible, setSafetyVisible] = useState(false);
  // Stabiler Sicherheitscode (SafetyNumber.js, Krypto-Review V1): haengt an
  // der Ratchet-Sitzung, nicht an der Verbindung. Fuer Gegenseiten 1.0/1.1 der
  // alte Verbindungscode (rtc.safetyCode) mit Hinweis.
  const [safety, refreshSafety] = useSafetyInfo(chat?.id, () => RTCStore.getConnection(chat?.id)?.safetyCode || null);
  const showSafety = hasSafetyDisplay(safety);
  const playerRef = useRef(null);
  // Audio-Fokus (AppFocus.js): startet Siegel eine Wiedergabe oder Aufnahme,
  // wird die des Chats hier sauber beendet (es gibt nur EINEN nativen Spieler).
  const stopChatAudio = async () => {
    // Nimmt Siegel auf/spielt ab, waehrend hier noch aufgenommen wird: die
    // Aufnahme wird zur Vorschau (nichts geht verloren, Mikrofon frei).
    if (recorderRef.current) await stopRecording();
    await voicePlayer.stop();
    playerRef.current = null;
    previewPlayerRef.current = null;
    setPlayingId(null);
    setPlayProgress({ position: 0, duration: 0 });
    setPreviewPlaying(false);
  };
  // (Frueher: Hinweis bei JEDER neuen Verbindung, weil der Code am
  // Verbindungsgeheimnis hing - Gewoehnung an Warnungen, Befund K-01. Der
  // Hinweis "geaendert" kommt jetzt nur bei einem echten Sitzungswechsel,
  // siehe SafetyNumber.getSafetyInfo.)
  const recordTimerRef = useRef(null);
  const recordStartRef = useRef(null);
  const previewPlayerRef = useRef(null);
  // Nur die Verbindung zu DIESEM Kontakt zaehlt. Vorher auch GLOBAL_RTC (die
  // zuletzt aufgebaute Verbindung irgendeines Kontakts) bzw. eine alte rtc-
  // Referenz - die Kopfzeile zeigte so "P2P verbunden", waehrend die App in
  // Wahrheit gerade neu verband (Live-Test 2026-10-19).
  const isConnected = connected;
  const ref                     = useRef(null);
  const msgsRef                 = useRef([]);
  // Audit G1 (MediaVault.js): Speicher-Reihenfolge, bereits abgelegte Medien
  // dieser Sitzung (id -> {mref, mk}), Aufraeum-Zustand.
  const saveChainRef            = useRef(Promise.resolve());
  const mediaRefsRef            = useRef(new Map());
  const historyLoadedRef        = useRef(false);
  const mediaSweptRef           = useRef(false);
  const expireModeRef           = useRef('off');
  const secretCountdownRef      = useRef(null);
  const storageKey              = 'chat_' + (chat?.id || 'default');
  // Live-Test-Fund 2026-09-27: "sent" (✓) bedeutet nur "an einen lokal
  // offenen DataChannel uebergeben", NICHT "beim Empfaenger angekommen" - ein
  // WebRTC dataChannel.send() wirft nicht, wenn der Peer laengst weg ist.
  // Seit der Zustell-Garantie (2026-10) laeuft JEDE ausgehende Nachricht ueber
  // die Warteschlange (sendViaOutbox, BackgroundSync.js): 🕐 eingereiht, ✓
  // uebergeben, ✓✓ erst mit der Empfangsbestaetigung der Gegenseite. Bleibt
  // sie aus, sendet die Warteschlange selbst erneut (vorher: 10-s-Timeout
  // pro Nachricht hier im ChatScreen). Statusmeldungen kommen als 'receipt'
  // ueber RTCStore an (siehe onMessage-Handler unten), ✓✓ wird nie wieder
  // zurueckgestuft (mergeSendStatus).
  const setMsgStatus            = (id, status) => {
    setMsgs(m => (m || []).map(x => x.id === id ? { ...x, status: mergeSendStatus(x.status, status) } : x));
  };
  // Secret Chat: noch nicht zugestellte Nachrichten verfallen mit dessen Ende.
  const ephemeralMeta           = () => (secretActive
    ? { ephemeral: true, expiresAt: Date.now() + Math.max(0, secretCountdown || 0) * 1000 }
    : {});

  // Secret Chat ist immer vor Screenshots geschuetzt - auch wenn sie in den
  // Einstellungen (Vollversion) erlaubt sind (ScreenSecurity.js).
  React.useEffect(() => {
    const tag = 'secret-chat:' + (chat?.id || '');
    forceScreenProtection(tag, !!secretActive);
    return () => forceScreenProtection(tag, false);
  }, [secretActive, chat?.id]);

  // Secret Chat Countdown
  React.useEffect(() => {
    if (!secretActive || secretCountdown <= 0) return;
    if (secretCountdown === 0) {
      // Zeit abgelaufen → alles löschen
      setMsgs([]);
      setSecret(false);
      setSecretTimer(null);
      return;
    }
    secretCountdownRef.current = setTimeout(() => {
      setCountdown(c => {
        if (c <= 1) {
          setSecret(false);
          setSecretTimer(null);
          AsyncStorage.removeItem('secret_' + chat?.id);
          // Noch nicht zugestellte Secret-Nachrichten verfallen mit.
          if (chat?.id) dropEphemeralFromQueue(chat.id).catch(() => {});
          // Kein removeItem(storageKey) mehr - siehe ausfuehrliche
          // Begruendung beim secret_end-Handler weiter unten (identischer
          // Datenverlust-Bug, hier fuer den lokalen Countdown-Ablauf statt
          // die vom Gegenueber empfangene secret_end-Nachricht). Aus dem
          // Speicher neu laden statt komplett leeren, damit die reguläre
          // Historie erhalten bleibt.
          AsyncStorage.getItem(storageKey).then((saved) => {
            let restored = [];
            if (saved) {
              try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) restored = parsed;
              } catch(e) {}
            }
            setMsgs([...restored, {
              id: Date.now().toString(),
              text: t('secret.ended'),
              mine: false, time: '', sys: true
            }]);
          });
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearTimeout(secretCountdownRef.current);
  }, [secretActive, secretCountdown]);

  // Eingehende Secret Chat Anfragen
  React.useEffect(() => {
    if (!chat?.id) return;
    // wird im Listener verarbeitet
  }, [chat?.id]);

  // Gepufferte Nachrichten laden wenn Chat öffnet
  React.useEffect(() => {
    if (!chat?.id) return;
  // Timer-Einstellung laden
    AsyncStorage.multiGet(['timer_' + chat.id, 'secret_' + chat.id, 'secret_ended_' + chat.id]).then(([[,timer],[,secret],[,secretEnded]]) => {
      if (timer) { setExpire(timer); expireModeRef.current = timer; }
      if (secretEnded === 'true') {
        // Secret Chat wurde vom anderen beendet. Secret-Chat-Nachrichten
        // wurden waehrend der Sitzung bewusst NIE unter storageKey
        // persistiert (siehe "Secret Chat Nachrichten nie speichern" beim
        // Speicher-Effekt weiter unten) - storageKey enthaelt an dieser
        // Stelle also bereits ausschliesslich die regulaeren Nachrichten
        // von VOR dem Secret Chat, unveraendert. Ein removeItem() hier war
        // ein echter Datenverlust-Bug (Live-Test entdeckt): loeschte diese
        // komplette reguläre Historie mit, nicht nur die (ohnehin nie
        // gespeicherten) Secret-Chat-Nachrichten. Der separate Lade-Effekt
        // weiter unten (AsyncStorage.getItem(storageKey)) stellt die
        // korrekten, unberuehrten regulaeren Nachrichten von selbst wieder
        // her - hier nur der Secret-Chat-State selbst zuruecksetzen.
        setMsgs([]);
        setSecret(false);
        setSecretTimer(null);
        setCountdown(0);
        AsyncStorage.removeItem('secret_ended_' + chat.id);
        return;
      }
      if (secret) {
        const s = JSON.parse(secret);
        const remaining = Math.floor((s.endsAt - Date.now()) / 1000);
        if (remaining > 0) {
          setSecret(true);
          setSecretTimer(s.mins);
          setCountdown(remaining);
        } else {
          // Vierte Fundstelle desselben Bugs (Live-Test entdeckt): lokal
          // bereits abgelaufener Secret-Chat-Timer beim Chat-Oeffnen -
          // kein removeItem(storageKey) mehr, siehe Begruendung oben.
          AsyncStorage.removeItem('secret_' + chat.id);
        }
      }
    });
    // takeBuffered statt getBuffered: wartet nach einem App-Neustart, bis die
    // verschluesselte Empfangs-Ablage (RTCStore.js) wiederhergestellt ist -
    // dort liegen Nachrichten, die bei geschlossenem Chat ankamen.
    setTimeout(() => RTCStore.takeBuffered(chat.id).then(async (buffered) => {
      if (buffered && buffered.length > 0) {
        console.log('[Chat] Gepufferte Nachrichten laden:', buffered.length);
        // Audit P1: Secret-Inhalte aus dem RAM-Puffer nur zeigen, solange der
        // Secret Chat noch laeuft (secret_start/-end wirken bei geschlossenem
        // Chat zentral, BackgroundSync.applyControlSignal) - und nie speichern.
        let secretLive = secretActiveRef.current;
        if (!secretLive) {
          try {
            const s = JSON.parse((await AsyncStorage.getItem('secret_' + chat.id)) || 'null');
            secretLive = !!s && Number(s.endsAt) > Date.now();
          } catch {}
        }
        let secretDropped = 0;
        const textMsgs = [];
        buffered.forEach(msg => {
          const isSecretContent = SECRET_CONTENT_TYPES.has(msg.type) && isEphemeral(msg);
          if (isSecretContent && !secretLive) { secretDropped++; return; }
          const countBefore = textMsgs.length;
          if (msg.type === 'system' && msg.subtype === 'secret_start') secretLive = true;
          if (msg.type === 'system' && msg.subtype === 'secret_end') {
            secretLive = false;
            for (let i = textMsgs.length - 1; i >= 0; i--) if (textMsgs[i].secret) textMsgs.splice(i, 1);
          }

          // Receipt
          if (msg.type === 'receipt' && msg.msgId) {
            setMsgStatus(msg.msgId, msg.status);

          // Chat löschen
          } else if (msg.type === 'system' && msg.subtype === 'delete_chat') {
            // Von der Gegenseite geloescht: nur lokal entfernen
            // (onRemoteDelete) - onDelete schickte einen Loesch-Hinweis zurueck.
            if (chat?.id) onRemoteDelete?.(chat.id);

          // Chat leeren (Kontakt/Pairing bleiben bestehen, siehe
          // clearChatMessages() - nur die Nachrichten verschwinden).
          // textMsgs auf leer zuruecksetzen statt nur EncryptedStorage zu
          // loeschen: alles, was in DIESEM Puffer-Batch VOR dem clear_chat
          // lag, soll nicht doch noch angezeigt werden, sobald der Batch
          // gleich unten in setMsgs uebernommen wird.
          } else if (msg.type === 'system' && msg.subtype === 'clear_chat') {
            textMsgs.length = 0;
            PinVault.removeItem('chat_' + chat.id).catch(() => {});
            removeMediaScope(chat.id).catch(() => {});

          // Einzelne Nachricht loeschen (fuer beide Seiten, analog zu
          // delete_chat/clear_chat) - kann sowohl den gerade in DIESEM
          // Puffer-Batch aufgebauten textMsgs treffen (Original und Loeschung
          // kamen im selben Batch an) als auch eine bereits persistierte
          // Nachricht (setMsgs unten filtert den aktuellen/geladenen Stand).
          } else if (msg.type === 'system' && msg.subtype === 'delete_message' && msg.msgId) {
            const idx = textMsgs.findIndex(t => t.id === msg.msgId);
            if (idx !== -1) textMsgs.splice(idx, 1);
            forgetMedia(msg.msgId);
            setMsgs(m => (m || []).filter(x => x.id !== msg.msgId));

          // Gegenueber hat sein Geraet zurueckgesetzt (Rot-Team-Review Fund 2 -
          // fehlte bisher in BEIDEN ChatScreen-Nachrichtenpfaden komplett,
          // obwohl checkIncoming's Relay-Fallback-Pfad es schon behandelte).
          } else if (msg.type === 'system' && msg.subtype === 'device_wiped') {
            if (chat?.id) onWipe?.(chat.id);

          // Secret Chat starten
          } else if (msg.type === 'system' && msg.subtype === 'secret_start' && msg.mins) {
            const remaining = msg.endsAt ? Math.floor((msg.endsAt - Date.now()) / 1000) : msg.mins * 60;
            if (remaining > 0) {
              setSecret(true);
              setSecretTimer(msg.mins);
              setCountdown(remaining);
              AsyncStorage.setItem('secret_' + chat.id, JSON.stringify({
                mins: msg.mins, endsAt: msg.endsAt || Date.now() + msg.mins * 60 * 1000
              }));
              setMsgs(m => [...m, {
                id: Date.now().toString(),
                text: t('secret.started', { count: msg.mins }),
                mine: false, time: '', sys: true
              }]);
            }

          // Secret Chat beenden
          } else if (msg.type === 'system' && msg.subtype === 'secret_end') {
            setSecret(false);
            setSecretTimer(null);
            setCountdown(0);
            clearTimeout(secretCountdownRef.current);
            AsyncStorage.removeItem('secret_' + chat?.id);
            // War hier derselbe Datenverlust-Bug wie im "Chat oeffnen"-Effekt
            // weiter oben (Live-Test entdeckt): removeItem(storageKey)
            // loeschte die komplette reguläre (VOR dem Secret Chat
            // gespeicherte) Historie mit, obendrein ersetzte setMsgs([...])
            // den kompletten In-Memory-State durch nur die "beendet"-
            // Systemmeldung. storageKey enthaelt an dieser Stelle weiterhin
            // ausschliesslich die unveraenderten regulaeren Nachrichten
            // (Secret-Chat-Nachrichten wurden nie dorthin geschrieben) -
            // aus dem Speicher neu laden statt loeschen/ersetzen, damit die
            // regulaere Historie im Blick bleibt, nur die Secret-Chat-
            // Nachrichten dieser Sitzung verschwinden (by design, nie
            // persistiert).
            AsyncStorage.getItem(storageKey).then((saved) => {
              let restored = [];
              if (saved) {
                try {
                  const parsed = JSON.parse(saved);
                  if (Array.isArray(parsed)) restored = parsed;
                } catch(e) {}
              }
              setMsgs([...restored, {
                id: Date.now().toString(),
                text: t('secret.ended'),
                mine: false, time: '', sys: true
              }]);
            });

          // Avatar
          } else if (msg.type === 'system' && msg.subtype === 'profile_avatar_received') {
            // Ueber updateContacts serialisiert (Konkurrenz-Review §5).
            updateContacts(cs => cs.map(c => c.id === chat.id ? { ...c, theirAvatar: msg.avatarUri } : c))
              .then((u) => {
                reportContact(u, { theirAvatar: msg.avatarUri });
                console.log('[Profile] ✅ Avatar aus Puffer gesetzt');
              })
              .catch(() => {});
          } else if (msg.type === 'system' && msg.subtype === 'profile_avatar_removed') {
            updateContacts(cs => cs.map(c => c.id === chat.id ? { ...c, theirAvatar: null } : c))
              .then((u) => {
                reportContact(u, { theirAvatar: null });
                console.log('[Profile] Avatar entfernt');
              })
              .catch(() => {});
          } else if (msg.type === 'system' && msg.subtype === 'profile_name') {
        updateContacts(cs => {
              const contact = cs.find(c => c.id === chat.id);
              if (!contact || contact.nameEdited) return null;
              return cs.map(c => c.id === chat.id ? { ...c, name: msg.name, theirName: msg.name } : c);
            })
              .then(updated => { if (updated) reportContact(updated, { name: msg.name }); })
              .catch(() => {});
          } else if (msg.type === 'audio_complete') {
            // id = msgId des Absenders (Zustell-Garantie): eine erneut
            // zugestellte Kopie faellt dann in der Dedup unten heraus.
            textMsgs.push({
              id:         msg.msgId || msg.audioId,
              type:       'audio',
              base64:     msg.base64,
              durationMs: msg.durationMs,
              viewOnce:   !!msg.viewOnce,
              wave:       sanitizeWave(msg.wave),
              mine:       false,
              time:       formatTime(),
              sys:        false,
            });
          } else if (msg.type === 'image_complete') {
            textMsgs.push({
              id:     msg.msgId || msg.imageId,
              type:   'image',
              base64: `data:${msg.mimeType};base64,${msg.base64}`,
              mine:   false,
              time:   formatTime(),
              sys:    false,
            });
          } else if (msg.type === 'file_complete') {
            textMsgs.push({
              id: msg.msgId || msg.fileId, type: 'file', base64: msg.base64,
              fileName: msg.fileName, mimeType: msg.mimeType, size: msg.size,
              mine: false,
              time: formatTime(),
              sys: false,
            });
          } else if (msg.type === 'text') {
            const pufMode = msg.expireMode || expireModeRef.current;
            const expireAtPuf = expireModeToExpireAt(pufMode);
            textMsgs.push({
              id:       msg.msgId || Date.now().toString() + Math.random(),
              text:     msg.text,
              mine:     false,
              time:     formatTime(msg.time),
              sys:      false,
              expireAt: expireAtPuf,
              isLocation: !!msg.isLocation, lat: msg.lat, lng: msg.lng, address: msg.address,
            });
            // Empfangsbestaetigung: sendet RTCStore zentral, sobald die
            // Nachricht dauerhaft abgelegt war (nicht erst beim Oeffnen).
          }
          if (isSecretContent && textMsgs.length > countBefore) textMsgs[textMsgs.length - 1].secret = true;
        });
        if (secretDropped) console.log('[Chat] Abgelaufene Secret-Inhalte verworfen:', secretDropped);
        // Dedup nach id (= msgId, wo vorhanden) - relay-fallback Nachrichten
        // koennen seit dem Client-Ack-Mechanismus (relay.js /packet) erneut
        // zugestellt werden, wenn der Ack nach erfolgreicher Verarbeitung
        // verloren geht (Chaos-Testing-Fund: RTCStore-Puffer hatte bisher gar
        // kein Dedup, ein solcher Fall haette die Nachricht sichtbar doppelt
        // angezeigt). Greift nur bei echter id-Kollision - der Zufalls-Fallback
        // fuer Nachrichten ohne msgId kollidiert praktisch nie versehentlich.
        if (textMsgs.length > 0) {
          setMsgs(m => {
            const existing = new Set((m || []).map(x => x.id));
            const deduped = [];
            for (const t of textMsgs) {
              if (existing.has(t.id)) continue;
              existing.add(t.id);
              deduped.push(t);
            }
            return deduped.length > 0 ? [...(m||[]), ...deduped] : (m || []);
          });
        }
      }
    }).catch((e) => console.warn('[Chat] Gepufferte Nachrichten konnten nicht geladen werden:', e?.message || e)), 500);
  }, [chat?.id]);

  React.useEffect(() => {
    if (!chat?.id) return;
    // RTCStore Listener setzen
    RTCStore.setMessageListener(chat.id, (msg) => {
      console.log('[Chat] Nachricht via RTCStore:', msg.type);
      if (msg.type === 'text') {
        // Nachricht parsen falls JSON
        let parsedMsg = msg;
        if (typeof msg.text === 'string' && msg.text.startsWith('{')) {
          try { parsedMsg = JSON.parse(msg.text); } catch {}
        }
        const incomingMode = parsedMsg.expireMode || expireModeRef.current;
        const expireAtIncoming = expireModeToExpireAt(incomingMode);
        // Timer auch lokal speichern wenn noch nicht gesetzt
        if (incomingMode !== 'off' && expireModeRef.current === 'off') {
          setExpire(incomingMode);
          expireModeRef.current = incomingMode;
          AsyncStorage.setItem('timer_' + chat.id, incomingMode);
        }

        setMsgs(m => {
          const id = parsedMsg.msgId || Date.now().toString();
          if (parsedMsg.msgId && (m || []).some(x => x.id === id)) return m || [];
          return [...(m||[]), {
            id, text: parsedMsg.text, mine: false,
            time: formatTime(),
            sys: false, expireAt: expireAtIncoming,
            isLocation: !!parsedMsg.isLocation, lat: parsedMsg.lat, lng: parsedMsg.lng, address: parsedMsg.address,
            // Audit P1: Secret-Inhalt bleibt nur im RAM (Speicher-Effekt filtert).
            secret: (parsedMsg.secret || secretActiveRef.current) ? true : undefined,
          }];
        });
        // Secret-Chat-Nachrichten duerfen nicht in die (nicht Secret-Chat-
        // bewusste) Kontaktlisten-Vorschau lecken - die blieb bisher auch
        // NACH Beendigung des Secret Chats sichtbar stehen, bis irgendeine
        // reguläre Nachricht sie ueberschrieb (Live-Test entdeckt, gleicher
        // Themenkomplex wie die removeItem(storageKey)-Funde oben).
        // parsedMsg.secret zusaetzlich zu secretActive geprueft - robust
        // gegen den Fall, dass diese Seite secretActive noch nicht gesetzt
        // hat (z.B. secret_start selbst noch unterwegs), die Nachricht aber
        // bereits als secret markiert eintrifft.
        // Timer-Nachricht: neutraler Hinweis statt Inhalt - die Vorschau
        // ueberdauert die Nachricht (siehe timerPreview in RTCStore.js).
        if (!secretActiveRef.current && !parsedMsg.secret) onLastMessage?.(chat.id, timerPreview(incomingMode) || (parsedMsg.isLocation ? t('preview.location') : parsedMsg.text));
        // Empfangsbestaetigung: sendet RTCStore zentral (auch bei
        // geschlossenem Chat), Wiederholungen verwirft RTCStore vorher.
      } else if (msg.type === 'receipt' && msg.msgId) {
        // 🕐/✓ aus der eigenen Warteschlange, ✓✓ von der Gegenseite - nie
        // von ✓✓ zurueck auf ✓ (mergeSendStatus).
        setMsgStatus(msg.msgId, msg.status);
      } else if (msg.type === 'system' && msg.subtype === 'handshake') {
        // Gebündeltes Handshake-Paket
        console.log('[Handshake] Empfangen - hasAvatar:', msg.hasAvatar, 'ready:', msg.ready);   // ohne Namen (Audit P5)
        // Ueber updateContacts serialisiert (Konkurrenz-Review §5).
        updateContacts(cs => {
          const contact = cs.find(c => c.id === chat.id);
          if (!contact || contact.nameEdited) return null;
          return cs.map(c => c.id === chat.id ? { ...c, name: msg.name, theirName: msg.name } : c);
        })
          .then(updated => { if (updated) reportContact(updated, { name: msg.name, theirName: msg.name }); })
          .catch(() => {});
        // Ready → Queue starten
        if (msg.ready) {
          console.log('[Handshake] Ready → Queue starten');
          // Queue wird via _onReady auf Sender-Seite gestartet
        }
      } else if (msg.type === 'system' && msg.subtype === 'profile_name') {
        // Legacy Support
        updateContacts(cs => {
          const contact = cs.find(c => c.id === chat.id);
          if (!contact || contact.nameEdited) return null;
          return cs.map(c => c.id === chat.id ? { ...c, name: msg.name, theirName: msg.name } : c);
        })
          .then(updated => {
            if (updated) {
              reportContact(updated, { name: msg.name, theirName: msg.name });
              console.log('[Profile] Name gesetzt');   // ohne Namen (Audit P5)
            }
          })
          .catch(() => {});
      } else if (msg.type === 'system' && msg.subtype === 'profile_avatar_received') {
        updateContacts(cs => cs.map(c => c.id === chat.id ? { ...c, theirAvatar: msg.avatarUri } : c))
          .then((u) => {
            reportContact(u, { theirAvatar: msg.avatarUri });
            console.log('[Profile] ✅ Avatar gesetzt');
          })
          .catch(() => {});
      } else if (msg.type === 'system' && msg.subtype === 'delete_chat') {
        // Gegenueber hat den Chat geloescht, waehrend dieser Chat offen ist
        // (fehlte hier bisher - kam nur ueber den Relay-Parallelversand an).
        if (chat?.id) onRemoteDelete?.(chat.id);
      } else if (msg.type === 'system' && msg.subtype === 'device_wiped') {
        // Gegenueber hat sein Geraet zurueckgesetzt, waehrend eine LIVE P2P-
        // Verbindung offen war (Rot-Team-Review Fund 2 - fehlte bisher hier
        // komplett, nur der Relay-Fallback-Pfad in checkIncoming behandelte
        // das). onWipe() macht dasselbe Tombstoning wie dort.
        if (chat?.id) onWipe?.(chat.id);
      } else if (msg.type === 'system' && msg.subtype === 'secret_end') {
        setSecret(false);
        setSecretTimer(null);
        setCountdown(0);
        clearTimeout(secretCountdownRef.current);
        AsyncStorage.removeItem('secret_' + chat?.id);
        // Dritte, unabhaengige Fundstelle desselben Datenverlust-Bugs (Live-
        // Test entdeckt) - siehe ausfuehrliche Begruendung bei der
        // checkIncoming/Puffer-Variante weiter oben. Aus dem Speicher neu
        // laden statt komplett leeren.
        setTimeout(() => {
          AsyncStorage.getItem(storageKey).then((saved) => {
            let restored = [];
            if (saved) {
              try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) restored = parsed;
              } catch(e) {}
            }
            setMsgs([...restored, {
              id: Date.now().toString(),
              text: t('secret.ended'),
              mine: false, time: '', sys: true
            }]);
          });
        }, 100);
      } else if (msg.type === 'system' && msg.subtype === 'clear_chat') {
        // Chat vom Gegenueber geleert, live waehrend der Chat offen ist -
        // Kontakt/Pairing/Secret bleiben unangetastet (siehe
        // clearChatMessages()), nur die Nachrichten verschwinden.
        PinVault.removeItem('chat_' + chat?.id).catch(() => {});
        if (chat?.id) removeMediaScope(chat.id).catch(() => {});
        setMsgs([]);
        onLastMessage?.(chat?.id, '');
      } else if (msg.type === 'system' && msg.subtype === 'delete_message' && msg.msgId) {
        // Einzelne Nachricht vom Gegenueber geloescht, live waehrend der Chat
        // offen ist - siehe identischer Fund/Begruendung im Puffer-Pfad oben.
        forgetMedia(msg.msgId);
        setMsgs(m => (m || []).filter(x => x.id !== msg.msgId));
      } else if (msg.type === 'system' && msg.subtype === 'secret_start' && msg.mins) {
        // Gegenüber hat Secret Chat gestartet
        const remaining = msg.endsAt ? Math.floor((msg.endsAt - Date.now()) / 1000) : msg.mins * 60;
        setSecret(true);
        setSecretTimer(msg.mins);
        setCountdown(remaining > 0 ? remaining : 0);
        AsyncStorage.setItem('secret_' + chat.id, JSON.stringify({
          mins: msg.mins, endsAt: msg.endsAt || Date.now() + msg.mins * 60 * 1000
        }));
        setMsgs(m => [...m, {
          id: Date.now().toString(), text: t('secret.started', { count: msg.mins }),
          mine: false, time: '', sys: true
        }]);
      } else if (msg.type === 'audio_complete' || msg.type === 'image_complete' || msg.type === 'file_complete') {
        // Zustell-Garantie 2026-10: RTCStore setzt Medien jetzt IMMER selbst
        // zusammen (auch bei offenem Chat - vorher reichte es hier die rohen
        // Chunks durch, die dieser Bildschirm per processAudioChunk/
        // processImageChunk/processFileChunk zusammensetzte) und bestaetigt
        // erst danach den Empfang. id = msgId des Absenders (falls vorhanden),
        // damit eine erneut zugestellte Kopie nie doppelt erscheint.
        const time = formatTime();
        let entry, preview;
        if (msg.type === 'audio_complete') {
          entry = {
            id:         msg.msgId || msg.audioId,
            type:       'audio',
            base64:     msg.base64,
            durationMs: msg.durationMs,
            viewOnce:   !!msg.viewOnce,
            wave:       sanitizeWave(msg.wave),
            mine:       false, time, sys: false,
          };
          // Live-Test-Fund 2026-09-28: Kontaktlisten-Vorschau zeigte bei einer
          // eingehenden Sprachnachricht weiterhin die letzte TEXT-Nachricht an.
          // Gleicher Vorschautext wie im Hintergrund-Pfad (RTCStore.js).
          preview = t('preview.voice');
        } else if (msg.type === 'image_complete') {
          entry = {
            id:     msg.msgId || msg.imageId,
            type:   'image',
            base64: `data:${msg.mimeType};base64,${msg.base64}`,
            mine:   false, time, sys: false,
          };
          preview = t('preview.image');
        } else {
          entry = {
            id: msg.msgId || msg.fileId, type: 'file', base64: msg.base64,
            fileName: msg.fileName, mimeType: msg.mimeType, size: msg.size,
            mine: false, time, sys: false,
          };
          preview = '📎 ' + (msg.fileName || t('common.file'));
        }
        if (msg.secret || secretActiveRef.current) entry.secret = true;   // Audit P1: nur RAM
        setMsgs(m => ((m || []).some(x => x.id === entry.id) ? (m || []) : [...(m || []), entry]));
        if (!entry.secret) onLastMessage?.(chat?.id, preview);
      } else if (msg.type === 'system' && msg.subtype === 'timer') {
        // Timer-Einstellung vom Gegenüber übernehmen (bei geschlossenem Chat:
        // BackgroundSync.applyControlSignal). Juengere Aenderung gewinnt.
        adoptPeerTimer(chat.id, msg).then((mode) => {
          if (!mode) return;
          console.log('[Timer] Gegenüber hat Timer gesetzt:', mode);
          setExpire(mode);
          expireModeRef.current = mode;
        }).catch(() => {});
      } else if (msg.type === 'system' && msg.subtype === 'hello' && msg.myId) {
        // myId des Kontakts speichern für Auto-Reconnect
        // Ueber updateContacts serialisiert (Konkurrenz-Review §5).
        updateContacts(cs => cs.map(c => c.id === chat.id ? {...c, theirMyId: msg.myId} : c))
          .then(() => { console.log('[Chat] theirMyId gespeichert:', msg.myId); })
          .catch(() => {});
      }
    });

    // Verbindungsstatus prüfen
    const interval = setInterval(() => {
      const conn = RTCStore.isConnected(chat.id);
      setConn(conn);
      if (conn) lastConnectedAt.current = Date.now();
      const tr = conn ? RTCStore.connections.get(chat.id)?.transport : null;
      setConnStatus(conn ? (tr === 'tor' ? 'tor' : 'direct')
        : (Date.now() - lastConnectedAt.current < RECONNECT_STATUS_MS ? 'reconnecting' : 'offline'));
    }, 500);

    return () => {
      clearInterval(interval);
      // Listener entfernen – Nachrichten werden ab jetzt gepuffert
      RTCStore.setMessageListener(chat.id, null);
      // Read-Once Nachrichten beim Verlassen löschen
      if (expireModeRef.current === 'read') {
        setMsgs(m => m.filter(msg => msg.mine));
      }
    };
  }, [chat?.id]);

  React.useEffect(() => {
    historyLoadedRef.current = false;
    mediaSweptRef.current = false;
    mediaRefsRef.current = new Map();
    // historyLoadedRef wird IM State-Update gesetzt, das den geladenen Verlauf
    // einmischt: Jeder Stand ab diesem Render enthaelt ihn. Erst dann darf der
    // Verlauf gespeichert und aufgeraeumt werden (persistChatHistory) - vorher
    // ueberschrieb ein frueher Stand (neue Nachrichten beim Oeffnen) den
    // Verlauf, und das Aufraeumen loeschte die Dateien aelterer Medien.
    const applyHistory = (valid) => setMsgs(prev => {
      historyLoadedRef.current = true;
      const ids = new Set(valid.map(x => x.id));
      // Immer ein neues Array: loest das Speichern aus, auch ohne alten Verlauf.
      return [...valid, ...(prev || []).filter(x => !ids.has(x.id))];
    });
    AsyncStorage.getItem(storageKey).then((saved) => {
      let valid = [];
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const now = Date.now();
            valid = parsed.filter(m => {
              if (!m.expireAt) return true;
              if (m.expireAt === 'read') return false;
              return m.expireAt > now;
            });
            console.log('[Chat] Nachrichten geladen:', parsed.length, '→ gültig:', valid.length);
          }
        } catch(e) {}
      }
      // Zusammenfuehren statt ersetzen: dauert das Lesen eines grossen
      // Verlaufs laenger als das Abholen des Empfangspuffers (oben),
      // ueberschrieb setMsgs(valid) die schon uebernommenen - und aus
      // der Empfangs-Ablage bereits entfernten - Nachrichten.
      applyHistory(valid);
    }).catch((e) => {
      // PIN-Tresor gesperrt bzw. Verlauf nicht lesbar: NICHT als leer
      // uebernehmen - sonst ueberschriebe das naechste Speichern den echten
      // Verlauf (persistChatHistory speichert ohne geladenen Verlauf nie).
      if (PinVault.isVaultError(e)) { console.warn('[Chat] Verlauf nicht lesbar:', e?.code); return; }
      applyHistory([]);
    });
  }, [chat?.id]);

  React.useEffect(() => {
    msgsRef.current = msgs;
    if (msgs && msgs.length > 0) {
      // Secret Chat Nachrichten nie speichern
      if (secretActive) return;
      const now = Date.now();
      const toSave = msgs.filter(m => {
        if (m.secret) return false;   // Audit P1: Secret Chat nie speichern
        if (!m.expireAt) return true;
        if (m.expireAt === 'read') return false;
        return m.expireAt > now;
      });
      // Audit G1: Medien als eigene verschluesselte Dateien (MediaVault.js),
      // im Verlauf nur Verweis + Schluessel. Nacheinander, damit ein
      // aelterer Stand nie einen neueren ueberschreibt.
      const scope = chat?.id;
      const key = storageKey;
      // Enthaelt DIESER Stand den geladenen Verlauf? Nur dann speichern und -
      // einmal je Oeffnen - Dateien ohne Verweis (geloeschte/abgelaufene
      // Nachrichten) entfernen (Fehler 2026-10-25, siehe persistChatHistory).
      const historyIncluded = historyLoadedRef.current;
      saveChainRef.current = saveChainRef.current.then(async () => {
        const sweep = historyIncluded && !mediaSweptRef.current;
        if (sweep) mediaSweptRef.current = true;
        const res = await persistChatHistory({
          storage: AsyncStorage, key, scope, entries: toSave, known: mediaRefsRef.current, historyIncluded, sweep,
        });
        if (res.swept) console.log('[Medien] Verwaiste Dateien entfernt:', res.swept);
      }).catch((e) => console.warn('[Chat] Verlauf speichern fehlgeschlagen:', e?.message || e));
    }
  }, [msgs]);

  const recorderRef = useRef(null);
  // Aufnahme fortsetzen (Nutzerwunsch 29.10.2026): der bisherige Teil der
  // Vorschau, an den der naechste Abschnitt angehaengt wird - nur im
  // Arbeitsspeicher wie die Aufnahme selbst (SecureAudio.appendAdtsBase64).
  const appendBaseRef = useRef(null);
  // Laenger als die native Obergrenze (30 min) wird eine Sprachnachricht nicht.
  const MAX_VOICE_MS = 29 * 60 * 1000;

  const startRecording = async (base = null) => {
    try {
      await claimAudio('chat', stopChatAudio);
      // Permission anfragen
      const { PermissionsAndroid } = require('react-native');
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        { title: t('common.microphone'), message: t('perm.mic.message'), buttonPositive: 'OK' }
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        console.warn('[Audio] Mikrofon-Permission verweigert');
        return;
      }
      // Pegel alle 100 ms (Wellenform). Aufnahme nur im Arbeitsspeicher
      // (SecureAudio.js) - es entsteht keine Audiodatei mehr. Beim Fortsetzen
      // laeuft die Wellenform mit dem bisherigen Teil weiter.
      if (base?.levels) levelFeedRef.current.load(base.levels);
      else levelFeedRef.current.clear();
      await voicePlayer.startRecording((db) => levelFeedRef.current?.push(db));
      appendBaseRef.current = base;
      recorderRef.current = true;
      setRecording(true);
      const baseMs = base?.durationMs || 0;
      setRecordSecs(Math.floor(baseMs / 1000));
      recordStartRef.current = Date.now();
      recordTimerRef.current = setInterval(() => {
        const total = baseMs + Date.now() - recordStartRef.current;
        setRecordSecs(Math.floor(total / 1000));
        if (total >= MAX_VOICE_MS) stopRecording();
      }, 500);
      console.log('[Audio] Aufnahme gestartet');
      return true;
    } catch(e) {
      console.error('[Audio] Start Fehler:', e);
      return false;
    }
  };

  // Vorschau -> weiter aufnehmen: der neue Abschnitt wird beim Stoppen an
  // den bisherigen angehaengt (Vorschau mit allem, Senden schickt alles).
  const resumeRecording = async () => {
    const base = audioPreview;
    if (!base || recording || !canAppendRecording(base.base64) || base.durationMs >= MAX_VOICE_MS) return;
    if (previewPlayerRef.current) { voicePlayer.stop(); previewPlayerRef.current = null; }
    setPreviewPlaying(false);
    setPreviewProgress({ position: 0, duration: 0 });
    setAudioPreview(null);
    const ok = await startRecording(base);
    if (!ok) setAudioPreview(base);   // Mikrofon nicht verfuegbar: Vorschau bleibt
  };

  // Extrahiert aus dem frueheren stopRecording() - jetzt von beiden
  // Aufnahme-Wegen (Vorschau UND Halten-Sofortversand) gemeinsam genutzt.
  const stopRecorderRaw = async () => {
    clearInterval(recordTimerRef.current);
    const elapsed = Date.now() - recordStartRef.current;
    recorderRef.current = null;
    const base = appendBaseRef.current;
    appendBaseRef.current = null;
    let rec;
    try {
      rec = await voicePlayer.stopRecording();
    } finally {
      setRecording(false);
      setRecordSecs(0);
    }
    let base64 = rec.base64;
    let durationMs = rec.durationMs || elapsed;
    // Fortgesetzt: bisherigen Teil + neuen Abschnitt verbinden. Ist der neue
    // Abschnitt leer (sofort wieder gestoppt), bleibt der bisherige.
    if (base) {
      const joined = base64 ? appendAdtsBase64(base.base64, base64) : null;
      if (joined) { base64 = joined; durationMs = base.durationMs + durationMs; }
      else { base64 = base.base64; durationMs = base.durationMs; }
    }
    const levels = levelFeedRef.current.samples();
    const wave = encodeWave(levels) || undefined;
    levelFeedRef.current.clear();
    console.log('[Audio] Aufnahme gestoppt');
    return { base64, durationMs, wave, levels };
  };

  const stopRecording = async () => {
    try {
      const { base64, durationMs, wave, levels } = await stopRecorderRaw();
      if (!base64) return;
      // Preview anzeigen statt direkt senden. id: Saat der Ersatz-
      // Wellenform und Kennung der laufenden Vorschau-Wiedergabe; levels:
      // Pegel fuer ein spaeteres Fortsetzen.
      setAudioPreview({ base64, durationMs, wave, levels, id: 'rec_' + Date.now() });
    } catch(e) {
      console.error('[Audio] Stop Fehler:', e);
      setRecording(false);
    }
  };

  // Nutzerwunsch: "mit Möglichkeit zum sofort senden ohne nochmals in die
  // Vorschau zu kommen" - Gegenstueck zu stopRecording() oben, aber ohne
  // Vorschau-Zwischenschritt. Wird vom regulaeren Senden-Knopf aufgerufen,
  // waehrend eine Aufnahme laeuft (siehe dessen onPress weiter unten). Kein
  // View-Once hier (der Toggle lebt in der Vorschau-Leiste, die dieser Weg
  // bewusst ueberspringt) - wer View-Once braucht, nutzt den Mikrofon-Tap-
  // zum-Stoppen-Weg (stopRecording()) stattdessen.
  const stopRecordingAndSendNow = async () => {
    try {
      const { base64, durationMs, wave } = await stopRecorderRaw();
      // Zu kurze/versehentliche Aufnahmen (z.B. Wackler beim Loslassen) nicht
      // als leere Sprachnachricht verschicken.
      if (durationMs < 300 || !base64) return;
      // Aus einer fortgesetzten Vorschau: dort gewaehltes "loescht sich nach
      // Anhoeren" gilt weiter.
      const viewOnce = viewOnceAudio;
      setViewOnceAudio(false);
      await sendAudioNow(base64, durationMs, viewOnce, wave);
    } catch (e) {
      console.error('[Audio] Sofortversand-Stop Fehler:', e);
      setRecording(false);
    }
  };

  // Gemeinsamer Sendepfad fuer beide Aufnahme-Wege (Tippen+Vorschau ODER
  // Halten+Sofortversand) - extrahiert, damit stopRecordingAndSendNow() unten
  // nicht die komplette P2P/Warteschlange-Logik dupliziert.
  const sendAudioNow = async (base64, durationMs, viewOnce, wave) => {
    const msgId = Date.now().toString();
    // Eine rohe Aufnahme-Datei gibt es nicht mehr (SecureAudio.js) - der
    // Inhalt liegt nur als base64 im Speicher und wird ab hier verschluesselt
    // gesendet/zwischengespeichert (Secrets-Lifecycle-Review, Fund S-5).
    // Fehler 2026-10-25: die eigene Sprachnachricht stand ohne Inhalt im
    // Verlauf - sie wurde nie (verschluesselt) abgelegt und war weder
    // abspielbar noch nach einem Neustart da. Jetzt wie bei Bildern/Dateien:
    // Inhalt im Eintrag, beim Speichern als verschluesselte Datei (MediaVault).
    setMsgs(m => [...(m||[]), {
      id: msgId, type: 'audio', mine: true, base64,
      durationMs, status: 'sending', viewOnce, secret: secretActive || undefined,
      wave: sanitizeWave(wave),
      time: formatTime(),
      sys: false,
    }]);
    // Zustell-Garantie (Outbox-Prinzip, BackgroundSync.js): ZUERST
    // verschluesselt in die Warteschlange (🕐), dann - falls verbunden -
    // sofort gesendet (✓); entfernt erst mit der Empfangsbestaetigung (✓✓).
    // Reisst die Verbindung mitten im Transfer ab, geht die Sprachnachricht
    // bei der naechsten Verbindung komplett neu raus. Nie ueber den Relay.
    // Chatliste: wie beim Empfang nur "Sprachnachricht" (bzw. der neutrale
    // Timer-Hinweis) - vorher blieb dort die vorherige Nachricht stehen.
    if (!secretActive) onLastMessage?.(chat?.id, timerPreview(expireModeRef.current) || t('preview.voice'));
    await sendViaOutbox(chat?.id, 'audio', { base64, durationMs, viewOnce, wave: sanitizeWave(wave) }, msgId, {
      ...ephemeralMeta(),
      onQueued: (ok) => setMsgStatus(msgId, ok ? 'pending' : 'failed'),
    });
  };

  const sendAudioPreview = async () => {
    if (!audioPreview) return;
    const { base64, durationMs, wave } = audioPreview;
    const viewOnce = viewOnceAudio;
    if (previewPlayerRef.current) { voicePlayer.stop(); previewPlayerRef.current = null; setPreviewPlaying(false); }
    setAudioPreview(null);
    setViewOnceAudio(false);
    await sendAudioNow(base64, durationMs, viewOnce, wave);
  };

  const playPreview = async () => {
    if (!audioPreview) return;
    try {
      await claimAudio('chat', stopChatAudio);
      // Immer zuerst eine evtl. noch laufende Wiedergabe (Vorschau ODER
      // eine empfangene Nachricht, siehe playAudio()) beenden - EINE
      // gemeinsame Spieler-Instanz (SecureAudio.js) kann nur eine Wiedergabe
      // gleichzeitig fahren. Erneutes Antippen waehrend die Vorschau bereits
      // laeuft: nur stoppen (Toggle), nicht von vorn neu starten.
      const wasAlreadyPlayingThis = previewPlayerRef.current === audioPreview.id && previewPlaying;
      await voicePlayer.stop();
      playerRef.current = null;
      setPlayingId(null);
      if (wasAlreadyPlayingThis) {
        previewPlayerRef.current = null;
        setPreviewPlaying(false);
        return;
      }
      const previewId = audioPreview.id;
      previewPlayerRef.current = previewId;
      setPreviewPlaying(true);
      // Aus dem Arbeitsspeicher (SecureAudio.js) - keine Datei.
      await voicePlayer.play(audioPreview.base64, (e) => {
        if (previewPlayerRef.current !== previewId) return;
        if (e.finished) {
          setPreviewPlaying(false);
          setPreviewProgress({ position: 0, duration: 0 });
          previewPlayerRef.current = null;
        } else {
          setPreviewProgress({ position: e.position, duration: e.duration });
        }
      });
    } catch(e) {
      console.error('[Audio] Play Fehler:', e);
      setPreviewPlaying(false);
    }
  };

  // Wellenform der Vorschau angetippt: an diese Stelle springen (startet die
  // Wiedergabe, falls sie noch nicht laeuft).
  const seekPreview = async (fraction) => {
    if (!audioPreview) return;
    const f = Math.max(0, Math.min(1, fraction));
    if (!previewPlaying) {
      await playPreview();
      if (f < 0.02 || !audioPreview.durationMs) return;
    }
    const total = previewProgress.duration || audioPreview.durationMs || 0;
    if (!total) return;
    await voicePlayer.seek(f * total);
    setPreviewProgress((p) => ({ ...p, position: f * total }));
  };

  // Design-Feedback: kein Halten-Gestik mehr fuers Mikrofon (Halten ist jetzt
  // dem Anruf-Modus-Umschalter vorbehalten) - einfaches Tippen startet/stoppt
  // die Aufnahme wie urspruenglich, stoppen zeigt weiterhin die Vorschau-
  // Leiste (inkl. View-Once-Option). Der Sofortversand ohne Vorschau bleibt
  // erhalten, aber ueber den regulaeren Senden-Knopf ausgeloest, siehe dessen
  // onPress weiter unten (ruft waehrend einer laufenden Aufnahme
  // stopRecordingAndSendNow() statt send() auf).
  const toggleRecording = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  // Vorschau verwerfen: es gibt keine Datei (SecureAudio.js) - Wiedergabe
  // beenden, der Inhalt verlaesst mit dem State den Speicher.
  const discardPreview = () => {
    if (previewPlayerRef.current) { voicePlayer.stop(); previewPlayerRef.current = null; }
    setPreviewPlaying(false);
    setPreviewProgress({ position: 0, duration: 0 });
    setAudioPreview(null);
    setViewOnceAudio(false);
  };

  // Zurueck-Taste (BackStack.js): laufende Aufnahme -> Vorschau (nichts geht
  // verloren); Vorschau -> verwerfen wie der Papierkorb. Erst danach verlaesst
  // Zurueck den Chat.
  useBackHandler(recording, () => { stopRecording(); });
  useBackHandler(!!audioPreview && !recording, discardPreview);

  // Chat verlassen (Zurueck, Sperre, Anruf) waehrend einer Aufnahme: Mikrofon
  // sofort frei, Aufnahme verworfen. Vorher lief sie im Hintergrund weiter -
  // das Mikrofon blieb an, und die naechste Aufnahme scheiterte ("laeuft
  // bereits").
  React.useEffect(() => () => {
    clearInterval(recordTimerRef.current);
    appendBaseRef.current = null;
    if (recorderRef.current) {
      recorderRef.current = null;
      voicePlayer.cancelRecording().catch(() => {});
    }
    if (previewPlayerRef.current) { previewPlayerRef.current = null; voicePlayer.stop().catch(() => {}); }
    if (!playerRef.current) releaseAudio('chat');
  }, []);

  // Datei oeffnen/teilen - genutzt vom Chatverlauf und der Kontaktuebersicht.
  const openFileItem = async (item) => {
    // Audit P8: Secret-Chat-Inhalte verlassen die App nicht (kein Klartext im
    // Cache, keine fremde App mit Zugriff).
    if (secretActive || item?.secret) {
      Alert.alert('Secret Chat', t('app.dateienAusDemSecretChat'));
      return;
    }
    try {
      // Base64 ist bereits im Speicher (Chunk-Zusammensetzung/lokale
      // Auswahl) - fuer den nativen Teilen/Oeffnen-Dialog muss sie
      // trotzdem kurz als echte Datei im Cache landen. RNs
      // eingebautes Share.share() unterstuetzt auf Android KEINE
      // Datei-Anhaenge (nur reiner Text, "url" wird dort ignoriert,
      // siehe ShareModule.kt) - deshalb FileShareModule.kt, das
      // per FileProvider ein content://-URI erzeugt (ein rohes
      // file://-URI wirft ab Android 7 eine
      // FileUriExposedException) und einen echten
      // ACTION_SEND-Anhang-Intent startet.
      const safeName = (item.fileName || 'Datei').replace(/[\\/:*?"<>|]/g, '_');
      // Audit 2026-09-28: die ENTSCHLUESSELTE Datei lag bisher als
      // "<zeit>_<name>" dauerhaft im Cache - ausserhalb jedes Wipes
      // (performWipe raeumt nur play_*/malachi_* weg), also auch
      // nach Duress-/5-Fehlversuche-Wipe im Klartext lesbar. Jetzt mit
      // malachi_share_-Praefix (vom Wipe erfasst) und beim naechsten
      // App-Start automatisch entfernt (cleanupSharedFileCache).
      const fileData = await mediaData(chat?.id, item);   // Audit G1: RAM oder Ablage
      if (!fileData) throw new Error('Datei nicht mehr verfügbar');
      const path = `${RNFS.CachesDirectoryPath}/malachi_share_${Date.now()}_${safeName}`;
      await RNFS.writeFile(path, fileData, 'base64');
      await NativeModules.FileShareModule.shareFile(path, item.mimeType || 'application/octet-stream', item.fileName || t('common.file'));
    } catch (e) {
      console.error('[File] Öffnen/Teilen fehlgeschlagen:', e?.message || e);
      Alert.alert(t('common.file'), t('chat.openFileFailed'));
    }
  };

  const playAudio = async (item, startMs = 0) => {
    try {
      await claimAudio('chat', stopChatAudio);
      // Aktuell spielendes stoppen - es gibt nur EINEN Spieler (siehe auch
      // playPreview()). Erneutes Antippen der laufenden Nachricht: stoppen.
      if (playerRef.current || previewPlayerRef.current) {
        const wasPlaying = playerRef.current;
        await voicePlayer.stop();
        playerRef.current = null;
        previewPlayerRef.current = null;
        setPreviewPlaying(false);
        if (wasPlaying === item.id && playingId === item.id) {
          setPlayingId(null);
          setPlayProgress({ position: 0, duration: 0 });
          return;
        }
      }
      setPlayingId(item.id);
      setPlayProgress({ position: startMs, duration: item.durationMs || 0 });
      const audioData = await mediaData(chat?.id, item);   // Audit G1: RAM oder Ablage
      if (!audioData) throw new Error('Sprachnachricht nicht mehr verfügbar');
      playerRef.current = item.id;
      // Wiedergabe aus dem Arbeitsspeicher (SecureAudio.js): die
      // entschluesselte Sprachnachricht wird nicht mehr als Datei abgelegt.
      // Die gewaehlte Geschwindigkeit gilt gleich ab dem Start.
      await voicePlayer.play(audioData, (e) => {
        if (playerRef.current !== item.id) return;
        if (e.finished) {
          setPlayingId(null);
          setPlayProgress({ position: 0, duration: 0 });
          playerRef.current = null;
          // Nutzerwunsch: "Sprachnachrichten, die sich nach Anhören löschen".
          // Nur fuer empfangene (nicht die eigene) Nachricht und nur nach
          // vollstaendigem Anhoeren - deleteMessage() loescht auf BEIDEN Seiten.
          if (item.viewOnce && !item.mine && !e.error) deleteMessage(item.id);
        } else {
          setPlayProgress({ position: e.position, duration: e.duration });
        }
      }, { startMs, speed: playbackSpeed });
    } catch(e) {
      console.error('[Audio] Play Fehler:', e);
      setPlayingId(null);
      setPlayProgress({ position: 0, duration: 0 });
      playerRef.current = null;
    }
  };

  // Tippen auf die Wellenform einer Sprachnachricht springt an diese Stelle.
  // fractionX kommt aus dem Touch-Handler (0 = Anfang, 1 = Ende).
  const seekAudio = async (item, fractionX) => {
    const f = Math.max(0, Math.min(1, fractionX));
    if (playingId !== item.id) {
      // Wellenform einer gerade nicht laufenden Nachricht angetippt: an dieser
      // Stelle starten (wie bei anderen Messengern).
      const start = item.durationMs && f >= 0.02 ? f * item.durationMs : 0;
      await playAudio(item, start);
      return;
    }
    if (!playProgress.duration) return;
    const target = f * playProgress.duration;
    await voicePlayer.seek(target);
    setPlayProgress(p => ({ ...p, position: target }));
  };

  const PLAYBACK_SPEEDS = [1, 1.5, 2];
  const cyclePlaybackSpeed = async () => {
    const next = PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(playbackSpeed) + 1) % PLAYBACK_SPEEDS.length];
    setPlaybackSpeed(next);
    // Nur anwendbar, waehrend tatsaechlich etwas abspielt (siehe playAudio) -
    // sonst gilt sie einfach erst beim naechsten Start.
    if (playingId) await voicePlayer.setSpeed(next);
  };

  const pickAndSendImage = async () => {
    try {
      const result = await launchImageLibrary({ mediaType: 'photo', includeBase64: true, quality: 0.7 });
      if (result.didCancel || !result.assets?.[0]) return;
      const asset    = result.assets[0];
      const base64   = asset.base64;
      const mimeType = asset.type || 'image/jpeg';
      const msgId    = Date.now().toString();

      // Vorschau sofort anzeigen
      setMsgs(m => [...(m||[]), {
        id:       msgId,
        type:     'image',
        secret:   secretActive || undefined,
        base64:   `data:${mimeType};base64,${base64}`,
        mine:     true,
        time:     formatTime(),
        sys:      false,
        status:   'sending',
      }]);

      // Verschlüsselt senden - immer ueber die Warteschlange (write-ahead,
      // siehe sendAudioNow/BackgroundSync.sendViaOutbox). Nachrichteninhalte
      // - auch Bild/Audio - beruehren nie den Relay (Nutzer-Vorgabe); ohne
      // Shared Secret (Pairing nie abgeschlossen) gibt es keinen sicheren Weg
      // -> 'failed'.
      if (!secretActive) onLastMessage?.(chat?.id, timerPreview(expireModeRef.current) || t('preview.image'));
      await sendViaOutbox(chat?.id, 'image', { base64, mimeType }, msgId, {
        ...ephemeralMeta(),
        onQueued: (ok) => setMsgStatus(msgId, ok ? 'pending' : 'failed'),
      });
    } catch(e) {
      console.error('[Image] Fehler:', e);
    }
  };

  // Nutzerwunsch: beliebige Dateien versenden (nicht nur Bild/Audio) - reiht
  // sich als vierter Anhangstyp in dieselbe verschluesselte Chunk-Pipeline ein
  // (FileCrypto.js, identisches Muster zu ImageCrypto.js), P2P live oder
  // lokale Warteschlange bei fehlender Verbindung, exakt wie beim Bild oben.
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB - Base64 landet komplett im RAM, siehe FileCrypto.js
  const pickAndSendFile = async () => {
    try {
      const { pick: rawPick, isErrorWithCode, errorCodes } = await import('@react-native-documents/picker');
      const pick = (opts) => withAutoLockSuspended(() => rawPick(opts));
      const [picked] = await pick({ type: ['*/*'] });
      if (!picked) return;
      const fileName = picked.name || 'Datei';
      const mimeType = picked.type || 'application/octet-stream';
      if (Number.isFinite(picked.size) && picked.size > MAX_FILE_BYTES) {
        Alert.alert(t('chat.fileTooBig.title'), t('chat.fileTooBig.body', { mb: Math.floor(MAX_FILE_BYTES / 1024 / 1024) }));
        return;
      }
      const base64 = await RNFS.readFile(picked.uri, 'base64');
      await sendFileNow(base64, fileName, mimeType, picked.size);
    } catch (e) {
      const { isErrorWithCode, errorCodes } = await import('@react-native-documents/picker');
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return; // Nutzer hat abgebrochen
      console.error('[File] Fehler:', e?.message || e);
      Alert.alert(t('common.file'), t('chat.sendFileFailed'));
    }
  };

  // Eigentlicher Datei-Versand - auch fuer Siegel-Anhaenge aus dem
  // Siegel-Fenster (SiegelScreen onSendFile: nur die verschluesselte
  // "siegel-<zufall>.sgl"-Datei, nie Klartext).
  const sendFileNow = async (base64, fileName, mimeType, size = null) => {
    const bytes = Number.isFinite(size) ? size
      : Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    const msgId = Date.now().toString();
    setMsgs(m => [...(m||[]), {
      id: msgId, type: 'file', base64, fileName, mimeType, size: bytes, secret: secretActive || undefined,
      mine: true, time: formatTime(), sys: false, status: 'sending',
    }]);
    if (!secretActive) onLastMessage?.(chat?.id, '📎 ' + fileName);

    // Siehe identische Begruendung beim Bild-Versand oben - immer ueber die
    // Warteschlange (write-ahead), nie Relay-Versand des Inhalts.
    await sendViaOutbox(chat?.id, 'file', { base64, fileName, mimeType, size: bytes }, msgId, {
      ...ephemeralMeta(),
      onQueued: (ok) => setMsgStatus(msgId, ok ? 'pending' : 'failed'),
    });
  };

  const send = () => {
    if (!text.trim()) return;
    const msgText = text.trim();
    setText('');
    sendTextNow(msgText);
  };

  // Eigentlicher Versand einer Textnachricht - auch fuer Siegel-Antworten aus
  // dem Siegel-Fenster (SiegelScreen onSendCipher: nur Geheimtext).
  const sendTextNow = (msgText) => {
    const msgId   = Date.now().toString();
    const msgTime = formatTime();
    const expireAt = expireModeToExpireAt(expireModeRef.current);

    setMsgs(m => [...(m || []), {
      id:     msgId,
      text:   msgText,
      mine:   true,
      time:   msgTime,
      sys:    false,
      status: 'sending',
      expireAt,
      secret: secretActive || undefined,
    }]);
    // Siehe identische Begruendung beim eingehenden Text-Handler oben -
    // gilt symmetrisch fuer selbst gesendete Nachrichten waehrend eines
    // aktiven Secret Chats. Mit Timer nie der Inhalt (timerPreview).
    if (!secretActive) onLastMessage?.(chat?.id, timerPreview(expireModeRef.current) || msgText);
    setTimeout(() => ref.current?.scrollToEnd({ animated:true }), 100);

    // Zustell-Garantie (Outbox-Prinzip, BackgroundSync.js): ZUERST
    // verschluesselt in die lokale Warteschlange (🕐), dann - falls verbunden
    // - sofort ueber den Kanal (✓). Entfernt wird die Nachricht erst, wenn die
    // Gegenseite den Empfang bestaetigt (✓✓); bis dahin sendet die
    // Warteschlange bei jeder neuen Verbindung und nach Ablauf der Wartezeit
    // erneut (die Gegenseite verwirft Wiederholungen). Vorher: Live-Versand
    // am Speicher vorbei, 10-s-Timeout, erst dann einreihen - ein toter, noch
    // "offener" Kanal (Netzwechsel) oder ein App-Ende in diesem Fenster
    // verlor die Nachricht.
    // Nachrichteninhalte duerfen NIE ueber den Relay-Server laufen (explizite
    // Nutzer-Vorgabe) - nur P2P bzw. Tor, sonst wartet sie verschluesselt.
    sendViaOutbox(chat?.id, 'text', {
      type: 'text', text: msgText, time: Date.now(), msgId,
      expireMode: expireModeRef.current,
      // secretActive ist reiner React-State in ChatScreen - existiert
      // nicht mehr, sobald der Chat geschlossen ist. Ohne dieses Flag auf
      // der Nachricht selbst kann weder die Gegenseite (falls IHR Chat
      // gerade nicht offen ist, RTCStore.js-Hintergrundpuffer) noch diese
      // Seite bei einem spaeteren Reload wissen, dass diese Nachricht zu
      // einer Secret-Chat-Sitzung gehoerte (Live-Test entdeckt - die
      // Kontaktlisten-Vorschau leckte Secret-Chat-Text, wenn der Chat der
      // Gegenseite beim Empfang nicht offen war).
      secret: secretActive || undefined,
    }, msgId, {
      ...ephemeralMeta(),
      onQueued: (ok) => setMsgStatus(msgId, ok ? 'pending' : 'failed'),
    });
  };

  // Nutzerwunsch: "Möglichkeit seinen Standort verschlüsselt ohne Google zu
  // versenden". Reitet bewusst auf der bereits bestehenden, getesteten
  // Text-Nachrichten-Pipeline mit (P2P live + verschlüsselter Relay-Fallback
  // ueber queueOffline, gleiche drei-Wege-Zustellung wie send() oben) statt
  // eigener Chunk-/Crypto-Logik - isLocation/lat/lng reiten als zusaetzliche
  // Felder auf dem 'text'-Umschlag mit, genau wie expireMode/secret. GPS
  // selbst laeuft ueber @react-native-community/geolocation, das auf Android
  // standardmaessig das plattformeigene LocationManager-API nutzt statt
  // Google Play Services FusedLocationProviderClient (siehe setRNConfiguration
  // weiter unten im Datei-Setup) - kein Google-Dienst sieht den Standort.
  // Ortsnamen (STUN-Ausstieg, Entscheidung E5): bis 1.1.0 fragte der Absender
  // im Verbindungsweg "Schnell" einmal OpenStreetMap-Nominatim nach einem
  // Ortsnamen - die einzige Stelle, an der Standortdaten (auf ~100 m
  // gerundet) zusammen mit der IP-Adresse an einen Dritten gingen. Diese
  // Rueckwaertssuche gibt es nicht mehr: gesendet werden nur die Koordinaten,
  // Ende-zu-Ende verschluesselt. Ein Ortsname, den eine aeltere Version noch
  // mitschickt, wird weiter angezeigt (reiner Text, keine Anfrage).
  // Timer wie bei Text (bis 1.2.0 blieb ein eigener Standort trotz Timer
  // dauerhaft im Verlauf; die Gegenseite wandte nur ihren eigenen Timer an).
  const sendLocationMessage = (lat, lng) => {
    const msgId = Date.now().toString();
    const msgTime = formatTime();
    const mode = expireModeRef.current;
    setMsgs(m => [...(m||[]), {
      id: msgId, text: t('preview.location'), isLocation: true, lat, lng,
      mine: true, time: msgTime, sys: false, status: 'sending', secret: secretActive || undefined,
      expireAt: expireModeToExpireAt(mode),
    }]);
    if (!secretActive) onLastMessage?.(chat?.id, timerPreview(mode) || t('preview.location'));
    const payload = {
      type: 'text', text: t('preview.location'), isLocation: true, lat, lng,
      time: Date.now(), msgId, secret: secretActive || undefined, expireMode: mode,
    };
    // Wie send(): write-ahead ueber die Warteschlange (Zustell-Garantie).
    sendViaOutbox(chat?.id, 'text', payload, msgId, {
      ...ephemeralMeta(),
      onQueued: (ok) => setMsgStatus(msgId, ok ? 'pending' : 'failed'),
    });
  };

  const sendLocation = async () => {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        { title: t('common.location'), message: t('perm.location.message'), buttonPositive: 'OK' }
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert(t('common.location'), t('chat.location.noPermission'));
        return;
      }
      const { default: Geolocation } = await import('@react-native-community/geolocation');
      Geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          sendLocationMessage(latitude, longitude);
        },
        (err) => {
          console.error('[Location] Fehler:', err?.message || err);
          Alert.alert(t('common.location'), t('chat.location.failed'));
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    } catch (e) {
      console.error('[Location] Permission/Fehler:', e?.message || e);
    }
  };

  // Einzelne Nachricht loeschen (fuer beide Seiten) - analog zu
  // clearChatMessages() (App-weit, "Chat leeren"), aber fuer genau eine
  // Nachricht statt den ganzen Verlauf. Sofort lokal entfernen, dann live
  // ueber den DataChannel benachrichtigen - schlaegt der Live-Versand fehl
  // (Gegenseite offline), in die lokale Warteschlange legen statt (wie
  // Nachrichteninhalte grundsaetzlich in diesem Projekt) ueber den Relay zu
  // schicken. Absichtlich keine "nur bei mir loeschen"-Variante - das
  // Projekt kennt bisher ausschliesslich "fuer beide" (delete_chat/
  // clear_chat), das bleibt hier konsistent.
  // Audit G1: Datei eines geloeschten Mediums sofort entfernen (in der
  // Speicher-Reihenfolge, damit kein laufendes Ablegen sie wieder anlegt).
  const forgetMedia = (msgId) => {
    const scope = chat?.id;
    const victim = (msgsRef.current || []).find(x => x.id === msgId);
    if (!scope || !victim || !(victim.type === 'image' || victim.type === 'audio' || victim.type === 'file')) return;
    saveChainRef.current = saveChainRef.current.then(async () => {
      const ref = victim.mref || mediaRefsRef.current.get(msgId)?.mref;
      mediaRefsRef.current.delete(msgId);
      if (ref) await removeMedia(scope, ref);
    }).catch(() => {});
  };
  const deleteMessage = (msgId) => {
    forgetMedia(msgId);
    setMsgs(m => (m || []).filter(x => x.id !== msgId));
    if (!chat?.id) return;
    // Zustell-Garantie: liegt die eigene Nachricht noch unbestaetigt in der
    // Warteschlange, wird sie dort entfernt (nicht mehr zustellen). Der
    // Loesch-Hinweis selbst geht write-ahead ueber die Warteschlange und
    // bleibt bis zur Bestaetigung stehen - die Nachricht kann ja schon
    // angekommen sein, nur ohne Bestaetigung.
    const chatId = chat.id;
    const ts = Date.now();
    dropFromQueue(chatId, (i) => i.msgId === msgId && i.type !== 'system').catch(() => {}).then(() =>
      sendViaOutbox(chatId, 'system', { type: 'system', subtype: 'delete_message', msgId, ts }, 'delmsg_' + msgId));
  };
  const confirmDeleteMessage = (msgId) => {
    Alert.alert(t('chat.deleteMessage.title'), t('chat.deleteMessage.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: () => deleteMessage(msgId) },
    ]);
  };

  // Siegel-Nachrichten (SiegelScreen.tsx) im Malachi-Chat: Antippen oeffnet
  // Siegel mit dem Geheimtext - nichts landet in der Zwischenablage (Tastaturen
  // wie Gboard fuehren einen Zwischenablage-Verlauf). Normale Nachrichten sind
  // auf Wunsch kopierbar (Nutzerwunsch 2026-10-19), aber nur geschuetzt
  // (SecureClipboard.js: "sensibel" markiert, nach 60 s geleert) und nie im
  // Secret Chat.
  // media: Siegel-Anhang (".sgl"-Datei als Base64) aus dem Chat.
  // Entschluesseln/Oeffnen ist kostenlos (Entscheidung 2026-10-19); nur das
  // Schreiben (Siegel-Modus am Mikrofon, Antworten, Einladen) ist Vollversion.
  const openSiegel = (text, media = null) => {
    setSiegelMsg({ msg: text || null, media: media || null });
  };
  // Siegel-Anhang aus dem Verlauf (Inhalt im RAM oder in der Ablage, Audit G1).
  const openSiegelAttachment = (item) => {
    mediaData(chat?.id, item).then((d) => {
      if (d) openSiegel(null, d);
      else Alert.alert(t('chat.siegelAttachment'), t('chat.siegelAttachmentGone'));
    });
  };
  const toggleSiegelMode = () => {
    if (recording) return;
    if (getLicenseState().pro !== true) {
      Alert.alert(t('app.siegelNachrichtenSchreiben'), t('app.siegelNachrichtenVerschluesselnIstTeil'));
      return;
    }
    setSiegelMode((m) => !m);
  };
  // Menue einer Siegel-Blase - im Design der App (wie Anhang-/Anrufmenue),
  // nicht mehr der graue System-Dialog.
  const [siegelMenu, setSiegelMenu] = useState(null);   // { id, text, mine }
  const siegelMessageMenu = (msgId, text, mine) => setSiegelMenu({ id: msgId, text, mine });
  const copySiegelCipher = (text) => { copySensitive(text).catch(() => {}); };
  // Menue einer normalen Textnachricht (Kopieren, Loeschen) - im Design wie das Siegel-Menue.
  const [msgMenu, setMsgMenu] = useState(null);   // { id, text }
  const [copyNotice, setCopyNotice] = useState(false);
  const copyNoticeTimer = useRef(null);
  const copyMessageText = (text) => {
    copySensitive(text).catch(() => {});
    setCopyNotice(true);
    clearTimeout(copyNoticeTimer.current);
    copyNoticeTimer.current = setTimeout(() => setCopyNotice(false), 2500);
  };
  React.useEffect(() => () => clearTimeout(copyNoticeTimer.current), []);

  // Aus dem "Secret Chat beenden"-Button herausgeloest, damit dieselbe
  // Logik auch beim Verlassen des Chats waehrend eines noch AKTIVEN Secret
  // Chats laeuft (Nutzer-Fund: "verlasse Secret Chat nur zur Uebersicht und
  // gehe wieder rein - Nachrichten sind vor Ablauf der Zeit weg"). secretActive
  // ist reiner React-State DIESER Komponente - beim Verlassen (Unmount) ging
  // die laufende Sitzung bisher in einen unklaren Zwischenzustand ueber: der
  // Timer/'secret_'-Marker in EncryptedStorage lief einfach weiter, beim
  // Wiederoeffnen wurde secretActive erneut auf true gesetzt (Timer noch
  // nicht abgelaufen), aber die WAEHREND der Sitzung getippten Nachrichten
  // waren fuer immer weg (lebten nur im jetzt zerstoerten State, wurden nie
  // persistiert - by design). Sauberer: Verlassen beendet den Secret Chat
  // genauso explizit wie der Knopf, mit derselben Benachrichtigung an die
  // Gegenseite - kein unklarer "noch aktiv, aber Inhalt schon weg"-Zustand.
  const endSecretChatSession = () => {
    setSecret(false);
    setSecretTimer(null);
    setCountdown(0);
    clearTimeout(secretCountdownRef.current);
    AsyncStorage.removeItem('secret_' + chat?.id);
    // Nur-P2P-Umstellung 2026-09-29: nur P2P/Tor, nie ueber den Relay.
    // Zustell-Garantie: write-ahead ueber die Warteschlange, bleibt bis zur
    // Bestaetigung stehen. Noch nicht zugestellte Secret-Nachrichten
    // verfallen sofort (duerfen nicht nach dem Ende noch ankommen).
    const secretEndSignal = { type: 'system', subtype: 'secret_end', ts: Date.now() };
    if (chat?.id) {
      const endChatId = chat.id;
      dropEphemeralFromQueue(endChatId).catch(() => {}).then(() =>
        sendViaOutbox(endChatId, 'system', secretEndSignal, 'secretend_' + secretEndSignal.ts));
    }
    AsyncStorage.getItem(storageKey).then((saved) => {
      let restored = [];
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) restored = parsed;
        } catch(e) {}
      }
      setMsgs([...restored, {
        id: Date.now().toString(),
        text: t('secret.ended'),
        mine: false, time: '', sys: true
      }]);
    });
  };

  // Haelt backInterceptRef synchron mit secretActive - siehe Begruendung bei
  // deren Deklaration in AppInner. Nur der Hardware-/Geste-Zurueck-Pfad
  // braucht diese Ref (der sichtbare Zurueck-Pfeil oben prueft secretActive
  // direkt inline); leert sich beim Unmount/Beenden von selbst.
  React.useEffect(() => {
    if (!backInterceptRef) return;
    backInterceptRef.current = secretActive
      ? () => {
          Alert.alert(
            t('secret.leave.title'),
            t('secret.leave.body'),
            [
              { text: t('common.cancel'), style: 'cancel' },
              { text: t('secret.leave.confirm'), style: 'destructive', onPress: () => { endSecretChatSession(); onBack(); } },
            ]
          );
        }
      : null;
    return () => { backInterceptRef.current = null; };
  }, [secretActive]);

return (
    // War bisher komplett ohne Tastatur-Ausweich-Logik (per Live-Test entdeckt):
    // das Eingabefeld unten wurde vom aufklappenden Tastatur-Overlay einfach
    // verdeckt, statt darueber zu ruecken. android:windowSoftInputMode=
    // "adjustResize" im Manifest allein reicht bei diesem targetSdk/Edge-to-
    // Edge-Setup nicht zuverlaessig aus (bekannte Einschraenkung neuerer
    // Android-Versionen) - explizit per KeyboardAvoidingView geloest.
    <KeyboardAvoidingView style={{ flex:1 }} behavior="height">
    <View style={{ flex:1, backgroundColor:P.bg }}>
      <SafetyNumberDialog
        visible={safetyVisible}
        chatId={chat?.id}
        info={safety}
        onClose={() => setSafetyVisible(false)}
        onRefresh={refreshSafety}
        onConfirmed={() => {
          // Krypto-Review K-03: der Hinweis "Vorgestellt von ..." verschwindet
          // erst nach der ausdruecklichen Bestaetigung, nicht schon beim Oeffnen.
          if (chat?.introducedBy && !chat.introducedBy.confirmed) {
            onRename?.({ id: chat.id, introducedBy: { ...chat.introducedBy, checked: true, confirmed: true } });
          }
        }}
      />

      <Modal visible={timerModal} transparent animationType="slide" onRequestClose={() => setTimer(false)}>
        <View style={{ flex:1, backgroundColor:P.overlay, justifyContent:'flex-end' }}>
          <View style={{ backgroundColor:P.surface, borderTopLeftRadius:28, borderTopRightRadius:28, padding:24, paddingBottom:48 }}>
            <Text style={{ fontSize:17, fontWeight:'600', color:P.text, marginBottom:4 }}>{t('timer.title')}</Text>
            <Text style={{ fontSize:13, color:P.textMuted, marginBottom:20 }}>{t('timer.subtitle')}</Text>
            {[
              { key:'off',  label:t('timer.off'),           sub:t('timer.off.sub') },
              { key:'read', label:t('timer.read'), sub:t('timer.read.sub') },
              { key:'1h',   label:t('timer.1h'),       sub:t('timer.1h.sub') },
              { key:'24h',  label:t('timer.24h'),     sub:t('timer.24h.sub') },
              { key:'7d',   label:t('timer.7d'),         sub:t('timer.7d.sub') },
            ].map(opt => (
              <TouchableOpacity key={opt.key} onPress={() => {
                setExpire(opt.key);
                expireModeRef.current = opt.key;
                setTimer(false);
                console.log('[Timer] Setze timer für:', chat?.id, '=', opt.key);
                const chatId = chat?.id;
                if (!chatId) return;
                // Timer auch an Gegenüber senden - ueber die Warteschlange, also
                // auch wenn gerade keine Verbindung steht. Bis 1.2.0 ging hier
                // ein secret_start ohne mins raus, das die Gegenseite verwarf
                // (Fund 28.10.2026). Ein noch nicht zugestelltes aelteres
                // Timer-Signal ist damit ueberholt.
                setOwnTimer(chatId, opt.key)
                  .then(async (ts) => {
                    await dropFromQueue(chatId, (item) => item.type === 'system' && item.subtype === 'timer');
                    await sendViaOutbox(chatId, 'system', { type: 'system', subtype: 'timer', mode: opt.key, ts }, 'timer_' + ts);
                  })
                  .catch((e) => console.warn('[Timer] Nicht gesendet:', e?.message || e));
              }}
                style={{ flexDirection:'row', alignItems:'center', paddingVertical:14, borderBottomWidth:0.5, borderBottomColor:P.border }}>
                <View style={{ flex:1 }}>
                  <Text style={{ fontSize:15, color:P.text, fontWeight: expireMode===opt.key ? '600':'400' }}>{opt.label}</Text>
                  <Text style={{ fontSize:12, color:P.textMuted }}>{opt.sub}</Text>
                </View>
                {expireMode === opt.key && <Text style={{ fontSize:18, color:AC }}>✓</Text>}
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setTimer(false)} style={{ marginTop:16, padding:14, alignItems:'center' }}>
              <Text style={{ color:P.textMuted, fontSize:15 }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {/* SECRET CHAT MODAL */}
      <Modal visible={secretModal} transparent animationType="slide" onRequestClose={() => setSecretModal(false)}>
        <View style={{ flex:1, backgroundColor:'rgba(0,0,0,0.7)', justifyContent:'flex-end' }}>
          <View style={{ backgroundColor:P.surface, borderTopLeftRadius:28, borderTopRightRadius:28, padding:24, paddingBottom:48 }}>
            <Text style={{ fontSize:20, fontWeight:'600', color:P.text, marginBottom:4 }}>{t('secret.title')}</Text>
            <Text style={{ fontSize:13, color:P.textMuted, marginBottom:24, lineHeight:20 }}>
              {t('secret.desc1')}{'\n'}{t('secret.desc2')}
            </Text>
            {[
              { mins:5,  label:t('secret.min5') },
              { mins:15, label:t('secret.min15') },
              { mins:30, label:t('secret.min30') },
              { mins:60, label:t('timer.1h') },
            ].map(opt => (
              <TouchableOpacity key={opt.mins} onPress={() => {
                setSecretTimer(opt.mins);
                setSecret(true);
                setSecretModal(false);
                setCountdown(opt.mins * 60);
                AsyncStorage.setItem('secret_' + chat?.id, JSON.stringify({
                  mins: opt.mins,
                  endsAt: Date.now() + opt.mins * 60 * 1000
                }));
                // System-Nachricht lokal anzeigen
                setMsgs(m => [...m, {
                  id: Date.now().toString(),
                  text: t('secret.started', { count: opt.mins }),
                  mine: false, time: '', sys: true
                }]);
                // Secret Chat Nachricht senden – nur P2P/Tor (Nur-P2P-
                // Umstellung 2026-09-29, vorher zusaetzlich Relay /packet).
                // Zustell-Garantie: write-ahead ueber die Warteschlange; ein
                // verspaetet zugestelltes, laengst abgelaufenes secret_start
                // ignoriert der Empfaenger (endsAt).
                const secretEndsAt = Date.now() + opt.mins * 60 * 1000;
                const secretStartSignal = {
                  type: 'system', subtype: 'secret_start', mins: opt.mins, endsAt: secretEndsAt, ts: Date.now()
                };
                if (chat?.id) sendViaOutbox(chat.id, 'system', secretStartSignal, 'secretstart_' + secretStartSignal.ts, { expiresAt: secretEndsAt });
              }}
                style={{ flexDirection:'row', alignItems:'center', paddingVertical:16,
                  borderBottomWidth:0.5, borderBottomColor:P.border }}>
                <Text style={{ fontSize:16, color:P.text, flex:1 }}>{opt.label}</Text>
                <Text style={{ fontSize:14, color:AC }}>{FORWARD_ARROW}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setSecretModal(false)} style={{ marginTop:16, padding:14, alignItems:'center' }}>
              <Text style={{ color:P.textSub, fontSize:15 }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={renaming} transparent animationType="fade" onRequestClose={() => setRenaming(false)}>
        <View style={{ flex:1, backgroundColor:P.overlay, alignItems:'center', justifyContent:'center', padding:32 }}>
          <View style={{ width:'100%', backgroundColor:P.surface, borderRadius:20, padding:24, gap:12 }}>
            <Text style={{ fontSize:17, fontWeight:'600', color:P.text }}>{t('chat.rename.title')}</Text>
            <TextInput value={newName} onChangeText={setNewName} autoFocus
              style={{ borderWidth:1, borderColor:P.border, borderRadius:12, padding:12, fontSize:15, color:P.text }}
              placeholder={t('chat.rename.placeholder')} placeholderTextColor={P.textMuted}/>
            <TouchableOpacity onPress={() => { 
              if (newName.trim() && onRename) { 
                onRename({...chat, name: newName.trim(), nameEdited: true});
                // nameEdited in contacts speichern - ueber updateContacts
                // serialisiert (Konkurrenz-Review §5).
                updateContacts(cs => cs.map(c => c.id === chat.id ? {...c, name: newName.trim(), nameEdited: true} : c))
                  .catch(() => {});
              }
              setRenaming(false); 
            }}
              style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:AC }}>
              <Text style={{ color:P.onAccent, fontWeight:'500' }}>{t('common.save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setRenaming(false)}
              style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:P.surfaceAlt }}>
              <Text style={{ color:P.textSub }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {/* KONTAKTUEBERSICHT (Nutzerwunsch, wie WhatsApp): Kopfleiste antippen ->
          grosses Profilbild, Name, Verbindungsweg, alle Medien im Chat, danach
          die bisherigen Aktionen (Umbenennen/Timer/Sicherheitscode/Loeschen).
          Einmal-Medien (viewOnce) werden bewusst NICHT aufgelistet. */}
      <Modal visible={chatInfo} animationType="slide" onRequestClose={() => setChatInfo(false)}>
        {(() => {
          const media = (msgs || []).filter(m => !m.viewOnce && !m.sys);
          const hasData = (m) => !!(m.base64 || m.mref);   // Audit G1: Inhalt im RAM oder in der Ablage
          const images = media.filter(m => m.type === 'image' && hasData(m));
          const audios = media.filter(m => m.type === 'audio' && hasData(m));
          const files  = media.filter(m => m.type === 'file' && hasData(m));
          const tabs = [
            { key: 'images', label: t('chatInfo.tabImages'), count: images.length },
            { key: 'audio',  label: t('chatInfo.tabAudio'), count: audios.length },
            { key: 'files',  label: t('chatInfo.tabFiles'), count: files.length },
          ];
          const thumb = Math.floor((W - 32 - 8) / 3);
          const transport = RTCStore.connections.get(chat?.id)?.transport;
          const statusText = isConnected
            ? (transport === 'tor' ? t('chatInfo.viaTor') : t('chatInfo.direct'))
            : t('chatInfo.offline');
          const fmtMsShort = (ms) => {
            const sec = Math.round((ms || 0) / 1000);
            return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
          };
          const action = (icon, label, onPress, danger) => (
            <TouchableOpacity onPress={onPress}
              style={{ flexDirection:'row', alignItems:'center', gap:14, paddingVertical:16, paddingHorizontal:20 }}>
              <Icon name={icon} size={18} color={danger ? P.danger : P.textSub} />
              <Text style={{ fontSize:15, color: danger ? P.danger : P.text }}>{label}</Text>
            </TouchableOpacity>
          );
          return (
            <View style={{ flex:1, backgroundColor:P.bg, paddingTop:insets.top }}>
              <View style={hm.header}>
                <TouchableOpacity onPress={() => setChatInfo(false)} style={{ marginRight:8, padding:4 }} hitSlop={DEMO_HIT}>
                  <Text style={{ fontSize:22, color:P.headerIcon }}>{BACK_ARROW}</Text>
                </TouchableOpacity>
                <Text style={{ fontSize:16, fontWeight:'600', color:P.headerText }}>{t('chatInfo.title')}</Text>
              </View>
              <ScrollView contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}>
                <View style={{ alignItems:'center', paddingTop:28, paddingBottom:20, paddingHorizontal:16, gap:8 }}>
                  <TouchableOpacity activeOpacity={0.85} disabled={!chat?.theirAvatar}
                    onPress={() => chat?.theirAvatar && setViewerImage(chat.theirAvatar)}>
                    {chat && <Avatar c={chat} size={140} />}
                  </TouchableOpacity>
                  <Text style={{ fontSize:22, fontWeight:'600', color:P.text, marginTop:8, textAlign:'center' }}>{chat?.name}</Text>
                  {chat?.theirName && chat.theirName !== chat?.name ? (
                    <Text style={{ fontSize:13, color:P.textSub }}>{t('chatInfo.selfName', { name: chat.theirName })}</Text>
                  ) : null}
                  <Text style={{ fontSize:12, color: isConnected ? P.green : P.textMuted, textAlign:'center' }}>
                    {isConnected ? '● ' : '○ '}{statusText}
                  </Text>
                </View>

                <View style={{ backgroundColor:P.surface, borderTopWidth:0.5, borderBottomWidth:0.5, borderColor:P.border }}>
                  <Text style={{ fontSize:13, fontWeight:'600', color:P.textSub, paddingHorizontal:16, paddingTop:14 }}>
                    {t('chatInfo.media')}
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal:12, paddingVertical:10, gap:8 }}>
                    {tabs.map(t => (
                      <TouchableOpacity key={t.key} onPress={() => setInfoTab(t.key)}
                        style={{ paddingVertical:7, paddingHorizontal:14, borderRadius:16,
                          backgroundColor: infoTab === t.key ? P.greenBg : 'transparent',
                          borderWidth:1, borderColor: infoTab === t.key ? AC : P.border }}>
                        <Text style={{ fontSize:13, color: infoTab === t.key ? P.text : P.textSub }}>
                          {t.label} · {t.count}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  {infoTab === 'images' && (images.length === 0
                    ? <Text style={{ color:P.textMuted, fontSize:13, padding:16 }}>{t('chatInfo.noImages')}</Text>
                    : <View style={{ flexDirection:'row', flexWrap:'wrap', gap:4, paddingHorizontal:16, paddingBottom:16 }}>
                        {images.slice().reverse().map(img => (
                          <TouchableOpacity key={img.id} activeOpacity={0.85} onPress={() => { mediaData(chat?.id, img).then((d) => { if (d) setViewerImage(d); }); }}>
                            <VaultImage scope={chat?.id} item={img} style={{ width:thumb, height:thumb, borderRadius:6 }} />
                          </TouchableOpacity>
                        ))}
                      </View>)}

                  {infoTab === 'audio' && (audios.length === 0
                    ? <Text style={{ color:P.textMuted, fontSize:13, padding:16 }}>{t('chatInfo.noAudio')}</Text>
                    : <View style={{ paddingBottom:8 }}>
                        {audios.slice().reverse().map(a => (
                          <TouchableOpacity key={a.id} onPress={() => playAudio(a)}
                            style={{ flexDirection:'row', alignItems:'center', gap:12, paddingVertical:12, paddingHorizontal:16 }}>
                            <Icon name={playingId === a.id ? 'pause-circle' : 'play-circle'} size={26} color={AC} />
                            <View style={{ flex:1, minWidth:0 }}>
                              <Text style={{ fontSize:14, color:P.text }}>{a.mine ? t('common.you') : chat?.name}</Text>
                              <Text style={{ fontSize:12, color:P.textMuted }}>{a.time} · {fmtMsShort(a.durationMs)}</Text>
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>)}

                  {infoTab === 'files' && (files.length === 0
                    ? <Text style={{ color:P.textMuted, fontSize:13, padding:16 }}>{t('chatInfo.noFiles')}</Text>
                    : <View style={{ paddingBottom:8 }}>
                        {files.slice().reverse().map(fl => (
                          <TouchableOpacity key={fl.id} onPress={() => {
                              // Siegel-Anhaenge oeffnen sich ueber Siegel (wie die Chat-Blase), nicht als
                              // nackte verschluesselte Datei.
                              if (isSiegelFileName(fl.fileName)) {
                                if (fl.mine || !(fl.base64 || fl.mref)) {
                                  Alert.alert(t('chat.siegelAttachment'), fl.mine ? t('chat.siegelOwnAttachment') : t('chat.siegelAttachmentGone'));
                                  return;
                                }
                                setChatInfo(false);
                                openSiegelAttachment(fl);
                                return;
                              }
                              openFileItem(fl);
                            }}
                            style={{ flexDirection:'row', alignItems:'center', gap:12, paddingVertical:12, paddingHorizontal:16 }}>
                            <Icon name={isSiegelFileName(fl.fileName) ? 'lock' : 'file'} size={22} color={AC} />
                            <View style={{ flex:1, minWidth:0 }}>
                              <Text numberOfLines={1} style={{ fontSize:14, color:P.text }}>{isSiegelFileName(fl.fileName) ? t('chat.siegelAttachment') : (fl.fileName || t('common.file'))}</Text>
                              <Text style={{ fontSize:12, color:P.textMuted }}>{fl.mine ? t('common.you') : chat?.name} · {fl.time}</Text>
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>)}
                </View>

                <View style={{ marginTop:16, backgroundColor:P.surface, borderTopWidth:0.5, borderBottomWidth:0.5, borderColor:P.border }}>
                  {action('edit-2', t('chatInfo.rename'), () => { setChatInfo(false); setNewName(chat?.name || ''); setRenaming(true); })}
                  {action('clock', expireMode !== 'off' ? t('chatInfo.timerActive') : t('chatInfo.timer'), () => { setChatInfo(false); setTimer(true); })}
                  {showSafety ? action('shield', t('common.showSafetyCode'), () => { setChatInfo(false); setSafetyVisible(true); }) : null}
                  {action('trash-2', t('home.deleteChat'), () => {
                    setChatInfo(false);
                    Alert.alert(
                      t('home.deleteChat'),
                      t('home.deleteChat.body'),
                      [
                        { text: t('common.cancel'), style: 'cancel' },
                        { text: t('common.delete'), style: 'destructive', onPress: () => onDelete?.(chat?.id) },
                      ]
                    );
                  }, true)}
                </View>
              </ScrollView>

              {/* Bild-Vollansicht (Profilbild oder Bild aus dem Chat) */}
              <Modal visible={!!viewerImage} transparent animationType="fade" onRequestClose={() => setViewerImage(null)}>
                <TouchableOpacity activeOpacity={1} onPress={() => setViewerImage(null)}
                  style={{ flex:1, backgroundColor:'rgba(0,0,0,0.95)', alignItems:'center', justifyContent:'center' }}>
                  {viewerImage ? (
                    <Image source={{ uri: viewerImage }} style={{ width:W, height:W * 1.4 }} resizeMode="contain" />
                  ) : null}
                  <Text style={{ position:'absolute', top: insets.top + 16, right:20, fontSize:28, color:'#FFFFFF' }}>✕</Text>
                </TouchableOpacity>
              </Modal>
            </View>
          );
        })()}
      </Modal>
      <View style={hm.header}>
        <TouchableOpacity onPress={() => {
          // Nutzer-Fund: Verlassen waehrend eines noch AKTIVEN Secret Chats
          // (Timer nicht abgelaufen) liess die Sitzung in einem unklaren
          // Zwischenzustand haengen - beim Wiederoeffnen wieder "aktiv",
          // aber die Sitzungsnachrichten fuer immer weg (siehe
          // endSecretChatSession() oben). Jetzt: explizit fragen und sauber
          // beenden statt stillschweigend in der Schwebe zu lassen.
          if (secretActive) {
            Alert.alert(
              t('secret.leave.title'),
              t('secret.leave.body'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('secret.leave.confirm'), style: 'destructive', onPress: () => { endSecretChatSession(); onBack(); } },
              ]
            );
            return;
          }
          // Storage wird automatisch durch msgs useEffect bereinigt
          onBack();
        }} style={{ marginRight:8, padding:4 }} hitSlop={demoBigTargets ? DEMO_HIT : undefined}>
          <Text style={{ fontSize:22, color:P.headerIcon }}>{BACK_ARROW}</Text>
        </TouchableOpacity>
        {chat && (
          <TouchableOpacity onPress={() => setChatInfo(true)} hitSlop={demoBigTargets ? DEMO_HIT : undefined}>
            <Avatar c={chat} size={34} onHeader />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={{ flex:1, marginLeft:10 }} onPress={() => setChatInfo(true)}>
          <View style={{ flexDirection:'row', alignItems:'center', gap:5 }}>
            <Text style={{ fontSize:15, fontWeight:'500', color:P.headerText }}>{chat?.name}</Text>
            {showSafety && (
              <TouchableOpacity testID="safety-shield" onPress={(e) => { e.stopPropagation(); setSafetyVisible(true); }} hitSlop={demoBigTargets ? DEMO_HIT : undefined}>
                <View style={{ flexDirection:'row', alignItems:'center' }}>
                  <Icon name="shield" size={13} color={safety?.verified ? P.headerVerified : P.headerIcon} />
                  {safety?.verified ? <Icon name="check" size={10} color={P.headerVerified} /> : null}
                  {safety?.changed && (
                    <View style={{ position:'absolute', top:-2, right:-3, width:7, height:7, borderRadius:3.5, backgroundColor:P.headerDanger }} />
                  )}
                </View>
              </TouchableOpacity>
            )}
          </View>
          <Text style={{ fontSize:11, color: isConnected ? P.headerOnline : connStatus === 'reconnecting' ? P.headerWarning : P.headerMuted }}>
              {connStatus === 'direct' ? t('app.direktVerbunden')
                : connStatus === 'tor' ? t('app.verbundenUeberTor')
                : connStatus === 'reconnecting' ? t('app.verbindungWirdWiederhergestellt')
                : t('app.nichtVerbundenNachrichtenWartenSicher')}
            </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setSecretModal(true)} style={{ padding:6 }} hitSlop={demoBigTargets ? DEMO_HIT : undefined}>
          <Text style={{ fontSize:18, color:P.headerIcon }}>🔥</Text>
        </TouchableOpacity>
        {/* Design-Feedback: kein Umschalter mehr nebeneinander - EIN Knopf,
            der direkt im aktuellen Modus anruft; Gedrückthalten wechselt den
            Modus (Audio/Video), ohne selbst anzurufen. RNs Touchable
            unterdrueckt onPress bereits eingebaut, wenn onLongPress
            ausgeloest wurde - kein eigenes Timer-Handling noetig.
            UI-Demo "callMenu": Antippen oeffnet stattdessen eine kleine
            Auswahl (Sprach-/Videoanruf) - gleiches Menue-Muster wie die
            Kontaktliste, kein zusaetzliches Header-Icon. */}
        <TouchableOpacity
          onPress={() => demoCallMenu ? setCallMenuOpen(true) : onCall(callMode === 'video')}
          onLongPress={demoCallMenu ? undefined : () => setCallMode(m => m === 'audio' ? 'video' : 'audio')}
          delayLongPress={350}
          hitSlop={demoBigTargets ? DEMO_HIT : undefined}
          style={{ padding:6 }}>
          <Icon name={demoCallMenu ? 'phone' : (callMode === 'video' ? 'video' : 'phone')} size={20} color={P.headerIcon} />
        </TouchableOpacity>
        </View>

      {/* Ueber eine Gruppe vorgestellt (GroupIntroPairing.js): der Admin haette
          die Einladung lesen oder ersetzen koennen - der Hinweis bleibt, bis der
          Sicherheitscode ausdruecklich als "stimmt ueberein" bestaetigt wurde
          (Krypto-Review K-03; vorher genuegte das Oeffnen des Dialogs). */}
      {chat?.introducedBy && !chat.introducedBy.confirmed && !safety?.verified && (
        <View testID="intro-chat-banner" style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:10, paddingHorizontal:14,
          backgroundColor:P.surfaceAlt, borderBottomWidth:0.5, borderBottomColor:P.border }}>
          <Icon name="user-check" size={15} color={AC} />
          <Text style={{ flex:1, fontSize:12, color:P.text, lineHeight:17 }}>
            {t('groups.intro.chatBanner', { admin: chat.introducedBy.admin || t('groups.unknown') })}
          </Text>
          <TouchableOpacity accessibilityRole="button" hitSlop={{ top:8, bottom:8, left:8, right:8 }}
            onPress={() => setSafetyVisible(true)}>
            <Text style={{ fontSize:12, fontWeight:'600', color:AC }}>{t('groups.intro.compare')}</Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={callMenuOpen} transparent animationType="fade" onRequestClose={() => setCallMenuOpen(false)}>
        <TouchableOpacity style={{ flex:1 }} activeOpacity={1} onPress={() => setCallMenuOpen(false)}>
          <View style={{ position:'absolute', right:12, top:58, backgroundColor:P.menuBg, borderRadius:12,
            borderWidth:0.5, borderColor:P.menuBorder, overflow:'hidden', minWidth:190, elevation:6 }}>
            <TouchableOpacity style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:14 }}
              onPress={() => { setCallMenuOpen(false); onCall(false); }}>
              <Icon name="phone" size={16} color={P.menuAccent} />
              <Text style={{ fontSize:14, color:P.menuText }}>{t('chat.voiceCall')}</Text>
            </TouchableOpacity>
            <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
            <TouchableOpacity style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:14 }}
              onPress={() => { setCallMenuOpen(false); onCall(true); }}>
              <Icon name="video" size={16} color={P.menuAccent} />
              <Text style={{ fontSize:14, color:P.menuText }}>{t('chat.videoCall')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {demoOfflineBanner && !isConnected && !secretActive && (
        <View style={{ backgroundColor:P.surfaceAlt, borderBottomWidth:0.5, borderBottomColor:P.border,
          paddingVertical:8, paddingHorizontal:14, flexDirection:'row', alignItems:'center', gap:10 }}>
          <Icon name="clock" size={15} color={P.warning} />
          <Text style={{ flex:1, fontSize:12, color:P.textSub, lineHeight:16 }}>
            {chat?.name ? t('chat.offlineBanner', { name: chat.name }) : t('chat.offlineBannerNoName')}
          </Text>
          <TouchableOpacity onPress={() => { global.malachiReconnectNow?.(); setReconnectKick(Date.now()); }}
            disabled={Date.now() - reconnectKick < 8000}
            style={{ paddingHorizontal:10, paddingVertical:6, borderRadius:10, borderWidth:1,
              borderColor: Date.now() - reconnectKick < 8000 ? P.border : AC }}>
            <Text style={{ fontSize:12, fontWeight:'600', color: Date.now() - reconnectKick < 8000 ? P.textMuted : P.accentFg }}>
              {Date.now() - reconnectKick < 8000 ? t('chat.connectingShort') : t('chat.connectNow')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {customBg && <Image source={{ uri: customBg }} style={{ position:'absolute', top:60, left:0, right:0, bottom:60 }} resizeMode="cover" />}
      {secretActive && (
        <View style={{ backgroundColor:P.surface, paddingVertical:8, paddingHorizontal:16,
          flexDirection:'row', alignItems:'center', justifyContent:'space-between' }}>
          <Text style={{ color:P.danger, fontSize:13, fontWeight:'600' }}>{t('secret.active')}</Text>
          <Text style={{ color:P.text, fontSize:13, fontWeight:'600' }}>
            {Math.floor(secretCountdown/60)}:{String(secretCountdown%60).padStart(2,'0')}
          </Text>
          <TouchableOpacity onPress={() => {
            Alert.alert(
              t('secret.end.title'),
              t('secret.end.body'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('secret.end.confirm'), style: 'destructive', onPress: endSecretChatSession },
              ]
            );
          }} style={{ padding:4 }}>
            <Icon name="x-circle" size={18} color={P.danger} />
          </TouchableOpacity>
        </View>
      )}
      {/* Design "Malachi Artwork": Klecks-Muster hinter dem Verlauf (ChatArtwork.tsx), die Liste ist dann durchsichtig */}
      <View style={{ flex:1 }}>
      {chatArtworkVisible(P, { secretActive, customBg }) && <ChatArtwork kind={P.artwork} fills={P.artworkFills} glints={P.artworkGlints} bg={P.chatBg} />}
      <FlatList ref={ref} data={msgs} keyExtractor={i => i.id}
        style={{ backgroundColor: secretActive ? '#0E0A06' : customBg || chatArtworkVisible(P, { secretActive, customBg }) ? 'transparent' : (P.chatBgPreset || (demoDarkChat || !P.chatBgLight ? P.chatBg : P.chatBgLight)) }}
        contentContainerStyle={{ padding:14 }}
        onContentSizeChange={() => ref.current?.scrollToEnd()}
        renderItem={({ item }) => {
          if (item.sys) return (
            <View style={{ alignSelf:'center', marginVertical:8, backgroundColor:P.surface,
              paddingHorizontal:12, paddingVertical:4, borderRadius:10 }}>
              <Text style={{ fontSize:11, color:P.textMuted }}>{item.text}</Text>
            </View>
          );
          if (item.type === 'audio') {
            const isPlayingThis = playingId === item.id;
            const fmtMs = (ms) => `${Math.floor((ms||0)/60000)}:${String(Math.floor(((ms||0)%60000)/1000)).padStart(2,'0')}`;
            const fraction = isPlayingThis && playProgress.duration
              ? Math.min(1, playProgress.position / playProgress.duration) : 0;
            // Sprachnachricht (Nutzerwunsch 2026-10-25): Wellenform aus dem echten
            // Pegel (VoiceWave.js) - Balken oder Pixel-Welle, abgespielter Teil in
            // Akzentfarbe, Antippen springt an die Stelle. Darunter Zeit,
            // Geschwindigkeit (waehrend des Abspielens) und Status.
            const activeColor = item.mine ? P.bubbleMineText : AC;
            const idleColor = item.mine ? P.bubbleMineTrack : P.bubbleTheirsBorder;
            const metaColor = item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta;
            const waveW = Math.max(120, Math.min(190, Math.round(W * 0.44)));
            return (
            <TouchableOpacity activeOpacity={1} onLongPress={() => confirmDeleteMessage(item.id)}
              style={[{ maxWidth:W*0.8, marginVertical:3, paddingTop:8, paddingBottom:6, paddingHorizontal:10, borderRadius:16 },
              item.mine
                ? { alignSelf:'flex-end', backgroundColor:P.bubbleMine }
                : { alignSelf:'flex-start', backgroundColor:P.bubbleTheirs, borderWidth:0.5, borderColor:P.bubbleTheirsBorder }]}>
              <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
                <TouchableOpacity onPress={() => playAudio(item)} testID={'voice-play-' + item.id}
                  accessibilityRole="button" accessibilityLabel={isPlayingThis ? t('voice.pause') : t('voice.play')}
                  style={{ width:36, height:36, borderRadius:18,
                    backgroundColor: item.mine ? P.bubbleMineSoft : AC,
                    alignItems:'center', justifyContent:'center' }}>
                  <Icon name={isPlayingThis ? 'pause' : 'play'} size={16}
                    color={item.mine ? P.bubbleMineText : P.onAccent} style={isPlayingThis ? undefined : { marginLeft:2 }} />
                </TouchableOpacity>
                <VoiceWaveView testID={'voice-wave-' + item.id} levels={levelsFor(item)} progress={fraction}
                  animate={isPlayingThis} variant={waveStyle} width={waveW} height={30}
                  activeColor={activeColor} idleColor={idleColor}
                  onSeek={(f) => seekAudio(item, f)} accessibilityLabel={t('voice.seek')} />
              </View>
              <View style={{ flexDirection:'row', alignItems:'center', marginTop:3, marginLeft:46, gap:8 }}>
                <Text style={{ fontSize:11, color:metaColor, fontVariant:['tabular-nums'] }}>
                  {isPlayingThis ? fmtMs(playProgress.position) : fmtMs(item.durationMs)}{item.viewOnce ? ' · ⚡' : ''}
                </Text>
                {isPlayingThis && (
                  <TouchableOpacity onPress={cyclePlaybackSpeed} hitSlop={{ top:6, bottom:6, left:6, right:6 }}
                    accessibilityRole="button" accessibilityLabel={t('voice.speed', { speed: playbackSpeed })}
                    style={{ paddingHorizontal:7, paddingVertical:1, borderRadius:8,
                      backgroundColor: item.mine ? P.bubbleMineSoft : P.surfaceAlt }}>
                    <Text style={{ fontSize:11, fontWeight:'600', color: item.mine ? P.bubbleMineText : P.accentFg }}>
                      {playbackSpeed}×
                    </Text>
                  </TouchableOpacity>
                )}
                <View style={{ flex:1 }} />
                <Text style={{ fontSize:11, color:metaColor }}>
                  {item.time}{item.mine ? '  ' + sendStatusIcon(item.status) : ''}
                </Text>
              </View>
            </TouchableOpacity>
            );
          }
          if (item.type === 'image') return (
            <View style={[{ maxWidth:W*0.74, marginVertical:3 },
              item.mine
                ? { alignSelf:'flex-end' }
                : { alignSelf:'flex-start' }]}>
              <TouchableOpacity onLongPress={() => {
                // Audit P8: Secret-Chat-Bilder nicht in die Galerie.
                if (secretActive || item.secret) {
                  Alert.alert(t('common.image'), t('app.bilderAusDemSecretChat'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('common.delete'), style: 'destructive', onPress: () => confirmDeleteMessage(item.id) },
                  ]);
                  return;
                }
                Alert.alert(t('common.image'), undefined, [
                  { text: t('common.cancel'), style: 'cancel' },
                  { text: t('chat.saveToGallery'), onPress: async () => {
                    try {
                      const data = await mediaData(chat?.id, item);   // Audit G1
                      if (!data) throw new Error('Bild nicht mehr verfügbar');
                      const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
                      const mimeType = data.match(/data:([^;]+);/)?.[1] || 'image/jpeg';
                      const ext = mimeType.split('/')[1] || 'jpg';
                      const path = `${RNFS.CachesDirectoryPath}/malachi_${Date.now()}.${ext}`;
                      await RNFS.writeFile(path, base64Data, 'base64');
                      await CameraRoll.saveAsset(`file://${path}`, { type: 'photo' });
                      await RNFS.unlink(path);
                      alert(t('chat.savedToGallery'));
                    } catch(e) {
                      console.error('[Image] Speichern fehlgeschlagen:', e);
                      alert(t('chat.saveFailed', { error: e.message }));
                    }
                  } },
                  { text: t('common.delete'), style: 'destructive', onPress: () => confirmDeleteMessage(item.id) },
                ]);
              }}>
                <VaultImage scope={chat?.id} item={item}
                  style={{ width:200, height:200, borderRadius:12 }} />
              </TouchableOpacity>
              <Text style={{ fontSize:11, marginTop:2, textAlign:'right',
                color: item.mine ? P.textMuted : P.textMuted }}>
                {item.time}{item.mine ? '  ' + sendStatusIcon(item.status) : ''}
              </Text>
            </View>
          );
          if (item.type === 'file') {
            const fmtSize = (bytes) => {
              if (!Number.isFinite(bytes)) return '';
              if (bytes < 1024) return `${bytes} B`;
              if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
              return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            };
            if (isSiegelFileName(item.fileName)) {
              // Siegel-Anhang (SiegelScreen.tsx): kompakt wie eine Siegel-
              // Nachricht; Antippen oeffnet Siegel mit der verschluesselten Datei.
              return (
              <TouchableOpacity activeOpacity={0.8}
                onPress={() => (item.mine || !(item.base64 || item.mref)
                  ? Alert.alert(t('chat.siegelAttachment'), item.mine ? t('chat.siegelOwnAttachment') : t('chat.siegelAttachmentGone'))
                  : openSiegelAttachment(item))}
                onLongPress={() => confirmDeleteMessage(item.id)}
                style={[{ maxWidth:W*0.74, marginVertical:3, padding:10 },
                item.mine
                  ? { alignSelf:'flex-end', backgroundColor:P.bubbleMine, borderRadius:16, borderBottomRightRadius:4 }
                  : { alignSelf:'flex-start', backgroundColor:P.bubbleTheirs, borderRadius:16,
                      borderBottomLeftRadius:4, borderWidth:0.5, borderColor:P.bubbleTheirsBorder }]}>
                <View style={{ flexDirection:'row', alignItems:'center', gap:8 }}>
                  <Icon name="lock" size={16} color={item.mine ? P.bubbleMineText : AC} />
                  <Text style={{ fontSize:15, fontWeight:'500', color: item.mine ? P.bubbleMineText : P.bubbleTheirsText }}>{t('chat.siegelAttachment')}</Text>
                </View>
                <Text style={{ fontSize:12, marginTop:4, color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                  {item.mine ? t('chat.siegelOnlyContactIt') : t('chat.tapToOpen')}
                </Text>
                <Text style={{ fontSize:11, marginTop:4, textAlign:'right', color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                  {item.time}{item.mine ? '  ' + sendStatusIcon(item.status) : ''}
                </Text>
              </TouchableOpacity>
              );
            }
            const openFile = () => openFileItem(item);
            return (
            <TouchableOpacity activeOpacity={0.8} onPress={openFile} onLongPress={() => confirmDeleteMessage(item.id)}
              style={[{ maxWidth:W*0.74, marginVertical:3, padding:10, flexDirection:'row', alignItems:'center', gap:8 },
              item.mine
                ? { alignSelf:'flex-end', backgroundColor:P.bubbleMine, borderRadius:16, borderBottomRightRadius:4 }
                : { alignSelf:'flex-start', backgroundColor:P.bubbleTheirs, borderRadius:16,
                    borderBottomLeftRadius:4, borderWidth:0.5, borderColor:P.bubbleTheirsBorder }]}>
              <Icon name="file" size={20} color={item.mine ? P.bubbleMineText : AC} />
              <View style={{ flexShrink:1 }}>
                <Text numberOfLines={1} style={{ fontSize: typeof fontSize === 'number' ? fontSize : 15, color: item.mine ? P.bubbleMineText : P.bubbleTheirsText, maxWidth:180 }}>
                  {item.fileName || t('common.file')}
                </Text>
                <Text style={{ fontSize:11, marginTop:2, color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                  {fmtSize(item.size)}{item.time ? ' · ' + item.time : ''}
                  {item.mine ? '  ' + sendStatusIcon(item.status) : ''}
                </Text>
              </View>
            </TouchableOpacity>
            );
          }
          if (item.isLocation && item.lat != null && item.lng != null) {
            const coordsText = `${item.lat.toFixed(6)}, ${item.lng.toFixed(6)}`;
            // Audit P8: im Secret Chat keine Weitergabe an Karten-App/Zwischenablage.
            const secretLocation = secretActive || !!item.secret;
            const copyCoords = () => {
              copySensitive(coordsText).catch(() => {});
              Alert.alert(t('common.copied'), t('app.koordinatenInDieZwischenablageKopiert'));
            };
            return (
            <TouchableOpacity activeOpacity={0.8}
              onPress={() => (secretLocation
                ? Alert.alert(t('common.location'), t('app.imSecretChatLassenSich', { coordsText }))
                : Linking.openURL(`geo:${item.lat},${item.lng}?q=${item.lat},${item.lng}`).catch(() => {
                  // Kein Karten-App installiert, die geo:-URIs behandelt (kein
                  // erzwungenes Google Maps) - Koordinaten wenigstens als Fallback zeigen.
                  Alert.alert(t('common.location'), coordsText);
                }))}
              onLongPress={() => confirmDeleteMessage(item.id)}
              style={[{ maxWidth:W*0.74, marginVertical:3, padding:10, flexDirection:'row', alignItems:'center', gap:8 },
              item.mine
                ? { alignSelf:'flex-end', backgroundColor:P.bubbleMine, borderRadius:16, borderBottomRightRadius:4 }
                : { alignSelf:'flex-start', backgroundColor:P.bubbleTheirs, borderRadius:16,
                    borderBottomLeftRadius:4, borderWidth:0.5, borderColor:P.bubbleTheirsBorder }]}>
              <Icon name="map-pin" size={18} color={item.mine ? P.bubbleMineText : AC} />
              <View style={{ flexShrink:1 }}>
                <Text style={{ fontSize: typeof fontSize === 'number' ? fontSize : 15, color: item.mine ? P.bubbleMineText : P.bubbleTheirsText }}>
                  {t('common.location')}
                </Text>
                {/* Ortsname nur noch von aelteren Absendern (bis 1.1.0 per
                    Nominatim, siehe sendLocationMessage) - sonst die
                    Koordinaten. Malachi selbst fragt keinen Dienst. */}
                <Text numberOfLines={2} style={{ fontSize:12, marginTop:1, maxWidth:180,
                  color: item.mine ? P.bubbleMineText : P.bubbleTheirsText }}>
                  {item.address || coordsText}
                </Text>
                <Text style={{ fontSize:11, marginTop:2, color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                  {item.time}{item.mine ? '  ' + sendStatusIcon(item.status) : ''}
                </Text>
              </View>
              {!secretLocation && (
                <TouchableOpacity onPress={copyCoords} style={{ padding:6 }}>
                  <Icon name="copy" size={16} color={item.mine ? P.bubbleMineText : P.bubbleTheirsMeta} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
            );
          }
          const sKind = siegelKind(item.text);
          const siegelText = sKind === 'msg' ? extractSiegelMessage(item.text) : sKind ? String(item.text).trim() : null;
          if (siegelText) {
            const sTitle = sKind === 'invite' ? t('chat.siegelInvite') : sKind === 'ack' ? t('chat.siegelAck') : t('chat.siegelMessage');
            const sSub = item.mine
              ? (sKind === 'invite' ? t('chat.siegel.waitingAccept') : sKind === 'ack' ? t('chat.siegel.pairAccepted') : t('chat.siegel.onlyContactThem'))
              : (sKind === 'invite' ? t('chat.siegel.tapAccept') : sKind === 'ack' ? t('chat.siegel.tapFinish') : t('chat.siegel.tapDecrypt'));
            return (
              <TouchableOpacity activeOpacity={0.8}
                onPress={() => (item.mine ? siegelMessageMenu(item.id, siegelText, true) : openSiegel(siegelText))}
                onLongPress={() => siegelMessageMenu(item.id, siegelText, item.mine)}
                style={[{ maxWidth:W*0.74, marginVertical:3, padding:10 },
              item.mine
                ? { alignSelf:'flex-end', backgroundColor:P.bubbleMine, borderRadius:16, borderBottomRightRadius:4 }
                : { alignSelf:'flex-start', backgroundColor:P.bubbleTheirs, borderRadius:16,
                    borderBottomLeftRadius:4, borderWidth:0.5, borderColor:P.bubbleTheirsBorder }]}>
                <View style={{ flexDirection:'row', alignItems:'center', gap:8 }}>
                  <Icon name="lock" size={16} color={item.mine ? P.bubbleMineText : AC} />
                  <Text style={{ fontSize:15, fontWeight:'500', color: item.mine ? P.bubbleMineText : P.bubbleTheirsText }}>{sTitle}</Text>
                </View>
                <Text style={{ fontSize:12, marginTop:4, color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                  {sSub}
                </Text>
                <Text style={{ fontSize:11, marginTop:4, textAlign:'right', color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                  {item.time}{item.mine ? '  ' + sendStatusIcon(item.status) : ''}
                </Text>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity activeOpacity={1}
              onLongPress={() => (secretActive ? confirmDeleteMessage(item.id) : setMsgMenu({ id: item.id, text: String(item.text ?? '') }))}
              style={[{ maxWidth:W*0.74, marginVertical:3, padding:10 },
              item.mine
                ? { alignSelf:'flex-end', backgroundColor:P.bubbleMine, borderRadius:16, borderBottomRightRadius:4 }
                : { alignSelf:'flex-start', backgroundColor:P.bubbleTheirs, borderRadius:16,
                    borderBottomLeftRadius:4, borderWidth:0.5, borderColor:P.bubbleTheirsBorder }]}>
              <Text style={{ fontSize: typeof fontSize === 'number' ? fontSize : 15, color: item.mine ? P.bubbleMineText : P.bubbleTheirsText, lineHeight: typeof fontSize === 'number' ? fontSize + 7 : 22 }}>
                {item.text}
              </Text>
              <Text style={{ fontSize:11, marginTop:4, textAlign:'right',
                color: item.mine ? P.bubbleMineMeta : P.bubbleTheirsMeta }}>
                {item.time}{item.mine ? (
                  // (Vorher '  ' + <Text/> - ergab "[object Object]".)
                  item.status === 'read'
                    ? <Text>{'  '}<Text style={{ color: P.bubbleMineText }}>✓✓✓</Text></Text>
                    : '  ' + sendStatusIcon(item.status)
                ) : ''}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
      </View>

      {chat?.wiped ? (
        <View style={{ padding:16, alignItems:'center', backgroundColor:P.surface, borderTopWidth:0.5, borderTopColor:P.border }}>
          <Text style={{ fontSize:13, color:P.textMuted, textAlign:'center' }}>
            {t('chat.wipedNotice')}
          </Text>
        </View>
      ) : audioPreview && !recording ? (
        // Vorschau nach der Aufnahme IM Eingabefeld (Nutzerwunsch 29.10.2026,
        // "wie bei WhatsApp") - dieselbe Leiste wie Gruppenchat und Siegel
        // (VoiceDraft.tsx); hier zusaetzlich "loescht sich nach Anhoeren".
        <View style={{ backgroundColor: secretActive ? P.bg : P.surface, borderTopWidth:0.5,
          borderTopColor: secretActive ? P.surfaceAlt : P.border, paddingHorizontal:10, paddingVertical:10 }}>
          {viewOnceAudio && (
            <Text style={{ fontSize:11, color:P.textMuted, marginBottom:6, marginLeft:42 }}>⚡ {t('chat.viewOnceHint')}</Text>
          )}
          <VoiceDraftBar colors={{ surfaceAlt:P.surfaceAlt, border:P.border, text:P.text, textSub:P.textSub, danger:P.danger, accent:AC, onAccent:P.onAccent }}
            draft={audioPreview} playing={previewPlaying} position={previewProgress.position} duration={previewProgress.duration}
            waveStyle={waveStyle} canResume={canAppendRecording(audioPreview.base64) && audioPreview.durationMs < MAX_VOICE_MS}
            onDiscard={discardPreview} onPlay={playPreview} onSeek={seekPreview} onResume={resumeRecording} onSend={sendAudioPreview}
            extraWidth={36}
            extra={(
              <TouchableOpacity testID="voice-preview-viewonce" onPress={() => setViewOnceAudio(v => !v)}
                accessibilityRole="switch" accessibilityState={{ checked: viewOnceAudio }} accessibilityLabel={t('chat.viewOnceHint')}
                style={{ width:36, height:40, alignItems:'center', justifyContent:'center' }}>
                <Icon name="zap" size={19} color={viewOnceAudio ? AC : P.textMuted} />
              </TouchableOpacity>
            )} />
        </View>
      ) : (
      <View style={{ flexDirection:'row', padding:10, gap:8, alignItems:'center',
        backgroundColor: secretActive ? P.bg : P.surface, borderTopWidth:0.5, borderTopColor: secretActive ? P.surfaceAlt : P.border }}>
        {recording ? (
          <View style={{ flex:1, flexDirection:'row', alignItems:'center', gap:8,
            backgroundColor:P.surfaceAlt, borderRadius:20, borderWidth:0.5,
            borderColor:P.danger, paddingHorizontal:14, paddingVertical:6 }}>
            <View style={{ width:8, height:8, borderRadius:4, backgroundColor:P.danger }} />
            <Text style={{ fontSize:14, color:P.text, fontVariant:['tabular-nums'] }}
              accessibilityLabel={t('chat.recording', { time: String(Math.floor(recordSecs/60)).padStart(2,'0') + ':' + String(recordSecs%60).padStart(2,'0') })}>
              {String(Math.floor(recordSecs/60)).padStart(2,'0') + ':' + String(recordSecs%60).padStart(2,'0')}
            </Text>
            {/* Live-Pegel (VoiceWave.js) - zeichnet nur sich selbst neu */}
            <View style={{ flex:1, alignItems:'flex-end', overflow:'hidden' }}>
              <LiveRecordingWave testID="voice-live-wave" feed={levelFeedRef.current} variant={waveStyle}
                width={Math.max(60, Math.round(W - 20 - 3 * 40 - 3 * 8 - 28 - 16 - 46 - 16))} height={24} color={P.danger} />
            </View>
          </View>
        ) : (
        <TextInput
          style={{ flex:1, backgroundColor:P.surfaceAlt, borderRadius:20, borderWidth:0.5,
            borderColor:P.border, paddingHorizontal:14, paddingVertical:8,
            fontSize:15, color:P.text }}
          value={text} onChangeText={setText}
          placeholder={t('chat.placeholder')} placeholderTextColor={P.textMuted}
          // Audit P10: im Secret Chat keine Vorschlaege/Autokorrektur - die
          // Tastatur bekommt "keine Vorschlaege" gemeldet (Android:
          // TYPE_TEXT_FLAG_NO_SUGGESTIONS) und lernt dort weniger mit.
          autoCorrect={!secretActive} spellCheck={!secretActive}
          autoComplete={secretActive ? 'off' : undefined}
          importantForAutofill={secretActive ? 'no' : 'auto'}
          multiline maxLength={2000} />
        )}
        {/* Design-Feedback: Bild/Datei/Standort waren drei einzelne Icons
            nebeneinander (wie bei WhatsApp jetzt in einem Anhang-Dropdown
            gebuendelt) - macht Platz fuer ein groesseres Texteingabefeld.
            Sprachnachricht bleibt bewusst die EINZIGE Ausnahme als direkter
            Button (siehe toggleRecording oben). */}
        <TouchableOpacity
          style={{ width:40, height:40, borderRadius:20, backgroundColor:P.surfaceAlt,
            alignItems:'center', justifyContent:'center', borderWidth:0.5, borderColor:P.border }}
          onPress={() => setAttachMenuOpen(true)} activeOpacity={0.8}>
          <Icon name="plus" size={20} color={AC} />
        </TouchableOpacity>
        <TouchableOpacity
          style={{ width:40, height:40, borderRadius:20,
            backgroundColor: recording ? P.dangerFill : P.surfaceAlt,
            alignItems:'center', justifyContent:'center', borderWidth:0.5,
            borderColor: recording ? P.dangerFill : P.border }}
          // 1,5 s halten (Nutzerwunsch: 3 s fuehlte sich stockend an): Umschalten
          // Mikrofon <-> Siegel (Schloss) - unauffaellig,
          // ohne sichtbaren Siegel-Knopf.
          onPress={siegelMode ? () => openSiegel(null) : toggleRecording}
          onLongPress={toggleSiegelMode} delayLongPress={1500} activeOpacity={0.8}>
          <Icon name={recording ? 'square' : siegelMode ? 'lock' : 'mic'} size={20} color={recording ? P.onDanger : AC} />
        </TouchableOpacity>
        <TouchableOpacity
          style={{ width:40, height:40, borderRadius:20, backgroundColor:AC,
            alignItems:'center', justifyContent:'center' }}
          // Design-Feedback: Sprachnachrichten auch ohne Vorschau verschickbar,
          // aber ueber den regulaeren Senden-Knopf statt einer Halten-Geste -
          // waehrend eine Aufnahme laeuft, sendet er sie direkt (Mikrofon-Tap
          // zum Stoppen zeigt weiterhin die Vorschau-Leiste als Alternative).
          onPress={() => (recording ? stopRecordingAndSendNow() : send())} activeOpacity={0.8}>
          <Text style={{ fontSize:18, color:P.onAccent }}>{FORWARD_ARROW}</Text>
        </TouchableOpacity>

        <Modal visible={attachMenuOpen} transparent animationType="fade" onRequestClose={() => setAttachMenuOpen(false)}>
          <TouchableOpacity style={{ flex:1 }} activeOpacity={1} onPress={() => setAttachMenuOpen(false)}>
            <View style={{ position:'absolute', left:16, bottom:70, backgroundColor:P.menuBg,
              borderRadius:12, borderWidth:0.5, borderColor:P.menuBorder, overflow:'hidden', minWidth:190,
              elevation:6, shadowColor:'#000', shadowOpacity:0.15, shadowRadius:8, shadowOffset:{width:0,height:2} }}>
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => { setAttachMenuOpen(false); pickAndSendImage(); }}>
                <Icon name="image" size={16} color={P.menuIcon} />
                <Text style={{ fontSize:14, color:P.menuText }}>{t('common.image')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => { setAttachMenuOpen(false); pickAndSendFile(); }}>
                <Icon name="file" size={16} color={P.menuIcon} />
                <Text style={{ fontSize:14, color:P.menuText }}>{t('common.file')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity
                style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:12, paddingHorizontal:14 }}
                onPress={() => { setAttachMenuOpen(false); sendLocation(); }}>
                <Icon name="map-pin" size={16} color={P.menuIcon} />
                <Text style={{ fontSize:14, color:P.menuText }}>{t('common.location')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      </View>
      )}
      <Modal visible={!!msgMenu} transparent animationType="fade" onRequestClose={() => setMsgMenu(null)}>
        <TouchableOpacity style={{ flex:1, backgroundColor:P.overlay, justifyContent:'center', padding:32 }} activeOpacity={1} onPress={() => setMsgMenu(null)}>
          {msgMenu && (
            <View style={{ backgroundColor:P.menuBg, borderRadius:14, borderWidth:0.5, borderColor:P.menuBorder, overflow:'hidden',
              elevation:6, shadowColor:'#000', shadowOpacity:0.15, shadowRadius:8, shadowOffset:{width:0,height:2} }}>
              <Text numberOfLines={3} style={{ fontSize:13, lineHeight:18, color:P.menuText, opacity:0.8, paddingVertical:12, paddingHorizontal:16 }}>
                {msgMenu.text}
              </Text>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity accessibilityRole="button" style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                onPress={() => { const t = msgMenu.text; setMsgMenu(null); copyMessageText(t); }}>
                <Icon name="copy" size={16} color={P.menuIcon} />
                <Text style={{ fontSize:14, color:P.menuText }}>{t('siegel.copy')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity accessibilityRole="button" style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                onPress={() => { const id = msgMenu.id; setMsgMenu(null); confirmDeleteMessage(id); }}>
                <Icon name="trash-2" size={16} color={P.menuDanger} />
                <Text style={{ fontSize:14, color:P.menuDanger }}>{t('common.delete')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </TouchableOpacity>
      </Modal>
      {copyNotice && (
        <View pointerEvents="none" accessibilityLiveRegion="polite"
          style={{ position:'absolute', left:24, right:24, bottom:96, alignItems:'center' }}>
          <Text style={{ backgroundColor:P.menuBg, color:P.menuText, borderWidth:0.5, borderColor:P.menuBorder, borderRadius:12,
            paddingVertical:8, paddingHorizontal:14, fontSize:13, overflow:'hidden' }}>
            {t('app.kopiertWirdNach60S')}
          </Text>
        </View>
      )}
      <Modal visible={!!siegelMenu} transparent animationType="fade" onRequestClose={() => setSiegelMenu(null)}>
        <TouchableOpacity style={{ flex:1, backgroundColor:P.overlay, justifyContent:'center', padding:32 }} activeOpacity={1} onPress={() => setSiegelMenu(null)}>
          {siegelMenu && (
            <View style={{ backgroundColor:P.menuBg, borderRadius:14, borderWidth:0.5, borderColor:P.menuBorder, overflow:'hidden',
              elevation:6, shadowColor:'#000', shadowOpacity:0.15, shadowRadius:8, shadowOffset:{width:0,height:2} }}>
              <View style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}>
                <Icon name="lock" size={16} color={P.menuAccent} />
                <Text style={{ fontSize:15, fontWeight:'600', color:P.menuText }}>{t('chat.siegelMessage')}</Text>
              </View>
              {siegelMenu.mine && (
                <Text style={{ fontSize:12, lineHeight:17, color:P.menuText, opacity:0.8, paddingHorizontal:16, paddingBottom:10 }}>
                  {t('chat.siegelOwnMessage')}
                </Text>
              )}
              {!siegelMenu.mine && (
                <>
                  <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
                  <TouchableOpacity style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                    onPress={() => { const t = siegelMenu.text; setSiegelMenu(null); openSiegel(t); }}>
                    <Icon name="unlock" size={16} color={P.menuIcon} />
                    <Text style={{ fontSize:14, color:P.menuText }}>{t('common.decrypt')}</Text>
                  </TouchableOpacity>
                </>
              )}
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                onPress={() => { const t = siegelMenu.text; setSiegelMenu(null); copySiegelCipher(t); }}>
                <Icon name="copy" size={16} color={P.menuIcon} />
                <Text style={{ fontSize:14, color:P.menuText }}>{t('chat.copyCipher')}</Text>
              </TouchableOpacity>
              <View style={{ height:0.5, backgroundColor:P.menuBorder }} />
              <TouchableOpacity style={{ flexDirection:'row', alignItems:'center', gap:10, paddingVertical:13, paddingHorizontal:16 }}
                onPress={() => { const id = siegelMenu.id; setSiegelMenu(null); confirmDeleteMessage(id); }}>
                <Icon name="trash-2" size={16} color={P.menuDanger} />
                <Text style={{ fontSize:14, color:P.menuDanger }}>{t('common.delete')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </TouchableOpacity>
      </Modal>
      <SiegelScreen visible={!!siegelMsg} initialMessage={siegelMsg?.msg || null} initialMedia={siegelMsg?.media || null} onClose={() => setSiegelMsg(null)}
        canSeal={getLicenseState().pro === true}
        chatId={chat?.id} chatName={chat?.name || ''}
        onSendCipher={(cipher) => sendTextNow(cipher)}
        onSendFile={(b64, fileName, mime) => sendFileNow(b64, fileName, mime).catch((e) => console.error('[Siegel] Anhang senden fehlgeschlagen:', e?.message || e))} />
    </View>
    </KeyboardAvoidingView>
  );
}
function CallScreen({ chat, callManager, callState, remoteStream, videoOn, remoteVideoOn, onEnd }) {
  const [secs, setSecs]   = useState(0);
  const [micOn, setMicOn] = useState(true);
  // videoOn/remoteVideoOn kommen als React-State von AppInner (callManager.
  // video/.remoteVideo sind normaler Instanz-State, keine Hooks - ohne diesen
  // Umweg wuerde toggleVideo() waehrend eines laufenden Gesprächs (siehe
  // Nutzerwunsch "zwischen Anruf und Videoanruf wechseln") die UI nicht
  // neu rendern).
  const isVideoCall = !!remoteVideoOn;
  // Videoanrufe: lokaler Vorschau-Stream ist nicht ueber React-State erreichbar
  // (callManager.localStream ist normaler Instanz-State, kein Hook) - reicht
  // hier, da CallScreen ohnehin waehrend CONNECTING/ACTIVE laufend re-rendert
  // (Sekunden-Timer oben), sobald _getLocalStream() also fertig ist, zeigt
  // der naechste Render die Vorschau von selbst.
  const localStream = callManager?.localStream || null;

  // Läuft nur während eines aktiven Gesprächs - callManager.getDuration()
  // basiert auf callStartTime (ab ICE "connected"), nicht auf Bildschirmzeit.
  React.useEffect(() => {
    if (callState !== CallState.ACTIVE) { setSecs(0); return; }
    setSecs(callManager?.getDuration() || 0);
    const t = setInterval(() => setSecs(callManager?.getDuration() || 0), 1000);
    return () => clearInterval(t);
  }, [callState, callManager]);

  // Mic-Status zurücksetzen, sobald ein neuer Anruf beginnt.
  React.useEffect(() => { setMicOn(true); }, [callManager]);

  // Lautsprecher (CallAudioRoute.js). Der tatsaechliche Ausgang kommt von
  // Telecom zurueck - auch wenn er ueber das System (Bluetooth, Benachrichtigung)
  // gewechselt wird. Videoanrufe laufen wie bei anderen Messengern automatisch
  // ueber den Lautsprecher, solange man nicht selbst umgeschaltet hat.
  const [speakerOn, setSpeakerOn] = useState(false);
  const speakerTouched = React.useRef(false);
  const speakerSupported = isCallSpeakerSupported();
  React.useEffect(() => onCallAudioRoute((route) => setSpeakerOn(route === AUDIO_ROUTE_SPEAKER)), []);
  React.useEffect(() => { setSpeakerOn(false); speakerTouched.current = false; }, [callManager]);
  const switchSpeaker = async (next, byUser) => {
    if (byUser) speakerTouched.current = true;
    setSpeakerOn(next);
    const ok = await callManager?.setSpeaker?.(next);
    if (!ok) setSpeakerOn(!next);
  };
  const wantsVideo = !!videoOn || isVideoCall;
  React.useEffect(() => {
    if (wantsVideo && callState === CallState.ACTIVE && !speakerTouched.current && !speakerOn) switchSpeaker(true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsVideo, callState]);

  const fmt = s => String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');

  const statusText = {
    [CallState.PREPARING]:        t('common.connectingViaTor'),
    [CallState.OUTGOING_RINGING]: t('call.status.ringing'),
    [CallState.INCOMING_RINGING]: isVideoCall ? t('call.status.incomingVideo') : t('call.status.incoming'),
    [CallState.CONNECTING]:       t('common.connectingDots'),
    [CallState.ACTIVE]:           fmt(secs),
    [CallState.ENDED]:            t('call.status.ended'),
  }[callState] || '';

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    callManager?.toggleMute(!next);
  };

  const isIncoming = callState === CallState.INCOMING_RINGING;
  // Farben aus dem Design (vorher fest Nachtblau/Weiss/Rot). Ueber dem Video
  // des Gegenuebers bleibt die Schrift weiss mit Schatten (lesbar auf jedem Bild).
  const overVideo = isVideoCall && !!remoteStream;
  const onSuccess = bestOn(P.success);

  return (
    <View style={{ flex:1, backgroundColor:P.bg }}>
      <View style={{ backgroundColor:P.surfaceAlt, flex:1, paddingHorizontal: isVideoCall ? 0 : 24, alignItems:'center', justifyContent:'center' }}>
        {isVideoCall && remoteStream ? (
          <RTCView streamURL={remoteStream.toURL()} style={{ position:'absolute', top:0, left:0, right:0, bottom:0 }} objectFit="cover" />
        ) : null}
        {videoOn && localStream ? (
          <View style={{ position:'absolute', top:16, right:16, width:96, height:128, borderRadius:12,
            overflow:'hidden', borderWidth:1.5, borderColor:'rgba(255,255,255,0.4)' }}>
            <RTCView streamURL={localStream.toURL()} style={{ width:'100%', height:'100%' }} objectFit="cover" mirror zOrder={1} />
          </View>
        ) : null}
        {(!isVideoCall || !remoteStream) && (
          <View style={{ position:'relative', marginBottom:16 }}>
            {chat && <Avatar c={chat} size={88} />}
            <View style={{ position:'absolute', bottom:2, right:2, width:18, height:18,
              borderRadius:9, backgroundColor:P.online, borderWidth:2.5, borderColor:P.surfaceAlt }} />
          </View>
        )}
        <Text style={{ fontSize:22, fontWeight:'500', color: overVideo ? '#FFFFFF' : P.text, marginBottom:4,
          textShadowColor: overVideo ? 'rgba(0,0,0,0.6)' : 'transparent', textShadowRadius:6 }}>{chat?.name}</Text>
        <Text style={{ fontSize:13, color: overVideo ? '#FFFFFF' : P.textMuted, marginBottom:12,
          textShadowColor: overVideo ? 'rgba(0,0,0,0.6)' : 'transparent', textShadowRadius:6 }}>{t('call.encryptedLine')}</Text>
        <Text style={{ fontSize: callState === CallState.ACTIVE ? 36 : 17, fontWeight:'300', color: overVideo ? '#FFFFFF' : P.accentFg, letterSpacing: callState === CallState.ACTIVE ? 2 : 0,
          textShadowColor: overVideo ? 'rgba(0,0,0,0.6)' : 'transparent', textShadowRadius:6 }}>
          {statusText}
        </Text>
        {/* Hinweis bei Sprache ueber Tor in eigener, kleiner Zeile - angehaengt an die
            36-pt-Dauer brach er bisher ueber zwei riesige Zeilen um (Geraetetest 1.3.0). */}
        {callState === CallState.ACTIVE && callManager?.viaChannelAudio ? (
          <Text style={{ fontSize:13, color: overVideo ? '#FFFFFF' : P.textMuted, marginTop:6,
            textShadowColor: overVideo ? 'rgba(0,0,0,0.6)' : 'transparent', textShadowRadius:6 }}>{t('call.status.viaTor')}</Text>
        ) : null}
      </View>

      <View style={{ padding:20, paddingTop:24, gap:12 }}>
        <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5,
          borderColor:P.border, padding:12, paddingHorizontal:16,
          flexDirection:'row', alignItems:'center', gap:10 }}>
          <View style={{ width:8, height:8, borderRadius:4, backgroundColor:P.online }} />
          <View>
            <Text style={{ fontSize:11, fontWeight:'500', color:P.accentFg }}>{t('call.e2e')}</Text>
            <Text style={{ fontSize:10, color:P.textMuted }}>WebRTC · DTLS-SRTP</Text>
          </View>
        </View>

        {isIncoming ? (
          <View style={{ flexDirection:'row', gap:12 }}>
            <TouchableOpacity
              style={{ flex:1, height:56, borderRadius:20, backgroundColor:P.dangerFill,
                alignItems:'center', justifyContent:'center' }}
              accessibilityLabel={t('app.ablehnen')}
              onPress={() => callManager?.rejectCall()} activeOpacity={0.85}>
              <Icon name="phone-off" size={22} color={P.onDanger} />
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flex:1, height:56, borderRadius:20, backgroundColor:P.success,
                alignItems:'center', justifyContent:'center' }}
              accessibilityLabel={t('app.annehmen')}
              onPress={() => callManager?.acceptCall()} activeOpacity={0.85}>
              <Icon name="phone" size={22} color={onSuccess} />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flexDirection:'row', gap:16, justifyContent:'center' }}>
            <TouchableOpacity
              style={{ width:56, height:56, borderRadius:28,
                backgroundColor: micOn ? P.surfaceAlt : P.dangerFill,
                alignItems:'center', justifyContent:'center',
                borderWidth:0.5, borderColor: micOn ? P.borderStrong : P.dangerFill }}
              accessibilityLabel={micOn ? t('app.stummschalten') : t('app.mikrofonAn')}
              onPress={toggleMic} activeOpacity={0.85}>
              <Icon name={micOn ? 'mic' : 'mic-off'} size={22} color={micOn ? P.accentFg : P.onDanger} />
            </TouchableOpacity>
            {speakerSupported && (
              <TouchableOpacity
                testID="call-speaker"
                style={{ width:56, height:56, borderRadius:28,
                  backgroundColor: speakerOn ? P.accent : P.surfaceAlt,
                  alignItems:'center', justifyContent:'center',
                  borderWidth:0.5, borderColor: speakerOn ? P.accent : P.borderStrong }}
                accessibilityRole="switch" accessibilityState={{ checked: speakerOn }}
                accessibilityLabel={speakerOn ? t('groupCall.hoererStattLautsprecher') : t('groupCall.lautsprecher')}
                onPress={() => switchSpeaker(!speakerOn, true)} activeOpacity={0.85}>
                <Icon name={speakerOn ? 'volume-2' : 'volume-1'} size={22} color={speakerOn ? P.onAccent : P.accentFg} />
              </TouchableOpacity>
            )}
            {callState === CallState.ACTIVE && (
              <TouchableOpacity
                style={{ width:56, height:56, borderRadius:28,
                  backgroundColor: videoOn ? P.accent : P.surfaceAlt,
                  alignItems:'center', justifyContent:'center',
                  borderWidth:0.5, borderColor: videoOn ? P.accent : P.borderStrong }}
                accessibilityLabel={videoOn ? t('app.kameraAus') : t('app.kameraAn')}
                onPress={() => callManager?.toggleVideo()} activeOpacity={0.85}>
                <Icon name={videoOn ? 'video' : 'video-off'} size={22} color={videoOn ? P.onAccent : P.accentFg} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={{ width:56, height:56, borderRadius:28, backgroundColor:P.dangerFill,
                alignItems:'center', justifyContent:'center' }}
              accessibilityLabel={t('app.auflegen')}
              onPress={() => (callManager ? callManager.endCall('user_hangup') : onEnd?.())} activeOpacity={0.85}>
              <Icon name="phone-off" size={22} color={P.onDanger} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

// Kurzer, immer sichtbarer Teaser statt langer, permanent ausgeschriebener
// Technik-Erklaerung (Design-Feedback: wirkte auf dem Connect-Screen
// ueberladen) - Tap klappt den vollen Text auf/zu. Ein Chevron zeigt den
// Zustand an, damit klar ist dass hier interagiert werden kann.
function CollapsibleNotice({ teaser, children, icon = 'shield' }) {
  const [open, setOpen] = React.useState(false);
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => setOpen(o => !o)}
      style={{ backgroundColor:P.surface, borderRadius:12, padding:12 }}>
      <View style={{ flexDirection:'row', alignItems:'center', gap:8 }}>
        <Icon name={icon} size={13} color={P.textMuted} />
        <Text style={{ fontSize:11, color:P.textMuted, flex:1 }}>{teaser}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={P.textMuted} />
      </View>
      {open && (
        <Text style={{ fontSize:11, color:P.textMuted, lineHeight:16, marginTop:8 }}>
          {children}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// Kopplung (Okt. 2026: komplett serverlos). Einziger Weg: ueber Tor. Der
// QR-Code/Link traegt Token, Einmal-Geheimnis (PSK) und die Onion-Adresse des
// Einladenden; das scannende Handy verbindet sich ueber Tor dorthin, beide
// melden sich mit dem PSK gegenseitig an (TorTransport.pairViaTor/
// registerPairingInvite), danach Kyber-Schluesseltausch ueber den Kanal. Erst
// wenn der fertig ist, wird der Kontakt angelegt. Die schnellere
// Direktverbindung wird anschliessend automatisch ueber Tor ausgehandelt
// (DirectUpgrade.js). Die fruehere Kopplung ueber den Treffpunkt-Server und
// die Suche per Telefonnummer gibt es nicht mehr.
// Kopplung (scannende Seite): bis zu 3 min durchgehend versuchen, nach 15 s
// ein paralleler Versuch mit eigenen Tor-Kreisen, sofort ein frischer, sobald
// die Beschreibung des Einladenden eintrifft; kommt sie 60 s lang nicht, haengt
// tor - dann einmal frisch starten (Live-Test 2026-10-18: 6 min ohne
// Beschreibung, der Einladende hatte inzwischen einen neuen Code).
const PAIR_TOTAL_MS = 180000;
const PAIR_HEDGE_MS = 15000;
const PAIR_TOR_STUCK_MS = 60000;
// Nach erfolgreicher Tor-Anmeldung: so lange auf den Schluesseltausch warten.
const PAIR_KEY_EXCHANGE_WAIT_MS = 30000;

function ConnectScreen({ onBack, onConnected, deepLinkToken }) {
  const [mode,       setMode]      = useState('generate');
  const [input,      setInput]     = useState('');
  const [status,     setStatus]    = useState('idle');
  const [statusDetail, setStatusDetail] = useState('');
  // Unterscheidet die Fehlerursache fuer die Anzeige (falscher Code, alte
  // Einladung ohne Tor-Adresse, Kontakt nicht erreichbar).
  const [errorReason, setErrorReason] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [invite,     setInvite]    = useState(null);   // { token, pskHex }
  const [inviteError, setInviteError] = useState('');
  const [torSt,      setTorSt]     = useState(getTorState());
  const [inviteWaitOver, setInviteWaitOver] = useState(false);
  const [codeCopied, setCodeCopied]= useState(false);
  // Die zuerst fertige Kopplung gewinnt, jede weitere wird geschlossen.
  const pairedRtc   = useRef(null);
  const connected   = useRef(false);
  // Laeuft schon eine Kopplung (Scan + Tippen auf "Verbinden", Deep Link),
  // keine zweite parallel starten - sie koennte einen zweiten Kontakt anlegen.
  const pairingRunning = useRef(false);
  const mounted     = useRef(true);
  // Immer die aktuelle onConnected-Prop: eine Tor-Kopplung kann deutlich
  // laenger dauern als ein Render.
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Die gespeicherte Kontakt-ID wird aus Token + PSK abgeleitet (SHA-256):
  // das PSK kennen nur die beiden koppelnden Geraete, das Ergebnis ist voll-
  // entropisch und fuer Dritte nicht vorhersagbar (Sicherheitsreview 3). Der
  // 8-stellige Token allein waere zu kollisionsanfaellig.
  // Gemeinsam mit der Vorstellung ueber Gruppen (PairingIds.js).
  const deriveContactId = deriveSharedContactId;

  // Tor muss laufen: die Einladung braucht die eigene Onion-Adresse, die
  // Annahme einer Einladung die Verbindung dorthin.
  React.useEffect(() => {
    mounted.current = true;
    ensureTorRunning();
    const unsub = onTorState(setTorSt);
    return () => { mounted.current = false; unsub(); };
  }, []);

  // Solange die eigene Onion-Adresse noch nicht als erreichbar bestaetigt ist:
  // alle 10 s Selbsttest (statt auf den 30-s-Starttest zu warten), nach 90 s
  // den QR-Code notfalls trotzdem zeigen.
  const torOnNow = torSt.status === 'ON';
  React.useEffect(() => {
    if (!torOnNow || torSt.reachable) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 90000) { setInviteWaitOver(true); clearInterval(t); return; }
      runSelfTest().catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [torOnNow, torSt.reachable]);

  React.useEffect(() => {
    // Deep Link Token automatisch einfuegen und nach einer Rueckfrage direkt
    // verbinden. Audit 2026-09-28: ein malachi://connect/...-Link kann von
    // JEDER Quelle kommen (Webseite, fremde Nachricht, NFC-Tag) - ohne
    // Rueckfrage koppelte die App dann still mit einem Fremden.
    if (deepLinkToken) {
      setMode('enter');
      setInput(deepLinkToken);
      Alert.alert(
        t('connect.deepLink.title'),
        t('connect.deepLink.body'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('common.connect'), onPress: () => handleConnect(deepLinkToken) },
        ],
        { cancelable: true },
      );
    }
  }, [deepLinkToken]);

  // Eigene Einladung: Token + Einmal-Geheimnis erzeugen und bei TorTransport
  // anmelden. Das Geheimnis reist nur im QR-Code/Link, nie ueber ein Netz.
  // Live-Test 2026-10-18: beim erneuten Oeffnen entstand ein NEUER Code - der
  // Kontakt scannte noch den alten ("keine offene Einladung"). Jetzt bleibt die
  // Einladung bis zu 25 min dieselbe, auch nach Verlassen des Bildschirms;
  // eine Kopplung in dieser Zeit wird im Hintergrund abgeschlossen.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const { Buffer: Buf } = require('buffer');
      let inv = OPEN_INVITE && Date.now() - OPEN_INVITE.createdAt < OPEN_INVITE_REUSE_MS ? OPEN_INVITE : null;
      if (!inv) {
        const token = Buf.from(await NativeModules.KyberModule.randomBytes(4), 'base64').toString('hex').toUpperCase();
        const pskB64 = await NativeModules.KyberModule.randomBytes(16);
        const pskHex = Buf.from(pskB64, 'base64').toString('hex');
        // Kontakt-ID VORAB ableiten - die Kopplungssitzung braucht sie sofort
        // (Schluessel werden unter ihr gespeichert).
        const contactId = await deriveContactId(token, pskHex);
        inv = { token, pskB64, pskHex, contactId, createdAt: Date.now() };
        OPEN_INVITE = inv;
      }
      if (cancelled) return;
      const { token, pskB64, pskHex, contactId } = inv;
      registerPairingInvite(token, {
        pskB64, contactId,
        onPaired: (torRtc) => {
          if (OPEN_INVITE?.token === token) OPEN_INVITE = null;   // verbraucht
          const newContact = { id: contactId, name: t('connect.newContact'), initials: t('connect.newContact').slice(0, 1).toUpperCase(), color: '#0A2340', tc: '#0A7EA4', last: t('connect.connectedViaTor'), time: t('connect.now'), unread: 0, role: 'initiator' };
          if (!mounted.current) {
            console.log('[Connect] Kopplung ueber Tor ✅ (im Hintergrund)');
            BACKGROUND_PAIRED?.(newContact, torRtc);
            return;
          }
          if (!connected.current) {
            connected.current = true;
            pairedRtc.current = torRtc;
            console.log('[Connect] Kopplung ueber Tor ✅');
            onConnectedRef.current(newContact, torRtc);
          } else if (pairedRtc.current !== torRtc) {
            try { torRtc.close(); } catch {}
          }
        },
      });
      setInvite({ token, pskHex });
    })().catch((e) => {
      console.warn('[Connect] Einladung konnte nicht erstellt werden:', e?.message || e);
      if (!cancelled) setInviteError(t('connect.inviteFailed'));
    });
    // Bewusst KEIN Abmelden beim Verlassen: die Einladung gilt weiter
    // (TorTransport laesst sie nach 30 min verfallen).
    return () => { cancelled = true; };
  }, []);

  const onionHost = torSt.status === 'ON' && torSt.onion ? torSt.onion.replace(/\.onion$/, '') : '';
  // QR-Code erst zeigen, wenn die eigene Onion-Adresse im Tor-Netz nachweislich
  // auffindbar ist (Selbsttest). Vorher scheitert der Scan mit "nicht gefunden",
  // und tor fragt dieselbe Adresse danach bis zu 15 min nicht erneut ab
  // (Live-Test 2026-10-17). Notfalls nach 90 s trotzdem anzeigen.
  const inviteReady = !!(invite && onionHost && (torSt.reachable || inviteWaitOver));
  const myCode = invite ? `SC1-${invite.token.slice(0, 4)}-${invite.token.slice(4, 8)}` : 'SC1-XXXX-XXXX';
  const myDeepLink = inviteReady ? `malachi://connect/${invite.token}.${invite.pskHex}.${onionHost}` : '';
  const myFullCode = inviteReady ? `${myCode}.${invite.pskHex}.${onionHost}` : '';

  const handleConnect = async (rawOverride) => {
    // Optionaler Override statt des `input`-States: der Deep-Link-/Scanner-
    // Pfad ruft handleConnect() im selben Tick wie setInput() auf - der State
    // ist da noch nicht committed (React-Stale-Closure).
    const source = rawOverride ?? input;
    if (!source.trim()) return;
    if (pairingRunning.current) {
      console.log('[Connect] Kopplung laeuft bereits - zweiter Start ignoriert');
      return;
    }
    // Robuste Extraktion statt striktem Prefix-Abschneiden: Scanner geben den
    // Link teils anders formatiert wieder (Leerzeichen statt "://" usw.).
    const match = source.match(/([0-9A-F]{4}-?[0-9A-F]{4})\.([0-9A-F]{32})/i);
    if (!match) {
      setErrorReason(t('connect.err.invalidCode'));
      setStatus('error');
      return;
    }
    const token = match[1].replace(/-/g, '').toUpperCase();
    // Kleinschreibung erzwingen: die Kontakt-ID wird aus genau diesem Text
    // abgeleitet. Ein (z.B. per Tastatur) gross geschriebener PSK ergaebe auf
    // beiden Geraeten verschiedene Kontakt-IDs - die Tor-Anmeldung scheiterte
    // danach fuer immer ("unbekannter Kontakt").
    const pskHex = match[2].toLowerCase();
    const onion = onionFromInvite(source);
    if (!onion) {
      setErrorReason(t('connect.err.noOnion'));
      setStatus('error');
      return;
    }
    pairingRunning.current = true;
    connected.current = false;
    pairedRtc.current = null;
    setStatus('connecting');
    setErrorReason('');
    try {
      const { Buffer: Buf } = require('buffer');
      const pskB64 = Buf.from(pskHex, 'hex').toString('base64');
      // Kontakt-ID VORAB ableiten und der Sitzung sofort mitgeben - der
      // Schluesseltausch speichert das Secret unter genau dieser ID.
      const contactId = await deriveContactId(token, pskHex);
      // Wird erst NACH dem fertigen Schluesseltausch aufgerufen (TorTransport).
      const winPairing = (rtcWon) => {
        if (!connected.current) {
          connected.current = true;
          pairedRtc.current = rtcWon;
          const newContact = { id: contactId, name: t('connect.newContact'), initials: t('connect.newContact').slice(0, 1).toUpperCase(), color: '#0A2340', tc: '#0A7EA4', last: t('connect.connectedViaTor'), time: t('connect.now'), unread: 0, role: 'responder', torOnion: onion };
          RTCStore.setConnection(contactId, rtcWon);
          GLOBAL_RTC = rtcWon;
          onConnectedRef.current(newContact, rtcWon);
        } else if (pairedRtc.current !== rtcWon) {
          try { rtcWon.close(); } catch {}
        }
      };
      const started = Date.now();
      let inFlight = 0;
      let lastLaunch = 0;
      let torRestarted = false;
      let keyExchange = false;
      const launch = () => {
        inFlight++;
        lastLaunch = Date.now();
        pairViaTor({ onion, token, pskB64, contactId, onPaired: winPairing }).then(async (session) => {
          if (session && !connected.current) {
            // Angemeldet - jetzt laeuft der Schluesseltausch ueber den Kanal.
            keyExchange = true;
            if (mounted.current) setStatusDetail(t('connect.status.keyExchange'));
            const until = Date.now() + PAIR_KEY_EXCHANGE_WAIT_MS;
            while (!connected.current && !session._closed && Date.now() < until) {
              await new Promise(r => setTimeout(r, 250));
            }
            if (!connected.current) { keyExchange = false; try { session.close(); } catch {} }
          }
        }).catch(() => {}).finally(() => { inFlight--; });
      };
      // Beschreibung des Einladenden eingetroffen: sofort ein frischer Versuch.
      const stopKick = onDescriptorReceived(onion, () => {
        if (!connected.current && !keyExchange && inFlight < 3) launch();
      });
      try {
        if (getTorState().status === 'ON') launch();
        while (!connected.current && mounted.current && Date.now() - started < PAIR_TOTAL_MS) {
          await new Promise(r => setTimeout(r, 1000));
          if (connected.current || !mounted.current) break;
          const elapsed = Date.now() - started;
          if (getTorState().status !== 'ON') { setStatusDetail(t('connect.status.torStarting')); continue; }
          if (!keyExchange) setStatusDetail(t('connect.status.searching', { secs: Math.round(elapsed / 1000) }));
          if (inFlight === 0) launch();
          else if (inFlight === 1 && !keyExchange && Date.now() - lastLaunch > PAIR_HEDGE_MS) launch();
          if (!torRestarted && !keyExchange && elapsed > PAIR_TOR_STUCK_MS && !descriptorReceivedSince(onion, started)) {
            torRestarted = true;
            setStatusDetail(t('connect.status.torStuck'));
            await restartTorForPairing().catch(() => false);
          }
        }
      } finally {
        stopKick();
      }
      if (connected.current) return;
      if (!connected.current && mounted.current) {
        setErrorReason(getTorState().status !== 'ON'
          ? t('connect.err.torUnreachable')
          : t('connect.err.contactUnreachable'));
        setStatus('error');
      }
    } catch (e) {
      console.warn('[Connect] Kopplung fehlgeschlagen:', e?.message || e);
      if (mounted.current) {
        setErrorReason(t('connect.err.failed'));
        setStatus('error');
      }
    } finally {
      pairingRunning.current = false;
    }
  };

  const torWaitText = torSt.status === 'ERROR'
    ? t('connect.wait.torError')
    : torSt.status === 'ON'
      ? t('connect.wait.publishing')
      : t('connect.status.torStarting') + (torSt.status === 'STARTING' && torSt.progress > 0 ? ' ' + torSt.progress + ' %' : '');

  // Kopplung per Telefonnummer (Okt. 2026, serverlos ueber einen
  // voruebergehenden Tor-Treffpunkt): Oberflaeche in PhonePairingPanel.tsx,
  // Logik in PhonePairing.js, siehe PHONE_PAIRING_DESIGN.md.
  const PhonePairingPanel = require('./PhonePairingPanel').default;

  return (
    <View style={{ flex:1, backgroundColor:P.bg }}>
      <View style={hm.header}>
        <TouchableOpacity onPress={onBack} style={{ marginRight:8, padding:4 }}>
            <Text style={{ fontSize:22, color:P.headerIcon }}>{BACK_ARROW}</Text>
          </TouchableOpacity>
        <Text style={hm.title}>{t('common.connect')}</Text>
        <View style={{ width:40 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding:16, paddingBottom:40 }}>
        <View style={{ flexDirection:'row', backgroundColor:P.surface, borderRadius:12,
          borderWidth:0.5, borderColor:P.border, overflow:'hidden', marginBottom:20 }}>
          {['generate','enter','phone'].map(m => (
            <TouchableOpacity key={m} style={{ flex:1, paddingVertical:10, alignItems:'center',
              backgroundColor: mode===m ? P.surfaceAlt : 'transparent' }} onPress={() => setMode(m)}>
              <Text style={{ fontSize:13, fontWeight:'500', color: mode===m ? P.accentFg : P.textSub }}>
                {m==='generate' ? t('common.invite') : m==='enter' ? t('connect.tabCode') : t('connect.tabPhone')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {mode === 'generate' ? (
          <View style={{ gap:16 }}>
            <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5,
              borderColor:P.border, alignItems:'center', paddingVertical:32, paddingHorizontal:24 }}>
              {inviteReady ? (
                <QRCode value={myDeepLink} size={250} ecl="L" quietZone={8} backgroundColor="white" color="#1C1410" />
              ) : (
                <View style={{ width:250, height:250, alignItems:'center', justifyContent:'center', padding:16 }}>
                  <Icon name={torSt.status === 'ERROR' ? 'alert-triangle' : 'loader'} size={28} color={torSt.status === 'ERROR' ? P.warning : P.textMuted} />
                  <Text style={{ color:P.textMuted, fontSize:13, marginTop:12, textAlign:'center', lineHeight:19 }}>
                    {inviteError || torWaitText}
                  </Text>
                </View>
              )}
              <Text style={{ color:P.textMuted, fontSize:11, marginTop:16 }}>
                {t('connect.scanToConnect')}
              </Text>
            </View>
            <TouchableOpacity
              disabled={!inviteReady}
              style={{ flexDirection:'row', alignItems:'center', justifyContent:'center',
                backgroundColor:P.surfaceAlt, borderRadius:14, padding:14, gap:8,
                borderWidth:0.5, borderColor:P.border, opacity: inviteReady ? 1 : 0.5 }}
              onPress={() => {
                Share.share({
                  message: t('connect.shareMessage', { link: myDeepLink }),
                  title: t('connect.shareTitle'),
                });
              }}>
              <Icon name="share-2" size={16} color={AC} />
              <Text style={{ color:P.accentFg, fontSize:14, fontWeight:'500' }}>{t('connect.shareLink')}</Text>
            </TouchableOpacity>
            {/* Krypto-Review K-02: Wer den Link unterwegs liest oder aendert,
                kann sich dazwischenschalten - nur der Code-Vergleich deckt das auf. */}
            <Text testID="connect-share-hint" style={{ color:P.textMuted, fontSize:11, lineHeight:16, textAlign:'center', marginTop:-6 }}>
              {t('connect.shareHint')}
            </Text>

            {inviteReady && (
              <View style={{ backgroundColor:P.surfaceAlt, borderRadius:12, borderWidth:1,
                borderColor:AC, paddingVertical:16, paddingHorizontal:12, alignItems:'center' }}>
                <Text style={{ color:P.textMuted, fontSize:11, marginBottom:6 }}>{t('connect.inviteCode')}</Text>
                <Text style={{ color:P.accentFg, fontSize:13, letterSpacing:0.5, fontWeight:'600', textAlign:'center' }}>
                  {myFullCode}
                </Text>
                <TouchableOpacity
                  style={{ flexDirection:'row', alignItems:'center', gap:6, marginTop:10 }}
                  onPress={() => {
                    // Klartext-Code statt QR-Scan-Umweg - exakt das, was
                    // handleConnect() erwartet (inkl. Tor-Adresse). Geschuetzt
                    // kopiert: als "sensibel" markiert (keine Vorschau, kein
                    // Tastatur-Verlauf), nach 60 s geleert (Audit P11/T4).
                    copySensitive(myFullCode).catch(() => {});
                    setCodeCopied(true);
                    setTimeout(() => setCodeCopied(false), 2000);
                  }}>
                  <Icon name={codeCopied ? 'check' : 'copy'} size={14} color={AC} />
                  <Text style={{ color:P.accentFg, fontSize:13, fontWeight:'500' }}>
                    {codeCopied ? t('common.copied') : t('connect.copyCode')}
                  </Text>
                </TouchableOpacity>
                <Text style={{ color:P.textMuted, fontSize:10, marginTop:6, textAlign:'center' }}>
                  {t('connect.codeHint')}
                </Text>
              </View>
            )}

            <View style={{ backgroundColor:P.accentSoft, borderRadius:12,
              padding:14, flexDirection:'row', gap:10, alignItems:'flex-start' }}>
              <Icon name="shield" size={16} color={P.codeText} />
              <Text style={{ color:P.codeText, fontSize:12, flex:1, lineHeight:18 }}>
                {!inviteReady ? t('connect.preparing')
                  : torSt.reachable ? t('connect.pqInfo')
                  : t('connect.pqInfoChecking')}
              </Text>
            </View>
            <CollapsibleNotice teaser={t('connect.how.teaser')} icon="info">
              {t('connect.how.body')}
            </CollapsibleNotice>
          </View>
        ) : mode === 'enter' ? (
          <View style={{ gap:16 }}>
            <Text style={{ fontSize:13, color:P.textSub, lineHeight:20 }}>
              {t('connect.enterHint')}
            </Text>
            <View style={{ flexDirection:'row', gap:10, alignItems:'center' }}>
              <TouchableOpacity
                style={{ width:48, height:48, alignItems:'center', justifyContent:'center',
                  backgroundColor:AC, borderRadius:12 }}
                accessibilityLabel={t('connect.scanQr')}
                accessibilityRole="button"
                onPress={async () => {
                  const { PermissionsAndroid } = require('react-native');
                  const granted = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.CAMERA,
                    { title: t('perm.camera.title'), message: t('perm.camera.message') }
                  );
                  if (granted === PermissionsAndroid.RESULTS.GRANTED) setShowScanner(true);
                  else Alert.alert(t('perm.camera.deniedTitle'), t('perm.camera.deniedBody'));
                }}>
                <Icon name="camera" size={20} color={P.onAccent} />
              </TouchableOpacity>
              <TextInput
                style={{ flex:1, backgroundColor:P.surface, borderRadius:12, borderWidth:0.5,
                  borderColor:P.border, padding:14, textAlign:'center', letterSpacing:1,
                  fontSize:14, color:P.text }}
                value={input} onChangeText={setInput}
                placeholder={t('connect.inputPlaceholder')}
                placeholderTextColor={P.textMuted}
                autoCapitalize="none" autoCorrect={false} />
            </View>

            {status === 'connecting' && (
              <View style={{ alignItems:'center', padding:16 }}>
                <Text style={{ color:P.textMuted, fontSize:13 }}>⏳ {statusDetail || t('common.connectingViaTor')}</Text>
              </View>
            )}

            {status === 'connected' && (
              <View style={{ backgroundColor:P.accentSoft, borderRadius:12, padding:14, alignItems:'center' }}>
                <Text style={{ color:P.codeText, fontSize:14, fontWeight:'500' }}>{t('connect.connected')}</Text>
              </View>
            )}

            {status === 'error' && (
              <View style={{ backgroundColor:'#FEE', borderRadius:12, padding:14, alignItems:'center' }}>
                <Text style={{ color:'#E74C3C', fontSize:13, textAlign:'center' }}>{errorReason || t('connect.failedRetry')}</Text>
              </View>
            )}

            <TouchableOpacity
              onPress={() => handleConnect()}
              disabled={input.length < 5 || status === 'connecting'}
              style={{ borderRadius:14, padding:16, alignItems:'center',
                backgroundColor: input.length > 5 ? AC : P.surfaceAlt }}>
              <Text style={{ color: input.length > 5 ? P.onAccent : P.textSub,
                fontSize:15, fontWeight:'500' }}>
                {status === 'connecting' ? t('common.connectingDots') : t('common.connect')}
              </Text>
            </TouchableOpacity>
          </View>
        ) : mode === 'phone' ? (
          <PhonePairingPanel onPaired={(contact, rtc) => {
            // Wie bei der Einladung: die zuerst fertige Kopplung gewinnt.
            if (connected.current) { try { rtc.close(); } catch {} return; }
            connected.current = true;
            pairedRtc.current = rtc;
            onConnectedRef.current(contact, rtc);
          }} />
        ) : null}
      </ScrollView>

      {/* In-App-QR-Scanner statt Umweg ueber die Systemkamera - die gab den
          erkannten "malachi://connect/"-Link je nach Scanner-App anders
          formatiert wieder. Der rohe gescannte String wird direkt an
          handleConnect() durchgereicht - Scannen verbindet damit automatisch. */}
      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <QRScannerScreen
          onScanned={(value) => {
            setShowScanner(false);
            setMode('enter');
            setInput(value);
            handleConnect(value);
          }}
          onClose={() => setShowScanner(false)}
        />
      </Modal>
    </View>
  );
}

function QRScannerScreen({ onScanned, onClose }) {
  // scanThrottleDelay der Bibliothek reicht allein nicht - onReadCode kann
  // trotzdem noch einmal nachfeuern, bevor der Modal-Wechsel (setShowScanner)
  // tatsaechlich das Kamera-Preview abbaut. Ein einfacher "schon verarbeitet"-
  // Ref verhindert einen doppelten handleConnect()-Aufruf fuer denselben Scan.
  const handledRef = useRef(false);
  return (
    <View style={{ flex:1, backgroundColor:'#000' }}>
      <Camera
        style={{ flex:1 }}
        scanBarcode
        onReadCode={(event) => {
          if (handledRef.current) return;
          const value = event?.nativeEvent?.codeStringValue;
          if (!value) return;
          handledRef.current = true;
          onScanned(value);
        }}
        showFrame
        laserColor="#0A7EA4"
        frameColor="white"
        // Bibliotheks-Default ist {width:300, height:150} - fuer 1D-Barcodes
        // gedacht, nicht fuer quadratische QR-Codes. Ein QR-Code passt in den
        // schmalen 150px-hohen Streifen oft nicht vollstaendig hinein, was
        // sowohl den schief wirkenden Rahmen als auch fehlgeschlagene Scans
        // erklaert (per Live-Test entdeckt) - quadratischer Rahmen behebt beides.
        barcodeFrameSize={{ width: 260, height: 260 }}
        // Nur QR noetig, verhindert dass andere Formate (z.B. EAN-Barcodes
        // auf Produktverpackungen im Bildausschnitt) versehentlich ausgeloest
        // werden und den Scan-Flow mit einem sinnlosen String beenden.
        allowedBarcodeTypes={['qr']}
      />
      <TouchableOpacity
        onPress={onClose}
        style={{ position:'absolute', top:48, left:20, width:40, height:40, borderRadius:20,
          backgroundColor:'rgba(0,0,0,0.5)', alignItems:'center', justifyContent:'center' }}>
        <Icon name="x" size={22} color="white" />
      </TouchableOpacity>
      <View style={{ position:'absolute', bottom:60, left:0, right:0, alignItems:'center' }}>
        <Text style={{ color:'white', fontSize:13 }}>{t('connect.positionQr')}</Text>
      </View>
    </View>
  );
}

// ── Tor-Ausweichweg: Einstellungen ─────────────────────────────────────────
// Namen der Bridge-Arten (Snowflake, obfs4, meek) bleiben unuebersetzt;
// Texte als Getter, damit ein Sprachwechsel sofort greift.
const TOR_MODE_INFO = {
  auto:      { get label() { return t('tor.mode.auto'); }, get desc() { return t('tor.mode.auto.desc'); } },
  none:      { get label() { return t('tor.mode.none'); }, get desc() { return t('tor.mode.none.desc'); } },
  snowflake: { label: 'Snowflake', get desc() { return t('tor.mode.snowflake.desc'); } },
  obfs4:     { label: 'obfs4', get desc() { return t('tor.mode.obfs4.desc'); } },
  meek:      { label: 'meek', get desc() { return t('tor.mode.meek.desc'); } },
  custom:    { get label() { return t('tor.mode.custom'); }, get desc() { return t('tor.mode.custom.desc'); } },
};
function torStatusText(st) {
  if (!isTorAvailable()) return t('tor.status.unavailable');
  const via = st.mode && st.mode !== 'none' ? ' · ' + (TOR_MODE_INFO[st.mode]?.label || st.mode) : '';
  switch (st.status) {
    case 'ON': return t('tor.status.active') + (via || ' · ' + t('tor.status.noBridges')) + ' · ' + (st.reachable ? t('tor.status.reachable') : t('tor.status.checking'));
    case 'STARTING': return t('tor.status.connecting') + (st.progress > 0 ? ' ' + st.progress + ' %' : '') + via;
    case 'ERROR': return t('tor.status.notConnected') + (st.message ? ' · ' + st.message : '');
    default: return t('tor.status.off');
  }
}
// ── Verbindungsweg (ConnectionMode.js): zwei Stufen ───────────────────────
// Jede Stufe sagt ehrlich, wer die IP-Adresse sieht und was sie kostet.
// (Seit dem STUN-Ausstieg ohne Nummer - es gibt nur noch zwei.)
const modeInfo = (id, hasCost) => ({
  get label() { return t('connMode.' + id + '.label'); },
  get desc() { return t('connMode.' + id + '.desc'); },
  get who() { return t('connMode.' + id + '.who'); },
  get cost() { return hasCost ? t('connMode.' + id + '.cost') : null; },
});
const CONNECTION_MODE_INFO = {
  [MODE_DIRECT]: modeInfo('direct', true),
  [MODE_TOR_ONLY]: modeInfo('torOnly', true),
};

function useConnectionMode() {
  const [mode, setMode] = React.useState(getConnectionMode());
  React.useEffect(() => {
    let alive = true;
    loadConnectionMode().then((m) => { if (alive) setMode(m); }).catch(() => {});
    const off = onConnectionModeChange((m) => { if (alive) setMode(m); });
    return () => { alive = false; off(); };
  }, []);
  return mode;
}

function ConnectionModeSection({ accent, pro, onOpenPro }) {
  const mode = useConnectionMode();
  const [busy, setBusy] = React.useState(false);
  const apply = async (next) => {
    setBusy(true);
    try {
      // Stufe 3 nur mit Vollversion - frisch geprueft, nicht nur aus der Anzeige.
      const verified = next === MODE_TOR_ONLY ? canSelectTorOnlyMode(await isProVerified()) : false;
      const r = await setConnectionMode(next, { pro: verified });
      if (!r.ok && r.reason === 'pro') { onOpenPro?.(); return; }
      if (!r.ok) {
        Alert.alert(t('connMode.title'), t('connMode.saveFailed')
          + (r.mode === MODE_TOR_ONLY ? ' ' + t('connMode.saveFailedTorOnly') : ''));
        return;
      }
      // Stufe 3 stuft Direktverbindungen selbst zurueck (DirectUpgrade); sonst
      // gleich mit der neuen Einstellung verbinden.
      if (next !== MODE_TOR_ONLY) global.malachiReconnectNow?.();
    } finally {
      setBusy(false);
    }
  };
  const choose = (next) => {
    if (busy || next === mode) return;
    // Ohne Vollversion: Antippen oeffnet die Vollversion-Seite (wie Duress-PIN).
    if (next === MODE_TOR_ONLY && !canSelectTorOnlyMode(pro)) { onOpenPro?.(); return; }
    if (mode === MODE_TOR_ONLY) {
      Alert.alert(t('connMode.leave.title'),
        t('connMode.leave.body')
          + (canSelectTorOnlyMode(pro) ? '' : ' ' + t('connMode.leave.proHint')), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('connMode.leave.confirm'), style: 'destructive', onPress: () => { apply(next); } },
        ]);
      return;
    }
    apply(next);
  };
  return (
    <>
      <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8 }}>{t('connMode.section')}</Text>
      <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border, overflow:'hidden', marginBottom:20 }}>
        <View style={{ padding:16, paddingBottom:8 }}>
          <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('connMode.question')}</Text>
          <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
            {t('connMode.intro')}
          </Text>
        </View>
        {CONNECTION_MODES.map((m) => {
          const info = CONNECTION_MODE_INFO[m];
          const selected = mode === m;
          const locked = m === MODE_TOR_ONLY && !canSelectTorOnlyMode(pro);
          return (
            <View key={m}>
              <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
              <TouchableOpacity activeOpacity={0.8} disabled={busy} onPress={() => choose(m)}
                style={{ flexDirection:'row', alignItems:'flex-start', paddingVertical:12, paddingHorizontal:16 }}>
                <View style={{ width:18, height:18, borderRadius:9, borderWidth:2, marginTop:1,
                  borderColor: selected ? accent : P.borderStrong, alignItems:'center', justifyContent:'center', marginRight:12 }}>
                  {selected && <View style={{ width:8, height:8, borderRadius:4, backgroundColor:accent }} />}
                </View>
                <View style={{ flex:1 }}>
                  <View style={{ flexDirection:'row', alignItems:'center' }}>
                    <Text style={{ fontSize:13, color:P.text }}>{info.label}</Text>
                    {locked && !selected && <ProBadge accent={accent} />}
                  </View>
                  <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>{info.desc}</Text>
                  <Text style={{ fontSize:11, color:P.textSub, marginTop:3, lineHeight:15 }}>{info.who}</Text>
                  {!!info.cost && <Text style={{ fontSize:11, color:P.textMuted, marginTop:3, lineHeight:15 }}>{info.cost}</Text>}
                  {m === MODE_TOR_ONLY && selected && locked && (
                    <Text style={{ fontSize:11, color:P.warning, marginTop:3, lineHeight:15 }}>
                      {t('connMode.activeWithoutPro')}
                    </Text>
                  )}
                  {m === MODE_TOR_ONLY && locked && !selected && (
                    <Text style={{ fontSize:11, color:P.accentFg, marginTop:3, lineHeight:15 }}>{t('connMode.proTap')}</Text>
                  )}
                </View>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </>
  );
}

// ── Verbindungs-Diagnose (ConnectionStats.js, STUN_AUSSTIEG_PLAN.md WP0) ───
// Nur lokale Zaehlwerte - keine Adressen, keine Kontakte, keine Zeitpunkte.
// "Als Text kopieren" legt sie geschuetzt in die Zwischenablage; Tester
// schicken sie selbst, wenn sie moechten. Es wird nichts hochgeladen.
function useConnectionStatsSnapshot() {
  const [snap, setSnap] = React.useState(getConnectionStats());
  React.useEffect(() => {
    let alive = true;
    loadConnectionStats().then(() => { if (alive) setSnap(getConnectionStats()); }).catch(() => {});
    const off = onConnectionStatsChange(() => { if (alive) setSnap(getConnectionStats()); });
    return () => { alive = false; off(); };
  }, []);
  return snap;
}

function ConnectionDiagnosticsSection({ accent, modeLabel }) {
  const stats = useConnectionStatsSnapshot();
  const text = statsAsText(stats, { tr: t, modeLabel, appVersion: [getVersionName(), getDistribution()].filter(Boolean).join(' · ') });
  const copy = () => {
    copySensitive(text).catch(() => {});
    Alert.alert(t('common.copied'), t('diag.copied'));
  };
  const reset = () => {
    Alert.alert(t('diag.resetTitle'), t('diag.resetBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('diag.reset'), style: 'destructive', onPress: () => { resetConnectionStats().catch(() => {}); } },
    ]);
  };
  return (
    <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border, padding:16, marginBottom:20 }}>
      <Text style={{ fontSize:11, color:P.textMuted, lineHeight:16 }}>{t('diag.intro')}</Text>
      <Text selectable={false} style={{ fontSize:11, color:P.textSub, marginTop:10, lineHeight:16, fontFamily: Platform.OS === 'android' ? 'monospace' : undefined }}>
        {text}
      </Text>
      <View style={{ flexDirection:'row', marginTop:12 }}>
        <TouchableOpacity onPress={copy} testID="diag-copy"
          style={{ flex:1, borderRadius:12, borderWidth:1, borderColor:accent, paddingVertical:10, alignItems:'center', marginRight:8 }}>
          <Text style={{ color:accent, fontSize:13, fontWeight:'500' }}>{t('diag.copy')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={reset} testID="diag-reset"
          style={{ flex:1, borderRadius:12, borderWidth:1, borderColor:P.border, paddingVertical:10, alignItems:'center' }}>
          <Text style={{ color:P.textMuted, fontSize:13, fontWeight:'500' }}>{t('diag.reset')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function TorSettingsSection({ accent, pro = false, onOpenPro = null }) {
  const [settings, setSettings] = React.useState(DEFAULT_TOR_SETTINGS);
  const [st, setSt] = React.useState(getTorState());
  const [customOpen, setCustomOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const connectionMode = useConnectionMode();
  React.useEffect(() => {
    loadTorSettings().then(setSettings);
    return onTorState(setSt);
  }, []);
  const apply = async (patch) => {
    const next = await saveTorSettings({ ...settings, ...patch });
    setSettings(next);
    // Tor ist der einzige Verbindungsweg (kein Server) - nie ausschalten,
    // nur mit den neuen Einstellungen neu starten.
    restartTor();
  };
  const statusColor = st.status === 'ON' ? P.success : st.status === 'ERROR' ? P.warning : P.textMuted;
  const pcp = getPortMappingStatus();
  const [ipv6, setIpv6] = React.useState(null);
  React.useEffect(() => {
    NativeModules.MalachiPcp?.ipv6Status?.().then(setIpv6).catch(() => {});
  }, []);
  const ipv6Missing = ipv6 && ipv6.transport === 'wifi' && !(ipv6.globalAddress && ipv6.defaultRoute);
  const PORT_MAPPING_METHOD_LABEL = { pcp: 'PCP', natpmp: 'NAT-PMP', upnp: 'UPnP' };
  // Ohne STUN ist die Router-Freigabe fuer alle der wichtigste Weg zu einer
  // Direktverbindung ueber IPv4 (ausser IPv6 und gleichem WLAN).
  const pcpText = connectionMode === MODE_TOR_ONLY
    ? t('direct.torOnly')
    : !pcp
      ? t('direct.pending')
      : pcp.result === 'SUCCESS'
        ? (PORT_MAPPING_METHOD_LABEL[pcp.method] ? t('direct.activeWith', { method: PORT_MAPPING_METHOD_LABEL[pcp.method] }) : t('direct.active'))
        : pcp.result === 'NOT_AUTHORIZED'
          ? t('direct.notAuthorized') + ' ' + t('direct.notAuthorizedHint')
          : t('direct.unsupportedHint');
  const validDraft = parseCustomBridges(draft).length;
  return (
    <>
      <ConnectionModeSection accent={accent} pro={pro} onOpenPro={onOpenPro} />
      <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8 }}>{t('direct.section')}</Text>
      <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border, padding:16, marginBottom:20 }}>
        <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('direct.title')}</Text>
        <Text style={{ fontSize:11, color: pcp?.result === 'SUCCESS' && connectionMode !== MODE_TOR_ONLY ? P.success : P.textMuted, marginTop:4, lineHeight:16 }}>{pcpText}</Text>
        {ipv6Missing && connectionMode !== MODE_TOR_ONLY && (
          <Text style={{ fontSize:11, color:P.warning, marginTop:10, lineHeight:16 }}>
            {t('direct.ipv6Missing')}
          </Text>
        )}
      </View>
      <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8 }}>TOR</Text>
      <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5,
        borderColor:P.border, overflow:'hidden', marginBottom:20 }}>
        <View style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
          <View style={{ flex:1 }}>
            <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('tor.title')}</Text>
            <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
              {t('tor.intro')}
            </Text>
            <Text style={{ fontSize:11, color:statusColor, marginTop:6 }}>{torStatusText(st)}</Text>
          </View>
        </View>
        {TOR_BRIDGE_MODES.map(mode => {
          const selected = settings.bridgeMode === mode;
          return (
            <View key={mode}>
              <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
              <TouchableOpacity activeOpacity={0.8}
                onPress={() => {
                  if (mode === 'custom') { setDraft(settings.customBridges || ''); setCustomOpen(true); }
                  else if (!selected) apply({ bridgeMode: mode });
                }}
                style={{ flexDirection:'row', alignItems:'center', paddingVertical:12, paddingHorizontal:16 }}>
                <View style={{ width:18, height:18, borderRadius:9, borderWidth:2,
                  borderColor: selected ? accent : P.borderStrong, alignItems:'center', justifyContent:'center', marginRight:12 }}>
                  {selected && <View style={{ width:8, height:8, borderRadius:4, backgroundColor:accent }} />}
                </View>
                <View style={{ flex:1 }}>
                  <Text style={{ fontSize:13, color:P.text }}>{TOR_MODE_INFO[mode].label}</Text>
                  <Text style={{ fontSize:11, color:P.textMuted, marginTop:1, lineHeight:15 }}>{TOR_MODE_INFO[mode].desc}</Text>
                </View>
              </TouchableOpacity>
            </View>
          );
        })}
        {/* Entwickler-Testschalter (getrennt vom Verbindungsweg "Maximal anonym",
            siehe TorTransport.DEFAULT_TOR_SETTINGS): prueft nur den Tor-Weg fuer
            Nachrichten, Anrufe nutzen weiter WebRTC - also KEIN IP-Schutz und
            nicht an die Vollversion gebunden. Nur in Entwickler-Builds sichtbar;
            in Release-Builds nur, solange er (aus einer aelteren Version) noch
            an ist - damit man ihn abschalten kann. */}
        {(__DEV__ || !!settings.forceTorTest) && (
          <View>
            <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
            <View style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
              <View style={{ flex:1, marginRight:12 }}>
                <Text style={{ fontSize:13, color:P.warning }}>{t('tor.devTest.title')}</Text>
                <Text style={{ fontSize:11, color:P.textMuted, marginTop:1, lineHeight:15 }}>
                  {t('tor.devTest.body')}
                </Text>
              </View>
              <Switch value={!!settings.forceTorTest}
                onValueChange={async (v) => {
                  const next = await saveTorSettings({ ...settings, forceTorTest: v });
                  setSettings(next);
                  if (v) demoteAllDirectToTor('Entwickler-Test "nur Tor"');
                  global.malachiReconnectNow?.();
                }}
                trackColor={{ false:P.border, true:P.warning + '88' }} thumbColor={settings.forceTorTest ? P.warning : P.textMuted} />
            </View>
          </View>
        )}
      </View>
      <Modal visible={customOpen} transparent animationType="fade" onRequestClose={() => setCustomOpen(false)}>
        <View style={{ flex:1, backgroundColor:P.overlay, alignItems:'center', justifyContent:'center', padding:24 }}>
          <View style={{ width:'100%', backgroundColor:P.surface, borderRadius:20, padding:20, gap:10 }}>
            <Text style={{ fontSize:17, fontWeight:'600', color:P.text }}>{t('tor.mode.custom')}</Text>
            <Text style={{ fontSize:12, color:P.textSub, lineHeight:18 }}>
              {t('tor.custom.hint')}
            </Text>
            <TextInput value={draft} onChangeText={setDraft} multiline autoCapitalize="none" autoCorrect={false}
              placeholder="webtunnel [2001:db8::1]:443 … url=https://…"
              placeholderTextColor={P.textMuted}
              style={{ minHeight:110, maxHeight:220, borderWidth:1, borderColor:P.border, borderRadius:12,
                padding:10, fontSize:11, color:P.text, textAlignVertical:'top', fontFamily:'monospace' }} />
            <Text style={{ fontSize:11, color: validDraft ? P.success : P.textMuted }}>
              {validDraft ? t('tor.custom.valid', { count: validDraft }) : t('tor.custom.none')}
            </Text>
            <TouchableOpacity disabled={!validDraft}
              onPress={() => { setCustomOpen(false); apply({ bridgeMode: 'custom', customBridges: draft }); }}
              style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor: validDraft ? accent : P.border }}>
              <Text style={{ color: validDraft ? P.onAccent : P.text, fontWeight:'500' }}>{t('tor.custom.save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setCustomOpen(false)} style={{ padding:10, alignItems:'center' }}>
              <Text style={{ color:P.textSub }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

function SettingsRow({ label, value, onPress, color }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}
      style={{ flexDirection:'row', alignItems:'center', padding:16, paddingHorizontal:16 }}>
      <Text style={{ flex:1, fontSize:14, fontWeight:'500', color:P.text }}>{label}</Text>
      <Text style={{ fontSize:14, color: color || P.textMuted, marginRight:8 }}>{value}</Text>
      <Text style={{ fontSize:16, color:P.textMuted }}>{CHEVRON}</Text>
    </TouchableOpacity>
  );
}

// Einstellungen nach Kategorien (Nutzerwunsch 2026-10-19: "je nach Kategorie
// ausklappbar, nicht immer alles anzeigen"). Kopfzeile mit Symbol, Titel und
// Kurzstatus; der Inhalt erscheint erst nach Antippen. Es ist immer hoechstens
// eine Kategorie offen (SettingsScreen haelt openId).
function SettingsGroup({ id, icon, title, summary, summaryColor, openId, onToggle, accent, children }) {
  const open = openId === id;
  return (
    <View style={{ marginBottom:12 }}>
      <TouchableOpacity activeOpacity={0.7} onPress={() => onToggle(open ? null : id)}
        testID={'settings-group-' + id} accessibilityRole="button" accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        style={{ flexDirection:'row', alignItems:'center', padding:16, backgroundColor:P.surface,
          borderRadius:16, borderWidth: open ? 1 : 0.5, borderColor: open ? (accent || P.accentFg) : P.border }}>
        <Icon name={icon} size={18} color={accent || P.accentFg} style={{ marginRight:14 }} />
        <View style={{ flex:1, marginRight:8 }}>
          <Text style={{ fontSize:15, fontWeight:'600', color:P.text }}>{title}</Text>
          {!!summary && (
            <Text numberOfLines={1} style={{ fontSize:12, color: summaryColor || P.textMuted, marginTop:2 }}>{summary}</Text>
          )}
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={P.textMuted} />
      </TouchableOpacity>
      {open && <View style={{ marginTop:12 }}>{children}</View>}
    </View>
  );
}

// Einzelner Eintrag im selben Aussehen wie eine Kategorie - oeffnet direkt
// eine eigene Seite (Vollversion, Siegel).
function SettingsLink({ icon, title, summary, summaryColor, onPress, accent, badge = null, testID }) {
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} accessibilityRole="button" accessibilityLabel={title} testID={testID}
      style={{ flexDirection:'row', alignItems:'center', padding:16, marginBottom:12, backgroundColor:P.surface,
        borderRadius:16, borderWidth:0.5, borderColor:P.border }}>
      <Icon name={icon} size={18} color={accent || P.accentFg} style={{ marginRight:14 }} />
      <View style={{ flex:1, marginRight:8 }}>
        <View style={{ flexDirection:'row', alignItems:'center' }}>
          <Text style={{ fontSize:15, fontWeight:'600', color:P.text }}>{title}</Text>
          {badge}
        </View>
        {!!summary && (
          <Text numberOfLines={2} style={{ fontSize:12, color: summaryColor || P.textMuted, marginTop:2, lineHeight:16 }}>{summary}</Text>
        )}
      </View>
      <Icon name="chevron-right" size={18} color={P.textMuted} />
    </TouchableOpacity>
  );
}

function SettingsSheet({ title, children, visible, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={{ flex:1, backgroundColor:'transparent' }} onPress={onClose} activeOpacity={1} />
      <View style={{ backgroundColor:P.surface, borderTopLeftRadius:28, borderTopRightRadius:28,
        padding:24, paddingBottom:52, position:'absolute', bottom:0, left:0, right:0,
        elevation:20 }}>
        <View style={{ width:40, height:4, borderRadius:2, backgroundColor:P.border,
          alignSelf:'center', marginBottom:24 }} />
        <Text style={{ fontSize:17, fontWeight:'600', color:P.text, marginBottom:8 }}>{title}</Text>
        <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginBottom:8 }} />
        {children}
      </View>
    </Modal>
  );
}
// ── VOLLVERSION ("Pro", siehe LicenseManager.js) ─────────────────────────
// Kleiner Hinweis an gesperrten Eintraegen in den Einstellungen.
function ProBadge({ accent }) {
  return (
    <View style={{ paddingHorizontal:7, paddingVertical:2, borderRadius:8, borderWidth:1,
      borderColor: accent || AC, marginLeft:8 }}>
      <Text style={{ fontSize:10, fontWeight:'700', letterSpacing:0.8, color: P.accentFg }}>PRO</Text>
    </View>
  );
}

// Texte als Getter (Sprachwechsel ohne Neustart).
const proFeature = (icon, titleKey, descKey) => ({ icon, get title() { return t(titleKey); }, get desc() { return t(descKey); } });
const PRO_FEATURE_LIST = [
  proFeature('alert-octagon', 'pro.f.duress.title', 'pro.f.duress.desc'),
  proFeature('trash-2', 'pro.f.wipe5.title', 'pro.f.wipe5.desc'),
  proFeature('send', 'pro.f.remoteWipe.title', 'pro.f.remoteWipe.desc'),
  proFeature('eye-off', 'connMode.torOnly.label', 'pro.f.torOnly.desc'),
  proFeature('lock', 'common.siegelMode', 'pro.f.siegel.desc'),
  proFeature('camera', 'pro.f.screenshots.title', 'pro.f.screenshots.desc'),
  proFeature('droplet', 'pro.f.themes.title', 'pro.f.themes.desc'),
];

// Nur fuer die Kauf-Karte, die ausschliesslich ohne aktive Vollversion
// sichtbar ist - "abgeschlossen" heisst dort: Lizenz nicht (mehr) gueltig.
const proRefetchHint = () => t('pro.refetchHint');
// Widerrufs-Zustimmung: der Shop bestaetigt genau den deutschen Wortlaut
// (ShopClient.CONSENT_TEXT, wortgleich mit dem Server). In anderen Sprachen
// steht die Uebersetzung davor, der deutsche Text bleibt verbindlich.
function consentDisplayText() {
  if (getLanguage() === 'de') return CONSENT_TEXT;
  return t('pro.consentText') + '\n\n' + t('pro.consentBinding') + '\n' + CONSENT_TEXT;
}
function proOrderStatusText(p, now) {
  if (!p) return '';
  if (p.gone) return t('pro.order.gone');
  const o = p.order;
  if (!o) return p.done ? proRefetchHint() : '';
  switch (o.status) {
    case 'pending':
      return isPaymentWindowOver(p, now)
        ? t('pro.order.windowOver')
        : t('pro.order.waiting');
    case 'underpaid':
      return t('pro.order.underpaid', { amount: o.missing || '?', currency: orderPaymentMethod(o) === 'btc' ? 'BTC' : 'XMR' });
    case 'unconfirmed':
      return orderPaymentMethod(o) === 'btc' ? t('pro.order.unconfirmedBtc') : t('pro.order.unconfirmed');
    case 'paid':
      return p.done ? proRefetchHint() : t('pro.order.paid');
    case 'expired':
      return t('pro.order.expired');
    case 'withdrawn':
      return t('pro.order.withdrawn')
        + (o.received && Number(o.received) > 0 ? ' ' + t('pro.order.withdrawnRefund', { amount: o.received, currency: orderPaymentMethod(o) === 'btc' ? 'BTC' : 'XMR' }) : '');
    default:
      return '';
  }
}

function proDeviceKeyText(level) {
  switch (level) {
    case 'strongbox': return t('pro.key.strongbox');
    case 'tee':       return t('pro.key.tee');
    case 'software':  return t('pro.key.software');
    default:          return t('pro.key.default');
  }
}

// Vollversion-Seite: in der Google-Play-Variante (Distribution.isPlay()) die
// Play-Seite (PlayProScreen.tsx: Kauf nur ueber Google Play Billing, keine
// anderen Zahlungswege, kein Geraetecode), sonst unveraendert die Shop-Seite.
// Exportiert nur fuer die Darstellungstests (__tests__/license/license.proScreen*.test.js).
export function ProScreen(props) {
  return isPlay()
    ? <PlayProScreen {...props} features={PRO_FEATURE_LIST} />
    : <ShopProScreen {...props} />;
}

// Website-Variante: Kauf ueber den Onion-Shop (LicenseManager.js, ShopClient.js).
function ShopProScreen({ visible, onClose, accent }) {
  const AC2 = accent || P.green;
  // Vollbild-Modal: eigene Abstaende zu Status-/Navigationsleiste (Edge-to-Edge).
  const insets = useSafeAreaInsets();
  const [lic, setLic] = React.useState(getLicenseState());
  const [consent, setConsent] = React.useState(false);
  const [busy, setBusy] = React.useState(null);        // null | 'kauf' | 'pruefen' | 'lizenz' | 'umzug' | 'widerruf'
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [panel, setPanel] = React.useState(null);      // null | 'license' | 'device' | 'transfer'
  const [licenseText, setLicenseText] = React.useState('');
  const [trOrder, setTrOrder] = React.useState('');
  const [trCode, setTrCode] = React.useState('');
  const [deviceCode, setDeviceCode] = React.useState(null);
  const [showRecovery, setShowRecovery] = React.useState(false);
  // "Vertrag widerrufen" (§ 356a BGB): freiwillige Angaben
  const [wdName, setWdName] = React.useState('');
  const [wdAddr, setWdAddr] = React.useState('');
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => subscribeLicense(setLic), []);
  const [method, setMethod] = React.useState(null);    // gewaehlte Zahlungsart: null (Vorgabe) | 'xmr' | 'btc'

  const p = lic.purchase;
  const open = isPurchaseOpen(p);

  // Zahlungsarten laut Shop (nur 'xmr'/'btc', ShopClient.parsePaymentMethods).
  // Bis eine Antwort da ist - oder ohne Antwort - bleibt es bei Monero.
  const offered = lic.shopMethods && lic.shopMethods.methods.length ? lic.shopMethods.methods : ['xmr'];
  const chosen = method && offered.includes(method) ? method
    : (lic.shopMethods && offered.includes(lic.shopMethods.defaultMethod) ? lic.shopMethods.defaultMethod : offered[0]);
  const canBuy = visible && !lic.pro && lic.purchaseAvailable && !open;
  // Angebotene Zahlungsarten einmal je Sitzung ueber Tor abfragen - nur wenn
  // gerade gekauft werden kann. Fehler: naechster Versuch beim naechsten Oeffnen.
  React.useEffect(() => {
    if (!canBuy || lic.shopMethods) return;
    loadShopPaymentMethods().catch(() => {});
  }, [canBuy, lic.shopMethods]);

  // Beim Schliessen fluechtige Anzeigen zuruecksetzen (eingegebene Codes
  // bleiben nicht im Speicher der Seite liegen).
  React.useEffect(() => {
    if (visible) return;
    setError(''); setNotice(''); setPanel(null); setShowRecovery(false);
    setLicenseText(''); setTrOrder(''); setTrCode(''); setWdName(''); setWdAddr('');
  }, [visible]);

  // Zahlungsstatus alle PURCHASE_POLL_MS (20 s) abfragen - nur solange diese
  // Seite offen ist und eine Bestellung laeuft. Fehler zeigt die Bestellung
  // selbst an (purchase.error), die naechste Runde versucht es erneut.
  React.useEffect(() => {
    if (!visible || !open || lic.pro || !lic.purchaseAvailable) return undefined;
    let stopped = false;
    const poll = () => { if (!stopped) checkPurchase().catch(() => {}); };
    if (!p.lastCheckedAt || Date.now() - p.lastCheckedAt > 15000) poll();
    const t = setInterval(poll, PURCHASE_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
    // Bewusst ohne p.lastCheckedAt: sonst startete jede Abfrage den Takt neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, open, lic.pro, lic.purchaseAvailable, p?.orderId]);

  // Restlaufzeit der Zahlungsfrist aktualisieren.
  React.useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [visible]);

  const run = async (kind, fn) => {
    if (busy) return;
    setBusy(kind); setError(''); setNotice('');
    try { await fn(); }
    catch (e) { setError(e?.message || t('pro.unknownError')); }
    finally { setBusy(null); }
  };
  const buy = () => run('kauf', async () => {
    if (canDismissPurchase(p)) await dismissPurchase();
    await startPurchase({ consent, paymentMethod: chosen });
  });
  const checkNow = () => run('pruefen', async () => { await checkPurchase(); });
  const saveLicense = () => run('lizenz', async () => {
    const r = await installLicense(licenseText);
    if (!r.ok) throw new Error(r.message);
    setLicenseText(''); setPanel(null);
    setNotice(t('pro.licenseSaved'));
  });
  const doTransfer = () => run('umzug', async () => {
    const r = await transferToThisDevice({ orderId: trOrder, recoveryCode: trCode });
    setTrOrder(''); setTrCode(''); setPanel(null);
    const counted = Number.isInteger(r.activations) && Number.isInteger(r.maxActivations);
    setNotice(r.newActivation
      ? (counted ? t('pro.transfer.movedCount', { n: r.activations, max: r.maxActivations }) : t('pro.transfer.moved'))
      : t('pro.transfer.refetched'));
  });
  const togglePanel = async (name) => {
    setError(''); setNotice('');
    const next = panel === name ? null : name;
    setPanel(next);
    if (next === 'device' && !deviceCode) {
      try { setDeviceCode(await getDeviceCode()); }
      catch { setError(licenseErrorMessage('kein-geraeteschluessel')); }
    }
    if (next === 'transfer' && p && p.recoveryCode && !trOrder && !trCode) {
      // Gespeicherte Bestellung vorschlagen (z. B. Lizenz erneut abholen).
      setTrOrder(formatGroups(p.orderId)); setTrCode(formatGroups(p.recoveryCode));
    }
  };
  const doWithdraw = () => run('widerruf', async () => {
    await withdrawPurchase({ refundAddress: wdAddr, name: wdName });
    setWdName(''); setWdAddr(''); setPanel(null);
    setNotice(t('pro.withdraw.received'));
  });
  const shareReceipt = (text) => {
    Share.share({ title: t('pro.withdraw.receiptTitle'), message: text }).catch(() => {});
  };
  // Zahlungsdaten/Geraetecode geschuetzt kopieren (Audit P11): "sensibel"
  // markiert, nach 60 s aus der Zwischenablage geloescht.
  const copy = (text, what) => {
    copySensitive(String(text)).catch(() => {});
    setError('');
    setNotice(t('pro.copied', { what }));
  };

  const o = p?.order;
  const payInfo = PAYMENT_METHODS[orderPaymentMethod(o) || 'xmr'];
  const payAmount = o ? paymentAmount(o) : null;
  // Zahlungsdaten nur, solange noch gezahlt werden soll - nicht mehr, wenn
  // die Zahlung schon unterwegs ist (sonst droht doppeltes Zahlen) oder die
  // Frist abgelaufen ist.
  const showPay = !!(open && o?.address && payAmount
    && (o.status === 'pending' || o.status === 'underpaid') && !isPaymentWindowOver(p, now));
  const payUri = showPay ? paymentUri(o) : null;
  const msgs = (!!error || !!notice) ? (
    <>
      {!!error && <Text style={{ fontSize:12, color:P.danger, lineHeight:17 }}>{error}</Text>}
      {!!notice && <Text style={{ fontSize:12, color:P.success, lineHeight:17 }}>{notice}</Text>}
    </>
  ) : null;
  const minsLeft = o ? Math.max(0, Math.round((o.expiresAt - now) / 60000)) : 0;
  const expiryText = o && o.status === 'pending' && !isPaymentWindowOver(p, now)
    ? t('pro.payUntil', {
        date: formatDateTime(o.expiresAt, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
        left: minsLeft >= 60 ? t('time.hm', { h: Math.floor(minsLeft / 60), m: minsLeft % 60 }) : t('time.m', { m: minsLeft % 60 }),
      })
    : null;
  const priceText = o?.eurPrice ? o.eurPrice.replace('.', ',') : PRO_PRICE_EUR;
  const storedInvalid = lic.loaded && !lic.pro && lic.reason !== 'keine-lizenz';

  const card = { backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border, padding:16, marginBottom:16 };
  const sectionTitle = { fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8 };
  const button = (enabled) => ({ borderRadius:12, padding:14, alignItems:'center', backgroundColor: enabled ? AC2 : P.border, marginTop:12 });
  const ghost = { borderRadius:12, padding:12, alignItems:'center', borderWidth:1, borderColor:P.border, marginTop:10 };
  const input = { borderWidth:1, borderColor:P.border, borderRadius:12, padding:12, fontSize:14, color:P.text, marginTop:10 };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex:1, backgroundColor:P.bg, paddingTop:insets.top, paddingBottom:insets.bottom }}>
        <View style={{ flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingTop:16, paddingBottom:12,
          backgroundColor:P.headerBg, borderBottomWidth:0.5, borderBottomColor:P.headerBorder }}>
          <TouchableOpacity onPress={onClose} style={{ marginRight:8, padding:4 }}>
            <Text style={{ fontSize:22, color:P.headerIcon }}>{BACK_ARROW}</Text>
          </TouchableOpacity>
          <Text style={{ fontSize:20, fontWeight:'600', color:P.headerText }}>{t('common.fullVersion')}</Text>
        </View>

        <ScrollView contentContainerStyle={{ padding:16, paddingBottom:48 }} keyboardShouldPersistTaps="handled">
          {/* STATUS */}
          <View style={[card, lic.pro && { borderColor:P.success, borderWidth:1 }]}>
            <View style={{ flexDirection:'row', alignItems:'center' }}>
              <Icon name={lic.pro ? 'check-circle' : 'shield'} size={22} color={lic.pro ? P.success : AC2} />
              <Text style={{ fontSize:17, fontWeight:'600', color:P.text, marginLeft:10 }}>
                {lic.pro ? t('pro.active') : t('pro.free')}
              </Text>
            </View>
            {lic.pro && lic.licenseInfo && (
              <Text style={{ fontSize:12, color:P.textSub, marginTop:6 }}>
                {t('pro.licenseLine', { lic: formatGroups(lic.licenseInfo.lic) })}
              </Text>
            )}
            {storedInvalid && (
              <Text style={{ fontSize:12, color:P.warning, marginTop:8, lineHeight:17 }}>
                {t('pro.storedInvalid', { reason: licenseErrorMessage(lic.reason) })}
              </Text>
            )}
            <Text style={{ fontSize:13, color:P.textSub, marginTop:10, lineHeight:19 }}>
              {t('pro.freeIntro')}
            </Text>
          </View>

          {/* WAS PRO ENTHAELT */}
          <Text style={sectionTitle}>{t('pro.extraSection')}</Text>
          <View style={card}>
            {PRO_FEATURE_LIST.map((f, i) => (
              <View key={f.title} style={{ flexDirection:'row', marginTop: i ? 14 : 0 }}>
                <Icon name={f.icon} size={18} color={AC2} style={{ marginTop:1 }} />
                <View style={{ flex:1, marginLeft:12 }}>
                  <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{f.title}</Text>
                  <Text style={{ fontSize:12, color:P.textMuted, marginTop:2, lineHeight:17 }}>{f.desc}</Text>
                </View>
              </View>
            ))}
            <Text style={{ fontSize:12, color:P.textSub, marginTop:14, lineHeight:18 }}>
              {t('pro.priceInfo', { price: priceText, methods: offered.map((id) => PAYMENT_METHODS[id].name).join(t('common.orJoin')) })}
            </Text>
          </View>

          {/* KAUF */}
          {!lic.pro && (
            <>
              <Text style={sectionTitle}>{t('pro.buySection')}</Text>
              <View style={card}>
                {!lic.purchaseAvailable ? (
                  <>
                    <Text style={{ fontSize:15, fontWeight:'600', color:P.warning }}>{t('pro.notAvailable')}</Text>
                    <Text style={{ fontSize:12, color:P.textMuted, marginTop:6, lineHeight:17 }}>
                      {t('pro.notAvailableBody')}
                    </Text>
                  </>
                ) : p && (open || o?.status === 'paid' || p.done) ? (
                  <>
                    <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{proOrderStatusText(p, now)}</Text>
                    {!!expiryText && <Text style={{ fontSize:12, color:P.textMuted, marginTop:4 }}>{expiryText}</Text>}
                    {!!payUri && (
                      <>
                        <View style={{ alignSelf:'center', backgroundColor:'white', borderRadius:16, padding:10, marginTop:14 }}>
                          <QRCode value={payUri} size={210} ecl="M" quietZone={8} backgroundColor="white" color="#1C1410" />
                        </View>
                        <Text style={{ fontSize:11, color:P.textMuted, marginTop:12 }}>{t('pro.amount')}</Text>
                        <Text selectable style={{ fontSize:20, fontWeight:'600', color:P.text, marginTop:2 }}>
                          {payAmount} {payInfo.currency}
                        </Text>
                        <Text style={{ fontSize:11, color:P.textMuted, marginTop:10 }}>{t('pro.toAddress', { name: payInfo.name.toUpperCase() })}</Text>
                        <Text selectable style={{ fontSize:12, color:P.text, fontFamily:'monospace', marginTop:2, lineHeight:17 }}>
                          {o.address}
                        </Text>
                        <View style={{ flexDirection:'row', gap:8, marginTop:10 }}>
                          <TouchableOpacity onPress={() => copy(o.address, t('pro.address'))} style={[ghost, { flex:1, marginTop:0 }]}>
                            <Text style={{ color:P.text, fontSize:13 }}>{t('pro.copyAddress')}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => copy(String(payAmount), t('pro.amountWord'))} style={[ghost, { flex:1, marginTop:0 }]}>
                            <Text style={{ color:P.text, fontSize:13 }}>{t('pro.copyAmount')}</Text>
                          </TouchableOpacity>
                        </View>
                        <TouchableOpacity onPress={() => Linking.openURL(payUri).catch(() => setError(t('pro.noWallet', { name: payInfo.name })))} style={ghost}>
                          <Text style={{ color:P.text, fontSize:13 }}>{t('pro.openWallet')}</Text>
                        </TouchableOpacity>
                      </>
                    )}
                    {!!p.error && <Text style={{ fontSize:12, color:P.warning, marginTop:10, lineHeight:17 }}>{p.error}</Text>}
                    {open && (
                      <TouchableOpacity disabled={!!busy} onPress={checkNow} style={ghost}>
                        <Text style={{ color:P.textSub, fontSize:13 }}>
                          {busy === 'pruefen' ? t('pro.askingShop') : t('pro.checkNow')}
                        </Text>
                      </TouchableOpacity>
                    )}
                    {open && (
                      <Text style={{ fontSize:11, color:P.textMuted, marginTop:8, textAlign:'center' }}>
                        {t('pro.pollInfo')}
                      </Text>
                    )}
                  </>
                ) : (
                  <>
                    {p && canDismissPurchase(p) && (
                      <Text style={{ fontSize:12, color:P.warning, marginBottom:10, lineHeight:17 }}>{proOrderStatusText(p, now)}</Text>
                    )}
                    <TouchableOpacity activeOpacity={0.8} onPress={() => setConsent(c => !c)} style={{ flexDirection:'row', alignItems:'flex-start' }}>
                      <View style={{ width:20, height:20, borderRadius:5, borderWidth:2, borderColor: consent ? AC2 : P.borderStrong,
                        backgroundColor: consent ? AC2 : 'transparent', alignItems:'center', justifyContent:'center', marginTop:1 }}>
                        {consent && <Icon name="check" size={13} color={P.onAccent} />}
                      </View>
                      <Text style={{ flex:1, fontSize:12, color:P.textSub, marginLeft:10, lineHeight:17 }}>{consentDisplayText()}</Text>
                    </TouchableOpacity>
                    {offered.length > 1 && (
                      <View style={{ marginTop:14 }}>
                        <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.2, marginBottom:6 }}>{t('app.bezahlenMit')}</Text>
                        <View style={{ flexDirection:'row', gap:8 }}>
                          {offered.map((id) => (
                            <TouchableOpacity key={id} disabled={!!busy} onPress={() => setMethod(id)}
                              accessibilityRole="radio" accessibilityState={{ selected: chosen === id }}
                              style={{ flex:1, borderRadius:12, paddingVertical:10, alignItems:'center',
                                borderWidth: chosen === id ? 2 : 1, borderColor: chosen === id ? AC2 : P.border }}>
                              <Text style={{ fontSize:14, fontWeight: chosen === id ? '600' : '400', color:P.text }}>{PAYMENT_METHODS[id].name}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    )}
                    {chosen === 'btc' && (
                      <Text style={{ fontSize:11, color:P.textMuted, marginTop:8, lineHeight:16 }}>
                        {t('app.btcPublic', { monero: offered.includes('xmr') ? t('app.moneroIstPrivater') : '' })}
                      </Text>
                    )}
                    <TouchableOpacity disabled={!consent || !!busy} onPress={buy} style={button(consent && !busy)}>
                      <Text style={{ color:P.onAccent, fontWeight:'600', fontSize:15 }}>
                        {busy === 'kauf' ? t('pro.connectingShop') : t('pro.buyButton', { method: PAYMENT_METHODS[chosen].name, price: PRO_PRICE_EUR })}
                      </Text>
                    </TouchableOpacity>
                    {busy === 'kauf' && (
                      <Text style={{ fontSize:11, color:P.textMuted, marginTop:8, textAlign:'center', lineHeight:16 }}>
                        {t('pro.onionSlow')}
                      </Text>
                    )}
                  </>
                )}
                {panel === null && msgs && <View style={{ marginTop:10 }}>{msgs}</View>}
              </View>
            </>
          )}
          {lic.pro && panel === null && msgs && <View style={card}>{msgs}</View>}

          {/* WIDERRUF ("Vertrag widerrufen", § 356a BGB) - bis zur Bereitstellung der Lizenz */}
          {!lic.pro && lic.purchaseAvailable && p && (canWithdrawPurchase(p) || o?.status === 'withdrawn') && (
            <>
              <Text style={sectionTitle}>{t('app.widerruf')}</Text>
              <View style={card}>
                {o?.status === 'withdrawn' ? (
                  <>
                    <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>
                      {p.withdrawal ? t('app.withdrawnAt', { date: formatDateTime(p.withdrawal.at, { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) }) : t('app.withdrawnPlain')}
                    </Text>
                    {!!p.withdrawal && (
                      <>
                        <Text selectable style={{ fontSize:12, color:P.textSub, marginTop:10, lineHeight:17 }}>{p.withdrawal.receipt}</Text>
                        <TouchableOpacity onPress={() => shareReceipt(p.withdrawal.receipt)} style={ghost}>
                          <Text style={{ color:P.text, fontSize:13 }}>{t('app.eingangsbestaetigungTeilenSpeichern')}</Text>
                        </TouchableOpacity>
                      </>
                    )}
                    {Number(o.received) > 0 && !p.withdrawal?.refundAddress && panel !== 'withdraw' && (
                      <TouchableOpacity onPress={() => togglePanel('withdraw')} style={ghost}>
                        <Text style={{ color:P.text, fontSize:13 }}>{t('app.rueckzahlungsadresseNachtragen')}</Text>
                      </TouchableOpacity>
                    )}
                  </>
                ) : panel !== 'withdraw' && (
                  <>
                    <Text style={{ fontSize:12, color:P.textMuted, lineHeight:17 }}>
                      {t('app.dochNichtKaufenBisZur')}
                    </Text>
                    <TouchableOpacity disabled={!!busy} onPress={() => togglePanel('withdraw')} style={ghost} accessibilityRole="button">
                      <Text style={{ color:P.text, fontSize:13 }}>{t('app.vertragWiderrufen2')}</Text>
                    </TouchableOpacity>
                  </>
                )}
                {panel === 'withdraw' && (
                  <View>
                    <Text style={{ fontSize:12, color:P.textMuted, lineHeight:17 }}>
                      {o?.status === 'withdrawn'
                        ? t('app.adresseDeinerEigenenWalletAn')
                        : t('app.bestellnummerUndWiederherstellungscodeKenntDie')}
                    </Text>
                    {o?.status !== 'withdrawn' && (
                      <TextInput value={wdName} onChangeText={(t) => setWdName(t.slice(0, 100))} autoCorrect={false}
                        placeholder={t('app.nameFreiwillig')} placeholderTextColor={P.textMuted} style={input} />
                    )}
                    <TextInput value={wdAddr} onChangeText={(t) => setWdAddr(t.replace(/\s/g, '').slice(0, 120))} autoCapitalize="none" autoCorrect={false}
                      placeholder={t('app.rueckzahlungsadresse', { name: payInfo.name })} placeholderTextColor={P.textMuted} style={[input, { fontFamily:'monospace', fontSize:12 }]} />
                    <TouchableOpacity disabled={!!busy || (o?.status === 'withdrawn' && !wdAddr)} onPress={doWithdraw}
                      style={button(!busy && !(o?.status === 'withdrawn' && !wdAddr))} accessibilityRole="button">
                      <Text style={{ color:P.onAccent, fontWeight:'600' }}>
                        {busy === 'widerruf' ? t('pro.connectingShop') : o?.status === 'withdrawn' ? t('app.adresseSpeichern') : t('app.widerrufBestaetigen')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity disabled={!!busy} onPress={() => setPanel(null)} style={ghost}>
                      <Text style={{ color:P.textSub, fontSize:13 }}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    {msgs && <View style={{ marginTop:10 }}>{msgs}</View>}
                  </View>
                )}
              </View>
            </>
          )}

          {/* WIEDERHERSTELLUNGSCODE */}
          {p && p.recoveryCode && (!p.recoveryAcknowledged || showRecovery) && (
            <View style={[card, { borderColor:P.warning, borderWidth:1 }]}>
              <Text style={{ fontSize:11, color:P.warning, letterSpacing:1.5 }}>{t('pro.recoverySection')}</Text>
              <Text style={{ fontSize:26, fontWeight:'700', color:P.text, fontFamily:'monospace', marginTop:8, lineHeight:34 }}>
                {formatGroups(p.recoveryCode)}
              </Text>
              <Text style={{ fontSize:12, color:P.textSub, marginTop:6 }}>
                {t('pro.orderNumber') + ' '}<Text style={{ fontFamily:'monospace', color:P.text }}>{formatGroups(p.orderId)}</Text>
              </Text>
              <Text style={{ fontSize:13, color:P.text, marginTop:10, lineHeight:19 }}>
                {t('pro.writeDown')}
              </Text>
              {!p.recoveryAcknowledged ? (
                <TouchableOpacity onPress={() => acknowledgeRecoveryCode()} style={button(true)}>
                  <Text style={{ color:P.onAccent, fontWeight:'500' }}>{t('pro.writtenDown')}</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => setShowRecovery(false)} style={ghost}>
                  <Text style={{ color:P.textSub, fontSize:13 }}>{t('pro.hide')}</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* WEITERE WEGE */}
          <Text style={sectionTitle}>{t('pro.licenseSection')}</Text>
          <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5, borderColor:P.border, overflow:'hidden', marginBottom:16 }}>
            {p && p.recoveryCode && p.recoveryAcknowledged && !showRecovery && (
              <>
                <SettingsRow label={t('pro.showRecovery')} value="" onPress={() => setShowRecovery(true)} />
                <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
              </>
            )}
            <SettingsRow label={t('pro.showDeviceCode')} value="" onPress={() => togglePanel('device')} />
            {panel === 'device' && (
              <View style={{ paddingHorizontal:16, paddingBottom:16 }}>
                {deviceCode ? (
                  <>
                    <Text selectable style={{ fontSize:18, fontWeight:'600', color:P.text, fontFamily:'monospace', lineHeight:26 }}>
                      {formatDeviceCode(deviceCode)}
                    </Text>
                    <TouchableOpacity onPress={() => copy(formatDeviceCode(deviceCode), t('pro.deviceCode'))} style={ghost}>
                      <Text style={{ color:P.text, fontSize:13 }}>{t('pro.copyDeviceCode')}</Text>
                    </TouchableOpacity>
                  </>
                ) : <Text style={{ fontSize:12, color:P.textMuted }}>{t('pro.reading')}</Text>}
                <Text style={{ fontSize:12, color:P.textMuted, marginTop:10, lineHeight:17 }}>
                  {t('pro.deviceCodeHint')}
                  {lic.purchaseAvailable && SHOP_ONION ? ' ' + t('app.shopHttp', { SHOP_ONION }) : ''}
                </Text>
                {!!lic.deviceKeyLevel && (
                  <Text style={{ fontSize:11, color:P.textMuted, marginTop:6 }}>{proDeviceKeyText(lic.deviceKeyLevel)}</Text>
                )}
              </View>
            )}
            <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
            <SettingsRow label={t('pro.enterLicense')} value="" onPress={() => togglePanel('license')} />
            {panel === 'license' && (
              <View style={{ paddingHorizontal:16, paddingBottom:16 }}>
                <Text style={{ fontSize:12, color:P.textMuted, lineHeight:17 }}>
                  {t('pro.enterLicenseHint')}
                </Text>
                <TextInput value={licenseText} onChangeText={(t) => setLicenseText(t.slice(0, 2000))} multiline
                  autoCapitalize="none" autoCorrect={false} placeholder="ML1.…" placeholderTextColor={P.textMuted}
                  style={[input, { minHeight:90, maxHeight:180, fontSize:11, fontFamily:'monospace', textAlignVertical:'top' }]} />
                <TouchableOpacity disabled={!licenseText.trim() || !!busy} onPress={saveLicense} style={button(!!licenseText.trim() && !busy)}>
                  <Text style={{ color:P.onAccent, fontWeight:'500' }}>{busy === 'lizenz' ? t('pro.checking') : t('pro.checkAndSave')}</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
            <SettingsRow label={t('pro.transfer')} value="" onPress={() => togglePanel('transfer')} />
            {panel === 'transfer' && (
              <View style={{ paddingHorizontal:16, paddingBottom:16 }}>
                <Text style={{ fontSize:12, color:P.textMuted, lineHeight:17 }}>
                  {t('pro.transferHint')}
                </Text>
                <TextInput value={trOrder} onChangeText={(t) => setTrOrder(t.slice(0, 40))} autoCapitalize="characters" autoCorrect={false}
                  placeholder={t('pro.orderPlaceholder')} placeholderTextColor={P.textMuted} style={[input, { fontFamily:'monospace' }]} />
                <TextInput value={trCode} onChangeText={(t) => setTrCode(t.slice(0, 40))} autoCapitalize="characters" autoCorrect={false}
                  secureTextEntry={false} placeholder={t('pro.recoveryPlaceholder')} placeholderTextColor={P.textMuted} style={[input, { fontFamily:'monospace' }]} />
                {lic.purchaseAvailable ? (
                  <TouchableOpacity disabled={!trOrder.trim() || !trCode.trim() || !!busy} onPress={doTransfer}
                    style={button(!!trOrder.trim() && !!trCode.trim() && !busy)}>
                    <Text style={{ color:P.onAccent, fontWeight:'500' }}>{busy === 'umzug' ? t('pro.connectingShop') : t('pro.transferButton')}</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={{ fontSize:12, color:P.warning, marginTop:10 }}>{t('shop.err.nicht-konfiguriert')}</Text>
                )}
              </View>
            )}
          </View>
          {panel !== null && panel !== 'withdraw' && msgs && <View style={card}>{msgs}</View>}
          <Text style={{ fontSize:11, color:P.textMuted, lineHeight:16 }}>
            {t('pro.footer')}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

// Exportiert nur fuer den Darstellungstest (__tests__/themes/themes.designSection.test.js).
export function SettingsScreen({ onBack, onDesignChange, onBgChange, onFontChange, currentBg, currentFont, onAvatarChange, username, onUsernameChange, onWipeAll, onLanguageChange, onLockNow }) {
  const [duress, setDuress]     = useState(false);
  const [chatBg, setChatBg]     = useState(currentBg || 'theme');
  const [fontSize, setFont]     = useState(currentFont || 'normal');
  const [wipeModal, setWipe]       = useState(false);
  const [sheet, setSheet]          = useState(null);
  // Sprachnachrichten-Stil (VoiceWave.js): Balken oder Pixel-Welle; der zweite
  // Stil ist Teil der Vollversion (ohne sie gilt immer der Standard).
  const [waveStyleSel, setWaveStyleSel] = useState(waveStyleSetting());
  React.useEffect(() => subscribeWaveStyle(setWaveStyleSel), []);
  const [avatar, setAvatar]        = useState(null);
  const [renameUser, setRenameUser] = useState(false);
  const [newUsername, setNewName]   = useState('');
  // Duress-PIN: reiner Zustand aus dem verschluesselten Speicher, kein
  // dekorativer lokaler Schalter mehr (Sicherheitsaudit - der Toggle tat
  // vorher gar nichts). "Aktiv" heisst: es liegt ein Duress-PIN vor.
  // App-PIN aendern und Notfall-PIN festlegen/aendern/entfernen laufen ueber
  // SecurityPinModal - immer erst mit der aktuellen App-PIN (PinChange.js).
  const [pinFlow, setPinFlow] = useState(null); // null | 'changePin' | 'setDuress' | 'changeDuress' | 'removeDuress'
  // Vollversion (LicenseManager.js): Zustand fuer PRO-Hinweise und die
  // Vollversion-Seite.
  const [lic, setLic] = useState(getLicenseState());
  const [proOpen, setProOpen] = useState(false);
  const [siegelOpen, setSiegelOpen] = useState(false);
  const pro = lic.pro === true;
  const shownWaveStyle = pro ? waveStyleSel : effectiveWaveStyle(false);
  // Ausklappbare Kategorien (SettingsGroup) - hoechstens eine offen.
  const [openGroup, setOpenGroup] = useState(null);
  // Bildschirmschutz (ScreenSecurity.js): an/aus, "aus" nur mit Vollversion.
  const [screenProt, setScreenProt] = useState(screenProtectionSetting());
  React.useEffect(() => subscribeScreenProtection(() => setScreenProt(screenProtectionSetting())), []);
  React.useEffect(() => { setScreenProt(screenProtectionSetting()); }, [pro]);
  const onScreenProtPress = async () => {
    if (!pro) { setProOpen(true); return; }
    if (screenProt) {
      Alert.alert(t('app.screenshotsErlauben'),
        t('app.dannLassenSichScreenshotsUnd'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('app.erlauben'), style: 'destructive', onPress: () => { setScreenProtection(false).catch(() => {}); } },
      ]);
    } else {
      await setScreenProtection(true);
    }
  };
  const connectionMode = useConnectionMode();
  const [torSt, setTorSt] = useState(getTorState());
  React.useEffect(() => onTorState(setTorSt), []);
  const modeShort = (CONNECTION_MODE_INFO[connectionMode]?.label || '').split(' (')[0];
  const diagStats = useConnectionStatsSnapshot();
  const diagSummary = statsSummary(diagStats, t);
  const torShort = torSt.status === 'ON' ? t('app.torShortOn') : torSt.status === 'STARTING' ? t('app.torShortStarting') : torSt.status === 'ERROR' ? t('app.torNichtVerbunden') : t('app.torShortOff');

  React.useEffect(() => {
    // Mit PIN-Tresor liegt die Notfall-PIN nur als Pruefwert im Tresor.
    PinVault.ready().then(async (r) => {
      if (r) setDuress(PinVault.hasDuressPin());
      else setDuress(!!(await EncryptedStorage.getItem('duress_pin').catch(() => null)));
    }).catch(() => {});
    return subscribeLicense(setLic);
  }, []);
  // Eigenes Profilbild (OwnAvatar.js) - dieselbe Quelle wie die Kopfzeile.
  React.useEffect(() => {
    loadOwnAvatar().then(setAvatar).catch(() => {});
    return subscribeOwnAvatar(setAvatar);
  }, []);

  // Duress-PIN-Zeile: Entfernen ist immer erlaubt; Einrichten und Aendern nur
  // mit Pro - ohne Pro oeffnet das Antippen die Vollversion-Seite. Jede
  // Aenderung verlangt zuerst die aktuelle App-PIN (Nutzerwunsch 29.10.2026:
  // wer das entsperrte Handy kurz hat, soll den Schutz weder setzen noch
  // abschalten koennen).
  const onDuressPress = () => {
    if (duress) {
      const buttons = [{ text: t('common.cancel'), style: 'cancel' }];
      if (canConfigureDuressPin(pro)) buttons.push({ text: t('settings.duress.change'), onPress: () => setPinFlow('changeDuress') });
      buttons.push({ text: t('common.remove'), style: 'destructive', onPress: () => setPinFlow('removeDuress') });
      Alert.alert(t('settings.duress.title'), pro ? t('settings.duress.manageBodyPro') : t('settings.duress.removeBodyFree'), buttons);
    } else if (!canConfigureDuressPin(pro)) {
      setProOpen(true);
    } else {
      setPinFlow('setDuress');
    }
  };

  const onPinFlowDone = (r) => {
    setPinFlow(null);
    if (r === 'duressSet') { setDuress(true); Alert.alert(t('settings.duress.title'), t('settings.duress.saved')); return; }
    if (r === 'duressRemoved') { setDuress(false); Alert.alert(t('settings.duress.title'), t('settings.duress.removed')); return; }
    if (r === 'pinChangedDuressRemoved') { setDuress(false); Alert.alert(t('pinChange.title'), t('pinChange.doneDuressRemoved')); return; }
    Alert.alert(t('pinChange.title'), t('pinChange.done'));
  };

  const removeAvatar = () => {
    Alert.alert(t('settings.avatar.remove'), t('settings.avatar.removeBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.remove'), style: 'destructive', onPress: () => {
        setAvatar(null);
        removeOwnAvatar().catch(() => {});
        onAvatarChange?.(null);
        // Allen Kontakten mitteilen
        const ES = require('react-native-encrypted-storage').default;
        AsyncStorage.getItem('contacts').then(saved => {
          if (!saved) return;
          try {
            const cs = JSON.parse(saved);
            cs.forEach(c => {
              ES.removeItem('avatar_hash_' + c.id).catch(() => {});
              RTCStore.sendMessage(c.id, JSON.stringify({
                type: 'system', subtype: 'profile_avatar_removed'
              }));
            });
          } catch {}
        });
        if (RTCStore.profileSent) RTCStore.profileSent.clear();
      }}
    ]);
  };

  // Profilbild verkleinert (512 px) und verschluesselt ablegen (OwnAvatar.js) -
  // vorher blieb nur der Pfad einer Cache-Kopie, die der Start-Sweep loeschte.
  const pickAvatar = () => {
    launchImageLibrary({ mediaType:'photo', quality:0.8, includeBase64:true, maxWidth:512, maxHeight:512 },
      async (response) => {
        if (response.assets && response.assets[0]) {
          const uri = await setOwnAvatarFromPicker(response.assets[0]).catch(() => null);
          if (!uri) return;
          setAvatar(uri);
          onAvatarChange?.(uri);
          // Avatar-Hash sofort löschen → beim nächsten Reconnect neu senden
          const ES = require('react-native-encrypted-storage').default;
          AsyncStorage.getItem('contacts').then(saved => {
            if (!saved) return;
            try {
              const cs = JSON.parse(saved);
              cs.forEach(c => ES.removeItem('avatar_hash_' + c.id).catch(() => {}));
              console.log('[Profile] Avatar-Hash gelöscht');
            } catch {}
          });
          // Auch RTCStore profileSent zurücksetzen
          if (RTCStore.profileSent) RTCStore.profileSent.clear();
          // Sofort senden wenn gerade verbunden
          AsyncStorage.getItem('contacts').then(saved => {
            if (!saved) return;
            try {
              const cs = JSON.parse(saved);
              cs.forEach(c => {
                const rtc = RTCStore.getConnection(c.id);
                if (rtc?.sharedSecret && rtc?._onKeyExchange) {
                  rtc._onKeyExchange();
                }
              });
            } catch {}
          });
        }
      }
    );
  };

  const pickBackground = () => {
    launchImageLibrary({ mediaType:'photo', quality:0.8 },
      (response) => {
        if (response.assets && response.assets[0]) {
          const uri = response.assets[0].uri;
          setChatBg('custom');
          setSheet(null);
          // Gespeichert wird nur noch ueber den Elternteil (saveSettings) -
          // hier stand ein zweites Schreiben in einem anderen Format, das
          // Akzent/Thema beim naechsten Start wieder verwarf.
          onBgChange?.('custom', uri);
        }
      }
    );
  };

  // Akzentfarben und Themen: DesignSection.tsx / Themes.js. Chat-Hintergrund:
  // "Wie Design" (Farbe des Themas) oder eine der bisherigen Voreinstellungen.
  const BACKGROUNDS = [
    { key:'theme', color:null, label:t('settings.bg.theme') },
    ...CHAT_BG_PRESETS.map(b => ({ ...b, label: t('chatBg.' + b.key) })),
  ];
  const FONTS = [
    { key:'small',  label:t('settings.font.small')  },
    { key:'normal', label:t('settings.font.normal') },
    { key:'large',  label:t('settings.font.large')   },
  ];

  const curAC    = AC;
  const bgLabel  = chatBg === 'custom' ? t('settings.bg.custom') : BACKGROUNDS.find(b => b.key === chatBg)?.label || t('settings.bg.theme');
  const fontLabel= FONTS.find(f => f.key === fontSize)?.label || t('settings.font.normal');
  // Sprache: 'system' (Geraetesprache) oder fest gewaehlt (i18n.js)
  const langChoice = getLanguageChoice();
  const langLabel = langChoice === SYSTEM_LANGUAGE
    ? t('settings.language.systemValue', { name: languageName(getLanguage()) })
    : languageName(langChoice);

  return (
    <View style={{ flex:1, backgroundColor:P.bg }}>
      <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center',
        paddingHorizontal:16, paddingTop:16, paddingBottom:12,
        backgroundColor:P.headerBg, borderBottomWidth:0.5, borderBottomColor:P.headerBorder }}>
        <TouchableOpacity onPress={onBack} style={{ marginRight:8, padding:4 }}>
          <Text style={{ fontSize:22, color:P.headerIcon }}>{BACK_ARROW}</Text>
        </TouchableOpacity>
        <Text style={{ fontSize:20, fontWeight:'600', color:P.headerText }}>{t('settings.title')}</Text>
        <View style={{ width:40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding:16, paddingBottom:48 }}>

        {/* PROFIL */}
        <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8, marginTop:8 }}>{t('settings.profile')}</Text>
        <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5,
          borderColor:P.border, padding:20, alignItems:'center', marginBottom:20 }}>
          <TouchableOpacity onPress={pickAvatar} onLongPress={avatar ? removeAvatar : null} style={{ position:'relative', marginBottom:10 }}>
            {avatar
              ? <Image source={{ uri:avatar }} style={{ width:64, height:64, borderRadius:32, borderWidth:2, borderColor:curAC, backgroundColor:P.avatarBg }} />
              : <View style={{ width:64, height:64, borderRadius:32, backgroundColor:P.avatarBg,
                  alignItems:'center', justifyContent:'center', borderWidth:2, borderColor:curAC }}>
                  <Text style={{ fontSize:24, fontWeight:'600', color:P.avatarText }}>{username ? initialsOf(username) : 'M'}</Text>
                </View>
            }
            <View style={{ position:'absolute', bottom:0, right:0, width:20, height:20,
              borderRadius:10, backgroundColor:curAC, borderWidth:2, borderColor:P.surface,
              alignItems:'center', justifyContent:'center' }}>
              <Text style={{ fontSize:11, color:P.onAccent }}>{avatar ? '✎' : '+'}</Text>
            </View>
          </TouchableOpacity>
          {avatar && <TouchableOpacity onPress={removeAvatar} style={{ marginBottom:8 }}>
            <Text style={{ fontSize:12, color:P.danger }}>{t('settings.avatar.remove')}</Text>
          </TouchableOpacity>}
          <TouchableOpacity onPress={() => setRenameUser(true)}>
  <Text style={{ fontSize:16, fontWeight:'500', color:P.text, marginBottom:4 }}>{username || 'Malachi User'} <Text style={{ fontSize:12, color:P.textMuted }}>✎</Text></Text>
</TouchableOpacity>
          <Text style={{ fontSize:11, color:P.textMuted }}>{t('settings.profileInfo')}</Text>
        </View>

        {/* VOLLVERSION */}
        <SettingsLink icon="star" title={t('common.fullVersion')} accent={curAC}
          summary={pro ? t('common.active') : proStatusLabel(lic)} summaryColor={pro ? P.success : P.accentFg}
          onPress={() => setProOpen(true)} />

        {/* Siegel-Modus (SiegelScreen.tsx): eigener Tresor, unabhaengig von App-PIN und Chats. */}
        <SettingsLink icon="lock" title={t('common.siegelMode')} accent={curAC}
          summary={pro ? t('settings.siegel.sub') : t('settings.siegel.subFree')}
          onPress={() => setSiegelOpen(true)} />

        {/* SPRACHE (i18n.js): System (Geraetesprache) oder fest gewaehlt. */}
        <SettingsLink icon="globe" title={t('settings.language')} accent={curAC} testID="settings-language"
          summary={langLabel} onPress={() => setSheet('language')} />

        {/* DESIGN (DesignSection.tsx): Themen, Akzentfarbe, Einfaerben -
            darunter wie bisher Chat-Hintergrund und Schriftgroesse. */}
        <SettingsGroup id="design" icon="droplet" title={t('app.design')} accent={curAC}
          summary={t('app.hintergrundSchrift', { bgLabel, fontLabel })}
          openId={openGroup} onToggle={setOpenGroup}>
        <DesignSection hideTitle pro={pro} onChoose={onDesignChange} onOpenPro={() => setProOpen(true)} ProBadge={ProBadge}>
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <SettingsRow label={t('settings.chatBg')} value={bgLabel}
            onPress={() => setSheet('background')} />
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <SettingsRow label={t('settings.fontSize')} value={fontLabel}
            onPress={() => setSheet('font')} />
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <SettingsRow label={t('settings.voiceStyle')} value={t('voiceStyle.' + shownWaveStyle)}
            onPress={() => setSheet('voiceStyle')} />
        </DesignSection>
        </SettingsGroup>

        {/* SICHERHEIT */}
        <SettingsGroup id="security" icon="shield" title={t('app.sicherheit')} accent={curAC}
          summary={(duress ? t('app.duressPinAktiv') : t('app.duressPinAus')) + (screenProt ? ' ' + t('app.screenshotsGesperrt') : ' ' + t('app.screenshotsErlaubt'))}
          summaryColor={duress ? P.success : undefined}
          openId={openGroup} onToggle={setOpenGroup}>
        <View style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5,
          borderColor:P.border, overflow:'hidden', marginBottom:8 }}>
          <TouchableOpacity testID="settings-change-pin" activeOpacity={0.7}
            style={{ flexDirection:'row', alignItems:'center', padding:16 }}
            onPress={() => setPinFlow('changePin')}>
            <View style={{ flex:1, marginRight:12 }}>
              <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('pinChange.title')}</Text>
              <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>{t('pinChange.rowSub')}</Text>
            </View>
            <Text style={{ fontSize:14, color:P.textMuted }}>{CHEVRON}</Text>
          </TouchableOpacity>
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <TouchableOpacity testID="settings-screen-protection"
            style={{ flexDirection:'row', alignItems:'center', padding:16 }}
            onPress={onScreenProtPress}>
            <View style={{ flex:1, marginRight:12 }}>
              <View style={{ flexDirection:'row', alignItems:'center' }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('app.screenshotsSperren')}</Text>
                {!pro && <ProBadge accent={curAC} />}
              </View>
              <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
                {screenProt
                  ? (pro ? t('app.anKeineScreenshotsOderBildschirmaufnahmen') : t('app.anAbschaltenIstTeilDer'))
                  : t('app.ausScreenshotsErlaubtSecretChat')}
              </Text>
            </View>
            <Switch value={screenProt} onValueChange={onScreenProtPress}
              trackColor={{ false:P.border, true:curAC+'88' }} thumbColor={screenProt ? curAC : P.textMuted} />
          </TouchableOpacity>
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <TouchableOpacity
            style={{ flexDirection:'row', alignItems:'center', padding:16 }}
            onPress={onDuressPress}>
            <View style={{ flex:1, marginRight:12 }}>
              <View style={{ flexDirection:'row', alignItems:'center' }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('settings.duress.title')}</Text>
                {!pro && !duress && <ProBadge accent={curAC} />}
              </View>
              <Text style={{ fontSize:11, color:P.textMuted, marginTop:2 }}>
                {duress
                  ? (pro ? t('settings.duress.activePro') : t('settings.duress.activeFree'))
                  : (pro ? t('settings.duress.setupPro') : t('settings.duress.setupFree'))}
              </Text>
            </View>
            <Switch value={duress} onValueChange={onDuressPress}
              trackColor={{ false:P.border, true:curAC+'88' }} thumbColor={duress ? curAC : P.textMuted} />
          </TouchableOpacity>
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <TouchableOpacity activeOpacity={0.7} style={{ flexDirection:'row', alignItems:'center', padding:16 }}
            onPress={() => pro
              ? Alert.alert(t('settings.wipe5.title'), t('settings.wipe5.alert'))
              : setProOpen(true)}>
            <View style={{ flex:1, marginRight:12 }}>
              <View style={{ flexDirection:'row', alignItems:'center' }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('settings.wipe5.title')}</Text>
                {!pro && <ProBadge accent={curAC} />}
              </View>
              <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
                {pro ? t('settings.wipe5.subPro')
                     : t('settings.wipe5.subFree')}
              </Text>
            </View>
            <Text style={{ fontSize:14, color: pro ? P.success : P.textMuted }}>{pro ? t('common.active') : CHEVRON}</Text>
          </TouchableOpacity>
          <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />
          <TouchableOpacity activeOpacity={0.7} style={{ flexDirection:'row', alignItems:'center', padding:16 }}
            onPress={() => pro
              ? Alert.alert(t('pro.f.remoteWipe.title'), t('settings.remoteWipe.alert'))
              : setProOpen(true)}>
            <View style={{ flex:1, marginRight:12 }}>
              <View style={{ flexDirection:'row', alignItems:'center' }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('pro.f.remoteWipe.title')}</Text>
                {!pro && <ProBadge accent={curAC} />}
              </View>
              <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
                {t('settings.remoteWipe.sub')}
              </Text>
            </View>
            <Text style={{ fontSize:14, color: pro ? P.success : P.textMuted }}>{pro ? t('common.active') : CHEVRON}</Text>
          </TouchableOpacity>
        </View>
        </SettingsGroup>

        {/* VERBINDUNG: Verbindungsweg, Direktverbindung, Tor */}
        <SettingsGroup id="connection" icon="globe" title={t('app.verbindungTor')} accent={curAC}
          summary={modeShort + ' · ' + torShort}
          summaryColor={torSt.status === 'ERROR' ? P.warning : undefined}
          openId={openGroup} onToggle={setOpenGroup}>
          <TorSettingsSection accent={curAC} pro={pro} onOpenPro={() => setProOpen(true)} />
        </SettingsGroup>

        {/* DIAGNOSE (ConnectionStats.js): lokale Verbindungszaehler, nichts wird gesendet */}
        <SettingsGroup id="diagnose" icon="activity" title={t('diag.title')} accent={curAC}
          summary={diagSummary}
          openId={openGroup} onToggle={setOpenGroup}>
          <ConnectionDiagnosticsSection accent={curAC} modeLabel={modeShort} />
        </SettingsGroup>

        {/* UPDATES (UpdateUI.tsx) - nur Web-Version, in der Play-Version gar nicht. */}
        {isUpdaterAvailable() && (
          <SettingsGroup id="updates" icon="download" title={t('app.updates')} accent={curAC}
            openId={openGroup} onToggle={setOpenGroup}>
            <UpdateSettingsSection palette={P} accent={curAC} hideTitle />
          </SettingsGroup>
        )}

        {/* NOTFALL - bewusst immer sichtbar (schneller Zugriff im Ernstfall) */}
        <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8, marginTop:12 }}>{t('settings.emergency')}</Text>
        <TouchableOpacity onPress={() => setWipe(true)}
          style={{ borderRadius:14, borderWidth:1, borderColor:P.danger, padding:16, alignItems:'center' }}>
          <Text style={{ color:P.danger, fontSize:14, fontWeight:'500' }}>{t('settings.wipeAll')}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* SHEET: HINTERGRUND */}
      {/* Audit 2026-09-28: die Sheets schrieben 'settings' frueher ein
          ZWEITES Mal in einem anderen Format, das beim naechsten Start nicht
          lesbar war. Persistiert wird nur ueber den Elternteil. */}
      <SettingsSheet title={t('settings.chatBg')} visible={sheet==='background'} onClose={() => setSheet(null)}>
        {BACKGROUNDS.map(b => (
          <TouchableOpacity key={b.key} onPress={() => { setChatBg(b.key); setSheet(null); onBgChange?.(b.color); }}
            style={{ flexDirection:'row', alignItems:'center', paddingVertical:14,
              borderBottomWidth:0.5, borderBottomColor:P.border }}>
            <View style={{ width:28, height:28, borderRadius:8, backgroundColor:b.color || P.chatBg,
              borderWidth:0.5, borderColor:P.borderStrong, marginRight:14 }} />
            <Text style={{ flex:1, fontSize:15, color:P.text }}>{b.label}</Text>
            {chatBg === b.key && <Text style={{ fontSize:18, color:curAC }}>✓</Text>}
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={pickBackground}
          style={{ flexDirection:'row', alignItems:'center', paddingVertical:14 }}>
          <View style={{ width:28, height:28, borderRadius:8, backgroundColor:P.surfaceAlt,
            borderWidth:1, borderColor:P.border, borderStyle:'dashed', marginRight:14,
            alignItems:'center', justifyContent:'center' }}>
            <Icon name="image" size={14} color={P.textMuted} />
          </View>
          <Text style={{ flex:1, fontSize:15, color:P.text }}>{t('settings.bg.custom')}</Text>
          {chatBg === 'custom' 
            ? <Text style={{ fontSize:18, color:curAC }}>✓</Text>
            : <Text style={{ fontSize:14, color:P.textMuted }}>{t('settings.bg.gallery')}</Text>}
        </TouchableOpacity>
      </SettingsSheet>

      {/* SHEET: SCHRIFTGRÖSSE */}
      <SettingsSheet title={t('settings.fontSize')} visible={sheet==='font'} onClose={() => setSheet(null)}>
        {FONTS.map(f => (
          <TouchableOpacity key={f.key} onPress={() => { setFont(f.key); setSheet(null); onFontChange?.(f.key==='small'?13:f.key==='large'?18:15); }}
            style={{ flexDirection:'row', alignItems:'center', paddingVertical:14,
              borderBottomWidth:0.5, borderBottomColor:P.border }}>
            <Text style={{ flex:1, fontSize: f.key==='small'?13:f.key==='normal'?15:18, color:P.text }}>
              {f.label}
            </Text>
            {fontSize === f.key && <Text style={{ fontSize:18, color:curAC }}>✓</Text>}
          </TouchableOpacity>
        ))}
      </SettingsSheet>

      {/* SHEET: SPRACHNACHRICHTEN-STIL (VoiceWave.js) - mit Live-Vorschau */}
      <SettingsSheet title={t('settings.voiceStyle')} visible={sheet==='voiceStyle'} onClose={() => setSheet(null)}>
        {['bars', 'pixel'].map((style) => {
          const locked = style !== 'bars' && !pro;
          const selected = shownWaveStyle === style;
          return (
            <TouchableOpacity key={style} testID={'voice-style-' + style}
              accessibilityRole="button" accessibilityState={{ selected }}
              onPress={() => {
                if (locked) { setSheet(null); setProOpen(true); return; }
                setWaveStyle(style).catch(() => {});
                setSheet(null);
              }}
              style={{ flexDirection:'row', alignItems:'center', paddingVertical:14, gap:12,
                borderBottomWidth:0.5, borderBottomColor:P.border }}>
              <View style={{ flex:1 }}>
                <View style={{ flexDirection:'row', alignItems:'center' }}>
                  <Text style={{ fontSize:15, color:P.text }}>{t('voiceStyle.' + style)}</Text>
                  {locked && <ProBadge accent={curAC} />}
                </View>
                <Text style={{ fontSize:11, color:P.textMuted, marginTop:2 }}>{t('voiceStyle.' + style + 'Desc')}</Text>
                <View style={{ marginTop:8 }}>
                  <VoiceWaveView levels={fallbackLevels('vorschau')} progress={0.4} animate={style === 'pixel'}
                    variant={style} width={180} height={26} activeColor={curAC} idleColor={P.border} />
                </View>
              </View>
              {selected && <Text style={{ fontSize:18, color:curAC }}>✓</Text>}
            </TouchableOpacity>
          );
        })}
      </SettingsSheet>

      {/* SHEET: SPRACHE */}
      <SettingsSheet title={t('settings.language')} visible={sheet==='language'} onClose={() => setSheet(null)}>
        <ScrollView style={{ maxHeight:420 }}>
          {[{ code: SYSTEM_LANGUAGE, name: t('settings.language.system') }, ...LANGUAGES].map(l => (
            <TouchableOpacity key={l.code} testID={'language-' + l.code}
              onPress={() => { setSheet(null); onLanguageChange?.(l.code); }}
              style={{ flexDirection:'row', alignItems:'center', paddingVertical:13,
                borderBottomWidth:0.5, borderBottomColor:P.border }}>
              <Text style={{ flex:1, fontSize:15, color:P.text }}>{l.name}</Text>
              {langChoice === l.code && <Text style={{ fontSize:18, color:curAC }}>✓</Text>}
            </TouchableOpacity>
          ))}
        </ScrollView>
        <Text style={{ fontSize:11, color:P.textMuted, marginTop:12, lineHeight:16 }}>{t('settings.language.disclaimer')}</Text>
      </SettingsSheet>

      {/* USERNAME MODAL */}
      <Modal visible={renameUser} transparent animationType="fade" onRequestClose={() => setRenameUser(false)}>
        <View style={{ flex:1, backgroundColor:P.overlay, alignItems:'center', justifyContent:'center', padding:32 }}>
          <View style={{ width:'100%', backgroundColor:P.surface, borderRadius:20, padding:24, gap:12 }}>
            <Text style={{ fontSize:17, fontWeight:'600', color:P.text }}>{t('settings.rename.title')}</Text>
            <TextInput value={newUsername} onChangeText={setNewName} autoFocus placeholder={t('common.name')} maxLength={32} style={{ borderWidth:1, borderColor:P.border, borderRadius:12, padding:12, fontSize:15, color:P.text }}/>
            <TouchableOpacity onPress={() => { if (newUsername.trim()) onUsernameChange?.(newUsername.trim()); setRenameUser(false); }} style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:curAC }}>
              <Text style={{ color:P.onAccent, fontWeight:'500' }}>{t('common.save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setRenameUser(false)} style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:P.surfaceAlt }}>
              <Text style={{ color:P.textSub }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {/* APP-PIN / DURESS-PIN (immer erst mit der aktuellen App-PIN) */}
      <SecurityPinModal mode={pinFlow} palette={P} accent={curAC}
        onClose={() => setPinFlow(null)} onDone={onPinFlowDone}
        onLockNow={() => { setPinFlow(null); onLockNow?.(); }}
        onWipe={() => { setPinFlow(null); onWipeAll?.(); }}
        onNeedPro={() => { setPinFlow(null); setProOpen(true); }} />
      {/* VOLLVERSION */}
      <ProScreen visible={proOpen} onClose={() => setProOpen(false)} accent={curAC} />
      {/* SIEGEL-MODUS */}
      <SiegelScreen visible={siegelOpen} onClose={() => setSiegelOpen(false)} canSeal={pro} onOpenPro={() => setProOpen(true)} />
      {/* WIPE MODAL */}
      <Modal visible={wipeModal} transparent animationType="fade" onRequestClose={() => setWipe(false)}>
        <View style={{ flex:1, backgroundColor:P.overlay, alignItems:'center',
          justifyContent:'center', padding:32 }}>
          <View style={{ width:'100%', backgroundColor:P.surface, borderRadius:20, padding:24, gap:12 }}>
            <Text style={{ fontSize:18, fontWeight:'600', color:P.text }}>{t('settings.wipe.title')}</Text>
            <Text style={{ fontSize:14, color:P.textSub, lineHeight:22 }}>
              {t('settings.wipe.body')}
            </Text>
            <TouchableOpacity onPress={() => { setWipe(false); onWipeAll?.(); }}
              style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:P.dangerFill }}>
              <Text style={{ color:P.onDanger, fontWeight:'500', fontSize:14 }}>{t('settings.wipe.confirm')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setWipe(false)}
              style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:P.surfaceAlt }}>
              <Text style={{ color:P.textSub, fontSize:14 }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}


