package com.securecommapp

import com.facebook.react.bridge.*
// BouncyCastle 1.86: ML-KEM liegt jetzt unter org.bouncycastle.crypto
// (vorher org.bouncycastle.pqc.crypto.mlkem). Gleiche Algorithmen, gleiches
// Schluesselformat (privat: 2400 Byte dk = s|t|rho|H(ek)|z) - gespeicherte
// Schluessel aus 1.0/1.1 bleiben lesbar (BouncyCastleVectorsTest.kt).
import org.bouncycastle.crypto.generators.MLKEMKeyPairGenerator
import org.bouncycastle.crypto.kems.MLKEMExtractor
import org.bouncycastle.crypto.kems.MLKEMGenerator
import org.bouncycastle.crypto.params.MLKEMKeyGenerationParameters
import org.bouncycastle.crypto.params.MLKEMParameters
import org.bouncycastle.crypto.params.MLKEMPrivateKeyParameters
import org.bouncycastle.crypto.params.MLKEMPublicKeyParameters
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import java.security.SecureRandom
import android.util.Base64

class KyberModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "KyberModule"
    private val random = SecureRandom()

    @ReactMethod
    fun randomBytes(length: Int, promise: Promise) {
        try {
            val bytes = ByteArray(length)
            random.nextBytes(bytes)
            promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
        } catch (e: Exception) { promise.reject("RANDOM_ERROR", e.message) }
    }

    // Auf finales, NIST-standardisiertes ML-KEM-768 (FIPS 203, August 2024)
    // umgestellt statt des vorherigen Vor-Standard-"Kyber" aus BouncyCastle
    // 1.78. Noetig fuer echte FIPS-203-Konformitaet (die App behauptet das
    // schon laenger in ENCRYPTION_STATUS) und fuer Byte-Kompatibilitaet mit
    // der Web-Version, die @noble/post-quantum's ml_kem768 nutzt - beide
    // implementieren jetzt denselben finalen Standard.
    @ReactMethod
    fun generateKeypair(promise: Promise) {
        try {
            val keyGen = MLKEMKeyPairGenerator()
            keyGen.init(MLKEMKeyGenerationParameters(random, MLKEMParameters.ml_kem_768))
            val kp: AsymmetricCipherKeyPair = keyGen.generateKeyPair()
            val privKey = kp.private as MLKEMPrivateKeyParameters
            val pub  = (kp.public  as MLKEMPublicKeyParameters).encoded
            val priv = privKey.encoded
            val result = Arguments.createMap()
            result.putString("publicKey", Base64.encodeToString(pub,  Base64.NO_WRAP))
            result.putString("secretKey", Base64.encodeToString(priv, Base64.NO_WRAP))
            // Schluesselmaterial nicht laenger als noetig im Java-Speicher
            // (der Base64-Text geht ohnehin an JS - Hygiene, kein Schutzversprechen).
            privKey.destroy()
            priv.fill(0)
            promise.resolve(result)
        } catch (e: Exception) { promise.reject("KYBER_ERROR", e.message) }
    }

    @ReactMethod
    fun encapsulate(publicKeyB64: String, promise: Promise) {
        try {
            val pubBytes = Base64.decode(publicKeyB64, Base64.NO_WRAP)
            val pubKey   = MLKEMPublicKeyParameters(MLKEMParameters.ml_kem_768, pubBytes)
            val gen      = MLKEMGenerator(random)
            val enc      = gen.generateEncapsulated(pubKey)
            val result   = Arguments.createMap()
            result.putString("cipherText",   Base64.encodeToString(enc.encapsulation, Base64.NO_WRAP))
            result.putString("sharedSecret", Base64.encodeToString(enc.secret,        Base64.NO_WRAP))
            promise.resolve(result)
        } catch (e: Exception) { promise.reject("KYBER_ERROR", e.message) }
    }

    @ReactMethod
    fun decapsulate(cipherTextB64: String, secretKeyB64: String, promise: Promise) {
        try {
            val privBytes   = Base64.decode(secretKeyB64,  Base64.NO_WRAP)
            val cipherBytes = Base64.decode(cipherTextB64, Base64.NO_WRAP)
            // 1.86 prueft hier Laenge und H(ek) des privaten Schluessels und
            // beim Entkapseln die Chiffratlaenge - Fehler landen als
            // KYBER_ERROR in JS (wie bisher jede andere Ausnahme).
            val privKey     = try {
                MLKEMPrivateKeyParameters(MLKEMParameters.ml_kem_768, privBytes)
            } finally { privBytes.fill(0) }
            try {
                val secret = MLKEMExtractor(privKey).extractSecret(cipherBytes)
                promise.resolve(Base64.encodeToString(secret, Base64.NO_WRAP))
            } finally { privKey.destroy() }
        } catch (e: Exception) { promise.reject("KYBER_ERROR", e.message) }
    }
    @ReactMethod
    fun sha256(input: String, promise: Promise) {
        try {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
            val hex = bytes.joinToString("") { "%02x".format(it) }
            promise.resolve(hex)
        } catch (e: Exception) { promise.reject("SHA256_ERROR", e.message) }
    }
}