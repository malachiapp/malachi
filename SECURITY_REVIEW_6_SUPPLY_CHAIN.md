# SecureCommApp ("Malachi") — Supply-Chain Security Review #6

Scope: dependencies, install/build scripts, and distribution mechanism for the RN app (repo root), the web client (`web/`), and the relay (`relay.js`) — **not** the crypto protocol or server trust model, which are covered by Reviews 1–5. Read-only review: no `npm audit fix`, no dependency changes, no other files modified.

---

## SUPPLY-CHAIN ISSUES FOUND (ranked by severity/practicality)

### S-1. (Low/Moderate) `firebase-admin` pulls ~2 of the 9 known-vulnerable transitive packages, and its install-time footprint is entirely unused by the deployed relay

`firebase-admin@14.4.0` is a direct root `dependency` (not devDependency), used only by `pushSender.js`. Tracing `npm ls uuid` / `npm ls gaxios` confirms both flagged CVEs come from its tree:

```
firebase-admin@14.4.0
 └─ @google-cloud/storage@8.2.0 → gaxios@6.7.1 → uuid@9.0.1   (GHSA-w5hq-g745-h8pq, uuid buffer bounds check, CVSS 7.5)
 └─ @google-cloud/firestore@9.2.0 → google-gax → google-auth-library → gaxios@7.3.1 / gtoken
```

`relay.js` (lines ~106–111) only `require('./pushSender')` inside a `try/catch`, and `pushSender.js` itself throws immediately if `FCM_SERVICE_ACCOUNT_PATH` isn't set — and per `relay.js`'s own comment (~line 795), **the deploy script copies only `relay.js` to the production server, with no `npm install` step**, so `firebase-admin` and its ~600-plus-package tree never actually reach the deployed relay today. It only exists in the dev-machine/CI `node_modules` tree.

Per the push-notification architecture plan (`sprightly-bouncing-milner-push-notifications.md`), this is already known and named: FCM is described as "totes Wissen" (dead code) — `CallBridgeModule.getFcmToken()` and `RelayClient.js`'s `registerPushToken()` are never invoked by any live code path, no device registers a token today. The plan's Phase 6 explicitly schedules removing `pushSender.js`, `firebase-admin`, and related FCM plumbing, but deliberately *after* the new WebSocket wake mechanism (Phases 1–5) proves itself, so the old path survives as a rollback anchor in the meantime.

**Practical impact:** low as a live threat (not deployed), but it materially inflates the installed dependency graph (660 prod + 321 dev + 97 optional = 1077 total packages) that every developer's `npm install` and every CI run pulls down, and is the direct source of 2 of the 9 `npm audit` moderate findings. See REQUIRES HUMAN DECISION below — this review does not re-litigate the FCM removal timeline, only flags that the dependency-surface argument supports it.

### S-2. `npm audit` at root: 9 moderate, 0 high/critical — all in devDependency toolchain or the (unused) firebase-admin tree

Full breakdown (via `npm audit --json`, `auditReportVersion 2`):

| Package | Severity | Path | Fix |
|---|---|---|---|
| `fast-xml-parser` <5.7.0 | moderate (CVSS 6.1) — XML Comment/CDATA injection, GHSA-gh4j-gqv2-49f6 | via `@react-native-community/cli-config-android` / `cli-platform-apple` (devDependency toolchain) | `@react-native-community/cli` → 20.2.0 (non-major bump per npm) |
| `@react-native-community/cli`, `cli-doctor`, `cli-config-android`, `cli-platform-android`, `cli-platform-apple`, `cli-platform-ios` (6 entries) | moderate | all transitively via the `fast-xml-parser` issue above | same fix, `@react-native-community/cli` 20.1.0 → 20.2.0, `isSemVerMajor: false` |
| `uuid` <11.1.1 | moderate (CVSS 7.5) — missing buffer bounds check, GHSA-w5hq-g745-h8pq | via `firebase-admin` → `@google-cloud/storage` → `gaxios` | `fixAvailable: true` (transitive bump, no major) |
| `gaxios` 6.4.0–6.7.1 | moderate | via `firebase-admin` → `@google-cloud/storage`, pulling vulnerable `uuid` | `fixAvailable: true` |

