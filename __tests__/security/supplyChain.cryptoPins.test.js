// Lieferkette der Krypto-Bibliotheken (Krypto-Review V8: K-12, K-13, K-14).
//
// Statische Pruefung der Build-Dateien - sie haelt fest, was am 25.10.2026
// entschieden wurde, damit es nicht unbemerkt zurueckrutscht:
//  - @noble/* exakt gepinnt (kein ^/~) in App und Web-Client, Lockfile passt;
//  - BouncyCastle exakt und mindestens 1.85 (KyberSlash-frei, Sammel-CVE-Fix,
//    1.86 = Haerte-Release), ML-KEM aus dem neuen Paket;
//  - die BouncyCastle-Testvektoren (JVM, BouncyCastleVectorsTest.kt) existieren
//    und decken ML-KEM-768 sowie alle drei Argon2id-Verwendungen ab - sie
//    sichern Byte-Gleichheit mit 1.80 und dem Web-Client (@noble);
//  - libwebrtc (org.jitsi:webrtc) ohne dynamische Version in der APK.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const EXACT = /^\d+\.\d+\.\d+$/;

function nobleDeps(pkgPath) {
  const pkg = JSON.parse(read(pkgPath));
  return Object.entries(pkg.dependencies || {}).filter(([n]) => n.startsWith('@noble/'));
}

describe.each([
  ['App', 'package.json', 'package-lock.json', ['@noble/ciphers', '@noble/curves', '@noble/hashes']],
  ['Web-Client', 'web/package.json', 'web/package-lock.json', ['@noble/ciphers', '@noble/hashes', '@noble/post-quantum']],
])('%s: @noble exakt gepinnt (K-14)', (_label, pkgPath, lockPath, expected) => {
  test('alle @noble-Abhaengigkeiten ohne Bereich (^/~)', () => {
    const deps = nobleDeps(pkgPath);
    expect(deps.map(([n]) => n).sort()).toEqual(expect.arrayContaining(expected));
    for (const [name, spec] of deps) {
      expect([name, spec]).toEqual([name, expect.stringMatching(EXACT)]);
    }
  });

  test('Lockfile: Wurzel-Angabe und installierte Version stimmen mit dem Pin ueberein', () => {
    const lock = JSON.parse(read(lockPath));
    for (const [name, spec] of nobleDeps(pkgPath)) {
      expect(lock.packages[''].dependencies[name]).toBe(spec);
      expect(lock.packages[`node_modules/${name}`].version).toBe(spec);
    }
  });
});

describe('BouncyCastle (K-13, V8)', () => {
  const gradle = read('android/app/build.gradle');

  test('bcprov-jdk18on exakt und mindestens 1.85', () => {
    const m = gradle.match(/implementation\s+'org\.bouncycastle:bcprov-jdk18on:([^']+)'/);
    expect(m).not.toBeNull();
    const ver = m[1];
    expect(ver).toMatch(/^\d+\.\d+(\.\d+)?$/);
    const [maj, min] = ver.split('.').map(Number);
    expect(maj > 1 || (maj === 1 && min >= 85)).toBe(true);
    // genau eine BouncyCastle-Abhaengigkeit (keine zweite, aeltere daneben)
    expect(gradle.match(/org\.bouncycastle:/g)).toHaveLength(1);
  });

  test('KyberModule nutzt das neue ML-KEM-Paket (org.bouncycastle.crypto), nicht mehr pqc.crypto.mlkem', () => {
    const kt = read('android/app/src/main/java/com/securecommapp/KyberModule.kt');
    expect(kt).not.toMatch(/import org\.bouncycastle\.pqc\./);
    expect(kt).toMatch(/import org\.bouncycastle\.crypto\.kems\.MLKEMExtractor/);
    expect(kt).toMatch(/import org\.bouncycastle\.crypto\.kems\.MLKEMGenerator/);
    expect(kt).toMatch(/MLKEMParameters\.ml_kem_768/);
  });

  test('JVM-Testvektoren vorhanden: ML-KEM-768 (wie @noble) und Argon2id fuer PIN, Siegel, Telefon-Kopplung, RFC 9106', () => {
    expect(gradle).toMatch(/testImplementation\s+'junit:junit:4\.13\.2'/);
    const t = read('android/app/src/test/java/com/securecommapp/BouncyCastleVectorsTest.kt');
    for (const name of [
      'mlkem768_schluessel_aus_seed_wie_noble',
      'mlkem768_kapseln_und_entkapseln_wie_noble',
      'mlkem768_beschaedigter_schluessel_und_falsche_laengen_scheitern',
      'argon2id_rfc9106',
      'argon2id_pin_tresor_parameter',
      'argon2id_siegel_tresor_parameter_mit_umlauten',
      'argon2id_telefon_kopplung_parameter',
    ]) {
      expect(t).toContain(`fun ${name}(`);
    }
    // Die Parameter der Vektoren entsprechen den echten App-Parametern.
    const pin = read('PinVault.js').match(/export const KDF = \{[^}]*memKiB: (\d+) \* (\d+), iterations: (\d+)/);
    expect(pin && [Number(pin[1]) * Number(pin[2]), Number(pin[3])]).toEqual([32 * 1024, 3]);
    const siegel = read('SiegelVault.js').match(/const KDF = \{[^}]*memKiB: (\d+) \* (\d+), iterations: (\d+)/);
    expect(siegel && [Number(siegel[1]) * Number(siegel[2]), Number(siegel[3])]).toEqual([32 * 1024, 3]);
    const phone = read('PhonePairing.js').match(/PHONE_KDF = Object\.freeze\(\{ memKiB: (\d+) \* (\d+), iterations: (\d+), outLen: (\d+)/);
    expect(phone && [Number(phone[1]) * Number(phone[2]), Number(phone[3]), Number(phone[4])]).toEqual([64 * 1024, 3, 32]);
    expect(t).toMatch(/"1234"\.toCharArray\(\), null, seq\(16, 0x10\), 32 \* 1024, 3, 1, 32\)/);
    expect(t).toMatch(/seq\(16, 0x40\), 32 \* 1024, 3, 1, 32\)/);
    expect(t).toMatch(/seq\(48, 0x70\), salt, 64 \* 1024, 3, 1, 32\)/);
  });

  test('Jetifier laesst BouncyCastle aus (Multi-Release-Klassen Java 25), sonst bricht der Build', () => {
    const props = read('android/gradle.properties');
    expect(props).toMatch(/^android\.jetifier\.ignorelist=.*bcprov-jdk18on/m);
  });
});

describe('libwebrtc (K-12)', () => {
  test('org.jitsi:webrtc in der App exakt festgehalten (keine dynamische Version in der APK)', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/details\.requested\.group == "org\.jitsi" && details\.requested\.name == "webrtc"/);
    const pinned = gradle.match(/details\.useVersion\("([^"]+)"\)/);
    expect(pinned).not.toBeNull();
    expect(pinned[1]).toMatch(EXACT);
    // Der Pin muss zur Hauptversion passen, die react-native-webrtc verlangt -
    // beim Update der Bibliothek schlaegt dieser Test an und erinnert daran.
    const lib = read('node_modules/react-native-webrtc/android/build.gradle').match(/org\.jitsi:webrtc:(\d+)\./);
    expect(lib).not.toBeNull();
    expect(pinned[1].split('.')[0]).toBe(lib[1]);
  });
});
