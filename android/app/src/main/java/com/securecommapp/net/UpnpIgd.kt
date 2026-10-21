package com.securecommapp.net

import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.Proxy
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL

/**
 * UPnP-IGD (Internet Gateway Device): Portfreigabe ueber die UPnP-Schnittstelle
 * des Heimrouters - fuer Router ohne PCP/NAT-PMP (viele Provider-Router).
 * Fallback in MalachiPcpModule, nur IPv4.
 *
 * Nur im eigenen Netz, nur zum Gateway:
 *  - Suche (SSDP, M-SEARCH) als Multicast mit TTL 1 (verlaesst das lokale Netz
 *    nicht) plus Unicast direkt an das Gateway. Antworten zaehlen nur, wenn
 *    sie vom Gateway selbst kommen.
 *  - Beschreibung (HTTP GET) und Steuerung (SOAP) gehen nur an
 *    http://<Gateway-IPv4>:<Port>/... - zeigt eine Antwort (LOCATION, URLBase,
 *    controlURL) auf eine andere Adresse, wird sie verworfen.
 *  - Eigener kleiner HTTP-Client ueber einen direkten Socket: kein Proxy,
 *    keine Weiterleitungen, Antwort hoechstens 64 KB, jede Anfrage inkl.
 *    Verbindungsaufbau unter 1 s. (Die Android-Klartext-Sperre fuer HTTP
 *    gilt fuer HttpURLConnection - sie bleibt fuer den Rest der App aktiv.)
 *  - Keine dauerhaften Freigaben: nur mit Ablaufzeit (Lease). Router, die nur
 *    dauerhafte kennen (Fehler 725), werden nicht genutzt - eine vergessene
 *    dauerhafte Freigabe koennte spaeter einen fremden Dienst freilegen.
 *  - Laeuft nur auf dem Hintergrund-Thread des Moduls.
 */
internal object UpnpIgd {
    private const val SSDP_PORT = 1900
    private const val SSDP_ADDR = "239.255.255.250"
    private const val SSDP_WAIT_MS = 900L
    private const val CONNECT_TIMEOUT_MS = 400
    private const val REQUEST_DEADLINE_MS = 900L
    private const val MAX_RESPONSE_BYTES = 64 * 1024
    // Neutral - erscheint in der Freigabeliste des Routers.
    private const val DESCRIPTION = "WebRTC"

    private val SEARCH_TARGETS = listOf(
        "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "urn:schemas-upnp-org:device:InternetGatewayDevice:2"
    )
    private val SERVICE_RE = Regex("<service>(.*?)</service>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val SERVICE_TYPE_RE = Regex(
        "<serviceType>\\s*(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\\d)\\s*</serviceType>",
        RegexOption.IGNORE_CASE
    )
    private val CONTROL_URL_RE = Regex("<controlURL>\\s*([^<]{1,512}?)\\s*</controlURL>", RegexOption.IGNORE_CASE)
    private val URL_BASE_RE = Regex("<URLBase>\\s*([^<]{1,512}?)\\s*</URLBase>", RegexOption.IGNORE_CASE)
    private val EXT_IP_RE = Regex("<NewExternalIPAddress>\\s*([0-9.]{7,15})\\s*</NewExternalIPAddress>", RegexOption.IGNORE_CASE)
    private val ERROR_CODE_RE = Regex("<errorCode>\\s*(\\d{1,4})\\s*</errorCode>", RegexOption.IGNORE_CASE)
    private val STATUS_RE = Regex("^HTTP/1\\.[01] (\\d{3})")
    private val IPV4_RE = Regex("^(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}$")
    private val CRLF = byteArrayOf(13, 10)
    private val CRLFCRLF = byteArrayOf(13, 10, 13, 10)

    /** Gefundener Router: Steuer-URL, Diensttyp und oeffentliche IPv4-Adresse. */
    class Igd(val controlUrl: URL, val serviceType: String, val externalAddress: String)

    /** errorCode: 0 = ok, sonst UPnP-Fehlercode (606 nicht erlaubt, 718 Konflikt, ...), -1 = keine/kaputte Antwort. */
    class SoapResult(val ok: Boolean, val errorCode: Int)

