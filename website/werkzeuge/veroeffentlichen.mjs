#!/usr/bin/env node
// Malachi-Website bauen, Update-Manifest signieren und (optional) auf den
// Laptop hochladen. Laeuft auf dem eigenen PC (Windows/Linux/macOS, Node >= 18).
//
//   node website/werkzeuge/veroeffentlichen.mjs --entwurf          Vorschau ohne APK/Signatur
//   node website/werkzeuge/veroeffentlichen.mjs                    Release bauen und signieren
//   node website/werkzeuge/veroeffentlichen.mjs --hochladen        ... und hochladen + aktivieren
//
// Unter Windows bequemer: website\werkzeuge\veroeffentlichen.ps1 (ruft dieses Skript auf).
// Alle Optionen: --hilfe. Ablauf und Hintergrund: website/ANLEITUNG.md.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { konfigLaden } from './lib/konfig.mjs';
import {
  passphraseLesen, schluesseldateiOeffnen, signieren, pruefen, signaturDateiText, signaturDateiLesen,
  base64urlKodieren, base64urlDekodieren, oeffentlichPem,
} from './lib/krypto.mjs';
import { manifestBytes, manifestLesen } from './lib/manifest.mjs';
import {
  seiteBauen, platzhalterHtml, groesseText, groesseTextEn, datumText, datumTextEn, hinweiseHtml, htmlMaskieren,
} from './lib/seite.mjs';
import {
  werkzeugFinden, starten, apksignerAuswerten, istDebugZertifikat, badgingAuswerten, gradleVersionLesen, mitDoppelpunkten,
} from './lib/android.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
export const WEBSITE = path.resolve(HIER, '..');
export const REPO = path.resolve(WEBSITE, '..');

export class NutzungsFehler extends Error {}
export class AbbruchFehler extends Error {}

const HILFE = `Malachi-Website bauen, Update-Manifest signieren, hochladen.

Aufruf: node website/werkzeuge/veroeffentlichen.mjs [Optionen]

  --entwurf               Vorschau: fehlende Angaben werden als Platzhalter angezeigt,
                          keine Signatur noetig, kein Hochladen.
  --apk-ordner <ordner>   Ordner mit app-web-<abi>-release.apk (oder app-<abi>-release.apk)
                          (Standard: android/app/build/outputs/apk/web/release,
                          gebaut mit ./gradlew assembleWebRelease - NIE die Play-Variante)
  --apk <abi>=<datei>     einzelne APK angeben (mehrfach moeglich, ersetzt --apk-ordner)
  --version <name>        versionName (Standard: aus der APK per aapt2, sonst build.gradle)
  --version-code <zahl>   versionCode (dito)
  --min-version-code <z>  aelteste unterstuetzte Version (Standard: seite.json)
  --hinweise <datei>      Versionshinweise (Standard: website/versionshinweise/<version>.txt)
  --schluessel <datei>    privater Update-Signierschluessel
                          (Standard: ~/.malachi/update-signierschluessel.json)
  --konfig <datei>        Standard: website/seite.json
  --ziel <ordner>         Standard: website/build/seite (wird geleert!)
  --zeit <JJJJ-MM-TTThh:mm:ssZ>  Veroeffentlichungszeit (Standard: jetzt)
  --apksigner <pfad>      apksigner(.bat), falls nicht automatisch gefunden
  --aapt2 <pfad>          aapt2(.exe), falls nicht automatisch gefunden
  --ohne-apksigner        Zertifikat NICHT pruefen (nicht empfohlen)
  --ohne-aapt2            Version nicht aus der APK lesen (dann --version/--version-code)
  --platzhalter-erlauben  trotz [BITTE AUSFUELLEN ...] bauen/hochladen (nur zum Testen!)
  --hochladen             nach dem Bauen per scp hochladen und per ssh aktivieren
  --ssh-ziel <nutzer@rechner>   Standard: seite.json hochladen.ziel
  --ssh-schluessel <datei>      Standard: seite.json hochladen.sshSchluessel
  --hilfe                 diese Hilfe

Passphrase: wird verdeckt abgefragt (oder MALACHI_UPDATE_PASSPHRASE, weniger sicher).`;