None of these touch the app's own crypto/messaging/relay code paths — they're all in the RN CLI build toolchain (dev-only, never ships in the app or relay) or in the already-unused `firebase-admin` push path. **No high or critical findings, no direct hits on `@noble/*`, `react-native-webrtc`, `react-native-encrypted-storage`, `react-native-biometrics`, or `ws`.**

### S-3. `web/` npm audit: clean — 0 vulnerabilities

`web/` has its own `package.json`/`package-lock.json`/`node_modules` (40 prod, 68 dev, 46 optional = 107 total). `npm audit --json` there returns an empty `vulnerabilities` object. Nothing to fix.

### S-4. `google-services.json` committed to git (already flagged in Review 1, reconfirmed here from the supply-chain angle)

`android/app/google-services.json` is tracked (`git ls-files`), containing a Firebase Android API key (`AIzaSyBNO_DyzWk3hApbUO8wApW7QlHdINN6mNA`, added in commit `3dbb629`). This is the same finding as Review 1's L-2 — restated here because it's a supply-chain-relevant provenance detail (anyone with repo access, including a future public fork, gets the Firebase project identifier). Not a newly discovered issue; no new action beyond what Review 1 already recommended (verify Firebase Console API-key restrictions).

---

## ALREADY MITIGATED / ACCEPTABLE (checked and found fine)

- **Postinstall scripts are benign.** Both flagged by `npm warn allow-scripts`:
  - `@firebase/util@1.15.3`'s `postinstall.js` only acts on the `FIREBASE_WEBAPP_CONFIG` env var (unset in this project); with it unset, the script writes two tiny generated files (`dist/postinstall.js`/`.mjs`) **inside its own package directory** and exits — no network call, no writes outside its own package. Even when the env var *is* set, the only network call is to `firebase.googleapis.com`'s official webConfig endpoint using the caller-supplied `apiKey`, not attacker-controlled.
  - `protobufjs@7.6.6`'s `scripts/postinstall.js` (used by `firebase-admin`'s tree) just compares `versionScheme` between the package and its parent's `package.json` and prints a `stderr` warning on mismatch — no filesystem writes, no network access at all.
