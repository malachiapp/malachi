package com.securecommapp.calling

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.securecommapp.MainActivity

/**
 * Notification für eingehende/laufende Anrufe.
 *
 * HINWEIS: Nutzt bewusst KEIN NotificationCompat.CallStyle - das würde eine
 * neuere androidx.core-Version voraussetzen, die dieses Projekt noch nicht hat.
 * Stattdessen: normale Notification mit zwei Action-Buttons (Annehmen/Ablehnen),
 * funktional identisch, nur ohne die spezielle grün/rot-System-Optik.
 * Kann später nachgerüstet werden, wenn ihr androidx.core auf >= 1.9.0 anhebt.
 */
object CallNotificationHelper {

    const val CHANNEL_ID = "malachi_calls"
    private const val NOTIF_ID = 9001

    const val ACTION_ANSWER = "com.securecommapp.calling.ACTION_ANSWER"
    const val ACTION_DECLINE = "com.securecommapp.calling.ACTION_DECLINE"
    const val EXTRA_CONTACT_ID = "contact_id"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, context.getString(com.securecommapp.R.string.call_channel_name), NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(com.securecommapp.R.string.call_channel_desc)
                setShowBadge(false)
            }
            context.getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    fun showIncoming(context: Context, contactId: String, peerName: String) {
        ensureChannel(context)

        val answerIntent = actionPendingIntent(context, ACTION_ANSWER, contactId, 0)
        val declineIntent = actionPendingIntent(context, ACTION_DECLINE, contactId, 1)

        val fullScreenIntent = PendingIntent.getActivity(
            context, 2,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("incoming_call_contact_id", contactId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            // Audit 2026-10-19 (P6): ohne Kontaktnamen - die Benachrichtigung
            // steht auf dem Sperrbildschirm, in der Leiste und auf verbundenen
            // Uhren. Wer anruft, zeigt die App selbst.
            .setContentTitle(context.getString(com.securecommapp.R.string.call_notif_title))
            .setContentText(context.getString(com.securecommapp.R.string.call_incoming_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .addAction(0, context.getString(com.securecommapp.R.string.call_action_decline), declineIntent)
            .addAction(0, context.getString(com.securecommapp.R.string.call_action_answer), answerIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .setOngoing(true)
            .setAutoCancel(false)
            .build()

        NotificationManagerCompat.from(context).notify(NOTIF_ID, notification)
    }

    fun showOngoing(context: Context, contactId: String, peerName: String) {
        ensureChannel(context)
        val hangupIntent = actionPendingIntent(context, ACTION_DECLINE, contactId, 3)

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(context.getString(com.securecommapp.R.string.call_notif_title))
            .setContentText(context.getString(com.securecommapp.R.string.call_ongoing_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .addAction(0, context.getString(com.securecommapp.R.string.call_action_hangup), hangupIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .build()

        NotificationManagerCompat.from(context).notify(NOTIF_ID, notification)
    }

    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIF_ID)
    }

    private fun actionPendingIntent(context: Context, action: String, contactId: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, CallActionReceiver::class.java).apply {
            this.action = action
            putExtra(EXTRA_CONTACT_ID, contactId)
        }
        return PendingIntent.getBroadcast(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
