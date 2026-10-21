package com.securecommapp.update

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.securecommapp.tor.MalachiTorModule
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Signierte In-App-Updates der Web-Version (Gegenstueck: AppUpdater.js,
 * Format: website/UPDATE_FORMAT.md).
 *
 * NUR WEB-VERSION: Google Play verbietet Apps, sich selbst zu aktualisieren.
 * In der Play-Variante ruft AppUpdater.js dieses Modul nie auf
 * (isUpdaterAvailable()); beim Zusammenfuehren mit dem Play-Flavor gehoert
 * dieses Paket samt REQUEST_INSTALL_PACKAGES in den Web-Flavor.
 *
 * Was dieses Modul tut - und was nicht:
 *  - Laedt Dateien AUSSCHLIESSLICH von einer v3-Onion-Adresse unter /updates/
 *    ueber den SOCKS-Port des app-eigenen tor (MalachiTorModule). Kein
 *    Klartext-Internet, kein DNS, keine Weiterleitungen. Klartext-HTTP zur
 *    .onion ist hier richtig: die Onion-Verbindung ist durch Tor Ende-zu-Ende
 *    verschluesselt und an den Schluessel der Adresse gebunden.
 *  - Jeder Abruf bekommt eigene Tor-Kreise (zufaellige SOCKS-Anmeldung).
 *  - Anfrage = "GET <pfad>" mit Host und "Connection: close" - kein
 *    User-Agent, keine Cookies, kein Accept-Encoding, nichts vom Geraet.
 *  - Groessen- und Zeitgrenzen; SHA-256 wird beim Laden mitgerechnet.
 *  - Installation nur aus dem eigenen Update-Ordner, nach erneuter Pruefung
 *    von Groesse und SHA-256, ueber den System-Installer (der Nutzer
 *    bestaetigt). Android selbst lehnt APKs mit fremdem Signaturschluessel ab;
 *    inspectApk() erlaubt JS, das schon vorher zu pruefen.
 *  - Geloggt werden weder Adressen noch Pfade noch Pruefsummen.
 *
 * Ereignis an JS: MalachiUpdaterProgress {received, total}
 */
class MalachiUpdaterModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiUpdater"
        const val EVENT_PROGRESS = "MalachiUpdaterProgress"
        // Virtueller Port des Website-Onion-Dienstes (website/deploy/torrc-malachi-web.conf).
        private const val ONION_PORT = 80
        private const val DIR_NAME = "malachi_update"
        private const val SMALL_MAX_BYTES = 64 * 1024            // manifest.json (UPDATE_FORMAT.md: 64 KiB)
        private const val APK_MAX_BYTES = 1024L * 1024 * 1024    // UPDATE_FORMAT.md: apks[].size <= 1 GiB
        private const val HEADER_MAX_BYTES = 16 * 1024
        private const val CONNECT_TIMEOUT_MS = 90_000
        private const val IDLE_TIMEOUT_MS = 60_000               // so lange ohne ein einziges Byte -> Abbruch
        private const val MIN_TOTAL_MS = 10_000
        private const val MAX_SMALL_TOTAL_MS = 180_000
        private const val MAX_DOWNLOAD_TOTAL_MS = 60 * 60 * 1000
        private const val PROGRESS_MIN_INTERVAL_MS = 400L
        private const val SMALL_MAX_PARALLEL = 2
        private val ONION_V3_RE = Regex("^[a-z2-7]{56}\\.onion$")
        // Nur Dateien direkt unter /updates/ (UPDATE_FORMAT.md: Dateiname ohne Pfad).
        private val PATH_RE = Regex("^/updates/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
        private val SHA256_RE = Regex("^[0-9a-f]{64}$")
        private val STATUS_RE = Regex("^HTTP/1\\.[01] (\\d{3})(?: .*)?$")
        private const val APK_MIME = "application/vnd.android.package-archive"
    }

    private class UpdateException(val code: String, message: String) : Exception(message)

    private val io = Executors.newCachedThreadPool { r -> Thread(r, "malachi-update-io").apply { isDaemon = true } }
    private val downloading = AtomicBoolean(false)
    private val smallInFlight = AtomicInteger(0)
    @Volatile private var cancelRequested = false
    @Volatile private var activeSocket: Socket? = null

    override fun getName() = "MalachiUpdater"

    // Pflicht fuer NativeEventEmitter in JS.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    /**
     * Feste Angaben zur installierten App - AppUpdater.js liest daraus die
     * eigene versionCode (nur Updates mit groesserer werden angeboten), die
     * App-ID (Demo-Builds ".demo" bekommen keine Updates) und die ABIs des
     * Geraets in Build.SUPPORTED_ABIS-Reihenfolge (Komma-getrennt).
     * Nichts davon verlaesst das Geraet.
     */
    @Suppress("DEPRECATION")
    override fun getConstants(): MutableMap<String, Any> {
        val c = HashMap<String, Any>()
        val pkg = reactApplicationContext.packageName
        c["applicationId"] = pkg
        c["supportedAbis"] = Build.SUPPORTED_ABIS.joinToString(",")
        c["sdkInt"] = Build.VERSION.SDK_INT
        try {
            val info = reactApplicationContext.packageManager.getPackageInfo(pkg, 0)
            val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
            c["versionCode"] = code.toDouble()
            c["versionName"] = info.versionName ?: ""
        } catch (e: Exception) {
            c["versionCode"] = 0.0
            c["versionName"] = ""
        }
        return c
    }

    private fun emitProgress(received: Long, total: Long) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_PROGRESS, Arguments.createMap().apply {
                    putDouble("received", received.toDouble())
                    putDouble("total", total.toDouble())
                })
        } catch (_: Exception) {}
    }

    private fun updateDir(): File = File(reactApplicationContext.cacheDir, DIR_NAME)

    /** Datei liegt wirklich im eigenen Update-Ordner (kanonischer Pfad, keine Umwege ueber Links). */
    private fun insideUpdateDir(f: File): Boolean {
        return try {
            val dir = updateDir().canonicalFile
            val canon = f.canonicalFile
            canon.parentFile == dir && canon.name.endsWith(".apk")
        } catch (_: Exception) { false }
    }

    private fun checkTarget(host: String, path: String) {
        if (!ONION_V3_RE.matches(host)) throw UpdateException("UPDATE_HOST", "Nur .onion-Adressen erlaubt")
        if (!PATH_RE.matches(path) || path.contains("..")) throw UpdateException("UPDATE_PATH", "Ungueltiger Pfad")
    }

    // ── HTTP/1.1 ueber Tor (nur GET, nur Onion) ───────────────────────────

    private class Head(val status: Int, val contentLength: Long?)

    private fun openAndRequest(host: String, path: String, proxyPort: Int): Socket {
        val s = MalachiTorModule.openIsolatedSocks(host, ONION_PORT, proxyPort, CONNECT_TIMEOUT_MS)
        try {
            s.tcpNoDelay = true
            // Bewusst minimal: nichts, was das Geraet oder die App-Version verraet.
            val req = "GET $path HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n"
            val out: OutputStream = s.getOutputStream()
            out.write(req.toByteArray(StandardCharsets.US_ASCII))
            out.flush()
            return s
        } catch (e: Exception) {
            try { s.close() } catch (_: Exception) {}
            throw e
        }
    }

    private fun setReadTimeout(s: Socket, deadline: Long) {
        val remaining = deadline - System.currentTimeMillis()
        if (remaining <= 0) throw java.net.SocketTimeoutException("Frist abgelaufen")
        s.soTimeout = minOf(remaining, IDLE_TIMEOUT_MS.toLong()).toInt().coerceAtLeast(1)
    }

    /** Liest den Antwortkopf bis CRLFCRLF (hoechstens 16 KB). */
    private fun readHead(s: Socket, input: InputStream, deadline: Long): Head {
        val buf = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            setReadTimeout(s, deadline)
            val b = input.read()
            if (b < 0) throw UpdateException("UPDATE_HTTP", "Antwort unvollstaendig")
            buf.write(b)
            if (buf.size() > HEADER_MAX_BYTES) throw UpdateException("UPDATE_HTTP", "Antwortkopf zu gross")
            last4 = (last4 shl 8) or b
            if (last4 == 0x0D0A0D0A) break
        }
        val lines = String(buf.toByteArray(), StandardCharsets.ISO_8859_1).split("\r\n")
        val m = STATUS_RE.find(lines[0]) ?: throw UpdateException("UPDATE_HTTP", "Ungueltige Statuszeile")
        val status = m.groupValues[1].toInt()
        var contentLength: Long? = null
        for (line in lines.drop(1)) {
            val i = line.indexOf(':')
            if (i <= 0) continue
            val name = line.substring(0, i).trim().lowercase(Locale.ROOT)
            val value = line.substring(i + 1).trim()
            when (name) {
                "content-length" -> {
                    if (!Regex("^\\d{1,12}$").matches(value)) throw UpdateException("UPDATE_HTTP", "Ungueltige Laenge")
                    val v = value.toLong()
                    if (contentLength != null && contentLength != v) throw UpdateException("UPDATE_HTTP", "Widerspruechliche Laenge")
                    contentLength = v
                }
                // Kein chunked/gzip: die Website liefert statische Dateien mit
                // Content-Length, und wir senden kein Accept-Encoding.
                "transfer-encoding" -> if (value.lowercase(Locale.ROOT) != "identity") throw UpdateException("UPDATE_HTTP", "Transfer-Encoding nicht unterstuetzt")
                "content-encoding" -> if (value.lowercase(Locale.ROOT) != "identity") throw UpdateException("UPDATE_HTTP", "Content-Encoding nicht unterstuetzt")
            }
        }
        return Head(status, contentLength)
    }

    /**
     * Liest den Koerper (Content-Length oder bis Verbindungsende), hoechstens
     * maxBytes, bis zur Frist; jede Leerlaufzeit > 60 s bricht ab.
     */
    private fun readBody(s: Socket, input: InputStream, head: Head, maxBytes: Long, deadline: Long, sink: (ByteArray, Int) -> Unit): Long {
        val cl = head.contentLength
        if (cl != null && cl > maxBytes) throw UpdateException("UPDATE_TOO_LARGE", "Datei groesser als erlaubt")
        val chunk = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            if (cancelRequested) throw UpdateException("UPDATE_CANCELLED", "Abgebrochen")
            val want = if (cl != null) minOf(chunk.size.toLong(), cl - total).toInt() else chunk.size
            if (want <= 0) break
            setReadTimeout(s, deadline)
            val n = input.read(chunk, 0, want)
            if (n < 0) break
            total += n
            if (total > maxBytes) throw UpdateException("UPDATE_TOO_LARGE", "Datei groesser als erlaubt")
            sink(chunk, n)
        }
        if (cancelRequested) throw UpdateException("UPDATE_CANCELLED", "Abgebrochen")
        if (cl != null && total != cl) throw UpdateException("UPDATE_TRUNCATED", "Antwort abgeschnitten")
        return total
    }

    private fun rejectWith(promise: Promise, e: Throwable) {
        when (e) {
            is UpdateException -> promise.reject(e.code, e.message)
            is java.net.SocketTimeoutException -> promise.reject("UPDATE_TIMEOUT", "Zeitueberschreitung")
            // Bewusst ohne e.message (koennte die Onion-Adresse enthalten).
            else -> promise.reject(if (cancelRequested) "UPDATE_CANCELLED" else "UPDATE_FAILED", "Abruf fehlgeschlagen (${e.javaClass.simpleName})")
        }
    }

    /**
     * Kleine Datei (manifest.json, manifest.json.sig) unveraendert laden.
     * Ergebnis: { status, bodyB64, length } - bodyB64 nur bei Status 200.
     */
    @ReactMethod
    fun fetchSmall(host: String, path: String, maxBytes: Double, timeoutMs: Double, promise: Promise) {
        try {
            checkTarget(host, path)
            if (maxBytes < 1 || maxBytes > SMALL_MAX_BYTES) throw UpdateException("UPDATE_ARG", "Ungueltige Groessengrenze")
        } catch (e: UpdateException) {
            promise.reject(e.code, e.message)
            return
        }
        val proxyPort = MalachiTorModule.activeSocksPort()
        if (proxyPort <= 0) {
            promise.reject("TOR_OFF", "Tor laeuft nicht")
            return
        }
        if (smallInFlight.incrementAndGet() > SMALL_MAX_PARALLEL) {
            smallInFlight.decrementAndGet()
            promise.reject("UPDATE_BUSY", "Zu viele gleichzeitige Abrufe")
            return
        }
        val limit = maxBytes.toLong()
        val total = timeoutMs.toLong().coerceIn(MIN_TOTAL_MS.toLong(), MAX_SMALL_TOTAL_MS.toLong())
        io.execute {
            var socket: Socket? = null
            try {
                val deadline = System.currentTimeMillis() + total
                val s = openAndRequest(host, path, proxyPort)
                socket = s
                val input = BufferedInputStream(s.getInputStream())
                val head = readHead(s, input, deadline)
                val result = Arguments.createMap()
                result.putInt("status", head.status)
                if (head.status == 200) {
                    val body = ByteArrayOutputStream()
                    val n = readBody(s, input, head, limit, deadline) { b, len -> body.write(b, 0, len) }
                    result.putString("bodyB64", Base64.encodeToString(body.toByteArray(), Base64.NO_WRAP))
                    result.putDouble("length", n.toDouble())
                }
                promise.resolve(result)
            } catch (e: Throwable) {
                rejectWith(promise, e)
            } finally {
                try { socket?.close() } catch (_: Exception) {}
                smallInFlight.decrementAndGet()
            }
        }
    }

    /**
     * APK laden: streamt in eine private Cache-Datei, rechnet SHA-256 mit,
     * nimmt hoechstens maxBytes an. Mit expectedSha256 wird eine abweichende
     * Datei sofort geloescht (UPDATE_SHA256). Nur ein Download gleichzeitig.
     * Ergebnis: { path, size, sha256 }.
     */
    @ReactMethod
    fun download(host: String, path: String, maxBytes: Double, expectedSha256: String?, timeoutMs: Double, promise: Promise) {
        try {
            checkTarget(host, path)
            if (!path.endsWith(".apk")) throw UpdateException("UPDATE_PATH", "Nur APK-Dateien")
            if (maxBytes < 1 || maxBytes > APK_MAX_BYTES) throw UpdateException("UPDATE_ARG", "Ungueltige Groessengrenze")
            if (expectedSha256 != null && !SHA256_RE.matches(expectedSha256)) throw UpdateException("UPDATE_ARG", "Ungueltige Pruefsumme")
        } catch (e: UpdateException) {
            promise.reject(e.code, e.message)
            return
        }
        val proxyPort = MalachiTorModule.activeSocksPort()
        if (proxyPort <= 0) {
            promise.reject("TOR_OFF", "Tor laeuft nicht")
            return
        }
        if (!downloading.compareAndSet(false, true)) {
            promise.reject("UPDATE_BUSY", "Es laeuft bereits ein Download")
            return
        }
        cancelRequested = false
        val limit = maxBytes.toLong()
        val total = timeoutMs.toLong().coerceIn(MIN_TOTAL_MS.toLong(), MAX_DOWNLOAD_TOTAL_MS.toLong())
        io.execute {
            var socket: Socket? = null
            var part: File? = null
            try {
                val dir = updateDir()
                // Nur eine Datei zur Zeit: Reste frueherer Versuche weg.
                dir.listFiles()?.forEach { it.delete() }
                if (!dir.exists() && !dir.mkdirs()) throw UpdateException("UPDATE_IO", "Ordner nicht anlegbar")
                val name = "update-" + randomHex(8)
                val p = File(dir, "$name.apk.part")
                part = p
                val deadline = System.currentTimeMillis() + total
                val s = openAndRequest(host, path, proxyPort)
                socket = s
                activeSocket = s
                if (cancelRequested) throw UpdateException("UPDATE_CANCELLED", "Abgebrochen")
                val input = BufferedInputStream(s.getInputStream())
                val head = readHead(s, input, deadline)
                if (head.status != 200) throw UpdateException("UPDATE_STATUS", "HTTP ${head.status}")
                val expectedTotal = head.contentLength ?: limit
                val md = MessageDigest.getInstance("SHA-256")
                var received = 0L
                var lastEmit = 0L
                emitProgress(0, expectedTotal)
                FileOutputStream(p).use { out ->
                    readBody(s, input, head, limit, deadline) { b, len ->
                        out.write(b, 0, len)
                        md.update(b, 0, len)
                        received += len
                        val now = System.currentTimeMillis()
                        if (now - lastEmit >= PROGRESS_MIN_INTERVAL_MS) {
                            lastEmit = now
                            emitProgress(received, expectedTotal)
                        }
                    }
                    out.fd.sync()
                }
                val sha = hex(md.digest())
                emitProgress(received, expectedTotal)
                if (expectedSha256 != null && sha != expectedSha256) {
                    p.delete()
                    throw UpdateException("UPDATE_SHA256", "Pruefsumme stimmt nicht")
                }
                val finalFile = File(dir, "$name.apk")
                if (!p.renameTo(finalFile)) throw UpdateException("UPDATE_IO", "Datei nicht umbenennbar")
                part = null
                Log.i(TAG, "Update geladen und Pruefsumme bestaetigt")
                promise.resolve(Arguments.createMap().apply {
                    putString("path", finalFile.absolutePath)
                    putDouble("size", received.toDouble())
                    putString("sha256", sha)
                })
            } catch (e: Throwable) {
                try { part?.delete() } catch (_: Exception) {}
                if (cancelRequested) promise.reject("UPDATE_CANCELLED", "Abgebrochen") else rejectWith(promise, e)
            } finally {
                activeSocket = null
                try { socket?.close() } catch (_: Exception) {}
                downloading.set(false)
            }
        }
    }

    /** Laufenden Download abbrechen (die Teildatei loescht download() selbst). */
    @ReactMethod
    fun cancelDownload(promise: Promise) {
        val active = downloading.get()
        cancelRequested = true
        try { activeSocket?.close() } catch (_: Exception) {}
        promise.resolve(active)
    }

    /** Alle geladenen Update-Dateien loeschen (nach Installation/Abbruch/beim Start). */
    @ReactMethod
    fun cleanup(promise: Promise) {
        io.execute {
            if (downloading.get()) {
                promise.resolve(0)
                return@execute
            }
            var n = 0
            try {
                updateDir().listFiles()?.forEach { if (it.delete()) n++ }
            } catch (_: Exception) {}
            promise.resolve(n)
        }
    }

    // ── Pruefen und Installieren ──────────────────────────────────────────

    private fun certSha256List(sigs: Array<Signature>?): WritableArray {
        val arr = Arguments.createArray()
        sigs?.forEach { arr.pushString(hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray()))) }
        return arr
    }

    @Suppress("DEPRECATION")
    private fun signersOf(info: PackageInfo?, includeHistory: Boolean): Array<Signature>? {
        if (info == null) return null
        if (Build.VERSION.SDK_INT >= 28) {
            val si = info.signingInfo ?: return info.signatures
            return if (si.hasMultipleSigners()) si.apkContentsSigners
            else if (includeHistory) si.signingCertificateHistory
            else si.apkContentsSigners
        }
        return info.signatures
    }

    /**
     * Angaben aus der geladenen APK (vor dem Installieren, UPDATE_FORMAT.md
     * Schritt 8): { packageName, versionCode, signers[], installedSigners[] }
     * - signers = SHA-256 der Signaturzertifikate der APK, installedSigners =
     * die der installierten App (inkl. frueherer Schluessel bei Rotation).
     */
    @Suppress("DEPRECATION")
    @ReactMethod
    fun inspectApk(path: String, promise: Promise) {
        io.execute {
            try {
                val f = File(path)
                if (!insideUpdateDir(f) || !f.isFile) throw UpdateException("UPDATE_PATH", "Datei nicht im Update-Ordner")
                val pm = reactApplicationContext.packageManager
                val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
                val apk = pm.getPackageArchiveInfo(f.absolutePath, flags)
                    ?: throw UpdateException("UPDATE_APK", "APK nicht lesbar")
                val installed = pm.getPackageInfo(reactApplicationContext.packageName, flags)
                val apkCode = if (Build.VERSION.SDK_INT >= 28) apk.longVersionCode else apk.versionCode.toLong()
                promise.resolve(Arguments.createMap().apply {
                    putString("packageName", apk.packageName ?: "")
                    putDouble("versionCode", apkCode.toDouble())
                    putArray("signers", certSha256List(signersOf(apk, false)))
                    putArray("installedSigners", certSha256List(signersOf(installed, true)))
                })
            } catch (e: Throwable) {
                rejectWith(promise, e)
            }
        }
    }

    /** Darf diese App den System-Installer aufrufen ("Unbekannte Apps installieren")? */
    @ReactMethod
    fun canRequestPackageInstalls(promise: Promise) {
        try {
            promise.resolve(if (Build.VERSION.SDK_INT >= 26) reactApplicationContext.packageManager.canRequestPackageInstalls() else true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * Systemeinstellung "Unbekannte Apps installieren" fuer genau diese App
     * oeffnen. JS zeigt vorher eine Erklaerung und prueft danach erneut.
     */
    @ReactMethod
    fun openInstallPermissionSettings(promise: Promise) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= 26) {
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + reactApplicationContext.packageName))
            } else {
                Intent(Settings.ACTION_SECURITY_SETTINGS)
            }
            startActivitySafely(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("UPDATE_SETTINGS", "Einstellungen nicht oeffenbar")
        }
    }

    private fun startActivitySafely(intent: Intent) {
        val activity = reactApplicationContext.currentActivity
        if (activity != null) {
            activity.startActivity(intent)
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
        }
    }

    /**
     * Geladene APK an den System-Installer uebergeben (ACTION_VIEW mit
     * FileProvider-content://-URI und befristeter Leseberechtigung). Vorher:
     * Datei liegt im eigenen Update-Ordner, Groesse und SHA-256 stimmen
     * (erneut gerechnet), die Installations-Berechtigung ist erteilt.
     * Ergebnis: "started". Ohne Berechtigung: Fehler UPDATE_PERMISSION.
     */
    @ReactMethod
    fun install(path: String, expectedSha256: String, expectedSize: Double, promise: Promise) {
        io.execute {
            try {
                val f = File(path)
                if (!insideUpdateDir(f) || !f.isFile) throw UpdateException("UPDATE_PATH", "Datei nicht im Update-Ordner")
                if (!SHA256_RE.matches(expectedSha256)) throw UpdateException("UPDATE_ARG", "Ungueltige Pruefsumme")
                if (f.length() != expectedSize.toLong()) throw UpdateException("UPDATE_SIZE", "Groesse stimmt nicht")
                if (sha256Of(f) != expectedSha256) {
                    f.delete()
                    throw UpdateException("UPDATE_SHA256", "Pruefsumme stimmt nicht")
                }
                if (Build.VERSION.SDK_INT >= 26 && !reactApplicationContext.packageManager.canRequestPackageInstalls()) {
                    throw UpdateException("UPDATE_PERMISSION", "Installation unbekannter Apps nicht erlaubt")
                }
                val uri = FileProvider.getUriForFile(reactApplicationContext, reactApplicationContext.packageName + ".fileprovider", f)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, APK_MIME)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                reactApplicationContext.runOnUiQueueThread {
                    try {
                        startActivitySafely(intent)
                        Log.i(TAG, "System-Installer gestartet")
                        promise.resolve("started")
                    } catch (e: Exception) {
                        promise.reject("UPDATE_INSTALLER", "Installer nicht startbar")
                    }
                }
            } catch (e: Throwable) {
                rejectWith(promise, e)
            }
        }
    }

    private fun sha256Of(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(f).use { inp ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = inp.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return hex(md.digest())
    }

    private fun randomHex(bytes: Int): String = hex(ByteArray(bytes).also { SecureRandom().nextBytes(it) })

    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) sb.append(String.format(Locale.ROOT, "%02x", x.toInt() and 0xFF))
        return sb.toString()
    }

    override fun invalidate() {
        cancelRequested = true
        try { activeSocket?.close() } catch (_: Exception) {}
        super.invalidate()
    }
}
