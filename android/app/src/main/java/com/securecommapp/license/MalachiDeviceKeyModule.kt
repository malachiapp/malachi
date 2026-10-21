package com.securecommapp.license

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executors

/**
 * Geraetebindung der Vollversion (Gegenstueck: LicenseManager.js, Spezifikation
 * shop/LIZENZ_FORMAT.md Abschnitt 3).
 *
 *  - EC-P-256-Schluesselpaar im AndroidKeyStore unter dem festen Alias
 *    "malachi_geraet_v1", einmal pro Installation erzeugt. Der private
 *    Schluessel ist nicht exportierbar und wird fuer die Lizenzpruefung nicht
 *    benutzt - er existiert nur, damit der oeffentliche Schluessel (und damit
 *    der Geraetecode) an DIESE Installation gebunden ist.
 *  - Wenn vorhanden in StrongBox (eigener Sicherheitschip), sonst in der TEE.
 *  - Keystore-Schluessel werden von Backups/Geraeteumzuegen nicht mitkopiert
 *    und bei Deinstallation bzw. "Daten loeschen" entfernt - gewollt: eine
 *    kopierte App-Sicherung samt Lizenz wird auf einem anderen Geraet nicht
 *    gueltig. Der Umzug laeuft ueber Bestellnummer + Wiederherstellungscode.
 *
 * JS: NativeModules.MalachiDeviceKey.getOrCreatePublicKey()
 *   -> { spki: base64(SubjectPublicKeyInfo-DER, 91 Byte), security: "strongbox"|"tee"|"software"|"unbekannt" }
 * Den Geraetecode berechnet JS daraus (LicenseFormat.geraetecodeAusSpki).
 */
class MalachiDeviceKeyModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiGeraet"
        const val ALIAS = "malachi_geraet_v1"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val SPKI_LENGTH = 91
        // SEQUENCE { SEQUENCE { ecPublicKey, prime256v1 }, BIT STRING ... } - danach 0x04 || X || Y
        private val SPKI_P256_PREFIX = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200")
        // Prozessweit EIN Erzeuger - zwei gleichzeitige Aufrufe duerfen nie zwei Schluessel anlegen.
        private val LOCK = Any()

        private fun hexToBytes(hex: String): ByteArray =
            ByteArray(hex.length / 2) { i -> hex.substring(2 * i, 2 * i + 2).toInt(16).toByte() }
    }

    // Keystore-Zugriffe koennen (v. a. mit StrongBox) Hunderte Millisekunden
    // dauern - nie auf dem JS- oder UI-Thread.
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "malachi-geraet").apply { isDaemon = true } }

    override fun getName() = "MalachiDeviceKey"

    @ReactMethod
    fun getOrCreatePublicKey(promise: Promise) {
        executor.execute {
            try {
                val (spki, level) = synchronized(LOCK) { loadOrCreate() }
                promise.resolve(Arguments.createMap().apply {
                    putString("spki", Base64.encodeToString(spki, Base64.NO_WRAP))
                    putString("security", level)
                })
            } catch (e: Exception) {
                // Keine Schluesseldaten ins Log - nur die Fehlerart.
                Log.w(TAG, "Geraeteschluessel nicht verfuegbar: ${e.javaClass.simpleName}")
                promise.reject("DEVICE_KEY", "Geraeteschluessel nicht verfuegbar", e)
            }
        }
    }

    private fun loadOrCreate(): Pair<ByteArray, String> {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        if (ks.containsAlias(ALIAS)) {
            val spki = ks.getCertificate(ALIAS)?.publicKey?.encoded
            if (spki != null && isP256Spki(spki)) return Pair(spki, securityLevel(ks))
            // Kaputter Eintrag (kein Zertifikat/fremdes Format): neu anlegen. Der
            // Geraetecode aendert sich dadurch - die Lizenz laesst sich mit dem
            // Wiederherstellungscode wieder umziehen.
            Log.w(TAG, "Geraeteschluessel unbrauchbar - wird neu erzeugt")
            ks.deleteEntry(ALIAS)
        }
        generate()
        val fresh = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val spki = fresh.getCertificate(ALIAS)?.publicKey?.encoded
            ?: throw IllegalStateException("Kein Zertifikat zum Geraeteschluessel")
        if (!isP256Spki(spki)) throw IllegalStateException("Unerwartetes Schluesselformat")
        return Pair(spki, securityLevel(fresh))
    }

    private fun spec(strongBox: Boolean): KeyGenParameterSpec {
        val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
        // Keine Nutzer-Authentifizierung: der Schluessel wird nie zum Signieren
        // benutzt, nur sein oeffentlicher Teil gelesen.
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
        return b.build()
    }

    private fun generate() {
        val wantStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            reactApplicationContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        if (wantStrongBox) {
            try {
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
                    initialize(spec(strongBox = true))
                    generateKeyPair()
                }
                return
            } catch (e: Exception) {
                // StrongBoxUnavailableException (API 28+) bzw. ProviderException bei
                // Chips, die P-256 nicht anbieten - auf die TEE ausweichen. Die
                // Klasse wird hier bewusst nicht direkt referenziert (minSdk 24).
                Log.i(TAG, "StrongBox nicht nutzbar (${e.javaClass.simpleName}) - TEE")
                try {
                    KeyStore.getInstance(KEYSTORE).apply { load(null) }.let { if (it.containsAlias(ALIAS)) it.deleteEntry(ALIAS) }
                } catch (_: Exception) {}
            }
        }
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
            initialize(spec(strongBox = false))
            generateKeyPair()
        }
    }

    private fun isP256Spki(spki: ByteArray): Boolean {
        if (spki.size != SPKI_LENGTH) return false
        for (i in SPKI_P256_PREFIX.indices) if (spki[i] != SPKI_P256_PREFIX[i]) return false
        return spki[SPKI_P256_PREFIX.size] == 0x04.toByte()
    }

    /** Nur zur Anzeige: wo liegt der Schluessel? */
    private fun securityLevel(ks: KeyStore): String {
        return try {
            val key = ks.getKey(ALIAS, null) as? PrivateKey ?: return "unbekannt"
            val info = KeyFactory.getInstance(key.algorithm, KEYSTORE).getKeySpec(key, KeyInfo::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (info.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
                    KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
                    else -> "unbekannt"
                }
            } else {
                // Vor Android 12 gibt es nur diese (seit API 31 veraltete) Angabe.
                if (info.isInsideSecureHardware) "tee" else "software"
            }
        } catch (_: Exception) {
            "unbekannt"
        }
    }

    override fun invalidate() {
        executor.shutdown()
        super.invalidate()
    }
}
