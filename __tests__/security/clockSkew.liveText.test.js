// Audit 2026-10-19 (T6): Geht die Uhr des Absenders falsch (>15 min nach bzw.
// >5 min vor), wurde jede Textnachricht auf dem Live-Pfad verworfen - ohne
// Empfangsbestaetigung, also endlose Wiederholung aus der Warteschlange und
// nie zugestellt. Jetzt: zugestellt, angezeigt mit der Empfangszeit.
const crypto = require('crypto');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const { WebRTCManager } = require('../../WebRTCManager');
const { encryptMsg } = require('../../MessageCrypto');

async function zustellen(time) {
  const empfangen = [];
  const secret = crypto.randomBytes(32).toString('base64');
  const rtc = new WebRTCManager((m) => empfangen.push(m), () => {}, () => {});
  rtc.sharedSecret = secret;
  rtc.keyExchangeDone = true;
  const channel = { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null };
  rtc._setupDataChannel(channel);
  const enc = await encryptMsg(JSON.stringify({ type: 'text', id: 'm1', text: 'Hallo', time }), secret);
  await channel.onmessage({ data: JSON.stringify({ type: 'encrypted', data: enc }) });
  rtc.close();
  return empfangen.filter((m) => m.type === 'text');
}

test.each([
  ['Uhr des Absenders 2 h nach', -2 * 3600 * 1000],
  ['Uhr des Absenders 1 h vor', 3600 * 1000],
])('%s: Nachricht kommt an, mit Empfangszeit', async (_n, versatz) => {
  const vorher = Date.now();
  const texte = await zustellen(Date.now() + versatz);
  expect(texte).toHaveLength(1);
  expect(texte[0].text).toBe('Hallo');
  expect(texte[0].time).toBeGreaterThanOrEqual(vorher);
  expect(texte[0].time).toBeLessThanOrEqual(Date.now());
});

test('normale Uhr: Zeitstempel des Absenders bleibt', async () => {
  const t = Date.now() - 60 * 1000;
  const texte = await zustellen(t);
  expect(texte[0].time).toBe(t);
});
