package com.securecommapp.clipboard

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Zwischenablage mit Schutz (SecureClipboard.js):
 *  - Inhalt als "sensibel" markiert (ClipDescription.EXTRA_IS_SENSITIVE, ab
 *    Android 13; davor derselbe Schluessel als Text). Android zeigt dann keine
 *    Vorschau, Tastaturen wie Gboard nehmen ihn nicht in ihren Verlauf auf.
 *  - Leeren nur, wenn noch genau unser Inhalt drinsteht (fremdes, spaeter
 *    Kopiertes bleibt unangetastet). Im Hintergrund darf eine App die
 *    Zwischenablage nicht lesen - dann wird nichts geleert (JS versucht es
 *    beim naechsten Oeffnen der App erneut).
 * Der Inhalt wird nirgends geloggt.
 */
class MalachiClipboardModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MalachiClipboard"

    private fun manager(): ClipboardManager? =
        reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

    @ReactMethod
    fun setSensitive(text: String, promise: Promise) {
        try {
            val cm = manager() ?: return promise.reject("NO_CLIPBOARD", "Zwischenablage nicht verfuegbar")
            val clip = ClipData.newPlainText("Malachi", text)
            val extras = PersistableBundle()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            } else {
                extras.putBoolean("android.content.extra.IS_SENSITIVE", true)
            }
            clip.description.extras = extras
            cm.setPrimaryClip(clip)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CLIPBOARD_FAILED", "Kopieren fehlgeschlagen")
        }
    }

    /**
     * Leert die Zwischenablage, wenn sie noch genau [text] enthaelt.
     * "geleert" | "anders" (inzwischen etwas anderes kopiert) | "unklar"
     * (leer oder - App im Hintergrund - nicht lesbar).
     */
    @ReactMethod
    fun clearIfEquals(text: String, promise: Promise) {
        try {
            val cm = manager() ?: return promise.resolve("unklar")
            val clip = cm.primaryClip
            if (clip == null || clip.itemCount == 0) return promise.resolve("unklar")
            val current = clip.getItemAt(0).coerceToText(reactApplicationContext)?.toString()
            if (current != text) return promise.resolve("anders")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) cm.clearPrimaryClip()
            else cm.setPrimaryClip(ClipData.newPlainText("", ""))
            promise.resolve("geleert")
        } catch (e: Exception) {
            promise.resolve("unklar")
        }
    }
}
