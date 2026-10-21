# Architecture & Threat Model — SecureCommApp ("Malachi")

**Scope of this document:** a different lens than the prior 12 security documents in
this repo. Where `SECURITY_REVIEW_1`–`6`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`,
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`, `SECURITY_STATE_MACHINES.md`,
`SECURITY_CHAOS_TESTING.md` and `SECURITY_SECRETS_LIFECYCLE.md` verified specific
claims and state transitions, this document reconstructs the **whole-system
architecture as a trust-boundary graph**, builds a **zero-knowledge property
matrix**, runs a **network-attacker simulation** against every named mechanism,
performs a **metadata-only correlation analysis**, and closes with a **comparative
alternative-architecture design**. It is read-only: no code, tests, or
configuration were changed to produce it.

**Ground truth inherited without re-derivation** (established by the six documents
above, cited by name where relevant): ML-KEM-768/Kyber via BouncyCastle
(native)/`@noble/post-quantum` (web) for key exchange; AES-256-GCM →
ChaCha20-Poly1305 → XSalsa20-Poly1305 triple-AEAD via `@noble/ciphers` for
messages (`MessageCrypto.js`); no long-term identity keys, no prekeys, fully
interactive key exchange; the relay (`relay.js`) is a single Node process holding
only in-RAM `Map`s, no database, no accounts; `hashIp()` now HMAC-keyed
per-process (fixed this session); the phone-connect PSK, TURN HMAC credentials,
and pepper-gated web storage are all real, as characterized in the crypto and
trust/privacy audits; the `device_wiped` tombstone mechanism was added this
session (`App.tsx:1218-1262`, `web/src/App.tsx:253-259`).

**Verdict legend** (same convention as prior audits): **PROVEN** / **DESIGN
GOAL** / **ASSUMPTION** / **UNVERIFIED CLAIM**.

---

# Part 1 — Trust Boundary Architecture Reconstruction

## 1.0 Method

Each pipeline stage below answers, from code actually read (cited): who holds
what; who must trust whom; what crosses the wire; what's persisted where; what an
on-path/malicious-relay attacker could tamper with; what's correlatable; what
survives a compromise of the relay or of one client.

## 1.1 USER → IDENTITY

**There is no identity layer in the cryptographic sense.** Confirmed by
`SECURITY_STATE_MACHINES.md` §1 and independently re-confirmed here: no
public/private identity keypair exists anywhere. `my_id`
(`App.tsx` `SetupScreen`, `generateContactId()` at `App.tsx:77-93` per the
state-machine report) is a locally-generated random string, never used as
key material — it is a **display/routing label**, not an identity credential.

| Question | Answer |
|---|---|
| Who holds what | The device holds a random `my_id` and a chosen display name. Nothing server-side. |
| Trust required | None — there is no party to authenticate *as*, only per-pairing shared secrets to negotiate later. |
| Wire data | `my_id`/display name are exchanged only inside the (already-encrypted-once-paired, or plaintext-during-first-handshake-profile-packet) pairing flow — see §1.9. |
| Persisted | `AsyncStorage` (plaintext, not `EncryptedStorage`) — `my_id`, `username`, `avatar` (`App.tsx` setup flow). |
| Tamperable by relay | The relay never sees `my_id` as a standalone value tied to anything (no `/register` route). |
| Correlatable | Only if the *same* `my_id`/display name is reused across multiple pairings and an observer sees both — nothing in the code forces or prevents this; it's user behavior, not architecture. |
| Post-compromise | Compromising the relay reveals nothing about identity, because none exists there. Compromising one client reveals that device's own `my_id`/name — irrelevant to any other device. |

