# SecureCommApp ("Malachi") — Adversarial Security Review #1

Scope: `relay.js`, native RN app (`App.tsx`, `HybridCrypto.js`, `MessageCrypto.js`, `WebRTCManager.js`, `RTCStore.js`, `CallManager.js`, `AudioCrypto.js`, `ImageCrypto.js`, `RelayClient.js`, `KyberModule.kt`, `MalachiFirebaseMessagingService.kt`), and the web client (`web/src/App.tsx`, `web/src/lib/*`). Read-only review, no code changed.

## Executive summary — worst issues first

1. **(Critical) The auto-reconnect flow sends the raw WebRTC SDP offer/answer to the relay completely unencrypted**, keyed by a value (`contact.id`) that the relay already sees on every request. Anyone who can compute `contact.id` — the relay operator trivially, or a network observer who saw the original pairing — can hijack every reconnect after the first one and run a full active MITM on the Kyber key exchange and all subsequent traffic. The developer explicitly understood and fixed this exact attack for the *initial* pairing (PSK-encrypted SDP) and for *calls* (see finding H-2), but never applied the fix to reconnects. Present identically in native (`App.tsx`) and web (`web/src/App.tsx`).
2. **(Critical) The phone-number "zero-knowledge" connect flow has no shared secret at all.** The rendezvous key is `SHA256("malachi_2026_phone_" + sorted(numberA, numberB))`, and the WebRTC offer is relayed in plaintext. Anyone who knows (or guesses) both phone numbers — not even an eavesdropper, just an acquaintance, a leaked contact list, or the relay operator — can register/lookup that hash and inject themselves as the peer, MITMing the pairing from a cold start.
3. **(Critical) The web PIN "pepper" anti-bruteforce mechanism can be bypassed entirely.** `/pepper/request` hands out the actual pepper to anyone who supplies the `deviceId` (stored in plaintext in the very same `localStorage` the mechanism is meant to protect), with no proof of PIN knowledge. Rate-limiting is enforced only because the *real* client dutifully calls `/pepper/fail` on a wrong guess — an attacker with a copy of `localStorage` just never calls it, fetches the pepper once, and brute-forces the PIN fully offline forever after.
4. **(Critical) Any unencrypted, unauthenticated JSON packet can delete a victim's chat.** `App.tsx`'s "delete_chat"/"secret_end" system packets are sent to `relay.js`'s `/packet` endpoint as plaintext, unauthenticated JSON keyed only by the (relay-visible) `contact.id`, and the receiving client acts on them with zero verification. One HTTP POST from anyone who knows `contact.id` wipes the victim's conversation.
5. **(High) No forward secrecy in practice**: the Kyber-derived shared secret is written to disk (`react-native-encrypted-storage` / pepper-protected `localStorage`) and reused for every message and call until the next full reconnect. Combined with #1, an attacker who MITMs one reconnect obtains a durable key that keeps working against relay-fallback traffic until the next renegotiation.

All four Critical findings share one root cause: **the relay's routing/rendezvous identifiers (`contact.id`, the phone hash, `offerKey`/`answerKey`) are treated as if they were secret, but they are either directly visible to the relay or trivially derivable from information sent to the relay, and nothing else authenticates who is allowed to act on them.**

---

## CRITICAL

### C-1. Auto-reconnect relays the WebRTC offer/answer in plaintext → active MITM on every reconnect

**Files/functions:**
- Native, initiator side: `App.tsx` lines 401–495 (`checkOutgoing`, "Auto-Reconnect – Initiator"), specifically line 410 `const offerKey = contact.id + '_offer';` and lines 481–483:
  ```js
  rtc.createOffer().then(offerJSON => {
    const offerWithMeta = JSON.stringify({ sdp: offerJSON, answerKey: dynamicAnswerKey });
    sendReconnectOffer(offerWithMeta, offerKey);
  ```
- Native, responder side: `App.tsx` lines 640–666 (`checkIncoming`), `getReconnectOffer(offerKey)` / `sendReconnectAnswer(answer, dynamicAnswerKey)` — again no encryption call anywhere in the path.
- Web, initiator side: `web/src/App.tsx` lines 66–116, line 87: `await sendReconnectOffer(JSON.stringify({ sdp: JSON.parse(offerJSON).sdp, answerKey }), offerKey);`
- Web, responder side: `web/src/App.tsx` lines 118–140+, same pattern.
- Server side: `relay.js` lines 381–425 (`/reconnect/offer`, `/reconnect/answer`) — stores/returns whatever payload it is given, no validation that it is encrypted, no authentication of the caller.

**The problem:** Contrast this with the *initial* pairing flow (`App.tsx` lines 2697–2724), where the developer generates a random PSK, shares it only via the QR code/deep link, and explicitly encrypts the SDP offer with it before it ever touches the relay — with a comment that spells out exactly why:

