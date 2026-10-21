// Live-Test 2026-10-17: Ein Handy mit ausgeschaltetem Bildschirm schlaeft und
// sendet keine Fuellpakete. Die Gegenseite erklaerte die Direktverbindung nach
// 8 s Stille fuer tot - sie flatterte alle 20-30 s zwischen direkt und Tor.
// Jetzt: nach der Stille erst eine Nachfrage senden (weckt das schlafende
// Geraet); tot ist die Verbindung erst, wenn auch darauf nichts kommt.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { WebRTCManager } = require('../../WebRTCManager');

function makeRtc(transport) {
  const rtc = new WebRTCManager(() => {}, () => {}, () => {});
  rtc.transport = transport;
  rtc._sendProbe = jest.fn();
  rtc.close = jest.fn(() => { rtc._closed = true; });
  rtc._fireDisc = jest.fn();
  return rtc;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('direkt: nach Stille zuerst Nachfrage, nicht sofort schliessen; Antwort haelt die Verbindung', () => {
  const rtc = makeRtc('direct');
  rtc._startLivenessWatch();
  jest.advanceTimersByTime(12000);           // laenger still als 8 s
  expect(rtc._sendProbe).toHaveBeenCalledWith(true);
  expect(rtc.close).not.toHaveBeenCalled();
  // Gegenseite wacht auf und antwortet (jede eingehende Nachricht zaehlt).
  rtc._lastActivity = Date.now();
  rtc._probeSentAt = 0;
  jest.advanceTimersByTime(6000);
  expect(rtc.close).not.toHaveBeenCalled();
  clearInterval(rtc._livenessWatch);
});

test('direkt: auch auf die Nachfrage keine Antwort -> Verbindung tot', () => {
  const rtc = makeRtc('direct');
  rtc._startLivenessWatch();
  jest.advanceTimersByTime(12000);
  expect(rtc._sendProbe).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(12000);           // 10 s Nachfrage-Frist abgelaufen
  expect(rtc.close).toHaveBeenCalled();
  expect(rtc._fireDisc).toHaveBeenCalled();
  clearInterval(rtc._livenessWatch);
});

test('Tor: laengere Fristen (Stille 15 s + Nachfrage 20 s)', () => {
  const rtc = makeRtc('tor');
  rtc._startLivenessWatch();
  jest.advanceTimersByTime(18000);
  expect(rtc._sendProbe).toHaveBeenCalledWith(true);
  jest.advanceTimersByTime(12000);
  expect(rtc.close).not.toHaveBeenCalled();
  jest.advanceTimersByTime(14000);
  expect(rtc.close).toHaveBeenCalled();
  clearInterval(rtc._livenessWatch);
});

// Live-Test 2026-10-17: Die Gegenseite startete neu - ihre Tor-Reserve war
// sofort zu, die tote Direktverbindung wurde aber erst nach 10 s erkannt.
// probeNow(): sofort nachfragen, nach 5 s ohne jedes Paket tot.
test('probeNow: ohne jedes Paket binnen 5 s tot; kommt etwas an, bleibt sie', () => {
  const dead = makeRtc('direct');
  dead._lastActivity = Date.now();
  dead.probeNow('Test');
  expect(dead._sendProbe).toHaveBeenCalledWith(true);
  jest.advanceTimersByTime(5100);
  expect(dead.close).toHaveBeenCalled();
  expect(dead._fireDisc).toHaveBeenCalled();

  const alive = makeRtc('direct');
  alive.probeNow('Test');
  jest.advanceTimersByTime(1000);
  alive._lastActivity = Date.now();          // Antwort/Fuellpaket kommt an
  jest.advanceTimersByTime(5000);
  expect(alive.close).not.toHaveBeenCalled();
});

test('Tor-Reserve von der GEGENSEITE geschlossen: Direktverbindung wird sofort geprueft - eigenes Schliessen nicht', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'TorTransport.js'), 'utf8').replace(/\r\n/g, '\n');
  expect(src).toMatch(/_remoteClosed\(\) \{\n\s+if \(this\.readyState === 'closed'\) return;\n\s+this\.readyState = 'closed';\n\s+this\._closedByRemote = true;/);
  expect(src).toMatch(/if \(wasReserve && channel\._closedByRemote\) \{[\s\S]{0,200}active\.probeNow\?\.\('Tor-Reserve von der Gegenseite geschlossen'\)/);
  // close() (eigenes Schliessen) setzt den Merker nicht.
  const closeBody = src.slice(src.indexOf('  close() {\n    if (this.readyState === \'closed\') return;'), src.indexOf('  _remoteClosed() {'));
  expect(closeBody).not.toMatch(/_closedByRemote/);
});
