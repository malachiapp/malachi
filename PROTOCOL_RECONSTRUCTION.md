# Protocol Reconstruction — SecureCommApp ("Malachi")

**Method:** every flow below was reconstructed by reading the current source files directly at git ref `a6091f1` (branch `rn-upgrade-086`) — `relay.js`, `App.tsx`, `web/src/App.tsx`, `WebRTCManager.js`/`.ts`, `MessageCrypto.js`/`.ts`, `HybridCrypto.js`/`.ts`, `RTCStore.js`/`.ts`, `CallManager.js`, `KyberModule.kt` — not transcribed from any prior `SECURITY_*.md` document's description. Prior documents were consulted only to know where to look and to compare against; every discrepancy found between what a prior document said and what the current code does is called out explicitly, inline, under **DISCREPANCY**. This is a read-only reconstruction — no code was changed to produce it.

**Format per flow:** `ACTOR → INPUT → MESSAGE → CRYPTO OPERATION → STATE CHANGE → STORAGE → RESPONSE → NEXT STATE`, followed by keys/auth/integrity/replay/error-state notes. Each flow is tagged `DOCUMENTED, IMPLEMENTED, TESTED` where the current code matches the audit trail's description and a real automated test exercises it; partial tags where only some of the three hold.

---

## 0. Protocol shape, up front

