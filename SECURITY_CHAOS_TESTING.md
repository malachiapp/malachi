# Chaos/Resilience Adversarial Testing — SecureCommApp ("Malachi")

**Scope of this pass:** the first chaos/resilience-specific pass this session,
following `SECURITY_REVIEW_1`–`6`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`,
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`, and `SECURITY_STATE_MACHINES.md`.
Those documents are treated as context, not re-derived. This pass simulates
hostile/unreliable *conditions* (network loss, process crashes, corrupted
storage, duplicate/out-of-order/contradictory messages) rather than auditing
static claims, and asks the same 8 invariant questions after every scenario.

**Note on timing:** this codebase was under active, concurrent revision while
this pass ran (confirmed via `git status`/`git diff`): `App.tsx`,
`web/src/App.tsx`, `web/src/lib/Storage.ts`, `RTCStore.js`/`.ts`,
`WebRTCManager.js`/`.ts`, and — notably — **`relay.js` itself was live-patched
mid-pass** to add the client-ack-before-delete mechanism for `/packet`
(`PACKET_ACK_GRACE_MS`, new `POST /packet/ack` endpoint) that
`SECURITY_STATE_MACHINES.md` §7 had flagged as the fix needed for its
"message loss on relay-fallback delivery" finding. This pass **tests the
relay.js that was actually on disk at run time** (the test harness copies the
live file fresh on every run) and explicitly re-tested that new mechanism
(see "Client-Ack Redelivery" below) rather than treating the old behavior as
still current.

**Test files added (all real, executed, not thought experiments):**

| File | Lines | Tests | Focus |
|---|---:|---:|---|
| `__tests__/security/chaos.relayNetworkFailures.test.js` | 444 | 14 | Network loss, server restart, concurrent request piling, stale-offer resurrection, `/packet` timestamp-key collision, WS wake-signal flood/cleanup, new client-ack redelivery mechanism |
| `__tests__/security/chaos.duplicateMessages.test.js` | 258 | 8 | Duplicate/parallel requests, contradictory role assignment, client-side (RTCStore) message dedup |
| `__tests__/security/chaos.corruptedState.test.js` | 271 | 11 | Malformed DataChannel messages, corrupted persisted secrets, corrupted/partial web `Storage.ts` local state |
| `__tests__/security/chaos.keyStateRace.test.js` | 251 | 4 | App-kill mid-Kyber-handshake → two devices with divergent post-restart key state |

**Full suite result (`npx jest __tests__/security`), all 4 new files
included:** 176/177 passed. The 1 failure
(`relay.js - Body-Groessenlimit › ... 413 ... ECONNRESET`) is a **pre-existing
known flake** under full-suite parallel load — already documented in
`SECURITY_STATE_MACHINES.md` §5 ("the 1 failure is a pre-existing, unrelated
flaky network test in relay.http.test.js, ECONNRESET on a >2MB body test,
not touched by this pass"). Re-run in isolation it passes cleanly (verified
here again: 2/2 pass alone). Not related to any change in this pass.

---

## Scenario-by-scenario summary

