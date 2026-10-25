/**
 * Malachi - Verbindungsweg (Einstellung "Verbindungsweg", zwei Stufen)
 *
 * Kontakte finden sich immer zuerst ueber Tor (TorTransport.js). Danach
 * entscheidet der Verbindungsweg, ob und wie die Verbindung auf direkt (WebRTC)
 * wechselt (DirectUpgrade.js) und wie Anrufe laufen (CallManager.js):
 *
 *   "Direkt, wenn moeglich" - Standard: keine ICE-Server, Malachi fragt nie
 *     einen STUN-Dienst. Direkt geht es ueber IPv6, das gleiche lokale Netz
 *     oder eine Portfreigabe des eigenen Routers (PCP, NAT-PMP, UPnP-IGD -
 *     siehe PortMapping.js und android/.../net/MalachiPcpModule.kt); dazu
 *     peer-reflexive Kandidaten (entstehen in ICE von selbst, sobald die
 *     Pruefpakete der Gegenseite ankommen). Angebot und Antwort (mit den
 *     IP-Adressen) reisen verschluesselt ueber Tor - der Kontakt sieht die
 *     Adressen also schon beim Versuch. Klappt direkt nicht, bleibt Tor.
 *   "Maximal anonym (nur Tor)" - Vollversion: nie eine Direktverbindung,
 *     keine WebRTC-Medien (Anrufe nur als Sprache ueber den Tor-Kanal, kein
 *     Video). Kontakte sehen die IP-Adresse nie; der Tor-Eintrittsknoten
 *     sieht sie wie bei jeder Tor-Nutzung, aber nicht, mit wem man spricht.
 *
 * Gespeichert in EncryptedStorage ('2' bzw. '3' - die Zahlen der frueheren
 * drei Stufen bleiben, damit nichts umgeschrieben werden muss). Bis Version
 * 1.1.0 gab es zusaetzlich Stufe 1 "Schnell (mit STUN)" (oeffentliche
 * STUN-Dienste). Sie entfaellt ersatzlos (STUN_AUSSTIEG_PLAN.md, E1-E4):
 * ein gespeichertes '1' gilt sofort als "Direkt, wenn moeglich", wird beim
 * Laden einmal umgeschrieben (mit Ruecklese-Pruefung) und loest einmalig
 * einen Hinweis aus (shouldShowStunRemovalNotice). Das ist mehr Schutz, nie
 * weniger - deshalb ohne Rueckfrage.
 *
 * Ein Wechsel wirkt sofort (Abonnenten: DirectUpgrade stuft bestehende
 * Direktverbindungen bei Stufe 3 auf Tor zurueck, CallManager schaltet
 * laufende Anrufe auf Sprache ueber den Kanal).
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

export const MODE_DIRECT = 2;
export const MODE_TOR_ONLY = 3;
// Gespeicherter Wert der frueheren Stufe 1 "Schnell (mit STUN)" (bis 1.1.0).
// Nur noch zum Erkennen beim Laden - waehlbar ist er nicht mehr.
export const LEGACY_MODE_FAST = 1;
export const CONNECTION_MODES = [MODE_DIRECT, MODE_TOR_ONLY];
export const DEFAULT_CONNECTION_MODE = MODE_DIRECT;
export const CONNECTION_MODE_STORAGE_KEY = 'connection_mode';
// Einmaliger Hinweis "Malachi fragt keine STUN-Dienste mehr":
//   'pending' - steht aus (gespeicherte Stufe 1 wurde umgestellt)
//   'shown'   - wurde gezeigt
//   'none'    - nicht noetig (nach diesem Update neu eingerichtet)
export const CONNECTION_MODE_NOTICE_KEY = 'connection_mode_notice';
const NOTICE_PENDING = 'pending';
const NOTICE_SHOWN = 'shown';
const NOTICE_NONE = 'none';

let current = DEFAULT_CONNECTION_MODE;
let loaded = false;
let loadPromise = null;
const listeners = new Set();
// Schreibzugriffe auf die gespeicherte Stufe nacheinander: die Umstellung
// alter Werte darf sich nie zwischen das Lesen und Schreiben einer Wahl des
// Nutzers schieben (sonst koennte sie ein gerade gespeichertes "nur Tor"
// ueberschreiben).
let writeChain = Promise.resolve();
function serialized(fn) {
  const run = writeChain.then(fn);
  writeChain = run.catch(() => {});
  return run;
}

// Gueltige, waehlbare Stufe oder null.
function normalize(v) {
  const n = Number(v);
  return CONNECTION_MODES.includes(n) ? n : null;
}

// Gespeicherter Wert -> wirksame Stufe (die fruehere Stufe 1 gilt als
// "Direkt, wenn moeglich").
function normalizeStored(raw) {
  if (raw != null && Number(raw) === LEGACY_MODE_FAST) return MODE_DIRECT;
  return normalize(raw);
}
const isLegacyFast = (raw) => raw != null && raw !== '' && Number(raw) === LEGACY_MODE_FAST;

// Einmalige Umstellung "Schnell (mit STUN)" -> "Direkt, wenn moeglich".
// Reihenfolge fuer Datenerhalt: erst den Hinweis vormerken (neuer Schluessel,
// nur hinzugefuegt), dann den alten Wert ersetzen und zuruecklesen. Scheitert
// das Schreiben, bleibt '1' stehen - es gilt trotzdem als "Direkt, wenn
// moeglich", und beim naechsten Start wird es erneut versucht.
function migrateLegacyFast() {
  return serialized(async () => {
    const notice = await EncryptedStorage.getItem(CONNECTION_MODE_NOTICE_KEY).catch(() => null);
    if (notice !== NOTICE_SHOWN && notice !== NOTICE_PENDING) {
      await EncryptedStorage.setItem(CONNECTION_MODE_NOTICE_KEY, NOTICE_PENDING).catch(() => {});
    }
    // Inzwischen anders gewaehlt (setConnectionMode schreibt selbst) oder
    // schon umgeschrieben: nichts anfassen.
    if (current !== MODE_DIRECT) return;
    const still = await EncryptedStorage.getItem(CONNECTION_MODE_STORAGE_KEY).catch(() => null);
    if (!isLegacyFast(still)) return;
    try {
      await EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(MODE_DIRECT));
      const check = await EncryptedStorage.getItem(CONNECTION_MODE_STORAGE_KEY);
      if (check !== String(MODE_DIRECT)) console.warn('[Verbindungsweg] Umstellung nicht bestaetigt - wird beim naechsten Start wiederholt');
      else console.log('[Verbindungsweg] Fruehere Stufe "Schnell (mit STUN)" auf "Direkt, wenn moeglich" umgestellt');
    } catch (e) {
      console.warn('[Verbindungsweg] Umstellung nicht gespeichert (gilt trotzdem):', e?.message || e);
    }
  });
}

/**
 * Liest die gespeicherte Stufe (einmal pro Prozess, danach aus dem Speicher).
 * Fehlt sie (Erstinstallation), gilt "Direkt, wenn moeglich". Wirft bei einem
 * Lesefehler - Aufrufer entscheiden dann ausfallsicher (siehe Modulkommentar).
 */
