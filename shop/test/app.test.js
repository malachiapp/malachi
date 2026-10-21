// HTTP-Ebene: Webseite ohne JavaScript, JSON-API fuer den In-App-Kauf,
// Sicherheits-Header, Groessenlimits, Pfad-Traversal, Fehler ohne Stacktraces.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { erstelleHandler, erstelleServer } from '../src/app.js';
import { pruefeLizenz } from '../src/lizenzpruefer.js';
import { testShop, GERAET_A, GERAET_B, TEST_OEFFENTLICH, TestZahlungsdienst } from './hilfen.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';
import { STATUS } from '../src/bestellungen.js';

function anfrage(port, { methode = 'GET', pfad = '/', kopf = {}, koerper = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, headers: { ...kopf, ...(koerper !== null ? { 'Content-Length': Buffer.byteLength(koerper) } : {}) } }, (res) => {
      const teile = [];
      res.on('data', (d) => teile.push(d));
      res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: Buffer.concat(teile).toString('utf8'), roh: Buffer.concat(teile) }));
    });
    req.on('error', reject);
    req.end(koerper ?? undefined);
  });
}
const form = (port, pfad, felder) =>
  anfrage(port, { methode: 'POST', pfad, kopf: { 'Content-Type': 'application/x-www-form-urlencoded' }, koerper: new URLSearchParams(felder).toString() });
const api = (port, methode, pfad, obj) =>
  anfrage(port, { methode, pfad, kopf: { 'Content-Type': 'application/json' }, koerper: obj === undefined ? null : JSON.stringify(obj) });

