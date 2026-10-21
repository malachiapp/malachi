/**
 * Malachi – WebRTCManager.js
 * P2P via WebRTC
 * Kyber-768 Key Exchange + Dreischicht-Verschlüsselung
 * AES-256-GCM + ChaCha20-Poly1305 + XSalsa20-Poly1305
 */
import {
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';
// (TURN-Zugangsdaten werden seit der Umstellung auf reines P2P nicht mehr abgerufen.)
import { generateKyberKeypair, kyberEncapsulate, kyberDecapsulate } from './HybridCrypto';
import { encryptMsg, decryptMsg } from './MessageCrypto';
import RTCStore from './RTCStore';
import * as RatchetSession from './RatchetSession';
import { Buffer } from 'buffer';
// Fix 2 (SECURITY_CHAOS_TESTING.md §9): vorher an beiden Kyber-Handlern per
// `import('react-native-encrypted-storage')` lazy/dynamisch nachgeladen -
// das machte den Schreibvorgang ohnehin nie schneller (das Modul ist winzig,
// kein Grund fuer Lazy-Loading) und musste jetzt awaitet werden (siehe dort).
// Statischer Top-Level-Import statt dynamisch, identisch zum bereits
// bestehenden Muster in App.tsx (`import EncryptedStorage from
// 'react-native-encrypted-storage'`) - funktioniert unveraendert unter Metro
// UND unter Jest (ein awaiteter `import()` scheitert dort ohne
// --experimental-vm-modules, ein normaler statischer Import nicht).
import EncryptedStorage from 'react-native-encrypted-storage';
import { NativeModules } from 'react-native';
import { MODE_FAST, MODE_PRIVATE, MODE_TOR_ONLY, connectionModeForDecision, iceServersForMode } from './ConnectionMode';

// ── Automatische Portfreigabe am Heimrouter (Masterplan Baustein 1) ──────────
// Nach dem Sammeln der Kandidaten bittet die App den eigenen Router (nur das
// Standard-Gateway im lokalen Netz), den Port des Kandidaten kurz
// freizugeben: IPv6 = Firewall-Loch fuer die ohnehin oeffentliche Adresse,
// IPv4 = Weiterleitung (nur mit echter oeffentlicher IPv4). Erfolgreiche
// IPv4-Weiterleitungen kommen als zusaetzlicher Kandidat ins Angebot.
// Native Seite: android/.../net/MalachiPcpModule.kt - zuerst PCP (RFC 6887),
// fuer IPv4 ersatzweise NAT-PMP (RFC 6886) und UPnP-IGD. Jede Zeile des
// Ergebnisses nennt in `method` das Protokoll ('pcp'|'natpmp'|'upnp'); das
// Modul merkt sich, womit freigegeben wurde, und loescht mit demselben.
// Im Verbindungsweg "Privat (ohne STUN)" ist der Router die EINZIGE Quelle
// der oeffentlichen IPv4-Adresse - dort wird laenger auf ihn gewartet.
// (Nachgeschlagen statt beim Laden festgehalten, damit Tests das native
// Modul ersetzen koennen.)
const pcpModule = () => NativeModules?.MalachiPcp;
const PCP_LIFETIME_S = 3600;
const PCP_RENEW_MS = 25 * 60 * 1000;
export const PORT_MAPPING_MAX_WAIT_MS = { [MODE_FAST]: 1500, [MODE_PRIVATE]: 4000 };
let lastPortMappingStatus = null;
export function getPortMappingStatus() { return lastPortMappingStatus; }

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Host-Kandidaten, fuer die eine Freigabe Sinn ergibt: globale IPv6-Adressen
// (nicht link-lokal/ULA) und private IPv4-Adressen hinter einem Router. Bei TCP
// nur "passive" Kandidaten - nur die nehmen Verbindungen an.
export function hostCandidatesForMapping(sdp) {
  const out = [];
  const seen = new Set();
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const m = /^a=candidate:\S+ 1 (udp|tcp) \d+ (\S+) (\d+) typ host(.*)$/i.exec(line);
    if (!m) continue;
    const protocol = m[1].toLowerCase();
    const address = m[2];
    const port = Number(m[3]);
    if (protocol === 'tcp' && !/tcptype passive/i.test(m[4])) continue;
    const v6 = address.includes(':');
    if (v6 ? /^(fe80|fc|fd)/i.test(address) : !PRIVATE_V4.test(address)) continue;
    if (!(port > 0 && port < 65536)) continue;
    const key = protocol + '|' + address + '|' + port;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ protocol, address, port });
  }
  return out.slice(0, 8);
}

// Fuegt fuer erfolgreiche IPv4-Weiterleitungen einen srflx-Kandidaten mit der
// oeffentlichen Adresse hinzu (IPv6-Pinholes brauchen keinen eigenen
// Kandidaten - die Host-Adresse ist bereits oeffentlich). Egal ob per PCP,
// NAT-PMP oder UPnP freigegeben - alle liefern dieselbe Ergebnisform.
const MAPPING_METHODS = new Set(['pcp', 'natpmp', 'upnp']);
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export function addMappedCandidates(sdp, results) {
  const lines = [];
  (results || []).forEach((r, i) => {
    const ext = r?.externalAddress;
    if (r?.result !== 'SUCCESS' || typeof ext !== 'string' || !IPV4_RE.test(ext)) return;
    if (PRIVATE_V4.test(ext) || /^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|22[4-9]\.|2[3-5]\d\.)/.test(ext)) return;
    if (!(r.externalPort > 0 && r.externalPort < 65536)) return;
    if (r.protocol !== 'udp' && r.protocol !== 'tcp') return;
    if (typeof r.address !== 'string' || !IPV4_RE.test(r.address) || !(r.port > 0 && r.port < 65536)) return;
    const tag = MAPPING_METHODS.has(r.method) ? r.method : 'pcp';
    const tcp = r.protocol === 'tcp' ? ' tcptype passive' : '';
    lines.push(`a=candidate:${tag}${i} 1 ${r.protocol} 1686052607 ${ext} ${r.externalPort} typ srflx raddr ${r.address} rport ${r.port}${tcp}`);
  });
  if (!lines.length) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const parts = sdp.split(eol);
  let idx = parts.findIndex(l => l.startsWith('a=end-of-candidates'));
  if (idx < 0) {
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].startsWith('a=candidate:')) { idx = i + 1; break; }
  }
  if (idx < 0) return sdp;
  parts.splice(idx, 0, ...lines);
  return parts.join(eol);
}

// ── UNIFORMITÄT (Cover Traffic) ─────────────────
// Cover Traffic schützt nur, wenn "Nachricht" und "keine Nachricht" für einen
// Beobachter ununterscheidbar sind. Dafür braucht es BEIDES:
//   1. festen Sendetakt (nicht zufällig - ein zufälliger, aber pro Session
//      konstanter Intervall ist sogar ein Fingerabdruck)
//   2. feste Paketgröße für echte UND unechte Pakete (sonst verrät die Größe,
//      welches Paket echt ist - egal wie gut verschlüsselt)
// Vorher war beides falsch: Intervall einmalig zufällig gewürfelt und dann
// konstant, Padding nur bei Dummies, echte Nachrichten ungepolstert.
// War 3000 - Live-Test 2026-09-27: mit STALE_TIMEOUT_MS = 4x diesem Wert
// (siehe _startLivenessWatch()) dauerte es bis zu 12s, bis eine tote
// Verbindung ueberhaupt als Zombie erkannt wurde, plus danach bis zu 15s bis
// zum naechsten Auto-Reconnect-Versuch (App.tsx) - insgesamt bis zu ~27s
// Downtime, vom Nutzer als "Verbindung muss oefter geprueft werden"
// wahrgenommen. Verkuerzt auf 2000ms (Zombie-Erkennung dann in 8s statt 12s).
const COVER_INTERVAL_MS = 2000;   // fester Takt
// Ueber Tor (Ausweichweg, siehe TorTransport.js) seltener: jedes Paket kostet
// dort deutlich mehr (Latenz, Akku), und die Tor-Zellen sind ohnehin
// gleich gross. Weiterhin fester Takt, damit Nachricht und Pause nicht
// unterscheidbar sind.
// Tor: alle 5 s ein Lebenszeichen (war 10 s). Tote Tor-Verbindungen (z.B.
// Gegenseite hat das Netz gewechselt) werden so nach 15 s statt 40 s erkannt.
const TOR_COVER_INTERVAL_MS = 5000;
const TOR_STALE_FACTOR = 3;
// Frist fuer probeNow(): wach antwortet die Gegenseite in Millisekunden, und
// direkt kommen ohnehin alle 2 s Fuellpakete.
const QUICK_PROBE_GRACE_MS = 5000;
const PAD_BLOCK_SIZE   = 512;     // feste Klartext-Blockgröße in Bytes

// Wie lange ICE maximal in "checking" verharren darf, bevor _setupPC()
// aktiv aufgibt (siehe ausführlicher Kommentar dort) - länger als die 12s
// aus _waitForICE() (die nur das GATHERING lokaler Kandidaten betreffen,
// nicht die tatsächliche Konnektivitätsprüfung danach), aber kurz genug,
// um bei einem echten Hänger zeitnah einen neuen Reconnect-Versuch zuzulassen.
const ICE_CHECKING_TIMEOUT_MS = 20000;
// Live-Test 2026-09-29 (Nur-P2P-Umstellung): DataChannel offen, aber der
// Kyber-Schluesselaustausch kam nie zustande (kyber_pubkey erreichte die
// Gegenseite nicht). Weder der ICE-Wachhund (ICE stand ja) noch die
// Liveness-Watch (startet erst NACH dem Austausch) griffen - die Verbindung
// hing ohne Secret fest, jede Nachricht blieb "queued", ein Reconnect wurde
// nie ausgeloest (RTCStore.isConnected() meldete ja "verbunden"). Jetzt: ist
// der Austausch nach dieser Zeit nicht abgeschlossen, Verbindung verwerfen,
// damit der normale Reconnect-Kreislauf eine neue aufbaut.
const KEY_EXCHANGE_TIMEOUT_MS = 8000;
// ICE-Neustart nach Netzwechsel (DirectUpgrade.js): so lange werden
// 'disconnected'/'failed' nicht als Abbruch gewertet, weil die Verbindung
// gerade auf das neue Netz umzieht. Kandidaten fuer den Neustart werden
// hoechstens ICE_RESTART_GATHER_MS gesammelt.
const ICE_RESTART_GRACE_MS = 8000;
const ICE_RESTART_GATHER_MS = 3000;
const KYBER_HANDSHAKE_SUBTYPES = new Set(['kyber_pubkey', 'kyber_ciphertext']);

// Bringt ein Nachrichten-Objekt auf ein exaktes Vielfaches der Blockgröße,
// indem ein Füllfeld "p" angehängt wird. Da die drei Verschlüsselungsschichten
// nur konstanten Overhead (Nonces + Tags) hinzufügen, ist damit auch das
// fertige Chiffrat größenkonstant.
export function padToBlock(obj, blockSize = PAD_BLOCK_SIZE) {
  const base = JSON.stringify({ ...obj, p: '' });
  const baseLen = Buffer.byteLength(base, 'utf8');
  const target = Math.ceil((baseLen + 1) / blockSize) * blockSize;
  const padLen = target - baseLen;
  return JSON.stringify({ ...obj, p: 'A'.repeat(padLen) });
}

