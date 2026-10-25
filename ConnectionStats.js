/**
 * Malachi - Verbindungs-Diagnose (STUN_AUSSTIEG_PLAN.md, WP0)
 *
 * Wie gut klappen Direktverbindungen ohne STUN wirklich? Das laesst sich ohne
 * Server und ohne Telemetrie nur auf den Geraeten selbst zaehlen. Dieses
 * Modul fuehrt deshalb rein LOKALE Zaehler (EncryptedStorage, 'conn_stats_v1')
 * und zeigt sie in den Einstellungen ("Diagnose", mit "Als Text kopieren").
 * Tester schicken den Text selbst, wenn sie wollen - es wird nichts
 * hochgeladen, nichts verlaesst das Geraet von allein.
 *
 * Datenschutz-Regeln (geprueft in connectionStats.privacy.test.js):
 *   - nur Zaehlwerte je fester Kategorie (Ganzzahlen),
 *   - keine IP-Adressen, keine Ports, keine Kontakt-IDs, keine Onion-Adressen,
 *     keine Namen und KEINE Zeitstempel einzelner Ereignisse,
 *   - unbekannte Kategorien werden verworfen (bump nimmt nur Schluessel aus
 *     SCHEMA), damit nie versehentlich ein freier Wert hineingeraet,
 *   - keine Logzeilen mit Werten; "Alle Daten loeschen" leert die Zaehler
 *     (EncryptedStorage.clear + resetConnectionStatsAfterWipe).
 *
 * Gespeichert wird nicht bei jeder Zaehlung, sondern hoechstens einmal je
 * Minute (Zeitanteil-Zaehler) und wenn die App in den Hintergrund geht - und
 * NIE waehrend eines Anrufs (setConnectionStatsWriteGuard): Anrufe hinterlassen
 * waehrend sie laufen keinen einzigen Schreibzugriff (GROUP_CALL_DESIGN.md
 * "Keine Spuren"). Was bis zu einer Minute vor einem Absturz gezaehlt wurde,
 * kann dabei verloren gehen - fuer eine Diagnose unerheblich.
 */
import EncryptedStorage from 'react-native-encrypted-storage';
import { NativeModules, AppState } from 'react-native';

export const CONNECTION_STATS_KEY = 'conn_stats_v1';
const MAX_COUNT = 1e12;   // Obergrenze je Zaehler (Plausibilitaet beim Laden)

// Alle erlaubten Kategorien und Zaehler. Reihenfolge = Anzeige.
export const SCHEMA = {
  // Versuche, eine Direktverbindung aufzubauen (DirectUpgrade).
  direct: ['started', 'ok', 'failTimeout', 'failIce', 'failRejected', 'failNetChange', 'failOther', 'superseded'],
  // Aufbauzeit gelungener Versuche (Start -> Schluesseltausch fertig).
  directSetup: ['lt2s', 'lt5s', 'lt10s', 'ge10s'],
  // Gewaehlter Pfad einer Direktverbindung (aus getStats, ohne Adressen).
  path: ['ipv6Host', 'lan', 'mapping', 'prflx', 'peerStun', 'other'],
  // Netzlage beim Versuch (MalachiPcp.ipv6Status).
  net: ['wifi', 'cellular', 'otherNet', 'ipv6Ok', 'ipv6Missing'],
  // Router-Portfreigabe (PortMapping.js), je Anfrage.
  mapping: ['success', 'notAuthorized', 'unsupported', 'late'],
  // ICE-Neustarts nach Netzwechsel.
  restart: ['started', 'ok', 'failed'],
  // 1:1-Anrufe: Weg und Aufbauzeit (Annehmen -> Sprache).
  calls: ['webrtc', 'channelDirect', 'channelTor', 'setupLt2s', 'setupLt5s', 'setupGe5s',
    'endConnectionLost', 'endConnectTimeout', 'endUnreachable', 'endMediaError'],
  // Sprache ueber den Kanal (natives MalachiCallAudio.getStats).
  channelAudio: ['frames', 'dropped', 'underruns', 'viaAudioChannel'],
  // Gruppenanrufe: Paare.
  groupPairs: ['connected', 'unreachable'],
  // Zeitanteil (Summe aller Verbindungen, Minuten, ohne Zuordnung).
  minutes: ['direct', 'tor'],
};

function emptyStats() {
  const out = { v: 1 };
  for (const [cat, keys] of Object.entries(SCHEMA)) {
    out[cat] = {};
    for (const k of keys) out[cat][k] = 0;
  }
  return out;
}

// Nur bekannte Kategorien/Zaehler, nur endliche, nicht negative Ganzzahlen.
function sanitize(raw) {
  const out = emptyStats();
  if (!raw || typeof raw !== 'object') return out;
  for (const [cat, keys] of Object.entries(SCHEMA)) {
    const src = raw[cat];
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      const n = Number(src[k]);
      if (Number.isInteger(n) && n >= 0 && n <= MAX_COUNT) out[cat][k] = n;
    }
  }
  return out;
}

