// Malachi Web - RTCStore.ts
// Vereinfachtes Gegenstueck zu RTCStore.js: haelt aktive WebRTCManager-
// Verbindungen und Shared Secrets pro Kontakt, aussehalb von React, damit
// kein Props-Drilling noetig ist. Bild-/Audio-Chunk-Puffer folgen, sobald
// Bilder/Sprachnachrichten fuer Web dran sind (Text zuerst).
import type { WebRTCManager } from './WebRTCManager';
import { flushQueue } from './Queue';

class RTCStore {
  connections = new Map<string, WebRTCManager>();
  listeners = new Map<string, (msg: any) => void>();
  buffer = new Map<string, any[]>();
  // Von App.tsx gesetzt - siehe setConnection().
  controlSignalHandler: ((chatId: string, msg: any) => void) | null = null;
  sharedSecrets = new Map<string, string>();
  // Audit 2026-09-28 - siehe ausfuehrliche Begruendung in RTCStore.js (nativ,
  // rememberPreviousSecret): vorheriges Secret bis zur Bestaetigung des
  // Schluesselwechsels durch die Gegenseite als Rueckfall-Kandidat.
  previousSecrets = new Map<string, string>();

  rememberPreviousSecret(chatId: string, previous: string | null | undefined, next: string | null): boolean {
    if (!chatId || !previous || previous === next) return false;
    this.previousSecrets.set(chatId, previous);
    return true;
  }

  confirmCurrentSecret(chatId: string): boolean {
    return this.previousSecrets.delete(chatId);
  }

  getSecretCandidates(chatId: string): string[] {
    const out: string[] = [];
    const cur = this.sharedSecrets.get(chatId);
    const prev = this.previousSecrets.get(chatId);
    if (cur) out.push(cur);
    if (prev && prev !== cur) out.push(prev);
    return out;
  }

  setConnection(chatId: string, rtc: WebRTCManager) {
    // Siehe RTCStore.js (nativ) fuer die Begruendung (State-Machine-Review,
    // Fund 8) - alte Verbindung aktiv schliessen statt sie nur zu ueberschreiben.
    const existing = this.connections.get(chatId);
    if (existing && existing !== rtc) {
      // Siehe identischer Fund/Fix in RTCStore.js (nativ): pendingMsgs der
      // sterbenden Instanz vor dem Schliessen uebernehmen, sonst geht eine
      // Nachricht, die genau im Sendezeitfenster hing, beim Instanzwechsel
      // (normaler Reconnect-Weg) endgueltig verloren.
      if (existing.pendingMsgs?.length) {
        rtc.pendingMsgs = [...(rtc.pendingMsgs || []), ...existing.pendingMsgs];
      }
      try { existing.close(); } catch {}
    }
    this.connections.set(chatId, rtc);
    rtc.chatId = chatId;
    // Loest die lokale Sende-Warteschlange (Queue.ts) aus, sobald der
    // Schluesselaustausch abgeschlossen ist - fehlte bisher komplett im
    // Web-Client (siehe ZERO_KNOWLEDGE_RELAY_PLAN.md Fund 1a). Nur setzen,
    // wenn noch kein Callback vorhanden ist - App.tsx koennte theoretisch
    // eigene Logik vorschalten wollen, dann hat die Vorrang.
    if (!rtc._onKeyExchange) rtc._onKeyExchange = () => flushQueue(chatId, rtc);
    rtc.onMessage = (msg: any) => {
      // Siehe identischer Fund/Fix in RTCStore.js (nativ, "H2"): Bestaetigung
      // zentral und unbedingt senden, nicht nur wenn der Chat gerade offen
      // ist - sonst deutet der native Absender eine ausbleibende Bestaetigung
      // faelschlich als "nicht zugestellt" und schickt erneut.
      // Best effort: ein Fehler beim Senden der Bestaetigung (Kanal gerade
      // geschlossen) darf die Zustellung der empfangenen Nachricht unten
      // nicht abbrechen.
      if (msg.type === 'text' && msg.msgId && typeof rtc.sendMessage === 'function') {
        try { rtc.sendMessage(JSON.stringify({ type: 'receipt', msgId: msg.msgId, status: 'delivered' })); } catch {}
      }
      // Nur-P2P-Umstellung 2026-09-29: "Chat geloescht"/"Geraet
      // zurueckgesetzt" kamen im Web bisher nur ueber den Relay-Pfad
      // (checkOfflinePackets) an - jetzt kommen sie per P2P und werden hier
      // zentral verarbeitet, unabhaengig davon, ob der Chat offen ist.
      if (msg.type === 'system' && (msg.subtype === 'delete_chat' || msg.subtype === 'device_wiped')
          && this.controlSignalHandler) {
        try { this.controlSignalHandler(chatId, msg); } catch {}
        return;
      }
      const cb = this.listeners.get(chatId);
      if (cb) {
        cb(msg);
      } else {
        if (!this.buffer.has(chatId)) this.buffer.set(chatId, []);
        this.buffer.get(chatId)!.push(msg);
      }
    };
  }

  getConnection(chatId: string) {
    return this.connections.get(chatId);
  }

  setMessageListener(chatId: string, callback: ((msg: any) => void) | null) {
    if (callback === null) {
      this.listeners.delete(chatId);
      return;
    }
    this.listeners.set(chatId, callback);
  }

  sendMessage(chatId: string, text: string): 'sent' | 'queued' | false {
    const rtc = this.connections.get(chatId);
    if (rtc) return rtc.sendMessage(text);
    return false;
  }

  isConnected(chatId: string): boolean {
    const rtc = this.connections.get(chatId);
    if (!rtc) return false;
    const dcOpen = rtc.dataChannel?.readyState === 'open';
    const iceOk =
      rtc.pc?.iceConnectionState === 'connected' || rtc.pc?.iceConnectionState === 'completed';
    return !!dcOpen && !!iceOk;
  }

  getSharedSecret(chatId: string): string | null {
    return this.sharedSecrets.get(chatId) || null;
  }

  getBuffered(chatId: string) {
    const buffered = this.buffer.get(chatId) || [];
    this.buffer.delete(chatId);
    return buffered;
  }

  // Setzt den gesamten In-Memory-Zustand des Singletons zurueck (Secrets-Lifecycle-
  // Review, Fund S-1): schliesst jede offene Verbindung und leert jede Map, damit
  // nach dem Pepper-Wipe keine Session-Secrets oder gepufferten Klartexte im
  // Tab-Speicher ueberleben.
  resetAll() {
    for (const rtc of this.connections.values()) {
      try { rtc.close('wipe'); } catch {}
    }
    this.connections.clear();
    this.listeners.clear();
    this.buffer.clear();
    this.sharedSecrets.clear();
    this.previousSecrets.clear();
  }

  // Loescht den gesamten In-Memory-Zustand eines einzelnen Kontakts (Secrets-
  // Lifecycle-Review, Fund S-3): schliesst dessen Verbindung und entfernt alle
  // fuer ihn gepufferten Nachrichten, ohne andere Kontakte zu beruehren.
  clearContact(chatId: string) {
    const existing = this.connections.get(chatId);
    if (existing) {
      try { existing.close('wipe'); } catch {}
      this.connections.delete(chatId);
    }
    this.listeners.delete(chatId);
    this.buffer.delete(chatId);
    this.sharedSecrets.delete(chatId);
    this.previousSecrets.delete(chatId);
  }
}

export default new RTCStore();
