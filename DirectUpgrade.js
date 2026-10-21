/**
 * Malachi - Wechsel auf eine direkte Verbindung ("Upgrade") ueber eine
 * bestehende, angemeldete Verbindung (meist Tor).
 *
 * Es gibt keinen Server mehr, ueber den zwei Geraete eine direkte WebRTC-
 * Verbindung aushandeln koennten. Stattdessen verbinden sich Kontakte zuerst
 * ueber Tor (TorTransport.js: gegenseitige Anmeldung, eigener Kyber-
 * Schluesseltausch). Ueber diese bereits Ende-zu-Ende-verschluesselte
 * Verbindung tauschen die Geraete Angebot und Antwort (SDP inkl. ICE-
 * Kandidaten) fuer eine direkte Verbindung aus - als System-Nachrichten
 * (subtype direct_*), verschluesselt wie jede andere Nachricht. RTCStore
 * reicht sie nur von dort hierher weiter, nie an die Chat-Oberflaeche.
 *
 * Ablauf:
 *  1. Tor-Verbindung steht (Schluesseltausch fertig).
 *  2. Das Geraet mit der alphabetisch kleineren Onion-Adresse bietet an
 *     (Offerer). Beide Seiten kommen ohne Absprache zum selben Ergebnis - es
 *     entstehen keine zwei konkurrierenden Angebote ("Glare"). Kennt eine
 *     Seite eine Onion-Adresse (noch) nicht, entscheidet die Rolle aus der
 *     Kopplung. Widersprechen sich beide Seiten trotzdem, gewinnt beim
 *     Zusammenstoss das Angebot der kleineren Onion-Adresse (jede Nachricht
 *     traegt die Onion-Adresse des Absenders). Die andere Seite kann per
 *     direct_request um ein Angebot bitten (z.B. nach ihrem Netzwechsel).
 *  3. Die neue Direktverbindung handelt ihren eigenen, frischen Kyber-
 *     Schluessel aus. Erst wenn der fertig ist, wird sie aktiv; die Tor-
 *     Verbindung wird Reserve (TorTransport.demoteActiveTorToReserve). Bis
 *     dahin laeuft alles unveraendert ueber Tor - ein scheiternder Versuch
 *     stoert die funktionierende Tor-Verbindung nicht.
 *  4. Bricht die Direktverbindung weg, uebernimmt die Reserve sofort; danach
 *     neuer Versuch mit wachsender Wartezeit (15 s ... 5 min).
 *
 * Netzwechsel: eine bestehende Direktverbindung wird nicht sofort verworfen,
 * sondern per ICE-Neustart auf das neue Netz umgezogen. Angebot und Antwort
 * laufen dabei ueber die Direktverbindung selbst - der alte Pfad traegt nach
 * einem Wechsel oft noch einige Sekunden (Mobilfunk bleibt beim Wechsel ins
 * WLAN kurz aktiv). DTLS, DataChannel und Kyber-Schluessel bleiben erhalten.
 * Liefert die Verbindung nach dem Wechsel binnen NETCHANGE_DEAD_AFTER_MS
 * nichts mehr, wird sie geschlossen und der normale Weg greift (Tor, dann
 * Upgrade).
 *
 * Sicherheit: Signale kommen nur ueber einen bereits angemeldeten,
 * verschluesselten Kanal zum Kontakt. Die neue Verbindung handelt trotzdem
 * einen eigenen Kyber-Schluessel aus - wie jede Verbindung. Das SDP enthaelt
 * die IP-Adressen des Geraets; sie sieht nur der Kontakt (wie bei jeder
 * direkten Verbindung). Schluessel werden nie geloggt.
 *
 * Verbindungsweg (ConnectionMode.js): in Stufe 3 "Maximal anonym (nur Tor)"
 * gibt es kein Upgrade - eigene Versuche unterbleiben, Angebote und Bitten der
 * Gegenseite werden mit 'tor_only' abgelehnt (sie wartet dann 10 min). Ein
 * Wechsel auf Stufe 3 stuft bestehende Direktverbindungen SOFORT auf Tor
 * zurueck (applyConnectionMode). Der Entwickler-Testschalter "nur Tor"
 * (TorTransport.isForceTorTestMode) wirkt hier genauso.
 *
 * Hole Punching ohne STUN (Stufe 2) - braucht es eine Zeitabstimmung ueber
 * den Kanal (etwa ein "direct_go" mit gemeinsamem Startzeitpunkt)? Nein:
 *  - Die Antwortseite beginnt ihre ICE-Pruefungen, sobald sie das Angebot
 *    angewendet hat (setLocalDescription), also VOR dem Absenden der Antwort.
 *    Ihre ausgehenden Pruefpakete oeffnen dabei ihr eigenes NAT/ihre Firewall
 *    fuer genau die Adressen des Anbieters. Der Anbieter beginnt, sobald die
 *    Antwort ankommt - Abstand: Sammeln + Portfreigabe (hoechstens
 *    PORT_MAPPING_MAX_WAIT_MS) + eine Tor-Laufzeit, typisch 2-8 s.
 *  - libwebrtc wiederholt Pruefungen eines unbeantworteten Paares rund 15 s
 *    lang und beantwortet eingehende Pruefungen sofort - auch von bis dahin
 *    unbekannten (peer-reflexiven) Adressen und sogar, bevor beim Anbieter
 *    die Antwort angekommen ist. Sobald es die ICE-Zugangsdaten der
 *    Gegenseite kennt, schickt es eine "getriggerte" Gegenpruefung auf genau
 *    diesem Weg. UDP-Zustaende in NAT/Firewall leben mindestens 30 s
 *    (RFC 4787: 2 min empfohlen). Der Abstand passt mit Reserve hinein.
 *  - Ein gemeinsamer Startzeitpunkt wuerde einen zusaetzlichen Tor-Umlauf
 *    kosten und gleich gehende Uhren voraussetzen, ohne einen Fehlerfall zu
 *    beheben. Trickle-ICE (Kandidaten einzeln nachreichen) bringt hier
 *    ebenfalls nichts: ohne STUN liegen alle Kandidaten (Host, IPv6, vom
 *    Router freigegebene Adresse) schon beim Absenden vor; was ICE sonst noch
 *    findet (peer-reflexiv), lernt es aus den Pruefpaketen selbst.
 *  Noetig ist nur, dass der Abstand klein bleibt: das Warten auf den Router
 *  ist begrenzt, und die ICE-Wachhunde (20 s) wie das Versuchs-Zeitlimit
 *  (35 s) liegen deutlich darueber. Klappt es trotzdem nicht, bleibt Tor.
 */