describe('HTTP', () => {
  let s;
  let server;
  let port;
  const extern = new TestZahlungsdienst();

  before(async () => {
    s = await testShop(
      {
        rechtliches: { anbieter: ['Max Muster', 'Musterstr. 1', '12345 Musterstadt'], impressum: ['Max Muster'] },
        zahlungswege: { extern: { aktiv: true, adapter: 'test' } },
      },
      { extern },
    );
    const handler = erstelleHandler({ konfig: s.konfig, verwaltung: s.verwaltung, lizenzOeffentlich: Buffer.from(TEST_OEFFENTLICH).toString('base64url'), wartezeitPruefungMs: 2000 });
    server = erstelleServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  it('Startseite: Sicherheits-Header, kein JavaScript, keine Cookies, kein Datum', async () => {
    const r = await anfrage(port, {});
    assert.equal(r.status, 200);
    assert.match(r.kopf['content-security-policy'], /default-src 'self'/);
    assert.match(r.kopf['content-security-policy'], /script-src 'none'/);
    assert.match(r.kopf['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.kopf['x-frame-options'], 'DENY');
    assert.equal(r.kopf['x-content-type-options'], 'nosniff');
    assert.equal(r.kopf['referrer-policy'], 'no-referrer');
    assert.equal(r.kopf['set-cookie'], undefined);
    assert.equal(r.kopf.date, undefined);
    assert.ok(!/<script/i.test(r.text));
    assert.ok(!/(src|href)="https?:/i.test(r.text), 'keine externen Ressourcen');
    assert.match(r.text, /2,99 €/);
    assert.match(r.text, /Gerätecode/);
    assert.match(r.text, /§ 19 UStG/);
    assert.match(r.text, /Notfall-PIN/);
    assert.match(r.text, /name="zahlungsweg" value="extern"/);
  });

  it('Webkauf: Bestellung anlegen zeigt den Wiederherstellungscode genau einmal', async () => {
    let r = await form(port, '/bestellung', { geraetecode: GERAET_A, zustimmung: 'ja', zahlungsweg: 'xmr' });
    assert.equal(r.status, 200);
    const nr = /\/bestellung\/([0-9A-Z]{16})"/.exec(r.text)[1];
    assert.match(r.text, /Wiederherstellungscode/);
    const code = /Wiederherstellungscode<\/dt><dd class="mono nummer">([0-9A-Z-]+)</.exec(r.text)[1];
    assert.equal(code.replace(/-/g, '').length, 20);
    r = await anfrage(port, { pfad: `/bestellung/${nr}` });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(code), 'Code erscheint auf der Bestellseite nicht mehr');
    assert.match(r.text, /<meta http-equiv="refresh" content="60">/);
    assert.match(r.text, /<svg[^>]+class="qr"/);
    assert.match(r.text, /monero:8/);
    assert.match(r.text, /0\.006149 XMR/);
    const png = await anfrage(port, { pfad: `/bestellung/${nr}/qr.png` });
    assert.equal(png.kopf['content-type'], 'image/png');
    assert.ok(png.roh.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    // kleingeschrieben/mit Bindestrichen -> Weiterleitung auf die kanonische Adresse
    r = await anfrage(port, { pfad: `/bestellung/${nr.toLowerCase().match(/.{4}/g).join('-')}` });
    assert.equal(r.status, 303);
    assert.equal(r.kopf.location, `/bestellung/${nr}`);

    // Bezahlen -> Lizenz, Rechnung
    const b = s.verwaltung.holen(nr);
    s.wallet.zahlung(b.index, b.betrag, { hoehe: s.wallet.hoehe });
    b.zuletztGeprueft = 0;
    r = await anfrage(port, { pfad: `/bestellung/${nr}` });
    assert.match(r.text, /Bezahlt/);
    assert.ok(!/http-equiv="refresh"/.test(r.text));
    const lizenz = /<textarea[^>]*>([^<]+)<\/textarea>/.exec(r.text)[1];
    assert.equal(pruefeLizenz(lizenz, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_A }).gueltig, true);
    const txt = await anfrage(port, { pfad: `/bestellung/${nr}/lizenz.txt` });
    assert.equal(txt.text.trim(), lizenz);
    assert.match(txt.kopf['content-disposition'], /attachment/);
    const rechnung = await anfrage(port, { pfad: `/bestellung/${nr}/rechnung` });
    assert.match(rechnung.text, /MAL-2026-000001/);
    assert.match(rechnung.text, /Max Muster<br>/);
    assert.match(rechnung.text, /Gemäß § 19 UStG wird keine Umsatzsteuer berechnet/);
    assert.match(rechnung.text, /2,99 €/);
    const gespeichert = await anfrage(port, { pfad: `/bestellung/${nr}/rechnung?speichern=1` });
    assert.match(gespeichert.kopf['content-disposition'], /rechnung-MAL-2026-000001\.html/);
    assert.match(gespeichert.text, /<style>/);

    // Umzug ueber das Formular
    r = await form(port, '/umzug', { nr, code: 'falsch', geraetecode: GERAET_B });
    assert.equal(r.status, 403);
    r = await form(port, '/umzug', { nr, code, geraetecode: GERAET_B });
    assert.equal(r.status, 200);
    const neueLizenz = /<textarea[^>]*>([^<]+)<\/textarea>/.exec(r.text)[1];
    assert.equal(pruefeLizenz(neueLizenz, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_B }).gueltig, true);
  });

  it('Webkauf: Fehler werden verstaendlich angezeigt und Eingaben bleiben erhalten', async () => {
    let r = await form(port, '/bestellung', { geraetecode: GERAET_A });
    assert.equal(r.status, 400);
    assert.match(r.text, /Zustimmung/);
    assert.match(r.text, new RegExp(`value="${GERAET_A}"`));
    r = await form(port, '/bestellung', { geraetecode: 'FALSCH', zustimmung: 'ja' });
    assert.equal(r.status, 400);
    assert.match(r.text, /Gerätecode ist ungültig/);
  });

  it('API: Info, Bestellung anlegen, Status mit Lizenz, Umzug', async () => {
    let r = await api(port, 'GET', '/api/v1/info');
    assert.equal(r.status, 200);
    const info = JSON.parse(r.text);
    assert.equal(info.priceEur, '2.99');
    assert.equal(info.licensePublicKeys[0], Buffer.from(TEST_OEFFENTLICH).toString('base64url'));
    assert.equal(info.consentRequired, true);

    r = await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A });
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text).error.code, 'consent_required');

    r = await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A, consent: true });
    assert.equal(r.status, 201);
    const o = JSON.parse(r.text);
    for (const f of ['orderId', 'address', 'amountXmr', 'eurRate', 'expiresAt', 'recoveryCode', 'paymentUri']) assert.ok(o[f], f);
    assert.equal(o.status, 'pending');
    assert.equal(o.amountXmr, '0.006149');
    assert.equal(o.eurRate, '486.27');
    assert.match(o.paymentUri, /^monero:8\w+\?tx_amount=0\.006149$/);

    const b = s.verwaltung.holen(o.orderId);
    s.wallet.zahlung(b.index, b.betrag); // im Pool
    b.zuletztGeprueft = 0;
    r = await api(port, 'GET', `/api/v1/orders/${o.orderId}`);
    assert.equal(JSON.parse(r.text).status, 'unconfirmed');
    s.wallet.transfers.at(-1).hoehe = s.wallet.hoehe;
    b.zuletztGeprueft = 0;
    r = await api(port, 'GET', `/api/v1/orders/${o.orderId}`);
    const bezahlt = JSON.parse(r.text);
    assert.equal(bezahlt.status, 'paid');
    assert.equal(pruefeLizenz(bezahlt.license, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_A }).gueltig, true);
    assert.match(bezahlt.invoiceNumber, /^MAL-2026-\d{6}$/);
    assert.equal(bezahlt.recoveryCode, undefined, 'Code nur bei der Anlage');

    r = await api(port, 'POST', '/api/v1/transfer', { orderId: o.orderId, recoveryCode: o.recoveryCode, deviceCode: GERAET_B });
    assert.equal(r.status, 200);
    const t = JSON.parse(r.text);
    assert.equal(t.activations, 2);
    assert.equal(pruefeLizenz(t.license, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_B }).gueltig, true);
    r = await api(port, 'POST', '/api/v1/transfer', { orderId: o.orderId, recoveryCode: 'X'.repeat(20), deviceCode: GERAET_B });
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.text).error.code, 'invalid_order_or_recovery_code');
    r = await api(port, 'GET', '/api/v1/orders/ZZZZZZZZZZZZZZZZ');
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.text).error.code, 'not_found');
  });

  it('API: Formate und Groessen werden geprueft', async () => {
    let r = await anfrage(port, { methode: 'POST', pfad: '/api/v1/orders', kopf: { 'Content-Type': 'text/plain' }, koerper: '{}' });
    assert.equal(r.status, 415);
    r = await anfrage(port, { methode: 'POST', pfad: '/api/v1/orders', kopf: { 'Content-Type': 'application/json' }, koerper: '{kaputt' });
    assert.equal(JSON.parse(r.text).error.code, 'invalid_json');
    r = await anfrage(port, { methode: 'POST', pfad: '/api/v1/orders', kopf: { 'Content-Type': 'application/json' }, koerper: JSON.stringify({ x: 'a'.repeat(5000) }) });
    assert.equal(r.status, 413);
    r = await api(port, 'POST', '/api/v1/orders', [1, 2]);
    assert.equal(r.status, 400);
    r = await api(port, 'DELETE', '/api/v1/orders/ABC');
    assert.equal(r.status, 405);
  });

  it('Webhook eines Zahlungsdienstes: nur mit gueltiger Signatur', async () => {
    const roh = JSON.stringify({ referenz: 'R999' });
    let r = await anfrage(port, { methode: 'POST', pfad: '/api/v1/zahlungsdienst/extern/benachrichtigung', kopf: { 'Content-Type': 'application/json', 'X-Signatur': 'falsch' }, koerper: roh });
    assert.equal(r.status, 401);
    const sig = crypto.createHmac('sha256', 'test-geheimnis').update(roh).digest('hex');
    r = await anfrage(port, { methode: 'POST', pfad: '/api/v1/zahlungsdienst/extern/benachrichtigung', kopf: { 'Content-Type': 'application/json', 'X-Signatur': sig }, koerper: roh });
    assert.equal(r.status, 200);
  });

  it('Pfad-Traversal, unbekannte Pfade, Methoden, lange URLs', async () => {
    for (const pfad of ['/static/../config.json', '/static/..%2f..%2fconfig.json', '/bestellung/..%2F..%2Fetc%2Fpasswd', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/static/style.css/../../../src/server.js']) {
      const r = await anfrage(port, { pfad });
      assert.equal(r.status, 404, pfad);
      assert.ok(!r.text.includes('root:'), pfad);
    }
    let r = await anfrage(port, { methode: 'PUT', pfad: '/' });
    assert.equal(r.status, 405);
    assert.equal(r.kopf.allow, 'GET, HEAD, POST');
    r = await anfrage(port, { pfad: '/' + 'a'.repeat(600) });
    assert.equal(r.status, 414);
    r = await anfrage(port, { methode: 'POST', pfad: '/bestellung', kopf: { 'Content-Type': 'application/x-www-form-urlencoded' }, koerper: 'x=' + 'a'.repeat(5000) });
    assert.equal(r.status, 413);
    r = await anfrage(port, { pfad: '/robots.txt' });
    assert.match(r.text, /Disallow: \//);
    r = await anfrage(port, { methode: 'HEAD', pfad: '/' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
  });

  it('interne Fehler ohne Stacktrace', async () => {
    const orig = s.verwaltung.holen;
    s.verwaltung.holen = () => {
      throw new Error('geheimer interner Zustand /opt/malachi-shop/src/x.js');
    };
    try {
      const r = await anfrage(port, { pfad: '/bestellung/ABCDEFGHJKMNPQRS' });
      assert.equal(r.status, 500);
      assert.ok(!r.text.includes('geheimer'));
      assert.ok(!/at .*\.js:\d+/.test(r.text));
      const a = await api(port, 'GET', '/api/v1/orders/ABCDEFGHJKMNPQRS');
      assert.deepEqual(JSON.parse(a.text), { error: { code: 'internal_error', message: 'Etwas ist schiefgelaufen. Bitte später erneut versuchen.' } });
    } finally {
      s.verwaltung.holen = orig;
    }
  });

  it('Rechtliche Seiten und Datenschutz', async () => {
    const r = await anfrage(port, { pfad: '/datenschutz' });
    assert.match(r.text, /keine Zugriffsprotokolle/);
    assert.match((await anfrage(port, { pfad: '/impressum' })).text, /Max Muster/);
    assert.match((await anfrage(port, { pfad: '/widerruf' })).text, /noch nicht hinterlegt/);
  });
});

describe('Angebot nur bereiter Zahlungswege', () => {
  it('/api/v1/info und Startseite zeigen nur bereite Wege; Vorauswahl folgt', async () => {
    const s = await testShop({ zahlungswege: { btc: { aktiv: true, zpub: BIP84_TESTVEKTOR_ZPUB } } });
    const server = erstelleServer(erstelleHandler({ konfig: s.konfig, verwaltung: s.verwaltung, lizenzOeffentlich: 'x' }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      let info = JSON.parse((await anfrage(port, { pfad: '/api/v1/info' })).text);
      assert.deepEqual(info.paymentMethods.map((m) => m.id), ['xmr', 'btc']);
      assert.equal(info.defaultPaymentMethod, 'xmr');
      s.wege.xmr.bereit = false;
      info = JSON.parse((await anfrage(port, { pfad: '/api/v1/info' })).text);
      assert.deepEqual(info.paymentMethods.map((m) => m.id), ['btc']);
      assert.equal(info.defaultPaymentMethod, 'btc');
      const seite = (await anfrage(port, {})).text;
      assert.ok(!/value="xmr"/.test(seite));
      assert.match(seite, /name="zahlungsweg" value="btc"/);
      // alle gestoert: trotzdem alle zeigen (die Bestellung nennt dann den Grund)
      s.wege.btc.bereit = false;
      info = JSON.parse((await anfrage(port, { pfad: '/api/v1/info' })).text);
      assert.deepEqual(info.paymentMethods.map((m) => m.id), ['xmr', 'btc']);
    } finally {
      server.close();
    }
  });
});

describe('Vertrag widerrufen (Seiten und API)', () => {
  const XMR_RUECK = '8BLD65nFvEm2oFSbgYs2xCikGbeiLCjpeRTtY9DL2m2H8XSsi6RBZDYGHeAYabCowvdPhr9DJ9F3AQtj6k172E6y3nUq6vG';
  async function shopMitServer() {
    const s = await testShop({ rechtliches: { anbieter: ['Max Muster', 'Musterstr. 1', '12345 Musterstadt'], impressum: ['Max Muster'] } });
    const server = erstelleServer(erstelleHandler({ konfig: s.konfig, verwaltung: s.verwaltung, lizenzOeffentlich: 'x', wartezeitPruefungMs: 500 }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { s, server, port: server.address().port };
  }

  it('Link auf jeder Seite; Formular -> Pruefen -> Widerruf bestaetigen -> Eingangsbestaetigung (Datei)', async () => {
    const { s, server, port } = await shopMitServer();
    try {
      assert.match((await anfrage(port, {})).text, /<a class="widerrufen" href="\/widerrufen">Vertrag widerrufen<\/a>/);
      const { bestellung: b, wiederherstellungscode: code } = await s.verwaltung.erstellen({ geraetecode: GERAET_A, zustimmung: true });
      assert.ok((await anfrage(port, { pfad: `/bestellung/${b.id}` })).text.includes(`href="/widerrufen?nr=${b.id}"`));
      const formularSeite = await anfrage(port, { pfad: `/widerrufen?nr=${b.id}` });
      assert.equal(formularSeite.status, 200);
      assert.match(formularSeite.text, new RegExp(`value="${b.id}"`));

      const pruef = await form(port, '/widerrufen', { schritt: 'pruefen', nr: b.id, code, name: 'Max', adresse: XMR_RUECK });
      assert.equal(pruef.status, 200);
      assert.match(pruef.text, /Widerruf bestätigen/);
      assert.equal(s.verwaltung.holen(b.id).status, STATUS.OFFEN, 'Pruefseite aendert nichts');

      const fertig = await form(port, '/widerrufen', { schritt: 'bestaetigen', nr: b.id, code, name: 'Max', adresse: XMR_RUECK });
      assert.equal(fertig.status, 200);
      assert.match(fertig.text, /Eingangsbestätigung Ihres Widerrufs/);
      assert.match(fertig.text, /Hiermit widerrufe ich den von mir abgeschlossenen Vertrag/);
      assert.match(fertig.text, /Max Muster/, 'Anbieter in der Bestaetigung');
      assert.equal(s.verwaltung.holen(b.id).status, STATUS.WIDERRUFEN);

      const beleg = await form(port, '/widerrufen', { schritt: 'beleg', nr: b.id, code });
      assert.equal(beleg.status, 200);
      assert.match(beleg.kopf['content-disposition'], /attachment; filename="widerruf-eingangsbestaetigung-/);
      assert.match(beleg.text, /^<!doctype html>/);
      assert.ok(beleg.text.includes(XMR_RUECK));

      const seite = await anfrage(port, { pfad: `/bestellung/${b.id}` });
      assert.match(seite.text, /Bitte nichts mehr an die Adresse dieser Bestellung zahlen/);
      assert.ok(!seite.text.includes(XMR_RUECK), 'Rueckzahlungsadresse nicht ohne Code sichtbar');
      assert.equal((await anfrage(port, { pfad: `/bestellung/${b.id}/qr.png` })).status, 404, 'kein Zahlungs-QR mehr');
    } finally {
      server.close();
    }
  });

  it('falscher Code und ungueltige Adresse: Formular mit Fehler, nichts geaendert', async () => {
    const { s, server, port } = await shopMitServer();
    try {
      const { bestellung: b, wiederherstellungscode: code } = await s.verwaltung.erstellen({ geraetecode: GERAET_A, zustimmung: true });
      const r1 = await form(port, '/widerrufen', { schritt: 'bestaetigen', nr: b.id, code: 'A'.repeat(20) });
      assert.equal(r1.status, 403);
      assert.match(r1.text, /stimmt nicht/);
      const r2 = await form(port, '/widerrufen', { schritt: 'bestaetigen', nr: b.id, code, adresse: XMR_RUECK.slice(0, -1) + 'x' });
      assert.equal(r2.status, 400);
      assert.match(r2.text, /keine gültige Monero-Adresse/);
      assert.equal(s.verwaltung.holen(b.id).status, STATUS.OFFEN);
    } finally {
      server.close();
    }
  });

  it('API: Vorschau, Widerruf mit Eingangsbestaetigung, Status "withdrawn" ohne Zahlungsdaten', async () => {
    const { s, server, port } = await shopMitServer();
    try {
      const { bestellung: b, wiederherstellungscode: code } = await s.verwaltung.erstellen({ geraetecode: GERAET_A, zustimmung: true });
      const vorschau = JSON.parse((await api(port, 'POST', `/api/v1/orders/${b.id}/withdraw`, { recoveryCode: code, confirm: false })).text);
      assert.equal(vorschau.status, 'pending');
      const r = await api(port, 'POST', `/api/v1/orders/${b.id}/withdraw`, { recoveryCode: code, refundAddress: XMR_RUECK, confirm: true });
      assert.equal(r.status, 200);
      const j = JSON.parse(r.text);
      assert.equal(j.status, 'withdrawn');
      assert.equal(j.newWithdrawal, true);
      assert.equal(j.refundAddress, XMR_RUECK);
      assert.match(j.receipt, /Eingangsbestätigung Ihres Widerrufs/);
      assert.ok(Date.parse(j.withdrawnAt) > 0);
      const status = JSON.parse((await anfrage(port, { pfad: `/api/v1/orders/${b.id}` })).text);
      assert.equal(status.status, 'withdrawn');
      assert.equal(status.address, undefined);
      assert.equal(status.paymentUri, undefined);
      assert.equal(s.verwaltung.holen(b.id).widerruf.quelle, 'app');
      const falsch = await api(port, 'POST', `/api/v1/orders/${b.id}/withdraw`, { recoveryCode: 'A'.repeat(20), confirm: true });
      assert.equal(JSON.parse(falsch.text).error.code, 'invalid_order_or_recovery_code');
    } finally {
      server.close();
    }
  });

  it('API: bezahlte Bestellung -> withdrawal_expired (409)', async () => {
    const { s, server, port } = await shopMitServer();
    try {
      const { bestellung: b, wiederherstellungscode: code } = await s.verwaltung.erstellen({ geraetecode: GERAET_A, zustimmung: true });
      s.wallet.zahlung(b.index, b.betrag, { hoehe: s.wallet.hoehe });
      await s.verwaltung.aktualisieren(b.id, { mindestAbstandMs: 0 });
      const r = await api(port, 'POST', `/api/v1/orders/${b.id}/withdraw`, { recoveryCode: code, confirm: true });
      assert.equal(r.status, 409);
      assert.equal(JSON.parse(r.text).error.code, 'withdrawal_expired');
    } finally {
      server.close();
    }
  });
});
