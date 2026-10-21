// Siegel-Anhaenge (SiegelCrypto.js sealMedia/openMedia): Dateiformat MSF1,
// Rundlauf fuer Bild/Sprachnachricht/Datei, Manipulation, falscher Kontakt,
// nur einmal zu oeffnen (Zero Trace), Groessengrenze, nichts im Klartext.
const crypto = require('crypto');
const { fakeKyber, rng } = require('../security/helpers/siegelTestHelpers');
const S = require('../../SiegelCrypto');

const kyber = fakeKyber();

async function pair() {
  const inv = await S.createInvite({ rng, kyber });
  const b = await S.acceptInvite(inv.qr, { rng, kyber });
  const a = await S.completeInvite(inv.secret, b.qr, { rng, kyber });
  return { a: a.contact, b: b.contact };
}
const bytesOf = (n, seed = 7) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 255;
  return out;
};
const contains = (hay, needle) => Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;

describe('Rundlauf', () => {
  test.each([
    ['image', 'image/jpeg', 'urlaub.jpg', 5000],
    ['audio', 'audio/mp4', 'sprachnachricht.mp4', 12345],
    ['file', 'application/pdf', 'Vertrag März.pdf', 70000],
  ])('%s: Inhalt, Typ und Name kommen unveraendert an', async (kind, mime, name, size) => {
    const { a, b } = await pair();
    const bytes = bytesOf(size);
    const r = await S.sealMedia(a.ratchet, { kind, mime, name, bytes }, { rng });
    expect(S.isSiegelMedia(r.file)).toBe(true);
    expect(Buffer.from(r.file.subarray(0, 4)).toString('latin1')).toBe('MSF1');
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    expect(o.kind).toBe(kind);
    expect(o.mime).toBe(mime);
    expect(o.name).toBe(name);
    expect(Buffer.from(o.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  test('beide Richtungen und gemischt mit Textnachrichten (ein gemeinsamer Ratchet)', async () => {
    let { a, b } = await pair();
    const t1 = await S.sealText(a.ratchet, 'zuerst Text', { rng });
    a.ratchet = t1.ratchet;
    const m1 = await S.sealMedia(a.ratchet, { kind: 'image', mime: 'image/png', name: 'x.png', bytes: bytesOf(300) }, { rng });
    a.ratchet = m1.ratchet;
    // Reihenfolge vertauscht angekommen: erst der Anhang, dann der Text.
    const o1 = await S.openMedia(b.ratchet, m1.file, { rng });
    b.ratchet = o1.ratchet;
    const o2 = await S.openText(b.ratchet, t1.message, { rng });
    b.ratchet = o2.ratchet;
    expect(o2.text).toBe('zuerst Text');
    const back = await S.sealMedia(b.ratchet, { kind: 'audio', mime: 'audio/mp4', name: 'a.mp4', bytes: bytesOf(900, 3) }, { rng });
    const o3 = await S.openMedia(a.ratchet, back.file, { rng });
    expect(o3.kind).toBe('audio');
    expect(o3.bytes.length).toBe(900);
  });

  test('Buffer (Polyfill/Node) als Eingabe funktioniert wie Uint8Array', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'n.txt', bytes: Buffer.from('Hallo Datei') }, { rng });
    const o = await S.openMedia(b.ratchet, Buffer.from(r.file), { rng });
    expect(Buffer.from(o.bytes).toString()).toBe('Hallo Datei');
  });

  test('leere Datei ist erlaubt', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'leer.txt', bytes: new Uint8Array(0) }, { rng });
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    expect(o.bytes.length).toBe(0);
  });
});

