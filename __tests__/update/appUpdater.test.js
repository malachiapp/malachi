// Signierte In-App-Updates (AppUpdater.js, Format: website/UPDATE_FORMAT.md)
// gegen ein gemocktes natives NativeModules.MalachiUpdater: Pruefung mit dem
// Testvektor und frisch erzeugten Testschluesseln, Feldregeln, Versionen,
// ABI-Wahl, Rueckfallschutz, Download-Gegenproben, Installation, Play-
// Variante, Zeitplan (24 h + Zufall, nur mit Tor), keine Geraetedaten in
// Anfragen, nichts Vertrauliches in Logs.
//
// Alle Schluessel hier sind Testschluessel: der oeffentlich bekannte
// Testvektor aus UPDATE_FORMAT.md und pro Lauf frisch erzeugte.
const { NativeModules, Platform } = require('react-native');
const { Buffer } = require('buffer');
const VEKTOR = require('../../website/werkzeuge/test/update-testvektor.json');

const ONION = 'p75bcu4mna6lik35occlsoeoyke46zyikfuq2ugu3wdvu44e5c4wanyd.onion';
const mockConfig = {
  LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99',
  UPDATE_PUBLIC_KEYS: [], UPDATE_ONION: ONION, UPDATE_PATH: '/updates/',
};
jest.mock('../../AppConfig', () => mockConfig);

const { ed25519 } = require('@noble/curves/ed25519.js');
const EncryptedStorage = require('react-native-encrypted-storage').default;
const U = require('../../AppUpdater');