export function optionenLesen(argv) {
  const o = { apk: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const wert = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new NutzungsFehler(`${a} braucht einen Wert.`);
      return v;
    };
    switch (a) {
      case '--entwurf': o.entwurf = true; break;
      case '--apk-ordner': o.apkOrdner = wert(); break;
      case '--apk': o.apk.push(wert()); break;
      case '--version': o.version = wert(); break;
      case '--version-code': o.versionCode = Number(wert()); break;
      case '--min-version-code': o.minVersionCode = Number(wert()); break;
      case '--hinweise': o.hinweise = wert(); break;
      case '--schluessel': o.schluessel = wert(); break;
      case '--konfig': o.konfig = wert(); break;
      case '--ziel': o.ziel = wert(); break;
      case '--zeit': o.zeit = wert(); break;
      case '--apksigner': o.apksigner = wert(); break;
      case '--aapt2': o.aapt2 = wert(); break;
      case '--ohne-apksigner': o.ohneApksigner = true; break;
      case '--ohne-aapt2': o.ohneAapt2 = true; break;
      case '--platzhalter-erlauben': o.platzhalterErlauben = true; break;
      case '--hochladen': o.hochladen = true; break;
      case '--ssh-ziel': o.sshZiel = wert(); break;
      case '--ssh-schluessel': o.sshSchluessel = wert(); break;
      case '--hilfe': case '-h': case '--help': o.hilfe = true; break;
      default: throw new NutzungsFehler(`Unbekannte Option: ${a} (siehe --hilfe)`);
    }
  }
  if (o.versionCode !== undefined && !Number.isSafeInteger(o.versionCode)) throw new NutzungsFehler('--version-code muss eine ganze Zahl sein.');
  if (o.minVersionCode !== undefined && !Number.isSafeInteger(o.minVersionCode)) throw new NutzungsFehler('--min-version-code muss eine ganze Zahl sein.');
  if (o.entwurf && o.hochladen) throw new NutzungsFehler('--entwurf und --hochladen schliessen sich aus.');
  if (o.zeit !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(o.zeit) || Number.isNaN(Date.parse(o.zeit)))) {
    throw new NutzungsFehler('--zeit im Format JJJJ-MM-TTThh:mm:ssZ (UTC) angeben.');
  }
  return o;
}

async function sha256Datei(p) {
  const h = crypto.createHash('sha256');
  for await (const stueck of fs.createReadStream(p)) h.update(stueck);
  return h.digest('hex');
}

function tilde(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function zielSicher(ziel) {
  const z = path.resolve(ziel);
  const verboten = [REPO, WEBSITE, path.join(WEBSITE, 'site'), os.homedir(), path.parse(z).root];
  for (const v of verboten) {
    const rel = path.relative(z, v);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new NutzungsFehler(`--ziel ${z} wuerde ${v} loeschen - bitte einen eigenen, leeren Ordner angeben.`);
    }
  }
  return z;
}

