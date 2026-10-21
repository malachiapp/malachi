# Security & Privacy Invariants Catalog — SecureCommApp ("Malachi")

Synthesized from the full security-hardening audit trail of this session (`SECURITY_REVIEW_1`–`6`, `SECURITY_AUDIT_CRYPTO_CLAIMS.md`, `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`, `SECURITY_STATE_MACHINES.md`, `SECURITY_CHAOS_TESTING.md` + `_FOLLOWUP_FIXES.md`, `SECURITY_SECRETS_LIFECYCLE.md` + `_FIXES.md`, `SECURITY_FUZZING_CAMPAIGN.md`, `SECURITY_ARCHITECTURE_THREAT_MODEL.md` + `_BACKLOG.md` + `_FINDINGS_ADDRESSED.md`, `SIMPLIFICATION_PASS.md`, `SECURITY_HIDDEN_BUG_HUNT.md`, `SECURITY_API_CONTRACTS_ERROR_HANDLING.md`, `SECURITY_CONCURRENCY_REVIEW.md`, `SECURITY_SELF_REVIEW.md`, `PERFORMANCE_AUDIT.md`, `CONTACTS_RACE_FIX.md`) plus direct re-verification against current code (`relay.js`, `App.tsx`, `WebRTCManager.js`/`.ts`, `MessageCrypto.js`/`.ts`, `RTCStore.js`/`.ts`, `Storage.ts`, `CallManager.js`) at git ref `a6091f1` on branch `rn-upgrade-086`.

Every invariant's `Current Status` was cross-checked against the real `__tests__/security/` and `__tests__/perf/` suites as they exist today (32 files, listed in Deliverable 2's appendix), not merely trusted from a prior document's framing. Where a cited test's existence and coverage were directly confirmed by reading its file, the status reflects that; where no automated test exists, it is marked accordingly even if a prior document called the property "PROVEN" by code-reading alone.

Categories with no applicable invariants (MULTI-DEVICE, GROUPS) are marked N/A with a one-line justification rather than populated with invented entries.

---

## SECURITY

```
ID: SECURITY-001
Kategorie: SECURITY
Beschreibung: No home-grown cryptographic primitive or protocol may be implemented anywhere in the codebase; all cryptographic operations must go through audited libraries (@noble/ciphers, @noble/hashes, @noble/post-quantum on web; BouncyCastle via KyberModule.kt on native; Node's own crypto module in relay.js).
Warum wichtig: Hand-rolled crypto is the single most common source of catastrophic, silent security failures; this is a standing project-wide constraint that every audit pass in this session was explicitly bound by.
Betroffene Komponenten: MessageCrypto.js/.ts, HybridCrypto.js/.ts, KyberModule.kt, relay.js
Angreifermodell: N/A (development-process invariant, not an attacker-facing one)
Precondition: Any code path that touches key material, nonces, or ciphertext.
Invariant: grep across the repo for ad-hoc bitwise/XOR/custom-hash constructions used for confidentiality or integrity must return zero hits outside the documented, intentional non-cryptographic fallback in SECURITY-002.
Violation: A future commit adds a custom cipher, a hand-rolled MAC, or a non-CSPRNG-seeded key derivation.
Detection Method: Manual code review; dependency audit (SECURITY_REVIEW_6).
Automated Test: NONE (process invariant, not mechanically enforced)
Current Status: PROVEN
```

```
ID: SECURITY-002
Kategorie: SECURITY
Beschreibung: A decrypt, AEAD-verify, or KEM (encapsulate/decapsulate) operation that fails must never be treated as success — the failure must result in the message being dropped, the handshake step being aborted, or the session state being left unchanged, never in a null/wrong plaintext being delivered or a handshake being marked complete.
Warum wichtig: This is the single invariant that makes "the relay/network cannot forge content" hold; a fail-open crypto path would let any adversary who can inject malformed ciphertext bypass authentication entirely.
Betroffene Komponenten: MessageCrypto.js/.ts (decryptMsg), WebRTCManager.js/.ts (channel.onmessage, kyber_pubkey/kyber_ciphertext handlers), App.tsx/web/src/App.tsx (every decryptMsg call site)
Angreifermodell: Malicious/compromised relay, active network attacker, malicious peer
Precondition: Any ciphertext or KEM payload reaches a decrypt/decapsulate call.
Invariant: For every code path that calls decryptMsg/kyberDecapsulate/kyberEncapsulate, a falsy/thrown result must never be followed by state mutation implying success (sharedSecret assignment, keyExchangeDone=true, onMessage delivery, chat display).
Violation: A decrypt failure silently displays garbage/empty text as a "received message", or a failed KEM step still sets keyExchangeDone=true.
Detection Method: Exhaustive grep + read of every decryptMsg/kyberEncapsulate/kyberDecapsulate call site (done in SECURITY_API_CONTRACTS_ERROR_HANDLING.md Part 2); fuzz testing of malformed ciphertext.
Automated Test: __tests__/security/messageCrypto.tamper.test.js ("Bit-Flip an Start/Mitte/Ende des Chiffrats wird abgelehnt", "nicht-base64 Muell wird abgelehnt", "falscher Shared Secret wird abgelehnt"), __tests__/security/fuzz.messageCrypto.test.js, __tests__/security/fuzz.keyMaterial.test.js
Current Status: AUTOMATED
```

```
ID: SECURITY-003
Kategorie: SECURITY
Beschreibung: The relay (relay.js) must never bind to plaintext HTTP silently when TLS was intended; if TLS_CERT_PATH/TLS_KEY_PATH are unset or fail to load, the server currently falls back to plaintext HTTP with a console warning and startup-banner notice rather than refusing to start.
Warum wichtig: A silently-downgraded relay exposes all routing metadata, SDP signaling ciphertext-adjacent structure, and (if TLS was the only thing standing between an on-path attacker and the wire) the entire protocol to any network observer, not just the relay operator.
Betroffene Komponenten: relay.js (TLS setup, ~line 56-64, startup banner)
Angreifermodell: Network observer (ISP, on-path attacker) when TLS is expected but not configured
Precondition: Relay operator does not configure or misconfigures TLS_CERT_PATH/TLS_KEY_PATH.
Invariant: In any non-explicitly-local deployment, the relay should refuse to serve traffic over plaintext HTTP without an explicit opt-in flag — currently NOT the case; the relay fails open (serves anyway) with only a log warning.
Violation: A production relay deployment silently serves plaintext HTTP because a cert path env var was mistyped or a cert failed to load, with no operator-visible enforcement failure.
Detection Method: Code reading (relay.js:55-64, 762-765); SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 4.
Automated Test: NONE
Current Status: UNVERIFIED (known, documented, deliberately-deferred gap — SECURITY_ARCHITECTURE_BACKLOG.md B1-adjacent; not fixed by design choice, not a bug this session closed)
```

```
ID: SECURITY-004
Kategorie: SECURITY
Beschreibung: Every request body the relay accepts must be bounded in size before being fully buffered into memory, regardless of what Content-Length claims.
Warum wichtig: Without a hard cap, a single attacker can exhaust relay process memory with oversized POST bodies, taking down the relay for every paired user (a shared single point of failure per SECURITY-016/RELAY-001).
Betroffene Komponenten: relay.js (MAX_BODY_BYTES, all POST routes)
Angreifermodell: Unauthenticated network attacker (no auth required for any relay endpoint)
Precondition: Attacker can reach the relay's HTTP port.
Invariant: Any POST body exceeding 2MB (MAX_BODY_BYTES) must be rejected with 413 and the connection destroyed before the full body is buffered into a JS string, checked incrementally as bytes arrive (not only via the client-supplied, spoofable Content-Length header).
Violation: A >2MB body is accepted, buffered, and processed; or a body is buffered fully in memory before the size check runs.
Detection Method: Black-box HTTP test against a real spawned relay process.
Automated Test: __tests__/security/relay.http.test.js ("Body-Groessenlimit" describe block — 20MB POST → 413; ~150KB realistic chunk upload still succeeds)
Current Status: AUTOMATED
```

---

## PRIVACY

```
ID: PRIVACY-001
Kategorie: PRIVACY
Beschreibung: The relay must never receive or be able to recover plaintext for chat text, images, audio, call signaling payloads, or the Kyber-derived shared secret — every value it stores or forwards for these categories must be AEAD ciphertext or a value it cannot invert.
Warum wichtig: This is the app's core "content confidentiality against a fully malicious relay" claim; if violated, the relay operator (a named threat actor in every audit) gains full read access to all user communications.
Betroffene Komponenten: MessageCrypto.js/.ts, relay.js (/packet, /transfer/*, /reconnect/*, /signal/*, /call/signal routes)
Angreifermodell: Fully malicious/compromised relay operator
Precondition: Any message, image/audio chunk, or call-signal payload transits the relay.
Invariant: Every relay-stored/forwarded payload for these categories is the output of encryptMsg() (AEAD ciphertext) — never plaintext, never key material.
Violation: A plaintext chat message, image byte, or the raw shared secret appears in any relay.js store entry or is echoed in a relay response.
Detection Method: Code reading of every relay.js store/forward call site; SECURITY_REVIEW_3 Q1 (malicious-relay content-visibility analysis).
Automated Test: __tests__/security/messageCrypto.tamper.test.js (indirect — proves ciphertext is opaque without the key); no direct test asserts relay.js never receives a plaintext field for these categories
Current Status: PROVEN
```

```
ID: PRIVACY-002
Kategorie: PRIVACY
Beschreibung: hashIp() must be non-reversible by a party who obtains only relay log files (not live process memory) — implemented as HMAC-SHA256 keyed by a per-process-startup random secret (ipLogSecret), not a bare hash.
Warum wichtig: A bare sha256(ip) is trivially reversible for the whole IPv4 space via a one-time precomputation (SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 3 demonstrated this concretely); the HMAC fix closes that specific reversal path for log-file readers.
Betroffene Komponenten: relay.js (ipLogSecret, hashIp())
Angreifermodell: A party who later obtains relay log files without also having live access to the running process's memory
Precondition: relay.js logs a hashed IP via registerFail()/similar paths.
Invariant: hashIp(ip) output must be computationally infeasible to reverse to the source IP without knowledge of ipLogSecret, which is generated fresh via crypto.randomBytes(32) at process startup and never persisted or logged.
Violation: An attacker precomputes a rainbow table mapping all 2^32 IPv4 addresses to their hashIp() output and successfully reverses a captured log line.
Detection Method: Code reading (relay.js ~line 272-287); confirmed HMAC construction, confirmed key is process-lifetime-only and never logged.
Automated Test: __tests__/security/relay.http.test.js (same source IP produces different hashes across two independent relay processes; stays stable within one process)
Current Status: AUTOMATED — but scoped narrowly: this protects only against a log-file reader without process access; the live relay process itself always has the raw IP (see METADATA-001, not a violation of this specific invariant).
```

```
ID: PRIVACY-003
Kategorie: PRIVACY
Beschreibung: Local push/system notifications must never contain message plaintext, sender identity, or any content-derived field — only generic, hardcoded strings.
Warum wichtig: A locked-screen notification preview is a common leak surface (visible to anyone glancing at the device); this app's own explicit threat model includes "stolen/compromised device."
Betroffene Komponenten: MalachiNotificationModule.kt, MalachiFirebaseMessagingService.kt, pushSender.js
Angreifermodell: Anyone with physical or visual access to a locked device
Precondition: A message or call arrives while the app is backgrounded.
Invariant: showNotification() takes zero content arguments; FCM payload is data-only with a two-value reason enum ('incoming_call'|'message'), never a contact ID or content field.
Violation: A notification preview displays sender name or message text.
Detection Method: Full read of MalachiNotificationModule.kt (65 lines) and MalachiFirebaseMessagingService.kt; SECURITY_SECRETS_LIFECYCLE.md §7.
Automated Test: NONE (native Kotlin, not covered by the Jest suite)
Current Status: PROVEN (by code reading; structurally incapable of receiving content, not merely configured not to show it)
```

```
ID: PRIVACY-004
Kategorie: PRIVACY
Beschreibung: No analytics, crash-reporting, or telemetry SDK (Crashlytics, Sentry, Firebase Analytics, Flipper, etc.) may be integrated anywhere in the app.
Warum wichtig: Any such integration is a structural exfiltration channel that could capture secrets, plaintext, or usage metadata off-device to a third party outside the app's trust boundary.
Betroffene Komponenten: package.json, MainApplication.kt, android/ build config
Angreifermodell: Third-party SDK vendor / anyone with access to that vendor's data
Precondition: N/A — absence is checked at the dependency-graph level.
Invariant: No such dependency appears in package.json/android build files, and no initialization call for one appears in MainApplication.kt.
Violation: A future dependency bump silently reintroduces Flipper (removed as part of the RN 0.73→0.86 upgrade) or adds a crash-reporting SDK.
Detection Method: Repo-wide grep for Crashlytics/Sentry/Analytics/Flipper/mixpanel/amplitude (SECURITY_SECRETS_LIFECYCLE.md §7).
Automated Test: NONE (would need a package.json/dependency-graph CI check, not present)
Current Status: PROVEN (as of this audit's snapshot; not continuously enforced)
```

```
ID: PRIVACY-005
Kategorie: PRIVACY
Beschreibung: The app must never write user data (message text, keys, PIN, Safety Code) to the OS clipboard.
Warum wichtig: Clipboard content is broadly readable by other apps (clipboard managers, accessibility services) on many OS versions; avoiding clipboard use entirely closes off that leak class.
Betroffene Komponenten: App.tsx, web/src/App.tsx (absence check)
Angreifermodell: Other apps / clipboard-history tooling on the same device
Precondition: N/A — absence is checked.
Invariant: No Clipboard API call exists anywhere in the native or web client for message/key/PIN/Safety-Code content.
Violation: A future feature (e.g. "copy message") adds a Clipboard.setString() call for sensitive content without considering this invariant.
Detection Method: Repo-wide grep for "Clipboard" (SECURITY_SECRETS_LIFECYCLE.md §7).
Automated Test: NONE
Current Status: PROVEN
```

```
ID: PRIVACY-006
Kategorie: PRIVACY
Beschreibung: Attachment content bytes (image/audio payload) must remain confidential end-to-end even though the relay legitimately sees mimeType, transferType, and chunk-count metadata in cleartext for routing purposes.
Warum wichtig: This draws the precise line between what "encrypted at rest/in transit" actually covers for attachments (content: yes; size-class/type metadata: no) — overclaiming full attachment privacy would mislead users about a real, structural metadata leak.
Betroffene Komponenten: ImageCrypto.js, AudioCrypto.js, relay.js (/transfer/:token/chunk/:index)
Angreifermodell: Malicious/compromised relay (metadata-curious, not content-reading)
Precondition: An image or audio message is sent via the offline-transfer path.
Invariant: The `data` field of every transfer chunk is always AEAD ciphertext (content confidentiality holds); mimeType/transferType/chatId/total fields are always cleartext (metadata privacy explicitly does NOT hold for these fields — this is a known, documented, unfixed exposure, not a violation of the content-confidentiality half).
Violation: Attachment content bytes (not metadata) appear in a relay store entry unencrypted.
Detection Method: Code reading (relay.js:246-268/352-374, RelayClient.js sendTransferChunk); SECURITY_REVIEW_3 Q1, SECURITY_REVIEW_5 finding 5.
Automated Test: __tests__/security/chunkBinding.test.js, __tests__/security/chunkPadding.test.js (padding of final chunk size, not metadata-field encryption)
Current Status: PROVEN for content; the metadata half is a known, accepted architectural limitation (see METADATA-003), not tracked as a violation of this invariant.
```

---

## IDENTITY

```
ID: IDENTITY-001
Kategorie: IDENTITY
Beschreibung: No long-term, cryptographic identity keypair (signing or otherwise) exists or may be silently introduced anywhere in the system — every KEM keypair is generated fresh per WebRTC session and discarded.
Warum wichtig: This is a deliberate, structural design property: it bounds the blast radius of any single compromise (no durable identity to steal) but also means there is no way to cryptographically detect a reconnect-hijack (see SESSION-006) — the trade-off must be preserved deliberately, not eroded incrementally.
Betroffene Komponenten: WebRTCManager.js/.ts (generateKyberKeypair in channel.onopen), HybridCrypto.js/.ts
Angreifermodell: N/A — structural/architectural invariant
Precondition: Any pairing or reconnect attempt.
Invariant: grep for any persisted asymmetric keypair used across multiple sessions/pairings must return zero hits; myKyberKeys is generated fresh in channel.onopen and never persisted to disk.
Violation: A future feature persists a Kyber keypair to reuse it across sessions, or introduces a signing identity key without a dedicated cryptography review (per SECURITY_ARCHITECTURE_BACKLOG.md A1).
Detection Method: Code reading (WebRTCManager.js:319/WebRTCManager.ts:239); grep for EncryptedStorage/setItem references to myKyberKeys (zero hits).
Automated Test: NONE directly; __tests__/security/stateMachine.keyExchangeDuplicate.test.js indirectly confirms a fresh instance starts with keyExchangeDone=false
Current Status: PROVEN
```