// ── Double Ratchet (RatchetSession.js, RATCHET_DESIGN.md) ───────────────────
// Schichten einer Nachricht, sobald fuer den Kontakt eine Ratchet-Sitzung
// besteht:
//   innen   Ratchet: eigener Schluessel pro Nachricht (Forward Secrecy,
//           Selbstheilung, ML-KEM-Geheimnisse im Root Key). Inhalt auf
//           RATCHET_INNER_PAD_BLOCK aufgepolstert.
//   aussen  wie bisher die Verbindungsschicht (dreifache Verschluesselung mit
//           dem ML-KEM-Geheimnis DIESER Verbindung) - sie verbirgt auch den
//           Ratchet-Header (Ratchet-Schluessel, Zaehler, KEM-Kennungen) vor
//           jedem, der die Verbindung nicht kennt. Deshalb keine zusaetzliche
//           Header-Verschluesselung im Ratchet.
// Nie durch den Ratchet (nur Verbindungsschicht): Fuellpakete, Sprachpakete
// eines Anrufs (viele pro Sekunde) und Medien-Chunks (eigener Dateischluessel,
// der im Ratchet-verschluesselten End-Marker reist, siehe MediaKey.js).
// Aussen wird bei Ratchet-Kontakten auf 1024 statt 512 Byte gepolstert: der
// Ratchet-Umschlag ist groesser, und kurze echte Nachrichten sollen weiter
// genauso gross sein wie Fuellpakete.
const RATCHET_PAD_BLOCK_SIZE = 1024;
const RATCHET_INNER_PAD_BLOCK = 64;
const MEDIA_CHUNK_TYPES = new Set(['img_chunk', 'audio_chunk', 'file_chunk']);
const TRANSPORT_ONLY_TYPES = new Set(['dummy', 'call_audio', ...MEDIA_CHUNK_TYPES]);

// Darf eine Nachricht ohne Ratchet ankommen, obwohl fuer den Kontakt der
// Ratchet aktiv ist? Nur Transportpakete - Medien-Chunks nur, wenn sie mit
// einem Dateischluessel verschluesselt sind (fk), dessen Schluessel dann im
// Ratchet-geschuetzten End-Marker kommen muss.
function allowedWithoutRatchet(m) {
  if (m.type === 'dummy' || m.type === 'call_audio') return true;
  return MEDIA_CHUNK_TYPES.has(m.type) && m.fk === 1;
}

// Verschluesselt ein Nachrichtenobjekt fuer genau diese Verbindung und
// liefert die fertige Leitungs-Nachricht ({type:'encrypted', data}) - innen
// Ratchet, sofern fuer den Kontakt eine Sitzung besteht (oder hier entsteht),
// sonst das bisherige Verfahren. Wirft bei Fehlern; Aufrufer duerfen dann NIE
// auf das alte Verfahren ausweichen (Downgrade), sondern halten die Nachricht
// zurueck. Als Funktion statt Methode, damit auch die Warteschlange
// (BackgroundSync.js) und Tests mit einfachen Verbindungs-Objekten sie nutzen.
export async function sealForConnection(rtc, obj) {
  const secret = rtc?.sharedSecret;
  if (!secret || !obj || typeof obj !== 'object') return null;
  const chatId = rtc.chatId || null;
  let inner = obj;
  let ratchetMode = false;
  if (chatId) {
    if (TRANSPORT_ONLY_TYPES.has(obj.type)) {
      ratchetMode = await RatchetSession.hasSession(chatId).catch(() => false);
    } else {
      const env = await RatchetSession.seal(chatId, padToBlock(obj, RATCHET_INNER_PAD_BLOCK), { connSecret: secret });
      if (env) {
        inner = env;
        ratchetMode = true;
      }
    }
  }
  const body = MEDIA_CHUNK_TYPES.has(obj.type)
    ? JSON.stringify(inner)
    : padToBlock(inner, ratchetMode ? RATCHET_PAD_BLOCK_SIZE : PAD_BLOCK_SIZE);
  const data = await encryptMsg(body, secret);
  if (!data) throw new Error('Verschluesselung fehlgeschlagen');
  return JSON.stringify({ type: 'encrypted', data });
}

// Medien-Sender fuer eine Verbindung (siehe ImageCrypto/AudioCrypto/
// FileCrypto meta.sealer): null = bisheriges Verfahren. Wirft, wenn nicht
// feststellbar ist, ob eine Sitzung besteht - dann lieber nicht senden als
// ein Medium nur mit der Verbindungsschicht zu schuetzen.
export async function mediaSealerFor(rtc, opts) {
  if (!rtc || typeof rtc.mediaSealer !== 'function') return null;
  return rtc.mediaSealer(opts);
}

// Zeitstempel-Frische-Pruefung, identisch zu App.tsx's isFreshTimestamp()
// (kann von hier aus nicht importiert werden - App.tsx importiert seinerseits
// aus diesem Modul, ein Ruecklauf-Import wuerde einen Zyklus erzeugen). Wird
// nur fuer 'text'-Nachrichten auf dem LIVE-DataChannel-Pfad genutzt
// (Sicherheitsaudit: die bestehende Replay-Pruefung deckte bisher nur den
// Relay-Fallback-Pfad ab - App.tsx checkIncoming/web's checkOfflinePackets -
// nicht den Live-P2P-Pfad hier. Ein boesartiger TURN-Server (sitzt bei
// NAT-Traversal-Fehlern im Datenpfad) oder ein anderweitig aktiv
// positionierter Angreifer koennte sonst eine einmal beobachtete, gueltig
// verschluesselte Live-Nachricht beliebig oft erneut einspielen. Bewusst NUR
// fuer 'text' - andere hier verarbeitete Typen (dummy/ready/handshake/
// img_chunk/system-Kontrollnachrichten) sind reine Echtzeit-Signale ohne
// garantiertes Zeitstempel-Feld; ihnen die Pruefung aufzuzwingen wuerde sie
// brechen, nicht absichern).
function isFreshTimestamp(ts) {
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  if (age > 15 * 60 * 1000) return false;
  if (age < -5 * 60 * 1000) return false;
  return true;
}

// Alters-Grenze fuer System-Steuersignale auf dem Live-Pfad (siehe Kommentar
// an der Aufrufstelle): so lange wie ein Eintrag in der lokalen Sende-
// Warteschlange auf Zustellung warten darf (BackgroundSync.js
// PENDING_DELETE_MAX_MS). Zukunfts-Toleranz wie bei isFreshTimestamp().
export const CONTROL_SIGNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function isPlausibleControlTimestamp(ts) {
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  if (age > CONTROL_SIGNAL_MAX_AGE_MS) return false;
  if (age < -5 * 60 * 1000) return false;
  return true;
}

// Sequenz-bewusster Replay-Schutz, identisch zu App.tsx's
// isNewerThanLastAcceptedSystemTs() (gleicher Schluessel
// "system_ts_hwm_<contactId>" - beide Zustellwege, live und Relay-Fallback,
// teilen sich absichtlich denselben Zeitstempel-Hochwasserstand pro Kontakt,
// damit ein per Relay bereits verbrauchter ts nicht nochmal live "frisch"
// waere und umgekehrt). Nur fuer System-Kontrollpakete auf dem LIVEN Pfad -
// dieser Pfad hatte bisher ueberhaupt keine Frische-/Reihenfolge-Pruefung
// fuer secret_start/secret_end/delete_chat/transfer_ready (State-Machine-
// Review Fund 4 + Sicherheitsaudit Claim 6 zusammen betrachtet).
//
// Konkurrenz-Review-Fund: dieser Speicher MUSS derselbe sein wie der, den
// App.tsx's eigene (wortgleiche) Kopie dieser Funktion benutzt, sonst ist
// der "geteilte Hochwasserstand" aus dem Kommentar oben eine leere
// Behauptung. App.tsx's `AsyncStorage` ist aber KEIN echtes
// @react-native-async-storage/async-storage - es ist ein lokaler,
// EncryptedStorage-Wrapper (App.tsx:22-26: jede Methode ruft 1:1 die
// gleichnamige EncryptedStorage-Methode auf). Diese Funktion hier importierte
// bisher tatsaechlich das ECHTE @react-native-async-storage/async-storage
// dynamisch - ein voellig ANDERER, unabhaengiger nativer Speicher, der mit
// App.tsx's EncryptedStorage-Wrapper nie etwas teilt. Konkrete Folge: ein
// legitim per Relay-Fallback verarbeitetes secret_end aktualisiert NUR
// App.tsx's (EncryptedStorage-)Hochwasserstand - der hier gepruefte, echte
// AsyncStorage-Hochwasserstand weiss davon nichts und haelt ein spaeter live
// wiedereingespieltes aelteres secret_start faelschlich weiterhin fuer
// "neuer als das letzte akzeptierte Paket". Das genaue Cross-Pfad-Replay-
// Szenario, das diese Funktion eigentlich schliessen sollte (State-Machine-
// Review Fund 5 / SECURITY_STATE_MACHINES.md §10), blieb dadurch fuer den
// Fall "secret_end via Relay, Replay-secret_start live" offen. Fix: denselben
// bereits statisch importierten EncryptedStorage benutzen wie App.tsx's
// Wrapper es tut - kein neuer Speicher, sondern derselbe, echte gemeinsame
// Zustand, den der Kommentar oben immer schon meinte. Als Nebeneffekt macht
// das diese Funktion auch unter Jest testbar (ein awaiteter `import()` eines
// echten natives Moduls scheitert dort mit
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG und wurde von channel.onmessage's
// aeusserem try/catch bisher stillschweigend geschluckt - jeder bestehende
// Test, der ueber diesen Zweig lief, pruefte dadurch nie die echte
// Sequenzlogik, sondern nur, dass eine geworfene Exception denselben
// "verworfen"-Effekt hat).
async function isNewerThanLastAcceptedSystemTs(contactId, ts) {
  const key = 'system_ts_hwm_' + contactId;
  const stored = await EncryptedStorage.getItem(key).catch(() => null);
  const lastTs = stored ? parseInt(stored, 10) : 0;
  if (!Number.isFinite(ts) || ts <= lastTs) return false;
  await EncryptedStorage.setItem(key, String(ts)).catch(() => {});
  return true;
}


// Einziger Netzdienst: STUN (coturn "stun-only", siehe AppConfig.js und
// server/hetzner/turnserver.conf) - und nur im Verbindungsweg Stufe 1
// (ConnectionMode.js). Er nennt dem Geraet nur dessen oeffentliche Adresse -
// keine Inhalte, keine Signale, kein TURN.

// ── NUR DIREKTES P2P (Produktentscheidung 2026-09-29) ──────────────────────
// Vorher lief jede Verbindung erzwungen ueber den TURN-Server
// (iceTransportPolicy 'relay'): alle - wenn auch verschluesselten - Inhalte
// flossen physisch durch den eigenen Server. Vorgabe jetzt: Malachi ist ein
// echter P2P-Messenger, Inhalte gehen AUSSCHLIESSLICH direkt Geraet <->
// Geraet. Deshalb:
//   - keine TURN-Server mehr in der ICE-Konfiguration (auch kein Abruf von
//     TURN-Zugangsdaten), nur noch STUN: der Server beantwortet dabei nur
//     "unter welcher Adresse siehst du mich?", es fliessen keine Daten
//     ueber ihn;
//   - iceTransportPolicy 'all': direkte Kandidaten (lokales Netz, oeffentliche
//     IPv6-Adresse, per STUN ermittelte IPv4-Adresse) werden genutzt.
// Kommt keine Direktverbindung zustande (seltene, sehr restriktive Netze),
// laufen Nachrichten ueber Tor (TorTransport.js) oder warten verschluesselt
// in der lokalen Sende-Warteschlange - es gibt bewusst keinen Umweg ueber
// einen Server. Ausgehandelt wird die Direktverbindung ueber die bestehende,
// verschluesselte Tor-Verbindung (DirectUpgrade.js). Folge von direktem P2P:
// die Gegenseite sieht die IP-Adressen des eigenen Geraets (stehen im
// Verbindungsangebot, das nur sie entschluesseln kann).
//
// Verbindungsweg (ConnectionMode.js): Stufe 1 mit eigenem STUN-Server, Stufe 2
// ganz ohne ICE-Server (oeffentliche Adresse nur vom eigenen Router, siehe
// _withPortMappings; dazu IPv6-Host- und peer-reflexive Kandidaten), Stufe 3
// ueberhaupt keine PeerConnection - _pcConfig() wirft dann, damit auch ein
// uebersehener Aufrufer nie eine Direktverbindung oder WebRTC-Medien aufbaut
// (die Kandidaten wuerden die IP-Adresse an den Kontakt verraten).
const FORCE_RELAY_ONLY = false;
export class TorOnlyModeError extends Error {
  constructor() {
    super('Verbindungsweg "Maximal anonym (nur Tor)": keine WebRTC-Verbindung');
    this.name = 'TorOnlyModeError';
  }
}
export function pcConfigForMode(mode) {
  if (mode === MODE_TOR_ONLY) throw new TorOnlyModeError();
  return {
    iceServers: iceServersForMode(mode),
    iceTransportPolicy: 'all',
    // Auch TCP-Kandidaten: manche Netze sperren UDP, lassen TCP aber durch
    // (Masterplan Baustein 1). libwebrtc sammelt sie standardmaessig schon,
    // hier bewusst festgeschrieben, damit ein Bibliotheks-Update das nicht
    // stillschweigend aendert.
    tcpCandidatePolicy: 'enabled',
  };
}
async function _pcConfig() {
  return pcConfigForMode(await connectionModeForDecision());
}
export const pcConfigForCalls = _pcConfig;

