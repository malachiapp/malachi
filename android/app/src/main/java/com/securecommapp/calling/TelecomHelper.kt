package com.securecommapp.calling

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Registriert Malachi als self-managed PhoneAccount und bietet die
 * Aufrufe, die CallBridgeModule (von JS) und CallActionReceiver (von der
 * Notification) nutzen.
 *
 * WICHTIG: Die Registrierung passiert absichtlich NICHT mehr beim App-Start
 * (das hat "SecurityException: does not have android.permission.MANAGE_OWN_CALLS"
 * verursacht - vermutlich weil die Berechtigung so früh im Prozess-Lebenszyklus
 * noch nicht vollständig vom System durchgereicht ist). Stattdessen: faule
 * Registrierung erst unmittelbar vor dem ersten tatsächlichen Anruf.
 */
object TelecomHelper {

    private const val ACCOUNT_ID = "malachi_self_managed"
    private val activeConnections = mutableMapOf<String, MalachiConnection>()
    private var accountRegistered = false

    private fun ensureRegistered(context: Context) {
        if (accountRegistered) return
        try {
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            val account = PhoneAccount.builder(phoneAccountHandle(context), "Malachi")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build()
            telecomManager.registerPhoneAccount(account)
            accountRegistered = true
        } catch (e: Exception) {
            android.util.Log.e("Malachi", "PhoneAccount-Registrierung fehlgeschlagen", e)
        }
    }

    private fun phoneAccountHandle(context: Context): PhoneAccountHandle {
        val componentName = ComponentName(context, MalachiConnectionService::class.java)
        return PhoneAccountHandle(componentName, ACCOUNT_ID)
    }

    // Audit 2026-10-19 (A5): Telecom-Aufrufe koennen werfen (z. B. SecurityException,
    // wenn die Registrierung scheiterte) - in einer void-@ReactMethod waere das im
    // Release ein Absturz der App, ausgeloest schon durch einen eingehenden Anruf.
    // Faellt Telecom aus, laeuft der Anruf ueber die App-eigene Oberflaeche weiter.
    fun placeOutgoingCall(context: Context, contactId: String, peerName: String) {
        try {
            placeOutgoingCallUnchecked(context, contactId, peerName)
        } catch (e: Throwable) {
            android.util.Log.w("Malachi", "Telecom: ausgehender Anruf nicht gemeldet (" + e.javaClass.simpleName + ")")
        }
    }

    fun addIncomingCall(context: Context, contactId: String, peerName: String) {
        try {
            addIncomingCallUnchecked(context, contactId, peerName)
        } catch (e: Throwable) {
            android.util.Log.w("Malachi", "Telecom: eingehender Anruf nicht gemeldet (" + e.javaClass.simpleName + ")")
        }
    }

    private fun placeOutgoingCallUnchecked(context: Context, contactId: String, peerName: String) {
        ensureRegistered(context)
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return
        val extras = Bundle().apply {
            putString(MalachiConnectionService.EXTRA_CONTACT_ID, contactId)
            putString(MalachiConnectionService.EXTRA_PEER_NAME, peerName)
        }
        val callExtras = Bundle().apply {
            putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, phoneAccountHandle(context))
            putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, extras)
        }
        // Uri-Schema "tel" ist hier nur ein Telecom-Formalismus - contactId ist eure
        // interne Kontakt-ID, keine echte Rufnummer, es wird kein Telefonnetz genutzt.
        telecomManager.placeCall(Uri.fromParts("tel", contactId, null), callExtras)
    }

    private fun addIncomingCallUnchecked(context: Context, contactId: String, peerName: String) {
        ensureRegistered(context)
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return
        val extras = Bundle().apply {
            putString(MalachiConnectionService.EXTRA_CONTACT_ID, contactId)
            putString(MalachiConnectionService.EXTRA_PEER_NAME, peerName)
        }
        telecomManager.addNewIncomingCall(phoneAccountHandle(context), extras)
    }

    fun markActive(contactId: String) {
        activeConnections[contactId]?.setActive()
    }

    fun endCall(context: Context, contactId: String) {
        activeConnections[contactId]?.apply {
            setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
            destroy()
        }
        activeConnections.remove(contactId)
        CallNotificationHelper.cancel(context)
    }

    fun trackConnection(contactId: String, connection: MalachiConnection) {
        activeConnections[contactId] = connection
    }

    /** Lautsprecher fuer laufende Telecom-Anrufe umschalten; false, wenn keiner laeuft. */
    fun setSpeakerRoute(on: Boolean): Boolean {
        var applied = false
        for (connection in activeConnections.values.toList()) {
            if (connection.state == Connection.STATE_DISCONNECTED) continue
            if (connection.setSpeaker(on)) applied = true
        }
        return applied
    }

    // --- Von CallActionReceiver aufgerufen (Tap auf Annehmen/Ablehnen in der Notification) ---

    fun answerFromNotification(contactId: String) {
        // Ruft dieselbe Logik wie onAnswer() auf - kein doppelter Code nötig,
        // Connection.onAnswer() ist eine normale, von außen aufrufbare Methode.
        activeConnections[contactId]?.onAnswer()
    }

    fun declineOrHangupFromNotification(contactId: String) {
        val connection = activeConnections[contactId] ?: return
        if (connection.state == Connection.STATE_RINGING) {
            connection.onReject()
        } else {
            connection.onDisconnect()
        }
    }
}
