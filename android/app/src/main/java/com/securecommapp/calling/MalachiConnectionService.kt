package com.securecommapp.calling

import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Self-managed ConnectionService für Malachi.
 * Braucht NUR android.permission.MANAGE_OWN_CALLS (kein Carrier/READ_PHONE_STATE),
 * liefert dafür native Anruf-UI, Bluetooth/Auto-Support und CallStyle-Notifications.
 *
 * contactId ist dieselbe geteilte Kontakt-ID, die auch relay.js /call/signal und
 * CallManager.js verwenden (analog zu eurem bestehenden /reconnect/offer/{contactId}) -
 * kein separates "sessionId"-Konzept mehr, um beide Seiten synchron zu halten.
 *
 * TODO: In AndroidManifest.xml registrieren (siehe AndroidManifest-additions.xml)
 * und TelecomHelper.registerPhoneAccount(context) einmalig beim App-Start aufrufen
 * (z.B. in MainApplication.onCreate()).
 */
class MalachiConnectionService : ConnectionService() {

    companion object {
        const val EXTRA_CONTACT_ID = "contact_id"
        const val EXTRA_PEER_NAME = "peer_name"
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val contactId = extras.getString(EXTRA_CONTACT_ID)
        val fallbackName = getString(com.securecommapp.R.string.call_unknown_contact)
        val connection = MalachiConnection(applicationContext).apply {
            this.contactId = contactId
            setCallerDisplayName(
                "Malachi", // Audit 2026-10-19 (P6): kein Kontaktname an Telecom (Sperrbildschirm, Auto, Uhr)
                TelecomManager.PRESENTATION_ALLOWED
            )
            setRinging()
            setAudioModeIsVoip(true)
        }
        if (contactId != null) TelecomHelper.trackConnection(contactId, connection)
        return connection
    }

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val contactId = extras.getString(EXTRA_CONTACT_ID)
        val fallbackName = getString(com.securecommapp.R.string.call_unknown_contact)
        val connection = MalachiConnection(applicationContext).apply {
            this.contactId = contactId
            setCallerDisplayName(
                "Malachi", // Audit 2026-10-19 (P6): kein Kontaktname an Telecom (Sperrbildschirm, Auto, Uhr)
                TelecomManager.PRESENTATION_ALLOWED
            )
            setDialing()
            setAudioModeIsVoip(true)
        }
        if (contactId != null) TelecomHelper.trackConnection(contactId, connection)
        return connection
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        // z.B. wenn parallel schon ein echtes Telefonat läuft - für v1 nur loggen,
        // JS bekommt sonst kein Signal und der Anrufer läuft in den Ring-Timeout.
    }
}
