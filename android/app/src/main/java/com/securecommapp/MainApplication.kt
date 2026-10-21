package com.securecommapp

import android.app.Application
import com.securecommapp.calling.MalachiCallPackage
import com.securecommapp.clipboard.MalachiClipboardPackage
import com.securecommapp.license.MalachiLicensePackage
import com.securecommapp.siegel.MalachiSiegelPackage
import com.securecommapp.tor.MalachiTorPackage
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(KyberPackage())
          add(MalachiServicePackage())
          add(MalachiNotificationPackage())
          add(MalachiCallPackage())
          add(FileSharePackage())
          add(MalachiTorPackage())
          add(MalachiLicensePackage())
          add(MalachiSiegelPackage())
          add(MalachiClipboardPackage())
          add(AppIconPackage())
          add(ScreenSecurityPackage())
          // Vertriebsvariante fuer JS (Distribution.js) - in beiden Flavors.
          add(MalachiBuildPackage())
          // Flavor-eigene Module: "play" = Google Play Billing, "web" = keine
          // (src/<flavor>/java/com/securecommapp/FlavorPackages.kt).
          addAll(FlavorPackages.packages())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Im Tor-Prozess (":tor", MalachiTorProcessService) laeuft nur tor -
    // kein React Native, keine App-Dienste.
    val proc = if (android.os.Build.VERSION.SDK_INT >= 28) Application.getProcessName()
      else runCatching { java.io.File("/proc/self/cmdline").readText().trim('\u0000') }.getOrDefault("")
    if (proc.endsWith(":tor")) return
    loadReactNative(this)
  }
}