const SEED = Uint8Array.from(Buffer.from(VEKTOR.seedHex, 'hex'));
const VEKTOR_BYTES = () => new Uint8Array(Buffer.from(VEKTOR.manifest, 'utf8'));
const BASE = JSON.parse(VEKTOR.manifest);
const CERT = BASE.signingCertSha256;
const APK_ARM64 = BASE.apks[0];
const APK_V7 = BASE.apks[1];
const OTHER_SHA = 'f'.repeat(64);

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const freshKey = () => {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, pub: b64url(ed25519.getPublicKey(sk)) };
};
const sigFile = (bytes, sk = SEED) => Buffer.from(ed25519.sign(new Uint8Array(bytes), sk)).toString('base64') + '\n';
/** Manifest so serialisieren wie der Signierer (feste Reihenfolge, 2 Leerzeichen, LF am Ende). */
const toBytes = (obj) => new Uint8Array(Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'));
const variant = (patch) => ({ ...BASE, ...patch });

async function codeOf(fn) {
  try { await fn(); } catch (e) { return e instanceof U.UpdateError ? e.code : 'FREMDER-FEHLER: ' + e.message; }
  return null;
}

// ── natives Modul ─────────────────────────────────────────────────────────

let files;
function serve(manifestBytes, sigText) {
  files = {
    '/updates/manifest.json': Buffer.from(manifestBytes),
    '/updates/manifest.json.sig': Buffer.from(sigText, 'utf8'),
  };
}
function installNative(opts = {}) {
  const nat = {
    versionCode: opts.versionCode ?? 11,
    versionName: opts.versionName ?? '1.1.0',
    applicationId: opts.applicationId ?? 'com.securecommapp',
    supportedAbis: opts.abis ?? 'arm64-v8a,armeabi-v7a,armeabi',
    sdkInt: 34,
    fetchSmall: jest.fn(async (host, path, max) => {
      const f = files && files[path];
      if (!f) return { status: 404 };
      if (f.length > max) throw Object.assign(new Error('zu gross'), { code: 'UPDATE_TOO_LARGE' });
      return { status: 200, bodyB64: f.toString('base64'), length: f.length };
    }),
    download: jest.fn(opts.download || (async (host, path, max, sha) => ({ path: '/data/user/0/com.securecommapp/cache/malachi_update/update-0a1b.apk', size: max, sha256: sha }))),
    cancelDownload: jest.fn(async () => true),
    cleanup: jest.fn(async () => 0),
    inspectApk: jest.fn(opts.inspect || (async () => ({ packageName: 'com.securecommapp', versionCode: BASE.versionCode, signers: [CERT], installedSigners: [CERT] }))),
    canRequestPackageInstalls: jest.fn(async () => opts.canInstall ?? true),
    openInstallPermissionSettings: jest.fn(async () => true),
    install: jest.fn(opts.install || (async () => 'started')),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  NativeModules.MalachiUpdater = nat;
  return nat;
}

let logSpies;
beforeEach(async () => {
  Platform.OS = 'android';
  delete NativeModules.MalachiBuild;
  mockConfig.UPDATE_PUBLIC_KEYS = [VEKTOR.oeffentlich];
  mockConfig.UPDATE_ONION = ONION;
  mockConfig.UPDATE_PATH = '/updates/';
  await EncryptedStorage.clear();
  U._resetUpdaterForTests();
  serve(VEKTOR_BYTES(), VEKTOR.signaturDatei);
  logSpies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  logSpies.forEach((s) => s.mockRestore());
  jest.useRealTimers();
});

// ── Signatur ──────────────────────────────────────────────────────────────

describe('Signatur (Testvektor aus UPDATE_FORMAT.md)', () => {
  test('Testvektor ist gueltig; Signieren mit dem Test-Seed ergibt genau die veroeffentlichte Signatur', () => {
    const bytes = VEKTOR_BYTES();
    expect(bytes.length).toBe(VEKTOR.manifestBytes);
    expect(require('crypto').createHash('sha256').update(bytes).digest('hex')).toBe(VEKTOR.manifestSha256);
    expect(sigFile(bytes)).toBe(VEKTOR.signaturDatei);
    const m = U.verifyManifest(bytes, VEKTOR.signaturDatei, [VEKTOR.oeffentlich]);
    expect(m).toMatchObject({ versionName: '1.2.0', versionCode: 12, minSupportedVersionCode: 10, applicationId: 'com.securecommapp' });
    expect(m.releaseNotes).toContain('äöüß');
    // Standard-Schluessel aus AppConfig
    expect(U.verifyManifest(bytes, VEKTOR.signaturDatei).versionCode).toBe(12);
  });

  test('Signaturdatei: mit LF, CRLF oder ohne Zeilenende ok - alles andere nicht', async () => {
    const bytes = VEKTOR_BYTES();
    const core = VEKTOR.signaturDatei.trim();
    expect(U.verifyManifest(bytes, core + '\r\n').versionCode).toBe(12);
    expect(U.verifyManifest(bytes, core).versionCode).toBe(12);
    for (const bad of [core + '\n\n', core + ' \n', ' ' + core + '\n', core.slice(0, 86) + '=\n', core.replace(/==$/, ''), '', 'x'.repeat(2000)]) {
      expect(await codeOf(() => U.verifyManifest(bytes, bad))).toBe('signatur-ungueltig');
    }
  });

  test('Gegenproben: CRLF statt LF, vorangestellter BOM, ein geaendertes Byte, angehaengte Daten -> ungueltig', async () => {
    const text = VEKTOR.manifest;
    const crlf = new Uint8Array(Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8'));
    const bom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
    const flipped = VEKTOR_BYTES(); flipped[100] ^= 0x01;
    const trailing = new Uint8Array(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from('\n')]));
    const trailingJson = new Uint8Array(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from('{}')]));
    const cut = VEKTOR_BYTES().slice(0, VEKTOR.manifestBytes - 1);
    for (const b of [crlf, bom, flipped, trailing, trailingJson, cut]) {
      expect(await codeOf(() => U.verifyManifest(b, VEKTOR.signaturDatei))).toBe('signatur-ungueltig');
    }
  });

  test('falscher Schluessel (frisch erzeugt) -> ungueltig; Liste mit altem und neuem Schluessel -> gueltig', async () => {
    const k = freshKey();
    const bytes = VEKTOR_BYTES();
    expect(await codeOf(() => U.verifyManifest(bytes, VEKTOR.signaturDatei, [k.pub]))).toBe('signatur-ungueltig');
    expect(U.verifyManifest(bytes, VEKTOR.signaturDatei, [k.pub, VEKTOR.oeffentlich]).versionCode).toBe(12);
    // Mit dem frischen Schluessel signiert: nur dieser Schluessel passt.
    const sig = sigFile(bytes, k.sk);
    expect(U.verifyManifest(bytes, sig, [k.pub]).versionCode).toBe(12);
    expect(await codeOf(() => U.verifyManifest(bytes, sig, [VEKTOR.oeffentlich]))).toBe('signatur-ungueltig');
  });

  test('ohne gueltigen eingebauten Schluessel wird nie etwas akzeptiert', async () => {
    const bytes = VEKTOR_BYTES();
    expect(await codeOf(() => U.verifyManifest(bytes, VEKTOR.signaturDatei, []))).toBe('nicht-eingerichtet');
    expect(await codeOf(() => U.verifyManifest(bytes, VEKTOR.signaturDatei, ['kaputt!', 'AAAA', null]))).toBe('nicht-eingerichtet');
    // Nicht-kanonisches Base64url (Standard-Base64 mit Auffuellung) zaehlt nicht.
    expect(await codeOf(() => U.verifyManifest(bytes, VEKTOR.signaturDatei, [Buffer.from(VEKTOR.oeffentlichHex, 'hex').toString('base64')]))).toBe('nicht-eingerichtet');
    mockConfig.UPDATE_PUBLIC_KEYS = [];
    expect(U.isUpdaterConfigured()).toBe(false);
  });

  test('Manifest groesser als 64 KiB wird vor jeder Pruefung abgelehnt', async () => {
    const big = new Uint8Array(65537).fill(0x20);
    expect(await codeOf(() => U.verifyManifest(big, sigFile(big)))).toBe('manifest-ungueltig');
  });
});

// ── Feldregeln ────────────────────────────────────────────────────────────

