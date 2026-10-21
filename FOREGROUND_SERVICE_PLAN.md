# Umsetzungsplan: Android Foreground Service für zuverlässigen Hintergrundbetrieb (SecureCommApp)

## 0. Bestandsaufnahme (verifiziert im Code, nicht angenommen)

Bevor irgendetwas geplant wird: **ein Großteil der Bausteine existiert bereits**, nur unvollständig verdrahtet. Das ändert die Aufgabe von "neu bauen" zu "fertigstellen und absichern".

### 0.1 Foreground Service existiert bereits, tut aber nichts

- `android/app/src/main/java/com/securecommapp/MalachiService.kt` — ein vollständiger, funktionsfähiger `Service`, der einen `NotificationChannel` `"malachi_service"` mit `IMPORTANCE_LOW` anlegt (genau die unaufdringliche Gestaltung, die gefordert ist), `startForeground()` mit Titel "Malachi" / Text "Verbindung aktiv – Nachrichten werden empfangen" aufruft und `START_STICKY` zurückgibt.
- `MalachiServiceModule.kt` — Native-Module-Brücke mit `start()`/`stop()`, registriert in `MalachiServicePackage.kt`, eingehängt in `MainApplication.kt`.
- `App.tsx:465` ruft `MalachiService?.start()` beim Verlassen des Setup-Screens auf (`AsyncStorage.getItem('setup_done')`-Zweig).
- Manifest (`android/app/src/main/AndroidManifest.xml:59-63`) deklariert den Service bereits korrekt mit `android:foregroundServiceType="dataSync"`, passend zu `FOREGROUND_SERVICE_DATA_SYNC` (Zeile 11) — **das ist tatsächlich der bereits Play-Policy-konforme Zustand**, siehe der eigene Kommentar im Manifest (Zeilen 16-27), der sogar erklärt, warum `FOREGROUND_SERVICE_MICROPHONE`/`_PHONE_CALL` bewusst entfernt wurden, weil sie nirgends real genutzt werden.

**Das eigentliche Problem ist NICHT "kein Foreground Service vorhanden"**, sondern: der Service hält zwar den Prozess offen, aber **niemand hat verifiziert, dass die React-Komponente `App()` (und damit ihre `useEffect`-Timer für `checkIncoming`/`checkOutgoing`) beim Zerstören der Activity überhaupt am Leben bleibt** — dazu unten mehr (Abschnitt 1). Zusätzlich fehlen: `onTaskRemoved()`-Handling, Boot-Restart, Runtime-Permission-Anfrage für `POST_NOTIFICATIONS`, und die Notification wird nie aktualisiert, wenn tatsächlich eine Nachricht ankommt.

### 0.2 Der `calling/`-Präzedenzfall — sorgfältig gelesen, Ergebnis anders als erwartet

Das `calling/`-Package (`android/app/src/main/java/com/securecommapp/calling/`) verwendet **kein eigenes Foreground-Service-Pattern als Vorlage** — Anrufe funktionieren im Hintergrund über einen anderen Mechanismus, der sich nicht 1:1 übertragen lässt:

