package com.securecommapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

// Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3e): startet MalachiService nach einem
// Geraete-Neustart wieder - bisher blieb der P2P-Empfang nach jedem Neustart
// bis zum naechsten manuellen Oeffnen der App aus.
//
// Nur, wenn der Dienst vorher bewusst gestartet war: MalachiServiceModule.
// start() (von App.tsx ausschliesslich nach abgeschlossenem Setup aufgerufen)
// setzt dafuer ein eigenes natives SharedPreferences-Flag, stop() loescht es.
// Bewusst KEIN Auslesen von AsyncStorage/EncryptedStorage aus Kotlin heraus
// (waere von deren Interna abhaengig, und EncryptedStorage ist verschluesselt).
//
// Zusaetzlich MY_PACKAGE_REPLACED: nach einem App-Update beendet Android den
// Prozess, und START_STICKY greift dabei NICHT - ohne das bliebe der Dienst
// nach jedem Update bis zum naechsten Oeffnen aus. Beide Broadcasts gehoeren
// zu den Ausnahmen, die ab Android 12 einen Foreground-Service-Start aus dem
// Hintergrund erlauben; "remoteMessaging" ist zudem keiner der FGS-Typen,
// die Android 15 fuer BOOT_COMPLETED-Starts sperrt.
//
// android:exported="false" (Manifest): beide Broadcasts sendet das System
// selbst, das erreicht auch nicht exportierte Receiver - fremde Apps nicht.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val enabled = context
            .getSharedPreferences(MalachiService.PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(MalachiService.PREF_START_ON_BOOT, false)
        if (!enabled) return
        try {
            ContextCompat.startForegroundService(
                context,
                Intent(context, MalachiService::class.java)
            )
            Log.d("Malachi", "MalachiService nach $action neu gestartet")
        } catch (e: Exception) {
            // z.B. ForegroundServiceStartNotAllowedException - dann startet der
            // Dienst eben erst beim naechsten Oeffnen der App (bisheriges
            // Verhalten), statt hier abzustuerzen.
            Log.w("Malachi", "Neustart von MalachiService nach $action verweigert", e)
        }
    }
}
