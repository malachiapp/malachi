package com.securecommapp.net

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

/**
 * NAT-PMP (RFC 6886) - Vorgaenger von PCP. Manche Router sprechen nur dieses
 * Protokoll (u. a. aeltere Apple-Basisstationen, viele OpenWrt-/pfSense-/
 * miniupnpd-Installationen). Fallback in MalachiPcpModule, wenn PCP schweigt.
 *
 *  - Nur IPv4, ausschliesslich an das Standard-Gateway (UDP 5351) - nie ins
 *    Internet. Antworten zaehlen nur, wenn sie vom Gateway kommen (RFC 6886
 *    3.1); alles andere wird verworfen.
 *  - Interner Client einer Weiterleitung ist laut Protokoll der Absender der
 *    Anfrage - deshalb wird von der Kandidaten-Adresse aus gesendet.
 *  - Jede Anfrage wird hoechstens zweimal gesendet (250 + 500 ms; RFC 6886:
 *    erste Wiederholung nach 250 ms, dann verdoppeln) - zusammen unter 1 s.
 *  - Laeuft nur auf dem Hintergrund-Thread des Moduls.
 */
internal object NatPmp {
    private const val PORT = 5351
    private val ATTEMPT_WAIT_MS = longArrayOf(250L, 500L)

    /** Ergebniscode: keine (passende) Antwort - der Router spricht kein NAT-PMP. */
    const val NO_ANSWER = -1

    private val RESULT_NAMES = mapOf(
        0 to "SUCCESS", 1 to "UNSUPP_VERSION", 2 to "NOT_AUTHORIZED",
        3 to "NETWORK_FAILURE", 4 to "NO_RESOURCES", 5 to "UNSUPP_OPCODE"
    )

    fun resultName(code: Int): String =
        if (code == NO_ANSWER) "TIMEOUT" else RESULT_NAMES[code] ?: "NATPMP_$code"

    class Result(
        val code: Int,
        val externalAddress: String? = null,
        val externalPort: Int = 0,
        val lifetime: Int = 0
    )

    /** Oeffentliche IPv4-Adresse des Routers (Opcode 0). */
    fun externalAddress(local: Inet4Address, gateway: Inet4Address): Result {
        val resp = exchange(local, gateway, byteArrayOf(0, 0), 128, 12) ?: return Result(NO_ANSWER)
        val code = u16(resp, 2)
        if (code != 0) return Result(code)
        val ext = InetAddress.getByAddress(resp.copyOfRange(8, 12)).hostAddress
        return Result(0, externalAddress = ext)
    }

    /**
     * Weiterleitung anlegen/erneuern (lifetimeSec > 0) oder loeschen (0).
     * Opcode 1 = UDP, 2 = TCP.
     */
    fun map(
        local: Inet4Address,
        gateway: Inet4Address,
        tcp: Boolean,
        internalPort: Int,
        suggestedExternalPort: Int,
        lifetimeSec: Int
    ): Result {
        val op = if (tcp) 2 else 1
        val req = ByteArray(12)
        req[0] = 0
        req[1] = op.toByte()
        putU16(req, 4, internalPort)
        putU16(req, 6, if (lifetimeSec <= 0) 0 else suggestedExternalPort)
        putU32(req, 8, if (lifetimeSec <= 0) 0 else lifetimeSec)
        val resp = exchange(local, gateway, req, 128 + op, 16) ?: return Result(NO_ANSWER)
        val code = u16(resp, 2)
        if (code != 0) return Result(code)
        if (u16(resp, 8) != internalPort) return Result(NO_ANSWER)
        return Result(0, externalPort = u16(resp, 10), lifetime = u32(resp, 12))
    }

    private fun exchange(
        local: Inet4Address,
        gateway: Inet4Address,
        req: ByteArray,
        expectedOp: Int,
        minLen: Int
    ): ByteArray? {
        DatagramSocket(InetSocketAddress(local, 0)).use { sock ->
            val buf = ByteArray(64)
            for (waitMs in ATTEMPT_WAIT_MS) {
                sock.send(DatagramPacket(req, req.size, InetSocketAddress(gateway, PORT)))
                val deadline = System.currentTimeMillis() + waitMs
                while (true) {
                    val left = deadline - System.currentTimeMillis()
                    if (left <= 0L) break
                    sock.soTimeout = left.toInt()
                    val p = DatagramPacket(buf, buf.size)
                    try {
                        sock.receive(p)
                    } catch (e: SocketTimeoutException) {
                        break
                    }
                    if (p.address != gateway) continue
                    if (p.length < minLen) continue
                    if (buf[0].toInt() != 0 || (buf[1].toInt() and 0xff) != expectedOp) continue
                    return buf.copyOf(p.length)
                }
            }
        }
        return null
    }

    private fun u16(b: ByteArray, off: Int): Int =
        ((b[off].toInt() and 0xff) shl 8) or (b[off + 1].toInt() and 0xff)

    private fun u32(b: ByteArray, off: Int): Int = (u16(b, off) shl 16) or u16(b, off + 2)

    private fun putU16(b: ByteArray, off: Int, v: Int) {
        b[off] = (v ushr 8).toByte()
        b[off + 1] = v.toByte()
    }

    private fun putU32(b: ByteArray, off: Int, v: Int) {
        putU16(b, off, v ushr 16)
        putU16(b, off + 2, v and 0xffff)
    }
}
