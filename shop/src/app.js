// HTTP-Schicht: Webseite (ohne JavaScript) und JSON-API fuer den In-App-Kauf.
// Sicherheits-Header, Groessenlimits, Ratenbegrenzung, Fehler ohne Stacktraces.
// Es werden keine Dateien anhand der URL gelesen (kein Pfad-Traversal moeglich):
// Stylesheets liegen im Speicher, alles andere wird erzeugt.

import fs from 'node:fs';
import http from 'node:http';
import { BESTELLNUMMER_LAENGE, normalisieren } from './ids.js';
import { ShopFehler, STATUS, betragText, offenerBetrag, waehrungsDaten } from './bestellungen.js';
import { TokenEimer, EimerJeSchluessel } from './ratenbegrenzung.js';
import { proxyProtokollServer } from './proxyprotokoll.js';
import { qrSvg, qrPng } from './qr.js';
import * as seiten from './seiten.js';

const MAX_URL = 512;
const MAX_KOERPER = 2048;

const SICHERHEITS_HEADER = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-DNS-Prefetch-Control': 'off',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** ShopFehler-Code -> HTTP-Status und API-Code. */
const FEHLER = {
  zustimmung: [400, 'consent_required'],
  geraetecode: [400, 'invalid_device_code'],
  zahlungsweg: [400, 'invalid_payment_method'],
  rate: [429, 'rate_limited'],
  voll: [503, 'busy'],
  kurs: [503, 'exchange_rate_unavailable'],
  netz: [503, 'payment_backend_unavailable'],
  code: [403, 'invalid_order_or_recovery_code'],
  gesperrt: [429, 'temporarily_locked'],
  limit: [409, 'activation_limit_reached'],
  unbekannt: [404, 'not_found'],
  signatur: [401, 'invalid_signature'],
  erloschen: [409, 'withdrawal_expired'],
  rueckzahlung: [400, 'invalid_refund_address'],
  erstattet: [409, 'already_refunded'],
};

const API_STATUS = {
  [STATUS.OFFEN]: 'pending',
  [STATUS.UNTERZAHLT]: 'underpaid',
  [STATUS.UNBESTAETIGT]: 'unconfirmed',
  [STATUS.BEZAHLT]: 'paid',
  [STATUS.ABGELAUFEN]: 'expired',
  [STATUS.WIDERRUFEN]: 'withdrawn',
};

class HttpFehler extends Error {
  constructor(status, titel, text, apiCode = 'error') {
    super(titel);
    this.status = status;
    this.titel = titel;
    this.text = text;
    this.apiCode = apiCode;
  }
}

const STILL = { info() {}, warnung() {}, fehler() {} };

/**
 * @param {object} o
 * @param {object} o.konfig
 * @param {import('./bestellungen.js').Bestellverwaltung} o.verwaltung
 * @param {string} o.lizenzOeffentlich  oeffentlicher Lizenzschluessel (base64url) fuer /api/v1/info
 */
