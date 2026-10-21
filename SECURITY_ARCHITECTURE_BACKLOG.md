# Architecture Backlog — SecureCommApp ("Malachi")

**Source:** every row of `SECURITY_ARCHITECTURE_THREAT_MODEL.md` Part 5's
12-row comparison table (§5.1), turned into actionable backlog entries. **This
document is a backlog, not an implementation plan.** Per the same hard
constraint that governed this pass: **no new cryptographic protocol or
primitive is designed, implemented, or hand-rolled here or anywhere in this
codebase as a result of this document.** Rows that would require inventing
new crypto (identity signing scheme, PAKE/OPRF, KEM-based X3DH-analog,
MLS-style group ratchet, threshold/recovery-code cryptography) are scoped
down to "what a future independent cryptography review would need to
resolve," never to wire formats, key sizes, or protocol steps.

Reference protocols (X3DH, MLS, PAKE/OPRF, Tor/mixnet) are named strictly as
**shape pointers** for whoever eventually does that review — not as specs to
implement, and not an endorsement that any of them adapts cleanly to
ML-KEM-768 (several explicitly do not, without their own redesign — see
`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §5.2).

**Priority scale:** P0 (do soon, low risk) / P1 (valuable, needs scoping) /
P2 (needs independent expert review before any design work starts) / P3
(research-grade, do not scope as a task).

---

## A. Rows that need independent cryptography review before any design work

These five rows are exactly the ones `SECURITY_ARCHITECTURE_THREAT_MODEL.md`
§5.2 names as requiring independent cryptographic review. Nothing below is a
specification — each entry is scoped only to "what problem, why current is
limited, what a reviewer would need to evaluate, what ships only after
sign-off."

### A1. Identity (P2)

- **Problem it solves:** there is no durable identity concept at all
  (§1.1) — no cross-device identity, no durable "safety number," and (per
  §3.1 Connection Hijacking) no way to make a stolen-secret-driven reconnect
  hijack cryptographically detectable rather than merely passively
  observable via an opt-in Safety Code comparison.
- **Why current approach is limited:** every pairing is a fresh, fully
  ephemeral KEM exchange with nothing signing "this public key really
  belongs to the device I paired with last time." An attacker who splices
  into a reconnect (§3.1) is indistinguishable from a legitimate rotation
  unless a user manually compares hashes — which `SECURITY_AUDIT_CRYPTO_CLAIMS.md`
  Claim 5 already found is "functionally close to theater" in practice.
- **What a proper fix would need:** a long-term, per-device signing
  keypair (reference point only: an ML-DSA/Dilithium-family scheme, per
  FIPS 204, to stay post-quantum-consistent with the existing ML-KEM
  choice) used *only* to sign ephemeral KEM public keys — never to derive
  message keys itself. This mirrors Signal's separation of identity keys
  from session keys, referenced here for shape only.
- **What needs independent review before any of this ships:** the specific
  signature scheme choice and parameters; how the identity key is
  generated/stored (must not become a weaker single point of failure than
  today's fully-ephemeral model); the key-loss/backup story (a durable
  identity key is also a durable *target* — compromising it once makes
  *every* past and future pairing signed by it suspect, a new blast-radius
  class the current design structurally avoids); and a genuine Safety
  Number UX (not just a passive hash-compare) so the new guarantee is
  actually used.
- **Relative priority:** high security benefit (closes the single most
  consequential protocol-design gap named across every document in this
  repo — Connection Hijacking, §3.1) but the highest-consequence row to get
  wrong after Group Messaging, because it introduces a durable, and
  therefore trackable, key that does not exist today.

### A2. Peer discovery / PAKE replacement for phone-hash rendezvous (P2)

- **Problem it solves:** `hashPhone()`'s deterministic, unsalted hash lets
  anyone who already knows both phone numbers compute the same rendezvous
  value and inject themselves as the "second party" (§3.1 Peer
  Impersonation, `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 6) — this
  includes a relay operator with side information, a jealous partner, or an
  acquaintance.
- **Why current approach is limited:** `derivePhonePSK()` only defeats
  observers who do *not* already know both numbers; there is no
  cryptographic barrier at all against someone who does.
- **What a proper fix would need:** a discovery mechanism shaped like a
  PAKE/OPRF-blinded lookup, so the relay learns only "a lookup happened"
  without being able to test candidate number-pairs even if it wanted to.
  Genuine password-authenticated-key-exchange literature is the reference
  point — this is explicitly *not* a small tweak to the existing hash.
- **What needs independent review before any of this ships:** the specific
  PAKE/OPRF construction and its resistance to offline-dictionary and
  online-guessing attacks — a poorly implemented PAKE can be *worse* than
  the current honest "this is a rendezvous key, not a secret" framing,
  because it would falsely imply a security property it doesn't deliver.
  Round-trip/latency cost against the app's phone-connect UX also needs
  scoping.
