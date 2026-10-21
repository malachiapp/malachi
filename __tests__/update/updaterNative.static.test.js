// In-App-Updates: statische Pruefung der nativen Seite (ein Android-Build
// laeuft hier nicht). Haelt die Zusagen fest, auf die sich AppUpdater.js
// verlaesst: nur GET, nur Onion, nur /updates/, keine Geraetedaten in der
// Anfrage, keine Adressen/Pfade/Pruefsummen im Log, Installation nur aus dem
// eigenen Ordner nach erneuter Pruefung, Berechtigung als "nur Web" markiert.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'android', 'app', 'src', 'main');
const JAVA = path.join(APP, 'java', 'com', 'securecommapp');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
// Updater-Code und -Berechtigung liegen NUR im Web-Flavor (src/web) - die
// Play-APK enthaelt sie gar nicht (Google Play verbietet Selbst-Updates).
const WEB = path.join(ROOT, 'android', 'app', 'src', 'web');
const WEB_JAVA = path.join(WEB, 'java', 'com', 'securecommapp');
const updater = read(path.join(WEB_JAVA, 'update', 'MalachiUpdaterModule.kt'));
const tor = read(path.join(JAVA, 'tor', 'MalachiTorModule.kt'));
const mainApp = read(path.join(JAVA, 'MainApplication.kt'));
const manifestRaw = read(path.join(APP, 'AndroidManifest.xml'));

describe('MalachiUpdaterModule.kt', () => {
  test('Anfrage: nur "GET <pfad>" mit Host und Connection: close - kein User-Agent, keine Geraetedaten', () => {
    const req = /val req = "([^"]*)"/.exec(updater);
    expect(req).not.toBeNull();
    expect(req[1]).toBe('GET $path HTTP/1.1\\r\\nHost: $host\\r\\nConnection: close\\r\\n\\r\\n');
    const code = updater.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/User-Agent|Accept-Encoding|Cookie|Build\.MODEL|ANDROID_ID|versionName\s*\+/i);
    // nur ein Ort, an dem gesendet wird
    expect((updater.match(/\.write\(req\./g) || []).length).toBe(1);
  });

  test('Ziel: nur v3-Onion, nur Dateien direkt unter /updates/, ueber den Tor-SOCKS-Port mit eigenen Kreisen', () => {
    expect(updater).toContain('Regex("^[a-z2-7]{56}\\\\.onion$")');
    expect(updater).toContain('Regex("^/updates/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")');
    expect(updater).toContain('MalachiTorModule.openIsolatedSocks(host, ONION_PORT, proxyPort');
    expect(updater).toContain('MalachiTorModule.activeSocksPort()');
    expect(updater).not.toMatch(/HttpURLConnection|OkHttp|URL\(|InetAddress\.getByName|Proxy\.NO_PROXY/);
    // Der Tor-Modul-Helfer gibt den Port nur bei laufendem Tor heraus.
    expect(tor).toMatch(/internal fun activeSocksPort\(\): Int =\s*if \(torCtl != null && sharedStatus == "ON" && socksPort > 0\) socksPort else 0/);
  });

  test('Grenzen: Manifest 64 KiB, APK 1 GiB, Kopf 16 KB, Leerlauf 60 s', () => {
    expect(updater).toContain('SMALL_MAX_BYTES = 64 * 1024');
    expect(updater).toContain('APK_MAX_BYTES = 1024L * 1024 * 1024');
    expect(updater).toContain('HEADER_MAX_BYTES = 16 * 1024');
    expect(updater).toContain('IDLE_TIMEOUT_MS = 60_000');
    expect(updater).toMatch(/if \(total > maxBytes\) throw UpdateException\("UPDATE_TOO_LARGE"/);
  });

  test('Log: keine Adressen, Pfade, Pruefsummen', () => {
    const logs = updater.match(/Log\.\w\([^\n]*/g) || [];
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/\$|host|path|sha|uri|file/i);
  });

  test('Installation: nur aus dem eigenen Ordner, Groesse + SHA-256 erneut geprueft, Erlaubnis abgefragt, FileProvider', () => {
    const install = updater.slice(updater.indexOf('fun install('), updater.indexOf('private fun sha256Of'));
    expect(install).toContain('insideUpdateDir(f)');
    expect(install).toContain('f.length() != expectedSize.toLong()');
    expect(install).toContain('sha256Of(f) != expectedSha256');
    expect(install).toContain('canRequestPackageInstalls()');
    expect(install).toContain('FileProvider.getUriForFile');
    expect(install).toContain('FLAG_GRANT_READ_URI_PERMISSION');
    expect(updater).toContain('Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:"');
  });

  test('Registrierung und Berechtigung NUR im Web-Flavor (nicht in main, nicht in play)', () => {
    const ohneKommentare = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
    expect(mainApp).not.toContain('MalachiUpdaterPackage');
    expect(read(path.join(WEB_JAVA, 'FlavorPackages.kt'))).toContain('listOf(MalachiUpdaterPackage())');
    expect(read(path.join(ROOT, 'android', 'app', 'src', 'play', 'java', 'com', 'securecommapp', 'FlavorPackages.kt'))).not.toContain('Updater');
    expect(fs.existsSync(path.join(JAVA, 'update', 'MalachiUpdaterModule.kt'))).toBe(false);
    expect(ohneKommentare(manifestRaw)).not.toContain('REQUEST_INSTALL_PACKAGES');
    expect(ohneKommentare(read(path.join(WEB, 'AndroidManifest.xml')))).toContain('<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />');
    const playManifest = path.join(ROOT, 'android', 'app', 'src', 'play', 'AndroidManifest.xml');
    if (fs.existsSync(playManifest)) expect(ohneKommentare(read(playManifest))).not.toContain('REQUEST_INSTALL_PACKAGES');
    // Der FileProvider deckt den Cache ab, in dem die APK liegt (cacheDir/malachi_update).
    expect(read(path.join(APP, 'res', 'xml', 'file_paths.xml'))).toMatch(/<cache-path name="[^"]+" path="\." \/>/);
  });
});
