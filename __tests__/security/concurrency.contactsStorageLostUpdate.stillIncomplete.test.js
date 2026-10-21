// FINAL RED-TEAM FUND (SECURITY_FINAL_REDTEAM.md), MITTLERWEILE BEHOBEN:
// 62e3464 ("Kontaktlisten-Lost-Update-Race behoben") migrierte nur die ~9
// Aufrufstellen, die 'contacts' per `AsyncStorage.getItem('contacts')` von
// der Platte lasen (per Grep gefunden) - eine zweite, unabhaengige
// Musterklasse blieb dabei unentdeckt: Stellen, die 'contacts' NIE von der
// Platte lesen, sondern direkt aus dem bereits aktuellen React-State
// ableiten und NUR schreiben (`setContacts(c => {...; AsyncStorage.setItem
// ('contacts', ...)})`). Acht solche Stellen existierten weiterhin
// unmigriert:
//
//   - global.incrementBadge
//   - der 'delete_chat'-Handler im Relay-Polling-Pfad (checkIncoming)
//   - der 'device_wiped'-Handler im Relay-Polling-Pfad (checkIncoming)
//   - der 'phone_connect_offer'-Handler, neuer Kontakt
//   - der pauschale `React.useEffect(() => {... AsyncStorage.setItem
//     ('contacts', ...) ...}, [contacts])` Auto-Persist - feuerte bei JEDER
//     Aenderung des contacts-States, unabhaengig vom ausloesenden Pfad, und
//     konkurrierte damit sogar gegen die bereits migrierten 9 Stellen
//   - der onRename-Handler, inline im screens-Objekt
//   - der onDelete-Handler, inline im screens-Objekt
//   - ConnectScreen onConnected, neuer Kontakt
//
// FIX: alle acht Stellen leiten jetzt ueber `updateContacts()`. Der
// pauschale Auto-Persist-Effekt wurde komplett entfernt (nicht migriert) -
// er war nach der Migration der einzelnen Stellen strukturell redundant
// (jede echte Aenderung persistiert sich jetzt selbst) UND aktiv schaedlich
// (haette als neunter, weiterhin unserialisierter Schreibpfad die gerade
// erst geschlossene Race wieder geoeffnet). Es gibt jetzt genau EINEN
// Schreibpfad fuer 'contacts': `updateContacts()`.

const EncryptedStorage = require('react-native-encrypted-storage').default;
const { updateContacts } = require('../../App');
const fs = require('fs');
const path = require('path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
// Seit Stufe 2 (FOREGROUND_SERVICE_PLAN.md 3a) stehen der Relay-Polling-Pfad
// (ex checkIncoming: delete_chat/device_wiped/phone_connect_offer), die
// Tombstone-Logik von wipeContactLocally() und die updateContacts()-
// Schreibkette selbst in BackgroundSync.js (gemeinsam mit dem Headless-Task).
const BG_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'BackgroundSync.js'), 'utf8');

