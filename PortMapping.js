/**
 * Malachi - Automatische Portfreigabe am Heimrouter (Masterplan Baustein 1)
 *
 * Nach dem Sammeln der Kandidaten bittet die App den eigenen Router (nur das
 * Standard-Gateway im lokalen Netz), den Port des Kandidaten kurz
 * freizugeben: IPv6 = Firewall-Loch fuer die ohnehin oeffentliche Adresse,
 * IPv4 = Weiterleitung (nur mit echter oeffentlicher IPv4). Erfolgreiche
 * IPv4-Weiterleitungen werden zu zusaetzlichen srflx-Kandidaten.
 * Native Seite: android/.../net/MalachiPcpModule.kt - zuerst PCP (RFC 6887),
 * fuer IPv4 ersatzweise NAT-PMP (RFC 6886) und UPnP-IGD. Jede Zeile des
 * Ergebnisses nennt in `method` das Protokoll ('pcp'|'natpmp'|'upnp'); das
 * Modul merkt sich, womit freigegeben wurde, und loescht mit demselben.
 *
 * Seit dem STUN-Ausstieg (STUN_AUSSTIEG_PLAN.md) ist der eigene Router die
 * EINZIGE Quelle einer oeffentlichen IPv4-Adresse - kein Dritter wird
 * gefragt. Deshalb nutzen alle PeerConnections diese Freigabe:
 *   - Chat-Direktverbindung (WebRTCManager): Angebot/Antwort warten kurz auf
 *     den Router; was spaeter kommt, reicht DirectUpgrade als 'direct_cand'
 *     nach (Luecke L3). Ebenso beim ICE-Neustart nach einem Netzwechsel (L2).
 *   - 1:1- und Gruppenanrufe (CallManager, GroupCallManager): nach dem Sammeln
 *     als gewoehnliche Trickle-Kandidaten ('ice') (L1).
 * Jede Freigabe wird erneuert, solange die Verbindung lebt, und beim Schliessen
 * geloescht - auch eine, die erst nach dem Schliessen eintrifft (nie verwaist).
 * Im Verbindungsweg "Maximal anonym (nur Tor)" entsteht keine PeerConnection,
 * der Router wird dann nie gefragt.
 *
 * (Das native Modul wird bei jedem Aufruf nachgeschlagen statt beim Laden
 * festgehalten, damit Tests es ersetzen koennen.)
 */
import { NativeModules } from 'react-native';
import * as ConnectionStats from './ConnectionStats';

const pcpModule = () => NativeModules?.MalachiPcp;
export const PCP_LIFETIME_S = 3600;
const PCP_RENEW_MS = 25 * 60 * 1000;
// So lange wartet ein Angebot bzw. eine Antwort hoechstens auf den Router
// (offer), beim ICE-Neustart nach einem Netzwechsel (restart). Was spaeter
// eintrifft, wird nachgereicht - deshalb kurz (bis 1.1.0 waren es in der
// Stufe ohne STUN 4 s, weil Spaetes verloren war).
export const PORT_MAPPING_MAX_WAIT_MS = { offer: 1500, restart: 1000 };
// Hoechstens so viele nachgereichte Kandidaten je Aushandlung (beide Seiten).
export const MAX_LATE_CANDIDATES = 8;
let lastPortMappingStatus = null;
export function getPortMappingStatus() { return lastPortMappingStatus; }

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Keine oeffentliche Adresse: privat, Carrier-NAT (100.64/10), 0/8, Loopback,
// link-lokal, Multicast und reserviert.
const NOT_PUBLIC_V4 = /^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|22[4-9]\.|2[3-5]\d\.)/;
const MAPPING_METHODS = new Set(['pcp', 'natpmp', 'upnp']);
// Prioritaet der Router-Kandidaten (wie srflx bei libwebrtc).
const MAPPED_PRIORITY = 1686052607;

const validPort = (p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) < 65536;

/** Echte oeffentliche IPv4-Adresse (Router-Weiterleitung, kein Carrier-NAT)? */
export function isPublicIPv4(ext) {
  return typeof ext === 'string' && IPV4_RE.test(ext) && !PRIVATE_V4.test(ext) && !NOT_PUBLIC_V4.test(ext);
}

