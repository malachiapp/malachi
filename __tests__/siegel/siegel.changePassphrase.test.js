// Siegel-Passphrase aendern (SiegelVault.changePassphrase, Nutzerwunsch
// 29.10.2026): nur bei offenem Tresor UND mit der richtigen alten Passphrase,
// Fehlversuche im selben Zaehler wie beim Entsperren, Kontakte und Ratchet
// bleiben erhalten, ein gescheitertes Speichern laesst alles beim Alten.
const { fakeKyber, fakeSiegelKey, rng } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
const siegelKey = fakeSiegelKey();
NativeModules.MalachiSiegelKey = siegelKey;

const EncryptedStorage = require('react-native-encrypted-storage').default;
const V = require('../../SiegelVault');
const S = require('../../SiegelCrypto');

const OLD = 'Kerze-Berg-Fluss-42';
const NEW = 'Wolke-Tal-Stein-77';
const kyber = NativeModules.KyberModule;

beforeEach(async () => {
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
  siegelKey.createKey.mockClear();
  siegelKey.destroyKey.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

async function pairWithPeer(name = 'Alex') {
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  const c = await V.finishInvite(peer.qr, name);
  return { id: c.id, peer: peer.contact };
}

test('richtige alte Passphrase: danach oeffnet nur noch die neue, Kontakt + Ratchet bleiben', async () => {
  await V.setup(OLD);
  const { id, peer } = await pairWithPeer();
  const saltBefore = JSON.parse(await EncryptedStorage.getItem('siegel_vault_v1')).salt;
  expect(await V.changePassphrase(OLD, NEW)).toEqual({ ok: true });
  expect(V.isUnlocked()).toBe(true);
  const stored = await EncryptedStorage.getItem('siegel_vault_v1');
  expect(JSON.parse(stored).salt).not.toBe(saltBefore);           // neues Salz
  expect(stored).not.toContain(NEW);
  expect(stored).not.toContain(OLD);
  expect(siegelKey.createKey).toHaveBeenCalledTimes(1);           // Chip-Schluessel bleibt

  V.lock();
  expect(await V.unlock(OLD)).toMatchObject({ ok: false, reason: 'wrong' });
  expect(await V.unlock(NEW)).toEqual({ ok: true });
  expect(V.listContacts().map((c) => c.name)).toEqual(['Alex']);
  const msg = await V.seal(id, 'nach dem Wechsel');
  expect((await S.openText(peer.ratchet, msg, { rng })).text).toBe('nach dem Wechsel');
});

test('falsche alte Passphrase: nichts geaendert, Fehlversuch gezaehlt', async () => {
  await V.setup(OLD);
  const before = await EncryptedStorage.getItem('siegel_vault_v1');
  const r = await V.changePassphrase('falsch-falsch', NEW);
  expect(r).toMatchObject({ ok: false, reason: 'wrong', remaining: V.MAX_FAILS - 1 });
  expect(await EncryptedStorage.getItem('siegel_vault_v1')).toBe(before);
  expect(await EncryptedStorage.getItem('siegel_vault_fails')).toBe('1');
  expect(V.isUnlocked()).toBe(true);                              // offen bleibt offen
  V.lock();
  expect(await V.unlock(OLD)).toEqual({ ok: true });              // alte gilt weiter
  expect(await EncryptedStorage.getItem('siegel_vault_fails')).toBeNull();
});

test('gleicher Zaehler wie beim Entsperren: Wartezeit greift, nach MAX_FAILS geloescht', async () => {
  await V.setup(OLD);
  for (let i = 0; i < 4; i++) await V.changePassphrase('falsch-' + i + '-xxxx', NEW);
  const wait = await V.changePassphrase(OLD, NEW);
  expect(wait).toMatchObject({ ok: false, reason: 'wait' });     // auch die richtige wartet
  await EncryptedStorage.setItem('siegel_vault_fails', String(V.MAX_FAILS - 1));
  await EncryptedStorage.removeItem('siegel_vault_next_try');
  expect(await V.changePassphrase('noch-falscher', NEW)).toEqual({ ok: false, reason: 'wiped' });
  expect(V.isUnlocked()).toBe(false);
  expect(await V.vaultState()).toBe('absent');
  expect(siegelKey.destroyKey).toHaveBeenCalled();
});

test('nur bei offenem Tresor; schwache oder gleiche neue Passphrase abgelehnt', async () => {
  await V.setup(OLD);
  await expect(V.changePassphrase(OLD, 'kurz')).rejects.toMatchObject({ code: 'passphrase' });
  expect(await V.changePassphrase(OLD, OLD)).toEqual({ ok: false, reason: 'same' });
  V.lock();
  expect(await V.changePassphrase(OLD, NEW)).toEqual({ ok: false, reason: 'locked' });
  expect(await V.unlock(OLD)).toEqual({ ok: true });
});

test('Speichern scheitert: alte Passphrase gilt weiter, Sitzung schreibt mit dem alten Schluessel', async () => {
  await V.setup(OLD);
  await pairWithPeer();
  const realSet = EncryptedStorage.setItem;
  let fail = true;
  jest.spyOn(EncryptedStorage, 'setItem').mockImplementation(async (k, v) => {
    if (fail && k === 'siegel_vault_v1') { fail = false; throw new Error('Speicher voll'); }
    return realSet.call(EncryptedStorage, k, v);
  });
  await expect(V.changePassphrase(OLD, NEW)).rejects.toThrow(/Speicher voll/);
  await V.renameContact(V.listContacts()[0].id, 'Alexandra');   // schreibt erneut
  V.lock();
  expect(await V.unlock(NEW)).toMatchObject({ ok: false, reason: 'wrong' });
  expect(await V.unlock(OLD)).toEqual({ ok: true });
  expect(V.listContacts()[0].name).toBe('Alexandra');
});
