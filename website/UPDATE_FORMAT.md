# Signierte In-App-Updates – Format, Version 1

Stand: 2026-10-19 · Werkzeuge: `website/werkzeuge/veroeffentlichen.mjs` (erzeugt und signiert), `website/werkzeuge/update-schluessel.mjs` (Schlüssel erzeugen/anzeigen, Manifest prüfen), `website/werkzeuge/lib/manifest.mjs` und `lib/krypto.mjs` (Referenz-Implementierung) · Tests: `website/werkzeuge/test/werkzeuge.test.mjs` (`cd website && npm test`).

Dieses Dokument beschreibt, was die Website unter `/updates/` ausliefert und wie die App es prüfen muss. Die App-Seite ist gebaut (`AppUpdater.js`, `UpdateUI.tsx`, `android/.../update/MalachiUpdaterModule.kt`, Abschnitt 9) – dieses Dokument bleibt der Vertrag zwischen beiden.

> **Nur Website-Variante.** Signierte In-App-Updates gibt es ausschließlich im Flavor `web` (App-ID `com.securecommapp`, `./gradlew assembleWebRelease`). Die Google-Play-Variante (Flavor `play`, siehe `PLAY_STORE.md`) wird nur über Google Play aktualisiert: Google Play verbietet Apps, sich an Google Play vorbei selbst zu aktualisieren (Richtlinie „Missbrauch von Geräten und Netzwerken“). Für den künftigen Updater heißt das: Code nur hinter `Distribution.isWeb()`, die Berechtigung `REQUEST_INSTALL_PACKAGES` nur in `android/app/src/web/AndroidManifest.xml` (nie in `src/main`), und die Prüfung von `applicationId` (Abschnitt 4) bleibt auf `com.securecommapp` festgelegt – eine Play-Installation mit eigener App-ID verwirft jedes Manifest ohnehin.

## 1. Wozu und wem wird vertraut

- **Android schützt die APK selbst:** Ein Update wird nur installiert, wenn es mit demselben APK-Signaturschlüssel signiert ist wie die installierte App, und (ohne ADB) nie mit kleinerem `versionCode`. Dieser Schutz bleibt die wichtigste Grenze.
- **Das Manifest schützt die Angaben drumherum:** Version, Mindestversion, Versionshinweise, Dateinamen, Größen und SHA-256 der APKs. Ohne Signatur könnte ein übernommener Webserver zum Beispiel eine erfundene Mindestversion („deine Version ist unsicher, installiere sofort …“) oder Versionshinweise mit Phishing-Links ausliefern.
- **Der Update-Signierschlüssel (Ed25519) liegt nur offline beim Betreiber** (verschlüsselte Datei auf dem eigenen PC bzw. USB-Stick). Auf dem Laptop/Server liegen nur fertig signierte Dateien. Wer den Server übernimmt, kann Updates zurückhalten, aber keine gültigen Manifeste erzeugen.
- Der Schlüssel ist **nur** für Update-Manifeste da – getrennt vom APK-Signaturschlüssel und vom Lizenzschlüssel des Shops.

## 2. Dateien

Alle unter demselben Verzeichnis, über beide Adressen gleich erreichbar:

- Onion (bevorzugt, die App nutzt ihren eigenen Tor): `http://<website-onion>/updates/`
- Clearnet: `https://<domain>/updates/`

| Datei | Inhalt | Content-Type |
|---|---|---|
| `manifest.json` | das signierte Manifest (Abschnitt 4) | `application/json; charset=utf-8` |
| `manifest.json.sig` | Signatur über `manifest.json` (Abschnitt 3) | `text/plain; charset=utf-8` |
| `malachi-<versionName>-<abi>.apk` | die APKs, eine je ABI | `application/vnd.android.package-archive` |
| `SHA256SUMS` | Komfort für Menschen (`sha256sum -c`), **nicht** signiert | `text/plain` |
| `update-schluessel.pem` | öffentlicher Schlüssel als SPKI-PEM (für `openssl`) – die App nutzt ihn **nicht**, sie hat ihren Schlüssel eingebaut | `text/plain` |

`manifest.json` und `manifest.json.sig` werden mit `Cache-Control: no-cache` ausgeliefert, APKs mit `max-age=86400`.

## 3. Signatur

