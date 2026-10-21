/**
 * Malachi - Verbindungsweg (Einstellung "Verbindungsweg", drei Stufen)
 *
 * Kontakte finden sich immer zuerst ueber Tor (TorTransport.js). Danach
 * entscheidet der Verbindungsweg, ob und wie die Verbindung auf direkt (WebRTC)
 * wechselt (DirectUpgrade.js) und wie Anrufe laufen (CallManager.js):
 *
 *   Stufe 1 "Schnell" - Standard: oeffentliche STUN-Dienste (AppConfig.
 *     STUN_POOL, je Verbindung zwei verschiedene Betreiber im Wechsel) nennen
 *     dem Geraet seine oeffentliche Adresse. Sie sehen dabei die IP-Adresse
 *     (nie Inhalte oder Kontakte), der Kontakt sieht sie bei einer
 *     Direktverbindung. Kein eigener Server noetig.
 *   Stufe 2 "Privat (ohne STUN)": keine ICE-Server. Die oeffentliche Adresse
 *     kommt nur vom eigenen Router (PCP, NAT-PMP, UPnP-IGD - siehe
 *     android/.../net/MalachiPcpModule.kt), dazu IPv6-Host-Kandidaten und
 *     peer-reflexive Kandidaten (entstehen in ICE von selbst, sobald die
 *     Pruefpakete der Gegenseite ankommen). Kein Server erfaehrt die IP, nur
 *     der Kontakt bei einer Direktverbindung. Direkt klappt seltener - sonst
 *     bleibt Tor.
 *   Stufe 3 "Maximal anonym (nur Tor)" - Vollversion: nie eine
 *     Direktverbindung, keine WebRTC-Medien (Anrufe nur als Sprache ueber den
 *     Tor-Kanal, kein Video). Niemand sieht die IP, auch Kontakte nicht.
 *
 * Gespeichert in EncryptedStorage. Ein Wechsel wirkt sofort (Abonnenten:
 * DirectUpgrade stuft bestehende Direktverbindungen bei Stufe 3 auf Tor
 * zurueck, CallManager schaltet laufende Anrufe auf Sprache ueber den Kanal).
 *
 * REGEL (wie bei der Duress-PIN, LicenseManager.canSelectTorOnlyMode): Stufe 3
 * NEU waehlen geht nur mit Vollversion - eine bereits aktive Stufe 3 bleibt
 * aber auch ohne (gueltige) Lizenz aktiv. Ein eingerichteter Schutz wird nie
 * still abgeschaltet. Deshalb liest dieses Modul den Lizenzzustand nie selbst.
 *
 * Ausfallsicher: Laesst sich die Einstellung nicht lesen, behandeln die
 * Entscheidungsstellen das wie Stufe 3 (lieber Tor als eine IP preisgeben).
 */
import EncryptedStorage from 'react-native-encrypted-storage';
import { STUN_POOL, STUN_PER_CONNECTION } from './AppConfig';

export const MODE_FAST = 1;
export const MODE_PRIVATE = 2;
export const MODE_TOR_ONLY = 3;
export const CONNECTION_MODES = [MODE_FAST, MODE_PRIVATE, MODE_TOR_ONLY];
export const DEFAULT_CONNECTION_MODE = MODE_FAST;
export const CONNECTION_MODE_STORAGE_KEY = 'connection_mode';

let current = DEFAULT_CONNECTION_MODE;
let loaded = false;
let loadPromise = null;
const listeners = new Set();

function normalize(v) {
  const n = Number(v);
  return CONNECTION_MODES.includes(n) ? n : null;
}

/**
 * Liest die gespeicherte Stufe (einmal pro Prozess, danach aus dem Speicher).
 * Fehlt sie (Erstinstallation), gilt Stufe 1. Wirft bei einem Lesefehler -
 * Aufrufer entscheiden dann ausfallsicher (siehe Modulkommentar).
 */
