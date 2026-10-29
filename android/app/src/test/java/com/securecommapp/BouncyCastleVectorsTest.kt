package com.securecommapp

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.MLKEMKeyPairGenerator
import org.bouncycastle.crypto.kems.MLKEMExtractor
import org.bouncycastle.crypto.kems.MLKEMGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.MLKEMKeyGenerationParameters
import org.bouncycastle.crypto.params.MLKEMParameters
import org.bouncycastle.crypto.params.MLKEMPrivateKeyParameters
import org.bouncycastle.crypto.params.MLKEMPublicKeyParameters
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Testvektoren fuer BouncyCastle (Krypto-Review V8, Update 1.80 -> 1.86).
 *
 * Warum: Geraete mit unterschiedlichen App-Versionen muessen dieselben Bytes
 * rechnen - sonst brechen bestehende PIN-/Siegel-Tresore (Argon2id), die
 * Telefon-Kopplung alt<->neu (Argon2id-Treffpunkt) oder gespeicherte
 * ML-KEM-Schluessel. Alle Sollwerte stammen aus zwei unabhaengigen Quellen
 * und wurden am 25.10.2026 gegen BouncyCastle 1.80 nachgerechnet (identisch):
 *  - ML-KEM-768: @noble/post-quantum (dieselbe Bibliothek wie der Web-Client),
 *    deterministisch ueber Seed d|z und Nachricht m (FIPS 203 *_internal).
 *  - Argon2id: RFC 9106 Abschnitt 5.3 sowie Node (crypto.argon2Sync) und
 *    @noble/hashes fuer die App-Parameter.
 * Die Builder-Ketten entsprechen MalachiPinKeyModule / MalachiSiegelKeyModule
 * (char[]-Passwort, UTF-8) bzw. MalachiTorModule (Bytes).
 *
 * Bei JEDEM BouncyCastle-Update laufen lassen: ./gradlew :app:testWebDebugUnitTest
 */
class BouncyCastleVectorsTest {

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun sha(b: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(b))
    private fun seq(n: Int, start: Int) = ByteArray(n) { (start + it).toByte() }
    private fun fill(n: Int, v: Int) = ByteArray(n) { v.toByte() }

    private val p768 = MLKEMParameters.ml_kem_768

    // ── ML-KEM-768 ──────────────────────────────────────────────────────

    private val seed = seq(64, 0)          // d = 00..1f, z = 20..3f
    private val msg = seq(32, 0xa0)        // m fuer das deterministische Kapseln
    private val pkSha = "0b7934c83125c788995e2ba6bd761e33046b3e40571be53e023309a29f398cc9"
    private val skSha = "dac268bde6a8dd238e9887117d6b664e7a7a9350ad6b7c08a948e504809572a5"
    private val ctSha = "a86a10e3529994dd5ebd846b42716c8bc35f71edbbb72b43a0f6c7e1870777bc"
    private val ssHex = "d4ab9572cd7c68df84854e27a7ddbfc54f89c74cd96d93fa1db660275420153b"
    // Implizite Ablehnung (Chiffrat Bit 0 gekippt): J(z|c') - wie @noble und 1.80.
    private val ssBadHex = "7146a38f2b0631a5ddc8b1730d8f8600a968637d36e98ada7fadda07639afee4"

    @Test
    fun mlkem768_schluessel_aus_seed_wie_noble() {
        val sk = MLKEMPrivateKeyParameters(p768, seed)
        assertEquals(1184, sk.publicKey.size)
        assertEquals(2400, sk.encoded.size)
        assertEquals(pkSha, sha(sk.publicKey))
        assertEquals(skSha, sha(sk.encoded))
    }

    @Test
    fun mlkem768_kapseln_und_entkapseln_wie_noble() {
        val sk = MLKEMPrivateKeyParameters(p768, seed)
        val pk = MLKEMPublicKeyParameters(p768, sk.publicKey)
        val enc = MLKEMGenerator.internalGenerateEncapsulated(pk, msg)
        assertEquals(1088, enc.encapsulation.size)
        assertEquals(ctSha, sha(enc.encapsulation))
        assertEquals(ssHex, hex(enc.secret))
        // Gespeichertes Format aus 1.0/1.1 (2400 Byte, ohne Seed) wie in KyberModule.decapsulate:
        val stored = MLKEMPrivateKeyParameters(p768, sk.encoded)
        assertEquals(ssHex, hex(MLKEMExtractor(stored).extractSecret(enc.encapsulation)))
        val bad = enc.encapsulation.clone()
        bad[0] = (bad[0].toInt() xor 1).toByte()
        assertEquals(ssBadHex, hex(MLKEMExtractor(stored).extractSecret(bad)))
    }