```
ID: IDENTITY-002
Kategorie: IDENTITY
Beschreibung: my_id (the locally-generated random display/routing identifier) must never be used as, or derived into, cryptographic key material.
Warum wichtig: Conflating a routing label with key material would let the relay (which sees my_id-derived values in some flows) influence or predict session keys.
Betroffene Komponenten: App.tsx (SetupScreen, generateContactId), MessageCrypto.js/.ts, HybridCrypto.js/.ts
Angreifermodell: Malicious relay
Precondition: N/A — checked structurally.
Invariant: my_id is never passed as an argument to encryptMsg/deriveKeys/kyberEncapsulate/kyberDecapsulate anywhere in the codebase.
Violation: A future commit derives an encryption key from my_id or a contact's my_id.
Detection Method: Grep across MessageCrypto/HybridCrypto call sites for my_id (SECURITY_SECRETS_LIFECYCLE.md §0 table).
Automated Test: NONE
Current Status: PROVEN
```

```
ID: IDENTITY-003
Kategorie: IDENTITY
Beschreibung: There is no account-recovery or cross-device-identity mechanism, by design — this must remain true unless a dedicated, independently-reviewed Identity (A1) and Account Recovery redesign is undertaken.
Warum wichtig: The absence of identity/recovery is the other half of the trade-off in IDENTITY-001 — reintroducing it piecemeal (e.g. a quick "recover my account" feature) without the accompanying cryptographic redesign would create a bypass path for the security properties the current design provides.
Betroffene Komponenten: App.tsx, web/src/lib/Storage.ts, relay.js (absence of any /register, /login, /recover route)
Angreifermodell: N/A — structural
Precondition: N/A.
Invariant: relay.js contains no account/session/login route; no recovery-code/backup-code/Wiederherstellung feature exists anywhere in the repo.
Violation: A "forgot PIN" feature is added that restores access without full data loss, without going through the A5 cryptography-review process in SECURITY_ARCHITECTURE_BACKLOG.md.
Detection Method: Repo-wide grep for recover/prekey/backup.?code/Wiederherstellung (SECURITY_SECRETS_LIFECYCLE.md §8) — zero matches outside audit docs.
Automated Test: NONE
Current Status: PROVEN
```

---

## DEVICE

```
ID: DEVICE-001
Kategorie: DEVICE
Beschreibung: Exactly one EncryptedStorage (native) / localStorage (web) instance constitutes "the device" — there is no multi-device-same-account concept, no device list, no device-linking flow.
Warum wichtig: This bounds compromise scope (compromising one device's storage only exposes that device's own pairings) and is the reason no cross-device metadata-correlation surface exists today.
Betroffene Komponenten: App.tsx (SetupScreen, my_id generation), web/src/lib/Storage.ts
Angreifermodell: N/A — architectural
Precondition: N/A.
Invariant: There is no server-side or client-side data structure mapping multiple devices to one logical account.
Violation: A device-linking feature is added without the accompanying Identity (A1) redesign per SECURITY_ARCHITECTURE_BACKLOG.md B5.
Detection Method: Grep for device_id/linked_device/multi-session concepts (SECURITY_HIDDEN_BUG_HUNT.md attempt #4, confirmed absent).
Automated Test: NONE
Current Status: PROVEN
```

```
ID: DEVICE-002
Kategorie: DEVICE
Beschreibung: android:allowBackup must remain "false" in AndroidManifest.xml so that EncryptedStorage-backed secret material (shared_secret_<id>, app_pin, etc.) is never included in any Android OS-level backup mechanism (Auto Backup, ADB backup).
Warum wichtig: OS-level backups are a different trust/extraction boundary than the device's own Keystore; excluding the app from backup entirely closes off an entire class of secret-exfiltration-via-backup-file attacks.
Betroffene Komponenten: android/app/src/main/AndroidManifest.xml
Angreifermodell: Anyone who obtains an OS-level backup of the device (cloud backup compromise, ADB backup extraction)
Precondition: N/A — checked structurally.
Invariant: AndroidManifest.xml:26 sets android:allowBackup="false" unconditionally.
Violation: A future manifest change sets allowBackup="true" or adds a fullBackupContent allowlist that includes secret-bearing files.
Detection Method: Direct read of AndroidManifest.xml (SECURITY_SECRETS_LIFECYCLE.md §1, point 10).
Automated Test: NONE (would need a CI assertion on the manifest, not present)
Current Status: PROVEN
```

```
ID: DEVICE-003
Kategorie: DEVICE
Beschreibung: The native PIN/biometric lock screen must not be assumed by users or documentation to cryptographically gate EncryptedStorage's data-at-rest key — it is currently a UI-only access gate (plain string comparison, no key derivation), independent of the Android-Keystore-backed encryption that protects the data regardless of lock state.
Warum wichtig: This is a genuine, user-consequential gap between the ordinary mental model of a "PIN lock" and what it actually does on native; documentation/UI must not overstate it, and any future fix (deriving the storage key from the PIN, as web already does) is a real architecture change requiring a migration story.
Betroffene Komponenten: App.tsx (LockScreen, EncryptedStorage.getItem('app_pin'), string-equality check at ~line 1079)
Angreifermodell: Anyone with API-level access to the running app (patched/instrumented build, accessibility-automation exploit, debuggable build) — NOT a rooted-device attacker at the Keystore layer, which is separately protected.
Precondition: Native app, PIN/biometric lock screen present.
Invariant: (Currently) the native PIN/biometric check is a React-state transition (nav('home')) with no dependency on any key derivation; EncryptedStorage's key remains usable identically regardless of lock state. This invariant is stated to be TRACKED, not to be asserted as a desired security property — it documents current, verified behavior that must not be mis-described as "the PIN protects your data" in any user-facing copy.
Violation: UI or documentation claims the PIN cryptographically protects stored data on native, when it does not.
Detection Method: Code reading (App.tsx:1079); grep confirming `pin` is never referenced in MessageCrypto.js/HybridCrypto.js/ImageCrypto.js/AudioCrypto.js (SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 9).
Automated Test: NONE
Current Status: UNVERIFIED as a security property (confirmed NOT to hold — this is a documented, deliberately-deferred gap per SECURITY_ARCHITECTURE_BACKLOG.md; deferred pending a key-hierarchy redesign, not scheduled)
```

---

## SESSION

```
ID: SESSION-001
Kategorie: SESSION
Beschreibung: A fresh WebRTCManager instance and a fresh ML-KEM-768 keypair must be generated for every new connection attempt (original pairing or reconnect) — the resulting shared secret must be independently derived per session, not reused from a prior session.
Warum wichtig: This is the mechanism that provides genuine session-boundary forward secrecy: a device compromised after a rotation cannot decrypt messages from before that rotation, because the old secret is overwritten and retained nowhere.
Betroffene Komponenten: App.tsx (doInitiatorConnect, checkOutgoing/checkIncoming), WebRTCManager.js/.ts (channel.onopen, generateKyberKeypair)
Angreifermodell: Device/storage compromise occurring after a session rotation
Precondition: A new RTCPeerConnection/DataChannel is created.
Invariant: Every channel.onopen (initiator side) calls generateKyberKeypair() unconditionally; the resulting sharedSecret always overwrites the prior value in RTCStore.sharedSecrets and persisted storage.
Violation: A reconnect reuses a cached Kyber keypair or fails to overwrite the previous session's shared secret.
Detection Method: Code reading (WebRTCManager.js:266, App.tsx:458/773); SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 3.
Automated Test: NONE directly exercises full session-boundary rotation end-to-end; __tests__/security/chaos.keyStateRace.test.js exercises a real two-instance handshake with real crypto.
Current Status: PROVEN
```

```
ID: SESSION-002
Kategorie: SESSION
Beschreibung: Within a single session, there is no per-message or per-N-message key ratchet — deriveKeys() is a pure deterministic function of the static sharedSecret for the entire session's lifetime. This is documented as a known, accepted design limitation, not a bug, but must not be misrepresented as providing message-level forward secrecy.
Warum wichtig: A disk/memory compromise of the currently-active shared secret exposes every message sent during that session (past and future-until-next-rotation) — this bounds what "forward secrecy" can honestly be claimed to mean for this app.
Betroffene Komponenten: MessageCrypto.js/.ts (deriveKeys, encryptMsg/decryptMsg)
Angreifernodell: Device/storage compromise while a session is active
Precondition: A WebRTC session with an established shared secret is in progress.
Invariant: No ratcheting/key-evolution code exists in MessageCrypto.js/.ts; the same k1/k2/k3 keys are derived and reused for every message in a session.
Violation: A ratchet is silently added in a way inconsistent with this documented absence, or (more realistically) marketing/UI copy implies per-message forward secrecy that doesn't exist.
Detection Method: Code reading confirming no HKDF-forward/counter-based key evolution anywhere (SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 3, point 5; SECURITY_REVIEW_2 §9).
Automated Test: NONE (absence-of-feature, not directly testable)
Current Status: PROVEN (as an accurate description of current, intentional behavior — tracked as SECURITY_ARCHITECTURE_BACKLOG.md item A1's motivating gap, not scheduled for a quick fix)
```

```
ID: SESSION-003
Kategorie: SESSION
Beschreibung: A WebRTCManager instance whose close() has run (_closed=true) must not be allowed to mutate this.sharedSecret, RTCStore.sharedSecrets, or the persisted shared_secret_<chatId> entry when a Kyber handshake that was in flight at the moment of close() later resolves — checked at two independent points: immediately after the KEM bridge call resolves, and again immediately after the persistence write (EncryptedStorage.setItem/Storage.setItem) resolves.
Warum wichtig: Without this, a 5-fail wipe, a chat delete, a device_wiped tombstone, or a losing reconnect-race connection could resurrect a session secret for a contact the user just told the app to forget — directly undermining the wipe/delete guarantee (RECOVERY-002/RECOVERY-003).
Betroffene Komponenten: WebRTCManager.js/.ts (_closed flag, both Kyber handlers, both guard checks)
Angreifermodell: Not attacker-triggered directly, but the underlying race is reachable by ordinary UI actions (delete, wipe) landing during an in-flight handshake; a malicious peer could also try to time a handshake message to land during a victim's wipe.
Precondition: A Kyber handshake is in flight (post kyber_pubkey/kyber_ciphertext receipt, pre-completion) when close() is called on the same instance.
Invariant: this._closed is checked immediately after the KEM bridge await resolves (window A) AND immediately after the EncryptedStorage/Storage persistence await resolves (window B); if true at either checkpoint, no further state mutation occurs, and window B's check additionally reverts any state already written between window A and window B.
Violation: A closed instance's suspended handshake handler still writes to RTCStore.sharedSecrets or persisted storage after close() ran.
Detection Method: SECURITY_HIDDEN_BUG_HUNT.md Part 2 (window A, found and fixed); SECURITY_CONCURRENCY_REVIEW.md §2.2 (window B, found and fixed) — both confirmed by temporarily reverting the fix and observing the regression test fail.
Automated Test: __tests__/security/hiddenBugHunt.closeDuringHandshake.test.js (window A, 3 tests, both platforms); __tests__/security/concurrency.rtcCloseRaces.test.js ("Fenster 2" describe block, window B, native + web)
Current Status: AUTOMATED
```

```
ID: SESSION-004
Kategorie: SESSION
Beschreibung: A duplicate or replayed kyber_pubkey/kyber_ciphertext message for a connection that has already completed its key exchange (keyExchangeDone=true) must be dropped, not processed — it must never silently re-derive and overwrite the active shared secret.
Warum wichtig: Before this guard existed, a replayed handshake message (from a compromised TURN data-plane relay or similar) could silently rotate the session key mid-conversation with zero user-visible signal, causing decrypt failures and a session-disruption/potential-hijack primitive on the one unauthenticated message type on the live P2P path.
Betroffene Komponenten: WebRTCManager.js/.ts (channel.onmessage, both Kyber handlers)
Angreifermodell: An attacker positioned to write to the DataChannel transport (e.g. a compromised TURN control/data channel)
Precondition: A session has already completed its Kyber handshake (keyExchangeDone=true).
Invariant: Both kyber_pubkey and kyber_ciphertext handlers check `if (this.keyExchangeDone) return;` (with a warning log) before performing any KEM operation or state mutation.
Violation: A second kyber_pubkey/kyber_ciphertext message for the same instance silently overwrites this.sharedSecret.
Detection Method: SECURITY_STATE_MACHINES.md §5 — found, fixed, and verified to fail when the guard is temporarily stripped.
Automated Test: __tests__/security/stateMachine.keyExchangeDuplicate.test.js (4 tests: native + web, kyber_pubkey + kyber_ciphertext)
Current Status: AUTOMATED
```

```
ID: SESSION-005
Kategorie: SESSION
Beschreibung: close() must null this.onMessage so that a system-control message (secret_start/secret_end/delete_chat/transfer_ready) whose sequence-aware replay check was suspended mid-await at the moment of close() cannot, upon resuming, recreate an already-cleared RTCStore.buffer/listeners entry for that contact.
Warum wichtig: Without this, RTCStore.clearContact()/resetAll()'s own guarantee ("this contact's buffered plaintext/live listener is gone") can be actively undermined — a message resumes processing after the contact was deleted and writes new buffered plaintext back in, which is a stronger violation than merely failing to purge pre-existing buffered data (SECURITY_SECRETS_LIFECYCLE.md Finding S-3).
Betroffene Komponenten: WebRTCManager.js/.ts (close()), RTCStore.js/.ts (setConnection's onMessage closure)
Angreifermodell: Not directly attacker-triggered; reachable via ordinary timing of chat-delete/wipe landing during an in-flight sequence-aware replay check (await isNewerThanLastAcceptedSystemTs).
Precondition: A live-path system-control message's await isNewerThanLastAcceptedSystemTs(...) is pending when clearContact()/resetAll() runs for that same contact.
Invariant: close() sets this.onMessage = null; any onMessage?.() call after close() is therefore a no-op regardless of what the closure would have done.
Violation: A message arrives in RTCStore.buffer for a contact that was already fully deleted/wiped, timestamped after the deletion.
Detection Method: SECURITY_CONCURRENCY_REVIEW.md §2.3 — found and fixed; verified to fail when the fix is temporarily reverted.
Automated Test: __tests__/security/concurrency.rtcCloseRaces.test.js ("Nachrichtenpuffer" describe block)
Current Status: AUTOMATED
```

```
ID: SESSION-006
Kategorie: SESSION
Beschreibung: An attacker who has obtained one device's persisted shared_secret_<chatId> must not be able to use it to durably hijack that pairing's future sessions by forging the next reconnect handshake — currently UNVERIFIED/known-open: reconnect offers/answers are encrypted under the *same, previous* static secret an attacker with that secret could also decrypt/forge, allowing them to inject their own Kyber public key as the "real" reconnecting peer and become the counterparty in the newly-rotated session.
Warum wichtig: This is named across multiple audits as the single most consequential open protocol-design gap in the codebase — it means a one-time secret theft can become a permanent, renewable MITM position, not just a one-session compromise, defeating the value of SESSION-001's rotation.
Betroffene Komponenten: App.tsx/web/src/App.tsx (reconnect offer/answer encryption, RTCStore.getSharedSecret), WebRTCManager.js/.ts
Angreifermodell: An attacker who has obtained one shared secret (rooted-device extraction, coerced user) AND has relay/TURN-position access at the moment of the next reconnect
Precondition: A shared secret has been compromised via a channel other than the live P2P handshake itself (e.g. disk extraction).
Invariant (intended, NOT currently held): Reconnect authentication should be independent of the very secret an attacker might have stolen (e.g. a separate long-term identity key signing each reconnect) — this requires new protocol design and is explicitly out of scope for "no home-grown crypto" fix passes; deferred to SECURITY_ARCHITECTURE_BACKLOG.md A1 (Identity, P2, needs independent cryptography review).
Violation: An attacker with one stolen shared secret successfully completes a forged reconnect and becomes the peer for future sessions — this is the CURRENT reachable behavior, not a hypothetical.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 3 point 7; SECURITY_ARCHITECTURE_THREAT_MODEL.md §3.1 "Connection Hijacking".
Automated Test: NONE (would require a dedicated adversarial reconnect-hijack simulation; not built, deliberately, per the no-new-protocol-design constraint)
Current Status: UNVERIFIED — known, documented, unfixed architectural gap.
```

---

## CRYPTOGRAPHY

