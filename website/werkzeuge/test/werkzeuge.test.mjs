// Tests fuer die Website-Werkzeuge: node --test website/werkzeuge/test/werkzeuge.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as k from '../lib/krypto.mjs';
import * as m from '../lib/manifest.mjs';
import * as s from '../lib/seite.mjs';
import * as a from '../lib/android.mjs';
import { konfigPruefen } from '../lib/konfig.mjs';
import { veroeffentlichen, optionenLesen, WEBSITE, REPO } from '../veroeffentlichen.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const VEKTOR = JSON.parse(fs.readFileSync(path.join(HIER, 'update-testvektor.json'), 'utf8'));
const SCHNELL = { N: 2 ** 14, r: 8, p: 1 }; // nur fuer Tests - echte Dateien nutzen 2^17
const PASS = 'richtig-langes-test-passwort';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'malachi-web-test-'));
}

async function nobleLaden() {
  // Erst die Version der App (Repo-Wurzel), sonst die des Shops.
  for (const p of [path.join(REPO, 'node_modules', '@noble', 'curves', 'ed25519.js'), path.join(REPO, 'shop', 'node_modules', '@noble', 'curves', 'ed25519.js')]) {
    if (fs.existsSync(p)) return (await import(pathToFileURL(p).href)).ed25519;
  }
  return null;
}

describe('Krypto', () => {
  test('Schluesseldatei: erzeugen, oeffnen, signieren, pruefen', () => {
    const { text, oeffentlichRoh } = k.schluesseldateiErzeugen(PASS, { scrypt: SCHNELL });
    const d = JSON.parse(text);
    assert.equal(d.format, 'malachi-update-signierschluessel');
    assert.ok(!text.includes(PASS));
    const { privat, oeffentlichRoh: pub } = k.schluesseldateiOeffnen(text, PASS);
    assert.deepEqual(pub, oeffentlichRoh);
    const sig = k.signieren(privat, Buffer.from('hallo'));
    assert.equal(sig.length, 64);
    assert.ok(k.pruefen(pub, Buffer.from('hallo'), sig));
    assert.ok(!k.pruefen(pub, Buffer.from('hallO'), sig));
  });

  test('falsche Passphrase und vertauschter oeffentlicher Schluessel werden erkannt', () => {
    const { text } = k.schluesseldateiErzeugen(PASS, { scrypt: SCHNELL });
    assert.throws(() => k.schluesseldateiOeffnen(text, PASS + 'x'), /Falsche Passphrase/);
    const d = JSON.parse(text);
    d.oeffentlich = VEKTOR.oeffentlich; // AAD bindet den oeffentlichen Schluessel
    assert.throws(() => k.schluesseldateiOeffnen(JSON.stringify(d), PASS), /Falsche Passphrase/);
  });

  test('zu kurze Passphrase und schwache scrypt-Parameter werden abgelehnt', () => {
    assert.throws(() => k.schluesseldateiErzeugen('kurz'), /mindestens/);
    const { text } = k.schluesseldateiErzeugen(PASS, { scrypt: SCHNELL });
    const d = JSON.parse(text);
    d.kdf.N = 1024;
    assert.throws(() => k.schluesseldateiLesen(JSON.stringify(d)), /scrypt/);
  });

  test('Signaturdatei: genau Base64 von 64 Byte + LF, streng gelesen', () => {
    const sig = crypto.randomBytes(64);
    const t = k.signaturDateiText(sig);
    assert.match(t, /^[A-Za-z0-9+/]{86}==\n$/);
    assert.deepEqual(k.signaturDateiLesen(t), sig);
    assert.deepEqual(k.signaturDateiLesen(t.trimEnd()), sig);
    assert.throws(() => k.signaturDateiLesen(t.replace(/\n$/, '\n\n')));
    assert.throws(() => k.signaturDateiLesen(sig.toString('base64url')));
  });

  test('Base64url wird streng (kanonisch) gelesen', () => {
    assert.equal(k.base64urlDekodieren(VEKTOR.oeffentlich, 32).toString('hex'), VEKTOR.oeffentlichHex);
    assert.throws(() => k.base64urlDekodieren(VEKTOR.oeffentlich + '=', 32));
    assert.throws(() => k.base64urlDekodieren(VEKTOR.oeffentlich.slice(0, -1), 32));
  });
});

