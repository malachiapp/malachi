// GroupCallManager.js - Gruppen-Sprachanrufe (GROUP_CALL_DESIGN.md)
//
// Topologie: vollvermaschtes Netz ("full mesh"). Jedes Paar von Teilnehmern
// hat eine EIGENE RTCPeerConnection nur fuer Audio (DTLS-SRTP, Opus mono mit
// niedriger Bitrate), hoechstens 8 Teilnehmer (= Gruppengroesse). Es gibt
// keinen Server, kein SFU, kein TURN und keinen Relay-Server - wie im Rest der
// App nur P2P.
//
// Signalisierung (system/gcall_signal, nie im Chat sichtbar, nie gespeichert):
//   - Jede Nachricht reist ueber die bestehende, verschluesselte 1:1-
//     Verbindung zum jeweiligen Kontakt und ist zusaetzlich mit einem eigenen
//     Unterschluessel ('gcall-signal') verschluesselt - wie die 1:1-Anrufe
//     (CallManager.js, 'call-signal').
//   - Teilnehmer, die direkt miteinander gekoppelt sind, tauschen Angebot/
//     Antwort/ICE NUR direkt aus.
//   - Teilnehmer, die NICHT miteinander gekoppelt sind (beide aber mit dem
//     Host): der Host (wer den Anruf gestartet hat) leitet ihr Angebot/ihre
//     Antwort/ICE ueber seine eigenen verschluesselten Kanaele weiter. Nie ein
//     anderes Mitglied, nie ein Server. Der Host sieht dabei das SDP dieser
//     Paare und buergt fuer deren DTLS-Fingerabdruecke (siehe Design-Dokument,
//     Vertrauensmodell).
//
// Ablauf: Host (nur Vollversion) laedt alle direkt gekoppelten Mitglieder ein
// (invite) -> Mitglieder klingeln (ringing) -> Annehmen (join) -> Host
// verteilt die Teilnehmerliste (roster) -> jedes Paar baut seine Verbindung
// auf (der Teilnehmer mit der kleineren Mitglieds-ID bietet an). Auflegen
// (leave), Ablehnen (decline), Ende fuer alle (end, nur Host). Legt der Host
// auf, endet der Anruf fuer alle. Bleibt nur der Host uebrig, endet er auch.
//
// Regeln: nur Sprache; im Verbindungsweg "Maximal anonym (nur Tor)" keine
// Gruppenanrufe (ein Mitglied in Stufe 3 lehnt automatisch ab); kommt fuer ein
// Paar keine direkte WebRTC-Verbindung zustande, gilt es als "nicht
// erreichbar" (kein Ausweichen auf Sprache ueber Tor); nur ein Anruf
// gleichzeitig (1:1 oder Gruppe). Keine Inhalte, kein SDP, keine IDs in Logs.

