# Hidden Bug Hunt — SecureCommApp ("Malachi")

**Scope of this pass:** an adversarial, non-obvious bug hunt explicitly tasked
with finding something **none** of the prior 18 security documents in this
repo found (`SECURITY_REVIEW_1`-`6`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`,
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`, `SECURITY_STATE_MACHINES.md`,
`SECURITY_CHAOS_TESTING.md`, `SECURITY_CHAOS_FOLLOWUP_FIXES.md`,
`SECURITY_FUZZING_CAMPAIGN.md`, `SECURITY_SECRETS_LIFECYCLE.md` +
`_FIXES.md`, `SECURITY_ARCHITECTURE_THREAT_MODEL.md` +
`_BACKLOG.md`/`_FINDINGS_ADDRESSED.md`, `SIMPLIFICATION_PASS.md`), all of
which were read in full before any code was touched. This document is
explicit about what was tried, what didn't pan out and why, and what did.

**Concurrent-editing note:** two other agents were working in this same
session, scoped to API-contracts/error-handling and to concurrency/race
conditions specifically. Mid-pass, `git diff --stat` showed `WebRTCManager.js`
and `web/src/lib/WebRTCManager.ts` had grown well beyond this pass's own
edits — the concurrency-focused agent had independently converged on the
**same root cause** documented below and extended the fix with an additional
defense-in-depth layer (see "What the concurrent concurrency pass added" at
the end of the Confirmed Bug section). This is treated as independent
corroboration, not a collision: both fixes are compatible and were verified
together in the same test/build run.

---

## Part 1 — Attack chains attempted, including negative results

Per the task's own framing, a negative result after this much prior scrutiny
is an expected, valid, and honestly-reportable outcome. Several avenues were
explored and are documented here even though they did not yield a new,
independently-exploitable finding beyond what's already recorded elsewhere.

### 1. Native-vs-web wire-format mismatch across an app-version boundary

**Tried:** whether a native client that hasn't received the "sequence-aware
system-control replay guard" (`isNewerThanLastAcceptedSystemTs()`,
`WebRTCManager.js`) could still interoperate with an updated peer, and
whether the peer's absence of the guard creates an asymmetric replay window
exploitable specifically because of the version skew (not just "web doesn't
implement the feature yet", which `SECURITY_FUZZING_CAMPAIGN.md` §2+3 already
documented as a currently-harmless native/web parser differential).

**Why it doesn't produce a new finding:** the guard is purely defensive and
additive — an old client without it behaves exactly as it did before this
session's fixes (accepts system-control packets on the live path without a
freshness/sequence check), which is already the documented, historical
baseline behavior, not a *regression* introduced by asymmetric upgrades. A
mixed-version pairing (old native ↔ new native) degrades to "as insecure as
the old client always was" for this one packet class, not to something worse
than either version alone. No new attack chain here — it's the same finding
already on record, just restated for a version-skew framing that doesn't
change its severity or reachability.

### 2. Client-ack redelivery (`PACKET_ACK_GRACE_MS`) interacting with the
   sequence-aware replay guard to create a false-reject or false-accept

**Tried:** constructing a scenario where the relay's ack-timeout-triggered
redelivery of a `/packet` entry (added per `SECURITY_CHAOS_TESTING.md` §6)
interacts badly with the sequence-aware high-water-mark check
(`system_ts_hwm_<contactId>` in `AsyncStorage`) for system-control packets —
e.g. a legitimate redelivery being wrongly rejected as a replay, or a
resurrected old high-water-mark letting a genuine new packet slip past
staleness checks.

**Why it doesn't produce a new finding:** redelivery always carries the
*same* `ts` as the original delivery (the relay never mutates the stored
ciphertext, only the delivery bookkeeping around it), so
`isNewerThanLastAcceptedSystemTs()` deterministically classifies the
redelivered copy as "already accepted" if the first delivery succeeded, or
"first now-accepted delivery" if the first delivery was lost before
processing. Both outcomes are correct, not new failure modes. Traced through
both the relay's ack/token bookkeeping (`relay.js`) and the client high-water
mark logic (`App.tsx`, `WebRTCManager.js`) without finding a path where the
two mechanisms disagree.

### 3. Multi-device / two-native-clients-different-version wire divergence in
   `contactId`/token format

**Tried:** whether an older client's 32-bit `Math.random()`-free
`generateContactId()` output could collide with, or be confused for, output
from a differently-versioned generator (in case an in-between commit changed
the ID format). Grepped the full git history region touching
`generateContactId`/`hashPhone` for format changes.

**Why it doesn't produce a new finding:** the ID format has been stable
(random hex string) across all commits reachable in this session; no format
migration exists to create a cross-version parsing ambiguity. This is a
restatement of the already-documented low-entropy-token finding
(`SECURITY_REVIEW_3` Finding B), not a new one.

