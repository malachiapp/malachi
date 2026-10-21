package com.securecommapp.calling

import android.content.Context
import android.content.Intent
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import com.securecommapp.MainActivity

/**
 * Eine einzelne Telecom-Connection. Spiegelt nur den Anruf-Zustand fürs
 * System-UI (Sperrbildschirm, Bluetooth, Notification) - die eigentliche
 * WebRTC-Arbeit passiert weiterhin in CallManager.js.
 */
class MalachiConnection(private val context: Context) : Connection() {

    var contactId: String? = null

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        connectionCapabilities = CAPABILITY_SUPPORT_HOLD or CAPABILITY_MUTE
    }

    // WICHTIG bei self-managed ConnectionServices: das System zeigt KEINE eigene
    // Anruf-UI automatisch (anders als bei normalen Telefonie-Apps). Dieser Callback
    // ist der Moment, in dem WIR die CallStyle-Notification selbst bauen müssen.
    override fun onShowIncomingCallUi() {
        val id = contactId ?: return
        CallNotificationHelper.showIncoming(
            context, id, callerDisplayName?.toString() ?: context.getString(com.securecommapp.R.string.call_unknown_contact)
        )
    }

    override fun onAnswer() {
        setActive()
        contactId?.let {
            CallNotificationHelper.showOngoing(context, it, callerDisplayName?.toString() ?: context.getString(com.securecommapp.R.string.call_unknown_contact))
        }
        // Live-Test-Fund 2026-09-28: war bei geschlossener App (headless
        // erkanntes Offer, siehe BackgroundSync.js checkIncomingCallSignal)
        // bisher der fehlende letzte Schritt - CallBridgeModule.
        // emitFromNative() erreicht zwar den weiterhin lebenden ReactContext
        // (haengt an keiner Activity), aber ohne gemountetes App() sah der
        // Nutzer nach dem Antippen von "Annehmen" nur den Sperrbildschirm statt
        // des CallScreens. MainActivity holt App() nach vorne, wo CallManager.js
        // das gepufferte Offer (RTCStore.takeBufferedCallSignal) uebernimmt.
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        }
        context.startActivity(launchIntent)
        CallBridgeModule.emitFromNative("nativeCallAnswered", contactId)
    }

    override fun onReject() {
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        CallNotificationHelper.cancel(context)
        destroy()
        CallBridgeModule.emitFromNative("nativeCallRejected", contactId)
    }

    override fun onDisconnect() {
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        CallNotificationHelper.cancel(context)
        destroy()
        CallBridgeModule.emitFromNative("nativeCallEnded", contactId)
    }

    override fun onAbort() {
        setDisconnected(DisconnectCause(DisconnectCause.CANCELED))
        CallNotificationHelper.cancel(context)
        destroy()
        CallBridgeModule.emitFromNative("nativeCallCancelled", contactId)
    }

    override fun onCallAudioStateChanged(state: CallAudioState) {
        // Lautsprecher/Bluetooth-Wechsel über System-UI -> an JS spiegeln, falls die
        // In-App-UI (CallScreen.tsx) den Status anzeigen soll.
        CallBridgeModule.emitAudioState(state.route)
    }
}
