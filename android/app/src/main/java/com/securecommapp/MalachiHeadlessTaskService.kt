package com.securecommapp

import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.CopyOnWriteArraySet

// Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3b): fuehrt den JS-Headless-Task
// "MalachiBackgroundSync" (index.js -> BackgroundSync.js runIncomingCycle/
// runOutgoingCycle) aus - auch wenn MainActivity/App() nicht mehr existiert.
// Wird ausschliesslich von MalachiService (AlarmManager-Tick, siehe
// MalachiSyncAlarmReceiver) gestartet, und nur wenn die App NICHT im
// Vordergrund ist.
//
// allowedInForeground bleibt bewusst false: im Vordergrund laufen bereits
// App.tsx's eigene Timer (dieselben Zyklen). ABER: Live-Test 2026-09-27 hat
// gezeigt, was passiert, wenn ein Task trotzdem im Vordergrund startet -
// HeadlessJsTaskContext.startTask() wirft eine IllegalStateException
// ("Tried to start task ... while in foreground") INNERHALB eines
// UiThreadUtil.runOnUiThread-Runnables der RN-Basisklasse. Die landet
// ungefangen im Main-Looper und reisst die ganze App mit - ein try/catch um
// startService() beim Aufrufer kann das nicht abfangen.
//
// Deshalb zwei Schutzschichten:
//   1. MalachiService.isAppInForeground() wird VOR startService() geprueft
//      (MalachiSyncAlarmReceiver) - der Normalfall.
//   2. Hier: onStartCommand() selbst ueberschrieben, damit der eigentliche
//      startTask()-Aufruf in einem EIGENEN, abgefangenen Runnable laeuft.
//      Deckt das verbleibende Zeitfenster zwischen Pruefung 1 und dem echten
//      Task-Start ab - vor allem den Kaltstart (Prozess neu, ReactHost muss
//      erst initialisieren, das dauert Sekunden; oeffnet der Nutzer genau
//      dann die App, waere die Activity beim Task-Start schon RESUMED).
//      Statt eines Absturzes wird dieser eine Tick dann nur uebersprungen.
// Die Nachbildung folgt 1:1 HeadlessJsTaskService.startTask()/
// invokeStartTask() aus RN 0.86 (node_modules/react-native/ReactAndroid/.../
// HeadlessJsTaskService.kt) - nur mit try/catch um den Task-Start. Bei einem
// RN-Upgrade gegen die dortige Basisklasse gegenpruefen.
class MalachiHeadlessTaskService : HeadlessJsTaskService() {
    companion object {
        const val TASK_NAME = "MalachiBackgroundSync"
        // Obergrenze fuer einen einzelnen Durchlauf (danach beendet RN den Task
        // selbst, ohne Absturz). Deutlich ueber einem normalen Durchlauf
        // (ein paar Relay-GETs pro Kontakt + ggf. Offer-Versand, siehe
        // runOutgoingCycle-Rueckgabewert), aber begrenzt, damit ein haengender
        // Relay den Wakelock nicht unbegrenzt haelt. Ueberlappende Ticks sind
        // unkritisch: BackgroundSync.js' Zyklus-Sperren ueberspringen sie.
        const val TASK_TIMEOUT_MS = 15_000L
        private const val TAG = "Malachi"
    }

    // Eigene Buchfuehrung, weil die der Basisklasse (activeTasks) privat ist
    // und nur von deren startTask()-Pfad befuellt wird, den wir hier umgehen.
    private val ownActiveTasks: MutableSet<Int> = CopyOnWriteArraySet()

