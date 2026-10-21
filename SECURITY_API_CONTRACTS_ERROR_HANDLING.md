# API Contracts & Error-Handling Architecture Review — SecureCommApp ("Malachi")

**Scope of this pass:** the two merged requests from the task brief — (1) a
contract-level audit of every client-server and internal-module API boundary
(native `App.tsx` ↔ `relay.js`, web `App.tsx` ↔ `relay.js`, and the clients'
own `App.tsx` ↔ `WebRTCManager` ↔ `RTCStore` boundaries), and (2) an
error-handling architecture audit (swallowed exceptions, wrong fallbacks,
inconsistent handling of the same problem, wrong codes, info/secret leaks,
fail-open-on-crypto-error). Prior documents are treated as ground truth and
**not re-derived**: `SECURITY_FUZZING_CAMPAIGN.md` §5/§6/§10 already covers
`/pepper/register` deviceId type confusion, unvalidated relay-response shapes,
and JSON duplicate-key handling; `SECURITY_CHAOS_TESTING.md`/
`SECURITY_CHAOS_FOLLOWUP_FIXES.md` already cover HTTP malformed-body handling,
poll-cycle guards, and the `/phone/register`/`/phone/lookup` role-confusion
fix. This pass's job was the **contract-level** analysis those passes didn't
do: versioning, error-shape consistency, idempotency-by-design, nullability
contracts, and a fresh sweep of error-handling call sites for the fail-open
invariant specifically.

**Concurrent editing note:** two other sessions were active during this pass
(a hidden-bug/cross-component hunt and a dedicated concurrency/race-condition
review), both editing `WebRTCManager.js`/`.ts`, `App.tsx`, and other shared
files live. Several findings this pass would otherwise have flagged as open
(`/pepper/register` deviceId type confusion, the `RelayClient` unvalidated
server-response shapes from the fuzzing report, the three `new Array(total)`
chunk-buffer bugs, a cross-store replay-protection storage mismatch in
`isNewerThanLastAcceptedSystemTs`) were found **already fixed** by the time
this pass reached them — confirmed by re-reading each file fresh immediately
before drawing a conclusion, not assumed from the older reports. Those are
noted below as "confirmed already fixed," not re-claimed as this pass's work.
No fix in this pass touches a section that showed signs of concurrent
in-progress editing (e.g. a `if (false && this._closed)` scaffold seen mid-work
in `WebRTCManager.js` was left untouched — clearly another session's
in-flight guard, not final state).

---

## Part 1 — API Contract Findings