1. **Telecom-Framework übernimmt die Anruf-UI selbst.** `MalachiConnectionService.kt` ist ein `ConnectionService` (`android.telecom.ConnectionService`, Manifest Zeile 65-72), kein eigener Foreground Service — der Kommentar im Manifest (Zeile 20-22) bestätigt das explizit: *"der self-managed ConnectionService für Anrufe [...] startet gar keinen eigenen Foreground-Service (das Telecom-Framework übernimmt die Anruf-UI)"*. Für Messaging gibt es kein Telecom-Äquivalent — dieser Baustein ist für den vorliegenden Zweck nicht wiederverwendbar.
2. **Das eigentliche "Aufwecken bei geschlossener App" läuft über FCM**, und zwar bereits produktiv eingerichtet: `MalachiFirebaseMessagingService.kt` empfängt eine **opake** Data-only-Message (`data: { reason: "incoming_call" | "message" }`, siehe `pushSender.js:34-43`), zeigt bei `"incoming_call"` sofort eine Full-Screen-Intent-Notification (`CallWakeHelper.showWakeNotification`), die die App öffnet. Die eigentliche Anruf-Erkennung übernimmt danach wieder der normale JS-Poll-Loop (`App.tsx:357-400`, 2s-Intervall über `pollCallSignals`).
3. **`pushSender.js` existiert im Repo tatsächlich** (Root-Verzeichnis, vollständig implementiert, 51 Zeilen) — anders als die Aufgabenbeschreibung vermuten ließ, ist es keine fehlende Datei. Der Kommentar in `pushSender.js:1-18` und `relay.js:181-187` zeigt aber den eigentlichen Haken: `relay.js` lädt es nur per `try/catch` optional (`require('./pushSender')`), und laut Kommentar in `pushSender.js` kopiert das **Deploy-Skript nur `relay.js` selbst auf den Server, nicht `node_modules`/`pushSender.js`** — d.h. auf dem tatsächlich laufenden Heimserver ist FCM-Wake mit hoher Wahrscheinlichkeit **inaktiv**, obwohl der Code dafür vollständig vorbereitet ist. Das ist konsistent mit der Zero-Knowledge-Philosophie: FCM ist als rein opaker, optionaler "letzter Weckruf" konzipiert, nicht als Kernmechanismus — genau die Linie, die auch für den vorliegenden Plan gelten soll.

**Für den Nachrichtenfall ist FCM im Code aktuell sogar explizit als "reicht nicht extra" markiert**: `MalachiFirebaseMessagingService.kt:34-38`, Kommentar: *"Normaler Nachrichtenfall: reicht, wenn die App beim nächsten eigenen Poll-Zyklus die Nachricht findet - hier ist nichts Zusätzliches nötig"*. Das bestätigt, dass FCM im Projekt bereits bewusst auf die Anruf-Dringlichkeit beschränkt ist und für normale Nachrichten nicht als Wake-Pfad gedacht ist — dieser Plan hält sich an diese bestehende Linie und macht sie nicht zur Kernlösung für Nachrichten.

### 0.3 Der eigentlich relevante, bereits vorhandene Baustein: der Zero-Knowledge-Wake-WebSocket

Deutlich wichtiger als FCM für diesen Plan ist ein bereits fertig implementierter, FCM-unabhängiger Mechanismus, den die Aufgabenbeschreibung nicht erwähnte, den ich aber für zentral halte:

- `RelayClient.js:250-326` — ein WebSocket (`_connectWakeSocket()`), der beim Öffnen die Kontakt-IDs abonniert (`setWakeSubscriptions`) und bei `{type:'wake', for: contactId}` alle registrierten Listener (`onWake`) sofort feuert, mit exponentiellem Backoff-Reconnect und `NetInfo`-getriggertem Sofort-Reconnect bei Netzwechsel.
- Gegenstück auf dem Relay: `relay.js` Abschnitt "WEBSOCKET WAKE-SIGNAL (FCM-unabhängig)" (ab Zeile 197).
- Eingehängt in **allen drei** relevanten Poll-Loops in `App.tsx`: `checkIncomingCalls` (Zeile 398), `checkOutgoing` (Zeile 627), `checkIncoming` (Zeile 972) — jeweils `const unsub = onWake(() => checkXyz())`.
- Gestartet in `App.tsx:466` direkt nach `MalachiService?.start()`.

**Das bedeutet: Das Projekt hat bereits eine funktionierende, Google-freie Push-Alternative gebaut** (im Prinzip ein selbstgehosteter, sehr einfacher Web-Push). Das feste Poll-Intervall (8s/15s) ist nur noch die **Rückfalllinie**, falls der Socket gerade tot ist — bei offenem Socket kommt das Wake-Signal quasi in Echtzeit. Der limitierende Faktor ist nicht "wie oft pollen wir", sondern **"bleibt der WebSocket überhaupt offen, wenn die App im Hintergrund ist"** — und das hängt exakt an der Frage aus Abschnitt 1.

