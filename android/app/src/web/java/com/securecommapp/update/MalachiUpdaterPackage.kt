package com.securecommapp.update

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * In-App-Updates (MalachiUpdaterModule) - NUR fuer die Web-Version. Beim
 * Zusammenfuehren mit dem Play-Flavor nur im Web-Flavor registrieren
 * (Google Play verbietet Selbst-Updates; AppUpdater.js prueft zusaetzlich
 * NativeModules.MalachiBuild.distribution).
 */
class MalachiUpdaterPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(MalachiUpdaterModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
