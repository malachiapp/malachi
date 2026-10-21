// Malachi Web - WebRTCManager.ts
// Portiert aus WebRTCManager.js. RTCPeerConnection/RTCSessionDescription sind
// im Browser globale APIs (kein Import noetig - genau das, worauf
// react-native-webrtc's eigene API sich bewusst ausrichtet, daher bleibt die
// Logik hier fast 1:1 identisch zur nativen App).
// (TURN-Zugangsdaten werden seit der Umstellung auf reines P2P nicht mehr abgerufen.)
import { generateKyberKeypair, kyberEncapsulate, kyberDecapsulate } from './HybridCrypto';
import { encryptMsg, decryptMsg } from './MessageCrypto';
import RTCStore from './RTCStore';
import { setItem, removeItem } from './Storage';

// Siehe identische Begruendung/Aenderung in WebRTCManager.js (nativ).
const COVER_INTERVAL_MS = 2000;
const PAD_BLOCK_SIZE = 512;

// Siehe Kommentar bei ICE_CHECKING_TIMEOUT_MS in der nativen WebRTCManager.js.
const ICE_CHECKING_TIMEOUT_MS = 20000;

export function padToBlock(obj: any, blockSize = PAD_BLOCK_SIZE): string {
  const base = JSON.stringify({ ...obj, p: '' });
  const baseLen = new TextEncoder().encode(base).length;
  const target = Math.ceil((baseLen + 1) / blockSize) * blockSize;
  const padLen = target - baseLen;
  return JSON.stringify({ ...obj, p: 'A'.repeat(padLen) });
}

// Zeitstempel-Frische-Pruefung, identisch zur nativen WebRTCManager.js
// (siehe dortiger Kommentar) - nur fuer 'text'-Nachrichten auf dem LIVEN
// DataChannel-Pfad, der bisher als einziger Pfad keine Replay-Pruefung hatte
// (Sicherheitsaudit).
function isFreshTimestamp(ts: number): boolean {
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  if (age > 15 * 60 * 1000) return false;
  if (age < -5 * 60 * 1000) return false;
  return true;
}

// LAN-IP statt Domain: Port 3478 ist nie ueber die FritzBox nach aussen
// weitergeleitet worden (anders als der Relay-Port 3333) - die Domain wuerde
// Produktions-Fund (Cross-Network-Diagnose) - siehe native WebRTCManager.js
// fuer die ausfuehrliche Begruendung: eine private LAN-IP war fuer jeden
// Client ausserhalb des Heimnetzes unerreichbar, ICE blieb bei (damals)
// erzwungenem Relay-only (FORCE_RELAY_ONLY) ohne jede Fehlermeldung fuer
// immer bei "checking" haengen. coturn laeuft bereits auf demselben Host
// wie der Relay (siehe coturn-setup.sh) - jetzt dieselbe Domain.
// Adresse zentral in AppConfig.ts (Umzug auf neuen Server = eine Zeile).
import { STUN_URL } from './AppConfig';

// Nur direktes P2P (Produktentscheidung 2026-09-29) - siehe ausfuehrliche
// Begruendung in WebRTCManager.js (nativ): keine TURN-Server mehr, Inhalte
// gehen ausschliesslich direkt Geraet <-> Geraet; STUN liefert nur die eigene
// oeffentliche Adresse, ueber ihn fliessen keine Daten.
const FORCE_RELAY_ONLY = false;

async function pcConfig(): Promise<RTCConfiguration> {
  return { iceServers: [{ urls: STUN_URL }], iceTransportPolicy: 'all' };
}
export const pcConfigForCalls = pcConfig;

