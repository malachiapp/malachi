package com.securecommapp.vault

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaDataSource
import android.media.MediaFormat
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * Sprachnachrichten ohne Klartext-Datei (SecureAudio.js, Audit 2026-10-25 F6/E2).
 *
 * Bisher schrieb die Aufnahme-Bibliothek jede Sprachnachricht als lesbare
 * .mp4-Datei in den Cache, und zum Abspielen wurde die entschluesselte
 * Nachricht wieder als Datei abgelegt. Beides ist hier ersetzt:
 *
 *  - Aufnahme: AudioRecord -> AAC-LC (MediaCodec, 16 kHz, mono, 32 kbit/s,
 *    wie vorher) -> ADTS-Rahmen in einen Puffer im ARBEITSSPEICHER. Es
 *    entsteht keine Datei. Das Mikrofon wird ab Android 11 als
 *    "privacy sensitive" geoeffnet: keine andere App (auch keine
 *    Bedienungshilfe/Assistent) kann waehrenddessen mitschneiden.
 *  - Wiedergabe: MediaPlayer liest die entschluesselten Bytes ueber eine
 *    MediaDataSource direkt aus dem Arbeitsspeicher - auch alte .mp4-
 *    Nachrichten. Nach dem Ende wird der Puffer ueberschrieben.
 *  - Ereignisse: "MalachiSecureAudioLevel" { db } (Pegel alle 100 ms, wie
 *    currentMetering der Bibliothek) und "MalachiSecureAudioPlayback"
 *    { id, position, duration, finished, error }.
 *
 * Root-Schadsoftware, die den Prozessspeicher liest, haelt das nicht auf -
 * aber nichts davon liegt mehr als Datei herum (Backup, Forensik, Cache).
 */
class MalachiSecureAudioModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiSecureAudio"
        private const val SAMPLE_RATE = 16000
        private const val BIT_RATE = 32000
        private const val FREQ_INDEX_16K = 8
        private const val MAX_RECORD_MS = 30 * 60 * 1000L
        private const val LEVEL_EVENT = "MalachiSecureAudioLevel"
        private const val PLAYBACK_EVENT = "MalachiSecureAudioPlayback"
        private const val PROGRESS_MS = 100L
    }

    override fun getName() = "MalachiSecureAudio"

    private val main = Handler(Looper.getMainLooper())

    // ─── Aufnahme ───────────────────────────────────────────────────────────

    private class Recording(
        val record: AudioRecord,
        val codec: MediaCodec,
        val out: ByteArrayOutputStream,
    ) {
        @Volatile var stop = false
        @Volatile var cancelled = false
        var samples = 0L
        var thread: Thread? = null
        var error: Throwable? = null
    }

    private var rec: Recording? = null

    @SuppressLint("MissingPermission")   // RECORD_AUDIO fragt JS vorher ab
    @ReactMethod
    fun startRecording(promise: Promise) {
        synchronized(this) {
            if (rec != null) { promise.reject("AUDIO_BUSY", "Aufnahme laeuft bereits"); return }
            var record: AudioRecord? = null
            var codec: MediaCodec? = null
            try {
                val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                if (minBuf <= 0) throw IllegalStateException("Puffergroesse")
                val builder = AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.MIC)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setSampleRate(SAMPLE_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .build()
                    )
                    .setBufferSizeInBytes(max(minBuf * 2, 8192))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) builder.setPrivacySensitive(true)
                record = builder.build()
                if (record.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("Mikrofon nicht verfuegbar")

                val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
                    setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                    setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
                }
                codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                codec.start()
                record.startRecording()
                val r = Recording(record, codec, ByteArrayOutputStream(256 * 1024))
                r.thread = Thread({ recordLoop(r) }, "malachi-secure-rec").apply { start() }
                rec = r
                promise.resolve(true)
            } catch (e: Throwable) {
                Log.w(TAG, "Aufnahme nicht startbar: ${e.javaClass.simpleName}")
                try { record?.release() } catch (_: Throwable) {}
                try { codec?.release() } catch (_: Throwable) {}
                promise.reject("AUDIO_START", "Aufnahme nicht startbar", e)
            }
        }
    }

    /** Beendet die Aufnahme -> { base64, durationMs } (ADTS/AAC). */
    @ReactMethod
    fun stopRecording(promise: Promise) {
        val r = synchronized(this) { rec.also { rec = null } }
        if (r == null) { promise.reject("AUDIO_IDLE", "Keine Aufnahme"); return }
        Thread({
            try {
                r.stop = true
                r.thread?.join(5000)
                if (r.error != null) throw r.error!!
                val bytes = r.out.toByteArray()
                val durationMs = r.samples * 1000L / SAMPLE_RATE
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                bytes.fill(0)
                wipe(r.out)
                promise.resolve(Arguments.createMap().apply {
                    putString("base64", b64)
                    putDouble("durationMs", durationMs.toDouble())
                })
            } catch (e: Throwable) {
                Log.w(TAG, "Aufnahme nicht abschliessbar: ${e.javaClass.simpleName}")
                wipe(r.out)
                promise.reject("AUDIO_STOP", "Aufnahme nicht abschliessbar", e)
            }
        }, "malachi-secure-rec-stop").start()
    }

    @ReactMethod
    fun cancelRecording(promise: Promise) {
        val r = synchronized(this) { rec.also { rec = null } }
        if (r == null) { promise.resolve(false); return }
        r.cancelled = true
        r.stop = true
        Thread({
            try { r.thread?.join(5000) } catch (_: Throwable) {}
            wipe(r.out)
            promise.resolve(true)
        }, "malachi-secure-rec-cancel").start()
    }

    private fun recordLoop(r: Recording) {
        val pcm = ShortArray(1024)
        val bytes = ByteArray(pcm.size * 2)
        val info = MediaCodec.BufferInfo()
        var peak = 0
        var lastLevel = System.currentTimeMillis()
        var eosSent = false
        try {
            while (true) {
                if (!eosSent) {
                    val limitReached = r.samples * 1000L / SAMPLE_RATE >= MAX_RECORD_MS
                    if (r.stop || limitReached) {
                        val idx = r.codec.dequeueInputBuffer(10_000)
                        if (idx >= 0) {
                            r.codec.queueInputBuffer(idx, 0, 0, presentationUs(r.samples), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            eosSent = true
                        }
                    } else {
                        val n = r.record.read(pcm, 0, pcm.size)
                        if (n > 0) {
                            for (i in 0 until n) {
                                val s = pcm[i].toInt()
                                peak = max(peak, abs(s))
                                bytes[i * 2] = (s and 0xFF).toByte()
                                bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
                            }
                            var off = 0
                            val len = n * 2
                            while (off < len) {
                                val idx = r.codec.dequeueInputBuffer(10_000)
                                if (idx < 0) { drain(r, info); continue }
                                val buf = r.codec.getInputBuffer(idx) ?: continue
                                buf.clear()
                                val chunk = min(buf.remaining(), len - off)
                                buf.put(bytes, off, chunk)
                                val chunkSamples = chunk / 2
                                r.codec.queueInputBuffer(idx, 0, chunk, presentationUs(r.samples), 0)
                                r.samples += chunkSamples
                                off += chunk
                            }
                            val now = System.currentTimeMillis()
                            if (now - lastLevel >= PROGRESS_MS) {
                                emitLevel(peak)
                                peak = 0
                                lastLevel = now
                            }
                        }
                    }
                }
                if (drain(r, info)) break
                if (eosSent) Thread.sleep(5)
            }
        } catch (e: Throwable) {
            r.error = e
        } finally {
            pcm.fill(0)
            bytes.fill(0)
            try { r.record.stop() } catch (_: Throwable) {}
            try { r.record.release() } catch (_: Throwable) {}
            try { r.codec.stop() } catch (_: Throwable) {}
            try { r.codec.release() } catch (_: Throwable) {}
        }
    }

    /** Holt fertige AAC-Rahmen ab. true = Ende des Datenstroms erreicht. */
    private fun drain(r: Recording, info: MediaCodec.BufferInfo): Boolean {
        while (true) {
            val idx = r.codec.dequeueOutputBuffer(info, 0)
            if (idx < 0) return false
            val buf = r.codec.getOutputBuffer(idx)
            val config = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
            if (buf != null && info.size > 0 && !config && !r.cancelled) {
                val frame = ByteArray(info.size)
                buf.position(info.offset)
                buf.get(frame, 0, info.size)
                r.out.write(adtsHeader(info.size))
                r.out.write(frame)
                frame.fill(0)
            }
            r.codec.releaseOutputBuffer(idx, false)
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return true
        }
    }

    private fun presentationUs(samples: Long) = samples * 1_000_000L / SAMPLE_RATE

    /** ADTS-Kopf (7 Byte) fuer AAC-LC, 16 kHz, mono. */
    private fun adtsHeader(payloadLen: Int): ByteArray {
        val len = payloadLen + 7
        val profile = 2        // AAC LC
        val chan = 1
        return byteArrayOf(
            0xFF.toByte(),
            0xF1.toByte(),
            (((profile - 1) shl 6) or (FREQ_INDEX_16K shl 2) or (chan shr 2)).toByte(),
            (((chan and 3) shl 6) or (len shr 11)).toByte(),
            ((len and 0x7FF) shr 3).toByte(),
            (((len and 7) shl 5) or 0x1F).toByte(),
            0xFC.toByte(),
        )
    }

    private fun emitLevel(peak: Int) {
        val db = if (peak <= 0) -160.0 else 20.0 * log10(peak / 32767.0)
        emit(LEVEL_EVENT, Arguments.createMap().apply { putDouble("db", db) })
    }

    /** ByteArrayOutputStream gibt seinen internen Puffer nicht heraus - neu beschreiben, dann leeren. */
    private fun wipe(out: ByteArrayOutputStream) {
        try {
            val size = out.size()
            out.reset()
            if (size > 0) out.write(ByteArray(size))
            out.reset()
        } catch (_: Throwable) {}
    }

    // ─── Wiedergabe ─────────────────────────────────────────────────────────

    private class MemorySource(val data: ByteArray) : MediaDataSource() {
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (position >= data.size) return -1
            val n = min(size.toLong(), data.size - position).toInt()
            System.arraycopy(data, position.toInt(), buffer, offset, n)
            return n
        }
        override fun getSize(): Long = data.size.toLong()
        override fun close() {}
    }

    private var player: MediaPlayer? = null
    private var playData: ByteArray? = null
    private var playId: String? = null
    private var speed = 1.0f

    private val ticker = object : Runnable {
        override fun run() {
            val p = player ?: return
            try {
                if (p.isPlaying) emitPlayback(playId, p.currentPosition, p.duration, finished = false)
            } catch (_: Throwable) {}
            main.postDelayed(this, PROGRESS_MS)
        }
    }

    /** Spielt Base64-Audio aus dem Arbeitsspeicher. startMs: Startposition. */
    @ReactMethod
    fun play(id: String, base64: String, startMs: Double, rate: Double, promise: Promise) {
        main.post {
            releasePlayer()
            var data: ByteArray? = null
            try {
                data = Base64.decode(base64, Base64.DEFAULT)
                val p = MediaPlayer()
                p.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                p.setDataSource(MemorySource(data))
                p.setOnCompletionListener {
                    val d = try { it.duration } catch (_: Throwable) { 0 }
                    val doneId = playId
                    releasePlayer()
                    emitPlayback(doneId, d, d, finished = true)
                }
                p.setOnErrorListener { _, _, _ ->
                    val errId = playId
                    releasePlayer()
                    emitPlayback(errId, 0, 0, finished = true, error = true)
                    true
                }
                p.prepare()
                speed = rate.toFloat().coerceIn(0.5f, 3.0f)
                if (startMs > 0) p.seekTo(startMs.toInt())
                p.start()
                if (speed != 1.0f) applySpeed(p)
                player = p
                playData = data
                playId = id
                main.removeCallbacks(ticker)
                main.postDelayed(ticker, PROGRESS_MS)
                promise.resolve(p.duration.toDouble())
            } catch (e: Throwable) {
                Log.w(TAG, "Wiedergabe nicht startbar: ${e.javaClass.simpleName}")
                data?.fill(0)
                releasePlayer()
                promise.reject("AUDIO_PLAY", "Wiedergabe nicht startbar", e)
            }
        }
    }

    @ReactMethod
    fun pause(promise: Promise) {
        main.post {
            try { player?.takeIf { it.isPlaying }?.pause(); promise.resolve(true) } catch (e: Throwable) { promise.resolve(false) }
        }
    }

    @ReactMethod
    fun resume(promise: Promise) {
        main.post {
            try {
                val p = player
                if (p != null) { p.start(); if (speed != 1.0f) applySpeed(p) }
                promise.resolve(p != null)
            } catch (e: Throwable) { promise.resolve(false) }
        }
    }

    @ReactMethod
    fun seek(ms: Double, promise: Promise) {
        main.post {
            try { player?.seekTo(ms.toInt()); promise.resolve(player != null) } catch (e: Throwable) { promise.resolve(false) }
        }
    }

    @ReactMethod
    fun setSpeed(rate: Double, promise: Promise) {
        main.post {
            speed = rate.toFloat().coerceIn(0.5f, 3.0f)
            try { player?.let { if (it.isPlaying) applySpeed(it) } } catch (_: Throwable) {}
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        main.post {
            releasePlayer()
            promise.resolve(true)
        }
    }

    private fun applySpeed(p: MediaPlayer) {
        try { p.playbackParams = p.playbackParams.setSpeed(speed) } catch (_: Throwable) {}
    }

    private fun releasePlayer() {
        main.removeCallbacks(ticker)
        val p = player
        player = null
        playId = null
        try { p?.stop() } catch (_: Throwable) {}
        try { p?.release() } catch (_: Throwable) {}
        playData?.fill(0)
        playData = null
    }

    private fun emitPlayback(id: String?, position: Int, duration: Int, finished: Boolean, error: Boolean = false) {
        emit(PLAYBACK_EVENT, Arguments.createMap().apply {
            putString("id", id ?: "")
            putDouble("position", position.toDouble())
            putDouble("duration", duration.toDouble())
            putBoolean("finished", finished)
            putBoolean("error", error)
        })
    }

    private fun emit(name: String, map: WritableMap) {
        try {
            if (!reactApplicationContext.hasActiveReactInstance()) return
            reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, map)
        } catch (_: Throwable) {}
    }

    // NativeEventEmitter erwartet diese beiden Methoden.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}

    override fun invalidate() {
        main.post { releasePlayer() }
        synchronized(this) {
            rec?.let { it.cancelled = true; it.stop = true }
            rec = null
        }
        super.invalidate()
    }
}
