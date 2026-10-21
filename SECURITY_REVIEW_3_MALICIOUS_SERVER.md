# Security Review 3 — Malachi under a FULLY MALICIOUS relay.js

**Threat model for this review:** the relay operator is actively adversarial. It may
arbitrarily modify, delay, delete, replay, or reorder any data; give different clients
different/inconsistent answers; withhold messages; replay old messages; tamper with
user/device data; swap public keys; influence sessions; manipulate push data; fake
online/offline status; and collect metadata. This is **not** a passive-eavesdropper
review — every finding below assumes the operator runs modified code, ignores its own
advertised TTLs/deletion promises, and actively tries to break things.

Scope read for this review: `relay.js`, `MessageCrypto.js`/`.ts`, `WebRTCManager.js`/`.ts`,
`CallManager.js`/`.ts`, `RelayClient.js`/`.ts`, `RTCStore.js`, `ImageCrypto.js`,
`AudioCrypto.js`, `App.tsx` (native, pairing/reconnect/phone-connect/attachment code
paths), `web/src/App.tsx`, `web/src/lib/*`, `pushSender.js`,
`android/.../MalachiFirebaseMessagingService.kt`. This builds on, and does not
re-litigate, the fixes already verified in `SECURITY_REVIEW_2_CRYPTO.md` (C-1..C-4,
H-2, domain separation) — those are treated as ground truth and re-examined only
through the "what can a fully malicious operator additionally do" lens.

---

## 1. Can it read message content?

**Answer: No**, for text, images, audio and system-control payloads — with one
metadata-adjacent caveat (attachment MIME type/category, see below).

**Mechanism:** every payload the relay ever stores or forwards is opaque ciphertext
produced by the three-layer AEAD (`AES-256-GCM` → `ChaCha20-Poly1305` →
`XSalsa20-Poly1305`, keys HKDF-derived from the Kyber-768 shared secret, never sent
to the relay). This holds uniformly across every relay-touched code path:

- `/send` + `/receive/*` — **dead code**, not called from `App.tsx` or `web/src/App.tsx`
  (grep confirms zero call sites besides their own definitions in `RelayClient.js`/`.ts`).
  All real store-and-forward traffic goes through `/packet`.
- `/packet` (text messages, `transfer_ready` pointers, `delete_chat`/`secret_start`/
  `secret_end`): relay.js:373-394 stores/returns `payload` verbatim — `{ type:'encrypted', data: enc }`
  where `enc` is the AEAD ciphertext (e.g. App.tsx:794, :1841, :1974).
- `/transfer/{token}/chunk/{index}` (offline image/audio): relay.js:246-268 stores
  `data` (ciphertext) exactly as given; each chunk is independently AEAD-encrypted
  before ever reaching `sendTransferChunk()` (`ImageCrypto.js:22-28`,
  `AudioCrypto.js:22-27`).
- `/reconnect/offer|answer`, `/signal/offer|answer`, `/call/signal`: all carry either
  PSK-encrypted or shared-secret-encrypted SDP/ICE blobs (see Q4).
- `MessageCrypto.js:64-93` / `.ts:49-77` — `encryptMsg()` is the only thing that ever
  produces what the relay stores; relay.js's own comment says it plainly:
  `payload, // bereits verschlüsselt von der App` (relay.js:214).

**Caveat — attachment metadata leaks in cleartext:** `sendTransferChunk()`
(`RelayClient.js:76-85`) posts `{ data, total, mimeType, transferType, chatId }` where
only `data` is ciphertext. `relay.js:252-263` stores `mimeType`, `transferType`
(`'image'`/`'audio'`) and `chatId` **unencrypted**. So while the relay cannot read an
image or hear a voice note, it directly learns: which contact-relationship the
attachment belongs to, whether it's an image or an audio message, and the exact MIME
subtype (e.g. `image/png` vs `image/jpeg`) — for every single attachment, always.

**Severity:** Low (the caveat is metadata, not content) for the main question; the
core "can it read the message" answer is a solid No.

