// Zweiter Zahlungsweg Bitcoin (BIP84, watch-only zpub, mempool.space-Attrappe) -
// gleichzeitig mit Monero aktiv: Adressableitung je Bestellung, Betrag in BTC mit
// 8 Nachkommastellen aus dem Kursmedian, Bestaetigungen, Unter-/Ueberzahlung,
// Staubgrenze, Ablauf, Wiederverwendung von Adressen, Gap-Limit, Lizenz und die
// JSON-API (/api/v1/info, /orders, /orders/:id, /transfer). Nur oeffentliche Testdaten
// (BIP84-Testvektor "abandon ... about" - niemals echte Zahlungen dorthin).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { STATUS, offenerBetrag } from '../src/bestellungen.js';
import { pruefeLizenz } from '../src/lizenzpruefer.js';
import { erstelleHandler, erstelleServer } from '../src/app.js';
import { empfangsAdresse } from '../src/bip84.js';
import { MempoolApi } from '../src/mempool.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';
import { BTC_STAUBGRENZE_SATS } from '../src/zahlung/bitcoin.js';
import { testShop, FakeMempool, FakeKurse, BTC_TESTKONTO, STUNDE, GERAET_A, GERAET_B, TEST_OEFFENTLICH, ONION } from './hilfen.js';

const ADRESSE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // BIP84-Testvektor m/84'/0'/0'/0/0
const ADRESSE_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/84'/0'/0'/0/1
const SATS = 4087; // 2,99 EUR bei 73.174 EUR/BTC (Median 73.000/73.348), aufgerundet

const pruefe = (v, id) => v.aktualisieren(id, { mindestAbstandMs: 0 });
const neu = (v, extra = {}) => v.erstellen({ geraetecode: GERAET_A, zustimmung: true, zahlungsweg: 'btc', ...extra });
const lizenzOk = (l, dev = GERAET_A) => pruefeLizenz(l, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: dev }).gueltig;

/** Shop mit Monero UND Bitcoin (Standard: Monero). */
async function zweiWege(ueberschreiben = {}, optionen = {}) {
  const mempool = optionen.mempool || new FakeMempool();
  const s = await testShop(
    {
      bestellung: { stoss: 50, proStunde: 10_000 },
      ...ueberschreiben,
      zahlungswege: { standard: 'xmr', ...(ueberschreiben.zahlungswege || {}), btc: { aktiv: true, zpub: BIP84_TESTVEKTOR_ZPUB, ...((ueberschreiben.zahlungswege || {}).btc || {}) } },
    },
    { ...optionen, mempool },
  );
  return { ...s, mempool };
}