    // Exakt die Instanz merken, bei der addTaskEventListener() in
    // startTaskSafely() registriert wurde - fuer die spaetere Abmeldung in
    // onHeadlessJsTaskFinish() dieselbe Referenz verwenden, statt sie ueber
    // reactContext (koennte sich zwischenzeitlich geaendert haben) erneut
    // herzuleiten und so evtl. am falschen HeadlessJsTaskContext-Singleton
    // abzumelden.
    @Volatile private var registeredTaskContext: HeadlessJsTaskContext? = null

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        HeadlessJsTaskConfig(
            TASK_NAME,
            Arguments.createMap(),
            TASK_TIMEOUT_MS,
            false // allowedInForeground - siehe Kommentar oben
        )

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (MalachiService.isAppInForeground(this)) {
            Log.d(TAG, "[HeadlessSync] App im Vordergrund - Tick uebersprungen (Service)")
            if (ownActiveTasks.isEmpty()) stopSelf()
            return START_NOT_STICKY
        }
        val config = getTaskConfig(intent)
        acquireWakeLockNow(this)
        val context = reactContext
        if (context != null) {
            startTaskSafely(context, config)
        } else {
            // Kaltstart: JS-Kontext existiert noch nicht (Prozess vom System,
            // BootReceiver oder nach Wegwischen neu gestartet).
            val host = reactHost
            if (host == null) {
                Log.w(TAG, "[HeadlessSync] Kein ReactHost - Tick uebersprungen")
                if (ownActiveTasks.isEmpty()) stopSelf()
                return START_NOT_STICKY
            }
            host.addReactInstanceEventListener(object : ReactInstanceEventListener {
                override fun onReactContextInitialized(context: ReactContext) {
                    host.removeReactInstanceEventListener(this)
                    startTaskSafely(context, config)
                }
            })
            host.start()
        }
        // Bewusst NICHT START_REDELIVER_INTENT (Basisklasse): ein vom System
        // abgebrochener Poll-Tick muss nicht nachgeholt werden - der naechste
        // Alarm kommt ohnehin in wenigen Sekunden, und ein spaeter
        // wiederzugestellter Intent koennte genau dann eintreffen, wenn die App
        // inzwischen im Vordergrund ist.
        return START_NOT_STICKY
    }

    private fun startTaskSafely(context: ReactContext, config: HeadlessJsTaskConfig) {
        UiThreadUtil.runOnUiThread {
            val taskContext = HeadlessJsTaskContext.getInstance(context)
            taskContext.addTaskEventListener(this)
            registeredTaskContext = taskContext
            try {
                val taskId = taskContext.startTask(config)
                ownActiveTasks.add(taskId)
            } catch (e: RuntimeException) {
                // IllegalStateException "... while in foreground" (App wurde
                // zwischen Pruefung und Start geoeffnet) oder ein bereits
                // zerstoerter ReactContext - beides harmlos, naechster Tick
                // versucht es erneut. Kein Absturz.
                Log.w(TAG, "[HeadlessSync] Task-Start abgelehnt, Tick uebersprungen: ${e.message}")
                if (ownActiveTasks.isEmpty()) {
                    taskContext.removeTaskEventListener(this)
                    registeredTaskContext = null
                    stopSelf()
                }
            }
        }
    }

    override fun onHeadlessJsTaskFinish(taskId: Int) {
        // Nicht super aufrufen: deren activeTasks-Menge ist hier immer leer
        // und wuerde bei JEDEM beendeten Task sofort stopSelf() ausloesen,
        // auch wenn noch ein zweiter (ueberlappender) Tick laeuft.
        ownActiveTasks.remove(taskId)
        if (ownActiveTasks.isEmpty()) {
            // Live-Test-Fund 2026-09-27 (JS-Thread fror nach einer Weile im
            // Hintergrund komplett ein): addTaskEventListener(this) in
            // startTaskSafely() wurde bisher NUR im Fehlerfall wieder
            // entfernt (siehe dortiger catch-Zweig) - im Normalfall (jeder
            // erfolgreiche Zyklus) blieb der Listener fuer immer auf dem
            // GETEILTEN, ReactContext-weiten HeadlessJsTaskContext-Singleton
            // registriert, mit einer Referenz auf diese (gleich zerstoerte)
            // Service-Instanz. Bei einem Tick alle 8s summierte sich das
            // ueber eine laengere Hintergrund-Phase zu Dutzenden/Hunderten
            // nie entfernter Listener, die HeadlessJsTaskContext bei JEDEM
            // weiteren Task-Event (auf dem UI-Thread) alle der Reihe nach
            // aufruft - das erklaert das beobachtete allmaehliche Einfrieren
            // statt eines sofortigen Absturzes. Jetzt symmetrisch zum
            // Fehlerfall: hier ebenfalls entfernen.
            registeredTaskContext?.removeTaskEventListener(this)
            registeredTaskContext = null
            stopSelf()
        }
    }
}
