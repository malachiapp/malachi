// Zugriff auf Geheimnisse (Lizenzschluessel, RPC-Zugang, API-Schluessel).
//
// Angaben der Form "credential:<name>" verweisen auf systemd-Credentials
// (LoadCredential=<name>:<datei> in der Unit). systemd stellt die Datei dann nur
// diesem Dienst im RAM bereit ($CREDENTIALS_DIRECTORY, Rechte 0400); die
// Originaldatei kann root gehoeren und fuer niemanden sonst lesbar sein.

import fs from 'node:fs';
import path from 'node:path';

export function geheimnisPfad(angabe) {
  if (typeof angabe !== 'string' || !angabe) throw new Error('Pfad zu einem Geheimnis fehlt');
  if (angabe.startsWith('credential:')) {
    const name = angabe.slice('credential:'.length);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error('Ungueltiger Credential-Name');
    const verzeichnis = process.env.CREDENTIALS_DIRECTORY;
    if (!verzeichnis) throw new Error(`Credential "${name}" angefordert, aber CREDENTIALS_DIRECTORY ist nicht gesetzt (Start ausserhalb von systemd?)`);
    return path.join(verzeichnis, name);
  }
  return angabe;
}

/**
 * Sind die Dateirechte eines Geheimnisses eng genug? Grundsatz: keine Rechte
 * fuer Gruppe/andere (600/400). Ausnahme: Dateien, die systemd per
 * LoadCredential im eigenen Credentials-Verzeichnis des Dienstes bereitstellt -
 * neuere systemd-Versionen (z. B. Ubuntu 24.04) legen sie mit 0440 an. Das
 * Verzeichnis ist nur fuer diesen Dienst zugaenglich; dann ist Lesen fuer die
 * Gruppe erlaubt, solange niemand sonst Rechte hat und niemand schreiben darf.
 */
export function rechteEngGenug(pfad, st) {
  if (process.platform === 'win32') return true;
  if ((st.mode & 0o077) === 0) return true;
  const verzeichnis = process.env.CREDENTIALS_DIRECTORY;
  if (!verzeichnis) return false;
  const rel = path.relative(path.resolve(verzeichnis), path.resolve(pfad));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if ((st.mode & 0o037) !== 0) return false;          // nur Gruppe-Lesen ist toleriert
  try {
    const dir = fs.statSync(verzeichnis);
    if ((dir.mode & 0o007) !== 0) return false;        // Verzeichnis darf fuer andere nicht offen sein
  } catch { return false; }
  return true;
}

/** Liest ein kleines Geheimnis als Text (ohne Zeilenumbruch am Ende). */
export function geheimnisLesen(angabe, { maxBytes = 4096 } = {}) {
  const pfad = geheimnisPfad(angabe);
  const st = fs.statSync(pfad);
  if (st.size > maxBytes) throw new Error(`Geheimnis-Datei ${pfad} ist zu gross`);
  if (!rechteEngGenug(pfad, st)) {
    throw new Error(`Geheimnis-Datei ${pfad} hat zu weite Dateirechte (${(st.mode & 0o777).toString(8)}); erlaubt sind 600 oder 400.`);
  }
  return fs.readFileSync(pfad, 'utf8').replace(/\r?\n$/, '');
}
