// Datenhaltung als JSON-Datei mit atomarem Schreiben
// (temporaere Datei -> fsync -> rename). Schreibvorgaenge laufen strikt
// nacheinander, damit nie ein aelterer Stand einen neueren ueberschreibt.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class SpeicherFehler extends Error {}

export class JsonSpeicher {
  constructor(datei) {
    this.datei = datei;
    this._kette = Promise.resolve();
  }

  /** Liest den gespeicherten Stand; null, wenn noch keine Datei existiert. Beschaedigte Dateien sind ein harter Fehler. */
  async laden() {
    let text;
    try {
      text = await fs.readFile(this.datei, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new SpeicherFehler(`Datei ${this.datei} nicht lesbar (${e.code})`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SpeicherFehler(
        `Datei ${this.datei} ist beschaedigt. Der Shop startet nicht, damit keine Daten ueberschrieben werden. ` +
          'Bitte Datei pruefen bzw. aus der Sicherung wiederherstellen.',
      );
    }
  }

  /** Speichert eine Momentaufnahme von `daten` (wird sofort serialisiert). */
  speichern(daten) {
    const json = JSON.stringify(daten, null, 1);
    const lauf = this._kette.then(
      () => this._schreiben(json),
      () => this._schreiben(json),
    );
    this._kette = lauf.catch(() => {});
    return lauf;
  }

  /** Wartet, bis alle angestossenen Schreibvorgaenge erledigt sind. */
  async leeren() {
    await this._kette;
  }

  async _schreiben(json) {
    const verzeichnis = path.dirname(this.datei);
    const tmp = path.join(verzeichnis, `.${path.basename(this.datei)}.${randomBytes(6).toString('hex')}.tmp`);
    let fh;
    try {
      fh = await fs.open(tmp, 'wx', 0o600);
      await fh.writeFile(json, 'utf8');
      await fh.sync();
      await fh.close();
      fh = null;
      await fs.rename(tmp, this.datei);
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw new SpeicherFehler('Speichern fehlgeschlagen: ' + (e.code || e.message));
    }
    // Verzeichnis-Eintrag dauerhaft machen (unter Windows nicht moeglich - dann ignorieren).
    try {
      const d = await fs.open(verzeichnis, 'r');
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } catch {
      /* best effort */
    }
  }
}

/** Haengt eine Zeile (JSON) an eine Journaldatei an (z. B. Verkaufsjournal fuer die Buchhaltung). */
export async function journalAnhaengen(datei, eintrag) {
  const fh = await fs.open(datei, 'a', 0o600);
  try {
    await fh.writeFile(JSON.stringify(eintrag) + '\n', 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}