- Verfahren: **Ed25519** nach RFC 8032 (PureEdDSA, ohne Prehash, ohne Kontext).
- Signiert wird die **Bytefolge der Datei `manifest.json`, genau so, wie der Server sie ausliefert** – ohne jede Normalisierung (kein Entfernen eines BOM, keine Zeilenende-Umwandlung, kein Neu-Serialisieren).
- `manifest.json.sig` enthält die 64 Byte der Signatur als **Standard-Base64** (RFC 4648, Abschnitt 4, Alphabet `A–Z a–z 0–9 + /`, mit `=`-Auffüllung) – das sind genau 88 Zeichen –, gefolgt von genau einem LF (`0x0A`).
  - Lesen: ein abschließendes `\n` bzw. `\r\n` entfernen; der Rest muss `^[A-Za-z0-9+/]{86}==$` erfüllen und zu genau 64 Byte dekodieren. Alles andere ablehnen.
- Öffentlicher Schlüssel: 32 Byte roh. In der App als **Base64url ohne Auffüllung** (wie `LICENSE_PUBLIC_KEY` in `AppConfig.js`), als Liste für einen späteren Schlüsselwechsel, z. B. `export const UPDATE_PUBLIC_KEYS = ['…'];`. Ein Manifest ist gültig, wenn **einer** der eingebauten Schlüssel passt. Die App vertraut nie einem Schlüssel, den der Server mitschickt.
- Prüfung **streng** nach RFC 8032: mit `@noble/curves` `ed25519.verify(sig, msg, pub, { zip215: false })`. Mit Node: `crypto.verify(null, msg, publicKey, sig)`. Mit OpenSSL 3: siehe Abschnitt 8.

## 4. Manifest

UTF-8 ohne BOM, ein JSON-Objekt. **Unbekannte Felder sind ein Fehler** (neue Felder kommen nur mit neuer `formatVersion`).

