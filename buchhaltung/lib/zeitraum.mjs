// Zeitraeume (Quartale, Jahre) als halboffene Intervalle [von, bis) mit ISO-Daten.

const MUSTER = /^(\d{4})-Q([1-4])$/;

/** '2026-Q4' -> { von: '2026-10-01', bis: '2027-01-01', name, jahr, quartal } */
export function quartal(name) {
  const m = MUSTER.exec(String(name || '').trim().toUpperCase());
  if (!m) throw new Error(`Quartal "${name}" ungueltig - Format JJJJ-Q1 bis JJJJ-Q4, z. B. 2026-Q4`);
  const jahr = Number(m[1]);
  const q = Number(m[2]);
  const monat = (q - 1) * 3 + 1;
  const von = `${jahr}-${String(monat).padStart(2, '0')}-01`;
  const bis = q === 4 ? `${jahr + 1}-01-01` : `${jahr}-${String(monat + 3).padStart(2, '0')}-01`;
  return { name: `${jahr}-Q${q}`, jahr, quartal: q, von, bis };
}

/** Kalenderjahr als Zeitraum. */
export function jahr(j) {
  const n = Number(j);
  if (!Number.isInteger(n) || n < 2000 || n > 2999) throw new Error(`Jahr "${j}" ungueltig`);
  return { name: String(n), jahr: n, von: `${n}-01-01`, bis: `${n + 1}-01-01` };
}

/** Das zuletzt vollstaendig abgeschlossene Quartal (UTC). */
export function letztesAbgeschlossenesQuartal(jetzt = new Date()) {
  const j = jetzt.getUTCFullYear();
  const q = Math.floor(jetzt.getUTCMonth() / 3) + 1;
  return q === 1 ? quartal(`${j - 1}-Q4`) : quartal(`${j}-Q${q - 1}`);
}

/** Das laufende Quartal (UTC). */
export function laufendesQuartal(jetzt = new Date()) {
  return quartal(`${jetzt.getUTCFullYear()}-Q${Math.floor(jetzt.getUTCMonth() / 3) + 1}`);
}

/** Lesbarer Zeitraum: '01.10.2026 bis 31.12.2026'. */
export function lesbar({ von, bis }) {
  const ende = new Date(Date.parse(bis + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  return `${deutschesDatum(von)} bis ${deutschesDatum(ende)}`;
}

export function deutschesDatum(iso) {
  const [j, m, t] = String(iso).slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
}

/** Liegt ein ISO-Datum/-Zeitpunkt im Zeitraum? */
export function imZeitraum(zeitpunkt, { von, bis }) {
  const z = String(zeitpunkt);
  return z >= von && z < bis;
}
