// Malachi Web - Storage.ts
// Browser-Gegenstueck zu EncryptedStorage (nativ, Android-Keystore-gestuetzt).
//
// Ein rein lokal aus dem PIN abgeleiteter Schluessel waere offline (wer die
// rohen localStorage-Daten kopiert - gestohlenes Geraet, Backup, Malware)
// beliebig oft durchprobierbar, egal welche Sperre die Web-UI zeigt - bei
// einem 4-6-stelligen PIN eine Frage von Minuten bis Stunden.
//
// Deshalb braucht der tatsaechliche Schluessel zusaetzlich einen "Pepper":
// einen zufaelligen Wert, den NUR der Relay-Server haelt und nur nach
// bestandener Rate-Pruefung herausgibt (siehe relay.js /pepper/*). Der
// Server sieht dabei nie den PIN, nie den finalen Schluessel, nie die Daten -
// er kennt nur "Pepper X gehoert zu Geraet Y" und zaehlt Fehlversuche.
// Ohne den Pepper ist die lokale Chiffre wertlos: Offline-Brute-Force auf
// gestohlene Browser-Daten bringt nichts mehr.
//
// Ehrlicher Trade-off: Entsperren braucht jetzt eine Verbindung zum Relay
// (anders als die native App, die dank Hardware-Keystore offline entsperren
// kann). Das ist der Preis dafuer, dass die Rate-Begrenzung im Browser
// ueberhaupt real durchsetzbar wird - ohne Server-Beteiligung geht das nicht.
import { pepperRegister, pepperRequest, pepperFail, pepperSuccess } from './RelayClient';

const PREFIX = 'malachi_';
const SALT_KEY = PREFIX + '__pin_salt';
const MARKER_KEY = PREFIX + '__pin_marker';
const DEVICE_ID_KEY = PREFIX + '__device_id';
const MARKER_PLAINTEXT = 'malachi-unlock-check';
const PBKDF2_ITERATIONS = 210_000;

let dek: CryptoKey | null = null;
// Zeitfenster-Fix (State-Machine-Review Fund 6): unlockEncryption() braucht
// einen vollen Netzwerk-Roundtrip (pepperRequest/pepperSuccess) PLUS einen
// kompletten Re-Verschluesselungsdurchlauf ueber ganz localStorage, bevor
// `dek` am Ende der Funktion gesetzt wird. Ruft waehrenddessen etwas anderes
// getItem()/setItem() auf - fuer den Nutzer war die PIN ja gerade schon als
// richtig bestaetigt - schlug das bisher fehl (getItem: null, setItem: wirft)
// und ging beim ueberall im Code dominanten Fire-and-Forget-Muster
// (`.catch(()=>{})`) lautlos verloren. Jetzt: waehrend ein Entsperren laeuft,
// warten getItem()/setItem() einfach auf dessen Abschluss, statt sofort
// anzunehmen, der Storage sei (noch) gesperrt. Kein neuer Netzwerk-Schritt -
// nur eine lokale Synchronisierung auf einen bereits laufenden Vorgang.
let unlockInFlight: Promise<unknown> | null = null;

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Chaos-Test-Fund (SECURITY_CHAOS_TESTING.md §10, Fix 3): fromB64()/atob()
// wirft bei ungueltigem Base64 eine echte Exception - fuer eine reine
// lokale Wohlgeformtheitspruefung (siehe _unlockEncryptionInner) wird das
// hier bewusst geschluckt statt durchgereicht, `null` signalisiert "kein
// gueltiges Base64".
function tryDecodeB64(b64: string): Uint8Array | null {
  try {
    return fromB64(b64);
  } catch {
    return null;
  }
}

function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[^a-zA-Z0-9]/g, '');
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function deriveKey(pin: string, pepper: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin + ':' + pepper),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptRaw(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), iv.length);
  return toB64(combined);
}

