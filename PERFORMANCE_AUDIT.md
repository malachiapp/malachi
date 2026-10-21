# Performance Audit — SecureCommApp ("Malachi")

**Scope of this pass:** a dedicated performance audit (CPU, memory, the
in-memory `Map`/`Set` "database" in `relay.js`, client-side
`AsyncStorage`/`EncryptedStorage`/`Storage.ts`, network, serialization,
encryption/decryption, file I/O, React/React Native rendering, background
tasks, synchronization) — explicitly **not** a security/correctness review;
`SIMPLIFICATION_PASS.md` and the ~15 `SECURITY_*.md` documents were skimmed
for context and confirm there is little overlap (different lens). This audit
measures the code as it stands **after** `SIMPLIFICATION_PASS.md` (its
redundant-`await import()` removals in hot loops — cover traffic, per-chunk
sends — already addressed some of what a perf pass would otherwise flag; not
re-flagged here).

**Hard constraints honored:** no crypto primitives/protocol touched
(`MessageCrypto.js/.ts`, `HybridCrypto.*`, Kyber/ML-KEM exchange) even where a
different primitive might be marginally faster; no large rewrites — several
real, plausible issues below were investigated and *deliberately left
unfixed* because a proper fix would require a wider-footprint change than
"surgical," and the actual impact at this app's real scale (a self-hosted P2P
messenger, one operator, a handful of contacts) doesn't justify that risk.

**Verdict legend:** **FIXED** (measured before/after) / **INVESTIGATED —
FINE** (measured or reasoned, no action needed) / **FLAGGED, NOT FIXED**
(real but out of scope for a surgical pass, or too costly to verify to the
standard this task requires).

---

## 1. Fixed: unbounded growth of incomplete image/audio chunk buffers (memory leak)

**Where:** `RTCStore.js` (`audioBuffer`/`imgBuffer`, the "no `ChatScreen`
open" buffered-receive path) and `ImageCrypto.js` (`imageBuffers`, the
"`ChatScreen` open, live listener" receive path). Both are module-level /
singleton `Map`s that outlive any single chat session.

**Why this candidate mattered:** both maps aggregate chunks keyed by
`imageId`/`audioId` until the end-marker (`img_end`/`audio_end`) arrives, then
delete the entry. If the sender's connection drops mid-transfer (flaky mobile
network, backgrounded app, peer force-closes) — a routine occurrence for a
P2P messenger, not an edge case — the end-marker never arrives and the
partially-filled entry is **never removed** except by `RTCStore.clearContact()`
/`resetAll()`, which only run on contact deletion or a full wipe. Every
further abandoned attempt (e.g. repeated retries on a bad connection) adds
*another* entry under a new id; nothing ever shrinks the map. Since these are
long-lived singletons (surviving many chat opens/closes and reconnects across
the app's runtime), this is a genuine, unbounded, self-inflicted memory leak
— not a guess, confirmed by reading the only two places that clear these maps
and finding neither is called on transfer failure/timeout/disconnect.

**Fix:** each buffer entry now carries `createdAt`. Before a *new* entry is
created in either map, a `sweepStaleBuffers()`/`sweepStaleImageBuffers()` pass
removes any entry older than `STALE_TRANSFER_MS` (10 minutes — far beyond any
realistic transfer duration, same order of magnitude as `relay.js`'s own
`EXPIRE_MS`). Deliberately **not** a new `setInterval`: `RTCStore.js` is a
singleton imported by nearly every test in the suite, and a perpetually
running timer risked "Jest did not exit"-style side effects across unrelated
tests for a leak that only needs to be bounded, not swept on a strict clock.
Piggybacking the sweep onto "a new transfer is starting anyway" is free and
sufficient.

**Measured:** `__tests__/perf/staleTransferBufferLeak.test.js` (3 tests, all
against the real production code, not a mock of the sweep logic):
- 50 independently-abandoned audio transfers → confirmed `audioBuffer.size`
  is 50 before the sweep condition is met, then collapses to 1 (only the
  fresh entry) the moment a 51st, new transfer starts.
- A transfer that's merely *slow* (created 1s inside the grace window, not
  abandoned) is confirmed **not** swept and completes normally — no
  false-positive data loss.