let stats = emptyStats();
let loaded = false;
let loadPromise = null;
let dirty = false;
let writeGuard = null;        // () => true, solange nicht gespeichert werden darf
let dirtyBeforeLoad = null;   // Zaehlungen vor dem ersten Laden
const listeners = new Set();

export function loadConnectionStats() {
  if (loaded) return Promise.resolve(stats);
  if (!loadPromise) {
    loadPromise = EncryptedStorage.getItem(CONNECTION_STATS_KEY)
      .then((raw) => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
        stats = sanitize(parsed);
      })
      .catch(() => { stats = emptyStats(); })
      .then(() => {
        loaded = true;
        // Was vor dem Laden gezaehlt wurde, dazurechnen.
        if (dirtyBeforeLoad) {
          for (const [cat, keys] of Object.entries(dirtyBeforeLoad)) {
            for (const [k, n] of Object.entries(keys)) stats[cat][k] = Math.min(MAX_COUNT, stats[cat][k] + n);
          }
          dirtyBeforeLoad = null;
          dirty = true;
        }
        return stats;
      })
      .finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

/**
 * Waehrend fn() true liefert, wird nichts gespeichert (App.tsx: solange ein
 * 1:1- oder Gruppenanruf laeuft). Gezaehlt wird trotzdem - im Arbeitsspeicher.
 */
export function setConnectionStatsWriteGuard(fn) {
  writeGuard = typeof fn === 'function' ? fn : null;
}

/** Geaenderte Zaehler speichern, sofern erlaubt. true = geschrieben. */
export async function flushConnectionStats() {
  if (!loaded || !dirty) return false;
  try { if (writeGuard && writeGuard()) return false; } catch { return false; }
  dirty = false;
  try {
    await EncryptedStorage.setItem(CONNECTION_STATS_KEY, JSON.stringify(stats));
    return true;
  } catch {
    dirty = true;
    console.warn('[Diagnose] Zaehler nicht gespeichert');
    return false;
  }
}

function emit() {
  for (const l of [...listeners]) { try { l(); } catch {} }
}

/**
 * Einen Zaehler erhoehen. Unbekannte Kategorien/Schluessel werden ignoriert -
 * so kann nie ein freier Wert (Adresse, ID ...) in die Statistik geraten.
 */
export function bump(category, key, by = 1) {
  // Nur eigene Eintraege von SCHEMA ('constructor', '__proto__' usw. nicht).
  const keys = Object.prototype.hasOwnProperty.call(SCHEMA, category) ? SCHEMA[category] : null;
  if (!Array.isArray(keys) || !keys.includes(key)) return;
  const n = Math.floor(Number(by));
  if (!Number.isFinite(n) || n <= 0) return;
  if (!loaded) {
    if (!dirtyBeforeLoad) dirtyBeforeLoad = {};
    if (!dirtyBeforeLoad[category]) dirtyBeforeLoad[category] = {};
    dirtyBeforeLoad[category][key] = (dirtyBeforeLoad[category][key] || 0) + n;
    loadConnectionStats().catch(() => {});
    return;
  }
  stats[category][key] = Math.min(MAX_COUNT, stats[category][key] + n);
  dirty = true;
  emit();
}

/** Kopie der Zaehler (fuer Anzeige und Tests). */
export function getConnectionStats() { return sanitize(stats); }

export function onConnectionStatsChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** "Zuruecksetzen" in der Diagnose-Ansicht. */
export async function resetConnectionStats() {
  stats = emptyStats();
  loaded = true;
  dirty = false;
  dirtyBeforeLoad = null;
  await EncryptedStorage.removeItem(CONNECTION_STATS_KEY).catch(() => {});
  emit();
}

/** Nach "Alle Daten loeschen": nichts mehr im Arbeitsspeicher, nichts speichern. */
export function resetConnectionStatsAfterWipe() {
  stats = emptyStats();
  loaded = false;
  loadPromise = null;
  dirty = false;
  dirtyBeforeLoad = null;
  stopConnectionTimeSampler();
  emit();
}

// ── Hilfen fuer die Zaehlstellen ────────────────────────────────────────────
/** Aufbauzeit-Klasse einer gelungenen Direktverbindung. */
export function noteDirectSetup(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  bump('directSetup', n < 2000 ? 'lt2s' : n < 5000 ? 'lt5s' : n < 10000 ? 'lt10s' : 'ge10s');
}

/** Aufbauzeit-Klasse eines Anrufs (Annehmen -> Sprache). */
export function noteCallSetup(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  bump('calls', n < 2000 ? 'setupLt2s' : n < 5000 ? 'setupLt5s' : 'setupGe5s');
}

/**
 * Pfad eines verbundenen Kandidatenpaars einordnen (nur Typen, nie Adressen):
 *   mapping  - ein Kandidat stammt aus einer Router-Portfreigabe (Foundation
 *              pcp|natpmp|upnp, siehe PortMapping.mappedCandidateLine),
 *   peerStun - die Gegenseite (aeltere Version) nutzt einen STUN-Kandidaten,
 *   prflx    - peer-reflexiv (aus den Pruefpaketen gelernt),
 *   ipv6Host - beide Host-Kandidaten mit IPv6,
 *   lan      - beide Host-Kandidaten mit privater IPv4,
 *   other    - alles andere.
 */
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
export function classifyPath(local, remote) {
  if (!local || !remote) return 'other';
  const isMapped = (c) => c.candidateType === 'srflx' && /^(pcp|natpmp|upnp)\d/.test(String(c.foundation || ''));
  // Eigene srflx-Kandidaten gibt es ohne STUN nur noch aus der Portfreigabe.
  if (local.candidateType === 'srflx' || isMapped(remote)) return 'mapping';
  if (remote.candidateType === 'srflx') return 'peerStun';
  if (local.candidateType === 'prflx' || remote.candidateType === 'prflx') return 'prflx';
  if (local.candidateType === 'host' && remote.candidateType === 'host') {
    const la = String(local.address || local.ip || '');
    const ra = String(remote.address || remote.ip || '');
    if (la.includes(':') && ra.includes(':')) return 'ipv6Host';
    if (PRIVATE_V4.test(la) && PRIVATE_V4.test(ra)) return 'lan';
  }
  return 'other';
}

/** Netzlage beim Direkt-Versuch (WLAN/Mobilfunk, IPv6 nutzbar?). */
export async function noteNetworkSituation() {
  try {
    const st = await NativeModules?.MalachiPcp?.ipv6Status?.();
    if (!st || typeof st !== 'object') return;
    bump('net', st.transport === 'wifi' ? 'wifi' : st.transport === 'cellular' ? 'cellular' : 'otherNet');
    bump('net', st.globalAddress && st.defaultRoute ? 'ipv6Ok' : 'ipv6Missing');
  } catch {}
}

// ── Zeitanteil direkt vs. Tor ───────────────────────────────────────────────
// Jede Minute: je bestehender Verbindung (Schluesseltausch fertig) eine
// Minute auf "direkt" bzw. "Tor". Nur Summen - wer verbunden war, wird nicht
// gemerkt. Danach (und wenn die App in den Hintergrund geht) speichern.
let sampler = null;
let appStateSub = null;
export function startConnectionTimeSampler(getConnections, intervalMs = 60000) {
  if (sampler) return;
  try {
    appStateSub = AppState?.addEventListener?.('change', (s) => {
      if (s === 'background') flushConnectionStats().catch(() => {});
    }) || null;
  } catch { appStateSub = null; }
  sampler = setInterval(() => {
    let direct = 0;
    let tor = 0;
    try {
      for (const c of getConnections()?.values?.() || []) {
        if (!c || c._closed || c.keyExchangeDone !== true) continue;
        if (c.transport === 'tor') tor++; else direct++;
      }
    } catch { return; }
    const minutes = Math.max(1, Math.round(intervalMs / 60000));
    if (direct) bump('minutes', 'direct', direct * minutes);
    if (tor) bump('minutes', 'tor', tor * minutes);
    flushConnectionStats().catch(() => {});
  }, intervalMs);
  sampler?.unref?.();
}
export function stopConnectionTimeSampler() {
  if (sampler) clearInterval(sampler);
  sampler = null;
  try { appStateSub?.remove?.(); } catch {}
  appStateSub = null;
}

// ── Anzeige / "Als Text kopieren" ───────────────────────────────────────────
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) + ' %' : '–');

