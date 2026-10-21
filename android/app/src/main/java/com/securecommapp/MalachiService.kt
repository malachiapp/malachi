package com.securecommapp

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.ReactApplication
import com.facebook.react.common.LifecycleState

class MalachiService : Service() {
    companion object {
        const val CHANNEL_ID = "malachi_service"
        const val NOTIF_ID   = 1
        const val PREFS_NAME = "malachi_service_prefs"
        const val PREF_UNEXPECTED_STOP_TS = "unexpected_stop_ts"
        // Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3e): eigenes natives Flag
        // "Dienst soll laufen", gesetzt von MalachiServiceModule.start() (das
        // App.tsx nur nach abgeschlossenem Setup aufruft), geloescht von
        // stop(). BootReceiver liest nur dieses Flag - bewusst NICHT
        // AsyncStorage/EncryptedStorage-Interna aus Kotlin heraus parsen.
        const val PREF_START_ON_BOOT = "start_on_boot"
        // Von MalachiServiceModule.stop() VOR dem stopService()-Aufruf gesetzt,
        // damit onDestroy() unten einen gewollten Stopp (Logout/Wipe) von einem
        // ungewollten (Benachrichtigung weggewischt, System killt den Prozess)
        // unterscheiden kann. Einfache In-Memory-Flag genuegt, da Modul und
        // Service im selben Prozess laufen.
        @Volatile var intentionalStop = false

        // ─── Stufe 2: periodischer Headless-Sync (Plan 3c) ─────────────────
        const val ACTION_SYNC_TICK = "com.securecommapp.action.SYNC_TICK"
        private const val SYNC_REQUEST_CODE = 4711
        private const val TAG = "Malachi"
        // Takt des Headless-Syncs, wenn die App NICHT im Vordergrund ist.
        // 8s = identisch zum checkOutgoing-Intervall in App.tsx (der Plantext
        // sagt noch 15s, das Intervall wurde inzwischen auf 8s verkuerzt) -
        // der Hintergrund reagiert damit so schnell wie die App selbst auf
        // wartende Reconnect-Offers. Zusaetzlicher Grund fuer < 10s:
        // AlarmManager "fuzzt" inexakte Alarme erst ab 10s Vorlauf
        // (AOSP AlarmManagerService.maxTriggerTime, MIN_FUZZABLE_INTERVAL) -
        // darunter wird auch ein inexakter setAndAllowWhileIdle()-Alarm
        // puenktlich zugestellt, ohne die Spezialberechtigung
        // SCHEDULE_EXACT_ALARM (ab Android 14 standardmaessig verweigert).
        // Unter 5s klemmt AlarmManager ohnehin (Mindestvorlauf), und
        // checkIncoming's 3s-Takt waere fuer Hintergrund-Weckungen
        // unverhaeltnismaessig akkuteuer. Im Doze-Modus drosselt Android
        // allow-while-idle-Alarme unabhaengig davon selbst (App-Quota) - das
        // ist gewollt und nicht umgehbar.
        const val SYNC_INTERVAL_MS = 8_000L
        // Haelt die CPU wach zwischen Alarm-Zustellung und dem Moment, in dem
        // HeadlessJsTaskService seinen eigenen Wakelock nimmt. Zeitlich
        // begrenzt, damit ein fehlgeschlagener Start nichts dauerhaft haelt.
        private const val HANDOFF_WAKELOCK_MS = 10_000L

        // true, solange diese Service-Instanz lebt (onStartCommand ..
        // onDestroy). Der Alarm-Receiver plant nur dann neu - ein nach
        // Prozesstod noch anstehender Alarm beendet die Kette so von selbst
        // (START_STICKY bzw. der naechste start() plant dann neu).
        @Volatile var isRunning = false
            private set

        // Ist die App gerade im Vordergrund (dann laufen App.tsx's eigene
        // Timer, und ein Headless-Task mit allowedInForeground=false wuerde
        // von RN mit einer NICHT abfangbaren IllegalStateException quittiert,
        // die die App abstuerzen laesst - siehe MalachiHeadlessTaskService)?
        //
        // Bewusst KEIN ProcessLifecycleOwner (androidx.lifecycle:lifecycle-
        // process): 1. RN wirft genau dann, wenn der ReactContext im Zustand
        // RESUMED ist - das hier direkt abzufragen ist exakt dasselbe
        // Kriterium, das den Absturz ausloest, statt einer Naeherung ueber
        // einen zweiten Lifecycle-Mechanismus (der zudem ON_STOP erst 700ms
        // verzoegert meldet). 2. Keine neue Gradle-Abhaengigkeit noetig.
        // Zusaetzlich (konservativ) die Prozess-Wichtigkeit: IMPORTANCE_
        // FOREGROUND (100) = eine Activity ist sichtbar - deckt den Kaltstart
        // ab, in dem die Activity schon oben ist, der ReactContext aber noch
        // nicht existiert. Ein reiner Foreground-Service-Prozess meldet
        // IMPORTANCE_FOREGROUND_SERVICE (125) und gilt damit korrekt als
        // "nicht im Vordergrund".
        fun isAppInForeground(context: Context): Boolean {
            val reactState = try {
                (context.applicationContext as? ReactApplication)
                    ?.reactHost?.currentReactContext?.lifecycleState
            } catch (e: Exception) {
                null
            }
            if (reactState == LifecycleState.RESUMED) return true
            val info = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(info)
            return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }

        private fun syncPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, MalachiSyncAlarmReceiver::class.java)
                .setAction(ACTION_SYNC_TICK)
            return PendingIntent.getBroadcast(
                context, SYNC_REQUEST_CODE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        // AlarmManager statt Handler/Runnable (Plan 3c): Handler-Timer werden
        // von Doze genauso eingefroren wie JS-setInterval - "AllowWhileIdle"
        // ist der Teil, der auch im Doze-Modus (gedrosselt) noch weckt.
        // Immer DERSELBE PendingIntent -> ein neuer Aufruf ersetzt einen noch
        // anstehenden Alarm, es entsteht nie eine zweite parallele Kette.
        // Exakt nur, wenn ohne Zusatzberechtigung erlaubt (< Android 12 bzw.
        // falls der Nutzer SCHEDULE_EXACT_ALARM je erteilt hat) - sonst
        // inexakt, was bei < 10s Vorlauf ohnehin praktisch puenktlich ist
        // (siehe SYNC_INTERVAL_MS).
        fun scheduleNextSync(context: Context, delayMs: Long = SYNC_INTERVAL_MS) {
            val am = context.getSystemService(AlarmManager::class.java) ?: return
            val pi = syncPendingIntent(context)
            val triggerAt = SystemClock.elapsedRealtime() + delayMs
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
                } else {
                    am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
                }
            } catch (e: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            }
        }

        fun cancelSync(context: Context) {
            context.getSystemService(AlarmManager::class.java)?.cancel(syncPendingIntent(context))
        }

        // Von MalachiSyncAlarmReceiver bei jedem Alarm aufgerufen.
        fun onSyncAlarm(context: Context) {
            if (!isRunning) {
                Log.d(TAG, "[HeadlessSync] Alarm ohne laufenden Dienst - Kette beendet")
                return
            }
            // Zuerst neu planen, damit ein Fehler weiter unten die Kette nie
            // abreissen laesst.
            scheduleNextSync(context)
            if (isAppInForeground(context)) return
            try {
                val pm = context.getSystemService(PowerManager::class.java)
                pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Malachi:SyncTick")
                    ?.acquire(HANDOFF_WAKELOCK_MS)
                context.startService(Intent(context, MalachiHeadlessTaskService::class.java))
            } catch (e: Exception) {
                // z.B. Hintergrund-Startverbot - dieser Tick entfaellt, der
                // naechste Alarm ist bereits geplant.
                Log.w(TAG, "[HeadlessSync] Start des Headless-Task-Service fehlgeschlagen", e)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.service_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.service_channel_desc)
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Malachi")
            .setContentText(getString(R.string.service_notif_text))
            .setSmallIcon(R.drawable.ic_stat_malachi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        isRunning = true
        // Stufe 2 (Plan 3c): periodischer Headless-Sync via AlarmManager.
        // War kurzzeitig deaktiviert (Live-Test 2026-09-27 zeigte ein
        // allmaehliches Einfrieren des JS-Threads nach laengerem
        // Hintergrundbetrieb) - Ursache gefunden und behoben: siehe
        // MalachiHeadlessTaskService.onHeadlessJsTaskFinish() (dort fehlte
        // im Erfolgsfall das Abmelden vom HeadlessJsTaskContext-Listener,
        // wodurch sich bei jedem Tick ein weiterer, nie entfernter Listener
        // auf dem geteilten Singleton ansammelte). Wieder aktiv - naechster
        // Hintergrundtest soll pruefen, ob das Einfrieren damit weg ist.
        scheduleNextSync(this)
        return START_STICKY
    }

    // Defensiv (Plan 3f): Android 15+ ruft onTimeout() fuer FGS-Typen mit
    // Laufzeitlimit (dataSync/mediaProcessing) auf und erwartet binnen
    // Sekunden stopSelf(), sonst beendet das System die App mit einem Fehler.
    // "remoteMessaging" hat laut Android-Doku kein solches Limit - dieser Pfad
    // sollte also nie laufen. Falls doch (anderes Geraeteverhalten als
    // dokumentiert), sauber beenden statt abzustuerzen; onDestroy() vermerkt
    // den Stopp dann als unerwartet, App.tsx zeigt beim naechsten Start den
    // bestehenden Hinweis. Bewusst KEIN automatischer Neustart: nach einem
    // Timeout verweigert Android den erneuten Start desselben FGS-Typs aus dem
    // Hintergrund ohnehin, bis der Nutzer die App oeffnet.
    // (Ersetzt die zwischenzeitliche Review-Fund-"M6"-Variante, die hier nach
    // stopSelf(startId) per startForegroundService() neu zu starten versuchte -
    // genau dieser Neustart ist nach einem Timeout nicht zulaessig.)
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Foreground-Service-Timeout (fgsType=$fgsType) - Dienst wird beendet")
        stopSelf()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Wegwischen aus "Zuletzt verwendet" beendet je nach Hersteller/Version
        // den Service samt Prozess - START_STICKY greift dann erst beim
        // naechsten System-Reclaim (oder gar nicht). Deshalb sofort selbst neu
        // starten, damit der Prozess weiterlebt. Ab Android 12 darf das System
        // einen Foreground-Service-Start aus dem Hintergrund verweigern
        // (ForegroundServiceStartNotAllowedException, eine
        // IllegalStateException) - dann bleibt es beim START_STICKY-Verhalten,
        // statt die App genau in diesem Moment abstuerzen zu lassen.
        try {
            ContextCompat.startForegroundService(
                applicationContext,
                Intent(applicationContext, MalachiService::class.java)
            )
        } catch (e: IllegalStateException) {
            android.util.Log.w("Malachi", "Neustart des Service nach onTaskRemoved verweigert", e)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // Live-Test 2026-09-27: Nutzer konnte die Dienst-Benachrichtigung per
        // Wisch-Geste entfernen, was den Dienst (und damit den P2P-Empfang)
        // beendete, ohne dass die App das je bemerkt oder gemeldet haette -
        // waehrenddessen eingehende Nachrichten kamen erst beim naechsten
        // manuellen Oeffnen an. Merkt sich hier einen Zeitstempel, sobald der
        // Dienst NICHT ueber den gewollten stop()-Aufruf (Logout/Wipe) beendet
        // wurde, damit App.tsx beim naechsten Start einen Hinweis zeigen kann.
        if (!intentionalStop) {
            try {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                    .putLong(PREF_UNEXPECTED_STOP_TS, System.currentTimeMillis())
                    .apply()
            } catch (e: Exception) {
                android.util.Log.w("Malachi", "Konnte unerwarteten Stopp nicht vermerken", e)
            }
        }
        intentionalStop = false
        // Periodischen Headless-Sync mit dem Dienst beenden - ohne laufenden
        // Foreground Service gibt es keinen Grund (und ab Android 12 oft auch
        // keine Erlaubnis) mehr, den Headless-Task aus dem Hintergrund zu starten.
        isRunning = false
        cancelSync(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}