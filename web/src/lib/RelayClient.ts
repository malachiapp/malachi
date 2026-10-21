// Malachi Web - RelayClient.ts
// Fast 1:1 aus RelayClient.js uebernommen - reine fetch()-Aufrufe, brauchen
// im Browser keine Anpassung. Nur die RN-Platform/Emulator-Erkennung entfaellt.
//
// Port 3333 statt 5356 (DS-Lite/CGNAT-Nachzug, siehe RelayClient.js fuer die
// volle Begruendung): IPv6 kennt kein NAT, die FritzBox-Portfreigabe fuer
// 5356 blieb trotz korrekter Konfiguration reproduzierbar unerreichbar -
// Port 3333 funktioniert nachweislich zuverlaessig.
//
// Audit 2026-09-28: wird die Web-App vom Relay selbst ausgeliefert (Normalfall,
// siehe relay.js tryServeStatic), redet sie jetzt mit genau DEM Ursprung, von
// dem sie geladen wurde (i.d.R. Port 443). Vorher immer fest Port 3333 - der
// ist laut RelayClient.js (nativ) in Mobilfunknetzen teils blockiert, die
// Web-App war dort also trotz geladener Seite offline. Ausserhalb des Relay-
// Hosts (lokale Entwicklung) Port 443 als Default.
// Lokal (localhost, ausser dem Vite-Dev-Server auf 5173/5174) gilt dasselbe:
// dann liefert eine lokale Relay-Kopie die App aus (tools/relay-preview.js) -
// so spricht eine lokale Vorschau nie versehentlich mit dem echten Server.
// Adresse zentral in AppConfig.ts (Umzug auf neuen Server = eine Zeile).
import { RELAY_HOST } from './AppConfig';
const loc = typeof window !== 'undefined' ? window.location : undefined;
const servedByRelay = !!loc && /^https?:$/.test(loc.protocol) && (
  (loc.hostname === RELAY_HOST && loc.protocol === 'https:') ||
  ((loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') && loc.port !== '5173' && loc.port !== '5174')
);
export const RELAY_URL = servedByRelay && loc ? loc.origin : `https://${RELAY_HOST}`;

// Audit 2026-09-28: im Browser gab es (anders als nativ, siehe
// fetchWithTimeout in RelayClient.js) keinerlei Zeitlimit - ein haengender
// Request (Netzwechsel, Laptop aus dem Standby) blockierte die jeweilige
// Poll-Schleife samt ihrer "laeuft noch"-Sperre unbegrenzt.
const RELAY_FETCH_TIMEOUT_MS = 10000;
async function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendSignalOffer(offer: string, token: string): Promise<boolean> {
  try {
    const res = await relayFetch(`${RELAY_URL}/signal/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer, token }),
    });
    // API-Vertrags-Review: gab bisher `true` zurueck, sobald `fetch()` selbst
    // nicht warf - ein 4xx/5xx vom Relay wurde also faelschlich als Erfolg
    // gemeldet, inkonsistent zu sendPacket/sendCallSignal, die bereits
    // `res.ok` pruefen. Kein Aufrufer wertet den Rueckgabewert aktuell aus
    // (rein fire-and-forget), daher risikolose Korrektur.
    return res.ok;
  } catch {
    return false;
  }
}

export async function getSignalOffer(token: string): Promise<string | null> {
  try {
    const res = await relayFetch(`${RELAY_URL}/signal/offer/${token}`);
    const data = await res.json();
    // Fund (Fuzzing-Kampagne, Server-Response-Parsing): ein kompromittierter
    // oder fehlerhafter Relay koennte ein truthy, aber falsch geformtes
    // "offer"-Feld liefern (Zahl/Objekt/Array) - vorher ungeprueft
    // durchgereicht. typeof-Pruefung statt blossem `|| null`.
    return typeof data.offer === 'string' ? data.offer : null;
  } catch {
    return null;
  }
}

export async function sendSignalAnswer(answer: string, token: string): Promise<boolean> {
  try {
    const res = await relayFetch(`${RELAY_URL}/signal/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, token }),
    });
    // Siehe sendSignalOffer oben fuer die Begruendung.
    return res.ok;
  } catch {
    return false;
  }
}

export async function getSignalAnswer(token: string): Promise<string | null> {
  try {
    const res = await relayFetch(`${RELAY_URL}/signal/answer/${token}`);
    const data = await res.json();
    // Siehe getReconnectOffer/getSignalOffer oben fuer die Begruendung.
    return typeof data.answer === 'string' ? data.answer : null;
  } catch {
    return null;
  }
}

