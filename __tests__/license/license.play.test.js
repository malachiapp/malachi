// Google-Play-Variante: Kaufpruefung ohne Server (PlayPurchase.js) und
// Freischaltung in LicenseManager.js. Mit einem in diesem Test erzeugten
// RSA-Schluesselpaar (wie aus der Play Console) und gemockten nativen Modulen.
/* global BigInt */
const crypto = require('crypto');
const { Buffer } = require('buffer');
const G = require('../security/helpers/playFixtures');

const mockConfig = {
  STUN_HOST: 'stun.invalid', STUN_URL: 'stun:stun.invalid:3478', LICENSE_PUBLIC_KEY: null, SHOP_ONION: null,
  SHOP_PORT: 80, PRO_PRICE_EUR: '2,99', PLAY_LICENSE_PUBLIC_KEY: null, PLAY_PRODUCT_ID: 'malachi_pro',
};
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const PP = require('../../PlayPurchase');
const LM = require('../../LicenseManager');

let KEY;        // "Google Play" dieser App
let OTHER;      // fremder Schluessel
beforeAll(() => {
  KEY = G.makeRsaKey(2048);
  OTHER = G.makeRsaKey(2048);
});

const opts = () => ({ publicKey: KEY.pubB64, packageName: G.PKG, productId: G.PRODUCT });

// ── PlayPurchase.verifyPlayPurchase ────────────────────────────────────────

describe('Kaufpruefung (PlayPurchase.verifyPlayPurchase)', () => {
  test('gueltige Signatur, eigenes Paket, richtiges Produkt, gekauft -> gueltig', () => {
    const r = PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey), opts());
    expect(r.gueltig).toBe(true);
    expect(r.kauf).toEqual({ purchaseToken: G.TOKEN, orderId: 'GPA.3374-1234-5678-90123', purchaseTime: 1792000000000, acknowledged: false });
  });

  test('bereits bestaetigter Kauf: acknowledged aus dem signierten JSON', () => {
    const r = PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, { acknowledged: true }), opts());
    expect(r.gueltig).toBe(true);
    expect(r.kauf.acknowledged).toBe(true);
  });

  test('SHA-256-Signatur wird ebenfalls angenommen', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, {}, { hash: 'sha256' }), opts()).gueltig).toBe(true);
  });

  test('Produkt als productIds-Liste (neueres Format)', () => {
    const json = G.purchaseJson({ productId: undefined, productIds: ['malachi_pro'] });
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, {}, { json }), opts()).gueltig).toBe(true);
  });

  test('falsche Signatur (anderer Schluessel) -> signatur', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(OTHER.privateKey), opts())).toEqual({ gueltig: false, grund: 'signatur' });
  });

  test('nach dem Signieren veraenderte Kaufdaten -> signatur', () => {
    const p = G.signedPurchase(KEY.privateKey, { productId: 'malachi_basis' });
    const forged = { ...p, originalJson: p.originalJson.replace('malachi_basis', 'malachi_pro') };
    expect(PP.verifyPlayPurchase(forged, opts())).toEqual({ gueltig: false, grund: 'signatur' });
  });

  test.each([
    ['leer', ''],
    ['kein Base64', '!!!nicht-base64!!!'],
    ['zu kurz', Buffer.alloc(64, 1).toString('base64')],
    ['Signatur >= Modulus', Buffer.alloc(256, 0xff).toString('base64')],
  ])('kaputte Signatur (%s) -> signatur/format', (_n, signature) => {
    const p = { ...G.signedPurchase(KEY.privateKey), signature };
    expect(PP.verifyPlayPurchase(p, opts()).gueltig).toBe(false);
    expect(['signatur', 'format']).toContain(PP.verifyPlayPurchase(p, opts()).grund);
  });

  test('falsches Paket -> paket', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, { packageName: 'com.securecommapp' }), opts()))
      .toEqual({ gueltig: false, grund: 'paket' });
  });

  test('falsches Produkt -> produkt', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, { productId: 'malachi_spende' }), opts()))
      .toEqual({ gueltig: false, grund: 'produkt' });
  });

  test('ausstehende Zahlung (purchaseState 4) -> ausstehend, nie gueltig', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, { purchaseState: 4 }), opts()))
      .toEqual({ gueltig: false, grund: 'ausstehend' });
  });

  test('natives Modul meldet "pending" trotz purchaseState 0 -> ausstehend', () => {
    const p = { ...G.signedPurchase(KEY.privateKey), purchaseState: 'pending' };
    expect(PP.verifyPlayPurchase(p, opts()).grund).toBe('ausstehend');
  });

  test('storniert (purchaseState 1) -> status', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey, { purchaseState: 1 }), opts()))
      .toEqual({ gueltig: false, grund: 'status' });
  });

  test('unsigniertes Token des nativen Moduls passt nicht zum signierten -> format', () => {
    const p = { ...G.signedPurchase(KEY.privateKey), purchaseToken: 'fremdes-token' };
    expect(PP.verifyPlayPurchase(p, opts())).toEqual({ gueltig: false, grund: 'format' });
  });

  test.each([
    ['null', null],
    ['leer', ''],
    ['Unsinn', 'kein-schluessel'],
    ['EC- statt RSA-Schluessel', crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')],
  ])('kein brauchbarer Schluessel (%s) -> nicht-konfiguriert', (_n, publicKey) => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey), { ...opts(), publicKey }))
      .toEqual({ gueltig: false, grund: 'nicht-konfiguriert' });
  });

  test('zu kurzer RSA-Schluessel (1024 Bit) wird abgelehnt', () => {
    const weak = G.makeRsaKey(1024);
    expect(() => PP.parseRsaPublicKey(weak.pubB64)).toThrow();
    expect(PP.verifyPlayPurchase(G.signedPurchase(weak.privateKey), { ...opts(), publicKey: weak.pubB64 }).grund).toBe('nicht-konfiguriert');
  });

  test('ohne eigenen Paketnamen wird nie geprueft', () => {
    expect(PP.verifyPlayPurchase(G.signedPurchase(KEY.privateKey), { ...opts(), packageName: null }).grund).toBe('nicht-konfiguriert');
  });

  test('parseRsaPublicKey liest Modulus und Exponent wie Node', () => {
    const k = PP.parseRsaPublicKey(KEY.pubB64);
    const jwk = KEY.publicKey.export({ format: 'jwk' });
    expect(k.n.toString(16)).toBe(Buffer.from(jwk.n, 'base64url').toString('hex').replace(/^0+/, ''));
    expect(k.e).toBe(BigInt(65537));
    expect(k.k).toBe(256);
  });

  test('purchaseTokenHash: SHA-256 hex, nie das Token selbst', () => {
    const h = PP.purchaseTokenHash(G.TOKEN);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(crypto.createHash('sha256').update(G.TOKEN, 'utf8').digest('hex'));
  });
});