### 4. Offline-sync / multi-device account-recovery race

**Tried:** since Malachi has no multi-device or account-recovery concept at
all (confirmed structurally in `SECURITY_STATE_MACHINES.md` §1 and
independently re-confirmed by grep here), there is no "two devices sharing
one identity" state to desynchronize. This entire attack surface category
named in the task brief is **architecturally absent**, not merely
well-defended — confirmed by re-grepping for `device_id`/`linked_device`/
multi-session concepts across `App.tsx`, `web/src/App.tsx`, and `relay.js`:
none exist beyond the single-device-is-the-account model already documented.
No new finding possible here because there is no mechanism to attack.

### 5. Rare event ordering: `RTCStore.setConnection()`'s supersede-and-close
   path racing a live handshake on the *losing* connection

**Tried and this DID lead somewhere — see Part 2.** This is the same root
cause as the confirmed bug below, reached via a different trigger (a
reconnect race, per `SECURITY_STATE_MACHINES.md` §4 Finding 8's "orphaned
connection" framing) rather than a wipe/delete. Not treated as a second,
separate finding since it shares the identical root cause and identical fix —
documented under "Related code paths checked" in Part 2.

### 6. App-restart mid-transition interacting with the *new* `resetAll()`/
   `clearContact()` cleanup added this session

This is the finding. See Part 2.

---

## Part 2 — Confirmed bug

### Title: `close()` does not cancel an in-flight Kyber handshake — a wipe or
### chat-delete that lands mid-handshake resurrects the "deleted" secret

**Affected components:** `WebRTCManager.js` (native) and
`web/src/lib/WebRTCManager.ts` (web), in combination with `RTCStore.js` /
`web/src/lib/RTCStore.ts`'s `resetAll()`/`clearContact()` (added this session
per `SECURITY_SECRETS_LIFECYCLE_FIXES.md` Fix 2/Fix 4) and the 5-fail wipe /
chat-delete / `device_wiped`-tombstone call sites in `App.tsx` and
`web/src/App.tsx`.

#### Root cause

`WebRTCManager.close()` nulls a fixed set of instance fields (`pc`,
`dataChannel`, `sharedSecret`, `keyExchangeDone`, `myKyberKeys`,
`safetyCode`) and stops the cover-traffic/liveness-watch intervals — but it
is a **plain synchronous function with no way to cancel a `channel.onmessage`
handler that is already running** on that same instance. The two Kyber
handlers (`kyber_pubkey` for the responder, `kyber_ciphertext` for the
initiator) each contain a real, non-trivial `await` on the actual key-exchange
primitive:

```js
const result = await kyberEncapsulate(msg.publicKey);       // native: NativeModules.KyberModule.encapsulate — a real JS↔Kotlin bridge round-trip to BouncyCastle
this.sharedSecret    = result.sharedSecret;
...
```
```js
this.sharedSecret = await kyberDecapsulate(msg.cipherText, this.myKyberKeys.secretKey);
```

(`HybridCrypto.js` confirms both calls cross the React Native bridge to a
real native module; `web/src/lib/HybridCrypto.ts` calls real
`@noble/post-quantum` ML-KEM-768 operations — both are genuine, multi-step
asynchronous operations, not instant microtask resolutions.)

If `close()` runs on this *exact* instance while that `await` is still
pending — for example because the app's 5-fail wipe just fired
(`RTCStore.resetAll()`), the user just deleted the chat
(`RTCStore.clearContact()`), a `device_wiped` tombstone for the same contact
just arrived (also `clearContact()`), or a competing reconnect attempt just
won the race and called `RTCStore.setConnection()`'s own supersede-and-close
path — the handler is completely unaware. When the bridge call eventually
resolves, the (already "closed") handler resumes exactly where it left off:
it sets `this.sharedSecret`, sets `this.keyExchangeDone = true`, and
unconditionally does

```js
RTCStore.sharedSecrets.set(this.chatId, this.sharedSecret);
await EncryptedStorage.setItem('shared_secret_' + this.chatId, this.sharedSecret) ...
```

— repopulating the very `RTCStore.sharedSecrets` Map entry (and, for the web
client, the `Storage.ts` PIN+pepper-gated persistent entry) that
`resetAll()`/`clearContact()` had *just* deleted, and then proceeds to
`_flushPending()`, `_startCoverTraffic()`, `_startLivenessWatch()`, and
`_onKeyExchange()` (which sends a profile/avatar packet) — i.e. the "wiped"
or "deleted" contact's session keeps running as if nothing happened.

For the initiator-side `kyber_ciphertext` handler specifically, there is no
`channel.send()` call between the `await` and the state-mutating block, so
there is no accidental protection from the closed data channel throwing —
this path was confirmed to be **deterministically reachable**, not a rare
timing fluke, whenever the interleaving lands during the bridge call.

