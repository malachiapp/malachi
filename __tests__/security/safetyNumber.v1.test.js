// Krypto-Review 2026-10-25, V1: stabiler Sicherheitscode (SafetyNumber.js).
// Behebt K-01 (Code wechselte bei jeder Verbindung), K-03 (Hinweis "Vorgestellt
// von ..." verschwand schon beim Oeffnen), K-10 (SHA-256 eines aktiven
// Schluessels ohne Domaenentrennung), entschaerft K-02.
//
// Teil A: Ableitung (Testvektor mit unabhaengiger Gegenprobe ueber Nodes
// crypto.hkdfSync). Teil B: zwei bzw. drei "Geraete" mit echtem Double Ratchet
// (RatchetSession + SafetyNumber je Geraet, eigener Speicher). Teil C: Dialog.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

jest.mock('react-native-encrypted-storage', () => {
  const dev = global.__mockDevice || 'default';
  global.__mockStores = global.__mockStores || {};
  const store = (global.__mockStores[dev] = global.__mockStores[dev] || new Map());
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: async (k, v) => { store.set(k, String(v)); },
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      removeItem: async (k) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

const kemSecret = () => crypto.randomBytes(32).toString('base64');

// Unabhaengige Gegenprobe: dieselbe Vorschrift mit Nodes OpenSSL-HKDF.
function referenceSn(adB64) {
  const out = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(adB64, 'base64'),
    Buffer.from('malachi-safety-number-v2'), Buffer.from('malachi-safety-v2|digits'), 30));
  const groups = [];
  for (let g = 0; g < 6; g++) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 256 + out[g * 5 + i];
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

describe('Teil A: Ableitung', () => {
  // Eigener Modul-Bereich: ein ausserhalb geladener Speicher-Mock wuerde sonst
  // von allen "Geraeten" in Teil B geteilt (jest-Fallback auf die Haupt-Registry).
  let SN;
  beforeAll(() => {
    global.__mockDevice = 'vektoren';
    jest.isolateModules(() => {
      require('./helpers/nativeBridgeMock').installKyberModuleMock();
      SN = require('../../SafetyNumber');
    });
    global.__mockDevice = undefined;
  });

  test('Testvektor (fest) und Gegenprobe mit unabhaengiger HKDF', () => {
    const ad = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
    expect(SN.safetyNumberFromAd(ad)).toBe('29501 86364 32461 27977 65863 50591');
    expect(referenceSn(ad)).toBe('29501 86364 32461 27977 65863 50591');
    for (let i = 0; i < 50; i++) {
      const r = crypto.randomBytes(32).toString('base64');
      expect(SN.safetyNumberFromAd(r)).toBe(referenceSn(r));
    }
  });

  test('30 Ziffern in 6 Gruppen, verschiedene Sitzungen -> verschiedene Codes, falsche Laenge wird abgelehnt', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const s = SN.safetyNumberFromAd(crypto.randomBytes(32).toString('base64'));
      expect(SN.isSafetyNumber(s)).toBe(true);
      expect(s.replace(/ /g, '')).toHaveLength(30);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
    expect(() => SN.safetyNumberFromAd(crypto.randomBytes(16).toString('base64'))).toThrow();
    expect(() => SN.safetyNumberFromAd('')).toThrow();
  });

  test('Domaenentrennung: nicht derselbe Wert wie der alte Verbindungscode oder ein HKDF mit anderem Label', () => {
    const ad = crypto.randomBytes(32).toString('base64');
    const sn = SN.safetyNumberFromAd(ad).replace(/ /g, '');
    const legacy = crypto.createHash('sha256').update(ad, 'utf8').digest('hex').replace(/[^0-9]/g, '').slice(0, 16);
    expect(sn.startsWith(legacy)).toBe(false);
    const other = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ad, 'base64'), Buffer.from('malachi-safety-number-v2'), Buffer.from('anderes-label'), 30));
    expect(referenceSn(ad)).not.toBe(other.toString('hex'));
  });
});

