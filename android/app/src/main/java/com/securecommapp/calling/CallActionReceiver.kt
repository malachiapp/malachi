package com.securecommapp.calling

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Reagiert auf die Annehmen/Ablehnen-Buttons der CallStyle-Notification.
 * TODO: In AndroidManifest.xml registrieren (siehe AndroidManifest-additions.xml).
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val contactId = intent.getStringExtra(CallNotificationHelper.EXTRA_CONTACT_ID) ?: return
        when (intent.action) {
            CallNotificationHelper.ACTION_ANSWER -> TelecomHelper.answerFromNotification(contactId)
            CallNotificationHelper.ACTION_DECLINE -> TelecomHelper.declineOrHangupFromNotification(contactId)
        }
    }
}
