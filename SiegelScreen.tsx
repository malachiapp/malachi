/**
 * Malachi – SiegelScreen.tsx
 *
 * Oberflaeche des Siegel-Modus (SIEGEL_DESIGN.md): Texte fuer WhatsApp & Co.
 * Ende-zu-Ende verschluesseln. Eigener Tresor mit eigener Passphrase
 * (SiegelVault.js) - unabhaengig von App-PIN und Malachi-Chats.
 *
 * Zero Trace: Klartext steht nur im Arbeitsspeicher dieses Fensters und wird
 * beim Sperren, beim Verlassen und beim Schliessen verworfen. Geheimtext geht
 * per "Teilen" direkt in den Messenger (keine Zwischenablage noetig); beim
 * Entschluesseln aus der Zwischenablage wird sie danach geleert.
 *
 * Anhaenge (Bild, Sprachnachricht, Datei): als Siegel-Datei (MSF1, ".sgl").
 * Entschluesselte Inhalte nur im Arbeitsspeicher - Bild als data:-URI;
 * Sprachnachricht und "Oeffnen/Teilen" brauchen kurz eine Cache-Datei
 * (SiegelFiles.js), die so frueh wie moeglich geloescht wird.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView, Share, Alert,
  ActivityIndicator, PermissionsAndroid, Platform, useWindowDimensions, Image, NativeModules,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { Camera } from 'react-native-camera-kit';
import Clipboard from '@react-native-clipboard/clipboard';
import { copySensitive } from './SecureClipboard';
import Icon from 'react-native-vector-icons/Feather';
import * as V from './SiegelVault';
import { INVITE_PREFIX, ACK_PREFIX, MESSAGE_PREFIX, splitForQr, QrAssembler, siegelKind, isSiegelMedia, MAX_MEDIA_BYTES } from './SiegelCrypto';
import * as SF from './SiegelFiles';
import { claimAudio, releaseAudio } from './AppFocus';
import { getTheme, subscribeTheme } from './Themes';
import { forceScreenProtection } from './ScreenSecurity';
import { t } from './i18n';

// Native Bibliotheken fuer Anhaenge erst bei Bedarf laden.
const imagePicker = () => require('react-native-image-picker');
const docPicker = () => require('@react-native-documents/picker');
// Eigene Instanz (der native Spieler/Rekorder ist trotzdem nur einer, siehe Design).
let audioLib = null;
function audio() {
  if (!audioLib) {
    const lib = require('react-native-audio-recorder-player');
    audioLib = { lib, player: new lib.default() };
  }
  return audioLib;
}
const MAX_RECORD_MS = 5 * 60 * 1000;
// Groesste Siegel-Datei, die geoeffnet wird (16 MB Inhalt + Auffuellung + Kopf).
const MAX_SIEGEL_FILE = Math.ceil(MAX_MEDIA_BYTES * 1.07) + 70000;

// Farben aus dem gewaehlten Design (Themes.js) - wie P in App.tsx ein Objekt,
// das bei jedem Themenwechsel in place aktualisiert wird. Vorher eine feste
// Nachtblau-Palette: in hellen und Pro-Designs passte Siegel nicht zum Rest.
const C: any = {};
function syncColors(t) {
  Object.assign(C, {
    bg: t.bg, surface: t.surface, surfaceAlt: t.surfaceAlt, border: t.border, text: t.text,
    sub: t.textSub, muted: t.textMuted, danger: t.danger, ok: t.success,
    accent: t.accent, onAccent: t.onAccent, accentFg: t.accentFg,
    headerBg: t.headerBg, headerBorder: t.headerBorder, headerText: t.headerText, headerIcon: t.headerIcon,
  });
}
syncColors(getTheme());
subscribeTheme(syncColors);

function errorText(e) {
  switch (e?.code) {
    case 'format': return t('siegel.err.format');
    case 'used': return t('siegel.err.used');
    case 'auth': return t('siegel.err.auth');
    case 'confirm': return t('siegel.err.confirm');
    case 'no-invite': return t('siegel.err.noInvite');
    case 'too-long': return t('siegel.err.tooLong');
    case 'locked': return t('siegel.err.locked');
    case 'passphrase': return e.message;
    case 'unavailable': return t('siegel.err.unavailable');
    case 'storage': return t('siegelUi.derSpeicherIstGeradeNicht');
    default: return t('siegel.err.default');
  }
}

function mediaErrorText(e) {
  switch (e?.code) {
    case 'format': return t('siegel.mediaErr.format');
    case 'used': return t('siegel.mediaErr.used');
    case 'auth': return t('siegel.mediaErr.auth');
    case 'too-long': return t('siegel.mediaErr.tooLong');
    default: return errorText(e);
  }
}

function fmtSecs(s) {
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function isCancel(e) {
  try {
    const { isErrorWithCode, errorCodes } = docPicker();
    return isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED;
  } catch { return false; }
}

function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return t('time.s', { s });
  const m = Math.ceil(s / 60);
  return m < 60 ? t('time.m', { m }) : t('time.h', { h: Math.ceil(m / 60) });
}

// Gefuellt: Akzent mit der dazu passenden Schrift (onAccent, >= 4.5:1).
// Umriss: Rand und Schrift in der uebergebenen Farbe (Standard: lesbarer Akzent).
function Btn({ label, onPress, color, outline, disabled }) {
  const fg = color || C.accentFg;
  return (
    <TouchableOpacity accessibilityRole="button" onPress={onPress} disabled={disabled} activeOpacity={0.8}
      style={{ borderRadius: 12, padding: 14, alignItems: 'center', opacity: disabled ? 0.5 : 1,
        backgroundColor: outline ? 'transparent' : C.accent, borderWidth: outline ? 1 : 0, borderColor: outline ? fg : C.accent }}>
      <Text style={{ color: outline ? fg : C.onAccent, fontWeight: '500', fontSize: 15 }}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field(props) {
  return (
    <TextInput placeholderTextColor={C.muted} autoCorrect={false} autoComplete="off" importantForAutofill="no"
      {...props}
      style={[{ borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, fontSize: 15, color: C.text }, props.style]} />
  );
}

// Sammelt die nacheinander gezeigten Teile ein (QrAssembler) und meldet den
// vollstaendigen Code einmal.
function Scanner({ onScanned, onClose }) {
  const done = useRef(false);
  const asm = useRef(new QrAssembler());
  const [progress, setProgress] = useState('');
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Camera style={{ flex: 1 }} scanBarcode showFrame laserColor="#0A7EA4" frameColor="white"
        barcodeFrameSize={{ width: 320, height: 320 }} allowedBarcodeTypes={['qr']} scanThrottleDelay={150}
        onReadCode={(event) => {
          if (done.current) return;
          const value = event?.nativeEvent?.codeStringValue;
          if (!value) return;
          const r = asm.current.add(value);
          if (!r) return;
          if (r.code) { done.current = true; onScanned(r.code); return; }
          setProgress(t('siegel.scan.progress', { have: r.have, total: r.total }));
        }} />
      <View style={{ position: 'absolute', top: 48, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 8 }}>
        <Text style={{ color: 'white', fontSize: 15 }}>{progress || t('siegel.scan.hold')}</Text>
      </View>
      <TouchableOpacity onPress={onClose} style={{ position: 'absolute', bottom: 48, alignSelf: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 24, paddingHorizontal: 24, paddingVertical: 12 }}>
        <Text style={{ color: 'white', fontSize: 15 }}>{t('common.cancel')}</Text>
      </TouchableOpacity>
    </View>
  );
}

async function cameraAllowed() {
  if (Platform.OS !== 'android') return true;
  try {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
      title: t('common.camera'), message: t('siegel.perm.camera'), buttonPositive: 'OK',
    });
    return r === PermissionsAndroid.RESULTS.GRANTED;
  } catch { return false; }
}

async function micAllowed() {
  if (Platform.OS !== 'android') return true;
  try {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: t('common.microphone'), message: t('siegel.perm.mic'), buttonPositive: 'OK',
    });
    return r === PermissionsAndroid.RESULTS.GRANTED;
  } catch { return false; }
}

// Zeigt einen Kopplungs-Code als Folge kleiner QR-Codes (wechseln von selbst).
const QR_PART_MS = 700;
function AnimatedQr({ code }) {
  const { width } = useWindowDimensions();
  const parts = useMemo(() => { try { return splitForQr(code); } catch { return [code]; } }, [code]);
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (parts.length < 2) return undefined;
    const t = setInterval(() => setI((x) => (x + 1) % parts.length), QR_PART_MS);
    return () => clearInterval(t);
  }, [parts]);
  const size = Math.min(width - 64, 360);
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <View style={{ backgroundColor: 'white', borderRadius: 16, padding: 12 }}>
        <QRCode value={parts[i % parts.length]} size={size} ecl="M" quietZone={12} backgroundColor="white" color="#000" />
      </View>
      <Text style={{ color: C.muted, fontSize: 12 }}>{t('siegel.qrPart', { i: (i % parts.length) + 1, n: parts.length })}</Text>
    </View>
  );
}

// initialMessage: Geheimtext aus einem Malachi-Chat - nach dem Entsperren
// sofort entschluesseln (ohne Zwischenablage).
// onSendCipher: aus einem Malachi-Chat geoeffnet - Antworten gehen als
// Siegel-Geheimtext direkt in diesen Chat zurueck.
// chatId/chatName: aus einem Malachi-Chat geoeffnet (Mikrofon 1,5 s halten bzw.
// Siegel-Blase): Kopplung ueber diesen Chat, Schreiben fuer den verknuepften
// Siegel-Kontakt. Die Verknuepfung steht nur im Tresor.
// onSendFile(base64, fileName, mime): aus einem Malachi-Chat geoeffnet -
// Siegel-Anhaenge gehen als Datei "siegel-<zufall>.sgl" in diesen Chat.
// initialMedia: Siegel-Datei (Base64) aus einem Malachi-Chat - nach dem
// Entsperren sofort oeffnen.
// canSeal: Verschluesseln/Antworten/Einladen (Vollversion). Entschluesseln,
// Oeffnen, Exportieren und das Annehmen einer Einladung sind kostenlos
// (Entscheidung 2026-10-19: wer eine Siegel-Nachricht bekommt, soll sie ohne
// Kauf lesen koennen). onOpenPro: optional, fuehrt zur Vollversion.
export default function SiegelScreen({ visible, onClose, accent, initialMessage = null, onSendCipher = null, chatId = null, chatName = '', onSendFile = null, initialMedia = null, canSeal = true, onOpenPro = null }) {
  // Schrift-/Symbolfarbe im Akzent (lesbar auf allen Flaechen); gefuellte
  // Flaechen nutzen C.accent mit C.onAccent.
  const AC = C.accentFg;
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const chatFiles = !!(onSendFile && chatId);
  // loading | setup | locked | list | newPair | invite | ack | paired | contact | decryptAny
  const [view, setView] = useState('loading');
  const [scan, setScan] = useState(null);          // null | 'invite' | 'ack'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [contacts, setContacts] = useState([]);
  const [qr, setQr] = useState('');
  const [pairName, setPairName] = useState('');
  const [paired, setPaired] = useState(null);       // { id, name, safety }
  const [current, setCurrent] = useState(null);     // { id, name, safety }
  const [tab, setTab] = useState('enc');
  const [input, setInput] = useState('');
  const [cipher, setCipher] = useState('');
  const [plain, setPlain] = useState('');
  const [plainFrom, setPlainFrom] = useState('');
  const [plainId, setPlainId] = useState(null);
  const [reply, setReply] = useState('');
  // Entschluesselter Anhang - NUR im Arbeitsspeicher:
  // { kind, mime, name, size, b64, from, fromId }
  const [media, setMedia] = useState(null);
  const [sealedOut, setSealedOut] = useState(null); // { path, name } Siegel-Datei zum erneuten Teilen
  const [playing, setPlaying] = useState(false);
  const [recSecs, setRecSecs] = useState(null);     // null = keine Aufnahme
  const pendingMsg = useRef(null);
  const pendingMedia = useRef(null);
  const playPath = useRef(null);
  const recPath = useRef(null);
  // An wen der naechste Anhang geht: Kontakt-Fenster oder Absender der gerade
  // gelesenen Nachricht/des gelesenen Anhangs (Antwort).
  const mediaTarget = useRef(null);
  const [plusFor, setPlusFor] = useState(null);     // offenes "+"-Menue (Ziel-Kontakt)
  const recTimer = useRef(null);
  const recStart = useRef(0);

  // Wiedergabe beenden und die (entschluesselte) Cache-Datei sofort loeschen.
  const stopPlayback = () => {
    const p = playPath.current;
    playPath.current = null;
    if (p) {
      const { player } = audio();
      player.removePlayBackListener();
      player.stopPlayer().catch(() => {}).finally(() => SF.removeTemp(p));
      releaseAudio('siegel');
    }
    setPlaying(false);
  };
  // Audio-Fokus (AppFocus.js): laeuft im Chat gerade eine Sprachnachricht, wird
  // sie beendet, bevor Siegel abspielt/aufnimmt - und umgekehrt.
  const stopSiegelAudio = () => { stopPlayback(); cancelRecording(); };
  // Laufende Aufnahme verwerfen (Datei geloescht).
  const cancelRecording = () => {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    const p = recPath.current;
    recPath.current = null;
    if (p) {
      audio().player.stopRecorder().catch(() => {}).finally(() => SF.removeTemp(p));
      releaseAudio('siegel');
    }
    setRecSecs(null);
  };
  const discardMedia = () => { stopPlayback(); cancelRecording(); setMedia(null); setSealedOut(null); };

  const clearSensitive = () => {
    setPass1(''); setPass2(''); setInput(''); setCipher(''); setPlain(''); setPlainFrom(''); setPlainId(null); setReply('');
    setQr(''); setPaired(null); setCurrent(null); setScan(null); setError(''); setNotice(''); setPairName('');
    setPlusFor(null); mediaTarget.current = null;
    discardMedia();
  };

  // Gesperrt (Hintergrund, 60 s ohne Bedienung): alles Sensible verwerfen.
  useEffect(() => V.subscribe((open) => {
    if (open) return;
    clearSensitive();
    setView((v) => (v === 'setup' || v === 'loading' ? v : 'locked'));
  }), []);

  // Siegel ist immer vor Screenshots geschuetzt (ScreenSecurity.js).
  useEffect(() => {
    forceScreenProtection('siegel', !!visible);
    return () => forceScreenProtection('siegel', false);
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      V.cancelInvite(); V.lock(); clearSensitive(); setView('loading'); pendingMsg.current = null; pendingMedia.current = null;
      SF.cleanupSiegelTemp();
      return;
    }
    SF.cleanupSiegelTemp();      // Reste vom letzten Mal (z.B. App beendet)
    pendingMsg.current = initialMessage || null;
    pendingMedia.current = initialMedia || null;
    let alive = true;
    (async () => {
      if (V.isUnlocked()) { goHome(); return; }
      // Audit C6: bei unlesbarem Speicher nie die Einrichtung anbieten
      // (wuerde einen bestehenden Tresor ersetzen) - Sperrbildschirm zeigt
      // dann beim Entsperren den Fehler.
      const state = await V.vaultState();
      if (alive) setView(state === 'absent' ? 'setup' : 'locked');
    })();
    return () => { alive = false; };
  }, [visible]);

  useEffect(() => () => {
    stopPlayback();
    cancelRecording();
    SF.cleanupSiegelTemp();
  }, []);

  // Waehrend ein Kopplungs-Code gezeigt wird, tippt niemand aufs Display -
  // den Tresor dann bis zu 5 min offen halten (sonst verfiele die Einladung).
  useEffect(() => {
    if (view !== 'invite' && view !== 'ack') return undefined;
    const started = Date.now();
    const t = setInterval(() => { if (Date.now() - started < 5 * 60 * 1000) V.touch(); }, 20000);
    return () => clearInterval(t);
  }, [view]);

  const refresh = () => { try { setContacts(V.listContacts()); } catch { setContacts([]); } };
  // Nach dem Entsperren: Liste - oder direkt die mitgebrachte Nachricht.
  const goHome = () => {
    refresh();
    const mb = pendingMedia.current;
    pendingMedia.current = null;
    if (mb) {
      pendingMsg.current = null;
      setView('decryptAny');
      openMediaBytes(SF.b64ToBytes(mb));
      return;
    }
    const m = pendingMsg.current;
    pendingMsg.current = null;
    const kind = m ? siegelKind(m) : null;
    if (kind === 'invite') {
      // Einladung aus dem Chat annehmen -> Antwort zurueck in den Chat.
      setView('list');
      run(async () => {
        const r = await V.acceptInviteAndStore(m, chatName, { chatId });
        refresh();
        if (onSendCipher) onSendCipher(r.qr);
        setPaired(r.contact);
        setView('paired');
      });
      return;
    }
    if (kind === 'ack') {
      setView('list');
      run(async () => {
        const c = await V.finishInvite(m, chatName, { chatId });
        refresh();
        setPaired(c);
        setView('paired');
      });
      return;
    }
    if (kind === 'msg') {
      setView('decryptAny');
      run(async () => {
        const r = await V.openAny(m);
        setPlain(r.text);
        setPlainFrom(r.name);
        setPlainId(r.id);
      });
      return;
    }
    // Aus dem Chat zum Schreiben geoeffnet: verknuepften Kontakt direkt oeffnen.
    if (chatId) {
      let linked = null;
      try { linked = V.contactForChat(chatId); } catch {}
      if (linked) { openContact(linked); return; }
    }
    setView('list');
  };

  // Kopplung ueber den Malachi-Chat: Einladung als Nachricht verschicken.
  const pairViaChat = () => run(async () => {
    if (!canSeal) return;
    const code = await V.startInvite();
    onSendCipher?.(code);
    setView('invitedViaChat');
  });
  const run = async (fn, forMedia = false) => {
    setError(''); setNotice(''); setBusy(true);
    try { await fn(); } catch (e) { setError(forMedia ? mediaErrorText(e) : errorText(e)); } finally { setBusy(false); }
  };

  const doSetup = () => run(async () => {
    if (pass1 !== pass2) { setError(t('siegel.mismatch')); return; }
    const problem = V.passphraseProblem(pass1);
    if (problem) { setError(problem); return; }
    await V.setup(pass1);
    setPass1(''); setPass2('');
    goHome();
  });

  const doUnlock = () => run(async () => {
    const r = await V.unlock(pass1);
    setPass1('');
    if (r.ok) { goHome(); return; }
    if (r.reason === 'wrong') setError('Falsche Passphrase. Noch ' + r.remaining + (r.remaining === 1 ? ' Versuch' : ' Versuche') + ', dann wird der Tresor gelöscht.' + (r.waitMs ? ' Nächster Versuch in ' + fmtWait(r.waitMs) + '.' : ''));
    else if (r.reason === 'wait') setError('Zu viele Fehlversuche – bitte ' + fmtWait(r.waitMs) + ' warten.');
    else if (r.reason === 'wiped') { setError('Zu viele Fehlversuche: Der Siegel-Tresor wurde gelöscht.'); setView('setup'); }
    else if (r.reason === 'storage') setError('Der Speicher ist gerade nicht lesbar. Bitte die App neu starten – der Tresor bleibt erhalten.');
    else if (r.reason === 'nokey') setError('Der Sicherheitsschlüssel dieses Geräts fehlt – dieser Tresor lässt sich nicht mehr öffnen. Du kannst ihn unten löschen und neu einrichten.');
    else setView('setup');
  });

  const startInvite = () => run(async () => {
    if (!canSeal) return;
    const code = await V.startInvite();
    setQr(code);
    setView('invite');
  });

  const openScanner = async (kind) => {
    setError('');
    if (!(await V.holdOpen(cameraAllowed))) { setError('Ohne Kamera kann der Code nicht gescannt werden.'); return; }
    setScan(kind);
  };

  const onScanned = (value) => {
    const kind = scan;
    setScan(null);
    run(async () => {
      if (kind === 'invite') {
        if (!String(value).startsWith(INVITE_PREFIX)) { setError(t('siegel.notInvite')); return; }
        const r = await V.acceptInviteAndStore(value, pairName);
        setQr(r.qr);
        setPaired(r.contact);
        refresh();
        setView('ack');
      } else {
        if (!String(value).startsWith(ACK_PREFIX)) { setError(t('siegel.notAck')); return; }
        const c = await V.finishInvite(value, pairName);
        setQr('');
        setPaired(c);
        refresh();
        setView('paired');
      }
    });
  };

  const openContact = (c) => { discardMedia(); setCurrent(c); setTab(canSeal ? 'enc' : 'dec'); setInput(''); setCipher(''); setPlain(''); setView('contact'); };
  // Im Chat-Modus: gewaehlten Kontakt mit diesem Chat verknuepfen (im Tresor).
  const chooseContact = (c) => {
    if (chatId && onSendCipher) V.linkChat(c.id, chatId).catch(() => {});
    openContact(c);
  };

  const doSeal = () => run(async () => {
    if (!canSeal) return;
    if (!input.trim()) return;
    const msg = await V.seal(current.id, input);
    setInput('');
    if (onSendCipher && chatId) {
      // Direkt in den Chat; Siegel danach sperren und schliessen.
      V.lock();
      clearSensitive();
      onSendCipher(msg);
      onClose?.();
      return;
    }
    setCipher(msg);
    try { await Share.share({ message: msg }); } catch {}
  });

  const copyCipher = () => {
    if (!cipher) return;
    // Geschuetzt kopieren (SecureClipboard.js) - die Leerung nach 60 s laeuft
    // auch weiter, wenn Siegel vorher geschlossen wird.
    copySensitive(cipher).catch(() => {});
    setNotice(t('siegel.copied'));
  };

  const readClipboard = async () => {
    const t = await Clipboard.getString();
    if (t && t.includes(MESSAGE_PREFIX)) Clipboard.setString('');   // nichts liegen lassen
    return t || '';
  };

  const doOpen = (fromClipboard) => run(async () => {
    const text = fromClipboard ? await readClipboard() : input;
    if (!text.trim()) { setError(t('siegel.clipboardEmpty')); return; }
    stopPlayback(); setMedia(null);
    if (view === 'decryptAny') {
      const r = await V.openAny(text);
      setPlain(r.text);
      setPlainFrom(r.name);
      setPlainId(r.id);
    } else {
      setPlain(await V.open(current.id, text));
      setPlainFrom(current.name);
      setPlainId(current.id);
    }
    setInput('');
  });

  // Antwort direkt aus dem Lese-Fenster - wieder als Siegel. Aus einem
  // Malachi-Chat geoeffnet: zurueck in diesen Chat, sonst ueber "Teilen".
  // Danach wird auch der gelesene Text verworfen (Zero Trace).
  const doReply = () => run(async () => {
    if (!canSeal) return;
    const to = plainId || media?.fromId;
    if (!reply.trim() || !to) return;
    const msg = await V.seal(to, reply);
    setReply('');
    setPlain(''); setPlainFrom('');
    stopPlayback(); setMedia(null);
    if (onSendCipher) {
      V.lock();
      clearSensitive();
      onSendCipher(msg);
      onClose?.();
      return;
    }
    setCipher(msg);
    try { await Share.share({ message: msg }); } catch {}
    setNotice(t('siegel.replySent'));
  });

  // ── Anhaenge ──────────────────────────────────────────────────────────────
  // Entschluesselt: nur in den Arbeitsspeicher (State), Bytes danach nullen.
  const showMedia = (r) => {
    const m = r.media;
    setPlain(''); setPlainFrom(''); setPlainId(null);
    setMedia({ kind: m.kind, mime: m.mime, name: m.name, size: m.bytes.length, b64: SF.bytesToB64(m.bytes), from: r.name, fromId: r.id });
    try { m.bytes.fill(0); } catch {}
  };

  const openMediaBytes = (bytes) => run(async () => {
    stopPlayback(); setMedia(null);
    if (!isSiegelMedia(bytes)) { setError(t('siegel.mediaErr.format')); return; }
    showMedia(await V.openMediaAny(bytes));
  }, true);

  // Siegel-Datei aus WhatsApp & Co. (vorher auf dem Geraet gespeichert) oeffnen.
  const pickSiegelFile = () => run(async () => {
    let picked;
    try {
      [picked] = await V.holdOpen(() => docPicker().pick({ type: ['*/*'] }));
    } catch (e) {
      if (isCancel(e)) return;
      throw e;
    }
    if (!picked) return;
    if (Number.isFinite(picked.size) && picked.size > MAX_SIEGEL_FILE) { setError(mediaErrorText({ code: 'too-long' })); return; }
    const bytes = SF.b64ToBytes(await SF.readB64(picked.uri));
    stopPlayback(); setMedia(null);
    if (!isSiegelMedia(bytes)) { setError(t('siegel.mediaErr.format')); return; }
    showMedia(await V.openMediaAny(bytes));
  }, true);

  const shareSealed = async (path) => {
    try {
      await NativeModules.FileShareModule.shareFile(path, SF.SIEGEL_FILE_MIME, t('siegel.shareTitle'));
    } catch {
      setError(t('siegel.shareFailed'));
    }
  };

  // Verschluesseln und weitergeben: im Chat-Modus direkt in den Chat (danach
  // sperren und schliessen wie bei Text), sonst als Datei teilen.
  const sendMedia = async (m) => {
    const to = mediaTarget.current || current?.id;
    if (!to) throw Object.assign(new Error('kein Ziel'), { code: 'unknown' });
    const file = await V.sealMediaFor(to, m);
    try { m.bytes.fill(0); } catch {}
    const b64 = SF.bytesToB64(file);
    const name = await SF.newSiegelFileName();
    if (chatFiles) {
      V.lock();
      clearSensitive();
      onSendFile(b64, name, SF.SIEGEL_FILE_MIME);
      onClose?.();
      return;
    }
    const path = await SF.writeTemp(name, b64);
    setSealedOut({ path, name });
    setNotice(t('siegel.fileReady'));
    await shareSealed(path);
  };

  const sealImage = (to) => run(async () => {
    if (!canSeal) return;
    mediaTarget.current = to || current?.id || null;
    const res = await V.holdOpen(() => imagePicker().launchImageLibrary({
      mediaType: 'photo', includeBase64: true, maxWidth: 2048, maxHeight: 2048, quality: 0.8,
    }));
    const asset = res?.assets?.[0];
    // Die Bildauswahl legt eine verkleinerte Kopie im Cache ab - sofort weg.
    if (asset?.uri) SF.removeIfInCache(asset.uri);
    if (res?.didCancel || !asset) return;
    if (!asset.base64) { setError(t('siegel.imageLoadFailed')); return; }
    const mime = /^image\//.test(asset.type || '') ? asset.type : 'image/jpeg';
    const name = 'Bild.' + (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');
    await sendMedia({ kind: 'image', mime, name, bytes: SF.b64ToBytes(asset.base64) });
  }, true);

  const sealFile = (to) => run(async () => {
    if (!canSeal) return;
    mediaTarget.current = to || current?.id || null;
    let picked;
    try {
      [picked] = await V.holdOpen(() => docPicker().pick({ type: ['*/*'] }));
    } catch (e) {
      if (isCancel(e)) return;
      throw e;
    }
    if (!picked) return;
    if (Number.isFinite(picked.size) && picked.size > MAX_MEDIA_BYTES) { setError(mediaErrorText({ code: 'too-long' })); return; }
    const b64 = await SF.readB64(picked.uri);
    await sendMedia({ kind: 'file', mime: picked.type || 'application/octet-stream', name: picked.name || 'Datei', bytes: SF.b64ToBytes(b64) });
  }, true);

  const startRecording = (to) => run(async () => {
    if (!canSeal) return;
    if (recPath.current) return;
    mediaTarget.current = to || current?.id || null;
    if (!(await V.holdOpen(micAllowed))) { setError('Ohne Mikrofon keine Sprachnachricht.'); return; }
    await claimAudio('siegel', stopSiegelAudio);
    const { lib, player } = audio();
    const p = await SF.tempPath('aufnahme.mp4');
    recPath.current = p;
    try {
      await player.startRecorder(p, {
        AudioSourceAndroid: lib.AudioSourceAndroidType?.MIC,
        OutputFormatAndroid: lib.OutputFormatAndroidType?.MPEG_4,
        AudioEncoderAndroid: lib.AudioEncoderAndroidType?.AAC,
        AudioSamplingRateAndroid: 16000,
        AudioEncodingBitRateAndroid: 32000,
        AudioChannelsAndroid: 1,
      });
    } catch (e) {
      cancelRecording();
      throw e;
    }
    recStart.current = Date.now();
    setRecSecs(0);
    recTimer.current = setInterval(() => {
      const ms = Date.now() - recStart.current;
      setRecSecs(Math.floor(ms / 1000));
      V.touch();                                   // waehrend der Aufnahme offen halten
      if (ms >= MAX_RECORD_MS) stopRecordingAndSeal();
    }, 1000);
  }, true);

  // Aufnahme beenden: Datei lesen, sofort loeschen, verschluesseln.
  const stopRecordingAndSeal = () => run(async () => {
    const p = recPath.current;
    if (!p) return;
    recPath.current = null;
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    const ms = Date.now() - recStart.current;
    setRecSecs(null);
    let b64 = '';
    try {
      await audio().player.stopRecorder();
      releaseAudio('siegel');
      b64 = await SF.readB64(p);
    } finally {
      SF.removeTemp(p);
    }
    if (ms < 500 || !b64) return;                  // versehentlich angetippt
    await sendMedia({ kind: 'audio', mime: 'audio/mp4', name: 'Sprachnachricht.mp4', bytes: SF.b64ToBytes(b64) });
  }, true);

  // Sprachnachricht abspielen: nur fuer die Dauer der Wiedergabe als
  // Cache-Datei (der native Spieler braucht einen Pfad).
  const togglePlay = () => run(async () => {
    if (playPath.current) { stopPlayback(); return; }
    if (media?.kind !== 'audio') return;
    await claimAudio('siegel', stopSiegelAudio);
    const { player } = audio();
    const p = await SF.writeTemp('wiedergabe.mp4', media.b64);
    playPath.current = p;
    setPlaying(true);
    player.addPlayBackListener((e) => {
      if (e?.isFinished || (e?.duration > 0 && e.currentPosition >= e.duration)) { stopPlayback(); return; }
      V.touch();                                   // waehrend der Wiedergabe offen halten
    });
    try {
      await player.startPlayer(p);
    } catch (e) {
      stopPlayback();
      throw e;
    }
  }, true);

  // Datei oeffnen/teilen: verlaesst damit Siegel - nur nach Warnung.
  // Export (Nutzerwunsch: z.B. Kanzlei und Mandant - Nachrichten und Dateien
  // muessen sich unabhaengig vom Absender in eine Akte uebernehmen lassen):
  // nur auf ausdruecklichen Wunsch, mit Warnung, ueber das System-Teilen
  // ("In Dateien speichern", E-Mail, Aktenprogramm ...). Siegel selbst
  // speichert weiterhin nichts - die Kopie hier wird beim Schliessen geloescht.
  const exportMedia = () => {
    const m = media;
    if (!m) return;
    Alert.alert(t('siegelUi.exportierenVerlaesstSiegel'), t('siegelUi.dieEntschluesselteDateiWirdAn'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('siegelUi.exportieren'), onPress: () => run(async () => {
        const p = await SF.writeTemp(m.name, m.b64);
        await NativeModules.FileShareModule.shareFile(p, m.mime, m.name);
      }, true) },
    ]);
  };
  const exportText = () => {
    const text = plain;
    if (!text) return;
    Alert.alert(t('siegelUi.exportierenVerlaesstSiegel'), t('siegelUi.derEntschluesselteTextWirdAls'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('siegelUi.exportieren'), onPress: () => run(async () => {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
        const name = t('siegelUi.siegelNachrichtTxt', { value: (plainFrom || '').slice(0, 30), stamp });
        const body = t('siegelUi.vonEntschluesselt', { value: plainFrom || '', value2: new Date().toLocaleString(), text });
        const p = await SF.writeTemp(name, SF.textToB64(body));
        await NativeModules.FileShareModule.shareFile(p, 'text/plain', name);
      }, true) },
    ]);
  };

  const confirmDeleteContact = (c) => Alert.alert(t('siegel.deleteContact.title'), t('siegel.deleteContact.body', { name: c.name }), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('common.delete'), style: 'destructive', onPress: () => run(async () => { await V.deleteContact(c.id); refresh(); setView('list'); setCurrent(null); }) },
  ]);

  const confirmWipe = () => Alert.alert(t('siegel.wipe.title'), t('siegel.wipe.body'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('common.delete'), style: 'destructive', onPress: () => run(async () => { await V.wipe(); clearSensitive(); setView('setup'); }) },
  ]);

  const close = () => { V.cancelInvite(); V.lock(); clearSensitive(); onClose?.(); };

  // Kopfleiste wie im Rest der App (Design-Farben der Kopfleiste).
  const header = (title, back) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10, backgroundColor: C.headerBg, borderBottomWidth: 0.5, borderBottomColor: C.headerBorder }}>
      <TouchableOpacity onPress={back || close} accessibilityLabel={back ? t('siegelUi.zurueck') : t('siegel.close')} style={{ padding: 6, marginRight: 4 }}>
        <Icon name={back ? 'arrow-left' : 'x'} size={22} color={C.headerIcon} />
      </TouchableOpacity>
      <Icon name="lock" size={15} color={C.headerIcon} style={{ marginRight: 8 }} />
      <Text style={{ flex: 1, color: C.headerText, fontSize: 17, fontWeight: '600' }} numberOfLines={1}>{title}</Text>
    </View>
  );

  // Hinweis statt Verschluesseln-Funktion ohne Vollversion.
  const proHint = (what) => (
    <View style={{ backgroundColor: C.surface, borderRadius: 14, borderWidth: 0.5, borderColor: C.border, padding: 14, gap: 10 }}>
      <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19 }}>{t('siegelUi.istTeilDerVollversionSiegel', { what })}</Text>
      {!!onOpenPro && <Btn label={t('siegelUi.vollversionAnsehen')} outline onPress={() => { close(); onOpenPro(); }} />}
    </View>
  );

  const messages = (
    <>
      {!!error && <Text style={{ color: C.danger, fontSize: 13, lineHeight: 19 }}>{error}</Text>}
      {!!notice && <Text style={{ color: C.ok, fontSize: 13, lineHeight: 19 }}>{notice}</Text>}
      {busy && <ActivityIndicator color={AC} />}
    </>
  );

  const bigQr = (value) => <AnimatedQr code={value} />;

  // Einheitliches Siegel-Eingabefeld (wie in Messengern): "+" fuer Bild/Datei,
  // Text, rechts Mikrofon bzw. - sobald Text da ist - Senden. Waehrend der
  // Aufnahme: Zeit, Verwerfen, Senden. Ueberall gleich: Schreibfenster und
  // Antwort unter einer gelesenen Nachricht/einem Anhang.
  const composer = ({ value, setValue, placeholder, to, onSendText }) => {
    const round = { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' };
    if (recSecs !== null) {
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.surface, borderRadius: 22, borderWidth: 1, borderColor: C.danger, padding: 6 }}>
          <TouchableOpacity accessibilityLabel={t('siegel.discardRecording')} onPress={cancelRecording} style={[round, { backgroundColor: C.border }]}>
            <Icon name="trash-2" size={18} color={C.text} />
          </TouchableOpacity>
          <Text style={{ flex: 1, color: C.text, fontSize: 15 }}>{t('siegelUi.aufnahme', { value: fmtSecs(recSecs) })}</Text>
          <TouchableOpacity accessibilityLabel={t('siegelUi.sprachnachrichtSenden')} onPress={stopRecordingAndSeal} style={[round, { backgroundColor: C.accent }]}>
            <Icon name="send" size={18} color={C.onAccent} />
          </TouchableOpacity>
        </View>
      );
    }
    const hasText = !!String(value || '').trim();
    return (
      <View style={{ gap: 6 }}>
        {plusFor === to && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Btn label={t('common.image')} outline color={AC} onPress={() => { setPlusFor(null); sealImage(to); }} disabled={busy} /></View>
            <View style={{ flex: 1 }}><Btn label={t('common.file')} outline color={AC} onPress={() => { setPlusFor(null); sealFile(to); }} disabled={busy} /></View>
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <TouchableOpacity accessibilityLabel={t('siegelUi.anhang')} onPress={() => setPlusFor(plusFor === to ? null : to)} disabled={busy}
            style={[round, { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border }]}>
            <Icon name={plusFor === to ? 'x' : 'plus'} size={20} color={AC} />
          </TouchableOpacity>
          {/* visible-password: Tastaturen lernen dabei nicht mit (kein Klartext im Woerterbuch). */}
          <TextInput value={value} onChangeText={setValue} multiline keyboardType="visible-password"
            placeholder={placeholder} placeholderTextColor={C.muted} autoCorrect={false} autoComplete="off" importantForAutofill="no"
            style={{ flex: 1, minHeight: 42, maxHeight: 140, borderWidth: 1, borderColor: C.border, borderRadius: 21, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: C.text, textAlignVertical: 'top' }} />
          {hasText ? (
            <TouchableOpacity accessibilityLabel={t('siegelUi.senden')} onPress={onSendText} disabled={busy} style={[round, { backgroundColor: C.accent }]}>
              <Icon name="send" size={18} color={C.onAccent} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity accessibilityLabel={t('common.voiceMessage')} onPress={() => startRecording(to)} disabled={busy} style={[round, { backgroundColor: C.accent }]}>
              <Icon name="mic" size={18} color={C.onAccent} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const replyPart = (toName, toId) => (canSeal ? composer({
    value: reply, setValue: setReply, placeholder: 'Antwort an ' + toName, to: toId, onSendText: doReply,
  }) : proHint('Mit Siegel antworten'));

  const plainBox = !!plain && (
    <View style={{ backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.accent, padding: 14, gap: 10 }}>
      <Text style={{ color: C.muted, fontSize: 12 }}>{t('siegelUi.vonWirdBeimSchliessenVerworfen', { plainFrom })}</Text>
      <Text selectable={false} style={{ color: C.text, fontSize: 16, lineHeight: 23 }}>{plain}</Text>
      {!!plainId && replyPart(plainFrom, plainId)}
      <Btn label={t('siegelUi.exportieren2')} outline color={AC} onPress={exportText} disabled={busy} />
      <Btn label={t('siegel.readDiscard')} outline color={C.sub} onPress={() => { setPlain(''); setPlainFrom(''); setReply(''); }} />
    </View>
  );

  // Entschluesselter Anhang: Bild aus dem Arbeitsspeicher (data:-URI), keine Datei.
  const imageMime = (m) => (/^image\/(jpeg|png|webp|gif|heic|heif|bmp)$/.test(m) ? m : 'image/jpeg');
  const mediaBox = !!media && (
    <View style={{ backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.accent, padding: 14, gap: 10 }}>
      <Text style={{ color: C.muted, fontSize: 12 }}>{t('siegelUi.vonWirdBeimSchliessenVerworfen2', { from: media.from })}</Text>
      {media.kind === 'image' ? (
        <Image source={{ uri: 'data:' + imageMime(media.mime) + ';base64,' + media.b64 }} resizeMode="contain"
          style={{ width: '100%', height: Math.min(winW - 64, 420), borderRadius: 10, backgroundColor: '#000' }} />
      ) : media.kind === 'audio' ? (
        <>
          <Text style={{ color: C.text, fontSize: 16 }}>{t('siegel.voiceLine', { size: SF.fmtSize(media.size) })}</Text>
          <Btn label={playing ? t('siegel.stop') : t('siegel.play')} color={AC} onPress={togglePlay} disabled={busy && !playing} />
        </>
      ) : (
        <>
          <Text style={{ color: C.text, fontSize: 16 }} numberOfLines={2}>📄 {media.name}</Text>
          <Text style={{ color: C.sub, fontSize: 12 }}>{SF.fmtSize(media.size)} · {media.mime}</Text>
        </>
      )}
      {/* Fuer alle Arten (Bild, Sprachnachricht, Datei): Export in Akte/Dateien. */}
      <Btn label={media.kind === 'file' ? t('siegelUi.oeffnenExportieren') : t('siegelUi.exportieren2')} outline color={AC} onPress={exportMedia} disabled={busy} />
      {!!media.fromId && replyPart(media.from, media.fromId)}
      <Btn label={t('siegel.readDiscard')} outline color={C.sub} onPress={() => { stopPlayback(); setMedia(null); setReply(''); }} />
    </View>
  );

  // Anhang schreiben (Reiter "Verschluesseln").
  const composerMedia = (
    <>
      <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>
        {chatFiles ? t('siegelUi.fuerBildOderDateiMikrofon') : t('siegelUi.fuerBildOderDateiMikrofon2')}
      </Text>
      {!!sealedOut && (
        <View style={{ backgroundColor: C.surface, borderRadius: 14, padding: 14, gap: 10 }}>
          <Text style={{ color: C.muted, fontSize: 12 }}>{t('siegel.fileOnlyFor', { name: current?.name })}</Text>
          <Btn label={t('siegel.shareAgain')} outline color={AC} onPress={() => shareSealed(sealedOut.path)} />
        </View>
      )}
    </>
  );

  const openFileHint = (
    <>
      <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19, marginTop: 8 }}>{t('siegel.openFileHint')}</Text>
      <Btn label={t('siegel.openFile')} outline color={AC} onPress={pickSiegelFile} disabled={busy} />
    </>
  );

  let body = null;
  if (view === 'loading') {
    body = <ActivityIndicator color={AC} style={{ marginTop: 40 }} />;
  } else if (view === 'setup') {
    body = (
      <>
        {header(t('siegel.setup.title'))}
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: C.text, fontSize: 15, lineHeight: 22 }}>
            {t('siegel.setup.intro')}
          </Text>
          <Text style={{ color: C.sub, fontSize: 13, lineHeight: 20 }}>
            {t('siegel.setup.vault')}
          </Text>
          <Field value={pass1} onChangeText={setPass1} secureTextEntry placeholder={t('siegel.setup.pass1')} />
          <Field value={pass2} onChangeText={setPass2} secureTextEntry placeholder={t('siegel.setup.pass2')} />
          <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>{t('siegel.setup.warning')}</Text>
          {messages}
          <Btn label={t('siegel.setup.button')} color={AC} onPress={doSetup} disabled={busy} />
        </ScrollView>
      </>
    );
  } else if (view === 'locked') {
    body = (
      <>
        {header('Siegel')}
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: C.text, fontSize: 15 }}>{t('siegel.locked')}</Text>
          <Field value={pass1} onChangeText={setPass1} secureTextEntry placeholder={t('siegel.passPlaceholder')} onSubmitEditing={doUnlock} />
          {messages}
          <Btn label={t('siegel.unlock')} color={AC} onPress={doUnlock} disabled={busy || !pass1} />
          <View style={{ height: 24 }} />
          <Btn label={t('siegel.wipeButton')} outline color={C.danger} onPress={confirmWipe} disabled={busy} />
        </ScrollView>
      </>
    );
  } else if (view === 'list') {
    body = (
      <>
        {header('Siegel')}
        <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
          {!!chatId && !!onSendCipher && canSeal && (
            <View style={{ backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.accent, padding: 14, gap: 10 }}>
              <Text style={{ color: C.text, fontSize: 14, lineHeight: 20 }}>{t('siegelUi.chatWith', { name: chatName || t('siegelUi.diesemKontakt') })}</Text>
              <Btn label={t('siegel.pairViaChat')} color={AC} onPress={pairViaChat} disabled={busy} />
            </View>
          )}
          {!!chatId && !canSeal && (
            <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19 }}>{t('siegelUi.canInvite', { name: chatName || t('siegelUi.deinKontakt') })}</Text>
          )}
          <Btn label={t('siegel.decryptMessage')} color={AC} outline={!!chatId} onPress={() => { setInput(''); setPlain(''); setView('decryptAny'); }} />
          <Text style={{ color: C.muted, fontSize: 11, letterSpacing: 1.5, marginTop: 8 }}>{t('siegel.contactsSection')}</Text>
          {contacts.length === 0 && <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19 }}>{t('siegel.noContacts')}</Text>}
          {contacts.map((c) => (
            <TouchableOpacity key={c.id} onPress={() => chooseContact(c)} onLongPress={() => confirmDeleteContact(c)}
              style={{ backgroundColor: C.surface, borderRadius: 14, borderWidth: 0.5, borderColor: C.border, padding: 16 }}>
              <Text style={{ color: C.text, fontSize: 15, fontWeight: '500' }}>{c.name}</Text>
              <Text style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{t('siegel.safetyShort', { code: c.safety.slice(0, 11) })}</Text>
            </TouchableOpacity>
          ))}
          <Btn label={t('siegel.newContact')} outline color={AC} onPress={() => { setPairName(''); setView('newPair'); }} />
          {messages}
          <View style={{ height: 16 }} />
          <Btn label={t('siegel.lock')} outline color={C.sub} onPress={() => V.lock()} />
          <Btn label={t('siegel.wipeButton')} outline color={C.danger} onPress={confirmWipe} disabled={busy} />
        </ScrollView>
      </>
    );
  } else if (view === 'newPair') {
    body = (
      <>
        {header(t('siegel.newPair.title'), () => setView('list'))}
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: C.sub, fontSize: 13, lineHeight: 20 }}>
            {t('siegel.newPair.intro')}
          </Text>
          <Field value={pairName} onChangeText={setPairName} placeholder={t('siegel.newPair.namePlaceholder')} maxLength={40} />
          {messages}
          {canSeal
            ? <Btn label={t('siegel.newPair.show')} color={AC} onPress={startInvite} disabled={busy} />
            : proHint('Eine Einladung zeigen')}
          <Btn label={t('siegel.newPair.scan')} outline={canSeal} color={AC} onPress={() => openScanner('invite')} disabled={busy} />
        </ScrollView>
      </>
    );
  } else if (view === 'invite') {
    body = (
      <>
        {header(t('common.invite'), () => { V.cancelInvite(); setQr(''); setView('newPair'); })}
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, alignItems: 'stretch' }}>
          <Text style={{ color: C.text, fontSize: 15, textAlign: 'center' }}>{t('siegel.invite.step1')}</Text>
          {!!qr && bigQr(qr)}
          <Text style={{ color: C.text, fontSize: 15, textAlign: 'center' }}>{t('siegel.invite.step2')}</Text>
          {messages}
          <Btn label={t('siegel.invite.scanAck')} color={AC} onPress={() => openScanner('ack')} disabled={busy} />
        </ScrollView>
      </>
    );
  } else if (view === 'ack') {
    body = (
      <>
        {header(t('siegel.ack.title'), () => { setQr(''); setView('list'); })}
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
          <Text style={{ color: C.text, fontSize: 15, textAlign: 'center' }}>{t('siegel.ack.body')}</Text>
          {!!qr && bigQr(qr)}
          {!!paired && <Text style={{ color: C.sub, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>{t('siegel.ack.safety')}{'\n'}<Text style={{ color: C.text, fontSize: 16, letterSpacing: 1 }}>{paired.safety}</Text></Text>}
          {messages}
          <Btn label={t('common.done')} color={AC} onPress={() => { setQr(''); setView('list'); }} />
        </ScrollView>
      </>
    );
  } else if (view === 'invitedViaChat') {
    body = (
      <>
        {header(t('siegel.invited.title'), () => setView('list'))}
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
          <Text style={{ color: C.text, fontSize: 15, lineHeight: 22 }}>{chatName ? t('siegel.invited.body', { name: chatName }) : t('siegel.invited.bodyNoName')}</Text>
          <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>{t('siegel.invited.valid')}</Text>
          <Btn label={t('common.done')} color={AC} onPress={close} />
        </ScrollView>
      </>
    );
  } else if (view === 'paired') {
    body = (
      <>
        {header(t('siegel.paired.title'), () => setView('list'))}
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
          <Text style={{ color: C.ok, fontSize: 16, fontWeight: '500' }}>{t('siegel.paired.line', { name: paired?.name })}</Text>
          <Text style={{ color: C.sub, fontSize: 13, lineHeight: 20 }}>{chatId ? t('siegel.paired.compareChat') : t('siegel.paired.compare')}</Text>
          <Text style={{ color: C.text, fontSize: 18, letterSpacing: 1, textAlign: 'center' }}>{paired?.safety}</Text>
          {!!chatId && !!onSendCipher && !!paired && canSeal && (
            <Btn label={t('siegel.paired.writeNow')} color={AC} onPress={() => openContact(paired)} />
          )}
          <Btn label={t('common.done')} outline={!!chatId} color={AC} onPress={chatId ? close : () => setView('list')} />
        </ScrollView>
      </>
    );
  } else if (view === 'contact' && current) {
    body = (
      <>
        {header(current.name, () => { discardMedia(); setCipher(''); setPlain(''); setInput(''); setView('list'); })}
        <View style={{ flexDirection: 'row', margin: 16, backgroundColor: C.surface, borderRadius: 12, padding: 4 }}>
          {[['enc', t('common.encrypt')], ['dec', t('common.decrypt')]].map(([k, label]) => (
            <TouchableOpacity key={k} onPress={() => { discardMedia(); setTab(k); setInput(''); setCipher(''); setPlain(''); setError(''); setNotice(''); }}
              style={{ flex: 1, padding: 10, borderRadius: 10, alignItems: 'center', backgroundColor: tab === k ? C.border : 'transparent' }}>
              <Text style={{ color: tab === k ? C.text : C.muted, fontWeight: '500' }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }} keyboardShouldPersistTaps="handled">
          {tab === 'enc' && !canSeal ? proHint(t('common.encrypt')) : tab === 'enc' ? (
            <>
              {composer({ value: input, setValue: setInput, placeholder: t('siegel.composePlaceholder', { name: current.name }), to: current.id, onSendText: doSeal })}
              {messages}
              {!!cipher && (
                <View style={{ backgroundColor: C.surface, borderRadius: 14, padding: 14, gap: 10 }}>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{t('siegel.cipherFor', { name: current.name })}</Text>
                  <Text style={{ color: C.sub, fontSize: 12, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier' }} numberOfLines={4}>{cipher}</Text>
                  <Btn label={t('siegel.shareAgain')} outline color={AC} onPress={() => Share.share({ message: cipher }).catch(() => {})} />
                  <Btn label={t('siegel.copy')} outline color={C.sub} onPress={copyCipher} />
                </View>
              )}
              {composerMedia}
            </>
          ) : (
            <>
              <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19 }}>{t('siegel.pasteHint')}</Text>
              <Btn label={t('siegel.decryptClipboard')} color={AC} onPress={() => doOpen(true)} disabled={busy} />
              {openFileHint}
              {messages}
              {plainBox}
              {mediaBox}
              <TouchableOpacity onPress={() => Alert.alert(t('common.safetyCode'), current.safety)}>
                <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 8 }}>{t('common.showSafetyCode')}</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </>
    );
  } else if (view === 'decryptAny') {
    body = (
      <>
        {header(t('common.decrypt'), () => { stopPlayback(); setMedia(null); setPlain(''); setView('list'); })}
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19 }}>{t('siegel.decryptAnyHint')}</Text>
          <Btn label={t('siegel.decryptClipboard')} color={AC} onPress={() => doOpen(true)} disabled={busy} />
          {openFileHint}
          {messages}
          {plainBox}
          {mediaBox}
        </ScrollView>
      </>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => (scan ? setScan(null) : close())}>
      <View style={{ flex: 1, backgroundColor: C.bg, paddingBottom: insets.bottom }}
        onTouchStart={() => V.touch()}>
        {!scan && <View style={{ height: insets.top, backgroundColor: C.headerBg }} />}
        {scan ? <Scanner onScanned={onScanned} onClose={() => setScan(null)} /> : body}
      </View>
    </Modal>
  );
}