import { RTCPeerConnection, mediaDevices } from 'react-native-webrtc';
import { NativeModules, NativeEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import RTCStore from './RTCStore';
import { pcConfigForCalls } from './WebRTCManager';
import { encryptMsg, decryptMsg, secureRandomToken } from './MessageCrypto';
import { MODE_TOR_ONLY, connectionModeForDecision, onConnectionModeChange } from './ConnectionMode';
import { getSelfMemberId, memberIdOfContact, GROUP_MAX_MEMBERS } from './GroupMessaging';
import { getLicenseState } from './LicenseManager';
import { claimAudio, releaseAudio } from './AppFocus';
import { rejectIncomingCallBusy } from './CallManager';
import { t as tr } from './i18n';   // t ist hier oft eine lokale Variable

export const GROUP_CALL_SUBTYPE = 'gcall_signal';
const PURPOSE = 'gcall-signal';
const PROTO_V = 1;
const AUDIO_ID = 'group-call';

export const GroupCallState = {
  IDLE: 'idle',
  OUTGOING: 'outgoing',       // Host: klingelt bei den Mitgliedern, noch niemand drin
  RINGING: 'ringing',         // Mitglied: eingehender Gruppenanruf
  CONNECTING: 'connecting',   // beigetreten, noch keine Sprachverbindung
  ACTIVE: 'active',           // mindestens ein Paar verbunden
  ENDED: 'ended',             // kurz nach dem Ende (danach IDLE)
};

// Hinweise als Funktionen: Text in der aktuellen Sprache (locales/*.js).
export const groupCallProNotice = () => tr('groupCall.notice.pro');
export const groupCallTorOnlyNotice = () => tr('groupCall.notice.torOnly');
export const groupCallBusyNotice = () => tr('groupCall.notice.busy');
const micDeniedNotice = () => tr('groupCall.notice.micDenied');

// Zeiten (Tests verkuerzen sie ueber configureGroupCall).
const DEFAULT_TIMEOUTS = {
  ringMs: 30000,            // Klingeln beim Mitglied (wie CallManager CALL_TIMEOUT_MS)
  hostRingSlackMs: 5000,    // Host: Reserve, bevor ein Mitglied als "nicht angenommen" gilt
  nobodyMs: 45000,          // Host: niemand angenommen -> Ende
  joinTimeoutMs: 20000,     // Mitglied: nach dem Annehmen keine Teilnehmerliste vom Host
  pairConnectMs: 20000,     // je Paar: keine Verbindung -> "nicht erreichbar"
  iceGraceMs: 6000,         // 'disconnected' ist oft voruebergehend (wie CallManager)
  endedLingerMs: 500,       // ENDED -> IDLE
  connectViaTorMs: 20000,   // Einladung/Beitritt: Verbindung zum Kontakt erst aufbauen
  inviteMaxAgeMs: 120000,   // aeltere Einladungen (z.B. spaet zugestellt) klingeln nicht
  inviteFutureMs: 120000,   // Uhrabweichung
  knownCallTtlMs: 4 * 60 * 60 * 1000,
  statsMs: 1000,            // Sprech-Anzeige
  terminalRetryMs: 400,
  reinviteGapMs: 10000,
};
let T = { ...DEFAULT_TIMEOUTS };
let deps = {
  isPro: () => getLicenseState().pro === true,
};
// Nur Tests (und spaeter evtl. Einstellungen): Zeiten/Abhaengigkeiten setzen.
export function configureGroupCall({ timeouts, isPro } = {}) {
  if (timeouts) T = { ...T, ...timeouts };
  if (typeof isPro === 'function') deps = { ...deps, isPro };
}

// ─── Grenzen und Formate ────────────────────────────────────────────────────
const CALL_ID_RE = /^gc_[0-9a-f]{32}$/;
const MID_RE = /^m_[0-9a-f]{32}$/;
const GROUP_ID_RE = /^g_[0-9a-f]{16,64}$/;
const ENC_MAX = 96 * 1024;
const PLAIN_MAX = 48 * 1024;
const SDP_MAX = 16 * 1024;
const CAND_MAX = 1024;
const SDP_MID_MAX = 64;
const MAX_PENDING_ICE = 64;
const MAX_ICE_PER_PEER = 128;
const MAX_RELAYS_PER_SENDER = 400;
const MAX_REINVITES = 3;
const SIGNAL_WINDOW_MS = 10000;
const SIGNALS_PER_WINDOW = 300;      // je Kontakt (Host leitet ICE mehrerer Paare weiter)
const INVITE_WINDOW_MS = 60000;
const INVITES_PER_WINDOW = 6;        // je Kontakt
const OPUS_MAX_BITRATE = 20000;      // bit/s, Sprache mono
const SPEAKING_LEVEL = 0.04;
const TYPES = new Set(['invite', 'ringing', 'decline', 'join', 'leave', 'mute', 'roster', 'end', 'offer', 'answer', 'ice']);
const PAIR_TYPES = new Set(['offer', 'answer', 'ice']);
const DECLINE_REASONS = new Set(['user', 'busy', 'tor_only', 'timeout', 'mic', 'error']);
const END_REASONS = new Set(['host_hangup', 'no_answer', 'alone', 'no_media', 'tor_only_switch', 'error']);
// Status eines Mitglieds (Host verteilt sie mit der Teilnehmerliste).
const MEMBER_STATUSES = new Set(['invited', 'ringing', 'joined', 'declined', 'missed', 'left', 'unreachable', 'busy', 'tor_only']);
const STATUS_FOR_DECLINE = { user: 'declined', busy: 'busy', tor_only: 'tor_only', timeout: 'missed', mic: 'declined', error: 'declined' };
const REINVITABLE = new Set(['declined', 'missed', 'left', 'unreachable', 'busy']);

const isMid = (v) => typeof v === 'string' && MID_RE.test(v);
// Native Module beim Laden festhalten (wie CallManager.js). Koennen fehlen
// (iOS, Tests) - deshalb ueberall mit ?. abgesichert.
const CallBridgeModule = NativeModules.CallBridgeModule || null;
const MalachiCallAudio = NativeModules.MalachiCallAudio || null;
const bridge = () => CallBridgeModule;
const callAudio = () => MalachiCallAudio;

function log(text) { console.log('[GCall] ' + text); }

// ─── Zustand ────────────────────────────────────────────────────────────────
let call = null;          // laufender Gruppenanruf (hoechstens einer)
let starting = false;     // startGroupCall/joinRunning laeuft (vor dem Anlegen)
let chain = Promise.resolve();
const listeners = new Set();
let noticeHandler = null;
// Laufende Anrufe, zu denen ich eingeladen war (Mitglied, nur im RAM): fuer
// den spaeteren Beitritt ("late join"). groupId -> { callId, hostMid, at }
const knownCalls = new Map();
const signalRate = new Map();   // contactId -> { start, n }
const inviteRate = new Map();   // contactId -> [Zeitpunkte]

export function subscribeGroupCall(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  try { fn(getGroupCallSnapshot()); } catch {}
  return () => { listeners.delete(fn); };
}
function emit() {
  const snap = getGroupCallSnapshot();
  for (const l of [...listeners]) { try { l(snap); } catch {} }
}
export function setGroupCallNoticeHandler(fn) {
  noticeHandler = typeof fn === 'function' ? fn : null;
}
function notice(text) {
  if (!text || !noticeHandler) return;
  try { noticeHandler(text); } catch {}
}

export function isGroupCallBusy() { return !!call || starting; }
export function canStartGroupCall() { try { return deps.isPro() === true; } catch { return false; } }

function speakerSupported() { return typeof callAudio()?.setSpeaker === 'function'; }

// Momentaufnahme fuer die Oberflaeche (keine Schluessel, kein SDP).
export function getGroupCallSnapshot() {
  const c = call;
  if (!c) return { state: GroupCallState.IDLE, participants: [], callKey: null, groupId: null };
  const participants = [];
  for (const m of c.members.values()) {
    const p = c.peers.get(m.mid);
    participants.push({
      mid: m.mid, name: m.name, contactId: m.contactId || null,
      isSelf: m.mid === c.selfMid, isHost: m.mid === c.hostMid,
      status: m.mid === c.selfMid ? (c.state === GroupCallState.RINGING ? 'ringing' : 'joined') : m.status,
      link: m.mid === c.selfMid ? null : (p ? p.link : null),
      muted: m.mid === c.selfMid ? c.muted : !!m.muted,
      speaking: m.mid === c.selfMid ? !!c.selfSpeaking : !!p?.speaking,
      canReinvite: c.role === 'host' && m.mid !== c.selfMid && !!m.contactId && REINVITABLE.has(m.status)
        && (m.reinvites || 0) < MAX_REINVITES,
    });
  }
  return {
    state: c.state, callKey: c.key, groupId: c.groupId, groupName: c.groupName, role: c.role,
    isHost: c.role === 'host', hostName: c.members.get(c.hostMid)?.name || 'Unbekannt',
    muted: c.muted, speaker: c.speaker, speakerSupported: speakerSupported(),
    startedAt: c.startedAt, endReason: c.endReason || null, participants,
  };
}

// Laufender Anruf einer Gruppe, an dem ich (noch) nicht teilnehme.
export function runningGroupCallFor(groupId) {
  const k = knownCalls.get(groupId);
  if (!k) return null;
  if (Date.now() - k.at > T.knownCallTtlMs) { knownCalls.delete(groupId); return null; }
  if (call && call.callId === k.callId) return null;
  return { groupId, hostMid: k.hostMid };
}

// ─── Hilfen ─────────────────────────────────────────────────────────────────
async function readJsonList(key) {
  const raw = await EncryptedStorage.getItem(key).catch(() => null);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []; } catch { return []; }
}
async function loadContext(groupId) {
  const [groups, contacts, selfMid] = await Promise.all([readJsonList('groups'), readJsonList('contacts'), getSelfMemberId()]);
  const g = groups.find((x) => x.groupId === groupId) || null;
  return { g, contacts, selfMid };
}
function pairedContactFor(contacts, mid) {
  return contacts.find((c) => memberIdOfContact(c) === mid && !c.pendingDelete && !c.wiped) || null;
}
function isMemberOf(g, mid) {
  return !!g && g.v === 1 && !g.removed && Array.isArray(g.members) && g.members.some((m) => m && m.mid === mid);
}
function memberDisplayName(g, contacts, mid) {
  const c = pairedContactFor(contacts, mid);
  if (c?.name) return String(c.name).slice(0, 64);
  const m = (g?.members || []).find((x) => x && x.mid === mid);
  return (typeof m?.name === 'string' && m.name) ? m.name.slice(0, 64) : 'Unbekannt';
}
function stopStream(stream) {
  try { stream?.getTracks?.().forEach((t) => { try { t.stop(); } catch {} }); } catch {}
}
function later(c, ms, fn) {
  const t = setTimeout(() => {
    c.timers.delete(t);
    if (call !== c || c.ended) return;
    try { fn(); } catch {}
  }, ms);
  c.timers.add(t);
  return t;
}
function clearLater(c, t) {
  if (!t) return;
  clearTimeout(t);
  c.timers.delete(t);
}
function isLive(c) { return call === c && !c.ended; }
function setState(c, state) {
  if (c.state === state) return;
  c.state = state;
  log('Zustand: ' + state);
  emit();
}

// Opus: mono, niedrige Bitrate, FEC (Paketverlust). Die fmtp-Parameter einer
// Beschreibung sagen der GEGENSEITE, wie sie senden soll - deshalb an der
// eigenen (lokalen) Beschreibung, beide Seiten tun es.
export function tuneOpusSdp(sdp, maxBitrate = OPUS_MAX_BITRATE) {
  if (typeof sdp !== 'string' || !sdp) return sdp;
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const ri = lines.findIndex((l) => /^a=rtpmap:\d+ opus\/48000/i.test(l));
  if (ri < 0) return sdp;
  const pt = /^a=rtpmap:(\d+)/.exec(lines[ri])[1];
  const want = { stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: String(maxBitrate), useinbandfec: '1' };
  const wanted = Object.entries(want).map(([k, v]) => k + '=' + v);
  const prefix = 'a=fmtp:' + pt + ' ';
  const fi = lines.findIndex((l) => l.startsWith(prefix));
  if (fi >= 0) {
    const kept = lines[fi].slice(prefix.length).split(';').map((s) => s.trim()).filter(Boolean)
      .filter((p) => !Object.prototype.hasOwnProperty.call(want, p.split('=')[0].toLowerCase()));
    lines[fi] = prefix + [...kept, ...wanted].join(';');
  } else {
    lines.splice(ri + 1, 0, prefix + ['minptime=10', ...wanted].join(';'));
  }
  return lines.join(nl);
}

function candidateToJson(c) {
  if (!c || typeof c.candidate !== 'string' || !c.candidate) return null;
  return {
    candidate: c.candidate.slice(0, CAND_MAX),
    sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, SDP_MID_MAX) : null,
    sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
  };
}

