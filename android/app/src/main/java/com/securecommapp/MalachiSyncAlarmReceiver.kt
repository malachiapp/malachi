package com.securecommapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3c): Empfaenger des periodischen
// AlarmManager-Ticks. Die eigentliche Logik (Vordergrund-Pruefung, Neu-
// planen, Headless-Task starten) steht in MalachiService.onSyncAlarm(),
// damit der gesamte Mechanismus an einer Stelle nachvollziehbar bleibt.
// Ein BroadcastReceiver statt PendingIntent.getService(): so laeuft die
// Vordergrund-Pruefung garantiert VOR jedem Start von
// MalachiHeadlessTaskService, und ein Alarm nach Prozesstod startet nicht
// ungefragt einen Service. Nicht exportiert - nur der eigene PendingIntent
// (AlarmManager sendet ihn im Namen dieser App) erreicht ihn.
class MalachiSyncAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != MalachiService.ACTION_SYNC_TICK) return
        MalachiService.onSyncAlarm(context)
    }
}