describe('Feldregeln (UPDATE_FORMAT.md Abschnitt 4) - korrekt signiert, trotzdem abgelehnt', () => {
  const cases = {
    'unbekanntes Feld': variant({ extra: 1 }),
    'falsches format': variant({ format: 'malachi-update' }),
    'formatVersion 2': variant({ formatVersion: 2 }),
    'versionCode 0': variant({ versionCode: 0, minSupportedVersionCode: 0 }),
    'versionCode als Text': variant({ versionCode: '12' }),
    'versionCode zu gross': variant({ versionCode: 2100000001 }),
    'minSupported > versionCode': variant({ minSupportedVersionCode: 13 }),
    'published ohne Z': variant({ published: '2026-10-19T12:00:00' }),
    'published unmoeglich': variant({ published: '2026-13-45T12:00:00Z' }),
    'signingCertSha256 gross': variant({ signingCertSha256: CERT.toUpperCase() }),
    'releaseNotesLang en': variant({ releaseNotesLang: 'en' }),
    'Tab in Hinweisen': variant({ releaseNotes: 'a\tb' }),
    'CR in Hinweisen': variant({ releaseNotes: 'a\r\nb' }),
    'Hinweise zu lang': variant({ releaseNotes: 'x'.repeat(4001) }),
    'versionName mit Leerzeichen': variant({ versionName: '1.2 beta' }),
    'apks leer': variant({ apks: [] }),
    'ABI doppelt': variant({ apks: [APK_ARM64, { ...APK_V7, abi: 'arm64-v8a' }] }),
    'unbekannte ABI': variant({ apks: [{ ...APK_ARM64, abi: 'mips' }] }),
    'Dateiname mit Pfad': variant({ apks: [{ ...APK_ARM64, file: 'x/malachi.apk' }] }),
    'Dateiname ..': variant({ apks: [{ ...APK_ARM64, file: '..malachi.apk' }] }),
    'Dateiname ohne .apk': variant({ apks: [{ ...APK_ARM64, file: 'malachi.zip' }] }),
    'Groesse 0': variant({ apks: [{ ...APK_ARM64, size: 0 }] }),
    'Groesse > 1 GiB': variant({ apks: [{ ...APK_ARM64, size: 1024 * 1024 * 1024 + 1 }] }),
    'sha256 zu kurz': variant({ apks: [{ ...APK_ARM64, sha256: 'abc' }] }),
    'unbekanntes APK-Feld': variant({ apks: [{ ...APK_ARM64, url: 'http://example.com/x.apk' }] }),
  };
  for (const [name, obj] of Object.entries(cases)) {
    test(name, async () => {
      const bytes = toBytes(obj);
      expect(await codeOf(() => U.verifyManifest(bytes, sigFile(bytes)))).toBe('manifest-ungueltig');
    });
  }

  test('ungueltiges UTF-8, BOM, kein JSON, Array, __proto__ - auch korrekt signiert abgelehnt', async () => {
    const overlong = new Uint8Array([...Buffer.from('{"a":"'), 0xc0, 0xaf, ...Buffer.from('"}')]);
    const surrogate = new Uint8Array([...Buffer.from('{"a":"'), 0xed, 0xa0, 0x80, ...Buffer.from('"}')]);
    const bom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VEKTOR.manifest)]));
    const notJson = new Uint8Array(Buffer.from(VEKTOR.manifest + '{}'));
    const arr = new Uint8Array(Buffer.from('[1,2]'));
    const proto = new Uint8Array(Buffer.from(VEKTOR.manifest.replace('"format"', '"__proto__": {},\n  "format"')));
    for (const b of [overlong, surrogate, bom, notJson, arr, proto]) {
      expect(await codeOf(() => U.verifyManifest(b, sigFile(b)))).toBe('manifest-ungueltig');
    }
  });

  test('strenges UTF-8', () => {
    expect(U.isStrictUtf8(Buffer.from('äöüß – €😀', 'utf8'))).toBe(true);
    expect(U.isStrictUtf8(new Uint8Array([0xe2, 0x82]))).toBe(false);          // abgeschnitten
    expect(U.isStrictUtf8(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))).toBe(false); // > U+10FFFF
    expect(U.isStrictUtf8(new Uint8Array([0xe0, 0x80, 0xaf]))).toBe(false);     // ueberlang
    expect(U.isStrictUtf8(new Uint8Array([0xff]))).toBe(false);
  });
});

// ── Versionen, ABI, Rueckfallschutz ───────────────────────────────────────

