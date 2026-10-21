// Abruf ueber Tor: SOCKS5 mit Domainnamen (keine lokale DNS-Aufloesung),
// GET und POST, Groessen- und Zeitlimits; mempool.space-Client mit Rueckfall.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { holeUeberTor, socks5Verbinden } from '../src/tor.js';
import { MempoolApi } from '../src/mempool.js';

const ONION = 'a'.repeat(56) + '.onion';

describe('SOCKS5 ueber Tor (Attrappe)', () => {
  let ziel;
  let socks;
  let zielPort;
  let socksPort;
  const anfragen = [];
  let antwortCode = 0;

  before(async () => {
    ziel = http.createServer((req, res) => {
      let koerper = '';
      req.on('data', (d) => (koerper += d));
      req.on('end', () => {
        if (req.url === '/gross') {
          res.end('x'.repeat(10_000));
          return;
        }
        // ohne Content-Length -> chunked
        res.write(JSON.stringify({ methode: req.method, pfad: req.url, host: req.headers.host, koerper, kopf: req.headers['x-test'] || null }));
        res.end();
      });
    });
    await new Promise((r) => ziel.listen(0, '127.0.0.1', r));
    zielPort = ziel.address().port;

    socks = net.createServer((c) => {
      let puffer = Buffer.alloc(0);
      let phase = 0;
      c.on('data', (d) => {
        puffer = Buffer.concat([puffer, d]);
        if (phase === 0 && puffer.length >= 3) {
          c.write(Buffer.from([5, 0]));
          puffer = puffer.subarray(3);
          phase = 1;
        }
        if (phase === 1 && puffer.length >= 5) {
          const atyp = puffer[3];
          const len = puffer[4];
          if (puffer.length < 5 + len + 2) return;
          anfragen.push({ atyp, name: puffer.subarray(5, 5 + len).toString(), port: puffer.readUInt16BE(5 + len) });
          const rest = puffer.subarray(7 + len);
          phase = 2;
          if (antwortCode) {
            c.end(Buffer.from([5, antwortCode, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const weiter = net.connect(zielPort, '127.0.0.1', () => {
            c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (rest.length) weiter.write(rest);
            c.removeAllListeners('data');
            c.pipe(weiter).pipe(c);
          });
        }
      });
      c.on('error', () => {});
    });
    await new Promise((r) => socks.listen(0, '127.0.0.1', r));
    socksPort = socks.address().port;
  });
  after(() => {
    ziel.close();
    socks.close();
  });

  it('GET an eine Onion-Adresse: Name geht als Domain (ATYP 3) an Tor', async () => {
    const r = await holeUeberTor(`http://${ONION}/api/blocks/tip/height?x=1`, { socksPort, timeoutMs: 5000 });
    assert.equal(r.status, 200);
    const d = JSON.parse(r.body);
    assert.equal(d.pfad, '/api/blocks/tip/height?x=1');
    assert.equal(d.host, ONION);
    assert.deepEqual(anfragen.at(-1), { atyp: 3, name: ONION, port: 80 });
  });

  it('POST mit Kopfzeilen und Koerper (fuer Kraken-API ueber Tor)', async () => {
    const r = await holeUeberTor(`http://${ONION}/0/private/Balance`, { socksPort, timeoutMs: 5000, methode: 'POST', kopf: { 'X-Test': 'ja', 'Content-Type': 'application/x-www-form-urlencoded' }, koerper: 'nonce=1' });
    const d = JSON.parse(r.body);
    assert.deepEqual([d.methode, d.koerper, d.kopf], ['POST', 'nonce=1', 'ja']);
  });

  it('Fehlerantwort von Tor, Groessenlimit, unverschluesseltes HTTP ins Clearnet', async () => {
    antwortCode = 4;
    await assert.rejects(holeUeberTor(`http://${ONION}/`, { socksPort, timeoutMs: 5000 }), /Ziel nicht erreichbar/);
    antwortCode = 0;
    await assert.rejects(holeUeberTor(`http://${ONION}/gross`, { socksPort, timeoutMs: 5000, maxBytes: 1000 }), /zu gross/);
    await assert.rejects(holeUeberTor('http://example.com/', { socksPort }), /nur zu \.onion/);
    await assert.rejects(holeUeberTor('ftp://x/', { socksPort }), /Nur http/);
  });

  it('Tor nicht erreichbar bzw. antwortet nicht', async () => {
    await assert.rejects(socks5Verbinden({ socksHost: '127.0.0.1', socksPort: 1, zielHost: ONION, zielPort: 80, timeoutMs: 2000 }), /nicht erreichbar/);
    const stumm = net.createServer(() => {});
    await new Promise((r) => stumm.listen(0, '127.0.0.1', r));
    await assert.rejects(socks5Verbinden({ socksHost: '127.0.0.1', socksPort: stumm.address().port, zielHost: ONION, zielPort: 80, timeoutMs: 300 }), /Zeitueberschreitung/);
    stumm.close();
  });
});

describe('MempoolApi (Bitcoin-Zahlungsweg)', () => {
  it('Rueckfall auf Clearnet nur, wenn eingeschaltet', async () => {
    const aufrufe = [];
    const holen = async (url) => {
      aufrufe.push(url);
      if (url.includes('.onion')) throw new Error('Onion nicht erreichbar');
      return { status: 200, body: Buffer.from('900000') };
    };
    const ohne = new MempoolApi({ holen, onionUrl: 'http://' + ONION, clearnetUrl: 'https://mempool.space' });
    await assert.rejects(ohne.blockhoehe(), /nicht erreichbar/);
    const mit = new MempoolApi({ holen, onionUrl: 'http://' + ONION, clearnetUrl: 'https://mempool.space', clearnetFallback: true });
    assert.equal(await mit.blockhoehe(), 900000);
    assert.deepEqual(aufrufe, [`http://${ONION}/api/blocks/tip/height`, `http://${ONION}/api/blocks/tip/height`, 'https://mempool.space/api/blocks/tip/height']);
  });

  it('weist unerwartete Antworten ab', async () => {
    const api = new MempoolApi({ holen: async () => ({ status: 200, body: Buffer.from('{"chain_stats":{}}') }), onionUrl: 'http://' + ONION });
    await assert.rejects(api.adressUebersicht('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'), /Antwortformat/);
    await assert.rejects(api.adressUebersicht('../../etc'), /Ungueltige Adresse/);
  });
});
