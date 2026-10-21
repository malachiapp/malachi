/**
 * Malachi – ImageCrypto.js
 * Verschlüsselter Bildversand via DataChannel
 * Chunks à 64KB, jeder einzeln dreischicht-verschlüsselt
 */
import { encryptMsg, secureRandomToken } from './MessageCrypto';
import { newFileKey, fileKeyToB64, sealMediaChunk } from './MediaKey';

const CHUNK_SIZE = 64 * 1024; // 64KB

// Der letzte Chunk ist fast nie exakt CHUNK_SIZE gross (Rest der Division) -
// seine genaue Laenge verraet einem Beobachter (Relay oder Netzwerk) die
// exakte Gesamtgroesse des Bildes bis auf das Byte genau, obwohl alle Chunks
// AEAD-verschluesselt sind (Verschluesselung versteckt keine Laenge). Auf
// CHUNK_SIZE aufgepolstert wird nur noch die grobe Groessenklasse (Vielfaches
// von CHUNK_SIZE) sichtbar, nicht mehr die exakte Byte-Zahl - realLen sagt
// dem Empfaenger, wie viel davon beim Zusammensetzen wieder abzuschneiden ist
// (Sicherheitsreview 5, Fund 7).
function padLastChunk(chunk, chunkSize) {
  if (chunk.length >= chunkSize) return { data: chunk, realLen: chunk.length };
  return { data: chunk + 'A'.repeat(chunkSize - chunk.length), realLen: chunk.length };
}