#### Concrete trigger (traced against real code, both platforms)

1. Contact X is mid-reconnect: the responder side has received `kyber_pubkey`
   and is awaiting `kyberEncapsulate()` (a real several-millisecond bridge
   round-trip). `keyExchangeDone` is still `false`.
2. At this exact moment, one of the following fires (all real, reachable UI
   paths documented elsewhere in this repo):
   - the user's 5th wrong PIN attempt triggers the native wipe
     (`App.tsx`'s `LockScreen` `att>=5` branch → `RTCStore.resetAll()`), or
     the web pepper-wipe equivalent;
   - the user deletes the chat for contact X (`onDelete` →
     `RTCStore.clearContact(chatId)`);
   - a `device_wiped` tombstone for contact X arrives from the peer
     (→ `RTCStore.clearContact(contact.id)`);
   - a second, competing reconnect attempt for contact X wins the race and
     calls `RTCStore.setConnection()`, which closes the "losing" connection
     (`SECURITY_STATE_MACHINES.md` §4 Finding 8's scenario, extended here).
3. `resetAll()`/`clearContact()`/`setConnection()` all call `.close()`
   synchronously on the in-flight `WebRTCManager` instance, nulling its
   fields and (before this pass's fix) leaving no trace that the instance was
   closed.
4. The bridge call resolves. The suspended handler resumes, re-derives and
   re-persists the shared secret, and restarts cover traffic — for a contact
   the user just told the app to forget.

#### Impact

- **Undermines the S-1 fix from this same session** (`RTCStore.resetAll()`,
  added specifically so "a complete wipe doesn't leave live session secrets
  running in memory") for exactly the class of timing this pass's own
  `SECURITY_CHAOS_TESTING.md`/`SECURITY_SECRETS_LIFECYCLE.md` passes were
  built to catch, but via a trigger (an in-flight handshake, not an
  already-established connection) neither of those passes constructed.
- **Undermines the S-3 fix** (`RTCStore.clearContact()`) identically for a
  single deleted contact.
- Data-integrity/confidentiality-adjacent: a device that the user believes is
  "wiped" or a contact the user believes is "deleted" can silently continue
  encrypting, decrypting, and transmitting cover traffic under a freshly
  re-derived session key, with a live secret sitting back in
  `RTCStore.sharedSecrets` (and, if the timing lands right relative to the
  wipe's own later `EncryptedStorage.clear()`/`localStorage.clear()` call,
  potentially re-persisted to disk *after* the wipe supposedly completed).
- Severity: **Correctness/Data-Integrity**, not a cryptographic break — no
  attacker gains plaintext they weren't already structurally entitled to as
  the real peer; the harm is that "wipe"/"delete" silently fails to be
  durable for a narrow but real timing window, exactly contradicting the
  guarantee those two mechanisms exist to provide.

#### Fix applied

Added an explicit `_closed` flag to `WebRTCManager` on both platforms:
`false` in the constructor, set to `true` at the top of `close()`. Both Kyber
handlers now check `if (this._closed) { ...warn...; return; }` **immediately
after** the `kyberEncapsulate`/`kyberDecapsulate` bridge call resolves, before
touching `this.sharedSecret`, `RTCStore.sharedSecrets`, or persistent
storage. This mirrors the existing `keyExchangeDone` duplicate/replay guard
already in the same handlers (same file, same idiom), so it introduces no new
pattern to the codebase.

- `WebRTCManager.js`: constructor (`_closed = false`), `close()`
  (`_closed = true`), both `channel.onmessage` Kyber branches (guard right
  after each bridge `await`).
- `web/src/lib/WebRTCManager.ts`: identical, field/constructor/`close()`/both
  branches.

**What the concurrent concurrency-focused pass added on top of this fix**
(observed via `git diff` mid-pass, verified compatible, not duplicated):
a second `_closed` check *after* the `EncryptedStorage.setItem()`/`setItem()`
persistence `await` in both handlers (closing the narrower window where
`close()` lands during the disk write itself, after the in-RAM
`RTCStore.sharedSecrets.set()` already ran — in that case the now-stale
entry is explicitly deleted again from both RAM and disk instead of merely
not being written a second time), and nulling `this.onMessage` inside
`close()` (closing an adjacent variant of the same root cause: a suspended
handler on the `'encrypted'` message path calling `this.onMessage?.(original)`
after close, which would otherwise recreate a `RTCStore.buffer`/listener
entry for an already-deleted contact). Both additions are the same root
cause, same idiom, and were verified together with this pass's own fix and
tests — no conflict, no duplication of logic.

#### Regression test

`__tests__/security/hiddenBugHunt.closeDuringHandshake.test.js` — 3 tests,
real production code (`WebRTCManager`, `RTCStore`), no reimplemented mirrors:

1. **Native, responder side:** gates `NativeModules.KyberModule.encapsulate`
   behind a controllable promise, starts processing a real `kyber_pubkey`
   message, calls `RTCStore.resetAll()` while the bridge call is still
   pending (simulating the 5-fail wipe), then releases the bridge result.
   Asserts `RTCStore.sharedSecrets` stays empty, `EncryptedStorage.setItem`
   is never called with the secret, `rtcResp.sharedSecret`/`keyExchangeDone`
   stay at their post-close values, and the new warning fires.
2. **Native, initiator side:** same shape, gating `decapsulate`, using
   `RTCStore.clearContact()` (simulating chat-delete) instead of
   `resetAll()`.
3. **Web, responder side:** same shape against the real `WebRTCManager.ts`
   and real `RTCStore.ts`, spying on `HybridCrypto.kyberEncapsulate` and
   `Storage.setItem`.

**Verified the tests actually catch the bug**, per this session's own
established convention: temporarily neutralized both `if (this._closed)`
guards in `WebRTCManager.js` (`sed` replace to `if (false && this._closed)`),
re-ran the suite — 2 of 3 tests failed exactly as expected (`toBeNull()` /
`toBe(false)` assertions on the resurrected secret failed with the secret
present instead), confirmed byte-for-byte restoration via `diff` against a
pre-edit backup, then re-ran to confirm all 3 pass again.

#### Related code paths checked for the same bug pattern

- **`RTCStore.setConnection()`'s existing supersede-and-close path** (added
  per `SECURITY_STATE_MACHINES.md` §4 Finding 8, both platforms): calls
  `existing.close()` on the "losing" connection of a reconnect race. Before
  this fix, a losing connection's in-flight handshake could finish *after*
  the winning connection already set the correct secret, and — with no
  ordering guarantee — the losing connection's stale/wrong secret could
  overwrite the winner's in `RTCStore.sharedSecrets` (a correctness bug
  strictly worse than the previously-documented "orphaned, unclosed
  `RTCPeerConnection`" framing, which only flagged the resource leak, not
  that the loser could also corrupt the winner's key state). This fix closes
  that variant identically, as a side effect of the same guard, without any
  additional code — confirmed by inspection, not given its own dedicated test
  since it's the same code path already covered by tests 1–3 above.
- **`_flushPending()`, `_startCoverTraffic()`, `_startLivenessWatch()`,
  `_onKeyExchange()`** — all four are reached only through the same two Kyber
  handlers on the success path, so the single early-return guard suppresses
  all of them together; no separate guard was needed at each call site.
- **`CallManager.js`** — checked for an analogous "long-running await
  followed by unconditional state mutation, racing a close/teardown" shape.
  `_getSharedSecret()`/`_sendSignal()` read `RTCStore.getSharedSecret()`
  synchronously per call with no equivalent multi-step bridge operation in
  between: no matching pattern found there.
- **`ImageCrypto.js`/`AudioCrypto.js` chunk handlers** — these run
  synchronously per chunk with no comparable bridge-crossing `await` between
  "receive chunk" and "mutate buffer," so the same race shape does not apply;
  their own known bugs (unvalidated `total`/duplicate-index handling) are
  already tracked in `SECURITY_FUZZING_CAMPAIGN.md` and were not re-examined
  here.

---

## Part 3 — Verification results

- New test file alone: `npx jest __tests__/security/hiddenBugHunt.closeDuringHandshake.test.js`
  → **3/3 passed**, confirmed to fail (2/3) when the fix is temporarily
  reverted, confirmed to pass again after restoring.
- Full suite, run twice consecutively: `npx jest`
  → run 1: **280/280 passed** (26 suites), no flake observed.
  → run 2: **279/280 passed**, the single failure was the pre-documented,
    known flake (`relay.js - Body-Groessenlimit`, `ECONNRESET` under parallel
    full-suite load) — re-run in isolation
    (`npx jest __tests__/security/relay.http.test.js -t "Body-Groessenlimit"`)
    passed cleanly (2/2), matching the behavior every prior document in this
    repo already documents for this specific test.
- `cd web && npx tsc --noEmit` → clean, zero errors, run after all edits
  (including the concurrently-added extensions to the same files).

## Files touched

- `WebRTCManager.js` (native) — `_closed` flag + constructor/`close()` +
  both Kyber-handler guards.
- `web/src/lib/WebRTCManager.ts` (web) — identical.
- `__tests__/security/hiddenBugHunt.closeDuringHandshake.test.js` (new).
- `SECURITY_HIDDEN_BUG_HUNT.md` (this file, new).

No other production files were modified by this pass. No git commit was
made — everything is left in the working tree for review, per instructions.