---

## 2. Can it modify messages in transit?

**Answer: Partial.** Per-message/per-chunk tampering is reliably detected and
rejected everywhere (AEAD authentication, fail-closed). **But the multi-chunk
offline-transfer reassembly protocol has no cross-chunk integrity binding**, which
lets a malicious relay silently splice in old, validly-encrypted chunks to corrupt a
reassembled image/audio message without any individual check failing.

**Where tamper-detection DOES hold (fail-closed, verified):**
- `WebRTCManager.js:337-343` / `.ts:276-289`: `decryptMsg()` failing → message
  silently dropped (`if (plaintext) { ... }`, no `else` fallthrough).
- `WebRTCManager.js:395-402` / `.ts:292-299`: any non-Kyber-handshake plaintext
  fallthrough is explicitly warned and discarded (this is the C-4 fix).
- App.tsx `checkIncoming` `/packet` consumption (~582-631): `type:'encrypted'`
  packets are only acted on after a *successful* `decryptMsg`.
- `CallManager.js:237-256` / `.ts:183-198`: a signal without `.enc`, or one that
  fails to decrypt, is discarded (H-2 fix holds for a malicious relay too — it
  cannot forge a call signal that decrypts without the shared secret).

**Where it does NOT hold — offline image/audio transfer splicing:**
`relay.js:246-268` keys each chunk purely by numeric `index` parsed from the URL,
with **no binding between the chunk and the transfer `token` it's filed under**
beyond that URL path. The AEAD only authenticates each chunk's own JSON payload
(`{type, imageId/audioId, index, total, data, mimeType}`) — it authenticates that
*a* legitimately-encrypted chunk was produced under this shared secret at some point,
not that it belongs to *this* transfer.

Reassembly (App.tsx:564-578, the `transfer_ready` handler) is:
```js
for (let i = 0; i < transfer.total - 1; i++) {
  const plain = dm(transfer.chunks[i], secret);
  if (plain) { const c = JSON.parse(plain); chunks[c.index] = c.data; }
}
```
This never checks that `c.imageId` matches `endMsg.imageId` for the final end-chunk.
Because **all** message types between two contacts (text, image/audio chunks, system
packets) share the same long-lived Kyber shared secret and the same default
`purpose='message'` HKDF domain (`MessageCrypto.js:56`, no per-attachment
sub-domain), any chunk the relay has ever seen from *any* prior image/audio transfer
between the same two users remains a validly-decryptable, self-consistent
`{index, data}` object.

**Concrete attack, step by step:**
1. Relay operator retains ciphertext of chunk(s) from an earlier legitimate image
   transfer between Alice and Bob (trivial — it already stores every chunk it
   relays; it does not have to honor its own advertised 24h/10min TTLs, since that
   "cleanup" is just its own code).
2. On a *later* transfer, when Alice POSTs new chunks to `/transfer/{newToken}/chunk/{i}`,
   the relay stores an old retained chunk at index `i` instead of (or alongside,
   overwriting) the one Alice actually sent.
3. Bob's client fetches `/transfer/{newToken}`, sees `chunkCount >= total` (relay.js:277-286),
   decrypts every chunk successfully (each one is a *real*, AEAD-valid chunk — just
   from the wrong transfer), and reassembles `chunks.join('')` into a corrupted /
   partially-wrong image or audio clip, displayed to Bob as if it were exactly what
   Alice sent just now.
4. No error, no warning: every individual AEAD check passed.

**Severity:** Medium. It requires the two victims to have exchanged at least one
prior image/audio (to give the relay material to splice from), and the attacker
cannot inject arbitrary *new* content this way (every spliced chunk must be a chunk
the relay genuinely saw at some point) — but it is a real, silent integrity break of
the reassembled artifact, invisible to both users, on a code path that exists
specifically because the relay is in the data path (offline delivery).