**This is a genuine architectural property, not a hedge:** the absence of
identity is why there is also no cross-device account-recovery story
(`SECURITY_SECRETS_LIFECYCLE.md` §8, confirmed absent) and why every pairing is
independent (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3, "compromising one
contact's secret exposes no others").

## 1.2 IDENTITY → DEVICE

Device state is a single local flag, not a server-verified concept
(`SECURITY_STATE_MACHINES.md` §1 table, `App.tsx:942-950`). One `EncryptedStorage`/
`AsyncStorage` instance **is** "the device" — there is no multi-device-same-account
concept, no device list, no device linking. This has a direct trust-boundary
consequence: **there is nothing to revoke at the identity layer** — see §1.10.

## 1.3 DEVICE → DISCOVERY

Two independent discovery mechanisms, both mediated by the relay, both examined in
depth by `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claims 5–6 (not re-derived, only
placed into the trust-boundary frame here):

### 1.3a QR / deep-link discovery
Out-of-band (the QR code or link itself is not transmitted through any party this
threat model covers — it's shown on one screen and scanned/opened on the other).
**Trust required:** the two devices trust that the physical/visual channel
carrying the QR code was not intercepted — a channel entirely outside this app's
control. **What crosses the wire:** the WebRTC offer/answer SDP, encrypted once a
shared secret exists (see §1.9) but the very first `kyber_pubkey` is plaintext by
design (`WebRTCManager.js:264-277`, cited in `SECURITY_AUDIT_CRYPTO_CLAIMS.md`
Claim 2). **Relay role:** none for QR pairing if a direct P2P signaling channel is
available; relay is used as the SDP transport when it's not (see §1.5).

### 1.3b Phone-number rendezvous
**Trust boundary, precisely:** `hashPhone()` (`App.tsx:2711-2726` per the
trust/privacy audit) computes a **deterministic, unsalted** hash of the sorted
phone-number pair — this is a rendezvous key, not a secret. **Anyone who knows
both numbers** — including the relay operator, if they already suspect a pairing
and want to confirm it — can compute the same hash and either observe or inject
into that rendezvous slot. The relay (`relay.js:409-478`) stores
`{hash → {initiatorId, ...}}` with a 5-minute TTL, deleted on match. **What the
relay learns:** that *some* pairing request is happening, tagged by an opaque
hash it cannot reverse without already knowing the two numbers, plus the
requesting IP and timing. **What the relay does NOT learn:** which two phone
numbers, unless it already had them as a hypothesis to test.

## 1.4 DISCOVERY → SIGNALING

Both discovery paths converge on the same signaling primitive: SDP offer/answer
exchanged via `relay.js`'s `/packet` or `/reconnect/offer|answer` singleton-slot
store (`relay.js`, cited with delete-on-fetch semantics in
`SECURITY_STATE_MACHINES.md` §7). **Trust boundary:** the relay is the **only**
party both peers necessarily contact during signaling — it is a mandatory
choke point structurally, not merely a fallback, for the SDP exchange itself
(P2P *media* can bypass it once connected, but the *initial* handshake cannot,
because the two devices have no other rendezvous channel). **What crosses the
wire:** SDP (ICE candidates, codec info, and — critically — the plaintext
`kyber_pubkey`/ciphertext `kyber_ciphertext` messages once the DataChannel is
open are a *separate*, later exchange over the now-established channel, not part
of SDP itself). **Tamperable by relay:** the relay could rewrite SDP fields
(e.g. inject its own ICE candidate to force traffic through an
attacker-controlled path) — see Part 3 for whether this is currently exploitable.

## 1.5 SIGNALING → NAT TRAVERSAL

STUN/TURN credentials are minted by the relay itself
(`relay.js:911-923`, `/turn-credentials`, HMAC-SHA1 over `TURN_SECRET`, 6h TTL —
already established as genuine in `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim
7). **Trust boundary:** the relay operator and the TURN operator are — by default
deployment (`coturn-setup.sh`) — **the same party**, since the relay mints
credentials with a secret only it holds unless deliberately handed to a separate
operator. **NAT traversal control-channel confidentiality:** as of this session's
fix, `coturn-setup.sh:43-60` now enables TURNS on port 5349 (TLS/DTLS) reusing the
relay's own certificate, while port 3478 (plaintext) remains open "for
compatibility" (`coturn-setup.sh:78`) — meaning the control-channel-cleartext
exposure Claim 7 identified is now **mitigated but not eliminated**: a
misconfigured or legacy client can still negotiate the plaintext port, and
nothing in the code forces TURNS-only. **Media confidentiality itself does not
depend on this** — DTLS-SRTP protects the RTP/data payload regardless of which
TURN control-channel transport was used (an `ASSUMPTION` this document does not
re-derive from the WebRTC stack, per the crypto audit's own scoping).

## 1.6 NAT TRAVERSAL → P2P CONNECTION

Once ICE completes, a `RTCPeerConnection` DataChannel exists between the two
devices, secured at the transport layer by DTLS (a classical, non-PQ handshake
WebRTC itself performs — `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 2). **Trust
boundary:** from this point, the relay is **not** in the data path for as long as
the P2P connection stays up — a structurally real privacy improvement over
relay-fallback, confirmed by the architecture (no code path routes live
DataChannel traffic through `relay.js`). **What the relay can still infer:**
nothing about ongoing P2P traffic content or volume, but it *did* observe both
peers' involvement during signaling/TURN-credential issuance, which is enough to
know the pairing exists and roughly when it started (§1.5).

## 1.7 P2P CONNECTION → RELAY FALLBACK

When P2P fails or is asleep, messages route through `relay.js`'s `/packet`
store-and-forward (`relay.js`, cited extensively in
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`'s consolidated observability table).
**Trust boundary, stated plainly per the mandate:** in this architecture, **the
relay, the signaling server, and the discovery server are the same process** —
there is exactly one server-side trust boundary in the entire system, not three
independent ones. Compromising `relay.js` compromises rendezvous, signaling, TURN
credential issuance, and message-relay fallback simultaneously. This is a
first-order architectural fact worth stating plainly (per the task's own
instruction): **Malachi has a single server-side trust boundary, wearing four
hats.** **What crosses the wire:** `{type:'encrypted', data}` ciphertext blobs
only — the relay never receives plaintext or key material for message content
(`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 4, PROVEN). **Persisted:** in-RAM only,
`EXPIRE_MS`-bounded (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`'s table). **Tamper
surface:** ciphertext could be corrupted/dropped/replayed by the relay — AEAD
catches corruption (PROVEN), replay is asymmetric between live-P2P and
relay-fallback paths (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 6).

## 1.8 RELAY FALLBACK → KEY EXCHANGE

The Kyber exchange (`kyber_pubkey`/`kyber_ciphertext`) can itself transit the
relay if it's the fallback path in use at pairing time — i.e., **the relay can be
in the path for the one exchange that produces the value it can never
subsequently decrypt anything with.** This is the system's core soundness
property: even total relay compromise (full plaintext logging of every packet it
ever forwarded, forever) does not yield message plaintext, because ML-KEM-768's
security holds against a passive observer of the public key and ciphertext
alone. **What it DOES yield:** the relay sees the *timing and existence* of every
key-exchange event, which — combined with §1.3's rendezvous metadata — lets it
build a complete graph of "who paired with whom, when" (content-blind, but
graph-complete). This is the single most important fact for Part 2 and Part 4.

## 1.9 KEY EXCHANGE → SESSION

A fresh `WebRTCManager` instance (`App.tsx:458,773`) and fresh Kyber keypair
(`WebRTCManager.js:266`) are created per connection attempt — this produces
genuine session-boundary forward secrecy but zero within-session ratcheting
(`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3, PROVEN/overstated-prior-framing).
**Trust boundary:** once `sharedSecret` is established, the two paired devices
are the only parties who can decrypt — this is the E2E boundary the whole
architecture exists to create. **What survives compromise of one client:** the
`sharedSecret` for every contact that client has ever paired with, persisted
indefinitely until rotated (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3, "no
periodic re-key requirement... PROVEN absent"). A compromised client thus exposes
**all of that device's own conversations**, past and future-until-next-rotation,
but — confirmed structurally — **zero** information about any other pairing
(`RTCStore.sharedSecrets` is a `Map` keyed per-contact with independent KEM
draws).

## 1.10 SESSION → MESSAGE

Message plaintext exists only at the two endpoints, momentarily, during
encrypt/decrypt (`MessageCrypto.js`). **New finding for this document, drawing
on `SECURITY_SECRETS_LIFECYCLE.md` Finding S-4:** the trust boundary that
matters most in practice is not the wire (well-protected) but **each device's own
process memory and logs** — `App.tsx:1732` and `App.tsx:3249` log full decrypted
message objects to console unconditionally. From a trust-boundary-diagram
perspective, this means the *effective* confidentiality boundary on the native
app is narrower than "the two paired devices" — it also includes **anyone with
console/logcat access to either device** during a session (a developer, a
connected debugger, a bug-report screen-share). This is a client-side boundary
leak, not a protocol weakness.

## 1.11 MESSAGE → STORAGE

Native: `EncryptedStorage` (Android Keystore-backed `EncryptedSharedPreferences`,
genuinely strong on the happy path, PIN does not gate it —
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 9, PROVEN/disproven split). Web:
PIN+relay-pepper-derived AES-256-GCM, a genuine cryptographic gate
(`Storage.ts`, same Claim 9, DESIGN GOAL/strong). **Trust boundary difference
between platforms, stated plainly:** on native, the storage-encryption trust
boundary is "the OS Keystore + physical device," independent of the app's own
lock screen; on web, the trust boundary is "PIN knowledge + live relay
availability," a strictly different (and, for the specific stolen-device-dump
scenario, stronger) model. **A reader of this app's marketing copy would not
know these are architecturally different guarantees** — this is a genuine
cross-platform trust-model inconsistency worth stating as its own finding,
distinct from either platform's audit taken alone.

## 1.12 STORAGE → SYNC

There is no cross-device sync of any kind — confirmed by the absence of any
multi-device/account concept (§1.2). "Sync" in this architecture means exactly
one thing: **the reconnect protocol re-establishing a session after an
interruption**, which is really a return to §1.4–§1.9, not a distinct data-sync
mechanism. This is worth stating explicitly because sync is often assumed to
imply a server-side merge/consistency mechanism — **none exists here, by
architecture, not by omission.**

## 1.13 Consolidated trust-boundary diagram

```
 ┌─────────────┐                                   ┌─────────────┐
 │  DEVICE A    │                                   │  DEVICE B    │
 │ (no identity;│                                   │ (no identity;│
 │  local PIN/  │                                   │  local PIN/  │
 │  Keystore or │                                   │  pepper gate)│
 │  pepper gate)│                                   │              │
 └──────┬───────┘                                   └──────┬───────┘
        │  (1) discovery: QR/deep-link (out-of-band)        │
        │      OR phone-hash rendezvous (via relay)         │
        │  (2) signaling: SDP via relay /packet              │
        │  (3) TURN creds: minted by relay (HMAC(TURN_SECRET))│
        ▼                                                    ▼
 ┌───────────────────────────────────────────────────────────────┐
 │        RELAY  =  SIGNALING SERVER = DISCOVERY SERVER =         │
 │        TURN-CREDENTIAL ISSUER  (relay.js, ONE Node process)    │
 │  Sees: raw IP, contactId per routed req, phone-hash pairs,     │
 │        attachment size/MIME, call-signal timing, key-exchange  │
 │        event timing.  Never sees: message/key plaintext.       │
 │  In-RAM only, no DB, no accounts, no persistence across restart│
 └───────────────────────────────────────────────────────────────┘
        │                                                    │
        │  (4) once ICE completes: DIRECT P2P DataChannel     │
        │      (relay NOT in this path) — OR, if P2P fails,   │
        │      continued relay-fallback for message ciphertext│
        ▼                                                    ▼
 ┌──────────────┐        DTLS-SRTP/DTLS-SCTP tunnel     ┌──────────────┐
 │ Kyber KEM +  │◄──────────────────────────────────────►│ Kyber KEM +  │
 │ triple-AEAD  │        (classical, non-PQ transport)    │ triple-AEAD  │
 │ session keys │                                          │ session keys │
 └──────────────┘                                          └──────────────┘
        │                                                    │
        ▼                                                    ▼
 EncryptedStorage (Keystore,           web: PIN+pepper AES-GCM Storage.ts
 PIN does NOT gate the key)            (PIN genuinely gates the key)

 Separate third parties, outside the diagram above but reachable in practice:
   - TURN operator (usually = relay operator by default deploy, can be split)
   - ISP / network observer of either device
   - FCM (Google) — wired but currently dead code, per trust-privacy Claim 12
```

**The single most important structural fact this diagram makes explicit:** there
is exactly **one** server-side box, wearing four functional hats (relay,
signaling, discovery, TURN-credential issuer). Every "the relay learns X" finding
in Parts 2–4 below is really "the one server-side trust boundary learns X" —
there is no meaningful sense in which compromising "the signaling server" is a
smaller event than compromising "the relay," because they are the same process,
the same `relay.js`, the same operator, the same failure domain.

---

# Part 2 — Zero-Knowledge Property Matrix

## 2.0 Why "zero-knowledge" must be decomposed

`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 9 already established that no
cryptographic-protocol-sense zero-knowledge proof exists anywhere in this
codebase (**N/A**, confirmed). The word nonetheless appears in the app's own UI
(`App.tsx:3144`, phone-connect) and developer comments (`relay.js:409`). This
section replaces the blanket term with concrete, independently gradable
properties, each checked against the actual code.

## 2.1 Property matrix

Legend: **VISIBLE** (plaintext, no effort needed) / **ENCRYPTED** (ciphertext
only reaches this party) / **DERIVABLE** (party can compute it from other data
it legitimately holds) / **CORRELATABLE** (not directly visible, but linkable
across events/time by this party) / **NOT AVAILABLE** (structurally absent).

Per the mandate's own instruction: **CLIENT** and **PEER** are the two paired
end-users' devices; **SERVER**, **SIGNALING**, **DISCOVERY**, and **RELAY** are
all the *same process* (`relay.js`) per §1.13 — shown as one merged column,
**SERVER/RELAY**, to avoid implying false separation; **DATABASE** is N/A (no
DB exists — only in-RAM `Map`s server-side and `AsyncStorage`/`EncryptedStorage`/
`localStorage` client-side, stated explicitly per the mandate); **PUSH
PROVIDER** is FCM (currently dead code, per trust-privacy Claim 12 — marked
accordingly); **NETWORK PROVIDER** is the ISP/any on-path network observer.

| Information | CLIENT (own device) | PEER | SERVER/RELAY | DATABASE | PUSH (FCM) | ISP/NETWORK |
|---|---|---|---|---|---|---|
| Message plaintext | VISIBLE (both sides) | VISIBLE | NOT AVAILABLE (AEAD, PROVEN) | N/A — no DB | NOT AVAILABLE (dead code, content-blind by design even if wired) | ENCRYPTED (sees ciphertext bytes only, or ECDHE/DTLS-wrapped bytes if live P2P) |
| Message keys (session `sharedSecret`) | VISIBLE (in-memory + persisted) | VISIBLE | NOT AVAILABLE — but see §1.8: relay *witnesses* the KEM exchange events without learning the resulting secret | N/A | NOT AVAILABLE | NOT AVAILABLE |
| Identity secrets | NOT AVAILABLE — none exist (confirmed, §1.1) | NOT AVAILABLE | NOT AVAILABLE | N/A | N/A | N/A |
| Account data | NOT AVAILABLE — no accounts (§1.1/1.2) | NOT AVAILABLE | NOT AVAILABLE | N/A | N/A | N/A |
| Device data (`my_id`, name, avatar) | VISIBLE (own) | VISIBLE (received via profile-exchange packet, once paired) | NOT AVAILABLE for content; CORRELATABLE for existence/timing of pairing events | N/A | NOT AVAILABLE | ENCRYPTED (profile packet ciphertext) |
| Contact/pairing information | VISIBLE (own contact list, plaintext `AsyncStorage` per `SECURITY_SECRETS_LIFECYCLE.md` §9 table) | VISIBLE (its own side) | CORRELATABLE — phone-hash pairs, `contactId`s per routed request (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` consolidated table) | N/A | NOT AVAILABLE (dead code) | CORRELATABLE (can observe connection patterns, not content) |
| Routing metadata (IP, timing, sizes) | VISIBLE (own) | NOT AVAILABLE (peer's IP not exposed to the other peer by the relay itself, though WebRTC ICE candidates *do* reveal both peers' IPs to each other directly once P2P negotiation starts — a structurally different exposure than the relay's) | VISIBLE (raw IP per request; hashed-in-logs only, per Claim 3 fix) | N/A | CORRELATABLE (FCM/Google sees delivery IP+token if ever wired) | VISIBLE (full traffic metadata for its own subscriber) |
| Presence/online-offline | DERIVABLE (own reconnect/poll state) | DERIVABLE (via reconnect success/failure, wake signals) | CORRELATABLE — the relay's WS `subscribe` mechanism binds an entire contact list to one IP at one moment (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 5) | N/A | NOT AVAILABLE | CORRELATABLE (connection timing patterns) |
| Group metadata | NOT AVAILABLE — no group feature exists (confirmed, `SECURITY_STATE_MACHINES.md` §8, grep-verified) | N/A | N/A | N/A | N/A | N/A |
| Relationship graph (who talks to whom) | VISIBLE (own contact list) | VISIBLE (own contact list) | CORRELATABLE — this is the central finding of this matrix: the relay cannot read *content* but can, over time, reconstruct the full pairing graph from phone-hash rendezvous + `contactId`-tagged routing + WS-subscribe contact-set binding, all without breaking any cryptography | N/A | NOT AVAILABLE | CORRELATABLE (via traffic timing/volume between endpoints it can see, weaker than the relay's view) |

## 2.2 "No server-side reconstruction of relationships" — does it hold?

**No, not fully, and this needs to be stated plainly rather than softened.**
Per §1.13 and the matrix above, the single server-side process can, purely from
metadata it legitimately needs to route packets:
1. Learn that two specific phone-number hashes (and, if it already suspects the
   two real numbers, confirm them by trial-hashing) paired, and when
   (`relay.js:409-478`).
2. Learn that a specific IP address holds a specific set of `contactId`s, in one
   shot, via the WS `subscribe` message (`relay.js:876-889`,
   `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 5).
3. Correlate `contactId`-tagged `/packet`, `/reconnect/*`, and `/call/signal`
   traffic over time into a timing graph of who communicates with whom and how
   often, even though every payload byte stays opaque.

**This is precisely the distinction the project's own documentation blurs** (see
§2.3): "the relay cannot read your messages" (true, PROVEN) is not the same
claim as "the relay cannot reconstruct your relationships" (false, as shown
above). Both are frequently gestured at with the single word "Zero-Knowledge" in
this codebase's UI and comments.

## 2.3 Distinguishing the six concepts — and where this codebase's own language conflates them

| Concept | Definition used here | Does Malachi have it? | Where the project's own language over-claims it |
|---|---|---|---|
| **Cryptographic confidentiality** | Ciphertext reveals nothing about plaintext without the key | **Yes**, PROVEN for message/image/audio content (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claims 1/6) | Not over-claimed — this is the one property the app's marketing language ("Ende-zu-Ende verschlüsselt") correctly and narrowly claims |
| **Access control** | A gate that requires proof of something (PIN, biometric) before granting access | **Split**: web genuinely cryptographic (Claim 9); native is a **UI-only** gate that does not control the actual `EncryptedStorage` key (Claim 9, "PIN/biometric protects your data" — UNVERIFIED CLAIM, disproven) | The native lock screen UI presents itself identically to the web one, with no indication one is a real cryptographic gate and the other is not |
| **Privacy** | Limiting what any party (including the service operator) can learn about a user, beyond pure content secrecy | **Partial** — content is private; a meaningful amount of relationship/timing metadata is not (§2.2) | The relay's own header comment, even post-fix, still implies more privacy than the metadata table actually delivers (`relay.js`'s "keine Metadaten" language, softened this session but still present as a partial claim per `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 1b) |
| **Metadata minimization** | Actively reducing what metadata is generated/retained, not merely not persisting it long-term | **Partial** — `hashIp()`'s HMAC fix (this session) is a genuine minimization step *for log-holders without the process's secret*; it does nothing to reduce what the live relay process itself observes in real time (see Part 4) | The phrase "kurzer, nicht umkehrbarer Fingerabdruck" invites the reader to think raw-IP knowledge is minimized *for the relay itself* — it is not; the relay computes and holds the very secret that makes the hash reversible, in the same process, the whole time |
| **Anonymity** | An observer cannot link an action to a real-world identity at all | **Not claimed anywhere in the codebase** (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 10, confirmed — grep for "anonym" finds only a security-review document itself using it to describe what the app is *not*) | Correctly absent — this is one place the project does **not** overclaim |
| **Genuine zero-knowledge (cryptographic ZKP)** | A prover convinces a verifier of a statement without revealing the witness | **Does not exist** anywhere in this codebase (Claim 9, N/A) | The word "Zero-Knowledge" is used in exactly the informal, non-cryptographic sense throughout (`App.tsx:3144`, `relay.js:409` dev comment) — a real terminology conflation between "the operator learns very little" (a privacy/metadata-minimization claim) and the formal cryptographic term, which this document explicitly does not use as a blanket label anywhere above |

**Verdict for this section, stated in the audits' own idiom:** "Zero-Knowledge"
as used in this app is **UNVERIFIED CLAIM as a formal term** (it is not one, and
nothing in the code implements one) but **DESIGN GOAL, partially achieved** if
read charitably as shorthand for "the operator cannot read content and
minimizes what it retains" — the matrix above shows exactly where that
charitable reading still falls short (relationship-graph reconstruction, §2.2).

---

# Part 3 — Network Attacker Simulation

## 3.0 Attacker capability model (as specified by the mandate)

Observe traffic; delay/drop/replay/reorder packets; block or force connections;
control relay nodes (here: **the single relay/signaling/discovery/TURN-credential
process** — one compromise gives all four); compromise individual peers; observe
IPs; perform timing analysis. All findings below are from code-reading, not live
exploitation.

## 3.1 Attempted attacks

### MITM (active substitution during Kyber handshake)

| | |
|---|---|
| **Required capability** | Control the relay (for relay-fallback signaling) or control/insert into the P2P DataChannel transport (e.g. via a malicious TURN relay's data plane) |
| **Attack path** | Run two independent Kyber exchanges, one with each victim, splicing in as both "peers" — the plaintext-by-design `kyber_pubkey` message (`WebRTCManager.js:264-277`) has no signature binding it to a specific expected peer, only to the DataChannel it arrives on |
| **Security impact** | Full read/write MITM on that session's messages |
| **Current mitigation** | The Safety Code (`SHA-256(sharedSecret)`, `WebRTCManager.js:422-434`) would visibly diverge for each victim if compared — a structurally sound detector |
| **Remaining risk** | Detection is **opt-in and unprompted** (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 5, "functionally close to theater") — the overwhelming majority of users never compare codes, so this attack succeeds silently in practice for as long as the attacker maintains the splice, including across reconnects (Claim 3's rotation-hijack finding: an attacker holding one stolen secret can hijack the *next* rotation to remain permanently in the middle) |

### Sybil (many fake peers/identities)

| | |
|---|---|
| **Required capability** | Ability to run many client instances |
| **Attack path** | Register many phone-hash entries or QR pairing attempts; since there is no identity layer (§1.1) and no reputation/rate-limited registration beyond `/phone/lookup`'s 20/5min-per-IP miss cap (`relay.js:110-124`), a Sybil attacker can flood the rendezvous namespace |
| **Security impact** | Low directly — Sybil identities gain no plaintext access to any conversation they're not cryptographically part of (confirmed structurally, no N-party key agreement exists, §1.9). The real impact is **availability/confusion**: `SECURITY_CHAOS_TESTING.md` Scenario 8 already empirically demonstrated a third device registering against an already-claimed phone-hash silently displaces the second device's belief that it holds the `initiator` role, with zero notification |
| **Current mitigation** | Only the miss-rate-limit on `/phone/lookup`; no protection at all on `/phone/register`'s "last write wins" role assignment |
| **Remaining risk** | Cheap, empirically demonstrated role-confusion at the rendezvous layer (not a key-exchange bypass) — bounded but real, and not previously flagged by any prior review before the chaos-testing pass |

### Peer impersonation

| | |
|---|---|
| **Required capability** | Knowledge of both phone numbers in a rendezvous pair (§1.3b), or control of the relay during a QR/deep-link session's relay-mediated signaling leg |
| **Attack path** | For phone-connect: compute the same `hashPhone()` value and register/claim the rendezvous slot before the real second party does (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 6, "anyone who knows both numbers... can inject themselves as a participant") |
| **Security impact** | Attacker completes a Kyber handshake as if they were the intended contact — full read access to everything sent to that pairing going forward |
| **Current mitigation** | `derivePhonePSK()` narrows this to defeating only observers who do **not** know both numbers (Claim 6) — no defense exists against an attacker who does know both, which is exactly the scenario relevant to, e.g., a jealous partner, an acquaintance, or a relay operator with side information |
| **Remaining risk** | High for this specific, realistic threat actor class; explicitly acknowledged in developer comments (`App.tsx:2728-2736`) but not in the user-facing string, per Claim 6's own finding |

### Connection hijacking (reconnect-offer takeover)

| | |
|---|---|
| **Required capability** | Possession of a previously-stolen `shared_secret_<chatId>` (e.g. rooted-device extraction) plus relay-position or TURN-control-channel access at the moment of the next reconnect |
| **Attack path** | Decrypt/forge the `purpose='reconnect'`-encrypted SDP that both sides continue encrypting under the *old* secret until the new one is negotiated (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3, point 7) — inject the attacker's own Kyber public key as the "real" reconnecting peer |
| **Security impact** | Attacker becomes the counterparty in the newly-rotated session; the legitimate peer no longer shares that new secret; this reproduces classic MITM but via the rotation channel specifically, so it survives what would otherwise look like a clean forward-secrecy rotation |
| **Current mitigation** | None beyond the passive Safety Code (same caveats as the MITM entry above) |
| **Remaining risk** | High if the precondition (one stolen secret) is met — this is the single most consequential *protocol-design* gap identified across all documents in this repo, per the crypto audit's own framing, and it is unchanged by anything added this session |

### Replay

| | |
|---|---|
| **Required capability** | Ability to capture and re-inject a previously-observed ciphertext blob on the same transport it was originally observed on |
| **Attack path — relay-fallback path:** | `isFreshTimestamp()` (`App.tsx:103-109`, 15-min window) rejects stale replays — **PROVEN**, unchanged this session |
| **Attack path — live P2P path:** | Fixed this session per `SECURITY_AUDIT_CRYPTO_CLAIMS.md`'s own fix log and independently confirmed present in `SECURITY_STATE_MACHINES.md`'s closing section — `type:'text'` messages on the live DataChannel now get the same freshness check |
| **Attack path — key-exchange messages specifically:** | Also fixed this session (`keyExchangeDone` guard, `SECURITY_STATE_MACHINES.md` §5) — a duplicated/replayed `kyber_pubkey`/`kyber_ciphertext` after an established session is now dropped, not silently re-keyed |
| **Attack path — `secret_start` replay within the freshness window, after a legitimate `secret_end`:** | **Still open** — `isFreshTimestamp()` is staleness-aware, not sequence-aware (`SECURITY_STATE_MACHINES.md` §10, Finding 5) — a captured `secret_start` can resurrect an already-ended self-destruct timer for up to the remainder of the 15-minute window |
| **Security impact** | Narrow UI-state confusion for the surviving gap, not a confidentiality break |
| **Current mitigation** | Timestamp freshness only |
| **Remaining risk** | Low-but-real for the one surviving gap; the higher-value replay vectors (message content, key exchange) are now closed |

### Traffic correlation / timing correlation

| | |
|---|---|
| **Required capability** | Passive observation of the relay's traffic (as the relay operator) or of either endpoint's network link (as an ISP) |
| **Attack path** | Correlate `/packet` POST/GET timing, WS-subscribe contact-set binding (`relay.js:876-889`), and TURN-credential-request timing to build a "who talks to whom, how often, roughly how much" graph — none of this requires breaking any cryptography (§2.2) |
| **Security impact** | Full relationship-graph reconstruction for a sufficiently patient relay-position attacker; content stays opaque |
| **Current mitigation** | None beyond what's inherent to short in-RAM TTLs limiting the *retention* window, not the real-time observability |
| **Remaining risk** | High for the relay operator specifically (structural, not a bug); moderate for a pure network/ISP observer who does not also operate the relay, since they see only encrypted/opaque endpoints without the relay's privileged view of `contactId` tagging |

### Peer / contact enumeration ("identity enumeration" mapped to this app's model)

| | |
|---|---|
| **Required capability** | Ability to send repeated `/phone/lookup` requests |
| **Attack path** | Rate-limited to 20 misses/5min/IP (`relay.js:110-124`) but not eliminated — `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 6's own finding: "a patient attacker can still slowly enumerate candidate phone-number hashes... across many IPs or over many windows" |
| **Security impact** | Confirms whether a specific phone-number pair is *currently* attempting to connect on Malachi — a real presence/contact-discovery side channel |
| **Current mitigation** | Per-IP miss-rate throttle only |
| **Remaining risk** | Moderate — slow and IP-distributable, but real and previously documented, unchanged this session |

### Eclipse-style attack (malicious relay selectively drops/delays messages to/from specific peers)

| | |
|---|---|
| **Required capability** | Control of the relay process |
| **Attack path** | Since the relay is the sole rendezvous/signaling/fallback path (§1.13), it can trivially choose to never store, never deliver, or delay-past-TTL any specific `contactId`'s packets, `/reconnect/*` offers, or (per §3.2 below) `device_wiped` notices — the client has no independent channel to detect selective censorship, only total silence indistinguishable from "peer is offline" |
| **Security impact** | Full, targeted denial-of-service against one or both sides of a specific pairing, with no forgery needed — the relay doesn't even need to break any crypto, just decline to do its job for specific keys |
| **Current mitigation** | None — this is inherent to a single, centralized rendezvous point, not a coding bug |
| **Remaining risk** | High for availability, structurally zero for confidentiality/integrity (the attacker still cannot read or forge content) — exactly the "broken, not unsafe" framing `SECURITY_CHAOS_TESTING.md` uses throughout, extended here to the deliberately-malicious case rather than just the unreliable-network case |

### Relay manipulation — full blast radius of a **fully malicious** (not merely metadata-curious) relay

This is the case the mandate specifically asks to go beyond "compromised for
metadata" and evaluate as fully hostile:

- **Cannot:** read message/image/audio/call-signaling plaintext (AEAD,
  PROVEN); forge a valid AEAD ciphertext without the shared secret; learn any
  contact's shared secret via any code path (never transmitted in a recoverable
  form).
- **Can:** drop, delay, or duplicate any packet at will (§3.1 Eclipse, above);
  learn the complete real-time relationship/timing graph (§2.2); learn raw IPs
  of every connecting device (`hashIp()` only obscures this from *other*
  log-readers, not from the relay process itself — see Part 4); mint TURN
  credentials for itself if it also controls the TURN secret (near-certain in
  the default single-operator deployment, §1.5) and thereby force both peers'
  media through a relay it fully controls at the transport level (media
  confidentiality then rests entirely on DTLS-SRTP, a separate, non-PQ,
  WebRTC-internal guarantee this document does not re-derive); rewrite SDP
  during signaling to bias ICE candidate selection toward paths it observes;
  selectively suppress the `device_wiped` tombstone notice (§3.2) or any
  `delete_chat`/`secret_end` notice, leaving stale state on one side
  indefinitely (`SECURITY_STATE_MACHINES.md` §9/§10); replay a captured
  `kyber_pubkey`/ciphertext up until this session's fix closed that
  specific vector (now closed); silently overwrite a colliding `/packet`
  store key under concurrent load — not maliciously in the original finding,
  but a hostile relay could deliberately engineer the same millisecond
  collision `SECURITY_CHAOS_TESTING.md` Scenario 5 found accidentally,
  to intentionally drop specific messages.
- **Net verdict:** the blast radius of a fully malicious relay is
  **complete availability/metadata compromise, zero content-confidentiality
  compromise** — a materially different (better) outcome than a traditional
  centralized-server messaging app precisely because the relay was never
  trusted with keys. This is the architecture's central, genuinely-earned
  security property, and it holds even under the "fully malicious, not just
  curious" framing the mandate asks for.

## 3.2 Device revocation (`device_wiped`) under this attacker model — analyzed fresh this pass

**Mechanism, as implemented this session** (`App.tsx:1218-1262`,
`web/src/App.tsx:253-259`): on the 5-fail wipe path, the device collects every
contact it still has a live secret for, encrypts a
`{type:'system', subtype:'device_wiped', ts:Date.now()}` packet under each
contact's existing shared secret, and POSTs each one to the relay's `/packet`
endpoint — fire-and-forget, no retry, sent **before** the local secret/contact
data is wiped (order deliberately chosen so the notification can still be
constructed) but with the network call itself **not awaited** (`App.tsx:1225-1231`
comment: "kein await auf das Netzwerk", so the local wipe proceeds immediately
regardless of whether the send completes).

**Could a network attacker who controls the relay forge a `device_wiped`
notice?** **No** — forging one requires producing a validly-authenticated AEAD
ciphertext under the target pairing's `sharedSecret`, which the relay never
possesses (§1.8). A malicious relay cannot manufacture a fake wipe notice for a
pairing it doesn't hold the secret for. This is a genuine, structurally-sound
negative result worth stating plainly: **the relay cannot lie to a device about
its peer having been wiped.**

**Could a network attacker who controls the relay suppress a `device_wiped`
notice?** **Yes, trivially, in two ways:**
1. **Drop it outright** — the `/packet` POST is fire-and-forget with no
   application-level ack for this specific message type (the client-ack
   redelivery mechanism `SECURITY_CHAOS_TESTING.md` documented applies to the
   general `/packet` GET path, but there is nothing that specifically forces
   *this* sender to confirm the wipe notice was picked up — the wiping device
   is, by the time any ack could return, already mid-wipe or gone).
2. **Delay it past the 15-minute freshness window** — since `device_wiped` is
   included in the `isSystemControl` freshness-checked set
   (`web/src/App.tsx:673`, mirrored natively), a relay that holds the packet
   for >15 minutes before finally delivering it causes the receiving device to
   silently discard it as stale, with **zero indication to either party that a
   wipe notice existed and was rejected.**

**What happens if the relay does suppress it?** Exactly the pre-existing
"orphaned contact" failure mode `SECURITY_STATE_MACHINES.md` §9 already
described for the no-notification case: the peer's device keeps retrying
reconnects against a contact that will never answer again, for up to the
33-day `EXPIRE_RECONNECT` TTL, with no user-facing error. The `device_wiped`
mechanism added this session is therefore a **best-effort improvement that a
malicious (not just unreliable) relay can unilaterally defeat**, without
needing to break any cryptography — it reduces the *accidental*-loss case
(network blip, app killed before send) to the same residual risk the
*adversarial* case already had. This is a fair, honest characterization: the
feature is valuable against ordinary unreliability and a curious-but-passive
relay, and provides no additional guarantee against a relay that has
specifically decided to suppress it.

## 3.3 Session recovery / reconnect — attacker model check

Already covered structurally in §3.1 (Connection Hijacking) and Part 1 §1.9;
no new gap found by re-examining it specifically under the full attacker
capability list — the reconnect protocol's exposure to an attacker holding one
stolen secret plus relay/TURN-position access is the dominant risk, unchanged
by this session's fixes (which addressed *duplicate-message* re-keying, not
the *legitimate-looking hijacked reconnect* scenario, which remains a
distinct, deferred, "needs new protocol design" gap per Claim 3's own framing).

---

# Part 4 — Metadata Risk Analysis

**Scope discipline, per the mandate:** content is explicitly out of scope here —
Parts 1–3 already established content confidentiality holds. This section is
metadata only.

## 4.1 Metadata-by-metadata visibility table

| Metadata | Comm. partner | Relay | Signaling (=relay) | Discovery (=relay) | ISP | Network observer | Compromised peer |
|---|---|---|---|---|---|---|---|
| IP address (raw) | No (P2P ICE candidates reveal it directly during connection setup — a separate exposure, WebRTC-inherent, not relay-mediated) | **Yes, always, in real time** — the relay computes `hashIp()` from the real connecting IP every single request; the HMAC only obscures this from someone reading logs *after the fact without the process's in-memory secret* | same | same | Yes (trivially, for its own subscriber) | Only if positioned on-path | Only the peer's own P2P-negotiated IP (via ICE), not the relay's broader view |
| NAT type/topology | Implicit (whether TURN was needed at all signals symmetric NAT/restrictive firewall — `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 7) | Same implicit signal, plus explicit (it issues the TURN credentials) | same | same | No | No | No |
| Connection timing | Yes (naturally, it's a live call) | Yes (every request timestamped implicitly by arrival) | same | same | Yes | If on-path | Only for calls it's part of |
| Connection duration | Yes | Yes (via signal/TTL lifecycle, `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` table) | same | same | Yes | If on-path | Only its own sessions |
| Peer discovery events | Yes (it's the other party) | Yes (phone-hash/QR-relayed SDP all transit it) | same | same | No (unless it can also see relay traffic) | No | No |
| Signaling metadata (SDP structure, ICE candidate count) | Yes | Yes (it forwards the whole SDP blob, encrypted content aside) | same | same | Partial (packet sizes/timing only) | Partial | No |
| Relay usage (P2P vs. fallback) | Implicit (does the message arrive fast/live or delayed) | Yes, directly (it's the fallback path itself) | same | same | No | No | No |
| Connection failures / retries | Partial (own side) | Yes (repeated `/reconnect/*` POSTs are directly visible) | same | same | Partial (retry traffic pattern) | Partial | No |
| Peer IDs (`contactId`) | Yes (both sides know it) | Yes, tagged on nearly every routed request (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` consolidated table) | same | same | No (opaque bytes to it) | No | Only for its own contacts |
| Device IDs (web `deviceId`/pepper fingerprint) | No (not exchanged with peer) | Yes (`relay.js:79,611-707`) | same | same | No | No | No |
| Message/attachment size | Yes | Yes (`total`/`mimeType` in transfer metadata, `relay.js:352-374`) | same | same | Yes (packet-size level) | Yes (packet-size level) | No |
| Traffic patterns (burst vs. steady, cover traffic) | Yes | Partial (sees relay-fallback traffic only; P2P cover traffic, `_startCoverTraffic()` every 3s, is invisible to the relay once P2P is up) | same | same | Yes, for the full P2P stream too (ISP sees all packets regardless of relay involvement) | Yes, if on-path for either endpoint | No |
| Presence/online-offline | Yes (that's the point of contact) | Yes, and with unusual precision via WS-subscribe (§2.2) | same | same | Partial (connection activity) | Partial | Only for shared contacts |
| Group communication | N/A — no group feature exists (confirmed, §2.1 matrix) | N/A | N/A | N/A | N/A | N/A | N/A |
| Retry patterns | Yes (own side) | Yes (every retried POST is a new, fully visible request) | same | same | Partial | Partial | No |

## 4.2 Correlation findings — where seemingly-harmless signals combine

**Does message size + timing correlate to message type even under encryption?**
**Yes, structurally, and this was not previously stated this precisely.**
Because each message type has a recognizable shape even as ciphertext:
- Text messages: small, variable-but-bounded payloads, arriving in bursts that
  correlate with typing/response latency.
- Image transfers: `ImageCrypto.js` chunks with fixed-ish chunk sizes
  (`ImageCrypto.js:41-45`), a `total` count visible to the relay in the
  transfer-store metadata itself (`relay.js:352-374`, not even hidden inside
  ciphertext — it's a plaintext field of the transfer record), and a
  characteristic multi-request burst pattern.
- Audio messages: similarly chunked, but with duration-correlated total size
  (`AudioCrypto.js`).
- Cover traffic (`_startCoverTraffic()`, every 3s): a very regular,
  fixed-interval pattern that a relay observing the *fallback* path (not
  applicable once P2P is live, since cover traffic is a P2P-only mechanism per
  `WebRTCManager.js:436-475`) could distinguish from genuine bursts by its
  metronomic regularity.

**A relay (or ISP) does not need to break AEAD to distinguish "the user just
sent a photo" from "the user sent a short text" from "the connection is merely
idling on cover traffic."** This is inherent to any system that doesn't pad
every message to a uniform size and doesn't send real traffic at indistinguishable
intervals from cover traffic — not a Malachi-specific implementation bug, but a
real, concrete limitation worth stating precisely rather than folding into a
generic "metadata leaks" statement.

## 4.3 `hashIp()` — precisely what it does and does not protect against

This deserves its own subsection because it's easy to over-credit the fix made
this session. The mechanism (`relay.js:259-266`, `ipLogSecret =
crypto.randomBytes(32)` generated fresh at process startup, HMAC-SHA256 keyed
by it):

- **Protects against:** an attacker or a later reader of the relay's log files
  who does **not** also have live access to the running process (or its
  restart-to-restart-changing key) precomputing a rainbow table of
  `sha256(ip)` for the entire IPv4 space and reversing every historical log
  entry at will, forever, cheaply — this closed a real, demonstrated flaw
  (`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 3).
- **Does NOT protect against:** the relay operator/process itself, at
  runtime, ever "not knowing" a connecting IP. The HMAC is computed **inside
  `relay.js`, from the real source IP, using a secret `relay.js` itself
  generated and holds in memory for its entire process lifetime.** Every
  request's raw IP is available to the process the instant it arrives
  (`req.socket.remoteAddress`, wherever `hashIp(ip)` is called) — the hashing
  only changes what gets **written to the log file**, not what the live
  process computed the hash *from*. A relay operator watching live traffic,
  or a relay that's been modified (maliciously or otherwise) to also log raw
  IPs alongside the hash, learns nothing less than before. **This needs to be
  stated with precision, per the mandate:** `hashIp()` is a **log-hygiene**
  improvement, not an **IP-minimization** improvement — the relay process
  always has full, real-time knowledge of every connecting IP; the fix only
  narrows what a *separate* party who later obtains log files (without also
  compromising the live process's memory) can reconstruct.

## 4.4 CONTENT vs. METADATA vs. NETWORK privacy vs. ANONYMITY — confirmed distinctions

| | Does Malachi provide it? |
|---|---|
| **Content privacy** (message/image/audio/call-signaling confidentiality) | **Yes**, strongly, per Part 1/2/3 and the crypto audit |
| **Metadata privacy** (hiding who-talks-to-whom, when, how much) | **No**, not meaningfully — §2.2/§4.1 show the single server-side process has a structurally privileged, real-time view of the relationship graph |
| **Network privacy** (hiding that this app/protocol is in use at all, or hiding traffic patterns from an ISP) | **No** — ordinary WebSocket/HTTPS-or-HTTP traffic to a specific relay host, TURN allocation patterns, and (if TLS isn't configured, `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 4) potentially fully plaintext-visible protocol structure to any on-path observer |
| **Anonymity** (no party can link actions to a real-world identity) | **Not claimed, and not provided** — confirmed absent as a claim (Claim 10) and, per this analysis, would not hold even if claimed, given the phone-number-hash and IP-observability findings above |

This app should be described, precisely, as providing **strong content
confidentiality with weak-to-moderate metadata privacy and no network-level or
identity-level anonymity** — a materially different (and more honest)
sentence than "Zero-Knowledge," and this document confirms the app does not,
in its actual code or in the one place it says "Zero-Knowledge" to an end
user, claim the stronger properties it doesn't have (aside from the Claim 6
gap already flagged: the phone-connect string omits its own caveat).

## 4.5 Concrete improvement possibilities (no architecture change — explicitly deferred to Part 5)

- Pad message/image/audio chunk sizes to a small set of fixed buckets to
  reduce the size↔type correlation in §4.2 — a parameter/constant change to
  `ImageCrypto.js`/`AudioCrypto.js`/`MessageCrypto.js`'s existing chunking
  logic, not a protocol redesign.
- Make cover traffic's interval jittered rather than a fixed 3s
  (`WebRTCManager.js:436-475`) to reduce its distinguishability from real
  traffic bursts — a tuning change to an existing mechanism.
- Consider whether `/phone/lookup`'s rate limit should be tightened or made
  progressive (not just a flat 20/5min cap) given the enumeration finding in
  §3.1 — a parameter change, not new protocol.
- Document explicitly (in the relay's own header comment, which this session
  already made more honest once) that `hashIp()` is a log-hygiene control, not
  an IP-minimization control, so operators and readers don't over-credit it —
  a documentation-only change.

None of these require the architectural rework Part 5 discusses — they are
noted here only because the mandate asked for "concrete improvement
possibilities" within this section specifically, without redesigning anything.

---

# Part 5 — Alternative Architecture Comparison

**Framing, per the mandate:** this is a comparative analysis, not an
implementation plan. No new cryptographic primitive or protocol is designed
here. Anywhere a genuine fix would require inventing new crypto, it is flagged
as **needs independent cryptography review** rather than sketched.

## 5.1 Comparison table

| Component | CURRENT | PROBLEM | PROPOSED (reference-point only) | SECURITY BENEFIT | PRIVACY BENEFIT | PERFORMANCE COST | COMPLEXITY COST | NEW RISKS |
|---|---|---|---|---|---|---|---|---|
| **Identity** | None — no keypair, no account (§1.1) | No cross-device identity, no durable "safety number" concept beyond one ephemeral per-session secret | A long-term identity keypair per device (PQ-safe, e.g. an ML-DSA/Dilithium signing key, referencing FIPS 204 conceptually — **needs independent cryptography review** for the specific scheme choice), used only to *sign* ephemeral KEM public keys, never to derive message keys itself (Signal's separation of identity keys from session keys is the reference shape here) | Makes reconnect-hijack (§3.1) detectable/preventable — a forged reconnect offer would need to also forge the identity signature | None directly — could actually reduce privacy if the identity key becomes a durable correlatable handle unless carefully scoped per-pairing | Extra signature verify per handshake — small | Real: needs key storage, backup/loss story, and a "verify this is really the same identity as before" UX (a proper Safety Number flow, not the current opt-in hash) | A durable identity key is also a durable *target* — if the device is compromised once, ALL past and future pairings signed by that key are suspect, a new class of blast radius the current fully-ephemeral design avoids |
| **Peer discovery** | Phone-hash rendezvous (unsalted, known-numbers-only privacy) + QR/deep-link (out-of-band) | Rendezvous hash isn't secret against anyone who knows both numbers (§3.1); no protection against enumeration beyond a flat rate limit | A discovery mechanism using a PAKE/OPRF-style blinded lookup, so the relay learns only "some lookup happened" without being able to test candidate number-pairs at all, even if it wanted to (real password-authenticated-key-exchange literature is the reference point — **needs independent cryptography review**, the relay's own `/pepper/*` comments already acknowledge this exact class of gap for a different secret) | Closes the "acquaintance/relay-with-side-info can inject" attack (§3.1) | Reduces relay's ability to test hypotheses about who's pairing with whom | Real: PAKE/OPRF protocols require more round trips and either client or server-side computation increase | Significant — this is genuinely new protocol design, not a config change | A poorly-implemented PAKE can introduce its own offline-dictionary or online-guessing weaknesses; must not be improvised |
| **Signaling** | Centralized relay, single process, mandatory choke point for the first handshake (§1.4) | Single point of both availability failure and metadata-observation privilege (§1.13, §2.2) | A decentralized or federated signaling layer (multiple independent relay operators a user can choose between, or a DHT-based rendezvous as some P2P messengers use) — Tor/mixnet-style multi-hop relaying is a relevant reference concept for hiding *which* relay operator sees a given pairing, not for replacing the relay's function entirely | Removes the single-operator total-metadata-visibility property (§2.2, §3.1's relay-manipulation section) | Substantial — no single party sees the whole graph | High — added latency, operational complexity of running/coordinating multiple nodes | Very high — this is a genuine distributed-systems redesign, self-hosting complexity increases sharply (works against this project's own stated self-hosting simplicity goal) | Sybil/eclipse attacks against the decentralized layer itself become a new concern; needs its own threat model |
| **NAT traversal** | Relay-issued TURN credentials, same operator by default; TURN control channel now TLS-capable (this session's fix) but plaintext port still open | Default deployment ties TURN trust to the same single operator as everything else (§1.5) | Make TURNS-only the default (remove/disable the plaintext 3478 fallback in the setup script), and support user-specified independent TURN operators | Removes the plaintext-control-channel metadata exposure entirely by default | Splitting TURN operator from relay operator removes one operator's ability to correlate call attempts with everything else it already sees | Negligible (TURNS vs TURN is a config choice, not a new protocol) | Low — this is a scoped config/script change (already 90% done this session) | An independent TURN operator is a new third party to trust for call-media relaying, though DTLS-SRTP already limits what they can extract |
| **Relay (message fallback)** | Single in-RAM process, `EXPIRE_MS`-bounded storage, delete-on-fetch (with client-ack redelivery added this session) | Millisecond store-key collisions still silently drop messages under load (`SECURITY_CHAOS_TESTING.md` Scenario 5, unfixed); single-process means total availability dependency | Multiple relay replicas behind a shared, versioned store (or a proper message queue with idempotent IDs) — general distributed-queue design, not new cryptography | Removes the store-key-collision message-loss bug class entirely; improves availability | None directly (same content-blindness either way) | Moderate — replicated storage has its own consistency cost | Moderate — this is ordinary distributed-systems engineering, not new crypto, but is real work | A shared store across replicas is a slightly larger attack surface (inter-replica sync channel) that must itself be secured |
| **Session establishment** | Fully interactive Kyber exchange, no prekeys, requires both parties simultaneously reachable (§1.9, `SECURITY_SECRETS_LIFECYCLE.md` §0 table) | No offline/asynchronous pairing — both must be online (or route through the relay) at the same moment; this is explicitly by design, not an oversight | A prekey-bundle model analogous to Signal's X3DH (published one-time and signed-prekey KEM public keys a device can fetch even while the owner is offline) — **needs independent cryptography review** for adapting the *shape* of X3DH to a KEM-only (non-DH) primitive, since X3DH as literally specified relies on DH combinations Kyber doesn't directly provide | Enables asynchronous first contact (a real usability/robustness gain, arguably also a security one since it removes the "must be online" constraint that currently makes users tolerate long-lived sessions to avoid reconnect friction, per Claim 3's own observation) | Neutral to slightly negative — published prekeys are a small new correlatable artifact (a public key visible before use) | Small (bundle fetch) | High — this is the single largest protocol change in this table, genuinely new cryptographic protocol design | Signal's own history shows prekey depletion/reuse and prekey-signature-stripping attacks are real; **do not improvise this without independent review** |
| **Message routing** | Direct P2P when possible, relay fallback otherwise, no padding/timing obfuscation | Size/timing correlation to message type (§4.2) | Fixed-size padding buckets + jittered cover traffic (already a parameter tuning task, not new crypto — see §4.5) | Reduces traffic-analysis surface | Meaningful reduction in size/timing-based type inference | Small bandwidth overhead from padding | Low | None significant — padding is a well-understood technique |
| **Group messaging** | Does not exist (confirmed absent, §2.1) | N/A currently, but worth addressing since the mandate asks whether/how it could be added | If added: a sender-keys or per-member-pairwise-KEM model (MLS — Messaging Layer Security — is the relevant modern reference point for group ratcheting) — **needs independent cryptography review**, this is genuinely hard to get right even for teams building exactly this | Would need its own forward-secrecy/post-compromise-security analysis; naive N-way pairwise Kyber does NOT give the same guarantees as a proper group ratchet | Group membership metadata (who's in the group) becomes a new, larger relationship-graph target for the relay unless specifically designed against it | Significant — group re-keying on membership change is not free | Very high | Group protocols have a much larger history of subtle bugs (e.g. member-removal races) than 1:1 — this is the single riskiest addition in this whole table if attempted without dedicated expertise |
| **Device linking** | Does not exist — one `EncryptedStorage` instance IS the device/account (§1.2) | No multi-device support at all; losing a device loses everything (by design) | A device-linking protocol (QR-scan-to-link, analogous to Signal's linked-devices model) with each linked device getting its own KEM identity, all authorized under a single user-controlled root | Enables recovery/continuity without weakening per-message E2E | New devices are a natural place for the relay to observe "these N devices belong to one user" — a genuinely new metadata category this architecture currently avoids entirely by not having the concept | Moderate (multi-device fan-out for message delivery) | High | Device-linking flows are a common real-world attack target (fake "link a new device" social engineering) — needs careful, dedicated UX/security co-design, not a bolt-on |
| **Offline messaging** | Relay-fallback store with in-RAM TTL, plus a durable on-disk `queue_<id>` for outbound media specifically (not for outbound text — `SECURITY_STATE_MACHINES.md` §7) | Ordinary text/system messages have no durable send-side queue equivalent to the media queue; relay-side TTL bounds how long a message can wait for an offline recipient | Extend the existing durable-queue pattern (already proven for media) to all outbound message types uniformly | Closes the specific asymmetry `SECURITY_STATE_MACHINES.md` flagged (text messages less durable than media) | None | Negligible | Low — this reuses an existing, working pattern, not new design | None significant |
| **Key recovery** | None — losing the PIN (native) or PIN+pepper (web) is unrecoverable by design (confirmed, `SECURITY_SECRETS_LIFECYCLE.md` §8) | Legitimate users with no malicious intent lose everything on a forgotten PIN, same as an attacker would | Any recovery mechanism (recovery codes, social/threshold recovery, escrow) *necessarily* creates a bypass path for the same "no recovery" property that currently also blocks attackers — this is a fundamental, unavoidable security/usability trade-off, not an implementation gap | Trades some brute-force-wipe security for user-friendliness | Any escrow party (even a threshold/social one) becomes a new metadata/trust surface | N/A | Moderate-to-high depending on scheme chosen | **Needs independent cryptography review** for any specific scheme (e.g. Shamir secret sharing among trusted contacts) — easy to accidentally reintroduce a single point of failure |
| **Account recovery** | N/A — no accounts exist to recover (§1.1/1.2) | Same trade-off as Key recovery — inherent to having no identity layer at all | If Identity (row 1) is added, account recovery becomes a distinct, additional question layered on top — deliberately not conflated with Key recovery above | — | — | — | — | Compounds with the Identity row's own new risks |
| **Metadata minimization** | Content-blind relay, short TTLs, HMAC-fixed IP hashing (this session) but full real-time IP/graph visibility to the live process (§4.3) | The single-process design structurally cannot avoid real-time metadata visibility no matter how logs are hardened | A mix-network-style batching/delay layer between clients and the relay (Tor's core idea — batch and delay to break timing correlation) is the relevant reference concept, **not** a specific protocol to adopt wholesale (full Tor integration is a major undertaking, not a drop-in) | Would meaningfully reduce the relay's *real-time* correlation advantage, not just its post-hoc log-based one | Significant, if genuinely implemented — this is the one row that could actually change the §2.2 finding (relay can reconstruct the relationship graph) from "structural" to "mitigated" | High — mixnets trade latency for privacy, directly at odds with the app's current low-latency chat/call experience | Very high | Mixnet integration is a research-grade undertaking on its own; do not treat this row as a scoped task |

## 5.2 What this comparison deliberately does not do

Per the mandate, no row above specifies wire formats, key sizes, or exact
protocol steps for anything flagged "needs independent cryptography review" —
Identity (signing scheme choice), Peer discovery (PAKE/OPRF construction),
Session establishment (KEM-based X3DH-analog), Group messaging (MLS-style
ratchet), and Key recovery (threshold scheme) all fall into this category.
Naming Signal's X3DH/Double Ratchet, MLS, and Tor/mixnet concepts above is
strictly for **shape/reference**, consistent with the mandate's own
instruction — this document does not attempt to adapt any of them to Kyber's
specific KEM (not DH) interface, which is a nontrivial cryptographic-design
question in its own right (ML-KEM does not compose with X3DH's DH-combination
step the way X25519 does) and is exactly the kind of gap a real
follow-on cryptography review would need to resolve before any of these rows
became implementable.

## 5.3 Summary priority, if this table were ever acted on (analysis, not a recommendation to build)

Ordered by the mandate's own stated priorities (confidentiality → integrity →
forward secrecy → post-compromise security → minimal server knowledge →
minimal metadata → secure peer auth → device mgmt → offline robustness →
relay fallback → sync), the rows with the best benefit-to-risk ratio, purely
as a comparative observation, are: **Offline messaging** (reuses a proven
pattern, near-zero new risk), **NAT traversal** (mostly already done this
session, low remaining cost), and **Message routing padding/jitter**
(parameter tuning, meaningful metadata benefit). The rows with the worst
benefit-to-risk ratio if rushed are **Group messaging** and **Peer
discovery's PAKE replacement** — both are the ones this document most
strongly flags as needing dedicated, independent cryptographic review rather
than being attempted inside a general security-review pass like this one.

---

## Closing cross-reference

This document's five parts are cumulative: Part 1's trust-boundary graph is the
substrate Part 2's matrix is built on; Part 2's "relay can reconstruct the
relationship graph" finding is the precondition for most of Part 3's
relay-manipulation and traffic-correlation entries; Part 3's concrete attack
paths are exactly what Part 4's metadata table quantifies per-signal; and
every row in Part 5 references back to a specific problem established in
Parts 1–4 rather than inventing a new one. The single fact worth carrying
forward above all others: **this architecture achieves strong, genuinely
earned content confidentiality against a fully malicious relay, at the cost
of a relay that structurally sees the complete communication-relationship
graph in real time** — that trade-off is real, is not currently mis-stated as
"Zero-Knowledge" anywhere as precisely as it should be, and is the correct
starting point for any future architectural discussion about this project.