import EncryptedStorage from 'react-native-encrypted-storage';
import RTCStore from './RTCStore';
import { WebRTCManager } from './WebRTCManager';
import { secureRandomToken } from './MessageCrypto';
import {
  getKnownOwnOnion, ONION_RE, isForceTorTestMode, demoteActiveTorToReserve, promoteTorReserve,
} from './TorTransport';
import {
  MODE_FAST, MODE_PRIVATE, MODE_TOR_ONLY, connectionModeForDecision, onConnectionModeChange,
} from './ConnectionMode';

// Angebot -> fertiger Schluesseltausch. Grosszuegig: Tor-Laufzeiten (2x je
// ~1-3 s) plus ICE-Pruefung (WebRTCManager gibt nach 20 s auf).
export const UPGRADE_ATTEMPT_TIMEOUT_MS = 35000;
export const UPGRADE_BACKOFF_MIN_MS = 15000;
export const UPGRADE_BACKOFF_MAX_MS = 5 * 60 * 1000;
// Gegenseite im Testmodus "nur Tor": lange in Ruhe lassen.
const TOR_ONLY_BACKOFF_MS = 10 * 60 * 1000;
// Nach Abbruch einer laufenden Direktverbindung: kurz durchatmen, dann neu.
const RETRY_AFTER_DIRECT_LOST_MS = 3000;
// Bitten um ein Angebot hoechstens so oft (beide Richtungen).
const REQUEST_MIN_GAP_MS = 10000;
// Neue Tor-Verbindung, Gegenseite ist Anbieter: so lange auf ihr Angebot
// warten, bevor nachgefragt wird.
const REQUEST_AFTER_TOR_READY_MS = 5000;
const RESTART_TIMEOUT_MS = 6000;
const RESTART_DELAY_AFTER_NETCHANGE_MS = 700;
export const NETCHANGE_DEAD_AFTER_MS = 5000;
const MAX_SDP_LEN = 30000;
const ID_RE = /^[0-9a-f]{8,64}$/;

let hooks = { flushQueue: null, onPromoted: null, onDirectLost: null };
export function configureDirectUpgrade(h) { hooks = { ...hooks, ...h }; }

const attempts = new Map();     // contactId -> laufender Upgrade-Versuch
const backoff = new Map();      // contactId -> { nextAt, delay }
const lastRequestSent = new Map();
const lastOfferStarted = new Map();
const restarts = new Map();     // contactId -> laufender ICE-Neustart
const retryTimers = new Map();