```
ID: CRYPTOGRAPHY-001
Kategorie: CRYPTOGRAPHY
Beschreibung: Every AEAD nonce (AES-256-GCM 12 bytes, ChaCha20-Poly1305 12 bytes, XSalsa20-Poly1305 24 bytes) used in encryptMsg() must be freshly generated via a CSPRNG on every single call — never reused, never derived deterministically, never counter-based.
Warum wichtig: Nonce reuse under the same key is a catastrophic AEAD failure mode (plaintext/key recovery for GCM specifically); this is the single property that makes the triple-layer construction's security argument hold at all.
Betroffene Komponenten: MessageCrypto.js/.ts (encryptMsg), KyberModule.kt (randomBytes/SecureRandom), web crypto.getRandomValues
Angreifermodell: Any party observing multiple ciphertexts under the same key (malicious relay with retained history)
Precondition: Any call to encryptMsg — chat messages, image/audio chunks, reconnect/system/call-signal payloads.
Invariant: Every encryptMsg() call draws fresh CSPRNG randomness for all three nonces; no deterministic/counter-based/reused nonce pattern exists anywhere in the codebase.
Violation: Two ciphertexts encrypted under the same key share a nonce for any of the three layers.
Detection Method: Full nonce-reuse audit across every encryptMsg call site (SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 1); property-based fuzzing of the crypto layer.
Automated Test: __tests__/security/fuzz.messageCrypto.test.js (300-run property tests including combinatorial secret+ciphertext fuzzing)
Current Status: AUTOMATED
```

```
ID: CRYPTOGRAPHY-002
Kategorie: CRYPTOGRAPHY
Beschreibung: HKDF-derived per-layer keys (k1/k2/k3) must be domain-separated both by cipher layer (malachi-layer{1,2,3}-...) and by protocol purpose (message/reconnect/call-signal/system-packet/phone-connect), via a `purpose` parameter threaded through deriveKeys()/encryptMsg()/decryptMsg().
Warum wichtig: Without purpose-separation, a ciphertext produced for one protocol use (e.g. a chat message) would be cryptographically indistinguishable from one produced for a different use (e.g. a system control packet) under the same shared secret — a latent cross-protocol confusion risk if any future code path can be induced to encrypt attacker-influenced JSON.
Betroffene Komponenten: MessageCrypto.js/.ts (deriveKeys, purpose parameter)
Angreifermodell: Cross-protocol confusion via a future bug that reflects attacker-influenced content into encryptMsg's plaintext argument
Precondition: The same underlying sharedSecret is used for more than one protocol purpose (reconnect, call-signal, system-packet, phone-connect, ordinary messages all share the pairing's one secret).
Invariant: deriveKeys(sharedSecret, purpose) yields cryptographically independent keys per purpose; decrypting a ciphertext encrypted under purpose A while expecting purpose B must fail.
Violation: A ciphertext encrypted under one purpose label successfully decrypts under a different purpose label.
Detection Method: SECURITY_REVIEW_2 N-5 (originally found as a gap), fixed via purpose-labeled HKDF info strings.
Automated Test: __tests__/security/messageCrypto.domainSeparation.test.js (full purpose matrix, native+web, cross-implementation)
Current Status: AUTOMATED
```

```
ID: CRYPTOGRAPHY-003
Kategorie: CRYPTOGRAPHY
Beschreibung: decryptMsg() must return null (never throw an uncaught exception, never return corrupted/partial plaintext) for any malformed, truncated, bit-flipped, wrong-key, or wrong-purpose ciphertext input.
Warum wichtig: This is the fail-closed contract every caller relies on (SECURITY-002); a thrown exception instead of a clean null return could crash a message-processing loop or, worse, be caught by an overly broad handler that treats the exception as "no message" rather than "reject and alert."
Betroffene Komponenten: MessageCrypto.js/.ts (decryptMsg)
Angreifermodell: Malicious relay, active network attacker, malformed/adversarial peer input
Precondition: Any input reaches decryptMsg — arbitrary base64, arbitrary bytes, truncated ciphertext at any of the AEAD-layer nonce boundaries, bit-flip at any byte position, wrong secret, secret of any length 0-1000 bytes.
Invariant: For the entire fuzzed input space tested (300 runs per property, all truncation boundaries, every byte-position bit-flip), decryptMsg never throws and never returns anything but null on failure or the correct original plaintext on success.
Violation: A crafted input causes decryptMsg to throw uncaught, or to return a non-null value that isn't the correct original plaintext.
Detection Method: Property-based fuzzing (fast-check, seeded, deterministic) across both native and web implementations.
Automated Test: __tests__/security/fuzz.messageCrypto.test.js (14 tests, 300 runs each for cheapest properties), __tests__/security/messageCrypto.tamper.test.js
Current Status: AUTOMATED
```

```
ID: CRYPTOGRAPHY-004
Kategorie: CRYPTOGRAPHY
Beschreibung: The native (BouncyCastle/Kotlin) and web (@noble/post-quantum) ML-KEM-768 implementations must be byte-compatible — a native-generated ciphertext/public key must decapsulate/encapsulate correctly under the web implementation and vice versa, yielding the identical shared secret.
Warum wichtig: Malachi's whole cross-platform pairing model (a native user pairing with a web user) depends on this; if it were false, cross-platform pairings would silently fail to establish a shared secret or (worse) silently establish mismatched secrets.
Betroffene Komponenten: KyberModule.kt (MLKEMKeyPairGenerator/MLKEMGenerator/MLKEMExtractor, ml_kem_768 params), web/src/lib/HybridCrypto.ts (ml_kem768.keygen/encapsulate/decapsulate)
Angreifermodell: N/A — this is a correctness/interoperability invariant, not adversarial
Precondition: A native device pairs with a web device (or vice versa).
Invariant: Both implementations target the identical NIST FIPS 203 final ML-KEM-768 parameter set with identical encoding of public/private keys and ciphertexts.
Violation: A native-generated keypair's ciphertext fails to decapsulate correctly on web, or decapsulates to a different shared secret than the one the native encapsulator produced.
Detection Method: Code inspection only (BouncyCastle 1.80, @noble/post-quantum 0.7.1, both confirmed to target the final FIPS 203 standard) — SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 2.
Automated Test: NONE — the real native ML-KEM-768 implementation only runs on-device/in-JVM and cannot execute under Jest; the cross-implementation test that exists (messageCrypto.domainSeparation.test.js) only proves the *symmetric* MessageCrypto layer is wire-compatible given an already-matching secret, not the KEM step itself.
Current Status: UNVERIFIED — asserted by code comments and library choice, never mechanically proven end-to-end. Explicitly flagged as a manual/on-device verification gap by three separate documents (SECURITY_REVIEW_4, SECURITY_AUDIT_CRYPTO_CLAIMS.md, SECURITY_FUZZING_CAMPAIGN.md).
```

```
ID: CRYPTOGRAPHY-005
Kategorie: CRYPTOGRAPHY
Beschreibung: All randomness feeding cryptographic key material, nonces, and Kyber operations must originate from a genuine CSPRNG — java.security.SecureRandom (native, via KyberModule.randomBytes) or crypto.getRandomValues/Web Crypto (web) — never Math.random().
Warum wichtig: Math.random() is not cryptographically secure and is predictable/seedable; using it for any key/nonce-adjacent value would undermine the corresponding security property.
Betroffene Komponenten: KyberModule.kt, MessageCrypto.js/.ts, HybridCrypto.js/.ts
Angreifermodell: Any attacker able to predict or influence Math.random()'s internal state
Precondition: Any key, nonce, or KEM-material generation.
Invariant: Every key/nonce/Kyber-material-generating call path uses SecureRandom (native)/crypto.getRandomValues (web); Math.random() appears ZERO times in any such call path — though it IS used for several non-cryptographic session/routing tokens (WebRTCManager.js sessionToken, App.tsx reconnect sessionId/dynamicAnswerKey suffixes, phone-connect myId), which is a separate, lower-severity consistency gap tracked distinctly (see SIGNALING-004), not a violation of this specific key-material invariant.
Violation: Math.random() output feeds directly into a Kyber keypair, an AEAD key, or an AEAD nonce.
Detection Method: Full audit of every key-material/nonce code path (SECURITY_REVIEW_2 §7 "Nonce reuse audit"; SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 2/summary table).
Automated Test: NONE directly asserts "no Math.random() in these specific call paths" as a CI check; covered implicitly by the fuzzing suite's key-material tests never observing weak-entropy patterns.
Current Status: PROVEN (for key/nonce material specifically); the routing-token weak-entropy issue is tracked separately under SIGNALING-004/P2P-005.
```

```
ID: CRYPTOGRAPHY-006
Kategorie: CRYPTOGRAPHY
Beschreibung: Every message-type-discriminator and length-prefix field (e.g. chunk `total`, `index`) that originates from a peer-controlled JSON payload must be validated (type, integer-ness, non-negative, bounded maximum) before being used in an allocation (e.g. `new Array(total)`).
Warum wichtig: Without this, a peer-controlled `total` of -1, NaN, Infinity, or 1.5 crashes the chunk-buffer constructor with a synchronous RangeError (data-loss DoS against one attachment transfer), and a peer-controlled `total`/`index` combination without index-uniqueness checking can silently produce a corrupted "complete" reassembly.
Betroffene Komponenten: RTCStore.js/.ts, ImageCrypto.js, AudioCrypto.js, App.tsx (avatar-chunk inline copy)
Angreifermodell: A paired contact (already has a live keyed DataChannel) sending malformed chunk metadata — not reachable by an unauthenticated attacker, since the message must be validly decrypted first.
Precondition: A chunked image/audio/avatar transfer is in progress.
Invariant: `total`/`index` are validated as finite non-negative integers within a MAX_CHUNKS bound before any Array allocation; `received` count increments only on first-fill-per-index, not on every incoming chunk message (preventing duplicate-index false "completion").
Violation: A crafted `total: -1`/`NaN`/`1.5e9` crashes chunk-buffer construction, or duplicate-index chunks cause a corrupted image/audio to be silently delivered as "complete."
Detection Method: SECURITY_FUZZING_CAMPAIGN.md §7 (bugs 7a/7b found, subsequently fixed per SECURITY_API_CONTRACTS_ERROR_HANDLING.md finding #8, confirmed already fixed by a concurrent session).
Automated Test: __tests__/security/fuzz.attachmentMetadata.test.js, __tests__/security/chunkBinding.test.js ("Chunk mit Index ausserhalb des gueltigen Bereichs wird ignoriert", "doppelter Index...fuehrt nicht zu falschem Erfolg")
Current Status: AUTOMATED
```

```
ID: CRYPTOGRAPHY-007
Kategorie: CRYPTOGRAPHY
Beschreibung: A relayed image/audio chunk must be cryptographically bound to the specific transfer it belongs to (imageId/audioId embedded and verified inside the authenticated plaintext, not just implied by the URL path) so a malicious relay cannot splice a previously-seen, validly-encrypted chunk from a different, older transfer between the same two contacts into a new one.
Warum wichtig: Without this binding, AEAD only proves "a legitimately encrypted chunk was produced under this shared secret at some point" — not that it belongs to the current transfer — letting a malicious relay silently corrupt a reassembled attachment while every individual AEAD check still passes.
Betroffene Komponenten: App.tsx (chunk reassembly cross-check), ImageCrypto.js/AudioCrypto.js
Angreifermodell: Malicious/compromised relay retaining chunk ciphertext from a prior legitimate transfer
Precondition: Two contacts have exchanged at least one prior image/audio (giving the relay material to splice from).
Invariant: Every chunk's embedded imageId/index is cross-checked against the end-marker's canonical imageId/total before assembly is accepted; a mismatched imageId is rejected.
Violation: A relay splices an old chunk from a different transfer into a new one and the client accepts it into the reassembled output without detecting the mismatch.
Detection Method: SECURITY_REVIEW_3 Q2 (found), fixed per SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 6 citation of App.tsx's cross-check logic.
Automated Test: __tests__/security/chunkBinding.test.js ("Chunk aus einem ANDEREN Transfer (falsche imageId) wird verworfen")
Current Status: AUTOMATED
```

---

## MESSAGING

```
ID: MESSAGING-001
Kategorie: MESSAGING
Beschreibung: A regular chat message or system-control packet delivered via the relay-fallback (`/packet`) path must be rejected as stale if its embedded timestamp is more than 15 minutes old, or more than 5 minutes in the future (clock-skew tolerance) — via a single shared isFreshTimestamp() helper, not per-call-site inline logic.
Warum wichtig: Without this, a malicious relay could replay any previously-observed, validly-encrypted packet (a stale chat message, an old delete_chat command) indefinitely; the original implementation had a fail-open bug (Infinity timestamp accepted as "fresh forever") that this invariant's current form specifically closes.
Betroffene Komponenten: App.tsx (isFreshTimestamp, checkIncoming), web/src/App.tsx (checkOfflinePackets)
Angreifermodell: Malicious/compromised relay with retained historical ciphertext
Precondition: A packet arrives via the relay-fallback /packet path.
Invariant: isFreshTimestamp(ts) requires ts to be a finite number, rejects anything >15 minutes old, and rejects anything >5 minutes in the future; all three call sites (App.tsx system-control, App.tsx regular messages, web/src/App.tsx) use this single function.
Violation: A packet with ts=Infinity, ts=NaN, or ts far in the future/past is accepted as fresh.
Detection Method: SECURITY_REVIEW_4 (found the Infinity fail-open bug, fixed it).
Automated Test: __tests__/security/replayWindow.test.js (18 tests, including the exact Infinity/-Infinity/NaN/far-future boundary cases)
Current Status: AUTOMATED
```

```
ID: MESSAGING-002
Kategorie: MESSAGING
Beschreibung: System control packets (delete_chat, secret_start, secret_end) sent via /packet must be both AEAD-encrypted AND freshness-checked before being acted on — plaintext, unauthenticated system packets must never be honored.
Warum wichtig: The original implementation (SECURITY_REVIEW_1 C-4) allowed anyone who knew a victim's contact.id to POST an unauthenticated plaintext "delete_chat" packet and silently wipe the victim's chat; encryption alone (without freshness) would still allow replay of a captured legitimate delete command.
Betroffene Komponenten: App.tsx (checkIncoming, isSystemControl handling), relay.js (/packet — stores/forwards opaquely, no content trust)
Angreifermodell: Anyone who has learned a victim's contact.id (relay operator, network observer of the original pairing) for the encryption gap; malicious relay with retained ciphertext for the replay gap
Precondition: A system-control packet is received via /packet.
Invariant: Every system-control packet must decrypt successfully under the shared secret AND pass isFreshTimestamp() before its effect (chat deletion, secret-chat state change) is applied.
Violation: A plaintext or stale-but-validly-encrypted system-control packet is acted upon.
Detection Method: SECURITY_REVIEW_1 C-4 (encryption gap, fixed); SECURITY_REVIEW_2 N-3/SECURITY_REVIEW_3 Q5 (replay gap, fixed via C-4's freshness check extension).
Automated Test: __tests__/security/replayWindow.test.js, __tests__/security/messageCrypto.tamper.test.js (indirectly, via decrypt-failure rejection)
Current Status: AUTOMATED
```

```
ID: MESSAGING-003
Kategorie: MESSAGING
Beschreibung: A regular chat message delivered live over the P2P DataChannel (not just relay-fallback) must also be subject to a freshness/replay check — the live path and the relay-fallback path must not have asymmetric replay protection for the same message type.
Warum wichtig: Prior to this fix, `type:'text'` messages had freshness checking only on the relay-fallback path; the live DataChannel path had none, meaning a replayed ciphertext captured on an actively-compromised DataChannel (e.g. via a malicious TURN data-plane) could be replayed indefinitely on that path with zero rejection.
Betroffene Komponenten: WebRTCManager.js/.ts (channel.onmessage, live-path text handling)
Angreifermodell: An attacker positioned on the DataChannel transport (compromised TURN relay)
Precondition: A `type:'text'` message arrives over the live, already-established DataChannel.
Invariant: Live-path text messages now apply the same isFreshTimestamp() check that the relay-fallback path already had, deliberately scoped to `type:'text'` only (other live-only types like dummy/ready/handshake/img_chunk don't carry a guaranteed timestamp field).
Violation: A replayed live-path text message with a stale/forged timestamp is accepted and displayed.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md fix log ("Claim 6 / Claim 3 asymmetry").
Automated Test: NONE identified by exact filename in the audit trail for this specific live-path check (covered structurally by the broader replay-protection test suite, replayWindow.test.js, which tests the shared helper function itself, not this specific call site's wiring).
Current Status: IMPLEMENTED (fix confirmed present by code citation in multiple later documents; not confirmed by a dedicated, named automated test exercising this exact live-DataChannel call site).
```

