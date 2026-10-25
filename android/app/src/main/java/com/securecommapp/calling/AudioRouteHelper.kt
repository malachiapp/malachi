package com.securecommapp.calling

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * Lautsprecher an/aus fuer 1:1- und Gruppenanrufe (CallBridgeModule.setSpeaker,
 * MalachiCallAudioModule.setSpeaker).
 *
 * Laeuft ein Telecom-Anruf (MalachiConnection), bestimmt Telecom das Audio-
 * Routing - ein AudioManager-Umschalten wuerde dort sofort wieder ueberschrieben.
 * Dann also ueber die Connection umschalten. Ohne Connection (Telecom nicht
 * verfuegbar oder Registrierung gescheitert) direkt ueber den AudioManager.
 */
object AudioRouteHelper {

    @JvmStatic
    fun setSpeaker(context: Context, on: Boolean): Boolean {
        if (TelecomHelper.setSpeakerRoute(on)) return true
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (on) {
                    val speaker = am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    speaker != null && am.setCommunicationDevice(speaker)
                } else {
                    am.clearCommunicationDevice()
                    true
                }
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = on
                true
            }
        } catch (e: Exception) {
            android.util.Log.w("Malachi", "Lautsprecher umschalten fehlgeschlagen (" + e.javaClass.simpleName + ")")
            false
        }
    }
}