// ── LicenseManager in der Play-Variante ───────────────────────────────────

let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); G.removePlayNativeMocks(); });

let billing;
beforeEach(async () => {
  mockConfig.PLAY_LICENSE_PUBLIC_KEY = KEY.pubB64;
  await EncryptedStorage.clear();
  billing = G.installPlayNativeMocks();
  LM._resetLicenseManagerForTests();
});

const stored = async () => {
  const raw = await EncryptedStorage.getItem(LM.PLAY_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
};
/** Neustart der App simulieren: Arbeitsspeicher weg, verschluesselter Speicher bleibt. */
const restart = () => LM._resetLicenseManagerForTests();

describe('Play-Variante: Freischaltung (LicenseManager)', () => {
  test('Zustand kennt die Variante, kein Shop-Kauf, kein Geraetecode', async () => {
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ distribution: 'play', loaded: true, pro: false, reason: 'keine-lizenz', deviceCode: null, purchaseAvailable: true });
    await G.flush();
    expect(LM.getLicenseState().playProduct).toMatchObject({ productId: 'malachi_pro', price: '2,99 €' });
    expect(LM.isPro()).toBe(false);
    // Shop-Funktionen sind in der Play-Variante gesperrt
    await expect(LM.startPurchase({ consent: true })).rejects.toMatchObject({ code: 'nicht-konfiguriert' });
    await expect(LM.transferToThisDevice({ orderId: 'x', recoveryCode: 'y' })).rejects.toMatchObject({ code: 'nicht-konfiguriert' });
    expect(await LM.loadShopPaymentMethods()).toBeNull();
    expect(await LM.installLicense('ML1.a.b')).toMatchObject({ ok: false, grund: 'play' });
  });

  test('ohne Play-Schluessel: "nicht verfuegbar", Pro gesperrt - auch mit gueltigem Kauf und Vermerk', async () => {
    mockConfig.PLAY_LICENSE_PUBLIC_KEY = null;
    await EncryptedStorage.setItem(LM.PLAY_STORAGE_KEY, JSON.stringify({ v: 1, tokenHash: PP.purchaseTokenHash(G.TOKEN), productId: 'malachi_pro', purchaseTime: 1, verifiedAt: 1 }));
    billing._purchases = [G.signedPurchase(KEY.privateKey, { acknowledged: true })];
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ pro: false, reason: 'nicht-konfiguriert', licenseCheckAvailable: false, purchaseAvailable: false });
    expect(await LM.isProVerified()).toBe(false);
    await expect(LM.startPlayPurchase()).rejects.toMatchObject({ code: 'nicht-konfiguriert' });
    expect(billing.launchPurchase).not.toHaveBeenCalled();
  });

  test('Kauf: Dialog oeffnen, Google Play meldet "gekauft" -> Pro, bestaetigt, nur Token-Hash gespeichert', async () => {
    await LM.refreshLicense();
    expect(await LM.startPlayPurchase()).toEqual({ started: true });
    expect(billing.launchPurchase).toHaveBeenCalledWith('malachi_pro');
    const p = G.signedPurchase(KEY.privateKey);
    G.emitPurchasesUpdated('OK', [p]);
    await G.flush();
    expect(LM.isPro()).toBe(true);
    expect(LM.getLicenseState()).toMatchObject({ pro: true, reason: 'aktiv', playPending: false, playInfo: { purchaseTime: 1792000000000 } });
    expect(billing.acknowledge).toHaveBeenCalledTimes(1);
    expect(billing.acknowledge).toHaveBeenCalledWith(G.TOKEN);
    const rec = await stored();
    expect(rec).toMatchObject({ v: 1, tokenHash: PP.purchaseTokenHash(G.TOKEN), productId: 'malachi_pro' });
    const raw = await EncryptedStorage.getItem(LM.PLAY_STORAGE_KEY);
    expect(raw).not.toContain(G.TOKEN);
    expect(raw).not.toContain(p.signature);
    expect(raw).not.toContain('GPA.');
  });

  test('ausstehende Zahlung schaltet NICHT frei, wird nicht bestaetigt; erst "gekauft" schaltet frei', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey, { purchaseState: 4 })]);
    await G.flush();
    expect(LM.isPro()).toBe(false);
    expect(LM.getLicenseState().playPending).toBe(true);
    expect(LM.proStatusLabel()).toBe('Zahlung ausstehend');
    expect(billing.acknowledge).not.toHaveBeenCalled();
    expect(await stored()).toBeNull();
    // Neustart, Zahlung noch offen: weiterhin gesperrt
    billing._purchases = [G.signedPurchase(KEY.privateKey, { purchaseState: 4 })];
    restart();
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'play-ausstehend', playPending: true });
    // Zahlung eingegangen
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
    expect(LM.isPro()).toBe(true);
    expect(billing.acknowledge).toHaveBeenCalledWith(G.TOKEN);
  });

  test('Neustart mit Vermerk und bestaetigtem Kauf -> Pro, keine erneute Bestaetigung', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
    expect(LM.isPro()).toBe(true);
    billing.acknowledge.mockClear();
    billing._purchases = [G.signedPurchase(KEY.privateKey, { acknowledged: true })];
    restart();
    expect(LM.isPro()).toBe(false);
    expect(await LM.refreshLicense()).toMatchObject({ pro: true, reason: 'aktiv' });
    expect(billing.queryPurchases).toHaveBeenCalled();
    expect(billing.acknowledge).not.toHaveBeenCalled();
  });

  test('Erstattung/Rueckbuchung: Kauf fehlt beim Neustart -> Pro entzogen, Vermerk geloescht', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
    expect(LM.isPro()).toBe(true);
    expect(await stored()).not.toBeNull();
    billing._purchases = [];                      // Google Play kennt den Kauf nicht mehr
    restart();
    const s = await LM.refreshLicense();
    expect(s).toMatchObject({ pro: false, reason: 'play-widerrufen' });
    expect(LM.licenseErrorMessage(s.reason)).toContain('erstattet');
    expect(await stored()).toBeNull();
    expect(await LM.isProVerified()).toBe(false);
  });

  test('Google Play nicht erreichbar: vermerkter Kauf bleibt aktiv (nichts entziehen ohne echte Antwort)', async () => {
    await EncryptedStorage.setItem(LM.PLAY_STORAGE_KEY, JSON.stringify({ v: 1, tokenHash: PP.purchaseTokenHash(G.TOKEN), productId: 'malachi_pro', purchaseTime: 5, verifiedAt: 1 }));
    billing.queryPurchases.mockRejectedValue(Object.assign(new Error('weg'), { code: 'SERVICE_UNAVAILABLE' }));
    expect(await LM.refreshLicense()).toMatchObject({ pro: true, reason: 'aktiv' });
    expect(await stored()).not.toBeNull();
    // ohne Vermerk: gesperrt, aber kein Fehler beim Start
    await EncryptedStorage.removeItem(LM.PLAY_STORAGE_KEY);
    restart();
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'keine-lizenz', playError: null });
  });

  test('gefaelschter Kauf (falsche Signatur) beim Neustart -> Pro entzogen', async () => {
    await EncryptedStorage.setItem(LM.PLAY_STORAGE_KEY, JSON.stringify({ v: 1, tokenHash: PP.purchaseTokenHash(G.TOKEN), productId: 'malachi_pro', purchaseTime: 5, verifiedAt: 1 }));
    billing._purchases = [G.signedPurchase(OTHER.privateKey, { acknowledged: true })];
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'play-signatur' });
    expect(await stored()).toBeNull();
  });

  test('frischer Kauf mit falschem Paket/Produkt beim Start -> nichts freigeschaltet, nichts bestaetigt', async () => {
    billing._purchases = [
      G.signedPurchase(KEY.privateKey, { packageName: 'com.example.andere' }),
    ];
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'play-paket' });
    billing._purchases = [G.signedPurchase(KEY.privateKey, { productId: 'etwas_anderes' })];
    restart();
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'keine-lizenz' });
    expect(billing.acknowledge).not.toHaveBeenCalled();
    expect(await stored()).toBeNull();
  });

  test('frischer (unbestaetigter) Kauf beim Start wird uebernommen und bestaetigt', async () => {
    billing._purchases = [G.signedPurchase(KEY.privateKey)];
    expect(await LM.refreshLicense()).toMatchObject({ pro: true });
    expect(billing.acknowledge).toHaveBeenCalledWith(G.TOKEN);
  });

  test('Speichern scheitert: nicht bestaetigen (naechster Start versucht es erneut)', async () => {
    billing._purchases = [G.signedPurchase(KEY.privateKey)];
    const spy = jest.spyOn(EncryptedStorage, 'setItem').mockRejectedValueOnce(new Error('voll'));
    await LM.refreshLicense();
    expect(billing.acknowledge).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('nach "Alle Daten loeschen": alter Kauf wird NICHT von selbst aktiv, erst mit "Kaeufe wiederherstellen"', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
    expect(LM.isPro()).toBe(true);
    // Wipe wie performWipe in App.tsx
    await EncryptedStorage.clear();
    LM.resetLicenseStateAfterWipe();
    expect(LM.isPro()).toBe(false);
    expect(await stored()).toBeNull();
    billing._purchases = [G.signedPurchase(KEY.privateKey, { acknowledged: true })];
    restart();
    expect(await LM.refreshLicense()).toMatchObject({ pro: false, reason: 'keine-lizenz', playRestorable: true });
    const s = await LM.restorePlayPurchases();
    expect(s).toMatchObject({ pro: true, reason: 'aktiv', playNotice: 'Kauf wiederhergestellt - Vollversion aktiv.' });
    expect(await stored()).not.toBeNull();
  });

  test('"Kaeufe wiederherstellen" ohne Kauf bzw. ohne Verbindung: klare Meldung, kein Pro', async () => {
    await LM.refreshLicense();
    expect(await LM.restorePlayPurchases()).toMatchObject({ pro: false, playNotice: 'Mit diesem Google-Konto wurde kein Kauf der Vollversion gefunden.' });
    billing.connect.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'BILLING_UNAVAILABLE' }));
    const s = await LM.restorePlayPurchases();
    expect(s.pro).toBe(false);
    expect(s.playError).toContain('Google-Konto');
  });

  test('Kauf abgebrochen / Fehler: Meldung, kein Pro', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('USER_CANCELED');
    await G.flush();
    expect(LM.getLicenseState()).toMatchObject({ pro: false, playNotice: 'Kauf abgebrochen.', playError: null });
    G.emitPurchasesUpdated('NETWORK_ERROR');
    await G.flush();
    expect(LM.getLicenseState().playError).toContain('nicht erreichbar');
    LM.clearPlayMessages();
    expect(LM.getLicenseState()).toMatchObject({ playError: null, playNotice: null });
  });

  test('"schon gekauft" beim Kaufdialog -> wird wiederhergestellt', async () => {
    await LM.refreshLicense();
    billing.launchPurchase.mockResolvedValueOnce({ responseCode: 'ITEM_ALREADY_OWNED' });
    billing._purchases = [G.signedPurchase(KEY.privateKey, { acknowledged: true })];
    expect(await LM.startPlayPurchase()).toEqual({ started: false });
    expect(LM.isPro()).toBe(true);
  });

  test('Kaufdialog nicht startbar -> deutsche Fehlermeldung', async () => {
    await LM.refreshLicense();
    billing.launchPurchase.mockResolvedValueOnce({ responseCode: 'BILLING_UNAVAILABLE' });
    await expect(LM.startPlayPurchase()).rejects.toMatchObject({ code: 'BILLING_UNAVAILABLE' });
    billing.queryProduct.mockResolvedValue(null);
    restart();
    await LM.refreshLicense();
    await expect(LM.startPlayPurchase()).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
  });

  test('Aktualisierung ohne gueltigen Kauf entzieht nie ein aktives Pro', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(OTHER.privateKey)]);
    G.emitPurchasesUpdated('OK', []);
    await G.flush();
    expect(LM.isPro()).toBe(true);
  });

  test('Einstellungszeile: Preis von Google Play statt festem EUR-Betrag', async () => {
    await LM.refreshLicense();
    await G.flush();
    expect(LM.proStatusLabel(LM.getLicenseState())).toBe('2,99 €');
    expect(LM.proStatusLabel({ pro: true })).toBe('Aktiv');
  });

  test('Gating-Regeln sind dieselben wie in der Website-Variante', async () => {
    await LM.refreshLicense();
    G.emitPurchasesUpdated('OK', [G.signedPurchase(KEY.privateKey)]);
    await G.flush();
    const pro = LM.isPro();
    expect(LM.canConfigureDuressPin(pro)).toBe(true);
    expect(LM.failedPinPolicy(5, pro).wipe).toBe(true);
    expect(LM.canSelectTorOnlyMode(pro)).toBe(true);
    expect(LM.shouldNotifyContactsOnWipe(pro)).toBe(true);
  });
});

describe('Website-Variante bleibt unveraendert', () => {
  test('ohne MalachiBuild: web, Play-Funktionen gesperrt, Preiszeile wie bisher', async () => {
    G.removePlayNativeMocks();
    LM._resetLicenseManagerForTests();
    const s = LM.getLicenseState();
    expect(s.distribution).toBe('web');
    expect(LM.isPlayPurchaseAvailable()).toBe(false);
    expect(LM.proStatusLabel(s)).toBe('2,99 EUR');
    await expect(LM.startPlayPurchase()).rejects.toMatchObject({ code: 'nicht-verfuegbar' });
    await expect(LM.restorePlayPurchases()).rejects.toMatchObject({ code: 'nicht-verfuegbar' });
    expect(await LM.loadPlayProduct()).toBeNull();
  });
});