describe('Testvektor (UPDATE_FORMAT.md)', () => {
  const bytes = Buffer.from(VEKTOR.manifest, 'utf8');
  const sig = k.signaturDateiLesen(VEKTOR.signaturDatei);
  const pub = k.base64urlDekodieren(VEKTOR.oeffentlich, 32);

  test('Seed ergibt Schluessel und (deterministische) Signatur', () => {
    const privat = k.privatAusSeed(Buffer.from(VEKTOR.seedHex, 'hex'));
    assert.deepEqual(k.oeffentlichRohAusPrivat(privat), pub);
    assert.deepEqual(k.signieren(privat, bytes), sig);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), VEKTOR.manifestSha256);
    assert.equal(bytes.length, VEKTOR.manifestBytes);
  });

  test('Manifest-Bytes werden exakt so erzeugt und gelesen', () => {
    const gelesen = m.manifestLesen(bytes);
    assert.deepEqual(m.manifestBytes(gelesen), bytes);
  });

  test('jede Aenderung eines Bytes macht die Signatur ungueltig', () => {
    assert.ok(k.pruefen(pub, bytes, sig));
    for (const i of [0, 100, bytes.length - 1]) {
      const b = Buffer.from(bytes);
      b[i] ^= 0x01;
      assert.ok(!k.pruefen(pub, b, sig), `Byte ${i}`);
    }
    // CRLF statt LF (z. B. durch Git unter Windows) muss scheitern
    assert.ok(!k.pruefen(pub, Buffer.from(VEKTOR.manifest.replace(/\n/g, '\r\n')), sig));
  });

  test('@noble/curves (wie in der App) akzeptiert die Signatur, auch streng (zip215: false)', async (t) => {
    const ed = await nobleLaden();
    if (!ed) return t.skip('@noble/curves nicht installiert');
    assert.ok(ed.verify(new Uint8Array(sig), new Uint8Array(bytes), new Uint8Array(pub), { zip215: false }));
    const falsch = Buffer.from(bytes);
    falsch[10] ^= 1;
    assert.ok(!ed.verify(new Uint8Array(sig), new Uint8Array(falsch), new Uint8Array(pub), { zip215: false }));
    assert.deepEqual(Buffer.from(ed.getPublicKey(Buffer.from(VEKTOR.seedHex, 'hex'))), pub);
  });

  test('UPDATE_FORMAT.md enthaelt genau diesen Testvektor', () => {
    const doku = fs.readFileSync(path.join(WEBSITE, 'UPDATE_FORMAT.md'), 'utf8');
    assert.ok(doku.includes(VEKTOR.seedHex), 'Seed');
    assert.ok(doku.includes(VEKTOR.oeffentlich), 'oeffentlicher Schluessel');
    assert.ok(doku.includes(VEKTOR.signaturDatei.trim()), 'Signatur');
    assert.ok(doku.includes(VEKTOR.manifestSha256), 'SHA-256 des Manifests');
    assert.ok(doku.replace(/\r\n/g, '\n').includes(VEKTOR.manifest.trimEnd()), 'Manifest-Text');
  });
});

