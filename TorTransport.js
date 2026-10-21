/**
 * Malachi - Tor-Verbindungsweg (Gegenstueck: android/.../tor/MalachiTorModule.kt)
 *
 * Malachi hat keinen eigenen Server. Die Geraete finden sich ausschliesslich
 * ueber ihre Onion-Adressen: Kopplung (QR-Code/Link mit Onion-Adresse) und
 * jeder Verbindungsaufbau zu bekannten Kontakten laufen zuerst ueber Tor.
 * Ueber die angemeldete Tor-Verbindung handeln die Geraete danach eine
 * direkte WebRTC-Verbindung aus (DirectUpgrade.js); steht sie, wird die
 * Tor-Verbindung zur Reserve. Ohne Verbindung warten Nachrichten in der
 * lokalen, verschluesselten Sende-Warteschlange.
 *
 * Hinweis: tor laeuft als eigener Prozess mit SOCKS-Port. Dieses Modul nutzt
 * nur Onion-Dienst-Verbindungen zu Kontakten; andere ausgehende Verbindungen
 * ueber denselben tor-Prozess (z.B. spaeter HTTP zu einem Onion-Shop ueber
 * den SOCKS-Port) werden hier weder benoetigt noch blockiert.
 *
 * Sicherheit - ueber Tor laeuft EXAKT dasselbe Protokoll wie ueber den
 * direkten Kanal (WebRTCManager): frischer ML-KEM-768-Schluesseltausch pro
 * Verbindung, dreifache Verschluesselung, Replay-/Reihenfolge-Schutz. Tors
 * eigene Verschluesselung liegt nur zusaetzlich aussen herum. Vorher melden
 * sich beide Seiten gegenseitig an (HMAC ueber das gemeinsame Kontakt-
 * Geheimnis, frische Nonces beider Seiten, an die Onion-Adresse gebunden) -
 * wer nur die Onion-Adresse kennt, kommt nicht weiter.
 *
 * Onion-Adressen werden ausschliesslich ueber den bereits verschluesselten
 * Kanal zwischen zwei Kontakten ausgetauscht (system/tor_address, siehe
 * RTCStore._onKeyExchange).
 */
import { NativeModules, NativeEventEmitter } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import EncryptedStorage from 'react-native-encrypted-storage';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { secureRandomToken } from './MessageCrypto';
import { WebRTCManager } from './WebRTCManager';
import RTCStore from './RTCStore';
import { TOR_BUILTIN_BRIDGES } from './TorBridges';
import { connectionModeForDecision, MODE_TOR_ONLY } from './ConnectionMode';
import { t } from './i18n';

const Tor = NativeModules.MalachiTor;
const emitter = Tor ? new NativeEventEmitter(Tor) : null;

export const TOR_VIRTUAL_PORT = 7777;
export const ONION_RE = /^[a-z2-7]{56}\.onion$/;
const AUTH_TIMEOUT_MS = 60000;          // Tor-Kreise koennen dauern
// Audit 2026-10-19 (A2/T3): Der Onion-Dienst endet auf 127.0.0.1 - dort kann
// sich auch jede andere App melden. Deshalb KEINE globale Sperre nach
// Fehlversuchen mehr (eine fremde App konnte damit alle Kontakte aussperren;
// Raten ist bei 256-Bit-Schluesseln ohnehin aussichtslos), sondern nur eine
// Obergrenze gleichzeitig unangemeldeter Verbindungen.
const MAX_PENDING_INCOMING = 12;

const SETTINGS_KEY = 'tor_settings';
const ONION_KEY_KEY = 'tor_onion_key';
const LAST_MODE_KEY = 'tor_last_working_mode';
// Zeitpunkt, an dem der direkte Weg (ohne Bridges) zuletzt scheiterte.
const NONE_FAILED_AT_KEY = 'tor_none_failed_at';
// So lange gilt ein Scheitern ohne Bridges als 'Netz sperrt Tor'. Danach wird
// der schnelle direkte Weg wieder zuerst versucht (Live-Test 2026-10-17: ein
// einmalig langsamer Start blieb sonst fuer immer beim langsamen Snowflake).
const NONE_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
// forceTorTest: Entwickler-Testschalter 'nur Tor' (kein Wechsel auf direkt).
// Bewusst NICHT im Verbindungsweg "Maximal anonym (nur Tor)" (ConnectionMode.js,
// Stufe 3) aufgegangen: er prueft nur den Tor-Weg fuer Nachrichten - Anrufe
// nutzen weiter WebRTC, er ist also kein IP-Schutz -, und er muss zum Testen
// ohne Vollversion gehen (Stufe 3 ist eine Pro-Funktion). Die UI zeigt ihn nur
// in Entwickler-Builds (bzw. solange er noch an ist, zum Abschalten).
// keepReserve: Tor-Reserve halten (siehe "Tor-Reserve" unten).
// enabled: bleibt nur aus Kompatibilitaet im Format - Tor ist seit dem Wegfall
// des Servers der einzige Weg, Kontakte zu finden, und laesst sich nicht mehr
// ausschalten (ein alter gespeicherter Wert 'false' wird ignoriert).
export const DEFAULT_TOR_SETTINGS = { enabled: true, bridgeMode: 'auto', customBridges: '', forceTorTest: false, keepReserve: true };
let cachedSettings = { ...DEFAULT_TOR_SETTINGS };
export function isForceTorTestMode() { return !!cachedSettings.forceTorTest; }
export function isTorReserveEnabled() { return cachedSettings.keepReserve !== false; }
export const TOR_BRIDGE_MODES = ['auto', 'none', 'snowflake', 'obfs4', 'meek', 'custom'];

// Automatik ("damit es ueberall klappt"): erst ohne Bridges, dann Snowflake,
// obfs4, zuletzt meek (langsam, aber ueber ein CDN kaum blockierbar). Die
// zuletzt funktionierende Stufe wird beim naechsten Start zuerst probiert.
const AUTO_SEQUENCE = [
  { mode: 'none', timeoutMs: 60000 },
  { mode: 'snowflake', timeoutMs: 120000 },
  { mode: 'obfs4', timeoutMs: 120000 },
  { mode: 'meek', timeoutMs: 180000 },
];

// ── Zustand fuer UI ────────────────────────────────────────────────────────
// reachable: eigener Onion-Dienst per Selbsttest nachweislich erreichbar.
let state = { status: 'OFF', progress: 0, message: null, onion: null, mode: null, reachable: false };
const stateListeners = new Set();
// Onion-Beschreibungen: wann zuletzt eingetroffen, wer darauf wartet (Kopplung).
const descReceivedAt = new Map();
const descWaiters = new Map();
export function onDescriptorReceived(onion, fn) {
  if (!descWaiters.has(onion)) descWaiters.set(onion, new Set());
  descWaiters.get(onion).add(fn);
  return () => { descWaiters.get(onion)?.delete(fn); };
}
export function descriptorReceivedSince(onion, since) {
  return (descReceivedAt.get(onion) || 0) >= since;
}
function setState(patch) {
  state = { ...state, ...patch };
  for (const l of stateListeners) { try { l(state); } catch {} }
}
export function getTorState() { return state; }
export function onTorState(fn) {
  stateListeners.add(fn);
  try { fn(state); } catch {}
  return () => stateListeners.delete(fn);
}
export function isTorAvailable() { return !!Tor; }
export function getOwnOnion() { return state.status === 'ON' ? state.onion : null; }
// Die eigene Onion-Adresse ist dauerhaft (gespeicherter Schluessel) - auch
// waehrend eines Tor-Neustarts (Netzwechsel) gilt die zuletzt bekannte. Fuer
// Entscheidungen, die beide Seiten gleich treffen muessen (DirectUpgrade.js).
let lastKnownOnion = null;
export function getKnownOwnOnion() { return getOwnOnion() || lastKnownOnion; }
// SOCKS-Port des tor-Prozesses (z.B. fuer spaetere HTTP-Anfragen an Onion-
// Dienste) - nur gueltig, solange Tor laeuft.
export function getTorSocksPort() { return state.status === 'ON' ? (state.socksPort || null) : null; }

// BackgroundSync.js reicht flushQueue() herein (vermeidet einen Import-Zyklus).
let hooks = { flushQueue: null };
export function configureTorTransport(h) { hooks = { ...hooks, ...h }; }

// ── Einstellungen ──────────────────────────────────────────────────────────
export async function loadTorSettings() {
  try {
    const raw = await EncryptedStorage.getItem(SETTINGS_KEY);
    const s = raw ? JSON.parse(raw) : {};
    const merged = { ...DEFAULT_TOR_SETTINGS, ...s, enabled: true };
    if (!TOR_BRIDGE_MODES.includes(merged.bridgeMode)) merged.bridgeMode = 'auto';
    cachedSettings = merged;
    return merged;
  } catch {
    return { ...DEFAULT_TOR_SETTINGS };
  }
}
export async function saveTorSettings(s) {
  const clean = {
    enabled: true,
    bridgeMode: TOR_BRIDGE_MODES.includes(s.bridgeMode) ? s.bridgeMode : 'auto',
    customBridges: String(s.customBridges || '').slice(0, 8000),
    forceTorTest: !!s.forceTorTest,
    keepReserve: s.keepReserve !== false,
  };
  await EncryptedStorage.setItem(SETTINGS_KEY, JSON.stringify(clean));
  cachedSettings = clean;
  return clean;
}

// Eigene Bridge-Zeilen pruefen: nur bekannte Transporte, keine Steuerzeichen.
// Akzeptiert auch die von bridges.torproject.org kopierte Form mit
// vorangestelltem "Bridge ".
export function parseCustomBridges(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim().replace(/^Bridge\s+/i, ''))
    .filter(l => /^(obfs4|snowflake|meek_lite|webtunnel)\s+\S+/.test(l) && l.length < 2000 && !/[\x00-\x1f]/.test(l));
}

