package com.securecommapp

import android.content.ComponentName
import android.content.pm.PackageManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * "App-Icon passend zum Design" (THEMES.md, Abschnitt "App-Icon").
 *
 * Der Launcher-Eintrag liegt auf activity-alias-Eintraegen von MainActivity
 * (AndroidManifest.xml, erzeugt von tools/gen-theme-icons.js), je Icon-Variante
 * einer; aktiv ist immer genau einer. Umschalten = Komponenten an/aus per
 * PackageManager.setComponentEnabledSetting (wie Telegrams alternative Icons):
 *
 *  - ZUERST das neue Alias einschalten, DANN die anderen aus - so gibt es nie
 *    einen Moment ganz ohne Launcher-Eintrag (sonst verschwindet die App bei
 *    einem Absturz dazwischen aus dem Launcher).
 *  - DONT_KILL_APP: der Prozess (Dienst, P2P-Verbindungen) laeuft weiter.
 *  - Idempotent: ist das Ziel schon das einzige aktive Alias, passiert nichts.
 *  - Nur Ids aus der festen Liste AppIconVariants.IDS (erzeugt) - kein
 *    beliebiger Komponentenname von JS aus.
 *
 * MainActivity selbst wird nie angefasst: Deep Links und alle PendingIntents
 * (Benachrichtigungen, Anruf-Vollbild) zielen direkt auf sie.
 * JS-Seite: AppIcon.js (schaltet nur, wenn die App in den Hintergrund geht).
 */
class AppIconModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MalachiAppIcon"

    private fun component(id: String) = ComponentName(ctx.packageName, AppIconVariants.ALIAS_PREFIX + id)

    // COMPONENT_ENABLED_STATE_DEFAULT = wie im Manifest: dort ist nur DEFAULT an.
    private fun isEnabled(pm: PackageManager, id: String): Boolean =
        when (pm.getComponentEnabledSetting(component(id))) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> id == AppIconVariants.DEFAULT
            else -> false
        }

    private fun current(pm: PackageManager): String =
        AppIconVariants.IDS.firstOrNull { isEnabled(pm, it) } ?: AppIconVariants.DEFAULT

    @ReactMethod
    fun getIcon(promise: Promise) {
        try {
            promise.resolve(synchronized(LOCK) { current(ctx.packageManager) })
        } catch (e: Exception) {
            promise.reject("app_icon_error", e.message, e)
        }
    }

    @ReactMethod
    fun setIcon(id: String?, promise: Promise) {
        if (id == null || id !in AppIconVariants.IDS) {
            promise.reject("app_icon_unknown", "Unbekannte Icon-Variante")
            return
        }
        try {
            synchronized(LOCK) {
                val pm = ctx.packageManager
                if (!isEnabled(pm, id)) {
                    pm.setComponentEnabledSetting(
                        component(id),
                        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                        PackageManager.DONT_KILL_APP,
                    )
                }
                for (other in AppIconVariants.IDS) {
                    if (other != id && isEnabled(pm, other)) {
                        pm.setComponentEnabledSetting(
                            component(other),
                            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                            PackageManager.DONT_KILL_APP,
                        )
                    }
                }
            }
            promise.resolve(id)
        } catch (e: Exception) {
            promise.reject("app_icon_error", e.message, e)
        }
    }

    companion object {
        private val LOCK = Any()
    }
}

class AppIconPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(AppIconModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
