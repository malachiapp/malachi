// Geschenk-Lizenzen (werkzeuge/geschenklizenz.js): gilt nur fuer das genannte
// Geraet, Protokoll ohne Lizenztext, ungueltige Geraetecodes werden abgelehnt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pruefeLizenz } from '../src/lizenzpruefer.js';
import { tempVerzeichnis, testSchluesselDatei, GERAET_A, GERAET_B, TEST_OEFFENTLICH } from './hilfen.js';

const WERKZEUG = fileURLToPath(new URL('../src/werkzeuge/geschenklizenz.js', import.meta.url));

function starten(dir, ...args) {
  return spawnSync(process.execPath, [WERKZEUG, '--schluessel', testSchluesselDatei(dir), '--protokoll', path.join(dir, 'geschenke.jsonl'), '--config', path.join(dir, 'fehlt.json'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, MALACHI_SHOP_TESTWERTE_ERLAUBT: '1' },
  });
}

test('Lizenz gilt nur fuer das genannte Geraet; Protokoll ohne Lizenztext', () => {
  const dir = tempVerzeichnis();
  const r = starten(dir, '--geraet', GERAET_A.toLowerCase().replace(/(.{4})/g, '$1-'), '--notiz', 'Mama\nund Papa');
  assert.equal(r.status, 0, r.stderr);
  const lizenz = r.stdout.split('\n').find((z) => z.startsWith('ML1.'));
  assert.ok(lizenz, 'Lizenztext ausgegeben');
  const a = pruefeLizenz(lizenz, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_A });
  assert.equal(a.gueltig, true, a.grund);
  assert.deepEqual(a.daten.feat, ['pro']);
  assert.equal(pruefeLizenz(lizenz, { oeffentlicheSchluessel: [TEST_OEFFENTLICH], geraetecode: GERAET_B }).gueltig, false);

  const protokoll = fs.readFileSync(path.join(dir, 'geschenke.jsonl'), 'utf8');
  assert.ok(!protokoll.includes('ML1.'), 'kein Lizenztext im Protokoll');
  const e = JSON.parse(protokoll.trim());
  assert.equal(e.dev, GERAET_A);
  assert.equal(e.notiz, 'Mama und Papa');
  assert.equal(e.lic, a.daten.lic);

  const liste = starten(dir, '--liste');
  assert.equal(liste.status, 0, liste.stderr);
  assert.match(liste.stdout, new RegExp(a.daten.lic));
});

test('ungueltiger Geraetecode wird abgelehnt, nichts protokolliert', () => {
  const dir = tempVerzeichnis();
  const r = starten(dir, '--geraet', 'ABC');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ungueltiger Geraetecode/);
  assert.equal(fs.existsSync(path.join(dir, 'geschenke.jsonl')), false);
});

test('Kurzform ohne --geraet und abgetippte 0/O-Verwechslung werden angenommen', () => {
  const dir = tempVerzeichnis();
  const vertippt = GERAET_A.replace(/O/g, '0').replace(/I/g, '1').replace(/B/g, '8');
  const r = starten(dir, vertippt, 'Kev');
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(fs.readFileSync(path.join(dir, 'geschenke.jsonl'), 'utf8').trim());
  assert.equal(e.dev, GERAET_A);
  assert.equal(e.notiz, 'Kev');
});