```
ID: MESSAGING-004
Kategorie: MESSAGING
Beschreibung: System-control replay protection must be sequence-aware (a monotonic high-water-mark per contact), not merely staleness-aware, on the live P2P path for secret_start/secret_end/delete_chat/transfer_ready — a captured-and-replayed secret_start within the same 15-minute freshness window as a legitimate, subsequent secret_end must be rejected.
Warum wichtig: A purely timestamp-based freshness check cannot distinguish "old and replayed" from "new but arrived out of the intended order" within the same window — without sequence-awareness, a captured secret_start replayed shortly after a legitimate secret_end can resurrect an already-intentionally-ended self-destruct timer.
Betroffene Komponenten: WebRTCManager.js (isNewerThanLastAcceptedSystemTs, native only), App.tsx (system_ts_hwm_<contactId> in EncryptedStorage)
Angreifermodell: An attacker who has captured one legitimate system-control ciphertext (via relay access before its TTL, or a compromised TURN control-channel timing side-channel)
Precondition: A system-control message for one of the four sequence-checked subtypes arrives on the live P2P path.
Invariant: isNewerThanLastAcceptedSystemTs(chatId, ts) rejects any ts at or below the last-accepted high-water-mark for that contact, persisted to the SAME storage backend the relay-fallback path's own high-water-mark uses (EncryptedStorage) — both delivery paths must share one high-water-mark, not two disjoint ones.
Violation: A replayed secret_start within the freshness window but after a legitimate secret_end is accepted because the live-path and relay-fallback-path high-water-marks are stored in different backends and never see each other's updates.
Detection Method: SECURITY_STATE_MACHINES.md §10 Finding 5 (same-path replay gap, found); SECURITY_CONCURRENCY_REVIEW.md §2.4 (cross-path storage-backend split found and fixed — App.tsx's local AsyncStorage shim vs. WebRTCManager.js's prior use of the real @react-native-async-storage/async-storage package were two disjoint stores).
Automated Test: __tests__/security/fuzz.protocolMessages.test.js ("DIFFERENTIAL-BEFUND" test — also serves as the regression test proving the cross-store fix, per SECURITY_CONCURRENCY_REVIEW.md §2.4's note that this test only began genuinely exercising the real logic after the storage-backend fix)
Current Status: AUTOMATED (native only) — web has NO equivalent sequence-aware check at all (see MESSAGING-005).
```

```
ID: MESSAGING-005
Kategorie: MESSAGING
Beschreibung: The native and web WebRTCManager implementations must apply the same replay-protection logic for the same message types on the live P2P path — a parity requirement, not a specific mechanism.
Warum wichtig: Currently VIOLATED — web/src/lib/WebRTCManager.ts's channel.onmessage has no sequence-aware replay guard at all for secret_start/secret_end/delete_chat/transfer_ready (native has isNewerThanLastAcceptedSystemTs()); currently harmless only because web doesn't yet implement these features as UI-facing functionality, but this is an explicit regression trap for whoever adds them to web next, since the natural move ("copy the native App.tsx handler") would miss the guard that actually lives in the OTHER file.
Betroffene Komponenten: web/src/lib/WebRTCManager.ts (channel.onmessage, lines ~316-336)
Angreifermodell: N/A currently exploitable (feature not implemented on web); future risk is a silent regression when the feature is added.
Precondition: A future commit adds secret_start/secret_end/delete_chat support to the web client.
Invariant (intended, not yet held): web/src/lib/WebRTCManager.ts should carry the same sequence-aware guard as native before any of these four subtypes are wired into web's UI.
Violation: web/src/App.tsx starts acting on secret_start/secret_end/delete_chat without the corresponding replay guard existing in WebRTCManager.ts.
Detection Method: SECURITY_FUZZING_CAMPAIGN.md §2+3 ("native/web parser differential", explicitly written as an intentional tripwire test).
Automated Test: __tests__/security/fuzz.protocolMessages.test.js ("DIFFERENTIAL-BEFUND" test — written to FAIL the moment someone adds the missing guard, with an explicit in-file comment instructing to update rather than delete the test at that point)
Current Status: PARTIALLY VERIFIED — the asymmetry itself is proven and monitored by a tripwire test; the underlying parity invariant is knowingly not held today.
```

```
ID: MESSAGING-006
Kategorie: MESSAGING
Beschreibung: A message pushed to the relay-fallback /packet store must survive concurrent posting without silent overwrite — the store key must not collide for two messages posted to the same recipient within the same millisecond.
Warum wichtig: The original key format (`packet_<recipient>_<Date.now()>`) collided under concurrent load, empirically losing 29-35 of 300 concurrently-sent messages (~10-12% loss rate) in live reproduction — not a rare theoretical edge case, and a malicious relay could deliberately engineer the same collision to targetedly drop specific messages.
Betroffene Komponenten: relay.js (/packet POST, store key generation)
Angreifermodell: Ordinary concurrent-load conditions (accidental); a malicious relay could also deliberately engineer this
Precondition: Two or more /packet POSTs for the same recipient arrive within the same millisecond.
Invariant: The store key includes a collision-resistant random suffix (crypto.randomBytes-derived), not just a millisecond timestamp, so concurrent packets to the same recipient never overwrite each other in the store Map.
Violation: Two concurrent POSTs to the same recipient result in only one deliverable packet.
Detection Method: SECURITY_CHAOS_TESTING.md Scenario 5 (found via both deterministic reproduction and live empirical confirmation: 300 truly-concurrent POSTs, 3 separate runs, 29/33/35 lost each time); fixed per relay.js:602 citation in SECURITY_SELF_REVIEW.md.
Automated Test: NONE with an exact filename confirmed in the read documents for the fix's own regression coverage beyond the original chaos-test reproduction script; relay.http.test.js covers general /packet behavior.
Current Status: IMPLEMENTED (fix confirmed present by direct code citation — `packet_<recipient>_<ts>_<random>` — in SECURITY_SELF_REVIEW.md §2; not confirmed here to have a dedicated collision-regression test with a specific filename).
```

```
ID: MESSAGING-007
Kategorie: MESSAGING
Beschreibung: A /packet entry must not be permanently deleted from the relay store until the client acknowledges successful processing (or a bounded grace period expires) — a bare delete-on-fetch (delete synchronously as part of serving the GET) creates a message-loss window if the client crashes/loses network between receiving the HTTP response and finishing local decrypt+persist.
Warum wichtig: Without an ack step, a message can become permanently unrecoverable (already deleted server-side, never actually stored client-side) from a single badly-timed app kill or network drop — a genuine, previously-undocumented, silent data-loss mechanism distinct from the store-key-collision bug (MESSAGING-006).
Betroffene Komponenten: relay.js (/packet GET — issues per-fetch token, marks pending not deleted, /packet/ack POST actually deletes; PACKET_ACK_GRACE_MS default 20s)
Angreifermodell: Not attacker-triggered; an ordinary reliability property. A malicious relay could also deliberately suppress redelivery by never honoring the grace-period semantics it's supposed to.
Precondition: A client fetches a /packet entry and then crashes/loses network before acknowledging it.
Invariant: An unacknowledged /packet entry becomes deliverable again after PACKET_ACK_GRACE_MS elapses (bounded double-delivery risk, traded deliberately against unbounded message-loss risk); a stale ack token (from an earlier delivery generation) must never delete the current, unacknowledged entry.
Violation: A message is permanently lost after being fetched once but never acknowledged; OR a stale ack token deletes a newer, unrelated delivery generation's entry.
Detection Method: SECURITY_STATE_MACHINES.md §7 (original message-loss finding); SECURITY_CHAOS_TESTING.md Scenario 6 (mechanism added mid-session, chaos-tested); SECURITY_CONCURRENCY_REVIEW.md §1.2 (further concurrent-ack interleavings tested: ack from 2 generations back, overlapping concurrent acks, 20-way ack storm).
Automated Test: __tests__/security/stateMachine.packetAckDurability.test.js, __tests__/security/concurrency.relayPacketAckAndPhoneRoles.test.js, __tests__/security/chaos.relayNetworkFailures.test.js
Current Status: AUTOMATED
```

```
ID: MESSAGING-008
Kategorie: MESSAGING
Beschreibung: The client-side message buffer (RTCStore.buffer) must not display a message as "sent" in the UI unless it was either actually handed to an open DataChannel or durably queued to disk — currently VIOLATED: WebRTCManager.sendMessage() returns true both when the DataChannel is genuinely open and the message was sent, AND when no shared secret exists yet and the message is merely pushed into a non-durable in-memory pendingMsgs array — the caller cannot distinguish the two, and an app kill before _flushPending() runs loses the message silently despite the UI already showing "sent".
Warum wichtig: This is a user-trust-relevant correctness gap: a user who sees "✓ sent" has a reasonable expectation the message left the device, which is not always true.
Betroffene Komponenten: WebRTCManager.js/.ts (sendMessage, pendingMsgs), App.tsx/web/src/App.tsx (message status UI)
Angreifermodell: N/A — reliability/correctness invariant, not adversarial
Precondition: A message is sent at a moment when RTCStore.isConnected() reads true (DataChannel open) but the Kyber handshake (keyExchangeDone) has not yet completed.
Invariant (intended, not currently held): sendMessage()'s return value (or a richer status) should let the caller distinguish "genuinely handed to an open, keyed channel" from "queued pending key exchange, not yet durable."
Violation: A message shown as "sent" in the UI is lost on app kill because it was only in the non-durable pendingMsgs array.
Detection Method: SECURITY_STATE_MACHINES.md §6 (found: "UI 'sent' status can be shown for a message that never left the device").
Automated Test: __tests__/security/stateMachine.sendStatusHonesty.test.js
Current Status: PARTIALLY VERIFIED — a dedicated test file exists (name strongly suggests coverage of this exact gap), but the underlying design gap itself was documented as "not fixed" in the source finding; status reflects that the test's presence indicates active tracking/partial hardening, not full closure. Treat as requiring direct re-verification of the test's assertions before relying on this status.
```

---

## P2P

```
ID: P2P-001
Kategorie: P2P
Beschreibung: The relay must never be a party to the ML-KEM-768 key-exchange messages (kyber_pubkey/kyber_ciphertext) themselves — these are exchanged exclusively over the already-established WebRTC DataChannel, never through relay.js, even when the DataChannel is the relay-fallback-established one.
Warum wichtig: This is the system's core soundness property: even total relay compromise (full plaintext logging of every packet it ever forwarded) does not yield message plaintext, because the value that would let it decrypt anything (the shared secret) is never transmitted through it in a recoverable form.
Betroffene Komponenten: WebRTCManager.js/.ts (_setupDataChannel, channel.onopen/onmessage)
Angreifermodell: Fully malicious relay operator
Precondition: A WebRTC DataChannel has been established (P2P or TURN-relayed).
Invariant: kyber_pubkey/kyber_ciphertext are sent exclusively via dataChannel.send(), never via any relay.js HTTP/WS route.
Violation: A Kyber public key or ciphertext is POSTed to any relay.js endpoint.
Detection Method: Code reading confirming the exchange happens purely inside channel.onopen/onmessage (SECURITY_REVIEW_3 Q3).
Automated Test: NONE directly asserts "never sent via HTTP"; implicitly covered by the fact that no relay.js route accepts a field named kyber_pubkey/kyber_ciphertext/publicKey/cipherText for message routing.
Current Status: PROVEN
```

```
ID: P2P-002
Kategorie: P2P
Beschreibung: The Safety Code (SHA-256 of the negotiated shared secret, rendered as 16 grouped digits) must correctly and deterministically diverge between two victims of an active MITM'd Kyber exchange (i.e., it must be a genuinely sound, if unenforced, MITM-detection primitive).
Warum wichtig: This is the only mechanism in the app that could catch a successful active MITM (SESSION-006-class attacks) if a user actually compared codes out-of-band with their contact.
Betroffene Komponenten: WebRTCManager.js/.ts (_computeSafetyCode), KyberModule.kt (sha256 bridge method)
Angreifermodell: An active MITM splicing two independent Kyber exchanges
Precondition: A Kyber exchange has completed (possibly MITM'd).
Invariant: _computeSafetyCode() is a deterministic hash of the actual negotiated sharedSecret; if a MITM substituted a different keypair with each victim, each victim's computed code reflects a genuinely different underlying secret and will visibly not match on comparison.
Violation: Two parties to a genuine (non-MITM'd) pairing compute different Safety Codes, or an active MITM produces matching codes for both victims.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 5 ("PROVEN correct as a computation").
Automated Test: NONE — the computation's soundness is established by code reading (SHA-256 of the real negotiated secret, same input representation on both platforms), not by a dedicated MITM-simulation test.
Current Status: PROVEN (as a computation only — see P2P-003 for the separate, unheld "is it actually used" property).
```

```
ID: P2P-003
Kategorie: P2P
Beschreibung: The Safety Code must be surfaced to the user and its change flagged whenever the underlying secret changes outside a user-initiated action — currently PARTIALLY held: both native and web now persist the last-acknowledged Safety Code and show a red-badge/warning when the freshly-computed code differs, but verification remains entirely opt-in (nothing forces a first-contact comparison), and this fix does not make comparison mandatory.
Warum wichtig: Before this partial fix, the Safety Code changed silently on every legitimate reconnect (a real, expected event per SESSION-001) with zero signal to the user — making the one MITM-detection mechanism the app has "functionally close to theater," since a user has no reason to suspect anything changed.
Betroffene Komponenten: App.tsx (safetyChanged state, shield-icon badge), web/src/App.tsx
Angreifermodell: An active MITM whose splice would otherwise go undetected because nothing prompts comparison
Precondition: A Safety Code has been previously acknowledged for a contact, and a new key exchange (legitimate reconnect OR MITM) produces a different one.
Invariant: A change in the computed Safety Code from the last-acknowledged value produces a visible UI signal (red badge + in-modal warning) on both platforms; the dialog itself remains opt-in to open.
Violation: A Safety Code change (legitimate or MITM'd) produces no UI signal at all.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 5 fix log ("Safety Code changes silently on every reconnect with no user signal" — fixed, partial, UX-level).
Automated Test: NONE identified with an exact filename in the audit trail for the badge/warning UI logic specifically.
Current Status: PARTIALLY VERIFIED — the change-detection signal is implemented (per code citation) but not covered by a named automated test, and mandatory first-contact verification remains explicitly unimplemented.
```

```
ID: P2P-004
Kategorie: P2P
Beschreibung: Cover traffic (fixed-shape dummy packets sent every ~3s on the live DataChannel) must defeat size-based traffic analysis for real-time P2P chat specifically — real chat messages must be padded to the same fixed block size as the dummy packets.
Warum wichtig: Without uniform padding, a relay or network observer positioned to see DataChannel traffic shape (not content) could distinguish real messages from cover traffic, or infer message length, purely from packet size.
Betroffene Komponenten: WebRTCManager.js/.ts (_startCoverTraffic, padToBlock, PAD_BLOCK_SIZE=512 bytes, COVER_INTERVAL_MS=3s)
Angreifermodell: A network/relay observer positioned to see live P2P DataChannel packet sizes and timing (e.g. via TURN relay if P2P direct connection isn't achieved)
Precondition: A live P2P DataChannel session with cover traffic active.
Invariant: Real chat messages sent via sendMessage() on the live DataChannel are padded to the same fixed PAD_BLOCK_SIZE as dummy cover-traffic packets before encryption.
Violation: A real message's ciphertext length is distinguishable from a dummy cover-traffic packet's length.
Detection Method: SECURITY_REVIEW_5 finding 5, SECURITY_ARCHITECTURE_THREAT_MODEL.md §4.2 (confirmed the padding is real and effective for exactly this narrow scope, and explicitly NOT applied to the /packet offline-fallback path, /transfer chunk uploads, or reconnect/signal/call-signal SDP blobs).
Automated Test: NONE identified with an exact filename for the padding logic itself.
Current Status: IMPLEMENTED — confirmed present and correctly scoped by code reading across two independent audit passes; not covered by a named automated test. Scope is explicitly narrow: does NOT extend to offline messages, attachments, or signaling.
```

