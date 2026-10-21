package com.securecommapp

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import android.os.Build
import android.os.Bundle
import android.view.WindowManager

class MainActivity : ReactActivity() {

  companion object {
    // Bildschirmschutz (ScreenSecurityModule): Standard an; nur JS schaltet ihn
    // ab (Vollversion + Einstellung). Ein neuer Prozess beginnt wieder mit "an".
    @Volatile @JvmStatic var secureWindow = true
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (secureWindow) {
      window.setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE
      )
    }
    // Vorschau in der App-Uebersicht immer leer - auch wenn Screenshots
    // erlaubt sind (ab Android 13; davor deckt das nur FLAG_SECURE ab).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      try { setRecentsScreenshotEnabled(false) } catch (_: Throwable) {}
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SecureCommApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