describe('Zero Trace und Metadaten', () => {
  test('nur einmal zu oeffnen: zweiter Versuch -> "used"', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'image', mime: 'image/jpeg', name: 'p.jpg', bytes: bytesOf(2000) }, { rng });
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    await expect(S.openMedia(o.ratchet, r.file, { rng })).rejects.toMatchObject({ code: 'used' });
  });

  test('Art, Typ, Name und Inhalt stehen nirgends im Klartext in der Datei', async () => {
    const { a } = await pair();
    const marker = Buffer.from('GEHEIMER-DATEIINHALT-0123456789');
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'application/x-geheim', name: 'Steuer-Geheimnis.pdf', bytes: marker }, { rng });
    for (const s of ['GEHEIMER-DATEIINHALT', 'application/x-geheim', 'Steuer-Geheimnis', '"media"', 'image', 'audio']) {
      expect(contains(r.file, s)).toBe(false);
    }
  });

  test('Laenge verraet nur eine Groessenklasse (Auffuellung)', async () => {
    const { a } = await pair();
    const r1 = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'a', bytes: bytesOf(10) }, { rng });
    const r2 = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'a', bytes: bytesOf(900) }, { rng });
    expect(r1.file.length).toBe(r2.file.length);
    expect(S.mediaPadLen(100001)).toBeGreaterThanOrEqual(100001);
    expect(S.mediaPadLen(100001)).toBeLessThanOrEqual(100001 * 1.13);
    expect(S.mediaPadLen(S.MAX_MEDIA_BYTES)).toBe(S.MAX_MEDIA_BYTES);
  });

  test('Name wird gekuerzt und von Pfad-/Steuerzeichen befreit, unbekannter Typ neutralisiert', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'kein typ', name: '../../etc/\u0007' + 'x'.repeat(300), bytes: bytesOf(5) }, { rng });
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    expect(o.name).not.toMatch(/[\/\\\u0000-\u001f]/);
    expect(o.name.length).toBeLessThanOrEqual(100);
    expect(o.mime).toBe('application/octet-stream');
  });
});

