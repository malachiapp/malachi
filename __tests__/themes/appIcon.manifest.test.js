// "App-Icon passend zum Design": Manifest und native Seite. Der Launcher-
// Eintrag liegt auf activity-alias-Eintraegen (je Icon einer, genau einer
// aktiv); MainActivity behaelt Deep Links und bleibt Ziel aller
// PendingIntents - nichts davon darf am gewaehlten Icon haengen.
const fs = require('fs');
const path = require('path');
const V = require('../../AppIconVariants');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'android', 'app', 'src', 'main');
const JAVA = path.join(APP, 'java', 'com', 'securecommapp');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const manifest = read(path.join(APP, 'AndroidManifest.xml')).replace(/<!--[\s\S]*?-->/g, '');
const NS = /namespace\s+"([\w.]+)"/.exec(read(path.join(ROOT, 'android', 'app', 'build.gradle')))[1];

const attr = (tag, name) => { const m = new RegExp('android:' + name + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
const aliases = [...manifest.matchAll(/<activity-alias([^>]*)>([\s\S]*?)<\/activity-alias>/g)].map(m => ({
  name: attr(m[1], 'name'), target: attr(m[1], 'targetActivity'), enabled: attr(m[1], 'enabled'),
  exported: attr(m[1], 'exported'), icon: attr(m[1], 'icon'), roundIcon: attr(m[1], 'roundIcon'), label: attr(m[1], 'label'),
  launcher: /android\.intent\.action\.MAIN/.test(m[2]) && /android\.intent\.category\.LAUNCHER/.test(m[2]),
}));
const mainActivity = /<activity\s([^>]*android:name="\.MainActivity"[^>]*)>([\s\S]*?)<\/activity>/.exec(manifest);

describe('AndroidManifest.xml', () => {
  test('ein Alias je Variante, in fester Reihenfolge, alle auf MainActivity, exportiert, mit Launcher-Filter', () => {
    expect(aliases.map(a => a.name)).toEqual(V.ICON_VARIANT_IDS.map(id => NS + '.' + V.ICON_ALIAS_PREFIX + id));
    for (const a of aliases) {
      // voll qualifiziert (Namespace, nicht applicationId - die Demo-App hat ".demo")
      expect([a.name, a.target, a.exported, a.launcher, a.label]).toEqual([a.name, NS + '.MainActivity', 'true', true, '${appLabel}']);
    }
  });

  test('genau EIN Launcher-Alias ist aktiviert: das bisherige Marken-Icon', () => {
    const on = aliases.filter(a => a.enabled !== 'false');
    expect(on).toHaveLength(1);
    expect(on[0].name).toBe(NS + '.AppIcon_' + V.DEFAULT_ICON_VARIANT);
    expect(on[0].enabled).toBe('true');
    expect(on[0].icon).toBe('@mipmap/ic_launcher');
    expect(on[0].roundIcon).toBe('@mipmap/ic_launcher_round');
    expect(aliases.filter(a => a.enabled === 'false')).toHaveLength(V.ICON_VARIANT_IDS.length - 1);
  });

  test('jedes Alias-Icon existiert als adaptives Icon (ab Android 8) UND fuer Android 7.x', () => {
    for (const a of aliases) {
      for (const ref of [a.icon, a.roundIcon]) {
        const m = /^@mipmap\/([a-z0-9_]+)$/.exec(ref);
        expect([a.name, !!m]).toEqual([a.name, true]);
        for (const dir of ['mipmap-anydpi-v26', 'mipmap-anydpi']) {
          const f = path.join(APP, 'res', dir, m[1] + '.xml');
          expect([f, fs.existsSync(f)]).toEqual([f, true]);
        }
      }
    }
  });

  test('MainActivity: kein eigener Launcher-Eintrag mehr, Deep Link malachi://connect bleibt, nie deaktiviert', () => {
    expect(mainActivity).not.toBeNull();
    const [, attrs, body] = mainActivity;
    expect(body).not.toMatch(/android\.intent\.category\.LAUNCHER/);
    expect(body).toMatch(/android\.intent\.action\.VIEW/);
    expect(body).toMatch(/android\.intent\.category\.BROWSABLE/);
    expect(body).toMatch(/<data android:scheme="malachi" android:host="connect" \/>/);
    expect(attr(attrs, 'exported')).toBe('true');
    expect(attr(attrs, 'enabled')).not.toBe('false');
    expect(attr(attrs, 'launchMode')).toBe('singleTask');
  });

  test('LAUNCHER kommt ausschliesslich in den Aliasen vor', () => {
    expect((manifest.match(/android\.intent\.category\.LAUNCHER/g) || []).length).toBe(aliases.length);
    expect(manifest.split('<activity-alias').length - 1).toBe(V.ICON_VARIANT_IDS.length);
  });
});

describe('Native Seite', () => {
  const module = read(path.join(JAVA, 'AppIconModule.kt'));
  const variants = read(path.join(JAVA, 'AppIconVariants.kt'));

  test('Modul MalachiAppIcon: feste Id-Liste, erst einschalten, dann ausschalten, DONT_KILL_APP', () => {
    expect(module).toMatch(/override fun getName\(\) = "MalachiAppIcon"/);
    expect(module).toMatch(/id !in AppIconVariants\.IDS/);
    const enable = module.indexOf('COMPONENT_ENABLED_STATE_ENABLED,');
    const disable = module.indexOf('COMPONENT_ENABLED_STATE_DISABLED,');
    expect(enable).toBeGreaterThan(0);
    expect(disable).toBeGreaterThan(enable);
    expect(module.match(/PackageManager\.DONT_KILL_APP/g)).toHaveLength(2);
    expect(module).toMatch(/@ReactMethod\s+fun setIcon\(/);
    expect(module).toMatch(/@ReactMethod\s+fun getIcon\(/);
    // Komponentenname = Paketname zur Laufzeit + fester Alias-Praefix (auch fuer die Demo-App-ID)
    expect(module).toMatch(/ComponentName\(ctx\.packageName, AppIconVariants\.ALIAS_PREFIX \+ id\)/);
    expect(variants).toContain('const val ALIAS_PREFIX = "' + NS + '.' + V.ICON_ALIAS_PREFIX + '"');
  });

  test('Paket in MainApplication registriert', () => {
    const app = read(path.join(JAVA, 'MainApplication.kt'));
    expect(app).toMatch(/add\(AppIconPackage\(\)\)/);
    expect(module).toMatch(/class AppIconPackage : ReactPackage/);
  });

  test('Benachrichtigungen, Anruf-Vollbild und CallBridge zielen weiter direkt auf MainActivity (nicht auf einen Alias)', () => {
    for (const f of ['MalachiNotificationModule.kt', 'calling/CallNotificationHelper.kt', 'calling/CallWakeHelper.kt', 'calling/MalachiConnection.kt']) {
      const src = read(path.join(JAVA, f));
      expect([f, /Intent\(context, MainActivity::class\.java\)/.test(src)]).toEqual([f, true]);
    }
    // nirgends ein Launch ueber den Paketnamen, der vom aktiven Alias abhinge
    const all = fs.readdirSync(JAVA, { recursive: true })
      .filter(f => String(f).endsWith('.kt') && path.basename(String(f)) !== 'AppIconVariants.kt')
      .map(f => read(path.join(JAVA, String(f)))).join('\n');
    expect(all).not.toMatch(/getLaunchIntentForPackage/);
    expect(all).not.toMatch(/AppIcon_/);   // Alias-Namen nur ueber AppIconVariants.kt
  });
});