export class WebRTCManager {
  constructor(onMessage, onConnected, onDisconnected) {
    this.pc              = null;
    this.dataChannel     = null;
    this.onMessage       = onMessage;
    this.onConnected     = onConnected;
    this.onDisc          = onDisconnected;
    this.sharedSecret    = null;
    this.myKyberKeys     = null;
    this.isInitiator     = false;
    this.pendingMsgs     = [];
    this.keyExchangeDone = false;
    this.chatId          = null;
    this._onKeyExchange  = null;
    this._onReady        = null;
    this._coverTraffic   = null;
    this._lastActivity   = 0;
    // 'direct' (WebRTC) oder 'tor' (Ausweichweg, siehe attachTorChannel).
    this.transport       = 'direct';
    this._livenessWatch  = null;
    this._iceCheckingTimeout = null;
    // Review-Fund 2026-09-27 ("H3"): onDisc() konnte bisher mehrfach pro
    // Instanz feuern (z.B. 'failed' → onDisc()+close() → dataChannel.close()
    // loest asynchron channel.onclose aus → onDisc() ein zweites Mal). Die
    // Aufrufer in App.tsx (checkOutgoing/checkIncoming) loeschen bei jedem
    // Aufruf bedingungslos aus RTCStore.connections/den Attempting-Sets -
    // ein zweiter, verspaeteter Aufruf (oder einer von der ALTEN Instanz
    // nach einem RTCStore.setConnection()-Ersatz) konnte so eine bereits
    // neu aufgebaute, gesunde Verbindung wieder aus der Map werfen. Einfache
    // Instanz-Sperre statt Wettlauf-Vermeidung auf App.tsx-Seite nachzubauen.
    this._discFired = false;
    // Hidden-Bug-Hunt-Fund: close() nullt bisher nur Felder DIESER Instanz,
    // brach aber niemals einen bereits laufenden Kyber-Handshake ab, der zum
    // Zeitpunkt des close()-Aufrufs mitten in `await kyberEncapsulate(...)`/
    // `await kyberDecapsulate(...)` haengt (ein echter, mehrere Millisekunden
    // dauernder Bridge-Aufruf zur nativen BouncyCastle-Implementierung -
    // siehe HybridCrypto.js). Laeuft z.B. der 5-Fail-Wipe (RTCStore.resetAll())
    // oder ein Chat-Loeschen (RTCStore.clearContact()) GENAU in diesem Fenster,
    // schliesst close() die Instanz und leert RTCStore.sharedSecrets - der
    // bereits laufende Handler ist davon unbeeindruckt und schreibt beim
    // Fortsetzen `this.sharedSecret`/`RTCStore.sharedSecrets` sowie die
    // persistente `shared_secret_<chatId>`-Ablage erneut, DIREKT NACH dem
    // vermeintlich vollstaendigen Wipe/Loeschen - siehe
    // SECURITY_HIDDEN_BUG_HUNT.md. `_closed` macht das explizit pruefbar:
    // gesetzt in close(), abgefragt direkt nach dem Bridge-Aufruf in beiden
    // Kyber-Handlern, bevor irgendein State mutiert wird.
    this._closed = false;
  }