---

## 1. Die zentrale Architekturfrage — mit konkreter Antwort

**Frage aus der Aufgabe:** Soll der Foreground Service WebRTC/Krypto selbst übernehmen, oder nur den JS-Kontext am Leben halten?

**Antwort: JS-Kontext am Leben halten — Krypto/WebRTC-Duplizierung nach Kotlin ist für dieses Projekt nicht vertretbar.** Begründung anhand des tatsächlichen Codes:

- `RTCStore.js:428` exportiert ein **In-Memory-Singleton** (`export default new RTCStore()`), das pro Kontakt `RTCPeerConnection`-Objekte, Shared Secrets und Message-Listener (`setMessageListener`, Zeile 311-319) hält. Das lebt ausschließlich im laufenden JS-Kontext.
- Der komplette Reconnect-Automat (`WebRTCManager.js:391-440`, `oniceconnectionstatechange`) inkl. eines selbst gebauten ICE-Watchdogs (Kommentar Zeile 402-415: *"ICE blieb über 90+ Sekunden regungslos bei 'checking' hängen [...] kein weiterer Reconnect-Versuch fand je statt"*) ist reine JS-Ereignis-/Timer-Logik on top von `react-native-webrtc`.
- Die eigentliche Nachrichtenverarbeitung (`checkIncoming`, `App.tsx:645-970`) ist tief mit React-State verwoben (`setContacts`, `EncryptedStorage`, Replay-Schutz über `isFreshTimestamp`/`isNewerThanLastAcceptedSystemTs`, Handling für `secret_start`/`secret_end`/`delete_chat`/`clear_chat`/`device_wiped`).

Eine native Neuimplementierung dieser Logik in Kotlin würde bedeuten: Kyber/Hybrid-Krypto (`HybridCrypto.js`, `MessageCrypto.js`), das komplette Replay-/Freshness-Regelwerk und den ICE-Watchdog **zweimal pflegen** — mit realer Gefahr, dass beide Implementierungen auseinanderlaufen (genau die Art Bug-Klasse, die schon mehrfach in den `SECURITY_*`-Dokumenten des Projekts als Fund auftaucht). Das steht in keinem Verhältnis zum Nutzen. Die pragmatische, im RN-Ökosystem etablierte Lösung ist daher **HeadlessJS**, nicht Kotlin-Port.

### 1.1 Der Teil, der tatsächlich unklar ist und zuerst geklärt werden muss

Wichtig, und im bisherigen Gespräch noch nicht sauber auseinandergehalten: **"Foreground Service hält den Prozess am Leben" ist nicht dasselbe wie "App.tsx' `useEffect`-Timer laufen weiter".**

- `MainApplication.kt:13-24` verwendet `ReactHost`/`DefaultReactHost` (New Architecture, Bridgeless, RN `0.86.3` laut `package.json:23`, React `19.2.3`). Der `ReactHost` lebt als Application-Singleton — der JS-VM-Prozess selbst überlebt eine Activity-Zerstörung, solange der OS-Prozess nicht gekillt wird.
- **Aber:** `App()` in `App.tsx` ist eine normale React-Komponente, gemountet über die von `MainActivity` (`ReactActivity`, Standard-`DefaultReactActivityDelegate`, keine eigene `onDestroy()`-Überschreibung, siehe `MainActivity.kt`) verwaltete Root-View/Surface. Wird `MainActivity` von Android zerstört (Nutzer wischt die App aus "Zuletzt verwendet", oder das System reclaimt die Activity unter Speicherdruck), wird bei Standard-RN-Verhalten die an diese Surface gebundene Komponenten-Instanz **unmounted** — und damit laufen die `useEffect`-Cleanups (`clearInterval`, `unsub()`) und die Timer sterben, **auch wenn der Prozess durch den Foreground Service technisch weiterläuft.**

