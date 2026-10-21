// Siegel-Modus, Protokoll (SiegelCrypto.js): Kopplung per zwei QR-Codes,
// Double Ratchet ueber Copy-Paste, Zero Trace (nicht wiederholbar),
// Laengen-Verschleierung, Fehlerfaelle.
const { fakeKyber, rng } = require('../security/helpers/siegelTestHelpers');
const S = require('../../SiegelCrypto');

const kyber = fakeKyber();

async function pair() {
  const inv = await S.createInvite({ rng, kyber });
  const b = await S.acceptInvite(inv.qr, { rng, kyber });
  const a = await S.completeInvite(inv.secret, b.qr, { rng, kyber });
  return { a: a.contact, b: b.contact, inviteQr: inv.qr, ackQr: b.qr };
}

describe('Kopplung', () => {
  test('beide Seiten erhalten denselben Sicherheitscode (6 x 5 Ziffern)', async () => {
    const { a, b } = await pair();
    expect(a.safety).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(a.safety).toBe(b.safety);
  });

  test('QR-Inhalte nutzen nur Zeichen des alphanumerischen QR-Modus (kompakter)', async () => {
    const { inviteQr, ackQr } = await pair();
    for (const q of [inviteQr, ackQr]) expect(q).toMatch(/^[0-9A-Z:]+$/);
    expect(inviteQr.startsWith('MSI1:')).toBe(true);
    expect(ackQr.startsWith('MSA1:')).toBe(true);
    expect(inviteQr.length).toBeLessThan(2100);
    expect(ackQr.length).toBeLessThan(2200);
  });

  test('Antwort auf eine ANDERE Einladung wird abgelehnt', async () => {
    const inv1 = await S.createInvite({ rng, kyber });
    const inv2 = await S.createInvite({ rng, kyber });
    const b = await S.acceptInvite(inv2.qr, { rng, kyber });
    await expect(S.completeInvite(inv1.secret, b.qr, { rng, kyber })).rejects.toMatchObject({ code: 'confirm' });
  });

  test('veraenderte Antwort (ein Zeichen) wird abgelehnt', async () => {
    const inv = await S.createInvite({ rng, kyber });
    const b = await S.acceptInvite(inv.qr, { rng, kyber });
    const i = 300;
    const bad = b.qr.slice(0, i) + (b.qr[i] === 'A' ? 'B' : 'A') + b.qr.slice(i + 1);
    await expect(S.completeInvite(inv.secret, bad, { rng, kyber })).rejects.toBeInstanceOf(S.SiegelError);
  });

  test('kaputte oder fremde Codes: klare Fehler', async () => {
    await expect(S.acceptInvite('https://example.org', { rng, kyber })).rejects.toMatchObject({ code: 'format' });
    await expect(S.acceptInvite('MSI1:ABC', { rng, kyber })).rejects.toMatchObject({ code: 'format' });
    const inv = await S.createInvite({ rng, kyber });
    await expect(S.completeInvite(inv.secret, inv.qr, { rng, kyber })).rejects.toMatchObject({ code: 'format' });
  });
});

