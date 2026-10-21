# Security Review 5 — Metadata Privacy Analysis

**Threat model for this review:** the relay operator (or a network-level observer
positioned between clients and the relay — ISP, coffee-shop wifi, anyone on the
transit path) is **honest-but-curious**: it can never break the AEAD or forge/tamper
content (that's Reviews 1-4's territory), but it sees everything about connection
*patterns*, *timing*, *sizes*, and *routing* that isn't itself hidden. The question
this review answers: what can such an observer learn about who talks to whom, when,
how often, and what kind of content, without ever decrypting a single byte?

Scope read for this review: `relay.js` (in full), `MessageCrypto.js`/`.ts`,
`ImageCrypto.js`, `AudioCrypto.js`, `WebRTCManager.js` (cover-traffic and wake-related
sections), `RelayClient.js` (WS wake-socket client), `App.tsx` (poll intervals and
wake wiring), `ecosystem.config.js`, `ecosystem.config.linux.js`, `coturn-setup.sh`,
and the push-notification architecture plan
(`sprightly-bouncing-milner-push-notifications.md`). This builds on Review 3's
Q1/Q8/Q10 (attachment metadata, push-token mapping, cover-traffic scoping, TURN
correlation — treated as ground truth, re-examined only through the metadata lens)
and on the push plan's own documented `{subscribe:[...]}` contact-graph trade-off
(not re-reported as new; extended where this review found something additional).
This is a read-only analysis pass — no code was changed.

---

## METADATA EXPOSURE FOUND

Ranked by practical severity for a realistic hobbyist self-hosted single-operator
deployment (not a global-passive-adversary scenario, which is out of scope).

### 1. (High) pm2's default logging directly contradicts the relay's own "no logs" claim — and the contradiction is worst for exactly the log lines that matter most

`relay.js:8` states the design goal in the file header itself: *"Kein Account, keine
Metadaten, keine Logs"*. The `/status` endpoint even asserts this to clients as a
literal API field: `relay.js:239` returns `logs: false`.

In reality, `relay.js` makes 21 `console.log`/`warn`/`error` calls (grep-confirmed),
and neither `ecosystem.config.js` nor `ecosystem.config.linux.js` sets any
log-shaping option at all — no `out_file`, `error_file`, `log_date_format`, or
`max_size`, and no `pm2-logrotate` module is installed or referenced anywhere in the
repo. Under pm2's undocumented-but-well-known default behavior, that means every one
of those lines is captured verbatim, unbounded, and un-rotated to
`~/.pm2/logs/malachi-relay-out.log` / `-error.log`, persisting indefinitely — long
after the corresponding in-memory `store` entry (10 min for messages, 2 min for call
signals, `EXPIRE_MS`/`EXPIRE_CALL`) has expired.

What actually ends up there:
- Full client IP addresses on every failed/malformed request (`relay.js:182`,
  `:186-187`).
- `deviceId` prefixes on pepper register/wipe events (`relay.js:91`, `:545`).
- `contactId` prefixes + call **direction/role** on every push-token registration
  (`relay.js:651`).
- `contactId` prefixes + reconnect events (`relay.js:448`).
- **The single worst line in the file**: `contactId` prefix + `direction` + the exact
  signal `type` (`offer`/`answer`/`ice`/`reject`/`cancel`/`end`) on *every single call
  signal*, twice over — once for the cancel/end/reject cleanup branch
  (`relay.js:678`) and once for every other signal type (`relay.js:689`).

**Important nuance on the "prefix" framing**: `contactId` is `'c_' + 8 hex chars`,
and per Review 3 Finding B those 8 hex chars are only a 32-bit truncation of the
Kyber-pubkey-derived token (`App.tsx:2809-2811`) — i.e. `contactId` *is* essentially
just that 8-char string. So `contactId.slice(0,8)` in these log lines is not a
harmless partial redaction; it is, for practical purposes, logging the entire
meaningful routing identifier.

Net effect: the in-memory TTLs the relay advertises for privacy (`EXPIRE_CALL` = 2
minutes) are irrelevant to an operator reading logs — the structured metadata already
escaped to disk the instant each `console.log` fired, and stays there forever absent
manual cleanup.