For each scenario: what was simulated, how, and the 8 invariant questions
where they have a non-trivial answer (trivial "N/A, no plaintext ever
touched" answers are omitted for brevity and folded into the prose).

### 1. Network loss — request to relay.js that never completes

**Simulated:** a raw TCP socket writes a real HTTP request, then the relay
child process is hard-killed (`SIGTERM`/`SIGKILL` via the harness) before the
response is flushed; separately, a request against an already-dead port is
issued to check the client doesn't hang waiting for a name/port that no
longer answers.

**Result:** the socket closes/errors, it does not hang indefinitely (verified
with an explicit "did we time out instead of failing" guard); a fresh request
against the now-dead port gets `ECONNREFUSED` immediately, not a hang. **Held
invariant** — a real client's `fetch`/`http.request` against this relay does
not need its own client-side timeout to avoid hanging forever when the
server process itself is gone (TCP RST does the job); a genuinely slow-but-
alive server is a different case (see §3 below, not independently testable).

**Invariants:** #8 — this is a pure connectivity failure, not a
confidentiality/integrity issue; no plaintext or key material is exposed by a
killed connection.

### 2. Server restart — in-RAM state genuinely gone, clients recover

**Simulated:** register a pepper, store a `/packet`, store a
`/reconnect/offer` on one relay child process; hard-kill it; start a **new**
child process (simulating a systemd/pm2 restart); probe all three pieces of
state on the new process, then re-register.

**Result:** all three are genuinely gone (`404`/empty on the new process —
not merely inaccessible, actually absent, confirmed by re-registering the
same `deviceId` and getting a **different** pepper value, not the old one
somehow surviving). Re-registration on the fresh process works without any
special client-side handling. **Confirms by direct reproduction** (not just
code-reading) the "zero-knowledge/ephemeral by design" property
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` already asserted for the pepper
store specifically, extended here to `/packet` and `/reconnect/offer`.

**Invariants:** #2/#5 — no stale key material survives a restart at the
relay (the relay never held any key material to begin with — only ciphertext
blobs and rendezvous metadata); #8 — a restart is a pure availability event,
not a confidentiality regression.

### 3. Server timeout — do client polling loops pile up or serialize?

**Split finding, one tested, one not.**

- **Relay side (tested):** fired 200 truly-concurrent `/pepper/request` calls
  for the *same* `deviceId` via `Promise.all` (no sequencing, unlike the
  existing `relay.http.test.js` coverage which issues them one at a time) —
  exactly **one** succeeds with a token, the other 199 get `429
  versuch_laeuft_noch`. The existing `pendingToken`/`pendingExpiresAt` mutex
  (already characterized as "held" in `SECURITY_STATE_MACHINES.md` §5) holds
  even under raw concurrency, not just sequential calls.
- **Client side (App.tsx/web App.tsx poll loops): not independently
  tested** — see "Not testable under Jest" below. **Code-reading finding,
  not test-proven:** `checkOutgoing`'s `setInterval(checkOutgoing, 15000)`
  (`App.tsx:588`) fires unconditionally every 15s regardless of whether the
  previous cycle's `fetch` calls are still in flight — there is no
  "already polling, skip this tick" guard at the *poll-cycle* level (the
  `initiatorAttempting`/`responderConnecting` Sets only guard *starting a new
  WebRTC connection attempt per contact*, not the outer HTTP poll calls
  themselves). Against a relay that accepts a TCP connection but never
  responds, this plausibly means concurrent in-flight `fetch` calls
  accumulate one per contact per 15s tick for as long as the relay stays
  slow. Low severity (self-bounded by contact count × poll interval, no
  unbounded growth, no crash), but not previously documented from this
  specific angle.

### 4. Stale reconnect-offer resurrection

**Simulated:** `POST /reconnect/offer` twice in a row for the same
`contactId` (offer A, then offer B — modeling "initiator gave up on A,
started a fresh attempt B"), then one `GET`; same pattern for
`/reconnect/answer`.

**Result:** the store key is a **singleton per `contactId`**
(`reconnect_${contactId}`) — the second `POST` structurally overwrites the
first via `Map.set`. A `GET` only ever returns the latest value; the older
one is unrecoverable, cannot resurface later. **Positive, directly-proven
invariant** — the exact "stale offer arrives after the initiator moved on"
scenario the task brief hypothesized cannot happen via this specific path,
by construction of the relay's storage model (single-slot-per-contact, not
a queue). This is stronger than the state-machine report's general treatment
of single-relay-process delete-on-fetch (§7), which addressed *double*
delivery, not staleness specifically.

### 5. `/packet` timestamp-key collision — a **new, previously-uncited**
### message-loss mechanism, distinct from the fixed delete-on-fetch issue

**Simulated two ways:**
1. **Deterministic, mirrored-logic reproduction** (same convention as the
   pre-existing TTL-sweep tests in `relay.http.test.js`, for a mechanism that
   depends on real-clock-tick timing): the relay's exact key formula,
   `` `packet_${recipient}_${Date.now()}` `` (`relay.js:512`), applied twice
   with the same fixed millisecond timestamp — the second `Map.set()`
   silently overwrites the first. Deterministic, always reproducible.
2. **Live empirical confirmation** against a real relay child process: 300
   truly-concurrent `POST /packet` calls to the same recipient, then one
   `GET`. Across three separate runs of the full suite: **29, 33, and 35 of
   300 messages were silently lost** to this exact collision (~10-12% loss
   rate under load on this machine/OS — not rare or theoretical).

**This is a genuinely new finding**, distinct from and *not* addressed by the
client-ack mechanism the concurrent session added this same pass — that
mechanism protects a packet **after** it's stored, against loss between
delivery and processing. This collision destroys a packet **before it is
ever stored**, at the moment a second `POST` in the same millisecond
overwrites the first `Map` entry. No ack/redelivery mechanism can help,
because the relay never had two entries to redeliver — one was never
created.

**Invariants:** #3 (message loss, the inverse of double-processing) — **yes,
concretely and empirically reproducible, not a low-probability theoretical
edge case**; #8 — this is a pure availability/message-loss bug, not a
confidentiality or integrity break (no plaintext exposure, no forged
acceptance — the message that "wins" the collision is itself a legitimately
sent, correctly authenticated ciphertext; only the *other*, equally
legitimate one silently vanishes).

### 6. Client-ack redelivery mechanism (new code, added by the concurrent
### session mid-pass) — chaos-tested for the first time here

**What it is:** `GET /packet/:recipient` now returns each packet with a
per-fetch `token` and marks the entry `pending` (not deleted) for
`PACKET_ACK_GRACE_MS` (default 20s, overridable via env for tests). Only an
explicit `POST /packet/ack {recipient, tokens}` actually deletes it. If no
ack arrives before the grace window expires, the packet becomes deliverable
again.

**Simulated (three tests, `PACKET_ACK_GRACE_MS` shortened to 200-300ms for
the test):**
- No ack ever sent → after the grace window, the **same** packet is
  delivered a **second time** with a **new** token (confirmed: this is
  by-design redelivery, not a bug — it is the direct trade-off the fix
  intentionally makes: message-loss risk traded for a bounded
  double-delivery risk).
- A timely ack fully and permanently prevents redelivery, even after the
  grace window elapses.
- A **stale ack** (using the token from the *first* delivery, arriving after
  a second delivery already issued a *new* token) acknowledges **0** entries
  and does **not** corrupt the currently-pending (unacknowledged) entry —
  confirms no cross-generation token confusion.

**This directly connects to Finding 2 in this report (below):** the new
mechanism's own designed failure mode — "client processed the message
successfully but crashed/lost network before its ack went out" — is now a
**real, demonstrated route to double delivery** at the relay layer. Whether
that becomes a **user-visible duplicate message** depends entirely on
whether anything on the client side deduplicates by content/msgId before
displaying — see the very next scenario, where the answer is proven to be
"no."

### 7. Duplicate/repeated messages at the relay layer and the client buffer

**Relay layer (real harness tests):**
- Two identical `POST /packet` calls (simulating a client retry after an
  ambiguous network response — "did my POST actually reach the relay?")
  create **two independent, both-deliverable store entries**. The relay does
  **not** deduplicate by ciphertext content, nonce, or any embedded ID.
- Two identical `/call/signal` `offer` POSTs create **two entries in the
  signals array**; a naive client that reacts to every array entry (e.g. one
  ring/PeerConnection-setup per entry) would double-process. `cancel`/`end`/
  `reject` do correctly flush the whole queue regardless of how many
  duplicates had accumulated (confirmed — no regression there).

**Client buffer layer (real production code, not mirrored — `RTCStore.js`
and `web/src/lib/RTCStore.ts` imported and exercised directly):**
- `RTCStore.setConnection()`'s internal `onMessage` handler
  (`RTCStore.js:131`, `RTCStore.ts:29`) pushes every delivered message
  straight into `this.buffer`/the active listener callback, **unconditionally**
  — confirmed by direct test: delivering the exact same decrypted message
  object twice (same `msgId`, same `text`, same `time`) results in **two**
  entries in the buffer, both with a live listener attached and without one.
  There is no msgId/content/timestamp-based dedup anywhere in this path, on
  *either* platform.

**Combined with Scenario 6**, this establishes a concrete, non-hypothetical
chain: relay-layer redelivery (by design, to fix message loss) → client-layer
buffer with zero dedup → **a message can visibly appear twice in the chat
UI** in the specific (bounded, rare) case where a client successfully
decrypts and buffers/displays a relay-fallback packet but then crashes or
loses network before its `/packet/ack` goes out.

**Invariants:** #3 — **yes, concretely proven reachable** (not merely
theoretical) via the combination above; #4/#1 — no, this does **not** allow a
forged or unauthenticated message through; every duplicate is a legitimately
authenticated ciphertext the real peer actually sent once — the failure is
purely about display/processing count, not authenticity. #8 — this is
explicitly a **broken-but-not-unsafe** state per the task's own priority
framing: annoying (a message shown twice), not a confidentiality/integrity
regression. For most message types this is harmless-if-ugly; the one place
duplicate processing would matter more is a *non-idempotent* side effect
triggered by message content (e.g. a queued disk write or a counter
increment keyed by message arrival, not by message identity) — none was
found in the reviewed paths; ordinary `text` messages, `image_complete`, and
`audio_complete` are all safe (if ugly) to show twice; `delete_chat`/
`secret_end`'s own idempotency was already established by code-reading in
`SECURITY_STATE_MACHINES.md` §10 and not independently re-tested here.

### 8. Contradictory role assignment — **new finding, not previously
### documented**, on `/phone/register` and `/phone/lookup`

**Simulated (real relay harness, black-box):**
- `/phone/register`: registered the same hash from `device_A` (→ responder,
  correctly), then `device_B` (→ initiator, correctly — this is the intended
  2-party flow). A **third** call from `device_C` for the *same hash*
  (modeling a client retry after a network timeout, or literally a third
  device that happens to know the same phone-number pair per
  `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 6's own finding that the
  rendezvous hash isn't secret against anyone who knows both numbers) **also
  gets `role:'initiator'`**, silently overwriting `entry.initiatorId` from
  `device_B` to `device_C`. Confirmed via the responder's own
  `/phone/pending` view: it only ever sees `device_C`, with **no signal to
  device_B that it was just displaced** — `device_B`, from its own already-
  received HTTP response, still believes itself to be the initiator.
- `/phone/lookup`: fired two truly-concurrent lookups (`Promise.all`, no
  sequencing) for the same pre-registered hash from `device_B` and
  `device_C` — **both got `{found:true, role:'initiator'}` in the same
  instant.** The handler sets `entry.initiatorId = chatId` and replies
  `role:'initiator'` to *every* caller that finds an existing entry, with no
  check for "has someone already claimed initiator." This is a direct,
  concretely-constructed instance of "the server tells two different devices
  they're both initiator for the same hash" — the exact scenario the task
  brief asked to try to construct, not just trust the code's own claim that
  it "shouldn't be possible."

**Invariants:** #6/#8 — this is a genuine protocol-state-machine bug (two
parties can simultaneously and validly believe they hold the same role in
the same pairing negotiation), but its actual security impact is bounded:
whichever device actually calls `createOffer()`/`createAnswer()` first and
successfully completes the ML-KEM handshake with the *other* party
determines who's really paired with whom — the "confused" third party simply
fails to connect or ends up in a dead/orphaned pairing attempt, it does not
gain plaintext access to a conversation it isn't cryptographically part of
(role confusion here is a rendezvous-protocol/connectivity bug, not a key-
exchange authentication bypass — the actual Kyber handshake that follows
still requires both sides to exchange real key material over the WebRTC
DataChannel they end up connected on). Categorized as **broken, not unsafe**
per the task's own priority framing, but worth fixing given how cheaply
reachable it is (a single extra retry or a second device with the same
phone-number knowledge).