- **Relative priority:** per `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §5.3,
  this is one of the two rows the report itself flags as **worst
  benefit-to-risk ratio if rushed** — do not schedule this without a named
  cryptography reviewer attached to the work from day one.

### A3. Session establishment / prekey-based (X3DH-analog) asynchronous pairing (P2)

- **Problem it solves:** both parties must be online (or route through the
  relay) at the same moment to establish a session (§1.9) — there is no
  offline/asynchronous first-contact flow, which also indirectly pressures
  users toward long-lived sessions to avoid reconnect friction
  (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3's own observation).
- **Why current approach is limited:** the Kyber exchange is fully
  interactive by construction — there is no published-prekey concept to
  fetch while the other party is offline.
- **What a proper fix would need:** a prekey-bundle model shaped like
  Signal's X3DH (published one-time and signed-prekey KEM public keys a
  device can fetch asynchronously). **Explicitly flagged by the threat
  model itself:** X3DH as literally specified relies on Diffie-Hellman
  combinations that ML-KEM does not directly provide (it's a KEM, not a DH
  primitive) — adapting the *shape* of X3DH to a KEM-only interface is
  itself a nontrivial, unresolved cryptographic-design question, not a
  drop-in.
- **What needs independent review before any of this ships:** the KEM-only
  prekey-combination construction itself (this is the crux — there is no
  off-the-shelf "X3DH for KEMs" to copy); prekey depletion/reuse and
  prekey-signature-stripping resistance (Signal's own deployment history
  has had real bugs in exactly this area); and the new small correlatable
  artifact a published prekey represents (a public key visible before use,
  a mild new metadata surface per the report's own framing).
- **Relative priority:** the single largest protocol change in the entire
  comparison table per the threat model's own words — real usability
  upside, but do not attempt without a cryptographer signing off on the
  KEM-prekey construction specifically, since no established reference
  design exists to defer to.

### A4. Group messaging / MLS-style group ratchet (P2)

- **Problem it solves:** no group feature exists at all today (confirmed
  absent, §2.1) — this entry exists because the mandate asked whether/how
  one could be added, not because one is planned.
- **Why "just do pairwise Kyber for each member" is not a real fix:** naive
  N-way pairwise KEM exchanges do **not** give the same forward-secrecy or
  post-compromise-security guarantees as a proper group ratchet — this is
  a well-documented trap, not a simplification.
- **What a proper fix would need:** a sender-keys or per-member-pairwise
  ratchet model shaped like MLS (Messaging Layer Security), referenced here
  purely as the modern reference point for group re-keying, membership
  changes, and ratcheting.
- **What needs independent review before any of this ships:** essentially
  everything — member-add/remove races, forward-secrecy and
  post-compromise-security proofs for the specific construction chosen, and
  a dedicated metadata analysis, since group membership itself becomes a
  new, larger relationship-graph target for the relay unless specifically
  designed against it (per §2's relationship-graph finding, a group
  membership list is a strictly bigger correlatable object than a 1:1
  pairing).
- **Relative priority:** per `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §5.3,
  this is the **other** row explicitly named as worst benefit-to-risk ratio
  if rushed, and the single riskiest addition in the entire comparison
  table — group protocols have a much larger history of subtle,
  hard-to-detect bugs than 1:1 messaging even among teams building exactly
  this. Do not schedule without dedicated cryptographic expertise.

### A5. Key recovery (and, contingently, account recovery) (P2)

- **Problem it solves:** losing the PIN (native) or PIN+pepper (web) is
  unrecoverable by design (`SECURITY_SECRETS_LIFECYCLE.md` §8) — a
  legitimate user who forgets their PIN loses everything, identically to
  what an attacker would face.
- **Why this is a genuine trade-off, not a gap:** any recovery mechanism
  *necessarily* creates a bypass path for the same "no recovery" property
  that currently also blocks attackers. This is fundamental, not an
  implementation oversight — the current design's security and its total
  lack of recovery are the same design decision viewed from two angles.
- **What a proper fix would need:** any specific scheme (recovery codes,
  Shamir-style social/threshold secret sharing among trusted contacts,
  third-party escrow) — reference point only, not a design to adopt as-is.
- **What needs independent review before any of this ships:** the specific
  scheme's resistance to reintroducing a single point of failure (a
  naively implemented threshold scheme can easily collapse back to "any one
  of N people can recover your account," which is a much weaker property
  than "no one can"); and, separately, if Identity (A1) is ever added,
  **account recovery** becomes a distinct additional question layered on
  top of key recovery, not the same problem — do not conflate the two
  when scoping either.