async function decryptRaw(key: CryptoKey, b64: string): Promise<string | null> {
  try {
    const combined = fromB64(b64);
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export function hasPinSetup(): boolean {
  return localStorage.getItem(SALT_KEY) !== null;
}

// Beim allerersten Festlegen des PIN aufrufen. Wirft, wenn der Relay nicht
// erreichbar ist - ohne Pepper vom Server gibt's keine sinnvolle Absicherung,
// dann lieber gar nicht erst einrichten als eine falsche Sicherheit vorgaukeln.
export async function setupEncryption(pin: string): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const result = await pepperRegister(deviceId);
  if (!result.ok) {
    // API-Vertrags-Review: 'conflict' (409, deviceId schon registriert) und
    // 'network' (Relay nicht erreichbar) sind zwei grundverschiedene
    // Ursachen, die vorher identisch als "Relay nicht erreichbar" gemeldet
    // wurden - eine irrefuehrende Fehlklassifizierung. 'conflict' ist
    // konkret erreichbar, wenn eine erste Registrierung serverseitig bereits
    // erfolgreich war, deren Antwort den Client aber nie erreichte (Tab
    // geschlossen/Netzwerkabbruch) und der Nutzer die Einrichtung mit
    // demselben, bereits lokal persistierten deviceId erneut versucht.
    if (result.reason === 'conflict') {
      throw new Error('Dieses Geraet hat bereits einen Pepper beim Server registriert (moeglicherweise durch einen frueheren, unterbrochenen Einrichtungsversuch) - eine erneute Einrichtung ist mit diesem Geraet nicht moeglich.');
    }
    throw new Error('Relay nicht erreichbar - PIN kann gerade nicht eingerichtet werden');
  }
  const pepper = result.pepper;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, pepper, salt);
  const marker = await encryptRaw(key, MARKER_PLAINTEXT);
  localStorage.setItem(SALT_KEY, toB64(salt));
  localStorage.setItem(MARKER_KEY, marker);
  dek = key;
}

export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'wrong_pin' }
  | { ok: false; reason: 'locked'; lockedUntil: number }
  | { ok: false; reason: 'wiped' }
  // Produktions-Realitaets-Review ("100k Nutzer, ein einziger relay.js-
  // Prozess"): relay.js haelt pepperStore NUR im RAM (siehe relay.js Kopf-
  // kommentar "Nur RAM, kein Disk") - jeder Neustart des Relay-Prozesses
  // (Deploy, Crash, OOM) loescht ALLE registrierten Pepper gleichzeitig fuer
  // ALLE Web-Client-Nutzer, die gerade einen PIN eingerichtet haben. Vorher
  // wurde genau dieser Fall (pepperRequest() liefert 'unknown', weil der
  // Server das deviceId nach einem Neustart nicht mehr kennt) identisch zu
  // einem ECHTEN 5-Fehlversuche-Wipe behandelt ('wiped') - dem Nutzer wurde
  // "Zu viele Fehlversuche" angezeigt, obwohl er nicht einen einzigen falschen
  // PIN eingegeben hat. Eigener, ehrlicher Grund: der Server hat seinen
  // Zustand verloren (Betriebsereignis), nicht der Nutzer hat sich geirrt
  // (Sicherheitsereignis). Das lokal verschluesselte Chiffrat ist in beiden
  // Faellen gleichermassen unwiderruflich nicht mehr entschluesselbar (der
  // Pepper ist zufaellig und wird nie woanders gespeichert), deshalb bleibt
  // die praktische Konsequenz (lokale Daten weg, Neueinrichtung noetig)
  // gleich - nur die Zuschreibung/Meldung ist jetzt korrekt.
  | { ok: false; reason: 'lost_state' }
  | { ok: false; reason: 'offline' }
  // Chaos-Test-Fund (SECURITY_CHAOS_TESTING.md §10, Fix 3): lokal beschaedigte
  // SALT_KEY/MARKER_KEY-Werte sind KEIN falscher PIN und duerfen deshalb auch
  // keinen echten Versuch gegen den 5-Fehlversuche-Wipe-Zaehler kosten - siehe
  // ausfuehrlicher Kommentar in _unlockEncryptionInner().
  | { ok: false; reason: 'corrupted' };

