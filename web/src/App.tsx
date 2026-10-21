import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import './App.css';
// Redesign 2026 (reine Darstellungsschicht, siehe Datei-Kopf) - diese eine
// Zeile entfernen, um zum bisherigen Aussehen zurueckzukehren.
import './theme-2026.css';
import { getItem, setItem, removeItem, hasPinSetup, setupEncryption, unlockEncryption } from './lib/Storage';
import { encryptMsg, decryptMsg } from './lib/MessageCrypto';
import { startWakeSocket, setWakeSubscriptions, onWake } from './lib/RelayClient';
import { WebRTCManager } from './lib/WebRTCManager';
import RTCStore from './lib/RTCStore';
import CallManager, { CallState, type CallStateT } from './lib/CallManager';
import { encryptOfferForCandidates, offerCiphertexts, decryptWithCandidates } from './lib/SecretCandidates';

// Kurzer, immer sichtbarer Teaser statt langer, permanent ausgeschriebener
// Technik-Erklaerung (Design-Feedback: wirkte ueberladen) - Klick klappt den
// vollen Text auf/zu. Gegenstueck zu CollapsibleNotice in App.tsx (nativ).
function CollapsibleNotice({ teaser, children }: { teaser: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="collapsible-notice" onClick={() => setOpen((o) => !o)}>
      <div className="collapsible-notice-row">
        <span className="muted">{teaser}</span>
        <span className="muted">{open ? '▲' : '▼'}</span>
      </div>
      {open && <p className="muted" style={{ marginTop: '6px' }}>{children}</p>}
    </div>
  );
}

interface Contact {
  id: string;
  name: string;
  role: 'initiator' | 'responder';
  wiped?: boolean;
  // Vom Nutzer geloescht, Loesch-Hinweis wartet noch auf P2P-Zustellung.
  pendingDelete?: boolean;
  pendingDeleteSince?: number;
}

interface Msg {
  id: string;
  text: string;
  mine: boolean;
  time: string;
  status?: 'sending' | 'sent' | 'failed';
}

