// Zentrale Server-Adresse der Web-App - Gegenstueck zu AppConfig.js (nativ).
// Beim Umzug auf einen neuen Server NUR hier und dort aendern
// (siehe server/hetzner/ANLEITUNG.md, Schritt 9).
export const RELAY_HOST = 'malachii.duckdns.org';
export const STUN_URL = `stun:${RELAY_HOST}:3478`;