### 2. (High) Call metadata is a complete, structured call-detail record (CDR) — categorically worse than regular-message metadata

Building on the review's own framing: `/call/signal` (`relay.js:660-700`) stores
`type`/`direction`/`ts: Date.now()` server-side per signal (`relay.js:687`), and every
state transition — offer, ICE exchange, answer/reject/cancel, end — is a separately
typed, separately logged event (`relay.js:678`, `:689`). Compare this to the actual
message-delivery path, `POST /packet` (`relay.js:413-424`), which has **zero**
`console.log` calls of any kind, and which the relay only ever sees as "an opaque
ciphertext blob of size X was stored for `recipient`" — no semantic label, no
in-memory log line for legitimate traffic at all.

So for calls, an operator (from either the live in-memory `store` while it exists, or
the persistent log per finding 1) can reconstruct: exact call start time, ring
duration, whether it was answered / rejected / cancelled / left unanswered, who
initiated (`direction`), and end time/duration — a full CDR, per call, forever. For
text messages, by contrast, the relay only ever learns "some bytes moved," with no
log trail on the hot path at all.

TURN adds a second (often same-operator) data point on top: `/turn-credentials`
requests (`relay.js:725-737`) time-correlate with call attempts regardless of whether
the P2P attempt actually needed TURN to succeed. New detail this review adds:
`coturn-setup.sh` does not disable or suppress coturn's own default logging (no
`no-stdout-log`/`syslog` suppression, no rotation configured) — so if TURN media
relay *is* actually used (NAT traversal failure), a **third**, entirely separate
persistent log (coturn's own, outside relay.js/pm2, on whatever box runs
`coturn-setup.sh`) independently captures IP-to-IP relay session timing/duration.
This is infrastructure the earlier crypto-focused reviews didn't examine.

### 3. (Medium-High) The WS wake-signal binds the full contact graph to one live IP instantly — extends the already-documented trade-off with an IP-correlation angle

The push plan already documents (and the project owner already accepted) that a
one-shot `{subscribe:[contactId,...]}` reveals the full correlated contact set at
once, vs. polling's gradual reveal. This review adds the piece the plan doesn't spell
out: that one-shot reveal happens over a single TCP/WS connection whose
`remoteAddress` the relay captures right at upgrade time (`ws._ip = ip`,
`relay.js:794`). So the operator doesn't just eventually learn "these `contactId`s
correlate" — it learns "this exact IP, right now, owns this exact contact set" in the
time it takes one WebSocket handshake to complete. That's a materially faster and
more certain correlation than inferring the same graph from polling patterns across
(possibly IP-rotating, e.g. mobile-carrier-NAT) source addresses over days.

`RelayClient.js:236-240`'s `NetInfo`-triggered reconnect additionally gives the
operator an explicit "this IP↔contact-graph binding just changed networks" event on
every WiFi/mobile handoff — a live network-transition signal that plain polling never
produced as a discrete, easily-flagged event.

### 4. (Medium) Low-latency push trades away polling's timing obfuscation

`checkIncomingCalls`/`checkOutgoing`/`checkIncoming` poll every 2s/15s/8s
respectively (`App.tsx:227`, `:565`, `:798`). Before the wake signal existed, a
message sent at time T was only observable-as-delivered somewhere in an up-to-15s
window — smearing the exact send time from any outside observer's perspective.

Now, `notifyWake()` (`relay.js:140-149`) fires synchronously with the triggering
`store.set()` — `POST /packet` (`relay.js:422`), `/reconnect/offer`
(`relay.js:447`), `/reconnect/answer` (`relay.js:472`), every `/call/signal` type
(`relay.js:696`) — and `RelayClient.js:218-225`'s `onmessage` immediately fans that
into an instant poll trigger (`App.tsx:231`, `:566`, `:799`). A network-level
observer who can see WS frame timing on *both* parties' sockets (not the relay
operator — an outside eavesdropper, consistent with this review's threat model) can
now correlate "wake frame lands on Bob's socket" with "packet frame just left
Alice's socket" to sub-second precision — recovering send time far more precisely
than the old poll-smeared model ever allowed. This is a real, additional trade
against timing privacy, distinct from the contact-graph trade-off already documented.