// Host-Kandidaten, fuer die eine Freigabe Sinn ergibt: globale IPv6-Adressen
// (nicht link-lokal/ULA) und private IPv4-Adressen hinter einem Router. Bei TCP
// nur "passive" Kandidaten - nur die nehmen Verbindungen an. Nimmt eine
// SDP-Beschreibung oder einzelne Zeilen ('a=candidate:...' bzw. 'candidate:...').
export function hostCandidatesForMapping(sdp) {
  const out = [];
  const seen = new Set();
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const m = /^(?:a=)?candidate:\S+ 1 (udp|tcp) \d+ (\S+) (\d+) typ host(.*)$/i.exec(line);
    if (!m) continue;
    const protocol = m[1].toLowerCase();
    const address = m[2];
    const port = Number(m[3]);
    if (protocol === 'tcp' && !/tcptype passive/i.test(m[4])) continue;
    const v6 = address.includes(':');
    if (v6 ? /^(fe80|fc|fd)/i.test(address) : !PRIVATE_V4.test(address)) continue;
    if (!(port > 0 && port < 65536)) continue;
    const key = protocol + '|' + address + '|' + port;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ protocol, address, port });
  }
  return out.slice(0, 8);
}

/**
 * Kandidatenzeile (ohne "a=") fuer eine erfolgreiche IPv4-Weiterleitung oder
 * null (IPv6-Pinholes brauchen keinen eigenen Kandidaten - die Host-Adresse
 * ist bereits oeffentlich). Egal ob per PCP, NAT-PMP oder UPnP freigegeben -
 * alle liefern dieselbe Ergebnisform.
 */
export function mappedCandidateLine(r, index) {
  const ext = r?.externalAddress;
  if (r?.result !== 'SUCCESS' || !isPublicIPv4(ext)) return null;
  if (!validPort(r.externalPort)) return null;
  if (r.protocol !== 'udp' && r.protocol !== 'tcp') return null;
  if (typeof r.address !== 'string' || !IPV4_RE.test(r.address) || !validPort(r.port)) return null;
  const tag = MAPPING_METHODS.has(r.method) ? r.method : 'pcp';
  const tcp = r.protocol === 'tcp' ? ' tcptype passive' : '';
  return `candidate:${tag}${index} 1 ${r.protocol} ${MAPPED_PRIORITY} ${ext} ${r.externalPort} typ srflx raddr ${r.address} rport ${r.port}${tcp}`;
}

// Fuegt fuer erfolgreiche IPv4-Weiterleitungen srflx-Kandidaten mit der
// oeffentlichen Adresse in eine SDP-Beschreibung ein (vor a=end-of-candidates).
export function addMappedCandidates(sdp, results) {
  const lines = [];
  (results || []).forEach((r, i) => {
    const c = mappedCandidateLine(r, i);
    if (c) lines.push('a=' + c);
  });
  if (!lines.length) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const parts = sdp.split(eol);
  let idx = parts.findIndex(l => l.startsWith('a=end-of-candidates'));
  if (idx < 0) {
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].startsWith('a=candidate:')) { idx = i + 1; break; }
  }
  if (idx < 0) return sdp;
  parts.splice(idx, 0, ...lines);
  return parts.join(eol);
}

// Nachgereichter Router-Kandidat der Gegenseite (DirectUpgrade 'direct_cand'):
// genau die Form, die mappedCandidateLine erzeugt - srflx mit oeffentlicher
// IPv4, private IPv4 als raddr. Alles andere (Host-Adressen, IPv6, fremde
// Typen, Zusatzfelder) wird verworfen.
const LATE_CAND_RE = /^candidate:(pcp|natpmp|upnp)\d{1,3} 1 (udp|tcp) (\d{1,10}) (\S+) (\d{1,5}) typ srflx raddr (\S+) rport (\d{1,5})( tcptype passive)?$/;
export function isValidMappedCandidate(cand) {
  if (!cand || typeof cand !== 'object') return false;
  const c = cand.candidate;
  if (typeof c !== 'string' || c.length > 200) return false;
  const m = LATE_CAND_RE.exec(c);
  if (!m) return false;
  if (!isPublicIPv4(m[4]) || !validPort(m[5])) return false;
  if (!IPV4_RE.test(m[6]) || !PRIVATE_V4.test(m[6]) || !validPort(m[7])) return false;
  if ((m[2] === 'tcp') !== !!m[8]) return false;
  if (cand.sdpMid != null && (typeof cand.sdpMid !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(cand.sdpMid))) return false;
  if (cand.sdpMLineIndex != null && (!Number.isInteger(cand.sdpMLineIndex) || cand.sdpMLineIndex < 0 || cand.sdpMLineIndex > 63)) return false;
  return cand.sdpMid != null || cand.sdpMLineIndex != null;
}