### 9. Client crash mid-Kyber-exchange → two devices with divergent
### post-restart secrets (the flagship scenario the task named explicitly)

**Simulated (real production `WebRTCManager` code, both native and web,
real crypto):** two real `WebRTCManager` instances wired to each other via
manually-controlled fake DataChannels (same pattern as the existing
`stateMachine.keyExchangeDuplicate.test.js`), driven through a **complete,
genuine** Kyber handshake — real `generateKyberKeypair`/`kyberEncapsulate`/
`kyberDecapsulate` (native: via the bridge mock's Node-crypto-backed
`randomBytes`/`sha256`, matching the existing test infrastructure's own
documented boundary — the *actual* ML-KEM-768 op only runs on-device; web:
**real** `@noble/post-quantum` ML-KEM-768, no mocking needed).

After the handshake genuinely completes (`rtcInit.sharedSecret ===
rtcResp.sharedSecret`, confirmed), the persistence step — which in
production is an unawaited, fire-and-forget
`import('react-native-encrypted-storage').then(m => m.default.setItem(...))`
(native, `WebRTCManager.js:334-338`/`:364-370`) or `setItem(...).catch(()=>
{})` (web, `WebRTCManager.ts:270-272`/`:290-292`) — is modeled via two
independent per-device storage doubles (since the two "devices" in this test
are, correctly, two independent physical machines with independent disks;
a single shared mock module would incorrectly conflate them). The
responder's device write is modeled as completing; the initiator's device is
modeled as dying in exactly the unawaited window before its write ever
starts.

