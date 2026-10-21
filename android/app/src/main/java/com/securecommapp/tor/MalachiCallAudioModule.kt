package com.securecommapp.tor

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Sprachanruf ueber den bestehenden Kanal (Tor oder direkt) - der letzte
 * Ausweg, wenn eine WebRTC-Medienverbindung nicht zustande kommt (z.B. 5G
 * gegen WLAN hinter Carrier-NAT, kein TURN-Server).
 *
 * Mikrofon (Sprachmodus mit Echo-Unterdrueckung) -> Opus 16 kHz ~16 kbit/s
 * (20-ms-Pakete) -> Ereignis "MalachiCallAudioFrame" an JS. JS verschluesselt
 * und schickt die Pakete ueber den Kanal (CallManager.js). Empfangene Pakete
 * kommen per play() zurueck -> Opus-Decoder -> Lautsprecher. Die
 * Wiedergabe-Warteschlange wird begrenzt, damit sich bei Tor-Schwankungen
 * keine immer groessere Verzoegerung aufbaut (lieber kurz etwas verwerfen).
 *
 * Braucht Android 10+ (Opus-Encoder im System).
 */
class MalachiCallAudioModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MalachiCallAudio"
        private const val MIME = "audio/opus"
        private const val SAMPLE_RATE = 16000
        private const val FRAME_BYTES = 640          // 20 ms, 16 kHz, mono, PCM16
        private const val BITRATE = 16000
        private const val MAX_PLAY_QUEUE = 20         // ~400 ms Puffer, darueber wird verworfen
        private const val PRE_SKIP = 312
    }

    @Volatile private var running = false
    @Volatile private var muted = false
    private var recorder: AudioRecord? = null
    private var encoder: MediaCodec? = null
    private var decoder: MediaCodec? = null
    private var track: AudioTrack? = null
    private var captureThread: Thread? = null
    private var playThread: Thread? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var previousAudioMode = AudioManager.MODE_NORMAL
    private val playQueue = LinkedBlockingQueue<ByteArray>(200)

    override fun getName() = "MalachiCallAudio"

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    private fun emitFrame(bytes: ByteArray) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("MalachiCallAudioFrame", Arguments.createMap().apply {
                    putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
        } catch (_: Exception) {}
    }

    @ReactMethod
    fun isSupported(promise: Promise) {
        promise.resolve(Build.VERSION.SDK_INT >= 29 && hasCodec(true) && hasCodec(false))
    }

    private fun hasCodec(encoder: Boolean): Boolean = try {
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
            info.isEncoder == encoder && info.supportedTypes.any { it.equals(MIME, ignoreCase = true) }
        }
    } catch (_: Exception) { false }

    @ReactMethod
    fun start(promise: Promise) {
        if (running) { promise.resolve(true); return }
        if (Build.VERSION.SDK_INT < 29) { promise.reject("AUDIO_UNSUPPORTED", "Android 10 oder neuer noetig"); return }
        if (ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            promise.reject("AUDIO_PERMISSION", "Mikrofon-Berechtigung fehlt"); return
        }
        try {
            val enc = MediaCodec.createEncoderByType(MIME)
            enc.configure(MediaFormat.createAudioFormat(MIME, SAMPLE_RATE, 1).apply {
                setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
            }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            enc.start()
            encoder = enc

            val dec = MediaCodec.createDecoderByType(MIME)
            dec.configure(MediaFormat.createAudioFormat(MIME, SAMPLE_RATE, 1).apply {
                setByteBuffer("csd-0", opusHead())
                setByteBuffer("csd-1", longBuffer(PRE_SKIP * 1_000_000_000L / 48000))
                setByteBuffer("csd-2", longBuffer(80_000_000L))
            }, null, null, 0)
            dec.start()
            decoder = dec

            val minIn = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minIn, FRAME_BYTES * 8))
            if (AcousticEchoCanceler.isAvailable()) aec = AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true }
            if (NoiseSuppressor.isAvailable()) ns = NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true }
            recorder = rec

            val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            previousAudioMode = am.mode
            am.mode = AudioManager.MODE_IN_COMMUNICATION

            playQueue.clear()
            muted = false
            running = true
            rec.startRecording()
            captureThread = Thread({ captureLoop() }, "malachi-call-capture").apply { start() }
            playThread = Thread({ playLoop() }, "malachi-call-play").apply { start() }
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "Start fehlgeschlagen: ${e.message}")
            releaseAll()
            promise.reject("AUDIO_START", e.message, e)
        }
    }

    private fun captureLoop() {
        val rec = recorder ?: return
        val enc = encoder ?: return
        val pcm = ByteArray(FRAME_BYTES)
        val info = MediaCodec.BufferInfo()
        var pts = 0L
        try {
            while (running) {
                var read = 0
                while (read < FRAME_BYTES && running) {
                    val n = rec.read(pcm, read, FRAME_BYTES - read)
                    if (n <= 0) break
                    read += n
                }
                if (!running || read < FRAME_BYTES) continue
                if (muted) java.util.Arrays.fill(pcm, 0)
                val inIdx = enc.dequeueInputBuffer(10_000)
                if (inIdx >= 0) {
                    enc.getInputBuffer(inIdx)?.apply { clear(); put(pcm) }
                    enc.queueInputBuffer(inIdx, 0, FRAME_BYTES, pts, 0)
                    pts += 20_000
                }
                while (true) {
                    val outIdx = enc.dequeueOutputBuffer(info, 0)
                    if (outIdx < 0) break
                    val buf = enc.getOutputBuffer(outIdx)
                    if (buf != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && !muted) {
                        val bytes = ByteArray(info.size)
                        buf.position(info.offset); buf.get(bytes)
                        emitFrame(bytes)
                    }
                    enc.releaseOutputBuffer(outIdx, false)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Aufnahme beendet: ${e.message}")
        }
    }

    private fun playLoop() {
        val dec = decoder ?: return
        val info = MediaCodec.BufferInfo()
        var pts = 0L
        try {
            while (running) {
                val frame = playQueue.poll(100, TimeUnit.MILLISECONDS)
                if (frame != null) {
                    val inIdx = dec.dequeueInputBuffer(10_000)
                    if (inIdx >= 0) {
                        dec.getInputBuffer(inIdx)?.apply { clear(); put(frame) }
                        dec.queueInputBuffer(inIdx, 0, frame.size, pts, 0)
                        pts += 20_000
                    }
                }
                while (true) {
                    val outIdx = dec.dequeueOutputBuffer(info, 0)
                    if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { ensureTrack(dec.outputFormat); continue }
                    if (outIdx < 0) break
                    val buf = dec.getOutputBuffer(outIdx)
                    if (buf != null && info.size > 0) {
                        if (track == null) ensureTrack(dec.outputFormat)
                        val pcm = ByteArray(info.size)
                        buf.position(info.offset); buf.get(pcm)
                        track?.write(pcm, 0, pcm.size)
                    }
                    dec.releaseOutputBuffer(outIdx, false)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Wiedergabe beendet: ${e.message}")
        }
    }

    private fun ensureTrack(format: MediaFormat) {
        if (track != null) return
        val rate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) format.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 48000
        val minOut = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder()
                .setSampleRate(rate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(minOut * 2)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build().apply { play() }
    }

    /** Empfangenes Opus-Paket abspielen (Base64). */
    @ReactMethod
    fun play(base64: String) {
        if (!running) return
        val bytes = try { Base64.decode(base64, Base64.NO_WRAP) } catch (_: Exception) { return }
        if (bytes.isEmpty() || bytes.size > 1500) return
        // Verzoegerung begrenzen: staut sich mehr als ~400 ms an, aeltestes verwerfen.
        while (playQueue.size >= MAX_PLAY_QUEUE) playQueue.poll()
        playQueue.offer(bytes)
    }

    @ReactMethod fun setMuted(value: Boolean) { muted = value }

    @ReactMethod
    fun setSpeaker(on: Boolean) {
        val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = on
    }

    @ReactMethod
    fun stop(promise: Promise) {
        releaseAll()
        promise.resolve(true)
    }

    private fun releaseAll() {
        running = false
        try { captureThread?.join(500) } catch (_: Exception) {}
        try { playThread?.join(500) } catch (_: Exception) {}
        captureThread = null; playThread = null
        try { recorder?.stop() } catch (_: Exception) {}
        try { recorder?.release() } catch (_: Exception) {}
        recorder = null
        try { aec?.release() } catch (_: Exception) {}
        try { ns?.release() } catch (_: Exception) {}
        aec = null; ns = null
        try { encoder?.stop() } catch (_: Exception) {}
        try { encoder?.release() } catch (_: Exception) {}
        encoder = null
        try { decoder?.stop() } catch (_: Exception) {}
        try { decoder?.release() } catch (_: Exception) {}
        decoder = null
        try { track?.stop() } catch (_: Exception) {}
        try { track?.release() } catch (_: Exception) {}
        track = null
        playQueue.clear()
        try {
            val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.mode = previousAudioMode
        } catch (_: Exception) {}
    }

    private fun opusHead(): ByteBuffer {
        val b = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
        b.put("OpusHead".toByteArray(Charsets.US_ASCII))
        b.put(1)                       // Version
        b.put(1)                       // Kanaele
        b.putShort(PRE_SKIP.toShort()) // Pre-Skip
        b.putInt(SAMPLE_RATE)          // urspruengliche Abtastrate
        b.putShort(0)                  // Ausgangsverstaerkung
        b.put(0)                       // Kanal-Mapping
        b.flip()
        return b
    }

    private fun longBuffer(v: Long): ByteBuffer =
        ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(v).apply { flip() }

    override fun invalidate() {
        releaseAll()
        super.invalidate()
    }
}
