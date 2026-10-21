package com.securecommapp.tor

import org.torproject.jni.TorService

/**
 * Tor in einem eigenen Prozess (":tor", siehe AndroidManifest).
 *
 * tor laesst sich pro Prozess nur EINMAL initialisieren - ein zweiter Start im
 * selben Prozess bricht in hs_circuitmap_init ab und reisst alles mit. Nach
 * einem Netzwechsel braucht man aber genau diesen Neustart: das alte tor kommt
 * im neuen Netz oft minutenlang nicht an Onion-Dienste heran (live gemessen),
 * ein frisches in ~20 s. Deshalb laeuft tor hier getrennt von der App, und der
 * Prozess beendet sich mit dem Dienst - der naechste Start ist ein frischer
 * Prozess. Die App steuert tor ueber dessen Control-Socket (MalachiTorModule).
 */
class MalachiTorProcessService : TorService() {
    override fun onDestroy() {
        try { super.onDestroy() } catch (_: Throwable) {}
        android.os.Process.killProcess(android.os.Process.myPid())
    }
}
