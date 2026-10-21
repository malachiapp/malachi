# Security Audit — Trust Model, Privacy & "Who Can See What" Claims

**Scope:** server-trust / metadata-privacy claims only (not the cryptographic-protocol
layer — AEAD strength, key exchange, etc. are a separate audit's territory). This is a
read-only adversarial re-verification. Nothing in the repo was modified.

**Method:** every claim below was checked against the ACTUAL current code (post
`c3eb036` "Sicherheitsreview 5+6 Fixes"), not against what `SECURITY_REVIEW_1`–`6`
*say* the code does. Where this audit reaches the same conclusion as an existing
review, that is stated explicitly (it strengthens the finding). Where this audit found
something those reviews missed, got wrong, or didn't examine, that is also stated
explicitly.

Files read in full for this audit: `relay.js` (957 lines), `ecosystem.config.js`,
`ecosystem.config.linux.js`, `setup-log-rotation.sh`, `coturn-setup.sh`,
`pushSender.js`, `web/src/lib/Storage.ts`, `MainActivity.kt`,
`App.tsx` LockScreen (~963–1240) and phone-connect (~2690–2850, ~3100–3190) sections,
`web/src/lib/RelayClient.ts` and `RelayClient.js` wake-socket sections, the push
notification architecture plan, and `SECURITY_REVIEW_2/3/5` for cross-reference.

---

## FIXES APPLIED (follow-up pass, after this audit)

- **Claim 3 — `hashIp()`'s "nicht umkehrbar" (non-reversible) claim was false.** Fixed: `hashIp()` now uses `HMAC-SHA256` keyed by a `crypto.randomBytes(32)` secret generated fresh at process startup, never persisted, never configured by the operator (unlike `TURN_SECRET`, which must stay stable by design). This closes the "precompute all 2³² IPv4 hashes once, reuse the table forever" attack this audit demonstrated. Trade-off, stated explicitly in the new code comment: fingerprints no longer match across a relay restart — judged a non-issue (even a privacy improvement) since the fingerprint's only purpose is recognizing repeat abuse *within one running process's logs*, not building a durable cross-restart identity. Proven with 2 new tests (`relay.http.test.js`): the same real source IP produces different logged fingerprints across two independent relay processes, and stays stable within one process.
- **Claim 1c / Claim 2 — relay.js header overclaimed "keine Metadaten, keine Logs."** Fixed: the header comment now explains precisely what's actually true (no content persistence, no raw IP/contactId in operational logs, but routing metadata is inherent to being a rendezvous point and is not eliminated) instead of asserting a blanket "no metadata, no logs" a careful reader would reasonably take as absolute.
- **Claim 7 — `coturn-setup.sh` explicitly disabled TLS/DTLS for the TURN control channel** (`no-tls`/`no-dtls`, an active choice, not an oversight). Fixed: the script now enables TURNS on port 5349 reusing the same certificate `setup-tls.sh` already provisions for the relay (`/etc/malachi/tls/`), keeps plaintext port 3478 available for compatibility, and updates the firewall/output accordingly. Not yet deployed (coturn itself isn't live in production yet per `server-setup.sh`'s own "Phase 2" framing) — takes effect whenever it's actually run.
- **Claim 6 — the phone-connect "Zero-Knowledge" label omitted the caveat that's already honest in the developer comment.** Fixed: the user-facing string (`App.tsx`) now states the limit directly: protects against someone who doesn't know both phone numbers, not against someone who does.

## NOT FIXED — deferred with reasoning (no code change)

- **Claim 9 — native PIN/biometric lock screen doesn't gate an actual encryption key.** See the companion crypto-claims audit's fix log for the shared reasoning: this needs a real key-hierarchy redesign (PIN-derived key, like web already does) with a migration path for existing installs, not a scoped patch. The single most consequential open finding across both audits.
- **Claim 4 — TLS on the main relay HTTP/WS server remains optional and fails open to plaintext.** Structural: the code can't force an operator to provision certificates; it already warns loudly (console + startup banner) when they haven't. Making this fail *closed* (refuse to start without TLS) would be a legitimate, low-risk option to consider, but changes operational behavior (breaks local dev-mode use, per `ecosystem.config.js`'s own intentionally-TLS-less dev config) — left as a decision for the project owner rather than assumed.
- **Claim 7 (TURN operator trust) and Claim 12 (FCM as an unaddressed third-party in the "zero-knowledge" boundary)** — both are inherent to using a third-party-operated relay/delivery hop at all (TURN operator, Google/FCM); neither is fixable from inside this codebase. FCM's path is additionally already dead code (unwired), so currently moot in practice.

## Consolidated table: what the relay operator can observe (no cryptography broken)

| Signal | Persisted to disk? | In RAM, how long? | Citation |
|---|---|---|---|
| Client IP (raw) | No (never written to disk by relay.js itself) | Yes, indefinitely in `knownIPs` (`Set`, never pruned, grows for the life of the process) and until unblocked in `blockedIPs`/`suspectIPs`/`phoneLookupMisses`/`wsConnectionsByIP` | `relay.js:68,96,106,163,194,197-205` |
| Client IP (hashed, `sha256(ip).slice(0,8)`) | **Yes, if `console.warn`/`error` output is captured** (pm2 default: unbounded/unrotated unless `setup-log-rotation.sh` was manually run) | n/a | `relay.js:213-227` |
| Contact-graph (which `contactId`s belong to one IP) | No (not logged); **yes, momentarily, in the WS `subscribe` message and in `wakeSubs`** for the live-connection lifetime | Lives exactly as long as the WS connection | `relay.js:162,876-889` |
| Message timing | Only implicitly via `notifyWake()` firing synchronously with `store.set()` | Not logged for the real `/packet` hot path (zero `console.log` calls there) | `relay.js:481-492` |
| Message/attachment size | Yes as metadata in the `/transfer/*/chunk/*` request itself (`total`, `mimeType`) — not logged, but visible in the live in-memory transfer record while it exists (up to 24h) | `store` entry, 24h TTL | `relay.js:352-374` |
| Call metadata (type/direction/timestamp per signal: offer/answer/ice/reject/cancel/end) | **No longer logged with `contactId`/`direction`** (redacted per Review 5 fix — confirmed current) | `store` entry, 2 min TTL, extended per signal | `relay.js:728-774` |
| Phone-number-hash correlation | No (not logged); yes in `store` under `phone_*`/`phone_search_*` keys | 5 min TTL | `relay.js:410-478` |
| `deviceId`/pepper fingerprint | No (not logged; only "Registriert"/"gewiped" text, no ID) | `pepperStore`, lives as long as the user keeps that PIN (not on the 5-min cleanup cycle) | `relay.js:79,611-707` |
| TURN usage (NAT-traversal failure signal) | Depends on the (separate) TURN operator's own coturn config — **not suppressed**, see the TURN section below | coturn's own default retention, outside relay.js's control | `coturn-setup.sh` |

---

## Claim 1 — relay.js header: *"Kein Account, keine Metadaten, keine Logs"*

> `relay.js:4-9`: *"Kein klassischer Server ... Kein Account, keine Metadaten, keine
> Logs"*

### 1a. "Kein Account" (no accounts)

**Implementation:** No user/password/session model anywhere in `relay.js`. All routes
are keyed by client-generated, client-controlled identifiers (`contactId`, `deviceId`,
phone-hash) with no registration/login flow, no persisted user table.

**Verdict: PROVEN** — directly demonstrable by reading the full route list; there is
no `store`/Map keyed by "user account" concept anywhere in the file, and no test is
needed because the absence is structural (there is no auth code to test).

### 1b. "keine Metadaten" (no metadata)

**Disproof:** This claim is false in the plain-English sense and the comment three
lines later (`relay.js:157-161`) already concedes as much for the wake-socket path
("nur dass ein subscribe die komplette Kontaktliste auf einen Schlag ... preisgibt,
ist ein bewusster Kompromiss"). Concretely, the relay necessarily observes and
(briefly) retains: source IP per request, `contactId` per call-signal/reconnect/push
route, phone-number-hash pairs, attachment MIME type and chunk count, and call
signal type/direction/timing while a call is in flight (table above). None of this
requires breaking any cryptography — it's inherent to being an HTTP/WebSocket
rendezvous point.

**What is actually true instead:** the relay does not persist **content** (message
plaintext or ciphertext bytes stay in RAM only, `EXPIRE_MS`/`EXPIRE_CALL`-bounded),
and as of the current code it minimizes what routing/identity metadata reaches
*persistent logs specifically* (see Claim 3). "No metadata" should be read as "no
metadata beyond what's structurally required to route packets, and that routing
metadata is largely RAM-only and short-lived" — a materially narrower and weaker
guarantee than the header's literal wording. `SECURITY_REVIEW_2_CRYPTO.md:568`
already flagged this exact scope mismatch ("this claim is about the relay's storage
hygiene, not about what it can see in transit") — this audit independently confirms
that reading is still accurate against the current code.

**Verdict: UNVERIFIED CLAIM as literally worded — DESIGN GOAL for "no *content*
persistence"; the "no metadata" half is not true and is not even claimed to be true
once you read past the header.**

### 1c. "keine Logs" (no logs)

**Disproof:** `relay.js` makes over a dozen `console.log`/`warn`/`error` calls on the
live code path (packet stored/delivered, phone match, reconnect stored, pepper
registered/wiped, call signal type, cleanup counts, TLS fallback warning, etc.).
Whether these become durable "logs" depends entirely on the deployment's process
manager — see Claim 3.

**Verdict: UNVERIFIED CLAIM as literally worded — refined by the file's own later
comment (`relay.js:207-212`) and by `/status`'s honest field (Claim 2) to something
narrower and closer to true, but the header itself is still overstated even after the
Review-5 fix pass.**

---

## Claim 2 — `/status` endpoint's `logs` field

> `relay.js:292-306`: `logs: 'nur Betriebsereignisse, keine IP-/Kontakt-Metadaten'`
> ("only operational events, no IP/contact metadata"), with an explicit comment
> admitting the field previously and dishonestly said `false`.

**Concrete implementation:** confirmed current — the string is accurate about *intent*
(operational-only log lines, `hashIp()` instead of raw IP, no `contactId` in the
call-signal/reconnect/pepper log lines per Claim on Review 5 fixes #2/#3, both
independently re-verified against the current file).

**Adversarial re-check — does "keine IP-...-Metadaten" hold?** Not quite. Every
`registerFail()` call (`relay.js:217-227`, fired on malformed requests, unknown
routes, and 5+ escalating failures) logs `hashIp(ip)` — an 8-hex-character
(32-bit), **unsalted** `sha256(ip)` truncation (`relay.js:213-215`). See Claim 3:
this is not a safe anonymization of an IPv4 address, because the entire IPv4 input
space is small enough to exhaustively hash offline. A hashed value that can be
reversed with a one-time, cheap precomputation is still IP metadata by any
reasonable adversarial standard — it is a *pseudonym*, not an anonymized value. So
`/status`'s claim "keine IP-...-Metadaten" (no IP metadata) is not accurate against
an adversary willing to spend a few CPU/GPU-hours once, ever.

**Would a reader who reads only the header + `/status` form an accurate mental
model?** No. They would reasonably conclude "the relay keeps no record connecting me
to my IP." The actual position is: raw IP is never written to disk by `relay.js`
itself, but a reversible fingerprint of it is written to logs on certain code paths,
and whether those logs are retained at all depends on manual server configuration
the client has no way to verify (Claim 3).

**Verdict: DESIGN GOAL** for the intent and the "no raw IP, no contactId in logs"
mechanism (genuinely implemented, matches Review 5's self-reported fixes #2–#4,
independently confirmed). **UNVERIFIED CLAIM / partially disproven** for the literal
"keine IP-...-Metadaten" wording, because `hashIp()` does not achieve anonymity
against a modestly resourced adversary (see Claim 3).

---

## Claim 3 (new finding, not raised by prior reviews) — `hashIp()` as IP anonymization

> `relay.js:207-215`: *"Kurzer, nicht umkehrbarer Fingerabdruck statt der vollen IP
> fuers Logging"* — "short, **non-reversible** fingerprint instead of the full IP for
> logging."

**Concrete implementation:**
```js
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 8);
}
```
No salt, no pepper, no HMAC key — a bare `sha256(ip)`, truncated to 32 bits.

**Adversarial disproof:** IPv4 address space is 2³² (~4.3 billion) values. An
attacker (or the relay operator themselves, or anyone who later obtains the log
file — including via legal compulsion) can precompute `sha256(ip).slice(0,8)` for
every possible IPv4 address exactly once — a few CPU-hours, trivially parallelizable,
minutes on a GPU — and build a reverse lookup table mapping every possible 8-hex
output back to its IP(s) (with unavoidable but small collision noise from the 32-bit
truncation itself, since the truncation is *also* only 32 bits — a second,
independent source of collisions on top of the birthday bound, meaning "same IP
again" recognition is itself somewhat unreliable). Once built, that table is reusable
forever against any log file from this relay. This is the textbook failure mode
"hashing does not anonymize a small/enumerable input space" — the same class of bug
as hashing unsalted SSNs or phone numbers.

**Comparison against the file's own claim:** the comment explicitly says
"nicht umkehrbar" (non-reversible). That is false. The function is trivially
reversible offline, for a one-time, cheap cost, by design of SHA-256 applied to a
32-bit input domain — no weakness in SHA-256 itself is needed.

**Why prior reviews missed this:** `SECURITY_REVIEW_5_METADATA_PRIVACY.md` (fix #2,
lines 226-229) accepted `hashIp()` as sufficient, characterizing the result as
"no durable plaintext IP record" — true only in the narrowest literal sense (the
*string* "1.2.3.4" isn't written), while the practical privacy property the fix was
supposed to deliver (an operator/log-holder can't attribute log lines back to a
specific IP) is not achieved. This audit's threat model matches Review 5's own
stated one ("assumed to retain and read everything it can passively observe...
indefinitely" — `SECURITY_REVIEW_5_METADATA_PRIVACY.md:303-306`), so this is a direct
gap in that review's own verification, not a stricter/different threat model being
applied here.

**What would actually fix it:** an HMAC with a server-side secret key (`HMAC-SHA256(
serverSecret, ip)`, truncated or not) would be non-reversible without the key, at the
cost of losing the fingerprint's stability across a key rotation — a legitimate,
available fix using only existing primitives (no new crypto protocol), analogous to
how `/turn-credentials` already does exactly this pattern (`TURN_SECRET`-keyed HMAC,
`relay.js:799-811`) elsewhere in the same file.

**Verdict: UNVERIFIED CLAIM — DISPROVEN.** The "non-reversible fingerprint" claim in
`relay.js:207` is factually incorrect for an IPv4 input space; `hashIp()` provides
weak pseudonymization, not anonymization, against any adversary willing to spend a
trivial one-time precomputation cost.

---

## Claim 4 — TLS is "optional" and the relay is still "private"/"secure"

> `relay.js:55-64,836-839`: TLS_CERT_PATH/TLS_KEY_PATH unset → falls back to plaintext
> HTTP with `console.warn('[TLS] ... laeuft ungeschuetzt ueber HTTP.')`, and the
> startup banner prints `Transport: HTTP (unverschluesselt)` prominently
> (`relay.js:950`).

**Concrete implementation confirmed current** at the cited lines. `usingTls` is a
plain boolean that gates nothing else — the server starts and serves normally either
way; there is no hard-fail, no refusal to bind, no forced redirect.

**Does the deployed config actually turn TLS on?** `ecosystem.config.linux.js:25-26`
(the Linux/production config) **does** set `TLS_CERT_PATH`/`TLS_KEY_PATH`.
`ecosystem.config.js` (the Windows/dev config) does **not**, consistent with its own
comment "z.B. fuer lokale Dev-Tests" — this is intentionally scoped to dev use, not a
gap in itself.

**Adversarial question — loud enough to notice?** Partially. The warning and the
banner both exist, but under `pm2 start ecosystem.config.js` in daemon mode (the
documented deployment path), that output goes to a log file nobody is necessarily
watching, not to an interactive terminal a self-hoster is staring at. A new
self-hoster who copies `ecosystem.config.js` (the Windows/dev file, which has no
TLS block at all) instead of `ecosystem.config.linux.js`, or who simply forgets to
provision certs, gets a fully functional, silently-plaintext relay with no runtime
enforcement stopping them — matching exactly the mandate's hypothetical. Every
"private"/"secure" claim elsewhere in the codebase (`App.tsx` "Verschlüsselt · P2P",
the relay's own startup banner calling itself "Secure") is contingent on this
operator-side configuration step that the code cannot itself guarantee happened.

**Verdict: ASSUMPTION.** "The relay is reachable only over TLS" is not proven or
enforced by the code — it depends entirely on the deploying operator's configuration,
is not verified by any test, and fails open (to plaintext) rather than closed.

---

## Claim 5 — WebSocket wake-signal "Bleibt zero-knowledge" (relay-trust sense)

> `relay.js:150-161`, `web/src/lib/RelayClient.ts:230-238`, `RelayClient.js:179-185`,
> and the push-notification plan (line 13): the wake mechanism reveals only
> `{type:'wake', for: contactId}` — no content — so it stays "zero-knowledge" in the
> sense that the relay learns nothing beyond what today's polling already reveals.

**Concrete implementation:** confirmed current. `notifyWake()` (`relay.js:168-177`)
sends exactly `{type:'wake', for: contactId}`, nothing else, to subscribed sockets.
The subscribe protocol (`relay.js:876-889`) accepts `{subscribe: [ids...]}` and
replaces (not accumulates) the previous subscription set per connection.

**Adversarial re-check, independent of Review 5:** the claim of "no more than
today's polling already reveals" is accurate for *content* (still zero — this part
holds), but is **not** accurate for the **speed and certainty** of contact-graph
correlation, exactly as `SECURITY_REVIEW_5_METADATA_PRIVACY.md` finding 3 already
identified: `ws._ip = ip` (`relay.js:868`) binds the entire subscribed contact set to
one concrete IP at the moment of a single WS handshake, rather than requiring the
operator to infer the same graph by correlating scattered polling requests over time.
This audit independently re-derived the same finding from the current code and found
nothing worse than what Review 5 already reported (no additional persistence, no
additional identity binding beyond IP+contact-set, cleanup on `close`/`error` via
`unsubscribeAll()` confirmed correct at `relay.js:179-188`).

**Verdict: DESIGN GOAL, held.** The *content*-blindness part of "zero-knowledge" is
demonstrably true by code inspection (no test explicitly asserts it, but the message
shape is a two-key JSON literal with no code path that could smuggle content into
it). The *"reveals nothing new"* framing is an accepted, explicitly-documented
trade-off (not hidden), but is optimistic about *speed of correlation* — this is
already flagged honestly in the plan doc itself, so it is not a case of documentation
contradicting code; it is a case of the plan being honest about a real cost.

---

## Claim 6 — Phone-number "Zero-Knowledge" connect

> `App.tsx:3144` (**user-facing UI text**): *"🔒 Zero-Knowledge: Nur ein SHA-256 Hash
> deiner Nummer wird temporär gespeichert. Nach dem Verbinden sofort gelöscht."*
> `relay.js:409` (developer comment): *"PHONE LOOKUP (Zero-Knowledge)"*

**Concrete implementation:** `hashPhone()` (`App.tsx:2711-2726`) computes
`sha256('malachi_2026_phone_' + sorted(numberA, numberB))` — a deterministic,
unsalted hash of the *pair* of phone numbers, used purely as a rendezvous key.
`derivePhonePSK()` (`App.tsx:2737-2749`) derives a **separate** value from the same
two numbers (different domain-separation label) used to actually encrypt the
offer/answer exchanged via `/packet`. `relay.js:410-478` stores only the hash and a
client-supplied `chatId`, with a 5-minute TTL, deleted on match or explicit cancel.

**Sub-claim: "only a hash is temporarily stored, deleted immediately after
connecting."** **PROVEN** — directly readable in `relay.js:410-478`: every code path
either deletes the `phone_*`/`phone_search_*` entries explicitly (on match pickup,
line 462-463; on explicit DELETE, line 472-478) or lets the 5-minute TTL expire them
via the general cleanup interval (`relay.js:915-934`). No test explicitly proves the
TTL fires, but the logic is unconditional and simple enough that structural reading
suffices.

**Sub-claim (implicit in "Zero-Knowledge"): the relay learns nothing useful.**
**Disproven**, and this is a case where **developer comments are honest but the
end-user-facing UI text is not**. `SECURITY_REVIEW_1_REDTEAM.md` (finding 2) and
`SECURITY_REVIEW_2_CRYPTO.md:564` already established, and this audit independently
confirms against the current code, that:
- The rendezvous hash is *not* a secret — it's derived only from the two phone
  numbers with no additional entropy. **Anyone who knows both numbers** (an
  acquaintance, a leaked contact list, or the relay operator *if* they already
  suspect two specific numbers and can compute the hash to check) can register or
  look up that same hash and inject themselves as a participant.
- `derivePhonePSK()` narrows this to "an observer who does NOT know both numbers
  cannot decrypt the offer/answer" — a real improvement (the C-2 fix), but the
  code's own comment at `App.tsx:2728-2736` states outright that this "closes only
  passive eavesdropping by someone who doesn't know both numbers" and explicitly
  does **not** protect against someone who does. That nuance exists in the developer
  comment. **It does not exist anywhere in the end-user-facing string at
  `App.tsx:3144`**, which just says "Zero-Knowledge" with no caveat.
- `/phone/lookup`'s "not found" path is rate-limited (`phoneLookupMisses`,
  `relay.js:110-124`, cap 20/5min per IP) but not eliminated — a patient attacker can
  still slowly enumerate candidate phone-number hashes across many IPs or over many
  windows to test "is this number currently trying to connect on Malachi right now,"
  a contact-discovery side channel `SECURITY_REVIEW_5_METADATA_PRIVACY.md` finding 6
  already flagged and which the rate limit only slows, doesn't close.

**Verdict:** "Only a hash is stored, deleted after connecting" — **PROVEN**.
"Zero-Knowledge" as a blanket label on the end-user-facing string — **UNVERIFIED
CLAIM, disproven for the specific and realistic case of an adversary (including a
malicious relay operator with side information, or anyone who obtains both phone
numbers through any channel) who knows both participants' numbers**, which is
exactly the scenario the feature is invoked for (you already know who you're
connecting to). This is a genuine gap between what the developer comments concede
and what the user is told.

---

## Claim 7 — TURN/coturn: what can the TURN operator observe?

> `relay.js:791-811` comment: TURN credentials are short-lived, HMAC-derived, replace
> a previously hardcoded shared password.

**Concrete implementation:** `/turn-credentials` mints a standard REST-API-style
`username:credential` pair using `TURN_SECRET` (server-only env var) via
`HMAC-SHA1`, 6-hour TTL (`relay.js:799-811`) — a correct implementation of coturn's
documented `--use-auth-secret` scheme.

**Adversarial reading of `coturn-setup.sh` (full file, 58 lines):**
- Line 32-33: `no-tls` / `no-dtls` are **explicitly set** in `/etc/turnserver.conf`.
  This is not "TLS optional and defaulted off" (as with `relay.js`'s main HTTP
  server) — it is **actively disabled** by this setup script, on every deployment
  that uses it unmodified. Practical effect: the STUN/TURN **control-channel**
  traffic between a client and the TURN server (allocation requests, permissions,
  channel binds — i.e., metadata about which peer IP:port pairs are being relayed,
  and for how long) travels in cleartext over the network. This is distinct from,
  and does not by itself break, the WebRTC media itself, which is separately
  protected by DTLS-SRTP at the application layer (`App.tsx:2635`: "WebRTC ·
  DTLS-SRTP") — that part is a cryptographic-protocol claim outside this audit's
  scope, and this audit treats "DTLS-SRTP protects the media payload even when
  relayed through an unencrypted-transport TURN server" as an **ASSUMPTION** it did
  not itself re-derive from the WebRTC stack's implementation. But the TURN
  *control*-channel cleartext-metadata exposure itself is a directly-observed,
  concrete finding not previously called out by name in `SECURITY_REVIEW_5` (which
  only noted coturn's own logging is unsuppressed, not that its transport is
  explicitly unencrypted).
- coturn's own stdout/logging is not suppressed (`no-cli` is set, but no
  `no-stdout-log`, `syslog`, or log-rotation directive appears anywhere in the 58-line
  script) — independently re-confirmed matching Review 5's finding.
- The TURN operator, if a genuinely separate party from the relay operator, only
  learns `TURN_SECRET` if the person running `coturn-setup.sh` is handed it
  (`TURN_SECRET=<value> bash coturn-setup.sh`, line 7) — i.e., trust in the TURN
  operator is a deliberate, explicit choice by whoever deploys it, not something the
  code silently assumes. If that operator's box is compromised, the leaked
  `TURN_SECRET` lets an attacker self-mint valid TURN credentials (since it is the
  *same* secret relay.js uses to mint them) — a moderate-severity secondary risk, not
  examined in prior reviews.
- **What the TURN operator can learn even without breaking any crypto:** that two
  specific real IP addresses are attempting a call, roughly when, for how long
  (allocation/session lifetime), and — since NAT-traversal-via-TURN only happens when
  direct P2P failed — an implicit signal about both parties' network topology
  (symmetric NAT / restrictive firewall). This matches `SECURITY_REVIEW_5`'s existing
  framing; this audit adds the transport-cleartext angle as new.

**Verdict: DESIGN GOAL** for the credential-issuance mechanism itself (short-lived,
HMAC-derived, not hardcoded — genuinely implemented as claimed). **ASSUMPTION** that
DTLS-SRTP protects media confidentiality end-to-end through an unencrypted-transport
TURN relay (not verified in this audit's scope). **UNVERIFIED CLAIM /
previously-unflagged gap**: no claim anywhere says TURN transport is encrypted, but
nothing flags that it's explicitly disabled either — a reader relying on the general
"Verschlüsselt" framing elsewhere in the app could reasonably be surprised that the
TURN control channel is plaintext by explicit configuration choice.

---

## Claim 8 — `FLAG_SECURE` = "secure" (`MainActivity.kt:14-17`)

**Concrete implementation:**
```kotlin
window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
```
Applied unconditionally in `onCreate()`, for the whole app (not scoped to individual
sensitive screens).

**What this demonstrably does:** per the Android platform's own documented behavior,
`FLAG_SECURE` (a) blacks out the app's content in the Recent Apps / app-switcher
thumbnail, and (b) causes the standard OS screenshot mechanism and the
`MediaProjection`-based screen-recording/casting APIs (Android 9+) to produce a black
frame instead of app content.

**Adversarial disproof of the broader "secure" implication:**
- **A rooted device** can bypass this entirely — root grants access to the
  framebuffer/SurfaceFlinger at a privilege level `FLAG_SECURE` does not defend
  against (it's an app-cooperative OS policy honored by the standard capture APIs,
  not a hardware/DRM-backed content-protection path like Widevine L1). A rooted
  device can also simply patch the installed APK to remove the flag, or use
  root-level screen-capture tools that read the graphics buffer directly.
- **ADB-based screen recording** (`adb shell screenrecord`) is, on most stock Android
  versions, also blacked out by `FLAG_SECURE` (it shares the same capture path as
  `MediaProjection`) — so this specific case in the mandate's question is actually
  covered, not a gap, on unmodified devices. This was worth verifying rather than
  assuming either way.
- **Accessibility-service-based screen readers**: modern Android (varies by OS
  version/OEM) generally still honors `FLAG_SECURE` against most accessibility-based
  capture paths, but this is OS-version-dependent behavior outside this app's
  control, and a malicious accessibility service with sufficiently elevated
  permissions (which the user would have had to explicitly grant) is a boundary this
  flag was never designed to hold against.
- **Physical capture** (another camera photographing the unlocked screen) is
  obviously unaffected — inherent to any on-screen-rendering app, not a code gap.

**Verdict: DESIGN GOAL, narrowly scoped and accurately effective for its actual
purpose** (screenshot and screen-recording-API blocking). **ASSUMPTION** for
anything beyond that: the guarantee depends on the device not being rooted/patched
and on the OS honestly enforcing the flag — neither of which the app can verify or
enforce itself. No claim in the repo overstates `FLAG_SECURE`'s scope explicitly (no
string in the codebase says "prevents all screen capture" or similar) — the gap here
is entirely in what a reader might *assume* "secure" means, not in an explicit false
statement.

---

## Claim 9 — Biometric/PIN lock gates access to encrypted data

This is the most consequential finding in this audit's scope, and it splits sharply
between the native app and the web client.

### Native app (`App.tsx` `LockScreen`, lines 963–1240)

**Concrete implementation:**
- The stored PIN (`EncryptedStorage.getItem('app_pin')`) is compared with plain
  string equality: `if (next === savedPin)` (`App.tsx:1079`). Confirmed via grep: `pin`
  is never referenced in `MessageCrypto.js`, `HybridCrypto.js`, `ImageCrypto.js`, or
  `AudioCrypto.js` — **the PIN is never used to derive any encryption key anywhere in
  the native app.**
- Biometric check: `rnBiometrics.simplePrompt({...})` (`App.tsx:1021-1029`) — on
  `success`, directly calls `onUnlock()`. `simplePrompt` is `react-native-biometrics`'
  presentation-only mode (a yes/no OS dialog); nothing in this repo uses that
  library's `createKeys`/`createSignature` `CryptoObject`-binding mode, and no
  `setUserAuthenticationRequired`-style Keystore key binding appears anywhere in the
  repo (grepped, zero matches).
- The actual confidentiality of chat data at rest is provided entirely by
  `react-native-encrypted-storage` (Android-Keystore-backed), independent of whether
  the PIN or biometric check ever ran.

**Adversarial conclusion:** passing the PIN/biometric screen does **not** unlock a
cryptographic key derived from anything the user just proved knowledge/possession
of. It flips a React state variable (`nav('home')` / `onUnlock()`). The actual
data-at-rest protection is whatever `react-native-encrypted-storage`'s native
Android-Keystore integration provides on its own, all the time, regardless of the
lock screen. This means: **the PIN/biometric screen is a UI-level access gate, not a
cryptographic access gate.** Anyone who can reach the same `EncryptedStorage` API
surface the legitimate app uses — a patched/instrumented build, an
Android-accessibility-based UI-automation exploit that drives the app without
knowing the PIN, or a debuggable build on a device the attacker controls — bypasses
the "lock" without needing to know the PIN or defeat the biometric sensor at all,
because that data was never gated on either. This is not tested anywhere in
`__tests__/` (no test constructs this bypass or asserts the PIN participates in key
derivation — because it doesn't).

This is a real, previously-unflagged (grepped `SECURITY_REVIEW_1`–`6`, none discuss
whether the PIN participates in key derivation) architectural gap in the "lock
screen" framing.

### Web client (`web/src/lib/Storage.ts`) — contrast

**Concrete implementation:** materially different and stronger. `unlockEncryption()`
(lines 114-169) derives a real AES-256-GCM key via `PBKDF2` (210,000 iterations) over
`pin + ':' + pepper`, where `pepper` must be fetched live from the relay
(rate-limited, wipes after 5 failures — `relay.js:643-669`). `getItem()`
(`Storage.ts:175-180`) returns `null` whenever the in-memory `dek` is unset — i.e.,
**every** local-storage read is actually gated behind a key that cannot be derived
without both the correct PIN and a currently-valid, rate-limited server pepper. This
is a genuine cryptographic gate, not just a UI gate, and the file's own comment is
explicit and honest about the trade-off this requires ("Entsperren braucht jetzt eine
Verbindung zum Relay ... kein Offline-Modus").

**Verdict:** Native app — **UNVERIFIED CLAIM, disproven**: "PIN/biometric protects
your data" is not true in the sense a reasonable user would understand it; it is true
only in the narrower sense "the app's UI won't show your chats without it," while the
underlying `EncryptedStorage` blob is equally accessible with or without ever
entering the PIN correctly, to anyone with API-level access to the running app.
**Web client — DESIGN GOAL, strongly implemented** and arguably closer to PROVEN by
construction (`getItem()` structurally cannot return plaintext without a valid `dek`)
— though no automated test in `__tests__/security/` currently exercises
`web/src/lib/Storage.ts` directly (all existing security tests target the RN app's
`MessageCrypto.js`/`relay.js`, not the web `Storage.ts` module), so full "PROVEN"
status is withheld pending such a test.

---

## Claim 10 — "Anonymous" / "anonym"

**Grepped the entire repository (case-insensitive) for `anonym`.** The only hits are
in `SECURITY_REVIEW_5_METADATA_PRIVACY.md` itself, describing the relay as
*"non-anonymized"* and noting anonymity-network architectures are explicitly out of
scope by the project owner's own prior decision. **The word "anonymous"/"anonym" is
never used as a claim anywhere in the app's code, comments, or user-facing strings.**

This matters because it means there is no explicit "anonymous" claim to disprove —
only the "Zero-Knowledge" framing (Claims 5/6) which is weaker and more scoped than
anonymity would be. Tracing what identifying information actually reaches the relay
regardless (confirmed above): raw IP on every request, `contactId` on every
routed request, phone-number-pair hash on phone-connect, `deviceId` prefix on pepper
operations, FCM token + contact/direction on push registration (currently dead code,
see Claim 12). None of this is "anonymous" by any standard definition, and nothing
in the repo claims it is.

**Verdict: Not a claim made in this repo — confirmed absent, not disproven, because
there was nothing to disprove.** Anyone inferring "anonymous" from the
"Zero-Knowledge" language would be extrapolating beyond what the app actually says.

---

## Claim 11 — "Private" — private from whom?

Searched for phrasing that could imply protection from a *paired contact's* own
device compromise, screenshotting, or forwarding (`nur du und dein Kontakt`,
`niemand außer`, etc.) — **no matches found** anywhere in `App.tsx` or the web
client. The only related string is the standard, narrowly-scoped
`"Ende-zu-Ende verschlüsselt"` / `"Verschlüsselt · P2P · WebRTC"` labeling on the
call screen (`App.tsx:2622,2634`), which is a transport/server-confidentiality claim,
not a claim about what a contact does with the plaintext once decrypted on their own
device. `FLAG_SECURE` (Claim 8) additionally only protects the *local* device's
screen against the *local* device's own OS-level capture, not anything on the far
end.

**Verdict:** No instance found in the codebase where "private" is used in a way that
over-claims protection from a legitimate contact's own device/behavior. This appears
to be a real gap in *what the app can technically guarantee* (any contact can always
screenshot or forward what they legitimately received — inherent to any messaging
app, not a Malachi-specific flaw) but **not** a case of the app's own claims
misrepresenting that scope. **DESIGN GOAL / not applicable** — the boundary is
correctly implicit and not contradicted by any string in the repo.

---

## Claim 12 — Push notification plan's "zero-knowledge-compatible" framing vs. FCM reality

> Push plan, line 13: *"Kein neuer Kryptografie-Baustein nötig ... bleibt
> zero-knowledge: der Relay sieht nur 'für Kontakt X liegt etwas Neues vor', nie
> was."*
> `pushSender.js:1-5`: *"Sendet AUSSCHLIESSLICH ein opakes Wecksignal ... Keine
> Kontakt-IDs, keine Inhalte, keine Metadaten außer Zeitpunkt der Zustellung."*

**Concrete implementation, re-verified against current code:** `sendWake()`
(`pushSender.js:34-49`) sends only `{ data: { reason } }` to FCM, `reason` being one
of exactly two enum strings. This is accurate as far as it goes — **but it is a claim
about what *Malachi's own server* sends to Google, not about what Google (a
completely separate third party outside the "self-hosted, zero-knowledge relay"
trust boundary) additionally learns on its own** by virtue of operating the FCM
delivery infrastructure: which device (tied to a Google-registered FCM token, itself
correlatable to a Google account/Android device identity Google already controls)
received a wake at what time, from which server. Neither the plan nor
`pushSender.js`'s comment addresses this — the claim's scope is implicitly "what our
own code sends," not "what any party in the delivery path learns," and a reader could
easily conflate the two given the surrounding "zero-knowledge" framing used
elsewhere in the same files.

**Is this live in the current app?** No — independently confirmed by grep: 
`RelayClient.js`'s `registerPushToken()` and `CallBridgeModule.kt`'s `getFcmToken()`
are defined but **never called** from `App.tsx`. This matches the push plan's own
"Context" section, which describes this exact path as *"totes Wissen"* (dead code,
no device today ever registers a token). `relay.js`'s `/push/register` endpoint and
`triggerWake()` are consequently unreachable in practice under the current app. This
audit independently confirms the plan's own characterization rather than taking it
on faith.

**Verdict: DESIGN GOAL** for the relay-to-FCM payload minimization (genuinely
content-blind, as far as Malachi's own code is concerned). **ASSUMPTION**, unaddressed
anywhere in the repo, that Google/FCM itself does not constitute a metadata-visible
third party outside the "zero-knowledge" boundary — the claim's scope is implicitly
narrower than "zero-knowledge" would suggest to a reader who doesn't already know FCM
architecture. **Currently moot in practice** since the path is dead code, not wired
into the shipping app.

---

## Summary of where this audit diverges from `SECURITY_REVIEW_1`–`6`

- **Confirms, independently re-derived:** Review 5's core finding that pm2's default
  logging previously contradicted the "no logs" claim, and that the current code's
  redaction fixes (hashed-not-raw IP in logs, no `contactId` in call-signal/reconnect/
  push logs, honest `/status` text, `/phone/lookup` throttling) are genuinely present
  in the current `relay.js` — this audit re-read the file line-by-line and agrees the
  self-reported fixes are real, not just claimed.
- **Confirms, independently re-derived:** Review 5's WS-wake IP-binding finding
  (finding 3) and found nothing worse in the same mechanism.
- **New, not raised by any prior review:** `hashIp()`'s "non-reversible fingerprint"
  claim is false for an IPv4 input space — this is a concrete, currently-live gap in
  the very fix Review 5 credited as done (Claim 3).
- **New, not raised by any prior review:** `coturn-setup.sh` explicitly sets
  `no-tls`/`no-dtls`, not merely "TLS not configured" — an active configuration
  choice with direct metadata-exposure consequences on the TURN control channel
  (Claim 7).
- **New, not raised by any prior review:** the native app's PIN/biometric screen does
  not gate a cryptographic key anywhere — it is a UI-only access control layered on
  top of `EncryptedStorage`'s independent, always-available OS-Keystore encryption
  (Claim 9). This is arguably the most user-consequential gap found in this audit,
  since it directly contradicts the ordinary-user's mental model of what a PIN/
  biometric "lock" does, and no prior review examined whether the PIN participates in
  key derivation.
- **Confirms and sharpens:** the developer-vs-user-facing text gap on the phone
  "Zero-Knowledge" connect flow (Claim 6) — Reviews 1/2 established the cryptographic
  limits precisely; this audit adds that those limits are accurately caveated in code
  comments but not at all in the one string the actual end user reads.