    private class HttpResponse(val status: Int, val body: String)

    fun errorName(code: Int): String = when (code) {
        -1 -> "TIMEOUT"
        606 -> "NOT_AUTHORIZED"
        718 -> "CONFLICT"
        725 -> "ONLY_PERMANENT_LEASES"
        else -> "UPNP_$code"
    }

    /** Sucht das IGD des Gateways; null, wenn keins antwortet. */
    fun discover(local: Inet4Address, gateway: Inet4Address): Igd? {
        for (location in search(local, gateway)) {
            for ((controlUrl, serviceType) in services(location, local, gateway)) {
                val ext = externalAddress(controlUrl, serviceType, local, gateway) ?: continue
                return Igd(controlUrl, serviceType, ext)
            }
        }
        return null
    }

    fun addPortMapping(
        igd: Igd,
        local: Inet4Address,
        gateway: Inet4Address,
        tcp: Boolean,
        internalPort: Int,
        externalPort: Int,
        leaseSec: Int
    ): SoapResult = soap(
        igd.controlUrl, igd.serviceType, "AddPortMapping", listOf(
            "NewRemoteHost" to "",
            "NewExternalPort" to externalPort.toString(),
            "NewProtocol" to (if (tcp) "TCP" else "UDP"),
            "NewInternalPort" to internalPort.toString(),
            "NewInternalClient" to (local.hostAddress ?: ""),
            "NewEnabled" to "1",
            "NewPortMappingDescription" to DESCRIPTION,
            "NewLeaseDuration" to leaseSec.coerceAtLeast(1).toString()
        ), local, gateway
    )

    fun deletePortMapping(
        igd: Igd,
        local: Inet4Address,
        gateway: Inet4Address,
        tcp: Boolean,
        externalPort: Int
    ): SoapResult = soap(
        igd.controlUrl, igd.serviceType, "DeletePortMapping", listOf(
            "NewRemoteHost" to "",
            "NewExternalPort" to externalPort.toString(),
            "NewProtocol" to (if (tcp) "TCP" else "UDP")
        ), local, gateway
    )

    // ── SSDP ────────────────────────────────────────────────────────────────
    private fun search(local: Inet4Address, gateway: Inet4Address): List<URL> {
        val found = ArrayList<URL>()
        MulticastSocket(InetSocketAddress(local, 0)).use { sock ->
            sock.timeToLive = 1
            NetworkInterface.getByInetAddress(local)?.let { nif ->
                runCatching { sock.networkInterface = nif }
            }
            val group = InetAddress.getByName(SSDP_ADDR)   // Literal - keine DNS-Anfrage
            for (st in SEARCH_TARGETS) {
                val multi = mSearch("$SSDP_ADDR:$SSDP_PORT", st)
                runCatching { sock.send(DatagramPacket(multi, multi.size, InetSocketAddress(group, SSDP_PORT))) }
                val uni = mSearch("${gateway.hostAddress}:$SSDP_PORT", st)
                runCatching { sock.send(DatagramPacket(uni, uni.size, InetSocketAddress(gateway, SSDP_PORT))) }
            }
            val buf = ByteArray(2048)
            val deadline = System.currentTimeMillis() + SSDP_WAIT_MS
            while (found.isEmpty()) {
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
                val text = String(buf, 0, p.length, Charsets.ISO_8859_1)
                val location = header(text, "location") ?: continue
                gatewayUrl(location, null, gateway)?.let { found.add(it) }
            }
        }
        return found
    }

    private fun mSearch(host: String, st: String): ByteArray =
        ("M-SEARCH * HTTP/1.1\r\n" +
            "HOST: " + host + "\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: 1\r\n" +
            "ST: " + st + "\r\n\r\n").toByteArray(Charsets.US_ASCII)