// ─── Teil B: Sitzungen ──────────────────────────────────────────────────────
function loadDevice(device, peerId, role) {
  global.__mockDevice = device;
  let RS;
  let SN;
  let ES;
  jest.isolateModules(() => {
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    RS = require('../../RatchetSession');
    SN = require('../../SafetyNumber');
    ES = require('react-native-encrypted-storage').default;
  });
  global.__mockDevice = undefined;
  return { RS, SN, ES, peerId, role, async setup() {
    await ES.setItem('contacts', JSON.stringify([{ id: peerId, name: 'x', role }]));
    await RS.notePeerCaps(peerId, true);
  } };
}
const sealText = (d, text, conn) => d.RS.seal(d.peerId, JSON.stringify({ t: text }), { connSecret: conn });
const openText = async (d, env, conn) => JSON.parse(await d.RS.open(d.peerId, env, { candidates: [conn] })).t;
const info = (d, legacyCode = null) => d.SN.getSafetyInfo(d.peerId, { legacyCode });

async function pairDevices(nameA = 'alice', nameB = 'bob', idA = 'c_bob', idB = 'c_alice') {
  const a = loadDevice(nameA, idA, 'initiator');
  const b = loadDevice(nameB, idB, 'responder');
  await a.setup();
  await b.setup();
  return { a, b };
}
async function establish(a, b, conn = kemSecret()) {
  await openText(b, await sealText(a, 'start', conn), conn);
  await openText(a, await sealText(b, 'ok', conn), conn);
  return conn;
}
async function bothNew(a, b) {
  await a.SN.notePeerSafetyCap(a.peerId, 2);
  await b.SN.notePeerSafetyCap(b.peerId, 2);
}

