// Malachi Web - CallManager.ts
// Portiert aus CallManager.js. Keine native Telecom-/Notification-Bruecke
// (die gibt es im Browser nicht) - Anrufe laufen rein als In-Page-UI.
// Signalisierung (Offer/Answer/ICE) laeuft identisch ueber denselben
// /call/signal-Kanal wie bei der nativen App - Web und Handy koennen sich
// gegenseitig anrufen.
import { sendCallSignal, pollCallSignals } from './RelayClient';
import { pcConfigForCalls } from './WebRTCManager';
import { encryptMsg, decryptMsg } from './MessageCrypto';
import RTCStore from './RTCStore';
import { getItem } from './Storage';

const CALL_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 700;

export const CallState = {
  IDLE: 'idle',
  OUTGOING_RINGING: 'outgoing_ringing',
  INCOMING_RINGING: 'incoming_ringing',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  ENDED: 'ended',
} as const;
export type CallStateT = (typeof CallState)[keyof typeof CallState];

interface CallSignal {
  type: string;
  payload: any;
  ts: number;
}

export default class CallManager {
  contactId: string;
  peerName: string;
  role: 'caller' | 'callee' | null = null;
  onStateChange: (state: CallStateT) => void;
  onMissedCall: (info: any) => void;
  onRemoteStream: (stream: MediaStream) => void;

  pc: RTCPeerConnection | null = null;
  localStream: MediaStream | null = null;
  state: CallStateT = CallState.IDLE;
  ringTimer: ReturnType<typeof setTimeout> | null = null;
  connectTimer: ReturnType<typeof setTimeout> | null = null;
  pollTimer: ReturnType<typeof setInterval> | null = null;
  // Konkurrenz-Review-Fund (mirrors CallManager.js nativ - dort per
  // Rot-Team-Review-Fund nachgezogen, hier direkt mit uebernommen): ohne
  // diese Zyklus-Sperre koennte ein haengender Relay-Request (mehrere
  // awaits: pollCallSignals(), decryptMsg, ggf. pc.setRemoteDescription/
  // addIceCandidate in handleSignal()) zwei ueberlappende Verarbeitungs-
  // Ketten fuer denselben Call gegen dasselbe this.pc/this.state laufen
  // lassen, statt sie sauber nacheinander abzuarbeiten.
  _pollCycleRunning = false;
  callStartTime: number | null = null;
  _incomingOffer: string | null = null;
  // Mirrors CallManager.js (nativ) - dort per Live-Test gefundener Bug:
  // Trickle-ICE-Kandidaten koennen vor der SDP-Antwort (setRemoteDescription)
  // eintreffen, addIceCandidate() davor wirft und der Kandidat ging bisher
  // verloren - haengt dann dauerhaft bei "Verbinde...".
  _pendingIceCandidates: any[] = [];

  constructor(opts: {
    contactId: string;
    peerName?: string;
    onStateChange?: (state: CallStateT) => void;
    onMissedCall?: (info: any) => void;
    onRemoteStream?: (stream: MediaStream) => void;
  }) {
    this.contactId = opts.contactId;
    this.peerName = opts.peerName || 'Malachi-Kontakt';
    this.onStateChange = opts.onStateChange || (() => {});
    this.onMissedCall = opts.onMissedCall || (() => {});
    this.onRemoteStream = opts.onRemoteStream || (() => {});
  }

  _outDirection() {
    return this.role === 'caller' ? 'to-callee' : 'to-caller';
  }
  _inDirection() {
    return this.role === 'caller' ? 'to-caller' : 'to-callee';
  }