  async createOffer() {
    this.isInitiator = true;
    this.pc = new RTCPeerConnection(await _pcConfig());
    this._setupPC();
    this.dataChannel = this.pc.createDataChannel('malachi', { ordered: true });
    this._setupDataChannel(this.dataChannel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitForICE();
    return JSON.stringify({ sdp: await this._withPortMappings(this.pc.localDescription), type: 'offer' });
  }

  // Tor-Ausweichweg (TorTransport.js): statt einer WebRTC-PeerConnection
  // traegt ein bereits angemeldeter Tor-Kanal die Daten. Darueber laeuft
  // unveraendert dieselbe Sitzungslogik wie beim direkten Kanal (Kyber-
  // Schluesseltausch, Verschluesselung, Replay-Schutz, Warteschlange). Das
  // Pseudo-pc-Objekt haelt RTCStore.isConnected()/close() unveraendert
  // funktionsfaehig - solange der Kanal offen ist, gilt die Verbindung als
  // verbunden.
  attachTorChannel(channel, isInitiator) {
    this.isInitiator = !!isInitiator;
    this.transport = 'tor';
    this.pc = { iceConnectionState: 'connected', close() {} };
    this.dataChannel = channel;
    this._setupDataChannel(channel);
    Promise.resolve().then(() => { if (!this._closed) channel.onopen?.(); });
  }

  async _withPortMappings(desc) {
    const Pcp = pcpModule();
    if (!Pcp?.map || !desc?.sdp) return desc;
    try {
      const wanted = hostCandidatesForMapping(desc.sdp);
      if (!wanted.length) return desc;
      const mode = await connectionModeForDecision();
      const maxWait = PORT_MAPPING_MAX_WAIT_MS[mode] || PORT_MAPPING_MAX_WAIT_MS[MODE_FAST];
      const pending = Promise.resolve(Pcp.map(wanted, PCP_LIFETIME_S));
      let timer = null;
      const results = await Promise.race([
        pending,
        new Promise(r => { timer = setTimeout(() => r(null), maxWait); }),
      ]);
      clearTimeout(timer);
      if (!Array.isArray(results)) {
        // Router antwortet zu langsam (erste Anfrage im Netz: das native Modul
        // probiert PCP, NAT-PMP und UPnP nacheinander). Das Angebot geht ohne
        // die Freigabe raus; kommt sie spaeter doch, wird sie wie jede andere
        // erneuert und beim Schliessen wieder geloescht - nie verwaist.
        pending.then((late) => this._adoptPortMappings(late, 'spaet')).catch(() => {});
        return desc;
      }
      const ok = this._adoptPortMappings(results, null);
      if (!ok.length || this._closed) return desc;
      const sdp = addMappedCandidates(desc.sdp, ok);
      return sdp === desc.sdp ? desc : { type: desc.type, sdp };
    } catch (e) {
      console.log('[Portfreigabe] nicht verfuegbar:', e?.message || e);
      return desc;
    }
  }

  // Merkt sich erfolgreiche Freigaben (Erneuern alle PCP_RENEW_MS, Loeschen
  // in close()). Ist die Verbindung schon zu, sofort wieder loeschen.
  // Liefert die erfolgreichen Zeilen.
  _adoptPortMappings(results, label) {
    const Pcp = pcpModule();
    if (!Array.isArray(results) || !Pcp?.map) return [];
    const ok = results.filter(r => r && r.result === 'SUCCESS');
    const okMethod = ok.find(r => MAPPING_METHODS.has(r.method))?.method || (ok.length ? 'pcp' : null);
    // Fehlschlag: zuerst ein ausdrueckliches "nicht erlaubt" melden (FritzBox
    // ohne "Selbststaendige Portfreigaben") - das kann der Nutzer aendern.
    const failure = results.find(r => r?.result === 'NOT_AUTHORIZED')?.result || results[0]?.result || 'UNKNOWN';
    lastPortMappingStatus = { at: Date.now(), result: ok.length ? 'SUCCESS' : failure, method: okMethod };
    console.log('[Portfreigabe]' + (label ? ' (' + label + ')' : ''), results.map(r =>
      r.protocol + '/' + (String(r.address).includes(':') ? 'IPv6' : 'IPv4') + ' ' + r.result
      + (r.method ? ' via ' + r.method : '') + (r.attempts ? ' [' + r.attempts + ']' : '')).join(', '));
    if (!ok.length) return ok;
    const fresh = ok.map(r => ({ protocol: r.protocol, address: r.address, port: r.port }));
    if (this._closed) {
      Promise.resolve(Pcp.map(fresh, 0)).catch(() => {});
      return ok;
    }
    const key = (m) => m.protocol + '|' + m.address + '|' + m.port;
    const merged = new Map((this._pcpMappings || []).map(m => [key(m), m]));
    for (const m of fresh) merged.set(key(m), m);
    this._pcpMappings = [...merged.values()];
    if (this._pcpRenew) clearInterval(this._pcpRenew);
    this._pcpRenew = setInterval(() => {
      const mod = pcpModule();
      if (!this._closed && this._pcpMappings && mod?.map) Promise.resolve(mod.map(this._pcpMappings, PCP_LIFETIME_S)).catch(() => {});
    }, PCP_RENEW_MS);
    this._pcpRenew?.unref?.();
    return ok;
  }

  // Verbindungsweg gewechselt (Stufe 1 <-> 2, DirectUpgrade.applyConnectionMode):
  // neue ICE-Konfiguration fuer diese bestehende Direktverbindung - wirksam ab
  // dem naechsten ICE-Neustart (neue Kandidaten ohne bzw. mit STUN).
  async applyConnectionModeConfig() {
    if (this._closed || !this.pc || this.transport !== 'direct' || typeof this.pc.setConfiguration !== 'function') return false;
    const cfg = await _pcConfig();
    if (this._closed || !this.pc) return false;
    this.pc.setConfiguration(cfg);
    return true;
  }

  async handleAnswer(answerJSON) {
    const answer = JSON.parse(answerJSON);
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer.sdp));
  }

  async createAnswerDirect(offerJSON) {
    this.isInitiator = false;
    this.pc = new RTCPeerConnection(await _pcConfig());
    this._setupPC();
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._setupDataChannel(this.dataChannel);
    };
    const offer = JSON.parse(offerJSON);
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._waitForICE();
    return JSON.stringify({ sdp: await this._withPortMappings(this.pc.localDescription) });
  }

  // Historisch gab es hier zusaetzlich einen Nebeneffekt: die lokale Answer-
  // SDP (DTLS-Fingerprint, ICE-Kandidaten) wurde UNVERSCHLUESSELT unter einem
  // eigenen Zufalls-Token per sendSignalOffer() an den Relay gepostet. Dieser
  // Token wurde nirgendwo im Code je wieder abgeholt (this.sessionToken war
  // komplett ungelesen) - reiner Klartext-Leak ohne jede Funktion, der jeden
  // Aufrufer dieser Methode betraf (urspruengliches QR-Pairing UND, bis vor
  // kurzem, den Reconnect-Pfad). Sicherheitsreview C-1/Folgefund: entfernt.
  // createAnswer() ist jetzt inhaltlich identisch zu createAnswerDirect() -
  // als eigene Methode belassen, um alle bestehenden Aufrufstellen (die den
  // Rueckgabewert mit "type":"offer" erwarten) unveraendert zu lassen.
  async createAnswer(offerJSON) {
    this.isInitiator = false;
    this.pc = new RTCPeerConnection(await _pcConfig());
    this._setupPC();
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._setupDataChannel(this.dataChannel);
    };
    const offer = JSON.parse(offerJSON);
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._waitForICE();
    return JSON.stringify({ sdp: await this._withPortMappings(this.pc.localDescription), type: 'offer' });
  }

  // Rueckgabewert praezisiert (State-Machine-Review Fund 7): vorher lieferte
  // diese Funktion fuer zwei GRUNDVERSCHIEDENE Faelle dasselbe `true` zurueck
  // - (a) die Nachricht wurde wirklich an einen offenen DataChannel
  // uebergeben, und (b) es gab noch gar kein Shared Secret, die Nachricht
  // landete nur im nicht-dauerhaften pendingMsgs-Array. Der Aufrufer konnte
  // (a) und (b) nicht unterscheiden und zeigte in beiden Faellen "✓ gesendet"
  // an - ein App-Kill vor _flushPending() verlor die Nachricht (b) dann
  // lautlos, obwohl die UI bereits Erfolg gemeldet hatte. Jetzt: 'sent' nur
  // fuer (a), 'queued' fuer (b), false wenn gar nicht zustellbar. Bewusst
  // OHNE neuen Netzwerk-Bestaetigungsschritt - das ist reine lokale
  // Ehrlichkeit ueber einen bereits vorhandenen Unterschied, kein neues
  // Protokoll.
  sendMessage(raw) {
    if (this.dataChannel?.readyState !== 'open') return false;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Konnte die Nachricht nicht einmal als JSON lesen - im Zweifel
      // NICHT unverschlüsselt senden, sondern verwerfen und melden.
      console.warn('[WebRTC] sendMessage: ungültiges JSON, verworfen statt unverschlüsselt gesendet');
      return false;
    }
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[WebRTC] sendMessage: kein Nachrichtenobjekt, verworfen');
      return false;
    }

    // Key-Exchange Nachrichten immer plain (Verschlüsselung noch nicht aktiv,
    // hier ist Klartext beabsichtigt und unbedenklich - kein geheimes Material)
    if (parsed.type === 'system' &&
        (parsed.subtype === 'kyber_pubkey' || parsed.subtype === 'kyber_ciphertext')) {
      this.dataChannel.send(raw);
      return 'sent';
    }

    // Noch kein Shared Secret: NICHT unverschlüsselt senden, sondern
    // zurückhalten. Wird automatisch verschickt, sobald _flushPending()
    // nach abgeschlossenem Schlüsselaustausch läuft.
    if (!this.sharedSecret) {
      this.pendingMsgs.push(raw);
      return 'queued';
    }

    // Zeitfenster-Fix (Live-Test entdeckt: Nachricht beim Umschalten des
    // Flugmodus verschickt, als "gesendet" markiert, kam aber nie an und
    // wurde auch nie nachgeliefert): die obige readyState-Pruefung ist
    // synchron, das eigentliche Senden hier unten passiert aber erst NACH
    // der asynchronen Verschluesselung - die Verbindung kann genau in
    // diesem Zeitfenster wegbrechen, ohne dass die Pruefung von oben das
    // noch mitbekommen hat. readyState deshalb direkt vor dem tatsaechlichen
    // Senden ERNEUT pruefen; schlaegt das (oder die Verschluesselung selbst)
    // fehl, die Nachricht in pendingMsgs ablegen statt sie stillschweigend
    // zu verlieren - _flushPending() liefert sie automatisch nach, sobald
    // die naechste Verbindung ihren Schluesselaustausch abschliesst (siehe
    // identisches, bereits bestehendes Muster fuer "noch kein Shared Secret"
    // oben). Der Rueckgabewert bleibt optimistisch 'sent' (die UI zeigt das
    // sofort an) - der eigentliche Gewinn ist, dass ein Fehlschlag in diesem
    // Fenster die Nachricht nicht mehr verliert, sondern automatisch erneut
    // versucht.
    // Double Ratchet: sealForConnection() verschluesselt bei Ratchet-Kontakten
    // zusaetzlich mit einem eigenen Schluessel pro Nachricht. Scheitert das
    // (z.B. Speicherfehler), wird NICHT auf das alte Verfahren ausgewichen.
    sealForConnection(this, parsed).then((wire) => {
      if (!wire) {
        console.warn('[WebRTC] Verschluesselung fehlgeschlagen, Nachricht fuer naechste Verbindung zurueckgehalten');
        this.pendingMsgs.push(raw);
        return;
      }
      if (this.dataChannel?.readyState === 'open') {
        this.dataChannel.send(wire);
      } else {
        console.warn('[WebRTC] DataChannel brach waehrend des Sendens weg, Nachricht fuer naechste Verbindung zurueckgehalten');
        this.pendingMsgs.push(raw);
      }
    }).catch((e) => {
      console.warn('[WebRTC] Verschluesselung fehlgeschlagen, Nachricht fuer naechste Verbindung zurueckgehalten:', e?.message || e);
      this.pendingMsgs.push(raw);
    });
    return 'sent';
  }

  // Wie sendMessage(), aber wartet, bis die Nachricht verschluesselt an den
  // Kanal uebergeben ist (true) - fuer Bestaetigungen, nach denen die
  // Verbindung sofort geschlossen wird (empfangener delete_chat, RTCStore.js).
  async sendMessageAndWait(raw) {
    if (this.dataChannel?.readyState !== 'open' || !this.sharedSecret) return false;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return false; }
    let wire = null;
    try { wire = await sealForConnection(this, parsed); } catch (e) {
      console.warn('[WebRTC] Verschluesselung fehlgeschlagen:', e?.message || e);
      return false;
    }
    if (!wire || this.dataChannel?.readyState !== 'open') return false;
    this.dataChannel.send(wire);
    return true;
  }

  // Medien bei Ratchet-Kontakten (MediaKey.js): Chunks nur mit der
  // Verbindungsschicht, End-Marker (mit dem Dateischluessel) durch den
  // Ratchet. null = keine Sitzung, bisheriges Verfahren. avatar: Profilbild
  // (Kennzeichen innen statt nur im ungeschuetzten Aussenumschlag).
  async mediaSealer({ avatar = false } = {}) {
    if (!this.chatId || !this.sharedSecret) return null;
    if (!(await RatchetSession.hasSession(this.chatId))) return null;
    const send = async (obj) => {
      const wire = await sealForConnection(this, avatar ? { ...obj, isAvatarChunk: true } : obj);
      if (!wire) throw new Error('Verschluesselung fehlgeschlagen');
      if (this._closed || this.dataChannel?.readyState !== 'open') throw new Error('DataChannel nicht offen');
      this.dataChannel.send(wire);
    };
    return { chunk: send, end: send };
  }

  sendTyping() {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'typing' }));
    }
  }

  async startCall(video = false) {
    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user' } : false,
    });
    stream.getTracks().forEach(track => this.pc.addTrack(track, stream));
    return stream;
  }

  // Review-Fund 2026-09-27 ("H3"): einziger Weg, onDisc() aufzurufen - stellt
  // sicher, dass er pro Instanz hoechstens einmal feuert, egal ueber welchen
  // der mehreren Pfade (ICE 'failed'/'disconnected', Checking-Timeout,
  // dataChannel.onclose) er ausgeloest wird.
  _fireDisc() {
    if (this._discFired) return;
    this._discFired = true;
    this.onDisc?.();
  }

  // reason: 'wipe' NUR aus RTCStore.clearContact()/resetAll() (Kontakt
  // loeschen / Geraet zuruecksetzen) - alle anderen Aufrufer sind normale
  // Verbindungsabbrueche. Siehe _closeReason-Auswertung in den kyber-Handlern.
  close(reason = 'disconnect') {
    if (!this._closed) this._closeReason = reason;
    if (this._coverTraffic) {
      clearInterval(this._coverTraffic);
      this._coverTraffic = null;
    }
    if (this._livenessWatch) {
      clearInterval(this._livenessWatch);
      this._livenessWatch = null;
    }
    if (this._iceCheckingTimeout) {
      clearTimeout(this._iceCheckingTimeout);
      this._iceCheckingTimeout = null;
    }
    if (this._keyExchangeWatch) {
      clearTimeout(this._keyExchangeWatch);
      this._keyExchangeWatch = null;
    }
    if (this._iceRecheckTimer) {
      clearTimeout(this._iceRecheckTimer);
      this._iceRecheckTimer = null;
    }
    if (this._pcpRenew) {
      clearInterval(this._pcpRenew);
      this._pcpRenew = null;
    }
    const Pcp = pcpModule();
    if (this._pcpMappings && Pcp?.map) {
      // Freigabe am Router loeschen - das native Modul nimmt dafuer dasselbe
      // Protokoll (PCP, NAT-PMP oder UPnP), mit dem sie angelegt wurde.
      Promise.resolve(Pcp.map(this._pcpMappings, 0)).catch(() => {});
    }
    this._pcpMappings = null;
    // Review-Fund 2026-09-27 ("H3"): onclose VOR dem close()-Aufruf selbst
    // nullen - dataChannel.close() loest onclose in der Regel asynchron aus,
    // was ohne dies (bei einem der 'failed'/'disconnected'-Pfade unten, die
    // close() bereits selbst synchron aufrufen) zu einem zweiten,
    // ueberfluessigen _fireDisc()-Aufruf gefuehrt haette. _fireDisc()s eigene
    // Sperre haette das zwar ohnehin abgefangen, aber sauberer, das
    // asynchrone Nachfeuern gar nicht erst auszuloesen.
    if (this.dataChannel) this.dataChannel.onclose = null;
    this.dataChannel?.close();
    this.pc?.close();
    this.pc              = null;
    this.dataChannel     = null;
    this.sharedSecret    = null;
    this.keyExchangeDone = false;
    this.myKyberKeys     = null;
    this.safetyCode      = null;
    // Konkurrenz-Review-Fund: `close()` nullte bisher `this.onMessage` nicht.
    // rtc.onMessage ist der Callback, den RTCStore.setConnection() genau
    // EINMAL pro Verbindung setzt (Closure ueber chatId/this.listeners/
    // this.buffer) - solange er nicht selbst genullt wird, feuert er weiter,
    // wenn ein bereits laufender channel.onmessage-Handler NACH diesem
    // close()-Aufruf noch an einem `await` haengt (z.B. der sequenzbewusste
    // Replay-Check `await isNewerThanLastAcceptedSystemTs(...)` fuer
    // secret_start/secret_end/delete_chat/transfer_ready weiter unten) und
    // beim Fortsetzen `this.onMessage?.(original)` aufruft. Da RTCStore's
    // Closure bei fehlendem Listener `this.buffer.set(chatId, [])`
    // NEU ANLEGT statt nur zu pruefen, wuerde genau das den Buffer-Eintrag
    // eines gerade per clearContact()/resetAll() geloeschten Kontakts
    // wiederherstellen - direkt nach dem vermeintlich vollstaendigen
    // Loeschen/Wipe. Nullen hier schliesst das an der Quelle, fuer jeden
    // Nachrichtentyp, ohne jede einzelne await-Stelle einzeln absichern zu
    // muessen.
    this.onMessage       = null;
    // Siehe Kommentar im Konstruktor - macht close() fuer einen bereits
    // laufenden Kyber-Handler beobachtbar, auch wenn dieser durch das
    // Nullen obiger Felder allein nicht gestoppt wird.
    this._closed         = true;
  }

  _setupPC() {
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      console.log('[WebRTC] ICE State:', state);
      if (state === 'connected' || state === 'completed') {
        if (this._iceCheckingTimeout) {
          clearTimeout(this._iceCheckingTimeout);
          this._iceCheckingTimeout = null;
        }
        this.onConnected?.();
        if (!this._pathLogged) {
          this._pathLogged = true;
          this._logSelectedPath('verbunden');
          setTimeout(() => { if (!this._closed) this._logSelectedPath('nach 5s'); }, 5000);
        }
      }
      if (state === 'checking' && !this._iceCheckingTimeout) {
        // Live-Test entdeckt (Auto-Reconnect nach App-Kill+Neustart auf
        // beiden Geraeten): genau das im Kommentar bei _waitForICE() bereits
        // dokumentierte Risiko - ICE blieb ueber 90+ Sekunden regungslos bei
        // "checking" haengen, ohne dass der native WebRTC-Stack jemals
        // 'failed'/'disconnected' ausloeste. Da onDisc() dadurch nie feuerte,
        // blieben initiatorAttempting/responderConnecting (App.tsx) fuer
        // immer blockiert - kein weiterer Reconnect-Versuch fand je statt,
        // obwohl der Kontakt dauerhaft als "nicht verbunden" haengen blieb.
        // _waitForICE() wartet nur auf ICE GATHERING (lokale Kandidaten
        // sammeln), nicht auf tatsaechliche Konnektivitaet - dieser Wachhund
        // schliesst genau die Luecke danach: kommt ICE nicht innerhalb von
        // ICE_CHECKING_TIMEOUT_MS zustande, aktiv als gescheitert behandeln
        // statt endlos zu warten.
        this._iceCheckingTimeout = setTimeout(() => {
          this._iceCheckingTimeout = null;
          const stillStuck = this.pc?.iceConnectionState !== 'connected' &&
                              this.pc?.iceConnectionState !== 'completed';
          if (stillStuck) {
            console.warn('[WebRTC] ICE haengt seit', ICE_CHECKING_TIMEOUT_MS, 'ms in "checking" fest - als gescheitert behandelt');
            this._fireDisc();
            // Review-Fund 2026-09-27 ("H3"): fehlte hier bisher komplett
            // (anders als bei 'failed'/'disconnected' unten) - pc/dataChannel
            // samt ihrer zwei TURN-Allokationen blieben nach diesem Timeout
            // fuer die gesamte Lebensdauer der (von App.tsx bereits
            // verworfenen) Instanz bestehen. Bei dauerhaft fehlender
            // Konnektivitaet (z.B. das Mobilfunk-Filter-Szenario) entsteht so
            // bei jedem 20s-Zyklus ein neues Leck - ein plausiblerer
            // Kandidat fuer den beobachteten Mehrstunden-Crash als die
            // Poll-Intervalle.
            this.close();
          }
        }, ICE_CHECKING_TIMEOUT_MS);
      }
      if (state === 'failed') {
        if (this._iceCheckingTimeout) {
          clearTimeout(this._iceCheckingTimeout);
          this._iceCheckingTimeout = null;
        }
        // Laeuft gerade ein ICE-Neustart (Netzwechsel, siehe DirectUpgrade.js),
        // erst nach dessen Frist erneut pruefen - sonst wuerde genau die
        // Verbindung geschlossen, die gerade auf das neue Netz umzieht.
        if (this._iceRestartPending()) return;
        // Nur bei echtem Fehler reconnecten
        this._fireDisc();
        // Live-Test-Fund 2026-09-27: hier fehlte bisher close() (anders als
        // bei der Zombie-Watch unten) - pc/dataChannel blieben nach einem
        // echten ICE-Fehler technisch bestehen, dataChannel.readyState also
        // weiterhin 'open'. Die Chat-UI (isConnected in ChatScreen) prueft
        // zusaetzlich zum korrekten RTCStore-Status auch diesen rohen
        // readyState als Fallback - blieb er faelschlich 'open', zeigte "●
        // P2P verbunden" dauerhaft weiter an, obwohl die Verbindung laengst
        // tot war (onDisc() hatte den Reconnect-Kreislauf zwar schon korrekt
        // neu gestartet, nur eben ohne die alten Objekte selbst zu schliessen).
        this.close();
      }
      if (state === 'disconnected') {
        // Kurz warten – manchmal erholt sich ICE selbst
        setTimeout(() => {
          if (this.pc?.iceConnectionState === 'disconnected' ||
              this.pc?.iceConnectionState === 'failed') {
            if (this._iceRestartPending()) return;
            this._fireDisc();
            // Siehe Kommentar bei state === 'failed' oben - identischer Fix.
            this.close();
          }
        }, 3000);
      }
    };
    this.pc.onicecandidateerror = (e) => console.warn('[WebRTC] ICE Error:', e.errorText);
  }

  // Diagnose (Nur-P2P-Umstellung): welcher Netzwerkpfad wurde gewaehlt
  // (Kandidatentyp/Protokoll/IP-Version/Netztyp - bewusst OHNE Adressen) und
  // fliessen darueber tatsaechlich Daten in beide Richtungen?
  async _logSelectedPath(label) {
    try {
      const report = await this.pc?.getStats?.();
      if (!report) return;
      const all = [];
      report.forEach(r => all.push(r));
      const byId = new Map(all.map(r => [r.id, r]));
      const transport = all.find(r => r.type === 'transport' && r.selectedCandidatePairId);
      const pair = (transport && byId.get(transport.selectedCandidatePairId))
        || all.find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
      if (!pair) { console.log('[WebRTC] Pfad (' + label + '): kein gewaehltes Kandidatenpaar'); return; }
      const describe = (c) => {
        if (!c) return '?';
        const addr = String(c.address || c.ip || '');
        return [c.candidateType, c.protocol, addr.includes(':') ? 'IPv6' : 'IPv4', c.networkType || '-'].join('/');
      };
      console.log('[WebRTC] Pfad (' + label + '): lokal', describe(byId.get(pair.localCandidateId)),
        '-> entfernt', describe(byId.get(pair.remoteCandidateId)),
        '| Bytes gesendet/empfangen:', pair.bytesSent, '/', pair.bytesReceived);
    } catch (e) {
      console.log('[WebRTC] Pfad-Statistik nicht verfuegbar:', e?.message || e);
    }
  }

  // ── ICE-Neustart (Netzwechsel, siehe DirectUpgrade.js) ────────────────────
  // Zieht eine bestehende Direktverbindung auf neue Kandidaten (neues Netz)
  // um, statt sie zu schliessen. DTLS, DataChannel und der Kyber-Schluessel
  // dieser Verbindung bleiben erhalten - kein neuer Schluesseltausch noetig.
  // Angebot/Antwort laufen verschluesselt ueber die Verbindung selbst (der
  // alte Pfad traegt nach einem Wechsel oft noch einige Sekunden).
  _beginIceRestart() {
    this._iceRestartUntil = Date.now() + ICE_RESTART_GRACE_MS;
    this._pathLogged = false;
  }

  // true, solange ein ICE-Neustart laeuft - plant dann selbst eine erneute
  // Pruefung nach Ablauf der Frist ein (siehe 'failed'/'disconnected' oben).
  _iceRestartPending() {
    const left = (this._iceRestartUntil || 0) - Date.now();
    if (left <= 0 || this._closed) return false;
    if (!this._iceRecheckTimer) {
      this._iceRecheckTimer = setTimeout(() => {
        this._iceRecheckTimer = null;
        if (this._closed) return;
        const s = this.pc?.iceConnectionState;
        if (s === 'disconnected' || s === 'failed') {
          console.warn('[WebRTC] ICE-Neustart hat die Verbindung nicht gerettet - wird geschlossen');
          this._fireDisc();
          this.close();
        }
      }, left + 500);
      this._iceRecheckTimer?.unref?.();
    }
    console.log('[WebRTC] ICE', this.pc?.iceConnectionState, 'waehrend ICE-Neustart - warte auf den neuen Pfad');
    return true;
  }

  async createIceRestartOffer() {
    if (this._closed || !this.pc || this.transport !== 'direct') throw new Error('keine Direktverbindung');
    this._beginIceRestart();
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    await this._waitForFreshICE();
    return this._plainLocalDescription();
  }

  async acceptIceRestartOffer(desc) {
    if (this._closed || !this.pc || this.transport !== 'direct') throw new Error('keine Direktverbindung');
    this._beginIceRestart();
    // Beide Seiten haben gleichzeitig neu gestartet: eigenes Angebot
    // zuruecknehmen (DirectUpgrade entscheidet vorher, wessen Angebot gilt).
    if (this.pc.signalingState === 'have-local-offer') {
      await this.pc.setLocalDescription({ type: 'rollback', sdp: '' });
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._waitForFreshICE();
    return this._plainLocalDescription();
  }

  async acceptIceRestartAnswer(desc) {
    if (this._closed || !this.pc) return false;
    if (this.pc.signalingState && this.pc.signalingState !== 'have-local-offer') return false;
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
    return true;
  }

  _plainLocalDescription() {
    const d = this.pc?.localDescription;
    return d ? { type: d.type, sdp: d.sdp } : null;
  }

  // Wie _waitForICE(), aber fuer eine NEUE Sammelrunde auf einer bestehenden
  // Verbindung: der alte Zustand 'complete' zaehlt dabei nicht. Bewusst kurz -
  // nach einem Netzwechsel zaehlt jede Sekunde.
  _waitForFreshICE(maxMs = ICE_RESTART_GATHER_MS) {
    return new Promise((resolve) => {
      let done = false;
      let firstTimer = null;
      let maxTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(firstTimer);
        clearTimeout(maxTimer);
        resolve();
      };
      maxTimer = setTimeout(finish, maxMs);
      if (!this.pc) { finish(); return; }
      this.pc.onicecandidate = (event) => {
        if (!event?.candidate) { finish(); return; }
        if (!firstTimer) firstTimer = setTimeout(finish, 1000);
      };
      this.pc.onicegatheringstatechange = () => {
        if (this.pc?.iceGatheringState === 'complete') finish();
      };
    });
  }

  _setupDataChannel(channel) {
    channel.onopen = async () => {
      console.log('[WebRTC] DataChannel offen ✅');
      this.onConnected?.();
      // onConnected kann diese Verbindung bereits verworfen haben (z.B. ein
      // doppelter Tor-Kanal, siehe TorTransport.attachSession).
      if (this._closed) return;
      // Siehe KEY_EXCHANGE_TIMEOUT_MS oben.
      if (!this._keyExchangeWatch) {
        this._keyExchangeWatch = setTimeout(() => {
          this._keyExchangeWatch = null;
          if (this._closed || this.keyExchangeDone) return;
          console.warn('[Crypto] Schluesselaustausch nach', KEY_EXCHANGE_TIMEOUT_MS, 'ms nicht abgeschlossen - Verbindung wird neu aufgebaut');
          this._logSelectedPath('Schluesselaustausch haengt');
          this._fireDisc();
          this.close();
        }, KEY_EXCHANGE_TIMEOUT_MS);
        this._keyExchangeWatch?.unref?.();
      }
      if (this.isInitiator) {
        try {
          this.myKyberKeys = await generateKyberKeypair();
          channel.send(JSON.stringify({
            type: 'system',
            subtype: 'kyber_pubkey',
            publicKey: this.myKyberKeys.publicKey,
          }));
          console.log('[Crypto] ✅ Kyber Public Key gesendet');
          setTimeout(() => {
            if (!this._closed && !this.keyExchangeDone) {
              console.log('[WebRTC] Nach 3s noch kein Kyber-Ciphertext - im Sendepuffer:', channel.bufferedAmount, 'Bytes, readyState:', channel.readyState);
            }
          }, 3000)?.unref?.();
        } catch(e) {
          // Fehlerbehandlungs-Review: gleiche Sanitisierung wie die bereits
          // bereinigten Catch-Bloecke in MessageCrypto.js/ImageCrypto.js/
          // AudioCrypto.js (SECURITY_SECRETS_LIFECYCLE_FIXES.md Fix 8) - dieser
          // hier (Kyber-Handshake-Start) war davon nicht erfasst.
          console.error('[Crypto] Key Exchange fehlgeschlagen:', e?.message || e);
        }
      }
    };

    channel.onclose = () => {
      console.log('[WebRTC] DataChannel geschlossen');
      this._fireDisc();
      // Live-Test Okt. 2026 ("alte Tor-Verbindung wird erst nach 15 s als
      // Zombie geschlossen"): wurde nur der Kanal geschlossen (z.B. alle
      // Tor-Kanaele beim Tor-Neustart nach einem Netzwechsel, stopTor()),
      // liefen Cover-Traffic und Lebenszeichen-Waechter dieser Instanz weiter,
      // bis der Waechter sie nach 15 s Stille selbst schloss. Ein geschlossener
      // Kanal macht die Verbindung endgueltig unbrauchbar - sofort aufraeumen.
      if (!this._closed) this.close();
    };

    channel.onmessage = async (event) => {
      this._lastActivity = Date.now();
      this._probeSentAt = 0;
      if (!this.keyExchangeDone) {
        console.log('[WebRTC] Nachricht vor Schluesselaustausch empfangen,', typeof event.data === 'string' ? event.data.length + ' Zeichen' : 'binaer');
      }
      // Laeuft gerade der Kyber-Schritt (nativer Aufruf + Speichern dauern
      // einige Millisekunden), duerfen direkt dahinter eintreffende
      // verschluesselte Nachrichten nicht verworfen werden ("kein Shared
      // Secret") - sie warten auf das Ende des Schluesseltauschs (siehe
      // 'encrypted'-Zweig unten). Wichtig v.a. beim Wechsel Tor -> direkt
      // (DirectUpgrade.js), wo die Gegenseite sofort weitersendet.
      let releaseKx = null;
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === 'system' && KYBER_HANDSHAKE_SUBTYPES.has(msg.subtype)
            && !this.keyExchangeDone && !this._kxPending) {
          this._kxPending = new Promise((r) => { releaseKx = r; });
        }

        if (msg.type === 'system' && msg.subtype === 'kyber_pubkey') {
          // Zustandspruefung (State-Machine-Review): kyber_pubkey/kyber_ciphertext
          // wurden bisher IMMER verarbeitet, egal ob fuer diese Verbindung schon
          // ein Schluesselaustausch abgeschlossen war (keyExchangeDone). Ein
          // dupliziertes oder auf dem DataChannel wiedereingespieltes
          // kyber_pubkey (der Live-P2P-Pfad hat, anders als der Relay-Fallback,
          // keinen Timestamp-/Replay-Schutz - siehe SECURITY_AUDIT_CRYPTO_CLAIMS
          // Claim 6) hat bisher unbemerkt this.sharedSecret MITTEN in der
          // Sitzung durch ein frisches Encapsulate ueberschrieben - jede gerade
          // in Zustellung befindliche Chiffre unter dem alten Secret wurde damit
          // unentschluesselbar, ohne dass Nutzer oder App etwas davon erfahren
          // haetten. Jetzt: nach abgeschlossenem Austausch wird ein erneutes
          // kyber_pubkey/kyber_ciphertext fuer dieselbe Verbindung verworfen
          // statt erneut verarbeitet.
          if (this.keyExchangeDone) {
            console.warn('[Crypto] kyber_pubkey nach bereits abgeschlossenem Schluesselaustausch verworfen (Duplikat/Replay)');
            return;
          }
          // Pro Verbindung genau EIN Schluesseltausch - auch ein Duplikat, das
          // eintrifft, WAEHREND der erste noch laeuft (Kapseln + Speichern
          // dauern), wird verworfen statt parallel ein zweites Secret zu bilden.
          if (this._kxStarted) {
            console.warn('[Crypto] Weiteres kyber_pubkey waehrend laufendem Schluesselaustausch verworfen');
            return;
          }
          this._kxStarted = true;
          console.log('[Crypto] Kyber Public Key empfangen → encapsulate');
          const result = await kyberEncapsulate(msg.publicKey);
          // Hidden-Bug-Hunt-Fund (siehe Konstruktor-Kommentar): close() kann
          // waehrend dieses Bridge-Aufrufs gelaufen sein (5-Fail-Wipe/Chat-
          // Loeschen/ueberholter Reconnect via RTCStore.setConnection). Ohne
          // diese Pruefung wuerde der Handler unten RTCStore.sharedSecrets
          // und die persistente Ablage fuer einen bereits geschlossenen/
          // geloeschten Kontakt erneut befuellen - direkt nach einem
          // vermeintlich vollstaendigen Wipe.
          if (this._closed) {
            console.warn('[Crypto] Verbindung waehrend Kyber-Encapsulate geschlossen - Ergebnis verworfen statt Secret wiederherzustellen');
            return;
          }
          // Double Ratchet, Post-Quanten-Schritt (RatchetSession.js): die
          // Gegenseite mischt dieses ML-KEM-Geheimnis in ihren naechsten
          // DH-Schritt - wir muessen es dann nachrechnen koennen. Eingetragen
          // wird es in der Ratchet-Sperre dieses Kontakts, und zwar hier,
          // BEVOR der Ciphertext rausgeht: jede Ratchet-Nachricht, die sich
          // darauf bezieht, kann erst nach dem Ciphertext entstehen und wird
          // deshalb in derselben Sperre erst danach geoeffnet. Bewusst nicht
          // abgewartet - Speicherfehler bleiben wie beim Secret selbst
          // nicht-fatal (der Eintrag bleibt dann im Arbeitsspeicher und geht
          // mit dem naechsten Ratchet-Speichervorgang mit).
          if (this.chatId) {
            RatchetSession.noteConnectionKem(this.chatId, result.sharedSecret, 'encap')
              .catch(e => console.warn('[Crypto] KEM-Geheimnis nicht fuer den Ratchet vorgemerkt:', e?.message || e));
          }
          this.sharedSecret    = result.sharedSecret;
          this.keyExchangeDone = true;
          channel.send(JSON.stringify({
            type: 'system',
            subtype: 'kyber_ciphertext',
            cipherText: result.cipherText,
          }));
          // SharedSecret im RTCStore speichern + persistent. Chaos-Test-Fund
          // (SECURITY_CHAOS_TESTING.md §9, Fix 2): dieser Schreibvorgang war
          // vorher fire-and-forget (`.then()` ohne `await`) - stirbt der
          // Prozess in genau diesem Fenster, glaubt die App (RAM-Zustand
          // bereits gesetzt, _flushPending/_onKeyExchange laufen schon
          // weiter) faelschlich, die Sitzung sei durabel abgeschlossen,
          // waehrend auf der Platte nichts landete. Jetzt: awaiten, bevor
          // irgendetwas (_flushPending, Cover-Traffic, _onKeyExchange) sich
          // auf diese Pairing als abgeschlossen/durabel verlaesst. Ein reiner
          // Speicherfehler (Disk voll o.ae.) soll den Handshake selbst nicht
          // zum Absturz bringen - deshalb weiterhin catch(), nur nicht mehr
          // stillschweigend (geloggt statt verschluckt).
          if (this.chatId) {
            await this._rememberPreviousSecret();
            RTCStore.sharedSecrets.set(this.chatId, this.sharedSecret);
            await EncryptedStorage.setItem('shared_secret_' + this.chatId, this.sharedSecret)
              .catch(e => console.warn('[Crypto] Persistieren des Shared Secret fehlgeschlagen (Responder):', e));
            // Konkurrenz-Review-Fund: der bereits vorhandene `_closed`-Schutz
            // oben deckt nur das Fenster VOR diesem Block ab (waehrend
            // kyberEncapsulate() lief). close() kann genausogut WAEHREND
            // dieses awaiteten Disk-Writes laufen (RTCStore.sharedSecrets.set()
            // direkt darueber ist bereits synchron gelaufen, BEVOR dieser
            // await ueberhaupt beginnt) - dann waere der Eintrag im RTCStore
            // schon "wiederhergestellt", obwohl clearContact()/resetAll()
            // ihn gerade erst geloescht hatte. Nach dem Write erneut pruefen
            // und beides (RAM + Disk) wieder entfernen, statt den Zustand vor
            // dem Loeschen/Wipe stehen zu lassen.
            if (this._closed) {
              // Audit 2026-09-28: dieses Entfernen darf NUR fuer einen echten
              // Wipe/Kontakt-Loeschen gelten (dafuer war es gedacht). close()
              // laeuft aber auch bei ganz normalem Verbindungsverlust (ICE
              // 'failed', Zombie-Watch, ersetzte Verbindung) - dann loeschte
              // dieser Zweig das GERADE ausgehandelte Secret komplett aus RAM
              // und Speicher. Der Kontakt hatte danach gar kein Secret mehr:
              // jeder weitere Reconnect wurde mangels Secret ignoriert, fuer
              // immer (nur Neu-Pairing half). Bei normalem Abbruch bleibt das
              // neue Secret jetzt stehen (die Gegenseite hat es ja bereits),
              // das vorherige bleibt als Rueckfall-Kandidat erhalten.
              if (this._closeReason === 'wipe') {
                console.warn('[Crypto] Verbindung waehrend Secret-Persistierung geschlossen (Wipe) - wiederhergestellten Eintrag erneut entfernt');
                RTCStore.sharedSecrets.delete(this.chatId);
                RTCStore.previousSecrets.delete(this.chatId);
                EncryptedStorage.removeItem('shared_secret_' + this.chatId).catch(() => {});
                EncryptedStorage.removeItem('shared_secret_prev_' + this.chatId).catch(() => {});
              }
              return;
            }
          }
          console.log('[Crypto] ✅ Shared Secret gesetzt (Responder)');
          await this._flushPending();
          this._startCoverTraffic();
          this._startLivenessWatch();
          this.safetyCode = await this._computeSafetyCode(this.sharedSecret);
          console.log('[WebRTC] Safety Code berechnet');
          console.log('[WebRTC] Key Exchange abgeschlossen');
          if (this._onKeyExchange) await this._onKeyExchange();
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'kyber_ciphertext') {
          // Siehe Kommentar bei kyber_pubkey oben - gleiche Absicherung.
          if (this.keyExchangeDone) {
            console.warn('[Crypto] kyber_ciphertext nach bereits abgeschlossenem Schluesselaustausch verworfen (Duplikat/Replay)');
            return;
          }
          if (this._kxStarted) {
            console.warn('[Crypto] Weiteres kyber_ciphertext waehrend laufendem Schluesselaustausch verworfen');
            return;
          }
          this._kxStarted = true;
          console.log('[Crypto] Kyber Ciphertext empfangen → decapsulate');
          const decapsulated = await kyberDecapsulate(msg.cipherText, this.myKyberKeys.secretKey);
          // Siehe Kommentar im kyber_pubkey-Handler oben - identische
          // Absicherung fuer die Initiator-Seite.
          if (this._closed) {
            console.warn('[Crypto] Verbindung waehrend Kyber-Decapsulate geschlossen - Ergebnis verworfen statt Secret wiederherzustellen');
            return;
          }
          // Double Ratchet, Post-Quanten-Schritt: dieses ML-KEM-Geheimnis
          // fliesst in unseren naechsten eigenen DH-Schritt (die Gegenseite hat
          // es beim Kapseln eingetragen). Die Ratchet-Sperre ordnet den
          // Eintrag vor jede spaeter ankommende Nachricht; ein Fehler kostet
          // nur den KEM-Beitrag dieser einen Verbindung.
          if (this.chatId) {
            RatchetSession.noteConnectionKem(this.chatId, decapsulated, 'decap')
              .catch(e => console.warn('[Crypto] KEM-Geheimnis nicht fuer den Ratchet vorgemerkt:', e?.message || e));
          }
          this.sharedSecret    = decapsulated;
          this.keyExchangeDone = true;
          // SharedSecret im RTCStore speichern + persistent - siehe
          // ausfuehrlicher Kommentar im kyber_pubkey-Handler oben (Fix 2):
          // awaiten, BEVOR _flushPending/Cover-Traffic/_onKeyExchange sich auf
          // eine durabel abgeschlossene Pairing verlassen.
          if (this.chatId) {
            await this._rememberPreviousSecret();
            RTCStore.sharedSecrets.set(this.chatId, this.sharedSecret);
            await EncryptedStorage.setItem('shared_secret_' + this.chatId, this.sharedSecret)
              .catch(e => console.warn('[Crypto] Persistieren des Shared Secret fehlgeschlagen (Initiator):', e));
            // Siehe identischer Kommentar im kyber_pubkey-Handler oben -
            // zweites Zeitfenster (waehrend des Disk-Writes selbst, nicht nur
            // waehrend kyberDecapsulate()).
            if (this._closed) {
              // Siehe Kommentar im kyber_pubkey-Handler oben (Audit 2026-09-28).
              if (this._closeReason === 'wipe') {
                console.warn('[Crypto] Verbindung waehrend Secret-Persistierung geschlossen (Wipe) - wiederhergestellten Eintrag erneut entfernt');
                RTCStore.sharedSecrets.delete(this.chatId);
                RTCStore.previousSecrets.delete(this.chatId);
                EncryptedStorage.removeItem('shared_secret_' + this.chatId).catch(() => {});
                EncryptedStorage.removeItem('shared_secret_prev_' + this.chatId).catch(() => {});
              }
              return;
            }
          }
          console.log('[Crypto] ✅ Shared Secret gesetzt (Initiator)');
          await this._flushPending();
          this._startCoverTraffic();
          this._startLivenessWatch();
          this.safetyCode = await this._computeSafetyCode(this.sharedSecret);
          console.log('[WebRTC] Safety Code berechnet');
          if (this._onKeyExchange) await this._onKeyExchange();
          return;
        }
        if (msg.type === 'encrypted') {
          if (!this.sharedSecret && this._kxPending) await this._kxPending;
          if (!this.sharedSecret) {
            console.warn('[Crypto] Encrypted msg aber kein Shared Secret');
            return;
          }
          const plaintext = decryptMsg(msg.data, this.sharedSecret);
          if (plaintext) {
            // Erste erfolgreich entschluesselte Nachricht der Gegenseite unter
            // dem NEUEN Secret = beide Seiten haben den Schluesselwechsel
            // abgeschlossen, das vorherige Secret wird nicht mehr gebraucht
            // (siehe _rememberPreviousSecret()).
            if (this._awaitingKeyConfirm) this._confirmNewSecret();
            const outer = JSON.parse(plaintext);
            // Füllfeld aus dem Uniformitäts-Padding wieder entfernen, bevor die
            // Nachricht weiterverarbeitet oder gespeichert wird.
            if (outer && typeof outer === 'object' && outer.p !== undefined) delete outer.p;
            // Double Ratchet: innere Schicht oeffnen bzw. Nachrichten ohne
            // Ratchet bei aktivem Ratchet ablehnen (Downgrade-Schutz).
            const original = await this._openRatchetLayer(outer);
            if (!original) return;
            // Audit C3: Profilbild-Kennzeichen gilt nur INNEN (verschluesselt).
            // Nur aussen gekennzeichnete Teile (aeltere Testversionen) weder
            // als Profilbild noch als Chat-Bild verwenden.
            if (msg.isAvatarChunk && original.isAvatarChunk !== true) return;
            // img_chunk und img_end direkt an RTCStore ohne Log
            if (original.type === 'img_chunk' || original.type === 'img_end') {
              this.onMessage?.(original);
              return;
            }
            // Ready-Signal → Queue abarbeiten
            if (original.type === 'system' && original.subtype === 'ready') {
              console.log('[WebRTC] ✅ Empfänger bereit → Queue starten');
              if (this._onReady) await this._onReady();
              return;
            }

            // Fuellpaket ignorieren - ausser es ist eine Nachfrage ("bist du
            // noch da?", siehe _startLivenessWatch): dann sofort antworten.
            // Antwort und Nachfrage sind selbst Fuellpakete (gleiche Groesse).
            if (original.type === 'dummy') {
              if (original.probe === 1) this._sendProbe(false);
              return;
            }

            // Handshake verarbeiten
            if (original.type === 'system' && original.subtype === 'handshake') {
              console.log('[Handshake] Empfangen, hasAvatar:', original.hasAvatar);
              if (original.hasAvatar && this.chatId) {
                // Prüfen ob Avatar bereits angekommen ist
                if (RTCStore.pendingAvatars?.has(this.chatId)) {
                  // Avatar bereits da → sofort verarbeiten
                  RTCStore.handleProfileAvatar(this.chatId);
                } else {
                  // Avatar kommt noch → warten
                  RTCStore.pendingAvatarExpected = RTCStore.pendingAvatarExpected || new Set();
                  RTCStore.pendingAvatarExpected.add(this.chatId);
                }
              }
              this.onMessage?.(original);
              return;
            }

            // profile_avatar_sent intern verarbeiten (Legacy)
            if (original.type === 'system' && original.subtype === 'profile_avatar_sent') {
              console.log('[Profile] profile_avatar_sent empfangen');
              if (this.chatId) RTCStore.handleProfileAvatar(this.chatId);
              return;
            }
            // Frische-Pruefung fuer normale Chat-Nachrichten, analog zum
            // Relay-Fallback-Pfad (App.tsx) - vorher galt der Schutz nur dort,
            // nicht hier auf dem Live-DataChannel (Sicherheitsaudit). Ein
            // boesartiger TURN-Server oder anderweitig aktiv positionierter
            // Angreifer koennte sonst eine einmal beobachtete, gueltig
            // verschluesselte Live-Nachricht beliebig oft erneut einspielen.
            // Audit 2026-10-19 (T6): NICHT mehr verwerfen - geht die Uhr des
            // Absenders mehr als 15 min nach bzw. 5 min vor, kam die Nachricht
            // sonst NIE an (endlose Wiederholung aus der Warteschlange, ohne
            // Hinweis). Gegen Wiederholung schuetzen inzwischen der Double
            // Ratchet (jede Nachricht eigener Schluessel, Replay-Erkennung), das
            // eigene Kyber-Geheimnis je Verbindung und die dauerhafte
            // msgId-Deduplizierung. Angezeigt wird dann die Empfangszeit.
            if (original.type === 'text' && !isFreshTimestamp(original.time)) {
              original.time = Date.now();
            }
            // Dieselbe Frische-/Reihenfolge-Pruefung wie im Relay-Fallback-Pfad
            // (App.tsx checkIncoming) jetzt auch hier - vorher hatten
            // secret_start/secret_end/delete_chat/transfer_ready auf dem LIVEN
            // Pfad ueberhaupt keinen Schutz (State-Machine-Review Fund 4). Ein
            // aufgezeichnetes secret_start koennte sonst nach einem legitimen
            // secret_end erneut eingespielt werden und einen bereits beendeten
            // Secret Chat unbemerkt reaktivieren.
            const isSystemControl = original.type === 'system' &&
              ['secret_start', 'secret_end', 'delete_chat', 'transfer_ready'].includes(original.subtype);
            if (isSystemControl && this.chatId) {
              // Nur-P2P-Umstellung 2026-09-29: Steuersignale gehen nicht mehr
              // parallel ueber den Relay, sondern warten notfalls in der
              // lokalen Sende-Warteschlange bis zur naechsten direkten
              // Verbindung - ein "Chat geloescht" darf daher Tage alt sein.
              // Das 15-Minuten-Fenster wird fuer sie auf das Warteschlangen-
              // Limit erweitert. Replay bleibt ausgeschlossen: jede Verbindung
              // hat ein eigenes Kyber-Secret (alte Chiffren sind hier nicht
              // entschluesselbar), und innerhalb einer Sitzung verwirft die
              // Reihenfolge-Pruefung darunter jeden bereits gesehenen ts.
              if (!isPlausibleControlTimestamp(original.ts)) {
                console.warn('[Security] Live-Systempaket ohne gueltigen/frischen Zeitstempel verworfen (moeglicher Replay):', original.subtype);
                this._ackDiscardedControl(original);
                return;
              }
              if (!(await isNewerThanLastAcceptedSystemTs(this.chatId, original.ts))) {
                console.warn('[Security] Live-Systempaket mit bereits ueberholtem Zeitstempel verworfen (moeglicher Replay):', original.subtype);
                this._ackDiscardedControl(original);
                return;
              }
            }
            console.log('[WebRTC] ✅ Nachricht entschlüsselt');
            this.onMessage?.(original);
          }
          return;
        }

        // Alles ausser dem Kyber-Handshake wird vom Sender IMMER als
        // {type:'encrypted', data} verschickt (siehe sendMessage()) - ein
        // Klartext-Fallthrough hier wuerde einer Gegenseite (oder einem
        // Angreifer, der ueber einen gekaperten Reconnect zum DataChannel-
        // Peer wurde) erlauben, z.B. delete_chat/secret_end unauthentifiziert
        // direkt einzuschleusen (Sicherheitsreview C-4). Verwerfen statt
        // durchreichen.
        console.warn('[WebRTC] Unerwartete unverschlüsselte Nachricht verworfen:', msg?.type);

      } catch(e) {
        console.warn('[WebRTC] Parse/Decrypt Fehler:', e);
      } finally {
        if (releaseKx) releaseKx();
      }
    };
  }

  // Innere Schicht einer entschluesselten Leitungs-Nachricht (siehe
  // sealForConnection): Ratchet-Umschlaege oeffnen; alles andere nur
  // durchlassen, solange fuer den Kontakt kein Ratchet aktiv ist (oder es ein
  // reines Transportpaket ist). null = verwerfen.
  async _openRatchetLayer(outer) {
    if (!outer || typeof outer !== 'object') return null;
    const chatId = this.chatId;
    if (outer.type === 'ratchet') {
      if (!chatId) {
        console.warn('[Ratchet] Ratchet-Nachricht ohne zugeordneten Kontakt verworfen');
        return null;
      }
      try {
        const text = await RatchetSession.open(chatId, outer, { candidates: this._kemCandidates() });
        const inner = JSON.parse(text);
        if (!inner || typeof inner !== 'object' || inner.type === 'ratchet' || inner.type === 'encrypted') {
          throw new Error('ungueltiger Inhalt');
        }
        if (inner.p !== undefined) delete inner.p;
        return inner;
      } catch (e) {
        console.warn('[Ratchet] Nachricht verworfen:', e?.message || e);
        return null;
      }
    }
    if (chatId && !allowedWithoutRatchet(outer)) {
      let active = true; // im Zweifel (Speicherfehler) ablehnen
      try { active = await RatchetSession.isActive(chatId); } catch {}
      if (active) {
        console.warn('[Ratchet] Nachricht ohne Ratchet bei aktiver Ratchet-Sitzung abgelehnt (Downgrade-Schutz):', outer.type);
        return null;
      }
    }
    return outer;
  }

  // Bekannte Verbindungsgeheimnisse dieses Kontakts - Rueckfall, falls eine
  // KEM-Kennung im Ratchet-Header nicht (mehr) im Vorrat steht.
  _kemCandidates() {
    const out = [];
    if (this.sharedSecret) out.push(this.sharedSecret);
    const active = this.chatId ? RTCStore.connections.get(this.chatId) : null;
    if (active?.sharedSecret) out.push(active.sharedSecret);
    if (this.chatId) out.push(...RTCStore.getSecretCandidates(this.chatId));
    return [...new Set(out)];
  }

  // Audit 2026-09-28 - siehe ausfuehrliche Begruendung bei
  // RTCStore.rememberPreviousSecret(): das bisherige Secret NICHT sofort
  // verwerfen, sondern bis zur Bestaetigung durch die Gegenseite als
  // Rueckfall-Kandidat fuer Reconnect-/Relay-Pfade aufheben. Ohne das endet
  // ein im falschen Moment abgerissener Schluesselwechsel in einem
  // dauerhaften "verbindet nie wieder".
  async _rememberPreviousSecret() {
    const previous = RTCStore.sharedSecrets.get(this.chatId);
    if (!RTCStore.rememberPreviousSecret(this.chatId, previous, this.sharedSecret)) return;
    this._awaitingKeyConfirm = true;
    await EncryptedStorage.setItem('shared_secret_prev_' + this.chatId, previous)
      .catch(e => console.warn('[Crypto] Vorheriges Secret konnte nicht gesichert werden:', e?.message || e));
  }

  _confirmNewSecret() {
    this._awaitingKeyConfirm = false;
    if (!this.chatId) return;
    // Audit 2026-10-19 (T8): Haben sich zwei Verbindungen desselben Kontakts
    // ueberlappend neu verschluesselt, bestaetigt die aeltere nur IHR Secret -
    // das aktuelle ist dann schon das der neueren. Den Rueckfall (vorheriges
    // Secret) dann nicht verwerfen: Bricht der neuere Wechsel ab, waere der
    // Kontakt sonst nicht mehr erreichbar.
    if (this.sharedSecret !== RTCStore.sharedSecrets.get(this.chatId)) return;
    RTCStore.confirmCurrentSecret(this.chatId);
    EncryptedStorage.removeItem('shared_secret_prev_' + this.chatId).catch(() => {});
  }

  // Zustell-Garantie (BackgroundSync-Warteschlange): ein Steuersignal mit
  // ackId, das hier als bereits angewandt (gleicher/aelterer ts) oder als
  // zu alt verworfen wird, ist fast immer die Wiederholung einer Nachricht,
  // deren Bestaetigung unterwegs verloren ging. Trotzdem bestaetigen - sonst
  // wiederholt der Absender endlos. Bestaetigt wird nur "verarbeitet", die
  // Nachricht selbst wirkt weiterhin nicht (Replay-Schutz unveraendert).
  _ackDiscardedControl(original) {
    const key = typeof original?.ackId === 'string' && original.ackId.length <= 128 ? original.ackId : null;
    if (!key || this._closed) return;
    try { this.sendMessage(JSON.stringify({ type: 'receipt', msgId: key, status: 'delivered' })); } catch {}
  }

  async _flushPending() {
    if (this.pendingMsgs.length === 0) return;
    console.log('[Crypto] Sende', this.pendingMsgs.length, 'gepufferte Nachrichten');
    const list = this.pendingMsgs;
    this.pendingMsgs = [];
    const failed = [];
    for (const raw of list) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      try {
        const wire = await sealForConnection(this, parsed);
        if (!wire || this.dataChannel?.readyState !== 'open') { failed.push(raw); continue; }
        this.dataChannel.send(wire);
      } catch (e) {
        console.warn('[Crypto] Gepufferte Nachricht nicht verschluesselbar, bleibt zurueckgehalten:', e?.message || e);
        failed.push(raw);
      }
    }
    // Neu hinzugekommene (waehrend des Abarbeitens) bleiben hinten stehen.
    this.pendingMsgs = [...failed, ...this.pendingMsgs];
  }

  async _computeSafetyCode(sharedSecret) {
    try {
      const { KyberModule } = require('react-native').NativeModules;
      if (KyberModule?.sha256) {
        const hash = await KyberModule.sha256(sharedSecret);
        // 4 Gruppen à 4 Ziffern aus Hash
        const digits = hash.replace(/[^0-9]/g, '').padEnd(16, '0').slice(0, 16);
        return digits.slice(0,4) + '-' + digits.slice(4,8) + '-' + 
               digits.slice(8,12) + '-' + digits.slice(12,16);
      }
    } catch {}
    return null;
  }

  _coverIntervalMs() {
    return this.transport === 'tor' ? TOR_COVER_INTERVAL_MS : COVER_INTERVAL_MS;
  }

  _startCoverTraffic() {
    if (this._coverTraffic) clearInterval(this._coverTraffic);
    this._coverTraffic = setInterval(async () => {
      if (this.dataChannel?.readyState !== 'open') return;
      if (!this.sharedSecret) return;
      try {
        // encryptMsg kommt aus dem statischen Import oben - vorher wurde das
        // Modul hier per await import() bei JEDEM Intervall-Tick (alle
        // COVER_INTERVAL_MS) erneut dynamisch aufgeloest, obwohl es schon
        // geladen war (Simplification-Pass, keine Verhaltensaenderung).
        // Dummy wird exakt wie eine echte Nachricht gepolstert - dadurch sind
        // beide auf der Leitung größengleich und nicht unterscheidbar
        // (sealForConnection: bei Ratchet-Kontakten auf den groesseren Block).
        const wire = await sealForConnection(this, { type: 'dummy' });
        if (wire && this.dataChannel?.readyState === 'open') {
          this.dataChannel.send(wire);
        }
      } catch {}
    }, this._coverIntervalMs()); // fester Takt - siehe Kommentar oben
    console.log('[CoverTraffic] ✅ Gestartet (fester Takt, feste Paketgröße)');
  }

  // Erkennt "Zombie"-Verbindungen: dataChannel.readyState und iceConnectionState
  // bleiben lokal oft minutenlang "offen"/"connected", obwohl die Gegenseite
  // laengst weg ist (z.B. abrupt geschlossener Browser-Tab ohne sauberes
  // WebRTC-Teardown) - RTCStore.isConnected() wuerde das nie bemerken und der
  // Reconnect-Code haette so nie einen Grund, neu zu verbinden. Da ohnehin
  // alle COVER_INTERVAL_MS Cover-Traffic (oder echte Nachrichten) reinkommen
  // muessten, gilt: kommt seit STALE_TIMEOUT_MS gar nichts mehr an, ist die
  // Verbindung tot - Zombie aktiv schliessen, damit der naechste periodische
  // Reconnect-Check (App.tsx) sie als "nicht verbunden" erkennt und neu aufbaut.
  //
  // Live-Test 2026-10-17: Ein Handy mit ausgeschaltetem Bildschirm schlaeft
  // (CPU im Ruhezustand, trotz Vordergrunddienst) und sendet dann keine
  // Fuellpakete - die Gegenseite erklaerte die Verbindung nach 8 s fuer tot,
  // Direktverbindungen flatterten alle 20-30 s. Jetzt: erst NACHFRAGEN. Ein
  // eingehendes Paket weckt das schlafende Geraet, es antwortet sofort. Erst
  // wenn auch auf die Nachfrage nichts kommt, ist die Verbindung tot. Dasselbe
  // gilt fuer ein Geraet, das selbst gerade aufwacht (seine Uhr ist
  // weitergelaufen): erst fragen, nicht sofort schliessen.
  _startLivenessWatch() {
    this._lastActivity = Date.now();
    this._probeSentAt = 0;
    if (this._livenessWatch) clearInterval(this._livenessWatch);
    const STALE_TIMEOUT_MS = this._coverIntervalMs() * (this.transport === 'tor' ? TOR_STALE_FACTOR : 4);
    const PROBE_GRACE_MS = this.transport === 'tor' ? 20000 : 10000;
    this._livenessWatch = setInterval(() => {
      const now = Date.now();
      if (now - this._lastActivity <= STALE_TIMEOUT_MS) return;
      if (!this._probeSentAt) {
        this._probeSentAt = now;
        this._sendProbe(true);
        return;
      }
      if (now - this._probeSentAt > PROBE_GRACE_MS) {
        console.warn('[WebRTC] Keine Antwort auf Nachfrage (still seit', now - this._lastActivity, 'ms) - Verbindung als Zombie erkannt, schließe');
        this._fireDisc();
        this.close();
      }
    }, this._coverIntervalMs() + 1000);
  }

  // Sofort-Nachfrage auf einen Hinweis von aussen (z.B. die Gegenseite hat die
  // Tor-Reserve zum selben Kontakt geschlossen - ihre App oder ihr tor startet
  // vermutlich gerade neu): nicht erst nach der normalen Stille-Frist fragen.
  // Kommt binnen QUICK_PROBE_GRACE_MS gar nichts an (auch kein Fuellpaket),
  // ist die Verbindung tot. Live-Test 2026-10-17: so vergingen 10 s, bis eine
  // tote Direktverbindung erkannt und ueber Tor neu gewaehlt wurde.
  probeNow(reason) {
    if (this._closed || this._quickProbeTimer) return;
    const sentAt = Date.now();
    this._sendProbe(true);
    this._quickProbeTimer = setTimeout(() => {
      this._quickProbeTimer = null;
      if (this._closed || this._lastActivity > sentAt) return;
      console.warn('[WebRTC] Keine Antwort auf Sofort-Nachfrage (' + reason + ') - Verbindung tot, schließe');
      this._fireDisc();
      this.close();
    }, QUICK_PROBE_GRACE_MS);
    this._quickProbeTimer?.unref?.();
  }

  // Nachfrage (probe) bzw. Antwort darauf - als Fuellpaket, damit sie auf der
  // Leitung nicht von Cover-Traffic unterscheidbar ist.
  async _sendProbe(isQuestion) {
    try {
      if (this.dataChannel?.readyState !== 'open' || !this.sharedSecret) return;
      const wire = await sealForConnection(this, isQuestion ? { type: 'dummy', probe: 1 } : { type: 'dummy', ack: 1 });
      if (wire && this.dataChannel?.readyState === 'open') this.dataChannel.send(wire);
    } catch {}
  }

  _waitForICE() {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') { resolve(); return; }
      let resolved = false;
      let firstCandidateTimer = null;
      const done = () => {
        if (resolved) return;
        resolved = true;
        if (firstCandidateTimer) clearTimeout(firstCandidateTimer);
        resolve();
      };
      this.pc.onicegatheringstatechange = () => {
        if (this.pc?.iceGatheringState === 'complete') done();
      };
      // Produktionsreife-Fund (Play-Store-Vorbereitung, Live-Test 2026-09-27):
      // bisher wurde IMMER auf das ENDE des kompletten Gatherings (oder den
      // vollen 12s-Fallback unten) gewartet, bevor ueberhaupt gesendet wurde -
      // bei FORCE_RELAY_ONLY reicht aber schon der erste brauchbare Relay-
      // Kandidat. Das Warten auf den vollstaendigen Abschluss (inkl. der
      // zweiten TURN-Allokation ueber TCP als Fallback-Kandidat, siehe
      // iceServers oben) kostete in jedem einzelnen Live-Test fast die vollen
      // 12 Sekunden, obwohl der erste brauchbare Kandidat meist in 1-3s da
      // war - mit Abstand der groesste Einzelposten der gesamten Reconnect-
      // Downtime, nicht die Poll-Intervalle. Sobald der erste Relay-
      // Kandidat da ist, noch kurz warten (statt sofort zu senden), damit
      // z.B. der TCP-Fallback-Kandidat idealerweise auch noch mit in die SDP
      // kommt - guenstiger Kompromiss zwischen Tempo und Ausfallsicherheit.
      // "typ relay" ist die von RFC 8445 vorgeschriebene SDP-Notation fuer
      // Relay-Kandidaten - robuster als sich auf ein moeglicherweise
      // fehlendes .type-Feld auf react-native-webrtc's Kandidaten-Objekt zu
      // verlassen. Seit der Nur-P2P-Umstellung (2026-09-29, FORCE_RELAY_ONLY
      // = false) startet schon der erste Kandidat den 1,5s-Timer - in dieser
      // Zeit kommt der per STUN ermittelte oeffentliche Kandidat
      // ueblicherweise noch mit in die SDP.
      this.pc.onicecandidate = (event) => {
        const c = event?.candidate?.candidate;
        if (c && !firstCandidateTimer && (!FORCE_RELAY_ONLY || / typ relay /.test(c))) {
          firstCandidateTimer = setTimeout(done, 1500);
        }
      };
      // Produktions-Fund (Cross-Network-Diagnose): reiner Sicherheitsnetz-
      // Fallback fuer den Fall, dass ueberhaupt kein Kandidat ankommt (TURN
      // nicht erreichbar o.ae.) - der Normalfall wird jetzt vom obigen
      // Kandidaten-Pfad abgedeckt, deutlich schneller als dieser Timeout.
      setTimeout(done, 12000);
    });
  }
}
