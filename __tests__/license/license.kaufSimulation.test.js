// Kauf-SIMULATION Ende zu Ende: der echte App-Code (LicenseManager +
// ShopClient) kauft beim echten Shop-Code (shop/test/simulation.js, lokal) -
// nur Tor, Wallet und Blockchain sind simuliert. Prueft Bestellung, Zahlung
// im Pool, Bestaetigung, Lizenz (lokal geprueft, an dieses Geraet gebunden),
// Teilzahlung, Bitcoin und den Umzug auf ein zweites Geraet.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const F = require('../security/helpers/licenseFixtures');

const mockConfig = { LICENSE_PUBLIC_KEY: null, SHOP_ONION: null, SHOP_PORT: 80, PRO_PRICE_EUR: '2,99' };
jest.mock('../../AppConfig', () => mockConfig);

const EncryptedStorage = require('react-native-encrypted-storage').default;
const LM = require('../../LicenseManager');

jest.setTimeout(60000);

let shop;      // Kindprozess
let port;
let deviceKey;
let tor;

/** HTTP an den lokalen Simulations-Shop (ersetzt den Tor-Weg). */
function anfrage(method, pfad, body, typ = 'application/json') {
  return new Promise((resolve, reject) => {
    const daten = body == null ? null : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: pfad, headers: daten ? { 'Content-Type': typ, 'Content-Length': daten.length } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, retryAfter: res.headers['retry-after'] || null }));
    });
    req.on('error', reject);
    req.end(daten);
  });
}
const simuliere = (was, nr) => anfrage('POST', `/__sim/${was}`, `nr=${nr}`, 'application/x-www-form-urlencoded');

