/**
 * @format
 */

// Hermes (React Native's JS-Engine) hat kein globales TextEncoder/TextDecoder
// (Encoding Living Standard) - react-native-qrcode-svg braucht das aber fuer
// QR-Inhalte mit Kleinbuchstaben (Byte-Mode-Encoding, ausgeloest durch den
// Deep-Link im QR-Code). Muss vor allen anderen Imports laufen, deshalb hier
// in index.js statt in App.tsx.
import { Buffer } from 'buffer';
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = class TextEncoder {
    encode(str) {
      return Uint8Array.from(Buffer.from(str, 'utf8'));
    }
  };
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = class TextDecoder {
    decode(bytes) {
      return Buffer.from(bytes).toString('utf8');
    }
  };
}

import {AppRegistry, NativeModules} from 'react-native';
import EncryptedStorage from 'react-native-encrypted-storage';
import App from './App';
import {
  runIncomingCycle,
  runOutgoingCycle,
  loadMissingSharedSecrets,
  updateContacts,
  startColdStartReconnect,
} from './BackgroundSync';
import { ensureTorRunning } from './TorTransport';
import RTCStore from './RTCStore';
import { t, formatTime, loadLanguageSetting } from './i18n';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);

// ─── Stufe 2: Headless-Hintergrund-Sync (FOREGROUND_SERVICE_PLAN.md 3d) ─────
// Laeuft, wenn MalachiService (nativ, per AlarmManager ~alle 8s) feststellt,
// dass die App NICHT im Vordergrund ist, und MalachiHeadlessTaskService
// startet - unabhaengig davon, ob MainActivity/App() noch existiert (Live-
// Spike 2026-09-27 bestaetigt, auch nach Wegwischen aus "Zuletzt verwendet").
// Muss exakt zum Task-Namen in MalachiHeadlessTaskService.kt passen.
const HEADLESS_TASK_NAME = 'MalachiBackgroundSync';
const { MalachiNotification, MalachiService, CallBridgeModule } = NativeModules;
const SETUP_READ_FAILED = Symbol('setup_read_failed');
let headlessLanguageLoaded = false;

async function contactNameFor(chatId) {
  try {
    const saved = await EncryptedStorage.getItem('contacts');
    const c = saved ? JSON.parse(saved).find(x => x.id === chatId) : null;
    return c?.name || null;
  } catch {
    return null;
  }
}

// Benachrichtigung mit Kontaktnamen (neue native Methode showNotificationFor,
// siehe MalachiNotificationModule.kt - die bisherige showNotification() ohne
// Parameter bleibt fuer App.tsx unveraendert bestehen).
function showNamedNotification(peerName) {
  try {
    if (MalachiNotification?.showNotificationFor) {
      MalachiNotification.showNotificationFor(peerName || null);
    } else {
      MalachiNotification?.showNotification?.();
    }
  } catch (e) {
    console.warn('[Headless] Benachrichtigung fehlgeschlagen:', e?.message || e);
  }
}

// Der P2P-Empfangspfad (RTCStore.setConnection -> rtc.onMessage) meldet neue
// Nachrichten ueber global.showMalachiNotification/global.incrementBadge -
// beide setzt normalerweise AppInner beim Rendern. Startet der JS-Kontext
// aber rein headless (Prozess vom System/Boot/Alarm neu gestartet, App() nie
// gemountet), gibt es sie nicht: eine per Hintergrund-Reconnect eintreffende
// Nachricht waere zwar gepuffert, aber ohne Benachrichtigung und ohne
// Unread-Zaehler. Deshalb hier Ersatz-Implementierungen - NUR wenn noch keine
// existieren (war App() schon einmal gemountet, bleiben deren Closures aktiv;
// mountet App() spaeter, ueberschreibt AppInner diese beim naechsten Render).
function installHeadlessFallbackGlobals() {
  if (typeof global.showMalachiNotification !== 'function') {
    global.showMalachiNotification = (chatId) => {
      contactNameFor(chatId).then(showNamedNotification);
    };
  }
  if (typeof global.incrementBadge !== 'function') {
    // Nur der persistente Teil von AppInner's incrementBadge (kein React-
    // State headless) - gleiche Felder/Kuerzung, damit die Kontaktliste beim
    // naechsten Oeffnen Unread-Zaehler und Vorschau korrekt zeigt.
    global.incrementBadge = (chatId, preview) => {
      const time = formatTime();
      updateContacts(cs => cs.map(x => x.id === chatId
        ? { ...x, unread: (x.unread || 0) + 1, ...(preview ? { last: preview.length > 200 ? preview.slice(0, 200) + '…' : preview, time } : {}) }
        : x)).catch(() => {});
    };
  }
}

