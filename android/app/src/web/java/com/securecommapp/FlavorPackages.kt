package com.securecommapp

import com.facebook.react.ReactPackage
import com.securecommapp.update.MalachiUpdaterPackage

/**
 * Website-Variante (Flavor "web"): signierte In-App-Updates von der eigenen
 * Website (update/MalachiUpdaterModule.kt, nur in diesem Flavor enthalten).
 * Insbesondere KEIN Google Play Billing - die Bibliothek ist nur als
 * playImplementation eingebunden und fehlt in dieser APK ganz.
 * Gegenstueck mit gleichem Namen: src/play/java/com/securecommapp/FlavorPackages.kt
 */
object FlavorPackages {
    fun packages(): List<ReactPackage> = listOf(MalachiUpdaterPackage())
}