| # | Contract issue | Where | Status |
|---|---|---|---|
| 1 | Four structurally identical "singleton slot, GET-by-key" endpoints (`/reconnect/offer`, `/reconnect/answer`, `/signal/offer`, `/signal/answer`) used **three different conventions** for "not found": only `/reconnect/offer` returned 404; the other three returned 200 with a null field. An existing test (`relay.http.test.js`) even asserted the 200-for-three/404-for-one split as if intentional, with no comment explaining the asymmetry. | `relay.js` GET handlers | **Fixed** — all four now return 404 consistently. Confirmed no client branches on status for these routes (only the payload field itself, via `typeof data.offer === 'string'`), so this is a pure contract-consistency fix, zero behavior change for any real caller. Tests updated + one new test added (`/signal/offer` not-found case, previously untested at all). |
| 2 | Malformed-input/parse-failure responses across ~24 `relay.js` catch blocks used **two different shapes**: some returned `{error: '<message>'}`, most returned a bare `{}` with no `error` field, for the same underlying "reject this request" semantic. | `relay.js`, every `catch { res.writeHead(400); res.end('{}'); }` site | **Fixed** — unified to `{error: 'ungueltige_anfrage'}`. Status codes unchanged; only the previously-empty error bodies gained a field. Confirmed no test asserted the old bare-`{}` shape for any of these (only for genuine "not found" 404s, which were deliberately left untouched — see below). |
| 3 | `/transfer/:token` GET-not-found (404, bare `{}`) was **not** touched — this is a genuinely different semantic ("resource doesn't exist") from "malformed request," and an existing test (`relay.http.test.js`) asserts the exact `{}` body. | `relay.js` `/transfer/` GET | **Documented as intentionally out of scope** — changing it would be scope creep against a passing, semantically-distinct test, not a contract bug. |
| 4 | `pepperRegister()` (web `RelayClient.ts`) collapsed **two unrelated failure causes** — a genuine network failure and a `409 already registered` — into the same `null` return value. `Storage.ts`'s `setupEncryption()` then always threw the same "Relay nicht erreichbar" message regardless of cause. Concretely reachable: `/pepper/register` is **not safely retryable** — if a first registration succeeds server-side but its response is lost (network drop, tab killed), the client's persisted `deviceId` causes every retry to hit the 409 branch, which was misreported as "relay unreachable," sending a user/support down the wrong debugging path entirely and giving no indication of the real, permanent lockout (there is no `/pepper/register`-equivalent "fetch my existing pepper" recovery path, by design — extending the protocol for that was judged out of scope per the "no new protocol design" constraint). | `web/src/lib/RelayClient.ts` `pepperRegister()`, `web/src/lib/Storage.ts` `setupEncryption()`, `web/src/App.tsx` `onUnlock` | **Fixed** — `pepperRegister()` now returns a discriminated `{ok:true,pepper} \| {ok:false,reason:'conflict'\|'network'}` result (same pattern already established by `pepperRequest()`'s `PepperRequestResult`). `setupEncryption()` throws a distinct, accurate message per cause. `web/src/App.tsx`'s `onUnlock` catch block (which previously **discarded** the thrown error entirely and always displayed one hardcoded string, regardless of cause — an overly-broad catch masking any downstream fix) now surfaces the actual message. 9 regression tests added/passing in `stateMachine.storageUnlockRace.test.js`. |
| 5 | `sendSignalOffer`/`sendSignalAnswer`/`sendReconnectOffer`/`sendReconnectAnswer` (both `RelayClient.js` and `.ts`) returned `true` as soon as `fetch()` itself didn't throw — **never checking `res.ok`** — while the sibling functions `sendPacket`/`sendCallSignal`/`sendTransferChunk`/`registerPushToken` in the same files already do check `res.ok`. A genuine 4xx/5xx from the relay (e.g. a malformed body due to a client bug) was silently reported as success. Inconsistent error handling for the identical underlying operation ("did my POST to the relay succeed?") across call sites in the same file. | `RelayClient.js` + `web/src/lib/RelayClient.ts`, 4 functions each (8 total) | **Fixed** — all 8 now `return res.ok`. Confirmed via grep that no current caller in `App.tsx`/`web/src/App.tsx` branches on the return value (all fire-and-forget or ignored), so this is a pure truthfulness improvement with zero behavior change today; it only starts to matter (correctly) if a caller is later written to check the result. 8 regression tests added in `fuzz.serverResponseParsing.test.js` (4 native + 4 web), each proving both the fixed 4xx-returns-false case and the unchanged 200-returns-true case. |
| 6 | **Confirmed already fixed by a concurrent session:** `RelayClient.js`/`.ts`'s `get*`/`poll*` functions (`getSignalOffer`, `getReconnectOffer`, `receiveFromRelay`/`getPackets`, `pollCallSignals`) previously used bare `data.field \|\| default` with no shape validation (per `SECURITY_FUZZING_CAMPAIGN.md` §6's suggested-but-not-applied fix). Re-read fresh: both files now use `typeof data.offer === 'string' ? ... : null` / `Array.isArray(data.packets) ? ... : []` throughout. | `RelayClient.js`, `web/src/lib/RelayClient.ts` | Already fixed (not this pass's work) — verified current, not re-applied. |
| 7 | **Confirmed already fixed by a concurrent session:** `/pepper/register`'s `deviceId.length < 16` type-confusion bug (`undefined < 16 === false` for non-string truthy values) from `SECURITY_FUZZING_CAMPAIGN.md` §5. Re-read fresh: `relay.js` now does `typeof deviceId !== 'string' \|\| deviceId.length < 16`. | `relay.js` `/pepper/register` | Already fixed (not this pass's work) — verified current. |
| 8 | **Confirmed already fixed by a concurrent session:** the `new Array(msg.total)` chunk-buffer crash/silent-corruption bugs (Bugs 7a/7b from `SECURITY_FUZZING_CAMPAIGN.md` §7), duplicated across `ImageCrypto.js`, `AudioCrypto.js`, `RTCStore.js` (2 inline copies), and `App.tsx`'s avatar-chunk inline copy (5 sites total). Re-read fresh: all 5 now validate `Number.isInteger(total)`, bounds, a `MAX_CHUNKS` cap, and count `received` only on first-fill-per-index. | `ImageCrypto.js`, `AudioCrypto.js`, `RTCStore.js`, `App.tsx` | Already fixed (not this pass's work) — verified current. |
| 9 | **Versioning — confirmed, not a gap requiring a fix.** `relay.js`'s `/status` endpoint returns a `version: '1.0'` field, but grepped every caller of `relayStatus()` (`RelayClient.js`) across the whole repo: it is called only from fuzz tests, never from any production code path in either `App.tsx`. **There is no version negotiation mechanism anywhere in this protocol.** Per the task's own explicit ask ("what does that concretely mean for a user with an old client talking to a new relay owner's updated server"): because every response-consuming call site already defaults defensively (`typeof`/`Array.isArray` checks feeding `null`/`[]`, per finding #6 above) rather than assuming a shape, an **additive** relay change (new optional field) is silently forward-compatible with old clients today, and a **breaking** relay change (renamed/removed field) degrades to "feature silently stops working" (e.g. no messages arrive) rather than a crash — consistent with this app's established fail-closed-but-silent posture elsewhere. Building an explicit version-check/negotiation handshake for a single-operator, self-hosted, hobby-scale relay (where the relay owner and the client's user are typically the same person, per the architecture docs) would be over-engineering relative to the actual risk; the honest, minimal conclusion is **documented, not built**. |
| 10 | **Pagination — confirmed N/A**, not assumed. Every list-returning relay endpoint (`/packet/:recipient`, `/call/signal/:contactId/:direction`) returns its full, unpaginated result set in one response; no `limit`/`offset`/`cursor` parameter exists anywhere in `relay.js`. Given the in-RAM, single-recipient, TTL-bounded store design, an unbounded list is not a realistic scale risk here (confirmed via the existing chunk/transfer-count caps already in place for the one endpoint class that could grow large). No action needed. |
| 11 | Authentication/authorization model: confirmed unchanged from prior audits — there are no bearer tokens on `/packet`, `/reconnect/*`, `/signal/*`; knowledge of a routing ID (`contactId`/token) is the sole "capability." This is an already-documented, accepted architectural property (`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §1.1–§1.4), re-confirmed here from the contract angle rather than re-litigated. |

---

## Part 2 — Error-Handling Architecture Findings

### The fails-open-on-crypto-error invariant — held everywhere checked

This was the task's explicitly highest-priority question. Checked, this
pass, by direct source reading (not re-deriving prior fuzzing/chaos proofs of
`MessageCrypto`/`HybridCrypto` themselves, which are already exhaustively
PROVEN fail-closed in `SECURITY_FUZZING_CAMPAIGN.md`/`SECURITY_AUDIT_CRYPTO_CLAIMS.md`):

- **Every** `decryptMsg(...)` call site in native `App.tsx` (10 call sites:
  offline-queue replay, relay-fallback receive, transfer-chunk reassembly,
  reconnect offer/answer, phone-connect offer/answer, QR-connect
  offer/answer) checks the return value for falsy and **returns/continues/
  drops** on failure — never proceeds to treat a `null` decrypt result as a
  valid message or a valid handshake step. Confirmed via direct grep +
  read of all matches, not sampled.
- Same confirmed for **every** `decryptMsg(...)` call site in
  `web/src/App.tsx` (5 call sites).
- `WebRTCManager.js`'s live-DataChannel `onmessage` handler: a `decryptMsg`
  failure (`plaintext` falsy) skips the entire message-processing block with
  no call to `onMessage?.()` — the message is dropped, not treated as
  received. The handler's outer `try/catch` only logs and drops; no code
  path inside the catch calls `onMessage` or otherwise treats a
  parse/decrypt exception as a delivered message.
- `kyber_pubkey`/`kyber_ciphertext` handlers: `kyberEncapsulate`/
  `kyberDecapsulate` failures propagate as exceptions caught by the same
  outer `try/catch` — `this.sharedSecret`/`this.keyExchangeDone` are only
  ever assigned **after** a successful KEM operation, never inside a catch
  branch, so a failed handshake step cannot leave the connection believing
  it has a (wrong or absent) secret marked as ready.
- **Verdict: no counterexample found anywhere checked in this pass.** A
  decrypt/verify/KEM failure never results in a message being delivered,
  a handshake being marked complete, or any downstream code treating the
  failure as success. This matches and extends (does not merely repeat)
  every prior pass's conclusion on this specific invariant.

### Findings fixed this pass

1. **Overly-broad catch block discarding a specific, actionable error
   message** (`web/src/App.tsx`'s `onUnlock` first-time-setup branch) — see
   Part 1 finding #4. This is the clearest "wrong fallback" instance found:
   the catch block ran `catch { return '<hardcoded string>'; }`, discarding
   whatever `setupEncryption()` actually threw, for every possible failure
   cause. Fixed to surface the real message.
2. **Two error-logging sites in `ImageCrypto.js`/`AudioCrypto.js` missed by
   the prior secrets-lifecycle cleanup pass** (`SECURITY_SECRETS_LIFECYCLE_FIXES.md`
   Fix 8 sanitized the *live-send* catch blocks in both files to
   `e?.message || e`, but not the *offline-send* catch blocks
   `sendEncryptedImageOffline`/`sendEncryptedAudioOffline`, which still
   logged `e.message, e.stack` — a full stack trace, unlike every sibling
   catch block in the same files). Fixed to match the established
   convention (message only, no stack).
3. **Native/web asymmetry in the same sanitization**: `MessageCrypto.js`
   (native) had its encrypt/decrypt failure logs sanitized to message-only
   by the same prior pass; `web/src/lib/MessageCrypto.ts` — the direct web
   equivalent of the exact same two catch blocks — was never touched and
   still logged the raw `Error` object. Fixed for parity.
4. **Same class, one more site**: `WebRTCManager.js`/`.ts`'s Kyber-handshake-
   initiation catch block (`[Crypto] Key Exchange fehlgeschlagen:`) also
   logged the raw error object on both platforms; brought in line with the
   same convention as a narrow, isolated, one-line-per-file change.
5. **Inconsistent error-shape/status-code handling for the same
   underlying operation** — see Part 1 findings #1, #2, #5. These are
   error-handling-architecture issues as much as API-contract issues: the
   same intended semantic ("did this succeed?") was implemented
   inconsistently across sibling functions/endpoints for no documented
   reason. Unified per the existing (already-correct-elsewhere) convention
   in each case, rather than inventing a new one.

### Findings checked and confirmed NOT a problem (stated for completeness, not padding)

- **Retry storms**: poll-loop "already in flight" guards (`checkOutgoing`/
  `checkIncoming`/`checkOfflinePackets`) were already fixed by
  `SECURITY_CHAOS_FOLLOWUP_FIXES.md` Fix 4 — re-confirmed present and
  correctly placed (guard-check before the first network call, reset in a
  `finally`) by re-reading the current file state, not re-fixed.
- **TURN-credential fetch**: already cached client-side (5 min) and rate-
  bounded by its own 6h server-side TTL; no retry-storm risk found.
- **Wake-socket reconnect**: exponential backoff with jitter already
  implemented (`_wakeReconnectDelay`, capped at 30s) on both platforms — no
  unbounded reconnect-spam risk found.
- **Loose equality / type-coercion bugs in auth-adjacent comparisons**:
  grepped `relay.js` for any `==`/`!=` (non-strict); none found — every
  comparison in the file (including all the token/attemptToken checks) uses
  strict `===`/`!==`. No coercion-based bypass risk found.
- **Idempotency of `/packet/ack`, `/phone/register` (post-fix),
  `/reconnect/*` singleton stores**: re-confirmed idempotent-by-construction
  (Map-keyed singleton slots, delete-then-miss on re-ack) by direct reading;
  no new gap found beyond what `SECURITY_CHAOS_TESTING.md`/
  `SECURITY_CHAOS_FOLLOWUP_FIXES.md` already established.
- **Information leaks in error responses to the network**: every
  `relay.js` error body was checked for anything beyond a short, generic
  German status string (`ungueltige_anfrage`, `unbekannt`, `gesperrt`,
  `versuch_laeuft_noch`, `bereits registriert`, `already_claimed`) — no
  stack traces, no internal paths, no echoed secrets found in any HTTP
  response body. The `.stack`-logging findings above are **local
  console/device-log** issues, not network-transmitted leaks.
- **CallManager.js**: has no cryptographic verification step of its own
  (by design — call signaling rides the already-established, DTLS-secured
  DataChannel/relay-signal path with no additional auth layer); no
  fail-open-adjacent error handling found because there is no
  security-relevant check in this file to fail open on.

---

## Verification

- `node --check relay.js` — clean.
- `npx jest __tests__/security/relay.http.test.js __tests__/security/chaos.relayNetworkFailures.test.js __tests__/security/fuzz.relayApiInput.test.js --runInBand` — **70/70 passed** (targeted run immediately after the relay.js edits).
- `npx jest __tests__/security/stateMachine.storageUnlockRace.test.js` — **9/9 passed** (includes the 3 new pepperRegister-classification regression tests).
- `npx jest __tests__/security/fuzz.serverResponseParsing.test.js` — **33/33 passed** (includes the 8 new `res.ok` regression tests).
- Full `npx jest`, run repeatedly as the two concurrent sessions kept
  landing changes: **296/296 of this codebase's own tests passed** in every
  run. Two categories of unrelated failures were observed at different
  points, both outside this pass's scope:
  - `__tests__/security/concurrency.rtcCloseRaces.test.js` — an
    **untracked, in-progress file being written live by the concurrency-
    review session** (confirmed via `git status`). Early in this pass it
    failed to even load (`require('@react-native-async-storage/async-storage')`
    module-resolution error); later, once that session fixed its own mock,
    it loaded but had 2 failing tests whose failure messages
    (`// DER FIX`, asserting a fix that session was mid-implementing in
    `RTCStore.clearContact()`/`WebRTCManager.close()`) make clear they are
    that session's own not-yet-complete work, not a regression from
    anything this pass touched (this pass never edited `clearContact`,
    `close()`, or `onMessage`-nulling logic).
  - The previously-documented `relay.js - Body-Groessenlimit` ECONNRESET
    flake **did** reproduce once during a full-parallel-suite run in this
    pass. Re-run in isolation (`npx jest relay.http.test.js -t
    "Body-Groessenlimit" --runInBand`): **2/2 passed cleanly**, confirming
    it is exactly the known, accepted, load-dependent flake per
    `SECURITY_STATE_MACHINES.md`/`SECURITY_CHAOS_TESTING.md`, not a
    regression from this pass's edits.
- `cd web && npx tsc --noEmit` — clean, zero errors (run twice, after the
  `RelayClient.ts`/`Storage.ts`/`MessageCrypto.ts`/`WebRTCManager.ts`
  edits and again after the concurrent session's own edits to
  `WebRTCManager.ts` landed).

## Files changed

- `relay.js` — 404/200 consistency fix (3 handlers), error-shape unification (24 catch blocks).
- `RelayClient.js`, `web/src/lib/RelayClient.ts` — `res.ok` fix (4 functions each); `pepperRegister` discriminated result (web only, native has no equivalent function).
- `web/src/lib/Storage.ts` — `setupEncryption()` error classification.
- `web/src/App.tsx` — `onUnlock` catch block now surfaces the real error message.
- `ImageCrypto.js`, `AudioCrypto.js` — sanitized the two offline-send catch blocks missed by the prior secrets-lifecycle pass.
- `web/src/lib/MessageCrypto.ts` — sanitized both catch blocks (native parity).
- `WebRTCManager.js`, `web/src/lib/WebRTCManager.ts` — sanitized the Kyber-handshake-initiation catch block.
- `__tests__/security/relay.http.test.js` — updated 2 stale assertions, added 1 new test for the 404 unification.
- `__tests__/security/stateMachine.storageUnlockRace.test.js` — updated 5 mock shapes, added 3 new regression tests.
- `__tests__/security/fuzz.serverResponseParsing.test.js` — added 8 new regression tests.

No git commit was made — all changes are left in the working tree for review, per instructions.
