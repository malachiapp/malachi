# Production Readiness Gate — "100,000 users, this exact build"

Scope: this report answers one question only — **assuming this exact build
(branch `rn-upgrade-086`, current HEAD `a6091f1` + this session's fixes) is
already live for 100,000 real users, what breaks in production, at scale,
for real people?** It deliberately does *not* re-derive the ~20 existing
`SECURITY_*.md` protocol/crypto audits already in this repo — it asks "what
happens operationally" instead of "is the protocol sound." Two other agents
worked the codebase in parallel during this pass (an invariants catalog,
read-only, and a final red-team pass that may land its own fixes); this
report only covers findings and fixes made under this task.

**Grounding fact that shapes everything below:** this is *not* a
one-relay-per-user self-hosted deployment in practice — `RelayClient.js`
hardcodes `RELAY_URL = 'https://malachii.duckdns.org:3333'` as the shipped
default. Unless every one of the 100,000 users manually reconfigures this,
**all of them talk to one single Node.js process** holding everything in
`Map`s in RAM (relay.js's own header comment: *"Nur RAM, kein Disk"*). The
"100k users, one relay process" framing in this task's prompt is not
hypothetical here — it is this app's actual default topology.

---

## Part 1 — Production-scale findings

### 1. [FIXED — release-relevant] Relay restart falsely told web-client users "too many failed attempts, data deleted" — and left them permanently stuck

**Where:** `web/src/lib/Storage.ts` (`_unlockEncryptionInner`), `web/src/App.tsx` (`LockScreen` `onUnlock` handler).

**Reproduction (concrete, not theoretical):** `relay.js` keeps the PIN-hardening
"pepper" for every web-client device *only* in the in-memory `pepperStore`
Map (relay.js:106). Any restart of the single shared relay process — a
routine deploy (this session alone produced 5+ commits that would each need
one), a crash, an OOM kill, a host reboot — wipes that Map for **every**
web-client user simultaneously. The next time any of those users enters
their **correct** PIN, `pepperRequest(deviceId)` gets a 404 from the relay
(`relay.js:813`, "unbekannt") because the process genuinely no longer knows
the device. `RelayClient.ts` correctly labels this `reason: 'unknown'`
(distinct from `'network'`/`'locked'`) — but `Storage.ts` then collapsed
`'unknown'` into the exact same `reason: 'wiped'` used for a real
5-failed-attempts security wipe (`Storage.ts:209`, old code). `web/src/App.tsx`
displayed that as **"🔴 Zu viele Fehlversuche - Daten unwiderruflich
gelöscht."** ("Too many failed attempts") to a user who entered **zero**
wrong PINs. Confirmed by reading the full call chain end to end; this exact
mechanism (relay restart → pepper gone) was already independently proven by
`SECURITY_CHAOS_TESTING.md`'s "Server restart" scenario, but that prior
write-up scored it only as "a pure availability event, not a confidentiality
regression" — true for confidentiality, but it missed that the *client-side*
consequence is a false security-incident message plus, worse:

**Second, compounding bug found in the same path:** the old `'wiped'` return
never called `setHasExistingPin(false)`, so after `localStorage.clear()` the
`LockScreen` kept rendering with `hasPin={true}` (state only computed once,
on mount, `web/src/App.tsx:64`). Every subsequent PIN entry hit the *first*
guard in `_unlockEncryptionInner` (`!deviceId` → `'wrong_pin'`, since
`DEVICE_ID_KEY` was cleared too), producing an infinite, silent "Falscher
PIN" loop with **no UI path back to PIN setup** short of a manual page
reload. This affects the *real* wipe path too, not just the new one.

**Fix applied (narrow, safe):**
- `web/src/lib/Storage.ts`: new `UnlockResult` variant `reason: 'lost_state'`
  for the "server doesn't recognize this deviceId" case, kept fully distinct
  from the real `'wiped'` (which still requires an actual failed decrypt
  against a live `attemptToken`). `localStorage.clear()` still happens (the
  local ciphertext is equally unrecoverable either way — the pepper is
  random and never stored anywhere else — so there is no path to preserve
  it), but the user is now told the truth.
- `web/src/App.tsx`: new `case 'lost_state'` with an honest message ("server
  connection was reset, e.g. a restart — your locally stored data can
  unfortunately no longer be decrypted as a result; no wrong PIN, no
  unauthorized login — please set up PIN protection again"), and **both**
  the `'wiped'` and `'lost_state'` branches now call `setHasExistingPin(false)`
  so the app correctly falls back to PIN setup instead of an infinite
  wrong-PIN loop.
- Regression test: `__tests__/security/productionReadiness.pepperLostState.test.js`
  (3 tests) — proves `'lost_state'` is returned (not `'wiped'`) when the
  relay returns `'unknown'`, proves no attempt is consumed
  (`pepperFail`/`pepperSuccess` never called), proves `hasPinSetup()` becomes
  `false` afterward (no stuck loop), and keeps a control test confirming a
  *real* wipe still reports `'wiped'`.

**What this does NOT fix:** the underlying data loss itself. The pepper is
gone forever on every relay restart, for every currently-registered
web-client device, by design of "RAM only." That is a genuine architecture
gap — see Finding 2 for why it isn't narrowly fixable and what the honest
severity is.

**Native Android app: unaffected.** Grepped `App.tsx` (native root) for any
pepper reference — zero hits. The native app uses Android Keystore-backed
`EncryptedStorage` and never depends on the relay for its local encryption
key, confirmed by reading `Storage.ts`'s own header comment. This bug is
web-client-only.

### 2. [Flagged — architectural, follow-up needed, not fixed] Relay restart silently drops in-flight messages, reconnect offers, and push-token registrations for all users at once

**Where:** `relay.js` — `store` Map, `pushTokens` Map.

Beyond the pepper issue above, the same "RAM only, single process" design
means a relay restart at any moment loses, for **every** user who has
something in flight at that instant:
- Any `/packet` message queued for a recipient who hasn't polled yet (10-min
  TTL window) — silent, permanent message loss, with no error surfaced to
  sender or recipient.
- Any pending `/reconnect/offer` (33-day rendezvous window).
- Any pending `/phone/register` or `/phone/lookup` rendezvous state (5-min
  window; self-heals via UI timeout, low impact).
- All FCM push-token registrations (`pushTokens` Map) — until each affected
  device's app re-registers, push-wake silently degrades to
  polling/WebSocket-reconnect only (the WS wake path already has documented,
  tested auto-reconnect, so this mostly self-heals, but there's a gap
  between restart and each client's next registration).

This is the same mechanism `SECURITY_CHAOS_TESTING.md` §2 already
reproduced and judged "clients recover" — that conclusion is correct from
the *relay's* perspective (it comes back up cleanly, re-registration works)
but understates the *client* impact: anything genuinely in flight at that
exact moment is gone, not delayed.

**Why not fixed here:** the message store is intentionally RAM-only for a
real privacy reason (relay.js's own header: message content is "nie
dauerhaft gespeichert" — never durably stored, precisely so a compromised or
subpoenaed relay has nothing at rest to hand over). Adding disk persistence
for message content would be a **regression** against that explicit,
already-reviewed design choice, not a fix — and per this task's own
constraints ("no large migrations/rewrites"), a proper fix (e.g., a
durable-but-still-ephemeral store, or a zero-downtime reload strategy) is a
real design project, not a narrow patch. **Recommendation:** restart the
relay only during low-traffic windows, and treat any planned relay restart
as a deploy that should drain (stop accepting new work, let in-flight polls
complete) before the process exits, where operationally feasible. Flagged
as a dedicated follow-up item, not attempted here.

### 3. [Verified safe — no fix needed] New optional fields need no client storage migration for users upgrading in place

Checked whether this session's `device_wiped` system-message subtype and the
`wiped` contact-list flag need any versioned local-storage migration for a
user updating from an older installed build (not a fresh install). They do
not:
- `updateContacts()` (`App.tsx:65-77`) reads via plain `JSON.parse` with no
  schema/shape validation that would reject an older stored contact record
  missing the new `wiped` field.
- Every read site treats `wiped` as optional/falsy-by-default:
  `item.wiped ? … : …` throughout `App.tsx` (native, lines 1507-1518, 2816)
  and `web/src/App.tsx` (lines 581-582, 936-937). An old record with no
  `wiped` key behaves exactly like `wiped: false` — correct behavior, no
  action needed.
- `device_wiped` is a new *message subtype string*, not a stored-schema
  field — nothing to migrate.

No code change made here; this is a confirmed non-finding, included because
the task explicitly asked whether a migration was needed.

### 4. [Verified safe — no fix needed] `PACKET_ACK_GRACE_MS` protocol change is safe across a staged Play Store rollout

During a staged rollout, some fraction of the 100k installs will run an app
version older than this session's `/packet/ack` protocol change while
already hitting the (immediately, fully upgraded) shared relay. An
old-version client never sends `POST /packet/ack`, so under the new relay
behavior a pending packet keeps re-appearing on every poll until
`PACKET_ACK_GRACE_MS` (20s default) lapses, repeatedly, until the 10-minute
hard TTL. This *could* mean visible duplicate messages for old-version users
mid-rollout — except the client already dedups relay-fallback messages by
`msgId` (`App.tsx:1780-1796`, confirmed present and unconditional), so the
practical effect is only mildly redundant polling traffic, not user-visible
duplicates. No fix needed. **Operational note:** deploy `relay.js` at the
same time as, or before, the app version that depends on it — never after —
since it's a single centrally-operated process, not something individual
installs carry with them.

### 5. [Informational — follow-up needed] No global rate limit on well-formed requests

`relay.js`'s only abuse defenses (`checkIP`/`registerFail`/`blockedIPs`)
trigger on **malformed or invalid** requests. A well-formed flood — e.g.
`POST /pepper/register` with a stream of random ≥16-character `deviceId`
values, which is entirely valid input — is never rate-limited and grows
`pepperStore` (which also has no TTL/eviction of its own, unlike the main
`store`) without bound. The existing 2MB body-size cap and periodic TTL
sweep address different problems (single giant request; entries that expire
on their own) and don't cover this. At genuine internet-facing 100k-user
scale this is a realistic memory-growth/DoS vector, distinct from what
prior fuzzing/chaos passes already fixed. **Not fixed here** — a global
per-IP request-rate limiter is a real architectural addition (needs load
testing to tune thresholds without throttling legitimate heavy pollers with
many contacts) and falls outside "narrow, safe fix" for this pass. Flagged
for dedicated follow-up.

### 6. [Verified — no new finding] Account takeover

Reviewed the native `LockScreen`/biometric flow (`App.tsx:1127+`) and the
relay pepper flow for any path where possessing something short of the
PIN/biometric/device grants access. No debug/dev bypass flag, no
skip-lock shortcut found (`grep` for `__DEV__`, `SKIP_PIN`, `bypassLock`,
etc. — zero hits in `App.tsx`). The native path's encryption key is
Android-Keystore-bound and never touches the relay, so it's entirely
unaffected by every relay-restart finding above. No new account-takeover
path found beyond what `SECURITY_REVIEW_1_REDTEAM.md` /
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` already cover.

### 7. Catastrophic sync (permanently diverged device state)

Already covered in depth by this repo's own `SECURITY_CHAOS_TESTING.md`
Scenario 9 (app-kill mid-Kyber-handshake → genuinely divergent post-restart
secrets, flagged there as unfixed pending a dedicated persistence design).
Nothing new found in this pass beyond what that scenario already documents;
not re-litigated here to avoid duplicating that existing, more detailed
analysis.

---

## Part 2 — Google Play policy / release-readiness checklist

Grounded in this repo's actual files, checked against Play's requirements as
they'd apply to a 2026 submission.

| Item | Status | Detail |
|---|---|---|
| `targetSdkVersion`/`compileSdkVersion` | **PASS** | Both `36` (`android/build.gradle:4-6`), ahead of Play's current minimum (35 as of late 2025); safe for a 2026 submission. |
| `android:allowBackup` | **PASS** | `false` (`AndroidManifest.xml`) — correctly prevents Android Auto Backup from ever exfiltrating locally-encrypted chat data via cloud backup, consistent with the app's own E2EE claims. |
| Declared permissions actually used | **FIXED** | `FOREGROUND_SERVICE_MICROPHONE` and `FOREGROUND_SERVICE_PHONE_CALL` were declared but never referenced anywhere in native code — the only `startForeground()` call (`MalachiService.kt:36`) uses the already-correctly-declared `dataSync` type, and the calling `ConnectionService` (`MalachiConnectionService.kt`) is self-managed and never starts its own foreground service (Telecom handles call UI). Removed both unused declarations from `AndroidManifest.xml`. Play's review flags unused "special use" foreground-service permissions and requires justification in the Play Console declaration form that wouldn't exist for genuinely-unused ones. All other permissions verified in use: `CAMERA`/`RECORD_AUDIO` (calls, voice messages, photo capture), `MANAGE_OWN_CALLS`/Telecom (`TelecomHelper.kt`), `USE_FULL_SCREEN_INTENT` (`CallWakeHelper.kt`, `CallNotificationHelper.kt`), `POST_NOTIFICATIONS`, `READ_MEDIA_IMAGES`/`WRITE_EXTERNAL_STORAGE` (maxSdk 29, legacy-compat, correctly scoped), biometric, `FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_DATA_SYNC` (`MalachiService`). |
| Privacy Policy | **FAIL — release-blocking** | No privacy policy file or draft exists anywhere in the repo (`grep -ri "privacy policy\|Datenschutz"` across the whole tree: zero hits), and the app links to none in its UI. An E2EE messenger requesting `CAMERA`, `RECORD_AUDIO`, `POST_NOTIFICATIONS`, and performing phone-number-hash contact matching **requires** a Play Console Privacy Policy URL — Play Console will not let this app publish without one. This is a legal/business document (needs a real company name, jurisdiction, contact address) that shouldn't be fabricated here; flagged as a concrete blocking action item for the app owner, not something to code around. |
| Data Safety form — likely required disclosures | **NEEDS ACTION** | Grounded in `SECURITY_ARCHITECTURE_THREAT_MODEL.md`'s own knowledge-minimization findings (not over- or under-claiming): disclose (1) phone number — collected, hashed before transmission, used for contact discovery/matching, not stored in plaintext by the relay; (2) photos/camera and voice audio — processed on-device, transmitted end-to-end encrypted, not accessible in plaintext to the developer/relay operator; (3) device/IP address — inevitably visible to the relay operator as connection metadata (per `relay.js`'s own header comment and `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §1.7), even though message *content* is not persisted or readable. Declaring content as "encrypted in transit" and network metadata as collected-but-not-shared is the accurate, defensible answer this codebase supports — declaring "no data collected" would be an overclaim Play could later contest. |
| App icon | **PASS** | Present for every density bucket (`mdpi` through `xxxhdpi`) plus the adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml` + round variant). |
| Release signing | **NEEDS ACTION (process, not code)** | `android/app/build.gradle` correctly sources release signing from `keystore.properties` (gitignored, not in the repo) and *intentionally* falls back to debug-signing only if that file is absent, so a missing file can't hard-break the build. The risk this creates: if `keystore.properties` happens to be absent on the actual release-build machine at build time, Gradle will **silently** produce a debug-signed release APK that looks fine locally but can never be published as an update to an existing Play listing. Not a code defect — flagged as a release-checklist item: confirm `keystore.properties` is present and correct immediately before running any real release build (not verified here — this task did not run `./gradlew assembleRelease`, per its own constraints). |

---

## What was fixed vs. flagged

**Fixed, with regression tests, in this pass:**
1. Relay-restart-vs-real-wipe misattribution + stuck-lock-screen dead end
   (`web/src/lib/Storage.ts`, `web/src/App.tsx`) — new
   `__tests__/security/productionReadiness.pepperLostState.test.js` (3 tests, all passing).
2. Two unused, Play-policy-risky permissions removed (`AndroidManifest.xml`).

**Release-blocking (needs owner action before Play submission), not code fixes:**
- Missing Privacy Policy (Part 2).
- Data Safety form disclosures need to be filled in per the grounded list above.
- Confirm `keystore.properties` is genuinely present before the real release build.

**Follow-up needed (flagged, not attempted — each is a real design task, not a narrow patch):**
- Relay-restart message/reconnect-offer/push-token loss (Finding 2) — needs
  a deliberate durability-vs-privacy design, not a quick patch.
- No global per-IP rate limit on well-formed requests (Finding 5) — needs
  load-testing-informed threshold tuning.

**Verified safe, no action needed:**
- Contact-schema/`wiped`-field forward compatibility across an in-place app update (Finding 3).
- `PACKET_ACK_GRACE_MS` rollout compatibility, thanks to existing client-side dedup (Finding 4).
- Account-takeover surface — no new path found (Finding 6).

---

## Verification results

- `npx jest` (full suite, run twice to rule out flakes/other-agent races):
  **326/327 passing.** The one failure both times was
  `relay.js - Body-Groessenlimit … ECONNRESET`, the pre-existing, explicitly
  pre-approved flake under parallel load (confirmed identical failure
  signature to the one named in this task's own instructions). All 3 new
  regression tests pass. No test I touched or that covers files I touched
  regressed.
  - Note: mid-session, a concurrent agent's file edits and this session's
    own `Edit` tool calls left `web/src/App.tsx` with its line endings
    flipped from LF to CRLF (Windows `core.autocrlf` artifact — confirmed
    via byte-level diff against `HEAD`), which broke an unrelated,
    line-ending-sensitive red-team test (`stateMachine.pollCycleGuard.test.js`)
    for one run. Normalized the file back to LF (content-only diff, no
    logic change) before the final verification run; not a real code defect.
- `cd web && npx tsc --noEmit`: **clean, zero errors.**

## GO / NO-GO recommendation

**NO-GO as-is for a Play Store submission — but not for code-quality
reasons.** The code-level findings from this pass are fixed or narrowly
scoped/flagged; the two remaining blockers are process/business items, not
bugs:
1. **No Privacy Policy exists or is linked in-app** — Play will not accept
   this submission without one. This alone blocks submission regardless of
   code quality.
2. **Data Safety form is not yet filled in** — needs the disclosures listed
   above before submission.

Once those two are done, this build's remaining known risks are already
honestly characterized, not hidden: the relay's "RAM-only, single process"
design (an explicit, previously-reviewed privacy trade-off, not new) means a
relay restart during the live 100k-user window will lose some in-flight
messages and force web-client PIN users to re-set-up their PIN — the latter
now at least reports itself honestly and recovers instead of leaving users
stuck. Neither is a silent data-integrity or confidentiality break; both are
availability/durability trade-offs the team has now knowingly accepted with
correct user-facing behavior. The unused-permission and account-takeover
checks came back clean. Recommend scheduling the two follow-up items
(Findings 2 and 5) as dedicated work before the next scale milestone beyond
100k, not as blockers for this release.