> "Der Token oben ist dem Relay bekannt ... und darf deshalb nicht gleichzeitig als Verschluesselungsschluessel dienen - sonst koennte ein boesartiger/kompromittierter Relay das SDP-Offer mitlesen und den DTLS-Fingerprint austauschen (Man-in-the-Middle auf die komplette P2P-Verbindung...)"

That exact reasoning applies to every subsequent reconnect, but the reconnect code path never derives or uses a PSK — it sends the bare SDP.

**Attack path:**
1. `contact.id` is `'c_' + token`, where `token` is the same 8-hex-char value used as the URL path segment in `/signal/offer/{token}` during the *original* pairing (`App.tsx` line 2716, 2724, 2741). This value is sent to the relay in the clear as routing metadata by design — the relay operator has it in every request log; a network observer who saw the original pairing (before/without TLS, or simply because it's an HTTP path component logged by any proxy) has it too.
2. From `contact.id`, anyone computes `offerKey = contact.id + '_offer'` — one string concatenation, no secret involved.
3. Attacker calls `GET /reconnect/offer/{offerKey}` on the relay. Because the offer is plaintext, they read the real SDP (ICE candidates, DTLS fingerprint) **and** the embedded `answerKey` (`dynamicAnswerKey`) needed to answer it.
4. Attacker creates their own `RTCPeerConnection`, generates their own answer, and POSTs it to `/reconnect/answer` with `contactId = dynamicAnswerKey` — racing (or simply beating, since they can respond instantly and the real device polls every 5–8s) the legitimate responder.
5. The victim's `WebRTCManager` completes a WebRTC/DataChannel handshake with the attacker instead of the real contact. The subsequent Kyber `kyber_pubkey`/`kyber_ciphertext` exchange (`WebRTCManager.js` lines 260–330) is itself unauthenticated and trusts whoever is on the other end of the DataChannel — so the attacker completes a Kyber exchange as "the contact" with the victim, and (using the leaked SDP) a second, independent Kyber exchange with the real contact, transparently relaying and re-encrypting everything in between. Full E2EE bypass for that reconnect session, including all messages, images, audio, and (if the attacker also relays call signaling — see H-2) calls sent afterward.
6. This requires no cryptographic break of Kyber/AES/ChaCha/XSalsa at all — the layered crypto is irrelevant once the attacker is a legitimate endpoint of the DataChannel.

**Impact:** Complete, silent E2EE bypass for any contact whose `contact.id` becomes known to an adversary — which includes the relay operator by definition, and any network observer of the original pairing. Auto-reconnect runs every 8–15 seconds in the background with no user interaction, so this is not a one-off risk window; it is continuously exploitable by a malicious/compromised relay.

**Severity:** Critical.

**Root cause:** The MITM-prevention fix (PSK-encrypt the SDP before it reaches the relay) was applied only to the initial-pairing code path and to call signaling (see H-2), not to the auto-reconnect code path that was added/extended later. Classic "fixed it in one place, forgot the other" — the developer's own comments prove they understood the exact threat.

**Proposed fix:** Derive a durable pairing secret at first connect (e.g. keep the original PSK, or derive one from the already-established Kyber shared secret via HKDF with a distinct label) and store it alongside `contact.id`. Encrypt every reconnect offer/answer (and the embedded `answerKey`) with that secret before calling `sendReconnectOffer`/`sendReconnectAnswer`, mirroring exactly what `ConnectScreen` already does for first pairing. Reject/ignore any reconnect offer that fails to decrypt.

**Also appears in:** web client (`web/src/App.tsx` lines 66–140) — identical pattern, identical fix needed.

---

### C-2. Phone-number connect flow has no shared secret and relays the offer in plaintext

**Files/functions:** `App.tsx` `hashPhone()` (2512–2529), `startPhoneConnect()` (2531–2614), `initiatePhoneConnect()` (2616–2660+), incoming handler for `phone_connect_offer` (589–624); `relay.js` `/phone/register`, `/phone/lookup`, `/phone/pending/*`, `/phone/*` DELETE (288–354), plus the generic `/packet` endpoint (356–378) used to actually carry the offer/answer.

**The problem:** The rendezvous key is:
```js
const sorted = [cleanMy, cleanOther].sort().join('_');
const input  = 'malachi_2026_phone_' + sorted;
return await NativeModules.KyberModule.sha256(input);   // hashPhone()
```
and the initiator sends the raw SDP offer to that hash with **no PSK, no encryption**:
```js
await fetch(`${RELAY_URL}/packet`, {
  method: 'POST',
  body: JSON.stringify({
    payload: JSON.stringify({ type: 'phone_connect_offer', offer: offerJSON, chatId: contactId }),
    recipient: hash,
  }),
});
```
Unlike the QR-pairing flow, there is no analogous PSK generation anywhere in this feature — the design relies entirely on "only the two phone numbers' owners know both numbers," which is false in practice (numbers are known to contacts, appear in address-book leaks, are often sequential/predictable within an area code, and — decisively — the relay operator sees the hash and the plaintext offer directly, no guessing required).

**Attack path:**
1. Attacker who knows (or is willing to enumerate) two phone numbers computes the same SHA-256 hash and calls `POST /phone/register` or `/phone/lookup` themselves, or simply waits and reads `/packet/{hash}` — no authentication exists on any of these endpoints.
2. Attacker intercepts/answers the plaintext `phone_connect_offer` exactly as in C-1, becoming a full MITM on the very first key exchange — before any trust has even been established between the two real users.
3. A malicious relay operator does not even need step 1: every phone-connect pairing that ever happens passes through their server in the clear.

**Impact:** Complete compromise of the phone-number pairing feature's confidentiality/authenticity claims ("zero-knowledge... gegenseitiges Matching" per the commit history) — it provides no cryptographic protection at all against the relay or against anyone who knows both numbers.

**Severity:** Critical.

**Root cause:** Missing feature — no PSK/out-of-band secret was ever designed into this flow, unlike the QR-code flow. Likely a case of building a second pairing mechanism without carrying over the security property of the first.

**Proposed fix:** At minimum, require a short manually-compared verification code (like the existing "Safety Code" computed from the Kyber shared secret) before either side trusts the pairing, and/or require out-of-band exchange of a PSK (e.g., the app could derive a PSK from a value only exchanged via SMS/other channel, not from the phone numbers alone). Treat this flow as inherently un-authenticatable against a malicious relay unless a true out-of-band secret is added, and disclose that to users.

---

### C-3. Web PIN "pepper" anti-bruteforce can be bypassed — offline brute force is fully possible

**Files/functions:** `relay.js` `/pepper/request` (490–502), `/pepper/fail` (504–523); `web/src/lib/Storage.ts` `unlockEncryption()` (114–144), `deriveKey()` (48–63), `getOrCreateDeviceId()` (39–46).

**The problem:** The entire security story of the pepper design is stated in the file's own comment: *"Ohne den Pepper ist die lokale Chiffre wertlos: Offline-Brute-Force ... bringt nichts mehr."* That is only true if the pepper cannot be obtained without going through the rate limiter. But:
- `deviceId` is generated client-side and stored, in plaintext, in the exact same `localStorage` that an attacker with "stolen device / backup / malware" access (the threat this feature is explicitly designed against, per the file's own header comment) already has.
- `POST /pepper/request` returns the pepper to **anyone who supplies that `deviceId`** — there is no proof of PIN knowledge required to ask for it:
  ```js
  } else if (req.method === 'POST' && req.url === '/pepper/request') {
    const { deviceId } = JSON.parse(body);
    const entry = pepperStore.get(deviceId);
    if (!entry) { ... }
    if (entry.lockedUntil > Date.now()) { ...423... }
    res.end(JSON.stringify({ pepper: entry.pepper }));   // <-- no PIN check at all
  ```
- The fail-counter is incremented only when the **client itself** calls `POST /pepper/fail` after locally failing to decrypt the marker (`web/src/lib/Storage.ts` lines 128–138). Nothing stops a different, attacker-written client from simply never calling `/pepper/fail`.

**Attack path:**
1. Attacker obtains a copy of the victim's `localStorage` (stolen laptop, malware, browser-profile backup — precisely the threat model in the code comments).
2. Attacker reads `malachi___device_id`, `malachi___pin_salt`, `malachi___pin_marker` directly from the dump.
3. Attacker's own script does `POST /pepper/request { deviceId }` **once**. If not currently locked, the server returns the pepper unconditionally.
4. Attacker now has `pepper`, `salt`, and the encrypted `marker` — everything needed to run `PBKDF2(pin + pepper, salt, 210000, SHA-256)` completely offline, with unlimited attempts, no further server contact, no rate limiting possible.
5. Because PINs are short (commentary throughout the codebase implies 4–6 digit numeric PINs, mirroring the native `LockScreen`), the effective keyspace is 10,000–1,000,000 — trivially brute-forced offline even at a few thousand PBKDF2/s.

**Impact:** Full compromise of all locally-stored web-client data (contacts, cached shared secrets, chat history) protected only by the PIN, for anyone who ever gets one read of `localStorage`. This defeats the specific, explicitly-stated purpose of the pepper mechanism.

**Severity:** Critical.

**Root cause:** Rate-limiting is enforced by client-reported honesty rather than being intrinsic to the protocol. The server should never hand over the raw pepper on demand; it should perform (or gate) the actual PIN verification itself, or use a protocol (e.g. OPAQUE-style PAKE, or a server-side HMAC "verify" call that increments the failure counter *before* it can be used, and only returns a boolean) where possession of the pepper alone is not sufficient and the server enforces the attempt limit regardless of client behavior.

**Proposed fix (concrete):** Change `/pepper/request` to *not* return the raw pepper. Instead, have the client send a value derived from the PIN attempt (e.g. HMAC of the marker plaintext under the candidate key) and have the server perform the AES-GCM verification server-side (or an OPRF-style blinded evaluation) so the server can increment `fails` *before* confirming success/failure, and never discloses `pepper` itself to anyone who hasn't already passed. At minimum, require the request to include a value that could only be produced by someone who already derived the correct key (chicken-and-egg — this is why a real PAKE/OPRF is the correct fix, not a patch).

---

### C-4. Unauthenticated system packets let anyone delete a victim's chat / forge control messages

**Files/functions:** `App.tsx` send side: line 729–733 (`onDelete`):
```js
fetch(`${RELAY_URL}/packet`, {
  method: 'POST',
  body: JSON.stringify({ payload: JSON.stringify({ type: 'system', subtype: 'delete_chat' }), recipient: chatId })
});
```
and line 2112, 2242 (`secret_end`/secret-chat control packets) — same pattern, `recipient: chat?.id` in plaintext.
Receive side: `App.tsx` lines 578–587, 625–634 (`checkIncoming`), which act on `msg.type === 'system'` packets from `/packet/{contact.id}` with **no signature/MAC/encryption check at all**:
```js
} else if (msg.type === 'system' && msg.subtype === 'delete_chat') {
  console.log('[Delete] Chat gelöscht von Gegenüber:', contact.name);
  setContacts(c => { const updated = c.filter(x => x.id !== contact.id); ... });
  EncryptedStorage.removeItem('chat_' + contact.id).catch(() => {});
  ...
```
Server side: `relay.js` `/packet` POST/GET (356–378) — stores and returns whatever it is given, no auth, no validation of payload shape, no rate limit tied to this endpoint specifically.

**Attack path:**
1. As established in C-1, `contact.id` is not secret — it is relay-visible and derivable from the original pairing token.
2. Attacker sends `POST {RELAY_URL}/packet` with `{"payload":"{\"type\":\"system\",\"subtype\":\"delete_chat\"}","recipient":"<victim contact.id>"}`.
3. Within 8 seconds (`checkIncoming` poll interval), the victim's app silently deletes the contact and all associated chat/timer/secret-chat state — no confirmation, no undo, no indication it wasn't the real contact who requested it.
4. The same technique works for `secret_end` (line 583–587) to prematurely terminate/wipe a "Secret Chat," and for `secret_start` (578–582) to make the client believe a secret chat timer was set by the peer when it wasn't.

**Impact:** Remote, unauthenticated, unauthorized destruction of user data (chat history, contacts) and forgery of secret-chat state, exploitable by the relay operator or anyone who has ever learned a `contact.id` (which, per C-1, is not hard to obtain). This is a data-integrity/availability break independent of the message-confidentiality crypto entirely.

**Severity:** Critical.

**Root cause:** "Convenience shortcut" — system/control packets were added to support offline delivery of housekeeping events but were never brought into the same encrypt-and-authenticate discipline as normal chat messages (which *do* go through `encryptMsg`/`decryptMsg` with the shared secret when sent over `/packet` as `type: 'encrypted'`, per lines 562–577). The control-packet code paths simply forgot to wrap the payload the same way.

**Proposed fix:** Encrypt and authenticate every system/control packet sent via `/packet` with the same shared-secret `encryptMsg`/`decryptMsg` used for normal messages (the code already has the shared secret available at every one of these call sites — `chat?.id` is exactly the key used to look it up). Reject any `type: 'system'` packet on receipt that isn't wrapped as `type: 'encrypted'` first.

---

## HIGH

### H-1. No forward secrecy / persisted static shared secret

**Files/functions:** `WebRTCManager.js` lines 284–330 (`onmessage` handler for `kyber_pubkey`/`kyber_ciphertext`):
```js
this.sharedSecret = result.sharedSecret;
...
import('react-native-encrypted-storage').then(m => {
  m.default.setItem('shared_secret_' + this.chatId, this.sharedSecret).catch(() => {});
});
```
Also `App.tsx` lines 382–386 (secrets reloaded from `EncryptedStorage` into `RTCStore` at every app start) and `CallManager.js` `_getSharedSecret()` (396–404), which reads the same persisted value for encrypting call signaling.

**The problem:** A fresh Kyber keypair is generated per WebRTC session (good ephemeral-key hygiene on its face), but the resulting **shared secret is written to disk in full** and reused for every message/call until the next full P2P renegotiation — which, given the reconnect logic, might not happen for a long time if the DataChannel stays "open" (the liveness watchdog only forces a reconnect after `COVER_INTERVAL_MS * 4` = 12s of silence, but a healthy connection can run for the app's entire lifetime on one secret). There is no ratchet (no Double-Ratchet-style key evolution per message), so:
- **Compromise of stored data breaks all messages, past and future, until the next full renegotiation** — this directly fails post-compromise security and, combined with C-1 (an attacker who MITMs one reconnect gets their own long-lived "shared secret" with the victim), gives an attacker a durable decryption key for anything sent via the relay-fallback path afterward.
- **No PFS against a future key/device compromise for messages already stored on disk** in `shared_secret_<chatId>` — anyone who later gets the encrypted-storage contents (rooted device, backup, or the pepper bypass in C-3 on web) can decrypt everything sent while that secret was active.

**Impact:** Device/storage compromise (an explicitly listed threat actor) yields plaintext of all messages encrypted under the currently-active shared secret, not just future ones; an attacker who MITMs a single reconnect (C-1) gets a durable key, not a one-time foothold.

**Severity:** High.

**Root cause:** Key material was persisted for legitimate operational reasons (offline relay-fallback decryption, resuming after app restart) without considering that this directly trades away forward secrecy. Convenience vs. security tradeoff made silently.

**Proposed fix:** Introduce a simple per-message or per-N-messages ratchet (HKDF the shared secret forward after each use, discarding the old value) so a disk-compromise only exposes future traffic from that point, not historical traffic already delivered. At minimum, rotate the Kyber exchange (and hence the shared secret) on a fixed cadence rather than only "when the DataChannel drops," and stop persisting the raw shared secret longer than needed for in-flight relay delivery (expire it after a short TTL matching the relay's own message TTL of 10 minutes).

### H-2. Fail-open plaintext fallback for call signaling

**File/function:** `CallManager.js` `_sendSignal()`, lines 406–419:
```js
async _sendSignal({ type, payload }) {
  const secret = await this._getSharedSecret();
  if (!secret) {
    console.warn('[Call] Kein Shared Secret gefunden - Signal wird UNVERSCHLÜSSELT gesendet:', type);
    return sendCallSignal(this.contactId, this._outDirection(), type, payload);
  }
  const encPayload = await encryptMsg(JSON.stringify(payload || {}), secret);
  return sendCallSignal(this.contactId, this._outDirection(), type, { enc: encPayload });
}
```

**The problem:** The comment directly above this function (lines 388–395) explains that call SDP/ICE used to be plaintext and was fixed specifically to prevent a malicious relay from swapping the DTLS fingerprint and MITMing the call. But if `_getSharedSecret()` returns null for any reason (race before the secret is persisted, storage error, app just wiped/restored, contact added but never messaged yet), the code **silently falls back to sending the SDP in the clear** and **still places the call**, with only a `console.warn` that no end user will ever see. The user has no indication the call is not protected against the exact MITM the fix was written for.

**Attack path:** An attacker who can force or wait for this fallback (e.g., target a freshly-paired contact who hasn't exchanged a text message yet, so no `shared_secret_<id>` has been persisted; or a malicious relay that has already achieved the C-1 MITM and thus controls what "shared secret" each side thinks it has) gets a plaintext SDP exchange and can swap the DTLS fingerprint, becoming an RTP-level MITM on the actual call audio/video.

**Impact:** Silent security downgrade for a security-critical operation (calls); users are told "encrypted calls" in the product's threat narrative but get no cryptographic protection in this fallback path, and are not warned.

**Severity:** High.

**Root cause:** "Fail open, not fail closed" — the fallback was clearly intended as a UX safety net ("lieber... als den Anruf komplett zu blockieren") but the security-relevant failure mode wasn't weighed against that convenience.

**Proposed fix:** Fail closed: if no shared secret is available, block the call and surface an explicit error/UI state ("secure channel not established yet — send a text message first" or force a synchronous key-exchange before allowing the call to proceed) rather than silently sending plaintext signaling.

### H-3. Relay has no request size limit and no rate limiting on well-formed traffic — trivial memory-exhaustion DoS

**File/function:** `relay.js`, whole request-handling pipeline, especially line 172–174:
```js
let body = '';
req.on('data', d => body += d);
req.on('end', () => { ... });
```
and the `/send` (187–209), `/packet` (356–367), `/transfer/*/chunk/*` (230–252) handlers.

**The problem:** There is no `Content-Length` cap, no maximum body size, and no maximum number of live entries in `store` for the general `/send`/`/packet` paths (only `transfer_*` keys get pruned above 100 entries, per lines 666–674). `registerFail()`/IP-blocking (113–133) only triggers on **malformed** requests (missing fields, JSON parse errors) — a well-formed flood of valid `/send` or `/packet` POSTs with arbitrarily large `payload` strings is never rate-limited or size-checked at all, and each concatenates the whole request body into a JS string in memory before parsing.

**Attack path:** A single attacker (no auth required for any of these endpoints) opens many connections POSTing large (multi-MB, repeated) payloads to `/send`/`/packet`. Each is accepted, stored in the shared, unbounded `Map`, and kept until its TTL (up to 33 days for `/signal/offer`/`/reconnect/offer` entries!) — the process's RSS grows without bound until the Node process OOMs or the host swaps to a crawl, taking down the relay for every user, not just the attacker's own conversation.

**Impact:** Full denial of service against the whole relay (all paired users) from a single unauthenticated attacker; some entry types (reconnect/signal offers) live for 33 days, worsening the effect.

**Severity:** High (single point of failure for the whole system's availability; trivial to execute).

**Root cause:** Missing validation — the relay was designed around "small encrypted blobs" but never enforces that assumption.

**Proposed fix:** Enforce a `Content-Length`/streamed body size cap (e.g. reject anything over ~256KB for `/send`/`/packet`, larger only for `/transfer/*/chunk/*` which is already chunked) before buffering; enforce a global cap on `store.size` (evict oldest first) independent of the existing `transfer_*`-only eviction; add per-IP request-rate limiting that also counts well-formed requests, not just malformed ones.

### H-4. Attacker/peer-controlled chunk `total` allows memory-exhaustion crash via a single malicious contact

**Files/functions:** `RTCStore.js` lines 65–81 (`img_chunk` handling: `new Array(msg.total)`), `AudioCrypto.js`/`ImageCrypto.js` chunk reassembly (analogous `new Array(msg.total)` pattern), and the equivalent receive-side buffering for audio (`RTCStore.js` lines 26–38).

**The problem:** `msg.total` comes from the decrypted, but attacker/peer-supplied, chunk-message JSON and is used directly as an `Array` length with no upper bound check:
```js
if (!this.imgBuffer.has(bufKey)) {
  this.imgBuffer.set(bufKey, { chunks: new Array(msg.total), total: msg.total, ... });
}
```

**Attack path:** A paired contact (or anyone who has already achieved the C-1/C-2 MITM) sends a crafted `img_chunk`/`audio_chunk` message with `total: 2_000_000_000`. The receiving client allocates a huge sparse array, likely crashing or freezing the app (native OOM / JS heap exhaustion) with a single message — no need to actually send that many chunks.

**Impact:** Trivial denial of service against a specific victim device, triggerable by anyone who can complete the Kyber handshake with them (a legitimate contact, or an attacker who's already MITM'd per C-1/C-2).

**Severity:** High for reachability (any existing contact can do it with one message) / Medium in isolation.

**Root cause:** Missing validation of peer-controlled size/length fields before using them in allocation.

**Proposed fix:** Clamp `total` to a sane maximum (e.g., based on `CHUNK_SIZE` and a maximum supported file size) and reject/ignore messages exceeding it, on both native and web.

---

## MEDIUM

### M-1. Native PIN lock is a UI gate only — not cryptographically bound to data at rest

**File/function:** `App.tsx` `LockScreen` (817–1000), specifically lines 913–920 (PIN stored via `EncryptedStorage.setItem('app_pin', next)`) and 933 (`if (next === savedPin)` — direct string comparison).

**The problem:** Unlike the web client, where the PIN is combined with a server-held pepper via PBKDF2 to *derive the actual encryption key* for local storage (`web/src/lib/Storage.ts`), the native app's PIN is just a value stored in `EncryptedStorage` and compared for equality. It never participates in deriving the key that protects `shared_secret_<chatId>`, chat history, or contacts — those are protected solely by whatever `react-native-encrypted-storage`/Android Keystore already provides, with or without a correct PIN. The 3/4/5-attempt lockout and wipe (lines 943–998) are enforced entirely in JS.

**Impact:** If Android Keystore protection is ever bypassed (rooted device, physical extraction tooling, a debug/Frida-instrumented build, or a future Keystore vulnerability), the PIN provides **zero additional cryptographic protection** on native, whereas the equivalent web mechanism is explicitly designed to still resist offline brute force in that scenario (modulo C-3). This is a meaningful security-model divergence between the two clients that isn't disclosed anywhere in the UI.

**Severity:** Medium (requires an additional device compromise primitive beyond "read localStorage," but the threat model explicitly includes "stolen/compromised device").

**Root cause:** The two clients were built at different times with different storage primitives (`react-native-encrypted-storage` vs. raw `localStorage`) and the PIN's role was re-implemented from scratch for each rather than kept consistent — web needed the pepper because it lacks a hardware keystore, but the native PIN then never picked up an equivalent "gate that actually protects data," it stayed a leftover comparison check.

**Proposed fix:** Derive the encryption key used for `EncryptedStorage` writes from the PIN as well (e.g., wrap the Keystore-backed key with a PIN-derived key, or use the PIN as an extra authentication factor via `react-native-encrypted-storage`'s underlying Keystore auth-required key if supported), so a PIN is cryptographically necessary, not just a UI speedbump.

### M-2. Relay routing/rendezvous identifiers double as unauthenticated bearer tokens (systemic)

**Files/functions:** `relay.js` — nearly every endpoint (`/reconnect/*`, `/signal/*`, `/packet/*`, `/call/signal/*`, `/transfer/*` DELETE, `/push/register`) accepts a caller-supplied `contactId`/`token`/`recipient` and performs the requested action for **whoever presents that string**, with no proof that the caller is the party who originally established it.

**The problem:** This is the mechanism underlying C-1, C-2, and C-4, called out separately here because it should be fixed structurally rather than endpoint-by-endpoint. Every "who am I talking to" decision on the relay is made by string equality against a value that is either sent to the relay directly (so the relay always knows it) or is deterministically derivable from such a value (so anyone who saw one relay request involving a contact can act as that contact for every other relay endpoint keyed by the same id).

**Severity:** Medium as a standalone architectural note (the concrete exploitable instances are already captured as Critical findings above).

**Root cause:** Convenience — using the same human-meaningful ID for routing and (implicitly) as an authorization credential is simpler than maintaining a separate capability token, but conflates the two.

**Proposed fix:** Separate "routing key" (fine to be relay-visible) from "authorization proof" (must never be relay-visible, e.g. an HMAC of the request using the Kyber-derived shared secret or the pairing PSK as the key). Require the proof on every mutating/read call that isn't supposed to be public.

### M-3. TLS is opt-in and silently falls back to plaintext HTTP

**File/function:** `relay.js` lines 55–64, 637–654:
```js
} else {
  console.warn('[TLS] TLS_CERT_PATH/TLS_KEY_PATH nicht gesetzt - laeuft ungeschuetzt ueber HTTP.');
  server = http.createServer(requestHandler);
}
```

**The problem:** If the operator forgets to set `TLS_CERT_PATH`/`TLS_KEY_PATH` (or the cert fails to load, per the `catch` at 647–650), the relay silently serves plaintext HTTP instead of refusing to start. The current deployment (`RelayClient.js` hardcodes `https://malachii.duckdns.org:5356`) happens to use TLS today, but nothing in the code enforces this, and a misconfigured redeploy would silently downgrade every user to a network attacker being able to read/tamper with all relay traffic (which, per C-1/C-2/C-4, is already sufficient for full compromise even over TLS — over plain HTTP it also exposes message ciphertext metadata and routing IDs to any network observer, not just the relay operator).

**Severity:** Medium (deployment/operational risk rather than a code-level exploit today).

**Root cause:** "Works in dev" default (plaintext HTTP for local testing) was preserved as the production fallback instead of failing loudly.

**Proposed fix:** Make TLS mandatory in any non-explicitly-local mode (e.g. require an explicit `ALLOW_INSECURE_HTTP=1` env var to opt into plaintext, and refuse to bind otherwise), and fail hard (don't fall back) if a configured cert fails to load.

### M-4. No replay protection on relayed packets

**Files/functions:** `MessageCrypto.js`/`.ts` (`encryptMsg`/`decryptMsg`), `relay.js` `/packet`, `/send`.

**The problem:** Each layer is AEAD (authenticated), so tampering is detected, but nothing prevents an attacker who can read relay traffic (or who controls the relay) from **replaying** a previously captured, validly-encrypted packet — there's no sequence number, timestamp-in-ciphertext, or "seen nonce" tracking on the receiving side. Combined with C-4's finding that system packets aren't even encrypted, an attacker could replay an old, legitimately-encrypted "message" packet to re-deliver stale content, or replay an old call `offer` to re-trigger a call notification.

**Severity:** Medium (requires an attacker with relay-read access, already a listed threat actor).

**Root cause:** Design gap — AEAD confidentiality/integrity was treated as sufficient without also covering freshness.

**Proposed fix:** Include a monotonic per-chat counter or timestamp inside the encrypted payload and reject/deduplicate on receipt.

---

## LOW / INFORMATIONAL

### L-1. Verbose logging of security-relevant values
Both `WebRTCManager.js` (`console.log('[WebRTC] Safety Code:', this.safetyCode)`, line 306/328) and many other call sites log tokens, contact IDs, and derived values to the console/logcat. On a debuggable build, or a device with `adb logcat` access, this leaks metadata (and, for the Safety Code, a value that's meant to be manually verified out-of-band, not sitting in logs where a co-located attacker could read it and pre-empt/spoof the verification). Recommend stripping/guarding these logs in release builds.

### L-2. `google-services.json` committed to the repository
`android/app/google-services.json` is tracked in git (`git ls-files`). Google's guidance is that this file is not strictly secret, but it does identify the Firebase project and should have API-key restrictions applied server-side (Firebase console) since it will be visible to anyone with repo access, including if the repo is ever made public. Verify restrictions are configured; not a code fix.

### L-3. Self-destructing "Secret Chat" is enforced client-side only
Expected/inherent limitation of any E2EE messenger (nothing stops a modified client, screenshot, or a device that already received the plaintext from retaining it), but worth stating explicitly since the feature name implies stronger guarantees than the architecture can provide. Consider adding this caveat to the in-app UI copy.

### L-4. IP-based abuse protection is coarse and spoofable
`relay.js`'s `checkIP`/`blockedIPs` keys purely off `req.socket.remoteAddress`. Behind typical NAT/proxying this can both over-block (shared IP) and under-protect (attacker rotates source IPs / uses a botnet). Not a fix-now item, just noted as a limitation of the current abuse-prevention design given the DoS findings above.

---

## Second pass — attacker's-eye re-examination

Re-reading everything above with "what did I wave through the first time" in mind:

- **The fresh-per-session Kyber keypair generation (`WebRTCManager.js` `channel.onopen`) initially reads as good PFS hygiene.** On reflection, freshness is irrelevant without authentication: because the Kyber exchange is not bound to any long-term identity or signed by anything, an active MITM (which C-1/C-2 show is achievable) just performs two separate, equally-fresh Kyber exchanges — one with each victim — and the "ephemeral key" property does nothing to stop this. The generated Safety Code (`_computeSafetyCode`) is the *only* thing that could catch this, and nothing in the product prompts users to check it, especially not on silent background auto-reconnects, which are exactly where C-1 bites.
- **The triple-layer AES-GCM → ChaCha20-Poly1305 → XSalsa20-Poly1305 construction initially reads as strong defense-in-depth.** On reflection, all three layers are keyed via HKDF from the *same single* Kyber shared secret (`deriveKeys()` in `MessageCrypto.js`/`.ts`). If that one secret is ever recovered — which C-1's MITM and H-1's persistence both make realistic — all three layers fall simultaneously. The triple-layering only helps against a hypothetical cryptanalytic break of one specific primitive; it provides no additional protection against the far more realistic threats (key exfiltration, MITM) identified in this review. Not a vulnerability per se, but the "post-quantum triple-layer" framing overstates the practical security margin relative to a single well-implemented AEAD under the same key-management model.
- **`relay.js`'s intrusion-detection/IP-blocking initially reads as reasonable abuse prevention.** On reflection (H-3), it only fires on malformed requests, so it does nothing against a well-formed flood — the exact traffic pattern a competent attacker would send. First-pass read gave it too much credit.
- **The TURN credential scheme (`relay.js` `/turn-credentials`, time-limited HMAC username/credential) was checked closely and is sound** — standard coturn `--use-auth-secret` pattern, `TURN_SECRET` never leaves the server, credentials expire in 6h. No finding here; flagged in the first pass and confirmed fine on the second.
- **Assumed the call-signaling encryption fix (`CallManager.js`) fully closed the call-MITM hole because the code comment says so.** On reflection (documented as H-2), it only closes it when a shared secret happens to already be present, and — more importantly — even when present, that secret may itself be one an attacker negotiated via C-1, so the call-signal encryption fix protects against a *new* MITM but not against one who already owns the underlying shared secret. Worth stating plainly: H-2's fix is necessary but not sufficient without also fixing C-1.
- **Initially treated `/pepper/register`'s 409-on-existing-deviceId as adequate protection against pepper overwrite races.** True as far as it goes, but on reflection the deeper issue (C-3) is that `/pepper/request` needed scrutiny, not `/pepper/register` — the register endpoint was a red herring that looked "protected" while the actually-exploitable endpoint sat two lines below it.
- **Google-services.json and the debug keystore initially looked like they might be committed secrets.** On checking, `debug.keystore` is the standard, non-sensitive RN/Android debug-signing keystore (well-known password), and no `secrets.local.js`/TURN_SECRET/production keystore was found in git history via `git log --all -p`. Secret hygiene around `TURN_SECRET` specifically is good and should be called out as a positive, not just an absence of findings.
