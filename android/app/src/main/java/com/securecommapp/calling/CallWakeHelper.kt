package com.securecommapp.calling

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.securecommapp.MainActivity

/**
 * Zeigt eine Vollbild-Notification, sobald ein FCM-Wecksignal für einen
 * eingehenden Anruf ankommt. Kennt (absichtlich, wegen FCM-Opazität) noch
 * keinen Anrufernamen - das holt die App gleich beim Start selbst nach.
 * Wird automatisch weggeräumt, sobald CallManager.js den echten Anruf
 * gefunden hat (siehe CallBridgeModule.reportIncomingCall).
 */
object CallWakeHelper {

    private const val WAKE_NOTIF_ID = 9002

    fun showWakeNotification(context: Context) {
        CallNotificationHelper.ensureChannel(context)

        val launchIntent = PendingIntent.getActivity(
            context, 4,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CallNotificationHelper.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("Malachi")
            .setContentText(context.getString(com.securecommapp.R.string.call_wake_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(launchIntent, true)
            .setContentIntent(launchIntent)
            .setAutoCancel(true)
            .build()

        NotificationManagerCompat.from(context).notify(WAKE_NOTIF_ID, notification)
    }

    fun cancelWakeNotification(context: Context) {
        NotificationManagerCompat.from(context).cancel(WAKE_NOTIF_ID)
    }
}
