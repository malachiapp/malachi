# Security Self-Review — Adversarial Pass Over This Session's Own Fixes

Scope: full security-hardening arc on `rn-upgrade-086`, range `3bd29b7..HEAD`
(7 commits: RN 0.86 upgrade baseline through Wave 2 bug-hunt/API-contracts/
concurrency, commit `68e2eee`). Goal: assume this session's own fixes are
flawed until proven otherwise; verify claims in the 22 SECURITY_*.md /
SIMPLIFICATION_PASS.md documents against actual current code, especially
where multiple passes touched the same file. `PERFORMANCE_AUDIT.md` does not
exist yet (parallel performance-audit agent had not produced it at review
time) — skipped per instructions.

No bugs requiring a code change were found. Every priority area was traced
end-to-end against its stated goal and confirmed correct. This is reported
as-is rather than manufacturing a finding — see per-area detail below.

## 1. WebRTCManager.close() during Kyber handshake (commit `68e2eee`, three
   convergent fixes)

Read `WebRTCManager.js`/`.ts` in full. Three independent findings landed in
the same commit: (a) `_closed` flag checked immediately after
`kyberEncapsulate`/`kyberDecapsulate` resolves, (b) a second `_closed` check
after the awaited `EncryptedStorage.setItem`/`setItem` persist call, (c)
`close()` now nulls `this.onMessage` so a still-in-flight `channel.onmessage`
(e.g. hung in `await isNewerThanLastAcceptedSystemTs()`) can't resurrect a
buffer/listener entry for a just-deleted contact.

Traced the composition by hand: between check (a) and the
`RTCStore.sharedSecrets.set()` call there is no `await`, so no interleaving
is possible there (single-threaded JS, no yield point) — check (a) alone
would miss the window during the persist `await`, which is exactly what
check (b) closes. The two checks are not redundant and don't undo each
other: (a) prevents mutating state at all if closed before the bridge call
returns; (b) reverts the RAM+disk state that was already (correctly, at the
time) written before `close()` ran mid-persist. Native and web mirror each
other exactly (`WebRTCManager.js` lines ~447-489/511-533; `WebRTCManager.ts`
lines ~300-330/347-366).

This is already covered by dedicated regression tests
(`__tests__/security/hiddenBugHunt.closeDuringHandshake.test.js` for window
1, `__tests__/security/concurrency.rtcCloseRaces.test.js` for window 2 and
the `onMessage`-buffer window, both native and web variants). Re-ran them
individually — all pass, and their structure (gate the bridge/storage call,
close mid-flight, release the gate, assert no resurrection) is a real proof
of the composed behavior, not just of each patch in isolation.

**Verdict: correct as merged. No bug found.**

## 2. `/packet` ack-based redelivery mechanism, full evolution

Traced `relay.js`'s `/packet` (POST), `/packet/:recipient` (GET),
`/packet/ack` (POST) from introduction (`e9a29aa`) through the key-collision
fix (random suffix, same commit), the fuzzing pass (`c266d79`, no code
change to this mechanism itself, added `relay.http.test.js` coverage), to
the concurrency review (`68e2eee`,
`concurrency.relayPacketAckAndPhoneRoles.test.js`).

Checked the GET handler's pending/ack-token assignment: it's a synchronous
`for...of` loop over the in-RAM `Map` with no `await` inside, so under
Node's single-threaded event loop two concurrent GETs for the same
recipient cannot interleave mid-loop — the "already pending, don't
re-issue" check and the token assignment are effectively atomic. Confirmed
the POST key uses `packet_<recipient>_<ts>_<random>` (closes the original
same-millisecond collision) and that `/packet/ack` only deletes entries
whose `ackToken` matches, so a stale/replayed ack token from an earlier
delivery round can't delete an unrelated, newer packet.

Traced client-side msgId dedup (introduced alongside the ack mechanism in
`e9a29aa` to cover the redelivery-without-ack case) in `App.tsx`: present at
both the buffered-poll merge site (~line 1744-1755, dedup by `id` before
appending) and the live-listener site (~line 1780-1782, skip if `msgId`
already present). Both still intact after Wave 2; nothing in the later
concurrency pass touched this logic path, and the new
`concurrency.relayPacketAckAndPhoneRoles.test.js` exercises the ack
mechanism together with the phone-role-claim fix from `c266d79` without
regressing either.

**Verdict: internally consistent across all three commits. No bug found.**

## 3. Simplification pass vs. later fixes (ordering/collision check)

`SIMPLIFICATION_PASS.md`'s changes and Wave 2's three parallel passes are
bundled in the same commit (`68e2eee`); the commit message states the
simplification pass ran first, feeding into Wave 2. Verified this ordering
is safe by checking the two files where both passes touched overlapping
code:

- `WebRTCManager.js`: simplification pass (A5) replaced a per-tick dynamic
  `import()` of `MessageCrypto` in `_startCoverTraffic()` with the existing
  static top-level import, and (A9) removed an unused `isEmulator`
  computation + its now-dead `NativeModules`/`Platform` import. Neither
  touches the `_closed`/Kyber-handshake code Wave 2 then added — confirmed
  by reading the full current file (see §1): the static `encryptMsg` import
  is used correctly in `_startCoverTraffic()`, and `_computeSafetyCode()`'s
  own separate `require('react-native').NativeModules` call (unrelated to
  the removed top-level import) still works.
