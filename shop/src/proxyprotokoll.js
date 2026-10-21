// PROXY-Protokoll v1 (HAProxy) - so meldet tor mit
// "HiddenServiceExportCircuitID haproxy" je Verbindung den Kreis, ueber den
// sie kommt: "PROXY TCP6 fc00:dead:beef:4dad::<kreis> ::1 <port> <port>\r\n".
// Damit lassen sich Grenzen je Tor-Kreis setzen statt nur fuer alle gemeinsam
// (Audit 2026-10-19, S2) - ein einzelner Kreis kann den Shop dann nicht mehr
// fuer alle anderen blockieren.
//
// Tolerant: beginnt eine Verbindung NICHT mit "PROXY " (lokale Tests, alte
// torrc ohne die Option), wird sie ganz normal als HTTP behandelt (Kreis
// unbekannt -> nur die gemeinsamen Grenzen). Der Shop lauscht nur auf
// 127.0.0.1; erreicht wird er ausschliesslich ueber tor.

import net from 'node:net';

const MAX_KOPF = 107;                 // Spezifikation v1: hoechstens 107 Bytes inkl. CRLF
const KOPF_ZEIT_MS = 5000;
const ZEILE = /^PROXY TCP6 fc00:dead:beef:4dad::([0-9a-f]{1,4}(?::[0-9a-f]{1,4})?) ::1 \d{1,5} \d{1,5}$/i;

/** Kreis-Kennung aus der PROXY-Zeile (z. B. "0:2a") oder null. */
export function kreisAusZeile(zeile) {
  const m = ZEILE.exec(zeile);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Netzserver, der den optionalen PROXY-Kopf liest, die Kreis-Kennung als
 * socket.malachiKreis ablegt und die Verbindung dann an den HTTP-Server gibt.
 */
export function proxyProtokollServer(httpServer) {
  return net.createServer((socket) => {
    let puffer = Buffer.alloc(0);
    let fertig = false;
    const zeitgeber = setTimeout(() => socket.destroy(), KOPF_ZEIT_MS);
    const weiter = (rest, kreis) => {
      fertig = true;
      clearTimeout(zeitgeber);
      socket.removeListener('data', lesen);
      socket.malachiKreis = kreis;
      if (rest.length) socket.unshift(rest);
      httpServer.emit('connection', socket);
    };
    const lesen = (stueck) => {
      if (fertig) return;
      puffer = Buffer.concat([puffer, stueck]);
      if (puffer.length >= 6 && puffer.subarray(0, 6).toString('latin1') !== 'PROXY ') return weiter(puffer, null);
      if (puffer.length < 6) return;
      const ende = puffer.indexOf('\r\n');
      if (ende < 0) {
        if (puffer.length > MAX_KOPF) socket.destroy();
        return;
      }
      const kreis = kreisAusZeile(puffer.subarray(0, ende).toString('latin1'));
      weiter(puffer.subarray(ende + 2), kreis);
    };
    socket.on('data', lesen);
    socket.on('error', () => socket.destroy());
  });
}
