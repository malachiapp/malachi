// Lokale Vorschau: startet eine Kopie von relay.js auf 127.0.0.1-tauglichen
// Ports (statt der fest eingetragenen 3333/5356/443) und liefert web/dist aus
// - genau wie der echte Server, inkl. der neuen Sicherheits-Header (CSP usw.).
// Nur fuer die Entwicklung; die Kopie wird beim Beenden wieder geloescht.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const port = Number(process.env.PREVIEW_PORT) || 8790;
const src = fs.readFileSync(path.join(root, 'relay.js'), 'utf8')
  .replace('server.listen(3333', `server.listen(${port}`)
  .replace('server5356.listen(5356', `server5356.listen(${port + 1}`)
  .replace('server443.listen(443', `server443.listen(${port + 2}`);
const scratch = path.join(root, 'relay-preview-scratch.js');
fs.writeFileSync(scratch, src);
const child = spawn(process.execPath, [scratch], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WEB_DIST_PATH: path.join(root, 'web', 'dist'), TLS_CERT_PATH: '', TLS_KEY_PATH: '' },
});
const cleanup = () => { try { fs.unlinkSync(scratch); } catch {} };
child.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(); });
