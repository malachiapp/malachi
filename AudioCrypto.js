/**
 * Malachi – AudioCrypto.js
 * Verschlüsselter Audio-Versand via DataChannel
 * Gleiche Chunk-Logik wie ImageCrypto
 */
import { encryptMsg, secureRandomToken } from './MessageCrypto';
import { newFileKey, fileKeyToB64, sealMediaChunk } from './MediaKey';
import { sanitizeWave } from './VoiceWave';

const CHUNK_SIZE = 64 * 1024; // 64KB

// Siehe ImageCrypto.js fuer die Begruendung (Sicherheitsreview 5, Fund 7) -
// der letzte, meist unvollstaendige Chunk verraet sonst die exakte
// Sprachnachrichten-Groesse bis aufs Byte. realLen sagt dem Empfaenger, wie
// viel Fuellzeichen beim Zusammensetzen wieder abzuschneiden sind.
function padLastChunk(chunk, chunkSize) {
  if (chunk.length >= chunkSize) return { data: chunk, realLen: chunk.length };
  return { data: chunk + 'A'.repeat(chunkSize - chunk.length), realLen: chunk.length };
}

// meta.msgId / meta.sealer: siehe sendEncryptedImage() in ImageCrypto.js.
export async function sendEncryptedAudio(audioBase64, sharedSecret, sendFn, durationMs, viewOnce = false, meta = {}) {
  let fk = null;
  try {
    const audioId = await secureRandomToken(8);
    const total   = Math.ceil(audioBase64.length / CHUNK_SIZE);
    const sealer  = meta?.sealer || null;
    if (sealer) fk = await newFileKey();

    for (let i = 0; i < total; i++) {
      const rawChunk = audioBase64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const { data: chunk, realLen } = padLastChunk(rawChunk, CHUNK_SIZE);
      if (fk) {
        await sealer.chunk({
          type: 'audio_chunk', audioId, index: i, total, realLen, fk: 1,
          data: sealMediaChunk(fk, 'audio', audioId, i, total, realLen, chunk),
        });
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      const payload = JSON.stringify({
        type: 'audio_chunk', audioId, index: i, total, data: chunk, realLen,
      });
      const encrypted = await encryptMsg(payload, sharedSecret);
      if (!encrypted) throw new Error('Verschlüsselung fehlgeschlagen');
      sendFn(JSON.stringify({ type: 'encrypted', data: encrypted }));
      await new Promise(r => setTimeout(r, 10));
    }

    // End-Marker
    const wave = sanitizeWave(meta?.wave);   // Wellenform (VoiceWave.js), nur im verschluesselten End-Marker
    const endObj = {
      type: 'audio_end', audioId, total, durationMs, viewOnce,
      ...(meta?.msgId ? { msgId: String(meta.msgId) } : {}),
      ...(wave ? { wave } : {}),
      ...(meta?.secret ? { secret: true } : {}),   // Audit P1, siehe ImageCrypto.js
    };
    if (fk) {
      await sealer.end({ ...endObj, fk: fileKeyToB64(fk) });
    } else {
      const encryptedEnd = await encryptMsg(JSON.stringify(endObj), sharedSecret);
      if (!encryptedEnd) throw new Error('Verschlüsselung fehlgeschlagen');
      sendFn(JSON.stringify({ type: 'encrypted', data: encryptedEnd }));
    }
    console.log(`[AudioCrypto] ✅ Audio ${audioId} gesendet`);
    return audioId;
  } catch(e) {
    console.error('[AudioCrypto] Fehler:', e?.message || e);
    return null;
  } finally {
    fk?.fill(0);
  }
}

const audioBuffers = new Map();
// Siehe ImageCrypto.js fuer die Begruendung (Fund 7a, Fuzzing-Kampagne) -
// identisches Muster, identischer Fix.
const MAX_CHUNKS = 10000;

// Performance-Audit (Speicherleck) - identisches Muster/identischer Fix wie
// ImageCrypto.js's imageBuffers (dort ausfuehrlich begruendet): audioBuffers
// ist Modul-State, ueberdauert also jede einzelne Chat-Sitzung - ein
// abgebrochener Audio-Transfer (Gegenseite trennt mitten im Senden) blieb
// bisher fuer die gesamte Prozesslaufzeit im Speicher.
const STALE_TRANSFER_MS = 10 * 60 * 1000;
function sweepStaleAudioBuffers() {
  if (audioBuffers.size === 0) return;
  const now = Date.now();
  for (const [key, buf] of audioBuffers) {
    if (buf?.createdAt && now - buf.createdAt > STALE_TRANSFER_MS) audioBuffers.delete(key);
  }
}

export function processAudioChunk(msg) {
  if (msg.type === 'audio_chunk') {
    if (!audioBuffers.has(msg.audioId)) {
      if (!Number.isInteger(msg.total) || msg.total < 0 || msg.total > MAX_CHUNKS) {
        console.warn('[AudioCrypto] Ungueltiger total-Wert verworfen:', msg.total);
        return null;
      }
      sweepStaleAudioBuffers();
      audioBuffers.set(msg.audioId, {
        chunks: new Array(msg.total), total: msg.total, received: 0, createdAt: Date.now()
      });
    }
    const buf = audioBuffers.get(msg.audioId);
    if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= buf.total) {
      console.warn('[AudioCrypto] Ungueltiger chunk-index verworfen:', msg.index);
      return null;
    }
    // Fund 7b (siehe ImageCrypto.js) - nur beim ERSTEN Befuellen eines Index zaehlen.
    const alreadyFilled = buf.chunks[msg.index] !== undefined;
    buf.chunks[msg.index] = Number.isFinite(msg.realLen) ? msg.data.slice(0, msg.realLen) : msg.data;
    if (!alreadyFilled) buf.received++;
    return null;
  }
  if (msg.type === 'audio_end') {
    const buf = audioBuffers.get(msg.audioId);
    if (!buf || buf.received < buf.total) return null;
    const fullBase64 = buf.chunks.join('');
    audioBuffers.delete(msg.audioId);
    const wave = sanitizeWave(msg.wave);
    return { audioId: msg.audioId, base64: fullBase64, durationMs: msg.durationMs, viewOnce: !!msg.viewOnce,
      ...(msg.msgId ? { msgId: String(msg.msgId) } : {}), ...(wave ? { wave } : {}) };
  }
  return null;
}