export function bridgesForMode(mode, customBridges) {
  switch (mode) {
    case 'none': return [];
    case 'snowflake': return TOR_BUILTIN_BRIDGES.snowflake;
    case 'obfs4': return TOR_BUILTIN_BRIDGES.obfs4;
    case 'meek': return TOR_BUILTIN_BRIDGES.meek;
    case 'custom': return parseCustomBridges(customBridges);
    default: return [];
  }
}

// ── Start / Stopp ──────────────────────────────────────────────────────────
let startPromise = null;

export function ensureTorRunning() {
  if (!Tor) return Promise.resolve(false);
  if (state.status === 'ON') return Promise.resolve(true);
  if (startPromise) return startPromise;
  startPromise = (async () => {
    try {
      const settings = await loadTorSettings();
      if (!settings.enabled) { setState({ status: 'OFF', progress: 0, message: 'ausgeschaltet' }); return false; }
      let sequence;
      if (settings.bridgeMode === 'auto') {
        const last = await EncryptedStorage.getItem(LAST_MODE_KEY).catch(() => null);
        const noneFailedAt = Number(await EncryptedStorage.getItem(NONE_FAILED_AT_KEY).catch(() => null)) || 0;
        const noneRecentlyFailed = Date.now() - noneFailedAt < NONE_RETRY_AFTER_MS;
        // Reihenfolge: ohne Bridges zuerst (schnellster Weg), ausser es scheiterte
        // kuerzlich - dann der zuletzt funktionierende Bridge-Weg zuerst.
        const first = noneRecentlyFailed ? last : 'none';
        sequence = [...AUTO_SEQUENCE].sort((a, b) => (a.mode === first ? -1 : b.mode === first ? 1 : 0));
      } else {
        sequence = [{ mode: settings.bridgeMode, timeoutMs: 180000 }];
      }
      for (const step of sequence) {
        const bridges = bridgesForMode(step.mode, settings.customBridges);
        if (step.mode === 'custom' && bridges.length === 0) {
          setState({ status: 'ERROR', message: t('tor.err.noCustomBridges') });
          return false;
        }
        setState({ status: 'STARTING', progress: 0, mode: step.mode, message: null });
        try {
          const onionKey = await EncryptedStorage.getItem(ONION_KEY_KEY).catch(() => null);
          const res = await Tor.start({ bridges, onionKey: onionKey || null, bootstrapTimeoutMs: step.timeoutMs });
          if (res.onionKey) await EncryptedStorage.setItem(ONION_KEY_KEY, res.onionKey);
          if (!ONION_RE.test(res.onion)) throw new Error('Ungueltige eigene Onion-Adresse');
          lastKnownOnion = res.onion;
          setState({ status: 'ON', progress: 100, onion: res.onion, mode: step.mode, message: null,
            socksPort: Number.isInteger(res.socksPort) && res.socksPort > 0 ? res.socksPort : null });
          await EncryptedStorage.setItem(LAST_MODE_KEY, step.mode).catch(() => {});
          if (step.mode === 'none') await EncryptedStorage.removeItem(NONE_FAILED_AT_KEY).catch(() => {});
          console.log('[Tor] ✅ Verbunden (' + (step.mode === 'none' ? 'ohne Bridges' : 'Bridges: ' + step.mode) + ')');
          announceOwnOnion();
          scheduleSelfTest(SELFTEST_AFTER_START_MS);
          startWatchdog();
          return true;
        } catch (e) {
          console.warn('[Tor] Start mit', step.mode, 'fehlgeschlagen:', e?.message || e);
          if (step.mode === 'none' && settings.bridgeMode === 'auto') {
            await EncryptedStorage.setItem(NONE_FAILED_AT_KEY, String(Date.now())).catch(() => {});
          }
        }
      }
      setState({ status: 'ERROR', progress: 0, message: t('tor.err.unreachable') });
      return false;
    } finally {
      startPromise = null;
    }
  })();
  return startPromise;
}

export async function stopTor() {
  if (!Tor) return;
  stopWatchdog();
  // Schliesst ueber TorChannel.onclose auch die zugehoerigen WebRTCManager
  // (siehe WebRTCManager channel.onclose) - keine weiterlaufenden Zombies.
  for (const ch of [...channels.values()]) ch.close();
  await Tor.stop().catch(() => {});
  setState({ status: 'OFF', progress: 0, onion: null, message: null, reachable: false, socksPort: null });
}

// tor laeuft in einem eigenen Prozess (MalachiTorProcessService) und darf
// jederzeit frisch gestartet werden. Neustarts laufen nacheinander, nie parallel.
let restartChain = Promise.resolve();
export function restartTor() {
  const p = restartChain.then(async () => {
    if (startPromise) await startPromise.catch(() => {});
    // Vor dem Stoppen fragen, ob die Wachen auffaellig viele Kreise verlieren
    // (Pfad-Bias-Warnungen) - dann beim Neustart neue waehlen lassen.
    const freshGuards = await shouldResetGuards().catch(() => false);
    await stopTor();
    if (freshGuards) {
      const ok = await Tor?.resetGuards?.().catch(() => false);
      if (ok) {
        await EncryptedStorage.setItem(GUARD_RESET_KEY, String(Date.now())).catch(() => {});
        console.warn('[Tor] Einstiegsknoten verlieren viele Verbindungen - waehle neue');
      }
    }
    return ensureTorRunning();
  });
  restartChain = p.catch(() => {});
  return p;
}

// Eigene Onion-Adresse allen aktuell (egal wie) verbundenen Kontakten
// mitteilen - z.B. wenn Tor erst nach dem Verbindungsaufbau fertig wurde.
function announceOwnOnion() {
  const onion = getOwnOnion();
  if (!onion) return;
  for (const rtc of RTCStore.connections.values()) {
    if (rtc?.keyExchangeDone && typeof rtc.sendMessage === 'function') {
      try { rtc.sendMessage(JSON.stringify({ type: 'system', subtype: 'tor_address', onion })); } catch {}
    }
  }
}
RTCStore.ownTorAddressProvider = getOwnOnion;

// ── Tor-Kanal: verhaelt sich fuer WebRTCManager wie ein RTCDataChannel ─────
const channels = new Map();   // connId -> TorChannel
const pending = new Map();    // connId -> { onLine, onClose }  (waehrend der Anmeldung)
// Telefonnummer-Kopplung (PhonePairing.js): wer Verbindungen am
// voruebergehenden Treffpunkt-Dienst annimmt - nur waehrend einer Kopplung.
let rendezvousIncomingHandler = null;

// tunnel (nur Telefonnummer-Kopplung, PhonePairing.js): { seal(text) -> Zeile,
// open(Zeile) -> text | undefined (Steuerzeile, verworfen) | null (nicht
// entschluesselbar), wipe() } - jede Zeile ist dann zusaetzlich mit dem beim
// Treffpunkt ausgehandelten Tunnelschluessel verschluesselt. Eine nicht
// entschluesselbare Zeile beendet den Kanal; beim Schliessen werden die
// Tunnelschluessel geloescht. Ohne tunnel unveraendert wie bisher.
export class TorChannel {
  constructor(connId, tunnel = null) {
    this.connId = connId;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this._lastRx = Date.now();
    this._tunneled = !!tunnel;
    this._tunnel = tunnel;
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('Tor-Kanal geschlossen');
    const line = this._tunneled ? this._tunnel.seal(String(data)) : String(data);
    Tor.send(this.connId, line).catch(() => this._remoteClosed());
  }
  _deliver(line) {
    let data = line;
    if (this._tunneled) {
      if (!this._tunnel) return;
      data = this._tunnel.open(line);
      if (data === undefined) return;
      if (data === null) {
        console.warn('[Tor] Tunnel-Zeile nicht entschluesselbar - Kanal wird geschlossen');
        this.close();
        return;
      }
    }
    this.onmessage?.({ data });
  }
  _wipeTunnel() {
    const t = this._tunnel;
    this._tunnel = null;
    if (t) { try { t.wipe?.(); } catch {} }
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    channels.delete(this.connId);
    try { Tor.close(this.connId); } catch {}
    this._wipeTunnel();
    const cb = this.onclose;
    if (cb) cb();
  }
  _remoteClosed() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this._closedByRemote = true;
    channels.delete(this.connId);
    this._wipeTunnel();
    const cb = this.onclose;
    if (cb) cb();
  }
}

if (emitter) {
  emitter.addListener('MalachiTorLine', ({ connId, line }) => {
    const ch = channels.get(connId);
    if (ch) { ch._lastRx = Date.now(); ch._deliver(line); return; }
    pending.get(connId)?.onLine(line);
  });
  emitter.addListener('MalachiTorClosed', ({ connId }) => {
    channels.get(connId)?._remoteClosed();
    pending.get(connId)?.onClose();
  });
  emitter.addListener('MalachiTorIncoming', ({ connId }) => { handleIncoming(connId); });
  // Telefonnummer-Kopplung: Verbindung am voruebergehenden Treffpunkt-Dienst
  // (nativ addRendezvousOnion). Geht NICHT durch die normale Anmeldung,
  // sondern an PhonePairing.js; ohne laufende Kopplung sofort schliessen.
  emitter.addListener('MalachiTorRendezvousIncoming', ({ connId, onion }) => {
    const h = rendezvousIncomingHandler;
    if (!h || !ONION_RE.test(onion || '')) { try { Tor.close(connId); } catch {} return; }
    try { h(connId, onion); } catch { try { Tor.close(connId); } catch {} }
  });
  // Onion-Beschreibung eines Kontakts ist eingetroffen (nativ aus HS_DESC
  // RECEIVED): BackgroundSync startet fuer noch nicht verbundene Kontakte mit
  // dieser Adresse sofort einen frischen Versuch.
  emitter.addListener('MalachiTorDescReceived', ({ onion }) => {
    if (!ONION_RE.test(onion || '')) return;
    descReceivedAt.set(onion, Date.now());
    try { hooks.onDescriptorReceived?.(onion); } catch {}
    for (const fn of [...(descWaiters.get(onion) || [])]) { try { fn(); } catch {} }
  });
  emitter.addListener('MalachiTorStatus', ({ status, progress, message }) => {
    if (status === 'STARTING') setState({ status: 'STARTING', progress: progress >= 0 ? progress : state.progress, message: message || null });
    else if (status === 'OFF' && state.status === 'ON') setState({ status: 'OFF', onion: null, message: message || null });
  });
}