// ── Hilfen ──────────────────────────────────────────────────────────────────
async function loadContact(contactId) {
  try {
    const raw = await EncryptedStorage.getItem('contacts');
    const cs = raw ? JSON.parse(raw) : [];
    return cs.find(c => c && c.id === contactId && !c.wiped) || null;
  } catch { return null; }
}

// Wer bietet an? Beide Seiten muessen ohne Absprache zum selben Ergebnis
// kommen: die kleinere Onion-Adresse. Fallback (eine Adresse unbekannt): die
// Rolle aus der Kopplung (der Einladende ist 'initiator').
export function decideOfferer(myOnion, peerOnion, role) {
  if (ONION_RE.test(myOnion || '') && ONION_RE.test(peerOnion || '') && myOnion !== peerOnion) {
    return myOnion < peerOnion;
  }
  return role === 'initiator';
}

function validSdp(desc, type) {
  return !!desc && typeof desc === 'object' && desc.type === type
    && typeof desc.sdp === 'string' && desc.sdp.length > 0 && desc.sdp.length <= MAX_SDP_LEN;
}
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

function sendSignal(contactId, body, viaRtc = null) {
  const rtc = viaRtc || RTCStore.connections.get(contactId);
  if (!rtc || rtc._closed || typeof rtc.sendMessage !== 'function') return false;
  let r = false;
  try { r = rtc.sendMessage(JSON.stringify({ type: 'system', v: 1, ...body })); } catch { r = false; }
  return r === 'sent' || r === 'queued';
}

function bumpBackoff(contactId, minMs = 0) {
  const prev = backoff.get(contactId);
  // minMs darf ueber dem Maximum liegen (Gegenseite nutzt nur Tor: 10 min).
  const delay = Math.max(minMs, Math.min(UPGRADE_BACKOFF_MAX_MS, prev ? prev.delay * 2 : UPGRADE_BACKOFF_MIN_MS));
  backoff.set(contactId, { delay, nextAt: Date.now() + delay });
  return delay;
}

function activeTorReady(contactId) {
  const active = RTCStore.connections.get(contactId);
  return !!active && !active._closed && active.keyExchangeDone === true && active.transport === 'tor'
    && active.dataChannel?.readyState === 'open';
}

export function isUpgradeInProgress(contactId) { return attempts.has(contactId); }

// Keine Direktverbindung erlaubt? Verbindungsweg Stufe 3 (bei unlesbarer
// Einstellung ausfallsicher ebenso) oder der Entwickler-Testschalter.
async function torOnly() {
  if (isForceTorTestMode()) return true;
  return (await connectionModeForDecision()) === MODE_TOR_ONLY;
}

// ── Upgrade starten ─────────────────────────────────────────────────────────
// reason: 'tor-bereit' (neue Tor-Verbindung), 'zyklus' (Verbindungszyklus,
// BackgroundSync), 'direkt-weg' (Direktverbindung abgebrochen), 'manuell'.
// Liefert eine kurze Begruendung (fuer Logs/Tests).
export async function maybeStartUpgrade(contactId, { reason = 'zyklus', force = false } = {}) {
  if (await torOnly()) return 'nur-tor';
  if (!activeTorReady(contactId)) return 'keine-tor-verbindung';
  if (attempts.has(contactId)) return 'laeuft';
  const b = backoff.get(contactId);
  if (!force && b && Date.now() < b.nextAt) return 'wartet';
  const contact = await loadContact(contactId);
  if (!contact) return 'unbekannt';
  // Zustand kann sich waehrend des Lesens geaendert haben.
  if (!activeTorReady(contactId) || attempts.has(contactId)) return 'laeuft';
  if (decideOfferer(getKnownOwnOnion(), contact.torOnion, contact.role)) {
    startOffer(contactId).catch(() => {});
    return 'angebot';
  }
  // Die Gegenseite bietet an. Routinezyklen fragen nicht nach (die Gegenseite
  // versucht es selbst mit ihrer Wartezeit) - nur bei einem Anlass. Bei einer
  // frischen Tor-Verbindung bietet die Gegenseite ohnehin gleich an: erst
  // nachfragen, wenn bis dahin nichts kam.
  if (reason === 'zyklus') return 'gegenseite';
  if (reason === 'tor-bereit') {
    scheduleRetry(contactId, REQUEST_AFTER_TOR_READY_MS, 'nachfrage');
    return 'gegenseite';
  }
  if (Date.now() - (lastRequestSent.get(contactId) || 0) < REQUEST_MIN_GAP_MS) return 'gegenseite';
  lastRequestSent.set(contactId, Date.now());
  sendSignal(contactId, { subtype: 'direct_request', onion: getKnownOwnOnion() || undefined });
  console.log('[Direkt] Bitte die Gegenseite um ein Angebot fuer eine Direktverbindung (' + reason + ')');
  return 'angefragt';
}