| Feld | Typ | Regel / Bedeutung |
|---|---|---|
| `format` | String | genau `"malachi-update-manifest"` (bindet die Signatur an diesen Zweck) |
| `formatVersion` | Zahl | genau `1` |
| `applicationId` | String | muss der eigenen App-ID entsprechen (`com.securecommapp`); Demo-Builds (`.demo`) lehnen ab |
| `versionName` | String | `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`, nur zur Anzeige |
| `versionCode` | Zahl | ganze Zahl 1 … 2 100 000 000; die neueste veröffentlichte Version |
| `minSupportedVersionCode` | Zahl | ganze Zahl 1 … `versionCode`. Installierte Versionen **darunter** gelten als nicht mehr unterstützt (z. B. Sicherheitslücke, Protokolländerung) – die App soll dann deutlich zum Update auffordern. Was sie sonst tut, entscheidet die App. |
| `published` | String | UTC, genau `JJJJ-MM-TTThh:mm:ssZ` |
| `signingCertSha256` | String | SHA-256 des APK-Signaturzertifikats, 64 Hex-Zeichen klein (wie `apksigner verify --print-certs`) |
| `releaseNotesLang` | String | genau `"de"` |
| `releaseNotes` | String | Versionshinweise auf Deutsch, Klartext, höchstens 4000 Zeichen. Einziges erlaubtes Steuerzeichen ist LF. Leerzeile = neuer Absatz, Zeilen mit `- ` = Listenpunkte. **Als Text anzeigen, nie als HTML/Markdown mit Links interpretieren.** |
| `apks` | Array | 1–4 Einträge, jede ABI höchstens einmal |
| `apks[].abi` | String | `arm64-v8a`, `armeabi-v7a`, `x86_64` oder `x86` |
| `apks[].file` | String | nur Dateiname: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$` (kein `/`, kein `..`); liegt im selben Verzeichnis wie das Manifest |
| `apks[].size` | Zahl | Größe in Byte, 1 … 1 073 741 824 |
| `apks[].sha256` | String | SHA-256 der APK, 64 Hex-Zeichen klein |

**So schreibt der Signierer die Datei** (`lib/manifest.mjs`, `manifestBytes`): Felder in der Reihenfolge der Tabelle, `JSON.stringify(objekt, null, 2)` (2 Leerzeichen, LF), danach ein LF; Nicht-ASCII-Zeichen werden nicht maskiert. Für die Prüfung spielt das keine Rolle – die App prüft die empfangenen Bytes und serialisiert nie neu.

## 5. Prüfablauf in der App (verbindlich)

1. `manifest.json` laden; **abbrechen, wenn größer als 64 KiB**. `manifest.json.sig` laden (höchstens 1 KiB).
2. Signatur über die **unveränderten Bytes** prüfen (Abschnitt 3). Ungültig → verwerfen, nichts davon anzeigen.
3. Erst jetzt: UTF-8 streng dekodieren (ungültiges UTF-8 oder BOM → verwerfen), JSON parsen, alle Regeln aus Abschnitt 4 prüfen. `applicationId` muss passen.
4. **Rückfallschutz:** Die App speichert das höchste bisher gültige Paar (`versionCode`, `published`). Ein Manifest mit kleinerem `versionCode`, oder gleichem `versionCode` und älterem `published`, wird verworfen (alte, abgefangene Manifeste dürfen nichts zurückdrehen).
5. Update anbieten, wenn `versionCode` > installierter `versionCode`. Ist die installierte Version < `minSupportedVersionCode`: deutlicher Hinweis.
6. APK wählen: der erste Eintrag aus `Build.SUPPORTED_ABIS` (in dieser Reihenfolge), der in `apks` vorkommt. Keiner passt → kein Update anbieten.
7. APK laden von `<dieselbe Basisadresse>/updates/<file>`. Beim Laden höchstens `size` Byte annehmen; danach müssen Größe **und** SHA-256 exakt passen, sonst Datei löschen.
8. Empfohlen: Signaturzertifikat der geladenen APK (`PackageManager.getPackageArchiveInfo(…, GET_SIGNING_CERTIFICATES)`) mit `signingCertSha256` **und** mit dem der installierten App vergleichen, bevor der Installer startet.
9. Installation über den Android-Installer (`PackageInstaller`/`ACTION_VIEW`); der Nutzer bestätigt. Dafür braucht die App die Berechtigung `REQUEST_INSTALL_PACKAGES` (steht im App-Manifest – gehört nur in die Web-Version, nie in die Play-Version).
10. Abrufen am besten über Tor (Onion-Adresse); Clearnet nur als Rückfall. Die Sicherheit hängt nicht am Transport, die Privatsphäre schon (der Server sieht sonst, wer wann nach Updates fragt). Die App nutzt **ausschließlich** die Onion-Adresse – ohne Tor wird nichts abgerufen, es gibt keinen Clearnet-Rückfall.

Beispiel (App, JavaScript, `@noble/curves` 2.x wie im Repo):

```js
import { ed25519 } from '@noble/curves/ed25519.js';
import { UPDATE_PUBLIC_KEYS } from './AppConfig';

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export function verifyManifest(manifestBytes /* Uint8Array */, sigFileText /* string */) {
  if (manifestBytes.length > 65536) throw new Error('manifest too large');
  const core = sigFileText.replace(/\r?\n$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(core)) throw new Error('bad signature file');
  const sig = Uint8Array.from(atob(core), (c) => c.charCodeAt(0));
  const ok = UPDATE_PUBLIC_KEYS.some((k) => ed25519.verify(sig, manifestBytes, b64urlToBytes(k), { zip215: false }));
  if (!ok) throw new Error('bad signature');
  if (manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) throw new Error('BOM');
  const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  // ... danach alle Feldregeln aus Abschnitt 4 pruefen (siehe website/werkzeuge/lib/manifest.mjs, manifestPruefen)
  return m;
}
```

## 6. Testvektor

**Nur zum Testen – dieser Schlüssel ist öffentlich und darf nie produktiv verwendet werden.** Maschinenlesbar in `website/werkzeuge/test/update-testvektor.json`.

- Seed (privater Schlüssel, 32 Byte, hex) = SHA-256 von „malachi-update-testvektor-v1 NUR ZUM TESTEN“:
  `bab4131f8ad6f045b7097019e311be5f26496745a3eecb94bbd17056182a928e`
- Öffentlicher Schlüssel, Base64url: `1sAMs8rB7H5FDyDbuPYizHMcQW428dpMw5sP6tWvEso`
- Öffentlicher Schlüssel, hex: `d6c00cb3cac1ec7e450f20dbb8f622cc731c416e36f1da4cc39b0fead5af12ca`
- `manifest.json` (858 Byte, UTF-8, LF, endet mit LF; SHA-256 `40d388d7d8daefee65cc00fa2dc381f2706e1609d3698165dd8ca5e2b1a3d63f`):

```json
{
  "format": "malachi-update-manifest",
  "formatVersion": 1,
  "applicationId": "com.securecommapp",
  "versionName": "1.2.0",
  "versionCode": 12,
  "minSupportedVersionCode": 10,
  "published": "2026-10-19T12:00:00Z",
  "signingCertSha256": "e2eb4f8133258532523447772bd5c99565ca954db2c8ff7d7ccf49bb6cad533e",
  "releaseNotesLang": "de",
  "releaseNotes": "Testversion – nur für den Testvektor.\n- Umlaute bleiben UTF-8: äöüß\n- Zweiter Punkt",
  "apks": [
    {
      "abi": "arm64-v8a",
      "file": "malachi-1.2.0-arm64-v8a.apk",
      "size": 41234567,
      "sha256": "72f91b5d5a094eb865f89f159349f9ddf175c8c8a30d32ec62c23e7a63ed1c8b"
    },
    {
      "abi": "armeabi-v7a",
      "file": "malachi-1.2.0-armeabi-v7a.apk",
      "size": 39876543,
      "sha256": "28c0e27818b2c7fb8f88031780485ac1c415d81e585b8a6e39a8b1bf91c10c57"
    }
  ]
}
```

- `manifest.json.sig` (88 Zeichen + LF):
  `wM0miEDK3S74Lx+96h5i7O2+grdQDIrrtORVNDtWAup4rmwVn4h8iz3PthDI6QHUhyjCNB8cEr4hNgcXeKXuCA==`

Gegenproben, die jede Implementierung bestehen muss: dieselbe Datei mit CRLF statt LF, mit vorangestelltem BOM oder mit einem einzigen geänderten Byte ist **ungültig**.

## 7. Grenzen, Schlüsselverlust, Schlüsselwechsel

- **Zurückhalten („Freeze“):** Ein übernommener Server oder ein Angreifer im Netz kann ein älteres, gültig signiertes Manifest ausliefern und so ein neues Update verschweigen. Der Rückfallschutz (Abschnitt 5, Schritt 4) verhindert nur das Zurückdrehen hinter bereits Gesehenes. Gegenmittel: über Tor abrufen, Veröffentlichungsdatum anzeigen, bei Bedarf zusätzlich über die Clearnet-Adresse abgleichen. Ein Ablaufdatum gibt es bewusst nicht (der Schlüssel ist offline, regelmäßiges Neusignieren wäre unpraktisch).
- **Schlüssel verloren:** Es lassen sich keine neuen Manifeste mehr signieren. Updates sind dann nur noch manuell über die Download-Seite möglich, bis eine App-Version mit neuem Schlüssel verbreitet ist. Deshalb Schlüsseldatei und Passphrase getrennt sichern.
- **Schlüssel gestohlen:** Ein Angreifer kann gefälschte Manifeste signieren (Hinweise, Mindestversion, Hashes), aber keine APK mit dem echten APK-Schlüssel – Android lehnt eine fremd signierte APK als Update ab (Schritt 8 fängt es schon vorher ab). Trotzdem sofort wechseln: neues Schlüsselpaar, App-Update mit `UPDATE_PUBLIC_KEYS = [neu]`.
- **Planmäßiger Wechsel:** App-Version mit `[alt, neu]` veröffentlichen (noch mit dem alten Schlüssel signiert), danach mit dem neuen signieren; den alten Schlüssel nach einer Übergangszeit aus der App entfernen.

## 8. Werkzeuge

```bash
# einmalig, auf dem eigenen PC (Passphrase wird verdeckt abgefragt):
node website/werkzeuge/update-schluessel.mjs erzeugen        # -> ~/.malachi/update-signierschluessel.json
node website/werkzeuge/update-schluessel.mjs anzeigen        # oeffentlichen Schluessel erneut ausgeben

