// Malachi Web - Queue.ts
// Lokale, verschluesselte Sende-Warteschlange - Web-Gegenstueck zu
// queueOffline()/flushQueue() in App.tsx (nativ). Nutzerauftrag: Nachrichten-
// INHALTE duerfen nie mehr ueber den Relay-Server laufen, nur reine
// Verbindungsaufbau-/Pollinganfragen - fuer die native App bereits umgesetzt
// (siehe ZERO_KNOWLEDGE_RELAY_PLAN.md, Stufe 1), hier das fehlende Web-
// Gegenstueck (dortiger Fund 1a: der Web-Client hatte bislang GAR KEINE
// lokale Warteschlange und schickte Text-Fallbacks weiterhin ueber /packet).
//
// Anders als nativ (RNFS-Datei pro Item) kein eigenes Dateisystem noetig -
// der bereits verschluesselte Payload wird direkt als Eintrag in der Liste
// unter queue_<chatId> abgelegt, die selbst wiederum durch Storage.ts'
// PIN+Pepper-Verschluesselung geschuetzt ist (doppelt verschluesselt, aber
// unschaedlich).
import { getItem, setItem, removeItem } from './Storage';
import { encryptMsg, decryptMsg } from './MessageCrypto';
import { padToBlock } from './WebRTCManager';
import type { WebRTCManager } from './WebRTCManager';

interface QueueItem {
  type: string;
  encrypted: string;
  msgId: string;
  secretUsed?: string;
}

// Siehe identischer Fund/Fix in der nativen App.tsx ("M1"): queueOffline()
// und flushQueue() machten beide ein ungesichertes Lese-Aendere-Schreibe auf
// denselben 'queue_<contactId>'-Schluessel - pro Kontakt serialisiert statt
// global, damit Warteschlangen verschiedener Kontakte sich nicht gegenseitig
// blockieren.
const queueWriteChains = new Map<string, Promise<any>>();
async function withQueueLock<T>(contactId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queueWriteChains.get(contactId) ?? Promise.resolve();
  const run = prev.then(fn);
  queueWriteChains.set(contactId, run.catch(() => {}));
  return run;
}

export async function queueOffline(
  contactId: string,
  type: string,
  payload: unknown,
  secret: string,
  msgId: string
): Promise<boolean> {
  if (!secret || !contactId) return false;
  try {
    const encrypted = await encryptMsg(JSON.stringify(payload), secret);
    if (!encrypted) return false;
    await withQueueLock(contactId, async () => {
      const queueRaw = await getItem('queue_' + contactId);
      const queue: QueueItem[] = queueRaw ? JSON.parse(queueRaw) : [];
      // Siehe identischer Fund/Fix in der nativen App.tsx queueOffline(): jede
      // Verbindung handelt per Kyber-KEM ein frisches sharedSecret aus (Perfect
      // Forward Secrecy) - ohne das hier verwendete Secret mit abzulegen,
      // versucht flushQueue() spaeter mit dem NEUEN (falschen) Secret zu
      // entschluesseln und der Eintrag bleibt fuer immer haengen.
      queue.push({ type, encrypted, msgId, secretUsed: secret });
      await setItem('queue_' + contactId, JSON.stringify(queue));
    });
    return true;
  } catch (e) {
    console.warn('[Queue] Konnte nicht lokal zwischenspeichern:', (e as Error)?.message);
    return false;
  }
}

// Nur-P2P-Umstellung 2026-09-29 (mirrors BackgroundSync.js nativ): ein
// "Chat geloescht"-Hinweis wartet hier auf die naechste direkte Verbindung
// statt ueber den Relay zu gehen. Ist er zugestellt, meldet flushQueue() das
// ueber diesen Handler (App.tsx entfernt dann den Kontakt endgueltig).
let deleteNoticeDeliveredHandler: ((contactId: string) => void) | null = null;
export function setDeleteNoticeDeliveredHandler(fn: ((contactId: string) => void) | null) {
  deleteNoticeDeliveredHandler = fn;
}

// Wird aufgerufen, sobald eine frische P2P-Verbindung zu einem Kontakt steht
// (rtc._onKeyExchange, siehe RTCStore.ts setConnection()). Arbeitet die
// komplette lokale Warteschlange dieses Kontakts ab - aktuell nur Text/
// System (Bild/Audio sind fuer Web noch nicht eingefuehrt, siehe Kommentar
// in RTCStore.ts). Items, die (noch) nicht zugestellt werden konnten,
// bleiben fuer den naechsten Versuch stehen.
export async function flushQueue(contactId: string, rtc: WebRTCManager): Promise<void> {
  return withQueueLock(contactId, () => flushQueueInner(contactId, rtc));
}