describe('Kontaktlisten-Lost-Update-Fix (62e3464) war unvollstaendig - acht weitere Direkt-Schreib-Stellen jetzt ebenfalls ueber updateContacts() migriert (Fund behoben)', () => {
  beforeEach(async () => {
    await EncryptedStorage.clear();
  });

  test('statisch: keine der acht identifizierten Stellen schreibt mehr direkt per AsyncStorage.setItem(\'contacts\', ...) - alle nutzen jetzt updateContacts()', () => {
    // global.incrementBadge - Parameter um 'preview' erweitert (Kontaktlisten-
    // Vorschau der letzten Nachricht), Schreibpfad selbst unveraendert.
    expect(APP_SRC).toMatch(/global\.incrementBadge = \(chatId, preview\) => \{[\s\S]{0,700}updateContacts\(cs => cs\.map/);
    // delete_chat/device_wiped: der fruehere Relay-Polling-Pfad (runIncomingCycle,
    // ex checkIncoming) ist seit der serverlosen Umstellung (Okt. 2026)
    // entfallen. Beide kommen nur noch per P2P/Tor und laufen bei geschlossenem
    // Chat zentral ueber applyControlSignal() -> removeContactLocally() bzw.
    // wipeContactLocally(), die selbst updateContacts() nutzen.
    expect(BG_SRC).toMatch(/case 'delete_chat':\s*removeContactLocally\(contactId\)/);
    expect(BG_SRC).toMatch(/export function wipeContactLocally\(contactId, onContactsChanged = noop\) \{[\s\S]{0,500}updateContacts\(cs => cs\.map/);
    expect(APP_SRC).toMatch(/const wipeContactLocally = \(contactId\) => \{\s*sharedWipeContactLocally\(contactId, setContacts\);/);
    expect(BG_SRC).toMatch(/case 'device_wiped':\s*wipeContactLocally\(contactId, setContacts\)/);
    // phone_connect_offer, neuer Kontakt - Audit 2026-09-28: dieser Zweig
    // wurde komplett entfernt (legte aus einem unverschluesselten,
    // unauthentifizierten Relay-Paket einen Kontakt an und war zusaetzlich
    // funktionslos, siehe Kommentar in BackgroundSync.js). Es darf daher auch
    // keinen Direkt-Schreibpfad mehr geben - und keinen Handler dafuer.
    expect(BG_SRC).not.toMatch(/msg\.type === 'phone_connect_offer'/);
    // Einziger verbleibender Direkt-Schreibzugriff ist der in updateContacts() selbst.
    expect(BG_SRC.match(/AsyncStorage\.setItem\('contacts'/g)).toHaveLength(1);
    // onRename (inline im screens-Objekt) - seit 2026-10-18 zusammenfuehrend
    // statt ersetzend (eine veraltete chat-Kopie loeschte sonst das Profilbild).
    expect(APP_SRC).toMatch(/onRename=\{\(updated\) => \{[\s\S]{0,900}updateContacts\(cs => cs\.map\(x => x\.id === patch\.id \? \{ \.\.\.x, \.\.\.patch \} : x\)\)/);
    // onDelete - seit dem Chat-Header-Redesign (Design-Feedback: Header war
    // ueberladen, Papierkorb-Icon entfernt, Loeschen jetzt zentral ueber die
    // gemeinsame deleteContact()/deleteContactCleanup()-Funktion, auch von
    // der Kontaktliste per Mehrfachauswahl aufrufbar) kein Inline-Handler
    // mehr - Wiring und eigentliche Loesch-Logik getrennt geprueft.
    expect(APP_SRC).toMatch(/onDelete=\{\(chatId\) => \{ deleteContact\(chatId\)/);
    // Nur-P2P-Umstellung 2026-09-29: deleteContactCleanup() in App.tsx ist
    // durch requestContactDeletion()/removeContactLocally() in
    // BackgroundSync.js ersetzt - beide schreiben weiterhin nur ueber
    // updateContacts().
    expect(APP_SRC).toMatch(/requestContactDeletion\(chatId\)/);
    expect(BG_SRC).toMatch(/export function removeContactLocally\(contactId\) \{[\s\S]{0,300}updateContacts\(cs => cs\.filter\(x => x\.id !== contactId\)\)/);
    expect(BG_SRC).toMatch(/export async function requestContactDeletion\(contactId\) \{[\s\S]{0,900}await updateContacts\(cs => cs\.map\(x => x\.id === contactId/);
    // ConnectScreen onConnected, neuer Kontakt (nie doppelt anlegen)
    expect(APP_SRC).toMatch(/updateContacts\(cs => \(cs\.some\(x => x\.id === contact\.id\) \? null : \[\.\.\.cs, contact\]\)\)/);
    // Sanity: updateContacts() existiert weiterhin als DER eine Schreibpfad -
    // genau EINE Schreibkette (BackgroundSync.js), App.tsx leitet nur weiter.
    expect(APP_SRC).toMatch(/export async function updateContacts\(mutator\) \{\s*return sharedUpdateContacts\(mutator\);/);
    expect(APP_SRC).not.toMatch(/contactsWriteChain/);
    expect(BG_SRC).toMatch(/export async function updateContacts\(mutator\)/);
    expect((BG_SRC.match(/let contactsWriteChain = /g) || []).length).toBe(1);
  });

  test('statisch: der pauschale useEffect-Auto-Persist (feuerte bei JEDER contacts-Aenderung unabhaengig vom Pfad) ist vollstaendig entfernt', () => {
    expect(APP_SRC).not.toMatch(/React\.useEffect\(\(\) => \{\s*const realContacts = contacts\.filter[\s\S]{0,150}AsyncStorage\.setItem\('contacts', JSON\.stringify\(contacts\)\);/);
  });

  test('behavioral: zwei ueberlappende updateContacts()-Aufrufe fuer VERSCHIEDENE Kontakte verlieren jetzt keine Aenderung mehr - der urspruengliche Trigger-Fall (Badge-Increment waehrend Profil-Umbenennung) ist geschlossen', async () => {
    const initial = [
      { id: 'A', name: 'Alice', unread: 0 },
      { id: 'B', name: 'Bob',   unread: 0 },
    ];
    await EncryptedStorage.setItem('contacts', JSON.stringify(initial));

    let releaseMutator;
    const gate = new Promise((resolve) => { releaseMutator = resolve; });

    // Pattern A: eine eingehende profile_name-Systemnachricht fuer Kontakt B
    // (simuliert reale native-Bridge-Latenz ueber `await gate`).
    const taskB = updateContacts(async (cs) => {
      await gate;
      return cs.map((c) => (c.id === 'B' ? { ...c, name: 'Bob Renamed' } : c));
    });

    // updateContacts()'s eigenen getItem()-Read abschliessen lassen, bevor
    // der zweite Aufruf unten dazwischenfunkt.
    await Promise.resolve();
    await Promise.resolve();

    // Pattern B: was vorher global.incrementBadge's unmigrierter Direkt-
    // Schreibpfad war, ist jetzt SELBST ein updateContacts()-Aufruf (siehe
    // Fix) - hier direkt nachgebildet, um zu beweisen, dass die Serialisierung
    // greift, nicht nur dass beide Pfade denselben Namen tragen. taskA haengt
    // sich an dieselbe Kette wie taskB und WARTET damit zwangslaeufig, bis
    // taskB fertig ist (kann also noch nicht selbst fertig sein, solange das
    // Gate unten nicht freigegeben wurde - kein separates await hier, sonst
    // Deadlock).
    const taskA = updateContacts((cs) => cs.map((c) => (c.id === 'A' ? { ...c, unread: 1 } : c)));

    releaseMutator();
    await taskB;
    await taskA;

    const final = JSON.parse(await EncryptedStorage.getItem('contacts'));
    const a = final.find((c) => c.id === 'A');
    const b = final.find((c) => c.id === 'B');

    expect(b.name).toBe('Bob Renamed');
    // FIX bestaetigt: Kontakt A's Badge-Increment ueberlebt jetzt, da beide
    // Aenderungen durch dieselbe serialisierte Kette liefen.
    expect(a.unread).toBe(1);
  });
});