# ein Manifest pruefen (nimmt den Schluessel aus website/seite.json oder --schluessel):
node website/werkzeuge/update-schluessel.mjs pruefen --manifest website/build/seite/updates/manifest.json

# dasselbe mit OpenSSL 3 (Linux/Git Bash):
base64 -d manifest.json.sig > manifest.sig.bin
openssl pkeyutl -verify -pubin -inkey update-schluessel.pem -rawin -in manifest.json -sigfile manifest.sig.bin
```

Die Schlüsseldatei (`~/.malachi/update-signierschluessel.json`) ist JSON: der private Seed (32 Byte) verschlüsselt mit AES-256-GCM, Schlüssel aus der Passphrase per scrypt (N = 2^17, r = 8, p = 1), der öffentliche Schlüssel im Klartext daneben und als Zusatzdaten an das Chiffrat gebunden. Sie wird nie überschrieben.

## 9. Umsetzung in der App (Web-Version)

| Teil | Datei |
|---|---|
| Prüfung, Zustand, Zeitplan | `AppUpdater.js` |
| Oberfläche (Einstellungen „UPDATES“, Hinweis auf der Startseite, Dialog) | `UpdateUI.tsx` |
| Abruf über Tor, Download, APK-Prüfung, Installer | `android/app/src/main/java/com/securecommapp/update/MalachiUpdaterModule.kt` |
| Schlüssel, Onion-Adresse, Pfad | `AppConfig.js`: `UPDATE_PUBLIC_KEYS`, `UPDATE_ONION`, `UPDATE_PATH` |
| Tests | `__tests__/update/` (Testvektor aus Abschnitt 6, frisch erzeugte Testschlüssel, Zeitplan, Play-Variante) |

**Einrichten (Betreiber):** `node website/werkzeuge/update-schluessel.mjs erzeugen` auf dem eigenen PC, den ausgegebenen öffentlichen Schlüssel in `AppConfig.js` (`UPDATE_PUBLIC_KEYS = ['…']`) und `website/seite.json` (`updateSchluessel`) eintragen, App bauen, mit `veroeffentlichen` hochladen (`ANLEITUNG.md`, Abschnitte 8.4 und 9). Ist `UPDATE_PUBLIC_KEYS` leer, ist die Prüfung aus und die Einstellungen zeigen „Updates werden eingerichtet“.

**Was die App sendet:** Je Prüfung genau zwei Anfragen `GET /updates/manifest.json` und `GET /updates/manifest.json.sig` an `UPDATE_ONION` (Port 80), jede über eigene Tor-Kreise (zufällige SOCKS-Anmeldung), Kopfzeilen nur `Host` und `Connection: close` – kein User-Agent, keine App-Version, keine Geräte- oder Kontodaten, keine Cookies. Das native Modul lehnt alles ab, was keine v3-Onion-Adresse ist oder nicht direkt unter `/updates/` liegt; Weiterleitungen, `chunked` und Kompression werden nicht angenommen. Grenzen: Manifest 64 KiB, Signatur 1 KiB, APK = signierte Größe (höchstens 1 GiB), Antwortkopf 16 KB, 60 s ohne Daten = Abbruch.

**Zeitplan:** Schalter „Automatisch nach Updates suchen“ (Standard an). Höchstens eine Prüfung je 24 h plus Zufall (0–6 h); nur wenn Tor läuft, und erst 1–10 min (zufällig) nach „Tor verbunden“, damit der Abruf nicht mit dem App-Start verknüpfbar ist. Auch ein fehlgeschlagener Abruf zählt. „Jetzt prüfen“ fragt sofort. Die APK wird **nie** automatisch geladen – nur, wenn der Nutzer „Über Tor herunterladen (xx MB)“ antippt; in einem getakteten Netz (Mobilfunk) fragt die App vorher nach.

**Prüfungen in der App** (zusätzlich zu Abschnitt 5): Rückfallschutz über das höchste gesehene Paar (`versionCode`, `published`); angeboten wird nur `versionCode` > installierte; installierte < `minSupportedVersionCode` → „Dieses Update ist wichtig“. Nach dem Laden prüfen das native Modul **und** JavaScript Größe und SHA-256; danach liest die App aus der APK Paketname, `versionCode` und das Signaturzertifikat und vergleicht sie mit dem Manifest und der installierten App (Abweichung → Datei gelöscht, keine Installation). Unmittelbar vor dem Installer rechnet das native Modul SHA-256 noch einmal. Android selbst installiert ohnehin nur APKs mit demselben Signaturschlüssel – darauf verlässt sich die App aber nicht allein. Liefert ein Gerät beim Lesen der APK keine Zertifikate, bleibt Androids eigene Prüfung.

**Installation:** `ACTION_VIEW` mit einem FileProvider-`content://`-URI (befristete Leseberechtigung) auf die Datei im privaten Cache (`cache/malachi_update/`). Fehlt die Erlaubnis „Unbekannte Apps installieren“, erklärt die App das zuerst und öffnet dann die Systemeinstellung für genau diese App (`ACTION_MANAGE_UNKNOWN_APP_SOURCES`). Geladene Dateien werden bei Abbruch, bei einer Prüfabweichung und beim nächsten App-Start gelöscht.

**Gespeichert** (nur `EncryptedStorage`, Schlüssel `update_state_v1`): Schalter, Zeit der letzten/nächsten Prüfung, Rückfallschutz, das zuletzt gültige Manifest samt Signatur (wird beim Start erneut geprüft) und die ausgeblendete Version. Geloggt werden weder Adressen noch Pfade, Prüfsummen oder Versionshinweise.

**Play-Version:** Google Play verbietet Selbst-Updates. `AppUpdater.isUpdaterAvailable()` ist die einzige Stelle, die das entscheidet: `NativeModules.MalachiBuild.distribution === 'play'` (oder ein unbekannter Wert) → keine Prüfung, kein Download, keine Oberfläche; fehlt `MalachiBuild`, gilt „web“. Beim Play-Flavor gehören `REQUEST_INSTALL_PACKAGES` und `MalachiUpdaterPackage` nur in den Web-Flavor. Demo-Builds (`com.securecommapp.demo`) bekommen keine Updates (`applicationId` passt nicht).