// ─── Eingangspruefung ───────────────────────────────────────────────────────
// Liefert eine bereinigte Kopie (nur bekannte Felder) oder null.
export function sanitizeGroupCallMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.v !== PROTO_V || !TYPES.has(m.t)) return null;
  if (typeof m.callId !== 'string' || !CALL_ID_RE.test(m.callId)) return null;
  if (typeof m.groupId !== 'string' || !GROUP_ID_RE.test(m.groupId)) return null;
  const out = { t: m.t, callId: m.callId, groupId: m.groupId };
  switch (m.t) {
    case 'invite': {
      if (!isMid(m.host) || !Number.isFinite(m.ts)) return null;
      if (!Array.isArray(m.participants) || m.participants.length < 2 || m.participants.length > GROUP_MAX_MEMBERS) return null;
      if (!m.participants.every(isMid) || new Set(m.participants).size !== m.participants.length) return null;
      if (!m.participants.includes(m.host)) return null;
      out.host = m.host; out.participants = [...m.participants]; out.ts = m.ts;
      return out;
    }
    case 'decline':
      out.reason = DECLINE_REASONS.has(m.reason) ? m.reason : 'user';
      return out;
    case 'mute':
      if (typeof m.mu !== 'boolean') return null;
      out.mu = m.mu;
      return out;
    case 'roster': {
      if (!Array.isArray(m.members) || m.members.length < 1 || m.members.length > GROUP_MAX_MEMBERS) return null;
      const seen = new Set();
      out.members = [];
      for (const e of m.members) {
        if (!e || typeof e !== 'object' || !isMid(e.mid) || seen.has(e.mid) || !MEMBER_STATUSES.has(e.st)) return null;
        seen.add(e.mid);
        out.members.push({ mid: e.mid, st: e.st, mu: e.mu === true });
      }
      return out;
    }
    case 'end':
      out.reason = END_REASONS.has(m.reason) ? m.reason : 'host_hangup';
      return out;
    case 'offer':
    case 'answer':
      if (!isMid(m.to) || (m.from != null && !isMid(m.from))) return null;
      if (typeof m.sdp !== 'string' || m.sdp.length < 3 || m.sdp.length > SDP_MAX || !m.sdp.startsWith('v=0')) return null;
      out.to = m.to; out.from = m.from || null; out.sdp = m.sdp;
      return out;
    case 'ice': {
      if (!isMid(m.to) || (m.from != null && !isMid(m.from))) return null;
      const c = m.c;
      if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || !c.candidate || c.candidate.length > CAND_MAX) return null;
      if (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > SDP_MID_MAX)) return null;
      if (c.sdpMLineIndex != null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 63)) return null;
      out.to = m.to; out.from = m.from || null;
      out.c = { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
      return out;
    }
    default:
      return out;   // ringing, join, leave
  }
}

function allowSignal(contactId) {
  const now = Date.now();
  let r = signalRate.get(contactId);
  if (!r || now - r.start > SIGNAL_WINDOW_MS) { r = { start: now, n: 0 }; signalRate.set(contactId, r); }
  r.n++;
  return r.n <= SIGNALS_PER_WINDOW;
}
function allowInvite(contactId) {
  const now = Date.now();
  const list = (inviteRate.get(contactId) || []).filter((t) => now - t < INVITE_WINDOW_MS);
  if (list.length >= INVITES_PER_WINDOW) { inviteRate.set(contactId, list); return false; }
  list.push(now);
  inviteRate.set(contactId, list);
  return true;
}

// ─── Senden ─────────────────────────────────────────────────────────────────
async function secretFor(contactId) {
  const s = RTCStore.getSharedSecret(contactId);
  if (s) return s;
  return (await EncryptedStorage.getItem('shared_secret_' + contactId).catch(() => null)) || null;
}

async function ensureConnection(contactId, timeoutMs) {
  if (RTCStore.isConnected(contactId)) return true;
  const ensure = RTCStore.connectionEnsurer;
  if (typeof ensure !== 'function') return false;
  try {
    const rtc = await ensure(contactId, { timeoutMs });
    return !!rtc && RTCStore.isConnected(contactId);
  } catch {
    return false;
  }
}

// true = an eine Verbindung uebergeben. Nie unverschluesselt (faellt sonst aus).
// Je Kontakt strikt in Aufrufreihenfolge (Verschluesselung ist asynchron -
// Liste, Angebot und ICE sollen nicht ueberholen).
const sendChains = new Map();   // contactId -> Promise
function sendTo(contactId, inner, ids, opts = {}) {
  if (!contactId) return Promise.resolve(false);
  const prev = sendChains.get(contactId) || Promise.resolve();
  const run = prev.then(() => sendNow(contactId, inner, ids, opts));
  const settled = run.catch(() => false);
  sendChains.set(contactId, settled);
  settled.then(() => { if (sendChains.get(contactId) === settled) sendChains.delete(contactId); });
  return run;
}

async function sendNow(contactId, inner, ids, { connect = false } = {}) {
  const secret = await secretFor(contactId);
  if (!secret) return false;
  const body = { v: PROTO_V, callId: ids.callId, groupId: ids.groupId, ...inner };
  const enc = await encryptMsg(JSON.stringify(body), secret, PURPOSE).catch(() => null);
  if (!enc) return false;
  const raw = JSON.stringify({ type: 'system', subtype: GROUP_CALL_SUBTYPE, enc });
  const trySend = () => {
    if (!RTCStore.isConnected(contactId)) return false;
    const r = RTCStore.sendMessage(contactId, raw);
    return r === 'sent' || r === 'queued';
  };
  if (trySend()) return true;
  if (!connect) return false;
  if (!(await ensureConnection(contactId, T.connectViaTorMs))) return false;
  return trySend();
}

// Ende/Ablehnen/Auflegen haben keine natuerliche Wiederholung - kurz erneut
// versuchen (wie CallManager._sendTerminalSignal).
async function sendTerminal(contactId, inner, ids) {
  for (let i = 0; i < 3; i++) {
    if (await sendTo(contactId, inner, ids).catch(() => false)) return true;
    if (i < 2) await new Promise((r) => { const t = setTimeout(r, T.terminalRetryMs); t?.unref?.(); });
  }
  return false;
}

function idsOf(c) { return { callId: c.callId, groupId: c.groupId }; }
function hostContactId(c) { return c.members.get(c.hostMid)?.contactId || null; }

// Paar-Signal an einen Teilnehmer: direkt gekoppelt -> nur direkt; sonst
// (nur als Mitglied) ueber den Host.
function sendPair(c, toMid, t, extra) {
  const mem = c.members.get(toMid);
  if (!mem) return Promise.resolve(false);
  const inner = { t, to: toMid, from: c.selfMid, ...extra };
  if (mem.contactId) return sendTo(mem.contactId, inner, idsOf(c), { connect: t !== 'ice' });
  if (c.role === 'member' && toMid !== c.hostMid) {
    const host = hostContactId(c);
    if (host) return sendTo(host, inner, idsOf(c));
  }
  return Promise.resolve(false);
}

// ─── Mikrofon ───────────────────────────────────────────────────────────────
async function ensureMicPermission() {
  if (Platform.OS !== 'android' || !PermissionsAndroid?.request) return true;
  try {
    const mic = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
    if (await PermissionsAndroid.check(mic)) return true;
    const r = await PermissionsAndroid.request(mic, {
      title: tr('common.microphone'), message: tr('groupCall.malachiBrauchtDasMikrofonFuer'), buttonPositive: 'OK',
    });
    return r === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return true;   // im Zweifel versuchen; getUserMedia meldet echte Fehler
  }
}
async function openMicrophone() {
  return mediaDevices.getUserMedia({ audio: true, video: false });
}

// ─── Anruf-Objekt ───────────────────────────────────────────────────────────
function newCall({ callId, groupId, groupName, role, hostMid, selfMid, state }) {
  return {
    callId, groupId, groupName: groupName || tr('common.group'), role, hostMid, selfMid, state,
    key: 'gcall_' + callId,           // Schluessel fuer die native Anruf-Anzeige
    members: new Map(),               // mid -> { mid, name, contactId, status, muted, ... }
    participants: new Set(),          // vom Host angekuendigte Teilnehmer (Mitglieds-IDs)
    peers: new Map(),                 // mid -> Paar-Verbindung
    midByContact: new Map(),          // contactId -> mid (direkt gekoppelte Teilnehmer)
    timers: new Set(),
    localStream: null, muted: false, speaker: false, selfSpeaking: false,
    startedAt: null, everJoined: false, gotRoster: false, ended: false, endReason: null,
    modeUnsub: null, statsTimer: null, relays: new Map(),
  };
}

function watchMode(c) {
  c.modeUnsub = onConnectionModeChange((mode) => {
    if (mode !== MODE_TOR_ONLY || !isLive(c)) return;
    log('Verbindungsweg "nur Tor" - Gruppenanruf endet');
    hangup(c, 'tor_only_switch');
  });
}

function label(c) { return 'Gruppenanruf · ' + c.groupName; }