**Fix recommendation:** established primitive, no new protocol needed — bind
`imageId`/`audioId` and `token` into the AEAD associated data (or re-verify
`c.imageId === endMsg.imageId` for every chunk before accepting reassembly), and
give image/audio chunk encryption its own HKDF `purpose` (e.g. `'attachment'`)
domain-separated from the rest of Review 2's `purpose` mechanism.

---

## 3. Can it forge messages / impersonate a user without compromising a device?

**Answer: No for content forgery** (AEAD prevents producing anything that decrypts
without the shared secret). **The deeper question — can it become a permanent MITM
during the initial Kyber exchange — is also No, but only because the out-of-band
secret never transits the relay; if that out-of-band channel is itself compromised,
the relay-level protections don't help.**

**Mechanism:** the actual Kyber-768 public key and ciphertext (the material that
establishes the shared secret) are exchanged **directly over the already-open P2P
DataChannel**, never through relay.js:
- `WebRTCManager.js:181-186` / `.ts:141-144`: `kyber_pubkey`/`kyber_ciphertext` are
  sent plaintext, but *only* over `this.dataChannel.send()` — a live WebRTC data
  channel the relay is not a party to.
- `WebRTCManager.js:264-335` / `.ts:220-274`: the full encapsulate/decapsulate
  exchange happens in `channel.onopen`/`channel.onmessage`, again purely P2P.

For the relay to intercept *that* exchange, it would need to make itself one of the
two actual WebRTC endpoints — i.e. win the SDP/DTLS-fingerprint swap. That requires
tampering with the SDP offer/answer in transit, and every pairing flow protects that:

| Flow | SDP protected by | Relay sees |
|---|---|---|
| QR/deep-link pairing | 16-byte PSK, shared **only** via QR/deep-link, never sent to relay (App.tsx:2816-2833) | opaque token + ciphertext it cannot decrypt |
| Reconnect (C-1) | already-established Kyber shared secret, `purpose='reconnect'` | opaque ciphertext, no secret |
| Phone-connect (C-2) | SHA-256(`both phone numbers`) PSK, independent HKDF domain from the rendezvous hash | opaque ciphertext, unless it also knows both numbers (documented, inherent limit) |

Tampering with any of these ciphertexts causes `decryptMsg` to fail on the receiving
side, which is treated as "possible attack, ignore and keep waiting" everywhere this
was checked (e.g. App.tsx:508, :690, :780). So the relay cannot swap the DTLS
fingerprint undetected in any of the three flows **without already knowing the
relevant secret** — and if it knows the secret, that's a failure of the out-of-band
channel, not of anything relay.js does.

