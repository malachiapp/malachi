package com.securecommapp

import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Nutzerwunsch: empfangene/gesendete Dateien oeffnen bzw. an eine andere App
 * weiterreichen (z.B. "in Downloads speichern", "mit Viewer X oeffnen").
 * RNs eingebautes Share-Modul unterstuetzt auf Android AUSSCHLIESSLICH reinen
 * Text (title/message) - kein Datei-Anhang, "url" wird dort schlicht
 * ignoriert (siehe ShareModule.kt in node_modules/react-native). Ein rohes
 * file://-URI direkt per Intent an eine andere App weiterzureichen wirft ab
 * Android 7 (API 24) eine FileUriExposedException - FileProvider wandelt den
 * Pfad stattdessen in ein befristet freigegebenes content://-URI um (siehe
 * AndroidManifest.xml <provider> + res/xml/file_paths.xml).
 */
class FileShareModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "FileShareModule"

    @ReactMethod
    fun shareFile(path: String, mimeType: String, title: String, promise: Promise) {
        try {
            val file = File(path)
            val authority = "${reactApplicationContext.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(reactApplicationContext, authority, file)

            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType.ifBlank { "application/octet-stream" }
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val chooser = Intent.createChooser(intent, title).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("file_share_error", e.message, e)
        }
    }
}
