// Siegel-Anhaenge im Tresor (SiegelVault.js sealMediaFor/openMediaAny):
// Ratchet-Zustand wird VOR der Herausgabe gespeichert, Probe-Entschluesselung
// ueber alle Kontakte, Zero Trace (weder Inhalt noch Name/Typ im Speicher),
// Systemdialoge (Galerie/Dateiauswahl) sperren den Tresor nicht sofort.
const { fakeKyber, fakeSiegelKey, rng } = require('../security/helpers/siegelTestHelpers');
const { installKyberModuleMock } = require('../security/helpers/nativeBridgeMock');
installKyberModuleMock();
const { NativeModules, AppState } = require('react-native');
Object.assign(NativeModules.KyberModule, fakeKyber());
NativeModules.MalachiSiegelKey = fakeSiegelKey();

const EncryptedStorage = require('react-native-encrypted-storage').default;
const V = require('../../SiegelVault');
const S = require('../../SiegelCrypto');
// Beim Laden registrierter AppState-Handler des Tresors.
const appStateHandler = AppState.addEventListener.mock.calls.find((c) => c[0] === 'change')?.[1];

const PASS = 'Kerze-Berg-Fluss-42';
const kyber = NativeModules.KyberModule;

let writes = [];
const realSetItem = EncryptedStorage.setItem;
EncryptedStorage.setItem = async (k, v) => { writes.push([k, v]); return realSetItem(k, v); };
beforeEach(async () => {
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
  writes = [];
});

async function pairWithPeer(name = 'Alex') {
  const inviteQr = await V.startInvite();
  const peer = await S.acceptInvite(inviteQr, { rng, kyber });
  const c = await V.finishInvite(peer.qr, name);
  return { id: c.id, peer: peer.contact };
}
const marker = (s) => Uint8Array.from(Buffer.from(s.repeat(40)));

test('sealMediaFor: Gegenseite oeffnet den Anhang; Zustand war VOR der Rueckgabe gespeichert', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  const before = writes.length;
  const file = await V.sealMediaFor(id, { kind: 'image', mime: 'image/jpeg', name: 'bild.jpg', bytes: marker('BILD') });
  expect(writes.length).toBe(before + 1);                  // genau ein Speichervorgang (Ratchet)
  const o = await S.openMedia(peer.ratchet, file, { rng });
  expect(o.kind).toBe('image');
  expect(Buffer.from(o.bytes).toString()).toBe('BILD'.repeat(40));
  // Nach "Absturz" (neu entsperrt): naechster Anhang nutzt NICHT denselben Zaehler.
  V.lock();
  await V.unlock(PASS);
  const file2 = await V.sealMediaFor(id, { kind: 'file', mime: 'text/plain', name: 'b.txt', bytes: marker('ZWEI') });
  const o2 = await S.openMedia(o.ratchet, file2, { rng });
  expect(o2.name).toBe('b.txt');
});

test('Speichern schlaegt fehl: keine Datei, Zustand unveraendert', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  EncryptedStorage.setItem = async () => { throw new Error('voll'); };
  try {
    await expect(V.sealMediaFor(id, { kind: 'file', mime: 'text/plain', name: 'x', bytes: marker('X') })).rejects.toThrow('voll');
  } finally {
    EncryptedStorage.setItem = async (k, v) => { writes.push([k, v]); return realSetItem(k, v); };
  }
  const file = await V.sealMediaFor(id, { kind: 'file', mime: 'text/plain', name: 'y', bytes: marker('Y') });
  expect((await S.openMedia(peer.ratchet, file, { rng })).name).toBe('y');
});

test('openMediaAny: findet den passenden Kontakt, danach "used"; fremd -> "auth"; kaputt -> "format"', async () => {
  await V.setup(PASS);
  const alex = await pairWithPeer('Alex');
  const bea = await pairWithPeer('Bea');
  const fromBea = await S.sealMedia(bea.peer.ratchet, { kind: 'audio', mime: 'audio/mp4', name: 'sprach.mp4', bytes: marker('TON') }, { rng });
  const r = await V.openMediaAny(fromBea.file);
  expect(r).toMatchObject({ id: bea.id, name: 'Bea', media: { kind: 'audio', mime: 'audio/mp4', name: 'sprach.mp4' } });
  expect(Buffer.from(r.media.bytes).toString()).toBe('TON'.repeat(40));
  await expect(V.openMediaAny(fromBea.file)).rejects.toMatchObject({ code: 'used' });

  const stranger = await S.createInvite({ rng, kyber });
  const other = await S.acceptInvite(stranger.qr, { rng, kyber });
  const foreign = await S.sealMedia(other.contact.ratchet, { kind: 'file', mime: 'text/plain', name: 'f', bytes: marker('F') }, { rng });
  await expect(V.openMediaAny(foreign.file)).rejects.toMatchObject({ code: 'auth' });
  await expect(V.openMediaAny(Uint8Array.from(Buffer.from('kein Siegel'.repeat(20))))).rejects.toMatchObject({ code: 'format' });
  // Alex' Zustand blieb von den Fehlversuchen unberuehrt.
  const fromAlex = await S.sealMedia(alex.peer.ratchet, { kind: 'file', mime: 'text/plain', name: 'a', bytes: marker('A') }, { rng });
  expect((await V.openMediaAny(fromAlex.file)).id).toBe(alex.id);
});