// ─── Starten (Host) ─────────────────────────────────────────────────────────
// Ergebnis: { ok: true } oder { error: 'pro'|'busy'|'tor_only'|'not_member'|
// 'no_reachable'|'mic'|'invalid'|'error' }.
export async function startGroupCall(groupId) {
  if (typeof groupId !== 'string' || !GROUP_ID_RE.test(groupId)) return { error: 'invalid' };
  // Regel des Inhabers: nur die Vollversion STARTET Gruppenanrufe (hier im
  // Manager geprueft, nicht nur in der Oberflaeche).
  if (!canStartGroupCall()) return { error: 'pro' };
  if (isGroupCallBusy() || RTCStore.activeCallContactId) return { error: 'busy' };
  starting = true;
  let stream = null;
  try {
    if ((await connectionModeForDecision()) === MODE_TOR_ONLY) return { error: 'tor_only' };
    const { g, contacts, selfMid } = await loadContext(groupId);
    if (!isMemberOf(g, selfMid)) return { error: 'not_member' };
    const others = g.members.filter((m) => m && isMid(m.mid) && m.mid !== selfMid).slice(0, GROUP_MAX_MEMBERS - 1);
    const reachable = others.filter((m) => pairedContactFor(contacts, m.mid));
    if (!reachable.length) return { error: 'no_reachable' };
    if (!(await ensureMicPermission())) return { error: 'mic' };
    try { stream = await openMicrophone(); } catch { return { error: 'mic' }; }
    if (call || RTCStore.activeCallContactId) { stopStream(stream); return { error: 'busy' }; }
    const callId = 'gc_' + await secureRandomToken(16);
    const c = newCall({ callId, groupId, groupName: g.name, role: 'host', hostMid: selfMid, selfMid, state: GroupCallState.OUTGOING });
    c.localStream = stream;
    stream = null;
    c.members.set(selfMid, { mid: selfMid, name: 'Du', contactId: null, status: 'joined', muted: false });
    c.participants.add(selfMid);
    for (const m of others) {
      const ct = pairedContactFor(contacts, m.mid);
      c.members.set(m.mid, {
        mid: m.mid, name: memberDisplayName(g, contacts, m.mid), contactId: ct?.id || null,
        status: ct ? 'invited' : 'unpaired', muted: false, reinvites: 0, lastInviteAt: 0, ringTimer: null,
      });
      if (ct) { c.participants.add(m.mid); c.midByContact.set(ct.id, m.mid); }
    }
    call = c;
    claimAudio(AUDIO_ID, () => {}).catch(() => {});
    watchMode(c);
    try { bridge()?.reportOutgoingCall?.(c.key, label(c)); } catch {}
    log('Gruppenanruf gestartet');
    emit();
    later(c, T.nobodyMs, () => { if (!c.everJoined) hangup(c, 'no_answer'); });
    for (const m of c.members.values()) {
      if (m.status === 'invited') inviteMember(c, m);
    }
    return { ok: true };
  } catch {
    stopStream(stream);
    return { error: 'error' };
  } finally {
    starting = false;
  }
}

function inviteMember(c, m) {
  m.status = 'invited';
  m.lastInviteAt = Date.now();
  clearLater(c, m.ringTimer);
  m.ringTimer = later(c, T.ringMs + T.hostRingSlackMs, () => {
    if (m.status === 'invited' || m.status === 'ringing') {
      m.status = 'missed';
      rosterChanged(c);
      checkHostDone(c);
    }
  });
  const payload = { t: 'invite', host: c.selfMid, participants: [...c.participants], ts: Date.now() };
  sendTo(m.contactId, payload, idsOf(c), { connect: true }).catch(() => false).then((ok) => {
    if (!isLive(c) || ok || m.status !== 'invited') return;
    m.status = 'unreachable';
    clearLater(c, m.ringTimer);
    rosterChanged(c);
    checkHostDone(c);
  });
}

// Host: Mitglied erneut anrufen (abgelehnt, verpasst, aufgelegt, ...).
export function ringAgain(mid) {
  const c = call;
  if (!c || c.ended || c.role !== 'host') return false;
  const m = c.members.get(mid);
  if (!m || !m.contactId || !REINVITABLE.has(m.status) || (m.reinvites || 0) >= MAX_REINVITES) return false;
  if (Date.now() - (m.lastInviteAt || 0) < T.reinviteGapMs) return false;
  m.reinvites = (m.reinvites || 0) + 1;
  inviteMember(c, m);
  rosterChanged(c);
  return true;
}

// Host: aktuelle Teilnehmerliste an alle Beigetretenen.
function rosterChanged(c) {
  if (!isLive(c)) return;
  if (c.role === 'host') {
    const members = [];
    for (const m of c.members.values()) {
      if (m.status === 'unpaired') continue;
      members.push({ mid: m.mid, st: m.mid === c.selfMid ? 'joined' : m.status, mu: m.mid === c.selfMid ? c.muted : !!m.muted });
    }
    for (const m of c.members.values()) {
      if (m.mid !== c.selfMid && m.status === 'joined' && m.contactId) {
        sendTo(m.contactId, { t: 'roster', members }, idsOf(c)).catch(() => {});
      }
    }
  }
  emit();
}

// Host: Anruf vorbei? Niemand mehr da (nachdem jemand drin war) bzw. niemand
// hat angenommen und niemand klingelt mehr.
function checkHostDone(c) {
  if (!isLive(c) || c.role !== 'host') return;
  const others = [...c.members.values()].filter((m) => m.mid !== c.selfMid);
  const joined = others.filter((m) => m.status === 'joined').length;
  const pending = others.filter((m) => m.status === 'invited' || m.status === 'ringing').length;
  if (c.everJoined && joined === 0) { hangup(c, 'alone'); return; }
  if (!c.everJoined && pending === 0) hangup(c, 'no_answer');
}

// ─── Eingang (RTCStore.groupCallSignalHandler) ──────────────────────────────
export function handleGroupCallSignal(contactId, msg) {
  if (!contactId || !msg || typeof msg.enc !== 'string' || msg.enc.length > ENC_MAX) return Promise.resolve();
  if (!allowSignal(contactId)) return Promise.resolve();
  const run = chain.then(() => processSignal(contactId, msg.enc));
  chain = run.catch(() => {});
  return run.catch(() => {});
}

function decryptFrom(contactId, enc, stored) {
  const candidates = [...RTCStore.getSecretCandidates(contactId)];
  if (stored && !candidates.includes(stored)) candidates.push(stored);
  for (const s of candidates) {
    const plain = decryptMsg(enc, s, PURPOSE);
    if (plain) return plain;
  }
  return null;
}

async function midOfContact(contactId) {
  const contacts = await readJsonList('contacts');
  const ct = contacts.find((x) => x.id === contactId && !x.pendingDelete && !x.wiped);
  return ct ? memberIdOfContact(ct) : null;
}

async function processSignal(contactId, enc) {
  let stored = null;
  if (!RTCStore.getSharedSecret(contactId)) stored = await EncryptedStorage.getItem('shared_secret_' + contactId).catch(() => null);
  const plain = decryptFrom(contactId, enc, stored);
  if (!plain || plain.length > PLAIN_MAX) return;
  let parsed;
  try { parsed = JSON.parse(plain); } catch { return; }
  const m = sanitizeGroupCallMessage(parsed);
  if (!m) { log('Ungueltiges Signal verworfen'); return; }
  if (m.t === 'invite') { await handleInvite(contactId, m); return; }
  const c = call;
  const known = !!c && !c.ended && c.callId === m.callId && c.groupId === m.groupId;
  if (m.t === 'end' && !known) { await forgetKnownCall(contactId, m); return; }
  if (!known) {
    // Beitritt zu einem Anruf, den es hier nicht (mehr) gibt: kurz "Ende"
    // antworten, damit das Mitglied nicht bis zur Zeitueberschreitung wartet
    // (zaehlt dort nur, wenn ich dessen Host bin).
    if (m.t === 'join') sendTo(contactId, { t: 'end', reason: 'host_hangup' }, m).catch(() => {});
    return;   // unbekannter Anruf
  }
  // Absender: nur direkt gekoppelte Teilnehmer dieses Anrufs (Kanal = Identitaet).
  const senderMid = c.midByContact.get(contactId);
  if (!senderMid) { log('Signal von Nicht-Teilnehmer verworfen'); return; }
  if (PAIR_TYPES.has(m.t)) { await handlePair(c, senderMid, m); return; }
  if (c.role === 'host') {
    switch (m.t) {
      case 'ringing': return onMemberRinging(c, senderMid);
      case 'decline': return onMemberDecline(c, senderMid, m.reason);
      case 'join': return onMemberJoin(c, senderMid);
      case 'leave': return onMemberLeave(c, senderMid);
      case 'mute': return onMemberMute(c, senderMid, m.mu);
      default: return;
    }
  }
  // Mitglied: Teilnehmerliste und Ende nur vom Host.
  if (senderMid !== c.hostMid) return;
  if (m.t === 'roster') await onRoster(c, m.members);
  else if (m.t === 'end') onHostEnded(c, m.reason);
}

