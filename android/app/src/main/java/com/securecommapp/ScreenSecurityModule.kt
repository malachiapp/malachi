package com.securecommapp

import android.view.WindowManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * Bildschirmschutz (ScreenSecurity.js): FLAG_SECURE an/aus.
 *  - Standard "an": MainActivity setzt den Schutz schon in onCreate, bevor JS
 *    laeuft. Nach einem Prozess-Neustart gilt wieder "an", bis JS die
 *    gespeicherte Einstellung (nur mit Vollversion "aus") anwendet.
 *  - Der zuletzt gesetzte Wunsch gilt auch fuer eine neu erzeugte Activity
 *    (MainActivity.secureWindow).
 *  - Die Vorschau in der App-Uebersicht bleibt ab Android 13 immer leer
 *    (MainActivity: setRecentsScreenshotEnabled(false)), auch bei "aus".
 */
class ScreenSecurityModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MalachiScreenSecurity"

    @ReactMethod
    fun setSecure(secure: Boolean) {
        MainActivity.secureWindow = secure
        val activity = ctx.getCurrentActivity() ?: return
        activity.runOnUiThread {
            try {
                if (secure) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } catch (_: Throwable) {
                // Fenster schon weg (Activity beendet) - die naechste setzt den Wunsch in onCreate.
            }
        }
    }
}

class ScreenSecurityPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(ScreenSecurityModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
