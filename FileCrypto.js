/**
 * Malachi – FileCrypto.js
 * Verschlüsselter Versand beliebiger Dateien via DataChannel
 * Identisches Chunk-Muster wie ImageCrypto.js/AudioCrypto.js (64KB-Chunks,
 * jeder einzeln dreischicht-verschlüsselt, letzter Chunk auf CHUNK_SIZE
 * aufgepolstert damit die exakte Dateigroesse nicht sichtbar wird) - nur mit
 * Dateiname zusaetzlich im End-Marker, sonst unveraendert uebernommen.
 */
import { encryptMsg, secureRandomToken } from './MessageCrypto';
import { newFileKey, fileKeyToB64, sealMediaChunk } from './MediaKey';

const CHUNK_SIZE = 64 * 1024; // 64KB

function padLastChunk(chunk, chunkSize) {
  if (chunk.length >= chunkSize) return { data: chunk, realLen: chunk.length };
  return { data: chunk + 'A'.repeat(chunkSize - chunk.length), realLen: chunk.length };
}

// meta.msgId / meta.sealer: siehe sendEncryptedImage() in ImageCrypto.js.
export async function sendEncryptedFile(fileBase64, fileName, mimeType, sharedSecret, sendFn, meta = {}) {
  let fk = null;
  try {
    const fileId = await secureRandomToken(8);
    const total = Math.ceil(fileBase64.length / CHUNK_SIZE);
    const sealer = meta?.sealer || null;
    if (sealer) fk = await newFileKey();

    console.log(`[FileCrypto] Sende Datei "${fileName}" (${fileId}) in ${total} Chunks`);

    for (let i = 0; i < total; i++) {
      const rawChunk = fileBase64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const { data: chunk, realLen } = padLastChunk(rawChunk, CHUNK_SIZE);
      if (fk) {
        await sealer.chunk({
          type: 'file_chunk', fileId, index: i, total, realLen, fk: 1,
          data: sealMediaChunk(fk, 'file', fileId, i, total, realLen, chunk),
        });
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      const payload = JSON.stringify({ type: 'file_chunk', fileId, index: i, total, data: chunk, realLen });
      const encrypted = await encryptMsg(payload, sharedSecret);
      if (!encrypted) throw new Error('Verschlüsselung fehlgeschlagen');
      sendFn(JSON.stringify({ type: 'encrypted', data: encrypted }));
      await new Promise(r => setTimeout(r, 10));
    }

    const endObj = { type: 'file_end', fileId, total, fileName, mimeType, size: fileBase64.length,
      ...(meta?.msgId ? { msgId: String(meta.msgId) } : {}),
      ...(meta?.secret ? { secret: true } : {}) };   // Audit P1, siehe ImageCrypto.js
    if (fk) {
      await sealer.end({ ...endObj, fk: fileKeyToB64(fk) });
    } else {
      const encryptedEnd = await encryptMsg(JSON.stringify(endObj), sharedSecret);
      if (!encryptedEnd) throw new Error('Verschlüsselung fehlgeschlagen');
      sendFn(JSON.stringify({ type: 'encrypted', data: encryptedEnd }));
    }
    console.log(`[FileCrypto] ✅ Datei ${fileId} vollständig gesendet`);
    return fileId;
  } catch (e) {
    console.error('[FileCrypto] Fehler:', e?.message || e);
    return null;
  } finally {
    fk?.fill(0);
  }
}

const fileBuffers = new Map(); // fileId → { chunks: [], total, fileName, mimeType, createdAt }
const MAX_CHUNKS = 10000; // siehe ImageCrypto.js - identische Begruendung
const STALE_TRANSFER_MS = 10 * 60 * 1000;
function sweepStaleFileBuffers() {
  if (fileBuffers.size === 0) return;
  const now = Date.now();
  for (const [key, buf] of fileBuffers) {
    if (buf?.createdAt && now - buf.createdAt > STALE_TRANSFER_MS) fileBuffers.delete(key);
  }
}

export function processFileChunk(msg) {
  if (msg.type === 'file_chunk') {
    if (!fileBuffers.has(msg.fileId)) {
      if (!Number.isInteger(msg.total) || msg.total < 0 || msg.total > MAX_CHUNKS) {
        console.warn('[FileCrypto] Ungueltiger total-Wert verworfen:', msg.total);
        return null;
      }
      sweepStaleFileBuffers();
      fileBuffers.set(msg.fileId, { chunks: new Array(msg.total), total: msg.total, received: 0, createdAt: Date.now() });
    }
    const buf = fileBuffers.get(msg.fileId);
    if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= buf.total) {
      console.warn('[FileCrypto] Ungueltiger chunk-index verworfen:', msg.index);
      return null;
    }
    const alreadyFilled = buf.chunks[msg.index] !== undefined;
    buf.chunks[msg.index] = Number.isFinite(msg.realLen) ? msg.data.slice(0, msg.realLen) : msg.data;
    if (!alreadyFilled) buf.received++;
    return null;
  }

  if (msg.type === 'file_end') {
    const buf = fileBuffers.get(msg.fileId);
    if (!buf || buf.received < buf.total) return null;
    const fullBase64 = buf.chunks.join('');
    fileBuffers.delete(msg.fileId);
    console.log('[FileCrypto] ✅ Datei vollständig empfangen:', msg.fileName);
    return {
      fileId: msg.fileId,
      base64: fullBase64,
      fileName: typeof msg.fileName === 'string' ? msg.fileName.slice(0, 255) : 'Datei',
      mimeType: msg.mimeType || 'application/octet-stream',
      size: Number.isFinite(msg.size) ? msg.size : fullBase64.length,
      ...(msg.msgId ? { msgId: String(msg.msgId) } : {}),
    };
  }

  return null;
}