// ─── Einladung (Mitglied) ───────────────────────────────────────────────────
async function handleInvite(contactId, m) {
  if (!allowInvite(contactId)) { log('Zu viele Einladungen - verworfen'); return; }
  const senderMid = await midOfContact(contactId);
  // Nur der Host selbst laedt ein (keine Einladung "im Namen" eines anderen).
  if (!senderMid || senderMid !== m.host) return;
  const now = Date.now();
  if (m.ts < now - T.inviteMaxAgeMs || m.ts > now + T.inviteFutureMs) { log('Veraltete Einladung verworfen'); return; }
  const { g, contacts, selfMid } = await loadContext(m.groupId);
  // Absender und ich muessen Mitglieder DIESER Gruppe sein.
  if (!isMemberOf(g, senderMid) || !isMemberOf(g, selfMid)) { log('Einladung ohne gemeinsame Gruppe verworfen'); return; }
  if (!m.participants.includes(selfMid)) return;
  if (call && call.callId === m.callId) return;   // doppelt bzw. bin schon drin
  const k = { callId: m.callId, hostMid: senderMid, at: now };
  const declineWith = (reason) => sendTerminal(contactId, { t: 'decline', reason }, m);
  if (isGroupCallBusy() || RTCStore.activeCallContactId) {
    // Fuer spaeter merken - ausser es laeuft gerade ein Anruf DIESER Gruppe.
    if (!(call && call.groupId === m.groupId)) { knownCalls.set(m.groupId, k); emit(); }
    log('Gruppenanruf abgelehnt: besetzt');
    await declineWith('busy');
    return;
  }
  if ((await connectionModeForDecision()) === MODE_TOR_ONLY) {
    log('Gruppenanruf abgelehnt: Verbindungsweg nur Tor');
    await declineWith('tor_only');
    notice(tr('groupCall.gruppenanrufVonInAutomatischAbgelehnt', { value: memberDisplayName(g, contacts, senderMid), name: g.name, value2: groupCallTorOnlyNotice() }));
    return;
  }
  if (isGroupCallBusy() || RTCStore.activeCallContactId) { await declineWith('busy'); return; }
  knownCalls.set(m.groupId, k);
  const c = buildMemberCall({ callId: m.callId, groupId: m.groupId, hostMid: senderMid, viaContactId: contactId, participants: m.participants, g, contacts, selfMid, state: GroupCallState.RINGING });
  call = c;
  watchMode(c);
  c.ringTimer = later(c, T.ringMs, () => {
    if (c.state === GroupCallState.RINGING) declineInternal(c, 'timeout', false);
  });
  try { bridge()?.reportIncomingCall?.(c.key, label(c)); } catch {}
  log('Eingehender Gruppenanruf');
  emit();
  sendTo(contactId, { t: 'ringing' }, idsOf(c)).catch(() => {});
}

function buildMemberCall({ callId, groupId, hostMid, viaContactId = null, participants, g, contacts, selfMid, state }) {
  const c = newCall({ callId, groupId, groupName: g.name, role: 'member', hostMid, selfMid, state });
  const groupMids = new Set(g.members.map((x) => x && x.mid));
  for (const mid of participants) {
    // Nur Teilnehmer, die auch in MEINEM Stand der Gruppe stehen.
    if (!groupMids.has(mid)) continue;
    c.participants.add(mid);
    if (mid === selfMid) {
      c.members.set(mid, { mid, name: 'Du', contactId: null, status: 'joined', muted: false });
      continue;
    }
    // Host: genau der Kontakt, ueber dessen Kanal die Einladung kam.
    const ct = mid === hostMid && viaContactId ? { id: viaContactId } : pairedContactFor(contacts, mid);
    c.members.set(mid, {
      mid, name: memberDisplayName(g, contacts, mid), contactId: ct?.id || null,
      status: mid === hostMid ? 'joined' : 'invited', muted: false,
    });
    if (ct) c.midByContact.set(ct.id, mid);
  }
  return c;
}

async function forgetKnownCall(contactId, m) {
  const k = knownCalls.get(m.groupId);
  if (!k || k.callId !== m.callId) return;
  if ((await midOfContact(contactId)) !== k.hostMid) return;
  knownCalls.delete(m.groupId);
  emit();
}

// ─── Annehmen / Ablehnen / Beitreten (Mitglied) ─────────────────────────────
export async function acceptGroupCall(fromNative = false) {
  const c = call;
  if (!c || c.ended || c.role !== 'member' || c.state !== GroupCallState.RINGING) return false;
  clearLater(c, c.ringTimer);
  setState(c, GroupCallState.CONNECTING);
  return startJoin(c, { fromNative, reportActive: true });
}

// Spaeter beitreten (Anruf laeuft, ich hatte abgelehnt/verpasst/aufgelegt).
export async function joinRunningGroupCall(groupId) {
  const k = runningGroupCallFor(groupId) && knownCalls.get(groupId);
  if (!k) return { error: 'gone' };
  if (isGroupCallBusy() || RTCStore.activeCallContactId) return { error: 'busy' };
  starting = true;
  try {
    if ((await connectionModeForDecision()) === MODE_TOR_ONLY) return { error: 'tor_only' };
    const { g, contacts, selfMid } = await loadContext(groupId);
    if (!isMemberOf(g, selfMid) || !isMemberOf(g, k.hostMid)) { knownCalls.delete(groupId); return { error: 'gone' }; }
    const participants = g.members.map((x) => x && x.mid).filter(isMid);
    if (call || RTCStore.activeCallContactId) return { error: 'busy' };
    const c = buildMemberCall({ callId: k.callId, groupId, hostMid: k.hostMid, participants, g, contacts, selfMid, state: GroupCallState.CONNECTING });
    if (!c.members.get(k.hostMid)?.contactId) { knownCalls.delete(groupId); return { error: 'gone' }; }
    call = c;
    watchMode(c);
    try { bridge()?.reportOutgoingCall?.(c.key, label(c)); } catch {}
    emit();
  } finally {
    starting = false;
  }
  const ok = await startJoin(call, { fromNative: false, reportActive: false });
  return ok ? { ok: true } : { error: 'failed' };
}

async function startJoin(c, { fromNative, reportActive }) {
  if ((await connectionModeForDecision()) === MODE_TOR_ONLY) {
    if (!isLive(c)) return false;
    notice(groupCallTorOnlyNotice());
    declineInternal(c, 'tor_only', fromNative);
    return false;
  }
  if (!isLive(c)) return false;
  if (!(await ensureMicPermission())) {
    if (!isLive(c)) return false;
    notice(micDeniedNotice());
    declineInternal(c, 'mic', fromNative);
    return false;
  }
  let stream;
  try { stream = await openMicrophone(); } catch {
    if (!isLive(c)) return false;
    notice(tr('groupCall.gruppenanrufDasMikrofonIstNicht'));
    declineInternal(c, 'error', fromNative);
    return false;
  }
  if (!isLive(c)) { stopStream(stream); return false; }
  c.localStream = stream;
  applyMute(c);
  claimAudio(AUDIO_ID, () => {}).catch(() => {});
  const ok = await sendTo(hostContactId(c), { t: 'join' }, idsOf(c), { connect: true }).catch(() => false);
  if (!isLive(c)) return false;
  if (!ok) { hangup(c, 'unreachable', { fromNative }); return false; }
  if (reportActive && !fromNative) { try { bridge()?.reportCallActive?.(c.key); } catch {} }
  later(c, T.joinTimeoutMs, () => { if (!c.gotRoster) hangup(c, 'connect_timeout'); });
  log('Beitritt gesendet');
  return true;
}

export function declineGroupCall(fromNative = false) {
  const c = call;
  if (!c || c.ended || c.state !== GroupCallState.RINGING) return;
  declineInternal(c, 'user', fromNative);
}

