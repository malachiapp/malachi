// Siegel-Tresor (SiegelVault.js): eigene Passphrase + Chip-Schluessel,
// Fehlversuchssperre und Loeschen, Zero Trace im Speicher, automatisches
// Sperren - unabhaengig vom Rest der App.
const { fakeKyber, fakeSiegelKey, rng } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, AppState } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
const siegelKey = fakeSiegelKey();
NativeModules.MalachiSiegelKey = siegelKey;

const EncryptedStorage = require('react-native-encrypted-storage').default;
const V = require('../../SiegelVault');
const S = require('../../SiegelCrypto');

const PASS = 'Kerze-Berg-Fluss-42';
const kyber = NativeModules.KyberModule;

let writes = [];
const realSetItem = EncryptedStorage.setItem;
EncryptedStorage.setItem = async (k, v) => { writes.push([k, v]); return realSetItem(k, v); };
beforeEach(async () => {
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
  writes = [];
  siegelKey.createKey.mockClear();
  siegelKey.destroyKey.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

async function pairWithPeer(name = 'Alex') {
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  const c = await V.finishInvite(peer.qr, name);
  return { id: c.id, peer: peer.contact, safety: c.safety };
}

test('Einrichten: kurze Passphrase abgelehnt; danach offen, Chip-Schluessel erzeugt, Argon2id-Parameter uebergeben', async () => {
  await expect(V.setup('kurz')).rejects.toMatchObject({ code: 'passphrase' });
  await V.setup(PASS);
  expect(V.isUnlocked()).toBe(true);
  expect(siegelKey.createKey).toHaveBeenCalledTimes(1);
  expect(siegelKey.calls[siegelKey.calls.length - 1]).toEqual({ memKiB: 32768, iterations: 3 });
  await expect(V.setup(PASS)).rejects.toMatchObject({ code: 'exists' });
});

test('gesperrt kommt niemand an Kontakte oder Nachrichten; richtige Passphrase oeffnet wieder', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  V.lock();
  expect(() => V.listContacts()).toThrow(/gesperrt/);
  await expect(V.seal(id, 'x')).rejects.toMatchObject({ code: 'locked' });
  expect((await V.unlock(PASS)).ok).toBe(true);
  const msg = await V.seal(id, 'Hallo Alex');
  expect((await S.openText(peer.ratchet, msg, { rng })).text).toBe('Hallo Alex');
});

test('Ende-zu-Ende mit Gegenseite: Kopplung, beide Richtungen, Sicherheitscode gleich', async () => {
  await V.setup(PASS);
  const { id, peer, safety } = await pairWithPeer();
  expect(safety).toBe(peer.safety);
  const fromPeer = await S.sealText(peer.ratchet, 'Antwort vom Peer', { rng });
  peer.ratchet = fromPeer.ratchet;
  expect(await V.open(id, fromPeer.message)).toBe('Antwort vom Peer');
  const second = await S.sealText(peer.ratchet, 'zweite', { rng });
  expect(await V.openAny(second.message)).toMatchObject({ id, name: 'Alex', text: 'zweite' });
  await expect(V.open(id, fromPeer.message)).rejects.toMatchObject({ code: 'used' });
});

test('Zero Trace: weder Klartext noch Passphrase landen je im Speicher', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  await V.seal(id, 'STRENG-GEHEIMER-KLARTEXT-1');
  const m = await S.sealText(peer.ratchet, 'STRENG-GEHEIMER-KLARTEXT-2', { rng });
  await V.open(id, m.message);
  const all = writes.map(([k, v]) => k + '=' + v).join('\n');
  expect(all).not.toMatch(/STRENG-GEHEIMER-KLARTEXT/);
  expect(all).not.toContain(PASS);
  expect(all).not.toMatch(/Alex/);                     // auch Kontaktnamen nur verschluesselt
  expect(writes.every(([k]) => k.startsWith('siegel_'))).toBe(true);
});

test('falsche Passphrase: Restversuche zaehlen herunter, ab dem 4. Fehlversuch Wartezeit', async () => {
  await V.setup(PASS);
  V.lock();
  const r1 = await V.unlock('falsch-falsch-1');
  expect(r1).toMatchObject({ ok: false, reason: 'wrong', remaining: 9 });
  await V.unlock('falsch-falsch-2');
  await V.unlock('falsch-falsch-3');
  const r4 = await V.unlock('falsch-falsch-4');
  expect(r4).toMatchObject({ ok: false, reason: 'wrong', remaining: 6 });
  expect(r4.waitMs).toBeGreaterThan(0);
  const r5 = await V.unlock(PASS);                    // waehrend der Sperrzeit: auch richtig zaehlt nicht
  expect(r5).toMatchObject({ ok: false, reason: 'wait' });
});

