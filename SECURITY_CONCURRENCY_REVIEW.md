# Concurrency / Race-Condition Review — SecureCommApp ("Malachi")

**Scope of this pass:** a dedicated concurrency/race-condition review, run in
parallel with two other sessions this same run: a "hidden-bug-hunt" pass
(`SECURITY_HIDDEN_BUG_HUNT.md`) and an API-contracts/error-handling pass
(`SECURITY_API_CONTRACTS_ERROR_HANDLING.md`). All prior security documents in
this repo (`SECURITY_REVIEW_1`–`6`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`,
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`, `SECURITY_STATE_MACHINES.md`,
`SECURITY_CHAOS_TESTING.md`, `SECURITY_CHAOS_FOLLOWUP_FIXES.md`,
`SECURITY_SECRETS_LIFECYCLE(.md/_FIXES.md)`, `SECURITY_FUZZING_CAMPAIGN.md`,
`SECURITY_ARCHITECTURE_THREAT_MODEL.md`/`_BACKLOG.md`/`_FINDINGS_ADDRESSED.md`,
`SIMPLIFICATION_PASS.md`) were read in full and treated as ground truth —
findings already proven safe or already fixed there are cited, not
re-verified, per the task's own instruction. This pass specifically hunts for
races those passes didn't reach: `await`-interleaving windows inside
already-reviewed functions, cross-file storage-backend mismatches, and poll
loops outside the ones already hardened.

**Live collision avoided:** `WebRTCManager.js`/`web/src/lib/WebRTCManager.ts`
were independently being edited by the hidden-bug-hunt pass while this review
ran (confirmed via `git diff` mid-session — a `_closed` flag and a guard
placed immediately after `await kyberEncapsulate()`/`await kyberDecapsulate()`
appeared in both files partway through this review). That pass's fix closes
**one** of the two windows this review had independently identified around
the same code (see Finding 1 below) — re-read both files fresh before editing
per the task's own instruction, and this review's own fixes were restructured
to close the **second**, still-open window plus a related, separate bug
(`onMessage` not nulled) rather than duplicate that pass's work. No collision
occurred; both passes' changes coexist in the final diff.