// ── Gegenseitige Anmeldung ─────────────────────────────────────────────────
const utf8 = (s) => Buffer.from(String(s), 'utf8');
function authMac(secretB64, role, parts) {
  const key = hkdf(sha256, Buffer.from(secretB64, 'base64'), undefined, utf8('malachi-tor-auth-v1'), 32);
  return Buffer.from(hmac(sha256, key, utf8([role, ...parts].join('|')))).toString('base64');
}
export function _authMacForTests(secretB64, role, parts) { return authMac(secretB64, role, parts); }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function findContact(id) {
  try {
    const saved = await EncryptedStorage.getItem('contacts');
    const cs = saved ? JSON.parse(saved) : [];
    return cs.find(c => c && c.id === id && !c.wiped) || null;
  } catch { return null; }
}

async function secretCandidates(id) {
  const c = RTCStore.getSecretCandidates(id);
  if (c.length) return c;
  const stored = await EncryptedStorage.getItem('shared_secret_' + id).catch(() => null);
  const prev = await EncryptedStorage.getItem('shared_secret_prev_' + id).catch(() => null);
  return [stored, prev].filter(Boolean);
}

const pendingIncoming = new Set();   // eingehend, noch nicht angemeldet

// Nach gueltiger Anmeldung: volles Zeilenlimit im nativen Teil (vorher 8 KB).
export function trustTorConnection(connId) {
  try { Tor?.trustConnection?.(connId); } catch {}
}

const isNonce = (n) => typeof n === 'string' && n.length >= 16 && n.length <= 64;

// Serverseite: jemand hat sich mit unserer Onion-Adresse verbunden.
async function handleIncoming(connId) {
  if (!state.onion || pendingIncoming.size >= MAX_PENDING_INCOMING) {
    if (state.onion) console.warn('[Tor] Zu viele unangemeldete Verbindungen - neue abgelehnt');
    try { Tor.close(connId); } catch {}
    return;
  }
  pendingIncoming.add(connId);
  const nonceS = await secureRandomToken(24);
  let finished = false;
  const fail = (why) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    pending.delete(connId);
    pendingIncoming.delete(connId);
    try { Tor.close(connId); } catch {}
    console.warn('[Tor] Eingehende Verbindung abgelehnt:', why);
  };
  const timer = setTimeout(() => fail('Zeitlimit'), AUTH_TIMEOUT_MS);
  pending.set(connId, {
    onClose: () => { if (!finished) { finished = true; clearTimeout(timer); pending.delete(connId); pendingIncoming.delete(connId); } },
    onLine: async (line) => {
      if (finished) return;
      const p = pending.get(connId);
      if (p) p.onLine = () => {};     // nur genau EINE Anmeldezeile
      let msg;
      try { msg = JSON.parse(line); } catch { return fail('kein JSON'); }
      if (msg?.t === 'malachi-tor' && msg.step === 'pair') {
        // Erstkopplung ueber Tor (siehe registerPairingInvite).
        if (typeof msg.token !== 'string' || !/^[0-9A-F]{8}$/.test(msg.token) || !isNonce(msg.nonce) || typeof msg.mac !== 'string') {
          return fail('ungueltige Kopplungsanfrage');
        }
        const invite = pairingInvites.get(msg.token);
        if (!invite || Date.now() > invite.expires) return fail('keine offene Einladung');
        const myOnionP = state.onion;
        if (!safeEqual(authMac(invite.pskB64, 'pair-client', [myOnionP, nonceS, msg.nonce, msg.token]), msg.mac)) {
          return fail('Kopplung: Einladungsgeheimnis falsch');
        }
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        pending.delete(connId);
        pendingIncoming.delete(connId);
        trustTorConnection(connId);
        // Einladung ist einmalig. Scheitert die Sitzung aber noch VOR dem
        // fertigen Schluesseltausch (Tor-Verbindung reisst ab), wird sie wieder
        // freigegeben - sonst koennte der Kontakt es nicht erneut versuchen und
        // muesste eine neue Einladung holen (Folge im Live-Test: doppelte
        // "Neuer Kontakt"-Eintraege).
        pairingInvites.delete(msg.token);
        const restore = () => restorePairingInvite(msg.token, invite);
        try {
          await Tor.send(connId, JSON.stringify({ t: 'malachi-tor', step: 'pair-ok', mac: authMac(invite.pskB64, 'pair-server', [myOnionP, nonceS, msg.nonce, msg.token]) }));
        } catch { try { Tor.close(connId); } catch {} restore(); return; }
        console.log('[Tor] ✅ Kopplung ueber Tor angenommen');
        attachPairingSession(connId, invite.contactId, false, (rtc) => { invite.used = true; invite.onPaired?.(rtc); }, restore);
        return;
      }
      if (!msg || msg.t !== 'malachi-tor' || msg.step !== 'auth' || typeof msg.id !== 'string'
          || msg.id.length > 128 || !isNonce(msg.nonce) || typeof msg.mac !== 'string') return fail('ungueltige Anmeldung');
      // Mehrere MACs erlaubt (aktueller + vorheriger Schluessel des Clients,
      // siehe connectViaTor) - hoechstens 3, sonst ungueltig.
      const macs = Array.isArray(msg.macs) ? msg.macs.filter(m => typeof m === 'string').slice(0, 3) : [msg.mac];
      if (!macs.includes(msg.mac)) macs.unshift(msg.mac);
      const contact = await findContact(msg.id);
      if (!contact) return fail('unbekannter Kontakt');
      const myOnion = state.onion;
      const cands = await secretCandidates(msg.id);
      const secret = cands.find(s => { const exp = authMac(s, 'client', [myOnion, nonceS, msg.nonce, msg.id]); return macs.some(m => safeEqual(exp, m)); });
      if (!secret) return fail('Anmeldung ungueltig');
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending.delete(connId);
      pendingIncoming.delete(connId);
      trustTorConnection(connId);
      try {
        await Tor.send(connId, JSON.stringify({ t: 'malachi-tor', step: 'ok', mac: authMac(secret, 'server', [myOnion, nonceS, msg.nonce, msg.id]) }));
      } catch { try { Tor.close(connId); } catch {} return; }
      console.log('[Tor] ✅ Eingehende Verbindung angemeldet:', contact.name);
      // fresh: die Gegenseite hatte beim Anmelden selbst keine Verbindung zu
      // uns - eine hier noch bestehende ist dann tot (siehe attachSession).
      attachSession(connId, contact, false, { peerFresh: msg.fresh === true });
    },
  });
  Tor.send(connId, JSON.stringify({ t: 'malachi-tor', v: 1, step: 'challenge', nonce: nonceS })).catch(() => fail('senden'));
}