**Result, both platforms:** after "restart" (reload from each device's own
storage), **the initiator has no secret at all** (`null`) while **the
responder still has the real, correct secret** — a direct, concrete
demonstration of exactly the divergence `SECURITY_STATE_MACHINES.md` §4
Finding 11 described but had not yet reduced to a test. The practical
consequence was also verified, not just asserted: a message the responder
encrypts with its correct persisted secret **fails to decrypt** (`null`, not
a crash, not a wrong-but-accepted plaintext) on the initiator's reloaded
(nonexistent) secret.

**Structural invariant, additionally checked (source-text-level, both
files):** the specific "impossible state" the task asked about —
`keyExchangeDone=true` with `sharedSecret=null`, or vice versa — was checked
by locating, in both `WebRTCManager.js` and `WebRTCManager.ts`, the exact
`this.sharedSecret = ...` assignment inside each of the two Kyber handlers
and confirming via a source-text scan that no further `await` occurs between
the end of that assignment statement and the following
`this.keyExchangeDone = true` assignment. **Confirmed absent in both files,
both handlers** — a genuine mid-statement kill (literally between two
synchronous JS statements with no yield point) cannot be simulated under
Jest/Node (this is the one sub-part of this scenario that is not testable —
see below), but the *code path* that would need to exist for this invalid
combination to be reachable via any *normal* async interruption (a kill
between two `await`s, an unhandled promise rejection, a re-entrant call)
structurally does not exist.