function newAttempt(contactId, id, role) {
  const early = [];
  const att = { contactId, id, role, startedAt: Date.now(), done: false, promoted: false, answered: false, early, timer: null, rtc: null };
  // Bis zur Uebernahme (promote) gehoeren eintreffende Nachrichten noch keiner
  // Chat-Weiche - puffern statt verlieren, danach zustellen.
  const rtc = new WebRTCManager(
    (m) => { if (early.length < 100) early.push(m); },
    () => {},
    () => onAttemptDisc(att),
  );
  rtc.chatId = contactId;
  rtc._upgradeId = id;
  rtc._onKeyExchange = () => promote(att);
  att.rtc = rtc;
  att.timer = setTimeout(() => { if (!att.done) failAttempt(att, 'Zeitlimit'); }, UPGRADE_ATTEMPT_TIMEOUT_MS);
  att.timer?.unref?.();
  attempts.set(contactId, att);
  return att;
}

async function startOffer(contactId) {
  const id = await secureRandomToken(8);
  if (await torOnly()) return;
  if (attempts.has(contactId) || !activeTorReady(contactId)) return;
  lastOfferStarted.set(contactId, Date.now());
  const att = newAttempt(contactId, id, 'offerer');
  console.log('[Direkt] Starte Aushandlung einer Direktverbindung (ueber Tor)');
  try {
    const offerJSON = await att.rtc.createOffer();
    if (att.done) return;
    const { sdp } = JSON.parse(offerJSON);
    if (!validSdp(sdp, 'offer')) throw new Error('ungueltiges eigenes Angebot');
    if (!sendSignal(contactId, { subtype: 'direct_offer', id, sdp, onion: getKnownOwnOnion() || undefined })) {
      throw new Error('Angebot nicht zustellbar');
    }
  } catch (e) {
    failAttempt(att, e?.message || String(e));
  }
}

function failAttempt(att, why, { noBackoff = false, backoffMs = 0 } = {}) {
  if (att.done) return;
  att.done = true;
  clearTimeout(att.timer);
  if (attempts.get(att.contactId) === att) attempts.delete(att.contactId);
  try { att.rtc?.close(); } catch {}
  if (noBackoff) {
    console.log('[Direkt] Versuch beendet:', why);
    return;
  }
  const delay = bumpBackoff(att.contactId, backoffMs);
  console.log('[Direkt] Direktverbindung kam nicht zustande (' + why + ') - weiter ueber Tor, neuer Versuch in', Math.round(delay / 1000), 's');
}

function onAttemptDisc(att) {
  if (!att.promoted) { failAttempt(att, 'Verbindung abgebrochen'); return; }
  // War aktiv: Direktverbindung verloren -> Reserve sofort uebernehmen.
  const id = att.contactId;
  if (RTCStore.connections.get(id) === att.rtc) {
    RTCStore.connections.delete(id);
    console.log('[Direkt] Direktverbindung abgebrochen - uebernehme Tor-Reserve');
    const promoted = promoteTorReserve(id);
    try { hooks.onDirectLost?.(id, promoted); } catch {}
  }
  // Danach erneut direkt versuchen (mit der Wartezeit-Logik).
  backoff.set(id, { delay: UPGRADE_BACKOFF_MIN_MS, nextAt: Date.now() + RETRY_AFTER_DIRECT_LOST_MS });
  scheduleRetry(id, RETRY_AFTER_DIRECT_LOST_MS + 200, 'direkt-weg');
}

function scheduleRetry(contactId, delayMs, reason) {
  if (retryTimers.has(contactId)) clearTimeout(retryTimers.get(contactId));
  const t = setTimeout(() => {
    retryTimers.delete(contactId);
    maybeStartUpgrade(contactId, { reason }).catch(() => {});
  }, delayMs);
  t?.unref?.();
  retryTimers.set(contactId, t);
}

