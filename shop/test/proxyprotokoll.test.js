// PROXY-Protokoll v1 von tor (HiddenServiceExportCircuitID haproxy): Kreis-
// Kennung je Verbindung; ohne Kopf normales HTTP (Audit 2026-10-19, S2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { kreisAusZeile } from '../src/proxyprotokoll.js';
import { lauschen } from '../src/app.js';

test('Kreis-Kennung aus der Zeile von tor', () => {
  assert.equal(kreisAusZeile('PROXY TCP6 fc00:dead:beef:4dad::0:2a ::1 65535 80'), '0:2a');
  assert.equal(kreisAusZeile('PROXY TCP6 fc00:dead:beef:4dad::ffff:ffff ::1 1 80'), 'ffff:ffff');
  assert.equal(kreisAusZeile('PROXY TCP4 1.2.3.4 5.6.7.8 1 80'), null);
  assert.equal(kreisAusZeile('PROXY TCP6 2001:db8::1 ::1 1 80'), null);
});

async function anfrage(port, vorspann) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(vorspann + 'GET /x HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    });
    let text = '';
    s.on('data', (d) => { text += d; });
    s.on('end', () => resolve(text));
    s.on('error', reject);
  });
}

test('mit und ohne PROXY-Kopf: Anfrage kommt an, Kreis steht am Socket', async () => {
  const gesehen = [];
  const server = http.createServer((req, res) => { gesehen.push(req.socket.malachiKreis); res.end('ok'); });
  const netz = await new Promise((r) => { const n = lauschen(server, 0, '127.0.0.1', () => r(n)); });
  const port = netz.address().port;
  try {
    assert.match(await anfrage(port, 'PROXY TCP6 fc00:dead:beef:4dad::0:7 ::1 4 80\r\n'), /200 OK[\s\S]*ok$/);
    assert.match(await anfrage(port, ''), /200 OK[\s\S]*ok$/);
    assert.deepEqual(gesehen, ['0:7', null]);
  } finally {
    netz.close();
    server.close();
  }
});