function declineInternal(c, reason, fromNative) {
  if (c.ended) return;
  const host = hostContactId(c);
  if (host) sendTerminal(host, { t: 'decline', reason }, idsOf(c)).catch(() => {});
  teardown(c, reason === 'timeout' ? 'missed' : 'declined', { fromNative });
}

// ─── Host: Antworten der Mitglieder ─────────────────────────────────────────
function onMemberRinging(c, mid) {
  const m = c.members.get(mid);
  if (!m || m.status !== 'invited') return;
  m.status = 'ringing';
  rosterChanged(c);
}

function onMemberDecline(c, mid, reason) {
  const m = c.members.get(mid);
  if (!m || (m.status !== 'invited' && m.status !== 'ringing')) return;
  clearLater(c, m.ringTimer);
  m.status = STATUS_FOR_DECLINE[reason] || 'declined';
  if (reason === 'tor_only') {
    notice(tr('groupCall.nutztDenVerbindungswegMaximalAnonym', { name: m.name }));
  }
  rosterChanged(c);
  checkHostDone(c);
}

async function onMemberJoin(c, mid) {
  const m = c.members.get(mid);
  if (!m || !m.contactId || !c.participants.has(mid)) return;
  if (m.status === 'joined') { rosterChanged(c); return; }   // doppelt: Liste erneut schicken
  const joined = [...c.members.values()].filter((x) => x.status === 'joined').length;
  if (joined >= GROUP_MAX_MEMBERS) return;
  clearLater(c, m.ringTimer);
  m.status = 'joined';
  m.muted = false;
  c.everJoined = true;
  if (c.state === GroupCallState.OUTGOING) setState(c, GroupCallState.CONNECTING);
  log('Mitglied beigetreten');
  rosterChanged(c);
  await ensurePairSetup(c, mid);
}

function onMemberLeave(c, mid) {
  const m = c.members.get(mid);
  if (!m) return;
  const wasJoined = m.status === 'joined';
  if (wasJoined) m.status = 'left';
  else if (m.status === 'invited' || m.status === 'ringing') m.status = 'declined';
  else return;
  clearLater(c, m.ringTimer);
  closePeer(c, mid);
  log('Mitglied hat aufgelegt');
  rosterChanged(c);
  checkHostDone(c);
}

function onMemberMute(c, mid, mu) {
  const m = c.members.get(mid);
  if (!m || m.status !== 'joined' || m.muted === mu) return;
  m.muted = mu;
  rosterChanged(c);
}

// ─── Mitglied: Teilnehmerliste / Ende vom Host ──────────────────────────────
async function onRoster(c, entries) {
  if (c.role !== 'member') return;
  if (c.state !== GroupCallState.CONNECTING && c.state !== GroupCallState.ACTIVE) return;
  c.gotRoster = true;
  const listed = new Set(entries.map((e) => e.mid));
  for (const e of entries) {
    if (e.mid === c.selfMid) continue;
    const m = c.members.get(e.mid);
    if (!m) continue;   // nicht in der Einladung / nicht in meiner Gruppe
    m.status = e.mid === c.hostMid ? 'joined' : e.st;
    m.muted = e.mu;
  }
  // Wer nicht in der Liste des Hosts steht, gehoert nicht zu diesem Anruf
  // (z.B. spaeter Beitritt: mein Stand kannte alle Gruppenmitglieder).
  for (const m of [...c.members.values()]) {
    if (m.mid === c.selfMid || m.mid === c.hostMid || listed.has(m.mid)) continue;
    closePeer(c, m.mid);
    c.members.delete(m.mid);
    c.participants.delete(m.mid);
    if (m.contactId) c.midByContact.delete(m.contactId);
  }
  for (const m of c.members.values()) {
    if (m.mid === c.selfMid) continue;
    if (m.status === 'joined') await ensurePairSetup(c, m.mid);
    else closePeer(c, m.mid);
    if (!isLive(c)) return;
  }
  await replayEarlySignals(c);
  if (!isLive(c)) return;
  emit();
  checkAllFailed(c);
}

function onHostEnded(c, reason) {
  knownCalls.delete(c.groupId);
  const wasIn = c.state === GroupCallState.CONNECTING || c.state === GroupCallState.ACTIVE;
  log('Host hat den Gruppenanruf beendet');
  teardown(c, wasIn ? (reason === 'no_media' ? 'host_no_media' : 'host_ended') : 'missed');
}

// ─── Paar-Verbindungen ──────────────────────────────────────────────────────
function newPeer(mid) {
  return { mid, pc: null, link: 'connecting', offered: false, answered: false, pendingIce: [], iceCount: 0,
    remoteStream: null, speaking: false, timer: null, graceTimer: null };
}
function isCurrentPeer(c, p) { return isLive(c) && c.peers.get(p.mid) === p; }

function peerFor(c, mid) {
  let p = c.peers.get(mid);
  if (!p) {
    p = newPeer(mid);
    c.peers.set(mid, p);
    p.timer = later(c, T.pairConnectMs, () => {
      if (c.peers.get(mid) === p && p.link !== 'connected' && p.link !== 'failed') failPeer(c, p);
    });
  }
  return p;
}

// Der Teilnehmer mit der kleineren Mitglieds-ID bietet an - eindeutig, ohne
// Absprache, kein gleichzeitiges Anbieten ("glare").
async function ensurePairSetup(c, mid) {
  if (!isLive(c) || mid === c.selfMid) return;
  const p = peerFor(c, mid);
  if (c.selfMid < mid && !p.offered && p.link !== 'failed') {
    p.offered = true;
    try {
      const pc = await createPc(c, p);
      if (!pc) return;
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      const sdp = tuneOpusSdp(offer.sdp);
      await pc.setLocalDescription({ type: 'offer', sdp });
      if (!isCurrentPeer(c, p)) return;
      await sendPair(c, mid, 'offer', { sdp });
    } catch (e) {
      pairError(c, p, e);
    }
  }
}

async function createPc(c, p) {
  // Wirft im Verbindungsweg "nur Tor" (TorOnlyModeError) - dann entsteht
  // keine PeerConnection, auch nicht durch einen Wettlauf mit dem Wechsel.
  const config = await pcConfigForCalls();
  if (!isCurrentPeer(c, p)) return null;
  const pc = new RTCPeerConnection(config);
  p.pc = pc;
  const stream = c.localStream;
  for (const track of stream?.getTracks?.() || []) {
    try { pc.addTrack(track, stream); } catch {}
  }
  pc.onicecandidate = (event) => {
    const cand = candidateToJson(event?.candidate);
    if (!cand || !isCurrentPeer(c, p) || p.pc !== pc) return;
    sendPair(c, p.mid, 'ice', { c: cand }).catch(() => {});
  };
  pc.ontrack = (event) => { p.remoteStream = event?.streams?.[0] || null; };
  pc.oniceconnectionstatechange = () => onPeerIce(c, p, pc);
  return pc;
}

function pairError(c, p, e) {
  if (e?.name === 'TorOnlyModeError') {
    if (isLive(c)) hangup(c, 'tor_only_switch');
    return;
  }
  log('Paar-Verbindung fehlgeschlagen');
  if (isCurrentPeer(c, p)) failPeer(c, p);
}

async function handlePair(c, senderMid, m) {
  if (c.state !== GroupCallState.CONNECTING && c.state !== GroupCallState.ACTIVE) return;
  if (m.to !== c.selfMid) {
    if (c.role === 'host') relay(c, senderMid, m);
    return;   // Mitglieder leiten nie weiter
  }
  let peerMid;
  if (c.role === 'member' && senderMid === c.hostMid && m.from && m.from !== c.hostMid) {
    // Vom Host weitergeleitet: nur fuer Teilnehmer, mit denen ich NICHT direkt
    // gekoppelt bin - gekoppelte Paare signalisieren ausschliesslich direkt.
    if (c.members.get(m.from)?.contactId) { log('Weitergeleitetes Signal eines gekoppelten Teilnehmers verworfen'); return; }
    peerMid = m.from;
  } else {
    if (m.from && m.from !== senderMid) return;
    peerMid = senderMid;
  }
  const mem = c.members.get(peerMid);
  if (!mem || peerMid === c.selfMid) return;
  // Nur mit BEIGETRETENEN Teilnehmern (Audit 2026-10-19): vorher genuegte bei
  // Mitgliedern "nicht verlassen" - ein eingeladenes, aber nicht beigetretenes
  // (oder ablehnendes) Mitglied konnte per eigenem Angebot mithoeren. Ob
  // jemand beigetreten ist, sagt die Teilnehmerliste des Hosts; Angebote und
  // ICE, die vor dieser Liste ankommen, werden kurz zurueckgehalten.
  if (mem.status !== 'joined') {
    if (c.role === 'member' && mem.status !== 'left' && (m.t === 'offer' || m.t === 'ice')) holdEarlySignal(c, peerMid, m);
    return;
  }
  await dispatchPair(c, peerMid, m);
}