describe('Manifest-Regeln', () => {
  const basis = () => m.manifestLesen(Buffer.from(VEKTOR.manifest, 'utf8'));
  const falsch = (aendern, muster) => {
    const x = basis();
    aendern(x);
    assert.throws(() => m.manifestPruefen(x), muster);
  };
  test('unbekannte Felder, Pfade, Hash-Format, Versionen', () => {
    falsch((x) => { x.extra = 1; }, /Unbekanntes Feld/);
    falsch((x) => { x.apks[0].file = '../evil.apk'; }, /Dateiname/);
    falsch((x) => { x.apks[0].file = 'sub/a.apk'; }, /Dateiname/);
    falsch((x) => { x.apks[0].sha256 = x.apks[0].sha256.toUpperCase(); }, /sha256/);
    falsch((x) => { x.minSupportedVersionCode = x.versionCode + 1; }, /minSupportedVersionCode/);
    falsch((x) => { x.versionCode = 1.5; }, /versionCode/);
    falsch((x) => { x.apks.push({ ...x.apks[0] }); }, /doppelt/);
    falsch((x) => { x.format = 'anderes'; }, /format/);
    falsch((x) => { x.published = '2026-10-19 12:00:00'; }, /published/);
    falsch((x) => { x.releaseNotes = 'a\tb'; }, /releaseNotes/);
  });
  test('BOM und kaputtes UTF-8 werden abgelehnt', () => {
    assert.throws(() => m.manifestLesen(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VEKTOR.manifest)])), /BOM/);
    assert.throws(() => m.manifestLesen(Buffer.from([0x7b, 0xff, 0x7d])));
  });
});

describe('Seite', () => {
  test('Marken werden maskiert, unbekannte Marken sind ein Fehler', () => {
    const k1 = { seite: 'x', basis: '', teile: {}, werte: { A: '<b>&"' , B_HTML: { html: '<i>ok</i>' } } };
    assert.equal(s.vorlageAnwenden('{{A}}|{{B_HTML}}', k1), '&lt;b&gt;&amp;&quot;|<i>ok</i>');
    assert.throws(() => s.vorlageAnwenden('{{C}}', k1), /Unbekannte Marke/);
    assert.throws(() => s.vorlageAnwenden('{{TEIL:fehlt}}', k1), /Unbekannter Teil/);
    assert.equal(s.vorlageAnwenden('<a{{AKTUELL:x}}><a{{AKTUELL:y}}>', k1), '<a aria-current="page"><a>');
  });

  test('Seitenpruefung verbietet Skripte, Inline-Styles und fremde Ressourcen', () => {
    const gut = '<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n</head><body><a href="https://example.org/">ok</a></body></html>';
    s.seitePruefen('gut', gut);
    for (const boese of ['<script>x</script>', '<p style="color:red">', '<img src="https://x.org/a.png">', '<link rel="stylesheet" href="//cdn.example/x.css">', '<a onclick="x()">', '<iframe src="a">']) {
      assert.throws(() => s.seitePruefen('boese', gut.replace('<body>', `<body>${boese}`)), undefined, boese);
    }
  });

  test('Versionshinweise werden zu Absatz + Liste, Text wird maskiert', () => {
    assert.equal(s.hinweiseHtml('Neu:\n\n- a <b>\n- c'), '<p>Neu:</p>\n  <ul>\n    <li>a &lt;b&gt;</li>\n    <li>c</li>\n  </ul>');
  });

  test('Groessen und Datum auf Deutsch', () => {
    assert.equal(s.groesseText(41234567), '41,2 MB');
    assert.equal(s.datumText(new Date('2026-03-05T12:00:00Z')), '5. März 2026');
  });
});

