/* eslint-env node */
// Kleinere Befunde des Release-Audits 2026-10-19 (Quelltext-Pruefung - die
// Stellen liegen in ChatScreen/AppInner, die sich nicht isoliert rendern lassen):
//   P8  Secret Chat: kein Galerie-Speichern, kein Standort an fremde Apps,
//       keine Datei in fremden Apps
//   P10 Secret Chat: Eingabefeld ohne Vorschlaege/Autokorrektur
//   P11 Einladungscode/Zahlungsdaten nur geschuetzt in die Zwischenablage
//   P12 Klartext-Reste im Cache werden beim Start entfernt
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');

describe('P8: Secret-Chat-Inhalte verlassen die App nicht', () => {
  test('Datei oeffnen/teilen gesperrt', () => {
    expect(app).toMatch(/const openFileItem = async \(item\) => \{[\s\S]{0,200}if \(secretActive \|\| item\?\.secret\) \{\s+Alert\.alert\('Secret Chat'/);
  });
  test('Bild: kein "In Galerie speichern"', () => {
    expect(app).toMatch(/if \(secretActive \|\| item\.secret\) \{\s+Alert\.alert\(t\('common\.image'\), t\('app\.bilderAusDemSecretChat'\)/);
  });
  test('Standort: keine Karten-App, kein Kopieren', () => {
    expect(app).toMatch(/const secretLocation = secretActive \|\| !!item\.secret;/);
    expect(app).toMatch(/onPress=\{\(\) => \(secretLocation\s+\? Alert\.alert\(t\('common\.location'\)/);
    expect(app).toMatch(/\{!secretLocation && \(\s+<TouchableOpacity onPress=\{copyCoords\}/);
  });
});

describe('P10: Eingabefeld im Secret Chat', () => {
  test('keine Vorschlaege, keine Autokorrektur, kein Autofill', () => {
    expect(app).toMatch(/autoCorrect=\{!secretActive\} spellCheck=\{!secretActive\}/);
    expect(app).toMatch(/importantForAutofill=\{secretActive \? 'no' : 'auto'\}/);
  });
});

describe('P11/T4: Zwischenablage', () => {
  test('Einladungscode und Zahlungsdaten nur ueber copySensitive', () => {
    expect(app).toMatch(/copySensitive\(myFullCode\)/);
    expect(app).toMatch(/const copy = \(text, what\) => \{\s+copySensitive\(String\(text\)\)/);
    // Kein ungeschuetztes Kopieren mehr - nur noch das Leeren beim Wipe.
    const plain = app.match(/Clipboard\.setString\([^)]*\)/g) || [];
    expect(plain).toEqual(["Clipboard.setString('')"]);
  });
});

describe('P12/G9: Klartext-Reste im Cache', () => {
  test('Start-Aufraeumen erfasst Wiedergabe, Aufnahme und Bildauswahl', () => {
    expect(app).toMatch(/const PLAINTEXT_TEMP_RE = \/\^\(play_\|malachi_\|rn_image_picker_lib_temp_\)\/;/);
    expect(app).toMatch(/const isPlainTemp = !isShareCopy && PLAINTEXT_TEMP_RE\.test\(f\.name\);/);
    expect(app).toMatch(/cleanupSharedFileCache\(\);/);
  });
  test('Abspiel-/Aufnahme-Dateien tragen eines der Praefixe', () => {
    const temps = app.match(/CachesDirectoryPath\}\/[a-z_]+/g) || [];
    const grp = fs.readFileSync(path.join(__dirname, '../../GroupChatScreen.tsx'), 'utf8').match(/CachesDirectoryPath\}\/[a-z_]+/g) || [];
    for (const t of [...temps, ...grp]) expect(t.split('/')[1]).toMatch(/^(play_|malachi_)/);
  });
});