async function promote(att) {
  if (att.done) return;
  att.done = true;
  att.promoted = true;
  clearTimeout(att.timer);
  const id = att.contactId;
  if (attempts.get(id) === att) attempts.delete(id);
  backoff.delete(id);
  const rtc = att.rtc;
  if (rtc._closed) return;
  // Tor wird Reserve (ohne Reserve-Wunsch schliesst setConnection sie).
  const cur = RTCStore.connections.get(id);
  if (cur && cur !== rtc && cur.transport === 'tor') demoteActiveTorToReserve(id);
  RTCStore.setConnection(id, rtc);
  if (hooks.flushQueue) rtc._onReady = () => hooks.flushQueue(id, rtc);
  for (const m of att.early.splice(0)) { try { rtc.onMessage?.(m); } catch {} }
  console.log('[Direkt] ✅ Direktverbindung aktiv (ueber Tor ausgehandelt) - Tor bleibt als Reserve');
  try { hooks.onPromoted?.(id, rtc); } catch {}
  // Wie bei jeder neuen Verbindung: Profil, eigene Onion-Adresse, wartende
  // Nachrichten (RTCStore._onKeyExchange, von setConnection gesetzt).
  if (typeof rtc._onKeyExchange === 'function') await rtc._onKeyExchange();
}

// ── Eingehende Signale (von RTCStore weitergereicht) ────────────────────────
export async function handleUpgradeSignal(chatId, msg) {
  if (!msg || typeof msg.subtype !== 'string') return;
  // Die Onion-Adresse kommt ueber den angemeldeten Kanal - wie tor_address.
  if (typeof msg.onion === 'string' && ONION_RE.test(msg.onion) && typeof RTCStore.torAddressHandler === 'function') {
    try { RTCStore.torAddressHandler(chatId, msg.onion); } catch {}
  }
  switch (msg.subtype) {
    case 'direct_request': return onRequest(chatId, msg);
    case 'direct_offer': return msg.restart ? onRestartOffer(chatId, msg) : onOffer(chatId, msg);
    case 'direct_answer': return msg.restart ? onRestartAnswer(chatId, msg) : onAnswer(chatId, msg);
    case 'direct_reject': return onReject(chatId, msg);
    default: return undefined;
  }
}

async function onRequest(chatId, msg) {
  if (await torOnly()) {
    sendSignal(chatId, { subtype: 'direct_reject', reason: 'tor_only' });
    return;
  }
  if (msg.restart) {
    const rtc = RTCStore.connections.get(chatId);
    if (rtc && rtc.transport === 'direct' && !rtc._closed) startRestart(chatId, rtc).catch(() => {});
    return;
  }
  if (attempts.has(chatId)) return;
  if (Date.now() - (lastOfferStarted.get(chatId) || 0) < REQUEST_MIN_GAP_MS) return;
  if (!activeTorReady(chatId)) return;
  console.log('[Direkt] Gegenseite bittet um eine Direktverbindung');
  backoff.delete(chatId);
  await startOffer(chatId);
}

async function onOffer(chatId, msg) {
  if (!validId(msg.id) || !validSdp(msg.sdp, 'offer')) return;
  if (await torOnly()) {
    sendSignal(chatId, { subtype: 'direct_reject', id: msg.id, reason: 'tor_only' });
    return;
  }
  const existing = attempts.get(chatId);
  if (existing && !existing.done) {
    if (existing.id === msg.id) return;   // Doppelt angekommen
    if (existing.role === 'offerer') {
      // Beide haben gleichzeitig angeboten: das Angebot der kleineren
      // Onion-Adresse gilt - auf beiden Seiten dieselbe Entscheidung.
      const contact = await loadContact(chatId);
      if (decideOfferer(getKnownOwnOnion(), msg.onion || contact?.torOnion, contact?.role)) {
        sendSignal(chatId, { subtype: 'direct_reject', id: msg.id, reason: 'glare' });
        return;
      }
      failAttempt(existing, 'gleichzeitiges Angebot der Gegenseite gilt', { noBackoff: true });
    } else {
      failAttempt(existing, 'durch neues Angebot ersetzt', { noBackoff: true });
    }
  }
  const att = newAttempt(chatId, msg.id, 'answerer');
  console.log('[Direkt] Angebot fuer eine Direktverbindung erhalten - antworte (ueber die bestehende Verbindung)');
  try {
    const answerJSON = await att.rtc.createAnswerDirect(JSON.stringify({ sdp: msg.sdp }));
    if (att.done) return;
    const { sdp } = JSON.parse(answerJSON);
    if (!validSdp(sdp, 'answer')) throw new Error('ungueltige eigene Antwort');
    if (!sendSignal(chatId, { subtype: 'direct_answer', id: msg.id, sdp, onion: getKnownOwnOnion() || undefined })) {
      throw new Error('Antwort nicht zustellbar');
    }
  } catch (e) {
    failAttempt(att, e?.message || String(e));
  }
}

