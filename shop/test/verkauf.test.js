// Verkaufsmodul: Kraken-Signatur (Beispiel aus der Kraken-Dokumentation),
// Schwellenwert/Zeitplan, Probelauf, Buchung ausgefuehrter Auftraege; manueller Modus.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { krakenSignatur, KrakenClient, Verkaufsmodul, krakenSchluesselPruefen, krakenZugangFehler } from '../src/verkauf.js';
import { Buchhaltung } from '../src/buchhaltung.js';
import { tempVerzeichnis, testUhr } from './hilfen.js';

describe('Kraken-API', () => {
  it('Signatur entspricht dem Beispiel der Kraken-Dokumentation', () => {
    const sig = krakenSignatur(
      '/0/private/AddOrder',
      '1616492376594',
      'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25',
      'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==',
    );
    assert.equal(sig, '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
  });
});

/** Attrappe der Kraken-API auf HTTP-Ebene. */
function fakeKraken() {
  const k = {
    bestand: '0.0000000000',
    auftraege: {},
    aufrufe: [],
    anfrage: async (url, { methode, kopf, koerper }) => {
      assert.equal(methode, 'POST');
      assert.ok(kopf['API-Key'] && kopf['API-Sign']);
      const p = new URLSearchParams(koerper);
      const m = url.split('/').pop();
      k.aufrufe.push({ m, p: Object.fromEntries(p) });
      let result;
      if (m === 'Balance') result = { ZEUR: '1.00', XXBT: k.bestand };
      else if (m === 'AddOrder') {
        if (p.get('validate') === 'true') result = { descr: { order: `sell ${p.get('volume')} XBTEUR @ market` } };
        else {
          const txid = 'OABCDE-' + (Object.keys(k.auftraege).length + 1);
          k.auftraege[txid] = { status: 'open', vol_exec: '0', cost: '0', fee: '0', descr: { pair: 'XBTEUR' } };
          result = { txid: [txid], descr: { order: 'sell' } };
        }
      } else if (m === 'QueryOrders') {
        result = Object.fromEntries(p.get('txid').split(',').map((t) => [t, k.auftraege[t]]));
      }
      return { status: 200, body: Buffer.from(JSON.stringify({ error: [], result })) };
    },
  };
  return k;
}

function aufbau(verkauf = {}) {
  const dir = tempVerzeichnis();
  const uhr = testUhr();
  const buchhaltung = new Buchhaltung({ verzeichnis: path.join(dir, 'buchhaltung'), jetzt: uhr.jetzt });
  const fake = fakeKraken();
  const kraken = new KrakenClient({ anfrage: fake.anfrage, apiKey: 'schluessel', apiSecret: Buffer.from('geheim').toString('base64'), jetzt: uhr.jetzt });
  const konfig = {
    modus: 'kraken',
    zeitplan: 'schwellenwert',
    stundeUtc: 3,
    mindestAbstandMinuten: 60,
    ...verkauf,
    kraken: { waehrung: 'BTC', schwellenwert: '0.001', reserve: '0', nurProbelauf: false, ...(verkauf.kraken || {}) },
  };
  const modul = new Verkaufsmodul({ konfig, datenVerzeichnis: dir, buchhaltung, kraken, jetzt: uhr.jetzt });
  return { modul, fake, buchhaltung, uhr };
}

describe('Verkaufsmodul', () => {
  it('unter dem Schwellenwert passiert nichts', async () => {
    const { modul, fake } = aufbau();
    fake.bestand = '0.0005000000';
    const r = await modul.lauf();
    assert.equal(r.verkauft, false);
    assert.ok(!fake.aufrufe.some((a) => a.m === 'AddOrder'));
  });

  it('Probelauf (validate) verkauft nichts und bucht nichts', async () => {
    const { modul, fake, buchhaltung } = aufbau({ kraken: { nurProbelauf: true } });
    fake.bestand = '0.0123456789';
    const r = await modul.lauf();
    assert.equal(r.grund, 'probelauf');
    assert.equal(r.volumen, '0.01234567');
    assert.equal(fake.aufrufe.find((a) => a.m === 'AddOrder').p.validate, 'true');
    assert.equal(buchhaltung.lesen('verkaeufe').length, 0);
  });

  it('verkauft ueber dem Schwellenwert und bucht nach Ausfuehrung genau einmal', async () => {
    const { modul, fake, buchhaltung, uhr } = aufbau({ kraken: { reserve: '0.0001' } });
    fake.bestand = '0.0020000000';
    const r = await modul.lauf();
    assert.equal(r.verkauft, true);
    const auftrag = fake.aufrufe.find((a) => a.m === 'AddOrder').p;
    assert.deepEqual([auftrag.pair, auftrag.type, auftrag.ordertype, auftrag.volume], ['XBTEUR', 'sell', 'market', '0.00190000']);
    assert.equal(buchhaltung.lesen('verkaeufe').length, 0, 'noch nicht ausgefuehrt');
    Object.assign(fake.auftraege[r.txid], { status: 'closed', vol_exec: '0.00190000', cost: '138.70', fee: '0.55', closetm: 1_790_000_000 });
    fake.bestand = '0.0001000000';
    uhr.vor(61 * 60_000);
    await modul.lauf();
    await modul.lauf();
    const v = buchhaltung.lesen('verkaeufe');
    assert.equal(v.length, 1);
    assert.deepEqual([v[0].waehrung, v[0].mengeCoin, v[0].erloesEur, v[0].gebuehrEur, v[0].dienst, v[0].referenz, v[0].quelle], ['BTC', '0.00190000', '138.70', '0.55', 'Kraken', r.txid, 'kraken']);
  });

  it('taeglicher Zeitplan: hoechstens ein Lauf pro Tag ab der eingestellten Stunde', async () => {
    const { modul, fake, uhr } = aufbau({ zeitplan: 'taeglich', stundeUtc: 13, kraken: { nurProbelauf: true } });
    fake.bestand = '0.01';
    assert.equal(await modul.lauf(), null, '12:00 UTC ist zu frueh');
    uhr.vor(2 * 3_600_000);
    assert.equal((await modul.lauf()).grund, 'probelauf');
    assert.equal(await modul.lauf(), null, 'heute schon gelaufen');
  });

  it('manueller Modus tut nichts automatisch', async () => {
    const { modul, fake } = aufbau({ modus: 'manuell' });
    fake.bestand = '1.0';
    assert.equal(await modul.lauf(), null);
    assert.equal(fake.aufrufe.length, 0);
  });
});

describe('Kraken-Schluessel vor dem Einsatz pruefen', () => {
  const ERLAUBT = { Balance: true, QueryOrders: true, AddOrder: true, WithdrawMethods: false };
  /** Attrappe auf Ebene von KrakenClient.privat: Rechte wie bei einem echten Schluessel. */
  function schluessel(rechte, { netzFehler = null } = {}) {
    const aufrufe = [];
    return {
      aufrufe,
      async privat(m, params = {}) {
        aufrufe.push({ m, params });
        if (netzFehler && netzFehler === m) throw new Error('Zeitueberschreitung beim Verbindungsaufbau ueber Tor');
        if (!rechte[m]) throw new Error('Kraken: EGeneral:Permission denied');
        if (m === 'QueryOrders') throw new Error('Kraken: EOrder:Invalid order');
        if (m === 'AddOrder') {
          assert.equal(params.validate, 'true', 'AddOrder nur als Probe');
          return { descr: { order: 'sell 0.0001 XBTEUR @ market' } };
        }
        return {};
      },
    };
  }

  it('richtiger Schluessel (ohne Auszahlungsrecht) besteht - und nichts wird ausgefuehrt', async () => {
    const k = schluessel(ERLAUBT);
    const r = await krakenSchluesselPruefen(k);
    assert.equal(r.ok, true, r.meldungen.join(' | '));
    assert.ok(r.meldungen.some((m) => /kein Auszahlungsrecht/.test(m)));
    assert.deepEqual(k.aufrufe.map((a) => a.m), ['Balance', 'WithdrawMethods', 'QueryOrders', 'AddOrder']);
  });

  it('Schluessel mit Auszahlungsrecht wird abgelehnt', async () => {
    const r = await krakenSchluesselPruefen(schluessel({ ...ERLAUBT, WithdrawMethods: true }));
    assert.equal(r.ok, false);
    assert.ok(r.meldungen.some((m) => /GEFAHR.*AUSZAHLEN/.test(m)));
  });

  it('fehlendes Auftragsrecht oder Abfragerecht faellt durch', async () => {
    assert.equal((await krakenSchluesselPruefen(schluessel({ ...ERLAUBT, AddOrder: false }))).ok, false);
    assert.equal((await krakenSchluesselPruefen(schluessel({ ...ERLAUBT, QueryOrders: false }))).ok, false);
  });

  it('ohne Guthabenrecht wird gar nicht weiter geprueft', async () => {
    const k = schluessel({ ...ERLAUBT, Balance: false });
    const r = await krakenSchluesselPruefen(k);
    assert.equal(r.ok, false);
    assert.deepEqual(k.aufrufe.map((a) => a.m), ['Balance']);
  });

  it('unklare Antwort beim Auszahlungsrecht (Netz/Tor) gilt als nicht bestanden', async () => {
    const r = await krakenSchluesselPruefen(schluessel(ERLAUBT, { netzFehler: 'WithdrawMethods' }));
    assert.equal(r.ok, false);
    assert.ok(r.meldungen.some((m) => /UNKLAR/.test(m)));
  });

  it('Formpruefung des Schluesselpaars', () => {
    const geheim = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
    assert.equal(krakenZugangFehler('Ab12+cd/Ef34GhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMn', geheim), null);
    assert.match(krakenZugangFehler('', geheim), /API-Key/);
    assert.match(krakenZugangFehler('Ab12 cd', geheim), /API-Key/);
    assert.match(krakenZugangFehler('Ab12cdEf34GhIjKlMnOpQrSt', geheim.slice(0, 80)), /Private Key/);
    assert.match(krakenZugangFehler('Ab12cdEf34GhIjKlMnOpQrSt', Buffer.alloc(32).toString('base64')), /Private Key/);
  });
});