// Clientseite: zum Kontakt ueber dessen Onion-Adresse verbinden.
export async function connectViaTor(contact, callbacks = {}) {
  if (!Tor) return null;
  if (!getOwnOnion()) { console.log('[Tor] Verbindung zu', contact?.name, 'nicht moeglich: Tor noch nicht bereit (' + state.status + ')'); return null; }
  if (!ONION_RE.test(contact?.torOnion || '')) { console.log('[Tor] Verbindung zu', contact?.name, 'nicht moeglich: keine Tor-Adresse bekannt'); return null; }
  const cands = await secretCandidates(contact.id);
  if (!cands.length) { console.log('[Tor] Verbindung zu', contact?.name, '(' + String(contact?.id).slice(0, 10) + ') nicht moeglich: kein Schluessel (RAM:', !!RTCStore.getSharedSecret(contact.id), ')'); return null; }
  // Alle bekannten Schluessel (aktueller + vorheriger) anbieten - nach
  // schnell aufeinanderfolgenden Schluesselwechseln (Direkt + Tor-Reserve)
  // kann die Gegenseite gerade noch den anderen als aktuell fuehren.
  const secrets = cands.slice(0, 3);
  const nonceC = await secureRandomToken(24);
  let connId;
  torConnectsInFlight++;
  try {
    connId = Tor.connectWithTimeout
      ? await Tor.connectWithTimeout(contact.torOnion, TOR_VIRTUAL_PORT, callbacks.timeoutMs || TOR_CONNECT_TIMEOUT_MS)
      : await Tor.connect(contact.torOnion, TOR_VIRTUAL_PORT);
    torConnectsInFlight--;
    lookupFailures.delete(contact.torOnion);
    refreshedOnions.delete(contact.torOnion);
  } catch (e) {
    torConnectsInFlight--;
    const why = String(e?.message || e);
    console.log('[Tor] Kontakt ueber Tor nicht erreichbar:', contact.name, '-', why);
    // Zweimal hintereinander "Onion-Beschreibung nicht gefunden" (tor-Fehler
    // F0): tor hat sich das evtl. gemerkt (Abfrage kam vor der
    // Veroeffentlichung, z.B. nach einem Neustart der Gegenseite) und fragt bis
    // zu 15 min nicht neu - dann, sehr vorsichtig dosiert, die Suche
    // zuruecksetzen. Zeitueberschreitungen und gescheiterte Einfuehrungen
    // loest tor selbst (neue Kreise/Beschreibung) - kein Grund fuer NEWNYM.
    // Kurz nach einem Netzwechsel (tor ohne Neustart, Beschreibungen und
    // gemerkte Fehlschlaege aus dem alten Netz bleiben erhalten) zaehlen auch
    // gescheiterte Einfuehrung/Treffpunkt - und schon der erste Fehlschlag.
    const afterNetChange = Date.now() - lastNetChangeAt < NETCHANGE_LOOKUP_WINDOW_MS;
    if (LOOKUP_NOT_FOUND_RE.test(why) || (afterNetChange && LOOKUP_STALE_RE.test(why))) {
      const n = (lookupFailures.get(contact.torOnion) || 0) + 1;
      lookupFailures.set(contact.torOnion, n);
      if (n >= (afterNetChange ? 1 : 2)) maybeRefreshLookups(contact.torOnion);
    }
    // Und in jedem Fall die Beschreibung GENAU dieses Kontakts gezielt neu
    // holen (HSFETCH, ohne Nebenwirkungen auf andere Verbindungen) - die
    // Gegenseite ist evtl. neu gestartet und hat neue Einstiegspunkte. Trifft
    // die neue Beschreibung ein, startet BackgroundSync sofort einen Versuch.
    maybeRefetchDescriptor(contact.torOnion);
    // KEIN NEWNYM mehr an dieser Stelle (Live-Test 2026-10-17): NEWNYM leert
    // den Onion-Zwischenspeicher und bricht dabei ALLE gerade laufenden
    // Onion-Verbindungsaufbauten ab. Scheiterten Versuche zu anderen (z.B.
    // veralteten) Kontakten, feuerte es im Sekundentakt und kappte jede
    // Kopplung mitten im Aufbau. Veraltete Beschreibungen holt tor selbst neu,
    // wenn die Einstiegspunkte nicht antworten.
    try { callbacks.onFail?.('nicht erreichbar'); } catch {}
    return null;
  }
  return new Promise((resolve) => {
    let nonceS = null;
    let authSent = false;
    let finished = false;
    const done = (rtc, why) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending.delete(connId);
      if (!rtc) {
        try { Tor.close(connId); } catch {}
        console.warn('[Tor] Anmeldung beim Kontakt fehlgeschlagen:', why);
        try { callbacks.onFail?.(why); } catch {}
      }
      resolve(rtc);
    };
    const timer = setTimeout(() => done(null, 'Zeitlimit'), AUTH_TIMEOUT_MS);
    pending.set(connId, {
      // Schliesst die Gegenseite direkt nach unserer Anmeldung, kennt sie uns
      // nicht (mehr) - z.B. weil sie den Kontakt geloescht oder neu gekoppelt
      // hat. Der Aufrufer wartet dann deutlich laenger bis zum naechsten
      // Versuch: jede abgelehnte Anmeldung zaehlt bei der Gegenseite als
      // Fehlversuch und kann sie fuer ALLE Kontakte kurz sperren.
      onClose: () => done(null, authSent ? 'abgelehnt' : 'Verbindung geschlossen'),
      onLine: (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return done(null, 'kein JSON'); }
        if (msg?.t !== 'malachi-tor') return done(null, 'fremdes Protokoll');
        if (msg.step === 'challenge' && nonceS === null) {
          if (!isNonce(msg.nonce)) return done(null, 'ungueltige Nonce');
          nonceS = msg.nonce;
          Tor.send(connId, JSON.stringify({
            t: 'malachi-tor', step: 'auth', id: contact.id, nonce: nonceC,
            mac: authMac(secrets[0], 'client', [contact.torOnion, nonceS, nonceC, contact.id]),
            macs: secrets.map(sec => authMac(sec, 'client', [contact.torOnion, nonceS, nonceC, contact.id])),
            // Keine nutzbare Verbindung zu diesem Kontakt auf unserer Seite -
            // eine bei der Gegenseite noch eingetragene ist tot (Netzwechsel).
            // Nur ein Hinweis fuer die Auswahl doppelter Kanaele, keine
            // Sicherheitsfunktion (die Anmeldung selbst bleibt unveraendert).
            fresh: !hasUsableConnection(contact.id),
          })).catch(() => done(null, 'senden'));
          authSent = true;
          return;
        }
        if (msg.step === 'ok' && nonceS !== null) {
          const okServer = secrets.some(sec => safeEqual(authMac(sec, 'server', [contact.torOnion, nonceS, nonceC, contact.id]), msg.mac));
          if (!okServer) return done(null, 'Gegenseite nicht authentisch');
          pending.delete(connId);
          console.log('[Tor] ✅ Beim Kontakt angemeldet:', contact.name);
          done(attachSession(connId, contact, true, callbacks), null);
          return;
        }
        return done(null, 'unerwarteter Schritt');
      },
    });
  });
}

// Nach erfolgreicher Anmeldung: dieselbe Sitzungslogik wie beim direkten
// Kanal (Kyber, Verschluesselung, Warteschlange) ueber den Tor-Kanal.
const TOR_DOUBLE_DIAL_WINDOW_MS = 30000;
// Juenger als das gilt ein bestehender, von der GEGENSEITE nicht selbst
// aufgebauter Kanal noch als "gleichzeitig gewaehlt" (beide Seiten waehlen
// fast gleichzeitig) - aelter meldet ein fresh-Neuaufbau zuverlaessig einen
// toten Kanal.
const TOR_FRESH_REPLACE_MIN_AGE_MS = 10000;

function hasUsableConnection(contactId) {
  const r = RTCStore.connections.get(contactId);
  return !!r && !r._closed && RTCStore.isConnected(contactId) && r.keyExchangeDone !== false;
}

// Eine Direktverbindung, die gerade per ICE-Neustart auf ein neues Netz
// umzieht (DirectUpgrade.js), zaehlt weiter als lebendig - sonst wuerde ein
// gleichzeitig ankommender Tor-Kanal genau diese Verbindung verdraengen.
function directStillAlive(existing, contactId) {
  if (!existing || existing.transport === 'tor' || existing._closed) return false;
  if (existing.keyExchangeDone === false) return false;
  return RTCStore.isConnected(contactId) || Date.now() < (existing._iceRestartUntil || 0);
}

function attachSession(connId, contact, isInitiator, { onConnected, onDisc, peerFresh = false } = {}) {
  const channel = new TorChannel(connId);
  channels.set(connId, channel);
  let connectedOnce = false;
  const rtc = new WebRTCManager(
    () => {},
    () => {
      if (connectedOnce) return;
      connectedOnce = true;
      const existing = RTCStore.connections.get(contact.id);
      // Eine funktionierende Direktverbindung hat immer Vorrang - der
      // Tor-Kanal wird dann zur Reserve (sofortiges Umschalten, falls die
      // Direktverbindung wegbricht) oder, ohne Reserve-Wunsch, geschlossen.
      if (existing && existing !== rtc && directStillAlive(existing, contact.id)) {
        if (isTorReserveEnabled()) {
          keepAsReserve(contact.id, rtc);
        } else {
          console.log('[Tor] Direktverbindung steht bereits - Tor-Kanal wird nicht gebraucht');
          rtc.close();
        }
        return;
      }
      // Nur eine Verbindung mit fertigem Schluesseltausch zaehlt - eine
      // haengende darf Tor nicht blockieren.
      const existingTor = existing && existing !== rtc && existing.transport === 'tor' && !existing._closed
        && RTCStore.isConnected(contact.id) && existing.keyExchangeDone !== false ? existing : null;
      if (existingTor) {
        const age = Date.now() - (existingTor._torEstablishedAt || 0);
        const sameDialer = !!existingTor._torClientOnion && existingTor._torClientOnion === rtc._torClientOnion;
        if (rtc._peerFresh && (sameDialer || age > TOR_FRESH_REPLACE_MIN_AGE_MS)) {
          // Live-Test Okt. 2026 ("alte Tor-Verbindung bleibt nach Netzwechsel
          // haengen"): die Gegenseite hat das Netz gewechselt, ihr Tor neu
          // gestartet und baut neu auf - bei uns hing aber noch ihr alter,
          // toter Kanal. War der juenger als 30 s, wurde der NEUE verworfen und
          // der tote erst nach 15 s Stille geschlossen. Jetzt meldet die
          // Gegenseite beim Anmelden, dass sie selbst keine Verbindung zu uns
          // hat: der neue Kanal wird sofort aktiv. Der bisherige wird nicht
          // geschlossen, sondern wartet als Reserve - war er doch ein noch
          // lebender Parallel-Versuch der Gegenseite, schliesst sie selbst den
          // ueberzaehligen, und beide Seiten landen auf demselben Kanal.
          console.log('[Tor] Gegenseite baut ohne bestehende Verbindung neu auf - neuer Tor-Kanal wird aktiv, der bisherige wartet als Reserve');
          RTCStore.connections.delete(contact.id);
          keepAsReserve(contact.id, existingTor);
        } else if (age <= TOR_DOUBLE_DIAL_WINDOW_MS) {
          // Parallele Versuche derselben Seite (z.B. nach Netzwechsel, siehe
          // BackgroundSync.reconnectAllViaTorNow): der erste bleibt.
          if (sameDialer) {
            console.log('[Tor] Weiterer paralleler Tor-Kanal zum selben Kontakt - der bestehende bleibt');
            rtc.close();
            return;
          }
          // Beide Seiten haben gleichzeitig aufgebaut: auf BEIDEN Geraeten
          // bleibt derselbe Kanal - der, dessen aufbauende Seite die
          // alphabetisch kleinere Onion-Adresse hat.
          if (existingTor._torClientOnion && existingTor._torClientOnion < rtc._torClientOnion) {
            console.log('[Tor] Zweiter Tor-Kanal zum selben Kontakt - der bestehende bleibt');
            rtc.close();
            return;
          }
        }
        // Sonst (bestehender Kanal aelter als 30 s): die Gegenseite baut nicht
        // gleichzeitig, sondern neu auf, weil ihr alter Kanal tot ist - der
        // neue ersetzt ihn (RTCStore.setConnection schliesst den alten).
      }
      rtc._torEstablishedAt = Date.now();
      if (RTCStore.connections.get(contact.id) && RTCStore.connections.get(contact.id) !== rtc) {
        console.log('[Tor] Neuer Tor-Kanal ersetzt die bisherige Verbindung');
      }
      RTCStore.setConnection(contact.id, rtc);
      onConnected?.(rtc);
    },
    () => {
      const wasReserve = reserves.get(contact.id) === rtc;
      if (wasReserve) reserves.delete(contact.id);
      // Die Gegenseite hat die Tor-Reserve geschlossen: ihre App oder ihr tor
      // startet vermutlich gerade neu - die Direktverbindung dorthin sofort
      // pruefen statt erst nach der normalen Stille-Frist (Live-Test
      // 2026-10-17: 10 s). Eigenes Schliessen (z.B. beim eigenen Netzwechsel)
      // loest das nicht aus.
      if (wasReserve && channel._closedByRemote) {
        const active = RTCStore.connections.get(contact.id);
        if (active && active !== rtc && active.transport !== 'tor') {
          try { active.probeNow?.('Tor-Reserve von der Gegenseite geschlossen'); } catch {}
        }
      }
      if (RTCStore.connections.get(contact.id) === rtc) {
        RTCStore.connections.delete(contact.id);
        // Wartet eine weitere angemeldete Tor-Sitzung als Reserve, sofort
        // uebernehmen statt auf den naechsten Verbindungszyklus zu warten.
        promoteTorReserve(contact.id);
      }
      onDisc?.();
    },
  );
  rtc.chatId = contact.id;
  channel._rtc = rtc;
  rtc._torClientOnion = isInitiator ? (state.onion || '') : (contact.torOnion || '');
  rtc._peerFresh = !isInitiator && !!peerFresh;
  if (hooks.flushQueue) rtc._onReady = () => hooks.flushQueue(contact.id, rtc);
  rtc.attachTorChannel(channel, isInitiator);
  return rtc;
}