/** Kurzstatus fuer die Kategorie in den Einstellungen. */
export function statsSummary(s = stats, tr = (k, p) => k) {
  const tried = s.direct.started;
  const share = s.minutes.direct + s.minutes.tor;
  return tr('diag.summary', { ok: s.direct.ok, tried, direct: pct(s.minutes.direct, share) });
}

/**
 * Zaehler als Text (Kopieren/Anzeige). tr: Uebersetzungsfunktion fuer die
 * Ueberschriften; die Zaehlernamen bleiben bewusst technisch (gleich in jeder
 * Sprache - so lassen sich Texte verschiedener Tester vergleichen).
 */
export function statsAsText(s = stats, { tr = (k) => k, appVersion = '', modeLabel = '' } = {}) {
  const lines = [];
  lines.push(tr('diag.textTitle') + (appVersion ? ' · ' + appVersion : ''));
  if (modeLabel) lines.push(tr('diag.textMode', { mode: modeLabel }));
  lines.push(tr('diag.textShare', {
    direct: pct(s.minutes.direct, s.minutes.direct + s.minutes.tor),
    ok: s.direct.ok, tried: s.direct.started,
  }));
  for (const [cat, keys] of Object.entries(SCHEMA)) {
    lines.push(cat + ': ' + keys.map((k) => k + '=' + s[cat][k]).join(', '));
  }
  lines.push(tr('diag.textPrivacy'));
  return lines.join('\n');
}

// Nur fuer Tests.
export function _resetConnectionStatsForTests() {
  stats = emptyStats();
  loaded = false;
  loadPromise = null;
  dirty = false;
  dirtyBeforeLoad = null;
  writeGuard = null;
  stopConnectionTimeSampler();
  listeners.clear();
}