- `App.tsx`: simplification pass's A3 (`expireModeToExpireAt()` extraction)
  and A4 (single `getItem` instead of `multiGet`) are both in `ChatScreen`,
  unrelated to the wipe/device_wiped/contacts-race code Wave 2's
  concurrency review flagged (the ~14-site contacts read-modify-write race,
  B1 in the simplification doc, was explicitly left alone by *both* passes
  and is tracked as a known, deliberately-deferred follow-up in both
  documents — consistent, not contradictory).

**Verdict: no collision. The simplification pass's own removals were of
genuinely dead/redundant code paths that Wave 2's fixes don't depend on.**

## 4. device_wiped tombstone + `RTCStore.resetAll()`/`clearContact()`
   end-to-end

Traced the full lifecycle: `e9a29aa` introduced receive-side tombstoning
(native `App.tsx` ~line 711-736 inside `checkIncoming`'s relay-poll path;
web `App.tsx` ~line 260-270 inside `checkOfflinePackets`) plus send-side
best-effort notification (native only, PIN-wipe flow, ~line 1251-1271: reads
`RTCStore.sharedSecrets`/disk-persisted secrets *before* wiping, POSTs
`/packet` per contact). `c266d79` added `RTCStore.resetAll()` (5-fail-wipe)
and `clearContact()` (single-contact delete/tombstone) to purge in-memory
state. `68e2eee`'s concurrency review then hardened `close()` itself (§1).

Verified the ordering-sensitive part explicitly: the wipe flow (App.tsx
~line 1278) calls `RTCStore.resetAll()` *after* collecting secrets for the
notification send (required, since `resetAll()` would otherwise clear the
secrets before they can be used to encrypt the notice) and *before* the
final `AsyncStorage.clear()`/`EncryptedStorage.clear()` disk wipe. Checked
whether a handshake resurrected by the close()-race (§1) *before* the
concurrency-review fix could have left a `shared_secret_<id>` entry that
survives past `resetAll()`: even without the §1 fix, `EncryptedStorage.
clear()` (unconditional, no per-key logic) at the end of the wipe flow would
still remove it — but with the fix, the resurrection itself no longer
happens, both defenses layer correctly rather than one masking a gap in the
other.

One residual, pre-existing (not-this-session) edge case checked and judged
out of scope: a *brand-new* incoming connection attempt (not yet in
`RTCStore.connections` when `resetAll()` runs) that completes its handshake
after `resetAll()` but concurrently with the disk-clear calls could, in
principle, write a fresh secret that isn't covered by either `close()`'s
`_closed` check (it was never closed) or the final `clear()` if it writes
after `clear()` executes. This is architecturally a "new connection
established during app teardown" scenario, not the "existing connection,
close() races its own in-flight handshake" scenario every fix in this
session's history explicitly targets, and the wipe flow already runs from a
locked/PIN screen where new WebRTC connections aren't normally initiated.
Documented here for completeness; not treated as a regression since no
commit in this session claimed to close this specific window.

Confirmed web/native parity: `clearContact()`/`resetAll()` are structurally
identical between `RTCStore.js` and `web/src/lib/RTCStore.ts`, both close()
implementations mirror each other exactly (§1), and web's intentional
non-support of `secret_start`/`secret_end`/`delete_chat` system subtypes
(documented inline in `web/src/App.tsx` ~line 250) predates this session
and isn't a Wave-2-introduced asymmetry.

**Verdict: mechanism is coherent end-to-end against its own stated goal. No
bug found; one pre-existing, out-of-scope theoretical edge case noted.**

## Other spot-checks performed

- `relay.js` `/pepper/register`: `typeof deviceId !== 'string'` check
  (fuzzing-campaign fix) correctly precedes the `.length` check — confirmed
  no regression from later commits touching this handler.
- `CallManager.js` poll-cycle guard (concurrency review): `try/finally`
  correctly resets `_pollCycleRunning`, matching the same pattern already
  used in `App.tsx`'s `checkOutgoing`/`checkIncoming` and web's
  `checkOfflinePackets` — verified the `finally` block can't be skipped by
  an early return inside the `try`.
- `isNewerThanLastAcceptedSystemTs()` storage backing: confirmed native
  `App.tsx`'s local `AsyncStorage` shim (line 23-40) is a thin wrapper
  directly over `EncryptedStorage`, matching the fix in `WebRTCManager.js`
  that switched from the real `@react-native-async-storage/async-storage`
  to the same `EncryptedStorage` instance — the "shared high-water-mark"
  claim in the code comments is now actually true, not just asserted.

## Full-suite verification status

- `npx jest` (native + shared `__tests__/security`): **308 passed, 1
  failed, 309 total.** The one failure is the pre-documented flake
  (`relay.js - Body-Groessenlimit › ... wird mit 413 abgelehnt`,
  `ECONNRESET` under parallel load) — matches the known, accepted flake
  from prior commit messages exactly, no new failures.
- `cd web && npx tsc --noEmit`: clean, zero errors.
- No code changes were made during this review (nothing failed
  verification), so no re-test-after-fix cycle was needed.
