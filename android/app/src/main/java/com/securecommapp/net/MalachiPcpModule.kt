package com.securecommapp.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * Automatische Portfreigabe am Heimrouter - Masterplan Baustein 1.
 *
 * Nach dem Sammeln der WebRTC-Kandidaten bittet die App den eigenen Router,
 * genau den Port des Kandidaten kurzzeitig freizugeben:
 *   - IPv6: "Pinhole" in der Router-Firewall (die Adresse ist ohnehin
 *     oeffentlich, nur die Firewall liess bisher nichts Unaufgefordertes rein),
 *   - IPv4: Weiterleitung von aussen auf das Handy (nur mit echter
 *     oeffentlicher IPv4 - bei DS-Lite/Carrier-NAT gibt es die nicht).
 *
 * Protokolle, in dieser Reihenfolge:
 *   1. PCP (RFC 6887) - IPv4 und IPv6 (FritzBox, neuere Router).
 *   2. NAT-PMP (RFC 6886, NatPmp.kt) - nur IPv4, nur wenn PCP schweigt (beide
 *      nutzen Port 5351; ein PCP-Router entscheidet ueber NAT-PMP genauso).
 *   3. UPnP-IGD (UpnpIgd.kt) - nur IPv4, wenn 1./2. nicht freigegeben haben.
 * NAT-PMP und UPnP nur im WLAN/LAN (im Mobilfunk gibt es keinen Heimrouter).
 * Im Verbindungsweg "Privat (ohne STUN)" (ConnectionMode.js) ist das die
 * einzige Quelle der oeffentlichen IPv4-Adresse.
 *
 * Alles geht ausschliesslich an das Standard-Gateway des Netzes, zu dem die
 * Kandidaten-Adresse gehoert (bzw. per SSDP-Multicast mit TTL 1 ins eigene
 * LAN) - nie ins Internet. Hinter dem freigegebenen Port lauscht nur WebRTC,
 * das ausschliesslich authentifizierte STUN-/DTLS-Pakete annimmt.
 *
 * Ergebnis je Zeile wie bisher bei PCP (WebRTCManager.addMappedCandidates
 * macht daraus Kandidaten), zusaetzlich `method` ('pcp'|'natpmp'|'upnp') und
 * `attempts` (kurzes Protokoll ohne Adressen). Das Modul merkt sich, womit
 * freigegeben wurde: Erneuern und Loeschen (lifetimeSec 0, beim Schliessen
 * der Verbindung) laufen ueber dasselbe Protokoll. Beim Beenden der App
 * werden verbliebene Freigaben geloescht.
 *
 * Alles laeuft auf einem eigenen Hintergrund-Thread; jede einzelne Anfrage
 * hat ein Zeitlimit unter 1 s. Was das Gateway kann (antwortet PCP? NAT-PMP?
 * wo ist das UPnP-Geraet?), wird 10 min gemerkt - der naechste
 * Verbindungsaufbau probiert dann nicht erneut alles durch.
 *
 * Bei der FritzBox muss "Selbststaendige Portfreigaben erlauben" fuer das
 * jeweilige Geraet aktiv sein, sonst antwortet sie mit NOT_AUTHORIZED (PCP)
 * bzw. Fehler 606 (UPnP).
 */
class MalachiPcpModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val PCP_PORT = 5351
        private const val OPCODE_MAP = 1
        private const val TIMEOUT_MS = 700L
        private const val GATEWAY_CACHE_MS = 10 * 60 * 1000L
        private val RESULT_NAMES = mapOf(
            0 to "SUCCESS", 1 to "UNSUPP_VERSION", 2 to "NOT_AUTHORIZED", 3 to "MALFORMED_REQUEST",
            4 to "UNSUPP_OPCODE", 5 to "UNSUPP_OPTION", 6 to "MALFORMED_OPTION", 7 to "NETWORK_FAILURE",
            8 to "NO_RESOURCES", 9 to "UNSUPP_PROTOCOL", 10 to "USER_EX_QUOTA",
            11 to "CANNOT_PROVIDE_EXTERNAL", 12 to "ADDRESS_MISMATCH", 13 to "EXCESSIVE_REMOTE_PEERS"
        )
        private val IPV4_LITERAL = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
        private val IPV6_LITERAL = Regex("^[0-9a-fA-F:.]{2,45}$")
    }

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "malachi-pcp") }
    private val random = SecureRandom()

    /** Bestehende Freigabe (nur auf dem Executor-Thread benutzt). */
    private class Active(
        val method: String,
        val local: InetAddress,
        val gateway: InetAddress,
        val tcp: Boolean,
        val internalPort: Int,
        val externalPort: Int,
        val igd: UpnpIgd.Igd?
    )
    private val active = HashMap<String, Active>()

    /** Was das Gateway kann (nur auf dem Executor-Thread benutzt). */
    private class GatewayInfo(val key: String, val since: Long) {
        var pcpSilent = false
        var natPmpSilent = false
        var upnpMissing = false
        var igd: UpnpIgd.Igd? = null
    }
    private var gatewayInfo: GatewayInfo? = null

    private class Route(val gateway: InetAddress?, val cellular: Boolean)
    private class MapResult(val code: Int, val lifetime: Int, val externalPort: Int, val externalAddress: String?)

    override fun getName() = "MalachiPcp"

    /**
     * mappings: Array<{ protocol: 'udp'|'tcp', address: String, port: Int }>
     * lifetimeSec: 0 = Freigabe wieder loeschen.
     * Ergebnis: Array<{ protocol, address, port, result, method?, externalAddress?,
     *                   externalPort?, lifetime?, attempts? }>
     */
    @ReactMethod
    fun map(mappings: ReadableArray, lifetimeSec: Int, promise: Promise) {
        executor.execute {
            val out = Arguments.createArray()
            try {
                for (i in 0 until mappings.size()) {
                    val m = mappings.getMap(i) ?: continue
                    val protocol = m.getString("protocol") ?: continue
                    val address = m.getString("address") ?: continue
                    val port = m.getInt("port")
                    val row = Arguments.createMap().apply {
                        putString("protocol", protocol)
                        putString("address", address)
                        putInt("port", port)
                    }
                    try {
                        if (protocol != "udp" && protocol != "tcp") {
                            row.putString("result", "ERROR")
                        } else {
                            handleOne(protocol == "tcp", address, port, lifetimeSec, row)
                        }
                    } catch (e: Exception) {
                        row.putString("result", "ERROR")
                        row.putString("message", e.message ?: e.javaClass.simpleName)
                    }
                    out.pushMap(row)
                }
                promise.resolve(out)
            } catch (e: Exception) {
                promise.reject("PCP", e.message, e)
            }
        }
    }

    /**
     * IPv6-Zustand des aktiven Netzes: hat das Geraet eine oeffentliche
     * IPv6-Adresse UND eine IPv6-Standardroute? Ohne Route (bekanntes Problem
     * mancher Router nach Praefixwechsel) klappen Direktverbindungen von
     * unterwegs oft nur noch ueber Tor - die App zeigt dann einen Hinweis.
     */
    @ReactMethod
    fun ipv6Status(promise: Promise) {
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val net = cm.activeNetwork
            val lp = cm.getLinkProperties(net)
            val caps = cm.getNetworkCapabilities(net)
            val hasGlobal = lp?.linkAddresses?.any { la ->
                val a = la.address
                a is Inet6Address && !a.isLinkLocalAddress && !a.isSiteLocalAddress && (a.address[0].toInt() and 0xfe) != 0xfc
            } ?: false
            val hasRoute = lp?.routes?.any { r -> r.isDefaultRoute && r.destination?.address is Inet6Address } ?: false
            promise.resolve(Arguments.createMap().apply {
                putBoolean("globalAddress", hasGlobal)
                putBoolean("defaultRoute", hasRoute)
                putString("transport", when {
                    caps == null -> "none"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    else -> "other"
                })
            })
        } catch (e: Exception) {
            promise.reject("IPV6", e.message, e)
        }
    }

    // ── Ablauf je Kandidat ───────────────────────────────────────────────────
    private fun handleOne(tcp: Boolean, address: String, port: Int, lifetimeSec: Int, row: WritableMap) {
        val local = parseLiteral(address)
        if (local == null || port !in 1..65535) {
            row.putString("result", "ERROR")
            return
        }
        val key = (if (tcp) "tcp|" else "udp|") + local.hostAddress + "|" + port
        if (lifetimeSec <= 0) {
            release(key, tcp, local, port, row)
            return
        }
        val route = routeFor(local)
        val gateway = route.gateway
        if (gateway == null) {
            row.putString("result", "NO_GATEWAY")
            return
        }
        if (local is Inet6Address) {
            // IPv6: nur PCP (Firewall-Pinhole). NAT-PMP kennt kein IPv6; UPnP-
            // Pinholes (WANIPv6FirewallControl) bieten kaum Router an.
            val r = pcpOrNull(local, gateway, tcp, port, lifetimeSec)
            putPcpResult(row, r)
            if (r != null && r.code == 0) active[key] = Active("pcp", local, gateway, tcp, port, r.externalPort, null)
            return
        }
        val local4 = local as? Inet4Address
        val gateway4 = gateway as? Inet4Address
        if (local4 == null || gateway4 == null) {
            row.putString("result", "NO_GATEWAY")
            return
        }
        mapV4(key, local4, gateway4, route.cellular, tcp, port, lifetimeSec, row)
    }

    private fun mapV4(
        key: String,
        local: Inet4Address,
        gateway: Inet4Address,
        cellular: Boolean,
        tcp: Boolean,
        port: Int,
        lifetimeSec: Int,
        row: WritableMap
    ) {
        // Bestehende NAT-PMP-/UPnP-Freigabe: mit demselben Protokoll erneuern.
        val prev = active[key]
        if (prev != null && prev.method != "pcp") {
            val renewed = renew(prev, lifetimeSec, row)
            if (renewed != null) {
                active[key] = renewed
                return
            }
            active.remove(key)
        }
        val info = gatewayInfoFor(gateway, local)
        val attempts = ArrayList<String>()
        var answer: String? = null   // erste ausdrueckliche Absage eines Routers

        // 1. PCP
        if (!info.pcpSilent) {
            val r = pcpOrNull(local, gateway, tcp, port, lifetimeSec)
            if (r == null) {
                info.pcpSilent = true
                attempts.add("pcp:TIMEOUT")
            } else if (r.code == 0) {
                putPcpResult(row, r)
                active[key] = Active("pcp", local, gateway, tcp, port, r.externalPort, null)
                return
            } else {
                val name = RESULT_NAMES[r.code] ?: "RESULT_${r.code}"
                attempts.add("pcp:$name")
                // UNSUPP_VERSION: der Router spricht (nur) NAT-PMP.
                if (r.code == 1) info.pcpSilent = true else if (answer == null) answer = name
            }
        }

        if (!cellular) {
            // 2. NAT-PMP
            if (info.pcpSilent && !info.natPmpSilent) {
                val ext = NatPmp.externalAddress(local, gateway)
                val extAddr = ext.externalAddress
                if (ext.code == NatPmp.NO_ANSWER) {
                    info.natPmpSilent = true
                    attempts.add("natpmp:TIMEOUT")
                } else if (ext.code != 0) {
                    val name = NatPmp.resultName(ext.code)
                    attempts.add("natpmp:$name")
                    if (answer == null) answer = name
                } else if (extAddr == null || !isPublicV4(extAddr)) {
                    // Doppeltes NAT/Carrier-NAT: eine Weiterleitung hier waere nutzlos.
                    attempts.add("natpmp:NOT_PUBLIC")
                    if (answer == null) answer = "NOT_PUBLIC"
                } else {
                    val r = NatPmp.map(local, gateway, tcp, port, port, lifetimeSec)
                    if (r.code == 0 && r.externalPort in 1..65535) {
                        success(row, "natpmp", extAddr, r.externalPort, r.lifetime)
                        active[key] = Active("natpmp", local, gateway, tcp, port, r.externalPort, null)
                        return
                    }
                    val name = if (r.code == 0) "ERROR" else NatPmp.resultName(r.code)
                    attempts.add("natpmp:$name")
                    if (r.code != NatPmp.NO_ANSWER && answer == null) answer = name
                }
            }

            // 3. UPnP-IGD
            if (!info.upnpMissing) {
                var igd = info.igd
                if (igd == null) {
                    igd = UpnpIgd.discover(local, gateway)
                    info.igd = igd
                    info.upnpMissing = igd == null
                }
                if (igd == null) {
                    attempts.add("upnp:NO_IGD")
                } else if (!isPublicV4(igd.externalAddress)) {
                    attempts.add("upnp:NOT_PUBLIC")
                    if (answer == null) answer = "NOT_PUBLIC"
                } else {
                    var ext = port
                    var r = UpnpIgd.addPortMapping(igd, local, gateway, tcp, port, ext, lifetimeSec)
                    if (!r.ok && r.errorCode == 718) {
                        // Port aussen schon vergeben (anderes Geraet) - einen freien hohen nehmen.
                        ext = 49152 + random.nextInt(16384)
                        r = UpnpIgd.addPortMapping(igd, local, gateway, tcp, port, ext, lifetimeSec)
                    }
                    if (r.ok) {
                        success(row, "upnp", igd.externalAddress, ext, lifetimeSec)
                        active[key] = Active("upnp", local, gateway, tcp, port, ext, igd)
                        return
                    }
                    val name = UpnpIgd.errorName(r.errorCode)
                    attempts.add("upnp:$name")
                    if (r.errorCode == -1) {
                        info.igd = null   // Router antwortet nicht mehr - beim naechsten Mal neu suchen
                    } else if (answer == null || name == "NOT_AUTHORIZED") {
                        if (answer != "NOT_AUTHORIZED") answer = name
                    }
                }
            }
        }

        row.putString("result", answer ?: if (attempts.any { it.endsWith(":TIMEOUT") }) "TIMEOUT" else "UNSUPPORTED")
        row.putString("attempts", attempts.joinToString(","))
    }

    /** Erneuert eine NAT-PMP-/UPnP-Freigabe; null, wenn das nicht mehr klappt. */
    private fun renew(prev: Active, lifetimeSec: Int, row: WritableMap): Active? {
        val local = prev.local as? Inet4Address ?: return null
        val gateway = prev.gateway as? Inet4Address ?: return null
        return try {
            when (prev.method) {
                "natpmp" -> {
                    val ext = NatPmp.externalAddress(local, gateway)
                    val extAddr = ext.externalAddress
                    if (ext.code != 0 || extAddr == null || !isPublicV4(extAddr)) return null
                    val r = NatPmp.map(local, gateway, prev.tcp, prev.internalPort, prev.externalPort, lifetimeSec)
                    if (r.code != 0 || r.externalPort !in 1..65535) return null
                    success(row, "natpmp", extAddr, r.externalPort, r.lifetime)
                    Active("natpmp", local, gateway, prev.tcp, prev.internalPort, r.externalPort, null)
                }
                "upnp" -> {
                    val igd = prev.igd ?: return null
                    val r = UpnpIgd.addPortMapping(igd, local, gateway, prev.tcp, prev.internalPort, prev.externalPort, lifetimeSec)
                    if (!r.ok) return null
                    success(row, "upnp", igd.externalAddress, prev.externalPort, lifetimeSec)
                    prev
                }
                else -> null
            }
        } catch (e: Exception) {
            null
        }
    }

    /** Freigabe loeschen - mit dem Protokoll, mit dem sie angelegt wurde. */
    private fun release(key: String, tcp: Boolean, local: InetAddress, port: Int, row: WritableMap) {
        val prev = active.remove(key)
        if (prev != null) {
            val (result, method) = releaseActive(prev)
            row.putString("result", result)
            row.putString("method", method)
            return
        }
        // Unbekannt (z.B. nach einem Neustart des Moduls): wie bisher per PCP
        // loeschen - harmlos. Ausser das Gateway spricht nachweislich kein PCP.
        val gateway = routeFor(local).gateway
        if (gateway == null) {
            row.putString("result", "NO_GATEWAY")
            return
        }
        val info = gatewayInfo
        if (local is Inet4Address && info != null && info.key == gatewayKey(gateway, local) && info.pcpSilent) {
            row.putString("result", "UNSUPPORTED")
            return
        }
        putPcpResult(row, pcpOrNull(local, gateway, tcp, port, 0))
    }

    private fun releaseActive(a: Active): Pair<String, String> {
        val local4 = a.local as? Inet4Address
        val gateway4 = a.gateway as? Inet4Address
        return when (a.method) {
            "natpmp" -> {
                if (local4 == null || gateway4 == null) return Pair("ERROR", "natpmp")
                val r = NatPmp.map(local4, gateway4, a.tcp, a.internalPort, 0, 0)
                Pair(if (r.code == 0) "SUCCESS" else NatPmp.resultName(r.code), "natpmp")
            }
            "upnp" -> {
                val igd = a.igd
                if (local4 == null || gateway4 == null || igd == null) return Pair("ERROR", "upnp")
                val r = UpnpIgd.deletePortMapping(igd, local4, gateway4, a.tcp, a.externalPort)
                Pair(if (r.ok) "SUCCESS" else UpnpIgd.errorName(r.errorCode), "upnp")
            }
            else -> {
                val r = pcpOrNull(a.local, a.gateway, a.tcp, a.internalPort, 0)
                Pair(if (r == null) "TIMEOUT" else RESULT_NAMES[r.code] ?: "RESULT_${r.code}", "pcp")
            }
        }
    }

    // App wird beendet: verbliebene Freigaben am Router loeschen (best effort -
    // die Ablaufzeit raeumt sie sonst nach spaetestens einer Stunde ab).
    override fun invalidate() {
        try {
            executor.execute {
                for (a in active.values.toList()) {
                    try { releaseActive(a) } catch (e: Exception) { }
                }
                active.clear()
            }
        } catch (e: Exception) { }
        executor.shutdown()
        super.invalidate()
    }

    // ── Hilfen ───────────────────────────────────────────────────────────────
    private fun success(row: WritableMap, method: String, externalAddress: String, externalPort: Int, lifetime: Int) {
        row.putString("result", "SUCCESS")
        row.putString("method", method)
        row.putString("externalAddress", externalAddress)
        row.putInt("externalPort", externalPort)
        row.putInt("lifetime", lifetime)
    }

    private fun putPcpResult(row: WritableMap, r: MapResult?) {
        if (r == null) {
            row.putString("result", "TIMEOUT")
            return
        }
        row.putString("result", RESULT_NAMES[r.code] ?: "RESULT_${r.code}")
        if (r.code == 0) {
            row.putString("method", "pcp")
            r.externalAddress?.let { row.putString("externalAddress", it) }
            row.putInt("externalPort", r.externalPort)
            row.putInt("lifetime", r.lifetime)
        }
    }

    /** Nur Zahlen-Adressen (nie ein Name - das wuerde eine DNS-Anfrage ausloesen). */
    private fun parseLiteral(s: String): InetAddress? {
        val ok = IPV4_LITERAL.matches(s) || (s.contains(':') && IPV6_LITERAL.matches(s))
        if (!ok) return null
        return try { InetAddress.getByName(s) } catch (e: Exception) { null }
    }

    private fun isPublicV4(s: String): Boolean {
        val p = s.split('.').map { it.toIntOrNull() ?: -1 }
        if (p.size != 4 || p.any { it !in 0..255 }) return false
        val a = p[0]
        val b = p[1]
        return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
            (a == 100 && b in 64..127) || (a == 169 && b == 254) ||
            (a == 172 && b in 16..31) || (a == 192 && b == 168))
    }

    private fun gatewayKey(gateway: InetAddress, local: InetAddress): String = "${gateway.hostAddress}|${local.hostAddress}"

    private fun gatewayInfoFor(gateway: Inet4Address, local: Inet4Address): GatewayInfo {
        val key = gatewayKey(gateway, local)
        val now = System.currentTimeMillis()
        val cur = gatewayInfo
        if (cur != null && cur.key == key && now - cur.since < GATEWAY_CACHE_MS) return cur
        return GatewayInfo(key, now).also { gatewayInfo = it }
    }

    /** Standard-Gateway (passend zur IP-Version) des Netzes, zu dem `local` gehoert. */
    private fun routeFor(local: InetAddress): Route {
        val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val v6 = local is Inet6Address
        val networks = ArrayList<Network>()
        cm.activeNetwork?.let { networks.add(it) }
        @Suppress("DEPRECATION")
        val all: Array<Network>? = try { cm.allNetworks } catch (e: Exception) { null }
        all?.forEach { if (!networks.contains(it)) networks.add(it) }
        for (net in networks) {
            val lp = cm.getLinkProperties(net) ?: continue
            if (lp.linkAddresses.none { it.address == local }) continue
            val caps = cm.getNetworkCapabilities(net)
            return Route(defaultGateway(lp, v6), caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
        }
        // Adresse keinem Netz zuzuordnen: wie bisher das aktive Netz.
        val net = cm.activeNetwork
        val lp = cm.getLinkProperties(net)
        val caps = cm.getNetworkCapabilities(net)
        return Route(if (lp != null) defaultGateway(lp, v6) else null,
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
    }

    private fun defaultGateway(lp: LinkProperties, v6: Boolean): InetAddress? {
        for (route in lp.routes) {
            if (!route.isDefaultRoute) continue
            val gw = route.gateway ?: continue
            if (gw.isAnyLocalAddress) continue
            if (!v6 && gw is Inet4Address) return gw
            if (v6 && gw is Inet6Address) {
                // Link-lokale Router-Adresse braucht die Schnittstelle als Scope.
                if (gw.isLinkLocalAddress && gw.scopeId == 0 && lp.interfaceName != null) {
                    val nif = NetworkInterface.getByName(lp.interfaceName)
                    if (nif != null) return Inet6Address.getByAddress(null, gw.address, nif)
                }
                return gw
            }
        }
        return null
    }

    private fun toPcpAddress(a: InetAddress): ByteArray = when (a) {
        is Inet6Address -> a.address
        else -> ByteArray(10) + byteArrayOf(0xff.toByte(), 0xff.toByte()) + a.address
    }

    private fun pcpOrNull(local: InetAddress, gateway: InetAddress, tcp: Boolean, port: Int, lifetime: Int): MapResult? =
        try {
            requestMap(local, gateway, if (tcp) 6 else 17, port, lifetime)
        } catch (e: SocketTimeoutException) {
            null
        }

    private fun requestMap(local: InetAddress, gateway: InetAddress, protocol: Int, port: Int, lifetime: Int): MapResult {
        val req = ByteArray(60)
        req[0] = 2                               // PCP-Version
        req[1] = OPCODE_MAP.toByte()             // Anfrage, Opcode MAP
        putInt(req, 4, lifetime)
        System.arraycopy(toPcpAddress(local), 0, req, 8, 16)
        val nonce = ByteArray(12).also { random.nextBytes(it) }
        System.arraycopy(nonce, 0, req, 24, 12)
        req[36] = protocol.toByte()
        putShort(req, 40, port)                  // interner Port
        putShort(req, 42, port)                  // Wunsch: gleicher externer Port
        val suggested = if (local is Inet6Address) ByteArray(16) else toPcpAddress(InetAddress.getByName("0.0.0.0"))
        System.arraycopy(suggested, 0, req, 44, 16)

        // Absender muss exakt die Kandidaten-Adresse sein (sonst ADDRESS_MISMATCH).
        DatagramSocket(InetSocketAddress(local, 0)).use { sock ->
            val buf = ByteArray(1100)
            for (attempt in 0 until 2) {
                sock.send(DatagramPacket(req, req.size, InetSocketAddress(gateway, PCP_PORT)))
                val deadline = System.currentTimeMillis() + TIMEOUT_MS
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
                    // Nur Antworten des Gateways zaehlen.
                    if (!p.address.address.contentEquals(gateway.address)) continue
                    // Version 0 = NAT-PMP-Router, der PCP nicht kennt (RFC 6887 Anhang A).
                    if (p.length >= 4 && buf[0].toInt() == 0) return MapResult(1, 0, 0, null)
                    if (p.length < 60 || buf[1] != (0x80 or OPCODE_MAP).toByte()) continue
                    if (!buf.copyOfRange(24, 36).contentEquals(nonce)) continue
                    val code = buf[3].toInt() and 0xff
                    val life = getInt(buf, 4)
                    val extPort = ((buf[42].toInt() and 0xff) shl 8) or (buf[43].toInt() and 0xff)
                    val extRaw = buf.copyOfRange(44, 60)
                    val ext = if (code == 0) runCatching { InetAddress.getByAddress(extRaw).hostAddress }.getOrNull() else null
                    return MapResult(code, life, extPort, ext?.substringBefore('%'))
                }
            }
        }
        throw SocketTimeoutException()
    }

    private fun putInt(b: ByteArray, off: Int, v: Int) {
        b[off] = (v ushr 24).toByte(); b[off + 1] = (v ushr 16).toByte()
        b[off + 2] = (v ushr 8).toByte(); b[off + 3] = v.toByte()
    }
    private fun putShort(b: ByteArray, off: Int, v: Int) {
        b[off] = (v ushr 8).toByte(); b[off + 1] = v.toByte()
    }
    private fun getInt(b: ByteArray, off: Int): Int =
        ((b[off].toInt() and 0xff) shl 24) or ((b[off + 1].toInt() and 0xff) shl 16) or
            ((b[off + 2].toInt() and 0xff) shl 8) or (b[off + 3].toInt() and 0xff)
}