- **Relative priority:** genuinely optional — this trades security for
  user-friendliness in a way the current design deliberately does not.
  Only worth scoping if user-support data shows PIN-loss is a frequent,
  costly problem in practice; not scoped here for that reason.

---

## B. Rows that do NOT need new cryptography — engineering/config backlog

These rows have low-risk, non-cryptographic improvements available. None
were implemented in this pass (see rationale per row) — each is small enough
to scope as its own follow-up task without touching the crypto layer.

### B1. NAT traversal — make TURNS-only the default (P0, not yet implemented)

- **Current state:** `coturn-setup.sh` already enables TURNS (TLS/DTLS,
  port 5349) this session, but leaves the plaintext port 3478 open "for
  compatibility" and firewalled-open by default; `WebRTCManager.js`/
  `CallManager.js` still need to be pointed at `turns:` by default per the
  script's own closing "Naechster Schritt" note.
- **Why deferred rather than done in this pass:** genuinely small, but it
  spans three files (`coturn-setup.sh`, `WebRTCManager.js`, `CallManager.js`)
  and changes default network-reachability behavior for real deployments —
  more than a comment/doc-only edit, and outside this pass's documentation
  scope. No cryptography is involved; DTLS-SRTP already protects the actual
  media regardless of which TURN control-channel transport is used (this
  is only about closing the metadata-exposure gap on the *control* channel,
  per `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §1.5).
- **Scoped follow-up:** switch `TURN_HOST` default to `turns:` in the two
  client-side files, then stop opening/advertising port 3478 by default in
  `coturn-setup.sh` (keep it as an explicit opt-in flag for legacy clients
  only, if needed at all).
- **Risk:** near zero technically; the only real risk is breaking a client
  that can't negotiate TLS/DTLS on the control channel — mitigate by
  keeping the opt-in flag rather than deleting the plaintext path outright.

### B2. Message routing — padding buckets + jittered cover traffic (P1, not implemented)

- **Current state:** message/image/audio chunk sizes are unpadded, and
  cover traffic fires at a fixed 3s interval (`WebRTCManager.js:436-475`),
  both of which let a relay or ISP distinguish message type and idle-vs-active
  state from ciphertext size/timing alone (§4.2).
- **Why deferred:** a pure parameter-tuning change to already-existing
  chunking/cover-traffic logic in `ImageCrypto.js`/`AudioCrypto.js`/
  `MessageCrypto.js`/`WebRTCManager.js` — genuinely low risk and no new
  cryptography, but touches four files that are mid-flight in this same
  session's git status; scoping it as its own follow-up avoids collision
  with concurrent work and keeps this pass's diff to documentation.
- **Scoped follow-up:** round chunk sizes up to a small fixed set of
  buckets (e.g. powers-of-two or a handful of fixed sizes) before
  encryption; replace the fixed 3s cover-traffic interval with a jittered
  interval (e.g. uniform random within a range) so it's no longer
  metronomically distinguishable from real bursts.
- **Risk:** low — padding/jitter are well-understood traffic-analysis
  mitigations, not new protocol design. Main cost is a small bandwidth/
  battery overhead.

### B3. Relay (message fallback) — fix store-key collision message loss (P1, not implemented)

- **Current state:** `SECURITY_CHAOS_TESTING.md` Scenario 5 found that
  millisecond-timestamp store-key collisions under concurrent load can
  silently drop a message — currently accidental, but §3.1's "fully
  malicious relay" analysis notes a hostile relay could deliberately
  engineer the same collision to targetedly drop messages.
- **Why deferred:** ordinary distributed-systems/concurrency engineering
  (unique message IDs instead of millisecond-timestamp keys, or a proper
  queue per recipient), not cryptography — but real implementation work
  against `relay.js`'s store logic and its test suite, out of scope for a
  documentation-focused pass.
- **Scoped follow-up:** replace the timestamp-derived store key with a
  collision-resistant identifier (random ID or monotonic per-recipient
  counter) so concurrent packets to the same recipient never overwrite each
  other.
- **Risk:** low — this is a correctness fix to existing non-cryptographic
  logic, with a chaos test already available to verify it.

### B4. Offline messaging — extend the durable queue to all outbound message types (P1, not implemented)

- **Current state:** outbound *media* already has a durable on-disk
  `queue_<id>` if the send fails; outbound *text/system* messages do not
  (`SECURITY_STATE_MACHINES.md` §7) — a message can be lost if the app is
  killed mid-send, with no equivalent recovery to the media path.
- **Why deferred:** reuses an already-proven, working pattern — the report
  itself calls this the best benefit-to-risk row in the entire table
  (`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §5.3) — but it's still an
  applied-code change to the send path in `App.tsx`/`web/src/App.tsx`
  outside this pass's documentation-only scope, and worth its own
  focused test pass rather than a quick edit alongside doc fixes.