async function dispatchPair(c, peerMid, m) {
  try {
    if (m.t === 'offer') await onOffer(c, peerMid, m.sdp);
    else if (m.t === 'answer') await onAnswer(c, peerMid, m.sdp);
    else await onIce(c, peerMid, m.c);
  } catch (e) {
    const p = c.peers.get(peerMid);
    if (p) pairError(c, p, e);
  }
}

const EARLY_MAX_PER_PEER = 40;
function holdEarlySignal(c, peerMid, m) {
  if (!c.early) c.early = new Map();
  const list = c.early.get(peerMid) || [];
  if (m.t === 'offer') list.length = 0;   // neues Angebot ersetzt alles Fruehere
  if (list.length >= EARLY_MAX_PER_PEER) return;
  list.push(m);
  c.early.set(peerMid, list);
}

// Nach einer Teilnehmerliste: zurueckgehaltene Signale nun beigetretener
// Teilnehmer verarbeiten; Signale nicht (mehr) gelisteter verwerfen.
async function replayEarlySignals(c) {
  if (!c.early || !c.early.size) return;
  for (const [mid, list] of [...c.early]) {
    const mem = c.members.get(mid);
    if (!mem || mem.status === 'left') { c.early.delete(mid); continue; }
    if (mem.status !== 'joined') continue;
    c.early.delete(mid);
    for (const m of list) {
      if (!isLive(c)) return;
      await dispatchPair(c, mid, m);
    }
  }
}

async function onOffer(c, peerMid, sdp) {
  if (!(peerMid < c.selfMid)) return;   // nur der Kleinere bietet an
  const p = peerFor(c, peerMid);
  if (p.answered || p.link === 'failed') return;
  const pc = p.pc || await createPc(c, p);
  if (!pc || !isCurrentPeer(c, p)) return;
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await flushIce(p);
  const answer = await pc.createAnswer();
  const tuned = tuneOpusSdp(answer.sdp);
  await pc.setLocalDescription({ type: 'answer', sdp: tuned });
  if (!isCurrentPeer(c, p)) return;
  p.answered = true;
  await sendPair(c, peerMid, 'answer', { sdp: tuned });
}

async function onAnswer(c, peerMid, sdp) {
  const p = c.peers.get(peerMid);
  if (!p || !p.pc || !p.offered || p.answered) return;
  p.answered = true;
  await p.pc.setRemoteDescription({ type: 'answer', sdp });
  await flushIce(p);
}

async function onIce(c, peerMid, cand) {
  const p = peerFor(c, peerMid);
  if (++p.iceCount > MAX_ICE_PER_PEER || p.link === 'failed') return;
  if (p.pc && p.pc.remoteDescription) {
    try { await p.pc.addIceCandidate(cand); } catch { log('ICE-Kandidat nicht anwendbar'); }
  } else if (p.pendingIce.length < MAX_PENDING_ICE) {
    p.pendingIce.push(cand);
  }
}

async function flushIce(p) {
  const list = p.pendingIce;
  p.pendingIce = [];
  for (const cand of list) {
    try { await p.pc.addIceCandidate(cand); } catch { log('Zwischengespeicherter ICE-Kandidat nicht anwendbar'); }
  }
}

// Host: Paar-Signal zwischen zwei NICHT miteinander gekoppelten Teilnehmern
// weiterleiten - nur zwischen Beigetretenen, Absender = Kanal des Absenders.
function relay(c, senderMid, m) {
  const from = c.members.get(senderMid);
  const to = c.members.get(m.to);
  if (!from || !to || from.status !== 'joined' || to.status !== 'joined' || !to.contactId) return;
  if (m.to === senderMid || m.to === c.selfMid || senderMid === c.selfMid) return;
  const n = (c.relays.get(senderMid) || 0) + 1;
  c.relays.set(senderMid, n);
  if (n > MAX_RELAYS_PER_SENDER) return;
  const fwd = { t: m.t, to: m.to, from: senderMid };
  if (m.sdp) fwd.sdp = m.sdp;
  if (m.c) fwd.c = m.c;
  sendTo(to.contactId, fwd, idsOf(c)).catch(() => {});
}

function onPeerIce(c, p, pc) {
  if (!isCurrentPeer(c, p) || p.pc !== pc) return;
  const s = pc.iceConnectionState;
  if (s === 'connected' || s === 'completed') {
    clearLater(c, p.timer);
    clearLater(c, p.graceTimer);
    if (p.link !== 'connected') {
      p.link = 'connected';
      log('Paar verbunden');
      if (c.state === GroupCallState.CONNECTING) {
        c.startedAt = Date.now();
        setState(c, GroupCallState.ACTIVE);
        try { bridge()?.reportCallActive?.(c.key); } catch {}
        startStats(c);
      }
      emit();
    }
    return;
  }
  if (s === 'failed') { failPeer(c, p); return; }
  if (s === 'disconnected') {
    clearLater(c, p.graceTimer);
    p.graceTimer = later(c, T.iceGraceMs, () => {
      if (c.peers.get(p.mid) === p && p.pc === pc && ['disconnected', 'failed'].includes(pc.iceConnectionState)) failPeer(c, p);
    });
  }
}

// Keine direkte Verbindung fuer dieses Paar (NAT, Netz): "nicht erreichbar".
// Bewusst kein Ausweichen auf Sprache ueber Tor (siehe Design-Dokument).
function failPeer(c, p) {
  if (p.link === 'failed') return;
  p.link = 'failed';
  p.speaking = false;
  clearLater(c, p.timer);
  clearLater(c, p.graceTimer);
  closePeerConnection(p);
  log('Paar nicht erreichbar');
  emit();
  checkAllFailed(c);
}

function closePeerConnection(p) {
  if (p.pc) {
    const pc = p.pc;
    p.pc = null;
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.ontrack = null;
    try { pc.close(); } catch {}
  }
  p.remoteStream = null;
}

function closePeer(c, mid) {
  const p = c.peers.get(mid);
  if (!p) return;
  clearLater(c, p.timer);
  clearLater(c, p.graceTimer);
  closePeerConnection(p);
  c.peers.delete(mid);
}

// Zu keinem anderen Beigetretenen eine Verbindung -> Anruf beenden.
function checkAllFailed(c) {
  if (!isLive(c) || (c.state !== GroupCallState.CONNECTING && c.state !== GroupCallState.ACTIVE)) return;
  const joinedOthers = [...c.members.values()].filter((m) => m.mid !== c.selfMid && m.status === 'joined');
  if (!joinedOthers.length) return;
  if (joinedOthers.every((m) => c.peers.get(m.mid)?.link === 'failed')) hangup(c, 'no_media');
}

// ─── Sprech-Anzeige (guenstig: getStats je verbundenem Paar) ───────────────
function startStats(c) {
  if (c.statsTimer || !T.statsMs) return;
  c.statsTimer = setInterval(() => { pollStats(c).catch(() => {}); }, T.statsMs);
  c.statsTimer?.unref?.();
}
function levelsFrom(report) {
  const out = { inbound: 0, source: 0 };
  const values = report && typeof report.forEach === 'function' ? [] : (Array.isArray(report) ? report : []);
  if (report && typeof report.forEach === 'function') report.forEach((v) => values.push(v));
  for (const s of values) {
    if (!s || typeof s.audioLevel !== 'number') continue;
    if (s.type === 'inbound-rtp') out.inbound = Math.max(out.inbound, s.audioLevel);
    if (s.type === 'media-source') out.source = Math.max(out.source, s.audioLevel);
  }
  return out;
}
async function pollStats(c) {
  if (!isLive(c)) { clearInterval(c.statsTimer); c.statsTimer = null; return; }
  let changed = false;
  let self = 0;
  for (const p of c.peers.values()) {
    if (!p.pc || p.link !== 'connected' || typeof p.pc.getStats !== 'function') continue;
    let lv;
    try { lv = levelsFrom(await p.pc.getStats()); } catch { continue; }
    const speaking = lv.inbound >= SPEAKING_LEVEL;
    if (speaking !== p.speaking) { p.speaking = speaking; changed = true; }
    self = Math.max(self, lv.source);
  }
  const selfSpeaking = !c.muted && self >= SPEAKING_LEVEL;
  if (selfSpeaking !== c.selfSpeaking) { c.selfSpeaking = selfSpeaking; changed = true; }
  if (changed && isLive(c)) emit();
}

