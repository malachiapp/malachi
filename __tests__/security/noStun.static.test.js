// Waechter STUN-Ausstieg (STUN_AUSSTIEG_PLAN.md, Entscheidungen E1/E2/E7):
// Malachi selbst fragt keinen STUN- und keinen TURN-Dienst - in keiner Stufe,
// fuer keine PeerConnection (Chat, 1:1-Anruf, Gruppenanruf), weder in der
// Website- noch in der Play-Variante, nativ wie in der (offline gestellten)
// Web-App.
//   - Im App-Code steht keine stun:/stuns:/turn:/turns:-Adresse und kein
//     bekannter STUN-Hostname.
//   - Einzige Ausnahme: die Snowflake-Zeilen der eingebauten Tor-Bruecken
//     (TorBridges.js) - das sind STUN-Server des Tor-Projekts fuer Snowflake,
//     keine von Malachi.
//   - pcConfigForMode liefert fuer jede erlaubte Stufe iceServers: [].
//   - AppConfig exportiert nichts mit STUN.
const fs = require('fs');
const path = require('path');
const { installKyberModuleMock } = require('./helpers/nativeBridgeMock');
installKyberModuleMock();

const ROOT = path.join(__dirname, '..', '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Quelltexte der App: alle JS/TS-Dateien im Hauptverzeichnis (ausser
// Werkzeug-Konfiguration), die Web-App, nativer Android-Code samt Manifest
// und Ressourcen, die Build-Konfiguration beider Varianten.
const SKIP_ROOT = new Set(['babel.config.js', 'jest.config.js', 'jest.setup.js', 'metro.config.js']);
function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'build', '.gradle', '.cxx', 'generated'].includes(e.name)) continue;
      walk(p, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}
function appSources() {
  const root = fs.readdirSync(ROOT).filter((f) => /\.(js|ts|tsx)$/.test(f) && !SKIP_ROOT.has(f)).map((f) => path.join(ROOT, f));
  return [
    ...root,
    ...walk(path.join(ROOT, 'locales'), ['.js']),
    ...walk(path.join(ROOT, 'web', 'src'), ['.ts', '.tsx', '.js']),
    ...walk(path.join(ROOT, 'android', 'app', 'src'), ['.kt', '.java', '.xml']),
    path.join(ROOT, 'android', 'app', 'build.gradle'),
    ...walk(path.join(ROOT, 'ios'), ['.swift', '.m', '.mm', '.plist']),
  ];
}

// stun:host, stuns:host, turn:host, turns:host (auch mit [IPv6] oder //).
const ICE_URL = /\b(?:stuns?|turns?):(?:\/\/)?[A-Za-z0-9[]/i;
// Bekannte STUN-Hostnamen ("stun.", "stun1.", "global.stun." ...) und die
// bis 1.1.0 genutzten Betreiber-Adressen.
const STUN_HOST = /(?:^|[^A-Za-z0-9])stun\d*\.[a-z0-9-]+\.[a-z]{2,}/i;
const KNOWN = /stun\.(?:nextcloud\.com|sipgate\.net|1und1\.de|t-online\.de|l\.google\.com|cloudflare\.com)/i;

function isAllowedLine(file, line) {
  // Snowflake-Bruecken des Tor-Projekts (E7).
  return rel(file) === 'TorBridges.js' && /^\s*"snowflake \S+ [0-9A-F]{40} /.test(line);
}

test('keine STUN-/TURN-Adresse und kein STUN-Hostname im App-Code (Ausnahme: Snowflake-Bruecken)', () => {
  const files = appSources();
  expect(files.length).toBeGreaterThan(60);
  expect(files.map(rel)).toEqual(expect.arrayContaining([
    'App.tsx', 'WebRTCManager.js', 'CallManager.js', 'GroupCallManager.js', 'ConnectionMode.js',
    'AppConfig.js', 'TorBridges.js', 'web/src/lib/WebRTCManager.ts', 'android/app/build.gradle',
  ]));
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isAllowedLine(f, line)) return;
      if (ICE_URL.test(line) || STUN_HOST.test(line) || KNOWN.test(line)) hits.push(rel(f) + ':' + (i + 1) + ': ' + line.trim().slice(0, 120));
    });
  }
  expect(hits).toEqual([]);
});

test('der Waechter erkennt, was er verbieten soll (Selbsttest)', () => {
  for (const bad of [
    "{ urls: 'stun:stun.nextcloud.com:443' }", 'iceServers: [{ urls: `turns:relay.example:5349` }]',
    "'stun:[2001:db8::1]:3478'", "const host = 'stun1.l.google.com';", 'global.stun.twilio.com:3478',
  ]) expect(ICE_URL.test(bad) || STUN_HOST.test(bad) || KNOWN.test(bad)).toBe(true);
  // Erklaerende Texte bleiben moeglich.
  for (const ok of ['// verbietet stun:/turn:-Adressen', 'Malachi fragt keinen STUN-Dienst', 'return: 1', 'Stunde']) {
    expect(ICE_URL.test(ok) || STUN_HOST.test(ok) || KNOWN.test(ok)).toBe(false);
  }
});

test('die Snowflake-Ausnahme gilt nur fuer die Bruecken-Zeilen in TorBridges.js', () => {
  const { TOR_BUILTIN_BRIDGES } = require('../../TorBridges');
  for (const line of TOR_BUILTIN_BRIDGES.snowflake) {
    expect(line).toMatch(/^snowflake /);
    expect(isAllowedLine(path.join(ROOT, 'TorBridges.js'), '    "' + line + '",')).toBe(true);
  }
  // Dieselbe Zeile in einer anderen Datei waere verboten.
  const sample = '    "' + TOR_BUILTIN_BRIDGES.snowflake[0] + '",';
  expect(isAllowedLine(path.join(ROOT, 'WebRTCManager.js'), sample)).toBe(false);
  // Sonst keine STUN-Angaben in den Bruecken (obfs4, meek).
  for (const [kind, list] of Object.entries(TOR_BUILTIN_BRIDGES)) {
    if (kind === 'snowflake') continue;
    for (const line of list) expect(line).not.toMatch(/stun/i);
  }
});

test('pcConfigForMode: fuer jede erlaubte Stufe iceServers: [] - Stufe 3 baut keine PeerConnection', () => {
  const CM = require('../../ConnectionMode');
  const { pcConfigForMode } = require('../../WebRTCManager');
  for (const mode of CM.CONNECTION_MODES.filter((m) => m !== CM.MODE_TOR_ONLY)) {
    expect(pcConfigForMode(mode).iceServers).toEqual([]);
  }
  // auch fuer alte oder unbekannte Werte
  for (const mode of [1, 2, 0, null, undefined, '1', 'x']) expect(pcConfigForMode(mode).iceServers).toEqual([]);
  expect(() => pcConfigForMode(CM.MODE_TOR_ONLY)).toThrow();
});

test('AppConfig exportiert nichts mit STUN; die Play-Variante hat keine eigene Netz-Konfiguration', () => {
  const cfg = require('../../AppConfig');
  expect(Object.keys(cfg).filter((k) => /(^|_)(STUN|TURN|ICE)(_|S?$)/i.test(k))).toEqual([]);
  // Distribution.js unterscheidet nur Vertrieb/Kauf - kein Netzweg je Variante.
  const dist = fs.readFileSync(path.join(ROOT, 'Distribution.js'), 'utf8');
  expect(dist).not.toMatch(/ice|stun|nominatim/i);
  // build.gradle: keine Flavor-eigenen Netzschalter.
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  expect(gradle).not.toMatch(/stun|nominatim/i);
});