export async function sendReconnectOffer(offer: string, contactId: string): Promise<boolean> {
  try {
    const res = await relayFetch(`${RELAY_URL}/reconnect/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer, contactId }),
    });
    // Siehe sendSignalOffer oben fuer die Begruendung.
    return res.ok;
  } catch {
    return false;
  }
}

export async function getReconnectOffer(contactId: string): Promise<string | null> {
  try {
    const res = await relayFetch(`${RELAY_URL}/reconnect/offer/${contactId}`);
    const data = await res.json();
    // Fund (Fuzzing-Kampagne, Server-Response-Parsing): ein kompromittierter
    // oder fehlerhafter Relay koennte ein truthy, aber falsch geformtes
    // "offer"-Feld liefern (Zahl/Objekt/Array) - vorher ungeprueft
    // durchgereicht. typeof-Pruefung statt blossem `|| null`.
    return typeof data.offer === 'string' ? data.offer : null;
  } catch {
    return null;
  }
}

export async function sendReconnectAnswer(answer: string, contactId: string): Promise<boolean> {
  try {
    const res = await relayFetch(`${RELAY_URL}/reconnect/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, contactId }),
    });
    // Siehe sendSignalOffer oben fuer die Begruendung.
    return res.ok;
  } catch {
    return false;
  }
}

export async function getReconnectAnswer(contactId: string): Promise<string | null> {
  try {
    const res = await relayFetch(`${RELAY_URL}/reconnect/answer/${contactId}`);
    const data = await res.json();
    // Siehe getReconnectOffer/getSignalOffer oben fuer die Begruendung.
    return typeof data.answer === 'string' ? data.answer : null;
  } catch {
    return null;
  }
}

export async function sendPacket(payload: string, recipient: string): Promise<boolean> {
  try {
    const res = await relayFetch(`${RELAY_URL}/packet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, recipient }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getPackets(recipient: string): Promise<Array<{ payload: string; token?: string }>> {
  try {
    const res = await relayFetch(`${RELAY_URL}/packet/${recipient}`);
    const data = await res.json();
    // Siehe getReconnectOffer oben fuer die Begruendung - Array.isArray()
    // statt blossem `|| []`, ein manipuliertes/fehlerhaftes "packets"-Feld
    // wuerde sonst ungeprueft an ein `for...of` beim Aufrufer durchgereicht.
    return Array.isArray(data.packets) ? data.packets : [];
  } catch {
    return [];
  }
}

// Muss nach erfolgreicher lokaler Verarbeitung der zugehoerigen Pakete
// aufgerufen werden (siehe RelayClient.js/App.tsx fuer die Begruendung -
// relay.js loescht ein /packet erst nach diesem expliziten Ack, nicht mehr
// sofort bei getPackets()). Fire-and-forget ist hier bewusst in Ordnung: ein
// verlorener Ack fuehrt bestenfalls zu einer harmlosen erneuten Zustellung
// nach Ablauf des serverseitigen Gnadenfensters, nie zu Datenverlust.
export async function ackPackets(recipient: string, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await relayFetch(`${RELAY_URL}/packet/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, tokens }),
    });
  } catch {
    // absichtlich stumm - siehe Kommentar oben
  }
}