export function erstelleHandler({ konfig, verwaltung, lizenzOeffentlich = '', jetzt = Date.now, log = STILL, wartezeitPruefungMs = 8000 }) {
  const css = fs.readFileSync(new URL('../static/style.css', import.meta.url));
  const rechnungCss = fs.readFileSync(new URL('../static/rechnung.css', import.meta.url));
  const anfragen = new TokenEimer(100, 50 * 3600, jetzt); // global max. ~50 Anfragen/s
  // Je Tor-Kreis (PROXY-Kopf von tor, siehe proxyprotokoll.js): ein einzelner
  // Kreis kann nicht mehr alle Anfragen fuer sich beanspruchen (Audit S2).
  const anfragenJeKreis = new EimerJeSchluessel(40, 10 * 3600, jetzt);
  const kreisVon = (req) => req?.socket?.malachiKreis ?? null;
  const wege = verwaltung.wege;
  // Nur bereite Zahlungswege anbieten (server.js setzt weg.bereit; ohne Angabe gilt bereit).
  // Sind gerade alle gestoert, werden trotzdem alle gezeigt - die Bestellung meldet dann den Grund.
  const angebot = () => {
    const bereit = Object.fromEntries(Object.entries(wege).filter(([, w]) => w.bereit !== false));
    return Object.keys(bereit).length ? bereit : wege;
  };
  const standardWeg = (a) => (Object.hasOwn(a, konfig.zahlungswege.standard) ? konfig.zahlungswege.standard : Object.keys(a)[0]);

  // ------------------------------------------------------------ Antworten

  function senden(res, status, typ, inhalt, extra = {}) {
    const body = Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(inhalt, 'utf8');
    res.writeHead(status, { 'Content-Type': typ, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  }
  const html = (res, status, inhalt, extra) => senden(res, status, 'text/html; charset=utf-8', inhalt, extra);
  const json = (res, status, obj, extra) => senden(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);

  function umleiten(res, ziel) {
    res.writeHead(303, { Location: ziel, 'Content-Length': 0, 'Cache-Control': 'no-store' });
    res.end();
  }

  // ------------------------------------------------------------ Eingaben

  async function koerperLesen(req, erwarteterTyp) {
    const typ = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (typ !== erwarteterTyp) throw new HttpFehler(415, 'Ungültige Anfrage', 'Die Daten wurden in einem unerwarteten Format gesendet.', 'unsupported_media_type');
    if (Number(req.headers['content-length'] || 0) > MAX_KOERPER) throw new HttpFehler(413, 'Anfrage zu groß', 'Die Anfrage ist zu groß.', 'payload_too_large');
    return new Promise((resolve, reject) => {
      const teile = [];
      let groesse = 0;
      let abgebrochen = false;
      req.on('data', (stueck) => {
        if (abgebrochen) return;
        groesse += stueck.length;
        if (groesse > MAX_KOERPER) {
          abgebrochen = true;
          reject(new HttpFehler(413, 'Anfrage zu groß', 'Die Anfrage ist zu groß.', 'payload_too_large'));
          return;
        }
        teile.push(stueck);
      });
      req.on('end', () => !abgebrochen && resolve(Buffer.concat(teile)));
      req.on('error', reject);
    });
  }

  const formular = async (req) => new URLSearchParams((await koerperLesen(req, 'application/x-www-form-urlencoded')).toString('utf8'));

  async function jsonLesen(req) {
    const roh = await koerperLesen(req, 'application/json');
    let d;
    try {
      d = JSON.parse(roh.toString('utf8'));
    } catch {
      throw new HttpFehler(400, 'Ungültige Anfrage', 'Kein gültiges JSON.', 'invalid_json');
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HttpFehler(400, 'Ungültige Anfrage', 'JSON-Objekt erwartet.', 'invalid_json');
    return d;
  }

  const nichtGefunden = () =>
    new HttpFehler(404, 'Bestellung nicht gefunden', 'Diese Bestellung gibt es nicht (mehr). Bitte die Bestellnummer prüfen. Unbezahlte Bestellungen werden nach Ablauf gelöscht – bitte nicht an Adressen alter Bestellungen zahlen.', 'not_found');

  function bestellungOder404(id) {
    const b = verwaltung.holen(id);
    if (!b) throw nichtGefunden();
    return b;
  }

  async function frischeBestellung(id) {
    bestellungOder404(id);
    let pruefFehler = false;
    const pruefung = verwaltung.aktualisieren(id).catch((e) => {
      log.warnung('Zahlungspruefung fehlgeschlagen: ' + e.message);
      pruefFehler = true;
    });
    let zeitgeber;
    await Promise.race([pruefung, new Promise((r) => (zeitgeber = setTimeout(r, wartezeitPruefungMs)))]);
    clearTimeout(zeitgeber);
    return { b: bestellungOder404(id), pruefFehler };
  }

  // Bestellung eines inzwischen abgeschalteten Zahlungswegs: Stellen nach Waehrung.
  const wegVon = (b) => wege[b.zahlungsweg] || { name: b.zahlungsweg, ...waehrungsDaten(b, null), uri: (a) => a };
  const offenBetrag = (b) => offenerBetrag(b, konfig.toleranzProzent, wegVon(b));

  // ------------------------------------------------------------ Webseite

  async function bestellungAnlegen(req, res) {
    const f = await formular(req);
    const geraetecode = (f.get('geraetecode') || '').slice(0, 80);
    try {
      const { bestellung, wiederherstellungscode } = await verwaltung.erstellen({ kreis: kreisVon(req),
        geraetecode,
        zahlungsweg: f.get('zahlungsweg') || undefined,
        zustimmung: f.get('zustimmung') === 'ja',
      });
      html(res, 200, seiten.bestellungAngelegt({ konfig, bestellung, wiederherstellungscode }));
    } catch (e) {
      if (!(e instanceof ShopFehler)) throw e;
      const [status] = FEHLER[e.code] || [503];
      html(res, status, seiten.startseite({ konfig, wege: angebot(), fehler: e.message, geraetecode }), status >= 429 ? { 'Retry-After': '300' } : {});
    }
  }

  async function umzugAusfuehren(req, res) {
    const f = await formular(req);
    const nr = (f.get('nr') || '').slice(0, 60);
    const geraetecode = (f.get('geraetecode') || '').slice(0, 80);
    try {
      const ergebnis = await verwaltung.umziehen({ kreis: kreisVon(req), bestellnummer: nr, wiederherstellungscode: f.get('code') || '', geraetecode });
      html(res, 200, seiten.umzugseite({ konfig, ergebnis }));
    } catch (e) {
      if (!(e instanceof ShopFehler)) throw e;
      const [status] = FEHLER[e.code] || [400];
      html(res, status, seiten.umzugseite({ konfig, fehler: e.message, nr, geraetecode }));
    }
  }

  /**
   * "Vertrag widerrufen" (§ 356a BGB) ohne JavaScript: Formular -> Pruefseite
   * ("Widerruf bestaetigen") -> Eingangsbestaetigung (Seite + Datei). Jeder
   * Schritt prueft Bestellnummer und Wiederherstellungscode erneut.
   */
  async function widerrufAusfuehren(req, res) {
    const f = await formular(req);
    const schritt = f.get('schritt') || 'pruefen';
    const nr = (f.get('nr') || '').slice(0, 60);
    const code = (f.get('code') || '').slice(0, 40);
    const name = (f.get('name') || '').slice(0, 200);
    const adresse = (f.get('adresse') || '').slice(0, 200);
    try {
      if (schritt === 'beleg') {
        const { bestellung: b } = await verwaltung.widerrufen({ kreis: kreisVon(req), bestellnummer: nr, wiederherstellungscode: code, nurPruefen: true });
        if (b.status !== STATUS.WIDERRUFEN) throw nichtGefunden();
        return html(res, 200, seiten.widerrufBelegHtml({ konfig, bestellung: b, weg: wegVon(b), eigenstaendig: true }), {
          'Content-Disposition': `attachment; filename="widerruf-eingangsbestaetigung-${b.id}.html"`,
        });
      }
      if (schritt === 'bestaetigen') {
        const { bestellung: b, neu } = await verwaltung.widerrufen({ kreis: kreisVon(req), bestellnummer: nr, wiederherstellungscode: code, name, rueckzahlAdresse: adresse });
        return html(res, 200, seiten.widerrufBestaetigt({ konfig, bestellung: b, weg: wegVon(b), code, neu }));
      }
      const { bestellung: b } = await verwaltung.widerrufen({ kreis: kreisVon(req), bestellnummer: nr, wiederherstellungscode: code, name, rueckzahlAdresse: adresse, nurPruefen: true });
      return html(res, 200, seiten.widerrufPruefseite({ konfig, bestellung: b, weg: wegVon(b), code, name: name.trim(), adresse: adresse.trim() }));
    } catch (e) {
      if (!(e instanceof ShopFehler)) throw e;
      const [status] = FEHLER[e.code] || [400];
      html(res, status, seiten.widerrufFormular({ konfig, fehler: e.message, nr, name, adresse }), status >= 429 ? { 'Retry-After': '300' } : {});
    }
  }

  async function bestellungUnterseite(req, res, id, teil, url) {
    if (!teil) {
      const { b, pruefFehler } = await frischeBestellung(id);
      return html(res, 200, seiten.bestellseite({ konfig, bestellung: b, weg: wegVon(b), pruefFehler }));
    }
    const b = bestellungOder404(id);
    const weg = wegVon(b);
    if (teil === 'qr.svg' || teil === 'qr.png') {
      const offen = offenBetrag(b);
      if (offen <= 0) throw nichtGefunden();
      const uri = weg.uri(b.adresse, betragText(offen, weg));
      return teil === 'qr.svg' ? senden(res, 200, 'image/svg+xml', qrSvg(uri)) : senden(res, 200, 'image/png', qrPng(uri));
    }
    if (b.status !== STATUS.BEZAHLT) throw nichtGefunden();
    const lizenz = verwaltung.aktuelleLizenz(b).lizenz;
    if (teil === 'lizenz.txt') {
      return senden(res, 200, 'text/plain; charset=utf-8', lizenz + '\n', { 'Content-Disposition': `attachment; filename="malachi-lizenz-${b.id}.txt"` });
    }
    if (teil === 'lizenz-qr.svg') return senden(res, 200, 'image/svg+xml', qrSvg(lizenz));
    if (teil === 'lizenz-qr.png') return senden(res, 200, 'image/png', qrPng(lizenz, { skala: 5 }));
    if (teil === 'rechnung') {
      const speichern = url.searchParams.get('speichern') === '1';
      const inhalt = seiten.rechnungHtml({ konfig, bestellung: b, weg, eigenstaendig: speichern });
      return html(res, 200, inhalt, speichern ? { 'Content-Disposition': `attachment; filename="rechnung-${b.rechnungsnummer}.html"` } : {});
    }
    throw nichtGefunden();
  }

  // ------------------------------------------------------------ JSON-API

  function apiBestellung(b, mitZahlung = true) {
    const weg = wegVon(b);
    const o = {
      orderId: b.id,
      status: API_STATUS[b.status],
      paymentMethod: b.zahlungsweg,
      currency: b.waehrung,
      expiresAt: new Date(b.gueltigBis).toISOString(),
      minConfirmations: konfig.mindestBestaetigungen,
    };
    if (b.status === STATUS.WIDERRUFEN) {
      // Keine Zahlungsdaten mehr (es soll nichts mehr gezahlt werden) - nur der Stand.
      Object.assign(o, {
        withdrawnAt: new Date(b.widerruf.zeit).toISOString(),
        received: betragText(b.empfangen, weg),
        eurPrice: b.preisEur.toFixed(2),
      });
      return o;
    }
    if (mitZahlung) {
      const betrag = betragText(b.betrag, weg);
      Object.assign(o, {
        address: b.adresse,
        amount: betrag,
        amountAtomic: String(b.betrag),
        ...(b.waehrung === 'XMR' ? { amountXmr: betrag } : {}),
        paymentUri: weg.uri(b.adresse, betragText(offenBetrag(b) || b.betrag, weg)),
        eurPrice: b.preisEur.toFixed(2),
        eurRate: b.kurs ? b.kurs.eurProCoin.toFixed(2) : null,
        rateMethod: b.kurs ? b.kurs.methode : null,
        rateFetchedAt: b.kurs ? b.kurs.abgerufen : null,
        received: betragText(b.empfangen, weg),
        missing: betragText(offenBetrag(b), weg),
        confirmations: b.bestaetigungen,
      });
    }
    if (b.status === STATUS.BEZAHLT) {
      const akt = verwaltung.aktuelleLizenz(b);
      Object.assign(o, {
        license: akt.lizenz,
        licenseId: b.lizenzId,
        licensedDevice: akt.dev,
        invoiceNumber: b.rechnungsnummer,
        activations: b.lizenzen.length,
        maxActivations: konfig.lizenz.maxAktivierungen,
      });
    }
    return o;
  }

  async function api(req, res, p) {
    if (!konfig.api.aktiv) throw new HttpFehler(404, 'Nicht gefunden', 'API ist abgeschaltet.', 'not_found');
    if (p === '/api/v1/info' && req.method === 'GET') {
      const a = angebot();
      return json(res, 200, {
        product: konfig.texte.produkt,
        priceEur: konfig.preisEur.toFixed(2),
        paymentMethods: Object.entries(a).map(([id, w]) => ({ id, currency: w.waehrung, name: w.name })),
        defaultPaymentMethod: standardWeg(a),
        minConfirmations: konfig.mindestBestaetigungen,
        maxActivations: konfig.lizenz.maxAktivierungen,
        consentRequired: konfig.widerrufsZustimmungErforderlich,
        consentText:
          'Ich verlange ausdrücklich, dass mit der Bereitstellung des Lizenznachweises vor Ablauf der Widerrufsfrist begonnen wird. Mir ist bekannt, dass ich mit Beginn der Bereitstellung mein Widerrufsrecht verliere.',
        licenseFormat: 'ML1',
        licensePublicKeys: lizenzOeffentlich ? [lizenzOeffentlich] : [],
      });
    }
    if (p === '/api/v1/orders' && req.method === 'POST') {
      const d = await jsonLesen(req);
      const { bestellung, wiederherstellungscode } = await verwaltung.erstellen({ kreis: kreisVon(req),
        geraetecode: typeof d.deviceCode === 'string' ? d.deviceCode : '',
        zahlungsweg: typeof d.paymentMethod === 'string' ? d.paymentMethod : undefined,
        zustimmung: d.consent === true,
      });
      return json(res, 201, { ...apiBestellung(bestellung), recoveryCode: wiederherstellungscode });
    }
    let m = /^\/api\/v1\/orders\/([0-9A-Za-z-]{16,40})$/.exec(p);
    if (m && req.method === 'GET') {
      const id = normalisieren(m[1], BESTELLNUMMER_LAENGE);
      if (!id) throw nichtGefunden();
      const { b } = await frischeBestellung(id);
      return json(res, 200, apiBestellung(b));
    }
    m = /^\/api\/v1\/orders\/([0-9A-Za-z-]{16,40})\/withdraw$/.exec(p);
    if (m && req.method === 'POST') {
      // "Vertrag widerrufen" aus der App: confirm=false prueft nur (Vorschau),
      // confirm=true erklaert den Widerruf. Antwort mit Eingangsbestaetigung (Text).
      const d = await jsonLesen(req);
      const { bestellung: b, neu } = await verwaltung.widerrufen({ kreis: kreisVon(req),
        bestellnummer: m[1],
        wiederherstellungscode: typeof d.recoveryCode === 'string' ? d.recoveryCode : '',
        name: typeof d.name === 'string' ? d.name.slice(0, 200) : '',
        rueckzahlAdresse: typeof d.refundAddress === 'string' ? d.refundAddress.slice(0, 200) : '',
        nurPruefen: d.confirm !== true,
        quelle: 'app',
      });
      const o = apiBestellung(b);
      if (b.status === STATUS.WIDERRUFEN) {
        Object.assign(o, {
          newWithdrawal: neu,
          refundAddress: b.widerruf.rueckzahlAdresse,
          receipt: seiten.widerrufBelegText({ konfig, bestellung: b, weg: wegVon(b) }),
        });
      }
      return json(res, 200, o);
    }
    if (p === '/api/v1/transfer' && req.method === 'POST') {
      const d = await jsonLesen(req);
      const e = await verwaltung.umziehen({ kreis: kreisVon(req),
        bestellnummer: typeof d.orderId === 'string' ? d.orderId : '',
        wiederherstellungscode: typeof d.recoveryCode === 'string' ? d.recoveryCode : '',
        geraetecode: typeof d.deviceCode === 'string' ? d.deviceCode : '',
      });
      return json(res, 200, { orderId: e.bestellung.id, license: e.lizenz, licenseId: e.bestellung.lizenzId, activations: e.aktivierungen, maxActivations: konfig.lizenz.maxAktivierungen, newActivation: e.neu });
    }
    m = /^\/api\/v1\/zahlungsdienst\/([a-z0-9-]{1,40})\/benachrichtigung$/.exec(p);
    if (m && req.method === 'POST') {
      const roh = await koerperLesen(req, 'application/json');
      await verwaltung.benachrichtigung(m[1], req.headers, roh);
      return json(res, 200, { ok: true });
    }
    throw new HttpFehler(404, 'Nicht gefunden', 'Unbekannter API-Pfad.', 'not_found');
  }

  // ------------------------------------------------------------ Verteiler

  async function verteilen(req, res) {
    if (req.url.length > MAX_URL) throw new HttpFehler(414, 'Adresse zu lang', 'Die aufgerufene Adresse ist zu lang.', 'uri_too_long');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD, POST');
      throw new HttpFehler(405, 'Nicht erlaubt', 'Diese Anfrageart wird nicht unterstützt.', 'method_not_allowed');
    }
    if (!anfragenJeKreis.versuchen(kreisVon(req)) || !anfragen.versuchen()) throw new HttpFehler(503, 'Gerade überlastet', 'Bitte in einem Moment erneut versuchen.', 'busy');

    let url;
    try {
      url = new URL(req.url, 'http://shop.invalid');
    } catch {
      throw new HttpFehler(400, 'Ungültige Anfrage', 'Die Adresse ist ungültig.', 'bad_request');
    }
    const p = url.pathname;
    if (p.startsWith('/api/')) return api(req, res, p);

    if (req.method === 'POST') {
      if (p === '/bestellung') return bestellungAnlegen(req, res);
      if (p === '/umzug') return umzugAusfuehren(req, res);
      if (p === '/widerrufen') return widerrufAusfuehren(req, res);
      res.setHeader('Allow', 'GET, HEAD');
      throw new HttpFehler(405, 'Nicht erlaubt', 'Diese Anfrageart wird hier nicht unterstützt.', 'method_not_allowed');
    }

    if (p === '/') return html(res, 200, seiten.startseite({ konfig, wege: angebot() }));
    if (p === '/static/style.css') return senden(res, 200, 'text/css; charset=utf-8', css, { 'Cache-Control': 'public, max-age=3600' });
    if (p === '/static/rechnung.css') return senden(res, 200, 'text/css; charset=utf-8', rechnungCss, { 'Cache-Control': 'public, max-age=3600' });
    if (p === '/robots.txt') return senden(res, 200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');
    if (p === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return res.end();
    }
    if (p === '/impressum') return html(res, 200, seiten.impressumseite({ konfig }));
    if (p === '/datenschutz') return html(res, 200, seiten.datenschutzseite({ konfig }));
    if (p === '/widerruf') return html(res, 200, seiten.widerrufseite({ konfig }));
    if (p === '/widerrufen') {
      const nr = normalisieren(url.searchParams.get('nr') || '', BESTELLNUMMER_LAENGE) || '';
      return html(res, 200, seiten.widerrufFormular({ konfig, nr }));
    }
    if (p === '/umzug') {
      const nr = normalisieren(url.searchParams.get('nr') || '', BESTELLNUMMER_LAENGE) || '';
      return html(res, 200, seiten.umzugseite({ konfig, nr }));
    }
    if (p === '/bestellung') {
      const nr = url.searchParams.get('nr');
      if (nr === null) return html(res, 200, seiten.abrufseite({ konfig }));
      const id = normalisieren(nr, BESTELLNUMMER_LAENGE);
      if (!id) return html(res, 400, seiten.abrufseite({ konfig, fehler: 'Die Bestellnummer hat 16 Zeichen (z. B. ABCD-EFGH-JKMN-PQRS).' }));
      return umleiten(res, `/bestellung/${id}`);
    }

    const m = /^\/bestellung\/([0-9A-Za-z-]{16,40})(?:\/(qr\.svg|qr\.png|lizenz\.txt|lizenz-qr\.svg|lizenz-qr\.png|rechnung))?$/.exec(p);
    if (m) {
      const id = normalisieren(m[1], BESTELLNUMMER_LAENGE);
      if (!id) throw nichtGefunden();
      if (id !== m[1]) return umleiten(res, `/bestellung/${id}${m[2] ? '/' + m[2] : ''}`);
      return bestellungUnterseite(req, res, id, m[2], url);
    }
    throw new HttpFehler(404, 'Seite nicht gefunden', 'Diese Seite gibt es nicht.', 'not_found');
  }

  return function handler(req, res) {
    res.sendDate = false; // keine Serverzeit preisgeben
    for (const [k, v] of Object.entries(SICHERHEITS_HEADER)) res.setHeader(k, v);
    const istApi = req.url.startsWith('/api/');
    verteilen(req, res).catch((e) => {
      let status;
      let titel;
      let text;
      let code;
      if (e instanceof HttpFehler) {
        ({ status, titel, text, apiCode: code } = e);
      } else if (e instanceof ShopFehler) {
        [status, code] = FEHLER[e.code] || [400, 'error'];
        titel = 'Nicht möglich';
        text = e.message;
      } else {
        // Keine Details (Stacktraces) nach aussen; im Log nur die Meldung.
        log.fehler('Interner Fehler: ' + (e && e.message ? e.message : String(e)));
        [status, titel, text, code] = [500, 'Interner Fehler', 'Etwas ist schiefgelaufen. Bitte später erneut versuchen.', 'internal_error'];
      }
      if (res.headersSent) return res.destroy();
      const extra = { Connection: 'close', ...(status === 429 || status === 503 ? { 'Retry-After': '300' } : {}) };
      if (istApi) json(res, status, { error: { code, message: text } }, extra);
      else html(res, status, seiten.fehlerseite({ konfig, titel, text }), extra);
    });
  };
}

/**
 * Lauscht mit PROXY-Protokoll (Kreis-Kennung von tor) auf host:port und gibt
 * die Verbindungen an den HTTP-Server weiter. Rueckgabe: der Netzserver.
 */
export function lauschen(httpServer, port, host, fertig) {
  const netz = proxyProtokollServer(httpServer);
  netz.listen(port, host, fertig);
  return netz;
}

/** HTTP-Server mit Zeit- und Groessenlimits. */
export function erstelleServer(handler) {
  const server = http.createServer({ maxHeaderSize: 8192 }, handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(120_000, (socket) => socket.destroy());
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  return server;
}