describe('Versionen und ABI', () => {
  const inst = (versionCode, abis = ['arm64-v8a', 'armeabi-v7a'], applicationId = 'com.securecommapp') => ({ versionCode, abis, applicationId, versionName: 'x' });

  test('nur groessere versionCode wird angeboten (gleich/aelter: kein Update)', () => {
    expect(U.evaluateManifest(BASE, inst(12)).update).toBeNull();
    expect(U.evaluateManifest(BASE, inst(13)).update).toBeNull();
    const r = U.evaluateManifest(BASE, inst(11));
    expect(r.update).toMatchObject({ versionName: '1.2.0', versionCode: 12, important: false, apk: APK_ARM64 });
  });

  test('installierte Version < minSupportedVersionCode -> "wichtig"', () => {
    expect(U.evaluateManifest(BASE, inst(10)).update.important).toBe(false);
    expect(U.evaluateManifest(BASE, inst(9)).update.important).toBe(true);
    expect(U.evaluateManifest(BASE, inst(1)).update.important).toBe(true);
  });

  test('ABI: erste passende in der Reihenfolge des Geraets; keine passende -> kein Angebot', () => {
    expect(U.evaluateManifest(BASE, inst(11, ['x86_64', 'arm64-v8a'])).update.apk.abi).toBe('arm64-v8a');
    expect(U.evaluateManifest(BASE, inst(11, ['armeabi-v7a', 'arm64-v8a'])).update.apk.abi).toBe('armeabi-v7a');
    expect(U.evaluateManifest(BASE, inst(11, ['x86']))).toEqual({ update: null, reason: 'keine-abi' });
    expect(U.evaluateManifest(BASE, inst(11, []))).toEqual({ update: null, reason: 'keine-abi' });
  });

  test('fremde App-ID und Demo-Builds lehnen ab', async () => {
    expect(await codeOf(() => U.evaluateManifest(BASE, inst(11, undefined, 'com.securecommapp.demo')))).toBe('falsche-app');
    expect(await codeOf(() => U.evaluateManifest(variant({ applicationId: 'com.securecommapp.demo' }), inst(11)))).toBe('falsche-app');
    expect(await codeOf(() => U.evaluateManifest(variant({ applicationId: 'org.example.app' }), inst(11)))).toBe('falsche-app');
  });

  test('Rueckfallschutz: kleinere versionCode oder gleiche mit aelterem published -> verworfen', async () => {
    const seen = { versionCode: 12, published: '2026-10-19T12:00:00Z' };
    expect(await codeOf(() => U.checkRollback(variant({ versionCode: 11, minSupportedVersionCode: 10 }), seen))).toBe('rueckfall');
    expect(await codeOf(() => U.checkRollback(variant({ published: '2026-10-19T11:59:59Z' }), seen))).toBe('rueckfall');
    expect(await codeOf(() => U.checkRollback(BASE, seen))).toBeNull();
    expect(await codeOf(() => U.checkRollback(variant({ published: '2026-10-20T00:00:00Z' }), seen))).toBeNull();
    expect(await codeOf(() => U.checkRollback(variant({ versionCode: 13 }), seen))).toBeNull();
    expect(await codeOf(() => U.checkRollback(BASE, null))).toBeNull();
  });
});

// ── Pruefen ueber das native Modul ────────────────────────────────────────

