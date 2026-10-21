# Fuzzing Campaign — SecureCommApp ("Malachi")

**Scope of this pass:** the first fuzzing-specific pass this session, following
`SECURITY_REVIEW_1`–`6`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`,
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`, `SECURITY_STATE_MACHINES.md`, and
`SECURITY_CHAOS_TESTING.md`. Those documents are treated as context, not
re-derived. This pass builds **real, automated, seeded/deterministic fuzzing
infrastructure** under `__tests__/security/` using
[`fast-check`](https://github.com/dubzzz/fast-check) (newly added as a
devDependency — see `package.json`/`package-lock.json` diff, not committed)
for property-based fuzzing with built-in shrinking, plus hand-written
generators for domain-specific byte-level mutations where that fit better
(base64 truncation points, raw JSON literal construction for `Infinity`).

**Note on timing:** this codebase was under active, concurrent revision while
this pass ran (`relay.js`, `WebRTCManager.js`/`.ts`, `RTCStore.js`/`.ts`,
`Storage.ts`, `App.tsx`, `web/src/App.tsx`, `ImageCrypto.js`, `AudioCrypto.js`,
`MessageCrypto.js` per the task brief). All line-number citations below were
re-derived from the files as read during this pass; no fix was applied to any
of those actively-edited files except where explicitly noted as a narrow,
low-risk, non-colliding addition (none were applied to production code in
this pass — see "Fixes applied" below, which is empty by design).

**Safety constraint honored:** every HTTP-level fuzz test runs exclusively
against a local `relay.js` child process spawned via the existing
`__tests__/security/helpers/relayHarness.js`. No fuzzed input was ever sent to
`https://malachii.duckdns.org` or any other real network endpoint. Crypto/
protocol-level fuzzing calls `MessageCrypto`/`HybridCrypto`/`WebRTCManager`
functions directly, in-process.

**New devDependency:** `fast-check@^4.10.2` (see `package.json`). This is a
test-tooling addition (the standard, audited property-based testing library
for JS/TS, MIT-licensed, no runtime footprint in the shipped app — devDependency
only), not a home-grown crypto/fuzzing primitive. Not committed, per the task
instruction — left in the working tree for review along with the
`package-lock.json` diff.

---

## Methodology

Six new test files, one per natural grouping of the ten priority targets in
the task brief (some priorities share a file where the underlying code is
shared):

| File | Tests | Runtime (isolated) | Priorities covered |
|---|---:|---:|---|
| `fuzz.messageCrypto.test.js` | 14 | ~2.4s | 1 (Ciphertext Parser), 8 (Serialization — Unicode round-trip) |
| `fuzz.keyMaterial.test.js` | 7 | ~1.2s | 4 (Key Material) |
| `fuzz.protocolMessages.test.js` | 6 | ~0.8s | 2 (Message Parser), 3 (Protocol Messages) |
| `fuzz.attachmentMetadata.test.js` | 8 | ~0.9s | 7 (Attachment Metadata) |
| `fuzz.relayApiInput.test.js` | 16 | ~4–6s | 5 (Authentication Messages), 10 (API Input), 3 (protocol `type` field on `/call/signal`) |
| `fuzz.serverResponseParsing.test.js` | 17 | ~1.1s | 6 (Server Responses) |
| **Total added** | **68** | **~11–15s** | |

Full `__tests__/security` suite with these six files included: **272/272
passed**, full run ~40s (dominated by `relay.http.test.js`'s existing,
pre-existing real 31s wait for a pepper-token TTL — unrelated to this pass).
Full repo `npx jest` (25 suites, 273 tests including `__tests__/App.test.tsx`):
**273/273 passed, ~40s**. The previously-documented flake
(`relay.js - Body-Groessenlimit`, `ECONNRESET` under parallel full-suite load)
did **not** reproduce in either run performed for this report — it remains a
known, accepted, load-dependent flake per `SECURITY_STATE_MACHINES.md`/
`SECURITY_CHAOS_TESTING.md`, not something this pass changed or needs to
re-litigate.

**Determinism:** every `fc.assert(...)` call in the new files passes an
explicit `seed` (`20260101`, one constant per file) and an explicit `numRuns`
tuned per target (100–300 for pure/fast crypto properties, 8–60 for anything
spawning or hitting a relay child process). A failing property always prints
the exact shrunk counterexample and the seed/path needed to reproduce it
bit-for-bit — no run is left to an unseeded random default.

