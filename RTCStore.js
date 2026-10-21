import { traceSecretMap, traceSecretStorage } from './SecretTrace';
import EncryptedStorage from 'react-native-encrypted-storage';
import RNFS from 'react-native-fs';
import { encryptMsg, decryptMsg, secureRandomToken, randomKeyB64 } from './MessageCrypto';
import { cleanDisplayName } from './TextSafety';
import * as RatchetSession from './RatchetSession';
import { fileKeyFromB64, openMediaChunk } from './MediaKey';
import { t } from './i18n';
traceSecretStorage();
/**
 * RTCStore – Globaler WebRTC State
 * Außerhalb React um Props-Drilling zu vermeiden
 */

// Performance-Audit (Speicherleck): audioBuffer/imgBuffer sammeln Chunks
// eines noch nicht abgeschlossenen Bild-/Audio-Transfers. Bricht die
// Gegenseite mitten im Senden ab (Verbindungsabbruch, Chat wird geschlossen
// bevor img_end/audio_end ankommt), blieb der teilbefuellte Eintrag bisher
// fuer die gesamte Lebensdauer des Prozesses liegen - RTCStore ist ein
// Singleton, der viele Chat-Oeffnungen/-Schliessungen ueberdauert. Jeder
// weitere abgebrochene Versuch legt unter einer neuen imageId/audioId einen
// zusaetzlichen Eintrag an, ohne dass die alten je entfernt werden (nur
// clearContact()/resetAll() raeumen sie auf, beide nur bei Kontakt-Loeschung
// bzw. Wipe). Fix: bevor ein neuer Eintrag in einem dieser Puffer angelegt
// wird, werden alle Eintraege DESSELBEN Puffers entfernt, die aelter als
// STALE_TRANSFER_MS sind - deutlich ueber jeder realistischen
// Uebertragungsdauer selbst bei sehr langsamer Verbindung (10 Minuten,
// gleicher Groessenordnung wie relay.js' eigenes EXPIRE_MS fuer Nachrichten).
// Bewusst kein eigener setInterval dafuer noetig (haette als Singleton, der
// von praktisch jedem Test importiert wird, das Risiko haengender Timer/
// "Jest did not exit" ueber die gesamte Testsuite getragen) - das Sweep
// laeuft huckepack, nur wenn ohnehin schon ein neuer Chunk-Transfer beginnt.
// Zustell-Garantie 2026-10: reisst die Verbindung mitten in einem Transfer ab,
// schickt die Warteschlange des Absenders das Medium KOMPLETT neu (neue
// imageId/audioId/fileId) - der unvollstaendige Rest wird hier ueber genau
// diesen Sweep verworfen.
const STALE_TRANSFER_MS = 10 * 60 * 1000;
function sweepStaleBuffers(map) {
  if (!map || map.size === 0) return;
  const now = Date.now();
  for (const [key, buf] of map) {
    if (buf?.createdAt && now - buf.createdAt > STALE_TRANSFER_MS) map.delete(key);
  }
}

// Kontaktlisten-Vorschau ("letzte Nachricht") fuer eine im Hintergrund
// eingegangene Nachricht - derselbe JSON-Envelope-Unwrap wie in ChatScreen
// (App.tsx), da msg.text bei geoeffnetem Chat selbst wieder ein JSON-Objekt
// sein kann ({text, expireMode, msgId, ...}), nicht der reine Klartext.
function previewForMessage(msg) {
  if (msg.secret === true) return '';   // Secret Chat: keine Vorschau (Audit P1)
  if (msg.type === 'image_complete') return t('preview.image');
  // War bisher 'audio_end' (die Chunk-Ende-Markierung) statt 'audio_complete'
  // (das tatsaechlich an previewForMessage() uebergebene, hier zusammengesetzte
  // Objekt, siehe audioMsg weiter oben) - dieser Zweig griff dadurch NIE, die
  // Kontaktlisten-Vorschau/Badge-Benachrichtigung bekam fuer eine gepufferte
  // Sprachnachricht einen leeren String statt "🎤 Sprachnachricht" (fiel auf
  // den generischen Text-Fallback unten durch, audioMsg hat aber kein .text).
  if (msg.type === 'audio_complete') return t('preview.voice');
  if (msg.type === 'file_complete') return '📎 ' + (msg.fileName || t('common.file'));
  let text = msg.text;
  if (typeof text === 'string' && text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      // Secret-Chat-Nachrichten duerfen nicht in die dauerhafte
      // Kontaktlisten-Vorschau lecken, wenn dieser Puffer-Pfad greift (kein
      // ChatScreen-Listener aktiv - genau dann existiert secretActive als
      // reiner React-State gar nicht, um das hier zu verhindern). Leerer
      // String statt Inhalt - incrementBadge() unten laesst "last"/"time"
      // dann unveraendert stehen (siehe dortiges `preview ? {...} : {}`),
      // erhoeht aber weiterhin den Unread-Zaehler. Live-Test entdeckt.
      if (parsed?.secret) return '';
      // Standort: Vorschau in der eigenen Sprache statt des (deutschen)
      // Platzhaltertexts aus dem Versand-Umschlag.
      if (parsed?.isLocation) return t('preview.location');
      text = parsed.text ?? text;
    } catch {}
  }
  return typeof text === 'string' ? text : '';
}

// Steuersignale, die auch ohne offenen Chat sofort wirken muessen (siehe
// setConnection() und BackgroundSync.applyControlSignal()).
const CONTROL_SIGNAL_SUBTYPES = new Set([
  'delete_chat', 'device_wiped', 'clear_chat', 'delete_message', 'secret_start', 'secret_end',
]);

// Gruppenchats (GroupMessaging.js, GROUP_CHAT_DESIGN.md): Gruppen-Nachrichten
// reisen als Steuersignale ueber den 1:1-Kanal des jeweiligen Mitglieds und
// gehen IMMER an die Gruppenverarbeitung - nie an den 1:1-Chat oder dessen
// Puffer (auch nicht bei offenem 1:1-Chat). Ihre Zustell-Schluessel (ackId)
// beginnen mit GROUP_ACK_PREFIX.
export const GROUP_SUBTYPES = new Set(['group_state', 'group_leave', 'group_text']);
export const GROUP_ACK_PREFIX = 'grp|';
// Bild/Sprachnachricht fuer eine Gruppe: reist ueber den normalen,
// verschluesselten Medienweg (Chunks + End-Marker, Dateischluessel im Ratchet)
// an jedes Mitglied einzeln; die Zustell-ID 'grp|m|<gruppe>|<id>' ordnet sie
// beim Empfaenger der Gruppe zu (GroupMessaging.handleMedia) statt dem 1:1-Chat.
export const GROUP_MEDIA_ACK_PREFIX = GROUP_ACK_PREFIX + 'm|';
export function isGroupMedia(msg) {
  return !!msg && (msg.type === 'image_complete' || msg.type === 'audio_complete')
    && typeof msg.msgId === 'string' && msg.msgId.startsWith(GROUP_MEDIA_ACK_PREFIX);
}

// ─── Zustell-Garantie, Empfangsseite (2026-10) ──────────────────────────────
// Gegenstueck zur Warteschlange in BackgroundSync.js (Outbox-Prinzip): der
// Absender loescht eine Nachricht erst aus seiner Warteschlange, wenn hier
// ein 'receipt' (status 'delivered') zurueckkommt - sonst schickt er sie bei
// jeder neuen Verbindung und nach Ablauf einer Wartezeit erneut. Dafuer gilt
// hier zentral (egal ob ein Chat offen ist):
//   - JEDE Nachricht mit Zustell-Schluessel (deliveryKeyOf) wird bestaetigt -
//     Text/Standort (msgId), Bild/Sprachnachricht/Datei (msgId im End-Marker,
//     erst nach vollstaendigem Zusammensetzen) und die zustandsrelevanten
//     Steuersignale (ackId).
//   - Wiederholungen werden verworfen, aber trotzdem bestaetigt (sonst
//     wiederholt der Absender endlos). Die Liste der zuletzt gesehenen
//     Schluessel liegt pro Kontakt in EncryptedStorage (rx_seen_<id>) und
//     uebersteht damit einen App-Neustart.
//   - Bestaetigt wird erst, wenn die Nachricht dauerhaft abgelegt ist: bei
//     geschlossenem Chat in der verschluesselten Empfangs-Ablage (siehe
//     _persistInbox), sonst nach dem Sichern der Dedup-Liste.
// Faehigkeit, die wir der Gegenseite im profile_name mitteilen. Fehlt sie beim
// Gegenueber, laeuft dort eine aeltere App-Version (Rueckfall-Regel siehe
// BackgroundSync.js). ratchet: Double Ratchet (RatchetSession.js) - fehlt es
// beim Gegenueber, bleibt es fuer diesen Kontakt beim bisherigen Verfahren.
export const OWN_CAPS = RatchetSession.RATCHET_ENABLED
  ? { ack: 1, ratchet: RatchetSession.RATCHET_CAP_VERSION }
  : { ack: 1 };
