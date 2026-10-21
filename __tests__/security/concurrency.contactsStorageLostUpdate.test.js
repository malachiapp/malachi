// KONKURRENZ-REVIEW (FIX): App.tsx hatte ~14+ unabhaengige
// `AsyncStorage.getItem('contacts').then(saved => {...ein Feld aendern...;
// AsyncStorage.setItem('contacts', JSON.stringify(updated));})`-Aufrufstellen
// (Redundanz-Fund B1 in SIMPLIFICATION_PASS.md, aus der Konkurrenz-
// Perspektive erneut gefunden in SECURITY_CONCURRENCY_REVIEW.md §5) - ein
// klassisches Lost-Update-Muster: zwei ueberlappende Zyklen fuer
// VERSCHIEDENE Kontakte lesen beide denselben veralteten Snapshot, und wer
// zuletzt schreibt, verwirft die Aenderung des anderen stillschweigend.
//
// BEHOBEN in dieser Passe: alle ~9 echten Read-Modify-Write-Aufrufstellen
// (die reinen Lese-Stellen ohne Rueckschreiben - Polling-Schleifen, die
// 'contacts' nur laden um Kontakte zu iterieren - wurden bewusst NICHT
// angefasst, siehe CONTACTS_RACE_FIX.md) laufen jetzt ueber die neue,
// serialisierende Funktion `updateContacts()` (App.tsx, direkt nach dem
// AsyncStorage-Wrapper definiert, als benannter Export zusaetzlich zum
// Default-Export von App). Ein modulweiter Promise-Ketten-Mutex sorgt
// dafuer, dass jeder Aufruf auf den vorherigen wartet, bevor er selbst
// liest - zwei ueberlappende Aufrufe fuer verschiedene Kontakte werden so
// automatisch serialisiert statt parallel auf demselben veralteten Snapshot
// zu arbeiten.
//
// Wichtig zur Einordnung: App.tsx's eigenes `AsyncStorage` (Zeilen ~22-26)
// ist KEIN echtes @react-native-async-storage/async-storage, sondern ein
// duenner Wrapper, der jede Methode 1:1 an `EncryptedStorage` durchreicht
// (`getItem: (key) => EncryptedStorage.getItem(key)`, etc.). Dieser Fund war
// zuvor faelschlich als "contacts liegt in Klartext-AsyncStorage" in
// SECURITY_SECRETS_LIFECYCLE.md dokumentiert - siehe die Korrektur dort und
// in SECURITY_SECRETS_LIFECYCLE_FIXES.md (Fix 7), sowie CONTACTS_RACE_FIX.md
// fuer die vollstaendige Einordnung.

const EncryptedStorage = require('react-native-encrypted-storage').default;

// Importiert die ECHTE Funktion aus App.tsx (benannter Export, ausschliesslich
// fuer diesen Test hinzugefuegt) statt sie nur nachzubauen - App.tsx laesst
// sich unter dem RN-Jest-Preset + den vorhandenen manuellen Mocks
// (__mocks__/react-native-encrypted-storage.js u.a.) importieren, siehe
// __tests__/App.test.tsx, das den vollen Default-Export bereits rendert.
const { updateContacts } = require('../../App');

// Mirrort App.tsx's tatsaechlichen AsyncStorage-Wrapper woertlich (Zeilen
// ~22-26) - nur noch fuer die Kontrollgruppen-/Dokumentations-Tests unten
// gebraucht, die das URSPRUENGLICHE (unsichere) Muster zu Vergleichszwecken
// nachbauen.
const AsyncStorage = {
  getItem: (key) => EncryptedStorage.getItem(key),
  setItem: (key, value) => EncryptedStorage.setItem(key, value),
};