// a=mid der ersten Medienzeile (Chat-Verbindung: genau eine, "application").
export function firstMid(sdp) {
  const m = /(?:^|\r?\n)a=mid:([A-Za-z0-9_-]{1,16})(?:\r?\n|$)/.exec(String(sdp || ''));
  return m ? m[1] : null;
}

/**
 * Freigaben EINER PeerConnection: anfragen, erneuern, beim Schliessen loeschen.
 */
export class PortMappingSession {
  constructor() {
    this._mappings = null;
    this._renew = null;
    this.closed = false;
  }

  /** Gemerkte Freigaben (fuer Erneuern/Loeschen) oder null. */
  get mappings() { return this._mappings; }

  available() { return !this.closed && typeof pcpModule()?.map === 'function'; }

  /**
   * Freigabe fuer `wanted` anfragen und hoechstens maxWaitMs warten. Liefert
   * die erfolgreichen Zeilen - oder null, wenn der Router zu langsam war; dann
   * kommt ein spaeteres Ergebnis ueber onLate(erfolgreicheZeilen), sofern die
   * Sitzung noch offen ist.
   */
  async request(wanted, { maxWaitMs = PORT_MAPPING_MAX_WAIT_MS.offer, onLate = null } = {}) {
    const Pcp = pcpModule();
    if (!Pcp?.map || this.closed || !Array.isArray(wanted) || !wanted.length) return [];
    const pending = Promise.resolve(Pcp.map(wanted, PCP_LIFETIME_S));
    let timer = null;
    const results = await Promise.race([
      pending,
      new Promise(r => { timer = setTimeout(() => r(null), maxWaitMs); }),
    ]);
    clearTimeout(timer);
    if (!Array.isArray(results)) {
      // Router antwortet zu langsam (erste Anfrage im Netz: das native Modul
      // probiert PCP, NAT-PMP und UPnP nacheinander). Kommt die Freigabe
      // spaeter doch, wird sie wie jede andere erneuert und beim Schliessen
      // geloescht - und dem Aufrufer zum Nachreichen gemeldet.
      pending.then((late) => {
        const ok = this.adopt(late, 'spaet');
        if (ok.length) ConnectionStats.bump('mapping', 'late');
        if (ok.length && !this.closed && typeof onLate === 'function') onLate(ok);
      }).catch(() => {});
      return null;
    }
    return this.adopt(results, null);
  }

  // Merkt sich erfolgreiche Freigaben (Erneuern alle PCP_RENEW_MS, Loeschen
  // in release()). Ist die Sitzung schon zu, sofort wieder loeschen.
  // Liefert die erfolgreichen Zeilen.
  adopt(results, label) {
    const Pcp = pcpModule();
    if (!Array.isArray(results) || !Pcp?.map) return [];
    const ok = results.filter(r => r && r.result === 'SUCCESS');
    const okMethod = ok.find(r => MAPPING_METHODS.has(r.method))?.method || (ok.length ? 'pcp' : null);
    // Fehlschlag: zuerst ein ausdrueckliches "nicht erlaubt" melden (FritzBox
    // ohne "Selbststaendige Portfreigaben") - das kann der Nutzer aendern.
    const failure = results.find(r => r?.result === 'NOT_AUTHORIZED')?.result || results[0]?.result || 'UNKNOWN';
    lastPortMappingStatus = { at: Date.now(), result: ok.length ? 'SUCCESS' : failure, method: okMethod };
    // Diagnose (ConnectionStats.js): nur das Ergebnis, nie Adressen.
    ConnectionStats.bump('mapping', ok.length ? 'success' : failure === 'NOT_AUTHORIZED' ? 'notAuthorized' : 'unsupported');
    // Bewusst ohne Adressen und Ports (nur Protokoll, IP-Version, Ergebnis).
    console.log('[Portfreigabe]' + (label ? ' (' + label + ')' : ''), results.map(r =>
      r.protocol + '/' + (String(r.address).includes(':') ? 'IPv6' : 'IPv4') + ' ' + r.result
      + (r.method ? ' via ' + r.method : '') + (r.attempts ? ' [' + r.attempts + ']' : '')).join(', '));
    if (!ok.length) return ok;
    const fresh = ok.map(r => ({ protocol: r.protocol, address: r.address, port: r.port }));
    if (this.closed) {
      Promise.resolve(Pcp.map(fresh, 0)).catch(() => {});
      return ok;
    }
    const key = (m) => m.protocol + '|' + m.address + '|' + m.port;
    const merged = new Map((this._mappings || []).map(m => [key(m), m]));
    for (const m of fresh) merged.set(key(m), m);
    this._mappings = [...merged.values()];
    if (this._renew) clearInterval(this._renew);
    this._renew = setInterval(() => {
      const mod = pcpModule();
      if (!this.closed && this._mappings && mod?.map) Promise.resolve(mod.map(this._mappings, PCP_LIFETIME_S)).catch(() => {});
    }, PCP_RENEW_MS);
    this._renew?.unref?.();
    return ok;
  }

