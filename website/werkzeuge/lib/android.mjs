// Android-Werkzeuge (apksigner, aapt2) finden und auswerten.
//
// apksigner prueft die APK-Signatur und liefert den SHA-256-Fingerabdruck des
// Signaturzertifikats. aapt2 liest Paketname, versionCode und versionName aus
// der APK. Beide liegen in den Android SDK Build-Tools.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class AndroidFehler extends Error {}

function versionVergleichen(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function sdkKandidaten() {
  const k = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) k.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  k.push(path.join(os.homedir(), 'Android', 'Sdk'), path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  return k.filter(Boolean);
}

/** Pfad zu apksigner/aapt2 in den neuesten Build-Tools oder null. */
export function werkzeugFinden(name) {
  const namen = process.platform === 'win32' ? (name === 'apksigner' ? ['apksigner.bat'] : [`${name}.exe`]) : [name];
  for (const sdk of sdkKandidaten()) {
    const bt = path.join(sdk, 'build-tools');
    if (!fs.existsSync(bt)) continue;
    const versionen = fs.readdirSync(bt).filter((v) => /^\d/.test(v)).sort(versionVergleichen).reverse();
    for (const v of versionen) {
      for (const n of namen) {
        const p = path.join(bt, v, n);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** Startet ein Werkzeug; .bat/.cmd unter Windows ueber die Shell (mit Anfuehrungszeichen). */
export function starten(programm, args) {
  const istBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(programm);
  for (const a of [programm, ...args]) {
    if (/["%^&|<>\r\n]/.test(a)) throw new AndroidFehler(`Unzulaessiges Zeichen in Pfad/Argument: ${a}`);
  }
  const r = istBatch
    ? spawnSync(`"${programm}"`, args.map((a) => `"${a}"`), { shell: true, encoding: 'utf8', windowsHide: true })
    : spawnSync(programm, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new AndroidFehler(`${path.basename(programm)} konnte nicht gestartet werden: ${r.error.message}`);
  return { code: r.status, aus: r.stdout || '', fehler: r.stderr || '' };
}

/** Wertet die Ausgabe von "apksigner verify --print-certs" aus. */
export function apksignerAuswerten(ausgabe) {
  const digests = [...ausgabe.matchAll(/^Signer #(\d+) certificate SHA-256 digest:\s*([0-9a-fA-F:]+)\s*$/gm)];
  const dns = [...ausgabe.matchAll(/^Signer #(\d+) certificate DN:\s*(.+)$/gm)].map((m) => m[2].trim());
  if (digests.length === 0) throw new AndroidFehler('apksigner: kein Zertifikat in der Ausgabe gefunden.');
  if (digests.length > 1) throw new AndroidFehler('apksigner: mehr als ein Signierer - erwartet genau einen.');
  const sha256 = digests[0][2].replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AndroidFehler('apksigner: ungueltiger Fingerabdruck.');
  return { sha256, dn: dns[0] || '' };
}

export function istDebugZertifikat(dn) {
  return /CN=Android Debug/i.test(dn);
}

/** Wertet "aapt2 dump badging" aus. */
export function badgingAuswerten(ausgabe) {
  const m = ausgabe.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m);
  if (!m) throw new AndroidFehler('aapt2: Paketzeile nicht gefunden.');
  const sdk = ausgabe.match(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m);
  return { applicationId: m[1], versionCode: Number(m[2]), versionName: m[3], minSdk: sdk ? Number(sdk[1]) : null };
}

/** versionCode/versionName aus android/app/build.gradle (Rueckfall, wenn aapt2 fehlt). */
export function gradleVersionLesen(gradleDatei) {
  const t = fs.readFileSync(gradleDatei, 'utf8');
  const code = t.match(/^\s*versionCode\s+(\d+)\s*$/m);
  const name = t.match(/^\s*versionName\s+"([^"]+)"\s*$/m);
  if (!code || !name) throw new AndroidFehler(`versionCode/versionName nicht in ${gradleDatei} gefunden.`);
  return { versionCode: Number(code[1]), versionName: name[1] };
}

/** Fingerabdruck in Doppelpunkt-Schreibweise (wie keytool): AB:CD:... */
export function mitDoppelpunkten(hex) {
  return hex.toUpperCase().match(/../g).join(':');
}