export class WebRTCManager {
  pc: RTCPeerConnection | null = null;
  dataChannel: RTCDataChannel | null = null;
  onMessage: ((msg: any) => void) | null;
  onConnected: (() => void) | null;
  onDisc: (() => void) | null;
  sharedSecret: string | null = null;
  myKyberKeys: { publicKey: string; secretKey: string } | null = null;
  isInitiator = false;
  pendingMsgs: string[] = [];
  keyExchangeDone = false;
  chatId: string | null = null;
  safetyCode: string | null = null;
  _onKeyExchange: (() => Promise<void>) | null = null;
  _onReady: (() => Promise<void>) | null = null;
  _coverTraffic: ReturnType<typeof setInterval> | null = null;
  _lastActivity = 0;
  _livenessWatch: ReturnType<typeof setInterval> | null = null;
  _iceCheckingTimeout: ReturnType<typeof setTimeout> | null = null;
  // Hidden-Bug-Hunt-Fund (siehe native WebRTCManager.js fuer die
  // ausfuehrliche Begruendung): close() nullt bisher nur Instanzfelder,
  // bricht aber einen bereits laufenden Kyber-Handshake nicht ab, der
  // gerade in `await kyberEncapsulate(...)`/`await kyberDecapsulate(...)`
  // haengt. Laeuft RTCStore.resetAll()/clearContact() genau in diesem
  // Fenster, wuerde der fortgesetzte Handler RTCStore.sharedSecrets und die
  // persistente Storage.ts-Ablage direkt NACH einem vermeintlich
  // vollstaendigen Wipe/Loeschen erneut befuellen - siehe
  // SECURITY_HIDDEN_BUG_HUNT.md.
  _closed = false;
  // Siehe identischer Fund/Fix in WebRTCManager.js (nativ, "H3"): onDisc()
  // pro Instanz hoechstens einmal feuern lassen.
  _discFired = false;

  constructor(
    onMessage: ((msg: any) => void) | null,
    onConnected: (() => void) | null,
    onDisconnected: (() => void) | null,
  ) {
    this.onMessage = onMessage;
    this.onConnected = onConnected;
    this.onDisc = onDisconnected;
  }