// ─── Stumm / Lautsprecher ───────────────────────────────────────────────────
function applyMute(c) {
  try { c.localStream?.getAudioTracks?.().forEach((t) => { t.enabled = !c.muted; }); } catch {}
}
export function setGroupCallMuted(muted) {
  const c = call;
  if (!c || c.ended) return;
  c.muted = !!muted;
  if (c.muted) c.selfSpeaking = false;
  applyMute(c);
  if (c.role === 'host') {
    rosterChanged(c);
  } else if (c.state === GroupCallState.CONNECTING || c.state === GroupCallState.ACTIVE) {
    sendTo(hostContactId(c), { t: 'mute', mu: c.muted }, idsOf(c)).catch(() => {});
  }
  emit();
}
export function setGroupCallSpeaker(on) {
  const c = call;
  if (!c || c.ended || !speakerSupported()) return;
  c.speaker = !!on;
  try { callAudio().setSpeaker(c.speaker); } catch {}
  emit();
}

// ─── Auflegen / Ende ────────────────────────────────────────────────────────
export function leaveGroupCall(reason = 'user_hangup', { fromNative = false } = {}) {
  const c = call;
  if (!c || c.ended) return;
  if (c.state === GroupCallState.RINGING) { declineInternal(c, 'user', fromNative); return; }
  hangup(c, reason, { fromNative });
}

// Gegenseite(n) informieren, dann lokal abbauen. Host: Ende fuer alle.
function hangup(c, reason, { fromNative = false } = {}) {
  if (c.ended) return;
  if (c.role === 'host') {
    const endReason = END_REASONS.has(reason) ? reason : 'host_hangup';
    for (const m of c.members.values()) {
      if (m.mid !== c.selfMid && m.contactId && m.status !== 'unpaired') {
        sendTerminal(m.contactId, { t: 'end', reason: endReason }, idsOf(c)).catch(() => {});
      }
    }
  } else if (c.state === GroupCallState.RINGING) {
    const host = hostContactId(c);
    if (host) sendTerminal(host, { t: 'decline', reason: 'user' }, idsOf(c)).catch(() => {});
  } else if (reason !== 'unreachable') {
    const host = hostContactId(c);
    if (host) sendTerminal(host, { t: 'leave' }, idsOf(c)).catch(() => {});
  }
  teardown(c, reason, { fromNative });
}

function noticeForEnd(c, reason) {
  switch (reason) {
    case 'no_answer': return 'Niemand hat den Gruppenanruf angenommen.';
    case 'alone': return tr('groupCall.alleAnderenHabenAufgelegtDer');
    case 'host_ended': return (c.members.get(c.hostMid)?.name || tr('groupCall.theHost')) + ' hat den Gruppenanruf beendet.';
    case 'host_no_media':
    case 'no_media': return tr('groupCall.gruppenanrufBeendetZuKeinemAnderen');
    case 'connect_timeout': return tr('groupCall.gruppenanrufHatNichtGeantwortetBeitritt', { value: c.members.get(c.hostMid)?.name || tr('groupCall.theHost') });
    case 'unreachable': return tr('groupCall.gruppenanrufIstGeradeNichtErreichbar', { value: c.members.get(c.hostMid)?.name || tr('groupCall.theHost') });
    case 'tor_only_switch': return 'Gruppenanruf beendet: ' + groupCallTorOnlyNotice();
    case 'error': return tr('groupCall.derGruppenanrufWurdeWegenEines');
    default: return null;   // selbst aufgelegt, abgelehnt, verpasst, Wipe
  }
}

// Lokal abbauen (nichts senden). Danach kurz ENDED, dann IDLE.
function teardown(c, reason, { fromNative = false, silent = false } = {}) {
  if (c.ended) return;
  c.ended = true;
  for (const t of c.timers) clearTimeout(t);
  c.timers.clear();
  if (c.statsTimer) { clearInterval(c.statsTimer); c.statsTimer = null; }
  for (const p of c.peers.values()) closePeerConnection(p);
  c.peers.clear();
  stopStream(c.localStream);
  c.localStream = null;
  if (c.speaker) { try { callAudio()?.setSpeaker?.(false); } catch {} }
  if (c.modeUnsub) { try { c.modeUnsub(); } catch {} c.modeUnsub = null; }
  releaseAudio(AUDIO_ID);
  if (!fromNative) { try { bridge()?.reportCallEnded?.(c.key); } catch {} }
  // Beitritt gescheitert: der Anruf laeuft vermutlich nicht mehr.
  if (c.role === 'member' && (reason === 'connect_timeout' || reason === 'unreachable')) knownCalls.delete(c.groupId);
  c.endReason = reason;
  c.state = GroupCallState.ENDED;
  log('Gruppenanruf beendet');
  if (!silent) notice(noticeForEnd(c, reason));
  emit();
  const t = setTimeout(() => {
    if (call === c) { call = null; emit(); }
  }, T.endedLingerMs);
  t?.unref?.();
}

// ─── Verdrahtung ────────────────────────────────────────────────────────────
RTCStore.groupCallSignalHandler = handleGroupCallSignal;
// Nur ein Anruf gleichzeitig: ein eingehender 1:1-Anruf waehrend eines
// Gruppenanrufs wird sofort als "besetzt" abgelehnt (klingelt nicht).
RTCStore.callBusyCheck = (chatId) => {
  if (!isGroupCallBusy()) return false;
  rejectIncomingCallBusy(chatId).catch(() => {});
  log('1:1-Anruf waehrend Gruppenanruf abgelehnt (besetzt)');
  return true;
};
RTCStore.onWipe((chatId) => {
  const c = call;
  if (chatId == null) {
    knownCalls.clear();
    signalRate.clear();
    inviteRate.clear();
    sendChains.clear();
    if (c) teardown(c, 'wipe', { silent: true });
    emit();
    return;
  }
  if (!c || c.ended) return;
  const mid = c.midByContact.get(chatId);
  if (!mid) return;
  if (mid === c.hostMid && c.role === 'member') { teardown(c, 'host_ended'); return; }
  closePeer(c, mid);
  c.midByContact.delete(chatId);
  const m = c.members.get(mid);
  if (m) { m.contactId = null; if (c.role === 'host' && m.status !== 'unpaired') m.status = 'left'; }
  if (c.role === 'host') { rosterChanged(c); checkHostDone(c); } else emit();
});

// Annehmen/Ablehnen/Auflegen aus der System-Anzeige (Benachrichtigung,
// Bluetooth) - gleicher Weg wie CallManager, Schluessel 'gcall_<callId>'.
if (CallBridgeModule) {
  try {
    const emitter = new NativeEventEmitter(CallBridgeModule);
    const forMe = (p) => !!call && p?.contactId === call.key;
    emitter.addListener('nativeCallAnswered', (p) => { if (forMe(p)) acceptGroupCall(true); });
    emitter.addListener('nativeCallRejected', (p) => { if (forMe(p)) leaveGroupCall('user_hangup', { fromNative: true }); });
    emitter.addListener('nativeCallEnded', (p) => { if (forMe(p)) leaveGroupCall('user_hangup', { fromNative: true }); });
    emitter.addListener('nativeCallCancelled', (p) => { if (forMe(p)) leaveGroupCall('user_hangup', { fromNative: true }); });
  } catch {}
}

export function _resetGroupCallForTests() {
  if (call) {
    for (const t of call.timers) clearTimeout(t);
    if (call.statsTimer) clearInterval(call.statsTimer);
    for (const p of call.peers.values()) closePeerConnection(p);
    if (call.modeUnsub) { try { call.modeUnsub(); } catch {} }
  }
  call = null;
  starting = false;
  chain = Promise.resolve();
  sendChains.clear();
  knownCalls.clear();
  signalRate.clear();
  inviteRate.clear();
  listeners.clear();
  noticeHandler = null;
  T = { ...DEFAULT_TIMEOUTS };
  deps = { isPro: () => getLicenseState().pro === true };
}
