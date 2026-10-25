// Kopplung nach der Vorstellung ueber eine Gruppe (GroupIntroPairing.js):
// Einladung wie beim QR-Code, aber bis zu 3 Tage gueltig, einmalig, nur
// verschluesselt gespeichert; nach dem Schluesseltausch ein normaler Kontakt mit
// dem Vermerk "vorgestellt von ...". Tor und GroupMessaging sind ersetzt.
const mockTor = {
  state: { status: 'ON', onion: 'q'.repeat(56) + '.onion' },
  invites: new Map(),
  pairCalls: [],
  pairResult: null,
};
jest.mock('../../TorTransport', () => ({
  PAIRING_INVITE_MAX_TTL_MS: 3 * 24 * 60 * 60 * 1000,
  registerPairingInvite: jest.fn((token, opts) => { mockTor.invites.set(token, opts); return () => mockTor.invites.delete(token); }),
  pairViaTor: jest.fn(async (opts) => { mockTor.pairCalls.push(opts); return mockTor.pairResult ? mockTor.pairResult(opts) : null; }),
  ensureTorRunning: jest.fn(),
  getTorState: () => mockTor.state,
  getOwnOnion: () => (mockTor.state.status === 'ON' ? mockTor.state.onion : null),
  onTorState: (fn) => { fn(mockTor.state); return () => {}; },
  onDescriptorReceived: () => () => {},
}));
jest.mock('../../GroupMessaging', () => ({
  onIntroPaired: jest.fn(async () => {}),
  onIntroFailed: jest.fn(async () => {}),
}));

const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const ES = require('react-native-encrypted-storage').default;
const RTCStore = require('../../RTCStore').default;
const GM = require('../../GroupMessaging');
const TT = require('../../TorTransport');
const GIP = require('../../GroupIntroPairing');
const { deriveContactId } = require('../../PairingIds');

let contacts = [];
let uiUpdates = 0;
beforeEach(async () => {
  await ES.clear?.();
  for (const k of ['group_intro_invites', 'group_intro_joins', 'contacts']) await ES.removeItem(k);
  GIP._resetGroupIntroPairingForTests();
  mockTor.invites.clear();
  mockTor.pairCalls = [];
  mockTor.pairResult = null;
  mockTor.state = { status: 'ON', onion: 'q'.repeat(56) + '.onion' };
  contacts = [];
  uiUpdates = 0;
  jest.clearAllMocks();
  GIP.configureGroupIntroPairing({
    updateContacts: async (m) => { const next = m(contacts); if (next) contacts = next; return next; },
    uiContacts: () => { uiUpdates++; },
  });
  jest.spyOn(RTCStore, 'setConnection').mockImplementation(() => {});
});
afterEach(() => { RTCStore.setConnection.mockRestore?.(); });

const INFO = { groupId: 'g_' + 'a'.repeat(24), groupName: 'Projekt', peerMid: 'm_' + 'b'.repeat(32), peerName: 'Bob', adminName: 'Alice' };

test('Einladender: Einladung wie beim QR-Code, 3 Tage gueltig, nur verschluesselt gespeichert und angemeldet', async () => {
  const before = Date.now();
  const inv = await GIP.createIntroInvite(INFO);
  expect(inv.token).toMatch(/^[0-9A-F]{8}$/);
  expect(inv.psk).toMatch(/^[0-9a-f]{32}$/);
  expect(inv.onion).toBe(mockTor.state.onion);
  const reg = mockTor.invites.get(inv.token);
  expect(reg.contactId).toBe(await deriveContactId(inv.token, inv.psk));   // dieselbe ID wie beim QR-Code
  expect(Buffer.from(reg.pskB64, 'base64').toString('hex')).toBe(inv.psk);
  expect(reg.expiresAt).toBeGreaterThanOrEqual(before + 3 * 24 * 3600 * 1000 - 1000);
  expect(reg.expiresAt).toBeLessThanOrEqual(Date.now() + 3 * 24 * 3600 * 1000);
  const stored = JSON.parse(await ES.getItem('group_intro_invites'));
  expect(Object.keys(stored)).toEqual([inv.token]);
  expect(stored[inv.token]).toMatchObject({ groupId: INFO.groupId, peerMid: INFO.peerMid, contactId: reg.contactId });
});

test('je Mitglied und Gruppe hoechstens eine offene Einladung; hoechstens 8 insgesamt', async () => {
  const a = await GIP.createIntroInvite(INFO);
  const b = await GIP.createIntroInvite(INFO);
  expect(mockTor.invites.has(a.token)).toBe(false);
  expect(mockTor.invites.has(b.token)).toBe(true);
  for (let i = 0; i < 7; i++) expect(await GIP.createIntroInvite({ ...INFO, peerMid: 'm_' + String(i).repeat(32) })).not.toBeNull();
  expect(await GIP.createIntroInvite({ ...INFO, peerMid: 'm_' + 'f'.repeat(32) })).toBeNull();
});