  async createOffer(): Promise<string> {
    this.isInitiator = true;
    this.pc = new RTCPeerConnection(await pcConfig());
    this._setupPC();
    this.dataChannel = this.pc.createDataChannel('malachi', { ordered: true });
    this._setupDataChannel(this.dataChannel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitForICE();
    return JSON.stringify({ sdp: this.pc.localDescription, type: 'offer' });
  }

  async handleAnswer(answerJSON: string) {
    const answer = JSON.parse(answerJSON);
    await this.pc!.setRemoteDescription(new RTCSessionDescription(answer.sdp));
  }

  // Schlanke Variante von createAnswer() ohne deren Nebeneffekt (Registrieren
  // eines neuen, zufaelligen Pairing-Tokens via sendSignalOffer) - fuer
  // Reconnect brauchen wir nur die Antwort selbst, kein neues Pairing.
  async createAnswerDirect(offerJSON: string): Promise<string> {
    this.isInitiator = false;
    this.pc = new RTCPeerConnection(await pcConfig());
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
    return JSON.stringify({ sdp: this.pc.localDescription });
  }

  async createAnswer(offerJSON: string): Promise<string> {
    this.isInitiator = false;
    this.pc = new RTCPeerConnection(await pcConfig());
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
    return JSON.stringify({ sdp: this.pc.localDescription });
  }

  // Rueckgabewert praezisiert - siehe identischer Kommentar in
  // WebRTCManager.js (nativ), State-Machine-Review Fund 7.
  sendMessage(raw: string): 'sent' | 'queued' | false {
    if (this.dataChannel?.readyState !== 'open') return false;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[WebRTC] sendMessage: ungültiges JSON, verworfen statt unverschlüsselt gesendet');
      return false;
    }

    if (parsed.type === 'system' && (parsed.subtype === 'kyber_pubkey' || parsed.subtype === 'kyber_ciphertext')) {
      this.dataChannel.send(raw);
      return 'sent';
    }

    if (!this.sharedSecret) {
      this.pendingMsgs.push(raw);
      return 'queued';
    }

    // Siehe identischer Fund/Fix in der nativen WebRTCManager.js: die
    // readyState-Pruefung oben ist synchron, das eigentliche Senden hier
    // passiert erst NACH der asynchronen Verschluesselung - bricht die
    // Verbindung genau in diesem Fenster weg, ging die Nachricht bisher
    // stillschweigend verloren. readyState direkt vor dem Senden erneut
    // pruefen, bei Fehlschlag in pendingMsgs ablegen statt zu verlieren -
    // _flushPending() liefert automatisch nach.
    encryptMsg(padToBlock(parsed), this.sharedSecret).then((enc) => {
      if (!enc) {
        console.warn('[WebRTC] Verschluesselung fehlgeschlagen, Nachricht fuer naechste Verbindung zurueckgehalten');
        this.pendingMsgs.push(raw);
        return;
      }
      if (this.dataChannel?.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({ type: 'encrypted', data: enc }));
      } else {
        console.warn('[WebRTC] DataChannel brach waehrend des Sendens weg, Nachricht fuer naechste Verbindung zurueckgehalten');
        this.pendingMsgs.push(raw);
      }
    });
    return 'sent';
  }

  async startCall(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => this.pc!.addTrack(track, stream));
    return stream;
  }

  // Siehe identischer Fund/Fix in WebRTCManager.js (nativ, "H3").
  _fireDisc() {
    if (this._discFired) return;
    this._discFired = true;
    this.onDisc?.();
  }

  // reason 'wipe' NUR aus RTCStore.clearContact()/resetAll() - siehe
  // gleichnamiger Fix in WebRTCManager.js (nativ, Audit 2026-09-28).
  _closeReason: string | null = null;
  _awaitingKeyConfirm = false;

  close(reason: string = 'disconnect') {
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
    // Siehe identischer Fund/Fix in WebRTCManager.js (nativ, "H3").
    if (this.dataChannel) this.dataChannel.onclose = null;
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
    this.dataChannel = null;
    this.sharedSecret = null;
    this.keyExchangeDone = false;
    this.myKyberKeys = null;
    this.safetyCode = null;
    // Konkurrenz-Review-Fund (siehe identischer Kommentar in WebRTCManager.js,
    // nativ): close() nullte bisher onMessage nicht - ein bereits laufender
    // channel.onmessage-Handler, der zum Zeitpunkt des close()-Aufrufs an
    // einem await haengt, wuerde beim Fortsetzen weiterhin `this.onMessage
    // ?.(original)` aufrufen und damit RTCStore's buffer/listeners-Eintrag
    // fuer einen gerade geloeschten/gewipedten Kontakt neu anlegen. Nullen
    // hier schliesst das an der Quelle.
    this.onMessage = null;
    // Siehe Kommentar bei der Felddeklaration oben.
    this._closed = true;
  }

  // Siehe WebRTCManager.js (nativ, Audit 2026-09-28).
  async _rememberPreviousSecret() {
    if (!this.chatId) return;
    const previous = RTCStore.sharedSecrets.get(this.chatId);
    if (!RTCStore.rememberPreviousSecret(this.chatId, previous, this.sharedSecret)) return;
    this._awaitingKeyConfirm = true;
    await setItem('shared_secret_prev_' + this.chatId, previous as string)
      .catch((e) => console.warn('[Crypto] Vorheriges Secret konnte nicht gesichert werden:', e));
  }

  _confirmNewSecret() {
    this._awaitingKeyConfirm = false;
    if (!this.chatId) return;
    RTCStore.confirmCurrentSecret(this.chatId);
    removeItem('shared_secret_prev_' + this.chatId).catch(() => {});
  }

  _setupPC() {
    this.pc!.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      console.log('[WebRTC] ICE State:', state);
      if (state === 'connected' || state === 'completed') {
        if (this._iceCheckingTimeout) {
          clearTimeout(this._iceCheckingTimeout);
          this._iceCheckingTimeout = null;
        }
        this.onConnected?.();
      }
      if (state === 'checking' && !this._iceCheckingTimeout) {
        // Siehe ausfuehrlicher Kommentar in der nativen WebRTCManager.js -
        // gleiche Grundursache, hier fuer Web-Paritaet gespiegelt: ICE kann
        // dauerhaft bei "checking" haengen bleiben, ohne dass der Browser
        // jemals 'failed'/'disconnected' ausloest - ohne diesen Wachhund
        // haengt der Reconnect-Versuch dann fuer immer.
        this._iceCheckingTimeout = setTimeout(() => {
          this._iceCheckingTimeout = null;
          const stillStuck = this.pc?.iceConnectionState !== 'connected' &&
                              this.pc?.iceConnectionState !== 'completed';
          if (stillStuck) {
            console.warn('[WebRTC] ICE haengt seit', ICE_CHECKING_TIMEOUT_MS, 'ms in "checking" fest - als gescheitert behandelt');
            this._fireDisc();
            // Siehe identischer Fund/Fix in der nativen WebRTCManager.js
            // ("H3") - fehlte hier bisher, pc/dataChannel blieben nach
            // diesem Timeout fuer die Lebensdauer der Instanz offen.
            this.close();
          }
        }, ICE_CHECKING_TIMEOUT_MS);
      }
      if (state === 'failed') {
        if (this._iceCheckingTimeout) {
          clearTimeout(this._iceCheckingTimeout);
          this._iceCheckingTimeout = null;
        }
        this._fireDisc();
        // Siehe identischer Fund/Fix in der nativen WebRTCManager.js: ohne
        // close() blieb dataChannel.readyState faelschlich 'open', wodurch
        // die Chat-UI dauerhaft "verbunden" anzeigte.
        this.close();
      }
      if (state === 'disconnected') {
        setTimeout(() => {
          if (this.pc?.iceConnectionState === 'disconnected' || this.pc?.iceConnectionState === 'failed') {
            this._fireDisc();
            this.close();
          }
        }, 3000);
      }
    };
    this.pc!.onicecandidateerror = (e: any) => console.warn('[WebRTC] ICE Error:', e.errorText);
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
  _startLivenessWatch() {
    this._lastActivity = Date.now();
    if (this._livenessWatch) clearInterval(this._livenessWatch);
    const STALE_TIMEOUT_MS = COVER_INTERVAL_MS * 4;
    this._livenessWatch = setInterval(() => {
      if (Date.now() - this._lastActivity > STALE_TIMEOUT_MS) {
        console.warn('[WebRTC] Keine Aktivität seit', STALE_TIMEOUT_MS, 'ms - Verbindung als Zombie erkannt, schließe');
        this._fireDisc();
        this.close();
      }
    }, COVER_INTERVAL_MS + 1000);
  }

  _setupDataChannel(channel: RTCDataChannel) {
    channel.onopen = async () => {
      console.log('[WebRTC] DataChannel offen ✅');
      this.onConnected?.();
      if (this.isInitiator) {
        try {
          this.myKyberKeys = await generateKyberKeypair();
          channel.send(
            JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: this.myKyberKeys.publicKey }),
          );
          console.log('[Crypto] ✅ Kyber Public Key gesendet');
        } catch (e) {
          // Siehe WebRTCManager.js (native) fuer die Begruendung - gleiche
          // Sanitisierung wie SECURITY_SECRETS_LIFECYCLE_FIXES.md Fix 8.
          console.error('[Crypto] Key Exchange fehlgeschlagen:', e instanceof Error ? e.message : e);
        }
      }
    };

    channel.onclose = () => {
      console.log('[WebRTC] DataChannel geschlossen');
      this._fireDisc();
    };

    channel.onmessage = async (event) => {
      this._lastActivity = Date.now();
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'system' && msg.subtype === 'kyber_pubkey') {
          // State-Machine-Review: siehe identischer Kommentar in WebRTCManager.js
          // (native) - ohne diese Pruefung ueberschreibt ein dupliziertes/
          // wiedereingespieltes kyber_pubkey mitten in der Sitzung stillschweigend
          // das aktive sharedSecret.
          if (this.keyExchangeDone) {
            console.warn('[Crypto] kyber_pubkey nach bereits abgeschlossenem Schluesselaustausch verworfen (Duplikat/Replay)');
            return;
          }
          const result = await kyberEncapsulate(msg.publicKey);
          // Hidden-Bug-Hunt-Fund (siehe Feld-Kommentar oben): close() kann
          // waehrend dieses await gelaufen sein (5-Fail-Wipe/Chat-Loeschen/
          // ueberholter Reconnect via RTCStore.setConnection). Ohne diese
          // Pruefung wuerde der Handler unten RTCStore.sharedSecrets und die
          // persistente Storage.ts-Ablage fuer einen bereits geschlossenen
          // Kontakt erneut befuellen.
          if (this._closed) {
            console.warn('[Crypto] Verbindung waehrend Kyber-Encapsulate geschlossen - Ergebnis verworfen statt Secret wiederherzustellen');
            return;
          }
          this.sharedSecret = result.sharedSecret;
          this.keyExchangeDone = true;
          channel.send(JSON.stringify({ type: 'system', subtype: 'kyber_ciphertext', cipherText: result.cipherText }));
          // Chaos-Test-Fund (SECURITY_CHAOS_TESTING.md §9, Fix 2 - identisch
          // zum nativen WebRTCManager.js, siehe dortiger ausfuehrlicher
          // Kommentar): vorher fire-and-forget (`.catch(()=>{})` ohne await) -
          // ein Prozess-Kill in diesem Fenster liess die App faelschlich
          // glauben, die Pairing sei bereits durabel abgeschlossen. Jetzt
          // awaiten, BEVOR _flushPending/Cover-Traffic/_onKeyExchange sich
          // darauf verlassen. Ein reiner Speicherfehler soll den Handshake
          // selbst nicht abbrechen - deshalb weiterhin catch(), nur geloggt
          // statt stillschweigend verschluckt.
          if (this.chatId) {
            await this._rememberPreviousSecret();
            RTCStore.sharedSecrets.set(this.chatId, this.sharedSecret);
            await setItem('shared_secret_' + this.chatId, this.sharedSecret)
              .catch((e) => console.warn('[Crypto] Persistieren des Shared Secret fehlgeschlagen (Responder):', e));
            // Konkurrenz-Review-Fund (siehe identischer Kommentar in
            // WebRTCManager.js, nativ): zweites Zeitfenster - close() kann
            // WAEHREND dieses awaiteten Storage-Writes gelaufen sein, NACH dem
            // bereits synchron erfolgten RTCStore.sharedSecrets.set() darueber.
            // Audit 2026-09-28: nur bei einem echten Wipe wieder entfernen - ein
            // normaler Verbindungsabbruch darf das gerade ausgehandelte Secret
            // nicht loeschen (Kontakt waere sonst dauerhaft unerreichbar).
            if (this._closed) {
              if (this._closeReason === 'wipe') {
                console.warn('[Crypto] Verbindung waehrend Secret-Persistierung geschlossen (Wipe) - wiederhergestellten Eintrag erneut entfernt');
                RTCStore.sharedSecrets.delete(this.chatId);
                RTCStore.previousSecrets.delete(this.chatId);
                removeItem('shared_secret_' + this.chatId).catch(() => {});
                removeItem('shared_secret_prev_' + this.chatId).catch(() => {});
              }
              return;
            }
          }
          await this._flushPending();
          this._startCoverTraffic();
          this._startLivenessWatch();
          this.safetyCode = await this._computeSafetyCode(this.sharedSecret);
          if (this._onKeyExchange) await this._onKeyExchange();
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'kyber_ciphertext') {
          if (this.keyExchangeDone) {
            console.warn('[Crypto] kyber_ciphertext nach bereits abgeschlossenem Schluesselaustausch verworfen (Duplikat/Replay)');
            return;
          }
          const decapsulated = await kyberDecapsulate(msg.cipherText, this.myKyberKeys!.secretKey);
          // Siehe Kommentar im kyber_pubkey-Handler oben - identische
          // Absicherung fuer die Initiator-Seite.
          if (this._closed) {
            console.warn('[Crypto] Verbindung waehrend Kyber-Decapsulate geschlossen - Ergebnis verworfen statt Secret wiederherzustellen');
            return;
          }
          this.sharedSecret = decapsulated;
          this.keyExchangeDone = true;
          // Siehe ausfuehrlicher Kommentar im kyber_pubkey-Handler oben (Fix 2).
          if (this.chatId) {
            await this._rememberPreviousSecret();
            RTCStore.sharedSecrets.set(this.chatId, this.sharedSecret);
            await setItem('shared_secret_' + this.chatId, this.sharedSecret)
              .catch((e) => console.warn('[Crypto] Persistieren des Shared Secret fehlgeschlagen (Initiator):', e));
            // Siehe identischer Kommentar im kyber_pubkey-Handler oben -
            // zweites Zeitfenster (waehrend des Storage-Writes selbst).
            if (this._closed) {
              if (this._closeReason === 'wipe') {
                console.warn('[Crypto] Verbindung waehrend Secret-Persistierung geschlossen (Wipe) - wiederhergestellten Eintrag erneut entfernt');
                RTCStore.sharedSecrets.delete(this.chatId);
                RTCStore.previousSecrets.delete(this.chatId);
                removeItem('shared_secret_' + this.chatId).catch(() => {});
                removeItem('shared_secret_prev_' + this.chatId).catch(() => {});
              }
              return;
            }
          }
          await this._flushPending();
          this._startCoverTraffic();
          this._startLivenessWatch();
          this.safetyCode = await this._computeSafetyCode(this.sharedSecret);
          if (this._onKeyExchange) await this._onKeyExchange();
          return;
        }
        if (msg.type === 'encrypted') {
          if (!this.sharedSecret) return;
          const plaintext = decryptMsg(msg.data, this.sharedSecret);
          if (plaintext) {
            if (this._awaitingKeyConfirm) this._confirmNewSecret();
            const original = JSON.parse(plaintext);
            if (original.p !== undefined) delete original.p;
            if (original.type === 'system' && original.subtype === 'ready') {
              if (this._onReady) await this._onReady();
              return;
            }
            if (original.type === 'dummy') return;
            // Siehe Kommentar in WebRTCManager.js (Sicherheitsaudit) - dieselbe
            // Pruefung, bisher fehlte sie hier komplett.
            if (original.type === 'text' && !isFreshTimestamp(original.time)) {
              console.warn('[Security] Live-Nachricht ohne gueltigen/frischen Zeitstempel verworfen (moeglicher Replay)');
              return;
            }
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
      } catch (e) {
        console.warn('[WebRTC] Parse/Decrypt Fehler:', e);
      }
    };
  }

  async _flushPending() {
    if (this.pendingMsgs.length === 0) return;
    for (const raw of this.pendingMsgs) {
      let padded = raw;
      try {
        padded = padToBlock(JSON.parse(raw));
      } catch {
        /* raw bleibt wie es ist */
      }
      const enc = await encryptMsg(padded, this.sharedSecret!);
      if (enc) this.dataChannel?.send(JSON.stringify({ type: 'encrypted', data: enc }));
    }
    this.pendingMsgs = [];
  }

  async _computeSafetyCode(sharedSecret: string): Promise<string | null> {
    try {
      const bytes = new TextEncoder().encode(sharedSecret);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const digits = hex.replace(/[^0-9]/g, '').padEnd(16, '0').slice(0, 16);
      return digits.slice(0, 4) + '-' + digits.slice(4, 8) + '-' + digits.slice(8, 12) + '-' + digits.slice(12, 16);
    } catch {
      return null;
    }
  }

  _startCoverTraffic() {
    if (this._coverTraffic) clearInterval(this._coverTraffic);
    this._coverTraffic = setInterval(async () => {
      if (this.dataChannel?.readyState !== 'open' || !this.sharedSecret) return;
      const dummy = padToBlock({ type: 'dummy' });
      const encrypted = await encryptMsg(dummy, this.sharedSecret);
      if (encrypted) this.dataChannel.send(JSON.stringify({ type: 'encrypted', data: encrypted }));
    }, COVER_INTERVAL_MS);
  }

  _waitForICE(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc!.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      let resolved = false;
      let firstCandidateTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (resolved) return;
        resolved = true;
        if (firstCandidateTimer) clearTimeout(firstCandidateTimer);
        resolve();
      };
      this.pc!.onicegatheringstatechange = () => {
        if (this.pc?.iceGatheringState === 'complete') done();
      };
      // Siehe identischer Fund/Fix in der nativen WebRTCManager.js: das
      // Warten auf den VOLLSTAENDIGEN Abschluss des Gatherings (statt nur
      // auf den ersten brauchbaren Relay-Kandidaten) war mit Abstand der
      // groesste Einzelposten der gesamten Reconnect-Downtime.
      this.pc!.onicecandidate = (event: any) => {
        const c = event?.candidate?.candidate;
        if (c && !firstCandidateTimer && (!FORCE_RELAY_ONLY || / typ relay /.test(c))) {
          firstCandidateTimer = setTimeout(done, 1500);
        }
      };
      // Reiner Sicherheitsnetz-Fallback, falls ueberhaupt kein Kandidat
      // ankommt - siehe identischer Kommentar in WebRTCManager.js (nativ).
      setTimeout(done, 12000);
    });
  }
}