**Invariants:** #2 — **yes, key state does become inconsistent across the
two peers** (this is the core finding), but not in the "impossible/invalid
single-instance state" sense — each individual device's own
`keyExchangeDone`/`sharedSecret` pair stays internally consistent; it's the
**pair of devices** that diverges. #4/#1 — no forged or plaintext-exposing
outcome: the failure mode is total, symmetric silence (neither side can read
the other without a fresh handshake), not a partial/confused decrypt. #5 —
no, an old/rotated key cannot become active again through this path; the
initiator simply has *no* key until the next successful reconnect, which
(per `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3, independently reconfirmed
structurally unchanged here) performs a fresh, independent Kyber exchange.
#8 — **broken, not unsafe**: this reproduces `SECURITY_STATE_MACHINES.md`'s
own framing precisely — a real, reachable, previously-undemonstrated bug,
but its effect is "conversation stops decrypting until the next reconnect,"
not any confidentiality or integrity compromise.

### 10. Corrupted local state — does every read site handle `JSON.parse`
### throwing?

**Native (`App.tsx`, code-reading across every `AsyncStorage.getItem
('contacts')` call site found, plus one live-code confirmation):**
checked all distinguishable call sites (`App.tsx:431-450` initial load,
`:466-469` `checkOutgoing`, `:596-600` `checkIncoming`, `:1529-1531`
`profile_avatar_received`, `:1666-1668` `handshake`) — **every one** wraps
its `JSON.parse` in a `try/catch` that fails gracefully (silently skips,
does not crash), a consistent, apparently-deliberate defensive pattern.
Screen-gated poll loops (`checkOutgoing`/`checkIncoming`, gated behind
`screen === 'home'`, itself gated behind PIN unlock) were **not** exercised
via a full `<App/>` render for cost reasons (see "not testable" section) —
their guard was confirmed by code-reading only, not by a live render.

**MessageCrypto (native + web, real code, real crypto):** fed genuinely
corrupted persisted-secret-shaped inputs — non-base64 garbage as a
"sharedSecret", a completely different (but validly-shaped) secret, and a
truncated ciphertext — to `encryptMsg`/`decryptMsg` directly. All three fail
closed (`null`), none throw uncaught. This closes the "what if a corrupted
`shared_secret_<id>` entry gets loaded and fed into the crypto layer"
question the task asked, at the crypto-primitive level.

**Web `Storage.ts` — first automated test coverage of this module at all**
(both crypto-claims and trust-privacy audits explicitly noted no test
exercised it directly). Three scenarios, real code, minimal in-memory
`localStorage`/`crypto.subtle` (Node 24 provides `crypto.subtle`/`btoa`/
`atob` globally — no polyfill needed for those) plus a mocked `RelayClient`
to isolate local-storage-corruption behavior from network state:

1. **Corrupted `MARKER_KEY`, intact `SALT_KEY`/`DEVICE_ID_KEY`:**
   `unlockEncryption()` does not crash, correctly falls through to
   `{ok:false, reason:'wrong_pin'}` (via `decryptRaw`'s own internal
   try/catch). **But it also calls `pepperFail()`** — i.e. **a user whose
   local storage is corrupted through no fault of their own burns one of
   their limited 5 attempts against the server-side wipe counter**,
   identically to an actual wrong PIN. Confirmed via mock call assertion.
   Robustness/annoyance finding, not a security one (fails closed, not
   open).
2. **`SALT_KEY` present, `MARKER_KEY` entirely absent** (the direct web
   analogue of the task's "partially-saved session" scenario — modeling a
   crash between the two `localStorage.setItem()` calls in
   `setupEncryption()`, lines 100-101): `unlockEncryption()` fails closed
   **immediately**, before any network round-trip (`pepperRequest` mock
   confirmed never called). Clean, safe, no wasted attempt.
3. **New finding — corrupted `SALT_KEY` (not valid base64):**
   `unlockEncryption()` does **not** return a structured `UnlockResult` —
   it **throws an uncaught exception** (confirmed: `await
   expect(Storage.unlockEncryption('1234')).rejects.toThrow()` passes).
   Root cause: `fromB64()` → `atob()` is called with no surrounding
   try/catch inside `unlockEncryption()` (`Storage.ts`, the
   `deriveKey(pin, pepperResult.pepper, fromB64(saltB64))` call), unlike
   the `MARKER_KEY` corruption case one line later, which *is* caught
   internally by `decryptRaw()`. **This is a genuine, previously-
   undocumented asymmetry**: two structurally similar corruption cases in
   the same function, one fails gracefully, the other crashes the caller.

**Web `App.tsx` — related, more user-impacting finding, found while tracing
where `getItem('contacts')` results get parsed on the web client (not
previously documented by any prior review):** `web/src/App.tsx:367`,
`const loadedContacts: Contact[] = JSON.parse(savedContacts);`, inside the
`onUnlock` async handler passed to `<LockScreen>` — **has no surrounding
try/catch**, unlike every equivalent native call site and unlike the web's
own `Storage.ts` `MARKER_KEY` handling. A corrupted `contacts` entry in
localStorage means **a user who enters the correct PIN** gets an uncaught
exception instead of reaching the home screen, because this line runs
*after* `unlockEncryption()` already succeeded. Verified present in the
current file (re-read immediately before writing this report, given the
concurrent-editing warning). Not patched directly (file under active
concurrent edit this session, per the task's own instruction to prefer
documenting over patching there) — flagged as a follow-up task instead (see
below) with a 3-5-line fix already scoped. The exact class of bug (unguarded
`atob`/`JSON.parse` on corrupted-but-app-written data) is proven reachable
by the adjacent, directly-testable `SALT_KEY` case in `Storage.ts` above.

**Invariants:** #7 — no plaintext reaches logs in any of these paths
(confirmed by reading each `catch`/`console.warn` call site touched — all
log either the corrupted-value's *existence*, an error object, or nothing
sensitive; no test's captured output contained plaintext message content).
#8 — every one of these is a **broken-but-not-unsafe** finding: corrupted
local state either fails closed cleanly, or (the two new asymmetry findings)
crashes a specific call path instead of failing closed cleanly — annoying/
buggy, never a confidentiality or integrity regression, since a thrown
exception before decryption succeeds is definitionally not an unsafe accept.

### 11. Malformed / unexpected live DataChannel messages

**Simulated (real `WebRTCManager`/`WebRTCManager.ts` code, both platforms):**
non-JSON payloads, valid-JSON-but-meaningless payloads (`{}`, `[1,2,3]`,
`null`), and — the more interesting case — a `kyber_ciphertext` message
arriving on a connection where `this.myKyberKeys` was **never set** (e.g. a
stray/replayed message on a connection that never actually sent a
`kyber_pubkey` as initiator, or state left over from a crash).

**Result:** all cases are caught by the handler's outer `try/catch`
(`WebRTCManager.js:458-460`/`.ts:330-332`); no test threw. The
`myKyberKeys`-null case is worth calling out specifically: without that
outer `try/catch`, `this.myKyberKeys.secretKey` would be a `TypeError` on
`null` — confirmed this is exactly what's thrown internally (visible in the
captured `console.warn('[WebRTC] Parse/Decrypt Fehler:', ...)` output during
the test run) and confirmed it's fully absorbed, not propagated. Key state
(`keyExchangeDone`/`sharedSecret`) remains unaffected by any of these inputs,
and — confirmed for the non-JSON case — the connection remains fully usable
afterward (a real, valid `kyber_pubkey` sent immediately after still
completes the handshake normally).

**Invariants:** #8 — pure robustness, no security implication; confirms the
outer `try/catch` around the whole `channel.onmessage` body is doing real,
necessary work, not just decorative.

---

## Not testable under Jest — what a manual/on-device test would need

- **True OS-level app-kill mid-syscall / mid-statement.** Jest/Node cannot
  interrupt a running JS statement mid-execution the way an OS `SIGKILL`
  can interrupt a native process at an arbitrary instruction. Where this
  mattered (the `sharedSecret`/`keyExchangeDone` "impossible state"
  question), it was instead addressed by (a) proving via source-text
  analysis that no `await` — i.e. no point where the JS engine could yield
  to another task — exists between the two relevant assignments, and (b)
  simulating the *reachable* approximation of a crash (death in the
  unawaited disk-write gap, which genuinely is a yield point) directly. A
  device test would need: pair two real devices, force-kill the app (`adb
  shell am kill` or a native crash trigger) at the moment `console.log
  ('[Crypto] ✅ Shared Secret gesetzt...')` fires (a natural breakpoint
  target), then inspect `EncryptedStorage`'s on-disk file to confirm whether
  the write landed, and attempt a subsequent conversation from both devices.
- **Real network-identity switch (WiFi↔cellular) triggering `NetInfo`.**
  `RelayClient.js`'s `startWakeSocket()` wires `NetInfo.addEventListener`
  to `_connectWakeSocket()`, which is idempotent by construction (a
  synchronous `readyState` guard, `RelayClient.js:207` — confirmed by
  code-reading, not by a live NetInfo/OS network-switch simulation, since
  Jest's NetInfo mock only allows manually invoking the registered callback,
  not simulating an actual interface change with the accompanying socket-
  level effects). A device test would need two real network interfaces (WiFi
  AP + cellular data) and toggling between them mid-reconnect-attempt while
  watching `adb logcat` for `[WebRTC]`/`[Crypto]` log lines, ideally with a
  packet-capture to confirm no double `RTCPeerConnection`/`WebSocket` is
  left dangling.
- **checkOutgoing/checkIncoming poll-pileup against a genuinely slow (not
  dead) relay.** Reaching these loops requires `screen === 'home'`, itself
  reachable only after the PIN-unlock UI flow — simulating that via
  `react-test-renderer` (finding the PIN pad, simulating N taps, handling
  the biometric-prompt branch) was judged too costly for this pass relative
  to the value (the finding was already extractable by code-reading with
  high confidence — no per-cycle mutex exists at the poll level, only at the
  per-contact connection-attempt level). A device/manual test would need: a
  relay configured to accept connections but never respond (e.g. an
  `iptables`/firewall rule that accepts but never `ACK`s past the TCP
  handshake, or a proxy that holds connections open), watch memory/socket
  count over an extended period (minutes, since the interval is 15s/10s) to
  confirm bounded vs. unbounded growth.
- **web `App.tsx` unlock-flow render.** Confirming the `JSON.parse` finding
  at `web/src/App.tsx:367` via an actual rendered `<App/>` (rather than the
  adjacent, directly-testable `Storage.ts` `SALT_KEY` case, which proves the
  identical class of bug) was judged out of scope — this project's Jest
  config targets the RN app; the web client has no equivalent jsdom-based
  component test harness set up in this repo, and standing one up was
  judged too large an infrastructure addition for a single finding already
  well-evidenced by code-reading plus the analogous `Storage.ts` test.
- **Native `EncryptedSharedPreferences` fail-open-to-plaintext path**
  (already flagged as untestable in `SECURITY_AUDIT_CRYPTO_CLAIMS.md`) —
  same reasoning applies here: forcing a real Android Keystore failure isn't
  reachable outside a real/emulated device with a deliberately corrupted
  Keystore entry.
- **Genuine multi-machine clock skew / TURN-relay packet reordering.**
  This pass's "out-of-order ICE candidates" question (does the client
  process `answer` before `offer` due to a poll-then-dispatch race) could
  not be exercised without a real two-device WebRTC session across a real
  network path with induced reordering (e.g. `tc netem` packet reordering
  on a Linux TURN box) — the relay itself was confirmed (Scenario 4 above)
  to preserve insertion order faithfully for `/call/signal`'s array, but
  whether a real client's poll-then-dispatch loop could still process
  entries out of the order *within* one already-ordered array is a client-
  UI-loop question not reachable without full `<App/>` rendering plus a
  real two-party call flow.

---

## Prioritized findings

Ordered per the task's explicit instruction: **real
confidentiality/integrity/authentication-breaking findings first**,
connectivity/robustness annoyances last. **Headline result: no scenario
constructed in this pass broke confidentiality, integrity, or authenticity.**
Every failure mode found bottoms out in one of: message loss, duplicate
display, role/state confusion that self-resolves at the cryptographic layer,
or an uncaught exception on a corrupted-but-still-locally-read-only value.
That is a materially better result than the state-machine pass's own
flagged severity-1 finding (the kyber_pubkey/kyber_ciphertext replay
re-keying bug), which *was* fixed prior to this pass and was re-confirmed
still fixed (the duplicate-kyber tests remain part of the suite and still
pass).

### Confidentiality/Integrity/Authentication-adjacent (none found broken — listed for completeness of the invariant check, not because any were violated)

None. Every scenario in this pass that touched key material, decryption, or
message authenticity resolved to a **fail-closed** outcome (`null`, a
dropped/ignored message, an uncaught-but-locally-scoped exception) rather
than a forged-acceptance, plaintext-exposure, or wrong-key-accepted outcome.
This was verified concretely, not assumed — see Scenarios 5/6/7/9/10/11
above, each of which explicitly checked for silent-accept/plaintext-leak
outcomes and found none.

### Real, reachable bugs — message loss / duplication / role confusion (broken, not unsafe)

1. **`/packet` store-key millisecond collision silently drops messages
   under concurrent load** (Scenario 5). New finding, not previously
   documented, empirically reproduced at a ~10-12% loss rate under 300
   concurrent sends on this machine — not a rare theoretical edge case.
   Distinct from, and unaddressed by, the concurrent session's new
   client-ack mechanism (that mechanism protects an already-stored packet;
   this bug prevents the packet from being stored at all). Fix would be
   narrow (append a per-request random suffix or counter to the store key,
   or switch to `crypto.randomBytes` for the token component like several
   other relay.js endpoints already do) but touches the core `/packet`
   storage key format relay.js is actively being edited around this
   session — deliberately not patched here per this task's own instruction
   to prefer documenting over touching files under concurrent edit.
2. **New client-ack redelivery mechanism (added this session) reintroduces
   a bounded double-delivery window, which the client has zero defense
   against** (Scenarios 6+7 combined). The relay-layer redelivery-on-
   missing-ack is itself correct and working as designed (verified). The
   gap is downstream: `RTCStore.js`/`RTCStore.ts`'s message-buffering path
   has no msgId/content dedup at all (confirmed by direct production-code
   test on both platforms), so the one failure mode the new ack mechanism
   is *designed* to produce (client processed a message, then died before
   acking) is a **real, demonstrated route to a visibly duplicated chat
   message**. Not fixed here (client-side dedup, likely keyed on the
   existing `msgId` field already present on `text` messages, is a
   reasonable, fairly contained fix, but touches the same `RTCStore`
   message-push path shared by every message type/platform and deserves
   its own scoped pass rather than a blind addition during a testing-
   focused session).
3. **`/phone/register`/`/phone/lookup` can tell more than one device it is
   the "initiator" for the same rendezvous hash** (Scenario 8). New
   finding. Concretely constructed (not just theorized) for both endpoints,
   including under true request concurrency. Bounded impact — role
   confusion at the rendezvous layer, not a key-exchange authentication
   bypass, and self-resolves once the real Kyber handshake either succeeds
   with one peer or times out with the others — but cheaply reachable (a
   single retried request, or a legitimate second device that happens to
   know the same phone-number pair, already an acknowledged limit of this
   feature per `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 6). Fix would
   need a "has this hash already been claimed by a different initiator"
   check in both handlers — small, but touches the same rendezvous flow
   worth a dedicated look rather than a blind patch here.