**Fast-check v4 API note (learned during construction, not a finding):** this
is the first use of `fast-check` in the repo. Two v3→v4 API surface changes
were hit and corrected while building these tests, documented here so a
future maintainer doesn't rediscover them the hard way: `fc.fullUnicodeString()`
no longer exists (use `fc.string({unit: 'binary'})`); `fc.pre()` inside a loop
that wants to "stop testing after N failures" causes a
"too many pre-condition failures" abort once the guard flips permanently true
— a plain `if (cond) return;` inside the property body is the correct pattern
for that, since `fc.pre()` is for genuinely *invalid* generated inputs, not
for early-exit state.

---

## Per-target findings

### 1. Ciphertext Parser — `MessageCrypto.js`/`.ts` (`encryptMsg`/`decryptMsg`)

**Result: robustly fail-closed across the entire fuzzed input space.** 14
property-based tests (300 runs each for the cheapest properties) covering:
arbitrary base64 garbage, arbitrary raw byte sequences, every truncation
position of a real ciphertext (systematically walking all three AEAD-layer
nonce-slice boundaries: 24/12/12 bytes), a bit-flip at *every* byte position
(not just 3 hand-picked ones), arbitrary secret lengths (0–1000 bytes),
combinatorial fuzzing of secret+ciphertext simultaneously, and an all-zero
32-byte key. **Zero uncaught exceptions, zero false accepts, zero silent
corruption** found in either the native or web implementation.

**Unicode edge cases:** full round-trip fidelity confirmed for null bytes,
RTL override characters, zero-width joiners/non-joiners, valid emoji surrogate
pairs (including 20,000-codepoint-long strings), and cross-implementation
(native-encrypts → web-decrypts) for all of the above. One **methodology
note, not a bug**, surfaced while building this: a string containing an
*unpaired* UTF-16 surrogate does not round-trip byte-exactly, because
`Buffer.from(str,'utf8')` (native) and `TextEncoder` (web) both replace lone
surrogates with U+FFFD per the WHATWG/ECMA-402 UTF-8 encoding spec — this is
inherent to UTF-8 itself, not a property of this app's crypto layer. The test
suite covers this input class separately (asserts only "never throws", not
"round-trips exactly").

**Second methodology note:** an early draft of the truncation-fuzzing test
falsely flagged a "failure" at certain cut points — the cause was that
`Buffer.from(base64, 'base64')` tolerantly ignores trailing `=` padding
characters, so trimming *only* padding characters (not actual payload bytes)
correctly still decrypts. Fixed by comparing decoded byte lengths rather than
string lengths before asserting `null`. Documented in-line in the test file
as a caution for future fuzz-property authors on this codebase.

### 2 + 3. Message Parser / Protocol Messages — `WebRTCManager.js`/`.ts` `channel.onmessage`

**Result: no uncaught exception escapes the dispatch handler on either
platform**, across ~550 fuzzed system/encrypted envelopes (type/subtype type
confusion via numbers/arrays/objects/null/booleans, missing required fields,
extra unknown fields, unknown subtypes, and JSON payloads nested up to 500
levels deep).

**New, previously-undocumented finding — native/web parser differential on
live-path system-control replay protection.** `WebRTCManager.js` (native)
applies `isFreshTimestamp()` **and** `isNewerThanLastAcceptedSystemTs()`
(sequence-aware replay protection) to `secret_start`/`secret_end`/
`delete_chat`/`transfer_ready` on the live P2P DataChannel path (lines
~487–505, added per `SECURITY_STATE_MACHINES.md` §10 Finding 4/5).
`web/src/lib/WebRTCManager.ts`'s `channel.onmessage` has **no equivalent
branch at all** for these four subtypes on the live path — after the
`'encrypted'` decrypt succeeds, everything except `ready`/`dummy`/`text` is
passed straight to `onMessage(original)` unfiltered (lines 316–336).
Concretely reproduced in `fuzz.protocolMessages.test.js`
("DIFFERENTIAL-BEFUND" test): the identical replayed-`secret_start`-after-
`secret_end` scenario that native correctly rejects is accepted unfiltered by
web's `WebRTCManager.onMessage`.