beforeAll(async () => {
  shop = spawn(process.execPath, [path.join(__dirname, '..', '..', 'shop', 'test', 'simulation.js'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  port = await new Promise((resolve, reject) => {
    let aus = '';
    const t = setTimeout(() => reject(new Error('Simulation startet nicht: ' + aus)), 30000);
    shop.stdout.on('data', (d) => {
      aus += d;
      const m = /Shop http:\/\/127\.0\.0\.1:(\d+)\//.exec(aus);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    shop.stderr.on('data', (d) => { aus += d; });
    shop.on('exit', (c) => reject(new Error(`Simulation beendet (${c}): ${aus}`)));
  });
});

afterAll(() => { if (shop) shop.kill(); });

beforeEach(async () => {
  mockConfig.LICENSE_PUBLIC_KEY = F.TEST_PUBLIC_B64URL; // Simulation signiert mit dem RFC-8032-Testschluessel
  mockConfig.SHOP_ONION = F.ONION;
  await EncryptedStorage.clear();
  LM._resetLicenseManagerForTests();
  ({ deviceKey, tor } = F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 }));
  tor.httpRequest.mockImplementation(async (host, p, method, pfad, body) => {
    expect(host).toBe(F.ONION);           // die App spricht nur ihre eingebaute Onion-Adresse an
    return anfrage(method, pfad, body);
  });
  LM.configureLicenseManager({ ensureTor: async () => true });
  await LM.refreshLicense();
});

test('Monero: bestellen -> Zahlung im Pool -> bestaetigt -> Vollversion aktiv', async () => {
  expect(LM.isPro()).toBe(false);
  const p = await LM.startPurchase({ consent: true, paymentMethod: 'xmr' });
  expect(p.order).toMatchObject({ status: 'pending', paymentMethod: 'xmr', currency: 'XMR', eurPrice: '2.99' });
  expect(p.order.address).toMatch(/^8/);           // eigene Subadresse je Bestellung
  expect(p.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);

  await simuliere('zahlen', p.orderId);
  expect((await LM.checkPurchase()).order.status).toBe('unconfirmed');
  expect(LM.isPro()).toBe(false);

  await simuliere('bestaetigen', p.orderId);
  const fertig = await LM.checkPurchase();
  expect(fertig.order.status).toBe('paid');
  expect(fertig.done).toBe(true);
  expect(LM.isPro()).toBe(true);
  expect(await LM.isProVerified()).toBe(true);
  // Die Lizenz liegt gespeichert vor und gilt nach einem Neustart weiter.
  LM._resetLicenseManagerForTests();
  F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 });
  expect(await LM.refreshLicense()).toMatchObject({ pro: true, reason: 'aktiv' });
});

test('Teilzahlung: App zeigt den Restbetrag, nach dem Rest wird freigeschaltet', async () => {
  const p = await LM.startPurchase({ consent: true, paymentMethod: 'xmr' });
  await simuliere('teil', p.orderId);
  await simuliere('bestaetigen', p.orderId);
  const teil = await LM.checkPurchase();
  expect(teil.order.status).toBe('underpaid');
  expect(Number(teil.order.missing)).toBeGreaterThan(0);
  expect(Number(teil.order.missing)).toBeLessThan(Number(teil.order.amount));
  await simuliere('teil', p.orderId);   // zweite Haelfte
  await simuliere('bestaetigen', p.orderId);
  expect((await LM.checkPurchase()).order.status).toBe('paid');
  expect(LM.isPro()).toBe(true);
});

test('Bitcoin: bc1q-Adresse, Zahlung, Lizenz', async () => {
  const p = await LM.startPurchase({ consent: true, paymentMethod: 'btc' });
  expect(p.order).toMatchObject({ status: 'pending', paymentMethod: 'btc', currency: 'BTC' });
  expect(p.order.address).toMatch(/^bc1q/);
  await simuliere('zahlen', p.orderId);
  await simuliere('bestaetigen', p.orderId);
  expect((await LM.checkPurchase()).order.status).toBe('paid');
  expect(LM.isPro()).toBe(true);
});

test('Umzug: zweites Geraet bekommt mit Bestellnummer + Code eine eigene Lizenz', async () => {
  const p = await LM.startPurchase({ consent: true, paymentMethod: 'xmr' });
  await simuliere('zahlen', p.orderId);
  await simuliere('bestaetigen', p.orderId);
  await LM.checkPurchase();
  expect(LM.isPro()).toBe(true);

  // Neues Handy: anderer Geraeteschluessel, leerer Speicher.
  await EncryptedStorage.clear();
  LM._resetLicenseManagerForTests();
  ({ deviceKey, tor } = F.installLicenseNativeMocks({ spki: F.SPKI_B_B64 }));
  tor.httpRequest.mockImplementation(async (h, q, method, pfad, body) => anfrage(method, pfad, body));
  LM.configureLicenseManager({ ensureTor: async () => true });
  expect((await LM.refreshLicense()).pro).toBe(false);
  const r = await LM.transferToThisDevice({ orderId: p.orderId, recoveryCode: p.recoveryCode });
  expect(r).toMatchObject({ activations: 2, maxActivations: 3, newActivation: true });
  expect(LM.isPro()).toBe(true);
  expect(LM.getLicenseState().deviceCode).toBe(F.GERAET_B);
});

test('Vertrag widerrufen aus der App: Eingangsbestaetigung, danach eingehende Zahlung schaltet NICHT frei', async () => {
  const RUECK = '8BLD65nFvEm2oFSbgYs2xCikGbeiLCjpeRTtY9DL2m2H8XSsi6RBZDYGHeAYabCowvdPhr9DJ9F3AQtj6k172E6y3nUq6vG';
  const p = await LM.startPurchase({ consent: true, paymentMethod: 'xmr' });
  expect(LM.canWithdrawPurchase(LM.getLicenseState().purchase)).toBe(true);
  // Tippfehler in der Rueckzahlungsadresse: Shop lehnt ab, nichts widerrufen
  await expect(LM.withdrawPurchase({ refundAddress: RUECK.slice(0, -1) + 'x' })).rejects.toMatchObject({ code: 'invalid_refund_address' });
  expect(LM.getLicenseState().purchase.order.status).toBe('pending');

  const w = await LM.withdrawPurchase({ refundAddress: RUECK, name: 'Testperson' });
  expect(w.receipt).toMatch(/Eingangsbestätigung Ihres Widerrufs/);
  expect(w.receipt).toMatch(/Hiermit widerrufe ich/);
  expect(w.refundAddress).toBe(RUECK);
  const rec = LM.getLicenseState().purchase;
  expect(rec.order.status).toBe('withdrawn');
  expect(LM.isPurchaseOpen(rec)).toBe(false);          // keine Zahlungsaufforderung mehr
  expect(LM.canDismissPurchase(rec)).toBe(true);

  // Zahlung kommt trotzdem an: kein Pro, Status bleibt widerrufen
  await simuliere('zahlen', p.orderId);
  await simuliere('bestaetigen', p.orderId);
  LM._resetLicenseManagerForTests();
  ({ deviceKey, tor } = F.installLicenseNativeMocks({ spki: F.SPKI_A_B64 }));
  tor.httpRequest.mockImplementation(async (h, q, method, pfad, body) => anfrage(method, pfad, body));
  LM.configureLicenseManager({ ensureTor: async () => true });
  const s = await LM.refreshLicense();
  expect(s.pro).toBe(false);
  expect(s.purchase.withdrawal.receipt).toMatch(/Eingangsbestätigung/);   // ueberlebt den Neustart
});
