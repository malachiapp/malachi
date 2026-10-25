// Zentrale Server-Adresse der Web-App - Gegenstueck zu AppConfig.js (nativ).
// Beim Umzug auf einen neuen Server NUR hier und dort aendern
// (siehe server/hetzner/ANLEITUNG.md, Schritt 9).
export const RELAY_HOST = 'malachii.duckdns.org';
// Kein STUN mehr (STUN-Ausstieg) - die Web-App nutzt wie die native App
// keine ICE-Server (web/src/lib/WebRTCManager.ts).
