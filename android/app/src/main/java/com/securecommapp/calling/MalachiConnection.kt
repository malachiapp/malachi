package com.securecommapp.calling

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.OutcomeReceiver
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.CallEndpointException
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.util.Log
import androidx.annotation.RequiresApi
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

    // ── Lautsprecher (AudioRouteHelper) ──────────────────────────────────────
    // Ab Android 14 laeuft das Routing ueber CallEndpoints (setAudioRoute ist dort
    // veraltet); davor ueber setAudioRoute. Beim Ausschalten geht es zurueck auf
    // Bluetooth (falls vorher aktiv), sonst kabelgebundenes Headset, sonst Hoerer.

    private var endpoints: List<CallEndpoint> = emptyList()
    private var currentEndpointType: Int? = null
    private var endpointBeforeSpeaker: Int? = null
    private var routeBeforeSpeaker: Int = CallAudioState.ROUTE_EARPIECE

    fun setSpeaker(on: Boolean): Boolean = try {
        if (Build.VERSION.SDK_INT >= 34 && endpoints.isNotEmpty()) speakerViaEndpoint(on) else speakerViaRoute(on)
    } catch (e: Exception) {
        Log.w("Malachi", "Telecom: Lautsprecher nicht umschaltbar (" + e.javaClass.simpleName + ")")
        false
    }

    @Suppress("DEPRECATION")
    private fun speakerViaRoute(on: Boolean): Boolean {
        val audioState = callAudioState ?: return false
        val mask = audioState.supportedRouteMask
        val target = if (on) CallAudioState.ROUTE_SPEAKER else when {
            routeBeforeSpeaker == CallAudioState.ROUTE_BLUETOOTH && mask and CallAudioState.ROUTE_BLUETOOTH != 0 -> CallAudioState.ROUTE_BLUETOOTH
            mask and CallAudioState.ROUTE_WIRED_HEADSET != 0 -> CallAudioState.ROUTE_WIRED_HEADSET
            else -> CallAudioState.ROUTE_EARPIECE
        }
        if (mask and target == 0) return false
        if (on && audioState.route != CallAudioState.ROUTE_SPEAKER) routeBeforeSpeaker = audioState.route
        setAudioRoute(target)
        return true
    }

    @RequiresApi(34)
    private fun speakerViaEndpoint(on: Boolean): Boolean {
        fun pick(type: Int) = endpoints.firstOrNull { it.endpointType == type }
        val target = if (on) pick(CallEndpoint.TYPE_SPEAKER) else
            (if (endpointBeforeSpeaker == CallEndpoint.TYPE_BLUETOOTH) pick(CallEndpoint.TYPE_BLUETOOTH) else null)
                ?: pick(CallEndpoint.TYPE_WIRED_HEADSET) ?: pick(CallEndpoint.TYPE_EARPIECE)
        if (target == null) return false
        if (on) currentEndpointType?.let { if (it != CallEndpoint.TYPE_SPEAKER) endpointBeforeSpeaker = it }
        requestCallEndpointChange(target, context.mainExecutor, object : OutcomeReceiver<Void, CallEndpointException> {
            override fun onResult(result: Void?) {}
            override fun onError(error: CallEndpointException) {
                Log.w("Malachi", "Telecom: Audio-Ausgang nicht gewechselt (Code " + error.code + ")")
            }
        })
        return true
    }

    @RequiresApi(34)
    override fun onAvailableCallEndpointsChanged(availableEndpoints: MutableList<CallEndpoint>) {
        endpoints = availableEndpoints.toList()
    }

    @RequiresApi(34)
    override fun onCallEndpointChanged(callEndpoint: CallEndpoint) {
        currentEndpointType = callEndpoint.endpointType
        // Dieselben Werte wie CallAudioState.route, damit JS nur eine Darstellung kennt.
        val route = when (callEndpoint.endpointType) {
            CallEndpoint.TYPE_SPEAKER -> CallAudioState.ROUTE_SPEAKER
            CallEndpoint.TYPE_BLUETOOTH -> CallAudioState.ROUTE_BLUETOOTH
            CallEndpoint.TYPE_WIRED_HEADSET -> CallAudioState.ROUTE_WIRED_HEADSET
            else -> CallAudioState.ROUTE_EARPIECE
        }
        CallBridgeModule.emitAudioState(route)
    }
}