    // ── Beschreibung und Steuerung ──────────────────────────────────────────
    /** WAN-Verbindungsdienste aus der Geraetebeschreibung (WANIPConnection zuerst). */
    private fun services(location: URL, local: Inet4Address, gateway: Inet4Address): List<Pair<URL, String>> {
        val resp = http(location, "GET", emptyList(), null, local, gateway) ?: return emptyList()
        if (resp.status != 200) return emptyList()
        val xml = resp.body
        val base = URL_BASE_RE.find(xml)?.groupValues?.get(1)
            ?.let { gatewayUrl(xmlUnescape(it), null, gateway) } ?: location
        val ip = ArrayList<Pair<URL, String>>()
        val ppp = ArrayList<Pair<URL, String>>()
        for (m in SERVICE_RE.findAll(xml)) {
            val block = m.groupValues[1]
            val type = SERVICE_TYPE_RE.find(block)?.groupValues?.get(1) ?: continue
            val ctl = CONTROL_URL_RE.find(block)?.groupValues?.get(1) ?: continue
            val url = gatewayUrl(xmlUnescape(ctl), base, gateway) ?: continue
            if (type.contains("WANIPConnection", ignoreCase = true)) ip.add(Pair(url, type)) else ppp.add(Pair(url, type))
            if (ip.size + ppp.size >= 4) break
        }
        return ip + ppp
    }

    private fun externalAddress(controlUrl: URL, serviceType: String, local: Inet4Address, gateway: Inet4Address): String? {
        val resp = soapRaw(controlUrl, serviceType, "GetExternalIPAddress", emptyList(), local, gateway) ?: return null
        if (resp.status != 200) return null
        val ext = EXT_IP_RE.find(resp.body)?.groupValues?.get(1) ?: return null
        return if (IPV4_RE.matches(ext) && ext != "0.0.0.0") ext else null
    }

    private fun soap(
        controlUrl: URL,
        serviceType: String,
        action: String,
        args: List<Pair<String, String>>,
        local: Inet4Address,
        gateway: Inet4Address
    ): SoapResult {
        val resp = soapRaw(controlUrl, serviceType, action, args, local, gateway) ?: return SoapResult(false, -1)
        if (resp.status == 200) return SoapResult(true, 0)
        val code = ERROR_CODE_RE.find(resp.body)?.groupValues?.get(1)?.toIntOrNull() ?: -1
        return SoapResult(false, code)
    }

    private fun soapRaw(
        controlUrl: URL,
        serviceType: String,
        action: String,
        args: List<Pair<String, String>>,
        local: Inet4Address,
        gateway: Inet4Address
    ): HttpResponse? {
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\"?>\r\n")
        sb.append("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" ")
        sb.append("s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>")
        sb.append("<u:").append(action).append(" xmlns:u=\"").append(serviceType).append("\">")
        for ((k, v) in args) {
            sb.append('<').append(k).append('>').append(xmlEscape(v)).append("</").append(k).append('>')
        }
        sb.append("</u:").append(action).append("></s:Body></s:Envelope>\r\n")
        val body = sb.toString().toByteArray(Charsets.UTF_8)
        return http(
            controlUrl, "POST", listOf(
                "Content-Type" to "text/xml; charset=\"utf-8\"",
                "SOAPAction" to "\"$serviceType#$action\""
            ), body, local, gateway
        )
    }

    /** Nur http://<Gateway-IPv4>[:Port]/... - alles andere wird verworfen. */
    private fun gatewayUrl(spec: String, base: URL?, gateway: Inet4Address): URL? = try {
        val u = if (base != null) URL(base, spec.trim()) else URL(spec.trim())
        val port = if (u.port == -1) 80 else u.port
        if (u.protocol.equals("http", ignoreCase = true) && u.host == gateway.hostAddress &&
            port in 1..65535 && u.userInfo == null
        ) u else null
    } catch (e: Exception) {
        null
    }

