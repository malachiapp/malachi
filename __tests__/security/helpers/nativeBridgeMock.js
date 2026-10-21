// Installiert NativeModules.KyberModule mit derselben Kryptografie wie die
// echte Kotlin-Implementierung (android/app/src/main/java/com/securecommapp/
// KyberModule.kt) - SecureRandom-Bytes und SHA-256(UTF-8) hex. Das steht NUR
// fuer den JNI-Bridge-Aufruf selbst, keine kryptografische Primitive wird hier
// nachgebaut oder ersetzt. Node's crypto-Modul ist selbst eine CSPRNG-Quelle,
// also bleibt die Sicherheitseigenschaft "kryptografisch sicherer Zufall"
// erhalten, nur die tatsaechliche Implementierung (BoringSSL/JVM vs. OpenSSL/
// Node) unterscheidet sich - fuer die hier getesteten Eigenschaften (Domain-
// Trennung, Frische, Tamper-Erkennung, Kollisionsfreiheit) irrelevant.
//
// Was das NICHT abdeckt: den echten ML-KEM-768-Schluesselaustausch selbst
// (lebt komplett nativ in Kotlin/BouncyCastle, laeuft nicht ausserhalb eines
// Android-Geraets/Emulators) - siehe REMAINING RISKS im Abschlussbericht.
const crypto = require('crypto');
const { NativeModules } = require('react-native');

function installKyberModuleMock() {
  NativeModules.KyberModule = {
    randomBytes: async (length) => crypto.randomBytes(length).toString('base64'),
    sha256: async (input) => crypto.createHash('sha256').update(input, 'utf8').digest('hex'),
  };
}

module.exports = { installKyberModuleMock };