  // Verbindung zu: Erneuern beenden, Freigaben am Router loeschen - das native
  // Modul nimmt dafuer dasselbe Protokoll (PCP, NAT-PMP oder UPnP), mit dem
  // sie angelegt wurden. Danach eintreffende Freigaben loescht adopt() sofort.
  release() {
    this.closed = true;
    if (this._renew) {
      clearInterval(this._renew);
      this._renew = null;
    }
    const Pcp = pcpModule();
    if (this._mappings && Pcp?.map) Promise.resolve(Pcp.map(this._mappings, 0)).catch(() => {});
    this._mappings = null;
  }
}

/**
 * Router-Kandidaten fuer eine Anruf-PeerConnection (1:1 und Gruppe, Luecke L1):
 * merkt sich die Host-Kandidaten aus onicecandidate und fragt nach dem Ende
 * des Sammelns (Kandidat null bzw. spaetestens nach GATHER_FALLBACK_MS) einmal
 * den Router. Erfolgreiche IPv4-Freigaben gehen ueber send() als normale
 * Trickle-Kandidaten ({ candidate, sdpMid, sdpMLineIndex }) an die Gegenseite -
 * egal wann der Router antwortet (dort gibt es kein festes Angebot, auf das
 * gewartet werden muesste). release() beim Schliessen der PeerConnection.
 */
const CALL_GATHER_FALLBACK_MS = 3000;
export class CallPortMapper {
  constructor(send, { isAllowed = null } = {}) {
    this._send = send;
    this._isAllowed = isAllowed;
    this._session = new PortMappingSession();
    this._hosts = [];
    this._started = false;
    this._fallback = null;
  }

  get session() { return this._session; }

  /** Aus pc.onicecandidate aufrufen (auch mit null am Ende des Sammelns). */
  onCandidate(cand) {
    if (this._started || this._session.closed) return;
    if (!cand) { this._start(); return; }
    if (typeof cand.candidate !== 'string') return;
    if (/ typ host/.test(cand.candidate) && this._hosts.length < 16) {
      this._hosts.push({ line: cand.candidate, sdpMid: cand.sdpMid ?? null, sdpMLineIndex: cand.sdpMLineIndex ?? null });
    }
    if (!this._fallback) {
      this._fallback = setTimeout(() => this._start(), CALL_GATHER_FALLBACK_MS);
      this._fallback?.unref?.();
    }
  }

  async _start() {
    if (this._started || this._session.closed) return;
    this._started = true;
    clearTimeout(this._fallback);
    this._fallback = null;
    if (!this._session.available() || !this._hosts.length) return;
    try {
      if (typeof this._isAllowed === 'function' && !(await this._isAllowed())) return;
      if (this._session.closed) return;
      const wanted = hostCandidatesForMapping(this._hosts.map(h => h.line).join('\n'));
      if (!wanted.length) return;
      const deliver = (rows) => this._deliver(rows);
      const ok = await this._session.request(wanted, { maxWaitMs: PORT_MAPPING_MAX_WAIT_MS.offer, onLate: deliver });
      if (ok && ok.length) deliver(ok);
    } catch (e) {
      console.log('[Portfreigabe] Anruf: nicht verfuegbar:', e?.message || e);
    }
  }

  _deliver(rows) {
    if (this._session.closed) return;
    rows.forEach((r, i) => {
      const line = mappedCandidateLine(r, i);
      if (!line) return;
      const host = this._hosts.find(h => h.line.includes(' ' + r.address + ' ' + r.port + ' typ host'));
      const cand = { candidate: line, sdpMid: host?.sdpMid ?? '0', sdpMLineIndex: host?.sdpMLineIndex ?? 0 };
      try { this._send(cand); } catch {}
    });
  }

  release() {
    clearTimeout(this._fallback);
    this._fallback = null;
    this._started = true;
    this._session.release();
  }
}