export function loadConnectionMode() {
  if (loaded) return Promise.resolve(current);
  if (!loadPromise) {
    loadPromise = EncryptedStorage.getItem(CONNECTION_MODE_STORAGE_KEY)
      .then(async (raw) => {
        // Ein setConnectionMode() waehrend des Lesens hat Vorrang.
        if (!loaded) {
          current = normalizeStored(raw) || DEFAULT_CONNECTION_MODE;
          loaded = true;
        }
        if (isLegacyFast(raw)) await migrateLegacyFast().catch(() => {});
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

// ICE-Server gibt es in keiner Stufe mehr: Malachi fragt keinen STUN- und
// keinen TURN-Dienst (STUN_AUSSTIEG_PLAN.md, E1/E2). Die oeffentliche Adresse
// kommt hoechstens vom eigenen Router (Portfreigabe), alles andere findet ICE
// ohne Dritte (Host-, IPv6- und peer-reflexive Kandidaten). Die Konfiguration
// jeder PeerConnection steht an EINER Stelle: WebRTCManager.pcConfigForMode.

/**
 * Darf von `current` auf `mode` gewechselt werden? Stufe 3 neu waehlen nur mit
 * Vollversion; ist sie schon aktiv, bleibt sie es (auch ohne Lizenz). Zurueck
 * auf "Direkt, wenn moeglich" geht immer - wer den Schutz abschaltet, tut das
 * bewusst.
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
 * Vollversion), 'ungueltig' oder 'speichern' (Speicherfehler).
 */
export async function setConnectionMode(mode, { pro = false } = {}) {
  const n = normalize(mode);
  if (!n) return { ok: false, mode: current, reason: 'ungueltig' };
  let prev;
  try { prev = await loadConnectionMode(); } catch { prev = current; }
  if (!canSelectConnectionMode(n, { pro, current: prev })) return { ok: false, mode: prev, reason: 'pro' };
  if (n === prev) {
    await serialized(() => EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(n))).catch(() => {});
    return { ok: true, mode: n };
  }
  if (n === MODE_TOR_ONLY) {
    // Schutz sofort wirksam (auch wenn das Speichern scheitert, gilt er
    // mindestens bis zum Neustart) - erst danach speichern.
    current = n;
    loaded = true;
    notify(n, prev);
    try {
      await serialized(() => EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(n)));
    } catch {
      return { ok: false, mode: n, reason: 'speichern' };
    }
    return { ok: true, mode: n };
  }
  // Schutz lockern: erst dauerhaft speichern, dann wirksam werden.
  try {
    await serialized(() => EncryptedStorage.setItem(CONNECTION_MODE_STORAGE_KEY, String(n)));
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

// ── Einmaliger Hinweis zur Umstellung (App.tsx, nach dem Entsperren) ─────────
/**
 * Soll der Hinweis "Malachi fragt keine STUN-Dienste mehr" jetzt kommen? Nur
 * fuer bereits eingerichtete Apps aufrufen. Ja, wenn eine gespeicherte Stufe 1
 * umgestellt wurde - oder wenn nie eine Stufe gespeichert war (bis 1.1.0 galt
 * dann Stufe 1). Neu eingerichtete Apps vermerken 'none' (SetupScreen).
 */
export async function shouldShowStunRemovalNotice() {
  try {
    await loadConnectionMode().catch(() => {});
    const notice = await EncryptedStorage.getItem(CONNECTION_MODE_NOTICE_KEY);
    if (notice === NOTICE_PENDING) return true;
    if (notice) return false;
    const raw = await EncryptedStorage.getItem(CONNECTION_MODE_STORAGE_KEY);
    return raw == null || raw === '' || isLegacyFast(raw);
  } catch {
    return false;
  }
}

/** Hinweis gezeigt (bzw. bei neu eingerichteten Apps: nicht noetig). */
export function markStunRemovalNoticeShown({ fresh = false } = {}) {
  return EncryptedStorage.setItem(CONNECTION_MODE_NOTICE_KEY, fresh ? NOTICE_NONE : NOTICE_SHOWN).catch(() => {});
}

// Nur fuer Tests: Zwischenspeicher verwerfen (wie ein App-Neustart). Abos
// bleiben bestehen (die Module abonnieren beim Laden).
export function _resetConnectionModeForTests() {
  current = DEFAULT_CONNECTION_MODE;
  loaded = false;
  loadPromise = null;
  writeChain = Promise.resolve();
}