// Eingehende Anrufe ohne gemountete App: Anruf-Signale kommen ueber die
// bestehende Verbindung zum Kontakt (direkt oder Tor - es gibt keinen Server
// mehr, den man abfragen koennte). RTCStore puffert das Angebot, solange App()
// nicht bereit ist, und meldet es hier - natives Klingeln sofort starten;
// App.tsx holt das gepufferte Angebot beim Start ab. Bricht der Anrufer ab,
// bevor angenommen wurde, endet das Klingeln.
RTCStore.incomingCallNotifier = (chatId) => {
  contactNameFor(chatId).then((name) => {
    const entry = RTCStore.pendingCalls.get(chatId);
    if (entry && !entry.peerName && name) entry.peerName = name;
    console.log('[Headless] Eingehender Anruf - klingele nativ');
    try {
      CallBridgeModule?.reportIncomingCall?.(chatId, name || t('call.unknownContact'));
    } catch (e) {
      console.warn('[Headless] Natives Klingeln fehlgeschlagen:', e?.message || e);
    }
  });
};
RTCStore.callCancelledNotifier = (chatId) => {
  try {
    CallBridgeModule?.reportCallEnded?.(chatId);
  } catch (e) {
    console.warn('[Headless] Klingeln beenden fehlgeschlagen:', e?.message || e);
  }
};

AppRegistry.registerHeadlessTask(HEADLESS_TASK_NAME, () => async () => {
  // Nach einem Wipe (5 Fehlversuche/Duress/"Alles loeschen") laeuft
  // MalachiService weiter - performWipe() stoppt ihn nicht - und wuerde
  // dank BootReceiver sogar nach einem Neustart wiederkommen. Ist das Geraet
  // nachweislich nicht (mehr) eingerichtet, Dienst hier gezielt beenden
  // (stop() loescht auch das native Boot-Flag und den Alarm). Nur bei einem
  // eindeutigen "nicht vorhanden" - ein Lesefehler ueberspringt nur diesen
  // Durchlauf, statt den Dienst auf Verdacht abzuschalten.
  const setupDone = await EncryptedStorage.getItem('setup_done').catch(() => SETUP_READ_FAILED);
  if (setupDone !== 'true') {
    if (setupDone == null) {
      console.log('[Headless] Geraet nicht eingerichtet - beende Hintergrunddienst');
      MalachiService?.stop?.();
    }
    return;
  }
  installHeadlessFallbackGlobals();
  // Gewaehlte Sprache auch ohne gemountete App() (Vorschautexte, Namen) -
  // einmal pro JS-Kontext; App.tsx laedt sie sonst beim Start aus 'settings'.
  if (!headlessLanguageLoaded) {
    headlessLanguageLoaded = true;
    await loadLanguageSetting(EncryptedStorage);
  }
  // Tor ist der einzige Weg, Kontakte zu finden (kein Server mehr) - auch
  // ohne gemountete App() (Prozess nach Neustart/Boot nur headless gestartet)
  // muss er laufen. Idempotent; bewusst NICHT abgewartet (der Start kann
  // laenger dauern als die 15 s, die dieser Task hat - er laeuft im
  // Hintergrund weiter, die naechsten Ticks verbinden dann).
  startColdStartReconnect();
  ensureTorRunning().catch(() => {});
  // Ohne gemountete App() hat noch niemand die Shared Secrets in RTCStore
  // geladen (siehe loadMissingSharedSecrets in BackgroundSync.js).
  await loadMissingSharedSecrets();
  await runIncomingCycle();
  // Verbindungszyklus: Tor-Verbindungen zu Kontakten aufbauen, danach Wechsel
  // auf direkt. Die Verbindungsversuche selbst laufen im Hintergrund weiter.
  // Eingehende Nachrichten/Anrufe kommen ueber diese Verbindungen (RTCStore
  // benachrichtigt bzw. laesst nativ klingeln, siehe oben).
  await runOutgoingCycle();
});