// Mirrort das EHEMALIGE Read-Modify-Write-Muster, das vor diesem Fix an
// ~9 Stellen in App.tsx wiederkehrte: frisch von der Platte lesen, EIN Feld
// EINES Kontakts aendern, den KOMPLETTEN Wert zurueckschreiben - OHNE jede
// Serialisierung. Dient hier nur noch als Kontrollgruppe/Dokumentation des
// urspruenglichen Fundes, nicht mehr als Beschreibung des aktuellen Codes.
async function updateOneContactFieldUnsafe(contactId, patch, opts = {}) {
  const saved = await AsyncStorage.getItem('contacts');
  if (!saved) return;
  const cs = JSON.parse(saved);
  if (opts.delayBeforeWrite) await opts.delayBeforeWrite;
  const updated = cs.map((c) => (c.id === contactId ? { ...c, ...patch } : c));
  await AsyncStorage.setItem('contacts', JSON.stringify(updated));
}

describe('Konkurrenz-Review: echte updateContacts()-Funktion aus App.tsx - kein Lost-Update mehr unter echter Ueberlappung', () => {
  beforeEach(async () => {
    await EncryptedStorage.clear();
  });

  test('A + B gleichzeitig fuer VERSCHIEDENE Kontakte (das im Mandat genannte Beispiel: eingehende Nachricht erhoeht unread fuer Kontakt A, waehrend der Nutzer gleichzeitig Kontakt B umbenennt) - BEIDE Aenderungen bleiben erhalten, weil updateContacts() den zweiten Aufruf auf den ersten warten laesst', async () => {
    await EncryptedStorage.setItem('contacts', JSON.stringify([
      { id: 'A', name: 'Alice', unread: 0 },
      { id: 'B', name: 'Bob', unread: 0 },
    ]));

    // "A": eingehende Nachricht erhoeht unread. Kein kuenstliches Delay noetig
    // hier - updateContacts() serialisiert ueber die interne Promise-Kette,
    // nicht ueber Timing. Beide Aufrufe werden bewusst OHNE await
    // hintereinander gestartet, um echte Ueberlappung zu erzwingen.
    const taskA = updateContacts((cs) => cs.map((c) => (c.id === 'A' ? { ...c, unread: 1 } : c)));
    // "B": Nutzer benennt Kontakt B um - gestartet, WAEHREND A's Zyklus noch
    // laeuft (kein await zwischen den beiden Aufrufen).
    const taskB = updateContacts((cs) => cs.map((c) => (c.id === 'B' ? { ...c, name: 'Bob Renamed' } : c)));

    await Promise.all([taskA, taskB]);

    const final = JSON.parse(await EncryptedStorage.getItem('contacts'));
    const a = final.find((c) => c.id === 'A');
    const b = final.find((c) => c.id === 'B');

    // Vor dem Fix haette hier (je nach Abschlussreihenfolge) eine der beiden
    // Aenderungen gefehlt - siehe Kontrollgruppen-Test unten, der das
        // unsichere Muster zu Vergleichszwecken reproduziert.
    expect(a.unread).toBe(1);
    expect(b.name).toBe('Bob Renamed');
  });

  test('Drei gleichzeitige Aufrufe fuer DENSELBEN Kontakt (verschiedene Felder) - alle drei Aenderungen sind am Ende vorhanden, keine geht verloren', async () => {
    await EncryptedStorage.setItem('contacts', JSON.stringify([
      { id: 'A', name: 'Alice', unread: 0, theirAvatar: null },
    ]));

    const t1 = updateContacts((cs) => cs.map((c) => (c.id === 'A' ? { ...c, unread: 5 } : c)));
    const t2 = updateContacts((cs) => cs.map((c) => (c.id === 'A' ? { ...c, name: 'Alice Renamed' } : c)));
    const t3 = updateContacts((cs) => cs.map((c) => (c.id === 'A' ? { ...c, theirAvatar: 'data:...' } : c)));

    await Promise.all([t1, t2, t3]);

    const final = JSON.parse(await EncryptedStorage.getItem('contacts'));
    const a = final.find((c) => c.id === 'A');
    expect(a.unread).toBe(5);
    expect(a.name).toBe('Alice Renamed');
    expect(a.theirAvatar).toBe('data:...');
  });

  test('Mutator, der null zurueckgibt (kein Treffer/keine Aenderung noetig), loest KEINEN Schreibvorgang aus - der vorherige Wert bleibt exakt erhalten', async () => {
    const original = [{ id: 'A', name: 'Alice', nameEdited: true }];
    await EncryptedStorage.setItem('contacts', JSON.stringify(original));

    const result = await updateContacts((cs) => {
      const contact = cs.find((c) => c.id === 'A');
      if (!contact || contact.nameEdited) return null; // z.B. profile_name-Guard
      return cs.map((c) => (c.id === 'A' ? { ...c, name: 'Ueberschrieben' } : c));
    });

    expect(result).toBeNull();
    const final = JSON.parse(await EncryptedStorage.getItem('contacts'));
    expect(final).toEqual(original);
  });

  test('Ein fehlschlagender Aufruf blockiert nicht dauerhaft die Kette fuer nachfolgende Aufrufe', async () => {
    await EncryptedStorage.setItem('contacts', JSON.stringify([{ id: 'A', name: 'Alice', unread: 0 }]));

    const failing = updateContacts(() => {
      throw new Error('simulierter Fehler im Mutator');
    });
    await expect(failing).rejects.toThrow('simulierter Fehler im Mutator');

    // Ein nachfolgender, gesunder Aufruf muss trotzdem normal durchlaufen -
    // sonst wuerde ein einziger Fehler jeden weiteren 'contacts'-Zugriff fuer
    // den Rest der App-Laufzeit blockieren (schlimmer als das urspruengliche
    // Lost-Update-Problem).
    await updateContacts((cs) => cs.map((c) => (c.id === 'A' ? { ...c, unread: 3 } : c)));

    const final = JSON.parse(await EncryptedStorage.getItem('contacts'));
    expect(final.find((c) => c.id === 'A').unread).toBe(3);
  });
});

