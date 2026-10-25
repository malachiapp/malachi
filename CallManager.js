// CallManager.js
// Verschlüsselte Anrufe für Malachi
//
// Baut auf demselben Unterbau wie WebRTCManager.js auf (gleiche ICE-
// Konfiguration: kein STUN, kein TURN), nutzt aber einen eigenen
// RTCPeerConnection fuer Audio. Die oeffentliche IPv4-Adresse kommt wie beim
// Chat hoechstens vom eigenen Router: nach dem Sammeln der Kandidaten wird er
// um eine Portfreigabe gebeten, erfolgreiche Freigaben gehen als normale
// Trickle-Kandidaten ('ice') an die Gegenseite und werden beim Auflegen
// geloescht (PortMapping.CallPortMapper, STUN_AUSSTIEG_PLAN.md Luecke L1).
// Die Signalisierung (Offer/Answer/ICE) laeuft ausschliesslich ueber die
// bestehende, verschluesselte Verbindung zum Kontakt (direkt oder Tor) als
// System-Nachricht (subtype call_signal), zusaetzlich mit eigenem
// Unterschluessel verschluesselt. Es gibt keinen Server mehr: steht keine
// Verbindung, wird zuerst eine ueber Tor aufgebaut (RTCStore.connectionEnsurer,
// siehe BackgroundSync.ensureConnection) - klappt das nicht, endet der Anruf
// mit einem klaren Hinweis.
//
// WICHTIG: Der eigentliche Audiostrom wird durch WebRTCs eingebautes DTLS-SRTP
// verschlüsselt (Standard, nicht optional). Eine zusätzliche Anwendungsschicht-
// Verschlüsselung auf dem Audio selbst ist NICHT vorgesehen (Latenz!) - die
// Dreischicht-Verschlüsselung bleibt Text/Bild/Voice-Notes vorbehalten.
//
// Verbindungsweg "Maximal anonym (nur Tor)" (ConnectionMode.js, Stufe 3): es
// entsteht NIE eine RTCPeerConnection - schon ihre ICE-Kandidaten (per Trickle
// an den Kontakt) wuerden die IP-Adresse verraten. Anrufe laufen dann nur als
// Sprache ueber den Kanal: das Angebot traegt statt SDP channelOnly:true, die
// Antwort ebenso; beide Seiten starten direkt "Sprache ueber den Kanal".
// Nimmt eine Seite in Stufe 3 ein normales Angebot an, antwortet sie
// ebenfalls channelOnly (ohne eigene Kandidaten). Videoanrufe werden in
// Stufe 3 mit Hinweis abgelehnt; ein eingehender Videoanruf laeuft als
// Sprachanruf. Wechselt der Nutzer waehrend eines Anrufs auf Stufe 3, wechselt
// der Anruf sofort auf den Kanal (bzw. endet mit Hinweis, wenn das nicht geht).