    @Test
    fun mlkem768_zufaellig_rundlauf_wie_kybermodule() {
        val random = SecureRandom()
        val gen = MLKEMKeyPairGenerator()
        gen.init(MLKEMKeyGenerationParameters(random, p768))
        val kp = gen.generateKeyPair()
        val pub = (kp.public as MLKEMPublicKeyParameters).encoded
        val priv = (kp.private as MLKEMPrivateKeyParameters).encoded
        val enc = MLKEMGenerator(random).generateEncapsulated(MLKEMPublicKeyParameters(p768, pub))
        val ss = MLKEMExtractor(MLKEMPrivateKeyParameters(p768, priv)).extractSecret(enc.encapsulation)
        assertArrayEquals(enc.secret, ss)
        assertEquals(32, ss.size)
    }

    @Test
    fun mlkem768_beschaedigter_schluessel_und_falsche_laengen_scheitern() {
        val sk = MLKEMPrivateKeyParameters(p768, seed).encoded
        // H(ek) liegt bei Offset 2336..2367 - Pruefung nach FIPS 203 7.3.
        val broken = sk.clone()
        broken[2340] = (broken[2340].toInt() xor 0x55).toByte()
        expectIllegalArgument { MLKEMPrivateKeyParameters(p768, broken) }
        expectIllegalArgument { MLKEMPrivateKeyParameters(p768, sk.copyOf(2399)) }
        val stored = MLKEMPrivateKeyParameters(p768, sk)
        expectIllegalArgument { MLKEMExtractor(stored).extractSecret(ByteArray(1087)) }
        // Oeffentlicher Schluessel ausserhalb des Modulus (FIPS 203 7.2): abgelehnt.
        val pk = MLKEMPrivateKeyParameters(p768, seed).publicKey
        pk[0] = 0xff.toByte(); pk[1] = 0xff.toByte()
        expectIllegalArgument { MLKEMPublicKeyParameters(p768, pk) }
    }

    @Test
    fun mlkem768_destroy_loescht_schluessel() {
        val sk = MLKEMPrivateKeyParameters(p768, seed)
        assertFalse(sk.isDestroyed)
        sk.destroy()
        assertTrue(sk.isDestroyed)
        try {
            sk.encoded
            fail("zerstoerter Schluessel darf nicht mehr lesbar sein")
        } catch (e: IllegalStateException) { /* erwartet */ }
    }

    private fun expectIllegalArgument(block: () -> Unit) {
        try {
            block()
            fail("IllegalArgumentException erwartet")
        } catch (e: IllegalArgumentException) { /* erwartet */ }
    }

    // ── Argon2id ────────────────────────────────────────────────────────

    private fun argon2id(
        pwChars: CharArray?, pwBytes: ByteArray?, salt: ByteArray, memKiB: Int,
        iterations: Int, lanes: Int, outLen: Int,
        secret: ByteArray? = null, ad: ByteArray? = null
    ): ByteArray {
        val b = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withMemoryAsKB(memKiB)
            .withIterations(iterations)
            .withParallelism(lanes)
        if (secret != null) b.withSecret(secret)
        if (ad != null) b.withAdditional(ad)
        val gen = Argon2BytesGenerator()
        gen.init(b.build())
        val out = ByteArray(outLen)
        if (pwChars != null) gen.generateBytes(pwChars, out) else gen.generateBytes(pwBytes!!, out)
        return out
    }

    @Test
    fun argon2id_rfc9106() {
        val out = argon2id(null, fill(32, 1), fill(16, 2), 32, 3, 4, 32, fill(8, 3), fill(12, 4))
        assertEquals("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659", hex(out))
    }

    @Test
    fun argon2id_pin_tresor_parameter() {
        // PinVault.KDF: 32 MiB, t=3, p=1; PIN als char[] wie MalachiPinKeyModule.argon2.
        val out = argon2id("1234".toCharArray(), null, seq(16, 0x10), 32 * 1024, 3, 1, 32)
        assertEquals("d6159ccb660b4ebe45d3435328b473233d2771e331e87b8244df92155b1d02e3", hex(out))
    }

    @Test
    fun argon2id_siegel_tresor_parameter_mit_umlauten() {
        // SiegelVault.KDF: 32 MiB, t=3, p=1; Passphrase mit Nicht-ASCII (UTF-8-Umwandlung).
        val out = argon2id("Korrekte Pferdebatterie ÄÖÜß €".toCharArray(), null,
            seq(16, 0x40), 32 * 1024, 3, 1, 32)
        assertEquals("ec3ae41c7e5ed7615b0ff148ce451e7588501f880af3eace5a93b817cbb7e012", hex(out))
    }

    @Test
    fun argon2id_telefon_kopplung_parameter() {
        // PhonePairing.PHONE_KDF: 64 MiB, t=3, p=1, Bytes wie MalachiTorModule.argon2id.
        val salt = MessageDigest.getInstance("SHA-256")
            .digest("malachi-phone-rendezvous-v1|bucket|493000".toByteArray(Charsets.UTF_8))
        val out = argon2id(null, seq(48, 0x70), salt, 64 * 1024, 3, 1, 32)
        assertEquals("22c6a12fab307f3c615395a841651b860ea3c576dbf8ca8a1cd5043a46219d69", hex(out))
    }
}
