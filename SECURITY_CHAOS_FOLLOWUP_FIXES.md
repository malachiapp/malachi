# Chaos-Testing Follow-up Fixes — SecureCommApp ("Malachi")

**Scope:** the 4 findings `SECURITY_CHAOS_TESTING.md`'s "Prioritized findings"
section left deliberately unfixed (items 3, 4, 5, 7/8 in that list — here
numbered Fix 1–4 per the task brief). All 4 are sequencing/validation/
state-machine fixes, no new cryptography, per the standing "keine
eigenentwickelte Kryptografie" constraint.

**Note on concurrent editing:** this repo had another session actively
modifying `RTCStore.js`/`.ts`, `MessageCrypto.js`, `AudioCrypto.js`,
`ImageCrypto.js`, `package.json` and adding `fuzz.messageCrypto.test.js`,
`fuzz.keyMaterial.test.js`, `stateMachine.rtcStoreWipeLifecycle.test.js`,
`SECURITY_SECRETS_LIFECYCLE.md` **while this pass was running** (confirmed via
repeated `git status`/`npx jest` runs showing different transient failures in
those unrelated files between consecutive runs, and via `git diff` showing
those files changed despite this pass never touching them). None of the 4
fixes below touch those files. Two full-suite runs during this pass showed a
transient failure in that concurrent work's own new fuzz tests
(`fuzz.messageCrypto.test.js`, then later `fuzz.keyMaterial.test.js` on a
different run) — both cleared on subsequent runs once that other session's
work settled, and neither touches any file this pass modified. Not
investigated or fixed here; out of scope and actively owned by another
session.

---

## Fix 1 — `/phone/register`/`/phone/lookup` contradictory-initiator bug

**File:** `relay.js`. Both handlers unconditionally set `role:'initiator'` and
overwrote `entry.initiatorId` for every caller that found an existing hash
entry, with no check for "already claimed."

**Fix:** both handlers now only accept a NEW initiator claim if
`entry.initiatorId` is still `null`, **or** the caller is retrying with the
*same* `chatId` (idempotent retry after a lost response — the relay can't
otherwise distinguish "my own retry" from "a different device"). Any other
`chatId` arriving after the slot is claimed gets `{ ok:false,
role:'already_claimed' }` (register) / `{ found:true, ok:false,
role:'already_claimed' }` (lookup) instead of a false `initiator` — and
`initiatorId` is left untouched.

**Client wiring:** only native `App.tsx`'s `startPhoneConnect()` calls
`/phone/register` (grepped both App.tsx files for `/phone/register`,
`/phone/lookup`, `phone_connect` — `/phone/lookup` and the web client's phone
flow have no call sites at all, so no other consumer exists). Added a new
`phoneStatus === 'claimed'` branch with the user-facing message "Dieser
Kontakt-Code wurde bereits von einem anderen Gerät verwendet" instead of
silently falling into the "wait as responder" branch.

**Tests:** extended `chaos.duplicateMessages.test.js` — renamed the two tests
that previously *documented* the bug into tests that *prove the fix*, plus
three new ones: idempotent same-chatId retry still succeeds; three truly
concurrent (`Promise.all`) `/phone/register` calls for one hash yield exactly
one winner and two honest `already_claimed` losers with `initiatorId`
uncorrupted; same concurrency proof for `/phone/lookup`; a same-chatId lookup
retry still succeeds. All real relay.js child-process harness tests (no
mocks).

---

## Fix 2 — App-kill mid-Kyber-handshake key-state divergence

**Files:** `WebRTCManager.js` (native), `web/src/lib/WebRTCManager.ts` (web),
both Kyber handlers (responder `kyber_pubkey`, initiator `kyber_ciphertext`).
Persistence of `sharedSecret` was fire-and-forget (`.then()`/`.catch(()=>{})`)
before `_flushPending()`/cover-traffic/`_onKeyExchange()` ran, so a process
kill in that window left the app believing the pairing was durable when it
wasn't.

**Fix:** the persistence write is now `await`ed **before** `_flushPending()`,
in all 4 handlers. A write failure is still non-fatal (logged via
`console.warn`, not rethrown) — the goal is "can't be outrun by a kill,"
not "persistence failure kills the handshake."

**Judgment call:** the native handler originally used a *dynamic*
`import('react-native-encrypted-storage')` inside the handler. Awaiting a real
dynamic `import()` throws under this project's Jest config
(`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` — confirmed with a minimal
isolated repro, not specific to this code) since Jest's CJS test runner has no
registered dynamic-import callback. Rather than leave the fix genuinely
untestable, I converted that one call site to a **static top-level import**
(`import EncryptedStorage from 'react-native-encrypted-storage'`) — this is
already the established pattern elsewhere in the codebase (`App.tsx:17` does
exactly this), works identically under Metro in production, and removes a
pointless lazy-load for a tiny always-needed native module. Not a scope
expansion of the crypto/protocol logic, purely an import-mechanism fix needed
to make the sequencing fix testable. Web side already used a static import
(`setItem` from `./Storage`), unaffected.

**Tests:** extended `chaos.keyStateRace.test.js` with 4 new tests (native +
web): (1) delay the persistence write behind a gate and prove `_flushPending`
has *not* run while the write is pending, then prove it runs once released;
(2) prove a persistence failure doesn't abort the handshake (`keyExchangeDone`
still true, secret still set, failure logged). Existing duplicate-kyber and
send-status tests were checked — they don't set `chatId`, so the persistence
branch is skipped and they were unaffected.