describe('Update-Pruefung ueber Tor', () => {
  test('genau zwei GETs (Manifest + Signatur) an die eingebaute Onion-Adresse - sonst nichts', async () => {
    const nat = installNative();
    await U.checkForUpdate();
    const s = U.getUpdateState();
    expect(s.checkError).toBeNull();
    expect(s.update).toMatchObject({ versionName: '1.2.0', versionCode: 12, important: false });
    expect(s.update.apk).toEqual(APK_ARM64);
    expect(nat.fetchSmall.mock.calls).toEqual([
      [ONION, '/updates/manifest.json', 65536, U.FETCH_TIMEOUT_MS],
      [ONION, '/updates/manifest.json.sig', 1024, U.FETCH_TIMEOUT_MS],
    ]);
    // Keine Geraetedaten: weder Version, ABI, App-ID noch sonst etwas geht in die Anfrage.
    const sent = JSON.stringify(nat.fetchSmall.mock.calls);
    for (const secret of ['1.1.0', 'arm64', 'com.securecommapp', '"11"']) expect(sent).not.toContain(secret);
    expect(nat.download).not.toHaveBeenCalled();
    // Gespeichert nur in EncryptedStorage
    const stored = JSON.parse(await EncryptedStorage.getItem('update_state_v1'));
    expect(stored).toMatchObject({ autoCheck: true, seen: { versionCode: 12, published: '2026-10-19T12:00:00Z' } });
    expect(stored.lastCheckAt).toBeGreaterThan(0);
  });

  test('nicht eingerichtet (keine Schluessel) -> "Updates werden eingerichtet", kein Abruf', async () => {
    mockConfig.UPDATE_PUBLIC_KEYS = [];
    const nat = installNative();
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('nicht-eingerichtet');
    expect(U.updateErrorMessage('nicht-eingerichtet')).toBe('Updates werden eingerichtet.');
    expect(nat.fetchSmall).not.toHaveBeenCalled();
  });

  test('Onion-Adresse ungueltig oder anderes Verzeichnis -> nicht eingerichtet, kein Abruf', async () => {
    const nat = installNative();
    mockConfig.UPDATE_ONION = 'malachi.example.com';
    await U.checkForUpdate();
    mockConfig.UPDATE_ONION = ONION;
    mockConfig.UPDATE_PATH = '/';
    await U.checkForUpdate();
    expect(nat.fetchSmall).not.toHaveBeenCalled();
  });

  test('Tor nicht verbunden -> kein Abruf; Tor meldet TOR_OFF -> "tor-aus"', async () => {
    const nat = installNative();
    U.configureUpdater({ isTorUp: () => false });
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('tor-aus');
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    U.configureUpdater({ isTorUp: () => true });
    nat.fetchSmall.mockRejectedValueOnce(Object.assign(new Error('Tor laeuft nicht'), { code: 'TOR_OFF' }));
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('tor-aus');
  });

  test('aktuell, nicht erreichbar, noch nichts veroeffentlicht', async () => {
    let nat = installNative({ versionCode: 12 });
    await U.checkForUpdate();
    expect(U.getUpdateState()).toMatchObject({ update: null, upToDate: true, checkError: null });
    files = {};
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('nicht-veroeffentlicht');
    nat.fetchSmall.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UPDATE_TIMEOUT' }));
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('nicht-erreichbar');
    nat = installNative();
    nat.fetchSmall.mockResolvedValueOnce({ status: 500 });
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('nicht-erreichbar');
  });

  test('falsch signierte Antwort wird verworfen - ein schon bekanntes Update bleibt', async () => {
    installNative();
    await U.checkForUpdate();
    expect(U.getUpdateState().update.versionCode).toBe(12);
    const fake = toBytes(variant({ versionCode: 99, releaseNotes: 'Bitte sofort installieren: http://boese.example' }));
    serve(fake, sigFile(fake, freshKey().sk));
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('signatur-ungueltig');
    expect(U.getUpdateState().update.versionCode).toBe(12);
  });

  test('Antwort groesser als erlaubt (Manifest > 64 KiB, Signatur > 1 KiB) wird abgelehnt', async () => {
    const nat = installNative();
    nat.fetchSmall.mockResolvedValueOnce({ status: 200, bodyB64: Buffer.alloc(65537, 0x20).toString('base64') });
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('manifest-ungueltig');
    files['/updates/manifest.json.sig'] = Buffer.alloc(2000, 0x41);
    await U.checkForUpdate();
    expect(U.getUpdateState().update).toBeNull();
    expect(U.getUpdateState().checkError).toBe('nicht-erreichbar'); // natives Limit (1 KiB) greift
  });

  test('Rueckfall: nach Version 12 wird ein gueltig signiertes Manifest mit 11 verworfen', async () => {
    installNative({ versionCode: 5 });
    await U.checkForUpdate();
    expect(U.getUpdateState().update.versionCode).toBe(12);
    const old = toBytes(variant({ versionCode: 11, versionName: '1.1.9', minSupportedVersionCode: 1 }));
    serve(old, sigFile(old));
    await U.checkForUpdate();
    expect(U.getUpdateState().checkError).toBe('rueckfall');
    expect(U.getUpdateState().update.versionCode).toBe(12);
  });

  test('wichtiges Update (installiert < minSupported)', async () => {
    installNative({ versionCode: 9 });
    await U.checkForUpdate();
    expect(U.getUpdateState().update.important).toBe(true);
  });

  test('nach einem Neustart wird das gespeicherte Manifest erneut geprueft; nach dem Update ist es weg', async () => {
    installNative();
    await U.checkForUpdate();
    U._resetUpdaterForTests();
    await U.loadUpdateState();
    expect(U.getUpdateState().update.versionCode).toBe(12);
    // Neuer Schluessel in der App (alter entfernt): gespeicherte Angaben gelten nicht mehr.
    U._resetUpdaterForTests();
    mockConfig.UPDATE_PUBLIC_KEYS = [freshKey().pub];
    await U.loadUpdateState();
    expect(U.getUpdateState().update).toBeNull();
    // Update installiert (versionCode 12): nichts mehr anzubieten.
    mockConfig.UPDATE_PUBLIC_KEYS = [VEKTOR.oeffentlich];
    U._resetUpdaterForTests();
    await U.checkForUpdate();
    installNative({ versionCode: 12 });
    U._resetUpdaterForTests();
    await U.loadUpdateState();
    expect(U.getUpdateState().update).toBeNull();
    const stored = JSON.parse(await EncryptedStorage.getItem('update_state_v1'));
    expect(stored.manifestB64).toBeNull();
  });

  test('Hinweis ausblenden: gilt fuer diese Version, auch nach Neustart', async () => {
    installNative();
    await U.checkForUpdate();
    await U.dismissBanner();
    expect(U.getUpdateState().bannerDismissed).toBe(true);
    U._resetUpdaterForTests();
    await U.loadUpdateState();
    expect(U.getUpdateState().bannerDismissed).toBe(true);
  });

  test('wichtiges Update: Ausblenden nur bis zum naechsten Start', async () => {
    installNative({ versionCode: 9 });
    await U.checkForUpdate();
    await U.dismissBanner();
    expect(U.getUpdateState().bannerDismissed).toBe(true);
    U._resetUpdaterForTests();
    await U.loadUpdateState();
    expect(U.getUpdateState().bannerDismissed).toBe(false);
  });
});