// ── Tor-Reserve ────────────────────────────────────────────────────────────
// Solange eine Direktverbindung laeuft, bleibt eine angemeldete Tor-Sitzung
// (Schluesseltausch fertig) als Reserve offen. Bricht direkt weg, wird sie
// sofort aktiv - ohne 7-15 s Neuaufbau ueber Tor. Kostet etwas Akku
// (Lebenszeichen alle 5 s), deshalb abschaltbar. Ausserdem traegt sie nach
// dem Wechsel auf direkt (DirectUpgrade.js) den naechsten Upgrade-Versuch.
const reserves = new Map();   // contactId -> WebRTCManager (Tor)
// Hat die aktive Direktverbindung in dieser Zeit noch etwas von der
// Gegenseite empfangen, ist sie nicht tot (Lebenszeichen alle 2 s).
const RESERVE_SWITCH_SILENCE_MS = 3500;

function keepAsReserve(contactId, rtc) {
  const old = reserves.get(contactId);
  if (old && old !== rtc) { try { old.close(); } catch {} }
  reserves.set(contactId, rtc);
  // Kommt auf der Reserve eine echte Nachricht an, nutzt die Gegenseite sie
  // bereits als aktive Verbindung (ihre Direktverbindung ist weg, z.B. nach
  // einem Netzwechsel) - dann sofort uebernehmen und die Nachricht zustellen,
  // statt sie bis zur eigenen Abbruch-Erkennung zu verlieren. (Fuellpakete
  // filtert WebRTCManager vorher heraus.)
  rtc.onMessage = (msg) => {
    if (reserves.get(contactId) !== rtc) return;
    const active = RTCStore.connections.get(contactId);
    // Liefert die aktive Direktverbindung nachweislich noch Daten, hat die
    // Gegenseite nur kurz vor ihrem eigenen Wechsel noch ueber Tor gesendet
    // (Wechsel Tor -> direkt, DirectUpgrade.js): Nachricht normal zustellen,
    // aber NICHT zurueck auf Tor schalten - das wuerde die gerade
    // ausgehandelte Direktverbindung wieder schliessen.
    if (active && active !== rtc && active.transport !== 'tor' && !active._closed
        && Date.now() - (active._lastActivity || 0) < RESERVE_SWITCH_SILENCE_MS
        && typeof active.onMessage === 'function') {
      active.onMessage(msg);
      return;
    }
    console.log('[Tor] Gegenseite nutzt die Tor-Reserve - wird aktiv');
    const p = promoteTorReserve(contactId);
    if (p && typeof p.onMessage === 'function') p.onMessage(msg);
  };
  console.log('[Tor] Tor-Reserve bereit');
}
export function hasTorReserve(contactId) {
  const r = reserves.get(contactId);
  return !!(r && !r._closed && r.dataChannel?.readyState === 'open');
}
// Direktverbindung ist weg: Reserve sofort zur aktiven Verbindung machen.
const RESERVE_VERIFY_MS = 12000;
export function promoteTorReserve(contactId) {
  const r = reserves.get(contactId);
  if (!r || r._closed || r.dataChannel?.readyState !== 'open' || !r.keyExchangeDone) {
    if (r && (r._closed || r.dataChannel?.readyState !== 'open')) reserves.delete(contactId);
    return null;
  }
  reserves.delete(contactId);
  RTCStore.setConnection(contactId, r);
  console.log('[Tor] ✅ Aktive Verbindung weg - Tor-Reserve sofort uebernommen');
  // Die Reserve kann selbst tot sein (Gegenseite hat das Netz gewechselt -
  // Tor kappt dabei alle Kreise, ohne dass wir es merken). Die Gegenseite
  // sendet mindestens alle 10 s etwas; kommt nach der Uebernahme binnen
  // RESERVE_VERIFY_MS nichts, sofort schliessen statt 40 s zu warten.
  const promotedAt = Date.now();
  const verify = setTimeout(() => {
    if (r._closed || RTCStore.connections.get(contactId) !== r) return;
    if ((r._lastActivity || 0) >= promotedAt) return;
    console.warn('[Tor] Uebernommene Tor-Reserve antwortet nicht - wird verworfen');
    try { r._fireDisc?.(); } catch {}
    try { r.close(); } catch {}
  }, RESERVE_VERIFY_MS);
  verify?.unref?.();
  // Schluesseltausch ist laengst fertig, _onKeyExchange feuert nicht erneut:
  // wartende Nachrichten hier selbst losschicken.
  if (hooks.flushQueue) hooks.flushQueue(contactId, r).catch?.(() => {});
  // BackgroundSync: UI-Verweis aktualisieren, spaeter erneut direkt versuchen.
  try { hooks.onReservePromoted?.(contactId, r); } catch {}
  return r;
}
// Direktverbindung ist (wieder) da: aktive Tor-Verbindung nicht schliessen,
// sondern zur Reserve machen.
export function demoteActiveTorToReserve(contactId) {
  const cur = RTCStore.connections.get(contactId);
  if (!cur || cur.transport !== 'tor' || cur._closed) return false;
  if (!isTorReserveEnabled()) return false;
  RTCStore.connections.delete(contactId);
  keepAsReserve(contactId, cur);
  return true;
}
// Netzwechsel: alle Reserven sind tot (Tor kappt dabei alle Kreise).
export function dropAllTorReserves() {
  for (const id of [...reserves.keys()]) dropTorReserve(id);
}
export function dropTorReserve(contactId) {
  const r = reserves.get(contactId);
  reserves.delete(contactId);
  if (r) { try { r.close(); } catch {} }
}

// Wipe/Kontakt loeschen (RTCStore.resetAll/clearContact): auch Reserven und
// Tor-Sitzungen ausserhalb von RTCStore.connections schliessen - mit Grund
// 'wipe', damit ein gerade laufender Schluesseltausch sein Secret nicht nach
// dem Loeschen wieder speichert (siehe WebRTCManager).
RTCStore.onWipe((chatId) => {
  for (const [id, r] of [...reserves.entries()]) {
    if (chatId && id !== chatId) continue;
    reserves.delete(id);
    try { r.close('wipe'); } catch {}
  }
  for (const ch of [...channels.values()]) {
    const r = ch._rtc;
    if (!r || (chatId && r.chatId !== chatId)) continue;
    try { r.close('wipe'); } catch {}
  }
});

// ── Erstkopplung ueber Tor ─────────────────────────────────────────────────
// Einziger Kopplungsweg (es gibt keinen Treffpunkt-Server mehr): das
// scannende Handy verbindet sich ueber die Onion-Adresse des Einladenden, die
// im QR-Code/Link mitreist. Angemeldet wird mit dem Einmal-Geheimnis (PSK)
// aus dem QR-Code - wer den Code nicht hat, kommt nicht weiter. Danach wie
// immer: Kyber-Schluesseltausch ueber den Kanal. Erst wenn der fertig ist,
// wird der Kontakt angelegt (onPaired). Jede Einladung funktioniert genau
// einmal und laeuft ab.
const PAIRING_INVITE_TTL_MS = 30 * 60 * 1000;
const pairingInvites = new Map();   // token -> { pskB64, contactId, onPaired, expires }

/**
 * Beim Loeschen aller Daten (Audit 2026-10-19, P4): tor stoppen, offene
 * Einladungen verwerfen und tors Daten (Wachen, torrc mit Bridges,
 * PT-Zustand) entfernen. Danach entsteht beim Einrichten eine NEUE
 * Onion-Identitaet - die alte ist mit dem verschluesselten Speicher geloescht
 * und wird auch nicht mehr veroeffentlicht.
 */
export async function wipeTorForReset() {
  for (const inv of pairingInvites.values()) inv.cancelled = true;
  pairingInvites.clear();
  await stopTor().catch(() => {});
  await Tor?.wipeData?.().catch(() => false);
}

/** Nur fuer Tests: Anzahl offener Einladungen. */
export function _pairingInviteCountForTests() { return pairingInvites.size; }

export function registerPairingInvite(token, { pskB64, contactId, onPaired }) {
  if (!/^[0-9A-F]{8}$/.test(token || '') || !pskB64 || !contactId) return () => {};
  const invite = { pskB64, contactId, onPaired, expires: Date.now() + PAIRING_INVITE_TTL_MS, cancelled: false, used: false };
  pairingInvites.set(token, invite);
  return () => { invite.cancelled = true; pairingInvites.delete(token); };
}