**Verdict legend** (same convention as prior audits in this repo): confirmed
race (reproduced with a real test, real timing control) / confirmed safe
(reasoned about and, where practical, tested) / documented-not-fixed (real,
scoped, deliberately left for a dedicated follow-up per the "no large
rewrites" constraint).

---

## 1. `relay.js` — in-memory `Map`/`Set` mutations

**Structural finding, applies to every route:** every `relay.js` request
handler runs to completion **synchronously** — confirmed by re-reading the
entire file top to bottom — there is no `await` anywhere between an
HTTP-request callback's body starting and it calling `res.end()`. Node's
single-threaded event loop therefore cannot interleave two request handlers'
bodies; each one runs atomically relative to every other one. This was
already established as a "held invariant" by `SECURITY_STATE_MACHINES.md` §7
and `SECURITY_CHAOS_TESTING.md` for the delete-on-fetch endpoints specifically
— this pass re-confirms it holds for **every** route (re-read, not assumed)
and used it to reason precisely about which interleavings are even possible
before testing them.

### 1.1 `/phone/register` + `/phone/lookup` — confirmed safe, new interleavings tried

Per the task's explicit request to check the Fix 1 (`CHAOS_FOLLOWUP_FIXES.md`)
"only-first-claimant-wins" logic's own `store.get(key)` → mutate →
`store.set(key, existing)` sequence for a TOCTOU gap: re-read the current code
(`relay.js:490-531`, `:533-564`) line by line — confirmed **zero** `await`
between the `store.get`/`store.has` read and the following `store.set` in
both handlers. This is provably atomic per §0 above; no TOCTOU window exists
structurally, not just empirically.

- **Confirmed safe (existing coverage, not re-tested):** 3 truly-concurrent
  `/phone/register` calls and 2 concurrent `/phone/lookup` calls for the same
  hash, per `chaos.duplicateMessages.test.js` (`CHAOS_FOLLOWUP_FIXES.md`
  Fix 1).
- **New interleaving tried this pass — confirmed a genuine, previously
  undocumented latent bug (dead code today, not currently reachable via the
  app):** `/phone/lookup`, when the hash is **not yet registered**, stores its
  own bookkeeping entry under a **different** key (`phone_search_<hash>`)
  than `/phone/register` reads/writes (`phone_<hash>`). A lookup-then-register
  sequence for the same hash (device B calls `/phone/lookup` first, finds
  nothing, is told `role:'initiator'`; device A then calls `/phone/register`)
  produces **two disjoint store entries that never reference each other** —
  A's registration never sees B's claim, and `/phone/pending/<hash>` (which
  only reads `phone_<hash>`) reports `found:false` forever. Grepped every
  client call site (`App.tsx`, `web/src/App.tsx`) and confirmed **nothing
  calls `/phone/lookup`** — `startPhoneConnect()` only ever calls
  `/phone/register` (already noted once, from a different angle, in
  `CHAOS_FOLLOWUP_FIXES.md` Fix 1's "Client wiring" section) — so this is not
  currently exploitable by any existing UI flow, but it is a real,
  reproducible data-model inconsistency waiting for the day a client calls
  both endpoints for the same hash. Documented, not fixed (fixing it means
  deciding whether `/phone/lookup`'s not-found branch should write to the
  same `phone_<hash>` key `/phone/register` uses — a small but
  protocol-shape decision, not a one-line change, and the endpoint has zero
  live callers today so there is no regression risk from leaving it as-is).
  **Test:** `concurrency.relayPacketAckAndPhoneRoles.test.js`, describe
  block "Cross-Endpoint-Speicherinkonsistenz".

### 1.2 `POST /packet` → `GET /packet/:recipient` → `POST /packet/ack` — confirmed safe, three new interleavings tried

Already established by prior passes: the millisecond-timestamp store-key
collision (fixed, now uses `crypto.randomBytes` suffix — `relay.js:602`), the
client-ack redelivery mechanism's basic behavior (no-ack redelivers, timely
ack prevents it, a stale ack from **one** generation back is correctly
ignored — `SECURITY_CHAOS_TESTING.md` Scenario 6). This pass specifically
targeted the interleavings the task named as untried:

- **Ack from 2 generations back (not just 1), arriving after two redeliveries
  already happened:** confirmed still correctly rejected (`acked: 0`), the
  live (3rd-generation) entry is untouched and still deletable only by its
  own current token. **New test**,
  `concurrency.relayPacketAckAndPhoneRoles.test.js`.
- **Two truly concurrent `/packet/ack` POSTs (`Promise.all`, no sequencing)
  with overlapping token sets** (3 packets, request A acks tokens `[0,1]`,
  request B acks `[1,2]`, token 1 shared): confirmed the combined `acked`
  count across both responses is **exactly 3** (never 4 — no double-delete
  double-counted; never less than 3 — no delete silently lost) and all three
  entries are actually gone afterward. This follows directly from §0 (fully
  synchronous handlers) but is now empirically confirmed under real HTTP
  concurrency, not just reasoned about. **New test**, same file.
- **20-way concurrent ack "storm"** (every request acking the full,
  identical token list, modeling a retry-loop gone wrong): total acked count
  across all 20 responses is exactly 5 (the real entry count), no crash, no
  corruption. **New test**, same file.

**Verdict: confirmed safe under all three new interleavings**, consistent
with the structural §0 argument.

### 1.3 `/pepper/request|fail|success`, `/send`+`/receive`, `/reconnect/offer|answer`, `/signal/offer|answer`, `/call/signal`, `/push/register`, `/turn-credentials`, `/transfer/:token/chunk/:i`

All re-read; all share the same synchronous-per-request property as §0. The
`pendingToken`/`pendingExpiresAt` mutex for pepper unlock attempts was already
proven to hold under true 200-way concurrency in `SECURITY_CHAOS_TESTING.md`
Scenario 3 — not re-tested. No new interleaving was found worth testing
beyond what prior passes already covered for these routes; the `/call/signal`
cancel/end/reject-flushes-the-whole-queue behavior and the `/transfer/`
chunk-store's opaque (non-length-based) `total` handling were both already
confirmed safe by `SECURITY_CHAOS_TESTING.md`/`SECURITY_FUZZING_CAMPAIGN.md`
respectively.

---

## 2. `WebRTCManager.js`/`.ts` — `channel.onmessage` await-interleaving windows

This was the highest-value area of this review. `channel.onmessage` is
`async`; every `await` inside it is a real yield point where a concurrently
running synchronous call (`RTCStore.clearContact()`, `RTCStore.resetAll()`,
`RTCStore.setConnection()`'s supersede-and-close path — all triggered from
outside this handler, e.g. a chat-delete button, the 5-fail wipe, or a
winning reconnect attempt) can mutate shared state that the paused handler
will later act on when it resumes.

### 2.1 Window A — during the Kyber bridge call itself (`await kyberEncapsulate()`/`await kyberDecapsulate()`)

**Found independently by this review and by the concurrent hidden-bug-hunt
pass; that pass's fix landed first and is the one now in the tree** — see
`SECURITY_HIDDEN_BUG_HUNT.md` Part 2 for the full writeup. Summary: a
`clearContact()`/`resetAll()`/superseding `setConnection()` call while the
Kyber bridge call is in flight used to let the *resuming* handler
unconditionally write `this.sharedSecret`, `RTCStore.sharedSecrets`, and the
persisted `shared_secret_<chatId>` entry — directly resurrecting a secret for
a contact whose deletion/wipe had *already completed*. Fix: a `_closed` flag,
set in `close()`, checked immediately after the bridge call resolves, before
any state mutation. Tested in `hiddenBugHunt.closeDuringHandshake.test.js`
(4 tests, both platforms, verified to fail without the fix). Not re-tested
here.

### 2.2 Window B — during the secret-persistence write itself (new finding, not covered by 2.1's fix)

**Confirmed race, fixed in this pass.** The `_closed` check from §2.1 sits
**before** the block that does:
```js
RTCStore.sharedSecrets.set(this.chatId, this.sharedSecret);   // synchronous
await EncryptedStorage.setItem('shared_secret_' + this.chatId, ...);  // <- window B
```
`RTCStore.sharedSecrets.set()` runs **synchronously**, immediately before the
awaited disk/Storage write starts — there is a **second**, independent window
during that write itself where `clearContact()`/`resetAll()` can still run.
Because the §2.1 guard only fires once, **before** this block, it does not
see a close that happens *during* this window: the resuming handler would
otherwise finish persisting the secret to disk and leave it sitting in
`RTCStore.sharedSecrets` — both **after** `clearContact()`/`resetAll()` already
reported the contact fully removed.

- **Root cause:** a single guard check covering only the first of two
  sequential await points that both need protecting.
- **Trigger:** `clearContact(chatId)` or `resetAll()` called by the main
  thread while `await EncryptedStorage.setItem(...)` (native) /
  `await setItem(...)` (web, `Storage.ts`) is in flight, for a connection
  whose Kyber bridge call had *already* resolved (i.e., strictly after
  window A closes, strictly before the persistence write completes).
- **Fix:** `WebRTCManager.js` (both Kyber handlers) and
  `web/src/lib/WebRTCManager.ts` (both handlers) now re-check `this._closed`
  **again**, immediately after the persistence `await` completes; if true,
  both the just-set `RTCStore.sharedSecrets` entry and the just-written disk
  entry are removed again before returning, undoing the resurrection.
- **Test:** `__tests__/security/concurrency.rtcCloseRaces.test.js`, describe
  blocks "Fenster 2" (native responder-side kyber_pubkey handler, and web
  responder-side kyber_pubkey handler — both gate the persistence write
  behind a controllable promise, call `clearContact()`/`resetAll()` while it
  hangs, then release it and assert the entry is gone from both RAM and
  storage afterward). **Verified to fail without the fix** (manually
  reverted both guard blocks, re-ran, both native tests failed as expected;
  restored, re-ran, all pass again).

### 2.3 Window C — `close()` never nulled `this.onMessage`, letting a paused system-control-message handler resurrect `RTCStore.buffer`/`listeners` after deletion (new finding, fixed in this pass)

**Confirmed race, distinct from 2.1/2.2 (affects message buffering, not key
material), fixed in this pass.** `RTCStore.setConnection()` sets
`rtc.onMessage` to a closure over `chatId`/`this.listeners`/`this.buffer`.
That closure, on a cache miss, does `this.buffer.set(chatId, [])` — it
**creates** the buffer entry rather than merely checking for one. Native's
live-path handler has a genuine await point for exactly four message
subtypes (`secret_start`, `secret_end`, `delete_chat`, `transfer_ready`):
```js
if (!(await isNewerThanLastAcceptedSystemTs(this.chatId, original.ts))) { ...; return; }
...
this.onMessage?.(original);   // <- resumes here after the await
```
`close()` (called by `clearContact()`/`resetAll()`) used to leave
`this.onMessage` pointing at the **same still-valid closure** — so a
`delete_chat` (or `secret_start`/`secret_end`/`transfer_ready`) message whose
processing was paused at the `await` when the user deleted that exact contact
(or the 5-fail wipe ran) would, on resuming, **recreate** `RTCStore.buffer`
for the just-deleted `chatId` and push the message into it — directly
undermining `RTCStore.clearContact()`'s/`resetAll()`'s own guarantee, and a
more active variant of the already-documented Secrets-Lifecycle Finding S-3
("chat delete doesn't purge already-buffered plaintext") — this one *writes
new* data back in *after* the purge, not merely fails to purge what was
already there.

- **Root cause:** `close()` tore down `pc`/`dataChannel`/`sharedSecret`/
  `keyExchangeDone`/`myKyberKeys`/`safetyCode` but never invalidated the
  `onMessage` callback reference itself.
- **Trigger:** a live P2P `delete_chat`/`secret_start`/`secret_end`/
  `transfer_ready` message arrives; while its `await
  isNewerThanLastAcceptedSystemTs(...)` is pending, the same contact is
  deleted locally (`RTCStore.clearContact`) or the device is wiped
  (`RTCStore.resetAll`).
- **Fix:** `close()` (native and web) now also sets `this.onMessage = null`.
  Single, minimal, structural fix — protects **every** message type that
  reaches the final `this.onMessage?.(original)` call, not just the four
  system-control subtypes that currently have an await point before it (this
  also future-proofs the web implementation, which — per
  `SECURITY_FUZZING_CAMPAIGN.md`'s already-documented native/web parser
  differential — doesn't implement the sequence-aware check yet at all; the
  moment it does, this same protection already covers it with zero extra
  code).
- **Test:** `concurrency.rtcCloseRaces.test.js`, describe block
  "Nachrichtenpuffer" — real `RTCStore.setConnection()`, a real encrypted
  `delete_chat` message, `EncryptedStorage.getItem` gated to hold the handler
  mid-`await`, `clearContact()` called while it hangs, released, and
  `RTCStore.buffer`/`listeners` asserted still empty afterward. A control
  test (no concurrent delete) confirms the same message is buffered normally
  when nothing races it — the fix doesn't suppress legitimate delivery.
  **Verified to fail without the fix**, confirmed restored afterward.

### 2.4 New finding along the way — cross-path replay-protection storage split (fixed as part of making 2.3 testable)

While instrumenting 2.3's test, discovered `isNewerThanLastAcceptedSystemTs()`
in `WebRTCManager.js` (native) used `await
import('@react-native-async-storage/async-storage')` — the **real**,
separate npm package — while `App.tsx`'s **word-for-word copy of the same
function** uses `App.tsx`'s own local `AsyncStorage` object, which (confirmed
by reading `App.tsx:22-26`) is **not** that package at all — it's a thin
compatibility wrapper whose every method calls the matching `EncryptedStorage`
method 1:1. These are two **entirely disjoint** storage backends. The
comment directly above the function explicitly claims "beide Zustellwege...
teilen sich absichtlich denselben Zeitstempel-Hochwasserstand" (both delivery
paths deliberately share the same timestamp high-water-mark) — that claim was
false in the code as written: a `secret_end` accepted via the relay-fallback
path (`App.tsx`, updates the `EncryptedStorage`-backed store) would **not**
update the real-AsyncStorage-backed store the live-P2P path checks, so a
captured `secret_start` replayed via the live path after a legitimate
relay-delivered `secret_end` would still be treated as "newer than last
accepted" and be wrongly accepted — reopening the exact cross-path variant of
the replay gap `SECURITY_STATE_MACHINES.md` §10 Finding 5 already flagged
(that finding described the *same-path* replay window; this is the
*cross-path* version of the identical mechanism, previously undocumented).