### 5. (Medium) Attachment size/type side-channel (confirmed at the source level, extends Review 3 Q1/Q10)

Reading `MessageCrypto.js:77-106`/`:108-134` confirms the triple-AEAD adds only
constant per-layer overhead (12/12/24-byte nonces plus fixed AEAD tags) — ciphertext
length tracks plaintext length exactly, it does not hide size. `ImageCrypto.js:9`
and `AudioCrypto.js:8` both chunk at a fixed `CHUNK_SIZE = 64 * 1024`, and
`relay.js:292-300` stores `total` (chunk count) and `mimeType`/`transferType` in
cleartext on every `/transfer/{token}/chunk/{index}` upload — so an observer learns
the exact chunk-count-derived size class and the literal MIME string for every
attachment, unconditionally.

Cover traffic (`WebRTCManager.js:28-29`, `:436-452`) pads real-time chat DataChannel
messages to fixed 512-byte plaintext blocks (`PAD_BLOCK_SIZE`) and injects
same-shaped dummy packets every fixed 3s (`COVER_INTERVAL_MS`) — real and effective,
but **only** for the live P2P `sendMessage()` DataChannel path. Confirmed it is *not*
applied to: `/transfer` chunk uploads (still exposes the 64KB-granularity size
class), the `/packet` offline-fallback path (no padding call anywhere in that
handler), or any reconnect/signal/call-signal SDP blob. So an offline text message —
routine, not an edge case, since it's the fallback for any recipient not currently
P2P-connected — is not size-padded at all; its ciphertext length reveals its
plaintext length directly.

### 6. (Low-Medium) `/phone/lookup` enumeration is unthrottled

`relay.js:367-385`: a "not found" result on `/phone/lookup` is a normal HTTP 200 JSON
response (`{found:false, role:'initiator'}`) and does **not** call `registerFail` —
confirmed by reading the full handler, only the `catch` block (malformed JSON) does.
So it never counts toward the 5-strikes `blockedIPs` mechanism. An attacker who can
precompute candidate phone-number hashes (the hash function itself was already
reviewed for strength in Reviews 2/3) can probe an unbounded number of them from one
IP with zero relay-side friction, distinguishing "registered/pending" vs "never
seen" per hash — a contact-discovery/enumeration channel bounded only by the
attacker's own request rate, not by anything the relay enforces.

### 7. (Low) `contactId` never rotates — correlation is re-derivable forever

Nothing in `relay.js`, `App.tsx`, or the push plan rotates `contactId` after initial
pairing. It's the permanent key for `/reconnect/offer/{contactId}`,
`/call/signal/{contactId}/*`, `/push/register`, and now the WS `subscribe` list, for
the entire lifetime of the pairing. The social-graph correlation in finding 3 isn't a
one-time event at pairing — it's re-derivable by the operator at will, from any
later traffic burst under the same identifier, with no expiring pseudonym ever
making old correlations go stale.

---

## ALREADY MITIGATED / ACCEPTABLE TRADE-OFFS

- **The WS wake-signal's one-shot contact-graph exposure is a consciously accepted
  trade-off**, explicitly documented in the push-notification plan's "Bekannte,
  nicht schönredbare Grenzen" section and mirrored in `relay.js:122-133`'s own
  comment block. For a self-hosted single-operator relay this review agrees the
  trade-off is reasonable; it only adds the IP-binding (finding 3) and timing
  (finding 4) nuances the plan didn't spell out.
- **Full client IPs are not logged on the happy path.** `registerFail()`
  (`relay.js:179-189`) is the *only* place `ip` is ever passed to `console.*`, and it
  only fires on malformed/missing-field requests, unknown routes, or explicit
  business-logic failures. Successful `/packet`, `/call/signal`, `/reconnect/*` POSTs
  never log the requester's IP. Worth crediting even though it's incomplete.
- **The actual message-delivery hot path is silent.** `POST /packet`
  (`relay.js:413-424` — confirmed by Review 3 to be the only path real chat traffic
  uses, since `/send`/`/receive` are dead code) has zero `console.log` calls. No
  token, recipient, or size is logged for ordinary message delivery.
