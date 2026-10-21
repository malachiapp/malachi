package com.securecommapp

import com.facebook.react.ReactPackage
import com.securecommapp.billing.PlayBillingPackage

/**
 * Google-Play-Variante (Flavor "play"): zusaetzlich Google Play Billing
 * (PlayBillingModule, JS: PlayBilling.js). Gegenstueck mit gleichem Namen:
 * src/web/java/com/securecommapp/FlavorPackages.kt
 */
object FlavorPackages {
    fun packages(): List<ReactPackage> = listOf(PlayBillingPackage())
}