describe('Bitcoin: Bestellungen (zusammen mit Monero)', () => {
  it('beide Wege gleichzeitig: eigene Zaehler, BIP84-Adresse je Bestellung, Betrag aus dem BTC-Median', async () => {
    const { verwaltung: v, wallet } = await zweiWege();
    const { bestellung: x } = await neu(v, { zahlungsweg: 'xmr' });
    const { bestellung: a } = await neu(v);
    const { bestellung: b } = await neu(v);
    const { bestellung: standard } = await neu(v, { zahlungsweg: undefined });
    assert.equal(x.waehrung, 'XMR');
    assert.equal(x.adresse, wallet.adressen[1]);
    assert.equal(standard.zahlungsweg, 'xmr', 'ohne Angabe gilt der Standard-Zahlungsweg');
    assert.deepEqual([a.zahlungsweg, a.waehrung, a.index, a.adresse], ['btc', 'BTC', 0, ADRESSE_0]);
    assert.deepEqual([b.index, b.adresse], [1, ADRESSE_1]);
    assert.equal(a.betrag, SATS);
    assert.equal(a.kurs.eurProCoin, 73_174);
    assert.equal(a.kurs.quellen.length, 2);
    assert.equal(a.schluessel, BTC_TESTKONTO().fingerabdruck);
    assert.deepEqual(v.daten.zaehler.btc.freie, []);
    assert.equal(v.daten.zaehler.btc.naechster, 2);
  });

  it('unterzahlt -> Rest im Mempool -> bestaetigt: Lizenz und Buchung in BTC', async () => {
    const { verwaltung: v, mempool, buchhaltung } = await zweiWege();
    const { bestellung: b } = await neu(v);
    const erste = mempool.zahlung(b.adresse, 3000, { hoehe: mempool.hoehe });
    let s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.UNTERZAHLT);
    assert.equal(offenerBetrag(s, 0, v.wege.btc), SATS - 3000);
    const rest = mempool.zahlung(b.adresse, SATS - 3000);
    s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.UNBESTAETIGT);
    assert.equal(s.bestaetigungen, 0, 'noch im Mempool');
    assert.equal(s.lizenzen.length, 0, 'keine Lizenz vor der Bestaetigung');
    rest.hoehe = mempool.hoehe;
    s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.BEZAHLT);
    assert.ok(lizenzOk(s.lizenzen[0].lizenz));
    const e = buchhaltung.lesen('einnahmen');
    assert.equal(e.length, 1);
    assert.equal(e[0].waehrung, 'BTC');
    assert.equal(e[0].zahlungsweg, 'btc');
    assert.equal(e[0].betragCoin, '0.00004087');
    assert.equal(e[0].empfangenCoin, '0.00004087');
    assert.equal(e[0].ueberzahlungCoin, '0.00000000');
    assert.equal(e[0].subadresseIndex, 0);
    assert.deepEqual(e[0].txids.sort(), [erste.txid, rest.txid].sort());
  });

  it('Rest unter der Staubgrenze wird auf den Mindestbetrag angehoben, Ueberzahlung wird gebucht', async () => {
    const { verwaltung: v, mempool, buchhaltung } = await zweiWege();
    const { bestellung: b } = await neu(v);
    mempool.zahlung(b.adresse, SATS - 7, { hoehe: mempool.hoehe }); // 7 sat zu wenig (Tippfehler)
    const s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.UNTERZAHLT);
    assert.equal(offenerBetrag(s, 0, v.wege.btc), BTC_STAUBGRENZE_SATS);
    mempool.zahlung(b.adresse, BTC_STAUBGRENZE_SATS, { hoehe: mempool.hoehe });
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
    assert.equal(buchhaltung.lesen('einnahmen')[0].ueberzahlungCoin, '0.00000539');
  });

  it('Betrag nie unter der Staubgrenze (sehr hoher Kurs)', async () => {
    const kurse = new FakeKurse();
    kurse.btc = { kraken: 9_000_000, coingecko: 9_000_000 };
    const { verwaltung: v } = await zweiWege({}, { kurse });
    assert.equal((await neu(v)).bestellung.betrag, BTC_STAUBGRENZE_SATS);
  });

  it('Ueberzahlung wird akzeptiert', async () => {
    const { verwaltung: v, mempool, buchhaltung } = await zweiWege();
    const { bestellung: b } = await neu(v);
    mempool.zahlung(b.adresse, SATS + 10_000, { hoehe: mempool.hoehe });
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
    assert.equal(buchhaltung.lesen('einnahmen')[0].ueberzahlungCoin, '0.00010000');
  });

  it('Mindestbestaetigungen werden ueber die Blockhoehe gezaehlt', async () => {
    const { verwaltung: v, mempool } = await zweiWege({ mindestBestaetigungen: 3 });
    const { bestellung: b } = await neu(v);
    mempool.zahlung(b.adresse, SATS, { hoehe: mempool.hoehe - 1 }); // 2 Bestaetigungen
    let s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.UNBESTAETIGT);
    assert.equal(s.bestaetigungen, 2);
    mempool.hoehe += 1;
    s = await pruefe(v, b.id);
    assert.equal(s.status, STATUS.BEZAHLT);
  });

  it('abgelaufen nach 24 h; eine spaete Zahlung wird noch erkannt', async () => {
    const { verwaltung: v, mempool, uhr } = await zweiWege();
    const { bestellung: a } = await neu(v);
    const { bestellung: b } = await neu(v);
    uhr.vor(24 * STUNDE + 1);
    assert.equal(v.holen(a.id).status, STATUS.ABGELAUFEN);
    mempool.zahlung(b.adresse, SATS, { hoehe: mempool.hoehe });
    assert.equal((await pruefe(v, b.id)).status, STATUS.BEZAHLT);
  });

  it('Adresse ohne jeden Eingang wird nach der Reservierung wiederverwendet, mit Eingang nie wieder', async () => {
    const { verwaltung: v, mempool, uhr } = await zweiWege();
    const { bestellung: a } = await neu(v);
    uhr.vor(72 * STUNDE + 1);
    await v.hintergrundLauf();
    assert.equal(v.holen(a.id), null);
    assert.deepEqual(v.daten.zaehler.btc.freie, [0]);
    const { bestellung: b } = await neu(v);
    assert.equal(b.adresse, ADRESSE_0, 'unbenutzte Adresse wird wiederverwendet');
    uhr.vor(72 * STUNDE + 1);
    await v.hintergrundLauf();
    assert.deepEqual(v.daten.zaehler.btc.freie, [0]);
    mempool.zahlung(ADRESSE_0, 1000); // spaete Zahlung nach dem Loeschen (noch im Mempool)
    const { bestellung: c } = await neu(v);
    assert.equal(c.index, 1);
    assert.ok(!v.daten.zaehler.btc.freie.includes(0), 'Adresse mit Eingang wird nie wieder vergeben');
  });

  it('Adressen mit fremder Historie werden uebersprungen; startIndex wird beachtet', async () => {
    const mempool = new FakeMempool();
    mempool.zahlung(empfangsAdresse(BTC_TESTKONTO(), 5), 20_000, { hoehe: 850_000 });
    const { verwaltung: v } = await zweiWege({ zahlungswege: { btc: { startIndex: 5 } } }, { mempool });
    const { bestellung: b } = await neu(v);
    assert.equal(b.index, 6);
    assert.equal(b.adresse, empfangsAdresse(BTC_TESTKONTO(), 6));
  });

  it('Gap-Limit: hoechstens gapLimit-1 unbezahlte Bitcoin-Bestellungen, Monero bleibt moeglich', async () => {
    const { verwaltung: v, mempool } = await zweiWege({ zahlungswege: { btc: { gapLimit: 4 } } });
    const offen = [];
    for (let i = 0; i < 3; i++) offen.push((await neu(v)).bestellung);
    await assert.rejects(neu(v), (e) => e.code === 'voll' && /Bitcoin/.test(e.message) && /anderen Zahlungsweg/.test(e.message));
    assert.equal((await neu(v, { zahlungsweg: 'xmr' })).bestellung.waehrung, 'XMR');
    mempool.zahlung(offen[1].adresse, SATS); // Zahlung im Mempool -> Adresse benutzt
    await pruefe(v, offen[1].id);
    const { bestellung: d } = await neu(v);
    assert.equal(d.index, 3);
  });

  it('Gap-Limit gilt auch fuer gleichzeitige Anfragen', async () => {
    const { verwaltung: v } = await zweiWege({ zahlungswege: { btc: { gapLimit: 4 } } });
    const ergebnisse = await Promise.allSettled(Array.from({ length: 6 }, () => neu(v)));
    const ok = ergebnisse.filter((r) => r.status === 'fulfilled').map((r) => r.value.bestellung.index);
    assert.deepEqual(ok.sort((a, b) => a - b), [0, 1, 2]);
    assert.ok(ergebnisse.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'voll'));
  });

  it('mempool.space nicht erreichbar: keine Bestellung, kein Index verbraucht', async () => {
    const { verwaltung: v, mempool } = await zweiWege();
    mempool.ausfall = true;
    await assert.rejects(neu(v), (e) => e.code === 'netz');
    mempool.ausfall = false;
    assert.equal((await neu(v)).bestellung.index, 0);
  });

  it('Bitcoin nicht aktiv: paymentMethod btc wird abgewiesen', async () => {
    const { verwaltung: v } = await testShop();
    await assert.rejects(neu(v), (e) => e.code === 'zahlungsweg');
  });
});

