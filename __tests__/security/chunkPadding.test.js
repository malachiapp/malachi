// Sicherheitsreview 5, Fund 7 - der letzte (meist unvollstaendige) Chunk
// eines Bild-/Audio-Transfers wird jetzt auf CHUNK_SIZE aufgepolstert
// (ImageCrypto.js/AudioCrypto.js padLastChunk), damit seine Chiffrat-Groesse
// nicht mehr die exakte Gesamtgroesse des Anhangs verraet - ein Beobachter
// lernt nur noch die grobe Groessenklasse (Vielfaches von 64KB) statt der
// exakten Byte-Zahl. Dieser Test prueft echten Byte-genauen Rundlauf mit den
// ECHTEN Sende-/Empfangsfunktionen (keine Mirror-Logik) ueber mehrere
// Groessen, inklusive Randfaelle (exakt durch CHUNK_SIZE teilbar, 1 Byte
// drueber, sehr klein).
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const crypto = require('crypto');
const { encryptMsg, decryptMsg } = require('../../MessageCrypto');
const { sendEncryptedImage, processImageChunk } = require('../../ImageCrypto');
const { sendEncryptedAudio, processAudioChunk } = require('../../AudioCrypto');

const CHUNK_SIZE = 64 * 1024;

function randomBase64(byteLen) {
  return crypto.randomBytes(byteLen).toString('base64');
}

describe('Chunk-Padding (letzter Chunk auf CHUNK_SIZE aufgepolstert)', () => {
  const secret = crypto.randomBytes(32).toString('base64');

  test.each([
    ['sehr klein, 1 Chunk, deutlich unter CHUNK_SIZE', 100],
    ['exakt 1 volle CHUNK_SIZE (kein Rest)', CHUNK_SIZE],
    ['1 Byte ueber einer vollen CHUNK_SIZE (kleiner Rest-Chunk)', CHUNK_SIZE + 1],
    ['mehrere volle Chunks + Rest', CHUNK_SIZE * 3 + 12345],
  ])('Bild: %s - Rundlauf ist byte-exakt', async (_label, byteLen) => {
    const original = randomBase64(byteLen);
    const sentChunks = [];
    const imageId = await new Promise((resolve) => {
      sendEncryptedImage(original, 'image/jpeg', secret, (raw) => {
        sentChunks.push(raw);
      }).then((id) => resolve(id));
    });
    expect(imageId).not.toBeNull();

    let result = null;
    for (const raw of sentChunks) {
      const outer = JSON.parse(raw);
      const plain = decryptMsg(outer.data, secret);
      const msg = JSON.parse(plain);
      const r = processImageChunk(msg);
      if (r) result = r;
    }
    expect(result).not.toBeNull();
    expect(result.base64).toBe(original); // byte-exakter Rundlauf trotz Padding
  });

  test('Bild: der letzte Chunk ist auf der Leitung genauso gross wie ein voller Chunk (Groessenklasse verborgen)', async () => {
    // Absichtlich NICHT exakt durch CHUNK_SIZE teilbar, damit der letzte Chunk
    // ohne Padding kuerzer waere als die anderen.
    const original = randomBase64(CHUNK_SIZE * 2 + 777);
    const sentChunks = [];
    await sendEncryptedImage(original, 'image/jpeg', secret, (raw) => sentChunks.push(raw));

    const chunkCiphertextLengths = [];
    for (const raw of sentChunks) {
      const outer = JSON.parse(raw);
      const plain = decryptMsg(outer.data, secret);
      const msg = JSON.parse(plain);
      if (msg.type === 'img_chunk') chunkCiphertextLengths.push(msg.data.length);
    }
    // 3 Daten-Chunks erwartet (2 volle + 1 Rest), alle mit identischer
    // gepolsterter Klartextlaenge -> identische Chiffratlaenge auf der Leitung.
    expect(chunkCiphertextLengths.length).toBe(3);
    expect(new Set(chunkCiphertextLengths).size).toBe(1);
  });

  test('Audio: Rundlauf ist byte-exakt trotz Padding', async () => {
    const original = randomBase64(CHUNK_SIZE + 999);
    const sentChunks = [];
    const audioId = await sendEncryptedAudio(original, secret, (raw) => sentChunks.push(raw), 4200);
    expect(audioId).not.toBeNull();

    let result = null;
    for (const raw of sentChunks) {
      const outer = JSON.parse(raw);
      const plain = decryptMsg(outer.data, secret);
      const msg = JSON.parse(plain);
      const r = processAudioChunk(msg);
      if (r) result = r;
    }
    expect(result).not.toBeNull();
    expect(result.base64).toBe(original);
    expect(result.durationMs).toBe(4200);
  });

  test('ein Chunk ohne realLen-Feld (Abwaertskompatibilitaet/fremdes Format) wird unveraendert uebernommen', () => {
    // processImageChunk() darf nicht abstuerzen, wenn realLen fehlt - z.B.
    // waehrend eines Uebergangs oder bei manipulierten Nachrichten.
    const r1 = processImageChunk({ type: 'img_chunk', imageId: 'x', index: 0, total: 1, data: 'AAAA', mimeType: 'image/jpeg' });
    expect(r1).toBeNull(); // noch nicht komplett, aber kein Crash
    const r2 = processImageChunk({ type: 'img_end', imageId: 'x', total: 1, mimeType: 'image/jpeg' });
    expect(r2.base64).toBe('AAAA');
  });
});
