package com.securecommapp

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MalachiServiceModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MalachiService"

    @ReactMethod
    fun start() {
        // Stufe 2 (Plan 3e): natives "Dienst soll laufen"-Flag fuer
        // BootReceiver. App.tsx ruft start() nur nach abgeschlossenem Setup auf.
        ctx.getSharedPreferences(MalachiService.PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putBoolean(MalachiService.PREF_START_ON_BOOT, true)
            .apply()
        val intent = Intent(ctx, MalachiService::class.java)
        // Audit 2026-10-19 (A5): Ab Android 12 darf ein Foreground Service aus
        // dem Hintergrund nicht starten (ForegroundServiceStartNotAllowedException)
        // - ungefangen waere das ein Absturz. Der naechste Start im Vordergrund
        // bzw. BootReceiver/Alarm holt es nach.
        try {
            ContextCompat.startForegroundService(ctx, intent)
        } catch (e: Throwable) {
            android.util.Log.w("MalachiService", "Dienst konnte nicht gestartet werden (" + e.javaClass.simpleName + ")")
        }
    }

    @ReactMethod
    fun stop() {
        // Gewollter Stopp (Logout/Wipe, bzw. der Headless-Task in index.js,
        // wenn das Geraet nicht mehr eingerichtet ist) - dann auch nach einem
        // Neustart nicht wieder hochfahren.
        ctx.getSharedPreferences(MalachiService.PREFS_NAME, Context.MODE_PRIVATE).edit()
            .remove(MalachiService.PREF_START_ON_BOOT)
            .apply()
        // Vor stopService() setzen, damit MalachiService.onDestroy() diesen
        // gewollten Stopp (Logout/Wipe) nicht faelschlich als "unerwartet
        // beendet" vermerkt.
        MalachiService.intentionalStop = true
        val wasRunning = ctx.stopService(Intent(ctx, MalachiService::class.java))
        // Lief der Dienst gar nicht, kommt auch kein onDestroy(), das die Flag
        // zuruecksetzt - sonst wuerde der NAECHSTE, echte unerwartete Stopp
        // faelschlich als gewollt verbucht.
        if (!wasRunning) MalachiService.intentionalStop = false
        MalachiService.cancelSync(ctx)
    }

    // Liefert den Zeitstempel des letzten UNGEWOLLTEN Dienst-Stopps (Wisch-
    // Geste auf die Benachrichtigung, oder ein Systemabbruch, den
    // onTaskRemoved() nicht ueberleben konnte) und loescht ihn danach - App.tsx
    // zeigt darauf einmalig einen Hinweis, dass P2P-Nachrichten in dieser Zeit
    // nicht empfangen wurden. null, wenn seit dem letzten Abruf kein
    // unerwarteter Stopp passiert ist.
    @ReactMethod
    fun consumeUnexpectedStopTimestamp(promise: Promise) {
        try {
            val prefs = ctx.getSharedPreferences(MalachiService.PREFS_NAME, Context.MODE_PRIVATE)
            val ts = prefs.getLong(MalachiService.PREF_UNEXPECTED_STOP_TS, -1L)
            if (ts >= 0) {
                prefs.edit().remove(MalachiService.PREF_UNEXPECTED_STOP_TS).apply()
                promise.resolve(ts.toDouble())
            } else {
                promise.resolve(null)
            }
        } catch (e: Exception) {
            promise.reject("E_UNEXPECTED_STOP", e)
        }
    }
}