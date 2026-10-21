# SecureCommApp ("Malachi") — Independent Cryptographic Protocol Review #2

Scope: full protocol reconstruction and crypto-focused re-examination, building on Review #1
(`SECURITY_REVIEW_1_REDTEAM.md`). Read-only, no code changed. Files read in full or in the
relevant sections: `HybridCrypto.js`/`.ts`, `android/app/src/main/java/com/securecommapp/KyberModule.kt`,
`MessageCrypto.js`/`.ts`, `WebRTCManager.js`/`.ts`, `App.tsx`, `web/src/App.tsx`,
`web/src/lib/Storage.ts`, `relay.js`, `CallManager.js`, `RTCStore.js`, `ImageCrypto.js`.

**Verification of Review #1's claimed fixes** (done by reading current code, not by trusting the
prior report): C-1, C-2, C-3, C-4 are all **substantively fixed** as described — confirmed line by
line below. However, this review finds that **C-1's fix is incomplete** (a vestigial code path
still leaks plaintext SDP to the relay — Finding N-1), that **C-4's fix does not provide replay
protection** (Finding N-3, and note H-2/M-4 from Review 1 are explicitly re-confirmed), and that
**H-2 (fail-open plaintext call signaling) was never fixed** despite being listed as "High" in
Review 1.

---

## Part 1 — Protocol reconstruction (as actually implemented)

### 1. Registration
There is no server-side account/registration. "Registration" = local first-run setup only.
- **Native**: `App.tsx` `SetupScreen`/`LockScreen` — user picks a display name (`AsyncStorage`,
  plaintext) and a PIN (`EncryptedStorage.setItem('app_pin', pin)`, compared by string equality on
  unlock — see M-1, unchanged from Review 1). No server contact at all; identity is purely local.
- **Web**: `web/src/lib/Storage.ts` `setupEncryption(pin)` — generates/persists a `deviceId`
  (`crypto.getRandomValues`, stored in **plaintext** `localStorage`), calls `POST /pepper/register`
  to get a server-held pepper, derives a PBKDF2(210,000, SHA-256) key from `pin + ':' + pepper`, and
  stores only a `salt` + an AES-GCM-encrypted marker locally. Requires the relay to be reachable at
  setup time (throws otherwise).
- **Dependent guarantee**: none directly — this step establishes the local unlock secret, not any
  E2EE identity. There is no persistent asymmetric "identity key" anywhere in this app (see below).

### 2. Identity-key generation
**There is no long-term identity key at all** — this is a structurally significant finding in its
own right (not a bug, but worth stating plainly for the "claims vs. reality" section below). Every
pairing/reconnect generates a **fresh, ephemeral ML-KEM-768 keypair** with no signature or
long-term key binding it to a person/device:
- Native: `KyberModule.kt generateKeypair()` — `MLKEMKeyPairGenerator` seeded from
  `java.security.SecureRandom` (a real CSPRNG). Confirmed genuine FIPS 203 ML-KEM-768 via
  `org.bouncycastle.pqc.crypto.mlkem` (BouncyCastle ≥1.80, post-final-standard).
- Web: `web/src/lib/HybridCrypto.ts` `generateKyberKeypair()` — `@noble/post-quantum`'s
  `ml_kem768.keygen()`, same FIPS 203 final standard. **Byte-compatible with native**: both encode
  raw ML-KEM-768 public/private keys per the same standard, base64-wrapped; verified by code
  inspection (same parameter set, same encoding used on both `encapsulate`/`decapsulate` paths, and
  the commit history / code comments state this was explicitly tested end-to-end after the
  BouncyCastle 1.80 upgrade specifically to fix a prior byte-incompatibility).
- **Who holds them**: only the two ends of one WebRTC DataChannel, in memory (`this.myKyberKeys` in
  `WebRTCManager`), never the relay.