function apksSammeln(o, konfig) {
  const liste = [];
  if (o.apk.length) {
    for (const eintrag of o.apk) {
      const m = eintrag.match(/^([a-z0-9_-]+)=(.+)$/);
      if (!m || !konfig.abis.includes(m[1])) throw new NutzungsFehler(`--apk ${eintrag}: Form <abi>=<datei>, abi aus ${konfig.abis.join(', ')}.`);
      liste.push({ abi: m[1], quelle: path.resolve(m[2]) });
    }
  } else {
    // Website-Variante (Flavor "web", PLAY_STORE.md): Gradle legt sie unter
    // apk/web/release als app-web-<abi>-release.apk ab. Der alte Name ohne
    // Flavor (app-<abi>-release.apk) wird fuer eigene Ordner weiter erkannt.
    // Eine Play-APK faellt spaetestens an applicationId/Zertifikat durch.
    const ordner = path.resolve(o.apkOrdner || path.join(REPO, 'android', 'app', 'build', 'outputs', 'apk', 'web', 'release'));
    for (const abi of konfig.abis) {
      const p = [`app-web-${abi}-release.apk`, `app-${abi}-release.apk`]
        .map((name) => path.join(ordner, name))
        .find((kandidat) => fs.existsSync(kandidat));
      if (p) liste.push({ abi, quelle: p });
    }
  }
  for (const a of liste) if (!fs.statSync(a.quelle, { throwIfNoEntry: false })?.isFile()) throw new NutzungsFehler(`APK nicht gefunden: ${a.quelle}`);
  if (new Set(liste.map((a) => a.abi)).size !== liste.length) throw new NutzungsFehler('Jede ABI darf nur einmal vorkommen.');
  liste.sort((a, b) => konfig.abis.indexOf(a.abi) - konfig.abis.indexOf(b.abi));
  return liste;
}

/**
 * Baut die Seite. Gibt eine Zusammenfassung zurueck.
 * @param {object} o - Optionen (siehe optionenLesen)
 * @param {{ log?: (s:string)=>void, warn?: (s:string)=>void }} [aus]
 */