- **`patch-package` is pinned** to `^8.0.1` in `devDependencies` (acceptable — caret range on a mature, widely-used tool; not pinned to an exact version, see Recommended Fixes).
- **The audio-toolkit patch matches its stated purpose exactly.** `patches/@react-native-community+audio-toolkit+2.0.3.patch` was diffed directly: it (1) removes the old `buildscript{ repositories{ jcenter() } ... classpath 'com.android.tools.build:gradle:3.2.1' }` block, (2) adds `namespace 'com.reactnativecommunity.rctaudiotoolkit'` and bumps `minSdkVersion` 19→24, (3) removes `jcenter()` from the module's own `repositories{}`, and (4) drops the now-conflicting `package=` attribute from `AndroidManifest.xml` (required once `namespace` is set in Gradle, to avoid AGP's "namespace already specified" build error). This is exactly the "fix jcenter()/old AGP references" purpose described — no unrelated code changes, no injected logic, no new permissions.
- **Lockfiles exist and are committed.** `package-lock.json` (root) and `web/package-lock.json` are both tracked in git (confirmed via `git ls-files`), neither is gitignored. Root `.gitignore` and `web/.gitignore` were both read in full — neither excludes lockfiles. Reproducible installs are intact for supply-chain analysis purposes.
- **Secrets hygiene is being followed today.** `secrets.local.js` (real) is gitignored and **not** tracked; only `secrets.local.js.example` (the template) is tracked. `firebase-service-account.json` is gitignored and not tracked. `android/keystore.properties` is gitignored and not tracked. `.gitignore` explicitly documents this ("Secrets - nie committen"). `ecosystem.config.js`'s own in-code comment references "die alte Version war eine getrackte Git-Datei" (an old tracked version had the secret in plaintext) as the reason for the current `secrets.local.js` indirection — **this repo's reachable git history was searched (`git log --follow -p`, plus `git log --all -G` for `TURN_SECRET`, `BEGIN PRIVATE KEY`, `AIza...`, generic `secret=`/`password=`/`api_key=` patterns) and no literal TURN_SECRET or other high-value secret value was found ever committed** — the earliest tracked version of `ecosystem.config.js` (commit `3dbb629`) already has no `TURN_SECRET` field at all; it was added later (`978107d`) already routed through the gitignored `secrets.local.js`. The comment appears to describe a lesson learned outside this repo's current commit graph (or an amended/never-pushed local state) rather than a live leak in this history. (Caveat: `git log --all` only covers reachable refs; this cannot rule out force-rewritten/dangling objects still physically present in `.git` but unreferenced — a `git gc --prune=now` audit would close that residual gap if ever warranted, but that's beyond a read-only review's scope.)
- **`android/app/build.gradle` and `keystore.properties` have no hardcoded release-signing secrets.** `keystoreProperties['storePassword']`/`keyAlias`/`keyPassword` are all read from the gitignored `keystore.properties` file at build time (lines ~36–68); only the well-known, non-sensitive default debug-keystore password (`'android'`, standard RN/Android tooling default) is hardcoded, which is expected and non-sensitive (also already noted in Review 1 L-2/second-pass).
- **No unusual Maven repositories.** `android/build.gradle`'s top-level `repositories{}` block (both `buildscript` and general) lists only `google()` and `mavenCentral()`. `android/app/build.gradle` and `android/settings.gradle` define no additional `repositories{}` blocks of their own (they inherit from root, standard for modern AGP + RN autolinking). No third-party/unofficial Maven mirrors anywhere in the Android build config.
- **No custom npm registry or override configuration.** No `.npmrc` in repo root or `web/` (confirmed via `find`), `npm config get registry` resolves to the standard `https://registry.npmjs.org/`, and neither `package.json` defines `resolutions`/`overrides`/`packageManager` fields that could silently redirect a dependency to an unexpected source.
- **Dependency provenance spot-check — all clean, no typosquatting detected:**
  - `@noble/ciphers`, `@noble/hashes` (root + web), `@noble/post-quantum` (web) — all three confirm `maintainers: paulmillr <paul@paulmillr.com>` and `repository.url` pointing to the legitimate `github.com/paulmillr/noble-*` repos via `npm view`. These are the real, well-audited libraries this project's PQ/AEAD crypto depends on.
  - `react-native-webrtc` — `repository.url` is `github.com/react-native-webrtc/react-native-webrtc` (the canonical org), package first published 2015, long-established maintainer set. Legitimate.
  - `react-native-biometrics` — points to `github.com/SelfLender/react-native-biometrics`, the known/expected maintainer org. Legitimate.
  - `react-native-encrypted-storage` — points to `github.com/emeraldsanto/react-native-encrypted-storage`, matches the well-known single-maintainer package. Legitimate.
  - No package name in either `package.json` shows obvious lookalike/typosquat spelling (no `noble-ciphers` without scope, no `react-native-webrtcc`, etc.) — all match their expected canonical names.

---

## RECOMMENDED FIXES (non-breaking, safe to apply without separate careful testing)

Status as of the follow-up fix pass: items 2-4 done; item 1 partially done (see
below - the remaining 2 findings turned out not to be a quick `npm audit fix` after
all, and are left alone rather than forced).

