package com.securecommapp.siegel

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

/**
 * Siegel-Tresor (SiegelVault.js, SIEGEL_DESIGN.md): geraetegebundener Anteil
 * des Tresorschluessels.
 *
 *  - HMAC-SHA256-Schluessel im AndroidKeyStore unter "malachi_siegel_v1",
 *    nicht exportierbar, wenn vorhanden im Sicherheitschip (StrongBox), sonst
 *    in der TEE. Wird beim Einrichten des Tresors erzeugt und beim Loeschen
 *    (zu viele Fehlversuche, Duress-PIN, Geraet zuruecksetzen) vernichtet.
 *  - deriveVaultKey(passphrase, salt, iterations):
 *        pw  = Argon2id(passphrase, salt, memKiB, iterations)   (32 Byte, BouncyCastle)
 *        key = HMAC-SHA256_keystore(pw)                          (32 Byte)
 *    Jeder Rateversuch fuer die Passphrase braucht damit den Schluessel im
 *    Chip DIESES Geraets: eine kopierte App-Datei laesst sich nirgends sonst
 *    durchprobieren, und auf dem Geraet selbst bremsen Argon2id (speicher-
 *    hart) und der Chip.
 *  - Weder Passphrase noch Ableitungen werden geloggt.
 *
 * JS: NativeModules.MalachiSiegelKey.{createKey, hasKey, deriveVaultKey, destroyKey}
 */
class MalachiSiegelKeyModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiSiegel"
        const val ALIAS = "malachi_siegel_v1"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val MIN_MEM_KIB = 8 * 1024
        private const val MAX_MEM_KIB = 256 * 1024
        private const val MAX_ITERATIONS = 10
        private val LOCK = Any()
    }

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "malachi-siegel").apply { isDaemon = true } }

    override fun getName() = "MalachiSiegelKey"

    /** Erzeugt den Geraeteschluessel neu (ein vorhandener wird ersetzt). -> "strongbox"|"tee"|"software"|"unbekannt" */
    @ReactMethod
    fun createKey(promise: Promise) {
        executor.execute {
            try {
                val level = synchronized(LOCK) {
                    val ks = keyStore()
                    if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
                    generate()
                    securityLevel()
                }
                promise.resolve(level)
            } catch (e: Throwable) {
                Log.w(TAG, "Siegel-Schluessel nicht erzeugbar: ${e.javaClass.simpleName}")
                promise.reject("SIEGEL_KEY", "Siegel-Schluessel nicht erzeugbar", e)
            }
        }
    }

    @ReactMethod
    fun hasKey(promise: Promise) {
        executor.execute {
            try { promise.resolve(keyStore().containsAlias(ALIAS)) } catch (e: Throwable) { promise.resolve(false) }
        }
    }

    @ReactMethod
    fun deriveVaultKey(passphrase: String, saltB64: String, memKiB: Int, iterations: Int, promise: Promise) {
        executor.execute {
            var pw: ByteArray? = null
            try {
                if (memKiB < MIN_MEM_KIB || memKiB > MAX_MEM_KIB || iterations < 1 || iterations > MAX_ITERATIONS) throw IllegalArgumentException("Parameter")
                val salt = Base64.decode(saltB64, Base64.NO_WRAP)
                if (salt.size < 16) throw IllegalArgumentException("Salz")
                val key = synchronized(LOCK) { keyStore().getKey(ALIAS, null) as? SecretKey }
                if (key == null) { promise.reject("SIEGEL_NO_KEY", "Siegel-Schluessel fehlt"); return@execute }
                pw = argon2id(passphrase, salt, memKiB, iterations)
                val mac = Mac.getInstance("HmacSHA256")
                mac.init(key)
                val out = mac.doFinal(pw)
                promise.resolve(Base64.encodeToString(out, Base64.NO_WRAP))
                out.fill(0)
            } catch (e: Throwable) {
                Log.w(TAG, "Tresorschluessel nicht ableitbar: ${e.javaClass.simpleName}")
                promise.reject("SIEGEL_DERIVE", "Tresorschluessel nicht ableitbar", e)
            } finally {
                pw?.fill(0)
            }
        }
    }

    @ReactMethod
    fun destroyKey(promise: Promise) {
        executor.execute {
            try {
                synchronized(LOCK) { keyStore().let { if (it.containsAlias(ALIAS)) it.deleteEntry(ALIAS) } }
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("SIEGEL_KEY", "Siegel-Schluessel nicht loeschbar", e)
            }
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun spec(strongBox: Boolean): KeyGenParameterSpec {
        val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
        return b.build()
    }

    private fun generate() {
        val wantStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            reactApplicationContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        if (wantStrongBox) {
            try {
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE).apply {
                    init(spec(strongBox = true))
                    generateKey()
                }
                return
            } catch (e: Throwable) {
                Log.i(TAG, "StrongBox nicht nutzbar (${e.javaClass.simpleName}) - TEE")
                try { keyStore().let { if (it.containsAlias(ALIAS)) it.deleteEntry(ALIAS) } } catch (_: Throwable) {}
            }
        }
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE).apply {
            init(spec(strongBox = false))
            generateKey()
        }
    }

    private fun securityLevel(): String = try {
        val key = keyStore().getKey(ALIAS, null) as SecretKey
        val factory = SecretKeyFactory.getInstance(key.algorithm, KEYSTORE)
        val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
                else -> "unbekannt"
            }
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) "tee" else "software"
        }
    } catch (_: Throwable) { "unbekannt" }

    /** Argon2id (RFC 9106) aus BouncyCastle - speicherhart, bremst Rateversuche auch auf Spezialhardware. */
    private fun argon2id(passphrase: String, salt: ByteArray, memKiB: Int, iterations: Int): ByteArray {
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withMemoryAsKB(memKiB)
            .withIterations(iterations)
            .withParallelism(1)
            .build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val chars = passphrase.toCharArray()
        val out = ByteArray(32)
        try { gen.generateBytes(chars, out) } finally { chars.fill('\u0000') }
        return out
    }
}