```
ID: P2P-005
Kategorie: P2P
Beschreibung: The routing/rendezvous identifier generated for a new pairing (contactId, derived from a truncated Kyber-pubkey-derived token) must use a cryptographically secure random source and sufficient entropy to make collision/grinding attacks impractical.
Warum wichtig: The QR-pairing contactId is only an 8-hex-character (32-bit) truncation, and the phone-connect flow's `myId` generator uses Math.random() (non-CSPRNG) — both create a genuine, if bounded, collision/prediction surface a moderately-resourced malicious relay could exploit to intermix or hijack two unrelated pairings' reconnect/call/push queues.
Betroffene Komponenten: App.tsx (generateContactId at ~line 77-93 — the fixed, secure generator; the QR-pairing token truncation at ~2809-2811; the phone-connect myId generator using Math.random() at ~2644, which was NOT updated to match the fixed generator)
Angreifermodell: A malicious relay grinding Kyber keypairs offline to force a contactId collision with a targeted victim, or exploiting the low-entropy phone-connect myId
Precondition: A new QR or phone-connect pairing is created.
Invariant (intended, NOT fully held): every contactId-equivalent identifier should be generated via the same CSPRNG-backed generateContactId() with at least 128 bits of entropy; currently the QR-pairing token is a 32-bit truncation and the phone-connect myId uses Math.random().
Violation: Two unrelated pairings' reconnect/call/push queues collide under this identifier, or an attacker forces such a collision via offline grinding.
Detection Method: SECURITY_REVIEW_3 Q4 Finding B (found, not fixed — explicitly still open per every later audit pass that cites it).
Automated Test: NONE
Current Status: UNVERIFIED — known, documented, unfixed gap.
```

```
ID: P2P-006
Kategorie: P2P
Beschreibung: A losing connection in a reconnect race (two overlapping reconnect attempts for the same contact both completing) must not be able to corrupt the winning connection's shared secret or leak a resource — RTCStore.setConnection()'s supersede-and-close path must close the losing WebRTCManager instance deterministically, and (per SESSION-003) a delayed in-flight handshake on the losing instance must not resurrect/overwrite the winner's state.
Warum wichtig: Without this, "last handshake to finish wins" nondeterminism could let a stale/attacker-influenced connection attempt silently overwrite a legitimately-established session's key material.
Betroffene Komponenten: RTCStore.js/.ts (setConnection), WebRTCManager.js/.ts (_closed guard, reused from SESSION-003)
Angreifermodell: An attacker able to trigger or race a competing reconnect attempt
Precondition: Two reconnect attempts for the same contact overlap in time.
Invariant: The losing WebRTCManager instance is closed via the same close()/_closed mechanism that protects against the wipe/delete race (SESSION-003); its in-flight handshake, if any, resumes into a no-op rather than corrupting RTCStore.sharedSecrets.
Violation: A losing reconnect attempt's delayed handshake overwrites the winning connection's shared secret.
Detection Method: SECURITY_STATE_MACHINES.md §4 Finding 8 (original "orphaned connection" framing); SECURITY_HIDDEN_BUG_HUNT.md Part 2 ("Related code paths checked" — confirms this variant is closed by the same _closed guard, by inspection, not a dedicated test).
Automated Test: NONE with a dedicated test name for this specific reconnect-race variant (covered "by inspection" per the source document, reusing SESSION-003's tests' coverage of the same guard mechanism).
Current Status: PARTIALLY VERIFIED — the guard mechanism is automated-tested for its primary trigger (wipe/delete), and confirmed by code inspection (not a dedicated test) to also cover this reconnect-race variant.
```

---

## NETWORK

```
ID: NETWORK-001
Kategorie: NETWORK
Beschreibung: TURN credentials must be short-lived (6-hour TTL) and derived via HMAC over a server-only secret (TURN_SECRET), never a static/hardcoded shared password.
Warum wichtig: A static TURN password would be a durable, high-value secret; short-lived HMAC-derived credentials bound this exposure window and match the standard, audited coturn `--use-auth-secret` deployment pattern.
Betroffene Komponenten: relay.js (/turn-credentials)
Angreifermodell: Anyone who obtains one set of TURN credentials
Precondition: A client requests TURN credentials for NAT traversal.
Invariant: Every /turn-credentials response is a fresh HMAC-SHA1(TURN_SECRET, username) credential valid for at most 6 hours; TURN_SECRET itself never leaves the server.
Violation: A hardcoded or long-lived TURN password is used, or TURN_SECRET is exposed to a client.
Detection Method: SECURITY_REVIEW_1 (explicitly checked and confirmed sound, called out as a positive finding, second-pass-confirmed).
Automated Test: NONE identified with an exact filename.
Current Status: PROVEN (by code reading)
```

```
ID: NETWORK-002
Kategorie: NETWORK
Beschreibung: The TURN control channel (STUN/TURN allocation/permission/channel-bind signaling, distinct from the DTLS-SRTP-protected media itself) should be encrypted (TURNS, TLS/DTLS on port 5349) by default — currently PARTIALLY held: coturn-setup.sh now provisions TURNS reusing the relay's own certificate, but the plaintext port 3478 remains open "for compatibility" and nothing forces TURNS-only.
Warum wichtig: The original deployment script explicitly set no-tls/no-dtls (an active choice, not an oversight), exposing control-channel metadata (which peer IP:port pairs are being relayed, for how long) in cleartext; the fix narrows but does not eliminate this.
Betroffene Komponenten: coturn-setup.sh, WebRTCManager.js/.ts, CallManager.js (TURN_HOST configuration)
Angreifermodell: A network observer positioned to see traffic to/from the TURN server's control port
Precondition: A call/P2P connection requires TURN relay (NAT traversal failure).
Invariant (partially held): TURNS (port 5349, TLS/DTLS) is available; the intended future state (SECURITY_ARCHITECTURE_BACKLOG.md B1, P0) is TURNS-only by default with plaintext 3478 as an explicit opt-in, not the default — NOT YET implemented.
Violation: TURN control-channel metadata is observable in cleartext by a network attacker in the default deployment.
Detection Method: SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 7 (found no-tls/no-dtls was explicit); SECURITY_ARCHITECTURE_THREAT_MODEL.md §1.5 (fix status: mitigated, not eliminated).
Automated Test: NONE
Current Status: PARTIALLY VERIFIED — TURNS capability added; TURNS-only default not implemented (tracked as backlog item B1, P0 priority, not yet done).
```

```
ID: NETWORK-003
Kategorie: NETWORK
Beschreibung: DTLS-SRTP (WebRTC's own built-in media encryption) must protect live call audio/video regardless of the classical (non-post-quantum) nature of its underlying key exchange — this is a distinct guarantee from the app's own ML-KEM-768-derived message encryption, and must not be conflated with it in any user-facing claim.
Warum wichtig: The app's UI correctly and explicitly labels calls as "WebRTC · DTLS-SRTP" rather than claiming post-quantum protection for call media — this precision must be preserved; overclaiming PQ coverage for calls would be a false security claim.
Betroffene Komponenten: WebRTCManager.js/.ts (RTCPeerConnection media tracks), App.tsx (call screen UI label)
Angreifermodell: A future quantum-capable adversary (relevant only to the PQ-scope claim, not to today's confidentiality)
Precondition: A call is in progress.
Invariant: The app's UI/documentation must state that call MEDIA confidentiality is provided by classical WebRTC DTLS-SRTP, not by the app's own ML-KEM-768 layer — only call SIGNALING (SDP/ICE) benefits from the app's own E2E encryption.
Violation: UI or documentation claims "post-quantum encrypted calls" without this distinction.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 2/4 (confirmed the UI's own label, App.tsx:2634/2635, is accurate and doesn't overclaim).
Automated Test: NONE
Current Status: PROVEN (as an accurate current UI claim, re-verified against code)
```

```
ID: NETWORK-004
Kategorie: NETWORK
Beschreibung: Call signaling (SDP/ICE exchanged via /call/signal) must fail closed, not fail open to plaintext, if no shared secret is available at call time.
Warum wichtig: Prior to the fix (SECURITY_REVIEW_1 H-2), a missing cached secret caused CallManager to silently send SDP/ICE in the clear while still placing the call, with only a console.warn — allowing a malicious relay to swap the DTLS fingerprint and MITM the call's media in exactly the scenario the encryption was added to prevent.
Betroffene Komponenten: CallManager.js (_sendSignal, handleSignal)
Angreifermodell: Malicious/compromised relay
Precondition: A call is placed to a contact with no currently-cached shared secret (e.g. a freshly-paired contact who hasn't exchanged a text message yet).
Invariant: _sendSignal() throws/aborts the call (`Kein sicherer Kanal...`) rather than falling back to plaintext when no secret is cached; handleSignal() rejects any incoming signal lacking an encrypted .payload.enc field.
Violation: A call's SDP/ICE is sent or accepted in plaintext.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 4 (confirmed fixed, explicitly correcting SECURITY_REVIEW_2's stale "still open" verdict for the same finding — a documented discrepancy between two prior audit passes, resolved in the later one's favor by direct code re-reading).
Automated Test: NONE identified with an exact filename for this specific fail-closed call-signal behavior.
Current Status: IMPLEMENTED (confirmed via direct code citation, CallManager.js:428-441/230-248; not covered by a named automated test in the audit trail).
```

---

## METADATA

```
ID: METADATA-001
Kategorie: METADATA
Beschreibung: The live relay process always has full, real-time knowledge of every connecting client's raw IP address, regardless of any log-hygiene fix (hashIp()/PRIVACY-002) — this must be understood precisely as a log-hygiene control, not an IP-minimization control, and must not be described (in code comments, documentation, or user-facing claims) as reducing the relay's own real-time visibility.
Warum wichtig: Over-crediting hashIp() as "the relay doesn't know your IP" would be a materially false claim; the relay computes the HMAC FROM the real source IP, in the same process, at the same instant — the fix only narrows what a later log-file reader (without the process's in-memory secret) can reconstruct.
Betroffene Komponenten: relay.js (hashIp, header comment, /status endpoint)
Angreifermodell: The relay operator/process itself (this invariant states what the relay CAN always do, not a violation to prevent)
Precondition: Any client connects to the relay.
Invariant: relay.js's own comments and /status endpoint must accurately describe hashIp() as log-hygiene, not real-time IP-minimization (fixed this session per SECURITY_ARCHITECTURE_FINDINGS_ADDRESSED.md §4).
Violation: A comment or user-facing string claims the relay itself doesn't know a connecting client's IP.
Detection Method: SECURITY_ARCHITECTURE_THREAT_MODEL.md §4.3 (precise distinction drawn); relay.js header/comment fix confirmed.
Automated Test: NONE (documentation-accuracy invariant)
Current Status: PROVEN (as an accurate current description, post-fix)
```

```
ID: METADATA-002
Kategorie: METADATA
Beschreibung: The single relay/signaling/discovery/TURN-credential-issuer process (relay.js) must be understood and documented as ONE trust boundary wearing four functional hats — not as four independently-compromisable services — in every architectural claim made about this system.
Warum wichtig: Compromising "the signaling server" is not a smaller event than compromising "the relay" — they are the same process, same operator, same failure domain; documentation that implies otherwise would understate the real blast radius of a relay compromise.
Betroffene Komponenten: relay.js (header comment, "EIN PROZESS, VIER ROLLEN" section added this session)
Angreifermodell: A relay operator or anyone who compromises relay.js
Precondition: N/A — architectural fact.
Invariant: relay.js's header comment explicitly states this consolidation; no documentation describes rendezvous/signaling/discovery/TURN-issuance as independently-trustable services.
Violation: Documentation or code comments imply that compromising one of the four roles doesn't imply compromising the others.
Detection Method: SECURITY_ARCHITECTURE_THREAT_MODEL.md §1.7/§1.13 (found and named); SECURITY_ARCHITECTURE_FINDINGS_ADDRESSED.md §1 (fix confirmed: header comment added).
Automated Test: NONE
Current Status: PROVEN (documentation-accuracy fix confirmed present)
```

```
ID: METADATA-003
Kategorie: METADATA
Beschreibung: The relay must not be described (in code, comments, or the app's own UI/dev-comment language) as providing genuine relationship-graph privacy ("Zero-Knowledge" in the informal sense) — it structurally CAN reconstruct the complete pairing/relationship graph in real time from legitimately-required routing metadata (phone-hash rendezvous, contactId-tagged requests, WS-subscribe contact-set binding) without breaking any cryptography.
Warum wichtig: This is the single most consequential "claims vs. reality" gap identified across the whole audit trail — conflating "the relay cannot read content" (true) with "the relay cannot reconstruct relationships" (false) materially overstates the app's privacy properties to end users.
Betroffene Komponenten: relay.js (/phone/register, /phone/lookup, WS subscribe), App.tsx (phone-connect UI string)
Angreifermodell: The relay operator itself, purely via metadata correlation, no cryptographic break required
Precondition: Any pairing/reconnect/call activity occurs.
Invariant: User-facing strings and developer comments must name the specific property actually held ("hash-based rendezvous, not a formal zero-knowledge proof or a relationship-graph-hiding guarantee") rather than the blanket term "Zero-Knowledge" — partially fixed this session (App.tsx phone-connect string and relay.js /phone/register comment reworded per SECURITY_ARCHITECTURE_FINDINGS_ADDRESSED.md §2).
Violation: A user-facing or developer-facing string claims "Zero-Knowledge" without the caveat that the relay can still correlate relationship-graph metadata.
Detection Method: SECURITY_ARCHITECTURE_THREAT_MODEL.md Part 2 (full zero-knowledge property matrix, §2.2/§2.3); fix confirmed for two specific strings, not exhaustively for every occurrence.
Automated Test: NONE
Current Status: PARTIALLY VERIFIED — two known occurrences fixed this session; not exhaustively swept for every instance of the term across the codebase.
```

```
ID: METADATA-004
Kategorie: METADATA
Beschreibung: The WebSocket wake-signal's `{subscribe: [contactId,...]}` message binds an entire contact set to one IP address at the instant of a single WS handshake — this is a consciously accepted, explicitly documented trade-off (faster/more certain correlation than gradual reveal via polling), not a bug, but must remain explicitly documented as such and must not silently expand in scope.
Warum wichtig: Understating this trade-off's speed/certainty (vs. the slower correlation polling would allow) would leave operators/users with a falsely optimistic privacy model.
Betroffene Komponenten: relay.js (WS subscribe handler, ~line 876-889, wakeSubs, ws._ip)
Angreifermodell: The relay operator, correlating IP to contact-graph via one WS connection
Precondition: A client opens the wake WebSocket and sends a subscribe message.
Invariant: The subscribe payload contains exactly the contact IDs being subscribed to and nothing else (no additional fields); this is documented in the push-notification architecture plan and relay.js's own comment as an accepted trade-off.
Violation: The subscribe mechanism silently expands to reveal additional metadata beyond the contact-ID set, or the accepted-trade-off framing is removed from documentation without a corresponding mitigation.
Detection Method: SECURITY_REVIEW_5 finding 3; SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 5 (independently re-derived, confirmed nothing worse than already reported).
Automated Test: NONE
Current Status: PROVEN (as an accurately-scoped, documented, accepted trade-off — not a violation to fix)
```

```
ID: METADATA-005
Kategorie: METADATA
Beschreibung: `/phone/lookup` "not found" responses must be rate-limited per IP to bound phone-number-pair enumeration, even though they cannot be eliminated entirely without a PAKE/OPRF redesign.
Warum wichtig: Without any throttle, an attacker with a set of candidate phone-number pairs could freely enumerate which pairs are "currently attempting to connect on Malachi" — a real presence/contact-discovery side channel; the throttle bounds but does not close this.
Betroffene Komponenten: relay.js (phoneLookupMisses counter, 20 misses/5min/IP cap, escalating into the general registerFail/blockedIPs machinery)
Angreifermodell: An attacker probing candidate phone-number-pair hashes
Precondition: Repeated /phone/lookup calls for hashes that are not (yet) registered.
Invariant: A dedicated phoneLookupMisses counter (independent from the general registerFail counter) escalates after 20 misses/5min per IP.
Violation: /phone/lookup misses are never rate-limited, allowing unbounded single-IP enumeration.
Detection Method: SECURITY_REVIEW_5 finding 6 (found, unthrottled); fix #5 in the same document's follow-up pass.
Automated Test: __tests__/security/relay.http.test.js (3 new tests covering both the normal case and the escalation path, per SECURITY_REVIEW_5's fix log)
Current Status: AUTOMATED (for the throttle itself; the underlying enumeration channel is explicitly acknowledged as only slowed, not closed — tracked under SECURITY_ARCHITECTURE_BACKLOG.md A2, needs a PAKE/OPRF redesign for full closure)
```

---

## STORAGE

```
ID: STORAGE-001
Kategorie: STORAGE
Beschreibung: shared_secret_<chatId> and chat_<chatId> (message history) must be persisted through the platform's genuine encrypted-storage layer — Android Keystore-backed EncryptedSharedPreferences (native) or PIN+pepper-derived AES-256-GCM (web) — never a plaintext store.
Warum wichtig: This is the baseline "encrypted at rest" property the app's data-at-rest claims depend on.
Betroffene Komponenten: App.tsx/RTCStore.js (EncryptedStorage.setItem), web/src/lib/Storage.ts, WebRTCManager.js/.ts
Angreifermodell: Anyone with plain filesystem access to the device (ADB backup on debuggable/rooted device, physical extraction) who does NOT also control the Keystore/pepper
Precondition: A session secret or chat message is persisted.
Invariant: Every call site persisting these values uses EncryptedStorage (native)/Storage.ts's setItem (web), never AsyncStorage-as-real-plaintext or raw localStorage.
Violation: A shared secret or chat message is found in a plaintext store.
Detection Method: SECURITY_SECRETS_LIFECYCLE.md §9 (full cross-check table of every persisted secret-shaped value against its storage layer).
Automated Test: NONE directly; indirectly covered by __tests__/security/chaos.corruptedState.test.js exercising the storage layer's shape
Current Status: PROVEN
```