async function flushQueueInner(contactId: string, rtc: WebRTCManager): Promise<void> {
  const queueRaw = await getItem('queue_' + contactId).catch(() => null);
  if (!queueRaw) return;
  let queue: QueueItem[];
  try {
    queue = JSON.parse(queueRaw);
  } catch {
    return;
  }
  if (!Array.isArray(queue) || queue.length === 0) return;
  console.log('[Queue] Ausstehende Nachrichten:', queue.length);
  const remaining: QueueItem[] = [];
  let deleteNoticeDelivered = false;
  for (const item of queue) {
    let payload: any;
    try {
      // Mit dem beim Einreihen aktiven Secret entschluesseln, nicht mit
      // rtc.sharedSecret (nach einem Reconnect bereits ein neues, per
      // Kyber-KEM frisch ausgehandeltes Secret) - siehe Queue.ts-weiter-oben
      // und die identische Begruendung in der nativen App.tsx.
      const decrypted = decryptMsg(item.encrypted, item.secretUsed || rtc.sharedSecret!);
      if (!decrypted) throw new Error('Entschluesselung fehlgeschlagen');
      payload = JSON.parse(decrypted);
    } catch (e) {
      console.warn('[Queue] Item nicht entschluesselbar, behalte fuer spaeter:', item.msgId);
      remaining.push(item);
      continue;
    }
    if (item.type !== 'text' && item.type !== 'system') {
      remaining.push(item);
      continue;
    }
    try {
      // Siehe identischer Fund/Fix in der nativen App.tsx flushQueue():
      // rohes Senden ohne Verschluesselung/Wrapping wird von der
      // Empfangsseite (channel.onmessage, Zweig msg.type==='encrypted')
      // stillschweigend ignoriert - identisch zum Live-Pfad verschluesseln
      // + polstern, dann erst senden.
      if (rtc.dataChannel?.readyState !== 'open') throw new Error('DataChannel nicht offen');
      // Siehe identischer Fund/Fix in der nativen App.tsx flushQueue()
      // ("H1"): payload.time neu stempeln, sonst verwirft die Frische-
      // Pruefung beim Empfaenger eine laenger gequeuete Textnachricht als
      // moeglichen Replay - genau der Fall, fuer den diese Warteschlange da
      // ist. Nicht fuer 'system' (eigene sequenzbewusste Pruefung).
      if (item.type === 'text') (payload as any).time = Date.now();
      const enc = await encryptMsg(padToBlock(payload), rtc.sharedSecret!);
      if (!enc) throw new Error('Verschluesselung fehlgeschlagen');
      rtc.dataChannel.send(JSON.stringify({ type: 'encrypted', data: enc }));
      console.log('[Queue] ✅ Nachricht gesendet:', item.msgId);
      // Siehe identischer Fund/Fix in der nativen App.tsx flushQueue():
      // flushQueue() laeuft ausserhalb der Chat-Komponente und hatte keinen
      // Weg, die eigene Nachrichtenblase des Absenders zu aktualisieren - sie
      // blieb optisch fuer immer auf "wartend" stehen. Wiederverwendet
      // denselben 'receipt'-Dispatch-Weg wie eine echte Empfangsbestaetigung.
      (rtc as any).onMessage?.({ type: 'receipt', msgId: item.msgId, status: 'sent' });
      if (item.type === 'system' && payload?.subtype === 'delete_chat') {
        deleteNoticeDelivered = true;
        break;
      }
    } catch (e) {
      console.warn('[Queue] Senden fehlgeschlagen, behalte fuer naechsten Versuch:', item.msgId, (e as Error)?.message);
      remaining.push(item);
    }
  }
  if (deleteNoticeDelivered) {
    // Restliche Eintraege sind mit dem Kontakt hinfaellig. 500ms Puffer,
    // damit der DataChannel den Hinweis noch hinausschickt, bevor die
    // Verbindung beim endgueltigen Entfernen geschlossen wird.
    await removeItem('queue_' + contactId);
    setTimeout(() => deleteNoticeDeliveredHandler?.(contactId), 500);
    return;
  }
  if (remaining.length > 0) {
    await setItem('queue_' + contactId, JSON.stringify(remaining));
  } else {
    await removeItem('queue_' + contactId);
  }
  console.log('[Queue] ✅ Queue verarbeitet');
}