// -- Call-Signaling --
export async function sendCallSignal(
  contactId: string,
  direction: string,
  type: string,
  payload: unknown,
): Promise<boolean> {
  try {
    const res = await relayFetch(`${RELAY_URL}/call/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, direction, type, payload }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pollCallSignals(
  contactId: string,
  direction: string,
): Promise<Array<{ type: string; payload: unknown; ts: number }>> {
  try {
    const res = await relayFetch(`${RELAY_URL}/call/signal/${contactId}/${direction}`);
    const data = await res.json();
    // Siehe getReconnectOffer oben fuer die Begruendung.
    return Array.isArray(data.signals) ? data.signals : [];
  } catch {
    return [];
  }
}

// -- Pepper (PIN-Haertung, siehe Storage.ts) --
//
// API-Vertrags-Review-Fund: vorher gab diese Funktion fuer ZWEI komplett
// verschiedene Fehlerursachen identisch `null` zurueck - ein echter
// Netzwerkfehler UND ein 409 "bereits registriert" (z.B. weil eine erste,
// serverseitig tatsaechlich erfolgreiche Registrierung nur an einer
// verlorenen/abgebrochenen Antwort scheiterte und der Client denselben,
// bereits lokal persistierten deviceId erneut versucht - /pepper/register
// ist NICHT idempotent wiederholbar wie z.B. /phone/register, das genau
// dafuer diese Session bereits einen expliziten Gleicher-Aufrufer-Ausnahmefall
// bekommen hat). Storage.ts's setupEncryption() zeigte dem Nutzer bei einem
// 409 faelschlich "Relay nicht erreichbar" an - eine irrefuehrende
// Fehlklassifizierung, die bei der Fehlersuche in die falsche Richtung fuehrt.
// Discriminierter Rueckgabewert (gleiches Muster wie PepperRequestResult
// unten) macht die Unterscheidung fuer den Aufrufer moeglich.
export type PepperRegisterResult =
  | { ok: true; pepper: string }
  | { ok: false; reason: 'conflict' | 'network' };

export async function pepperRegister(deviceId: string): Promise<PepperRegisterResult> {
  try {
    const res = await relayFetch(`${RELAY_URL}/pepper/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (res.status === 409) return { ok: false, reason: 'conflict' };
    if (!res.ok) return { ok: false, reason: 'network' };
    const data = await res.json();
    if (typeof data.pepper !== 'string') return { ok: false, reason: 'network' };
    return { ok: true, pepper: data.pepper };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export type PepperRequestResult =
  | { ok: true; pepper: string; attemptToken: string }
  | { ok: false; reason: 'locked'; lockedUntil: number }
  | { ok: false; reason: 'unknown' | 'network' };

export async function pepperRequest(deviceId: string): Promise<PepperRequestResult> {
  try {
    const res = await relayFetch(`${RELAY_URL}/pepper/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (res.status === 423) {
      const data = await res.json();
      return { ok: false, reason: 'locked', lockedUntil: data.lockedUntil };
    }
    if (!res.ok) return { ok: false, reason: 'unknown' };
    const data = await res.json();
    return { ok: true, pepper: data.pepper, attemptToken: data.attemptToken };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

// Rueckgabe true = Pepper wurde nach 5 Fehlversuchen geloescht (Wipe) - die
// lokal gespeicherten Daten sind damit endgueltig nicht mehr entschluesselbar.
// attemptToken muss das aus pepperRequest() sein - der Server nimmt sonst
// keinen Fehlversuch an (Sicherheitsreview C-3).
export async function pepperFail(deviceId: string, attemptToken: string): Promise<{ wiped: boolean; lockedUntil?: number }> {
  try {
    const res = await relayFetch(`${RELAY_URL}/pepper/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, attemptToken }),
    });
    const data = await res.json();
    return { wiped: !!data.wiped, lockedUntil: data.lockedUntil };
  } catch {
    return { wiped: false };
  }
}

// Gibt bei Erfolg den ROTIERTEN Pepper zurueck - der alte ist ab jetzt serverseitig
// ungueltig, Storage.ts muss den Marker lokal mit dem neuen Pepper neu verschluesseln
// (Sicherheitsreview C-3: begrenzt das Zeitfenster eines einmal kopierten Peppers).
export async function pepperSuccess(deviceId: string, attemptToken: string): Promise<string | null> {
  try {
    const res = await relayFetch(`${RELAY_URL}/pepper/success`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, attemptToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.newPepper || null;
  } catch {
    return null;
    /* nicht kritisch fuers Entsperren selbst, aber Rotation faellt dann aus */
  }
}

// -- Wake-Socket (unabhaengig von Push-Diensten, siehe Push-Architektur-Plan) --
// Ersetzt schrittweise blindes Intervall-Polling: ein einziges WebSocket haelt
// (solange der Tab offen ist) eine Verbindung zum Relay, meldet einmalig die
// eigenen Kontakt-IDs an, und bekommt bei neuem Relay-Inhalt ein voellig
// inhaltsloses {type:'wake', for: contactId} zurueck. Bleibt zero-knowledge -
// der Relay erfaehrt dabei nicht mehr, als er heute schon durch die
// wiederholten Poll-Requests erfaehrt, nur alles auf einmal statt ueber Zeit
// verteilt (siehe Kommentar in relay.js). Fallback: bestehende Timer-Polls
// bleiben unveraendert bestehen, falls das Socket gerade tot ist.
type WakeListener = (contactId: string) => void;
let wakeListeners: WakeListener[] = [];
let wakeSocket: WebSocket | null = null;
let wakeReconnectDelay = 1000;
let wakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wakeSubscribedIds: string[] = [];
let wakeStarted = false;

function wakeSocketUrl(): string {
  return RELAY_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

function scheduleWakeReconnect(): void {
  if (wakeReconnectTimer) return;
  wakeReconnectTimer = setTimeout(() => {
    wakeReconnectTimer = null;
    connectWakeSocket();
  }, wakeReconnectDelay + Math.random() * 500);
  wakeReconnectDelay = Math.min(wakeReconnectDelay * 2, 30000);
}

function connectWakeSocket(): void {
  if (wakeSocket && (wakeSocket.readyState === WebSocket.OPEN || wakeSocket.readyState === WebSocket.CONNECTING)) return;
  try {
    wakeSocket = new WebSocket(wakeSocketUrl());
  } catch {
    scheduleWakeReconnect();
    return;
  }
  wakeSocket.onopen = () => {
    wakeReconnectDelay = 1000;
    if (wakeSubscribedIds.length > 0) wakeSocket?.send(JSON.stringify({ subscribe: wakeSubscribedIds }));
  };
  wakeSocket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg?.type === 'wake' && typeof msg.for === 'string') {
        wakeListeners.forEach((l) => l(msg.for));
      }
    } catch {
      /* kein gueltiges JSON - ignorieren */
    }
  };
  wakeSocket.onclose = scheduleWakeReconnect;
  wakeSocket.onerror = () => wakeSocket?.close();
}

