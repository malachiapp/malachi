/* eslint-env node */
// TextSafety.js (Audit 2026-10-19, G9): Namen der Gegenseite ohne Bidi- und
// Nullbreiten-Zeichen - im Kontakt-Namen (profile_name/handshake, zentral in
// RTCStore) und in Gruppen-/Mitgliedsnamen (GroupMessaging).
const fs = require('fs');
const path = require('path');
const { cleanDisplayName, cleanDisplayText } = require('../../TextSafety');

describe('cleanDisplayName', () => {
  test('Bidi-Overrides/-Isolates/-Marken und Nullbreiten fliegen raus', () => {
    expect(cleanDisplayName('Alice‮ecila')).toBe('Aliceecila');
    expect(cleanDisplayName('⁦Bob⁩')).toBe('Bob');
    expect(cleanDisplayName('Ali​ce')).toBe('Alice');
    expect(cleanDisplayName('Ali‍ce')).toBe('Alice');            // loses ZWJ zwischen Buchstaben
    expect(cleanDisplayName('A‎lice‏')).toBe('Alice');
    expect(cleanDisplayName('﻿Carol­')).toBe('Carol');
    expect(cleanDisplayName('ㅤ')).toBe('');                       // Hangul-Fueller (unsichtbarer Name)
    expect(cleanDisplayName('Zeile1\nZeile2\t x')).toBe('Zeile1 Zeile2 x');
  });

  test('normale Namen bleiben, auch RTL-Schrift und Emoji-Folgen', () => {
    expect(cleanDisplayName('Kev Meyer')).toBe('Kev Meyer');
    expect(cleanDisplayName('محمد')).toBe('محمد');
    expect(cleanDisplayName('דוד')).toBe('דוד');
    const familie = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(cleanDisplayName('Fam ' + familie)).toBe('Fam ' + familie);
    expect(cleanDisplayName('Herz ❤️‍\u{1F525}')).toBe('Herz ❤️‍\u{1F525}');
  });

  test('Laenge begrenzt, Nicht-Text -> leer', () => {
    expect(cleanDisplayName('x'.repeat(200), 32)).toHaveLength(32);
    expect(cleanDisplayName(null)).toBe('');
    expect(cleanDisplayName(42)).toBe('');
  });
});

describe('cleanDisplayText (Beschreibung)', () => {
  test('Zeilenumbrueche bleiben, unsichtbare Zeichen nicht', () => {
    expect(cleanDisplayText('Zeile 1\r\nZeile‮ 2')).toBe('Zeile 1\nZeile 2');
    expect(cleanDisplayText('a​b', 500)).toBe('ab');
  });
});

describe('Verdrahtung', () => {
  test('RTCStore bereinigt den Namen der Gegenseite vor jeder Anzeige/Speicherung', () => {
    jest.isolateModules(() => {
      require('./helpers/nativeBridgeMock').installKyberModuleMock();
      const RTCStore = require('../../RTCStore').default;
      const seen = [];
      RTCStore.setMessageListener('c_x', (m) => seen.push(m));
      const rtc = { sendMessage() {}, _closed: false };
      RTCStore.connections.set('c_x', rtc);
      RTCStore._onIncoming('c_x', rtc, { type: 'system', subtype: 'profile_name', name: 'Bo‮b​' });
      RTCStore._onIncoming('c_x', rtc, { type: 'system', subtype: 'handshake', name: '⁦⁩' });
      expect(seen.map((m) => m.name)).toEqual(['Bob', 'Malachi User']);
      RTCStore.setMessageListener('c_x', null);
      RTCStore.connections.delete('c_x');
    });
  });

  test('Gruppen: Namen/Mitgliedsnamen/Beschreibung ueber safeName/safeDesc, Texte unveraendert ueber cleanText', () => {
    const gm = fs.readFileSync(path.join(__dirname, '../../GroupMessaging.js'), 'utf8');
    expect(gm).toMatch(/const name = safeName\(msg\.name, NAME_MAX\);/);
    expect(gm).toMatch(/name: safeName\(m\.name, MEMBER_NAME_MAX\)/);
    expect(gm).toMatch(/description: safeDesc\(msg\.description, DESC_MAX\)/);
    expect(gm).toMatch(/const text = cleanText\(msg\.text, TEXT_MAX\);/);
    expect(gm).not.toMatch(/cleanText\([^)]*(NAME_MAX|DESC_MAX)\)/);
  });
});