Das ist exakt der Punkt, den `MalachiService` in seiner heutigen Form NICHT löst: Er hält höchstens den Prozess vor OS-Doze/Freezing geschützt, aber nicht zwangsläufig die konkrete `App()`-Instanz mit ihren Timern am Leben, wenn die Activity separat zerstört wird.

**Das muss vor Stufe 2 an einem echten Gerät verifiziert werden** (nicht nur aus dem Code angenommen) — konkret: `MalachiService.start()` aufrufen, App in den Hintergrund schieben, aus "Zuletzt verwendet" wischen, per `adb logcat` beobachten, ob die `console.log`-Ausgaben aus `checkIncoming`/`checkOutgoing` weiterhin alle 8s/15s erscheinen. Das kann nicht abschließend aus dem Quellcode bewiesen werden, nur die Architekturrisiken benennen — das ist die ehrliche Grenze dieses Plans.

**Konsequenz für den Stufenplan:** Stufe 1 testet/härtet genau diese Annahme mit minimalem Aufwand. Stufe 2 baut den robusten Ersatzpfad (HeadlessJS), falls Stufe 1 zeigt, dass die Timer beim Activity-Tod tatsächlich sterben (wovon nach Kenntnis des Standard-RN-Verhaltens auszugehen ist).

---

## 2. Stufe 1 — Minimal, schnell, macht den bestehenden Service tatsächlich wirksam

Ziel: den bereits vorhandenen `MalachiService` so hart machen, dass er den häufigsten Fall abdeckt (Bildschirm aus / App im Hintergrund / kurz gewischt), **ohne** an `App.tsx`s Komponentenstruktur etwas zu ändern.

**1a. `MalachiService.kt` — `onTaskRemoved()` ergänzen.**
Aktuell fehlt jede Behandlung dafür, dass der Nutzer die App aus "Zuletzt verwendet" wischt. Android-Standardverhalten: Services ohne `onTaskRemoved()`-Override werden bei Task-Entfernung je nach Hersteller/Version oft mitsamt Prozess beendet. Ergänzen:
```kotlin
override fun onTaskRemoved(rootIntent: Intent?) {
    // Service (und damit Prozess) bewusst NICHT sterben lassen – sich selbst
    // sofort neu starten, damit START_STICKY nicht erst auf den naechsten
    // System-Reclaim wartet.
    val restartIntent = Intent(applicationContext, MalachiService::class.java)
    ContextCompat.startForegroundService(applicationContext, restartIntent)
    super.onTaskRemoved(rootIntent)
}
```
Das verhindert nicht, dass die `MainActivity` zerstört wird (das ist so gewollt/unvermeidbar), sorgt aber dafür, dass der **Prozess** überlebt.

**1b. `POST_NOTIFICATIONS` Runtime-Permission tatsächlich anfragen.**
Verifiziert: Manifest deklariert `POST_NOTIFICATIONS` (Zeile 29), aber **nirgends in `App.tsx` wird sie über `PermissionsAndroid.request` angefragt** (Grep über die gesamte Datei liefert nur Treffer für `RECORD_AUDIO`/`CAMERA`). Bei `targetSdkVersion 36` (Android 16) ist das Laufzeit-Permission-Modell seit Android 13 (API 33) für **alle** Notifications Pflicht — ohne Anfrage bleibt sowohl `MalachiNotification.showNotification()` als auch die Foreground-Service-Notification selbst für den Nutzer **unsichtbar**, obwohl der Code sie postet. Fix: In demselben `useEffect`-Block wie `MalachiService?.start()` (`App.tsx:459-468`) vor dem Start:
```js
if (Platform.OS === 'android' && Platform.Version >= 33) {
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}
```
Ohne das ist der gesamte restliche Plan im Effekt unsichtbar für den Nutzer — das ist keine Nebensächlichkeit, sondern ein Blocker.

