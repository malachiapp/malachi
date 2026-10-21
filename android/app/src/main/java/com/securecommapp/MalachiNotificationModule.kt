package com.securecommapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MalachiNotificationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "MalachiNotification"

    private val CHANNEL_ID = "malachi_messages"
    private var notifId = 0

    init {
        createChannel()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Texte aus res/values*/strings.xml (Geraetesprache); ein erneutes
            // createNotificationChannel aktualisiert Name/Beschreibung.
            val channel = NotificationChannel(
                CHANNEL_ID,
                reactApplicationContext.getString(R.string.notif_channel_messages),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = reactApplicationContext.getString(R.string.notif_channel_messages_desc)
                enableVibration(true)
            }
            val manager = reactApplicationContext
                .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    // Unveraendert parameterlos (App.tsx ruft sie ohne Argument auf) - eine
    // Signaturaenderung auf showNotification(peerName) wuerde jeden
    // bestehenden Null-Argument-Aufruf aus JS mit "got 0 arguments, expected
    // 1" scheitern lassen (RN prueft die Argumentanzahl bei nativen Modulen).
    @ReactMethod
    fun showNotification() {
        postMessageNotification(null)
    }

    // Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3a): vom Headless-Task (index.js)
    // mit dem lokalen Kontaktnamen aufgerufen.
    @ReactMethod
    fun showNotificationFor(peerName: String?) {
        postMessageNotification(peerName)
    }

    private fun postMessageNotification(peerName: String?) {
        val context = reactApplicationContext
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        val pendingIntent = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        // Audit 2026-10-19 (P6): IMMER ohne Kontaktnamen. Die publicVersion
        // greift nur, wenn der Nutzer "sensible Inhalte ausblenden" gewaehlt
        // hat - mit der Standardeinstellung stand der Name sonst lesbar auf dem
        // Sperrbildschirm. Der Name ist ein Metadatum (wer schreibt mir).
        val text = context.getString(R.string.notif_new_message)
        val publicVersion = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_malachi)
            .setContentTitle("Malachi")
            .setContentText(context.getString(R.string.notif_new_message))
            .build()
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_malachi)
            .setContentTitle("Malachi")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()

        val manager = context
            .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Eigener Tag: ohne ihn teilte sich diese fortlaufende ID (0, 1, 2, ...)
        // den Namensraum mit der Dienst-Benachrichtigung von MalachiService
        // (NOTIF_ID = 1) - die zweite Nachrichten-Benachrichtigung hat die
        // Dauer-Benachrichtigung des Foreground Service dadurch ersetzt.
        // Mit dem Headless-Pfad kommen solche Benachrichtigungen jetzt
        // deutlich haeufiger vor.
        manager.notify(NOTIF_TAG, notifId++, notification)
    }

    /**
     * Alle Benachrichtigungen der App entfernen (Audit 2026-10-19, P2) -
     * beim Loeschen aller Daten bzw. nach der Notfall-PIN darf keine
     * "Neue Nachricht"/Anruf-Benachrichtigung in der Leiste stehen bleiben.
     */
    @ReactMethod
    fun cancelAll() {
        try {
            val manager = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.cancelAll()
        } catch (_: Throwable) {
        }
    }

    private companion object {
        const val NOTIF_TAG = "malachi_msg"
    }
}