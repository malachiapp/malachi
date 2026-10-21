# Security Review 4 — Adversarial Test Suite

Scope: build and run a real, executable adversarial test suite exercising the
protocol/trust-boundary properties established and fixed in Reviews 1-3 (red-team,
crypto-protocol, malicious-relay trust model), and apply the one narrowly-scoped
production fix a test run surfaced. No new cryptography was designed or hand-rolled
anywhere in this pass, per the project's standing "keine eigenentwickelte
Kryptografie" rule — only Node's built-in `crypto`, the project's own `@noble/*`
crypto libraries, and the project's own exported functions were used.

All new files live under `C:\SecureCommApp\__tests__\security\`.

---

## SECURITY ISSUES FOUND / FIXED

### Fixed: fail-open clock-skew / `Infinity`-timestamp bypass in the replay-freshness check

**Where:** `App.tsx` (system-control packets and regular relay-delivered messages)
and `web/src/App.tsx` (`checkOfflinePackets`) — the freshness check added in Review 3
to stop a malicious relay from replaying an old, validly-encrypted packet.

**The bug:** the original condition was `!ts || Date.now() - ts > 15*60*1000`. For
`ts = Infinity` (or any timestamp far in the future), `Date.now() - ts` evaluates to
a large negative number, which is never `> 15min` — the packet was accepted as
"fresh" *forever* instead of being rejected. This is a genuine fail-open gap inside
otherwise fail-closed logic, and is proven directly in
`__tests__/security/replayWindow.test.js` (see below).

**The fix:** a new shared `isFreshTimestamp(ts)` helper (module-scope in `App.tsx`,
mirrored in `web/src/App.tsx`) now requires `ts` to be a finite number, rejects
anything more than 15 minutes old (unchanged), **and** rejects anything more than 5
minutes in the future. The 5-minute forward tolerance is a judgment call for real
device-clock drift/NTP skew — deliberately much smaller than the 15-minute window so
it can't be used to meaningfully extend it. All three call sites (`App.tsx` system
control, `App.tsx` regular messages, `web/src/App.tsx`) now call this single
function instead of three separately-written inline conditions, so there's one
place to keep correct going forward.

This is a narrowly-scoped logic fix (an `if` condition), not new cryptography.

### Fixed (follow-up pass): `relay.js` had no request body-size limit

Every route read the full request body into memory via `req.on('data', d => body
+= d)` with no cap. `__tests__/security/relay.http.test.js` demonstrated the relay
accepted a 20MB `/packet` POST body without any size-based rejection (200 OK) — a
real memory-exhaustion DoS vector against a relay instance's finite RAM.

Originally left as a documented-not-fixed finding here (picking a concrete limit is
a decision about someone else's exposed, running process). The project owner
subsequently asked for it to be fixed: `relay.js` now enforces a 2MB `MAX_BODY_BYTES`
cap uniformly across all routes, checked incrementally as data arrives (not just via
`Content-Length`, which a client could lie about) — oversized requests get `413` and
the connection is destroyed. 2MB was chosen as comfortably above the largest
legitimate request (a single image/audio chunk: 64KB raw data, ~90-100KB after AEAD
encryption + JSON envelope + base64 re-encoding) while still meaningfully bounding
abuse. `relay.http.test.js` now asserts both the rejection (20MB → 413) and that a
realistic ~150KB chunk upload still succeeds.

---

## TESTS ADDED/PASSED

All new files under `C:\SecureCommApp\__tests__\security\`:

| File | Covers |
|---|---|
| `helpers/nativeBridgeMock.js` | Installs `NativeModules.KyberModule` backed by Node's real `crypto` (SecureRandom-equivalent CSPRNG bytes, real SHA-256) — stands in only for the JNI bridge call, not for any cryptographic primitive. |
| `helpers/relayHarness.js` | Spawns a real `relay.js` process (scratch copy with the hardcoded port `3333` substituted for a dynamically-chosen free port, so the committed file and any real running relay are untouched) for black-box HTTP testing. |
| `messageCrypto.tamper.test.js` | Ciphertext malleability: bit-flips at multiple offsets, truncation, empty string, non-base64 garbage, cross-ciphertext/cross-key substitution — all must return `null`, never throw. Run against **both** native `MessageCrypto.js` and `web/src/lib/MessageCrypto.ts`. |
| `messageCrypto.domainSeparation.test.js` | Full purpose matrix (`message`/`reconnect`/`call-signal`/arbitrary) for both implementations, plus a **cross-implementation** pass proving native and web are wire-compatible for the same purpose and still domain-separated across purposes. |
| `replayWindow.test.js` | Boundary tests for the freshness check, including the exact `Infinity`/far-future case that proves the bug above (documents the old broken behavior, then proves the fix). |
| `chunkBinding.test.js` | Adversarial chunk-reassembly tests (spliced-in chunk from a different transfer, out-of-range index, missing chunk/hole, duplicate index, tampered end-marker total, wrong decryption key) against a faithful mirror of the `App.tsx` binding logic, using **real** AEAD encrypt/decrypt (not mocked). |
| `relay.http.test.js` | Real spawned-process HTTP tests: garbage bodies against every POST route (split into two groups so the 5-failed-attempts IP-block doesn't contaminate later assertions), confirmed IP-block actually triggers and blocks, oversized-body DoS demonstration, soft-404 behavior for unregistered transfer/reconnect/signal tokens, pepper `attemptToken` double-request (429) **and a real 31-second wait** proving the pending-token-expiry-as-implicit-fail path, pepper rotation on success, `pepper/fail` rejecting a forged `attemptToken`, plus extracted-logic unit tests for the TTL sweep (33-day/24h/2min, without waiting) and the IP-block state machine. |
| `phonePskIndependence.test.js` | Proves `hashPhone` (public rendezvous hash) and `derivePhonePSK` (secret PSK) are independent SHA-256 digests via distinct domain labels, order-independent, and that input normalization doesn't create collisions. |

### Real test run output

```
$ npx jest __tests__/security
Test Suites: 6 passed, 6 total
Tests:       103 passed, 103 total
Snapshots:   0 total
Time:        35.042 s
```

Per-file breakdown (all passed):
- `messageCrypto.tamper.test.js` — 14 tests (7 native + 7 web)
- `messageCrypto.domainSeparation.test.js` — 21 tests (6 native + 6 web + 9 cross-implementation)
- `replayWindow.test.js` — 18 tests
- `chunkBinding.test.js` — 8 tests
- `relay.http.test.js` — 33 tests (includes one deliberately-slow ~31s real-time wait for the pepper token-expiry case)
- `phonePskIndependence.test.js` — 9 tests

Full project `npx jest` run: the same 103/103 pass; the pre-existing
`__tests__/App.test.tsx` (default RN template test) still fails for an unrelated,
pre-existing reason (`react-native-qrcode-svg` ships ESM that isn't transformed —
a leftover gap from the RN 0.73→0.86 upgrade, not something this review's scope
covers or that any change here regressed).

### Incidental jest-infrastructure fixes (not security fixes, needed to run any of this)

- `jest.config.js` was still pointing at the old `preset: 'react-native'` (moved to
  `@react-native/jest-preset` as of the RN 0.86 upgrade) — `npm test` didn't run at
  all before this. Fixed, and `@react-native/jest-preset` added as a devDependency.
- Added `transformIgnorePatterns` entries for `@noble/*` (both the root copy and the
  separate copy under `web/node_modules`, needed to exercise the web `.ts` crypto
  files in the same Jest run) and `react-native-vector-icons` (both ship ESM).
- Added a `moduleNameMapper` for `@noble/ciphers/*` and `@noble/hashes/*` imports
  without a file extension — Metro (the RN bundler) resolves these leniently at
  build time, but Node/Jest's module resolver honors `@noble`'s strict `exports`
  map in `package.json`, which only defines `.js`-suffixed subpaths.
- Added `testPathIgnorePatterns` for `__tests__/security/helpers/` — Jest's default
  `testMatch` treats every `.js` file under any `__tests__` directory as a test
  file; the shared helpers aren't tests themselves.

---

## REMAINING RISKS

1. ~~`relay.js` has no request body-size limit~~ — **fixed** in a follow-up pass
   (see above): a 2MB cap now applies uniformly, enforced incrementally.
2. **IP-block/intrusion-detection logic is only partially black-box-verified.** A
   single local test process can only originate requests from one source IP
   (`127.0.0.1`/`::1`), so the *real* `checkIP`/`registerFail`/`blockedIPs` code
   path is exercised end-to-end for one IP (confirmed: 5 failures block it, other
   IPs stay unaffected in principle) — but true multi-IP behavior is additionally
   covered only by an extracted, faithfully-mirrored copy of the state machine, not
   by hitting the real server from genuinely different source addresses.
3. **The 5-minute future-clock-skew tolerance is a judgment call**, not a value
   derived from any spec. If real-world testing shows legitimate devices routinely
   drift by more than that (unlikely for phones with network time sync enabled,
   but self-hosted/rooted devices could disable it), the window may need
   adjustting — currently untested against a real device with deliberately-skewed
   clock.
4. **`derivePhonePSK`/`hashPhone`'s inherent limitation is unchanged and still
   applies**: an attacker who already knows both phone numbers can derive the same
   PSK as the legitimate parties (documented in App.tsx's own comments, carried
   forward from Review 3 — not something this pass could or should change, since a
   real fix would require a different protocol, not a test).
5. **Duplicate-index chunk handling is "last write wins" without an explicit
   integrity error** — `chunkBinding.test.js` confirms this doesn't produce a false
   "complete" transfer (the resulting hole elsewhere is still caught), but a
   deliberately duplicate-then-hole attack currently fails safe by accident of the
   hole-check, not by an explicit "duplicate index" rejection. Low severity (no
   path to a successful forged transfer was found), noted for completeness.

---

## SECURITY ASSUMPTIONS

- `NativeModules.KyberModule.randomBytes`/`.sha256` are assumed to be exactly what
  `android/app/src/main/java/com/securecommapp/KyberModule.kt` implements: Android
  `SecureRandom` bytes and plain `SHA-256(UTF-8 bytes)` hex. The test mock
  (`nativeBridgeMock.js`) uses Node's own `crypto.randomBytes`/`crypto.createHash
  ('sha256')`, which are algorithmically identical, standing in only for the JNI
  bridge call itself — this is stated as an assumption, not verified by these tests
  against the actual compiled Kotlin, since that only runs on-device.
- The `@noble/ciphers`/`@noble/hashes` implementations themselves (AES-256-GCM,
  ChaCha20-Poly1305, XSalsa20-Poly1305, HKDF-SHA256) are assumed correct per their
  own upstream test suites/audits — this review tests *usage* of them (key
  derivation, domain separation, tamper rejection), not the primitives themselves.
- `relay.js`'s TLS termination (cert/key handling) and the coturn TURN-credential
  HMAC scheme are out of scope for this pass — Review 1-3 already covered relay
  trust-model concerns; this pass only added adversarial *tests* for what those
  reviews found and fixed.
- Tests assume a Windows/Node 24.x development environment can accurately stand in
  for the relay's actual Linux/pm2 production deployment for the purposes of HTTP
  route behavior — process-level behavior (signal handling, file paths) was not a
  target of this review.

---

## AREAS REQUIRING HUMAN/EXTERNAL CRYPTOGRAPHIC REVIEW

Carried forward from Reviews 1-3 (still true, not re-litigated here):

- **The pepper mechanism's residual gap** (an attacker-controlled client can call
  `/pepper/success` instead of `/pepper/fail` after a wrong guess, resetting its own
  fail counter) is only fully closable with a real PAKE/OPRF protocol — deliberately
  not hand-rolled, per the project's no-home-grown-crypto rule.
- **No forward secrecy / post-compromise recovery** — the single long-lived
  Kyber-derived shared secret per contact pair has no ratchet. A real fix needs a
  Double-Ratchet-style protocol design, which is new cryptographic protocol design,
  not a test-suite or logic-fix task.
- **The real ML-KEM-768 keypair generation/encapsulation/decapsulation path
  (native Kotlin/BouncyCastle) was not exercised by any test in this pass** — it
  cannot run outside an Android device/emulator. Everything tested here operates
  on an already-established shared secret (a random 32-byte value standing in for
  the real Kyber output), which is sufficient for testing the symmetric-crypto
  layer, replay logic, and relay trust-boundary behavior, but is **not** a
  verification of the KEM implementation itself. That remains an on-device/manual
  verification gap.
- The relay.js body-size limit is fixed (2MB, see above) — if real-world usage
  ever needs larger attachments than the current 64KB-chunked transfer design
  produces, this threshold would need revisiting together with that design.