// Beim Entsperren aufrufen. Braucht eine Relay-Verbindung (siehe Kommentar
// oben) - ohne die bleibt der Storage gesperrt, es gibt keinen Offline-Modus.
export async function unlockEncryption(pin: string): Promise<UnlockResult> {
  const p = _unlockEncryptionInner(pin);
  unlockInFlight = p;
  try {
    return await p;
  } finally {
    if (unlockInFlight === p) unlockInFlight = null;
  }
}

async function _unlockEncryptionInner(pin: string): Promise<UnlockResult> {
  const saltB64 = localStorage.getItem(SALT_KEY);
  const marker = localStorage.getItem(MARKER_KEY);
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!saltB64 || !marker || !deviceId) return { ok: false, reason: 'wrong_pin' };

  // Chaos-Test-Fund (SECURITY_CHAOS_TESTING.md §10, Fix 3): ein lokal
  // beschaedigter SALT_KEY (kein gueltiges Base64 - liess fromB64()/atob()
  // bisher unbehandelt aus dieser Funktion werfen statt ein strukturiertes
  // UnlockResult zu liefern) oder MARKER_KEY ist KEIN falscher PIN. Trotzdem
  // wurde bisher in JEDEM Fall pepperRequest() aufgerufen, was ein echtes,
  // 30s gueltiges attemptToken ausstellt - verfaellt es ungeloest, zaehlt es
  // serverseitig (relay.js /pepper/request, siehe Kommentar dort, C-3) als
  // IMPLIZITER Fehlversuch gegen den 5-Versuche-Wipe-Zaehler, selbst wenn
  // hier nie pepperFail() aufgerufen wird - "einfach pepperFail() nicht
  // aufrufen" vermeidet also NICHTS. Der einzige Weg, wirklich keinen
  // Versuch zu verbrauchen: die Pruefung MUSS vor pepperRequest() passieren,
  // damit gar nie ein Token ausgestellt wird.
  //
  // Reine lokale Wohlgeformtheitspruefung, kein PIN-abhaengiger Schritt:
  // encryptRaw() liefert immer IV(12 Byte) + AES-GCM-Ciphertext(>=16 Byte
  // Tag), unabhaengig vom PIN - alles, was nicht mal gueltiges Base64 dieser
  // Mindestlaenge ist, kann strukturell nie unser eigenes Format sein. Ein
  // Wert, der zufaellig lang genug UND gueltiges Base64 ist, aber trotzdem
  // korrupt (oder schlicht der falsche PIN) ist, faellt bewusst weiterhin
  // ausschliesslich ueber den echten Entschluesselungsversuch unten auf
  // 'wrong_pin' zurueck - das bleibt ABSICHTLICH kryptografisch
  // ununterscheidbar von einem echten falschen PIN (siehe Kommentar dort).
  // Sonst liesse sich per Antwortunterschied "korrupt" von "falscher PIN"
  // erkennen, nachdem ein echter Entschluesselungsversuch schon gelaufen
  // ist - das waere ein Informationsleck ueber den lokalen Speicherzustand.
  const saltPrecheck = tryDecodeB64(saltB64);
  const markerPrecheck = tryDecodeB64(marker);
  if (!saltPrecheck || saltPrecheck.length < 8 || !markerPrecheck || markerPrecheck.length < 12 + 16) {
    return { ok: false, reason: 'corrupted' };
  }

  const pepperResult = await pepperRequest(deviceId);
  if (!pepperResult.ok) {
    if (pepperResult.reason === 'locked') return { ok: false, reason: 'locked', lockedUntil: pepperResult.lockedUntil };
    if (pepperResult.reason === 'network') return { ok: false, reason: 'offline' };
    // 'unknown' vom Server = Pepper existiert nicht (mehr). Das ist NICHT
    // dasselbe wie ein echter 5-Fehlversuche-Wipe (siehe UnlockResult-
    // Kommentar oben) - kein einziger Entschluesselungsversuch wurde hier
    // ueberhaupt unternommen, also auch keiner "verbraucht" oder als falsch
    // gewertet. Trotzdem: ohne den Pepper ist salt/marker/alles Verschluesselte
    // dauerhaft wertlos, genau wie bei einem echten Wipe - localStorage wird
    // deshalb ebenso geleert, sonst bliebe der Nutzer für immer auf dem
    // Lock-Screen haengen (hasPinSetup() bliebe true, aber pepperRequest()
    // wuerde fuer dieses deviceId nie wieder etwas anderes als 'unknown'
    // liefern) ohne jeden Weg zurueck zu einer neuen Einrichtung.
    localStorage.clear();
    return { ok: false, reason: 'lost_state' };
  }

  // Verteidigung in der Tiefe: sollte saltB64 zwischen der Vorpruefung oben
  // und hier doch noch beschaedigt werden (z.B. ein anderer Tab desselben
  // Origins schreibt gleichzeitig in localStorage), hier ebenso fail-closed
  // statt eine unbehandelte Exception aus dieser Funktion werfen zu lassen.
  let saltBytes: Uint8Array;
  try {
    saltBytes = fromB64(saltB64);
  } catch {
    return { ok: false, reason: 'corrupted' };
  }
  const key = await deriveKey(pin, pepperResult.pepper, saltBytes);
  const decrypted = await decryptRaw(key, marker);
  if (decrypted !== MARKER_PLAINTEXT) {
    const failResult = await pepperFail(deviceId, pepperResult.attemptToken);
    if (failResult.wiped) {
      localStorage.clear();
      return { ok: false, reason: 'wiped' };
    }
    if (failResult.lockedUntil && failResult.lockedUntil > Date.now()) {
      return { ok: false, reason: 'locked', lockedUntil: failResult.lockedUntil };
    }
    return { ok: false, reason: 'wrong_pin' };
  }

  // Pepper rotieren (Sicherheitsreview C-3): ein evtl. vorher kopierter Pepper
  // ist ab jetzt serverseitig ungueltig. Der abgeleitete Schluessel aendert
  // sich damit auch - JEDER bereits mit dem alten Schluessel verschluesselte
  // Wert (Marker, Kontakte, Chatverlauf, Shared Secrets, ...) muss deshalb
  // mit dem neuen Schluessel neu verschluesselt werden, sonst liesse er sich
  // beim naechsten Entsperren nicht mehr lesen. Schlaegt die Rotation selbst
  // fehl (Netzwerkfehler nach dem eigentlichen Login), bleibt der alte
  // Pepper/Schluessel fuer diese Sitzung gueltig - kein Datenverlust, nur die
  // Rotation faellt fuer diesen Zyklus aus.
  const newPepper = await pepperSuccess(deviceId, pepperResult.attemptToken);
  if (newPepper) {
    const newKey = await deriveKey(pin, newPepper, fromB64(saltB64));
    for (const storageKey of Object.keys(localStorage)) {
      if (storageKey === SALT_KEY || storageKey === MARKER_KEY || storageKey === DEVICE_ID_KEY) continue;
      if (!storageKey.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(storageKey);
      if (raw === null) continue;
      const plaintext = await decryptRaw(key, raw);
      if (plaintext === null) continue; // nicht unser Format (sollte nicht vorkommen) - unangetastet lassen
      localStorage.setItem(storageKey, await encryptRaw(newKey, plaintext));
    }
    const newMarker = await encryptRaw(newKey, MARKER_PLAINTEXT);
    localStorage.setItem(MARKER_KEY, newMarker);
    dek = newKey;
  } else {
    dek = key;
  }
  return { ok: true };
}

export function lock(): void {
  dek = null;
}

export async function getItem(key: string): Promise<string | null> {
  if (!dek && unlockInFlight) await unlockInFlight.catch(() => {});
  if (!dek) return null;
  const raw = localStorage.getItem(PREFIX + key);
  if (raw === null) return null;
  return decryptRaw(dek, raw);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (!dek && unlockInFlight) await unlockInFlight.catch(() => {});
  if (!dek) throw new Error('Storage ist gesperrt - unlockEncryption() zuerst aufrufen');
  localStorage.setItem(PREFIX + key, await encryptRaw(dek, value));
}

export async function removeItem(key: string): Promise<void> {
  localStorage.removeItem(PREFIX + key);
}

export async function clear(): Promise<void> {
  Object.keys(localStorage)
    .filter((k) => k.startsWith(PREFIX))
    .forEach((k) => localStorage.removeItem(k));
  dek = null;
}