test('nach 10 Fehlversuchen wird der Tresor geloescht - inklusive Chip-Schluessel', async () => {
  await V.setup(PASS);
  V.lock();
  const realNow = Date.now;
  let offset = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  let last;
  for (let i = 0; i < 10; i++) {
    last = await V.unlock('falsch-' + i + '-xxxx');
    offset += 2 * 60 * 60 * 1000;                     // Sperrzeiten abwarten
  }
  expect(last).toMatchObject({ ok: false, reason: 'wiped' });
  expect(siegelKey.destroyKey).toHaveBeenCalled();
  expect(await V.exists()).toBe(false);
  expect(await EncryptedStorage.getItem('siegel_vault_v1')).toBeNull();
});

test('Audit C6: Lesefehler gilt nie als "kein Tresor" - Einrichten verweigert, Chip-Schluessel und Tresor bleiben', async () => {
  await V.setup(PASS);
  V.lock();
  siegelKey.createKey.mockClear();
  const before = await EncryptedStorage.getItem('siegel_vault_v1');
  const spy = jest.spyOn(EncryptedStorage, 'getItem').mockImplementation(async () => { throw new Error('Keystore gesperrt'); });
  expect(await V.vaultState()).toBe('unknown');
  expect(await V.exists()).toBe(false);
  await expect(V.setup('Neue-Passphrase-1234')).rejects.toMatchObject({ code: 'storage' });
  expect(await V.unlock(PASS)).toMatchObject({ ok: false, reason: 'storage' });
  expect(siegelKey.createKey).not.toHaveBeenCalled();
  expect(siegelKey.destroyKey).not.toHaveBeenCalled();
  spy.mockRestore();
  expect(await EncryptedStorage.getItem('siegel_vault_v1')).toBe(before);
  expect(await V.vaultState()).toBe('present');
  expect(await V.unlock(PASS)).toMatchObject({ ok: true });
});

test('kopierte Daten ohne den Chip-Schluessel (anderes Geraet/Schluessel weg): nicht zu oeffnen', async () => {
  await V.setup(PASS);
  V.lock();
  siegelKey._forgetKeyForTests();
  expect(await V.unlock(PASS)).toMatchObject({ ok: false, reason: 'nokey' });
});

test('sperrt sich, sobald die App in den Hintergrund geht', async () => {
  await V.setup(PASS);
  const handler = AppState.addEventListener.mock?.calls?.find((c) => c[0] === 'change')?.[1];
  if (!handler) return;   // Preset ohne Mock-Aufzeichnung: statisch unten abgedeckt
  handler('background');
  expect(V.isUnlocked()).toBe(false);
});

test('sperrt sich nach 60 s ohne Bedienung', async () => {
  jest.useFakeTimers();
  try {
    await V.setup(PASS);
    expect(V.isUnlocked()).toBe(true);
    jest.advanceTimersByTime(V.IDLE_LOCK_MS + 10);
    expect(V.isUnlocked()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('statisch: App-Zuruecksetzen/Duress loescht den Siegel-Tresor mit; Hintergrund sperrt', () => {
  const fs = require('fs');
  const path = require('path');
  const vault = fs.readFileSync(path.join(__dirname, '..', '..', 'SiegelVault.js'), 'utf8');
  // Hintergrund sperrt - ausser waehrend eines Systemdialogs (holdOpen, siehe siegel.media.vault.test.js).
  expect(vault).toMatch(/AppState\?\.addEventListener\?\.\('change', \(s\) => \{ if \(s !== 'active'\) onAppStateChange\(s\); \}\)/);
  expect(vault).toMatch(/function onAppStateChange\(s\) \{\s*if \(s !== 'active' && holds === 0\) lock\(\);\s*\}/);
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const wipeFn = app.slice(app.indexOf('async function performWipe()'), app.indexOf('async function performWipe()') + 6000);
  expect(wipeFn).toMatch(/siegelWipe\(\)/);
});