- **Fix:** changed `isNewerThanLastAcceptedSystemTs()` in `WebRTCManager.js`
  to use the already-statically-imported `EncryptedStorage` directly — the
  same backing store `App.tsx`'s wrapper actually uses — making the "shared
  high-water-mark" claim true instead of aspirational. One function, ~4 lines
  changed net.
  Web has no equivalent function to fix (per `SECURITY_FUZZING_CAMPAIGN.md`'s
  own finding, web doesn't implement the sequence-aware check at all yet).
- **Bonus, discovered as a side effect:** this also fixes a **test-validity**
  bug — under Jest, the dynamic `import()` of the real
  `@react-native-async-storage/async-storage` package throws
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` (confirmed by direct
  reproduction), which was silently swallowed by `channel.onmessage`'s outer
  `try/catch`. The pre-existing `fuzz.protocolMessages.test.js`
  "DIFFERENTIAL-BEFUND" test asserted native correctly rejects a replayed
  `secret_start` — that assertion was passing, but only because the whole
  message-processing path was crashing and being silently discarded, **not**
  because the real sequence-check logic ever ran under test. Re-ran that
  exact test after this fix: still passes, now genuinely exercising
  `isNewerThanLastAcceptedSystemTs()` and hitting the real
  `"Live-Systempaket mit bereits ueberholtem Zeitstempel verworfen"` rejection
  path (confirmed via captured console output before/after the fix). No test
  file was changed to achieve this — an existing test simply became
  meaningful instead of accidentally-correct.
- **Verification:** full suite green after the change (see §7); `cd web &&
  npx tsc --noEmit` unaffected (web has no equivalent code path).

---

## 3. `RTCStore.js`/`.ts` — `resetAll()`/`clearContact()` vs. concurrent `onMessage`

Covered above (§2.2/§2.3) from the `WebRTCManager` side, which is where the
actual race lives (the `RTCStore` methods themselves are fully synchronous
and race-free by construction — `resetAll()`/`clearContact()` iterate and
clear plain `Map`/`Set` objects with no `await` anywhere in either method,
re-confirmed by re-reading both current implementations). The *interaction*
between these synchronous methods and an already-in-flight asynchronous
`WebRTCManager` handler is the actual concurrency-sensitive surface, and is
what §2.2/§2.3 fix.

**`RTCStore.setConnection()`'s supersede-and-close path** (State-Machine
Review Finding 8, already fixed this session by closing the losing
connection): re-examined under this review's lens and confirmed the §2.2/§2.3
fixes **also** protect this path for free — a losing reconnect-race
connection whose in-flight Kyber handshake or paused system-message handling
resumes *after* being superseded can no longer clobber the winning
connection's `RTCStore.sharedSecrets` entry or resurrect a stale buffer, for
the same structural reason (the guard is keyed on `this._closed`/
`this.onMessage`, not on *why* `close()` was called). This closes a variant
`SECURITY_HIDDEN_BUG_HUNT.md` Part 2 explicitly called out as "confirmed by
inspection, not given its own dedicated test since it's the same code path" —
independently re-confirmed true here for the two additional windows this
review found. The underlying resource-leak framing (orphaned, never-explicitly-closed
losing `pc`/`dataChannel` beyond what `.close()` itself tears down) remains
open, unchanged, and out of scope for this pass (same "touches a shared path
used by every connection type" reasoning `SECURITY_STATE_MACHINES.md` §4
already gave).

---

## 4. `CallManager.js` — call-signal poll loop (new finding, fixed in this pass)

**Confirmed race.** `_startPolling()`'s `setInterval(async () => {...},
700)` had **no** "previous cycle still running" guard — the same class of bug
`SECURITY_CHAOS_TESTING.md` Scenario 3 / Fix 4 already found and fixed for
`App.tsx`'s `checkOutgoing`/`checkIncoming` and `web/src/App.tsx`'s
`checkOfflinePackets`, but in a **different file** that pass never touched.
`SECURITY_HIDDEN_BUG_HUNT.md` explicitly checked `CallManager.js` for a
*different* race shape ("long bridge-call await followed by unconditional
mutation") and correctly found none — this is a structurally different bug
(poll-cycle overlap, not a single-await race) that pass wasn't looking for.

- **Root cause:** the interval callback (`pollCallSignals()` + a `for` loop
  awaiting `handleSignal()` per signal, itself doing further awaits —
  `_getSharedSecret()`, `decryptMsg`, and for `answer`/`ice` signals,
  `pc.setRemoteDescription`/`addIceCandidate`) can take longer than
  `POLL_INTERVAL_MS` (700ms) under a slow relay or a burst of signals: the
  next `setInterval` tick fires unconditionally while the previous one is
  still mid-flight, running two overlapping `handleSignal()` chains against
  the same `this.pc`/`this.state`.
- **Trigger:** a slow/backed-up relay response to `pollCallSignals()`, or
  several signals arriving in one poll needing sequential `await
  this.handleSignal(signal)` processing, taking >700ms total.
- **Note:** `handleSignal()`'s own per-signal-type guards (the `answer` case's
  `if (this.state !== CallState.OUTGOING_RINGING) break;`, `acceptCall()`'s
  synchronous state-check-before-any-await) already defend against some
  consequences of double-processing a *specific* signal — this finding is
  about the *outer poll cycle* piling up regardless, at a different layer,
  matching exactly how `SECURITY_CHAOS_TESTING.md` distinguished the
  per-contact connection-attempt guard from the missing outer poll-cycle
  guard for the text/image poll loops.
- **Fix:** added the identical `_pollCycleRunning` ref-style guard pattern
  already established and reviewed for the other three poll loops — checked
  and set before the poll body, reset in a `finally` so a thrown error (e.g.
  a relay error from `pollCallSignals()`) can't wedge the lock permanently.
- **Test:** `__tests__/security/concurrency.callManagerPollGuard.test.js` —
  unlike the existing `stateMachine.pollCycleGuard.test.js` (which had to
  fall back to source-structure checks because `App.tsx` needs a full
  PIN-unlock render), `CallManager` is a plain ES class with no React/render
  dependency, so this test drives the **real** `_startPolling()` method
  directly: the `setInterval` callback is captured via a `jest.spyOn(global,
  'setInterval')` and invoked manually as controlled "ticks," with
  `pollCallSignals` gated behind a releasable promise — a genuine behavioral
  test, not a structural one. 3 tests: overlapping tick is skipped and
  `pollCallSignals` is not called a second time; a cycle that throws still
  releases the guard for the next tick; `_startPolling()` remains idempotent
  (unchanged pre-existing behavior). **Verified to fail (2/3) without the
  fix**, confirmed restored afterward.

---

## 5. Native `AsyncStorage`/`EncryptedStorage` read-modify-write — `contacts` list (documented, not fixed)

**Confirmed race, deliberately not fixed — see rationale below.**
`App.tsx`'s own `AsyncStorage` is a thin `EncryptedStorage` wrapper (see §2.4
— this matters here too: every occurrence below is really an
`EncryptedStorage` read-modify-write, not the separate real npm package).
Grepped every `AsyncStorage.getItem('contacts')` call site (18 total,
`App.tsx:217,309,434,474,624,933,1252,1665,1676,1687,1802,1821,1835,1941,
2545,3568,3595,3606`) — roughly 14 of them follow the shape:
```js
AsyncStorage.getItem('contacts').then(saved => {
  const cs = JSON.parse(saved);
  const updated = cs.map(x => x.id === targetId ? {...x, <one field>} : x);
  AsyncStorage.setItem('contacts', JSON.stringify(updated));
});
```
Each call reads the **entire** current list, changes **one** contact's
field(s), and writes the **entire** list back. Two such cycles for
**different** contacts that overlap in time — read for A starts, read for B
starts before A writes, both compute their own "updated" full list from the
same stale snapshot, whichever **finishes writing last wins outright** and
silently discards the other's change. This is the exact "incoming message
bumps unread count while the user renames a different contact" scenario the
task named as an example. A subset of these calls (the `AppInner`-scoped
ones, e.g. `:933`) sit alongside a `setContacts(c => ...)` React-state update
and a central `useEffect([contacts])` auto-persist (`App.tsx:920-925`) that
would, on its own, be race-free (React serializes functional state updaters)
— but the **redundant** manual read-modify-write next to it is not
coordinated with that effect at all and can still lose data on its own. The
`ChatScreen`-scoped call sites (`:1802`–`:2545`) have **no** such backing
React-state/effect mechanism at all — they are the only writer for their own
change and race directly against every other call site, including the
`AppInner` ones, with nothing in common but the storage key.

- **Root cause:** ~14 independent, uncoordinated read-modify-write cycles
  against the same `'contacts'` storage key, with no serialization between
  them.
- **Trigger:** any two of these call sites firing for **different** contacts
  within roughly one `EncryptedStorage` round-trip of each other — plausible
  in normal use (a message arrives for one contact while the user is
  actively renaming/interacting with another).
- **Test (mirrors the exact production shape, does not touch `App.tsx`):**
  `__tests__/security/concurrency.contactsStorageLostUpdate.test.js` —
  reproduces `App.tsx`'s literal `AsyncStorage` wrapper semantics against the
  real `EncryptedStorage` mock, gates one write behind a releasable promise,
  and confirms the later-finishing write **silently discards** the other
  contact's already-successfully-written change. A control test (sequential,
  no overlap) confirms both changes persist correctly when nothing races —
  the bug is specifically about overlap, not the read-modify-write shape in
  isolation.
- **Why not fixed here:** this is exactly `SIMPLIFICATION_PASS.md`'s own
  finding B1, independently rediscovered here from the concurrency angle
  rather than the redundancy angle — that pass already scoped and declined a
  full fix for the same reasons that apply here even more strongly for a
  concurrency fix: ~14 non-identical call sites (some guard on
  `nameEdited`, some don't; `ChatScreen` sites have no shared React state to
  fall back on) spread across a single 3600+-line file that **two other
  agents are actively editing in this same session** (per this task's own
  briefing). A correct fix needs either a shared serialization
  primitive (a small promise-chaining mutex wrapping every `'contacts'`
  read+write) or migrating the `ChatScreen` sites onto `AppInner`'s existing
  React-state/effect mechanism (not possible for all of them, since
  `ChatScreen` doesn't always have a live reference to `AppInner`'s
  `setContacts`) — either is a real, multi-site change, not a narrow
  one-line patch, and risks colliding with the concurrent sessions' own
  in-flight edits to the exact same file. Flagged as a follow-up task (see
  below) rather than patched blind, consistent with this session's own
  established precedent for exactly this situation.

---

## 6. Areas examined and confirmed already safe (no new finding)

- **Native/web `initiatorAttempting`/`responderConnecting` Sets** (per-contact
  connection-attempt guards, `App.tsx`/`web/src/App.tsx`): re-confirmed
  synchronous check-then-add with no `await` in between — genuinely atomic,
  matches `SECURITY_STATE_MACHINES.md` §4's own re-confirmation. Not
  re-tested.
- **`App.tsx`/`web/src/App.tsx` poll-cycle guards** (`checkOutgoing`,
  `checkIncoming`, `checkOfflinePackets`): already fixed and tested this
  session (`CHAOS_FOLLOWUP_FIXES.md` Fix 4,
  `stateMachine.pollCycleGuard.test.js`). Not re-tested; `CallManager.js`'s
  analogous, previously-missed loop is the new finding in §4.
- **`RelayClient.js`'s `_connectWakeSocket()`**: idempotent by construction
  (synchronous `readyState` guard) per `SECURITY_CHAOS_TESTING.md`'s own
  code-reading confirmation. Re-read this pass, unchanged, no new gap found.
- **`relay.js` WS wake-signal subscribe/unsubscribe** (`wakeSubs`,
  `wsConnectionsByIP`): synchronous per-message handling inside the `ws`
  library's own single-threaded event dispatch; `unsubscribeAll()` is called
  from exactly one place per connection lifecycle event (`message`
  re-subscribe, `close`, `error`) with no overlap possible. No new finding.
- **`RTCStore.setConnection()`'s own supersede-and-close call**: confirmed
  free of its own internal race (fully synchronous), and now doubly
  protected against a *delayed* loser corrupting the winner's state (§3).
- **Web `Storage.ts` unlock key-rotation window** (Finding 13,
  `SECURITY_STATE_MACHINES.md` §2b): already documented in detail by a prior
  pass (a real window where `dek` stays `null` across a full network
  round-trip plus a full re-encryption pass after PIN verification succeeds).
  Not re-derived or re-tested here — cited as still open, unchanged.

---

## 7. Verification

- **New/modified test files, run together:**
  `npx jest __tests__/security/concurrency.rtcCloseRaces.test.js
  __tests__/security/concurrency.callManagerPollGuard.test.js
  __tests__/security/concurrency.relayPacketAckAndPhoneRoles.test.js
  __tests__/security/concurrency.contactsStorageLostUpdate.test.js
  --runInBand` → **14/14 passed.**
- Every confirmed-and-fixed race's test was verified to **fail** when its
  corresponding fix was temporarily reverted (WebRTCManager.js's window-B
  guard, CallManager.js's poll guard), and to pass again once restored —
  not just written to pass against the current code.
- **Full suite:** `npx jest` → **308/309 passed, 29/30 suites**; the one
  failure (`relay.js - Body-Groessenlimit`, `ECONNRESET`) is the
  pre-existing, already-documented flake under full parallel-suite load
  (`SECURITY_STATE_MACHINES.md` §5, re-confirmed present in every prior
  pass's own verification section). Re-ran in isolation
  (`npx jest __tests__/security/relay.http.test.js -t "Body-Groessenlimit"`):
  **2/2 passed**, matching the documented behavior exactly.
- `cd web && npx tsc --noEmit` → clean, zero errors, run after all edits.

---

## 8. Files touched

**Production code:**
- `WebRTCManager.js` — `_closed`-based second-window guard after secret
  persistence (both Kyber handlers), `onMessage = null` in `close()`,
  `isNewerThanLastAcceptedSystemTs()` switched to the shared `EncryptedStorage`
  backend.
- `web/src/lib/WebRTCManager.ts` — same second-window guard and `onMessage =
  null` fix (web has no `isNewerThanLastAcceptedSystemTs` equivalent to fix).
- `CallManager.js` — `_pollCycleRunning` guard added to `_startPolling()`.

**Tests (all new):**
- `__tests__/security/concurrency.rtcCloseRaces.test.js`
- `__tests__/security/concurrency.callManagerPollGuard.test.js`
- `__tests__/security/concurrency.relayPacketAckAndPhoneRoles.test.js`
- `__tests__/security/concurrency.contactsStorageLostUpdate.test.js`

No production code changes were made to `relay.js` (confirmed safe under
every interleaving tried, no fix needed) or to `App.tsx` (the one confirmed,
unfixed race — §5 — was deliberately left for a dedicated follow-up given the
scope/collision-risk reasoning given there). No git commit was made; all
changes are left in the working tree for review.