describe('Bitcoin: mempool.space-Abfrage', () => {
  it('Bestaetigungen: 0 im Mempool, sonst die kleinste Zahl (bei Mindestbestaetigungen > 1)', async () => {
    const m = new FakeMempool();
    const api = new MempoolApi({ holen: m.holen, onionUrl: ONION });
    m.zahlung(ADRESSE_0, 1000, { hoehe: m.hoehe - 9 });
    m.zahlung(ADRESSE_0, 2000, { hoehe: m.hoehe - 2 });
    let s = await api.zahlungsstand(ADRESSE_0, 3);
    assert.deepEqual([s.empfangenSats, s.bestaetigtSats, s.bestaetigungen], [3000, 3000, 3]);
    s = await api.zahlungsstand(ADRESSE_0, 5);
    assert.deepEqual([s.bestaetigtSats, s.bestaetigungen], [1000, 3]);
    m.zahlung(ADRESSE_0, 500);
    s = await api.zahlungsstand(ADRESSE_0, 1);
    assert.deepEqual([s.empfangenSats, s.bestaetigtSats, s.bestaetigungen], [3500, 3000, 0]);
    assert.equal(s.txids.length, 3);
  });

  it('ungueltige Adressen werden gar nicht erst abgefragt', async () => {
    const m = new FakeMempool();
    const api = new MempoolApi({ holen: m.holen, onionUrl: ONION });
    for (const a of ['tb1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', '../api/v1', ADRESSE_0.slice(0, -1) + 'v']) {
      await assert.rejects(api.zahlungsstand(a), /Ungueltige Adresse/);
    }
  });
});

