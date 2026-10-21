// HTTP-Digest-Authentifizierung (RFC 7616 / RFC 2617), wie sie monero-wallet-rpc
// mit --rpc-login verlangt. Unterstuetzt MD5, MD5-sess, SHA-256, SHA-256-sess
// (SHA-256 wird bevorzugt, falls angeboten).
//
// Wichtig: monero-wallet-rpc (epee) merkt sich die Nonce PRO TCP-VERBINDUNG.
// Herausforderung und Antwort muessen deshalb ueber dieselbe Verbindung
// laufen - Node 18 oeffnet ohne Keep-Alive-Agent fuer jede Anfrage eine neue,
// dann lehnt epee jede (an sich richtige) Antwort ab.

import crypto from 'node:crypto';
import http from 'node:http';

const ALGORITHMEN = { 'MD5': 'md5', 'MD5-SESS': 'md5', 'SHA-256': 'sha256', 'SHA-256-SESS': 'sha256' };

/** Zerlegt einen einzelnen WWW-Authenticate-Header in Herausforderungen. */
export function herausforderungenLesen(kopfzeilen) {
  const ergebnis = [];
  for (const zeile of kopfzeilen) {
    const re = /(\w+)\s+((?:[\w-]+=(?:"(?:[^"\\]|\\.)*"|[^,\s]*)\s*,?\s*)+)/g;
    let m;
    while ((m = re.exec(zeile))) {
      if (m[1].toLowerCase() !== 'digest') continue;
      const params = {};
      const pr = /([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
      let p;
      while ((p = pr.exec(m[2]))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
      ergebnis.push(params);
    }
  }
  return ergebnis;
}

const h = (algo, text) => crypto.createHash(algo).update(text, 'utf8').digest('hex');

/** Berechnet den Authorization-Header fuer eine Herausforderung. */
export function digestAntwort({ herausforderung, benutzer, passwort, methode, uri, cnonce = crypto.randomBytes(8).toString('hex'), nc = '00000001' }) {
  const algoName = (herausforderung.algorithm || 'MD5').toUpperCase();
  const algo = ALGORITHMEN[algoName];
  if (!algo) throw new Error('Nicht unterstuetzter Digest-Algorithmus: ' + algoName);
  const { realm = '', nonce = '' } = herausforderung;
  let ha1 = h(algo, `${benutzer}:${realm}:${passwort}`);
  if (algoName.endsWith('-SESS')) ha1 = h(algo, `${ha1}:${nonce}:${cnonce}`);
  const ha2 = h(algo, `${methode}:${uri}`);
  const qops = (herausforderung.qop || '').split(',').map((q) => q.trim());
  const mitQop = qops.includes('auth');
  const antwort = mitQop ? h(algo, `${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`) : h(algo, `${ha1}:${nonce}:${ha2}`);
  const teile = [
    `username="${benutzer}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${herausforderung.algorithm || 'MD5'}`,
    `response="${antwort}"`,
  ];
  if (mitQop) teile.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
  if (herausforderung.opaque !== undefined) teile.push(`opaque="${herausforderung.opaque}"`);
  return { kopf: 'Digest ' + teile.join(', '), antwort };
}

function anfrage({ host, port, pfad, koerper, kopf, timeoutMs, maxBytes, agent }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: pfad,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(koerper),
          ...(kopf ? { Authorization: kopf } : {}),
        },
        timeout: timeoutMs,
        agent,
      },
      (res) => {
        const teile = [];
        let n = 0;
        let zuGross = false;
        res.on('data', (d) => {
          n += d.length;
          if (n > maxBytes) {
            if (!zuGross) reject(new Error('Antwort zu gross'));
            zuGross = true;
            req.destroy();
            return;
          }
          teile.push(d);
        });
        res.on('end', () => {
          if (zuGross) return;
          const auth = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (res.rawHeaders[i].toLowerCase() === 'www-authenticate') auth.push(res.rawHeaders[i + 1]);
          }
          resolve({ status: res.statusCode, body: Buffer.concat(teile), auth });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Zeitueberschreitung')));
    req.on('error', reject);
    req.end(koerper);
  });
}

/** POST mit Digest-Authentifizierung (erst ohne, bei 401 mit Antwort auf die Herausforderung). */
export async function digestPost({ url, koerper, benutzer, passwort, timeoutMs = 30_000, maxBytes = 5 * 1024 * 1024 }) {
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error('Nur http:// zum lokalen wallet-rpc');
  // Eigener Agent je Aufruf: genau eine Verbindung, die fuer Herausforderung
  // und Antwort wiederverwendet und danach geschlossen wird.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const basis = { host: u.hostname, port: Number(u.port) || 80, pfad: u.pathname + u.search, koerper, timeoutMs, maxBytes, agent };
  try {
    let r = await anfrage(basis);
    if (r.status !== 401) return r;
    const hs = herausforderungenLesen(r.auth);
    if (!hs.length) throw new Error('wallet-rpc verlangt eine unbekannte Anmeldung');
    const wahl = hs.find((x) => /^SHA-256/i.test(x.algorithm || '')) || hs[0];
    const { kopf } = digestAntwort({ herausforderung: wahl, benutzer, passwort, methode: 'POST', uri: basis.pfad });
    r = await anfrage({ ...basis, kopf });
    if (r.status === 401) throw new Error('wallet-rpc: Anmeldung abgelehnt (RPC-Login pruefen)');
    return r;
  } finally {
    agent.destroy();
  }
}