4. **App-kill mid-Kyber-handshake leaves two paired devices with genuinely
   divergent key state after restart** (Scenario 9). This is the flagship
   scenario the task named explicitly, now backed by a concrete,
   passing, real-crypto reproduction on both platforms (previously
   described but not reduced to a test in `SECURITY_STATE_MACHINES.md`
   §4 Finding 11). Self-heals on the next successful reconnect (fresh
   Kyber exchange, per `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3,
   structurally reconfirmed unchanged here) — the cost is a silent,
   unexplained "nothing decrypts" window for the affected pairing until
   that happens, with no user-facing signal of why (same UX gap already
   noted for the related restart-timing finding in
   `SECURITY_STATE_MACHINES.md` §4). Not fixed here (the actual fix —
   awaiting the persistence write, or at least not treating the key
   exchange as "done" for UI purposes until it lands — touches the shared,
   currently-being-edited `WebRTCManager.js`/`.ts` core path).

### Robustness / annoyance-tier (lower priority per this task's own framing)

5. **Web `Storage.ts`: corrupted `SALT_KEY` crashes `unlockEncryption()`
   with an uncaught exception instead of a structured `UnlockResult`**,
   asymmetric with the adjacent `MARKER_KEY` corruption case one line later
   which *is* caught gracefully (Scenario 10). First-ever automated test
   coverage of this module; genuinely new finding.
6. **Web `App.tsx:367`: `JSON.parse(savedContacts)` inside the PIN-unlock
   success handler has no try/catch**, unlike every native equivalent
   call site (Scenario 10). A user with a correct PIN but corrupted local
   contact data gets stuck instead of reaching `home`. **Flagged as a
   follow-up task** (`task_a8f5b5d2`, "Guard JSON.parse(savedContacts) in
   web onUnlock") rather than patched directly, since `web/src/App.tsx`
   is under active concurrent edit this session — the fix is a small,
   well-scoped 3-5 line try/catch, but touching that file right now risks
   colliding with the concurrent sequence-aware-replay/device-wipe-
   notification/send-status work happening in the same file.
7. **Web `Storage.ts`: corrupted `MARKER_KEY` burns a real PIN-fail attempt
   against the server-side 5-attempt wipe counter**, even though the cause
   wasn't a wrong PIN (Scenario 10). Low severity (fails closed, doesn't
   expose anything), but a user could plausibly get wiped by storage
   corruption alone, compounding an already-bad day.
8. **`checkOutgoing`/`checkIncoming` poll loops have no per-cycle "already in
   flight" guard**, only a per-contact connection-attempt guard
   (code-reading finding, Scenario 3 — not independently render-tested,
   see "not testable" section). Plausible but unconfirmed pile-up of
   concurrent `fetch` calls against a slow-but-alive relay; self-bounded,
   no crash risk identified.

---

## Files touched/added

- `__tests__/security/chaos.relayNetworkFailures.test.js` (new)
- `__tests__/security/chaos.duplicateMessages.test.js` (new)
- `__tests__/security/chaos.corruptedState.test.js` (new)
- `__tests__/security/chaos.keyStateRace.test.js` (new)
- `SECURITY_CHAOS_TESTING.md` (this file, new)

No production files were modified in this pass, per its own instruction to
default to documenting/testing over patching given the concurrent editing in
progress on `App.tsx`, `web/src/App.tsx`, `relay.js`, `web/src/lib/
Storage.ts`, `RTCStore.js`/`.ts`, and `WebRTCManager.js`/`.ts`. One follow-up
task was queued (`task_a8f5b5d2`) for the single trivial, low-collision-risk
fix identified (web `App.tsx:367`'s unguarded `JSON.parse`).