// ── Download und Installation ─────────────────────────────────────────────

describe('Download, Gegenproben, Installation', () => {
  async function ready(opts) {
    const nat = installNative(opts);
    await U.checkForUpdate();
    return nat;
  }

  test('laedt nur die signierte Datei mit Groesse und SHA-256 aus dem Manifest, prueft die APK, installiert', async () => {
    const nat = await ready();
    expect(await U.downloadUpdate()).toBe(true);
    expect(nat.download.mock.calls).toEqual([[ONION, '/updates/' + APK_ARM64.file, APK_ARM64.size, APK_ARM64.sha256, U.DOWNLOAD_TIMEOUT_MS]]);
    expect(nat.inspectApk).toHaveBeenCalledTimes(1);
    const s = U.getUpdateState();
    expect(s.dl).toMatchObject({ status: 'ready', received: APK_ARM64.size, error: null });
    expect(await U.installUpdate()).toEqual({ started: true });
    expect(nat.install).toHaveBeenCalledWith(s.dl.file.path, APK_ARM64.sha256, APK_ARM64.size);
  });

  test('SHA-256 aus dem nativen Ergebnis passt nicht -> Datei geloescht, keine Installation', async () => {
    const nat = await ready({ download: async (h, p, max) => ({ path: '/x/malachi_update/update-1.apk', size: max, sha256: OTHER_SHA }) });
    expect(await U.downloadUpdate()).toBe(false);
    expect(U.getUpdateState().dl).toMatchObject({ status: 'error', error: 'pruefsumme', file: null });
    expect(nat.cleanup).toHaveBeenCalled();
    expect(nat.inspectApk).not.toHaveBeenCalled();
    expect(await U.installUpdate()).toMatchObject({ started: false });
    expect(nat.install).not.toHaveBeenCalled();
  });

  test('Groesse passt nicht bzw. natives Limit/Pruefsumme schlaegt an -> keine Installation', async () => {
    let nat = await ready({ download: async (h, p, max, sha) => ({ path: '/x/a.apk', size: max - 1, sha256: sha }) });
    expect(await U.downloadUpdate()).toBe(false);
    expect(U.getUpdateState().dl.error).toBe('pruefsumme');
    nat.download.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UPDATE_TOO_LARGE' }));
    expect(await U.downloadUpdate()).toBe(false);
    expect(U.getUpdateState().dl.error).toBe('zu-gross');
    nat.download.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UPDATE_SHA256' }));
    expect(await U.downloadUpdate()).toBe(false);
    expect(U.getUpdateState().dl.error).toBe('pruefsumme');
    expect(await U.installUpdate()).toMatchObject({ started: false });
    expect(nat.install).not.toHaveBeenCalled();
    // Obergrenze beim Laden = die signierte Groesse, nie mehr.
    for (const c of nat.download.mock.calls) expect(c[2]).toBe(APK_ARM64.size);
  });

  test('APK mit fremdem Zertifikat, fremdem Paket oder falscher Version -> verworfen', async () => {
    const cases = [
      [{ packageName: 'com.securecommapp', versionCode: 12, signers: [OTHER_SHA], installedSigners: [CERT] }, 'apk-signatur'],
      [{ packageName: 'com.securecommapp', versionCode: 12, signers: [CERT], installedSigners: [OTHER_SHA] }, 'andere-signatur'],
      [{ packageName: 'com.evil', versionCode: 12, signers: [CERT], installedSigners: [CERT] }, 'apk-ungueltig'],
      [{ packageName: 'com.securecommapp', versionCode: 11, signers: [CERT], installedSigners: [CERT] }, 'apk-ungueltig'],
      [null, 'apk-ungueltig'],
    ];
    for (const [info, code] of cases) {
      U._resetUpdaterForTests();
      const nat = await ready({ inspect: async () => info });
      expect(await U.downloadUpdate()).toBe(false);
      expect(U.getUpdateState().dl.error).toBe(code);
      expect(nat.cleanup).toHaveBeenCalled();
      expect(nat.install).not.toHaveBeenCalled();
    }
    // Liefert das Geraet keine Zertifikate, bleibt Androids eigene Pruefung.
    U._resetUpdaterForTests();
    await ready({ inspect: async () => ({ packageName: 'com.securecommapp', versionCode: 12, signers: [], installedSigners: [] }) });
    expect(await U.downloadUpdate()).toBe(true);
  });

  test('Abbrechen: kein Fehler, Teildatei weg', async () => {
    const nat = await ready({ download: async () => { throw Object.assign(new Error('x'), { code: 'UPDATE_CANCELLED' }); } });
    expect(await U.downloadUpdate()).toBe(false);
    expect(U.getUpdateState().dl).toMatchObject({ status: 'idle', error: null });
    expect(nat.cleanup).toHaveBeenCalled();
    await U.cancelDownload();
    expect(nat.cancelDownload).toHaveBeenCalled();
  });

  test('ohne "Unbekannte Apps installieren": erst Erklaerung/Einstellung, kein Installer-Aufruf', async () => {
    const nat = await ready({ canInstall: false });
    await U.downloadUpdate();
    expect(await U.installUpdate()).toEqual({ started: false, needsPermission: true });
    expect(nat.install).not.toHaveBeenCalled();
    expect(await U.openInstallPermissionSettings()).toBe(true);
    nat.canRequestPackageInstalls.mockResolvedValue(true);
    nat.install.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UPDATE_PERMISSION' }));
    expect(await U.installUpdate()).toEqual({ started: false, needsPermission: true });
    expect(await U.installUpdate()).toEqual({ started: true });
  });

  test('Installer meldet geaenderte Datei -> verworfen', async () => {
    const nat = await ready();
    await U.downloadUpdate();
    nat.install.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UPDATE_SHA256' }));
    expect(await U.installUpdate()).toEqual({ started: false, error: 'pruefsumme' });
    expect(U.getUpdateState().dl.status).toBe('error');
  });

  test('ohne angebotenes Update wird nichts geladen', async () => {
    const nat = installNative({ versionCode: 12 });
    await U.checkForUpdate();
    expect(await U.downloadUpdate()).toBe(false);
    expect(nat.download).not.toHaveBeenCalled();
  });
});