**1c. `MalachiNotification` in `MalachiService`-Kanal integrieren statt zwei Notifications zu haben.**
Aktuell zwei getrennte Kanäle: `"malachi_service"` (Ongoing, LOW, in `MalachiService.kt`) und `"malachi_messages"` (HIGH, in `MalachiNotificationModule.kt`, aufgerufen über `App.tsx:98-101` `showNotification()`, aber nur wenn `AppState.currentState !== 'active'`). Das ist grundsätzlich schon die richtige Trennung (Threema/Signal machen es genauso: eine leise Dauerbenachrichtigung + separate, lautere Pro-Nachricht-Benachrichtigung) — **keine Änderung nötig**, nur in 2c die inhaltliche Verbesserung der Ongoing-Notification.

**1d. AndroidManifest: `RECEIVE_BOOT_COMPLETED` + `BootReceiver` (siehe Stufe 2, aber Permission kann schon hier ergänzt werden).**

**Aufwand Stufe 1:** klein (ein Kotlin-Override, eine JS-Permission-Anfrage, ein Manifest-Eintrag). **Realistischer Nutzen:** deckt den mit Abstand häufigsten Alltagsfall ab (Bildschirm aus, App im Hintergrund, nicht explizit weggewischt) zuverlässiger ab als heute, weil die Notification jetzt tatsächlich sichtbar ist und der Prozess nach Task-Removal aktiv neu gestartet wird.

---

## 3. Stufe 2 — Vollständige Lösung (HeadlessJS-Absicherung)

Ziel: Nachrichten auch dann verarbeiten, wenn die `MainActivity`/React-Root tatsächlich zerstört wurde (Stufe-1-Test negativ) — ohne `App.tsx` als Ganzes umzubauen.

**3a. `App.tsx`: `checkIncoming`-Kernlogik in ein wiederverwendbares, State-unabhängiges Modul extrahieren.**

Neue Datei `BackgroundSync.js` (Root-Verzeichnis, neben `RTCStore.js`/`RelayClient.js`). Extrahiert aus `App.tsx:645-970` (`checkIncoming`) und `App.tsx:527-627` (`checkOutgoing`) **nur den Teil, der bereits storage-getrieben statt React-State-getrieben ist**:
- Kontaktliste lesen (`AsyncStorage.getItem('contacts')`),
- System-Pakete abholen/entschlüsseln/validieren (Freshness/Order-Check, `delete_chat`/`clear_chat`/`secret_start`/`secret_end`/`device_wiped`),
- `EncryptedStorage`-Schreibvorgänge (Chatverlauf, Secret-Chat-Status),
- Reconnect-Offer/-Answer über `RelayClient.js`,
- `RTCStore`-Zugriffe (Shared Secret, Verbindungsaufbau).

Was **bewusst nicht** mitwandert und über einen Callback-Parameter injiziert wird: alles, was direkt React-State setzt (`setContacts`, `setChat`, Navigation `nav()`) — im Headless-Fall sind das No-ops, im Foreground-Fall die bestehenden Setter aus `App.tsx`. Konkret als Funktionssignatur:
```js
// BackgroundSync.js
export async function runIncomingCycle({ onContactsChanged, onNotifyMessage } = {}) { ... }
export async function runOutgoingCycle({ onContactsChanged } = {}) { ... }
```
`App.tsx`s bestehende `useEffect`-Blöcke rufen diese Funktionen nur noch auf und reichen ihre echten Setter als Callbacks durch — **die Effekte selbst, ihre Intervalle, der `onWake`-Hook bleiben strukturell unverändert**, es wird nur der Rumpf ausgelagert. Das ist der einzige echte Refactor in diesem Plan, geschätzter Umfang: Verschieben von ca. 250-350 Zeilen aus `App.tsx` nach `BackgroundSync.js`, keine Logikänderung.

