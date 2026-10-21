package com.securecommapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.uimanager.ViewManager

/**
 * Build-Angaben fuer JS (Distribution.js, PLAY_STORE.md):
 *  - distribution: Gradle-Flavor der Dimension "vertrieb" - "web" (APK von
 *    der eigenen Website, Shop) oder "play" (Google Play, Play Billing).
 *  - applicationId: eigener Paketname (Play-Kaufpruefung vergleicht ihn mit
 *    dem signierten packageName eines Kaufs).
 * Reine Konstanten, keine Methoden, keine Berechtigungen.
 */
class MalachiBuildModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MalachiBuild"

    override fun getConstants(): Map<String, Any> = mapOf(
        "distribution" to BuildConfig.FLAVOR,
        "applicationId" to reactApplicationContext.packageName,
        "versionName" to BuildConfig.VERSION_NAME,
        "versionCode" to BuildConfig.VERSION_CODE,
    )
}

class MalachiBuildPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(MalachiBuildModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