export async function veroeffentlichen(o, aus = {}) {
  const log = aus.log || ((s) => console.log(s));
  const warn = aus.warn || ((s) => console.warn(`WARNUNG: ${s}`));
  const entwurf = !!o.entwurf;
  const konfig = konfigLaden(path.resolve(o.konfig || path.join(WEBSITE, 'seite.json')));
  // Zielordner zuerst pruefen - er wird spaeter geleert; ein gefaehrliches
  // Ziel (Repo, Quellen) muss abbrechen, bevor irgendetwas anderes passiert.
  zielSicher(o.ziel || path.join(WEBSITE, 'build', 'seite'));
  const fehlt = (was) => {
    if (entwurf) return { html: platzhalterHtml(was) };
    throw new AbbruchFehler(`Fehlt: ${was}`);
  };

  // ---------------------------------------------------------- APKs
  const apks = apksSammeln(o, konfig);
  if (!entwurf) {
    const fehlend = konfig.abis.filter((abi) => !apks.some((a) => a.abi === abi));
    if (fehlend.length) throw new AbbruchFehler(`APK fehlt fuer: ${fehlend.join(', ')} (erwartet app-web-<abi>-release.apk aus ./gradlew assembleWebRelease; ABIs in seite.json "abis").`);
  } else if (apks.length === 0) {
    warn('Keine APK gefunden - Entwurf ohne Download-Dateien.');
  }

  // ---------------------------------------------------------- Version und Zertifikat pruefen
  const aapt2 = o.ohneAapt2 ? null : (o.aapt2 || (apks.length ? werkzeugFinden('aapt2') : null));
  const apksigner = o.ohneApksigner ? null : (o.apksigner || (apks.length ? werkzeugFinden('apksigner') : null));
  let ausApk = null;
  let gemessenesZert = null;
  for (const a of apks) {
    if (aapt2) {
      const r = starten(aapt2, ['dump', 'badging', a.quelle]);
      if (r.code !== 0) throw new AbbruchFehler(`aapt2 konnte ${a.quelle} nicht lesen: ${r.fehler.trim()}`);
      const b = badgingAuswerten(r.aus);
      if (b.applicationId !== konfig.applicationId) throw new AbbruchFehler(`${path.basename(a.quelle)}: Paket ${b.applicationId}, erwartet ${konfig.applicationId} (Demo-Build?).`);
      if (ausApk && (ausApk.versionCode !== b.versionCode || ausApk.versionName !== b.versionName)) {
        throw new AbbruchFehler('Die APKs haben unterschiedliche Versionen.');
      }
      ausApk = b;
    }
    if (apksigner) {
      const r = starten(apksigner, ['verify', '--print-certs', a.quelle]);
      if (r.code !== 0) throw new AbbruchFehler(`apksigner: Signatur von ${path.basename(a.quelle)} ungueltig: ${(r.fehler || r.aus).trim()}`);
      const z = apksignerAuswerten(r.aus);
      if (istDebugZertifikat(z.dn)) {
        const text = `${path.basename(a.quelle)} ist mit dem DEBUG-Schluessel signiert (keystore.properties fehlt beim Bauen?).`;
        if (!entwurf) throw new AbbruchFehler(text);
        warn(text);
      }
      if (gemessenesZert && gemessenesZert !== z.sha256) throw new AbbruchFehler('Die APKs sind mit unterschiedlichen Schluesseln signiert.');
      gemessenesZert = z.sha256;
    }
  }
  if (apks.length && !apksigner) {
    const text = o.ohneApksigner
      ? '--ohne-apksigner: das Signaturzertifikat der APK wird NICHT geprueft.'
      : 'apksigner nicht gefunden (Android SDK Build-Tools) - das Signaturzertifikat wird NICHT geprueft.';
    if (!entwurf && !o.ohneApksigner) throw new AbbruchFehler(`${text} Pfad mit --apksigner angeben oder (nicht empfohlen) --ohne-apksigner.`);
    warn(text);
  }
  if (apks.length && !aapt2) warn('aapt2 nicht gefunden - Version kommt aus --version/--version-code bzw. android/app/build.gradle.');

  let version = ausApk ? { versionName: ausApk.versionName, versionCode: ausApk.versionCode } : null;
  if (o.version !== undefined || o.versionCode !== undefined) {
    if (version && ((o.version !== undefined && o.version !== version.versionName) || (o.versionCode !== undefined && o.versionCode !== version.versionCode))) {
      throw new AbbruchFehler(`Angegebene Version passt nicht zur APK (${version.versionName} / ${version.versionCode}).`);
    }
    version = version || {};
    if (o.version !== undefined) version.versionName = o.version;
    if (o.versionCode !== undefined) version.versionCode = o.versionCode;
  }
  if (!version || version.versionName === undefined || version.versionCode === undefined) {
    version = { ...gradleVersionLesen(path.join(REPO, 'android', 'app', 'build.gradle')), ...(version || {}) };
    if (apks.length) warn(`Version aus build.gradle: ${version.versionName} (${version.versionCode}) - bitte pruefen, ob die APK so gebaut wurde.`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version.versionName)) throw new AbbruchFehler(`Ungueltiger versionName: ${version.versionName}`);
  const minVersionCode = o.minVersionCode ?? konfig.minSupportedVersionCode;
  if (minVersionCode > version.versionCode) throw new AbbruchFehler(`minSupportedVersionCode (${minVersionCode}) ist groesser als versionCode (${version.versionCode}).`);

  let zert = konfig.apkZertifikatSha256 || null;
  if (gemessenesZert) {
    if (!zert) {
      const text = `In website/seite.json ist "apkZertifikatSha256" noch leer. Gemessen: ${gemessenesZert}\n` +
        '  Pruefe, dass das dein Release-Schluessel ist (keytool -list -v -keystore <dein-keystore>), und trage den Wert ein.';
      if (!entwurf) throw new AbbruchFehler(text);
      warn(text);
      zert = gemessenesZert;
    } else if (zert !== gemessenesZert) {
      throw new AbbruchFehler(`Die APK ist mit einem ANDEREN Schluessel signiert als in seite.json eingetragen!\n  seite.json: ${zert}\n  APK:        ${gemessenesZert}`);
    }
  }

  // ---------------------------------------------------------- Versionshinweise
  const hinweisDatei = path.resolve(o.hinweise || path.join(WEBSITE, 'versionshinweise', `${version.versionName}.txt`));
  let hinweise = fs.existsSync(hinweisDatei) ? fs.readFileSync(hinweisDatei, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim() : '';
  if (!hinweise) {
    if (!entwurf) throw new AbbruchFehler(`Versionshinweise fehlen: ${hinweisDatei}`);
    warn(`Versionshinweise fehlen (${hinweisDatei}).`);
  }
  // Englische Versionshinweise fuer /en/download.html (<version>.en.txt); ohne Datei: deutscher Text mit Hinweis.
  const hinweisDateiEn = hinweisDatei.replace(/\.txt$/i, '.en.txt');
  const hinweiseEn = fs.existsSync(hinweisDateiEn) ? fs.readFileSync(hinweisDateiEn, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim() : '';
  if (hinweise && !hinweiseEn) warn(`Englische Versionshinweise fehlen (${hinweisDateiEn}) - die englische Seite zeigt den deutschen Text.`);

  // ---------------------------------------------------------- Ausgabeordner
  const ziel = zielSicher(o.ziel || path.join(WEBSITE, 'build', 'seite'));
  fs.rmSync(ziel, { recursive: true, force: true });
  fs.mkdirSync(path.join(ziel, 'updates'), { recursive: true });

  const veroeffentlicht = o.zeit || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const eintraege = [];
  for (const a of apks) {
    const datei = `malachi-${version.versionName}-${a.abi}.apk`;
    const zielDatei = path.join(ziel, 'updates', datei);
    fs.copyFileSync(a.quelle, zielDatei);
    eintraege.push({ abi: a.abi, file: datei, size: fs.statSync(zielDatei).size, sha256: await sha256Datei(zielDatei) });
  }

  // ---------------------------------------------------------- Manifest und Signatur
  let updateSchluessel = konfig.updateSchluessel || null;
  let signaturB64 = null;
  if (eintraege.length && zert && hinweise) {
    const bytes = manifestBytes({
      applicationId: konfig.applicationId,
      versionName: version.versionName,
      versionCode: version.versionCode,
      minSupportedVersionCode: minVersionCode,
      published: veroeffentlicht,
      signingCertSha256: zert,
      releaseNotes: hinweise,
      apks: eintraege,
    });
    fs.writeFileSync(path.join(ziel, 'updates', 'manifest.json'), bytes);
    const schluesselDatei = path.resolve(tilde(o.schluessel || '~/.malachi/update-signierschluessel.json'));
    if (!entwurf || o.schluessel) {
      if (!fs.existsSync(schluesselDatei)) {
        throw new AbbruchFehler(`Update-Signierschluessel nicht gefunden: ${schluesselDatei}\n  Erzeugen: node website/werkzeuge/update-schluessel.mjs erzeugen (siehe UPDATE_FORMAT.md)`);
      }
      const passphrase = await passphraseLesen(`Passphrase fuer ${schluesselDatei}: `);
      const { privat, oeffentlichRoh } = schluesseldateiOeffnen(fs.readFileSync(schluesselDatei, 'utf8'), passphrase);
      const pub = base64urlKodieren(oeffentlichRoh);
      if (!updateSchluessel) {
        if (!entwurf) throw new AbbruchFehler(`In website/seite.json ist "updateSchluessel" leer. Eintragen: ${pub}`);
        updateSchluessel = pub;
      } else if (updateSchluessel !== pub) {
        throw new AbbruchFehler(`Die Schluesseldatei passt nicht zu seite.json "updateSchluessel" (${pub} statt ${updateSchluessel}).`);
      }
      const sig = signieren(privat, bytes);
      fs.writeFileSync(path.join(ziel, 'updates', 'manifest.json.sig'), signaturDateiText(sig));
      // Gegenprobe wie in der App: Datei neu lesen, Signatur pruefen, dann parsen.
      const gelesen = fs.readFileSync(path.join(ziel, 'updates', 'manifest.json'));
      const sigGelesen = signaturDateiLesen(fs.readFileSync(path.join(ziel, 'updates', 'manifest.json.sig'), 'utf8'));
      if (!pruefen(base64urlDekodieren(updateSchluessel, 32), gelesen, sigGelesen)) throw new AbbruchFehler('Gegenprobe der Signatur fehlgeschlagen.');
      manifestLesen(gelesen);
      signaturB64 = sigGelesen.toString('base64');
    } else {
      warn('Entwurf: Manifest wird nicht signiert (manifest.json.sig fehlt).');
    }
  } else if (!entwurf) {
    throw new AbbruchFehler('Manifest konnte nicht erstellt werden (APK, Zertifikat oder Versionshinweise fehlen).');
  }
  if (eintraege.length) {
    fs.writeFileSync(path.join(ziel, 'updates', 'SHA256SUMS'), eintraege.map((e) => `${e.sha256}  ${e.file}\n`).join(''));
  }
  if (updateSchluessel) fs.writeFileSync(path.join(ziel, 'updates', 'update-schluessel.pem'), oeffentlichPem(base64urlDekodieren(updateSchluessel, 32)));

  // ---------------------------------------------------------- Seite
  const haupt = eintraege.find((e) => e.abi === 'arm64-v8a') || eintraege[0];
  const werte = {
    ONION_ADRESSE: konfig.onionAdresse || fehlt('Onion-Adresse der Website in website/seite.json'),
    SHOP_LINK_HTML: {
      html: konfig.shopOnion
        ? `<a class="pruefsumme" href="http://${htmlMaskieren(konfig.shopOnion)}/">${htmlMaskieren(konfig.shopOnion)}</a>`
        : '<em>Der Shop geht in Kürze online.</em>',
    },
    VERSION: version.versionName,
    VERSION_CODE: String(version.versionCode),
    DATUM: datumText(new Date(veroeffentlicht)),
    APK_HAUPT_DATEI: haupt ? haupt.file : fehlt('APK-Datei'),
    APK_HAUPT_ABI: haupt ? haupt.abi : fehlt('ABI'),
    APK_HAUPT_GROESSE: haupt ? groesseText(haupt.size) : fehlt('Groesse'),
    APK_HAUPT_SHA256: haupt ? haupt.sha256 : fehlt('SHA-256'),
    APK_TABELLE_HTML: {
      html: eintraege.length
        ? eintraege.map((e) => `        <tr><th scope="row">${htmlMaskieren(e.abi)}</th><td><a class="pruefsumme" href="updates/${htmlMaskieren(e.file)}">${htmlMaskieren(e.file)}</a></td><td>${htmlMaskieren(groesseText(e.size))}</td><td><code class="pruefsumme">${e.sha256}</code></td></tr>`).join('\n')
        : `        <tr><td colspan="4">${platzhalterHtml('APK-Dateien')}</td></tr>`,
    },
    HINWEISE_HTML: hinweise ? { html: hinweiseHtml(hinweise) } : fehlt('Versionshinweise'),
    HINWEISE_EN_HTML: hinweiseEn
      ? { html: hinweiseHtml(hinweiseEn) }
      : hinweise ? { html: `<p><em>Release notes are available in German only:</em></p>\n  ${hinweiseHtml(hinweise)}` } : fehlt('Versionshinweise'),
    DATUM_EN: datumTextEn(new Date(veroeffentlicht)),
    APK_HAUPT_GROESSE_EN: haupt ? groesseTextEn(haupt.size) : fehlt('Groesse'),
    APK_TABELLE_EN_HTML: {
      html: eintraege.length
        ? eintraege.map((e) => `        <tr><th scope="row">${htmlMaskieren(e.abi)}</th><td><a class="pruefsumme" href="../updates/${htmlMaskieren(e.file)}">${htmlMaskieren(e.file)}</a></td><td>${htmlMaskieren(groesseTextEn(e.size))}</td><td><code class="pruefsumme">${e.sha256}</code></td></tr>`).join('\n')
        : `        <tr><td colspan="4">${platzhalterHtml('APK files')}</td></tr>`,
    },
    APK_ZERTIFIKAT_SHA256: zert || fehlt('SHA-256 des Signaturzertifikats in website/seite.json'),
    APK_ZERTIFIKAT_SHA256_DOPPELPUNKT: zert ? mitDoppelpunkten(zert) : fehlt('Zertifikat'),
    UPDATE_SCHLUESSEL: updateSchluessel || fehlt('oeffentlicher Update-Schluessel in website/seite.json'),
  };
  const { seiten, platzhalter } = seiteBauen(path.join(WEBSITE, 'site'), ziel, werte);

  log(`\nGebaut: ${ziel}`);
  log(`  Seiten: ${seiten.join(', ')}`);
  log(`  Version: ${version.versionName} (versionCode ${version.versionCode}, mindestens unterstuetzt: ${minVersionCode})`);
  for (const e of eintraege) log(`  ${e.file}  ${groesseText(e.size)}  ${e.sha256}`);
  if (zert) log(`  Signaturzertifikat SHA-256: ${zert}`);
  if (signaturB64) log(`  Manifest signiert (Ed25519, Schluessel ${updateSchluessel}).`);

  if (platzhalter.length) {
    const text = `Noch nicht ausgefuellt ([BITTE AUSFUELLEN ...]): ${platzhalter.join(', ')}`;
    if (!entwurf && !o.platzhalterErlauben) throw new AbbruchFehler(`${text}\n  Erst ausfuellen (website/site/*.html) - oder nur zum Testen --platzhalter-erlauben.`);
    warn(text);
  }

  const ergebnis = { ziel, version, eintraege, zert, updateSchluessel, signaturB64, platzhalter, veroeffentlicht };

  // ---------------------------------------------------------- Hochladen
  if (o.hochladen) hochladen(o, konfig, ergebnis, log);
  return ergebnis;
}

function hochladen(o, konfig, ergebnis, log) {
  const sshZiel = o.sshZiel || konfig.hochladen.ziel;
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.:\[\]-]+$/.test(sshZiel)) throw new NutzungsFehler('--ssh-ziel muss die Form nutzer@rechner haben.');
  const schluessel = path.resolve(tilde(o.sshSchluessel || konfig.hochladen.sshSchluessel));
  const idArgs = fs.existsSync(schluessel) ? ['-i', schluessel] : [];
  if (!idArgs.length) console.warn(`WARNUNG: SSH-Schluessel ${schluessel} nicht gefunden - ssh nutzt seine Standardschluessel.`);
  const jetzt = new Date();
  const stempel = `${jetzt.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${ergebnis.version.versionName}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const eingang = konfig.hochladen.eingang;

  log(`\nHochladen nach ${sshZiel}:${eingang}/${stempel} ...`);
  // Relativer Quellpfad (cwd = Elternordner): keine Laufwerksbuchstaben, die scp als Rechnernamen deuten koennte.
  let r = spawnSync('scp', [...idArgs, '-r', '-q', path.basename(ergebnis.ziel), `${sshZiel}:${eingang}/${stempel}`], {
    cwd: path.dirname(ergebnis.ziel), stdio: 'inherit',
  });
  if (r.error || r.status !== 0) throw new AbbruchFehler(`scp fehlgeschlagen (${r.error ? r.error.message : `Code ${r.status}`}).`);
  log('Aktivieren (sudo fragt nach deinem Passwort auf dem Laptop) ...');
  r = spawnSync('ssh', [...idArgs, '-t', sshZiel, 'sudo', konfig.hochladen.aktivieren, stempel], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    throw new AbbruchFehler(`Aktivieren fehlgeschlagen (${r.error ? r.error.message : `Code ${r.status}`}). Der Upload liegt noch in ${eingang}/${stempel}.`);
  }
  log(`Fertig: Version ${ergebnis.version.versionName} ist online.`);
}

function istHauptmodul() {
  if (!process.argv[1]) return false;
  const a = fileURLToPath(import.meta.url);
  const b = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (istHauptmodul()) {
  try {
    const o = optionenLesen(process.argv.slice(2));
    if (o.hilfe) {
      console.log(HILFE);
    } else {
      await veroeffentlichen(o);
    }
  } catch (e) {
    console.error(`\nFEHLER: ${e.message}`);
    process.exit(e instanceof NutzungsFehler ? 2 : 1);
  }
}
