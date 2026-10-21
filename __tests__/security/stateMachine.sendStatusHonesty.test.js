// State-Machine-Sicherheitsreview Fund 7: WebRTCManager.sendMessage() lieferte
// vorher fuer zwei grundverschiedene Faelle dasselbe `true` zurueck - (a) die
// Nachricht wurde wirklich an einen offenen DataChannel uebergeben, (b) es
// gab noch kein Shared Secret, die Nachricht landete nur im nicht-
// dauerhaften pendingMsgs-Array. Ein App-Kill vor _flushPending() verlor (b)
// lautlos, obwohl die UI bereits "✓ gesendet" gezeigt hatte. Jetzt liefert
// die Funktion 'sent' | 'queued' | false, klar unterscheidbar - ohne neuen
// Netzwerk-Bestaetigungsschritt, reine lokale Ehrlichkeit ueber einen
// bereits vorhandenen Unterschied.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const { WebRTCManager: NativeWebRTCManager } = require('../../WebRTCManager');

function fakeChannel() {
  return { readyState: 'open', send: jest.fn(), onopen: null, onmessage: null, onclose: null };
}

describe('WebRTCManager (native) - ehrlicher sendMessage()-Rueckgabewert', () => {
  test('kein offener DataChannel -> false', () => {
    const rtc = new NativeWebRTCManager(() => {}, () => {}, () => {});
    // dataChannel bewusst nicht gesetzt (readyState undefined !== 'open')
    expect(rtc.sendMessage(JSON.stringify({ type: 'text', text: 'hi' }))).toBe(false);
  });

  test('offener Channel, aber noch KEIN Shared Secret -> "queued" (nicht "sent")', () => {
    const rtc = new NativeWebRTCManager(() => {}, () => {}, () => {});
    rtc.dataChannel = fakeChannel();
    expect(rtc.sharedSecret).toBeNull();
    const result = rtc.sendMessage(JSON.stringify({ type: 'text', text: 'hi', msgId: '1' }));
    expect(result).toBe('queued');
    expect(rtc.pendingMsgs.length).toBe(1); // landet im nicht-dauerhaften Array
    expect(rtc.dataChannel.send).not.toHaveBeenCalled(); // wurde NICHT wirklich gesendet
  });

  test('offener Channel MIT Shared Secret -> "sent" (wirklich uebergeben)', async () => {
    const rtc = new NativeWebRTCManager(() => {}, () => {}, () => {});
    rtc.dataChannel = fakeChannel();
    rtc.sharedSecret = require('crypto').randomBytes(32).toString('base64');
    const result = rtc.sendMessage(JSON.stringify({ type: 'text', text: 'hi', msgId: '2' }));
    expect(result).toBe('sent');
    expect(rtc.pendingMsgs.length).toBe(0); // NICHT im pendingMsgs-Array gelandet
    // encryptMsg().then(enc => dataChannel.send(...)) laeuft async - kurz warten
    await new Promise((r) => setTimeout(r, 50));
    expect(rtc.dataChannel.send).toHaveBeenCalled();
  });

  test('kyber_pubkey/kyber_ciphertext (Klartext-Handshake) -> immer "sent"', () => {
    const rtc = new NativeWebRTCManager(() => {}, () => {}, () => {});
    rtc.dataChannel = fakeChannel();
    const result = rtc.sendMessage(JSON.stringify({ type: 'system', subtype: 'kyber_pubkey', publicKey: 'x' }));
    expect(result).toBe('sent');
    expect(rtc.dataChannel.send).toHaveBeenCalled();
  });
});

describe('WebRTCManager (web) - ehrlicher sendMessage()-Rueckgabewert', () => {
  const { WebRTCManager: WebWebRTCManager } = require('../../web/src/lib/WebRTCManager.ts');

  test('offener Channel, aber noch KEIN Shared Secret -> "queued"', () => {
    const rtc = new WebWebRTCManager(() => {}, () => {}, () => {});
    rtc.dataChannel = fakeChannel();
    const result = rtc.sendMessage(JSON.stringify({ type: 'text', text: 'hi', msgId: '1' }));
    expect(result).toBe('queued');
    expect(rtc.pendingMsgs.length).toBe(1);
  });

  test('offener Channel MIT Shared Secret -> "sent"', async () => {
    const rtc = new WebWebRTCManager(() => {}, () => {}, () => {});
    rtc.dataChannel = fakeChannel();
    rtc.sharedSecret = require('crypto').randomBytes(32).toString('base64');
    const result = rtc.sendMessage(JSON.stringify({ type: 'text', text: 'hi', msgId: '2' }));
    expect(result).toBe('sent');
    expect(rtc.pendingMsgs.length).toBe(0);
  });
});