**Severity of the residual risk:** Informational/Low for relay.js itself. The
underlying architectural gap — Kyber exchange has no long-term identity binding, and
nothing prompts users to compare the Safety Code (already flagged in Review 2, and
web doesn't even surface it) — remains the real exposure, but it requires compromise
of the out-of-band pairing channel (QR image, deep link, or knowledge of both phone
numbers), not just relay.js control. **Fix recommendation:** this needs a real
authenticated key exchange / long-term identity verification scheme (e.g. mandatory
Safety-Code confirmation gating first use, or a proper AKE with persistent identity
keys) — not a relay.js patch.

---

## 4. Can it MITM?

**Answer: No for content** (see Q3 — every key-exchange-relevant value the relay
actually touches is protected by a secret it doesn't have). **Yes for a narrower
class of routing/session interference**, via two concrete, relay-controlled
weaknesses in how pairing sessions are identified.

**Every point the relay touches key-exchange-relevant data:**
1. `/signal/offer`, `/signal/answer` — PSK-encrypted SDP (protected).
2. `/reconnect/offer`, `/reconnect/answer` — shared-secret-encrypted SDP (protected).
3. `/packet` carrying `phone_connect_offer`/`phone_connect_answer` — phone-PSK-encrypted SDP (protected, with documented inherent limit).
4. `/phone/register`, `/phone/lookup` — carry the **rendezvous hash in cleartext**
   (`hash = SHA256('malachi_2026_phone_' + sorted numbers)`, App.tsx:2595-2609) —
   by design, needed for routing; does not expose the separate PSK
   (different HKDF/SHA-256 domain, App.tsx:2621-2632).
5. Kyber pubkey/ciphertext itself — **never transits relay.js at all** (Q3).
6. TURN credentials (`/turn-credentials`, relay.js:678-690) — the relay operator
   also controls the coturn server the credentials are for (`TURN_HOST`,
   `WebRTCManager.js:55` / `.ts:28`). If ICE ends up relay-routed, the operator sees
   ICE traffic timing/volume but still cannot read or rewrite the DTLS-protected
   DataChannel payload, and cannot swap the DTLS fingerprint without breaking the
   already-protected SDP.

**Finding A — `/phone/register` and `/phone/lookup` have no authentication tying a
request to a real second participant.** `/packet` POST (relay.js:373-383) accepts
any `{payload, recipient}` with zero proof of prior registration. A malicious relay
can therefore freely control who is told they're "initiator" vs "responder," or
simply never report a match to either side, or report a match to only one side —
pure session-disruption, not content exposure. Covered further under Q7.

**Finding B — low-entropy, relay-visible routing identifiers create a real
collision surface.** For QR/code pairing, `contactId = 'c_' + token`, where `token`
is only **8 hex characters (32 bits)**, truncated from the Kyber-pubkey-derived
short code:
```js
// App.tsx:2809-2811
const hex = Array.from(publicKey.slice(0,6)).map(...).join('').toUpperCase();
const tokenHex = hex.replace(/[^A-F0-9]/g, 'X').slice(0,8);   // 32 bits
```
That `contactId` becomes the **permanent** routing key for `/reconnect/offer/{contactId}`,
`/call/signal/{contactId}/*`, and `/push/register` for the lifetime of the contact
(App.tsx:2860, :2922). With only 2^32 possible values, the relay's single shared
`store` Map (relay.js:67) will start genuinely intermixing two unrelated pairs'
reconnect/call/push queues around the ~65,000-pairing birthday bound — and a
malicious operator can deliberately force an earlier collision by grinding Kyber
keypairs offline until its own token matches a specific targeted victim's
`contactId`, then feed garbage/duplicate data into that shared namespace key. This
does **not** break confidentiality (payloads still require the correct shared secret
to decrypt) — decryption under the wrong key just fails closed — but it is a
concrete, exploitable DoS/confusion surface on session routing.

Separately, the phone-connect flow generates its `myId` with
`'c_' + Math.random().toString(36).slice(2, 10)` (App.tsx:2644) — **`Math.random()`,
not a CSPRNG** — the same class of weakness that was already identified and fixed
for `generateContactId()` (App.tsx:72-93, "War vorher... NICHT sicher: Math.random()
ist kein kryptographisch sicherer Zufallsgenerator") but was apparently not ported
to this second, parallel ID-generation site.

**Severity:** Medium (routing/DoS collision surface, not content MITM).
**Fix recommendation:** use the existing `generateContactId()` (native's secure
`KyberModule.randomBytes`-based generator, or `crypto.getRandomValues` on web) for
*every* contactId generation site, and widen the QR-pairing token to at least 16
bytes / 128 bits so it is not the weakest link in the identifier space.

---

## 5. Can it replay old messages?

**Answer: Yes, for the two things that matter most (regular chat text and
attachment pointers) — this is the single most impactful finding in this review.**
C-4's timestamp check is narrowly scoped and does **not** cover them.

**What IS protected (C-4, confirmed, App.tsx:603-606):**
```js
const isSystemControl = original.type === 'system' &&
  ['secret_start', 'secret_end', 'delete_chat'].includes(original.subtype);
if (isSystemControl && (!original.ts || Date.now() - original.ts > 15 * 60 * 1000)) {
  // dropped as possible replay
}
```
Only these three subtypes carry and check a `ts` field.

**What is NOT protected:**
- **Regular chat messages** delivered via `/packet` (the actual, used
  store-and-forward path — `/send`/`/receive` are dead code, confirmed by grep).
  In `checkIncoming`'s `else` branch (App.tsx ~626-630), any successfully-decrypted
  `type:'encrypted'` payload that isn't one of the three system subtypes is pushed
  straight into `RTCStore.buffer` with **no timestamp, no nonce, no message-id
  dedup check of any kind**. A malicious relay that has ever seen (and, being
  malicious, permanently retained) a legitimately-encrypted chat message can
  literally POST that exact same payload to `/packet` again — today, next week,
  whenever — and it will decrypt successfully and be displayed as a brand-new
  incoming message.
- **`transfer_ready` system packets** (App.tsx:1841, :1974) — these ARE `type:'system'`,
  but their `subtype` is `'transfer_ready'`, which is **not** in the
  `['secret_start','secret_end','delete_chat']` allowlist, so they get **no**
  freshness check either (App.tsx:550-581 handler runs unconditionally). A relay
  can replay an old `transfer_ready` pointing at an old (relay-retained, TTL
  ignored) `/transfer/{token}` to redeliver an already-seen image/audio message as
  if new.
- Reconnect offer/answer and call-signal payloads also carry no `ts`, but their
  blast radius is smaller: replaying a stale reconnect SDP just re-triggers a full
  WebRTC handshake (which always regenerates a fresh Kyber keypair on
  `channel.onopen`, so no stale key material is reused for content), and a
  replayed call offer/ICE is largely constrained by the WebRTC state machine and
  the receiving `CallManager`'s state guards (e.g. `if (this.state !==
  CallState.OUTGOING_RINGING) break;`, CallManager.js:270) — real but a nuisance
  (see Q7/Q9), not content exposure.

**Severity: High.** No message-level replay protection exists on the one code path
that carries actual conversation content when a recipient is offline — which is
exactly the scenario the `/packet` fallback exists for. A resurfaced old message
(a private disclosure, a past instruction, a stale "yes") displayed as freshly
received is a meaningful, direct harm to the user, and there is nothing in the
client to catch it (no per-message id/counter is even embedded in the plaintext
today, so client-side dedup isn't possible without a protocol change).

**Fix recommendation:** established primitive — embed a strictly-increasing
per-conversation counter or a `ts` (checked against a short freshness window, same
as C-4) plus a small "seen recently" nonce cache into every message, not just the
three system subtypes; extend the same allowlist logic in App.tsx:603-606 to cover
`transfer_ready` and ordinary chat payloads, and mirror it in `web/src/App.tsx`'s
`checkOfflinePackets` (see Q6 note below — web currently has **no** such check at
all, for anything).

---

## 6. Can it swap public keys / inject devices?

**Answer: There is no device concept at all — `contact.id` (and its one associated
Kyber shared secret) *is* the identity unit.** The relay cannot inject a second
"device" for an existing contact through relay.js alone; it can only ever win the
identity for a `contact.id` by defeating the out-of-band secret of the very first
pairing (Q3) — and if it ever does, there is no separate layer to detect or revoke
that illegitimate party afterward.

**Evidence there is no multi-device layer:** UI copy explicitly states
`'Consumer · 1 Gerät · Lebenslang'` ("1 device", App.tsx:3354); no linked-device,
device-list, or device-revocation code exists anywhere in `App.tsx` or
`web/src/App.tsx` (grep for "device"/"Gerät" found nothing else relevant). Every
pairing (QR, reconnect, phone-connect) creates exactly one `contact.id ↔ shared
secret` binding, persisted in `RTCStore.sharedSecrets` / `EncryptedStorage
shared_secret_<id>` and reused indefinitely (no rotation, confirmed already in
Review 2 as "no forward secrecy" / "no PCS").

**Consequence:** because identity == the shared secret established at first
pairing, and nothing ever re-verifies it (the Safety Code exists —
`_computeSafetyCode`, WebRTCManager.js:422-434 / `.ts:321-333` — but nothing in the
UI *prompts* users to check it, and web doesn't display it at all, per Review 2), a
successful one-time compromise of the out-of-band pairing channel is permanent and
undetectable: the illegitimate party simply *becomes* "the contact" for that
`contact.id` forever, with no second device slot, no indicator, and no way for the
real user to later distinguish "my original contact" from "whoever won the very
first Kyber exchange." Every subsequent reconnect (Q4/Q5) re-derives a fresh Kyber
secret each time a new DataChannel opens, but always with whichever party already
holds the *previous* shared secret — so an illegitimate holder stays entrenched
across all future reconnects.

**Severity:** High as an architectural gap (restates/sharpens Review 2's
no-authentication finding specifically from the "device injection" angle), but the
relay alone cannot trigger it without also compromising the out-of-band pairing
channel — so it is not something relay.js can do unilaterally today.

**Fix recommendation:** needs a real identity/authentication layer (persistent
identity keys + mandatory-on-first-use Safety Code confirmation, or a proper
authenticated key exchange), not a relay-side patch — consistent with Review 2's
conclusion.

---

## 7. Can it influence sessions?

**Answer: Yes, extensively — for availability/routing, not content.** The relay is
authoritative for every rendezvous decision (who's initiator/responder, whose
GET returns what) and nothing detects it lying.

**Force renegotiation:** trivial — withhold a legitimate reconnect-answer and the
initiator retries forever on its own 15s/10s interval (App.tsx:526,
`web/src/App.tsx:127`) with no backoff limit besides the per-attempt 30-min window.

**Deny one party while accepting the other (selective black-holing):** every
GET/POST pair (`/packet/{recipient}`, `/reconnect/offer/{contactId}`,
`/call/signal/{contactId}/{direction}`) is independently servable. The relay can
honestly store what Alice POSTs while simply always returning an empty result to
Bob's GETs for that key — Alice's send always "succeeds" (POST handlers just
`res.end(JSON.stringify({ok:true}))` after storing, relay.js:220/:382/:407, no
delivery confirmation loop back to sender), Bob never receives anything, and neither
side sees an error (client code wraps these calls in `.catch(() => {})`/silent
`try/catch` throughout `RelayClient.js`, `App.tsx`). This is a durable, silent,
fully asymmetric denial of service against one specific party in a conversation.

**Split-brain:** only in the availability sense above (the relay decides who talks
to whom and when), **not** in the content sense — the relay cannot fabricate
believable content for either side without the shared secret (Q1-3), so it cannot
make both users believe they're having a real conversation with each other while
actually both talking to the server. It *can* make each side believe the *channel*
is healthy (its own POSTs succeed) while the *conversation* is dead.

**Severity:** Medium-High for availability/reliability; no content confidentiality
or integrity impact.

---

## 8. Can it manipulate push data?

**Answer: Payload content is genuinely opaque (no leak there), but the relay has
unrestricted, unilateral control over *when* wake signals fire — it can fabricate
fake incoming-call notifications and silently suppress real ones.**

**Payload is minimal by design, confirmed:**
- `pushSender.js:34-44`: `data: { reason }` only, `reason ∈ {'incoming_call','message'}` —
  explicitly a `data`-only FCM message, no `notification` field, no contact id, no content.
- `MalachiFirebaseMessagingService.kt:27-40`: reads only `message.data["reason"]`; on
  `"incoming_call"` shows a generic full-screen wake notification
  (`CallWakeHelper.showWakeNotification`), on `"message"` does nothing extra.

**But the relay fully controls the trigger, not just the transport:**
- `triggerWake()` (relay.js:114-120) is server-side code the malicious operator
  fully controls; nothing about the FCM call itself requires a genuine pending call
  offer to exist. A malicious deployment can call `pushSender.sendWake(token,
  'incoming_call')` for any registered token at any time — **fake incoming-call
  notification / harassment DoS**, no correlation to reality required.
- Conversely, the relay can simply not call `triggerWake` (or make it a no-op) even
  though a real call offer is sitting in `store` (relay.js:640-650) — the intended
  recipient's backgrounded/killed app never wakes, never polls, and misses the call
  silently; the offer just expires 2 minutes later (`EXPIRE_CALL`) with zero
  user-visible failure — **real-call suppression**.
- `pushTokens.set('${contactId}_${direction}', fcmToken)` (relay.js:607) means the
  relay always knows exactly which push token belongs to which contact-relationship
  and role — a metadata item (see Q10), not a content leak.

**Severity:** Medium. No content/metadata-in-payload leak, but full
availability/integrity control over the call-wake signal itself.

---

## 9. Can it fake online/offline / presence?

**Answer: There is no presence feature in the protocol at all — nothing to fake.**
`isOnline` (e.g. App.tsx:1816, :1943-1945) is derived **purely locally** from
`RTCStore.isConnected(chatId)` (own `dataChannel.readyState`/`iceConnectionState`)
to decide whether *this* device should attempt a live P2P send or fall back to
`/packet` — it is never transmitted to, or queried from, the relay, and never shown
to the other party as a presence indicator. There is no `/presence`,
`/online`, or `lastSeen` endpoint in `relay.js`, and no such field anywhere in the
contact/chat UI state (grep for "online"/"presence"/"lastSeen" in `App.tsx`
confirms no such concept beyond this local connectivity check).

That said, the relay can still produce an equivalent *effect* by the same
mechanism as Q7: since a contact only *appears* reachable to the user when a
reconnect/handshake actually succeeds, a relay that selectively withholds
reconnect-offers/answers for one party can make that contact look permanently
"unreachable" (never connects), or conversely accept everything to make a contact
look "reachable" even if the real device is gone — but this is a side effect of
routing control, not a manipulation of any explicit presence signal, because none
exists.

**Severity:** N/A / Informational (feature does not exist).

---

## 10. What metadata can it collect regardless of any fix?

Definitively, and regardless of any of the crypto fixes already verified:

- **IP addresses** of every client on every request (`req.socket.remoteAddress`,
  used directly in `checkIP`/`registerFail`, relay.js:129-149, 166).
- **Contact-relationship graph**: which `contactId`/`recipient`/`hash` values
  recur together over time (pairing via `/signal/offer/{token}` then ongoing
  `/reconnect/*`, `/call/signal/*`, `/packet/*` under the same `contactId`)
  directly exposes who is paired with whom and how active/dormant each
  relationship is.
- **Timing**: every message/call/reconnect event is individually timestamped by
  the relay's own request handling regardless of any client-side padding.
- **Attachment category and exact size class**: `mimeType`/`transferType`/`chatId`
  are sent **unencrypted** on every `/transfer` chunk upload (relay.js:252-263,
  `RelayClient.js:76-85`) — the relay always knows "this is an image (image/png)"
  vs "this is a voice note," per contact, per message. Additionally `total` (chunk
  count, relay.js:258) directly reveals attachment size to within the fixed 64KB
  chunk granularity (`ImageCrypto.js:9`, `AudioCrypto.js:8`) — this is **not**
  inferable-only, it's stored and returned in cleartext on every
  `GET /transfer/{token}` (relay.js:278-286).
- **Cover-traffic padding does NOT uniformly hide size** — precisely scoped answer
  to the question asked: `padToBlock`/`COVER_INTERVAL_MS` (WebRTCManager.js:19-41,
  436-453 / `.ts:12-21, 335-343`) only applies to the **live P2P DataChannel**
  `sendMessage()` path for regular chat messages, and only while
  `dataChannel.readyState === 'open'`. It does **not** apply to:
  - the `/packet` offline fallback for regular text messages (ciphertext length
    varies directly with plaintext length, no padding, no cover traffic while
    offline);
  - `/transfer` image/audio chunks (fixed 64KB chunking reveals size class
    directly via `total`, as above — chunking is a different mechanism from
    `padToBlock` and isn't uniform-size cover traffic);
  - reconnect/signal/call-signal SDP and ICE blobs (no padding at all).

  So the uniformity guarantee is real but narrow: it defeats size-based traffic
  analysis only for real-time text chat between two currently-P2P-connected peers,
  not for attachments, not for offline messaging, not for signaling.
- **Push token ↔ contact-relationship ↔ role mapping**
  (`pushTokens.set('${contactId}_${direction}', fcmToken)`, relay.js:607) — ties a
  Google/Apple push identity directly to a specific contact pairing and calling
  role.
- **Call timing/duration via TURN correlation**: `/turn-credentials` requests
  (relay.js:678-690) are time-correlated with call attempts, and the same operator
  controls the `TURN_HOST` coturn server the credentials are issued for
  (`WebRTCManager.js:55`/`.ts:28`) — even though SRTP/DTLS keeps call audio
  unreadable, ICE-relay traffic volume/timing through that same-operator
  infrastructure closely approximates call start/end/duration per contact pair.
- **Weak-entropy, self-issued transfer tokens**: `Math.random().toString(36).slice(2,14)`
  (`ImageCrypto.js:14`, `AudioCrypto.js:17`) — moot for a malicious relay (it
  already owns every token it issues) but flagged as a defense-in-depth
  inconsistency with the already-fixed `generateContactId()`.

**Severity:** Medium-High cumulative — no message content leaks, but the relay
builds a precise, timestamped social graph with attachment-category/size
fingerprints and call-timing correlation, which is a serious metadata exposure for
a "no accounts, no logs" messaging product whose entire value proposition is
"the relay is a dumb, blind pipe."

---

## Executive summary — worst 3–5 findings, ranked

1. **(High) No replay protection on regular chat messages and `transfer_ready`
   attachment pointers relayed via `/packet` (Q5).** This is the most directly
   user-harmful gap: a malicious relay can resurface any previously-seen encrypted
   text message or image/voice-note pointer at any future time, and it will be
   decrypted and displayed as newly received, with zero client-side defense (no
   message id, counter, or timestamp exists on this path). C-4's freshness check
   only covers `secret_start`/`secret_end`/`delete_chat` — three subtypes out of
   the whole message space.

2. **(High, architectural) No device/identity layer — `contact.id` and its one
   Kyber secret *are* the identity, with no re-verification prompt (Q3/Q6).** A
   one-time compromise of the out-of-band pairing secret (QR image, deep link, or
   both phone numbers) is permanent and undetectable; nothing prompts Safety Code
   comparison, and web doesn't even display it. This is a restatement of Review 2's
   core finding, confirmed here to also mean there is no way to detect or revoke an
   illegitimately-injected "device" after the fact.

3. **(Medium) Offline image/audio transfer reassembly has no cross-chunk integrity
   binding (Q2).** A malicious relay can splice previously-seen, validly-encrypted
   chunks from an earlier transfer into a new one, producing a silently-corrupted
   attachment that passes every individual AEAD check. AEAD authenticates chunks,
   not transfers.

4. **(Medium-High) The relay can silently, durably, and selectively deny service
   to one party in a conversation while appearing to function normally to the
   other (Q7), and can fabricate or suppress call-wake push notifications at will
   (Q8).** Neither breaks confidentiality, but both are serious, easily-exercised
   availability/integrity attacks a "trust-nothing" design should not permit
   invisibly.

5. **(Medium) Low-entropy / non-CSPRNG routing identifiers create a genuine
   collision surface (Q4).** The 32-bit QR-pairing token (and its derived,
   permanent `contact.id`) and the `Math.random()`-based phone-connect id are weak
   enough that a moderately-resourced malicious relay can force or benefit from
   collisions across unrelated pairs' reconnect/call/push queues — a real gap the
   already-fixed `generateContactId()` should have been applied to uniformly.

Metadata collection (Q10) is comprehensive and, by the app's own "no logs, blind
pipe" design goal, arguably the most consequential *systemic* issue, but it is
distinct in kind (inherent to any centralized rendezvous relay) rather than a
discrete bug — noted here rather than ranked alongside the above.
