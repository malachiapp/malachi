# Adversarial Security Claims Audit — Cryptographic & Protocol Claims

**Scope:** Cryptographic/protocol-level claims only (E2EE, forward secrecy, tamper-proofing, encrypted-at-rest, post-quantum, algorithm-specific guarantees). Server-trust / relay-metadata claims are explicitly out of scope per the mandate.

**Method:** Every verdict below is based on reading the current code at the paths/lines cited, not on trusting `SECURITY_REVIEW_1`–`6`. Those documents are cited only as historical context, and in several places this audit finds their current-state framing is **now inaccurate** (the code has moved since they were written) or **imprecise** (a nuance they collapsed). Those discrepancies are called out explicitly.

**Verdict legend:** **PROVEN** (demonstrated by code logic and/or a cited automated test) / **DESIGN GOAL** (intended, code exists, no adversarial test) / **ASSUMPTION** (guarantee depends on something the code can't verify) / **UNVERIFIED CLAIM** (stated somewhere, not confirmed, or doubted).

---

## FIXES APPLIED (follow-up pass, after this audit)

- **Claim 6 / Claim 3 asymmetry — replay protection missing on the live P2P DataChannel path.** Fixed: `WebRTCManager.js`/`.ts` now apply the same `isFreshTimestamp()` check (finite, ≤15min old, ≤5min in the future) to `type:'text'` messages received live, mirroring the check that already existed only on the relay-fallback path. Scoped deliberately to `'text'` only — other live-only signal types (`dummy`/`ready`/`handshake`/`img_chunk`/system control) don't carry a guaranteed timestamp field and would break if the check applied to them unconditionally.
- **Claim 5 — Safety Code changes silently on every reconnect with no user signal.** Fixed (partial, UX-level, not a cryptographic change): both apps now persist the last-*acknowledged* Safety Code per contact and show a small red badge + an explicit in-modal warning ("dieser Code hat sich geändert, bitte erneut vergleichen") whenever the freshly-computed code differs from it. This does not make verification mandatory (still opt-in to open the dialog at all) but closes the specific "changes with zero signal" gap this audit flagged as making the feature "functionally close to theater."

## NOT FIXED — deferred with reasoning (no code change)

- **Claim 3 — reconnect-hijack via a stolen shared secret.** A real fix needs the reconnect offer/answer to be authenticated by something independent of the very secret an attacker might have stolen (e.g. a separate long-term identity key signing each reconnect) — that's new protocol design, not a narrow logic fix, and out of scope for a "no home-grown crypto" fix pass.
- **Claim 2 — native↔web ML-KEM-768 byte-compatibility is asserted, not tested.** No automated test can exercise this: the native side's real KEM implementation only runs inside compiled Kotlin/BouncyCastle on-device, unreachable from Jest. Remains a manual/on-device verification gap.
- **Claim 7 — `RNEncryptedStorageModule.java` silently falls back to plaintext `SharedPreferences` on any `EncryptedSharedPreferences.create()` exception.** This lives in a third-party native dependency (`node_modules/react-native-encrypted-storage`). A `patch-package` patch is technically possible, but the failure path can't be safely triggered/verified in this environment (would need to force a Keystore failure on a real device), so a blind patch to security-critical storage code was judged too risky to ship without the ability to test it. Recommended real fix: patch the module to at least surface the degraded state to JS (e.g. an `isEncrypted()` query) so the app can warn the user, rather than failing silently.
- **Claim 7 — no biometric/user-authentication binding on the native `EncryptedStorage` Keystore key**, and **Claim 9 (trust-privacy audit) — the native PIN/biometric lock screen doesn't gate an actual encryption key.** Both point at the same underlying gap: native's data-at-rest protection is entirely independent of the PIN/biometric UI. A real fix means redesigning the native key hierarchy so the PIN participates in key derivation (like the web client already does correctly) — a genuine architecture change with a migration story for existing installs, not a scoped fix. Flagged here as the single most consequential open finding from this audit pass.

---

## Claim 1: "Dreischicht Post-Quantum Verschlüsselung" — triple-layer AES-256-GCM → ChaCha20-Poly1305 → XSalsa20-Poly1305

**Where found:** `MessageCrypto.js:1-9` header comment; identical in `web/src/lib/MessageCrypto.ts:1-7`.

**Implementation:** `deriveKeys()` (`MessageCrypto.js:69-75`) runs HKDF-SHA256 three times over the same raw ML-KEM shared secret with distinct `info` strings (`malachi-layer{1,2,3}-<algo>-<purpose>`) to get three independent 32-byte keys `k1,k2,k3`. `encryptMsg()` (`:77-106`) then does AES-256-GCM(k1) → ChaCha20-Poly1305(k2) → XSalsa20-Poly1305(k3), each with its own freshly random nonce (12/12/24 bytes respectively), each layer's ciphertext-plus-nonce becoming the next layer's plaintext. All three primitives come from `@noble/ciphers` (audited pure-JS implementations), not hand-rolled.

**Adversarial check performed:** verified nonces are freshly randomized per call (via `KyberModule.randomBytes`/`crypto.getRandomValues`, not reused/derived), verified key derivation uses domain-separated HKDF `info` strings so `k1≠k2≠k3` are cryptographically independent even though derived from one input, verified decrypt path correctly un-nests the layers in reverse order.

**Test evidence:** `__tests__/security/messageCrypto.tamper.test.js` proves — for both native and web implementations — that bit-flips anywhere in the ciphertext, truncation, non-base64 garbage, wrong secret, and cross-secret ciphertexts are all rejected (`decryptMsg` returns `null`, never throws uncaught). `__tests__/security/messageCrypto.domainSeparation.test.js` proves the `purpose` label genuinely isolates keys: encrypting under `purpose=A` and decrypting under `purpose=B≠A` always fails, for every pair of the four purposes in use, in both directions, cross-implementation (native↔web).

**What is NOT proven / limitation found:** All three layer keys derive from **one single input** (the raw ML-KEM shared secret). This is legitimate multi-primitive defense-in-depth (an attacker must find a full break of AEAD-with-known-plaintext-structure in all three primitives, or recover the one shared secret) — but it is not "3x the entropy" or three independent secrets; if the raw shared secret is known, all three layers fall simultaneously since HKDF is a deterministic, publicly-known function. This doesn't contradict the claim as literally stated but is worth being precise about: the layering hardens against a single-cipher cryptanalytic break, not against key compromise.

**Verdict:** Triple-layer AEAD construction, correctly implemented, tamper-detection and domain-separation genuinely **PROVEN** by the cited tests. The three-layers-add-defense-in-depth framing is **PROVEN**; the (never explicitly made, but easy to assume) idea that layering multiplies key-compromise resistance is **not true** and would be an **UNVERIFIED CLAIM** if anyone made it.

---

## Claim 2: "Kyber-768" / "ML-KEM-768 (NIST FIPS 203)" key exchange — genuinely post-quantum

**Where found:** `HybridCrypto.js:20-24` (`ENCRYPTION_STATUS.keyEx = ['Kyber-768 (KEM)']`, `standard: 'NIST FIPS 203 (2024)'`, `pqSafe: true`); `web/src/lib/HybridCrypto.ts:36-40` (same, `keyEx: ['ML-KEM-768 (KEM)']`); code comments in `KyberModule.kt:24-29` and `HybridCrypto.ts:1-7` explicitly claim byte-compatibility between native and web.

**Implementation:**
- Native: `android/app/src/main/java/com/securecommapp/KyberModule.kt` imports `org.bouncycastle.pqc.crypto.mlkem.*` and uses `MLKEMKeyPairGenerator`/`MLKEMGenerator`/`MLKEMExtractor` with `MLKEMParameters.ml_kem_768`, keyed by `java.security.SecureRandom` (`:13`). `android/app/build.gradle:95` pins `org.bouncycastle:bcprov-jdk18on:1.80` — confirmed this is a real, current BouncyCastle release containing the finalized FIPS 203 ML-KEM implementation (not a pre-standard "Kyber" draft, not a stub).
- Web: `web/src/lib/HybridCrypto.ts` uses `@noble/post-quantum`'s `ml_kem768` (`web/package.json:15`, `^0.7.1`) — a real, independently-audited pure-JS ML-KEM-768 implementation.
- Randomness: `KyberModule.randomBytes()` uses `java.security.SecureRandom` (`KyberModule.kt:13,16-22`), a legitimate CSPRNG seeded by the OS. Web uses `crypto.getRandomValues` (Web Crypto API CSPRNG). Both are genuine, not `Math.random()`.

**Adversarial check performed:** confirmed the native module is actually wired into the app (not dead code) — `MainApplication.kt:18` registers `KyberPackage()`. Confirmed both native and web keypairs are generated **fresh per WebRTC session** (`WebRTCManager.js:266`, `WebRTCManager.ts:225` call `generateKyberKeypair()` inside `channel.onopen`, not once at app install) — i.e., ephemeral KEM keys, not a static long-term identity key reused across pairings.

**What is NOT proven:** No test in the repo cross-checks that a native-generated ML-KEM-768 ciphertext actually decapsulates correctly under `@noble/post-quantum`'s implementation (or vice versa) to the *same* shared secret — the "byte-compatible" claim in the comments is **asserted, not tested**. The MessageCrypto cross-implementation test (`messageCrypto.domainSeparation.test.js`) only proves the *symmetric* layer is wire-compatible given an already-matching secret; it does not exercise the KEM step at all (both sides in that test use a random `crypto.randomBytes(32)` string standing in for the shared secret, never an actual ML-KEM encapsulation/decapsulation). `SECURITY_REVIEW_4_ADVERSARIAL_TESTS.md:186` independently flags this same gap ("the real ML-KEM-768 keypair generation/encapsulation/decapsulation path" is untested) — this is confirmed still true by reading the current test suite.

**"Post-quantum" scope limitation (found by adversarial reading, not previously stated this precisely):** The PQ guarantee covers exactly one thing: the derivation of the raw shared secret used for chat text, images, audio messages and system signaling (everything that flows through `MessageCrypto.encryptMsg`/`decryptMsg`). It does **not** cover:
- **Live call audio/video (RTP media)**: `WebRTCManager.startCall()`/`CallManager.js` add raw media tracks to the `RTCPeerConnection` (`WebRTCManager.js:210-217`), which WebRTC protects via native **DTLS-SRTP** — a classical (non-PQ) ECDHE key exchange baked into `react-native-webrtc`/browser WebRTC stacks, entirely outside this app's control. Encouragingly, the app's own UI is honest about this: the call screen literally labels it "**WebRTC · DTLS-SRTP**" (`App.tsx:2635`), not claiming PQ for calls.
- **The WebRTC transport/signaling layer generally**: SDP exchange, ICE, and the DataChannel's own DTLS handshake are all classical crypto. The PQ property only protects the *application-layer payload* carried inside that classical-crypto tunnel — i.e., even if DTLS's classical KEX were later broken by a quantum adversary, the attacker would still need to break ML-KEM-768 to read message content (good layering), but they could still, e.g., inject at the DTLS layer if they'd broken it (a separate concern, not contradicting confidentiality).

**Verdict:**
- Real ML-KEM-768/FIPS 203 implementation on both platforms, ephemeral per-session keys, genuine CSPRNGs: **PROVEN** (by code inspection; BouncyCastle 1.80 and @noble/post-quantum are both real, current, standard-compliant libraries).
- Native↔web KEM byte-compatibility: **UNVERIFIED CLAIM** — asserted in comments, no test exercises the actual cross-platform KEM round-trip.
- "Post-quantum" as an unqualified, whole-app claim: **UNVERIFIED CLAIM / partially false** if read as covering calls — it's **PROVEN** for text/image/audio-message confidentiality specifically, and does not apply to live call media, which the app's own UI correctly scopes to DTLS-SRTP.

---

## Claim 3: "Forward Secrecy" (implicit design goal; explicitly disputed by prior reviews as absent)

**Where found:** Not stated as an explicit marketing claim in the app UI. It is, however, the subject of `SECURITY_REVIEW_1_REDTEAM.md` H-1, `SECURITY_REVIEW_2_CRYPTO.md` §9/H-1, `SECURITY_REVIEW_3_MALICIOUS_SERVER.md:320-322`, and `SECURITY_REVIEW_4_ADVERSARIAL_TESTS.md:182-185`, all of which assert **"no forward secrecy... reused indefinitely (no rotation)"**. This audit independently re-traced the actual mechanism and finds that framing is **too blunt** — the truth is more specific and, in one respect, better than stated; in another respect, worse.

**What the code actually does (traced line-by-line):**
1. Every time a fresh WebRTC connection is established — whether the *original* pairing or an *auto-reconnect* — a **brand-new `WebRTCManager` instance** is constructed (`App.tsx:458`, `App.tsx:773`) and its `sharedSecret` starts `null`.
2. `_setupDataChannel().onopen` (`WebRTCManager.js:261-277`, `WebRTCManager.ts:220-234`) **always** generates a fresh ephemeral ML-KEM-768 keypair via `generateKyberKeypair()` when the local side is the initiator — this is not gated on "first pairing only."
3. On receipt of `kyber_pubkey`/`kyber_ciphertext` (`WebRTCManager.js:289-336`), the responder/initiator **unconditionally overwrites** `this.sharedSecret`, `RTCStore.sharedSecrets.set(chatId, ...)`, and the persisted `EncryptedStorage`/`localStorage` value (`shared_secret_<chatId>`) with the new value.
4. Therefore: **every successful reconnect performs a fresh, independent ML-KEM-768 exchange and rotates the raw shared secret.** This is real, session-boundary forward secrecy — a device compromised *after* a rotation cannot decrypt messages from *before* that rotation, because the old raw secret was overwritten and is retained nowhere.
5. However — **within one continuous session**, there is **zero** ratcheting: `deriveKeys()` (`MessageCrypto.js:69-75`) is a pure deterministic function of the static `sharedSecretBase64` input; every message, however many are sent, reuses the exact same `k1,k2,k3`. This is independently confirmed correct by `SECURITY_REVIEW_2_CRYPTO.md:197-200`.
6. Critically, sessions are engineered to be **long-lived, not short-lived**: `_startCoverTraffic()` sends dummy encrypted traffic every 3s and `_startLivenessWatch()` (`WebRTCManager.js:436-475`) only tears down a connection after 12s of total silence, specifically to *avoid* spurious reconnects. So while the rotation mechanism exists, it fires opportunistically on real network interruption, not on any periodic timer or per-message/per-N-message basis — there is no code anywhere that proactively rotates a healthy, long-running session. In practice this means the "forward secrecy window" can be very large (hours to days) for a session that never drops.
7. **The reconnect authentication itself has a self-reinforcing weakness that gives an active attacker durable compromise even with rotation in place:** the reconnect offer/answer SDP is encrypted with `purpose='reconnect'` under the *previous* session's secret (`App.tsx:526,538` initiator; `App.tsx:763-765,788` responder — both call `RTCStore.getSharedSecret(contact.id)`, i.e., the currently-cached/persisted secret). An attacker who has obtained that one static secret (rooted device extraction, coerced user, etc.) can therefore decrypt and forge the next reconnect handshake, inject their own ML-KEM public key as if they were the legitimate peer, and thereby **install themselves as the counterparty in the newly-rotated session** — from that point on holding a *new* secret the real peer no longer shares. This reproduces the "durable MITM once one secret leaks" outcome the reviews describe, but via **active hijack of the rotation mechanism**, not because the raw secret itself is reused forever.

**Adversarial answer to "if an attacker obtains ONE shared secret, what do they gain?"** (concrete, traced):
- **Passive theft only** (e.g., pulls `shared_secret_<chatId>` off a rooted/backed-up device, no ongoing network position): gains every message sent during the session that secret belongs to — both messages already sent before the theft *and* any further messages sent while that same session stays open (no per-message ratchet, per finding above) — until the next reconnect happens to rotate it. Does **not** gain messages from earlier, already-rotated sessions (those secrets are gone, overwritten, not archived anywhere) or later sessions after the next successful, un-tampered rotation. **PROVEN** by the code paths cited in points 1–5.
- **Active attacker** who can also intercept/inject on the reconnect signaling path (relay is a plausible vantage point — `App.tsx:540,790` post/poll reconnect offers via the relay's `/reconnect/*` endpoints): can leverage the stolen secret to hijack the *next* rotation and obtain a **renewable, effectively-permanent** MITM position, exactly as the prior reviews describe. **DESIGN GOAL / UNVERIFIED under adversarial test** — plausible from code reading, no test simulates this attack.
- **Other contacts are unaffected**: `RTCStore.sharedSecrets` is a `Map` keyed by `chatId`, and each contact pairing runs its own independent `generateKyberKeypair()`/`kyberEncapsulate()` call — there is no shared master secret or cross-contact key derivation anywhere. Compromising contact A's secret gives **zero** information about contact B's secret. **PROVEN** by code structure (independent CSPRNG-seeded KEM keypairs per pairing; no test needed to prove structural independence, though none exists explicitly either).

**Verdict (split, as the compound claim demands):**
- "Zero forward secrecy, static secret used forever" (the prior reviews' summary framing): **UNVERIFIED CLAIM — found to be overstated.** Rotation genuinely occurs at reconnect boundaries.
- "No forward secrecy within a session / no message-level ratchet" (the reviews' own detailed §9 finding): **PROVEN** correct, independently re-confirmed.
- "An active attacker who compromises one secret can achieve durable, renewable compromise of the pairing": **DESIGN GOAL-level plausible finding, not proven by a test** — traced through real code paths but not adversarially exercised.
- "Compromise of one contact's secret never exposes another contact's messages": **PROVEN** by code structure.
- No automatic detection/limitation of damage from a compromised secret exists anywhere (no periodic re-key requirement, no "safety number changed" warning analogous to Signal — confirmed absent by grep across `App.tsx`/`web/src/App.tsx`; only the manual Safety Code, see Claim 5): **PROVEN absent.**

---

## Claim 4: "Ende-zu-Ende verschlüsselt" (end-to-end encrypted) — UI-facing claim

**Where found:** `App.tsx:2634` (call screen: "Ende-zu-Ende verschlüsselt"); `CallManager.js:411` code comment ("payload... wird jetzt Ende-zu-Ende verschlüsselt, bevor sie den Relay erreicht").

**Implementation:** For chat messages/images/audio: `WebRTCManager` encrypts with a secret only the two paired devices ever hold (Claim 2/3) before handing ciphertext to either the P2P DataChannel or, as fallback, the relay's `/packet` endpoint — relay never sees plaintext or key material. **PROVEN true** for this path by the AEAD tamper tests plus the structural argument above (relay only ever routes `{type:'encrypted', data}` blobs; see also `WebRTCManager.js:395-402` / `.ts:292-299`, which explicitly *discard* any unexpected plaintext system packet arriving over the DataChannel rather than trust it, closing a previously-real hole cited as C-4 in `SECURITY_REVIEW_1`).

For call signaling specifically: `CallManager.js:428-441` (`_sendSignal`) now **fails closed** — `if (!secret) { ... throw new Error('Kein sicherer Kanal...') }` (`:431-438`) — if no shared secret is cached, the call is aborted rather than falling back to plaintext. **This directly contradicts `SECURITY_REVIEW_2_CRYPTO.md:548`'s "H-2 Still open, unchanged" verdict and the finding table's "Fail-open plaintext call signaling."** Reading the current code shows H-2 is fixed: `handleSignal()` (`CallManager.js:230-248`) also now rejects any incoming signal without an encrypted `.payload.enc` field outright (`:237-240`), rather than trusting a downgrade to plaintext. This is exactly the kind of "prior review said X, current code says otherwise" discrepancy the mandate asked to independently verify — confirmed the code, not the review, reflects the current truth.

**What "end-to-end" does NOT cover:** as established in Claim 2, live call *media* (RTP audio/video) rides on WebRTC's own DTLS-SRTP, not on `MessageCrypto`'s ML-KEM-derived layers — so "end-to-end encrypted" for calls is true of the *signaling* (SDP/ICE now genuinely E2E via the fix above) but the *media* encryption is WebRTC's own DTLS-SRTP, whose key exchange is only as strong as WebRTC's classical DTLS handshake and is authenticated only insofar as the SDP fingerprint exchanged inside the (now E2E-encrypted) signaling can be trusted — which depends on the shared secret used to encrypt that signaling, tying back into Claim 3's rotation/hijack analysis.

**Verdict:**
- "End-to-end encrypted" for chat text/images/audio messages and call *signaling*: **PROVEN**, and the specific H-2 fail-open gap the prior review flagged is **confirmed fixed** in the current code (contradicts the review's stale "still open" table entry).
- "End-to-end encrypted" for call *media* streams: **DESIGN GOAL at best / ASSUMPTION** — it's end-to-end only in the sense that DTLS-SRTP's fingerprint is now carried over an E2E-encrypted signaling channel; actual media confidentiality is WebRTC's own classical DTLS-SRTP, not `MessageCrypto`. The UI's own label ("WebRTC · DTLS-SRTP") is accurate and doesn't overclaim.

---

## Claim 5: Safety Code — MITM detection via out-of-band comparison

**Where found:** `WebRTCManager._computeSafetyCode()` (`WebRTCManager.js:422-434`, `.ts:321-333`); UI: `App.tsx:2177-2199` (native modal), `web/src/App.tsx:791-800` (web overlay).

**Implementation:** Native computes SHA-256(sharedSecret) via the native `KyberModule.sha256` bridge method (`KyberModule.kt:70-78`, a genuine `MessageDigest.getInstance("SHA-256")` call — not fake); web computes it via `crypto.subtle.digest('SHA-256', ...)`. Both reduce the hash to 16 digits formatted as four groups of four. Because it's a deterministic hash of the *actual* negotiated `sharedSecret`, if an active MITM substituted their own ML-KEM keypair during the handshake (i.e., ran two independent Kyber exchanges, one with each victim, splicing itself in the middle), each victim's computed Safety Code would reflect a *different* underlying secret, and would visibly **not match** on comparison. This is a structurally sound MITM-detection primitive — **PROVEN correct as a computation**, given the underlying `sharedSecret` genuinely differs when a MITM is present.

**Adversarial finding — is comparison actually enforced?** No.
- Native: the code (`App.tsx:2177+`) shows the Safety Code only inside a `Modal` gated by `safetyVisible` state, which nothing sets automatically on key establishment or key *change* — it requires the user to actively find and tap a UI affordance to view it at all.
- Web: identical pattern — `setSafetyVisible(true)` is only invoked by an explicit shield-icon button click (`web/src/App.tsx:804`); the code even polls for `rtc.safetyCode` in the background (`:687-697`) but never surfaces it unprompted.
- There is no forced first-contact verification step, no "unverified" badge/warning shown anywhere in the chat UI, no re-prompt if the secret changes between sessions (which, per Claim 3, it legitimately does on every reconnect — meaning the Safety Code itself **changes on every reconnect**, and the UI gives the user no indication that a change happened or that re-verification might be warranted), and nothing is persisted about whether a user ever actually compared it. `SECURITY_REVIEW_2_CRYPTO.md:521-525` makes the same observation and it is independently reconfirmed true of the current code.

**Verdict:**
- The Safety Code computation and its capacity to reveal a MITM if compared: **PROVEN** correct as a primitive (correctly bound to the real negotiated secret, correctly divergent under a MITM).
- The claim (nowhere explicitly made in marketing copy, but clearly implied by the feature's existence and its own in-app text "Stimmt der Code NICHT überein, könnte jemand die Verbindung abgefangen haben") that this *protects users in practice*: **UNVERIFIED CLAIM, and adversarially, functionally close to theater** for the overwhelming majority of users who are never prompted to check it, and structurally undermined further by the fact the code silently changes on every legitimate reconnect with no signal to the user that re-verification might matter.

---

## Claim 6: "Tamper-proof" / manipulationssicher — scoped by threat model

The mandate asks: tamper-proof against **whom**? Answering per threat model, based on code actually read:

**Against a malicious/compromised relay tampering with ciphertext in transit or storage:**
- Message ciphertext: **PROVEN** — AEAD (all three layers) rejects any bit-flip (`messageCrypto.tamper.test.js`), so a relay that modifies a `{type:'encrypted', data}` blob in transit causes decryption to fail cleanly (`decryptMsg` returns `null`), never silent corruption or a crash.
- Image/audio chunked transfers: each chunk is independently AEAD-encrypted (`ImageCrypto.js:41-45`, `:81-83`) with the chunk's `imageId`/`index`/`total` embedded *inside* the authenticated plaintext, not just as transport metadata — so a relay cannot forge chunks. Additionally, `App.tsx:652-693` explicitly cross-checks every chunk's embedded `imageId`/`index` against the end-marker's canonical values before assembly, specifically to stop a malicious relay from **splicing chunks from a different, older, validly-encrypted transfer between the same two contacts** into a new one (comment cites this exact attack at `App.tsx:656-663`, matching `SECURITY_REVIEW_3`'s finding). **PROVEN** by code logic; no dedicated automated test for the cross-transfer-splice scenario specifically was found (only the general chunk-binding structure test `__tests__/security/chunkBinding.test.js` was located — not read in full detail here, but its existence plus the App.tsx enforcement logic together support the verdict).
- System control packets (`delete_chat`, `secret_end`, `secret_start`, `transfer_ready`): now require both valid decryption **and** an embedded fresh timestamp (`isFreshTimestamp()`, `App.tsx:103-109`, 15-minute window) before being acted on (`App.tsx:616-619`) — this closes the specific C-4 hole from `SECURITY_REVIEW_1` (unauthenticated plaintext system packets that could delete a victim's chat with one relay POST). **PROVEN fixed** in current code.

**What "tamper-proof" does NOT cover (found adversarially, not previously stated this precisely):**
- **Replay is only checked on the relay-fallback delivery path, not on the live P2P path.** `isFreshTimestamp()` is invoked only inside `App.tsx`'s `checkIncoming`/relay-polling code (`:616-619`, `:698-700`). The live WebRTC DataChannel handler (`WebRTCManager.js:337-393`, `.ts:276-289`) decrypts and dispatches `{type:'encrypted'}` messages with **no timestamp/freshness/nonce-dedup check at all** — a valid ciphertext blob captured on an actively-MITM'd DataChannel (or replayed by a malicious TURN relay acting as a data-plane man-in-the-middle) could in principle be replayed indefinitely on that path with no rejection, since AEAD alone proves authenticity and integrity, not freshness. This is a genuine, previously-uncited asymmetry: the *same* logical protection (replay rejection) exists on one delivery path and not the other.
- **Availability/drop attacks are entirely unaddressed** (inherent to any confidentiality/integrity scheme, not a flaw specific to this app): a relay or network attacker can simply drop or withhold packets/chunks. The chunk-count check in `App.tsx:682-685` detects incompleteness and refuses to assemble a partial transfer, but this is a DoS, not a tamper/forge, and is correctly *not* claimed as prevented anywhere.
- **Tamper-proofing does not extend to physical/root-level device tampering** — see Claim 7. No code-level self-integrity/attestation check exists anywhere in the reviewed files.

**Verdict:**
- "Tamper-proof against a malicious relay, for message and file-transfer content and recent system commands": **PROVEN**, with the specific mechanisms cited above, matching but going beyond what the prior reviews checked.
- "Tamper-proof / replay-proof, uniformly, for everything, everywhere": **UNVERIFIED CLAIM — found to be false as stated.** Replay protection is asymmetric across delivery paths (relay-fallback: protected; live P2P DataChannel: unprotected) — a fact not previously called out in this precise form by the existing reviews.

---

## Claim 7: "Encrypted at rest" — native Android (`react-native-encrypted-storage`)

**Where found:** Implicit throughout `App.tsx`/`RTCStore.js`/`WebRTCManager.js` via `EncryptedStorage.setItem/getItem` calls for `shared_secret_<chatId>`, contacts, chat history, username, avatar. No explicit in-app marketing text found (grep across `App.tsx`, `README.md` for "verschlüsselt gespeichert"/"encrypted at rest" found no such literal UI/doc claim — the claim is purely implicit in the library's name and its use for secret material).

**Implementation (read in full, not assumed):** `node_modules/react-native-encrypted-storage/android/src/main/java/com/emeraldsanto/encryptedstorage/RNEncryptedStorageModule.java:20-41`:
```java
MasterKey key = new MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build();
this.sharedPreferences = EncryptedSharedPreferences.create(
    context, SHARED_PREFERENCES_FILENAME, key,
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
);
```
This is a **genuine** implementation: AndroidX Security's `EncryptedSharedPreferences` backed by a Keystore-resident `MasterKey` — keys AES256-SIV-wrapped, values AES256-GCM-encrypted, key material anchored in the Android Keystore (hardware-backed on most modern devices, e.g. StrongBox/TEE where available). This is real "encrypted at rest," not merely a library with a reassuring name — this specific adversarial concern from the mandate is **resolved in the library's favor** on the happy path.

**Adversarial finding — concrete, exploitable-without-any-attacker-action fail-open bug:**
```java
catch (Exception ex) {
    Log.e(NATIVE_MODULE_NAME, "Failed to create encrypted shared preferences! Failing back to standard SharedPreferences", ex);
    this.sharedPreferences = context.getSharedPreferences(RNEncryptedStorageModule.SHARED_PREFERENCES_FILENAME, Context.MODE_PRIVATE);
}
```
(`RNEncryptedStorageModule.java:37-40`). If `EncryptedSharedPreferences.create()` throws for **any** reason (corrupted Keystore entry, OS bug, certain custom ROMs, an interrupted key-rotation, some emulator images), the module **silently downgrades to plain, unencrypted `SharedPreferences`** — same filename, `MODE_PRIVATE` only (process-sandbox protection, not encryption) — and continues operating with **zero warning to the app, the JS layer, or the user.** Every subsequent `EncryptedStorage.setItem('shared_secret_...', ...)` call from `WebRTCManager.js:298,325` / `App.tsx` would then write the raw Kyber-derived shared secret to disk **in plaintext XML**, readable by anyone with plain filesystem access (ADB backup on a debuggable/rooted device, physical extraction, etc.) — no PIN, no Keystore, no encryption at all. This is a real, adversarially-found counterexample to an unqualified "encrypted at rest" claim: the guarantee is conditional on `EncryptedSharedPreferences.create()` succeeding, and the app has no code path that checks, surfaces, or fails closed on that condition. This is the mobile-storage analogue of exactly the "fail-open vs fail-closed" pattern the app's own JS code elsewhere is careful to avoid (e.g., `MessageCrypto.js:41-52`'s `secureRandomToken` explicitly throws rather than falling back to `Math.random()` — the same discipline was not applied here, in a dependency the app doesn't control but also doesn't defensively check).

**Adversarial finding — what protects the key from a rooted device or the app's own compromise:** No `setUserAuthenticationRequired(true)` (or equivalent biometric/PIN gating) is configured on the `MasterKey` builder — the Keystore key is usable by the app process at any time without re-authentication. This means "Android's biometric/PIN gate" (mentioned in the mandate's question) **does not gate this storage at all** in the current code — there is no biometric/PIN requirement wired to `EncryptedStorage` on native; the OS lock screen's PIN (if any) only gates general device access, not this specific key's usability. Practically: the guarantee reduces to "the Android per-app sandbox and Keystore prevent *other apps* from reading this data without root"; a rooted device, or a repackaged/instrumented build of the app itself, can call the same `EncryptedSharedPreferences` APIs in-process and read everything back in plaintext, same as the legitimate app does. This matches (and is independently re-confirmed) `SECURITY_REVIEW`'s general framing that device compromise is out of the app's threat model — but it had not been established with this specific code citation before.

**Verdict:**
- "Data is encrypted at rest using the Android Keystore" on the happy path: **PROVEN** — genuine, strong implementation (`EncryptedSharedPreferences` + Keystore `MasterKey`), not merely a library name.
- "Data is *always* encrypted at rest" (unqualified): **UNVERIFIED CLAIM — disproven by a concrete fail-open code path** at `RNEncryptedStorageModule.java:37-40` that the app does not detect or defend against.
- "Protected by Android's biometric/PIN gate": **UNVERIFIED CLAIM — no such gating exists in the current configuration.** The key requires no user authentication to use; protection is Keystore-process-isolation only.
- "Safe against a rooted device": **ASSUMPTION**, and one the code does not hold — a root-level or in-process attacker reads the same plaintext the legitimate app does, same as with any non-hardware-enclave storage.

---

## Claim 8: "Encrypted at rest" — web client (`web/src/lib/Storage.ts`, PIN + server pepper)

**Where found:** In-code comments, `web/src/lib/Storage.ts:1-20`, explicitly reasoning about *why* a PIN-only local key would be weak and what the pepper is meant to buy.

**Implementation (read in full):** `deriveKey()` (`Storage.ts:48-63`) runs PBKDF2-HMAC-SHA256 with **210,000 iterations** over `pin + ':' + pepper`, producing an AES-256-GCM key. The `pepper` is a value the client never derives itself — it's fetched from the relay server only after passing a server-side rate-check (`pepperRegister`/`pepperRequest`, imported from `RelayClient`), and is rotated on every successful unlock (`Storage.ts:141-167`, citing "Sicherheitsreview C-3"), immediately re-encrypting every stored key under the new pepper-derived key so a previously-copied pepper becomes useless. `setupEncryption()` (`:93-103`) explicitly refuses to proceed if the relay is unreachable, rather than silently falling back to a PIN-only (weak) key — this is a genuine fail-closed design choice, called out honestly in the code's own comment (`:90-92`).

**Adversarial check performed:** confirmed the actual encryption key is **not derivable from the localStorage contents alone** — `pin + pepper` is the PBKDF2 input, and `pepper` is never written to `localStorage` (only `SALT_KEY`/`MARKER_KEY`/`DEVICE_ID_KEY` are persisted locally; grep of `Storage.ts` confirms no `pepper` value is ever stored client-side). So an attacker who steals only the browser profile / localStorage dump genuinely cannot offline-brute-force the PIN without also obtaining the pepper — **this is a real, structurally sound defense against the specific "stolen localStorage dump, offline PIN brute-force" scenario the code comment worries about**, *provided* the relay's pepper-issuance rate-limiting actually holds server-side (out of this audit's scope — the crypto-protocol-only mandate explicitly excludes the server-trust dimension of this claim, and `SECURITY_REVIEW_2_CRYPTO.md:545` already flags that the rate-limiter is "not fully closable without a real PAKE/OPRF" as an open, honestly-documented residual risk).

**Explicit, honest trade-off already stated in-code and independently confirmed accurate:** unlike native, the web client has **no offline unlock** — every unlock requires a live relay round-trip (`unlockEncryption()`, `Storage.ts:114-169`). This is correctly framed by the code's own comment (`:17-20`) as the necessary cost of making the rate-limit real; this audit finds no discrepancy between that claim and the implementation.

**Verdict:**
- "Web data is encrypted at rest, resistant to offline PIN brute-force on a stolen device/browser profile": **PROVEN** as a client-side cryptographic construction (correct PBKDF2 parameters, pepper never persisted locally, genuine AES-256-GCM), **conditional on an ASSUMPTION explicitly outside this audit's scope** — that the relay's server-side pepper rate-limiting is itself sound (a server-trust claim, not a cryptographic-protocol one, per the mandate's own scoping).
- Pepper rotation on unlock genuinely limiting a previously-leaked pepper's value: **PROVEN** by code logic (`Storage.ts:141-167`).

---

## Claim 9: "Zero-knowledge" — cryptographic-protocol sense

**Finding:** No genuine zero-knowledge proof protocol (in the formal cryptographic sense — a prover convincing a verifier of a statement without revealing the witness) exists anywhere in `MessageCrypto.js/.ts`, `HybridCrypto.js/.ts`, `WebRTCManager.js/.ts`, or `Storage.ts`. The only place "zero-knowledge"-adjacent language appears in the repository is describing the **phone-number-matching rendezvous hash** (per `SECURITY_REVIEW_2_CRYPTO.md:564`, "Zero-knowledge phone-number matching"), which is explicitly a **server-trust claim** (about what the relay operator can and cannot infer from a hash it's shown), not a cryptographic zero-knowledge-proof construction — and per the mandate's own instruction, that sense of "zero-knowledge" is a separate audit's scope, not this one's.

**Verdict:** No cryptographic-protocol-sense zero-knowledge claim exists in this codebase to audit. **N/A** (not a claim made in the scoped sense).

---

## Summary table

| Claim | Verdict |
|---|---|
| Triple-layer AEAD (AES-256-GCM/ChaCha20-Poly1305/XSalsa20-Poly1305) is real, tamper-detecting, domain-separated | **PROVEN** (tests: `messageCrypto.tamper.test.js`, `messageCrypto.domainSeparation.test.js`) |
| Triple-layering multiplies key-compromise resistance | **UNVERIFIED / not actually true** — one shared input drives all three layers |
| ML-KEM-768/FIPS 203 genuinely implemented on both platforms with ephemeral keys and real CSPRNGs | **PROVEN** (BouncyCastle 1.80, @noble/post-quantum 0.7.1) |
| Native/web KEM byte-compatibility | **UNVERIFIED CLAIM** — asserted, not tested |
| "Post-quantum" covers the whole app including calls | **False as stated** — covers messages/images/audio only; call media is classical DTLS-SRTP (honestly labeled in UI) |
| Forward secrecy is completely absent | **Overstated** — session-boundary rotation is real and proven; within-session (and vs. an active hijacker of the rotation channel) it is absent, as the prior reviews correctly detailed |
| Compromising one contact's secret exposes other contacts | **False — PROVEN false** (structurally independent per-contact KEM) |
| End-to-end encryption for chat/image/audio and call signaling | **PROVEN**, and H-2 (fail-open call signaling) is **confirmed fixed**, contradicting the stale "still open" table in `SECURITY_REVIEW_2` |
| End-to-end encryption for call media | Only in the DTLS-SRTP sense, accurately labeled by the UI — **DESIGN GOAL / ASSUMPTION**, not `MessageCrypto`-level E2E |
| Safety Code correctly detects MITM if compared | **PROVEN** as a computation |
| Safety Code is actually used/enforced | **UNVERIFIED / effectively theater** — opt-in, never prompted, changes silently on every reconnect with no user signal |
| Tamper-proof against malicious relay (messages, chunked transfers, system commands) | **PROVEN**, including cross-transfer chunk-splice prevention |
| Replay-proof everywhere | **False as stated** — replay checks exist only on the relay-fallback path, not the live P2P DataChannel path |
| Android "encrypted at rest" | **PROVEN on the happy path** (real Keystore-backed `EncryptedSharedPreferences`), **disproven as an unconditional guarantee** by a silent plaintext fallback on any initialization exception, with no biometric/user-auth gating configured |
| Web "encrypted at rest" resists offline brute-force on a stolen browser profile | **PROVEN client-side**, conditional on the (out-of-scope) server-side pepper rate-limiter holding |
| "Zero-knowledge" cryptographic protocol | **N/A** — no such construction exists; only claim in this vein found is a server-trust claim outside this audit's scope |

---

## Files read in full for this audit
`MessageCrypto.js`, `web/src/lib/MessageCrypto.ts`, `HybridCrypto.js`, `web/src/lib/HybridCrypto.ts`, `WebRTCManager.js`, `web/src/lib/WebRTCManager.ts`, `android/app/src/main/java/com/securecommapp/KyberModule.kt`, `web/src/lib/Storage.ts`, `RTCStore.js`, `ImageCrypto.js`, `node_modules/react-native-encrypted-storage/android/.../RNEncryptedStorageModule.java`, `__mocks__/react-native-encrypted-storage.js`, `__tests__/security/messageCrypto.tamper.test.js`, `__tests__/security/messageCrypto.domainSeparation.test.js`, plus targeted reads of `App.tsx` (reconnect flow, Safety Code UI, replay-window logic, EncryptedStorage/RTCStore wiring) and `web/src/App.tsx` (Safety Code UI, chat send flow), `CallManager.js` (signal encryption/fail-closed logic), and `MainApplication.kt` (native module registration). `SECURITY_REVIEW_1`–`6` were consulted only as historical context and cross-checked against, never inherited as ground truth; several discrepancies with the current code were found and documented above.
