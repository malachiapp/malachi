package com.securecommapp.vault

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.UiThreadUtil
import com.securecommapp.BuildConfig
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

/**
 * PIN-Tresor (PinVault.js, PIN_VAULT_DESIGN.md): geraetegebundene Anteile des
 * Schluessels, der Chatverlaeufe und Vorschautexte schuetzt.
 *
 *  - PIN: HMAC-SHA256-Schluessel "malachi_pin_v1" im AndroidKeyStore (wenn
 *    vorhanden StrongBox, sonst TEE), nicht exportierbar.
 *        kek = HMAC_chip(Argon2id(PIN, Salz, memKiB, iterations))
 *    Jeder Rateversuch fuer die PIN braucht den Chip DIESES Geraets - eine
 *    kopierte App-Datei laesst sich nirgends sonst durchprobieren; auf dem
 *    Geraet bremsen Argon2id, der Chip und die Fehlversuchssperre der App.
 *    Gleiches Verfahren wie der Siegel-Tresor (MalachiSiegelKeyModule), aber
 *    ein eigener Chip-Schluessel: wer die App-PIN kennt, kommt nicht in Siegel.
 *  - Fingerabdruck: AES-256-GCM-Schluessel "malachi_pin_bio_v1", nur nach
 *    erfolgreicher starker Biometrie im Systemdialog benutzbar (CryptoObject,
 *    jede Nutzung einzeln) und ungueltig, sobald ein neuer Fingerabdruck
 *    hinzukommt. Er verschluesselt nur eine Kopie des Tresorschluessels.
 *  - Weder PIN noch Ableitungen noch der Tresorschluessel werden geloggt.
 *  - Krypto-Review 2026-10-25 (V3/K-05): zweiter PIN-Schluessel
 *    "malachi_pin_v2" mit setUnlockedDeviceRequired(true) (ab Android 9) - der
 *    Chip rechnet damit nur, solange das GERAET entsperrt ist; ein Angreifer mit
 *    Root am gesperrten Geraet kann keine Rateversuche mehr anstossen. Neue
 *    Tresore nutzen ihn, bestehende stellt PinVault.js beim naechsten PIN-
 *    Entsperren um (neu wickeln, zuruecklesen, pruefen, erst bei einem spaeteren
 *    Entsperren den alten Schluessel loeschen). deriveKeys rechnet Argon2id nur
 *    EINMAL und den HMAC mit jedem genannten Schluessel (Notfall-PIN-Pruefwert
 *    kann waehrend der Umstellung noch am alten haengen).
 *  - Nur in Debug-Builds: Dauer von Argon2id und Chip-HMAC im Logcat
 *    ("MalachiPinKey: Zeit ...") - zum Messen am Geraet, nie in Release.
 *
 * JS: NativeModules.MalachiPinKey.{createKey, hasKey, deriveKey, destroyKey,
 *     createKeyAlias, deriveKeys, hasKeyAlias, deleteKeyAlias,
 *     bioAvailable, bioEnroll, bioUnwrap, bioRemove}
 */
class MalachiPinKeyModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiPinKey"
        const val ALIAS = "malachi_pin_v1"
        const val ALIAS_V2 = "malachi_pin_v2"
        // Nur diese Schluessel darf JS anlegen/benutzen/loeschen (nie z.B. die
        // des Siegel-Tresors oder der Lizenz).
        private val PIN_ALIASES = setOf(ALIAS, ALIAS_V2)
        const val BIO_ALIAS = "malachi_pin_bio_v1"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val MIN_MEM_KIB = 8 * 1024
        private const val MAX_MEM_KIB = 256 * 1024
        private const val MAX_ITERATIONS = 10
        private val LOCK = Any()
    }

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "malachi-pinkey").apply { isDaemon = true } }

    override fun getName() = "MalachiPinKey"

    // ─── PIN ────────────────────────────────────────────────────────────────

    /** Erzeugt den Geraeteschluessel neu (ein vorhandener wird ersetzt). -> "strongbox"|"tee"|"software"|"unbekannt" */
    @ReactMethod
    fun createKey(promise: Promise) {
        executor.execute {
            try {
                val level = synchronized(LOCK) {
                    val ks = keyStore()
                    if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
                    generateHmac(ALIAS, false)
                    securityLevel(ALIAS)
                }
                promise.resolve(level)
            } catch (e: Throwable) {
                Log.w(TAG, "PIN-Schluessel nicht erzeugbar: ${e.javaClass.simpleName}")
                promise.reject("PIN_KEY", "PIN-Schluessel nicht erzeugbar", e)
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
    fun deriveKey(pin: String, saltB64: String, memKiB: Int, iterations: Int, promise: Promise) {
        executor.execute {
            var pw: ByteArray? = null
            try {
                if (memKiB < MIN_MEM_KIB || memKiB > MAX_MEM_KIB || iterations < 1 || iterations > MAX_ITERATIONS) throw IllegalArgumentException("Parameter")
                val salt = Base64.decode(saltB64, Base64.NO_WRAP)
                if (salt.size < 16) throw IllegalArgumentException("Salz")
                val key = synchronized(LOCK) { keyStore().getKey(ALIAS, null) as? SecretKey }
                if (key == null) { promise.reject("PIN_NO_KEY", "PIN-Schluessel fehlt"); return@execute }
                pw = argon2id(pin, salt, memKiB, iterations)
                val mac = Mac.getInstance("HmacSHA256")
                mac.init(key)
                val out = mac.doFinal(pw)
                promise.resolve(Base64.encodeToString(out, Base64.NO_WRAP))
                out.fill(0)
            } catch (e: Throwable) {
                Log.w(TAG, "PIN-Schluessel nicht ableitbar: ${e.javaClass.simpleName}")
                promise.reject("PIN_DERIVE", "PIN-Schluessel nicht ableitbar", e)
            } finally {
                pw?.fill(0)
            }
        }
    }

    // ─── Mehrere PIN-Schluessel (V3) ───────────────────────────────────────

    /**
     * Erzeugt den PIN-Schluessel alias neu (ein vorhandener wird ersetzt).
     * unlockedRequired: setUnlockedDeviceRequired(true) ab Android 9; scheitert
     * das auf einem Geraet, wird ohne das Merkmal erzeugt (und gemeldet).
     * -> { level, unlockedRequired }
     */
    @ReactMethod
    fun createKeyAlias(alias: String, unlockedRequired: Boolean, promise: Promise) {
        if (alias !in PIN_ALIASES) { promise.reject("PIN_ALIAS", "Unbekannter Schluessel"); return }
        executor.execute {
            try {
                val res = synchronized(LOCK) {
                    val ks = keyStore()
                    if (ks.containsAlias(alias)) ks.deleteEntry(alias)
                    val applied = generateHmac(alias, unlockedRequired)
                    Arguments.createMap().apply {
                        putString("level", securityLevel(alias))
                        putBoolean("unlockedRequired", applied)
                    }
                }
                promise.resolve(res)
            } catch (e: Throwable) {
                Log.w(TAG, "PIN-Schluessel nicht erzeugbar: ${e.javaClass.simpleName}")
                promise.reject("PIN_KEY", "PIN-Schluessel nicht erzeugbar", e)
            }
        }
    }

    @ReactMethod
    fun hasKeyAlias(alias: String, promise: Promise) {
        if (alias !in PIN_ALIASES) { promise.resolve(false); return }
        executor.execute {
            try { promise.resolve(keyStore().containsAlias(alias)) } catch (e: Throwable) { promise.resolve(false) }
        }
    }

    @ReactMethod
    fun deleteKeyAlias(alias: String, promise: Promise) {
        if (alias !in PIN_ALIASES) { promise.reject("PIN_ALIAS", "Unbekannter Schluessel"); return }
        executor.execute {
            try {
                synchronized(LOCK) { keyStore().let { if (it.containsAlias(alias)) it.deleteEntry(alias) } }
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("PIN_KEY", "PIN-Schluessel nicht loeschbar", e)
            }
        }
    }

    /**
     * Argon2id EINMAL, danach HMAC mit jedem genannten Schluessel.
     * -> Array (gleiche Reihenfolge) aus Base64 oder null (Schluessel fehlt bzw.
     * nicht nutzbar - z.B. Geraet gesperrt bei setUnlockedDeviceRequired).
     */
    @ReactMethod
    fun deriveKeys(pin: String, saltB64: String, memKiB: Int, iterations: Int, aliases: ReadableArray, promise: Promise) {
        executor.execute {
            var pw: ByteArray? = null
            try {
                if (memKiB < MIN_MEM_KIB || memKiB > MAX_MEM_KIB || iterations < 1 || iterations > MAX_ITERATIONS) throw IllegalArgumentException("Parameter")
                if (aliases.size() < 1 || aliases.size() > 4) throw IllegalArgumentException("Schluessel")
                val names = (0 until aliases.size()).map { aliases.getString(it) ?: "" }
                if (names.any { it !in PIN_ALIASES }) throw IllegalArgumentException("Schluessel")
                val salt = Base64.decode(saltB64, Base64.NO_WRAP)
                if (salt.size < 16) throw IllegalArgumentException("Salz")
                val t0 = System.nanoTime()
                pw = argon2id(pin, salt, memKiB, iterations)
                val t1 = System.nanoTime()
                val out = Arguments.createArray()
                for (name in names) {
                    val key = try { synchronized(LOCK) { keyStore().getKey(name, null) as? SecretKey } } catch (e: Throwable) { null }
                    if (key == null) { out.pushNull(); continue }
                    try {
                        val mac = Mac.getInstance("HmacSHA256")
                        mac.init(key)
                        val r = mac.doFinal(pw)
                        out.pushString(Base64.encodeToString(r, Base64.NO_WRAP))
                        r.fill(0)
                    } catch (e: Throwable) {
                        Log.w(TAG, "PIN-Schluessel nicht nutzbar: ${e.javaClass.simpleName}")
                        out.pushNull()
                    }
                }
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, "Zeit: Argon2id ${(t1 - t0) / 1_000_000} ms, Chip-HMAC x${names.size} ${(System.nanoTime() - t1) / 1_000_000} ms")
                }
                promise.resolve(out)
            } catch (e: Throwable) {
                Log.w(TAG, "PIN-Schluessel nicht ableitbar: ${e.javaClass.simpleName}")
                promise.reject("PIN_DERIVE", "PIN-Schluessel nicht ableitbar", e)
            } finally {
                pw?.fill(0)
            }
        }
    }

    /** Vernichtet PIN- und Fingerabdruck-Schluessel (Loeschen, Notfall-PIN). */
    @ReactMethod
    fun destroyKey(promise: Promise) {
        executor.execute {
            try {
                synchronized(LOCK) {
                    val ks = keyStore()
                    if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
                    if (ks.containsAlias(ALIAS_V2)) ks.deleteEntry(ALIAS_V2)
                    if (ks.containsAlias(BIO_ALIAS)) ks.deleteEntry(BIO_ALIAS)
                }
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("PIN_KEY", "PIN-Schluessel nicht loeschbar", e)
            }
        }
    }

    // ─── Fingerabdruck ──────────────────────────────────────────────────────

    @ReactMethod
    fun bioAvailable(promise: Promise) {
        try {
            val r = BiometricManager.from(reactApplicationContext).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            promise.resolve(r == BiometricManager.BIOMETRIC_SUCCESS)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /**
     * Verschluesselt den (Base64-)Tresorschluessel mit einem neuen
     * Fingerabdruck-Schluessel - erst nach Bestaetigung im Systemdialog.
     * -> { iv, ct } (Base64)
     */
    @ReactMethod
    fun bioEnroll(secretB64: String, title: String, subtitle: String, cancel: String, promise: Promise) {
        val activity = reactApplicationContext.currentActivity as? FragmentActivity
        if (activity == null) { promise.reject("BIO_NO_ACTIVITY", "Kein Fenster"); return }
        val cipher = try {
            synchronized(LOCK) {
                val ks = keyStore()
                if (ks.containsAlias(BIO_ALIAS)) ks.deleteEntry(BIO_ALIAS)
                generateBioKey()
                val key = ks.getKey(BIO_ALIAS, null) as SecretKey
                Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Fingerabdruck-Schluessel nicht erzeugbar: ${e.javaClass.simpleName}")
            promise.reject("BIO_KEY", "Fingerabdruck-Schluessel nicht erzeugbar", e)
            return
        }
        authenticate(activity, cipher, title, subtitle, cancel, promise) { c ->
            val secret = Base64.decode(secretB64, Base64.NO_WRAP)
            try {
                val ct = c.doFinal(secret)
                Arguments.createMap().apply {
                    putString("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
                    putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                }
            } finally {
                secret.fill(0)
            }
        }
    }

    /** Entschluesselt die Kopie des Tresorschluessels nach Fingerabdruck. -> Base64 */
    @ReactMethod
    fun bioUnwrap(ivB64: String, ctB64: String, title: String, subtitle: String, cancel: String, promise: Promise) {
        val activity = reactApplicationContext.currentActivity as? FragmentActivity
        if (activity == null) { promise.reject("BIO_NO_ACTIVITY", "Kein Fenster"); return }
        val cipher = try {
            synchronized(LOCK) {
                val key = keyStore().getKey(BIO_ALIAS, null) as? SecretKey
                if (key == null) { promise.reject("BIO_NO_KEY", "Kein Fingerabdruck-Schluessel"); return }
                Cipher.getInstance("AES/GCM/NoPadding").apply {
                    init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(ivB64, Base64.NO_WRAP)))
                }
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            // Neuer Fingerabdruck im System hinzugefuegt - Schluessel ist weg.
            try { synchronized(LOCK) { keyStore().deleteEntry(BIO_ALIAS) } } catch (_: Throwable) {}
            promise.reject("BIO_INVALIDATED", "Fingerabdruck-Schluessel ungueltig")
            return
        } catch (e: Throwable) {
            Log.w(TAG, "Fingerabdruck-Schluessel nicht nutzbar: ${e.javaClass.simpleName}")
            promise.reject("BIO_KEY", "Fingerabdruck-Schluessel nicht nutzbar", e)
            return
        }
        authenticate(activity, cipher, title, subtitle, cancel, promise) { c ->
            val plain = c.doFinal(Base64.decode(ctB64, Base64.NO_WRAP))
            try { Base64.encodeToString(plain, Base64.NO_WRAP) } finally { plain.fill(0) }
        }
    }

    @ReactMethod
    fun bioRemove(promise: Promise) {
        executor.execute {
            try {
                synchronized(LOCK) { keyStore().let { if (it.containsAlias(BIO_ALIAS)) it.deleteEntry(BIO_ALIAS) } }
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.resolve(false)
            }
        }
    }

    private fun authenticate(
        activity: FragmentActivity,
        cipher: Cipher,
        title: String,
        subtitle: String,
        cancel: String,
        promise: Promise,
        onSuccess: (Cipher) -> Any,
    ) {
        UiThreadUtil.runOnUiThread {
            try {
                val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val c = result.cryptoObject?.cipher
                        if (c == null) { promise.reject("BIO_FAIL", "Kein Schluessel"); return }
                        executor.execute {
                            try { promise.resolve(onSuccess(c)) } catch (e: Throwable) {
                                Log.w(TAG, "Fingerabdruck-Operation fehlgeschlagen: ${e.javaClass.simpleName}")
                                promise.reject("BIO_FAIL", "Fingerabdruck-Operation fehlgeschlagen", e)
                            }
                        }
                    }
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                            errorCode == BiometricPrompt.ERROR_CANCELED
                        promise.reject(if (cancelled) "BIO_CANCEL" else "BIO_ERROR", errString.toString())
                    }
                })
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .apply { if (subtitle.isNotEmpty()) setSubtitle(subtitle) }
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setConfirmationRequired(false)
                    .build()
                prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
            } catch (e: Throwable) {
                Log.w(TAG, "Fingerabdruck-Dialog nicht startbar: ${e.javaClass.simpleName}")
                promise.reject("BIO_ERROR", "Fingerabdruck-Dialog nicht startbar", e)
            }
        }
    }

    // ─── Hilfen ─────────────────────────────────────────────────────────────

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun hasStrongBox(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
        reactApplicationContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    /**
     * HMAC-Schluessel im Keystore (StrongBox, sonst TEE). unlockedRequired:
     * setUnlockedDeviceRequired(true) ab Android 9 - wird es auf einem Geraet
     * nicht angenommen, wird ohne erzeugt. -> ob das Merkmal gesetzt ist.
     */
    private fun generateHmac(alias: String, unlockedRequired: Boolean): Boolean {
        val canUnlocked = unlockedRequired && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        fun spec(strongBox: Boolean, unlocked: Boolean): KeyGenParameterSpec {
            val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
            if (unlocked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setUnlockedDeviceRequired(true)
            return b.build()
        }
        fun tryGenerate(strongBox: Boolean, unlocked: Boolean): Boolean = try {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE).apply {
                init(spec(strongBox, unlocked))
                generateKey()
            }
            true
        } catch (e: Throwable) {
            Log.i(TAG, "Schluessel nicht erzeugbar (StrongBox=$strongBox, entsperrt=$unlocked, ${e.javaClass.simpleName})")
            try { keyStore().let { if (it.containsAlias(alias)) it.deleteEntry(alias) } } catch (_: Throwable) {}
            false
        }
        val order = buildList {
            if (hasStrongBox()) { if (canUnlocked) add(true to true); add(true to false) }
            if (canUnlocked) add(false to true)
            add(false to false)
        }
        for ((strongBox, unlocked) in order) {
            if (tryGenerate(strongBox, unlocked)) return unlocked
        }
        throw IllegalStateException("Kein PIN-Schluessel erzeugbar")
    }

    private fun generateBioKey() {
        val b = KeyGenParameterSpec.Builder(BIO_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        }
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply {
            init(b.build())
            generateKey()
        }
    }

    private fun securityLevel(alias: String): String = try {
        val key = keyStore().getKey(alias, null) as SecretKey
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

    /** Argon2id (RFC 9106) aus BouncyCastle - speicherhart. */
    private fun argon2id(pin: String, salt: ByteArray, memKiB: Int, iterations: Int): ByteArray {
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withMemoryAsKB(memKiB)
            .withIterations(iterations)
            .withParallelism(1)
            .build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val chars = pin.toCharArray()
        val out = ByteArray(32)
        try { gen.generateBytes(chars, out) } finally { chars.fill('\u0000') }
        return out
    }
}