async function onAnswer(chatId, msg) {
  const att = attempts.get(chatId);
  if (!att || att.done || att.role !== 'offerer' || att.id !== msg.id || att.answered) return;
  if (!validSdp(msg.sdp, 'answer')) return;
  att.answered = true;
  try {
    await att.rtc.handleAnswer(JSON.stringify({ sdp: msg.sdp }));
    console.log('[Direkt] Antwort erhalten - pruefe direkten Pfad');
  } catch (e) {
    failAttempt(att, 'Antwort nicht verwendbar: ' + (e?.message || e));
  }
}

function onReject(chatId, msg) {
  if (msg.reason === 'tor_only' && !msg.id) {
    backoff.set(chatId, { delay: TOR_ONLY_BACKOFF_MS, nextAt: Date.now() + TOR_ONLY_BACKOFF_MS });
    return;
  }
  const r = restarts.get(chatId);
  if (r && r.id === msg.id) { endRestart(chatId, r, 'von der Gegenseite abgelehnt (' + String(msg.reason || '?').slice(0, 20) + ')'); return; }
  const att = attempts.get(chatId);
  if (!att || att.id !== msg.id) return;
  if (msg.reason === 'glare') { failAttempt(att, 'Angebot der Gegenseite gilt', { noBackoff: true }); return; }
  if (msg.reason === 'tor_only') { failAttempt(att, 'Gegenseite nutzt nur Tor', { backoffMs: TOR_ONLY_BACKOFF_MS }); return; }
  failAttempt(att, 'abgelehnt');
}

// ── Netzwechsel: Direktverbindung per ICE-Neustart retten ───────────────────
// Von BackgroundSync bei einem Wechsel des eigenen Netzes aufgerufen.
export function onLocalNetworkChange() {
  // Laufende Versuche tragen Kandidaten des alten Netzes - verwerfen, ohne
  // Strafwartezeit; nach dem Tor-Neuaufbau geht es sofort weiter.
  for (const att of [...attempts.values()]) failAttempt(att, 'Netzwechsel', { noBackoff: true });
  backoff.clear();
  lastRequestSent.clear();
  lastOfferStarted.clear();
  for (const [id, rtc] of [...RTCStore.connections.entries()]) {
    if (!rtc || rtc.transport !== 'direct' || rtc._closed || !rtc.keyExchangeDone) continue;
    const changedAt = Date.now();
    rtc._netChangedAt = changedAt;
    console.log('[Direkt] Netzwechsel - versuche die Direktverbindung per ICE-Neustart zu retten');
    // Kurz warten, bis das neue Netz auch fuer WebRTC sichtbar ist (Android
    // meldet es der App etwas frueher) - sonst fehlen dessen Kandidaten.
    const rt = setTimeout(() => { if (!rtc._closed) restartFlow(id, rtc).catch(() => {}); }, RESTART_DELAY_AFTER_NETCHANGE_MS);
    rt?.unref?.();
    // Totmann: kommt nach dem Wechsel gar nichts mehr an (alter Pfad tot,
    // Neustart nicht durchgekommen), schliessen - die Lebenszeichen-Erkennung
    // braeuchte sonst 8 s, so greift der Tor-Weg schneller.
    const t = setTimeout(() => {
      if (rtc._closed || RTCStore.connections.get(id) !== rtc) return;
      if ((rtc._lastActivity || 0) >= changedAt) return;
      console.warn('[Direkt] Direktverbindung liefert nach dem Netzwechsel nichts mehr - wird geschlossen');
      try { rtc._fireDisc?.(); } catch {}
      try { rtc.close(); } catch {}
    }, NETCHANGE_DEAD_AFTER_MS);
    t?.unref?.();
  }
}

async function restartFlow(contactId, rtc) {
  const contact = await loadContact(contactId);
  if (rtc._closed) return;
  if (decideOfferer(getKnownOwnOnion(), contact?.torOnion, contact?.role)) {
    await startRestart(contactId, rtc);
  } else {
    // Gegenseite startet den Neustart - Bitte ueber die Verbindung selbst.
    sendSignal(contactId, { subtype: 'direct_request', restart: true, onion: getKnownOwnOnion() || undefined }, rtc);
  }
}

async function startRestart(contactId, rtc) {
  const cur = restarts.get(contactId);
  if (cur && cur.rtc === rtc && !cur.done) return;
  if (await torOnly()) return;
  const id = await secureRandomToken(8);
  const r = { id, rtc, done: false, answered: false, timer: null };
  r.timer = setTimeout(() => endRestart(contactId, r, 'Zeitlimit'), RESTART_TIMEOUT_MS);
  r.timer?.unref?.();
  restarts.set(contactId, r);
  try {
    const desc = await rtc.createIceRestartOffer();
    if (r.done || rtc._closed) return;
    if (!validSdp(desc, 'offer')) throw new Error('ungueltiges Neustart-Angebot');
    if (!sendSignal(contactId, { subtype: 'direct_offer', restart: true, id, sdp: desc, onion: getKnownOwnOnion() || undefined }, rtc)) {
      throw new Error('Direktverbindung nimmt nichts mehr an');
    }
  } catch (e) {
    endRestart(contactId, r, e?.message || String(e));
  }
}