  _startPolling() {
    if (this.pollTimer) return;
    this._pollCycleRunning = false;
    this.pollTimer = setInterval(async () => {
      if (this._pollCycleRunning) return;
      this._pollCycleRunning = true;
      try {
        const signals = await pollCallSignals(this.contactId, this._inDirection());
        for (const signal of signals) {
          await this.handleSignal(signal as CallSignal);
        }
      } finally {
        this._pollCycleRunning = false;
      }
    }, POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  _setState(state: CallStateT) {
    this.state = state;
    this.onStateChange(state);
  }

  _startConnectTimeout() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.state === CallState.CONNECTING) this.endCall('connect_timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  async _flushPendingIceCandidates() {
    const pending = this._pendingIceCandidates;
    this._pendingIceCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc!.addIceCandidate(candidate);
      } catch (e: any) {
        console.warn('[Call] Zwischengespeicherter ICE-Kandidat fehlgeschlagen:', e.message);
      }
    }
  }

  async _createPeerConnection(): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection(await pcConfigForCalls());

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignal({ type: 'ice', payload: { candidate: event.candidate } }).catch((e: Error) =>
          console.warn('[Call] ICE-Kandidat konnte nicht gesendet werden:', e.message)
        );
      }
    };

    pc.ontrack = (event) => this.onRemoteStream(event.streams[0]);

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' && this.state !== CallState.ACTIVE) {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this._setState(CallState.ACTIVE);
        this.callStartTime = Date.now();
      }
      if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
        this.endCall('connection_lost');
      }
    };

    return pc;
  }

  async _getLocalStream(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    return this.localStream;
  }

  async startCall() {
    this.role = 'caller';
    this._startPolling();

    // getUserMedia (kein Mikrofon, Berechtigung verweigert...) kann hier
    // fehlschlagen, waehrend state noch IDLE ist - endCall() bricht bei IDLE
    // sofort ab, die UI bliebe sonst fuer immer auf dem CallScreen haengen.
    try {
      this.pc = await this._createPeerConnection();
      const stream = await this._getLocalStream();
      stream.getTracks().forEach((track) => this.pc!.addTrack(track, stream));

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this._setState(CallState.OUTGOING_RINGING);
      await this._sendSignal({ type: 'offer', payload: { sdp: offer.sdp } });

      this.ringTimer = setTimeout(() => {
        if (this.state === CallState.OUTGOING_RINGING) {
          this._sendSignal({ type: 'cancel', payload: {} }).catch((e: Error) =>
            console.warn('[Call] Cancel-Signal konnte nicht gesendet werden:', e.message)
          );
          this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'outgoing_unanswered' });
          this.endCall('timeout');
        }
      }, CALL_TIMEOUT_MS);
    } catch (e) {
      console.error('[Call] startCall fehlgeschlagen (Mikrofon/Verbindung):', e);
      this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'media_error' });
      this._forceCleanupToIdle();
    }
  }

  async handleIncomingOffer(signal: CallSignal) {
    this.role = 'callee';
    this._incomingOffer = (signal.payload as any).sdp;
    this._setState(CallState.INCOMING_RINGING);
    this._startPolling();

    this.ringTimer = setTimeout(() => {
      if (this.state === CallState.INCOMING_RINGING) {
        this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'incoming_unanswered' });
        this.endCall('timeout');
      }
    }, CALL_TIMEOUT_MS);
  }

  async handleSignal(signal: CallSignal) {
    // _sendSignal() verschickt inzwischen nie mehr unverschluesselt (H-2) - ein
    // Signal ohne .enc wird verworfen statt blind vertraut (Sicherheitsreview).
    if (!signal.payload?.enc) {
      console.warn('[Call] Unverschlüsseltes Signal verworfen (kein .enc):', signal.type);
      return;
    }
    const secret = await this._getSharedSecret();
    if (secret) {
      // purpose 'call-signal' - muss mit nativer CallManager.js identisch sein.
      const decrypted = decryptMsg(signal.payload.enc, secret, 'call-signal');
      if (decrypted) {
        signal = { ...signal, payload: JSON.parse(decrypted) };
      } else {
        return;
      }
    } else {
      return;
    }

    switch (signal.type) {
      case 'offer':
        if (this.state === CallState.IDLE) await this.handleIncomingOffer(signal);
        break;
      case 'answer':
        if (this.state !== CallState.OUTGOING_RINGING) break;
        if (this.ringTimer) clearTimeout(this.ringTimer);
        await this.pc!.setRemoteDescription({ type: 'answer', sdp: (signal.payload as any).sdp });
        await this._flushPendingIceCandidates();
        this._setState(CallState.CONNECTING);
        this._startConnectTimeout();
        break;
      case 'ice':
        // Mirrors CallManager.js (nativ) - Kernbug: this.pc existiert auf der
        // Angerufenen-Seite waehrend des Klingelns noch nicht (erst in
        // acceptCall() erzeugt), der Anrufer sendet seine Kandidaten aber
        // sofort per Trickle-ICE. "if (this.pc && ...)" verwarf sie daher
        // komplett, statt sie zwischenzuspeichern.
        if ((signal.payload as any)?.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            try {
              await this.pc.addIceCandidate((signal.payload as any).candidate);
            } catch (e: any) {
              console.warn('[Call] ICE-Kandidat fehlgeschlagen:', e.message);
            }
          } else {
            this._pendingIceCandidates.push((signal.payload as any).candidate);
          }
        }
        break;
      case 'reject':
        this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'rejected_by_peer' });
        this.endCall('rejected');
        break;
      case 'cancel':
        this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'cancelled_by_peer' });
        this.endCall('cancelled');
        break;
      case 'end':
        this.endCall('remote_hangup');
        break;
    }
  }

  async acceptCall() {
    if (this.state !== CallState.INCOMING_RINGING) return;
    this._setState(CallState.CONNECTING);
    this._startConnectTimeout();
    if (this.ringTimer) clearTimeout(this.ringTimer);

    try {
      this.pc = await this._createPeerConnection();
      const stream = await this._getLocalStream();
      stream.getTracks().forEach((track) => this.pc!.addTrack(track, stream));

      await this.pc.setRemoteDescription({ type: 'offer', sdp: this._incomingOffer! });
      await this._flushPendingIceCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      await this._sendSignal({ type: 'answer', payload: { sdp: answer.sdp } });
    } catch (e) {
      console.error('[Call] acceptCall fehlgeschlagen (Mikrofon/Verbindung):', e);
      this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'media_error' });
      this.endCall('media_error');
    }
  }

  rejectCall() {
    if (this.state !== CallState.INCOMING_RINGING) return;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this._sendTerminalSignal('reject');
    this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason: 'rejected_locally' });
    this.endCall('rejected');
  }

  endCall(_reason = 'user_hangup') {
    if (this.state === CallState.ENDED || this.state === CallState.IDLE) return;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this._stopPolling();

    if (this.state === CallState.OUTGOING_RINGING) {
      this._sendTerminalSignal('cancel');
    } else if (this.state === CallState.INCOMING_RINGING) {
      this._sendTerminalSignal('reject');
    } else if (this.state === CallState.ACTIVE || this.state === CallState.CONNECTING) {
      this._sendTerminalSignal('end');
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this._setState(CallState.ENDED);
    setTimeout(() => this._setState(CallState.IDLE), 500);
  }

  // Fuer Fehler, die auftreten BEVOR der State ueberhaupt von IDLE weg ist -
  // endCall() selbst greift hier nicht (sein Schutz vor Doppelaufrufen bricht
  // bei IDLE ab). Raeumt dieselben Ressourcen auf und bringt die UI garantiert
  // aus dem CallScreen wieder raus.
  _forceCleanupToIdle() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this._stopPolling();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this._setState(CallState.ENDED);
    setTimeout(() => this._setState(CallState.IDLE), 500);
  }

  toggleMute(muted: boolean) {
    if (this.localStream) this.localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  getDuration(): number {
    return this.callStartTime ? Math.floor((Date.now() - this.callStartTime) / 1000) : 0;
  }

  async _getSharedSecret(): Promise<string | null> {
    let secret = RTCStore.getSharedSecret(this.contactId);
    if (secret) return secret;
    secret = await getItem('shared_secret_' + this.contactId);
    return secret || null;
  }

  // Siehe identischer Fix in CallManager.js (nativ) - Hauptfund war ein
  // Server-Bug (relay.js loeschte die Signal-Queue statt cancel/end/reject
  // zuzustellen, siehe dortiger Kommentar), diese Wiederholung ist die
  // zusaetzliche clientseitige Absicherung gegen einen rein transienten
  // Netzwerkfehler bei genau den drei Signalen, die sonst keine natuerliche
  // Wiederholung haben.
  async _sendTerminalSignal(type: string) {
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      try {
        const ok = await this._sendSignal({ type, payload: {} });
        if (ok) return true;
      } catch (e: any) {
        if (i === attempts - 1) {
          console.warn(`[Call] ${type}-Signal konnte auch nach ${attempts} Versuchen nicht gesendet werden:`, e.message);
        }
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  async _sendSignal({ type, payload }: { type: string; payload: any }) {
    const secret = await this._getSharedSecret();
    if (!secret) {
      // Faellt geschlossen aus statt unverschluesselt zu senden (Sicherheitsreview H-2).
      console.error('[Call] Kein Shared Secret gefunden - Signal wird NICHT unverschlüsselt gesendet:', type);
      throw new Error('Kein sicherer Kanal zu diesem Kontakt - Anruf abgebrochen.');
    }
    const encPayload = await encryptMsg(JSON.stringify(payload || {}), secret, 'call-signal');
    return sendCallSignal(this.contactId, this._outDirection(), type, { enc: encPayload });
  }
}