type Screen = 'setup' | 'lock' | 'home' | 'chat' | 'call' | 'connect';

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Zeitstempel-Frische-Pruefung fuer den Replay-Schutz (Sicherheitsreview 4,
// mirrors App.tsx). Vorher liess sich `Date.now() - ts > 15min` mit einem
// weit in der Zukunft liegenden ts (z.B. Infinity) dauerhaft umgehen - die
// Nachricht galt dann fuer immer als "frisch". ts muss jetzt endlich sein und
// darf hoechstens 5 Minuten in der Zukunft liegen (Uhr-Drift-Toleranz,
// bewusst kleiner als das 15-Minuten-Fenster).
function isFreshTimestamp(ts: number): boolean {
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  if (age > 15 * 60 * 1000) return false;
  if (age < -5 * 60 * 1000) return false;
  return true;
}

// Serialisiert JEDEN Lese-Aendere-Schreibe-Zyklus auf den 'contacts'-
// Schluessel (mirrors App.tsx nativ - Konkurrenz-/Rot-Team-Review Fund 1
// dort, hier nachgezogen: derselbe Bug existierte in kleinerer Form ueber
// saveContacts()'s zwei Aufrufstellen, die beide direkt aus dem React-State
// statt aus dem Storage lasen und dadurch ohne Koordination gegeneinander
// schreiben konnten). `mutator(current)` bekommt die aktuell gespeicherte
// Kontaktliste und gibt entweder die neue Liste zurueck (wird geschrieben)
// oder null/undefined, wenn nichts zu aendern war.
let contactsWriteChain: Promise<unknown> = Promise.resolve();
export async function updateContacts(
  mutator: (current: Contact[]) => Contact[] | null | undefined | Promise<Contact[] | null | undefined>,
): Promise<Contact[] | null | undefined> {
  const run = contactsWriteChain.then(async () => {
    const saved = await getItem('contacts');
    const current: Contact[] = saved ? JSON.parse(saved) : [];
    const updated = await mutator(current);
    if (updated != null) await setItem('contacts', JSON.stringify(updated));
    return updated;
  });
  // Muss auch bei einem Fehler weiterlaufen - sonst wuerde ein einziger
  // fehlgeschlagener Aufruf die Kette dauerhaft blockieren.
  contactsWriteChain = run.catch(() => {});
  return run;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [username, setUsername] = useState('');
  const [pendingName, setPendingName] = useState(''); // Name aus SetupScreen, bis der PIN steht und wir verschluesselt speichern koennen
  const [hasExistingPin, setHasExistingPin] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [chat, setChat] = useState<Contact | null>(null);
  const [callState, setCallState] = useState<CallStateT>(CallState.IDLE);
  const callManagerRef = useRef<CallManager | null>(null);

  // Alles ist jetzt PIN-verschluesselt - Username/Kontakte lassen sich vor
  // dem Entsperren gar nicht lesen. Wir koennen beim Start nur pruefen, OB
  // schon ein PIN existiert (Salt vorhanden), nicht wer der Nutzer ist.
  useEffect(() => {
    if (hasPinSetup()) {
      setHasExistingPin(true);
      setScreen('lock');
    }
  }, []);

  // WS-Wecksignal starten (einmalig) und bei jeder Kontakt-Aenderung die
  // Abo-Liste aktualisieren - siehe RelayClient.ts. Ersetzt kein bestehendes
  // Polling, laesst es nur seltener tatsaechlich etwas finden muessen.
  useEffect(() => { startWakeSocket(); }, []);
  useEffect(() => { setWakeSubscriptions(contacts.map((c) => c.id)); }, [contacts]);

  // Auto-Reconnect (Initiator-Seite) - fehlte in der Web-Version komplett,
  // dadurch war nach einem Seiten-Reload/Tab-Neustart nie wieder eine echte
  // WebRTC-Verbindung da: Nachrichten liefen dann jedes Mal erst 30s erfolglos
  // gegen den (nicht existenten) Datenkanal, bevor der Relay-Fallback griff -
  // fuehlte sich wie "haengt fest" an.
  //
  // Bewusst NICHT nach nativem "nur einmal beim Start"-Muster gebaut: laeuft
  // hier dauerhaft im Intervall (wie die Responder-Seite) statt nur einmal zu
  // feuern. Grund: wenn die eigene Verbindung erst NACH diesem einen Versuch
  // wegbricht (z.B. Netzwerkwechsel, WLAN kurz weg), haette ein "nur einmal"-
  // Guard das nie wieder selbst repariert - der Fehler, den wir gerade jagen,
  // waere so nur halb behoben gewesen.
  const initiatorConnecting = useRef(new Set<string>());
  // Audit 2026-09-28: pro Kontakt genau ein verwalteter Versuch (siehe
  // gleichnamiger Umbau in BackgroundSync.js) - vorher wurde die
  // RTCPeerConnection eines unbeantworteten oder fehlgeschlagenen Versuchs
  // nie geschlossen (Leck samt TURN-Allokation, alle 10s ein neues).
  const outgoingAttempts = useRef(new Map<string, { rtc: WebRTCManager; poll: ReturnType<typeof setInterval> | null; deadline: ReturnType<typeof setTimeout> | null }>());
  const abandonAttempt = (contactId: string, onlyRtc?: WebRTCManager) => {
    const att = outgoingAttempts.current.get(contactId);
    if (!att || (onlyRtc && att.rtc !== onlyRtc)) return;
    outgoingAttempts.current.delete(contactId);
    if (att.poll) clearInterval(att.poll);
    if (att.deadline) clearTimeout(att.deadline);
    if (RTCStore.connections.get(contactId) !== att.rtc) { try { att.rtc.close(); } catch { /* egal */ } }
    initiatorConnecting.current.delete(contactId);
  };
  // Netzwechsel: unbeantwortete Angebote tragen Kandidaten des alten Netzes.
  useEffect(() => {
    const onOnline = () => {
      for (const id of Array.from(outgoingAttempts.current.keys())) {
        if (!RTCStore.isConnected(id)) abandonAttempt(id);
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);
  // Audit 2026-09-28: lief bisher NUR auf dem Home-Screen - sobald man einen
  // Chat offen hatte, gab es fuer Initiator-Kontakte gar keinen Reconnect mehr
  // (derselbe Fehler war nativ schon behoben). Jetzt immer, sobald entsperrt.
  const unlocked = screen !== 'setup' && screen !== 'lock';
  useEffect(() => {
    const checkOutgoing = async () => {
      const { sendReconnectOffer, getReconnectAnswer } = await import('./lib/RelayClient');
      for (const contact of contacts) {
        if (contact.role !== 'initiator') continue;
        if (RTCStore.isConnected(contact.id) || initiatorConnecting.current.has(contact.id)) continue;
        // Reconnect-Offer/Answer MUESSEN mit dem bereits etablierten Shared
        // Secret verschluesselt werden - genau wie beim Erst-Pairing per PSK.
        // Ohne das kann jeder, der contact.id kennt (der Relay trivial, oder
        // wer das urspruengliche Pairing beobachtet hat), das Offer lesen und
        // mit einer eigenen Antwort MITMen (Sicherheitsreview C-1).
        const candidates = RTCStore.getSecretCandidates(contact.id);
        if (candidates.length === 0) continue;
        initiatorConnecting.current.add(contact.id);
        const offerKey = contact.id + '_offer';
        const sessionId = Math.random().toString(36).slice(2, 10);
        const answerKey = contact.id + '_answer_' + sessionId;
        const rtc: WebRTCManager = new WebRTCManager(
          () => {},
          () => {
            RTCStore.setConnection(contact.id, rtc);
            initiatorConnecting.current.delete(contact.id);
            const att = outgoingAttempts.current.get(contact.id);
            if (att?.rtc === rtc) {
              if (att.poll) clearInterval(att.poll);
              if (att.deadline) clearTimeout(att.deadline);
              outgoingAttempts.current.delete(contact.id);
            }
          },
          () => {
            const att = outgoingAttempts.current.get(contact.id);
            if (!att || att.rtc === rtc) { abandonAttempt(contact.id, rtc); initiatorConnecting.current.delete(contact.id); }
          },
        );
        outgoingAttempts.current.set(contact.id, { rtc, poll: null, deadline: null });
        try {
          const offerJSON = await rtc.createOffer();
          // purpose 'reconnect' - eigener Unterschluessel (Sicherheitsreview
          // Review 2, Domain-Separation). Muss mit native App.tsx identisch sein.
          const encryptedOffer = await encryptOfferForCandidates(JSON.stringify({ sdp: JSON.parse(offerJSON).sdp, answerKey }), candidates);
          if (!encryptedOffer || rtc._closed) { abandonAttempt(contact.id, rtc); continue; }
          const sent = await sendReconnectOffer(encryptedOffer, offerKey);
          if (!sent || rtc._closed) { abandonAttempt(contact.id, rtc); continue; }
          let handled = false;
          const poll = setInterval(async () => {
            if (handled) return;
            if (RTCStore.isConnected(contact.id)) { abandonAttempt(contact.id, rtc); return; }
            const encryptedAnswer = await getReconnectAnswer(answerKey);
            if (!encryptedAnswer || handled) return;
            const opened = decryptWithCandidates([encryptedAnswer], candidates, 'reconnect');
            if (!opened) return; // Entschluesselung fehlgeschlagen - moeglicher Angriff, weiter warten
            handled = true;
            clearInterval(poll);
            try { await rtc.handleAnswer(opened.plain); } catch { abandonAttempt(contact.id, rtc); }
          }, 5000);
          // Ohne Antwort nach 5 Min. aufgeben - jetzt inklusive rtc.close().
          const deadline = setTimeout(() => abandonAttempt(contact.id, rtc), 5 * 60 * 1000);
          const att = outgoingAttempts.current.get(contact.id);
          if (att?.rtc === rtc) { att.poll = poll; att.deadline = deadline; }
          else { clearInterval(poll); clearTimeout(deadline); }
        } catch {
          abandonAttempt(contact.id, rtc);
        }
      }
    };
    if (!unlocked) return;
    checkOutgoing();
    const interval = setInterval(checkOutgoing, 10000);
    const unsub = onWake(() => { checkOutgoing(); });
    return () => { clearInterval(interval); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, contacts]);

  // Auto-Reconnect (Responder-Seite) - laeuft dauerhaft, prueft periodisch auf
  // eingehende Reconnect-Offers von "responder"-Kontakten.
  const responderConnecting = useRef(new Set<string>());
  // Audit 2026-09-28: Zyklus-Sperre wie ueberall sonst (fehlte hier) - bei
  // haengendem Relay summierten sich pro 5s-Tick weitere Durchlaeufe.
  const incomingCycleRunning = useRef(false);
  useEffect(() => {
    const checkIncoming = async () => {
      if (incomingCycleRunning.current) return;
      incomingCycleRunning.current = true;
      try {
      const { getReconnectOffer, sendReconnectAnswer } = await import('./lib/RelayClient');
      for (const contact of contacts) {
        if (contact.role !== 'responder') continue;
        if (RTCStore.isConnected(contact.id) || responderConnecting.current.has(contact.id)) continue;
        const offerKey = contact.id + '_offer';
        const encryptedOffer = await getReconnectOffer(offerKey);
        if (!encryptedOffer) continue;
        // Ohne bereits etabliertes Shared Secret koennen wir das Offer weder
        // verifizieren noch entschluesseln - dann ignorieren statt (wie vorher)
        // ein unverschluesseltes/manipuliertes Offer blind anzunehmen (C-1).
        // Audit 2026-09-28: alle Secret-Kandidaten + Angebotsformat v2.
        const candidates = RTCStore.getSecretCandidates(contact.id);
        if (candidates.length === 0) continue;
        const opened = decryptWithCandidates(offerCiphertexts(encryptedOffer), candidates, 'reconnect');
        if (!opened) continue; // Entschluesselung fehlgeschlagen - moeglicher Angriff, verwerfen
        const secretForOffer = opened.secret;
        responderConnecting.current.add(contact.id);
        let rtc: WebRTCManager | null = null;
        try {
          const parsed = JSON.parse(opened.plain);
          if (typeof parsed.answerKey !== 'string' || !parsed.answerKey.startsWith(contact.id + '_answer_')) {
            throw new Error('ungueltiger answerKey');
          }
          const thisRtc: WebRTCManager = new WebRTCManager(
            () => {},
            () => {
              RTCStore.setConnection(contact.id, thisRtc);
              responderConnecting.current.delete(contact.id);
            },
            () => responderConnecting.current.delete(contact.id),
          );
          rtc = thisRtc;
          const answer = await thisRtc.createAnswerDirect(JSON.stringify({ sdp: parsed.sdp }));
          const encryptedAnswer = await encryptMsg(answer, secretForOffer, 'reconnect');
          if (!encryptedAnswer) throw new Error('Verschluesselung fehlgeschlagen');
          const sent = await sendReconnectAnswer(encryptedAnswer, parsed.answerKey);
          if (!sent) throw new Error('Antwort nicht gesendet');
        } catch {
          if (rtc) { try { rtc.close(); } catch { /* egal */ } }
          responderConnecting.current.delete(contact.id);
        }
      }
      } finally {
        incomingCycleRunning.current = false;
      }
    };
    checkIncoming();
    // Siehe identische Aenderung/Begruendung in der nativen App.tsx.
    const interval = setInterval(checkIncoming, 5000);
    const unsub = onWake(() => checkIncoming());
    return () => { clearInterval(interval); unsub(); };
  }, [contacts]);

  // Relay-zugestellte Nachrichten abholen - Gegenstueck zum Relay-Fallback in
  // send() (ChatScreen). Ohne das kaeme eine Nachricht, die der Kontakt
  // geschickt hat waehrend WIR offline waren, nie an, selbst nachdem wir
  // wieder online sind - sie liegt sonst nur auf dem Relay und wird nie
  // abgeholt. Direkt an RTCStore.buffer vorbei, RTCStore selbst kennt den
  // Relay-Pfad nicht (das ist reine Web-Zustaendigkeit, kein WebRTC-Msg).
  // Chaos-Test-Fund (SECURITY_CHAOS_TESTING.md §3/§8, Fix 4 - identisches
  // Problem/gleiche Loesung wie bei App.tsx (nativ) checkOutgoing/
  // checkIncoming): dieser Poll-Loop feuerte bisher auf jedem 8s-Tick
  // unbedingt, egal ob der vorherige Zyklus (ein fetch() pro Kontakt an den
  // Relay) noch lief - gegen einen Relay, der eine Verbindung annimmt aber
  // nie antwortet, haetten sich so pro Tick weitere haengende Requests
  // aufsummiert. Einfache Zyklus-Sperre, useRef statt State (kein Re-Render
  // noetig, reine interne Buchhaltung).
  const offlinePacketsCycleRunning = useRef(false);
  useEffect(() => {
    const checkOfflinePackets = async () => {
      if (offlinePacketsCycleRunning.current) return;
      offlinePacketsCycleRunning.current = true;
      try {
      const { getPackets, ackPackets } = await import('./lib/RelayClient');
      for (const contact of contacts) {
        const packets = await getPackets(contact.id);
        // Relay loescht ein abgeholtes /packet erst nach explizitem Ack, nicht
        // mehr sofort bei getPackets() (relay.js - State-Machine-Review,
        // Nachrichtenverlust-Fund, mirrors App.tsx). Erst nach Verarbeitung
        // aller Pakete dieser Runde in einem Batch bestaetigen.
        const ackTokens: string[] = [];
        for (const packet of packets) {
          if (packet.token) ackTokens.push(packet.token);
          try {
            const msg = JSON.parse(packet.payload);
            if (msg.type !== 'encrypted') continue;
            const candidates = RTCStore.getSecretCandidates(contact.id);
            if (candidates.length === 0) continue; // ohne Secret koennen wir es nicht lesen - geht sonst verloren
            const plaintext = decryptWithCandidates([msg.data], candidates)?.plain;
            if (!plaintext) continue;
            const original = JSON.parse(plaintext);
            // Verschluesselung allein garantiert keine Frische - ein Angreifer
            // mit Relay-Zugriff koennte eine einmal beobachtete, gueltig
            // verschluesselte Nachricht beliebig spaeter erneut einspielen
            // (Sicherheitsreview 3, mirrors App.tsx). Aelter als 15 Minuten
            // (bzw. kein Zeitstempel vorhanden) wird verworfen.
            // Audit 2026-09-28: Chat-Nachrichten tragen ihren Zeitstempel in
            // `time`, nicht `ts` (siehe nativ: `original.ts || original.time`)
            // - normale Textnachrichten ueber den Relay-Pfad wurden hier bisher
            // IMMER als "Replay" verworfen.
            if (!isFreshTimestamp(original.ts ?? original.time)) {
              console.warn('[Security] Nachricht ohne gueltigen/frischen Zeitstempel verworfen (moeglicher Replay)');
              continue;
            }
            // Gegenueber hat sein Geraet zurueckgesetzt (State-Machine-Review,
            // Nutzer-Fund 3, mirrors App.tsx) - Kontakt wird als "tombstoned"
            // markiert statt entfernt; Chatverlauf/Secret sind hinueber, eine
            // weitere Kommunikation ueber das alte Secret ist ohnehin sinnlos.
            // Web implementiert (noch) keine anderen system-Subtypes
            // (delete_chat/secret_start/secret_end) - bewusst nur dieser eine
            // neu hinzugefuegt, keine groessere Nacharbeit an dieser Stelle.
            //
            // BEKANNTE, AKZEPTIERTE EINSCHRAENKUNG (Architektur-Review,
            // SECURITY_ARCHITECTURE_THREAT_MODEL.md §3.2): wenn dieses Paket
            // NIE ankommt (boesartiger Relay unterdrueckt es, oder verzoegert
            // es ueber das Frische-Fenster hinaus), bleibt der Kontakt hier
            // einfach unveraendert "verbunden" - inhaerent am Single-Relay-
            // Zustellmodell, kein Bug in diesem Handler, siehe Dokument §3.2.
            if (original.type === 'system' && original.subtype === 'device_wiped') {
              console.log('[Wipe] Kontakt hat sein Geraet zurueckgesetzt:', contact.name);
              setContacts((c) => c.map((x) =>
                x.id === contact.id ? { ...x, wiped: true, name: 'Wiped Kontakt' } : x));
              // Ueber updateContacts serialisiert (Rot-Team-Review Fund 1,
              // hier nachgezogen).
              updateContacts((cs) => cs.map((c) =>
                c.id === contact.id ? { ...c, wiped: true, name: 'Wiped Kontakt' } : c)).catch(() => {});
              removeItem('chat_' + contact.id).catch(() => {});
              removeItem('shared_secret_' + contact.id).catch(() => {});
              // Gesamten In-Memory-Zustand für diesen Kontakt löschen (schließt
              // auch dessen Verbindung, Secrets-Lifecycle-Review Fund S-3).
              RTCStore.clearContact(contact.id);
              continue;
            }
            // Plattform-Paritaet: Gegenueber hat den Chat bei sich geloescht -
            // fehlte im Web komplett (per Live-Test bemerkt), mirrors App.tsx.
            if (original.type === 'system' && original.subtype === 'delete_chat') {
              console.log('[Delete] Kontakt hat den Chat geloescht:', contact.name);
              deleteContactCleanup(contact.id);
              continue;
            }
            const listener = RTCStore.listeners.get(contact.id);
            if (listener) {
              listener(original);
            } else {
              if (!RTCStore.buffer.has(contact.id)) RTCStore.buffer.set(contact.id, []);
              RTCStore.buffer.get(contact.id)!.push(original);
            }
          } catch {
            /* einzelnes kaputtes Paket ueberspringen, Rest trotzdem verarbeiten */
          }
        }
        void ackPackets(contact.id, ackTokens);
      }
      } finally {
        // Muss auch bei einem Fehler mitten im Zyklus zurueckgesetzt werden -
        // sonst wuerde ein einziger geworfener Fehler die Sperre dauerhaft
        // haengen lassen und JEDEN weiteren Zyklus fuer immer blockieren.
        offlinePacketsCycleRunning.current = false;
      }
    };
    checkOfflinePackets();
    const interval = setInterval(checkOfflinePackets, 8000);
    const unsub = onWake(() => checkOfflinePackets());
    return () => { clearInterval(interval); unsub(); };
  }, [contacts]);

  // Wiederkehrende Anrufe erkennen - Muster wie in App.tsx (nativ):
  // waehrend kein Anruf laeuft, alle 2s prophylaktisch pruefen, ob fuer
  // einen Kontakt ein eingehendes 'offer' wartet.
  useEffect(() => {
    const check = async () => {
      if (callManagerRef.current) return;
      for (const contact of contacts) {
        if (callManagerRef.current) return;
        const { pollCallSignals } = await import('./lib/RelayClient');
        const signals = await pollCallSignals(contact.id, 'to-callee');
        const offerSignal = signals.find((s) => s.type === 'offer');
        if (!offerSignal) continue;
        const cm = new CallManager({
          contactId: contact.id,
          peerName: contact.name,
          onStateChange: (s) => {
            setCallState(s);
            if (s === CallState.IDLE) {
              callManagerRef.current = null;
              setChat(contact);
              setScreen('chat');
            }
          },
          onRemoteStream: (stream) => attachRemoteAudio(stream),
        });
        callManagerRef.current = cm;
        setChat(contact);
        setScreen('call');
        await cm.handleSignal(offerSignal as any);
        setCallState(cm.state);
      }
    };
    const interval = setInterval(check, 2000);
    // Anruf-Poll bewusst NICHT verlaengert und weiterhin per Timer aktiv,
    // auch mit Wecksignal - das ist die letzte Verteidigungslinie fuers
    // Klingeln, falls das WS gerade tot ist (siehe Push-Architektur-Plan).
    const unsub = onWake(() => check());
    return () => { clearInterval(interval); unsub(); };
  }, [contacts]);

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  function attachRemoteAudio(stream: MediaStream) {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.play().catch(() => {});
    }
  }

  const startOutgoingCall = (contact: Contact) => {
    if (callManagerRef.current) return;
    const cm = new CallManager({
      contactId: contact.id,
      peerName: contact.name,
      onStateChange: (s) => {
        setCallState(s);
        if (s === CallState.IDLE) {
          callManagerRef.current = null;
          setChat(contact);
          setScreen('chat');
        }
      },
      onRemoteStream: (stream) => attachRemoteAudio(stream),
    });
    callManagerRef.current = cm;
    setChat(contact);
    setScreen('call');
    cm.startCall();
  };

  // Plattform-Paritaet: Loeschen fehlte im Web komplett (per Live-Test
  // bemerkt) - mirrors deleteContact()/requestContactDeletion() nativ.
  // Nur-P2P-Umstellung 2026-09-29: kein Relay-Parallelversand (/packet) mehr.
  // Besteht gerade eine direkte Verbindung, geht der Hinweis sofort raus;
  // sonst wartet er in der lokalen Sende-Warteschlange (Queue.ts) und der
  // Kontakt bleibt bis zur Zustellung unsichtbar vorgemerkt (pendingDelete) -
  // die Reconnect-Schleifen laufen fuer ihn weiter, damit die naechste
  // direkte Verbindung den Hinweis zustellen kann.
  const deleteContact = async (chatId: string) => {
    removeItem('chat_' + chatId).catch(() => {});
    if (chat?.id === chatId) setScreen('home');
    const secret = RTCStore.getSharedSecret(chatId);
    const ts = Date.now();
    const { queueOffline, flushQueue } = await import('./lib/Queue');
    const queued = secret
      ? await queueOffline(chatId, 'system', { type: 'system', subtype: 'delete_chat', ts }, secret, 'delchat_' + ts)
      : false;
    if (!queued) { deleteContactCleanup(chatId); return; }
    const mark = (x: Contact) => (x.id === chatId ? { ...x, pendingDelete: true, pendingDeleteSince: Date.now() } : x);
    setContacts((c) => c.map(mark));
    updateContacts((cs) => cs.map(mark)).catch(() => {});
    const rtc = RTCStore.getConnection(chatId);
    if (rtc && RTCStore.isConnected(chatId)) flushQueue(chatId, rtc).catch(() => {});
  };
  // Nur lokal entfernen (Loeschung von der Gegenseite, oder eigener
  // Loesch-Hinweis bereits zugestellt) - schickt nichts.
  const deleteContactCleanup = (chatId: string) => {
    setContacts((c) => c.filter((x) => x.id !== chatId));
    updateContacts((cs) => cs.filter((x) => x.id !== chatId)).catch(() => {});
    removeItem('chat_' + chatId).catch(() => {});
    RTCStore.clearContact(chatId);
    removeItem('shared_secret_' + chatId).catch(() => {});
    removeItem('shared_secret_prev_' + chatId).catch(() => {});
    // Review-Fund 2026-09-27 ("M3", siehe identischer Fix in der nativen
    // App.tsx): die lokale Sende-Warteschlange (samt secretUsed) muss mit.
    removeItem('queue_' + chatId).catch(() => {});
  };
  const markContactWiped = (contactId: string) => {
    setContacts((c) => c.map((x) =>
      x.id === contactId ? { ...x, wiped: true, name: 'Wiped Kontakt' } : x));
    updateContacts((cs) => cs.map((c) =>
      c.id === contactId ? { ...c, wiped: true, name: 'Wiped Kontakt' } : c)).catch(() => {});
    removeItem('chat_' + contactId).catch(() => {});
    removeItem('shared_secret_' + contactId).catch(() => {});
    removeItem('shared_secret_prev_' + contactId).catch(() => {});
    removeItem('queue_' + contactId).catch(() => {});
    RTCStore.clearContact(contactId);
  };
  // Per P2P empfangene Steuersignale (RTCStore.ts) und zugestellte eigene
  // Loesch-Hinweise (Queue.ts). Refs, damit die Handler immer den aktuellen
  // Render-Stand (chat/screen) sehen.
  const deleteContactCleanupRef = useRef(deleteContactCleanup);
  deleteContactCleanupRef.current = deleteContactCleanup;
  const markContactWipedRef = useRef(markContactWiped);
  markContactWipedRef.current = markContactWiped;
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chat?.id ?? null;
  useEffect(() => {
    RTCStore.controlSignalHandler = (chatId, msg) => {
      if (msg.subtype === 'delete_chat') {
        if (chatIdRef.current === chatId) setScreen('home');
        deleteContactCleanupRef.current(chatId);
      } else if (msg.subtype === 'device_wiped') {
        markContactWipedRef.current(chatId);
      }
    };
    let unsetDeliveredHandler = () => {};
    import('./lib/Queue').then(({ setDeleteNoticeDeliveredHandler }) => {
      setDeleteNoticeDeliveredHandler((id) => deleteContactCleanupRef.current(id));
      unsetDeliveredHandler = () => setDeleteNoticeDeliveredHandler(null);
    });
    return () => { RTCStore.controlSignalHandler = null; unsetDeliveredHandler(); };
  }, []);

  return (
    <div className="app">
      <audio ref={remoteAudioRef} autoPlay />
      {screen === 'setup' && (
        <SetupScreen
          onDone={(name) => {
            setPendingName(name);
            setScreen('lock');
          }}
        />
      )}
      {screen === 'lock' && (
        <LockScreen
          hasPin={hasExistingPin}
          onUnlock={async (enteredPin) => {
            if (!hasExistingPin) {
              // Erstmaliges Festlegen - danach ist der Storage entsperrt und
              // wir koennen den vorhin eingegebenen Namen verschluesselt ablegen.
              try {
                await setupEncryption(enteredPin);
              } catch (e) {
                // Fehlerbehandlungs-Review: vorher wurde JEDER Fehlschlag hier
                // (echter Netzwerkfehler, aber auch ein 409 "Geraet bereits
                // registriert" - siehe Storage.ts setupEncryption()/
                // RelayClient.ts pepperRegister()) auf dieselbe "Relay nicht
                // erreichbar"-Meldung abgebildet, unabhaengig von der
                // tatsaechlichen Ursache - eine falsche Fehlklassifizierung
                // fuer den Nutzer/Support. setupEncryption() wirft jetzt pro
                // Ursache eine eigene, unterscheidbare Meldung; die hier
                // gezeigte Meldung uebernimmt sie direkt statt sie zu verwerfen.
                return e instanceof Error && e.message
                  ? e.message
                  : 'Relay nicht erreichbar - PIN kann gerade nicht eingerichtet werden.';
              }
              await setItem('username', pendingName);
              setUsername(pendingName);
              setScreen('home');
              return '';
            }
            const result = await unlockEncryption(enteredPin);
            if (!result.ok) {
              switch (result.reason) {
                case 'locked': {
                  const secs = Math.ceil((result.lockedUntil - Date.now()) / 1000);
                  return `🚨 Gesperrt noch ${Math.max(secs, 1)}s`;
                }
                case 'wiped':
                  // In-Memory-Zustand von RTCStore zurücksetzen (Secrets-
                  // Lifecycle-Review, Fund S-1): offene Verbindungen schließen,
                  // gepufferte Klartexte und gecachte Shared Secrets entfernen -
                  // sonst überleben sie den Pepper-Wipe im Tab-Prozess.
                  RTCStore.resetAll();
                  // Produktions-Realitaets-Review: Storage.ts hat localStorage
                  // bereits geleert (SALT_KEY inklusive), aber `hasExistingPin`
                  // wurde bisher NIE zurueckgesetzt - hasPinSetup() wird nur
                  // einmal beim allerersten Mount geprueft (Zeile ~64). Ohne
                  // dieses setHasExistingPin(false) zeigt der Lock-Screen im
                  // selben Tab fuer immer weiter "PIN eingeben" an, obwohl
                  // SALT_KEY/MARKER_KEY/DEVICE_ID_KEY gar nicht mehr existieren -
                  // jeder weitere Versuch liefe zwangslaeufig sofort in
                  // 'wrong_pin' (erster Guard in _unlockEncryptionInner), ein
                  // stiller Sackgassen-Zustand, aus dem nur ein manueller
                  // Seiten-Reload wieder herausfuehrt.
                  setHasExistingPin(false);
                  return '🔴 Zu viele Fehlversuche - Daten unwiderruflich gelöscht.';
                case 'lost_state':
                  // Produktions-Realitaets-Review: NICHT dasselbe wie 'wiped'
                  // oben - kein einziger Entschluesselungsversuch wurde hier
                  // gegen diesen PIN gewertet, der Nutzer hat nichts falsch
                  // gemacht. Der Relay-Prozess (haelt Pepper nur im RAM) hat
                  // zwischenzeitlich neu gestartet und dieses Geraet
                  // "vergessen" - ohne den alten Pepper sind die lokalen Daten
                  // trotzdem gleichermassen unwiderruflich weg, deshalb auch
                  // hier RTCStore zuruecksetzen und hasExistingPin zuruecksetzen
                  // (siehe Kommentar im 'wiped'-Zweig oben - identischer
                  // Sackgassen-Bug traefe sonst auch hier zu).
                  RTCStore.resetAll();
                  setHasExistingPin(false);
                  return '🟡 Serververbindung wurde zurückgesetzt (z.B. Neustart) - deine lokal gespeicherten Daten können dadurch leider nicht mehr entschlüsselt werden. Kein falscher PIN, keine fremde Anmeldung - bitte richte den PIN-Schutz neu ein.';
                case 'offline':
                  return 'Relay nicht erreichbar - Entsperren braucht eine Verbindung.';
                case 'corrupted':
                  // Fix 3 (SECURITY_CHAOS_TESTING.md §10): lokale Daten (Salt/
                  // Marker) sind beschaedigt - das ist NICHT dasselbe wie ein
                  // falscher PIN (der PIN wurde nie tatsaechlich geprueft, kein
                  // Versuch wurde gegen den Wipe-Zaehler verbraucht) und auch
                  // nicht "gesperrt/gewiped" - eine ehrliche, eigene Meldung
                  // vermeidet, dass der Nutzer faelschlich denkt, sein PIN sei
                  // falsch oder er habe gerade einen Versuch verloren.
                  return 'Lokale Daten beschädigt - PIN kann nicht geprüft werden.';
                default:
                  return 'Falscher PIN';
              }
            }
            const savedUser = await getItem('username');
            const savedContacts = await getItem('contacts');
            if (savedUser) setUsername(savedUser);
            if (savedContacts) {
              // Ungeschuetztes JSON.parse hier liess einen Nutzer mit KORREKTEM
              // PIN bei beschaedigtem contacts-Eintrag mit einer ungefangenen
              // Exception haengen, statt (wie jede native Entsprechung) einfach
              // ohne Kontakte auf dem Home-Screen zu landen (Chaos-Testing-Fund).
              let loadedContacts: Contact[] = [];
              try {
                loadedContacts = JSON.parse(savedContacts);
              } catch {
                console.warn('[Storage] Kontaktliste beschaedigt - ohne Kontakte fortfahren');
              }
              setContacts(loadedContacts);
              // Shared Secrets aus der letzten Sitzung zurueck in RTCStore laden -
              // ohne das ist RTCStore.sharedSecrets nach jedem Tab-Neustart leer,
              // bis ein frischer P2P-Reconnect den Schluesseltausch wiederholt hat.
              // In der Zwischenzeit wuerde checkOfflinePackets() jede via Relay
              // wartende Nachricht abholen (der Server loescht sie beim Abholen),
              // aber mangels Secret nicht entschluesseln koennen und sie damit
              // unwiderruflich verwerfen - das genaue "Nachrichten verschwinden"-
              // Symptom, das gemeldet wurde.
              for (const c of loadedContacts) {
                const secret = await getItem('shared_secret_' + c.id);
                if (secret) RTCStore.sharedSecrets.set(c.id, secret);
                // Audit 2026-09-28: unbestaetigtes vorheriges Secret als
                // Rueckfall-Kandidat (siehe RTCStore.previousSecrets).
                const prev = await getItem('shared_secret_prev_' + c.id);
                if (prev) RTCStore.previousSecrets.set(c.id, prev);
              }
            }
            setScreen('home');
            return '';
          }}
        />
      )}
      {(screen === 'home' || screen === 'connect' || screen === 'chat' || screen === 'call') && (
        <div className="shell">
          <div className={`sidebar-pane${screen === 'home' ? ' active' : ''}`}>
            <HomeScreen
              username={username}
              contacts={contacts.filter((c) => !c.pendingDelete)}
              activeChatId={chat?.id ?? null}
              onChat={(c) => {
                setChat(c);
                setScreen('chat');
              }}
              onConnect={() => setScreen('connect')}
              onDelete={(ids) => ids.forEach(deleteContact)}
            />
          </div>
          <div className={`main-pane${screen !== 'home' ? ' active' : ''}`}>
            {screen === 'home' && <EmptyMainPane />}
            {screen === 'connect' && (
              <ConnectScreen
                onBack={() => setScreen('home')}
                onConnected={(contact, rtc) => {
                  RTCStore.setConnection(contact.id, rtc);
                  setContacts((c) => [...c, contact]);
                  // Ueber updateContacts serialisiert (Rot-Team-Review Fund 1,
                  // hier nachgezogen).
                  updateContacts((cs) => [...cs, contact]).catch(() => {});
                  setScreen('home');
                }}
              />
            )}
            {screen === 'chat' && chat && (
              <ChatScreen
                chat={chat}
                onBack={() => setScreen('home')}
                onCall={() => startOutgoingCall(chat)}
              />
            )}
            {screen === 'call' && chat && (
              <CallScreen chat={chat} callManager={callManagerRef.current} callState={callState} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Desktop-Split-View (WhatsApp-Web-artig, Nutzerwunsch): auf schmalen
// Bildschirmen (Handy) ist die Seitenleiste bei screen==='home' die einzige
// sichtbare Ansicht, das main-pane bleibt dann unbenutzt im DOM - dieser
// Platzhalter existiert nur fuer den Fall, dass beide Spalten gleichzeitig
// sichtbar sind (Desktop-Breite, siehe App.css) und noch kein Chat offen ist.
function EmptyMainPane() {
  return (
    <div className="screen center empty-main-pane">
      <img className="empty-logo" src="/brand/logo-d-centered.svg" width="120" height="120" alt="" />
      <h2 className="empty-title">Malachi Web</h2>
      <p className="muted">Wähle links einen Chat aus – oder verbinde dich mit einem neuen Kontakt.</p>
      <p className="empty-note">Ende-zu-Ende verschlüsselt · direkt von Gerät zu Gerät</p>
    </div>
  );
}

function SetupScreen({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="screen center dark auth-screen">
      <div className="auth-card">
      <img className="auth-logo" src="/brand/logo-d-centered.svg" width="72" height="72" alt="" />
      <h1 className="auth-title">Willkommen bei Malachi</h1>
      <p className="auth-sub">Wie sollen deine Kontakte dich sehen? Der Name bleibt auf deinem Gerät und wird nur verschlüsselt an Kontakte übertragen.</p>
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onDone(name.trim())} placeholder="Dein Name" maxLength={32} autoFocus />
      <button disabled={!name.trim()} onClick={() => onDone(name.trim())}>
        Weiter
      </button>
      <p className="auth-foot">Kein Konto · keine E-Mail · keine Telefonnummer nötig</p>
      </div>
    </div>
  );
}

function LockScreen({ hasPin, onUnlock }: { hasPin: boolean; onUnlock: (pin: string) => Promise<string> }) {
  const [pin, setPinInput] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Nur beim Ersteinrichten (kein hasPin) relevant - Gegenstueck zu App.tsx
  // LockScreen step 'setup'/'confirm': ohne diese zweite Eingabe wuerde ein
  // Vertipper beim einmaligen Festlegen den Nutzer stillschweigend mit einem
  // PIN zurücklassen, den er nie beabsichtigt hat (Plattform-Paritaets-Luecke,
  // vom Nutzer beim Web-Test bemerkt - native fragt seit jeher zweimal).
  const [confirmPin, setConfirmPin] = useState<string | null>(null);

  const submit = async () => {
    if (pin.length < 4 || busy) return;

    if (!hasPin && confirmPin === null) {
      setConfirmPin(pin);
      setPinInput('');
      setErr('PIN bestätigen');
      return;
    }

    if (!hasPin && confirmPin !== null) {
      if (pin !== confirmPin) {
        setErr('PINs stimmen nicht überein - von vorn');
        setPinInput('');
        setConfirmPin(null);
        setTimeout(() => setErr(''), 3000);
        return;
      }
    }

    setBusy(true);
    const errMsg = await onUnlock(pin);
    setBusy(false);
    if (errMsg) {
      setErr(errMsg);
      setPinInput('');
      setConfirmPin(null);
      setTimeout(() => setErr(''), 3000);
    }
  };

  const label = hasPin
    ? 'PIN eingeben'
    : confirmPin === null
      ? 'Neuen PIN festlegen (min. 4 Ziffern)'
      : 'PIN bestätigen';

  return (
    <div className="screen center auth-screen">
      <div className="auth-card">
      <img className="auth-logo" src="/brand/logo-d-centered.svg" width="72" height="72" alt="" />
      <h1 className="auth-title">{hasPin ? 'Willkommen zurück' : 'Deine Daten, dein PIN'}</h1>
      <p className="auth-sub">{label}</p>
      <input
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        autoFocus
        style={{ letterSpacing: '8px', textAlign: 'center', fontSize: '24px' }}
      />
      {err && <p className="error">{err}</p>}
      <button onClick={submit} disabled={busy}>
        {busy ? 'Prüfe…' : 'Entsperren'}
      </button>
      <p className="auth-foot">🔒 Alles bleibt verschlüsselt auf diesem Gerät</p>
      </div>
    </div>
  );
}

function HomeScreen({
  username,
  contacts,
  activeChatId,
  onChat,
  onConnect,
  onDelete,
}: {
  username: string;
  contacts: Contact[];
  activeChatId?: string | null;
  onChat: (c: Contact) => void;
  onConnect: () => void;
  onDelete: (ids: string[]) => void;
}) {
  // Letzte-Nachricht-Vorschau (Plattform-Paritaet zu App.tsx nativ, dessen
  // contact.last/`unread`-Felder bereits existierten, aber nie mit dem
  // tatsaechlichen Nachrichtentext aktualisiert wurden - hier auf Web gab es
  // bisher ueberhaupt keine Vorschau). Liest den zuletzt gespeicherten
  // Chatverlauf je Kontakt (siehe ChatScreen: 'chat_' + chat.id) statt eine
  // zweite Kopie des letzten Textes separat mitzufuehren - EIN Datenstand.
  // Kein Live-Push fuer Hintergrund-Chats (RTCStore.ts puffert eingehende
  // Nachrichten fuer nicht geoeffnete Chats bisher ohne jedes Signal nach
  // aussen - separates, groesseres Vorhaben), daher ein leichtes Poll-
  // Intervall, das zumindest jede bereits gespeicherte Aenderung zuverlaessig
  // nachzieht (z.B. nach dem Verlassen eines Chats, oder waehrend die
  // Seitenleiste im Desktop-Split-View neben einem offenen Chat sichtbar ist).
  const [previews, setPreviews] = useState<Record<string, { text: string; time: string }>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(contacts.map(async (c) => {
        const saved = await getItem('chat_' + c.id);
        if (!saved) return null;
        try {
          const msgs: Msg[] = JSON.parse(saved);
          const last = msgs[msgs.length - 1];
          return last ? [c.id, { text: last.text, time: last.time }] as const : null;
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      setPreviews(Object.fromEntries(entries.filter((e): e is [string, { text: string; time: string }] => !!e)));
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [contacts]);
  // Plattform-Paritaet: Loeschen fehlte im Web komplett (per Live-Test
  // bemerkt) - Gegenstueck zum Gedruckthalten-Menue in App.tsx (nativ), hier
  // per Klick auf ein "⋮"-Symbol je Zeile statt Long-Press (Maus-/Touch-
  // freundlicher fuer eine Web-Oberflaeche).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  const toggleSelected = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const confirmDeleteSelected = () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (confirm(ids.length === 1 ? 'Chat und alle Nachrichten unwiderruflich löschen?' : `${ids.length} Chats und alle Nachrichten unwiderruflich löschen?`)) {
      onDelete(ids);
      exitSelect();
    }
  };

  return (
    <div className="screen">
      <div className="header">
        {selectMode ? (
          <>
            <button onClick={exitSelect}>✕</button>
            <span>{selected.size} ausgewählt</span>
            <button onClick={confirmDeleteSelected} disabled={!selected.size} className={selected.size ? 'danger' : undefined}>
              🗑
            </button>
          </>
        ) : (
          <>
            <div className="home-brand">
              <img src="/brand/logo-d-centered.svg" width="38" height="38" alt="" />
              <div>
                <h2>Nachrichten</h2>
                <span className="sub">{username}</span>
              </div>
            </div>
            <button onClick={onConnect}>+ Verbinden</button>
          </>
        )}
      </div>
      <div className="contact-list">
        {contacts.length === 0 && (
          <div className="empty-contacts">
            <p className="empty-contacts-title">Noch keine Kontakte</p>
            <p className="muted">Tippe auf „+ Verbinden“, zeig deinem Gegenüber den QR-Code oder scanne seinen – fertig.</p>
          </div>
        )}
        {contacts.map((c) => (
          <div
            key={c.id}
            className={[
              c.wiped ? 'contact-row wiped' : 'contact-row',
              selected.has(c.id) ? 'selected' : '',
              c.id === activeChatId ? 'active' : '',
            ].join(' ').trim()}
            onClick={() => (selectMode ? toggleSelected(c.id) : onChat(c))}>
            {selectMode && <span className="select-check">{selected.has(c.id) ? '☑' : '☐'}</span>}
            <div className="avatar">{c.wiped ? '🪦' : c.name[0]?.toUpperCase()}</div>
            <div className="contact-row-main">
              <div className="contact-row-top">
                <span className="contact-row-name">{c.name}</span>
                {previews[c.id] && <span className="contact-row-time">{previews[c.id].time}</span>}
              </div>
              <span className="contact-row-preview">
                {c.wiped ? 'Gerät wurde zurückgesetzt' : previews[c.id]?.text || 'P2P verbunden'}
              </span>
            </div>
            {!selectMode && (
              <button
                className="row-menu-btn"
                onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}>
                ⋮
              </button>
            )}
            {menuFor === c.id && (
              <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { setSelectMode(true); setSelected(new Set([c.id])); setMenuFor(null); }}>
                  Auswählen
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setMenuFor(null);
                    if (confirm('Chat und alle Nachrichten unwiderruflich löschen?')) onDelete([c.id]);
                  }}>
                  Löschen
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {menuFor && <div className="row-menu-backdrop" onClick={() => setMenuFor(null)} />}
    </div>
  );
}

function ConnectScreen({
  onBack,
  onConnected,
}: {
  onBack: () => void;
  onConnected: (contact: Contact, rtc: WebRTCManager) => void;
}) {
  const [mode, setMode] = useState<'generate' | 'enter' | 'phone'>('generate');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [myCode, setMyCode] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'error'>('idle');
  const [errorReason, setErrorReason] = useState('');
  const [copied, setCopied] = useState(false);
  const connected = useRef(false);

  // Plattform-Paritaet: dieselbe Telefonnummer-Verbindungsfunktion wie im
  // nativen Client (App.tsx) - fehlte bisher komplett im Web (per Live-Test
  // bemerkt). Reine Web-Crypto/fetch-Logik, keine native-only API involviert,
  // daher 1:1 portierbar.
  const [phone, setPhone] = useState('');
  const [phoneOther, setPhoneOther] = useState('');
  const [phoneStatus, setPhoneStatus] = useState<'idle' | 'searching' | 'found' | 'error' | 'claimed'>('idle');
  const phoneHashRef = useRef<string | null>(null);
  const phonePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Der kurze QR/Code-Token ist bewusst nur 8 Hex-Zeichen (32 Bit) fuers Auge/
  // Vorlesen kurz gehalten - er ist dem Relay ohnehin bekannt (reine Routing-
  // ID) und schuetzt fuer sich genommen nichts. Als dauerhafte lokale Kontakt-
  // ID (Schluessel fuer Shared Secrets, Reconnect-Routing etc.) ist er aber zu
  // kollisionsanfaellig. Die tatsaechlich gespeicherte Kontakt-ID wird deshalb
  // aus Token + PSK abgeleitet (SHA-256) - das PSK kennen nur die beiden
  // pairenden Geraete, nie der Relay, also ist das Ergebnis voll-entropisch
  // UND fuer Dritte nicht vorhersagbar (Sicherheitsreview 3, mirrors App.tsx).
  const deriveContactId = async (token: string, pskHex: string) => {
    const bytes = new TextEncoder().encode('malachi_2026_pairing_' + token + '|' + pskHex);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'c_' + hex.slice(0, 32);
  };

  const sha256Hex = async (input: string) => {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Rendezvous-Hash - siehe hashPhone() in App.tsx fuer die volle Begruendung
  // (sortierte Kombination beider Nummern, gleicher Hash auf beiden Seiten).
  const hashPhone = async (myNumber: string, otherNumber: string) => {
    const cleanMy = myNumber.replace(/\s/g, '').replace(/[^+0-9]/g, '');
    const cleanOther = otherNumber.replace(/\s/g, '').replace(/[^+0-9]/g, '');
    const sorted = [cleanMy, cleanOther].sort().join('_');
    return sha256Hex('malachi_2026_phone_' + sorted);
  };

  // Eigenes Geheimnis fuers Verschluesseln des Offers/Answers - siehe
  // derivePhonePSK() in App.tsx fuer die volle Begruendung (andere Domain-
  // Separation als der Rendezvous-Hash, sonst waere die Verschluesselung
  // wertlos gegen einen Relay-Betreiber, der den Hash ohnehin sieht).
  const derivePhonePSK = async (myNumber: string, otherNumber: string) => {
    const cleanMy = myNumber.replace(/\s/g, '').replace(/[^+0-9]/g, '');
    const cleanOther = otherNumber.replace(/\s/g, '').replace(/[^+0-9]/g, '');
    const sorted = [cleanMy, cleanOther].sort().join('_');
    const hex = await sha256Hex('malachi_2026_phone_psk_' + sorted);
    const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
    return btoa(String.fromCharCode(...bytes));
  };

  const initiatePhoneConnect = async (hash: string, myId: string, psk: string) => {
    const contact: Contact = { id: myId, name: 'Neuer Kontakt', role: 'initiator' };
    const { RELAY_URL } = await import('./lib/RelayClient');
    const rtcPhone = new WebRTCManager(
      () => {},
      () => {
        if (!connected.current) {
          connected.current = true;
          rtcPhone.chatId = myId;
          RTCStore.setConnection(myId, rtcPhone);
          onConnected(contact, rtcPhone);
        }
      },
      () => {},
    );
    rtcPhone.chatId = myId;
    const offerJSON = await rtcPhone.createOffer();
    const encryptedOffer = await encryptMsg(offerJSON, psk);
    if (!encryptedOffer) { console.error('[Phone] Verschlüsselung des Offers fehlgeschlagen'); return; }
    await fetch(`${RELAY_URL}/packet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: JSON.stringify({ type: 'phone_connect_offer', offer: encryptedOffer, chatId: myId }),
        recipient: hash,
      }),
    });
    const pollAnswer = setInterval(async () => {
      try {
        const res = await fetch(`${RELAY_URL}/packet/${myId}_answer`);
        const data = await res.json();
        const answerPacket = data.packets?.find((p: any) => {
          try { return JSON.parse(p.payload).type === 'phone_connect_answer'; } catch { return false; }
        });
        if (answerPacket) {
          const msg = JSON.parse(answerPacket.payload);
          const decryptedAnswer = decryptMsg(msg.answer, psk);
          if (!decryptedAnswer) return; // Entschluesselung fehlgeschlagen - moeglicher Angriff, weiter warten
          clearInterval(pollAnswer);
          await rtcPhone.handleAnswer(decryptedAnswer);
        }
      } catch { /* naechster Poll versucht's erneut */ }
    }, 2000);
    setTimeout(() => clearInterval(pollAnswer), 60000);
  };

  const startPhoneConnect = async () => {
    if (!phone || phone.length < 6 || !phoneOther || phoneOther.length < 6) return;
    setPhoneStatus('searching');
    // Reset bei jedem neuen Versuch - siehe Kommentar bei handleConnect().
    connected.current = false;
    try {
      const { RELAY_URL } = await import('./lib/RelayClient');
      const hash = await hashPhone(phone, phoneOther);
      const psk = await derivePhonePSK(phone, phoneOther);
      phoneHashRef.current = hash;
      const myIdBytes = crypto.getRandomValues(new Uint8Array(12));
      const myId = 'c_' + Array.from(myIdBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

      const regRes = await fetch(`${RELAY_URL}/phone/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, chatId: myId }),
      });
      const regData = await regRes.json();

      if (regData.role === 'already_claimed') {
        setPhoneStatus('claimed');
        return;
      }
      if (regData.matched && regData.role === 'initiator') {
        setPhoneStatus('found');
        await initiatePhoneConnect(hash, myId, psk);
      } else {
        phonePollRef.current = setInterval(async () => {
          try {
            const offerRes = await fetch(`${RELAY_URL}/packet/${hash}`);
            const offerData = await offerRes.json();
            const offerPacket = offerData.packets?.find((p: any) => {
              try { return JSON.parse(p.payload).type === 'phone_connect_offer'; } catch { return false; }
            });
            if (offerPacket) {
              const msg = JSON.parse(offerPacket.payload);
              const decryptedOfferJSON = decryptMsg(msg.offer, psk);
              if (!decryptedOfferJSON) return;
              clearInterval(phonePollRef.current!);
              setPhoneStatus('found');
              const rtcResp = new WebRTCManager(
                () => {},
                () => {
                  rtcResp.chatId = msg.chatId;
                  RTCStore.setConnection(msg.chatId, rtcResp);
                  const newContact: Contact = { id: msg.chatId, name: 'Neuer Kontakt', role: 'responder' };
                  onConnected(newContact, rtcResp);
                },
                () => {},
              );
              rtcResp.chatId = msg.chatId;
              const answer = await rtcResp.createAnswerDirect(decryptedOfferJSON);
              const encryptedAnswer = await encryptMsg(answer, psk);
              if (!encryptedAnswer) return;
              await fetch(`${RELAY_URL}/packet`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  payload: JSON.stringify({ type: 'phone_connect_answer', answer: encryptedAnswer }),
                  recipient: msg.chatId + '_answer',
                }),
              });
            }
          } catch (e) { console.error('[Phone] Poll Fehler:', e); }
        }, 2000);
        setTimeout(() => {
          setPhoneStatus((s) => {
            if (s === 'searching') {
              if (phonePollRef.current) clearInterval(phonePollRef.current);
              fetch(`${RELAY_URL}/phone/${hash}`, { method: 'DELETE' }).catch(() => {});
              return 'idle';
            }
            return s;
          });
        }, 5 * 60 * 1000);
      }
    } catch (e) {
      console.error('[Phone] Fehler:', e);
      setPhoneStatus('error');
    }
  };

  useEffect(() => {
    return () => {
      if (phonePollRef.current) clearInterval(phonePollRef.current);
      if (phoneHashRef.current) {
        import('./lib/RelayClient').then(({ RELAY_URL }) => {
          fetch(`${RELAY_URL}/phone/${phoneHashRef.current}`, { method: 'DELETE' }).catch(() => {});
        });
      }
    };
  }, []);

  // Aus der IIFE herausgeloest, damit die useEffect-Cleanup-Funktion unten
  // den Poll-Interval erreichen kann - vorher lief er beim Verlassen des
  // Screens (Navigation, aber vor allem jeder Vite-HMR-Reload waehrend der
  // Entwicklung) einfach 30 Minuten lang im Hintergrund weiter, alle 2s ein
  // Request gegen /signal/answer/<laengst verwaistes Token>. Bei vielen
  // Reloads in derselben Browser-Sitzung (wie in einer laengeren Debug-
  // Sitzung) summierten sich diese "Zombie"-Polls zu genug 404-Anfragen, um
  // die IP-Sperre des Relays selbst auszuloesen - ein selbst verursachter
  // Deny-of-Service, der neue, echte Verbindungsversuche vom selben Rechner
  // blockierte. Per Live-Test entdeckt (mehrfach reproduziert).
  const generatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    (async () => {
      // Routing-Token (dem Relay bekannt, oeffentlich) und Pairing-Geheimnis
      // (PSK, nie an den Relay gesendet) sind zwei unabhaengige Zufallswerte -
      // der eigentliche Kyber-Schluesselaustausch fuer den Shared Secret
      // passiert separat, sobald der DataChannel oeffnet (WebRTCManager).
      const tokenHex = randomHex(4).toUpperCase();
      const psk = crypto.getRandomValues(new Uint8Array(16));
      const pskHex = Array.from(psk)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const pskB64 = btoa(String.fromCharCode(...psk));

      const code = `SC1-${tokenHex.slice(0, 4)}-${tokenHex.slice(4, 8)}`;
      setMyCode(`${code}.${pskHex}`);
      const deepLink = `malachi://connect/${tokenHex}.${pskHex}`;
      QRCode.toDataURL(deepLink, { width: 240 }).then(setQrDataUrl);

      // Kontakt-ID VORAB ableiten und rtc.chatId sofort setzen, bevor
      // ueberhaupt ein Offer/ICE/DataChannel existiert - kein Zeitfenster
      // mehr, in dem der Kyber-Schluesselaustausch auf dem DataChannel
      // schneller waere als diese Zuweisung (siehe ausfuehrlicher Kommentar
      // bei handleConnect(), identischer Bug - hier zur Konsistenz ebenfalls
      // behoben statt sich auf reine Geschwindigkeit zu verlassen).
      const contactId = await deriveContactId(tokenHex, pskHex);
      // War vorher der eigentliche Bug (Live-Test entdeckt): alle drei
      // WebRTCManager-Callbacks waren No-Ops, onConnected(contact, rtc) wurde
      // stattdessen direkt nach dem Empfang der SIGNALISIERUNGS-Antwort
      // (handleAnswer) manuell ausgeloest - das beweist nur, dass die
      // Gegenseite geantwortet hat, nicht dass ICE/DTLS tatsaechlich
      // verbunden sind. Web zeigte dadurch sofort einen "verbundenen" Chat
      // an, auch wenn ICE danach an TURN/NAT scheiterte - kein echter
      // Chatpartner online. Jetzt wie handleConnect() (Code-eingeben-Seite)
      // ueber den echten onConnected-Callback (2. Argument, feuert erst bei
      // iceConnectionState 'connected'/'completed').
      const rtc = new WebRTCManager(
        () => {},
        () => {
          if (!connected.current) {
            connected.current = true;
            const contact: Contact = { id: contactId, name: 'Neuer Kontakt', role: 'initiator' };
            onConnected(contact, rtc);
          }
        },
        () => {},
      );
      rtc.chatId = contactId;
      const offerJSON = await rtc.createOffer();
      const encOffer = await encryptMsg(offerJSON, pskB64);
      const { sendSignalOffer } = await import('./lib/RelayClient');
      await sendSignalOffer(encOffer!, tokenHex);

      const poll = setInterval(async () => {
        const { RELAY_URL } = await import('./lib/RelayClient');
        try {
          const res = await fetch(`${RELAY_URL}/signal/answer/${tokenHex}`);
          const data = await res.json();
          if (data.answer) {
            clearInterval(poll);
            const decAnswer = decryptMsg(data.answer, pskB64);
            if (!decAnswer) return;
            await rtc.handleAnswer(decAnswer);
          }
        } catch {
          /* naechster Poll versucht's erneut */
        }
      }, 2000);
      generatePollRef.current = poll;
      setTimeout(() => clearInterval(poll), 30 * 60 * 1000);
    })();
    return () => {
      if (generatePollRef.current) clearInterval(generatePollRef.current);
    };
  }, []);

  const handleConnect = async () => {
    if (!input.trim()) return;
    setStatus('connecting');
    setErrorReason('');
    // Reset bei jedem neuen Versuch - sonst blockiert ein frueherer
    // Verbindungsversuch (der z.B. kurz 'connected' erreichte, dann aber an
    // ICE-Instabilitaet scheiterte) diesen Guard dauerhaft fuer den Rest der
    // ConnectScreen-Sitzung. Ein SPAETERER, tatsaechlich erfolgreicher Retry
    // wuerde dann durch das `if (!connected.current)` unten leise
    // verschluckt - die Verbindung steht (DataChannel offen), aber der neue
    // Chat wird nie angelegt/geoeffnet (per Live-Test entdeckt, gleicher Bug
    // wie in App.tsx nativ).
    connected.current = false;
    try {
      // Robuste Extraktion statt striktem Prefix-Abschneiden: manche QR-Scanner
      // (Systemkamera statt einer eigenen In-App-Kamera, die es hier nicht
      // gibt - der native/Web-Client verlaesst sich auf OS-Deep-Links bzw.
      // Copy-Paste) geben den erkannten "malachi://connect/"-Link anders
      // formatiert wieder (z.B. mit Leerzeichen statt "://" und "/", je nach
      // Scanner-App). Das reine .replace('malachi://connect/', '') traf dann
      // nicht, der Rest-Prefix landete im Token und die Verbindung schlug
      // mit falschem Token statt einer verstaendlichen Fehlermeldung fehl -
      // per Live-Test entdeckt. Ein Regex-Suchmuster fuer Code.PSK irgendwo
      // im eingefuegten Text ist unabhaengig vom genauen Prefix-Wortlaut.
      const match = input.match(/([0-9A-F]{4}-?[0-9A-F]{4})\.([0-9A-F]{32})/i);
      const codePart = match ? match[1] : '';
      const pskHex = match ? match[2].toUpperCase() : null;
      const token = codePart.replace(/-/g, '').toUpperCase().slice(0, 8);
      if (!pskHex) {
        setErrorReason('Kein gültiger Code erkannt. Bitte den kompletten Code (inkl. Punkt-Teil) oder QR-Link einfügen.');
        setStatus('error');
        return;
      }
      const pskBytes = pskHex.match(/../g)!.map((h) => parseInt(h, 16));
      const pskB64 = btoa(String.fromCharCode(...pskBytes));

      const { RELAY_URL, sendSignalAnswer } = await import('./lib/RelayClient');
      const offerRes = await fetch(`${RELAY_URL}/signal/offer/${token}`);
      const offerData = await offerRes.json();
      const encOffer = offerData.offer || null;
      if (!encOffer) {
        setErrorReason('Kein Angebot für diesen Code gefunden. Ist der Code richtig, und hat dein Kontakt den Einladungs-Bildschirm noch offen?');
        setStatus('error');
        return;
      }
      const offerJSON = decryptMsg(encOffer, pskB64);
      if (!offerJSON) {
        setErrorReason('Entschlüsselung fehlgeschlagen - vermutlich ein Tippfehler im Code (meist im PSK-Teil nach dem Punkt).');
        setStatus('error');
        return;
      }

      // Kontakt-ID VORAB ableiten und rtc.chatId sofort, synchron setzen - sonst
      // setzt RTCStore.setConnection() (im onConnected-Callback der Eltern-App,
      // erst NACH dieser async .then()-Kette) chatId zu spaet: der Kyber-
      // Schluesselaustausch auf dem DataChannel kann schneller fertig sein,
      // liest dann this.chatId als undefined, das Shared Secret landet nie
      // unter der richtigen ID - Senden schlaegt fuer immer fehl, Profil-
      // Handshake (Name/Avatar) ebenso. Per Live-Test entdeckt, siehe
      // ausfuehrlicher Kommentar in App.tsx (nativ), identischer Bug.
      const contactId = await deriveContactId(token, pskHex);
      const rtc = new WebRTCManager(
        () => {},
        () => {
          if (!connected.current) {
            connected.current = true;
            const contact: Contact = { id: contactId, name: 'Neuer Kontakt', role: 'responder' };
            onConnected(contact, rtc);
          }
        },
        () => setStatus('idle'),
      );
      rtc.chatId = contactId;
      const answerJSON = await rtc.createAnswer(offerJSON);
      const encAnswer = await encryptMsg(answerJSON, pskB64);
      await sendSignalAnswer(encAnswer!, token);
    } catch (e) {
      console.error(e);
      setErrorReason('Netzwerkfehler beim Verbinden. Relay erreichbar? Erneut versuchen.');
      setStatus('error');
    }
  };

  return (
    <div className="screen">
      <div className="header">
        <button onClick={onBack}>← Zurück</button>
        <h2>Verbinden</h2>
      </div>
      <div className="tabs">
        <button className={mode === 'generate' ? 'active' : ''} onClick={() => setMode('generate')}>
          Code erzeugen
        </button>
        <button className={mode === 'enter' ? 'active' : ''} onClick={() => setMode('enter')}>
          Code eingeben
        </button>
        <button className={mode === 'phone' ? 'active' : ''} onClick={() => setMode('phone')}>
          Nummer
        </button>
      </div>
      {mode === 'phone' ? (
        <div className="center">
          <p className="muted">
            Verbinde dich mit jemandem über seine Telefonnummer. Die Nummer wird niemals an den Server übertragen - nur ein verschlüsselter Hash.
          </p>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Meine Nummer: +49 176 12345678"
          />
          <input
            type="tel"
            value={phoneOther}
            onChange={(e) => setPhoneOther(e.target.value)}
            placeholder="Nummer des Kontakts: +49 176 87654321"
          />
          {phoneStatus === 'idle' && (
            <button onClick={startPhoneConnect}>Suchen &amp; Verbinden</button>
          )}
          {phoneStatus === 'searching' && (
            <div className="center">
              <p className="muted">🔍 Suche läuft... Warte bis der andere Malachi öffnet</p>
              <button
                onClick={() => {
                  if (phonePollRef.current) clearInterval(phonePollRef.current);
                  if (phoneHashRef.current) {
                    import('./lib/RelayClient').then(({ RELAY_URL }) => {
                      fetch(`${RELAY_URL}/phone/${phoneHashRef.current}`, { method: 'DELETE' }).catch(() => {});
                    });
                  }
                  setPhoneStatus('idle');
                }}>
                Abbrechen
              </button>
            </div>
          )}
          {phoneStatus === 'found' && <p className="success">✅ Verbunden!</p>}
          {phoneStatus === 'error' && <p className="error">Verbindung fehlgeschlagen. Nochmal versuchen.</p>}
          {phoneStatus === 'claimed' && <p className="error">Dieser Kontakt-Code wurde bereits von einem anderen Gerät verwendet.</p>}
          <CollapsibleNotice teaser="🔒 Datensparsam, nicht „Zero-Knowledge“ - Details">
            Statt deiner Nummer wird nur ein SHA-256 Hash daraus kurzzeitig gespeichert, sofort nach dem Verbinden gelöscht. Das ist ein Wiedererkennungsmerkmal, kein Geheimnis – es schützt vor Mitlesern, die deine Nummer nicht kennen, aber nicht vor jemandem, der bereits beide Telefonnummern kennt und denselben Hash selbst berechnen kann.
          </CollapsibleNotice>
        </div>
      ) : mode === 'generate' ? (
        <div className="center">
          {qrDataUrl && <img src={qrDataUrl} alt="QR" width={240} height={240} />}
          <p className="code-display">{myCode}</p>
          <button
            onClick={() => {
              // Direkter Klartext-Code statt QR-Scan-Umweg: ein Scan mit der
              // Systemkamera (kein eigener In-App-Scanner vorhanden) gibt den
              // erkannten "malachi://connect/"-Link je nach Scanner-App anders
              // formatiert wieder, was Copy-Paste unzuverlaessig macht - per
              // Live-Test entdeckt. Der reine Code hier ist exakt das, was
              // handleConnect() erwartet, ganz ohne Scan-Umweg.
              navigator.clipboard?.writeText(myCode).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }).catch(() => {});
            }}>
            {copied ? 'Kopiert ✓' : 'Code kopieren'}
          </button>
          <p className="muted">QR-Code scannen oder Code an den Kontakt geben (komplett, inkl. Punkt-Teil).</p>
        </div>
      ) : (
        <div className="center">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="SC1-XXXX-XXXX.pskhex… oder malachi://connect/…"
            rows={3}
          />
          <button onClick={handleConnect}>Verbinden</button>
          {status === 'error' && <p className="error">{errorReason || 'Verbindung fehlgeschlagen. Code prüfen.'}</p>}
          {status === 'connecting' && <p className="muted">Verbinde…</p>}
        </div>
      )}
    </div>
  );
}

function ChatScreen({ chat, onBack, onCall }: { chat: Contact; onBack: () => void; onCall: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [safetyCode, setSafetyCode] = useState<string | null>(null);
  const [safetyVisible, setSafetyVisible] = useState(false);
  const [safetyChanged, setSafetyChanged] = useState(false);

  // Sicherheitscode aus der laufenden WebRTC-Verbindung uebernehmen, sobald
  // der Kyber-Schluesselaustausch ihn berechnet hat. Ohne das gab es auf Web
  // (anders als nativ, siehe App.tsx) ueberhaupt keine Moeglichkeit, den Code
  // zu vergleichen und einen aktiven MITM auf den Schluesselaustausch zu
  // erkennen (Sicherheitsreview 3).
  //
  // Der Code aendert sich legitim bei jedem Reconnect (frischer Kyber-
  // Austausch, Forward Secrecy) - das war bisher unsichtbar fuer den Nutzer,
  // wodurch der Vergleich faktisch wirkungslos war (Sicherheitsaudit): siehe
  // Kommentar in App.tsx fuer dieselbe Begruendung/Loesung.
  useEffect(() => {
    setSafetyCode(null);
    setSafetyChanged(false);
    const check = setInterval(async () => {
      const rtc = RTCStore.getConnection(chat.id);
      if (rtc?.safetyCode) {
        const seenKey = 'safety_code_seen_' + chat.id;
        const lastSeen = await getItem(seenKey);
        setSafetyCode(rtc.safetyCode);
        if (lastSeen && lastSeen !== rtc.safetyCode) {
          setSafetyChanged(true);
        } else if (!lastSeen) {
          await setItem(seenKey, rtc.safetyCode).catch(() => {});
        }
        clearInterval(check);
      }
    }, 1000);
    return () => clearInterval(check);
  }, [chat.id]);

  // Chatverlauf laden (verschluesselt in localStorage, wie Kontakte). Vorher
  // gab es das gar nicht - jede Nachricht existierte nur im Arbeitsspeicher
  // der aktuell offenen Seite und war nach Neuladen/Verbindungsabbruch weg.
  useEffect(() => {
    setLoaded(false);
    (async () => {
      const saved = await getItem('chat_' + chat.id);
      setMsgs(saved ? JSON.parse(saved) : []);
      setLoaded(true);
    })();
  }, [chat.id]);

  // Nicht speichern, bevor das Laden fertig ist - sonst ueberschreiben wir
  // die gerade erst geladene Historie kurzzeitig mit einem leeren Array.
  useEffect(() => {
    if (!loaded) return;
    setItem('chat_' + chat.id, JSON.stringify(msgs)).catch(() => {});
  }, [msgs, loaded, chat.id]);

  const appendIncoming = (msgId: string, text: string) => {
    setMsgs((m) => (m.some((x) => x.id === msgId) ? m : [...m, { id: msgId, text, mine: false, time: nowTime() }]));
  };

  useEffect(() => {
    RTCStore.setMessageListener(chat.id, (msg: any) => {
      if (msg.type === 'text') appendIncoming(msg.msgId || String(Date.now()), msg.text);
    });
    const buffered = RTCStore.getBuffered(chat.id);
    for (const msg of buffered) {
      if (msg.type === 'text') appendIncoming(msg.msgId || String(Date.now()), msg.text);
    }
    return () => RTCStore.setMessageListener(chat.id, null);
  }, [chat.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  // Wie native App.tsx's send(): ueber WebRTC mit Retries versuchen (gibt
  // Reconnect-Logik Zeit, eine frisch abgebrochene Verbindung wiederherzu-
  // stellen), und erst wenn das nach 30s nicht klappt (z.B. Kontakt gerade
  // offline) verschluesselt ueber den Relay zustellen - vorher gab Web nach
  // einem einzigen Fehlversuch sofort auf, ohne diesen Fallback.
  const send = () => {
    if (!text.trim()) return;
    const msgText = text.trim();
    const msgId = String(Date.now());
    setText('');
    setMsgs((m) => [...m, { id: msgId, text: msgText, mine: true, time: nowTime(), status: 'sending' }]);

    const updateStatus = (status: 'sending' | 'sent' | 'failed') => {
      setMsgs((m) => m.map((x) => (x.id === msgId ? { ...x, status } : x)));
    };
    // ts eingebettet fuer die Frische-Pruefung beim Empfang ueber den Relay-
    // Fallback (checkOfflinePackets) - ohne das waere jede ueber /packet
    // zugestellte Nachricht fuer einen boesartigen Relay beliebig oft erneut
    // einspielbar gewesen (Sicherheitsreview 3, mirrors App.tsx).
    // time zusaetzlich eingebettet (Review-Fund 2026-09-27, "P1"): der LIVE
    // DataChannel-Pfad prueft original.time (WebRTCManager.ts, mirrors
    // WebRTCManager.js nativ), nicht original.ts - ohne dieses Feld verwarf
    // JEDE ueber den Web-Client live gesendete Textnachricht die Frische-
    // Pruefung beim Empfaenger als moeglichen Replay und kam nie an, obwohl
    // der Web-Absender faelschlich "gesendet" anzeigte.
    const payload = JSON.stringify({ type: 'text', text: msgText, msgId, ts: Date.now(), time: Date.now() });

    const trySend = (attempts: number) => {
      // 'sent' = wirklich an einen offenen DataChannel uebergeben; 'queued' =
      // nur im nicht-dauerhaften pendingMsgs-Array (State-Machine-Review
      // Fund 7, siehe WebRTCManager.ts) - vorher beides "true", faelschlich
      // als "gesendet" angezeigt.
      const result = RTCStore.sendMessage(chat.id, payload);
      if (result === 'sent') {
        updateStatus('sent');
      } else if (result === 'queued') {
        updateStatus('sending');
      } else if (attempts > 0 && RTCStore.isConnected(chat.id)) {
        // Siehe identische Begruendung in App.tsx nativ - nur weiter
        // retryen, wenn die Verbindung noch grundsaetzlich als aktiv gilt.
        setTimeout(() => trySend(attempts - 1), 3000);
      } else {
        // Nachrichteninhalte duerfen nie mehr ueber den Relay-Server laufen
        // (siehe identische Begruendung in App.tsx nativ, trySend() - Fund
        // 1a im ZERO_KNOWLEDGE_RELAY_PLAN.md: Web schickte den Text-Fallback
        // bisher weiterhin verschluesselt per POST /packet). Jetzt
        // ausschliesslich lokale Warteschlange (Queue.ts), Zustellung erst
        // bei der naechsten echten P2P-Verbindung (rtc._onKeyExchange).
        (async () => {
          const secret = RTCStore.getSharedSecret(chat.id);
          if (!secret) {
            updateStatus('failed');
            return;
          }
          const { queueOffline } = await import('./lib/Queue');
          const ok = await queueOffline(chat.id, 'text', JSON.parse(payload), secret, msgId);
          updateStatus(ok ? 'sending' : 'failed');
        })();
      }
    };
    trySend(10);
  };

  return (
    <div className="screen chat-screen">
      {safetyVisible && (
        <div className="safety-overlay" onClick={() => setSafetyVisible(false)}>
          <div className="safety-card" onClick={(e) => e.stopPropagation()}>
            <h3>🛡 Sicherheitscode</h3>
            {safetyChanged && (
              <p className="safety-changed-warning">
                ⚠️ Dieser Code hat sich seit dem letzten Mal geändert (z.B. durch eine neue Verbindung). Bitte erneut mit deinem Kontakt vergleichen.
              </p>
            )}
            <p>Vergleiche diesen Code mit deinem Kontakt per Telefon. Stimmt er überein, ist die Verbindung sicher.</p>
            <div className="safety-code">{safetyCode || 'Wird berechnet…'}</div>
            <button
              onClick={() => {
                setSafetyVisible(false);
                setSafetyChanged(false);
                if (safetyCode) setItem('safety_code_seen_' + chat.id, safetyCode).catch(() => {});
              }}
            >
              Schließen
            </button>
          </div>
        </div>
      )}
      <div className="header">
        <button onClick={onBack}>← Zurück</button>
        <div className="header-title">
          <h2>{chat.name}</h2>
          <button
            onClick={() => setSafetyVisible(true)}
            title="Sicherheitscode"
            className={`shield-icon-btn${safetyChanged ? ' safety-badge' : ''}`}
          >
            🛡
          </button>
        </div>
        <button onClick={onCall}>📞</button>
      </div>
      <div className="messages" ref={listRef}>
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.mine ? 'mine' : 'theirs'}`}>
            <span>{m.text}</span>
            <span className="time">
              {m.time}
              {m.status === 'sending' ? ' · …' : m.status === 'failed' ? ' · ⚠' : ''}
            </span>
          </div>
        ))}
      </div>
      {chat.wiped ? (
        <div className="input-row wiped-notice">
          <span>🪦 Dieses Gerät wurde zurückgesetzt - keine Nachrichten mehr möglich.</span>
        </div>
      ) : (
        <div className="input-row">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Nachricht…"
          />
          <button onClick={send}>Senden</button>
        </div>
      )}
    </div>
  );
}

function CallScreen({
  chat,
  callManager,
  callState,
}: {
  chat: Contact;
  callManager: CallManager | null;
  callState: CallStateT;
}) {
  const [secs, setSecs] = useState(0);
  const [micOn, setMicOn] = useState(true);

  useEffect(() => {
    if (callState !== CallState.ACTIVE) {
      setSecs(0);
      return;
    }
    const t = setInterval(() => setSecs(callManager?.getDuration() || 0), 1000);
    return () => clearInterval(t);
  }, [callState, callManager]);

  const fmt = (s: number) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  const statusMap: Record<CallStateT, string> = {
    [CallState.IDLE]: '',
    [CallState.OUTGOING_RINGING]: 'Rufe an…',
    [CallState.INCOMING_RINGING]: 'Eingehender Anruf…',
    [CallState.CONNECTING]: 'Verbinde…',
    [CallState.ACTIVE]: fmt(secs),
    [CallState.ENDED]: 'Anruf beendet',
  };
  const statusText = statusMap[callState] || '';

  const isIncoming = callState === CallState.INCOMING_RINGING;

  return (
    <div className="screen center call-screen">
      <div className="avatar big">{chat.name[0]?.toUpperCase()}</div>
      <h2>{chat.name}</h2>
      <p className="muted">Verschlüsselt · P2P · WebRTC</p>
      <p className="call-status">{statusText}</p>

      {isIncoming ? (
        <div className="call-controls">
          <button className="danger" aria-label="Ablehnen" onClick={() => callManager?.rejectCall()}>
            ✖
          </button>
          <button className="success" aria-label="Annehmen" onClick={() => callManager?.acceptCall()}>
            📞
          </button>
        </div>
      ) : (
        <div className="call-controls">
          <button
            aria-label={micOn ? 'Mikrofon stummschalten' : 'Mikrofon aktivieren'}
            onClick={() => {
              setMicOn(!micOn);
              callManager?.toggleMute(micOn);
            }}
          >
            {micOn ? '🎤' : '🔇'}
          </button>
          <button className="danger" aria-label="Auflegen" onClick={() => callManager?.endCall('user_hangup')}>
            ✖
          </button>
        </div>
      )}
    </div>
  );
}

function nowTime(): string {
  return new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
