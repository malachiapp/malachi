/* eslint-env node */
// MediaVault.js (Audit 2026-10-19, G1): Bilder/Sprachnachrichten/Dateien des
// Verlaufs liegen als einzeln verschluesselte Dateien vor - im Verlauf
// (EncryptedStorage) nur Verweis und Schluessel. Geprueft:
//   - Datei enthaelt keinen Klartext, falscher Schluessel/Verweis -> null,
//   - Verweise koennen keine fremden Pfade erreichen,
//   - externalizeEntries: Base64 raus, Verweis rein, bereits abgelegte nicht
//     doppelt, Fehlschlag laesst den Inhalt eingebettet (kein Verlust),
//   - Aufraeumen (einzeln, Bereich, verwaiste Dateien, Wipe),
//   - Verdrahtung in ChatScreen/BackgroundSync (Quelltext-Pruefung).
const fs = require('fs');
const path = require('path');

jest.mock('react-native-fs', () => {
  const files = new Map();
  return {
    __files: files,
    __failWrites: { on: false },
    DocumentDirectoryPath: '/mock/docs',
    CachesDirectoryPath: '/mock/caches',
    writeFile: async (p, d) => {
      if (require('react-native-fs').__failWrites.on) throw new Error('ENOSPC');
      files.set(p, d);
    },
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    unlink: async (p) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    readDir: async (d) => [...files.keys()]
      .filter((p) => p.startsWith(d + '/') && !p.slice(d.length + 1).includes('/'))
      .map((p) => ({ name: p.split('/').pop(), path: p, isFile: () => true })),
  };
});

const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();
const RNFS = require('react-native-fs');
const MV = require('../../MediaVault');

const IMG = 'data:image/jpeg;base64,' + Buffer.from('JPEG-INHALT-'.repeat(500)).toString('base64');
const AUD = Buffer.from('AUDIO-'.repeat(800)).toString('base64');

beforeEach(() => {
  RNFS.__files.clear();
  RNFS.__failWrites.on = false;
  MV.clearMediaCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { console.warn.mockRestore(); console.log.mockRestore(); });

describe('Ablage', () => {
  test('ablegen und lesen; Datei ohne Klartext; ohne RAM-Zwischenspeicher aus der Datei', async () => {
    const ref = await MV.putMedia('c_alice', IMG);
    expect(ref.mref).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof ref.mk).toBe('string');
    const file = RNFS.__files.get(`/mock/docs/media/c_alice/${ref.mref}.enc`);
    expect(file).toBeDefined();
    expect(file).not.toContain(IMG.slice(30, 90));
    expect(file).not.toContain('JPEG');
    expect(await MV.getMedia('c_alice', ref)).toBe(IMG);
    MV.clearMediaCache();
    expect(await MV.getMedia('c_alice', ref)).toBe(IMG);
  });

  test('falscher Schluessel, fehlende Datei, falscher Bereich: null', async () => {
    const a = await MV.putMedia('c_alice', IMG);
    const b = await MV.putMedia('c_alice', AUD);
    MV.clearMediaCache();
    expect(await MV.getMedia('c_alice', { mref: a.mref, mk: b.mk })).toBeNull();
    expect(await MV.getMedia('c_bob', a)).toBeNull();
    expect(await MV.getMedia('c_alice', { mref: '0'.repeat(32), mk: a.mk })).toBeNull();
    expect(await MV.getMedia('c_alice', null)).toBeNull();
  });

  test('Verweise erreichen keine fremden Pfade', async () => {
    const ref = await MV.putMedia('c_alice', IMG);
    for (const mref of ['../../shared_prefs/x', '../inbox_1', 'a/b', '', 'x'.repeat(100), 42]) {
      expect(await MV.getMedia('c_alice', { mref, mk: ref.mk })).toBeNull();
    }
    expect(MV.scopeDir('../../etc')).toBe('/mock/docs/media/______etc');
    expect(() => MV.scopeDir('')).toThrow();
    expect(() => MV.scopeDir('..')).toThrow();
    await MV.removeMedia('c_alice', '../../x');   // kein Fehler, nichts geloescht
    expect(RNFS.__files.size).toBe(1);
  });
});

