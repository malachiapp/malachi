// Dateirechte von Geheimnissen (geheimnisse.rechteEngGenug): grundsaetzlich nur
// 600/400; systemd-Credentials im eigenen Verzeichnis des Dienstes duerfen
// 0440 haben (Ubuntu 24.04 legt sie so an), sonst nichts Weiteres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rechteEngGenug } from '../src/geheimnisse.js';

function alsLinux(fn) {
  const plattform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', plattform); }
}

test('600/400 immer erlaubt, Gruppe/andere ausserhalb des Credentials-Verzeichnisses nie', () => {
  alsLinux(() => {
    const alt = process.env.CREDENTIALS_DIRECTORY;
    delete process.env.CREDENTIALS_DIRECTORY;
    try {
      assert.equal(rechteEngGenug('/etc/x/schluessel.pem', { mode: 0o100600 }), true);
      assert.equal(rechteEngGenug('/etc/x/schluessel.pem', { mode: 0o100400 }), true);
      assert.equal(rechteEngGenug('/etc/x/schluessel.pem', { mode: 0o100440 }), false);
      assert.equal(rechteEngGenug('/etc/x/schluessel.pem', { mode: 0o100644 }), false);
    } finally {
      if (alt !== undefined) process.env.CREDENTIALS_DIRECTORY = alt;
    }
  });
});

test('systemd-Credential mit 0440 im eigenen Verzeichnis erlaubt - nicht ausserhalb, nicht mit Schreib-/Fremdrechten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-'));
  const alt = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = dir;
  try {
    const realStat = fs.statSync;
    // Verzeichnis-Rechte simulieren (Windows kennt keine POSIX-Rechte)
    fs.statSync = (p, ...r) => (path.resolve(p) === path.resolve(dir) ? { mode: 0o040500 } : realStat(p, ...r));
    try {
      alsLinux(() => {
        const datei = path.join(dir, 'lizenz-schluessel');
        assert.equal(rechteEngGenug(datei, { mode: 0o100440 }), true);
        assert.equal(rechteEngGenug(datei, { mode: 0o100460 }), false);   // Gruppe darf schreiben
        assert.equal(rechteEngGenug(datei, { mode: 0o100444 }), false);   // andere duerfen lesen
        assert.equal(rechteEngGenug(path.join(dir, '..', 'fremd'), { mode: 0o100440 }), false);
      });
      fs.statSync = (p, ...r) => (path.resolve(p) === path.resolve(dir) ? { mode: 0o040755 } : realStat(p, ...r));
      alsLinux(() => {
        assert.equal(rechteEngGenug(path.join(dir, 'lizenz-schluessel'), { mode: 0o100440 }), false);   // Verzeichnis offen
      });
    } finally {
      fs.statSync = realStat;
    }
  } finally {
    if (alt === undefined) delete process.env.CREDENTIALS_DIRECTORY; else process.env.CREDENTIALS_DIRECTORY = alt;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