describe('Nachrichten', () => {
  test('beide Seiten koennen ZUERST schreiben; Hin und Her mehrfach', async () => {
    let { a, b } = await pair();
    let r = await S.sealText(a.ratchet, 'Hallo von A', { rng });
    a.ratchet = r.ratchet;
    let o = await S.openText(b.ratchet, r.message, { rng });
    b.ratchet = o.ratchet;
    expect(o.text).toBe('Hallo von A');
    for (let i = 0; i < 3; i++) {
      r = await S.sealText(b.ratchet, 'B ' + i + ' äöü 🔒', { rng });
      b.ratchet = r.ratchet;
      o = await S.openText(a.ratchet, r.message, { rng });
      a.ratchet = o.ratchet;
      expect(o.text).toBe('B ' + i + ' äöü 🔒');
    }
    // Und B kann auch ganz am Anfang zuerst schreiben:
    const fresh = await pair();
    const first = await S.sealText(fresh.b.ratchet, 'B zuerst', { rng });
    expect((await S.openText(fresh.a.ratchet, first.message, { rng })).text).toBe('B zuerst');
  });

  test('Reihenfolge vertauscht (Messenger liefert anders aus): alles kommt an', async () => {
    let { a, b } = await pair();
    const msgs = [];
    for (const t of ['eins', 'zwei', 'drei']) {
      const r = await S.sealText(a.ratchet, t, { rng });
      a.ratchet = r.ratchet;
      msgs.push(r.message);
    }
    const got = [];
    for (const m of [msgs[2], msgs[0], msgs[1]]) {
      const o = await S.openText(b.ratchet, m, { rng });
      b.ratchet = o.ratchet;
      got.push(o.text);
    }
    expect(got).toEqual(['drei', 'eins', 'zwei']);
  });

  test('Zero Trace: eine Nachricht laesst sich nur EINMAL entschluesseln', async () => {
    let { a, b } = await pair();
    const r = await S.sealText(a.ratchet, 'geheim', { rng });
    const o = await S.openText(b.ratchet, r.message, { rng });
    await expect(S.openText(o.ratchet, r.message, { rng })).rejects.toMatchObject({ code: 'used' });
  });

  test('veraendert oder fuer einen anderen Kontakt: abgelehnt, Zustand unveraendert', async () => {
    const p1 = await pair();
    const p2 = await pair();
    const r = await S.sealText(p1.a.ratchet, 'nur fuer p1', { rng });
    const before = JSON.stringify(p2.b.ratchet);
    await expect(S.openText(p2.b.ratchet, r.message, { rng })).rejects.toMatchObject({ code: 'auth' });
    expect(JSON.stringify(p2.b.ratchet)).toBe(before);
    const body = r.message.slice(4);
    const k = body.length - 10;
    const tampered = 'MS1:' + body.slice(0, k) + (body[k] === 'A' ? 'B' : 'A') + body.slice(k + 1);
    await expect(S.openText(p1.b.ratchet, tampered, { rng })).rejects.toMatchObject({ code: 'auth' });
    // Die echte Nachricht geht danach weiterhin.
    expect((await S.openText(p1.b.ratchet, r.message, { rng })).text).toBe('nur fuer p1');
  });

  test('Laenge verraet nur die Groessenklasse: 1 Zeichen und 50 Zeichen sind gleich lang', async () => {
    const { a } = await pair();
    const short = await S.sealText(a.ratchet, 'x', { rng });
    const long = await S.sealText(short.ratchet, 'y'.repeat(50), { rng });
    expect(short.message.length).toBe(long.message.length);
    const big = await S.sealText(long.ratchet, 'z'.repeat(100), { rng });
    expect(big.message.length).toBeGreaterThan(long.message.length);
  });

  test('Nachricht wird auch mit Zeilenumbruechen und Begleittext gefunden', async () => {
    let { a, b } = await pair();
    const r = await S.sealText(a.ratchet, 'eingebettet', { rng });
    const m = r.message;
    const pasted = 'Weitergeleitet:\n' + m.slice(0, 40) + '\n' + m.slice(40) + '  ';
    expect((await S.openText(b.ratchet, pasted, { rng })).text).toBe('eingebettet');
    await expect(S.openText(b.ratchet, 'nur Text', { rng })).rejects.toMatchObject({ code: 'format' });
  });

  test('zu langer Text wird abgelehnt', async () => {
    const { a } = await pair();
    await expect(S.sealText(a.ratchet, 'a'.repeat(S.MAX_TEXT_BYTES + 1), { rng })).rejects.toMatchObject({ code: 'too-long' });
  });
});

describe('mehrteilige QR-Anzeige (Kamera analysiert nur ~640x480)', () => {
  test('Einladung und Antwort zerfallen in kleine Teile und setzen sich in beliebiger Reihenfolge wieder zusammen', async () => {
    const { inviteQr, ackQr } = await pair();
    for (const code of [inviteQr, ackQr]) {
      const parts = S.splitForQr(code);
      expect(parts.length).toBeGreaterThanOrEqual(4);
      for (const p of parts) {
        expect(p.length).toBeLessThanOrEqual(S.QR_PART_CHARS + 20);
        expect(p).toMatch(/^[0-9A-Z:]+$/);
      }
      const asm = new S.QrAssembler();
      const order = [...parts].reverse();
      let res = null;
      for (const p of [order[0], order[0], ...order.slice(1)]) res = asm.add(p);   // Duplikate egal
      expect(res.code).toBe(code);
    }
  });

  test('Teile verschiedener Codes werden nicht vermischt; Fremdes wird ignoriert', async () => {
    const a = await pair();
    const b = await pair();
    const pa = S.splitForQr(a.ackQr);
    const pb = S.splitForQr(b.ackQr);
    const asm = new S.QrAssembler();
    expect(asm.add('https://example.org')).toBeNull();
    asm.add(pa[0]);
    asm.add(pa[1]);
    let res = null;
    for (const p of pb) res = asm.add(p);         // anderer Satz: neu begonnen
    expect(res.code).toBe(b.ackQr);
    expect(new S.QrAssembler().add(a.inviteQr).code).toBe(a.inviteQr);   // einteilig direkt
  });
});