Bei einer neuen Nachricht ruft `onNotifyMessage` im Headless-Fall `MalachiNotification.showNotification()` mit echtem Kontaktnamen auf (aktuell zeigt `MalachiNotificationModule.kt:52-59` fest den Text "Neue Nachricht" ohne Namen — sollte um einen Parameter erweitert werden: `showNotification(peerName: String?)`).

**3b. `MalachiHeadlessTaskService.kt` — neue Datei, `android/app/src/main/java/com/securecommapp/MalachiHeadlessTaskService.kt`.**
```kotlin
class MalachiHeadlessTaskService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? =
        HeadlessJsTaskConfig(
            "MalachiBackgroundSync",
            Arguments.createMap(),
            15_000L,   // Timeout, an checkOutgoing-Intervall angelehnt
            false       // kein "allowedInForeground" noetig, kein eigener FGS
        )
}
```
Registrierung im Manifest (neuer `<service>`-Eintrag, `android:exported="false"`).

**3c. `MalachiService.kt` erweitern: periodisch den Headless-Task antriggern.**
`MalachiService` bekommt einen internen `Handler`/`Runnable`, der alle 15s (an `checkOutgoing`-Takt angelehnt, siehe `App.tsx:626`) `MalachiHeadlessTaskService` per `Intent` startet — **nur wenn** `AppState`/Activity gerade nicht im Vordergrund ist (sonst laufen Foreground-Timer und Headless-Task parallel und verdoppeln Arbeit; Prüfung z.B. über `ProcessLifecycleOwner.get().lifecycle.currentState`). Alternative, robustere Variante: `AlarmManager.setExactAndAllowWhileIdle()` statt `Handler`, weil das explizit für Doze-taugliche periodische Weckung gedacht ist (`Handler`-Timer werden von Doze genauso gedrosselt wie JS-`setInterval`).

**3d. `index.js` — Headless-Task registrieren.**
```js
import { AppRegistry } from 'react-native';
import App from './App';
import { runIncomingCycle, runOutgoingCycle } from './BackgroundSync';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
AppRegistry.registerHeadlessTask('MalachiBackgroundSync', () => async () => {
  await runIncomingCycle();
  await runOutgoingCycle();
});
```

