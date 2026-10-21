// Sicherheitsreview 4 - Testet die Zeitstempel-Frische-Pruefung, die den
// Replay-Schutz auf relay-vermittelten Nachrichten traegt (App.tsx
// isFreshTimestamp(), web/src/App.tsx isFreshTimestamp() - beide identisch).
// App.tsx/web-App.tsx selbst lassen sich wegen diverser RN-/Browser-globaler
// Abhaengigkeiten (react-native-vector-icons, WebRTC-Globals etc.) nicht
// direkt unter Jest importieren - deshalb hier als woertliche Kopie der
// Funktion gefuehrt (Quelle: App.tsx, Funktion isFreshTimestamp, direkt nach
// generateContactId(); identisch in web/src/App.tsx). Bei Aenderung an der
// echten Funktion muss dieser Test entsprechend nachgezogen werden.
//
// Dieser Test dokumentiert zugleich die VOR Sicherheitsreview 4 bestehende
// Luecke: die urspruengliche Pruefung war nur `!ts || Date.now() - ts >
// 15*60*1000` - fuer ts=Infinity (oder jeden weit in der Zukunft liegenden
// Wert) ist `Date.now() - ts` nie > 15 Minuten, die Nachricht galt fuer immer
// als frisch. isFreshTimestampFixed() unten ist die tatsaechlich jetzt in
// App.tsx/web/src/App.tsx verwendete, gefixte Version.

function isFreshTimestampOriginal(ts) {
  // Wortgetreu die urspruengliche, VOR Review 4 bestehende Pruefung.
  return !!(ts && Date.now() - ts <= 15 * 60 * 1000);
}

function isFreshTimestampFixed(ts) {
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  if (age > 15 * 60 * 1000) return false;
  if (age < -5 * 60 * 1000) return false;
  return true;
}

const FIFTEEN_MIN = 15 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

describe('Replay-Fenster - urspruengliche Luecke (Dokumentation des Bugs)', () => {
  test('Infinity wurde von der urspruenglichen Pruefung faelschlich als frisch akzeptiert', () => {
    expect(isFreshTimestampOriginal(Infinity)).toBe(true); // BUG, dokumentiert
  });

  test('weit in der Zukunft (z.B. +10 Jahre) wurde faelschlich als frisch akzeptiert', () => {
    const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(isFreshTimestampOriginal(farFuture)).toBe(true); // BUG, dokumentiert
  });
});

describe('Replay-Fenster - gefixte Pruefung (aktueller Stand in App.tsx/web)', () => {
  test('genau jetzt ist frisch', () => {
    expect(isFreshTimestampFixed(Date.now())).toBe(true);
  });

  test('knapp innerhalb des 15-Minuten-Fensters ist frisch', () => {
    expect(isFreshTimestampFixed(Date.now() - FIFTEEN_MIN + 1000)).toBe(true);
  });

  test('knapp ausserhalb des 15-Minuten-Fensters wird abgelehnt', () => {
    expect(isFreshTimestampFixed(Date.now() - FIFTEEN_MIN - 1000)).toBe(false);
  });

  test.each([undefined, null, 0, NaN, ''])('fehlender/ungueltiger Zeitstempel (%p) wird abgelehnt', (bad) => {
    expect(isFreshTimestampFixed(bad)).toBe(false);
  });

  test('kleiner Zukunfts-Skew (z.B. 1s, typischer Uhr-Drift) wird noch akzeptiert', () => {
    expect(isFreshTimestampFixed(Date.now() + 1000)).toBe(true);
  });

  test('Zukunfts-Skew knapp innerhalb der 5-Minuten-Toleranz wird akzeptiert', () => {
    expect(isFreshTimestampFixed(Date.now() + FIVE_MIN - 1000)).toBe(true);
  });

  test('Zukunfts-Skew knapp ausserhalb der 5-Minuten-Toleranz wird abgelehnt', () => {
    expect(isFreshTimestampFixed(Date.now() + FIVE_MIN + 1000)).toBe(false);
  });

  test('Infinity wird jetzt korrekt abgelehnt (Fix fuer den oben dokumentierten Bug)', () => {
    expect(isFreshTimestampFixed(Infinity)).toBe(false);
  });

  test('-Infinity wird abgelehnt', () => {
    expect(isFreshTimestampFixed(-Infinity)).toBe(false);
  });

  test('NaN wird abgelehnt', () => {
    expect(isFreshTimestampFixed(NaN)).toBe(false);
  });

  test('weit in der Zukunft (z.B. +10 Jahre) wird jetzt korrekt abgelehnt', () => {
    const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(isFreshTimestampFixed(farFuture)).toBe(false);
  });

  test('weit in der Vergangenheit wird abgelehnt', () => {
    expect(isFreshTimestampFixed(Date.now() - 24 * 60 * 60 * 1000)).toBe(false);
  });
});