- `ImageCrypto.js`'s private module buffer: proved via `Date.now()` mocking
  that a stale entry is actually gone (not just logically ignored) by
  attempting to complete it with only its later chunks — this must fail
  (`toBeNull()`) if the earlier chunk was really purged, and does.

Ran the same test file against the **pre-fix** source (`git stash` of just
`RTCStore.js`/`ImageCrypto.js`): 2 of 3 tests fail as expected (`audioBuffer`
grows to 51 instead of collapsing to 1; the "purged" assertion instead
observes the leaked chunk 0 still present and successfully reconstructs the
image) — confirms the leak was real and the fix closes it, not just that the
new tests pass in isolation.

**Not touched:** `AudioCrypto.js`'s equivalent `audioBuffers`/`processAudioChunk`
is exported but, per a repo-wide grep, never actually called from any
production code path (only from its own tests) — dead code, unreachable in
practice, so applying the same fix there would add complexity for a map that
never receives real traffic. Flagged as an aside, not fixed (out of scope —
dead-code, not a live perf issue). The one-off avatar-chunk buffer entries
that `App.tsx` writes directly into `RTCStore.imgBuffer` (`avatar_<chatId>_...`
keys) share the same theoretical leak shape but are bounded by "one stale
entry per contact per abandoned avatar send," and avatar sends only happen on
first connect or when the avatar hash changes — negligible frequency at this
app's scale. Left alone to avoid an App.tsx edit for a corner case with no
measurable impact.

---

## 2. Investigated — fine: `relay.js`'s single `Map` and full linear scans

**Where:** `GET /receive/:recipient`, `GET/POST /packet(/ack)`,
`DELETE /transfer/:token`, and both periodic cleanup intervals (60s expiry
sweep, 5-minute deep cleanup) all iterate the entire `store` Map with
`for...of` instead of a secondary index per recipient.

**Why it looked like a candidate:** textbook "missing index" shape — looks
identical to an unindexed table scan in a real database.