const DELETE_ACK_GRACE_MS = 300;  // Bestaetigung eines delete_chat vor dem Schliessen
const SEEN_MAX = 1000;            // persistierte Zustell-Schluessel pro Kontakt
const VOLATILE_SEEN_MAX = 500;    // Secret Chat: nur im RAM
const SEEN_PREFIX = 'rx_seen_';
const PEER_NAME_MAX = 64;          // Name der Gegenseite (eigene Eingabe: 32)
const CAPS_PREFIX = 'peer_caps_';
const INBOX_INDEX_KEY = 'rx_inbox';
const INBOX_FILE_PREFIX = 'inbox_';
const USER_CONTENT_TYPES = new Set(['text', 'image_complete', 'audio_complete', 'file_complete']);
const CHUNK_TYPES = new Set(['img_chunk', 'img_end', 'audio_chunk', 'audio_end', 'file_chunk', 'file_end']);

function normKey(v) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  return typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : null;
}

// Zustell-Schluessel einer empfangenen Nachricht (null = keine Bestaetigung,
// z.B. aeltere Gegenseite oder reine Profil-/Statuspakete). Achtung: bei
// delete_message ist msgId die ZU LOESCHENDE Nachricht - Steuersignale tragen
// ihren eigenen Schluessel deshalb immer in ackId.
export function deliveryKeyOf(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'system') return normKey(msg.ackId);
  if (USER_CONTENT_TYPES.has(msg.type)) return normKey(msg.msgId);
  return null;
}

// Secret-Chat-Inhalt ("Nur RAM – kein Speicher – kein Trace") - wird weder in
// der Empfangs-Ablage noch in der persistenten Dedup-Liste festgehalten.
export function isEphemeral(msg) {
  if (msg?.secret) return true;
  if (typeof msg?.text === 'string' && msg.text.startsWith('{')) {
    try { return !!JSON.parse(msg.text)?.secret; } catch {}
  }
  return false;
}

// Auf CHUNK_SIZE aufgepolsterte Chunks (Sicherheitsreview 5, Fund 7 - siehe
// ImageCrypto.js padLastChunk) wieder auf die echte Laenge zuruecksschneiden.
// Fehlte bisher in diesem Pfad: Bilder/Dateien, die bei geschlossenem Chat
// ankamen, trugen die Fuellzeichen mit.
function chunkData(msg) {
  return typeof msg.data === 'string' && Number.isFinite(msg.realLen) ? msg.data.slice(0, msg.realLen) : msg.data;
}

// Chunk zum Puffern: mit Dateischluessel verschluesselte Chunks (Double
// Ratchet, MediaKey.js) bleiben verschluesselt, bis der End-Marker mit dem
// Schluessel kommt.
function bufferedChunk(msg) {
  return msg.fk === 1 ? { fk: msg.data, l: msg.realLen } : chunkData(msg);
}