describe('Teil B: stabiler Code ueber die Ratchet-Sitzung', () => {
  beforeEach(() => { global.__mockStores = {}; });

  test('beide Seiten zeigen denselben Code - unabhaengig von der Rolle', async () => {
    const { a, b } = await pairDevices();
    await bothNew(a, b);
    await establish(a, b);
    const ia = await info(a);
    const ib = await info(b);
    expect(ia.mode).toBe('v2');
    expect(ib.mode).toBe('v2');
    expect(ia.number).toBe(ib.number);
    expect(a.SN.isSafetyNumber(ia.number)).toBe(true);
    expect(ia.changed).toBe(false);
    expect(ia.verified).toBe(false);
  });

  test('Mann in der Mitte (zwei Sitzungen): die Codes von Alice und Bob unterscheiden sich', async () => {
    global.__mockStores = {};
    const alice = loadDevice('alice', 'c_mallory_a', 'initiator');
    const malA = loadDevice('malA', 'c_alice', 'responder');
    const malB = loadDevice('malB', 'c_bob', 'initiator');
    const bob = loadDevice('bob', 'c_mallory_b', 'responder');
    for (const d of [alice, malA, malB, bob]) { await d.setup(); await d.SN.notePeerSafetyCap(d.peerId, 2); }
    await establish(alice, malA);
    await establish(malB, bob);
    const ia = await info(alice);
    const ib = await info(bob);
    expect(ia.mode).toBe('v2');
    expect(ib.mode).toBe('v2');
    expect(ia.number).not.toBe(ib.number);
    // Mallory sieht auf ihren beiden Seiten jeweils den passenden Code - aber
    // nie einen, der fuer Alice UND Bob gilt.
    expect((await info(malA)).number).toBe(ia.number);
    expect((await info(malB)).number).toBe(ib.number);
  });

  test('stabil ueber viele neue Verbindungen, KEM-Schritte und Nachrichten - kein "geaendert"', async () => {
    const { a, b } = await pairDevices();
    await bothNew(a, b);
    const conn = await establish(a, b);
    const first = (await info(a)).number;
    for (let i = 0; i < 10; i++) {
      const kem = kemSecret();                       // neue Verbindung
      await b.RS.noteConnectionKem(b.peerId, kem, 'encap');
      await a.RS.noteConnectionKem(a.peerId, kem, 'decap');
      await openText(b, await sealText(a, 'a' + i, kem), kem);
      await openText(a, await sealText(b, 'b' + i, kem), kem);
      const ia = await info(a, 'neuer-verbindungscode-' + i);
      const ib = await info(b, 'neuer-verbindungscode-' + i);
      expect(ia.number).toBe(first);
      expect(ib.number).toBe(first);
      expect(ia.changed).toBe(false);
      expect(ib.changed).toBe(false);
    }
    expect(conn).toBeTruthy();
  });

  test('bestaetigt bleibt bestaetigt (auch nach Neustart); falscher Code wird nicht bestaetigt', async () => {
    const { a, b } = await pairDevices();
    await bothNew(a, b);
    await establish(a, b);
    const { number } = await info(a);
    expect(await a.SN.markVerified(a.peerId, '11111 22222 33333 44444 55555 66666')).toBe(false);
    expect((await info(a)).verified).toBe(false);
    expect(await a.SN.markVerified(a.peerId, number)).toBe(true);
    expect((await info(a)).verified).toBe(true);
    const a2 = loadDevice('alice', a.peerId, 'initiator');      // Neustart
    expect(await info(a2)).toMatchObject({ mode: 'v2', number, verified: true, changed: false });
    await a2.SN.unverify(a2.peerId);
    expect((await info(a2)).verified).toBe(false);
  });

  test('echter Sitzungswechsel (Zuruecksetzen auf beiden Seiten): Warnung, Bestaetigung faellt weg; gesehen -> Warnung weg', async () => {
    const { a, b } = await pairDevices();
    await bothNew(a, b);
    await establish(a, b);
    const old = (await info(a)).number;
    await a.SN.markVerified(a.peerId, old);
    await info(b);
    await a.RS.resetSession(a.peerId);
    await b.RS.resetSession(b.peerId);
    await establish(a, b);
    const ia = await info(a);
    expect(ia.number).not.toBe(old);
    expect(ia).toMatchObject({ mode: 'v2', changed: true, verified: false });
    expect((await info(b)).changed).toBe(true);
    await a.SN.acknowledgeChange(a.peerId);
    expect((await info(a)).changed).toBe(false);
    expect((await info(a)).number).toBe((await info(b)).number);
  });

  test('Sitzung noch im Aufbau (keine Antwort): "pending", erst danach der Code - kein Fehlalarm durch gleichzeitigen Aufbau', async () => {
    global.__mockStores = {};
    const a = loadDevice('alice', 'c_bob', 'initiator');
    const b = loadDevice('bob', 'c_alice', 'initiator');      // beide Rolle initiator -> gleichzeitiger Aufbau
    await a.setup(); await b.setup();
    await bothNew(a, b);
    const conn = kemSecret();
    const fromA = await sealText(a, 'A1', conn);
    const fromB = await sealText(b, 'B1', conn);
    expect((await info(a, '1234-5678-9012-3456')).mode).toBe('pending');
    await Promise.allSettled([openText(b, fromA, conn), openText(a, fromB, conn)]);
    // der Verlierer antwortet in der Sitzung des Gewinners
    const ra = await a.RS.isActive(a.peerId);
    const [winner, loser] = ra ? [a, b] : [b, a];
    await openText(winner, await sealText(loser, 'antwort', conn), conn);
    await openText(loser, await sealText(winner, 'weiter', conn), conn);
    const ia = await info(a);
    const ib = await info(b);
    expect(ia.number).toBe(ib.number);
    expect(ia.changed).toBe(false);
    expect(ib.changed).toBe(false);
  });

  test('Gegenseite 1.0/1.1 (kein caps.sn): alter Verbindungscode mit Hinweis, Bestaetigung nur fuer diese Verbindung', async () => {
    const { a, b } = await pairDevices();
    await establish(a, b);                                   // keine sn-Faehigkeit gemeldet
    const ia = await info(a, '1111-2222-3333-4444');
    expect(ia).toMatchObject({ mode: 'legacy', legacyCode: '1111-2222-3333-4444', legacyVerified: false, number: null });
    await a.SN.markLegacyVerified(a.peerId, '1111-2222-3333-4444');
    expect((await info(a, '1111-2222-3333-4444')).legacyVerified).toBe(true);
    expect((await info(a, '5555-6666-7777-8888')).legacyVerified).toBe(false);   // neue Verbindung
    // Gegenseite aktualisiert: ab jetzt v2 - dieselbe Sitzung, also kein "geaendert".
    await a.SN.notePeerSafetyCap(a.peerId, 2);
    expect(await info(a)).toMatchObject({ mode: 'v2', changed: false, verified: false });
  });

  test('Migration: Speicherabbild 1.1 (Sitzung aktiv, alter safety_code_seen_-Eintrag) - Grundlage ohne Warnung, nichts anderes veraendert', async () => {
    const { a, b } = await pairDevices();
    await establish(a, b);
    await a.ES.setItem('safety_code_seen_' + a.peerId, '1234-5678-9012-3456');
    const before = new Map(a.ES.__store);
    const a2 = loadDevice('alice', a.peerId, 'initiator');    // Update auf die neue Version
    await a2.SN.notePeerSafetyCap(a2.peerId, 2);
    const ia = await info(a2);
    expect(ia).toMatchObject({ mode: 'v2', changed: false, verified: false });
    for (const [k, v] of before) expect(a2.ES.__store.get(k)).toBe(v);
    expect([...a2.ES.__store.keys()].filter((k) => !before.has(k))).toEqual(['safety_v2_' + a.peerId]);
  });

  test('Kontakt loeschen: Eintrag weg; Wipe: laufende Schreibvorgaenge speichern nichts', async () => {
    const { a, b } = await pairDevices();
    await bothNew(a, b);
    await establish(a, b);
    await a.SN.markVerified(a.peerId, (await info(a)).number);
    expect(a.ES.__store.has('safety_v2_' + a.peerId)).toBe(true);
    await a.SN.forget(a.peerId);
    expect(a.ES.__store.has('safety_v2_' + a.peerId)).toBe(false);
    const p = a.SN.notePeerSafetyCap(a.peerId, 2);
    a.SN.forgetAll();
    await a.ES.clear();
    await p;
    expect(a.ES.__store.size).toBe(0);
  });

  test('Loeschen eines Kontakts entfernt auch safety_v2_ (BackgroundSync-Liste)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'BackgroundSync.js'), 'utf8');
    const lists = src.match(/for \(const prefix of \[[^\]]+\]\)/g) || [];
    expect(lists.filter((l) => l.includes("'safety_v2_'")).length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Teil C: Dialog ─────────────────────────────────────────────────────────
describe('Teil C: Dialog (SafetyNumberDialog.tsx)', () => {
  // React, Renderer und Dialog aus DEMSELBEN Modul-Bereich (Hooks).
  let React;
  let renderer;
  let Text;
  let Alert;
  let SN;
  let Dialog;
  let ES;
  const allText = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join(' | ');
  const byId = (tree, id) => tree.root.findAll((n) => n.props && n.props.testID === id && typeof n.type !== 'string')[0]
    || tree.root.findAll((n) => n.props && n.props.testID === id)[0];

  // Haupt-Registry, erst zur Laufzeit (nach Teil B) geladen - React Native und
  // React muessen dieselbe Instanz sein.
  beforeAll(() => {
    require('./helpers/nativeBridgeMock').installKyberModuleMock();
    React = require('react');
    renderer = require('react-test-renderer');
    ({ Text, Alert } = require('react-native'));
    SN = require('../../SafetyNumber');
    Dialog = require('../../SafetyNumberDialog');
    ES = require('react-native-encrypted-storage').default;
  });
  afterEach(() => { jest.restoreAllMocks(); });

  async function render(props) {
    let tree;
    await renderer.act(async () => { tree = renderer.create(React.createElement(Dialog.SafetyNumberDialog, { visible: true, chatId: 'c_x', ...props })); });
    return tree;
  }

  test('v2: zeigt den Code, Oeffnen allein bestaetigt nichts; "Stimmt ueberein" ruft markVerified und onConfirmed', async () => {
    const onConfirmed = jest.fn();
    const onRefresh = jest.fn(async () => {});
    const spy = jest.spyOn(SN, 'markVerified').mockResolvedValue(true);
    const number = '12345 67890 11111 22222 33333 44444';
    const tree = await render({ info: { mode: 'v2', number, verified: false, changed: false }, onConfirmed, onRefresh });
    expect(allText(tree)).toMatch(/12345 {2}67890 {2}11111/);
    expect(allText(tree)).toMatch(/Noch nicht bestätigt/);
    expect(onConfirmed).not.toHaveBeenCalled();
    await renderer.act(async () => { await byId(tree, 'safety-match').props.onPress(); });
    expect(spy).toHaveBeenCalledWith('c_x', number);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    await renderer.act(async () => tree.unmount());
  });

  test('"Stimmt nicht" warnt und bestaetigt nichts', async () => {
    const onConfirmed = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render({ info: { mode: 'v2', number: '12345 67890 11111 22222 33333 44444', verified: false, changed: false }, onConfirmed });
    await renderer.act(async () => { byId(tree, 'safety-mismatch').props.onPress(); });
    expect(alert).toHaveBeenCalledWith('Code stimmt nicht überein', expect.stringMatching(/dazwischen|zwischen euch/));
    expect(onConfirmed).not.toHaveBeenCalled();
    await renderer.act(async () => tree.unmount());
  });

  test('geaenderte Sitzung: Hinweis sichtbar, Schliessen quittiert ihn', async () => {
    const ack = jest.spyOn(SN, 'acknowledgeChange').mockResolvedValue();
    const onClose = jest.fn();
    const tree = await render({ info: { mode: 'v2', number: '12345 67890 11111 22222 33333 44444', verified: false, changed: true }, onClose });
    expect(byId(tree, 'safety-changed')).toBeTruthy();
    await renderer.act(async () => { byId(tree, 'safety-close').props.onPress(); });
    expect(ack).toHaveBeenCalledWith('c_x');
    expect(onClose).toHaveBeenCalled();
    await renderer.act(async () => tree.unmount());
  });

  test('alte Gegenseite: alter Code mit klarem Hinweis "gilt nur fuer diese Verbindung"', async () => {
    const tree = await render({ info: { mode: 'legacy', number: null, legacyCode: '1234-5678-9012-3456', legacyVerified: false } });
    const text = allText(tree);
    expect(text).toMatch(/1234-5678-9012-3456/);
    expect(text).toMatch(/ältere Malachi-Version/);
    expect(text).toMatch(/nur für die aktuelle Verbindung/);
    await renderer.act(async () => tree.unmount());
  });

  test('useSafetyInfo: liest den Zustand und uebergibt den Verbindungscode', async () => {
    const spy = jest.spyOn(SN, 'getSafetyInfo').mockResolvedValue({ mode: 'legacy', number: null, legacyCode: 'abc', legacyVerified: false, verified: false, changed: false });
    let seen = null;
    function Probe() { const [i] = Dialog.useSafetyInfo('c_y', () => 'abc'); seen = i; return null; }
    let tree;
    await renderer.act(async () => { tree = renderer.create(React.createElement(Probe)); });
    expect(spy).toHaveBeenCalledWith('c_y', { legacyCode: 'abc' });
    expect(seen).toMatchObject({ mode: 'legacy', legacyCode: 'abc' });
    expect(Dialog.hasSafetyDisplay(seen)).toBe(true);
    expect(Dialog.hasSafetyDisplay({ mode: 'legacy', legacyCode: null })).toBe(false);
    await renderer.act(async () => tree.unmount());
    expect(ES).toBeTruthy();
  });

  test('Chat (App.tsx): "Vorgestellt von"-Hinweis verschwindet erst nach Bestaetigung, nicht beim Oeffnen', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/chat\?\.introducedBy && !chat\.introducedBy\.confirmed && !safety\?\.verified/);
    expect(app).not.toMatch(/introducedBy: \{ \.\.\.chat\.introducedBy, checked: true \} \}\);\s*setSafetyVisible\(true\)/);
    const confirmed = app.indexOf('onConfirmed={() => {');
    expect(confirmed).toBeGreaterThan(0);
    expect(app.slice(confirmed, confirmed + 600)).toMatch(/confirmed: true/);
    // kein Hinweis mehr bei jeder neuen Verbindung (alter safety_code_seen_-Vergleich)
    expect(app).not.toMatch(/AsyncStorage\.setItem\('safety_code_seen_'/);
  });
});