test('gesperrt: weder verschluesseln noch oeffnen', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  const m = await S.sealMedia(peer.ratchet, { kind: 'file', mime: 'text/plain', name: 'x', bytes: marker('X') }, { rng });
  V.lock();
  await expect(V.sealMediaFor(id, { kind: 'file', mime: 'text/plain', name: 'x', bytes: marker('X') })).rejects.toMatchObject({ code: 'locked' });
  await expect(V.openMediaAny(m.file)).rejects.toMatchObject({ code: 'locked' });
});

test('Zero Trace: weder Inhalt noch Dateiname/Typ landen im Speicher', async () => {
  await V.setup(PASS);
  const { id, peer } = await pairWithPeer();
  await V.sealMediaFor(id, { kind: 'file', mime: 'application/x-geheimtyp', name: 'GEHEIMER-DATEINAME.pdf', bytes: marker('GEHEIMER-INHALT-1') });
  const m = await S.sealMedia(peer.ratchet, { kind: 'image', mime: 'image/x-geheimbild', name: 'GEHEIMES-FOTO.jpg', bytes: marker('GEHEIMER-INHALT-2') }, { rng });
  await V.openMediaAny(m.file);
  const all = writes.map(([k, v]) => k + '=' + v).join('\n');
  for (const s of ['GEHEIMER-INHALT', 'GEHEIMER-DATEINAME', 'GEHEIMES-FOTO', 'geheimtyp', 'geheimbild',
    Buffer.from('GEHEIMER-INHALT-1').toString('base64').slice(0, 16)]) {
    expect(all).not.toContain(s);
  }
  expect(writes.every(([k]) => k.startsWith('siegel_'))).toBe(true);
});

test('Systemdialog (holdOpen): Hintergrund sperrt dabei nicht sofort, danach wieder wie gewohnt', async () => {
  expect(typeof appStateHandler).toBe('function');
  await V.setup(PASS);
  let release;
  const p = V.holdOpen(() => new Promise((r) => { release = r; }));
  appStateHandler('background');                           // Galerie geoeffnet
  expect(V.isUnlocked()).toBe(true);
  appStateHandler('active');
  release('bild');
  await expect(p).resolves.toBe('bild');
  appStateHandler('background');                           // danach: sofort gesperrt
  expect(V.isUnlocked()).toBe(false);
});

test('holdOpen haelt hoechstens HOLD_MAX_MS offen; Fehler im Dialog geben die Sperre wieder frei', async () => {
  jest.useFakeTimers();
  try {
    await V.setup(PASS);
    const never = V.holdOpen(() => new Promise(() => {}));
    appStateHandler('background');
    jest.advanceTimersByTime(V.IDLE_LOCK_MS + 10);
    expect(V.isUnlocked()).toBe(true);                     // laengere Frist waehrend des Dialogs
    jest.advanceTimersByTime(V.HOLD_MAX_MS);
    expect(V.isUnlocked()).toBe(false);                    // aber nicht unbegrenzt
    void never;
  } finally {
    jest.useRealTimers();
  }
  V._resetSiegelVaultForTests();
  await EncryptedStorage.clear();
  await V.setup(PASS);
  await expect(V.holdOpen(async () => { throw new Error('abgebrochen'); })).rejects.toThrow('abgebrochen');
  appStateHandler('background');
  expect(V.isUnlocked()).toBe(false);
});

test('holdOpen: haengt der Systemdialog, hebt das spaetere Sperren die Ausnahme auf - danach sperrt der Hintergrund wieder sofort', async () => {
  const { AppState } = require('react-native');
  await V.setup('Kerze-Berg-Fluss-42').catch(() => {});
  if (!V.isUnlocked()) await V.unlock('Kerze-Berg-Fluss-42');
  V.holdOpen(() => new Promise(() => {}));            // Dialog kommt nie zurueck
  V.lock();
  await V.unlock('Kerze-Berg-Fluss-42');
  const handler = AppState.addEventListener.mock?.calls?.find((c) => c[0] === 'change')?.[1];
  if (!handler) return;
  handler('background');
  expect(V.isUnlocked()).toBe(false);
});