// Audit 2026-09-28 (siehe gleichnamiger Fix in RelayClient.js): nach
// Netzwechsel oder Standby meldet ein totes Socket oft noch OPEN - dann den
// alten Socket aktiv verwerfen und neu verbinden, statt auf TCP-Timeouts zu
// warten.
function forceWakeReconnect(): void {
  const old = wakeSocket;
  wakeSocket = null;
  if (old) {
    old.onclose = null;
    old.onerror = null;
    old.onmessage = null;
    try { old.close(); } catch { /* egal */ }
  }
  if (wakeReconnectTimer) { clearTimeout(wakeReconnectTimer); wakeReconnectTimer = null; }
  wakeReconnectDelay = 1000;
  connectWakeSocket();
}

// Einmal beim App-Start aufrufen. Idempotent.
export function startWakeSocket(): void {
  if (wakeStarted) return;
  wakeStarted = true;
  connectWakeSocket();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', forceWakeReconnect);
    let hiddenSince = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
      // Laenger unsichtbar (Tab im Hintergrund / Laptop im Standby) -> Socket
      // ist sehr wahrscheinlich tot, sicherheitshalber frisch verbinden.
      if (hiddenSince && Date.now() - hiddenSince > 30000) forceWakeReconnect();
      hiddenSince = 0;
    });
  }
}

// Bei jeder Aenderung der Kontaktliste aufrufen - ersetzt die vorherige
// Abo-Liste komplett (kein Anhaeufen). Audit 2026-09-28: nur senden, wenn
// sich die ID-Menge wirklich geaendert hat (der Relay verwirft Abos schneller
// als 1/s), und "<id>_offer" mit abonnieren, damit auch aeltere Relays ein
// eingehendes Reconnect-Angebot sofort melden.
let wakeSubscribeTimer: ReturnType<typeof setTimeout> | null = null;
export function setWakeSubscriptions(ids: string[]): void {
  const next: string[] = [];
  for (const id of [...new Set(ids)].sort()) next.push(id, id + '_offer');
  if (next.join(',') === wakeSubscribedIds.join(',')) return;
  wakeSubscribedIds = next;
  if (wakeSubscribeTimer) clearTimeout(wakeSubscribeTimer);
  wakeSubscribeTimer = setTimeout(() => {
    wakeSubscribeTimer = null;
    if (wakeSocket?.readyState === WebSocket.OPEN) {
      wakeSocket.send(JSON.stringify({ subscribe: wakeSubscribedIds }));
    }
  }, 1100);
}

export function onWake(listener: WakeListener): () => void {
  wakeListeners.push(listener);
  return () => {
    wakeListeners = wakeListeners.filter((l) => l !== listener);
  };
}

// -- TURN-Zugangsdaten --
let turnCredsCache: { username: string; credential: string } | null = null;
let turnCredsCacheUntil = 0;

export async function getTurnCredentials(): Promise<{ username: string; credential: string } | null> {
  if (turnCredsCache && Date.now() < turnCredsCacheUntil) return turnCredsCache;
  try {
    const res = await relayFetch(`${RELAY_URL}/turn-credentials`);
    if (!res.ok) throw new Error('TURN-Zugangsdaten-Abruf fehlgeschlagen');
    const data = await res.json();
    turnCredsCache = { username: data.username, credential: data.credential };
    turnCredsCacheUntil = Date.now() + 5 * 60 * 1000;
    return turnCredsCache;
  } catch (e) {
    console.warn('[TURN] Konnte keine frischen Zugangsdaten holen:', (e as Error).message);
    return null;
  }
}
