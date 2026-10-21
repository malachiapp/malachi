// CHAOS/RESILIENCE PASS - "Duplicate requests", "Repeated messages" (siehe
// Task-Mandat): dedupliziert die Client-Pufferschicht (RTCStore.js /
// RTCStore.ts, echter Produktionscode, direkt importiert) identische,
// zweifach zugestellte Nachrichten, oder landen sie zweimal im Puffer/Chat?
//
// Die frueheren Black-Box-Tests gegen relay.js (Idempotenz von /packet,
// /call/signal, /phone/*) sind mit der serverlosen Umstellung (Okt. 2026)
// samt relay.js entfallen.

// ═══════════════════════════════════════════════════════════════════════
// RTCStore (echter Produktionscode) - Client-seitige Pufferung
// dedupliziert NICHT nach Inhalt
// ═══════════════════════════════════════════════════════════════════════

describe('CHAOS: RTCStore.js (nativ) - dieselbe entschluesselte Nachricht zweimal ueber onMessage zugestellt', () => {
  let RTCStore;
  beforeEach(() => {
    jest.resetModules();
    RTCStore = require('../../RTCStore').default;
  });

  test('kein Listener aktiv (App im Hintergrund/Chat nicht offen): zwei identische text-Nachrichten (gleiche msgId) landen nur EINMAL im buffer - Dedup in RTCStore (Warteschlangen-Wiederholung)', () => {
    const chatId = 'contact_dup_native';
    const fakeRtc = { chatId, onConnected: null, onSharedSecretSet: null };
    RTCStore.setConnection(chatId, fakeRtc);
    // setMessageListener bewusst NICHT gesetzt - simuliert genau das im Task
    // beschriebene Szenario: Relay-Wake feuert, Client pollt und verarbeitet
    // die Nachricht, dann feuert (bevor irgendein serverseitiges Loeschen
    // relevant wird) ZUSAETZLICH der periodische Fallback-Poll oder die
    // Live-P2P-Zustellung mit exakt demselben, bereits entschluesselten
    // Original-Objekt (z.B. weil Sender sowohl live als auch per
    // Relay-Fallback sendete und beide Wege beim Empfaenger ankommen).
    const sameDecryptedMessage = { type: 'text', text: 'Hallo', time: Date.now(), msgId: 'm1' };
    fakeRtc.onMessage(sameDecryptedMessage);
    fakeRtc.onMessage({ ...sameDecryptedMessage }); // zweite, inhaltlich identische Zustellung

    const buffered = RTCStore.getBuffered(chatId);
    // Frueher landeten beide Kopien im Puffer (zwei Chat-Bubbles). Seit der
    // Warteschlange mit Empfangsbestaetigung (BackgroundSync.flushQueue sendet
    // ohne Bestaetigung erneut) verwirft RTCStore Duplikate nach msgId.
    expect(buffered.length).toBe(1);
    expect(buffered[0].msgId).toBe('m1');
  });

  test('AKTIVER Listener (Chat gerade offen): der Dedup-Schutz gilt auch fuer den Live-Callback-Pfad, nicht nur den Puffer', () => {
    const chatId = 'contact_dup_native_live';
    const fakeRtc = { chatId };
    RTCStore.setConnection(chatId, fakeRtc);
    const received = [];
    RTCStore.setMessageListener(chatId, (msg) => received.push(msg));

    const msg = { type: 'text', text: 'Doppelt?', time: Date.now(), msgId: 'm2' };
    fakeRtc.onMessage(msg);
    fakeRtc.onMessage({ ...msg });

    expect(received.length).toBe(1);
  });
});

describe('CHAOS: RTCStore.ts (web) - identisches Verhalten, keine Dedup-Schicht', () => {
  let RTCStore;
  beforeEach(() => {
    jest.resetModules();
    RTCStore = require('../../web/src/lib/RTCStore.ts').default;
  });

  test('kein Listener aktiv: dieselbe Nachricht zweimal ueber onMessage zugestellt landet zweimal im buffer', () => {
    const chatId = 'contact_dup_web';
    const fakeRtc = { chatId };
    RTCStore.setConnection(chatId, fakeRtc);

    const msg = { type: 'text', text: 'Hallo Web', time: Date.now(), msgId: 'w1' };
    fakeRtc.onMessage(msg);
    fakeRtc.onMessage({ ...msg });

    const buffered = RTCStore.getBuffered(chatId);
    expect(buffered.length).toBe(2);
  });
});