export function loadConnectionMode() {
  if (loaded) return Promise.resolve(current);
  if (!loadPromise) {
    loadPromise = EncryptedStorage.getItem(CONNECTION_MODE_STORAGE_KEY)
      .then((raw) => {
        // Ein setConnectionMode() waehrend des Lesens hat Vorrang.
        if (!loaded) {
          current = normalize(raw) || DEFAULT_CONNECTION_MODE;
          loaded = true;
        }
        return current;
      })
      .finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

/** Zuletzt bekannte Stufe (synchron, z.B. fuer die Anzeige). */
export function getConnectionMode() { return current; }
export function isConnectionModeLoaded() { return loaded; }
export function isTorOnlyMode() { return current === MODE_TOR_ONLY; }

/**
 * Stufe fuer Entscheidungen, die die IP-Adresse betreffen: bei einem
 * Lesefehler Stufe 3 (ausfallsicher).
 */
export async function connectionModeForDecision() {
  try { return await loadConnectionMode(); } catch { return MODE_TOR_ONLY; }
}

/**
 * ICE-Server je Stufe: nur Stufe 1 fragt STUN - je Verbindung zwei
 * verschiedene Betreiber aus STUN_POOL, reihum (kein Zufall noetig: es geht
 * nur um Lastverteilung/Ausfallsicherheit, nicht um Geheimhaltung).
 */
let stunRotation = 0;
export function iceServersForMode(mode) {
  if (mode !== MODE_FAST || !STUN_POOL.length) return [];
  const n = Math.min(STUN_PER_CONNECTION, STUN_POOL.length);
  const start = stunRotation % STUN_POOL.length;
  stunRotation = (stunRotation + 1) % STUN_POOL.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ urls: STUN_POOL[(start + i) % STUN_POOL.length].url });
  return out;
}

/**
 * Darf von `current` auf `mode` gewechselt werden? Stufe 3 neu waehlen nur mit
 * Vollversion; ist sie schon aktiv, bleibt sie es (auch ohne Lizenz). Zurueck
 * auf Stufe 1/2 geht immer - wer den Schutz abschaltet, tut das bewusst.
 */
export function canSelectConnectionMode(mode, { pro = false, current: cur = current } = {}) {
  const n = normalize(mode);
  if (!n) return false;
  if (n !== MODE_TOR_ONLY) return true;
  return pro === true || cur === MODE_TOR_ONLY;
}

function notify(mode, prev) {
  for (const l of [...listeners]) {
    try {
      const r = l(mode, prev);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* ein Abonnent darf die anderen nicht stoeren */ }
  }
}

/**
 * Stufe waehlen. pro: frisch gepruefter Lizenzzustand (LicenseManager.
 * isProVerified). Liefert { ok, mode, reason? } - reason 'pro' (Stufe 3 ohne
 * Vollversion) oder 'speichern' (Speicherfehler).
 */
export async function setConnectionMode(mode, { pro = false } = {}) {
  const n = normalize(mode);
  if (!n) return { ok: false, mode: current, reason: 'ungueltig' };
  let prev;
  try { prev = await loadConnectionMode(); } catch { prev = current; }
  if (!canSelectConnectionMode(n, { pro, current: prev })) return { ok: false, mode: prev, reason: 'pro' };
  if (n === prev) {
    try { await EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(n)); } catch {}
    return { ok: true, mode: n };
  }
  if (n === MODE_TOR_ONLY) {
    // Schutz sofort wirksam (auch wenn das Speichern scheitert, gilt er
    // mindestens bis zum Neustart) - erst danach speichern.
    current = n;
    loaded = true;
    notify(n, prev);
    try {
      await EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(n));
    } catch {
      return { ok: false, mode: n, reason: 'speichern' };
    }
    return { ok: true, mode: n };
  }
  // Schutz lockern: erst dauerhaft speichern, dann wirksam werden.
  try {
    await EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(n));
  } catch {
    return { ok: false, mode: prev, reason: 'speichern' };
  }
  current = n;
  loaded = true;
  notify(n, prev);
  return { ok: true, mode: n };
}

/** Abo fuer Stufenwechsel: fn(neu, vorher). Rueckgabe: Abmelden. */
export function onConnectionModeChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Nur fuer Tests: Zwischenspeicher verwerfen (wie ein App-Neustart). Abos
// bleiben bestehen (die Module abonnieren beim Laden).
export function _resetConnectionModeForTests() {
  current = DEFAULT_CONNECTION_MODE;
  loaded = false;
  loadPromise = null;
}
