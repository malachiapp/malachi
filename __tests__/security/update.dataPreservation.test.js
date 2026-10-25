// Update-Sicherheitsnetz (Audit 2026-10-25): Ein Update darf gespeicherte
// Daten nie verlieren oder still ueberschreiben. Nachgestellt wird der
// Speicher einer 1.0-Installation (Formate wie in 1.0.0); dann laufen die
// beim Start neuen bzw. geaenderten Teile dieser Version. Danach muss jeder
// Schluessel noch da sein und jeder Wert unveraendert - neue Felder kommen nur
// hinzu, wenn tatsaechlich etwas Neues passiert.
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const ES = require('react-native-encrypted-storage').default;
const VW = require('../../VoiceWave');
const GIP = require('../../GroupIntroPairing');
const GM = require('../../GroupMessaging');
const MV = require('../../MediaVault');

const MID = (c) => 'm_' + c.repeat(32);
const SNAPSHOT_1_0 = {
  username: 'Alice',
  group_self_id: MID('a'),
  contacts: JSON.stringify([
    { id: 'c_bob', name: 'Bob', theirName: 'Bob', groupMemberId: MID('b'), pinned: true, lastTs: 1760000000000, unread: 2, role: 'initiator' },
    { id: 'c_carol', name: 'Carol', groupMemberId: MID('c'), theirAvatar: 'data:image/jpeg;base64,QUJD', role: 'responder', torOnion: 'x'.repeat(56) + '.onion' },
  ]),
  groups: JSON.stringify([{
    v: 1, groupId: 'g_' + '1'.repeat(24), name: 'Familie', description: '', avatarUri: null,
    members: [{ mid: MID('a'), name: 'Alice' }, { mid: MID('b'), name: 'Bob' }, { mid: MID('c'), name: 'Carol' }],
    admins: [MID('a')], createdBy: MID('a'), createdAt: 1760000000000, rev: 3, updatedAt: 1760000000500,
    removed: false, leftMembers: {}, unread: 1, last: 'Bob: Hallo', lastTime: 1760000000400, pinned: true,
  }]),
  ['gchat_g_' + '1'.repeat(24)]: JSON.stringify([{ id: 'x1', from: MID('b'), mine: false, text: 'Hallo', time: 1760000000400 }]),
  chat_c_bob: JSON.stringify([
    { id: '1760000000001', text: 'Hi Bob', mine: true, time: '10:00', status: 'delivered' },
    { id: '1760000000002', type: 'audio', mine: false, mref: 'a'.repeat(32), mk: 'S0VZ', durationMs: 4000, time: '10:01' },
  ]),
  screen_protection: 'off',
  tor_onion_key: 'ED25519-V3:' + 'A'.repeat(86) + '==',
  'settings': JSON.stringify({ lang: 'de' }),
};

beforeEach(async () => {
  await ES.clear?.();
  for (const [k, v] of Object.entries(SNAPSHOT_1_0)) await ES.setItem(k, v);
  GIP._resetGroupIntroPairingForTests();
  GM._resetGroupMessagingForTests();
});

async function dump() {
  const out = {};
  for (const k of Object.keys(SNAPSHOT_1_0)) out[k] = await ES.getItem(k);
  return out;
}

test('Start der neuen Version: nichts geht verloren, nichts wird umgeschrieben', async () => {
  GM.configureGroupMessaging({
    updateGroups: async (m) => { const cur = JSON.parse((await ES.getItem('groups')) || '[]'); const n = await m(cur); if (n) await ES.setItem('groups', JSON.stringify(n)); return n; },
    updateContacts: async (m) => { const cur = JSON.parse((await ES.getItem('contacts')) || '[]'); const n = await m(cur); if (n) await ES.setItem('contacts', JSON.stringify(n)); return n; },
    sendViaOutbox: async () => true,
  });
  GIP.configureGroupIntroPairing({ updateContacts: async () => null, uiContacts: () => {} });

  // Neue Startschritte dieser Version
  await VW.loadWaveStyle();                 // Sprachnachrichten-Stil
  await GIP.resumeIntroPairings();          // offene Vorstellungen (gibt es in 1.0 nicht)
  await GM.loadGroups();                    // Gruppen (1.0-Format v1)

  expect(await dump()).toEqual(SNAPSHOT_1_0);
  expect(VW.waveStyleSetting()).toBe('bars');
  // Keine neuen Schluessel angelegt, nur weil die Version neu ist
  expect(await ES.getItem('voice_wave_style')).toBeNull();
  expect(await ES.getItem('group_intro_invites')).toBeNull();
  expect(await ES.getItem('group_intro_joins')).toBeNull();
});

test('1.0-Gruppe ohne neue Felder: Lesen und Anzeigen ohne Umschreiben, lokale Felder bleiben', async () => {
  const [g] = JSON.parse(SNAPSHOT_1_0.groups);
  expect(GM.introsAvailable(g)).toBe(false);             // aeltere Admins bieten es nicht an
  expect(GM.isReadOnlyChannel(g, MID('b'))).toBe(false);  // ohne "mode" eine normale Gruppe
  expect(GM.introStatus(g, MID('c'))).toBe('none');
  expect(GM.incomingIntroCount(g)).toBe(0);
});

test('1.0-Sprachnachricht ohne Wellenform: Ersatzform, Eintrag bleibt unveraendert', async () => {
  const [, audio] = JSON.parse(SNAPSHOT_1_0.chat_c_bob);
  const before = JSON.stringify(audio);
  const levels = VW.levelsFor(audio);
  expect(levels).toHaveLength(VW.WAVE_BARS);
  expect(JSON.stringify(audio)).toBe(before);
  // Gespeicherter Verlauf mit Verweisen wird beim Speichern nicht veraendert
  const storage = { m: new Map(), getItem: async () => null, setItem: async (k, v) => storage.m.set(k, v), removeItem: async () => {} };
  await MV.persistChatHistory({ storage, key: 'chat_c_bob', scope: 'c_bob', entries: JSON.parse(SNAPSHOT_1_0.chat_c_bob), known: new Map(), historyIncluded: true });
  expect(JSON.parse(storage.m.get('chat_c_bob'))).toEqual(JSON.parse(SNAPSHOT_1_0.chat_c_bob));
});