// Kopplungssitzung scheiterte vor dem fertigen Schluesseltausch: Einladung
// wieder freigeben, damit der Kontakt es erneut versuchen kann (sofern sie
// noch gilt und der Einladungs-Bildschirm noch offen ist).
function restorePairingInvite(token, invite) {
  if (!invite || invite.used || invite.cancelled || Date.now() > invite.expires) return;
  if (!pairingInvites.has(token)) {
    pairingInvites.set(token, invite);
    console.log('[Tor] Kopplung abgebrochen - Einladung bleibt gueltig');
  }
}

// Format im QR-Code/Link: malachi://connect/TOKEN.PSK.ONION (ONION ohne ".onion").
export function onionFromInvite(text) {
  const m = /[0-9A-F]{4}-?[0-9A-F]{4}\.[0-9A-F]{32}\.([a-z2-7]{56})(?![a-z2-7])/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() + '.onion' : null;
}

export async function pairViaTor({ onion, token, pskB64, contactId, onPaired }) {
  if (!Tor || !ONION_RE.test(onion || '') || !/^[0-9A-F]{8}$/.test(token || '') || !pskB64) return null;
  if (state.status !== 'ON') await ensureTorRunning();
  if (state.status !== 'ON') return null;
  const nonceC = await secureRandomToken(24);
  let connId;
  pairingInFlight++;
  try {
    connId = Tor.connectWithTimeout
      ? await Tor.connectWithTimeout(onion, TOR_VIRTUAL_PORT, PAIR_CONNECT_TIMEOUT_MS)
      : await Tor.connect(onion, TOR_VIRTUAL_PORT);
    pairingInFlight--;
  } catch (e) {
    pairingInFlight--;
    const why = String(e?.message || e);
    console.log('[Tor] Kopplung: Einladender ueber Tor nicht erreichbar -', why);
    // Beschreibung des Einladenden gezielt neu holen (trifft sie ein, startet
    // die Kopplung sofort einen frischen Versuch). "Nicht gefunden" kann an
    // tors 15-min-Merker haengen - dann NEWNYM, aber nie waehrend ein
    // paralleler Kopplungsversuch laeuft (NEWNYM braeche ihn ab).
    maybeRefetchDescriptor(onion);
    if (LOOKUP_NOT_FOUND_RE.test(why) && pairingInFlight === 0) refreshOnionLookups().catch(() => {});
    return null;
  }
  return new Promise((resolve) => {
    let nonceS = null;
    let finished = false;
    const done = (rtc, why) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending.delete(connId);
      if (!rtc) {
        try { Tor.close(connId); } catch {}
        console.warn('[Tor] Kopplung ueber Tor fehlgeschlagen:', why);
      }
      resolve(rtc);
    };
    const timer = setTimeout(() => done(null, 'Zeitlimit'), AUTH_TIMEOUT_MS);
    pending.set(connId, {
      onClose: () => done(null, 'Verbindung geschlossen'),
      onLine: (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return done(null, 'kein JSON'); }
        if (msg?.t !== 'malachi-tor') return done(null, 'fremdes Protokoll');
        if (msg.step === 'challenge' && nonceS === null) {
          if (!isNonce(msg.nonce)) return done(null, 'ungueltige Nonce');
          nonceS = msg.nonce;
          Tor.send(connId, JSON.stringify({
            t: 'malachi-tor', step: 'pair', token, nonce: nonceC,
            mac: authMac(pskB64, 'pair-client', [onion, nonceS, nonceC, token]),
          })).catch(() => done(null, 'senden'));
          return;
        }
        if (msg.step === 'pair-ok' && nonceS !== null) {
          if (!safeEqual(authMac(pskB64, 'pair-server', [onion, nonceS, nonceC, token]), msg.mac)) {
            return done(null, 'Einladender nicht authentisch');
          }
          pending.delete(connId);
          console.log('[Tor] ✅ Kopplung ueber Tor angemeldet');
          done(attachPairingSession(connId, contactId, true, onPaired), null);
          return;
        }
        return done(null, 'unerwarteter Schritt');
      },
    });
  });
}

// Uebergabe an die App (onPaired -> Kontakt anlegen, RTCStore.setConnection)
// erst NACH dem fertigen Kyber-Schluesseltausch - vorher legte bereits das
// Oeffnen des Kanals den Kontakt an. Riss die Tor-Verbindung danach noch ab,
// blieb ein "Neuer Kontakt" ohne Schluessel zurueck, und der naechste Versuch
// legte einen zweiten an (Live-Test: doppelte Kontakteintraege). Nachrichten,
// die die Gegenseite direkt nach ihrem eigenen Schluesseltausch schickt (Name,
// Onion-Adresse), werden bis zur Uebergabe gepuffert und danach zugestellt.
function attachPairingSession(connId, contactId, isInitiator, onPaired, onFailBeforePaired) {
  return attachPairingChannel(new TorChannel(connId), contactId, isInitiator, onPaired, onFailBeforePaired);
}

// Wie attachPairingSession, aber mit einem fertigen Kanal - die Telefonnummer-
// Kopplung (PhonePairing.js) uebergibt hier ihren Tunnel-Kanal. Darin laeuft
// unveraendert die normale Kopplung (Kyber-Schluesseltausch usw.).
export function attachPairingChannel(channel, contactId, isInitiator, onPaired, onFailBeforePaired) {
  channels.set(channel.connId, channel);
  let paired = false;
  const early = [];
  const rtc = new WebRTCManager((m) => { if (early.length < 50) early.push(m); }, () => {}, () => {
    if (!paired) { try { onFailBeforePaired?.(); } catch {} }
  });
  const handOver = async () => {
    if (paired || rtc._closed) return;
    paired = true;
    try { onPaired?.(rtc); } catch (e) { console.warn('[Tor] Kopplung: Uebergabe fehlgeschlagen', e?.message || e); }
    // onPaired hat (ueber RTCStore.setConnection) eigene Handler gesetzt:
    // gepufferte Nachrichten nachreichen, danach Profil/Onion-Adresse/
    // Warteschlange wie bei jeder Verbindung (RTCStore._onKeyExchange).
    for (const m of early.splice(0)) { try { rtc.onMessage?.(m); } catch {} }
    if (rtc._onKeyExchange && rtc._onKeyExchange !== handOver) await rtc._onKeyExchange();
  };
  rtc._onKeyExchange = handOver;
  rtc.chatId = contactId;
  channel._rtc = rtc;
  rtc._torClientOnion = isInitiator ? (state.onion || '') : '';
  rtc._torEstablishedAt = Date.now();
  if (hooks.flushQueue) rtc._onReady = () => hooks.flushQueue(contactId, rtc);
  rtc.attachTorChannel(channel, isInitiator);
  return rtc;
}

// ── Telefonnummer-Kopplung (PhonePairing.js) ───────────────────────────────
// Rohzugriff auf einzelne Tor-Verbindungen fuer das eigene Handshake-
// Protokoll der Telefonnummer-Kopplung: die Zeilen einer beanspruchten
// Verbindung gehen an handlers.onLine/onClose statt an die normale Anmeldung.
// Solange eine solche Verbindung offen ist, gilt Tor als "in Benutzung" (kein
// Neustart durch Waechter/Selbsttest, siehe isTorInUse).
export function claimTorConnection(connId, handlers) {
  pending.set(connId, handlers);
  return () => { if (pending.get(connId) === handlers) pending.delete(connId); };
}

export function setRendezvousIncomingHandler(fn) {
  rendezvousIncomingHandler = typeof fn === 'function' ? fn : null;
  return () => { if (rendezvousIncomingHandler === fn) rendezvousIncomingHandler = null; };
}

// Verbindung zum Treffpunkt-Dienst des Gegenuebers - wie pairViaTor: eigene
// Tor-Kreise je Versuch, die Beschreibung gezielt neu holen, bei "nicht
// gefunden" die Onion-Suche zuruecksetzen (nie waehrend ein anderer
// Kopplungsversuch laeuft - NEWNYM braeche ihn ab). Fehlertext = tors Grund,
// nie die Adresse.
export async function connectRendezvous(onion, timeoutMs = PAIR_CONNECT_TIMEOUT_MS) {
  if (!Tor || !ONION_RE.test(onion || '') || state.status !== 'ON') throw new Error('Tor nicht bereit');
  pairingInFlight++;
  let connId;
  try {
    connId = Tor.connectWithTimeout
      ? await Tor.connectWithTimeout(onion, TOR_VIRTUAL_PORT, timeoutMs)
      : await Tor.connect(onion, TOR_VIRTUAL_PORT);
  } catch (e) {
    pairingInFlight--;
    const why = String(e?.message || e);
    maybeRefetchDescriptor(onion);
    if (LOOKUP_NOT_FOUND_RE.test(why) && pairingInFlight === 0) refreshOnionLookups().catch(() => {});
    throw new Error(why);
  }
  pairingInFlight--;
  return connId;
}

// ── Waechter: Netzwechsel, Gesundheit, Selbsttest ─────────────────────────
// Ziel: Wer Tor an hat, ist ueber seine Onion-Adresse IMMER erreichbar -
// auch direkt nach einem Wechsel zwischen WLAN und Mobilfunk.
// Ein Onion-Verbindungsaufbau dauert normal 5-20 s, mit frisch gestartetem
// tor auch ~30 s (Live-Test 2026-10-17: Versuch kam nach 29 s an, war aber
// nach 25 s schon abgebrochen - danach 15 s Pause und alles von vorn).
// Haengende Versuche fangen parallele Zusatzversuche mit eigenen Kreisen ab
// (BackgroundSync), daher darf der einzelne Versuch laenger laufen.
const TOR_CONNECT_TIMEOUT_MS = 45000;
// Kopplung: der allererste Kontakt zu einer Onion-Adresse (Beschreibung holen,
// Einstiegspunkt, Treffpunkt) dauert laenger, zumal die Einladung oft gerade
// erst veroeffentlicht wurde.
const PAIR_CONNECT_TIMEOUT_MS = 60000;
const SELFTEST_AFTER_START_MS = 30000;
const SELFTEST_AFTER_NETCHANGE_MS = 25000;
const SELFTEST_INTERVAL_MS = 10 * 60 * 1000;
const SELFTEST_TIMEOUT_MS = 90000;
const HEALTH_INTERVAL_MS = 60000;
const HEALTH_FAILS_BEFORE_RESTART = 3;
const SELFTEST_FAILS_BEFORE_RESTART = 2;
const SELFTEST_RESTART_MIN_GAP_MS = 5 * 60 * 1000;
let lastSelfTestRestart = 0;