- **Scoped follow-up:** generalize the existing media-queue persistence
  mechanism to cover text/system message sends uniformly.
- **Risk:** minimal — no new cryptography, no new metadata surface, purely
  closes an existing asymmetry with a pattern already proven in production.

### B5. Device linking (P2, non-cryptographic UX/product work, but large)

- **Current state:** does not exist — one `EncryptedStorage` instance IS
  the device/account (§1.2); losing a device loses everything, by design.
- **Why this belongs in the backlog, not this pass:** while the underlying
  mechanism (each linked device gets its own KEM identity under a
  user-controlled root) would eventually intersect with the Identity row
  (A1) if that's ever built, the linking *flow* itself is mostly UX/product
  design work, not new cryptography by itself — but it is large, and a
  common real-world social-engineering attack target ("scan this QR to
  link a new device"), so it needs dedicated, careful UX/security
  co-design, not a bolt-on.
- **What a fix would need:** a device-linking protocol (QR-scan-to-link,
  analogous to Signal's linked-devices model), which structurally depends
  on Identity (A1) existing first to have something to link additional
  devices *to*.
- **New metadata risk to weigh:** linked devices are a natural new place
  for the relay to observe "these N devices belong to one user" — a
  correlatable category the current one-device-is-the-account model avoids
  entirely simply by not having the concept.
- **Relative priority:** blocked on Identity (A1); do not scope
  independently of it.

### B6. Signaling decentralization (P3, out of scope as a near-term task)

- **Current state:** one centralized relay process is the mandatory choke
  point for the first handshake (§1.4, §1.13) — a single point of both
  availability failure and metadata-observation privilege.
- **Why this is P3, not a scoped task:** the proposed direction
  (multi-operator/federated signaling, or a DHT-based rendezvous, with
  Tor/mixnet-style multi-hop relaying as a reference concept for hiding
  *which* operator sees a given pairing) is a genuine distributed-systems
  redesign, not a config change — and works directly against this
  project's own stated self-hosting-simplicity goal. No cryptography
  review is strictly required (this is a systems/ops design problem, not a
  crypto one), but the scope is large enough that it should not be
  attempted piecemeal.
- **Relative priority:** valuable long-term privacy benefit (removes the
  single-operator total-metadata-visibility property, §2.2) but very high
  complexity/operational cost — track as a future major-version
  consideration, not a sprint-sized item.

### B7. Metadata minimization — mixnet-style batching/delay layer (P3, research-grade)

- **Current state:** the relay's real-time, single-process view of
  connection timing/graph metadata is structural, not a logging bug —
  hardening logs (`hashIp()`, this session) narrows what a *later log
  reader* can reconstruct but does nothing to reduce what the *live
  process* observes in real time (§4.3, and this pass's tightened comments
  in `relay.js`).
- **Why this is P3, not a scoped task:** a Tor-style batch-and-delay mixnet
  layer is the only row in the entire comparison table that could actually
  change the §2.2 finding (relay can reconstruct the relationship graph)
  from "structural" to "mitigated" — but full mixnet integration is
  explicitly called out by the threat model as "a research-grade
  undertaking on its own," directly trading away the low-latency chat/call
  experience the app is built around.
- **Relative priority:** do not scope as a task; revisit only if the
  project's threat model or user base changes enough to justify the latency
  trade-off. The smaller, already-scoped items in this section (B1, B2)
  capture the load-bearing, low-risk wins available today.

---

## Summary table

| Row | Category | Priority | Needs crypto review? |
|---|---|---|---|
| Identity | A1 | P2 | Yes |
| Peer discovery (PAKE) | A2 | P2 | Yes |
| Session establishment (X3DH-analog) | A3 | P2 | Yes |
| Group messaging (MLS-style) | A4 | P2 | Yes |
| Key / account recovery | A5 | P2 | Yes |
| NAT traversal (TURNS-only default) | B1 | P0 | No |
| Message routing (padding/jitter) | B2 | P1 | No |
| Relay fallback (collision fix) | B3 | P1 | No |
| Offline messaging (durable text queue) | B4 | P1 | No |
| Device linking | B5 | P2 | No (blocked on A1) |
| Signaling decentralization | B6 | P3 | No (systems design) |
| Metadata minimization (mixnet) | B7 | P3 | No (research-grade) |

None of the P2-crypto-review rows (A1–A5) should be scheduled for
implementation without a named, independent cryptography reviewer attached
to the work before design starts — per the constraint that governed this
entire pass.