describe('Android-Ausgaben', () => {
  test('apksigner: Fingerabdruck, Debug-Zertifikat, mehrere Signierer', () => {
    const aus = 'Signer #1 certificate DN: CN=Malachi, O=Malachi\nSigner #1 certificate SHA-256 digest: ' + 'ab'.repeat(32) + '\nSigner #1 certificate SHA-1 digest: 00\n';
    assert.deepEqual(a.apksignerAuswerten(aus), { sha256: 'ab'.repeat(32), dn: 'CN=Malachi, O=Malachi' });
    assert.ok(a.istDebugZertifikat('C=US, O=Android, CN=Android Debug'));
    assert.throws(() => a.apksignerAuswerten(aus + aus.replace(/#1/g, '#2')), /mehr als ein/);
    assert.equal(a.mitDoppelpunkten('ab01'), 'AB:01');
  });
  test('aapt2 badging', () => {
    const b = a.badgingAuswerten("package: name='com.securecommapp' versionCode='12' versionName='1.2.0' platformBuildVersionName='16'\nminSdkVersion:'24'\n");
    assert.deepEqual(b, { applicationId: 'com.securecommapp', versionCode: 12, versionName: '1.2.0', minSdk: 24 });
  });
  test('Version aus build.gradle', () => {
    const v = a.gradleVersionLesen(path.join(REPO, 'android', 'app', 'build.gradle'));
    assert.ok(Number.isSafeInteger(v.versionCode) && v.versionName.length > 0);
  });
});

describe('Konfiguration', () => {
  test('seite.json im Repo ist gueltig, Tippfehler werden erkannt', () => {
    konfigPruefen(JSON.parse(fs.readFileSync(path.join(WEBSITE, 'seite.json'), 'utf8')));
    assert.throws(() => konfigPruefen({ onionAdrese: '' }), /unbekannter Schluessel/);
    assert.throws(() => konfigPruefen({ onionAdresse: 'abc.onion' }), /v3-Onion/);
    assert.throws(() => konfigPruefen({ updateSchluessel: 'abc' }), /Base64url/);
    const e = konfigPruefen({ apkZertifikatSha256: 'AB:'.repeat(31) + 'AB', onionAdresse: `http://${'a'.repeat(56)}.onion/` });
    assert.equal(e.apkZertifikatSha256, 'ab'.repeat(32));
    assert.equal(e.onionAdresse, `${'a'.repeat(56)}.onion`);
  });
  test('Optionen', () => {
    assert.throws(() => optionenLesen(['--entwurf', '--hochladen']), /schliessen sich aus/);
    assert.throws(() => optionenLesen(['--zeit', 'gestern']), /--zeit/);
    assert.throws(() => optionenLesen(['--gibtsnicht']), /Unbekannte Option/);
  });
});

describe('Bauen', () => {
  const still = { log: () => {}, warn: () => {} };

  test('Entwurf ohne APK: baut alle Seiten mit Platzhaltern', async () => {
    const ziel = path.join(tmp(), 'seite');
    const r = await veroeffentlichen({ entwurf: true, apk: [], apkOrdner: tmp(), ziel }, still);
    for (const seite of ['index.html', 'download.html', 'vollversion.html', 'faq.html', 'impressum.html', 'datenschutz.html', 'widerruf.html', '404.html', 'assets/style.css', 'assets/logo.svg']) {
      assert.ok(fs.existsSync(path.join(ziel, seite)), seite);
    }
    assert.ok(!fs.existsSync(path.join(ziel, '_teile')));
    // Platzhalter-Liste = genau die Seiten, die noch [BITTE AUSFUELLEN ...] enthalten
    for (const seite of r.platzhalter) assert.ok(fs.readFileSync(path.join(ziel, seite), 'utf8').includes('BITTE AUSFUELLEN'), seite);
    const html = fs.readFileSync(path.join(ziel, 'download.html'), 'utf8');
    assert.ok(!html.includes('{{'));
    assert.match(fs.readFileSync(path.join(ziel, '404.html'), 'utf8'), /href="\/assets\/style\.css"/);
    assert.match(fs.readFileSync(path.join(ziel, 'faq.html'), 'utf8'), /<a href="faq\.html" aria-current="page">/);
  });

  test('Englische Seiten: gleiche Dateinamen unter /en/, Sprachumschalter in beide Richtungen', async () => {
    const ziel = path.join(tmp(), 'seite');
    await veroeffentlichen({ entwurf: true, apk: [], apkOrdner: tmp(), ziel }, still);
    for (const seite of ['index', 'download', 'vollversion', 'faq', 'impressum', 'datenschutz', 'widerruf', 'kaufbedingungen', '404']) {
      const de = fs.readFileSync(path.join(ziel, `${seite}.html`), 'utf8');
      const en = fs.readFileSync(path.join(ziel, 'en', `${seite}.html`), 'utf8');
      assert.match(en, /<html lang="en">/, seite);
      const basis = seite === '404' ? '/' : '';
      assert.ok(de.includes(`href="${basis}en/${seite}.html" hreflang="en"`), `${seite}: DE -> EN`);
      assert.ok(en.includes(`href="${seite === '404' ? '/' : '../'}${seite}.html" hreflang="de"`), `${seite}: EN -> DE`);
      assert.ok(!en.includes('{{'), seite);
    }
    const dl = fs.readFileSync(path.join(ziel, 'en', 'download.html'), 'utf8');
    assert.match(dl, /href="\.\.\/assets\/style\.css"/);
    assert.match(dl, /<a href="\.\.\/en\/download\.html" aria-current="page">Download<\/a>/);
    assert.match(fs.readFileSync(path.join(ziel, 'en', '404.html'), 'utf8'), /href="\/en\/index\.html"/);
  });

  test('Release: signiertes Manifest, Pruefsummen, Seite mit echten Werten', async () => {
    const arbeit = tmp();
    const apkOrdner = path.join(arbeit, 'apk');
    fs.mkdirSync(apkOrdner);
    // Name aus `gradlew assembleWebRelease` (app-web-…) und alter Name ohne Flavor - beide werden erkannt.
    fs.writeFileSync(path.join(apkOrdner, 'app-web-arm64-v8a-release.apk'), crypto.randomBytes(2048));
    fs.writeFileSync(path.join(apkOrdner, 'app-armeabi-v7a-release.apk'), crypto.randomBytes(2048));
    const { text, oeffentlichRoh } = k.schluesseldateiErzeugen(PASS, { scrypt: SCHNELL });
    const schluessel = path.join(arbeit, 'schluessel.json');
    fs.writeFileSync(schluessel, text);
    const konfig = path.join(arbeit, 'seite.json');
    fs.writeFileSync(konfig, JSON.stringify({
      onionAdresse: `${'b'.repeat(56)}.onion`,
      shopOnion: `${'c'.repeat(56)}.onion`,
      apkZertifikatSha256: 'cd'.repeat(32),
      updateSchluessel: k.base64urlKodieren(oeffentlichRoh),
      minSupportedVersionCode: 3,
      abis: ['arm64-v8a', 'armeabi-v7a'],
    }));
    const hinweise = path.join(arbeit, 'hinweise.txt');
    fs.writeFileSync(hinweise, 'Erste Version.\r\n\r\n- Punkt <eins>\r\n');
    const ziel = path.join(arbeit, 'seite');
    const optionen = {
      apk: [], apkOrdner, konfig, hinweise, schluessel, ziel, version: '1.4.0', versionCode: 14,
      zeit: '2026-10-19T10:00:00Z', ohneApksigner: true, ohneAapt2: true,
    };
    process.env.MALACHI_UPDATE_PASSPHRASE = PASS;
    try {
      // Enthalten die Rechtstexte noch [BITTE AUSFUELLEN ...], bricht der Release ohne Erlaubnis ab.
      const quelle = new URL('../../site/', import.meta.url);
      const offen = fs.readdirSync(quelle).filter((d) => d.endsWith('.html') && fs.readFileSync(new URL(d, quelle), 'utf8').includes('BITTE AUSFUELLEN'));
      if (offen.length) await assert.rejects(veroeffentlichen(optionen, still), (e) => String(e).includes(offen[0]));
      const r = await veroeffentlichen({ ...optionen, platzhalterErlauben: true }, still);
      assert.equal(r.eintraege.length, 2);
    } finally {
      delete process.env.MALACHI_UPDATE_PASSPHRASE;
    }
    const upd = path.join(ziel, 'updates');
    const bytes = fs.readFileSync(path.join(upd, 'manifest.json'));
    const sig = k.signaturDateiLesen(fs.readFileSync(path.join(upd, 'manifest.json.sig'), 'utf8'));
    assert.ok(k.pruefen(oeffentlichRoh, bytes, sig));
    const man = m.manifestLesen(bytes);
    assert.equal(man.versionCode, 14);
    assert.equal(man.minSupportedVersionCode, 3);
    assert.equal(man.releaseNotes, 'Erste Version.\n\n- Punkt <eins>');
    assert.equal(man.published, '2026-10-19T10:00:00Z');
    for (const e of man.apks) {
      const datei = path.join(upd, e.file);
      assert.equal(fs.statSync(datei).size, e.size);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(datei)).digest('hex'), e.sha256);
    }
    const summen = fs.readFileSync(path.join(upd, 'SHA256SUMS'), 'utf8');
    assert.match(summen, new RegExp(`^${man.apks[0].sha256}  malachi-1\\.4\\.0-arm64-v8a\\.apk$`, 'm'));
    assert.match(fs.readFileSync(path.join(upd, 'update-schluessel.pem'), 'utf8'), /^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/);
    const html = fs.readFileSync(path.join(ziel, 'download.html'), 'utf8');
    assert.ok(html.includes(man.apks[0].sha256));
    assert.ok(html.includes('href="updates/malachi-1.4.0-arm64-v8a.apk"'));
    assert.ok(html.includes('CD:CD:CD'));
    assert.ok(html.includes('<li>Punkt &lt;eins&gt;</li>'));
    assert.ok(html.includes('19. Oktober 2026'));
    assert.ok(fs.readFileSync(path.join(ziel, 'vollversion.html'), 'utf8').includes(`http://${'c'.repeat(56)}.onion/`));
    assert.ok(fs.readFileSync(path.join(ziel, 'index.html'), 'utf8').includes(`${'b'.repeat(56)}.onion`));
  });

  test('falscher Schluessel oder fehlende APK fuehren zum Abbruch', async () => {
    const arbeit = tmp();
    const apkOrdner = path.join(arbeit, 'apk');
    fs.mkdirSync(apkOrdner);
    fs.writeFileSync(path.join(apkOrdner, 'app-arm64-v8a-release.apk'), crypto.randomBytes(100));
    const fremd = k.schluesseldateiErzeugen(PASS, { scrypt: SCHNELL });
    const schluessel = path.join(arbeit, 'schluessel.json');
    fs.writeFileSync(schluessel, fremd.text);
    const konfig = path.join(arbeit, 'seite.json');
    const basis = {
      onionAdresse: `${'b'.repeat(56)}.onion`, apkZertifikatSha256: 'cd'.repeat(32),
      updateSchluessel: VEKTOR.oeffentlich, abis: ['arm64-v8a'],
    };
    fs.writeFileSync(konfig, JSON.stringify(basis));
    const hinweise = path.join(arbeit, 'h.txt');
    fs.writeFileSync(hinweise, 'x');
    const o = { apk: [], apkOrdner, konfig, hinweise, schluessel, ziel: path.join(arbeit, 'seite'), version: '1.0', versionCode: 1, ohneApksigner: true, ohneAapt2: true, platzhalterErlauben: true };
    process.env.MALACHI_UPDATE_PASSPHRASE = PASS;
    try {
      await assert.rejects(veroeffentlichen(o, still), /passt nicht zu seite\.json/);
      fs.writeFileSync(konfig, JSON.stringify({ ...basis, abis: ['arm64-v8a', 'x86_64'] }));
      await assert.rejects(veroeffentlichen(o, still), /APK fehlt fuer: x86_64/);
    } finally {
      delete process.env.MALACHI_UPDATE_PASSPHRASE;
    }
  });

  test('Ausgabeordner darf nie das Repo oder die Quellen sein', async () => {
    await assert.rejects(veroeffentlichen({ entwurf: true, apk: [], ziel: path.join(WEBSITE, 'site') }, still), /wuerde/);
    await assert.rejects(veroeffentlichen({ entwurf: true, apk: [], ziel: REPO }, still), /wuerde/);
  });
});