// ------------------------------------------------------------------ HTTP / JSON-API

function anfrage(port, { methode = 'GET', pfad = '/', kopf = {}, koerper = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, headers: { ...kopf, ...(koerper !== null ? { 'Content-Length': Buffer.byteLength(koerper) } : {}) } }, (res) => {
      const teile = [];
      res.on('data', (d) => teile.push(d));
      res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: Buffer.concat(teile).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(koerper ?? undefined);
  });
}
const api = (port, methode, pfad, obj) =>
  anfrage(port, { methode, pfad, kopf: { 'Content-Type': 'application/json' }, koerper: obj === undefined ? null : JSON.stringify(obj) });

describe('Bitcoin: JSON-API und Webseite (Monero und Bitcoin aktiv)', () => {
  let s;
  let server;
  let port;

  before(async () => {
    s = await zweiWege({ rechtliches: { anbieter: ['Max Muster'], impressum: ['Max Muster'] } });
    const handler = erstelleHandler({ konfig: s.konfig, verwaltung: s.verwaltung, lizenzOeffentlich: Buffer.from(TEST_OEFFENTLICH).toString('base64url'), wartezeitPruefungMs: 2000 });
    server = erstelleServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  it('/api/v1/info bietet beide Zahlungswege an', async () => {
    const r = await api(port, 'GET', '/api/v1/info');
    const info = JSON.parse(r.text);
    assert.deepEqual(info.paymentMethods, [
      { id: 'xmr', currency: 'XMR', name: 'Monero' },
      { id: 'btc', currency: 'BTC', name: 'Bitcoin' },
    ]);
    assert.equal(info.defaultPaymentMethod, 'xmr');
  });

  it('Bitcoin-Bestellung: Adresse, Betrag mit 8 Stellen, BIP21-URI, Ablauf bis zur Lizenz und Umzug', async () => {
    let r = await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A, consent: true, paymentMethod: 'btc' });
    assert.equal(r.status, 201);
    const o = JSON.parse(r.text);
    assert.equal(o.paymentMethod, 'btc');
    assert.equal(o.currency, 'BTC');
    assert.match(o.address, /^bc1q[02-9ac-hj-np-z]{38}$/);
    assert.equal(o.amount, '0.00004087');
    assert.equal(o.amountAtomic, '4087');
    assert.equal(o.amountXmr, undefined);
    assert.equal(o.paymentUri, `bitcoin:${o.address}?amount=0.00004087`);
    assert.equal(o.eurPrice, '2.99');
    assert.equal(o.eurRate, '73174.00');
    assert.equal(o.received, '0.00000000');
    assert.equal(o.missing, '0.00004087');
    assert.equal(o.confirmations, null);
    assert.match(o.recoveryCode, /^[0-9A-Z]{20}$/);

    // Teilzahlung im Mempool -> unterzahlt
    s.mempool.zahlung(o.address, 2000);
    s.verwaltung.holen(o.orderId).zuletztGeprueft = 0;
    r = await api(port, 'GET', `/api/v1/orders/${o.orderId}`);
    let st = JSON.parse(r.text);
    assert.deepEqual([st.status, st.received, st.missing, st.paymentMethod, st.currency], ['underpaid', '0.00002000', '0.00002087', 'btc', 'BTC']);
    assert.equal(st.paymentUri, `bitcoin:${o.address}?amount=0.00002087`);
    assert.equal(st.recoveryCode, undefined);
    // Rest -> unbestaetigt -> bestaetigt
    s.mempool.zahlung(o.address, 2087);
    s.verwaltung.holen(o.orderId).zuletztGeprueft = 0;
    r = await api(port, 'GET', `/api/v1/orders/${o.orderId}`);
    st = JSON.parse(r.text);
    assert.deepEqual([st.status, st.confirmations, st.missing], ['unconfirmed', 0, '0.00000000']);
    for (const tx of s.mempool.txs) if (tx.adresse === o.address) tx.hoehe = s.mempool.hoehe;
    s.verwaltung.holen(o.orderId).zuletztGeprueft = 0;
    r = await api(port, 'GET', `/api/v1/orders/${o.orderId}`);
    st = JSON.parse(r.text);
    assert.equal(st.status, 'paid');
    assert.ok(lizenzOk(st.license));
    assert.equal(st.licensedDevice, GERAET_A);

    r = await api(port, 'POST', '/api/v1/transfer', { orderId: o.orderId, recoveryCode: o.recoveryCode, deviceCode: GERAET_B });
    assert.equal(r.status, 200);
    assert.ok(lizenzOk(JSON.parse(r.text).license, GERAET_B));
  });

  it('Monero bleibt unveraendert (Standard), unbekannte Zahlungswege werden abgewiesen', async () => {
    let r = await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A, consent: true });
    let o = JSON.parse(r.text);
    assert.deepEqual([r.status, o.paymentMethod, o.currency, o.amountXmr], [201, 'xmr', 'XMR', '0.006149']);
    assert.match(o.paymentUri, /^monero:8\w+\?tx_amount=0\.006149$/);
    r = await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A, consent: true, paymentMethod: 'xmr' });
    o = JSON.parse(r.text);
    assert.equal(o.currency, 'XMR');
    for (const m of ['ltc', 'extern', 'BTC', '__proto__', 'constructor', 'toString']) {
      r = await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A, consent: true, paymentMethod: m });
      assert.equal(r.status, 400, m);
      assert.equal(JSON.parse(r.text).error.code, 'invalid_payment_method', m);
    }
  });

  it('Webseite: Auswahl beider Wege, Bitcoin-Bestellseite mit QR und BIP21-Link, Datenschutz', async () => {
    let r = await anfrage(port, {});
    assert.match(r.text, /name="zahlungsweg" value="xmr" checked/);
    assert.match(r.text, /name="zahlungsweg" value="btc"/);
    assert.match(r.text, /Bitcoin-Zahlungen sind in der Bitcoin-Blockchain öffentlich sichtbar; Monero ist privater\./);
    assert.match(r.text, /Bezahlung mit Monero oder Bitcoin/);
    const a = JSON.parse((await api(port, 'POST', '/api/v1/orders', { deviceCode: GERAET_A, consent: true, paymentMethod: 'btc' })).text);
    r = await anfrage(port, { pfad: `/bestellung/${a.orderId}` });
    assert.match(r.text, /0\.00004087 BTC/);
    assert.ok(r.text.includes(`href="bitcoin:${a.address}?amount=0.00004087"`));
    assert.match(r.text, /Adresse \(Bitcoin\)/);
    const png = await anfrage(port, { pfad: `/bestellung/${a.orderId}/qr.png` });
    assert.equal(png.kopf['content-type'], 'image/png');
    r = await anfrage(port, { pfad: '/datenschutz' });
    assert.match(r.text, /mempool\.space/);
    assert.match(r.text, /öffentlich einsehbar, Monero-Zahlungen nicht/);
  });
});
