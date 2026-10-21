package com.securecommapp.tor

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import IPtProxy.Controller
import IPtProxy.OnTransportEvents
import net.freehaven.tor.control.TorControlCommands
import org.torproject.jni.TorService
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.Locale

/**
 * Tor-Ausweichweg fuer Malachi (Gegenstueck: TorTransport.js).
 *
 *  - Startet Tor (tor-android) in einem EIGENEN Prozess (MalachiTorProcessService,
 *    ":tor") und steuert es ueber dessen Control-Socket - so ist ein Neustart
 *    (z.B. nach Netzwechsel) jederzeit moeglich. Auf Wunsch ueber
 *    Bridges (obfs4, Snowflake, meek, WebTunnel - bereitgestellt von IPtProxy).
 *  - Betreibt einen Onion-Dienst: eingehende Tor-Verbindungen landen auf einem
 *    Server-Socket, der NUR auf 127.0.0.1 lauscht.
 *  - Baut ausgehende Verbindungen zu .onion-Adressen ueber Tors SOCKS-Port auf.
 *
 * Transportformat: eine Nachricht = eine Zeile (UTF-8, '\n'-getrennt). Anmeldung,
 * Kyber-Schluesseltausch und Verschluesselung laufen komplett in JS - dieses
 * Modul transportiert nur Zeilen und sieht keine Klartexte.
 *
 * Ereignisse an JS (DeviceEventEmitter):
 *   MalachiTorStatus   {status, progress, message}
 *   MalachiTorIncoming {connId}
 *   MalachiTorLine     {connId, line}
 *   MalachiTorClosed   {connId, reason}
 *   MalachiTorRendezvousIncoming {connId, onion}  (Telefonnummer-Kopplung, siehe
 *                      addRendezvousOnion - nicht ueber die normale Anmeldung)
 */
class MalachiTorModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiTor"
        private const val TOR_LOG_TAG = "MalachiTorLog"
        const val VIRTUAL_PORT = 7777
        private const val MAX_LINE_BYTES = 2 * 1024 * 1024
        private const val MAX_CONNECTIONS = 64
        // Audit 2026-10-19 (A2/T3): eingehende Verbindungen kommen ueber
        // 127.0.0.1 - auch von anderen Apps. Bis JS sie nach gueltiger
        // Anmeldung freigibt (trustConnection), gilt ein kleines Zeilenlimit
        // (Anmelde-/Handshake-Zeilen sind wenige KB gross).
        private const val PRE_AUTH_MAX_LINE_BYTES = 8 * 1024
        private const val SOCKS_CONNECT_TIMEOUT_MS = 90_000
        private const val CONTROL_WAIT_MS = 60_000L
        // HTTP ueber Tor (httpRequest, nur fuer den In-App-Kauf)
        private const val HTTP_MAX_RESPONSE_BYTES = 256 * 1024
        private const val HTTP_MAX_REQUEST_BYTES = 8 * 1024
        private const val HTTP_MAX_PARALLEL = 4
        private val ONION_V3_RE = Regex("^[a-z2-7]{56}\\.onion$")
        private val HTTP_PATH_RE = Regex("^/[A-Za-z0-9/_.~-]{0,200}$")
        private val HTTP_STATUS_RE = Regex("^HTTP/1\\.[01] (\\d{3})(?: .*)?$")
        // Telefonnummer-Kopplung (PhonePairing.js): Treffpunkt-Schluessel =
        // "ED25519-V3:" + Base64 des 64-Byte-Schluessels - sonst nichts.
        private val RENDEZVOUS_KEY_RE = Regex("^ED25519-V3:[A-Za-z0-9+/]{86}==$")
        private const val MAX_RENDEZVOUS = 2
        private const val MAX_RENDEZVOUS_CONNS = 16
        private const val KDF_MIN_MEM_KIB = 8 * 1024
        private const val KDF_MAX_MEM_KIB = 256 * 1024
        private const val KDF_MAX_ITERATIONS = 10

        // Prozessweit genau EIN Controller (IPtProxy-Vorgabe) und EINE
        // Steuerverbindung zum tor-Prozess.
        @Volatile private var ptController: Controller? = null
        @Volatile private var torCtl: net.freehaven.tor.control.TorControlConnection? = null
        @Volatile private var controlSocket: android.net.LocalSocket? = null
        @Volatile private var socksPort: Int = 0
        // Zuletzt gemeldeter Status (prozessweit, fuer activeSocksPort()).
        @Volatile private var sharedStatus: String = "OFF"
        private const val TOR_PROCESS_SUFFIX = ":tor"

        /**
         * SOCKS-Port des laufenden tor - 0, solange Tor nicht verbunden ist.
         * Fuer andere native Module, die einen Onion-Dienst ueber denselben
         * tor-Prozess erreichen (MalachiUpdaterModule: In-App-Updates).
         */
        internal fun activeSocksPort(): Int =
            if (torCtl != null && sharedStatus == "ON" && socksPort > 0) socksPort else 0

        /**
         * SOCKS5-Aufbau zu einer .onion-Adresse mit eigener Zufalls-Anmeldung je
         * Versuch. tor gibt Verbindungen mit unterschiedlicher SOCKS-Anmeldung
         * eigene Kreise (IsolateSOCKSAuth ist Standard). Live-Test 2026-10-17:
         * parallele Versuche zum selben Kontakt hingen sonst alle am selben
         * steckengebliebenen Kreis - jetzt ist jeder Versuch eine echte Alternative.
         * Fehler tragen tors genauen Grund (ExtendedErrors, siehe writeTorrc).
         * Im companion, damit auch MalachiUpdaterModule ihn nutzen kann (eigene,
         * von allen Kontakt-Verbindungen getrennte Kreise je Update-Abruf).
         */
        internal fun openIsolatedSocks(onion: String, port: Int, proxyPort: Int, timeoutMs: Int): Socket {
            val deadline = System.currentTimeMillis() + timeoutMs
            fun remaining(): Int {
                val r = deadline - System.currentTimeMillis()
                if (r <= 0) throw java.net.SocketTimeoutException("Connect timed out")
                return r.toInt()
            }
            val s = Socket()
            try {
                s.connect(InetSocketAddress("127.0.0.1", proxyPort), 5_000)
                s.tcpNoDelay = true
                s.soTimeout = remaining()
                val out = s.getOutputStream()
                val inp = java.io.DataInputStream(s.getInputStream())
                // Nur Benutzername/Passwort anbieten (0x02).
                out.write(byteArrayOf(5, 1, 2)); out.flush()
                val greet = ByteArray(2); inp.readFully(greet)
                if (greet[0].toInt() != 5 || greet[1].toInt() != 2) throw java.io.IOException("SOCKS: Anmeldung nicht angeboten")
                val rnd = java.security.SecureRandom()
                val user = ByteArray(12).also { rnd.nextBytes(it) }.joinToString("") { "%02x".format(it) }.toByteArray(Charsets.US_ASCII)
                val pass = ByteArray(12).also { rnd.nextBytes(it) }.joinToString("") { "%02x".format(it) }.toByteArray(Charsets.US_ASCII)
                out.write(byteArrayOf(1, user.size.toByte()) + user + byteArrayOf(pass.size.toByte()) + pass); out.flush()
                val auth = ByteArray(2); inp.readFully(auth)
                if (auth[1].toInt() != 0) throw java.io.IOException("SOCKS: Anmeldung abgelehnt")
                val host = onion.toByteArray(Charsets.US_ASCII)
                out.write(byteArrayOf(5, 1, 0, 3, host.size.toByte()) + host + byteArrayOf((port shr 8).toByte(), (port and 0xFF).toByte()))
                out.flush()
                s.soTimeout = remaining()
                val head = ByteArray(4)
                try { inp.readFully(head) } catch (e: java.net.SocketTimeoutException) { throw java.net.SocketTimeoutException("Connect timed out") }
                val rep = head[1].toInt() and 0xFF
                if (rep != 0) throw java.io.IOException("Tor: " + socksReason(rep))
                // Rest der Antwort (gebundene Adresse + Port) verwerfen.
                val addrLen = when (head[3].toInt()) { 1 -> 4; 4 -> 16; 3 -> inp.readUnsignedByte(); else -> 0 }
                inp.readFully(ByteArray(addrLen + 2))
                s.soTimeout = 0
                return s
            } catch (e: Exception) {
                try { s.close() } catch (_: Exception) {}
                throw e
            }
        }

        /** tors SOCKS5-Antwortcodes (0xF0-0xF7 = ExtendedErrors fuer Onion-Ziele). */
        internal fun socksReason(code: Int): String = when (code) {
            0x01 -> "allgemeiner Fehler"
            0x04 -> "Ziel nicht erreichbar"
            0x05 -> "Verbindung abgewiesen"
            0x06 -> "Zeitueberschreitung in Tor"
            0xF0 -> "Onion-Beschreibung nicht gefunden"
            0xF1 -> "Onion-Beschreibung ungueltig"
            0xF2 -> "Einfuehrung gescheitert"
            0xF3 -> "Treffpunkt gescheitert"
            0xF6 -> "Onion-Adresse ungueltig"
            0xF7 -> "Einfuehrung: Zeitueberschreitung"
            else -> "SOCKS-Fehler 0x" + Integer.toHexString(code)
        }
    }

    private class Conn(val id: String, val socket: Socket, val inbound: Boolean) {
        val outbox = LinkedBlockingQueue<ByteArray>()
        @Volatile var closed = false
        @Volatile var maxLine = if (inbound) PRE_AUTH_MAX_LINE_BYTES else MAX_LINE_BYTES
    }

    private val tasks = Executors.newSingleThreadExecutor { r -> Thread(r, "malachi-tor-ctl") }
    private val ioThreads = Executors.newCachedThreadPool { r -> Thread(r, "malachi-tor-io").apply { isDaemon = true } }
    private val conns = ConcurrentHashMap<String, Conn>()
    private val httpInFlight = AtomicInteger(0)
    @Volatile private var server: ServerSocket? = null
    @Volatile private var serviceConnection: ServiceConnection? = null
    @Volatile private var onionHost: String? = null
    // Zeitpunkt des letzten Netzwechsels: "status/circuit-established" bleibt
    // danach oft auf 1 stehen, obwohl alle Kreise am alten Netz hingen - erst
    // ein NACH dem Wechsel gebauter Kreis beweist, dass Tor wieder geht.
    @Volatile private var netChangedAt: Long = 0
    // Warnungen "Guard ... is failing more circuits than usual" seit dem Start
    // dieses tor-Prozesses (Pfad-Bias: der Einstiegsknoten verliert ungewoehnlich
    // viele Kreise - meist ueberlastet). Siehe resetGuards().
    @Volatile private var guardWarnings: Int = 0
    @Volatile private var startedTransports: List<String> = emptyList()
    @Volatile private var status = "OFF"
    // Telefonnummer-Kopplung: voruebergehende Treffpunkt-Dienste (Adresse ohne
    // ".onion" -> Dienst mit eigenem lokalen Server-Socket).
    private class Rendezvous(val host: String, val server: ServerSocket) {
        val accepted = AtomicInteger(0)
    }
    private val rendezvous = ConcurrentHashMap<String, Rendezvous>()
    // Argon2id-Laeufe nacheinander (je Lauf bis zu 64 MiB) - nie zwei
    // gleichzeitig im Speicher, und nie auf dem Tor-Steuer-Thread.
    private val kdfThread = Executors.newSingleThreadExecutor { r -> Thread(r, "malachi-tor-kdf").apply { isDaemon = true } }

    override fun getName() = "MalachiTor"

    // Pflicht fuer NativeEventEmitter in JS.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    private fun emit(event: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        } catch (e: Exception) {
            Log.w(TAG, "Ereignis $event nicht zustellbar: ${e.message}")
        }
    }

    private fun emitStatus(newStatus: String, progress: Int = -1, message: String? = null) {
        status = newStatus
        sharedStatus = newStatus
        emit("MalachiTorStatus", Arguments.createMap().apply {
            putString("status", newStatus)
            putInt("progress", progress)
            if (message != null) putString("message", message)
        })
    }

    // ── Start / Stopp ──────────────────────────────────────────────────────

    /**
     * options:
     *   bridges:  Array<String>  Bridge-Zeilen ("obfs4 1.2.3.4:443 FP cert=... iat-mode=0",
     *                            "snowflake 192.0.2.3:80 FP ...", ...). Leer = ohne Bridges.
     *   onionKey: String?        gespeicherter Schluessel "ED25519-V3:..." oder null (neu erzeugen).
     *   bootstrapTimeoutMs: Int  Abbruch, wenn Tor bis dahin nicht verbunden ist.
     * Ergebnis: { onion: "xyz.onion", onionKey: "ED25519-V3:..." (nur wenn neu), socksPort }
     */
    @ReactMethod
    fun start(options: ReadableMap, promise: Promise) {
        tasks.execute {
            try {
                stopInternal()
                val bridges = mutableListOf<String>()
                options.getArray("bridges")?.let { arr ->
                    for (i in 0 until arr.size()) arr.getString(i)?.trim()?.takeIf { it.isNotEmpty() }?.let(bridges::add)
                }
                val bootstrapTimeout = if (options.hasKey("bootstrapTimeoutMs")) options.getInt("bootstrapTimeoutMs").toLong() else 120_000L
                val onionKey = if (options.hasKey("onionKey")) options.getString("onionKey") else null
                emitStatus("STARTING", 0, if (bridges.isEmpty()) "direkt" else "Bridges")

                val localPort = startLocalServer()
                writeTorrc(bridges)
                // Frischer tor-Prozess (der alte wurde in stopInternal beendet).
                val control = startTorProcess()
                netChangedAt = System.currentTimeMillis()
                attachTorLog(control)
                waitForBootstrap(control, bootstrapTimeout)

                val reply = control.addOnion(
                    onionKey ?: "NEW:ED25519-V3",
                    mapOf(VIRTUAL_PORT to "127.0.0.1:$localPort"),
                    null
                )
                val host = reply[TorControlCommands.HS_ADDRESS] ?: throw IllegalStateException("Kein Onion-Name erhalten")
                onionHost = host
                Log.i(TAG, "Onion-Dienst aktiv -> lokaler Port $localPort (Modul ${System.identityHashCode(this)})")
                emitStatus("ON", 100, "verbunden")
                promise.resolve(Arguments.createMap().apply {
                    putString("onion", "$host.onion")
                    reply[TorControlCommands.HS_PRIVKEY]?.let { putString("onionKey", it) }
                    putInt("socksPort", socksPort)
                    putInt("virtualPort", VIRTUAL_PORT)
                })
            } catch (e: Exception) {
                Log.w(TAG, "Start fehlgeschlagen: ${e.message}")
                stopInternal()
                emitStatus("ERROR", -1, e.message)
                promise.reject("TOR_START", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        tasks.execute {
            stopInternal()
            emitStatus("OFF", 0)
            promise.resolve(null)
        }
    }

    /**
     * Netzwechsel (WLAN <-> Mobilfunk): Tor bemerkt den sonst erst nach
     * Minuten. Kurz aus- und wieder einschalten zwingt neue Kreise und eine
     * neue Veroeffentlichung des Onion-Dienstes - so ist man im neuen Netz
     * schnell wieder erreichbar (gleiches Vorgehen wie Orbot).
     */
    @ReactMethod
    fun networkChanged(promise: Promise) {
        tasks.execute {
            try {
                val control = torCtl
                if (control == null || status != "ON") { promise.resolve(false); return@execute }
                netChangedAt = System.currentTimeMillis()
                control.setConf("DisableNetwork", "1")
                Thread.sleep(500)
                control.setConf("DisableNetwork", "0")
                // Neue Kreise fuer neue Verbindungen erzwingen - alte haengen am
                // weggefallenen Netz.
                try { control.signal("NEWNYM") } catch (_: Exception) {}
                try { control.signal("ACTIVE") } catch (_: Exception) {}
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("TOR_NET", e.message, e)
            }
        }
    }

    /**
     * Netzwechsel ohne tor-Neustart: alle Verbindungen am alten Netz kappen
     * (DisableNetwork 1 -> 0) und neu aufbauen - OHNE NEWNYM. So bleiben
     * Konsens, Wachen und die Onion-Beschreibungen der Kontakte erhalten; ein
     * frisch gestartetes tor braucht allein fuer eine Beschreibung oft 20 s+
     * (Live-Test 2026-10-17). Ob tor danach im neuen Netz wirklich Kreise baut,
     * prueft TorTransport ueber health().freshCircuits (sonst Neustart).
     */
    @ReactMethod
    fun resetNetwork(promise: Promise) {
        tasks.execute {
            try {
                val control = torCtl
                if (control == null || status != "ON") { promise.resolve(false); return@execute }
                netChangedAt = System.currentTimeMillis()
                control.setConf("DisableNetwork", "1")
                Thread.sleep(300)
                control.setConf("DisableNetwork", "0")
                try { control.signal("ACTIVE") } catch (_: Exception) {}
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("TOR_NET", e.message, e)
            }
        }
    }

    /**
     * Onion-Beschreibung EINES Kontakts gezielt neu holen (HSFETCH) - ohne die
     * Nebenwirkungen von NEWNYM (das leert alle Beschreibungen und bricht
     * laufende Aufbauten ab). Live-Test 2026-10-18: starten beide Seiten
     * gleichzeitig neu, haelt jede noch die veraltete Beschreibung der anderen
     * und fragt erst nach, wenn tor selbst aufgibt - die Verbindung stand erst
     * nach 2:20 min. Die neue Beschreibung meldet HS_DESC RECEIVED (-> JS).
     */
    @ReactMethod
    fun refetchDescriptor(onion: String, promise: Promise) {
        tasks.execute {
            try {
                val control = torCtl
                val addr = onion.removeSuffix(".onion")
                if (control == null || status != "ON" || !Regex("^[a-z2-7]{56}$").matches(addr)) {
                    promise.resolve(false)
                    return@execute
                }
                control.hsFetch(addr)
                promise.resolve(true)
            } catch (e: Exception) {
                // z.B. Abruf laeuft schon - kein Fehler fuer den Aufrufer.
                promise.resolve(false)
            }
        }
    }

    /**
     * Neue Einstiegsknoten waehlen lassen: tors Zustandsdatei ("state", enthaelt
     * die Wachen-Auswahl) loeschen - NUR bei gestopptem tor. Live-Test
     * 2026-10-18: beide Wachen des Pixel 8 verloren ~40 % der Kreise, der eigene
     * Onion-Dienst blieb minutenlang unerreichbar, waehrend das 7a (andere
     * Wachen) in 42 s erreichbar war. TorTransport ruft das hoechstens alle 12 h
     * (haeufiger Wachen-Wechsel schadet der Anonymitaet).
     */
    @ReactMethod
    fun resetGuards(promise: Promise) {
        tasks.execute {
            try {
                if (status == "ON" || serviceConnection != null) { promise.resolve(false); return@execute }
                val state = File(File(reactApplicationContext.getDir(TorService::class.java.simpleName, Context.MODE_PRIVATE), "data"), "state")
                val ok = !state.exists() || state.delete()
                guardWarnings = 0
                Log.i(TAG, "Wachen-Auswahl zurueckgesetzt: $ok")
                promise.resolve(ok)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }
    }

    /**
     * Beim Loeschen aller Daten (Audit 2026-10-19, P4): tors Datenverzeichnis
     * (Wachen, Zustand, Zwischenspeicher), die torrc (eigene Bridges) und den
     * Zustand der Pluggable Transports entfernen - NUR bei gestopptem tor.
     * Die Onion-Identitaet selbst liegt im (gleichzeitig geleerten)
     * verschluesselten Speicher der App.
     */
    @ReactMethod
    fun wipeData(promise: Promise) {
        tasks.execute {
            try {
                if (status == "ON" || serviceConnection != null) { promise.resolve(false); return@execute }
                val torDir = reactApplicationContext.getDir(TorService::class.java.simpleName, Context.MODE_PRIVATE)
                var ok = torDir.deleteRecursively()
                try { TorService.getTorrc(reactApplicationContext).delete() } catch (_: Throwable) {}
                ok = File(reactApplicationContext.noBackupFilesDir, "pt_state").deleteRecursively() && ok
                guardWarnings = 0
                promise.resolve(ok)
            } catch (e: Throwable) {
                promise.resolve(false)
            }
        }
    }

    /** NEWNYM: neue Kreise + Onion-Zwischenspeicher leeren (Tor begrenzt auf 1x/10 s). */
    @ReactMethod
    fun refreshCircuits(promise: Promise) {
        tasks.execute {
            try {
                val control = torCtl
                if (control == null || status != "ON") { promise.resolve(false); return@execute }
                control.signal("NEWNYM")
                promise.resolve(true)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }
    }

    /** { circuitEstablished, progress, dormant } fuer die Gesundheitspruefung in JS. */
    @ReactMethod
    fun health(promise: Promise) {
        tasks.execute {
            val control = torCtl
            val result = Arguments.createMap()
            if (control == null || status != "ON") {
                result.putBoolean("running", false)
                promise.resolve(result)
                return@execute
            }
            result.putBoolean("running", true)
            try { result.putBoolean("circuitEstablished", control.getInfo("status/circuit-established").trim() == "1") } catch (_: Exception) { result.putBoolean("circuitEstablished", false) }
            try {
                val phase = control.getInfo("status/bootstrap-phase")
                result.putInt("progress", Regex("PROGRESS=(\\d+)").find(phase)?.groupValues?.get(1)?.toIntOrNull() ?: 0)
            } catch (_: Exception) { result.putInt("progress", 0) }
            try { result.putBoolean("dormant", control.getInfo("dormant").trim() == "1") } catch (_: Exception) {}
            try { result.putInt("freshCircuits", countCircuitsBuiltSince(control.getInfo("circuit-status"), netChangedAt)) } catch (_: Exception) { result.putInt("freshCircuits", 0) }
            result.putInt("guardWarnings", guardWarnings)
            // Fuehrt tor den eigenen Onion-Dienst noch (an diese Steuerverbindung gebunden)?
            try {
                val host = onionHost
                result.putBoolean("onionActive", host != null && control.getInfo("onions/current").contains(host))
            } catch (_: Exception) {}
            result.putBoolean("localServerOpen", server?.isClosed == false)
            result.putInt("localPort", server?.localPort ?: -1)
            try { Log.i(TAG, "Diagnose: Modul ${System.identityHashCode(this)} lokaler Port ${server?.localPort} onions=" + control.getInfo("onions/current").lines().size) } catch (_: Exception) {}
            promise.resolve(result)
        }
    }

    /**
     * Tors eigene Hinweise/Warnungen ins Logcat (Tag MalachiTorLog) - sonst
     * sieht man nicht, warum Tor z.B. nach einem Netzwechsel haengt. Bei
     * HS_DESC nur Aktion + Grund, keine Onion-Adressen. CIRC bleibt abonniert
     * (braucht TorService selbst fuer seine Statusmeldung).
     */
    /**
     * Tor-Meldungen vor dem Loggen schwaerzen (Audit 2026-10-19): Onion-
     * Adressen, IPv4/IPv6-Adressen (z. B. eigener Bridges) und Relay-
     * Fingerabdruecke - logcat ist auf dem Geraet fuer adb lesbar.
     */
    private fun schwaerzen(msg: String): String = msg
        .replace(Regex("[a-z2-7]{56}"), "<onion>")
        .replace(Regex("""\$?[0-9A-Fa-f]{40}"""), "<fp>")
        .replace(Regex("""\[[0-9A-Fa-f:.]+\](:\d+)?"""), "<ip>")
        .replace(Regex("""\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b"""), "<ip>")
        .replace(Regex("""\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"""), "<ip>")

    private fun attachTorLog(control: net.freehaven.tor.control.TorControlConnection) {
        try {
            control.addRawEventListener { type, msg ->
                when (type) {
                    "NOTICE", "WARN" -> {
                        Log.i(TOR_LOG_TAG, "$type ${schwaerzen(msg)}")
                        if (msg.contains("is failing more circuits than usual") || msg.contains("is failing an extremely large amount of circuits")) guardWarnings++
                    }
                    "HS_DESC" -> {
                        val parts = msg.split(' ')
                        val action = parts.getOrNull(0) ?: ""
                        if (action == "FAILED" || action == "RECEIVED" || action == "UPLOADED" || action == "REQUESTED") {
                            Log.i(TOR_LOG_TAG, "HS_DESC $action " + parts.filter { it.startsWith("REASON=") }.joinToString(" "))
                        }
                        // Beschreibung eines Kontakts ist da: JS startet einen frischen
                        // Versuch - waehrend des Abrufs gestartete haengen oft weiter
                        // (Live-Test 2026-10-17). Adresse nur an JS, nie ins Log.
                        val addr = parts.getOrNull(1) ?: ""
                        if (action == "RECEIVED" && Regex("^[a-z2-7]{56}$").matches(addr) && addr != onionHost) {
                            emit("MalachiTorDescReceived", Arguments.createMap().apply { putString("onion", "$addr.onion") })
                        }
                    }
                }
            }
            control.setEvents(listOf("NOTICE", "WARN", "HS_DESC"))
        } catch (e: Exception) {
            Log.w(TAG, "Tor-Log nicht abonnierbar: ${e.message}")
        }
    }

    /** Anzahl fertiger (BUILT) Kreise, die nach [sinceMs] erzeugt wurden (TIME_CREATED ist UTC). */
    private fun countCircuitsBuiltSince(status: String, sinceMs: Long): Int {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        // Sekundengenau - eine Sekunde Abzug, damit ein Kreis aus derselben Sekunde zaehlt.
        val since = sinceMs - 1000
        return status.lineSequence().count { line ->
            if (!line.contains(" BUILT ")) return@count false
            val t = Regex("TIME_CREATED=(\\S{19})").find(line)?.groupValues?.get(1) ?: return@count false
            (runCatching { fmt.parse(t)?.time }.getOrNull() ?: 0L) >= since
        }
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putString("status", status)
            onionHost?.let { putString("onion", "$it.onion") }
            putInt("connections", conns.size)
        })
    }

    private fun writeTorrc(bridges: List<String>) {
        val sb = StringBuilder()
        // Keine HTTP-Tunnel-Schnittstelle, keine unnoetigen Plattenzugriffe.
        sb.append("HTTPTunnelPort 0\n")
        sb.append("AvoidDiskWrites 1\n")
        sb.append("ClientOnly 1\n")
        // Tor lernt sein Zeitlimit fuer den Kreisaufbau selbst - nach Netzwechseln
        // steht es oft bei 60 s (live gesehen), dann haengt jeder Versuch am alten
        // Netz eine Minute. Deshalb fest - aber 20 s statt 10 s: mit 10 s
        // scheiterten live ~40 % aller Kreise ("Guard ... is failing more
        // circuits than usual", 105/177), gerade die 4-stufigen Onion-Kreise im
        // Mobilnetz - Beschreibungen, Kopplung und der eigene Dienst hingen. Das
        // Haengen am alten Netz fangen inzwischen resetNetwork + Neustart-
        // Rueckfall (TorTransport.lightResetThenReconnect) ab.
        sb.append("LearnCircuitBuildTimeout 0\n")
        sb.append("CircuitBuildTimeout 20\n")
        // Mobilfunk ist oft reines IPv6 (z.B. Telekom internet.v6, IPv4 nur per
        // Uebersetzer/464XLAT): Tor darf Relais direkt ueber IPv6 erreichen.
        sb.append("ClientUseIPv6 1\n")
        // SOCKS nur lokal (auto = 127.0.0.1, freier Port); ExtendedErrors: tor
        // nennt bei Onion-Zielen den genauen Grund (nicht gefunden, Einfuehrung
        // oder Treffpunkt gescheitert) statt "allgemeiner Fehler".
        sb.append("SocksPort auto ExtendedErrors\n")
        // Malachi betreibt einen Onion-Dienst - Tor darf nie in den
        // Ruhezustand ("dormant") gehen, sonst ist man ueber Tor unerreichbar.
        sb.append("DormantCanceledByStartup 1\n")
        sb.append("DormantClientTimeout 10 days\n")
        if (bridges.isNotEmpty()) {
            startTransports(bridges).forEach { sb.append("ClientTransportPlugin ").append(it).append('\n') }
            sb.append("UseBridges 1\n")
            bridges.forEach { sb.append("Bridge ").append(it.replace('\n', ' ')).append('\n') }
        }
        TorService.getTorrc(reactApplicationContext).writeText(sb.toString())
    }

    /** Startet die noetigen Bridge-Transporte; liefert "typ socks5 127.0.0.1:port"-Zeilen. */
    private fun startTransports(bridges: List<String>): List<String> {
        val controller = ensurePtController()
        val transports = bridges.map { it.substringBefore(' ') }.distinct()
        val started = mutableListOf<String>()
        val lines = mutableListOf<String>()
        for (t in transports) {
            val method = when (t) {
                "obfs4" -> IPtProxy.IPtProxy.Obfs4
                "snowflake" -> IPtProxy.IPtProxy.Snowflake
                "meek_lite" -> IPtProxy.IPtProxy.MeekLite
                "webtunnel" -> IPtProxy.IPtProxy.Webtunnel
                else -> throw IllegalArgumentException("Unbekannter Bridge-Typ: $t")
            }
            controller.start(method, "")
            started.add(method)
            lines.add("$t socks5 127.0.0.1:${controller.port(method)}")
        }
        startedTransports = started
        return lines
    }

    /** Bridges im laufenden Tor setzen bzw. entfernen (SETCONF/RESETCONF). */
    private fun applyBridgesLive(control: net.freehaven.tor.control.TorControlConnection, bridges: List<String>) {
        if (bridges.isEmpty()) {
            control.resetConf(listOf("UseBridges", "Bridge", "ClientTransportPlugin"))
            return
        }
        val kv = mutableListOf<String>()
        startTransports(bridges).forEach { kv.add("ClientTransportPlugin $it") }
        bridges.forEach { kv.add("Bridge " + it.replace('\n', ' ')) }
        kv.add("UseBridges 1")
        control.setConf(kv)
    }

    private fun ensurePtController(): Controller {
        ptController?.let { return it }
        val dir = File(reactApplicationContext.noBackupFilesDir, "pt_state").apply { mkdirs() }
        val c = IPtProxy.IPtProxy.newController(dir.absolutePath, false, false, "ERROR", object : OnTransportEvents {
            override fun connected(name: String?) { Log.i(TAG, "Bridge-Transport verbunden: $name") }
            override fun error(name: String?, error: java.lang.Exception?) { Log.w(TAG, "Bridge-Transport $name: ${error?.message}") }
            override fun stopped(name: String?, error: java.lang.Exception?) { Log.i(TAG, "Bridge-Transport $name gestoppt") }
        }) ?: throw IllegalStateException("IPtProxy nicht initialisierbar")
        ptController = c
        return c
    }

    /** Control-Socket des tor-Prozesses (gleicher Pfad wie in TorService). */
    private fun torControlSocketFile(): File =
        File(File(reactApplicationContext.getDir(TorService::class.java.simpleName, Context.MODE_PRIVATE), "data"), "ControlSocket")

    /**
     * Startet den tor-Prozess (Bindung an MalachiTorProcessService) und baut die
     * Steuerverbindung ueber dessen Control-Socket auf (Unix-Socket im privaten
     * App-Verzeichnis - nur diese App kommt heran, deshalb ohne Passwort).
     */
    private fun startTorProcess(): net.freehaven.tor.control.TorControlConnection {
        val latch = java.util.concurrent.CountDownLatch(1)
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) { latch.countDown() }
            override fun onServiceDisconnected(name: ComponentName?) {
                // tor-Prozess unerwartet beendet (Absturz, Systembereinigung) -
                // JS (Waechter) startet ihn neu.
                if (serviceConnection !== this) return
                closeControl()
                emitStatus("OFF", 0, "Tor-Prozess beendet")
            }
        }
        serviceConnection = connection
        val ok = reactApplicationContext.bindService(
            Intent(reactApplicationContext, MalachiTorProcessService::class.java), connection, Context.BIND_AUTO_CREATE
        )
        if (!ok) throw IllegalStateException("Tor-Dienst nicht startbar")
        if (!latch.await(30, TimeUnit.SECONDS)) throw IllegalStateException("Tor-Dienst antwortet nicht")

        val path = torControlSocketFile().absolutePath
        val deadline = System.currentTimeMillis() + CONTROL_WAIT_MS
        var lastError: Exception? = null
        while (System.currentTimeMillis() < deadline) {
            var ls: android.net.LocalSocket? = null
            try {
                ls = android.net.LocalSocket()
                ls.connect(android.net.LocalSocketAddress(path, android.net.LocalSocketAddress.Namespace.FILESYSTEM))
                val c = net.freehaven.tor.control.TorControlConnection(ls.inputStream, ls.outputStream)
                c.launchThread(true)
                c.authenticate(ByteArray(0))
                val port = Regex(":(\\d+)").findAll(c.getInfo("net/listeners/socks")).lastOrNull()?.groupValues?.get(1)?.toIntOrNull() ?: 0
                if (port <= 0) throw IllegalStateException("SOCKS-Port noch nicht offen")
                controlSocket = ls
                torCtl = c
                socksPort = port
                return c
            } catch (e: Exception) {
                lastError = e
                try { ls?.close() } catch (_: Exception) {}
                Thread.sleep(300)
            }
        }
        throw IllegalStateException("Tor-Steuerverbindung nicht verfuegbar: ${lastError?.message}")
    }

    private fun closeControl() {
        try { controlSocket?.close() } catch (_: Exception) {}
        controlSocket = null
        torCtl = null
        socksPort = 0
    }

    /** Wartet, bis der tor-Prozess wirklich weg ist (Datenverzeichnis frei). */
    private fun waitForTorProcessGone(timeoutMs: Long) {
        val am = reactApplicationContext.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val alive = am.runningAppProcesses?.any { it.processName.endsWith(TOR_PROCESS_SUFFIX) } ?: false
            if (!alive) return
            Thread.sleep(100)
        }
        Log.w(TAG, "tor-Prozess nach ${timeoutMs} ms noch aktiv")
    }

    private fun waitForBootstrap(control: net.freehaven.tor.control.TorControlConnection, timeoutMs: Long) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastProgress = -1
        while (System.currentTimeMillis() < deadline) {
            val phase = try { control.getInfo("status/bootstrap-phase") } catch (e: Exception) { "" }
            val progress = Regex("PROGRESS=(\\d+)").find(phase)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            if (progress != lastProgress) {
                lastProgress = progress
                val summary = Regex("SUMMARY=\"([^\"]*)\"").find(phase)?.groupValues?.get(1)
                emitStatus("STARTING", progress, summary)
            }
            if (progress >= 100) return
            Thread.sleep(1000)
        }
        throw IllegalStateException("Tor hat sich nicht innerhalb von ${timeoutMs / 1000}s verbunden (Fortschritt $lastProgress%)")
    }

    private fun <T> waitFor(timeoutMs: Long, get: () -> T?): T? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            get()?.let { return it }
            Thread.sleep(250)
        }
        return null
    }

    private fun stopInternal() {
        // Treffpunkt-Dienste der Telefonnummer-Kopplung enden mit tor.
        rendezvous.values.toList().forEach { closeRendezvous(it) }
        rendezvous.clear()
        onionHost?.let { host ->
            try { torCtl?.delOnion(host) } catch (_: Exception) {}
        }
        onionHost = null
        conns.values.toList().forEach { closeConn(it, "Tor gestoppt") }
        try { server?.close() } catch (_: Exception) {}
        server = null
        // tor-Prozess beenden (MalachiTorProcessService beendet sich mit dem
        // Dienst) - der naechste Start bekommt einen frischen Prozess.
        val sc = serviceConnection
        serviceConnection = null
        if (sc != null) {
            try { reactApplicationContext.unbindService(sc) } catch (_: Exception) {}
        }
        closeControl()
        if (sc != null) waitForTorProcessGone(8_000)
        ptController?.let { c -> startedTransports.forEach { t -> try { c.stop(t) } catch (_: Exception) {} } }
        startedTransports = emptyList()
    }

    // ── Eingehend: lokaler Server fuer den Onion-Dienst ────────────────────

    private fun startLocalServer(): Int {
        val s = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        server = s
        ioThreads.execute {
            while (!s.isClosed) {
                val socket = try { s.accept() } catch (e: Exception) { break }
                if (conns.size >= MAX_CONNECTIONS) {
                    try { socket.close() } catch (_: Exception) {}
                    continue
                }
                if (com.securecommapp.BuildConfig.DEBUG) Log.i(TAG, "Eingehende Tor-Verbindung am Onion-Dienst angenommen")
                val conn = Conn("in-" + UUID.randomUUID().toString(), socket, true)
                conns[conn.id] = conn
                emit("MalachiTorIncoming", Arguments.createMap().apply { putString("connId", conn.id) })
                startIo(conn)
            }
        }
        return s.localPort
    }

    // ── Telefonnummer-Kopplung: voruebergehender Treffpunkt ────────────────
    //
    // PhonePairing.js leitet aus beiden Telefonnummern (argon2id unten + HKDF)
    // einen Ed25519-Schluessel ab - beide Geraete kennen damit dieselbe Onion-
    // Adresse. Das Geraet mit der kleineren Nummer betreibt den Dienst hier:
    //  - ADD_ONION mit genau diesem Schluessel, Flags=DiscardPK, OHNE Detach:
    //    der Dienst ist fluechtig und endet spaetestens mit der Steuerverbindung
    //    bzw. dem tor-Prozess (App-Absturz, Tor-Neustart).
    //  - eigener Server-Socket NUR auf 127.0.0.1, hoechstens 16 Verbindungen je
    //    Dienst. Verbindungen melden sich als MalachiTorRendezvousIncoming (nicht
    //    als MalachiTorIncoming - sie gehen nicht durch die normale Anmeldung).
    //  - removeRendezvousOnion: Server-Socket zu + DEL_ONION. Bereits
    //    angenommene Verbindungen bleiben bestehen (tor schliesst die
    //    Treffpunkt-Kreise dabei nicht) - JS schliesst sie selbst.
    // Weder Schluessel noch Adressen noch Nummern werden geloggt.

    /**
     * Argon2id (RFC 9106, BouncyCastle) fuer die Treffpunkt-Ableitung der
     * Telefonnummer-Kopplung. Eingaben/Ergebnis Base64, Ergebnis outLen Byte.
     * Eigener Thread, mehrere Aufrufe laufen nacheinander. Die Eingabe wird nach
     * Gebrauch ueberschrieben; geloggt wird nur die Dauer.
     */
    @ReactMethod
    fun argon2id(passwordB64: String, saltB64: String, memKiB: Int, iterations: Int, outLen: Int, promise: Promise) {
        kdfThread.execute {
            var pw: ByteArray? = null
            var out: ByteArray? = null
            try {
                if (memKiB < KDF_MIN_MEM_KIB || memKiB > KDF_MAX_MEM_KIB || iterations < 1 || iterations > KDF_MAX_ITERATIONS || outLen < 16 || outLen > 64) {
                    throw IllegalArgumentException("Parameter")
                }
                val pwBytes = android.util.Base64.decode(passwordB64, android.util.Base64.NO_WRAP)
                pw = pwBytes
                val salt = android.util.Base64.decode(saltB64, android.util.Base64.NO_WRAP)
                if (pwBytes.isEmpty() || pwBytes.size > 1024 || salt.size < 16 || salt.size > 64) throw IllegalArgumentException("Eingabe")
                val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                    .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                    .withSalt(salt)
                    .withMemoryAsKB(memKiB)
                    .withIterations(iterations)
                    .withParallelism(1)
                    .build()
                val gen = Argon2BytesGenerator()
                gen.init(params)
                val result = ByteArray(outLen)
                out = result
                val t0 = System.currentTimeMillis()
                gen.generateBytes(pwBytes, result)
                Log.i(TAG, "Argon2id (Treffpunkt): ${System.currentTimeMillis() - t0} ms")
                promise.resolve(android.util.Base64.encodeToString(result, android.util.Base64.NO_WRAP))
            } catch (e: OutOfMemoryError) {
                promise.reject("KDF_MEMORY", "Zu wenig Arbeitsspeicher fuer die Ableitung")
            } catch (e: Exception) {
                promise.reject("KDF", "Ableitung fehlgeschlagen")
            } finally {
                pw?.fill(0)
                out?.fill(0)
            }
        }
    }

    /**
     * Treffpunkt-Dienst starten. keyBlob = "ED25519-V3:" + Base64 des 64-Byte-
     * Schluessels (erweiterte Form, wie tor sie erwartet), expectedOnion = die in
     * JS daraus berechnete Adresse - tor muss genau diese melden, sonst wird der
     * Dienst sofort wieder entfernt. Ergebnis: "xyz.onion".
     */
    @ReactMethod
    fun addRendezvousOnion(keyBlob: String, expectedOnion: String, promise: Promise) {
        tasks.execute {
            var server: ServerSocket? = null
            try {
                val control = torCtl
                if (control == null || status != "ON") {
                    promise.reject("TOR_OFF", "Tor laeuft nicht")
                    return@execute
                }
                // Streng: der Schluessel landet in einer Zeile des Steuerprotokolls -
                // nichts ausser Base64 (kein Leerzeichen, kein Zeilenumbruch) darf hinein.
                if (!RENDEZVOUS_KEY_RE.matches(keyBlob) || !ONION_V3_RE.matches(expectedOnion)) {
                    promise.reject("TOR_RDV_ARG", "Ungueltiger Treffpunkt")
                    return@execute
                }
                val expectedHost = expectedOnion.removeSuffix(".onion")
                if (rendezvous.containsKey(expectedHost)) {
                    promise.resolve(expectedOnion)
                    return@execute
                }
                if (rendezvous.size >= MAX_RENDEZVOUS) {
                    promise.reject("TOR_RDV_LIMIT", "Zu viele Treffpunkte")
                    return@execute
                }
                val s = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
                server = s
                val ports = mapOf(VIRTUAL_PORT to "127.0.0.1:${s.localPort}")
                val reply = try {
                    control.addOnion(keyBlob, ports, listOf("DiscardPK"))
                } catch (e: Exception) {
                    // Dieselbe Adresse noch aus einem frueheren Versuch in diesem tor
                    // aktiv ("collision"): einmal entfernen und neu anlegen.
                    try { control.delOnion(expectedHost) } catch (_: Exception) {}
                    control.addOnion(keyBlob, ports, listOf("DiscardPK"))
                }
                val host = reply[TorControlCommands.HS_ADDRESS] ?: throw IllegalStateException("Kein Onion-Name erhalten")
                if (host != expectedHost) {
                    try { control.delOnion(host) } catch (_: Exception) {}
                    throw IllegalStateException("Treffpunkt-Adresse passt nicht")
                }
                val r = Rendezvous(host, s)
                rendezvous[host] = r
                startRendezvousServer(r)
                Log.i(TAG, "Treffpunkt-Dienst aktiv (Telefonnummer-Kopplung)")
                promise.resolve("$host.onion")
            } catch (e: Exception) {
                try { server?.close() } catch (_: Exception) {}
                Log.w(TAG, "Treffpunkt-Dienst nicht startbar: ${e.javaClass.simpleName}")
                promise.reject("TOR_RDV", "Treffpunkt-Dienst nicht startbar")
            }
        }
    }

    /** Treffpunkt-Dienst beenden (DEL_ONION). Ergebnis: true, wenn er lief. */
    @ReactMethod
    fun removeRendezvousOnion(onion: String, promise: Promise) {
        val r = rendezvous.remove(onion.removeSuffix(".onion"))
        if (r == null) {
            promise.resolve(false)
            return
        }
        // Keine neuen Verbindungen mehr annehmen - sofort, nicht erst hinter
        // einem evtl. laufenden Tor-Start in der Warteschlange.
        try { r.server.close() } catch (_: Exception) {}
        tasks.execute {
            closeRendezvous(r)
            promise.resolve(true)
        }
    }

    private fun closeRendezvous(r: Rendezvous) {
        try { r.server.close() } catch (_: Exception) {}
        try { torCtl?.delOnion(r.host) } catch (_: Exception) {}
    }

    private fun startRendezvousServer(r: Rendezvous) {
        ioThreads.execute {
            val s = r.server
            while (!s.isClosed) {
                val socket = try { s.accept() } catch (e: Exception) { break }
                if (conns.size >= MAX_CONNECTIONS || r.accepted.incrementAndGet() > MAX_RENDEZVOUS_CONNS || rendezvous[r.host] !== r) {
                    try { socket.close() } catch (_: Exception) {}
                    continue
                }
                val conn = Conn("rv-" + UUID.randomUUID().toString(), socket, true)
                conns[conn.id] = conn
                emit("MalachiTorRendezvousIncoming", Arguments.createMap().apply {
                    putString("connId", conn.id)
                    putString("onion", "${r.host}.onion")
                })
                startIo(conn)
            }
        }
    }

    // ── Ausgehend: Verbindung zu einer .onion-Adresse ──────────────────────

    @ReactMethod
    fun connect(onion: String, port: Int, promise: Promise) = connectWithTimeout(onion, port, SOCKS_CONNECT_TIMEOUT_MS, promise)

    @ReactMethod
    fun connectWithTimeout(onion: String, port: Int, timeoutMs: Int, promise: Promise) {
        val proxyPort = socksPort
        if (torCtl == null || proxyPort <= 0 || status != "ON") {
            promise.reject("TOR_OFF", "Tor laeuft nicht")
            return
        }
        if (!Regex("^[a-z2-7]{56}\\.onion$").matches(onion)) {
            promise.reject("TOR_ADDR", "Ungueltige Onion-Adresse")
            return
        }
        if (conns.size >= MAX_CONNECTIONS) {
            promise.reject("TOR_LIMIT", "Zu viele Verbindungen")
            return
        }
        ioThreads.execute {
            try {
                val socket = openIsolatedSocks(onion, port, proxyPort, timeoutMs.coerceIn(5_000, 180_000))
                val conn = Conn("out-" + UUID.randomUUID().toString(), socket, false)
                conns[conn.id] = conn
                startIo(conn)
                promise.resolve(conn.id)
            } catch (e: Exception) {
                promise.reject("TOR_CONNECT", e.message ?: "Verbindung fehlgeschlagen")
            }
        }
    }

    // openIsolatedSocks() und socksReason() stehen im companion (oben) -
    // gemeinsam mit MalachiUpdaterModule genutzt.

    // ── HTTP ueber Tor - nur zu .onion (In-App-Kauf, ShopClient.js) ────────

    /**
     * Minimale HTTP/1.1-Anfrage an einen Onion-Dienst ueber Tors SOCKS-Port.
     *  - Nur v3-Onion-Adressen: alles andere wird abgelehnt - es gibt hierueber
     *    KEINE Klartext-Verbindung ins Internet. Der Hostname geht unaufgeloest
     *    an Tor (keine lokale DNS-Aufloesung).
     *  - Nur GET/POST, Pfad ohne Query/Sonderzeichen, JSON-Koerper hoechstens 8 KB.
     *  - Kopfzeilen nur Host, Accept, Connection: close und bei POST Content-Type/
     *    Content-Length - kein User-Agent, keine Cookies, nichts mit Geraetedaten.
     *  - Antwort (Kopf + Koerper) auf 256 KB begrenzt, Gesamtzeit auf timeoutMs.
     *  - Weder Anfrage noch Antwort werden geloggt.
     * Ergebnis: { status: Int, body: String, retryAfter?: String }
     */
    @ReactMethod
    fun httpRequest(targetHost: String, port: Int, method: String, path: String, jsonBody: String?, timeoutMs: Int, promise: Promise) {
        val proxyPort = socksPort
        if (torCtl == null || proxyPort <= 0 || status != "ON") {
            promise.reject("TOR_OFF", "Tor laeuft nicht")
            return
        }
        if (!ONION_V3_RE.matches(targetHost)) {
            promise.reject("HTTP_HOST", "Nur .onion-Adressen erlaubt")
            return
        }
        if (port < 1 || port > 65535) {
            promise.reject("HTTP_PORT", "Ungueltiger Port")
            return
        }
        if (method != "GET" && method != "POST") {
            promise.reject("HTTP_METHOD", "Nur GET und POST")
            return
        }
        if (!HTTP_PATH_RE.matches(path) || path.contains("..")) {
            promise.reject("HTTP_PATH", "Ungueltiger Pfad")
            return
        }
        val body = if (method == "POST") (jsonBody ?: "").toByteArray(StandardCharsets.UTF_8) else null
        if (method == "GET" && !jsonBody.isNullOrEmpty()) {
            promise.reject("HTTP_BODY", "GET ohne Koerper")
            return
        }
        if (body != null && body.size > HTTP_MAX_REQUEST_BYTES) {
            promise.reject("HTTP_BODY", "Anfrage zu gross")
            return
        }
        if (httpInFlight.incrementAndGet() > HTTP_MAX_PARALLEL) {
            httpInFlight.decrementAndGet()
            promise.reject("HTTP_BUSY", "Zu viele gleichzeitige Anfragen")
            return
        }
        ioThreads.execute {
            var socket: Socket? = null
            try {
                val total = timeoutMs.coerceIn(5_000, 180_000)
                val deadline = System.currentTimeMillis() + total
                val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", proxyPort))
                val s = Socket(proxy)
                socket = s
                s.connect(InetSocketAddress.createUnresolved(targetHost, port), total)
                s.tcpNoDelay = true
                val head = StringBuilder()
                    .append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
                    .append("Host: ").append(targetHost).append(if (port == 80) "" else ":$port").append("\r\n")
                    .append("Accept: application/json\r\n")
                    .append("Connection: close\r\n")
                if (body != null) {
                    head.append("Content-Type: application/json\r\n")
                    head.append("Content-Length: ").append(body.size).append("\r\n")
                }
                head.append("\r\n")
                val out = s.getOutputStream()
                out.write(head.toString().toByteArray(StandardCharsets.US_ASCII))
                if (body != null) out.write(body)
                out.flush()
                val res = parseHttpResponse(readHttpResponse(s, deadline))
                promise.resolve(Arguments.createMap().apply {
                    putInt("status", res.status)
                    putString("body", res.body)
                    res.retryAfter?.let { putString("retryAfter", it) }
                })
            } catch (e: java.net.SocketTimeoutException) {
                promise.reject("HTTP_TIMEOUT", "Zeitueberschreitung")
            } catch (e: Exception) {
                // Bewusst ohne e.message (koennte die Onion-Adresse enthalten).
                promise.reject("HTTP_FAILED", "Anfrage fehlgeschlagen (${e.javaClass.simpleName})")
            } finally {
                try { socket?.close() } catch (_: Exception) {}
                httpInFlight.decrementAndGet()
            }
        }
    }

    private class HttpResult(val status: Int, val body: String, val retryAfter: String?)

    /** Liest bis Verbindungsende bzw. bis Content-Length erreicht ist - hoechstens 256 KB, bis zur Frist. */
    private fun readHttpResponse(socket: Socket, deadline: Long): ByteArray {
        val input = socket.getInputStream()
        val buf = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        var expectedTotal = -1
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) throw java.net.SocketTimeoutException("Frist abgelaufen")
            socket.soTimeout = remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            val n = input.read(chunk)
            if (n < 0) break
            buf.write(chunk, 0, n)
            if (buf.size() > HTTP_MAX_RESPONSE_BYTES) throw IllegalStateException("Antwort zu gross")
            if (expectedTotal < 0) {
                val data = buf.toByteArray()
                val headerEnd = indexOf(data, CRLFCRLF, 0)
                if (headerEnd >= 0) {
                    val len = contentLengthOf(String(data, 0, headerEnd, StandardCharsets.ISO_8859_1))
                    if (len != null) expectedTotal = headerEnd + 4 + len
                }
            }
            if (expectedTotal >= 0 && buf.size() >= expectedTotal) break
        }
        return buf.toByteArray()
    }

    private fun contentLengthOf(headerText: String): Int? {
        for (line in headerText.split("\r\n").drop(1)) {
            val i = line.indexOf(':')
            if (i > 0 && line.substring(0, i).trim().lowercase(Locale.ROOT) == "content-length") {
                val v = line.substring(i + 1).trim().toLongOrNull() ?: throw IllegalStateException("Ungueltige Laenge")
                if (v < 0 || v > HTTP_MAX_RESPONSE_BYTES) throw IllegalStateException("Ungueltige Laenge")
                return v.toInt()
            }
        }
        return null
    }

    private fun parseHttpResponse(raw: ByteArray): HttpResult {
        val headerEnd = indexOf(raw, CRLFCRLF, 0)
        if (headerEnd < 0) throw IllegalStateException("Unvollstaendige Antwort")
        val lines = String(raw, 0, headerEnd, StandardCharsets.ISO_8859_1).split("\r\n")
        val m = HTTP_STATUS_RE.find(lines[0]) ?: throw IllegalStateException("Ungueltige Statuszeile")
        val code = m.groupValues[1].toInt()
        var chunked = false
        var retryAfter: String? = null
        for (line in lines.drop(1)) {
            val i = line.indexOf(':')
            if (i <= 0) continue
            val name = line.substring(0, i).trim().lowercase(Locale.ROOT)
            val value = line.substring(i + 1).trim()
            if (name == "transfer-encoding" && value.lowercase(Locale.ROOT).contains("chunked")) chunked = true
            if (name == "retry-after" && value.length <= 12) retryAfter = value
        }
        var body = raw.copyOfRange(headerEnd + 4, raw.size)
        val len = contentLengthOf(lines.joinToString("\r\n"))
        if (chunked) {
            body = decodeChunked(body)
        } else if (len != null) {
            if (body.size < len) throw IllegalStateException("Antwort abgeschnitten")
            body = body.copyOfRange(0, len)
        }
        return HttpResult(code, String(body, StandardCharsets.UTF_8), retryAfter)
    }

    private fun decodeChunked(data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var pos = 0
        while (true) {
            val lineEnd = indexOf(data, CRLF, pos)
            if (lineEnd < 0) throw IllegalStateException("Chunk unvollstaendig")
            val sizeText = String(data, pos, lineEnd - pos, StandardCharsets.US_ASCII).substringBefore(';').trim()
            val size = sizeText.toIntOrNull(16) ?: throw IllegalStateException("Ungueltige Chunk-Groesse")
            if (size < 0 || size > HTTP_MAX_RESPONSE_BYTES) throw IllegalStateException("Ungueltige Chunk-Groesse")
            pos = lineEnd + 2
            if (size == 0) break
            if (pos + size > data.size) throw IllegalStateException("Chunk abgeschnitten")
            out.write(data, pos, size)
            if (out.size() > HTTP_MAX_RESPONSE_BYTES) throw IllegalStateException("Antwort zu gross")
            pos += size + 2
        }
        return out.toByteArray()
    }

    private val CRLF = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte())
    private val CRLFCRLF = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())

    private fun indexOf(data: ByteArray, pattern: ByteArray, from: Int): Int {
        var i = from
        while (i <= data.size - pattern.size) {
            var match = true
            for (j in pattern.indices) {
                if (data[i + j] != pattern[j]) { match = false; break }
            }
            if (match) return i
            i++
        }
        return -1
    }

    @ReactMethod
    fun send(connId: String, line: String, promise: Promise) {
        val conn = conns[connId]
        if (conn == null || conn.closed) {
            promise.reject("TOR_CLOSED", "Verbindung geschlossen")
            return
        }
        if (line.indexOf('\n') >= 0) {
            promise.reject("TOR_LINE", "Zeilenumbruch in Nachricht")
            return
        }
        val bytes = (line + "\n").toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_LINE_BYTES) {
            promise.reject("TOR_SIZE", "Nachricht zu gross")
            return
        }
        conn.outbox.offer(bytes)
        promise.resolve(null)
    }

    @ReactMethod
    fun close(connId: String) {
        conns[connId]?.let { closeConn(it, "lokal geschlossen") }
    }

    /** Eingehende Verbindung hat sich angemeldet: volles Zeilenlimit (Audit A2/T3). */
    @ReactMethod
    fun trustConnection(connId: String) {
        conns[connId]?.maxLine = MAX_LINE_BYTES
    }

    private fun startIo(conn: Conn) {
        // Schreiber: haelt die Reihenfolge ein und blockiert nie den JS-Thread.
        ioThreads.execute {
            try {
                val out: OutputStream = conn.socket.getOutputStream()
                while (!conn.closed) {
                    val chunk = conn.outbox.poll(30, TimeUnit.SECONDS) ?: continue
                    out.write(chunk)
                    out.flush()
                }
            } catch (e: Exception) {
                closeConn(conn, "Schreibfehler")
            }
        }
        // Leser: eine Zeile = eine Nachricht, mit Groessenlimit.
        ioThreads.execute {
            try {
                val input = BufferedInputStream(conn.socket.getInputStream())
                while (!conn.closed) {
                    val line = readLine(input, conn) ?: break
                    if (line.isEmpty()) continue
                    emit("MalachiTorLine", Arguments.createMap().apply {
                        putString("connId", conn.id)
                        putString("line", line)
                    })
                }
                closeConn(conn, "Gegenseite hat geschlossen")
            } catch (e: Exception) {
                closeConn(conn, e.message ?: "Lesefehler")
            }
        }
    }

    private fun readLine(input: InputStream, conn: Conn): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() > 0) buf.toString("UTF-8") else null
            if (b == '\n'.code) return buf.toString("UTF-8")
            buf.write(b)
            if (buf.size() > conn.maxLine) throw IllegalStateException("Nachricht zu gross")
        }
    }

    private fun closeConn(conn: Conn, reason: String) {
        if (conn.closed) return
        conn.closed = true
        conns.remove(conn.id)
        try { conn.socket.close() } catch (_: Exception) {}
        emit("MalachiTorClosed", Arguments.createMap().apply {
            putString("connId", conn.id)
            putString("reason", reason)
        })
    }

    override fun invalidate() {
        tasks.execute { stopInternal() }
        super.invalidate()
    }
}