function endRestart(contactId, r, why) {
  if (r.done) return;
  r.done = true;
  clearTimeout(r.timer);
  if (restarts.get(contactId) === r) restarts.delete(contactId);
  if (why) console.log('[Direkt] ICE-Neustart beendet:', why);
}

async function onRestartOffer(chatId, msg) {
  if (!validId(msg.id) || !validSdp(msg.sdp, 'offer')) return;
  if (await torOnly()) {
    // Kann nur bei einem Wettlauf mit dem Wechsel auf Stufe 3 passieren -
    // keine neuen Kandidaten (IP-Adressen) mehr herausgeben.
    sendSignal(chatId, { subtype: 'direct_reject', id: msg.id, reason: 'tor_only' });
    return;
  }
  const rtc = RTCStore.connections.get(chatId);
  if (!rtc || rtc.transport !== 'direct' || rtc._closed) {
    sendSignal(chatId, { subtype: 'direct_reject', id: msg.id, reason: 'no_direct' });
    return;
  }
  const mine = restarts.get(chatId);
  if (mine && mine.rtc === rtc && !mine.done) {
    // Beide Seiten haben gleichzeitig neu gestartet.
    const contact = await loadContact(chatId);
    if (decideOfferer(getKnownOwnOnion(), msg.onion || contact?.torOnion, contact?.role)) {
      sendSignal(chatId, { subtype: 'direct_reject', id: msg.id, reason: 'glare' }, rtc);
      return;
    }
    endRestart(chatId, mine, 'Neustart der Gegenseite gilt');
  }
  try {
    const desc = await rtc.acceptIceRestartOffer(msg.sdp);
    if (!validSdp(desc, 'answer')) throw new Error('ungueltige Neustart-Antwort');
    sendSignal(chatId, { subtype: 'direct_answer', restart: true, id: msg.id, sdp: desc }, rtc);
    console.log('[Direkt] ICE-Neustart der Gegenseite beantwortet');
  } catch (e) {
    console.warn('[Direkt] ICE-Neustart nicht moeglich:', e?.message || e);
  }
}

async function onRestartAnswer(chatId, msg) {
  const r = restarts.get(chatId);
  if (!r || r.done || r.id !== msg.id || r.answered || !validSdp(msg.sdp, 'answer')) return;
  r.answered = true;
  try {
    await r.rtc.acceptIceRestartAnswer(msg.sdp);
    endRestart(chatId, r, null);
    console.log('[Direkt] ✅ ICE-Neustart ausgehandelt - Direktverbindung zieht ins neue Netz um');
  } catch (e) {
    endRestart(chatId, r, 'Antwort nicht verwendbar: ' + (e?.message || e));
  }
}

// ── Verbindungsweg gewechselt (ConnectionMode.js) - wirkt ohne Neustart ─────
// Direktverbindung eines Kontakts sofort auf Tor zurueckstufen: die Tor-
// Reserve wird aktiv (RTCStore.setConnection schliesst dabei die
// Direktverbindung und uebernimmt deren wartende Nachrichten); ohne Reserve
// wird die Direktverbindung geschlossen und sofort ueber Tor neu verbunden.
// Die Gegenseite erfaehrt ueber Tor, dass hier nur Tor gilt (sie versucht es
// dann 10 min nicht mehr; Wartendes stellt die Warteschlange erneut zu).
function demoteDirectToTor(contactId, rtc, why) {
  console.log('[Direkt] ' + why + ' - Direktverbindung wird sofort auf Tor zurueckgestuft');
  const promoted = promoteTorReserve(contactId);
  if (promoted) {
    sendSignal(contactId, { subtype: 'direct_reject', reason: 'tor_only' }, promoted);
  } else {
    if (RTCStore.connections.get(contactId) === rtc) RTCStore.connections.delete(contactId);
    try { rtc.close(); } catch {}
  }
  try { hooks.onDirectLost?.(contactId, promoted); } catch {}
  return !!promoted;
}