1. ~~Run `npm audit fix` at root for the `uuid`/`gaxios` pair.~~ **Attempted, did not
   resolve as expected.** `npm audit fix` (run twice, before and after item 2) made
   no change to `package-lock.json` for this pair despite `fixAvailable: true` —
   `uuid`/`gaxios` are nested deep inside `firebase-admin`'s own dependency tree
   (`@google-cloud/storage` → `gaxios` → `uuid`), and npm's non-forcing resolver
   won't bump them without also touching `@google-cloud/storage`'s pinned range,
   which it treats as too risky to do automatically. Forcing it
   (`npm audit fix --force`) would mean an unreviewed version bump inside the
   already-confirmed-dead `firebase-admin` tree — the same category of decision as
   REQUIRES HUMAN DECISION #1 below, so left alone rather than forced through
   as part of this pass. Audit count: 9 → 2 moderate (both `uuid`/`gaxios`, both
   inside `firebase-admin`'s tree only).
2. ~~Bump `@react-native-community/cli` family from 20.1.0 → 20.2.0.~~ **Done** —
   resolved 7 of the 9 original findings (the `fast-xml-parser`-via-CLI cluster).
   Verified afterward: `npx react-native --version` → `20.2.0`, and
   `./gradlew assembleDebug` still succeeds.
3. ~~Pin `patch-package` to an exact version.~~ **Done** — `"patch-package": "8.0.1"`.
   Verified the patch still applies cleanly on a fresh `npm install`
   (`@react-native-community/audio-toolkit@2.0.3 ✔`).
4. **`web/` needs no action** — audit is already clean. Unchanged.

## REQUIRES HUMAN DECISION

1. **Whether to remove `firebase-admin` (and `pushSender.js`) now vs. waiting for the planned FCM removal (Phase 6 of the push-notification plan).** This review's findings (S-1: 2 of 9 audit vulnerabilities trace to it; it is confirmed dead code not reachable by the deployed relay; the plan already names it for removal) support doing it sooner rather than later from a pure dependency-hygiene standpoint. However, the plan owner deliberately sequenced this *after* Phases 1–5 (the new WebSocket wake mechanism) prove themselves in real use, keeping the old FCM path as a rollback anchor. That is a legitimate engineering trade-off (reliability/rollback safety vs. dependency-surface minimization) that only the project owner should decide — this review does not recommend overriding the existing plan's sequencing, just confirms the supply-chain angle adds weight to *not* delaying it indefinitely once Phase 5 is validated.
2. **Whether to eventually adopt npm's `allowScripts` (via `@lavamoat/allow-scripts` or similar) to explicitly allowlist install scripts** rather than relying on ad-hoc `npm warn` visibility. Both currently-flagged scripts (`@firebase/util`, `protobufjs`) were manually verified benign in this review, but that verification doesn't automatically re-run on every dependency bump — formalizing an allowlist is a process/tooling change with its own maintenance cost, worth a deliberate decision rather than a silent default.
3. **Any future major-version bumps** (e.g., if `npm audit` later surfaces a fix requiring `isSemVerMajor: true`) should go through normal testing, not be applied as part of a routine audit-fix pass — none are currently required, but noting this as a standing policy point since the review explicitly excludes doing so itself.

---

## SECURITY ASSUMPTIONS

- This review assumes the crypto protocol and server/relay trust model are out of scope, per Reviews 1–5 — a compromised relay operator or a broken Kyber exchange is not re-analyzed here.
- `npm audit` and `npm view` results reflect the npm registry's advisory database and package metadata **as observed on 2026-09-19**; both can change (new CVEs disclosed, packages unpublished/taken over) after this review, so this is a point-in-time snapshot, not a standing guarantee.
- Git history analysis for committed secrets covers all **reachable** refs (`git log --all`) at the time of this review; it does not cover unreferenced/dangling objects that might still physically exist in `.git` if history was ever rewritten (e.g., via `filter-branch`/`BFG`) without a subsequent `git gc --prune=now`. No evidence of such rewriting was found, but this is a structural limitation of any `git log`-based secret scan, not a specific finding.
- The postinstall-script and patch-file review is a manual, one-time read of the *currently installed* versions (`@firebase/util@1.15.3`, `protobufjs@7.6.6`, `patch-package@8.0.1`'s applied patch). It does not constitute an automated, continuously-enforced guarantee that future dependency updates won't introduce a malicious postinstall script — that would require tooling (see Requires Human Decision #2), not a one-off review.
- The Android Gradle repository check covers `android/build.gradle`, `android/app/build.gradle`, and `android/settings.gradle` as they exist today; it does not exhaustively verify every transitively-resolved native Maven artifact's own POM for further nested repository declarations (out of scope for a "best-effort" pass per the task brief).