let healthTimer = null;
let selfTestTimer = null;
let healthFails = 0;
let selfTestFails = 0;
let selfTestRunning = false;
let lastNetKey = null;

function startWatchdog() {
  if (healthTimer) return;
  healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
  healthTimer?.unref?.();
}
function stopWatchdog() {
  if (healthTimer) clearInterval(healthTimer);
  if (selfTestTimer) clearTimeout(selfTestTimer);
  healthTimer = null;
  selfTestTimer = null;
  healthFails = 0;
  selfTestFails = 0;
}

async function checkHealth() {
  if (!Tor?.health || state.status !== 'ON') return;
  try {
    const h = await Tor.health();
    if (!h?.running) {
      console.warn('[Tor] Tor laeuft nicht mehr - starte neu');
      setState({ status: 'OFF', onion: null, reachable: false });
      stopWatchdog();
      ensureTorRunning();
      return;
    }
    if (h.dormant) Tor.networkChanged?.().catch(() => {});
    if (h.circuitEstablished) { healthFails = 0; return; }
    healthFails++;
    console.warn('[Tor] Keine funktionierende Verbindung ins Tor-Netz (' + healthFails + '/' + HEALTH_FAILS_BEFORE_RESTART + ')');
    if (healthFails >= HEALTH_FAILS_BEFORE_RESTART) {
      healthFails = 0;
      if (isTorInUse()) {
        console.log('[Tor] Meldet keine Kreise, transportiert aber Daten - kein Neustart');
        return;
      }
      softRecoverTor('keine Kreise');
    }
  } catch {}
}

// Laeuft gerade irgendetwas ueber Tor? Zaehlt: jeder offene Tor-Kanal, ueber
// den in den letzten TOR_IN_USE_WINDOW_MS etwas ankam (aktive Verbindung,
// Reserve, Kopplung), und jede laufende Anmeldung. Dann darf weder der
// Selbsttest noch der Waechter tor neu starten.
const TOR_IN_USE_WINDOW_MS = 20000;
export function isTorInUse(now = Date.now()) {
  for (const ch of channels.values()) {
    if (ch.readyState === 'open' && now - (ch._lastRx || 0) < TOR_IN_USE_WINDOW_MS) return true;
  }
  return pending.size > 0;
}

function scheduleSelfTest(delayMs) {
  if (selfTestTimer) clearTimeout(selfTestTimer);
  selfTestTimer = setTimeout(runSelfTest, delayMs);
  selfTestTimer?.unref?.();
}

// Verbindet sich ueber Tor mit dem EIGENEN Onion-Dienst. Kommt die Begruessung
// des eigenen Servers an, ist der Dienst im Tor-Netz veroeffentlicht und
// erreichbar - genau so, wie ein Kontakt ihn erreichen wuerde.
// Laufende Tor-Verbindungsaufbauten (NEWNYM wuerde sie abbrechen) und
// Fehlversuche je Onion-Adresse.
let torConnectsInFlight = 0;
let pairingInFlight = 0;
const lookupFailures = new Map();
const refreshedOnions = new Set();
// Gezieltes Neuholen einer Onion-Beschreibung (HSFETCH): hoechstens alle 30 s
// je Adresse - tor waehlt dabei jedes Mal ein anderes Verzeichnis.
const REFETCH_MIN_GAP_MS = 30000;
const lastRefetch = new Map();
function maybeRefetchDescriptor(onion) {
  if (!Tor?.refetchDescriptor || state.status !== 'ON' || !ONION_RE.test(onion || '')) return;
  if (Date.now() - (lastRefetch.get(onion) || 0) < REFETCH_MIN_GAP_MS) return;
  lastRefetch.set(onion, Date.now());
  Tor.refetchDescriptor(onion).catch(() => {});
}
const LOOKUP_NOT_FOUND_RE = /Onion-Beschreibung nicht gefunden/;
const LOOKUP_STALE_RE = /Einfuehrung gescheitert|Einfuehrung: Zeitueberschreitung|Treffpunkt gescheitert/;
const NETCHANGE_LOOKUP_WINDOW_MS = 2 * 60 * 1000;
let lastNetChangeAt = 0;
const BACKGROUND_REFRESH_GAP_MS = 3 * 60 * 1000;
let lastBackgroundRefresh = 0;
// Fuer Hintergrund-Wiederverbindungen: hoechstens alle 3 min, nur wenn gerade
// KEIN anderer Tor-Aufbau laeuft (Lehre aus dem NEWNYM-Sturm) und je Onion-
// Adresse nur EINMAL bis zum naechsten Erfolg. Live-Test 2026-10-17: ein
// veralteter Kontakt (dort geloescht) loeste es sonst jede Minute aus - und
// NEWNYM leert dabei die Onion-Beschreibungen ALLER Kontakte.
function maybeRefreshLookups(onion) {
  if (torConnectsInFlight > 0 || pairingInFlight > 0) return;
  if (onion && refreshedOnions.has(onion)) return;
  if (Date.now() - lastBackgroundRefresh < BACKGROUND_REFRESH_GAP_MS) return;
  lastBackgroundRefresh = Date.now();
  if (onion) refreshedOnions.add(onion);
  console.log('[Tor] Setze Onion-Suche zurueck (Kontakt nicht auffindbar)');
  refreshOnionLookups().catch(() => {});
}

// Vor einem erneuten Kopplungsversuch: tor fragt eine Onion-Beschreibung, die
// eben "nicht gefunden" wurde, bis zu 15 min nicht erneut ab. NEWNYM hebt das
// auf. Nur fuer die vom Nutzer gestartete Kopplung und hoechstens alle 15 s
// (NEWNYM bricht laufende Onion-Aufbauten ab - nie bei jedem Fehlschlag!).
let lastLookupRefresh = 0;
export async function refreshOnionLookups() {
  if (!Tor?.refreshCircuits || state.status !== 'ON') return false;
  if (Date.now() - lastLookupRefresh < 15000) return false;
  lastLookupRefresh = Date.now();
  return Tor.refreshCircuits().catch(() => false);
}

export async function runSelfTest() {
  if (!Tor || state.status !== 'ON' || !state.onion || selfTestRunning) return null;
  selfTestRunning = true;
  let ok = false;
  try {
    const connId = Tor.connectWithTimeout
      ? await Tor.connectWithTimeout(state.onion, TOR_VIRTUAL_PORT, SELFTEST_TIMEOUT_MS)
      : await Tor.connect(state.onion, TOR_VIRTUAL_PORT);
    ok = await new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), 30000);
      const finish = (v) => {
        clearTimeout(timer);
        pending.delete(connId);
        try { Tor.close(connId); } catch {}
        resolve(v);
      };
      pending.set(connId, {
        onLine: (line) => {
          let m = null;
          try { m = JSON.parse(line); } catch {}
          finish(m?.t === 'malachi-tor' && m.step === 'challenge');
        },
        onClose: () => finish(false),
      });
    });
  } catch (e) {
    ok = false;
    console.warn('[Tor] Selbsttest: Verbindung zum eigenen Onion-Dienst gescheitert -', e?.message || e);
  } finally {
    selfTestRunning = false;
  }
  if (!ok) {
    try {
      const h = await Tor.health?.();
      console.warn('[Tor] Selbsttest-Diagnose: Dienst aktiv =', h?.onionActive, '| lokaler Server offen =', h?.localServerOpen, '| Kreise =', h?.circuitEstablished);
    } catch {}
  }
  if (state.status !== 'ON') return ok;
  if (ok) {
    selfTestFails = 0;
    if (!state.reachable) console.log('[Tor] ✅ Eigener Onion-Dienst ist im Tor-Netz erreichbar');
    setState({ reachable: true });
    scheduleSelfTest(SELFTEST_INTERVAL_MS);
  } else {
    selfTestFails++;
    setState({ reachable: false });
    console.warn('[Tor] Eigener Onion-Dienst nicht erreichbar (' + selfTestFails + '/' + SELFTEST_FAILS_BEFORE_RESTART + ')');
    if (selfTestFails >= SELFTEST_FAILS_BEFORE_RESTART) {
      selfTestFails = 0;
      // Neustart kappt alle Tor-Verbindungen - wegen des Selbsttests hoechstens
      // alle 5 min (ein dauerhaft scheiternder Test darf keine Schleife ausloesen).
      // Laeuft gerade etwas ueber Tor (aktive Verbindung, Reserve, Kopplung,
      // Anmeldung), ist tor offensichtlich nutzbar - ein Neustart wuerde es nur
      // kappen (live gesehen). Vorher zaehlten nur aktive Verbindungen, nicht
      // die Reserve neben einer Direktverbindung oder eine laufende Kopplung.
      if (isTorInUse()) {
        // Ausnahme: tor meldet ueberlastete Einstiegsknoten (Pfad-Bias) - dann
        // sind auch die laufenden Verbindungen zaeh (live: Nachrichten 2 min
        // verspaetet, Direkt-Aushandlung scheiterte). Neustart mit neuen Wachen,
        // hoechstens alle 30 Tage, nie in "Nur Tor" (shouldResetGuards, Audit T5).
        if (await shouldResetGuards().catch(() => false)) {
          lastSelfTestRestart = Date.now();
          softRecoverTor('Einstiegsknoten ueberlastet');
        } else {
          console.log('[Tor] Selbsttest gescheitert, aber Tor-Verbindungen laufen - kein Neustart');
          scheduleSelfTest(SELFTEST_INTERVAL_MS);
        }
      } else if (Date.now() - lastSelfTestRestart > SELFTEST_RESTART_MIN_GAP_MS) {
        lastSelfTestRestart = Date.now();
        softRecoverTor('Onion-Dienst nicht erreichbar');
      } else {
        scheduleSelfTest(SELFTEST_INTERVAL_MS);
      }
    } else {
      scheduleSelfTest(SELFTEST_AFTER_NETCHANGE_MS);
    }
  }
  return ok;
}

