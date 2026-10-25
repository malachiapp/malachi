// Die Wellenform reist nur im verschluesselten End-Marker der Sprachnachricht
// und wird beim Empfang streng geprueft (AudioCrypto.js, RTCStore._assemble).
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();

const crypto = require('crypto');
const { decryptMsg } = require('../../MessageCrypto');
const { sendEncryptedAudio, processAudioChunk } = require('../../AudioCrypto');
const { encodeWave } = require('../../VoiceWave');

const secret = crypto.randomBytes(32).toString('base64');
const audio = crypto.randomBytes(3000).toString('base64');

async function roundTrip(meta) {
  const sent = [];
  const id = await sendEncryptedAudio(audio, secret, (raw) => sent.push(raw), 5200, false, meta);
  expect(id).not.toBeNull();
  let result = null;
  const plains = [];
  for (const raw of sent) {
    const outer = JSON.parse(raw);
    expect(outer.type).toBe('encrypted');
    const plain = decryptMsg(outer.data, secret);
    plains.push(plain);
    const r = processAudioChunk(JSON.parse(plain));
    if (r) result = r;
  }
  return { result, sent, plains };
}

describe('Wellenform im Transport', () => {
  test('gueltige Wellenform kommt an, nur verschluesselt auf der Leitung', async () => {
    const wave = encodeWave(Array.from({ length: 80 }, (_, i) => -45 + (i % 9) * 5));
    const { result, sent } = await roundTrip({ msgId: 'm1', wave });
    expect(result.wave).toBe(wave);
    expect(result.base64).toBe(audio);
    expect(sent.join('')).not.toContain(wave);   // nie im Klartext
  });

  test('ohne Wellenform (aeltere Absender/Nachrichten) bleibt alles wie bisher', async () => {
    const { result, plains } = await roundTrip({ msgId: 'm2' });
    expect(result.wave).toBeUndefined();
    expect(plains.join('')).not.toContain('"wave"');
  });

  test('ungueltige Wellenform wird weder gesendet noch angenommen', async () => {
    const { result, plains } = await roundTrip({ msgId: 'm3', wave: '<img src=x>'.repeat(4) });
    expect(result.wave).toBeUndefined();
    expect(plains.join('')).not.toContain('<img');
    // Manipulierter End-Marker einer Gegenstelle
    const forged = processAudioChunk({ type: 'audio_chunk', audioId: 'x1', index: 0, total: 1, data: 'QUJD', realLen: 4 });
    expect(forged).toBeNull();
    const end = processAudioChunk({ type: 'audio_end', audioId: 'x1', total: 1, durationMs: 1, wave: { evil: true } });
    expect(end.wave).toBeUndefined();
    processAudioChunk({ type: 'audio_chunk', audioId: 'x2', index: 0, total: 1, data: 'QUJD', realLen: 4 });
    expect(processAudioChunk({ type: 'audio_end', audioId: 'x2', total: 1, durationMs: 1, wave: 'Z'.repeat(48) }).wave).toBeUndefined();
  });
});
