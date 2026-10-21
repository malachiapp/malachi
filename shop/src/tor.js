// Minimaler HTTP(S)-Abruf ueber den SOCKS5-Proxy von Tor.
//
// Der Zielname (z. B. die Onion-Adresse von mempool.space) wird als Domainname
// an Tor uebergeben (SOCKS5 ATYP 0x03) - es findet KEINE lokale DNS-Aufloesung
// statt. Ohne funktionierendes Tor schlaegt jeder Abruf fehl (kein stiller
// Rueckfall auf eine direkte Verbindung).

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const SOCKS_FEHLER = {
  1: 'allgemeiner Fehler',
  2: 'Verbindung nicht erlaubt',
  3: 'Netz nicht erreichbar',
  4: 'Ziel nicht erreichbar',
  5: 'Verbindung abgelehnt',
  6: 'TTL abgelaufen',
  7: 'Befehl nicht unterstuetzt',
  8: 'Adresstyp nicht unterstuetzt',
};

/** Baut ueber SOCKS5 eine TCP-Verbindung zu zielHost:zielPort auf. */
export function socks5Verbinden({ socksHost, socksPort, zielHost, zielPort, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const name = Buffer.from(zielHost, 'ascii');
    if (name.length === 0 || name.length > 255) {
      reject(new Error('Ungueltiger Zielname'));
      return;
    }
    const socket = net.connect({ host: socksHost, port: socksPort });
    let puffer = Buffer.alloc(0);
    let phase = 'gruss';
    let erledigt = false;

    const fertig = (fehler) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(timer);
      socket.removeListener('data', aufDaten);
      socket.removeListener('error', aufFehler);
      socket.removeListener('close', aufEnde);
      if (fehler) {
        socket.destroy();
        reject(fehler);
      } else {
        resolve(socket);
      }
    };
    const aufFehler = (e) => fertig(new Error('Tor-SOCKS nicht erreichbar: ' + (e.code || e.message)));
    const aufEnde = () => fertig(new Error('Tor-SOCKS hat die Verbindung geschlossen'));
    const timer = setTimeout(() => fertig(new Error('Zeitueberschreitung beim Verbindungsaufbau ueber Tor')), timeoutMs);

    const aufDaten = (stueck) => {
      puffer = Buffer.concat([puffer, stueck]);
      if (puffer.length > 600) return fertig(new Error('SOCKS-Antwort zu lang'));
      if (phase === 'gruss') {
        if (puffer.length < 2) return;
        if (puffer[0] !== 0x05 || puffer[1] !== 0x00) return fertig(new Error('SOCKS5-Anmeldung abgelehnt'));
        puffer = puffer.subarray(2);
        phase = 'verbinden';
        const port = Buffer.from([(zielPort >> 8) & 0xff, zielPort & 0xff]);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, port]));
      }
      if (phase === 'verbinden') {
        if (puffer.length < 5) return;
        if (puffer[0] !== 0x05) return fertig(new Error('Ungueltige SOCKS5-Antwort'));
        if (puffer[1] !== 0x00) {
          return fertig(new Error('Tor konnte das Ziel nicht erreichen: ' + (SOCKS_FEHLER[puffer[1]] || 'Code ' + puffer[1])));
        }
        let laenge;
        if (puffer[3] === 0x01) laenge = 4 + 4 + 2;
        else if (puffer[3] === 0x04) laenge = 4 + 16 + 2;
        else if (puffer[3] === 0x03) laenge = 4 + 1 + puffer[4] + 2;
        else return fertig(new Error('Ungueltiger Adresstyp in SOCKS5-Antwort'));
        if (puffer.length < laenge) return;
        const rest = puffer.subarray(laenge);
        fertig(null);
        if (rest.length) socket.unshift(rest);
      }
    };

    socket.on('data', aufDaten);
    socket.on('error', aufFehler);
    socket.on('close', aufEnde);
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}

/**
 * HTTP(S)-Anfrage (Standard GET) ueber Tor.
 * @returns {Promise<{status: number, body: Buffer}>}
 */
export function holeUeberTor(
  url,
  { socksHost = '127.0.0.1', socksPort = 9050, timeoutMs = 60_000, maxBytes = 2 * 1024 * 1024, methode = 'GET', kopf = {}, koerper = null } = {},
) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('Ungueltige URL'));
      return;
    }
    const istHttps = u.protocol === 'https:';
    if (!istHttps && u.protocol !== 'http:') {
      reject(new Error('Nur http/https erlaubt'));
      return;
    }
    // Unverschluesseltes HTTP nur zu Onion-Diensten (dort verschluesselt Tor Ende-zu-Ende).
    if (!istHttps && !u.hostname.endsWith('.onion')) {
      reject(new Error('Unverschluesseltes HTTP nur zu .onion-Adressen erlaubt'));
      return;
    }
    const port = Number(u.port) || (istHttps ? 443 : 80);
    let erledigt = false;
    const ende = (fehler, wert) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(timer);
      if (fehler) reject(fehler);
      else resolve(wert);
    };

    const modul = istHttps ? https : http;
    const anfrage = modul.request({
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method: methode,
      headers: {
        Host: u.host,
        Accept: 'application/json, text/plain;q=0.9',
        'User-Agent': 'Mozilla/5.0',
        Connection: 'close',
        ...kopf,
        ...(koerper !== null ? { 'Content-Length': Buffer.byteLength(koerper) } : {}),
      },
      // Kein Agent: die Verbindung wird ausschliesslich ueber SOCKS5 aufgebaut.
      createConnection: (_opts, rueckruf) => {
        socks5Verbinden({ socksHost, socksPort, zielHost: u.hostname, zielPort: port, timeoutMs })
          .then((socket) => {
            if (!istHttps) return rueckruf(null, socket);
            const t = tls.connect({ socket, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
            t.once('secureConnect', () => rueckruf(null, t));
            t.once('error', (e) => rueckruf(e));
          })
          .catch((e) => rueckruf(e));
        return undefined;
      },
    });

    const timer = setTimeout(() => {
      anfrage.destroy(new Error('Zeitueberschreitung beim Abruf ueber Tor'));
    }, timeoutMs);

    anfrage.on('error', (e) => ende(e));
    anfrage.on('response', (antwort) => {
      const teile = [];
      let groesse = 0;
      antwort.on('data', (stueck) => {
        groesse += stueck.length;
        if (groesse > maxBytes) {
          ende(new Error('Antwort zu gross'));
          anfrage.destroy();
          return;
        }
        teile.push(stueck);
      });
      antwort.on('end', () => ende(null, { status: antwort.statusCode, body: Buffer.concat(teile) }));
      antwort.on('error', (e) => ende(e));
      antwort.on('aborted', () => ende(new Error('Antwort abgebrochen')));
    });
    anfrage.end(koerper !== null ? koerper : undefined);
  });
}