// meta.msgId (optional, Zustell-Garantie 2026-10): ID der Nachrichtenblase des
// Absenders - reist im End-Marker mit, der Empfaenger bestaetigt damit den
// vollstaendigen Empfang und verwirft Wiederholungen (RTCStore.js). Wirft
// sendFn (Kanal waehrend des Transfers abgerissen), liefert die Funktion null
// - die Warteschlange schickt das Bild dann spaeter komplett neu.
// meta.sealer (Double Ratchet, siehe WebRTCManager.mediaSealer/MediaKey.js):
// Chunks mit einem frischen Dateischluessel verschluesselt, der Schluessel
// reist im Ratchet-geschuetzten End-Marker. Ohne sealer: bisheriges Verfahren.
// meta.avatar (Audit 2026-10-19, C3): Profilbild - Kennzeichen IN jedem
// verschluesselten Chunk und im End-Marker (nie nur aussen), und mit Ratchet
// eigene Art 'avatar' in den Zusatzdaten: ein Chat-Bild laesst sich nicht als
// Profilbild ausgeben und umgekehrt.
export async function sendEncryptedImage(imageBase64, mimeType, sharedSecret, sendFn, meta = {}) {
  let fk = null;
  const avatar = meta?.avatar === true;
  const kind = avatar ? 'avatar' : 'img';
  const avatarFlag = avatar ? { isAvatarChunk: true } : {};
  try {
    const imageId = await secureRandomToken(8);
    const data    = imageBase64;
    const total   = Math.ceil(data.length / CHUNK_SIZE);
    const sealer  = meta?.sealer || null;
    if (sealer) fk = await newFileKey();

    console.log(`[ImageCrypto] Sende Bild ${imageId} in ${total} Chunks`);

    for (let i = 0; i < total; i++) {
      const rawChunk = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const { data: chunk, realLen } = padLastChunk(rawChunk, CHUNK_SIZE);
      if (fk) {
        await sealer.chunk({
          type: 'img_chunk', imageId, index: i, total, realLen, mimeType, fk: 1, ...avatarFlag,
          data: sealMediaChunk(fk, kind, imageId, i, total, realLen, chunk),
        });
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      const payload = JSON.stringify({
        type:    'img_chunk',
        imageId,
        index:   i,
        total,
        data:    chunk,
        realLen,
        mimeType,
        ...avatarFlag,
      });
      const encrypted = await encryptMsg(payload, sharedSecret);
      if (!encrypted) throw new Error('Verschlüsselung fehlgeschlagen');
      sendFn(JSON.stringify({ type: 'encrypted', data: encrypted }));
      // Kurze Pause zwischen Chunks
      await new Promise(r => setTimeout(r, 10));
    }

    // End-Marker senden
    const endObj = {
      type:    'img_end',
      imageId,
      total,
      mimeType,
      ...(meta?.msgId ? { msgId: String(meta.msgId) } : {}),
      // Audit P1: Secret-Chat-Medium - der Empfaenger haelt es nur im RAM.
      ...(meta?.secret ? { secret: true } : {}),
      ...avatarFlag,
    };
    if (fk) {
      await sealer.end({ ...endObj, fk: fileKeyToB64(fk) });
    } else {
      const encryptedEnd = await encryptMsg(JSON.stringify(endObj), sharedSecret);
      if (!encryptedEnd) throw new Error('Verschlüsselung fehlgeschlagen');
      sendFn(JSON.stringify({ type: 'encrypted', data: encryptedEnd }));
    }
    console.log(`[ImageCrypto] ✅ Bild ${imageId} vollständig gesendet`);
    return imageId;
  } catch(e) {
    console.error('[ImageCrypto] Fehler:', e?.message || e);
    return null;
  } finally {
    fk?.fill(0);
  }
}

// Empfangene Chunks zusammensetzen
const imageBuffers = new Map(); // imageId → { chunks: [], total, mimeType }

// Fund 7a (Fuzzing-Kampagne): ein negativer/unendlicher/nicht-ganzzahliger
// `total` liess `new Array(total)` bisher mit einem synchronen RangeError
// abstuerzen. Obergrenze zusaetzlich bei 10000 Chunks (~640MB bei 64KB
// CHUNK_SIZE) - weit jenseits jeder realistischen Anhangsgroesse, verhindert
// aber eine uebermaessig grosse Array-Allokation durch einen manipulierten Wert.
const MAX_CHUNKS = 10000;

// Performance-Audit (Speicherleck): dieser Modul-Puffer ist der Live-
// Empfangspfad fuer Bilder, waehrend ein ChatScreen fuer den jeweiligen
// Kontakt bereits offen ist (siehe App.tsx-Listener). Bricht die Gegenseite
// mitten im Senden ab, blieb der teilbefuellte Eintrag bisher fuer die
// gesamte Lebensdauer des Prozesses liegen (imageBuffers ist Modul-State,
// kein Teil von RTCStore.clearContact()/resetAll()). Gleicher Fix wie in
// RTCStore.js: vor jedem neu angelegten Eintrag werden Eintraege raeumen,
// die aelter als STALE_TRANSFER_MS sind - kein neuer Timer, laeuft huckepack
// mit dem naechsten Transferversuch.
const STALE_TRANSFER_MS = 10 * 60 * 1000;
function sweepStaleImageBuffers() {
  if (imageBuffers.size === 0) return;
  const now = Date.now();
  for (const [key, buf] of imageBuffers) {
    if (buf?.createdAt && now - buf.createdAt > STALE_TRANSFER_MS) imageBuffers.delete(key);
  }
}

export function processImageChunk(msg) {
  if (msg.type === 'img_chunk') {
    if (!imageBuffers.has(msg.imageId)) {
      if (!Number.isInteger(msg.total) || msg.total < 0 || msg.total > MAX_CHUNKS) {
        console.warn('[ImageCrypto] Ungueltiger total-Wert verworfen:', msg.total);
        return null;
      }
      sweepStaleImageBuffers();
      imageBuffers.set(msg.imageId, {
        chunks:   new Array(msg.total),
        total:    msg.total,
        mimeType: msg.mimeType,
        received: 0,
        createdAt: Date.now(),
      });
    }
    const buf = imageBuffers.get(msg.imageId);
    // Index ausserhalb des deklarierten Bereichs verwerfen statt das Array
    // stillschweigend zu erweitern (JS-Arrays tolerieren das, buf.total
    // waere danach falsch/nie erreichbar).
    if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= buf.total) {
      console.warn('[ImageCrypto] Ungueltiger chunk-index verworfen:', msg.index);
      return null;
    }
    // Fund 7b: `received` zaehlte bisher jede eingehende Nachricht statt der
    // Anzahl tatsaechlich befuellter, EINDEUTIGER Indizes - ein wiederholter
    // Chunk-Index liess die Zaehlung faelschlich "voll" werden, obwohl ein
    // anderer Index nie ankam (stiller Datenverlust statt einer erkennbaren
    // Luecke). Nur beim ERSTEN Befuellen eines Index zaehlen.
    const alreadyFilled = buf.chunks[msg.index] !== undefined;
    // Auf CHUNK_SIZE aufgepolsterte Chunks (siehe padLastChunk beim Senden)
    // wieder auf die echte Laenge zurueckschneiden.
    buf.chunks[msg.index] = Number.isFinite(msg.realLen) ? msg.data.slice(0, msg.realLen) : msg.data;
    if (!alreadyFilled) buf.received++;
    return null; // noch nicht fertig
  }

  if (msg.type === 'img_end') {
    const buf = imageBuffers.get(msg.imageId);
    if (!buf) return null;
    if (buf.received < buf.total) {
      console.warn('[ImageCrypto] Nicht alle Chunks empfangen');
      return null;
    }
    const fullBase64 = buf.chunks.join('');
    imageBuffers.delete(msg.imageId);
    console.log('[ImageCrypto] ✅ Bild vollständig empfangen');
    return {
      imageId:  msg.imageId,
      base64:   fullBase64,
      mimeType: buf.mimeType,
      ...(msg.msgId ? { msgId: String(msg.msgId) } : {}),
    };
  }

  return null;
}