describe('Dokumentation des urspruenglichen Fundes (Kontrollgruppen, reproduzieren das VOR dem Fix bestehende unsichere Muster zu Vergleichszwecken - testen NICHT mehr den aktuellen App.tsx-Code)', () => {
  beforeEach(async () => {
    await EncryptedStorage.clear();
  });

  test('Unsicheres Muster (updateOneContactFieldUnsafe, kein Mutex): der zuerst FERTIGE Schreibvorgang wird vom zweiten stillschweigend ueberschrieben - genau der Fund, den updateContacts() jetzt behebt', async () => {
    await AsyncStorage.setItem('contacts', JSON.stringify([
      { id: 'A', name: 'Alice', unread: 0 },
      { id: 'B', name: 'Bob', unread: 0 },
    ]));

    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const taskA = updateOneContactFieldUnsafe('A', { unread: 1 }, { delayBeforeWrite: gateA });

    await new Promise((r) => setTimeout(r, 0));

    await updateOneContactFieldUnsafe('B', { name: 'Bob Renamed' });

    releaseA();
    await taskA;

    const final = JSON.parse(await AsyncStorage.getItem('contacts'));
    const a = final.find((c) => c.id === 'A');
    const b = final.find((c) => c.id === 'B');

    expect(a.unread).toBe(1);
    // DER URSPRUENGLICHE BEFUND: B's Umbenennung ist WEG - jetzt nur noch
    // reproduziert ueber das absichtlich unveraenderte Vergleichsmuster,
    // nicht mehr ueber echten App.tsx-Code (der laeuft seit diesem Fix ueber
    // updateContacts() und ist im Test oben separat verifiziert).
    expect(b.name).toBe('Bob'); // NICHT 'Bob Renamed'
  });

  test('Kontrollgruppe: ohne Ueberlappung bleiben beide Aenderungen erhalten - bestaetigt, dass das unsichere Muster fuer sich genommen korrekt ist und nur echte Ueberlappung das Problem war', async () => {
    await AsyncStorage.setItem('contacts', JSON.stringify([
      { id: 'A', name: 'Alice', unread: 0 },
      { id: 'B', name: 'Bob', unread: 0 },
    ]));

    await updateOneContactFieldUnsafe('A', { unread: 1 });
    await updateOneContactFieldUnsafe('B', { name: 'Bob Renamed' });

    const final = JSON.parse(await AsyncStorage.getItem('contacts'));
    expect(final.find((c) => c.id === 'A').unread).toBe(1);
    expect(final.find((c) => c.id === 'B').name).toBe('Bob Renamed');
  });
});
