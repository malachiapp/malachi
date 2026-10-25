// Update 1.1.0 -> STUN-Ausstieg: nichts darf verloren gehen oder still
// umgeschrieben werden. Nachgestellt wird der Speicher einer 1.1.0-Installation
// (Formate wie in 1.1.0); dann laufen die beim Start neuen bzw. geaenderten
// Teile dieser Version (Verbindungsweg laden, Umstellungs-Hinweis pruefen,
// Diagnose laden, Zeitanteil-Zaehler starten). Danach ist jeder Schluessel
// noch da und jeder Wert unveraendert - einzige Ausnahmen:
//   - eine gespeicherte Stufe 1 ("Schnell (mit STUN)") wird zu '2',
//   - neu hinzu kommt nur der Merker fuer den einmaligen Hinweis.
// Eine aktive Stufe 3 ("nur Tor") bleibt - auch ohne Lizenz.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const ES = require('react-native-encrypted-storage').default;
const CM = require('../../ConnectionMode');
const CS = require('../../ConnectionStats');
const { pcConfigForCalls } = require('../../WebRTCManager');

const MID = (c) => 'm_' + c.repeat(32);
const SNAPSHOT_1_1 = {
  setup_done: 'true',
  username: 'Alice',
  my_id: 'id_' + 'a'.repeat(24),
  group_self_id: MID('a'),
  contacts: JSON.stringify([
    { id: 'c_bob', name: 'Bob', theirName: 'Bob', groupMemberId: MID('b'), pinned: true, lastTs: 1760000000000, unread: 2, role: 'initiator', torOnion: 'b'.repeat(56) + '.onion' },
    { id: 'c_carol', name: 'Carol', groupMemberId: MID('c'), role: 'responder', torOnion: 'c'.repeat(56) + '.onion' },
  ]),
  chat_c_bob: JSON.stringify([
    { id: '1760000000001', text: 'Hi Bob', mine: true, time: '10:00', status: 'delivered' },
    // Standort aus 1.1.0 MIT Ortsnamen (Nominatim) - bleibt unveraendert.
    { id: '1760000000002', text: '📍 Standort', isLocation: true, lat: 52.52, lng: 13.405, address: 'Mitte, Berlin', mine: false, time: '10:01' },
  ]),
  shared_secret_c_bob: 'U0VDUkVU',
  peer_caps_c_bob: 'new',
  tor_settings: JSON.stringify({ bridgeMode: 'auto', customBridges: '', forceTorTest: false }),
  tor_onion_key: 'ED25519-V3:' + 'A'.repeat(86) + '==',
  settings: JSON.stringify({ lang: 'de', theme: 'standard' }),
  screen_protection: 'off',
  voice_wave_style: 'bars',
  rx_seen_c_bob: JSON.stringify(['m1', 'm2']),
};

async function dump(keys) {
  const out = {};
  for (const k of keys) out[k] = await ES.getItem(k);
  return out;
}

async function startNewVersion() {
  CM._resetConnectionModeForTests();
  CS._resetConnectionStatsForTests();
  // Neue/geaenderte Startschritte dieser Version
  await CM.loadConnectionMode();
  const notice = await CM.shouldShowStunRemovalNotice();
  await CS.loadConnectionStats();
  CS.setConnectionStatsWriteGuard(() => false);
  await CS.flushConnectionStats();            // nichts gezaehlt -> nichts geschrieben
  return notice;
}

beforeEach(async () => {
  await ES.clear();
});

for (const [label, stored, expectedMode] of [
  ['Stufe 1 "Schnell (mit STUN)"', '1', '2'],
  ['Stufe 2 "Privat (ohne STUN)"', '2', '2'],
  ['Stufe 3 "nur Tor" (ohne Lizenz)', '3', '3'],
  ['keine gespeicherte Stufe (Standard bis 1.1.0)', null, null],
]) {
  test('Update aus 1.1.0, ' + label + ': alles bleibt, nur die Stufe wird umgestellt', async () => {
    const snap = { ...SNAPSHOT_1_1 };
    if (stored !== null) snap.connection_mode = stored;
    for (const [k, v] of Object.entries(snap)) await ES.setItem(k, v);

    const notice = await startNewVersion();

    const expected = { ...snap };
    if (stored !== null) expected.connection_mode = expectedMode;
    expect(await dump(Object.keys(snap))).toEqual(expected);
    // Neu nur der Hinweis-Merker (und nur, wo eine Stufe 1 umgestellt wurde).
    expect(await ES.getItem(CM.CONNECTION_MODE_NOTICE_KEY)).toBe(stored === '1' ? 'pending' : null);
    expect(await ES.getItem(CS.CONNECTION_STATS_KEY)).toBeNull();
    // Hinweis fuer bisherige Stufe-1-Nutzer (gespeichert oder Standard).
    expect(notice).toBe(stored === '1' || stored === null);
    // Wirksam: nie STUN; "nur Tor" bleibt nur Tor.
    if (expectedMode === '3') {
      expect(CM.getConnectionMode()).toBe(CM.MODE_TOR_ONLY);
      await expect(pcConfigForCalls()).rejects.toMatchObject({ name: 'TorOnlyModeError' });
    } else {
      expect(CM.getConnectionMode()).toBe(CM.MODE_DIRECT);
      expect((await pcConfigForCalls()).iceServers).toEqual([]);
    }

    // Zweiter Start: nichts aendert sich mehr, nur der Hinweis-Merker nach dem Zeigen.
    if (notice) await CM.markStunRemovalNoticeShown();
    const after = await dump([...Object.keys(snap), CM.CONNECTION_MODE_NOTICE_KEY]);
    expect(await startNewVersion()).toBe(false);
    expect(await dump([...Object.keys(snap), CM.CONNECTION_MODE_NOTICE_KEY])).toEqual(after);
  });
}

test('Standort-Nachricht mit Ortsnamen aus 1.1.0: Eintrag bleibt unveraendert (Anzeige nutzt address weiter)', () => {
  const [, loc] = JSON.parse(SNAPSHOT_1_1.chat_c_bob);
  expect(loc).toMatchObject({ isLocation: true, address: 'Mitte, Berlin' });
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(/\{item\.address \|\| coordsText\}/);
});