describe('externalizeEntries (Speichern des Verlaufs)', () => {
  test('Base64 raus, Verweis rein; Texte unveraendert; bereits abgelegte nicht doppelt', async () => {
    const known = new Map();
    const entries = [
      { id: 't1', text: 'hallo', mine: true },
      { id: 'i1', type: 'image', base64: IMG, mine: false },
      { id: 'a1', type: 'audio', base64: AUD, durationMs: 1200, mine: true },
      { id: 'f1', type: 'file', base64: AUD, fileName: 'x.bin', size: 3 },
    ];
    const out = await MV.externalizeEntries('c_alice', entries, known);
    expect(out[0]).toEqual(entries[0]);
    for (const m of out.slice(1)) {
      expect(m.base64).toBeUndefined();
      expect(m.mref).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(out[2]).toMatchObject({ id: 'a1', type: 'audio', durationMs: 1200, mine: true });
    expect(JSON.stringify(out)).not.toContain(AUD.slice(0, 40));
    expect(await MV.mediaData('c_alice', out[1])).toBe(IMG);
    expect(await MV.mediaData('c_alice', entries[1])).toBe(IMG);   // frischer Eintrag: aus dem RAM
    // Zweites Speichern derselben (noch Base64 tragenden) RAM-Eintraege: keine neuen Dateien.
    const before = RNFS.__files.size;
    const out2 = await MV.externalizeEntries('c_alice', entries, known);
    expect(RNFS.__files.size).toBe(before);
    expect(out2.map((m) => m.mref)).toEqual(out.map((m) => m.mref));
    // Geladene Eintraege (nur Verweis) bleiben, wie sie sind.
    const out3 = await MV.externalizeEntries('c_alice', out, new Map());
    expect(out3).toEqual(out);
    expect(RNFS.__files.size).toBe(before);
  });

  test('Eintrag mit Verweis UND Base64 (RAM): gespeichert wird nur der Verweis', async () => {
    const ref = await MV.putMedia('c_alice', IMG);
    const out = await MV.externalizeEntries('c_alice', [{ id: 'i1', type: 'image', base64: IMG, ...ref }], new Map());
    expect(out[0].base64).toBeUndefined();
    expect(out[0].mref).toBe(ref.mref);
  });

  test('Ablegen schlaegt fehl (Speicher voll): Inhalt bleibt eingebettet, naechstes Speichern lagert aus', async () => {
    const known = new Map();
    const entries = [{ id: 'i1', type: 'image', base64: IMG }];
    RNFS.__failWrites.on = true;
    const out = await MV.externalizeEntries('c_alice', entries, known);
    expect(out[0].base64).toBe(IMG);
    expect(out[0].mref).toBeUndefined();
    RNFS.__failWrites.on = false;
    const out2 = await MV.externalizeEntries('c_alice', entries, known);
    expect(out2[0].base64).toBeUndefined();
    expect(await MV.mediaData('c_alice', out2[0])).toBe(IMG);
  });
});

describe('Aufraeumen', () => {
  test('einzeln, verwaiste Dateien eines Bereichs, ganzer Bereich, Wipe', async () => {
    const a = await MV.putMedia('c_alice', IMG);
    const b = await MV.putMedia('c_alice', AUD);
    const c = await MV.putMedia('c_bob', AUD);
    await MV.removeMedia('c_alice', a.mref);
    expect(await MV.getMedia('c_alice', a)).toBeNull();
    expect(await MV.getMedia('c_alice', b)).toBe(AUD);

    const d = await MV.putMedia('c_alice', IMG);
    expect(await MV.sweepScope('c_alice', new Set([b.mref]))).toBe(1);   // d verwaist
    expect(await MV.getMedia('c_alice', d)).toBeNull();
    expect(await MV.getMedia('c_alice', b)).toBe(AUD);
    expect(await MV.getMedia('c_bob', c)).toBe(AUD);                     // anderer Bereich unberuehrt

    await MV.removeScope('c_alice');
    expect(await MV.getMedia('c_alice', b)).toBeNull();
    expect(await MV.getMedia('c_bob', c)).toBe(AUD);

    await MV.wipeAllMedia();
    expect([...RNFS.__files.keys()].filter((p) => p.includes('/media/'))).toEqual([]);
    expect(await MV.getMedia('c_bob', c)).toBeNull();                    // auch nicht aus dem RAM
  });

  // Fehler 2026-10-25: "Sprachnachrichten bleiben beidseitig nicht gespeichert".
  describe('persistChatHistory: Chat oeffnen, waehrend neue Nachrichten ankommen', () => {
    const memStorage = () => {
      const m = new Map();
      return {
        __m: m,
        getItem: async (k) => (m.has(k) ? m.get(k) : null),
        setItem: async (k, v) => { m.set(k, v); },
        removeItem: async (k) => { m.delete(k); },
      };
    };
    const save = (storage, entries, known, historyIncluded, sweep) =>
      MV.persistChatHistory({ storage, key: 'chat_c_alice', scope: 'c_alice', entries, known, historyIncluded, sweep });

    test('aeltere Sprachnachrichten/Bilder ueberleben einen fruehen, unvollstaendigen Stand', async () => {
      const storage = memStorage();
      // Sitzung 1: Verlauf mit Sprachnachricht und Bild gespeichert
      const s1 = await save(storage, [
        { id: 'a1', type: 'audio', base64: AUD, durationMs: 3000 },
        { id: 'i1', type: 'image', base64: IMG },
        { id: 't1', text: 'hallo' },
      ], new Map(), true, true);
      expect(s1.saved).toBe(true);
      const history = JSON.parse(storage.__m.get('chat_c_alice'));
      expect(history.every((m) => !m.base64)).toBe(true);
      MV.clearMediaCache();

      // Sitzung 2: neue Sprachnachricht kommt an, BEVOR der Verlauf geladen ist
      const known = new Map();
      const early = await save(storage, [{ id: 'a2', type: 'audio', base64: AUD + 'X', durationMs: 900 }], known, false, false);
      expect(early).toMatchObject({ saved: false, swept: 0 });
      expect(JSON.parse(storage.__m.get('chat_c_alice'))).toEqual(history);        // Verlauf nicht ueberschrieben
      for (const m of history.filter((x) => x.mref)) expect(await MV.getMedia('c_alice', m)).not.toBeNull();

      // Verlauf eingemischt -> vollstaendiger Stand wird gespeichert, aufgeraeumt wird nichts Benutztes
      const full = [...history, { id: 'a2', type: 'audio', base64: AUD + 'X', durationMs: 900 }];
      const res = await save(storage, full, known, true, true);
      expect(res.saved).toBe(true);
      expect(res.swept).toBe(0);
      const stored = JSON.parse(storage.__m.get('chat_c_alice'));
      expect(stored.map((m) => m.id)).toEqual(['a1', 'i1', 't1', 'a2']);
      MV.clearMediaCache();
      expect(await MV.mediaData('c_alice', stored[0])).toBe(AUD);
      expect(await MV.mediaData('c_alice', stored[1])).toBe(IMG);
      expect(await MV.mediaData('c_alice', stored[3])).toBe(AUD + 'X');
    });

    test('vorher (ohne historyIncluded-Pruefung) haette das Aufraeumen die alten Dateien geloescht', async () => {
      const storage = memStorage();
      await save(storage, [{ id: 'a1', type: 'audio', base64: AUD }], new Map(), true, false);
      const old = JSON.parse(storage.__m.get('chat_c_alice'))[0];
      // Nachstellung des alten Ablaufs: unvollstaendiger Stand MIT Aufraeumen
      const known = new Map();
      await save(storage, [{ id: 'a2', type: 'audio', base64: AUD + 'Y' }], known, true, true);
      MV.clearMediaCache();
      expect(await MV.getMedia('c_alice', old)).toBeNull();   // genau der gemeldete Verlust
    });

    test('eigene Sprachnachricht mit Inhalt wird verschluesselt abgelegt und ist nach einem Neustart abspielbar', async () => {
      const storage = memStorage();
      await save(storage, [{ id: 'm1', type: 'audio', mine: true, base64: AUD, durationMs: 1200, wave: 'G'.repeat(48) }], new Map(), true, true);
      const raw = storage.__m.get('chat_c_alice');
      expect(raw).not.toContain(AUD.slice(0, 40));
      MV.clearMediaCache();
      const [m] = JSON.parse(raw);
      expect(m).toMatchObject({ id: 'm1', mine: true, wave: 'G'.repeat(48) });
      expect(await MV.mediaData('c_alice', m)).toBe(AUD);
      for (const [p, v] of RNFS.__files) if (p.includes('/media/')) expect(v).not.toContain(AUD.slice(0, 40));
    });

    test('leerer, aber vollstaendiger Stand entfernt den Verlauf; ohne Bereich nichts', async () => {
      const storage = memStorage();
      await storage.setItem('chat_c_alice', '[]');
      expect((await save(storage, [], new Map(), true, false)).saved).toBe(true);
      expect(storage.__m.has('chat_c_alice')).toBe(false);
      const r = await MV.persistChatHistory({ storage, key: 'k', scope: null, entries: [{ id: 'x', text: 'y' }], known: new Map(), historyIncluded: true });
      expect(r.saved).toBe(false);
    });
  });

  test('RAM-Zwischenspeicher bleibt begrenzt', async () => {
    const refs = [];
    for (let i = 0; i < 20; i++) refs.push(await MV.putMedia('c_alice', AUD + i));
    // Datei weg -> nur noch aus dem RAM lesbar: hoechstens die letzten 12.
    for (const k of [...RNFS.__files.keys()]) RNFS.__files.delete(k);
    let ausRam = 0;
    for (const r of refs) if (await MV.getMedia('c_alice', r)) ausRam++;
    expect(ausRam).toBeLessThanOrEqual(12);
  });
});

describe('Verdrahtung (Quelltext-Pruefung)', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
  const bg = fs.readFileSync(path.join(__dirname, '../../BackgroundSync.js'), 'utf8');
  const gm = fs.readFileSync(path.join(__dirname, '../../GroupMessaging.js'), 'utf8');

  test('ChatScreen speichert ueber persistChatHistory, nacheinander, nur mit geladenem Verlauf', () => {
    expect(app).toMatch(/const historyIncluded = historyLoadedRef\.current;\s+saveChainRef\.current = saveChainRef\.current\.then\(async \(\) => \{/);
    expect(app).toMatch(/const sweep = historyIncluded && !mediaSweptRef\.current;/);
    expect(app).toMatch(/await persistChatHistory\(\{\s+storage: AsyncStorage, key, scope, entries: toSave, known: mediaRefsRef\.current, historyIncluded, sweep,/);
    // Der Verlauf gilt erst als geladen, wenn er im State eingemischt ist
    expect(app).toMatch(/const applyHistory = \(valid\) => setMsgs\(prev => \{\s+historyLoadedRef\.current = true;/);
    expect(app).not.toMatch(/AsyncStorage\.setItem\(storageKey, JSON\.stringify\(toSave\)\)/);
    expect(app).not.toMatch(/externalizeEntries\(/);
    // Eigene Sprachnachricht mit Inhalt im Verlauf (wird verschluesselt abgelegt)
    expect(app).toMatch(/id: msgId, type: 'audio', mine: true, base64,/);
  });

  test('Anzeige, Abspielen, Oeffnen, Galerie, Siegel lesen ueber MediaVault', () => {
    expect(app).toMatch(/<VaultImage scope=\{chat\?\.id\} item=\{item\}/);
    expect(app).toMatch(/const audioData = await mediaData\(chat\?\.id, item\);/);
    expect(app).toMatch(/const fileData = await mediaData\(chat\?\.id, item\);/);
    expect(app).toMatch(/const data = await mediaData\(chat\?\.id, item\);\s+\/\/ Audit G1/);
    expect(app).not.toMatch(/RNFS\.writeFile\([^,]+, item\.base64,/);
    expect(app).not.toMatch(/source=\{\{ uri: item\.base64 \}\}/);
  });

  test('Loeschen: Nachricht, Chat leeren (beide Seiten), Kontakt, Wipe', () => {
    expect(app).toMatch(/const deleteMessage = \(msgId\) => \{\s+forgetMedia\(msgId\);/);
    expect(app).toMatch(/const clearChatMessages = \(chatId\) => \{\s+PinVault\.removeItem\('chat_' \+ chatId\)\.catch\(\(\) => \{\}\);\s+removeMediaScope\(chatId\)/);
    expect(app).toMatch(/await wipeAllMedia\(\)\.catch\(\(\) => \{\}\);/);
    expect((app.match(/removeMediaScope\(chat\??\.id\)/g) || []).length).toBe(2);   // clear_chat Puffer + live
    expect((bg.match(/removeMediaScope\(contactId\)/g) || []).length).toBe(4);      // Wipe-Kontakt, entfernen, Loeschwunsch, clear_chat
    // delete_message laeuft ueber den PIN-Tresor (applyChatOps) - die Datei
    // des geloeschten Mediums wird dort mit entfernt.
    expect(bg).toMatch(/PinVault\.update\('chat_' \+ contactId, \{ op: 'delete', id: String\(msg\.msgId\) \}\)/);
    expect(bg).toMatch(/for \(const m of hit\) if \(typeof m\.mref === 'string'\) await removeMedia\(contactId, m\.mref\);/);
    expect(gm).toMatch(/await removeMediaScope\(groupMediaScope\(groupId\)\)/);
  });
});