    // ── Minimaler HTTP/1.1-Client (nur zum Gateway) ─────────────────────────
    private fun http(
        url: URL,
        method: String,
        headers: List<Pair<String, String>>,
        body: ByteArray?,
        local: Inet4Address,
        gateway: Inet4Address
    ): HttpResponse? {
        if (url.host != gateway.hostAddress) return null
        val port = if (url.port == -1) 80 else url.port
        val path = url.file.let { if (it.isNullOrEmpty()) "/" else it }
        if (path.any { it == '\r' || it == '\n' || it == ' ' }) return null
        val deadline = System.currentTimeMillis() + REQUEST_DEADLINE_MS
        return try {
            Socket(Proxy.NO_PROXY).use { s ->
                s.bind(InetSocketAddress(local, 0))
                s.connect(InetSocketAddress(gateway, port), CONNECT_TIMEOUT_MS)
                val head = StringBuilder()
                head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
                head.append("Host: ").append(gateway.hostAddress).append(':').append(port).append("\r\n")
                head.append("Connection: close\r\n")
                for ((k, v) in headers) head.append(k).append(": ").append(v).append("\r\n")
                if (body != null) head.append("Content-Length: ").append(body.size).append("\r\n")
                head.append("\r\n")
                val out = s.getOutputStream()
                out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
                if (body != null) out.write(body)
                out.flush()
                val raw = readResponse(s, deadline)
                if (raw == null) null else parseResponse(raw)
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun readResponse(s: Socket, deadline: Long): ByteArray? {
        val inp = s.getInputStream()
        val buf = ByteArrayOutputStream()
        val chunk = ByteArray(4096)
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0L) return null
            s.soTimeout = left.toInt()
            val n = try {
                inp.read(chunk)
            } catch (e: SocketTimeoutException) {
                return null
            }
            if (n < 0) break
            buf.write(chunk, 0, n)
            if (buf.size() > MAX_RESPONSE_BYTES) return null
            if (isComplete(buf.toByteArray())) break
        }
        return buf.toByteArray()
    }

    private fun isComplete(raw: ByteArray): Boolean {
        val headerEnd = indexOf(raw, CRLFCRLF, 0)
        if (headerEnd < 0) return false
        val head = String(raw, 0, headerEnd, Charsets.ISO_8859_1)
        val bodyLen = raw.size - headerEnd - 4
        val te = header(head, "transfer-encoding")
        if (te != null && te.contains("chunked", ignoreCase = true)) {
            return dechunk(raw.copyOfRange(headerEnd + 4, raw.size)) != null
        }
        val cl = header(head, "content-length")?.trim()?.toIntOrNull() ?: return false
        return bodyLen >= cl
    }

    private fun parseResponse(raw: ByteArray): HttpResponse? {
        val headerEnd = indexOf(raw, CRLFCRLF, 0)
        if (headerEnd < 0) return null
        val head = String(raw, 0, headerEnd, Charsets.ISO_8859_1)
        val status = STATUS_RE.find(head)?.groupValues?.get(1)?.toIntOrNull() ?: return null
        var body = raw.copyOfRange(headerEnd + 4, raw.size)
        val te = header(head, "transfer-encoding")
        if (te != null && te.contains("chunked", ignoreCase = true)) {
            body = dechunk(body) ?: return null
        } else {
            val cl = header(head, "content-length")?.trim()?.toIntOrNull()
            if (cl != null && cl in 0..body.size) body = body.copyOf(cl)
        }
        return HttpResponse(status, String(body, Charsets.UTF_8))
    }

    private fun dechunk(b: ByteArray): ByteArray? {
        val out = ByteArrayOutputStream()
        var pos = 0
        while (true) {
            val lineEnd = indexOf(b, CRLF, pos)
            if (lineEnd < 0) return null
            val sizeText = String(b, pos, lineEnd - pos, Charsets.ISO_8859_1).substringBefore(';').trim()
            val size = sizeText.toIntOrNull(16) ?: return null
            pos = lineEnd + 2
            if (size == 0) return out.toByteArray()
            if (size < 0 || pos + size > b.size) return null
            out.write(b, pos, size)
            pos += size + 2
        }
    }

    private fun header(text: String, name: String): String? {
        for (line in text.split("\r\n", "\n")) {
            val i = line.indexOf(':')
            if (i <= 0) continue
            if (line.substring(0, i).trim().equals(name, ignoreCase = true)) {
                val v = line.substring(i + 1).trim()
                return if (v.isEmpty()) null else v
            }
        }
        return null
    }

    private fun indexOf(h: ByteArray, n: ByteArray, from: Int): Int {
        var i = from
        while (i <= h.size - n.size) {
            var match = true
            for (j in n.indices) {
                if (h[i + j] != n[j]) {
                    match = false
                    break
                }
            }
            if (match) return i
            i++
        }
        return -1
    }

    private fun xmlEscape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private fun xmlUnescape(s: String): String =
        s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}