// Alle laufenden Versuche/Neustarts beenden und jede Direktverbindung auf Tor
// zurueckstufen (Stufe 3 oder Entwickler-Testschalter "nur Tor").
export function demoteAllDirectToTor(why = 'Verbindungsweg "nur Tor"') {
  for (const att of [...attempts.values()]) failAttempt(att, why, { noBackoff: true });
  for (const [id, r] of [...restarts.entries()]) endRestart(id, r, null);
  for (const [id, t] of [...retryTimers.entries()]) { clearTimeout(t); retryTimers.delete(id); }
  let count = 0;
  for (const [id, rtc] of [...RTCStore.connections.entries()]) {
    if (!rtc || rtc.transport === 'tor') continue;
    demoteDirectToTor(id, rtc, why);
    count++;
  }
  return count;
}

export async function applyConnectionMode(mode, prev) {
  if (mode === MODE_TOR_ONLY) {
    demoteAllDirectToTor('Verbindungsweg "Maximal anonym (nur Tor)"');
    return;
  }
  if (prev === MODE_TOR_ONLY) {
    // Direkt ist wieder erlaubt: Wartezeiten aufheben und sofort versuchen.
    // 'manuell' bittet auch eine Gegenseite um ein Angebot, die wegen unseres
    // frueheren 'tor_only' gerade 10 min Ruhe gibt.
    backoff.clear();
    lastRequestSent.clear();
    lastOfferStarted.clear();
    for (const [id, rtc] of [...RTCStore.connections.entries()]) {
      if (rtc?.transport === 'tor') maybeStartUpgrade(id, { reason: 'manuell', force: true }).catch(() => {});
    }
    return;
  }
  // Stufe 1 <-> 2: neue Verbindungen nutzen die neue Konfiguration ohnehin.
  // Bestehende Direktverbindungen bekommen sie ebenfalls - und beim Wechsel
  // auf "Privat" einen ICE-Neustart, damit sie den STUN-Server nicht weiter
  // (libwebrtc schickt ihm regelmaessig Lebenszeichen) ansprechen. Klappt der
  // Neustart ohne STUN nicht, uebernimmt Tor (wie nach einem Netzwechsel).
  for (const [id, rtc] of [...RTCStore.connections.entries()]) {
    if (!rtc || rtc.transport !== 'direct' || rtc._closed || !rtc.keyExchangeDone) continue;
    if (typeof rtc.applyConnectionModeConfig !== 'function') continue;
    const changed = await rtc.applyConnectionModeConfig().catch(() => false);
    if (changed && mode === MODE_PRIVATE && prev === MODE_FAST && !rtc._closed) {
      console.log('[Direkt] Verbindungsweg "Privat": Direktverbindung zieht per ICE-Neustart auf Kandidaten ohne STUN um');
      restartFlow(id, rtc).catch(() => {});
    }
  }
}
onConnectionModeChange((mode, prev) => applyConnectionMode(mode, prev));

RTCStore.upgradeSignalHandler = handleUpgradeSignal;

// Wipe/Kontakt loeschen: laufende Versuche (nicht in RTCStore.connections)
// mit Grund 'wipe' schliessen - ein gerade laufender Schluesseltausch darf
// sein Secret danach nicht wieder speichern (siehe WebRTCManager).
RTCStore.onWipe((chatId) => {
  for (const att of [...attempts.values()]) {
    if (chatId && att.contactId !== chatId) continue;
    att.done = true;
    clearTimeout(att.timer);
    attempts.delete(att.contactId);
    try { att.rtc?.close('wipe'); } catch {}
  }
  for (const [id, r] of [...restarts.entries()]) {
    if (chatId && id !== chatId) continue;
    endRestart(id, r, null);
  }
  for (const [id, t] of [...retryTimers.entries()]) {
    if (chatId && id !== chatId) continue;
    clearTimeout(t);
    retryTimers.delete(id);
  }
  if (chatId) backoff.delete(chatId); else backoff.clear();
});

// Fuer "Jetzt verbinden" (UI) und Tests.
export function resetUpgradeBackoff(contactId = null) {
  if (contactId) backoff.delete(contactId); else backoff.clear();
}
export function _resetDirectUpgradeForTests() {
  for (const att of [...attempts.values()]) { clearTimeout(att.timer); try { att.rtc?.close(); } catch {} }
  attempts.clear();
  backoff.clear();
  lastRequestSent.clear();
  lastOfferStarted.clear();
  for (const r of restarts.values()) clearTimeout(r.timer);
  restarts.clear();
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
}
export function _getAttemptForTests(contactId) { return attempts.get(contactId) || null; }
export function _getBackoffForTests(contactId) { return backoff.get(contactId) || null; }
export function _getRestartForTests(contactId) { return restarts.get(contactId) || null; }
