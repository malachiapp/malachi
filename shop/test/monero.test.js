// Monero-Zahlungsweg: Digest-Login gegen wallet-rpc, Auswertung von get_transfers,
// Startpruefung (richtiges Wallet, view-only).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { digestAntwort, herausforderungenLesen } from '../src/zahlung/digest.js';
import { MoneroZahlungsweg, walletRpcTransport, WalletRpcFehler, istMoneroHauptadresse } from '../src/zahlung/monero.js';
import { FakeWallet, TEST_HAUPTADRESSE, testAdresse } from './hilfen.js';

describe('HTTP-Digest (RFC 2617)', () => {
  it('Beispiel aus RFC 2617 Abschnitt 3.5', () => {
    const { antwort } = digestAntwort({
      herausforderung: { realm: 'testrealm@host.com', qop: 'auth,auth-int', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41' },
      benutzer: 'Mufasa',
      passwort: 'Circle Of Life',
      methode: 'GET',
      uri: '/dir/index.html',
      cnonce: '0a4f113b',
      nc: '00000001',
    });
    assert.equal(antwort, '6629fae49393a05397450978507c4ef1');
  });

  it('liest mehrere Herausforderungen', () => {
    const h = herausforderungenLesen(['Digest qop="auth",algorithm=SHA-256,realm="monero-rpc",nonce="abc",stale=false', 'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="def"']);
    assert.equal(h.length, 2);
    assert.equal(h[0].algorithm, 'SHA-256');
    assert.equal(h[1].nonce, 'def');
  });
});

describe('wallet-rpc-Transport mit Digest-Login', () => {
  let server;
  let port;
  let algorithmus = 'MD5';
  const nonce = crypto.randomBytes(8).toString('hex');
  const h = (a, t) => crypto.createHash(a === 'MD5' ? 'md5' : 'sha256').update(t).digest('hex');

  before(async () => {
    server = http.createServer((req, res) => {
      let koerper = '';
      req.on('data', (d) => (koerper += d));
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
        const ha1 = h(algorithmus, `shop:monero-rpc:geheim`);
        const ha2 = h(algorithmus, `POST:/json_rpc`);
        const erwartet = h(algorithmus, `${ha1}:${nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`);
        if (!auth.startsWith('Digest ') || p.response !== erwartet || p.username !== 'shop') {
          res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth",algorithm=${algorithmus},realm="monero-rpc",nonce="${nonce}",stale=false` });
          return res.end();
        }
        const anfrage = JSON.parse(koerper);
        const antwort = anfrage.method === 'get_height' ? { result: { height: 123 } } : { error: { code: -1, message: 'Methode unbekannt' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: anfrage.id, jsonrpc: '2.0', ...antwort }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  it('meldet sich mit MD5 und SHA-256 an', async () => {
    for (const a of ['MD5', 'SHA-256']) {
      algorithmus = a;
      const rpc = walletRpcTransport({ url: `http://127.0.0.1:${port}/json_rpc`, benutzer: 'shop', passwort: 'geheim' });
      assert.deepEqual(await rpc('get_height'), { height: 123 });
    }
  });

  it('falsches Passwort und RPC-Fehler werden sauber gemeldet', async () => {
    algorithmus = 'MD5';
    const falsch = walletRpcTransport({ url: `http://127.0.0.1:${port}/json_rpc`, benutzer: 'shop', passwort: 'falsch' });
    await assert.rejects(falsch('get_height'), /Anmeldung abgelehnt/);
    const rpc = walletRpcTransport({ url: `http://127.0.0.1:${port}/json_rpc`, benutzer: 'shop', passwort: 'geheim' });
    await assert.rejects(rpc('unbekannt'), (e) => e instanceof WalletRpcFehler && e.code === -1);
  });

  it('nicht erreichbares wallet-rpc', async () => {
    const rpc = walletRpcTransport({ url: 'http://127.0.0.1:1/json_rpc', benutzer: 'a', passwort: 'b', timeoutMs: 2000 });
    await assert.rejects(rpc('get_height'), /nicht erreichbar/);
  });
});

describe('MoneroZahlungsweg', () => {
  const weg = (w) => new MoneroZahlungsweg({ rpc: w.rpc, hauptadresse: TEST_HAUPTADRESSE });

  it('Adressformat', () => {
    assert.ok(istMoneroHauptadresse(TEST_HAUPTADRESSE));
    assert.ok(!istMoneroHauptadresse(testAdresse('8', 'x')));
    assert.ok(!istMoneroHauptadresse('4_HIER_EINTRAGEN'));
  });

  it('Startpruefung: richtiges Wallet und view-only', async () => {
    const w = new FakeWallet();
    assert.deepEqual(await weg(w).pruefen(), { hoehe: 3_500_000 });
    const fremd = new FakeWallet(testAdresse('4', 'anderes-wallet'));
    await assert.rejects(weg(fremd).pruefen(), /gehoert nicht/);
    const vollesWallet = new FakeWallet();
    vollesWallet.viewOnly = false;
    await assert.rejects(weg(vollesWallet).pruefen(), /NICHT view-only/);
  });

  it('neue Subadressen und Wiederverwendbarkeit', async () => {
    const w = new FakeWallet();
    const m = weg(w);
    const a = await m.frischeAdresse();
    const b = await m.frischeAdresse();
    assert.deepEqual([a.index, b.index], [1, 2]);
    assert.match(a.adresse, /^8/);
    assert.equal(await m.istUnbenutzt(1), true);
    w.zahlung(1, 5);
    assert.equal(await m.istUnbenutzt(1), false);
    assert.equal(await m.istUnbenutzt(2), true);
  });

  it('Zahlungsstand: Pool, Bestaetigungen, zeitgesperrte Ausgaenge, Double-Spend', async () => {
    const w = new FakeWallet();
    const m = weg(w);
    await m.frischeAdresse();
    await m.frischeAdresse();
    w.zahlung(1, 1_000_000_000); // im Pool
    let s = await m.zahlungsstand(1, null, 1);
    assert.deepEqual([s.empfangen, s.bestaetigt, s.bestaetigungen], [1_000_000_000, 0, 0]);
    w.zahlung(1, 2_000_000_000, { hoehe: w.hoehe - 2 }); // 3 Bestaetigungen
    w.zahlung(1, 7_000_000_000, { hoehe: w.hoehe, unlock_time: 9_999_999 }); // zeitgesperrt -> zaehlt nicht
    w.zahlung(1, 9_000_000_000, { double_spend_seen: true }); // Double-Spend im Pool -> zaehlt nicht
    w.zahlung(2, 4_000_000_000, { hoehe: w.hoehe }); // andere Subadresse
    s = await m.zahlungsstand(1, null, 1);
    assert.equal(s.empfangen, 3_000_000_000);
    assert.equal(s.bestaetigt, 2_000_000_000);
    assert.equal(s.gesperrt, 7_000_000_000);
    assert.equal(s.txids.length, 2);
    s = await m.zahlungsstand(1, null, 4); // 4 Bestaetigungen verlangt
    assert.equal(s.bestaetigt, 0);
  });

  it('Zahlungs-URI', () => {
    assert.equal(weg(new FakeWallet()).uri('8abc', '0.006163'), 'monero:8abc?tx_amount=0.006163');
  });
});

describe('wallet-rpc wie epee: Nonce gilt nur auf der eigenen TCP-Verbindung', () => {
  // monero-wallet-rpc merkt sich die Nonce je Verbindung (epee http_server_auth).
  // Kommt die Antwort ueber eine neue Verbindung, ist sie dort unbekannt -> 401.
  let server;
  let port;
  const nonces = new WeakMap();
  const md5 = (t) => crypto.createHash('md5').update(t).digest('hex');

  before(async () => {
    server = http.createServer((req, res) => {
      let koerper = '';
      req.on('data', (d) => (koerper += d));
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
        const nonce = nonces.get(req.socket);
        let ok = false;
        if (nonce && auth.startsWith('Digest ') && p.nonce === nonce && p.username === 'shop') {
          let ha1 = md5('shop:monero-rpc:geheim');
          if (/-sess$/i.test(p.algorithm || '')) ha1 = md5(`${ha1}:${nonce}:${p.cnonce}`);
          ok = p.response === md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5('POST:/json_rpc')}`);
        }
        if (!ok) {
          const neu = crypto.randomBytes(8).toString('hex');
          nonces.set(req.socket, neu);
          res.writeHead(401, [
            ['WWW-authenticate', `Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="${neu}",stale=false`],
            ['WWW-authenticate', `Digest qop="auth",algorithm=MD5-sess,realm="monero-rpc",nonce="${neu}",stale=false`],
          ]);
          return res.end('<html><head><title>Unauthorized</title></head><body><h1>401 Unauthorized</h1></body></html>');
        }
        const anfrage = JSON.parse(koerper);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: anfrage.id, jsonrpc: '2.0', result: { height: 7 } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  it('Herausforderung und Antwort laufen ueber dieselbe Verbindung, danach wird sie geschlossen', async () => {
    const rpc = walletRpcTransport({ url: `http://127.0.0.1:${port}/json_rpc`, benutzer: 'shop', passwort: 'geheim' });
    for (let i = 0; i < 3; i++) assert.deepEqual(await rpc('get_height'), { height: 7 });
    // Keine Verbindung bleibt offen (eigener Agent je Aufruf wird zerstoert).
    // Schliessen ist asynchron - unter Last kurz warten (hoechstens 2 s).
    let offen = -1;
    for (let i = 0; i < 40 && offen !== 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      offen = await new Promise((r) => server.getConnections((_, n) => r(n)));
    }
    assert.equal(offen, 0);
  });

  it('falsches Passwort bleibt abgelehnt', async () => {
    const rpc = walletRpcTransport({ url: `http://127.0.0.1:${port}/json_rpc`, benutzer: 'shop', passwort: 'falsch' });
    await assert.rejects(() => rpc('get_height'), /Anmeldung abgelehnt/);
  });
});

describe('Monero-Knoten: Pruefung und Umschalten auf Ersatzknoten', () => {
  const ERSATZ = ['b'.repeat(56) + '.onion:18089', 'c'.repeat(56) + '.onion:18089'];
  /** wallet-rpc-Attrappe: tote Knoten antworten auf refresh mit -38 (wie monero-wallet-rpc). */
  function rpcMit({ tot = new Set(), rpcWeg = false } = {}) {
    const k = { aktuell: 'conf', aufrufe: [] };
    k.rpc = async (m, params = {}) => {
      k.aufrufe.push(m);
      if (rpcWeg) throw new WalletRpcFehler('wallet-rpc nicht erreichbar: connect ECONNREFUSED 127.0.0.1:18082');
      if (m === 'set_daemon') {
        assert.equal(params.trusted, false, 'Knoten bleiben untrusted');
        assert.equal(params.proxy, undefined, 'kein eigener Proxy - wallet-rpc nutzt seinen Tor-Proxy');
        k.aktuell = params.address;
        return {};
      }
      if (m === 'refresh') {
        if (tot.has(k.aktuell)) throw new WalletRpcFehler('wallet-rpc: no connection to daemon', -38);
        return { blocks_fetched: 0, received_money: false };
      }
      throw new Error('unerwartet ' + m);
    };
    return k;
  }
  const weg = (k, ersatzKnoten = ERSATZ) => new MoneroZahlungsweg({ rpc: k.rpc, hauptadresse: TEST_HAUPTADRESSE, ersatzKnoten });

  it('antwortender Knoten: nichts umschalten', async () => {
    const k = rpcMit();
    assert.deepEqual(await weg(k).knotenPruefen(), { ok: true, gewechselt: false });
    assert.deepEqual(k.aufrufe, ['refresh']);
  });

  it('toter Knoten: Ersatzknoten der Reihe nach, bis einer antwortet', async () => {
    const k = rpcMit({ tot: new Set(['conf', ERSATZ[0]]) });
    const w = weg(k);
    assert.deepEqual(await w.knotenPruefen(), { ok: true, gewechselt: true });
    assert.equal(k.aktuell, ERSATZ[1]);
    // naechste Pruefung bleibt beim funktionierenden Knoten
    k.aufrufe.length = 0;
    assert.deepEqual(await w.knotenPruefen(), { ok: true, gewechselt: false });
    assert.deepEqual(k.aufrufe, ['refresh']);
  });

  it('alle tot oder keine Ersatzknoten: ok=false, kein Absturz', async () => {
    assert.deepEqual(await weg(rpcMit({ tot: new Set(['conf', ...ERSATZ]) })).knotenPruefen(), { ok: false, gewechselt: false });
    assert.deepEqual(await weg(rpcMit({ tot: new Set(['conf']) }), []).knotenPruefen(), { ok: false, gewechselt: false });
  });

  it('wallet-rpc selbst weg: Fehler, kein Umschalten', async () => {
    const k = rpcMit({ rpcWeg: true });
    await assert.rejects(() => weg(k).knotenPruefen(), /ECONNREFUSED/);
    assert.ok(!k.aufrufe.includes('set_daemon'));
  });
});