**Why it isn't one here, measured, not assumed:** this relay is explicitly a
single-operator, single-process deployment for one user plus a handful of
contacts (per the app's own architecture docs). `store` holds only
short-lived data (`EXPIRE_MS` = 10 min for messages, 2 min for call signals,
33 days only for the rare reconnect-offer case) that self-prunes. Spun up a
real `relay.js` instance (`relayHarness.js`, the same one the security test
suite uses) and measured `GET /receive/:recipient` against **2000** unrelated
entries in the store — a size this relay would realistically never reach,
even generously multiplied over any plausible contact count:

```
[Perf] GET /receive mit 2000 Store-Eintraegen: 18ms
```
(`__tests__/perf/relayStoreScanScale.test.js`). 18ms for a 20x-exaggerated
worst case is not a bottleneck; no change made.

---

## 3. Investigated — fine: sequential per-contact relay polling (`checkIncoming`/`checkOutgoing`, native + web)

**Where:** `App.tsx`'s `checkOutgoing`/`checkIncoming` effects (8s/15s
intervals) and `web/src/App.tsx`'s equivalents each `for (const contact of
contacts)` and `await fetch(...)` per contact sequentially rather than in
parallel or via a batched relay endpoint.

**Why it looked like a candidate:** this is exactly the "N+1 query" shape the
task asked to look for.

**Why it isn't fixed:** at this app's declared scale ("a handful of
contacts"), sequential polling adds at most a few hundred ms of wall-clock
time to a *background* poll cycle that already runs every 8–15 seconds and is
never on the UI's critical path (no spinner, no blocking render waits on it).
Parallelizing with `Promise.all` would reduce that latency further but
introduces real concurrency risk: several of these per-contact bodies mutate
shared `useRef` sets (`initiatorAttempting`, `responderConnecting`) and call
`setContacts(c => ...)` functional updates whose ordering guarantees were
never designed for out-of-order completion. The gain (sub-second, invisible,
background) doesn't justify that risk or the review burden of re-verifying
every one of the ~15 state-machine/concurrency `SECURITY_*.md` findings that
already depend on this loop's current sequential, one-cycle-lock-at-a-time
behavior. No change made; documented instead of guessed away.

Batching this into a single relay endpoint (e.g. `GET /packet-batch?ids=...`)
would remove the N sequential round-trips entirely, but that's a relay API
change — real scope creep for a "surgical" pass. Flagged as a legitimate
follow-up, not attempted here.

---

## 4. Investigated — fine: `web/src/lib/Storage.ts` per-operation WebCrypto cost and pepper-rotation loop

`getItem`/`setItem` each do one AES-GCM operation via native WebCrypto per
call on small values (chat messages, contact list) — hardware-accelerated,
sub-millisecond, and the expensive part (PBKDF2, 210k iterations) only runs
once at unlock, not per storage op; `dek` is cached in memory afterward. The
pepper-rotation loop in `unlockEncryption()` (`for (const storageKey of
Object.keys(localStorage))`, re-encrypting every key under a new key) runs
**once per successful unlock**, not in any hot path, and iterates a bounded,
small key set (one user's chats + a handful of contacts). No change made.

---

## 5. Investigated — fine: full-file `RNFS.readFile(..., 'base64')` for images/avatars

Sending an image reads the whole file into a single base64 string before
chunking it, rather than streaming reads. This is a real, non-trivial
one-shot cost for a multi-MB photo (a 6MB photo becomes an ~8MB string
crossing the RN bridge), but it's inherent to the current design — the
in-memory chunking/encryption pipeline (`ImageCrypto.js`) already assumes the
full base64 string is available, and streaming it would mean restructuring
the chunk-encrypt-send pipeline around incremental file reads across
`ImageCrypto.js`, `RTCStore.js`, and both `App.tsx`s. That's an architecture
change, not a surgical fix, and it's triggered only by a user-initiated,
one-off action (sending one photo), not a recurring background loop. Left
alone; noted for a dedicated follow-up if larger attachments become common.

---

## 6. Flagged, not fixed: missing `bufferedAmount` backpressure on the live P2P chunk-send path

**Where:** `WebRTCManager`-backed `sendEncryptedImage`/`sendEncryptedAudio`
(`ImageCrypto.js`/`AudioCrypto.js`) send chunks to an open `RTCDataChannel` in
a loop with a fixed `await new Promise(r => setTimeout(r, 10))` between
chunks — no check of `dataChannel.bufferedAmount` before sending the next
one. This is exactly the "does the chunking logic send as fast as possible
with no flow control" question the task asked about, and the honest answer is
partially yes: the loop doesn't consult the channel's actual send buffer, only
a fixed timer.

**Why not fixed:** the `sendFn` callback passed into `sendEncryptedImage`/
`sendEncryptedAudio` from all four call sites (`App.tsx` ×2, `RTCStore.js`
×2) is a plain, fire-and-forget `(raw) => rtc.dataChannel?.send(raw)` closure
— `ImageCrypto.js`/`AudioCrypto.js` never see the `dataChannel` itself, only
this opaque function. Adding real `bufferedAmount`-aware backpressure would
mean changing that contract (passing the channel or a buffered-amount-aware
callback) at every call site — a moderate, cross-file signature change, which
is a bigger footprint than "surgical" for a gap whose real-world risk is
bounded: chunks are 64KB, paced at ~10ms+encrypt-time apart, so at most a few
hundred KB can be in flight even if the network stalls completely — well
under typical `RTCDataChannel`/SCTP buffer limits, for message sizes (a few
MB, personal photos/voice notes) that are nowhere near "high-throughput."
Documented rather than fixed; a dedicated follow-up should thread the
`dataChannel` (or a `canSendMore()` callback) through the send functions if
this ever needs hardening (e.g. before adding video/larger attachments).

---

## 7. Investigated, inconclusive: `ChatScreen`'s 500ms connection-check timer + inline `FlatList` `renderItem`

**Where:** `App.tsx`'s `ChatScreen` runs `setInterval(() => setConn(...),
500)` for the connection indicator, and its message `FlatList` (and the
contacts list `FlatList`) pass `renderItem={({item}) => (...)}` as an inline
arrow function, recreated on every render — the classic RN anti-pattern the
task called out ("inline function props causing child re-renders").

**Why this wasn't turned into a fix:** React bails out of re-rendering when a
`useState` setter is called with a value that's `Object.is`-equal to the
current one (true for the boolean `conn` here), so the 500ms timer likely
*doesn't* force a re-render every tick in steady state — only on an actual
connection-state flip. Whether the inline `renderItem` then meaningfully
re-renders already-mounted message rows on the renders that *do* happen (new
message arrives, status update, etc. — real content changes, not a busy
loop) depends on `VirtualizedList`/`CellRenderer` internals in this RN
version that weren't verified against a real render, because doing so
properly would require standing up a full navigation flow (PIN unlock →
home → open chat with a mocked contact/RTC connection) that doesn't exist
anywhere in the current test suite (`App.test.tsx` only smoke-renders the
lock screen). Building that harness to verify a single, likely-low-impact
re-render question was judged disproportionate — the task's own instruction
is to not optimize on guesses, which cuts both ways: it also means not
*applying* a `useCallback`/`React.memo` change on a guess that it fixes
something real. Left as-is; flagged as unverified rather than "fixed."

---

## 8. Investigated — fine, or already handled

- **`getTurnCredentials()` (`RelayClient.js`/`.ts`):** already has a 5-minute
  in-memory cache before hitting `/turn-credentials` — correctly avoids a
  network round-trip on every connection/call attempt. No change needed.
- **Message persistence (`ChatScreen`'s `AsyncStorage.setItem(storageKey,
  JSON.stringify(msgs))` on every `msgs` change):** re-serializes/writes the
  whole chat's message array on every append. O(n) per message, but n is a
  personal chat's message count (further capped by expiring-message modes),
  not a large dataset — sub-millisecond JSON + storage write at this scale.
  No change needed.
- **Cover traffic / per-tick module re-resolution:** already fixed by
  `SIMPLIFICATION_PASS.md` (A5) — `WebRTCManager.js`'s 3s cover-traffic
  interval and `ImageCrypto.js`'s per-chunk send loop used to re-resolve
  `MessageCrypto` via `await import()` on every tick/chunk; now static
  imports. Verified still in place, not re-flagged.
- **`checkOutgoing`/`checkIncoming` re-reading `AsyncStorage.getItem('contacts')`
  every poll tick instead of using the `contacts` React state already held in
  memory:** looks redundant at first glance, but it's a deliberate choice —
  the effect's dependency array is `[screen]` only (not `[screen, contacts]`),
  so a closure over `contacts` would go stale between poll cycles whenever the
  contact list changes without the screen changing. Re-reading storage each
  tick is the (cheap — a few KB, one native bridge call) price paid to avoid
  that staleness bug. Cost is negligible at this scale; changing it risks
  reintroducing a real correctness bug for no measurable gain. No change made.
- **relay.js route/handler structure:** no duplicated logic worth extracting
  found (confirmed already in `SIMPLIFICATION_PASS.md` C1); no perf-relevant
  inefficiency found either beyond the Map-scan question addressed in §2.
- **Native vs. web `RTCStore`:** the web client has no image/audio
  chunk-buffering at all yet (`RTCStore.ts`'s own comment: "Bild-/Audio-Chunk-
  Puffer folgen, sobald Bilder/Sprachnachrichten fuer Web dran sind") — the
  leak in §1 has no web-side counterpart to fix.

---

## Verification

- `npx jest` (full suite, including the 4 new performance tests added by this
  pass): **313 passed, 313 total**, 32 suites. The previously-documented flake
  (`relay.js - Body-Groessenlimit` under parallel load) did not reproduce in
  this run.
- `cd web && npx tsc --noEmit`: clean, zero errors (no web files were
  changed by this pass — the leak fix is native-only, see §1).
- Re-ran the new leak-regression tests against the pre-fix source via
  `git stash` of just `RTCStore.js`/`ImageCrypto.js` to confirm they fail
  without the fix (see §1) — not just that they pass with it.

## Files changed

`RTCStore.js`, `ImageCrypto.js` (both: stale-buffer sweep, see §1).
New test files: `__tests__/perf/staleTransferBufferLeak.test.js`,
`__tests__/perf/relayStoreScanScale.test.js`.

No git commit was made — changes are left in the working tree for review.