// ── Play-Variante ─────────────────────────────────────────────────────────

describe('Play-Variante', () => {
  test('distribution "play" -> alles aus: keine Pruefung, kein Download, kein Zeitplan', async () => {
    NativeModules.MalachiBuild = { distribution: 'play' };
    const nat = installNative();
    expect(U.getDistribution()).toBe('play');
    expect(U.isUpdaterAvailable()).toBe(false);
    await U.checkForUpdate();
    expect(await U.downloadUpdate()).toBe(false);
    expect(await U.installUpdate()).toMatchObject({ started: false });
    const stop = U.startUpdateScheduler({ isTorUp: () => true });
    stop();
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    expect(nat.cleanup).not.toHaveBeenCalled();
    expect(nat.download).not.toHaveBeenCalled();
    expect(nat.install).not.toHaveBeenCalled();
  });

  test('ohne MalachiBuild gilt "web"; unbekannter Vertriebsweg -> aus; ohne natives Modul -> aus; iOS -> aus', () => {
    installNative();
    expect(U.getDistribution()).toBe('web');
    expect(U.isUpdaterAvailable()).toBe(true);
    NativeModules.MalachiBuild = { distribution: 'web' };
    expect(U.isUpdaterAvailable()).toBe(true);
    NativeModules.MalachiBuild = { distribution: 'fdroid' };
    expect(U.isUpdaterAvailable()).toBe(false);
    delete NativeModules.MalachiBuild;
    delete NativeModules.MalachiUpdater;
    expect(U.isUpdaterAvailable()).toBe(false);
    installNative();
    Platform.OS = 'ios';
    expect(U.isUpdaterAvailable()).toBe(false);
  });
});

// ── Zeitplan ──────────────────────────────────────────────────────────────

