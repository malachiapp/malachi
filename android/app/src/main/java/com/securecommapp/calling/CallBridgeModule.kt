package com.securecommapp.calling

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Brücke zwischen nativer Telecom-Anruf-UI und CallManager.js.
 *
 * JS -> Native: reportOutgoingCall/reportIncomingCall/reportCallActive/reportCallEnded,
 *               getFcmToken (für die Push-Registrierung beim Relay)
 * Native -> JS: DeviceEventEmitter-Events "nativeCallAnswered", "nativeCallRejected",
 *               "nativeCallEnded", "nativeCallCancelled", "nativeCallAudioState"
 */
class CallBridgeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private var instance: CallBridgeModule? = null

        fun emitFromNative(event: String, contactId: String?) {
            val params = Arguments.createMap().apply { putString("contactId", contactId) }
            instance?.sendEvent(event, params)
        }

        fun emitAudioState(route: Int) {
            val params = Arguments.createMap().apply { putInt("route", route) }
            instance?.sendEvent("nativeCallAudioState", params)
        }
    }

    init {
        instance = this
    }

    override fun getName() = "CallBridgeModule"

    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun reportOutgoingCall(contactId: String, peerName: String) {
        TelecomHelper.placeOutgoingCall(reactApplicationContext, contactId, peerName)
    }

    @ReactMethod
    fun reportIncomingCall(contactId: String, peerName: String) {
        // Der echte Anruf wurde gefunden - die generische Weck-Notification
        // (falls durch FCM ausgelöst) wird jetzt überflüssig.
        CallWakeHelper.cancelWakeNotification(reactApplicationContext)
        TelecomHelper.addIncomingCall(reactApplicationContext, contactId, peerName)
    }

    @ReactMethod
    fun reportCallActive(contactId: String) {
        TelecomHelper.markActive(contactId)
    }

    @ReactMethod
    fun reportCallEnded(contactId: String) {
        TelecomHelper.endCall(reactApplicationContext, contactId)
    }

    // React-Native-Boilerplate für NativeEventEmitter (kein Zusatzverhalten nötig)
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