test('ohne Tor keine Einladung (statt einer, die niemand erreicht)', async () => {
  mockTor.state = { status: 'OFF', onion: null };
  jest.useFakeTimers();
  const p = GIP.createIntroInvite(INFO);
  await jest.advanceTimersByTimeAsync(61000);
  expect(await p).toBeNull();
  jest.useRealTimers();
});

test('Kopplung fertig (Einladender): Kontakt mit Vermerk, Verbindung, Gruppe informiert - nur einmal', async () => {
  const inv = await GIP.createIntroInvite(INFO);
  const reg = mockTor.invites.get(inv.token);
  const rtc = { close: jest.fn() };
  reg.onPaired(rtc);
  await new Promise((r) => setTimeout(r, 20));
  expect(contacts).toHaveLength(1);
  expect(contacts[0]).toMatchObject({ id: reg.contactId, name: 'Bob', role: 'initiator', introducedBy: { groupId: INFO.groupId, admin: 'Alice' } });
  expect(contacts[0].introducedBy.checked).toBeUndefined();
  expect(RTCStore.setConnection).toHaveBeenCalledWith(reg.contactId, rtc);
  expect(GM.onIntroPaired).toHaveBeenCalledWith(INFO.groupId, INFO.peerMid);
  expect(uiUpdates).toBe(1);
  expect(await ES.getItem('group_intro_invites')).toBeNull();       // Einladung verbraucht und geloescht
  expect(mockTor.invites.has(inv.token)).toBe(false);
  // Zweiter Rueckruf derselben Einladung: keine Doppelanlage, Verbindung zu
  const rtc2 = { close: jest.fn() };
  reg.onPaired(rtc2);
  await new Promise((r) => setTimeout(r, 20));
  expect(contacts).toHaveLength(1);
  expect(rtc2.close).toHaveBeenCalled();
});

test('Beitretender: koppelt mit der Einladung; Kontakt als responder mit Onion-Adresse des anderen', async () => {
  const invite = { token: 'C0FFEE11', psk: '1f'.repeat(16), onion: 'r'.repeat(56) + '.onion' };
  mockTor.pairResult = (opts) => { setTimeout(() => opts.onPaired({ close() {} }), 5); return { _closed: false, close() {} }; };
  expect(await GIP.joinIntroInvite({ ...INFO, invite })).toBe(true);
  await new Promise((r) => setTimeout(r, 80));
  expect(mockTor.pairCalls).toHaveLength(1);
  expect(mockTor.pairCalls[0]).toMatchObject({ onion: invite.onion, token: invite.token, contactId: await deriveContactId(invite.token, invite.psk) });
  expect(Buffer.from(mockTor.pairCalls[0].pskB64, 'base64').toString('hex')).toBe(invite.psk);
  expect(contacts[0]).toMatchObject({ role: 'responder', torOnion: invite.onion, name: 'Bob' });
  expect(await ES.getItem('group_intro_joins')).toBeNull();
});

test('Beitretender: andere Seite (noch) nicht erreichbar -> Einladung bleibt, neuer Versuch spaeter', async () => {
  const invite = { token: 'C0FFEE22', psk: '2e'.repeat(16), onion: 's'.repeat(56) + '.onion' };
  jest.useFakeTimers();
  await GIP.joinIntroInvite({ ...INFO, invite });
  await jest.advanceTimersByTimeAsync(10);
  expect(mockTor.pairCalls).toHaveLength(1);
  expect(Object.keys(JSON.parse(await ES.getItem('group_intro_joins')))).toEqual([invite.token]);
  await jest.advanceTimersByTimeAsync(61000);
  expect(mockTor.pairCalls).toHaveLength(2);
  jest.useRealTimers();
});

test('abgelaufene Einladungen verfallen beim Start und melden "gescheitert"; offene werden wieder angemeldet', async () => {
  const now = Date.now();
  await ES.setItem('group_intro_invites', JSON.stringify({
    AAAA1111: { pskB64: 'x', contactId: 'c_1', groupId: INFO.groupId, peerMid: INFO.peerMid, expires: now - 1 },
    BBBB2222: { pskB64: Buffer.from('3d'.repeat(16), 'hex').toString('base64'), contactId: 'c_2', groupId: INFO.groupId, peerMid: 'm_' + 'c'.repeat(32), expires: now + 60000 },
  }));
  await GIP.resumeIntroPairings();
  expect(GM.onIntroFailed).toHaveBeenCalledWith(INFO.groupId, INFO.peerMid);
  expect(mockTor.invites.has('AAAA1111')).toBe(false);
  expect(mockTor.invites.has('BBBB2222')).toBe(true);
  expect(Object.keys(JSON.parse(await ES.getItem('group_intro_invites')))).toEqual(['BBBB2222']);
});

test('TorTransport: Gueltigkeit hoechstens 3 Tage, Standard weiterhin 30 Minuten', () => {
  const real = jest.requireActual('../../TorTransport');
  expect(real.PAIRING_INVITE_MAX_TTL_MS).toBe(3 * 24 * 60 * 60 * 1000);
  expect(TT.registerPairingInvite).toBeDefined();
});