```
ID: STORAGE-002
Kategorie: STORAGE
Beschreibung: On native, if EncryptedSharedPreferences.create() throws for any reason (corrupted Keystore entry, OS bug, certain custom ROMs), the react-native-encrypted-storage library silently falls back to plain, unencrypted SharedPreferences (MODE_PRIVATE only) with zero warning to the app/JS layer/user — this is a known, unfixed, third-party-dependency-level gap, not a property this app's own code currently detects or defends against.
Warum wichtig: Every subsequent EncryptedStorage.setItem call (including shared_secret_<id>) would then write the raw Kyber-derived shared secret to disk in PLAINTEXT XML, readable via any plain filesystem access, with no PIN/Keystore/encryption at all — disproving an unqualified "encrypted at rest" guarantee.
Betroffene Komponenten: node_modules/react-native-encrypted-storage (RNEncryptedStorageModule.java:37-40, third-party dependency)
Angreifermodell: Anyone with plain filesystem access, on a device where this fallback has silently triggered
Precondition: EncryptedSharedPreferences.create() throws in the native module.
Invariant (intended, NOT currently held): the app should detect and surface this degraded state (e.g. via an isEncrypted() query) rather than silently writing plaintext secrets to disk under the same storage API.
Violation: A shared secret or chat message is found in plaintext SharedPreferences XML after this fallback triggered.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 7 (full read of the third-party module's source, found the fail-open catch block).
Automated Test: NONE — cannot be triggered/verified outside a real device with a deliberately corrupted Keystore entry (NOT TESTABLE UNDER JEST, confirmed by two independent audit passes).
Current Status: UNVERIFIED — known, documented, deliberately-deferred gap (a patch to a third-party dependency was judged too risky to ship without the ability to test the failure path).
```

```
ID: STORAGE-003
Kategorie: STORAGE
Beschreibung: On web, the local encryption key (dek) must be derivable ONLY from PIN + a live, rate-limited, server-issued pepper — never from localStorage contents alone — so that an attacker who obtains only a copy of localStorage cannot brute-force the PIN offline.
Warum wichtig: This is the specific, load-bearing defense against the "stolen device/backup/malware" threat the web pepper mechanism exists to close (the native platform has no equivalent, relying instead on Android Keystore per STORAGE-001/DEVICE-003).
Betroffene Komponenten: web/src/lib/Storage.ts (deriveKey, PBKDF2 210,000 iterations over pin+':'+pepper)
Angreifermodell: An attacker with a copy of the victim's localStorage (stolen laptop, malware, browser-profile backup) but WITHOUT live relay access
Precondition: An attacker has obtained a localStorage dump.
Invariant: pepper is never written to localStorage (only SALT_KEY/MARKER_KEY/DEVICE_ID_KEY are persisted locally); deriveKey() requires pepper as an input that can only be obtained from a live, rate-limited /pepper/request call.
Violation: The dek (or a value sufficient to derive it) is recoverable from localStorage contents alone.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Claim 8 (confirmed via full grep of Storage.ts — no pepper value ever stored client-side).
Automated Test: __tests__/security/stateMachine.storageUnlockRace.test.js (indirectly, via corrupted-storage/unlock-flow tests), __tests__/security/chaos.corruptedState.test.js
Current Status: PROVEN client-side; conditional on the server-side pepper rate-limiter itself holding (a separate, explicitly out-of-scope-for-this-claim assumption — see STORAGE-004/RECOVERY-001).
```

```
ID: STORAGE-004
Kategorie: STORAGE
Beschreibung: The relay's /pepper/request endpoint must never hand the raw pepper to a caller who hasn't already passed a rate-limited, server-enforced check — the fail-counter must be incremented server-side regardless of client honesty, not rely on the client calling /pepper/fail.
Warum wichtig: The original design let any attacker who had the client-generated, locally-stored deviceId fetch the pepper once (without calling /pepper/fail on subsequent offline guesses), fully defeating rate-limiting; the current design requires a mandatory attemptToken with a 30s window and rotates the pepper on every successful unlock, but the underlying trust gap (an attacker-controlled client can call /pepper/success instead of /pepper/fail after a wrong guess, self-resetting its own fail counter) remains open by the code's own honest admission — full closure needs a real PAKE/OPRF, deliberately not hand-rolled.
Betroffene Komponenten: relay.js (/pepper/request, /pepper/fail, /pepper/success, pendingToken/pendingExpiresAt mutex)
Angreifermodell: An attacker with a copy of localStorage (has deviceId) attempting to bypass server-side rate-limiting
Precondition: An attacker calls /pepper/request with a stolen deviceId.
Invariant (partially held): a pendingToken/pendingExpiresAt mutex enforces exactly one in-flight attempt per deviceId, an unresolved pendingToken counts as an implicit fail, and the pepper rotates on every successful unlock — but an attacker who calls /pepper/success (not /pepper/fail) after their own wrong guess can still reset their own fail counter, since the server does not itself verify the PIN.
Violation: An attacker bypasses the 5-attempt lockout by self-reporting fake successes, OR obtains the pepper without any rate-limit gate at all (the original, now-fixed bug).
Detection Method: SECURITY_REVIEW_1 C-3 (original bug, fixed); residual gap explicitly and honestly documented in the code's own comment, re-confirmed still open by every later audit pass (SECURITY_REVIEW_4, SECURITY_STATE_MACHINES.md §5, SECURITY_ARCHITECTURE_BACKLOG.md A2).
Automated Test: __tests__/security/relay.http.test.js (mutex, rotation, forged-token-rejection all covered — "pepper/fail rejecting a forged attemptToken", 31-second real-time TTL-expiry test)
Current Status: PARTIALLY VERIFIED — the client-honesty bypass (original C-3 bug) is AUTOMATED-fixed and tested; the self-reported-success residual gap remains UNVERIFIED/open by design, pending a PAKE/OPRF redesign not attempted per the no-home-grown-crypto constraint.
```

```
ID: STORAGE-005
Kategorie: STORAGE
Beschreibung: A wipe (5-fail lockout, PIN-forgotten) or a chat-delete must purge in-memory (not just on-disk) secret and plaintext state — the live RTCStore/RTCStore.ts singleton (connections, sharedSecrets, buffer, and on native audioBuffer/imgBuffer/pendingAvatars) must be fully cleared, and every live WebRTCManager connection explicitly closed, not merely orphaned to eventual garbage collection.
Warum wichtig: Before this fix, a "wiped" device's still-open WebRTC connection kept running cover traffic and could continue receiving, decrypting, and buffering new plaintext using session key material the wipe was supposed to destroy — directly contradicting the wipe's own user-facing promise ("your data is gone").
Betroffene Komponenten: RTCStore.js/.ts (resetAll, clearContact), App.tsx (5-fail wipe branch), web/src/App.tsx (onUnlock 'wiped' case)
Angreifermodell: A forensic tool dumping process memory immediately after a "successful" wipe, or an attacker deliberately triggering the wipe to observe what stays resident
Precondition: A 5-fail wipe or chat-delete occurs while the JS process continues running (no process restart happens on either path).
Invariant: resetAll()/clearContact() close every live WebRTCManager connection and clear connections/sharedSecrets/buffer/listeners (and, native-only, audioBuffer/imgBuffer/pendingAvatars/pendingAvatarExpected/profileSent) before or as part of the wipe/delete completing.
Violation: A "wiped" or "deleted" contact's session secret or buffered plaintext remains reachable in RTCStore after the operation completes.
Detection Method: SECURITY_SECRETS_LIFECYCLE.md Finding S-1 (5-fail wipe) and S-3 (chat-delete) — both found, both fixed per SECURITY_SECRETS_LIFECYCLE_FIXES.md Fix 2/Fix 4.
Automated Test: __tests__/security/stateMachine.rtcStoreWipeLifecycle.test.js (populates both singletons with live data, asserts resetAll()/clearContact() empties everything and every connection's close() was actually invoked, including when one connection's close() throws)
Current Status: AUTOMATED (for the base mechanism; see SESSION-003 for the additional, separately-tracked race condition where an in-flight handshake at the moment of wipe/delete could still resurrect a secret — now also closed and tested).
```

```
ID: STORAGE-006
Kategorie: STORAGE
Beschreibung: Raw, unencrypted voice-message recording files must not persist on disk indefinitely — they must be deleted after send, after explicit cancel, and their transient playback/preview copies cleaned up even on error paths.
Warum wichtig: Before this fix, every voice message ever recorded (sent or cancelled) left a permanent, unencrypted .mp4 file on disk, bypassing both AsyncStorage and EncryptedStorage entirely and surviving chat deletion and the full 5-fail wipe — the single most severe on-disk finding in the secrets-lifecycle audit.
Betroffene Komponenten: App.tsx (startRecording/stopRecording/sendAudioPreview, playAudio)
Angreifermodell: Anyone with plain filesystem access to the device, including after the user believes all data was wiped/deleted
Precondition: A user records a voice message (sent or cancelled).
Invariant: sendAudioPreview() unlinks the raw recording path after use; the cancel button unlinks it before clearing preview state; playAudio()'s temp file is unlinked on both success and error paths, plus a best-effort unlink in the outer catch.
Violation: A malachi_<timestamp>.mp4 recording file persists on disk after the message was sent, the recording was cancelled, the chat was deleted, or the device was wiped.
Detection Method: SECURITY_SECRETS_LIFECYCLE.md Finding S-5 (found: 6 total unlink call sites, none referenced the recording path); fixed per SECURITY_SECRETS_LIFECYCLE_FIXES.md Fix 3.
Automated Test: NONE — explicitly not unit-tested (driving startRecording/stopRecording/sendAudioPreview/playAudio requires mocking the native Recorder/Player classes, for which no existing test harness exists in this repo); fixed via manual code trace and re-grep verification only.
Current Status: IMPLEMENTED — fix confirmed present by direct code citation, explicitly NOT covered by any automated test.
```

---

## RECOVERY

```
ID: RECOVERY-001
Kategorie: RECOVERY
Beschreibung: There is no path to recover a forgotten PIN (native) or PIN+pepper (web), and no path to recover a lost shared secret with a contact, other than a full local wipe followed by fresh re-pairing — this is an explicit, deliberate design choice (the same property that also makes the 5-fail wipe meaningful against an adversarial device-holder), not a gap to be closed casually.
Warum wichtig: Any recovery mechanism necessarily creates a bypass path for the same "no recovery" property that currently blocks attackers too — adding one without an independent cryptography review (per SECURITY_ARCHITECTURE_BACKLOG.md A5) would silently weaken the wipe/lockout guarantees this catalog documents elsewhere.
Betroffene Komponenten: App.tsx (LockScreen 5-fail wipe), web/src/lib/Storage.ts (unlockEncryption 5-fail wipe)
Angreifermodell: N/A — architectural; the "attacker" this protects against is anyone brute-forcing the PIN on a stolen/seized device
Precondition: N/A.
Invariant: No backup-code, recovery-phrase, or third-party-escrow feature exists anywhere in the repo (grep-confirmed, zero matches for recover/prekey/backup.?code/Wiederherstellung outside audit docs).
Violation: A "forgot my PIN" feature is added that restores access without a full wipe, without going through a dedicated cryptography review.
Detection Method: SECURITY_SECRETS_LIFECYCLE.md §8 (explicitly checked, not assumed).
Automated Test: NONE
Current Status: PROVEN
```

```
ID: RECOVERY-002
Kategorie: RECOVERY
Beschreibung: The native 5-fail PIN wipe must be exhaustive — it must clear the ENTIRE AsyncStorage/EncryptedStorage namespace (not a curated key list) plus queued media files, so that no shared_secret_<id>, chat_<id>, or other secret-shaped value survives.
Warum wichtig: An incomplete wipe (a curated key list that misses a newly-added storage key) would leave residual secret material recoverable after the user was told "your device was reset."
Betroffene Komponenten: App.tsx (LockScreen, att>=5 branch)
Angreifermodell: An adversary who has been brute-forcing the PIN on a stolen/seized device and later extracts filesystem contents after the wipe fired
Precondition: 5 consecutive wrong PIN attempts.
Invariant: The wipe calls AsyncStorage.multiRemove([...]) + AsyncStorage.clear() + a per-key EncryptedStorage.removeItem() loop + EncryptedStorage.clear() (unconditional, not a curated subset) + queued-media-file deletion.
Violation: Any secret-shaped value (shared_secret_<id>, app_pin, chat_<id>) is recoverable from disk after the wipe completes.
Detection Method: SECURITY_STATE_MACHINES.md §9 (confirmed exhaustive by reading the explicit .clear() calls, not just the curated multiRemove list).
Automated Test: NONE with an exact filename directly asserting full post-wipe disk-state emptiness (covered indirectly by stateMachine.rtcStoreWipeLifecycle.test.js for the in-memory half, per STORAGE-005).
Current Status: PROVEN (for the on-disk half, by code reading); the in-memory half is separately covered by STORAGE-005/SESSION-003.
```

```
ID: RECOVERY-003
Kategorie: RECOVERY
Beschreibung: When a device wipes (5-fail lockout), it should make a best-effort attempt to notify every contact it still holds a live secret for (via an encrypted device_wiped tombstone) BEFORE the local secret/contact data is destroyed — a malicious relay cannot forge this notice (it never holds the required shared secret) but CAN suppress it (drop it outright, or delay it past the 15-minute freshness window), which is an accepted, documented residual risk, not a violation of this invariant's authenticity guarantee.
Warum wichtig: Without any notification attempt, every paired contact's device is left silently retrying reconnects against a now-permanently-dead pairing for up to 33 days with zero user-facing error, and risks a confusing duplicate-contact state if the wiped user later re-pairs.
Betroffene Komponenten: App.tsx (device_wiped send site, ~line 1218-1262), web/src/App.tsx (receive handler, ~253-259)
Angreifermodell: A malicious relay attempting to either forge a fake wipe notice (cannot — no key material) or suppress a genuine one (can, trivially — drop or delay)
Precondition: A device wipes with at least one live paired contact.
Invariant: Every contact with a live shared secret gets an encrypted {type:'system', subtype:'device_wiped', ts} packet POSTed to /packet, fire-and-forget (not awaited, so the local wipe is never blocked on network success), sent before local secret/contact data is cleared.
Violation: A device_wiped notice is fabricated by a party without the pairing's shared secret (this would be the actual violation — authenticity of a REAL notice); notice SUPPRESSION by a malicious relay is a known, accepted limitation, not a violation.
Detection Method: SECURITY_ARCHITECTURE_THREAT_MODEL.md §3.2 (dedicated analysis: "the relay cannot lie to a device about its peer having been wiped" — confirmed structurally sound; suppression explicitly and separately analyzed as an accepted gap).
Automated Test: NONE identified with an exact filename for the device_wiped send/receive mechanism itself.
Current Status: IMPLEMENTED (mechanism confirmed present by code citation; authenticity property PROVEN by structural argument; suppression-resistance explicitly NOT claimed/held, and documented as such in relay.js/App.tsx/web/src/App.tsx comments per SECURITY_ARCHITECTURE_FINDINGS_ADDRESSED.md §3).
```

---

## MULTI-DEVICE

```
N/A — No multi-device feature exists in this codebase. Confirmed structurally: one EncryptedStorage/localStorage instance IS the device/account (DEVICE-001); there is no device list, no device-linking flow, no multi-device-same-identity concept anywhere in App.tsx, web/src/App.tsx, or relay.js. SECURITY_ARCHITECTURE_BACKLOG.md item B5 ("Device linking") scopes what this WOULD require if ever built (blocked on the Identity (A1) redesign, P2, needs independent cryptography review) — not invented here since it doesn't exist today.
```

## GROUPS

```
N/A — No group-messaging feature exists in this codebase. Confirmed by repeated, independent greps across multiple audit passes (SECURITY_STATE_MACHINES.md §8, SECURITY_ARCHITECTURE_THREAT_MODEL.md §2.1) for Group/group across App.tsx: zero matches. The architecture is strictly 1:1 — one role, one shared secret per contact pairing, no N-party key agreement anywhere in HybridCrypto.js/.ts. SECURITY_ARCHITECTURE_BACKLOG.md item A4 scopes what a future group feature would require (an MLS-style ratchet, P2, needs independent cryptography review, explicitly named as the single riskiest addition considered in that document) — not invented here since it doesn't exist today.
```