// Netzwechsel: Tor sofort neu verbinden lassen, Onion-Dienst neu pruefen,
// Tor-Versuche zu Kontakten sofort erlauben (BackgroundSync-Hook).
// Tor haengt oder das Netz hat gewechselt: tor frisch starten (eigener
// Prozess) und danach sofort alle Kontakte neu verbinden. Ein frisches tor ist
// im neuen Netz nach ~5 s bereit; das alte kam dort live gemessen minutenlang
// nicht an Onion-Dienste heran - auch nicht nach Netz-aus/an.
let freshRestartTimer = null;
function softRecoverTor(reason) {
  if (state.status !== 'ON' && state.status !== 'STARTING') return;
  console.warn('[Tor] Tor wird frisch gestartet (' + reason + ')');
  setState({ reachable: false });
  // Mehrere Netz-Ereignisse kurz hintereinander zu EINEM Neustart buendeln.
  if (freshRestartTimer) clearTimeout(freshRestartTimer);
  freshRestartTimer = setTimeout(() => {
    freshRestartTimer = null;
    const t0 = Date.now();
    restartTor().then((ok) => {
      if (!ok) return;
      console.log('[Tor] Tor im neuen Netz bereit nach', Math.round((Date.now() - t0) / 100) / 10, 's - verbinde Kontakte');
      try { hooks.onTorReadyAfterNetworkChange?.(); } catch {}
    }).catch(() => {});
  }, FRESH_RESTART_DEBOUNCE_MS);
  freshRestartTimer?.unref?.();
}
const FRESH_RESTART_DEBOUNCE_MS = 800;

// Kopplung: tor holt die Beschreibung des Einladenden seit langem nicht -
// frisch starten und warten, bis tor wieder bereit ist (hoechstens 60 s).
// Neue Einstiegsknoten nur, wenn tor selbst Pfad-Bias-Warnungen meldet und
// der letzte Wechsel mindestens 12 h her ist (Anonymitaet: Wachen sollen
// moeglichst lange dieselben bleiben).
const GUARD_RESET_KEY = 'tor_guard_reset_at';
// Audit 2026-10-19 (T5): Wachen (Einstiegsknoten) nur selten neu waehlen
// lassen. Jede neue Wache erhoeht die Chance, dass ein Angreifer, der die
// Onion-Adresse kennt, ueber Guard-Discovery an eine eigene Wache kommt und so
// die IP aufdeckt - genau davor schuetzt "Maximal anonym". Vorher reichte
// eine einzige Pfad-Bias-Warnung (auf Mobilfunk haeufig) fuer einen Wechsel
// alle 12 h. Jetzt: hoechstens alle 30 Tage, im Verbindungsweg "Maximal
// anonym" nie automatisch.
const GUARD_RESET_MIN_GAP_MS = 30 * 24 * 60 * 60 * 1000;
const GUARD_RESET_MIN_WARNINGS = 3;
async function shouldResetGuards() {
  if (!Tor?.resetGuards || !Tor?.health || state.status !== 'ON') return false;
  if ((await connectionModeForDecision()) === MODE_TOR_ONLY) return false;
  const h = await Tor.health();
  if (!(h?.guardWarnings >= GUARD_RESET_MIN_WARNINGS)) return false;
  const last = Number(await EncryptedStorage.getItem(GUARD_RESET_KEY).catch(() => 0)) || 0;
  return Date.now() - last > GUARD_RESET_MIN_GAP_MS;
}
export { shouldResetGuards as _shouldResetGuardsForTests };

export async function restartTorForPairing() {
  softRecoverTor('Kopplung: Tor findet den Kontakt nicht');
  const until = Date.now() + 60000;
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < until) {
    if (state.status === 'ON' && state.onion && !freshRestartTimer) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return state.status === 'ON';
}

export function handleNetworkChange(netState) {
  const key = netState ? [netState.type, netState.isConnected, netState.details?.ipAddress || ''].join('|') : null;
  if (key === lastNetKey) return;
  const first = lastNetKey === null;
  // Gleiches Netz, nur die Adresse wurde nachgereicht ('' -> echte IP) bzw.
  // kurz nicht gemeldet: kein Wechsel. Sonst kappt ein Fehlalarm direkt nach dem
  // App-Start die gerade gebauten Tor-Kreise (live gesehen).
  const [pType, pConn, pIp] = (lastNetKey || '').split('|');
  const sameNetLateIp = !first && pType === netState?.type && pConn === 'true' && !!netState?.isConnected
    && (!pIp || !netState?.details?.ipAddress);
  lastNetKey = key;
  if (sameNetLateIp) return;
  if (first || !netState?.isConnected) return;
  // Erst die App (BackgroundSync) aufraeumen lassen: Verbindungen am alten
  // Netz sind tot, Wartezeiten fuer Tor-Versuche aufheben.
  try { hooks.onNetworkChange?.(); } catch {}
  // Ein Zuruecksetzen der Onion-Suche ist im neuen Netz sofort wieder erlaubt.
  lastNetChangeAt = Date.now();
  refreshedOnions.clear();
  lookupFailures.clear();
  lastBackgroundRefresh = 0;
  if (state.status === 'ON' && Tor?.resetNetwork && !freshRestartTimer) {
    lightResetThenReconnect();
  } else if (state.status === 'ON' || state.status === 'STARTING') {
    softRecoverTor('Netzwechsel');
  } else if (state.status === 'ERROR' || state.status === 'OFF') {
    ensureTorRunning().then((ok) => { if (ok) { try { hooks.onTorReadyAfterNetworkChange?.(); } catch {} } });
  }
}

let netReconnectTimer = null;
// Netzwechsel OHNE tor-Neustart (Live-Test 2026-10-17): ein frisch
// gestartetes tor braucht allein fuer die Onion-Beschreibung eines Kontakts
// 20 s+, und waehrend des Abrufs gestartete Versuche haengen oft bis zum
// Zeitlimit - Wiederverbindung nach ~60 s. Jetzt nur das Netz neu (nativ
// resetNetwork, Konsens/Wachen/Beschreibungen bleiben) und alle halbe Sekunde
// pruefen, ob tor im neuen Netz neue Kreise baut; dann sofort alle Kontakte
// anwaehlen. Kommt binnen LIGHT_RESET_GIVE_UP_MS kein neuer Kreis zustande,
// haengt tor am alten Netz - dann wie bisher frisch starten.
const LIGHT_RESET_GIVE_UP_MS = 12000;
let lightResetGiveUpMs = LIGHT_RESET_GIVE_UP_MS;
export function _setLightResetGiveUpForTests(ms) { lightResetGiveUpMs = ms; }
const LIGHT_RESET_POLL_MS = 500;
function lightResetThenReconnect() {
  if (netReconnectTimer) clearInterval(netReconnectTimer);
  setState({ reachable: false });
  const started = Date.now();
  console.log('[Tor] Netzwechsel - Tor verbindet sich im neuen Netz neu (ohne Neustart)');
  Tor.resetNetwork().catch(() => {});
  let polling = false;
  const stop = () => { if (netReconnectTimer) { clearInterval(netReconnectTimer); netReconnectTimer = null; } };
  netReconnectTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      if (state.status !== 'ON') { stop(); return; }
      if (Date.now() - started > lightResetGiveUpMs) {
        stop();
        softRecoverTor('Netzwechsel: ohne Neustart keine neuen Kreise');
        return;
      }
      const h = await Tor?.health?.();
      // freshCircuits: nach resetNetwork gebaute Kreise (nativ).
      const ready = h?.running && (typeof h.freshCircuits === 'number' ? h.freshCircuits > 0 : h.circuitEstablished);
      if (ready && netReconnectTimer) {
        stop();
        console.log('[Tor] Tor im neuen Netz bereit nach', Math.round((Date.now() - started) / 100) / 10, 's (ohne Neustart) - verbinde Kontakte');
        try { hooks.onTorReadyAfterNetworkChange?.(); } catch {}
      }
    } catch {} finally { polling = false; }
  }, LIGHT_RESET_POLL_MS);
  netReconnectTimer?.unref?.();
}
if (Tor) {
  try { NetInfo.addEventListener(handleNetworkChange); } catch {}
}

// Fuer Tests.
export function _resetTorTransportForTests() {
  stopWatchdog();
  if (freshRestartTimer) { clearTimeout(freshRestartTimer); freshRestartTimer = null; }
  lastSelfTestRestart = 0;
  restartChain = Promise.resolve();
  if (netReconnectTimer) { clearInterval(netReconnectTimer); netReconnectTimer = null; }
  pairingInvites.clear();
  reserves.clear();
  lastNetKey = null;
  selfTestRunning = false;
  cachedSettings = { ...DEFAULT_TOR_SETTINGS };
  channels.clear();
  pending.clear();
  pendingIncoming.clear();
  state = { status: 'OFF', progress: 0, message: null, onion: null, mode: null, reachable: false };
  lastKnownOnion = null;
  lookupFailures.clear();
  refreshedOnions.clear();
  lastRefetch.clear();
  descReceivedAt.clear();
  descWaiters.clear();
  lastBackgroundRefresh = 0;
  lastLookupRefresh = 0;
  lastNetChangeAt = 0;
  lightResetGiveUpMs = LIGHT_RESET_GIVE_UP_MS;
  torConnectsInFlight = 0;
  pairingInFlight = 0;
  rendezvousIncomingHandler = null;
}
export function _setTorStateForTests(patch) {
  if (patch?.onion) lastKnownOnion = patch.onion;
  setState(patch);
}
export function _handleIncomingForTests(connId) { return handleIncoming(connId); }