**3e. `BootReceiver.kt` — neue Datei, `android/app/src/main/java/com/securecommapp/BootReceiver.kt`.**
Empfängt `android.intent.action.BOOT_COMPLETED`, startet `MalachiService` neu, **nur falls** `setup_done` bereits `true` war (Zustand aus `AsyncStorage` ist nativ nicht direkt lesbar — pragmatisch: ein kleines natives `SharedPreferences`-Flag, das `MalachiServiceModule.start()` beim ersten echten Start zusätzlich setzt, oder RN's `AsyncStorage`-Backing-Datei — je nach verwendetem AsyncStorage-Adapter liegt das ohnehin in einer für natives Kotlin lesbaren SQLite-/MMKV-Datei; sollte man aber nicht darauf verlassen, sondern explizit ein eigenes natives Flag pflegen, um nicht von AsyncStorage-Interna abhängig zu sein). Neuer Manifest-Eintrag:
```xml
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<receiver android:name=".BootReceiver" android:exported="false">
    <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
    </intent-filter>
</receiver>
```

**3f. Kritisches, zu verifizierendes Risiko: FGS-Typ `dataSync` und Laufzeitlimits ab Android 15.**
`targetSdkVersion 36` (root `android/build.gradle:6`) bedeutet Ziel-API Android 16. Google hat ab Android 15 (API 35) für die Foreground-Service-Typen `dataSync`/`mediaProcessing` ein **Laufzeitlimit pro rollierendem 24h-Fenster** eingeführt (`Service.onTimeout(startId, fgsType)`-Callback, danach Zwangsstopp durch das System) — genau der Typ, den `MalachiService` verwendet. Das würde bedeuten: ein als `dataSync` laufender, dauerhafter Foreground Service wird auf Android 15/16-Geräten **nicht unbegrenzt laufen**, sondern nach einigen Stunden zwangsgestoppt. **Das kann nicht aus dem Quellcode allein abschließend verifiziert werden** (kein Zugriff auf ein echtes Android-15/16-Gerät/Emulator in der Planungssitzung) — es ist ein Kernrisiko für die "always-on"-Prämisse dieses gesamten Plans und muss vor Stufe-2-Umsetzung an einem echten Gerät/Emulator mit API 35+ geprüft werden (`adb shell dumpsys activity services` nach mehreren Stunden Laufzeit beobachten, sowie Verhalten von `onTimeout()`). Als Absicherung unabhängig vom Ausgang: `MalachiService.onTimeout()` überschreiben (falls API verfügbar) und darin `stopSelf()` + sofortigen `AlarmManager`-Neustart in wenigen Sekunden einplanen, damit ein eventueller Zwangsstopp nur eine kurze Lücke reißt statt den Dienst dauerhaft zu beenden.

**Aufwand Stufe 2:** mittel — der einzige echte Umbauaufwand ist 3a (Extraktion), alles andere ist additiver, neuer Code. Kein Eingriff in UI-Screens, Navigation oder Zustandsverwaltung von `App.tsx` selbst.

---

## 4. Stufe 3 — Optionale Härtung / UnifiedPush-Bewertung

**4a. Battery-Optimization-Ausnahme anfragen.**
`Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)` beim Setup zusätzlich zur `POST_NOTIFICATIONS`-Anfrage einbauen (eigener Permission-Dialog, KEIN Teil von `PermissionsAndroid`, sondern ein expliziter Settings-Intent). Deckt Standard-AOSP-Doze ab — hilft NICHT gegen OEM-eigene Battery-Manager (siehe Abschnitt 5).

**4b. UnifiedPush — Bewertung: für dieses Projekt aktuell Overkill, nicht empfohlen.**
UnifiedPush bräuchte entweder (a) einen UnifiedPush-Distributor auf dem Gerät des Nutzers (z.B. ntfy, ausschließlich in F-Droid-Ökosystem verbreitet, für Freundes-/Familienkreis-Nutzer auf Play-Store-Geräten unrealistisch als Voraussetzung) oder (b) einen selbstbetriebenen UnifiedPush-fähigen Push-Server zusätzlich zum bereits laufenden `relay.js`. Der bereits vorhandene, funktionierende Wake-WebSocket (Abschnitt 0.3) erfüllt für die Zielgruppe (eigener Heimserver, kleiner Empfängerkreis, technisch versierter Betreiber) bereits denselben Zweck ohne zusätzliche Infrastruktur oder Abhängigkeit. **Empfehlung: nicht umsetzen**, es sei denn Stufe 1+2 erweisen sich in der Praxis als nicht ausreichend zuverlässig UND der Nutzer ist bereit, von seinen Kontakten die Installation eines UnifiedPush-Distributors zu verlangen — das ist ein Realitäts-Kompromiss, den nur der Nutzer selbst abwägen kann.

**4c. Poll-Intervall-Jitter** (siehe `ZERO_KNOWLEDGE_RELAY_PLAN.md`, dort bereits unter 2c für Metadaten-Zwecke vorgeschlagen) hat einen Nebennutzen fürs Akku-Verhalten, ist aber kein Kern-Baustein dieses Plans.

---

## 5. Ehrlichkeits-Sektion — was dieser Plan NICHT löst

- **OEM-Battery-Manager (Xiaomi/MIUI, Huawei, Oppo/ColorOS, teils Samsung) killen Prozesse trotz Foreground Service und trotz Battery-Optimization-Ausnahme.** Das ist bekanntes, dokumentiertes Verhalten dieser Hersteller-Skins, komplett außerhalb des AOSP-Standards, und mit App-Code **nicht zuverlässig umgehbar** — nur durch manuelle Nutzeraktion in herstellerspezifischen Einstellungen ("Autostart erlauben", "Keine Beschränkungen" o.ä., z.T. über dontkillmyapp.com dokumentiert). Das kann höchstens per In-App-Hinweis beim Setup kommuniziert werden, nicht technisch erzwungen werden.
- **Kein Ersatz für einen echten Always-On-Server-Proxy.** Wenn beide Gesprächspartner-Geräte nie gleichzeitig "wach" sind (Prozess läuft, WebRTC kann verbinden), hilft der beste Foreground Service nichts — er erhöht nur die Wahrscheinlichkeit überlappender Online-Zeiten und sorgt dafür, dass ein bereits wartendes System-Paket/Reconnect-Offer schneller abgeholt wird, sobald eine Seite online ist. Die 33-Tage-TTL für Reconnect-Offers (`relay.js`, referenziert im `ZERO_KNOWLEDGE_RELAY_PLAN.md`) bleibt die eigentliche Zustellgarantie-Grenze, nicht dieser Plan.
- **Android-15/16-Laufzeitlimits für `dataSync`-FGS-Typ sind nicht verifiziert** (Abschnitt 3f) — falls sie in der vermuteten Form greifen, braucht es zusätzlich zu diesem Plan einen `onTimeout()`-Restart-Mechanismus, der hier nur skizziert, nicht final ausgearbeitet ist, weil er echtes Geräte-Testing auf API 35+ voraussetzt.
- **HeadlessJS mit New Architecture/Bridgeless (`ReactHost`, RN 0.86.3) ist weniger battle-tested als mit der alten Bridge-Architektur.** Community-Berichte zu Headless-Task-Zuverlässigkeit beziehen sich überwiegend auf ältere RN-Versionen. Vor Stufe-2-Festlegung sollte ein kleiner Spike (Headless-Task mit simplem `console.log`/AsyncStorage-Schreibzugriff, App komplett aus Recents gewischt, per `adb logcat` beobachtet) die Grundannahme bestätigen, bevor der Extraktions-Aufwand (3a) investiert wird.
- **Der Akku-Kompromiss ist real und dauerhaft**, nicht nur ein Einmal-Kompromiss beim Einrichten: eine dauerhaft sichtbare Notification plus ein Prozess, der regelmäßig aufwacht (auch bei niedrigem Poll-Takt), kostet spürbar mehr Akku als eine App, die nur beim Öffnen aktiv ist — das ist der bewusste Preis für Zuverlässigkeit nach dem Signal/Threema-Vorbild und sollte dem Nutzer nicht als "kostenlos" verkauft werden.
- **Kein Anspruch auf Vollständigkeit bei "wurde bereits getestet".** Alles in diesem Dokument ist aus dem vorhandenen Quellcode und öffentlich bekanntem Android-Verhalten abgeleitet — nichts davon wurde in dieser Planungssitzung tatsächlich auf einem Gerät gebaut oder ausgeführt. Die als "zu verifizieren" markierten Punkte (1.1, 3f, HeadlessJS-Spike) sind harte Voraussetzungen vor Stufe 2, keine optionalen Nice-to-haves.

---

## Kritische Dateien für die Umsetzung

- `android/app/src/main/java/com/securecommapp/MalachiService.kt`
- `android/app/src/main/java/com/securecommapp/MalachiServiceModule.kt`
- `App.tsx` (Zeilen 357-400, 459-468, 527-627, 645-970 — Extraktionsquelle für `BackgroundSync.js`)
- `RTCStore.js`
- `RelayClient.js` (Wake-Socket-Mechanismus, Zeilen 250-326)
- `android/app/src/main/AndroidManifest.xml`
- `index.js` (Headless-Task-Registrierung, Stufe 2)