describe('Zeitplan', () => {
  function setup({ tor = false, random = 0.5 } = {}) {
    jest.useFakeTimers();
    const nat = installNative();
    const clock = { now: 1790000000000 };
    const torState = { up: tor, listener: null };
    const stop = U.startUpdateScheduler({
      isTorUp: () => torState.up,
      onTorState: (fn) => { torState.listener = fn; return () => { torState.listener = null; }; },
      now: () => clock.now,
      random: () => random,
    });
    const setTor = (up) => { torState.up = up; torState.listener && torState.listener({ status: up ? 'ON' : 'OFF' }); };
    const advance = async (ms) => {
      clock.now += ms;
      await jest.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return { nat, clock, setTor, advance, stop, torState };
  }
  const startDelay = (r) => U.CHECK_START_DELAY_MIN_MS + Math.floor(r * (U.CHECK_START_DELAY_MAX_MS - U.CHECK_START_DELAY_MIN_MS));

  test('beim Start: alte Download-Reste werden geloescht', async () => {
    const { nat, stop } = setup();
    expect(nat.cleanup).toHaveBeenCalledTimes(1);
    stop();
  });

  test('Tor aus -> keine Anfrage, egal wie lange; Tor an -> erste Pruefung erst nach Zufallsverzoegerung', async () => {
    const { nat, setTor, advance, stop } = setup({ tor: false });
    await advance(3 * 60 * 60 * 1000);
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    setTor(true);
    await advance(startDelay(0.5) - 1000);
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    await advance(2000);
    expect(nat.fetchSmall).toHaveBeenCalledTimes(2);
    stop();
  });

  test('hoechstens einmal je 24 h + Zufall (0-6 h)', async () => {
    const { nat, clock, setTor, advance, stop } = setup({ tor: true, random: 0.5 });
    await advance(startDelay(0.5) + 1000);
    expect(nat.fetchSmall).toHaveBeenCalledTimes(2);
    const first = U.getUpdateState().lastCheckAt;
    const stored = JSON.parse(await EncryptedStorage.getItem('update_state_v1'));
    expect(stored.nextCheckAt).toBe(first + U.CHECK_INTERVAL_MS + 0.5 * U.CHECK_JITTER_MS);
    // 26 h spaeter (vor 24 h + 3 h Zufall): noch nichts, auch nicht bei Tor-Ereignissen
    await advance(26 * 60 * 60 * 1000);
    setTor(true);
    await advance(U.CHECK_START_DELAY_MAX_MS);
    expect(nat.fetchSmall).toHaveBeenCalledTimes(2);
    // nach 27 h + Startverzoegerung: zweite Pruefung
    clock.now = first + U.CHECK_INTERVAL_MS + 0.5 * U.CHECK_JITTER_MS;
    setTor(true);
    await advance(startDelay(0.5) + 1000);
    expect(nat.fetchSmall).toHaveBeenCalledTimes(4);
    stop();
  });

  test('Tor faellt waehrend der Startverzoegerung aus -> keine Anfrage', async () => {
    const { nat, setTor, advance, stop } = setup({ tor: true, random: 0.9 });
    await advance(10 * 1000);
    setTor(false);
    await advance(U.CHECK_START_DELAY_MAX_MS);
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    stop();
  });

  test('"Automatisch nach Updates suchen" aus -> keine Anfrage; wieder an -> Pruefung', async () => {
    const { nat, advance, stop } = setup({ tor: false });
    await advance(1);
    await U.setAutoCheck(false);
    expect(JSON.parse(await EncryptedStorage.getItem('update_state_v1')).autoCheck).toBe(false);
    U.configureUpdater({ isTorUp: () => true });
    await advance(5 * U.SCHEDULER_TICK_MS);
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    await U.setAutoCheck(true);
    await advance(U.CHECK_START_DELAY_MAX_MS);
    expect(nat.fetchSmall).toHaveBeenCalledTimes(2);
    stop();
  });

  test('ohne Schluessel prueft der Zeitplan nie', async () => {
    mockConfig.UPDATE_PUBLIC_KEYS = [];
    const { nat, advance, stop } = setup({ tor: true });
    await advance(48 * 60 * 60 * 1000);
    expect(nat.fetchSmall).not.toHaveBeenCalled();
    stop();
  });

  test('der Zeitplan laedt nie eine APK', async () => {
    const { nat, advance, stop } = setup({ tor: true });
    await advance(3 * 24 * 60 * 60 * 1000);
    expect(U.getUpdateState().update).not.toBeNull();
    expect(nat.download).not.toHaveBeenCalled();
    expect(nat.install).not.toHaveBeenCalled();
    stop();
  });
});

// ── Logs ──────────────────────────────────────────────────────────────────

describe('Logs', () => {
  test('weder Adresse noch Pfade, Pruefsummen, Signatur oder Versionshinweise landen im Log', async () => {
    const nat = installNative();
    await U.checkForUpdate();
    await U.downloadUpdate();
    await U.installUpdate();
    nat.download.mockRejectedValueOnce(Object.assign(new Error('Abruf von ' + ONION + ' fehlgeschlagen'), { code: 'UPDATE_FAILED' }));
    await U.downloadUpdate();
    const fake = toBytes(variant({ versionCode: 99 }));
    serve(fake, sigFile(fake, freshKey().sk));
    await U.checkForUpdate();
    nat.fetchSmall.mockRejectedValueOnce(Object.assign(new Error(ONION + ' nicht erreichbar'), { code: 'UPDATE_FAILED' }));
    await U.checkForUpdate();
    const logged = logSpies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    for (const secret of [ONION, ONION.slice(0, 20), '/updates/', APK_ARM64.sha256, CERT, VEKTOR.signaturDatei.trim(), 'äöüß', 'malachi_update']) {
      expect(logged).not.toContain(secret);
    }
  });
});

// ── Anzeige-Helfer ────────────────────────────────────────────────────────

describe('Anzeige-Helfer', () => {
  test('Groesse, Datum, Versionshinweise als reiner Text', () => {
    expect(U.formatSize(41234567)).toBe('41,2 MB');
    expect(U.formatSize(999)).toBe('1 kB');
    expect(U.formatDate('2026-10-19T12:00:00Z')).toBe('19.10.2026');
    expect(U.releaseNoteBlocks('Absatz eins\n- Punkt <b>a</b>\n\nZweiter Absatz')).toEqual([
      { kind: 'text', text: 'Absatz eins' },
      { kind: 'bullet', text: 'Punkt <b>a</b>' },
      { kind: 'gap' },
      { kind: 'text', text: 'Zweiter Absatz' },
    ]);
  });
});