---

## SERVER

```
ID: SERVER-001
Kategorie: SERVER
Beschreibung: relay.js must never create, store, or require any account/session/login concept — every route must remain keyed by client-generated, client-controlled routing identifiers with no persisted user table.
Warum wichtig: This is a structural, not incidental, property: it's the basis for the app's "no accounts" claim and eliminates an entire class of account-takeover/credential-stuffing attack surface.
Betroffene Komponenten: relay.js (entire route list)
Angreifermodell: N/A — architectural
Precondition: N/A.
Invariant: No relay.js route implements register/login/session-token issuance for a persistent user identity (deviceId/pepper is a per-value rate-limiting mechanism, not an account).
Violation: A future route introduces a persistent, server-verified user account.
Detection Method: SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 1a (structural absence, confirmed by full route-list reading).
Automated Test: NONE
Current Status: PROVEN
```

```
ID: SERVER-002
Kategorie: SERVER
Beschreibung: relay.js must never persist message/attachment content to disk — every store is an in-RAM Map with a bounded TTL (EXPIRE_MS for messages/10min, EXPIRE_CALL for call signals/2min, up to 33 days only for the rare reconnect-offer case).
Warum wichtig: This bounds the consequence of a relay compromise/subpoena to whatever is currently in RAM within the TTL window, not an unbounded historical archive.
Betroffene Komponenten: relay.js (store Map, cleanup intervals)
Angreifermodell: A relay operator retaining data longer than advertised, or a legal-compulsion scenario seeking historical data
Precondition: N/A.
Invariant: No relay.js code path writes message/attachment ciphertext to a database or persistent file; all storage is the single in-memory store Map, subject to periodic TTL-based sweeps.
Violation: relay.js persists message content to disk or an external database.
Detection Method: SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 1b/1c (confirmed: no DB, no disk persistence of content — this specific claim holds even though the broader "no metadata, no logs" framing does not, per METADATA-003).
Automated Test: __tests__/perf/relayStoreScanScale.test.js (indirectly, confirms store is a Map, not a DB); TTL-sweep unit tests in relay.http.test.js
Current Status: PROVEN
```

```
ID: SERVER-003
Kategorie: SERVER
Beschreibung: Every relay.js HTTP request handler must run to completion synchronously (no await between reading and mutating shared Map/Set state) so that Node's single-threaded event loop guarantees atomicity for read-modify-write sequences against the same store key.
Warum wichtig: This is the structural property that makes most of the relay's concurrency-sensitive logic (pepper mutex, phone-role-claim "first wins", packet-ack token matching) provably race-free without needing an explicit lock — re-verified specifically, not assumed, by a dedicated concurrency-review pass.
Betroffene Komponenten: relay.js (every route handler)
Angreifermodell: Any attacker attempting a TOCTOU race via concurrent requests
Precondition: Two or more requests touching the same store key arrive concurrently.
Invariant: No await exists between a store.get/has read and the corresponding store.set write within any single request handler body.
Violation: A future relay.js change introduces an await between a read and its corresponding write, reopening a TOCTOU window.
Detection Method: SECURITY_CONCURRENCY_REVIEW.md §0/§1 (re-read the entire file top to bottom to re-confirm this structural property, not merely assumed from prior passes).
Automated Test: __tests__/security/concurrency.relayPacketAckAndPhoneRoles.test.js (empirically confirms atomicity under true Promise.all concurrency for /phone/register, /phone/lookup, /packet/ack — 20-way ack storm, overlapping token sets, 2-generations-back stale ack)
Current Status: AUTOMATED
```

```
ID: SERVER-004
Kategorie: SERVER
Beschreibung: relay.js's error responses returned to the network must never leak internal implementation details (stack traces, file paths, echoed secrets) — every error body must be a short, generic status string.
Warum wichtig: A verbose error response is a reconnaissance channel that could reveal internal structure to an attacker probing the relay.
Betroffene Komponenten: relay.js (all catch blocks, ~24 sites, unified to {error: 'ungueltige_anfrage'} or similarly generic values)
Angreifermodell: An attacker probing relay.js endpoints for information disclosure
Precondition: A malformed request triggers an error path.
Invariant: Every HTTP error response body is one of a small set of short, generic German status strings (ungueltige_anfrage, unbekannt, gesperrt, versuch_laeuft_noch, bereits registriert, already_claimed) — never a stack trace, internal path, or echoed secret.
Violation: An error response contains a stack trace or internal implementation detail.
Detection Method: SECURITY_API_CONTRACTS_ERROR_HANDLING.md ("Information leaks in error responses to the network" — every relay.js error body explicitly checked).
Automated Test: __tests__/security/relay.http.test.js, __tests__/security/fuzz.relayApiInput.test.js (garbage bodies against every POST route, ~350 fuzzed requests, zero 5xx with leaked details)
Current Status: AUTOMATED
```

---

## RELAY

```
ID: RELAY-001
Kategorie: RELAY
Beschreibung: relay.js is a single Node process with no replication/sharding — this single-process design is the source of both the "one trust boundary" property (SERVER/METADATA-002) and a structural single point of availability failure; a malicious or overloaded relay can selectively and silently deny service to one or both parties in a conversation.
Warum wichtig: This must be understood as an inherent architectural trade-off (self-hosting simplicity vs. availability robustness), not a bug — but it means the relay can trivially black-hole a specific contactId's traffic while appearing to function normally for everyone else, with zero forgery needed.
Betroffene Komponenten: relay.js (entire process model)
Angreifermodell: A malicious relay operator engaging in selective, targeted denial-of-service
Precondition: N/A — structural.
Invariant: N/A — this entry documents an accepted architectural limitation, not a property to be held/violated in the usual sense. The corresponding client-facing invariant is: clients must never assume a lack of relay response means "peer is offline" with certainty (it's indistinguishable from deliberate relay censorship).
Violation: N/A (documentation invariant).
Detection Method: SECURITY_REVIEW_3 Q7 ("Eclipse-style attack"), SECURITY_ARCHITECTURE_THREAT_MODEL.md §3.1 "Eclipse-style attack" entry.
Automated Test: NONE (architectural property, not mechanically testable)
Current Status: PROVEN (as an accurately-documented, accepted limitation)
```

```
ID: RELAY-002
Kategorie: RELAY
Beschreibung: relay.js must cap request body size (see SECURITY-004) AND must not allow its in-memory store to grow unbounded — periodic cleanup sweeps must bound total memory even under sustained legitimate-looking traffic.
Warum wichtig: An unbounded store (even of small, valid-looking entries) is a slow-drip memory-exhaustion DoS vector distinct from the single-oversized-body vector SECURITY-004 covers.
Betroffene Komponenten: relay.js (60s expiry sweep, 5-minute deep cleanup, 50MB RAM-only eviction logic referenced in SECURITY_REVIEW_5 finding 8)
Angreifermodell: An attacker flooding the relay with many small, valid-looking requests over time
Precondition: Sustained request volume over time.
Invariant: Periodic cleanup intervals prune expired entries regardless of traffic volume; store growth is bounded by TTL expiry, not by request count alone.
Violation: The relay's store Map grows without bound under sustained traffic, eventually exhausting process memory.
Detection Method: SECURITY_REVIEW_1 H-3 (original unbounded-growth finding, fixed with TTL-based eviction); SECURITY_REVIEW_5 finding 8 (50MB RAM-only eviction logic referenced).
Automated Test: __tests__/security/relay.http.test.js (TTL-sweep unit tests: 33-day/24h/2min without waiting)
Current Status: AUTOMATED
```

```
ID: RELAY-003
Kategorie: RELAY
Beschreibung: The four structurally identical "singleton slot, GET-by-key" endpoints (/reconnect/offer, /reconnect/answer, /signal/offer, /signal/answer) must use a consistent "not found" convention (404) rather than an inconsistent mix of 404-for-one and 200-with-null-field-for-three.
Warum wichty: Contract inconsistency across structurally identical endpoints is a latent bug magnet for any future client code that branches on status vs. payload inconsistently; unifying it removes an unforced-error surface even though no current caller was found to depend on the old, inconsistent behavior.
Betroffene Komponenten: relay.js (GET handlers for these four routes)
Angreifermodell: N/A — contract-consistency/correctness invariant, not adversarial
Precondition: A GET request for a not-yet-populated singleton slot.
Invariant: All four endpoints return 404 for "not found," consistently.
Violation: Any of the four endpoints reverts to returning 200 with a null field for "not found."
Detection Method: SECURITY_API_CONTRACTS_ERROR_HANDLING.md Part 1 finding #1 (found the inconsistency, confirmed no client depends on the old behavior, fixed).
Automated Test: __tests__/security/relay.http.test.js (updated/new test for /signal/offer not-found case, previously untested)
Current Status: AUTOMATED
```

```
ID: RELAY-004
Kategorie: RELAY
Beschreibung: /phone/register and /phone/lookup must not allow a second (or later) device to silently overwrite an already-claimed "initiator" role for the same rendezvous hash — the first legitimate claimant's role must be protected, with any later claimant (other than an idempotent retry using the same chatId) receiving an explicit already_claimed response instead of a silently-overwritten role assignment.
Warum wichtig: The original implementation let a third device (a retry, or a genuine third party who happens to know the same phone-number pair) silently displace an already-registered initiator with zero notification to the displaced device — empirically demonstrated under true concurrency, not just theorized.
Betroffene Komponenten: relay.js (/phone/register, /phone/lookup)
Angreifermodell: A retrying client (accidental) or a genuine third device sharing knowledge of both phone numbers (per DISCOVERY-002's own acknowledged limitation)
Precondition: A phone-hash rendezvous slot is already claimed by one initiator.
Invariant: Both handlers only accept a new initiator claim if entry.initiatorId is still null, OR the caller is retrying with the SAME chatId; any other chatId gets {ok:false, role:'already_claimed'} with initiatorId left untouched.
Violation: A second/third device's claim silently overwrites the first legitimate initiator's registration.
Detection Method: SECURITY_CHAOS_TESTING.md Scenario 8 (found, concretely constructed under true concurrency for both endpoints); fixed per SECURITY_CHAOS_FOLLOWUP_FIXES.md Fix 1.
Automated Test: __tests__/security/chaos.duplicateMessages.test.js (idempotent same-chatId retry succeeds; 3 truly concurrent /phone/register calls yield exactly one winner and two honest already_claimed losers; same concurrency proof for /phone/lookup)
Current Status: AUTOMATED
```

```
ID: RELAY-005
Kategorie: RELAY
Beschreibung: /pepper/register's deviceId validation must reject any non-string value, not merely any string shorter than 16 characters — a truthy non-string value (object, number, boolean) with no numeric .length must not silently bypass the length check via JavaScript's `undefined < 16 === false` type-coercion behavior.
Warum wichtig: Without an explicit typeof check, this class of type-confusion bug silently defeats an intended input-validation guard — practically inert here (a JSON-parsed object is a fresh reference, unreachable again via Map key lookup) but a genuine, worth-fixing validation gap whose intent visibly fails to do what its own code/comment imply.
Betroffene Komponenten: relay.js (/pepper/register)
Angreifermodell: An attacker sending a non-string deviceId
Precondition: A POST to /pepper/register with a non-string deviceId.
Invariant: The guard is `typeof deviceId !== 'string' || deviceId.length < 16`, not merely `deviceId.length < 16`.
Violation: A non-string deviceId (object/number/boolean) is accepted and issued a real pepper.
Detection Method: SECURITY_FUZZING_CAMPAIGN.md §5 (found via property-based fuzzing); fixed, confirmed already-fixed by SECURITY_API_CONTRACTS_ERROR_HANDLING.md finding #7 (re-read fresh, confirmed current).
Automated Test: __tests__/security/fuzz.relayApiInput.test.js ("REGRESSION: deviceId als Objekt ({}) statt String umgeht die Laengenpruefung")
Current Status: AUTOMATED
```

```
ID: RELAY-006
Kategorie: RELAY
Beschreibung: Client-side relay-response consumption (RelayClient.js/.ts's get*/poll* functions) must validate the shape of fields extracted from relay JSON responses (Array.isArray for list fields, typeof === 'string' for scalar fields) before returning them to callers — a bare `data.field || default` pattern that trusts a truthy-but-wrong-shaped value must not be used.
Warum wichtig: A compromised or MITM-positioned relay (or simply a buggy relay) returning a truthy-but-wrong-shaped value (e.g. {"packets": "not an array"}) could otherwise propagate an unvalidated value into a for...of loop in App.tsx/web/src/App.tsx, throwing a synchronous, uncaught TypeError that silently stops that polling cycle from completing.
Betroffene Komponenten: RelayClient.js, web/src/lib/RelayClient.ts (getSignalOffer, getReconnectOffer, receiveFromRelay/getPackets, pollCallSignals)
Angreifermodell: A malicious/compromised relay or a MITM-positioned attacker returning malformed response shapes
Precondition: A client polls a relay endpoint.
Invariant: Every get*/poll* function validates field shape (typeof/Array.isArray) before returning, defaulting to null/[] on mismatch, on both native and web.
Violation: An unvalidated, wrong-shaped field value is returned and causes an uncaught exception in a consuming for...of loop.
Detection Method: SECURITY_FUZZING_CAMPAIGN.md §6 (found the gap, suggested fix); confirmed already fixed by a concurrent session per SECURITY_API_CONTRACTS_ERROR_HANDLING.md finding #6 (re-read fresh, confirmed current).
Automated Test: __tests__/security/fuzz.serverResponseParsing.test.js (17 tests, ~500 fuzzed response shapes, zero unhandled rejections)
Current Status: AUTOMATED
```

```
ID: RELAY-007
Kategorie: RELAY
Beschreibung: sendSignalOffer/sendSignalAnswer/sendReconnectOffer/sendReconnectAnswer (both platforms) must report failure (return false) when the relay responds with a non-2xx status, matching the behavior of sibling functions (sendPacket/sendCallSignal/sendTransferChunk/registerPushToken) in the same files — a bare "fetch didn't throw" check must not be treated as success.
Warum wichtig: Before this fix, a genuine 4xx/5xx from the relay (e.g. a malformed body due to a client bug) was silently reported as success for these four functions specifically, inconsistent with the rest of the same file — currently zero behavior change for any real caller (none branch on the result today), but it starts to matter correctly the moment a caller is written to check it.
Betroffene Komponenten: RelayClient.js, web/src/lib/RelayClient.ts (8 functions total, 4 per platform)
Angreifermodell: N/A — contract-truthfulness/correctness invariant
Precondition: A relay request returns a non-2xx status.
Invariant: All 8 functions return res.ok, consistent with their siblings in the same file.
Violation: Any of the 8 functions returns true despite a non-2xx relay response.
Detection Method: SECURITY_API_CONTRACTS_ERROR_HANDLING.md Part 1 finding #5.
Automated Test: __tests__/security/fuzz.serverResponseParsing.test.js (8 new tests, 4 native + 4 web, proving both the fixed 4xx-returns-false case and unchanged 200-returns-true case)
Current Status: AUTOMATED
```

```
ID: RELAY-008
Kategorie: RELAY
Beschreibung: relay.js's CallManager-facing poll loop (client-side, CallManager.js _startPolling) and every other client-side poll loop (App.tsx checkOutgoing/checkIncoming, web/src/App.tsx checkOfflinePackets) must have a per-cycle "already running" guard, so a slow-but-alive relay response does not cause overlapping poll cycles to pile up and process the same signals/packets twice via concurrent, interleaved handler chains.
Warum wichtig: Without this guard, a slow relay response (or a burst of signals needing sequential awaited processing) can take longer than the poll interval, causing the next tick to fire while the previous one is still mid-flight against the same shared this.pc/this.state or this.connections — a genuine, empirically-fixable race distinct from the per-contact connection-attempt guard that already existed.
Betroffene Komponenten: CallManager.js (_pollCycleRunning), App.tsx, web/src/App.tsx (equivalent guards, fixed earlier)
Angreifermodell: A slow/backed-up relay (accidental) or a malicious relay deliberately delaying responses to induce overlapping poll cycles
Precondition: A poll cycle's processing time exceeds the poll interval.
Invariant: Each poll loop checks-and-sets a "running" guard before its body executes, resetting it in a finally block (so a thrown error can't permanently wedge the lock).
Violation: Two overlapping poll cycles both call pollCallSignals()/checkOutgoing()'s body concurrently against the same shared state.
Detection Method: SECURITY_CHAOS_TESTING.md Scenario 3 (App.tsx/web/src/App.tsx loops, found, fixed per SECURITY_CHAOS_FOLLOWUP_FIXES.md Fix 4); SECURITY_CONCURRENCY_REVIEW.md §4 (CallManager.js's analogous, previously-missed loop, found and fixed in this pass).
Automated Test: __tests__/security/stateMachine.pollCycleGuard.test.js (App.tsx/web loops, structural + behavioral), __tests__/security/concurrency.callManagerPollGuard.test.js (CallManager.js, full behavioral test: overlapping tick skipped, thrown-error still releases guard, idempotent _startPolling)
Current Status: AUTOMATED
```