// Setzt die Chunks eines Mediums zusammen. Mit Dateischluessel im End-Marker
// (kam durch den Ratchet): JEDER Chunk muss sich damit oeffnen lassen, die
// Gesamtzahl aus dem End-Marker gilt. Ohne Schluessel nur unverschluesselte
// Chunks (bisheriges Verfahren). Eine Mischung oder ein Fehler -> null.
function joinChunks(buf, end, kind, id) {
  const sealed = buf.chunks.filter((c) => c && typeof c === 'object').length;
  if (end.fk === undefined) return sealed ? null : buf.chunks.join('');
  const key = fileKeyFromB64(end.fk);
  if (!key || sealed !== buf.total || end.total !== buf.total) return null;
  try {
    return buf.chunks.map((c, i) => {
      const text = openMediaChunk(key, kind, id, i, buf.total, c.l, c.fk);
      return Number.isFinite(c.l) ? text.slice(0, c.l) : text;
    }).join('');
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}
// Aushandlung einer Direktverbindung ueber eine bestehende (meist Tor-)
// Verbindung - siehe DirectUpgrade.js. Nie an die Chat-UI oder den Puffer.
const UPGRADE_SIGNAL_SUBTYPES = new Set(['direct_offer', 'direct_answer', 'direct_request', 'direct_reject']);
// Anruf-Signale, mit denen der Anrufer einen noch klingelnden Anruf beendet.
const CALL_END_SIGNALS = new Set(['cancel', 'end', 'reject']);

// Profilbild: Pruefung nach dem Handshake bzw. Mindestabstand fuer erneutes Senden.
const AVATAR_CHECK_DELAY_MS = 4000;
const AVATAR_RESEND_MIN_GAP_MS = 60000;

class RTCStore {
  constructor() {
    // Von BackgroundSync.js gesetzt - (chatId, msg) => Promise.
    this.controlSignalHandler = null;
    // Von BackgroundSync.js gesetzt: (chatId, msgId) => void - echte
    // Empfangsbestaetigung der Gegenseite, Warteschlangen-Eintrag darf weg.
    this.receiptHandler = null;
    // Von BackgroundSync.js gesetzt: (chatId) => void - Secret Chat beendet,
    // noch nicht zugestellte Secret-Nachrichten verfallen.
    this.secretEndedHandler = null;
    // Tor-Ausweichweg: BackgroundSync.js speichert empfangene Onion-Adressen
    // (chatId, onion) => void; TorTransport.js liefert die eigene () => string|null.
    this.torAddressHandler = null;
    this.ownTorAddressProvider = null;
    // Gruppenchats (GroupMessaging.js): eingehende Gruppen-Nachricht
    // (chatId, msg) => Promise (erfuellt = dauerhaft abgelegt), empfangene
    // Mitglieds-ID des Kontakts (chatId, gid) => void, eigene () => Promise<string>.
    this.groupMessageHandler = null;
    this.groupIdHandler = null;
    this.ownGroupIdProvider = null;
    // Anrufe ueber den bestehenden Kanal (CallManager.js): Signale (Klingeln,
    // Annehmen, Verbindungsdaten) und - als letzter Ausweg - Sprachpakete.
    this.callSignalHandler = null;   // (chatId, signal) => void   (App.tsx)
    this.callAudioHandler = null;    // (chatId, msg) => void      (CallManager.js)
    // Gruppenanrufe (GroupCallManager.js): eigene Signale (nie Chat/Puffer)
    // und "besetzt"-Pruefung fuer eingehende 1:1-Anrufe waehrend eines
    // Gruppenanrufs (true = schon abgelehnt, nicht klingeln).
    this.groupCallSignalHandler = null; // (chatId, msg) => void
    this.callBusyCheck = null;          // (chatId, signal) => bool
    // Ohne gemountete App (Hintergrund/Headless, index.js): eingehenden
    // Anruf nativ klingeln lassen bzw. das Klingeln beenden.
    this.incomingCallNotifier = null;  // (chatId) => void
    this.callCancelledNotifier = null; // (chatId) => void
    // Direkt-Upgrade (DirectUpgrade.js): (chatId, msg) => void
    this.upgradeSignalHandler = null;
    // Schluesseltausch einer aktiven Verbindung fertig (BackgroundSync.js
    // startet darauf z.B. den Wechsel Tor -> direkt): (chatId, rtc) => void
    this.connectionReadyHandler = null;
    // Verbindung zu einem Kontakt herstellen, falls keine steht (Tor, siehe
    // BackgroundSync.ensureConnection) - z.B. fuer Anrufe:
    // (chatId, { timeoutMs }) => Promise<rtc|null>
    this.connectionEnsurer = null;
    // Verbindungen ausserhalb von this.connections (Tor-Reserve, laufende
    // Tor-Anmeldungen, Direkt-Upgrade-Versuche) muessen bei einem Wipe/
    // Kontakt-Loeschen ebenfalls geschlossen werden - sonst koennte ein noch
    // laufender Schluesseltausch das Secret nach dem Loeschen wieder
    // speichern (siehe WebRTCManager _closeReason 'wipe'). (chatId|null) => void
    this.wipeListeners = new Set();
    this.connections   = new Map(); // chatId → WebRTCManager
    this.listeners     = new Map(); // chatId → callback
    this.buffer        = new Map(); // chatId → [msg, msg, ...] (Hintergrundpuffer)
    this.sharedSecrets = traceSecretMap(new Map(), 'Schluessel (RAM)'); // chatId → sharedSecret Base64
    // chatId → vorheriges sharedSecret (Base64), nur solange der letzte
    // Schluesselwechsel noch nicht von der Gegenseite bestaetigt ist - siehe
    // rememberPreviousSecret()/getSecretCandidates() unten.
    this.previousSecrets = traceSecretMap(new Map(), 'Vorheriger Schluessel (RAM)');
    // chatId → { peerName, signals: [...] } - siehe bufferCallSignal() unten.
    this.pendingCalls  = new Map();
    // contactId des gerade laufenden Anrufs (oder null) - siehe setActiveCall().
    this.activeCallContactId = null;
    // Zustell-Garantie (siehe oben).
    this.peerCaps      = new Map(); // chatId → 'new' | 'old'
    this._capsLoading  = new Set();
    this._seen         = new Map(); // chatId → Dedup-Zustand (_seenState)
    this._inboxIds     = new WeakMap(); // gepufferte Nachricht → Promise<Ablage-ID|null>
    this._sessionInboxIds = new Set();  // in dieser Sitzung abgelegte IDs
    this._inboxChain   = Promise.resolve();
    this._inboxRestore = null;
  }

  // Audit 2026-09-28 ("Reconnect klappt dauerhaft nicht mehr"): jede
  // Verbindung handelt per Kyber ein NEUES Shared Secret aus und beide Seiten
  // ueberschreiben dabei das alte (WebRTCManager.js, kyber_*-Handler). Reisst
  // die Verbindung genau zwischen "Responder hat das neue Secret gespeichert"
  // und "Initiator hat den Ciphertext empfangen/gespeichert" ab (oder wird
  // eine Seite in diesem Fenster beendet), haben beide Seiten danach
  // VERSCHIEDENE Secrets. Jedes weitere Reconnect-Angebot ist dann fuer die
  // Gegenseite nicht mehr entschluesselbar und wird als "moeglicher Angriff"
  // verworfen - fuer immer, bis zum kompletten Neu-Pairing. Deshalb merkt sich
  // jede Seite beim Wechsel das vorherige Secret, bis die Gegenseite
  // nachweislich mit dem neuen arbeitet (confirmCurrentSecret), und die
  // Reconnect-/Relay-Pfade probieren beide Kandidaten.
  rememberPreviousSecret(chatId, previous, next) {
    if (!chatId || !previous || previous === next) return false;
    this.previousSecrets.set(chatId, previous);
    return true;
  }

  confirmCurrentSecret(chatId) {
    return this.previousSecrets.delete(chatId);
  }

  getSecretCandidates(chatId) {
    const out = [];
    const cur = this.sharedSecrets.get(chatId);
    const prev = this.previousSecrets.get(chatId);
    if (cur) out.push(cur);
    if (prev && prev !== cur) out.push(prev);
    return out;
  }

  // contactId des gerade laufenden Anrufs (CallManager._setState) - nur
  // Zustandsanzeige, z.B. fuer die Diagnose.
  setActiveCall(contactId) {
    this.activeCallContactId = contactId || null;
  }

  // Puffert ein eingehendes Anruf-Angebot (kommt ueber die bestehende
  // Verbindung zum Kontakt, siehe setConnection), solange App() NICHT bereit
  // ist - es gibt dann noch keinen CallManager, der es verarbeiten koennte.
  // App.tsx holt es beim naechsten Mount ab und reicht es an einen frisch
  // erzeugten CallManager; das native Klingeln (CallBridgeModule.
  // reportIncomingCall, siehe index.js) startet parallel dazu bereits sofort.
  bufferCallSignal(chatId, peerName, signals) {
    this.pendingCalls.set(chatId, { peerName, signals, at: Date.now() });
  }

  takeBufferedCallSignal(chatId) {
    const entry = this.pendingCalls.get(chatId);
    this.pendingCalls.delete(chatId);
    return entry || null;
  }

  takeAllBufferedCallSignals() {
    const all = Array.from(this.pendingCalls.entries());
    this.pendingCalls.clear();
    return all;
  }

  setConnection(chatId, rtc) {
    // Bei einem Reconnect-Wettlauf (State-Machine-Review, Fund 8) koennen zwei
    // parallele Verbindungsversuche fuer denselben Kontakt beide fertig
    // werden - die "verlierende" WebRTCManager-Instanz wurde bisher einfach
    // ueberschrieben, ohne ihre pc/dataChannel explizit zu schliessen (nur
    // dem Liveness-Watchdog/GC ueberlassen). Jetzt: alte Verbindung aktiv
    // schliessen, bevor sie durch die neue ersetzt wird.
    const existing = this.connections.get(chatId);
    if (existing && existing !== rtc) {
      // Nutzer-Fund: eine Nachricht, die genau im Sendezeitfenster einer
      // sterbenden Verbindung haengen blieb (siehe pendingMsgs-Fallback in
      // WebRTCManager.js sendMessage()), lebt nur im Arbeitsspeicher DIESER
      // Instanz. Der normale Reconnect-Weg (checkOutgoing/checkIncoming)
      // erzeugt fuer denselben Kontakt eine KOMPLETT NEUE WebRTCManager-
      // Instanz mit leerem pendingMsgs - ohne diese Uebertragung waere die
      // Nachricht damit endgueltig verloren, obwohl die naechste Verbindung
      // Sekunden spaeter erfolgreich steht. Vor dem Schliessen uebernehmen,
      // damit _flushPending() sie auf der neuen Instanz nachliefert, sobald
      // deren Schluesselaustausch abgeschlossen ist.
      if (existing.pendingMsgs?.length) {
        console.log('[RTCStore] Uebertrage', existing.pendingMsgs.length, 'wartende Nachricht(en) auf neue Verbindung fuer:', chatId);
        rtc.pendingMsgs = [...(rtc.pendingMsgs || []), ...existing.pendingMsgs];
      }
      console.log('[RTCStore] Ersetze bestehende Verbindung fuer:', chatId, '- alte wird geschlossen');
      try { existing.close(); } catch {}
    }
    this.connections.set(chatId, rtc);
    // Dedup-Liste/Faehigkeiten dieses Kontakts spaetestens jetzt laden (im
    // Normalfall laengst geschehen, siehe BackgroundSync.loadPreviousSecret()).
    this.preloadContact(chatId);
    rtc.onMessage = (msg) => this._onIncoming(chatId, rtc, msg);
    rtc.chatId = chatId;
    // Live-Test-Fund (Nutzer-Vorgabe "Nachrichten duerfen nie den Relay-
    // Server beruehren"): dieser Ort hatte bisher ZWEI fast identische Kopien
    // eines eigenen, gebrochenen "_onReady"-Fallbacks (hier UND weiter unten
    // nach _onKeyExchange), beide nur fuer 'image'/'audio' - 'text'/'system'
    // fielen durch und die Queue wurde trotzdem bedingungslos geleert
    // (Datenverlust). Beide waren zudem an ein 'system'/'ready'-Signal
    // gekoppelt, das im gesamten Projekt nirgends je gesendet wird - toter
    // Code, der nur so aussah, als wuerde er funktionieren. Jetzt: kein
    // eigener Fallback mehr hier - _onReady wird ausschliesslich von den
    // Reconnect-Aufrufstellen in App.tsx gesetzt (die einzigen Faelle, in
    // denen bei Verbindungsaufbau ueberhaupt eine vorbestehende lokale Queue
    // existieren kann) und unten direkt aus _onKeyExchange heraus ausgeloest,
    // sobald der Schluesselaustausch nachweislich abgeschlossen ist.
    rtc._onKeyExchange = async () => {
      // Verbindung ist nutzbar - z.B. Wechsel Tor -> direkt anstossen
      // (BackgroundSync.js/DirectUpgrade.js). Entkoppelt, damit ein Fehler dort
      // das Profil-Senden unten nicht stoert.
      if (typeof this.connectionReadyHandler === 'function') {
        Promise.resolve().then(() => this.connectionReadyHandler(chatId, rtc)).catch(() => {});
      }
      // Nur senden wenn noch kein Profil für diesen Chat übertragen
      if (!this.profileSent) this.profileSent = new Set();
      // Immer senden – Empfänger entscheidet ob Avatar neu angezeigt wird
      try {
        const name   = await EncryptedStorage.getItem('username') || 'Malachi User';
        const avatarUri = await EncryptedStorage.getItem('avatar') || null;
        // caps: siehe OWN_CAPS - aeltere Gegenseiten ignorieren das Feld.
        rtc.sendMessage(JSON.stringify({
          type: 'system', subtype: 'profile_name', name, caps: OWN_CAPS
        }));
        // Eigene Onion-Adresse fuer den Tor-Ausweichweg mitteilen (sofern Tor
        // laeuft) - ueber den gerade frisch verschluesselten Kanal.
        const ownOnion = typeof this.ownTorAddressProvider === 'function' ? this.ownTorAddressProvider() : null;
        if (ownOnion) {
          rtc.sendMessage(JSON.stringify({ type: 'system', subtype: 'tor_address', onion: ownOnion }));
        }
        // Eigene Mitglieds-ID fuer Gruppenchats (zufaellig, keine Netz-Kennung,
        // siehe GroupMessaging.js) - ebenfalls nur ueber diesen Kanal.
        const ownGid = typeof this.ownGroupIdProvider === 'function'
          ? await Promise.resolve().then(() => this.ownGroupIdProvider()).catch(() => null)
          : null;
        if (ownGid) {
          rtc.sendMessage(JSON.stringify({ type: 'system', subtype: 'group_id', gid: ownGid }));
        }
        if (avatarUri && rtc.sharedSecret) {
          const { sendEncryptedImage } = await import('./ImageCrypto');
          // Dateipfad → Base64 konvertieren
          let base64Data = avatarUri;
          if (avatarUri.startsWith('file://') || avatarUri.startsWith('/')) {
            const path = avatarUri.replace('file://', '');
            base64Data = await RNFS.readFile(path, 'base64');
          } else if (avatarUri.includes(';base64,')) {
            base64Data = avatarUri.split(';base64,')[1];
          }
          // Ersten Verbindung immer senden, danach nur bei Hash-Änderung
          const avatarHash = base64Data.slice(0, 32);
          const storedHash = await EncryptedStorage.getItem('avatar_hash_' + chatId).catch(() => null);
          const isFirstConnect = !storedHash;
          if (isFirstConnect || avatarHash !== storedHash) {
            // Ratchet-Kontakt: Dateischluessel-Verfahren (End-Marker durch den
            // Ratchet), sonst wie bisher. Laesst sich das nicht feststellen
            // (Speicherfehler), das Profilbild diesmal auslassen - weder
            // schwaecher geschuetzt senden noch den Rest (Warteschlange!)
            // abbrechen.
            let sealer = null;
            let skipAvatar = false;
            try {
              sealer = typeof rtc.mediaSealer === 'function' ? await rtc.mediaSealer({ avatar: true }) : null;
            } catch (e) {
              skipAvatar = true;
              console.warn('[Profile] Profilbild ausgelassen (Ratchet-Zustand nicht lesbar):', e?.message || e);
            }
            // Kennzeichen innen (Audit C3) - nicht mehr aussen um den Umschlag.
            if (!skipAvatar) await sendEncryptedImage(
              base64Data,
              'image/jpeg',
              rtc.sharedSecret,
              (raw) => rtc.dataChannel?.send(raw),
              { sealer, avatar: true },
            );
        // Safety Code verfügbar (Wert selbst nicht loggen - Secrets-Lifecycle-
        // Review: der Safety Code ist die eine manuelle MITM-Erkennung der App
        // und darf nicht ueber Logs abgreifbar sein, siehe UI-Anzeige dafuer)
        if (rtc.safetyCode) {
          console.log('[Safety] Code verfuegbar');
        }
        // Gebündeltes Handshake-Paket (Phase 2)
        rtc.sendMessage(JSON.stringify({
          type: 'system',
          subtype: 'handshake',
          name,
          hasAvatar: !!(avatarUri),
          ready: true,
          caps: OWN_CAPS
        }));
            // Hash speichern
            await EncryptedStorage.setItem('avatar_hash_' + chatId, avatarHash).catch(() => {});
            console.log('[Profile] ✅ Neues Avatar gesendet');
          } else {
            console.log('[Profile] Avatar unverändert – nicht gesendet');
          }
        }
        console.log('[Profile] ✅ Profil gesendet:', name);
        // Loest eine evtl. von App.tsx gesetzte lokale Sende-Warteschlange
        // aus (siehe ausfuehrlicher Kommentar bei der entfernten Fallback-
        // Kopie oben) - _onKeyExchange feuert nachweislich zuverlaessig auf
        // beiden Seiten nach abgeschlossenem Kyber-Handshake, anders als das
        // nie gesendete 'system'/'ready'-Signal, an das dieser Aufruf vorher
        // gekoppelt war.
        if (rtc._onReady) await rtc._onReady();
      } catch(e) {
        console.warn('[Profile] Fehler:', e);
      }
    };
    console.log('[RTCStore] Verbindung gespeichert für:', chatId);
  }

  // Profilbild erneut senden (Anforderung der Gegenseite) - hoechstens einmal
  // pro Minute und Kontakt. Gleicher Weg wie beim Verbindungsaufbau.
  async _resendAvatar(chatId, rtc) {
    if (!this._avatarResentAt) this._avatarResentAt = new Map();
    if (Date.now() - (this._avatarResentAt.get(chatId) || 0) < AVATAR_RESEND_MIN_GAP_MS) return;
    this._avatarResentAt.set(chatId, Date.now());
    const avatarUri = await EncryptedStorage.getItem('avatar').catch(() => null);
    if (!avatarUri || !rtc?.sharedSecret || rtc._closed) return;
    let base64Data = avatarUri;
    if (avatarUri.startsWith('file://') || avatarUri.startsWith('/')) {
      base64Data = await RNFS.readFile(avatarUri.replace('file://', ''), 'base64');
    } else if (avatarUri.includes(';base64,')) {
      base64Data = avatarUri.split(';base64,')[1];
    }
    // require statt import(): laeuft auch unter Jest; zur Laufzeit (Metro) gleich.
    const { sendEncryptedImage } = require('./ImageCrypto');
    const sealer = typeof rtc.mediaSealer === 'function' ? await rtc.mediaSealer({ avatar: true }) : null;
    await sendEncryptedImage(base64Data, 'image/jpeg', rtc.sharedSecret, (raw) => rtc.dataChannel?.send(raw), { sealer, avatar: true });
    rtc.sendMessage(JSON.stringify({ type: 'system', subtype: 'handshake',
      name: await EncryptedStorage.getItem('username').catch(() => null) || 'Malachi User', hasAvatar: true, ready: true, caps: OWN_CAPS }));
    await EncryptedStorage.setItem('avatar_hash_' + chatId, base64Data.slice(0, 32)).catch(() => {});
    console.log('[Profile] ✅ Profilbild auf Anforderung erneut gesendet');
  }

  // Zentrale Verarbeitung JEDER entschluesselten Nachricht einer Verbindung
  // (vorher eine grosse Closure in setConnection()).
  _onIncoming(chatId, rtc, msg) {
    if (!msg || typeof msg !== 'object') return;
    // Echte Empfangsbestaetigung der Gegenseite: Warteschlangen-Eintrag darf
    // jetzt weg. Danach wie bisher an den Chat (Haekchen) bzw. in den Puffer.
    if (msg.type === 'receipt') {
      const key = normKey(msg.msgId);
      if (key && msg.status === 'delivered' && typeof this.receiptHandler === 'function') {
        try { this.receiptHandler(chatId, key); } catch {}
      }
      // Bestaetigung einer Gruppen-Nachricht: betrifft nicht den 1:1-Chat
      // (Haekchen im Gruppenchat setzt BackgroundSync -> GroupMessaging).
      if (key && key.startsWith(GROUP_ACK_PREFIX)) return;
      this._route(chatId, msg);
      return;
    }
    if (msg.type === 'call_audio') {
      if (typeof this.callAudioHandler === 'function') {
        try { this.callAudioHandler(chatId, msg); } catch {}
      }
      return;
    }
    // Gruppenanruf-Signale (GroupCallManager.js): nur ueber diesen bereits
    // verschluesselten, angemeldeten Kanal; nie an Chat, Puffer oder Ablage,
    // keine Bestaetigung, nichts wird gespeichert.
    if (msg.type === 'system' && msg.subtype === 'gcall_signal') {
      if (typeof this.groupCallSignalHandler === 'function') {
        try { this.groupCallSignalHandler(chatId, msg); } catch {}
      }
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'call_signal' && msg.signal && typeof msg.signal.type === 'string') {
      // Nur ein Anruf gleichzeitig: laeuft ein Gruppenanruf, lehnt
      // GroupCallManager ein neues 1:1-Angebot als "besetzt" ab.
      if (msg.signal.type === 'offer' && typeof this.callBusyCheck === 'function') {
        let busy = false;
        try { busy = !!this.callBusyCheck(chatId, msg.signal); } catch {}
        if (busy) return;
      }
      if (typeof this.callSignalHandler === 'function') {
        try { this.callSignalHandler(chatId, msg.signal); } catch {}
      } else {
        // App gerade nicht bereit (Hintergrund/Headless): Angebot puffern,
        // nativ klingeln lassen; App holt es beim Start ab
        // (takeAllBufferedCallSignals in App.tsx). Weitere Signale des
        // klingelnden Anrufs (ICE) anhaengen, Abbruch des Anrufers beendet
        // das Klingeln sofort. (Ersetzt den frueheren Server-Poll.)
        const pendingCall = this.pendingCalls.get(chatId);
        if (msg.signal.type === 'offer') {
          this.bufferCallSignal(chatId, pendingCall?.peerName ?? null, [msg.signal]);
          if (typeof this.incomingCallNotifier === 'function') {
            try { this.incomingCallNotifier(chatId); } catch {}
          }
        } else if (pendingCall && CALL_END_SIGNALS.has(msg.signal.type)) {
          this.pendingCalls.delete(chatId);
          if (typeof this.callCancelledNotifier === 'function') {
            try { this.callCancelledNotifier(chatId); } catch {}
          }
        } else if (pendingCall && pendingCall.signals.length < 200) {
          pendingCall.signals.push(msg.signal);
        }
      }
      return;
    }
    // Aushandlung einer Direktverbindung (DirectUpgrade.js) - kommt nur ueber
    // diesen bereits verschluesselten, angemeldeten Kanal; nie an die Chat-UI.
    if (msg.type === 'system' && UPGRADE_SIGNAL_SUBTYPES.has(msg.subtype)) {
      if (typeof this.upgradeSignalHandler === 'function') {
        Promise.resolve()
          .then(() => this.upgradeSignalHandler(chatId, msg))
          .catch(e => console.warn('[RTCStore] Direkt-Signal nicht verarbeitbar:', e?.message || e));
      }
      return;
    }
    // Onion-Adresse des Kontakts (Tor-Ausweichweg) - kommt nur ueber diesen
    // bereits verschluesselten, angemeldeten Kanal; nie an die Chat-UI.
    if (msg.type === 'system' && msg.subtype === 'tor_address') {
      if (typeof this.torAddressHandler === 'function') {
        try { this.torAddressHandler(chatId, msg.onion); } catch {}
      }
      return;
    }
    // Mitglieds-ID des Kontakts fuer Gruppenchats - nie an die Chat-UI.
    if (msg.type === 'system' && msg.subtype === 'group_id') {
      if (typeof this.groupIdHandler === 'function') {
        try { this.groupIdHandler(chatId, msg.gid); } catch {}
      }
      return;
    }
    if (msg.type === 'system' && (msg.subtype === 'profile_name' || msg.subtype === 'handshake')) {
      // Audit G9: Name der Gegenseite ohne Bidi-/Nullbreiten-Zeichen, bevor er
      // irgendwo angezeigt oder gespeichert wird.
      if (typeof msg.name === 'string') msg = { ...msg, name: cleanDisplayName(msg.name, PEER_NAME_MAX) || 'Malachi User' };
      this._notePeerCaps(chatId, msg);
    }
    // Gegenseite hat unser Profilbild nicht (mehr): erneut senden.
    if (msg.type === 'system' && msg.subtype === 'profile_avatar_request') {
      this._resendAvatar(chatId, rtc).catch(() => {});
      return;
    }
    // Gegenseite hat ein Profilbild, wir aber keins von ihr gespeichert (z.B.
    // verloren, siehe handleProfileAvatar): kurz warten (das Bild kommt vor
    // dem Handshake) und dann einmal je Verbindung anfordern.
    if (msg.type === 'system' && msg.subtype === 'handshake' && msg.hasAvatar === true
        && typeof this.avatarMissingCheck === 'function' && !rtc._avatarRequested) {
      rtc._avatarRequested = true;
      const t = setTimeout(async () => {
        try {
          if (rtc._closed || this.connections.get(chatId) !== rtc) return;
          if (this.pendingAvatars?.has(chatId) || this.pendingAvatarExpected?.has(chatId)) return;
          if (!(await this.avatarMissingCheck(chatId))) return;
          console.log('[Profile] Profilbild des Kontakts fehlt - fordere es an');
          rtc.sendMessage(JSON.stringify({ type: 'system', subtype: 'profile_avatar_request' }));
        } catch {}
      }, AVATAR_CHECK_DELAY_MS);
      t?.unref?.();
    }

    // Medien: IMMER hier zusammensetzen - auch bei offenem Chat (vorher reichte
    // RTCStore die rohen Chunks dann an ChatScreen durch, eine Bestaetigung
    // "vollstaendig angekommen" war so zentral gar nicht moeglich).
    if (CHUNK_TYPES.has(msg.type)) {
      const complete = this._assemble(chatId, msg);
      if (!complete) return;
      msg = complete;
    }

    const key = deliveryKeyOf(msg);
    if (key) {
      if (this._hasSeen(chatId, key)) {
        // Die Warteschlange des Absenders schickt erneut, wenn ihre
        // Bestaetigung ausblieb. Kam das Original doch an: Duplikat
        // verwerfen, aber bestaetigen, damit der Absender aufhoert.
        console.log('[RTCStore] Doppelt zugestellte Nachricht verworfen (erneut bestaetigt):', key);
        this._ackWhenDurable(chatId, rtc, key, null);
        return;
      }
      this._markSeen(chatId, key, !isEphemeral(msg));
    }
    if (msg.type === 'system' && msg.subtype === 'secret_end') {
      // Audit P1: Secret-Inhalte, die bei geschlossenem Chat im RAM-Puffer
      // warten, enden mit dem Secret Chat - sonst tauchten sie beim naechsten
      // Oeffnen im normalen Verlauf auf (und wurden dort gespeichert).
      this.dropEphemeralBuffered(chatId);
      if (typeof this.secretEndedHandler === 'function') {
        try { this.secretEndedHandler(chatId); } catch {}
      }
    }
    // delete_chat entfernt den Kontakt samt Verbindung - danach liesse sich
    // nichts mehr bestaetigen. Deshalb VOR der Verarbeitung bestaetigen und
    // erst anwenden, wenn die Bestaetigung den Kanal verlassen hat (kurzer
    // Puffer, wie beim Absender des Hinweises frueher).
    if (key && msg.type === 'system' && msg.subtype === 'delete_chat') {
      const target = this._receiptTarget(chatId, rtc);
      const raw = JSON.stringify({ type: 'receipt', msgId: key, status: 'delivered' });
      Promise.resolve()
        .then(() => (typeof target?.sendMessageAndWait === 'function' ? target.sendMessageAndWait(raw) : target?.sendMessage?.(raw)))
        .catch(() => {})
        .then(() => new Promise((r) => { const t = setTimeout(r, DELETE_ACK_GRACE_MS); t?.unref?.(); }))
        .then(() => this._route(chatId, msg));
      return;
    }
    const durable = this._route(chatId, msg);
    if (key) this._ackWhenDurable(chatId, rtc, key, durable);
  }

  // Zustellung an den offenen Chat, an die zentrale Steuersignal-Verarbeitung
  // oder in den Hintergrundpuffer. Liefert ein Promise, sobald die Nachricht
  // dauerhaft abgelegt ist (Empfangs-Ablage/Steuersignal angewandt), sonst null.
  _route(chatId, msg) {
    // Gruppen-Nachrichten: immer an die Gruppenverarbeitung (egal ob der
    // 1:1-Chat dieses Kontakts offen ist) - bestaetigt wird erst, wenn sie im
    // Gruppenverlauf gespeichert ist.
    if ((msg.type === 'system' && GROUP_SUBTYPES.has(msg.subtype)) || isGroupMedia(msg)) {
      if (typeof this.groupMessageHandler !== 'function') return null;
      return Promise.resolve()
        .then(() => this.groupMessageHandler(chatId, msg))
        .catch(e => console.warn('[RTCStore] Gruppen-Nachricht nicht verarbeitbar:', e?.message || e));
    }
    const cb = this.listeners.get(chatId);
    if (cb) {
      cb(msg);
      return null;
    }
    // Nur-P2P-Umstellung 2026-09-29: Steuersignale (Chat geloescht,
    // Geraet zurueckgesetzt, Secret Chat, ...) kamen bisher bei
    // geschlossenem Chat nur in den Puffer und wirkten erst beim naechsten
    // Oeffnen - frueher fing das der Relay-Parallelversand ab. Jetzt
    // direkt zentral verarbeiten (BackgroundSync.applyControlSignal).
    if (msg.type === 'system' && CONTROL_SIGNAL_SUBTYPES.has(msg.subtype)
        && typeof this.controlSignalHandler === 'function') {
      return Promise.resolve()
        .then(() => this.controlSignalHandler(chatId, msg))
        .catch(e => console.warn('[RTCStore] Steuersignal-Verarbeitung fehlgeschlagen:', e?.message || e));
    }
    if (!this.buffer.has(chatId)) this.buffer.set(chatId, []);
    this.buffer.get(chatId).push(msg);
    if (msg.type === 'receipt') return null;
    console.log('[RTCStore] Nachricht gepuffert für:', chatId);
    let durable = null;
    if (USER_CONTENT_TYPES.has(msg.type)) {
      // Der Puffer lebt nur im Arbeitsspeicher - wurde die App beendet, bevor
      // der Chat geoeffnet wurde, war eine bereits bestaetigte Nachricht
      // bisher verloren. Jetzt verschluesselt abgelegt (ausser Secret Chat).
      if (!isEphemeral(msg)) {
        durable = this._persistInbox(chatId, msg).catch((e) => {
          console.warn('[RTCStore] Empfangs-Ablage fehlgeschlagen:', e?.message || e);
          return null;
        });
        this._inboxIds.set(msg, durable);
      }
      // Badge + Push Notification (chatId: App.tsx's showNotification()
      // ignoriert ihn, der Headless-Fallback aus index.js zeigt damit den
      // Kontaktnamen). Fuer Bild/Sprachnachricht/Datei fehlte das frueher
      // (Live-Test-Fund 2026-09-28: falscher Typ 'audio_end', fruehes return).
      if (global.showMalachiNotification) global.showMalachiNotification(chatId);
      if (global.incrementBadge) global.incrementBadge(chatId, previewForMessage(msg));
    }
    return durable;
  }

  // Secret-Chat-Inhalte aus dem RAM-Puffer eines Kontakts entfernen (Audit P1).
  dropEphemeralBuffered(chatId) {
    const list = this.buffer.get(chatId);
    if (!list) return 0;
    const keep = list.filter((m) => !isEphemeral(m));
    const dropped = list.length - keep.length;
    if (keep.length) this.buffer.set(chatId, keep); else this.buffer.delete(chatId);
    return dropped;
  }

  // Lokale Statusmeldung der eigenen Warteschlange (🕐/✓) an den offenen Chat
  // bzw. in den Puffer - ohne Dedup/Ablage/Benachrichtigung.
  deliverLocal(chatId, msg) {
    this._route(chatId, msg);
  }

  // ─── Medien-Zusammensetzung ───────────────────────────────────────────────
  // Gibt bei vollstaendigem, entschluesseltem Medium das *_complete-Objekt
  // zurueck, sonst null. Jeder Chunk ist einzeln verschluesselt und wurde von
  // WebRTCManager bereits entschluesselt/authentifiziert.
  _assemble(chatId, msg) {
    if (msg.type === 'audio_chunk') {
      if (!this.audioBuffer) this.audioBuffer = new Map();
      const bufKey = chatId + '_' + msg.audioId;
      if (!this.audioBuffer.has(bufKey)) {
        // Fund 7a/7b (Fuzzing-Kampagne) - siehe AudioCrypto.js fuer die
        // ausfuehrliche Begruendung, identisches Muster hier dupliziert.
        if (!Number.isInteger(msg.total) || msg.total < 0 || msg.total > 10000) {
          console.warn('[RTCStore] Ungueltiger total-Wert (audio) verworfen:', msg.total);
          return null;
        }
        sweepStaleBuffers(this.audioBuffer); // siehe Kommentar oben (Speicherleck-Fix)
        this.audioBuffer.set(bufKey, {
          chunks: new Array(msg.total), total: msg.total, received: 0, durationMs: 0, createdAt: Date.now()
        });
      }
      const buf = this.audioBuffer.get(bufKey);
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= buf.total) {
        console.warn('[RTCStore] Ungueltiger chunk-index (audio) verworfen:', msg.index);
        return null;
      }
      const alreadyFilled = buf.chunks[msg.index] !== undefined;
      buf.chunks[msg.index] = bufferedChunk(msg);
      if (!alreadyFilled) buf.received++;
      return null;
    }
    if (msg.type === 'audio_end') {
      if (!this.audioBuffer) return null;
      const bufKey = chatId + '_' + msg.audioId;
      const buf = this.audioBuffer.get(bufKey);
      if (!buf || buf.received < buf.total) return null;
      const fullBase64 = joinChunks(buf, msg, 'audio', msg.audioId);
      this.audioBuffer.delete(bufKey);
      if (fullBase64 === null) {
        console.warn('[RTCStore] Sprachnachricht verworfen: Chunks passen nicht zum Dateischluessel');
        return null;
      }
      const audioMsg = {
        type: 'audio_complete',
        audioId: msg.audioId,
        base64: fullBase64,
        durationMs: msg.durationMs,
        viewOnce: !!msg.viewOnce,
      };
      const id = normKey(msg.msgId);
      if (id) audioMsg.msgId = id;
      if (msg.secret === true) audioMsg.secret = true;   // Audit P1: nur RAM
      return audioMsg;
    }

    // Bild-Chunks sammeln und erst nach img_end ausliefern
    if (msg.type === 'img_chunk') {
      if (!this.imgBuffer) this.imgBuffer = new Map();
      const bufKey = (msg.isAvatarChunk ? 'avatar_' : '') + chatId + '_' + msg.imageId;
      if (!this.imgBuffer.has(bufKey)) {
        // Fund 7a/7b (Fuzzing-Kampagne) - siehe ImageCrypto.js fuer die
        // ausfuehrliche Begruendung, identisches Muster hier dupliziert.
        if (!Number.isInteger(msg.total) || msg.total < 0 || msg.total > 10000) {
          console.warn('[RTCStore] Ungueltiger total-Wert (bild) verworfen:', msg.total);
          return null;
        }
        sweepStaleBuffers(this.imgBuffer); // siehe Kommentar oben (Speicherleck-Fix)
        this.imgBuffer.set(bufKey, {
          chunks: new Array(msg.total),
          total: msg.total,
          mimeType: msg.mimeType,
          received: 0,
          isAvatar: !!msg.isAvatarChunk,
          createdAt: Date.now()
        });
      }
      const buf = this.imgBuffer.get(bufKey);
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= buf.total) {
        console.warn('[RTCStore] Ungueltiger chunk-index (bild) verworfen:', msg.index);
        return null;
      }
      const alreadyFilled = buf.chunks[msg.index] !== undefined;
      buf.chunks[msg.index] = bufferedChunk(msg);
      if (!alreadyFilled) buf.received++;
      return null; // Warte auf img_end
    }
    if (msg.type === 'img_end') {
      if (!this.imgBuffer) return null;
      // Audit C3: Profilbild oder Chat-Bild entscheidet der (verschluesselte,
      // mit Ratchet authentifizierte) End-Marker; die Chunks muessen dazu
      // passen (eigener Puffer, eigene Art in den Zusatzdaten).
      const endAvatar = msg.isAvatarChunk === true;
      const bufKey = (endAvatar ? 'avatar_' : '') + chatId + '_' + msg.imageId;
      const buf = this.imgBuffer.get(bufKey);
      if (!buf || buf.received < buf.total) return null;
      const fullBase64 = joinChunks(buf, msg, endAvatar ? 'avatar' : 'img', msg.imageId);
      this.imgBuffer.delete(bufKey);
      if (fullBase64 === null) {
        console.warn('[RTCStore] Bild verworfen: Chunks passen nicht zum Dateischluessel');
        return null;
      }
      // Mit Dateischluessel gilt der authentifizierte Typ aus dem End-Marker.
      if (msg.fk !== undefined && typeof msg.mimeType === 'string') buf.mimeType = msg.mimeType.slice(0, 100);
      if (endAvatar) {
        // Profilbild: wird beim Handshake (WebRTCManager) bzw. sofort hier
        // uebernommen - keine Chat-Nachricht, keine Bestaetigung.
        if (!this.pendingAvatars) this.pendingAvatars = new Map();
        this.pendingAvatars.set(chatId, { imageId: msg.imageId, base64: fullBase64, mimeType: buf.mimeType });
        // Sofort verarbeiten wenn Handshake bereits empfangen
        if (this.pendingAvatarExpected?.has(chatId)) {
          this.pendingAvatarExpected.delete(chatId);
          this.handleProfileAvatar(chatId);
        }
        return null;
      }
      const imageMsg = { type: 'image_complete', imageId: msg.imageId, base64: fullBase64, mimeType: buf.mimeType };
      const id = normKey(msg.msgId);
      if (id) imageMsg.msgId = id;
      if (msg.secret === true) imageMsg.secret = true;   // Audit P1: nur RAM
      console.log('[RTCStore] image_complete:', msg.imageId, 'Listener:', this.listeners.has(chatId));
      return imageMsg;
    }

    // Datei-Chunks sammeln und erst nach file_end ausliefern - identisches
    // Muster zu img_chunk/img_end oben, nur ohne Avatar-Sonderfall.
    if (msg.type === 'file_chunk') {
      if (!this.fileBuffer) this.fileBuffer = new Map();
      const bufKey = chatId + '_' + msg.fileId;
      if (!this.fileBuffer.has(bufKey)) {
        if (!Number.isInteger(msg.total) || msg.total < 0 || msg.total > 10000) {
          console.warn('[RTCStore] Ungueltiger total-Wert (datei) verworfen:', msg.total);
          return null;
        }
        sweepStaleBuffers(this.fileBuffer);
        this.fileBuffer.set(bufKey, { chunks: new Array(msg.total), total: msg.total, received: 0, createdAt: Date.now() });
      }
      const buf = this.fileBuffer.get(bufKey);
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= buf.total) {
        console.warn('[RTCStore] Ungueltiger chunk-index (datei) verworfen:', msg.index);
        return null;
      }
      const alreadyFilled = buf.chunks[msg.index] !== undefined;
      buf.chunks[msg.index] = bufferedChunk(msg);
      if (!alreadyFilled) buf.received++;
      return null;
    }
    if (msg.type === 'file_end') {
      if (!this.fileBuffer) return null;
      const bufKey = chatId + '_' + msg.fileId;
      const buf = this.fileBuffer.get(bufKey);
      if (!buf || buf.received < buf.total) return null;
      const fullBase64 = joinChunks(buf, msg, 'file', msg.fileId);
      this.fileBuffer.delete(bufKey);
      if (fullBase64 === null) {
        console.warn('[RTCStore] Datei verworfen: Chunks passen nicht zum Dateischluessel');
        return null;
      }
      const fileMsg = {
        type: 'file_complete', fileId: msg.fileId, base64: fullBase64,
        fileName: typeof msg.fileName === 'string' ? msg.fileName.slice(0, 255) : 'Datei',
        mimeType: msg.mimeType || 'application/octet-stream',
        size: Number.isFinite(msg.size) ? msg.size : fullBase64.length,
      };
      const id = normKey(msg.msgId);
      if (id) fileMsg.msgId = id;
      if (msg.secret === true) fileMsg.secret = true;    // Audit P1: nur RAM
      return fileMsg;
    }
    return null;
  }

  // ─── Bestaetigung ─────────────────────────────────────────────────────────
  // Bevorzugt ueber die Verbindung, auf der die Nachricht kam; ist die schon
  // zu, ueber die aktuelle. Best effort: geht die Bestaetigung verloren,
  // wiederholt der Absender und wir bestaetigen das Duplikat erneut.
  _receiptTarget(chatId, rtc) {
    const viaArrival = rtc && typeof rtc.sendMessage === 'function' && !rtc._closed
      && (!rtc.dataChannel || rtc.dataChannel.readyState === 'open');
    return viaArrival ? rtc : this.connections.get(chatId);
  }

  _sendReceipt(chatId, rtc, key) {
    const raw = JSON.stringify({ type: 'receipt', msgId: key, status: 'delivered' });
    try { this._receiptTarget(chatId, rtc)?.sendMessage?.(raw); } catch {}
  }

  _ackWhenDurable(chatId, rtc, key, durable) {
    Promise.all([durable || null, this._persistSeen(chatId)])
      .catch(() => {})
      .then(() => this._sendReceipt(chatId, rtc, key));
  }

  // ─── Dedup (persistent) ───────────────────────────────────────────────────
  _seenState(chatId) {
    let st = this._seen.get(chatId);
    if (st) return st;
    st = { set: new Set(), order: [], vol: [], loaded: false, load: null, writeChain: Promise.resolve(), writePending: null };
    this._seen.set(chatId, st);
    st.load = Promise.resolve()
      .then(() => EncryptedStorage.getItem(SEEN_PREFIX + chatId))
      .then((raw) => {
        let arr = [];
        try { arr = raw ? JSON.parse(raw) : []; } catch {}
        if (Array.isArray(arr) && arr.length) {
          // Persistierte (aeltere) Schluessel vor die in dieser Sitzung schon
          // gesehenen stellen.
          const sessionOrder = st.order;
          const merged = [];
          const mergedSet = new Set();
          for (const k of [...arr, ...sessionOrder]) {
            if (typeof k === 'string' && !mergedSet.has(k)) { mergedSet.add(k); merged.push(k); }
          }
          st.order = merged.slice(-SEEN_MAX);
          for (const k of st.order) st.set.add(k);
        }
      })
      .catch(() => {})
      .then(() => { st.loaded = true; });
    return st;
  }

  _hasSeen(chatId, key) {
    return this._seenState(chatId).set.has(key);
  }

  _markSeen(chatId, key, persist) {
    const st = this._seenState(chatId);
    st.set.add(key);
    const list = persist ? st.order : st.vol;
    list.push(key);
    const max = persist ? SEEN_MAX : VOLATILE_SEEN_MAX;
    while (list.length > max) {
      const old = list.shift();
      if (!st.order.includes(old) && !st.vol.includes(old)) st.set.delete(old);
    }
  }

  // Schreibt die Dedup-Liste (gebuendelt: Aenderungen waehrend eines laufenden
  // Schreibvorgangs landen im naechsten). Erst nach dem Laden - sonst wuerde
  // eine noch nicht gelesene, aeltere Liste ueberschrieben.
  _persistSeen(chatId) {
    const st = this._seenState(chatId);
    if (st.writePending) return st.writePending;
    const p = st.writeChain
      .then(() => st.load)
      .then(() => {
        st.writePending = null;
        if (st.dropped) return null; // Kontakt inzwischen geloescht/gewiped
        return EncryptedStorage.setItem(SEEN_PREFIX + chatId, JSON.stringify(st.order.slice(-SEEN_MAX)));
      })
      .catch(() => {});
    st.writePending = p;
    st.writeChain = p;
    return p;
  }

  // ─── Faehigkeiten der Gegenseite ──────────────────────────────────────────
  _notePeerCaps(chatId, msg) {
    // Double Ratchet: Faehigkeit merken (klebrig, siehe RatchetSession.
    // notePeerCaps). profile_name kommt bei jeder Verbindung - fehlt dort die
    // Angabe, ist die Gegenseite (noch) eine aeltere Version.
    const ratchetCap = Number(msg.caps?.ratchet) >= 1;
    if (ratchetCap || msg.subtype === 'profile_name') {
      RatchetSession.notePeerCaps(chatId, ratchetCap).catch(() => {});
    }
    const isNew = !!(msg.caps && Number(msg.caps.ack) >= 1);
    // handshake wird nur bei geaendertem Profilbild gesendet - ohne caps sagt
    // er nichts; profile_name kommt bei jeder Verbindung.
    if (!isNew && msg.subtype !== 'profile_name') return;
    const v = isNew ? 'new' : 'old';
    if (this.peerCaps.get(chatId) === v) return;
    this.peerCaps.set(chatId, v);
    EncryptedStorage.setItem(CAPS_PREFIX + chatId, v).catch(() => {});
  }

  getPeerCaps(chatId) {
    return this.peerCaps.get(chatId) || 'unknown';
  }

  // Laedt Dedup-Liste und Faehigkeiten eines Kontakts (idempotent) und stellt
  // die Empfangs-Ablage wieder her. Wird beim App-/Headless-Start fuer jeden
  // Kontakt ZUSAMMEN mit dessen Secret geladen (BackgroundSync.
  // loadPreviousSecret) - also lange bevor eine Verbindung steht.
  preloadContact(chatId) {
    if (!chatId) return Promise.resolve();
    const st = this._seenState(chatId);
    let caps = Promise.resolve();
    if (!this.peerCaps.has(chatId) && !this._capsLoading.has(chatId)) {
      this._capsLoading.add(chatId);
      caps = Promise.resolve()
        .then(() => EncryptedStorage.getItem(CAPS_PREFIX + chatId))
        .then((v) => { if ((v === 'new' || v === 'old') && !this.peerCaps.has(chatId)) this.peerCaps.set(chatId, v); })
        .catch(() => {})
        .then(() => { this._capsLoading.delete(chatId); });
    }
    return Promise.all([st.load, caps, this.ensureInboxRestored(), RatchetSession.preload(chatId)]).then(() => {});
  }

  // ─── Empfangs-Ablage ("Inbox") ────────────────────────────────────────────
  // Gepufferte Nutzerinhalte (Chat nicht offen) werden mit einem zufaelligen,
  // nur lokal bekannten Schluessel verschluesselt als Datei abgelegt; Index
  // (inkl. Schluessel) in EncryptedStorage. Beim Abholen durch den Chat
  // (getBuffered/takeBuffered) wieder geloescht, nach einem Neustart
  // wiederhergestellt (ensureInboxRestored).
  _withInboxLock(fn) {
    const run = this._inboxChain.then(fn);
    this._inboxChain = run.catch(() => {});
    return run;
  }

  async _readInboxIndex() {
    const raw = await EncryptedStorage.getItem(INBOX_INDEX_KEY).catch(() => null);
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  async _writeInboxIndex(idx) {
    if (idx.length) await EncryptedStorage.setItem(INBOX_INDEX_KEY, JSON.stringify(idx));
    else await EncryptedStorage.removeItem(INBOX_INDEX_KEY);
  }

  async _persistInbox(chatId, msg) {
    const id = await secureRandomToken(12);
    const k = await randomKeyB64(32);
    const enc = await encryptMsg(JSON.stringify(msg), k, 'inbox');
    if (!enc) throw new Error('Verschluesselung fehlgeschlagen');
    const path = `${RNFS.DocumentDirectoryPath}/${INBOX_FILE_PREFIX}${id}.enc`;
    await RNFS.writeFile(path, enc, 'utf8');
    this._sessionInboxIds.add(id);
    await this._withInboxLock(async () => {
      const idx = await this._readInboxIndex();
      idx.push({ id, chatId, path, k, at: Date.now() });
      await this._writeInboxIndex(idx);
    });
    return id;
  }

  _dropInbox(ids) {
    const drop = new Set(ids.filter(Boolean));
    if (!drop.size) return Promise.resolve();
    return this._withInboxLock(async () => {
      const idx = await this._readInboxIndex();
      const keep = [];
      for (const e of idx) {
        if (drop.has(e?.id)) await RNFS.unlink(e.path).catch(() => {});
        else keep.push(e);
      }
      if (keep.length !== idx.length) await this._writeInboxIndex(keep);
    }).catch(() => {});
  }

  // An den Chat uebergebene Nachrichten aus der Ablage entfernen (wartet ggf.
  // auf ein noch laufendes Ablegen derselben Nachricht).
  _releaseInbox(msgs) {
    const pending = [];
    for (const m of msgs) {
      const p = m && typeof m === 'object' ? this._inboxIds.get(m) : null;
      if (p) { this._inboxIds.delete(m); pending.push(p); }
    }
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending).then((ids) => this._dropInbox(ids));
  }

  ensureInboxRestored() {
    if (!this._inboxRestore) this._inboxRestore = this._restoreInbox().catch(() => {});
    return this._inboxRestore;
  }

  async _restoreInbox() {
    const entries = await this._withInboxLock(() => this._readInboxIndex());
    const byChat = new Map();
    const broken = [];
    for (const e of entries) {
      if (!e?.id || this._sessionInboxIds.has(e.id)) continue; // liegt schon im Speicher
      let msg = null;
      try {
        const enc = await RNFS.readFile(e.path, 'utf8');
        const plain = enc ? decryptMsg(enc, e.k, 'inbox') : null;
        msg = plain ? JSON.parse(plain) : null;
      } catch {}
      if (!msg || typeof msg !== 'object') { broken.push(e.id); continue; }
      this._sessionInboxIds.add(e.id);
      this._inboxIds.set(msg, Promise.resolve(e.id));
      if (!byChat.has(e.chatId)) byChat.set(e.chatId, []);
      byChat.get(e.chatId).push(msg);
    }
    for (const [chatId, msgs] of byChat) {
      this.buffer.set(chatId, [...msgs, ...(this.buffer.get(chatId) || [])]);
      console.log('[RTCStore] Empfangs-Ablage wiederhergestellt:', msgs.length, 'Nachricht(en)');
    }
    if (broken.length) await this._dropInbox(broken);
  }

  // Entfernt alle DAUERHAFT gespeicherten Empfangsdaten eines Kontakts
  // (Ablage, Dedup-Liste, Faehigkeiten) - bei Kontakt-Loeschung/Wipe.
  async dropPersistedContactData(chatId) {
    const st = this._seen.get(chatId);
    this._seen.delete(chatId);
    this.peerCaps.delete(chatId);
    if (st) {
      // Laufenden Schreibvorgang abwarten, sonst legt er die Liste nach dem
      // Loeschen wieder an.
      st.dropped = true;
      await st.writeChain.catch(() => {});
    }
    await EncryptedStorage.removeItem(SEEN_PREFIX + chatId).catch(() => {});
    await EncryptedStorage.removeItem(CAPS_PREFIX + chatId).catch(() => {});
    // Double Ratchet: Zustand, KEM-Vorrat und uebersprungene Schluessel.
    await RatchetSession.forget(chatId);
    await this._withInboxLock(async () => {
      const idx = await this._readInboxIndex();
      const keep = [];
      for (const e of idx) {
        if (e?.chatId === chatId) await RNFS.unlink(e.path).catch(() => {});
        else keep.push(e);
      }
      if (keep.length !== idx.length) await this._writeInboxIndex(keep);
    }).catch(() => {});
  }

  getConnection(chatId) {
    return this.connections.get(chatId);
  }

    setMessageListener(chatId, callback) {
    if (callback === null) {
      this.listeners.delete(chatId);
      console.log('[RTCStore] Listener entfernt für:', chatId);
      return;
    }
    this.listeners.set(chatId, callback);
    console.log('[RTCStore] Listener gesetzt für:', chatId);
  }

  sendMessage(chatId, text) {
    const rtc = this.connections.get(chatId);
    if (rtc) {
      return rtc.sendMessage(text);
    }
    return false;
  }

  isConnected(chatId) {
    const rtc = this.connections.get(chatId);
    if (!rtc) return false;
    const dcOpen = rtc?.dataChannel?.readyState === 'open';
    const iceOk = rtc?.pc?.iceConnectionState === 'connected' ||
                  rtc?.pc?.iceConnectionState === 'completed';
    return dcOpen && iceOk;
  }

  processAvatarEnd(chatId, msg) {
    // img_chunk Buffer für Avatar aufbauen
    if (!this.imgBuffer) this.imgBuffer = new Map();
    const avatarKey = 'avatar_' + chatId + '_' + msg.imageId;
    const buf = this.imgBuffer.get(avatarKey);
    if (buf && buf.received >= buf.total) {
      const fullBase64 = buf.chunks.join('');
      this.imgBuffer.delete(avatarKey);
      this.handleProfileAvatar(chatId, fullBase64, buf.mimeType);
    }
  }

  handleProfileAvatar(chatId) {
    if (!this.pendingAvatars) return;
    const pending = this.pendingAvatars.get(chatId);
    if (!pending) return;
    this.pendingAvatars.delete(chatId);
    const avatarUri = `data:${pending.mimeType};base64,${pending.base64}`;
    // Live-Test 2026-10-18: bei geschlossenem Chat lag das Profilbild nur im
    // RAM-Puffer - nach einem App-Neustart war es weg, und die Gegenseite
    // hielt es fuer zugestellt. Jetzt sofort beim Kontakt speichern
    // (BackgroundSync), unabhaengig davon, ob der Chat offen ist.
    if (typeof this.avatarReceivedHandler === 'function') {
      try { this.avatarReceivedHandler(chatId, avatarUri); } catch {}
    }
    const cb = this.listeners.get(chatId);
    const avatarMsg = { type: 'system', subtype: 'profile_avatar_received', avatarUri };
    if (cb) {
      cb(avatarMsg);
    } else {
      if (!this.buffer.has(chatId)) this.buffer.set(chatId, []);
      this.buffer.get(chatId).push(avatarMsg);
      console.log('[Profile] Avatar gepuffert für:', chatId);
    }
  }

  getSharedSecret(chatId) {
    return this.sharedSecrets.get(chatId) || null;
  }

  // Synchron (bestehende Aufrufer/Tests): liefert den Speicher-Puffer und gibt
  // die zugehoerigen Ablage-Eintraege frei.
  getBuffered(chatId) {
    const buffered = this.buffer.get(chatId) || [];
    this.buffer.delete(chatId);
    this._releaseInbox(buffered);
    return buffered;
  }

  // Fuer den Chat-Bildschirm: wartet zuerst, bis die Empfangs-Ablage nach
  // einem Neustart wiederhergestellt ist.
  async takeBuffered(chatId) {
    await this.ensureInboxRestored();
    return this.getBuffered(chatId);
  }

  // Setzt den gesamten In-Memory-Zustand des Singletons zurueck (Secrets-Lifecycle-
  // Review, Fund S-1): schliesst jede offene Verbindung und leert jede Map, damit
  // nach einem "vollstaendigen Wipe" keine Session-Secrets, gepufferten Klartexte
  // oder laufenden WebRTC-Verbindungen im Prozessspeicher ueberleben.
  onWipe(fn) {
    this.wipeListeners.add(fn);
    return () => this.wipeListeners.delete(fn);
  }

  _notifyWipe(chatId) {
    for (const fn of this.wipeListeners) {
      try { fn(chatId); } catch {}
    }
  }

  resetAll() {
    this._notifyWipe(null);
    for (const rtc of this.connections.values()) {
      try { rtc.close('wipe'); } catch {}
    }
    this.pendingCalls.clear();
    this.connections.clear();
    this.listeners.clear();
    this.buffer.clear();
    this.sharedSecrets.clear();
    this.previousSecrets.clear();
    this.activeCallContactId = null;
    this.audioBuffer?.clear();
    this.imgBuffer?.clear();
    this.fileBuffer?.clear();
    this.pendingAvatars?.clear();
    this.pendingAvatarExpected?.clear();
    this.profileSent?.clear();
    this.peerCaps.clear();
    this._seen.clear();
    // Ratchet-Zustaende im Arbeitsspeicher verwerfen; laufende Ratchet-
    // Operationen speichern danach nichts mehr (den Speicher leert der Wipe).
    RatchetSession.forgetAll();
    this._sessionInboxIds.clear();
    this._inboxIds = new WeakMap();
    this._inboxRestore = null;
  }

  // Loescht den gesamten In-Memory-Zustand eines einzelnen Kontakts (Secrets-
  // Lifecycle-Review, Fund S-3): schliesst dessen Verbindung und entfernt alle
  // fuer ihn gepufferten Nachrichten/Chunks, ohne andere Kontakte zu beruehren.
  // (Dauerhaft Gespeichertes raeumt dropPersistedContactData() ab.)
  clearContact(chatId) {
    this._notifyWipe(chatId);
    const existing = this.connections.get(chatId);
    if (existing) {
      try { existing.close('wipe'); } catch {}
      this.connections.delete(chatId);
    }
    this.listeners.delete(chatId);
    this.buffer.delete(chatId);
    this.sharedSecrets.delete(chatId);
    this.previousSecrets.delete(chatId);
    this.pendingCalls.delete(chatId);
    this.pendingAvatars?.delete(chatId);
    this.pendingAvatarExpected?.delete(chatId);
    this.profileSent?.delete(chatId);
    this.peerCaps.delete(chatId);
    this._seen.delete(chatId);
    RatchetSession.forgetFromMemory(chatId);
    const prefix = chatId + '_';
    for (const map of [this.audioBuffer, this.fileBuffer]) {
      if (!map) continue;
      for (const key of Array.from(map.keys())) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
    if (this.imgBuffer) {
      const avatarPrefix = 'avatar_' + chatId + '_';
      for (const key of Array.from(this.imgBuffer.keys())) {
        if (key.startsWith(prefix) || key.startsWith(avatarPrefix)) this.imgBuffer.delete(key);
      }
    }
  }
}

export default new RTCStore();