---

## Fix 3 — Web `Storage.ts`: corrupted local data crashes unlock and burns an attempt

**File:** `web/src/lib/Storage.ts`, `_unlockEncryptionInner()`.

Two related bugs: (a) a corrupted `SALT_KEY` (invalid base64) let
`fromB64()`/`atob()` throw uncaught instead of returning a structured
`UnlockResult`; (b) any local corruption (SALT_KEY or MARKER_KEY) still called
`pepperRequest()`, issuing a real 30s `attemptToken` that counts as an
**implicit failed attempt** if left unresolved (relay.js's own by-design
anti-abuse rule) — so merely skipping `pepperFail()` doesn't avoid burning an
attempt; the check has to happen **before** `pepperRequest()` is ever called.

**Fix:** a cheap local well-formedness pre-check on both `SALT_KEY` and
`MARKER_KEY` (valid base64, minimum plausible AES-GCM length: IV 12 + tag 16
bytes) runs before `pepperRequest()`. On failure, returns `{ok:false,
reason:'corrupted'}` immediately — no token ever issued, so nothing to burn.
Added `'corrupted'` to the `UnlockResult` type. The real `fromB64(saltB64)`
call at the `deriveKey()` site is also now wrapped in try/catch as defense in
depth (e.g. a second same-origin tab corrupting storage between the pre-check
and this point).

**Judgment call — where the line is drawn:** a `MARKER_KEY` that decodes fine
as base64 at plausible length but decrypts to the wrong plaintext is
**deliberately left indistinguishable from a real wrong PIN** (still
`wrong_pin` + real `pepperFail()`), per the task's explicit security
requirement — once a real decrypt attempt has run, "corrupted" and "wrong PIN"
must not be distinguishable via response differences, or an attacker learns
about local storage state without knowing the PIN.

**Client wiring:** `web/src/App.tsx`'s `onUnlock` switch now handles
`case 'corrupted'` with "Lokale Daten beschädigt - PIN kann nicht geprüft
werden." — distinct from both `wrong_pin` and `wiped`.

**Tests:** extended `stateMachine.storageUnlockRace.test.js` (3 new tests:
corrupted SALT_KEY → `corrupted` + `pepperRequest` never called; corrupted
MARKER_KEY shape → same; valid-shape-but-wrong-content MARKER_KEY → unchanged
`wrong_pin` + `pepperFail` called once) and rewrote the 3 now-stale tests in
`chaos.corruptedState.test.js` that had documented the old buggy behavior
(one asserted an uncaught exception, one asserted a burned attempt for a
shape the precheck now catches) to instead prove the fix, while keeping a
test for the "valid shape, wrong content" case that must still behave exactly
as before.

---

## Fix 4 — Poll loops have no per-cycle "already running" guard

**Files:** `App.tsx` (native, `checkOutgoing`/`checkIncoming`),
`web/src/App.tsx` (`checkOfflinePackets`). Added a `useRef(false)` cycle-guard
to all three: check-and-return at the top, set before the poll body runs,
reset in a `finally` (or `.finally()` for `checkOutgoing`'s promise-chain
shape) so a thrown error can't leave the guard permanently stuck.

**Verification:** per `SECURITY_CHAOS_TESTING.md`'s own "not testable under
Jest" section, reaching these loops needs a full `<App/>` render behind the
PIN-unlock flow, judged disproportionate there for the same reason here.
Verified by code-reading that the guard is correctly placed (before the first
`fetch`/`AsyncStorage` call, not after) and resets on both success and
failure paths in all 3 functions. As a lower-cost alternative to a full
render, added `stateMachine.pollCycleGuard.test.js`: a source-text structural
check (same style as the existing await/statement-ordering structural tests
in `chaos.keyStateRace.test.js`) confirming the guard ref exists, is
checked/set before the poll body, and is reset inside a `finally`/`.finally`
block in all three functions — plus one fully isolated behavioral test of the
guard pattern itself (overlapping calls skip, a thrown error doesn't wedge
the lock) with no App.tsx dependency.

---

## Test results

Targeted run (all new/modified tests for Fixes 1–4): **51/51 pass.**

Full suite (`npx jest`), run repeatedly to separate this pass's own state
from the concurrent session's churn described above: stabilized at
**232/232 passing** once the concurrent session's transient fuzz-test
failures cleared. One later run reproduced exactly the pre-documented
`relay.js - Body-Groessenlimit` ECONNRESET flake (1/232) under full parallel
load; re-run in isolation (`npx jest -t "Body-Groessenlimit"`) passed cleanly
(2/2), matching the already-documented, unrelated, known-flaky behavior.

## Files touched

- `relay.js` (Fix 1)
- `App.tsx`, `web/src/App.tsx` (Fix 1 client wiring, Fix 3 client wiring, Fix 4)
- `WebRTCManager.js`, `web/src/lib/WebRTCManager.ts` (Fix 2)
- `web/src/lib/Storage.ts` (Fix 3)
- `__tests__/security/chaos.duplicateMessages.test.js` (Fix 1 tests)
- `__tests__/security/chaos.keyStateRace.test.js` (Fix 2 tests)
- `__tests__/security/chaos.corruptedState.test.js` (Fix 3 — updated stale tests)
- `__tests__/security/stateMachine.storageUnlockRace.test.js` (Fix 3 tests)
- `__tests__/security/stateMachine.pollCycleGuard.test.js` (new, Fix 4)

No commits made — working tree left as-is for review, per instructions.
