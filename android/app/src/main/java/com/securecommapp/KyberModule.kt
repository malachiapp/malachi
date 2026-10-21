package com.securecommapp

import com.facebook.react.bridge.*
import org.bouncycastle.pqc.crypto.mlkem.*
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
            val pub  = (kp.public  as MLKEMPublicKeyParameters).encoded
            val priv = (kp.private as MLKEMPrivateKeyParameters).encoded
            val result = Arguments.createMap()
            result.putString("publicKey", Base64.encodeToString(pub,  Base64.NO_WRAP))
            result.putString("secretKey", Base64.encodeToString(priv, Base64.NO_WRAP))
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
            val privKey     = MLKEMPrivateKeyParameters(MLKEMParameters.ml_kem_768, privBytes)
            val ext         = MLKEMExtractor(privKey)
            val secret      = ext.extractSecret(cipherBytes)
            promise.resolve(Base64.encodeToString(secret, Base64.NO_WRAP))
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