- **Randomness**: native = `SecureRandom` (OS CSPRNG via Android). Web = whatever `@noble/post-quantum`
  uses internally (Web Crypto `crypto.getRandomValues` under the hood, per noble's standard design) —
  no `Math.random()` found in any Kyber/AES/ChaCha/XSalsa key-material code path on either side.
- **Storage**: the Kyber *keypair* itself is never persisted — only the resulting *shared secret*
  is (see step 4/6). Discarded when `WebRTCManager.close()` runs.
- **Rotation**: a new keypair is generated on **every** `channel.onopen` (every fresh
  `RTCPeerConnection`/DataChannel), including every reconnect. Good hygiene in isolation, but see
  Finding N-4: without any signature/authentication, "fresh key" only buys freshness, not identity
  assurance — an active MITM gets an equally fresh keypair for each side.
- **Deletion**: implicit, on `close()`/garbage collection; nothing to explicitly delete since it's
  never written to disk.
- **Dependent guarantee**: confidentiality of the *shared secret* derived per session — but with
  zero authentication of *who* you performed the KEM exchange with.

### 3. Pre-key generation
**None.** This is not a Signal-style X3DH/pre-key system. There is exactly one KEM exchange per
WebRTC session, performed live over the just-opened DataChannel (see step 4). No pre-keys are
published anywhere, so there is no "message someone while they're offline and get a session key
without them being online" capability at the KEM layer — offline delivery instead falls back to
reusing an *already-established* shared secret via the relay's `/packet` store-and-forward (step 5).

### 4. Key Exchange
Happens **over the WebRTC DataChannel itself**, after ICE/DTLS connectivity is already up, per
`WebRTCManager.js`/`.ts` `_setupDataChannel()`:
1. `channel.onopen`: if `isInitiator`, generate a fresh Kyber keypair, send
   `{type:'system', subtype:'kyber_pubkey', publicKey}` **in plaintext over the DataChannel**
   (intentional and fine — DataChannel is itself DTLS-encrypted at the WebRTC transport layer, and
   the public key isn't secret).
2. Responder's `onmessage` sees `kyber_pubkey` → `kyberEncapsulate(pubkey)` → gets
   `{cipherText, sharedSecret}` → sets `this.sharedSecret`, persists it (step 6), replies with
   `{type:'system', subtype:'kyber_ciphertext', cipherText}` in plaintext over the DataChannel.
3. Initiator's `onmessage` sees `kyber_ciphertext` → `kyberDecapsulate(cipherText, mySecretKey)` →
   same `sharedSecret` on both sides (verified byte-compatible per step 2).
4. Both sides compute a "Safety Code" (`_computeSafetyCode`): SHA-256 of the shared-secret
   *base64 string's UTF-8 bytes* (not raw bytes) → 16 numeric digits, grouped `XXXX-XXXX-XXXX-XXXX`.
   Native hashes via `KyberModule.sha256` (also UTF-8-of-base64-string input); web via
   `crypto.subtle.digest('SHA-256', encoder.encode(sharedSecret))` — **same input representation on
   both sides**, so the codes match when the secret matches. Good for its stated purpose.
- **Who holds the shared secret**: both DataChannel endpoints only. The relay/TURN/STUN
  infrastructure never sees it (assuming the WebRTC handshake that establishes the DataChannel was
  not itself MITM'd — see Finding N-1 for where that assumption is undermined).
- **Authentication**: **none**. Nothing signs the Kyber public key or ciphertext with any
  longer-lived identity key. Whoever is on the other end of the DataChannel completes the exchange
  "as" the contact. This matches Review 1's second-pass note and remains true.
- **Dependent guarantee**: confidentiality of all subsequent traffic under this specific
  `sharedSecret` — contingent entirely on the DataChannel having been established with the intended
  peer, which in turn is contingent on the offer/answer SDP exchange being authentic (see Session
  Establishment/Renewal below — this is exactly the C-1/C-2 attack surface).

### 5. Session Establishment (first pairing)
Two independent mechanisms, both now require a pre-shared secret before the SDP ever touches the
relay (per Review 1's C-1/C-2 fixes, confirmed):
- **QR/deep-link pairing** (`App.tsx` `ConnectScreen`): initiator generates a random PSK
  (confirmed via `secrets.local`-style random generation feeding `pskHex`/`pskB64`, exchanged only
  via the QR code/deep link, never sent to the relay), encrypts the SDP offer with
  `encryptMsg(offerJSON, pskB64)` before `POST /signal/offer`. Responder decrypts with the same PSK
  (from the scanned code), answers via `createAnswer()`/`encryptMsg(answer, pskB64)` →
  `POST /signal/answer`. **Finding N-1**: `createAnswer()` has an undocumented, security-relevant
  side effect that leaks a plaintext copy of the local answer SDP to the relay regardless — see
  below.
- **Phone-number connect** (`App.tsx` `startPhoneConnect`/`initiatePhoneConnect`, C-2 fix): rendezvous
  key `hashPhone()` = `SHA256("malachi_2026_phone_" + sorted(numberA,numberB))`; **separate**
  encryption key `derivePhonePSK()` = `SHA256("malachi_2026_phone_psk_" + sorted(numberA,numberB))`
  — correct domain separation between the two (different label prefixes, verified in code), so the
  relay-visible rendezvous hash and the SDP-encryption key are not the same value even though
  they're derived from the same input material. Explicitly documented, correctly-scoped residual
  limitation: protects only against an attacker who doesn't know both phone numbers.
  **Finding N-2**: both `hashPhone()` and `derivePhonePSK()` share an insecure fallback if
  `NativeModules.KyberModule?.sha256` is unavailable.
- **Storage of the resulting shared secret**: immediately upon Kyber exchange completion,
  `shared_secret_<chatId>` is written to `EncryptedStorage` (native, Android-Keystore-backed) or via
  `web/src/lib/Storage.ts setItem()` (web, PBKDF2(pin+pepper)-derived AES-GCM key) — i.e. "encrypted
  at rest" in both cases, gated by whatever protects the PIN/Keystore.
- **Dependent guarantee**: this is the step where an active MITM would have to occur to compromise
  everything downstream; C-1/C-2 close the *obvious* plaintext-relay path but see Finding N-1 for
  the residual leak, and note (per Part 1 §4) there is still no cryptographic binding of the SDP/Kyber
  exchange to a persistent identity — the PSK/phone-hash only proves "whoever answered knew the
  out-of-band secret," which is exactly the intended (and correctly scoped) trust model for a
  first-contact pairing app.

### 6. Session Renewal (reconnects)
Fixed per Review 1 C-1, confirmed by reading current code (`App.tsx` `checkOutgoing`/`checkIncoming`,
`web/src/App.tsx` equivalents):
- Initiator: `encryptMsg(JSON.stringify({sdp, answerKey}), existingSharedSecret)` →
  `POST /reconnect/offer`. Responder: fetches, **refuses to proceed if no cached shared secret
  exists** (`if (!secretForOffer) continue`), decrypts, **refuses if decryption fails** ("möglicher
  Angriff, verwerfen"), answers, `encryptMsg(answer, sameSecret)` → `POST /reconnect/answer`.
  This is a real, verified fix — both native and web reject any reconnect offer/answer that isn't
  successfully authenticated-decrypted under the shared secret already established during original
  pairing.
- **Key reused for this purpose**: the *same* raw Kyber-derived `sharedSecret` used for ordinary
  chat messages — run through the exact same `encryptMsg`/`decryptMsg` (same HKDF labels
  `malachi-layer{1,2,3}-...`). See Finding N-5 (domain-separation analysis) for why this specific
  reuse, while not a currently-exploitable key-recovery break, is a genuine hygiene gap that the
  task specifically asked to re-examine.
- **Finding N-1 (incomplete fix)**: native's reconnect **responder** path
  (`App.tsx:695`, `const answer = await rtc.createAnswer(JSON.stringify({ sdp: realSdp }));`) still
  calls `WebRTCManager.createAnswer()` — the method that, as a side effect, unconditionally
  registers a **new plaintext copy of the local answer SDP** with the relay via
  `sendSignalOffer(localOffer, token)` (`WebRTCManager.js:142-161`), where `token` is a
  freshly-`Math.random()`-generated, throwaway, never-consumed session token. The *actual* reconnect
  answer is correctly encrypted and sent via `sendReconnectAnswer` — but this vestigial call means
  the relay operator **also** receives a full plaintext SDP answer (DTLS fingerprint, ICE
  ufrag/pwd, candidate IPs) on every single native reconnect, silently, in addition to the encrypted
  one. **The web client does not have this bug for reconnects** — `web/src/App.tsx:159` correctly
  calls the purpose-built `createAnswerDirect()` (`WebRTCManager.ts:99-113`), which was explicitly
  written, per its own code comment, "ohne deren Nebeneffekt (Registrieren eines neuen, zufaelligen
  Pairing-Tokens via sendSignalOffer)" — i.e. the web author already identified and fixed exactly
  this problem for reconnects, but the equivalent native call site (`App.tsx:695`) was never
  updated to match, even though native's `WebRTCManager.js` *also* has `createAnswerDirect`
  available (lines 126–140) and simply isn't used there. Additionally, the same leak exists in
  **both** clients' *initial pairing* flow (`App.tsx:2920`, `web/src/App.tsx:572`, both call
  `createAnswer()` not `createAnswerDirect()`), so the relay gets a plaintext SDP answer copy on
  every first pairing too, independent of the properly-PSK-encrypted answer sent alongside it.
- **Dependent guarantee undermined**: the specific security property C-1 was supposed to
  fully restore — "the relay never sees SDP in the clear" — is **not actually achieved**; it only
  closes the *offer* leak and (on web) the reconnect-*answer* leak. Native reconnect answers, and
  both clients' pairing answers, still leak. Severity assessment and fix in Part 2.

### 7. Message Encryption / 8. Message Decryption
`MessageCrypto.js`/`.ts` `encryptMsg`/`decryptMsg`, used identically for chat text, image/audio
chunks, and (as of the C-1/C-4 fixes) reconnect offers/answers, phone-connect offers/answers,
call-signaling payloads, and system control packets:
1. `deriveKeys(sharedSecretB64)`: **standard RFC 5869 HKDF-SHA256** (not ad-hoc `SHA256(secret‖N)`
   concatenation — confirmed via `@noble/hashes/hkdf`), three independent 32-byte keys via three
   distinct `info` labels: `malachi-layer1-aes256gcm`, `malachi-layer2-chacha20poly1305`,
   `malachi-layer3-xsalsa20poly1305`. Correct domain separation **between the three cipher layers**.
   `salt` is `undefined` (HKDF spec-compliant fallback to zero-salt) — acceptable since the input
   keying material (the Kyber shared secret) is already high-entropy and unique per session.
2. Layer 1: AES-256-GCM, fresh random 12-byte nonce every call (`randomBytes(12)`, native via
   `KyberModule.randomBytes` → `SecureRandom`; web via `crypto.getRandomValues`).
3. Layer 2: ChaCha20-Poly1305 over the *entire* layer-1 output (nonce‖ciphertext‖tag), fresh
   random 12-byte nonce.
4. Layer 3: XSalsa20-Poly1305 over the layer-2 output, fresh random 24-byte nonce.
5. Output is `nonce3‖ciphertext3` base64-encoded; decryption reverses in the mirrored order.
- **Nonce reuse audit**: every call site that produces ciphertext (`MessageCrypto`, `ImageCrypto`,
  `AudioCrypto`, `WebRTCManager` cover-traffic, reconnect/system-packet/call-signal encryption) goes
  through this single `encryptMsg`, which draws **fresh CSPRNG randomness for all three nonces on
  every invocation**, including per-chunk in file transfers. No deterministic/counter-based/reused
  nonce pattern found anywhere. This is a genuinely solid property.
- **Key separation gap**: HKDF's `info` labels separate the 3 *layers* from each other, but **do
  not separate different *purposes*** of encryption under the same shared secret. See Finding N-5.
- **Dependent guarantee**: confidentiality+integrity of each individual encrypted blob, contingent
  on the shared secret's secrecy — but, per Finding N-3, **not freshness/replay-resistance**, since
  nothing in the plaintext or the transport carries a sequence number or timestamp that receivers
  check.

### 9. Key Ratcheting
**None exists.** Confirmed: no per-message or per-N-message forward-ratcheting anywhere in
`MessageCrypto.js`/`.ts`, `WebRTCManager.js`/`.ts`, or `RTCStore.js`. The same `sharedSecret`
(and hence the same three HKDF-derived layer keys) is used for the entire lifetime of a WebRTC
session, and is re-used again after every reconnect *unless* a full new Kyber exchange happens
(which only occurs when a brand-new `RTCPeerConnection`/DataChannel is created — not on every
reconnect attempt, since a still-"open" DataChannel is simply reused). This directly confirms
Review 1's H-1 finding stands, unchanged.

### 10. Device Addition
**Not a supported concept.** There is no multi-device/device-linking flow anywhere in the codebase
— each install is an independent local identity with its own set of pairwise `contact.id →
sharedSecret` relationships. "Adding a device" would in practice mean re-pairing that device from
scratch with each contact (a new QR/phone-connect flow per contact), which also means a brand
new, unrelated Kyber exchange and shared secret — i.e., no key continuity, no cross-device sync,
and (positively) no shared long-term key that a compromise of one device would leak for another
device's conversations.

### 11. Device Removal
Not applicable for the same reason — there's no device registry to remove from. The closest
analogue is deleting the app / the PIN-triggered wipe (see Logout/Account Deletion below), which is
purely local and has no server-side revocation step (the relay has no concept of "this device is no
longer authorized").

### 12. Key Change (re-pairing / renegotiation)
Only occurs when a **new** `RTCPeerConnection` is created from scratch (fresh `createOffer()`/
`createAnswer()`), which happens on: (a) first pairing, (b) whenever `WebRTCManager.close()` was
called and a subsequent reconnect attempt builds a new `RTCPeerConnection` (this *does* generate a
fresh Kyber keypair/shared secret each time — see step 4's "rotation" note), or (c) manually
re-scanning a QR code for an existing contact (creates a second `contact.id`, doesn't rotate the
old one). There is **no mechanism to force/prompt key rotation** on a cadence, on suspected
compromise, or after a failed Safety Code comparison — the Safety Code UI (native only, see Finding
N-6) is purely informational; there's no "re-key" button.

### 13. Recovery
No true "account recovery" exists (no server-side account). The two relevant flows:
- **Native PIN forgotten**: after 5 failed attempts, `LockScreen` performs a full local wipe
  (`AsyncStorage.clear()` + `EncryptedStorage.clear()` + queued-media-file deletion) — confirmed at
  `App.tsx:1011-1040+`. This is "recovery via data loss," not key recovery. All persisted
  `shared_secret_<id>` values are destroyed along with everything else, so all contacts must be
  re-paired from scratch afterward — which incidentally *does* provide a clean re-keying event, but
  only as a side effect of catastrophic data loss, not a designed recovery path.
- **Web PIN forgotten / pepper exhausted**: identical in spirit — 5 failed `/pepper/fail` calls (or
  5 unresolved-token timeouts) cause the server to delete the pepper entry (`pepperStore.delete`),
  after which `unlockEncryption()` returns `reason:'wiped'` and the client does
  `localStorage.clear()`. Same "recovery = wipe" model.
- **No mechanism exists to recover a shared secret / re-establish trust with a contact after key
  material is lost** other than a fresh pairing (QR/phone) — there is no backup/escrow of Kyber
  material anywhere (correctly — that would be a forward-secrecy anti-pattern), but also no
  Signal-style safety-number re-verification prompt when a contact's key changes; the app doesn't
  even track "this contact's key changed since last time" (each `contact.id` maps to exactly one
  slot in `RTCStore.sharedSecrets`/`EncryptedStorage`, silently overwritten on any new exchange —
  see Finding N-7, "missing post-compromise re-trust signaling").

### 14. Logout
**Native**: no distinct "logout" — PIN lock (`LockScreen`) re-locks the UI but does not clear
in-memory `RTCStore.sharedSecrets`/`GLOBAL_RTC`; the underlying `EncryptedStorage` keys remain
Keystore-encrypted at rest regardless of lock state (M-1 unchanged: the PIN itself is not what
protects that data cryptographically).
**Web**: `Storage.lock()` simply nulls the in-memory `dek` (`CryptoKey`); this is web's *only*
lock/logout primitive, triggered implicitly by nothing observed in the read files as an explicit
button — closing the tab/losing the JS heap has the same effect. All localStorage remains
AES-GCM-encrypted at rest under the PIN+pepper-derived key regardless.

### 15. Account Deletion
No server-side account exists to delete. Local-only equivalents:
- **Contact/chat deletion** (`App.tsx` `ChatScreen onDelete`, confirmed at `App.tsx:745-770`):
  correctly removes `chat_<id>`, `timer_<id>`, `secret_<id>`, **and `shared_secret_<id>`**, plus
  the pending `queue_<id>`, from `EncryptedStorage`, and removes the contact from the in-memory/
  `AsyncStorage` contact list. This is a genuinely complete key-deletion path — good finding,
  called out positively.
- **Full local wipe**: same code path as PIN-lockout wipe (step 13), reachable manually via
  Settings (not traced in detail here, but uses the identical `AsyncStorage.clear()`/
  `EncryptedStorage.clear()` primitives).
- **No relay-side deletion request exists** for any of the above — `relay.js` has no
  "deregister this contact/device" endpoint; stale `reconnect_<contactId>`/`offer_<token>`/
  `phone_<hash>` entries simply age out per their own TTLs (33 days for reconnect/signal offers!,
  10 minutes for packets, 2 minutes for call signals). A deleted-on-device contact whose reconnect
  offer was already posted to the relay leaves that ciphertext sitting there, addressable by anyone
  who still knows the (now-orphaned) `contact.id`, for up to 33 days.

---

## Part 2 — Findings

Findings are numbered N-1..N-7 (new in this review) plus explicit **re-confirmation** status for
every open item from Review 1. Severity scale matches Review 1 (Critical/High/Medium/Low).

### N-1. (High) C-1's fix is incomplete — `createAnswer()`'s vestigial relay-registration leaks plaintext SDP on native reconnects and on both clients' initial pairing

**Files/functions:** `WebRTCManager.js:142-161` (`createAnswer()`), called from
`App.tsx:695` (native reconnect responder — **should** call `createAnswerDirect()`, doesn't) and
`App.tsx:2920` (native initial pairing) and `web/src/App.tsx:572` (web initial pairing). Contrast
with the *correct* usage at `web/src/App.tsx:159` and `App.tsx:2685`, both of which use
`createAnswerDirect()`.

**The problem:** `createAnswer()` does two unrelated things: (1) build and return the actual SDP
answer, and (2) as an internal side effect, generate a **throwaway `Math.random()` token** and
`POST` the local answer SDP to `/signal/offer/{token}` **in plaintext**, purely to self-register a
new pairing slot nobody asked for and nobody will ever read back (the caller ignores this
registration and separately sends the *real*, properly-encrypted answer via
`sendReconnectAnswer`/`sendSignalAnswer`). The web author clearly recognized this was wrong for
reconnects and wrote a "slim" replacement, `createAnswerDirect()`, specifically to avoid it — the
code comment says so explicitly ("Schlanke Variante von createAnswer() ohne deren Nebeneffekt"). But:
1. Native's reconnect responder path (`App.tsx:695`) was never migrated to `createAnswerDirect()`,
   even though the exact same method exists in native's `WebRTCManager.js`.
2. **Neither** client's *initial pairing* answer path was ever migrated — both still call
   `createAnswer()`, so every first-time pairing leaks a full plaintext copy of the responder's SDP
   (DTLS fingerprint, ICE ufrag/pwd, candidate IP addresses) to the relay, via a code path that has
   nothing to do with the PSK-encrypted answer sitting right next to it in the same function.

**Attack path:** A malicious/compromised relay operator (the exact threat actor C-1 was written to
defend against) receives, on every native reconnect and on every pairing (both clients), a
plaintext SDP answer under a random unread token. This discloses network-topology metadata
(candidate IPs, which can reveal LAN/NAT topology or even public IP if not using
`iceTransportPolicy:'relay'`) and the DTLS certificate fingerprint to the relay operator
unconditionally, regardless of the "fixed" encrypted channel running in parallel. It does **not**
by itself grant a full MITM (the initiator's offer, which also needs its own fingerprint disclosed,
remains properly PSK/shared-secret-encrypted in all paths), but it is a direct, live violation of
the security property C-1's fix claims to deliver ("the relay never sees SDP in the clear"), and it
is architecturally sloppy in a way that increases the chance of a *future* regression (a later
change that also uses the leaked answer SDP for something, or a change to `_pcConfig()` that starts
including real public IPs, would immediately upgrade this from "metadata leak" to "exploitable").

**Impact:** Confidentiality leak of SDP metadata to the relay on every reconnect (native) and every
pairing (both clients); undermines the explicit "relay never sees SDP" design goal; asymmetric bug
between clients (web already has the correct fix, native does not) suggests this was simply missed
during the C-1 patch rather than being a considered trade-off.

**Severity:** High (confidentiality leak to an already-identified adversary, direct contradiction of
a stated and load-bearing security design goal; not by itself sufficient for full MITM given current
`_pcConfig()`).

**Root cause:** Incomplete propagation of a fix — the web client's author already built the correct
primitive (`createAnswerDirect`) specifically to solve this, but the native reconnect call site and
both clients' pairing call sites were never switched over to it.

**Proposed fix:** Replace `rtc.createAnswer(...)` with `rtc.createAnswerDirect(...)` at
`App.tsx:695` (mirroring the already-fixed web reconnect path), and additionally at `App.tsx:2920`
and `web/src/App.tsx:572` for the initial-pairing flow — the actual relay registration needed for
pairing is already handled explicitly by the surrounding `ConnectScreen`/`sendSignalAnswer` code
using the *real*, known-in-advance `token` from the QR code, so `createAnswer()`'s internal
self-registration with a random, unused token is pure dead weight that should be removed from
`createAnswer()` entirely (or `createAnswer()` itself should be deleted in favor of always using
`createAnswerDirect()` plus explicit, caller-controlled relay registration where actually needed).

### N-2. (Medium) Weak, non-cryptographic hash fallback in phone-connect rendezvous hash and PSK derivation

**Files/functions:** `App.tsx` `hashPhone()` (~2575-2592) and `derivePhonePSK()` (~2603-2621).

**The problem:** Both functions call `NativeModules.KyberModule.sha256(input)` for a real
SHA-256, but **both** have an identical fallback if that native method is unavailable:
```js
let hash = 0;
for (let i = 0; i < input.length; i++) {
  hash = ((hash << 5) - hash) + input.charCodeAt(i);
  hash = hash & hash;
}
return Math.abs(hash).toString(16).padStart(64, '0');
```
This is a classic 32-bit non-cryptographic string hash (same construction as Java's/JS's common
`String.hashCode()`), not a cryptographic hash: it has only ~2^31 possible outputs (vs. SHA-256's
2^256), is trivially invertible/collision-prone, and is deterministic per-platform with no secret
key. If this fallback ever triggers (module registration failure, a build variant without the
native module, timing race before native modules are ready, etc.), **both** the phone-lookup
rendezvous hash *and* — more seriously — the SDP-encryption PSK for the phone-connect feature
silently collapse to this weak construction, with no error, warning, or user-visible indication
that the "zero-knowledge" phone-connect flow is no longer even nominally protected by SHA-256.

**Attack path:** An attacker who can make/observe this fallback occur (or who simply notices the
64-hex-char output has far less entropy than real SHA-256 would produce, e.g. by checking that the
same short numeric input always maps to the same low-entropy pattern) can brute-force or directly
recompute the PSK offline in a trivial search space, fully defeating the C-2 fix for that session.

**Severity:** Medium (requires the fallback path to trigger, which should be rare, but the app has
no detection/telemetry for when it does, and the fallback silently downgrades a security-critical
KDF instead of failing closed).

**Root cause:** Defensive fallback code written for availability, without considering that a
"fallback hash" for a security-relevant derivation must either be equally strong or must fail
closed (refuse the phone-connect feature) rather than silently proceed with weak material.

**Proposed fix:** Remove the fallback entirely and fail closed (surface an error, refuse to start
phone-connect) if `KyberModule.sha256` is unavailable, exactly as `web/src/lib/Storage.ts`'s
`setupEncryption()` already does for its own dependency ("ohne Pepper vom Server gibt's keine
sinnvolle Absicherung, dann lieber gar nicht erst einrichten"). Apply the same "fail closed, not
degraded" philosophy here.

### N-3. (Medium, confirms/extends Review 1 M-4) C-4's encryption fix does not provide replay protection for system control packets

**Files/functions:** `MessageCrypto.js`/`.ts` (no sequence/timestamp field), `relay.js` `/packet`
(POST/GET, no dedup/freshness check), `App.tsx` system-packet handling
(`checkIncoming`, lines ~591-614).

**The problem:** The task specifically asked to re-examine whether C-4's fix (encrypting
`delete_chat`/`secret_start`/`secret_end` before sending) is sufficient on its own. It is not:
AEAD (all three layers) guarantees *authenticity and integrity of a given ciphertext*, but says
nothing about *freshness*. Nothing in the plaintext JSON (`{type:'system', subtype:'delete_chat'}`
etc.) carries a nonce, counter, or timestamp that the receiver checks against previously-seen
values. An attacker who can observe relay traffic even once (the same "malicious/compromised relay"
threat actor this whole review targets) can capture a **legitimately encrypted** `delete_chat` or
`secret_end` blob and **replay** it later — `POST /packet` with the identical `payload` and
`recipient` — and, because the shared secret is never rotated/ratcheted (Finding: no forward
secrecy, H-1 confirmed below), the replayed ciphertext will decrypt successfully and be acted on as
if freshly sent, at any point in the future until the two parties fully re-pair.

**Attack path:** 1) Attacker (relay operator, or anyone with relay access) observes one legitimate
`delete_chat`/`secret_end` ciphertext for a target contact pair (these are sent routinely — e.g.
whenever either party actually deletes a chat). 2) At any later time, attacker re-POSTs the exact
same ciphertext to `/packet`. 3) Victim's client decrypts it successfully (same never-rotated
shared secret), and — because there is no dedup/freshness check — processes it again: chat deleted
a second time, or (with a captured `secret_end`) a Secret Chat forcibly and repeatedly terminated,
purely from a replay with zero cryptographic break required.

**Impact:** Repeatable, unauthenticated-in-effect data destruction/state manipulation, despite the
C-4 encryption fix — narrower than the original C-4 (needs a previously-observed legitimate
ciphertext, not an arbitrary forgery) but still a live availability/integrity gap against the
documented relay-operator threat actor.

**Severity:** Medium (requires the attacker to have previously observed relay traffic for the
target pair — a real but somewhat narrower precondition than C-4's original "anyone who knows
contact.id" — but the attack itself needs zero cryptographic work once that precondition is met).

**Root cause:** AEAD confidentiality/integrity was (correctly) added by C-4 without also adding the
orthogonal property of freshness — a common and easy gap to miss when "encrypt it" is treated as a
complete fix for "attacker can send it."

**Proposed fix:** Include a strictly-increasing per-chat sequence number or a timestamp inside the
*encrypted* plaintext of every system/control packet (and ideally every message), and have the
receiver track and reject any value at or below the last-seen sequence number/timestamp for that
`chatId`. This only requires data already available client-side (a persisted last-seen counter per
contact) — no new cryptographic primitive needed.

### N-4. (Informational/Medium, re-confirms Review 1's second-pass note) Kyber exchange is unauthenticated; "fresh key per session" is not the same as identity assurance

Confirmed by reading `WebRTCManager.js`/`.ts` `_setupDataChannel()` in full: nothing signs or binds
the `kyber_pubkey`/`kyber_ciphertext` DataChannel messages to any persistent identity key (there is
no persistent identity key in this system at all — see Part 1 §2). The only user-facing check is
the optional, manually-triggered Safety Code comparison (native only — see N-6). This means: a
successful MITM at *any* point (pairing, phone-connect, or exploiting N-1's residual leak, or a
compromised relay generally) is **completely undetectable** unless the user manually compares
Safety Codes out-of-band, which nothing in the product prompts them to do, especially not silently
on background auto-reconnects (exactly where this matters most). This is Review 1's own
second-pass observation, re-confirmed unchanged, and is the root cause tying together N-1, C-1, C-2,
and the "no forward secrecy" finding (H-1) into one coherent picture: **the system has no source of
cryptographic identity assurance at all** — everything rests on (a) an out-of-band PSK at first
contact, and (b) the relay/network never having MITM'd that first contact or any subsequent
reconnect, with no way to detect or recover from a violation of (b) after the fact.

### N-5. (Medium) Missing purpose/domain separation between message encryption and its reuse for reconnect/call-signal/system-packet encryption

**Files/functions:** `MessageCrypto.js`/`.ts` `deriveKeys()`/`encryptMsg()`/`decryptMsg()`, called
identically from: chat-message send/receive, `App.tsx`/`web/src/App.tsx` reconnect offer/answer
encryption (C-1 fix), phone-connect offer/answer encryption (C-2 fix), `CallManager.js` call-signal
payload encryption, and the C-4-fixed system control packets — **all six use cases derive and use
the exact same three per-layer keys** (`k1`/`k2`/`k3`) whenever they share the same underlying
`sharedSecret`, because the HKDF `info` labels (`malachi-layer1-aes256gcm` etc.) are scoped to the
*cipher layer*, not the *purpose* of the call.

**The problem:** the task specifically asked whether C-1's fix (reusing the message-encryption
shared secret to also encrypt reconnect signaling) is a safe reuse or a domain-separation violation.
The answer: it is **not currently exploitable for key recovery** (AEAD keys don't weaken from being
used for structurally different plaintexts, and nonces are always fresh-random — no reuse found
anywhere per Part 1 §7's audit), but it **is** a real domain-separation violation in the classical
sense: there is nothing in the derived keys, the AEAD associated data, or the plaintext that
cryptographically binds a given ciphertext to *which* of the six protocols it was produced for.
Concretely, `decryptMsg()` + `JSON.parse()` is the *only* thing that decides how a successfully
decrypted blob gets interpreted downstream — purely based on the resulting JSON's `type`/`subtype`
fields, chosen entirely by whichever code path constructed the plaintext. This creates a latent
cross-protocol confusion risk: any code path that can be induced to `encryptMsg()` attacker-influenced
JSON under a given shared secret (e.g., a chat message whose text content, if it were ever
reflected back through a bug elsewhere, could be shaped to parse as
`{"type":"system","subtype":"delete_chat"}`) produces a ciphertext indistinguishable, at the crypto
layer, from a "real" system packet encrypted for a completely different purpose — because there is
no protocol/purpose tag inside the AEAD associated data and no separate sub-key per purpose.

**Impact:** Currently latent (no concrete injection path into `encryptMsg`'s plaintext argument was
found that an external attacker fully controls end-to-end in this review), but this is exactly the
kind of gap that turns into a real vulnerability the next time a new feature is added that also
calls `encryptMsg()` with even partially attacker-influenced content — there is no structural
guard against it today.

**Severity:** Medium (defense-in-depth gap / latent risk, not a demonstrated exploit today).

**Root cause:** `encryptMsg`/`decryptMsg` were designed as a single general-purpose "encrypt this
JSON blob under the shared secret" primitive and then organically reused for six different
protocols as they were added, without ever introducing a purpose tag.

**Proposed fix (using only established primitives already in the codebase — no new crypto):**
Use HKDF's `info` parameter (already in use for per-layer separation) to *also* mix in a
purpose label, i.e. derive `k1/k2/k3` from `sharedSecret` **and** a `purpose` string
(`"message"`, `"reconnect"`, `"call-signal"`, `"system-packet"`, `"phone-connect"`) so that
`deriveKeys(sharedSecret, purpose)` yields cryptographically independent keys per purpose from the
same root secret — this is exactly what HKDF's `info` field is designed for and requires no new
primitive, just widening the existing labels (e.g. `malachi-layer1-aes256gcm-reconnect` instead of
`malachi-layer1-aes256gcm`) and threading a `purpose` argument through every call site. Alternatively
(cheaper, still using only AEAD's existing `associatedData`/AAD support in `@noble/ciphers`), bind
the purpose string as AAD on all three layers so a ciphertext produced for one purpose fails
authentication if decrypted expecting another.

### N-6. (Low/Medium) Web client never surfaces the Safety Code UI at all

**Files/functions:** `web/src/lib/WebRTCManager.ts` `_computeSafetyCode()` computes the value and
stores it on `this.safetyCode`, but a full-text search of `web/src/App.tsx` (the only UI file for
the web client) finds **zero** references to `safetyCode`/`Sicherheitscode` being rendered anywhere
— contrast with native's `App.tsx`, which has a dedicated "🛡 Sicherheitscode" shield-button UI in
`ChatScreen` (lines ~1242-1250, 2063-2069, 2233).

**Impact:** Web users have no way at all to perform the one manual verification step (comparing
Safety Codes out-of-band) that could catch a MITM'd Kyber exchange (N-4), even though the exact same
underlying data (`rtc.safetyCode`) is already being computed and is available. This makes the
already-weak "no identity assurance" situation (N-4) strictly worse on web than on native.

**Severity:** Low/Medium (missing defense-in-depth UI, not a crypto bug per se, but directly
relevant to the product's implicit security claims since native already has this feature).

**Proposed fix:** Surface `rtc.safetyCode` in the web chat UI the same way native does (e.g. a
shield icon opening a modal showing the grouped digits), ideally with a prompt to verify it at
least once per new pairing.

### N-7. (Low) No post-compromise re-trust / key-change detection

Confirmed by reading `RTCStore.js`/`App.tsx`/`web/src/App.tsx`: each `contact.id` maps to exactly
one slot for `sharedSecrets`, silently overwritten whenever a new Kyber exchange completes for that
`contact.id` (e.g., after a full re-pair). There is no "this contact's key material changed since
last session — re-verify?" prompt analogous to Signal's safety-number-change warning. Combined with
N-4 (no exchange authentication) and H-1 (no forward secrecy/ratchet), this means: once a MITM
occurs and is not caught by manual Safety Code comparison, there is no mechanism — automatic or
even user-initiated beyond a full app wipe/re-pair — to detect or recover trust afterward. This is
an architectural gap rather than a single-line bug; flagged as Low severity because it requires a
prior successful compromise (N-1/N-4/C-1/C-2) to matter, but it's the reason such a compromise, once
achieved, is durable indefinitely.

**Proposed fix:** This is exactly the class of problem a **Double Ratchet / Signal-protocol-style
construction** is designed to solve (per-message forward secrecy plus a well-defined re-keying and
safety-number-change notification model) — do not hand-roll a partial version of this; if the
product wants real post-compromise security, adopt (or bind to) an established, audited
implementation of the Double Ratchet (e.g., via `libsignal`) rather than extending the current
single-static-secret model piecemeal.

---

### Re-confirmed findings from Review 1 (status after reading current code)

| ID | Finding | Status |
|----|---------|--------|
| C-1 | Reconnect SDP sent unencrypted | **Fixed**, but see N-1 (incomplete — residual plaintext leak via `createAnswer()`) |
| C-2 | Phone-connect has no shared secret | **Fixed** (separate PSK via `derivePhonePSK`, correct domain separation from rendezvous hash) — but see N-2 (weak fallback hash) |
| C-3 | Pepper bypass / offline brute force | **Fixed** (mandatory attemptToken + rotation on success), residual risk explicitly and correctly documented in-code (needs real PAKE/OPRF for full closure) |
| C-4 | Unauthenticated system packets | **Fixed** (now encrypted, only trusted post-decryption) — but see N-3 (no replay protection, so the fix is necessary but not sufficient) |
| H-1 | No forward secrecy, static persisted shared secret | **Still open, unchanged.** Confirmed: `WebRTCManager` persists `sharedSecret` to `EncryptedStorage`/`localStorage` indefinitely, no ratchet anywhere (Part 1 §9). |
| H-2 | Fail-open plaintext call signaling | **Still open, unchanged.** Confirmed at `CallManager.js:406-419` — `_sendSignal()` still falls back to `sendCallSignal(...)` **without encryption** and **without blocking the call** when no shared secret is cached, with only a `console.warn`. This was listed as High in Review 1 and was not addressed by any of the fixes described for this review. |
| H-3 | No relay size/rate limiting on well-formed traffic | Not in scope for this crypto-focused pass; not re-verified here. |
| H-4 | Unbounded `msg.total` chunk allocation | Not in scope for this crypto-focused pass; not re-verified here. |
| M-1 | Native PIN is UI-gate only, not cryptographically bound to storage | **Still open, unchanged.** Confirmed: `LockScreen` does direct string comparison (`next === savedPin`), never participates in deriving any storage-protection key. |
| M-2 | Relay routing IDs double as bearer tokens | Structural note, unchanged; underlying instances addressed per-endpoint by C-1–C-4 fixes as before. |
| M-3 | TLS opt-in, silent HTTP fallback | Confirmed unchanged at `relay.js:63-64,703-718` — still warns and falls back to plaintext HTTP rather than refusing to start. |
| M-4 | No replay protection on relayed packets | **Confirmed still open**, and specifically demonstrated against the now-encrypted C-4 packets — see N-3 for the detailed, updated attack path. |

---

## Part 3 — Claims vs. actual delivered security properties

| Claim (from code comments, commit history, `ENCRYPTION_STATUS`, or UI strings) | Verdict | Basis |
|---|---|---|
| "Post-quantum" key exchange (ML-KEM-768 / FIPS 203) | **True, verified** | `KyberModule.kt` uses `org.bouncycastle.pqc.crypto.mlkem` (final-standard BouncyCastle ≥1.80); web uses `@noble/post-quantum`'s `ml_kem768`; both target the same NIST FIPS 203 final parameter set and are asserted byte-compatible in code comments consistent with the described prior end-to-end fix/testing. `ENCRYPTION_STATUS` in both `HybridCrypto.js` and `.ts` was corrected (per its own comment) to stop claiming a nonexistent "X25519/ECDH-384" hybrid — now accurately states Kyber/ML-KEM-768 only. **Accurate as currently stated.** |
| Triple-layer "defense in depth" (AES-256-GCM → ChaCha20-Poly1305 → XSalsa20-Poly1305) | **Real algorithms, correctly implemented (standard HKDF, fresh nonces)** — but **overstated as a practical security margin**: all three layers derive from one single Kyber shared secret with no independent entropy source per layer, so recovering that one secret (e.g. via N-1's leak, N-4's lack of authentication, or H-1's persistence) breaks all three simultaneously. Genuinely helps only against a hypothetical future cryptanalytic break of one specific cipher, not against the realistic threats this review and Review 1 identify (MITM, key exfiltration, replay). |
| "Zero-knowledge" phone-number matching ("gegenseitiges Matching") | **Overstated**, and the C-2 fix's own in-code comment already says so honestly: it protects only against a passive observer who doesn't know both numbers, not against the relay operator's ability to observe the (correctly non-secret) rendezvous hash, nor against anyone who already knows both numbers. Additionally weakened further by N-2 (weak-hash fallback can silently degrade the PSK itself, not just the rendezvous hash). |
| "Ende-zu-Ende verschlüsselt" for calls | **Conditionally true, not unconditionally true.** True whenever a shared secret is already cached at call time; **false** (plaintext SDP/ICE signaling) in the fallback path that H-2 shows is still fail-open, contrary to the code comment directly above it explaining exactly why that's dangerous. |
| Implicit "fresh Kyber keypair per session ⇒ forward secrecy" impression (from the ephemeral-key generation pattern) | **False in practice.** The *keypair* is ephemeral, but the resulting *shared secret* is persisted to disk indefinitely and reused for the entire session/reconnect lifetime with no ratchet (H-1, confirmed unchanged) — so device/storage compromise exposes all traffic under the currently-active secret, and there is no path to post-compromise recovery (N-7) short of a full re-pair. |
| "Sichere Zufallszahlen via KyberModule (SecureRandom)" (MessageCrypto.js header comment) | **True for all cryptographic key/nonce material** — verified `SecureRandom` (native) / `crypto.getRandomValues` (web) used consistently for every key, nonce, and Kyber operation checked. **Not true for all identifiers**: several session/routing tokens (`WebRTCManager.js:156`'s `sessionToken`, `App.tsx`'s reconnect `sessionId`/`dynamicAnswerKey` suffixes, phone-connect `myId`) use `Math.random()`, a non-cryptographic PRNG, instead of a CSPRNG. These don't gate confidentiality directly (the payloads they route to remain separately encrypted), but using a non-CSPRNG for anything that indexes secret-adjacent relay storage is inconsistent with the stated design intent and worth tightening for consistency. |
| Relay "Kein Account, keine Metadaten, keine Logs" / ephemeral-only storage | **Accurate for the relay's own design** (in-memory `Map`, TTL-based auto-expiry, no disk persistence, no request logging observed) — but this claim is about the relay's *storage* hygiene, not about what it can *see in transit*, which is exactly what N-1 and the (now largely fixed) C-1–C-4 findings are about. No contradiction, just worth noting the claim's scope is narrower than "the relay can't learn anything." |

---

*End of report. All findings above were derived from reading the current repository state; no code
was modified as part of this review.*