- **TLS is available and fails loudly, not silently**, into plaintext
  (`relay.js:762-765` logs a warning rather than pretending to be secure) — cuts
  outside network observers out of the picture entirely for findings 4/5 whenever
  configured, per `relay.js:56-64`'s own comment and Reviews 1-4's existing coverage.
- **Cover traffic is real and correctly scoped for its stated purpose** — fixed
  cadence, fixed size (`WebRTCManager.js:25-27`'s own changelog note says the
  earlier version padded only dummies, not real traffic; that's fixed now), and does
  defeat size-based traffic analysis for live P2P text chat specifically.
- **TURN credentials are short-lived (6h TTL) and HMAC-derived per request**
  (`relay.js:733-737`), replacing a previously hardcoded shared password — narrows
  (does not eliminate) the window for stolen-credential replay/correlation.
- **Push payload content itself carries no metadata** beyond a bare `reason` enum
  (already verified content-blind in Review 3 Q8) — this review's logging concern is
  about the *registration* log line (`relay.js:651`), not the push payload.

---

## RECOMMENDED FIXES (no new cryptography, no architecture change)

Status as of the follow-up fix pass: items 1-7 are done; item 8 remains deliberately
deferred (see its own entry below).

1. ~~Add pm2 log rotation + a retention cap.~~ **Done** — `setup-log-rotation.sh`
   installs and configures `pm2-logrotate` (10MB max size, 7-day retain, compressed).
   Not an ecosystem.config.js field (pm2-logrotate is a separate global module), so
   this has to be run once on the server; `ecosystem.config.linux.js` now has a
   comment pointing to it. **Not yet executed on the production server** — the
   project owner needs to run it there.
2. ~~Stop logging full client IPs even on failure paths.~~ **Done** — `relay.js`'s
   new `hashIp()` (`sha256(ip).slice(0,8)`) replaces the raw IP in `registerFail()`'s
   warn/error lines. Still lets an operator recognize "same IP again" for abuse
   patterns, no durable plaintext IP record.
3. ~~Drop contactId/deviceId prefixes from log lines that don't need them.~~ **Done**
   — pepper wipe/register, reconnect offer, push-token registration, and both
   call-signal log lines (the CDR-building one) all redacted to plain event-count
   logs with no identity/routing data. The dead `/send`/`/receive` routes' logs were
   redacted too for consistency, though they carry no live traffic.
4. ~~Make `/status`'s `logs: false` claim true, or remove it.~~ **Done** — now
   reports `"nur Betriebsereignisse, keine IP-/Kontakt-Metadaten"` instead of a flat
   (and after items 1-3, more accurate but still slightly misleading) `false`.
5. ~~Rate-limit `/phone/lookup` "not found" responses per IP.~~ **Done** — a
   dedicated `phoneLookupMisses` counter (20 misses / 5 min per IP, independent from
   the stricter general `registerFail` counter since "not found" is the expected
   common case) escalates into the existing `registerFail`/`blockedIPs` machinery
   after repeated abuse. 3 new tests in `relay.http.test.js` cover both the normal
   case and the escalation path.
6. ~~Extend the existing `padToBlock` padding to the `/packet` offline-fallback text
   path.~~ **Done** for the routine text-message case (both `App.tsx` and
   `web/src/App.tsx`'s relay-fallback send). Reconnect/signal/call-signal SDP
   payloads remain unpadded — deliberately out of scope for this pass (SDP blobs
   already vary in size by ICE-candidate count for reasons unrelated to message
   content, so the marginal privacy benefit is smaller and the risk of subtly
   breaking WebRTC signaling was judged not worth it without dedicated interop
   testing).
7. ~~Bucket attachment chunk sizes instead of leaving `total` exact.~~ **Done** —
   `padLastChunk()` in `ImageCrypto.js`/`AudioCrypto.js` pads the final (partial)
   chunk up to the full `CHUNK_SIZE`, carrying a `realLen` field so the receiver
   trims it back exactly on reassembly. An observer now only learns the attachment's
   size to the nearest 64KB instead of its exact byte count. Verified with 7 new
   tests (`chunkPadding.test.js`) proving byte-exact round-trip across several sizes
   (including the exactly-divisible and one-byte-over edge cases) using the real
   send/receive functions, not a mirror.
8. **Still deferred: rotating the routing-layer identifier independently of
   `contactId`.** Explicitly flagged in the original review as "more involved than
   items 1-7... should be scoped separately" — unchanged in this pass. Remains a
   real candidate for future work, not attempted here.

---

## ARCHITECTURAL LIMITATIONS (accepted by design, not bugs)

- **Direct-connect, non-anonymized relay.** Every client's real IP is visible to the
  relay operator on every request (HTTP or WS) — there is no Tor/mixnet/onion layer,
  and per this review's brief the project owner has already decided against building
  one, given the Sybil/traffic-analysis complexity for a hobbyist single-operator
  deployment. This is the root cause behind findings 1-4; the recommended fixes
  reduce what gets *persisted* or *correlated faster* than the bare architecture
  already implies — they do not remove the underlying visibility.
- **Single shared relay = single point of correlation.** One operator's process sees
  all clients' traffic (no sharding across independent relays), so any two
  `contactId`s that ever transact are, by construction, visible to the same party.
  Inherent to "self-hosted single relay," not fixable short of federation or a
  mixnet — both explicitly out of scope.
- **TURN, when actually used, is a second metadata-visible party.** coturn's own
  logging/retention (`coturn-setup.sh`) is a standard third-party daemon outside this
  codebase's control surface; hardening it further is a coturn-configuration
  exercise, not something relay.js or the app's crypto layer can address.
- **Push-vs-poll is a fundamental trade-off, not a fixable bug.** A live WebSocket
  connection is inherently a stateful, addressable network identity for as long as
  it's open; any low-latency push channel (WS, FCM, or otherwise) necessarily trades
  away the timing obfuscation that only high-latency polling provides "for free."
  Finding 4 is a property of *having* real-time push at all, not of this specific
  implementation.
- **Fixed chunking for large attachments is bounded by needing *some* fixed
  size for offline store-and-forward.** Unbounded single blobs would worsen memory
  pressure against the relay's own 50MB RAM-only eviction logic
  (`relay.js:850-858`). Bucketed padding (fix #7) narrows the exposed size classes
  but can't eliminate the "this was a multi-MB attachment vs. a text message" signal
  without materially increasing bandwidth — which runs against the push plan's own
  stated goal of minimizing relay traffic.

---

## SECURITY ASSUMPTIONS

- The relay operator (and any TURN operator) is honest-but-curious for this review
  only: never breaks AEAD, never actively tampers (Review 3's threat model) — but is
  assumed to retain and read everything it can passively observe, including its own
  process's console output/logs, indefinitely.
- Network-level observers (ISP, wifi operator) see the same ciphertext-and-metadata
  surface as the relay operator whenever TLS is not configured — `relay.js` falls
  back to plaintext HTTP silently-but-with-a-warning if `TLS_CERT_PATH`/
  `TLS_KEY_PATH` are unset (`relay.js:762-765`). Findings 4-5 apply doubly in that
  case, and are mitigated (relay-to-client hop only) once TLS is configured.
- Scope is a realistic hobbyist/self-hosted single-operator deployment, per this
  review's brief — not a global-passive-adversary or subpoena/legal-compulsion
  threat model. Mixnet/onion-routing/anonymity-network architectures remain
  explicitly out of scope per the project owner's prior decision.
- Findings assume the documented deployment path (`ecosystem.config.linux.js` under
  pm2) is what actually runs in production. If the operator instead runs `node
  relay.js` directly, console output goes to whatever terminal/redirect they chose —
  potentially nothing (best case) or an equally unrotated shell redirect (same
  practical risk as pm2's defaults).
- This review did not access a live production relay instance or an actual
  `~/.pm2/logs/` directory — the pm2-logging finding is a code/config-based
  inference (absence of any log-shaping configuration in both ecosystem files, plus
  pm2's documented default behavior), not a direct observation of an existing log
  file.