describe('Fehlerfaelle', () => {
  test('veraenderter Blob -> "auth"; der Zustand bleibt unveraendert (Original oeffnet danach)', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'image', mime: 'image/jpeg', name: 'p.jpg', bytes: bytesOf(4000) }, { rng });
    const bad = Uint8Array.from(r.file);
    bad[bad.length - 100] ^= 1;
    const before = JSON.stringify(b.ratchet);
    await expect(S.openMedia(b.ratchet, bad, { rng })).rejects.toMatchObject({ code: 'auth' });
    expect(JSON.stringify(b.ratchet)).toBe(before);
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    expect(o.bytes.length).toBe(4000);
  });

  test('veraenderter Kopf -> "auth"', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'n', bytes: bytesOf(50) }, { rng });
    const bad = Uint8Array.from(r.file);
    bad[60] ^= 1;
    await expect(S.openMedia(b.ratchet, bad, { rng })).rejects.toMatchObject({ code: 'auth' });
  });

  test('Blob einer anderen Datei untergeschoben -> "auth" (Pruefsumme im Kopf)', async () => {
    const { a, b } = await pair();
    const r1 = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'eins', bytes: bytesOf(500, 1) }, { rng });
    const r2 = await S.sealMedia(r1.ratchet, { kind: 'file', mime: 'text/plain', name: 'zwei', bytes: bytesOf(500, 2) }, { rng });
    const h1 = Buffer.from(r1.file).readUInt32BE(4);
    const h2 = Buffer.from(r2.file).readUInt32BE(4);
    const mixed = Buffer.concat([Buffer.from(r1.file.subarray(0, 8 + h1)), Buffer.from(r2.file.subarray(8 + h2))]);
    await expect(S.openMedia(b.ratchet, mixed, { rng })).rejects.toMatchObject({ code: 'auth' });
  });

  test('falscher Kontakt -> "auth"', async () => {
    const p1 = await pair();
    const p2 = await pair();
    const r = await S.sealMedia(p1.a.ratchet, { kind: 'audio', mime: 'audio/mp4', name: 'a.mp4', bytes: bytesOf(100) }, { rng });
    await expect(S.openMedia(p2.b.ratchet, r.file, { rng })).rejects.toMatchObject({ code: 'auth' });
  });

  test('keine Siegel-Datei / abgeschnitten / Kopflaenge unsinnig -> "format"', async () => {
    const { a, b } = await pair();
    expect(S.isSiegelMedia(Buffer.from('%PDF-1.7 ....................................................................................................'))).toBe(false);
    expect(S.isSiegelMedia(null)).toBe(false);
    expect(S.isSiegelMedia('MSF1')).toBe(false);
    await expect(S.openMedia(b.ratchet, crypto.randomBytes(500), { rng })).rejects.toMatchObject({ code: 'format' });
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'n', bytes: bytesOf(50) }, { rng });
    await expect(S.openMedia(b.ratchet, r.file.subarray(0, 120), { rng })).rejects.toMatchObject({ code: 'format' });
    const weird = Uint8Array.from(r.file);
    weird.set([0x7f, 0xff, 0xff, 0xff], 4);
    await expect(S.openMedia(b.ratchet, weird, { rng })).rejects.toMatchObject({ code: 'format' });
  });

  test('Groessengrenze 16 MB: groesser wird nicht verschluesselt ("too-long"); unbekannte Art -> "format"', async () => {
    const { a } = await pair();
    await expect(S.sealMedia(a.ratchet, { kind: 'file', mime: 'x/y', name: 'gross', bytes: new Uint8Array(S.MAX_MEDIA_BYTES + 1) }, { rng }))
      .rejects.toMatchObject({ code: 'too-long' });
    await expect(S.sealMedia(a.ratchet, { kind: 'video', mime: 'x/y', name: 'v', bytes: bytesOf(5) }, { rng }))
      .rejects.toMatchObject({ code: 'format' });
    await expect(S.sealMedia(a.ratchet, { kind: 'file', mime: 'x/y', name: 'v', bytes: 'kein Uint8Array' }, { rng }))
      .rejects.toMatchObject({ code: 'format' });
  });

  test('genau 16 MB gehen (Rundlauf)', async () => {
    const { a, b } = await pair();
    const big = new Uint8Array(S.MAX_MEDIA_BYTES);
    big[0] = 1; big[big.length - 1] = 2;
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'application/zip', name: 'gross.zip', bytes: big }, { rng });
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    expect(o.bytes.length).toBe(S.MAX_MEDIA_BYTES);
    expect(o.bytes[0]).toBe(1);
    expect(o.bytes[o.bytes.length - 1]).toBe(2);
  }, 60000);

  test('Kopf eines Anhangs als MS1-Text umverpackt: wird nicht als Nachricht angezeigt ("format")', async () => {
    const { a, b } = await pair();
    const r = await S.sealMedia(a.ratchet, { kind: 'file', mime: 'text/plain', name: 'n', bytes: bytesOf(50) }, { rng });
    const hLen = Buffer.from(r.file).readUInt32BE(4);
    const header = Buffer.from(r.file.subarray(8, 8 + hLen));
    const asText = 'MS1:' + header.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(S.openText(b.ratchet, asText, { rng })).rejects.toMatchObject({ code: 'format' });
    // ... und der Anhang selbst laesst sich danach weiterhin oeffnen.
    const o = await S.openMedia(b.ratchet, r.file, { rng });
    expect(o.bytes.length).toBe(50);
  });

  test('Text-Umschlag als Anhang verpackt -> abgelehnt, Zustand unveraendert', async () => {
    const { a, b } = await pair();
    const t = await S.sealText(a.ratchet, 'nur Text', { rng });
    const raw = Buffer.from(t.message.slice(4).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const len = Buffer.alloc(4); len.writeUInt32BE(raw.length);
    const fake = Buffer.concat([Buffer.from('MSF1'), len, raw, crypto.randomBytes(64)]);
    await expect(S.openMedia(b.ratchet, fake, { rng })).rejects.toMatchObject({ code: 'format' });
    expect((await S.openText(b.ratchet, t.message, { rng })).text).toBe('nur Text');
  });
});