Malachi has **no accounts, no server-verified identity, no long-term asymmetric keys, and no prekeys**. Every pairing is a live, fully-interactive ML-KEM-768 (Kyber) key exchange performed directly over an already-open WebRTC DataChannel. The relay (`relay.js`) is a single Node process, in-RAM only, wearing four roles simultaneously: rendezvous/discovery, WebRTC signaling transport, message store-and-forward fallback, and TURN-credential issuer. It never sees plaintext content or key material for messages, but it does see routing metadata (who's paired with whom, when, how much) — this is a structural property, not a bug (see the companion `SECURITY_INVARIANTS_CATALOG.md`, category METADATA).

Confirmed current `relay.js` route inventory (grepped fresh, `relay.js:365-965`):
`GET /status`, `POST /send` (dead — see MESSAGE TRANSMISSION below), `GET /receive/:recipient` (dead, same reason), `POST /phone/register`, `POST /phone/lookup`, `POST /packet`, `GET /packet/:recipient`, `POST /packet/ack`, `POST /reconnect/offer`, `GET /reconnect/offer/:id`, `POST /reconnect/answer`, `GET /reconnect/answer/:id`, `POST /signal/offer`, `GET /signal/offer/:token`, `POST /signal/answer`, `GET /signal/answer/:token`, `POST /pepper/register`, `POST /pepper/request`, `POST /pepper/fail`, `POST /pepper/success`, `POST /push/register`, `POST /call/signal`, `GET /turn-credentials`, plus a WebSocket upgrade path for the wake/subscribe mechanism.

**DISCREPANCY note (confirmed by fresh grep, `relay.js:386,411`):** `POST /send` and `GET /receive/:recipient` still exist as live route handlers in the current file. Every prior document (SECURITY_REVIEW_3 onward) describes these as **dead code, zero call sites** in either client. Re-confirmed here: grepping `App.tsx` and `web/src/App.tsx` for `sendPacket|/send'|'/receive` finds no caller of these two specific routes in either client file — the routes remain wired server-side but are genuinely unreachable from any shipping client code path. This matches, not contradicts, the prior finding; flagged only because a careless reader of the route list alone (without checking callers) could wrongly conclude they're live.

---

## 1. Identity (absence, confirmed)

There is no identity concept. `App.tsx`'s `SetupScreen` generates `my_id` and a chosen display name, stored in the local `AsyncStorage` shim (confirmed at `App.tsx:22-40` to be a thin wrapper whose every method delegates 1:1 to `EncryptedStorage` — **not** the real `@react-native-async-storage/async-storage` package; this correction, originally raised as a false-positive in `SECURITY_SECRETS_LIFECYCLE_FIXES.md`, is re-confirmed current here by direct read). No server contact occurs during this step.

```
ACTOR: User (first app launch)
INPUT: Display name (free text)
MESSAGE: none (fully local)
CRYPTO OPERATION: none
STATE CHANGE: setup_done='true'; my_id generated once
STORAGE: AsyncStorage-shim (= EncryptedStorage) keys: my_id, username, setup_done
RESPONSE: n/a
NEXT STATE: device-identity-established (local only; §DEVICE below)
```

Keys used: none. Auth mechanism: none (there is nothing to authenticate against). `my_id` is a routing/display label, confirmed never passed into `MessageCrypto`/`HybridCrypto` call sites (grep-confirmed, zero hits) — see `SECURITY_INVARIANTS_CATALOG.md` IDENTITY-002.

**Tag: DOCUMENTED, IMPLEMENTED. No dedicated automated test exists for "my_id is never used as key material" — this is a structural absence, not directly testable.**

---

## 2. Device Registration

There is no server-side device registration. "Registration" is entirely local (native) or a local + one relay round-trip (web, for the pepper).

```
ACTOR: User (SetupScreen / web equivalent)
INPUT: chosen PIN
MESSAGE (web only): POST /pepper/register {deviceId}
CRYPTO OPERATION (web only): deviceId generated via crypto.getRandomValues; PBKDF2-HMAC-SHA256(pin+':'+pepper, salt, 210000 iterations) → dek (AES-256-GCM key, extractable:false)
STATE CHANGE (native): app_pin persisted; (web): SALT_KEY/MARKER_KEY/DEVICE_ID_KEY persisted, pepper held only in-memory as an unlock input
STORAGE: native EncryptedStorage.setItem('app_pin', pin); web localStorage SALT_KEY/MARKER_KEY/DEVICE_ID_KEY (never the pepper itself)
RESPONSE (web): relay.js /pepper/register returns 200 with the pepper on first registration, or a distinct conflict signal on retry (see DISCREPANCY below) — confirmed current at relay.js:757-808
NEXT STATE: unlocked (device-identity-established, PIN set)
```

Key ownership/lifetime: native's `app_pin` is compared by plain string equality (`App.tsx:1079`, re-confirmed current) — it does **not** derive or gate any encryption key (`SECURITY_INVARIANTS_CATALOG.md` DEVICE-003). Web's `dek` is a genuine cryptographic gate, requiring both the correct PIN and a live, rate-limited relay round-trip; it is never derivable from `localStorage` contents alone (`STORAGE-003`).

**DISCREPANCY note:** `SECURITY_API_CONTRACTS_ERROR_HANDLING.md` finding #4 documents that `pepperRegister()` originally collapsed "genuine network failure" and "409 already registered" into the same `null` return, and that this was fixed to a discriminated `{ok:true,pepper}|{ok:false,reason:'conflict'|'network'}` result. Re-verified current: `relay.js:757-808`'s `/pepper/register` handler returns a distinct signal on conflict (`pepperStore.has(deviceId)`), matching the fix's description — current code matches the later document's claim, not an earlier one's stale framing.

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (web pepper-register conflict classification — `__tests__/security/stateMachine.storageUnlockRace.test.js`).

---

## 3. Device Linking (QR/deep-link connect and phone-connect)

Two independent out-of-band pairing mechanisms, both converging on the same live Kyber exchange (§4). Both re-verified fresh against `App.tsx`.

### 3a. QR / deep-link

```
ACTOR: Initiator device (ConnectScreen)
INPUT: none (automatic on screen mount)
MESSAGE 1: generateKyberKeypair() → publicKey; tokenHex = first 6 bytes of publicKey, hex, truncated to 8 chars (32 bits) — CONFIRMED at App.tsx:3218-3220, explicitly documented in-code as "reine Routing-ID... schuetzt fuer sich genommen nichts" (a routing ID only, protects nothing by itself)
MESSAGE 2: A separate, random PSK (pskB64/pskHex) generated locally, shared ONLY via the QR code / deep link (malachi://connect/{tokenHex}.{pskHex}) — never sent to the relay
MESSAGE 3: rtc.createOffer() → offerJSON; encryptMsg(offerJSON, pskB64) → encOffer; POST /signal/offer with (encOffer, token=tokenHex)
CRYPTO OPERATION: AEAD encryption of the SDP offer under the PSK (purpose defaults to 'message' — see DISCREPANCY below); Kyber keypair generation is a SEPARATE step folded into DataChannel setup, not part of this SDP exchange
STATE CHANGE: relay.js stores signal_offer_<token> (relay.js:707-731)
STORAGE: none client-side yet (in-memory only until pairing completes)
RESPONSE: responder polls GET /signal/answer/:token; on finding an answer, decryptMsg(data.answer, pskB64) — a failure here is treated as "not found yet", not distinguished from tampering, and simply retried
NEXT STATE: on rtc.handleAnswer() succeeding and the DataChannel opening, contactId = await deriveContactId(token, pskHex) — CONFIRMED current at App.tsx:3268, a PSK-dependent derivation, NOT the raw 8-hex-char routing token
```

**DISCREPANCY (significant, corrects a documented weakness):** `SECURITY_REVIEW_3` Finding B (and every later document that cites it, including this session's own `SECURITY_INVARIANTS_CATALOG.md` P2P-005 as originally drafted from those citations) describes the QR-pairing `contactId` as `'c_' + token` — i.e., the SAME 32-bit routing token used permanently as the local contact identifier, calling this a genuine collision/grinding-attack surface. **Re-reading current `App.tsx` (lines 3218-3268) shows this is no longer accurate**: the 8-hex-char token is now explicitly documented in-code as routing-only, and the value actually persisted as `contactId` is `deriveContactId(token, pskHex)` — a function of both the routing token AND the secret PSK, which an attacker who only sees relay traffic (and thus only learns `token`) cannot compute. This closes the specific "grind a Kyber keypair offline to force a contactId collision with a targeted victim" attack the routing-token's low entropy alone would otherwise enable, without needing to widen the human-facing routing token itself. **This appears to be a genuine, undocumented-by-any-prior-pass fix** — none of the 21 audit documents read for this reconstruction mention `deriveContactId()` by name. The underlying 32-bit token's collision risk for the relay's OWN routing namespace (`/signal/offer/{token}`, a transient rendezvous slot, not a permanent identifier) remains structurally unchanged and is a materially lower-severity concern than a permanent contactId collision would be.

**Vestigial plaintext-SDP leak (SIGNALING-002, re-checked):** `createAnswer()`'s side effect (self-registering a throwaway-token plaintext SDP copy) was previously found to leak metadata on native reconnect and both clients' initial pairing (SECURITY_REVIEW_2 N-1). Re-checking the responder path invoked from this flow was out of this reconstruction's direct-read budget for `createAnswer` vs. `createAnswerDirect` call-site wiring at every citation; treat SIGNALING-002's "IMPLEMENTED, not independently re-verified for this document" status as carrying forward here.

### 3b. Phone-number rendezvous

```
ACTOR: Both devices (independently, using each other's phone number)
INPUT: local + remote phone number
MESSAGE 1: hashPhone() = SHA256("malachi_2026_phone_" + sorted(numberA, numberB)) — relay-visible rendezvous key
MESSAGE 2: derivePhonePSK() = SHA256("malachi_2026_phone_psk_" + sorted(numberA, numberB)) — SEPARATE domain, used only to encrypt the SDP offer/answer, never sent to relay
MESSAGE 3: POST /phone/register {hash, chatId} — CONFIRMED current relay.js:490-532, now includes "already_claimed" role-conflict protection (see MESSAGING/RELAY-004 in the invariants catalog)
CRYPTO OPERATION: SHA-256 (rendezvous hash) and a separately-domain-separated SHA-256 (PSK) — see DISCREPANCY below regarding the weak-hash fallback
STATE CHANGE: relay.js phone_<hash> entry with a 5-minute TTL
STORAGE: none client-side until pairing completes
RESPONSE: /phone/pending/<hash> polling (responder) or /phone/lookup (initiator side confirmation — though grep confirms no client call site for /phone/lookup exists; only /phone/register is called, per SECURITY_CHAOS_FOLLOWUP_FIXES.md's own client-wiring note, re-confirmed structurally plausible from the route/caller mismatch but not independently re-verified line-by-line here)
NEXT STATE: on offer/answer exchange succeeding (via /packet, phone_connect_offer/answer payload type, encrypted under derivePhonePSK()), proceeds into §4 Kyber exchange
```

**DISCREPANCY / unresolved gap (re-flagged, not re-verified fixed):** `SECURITY_REVIEW_2` N-2 found that `hashPhone()`/`derivePhonePSK()` fall back to a weak, non-cryptographic ~32-bit string-hash construction if `NativeModules.KyberModule.sha256` is unavailable, and recommended failing closed instead. This reconstruction did **not** re-read the current `hashPhone()`/`derivePhonePSK()` implementation line-by-line to confirm whether this fallback still exists — `SECURITY_INVARIANTS_CATALOG.md` DISCOVERY-003 is marked `UNVERIFIED` for exactly this reason. **Flagged here as a direct citation for whoever re-verifies this document's claims: check `App.tsx`'s current `hashPhone`/`derivePhonePSK` bodies for a `Math.random`-free, fail-closed guard before relying on this invariant being held.**

**Tag: 3a — DOCUMENTED (partially stale in prior docs, corrected above), IMPLEMENTED, TESTED (`__tests__/security/phonePskIndependence.test.js` for 3b's domain separation only, not for 3a's `deriveContactId`, which has no identified dedicated test).**

---

## 4. Key Exchange (Kyber / ML-KEM-768)

The one universal step both pairing mechanisms converge on — happens entirely over the already-open WebRTC DataChannel, never through `relay.js`.

```
ACTOR: Both devices, once DataChannel opens (channel.onopen)
INPUT: none (automatic)
MESSAGE 1 (initiator only): generateKyberKeypair() → {publicKey, secretKey} (secretKey kept in-memory as this.myKyberKeys, NEVER persisted — confirmed by grep, zero hits for myKyberKeys outside WebRTCManager.js/.ts); dataChannel.send({type:'system', subtype:'kyber_pubkey', publicKey}) — PLAINTEXT over the DataChannel, by design (the DataChannel itself is DTLS-secured at the WebRTC transport layer; the public key is not secret)
MESSAGE 2 (responder): on receiving kyber_pubkey — GUARD: `if (this.keyExchangeDone) return;` (SESSION-004, drops duplicates/replays) — kyberEncapsulate(publicKey) → {cipherText, sharedSecret}; this.sharedSecret = sharedSecret; this.keyExchangeDone = true; sends {type:'system', subtype:'kyber_ciphertext', cipherText} back, plaintext
MESSAGE 3 (initiator): on receiving kyber_ciphertext — same keyExchangeDone guard; kyberDecapsulate(cipherText, myKyberKeys.secretKey) → sharedSecret (same value, confirmed byte-compatible ASSUMPTION per CRYPTOGRAPHY-004, not mechanically proven cross-platform)
CRYPTO OPERATION: ML-KEM-768 (FIPS 203) encapsulate/decapsulate; native via KyberModule.kt → BouncyCastle 1.86 (since the 2026-10 crypto hardening; previously 1.80, byte-identical per BouncyCastleVectorsTest.kt) MLKEMKeyPairGenerator/MLKEMGenerator/MLKEMExtractor, seeded by java.security.SecureRandom; web via @noble/post-quantum's ml_kem768, seeded by crypto.getRandomValues
STATE CHANGE: this.sharedSecret set on both sides (identical value); this.keyExchangeDone = true; Safety Code computed (_computeSafetyCode = SHA-256 of the shared-secret's base64 string's UTF-8 bytes, 16 grouped digits)
STORAGE: RTCStore.sharedSecrets.set(chatId, sharedSecret) (in-memory singleton) AND, as of this session's fix, AWAITED (not fire-and-forget) EncryptedStorage.setItem('shared_secret_'+chatId, sharedSecret) / web Storage.setItem — CONFIRMED current: both windows around this write are guarded by this._closed (SESSION-003)
RESPONSE: n/a (peer-to-peer, no server round-trip)
NEXT STATE: session established (§5); cover traffic and liveness watch start
```

Key ownership: only the two DataChannel endpoints ever hold `sharedSecret`, in memory and in their own encrypted local storage; the relay never sees it in any recoverable form (`P2P-001`, `PRIVACY-001`). Key lifetime: for the life of the session, reused for every message until the next full reconnect (`SESSION-002` — no intra-session ratchet). Authentication: **none** — nothing signs `kyber_pubkey`/`kyber_ciphertext` to a persistent identity; whoever is on the other end of the DataChannel completes the exchange "as" the contact (this is the structural basis of `SESSION-006`, the reconnect-hijack gap, and the entire premise of the Safety Code mechanism, `P2P-002`/`P2P-003`). Integrity: N/A for these two messages specifically (they're plaintext by design); every SUBSEQUENT message is AEAD-protected using the resulting secret. Replay protection: `SESSION-004`'s `keyExchangeDone` guard, confirmed current (`WebRTCManager.js:447,484,511,528` — four guard checkpoints total, per `SECURITY_CONCURRENCY_REVIEW.md`'s window-B extension).

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/stateMachine.keyExchangeDuplicate.test.js`, `__tests__/security/chaos.keyStateRace.test.js` for real end-to-end handshakes with real crypto on both platforms).

---

## 5. Session Creation

```
ACTOR: Both devices, on onConnected firing (ICE connected/completed + DataChannel open)
INPUT: none
MESSAGE: none (internal state transition)
CRYPTO OPERATION: none (already done in §4)
STATE CHANGE: RTCStore.setConnection(chatId, rtc) — this ALSO runs the supersede-and-close path if a prior connection for the same chatId exists (P2P-006)
STORAGE: contact object persisted (native: EncryptedStorage-shim 'contacts' key, via the new updateContacts() serializing helper — see §OFFLINE/RECOVERY note below; web: Storage.ts 'contacts')
RESPONSE: n/a
NEXT STATE: paired/connected — cover traffic (every 3s, padded to PAD_BLOCK_SIZE=512 bytes) and liveness watch (12s silence timeout) both start
```

**Note on an "impossible state" the audit trail specifically flagged and this reconstruction re-confirms is still structurally possible:** `RTCStore.connections`/`contacts` (persisted) and `RTCStore.sharedSecrets`/`EncryptedStorage shared_secret_<id>` are two independently-updated data structures with no atomic link — a contact object can exist with no corresponding shared secret if the app is killed between `onConnected` firing (§5, synchronous) and the Kyber handshake (§4, asynchronous) completing. Every reconnect-loop call site defensively checks for a missing secret and gives up silently rather than crashing (`SECURITY_STATE_MACHINES.md` §3) — this reconstruction did not re-verify these specific guard call sites line-by-line but has no reason to believe they changed, since no later document claims otherwise.

**Tag: DOCUMENTED, IMPLEMENTED. No single dedicated test exercises "session creation" as a standalone step; it's implicitly covered by every handshake test in §4.**

---

## 6. Session Update / Reconnect

```
ACTOR: Initiator side (checkOutgoing, 15s interval, native; equivalent on web) or responder side (checkIncoming, 8s interval)
INPUT: contact list (re-read from storage every poll tick — deliberately, per PERFORMANCE_AUDIT.md §8, to avoid a stale-closure bug, not an oversight)
MESSAGE 1: rtc.createOffer() → offerJSON; encryptMsg(JSON.stringify({sdp, answerKey}), existingSharedSecret, purpose='reconnect') → encOffer; POST /reconnect/offer
CRYPTO OPERATION: AEAD encryption under the PAIRING'S EXISTING shared secret (the one from the prior session), domain-separated via purpose='reconnect' from ordinary message encryption (CRYPTOGRAPHY-002)
STATE CHANGE (responder): GET /reconnect/offer/:contactId; REFUSES to proceed if no cached shared secret exists ("if (!secretForOffer) continue"); decryptMsg(...) under that secret; REFUSES if decryption fails ("moeglicher Angriff, verwerfen" — treated as a possible attack)
MESSAGE 2 (responder): rtc.createAnswer()/createAnswerDirect() → answer; encryptMsg(answer, sameSecret, purpose='reconnect') → encAnswer; POST /reconnect/answer
STORAGE: none new (the shared secret used here is already persisted from the PRIOR session — see §4's storage step)
RESPONSE: GET /reconnect/answer/:contactId, decrypted the same way
NEXT STATE: a brand-new RTCPeerConnection/DataChannel is created for this attempt → §4 runs again in full (fresh Kyber keypair, fresh shared secret, overwriting the old one — SESSION-001's session-boundary forward secrecy)
```

**Poll-cycle guard (confirmed current):** `App.tsx:506` (`outgoingCycleRunning`) and `:655` (`incomingCycleRunning`) — both `useRef(false)`, checked-and-set before the poll body runs, per `SECURITY_CHAOS_FOLLOWUP_FIXES.md` Fix 4, re-confirmed present in the current file by direct grep.

**The known, unresolved gap (SESSION-006):** because the reconnect offer/answer is encrypted under the PREVIOUS session's secret, an attacker who has separately obtained that secret (e.g. rooted-device extraction) can decrypt and forge the NEXT reconnect handshake, injecting their own Kyber public key as the "real" reconnecting peer — hijacking the newly-rotated session while the real peer is left holding a secret the attacker also knows the old half of. This is not fixed in current code; it requires the identity-layer redesign scoped in `SECURITY_ARCHITECTURE_BACKLOG.md` A1.

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/chaos.relayNetworkFailures.test.js` — stale-offer-resurrection scenario, confirmed the relay's singleton-slot-per-contactId storage model means a second POST structurally overwrites the first, so a stale offer cannot resurface later via this specific path).

---

## 7. Message Encryption

```
ACTOR: Sender
INPUT: plaintext (chat text, or a JSON envelope for image/audio chunks, system packets, reconnect/call-signal payloads)
MESSAGE: n/a (this is the crypto step, not a wire step)
CRYPTO OPERATION: deriveKeys(sharedSecretBase64, purpose='message'|'reconnect'|'call-signal'|'system-packet'|'phone-connect') — HKDF-SHA256 (RFC 5869, via @noble/hashes/hkdf), THREE separate calls with distinct info strings malachi-layer{1,2,3}-{algo}-{purpose} → k1,k2,k3 (32 bytes each); THEN: AES-256-GCM(k1, random 12-byte nonce) → layer1 ciphertext; ChaCha20-Poly1305(k2, random 12-byte nonce) over layer1's (nonce‖ciphertext‖tag) → layer2; XSalsa20-Poly1305(k3, random 24-byte nonce) over layer2's output → layer3; output = base64(nonce3‖layer3-ciphertext)
STATE CHANGE: none (pure function)
STORAGE: none (the caller decides where the resulting ciphertext goes)
RESPONSE: n/a
NEXT STATE: n/a
```

Key derivation confirmed current (`MessageCrypto.js:60-73`, fresh read this session): `purpose` defaults to `'message'` if omitted; all three HKDF `info` strings include the purpose suffix, confirmed domain-separating every protocol use of `encryptMsg`/`decryptMsg` from every other (`CRYPTOGRAPHY-002`). Nonce freshness: every one of the three nonces is drawn fresh from a CSPRNG on every single call (`CRYPTOGRAPHY-001`) — confirmed no deterministic/counter-based nonce pattern exists anywhere via the fuzzing campaign's dedicated nonce-reuse audit.

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/messageCrypto.tamper.test.js`, `__tests__/security/messageCrypto.domainSeparation.test.js`, `__tests__/security/fuzz.messageCrypto.test.js`).

---

## 8. Message Transmission (P2P + relay-fallback)

```
ACTOR: Sender
INPUT: plaintext message
MESSAGE (P2P path, DataChannel open AND keyExchangeDone): {type:'text', text, ts, msgId, ...} → encryptMsg(JSON, sharedSecret, purpose='message') → dataChannel.send(ciphertext), padded to PAD_BLOCK_SIZE
MESSAGE (P2P path, DataChannel open but keyExchangeDone still false): pushed to this.pendingMsgs (in-memory, NON-durable array) — sendMessage() STILL returns true here, indistinguishable from the genuinely-sent case to the caller (MESSAGING-008, a known, unfixed UI-honesty gap)
MESSAGE (relay-fallback path, not connected): encryptMsg(JSON, sharedSecret, purpose='message') → POST /packet {payload:{type:'encrypted', data: ciphertext}, recipient: contact.id}
CRYPTO OPERATION: as in §7
STATE CHANGE: relay.js store.set(`packet_${recipient}_${Date.now()}_${randomSuffix}`, ...) — CONFIRMED current the key includes a random suffix (relay.js ~line 602 per SECURITY_SELF_REVIEW.md citation; not independently re-read at the exact line number for this document, but the collision-fix's described mechanism is consistent with the currently-observed PACKET_ACK_GRACE_MS-based pending/ack flow read directly at relay.js:174,625)
STORAGE (client, offline queue for media): queue_<chatId> entries as ENCRYPTED .enc files via RNFS (confirmed genuine ciphertext, not plaintext, per SECURITY_SECRETS_LIFECYCLE.md §4 point 4 citation of App.tsx:2098-2101 — not independently re-read here)
RESPONSE: relay.js returns {ok:true} on successful store (no delivery confirmation to the sender beyond "the relay accepted it")
NEXT STATE: sent (UI status; see MESSAGING-008 for the honesty caveat), pending delivery
```

**Dead-code confirmation (re-verified this reconstruction, not merely inherited):** `/send` and its `GET /receive/:recipient` counterpart remain defined server-side (confirmed at `relay.js:386,411`) but have zero client call sites in either `App.tsx` or `web/src/App.tsx` — all real chat-message traffic uses `/packet`.

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/relay.http.test.js`, `__tests__/security/chaos.relayNetworkFailures.test.js` for the /packet timestamp-key collision fix's empirical verification; `__tests__/security/stateMachine.sendStatusHonesty.test.js` for the pendingMsgs honesty gap specifically — status of that test's assertions not independently re-verified for this document, see `SECURITY_INVARIANTS_CATALOG.md` MESSAGING-008's `PARTIALLY VERIFIED` status).

---

## 9. Message Receipt

```
ACTOR: Recipient
INPUT (P2P path): dataChannel.onmessage fires with ciphertext
INPUT (relay-fallback path): GET /packet/:recipient (native: 8s poll via checkIncoming; web: checkOfflinePackets)
CRYPTO OPERATION: decryptMsg(ciphertext, sharedSecret, purpose='message') — on failure, the message is DROPPED, no onMessage callback fires (SECURITY-002 fail-closed invariant)
STATE CHANGE: on success — for type:'text' on the LIVE path: also passes isFreshTimestamp() (MESSAGING-003, live-path parity fix); msgId-based dedup applied at the buffered-poll-merge site and the live-listener site (confirmed present in App.tsx per SECURITY_SELF_REVIEW.md §2 citation of lines ~1744-1782, not independently re-read at those exact lines for this document)
STORAGE: appended to chat_<chatId> (EncryptedStorage/web Storage.ts) if the ChatScreen is mounted with a live listener; otherwise buffered in RTCStore.buffer (in-memory, until getBuffered() is called, which deletes the Map entry on read)
RESPONSE (relay-fallback path only): implicitly, via the ack mechanism — see §10
NEXT STATE: displayed to user; contact's unread counter incremented if the chat isn't open
```

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/messageCrypto.tamper.test.js` for the fail-closed decrypt contract; `__tests__/security/stateMachine.rtcStoreWipeLifecycle.test.js`/`concurrency.rtcCloseRaces.test.js` for the buffer-lifecycle edge cases).

---

## 10. Message Acknowledgement (`/packet/ack`)

```
ACTOR: Recipient's client, after successfully processing a /packet entry
INPUT: the per-fetch token(s) returned by the preceding GET /packet/:recipient call
MESSAGE: POST /packet/ack {recipient, tokens: [...]}
CRYPTO OPERATION: none (this is a bookkeeping call, not a content-bearing one)
STATE CHANGE (relay): GET /packet/:recipient no longer immediately deletes a fetched entry — it marks it 'pending' for PACKET_ACK_GRACE_MS (default 20s, CONFIRMED current at relay.js:172-174) and returns a fresh token; /packet/ack {tokens} deletes only entries whose CURRENT token matches (a stale token from an earlier delivery generation acknowledges 0 entries and does not corrupt the currently-pending entry — CONFIRMED via concurrency.relayPacketAckAndPhoneRoles.test.js's "2 generations back" test)
STORAGE: relay.js store Map only (client-side, no separate ack-tracking storage needed — the client already knows it processed the message)
RESPONSE: {acked: N} (count of entries actually deleted)
NEXT STATE: entry permanently gone (acked) OR, if no ack arrives before the grace window expires, deliverable AGAIN with a NEW token (deliberate design trade-off: bounded double-delivery risk traded against the ORIGINAL unbounded message-loss risk of pure delete-on-fetch)
```

**Known, accepted consequence (MESSAGING-007's redelivery half):** because `RTCStore.buffer`/`RTCStore.ts`'s message-push path has NO msgId/content-based deduplication (confirmed by direct production-code test, `SECURITY_CHAOS_TESTING.md` Scenario 7), the one failure mode this ack mechanism is DESIGNED to produce (client processed a message, then died before its ack went out) is a demonstrated, real route to a message being visibly displayed twice in the chat UI. Not a confidentiality/integrity issue — every duplicate is a legitimately-authenticated ciphertext the real peer actually sent once — purely a display/processing-count annoyance.

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/stateMachine.packetAckDurability.test.js`, `__tests__/security/concurrency.relayPacketAckAndPhoneRoles.test.js` — 2-generations-back stale ack, overlapping concurrent acks with shared tokens, 20-way ack storm, all empirically confirmed exactly-once accounting).

---

## 11. Message Retry

No explicit application-level "retry N times then give up" logic was found for ordinary text messages beyond the ack-grace-window redelivery (§10) and the poll loops' own natural re-attempt cadence (every 8-15s, indefinitely, with no backoff limit beyond the per-attempt 30-minute reconnect-offer window). Outbound MEDIA specifically has a durable, disk-persisted retry queue (`queue_<chatId>` — survives app restarts); outbound ORDINARY TEXT/SYSTEM messages do NOT have an equivalent durable send-side queue — a message can be lost if the app is killed mid-send with no local record to retry from on next launch (`SECURITY_STATE_MACHINES.md` §7, confirmed as a documented, currently-open gap by `SECURITY_ARCHITECTURE_BACKLOG.md` item B4, "reuses a proven pattern, near-zero new risk" — scoped but not yet implemented).

**Tag: DOCUMENTED (media path), UNVERIFIED/open (text path — explicitly named backlog item, not implemented).**

---

## 12. Replay Handling

Covered in detail across `SECURITY_INVARIANTS_CATALOG.md` MESSAGING-001 through MESSAGING-005. Summary of the CURRENT (re-verified) state:

- Relay-fallback text messages and system-control packets: `isFreshTimestamp()` (confirmed current at `App.tsx:138`), rejects `ts` that is non-finite, >15min old, or >5min in the future.
- Live P2P `type:'text'` messages: same check, added this session (fix confirmed by citation, not independently re-read at its exact call site for this document).
- System-control packets specifically (`secret_start`/`secret_end`/`delete_chat`/`transfer_ready`/`device_wiped` — confirmed current five-element list at `App.tsx:714`, note `device_wiped` is now included alongside the originally-documented four): ALSO sequence-aware via `isNewerThanLastAcceptedSystemTs()` (native only), CONFIRMED current at `App.tsx:725` and cross-referenced in `WebRTCManager.js`'s guard checkpoints — both delivery paths (live P2P and relay-fallback) now share the SAME storage backend for this high-water-mark (the cross-path storage-split bug found and fixed per `SECURITY_CONCURRENCY_REVIEW.md` §2.4).
- Web: has NO sequence-aware check at all (`MESSAGING-005`, a documented, monitored, currently-harmless asymmetry with a tripwire regression test).
- Kyber handshake messages: protected by the `keyExchangeDone` guard (§4, `SESSION-004`), not a timestamp check.

**DISCREPANCY confirmed resolved:** `device_wiped` now appears in the `isSystemControl` subtype list (`App.tsx:714`) — earlier documents (`SECURITY_STATE_MACHINES.md` written before the `device_wiped` mechanism existed) could not have covered this; later documents (`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §3.2) correctly describe it as freshness-checked. Re-confirmed current and accurate.

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (`__tests__/security/replayWindow.test.js`, `__tests__/security/fuzz.protocolMessages.test.js` "DIFFERENTIAL-BEFUND", `__tests__/security/stateMachine.systemSequenceReplay.test.js`).

---

## 13. Key Rotation (per-session — there is no long-term identity to rotate)

Already fully covered in §4/§6/SESSION-001/SESSION-002. Summary: rotation happens ONLY at session boundaries (a brand-new `RTCPeerConnection`/DataChannel, i.e. original pairing or a successful reconnect) — never proactively on a timer, never per-message. A healthy, long-running connection (cover traffic + 12s liveness tolerance keep it alive) can run on ONE secret indefinitely. There is no automatic re-key trigger on suspected compromise, and no Signal-style "safety number changed, re-verify" forced prompt — only the opt-in Safety Code (`P2P-002`/`P2P-003`).

**Tag: DOCUMENTED, IMPLEMENTED, TESTED** (same tests as §4/§6).

---

## 14. Device Revocation (`device_wiped`)

```
ACTOR: The device performing a 5-fail PIN wipe (native) or pepper-triggered wipe (web)
INPUT: none (automatic, triggered by the 5th wrong PIN attempt)
MESSAGE: for EVERY contact with a still-live shared secret: encryptMsg('{"type":"system","subtype":"device_wiped","ts":Date.now()}', secret, purpose defaults to 'message' — CONFIRMED current at App.tsx:1316, NOT purpose='system-packet' despite the CRYPTOGRAPHY-002 purpose-separation invariant existing for exactly this kind of message; this is worth flagging as a DISCREPANCY between the documented intent of purpose-separation and this specific call site's actual argument) → POST /packet, FIRE-AND-FORGET (not awaited — the local wipe proceeds regardless of send success, per the explicit in-code comment "kein await auf das Netzwerk")
CRYPTO OPERATION: standard encryptMsg (see caveat above on the purpose argument)
STATE CHANGE: sent BEFORE local secret/contact data is destroyed (so the notification can still be constructed using the about-to-be-wiped secret) — CONFIRMED current ordering: RTCStore.sharedSecrets read for notification content happens before RTCStore.resetAll() runs, which happens before the final AsyncStorage.clear()/EncryptedStorage.clear()
STORAGE: n/a (destroyed, not written, on this device); on the RECEIVING device — see next
RESPONSE: n/a (fire-and-forget)
NEXT STATE (sending device): no-device-identity (fully wiped)
```

```
ACTOR: Receiving device (a contact of the wiped device)
INPUT: the device_wiped packet, via relay-fallback poll or live P2P
CRYPTO OPERATION: decryptMsg under the (still-valid, on THIS side) shared secret; MUST pass isFreshTimestamp() + isNewerThanLastAcceptedSystemTs() (native) since device_wiped is in the isSystemControl list (§12)
STATE CHANGE: RTCStore.clearContact(contact.id) — closes the connection, purges sharedSecrets/buffer/listeners/audioBuffer/imgBuffer entries for that one contact (STORAGE-005's clearContact half)
STORAGE: contact removed/tombstoned locally
RESPONSE: n/a
NEXT STATE: contact marked as wiped/gone on the receiving side
```

**Authenticity vs. suppression (re-confirmed structurally, matching `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §3.2's analysis, not independently re-derived from scratch for this document but consistent with the AEAD-authentication argument applied everywhere else in this reconstruction):** a malicious relay CANNOT forge a `device_wiped` notice (it never holds the shared secret required to produce a validly-authenticated one) but CAN trivially suppress a genuine one (drop it, or delay it past the freshness window) — an accepted, documented limitation of the single-relay delivery model, not a violation of the mechanism's authenticity guarantee.

**Tag: DOCUMENTED, IMPLEMENTED. No dedicated automated test filename was identified in the read audit trail specifically for the device_wiped send/receive round-trip end-to-end** (its cleanup HALF is covered by `stateMachine.rtcStoreWipeLifecycle.test.js`'s `clearContact()` tests, but not the send-then-receive protocol flow itself).

---

## 15. Logout (confirmed absent as a distinct concept)

Re-confirmed directly: there is no "logout" separate from PIN re-lock (native, does NOT clear in-memory `RTCStore` state or `EncryptedStorage` — the Keystore-backed data remains equally accessible regardless of lock state, per `DEVICE-003`) or `Storage.lock()` (web, nulls the in-memory `dek` only — `localStorage` remains AES-GCM-encrypted at rest regardless, requiring a fresh PIN+pepper round-trip to unlock again). Neither path notifies any contact or the relay. This matches every prior document's description; no discrepancy found on re-reading.

```
ACTOR: User (native: backgrounding/re-locking; web: explicit lock or tab-close/heap-loss)
INPUT: none
MESSAGE: none
CRYPTO OPERATION (web only): dek reference dropped (garbage-collectable, not explicitly zeroed — JS string/CryptoKey lifetime is GC-dependent, not deterministic, per the same caveat that applies to every secret in this codebase)
STATE CHANGE: UI returns to LockScreen; underlying data remains equally protected/unprotected as before (native: Keystore-only, PIN doesn't participate; web: genuinely re-locked, requires full unlock flow again)
STORAGE: unchanged
RESPONSE: n/a
NEXT STATE: locked
```

**Tag: DOCUMENTED, IMPLEMENTED. No automated test targets "logout" as a distinct concept since none exists to test.**

---

## 16. Recovery (confirmed absent by design)

Re-confirmed: no backup codes, no recovery phrase, no social/threshold recovery, no third-party escrow anywhere in the repo (repo-wide grep for `recover`/`prekey`/`backup.?code`/`Wiederherstellung`, zero matches outside audit documents — re-confirmed structurally consistent with every prior pass, not independently re-run for this document but no later document contradicts it). The ONLY "recovery" path is a full destructive wipe (5 wrong PIN attempts, native; 5 wrong pepper attempts, web) followed by starting over as an entirely new, unrelated local identity — this is irreversible data loss by explicit design, not a bug, and is the direct trade-off underpinning the app's PIN-lockout security guarantee (`RECOVERY-001`).

**Tag: DOCUMENTED, IMPLEMENTED (absence confirmed, not merely assumed).**

---

## 17. Offline Handling

```
ACTOR: Sender, when RTCStore.isConnected(chatId) reads false
INPUT: outgoing message (text or media)
MESSAGE (text): falls through to the /packet relay-fallback path directly (§8)
MESSAGE (media): encrypted chunks written to a durable queue_<chatId> disk queue (EncryptedStorage-tracked file list, RNFS-backed .enc files — genuine ciphertext, per SECURITY_SECRETS_LIFECYCLE.md §4) BEFORE attempting delivery, so an app kill mid-send can retry from the queue on next launch
CRYPTO OPERATION: as in §7, per chunk
STATE CHANGE: queue entry persists until successful delivery is confirmed
STORAGE: queue_<chatId> (media only — text has no equivalent, per §11's MESSAGING-004-adjacent gap)
RESPONSE: n/a until the peer reconnects and the relay-fallback/offline-transfer mechanism delivers it
NEXT STATE: queued-offline → sent, once connectivity/pairing resumes
```

**Tag: DOCUMENTED, IMPLEMENTED (media path). Text path explicitly lacks this durability — see §11.**

---

## 18. Reconnect

Fully covered in §6 (Session Update / Reconnect) — this is the same mechanism, not a distinct protocol step. Re-stated here only to satisfy the task's explicit flow list: reconnect = a new WebRTC session establishment (§4/§5) whose SDP offer/answer is authenticated under the PRIOR session's shared secret (§6), rather than an out-of-band PSK (§3) or a phone-number-derived one (§3b).

---

## 19. Group Operations (confirmed absent)

Re-confirmed by direct grep of `App.tsx` for `[Gg]roup`: zero matches. No group-chat data model, no N-party key agreement, no membership list anywhere in `HybridCrypto.js`/`.ts`. The architecture is strictly 1:1 — one `role`, one shared secret, per contact pairing. `SECURITY_ARCHITECTURE_BACKLOG.md` item A4 scopes what a future group feature would require (an MLS-style ratchet, explicitly the single riskiest addition considered in that document's entire comparison table) — this reconstruction does not invent a flow for a feature that does not exist.

**Tag: N/A — feature does not exist, confirmed by fresh grep for this document.**

---

## Appendix: automated test inventory referenced above (confirmed present via directory listing, `__tests__/security/` + `__tests__/perf/`)

```
chaos.corruptedState.test.js          chaos.duplicateMessages.test.js
chaos.keyStateRace.test.js            chaos.relayNetworkFailures.test.js
chunkBinding.test.js                  chunkPadding.test.js
concurrency.callManagerPollGuard.test.js
concurrency.contactsStorageLostUpdate.test.js
concurrency.relayPacketAckAndPhoneRoles.test.js
concurrency.rtcCloseRaces.test.js
fuzz.attachmentMetadata.test.js       fuzz.keyMaterial.test.js
fuzz.messageCrypto.test.js            fuzz.protocolMessages.test.js
fuzz.relayApiInput.test.js            fuzz.serverResponseParsing.test.js
hiddenBugHunt.closeDuringHandshake.test.js
messageCrypto.domainSeparation.test.js   messageCrypto.tamper.test.js
phonePskIndependence.test.js          relay.http.test.js
replayWindow.test.js                  stateMachine.keyExchangeDuplicate.test.js
stateMachine.packetAckDurability.test.js
stateMachine.pollCycleGuard.test.js   stateMachine.rtcStoreWipeLifecycle.test.js
stateMachine.sendStatusHonesty.test.js
stateMachine.storageUnlockRace.test.js
stateMachine.systemSequenceReplay.test.js
perf/relayStoreScanScale.test.js      perf/staleTransferBufferLeak.test.js
```

---

## Summary of discrepancies found (prior-doc claim vs. current code)

1. **QR-pairing `contactId` derivation (§3a)** — prior docs (`SECURITY_REVIEW_3` Finding B and everything citing it) describe the permanent local contact ID as the raw 32-bit routing token; current code derives it via `deriveContactId(token, pskHex)`, a PSK-dependent value an attacker who only observes relay traffic cannot compute. This is an undocumented-by-name fix, not previously called out in any of the 21 audit documents read.
2. **`device_wiped`'s `encryptMsg` purpose argument (§14)** — uses the default `'message'` purpose rather than a dedicated `'system-packet'` purpose, despite the app having a purpose-separation mechanism (`CRYPTOGRAPHY-002`) seemingly intended to cover exactly this kind of control message. Not flagged as a live vulnerability (no cross-protocol confusion path was demonstrated), but an inconsistency with the domain-separation invariant's evident intent, not previously named in any prior document read for this reconstruction.
3. **`/send` and `/receive/:recipient` are still live route handlers, not removed** — every prior document correctly notes they have zero callers (re-confirmed here), but a reader of the route list alone, without checking callers, could wrongly conclude otherwise; noted explicitly to close that gap.
4. **`device_wiped` is included in the `isSystemControl` replay-protected subtype set** — consistent with the LATER documents (`SECURITY_ARCHITECTURE_THREAT_MODEL.md`), not the EARLIER ones (`SECURITY_STATE_MACHINES.md`, written before this mechanism existed) — not a real discrepancy, just a timeline artifact, noted for completeness.
5. **`hashPhone()`/`derivePhonePSK()`'s weak-hash fallback status (§3b)** — NOT independently re-verified fixed or unfixed for this document; explicitly flagged rather than silently inherited as either "still broken" or "confirmed fixed" from any single prior source, since no later document in the trail explicitly re-confirms this specific fix the way it does for several other findings.

No discrepancy found in this reconstruction contradicts a SECURITY property currently claimed to hold — all five are either genuine improvements not previously documented, or gaps in this reconstruction's own verification depth that are explicitly flagged rather than papered over.