import { RTCPeerConnection, mediaDevices } from 'react-native-webrtc';
import { NativeModules, NativeEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import { pcConfigForCalls } from './WebRTCManager';
import { encryptMsg, decryptMsg } from './MessageCrypto';
import RTCStore from './RTCStore';
import { MODE_TOR_ONLY, connectionModeForDecision, onConnectionModeChange } from './ConnectionMode';
import { CallPortMapper } from './PortMapping';
import * as ConnectionStats from './ConnectionStats';
import { setCallSpeaker } from './CallAudioRoute';
import { t } from './i18n';

// Hinweistexte in der aktiven Sprache (i18n.js) - als Funktionen, damit ein
// Sprachwechsel ohne Neustart greift.
export const torOnlyVideoNotice = () => t('call.notice.torOnlyVideo');
const torOnlyVideoAsVoiceNotice = () => t('call.notice.torOnlyVideoAsVoice');

// Brücke zur nativen Telecom-/Notification-Schicht (siehe CallBridgeModule.kt).
// Kann null sein (z.B. iOS, oder falls das native Modul aus irgendeinem Grund
// fehlt) - deshalb überall mit ?. abgesichert, statt hart vorauszusetzen.
const { CallBridgeModule } = NativeModules;
const callEventEmitter = CallBridgeModule ? new NativeEventEmitter(CallBridgeModule) : null;

const CALL_TIMEOUT_MS = 30000;   // Klingelzeit, bevor "verpasster Anruf" gemeldet wird
const CONNECT_TIMEOUT_MS = 20000; // Sicherheitsnetz: hängt "Verbinde..." länger, sauber abbrechen
// Kommt die Medienverbindung (WebRTC) bis dahin nicht zustande, wechselt der
// Anruf auf "Sprache ueber den Kanal" (Tor oder direkt) - siehe
// _switchToChannelAudio(). Muss deutlich vor CONNECT_TIMEOUT_MS liegen.
// Laeuft die Verbindung zum Kontakt schon ueber Tor (direkt ging also
// bereits vorher nicht), scheitert auch die direkte Anrufverbindung fast
// sicher - dann sofort wechseln statt zu warten.
const CHANNEL_AUDIO_AFTER_MS = 5000;
const CHANNEL_AUDIO_AFTER_MS_VIA_TOR = 0;
const micDeniedNotice = () => t('call.notice.micDenied');
const CallAudio = NativeModules.MalachiCallAudio;
const callAudioEmitter = CallAudio ? new NativeEventEmitter(CallAudio) : null;
const ICE_DISCONNECT_GRACE_MS = 6000; // siehe oniceconnectionstatechange ('disconnected')
// Keine Verbindung zum Kontakt: so lange darf der Aufbau ueber Tor dauern,
// bevor der Anruf mit Hinweis endet (Tor-Verbindungen brauchen 5-25 s).
export const CALL_CONNECT_VIA_TOR_TIMEOUT_MS = 45000;
// Beendigungssignal (Auflegen/Ablehnen) ohne Verbindung: kuerzer, die
// Gegenseite beendet ein haengendes Klingeln ohnehin nach 30 s selbst.
const TERMINAL_SIGNAL_CONNECT_TIMEOUT_MS = 15000;
// Fuer diese Signale lohnt sich ein Verbindungsaufbau ueber Tor, falls gerade
// keine Verbindung steht (siehe _sendSignal).
const SIGNALS_WORTH_CONNECTING = new Set(['offer', 'answer']);

export const CallState = {
  IDLE: 'idle',
  // Noch keine Verbindung zum Kontakt - wird ueber Tor aufgebaut ("Verbinde
  // ueber Tor ..."), erst danach klingelt es bei der Gegenseite.
  PREPARING: 'preparing',
  OUTGOING_RINGING: 'outgoing_ringing',
  INCOMING_RINGING: 'incoming_ringing',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  ENDED: 'ended',
};

export default class CallManager {
  // contactId: gemeinsame Kontakt-ID aus der Kopplung (beide Seiten kennen sie).
  // role: wird pro Anrufversuch gesetzt - 'caller' bei startCall(), 'callee' bei
  //       handleIncomingOffer().
  constructor({ contactId, peerName, theirMyId, video = false, onStateChange, onMissedCall, onRemoteStream, onVideoStateChange, onNotice }) {
    this.contactId = contactId;
    this.peerName = peerName || t('call.unknownContact');
    this.theirMyId = theirMyId || null; // frueher fuers Server-Wecksignal - ohne Server ungenutzt
    this.role = null; // 'caller' | 'callee'
    // Nutzerwunsch: Videoanrufe, jetzt auch waehrend eines laufenden Gesprächs
    // umschaltbar (siehe toggleVideo() weiter unten) - dieser Wert ist nur der
    // Startzustand. Fuer den Anrufer gilt der hier uebergebene Wert; der
    // Angerufene uebernimmt ihn stattdessen aus dem Offer-Signal (siehe
    // handleIncomingOffer). Jede Seite kann ihr eigenes Video unabhaengig von
    // der Gegenseite an-/ausschalten (this.remoteVideo haelt DEREN Zustand).
    this.video = !!video;
    this.remoteVideo = !!video;
    this.onStateChange = onStateChange || (() => {});
    this.onMissedCall = onMissedCall || (() => {});
    this.onRemoteStream = onRemoteStream || (() => {});
    this.onVideoStateChange = onVideoStateChange || (() => {});
    // Hinweise an den Nutzer (Abbruchgrund, Video ueber Tor nicht moeglich).
    // Vorher endete ein gescheiterter Anruf kommentarlos (Live-Test 2026-10-05).
    this.onNotice = onNotice || (() => {});

    this.pc = null;
    this.localStream = null;
    this.state = CallState.IDLE;
    this.ringTimer = null;
    this.connectTimer = null;
    this.callStartTime = null;
    this._incomingOffer = null;
    // ICE-Kandidaten treffen per Trickle-ICE ueber die Verbindung zum Kontakt
    // ein - koennen also durchaus VOR der SDP-Antwort (setRemoteDescription)
    // ankommen, z.B. wenn der Angerufene erst nach ein paar hundert ms
    // annimmt (Mikrofon-Berechtigung, Nutzer-Tap). pc.addIceCandidate() vor
    // gesetzter remoteDescription wirft (InvalidStateError), unbehandelt hier
    // bisher - der Kandidat ging dabei stillschweigend verloren. Bei genug
    // verlorenen Kandidaten (v.a. der TURN-Relay-Kandidat, der laenger
    // braucht als der erste STUN-Kandidat) findet ICE nie ein funktionierendes
    // Paar - haengt dauerhaft bei "Verbinde..." (per Live-Test entdeckt).
    // Fix: zu frueh eintreffende Kandidaten zwischenspeichern, nach
    // setRemoteDescription() nachtraeglich anwenden.
    this._pendingIceCandidates = [];
    // Eingehende Signale kommen einzeln ueber die Verbindung (RTCStore ->
    // App.tsx -> handleSignal) und werden strikt nacheinander verarbeitet -
    // wie frueher durch die Sperre des Server-Polls: zwei parallele
    // handleSignal()-Ketten gegen dasselbe this.pc/this.state (z.B. 'answer'
    // und direkt danach ein ICE-Kandidat) koennten sonst Kandidaten verlieren.
    this._signalChain = Promise.resolve();
    this._nativeSubs = [];
    this.speaker = false;   // Lautsprecher (setSpeaker), beim Ende zurueckgesetzt
    this._subscribeNativeEvents();
    // Nur Sprache ueber den Kanal, nie WebRTC (Verbindungsweg "nur Tor" bei
    // uns oder bei der Gegenseite) - siehe Kopfkommentar.
    this.channelOnly = false;
    this._torOnlyCall = false;
    this._peerChannelOnly = false;
    this._modeUnsub = null;
    this._channelSwitch = null;
    // Router-Portfreigabe der Anruf-PeerConnection (PortMapping.js, L1).
    this._portMapper = null;
    // Diagnose (ConnectionStats.js): Beginn des Verbindens (Annehmen bzw.
    // Antwort erhalten) fuer die Aufbauzeit-Klasse.
    this._connectStartedAt = 0;
    this._callCounted = false;
  }

  // Wechsel des Verbindungswegs waehrend eines Anrufs mitbekommen (nur solange
  // ein Anruf laeuft - beendet in endCall/_forceCleanupToIdle).
  _watchConnectionMode() {
    if (this._modeUnsub) return;
    this._modeUnsub = onConnectionModeChange((mode) => this._onConnectionModeChange(mode));
  }

  _unwatchConnectionMode() {
    if (this._modeUnsub) { try { this._modeUnsub(); } catch {} }
    this._modeUnsub = null;
  }

  // Abo laeuft nur zwischen Anrufbeginn und -ende; IDLE heisst hier "Anruf wird
  // gerade aufgebaut" (startCall bei bestehender Verbindung).
  _onConnectionModeChange(mode) {
    if (mode !== MODE_TOR_ONLY || this.state === CallState.ENDED) return;
    this.channelOnly = true;
    this._torOnlyCall = true;
    if (this.viaChannelAudio) return;
    if (this.state === CallState.CONNECTING || this.state === CallState.ACTIVE) {
      console.log('[Call] Verbindungsweg "nur Tor" - Anruf wechselt auf Sprache ueber den Kanal');
      this._switchToChannelAudio(true).then((ok) => {
        if (!ok && (this.state === CallState.CONNECTING || this.state === CallState.ACTIVE)) this.endCall('tor_only_switch');
      }).catch(() => {});
      return;
    }
    // Aufbau/Klingeln: WebRTC sofort beenden (keine weiteren Kandidaten).
    // startCall() schickt dann ein Angebot ohne SDP; antwortet die Gegenseite
    // auf ein frueheres Angebot mit SDP, geht der Anruf auf den Kanal (siehe
    // 'answer'). INCOMING_RINGING: acceptCall() prueft den Verbindungsweg selbst.
    this._closePeerConnection();
  }

  // Portfreigaben dieses Anrufs am Router loeschen (auch eine, die erst
  // danach eintrifft - PortMappingSession loescht sie dann sofort).
  _releasePortMapper() {
    if (this._portMapper) { try { this._portMapper.release(); } catch {} }
    this._portMapper = null;
  }

  // Diagnose: Weg und Aufbauzeit des Anrufs einmal zaehlen.
  _countCallPath(kind) {
    if (this._callCounted) return;
    this._callCounted = true;
    ConnectionStats.bump('calls', kind);
    if (this._connectStartedAt) ConnectionStats.noteCallSetup(Date.now() - this._connectStartedAt);
  }

  _closePeerConnection() {
    this._releasePortMapper();
    if (this.pc) {
      this.pc.oniceconnectionstatechange = null;
      this.pc.onicecandidate = null;
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
  }

  async _flushPendingIceCandidates() {
    const pending = this._pendingIceCandidates;
    this._pendingIceCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn('[Call] Zwischengespeicherter ICE-Kandidat fehlgeschlagen:', e.message);
      }
    }
  }

  // Reagiert auf Annehmen/Ablehnen/Auflegen, das NICHT aus der App-UI kommt,
  // sondern z.B. über die System-Notification, Bluetooth-Headset-Taste o.ä.
  // "true" als zweiter Parameter bei accept/reject/endCall verhindert, dass wir
  // die native Seite gleich nochmal informieren (die weiß es ja bereits).
  _subscribeNativeEvents() {
    if (!callEventEmitter) return;
    const forMe = (params) => params?.contactId === this.contactId;
    this._nativeSubs.push(
      callEventEmitter.addListener('nativeCallAnswered', (p) => { if (forMe(p)) this.acceptCall(true); }),
      callEventEmitter.addListener('nativeCallRejected', (p) => { if (forMe(p)) this.rejectCall(true); }),
      callEventEmitter.addListener('nativeCallEnded', (p) => { if (forMe(p)) this.endCall('remote_hangup', true); }),
      callEventEmitter.addListener('nativeCallCancelled', (p) => { if (forMe(p)) this.endCall('cancelled', true); }),
    );
  }

  _unsubscribeNativeEvents() {
    this._nativeSubs.forEach((sub) => sub.remove());
    this._nativeSubs = [];
  }

  _setState(state) {
    console.log('[Call] State:', this.role, '→', state);
    this.state = state;
    // Laufenden Anruf in RTCStore vermerken (Zustandsanzeige).
    if (state === CallState.IDLE) {
      if (RTCStore.activeCallContactId === this.contactId) RTCStore.setActiveCall(null);
    } else if (state !== CallState.ENDED) {
      RTCStore.setActiveCall(this.contactId);
    }
    this.onStateChange(state);
  }

  // Sicherheitsnetz: wird beim Wechsel zu CONNECTING gestartet. Falls die
  // Verbindung nicht innerhalb der Frist wirklich zustande kommt (ICE bleibt
  // hängen, Gegenseite verschwindet ohne Signal etc.), sauber abbrechen statt
  // für immer bei "Verbinde..." stehen zu bleiben.
  _startConnectTimeout() {
    clearTimeout(this.connectTimer);
    clearTimeout(this._channelAudioTimer);
    if (!this._connectStartedAt) this._connectStartedAt = Date.now();
    const viaTor = RTCStore.connections.get(this.contactId)?.transport === 'tor' && RTCStore.isConnected(this.contactId);
    this._channelAudioTimer = setTimeout(() => {
      if (this.state === CallState.CONNECTING && !this.viaChannelAudio) {
        console.log(viaTor
          ? '[Call] Verbindung laeuft ueber Tor - Sprache sofort ueber den Kanal'
          : '[Call] Keine Medienverbindung - wechsle auf Sprache ueber den Kanal');
        this._switchToChannelAudio(true);
      }
    }, viaTor ? CHANNEL_AUDIO_AFTER_MS_VIA_TOR : CHANNEL_AUDIO_AFTER_MS);
    this.connectTimer = setTimeout(() => {
      if (this.state === CallState.CONNECTING && !this.viaChannelAudio) {
        this.endCall('connect_timeout');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  // ── Sprache ueber den Kanal (letzter Ausweg) ────────────────────────────
  // Klappt keine WebRTC-Medienverbindung (z.B. 5G gegen WLAN hinter
  // Carrier-NAT, kein TURN), laeuft die Sprache ueber die bestehende,
  // verschluesselte Verbindung zum Kontakt (Tor oder direkt): Opus-Pakete
  // (MalachiCallAudioModule.kt), je 3 x 20 ms gebuendelt, verschluesselt wie
  // jede Nachricht. Ueber Tor mit spuerbarer Verzoegerung, aber ohne Server.
  _canUseChannelAudio() {
    return !!CallAudio && RTCStore.isConnected(this.contactId);
  }

  // Zwei Ausloeser gleichzeitig (Zeitgeber, Signal der Gegenseite, Wechsel
  // des Verbindungswegs) teilen sich denselben Wechsel statt zweimal zu starten.
  _switchToChannelAudio(initiatedByMe) {
    if (this._channelSwitch) return this._channelSwitch;
    const p = this._doSwitchToChannelAudio(initiatedByMe);
    this._channelSwitch = p;
    const clear = () => { if (this._channelSwitch === p) this._channelSwitch = null; };
    p.then(clear, clear);
    return p;
  }

  async _doSwitchToChannelAudio(initiatedByMe) {
    if (this.viaChannelAudio || this.state === CallState.ENDED || this.state === CallState.IDLE) return false;
    if (!this._canUseChannelAudio()) return false;
    const supported = await CallAudio.isSupported().catch(() => false);
    if (!supported || this.viaChannelAudio) return false;
    this.viaChannelAudio = true;
    if (this.video || this.remoteVideo) {
      this.video = false;
      this.remoteVideo = false;
      try { this.onVideoStateChange(false, false); } catch {}
      this.onNotice(this._torOnlyCall
        ? torOnlyVideoAsVoiceNotice()
        : this._viaTor()
          ? t('call.notice.videoViaTor', { name: this.peerName })
          : t('call.notice.videoNoConnection'));
    }
    clearTimeout(this.connectTimer);
    clearTimeout(this._iceGraceTimer);
    clearTimeout(this._channelAudioTimer);
    // WebRTC-Medien freigeben (Mikrofon wird gleich nativ gebraucht).
    this._closePeerConnection();
    if (initiatedByMe) {
      await this._sendSignal({ type: 'channel_audio', payload: {} }).catch(() => {});
    }
    RTCStore.callAudioHandler = (chatId, msg) => {
      if (chatId !== this.contactId || !Array.isArray(msg.f)) return;
      for (const fr of msg.f.slice(0, 10)) if (typeof fr === 'string') CallAudio.play(fr);
    };
    this._audioBatch = [];
    this._audioSeq = 0;
    this._audioViaChannelCounted = false;
    this._audioSub = callAudioEmitter?.addListener('MalachiCallAudioFrame', ({ data }) => {
      if (!this.viaChannelAudio) return;
      this._audioBatch.push(data);
      if (this._audioBatch.length >= 3) {
        const f = this._audioBatch;
        this._audioBatch = [];
        // Direktverbindung: eigener, ungeordneter Sprachkanal ohne Neusenden
        // (WP3a, sofern die Gegenseite ihn kennt); sonst wie jede Nachricht.
        const how = RTCStore.sendCallAudio(this.contactId, { type: 'call_audio', s: this._audioSeq++, f });
        if (how === 'audio' && !this._audioViaChannelCounted) {
          this._audioViaChannelCounted = true;
          ConnectionStats.bump('channelAudio', 'viaAudioChannel');
        }
      }
    });
    try {
      await CallAudio.start();
    } catch (e) {
      console.warn('[Call] Sprache ueber den Kanal nicht startbar:', e?.message || e);
      this._stopChannelAudio();
      this.endCall('connection_lost');
      return false;
    }
    const viaTorNow = RTCStore.connections.get(this.contactId)?.transport === 'tor';
    console.log('[Call] ✅ Sprache laeuft ueber den Kanal (' + (viaTorNow ? 'Tor' : 'direkt') + ')');
    this._countCallPath(viaTorNow ? 'channelTor' : 'channelDirect');
    if (this.state !== CallState.ACTIVE) {
      this.callStartTime = Date.now();
      this._setState(CallState.ACTIVE);
      CallBridgeModule?.reportCallActive(this.contactId);
    } else {
      this.onStateChange(this.state);
    }
    return true;
  }

  _stopChannelAudio() {
    if (this._audioSub) { try { this._audioSub.remove(); } catch {} this._audioSub = null; }
    if (RTCStore.callAudioHandler) RTCStore.callAudioHandler = null;
    // stop() liefert die Diagnose-Zaehler des Anrufs (nur Zahlen, WP0).
    if (this.viaChannelAudio) {
      Promise.resolve(CallAudio?.stop()).then((st) => {
        if (!st || typeof st !== 'object') return;
        ConnectionStats.bump('channelAudio', 'frames', st.frames);
        ConnectionStats.bump('channelAudio', 'dropped', st.dropped);
        ConnectionStats.bump('channelAudio', 'underruns', st.underruns);
      }).catch(() => {});
    }
  }

  async _createPeerConnection() {
    // Wirft im Verbindungsweg "nur Tor" (TorOnlyModeError) - es entsteht dann
    // keine PeerConnection, auch nicht durch einen Wettlauf mit dem Wechsel.
    const pc = new RTCPeerConnection(await pcConfigForCalls());

    // Router-Portfreigabe (L1): nach dem Sammeln einmal den Router fragen,
    // erfolgreiche IPv4-Freigaben als zusaetzliche Kandidaten nachschicken.
    // Nie im Verbindungsweg "nur Tor" (dort entsteht ohnehin keine PC) und
    // nie mehr, sobald der Anruf auf den Kanal gewechselt hat.
    this._releasePortMapper();
    const mapper = new CallPortMapper((candidate) => {
      if (this.pc !== pc || this.channelOnly || this.viaChannelAudio) return;
      this._sendSignal({ type: 'ice', payload: { candidate } }).catch(e =>
        console.warn('[Call] Router-Kandidat konnte nicht gesendet werden:', e.message)
      );
    }, { isAllowed: async () => (await connectionModeForDecision()) !== MODE_TOR_ONLY });
    this._portMapper = mapper;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // _sendSignal() wirft jetzt statt unverschluesselt zu senden (H-2) -
        // hier bewusst nur loggen statt den ganzen Call abzubrechen, ein
        // einzelner verlorener ICE-Kandidat ist unkritisch (mehrere folgen).
        this._sendSignal({ type: 'ice', payload: { candidate: event.candidate } }).catch(e =>
          console.warn('[Call] ICE-Kandidat konnte nicht gesendet werden:', e.message)
        );
      }
      mapper.onCandidate(event?.candidate || null);
    };

    pc.ontrack = (event) => this.onRemoteStream(event.streams[0]);

    pc.oniceconnectionstatechange = () => {
      console.log('[Call] ICE State:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' && this.state !== CallState.ACTIVE) {
        clearTimeout(this.connectTimer);
        this._countCallPath('webrtc');
        this._setState(CallState.ACTIVE);
        this.callStartTime = Date.now();
        CallBridgeModule?.reportCallActive(this.contactId);
      }
      if (['failed', 'closed'].includes(pc.iceConnectionState)) {
        if (this.viaChannelAudio) return;
        if (pc.iceConnectionState === 'failed' && this._canUseChannelAudio()) {
          console.log('[Call] ICE fehlgeschlagen - wechsle auf Sprache ueber den Kanal');
          this._switchToChannelAudio(true);
          return;
        }
        console.log('[Call] ICE fehlgeschlagen, beende Call');
        this.endCall('connection_lost');
      }
      // Audit 2026-09-28 ("Anrufe brechen staendig ab"): 'disconnected' ist in
      // WebRTC ausdruecklich ein VORUEBERGEHENDER Zustand (kurzer Paketverlust,
      // Funkloch, WLAN->Mobilfunk-Uebergabe) und erholt sich oft von selbst
      // wieder zu 'connected'. Bisher wurde der Anruf hier sofort beendet -
      // jeder kurze Aussetzer war ein abgebrochenes Gespraech. Jetzt
      // Gnadenfrist (wie WebRTCManager.js fuer Chats), erst danach aufgeben.
      if (pc.iceConnectionState === 'disconnected') {
        clearTimeout(this._iceGraceTimer);
        this._iceGraceTimer = setTimeout(() => {
          if (this.pc === pc && ['disconnected', 'failed'].includes(pc.iceConnectionState)) {
            console.log('[Call] ICE nach Gnadenfrist weiter getrennt, beende Call');
            this.endCall('connection_lost');
          }
        }, ICE_DISCONNECT_GRACE_MS);
      }
    };

    return pc;
  }

  async _getLocalStream() {
    if (!this.localStream) {
      this.localStream = await mediaDevices.getUserMedia({
        audio: true,
        video: this.video ? { facingMode: 'user' } : false,
      });
    }
    return this.localStream;
  }

  // --- Ausgehender Anruf ---
  async startCall() {
    this.role = 'caller';
    // Verbindungsweg "nur Tor" (bei unlesbarer Einstellung ebenso): keine
    // WebRTC-Medien. Ein Videoanruf wird dann mit Hinweis abgelehnt, statt
    // still etwas anderes zu tun, als der Nutzer gewaehlt hat.
    this._torOnlyCall = (await connectionModeForDecision()) === MODE_TOR_ONLY;
    if (this._torOnlyCall && this.video) {
      console.log('[Call] Videoanruf im Verbindungsweg "nur Tor" abgelehnt');
      try { this.onNotice(torOnlyVideoNotice()); } catch {}
      this._forceCleanupToIdle();
      return;
    }
    this.channelOnly = this._torOnlyCall;
    // Mikrofon (und bei Video die Kamera) VOR dem Anruf erfragen - vorher brach
    // der Anruf ohne Berechtigung kommentarlos mit media_error ab (Live-Test
    // 2026-10-17: Mikrofon auf dem Pixel 7a nicht erteilt).
    if (!(await this._ensureCallPermissions())) {
      try { this.onNotice(micDeniedNotice()); } catch {}
      this._forceCleanupToIdle();
      return;
    }
    this._watchConnectionMode();
    RTCStore.setActiveCall(this.contactId);
    CallBridgeModule?.reportOutgoingCall(this.contactId, this.peerName);

    // Alles hier drin (v.a. getUserMedia) kann fehlschlagen - kein Mikrofon,
    // Berechtigung verweigert etc. Vorher blieb der CallScreen dann fuer immer
    // haengen: der State war noch IDLE, und endCall() bricht bei IDLE sofort
    // ab (kein Weg mehr raus, auch "Auflegen" tat nichts).
    try {
      // Ohne Server laufen Anruf-Signale nur ueber eine bestehende Verbindung.
      // Steht keine, zuerst ueber Tor verbinden ("Verbinde ueber Tor ...").
      let wasPreparing = false;
      if (!RTCStore.isConnected(this.contactId)) {
        wasPreparing = true;
        this._setState(CallState.PREPARING);
        const ok = await this._ensureConnection(CALL_CONNECT_VIA_TOR_TIMEOUT_MS);
        if (this.state !== CallState.PREPARING) return;   // inzwischen aufgelegt
        if (!ok) { this.endCall('unreachable'); return; }
      }

      let payload;
      if (this.channelOnly) {
        // Kein RTCPeerConnection, kein SDP, keine Kandidaten - nur die Bitte,
        // ueber den Kanal zu sprechen (siehe Kopfkommentar).
        payload = { channelOnly: true, video: false };
      } else {
        try {
          this.pc = await this._createPeerConnection();
          const stream = await this._getLocalStream();
          stream.getTracks().forEach((track) => this.pc.addTrack(track, stream));

          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          payload = { sdp: offer.sdp, video: this.video };
        } catch (e) {
          if (!this.channelOnly) throw e;
        }
        // Waehrend des Aufbaus auf "nur Tor" gewechselt (siehe
        // _onConnectionModeChange): die gerade entstandene PeerConnection
        // verwerfen, bevor irgendein Angebot oder Kandidat das Geraet verlaesst.
        if (this.channelOnly) {
          this._closePeerConnection();
          if (this.video) {
            this.video = false;
            this.remoteVideo = false;
            try { this.onVideoStateChange(false, false); } catch {}
            try { this.onNotice(torOnlyVideoAsVoiceNotice()); } catch {}
          }
          payload = { channelOnly: true, video: false };
        }
      }

      // Waehrend der Vorbereitung aufgelegt? (ENDED, nach 500 ms IDLE.) Bei
      // bestehender Verbindung steht der Zustand hier noch regulaer auf IDLE -
      // vorher brach genau dieser Fall faelschlich ab: ein Anruf zu einem
      // bereits verbundenen Kontakt klingelte nie.
      if (this.state === CallState.ENDED || (wasPreparing && this.state === CallState.IDLE)) {
        this._closePeerConnection();
        return;
      }
      this._setState(CallState.OUTGOING_RINGING);
      const sent = await this._sendSignal({ type: 'offer', payload });
      if (!sent) {
        if (this.state === CallState.OUTGOING_RINGING) this.endCall('unreachable');
        return;
      }

      this.ringTimer = setTimeout(() => {
        if (this.state === CallState.OUTGOING_RINGING) {
          this._sendSignal({ type: 'cancel', payload: {} }).catch(e =>
            console.warn('[Call] Cancel-Signal konnte nicht gesendet werden:', e.message)
          );
          this._reportMissed('outgoing_unanswered');
          this.endCall('timeout');
        }
      }, CALL_TIMEOUT_MS);
    } catch (e) {
      if (e?.name === 'TorOnlyModeError') {
        // Wettlauf mit dem Wechsel auf "nur Tor" - keine PeerConnection entstanden.
        console.log('[Call] Verbindungsweg "nur Tor" waehrend des Anrufaufbaus - abgebrochen');
        try { this.onNotice(this._noticeForEnd('tor_only_switch')); } catch {}
      } else {
        console.error('[Call] startCall fehlgeschlagen (Mikrofon/Verbindung):', e);
        this._reportMissed('media_error');
      }
      this._forceCleanupToIdle();
    }
  }

  // Wird aufgerufen, sobald irgendwo (App-weiter Kontakt-Poll oder nach FCM-Wake)
  // ein wartendes 'offer' für diesen contactId gefunden wurde.
  async handleIncomingOffer(signal) {
    this.role = 'callee';
    const sdp = signal.payload?.sdp;
    this._incomingOffer = typeof sdp === 'string' && sdp.length > 0 ? sdp : null;
    // Anrufer im Verbindungsweg "nur Tor" (oder Angebot ohne SDP): nur
    // Sprache ueber den Kanal - es gibt nichts, womit WebRTC starten koennte.
    this._peerChannelOnly = signal.payload?.channelOnly === true || !this._incomingOffer;
    // Symmetrisch zum Anrufer (siehe Konstruktor-Kommentar) - ob dieser Anruf
    // Video ist, entscheidet ausschliesslich der Anrufer per Offer-Flag; das
    // ist zu diesem Zeitpunkt auch der (einzig bekannte) Video-Zustand DER
    // GEGENSEITE - wird spaeter durch echte 'renegotiate'-Signale ersetzt,
    // falls die Gegenseite ihr Video waehrend des Gespraechs umschaltet.
    this.video = !!signal.payload?.video && !this._peerChannelOnly;
    this.remoteVideo = this.video;
    this._watchConnectionMode();
    this._setState(CallState.INCOMING_RINGING);
    // Weitere Signale des Anrufers (ICE) kommen ueber die Verbindung zum
    // Kontakt an (RTCStore -> App.tsx -> handleSignal).

    // Das hier hat vorher gefehlt: ohne diesen Aufruf gibt's nie eine System-
    // Notification/CallStyle-UI, nur den In-App-CallScreen.
    CallBridgeModule?.reportIncomingCall(this.contactId, this.peerName);

    this.ringTimer = setTimeout(() => {
      if (this.state === CallState.INCOMING_RINGING) {
        this._reportMissed('incoming_unanswered');
        this.endCall('timeout');
      }
    }, CALL_TIMEOUT_MS);
  }

  // --- Eingehendes Signal (ueber die Verbindung zum Kontakt) ---
  // Strikt nacheinander, siehe this._signalChain im Konstruktor.
  handleSignal(signal) {
    const run = this._signalChain.then(() => this._handleSignalNow(signal));
    this._signalChain = run.catch(() => {});
    return run;
  }

  async _handleSignalNow(signal) {
    // Verschlüsseltes payload (siehe _sendSignal) wieder entschlüsseln, bevor
    // irgendeine weitere Verarbeitung (auch handleIncomingOffer) darauf zugreift.
    // _sendSignal() verschickt inzwischen NIE mehr unverschluesselt (H-2) - ein
    // Signal ohne .enc ist also entweder von einem veralteten Client oder
    // (Sicherheitsreview) ein per Downgrade untergeschobenes gefaelschtes
    // Klartext-Signal. Beides wird verworfen statt blind vertraut.
    if (!signal.payload?.enc) {
      console.warn('[Call] Unverschlüsseltes Signal verworfen (kein .enc):', signal.type);
      return;
    }
    const secret = await this._getSharedSecret();
    if (secret) {
      // purpose 'call-signal' - eigener Unterschluessel, getrennt von normaler
      // Nachrichtenverschluesselung (Sicherheitsreview Review 2, Domain-
      // Separation). Muss mit _sendSignal() unten und web/CallManager.ts identisch sein.
      // Audit 2026-09-28: zusaetzlich das vorherige Secret probieren, falls der
      // letzte Schluesselwechsel noch nicht bestaetigt ist (RTCStore.
      // getSecretCandidates) - sonst scheitert jeder Anruf, solange die
      // Chat-Verbindung wegen genau dieses Desyncs nicht wieder zustande kommt.
      let decrypted = decryptMsg(signal.payload.enc, secret, 'call-signal');
      if (!decrypted) {
        for (const alt of RTCStore.getSecretCandidates(this.contactId)) {
          if (alt === secret) continue;
          decrypted = decryptMsg(signal.payload.enc, alt, 'call-signal');
          if (decrypted) break;
        }
      }
      if (decrypted) {
        signal = { ...signal, payload: JSON.parse(decrypted) };
      } else {
        console.warn('[Call] Signal konnte nicht entschlüsselt werden, verwerfe:', signal.type);
        return;
      }
    } else {
      console.warn('[Call] Kein Shared Secret zum Entschlüsseln, verwerfe Signal:', signal.type);
      return;
    }

    switch (signal.type) {
      case 'offer':
        // Normalfall: schon über handleIncomingOffer() reingekommen. Falls nicht
        // (z.B. Direktanbindung an einen generischen Kontakt-Poll), hier abfangen:
        if (this.state === CallState.IDLE) await this.handleIncomingOffer(signal);
        break;

      case 'answer':
        // Wächter: eine zweite oder verspätete "answer" (z.B. weil die Gegenseite
        // aus irgendeinem Grund zweimal angenommen hat) wird ignoriert, statt
        // setRemoteDescription ein zweites Mal aufzurufen - genau das hat den
        // "wrong state: stable"-Fehler verursacht.
        if (this.state !== CallState.OUTGOING_RINGING) break;
        clearTimeout(this.ringTimer);
        if (signal.payload?.channelOnly === true || this.channelOnly || !this.pc) {
          // Gegenseite (oder wir) im Verbindungsweg "nur Tor": keine WebRTC-
          // Medien, Sprache ueber den Kanal. Kam trotzdem ein SDP (die
          // Gegenseite erwartet WebRTC), sagen wir ihr, dass es ueber den
          // Kanal weitergeht ('channel_audio').
          this._setState(CallState.CONNECTING);
          if (!this._connectStartedAt) this._connectStartedAt = Date.now();
          const informPeer = signal.payload?.channelOnly !== true;
          const ok = await this._switchToChannelAudio(informPeer);
          if (!ok && this.state === CallState.CONNECTING) this.endCall(this._torOnlyCall ? 'tor_only_switch' : 'connection_lost');
          break;
        }
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.payload.sdp });
        await this._flushPendingIceCandidates();
        this._setState(CallState.CONNECTING);
        this._startConnectTimeout();
        break;

      case 'ice':
        // Nur Sprache ueber den Kanal: Kandidaten der Gegenseite sind wertlos.
        if (this.channelOnly) break;
        // War der eigentliche Kern des Bugs (Live-Test entdeckt): auf der
        // Angerufenen-Seite existiert this.pc waehrend des Klingelns noch gar
        // nicht (wird erst in acceptCall() erzeugt) - der Anrufer verschickt
        // seine Kandidaten aber sofort per Trickle-ICE, lange bevor die
        // Gegenseite ueberhaupt annimmt. Die alte Bedingung "if (this.pc && ...)"
        // verwarf jeden waehrend des Klingelns eintreffenden Kandidaten
        // komplett, statt ihn wie unten fuer den anderen Fall (pc existiert,
        // remoteDescription fehlt noch) zwischenzuspeichern - blieb dadurch in
        // der Praxis fast immer leer.
        if (signal.payload?.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            try {
              await this.pc.addIceCandidate(signal.payload.candidate);
            } catch (e) {
              console.warn('[Call] ICE-Kandidat fehlgeschlagen:', e.message);
            }
          } else {
            this._pendingIceCandidates.push(signal.payload.candidate);
          }
        }
        break;

      // Nutzerwunsch: waehrend eines laufenden Anrufs zwischen Audio und Video
      // wechseln koennen (nicht nur beim Start festlegen). WebRTC braucht dafuer
      // nach addTrack()/removeTrack() eine frische Offer/Answer-Runde (SDP-
      // Renegotiation) - eigene Signaltypen statt des regulaeren initialen
      // offer/answer-Paars oben, weil die Verbindung dabei bereits ACTIVE ist
      // und pc.setLocalDescription()/-RemoteDescription() hier kein "stable"-
      // vs-"have-local-offer"-Zustandskonflikt mit dem Verbindungsaufbau werden
      // darf. Bewusst keine volle "perfect negotiation" mit Rollback - ein
      // beidseitig fast gleichzeitiges Umschalten ist ein seltener, niedrig-
      // riskanter Sonderfall fuer diesen manuell ausgeloesten Knopf.
      case 'renegotiate':
        if (this.state !== CallState.ACTIVE || !this.pc) break;
        try {
          await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.payload.sdp });
          const reAnswer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(reAnswer);
          await this._sendSignal({ type: 'renegotiate-answer', payload: { sdp: reAnswer.sdp } });
          this.remoteVideo = !!signal.payload.video;
          this.onVideoStateChange?.(this.video, this.remoteVideo);
        } catch (e) {
          console.warn('[Call] Renegotiation (Offer) fehlgeschlagen:', e.message);
        }
        break;

      case 'renegotiate-answer':
        if (this.state !== CallState.ACTIVE || !this.pc) break;
        try {
          await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.payload.sdp });
        } catch (e) {
          console.warn('[Call] Renegotiation (Answer) fehlgeschlagen:', e.message);
        }
        break;

      case 'channel_audio':
        if (!this.viaChannelAudio && (this.state === CallState.CONNECTING || this.state === CallState.ACTIVE)) {
          await this._switchToChannelAudio(false);
        }
        break;

      case 'reject':
        this._reportMissed('rejected_by_peer');
        // Gegenseite telefoniert gerade (z.B. Gruppenanruf, siehe
        // rejectIncomingCallBusy unten) - sagen, statt kommentarlos zu enden.
        if (signal.payload?.busy === true && this.role === 'caller') {
          try { this.onNotice(this.peerName + ' telefoniert gerade (besetzt).'); } catch {}
        }
        this.endCall('rejected');
        break;

      case 'cancel':
        this._reportMissed('cancelled_by_peer');
        this.endCall('cancelled');
        break;

      case 'end':
        this.endCall('remote_hangup');
        break;
    }
  }

  // --- Eingehenden Anruf annehmen / ablehnen ---
  // fromNative=true bedeutet: kam schon von der System-UI (Notification-Button,
  // Bluetooth-Taste) - native weiß es dann bereits, wir müssen es nicht nochmal sagen.
  async acceptCall(fromNative = false) {
    // Schutz gegen doppeltes Annehmen (z.B. In-App-Tap UND natives Event fast
    // gleichzeitig) - Zustand wird SOFORT gesetzt, bevor irgendein await läuft,
    // damit ein zweiter Aufruf hier sofort abbricht statt eine zweite Antwort
    // zu verschicken (das hat vorher "wrong state: stable" verursacht).
    if (this.state !== CallState.INCOMING_RINGING) return;
    this._setState(CallState.CONNECTING);
    clearTimeout(this.ringTimer);
    // Ueber die System-Benachrichtigung bzw. Headset-Taste angenommen: dort
    // ist nicht zu sehen, dass es ein Videoanruf ist (Audit 2026-10-19) -
    // deshalb OHNE eigene Kamera annehmen. Das Bild der Gegenseite kommt
    // trotzdem an; die eigene Kamera schaltet der Nutzer in der App ein.
    if (fromNative && this.video) {
      this.video = false;
      try { this.onVideoStateChange?.(this.video, this.remoteVideo); } catch {}
    }

    // Verbindungsweg "nur Tor" (hier oder beim Anrufer): ohne eigene
    // PeerConnection annehmen - keine Kandidaten, keine IP-Adresse.
    const torOnlyHere = (await connectionModeForDecision()) === MODE_TOR_ONLY;
    if (this.state !== CallState.CONNECTING) return;   // inzwischen beendet
    if (!(await this._ensureCallPermissions())) {
      this._reportMissed('mic_denied');
      this.endCall('mic_denied', fromNative);
      return;
    }
    if (this.state !== CallState.CONNECTING) return;
    if (torOnlyHere) this._torOnlyCall = true;
    // Laeuft die Verbindung zum Anrufer gerade ueber Tor, klappt WebRTC-Medien
    // ohnehin nicht - direkt per Kanal annehmen. Vorher lief beides parallel:
    // der sofortige Kanal-Wechsel schloss die PeerConnection, waehrend das
    // Annehmen ihr noch das Mikrofon hinzufuegen wollte (TypeError addTrack of
    // null) - und das beendete den eigentlich laufenden Anruf.
    if (torOnlyHere || this._peerChannelOnly || this._viaTor()) {
      await this._acceptViaChannel(fromNative);
      return;
    }
    this._startConnectTimeout();

    try {
      this.pc = await this._createPeerConnection();
      const stream = await this._getLocalStream();
      if (this.viaChannelAudio || !this.pc) return;   // Kanal hat inzwischen uebernommen
      stream.getTracks().forEach((track) => this.pc.addTrack(track, stream));

      await this.pc.setRemoteDescription({ type: 'offer', sdp: this._incomingOffer });
      await this._flushPendingIceCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      if (this.viaChannelAudio || !this.pc) return;

      const sent = await this._sendSignal({ type: 'answer', payload: { sdp: answer.sdp } });
      if (!sent) {
        // Verbindung zum Anrufer weg und auch ueber Tor nicht wieder da.
        this.endCall('unreachable', fromNative);
        return;
      }
      if (!fromNative) CallBridgeModule?.reportCallActive(this.contactId);
    } catch (e) {
      if (e?.name === 'TorOnlyModeError') {
        // Wettlauf mit dem Wechsel auf "nur Tor": dann eben ueber den Kanal.
        this._torOnlyCall = true;
        await this._acceptViaChannel(fromNative);
        return;
      }
      // Hat der Sprachkanal inzwischen uebernommen, ist der Fehler der
      // abgebauten PeerConnection kein Grund, den Anruf zu beenden.
      if (this.viaChannelAudio) return;
      console.error('[Call] acceptCall fehlgeschlagen (Mikrofon/Verbindung):', e);
      this._reportMissed('media_error');
      this.endCall('media_error', fromNative);
    }
  }

  // Annehmen ohne WebRTC: Antwort ohne SDP (channelOnly), dann sofort Sprache
  // ueber den Kanal. Ein Videoanruf laeuft dabei als Sprachanruf (mit Hinweis).
  async _acceptViaChannel(fromNative) {
    this.channelOnly = true;
    if (!this._connectStartedAt) this._connectStartedAt = Date.now();
    clearTimeout(this.connectTimer);
    clearTimeout(this._channelAudioTimer);
    this.connectTimer = setTimeout(() => {
      if (this.state === CallState.CONNECTING && !this.viaChannelAudio) this.endCall('connect_timeout');
    }, CONNECT_TIMEOUT_MS);
    let sent = false;
    try {
      sent = await this._sendSignal({ type: 'answer', payload: { channelOnly: true } });
    } catch (e) {
      console.warn('[Call] Antwort (Kanal) nicht sendbar:', e?.message || e);
    }
    if (this.state !== CallState.CONNECTING) return;
    if (!sent) { this.endCall('unreachable', fromNative); return; }
    const ok = await this._switchToChannelAudio(false);
    if (!ok && this.state === CallState.CONNECTING) {
      this.endCall(this._torOnlyCall ? 'tor_only_switch' : 'connection_lost', fromNative);
    }
  }

  rejectCall(fromNative = false) {
    if (this.state !== CallState.INCOMING_RINGING) return;
    clearTimeout(this.ringTimer);
    this._sendTerminalSignal('reject');
    this._reportMissed('rejected_locally');
    this.endCall('rejected', fromNative);
  }

  // Mikrofon ist Pflicht; Kamera nur bei Video - fehlt sie, laeuft der Anruf
  // als Sprachanruf weiter (mit Hinweis). false = kein Mikrofon, Anruf geht nicht.
  async _ensureCallPermissions() {
    if (Platform.OS !== 'android' || !PermissionsAndroid?.request) return true;
    try {
      const mic = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
      if (!(await PermissionsAndroid.check(mic))) {
        const r = await PermissionsAndroid.request(mic, {
          title: t('common.microphone'), message: t('call.perm.mic'), buttonPositive: 'OK',
        });
        if (r !== PermissionsAndroid.RESULTS.GRANTED) return false;   // Hinweis zeigt der Aufrufer
      }
      if (this.video) {
        const cam = PermissionsAndroid.PERMISSIONS.CAMERA;
        if (!(await PermissionsAndroid.check(cam))) {
          const r = await PermissionsAndroid.request(cam, {
            title: t('common.camera'), message: t('call.perm.camera'), buttonPositive: 'OK',
          });
          if (r !== PermissionsAndroid.RESULTS.GRANTED) {
            this.video = false;
            try { this.onVideoStateChange(false, this.remoteVideo); } catch {}
            try { this.onNotice(t('call.notice.noCamera')); } catch {}
          }
        }
      }
      return true;
    } catch (e) {
      console.warn('[Call] Berechtigungsabfrage fehlgeschlagen:', e?.message || e);
      return true;   // im Zweifel versuchen; getUserMedia meldet echte Fehler
    }
  }

  _viaTor() {
    return RTCStore.connections.get(this.contactId)?.transport === 'tor';
  }

  // Abbruchgruende, die der Nutzer erfahren soll (nicht: selbst aufgelegt,
  // Gegenseite hat aufgelegt/abgelehnt - das ist offensichtlich).
  _noticeForEnd(reason) {
    const tor = this._viaTor() ? ' ' + t('call.end.viaTor') : '';
    const name = this.peerName;
    switch (reason) {
      case 'connect_timeout': return t('call.end.connectTimeout', { name }) + tor;
      case 'connection_lost': return t('call.end.connectionLost', { name }) + tor;
      case 'media_error': return t('call.end.mediaError');
      case 'mic_denied': return micDeniedNotice();
      case 'unreachable': return t('call.end.unreachable', { name });
      case 'tor_only_switch': return t('call.end.torOnlySwitch', { name });
      case 'timeout': return this.role === 'caller' ? t('call.end.noAnswer', { name }) : null;
      default: return null;
    }
  }

  endCall(reason = 'user_hangup', fromNative = false) {
    // Schutz gegen doppelten Aufruf (z.B. wenn sowohl ein Signal der
    // Gegenseite als auch ein natives Event fast gleichzeitig "Ende" melden).
    if (this.state === CallState.ENDED || this.state === CallState.IDLE) return;
    const notice = this._noticeForEnd(reason);
    if (notice) { try { this.onNotice(notice); } catch {} }
    // Diagnose: technische Abbruchgruende zaehlen (nicht Auflegen/Ablehnen).
    const endKind = { connection_lost: 'endConnectionLost', connect_timeout: 'endConnectTimeout',
      unreachable: 'endUnreachable', media_error: 'endMediaError' }[reason];
    if (endKind) ConnectionStats.bump('calls', endKind);
    this._releasePortMapper();
    clearTimeout(this.ringTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this._iceGraceTimer);
    clearTimeout(this._channelAudioTimer);
    this._stopChannelAudio();
    this._unsubscribeNativeEvents();
    this._unwatchConnectionMode();

    // Die Gegenseite MUSS in jedem nicht-beendeten Zustand informiert werden -
    // vorher wurde das nur bei ACTIVE/CONNECTING gemacht. Bug: legt der Anrufer
    // auf, während es bei der Gegenseite noch klingelt (OUTGOING_RINGING), kam
    // nie ein Signal an - die Gegenseite klingelte ewig weiter bzw. blieb beim
    // späteren Annehmen für immer bei "Verbinde..." hängen.
    // (PREPARING: es wurde noch nichts gesendet; 'unreachable': es gibt
    // keinen Weg zur Gegenseite - in beiden Faellen nichts zu melden.)
    if (this.state === CallState.PREPARING || reason === 'unreachable') {
      // nichts senden
    } else if (this.state === CallState.OUTGOING_RINGING) {
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
    if (!fromNative) CallBridgeModule?.reportCallEnded(this.contactId);
    this._resetSpeaker();
    this._setState(CallState.ENDED);
    setTimeout(() => this._setState(CallState.IDLE), 500);
  }

  // Fuer Fehler, die auftreten BEVOR der State ueberhaupt von IDLE weg ist
  // (z.B. getUserMedia schlaegt in startCall() sofort fehl) - endCall() selbst
  // greift hier nicht, weil sein eigener Schutz vor Doppelaufrufen genau bei
  // IDLE abbricht. Raeumt dieselben Ressourcen auf, ohne diesen Schutz zu
  // verletzen, und bringt die UI garantiert aus dem CallScreen wieder raus.
  _forceCleanupToIdle() {
    clearTimeout(this.ringTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this._iceGraceTimer);
    clearTimeout(this._channelAudioTimer);
    this._stopChannelAudio();
    this._unwatchConnectionMode();
    this._releasePortMapper();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this._resetSpeaker();
    this._setState(CallState.ENDED);
    setTimeout(() => this._setState(CallState.IDLE), 500);
  }

  toggleMute(muted) {
    if (this.viaChannelAudio) CallAudio?.setMuted(!!muted);
    if (this.localStream) this.localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  // Lautsprecher an/aus (CallAudioRoute.js). Rueckgabe: umgeschaltet?
  async setSpeaker(on) {
    if (this.state === CallState.ENDED || this.state === CallState.IDLE) return false;
    const ok = await setCallSpeaker(!!on);
    if (ok) this.speaker = !!on;
    return ok;
  }

  // Beim Ende: ohne Telecom bliebe der Lautsprecher sonst fuer andere Apps an
  // (mit Telecom setzt das System den Ausgang ohnehin zurueck).
  _resetSpeaker() {
    if (!this.speaker) return;
    this.speaker = false;
    setCallSpeaker(false).catch(() => {});
  }

  // Nutzerwunsch: zwischen Audio- und Videoanruf wechseln koennen, waehrend
  // das Gespraech bereits laeuft (nicht nur beim Start waehlbar). Nur waehrend
  // ACTIVE sinnvoll - vor der Verbindung entscheidet startCall()/acceptCall()
  // ueber den Startzustand, danach ist toggleVideo() der einzige Weg.
  async toggleVideo() {
    // Ueber den Kanal nur Sprache (Video waere ueber Tor nicht sinnvoll).
    if (this.viaChannelAudio || this.channelOnly) {
      this.onNotice(this._torOnlyCall
        ? t('call.video.torOnly')
        : this._viaTor()
          ? t('call.video.viaTor')
          : t('call.video.channelOnly'));
      return;
    }
    if (this.state !== CallState.ACTIVE || !this.pc) return;
    if (this.video) {
      // Video ausschalten: Track aus der Verbindung UND aus dem lokalen
      // Stream entfernen (nicht nur .enabled=false - sonst wuerde weiterhin
      // ein - wenn auch schwarzes - Videobild an die Gegenseite gesendet,
      // und die Kamera-Hardware bliebe aktiv).
      const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        try { this.pc.removeTrack(sender); } catch (e) { console.warn('[Call] removeTrack fehlgeschlagen:', e.message); }
      }
      this.localStream?.getVideoTracks().forEach((t) => {
        t.stop();
        this.localStream.removeTrack(t);
      });
      this.video = false;
    } else {
      try {
        const videoStream = await mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } });
        const videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) return;
        if (!this.localStream) this.localStream = videoStream;
        else this.localStream.addTrack(videoTrack);
        this.pc.addTrack(videoTrack, this.localStream);
        this.video = true;
      } catch (e) {
        console.error('[Call] Video konnte nicht aktiviert werden (Kamera/Berechtigung):', e?.message || e);
        return;
      }
    }
    this.onVideoStateChange?.(this.video, this.remoteVideo);
    await this._renegotiate();
  }

  async _renegotiate() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this._sendSignal({ type: 'renegotiate', payload: { sdp: offer.sdp, video: this.video } });
    } catch (e) {
      console.error('[Call] Renegotiation fehlgeschlagen:', e?.message || e);
    }
  }

  getDuration() {
    return this.callStartTime ? Math.floor((Date.now() - this.callStartTime) / 1000) : 0;
  }

  // --- Signalisierung ueber die Verbindung zum Kontakt (direkt oder Tor) ---
  // payload (SDP/ICE-Daten) wird zusaetzlich zur Kanal-Verschluesselung mit
  // einem eigenen Unterschluessel ('call-signal') Ende-zu-Ende verschluesselt
  // (Sicherheitsreview: niemand darf den DTLS-Fingerprint im SDP austauschen
  // koennen). Ein Server ist an keiner Stelle beteiligt.
  async _getSharedSecret() {
    let secret = RTCStore.getSharedSecret(this.contactId);
    if (secret) return secret;
    try {
      const ES = (await import('react-native-encrypted-storage')).default;
      secret = await ES.getItem('shared_secret_' + this.contactId);
    } catch {}
    return secret || null;
  }

  // Steht keine Verbindung, eine ueber Tor aufbauen (BackgroundSync.
  // ensureConnection, ueber RTCStore entkoppelt). true = Verbindung steht.
  async _ensureConnection(timeoutMs = CALL_CONNECT_VIA_TOR_TIMEOUT_MS) {
    if (RTCStore.isConnected(this.contactId)) return true;
    const ensure = RTCStore.connectionEnsurer;
    if (typeof ensure !== 'function') return false;
    console.log('[Call] Keine Verbindung zu', this.peerName, '- verbinde ueber Tor');
    try {
      const rtc = await ensure(this.contactId, { timeoutMs });
      return !!rtc && RTCStore.isConnected(this.contactId);
    } catch {
      return false;
    }
  }

  // Live-Test-Fund 2026-09-28 (Nutzer-Bericht: "Ablehnen kommt nicht sofort
  // an", Nutzerwunsch "gegenseitigen Mechanismus einbauen"): reject/cancel/end
  // sind die einzigen Anruf-Signale OHNE jede natuerliche Wiederholung - ein
  // verlorenes 'offer'/'answer'/'ice' wird durch den laufenden Klingel-/
  // Trickle-ICE-Zyklus ohnehin implizit "nachgebessert", ein verlorenes
  // Beendigungssignal dagegen gar nicht (die Gegenseite haette bis zu ihrem
  // eigenen 30s-Timeout keine Chance, davon zu erfahren). Deshalb hier eine
  // kleine, unabhaengige Wiederholung mit kurzer Pause - laeuft bewusst im
  // Hintergrund weiter, auch nachdem endCall() synchron bereits pc/Stream
  // aufgeraeumt hat (braucht nur contactId/Shared-Secret, beide bleiben danach
  // gueltig). Ist die Verbindung gerade weg, baut erst der letzte Versuch
  // (kurz) eine ueber Tor auf.
  async _sendTerminalSignal(type) {
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      const last = i === attempts - 1;
      try {
        const ok = await this._sendSignal({ type, payload: {} }, { connect: last, connectTimeoutMs: TERMINAL_SIGNAL_CONNECT_TIMEOUT_MS });
        if (ok) return true;
      } catch (e) {
        if (last) {
          console.warn(`[Call] ${type}-Signal konnte auch nach ${attempts} Versuchen nicht gesendet werden:`, e.message);
        }
      }
      if (!last) await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  // Liefert true, wenn das Signal an eine Verbindung uebergeben wurde.
  // connect: steht keine Verbindung, zuerst eine ueber Tor aufbauen (Standard
  // fuer Angebot/Antwort; ICE-Kandidaten und Umschaltsignale nicht - die sind
  // ohne laufende Verbindung ohnehin wertlos).
  async _sendSignal({ type, payload }, { connect = SIGNALS_WORTH_CONNECTING.has(type), connectTimeoutMs = CALL_CONNECT_VIA_TOR_TIMEOUT_MS } = {}) {
    console.log('[Call] Sende Signal:', type);
    const secret = await this._getSharedSecret();
    if (!secret) {
      // Faellt geschlossen aus (Sicherheitsreview H-2) statt unverschluesselt
      // zu senden: ein fehlendes Secret hiesse, dass etwas grundlegend kaputt
      // ist - ein Anruf OHNE Verschluesselung waere schlimmer als gar keiner.
      console.error('[Call] Kein Shared Secret gefunden - Signal wird NICHT unverschlüsselt gesendet:', type);
      throw new Error('Kein sicherer Kanal zu diesem Kontakt - Anruf abgebrochen.');
    }
    const encPayload = await encryptMsg(JSON.stringify(payload || {}), secret, 'call-signal');
    const raw = JSON.stringify({ type: 'system', subtype: 'call_signal', signal: { type, payload: { enc: encPayload } } });
    const trySend = () => {
      if (!RTCStore.isConnected(this.contactId)) return false;
      const r = RTCStore.sendMessage(this.contactId, raw);
      // 'queued': Schluesseltausch der Verbindung laeuft noch, geht direkt
      // danach raus (WebRTCManager._flushPending).
      return r === 'sent' || r === 'queued';
    };
    if (trySend()) return true;
    if (!connect) return false;
    if (!(await this._ensureConnection(connectTimeoutMs))) return false;
    return trySend();
  }

  // TODO: an eure Chat-UI/State anbinden, damit eine "📞 Verpasster Anruf"-Zeile
  // im Chatverlauf erscheint (kann eine ganz normale lokale System-Message sein,
  // muss nicht zwingend durch RTCStore laufen).
  _reportMissed(reason) {
    this.onMissedCall({ contactId: this.contactId, timestamp: Date.now(), reason });
  }
}

// Besetzt (GroupCallManager.js: ein Gruppenanruf laeuft): eingehendes Angebot
// sofort ablehnen - ohne CallManager-Instanz, ohne Klingeln. Gleiches Format
// wie _sendSignal ('call-signal'-Unterschluessel), mit Kennzeichen busy.
export async function rejectIncomingCallBusy(contactId) {
  let secret = RTCStore.getSharedSecret(contactId);
  if (!secret) {
    try {
      const ES = (await import('react-native-encrypted-storage')).default;
      secret = await ES.getItem('shared_secret_' + contactId);
    } catch {}
  }
  if (!secret || !RTCStore.isConnected(contactId)) return false;
  const enc = await encryptMsg(JSON.stringify({ busy: true }), secret, 'call-signal');
  if (!enc) return false;
  const r = RTCStore.sendMessage(contactId, JSON.stringify({ type: 'system', subtype: 'call_signal', signal: { type: 'reject', payload: { enc } } }));
  return r === 'sent' || r === 'queued';
}