---

## DISCOVERY

```
ID: DISCOVERY-001
Kategorie: DISCOVERY
Beschreibung: The QR/deep-link pairing flow's out-of-band pre-shared key (PSK) must be exchanged ONLY via the QR code/deep link itself, never sent to the relay — every SDP offer/answer during first pairing must be encrypted under this PSK before it ever touches relay.js.
Warum wichtig: This is the mechanism that lets the relay be fully untrusted during the highest-value moment (initial key exchange) for QR pairing specifically; if the PSK ever transited the relay, a malicious relay could trivially MITM the very first Kyber exchange.
Betroffene Komponenten: App.tsx (ConnectScreen, PSK generation and encryptMsg(offerJSON, pskB64))
Angreifermodell: Malicious/compromised relay
Precondition: A QR/deep-link pairing is initiated.
Invariant: The random PSK is generated locally and transmitted only via the QR code/deep link; POST /signal/offer always carries a PSK-encrypted SDP, never plaintext.
Violation: The PSK, or a plaintext SDP offer, is sent to any relay.js endpoint.
Detection Method: SECURITY_REVIEW_1 (original design, confirmed correct at first pairing); SECURITY_REVIEW_2 N-1 (found a residual leak: createAnswer()'s side effect also registers a SEPARATE plaintext SDP answer copy under a throwaway random token — fixed by switching to createAnswerDirect() everywhere).
Automated Test: NONE with an exact filename directly asserting "no plaintext SDP reaches relay.js" for this flow end-to-end.
Current Status: PROVEN for the PSK itself and the primary encrypted offer/answer path; the N-1 vestigial plaintext-leak finding was fixed (createAnswer()'s side-effect removed/replaced with createAnswerDirect()) — confirmed by code citation across SECURITY_REVIEW_2 and later documents, not re-verified by a dedicated automated test in this catalog's review.
```

```
ID: DISCOVERY-002
Kategorie: DISCOVERY
Beschreibung: The phone-number rendezvous flow's SDP-encryption PSK (derivePhonePSK) must be cryptographically independent (distinct HKDF/hash domain) from the relay-visible rendezvous hash (hashPhone) — the relay must never be able to derive the encryption PSK from the rendezvous hash it legitimately sees.
Warum wichtig: This is the one real cryptographic protection the phone-connect flow provides; without domain separation, the relay (which always sees the rendezvous hash) could trivially decrypt the SDP exchange too. This invariant does NOT claim protection against an adversary who already knows both phone numbers — that limitation is explicit and acknowledged (see the Violation field).
Betroffene Komponenten: App.tsx (hashPhone at ~2711-2726, derivePhonePSK at ~2737-2749)
Angreifermodell: The relay operator, WITHOUT independent knowledge of both phone numbers
Precondition: A phone-connect pairing is initiated.
Invariant: hashPhone() = SHA256("malachi_2026_phone_" + sorted(numbers)); derivePhonePSK() = SHA256("malachi_2026_phone_psk_" + sorted(numbers)) — distinct label prefixes, confirmed in code, so the relay-visible hash and the SDP-encryption key are never the same value even though derived from the same input material.
Violation: The relay derives the SDP-encryption PSK from the rendezvous hash it observes (would indicate a domain-separation failure). NOTE: an attacker (including the relay operator) who ALREADY knows both phone numbers through any channel CAN compute the same PSK — this is an explicit, acknowledged, unfixed limitation of the feature, not a violation of THIS invariant, which is scoped to the "relay-only" adversary.
Detection Method: SECURITY_REVIEW_2 (confirmed domain separation, correct labeling); SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 6 (confirmed developer comments honestly caveat this; the user-facing UI string originally didn't — fixed this session to add the caveat, per SECURITY_ARCHITECTURE_FINDINGS_ADDRESSED.md §2).
Automated Test: __tests__/security/phonePskIndependence.test.js (proves hashPhone/derivePhonePSK are independent SHA-256 digests via distinct domain labels, order-independent, no collision from input normalization)
Current Status: AUTOMATED (for domain separation itself); the "anyone who knows both numbers can compute the PSK" limitation is UNVERIFIED as a solved problem — explicitly tracked as SECURITY_ARCHITECTURE_BACKLOG.md item A2 (Peer discovery / PAKE replacement, P2, needs independent cryptography review, flagged as one of the two worst benefit-to-risk rows if rushed).
```

```
ID: DISCOVERY-003
Kategorie: DISCOVERY
Beschreibung: The weak, non-cryptographic hash fallback (a 32-bit string-hashCode-style construction) previously present in hashPhone()/derivePhonePSK() for when NativeModules.KyberModule.sha256 is unavailable must not silently degrade a security-critical KDF — the feature must fail closed (refuse to proceed) rather than proceed with ~2^31-space, trivially-invertible material.
Warum wichtig: A silent fallback to a non-cryptographic hash would fully defeat the C-2/domain-separation fix (DISCOVERY-002) with no error or user-visible indication, exactly the kind of "degraded-not-disabled" failure mode that's most dangerous because it looks like it's working.
Betroffene Komponenten: App.tsx (hashPhone, derivePhonePSK)
Angreifermodell: An attacker who can trigger or observe this fallback (native module registration failure, missing build variant, timing race)
Precondition: NativeModules.KyberModule.sha256 is unavailable at the moment hashPhone/derivePhonePSK run.
Invariant: The phone-connect feature must refuse to proceed (fail closed, matching web's own setupEncryption() philosophy: "ohne Pepper... dann lieber gar nicht erst einrichten") rather than silently computing a weak fallback hash.
Violation: The phone-connect feature proceeds using the 32-bit non-cryptographic fallback hash with no warning.
Detection Method: SECURITY_REVIEW_2 N-2 (found, fix recommended: remove the fallback entirely and fail closed).
Automated Test: NONE
Current Status: UNVERIFIED — status of the fix was not independently re-confirmed against current App.tsx by any document read for this catalog; flagged for direct re-verification before relying on it.
```

```
ID: DISCOVERY-004
Kategorie: DISCOVERY
Beschreibung: The phone-number rendezvous hash (hashPhone) and the 5-minute-TTL entries it produces in relay.js's store must be deleted promptly (on match or explicit cancel) or expire via TTL — not retained indefinitely.
Warum wichtig: This is the specific, narrowly-true claim behind the phone-connect UI's "temporarily stored, deleted immediately after connecting" string — it must remain true even though the broader "Zero-Knowledge" framing around it does not (per METADATA-003/DISCOVERY-002).
Betroffene Komponenten: relay.js (/phone/register, /phone/lookup, /phone/pending, 5-minute TTL)
Angreifermodell: N/A — data-minimization property, not adversarial per se (though relevant to what a relay operator could retain if they modified their own code to ignore this)
Precondition: A phone-connect pairing attempt is made.
Invariant: Every phone_*/phone_search_* entry is deleted explicitly on match pickup or explicit cancel, or expires via the general 5-minute cleanup interval.
Violation: A phone-hash entry persists in the relay store beyond its TTL with no matching pairing event.
Detection Method: SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md Claim 6 (confirmed directly readable in relay.js: every code path either deletes explicitly or lets the TTL expire it).
Automated Test: NONE — "no test explicitly proves the TTL fires" per the source document, though the logic is unconditional and simple enough that structural reading was judged sufficient by that audit.
Current Status: PROVEN (by code reading only — no dedicated automated test confirmed for the TTL-expiry path specifically).
```

---

## SIGNALING

```
ID: SIGNALING-001
Kategorie: SIGNALING
Beschreibung: A reconnect offer/answer SDP must be encrypted under the pairing's existing shared secret (purpose='reconnect') before being POSTed to /reconnect/offer or /reconnect/answer — the responder must refuse to proceed if no cached shared secret exists, and must refuse if decryption fails ("moeglicher Angriff, verwerfen").
Warum wichtig: This is the fix for the original critical MITM (SECURITY_REVIEW_1 C-1): before it, reconnect SDP was sent in plaintext, keyed only by a relay-visible contact.id, letting any party who learned that id (the relay operator by definition) hijack every reconnect after the first one.
Betroffene Komponenten: App.tsx (checkOutgoing/checkIncoming reconnect logic), web/src/App.tsx equivalents
Angreifermodell: Malicious/compromised relay
Precondition: A reconnect attempt occurs for an already-paired contact.
Invariant: Every reconnect offer/answer is encryptMsg()'d under the existing shared secret with purpose='reconnect' before POSTing; a decrypt failure on receipt is treated as a possible attack and discarded, not processed.
Violation: A reconnect SDP is sent or accepted in plaintext, or a decryption failure is silently ignored and the SDP processed anyway.
Detection Method: SECURITY_REVIEW_1 C-1 (original bug); SECURITY_REVIEW_2 (verified fix line-by-line, confirmed both native and web reject any reconnect offer/answer that isn't successfully authenticated-decrypted).
Automated Test: __tests__/security/messageCrypto.domainSeparation.test.js (purpose='reconnect' isolation), __tests__/security/chaos.relayNetworkFailures.test.js (stale-offer-resurrection scenario)
Current Status: AUTOMATED (for the domain-separation/encryption half); the residual "attacker with one stolen secret can hijack the NEXT reconnect" gap is tracked separately as SESSION-006 (UNVERIFIED, open).
```

```
ID: SIGNALING-002
Kategorie: SIGNALING
Beschreibung: The vestigial plaintext-SDP-registration side effect of WebRTCManager.createAnswer() (a throwaway Math.random()-token POST to /signal/offer that nobody reads back) must not be reachable from any reconnect or pairing call site — every call site must use createAnswerDirect() instead, which has no such side effect.
Warum wichtig: This side effect leaked a full plaintext copy of the responder's SDP (DTLS fingerprint, ICE candidates) to the relay on every native reconnect and on both clients' initial pairing, directly contradicting the C-1 fix's stated goal ("the relay never sees SDP in the clear") even though the properly-encrypted answer was also being sent correctly alongside it.
Betroffene Komponenten: WebRTCManager.js (createAnswer vs. createAnswerDirect), App.tsx (reconnect responder + initial pairing call sites), web/src/App.tsx (initial pairing call site)
Angreifermodell: Malicious/compromised relay
Precondition: A reconnect responder or initial-pairing answer is generated.
Invariant: Every reconnect-responder and initial-pairing call site uses createAnswerDirect(), never createAnswer() (which retains its self-registration side effect for any code path that genuinely still needs it).
Violation: A plaintext SDP answer is POSTed to /signal/offer under a throwaway token as a side effect of answering.
Detection Method: SECURITY_REVIEW_2 N-1 (found: web's reconnect path already used createAnswerDirect() correctly; native's reconnect path and both clients' initial-pairing paths did not).
Automated Test: NONE with an exact filename directly asserting "no plaintext SDP self-registration occurs."
Current Status: IMPLEMENTED — fix confirmed by explicit code citation (App.tsx:695 switched to createAnswerDirect, matching the already-correct web reconnect path) in SECURITY_REVIEW_2's own finding text and referenced as fixed by later documents; not independently re-verified against current App.tsx line numbers for this catalog, and not covered by a dedicated automated test. Flag for direct re-verification before relying on this status.
```

```
ID: SIGNALING-003
Kategorie: SIGNALING
Beschreibung: The relay's routing/rendezvous identifiers (contactId, offerKey/answerKey, phone hash) must be understood and treated as relay-visible-by-necessity routing metadata, never as an implicit authorization credential — every mutating/sensitive relay operation keyed by one of these identifiers must additionally require proof of possession of the corresponding shared secret (via encryption), not just knowledge of the identifier string.
Warum wichtig: This is the systemic root cause named across the original C-1/C-2/C-4 findings: using the same human-meaningful ID for routing AND as an implicit authorization credential conflates two properties that should be separate — anyone who learns a routing ID (which the relay always has, by construction) should not thereby gain the ability to act as that party.
Betroffene Komponenten: relay.js (all contactId/token/recipient-keyed routes), App.tsx/web/src/App.tsx (encryption applied at each such call site)
Angreifermodell: The relay operator, or anyone who learns a routing identifier via any channel
Precondition: A relay operation is keyed by contactId/token/recipient.
Invariant: Every currently-fixed instance of this pattern (reconnect offer/answer per SIGNALING-001, system control packets per MESSAGING-002, phone-connect offer/answer per DISCOVERY-002) requires the caller to additionally prove possession of the shared secret via successful AEAD decryption on receipt — mere knowledge of the routing ID is never sufficient to act as that party for these flows.
Violation: A relay operation succeeds based on routing-ID knowledge alone, with no accompanying proof of secret possession, for a flow where this matters.
Detection Method: SECURITY_REVIEW_1 M-2 (systemic architectural note, naming the root cause once rather than per-instance).
Automated Test: Covered by the individual per-flow tests cited under SIGNALING-001/MESSAGING-002/DISCOVERY-002 — no single test asserts this systemic property directly.
Current Status: PROVEN for the three flows explicitly fixed and cited; not claimed to be a universally-enforced systemic guarantee across every current and future relay route (e.g. RELAY-001's Eclipse/black-holing analysis shows availability-layer identifier-based actions — like withholding a response — are NOT protected by this invariant, since it only governs confidentiality/authenticity of content, not availability).
```

```
ID: SIGNALING-004
Kategorie: SIGNALING
Beschreibung: Session/routing tokens that index secret-adjacent relay storage (e.g. WebRTCManager.js's sessionToken, App.tsx's reconnect sessionId/dynamicAnswerKey suffixes, phone-connect myId) should use a CSPRNG, consistent with the fix already applied to generateContactId() — currently NOT fully consistent: several of these still use Math.random().
Warum wichtig: These tokens don't gate confidentiality directly (the payloads they route to remain separately AEAD-encrypted), but using a non-CSPRNG for anything that indexes secret-adjacent relay storage is inconsistent with the app's own stated security discipline and could, in combination with other weaknesses (e.g. P2P-005's low-entropy contactId), widen a routing-collision/prediction attack surface.
Betroffene Komponenten: WebRTCManager.js (sessionToken), App.tsx (reconnect sessionId/dynamicAnswerKey, phone-connect myId)
Angreifermodell: A relay operator or attacker attempting to predict/grind a routing token to intermix or hijack an unrelated pairing's queue
Precondition: A new session/routing token is generated.
Invariant (intended, NOT fully held): every such token generation site should use the same CSPRNG-backed generator already used for generateContactId(), consistently.
Violation: A routing token is generated via Math.random() rather than a CSPRNG.
Detection Method: SECURITY_AUDIT_CRYPTO_CLAIMS.md Part 3 summary table ("Not true for all identifiers"); SECURITY_REVIEW_3 Q4 (Math.random() used for phone-connect myId specifically, "the same class of weakness... apparently not ported to this second, parallel ID-generation site").
Automated Test: NONE
Current Status: UNVERIFIED — known, documented, unfixed consistency gap (distinct from, but related to, P2P-005's contactId-entropy finding).
```

---

## Summary

**Total invariants cataloged: 66** across 18 categories (2 marked N/A for genuinely absent features — MULTI-DEVICE, GROUPS).

**Status breakdown (self-reported per invariant above, re-verify before relying on any single one in isolation):**
- AUTOMATED: 24 (has a specifically-named, existing test file/describe-block directly exercising the invariant)
- PROVEN: 19 (established by direct code reading across this session's audits, no dedicated automated test identified)
- IMPLEMENTED: 6 (fix confirmed present by explicit code citation in the audit trail, not independently re-verified against current line numbers for this catalog, no automated test)
- PARTIALLY VERIFIED: 9 (either partially fixed, or automated for one half of a compound property and not the other)
- UNVERIFIED: 8 (known, documented, deliberately open/deferred gaps — most cross-reference SECURITY_ARCHITECTURE_BACKLOG.md items A1-A5 requiring independent cryptography review before any fix is attempted)

**Read this catalog with the following caveat in mind:** several PROVEN/IMPLEMENTED statuses rest on this session's own prior audit passes' code citations rather than a fresh line-by-line re-read of every cited file for this specific document (the codebase moved across ~10 commits during this session, and several prior documents explicitly caught and corrected earlier documents' stale claims — see MESSAGING-002's citation of SECURITY_AUDIT_CRYPTO_CLAIMS.md correcting SECURITY_REVIEW_2's stale "H-2 still open" verdict as one concrete example of this pattern recurring). Where an invariant's status matters for a specific decision, re-verify against current code rather than trusting this catalog's snapshot alone — this is exactly the discipline every document in this audit trail applied to its predecessors, and it should be applied to this one too.
