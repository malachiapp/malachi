/* eslint-env node */
// Audit 2026-10-19, C3: Profilbild-Kennzeichen authentifiziert.
//   - Der (verschluesselte, mit Ratchet authentifizierte) End-Marker
//     entscheidet Profilbild vs. Chat-Bild; Chunks muessen dazu passen.
//   - Mit Dateischluessel: eigene Art 'avatar' in den Zusatzdaten - ein als
//     Chat-Bild versiegeltes Bild laesst sich nicht als Profilbild oeffnen.
//   - Ein nur AUSSEN (unverschluesselt) gesetztes Kennzeichen zaehlt nicht.
const fs = require('fs');
const path = require('path');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const RTCStore = require('../../RTCStore').default;
const { newFileKey, fileKeyToB64, sealMediaChunk } = require('../../MediaKey');
const { sendEncryptedImage } = require('../../ImageCrypto');
const { decryptMsg } = require('../../MessageCrypto');

const CHAT = 'c_avatar';
const IMG = Buffer.from('BILD-'.repeat(100)).toString('base64');

beforeEach(() => {
  RTCStore.resetAll();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const chunk = (id, extra = {}) => ({ type: 'img_chunk', imageId: id, index: 0, total: 1, data: IMG, realLen: IMG.length, mimeType: 'image/jpeg', ...extra });
const end = (id, extra = {}) => ({ type: 'img_end', imageId: id, total: 1, mimeType: 'image/jpeg', ...extra });

describe('Empfang (RTCStore._assemble)', () => {
  test('Kennzeichen in Chunk UND End-Marker: Profilbild, keine Chat-Nachricht', () => {
    expect(RTCStore._assemble(CHAT, chunk('a1', { isAvatarChunk: true }))).toBeNull();
    expect(RTCStore._assemble(CHAT, end('a1', { isAvatarChunk: true }))).toBeNull();
    expect(RTCStore.pendingAvatars.get(CHAT)).toMatchObject({ imageId: 'a1', base64: IMG });
  });

  test('normales Bild: Chat-Nachricht, kein Profilbild', () => {
    RTCStore._assemble(CHAT, chunk('n1'));
    expect(RTCStore._assemble(CHAT, end('n1', { msgId: 'm1' }))).toMatchObject({ type: 'image_complete', msgId: 'm1', base64: IMG });
    expect(RTCStore.pendingAvatars?.get(CHAT)).toBeUndefined();
  });

  test('Widerspruch zwischen Chunks und End-Marker: verworfen (weder noch)', () => {
    RTCStore._assemble(CHAT, chunk('x1', { isAvatarChunk: true }));
    expect(RTCStore._assemble(CHAT, end('x1', { msgId: 'm2' }))).toBeNull();
    RTCStore._assemble(CHAT, chunk('x2'));
    expect(RTCStore._assemble(CHAT, end('x2', { isAvatarChunk: true }))).toBeNull();
    expect(RTCStore.pendingAvatars?.get(CHAT)).toBeUndefined();
  });

  test('mit Dateischluessel: als Chat-Bild versiegelt -> nicht als Profilbild zu oeffnen', async () => {
    const fk = await newFileKey();
    const sealed = sealMediaChunk(fk, 'img', 'r1', 0, 1, IMG.length, IMG);
    RTCStore._assemble(CHAT, chunk('r1', { fk: 1, data: sealed, isAvatarChunk: true }));
    expect(RTCStore._assemble(CHAT, end('r1', { fk: fileKeyToB64(fk), isAvatarChunk: true }))).toBeNull();
    expect(RTCStore.pendingAvatars?.get(CHAT)).toBeUndefined();
    // Richtig versiegelt ('avatar') klappt es.
    const fk2 = await newFileKey();
    RTCStore._assemble(CHAT, chunk('r2', { fk: 1, data: sealMediaChunk(fk2, 'avatar', 'r2', 0, 1, IMG.length, IMG), isAvatarChunk: true }));
    RTCStore._assemble(CHAT, end('r2', { fk: fileKeyToB64(fk2), isAvatarChunk: true }));
    expect(RTCStore.pendingAvatars.get(CHAT)).toMatchObject({ imageId: 'r2', base64: IMG });
  });
});

describe('Senden (ImageCrypto)', () => {
  test('ohne Ratchet: Kennzeichen steckt IN jedem verschluesselten Teil, nicht aussen', async () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const wire = [];
    await sendEncryptedImage(IMG, 'image/jpeg', secret, (raw) => wire.push(JSON.parse(raw)), { avatar: true });
    expect(wire.length).toBe(2);
    for (const w of wire) {
      expect(w.isAvatarChunk).toBeUndefined();
      expect(JSON.parse(decryptMsg(w.data, secret)).isAvatarChunk).toBe(true);
    }
  });

  test('mit Ratchet: Art "avatar" in den Zusatzdaten, Kennzeichen in Chunk und End-Marker', async () => {
    const sent = [];
    const sealer = { chunk: async (o) => sent.push(o), end: async (o) => sent.push(o) };
    await sendEncryptedImage(IMG, 'image/jpeg', 'unbenutzt', () => {}, { sealer, avatar: true });
    expect(sent.map((o) => [o.type, o.isAvatarChunk])).toEqual([['img_chunk', true], ['img_end', true]]);
    RTCStore._assemble(CHAT, sent[0]);
    RTCStore._assemble(CHAT, sent[1]);
    expect(RTCStore.pendingAvatars.get(CHAT)?.base64).toBe(IMG);
  });
});

test('statisch: WebRTCManager uebernimmt das Kennzeichen nicht mehr von aussen; RTCStore sendet ohne Aussen-Umschlag', () => {
  const w = fs.readFileSync(path.join(__dirname, '../../WebRTCManager.js'), 'utf8');
  const r = fs.readFileSync(path.join(__dirname, '../../RTCStore.js'), 'utf8');
  expect(w).not.toMatch(/if \(msg\.isAvatarChunk\) original\.isAvatarChunk = true;/);
  expect(w).toMatch(/if \(msg\.isAvatarChunk && original\.isAvatarChunk !== true\) return;/);
  expect(r).not.toMatch(/\{ \.\.\.parsed, isAvatarChunk: true \}/);
  expect((r.match(/\{ sealer, avatar: true \}/g) || []).length).toBe(2);
});