**Severity assessment: currently harmless, but a live regression trap.** Web
does not yet implement `secret_start`/`secret_end`/`delete_chat` as features
at all (confirmed: `web/src/App.tsx` line ~250 comment, "Web implementiert
(noch) keine anderen system-Subtypes … bewusst nur [device_wiped]") — so the
unfiltered object currently lands nowhere that can do anything with it. The
finding matters because **there is no template in `WebRTCManager.ts` for the
sequence-aware check** the day someone adds these features to web — the
natural move ("copy the native `App.tsx` handler") would silently miss the
replay guard that lives in the *other* file (`WebRTCManager.js`), not the one
being copied from. The regression test is written to fail (flip from
`webAcceptedSecretStart === true` to `=== false`) the moment someone adds that
guard, as an intentional tripwire, with an explicit comment saying to update
rather than delete the test at that point.

**Server-returned-response reverse-direction confirms the mirror image (see
§6):** the client-parsing side has an analogous, symmetric gap.

### 4. Key Material — `HybridCrypto.js`/`.ts` (`kyberEncapsulate`/`kyberDecapsulate`)

**Web (`@noble/post-quantum` real ML-KEM-768, runs fully under Node/Jest):**
150+150 fuzzed malformed-base64/wrong-length public keys and ciphertexts,
plus an empty string, a 100KB string, and an oversized-but-valid-base64
118,400-byte string. Every malformed case either throws a normal `Error`
(the library's own strict length validation) or is rejected before producing
a usable result — **no hang, no wrong-key silent acceptance, no uncaught
non-`Error` exception**. A real-keypair-derived ciphertext truncated at every
possible byte length never decapsulates to the real shared secret.

Fed through the **actual `WebRTCManager.ts` dispatch path**: a
`kyber_pubkey`/`kyber_ciphertext` message with a fuzzed public key/ciphertext
never escapes `channel.onmessage`'s try/catch, and — critically — leaves
`keyExchangeDone`/`sharedSecret` in the **exact pre-message state** (both
unset) whenever the real ML-KEM-768 length check rejects the input. No
partial/inconsistent key state was found reachable via this path.

**Native (`HybridCrypto.js` → `NativeModules.KyberModule`):** the real
BouncyCastle ML-KEM-768 implementation lives exclusively in Kotlin and cannot
run under Jest (confirmed absent from every prior review/chaos pass too, not
a new limitation). Fuzzing here would only exercise `nativeBridgeMock.js`'s
SHA-256/SecureRandom stand-in, which performs no length validation by design
— doing so would test the mock, not the app. Documented as intentionally
**not** fuzzed for this reason (see "Not fuzzable" below), with the
type-confusion dispatch-level tests (numbers/arrays/objects instead of a
string `publicKey`) still run against the native `WebRTCManager.js` to confirm
the *dispatch* layer (not the crypto primitive) handles it — confirmed clean.

### 5. Authentication Messages — `relay.js` `/pepper/*`

**Real, confirmed bug — `/pepper/register` deviceId type confusion bypasses
the length check.** `relay.js`'s validation is
`if (!deviceId || deviceId.length < 16) { ...reject... }`. For a **truthy
non-string value with no numeric `.length`** (an object `{}`, a number, a
boolean `true`), `deviceId.length` is `undefined`, and `undefined < 16`
evaluates to **`false`** in JavaScript (not `true`) — so the length check
silently does not fire, and a real pepper is issued and stored under that
non-string `deviceId` key.

**Practical exploitability: negligible, confirmed by direct test.** The
`pepperStore` is a `Map`; a JSON-parsed object is a **fresh object reference**
on every single request, and `Map` key lookup for objects uses reference
identity, not structural equality — so this entry becomes **permanently
unreachable the instant the response is sent** (no future request can ever
present "the same" object key again). Net effect is one harmless, orphaned,
never-expiring `Map` entry (pepper entries have no TTL sweep by design, per
`relay.js`'s own comment — this doesn't change that). No auth bypass, no
information disclosure, no resource-exhaustion vector (bounded by request
rate, same as any legitimate registration).

**Still a genuine, worth-fixing validation gap**, because the check's own
intent (reject anything that isn't a real device-id-shaped string) silently
fails to do what its code and comment imply for an entire class of input
types. **Suggested fix** (narrow, one line, not applied — `relay.js` is under
active concurrent editing this session): change the guard to
`if (typeof deviceId !== 'string' || deviceId.length < 16)`.
Regression test: `fuzz.relayApiInput.test.js`, "REGRESSION: deviceId als
Objekt ({}) statt String umgeht die Laengenpruefung".

Beyond that: `attemptToken` type-confusion (number/array/object/boolean
instead of string) against `/pepper/fail` was fuzzed and **never** accepted —
the `attemptToken !== entry.pendingToken` strict-inequality check correctly
rejects every non-matching type as a type mismatch is always `!==`. No bug
here.

### 6. Server Responses — client-side parsing of relay.js's own JSON (native `RelayClient.js` + web `RelayClient.ts`)

**Explicitly the least-previously-tested direction per the task brief, and it
paid off — a real, symmetric finding on both platforms.**

Every `get*`/`poll*` function in both `RelayClient.js` and `RelayClient.ts`
extracts its expected field with a bare `data.field || <default>` pattern
(`data.packets || []`, `data.offer || null`, `data.signals || []`, …) with
**no `Array.isArray()` / `typeof` check** on the extracted value before
returning it. A compromised or MITM-positioned relay (or simply a buggy
relay) that returns a *truthy but wrong-shaped* value —
e.g. `{"packets": "not an array"}` or `{"packets": {"evil": true}}` — gets
that value passed straight back to the caller, **unvalidated, on both
platforms identically** (confirmed via dedicated regression tests on each
side, not just inferred from reading the source).

**Downstream impact (traced, not directly re-tested — the consuming files
are under active concurrent edit this session):** `App.tsx`'s
`checkIncoming`/`checkOutgoing` and `web/src/App.tsx`'s `checkOfflinePackets`
consume this return value with `for (const packet of packets)`. A string
value iterates character-by-character (harmless but nonsensical — each
"packet" is a single character, which then fails `JSON.parse` inside the
per-packet `try/catch` and is silently skipped, per both files' existing
defensive per-packet catch blocks). A **number, plain object, `null`, or
`boolean`** value is **not iterable** — `for...of` over it throws a
`TypeError` **synchronously**, and neither polling loop wraps its own
`for...of` line in a try/catch (only the per-*packet* body inside the loop
is guarded) — this would surface as an uncaught exception in that polling
cycle's async callback, most likely an unhandled promise rejection rather
than a process crash, but it would silently stop that one poll cycle from
completing (no `ackPackets`/cleanup calls after the throw point). Not
independently re-tested end-to-end against the live `App.tsx` component for
the same reason `SECURITY_CHAOS_TESTING.md` gave for a similar finding (no
jsdom/react-test-renderer harness stood up for this pass — see "Not
fuzzable" below) — the finding is proven at the `RelayClient` boundary with
high confidence via direct source-reading of the consuming `for...of` sites.

**Suggested fix** (narrow, one function each, not applied — both
`RelayClient` files are technically low-risk to touch but their *callers*
(`App.tsx`/`web/src/App.tsx`) are under active concurrent edit and the fix
is more valuably centralized there): change
`return data.packets || [];` to `return Array.isArray(data.packets) ? data.packets : [];`
(and the equivalent `typeof … === 'string'` guard for `offer`/`answer`)
inside `RelayClient.js`/`.ts` themselves — this closes the gap at the single
shared choke point instead of needing a guard at every call site.

All other server-response fuzzing (arbitrary primitive/object/array response
bodies fed to `pepperRequest`, `pepperFail`, `pepperSuccess`, `relayStatus`,
`getTurnCredentials`, and a `res.json()`-throws / `fetch`-rejects simulation
for every function) confirmed the documented fail-closed defaults
(`null`/`[]`/`false`/`{ok:false,...}`) are always reached, with **zero
unhandled rejections** in any of the ~500 fuzzed response shapes tried.

### 7. Attachment Metadata — `RTCStore.js`, `ImageCrypto.js`/`AudioCrypto.js` chunk buffering

**Two real, confirmed, reproducible bugs, both in production code (not test
mirrors) — this was the highest-value target of the whole campaign.**

**Bug 7a — unvalidated `total` field crashes the chunk-buffer constructor
with a `RangeError`.** `processImageChunk`/`processAudioChunk`
(`ImageCrypto.js`/`AudioCrypto.js`, confirmed live production code via
`App.tsx:1912`) and `RTCStore.js`'s own independent, duplicated inline
buffering logic (`setConnection()`'s `onMessage`, lines ~41/80/112, used for
the "no chat screen open" background path) both do
`chunks: new Array(msg.total)` **with zero validation** of `total`'s type or
range. `new Array(n)` throws a synchronous `RangeError: Invalid array length`
for `n < 0`, non-finite `n` (`NaN`/`±Infinity`), or non-integer `n` (`1.5`).
Confirmed via minimal regression tests:
```js
processImageChunk({ type:'img_chunk', imageId:'x', index:0, total:-1, data:'AAAA', mimeType:'image/jpeg' })
// throws RangeError: Invalid array length
```
(identical for `total: NaN` on `processAudioChunk`, `total: 1.5` on
`processImageChunk`).

**Containment confirmed both ways:**
- Via the **live P2P path** (`WebRTCManager.channel.onmessage` → directly
  calling `this.onMessage?.(original)` for `img_chunk`/`img_end`, no
  validation at that layer either — confirmed by dedicated test that a fuzzed
  `total` value, including `1e400`/`-1e400`-overflow-to-Infinity JSON
  literals, passes through completely unchanged to the caller): the
  `RangeError` this throws deeper inside `RTCStore`'s synchronous
  `onMessage` callback **is** caught by `WebRTCManager`'s own outer
  `try/catch` around the whole `channel.onmessage` body (no `await` sits
  between the synchronous callback invocation and that catch) — **no process
  crash, no uncaught exception reaches Jest.** The concrete cost: the chunk
  is silently dropped and never contributes to the eventual image/audio
  (a data-loss bug, not a crash).
- Via `App.tsx`'s **avatar-chunk inline mirror of the same pattern**
  (`App.tsx:1893`, `new Array(msg.total)`, identical to `RTCStore.js`'s copy):
  same underlying vulnerability exists a **third time**, independently
  copy-pasted, not directly re-tested against the live component (App.tsx is
  under active concurrent edit) but traced and confirmed present via direct
  source read at the cited line.

**Severity: broken, not unsafe** — this is a denial-of-service against *that
one attachment transfer* (never completes, no error surfaced to the user
beyond a silent console warning), not a process-level crash and not a
confidentiality/integrity break (the dropped chunk was itself a legitimately
decrypted, authenticated message from the real peer — this isn't reachable
by an unauthenticated attacker, only by whoever is on the other end of an
already-established, keyed DataChannel, i.e., the paired contact themselves,
sending malformed *chunk metadata* rather than malformed ciphertext).

**Bug 7b — duplicate/out-of-range chunk index causes silent, corrupted
"completion" instead of a detected gap.** Both `RTCStore.js`'s inline buffer
and (per `chunkBinding.test.js`'s pre-existing coverage of a *different*,
mirrored reassembly function) the general pattern share the same root cause:
`buf.received++` counts **every incoming chunk message**, not the number of
**distinct indices filled**. Confirmed via a new regression test
(`fuzz.attachmentMetadata.test.js`): sending two `img_chunk` messages both
targeting `index: 0` (never sending `index: 1`) for a `total: 2` transfer
causes `buf.received` (2) to reach `buf.total` (2) — the transfer is
declared "complete" and delivered as `image_complete` with `base64: 'BBBB'`
(only the second write to slot 0; slot 1 was never set, and
`Array.prototype.join('')` silently treats the empty slot as `''`, not as an
error). No error, no warning, no indication to the user that half their image
never arrived — they get a shorter-than-expected but not obviously broken
image, silently.

**Chunk-content/AEAD integrity is unaffected** — `chunkBinding.test.js`
already independently confirms each individual chunk is genuinely encrypted
by the real peer under the real shared secret; this bug is purely in the
**assembly bookkeeping**, not a cryptographic bypass.

**Not fixed here.** Both bugs are genuinely narrow-scope, low-risk fixes in
isolation (a bounds/type check on `total` before `new Array(total)`; an
index-uniqueness check via `if (buf.chunks[msg.index] === undefined) buf.received++`
instead of unconditional `buf.received++`) — but they live in
`RTCStore.js`/`ImageCrypto.js`/`AudioCrypto.js`, all three explicitly named as
under active concurrent editing this session, and the fix touches the shared
chunk-assembly path used by every image/audio transfer on every platform.
Per this session's established precedent (documented, not patched blind,
when a file is under concurrent edit and the fix isn't a single obviously
isolated line), this is documented here with concrete repro rather than
applied.

### 8. Serialization/Deserialization

Covered as part of §1 above (Unicode round-trip properties through the full
`encryptMsg`/`decryptMsg` JSON-wrapping pipeline) rather than as a separate
file — `chaos.corruptedState.test.js` already owns dedicated
JSON.parse/localStorage-corruption coverage for `Storage.ts` and doesn't need
duplication. The one JSON-specific structural question in the task's mutation
list — **duplicate keys in a raw JSON string** — was verified directly
against `relay.js`'s real `/packet` handler (not a mirrored function): a raw
body containing `"recipient":"opfer_A","recipient":"opfer_B"` twice is
resolved by `JSON.parse` exactly per the JSON specification (**last value
wins** — confirmed `JSON.parse(raw).recipient === 'opfer_B'`), and `relay.js`
consistently stores/serves the packet only under the winning (`opfer_B`)
value with no observable "confusion" between the two candidate recipients —
**not an exploitable smuggling vector**, confirmed empirically rather than
just assumed from the spec.

### 9. Database Input

Deliberately not re-covered — `chaos.corruptedState.test.js` already provides
first-of-its-kind, dedicated coverage of `Storage.ts` (web
localStorage-equivalent) corruption scenarios (corrupted marker/salt/missing
keys) and of native `AsyncStorage`/`EncryptedStorage` read-site try/catch
coverage (by code-reading, per that document). Nothing new to add here beyond
what's already in this report's §1/§7 (both of which incidentally exercise
storage-adjacent code paths — `shared_secret_<id>` persistence via
`MessageCrypto`, chunk-buffer state).

### 10. API Input — `relay.js` general endpoint fuzzing

Covered together with §5 in `fuzz.relayApiInput.test.js`. In addition to the
`/pepper/register` finding above, fuzzed **valid JSON with wrong field
types/oversized values/deeply-nested-object values/missing fields** against
`/packet`, `/phone/register`, `/phone/lookup`, `/reconnect/offer`,
`/reconnect/answer`, `/signal/offer`, `/call/signal`, `/transfer/:token/chunk/:i`,
and `/push/register` — **~350 fuzzed requests total across these routes,
zero 5xx responses, zero hangs, zero process crashes.** One structural
observation (not a bug): `/transfer/:token/chunk/:i`'s `total` field is
stored by `relay.js` as an **opaque value** — the relay itself never does
`new Array(total)` or any length-based allocation with it (that only happens
client-side in the chunk-*consuming* code, §7) — so the relay itself is
structurally immune to the §7 vulnerability class, confirmed by fuzzing the
same boundary-integer set against it directly with no ill effect.

`/call/signal`'s `type` field (a de facto protocol discriminator —
`offer`/`answer`/`ice`/`reject`/`cancel`/`end`) was fuzzed with type-confused
values (numbers, arrays, objects, booleans, `null`, unknown strings): never
matches the special `cancel`/`end`/`reject` string-equality branches (`===`
correctly rejects any non-matching type), always falls through to the
generic append-to-`signals`-array path, never causes a 5xx. No bug found.

---

## Prioritized findings summary

Ordered by real-world impact, matching this session's established convention
(confidentiality/integrity/DoS-relevant first, pure robustness/annoyance
last). **Headline result: no scenario constructed in this pass broke
confidentiality, integrity, or authenticity** — consistent with
`SECURITY_CHAOS_TESTING.md`'s own headline finding from the prior pass.

1. **Attachment chunk metadata: unvalidated `total`/`index` causes both a
   `RangeError`-triggered data-loss bug (7a) and a silent, corrupted
   "premature completion" data-integrity bug (7b)**, independently duplicated
   across three separate code paths (`RTCStore.js`, `ImageCrypto.js`/
   `AudioCrypto.js`, `App.tsx`'s avatar-chunk inline copy). The
   highest-value, most concretely reproducible finding of this pass. Not
   fixed (concurrent-edit files); regression tests + fix suggestion
   documented in §7 above.
2. **Native/web parser differential: web `WebRTCManager.ts` has no
   sequence-aware replay guard for live-path system-control messages**,
   unlike native's already-fixed `isNewerThanLastAcceptedSystemTs()`.
   Currently harmless (feature not yet implemented on web) but a documented
   regression trap for whoever implements it next. See §2+3.
3. **Server-response trust gap, symmetric on both platforms:
   `RelayClient.js`/`.ts` never validate that `packets`/`offer`/`answer`/
   `signals` actually have the expected shape** before returning them —
   traced to a likely uncaught `TypeError` in the consuming `for...of` loops
   on a malicious/compromised relay. See §6.
4. **`relay.js` `/pepper/register`: a type-confusion bug in the deviceId
   length check** (`undefined < 16` is `false`, not `true`) lets a
   non-string `deviceId` bypass validation and receive a real pepper.
   Confirmed practically inert (Map reference-identity self-neutralizes it)
   but a genuine, worth-fixing validation gap. See §5.

None of the four findings above constitute an authentication bypass, a
fails-open cryptographic acceptance, or a confidentiality/plaintext-exposure
regression — every one bottoms out in data loss, data corruption, or an
uncaught-but-locally-scoped exception, consistent with every prior chaos/
state-machine pass this session.

---

## What's not fuzzable under Jest, and why

- **Native ML-KEM-768 (`NativeModules.KyberModule`, real BouncyCastle-backed
  implementation).** Lives exclusively in Kotlin on-device; the Jest bridge
  mock (`nativeBridgeMock.js`) performs no cryptographic length/format
  validation by design (it's a thin SecureRandom/SHA-256 stand-in). Fuzzing
  against the mock would test the mock, not the app — explicitly not done,
  same boundary already documented in `SECURITY_CHAOS_TESTING.md`. The
  *dispatch*-layer behavior around it (type confusion on the `publicKey`/
  `cipherText` JSON field, key-state consistency after a throw) **was**
  fuzzed successfully against the real `WebRTCManager.js`, since that part is
  pure JS.
- **True OS-level process kill mid-statement**, for the "does a chunk-buffer
  RangeError ever escape as a genuinely uncaught, process-crashing exception
  under a *different* call path than the one tested" question. This pass
  confirmed containment specifically for the live P2P DataChannel path
  (`WebRTCManager`'s outer try/catch); the `App.tsx:1912`
  `import('./ImageCrypto').then(...)` avatar-chunk inline copy site,
  and the relay-fallback (`checkIncoming`/`checkOfflinePackets`) paths for
  the same bug class, were traced by source-reading only (not
  independently re-executed against a live `<App/>` render) — matching
  `SECURITY_CHAOS_TESTING.md`'s own stated boundary for exactly this class of
  "would need a jsdom/react-test-renderer harness for this one finding"
  situation, not stood up here for the same cost/benefit reasoning that
  document gave.
- **A real MITM/TLS-downgrade attack against the actual relay deployment**
  (as opposed to the local relayHarness) — out of scope by the task's own
  explicit safety constraint; §6's findings were proven via mocked `fetch`
  responses (functionally identical to what a compromised/malicious relay
  would return over the wire) rather than a live network MITM.
- **`checkOutgoing`/`checkIncoming`/`checkOfflinePackets` poll-loop
  behavior against a genuinely malformed relay under a full `<App/>` render**
  — same "no jsdom harness stood up for RN component tests" boundary
  `SECURITY_CHAOS_TESTING.md` already documented; the underlying
  `RelayClient` functions those loops call **were** fuzzed directly and
  exhaustively (§6), which covers the same code with high confidence at one
  layer of indirection removed from a full render.

---

## Fixes applied in this pass

**None.** Every bug found in this pass lives in a file explicitly named as
under active, concurrent editing by other sessions this run
(`RTCStore.js`, `ImageCrypto.js`, `AudioCrypto.js`, `relay.js`,
`RelayClient.js`/`.ts`'s callers). None of the fixes were a single, obviously
isolated one-line change with zero risk of colliding with concurrent work in
the same file (unlike, e.g., the `keyExchangeDone` guard fix in
`SECURITY_STATE_MACHINES.md`, which touched two clearly-delimited handler
blocks). All four findings are documented above with an exact minimal
reproduction, a concrete regression test already in the suite, and a
specific suggested fix — ready for a dedicated follow-up pass once the
concurrent edits to those files land.

---

## Files added

- `__tests__/security/fuzz.messageCrypto.test.js` (14 tests)
- `__tests__/security/fuzz.keyMaterial.test.js` (7 tests)
- `__tests__/security/fuzz.protocolMessages.test.js` (6 tests)
- `__tests__/security/fuzz.attachmentMetadata.test.js` (8 tests)
- `__tests__/security/fuzz.relayApiInput.test.js` (16 tests)
- `__tests__/security/fuzz.serverResponseParsing.test.js` (17 tests)
- `SECURITY_FUZZING_CAMPAIGN.md` (this file, new)
- `package.json`/`package-lock.json` — `fast-check@^4.10.2` added as a
  devDependency (not committed, left for review per task instruction)

No production files were modified in this pass, for the reasons given under
"Fixes applied" above.
