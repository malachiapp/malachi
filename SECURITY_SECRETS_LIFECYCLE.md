# Secrets Lifecycle Audit — SecureCommApp ("Malachi")

**Scope:** full lifecycle (create → memory → disk → access → deletion) of every
secret-shaped value in this codebase, plus unintended-copy vectors (logging,
serialization, caching, IPC, notifications, clipboard, analytics). Read-only,
adversarial, following the same rigor as `SECURITY_AUDIT_CRYPTO_CLAIMS.md` and
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`. Those two documents, plus
`SECURITY_STATE_MACHINES.md` and `SECURITY_CHAOS_TESTING.md`, are treated as
established background and **not re-derived** here except where this pass's
specific lens (secrets lifecycle, not protocol correctness or state machines)
turned up something they didn't examine.

**Verdict legend** (same as prior audits): **PROVEN** (demonstrated by reading
the actual code path, no ambiguity) / **DESIGN GOAL** (intended and
implemented, not adversarially exercised) / **ASSUMPTION** (depends on
something the code can't verify, e.g. OS/library behavior) / **UNVERIFIED
CLAIM** (asserted somewhere, not confirmed, or contradicted by code) /
**NOT TESTABLE UNDER JEST** (needs a real device).

**Concurrent editing note:** a separate session was fixing `relay.js`
`/phone/register`+`/phone/lookup`, `WebRTCManager.js`/`.ts` Kyber timing,
`web/src/lib/Storage.ts`, and the `App.tsx`/web poll loops while this audit
ran. None of those specific bugs are re-reported here. Line numbers cite the
file content at the time each section was read.

**Files read in full or in the relevant sections for this pass:**
`WebRTCManager.js`/`.ts` (full), `RTCStore.js`/`.ts` (full), `App.tsx`
(LockScreen/wipe ~963-1270, delete-chat ~919-964, message-receive ~605-710,
~1728-1760, audio recording/playback ~1972-2165, image save ~2655-2685, phone
connect ~3220-3260), `web/src/App.tsx` (wipe/unlock ~360-420, message receive
~200-260), `web/src/lib/Storage.ts` (full), `MessageCrypto.js` (header +
`secureRandomToken`/`deriveKeys`), `ImageCrypto.js`, `AudioCrypto.js` (full),
`relay.js` (pepper section, ~93-820), `AndroidManifest.xml`,
`MainApplication.kt`, `KyberModule.kt`, `MalachiNotificationModule.kt`,
`MalachiFirebaseMessagingService.kt`, plus targeted greps across the whole
repo for `console.log/warn/error`, `Clipboard`, `Crashlytics`/`Sentry`/
`Analytics`, `Flipper`, `allowBackup`, `recover`/`prekey`.

---

## 0. Secret-type inventory — what actually exists

Confirmed by reading the protocol code (matches `SECURITY_AUDIT_CRYPTO_CLAIMS.md`):

| Secret type | Exists? | Where |
|---|---|---|
| Long-term identity keys | **No** — confirmed absent, not assumed | No public/private identity keypair anywhere; `my_id` (`App.tsx` setup) is a random, non-cryptographic display identifier, never used as key material (grepped: never passed to `HybridCrypto`/`MessageCrypto`) |
| Session keys (Kyber shared secret) | **Yes** | `sharedSecret` in `WebRTCManager.js`/`.ts`; persisted as `shared_secret_<chatId>` |
| Ephemeral keys (per-handshake Kyber keypair) | **Yes** | `myKyberKeys` in `WebRTCManager.js`/`.ts`, in-memory only, never persisted |
| Prekeys | **No** — checked, not assumed | No prekey-bundle concept anywhere: no pre-generated/published keypairs, no "one-time prekey" store server-side or client-side. Key exchange is fully interactive (both Kyber messages exchanged live over the just-opened DataChannel), unlike Signal-style async prekey bundles. This is consistent with the app having no offline/asynchronous pairing — a contact must be online (or the offer/answer must transit the relay) for the handshake to happen at all |
| Plaintext messages | **Yes** | Decrypted `text`/`image_complete`/`audio_complete` objects, in `RTCStore.buffer`, `ChatScreen` React state, `EncryptedStorage`/`localStorage` `chat_<id>` |
| Decrypted attachments | **Yes** | Full base64 image/audio in `RTCStore.imgBuffer`/`audioBuffer`, temp files under `RNFS.CachesDirectoryPath`/`DocumentDirectoryPath` |
| Auth tokens | **Yes** | Relay pepper `attemptToken` (`relay.js`), TURN HMAC credentials, phone-connect PSK |
| Recovery material | **No** — checked, not assumed | No backup codes, no recovery phrase, no account-recovery flow anywhere (grepped `recover`/`prekey`/`Wiederherstellung`/`backup.?code` repo-wide: zero matches outside this report). Losing the PIN (native) or PIN+pepper (web) is unrecoverable by design — matches the 5-fail wipe's own framing as intentional, not a gap |
| Passwords/passphrases | **Yes** | The PIN itself (native: `app_pin`; web: never stored, only salt/marker/pepper-derived key) |
| Temporary buffers | **Yes** | `RTCStore.audioBuffer`/`imgBuffer` (native), raw microphone recording files, chunk-reassembly `Map`s in `ImageCrypto.js`/`AudioCrypto.js` |

---

## 1. Session keys — `sharedSecret` (Kyber-derived)

**1. Created:** `kyberEncapsulate()`/`kyberDecapsulate()` inside
`WebRTCManager._setupDataChannel().onmessage`, on receipt of
`kyber_pubkey`/`kyber_ciphertext` (`WebRTCManager.js:361-403`,
`.ts:269-299`). Fresh per WebRTC session (every original pairing and every
reconnect) — **PROVEN**, matches `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3.

**2. In memory:** `this.sharedSecret` on the live `WebRTCManager` instance,
and a second copy in the module-level singleton `RTCStore.sharedSecrets`
(`Map<chatId, secret>`) (`WebRTCManager.js:366,397`; `RTCStore.js:14`; same
on web, `WebRTCManager.ts:273,292`, `RTCStore.ts:12`). **Two independent
in-memory copies exist simultaneously** by design (the RTCStore copy is what
survives when a `WebRTCManager` instance is replaced on reconnect).

**3. Persisted:** `EncryptedStorage.setItem('shared_secret_'+chatId, secret)`
(native, fire-and-forget, `WebRTCManager.js:368,400`) / `setItem()` into
web's PIN+pepper-gated AES-GCM store (`WebRTCManager.ts:274,293`, via
`web/src/lib/Storage.ts`).

**4. Duration:**
- In memory: for the life of the `WebRTCManager` instance **and, critically,
  beyond it** — see Finding S-1 below. `close()` on both native and web
  (`WebRTCManager.js:272-287`, `.ts:177-192`) sets `this.sharedSecret = null`
  on the *instance*, but the `RTCStore.sharedSecrets` copy is a **separate**
  reference the instance's `close()` never touches, and is only removed by
  explicit caller code (`App.tsx:941`, `web/src/App.tsx:247` on chat delete).
- On disk: until explicitly overwritten by the next rotation (Claim 3,
  forward-secrecy audit) or explicitly deleted (chat delete, wipe).

**5. Accessible from:** `WebRTCManager` instance, `RTCStore` singleton (any
code with a JS-side reference — no access control inside the process),
`MessageCrypto`/`ImageCrypto`/`AudioCrypto` (passed by value as a function
argument to `encryptMsg`/`decryptMsg`/`sendEncryptedImage`/`sendEncryptedAudio`).

**6. Deleted:** on `close()` (instance copy only), on `RTCStore.sharedSecrets.delete()` +
`EncryptedStorage.removeItem('shared_secret_'+id)` (chat delete,
`App.tsx:941,943`), on rotation (overwritten, not securely wiped — a plain JS
string/Map-value replacement, no zeroing of the old buffer, which is a
structural **ASSUMPTION**: JS strings are immutable and garbage-collected on
GC's own schedule, not deterministically wiped, so the old secret's bytes can
remain in the JS heap/native memory for an indeterminate time after
"deletion" — this is inherent to using JS-string-based key material
throughout the app, not specific to this one path, and is **NOT TESTABLE
UNDER JEST** — no test can assert V8/Hermes heap contents).

**7. Logs:** the raw secret value is **never** logged anywhere (grepped every
`console.log`/`warn`/`error` call site touching `sharedSecret` in both
`WebRTCManager.js`/`.ts` and `RTCStore.js`/`.ts` — all log only status
strings like `'[Crypto] ✅ Shared Secret gesetzt (Responder)'`). **PROVEN**
the literal secret is not interpolated into any log line.

However, a **derived** value that only has meaning because of the secret
**is** logged in full, unconditionally, not `__DEV__`-gated:
- `WebRTCManager.js:381,408`: `console.log('[WebRTC] Safety Code:', this.safetyCode)`
  — `safetyCode` is `SHA-256(sharedSecret)` truncated to 16 digits
  (`_computeSafetyCode`, `WebRTCManager.js:526-538`). One-way hash, so this
  is not a confidentiality leak of the secret itself, but it **does** leak
  the exact value the Safety-Code MITM-detection feature (Claim 5,
  crypto-claims audit) depends on being verified out-of-band — anyone with
  log access (Metro console in dev, or logcat if RN's release console
  isn't stripped, see §7 general finding below) can read the safety code
  without ever touching the raw secret. Not present in `web/src/lib/WebRTCManager.ts`
  (the web implementation never logs `safetyCode`) — a real, previously
  undocumented **asymmetry between native and web** in this specific leak.
- `RTCStore.js:218-220`: `console.log('[Safety] Code:', rtc.safetyCode)` — a
  **second, independent** log site for the same value, inside the
  post-key-exchange profile-send flow. Also native-only; no web equivalent.

**Verdict:** raw secret never logged — **PROVEN**. Derived Safety Code logged
unconditionally in two native-only call sites — **new finding, previously
undocumented**, low-severity in isolation (one-way hash, and an attacker who
already has log access to a live device is already in a strong position) but
directly undermines the trust model of the one manual MITM-detection
mechanism the app has (an attacker who can read logs could present a
different, colliding-looking code, or simply already knows what the victim
would see and tailor a social-engineering pretext).

**8. Crash reports:** no native crash handler / Crashlytics exists in this
repo (see §9 below) that could capture `sharedSecret` from a JS exception —
**N/A, confirmed absent, not assumed**. A generic uncaught-exception
handler (if the OS/RN default crash reporter is active) could in principle
capture a JS stack frame's local variables in some crash-reporting
integrations, but no such integration is wired into this app — **PROVEN
absent** by grep, see §9.

**9. Caches:** `RTCStore.sharedSecrets` is itself a long-lived,
un-evicted, in-memory cache — see Finding S-1.

**10. Backups:** native `AndroidManifest.xml:26` sets
`android:allowBackup="false"` — confirmed current, **PROVEN**, this
structurally disables Android Auto Backup for the entire app, so
`shared_secret_<id>` in `EncryptedStorage`'s `EncryptedSharedPreferences`
file is never included in any OS-level backup. No `android:fullBackupContent`
is needed/present since backup is disabled outright, not selectively
filtered. Web has no OS-level backup concept for `localStorage`; the
pepper-gated encryption (Storage.ts) means even if a browser profile itself
is backed up/synced by some other mechanism outside this app's control
(profile sync, disk imaging), the stored `shared_secret_<id>` value is
AES-GCM-ciphertext under a key that requires the live relay pepper to
derive — **DESIGN GOAL, matches Claim 8** of the crypto-claims audit.

**11/12. After logout/revocation:** there is no "logout" concept distinct
from chat-delete or full wipe in this app (confirmed, no session/login
state exists per `SECURITY_STATE_MACHINES.md` §1). Device revocation is
represented by chat-delete (§3 below) or the receiving side's
`device_wiped` tombstone handling — see Finding S-2 for what is and isn't
cleared.

---

### Finding S-1 (new): `RTCStore.sharedSecrets`/`buffer`/`audioBuffer`/`imgBuffer` are never cleared by the 5-fail wipe — the entire in-memory secret/plaintext cache survives a "complete wipe"

Traced the native 5-fail wipe handler end-to-end
(`App.tsx:1195-1264`, `LockScreen`'s wrong-PIN branch reaching `att>=5`):

- It reads `RTCStore.sharedSecrets` (`:1214`) to send `device_wiped` notices,
  then clears `AsyncStorage` (`multiRemove`+`clear`, `:1241-1242`) and
  `EncryptedStorage` (`removeItem` loop + `clear`, `:1245-1250`), then
  deletes `queue_`-prefixed files under `RNFS.DocumentDirectoryPath`
  (`:1254-1262`), then calls `onWipe?.()` (`:1264`) which is wired
  (`App.tsx:917`) to `() => { setContacts([]); setUsername(''); setAvatar(null); nav('setup'); }`
  — **pure React state reset, no process restart.**
- **At no point in this entire block does any code touch `RTCStore.connections`,
  `RTCStore.sharedSecrets`, `RTCStore.buffer`, `RTCStore.audioBuffer`,
  `RTCStore.imgBuffer`, or `RTCStore.pendingAvatars`, and no live
  `WebRTCManager` instance's `.close()` is ever called.** Confirmed by
  reading the full block and by grep (`RTCStore`/`.close()`/`GLOBAL_RTC` —
  zero hits inside lines 1150-1270).
- Because the JS process is not restarted (`nav('setup')` is a React
  navigation, not an app relaunch), the module-level `RTCStore` singleton
  — a plain JS object that lives for the process lifetime — **keeps every
  cached `sharedSecret`, every open `WebRTCManager` connection (with its own
  live `this.sharedSecret`/`this.myKyberKeys` fields), and any plaintext
  messages sitting in `RTCStore.buffer` for chats whose screen wasn't open**,
  completely intact through and after a "complete wipe."
- **Concrete, reachable consequence:** an open `WebRTCManager`'s cover
  traffic (`_startCoverTraffic`, every 3s) and liveness watch keep running
  after the wipe; if the real peer sends an actual message during this
  window, `RTCStore`'s `onMessage` handler (`RTCStore.js:30-138`) decrypts
  it with the still-cached secret and, finding no listener attached (the
  chat screen was torn down by the wipe's `setContacts([])`), pushes the
  **decrypted plaintext** into `RTCStore.buffer` — i.e., a device the user
  just told to "wipe everything" continues to silently receive, decrypt,
  and buffer new plaintext messages in memory, using session key material
  the wipe was supposed to destroy.
- The reload path at `App.tsx:439-446` (populating `RTCStore.sharedSecrets`
  from `EncryptedStorage` on next app-state read) reads from now-empty
  `EncryptedStorage`, so it does not resurrect anything — but it also
  doesn't need to, since the in-memory Map was never cleared in the first
  place.

**Same gap confirmed on web**, structurally identical: `web/src/lib/Storage.ts`'s
wipe path (`unlockEncryption()`'s `failResult.wiped` branch, `Storage.ts:152-156`,
and the direct wrong-PIN-5th-fail path) calls `localStorage.clear()` and
returns `{ok:false, reason:'wiped'}`; `web/src/App.tsx`'s `onUnlock` handler
(`:377-390`) only returns a display string for this case — grepped the
entire file for any `RTCStore.sharedSecrets.clear()`/`RTCStore.connections`
teardown triggered by the `'wiped'` reason: **none exists.** The web
`RTCStore` singleton (`web/src/lib/RTCStore.ts`) is equally never purged.

**Severity/framing:** this is not a cryptographic break (no attacker gains
anything they couldn't already get by compromising the running process) —
it is a **wipe-completeness bug**: the user-facing promise of the 5-fail
wipe ("your data is gone") is only true for *persisted* data, not for
whatever was cached in the live JS process's memory at the moment of the
wipe. A forensic tool that can dump the app process's memory immediately
after a "successful" wipe (or an attacker who triggers the 5-fail wipe
themselves specifically to see what stays resident) would find live
session secrets and possibly fresh plaintext for as long as the process
stays alive afterward (until OS kills it or the user force-closes it).
**PROVEN** by code reading; the "message arrives and gets buffered
post-wipe" chain is a direct, mechanical consequence of the confirmed gaps
above, not a hypothetical — reproducing it live would need a two-device
setup with a timed message send during the wipe window (**NOT
INDEPENDENTLY TESTED as a live two-device scenario in this pass** — the
code-level absence of any clearing call is definitive on its own and
doesn't need a live reproduction to establish, matching how `SECURITY_STATE_MACHINES.md`
treats similarly-structural findings).

**Fix shape (not applied — read-only audit):** the wipe handler should call
`RTCStore.connections.forEach(rtc => rtc.close())` then clear every one of
`RTCStore.connections/sharedSecrets/buffer/audioBuffer/imgBuffer/pendingAvatars`
(and the web equivalents), before or as part of `onWipe?.()`.

---

## 2. Ephemeral keys — `myKyberKeys` (per-handshake Kyber keypair)

**1. Created:** `generateKyberKeypair()` in `channel.onopen`, initiator only
(`WebRTCManager.js:319`, `.ts:239`) — fresh per connection attempt, genuine
CSPRNG-backed (`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 2, re-confirmed
current).

**2. In memory:** `this.myKyberKeys = {publicKey, secretKey}` on the
`WebRTCManager` instance only — **never** copied into `RTCStore` or any
other module-level structure (confirmed by grep: `myKyberKeys` appears only
inside `WebRTCManager.js`/`.ts`, nowhere else in the repo).

**3. Persisted:** **never** — confirmed by grep, no `EncryptedStorage`/
`setItem` call anywhere references `myKyberKeys`. This is correct: only the
derived `sharedSecret` needs to survive a reconnect; the ephemeral keypair
that produced it is single-use by design (ML-KEM's `secretKey` is only
needed to decapsulate the one matching ciphertext).

### Finding S-2 (new): `myKyberKeys` (including the ML-KEM secret key) is never wiped on `close()`, on either platform

`close()` (`WebRTCManager.js:272-287`, `.ts:177-192`) explicitly nulls
`this.pc`, `this.dataChannel`, `this.sharedSecret`, and
`this.keyExchangeDone` — but **not** `this.myKyberKeys` and **not**
`this.safetyCode`. Confirmed by reading the full `close()` body on both
files; no other method ever nulls `myKyberKeys` either. Practically: the
ephemeral ML-KEM-768 private key remains reachable in memory for as long as
*any* reference to that `WebRTCManager` instance survives (which, per
Finding S-1, can be indefinitely if the instance is never dropped from
`RTCStore.connections` and the wipe path doesn't clear it either) —
inconsistent with the "ephemeral, single-use" design intent the crypto audit
credited this mechanism with. **Not exploitable on its own** (an already-used
keypair's secret key only lets an attacker decapsulate a ciphertext they'd
have needed to intercept live anyway, and the resulting shared secret is the
same one already exposed via `sharedSecret`/`shared_secret_<id>`), but it is
a genuine, previously-undocumented instance of "ephemeral" key material not
being explicitly zeroed at the one lifecycle point (`close()`) that exists
specifically to tear the connection down. **PROVEN** by code reading; the
practical memory-retention duration cannot be measured without a heap
snapshot (**NOT TESTABLE UNDER JEST**).

**4-6/11-12.** Given S-2, duration/deletion is "until the containing
`WebRTCManager` instance is garbage-collected," not "until `close()` is
called" as the code's structure would suggest at a glance.

**7. Logs:** never logged (grepped, zero hits for `myKyberKeys` inside any
`console.*` call). **PROVEN.**

**8-10.** No crash-reporting integration exists (§9); never persisted, so
no backup exposure.

---

## 3. Plaintext messages

**1-3. Created/memory/persisted:** decrypted inside
`WebRTCManager.onmessage` (`decryptMsg`) or the relay-fallback poll loops
(`App.tsx checkIncoming`); handed to `this.onMessage` → `RTCStore`'s
per-chat `onMessage` closure (`RTCStore.js:30-138`) → either an attached
listener (chat screen open, message goes straight into React state,
`ChatScreen`'s `setMsgs`) or `RTCStore.buffer` (chat screen closed).
Persisted to `EncryptedStorage`/web `Storage.ts` under `chat_<id>` — native
confirmed via `EncryptedStorage.removeItem('chat_'+contact.id)` call sites
(`App.tsx:674,683,703,932`) implying the same key is the write target
(the write call itself is at `App.tsx:1507`'s `storageKey` construction,
consistent), web via `setItem('chat_'+chat.id, JSON.stringify(msgs))`
(`web/src/App.tsx:767`).

**4. Duration:** on disk, until chat delete or wipe (both apply
`removeItem('chat_<id>')`/wipe clears all of `localStorage`/`EncryptedStorage`
— **PROVEN** for the persisted copy specifically). In memory: React state
lives for the mounted `ChatScreen`'s lifetime; `RTCStore.buffer` entries
live **until `getBuffered()` is called** (`RTCStore.js:359-363`,
`RTCStore.ts:65-69` — both `delete` the Map entry on read) — if the chat
screen for that contact is never opened again, the buffered plaintext stays
in memory for the process's lifetime, and per Finding S-1, is **not**
cleared by chat-delete or wipe either (neither `App.tsx:919-964`'s
delete-chat block nor the wipe block at `:1195-1264` touch
`RTCStore.buffer`).

### Finding S-3 (new): deleting a chat does not purge that chat's already-buffered plaintext from `RTCStore.buffer`/`audioBuffer`/`imgBuffer`

Read the full local delete-chat handler (`App.tsx:919-964`, "onDelete"):
it clears `EncryptedStorage` (`chat_`, `timer_`, `secret_`, `shared_secret_`,
`queue_`), `RTCStore.connections`, and `RTCStore.sharedSecrets` — but never
references `RTCStore.buffer`, `RTCStore.audioBuffer`, `RTCStore.imgBuffer`,
or `RTCStore.pendingAvatars` (confirmed absent by re-reading the block and
by grep — none of those four appear anywhere in the onDelete closure). If a
message (or a partially-received image/audio chunk set) arrived for that
contact while the chat screen was closed, and the user then deletes the
contact, the already-decrypted plaintext — or partially-reassembled
attachment bytes — for that now-"deleted" contact remains resident in the
`RTCStore` singleton, inaccessible from the UI (no chat/listener will ever
read it again, since the contact is gone) but not zeroed, not overwritten,
just an orphaned live reference until the JS engine's GC eventually
collects it. **PROVEN** by code reading; same GC-timing caveat as Finding
S-1 applies to how long it actually persists (**NOT TESTABLE UNDER JEST**).

**5. Accessible from:** `ChatScreen` component, `RTCStore` singleton (any
code with a reference), React DevTools if attached during development
(component state/props are always inspectable there — this is inherent to
React and not a code bug, but is a real exposure surface during development
builds specifically).

### Finding S-4 (new, concrete, most severe finding in this document): decrypted plaintext message content is logged to console unconditionally, not gated by `__DEV__`

- **`App.tsx:1732`**: `console.log('[Chat] Nachricht via RTCStore:', msg)`
  — inside `ChatScreen`'s `RTCStore.setMessageListener` callback
  (`App.tsx:1728-1733`), fired on **every** message the listener receives
  while a chat screen is open. `msg` is the fully decrypted object as
  produced by `WebRTCManager`/`RTCStore` — for `type:'text'` this includes
  the actual plaintext chat text (`msg.text`); for other types routed
  through this same listener (`image_complete`, `audio_complete`) it would
  include the full base64-encoded image/audio payload. There is no
  `__DEV__` guard, no redaction, no truncation — this line executes in
  every build that includes this exact source, and would appear in the
  Metro dev console during development and (depending on whether release
  builds strip `console.*` calls — see the note below) potentially in
  `adb logcat` on a release build too.
- **`App.tsx:3249`**: `(msg) => console.log('[P2P] Message:', msg)` — the
  `onMessage` callback passed to the `WebRTCManager` constructor in the
  phone-connect/QR-connect flow (`ConnectScreen`'s initial pairing path,
  before `RTCStore.setConnection` swaps in the real handler). Same issue:
  logs the full decrypted message object for every message received during
  the connect flow, unconditionally.

**What this means concretely:** any code path that captures this app's
console output — a developer's Metro terminal during testing, `adb logcat`
attached to a device running a debug build, or (unverified, see below) a
release build that doesn't strip `console.*` — would see actual chat
message plaintext, not just status strings. This directly contradicts the
pattern used **everywhere else** in this same file and in `WebRTCManager.js`
itself, where log lines are careful to log only status/type strings
(`'[Crypto] ✅ Shared Secret gesetzt...'`, `'[WebRTC] ✅ Nachricht entschlüsselt'`)
and never the payload — these two call sites are outliers, not the norm,
and read as debug leftovers rather than an intentional design choice.

**Whether this reaches a real device's persistent log store in a release
build is an ASSUMPTION this audit did not verify** — React Native's default
Metro/Hermes behavior strips some `console.*` calls in release only if the
project's build config explicitly enables that (e.g. a ProGuard/Terser
`drop_console` rule); this repo's `metro.config.js`/`babel.config.js` were
not confirmed either way to strip console calls in release builds. **This
is exactly the kind of claim that needs a real release-build device test**
(build a release APK, attach `adb logcat`, send a text message, grep the
log for the message content) — **NOT TESTABLE UNDER JEST.** Even absent
that confirmation, the debug-build/Metro-console exposure alone is already
a concrete, reproducible plaintext-in-logs finding, and — independent of
release-strip behavior — any developer or QA engineer running this app
during development sees real users' message plaintext in their terminal
the moment they attach a debugger, which is itself a real internal-exposure
concern (shared dev logs, screen-shares, bug reports pasting console output).

**Verdict:** **PROVEN, new finding, not previously documented** by any prior
review in this repo. Highest-priority item in this document.

**6-12.** Chat-delete/wipe handling of the *persisted* `chat_<id>` copy is
correctly implemented (**PROVEN**, cited above); the *in-memory* copies
(buffer, React state, and now confirmed console output) are not
comprehensively cleared — see Findings S-1/S-3/S-4.

---

## 4. Decrypted attachments (images/audio)

**1-3. Created/persisted:** `ImageCrypto.js`/`AudioCrypto.js` decrypt
chunk-by-chunk; reassembly happens in per-module `Map`s keyed by
`imageId`/`audioId` (`ImageCrypto.js:106`, `AudioCrypto.js:83` — module-level,
**unscoped by chatId**, distinct from `RTCStore.imgBuffer`/`audioBuffer`
which *are* chatId-scoped) or in `RTCStore.imgBuffer`/`audioBuffer`
directly (`RTCStore.js:37-92`), depending on which code path receives the
chunk. Once complete, the full base64 is handed to the UI as
`image_complete`/`audio_complete`/`audio_end`.

### Finding S-5 (new): raw voice-message recordings are never deleted from disk — not on send, not on cancel, not on chat delete, not on wipe

Traced the full recording lifecycle in `App.tsx`:
- `startRecording()` (`:1974-2016`) creates a native `Recorder` writing to
  `malachi_<timestamp>.mp4` (`:1986`) — a plaintext (unencrypted) audio file
  written by the third-party recording library to its own filesystem path.
- `stopRecording()` (`:2018-2042`) reads that file into base64
  (`RNFS.readFile(audioPath,'base64')`, `:2035`) for the send/preview flow
  and stores `audioPath` in React state (`audioPreview.path`, `:2037`) —
  **the raw file on disk is never unlinked here.**
- `sendAudioPreview()` (`:2044-2062`+): sends the base64 (already read into
  memory) via `sendEncryptedAudio()` — still no unlink of `audioPreview.path`.
- The preview UI's cancel button (`:2729`, the `x` icon) calls only
  `setAudioPreview(null)` — **no `RNFS.unlink()` call at all.**
- The 5-fail wipe's own media cleanup (`:1254-1262`) only targets files
  **starting with `queue_`** under `RNFS.DocumentDirectoryPath` — the raw
  recording's filename (`malachi_<timestamp>.mp4`, no `queue_` prefix) does
  not match this filter even if it happens to live in the same directory,
  and grepping the entire file for any other `unlink` call referencing this
  recording path or pattern found none.
- Net effect: **every voice message ever recorded — sent, or discarded via
  the cancel button — leaves a permanent, unencrypted `.mp4` file on disk**,
  surviving chat deletion and the full 5-fail wipe. Confirmed by exhaustive
  grep of every `unlink` call site in `App.tsx` (6 total, none reference
  the recording path or a `malachi_`-prefixed filename pattern) — **PROVEN**
  by code reading. The exact filesystem directory the third-party
  `Recorder` writes to by default was not independently re-derived from its
  native implementation in this pass (**ASSUMPTION**, inherited from the
  library's own default behavior) but wherever it is, it is provably never
  cleaned up by this app's own code.

**Separately, playback and gallery-save also write transient plaintext to
`RNFS.CachesDirectoryPath`:**
- `playAudio()` (`:2136-2165`) writes decrypted audio to
  `${CachesDirectoryPath}/play_<id>.mp4` and unlinks it **only inside the
  player's completion callback** (`:2158`) — if the app is killed, crashes,
  or the callback never fires for any other reason during playback, this
  temp file is orphaned. Lower severity than S-5 (bounded to one file per
  playback attempt, in the OS cache dir which the OS itself may reclaim
  under storage pressure) but the same class of gap: cleanup is
  callback-conditional, not guaranteed (e.g. via a `finally`).
- The "save image to gallery" long-press handler (`:2668-2681`) writes
  decrypted image bytes to `${CachesDirectoryPath}/malachi_<ts>.<ext>`,
  calls `CameraRoll.saveAsset()`, then unlinks the temp file
  (`:2674-2676`) — the temp file itself is properly cleaned up in the
  success path (though not inside a `finally`, so an exception between
  `writeFile` and `unlink` would orphan it), but **by design** this action
  permanently copies decrypted plaintext image content into the OS-wide
  Camera Roll / MediaStore, a storage location entirely outside this app's
  encryption boundary and potentially included in the *device's* own
  cloud-photo-backup mechanism (Google Photos, OEM gallery sync) if the
  user has one enabled — inherent to any "save to gallery" feature, not a
  code bug, but worth stating explicitly as a **DESIGN GOAL, correctly
  understood as an intentional plaintext exit point** the moment the user
  invokes it, distinct from `queue_`/`chat_` staying inside the app's own
  encrypted storage.

**4-12.** Given S-5, the answer to "how long does decrypted audio remain on
disk" and "is it present after wipe" is: **potentially forever, yes** for
every voice message ever sent or recorded-then-cancelled. This is the most
severe on-disk finding in this document. `queue_`-prefixed offline-send
files were separately confirmed to hold genuine ciphertext, not plaintext
(`App.tsx:2098-2101`: `encryptedBlob = await encryptMsg(...)` written to
`queue_audio_<msgId>.enc`) — **DESIGN GOAL, correctly implemented** for that
specific path, in contrast with the raw-recording gap above.

**7. Logs:** `ImageCrypto.js:100`/`AudioCrypto.js:78` log the **full caught
exception object** (`console.error('[ImageCrypto] Fehler:', e)` /
`'[AudioCrypto] Fehler:', e`) rather than just `e.message`. In the current
code the only thrown error at these call sites is the fixed string
`'Verschlüsselung fehlgeschlagen'` (no plaintext or key material
interpolated into it) — so **no live leak exists today** — but logging full
error objects instead of sanitized messages is a fragile pattern: any
future change that embeds a chunk's data or a key into an `Error`'s message
for debugging purposes would silently start leaking through an
already-existing, seemingly-innocuous log line. **DESIGN GOAL / fragile
pattern, not a proven leak today** — flagged for awareness, not as a live
finding.

---

## 5. Authentication tokens

### 5a. Relay pepper `attemptToken` (web unlock rate-limiting)

**1-3.** Minted server-side, `crypto.randomBytes(16).toString('hex')`
(`relay.js:777`), returned once per `/pepper/request` call together with
the pepper itself, held server-side in `pepperStore`'s `pendingToken` field
(`relay.js:93,778`) and client-side only transiently as a function
parameter passed straight through to the next `/pepper/fail` or
`/pepper/success` call (`web/src/lib/Storage.ts:152,172`) — **never
persisted to `localStorage`** (confirmed by grep of `Storage.ts`: no
`attemptToken` write to any storage key).

**4-6.** Single-use by construction: the server compares
`attemptToken !== entry.pendingToken` (`relay.js:792,806`) and a fresh one
is minted on every `/pepper/request`, invalidating the previous one
implicitly. **PROVEN.**

**7-9.** Never logged anywhere (grepped `relay.js`, `Storage.ts`,
`RelayClient.ts` for any `console.*` call referencing `attemptToken`: zero
hits). Not cached beyond the single in-flight unlock attempt.

**Verdict: DESIGN GOAL, correctly implemented, no leak found.**

### 5b. TURN credentials (`getTurnCredentials()`)

Short-lived (6h), HMAC-derived server-side (`relay.js:799-811`, already
covered by `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 7). Client-side:
fetched fresh per `_pcConfig()` call (`WebRTCManager.js:108`, `.ts:48`),
held only as local `const creds` inside that async function's scope — not
assigned to any persistent field, not cached beyond one ICE-server-config
build. **PROVEN** minimal exposure; not logged (`WebRTCManager.js:110-120`
logs only "keine TURN-Zugangsdaten verfügbar" on the *absence* case, never
the credential values themselves on the present case).

### 5c. Phone-connect PSK (`derivePhonePSK`)

Derived client-side from both phone numbers (`App.tsx:2737-2749`, already
covered by `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 6 — not
re-derived here). Held as a local variable (`pskB64`/`pskHex`) through the
connect flow (`App.tsx:3240` `decryptMsg(encOffer, pskB64)`); not
persisted beyond the connect flow's own lifetime, not logged directly
(only status strings like `'[Connect] Offer vom Relay: gefunden'` at
`:3233`). **DESIGN GOAL, no new leak found.**

---

## 6. Passwords/passphrases — the PIN

**Native (`app_pin`):** stored via `EncryptedStorage.setItem('app_pin', next)`
(`App.tsx:1141`), compared with plain string equality on unlock
(`App.tsx:1079` per `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 9 —
**not re-derived here**, cited as established). Read back only at
`App.tsx:1069`. Never logged (grepped every line referencing `pin`/`att` in
the LockScreen block for `console.*` calls with the PIN value
interpolated: none found — `setErr()` calls only ever construct UI strings
like `` `Falscher PIN – noch ${5-n} Versuch...` `` with a **count**, never
the PIN digits themselves). Cleared on wipe
(`EncryptedStorage.removeItem`/`clear()`, `:1238,1250`) — **PROVEN**, the
persisted PIN is genuinely gone after a wipe (matches `SECURITY_STATE_MACHINES.md`
§9's framing).

**Web:** the PIN is **never stored anywhere**, by design — only
`SALT_KEY`/`MARKER_KEY`/`DEVICE_ID_KEY` persist locally, and the PIN exists
transiently as a function parameter through `setupEncryption(pin)`/
`unlockEncryption(pin)` (`Storage.ts:105,126`), used immediately to derive
`dek` via PBKDF2 and then going out of scope. **PROVEN** by reading the
full file — no `pin` variable is ever written to `localStorage`, logged, or
retained past the synchronous derivation call. This is the strongest
password-handling in the app, already credited as such in
`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 8 — independently re-confirmed
current here.

**One positive note not previously stated this precisely:** the AES-GCM
`dek` in `Storage.ts` is derived with `extractable:false`
(`Storage.ts:71`, the `deriveKey` call's 4th argument) — meaning even if an
attacker achieved arbitrary JS execution in the page and obtained a
reference to the `dek` `CryptoKey` object, the WebCrypto API itself refuses
to export its raw bytes; the key is only usable for `encrypt`/`decrypt`
operations, not extraction. This is a genuine defense-in-depth property of
using `SubtleCrypto` non-extractable keys rather than raw byte arrays for
the DEK specifically (**PROVEN** by reading the `deriveKey()` call and by
WebCrypto's own documented `extractable:false` semantics) — narrower in
scope than it might sound: it protects the *DEK* this way, not the
`sharedSecret`/`myKyberKeys` values elsewhere in the app, which remain
plain JS strings with no equivalent protection (see §1/§2 above).

---

## 7. Temporary buffers — general findings across all secret types

**Audio recording buffer / chunk-reassembly buffers:** covered in detail
under Findings S-3/S-5 above (`RTCStore.audioBuffer`/`imgBuffer`,
`ImageCrypto.js`/`AudioCrypto.js`'s own module-level `Map`s). All are
plain, unencrypted JS objects holding base64 plaintext while assembly is in
progress — appropriate for a receive buffer (the data isn't secret *after*
decryption in the sense that it's about to be shown to the user anyway),
but per S-1/S-3, not comprehensively cleared on delete/wipe.

**Clipboard:** grepped the entire repository (`Clipboard`, case-sensitive
and via file search across `.js`/`.ts`/`.tsx`/`.kt`) — **zero matches
anywhere.** No feature in this app copies a message, Safety Code, PIN, or
any other value to the system clipboard. **PROVEN absent** — nothing to
audit here, and this closes off an entire class of potential leak (clipboard
history apps/OS clipboard managers on Android 13+ that show a toast on
every clipboard write are not a concern here since the app never writes to
it).

**Notifications:** `MalachiNotificationModule.kt:52-59` — the local
notification's `setContentTitle("Malachi")`/`setContentText("Neue Nachricht")`
are **hardcoded, generic strings**, not derived from the actual message,
sender name, or contact ID in any way. Confirmed by reading the full,
short (65-line) file — there is no code path in this module that could
receive or display plaintext content even if it wanted to (the
`showNotification()` method takes zero arguments). **PROVEN, DESIGN GOAL,
correctly implemented** — this is a genuinely good, previously-unstated
(no prior review examined this file) result: a locked-screen notification
preview cannot leak chat content because the native module structurally
never receives any. FCM path (`MalachiFirebaseMessagingService.kt:27-40`)
is equally content-blind — `message.data["reason"]` is one of exactly two
enum strings, matching `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 12's
finding that this path sends no content, independently re-confirmed here
from the receiving side.

**Analytics:** grepped for `Crashlytics`, `Sentry`, `Analytics` (and
Firebase Analytics specifically, distinct from the legitimately-used FCM),
`mixpanel`, `amplitude` across every `.js`/`.ts`/`.tsx`/`.kt`/`.gradle`
file in the repo — **zero matches.** No analytics or crash-reporting SDK
of any kind is integrated. **PROVEN absent.** This also answers the crash
report question (§8 of the lifecycle questions) for every secret type in
this document at once: **there is no crash-reporting pipeline anywhere in
this app that could capture a secret from a stack trace, breadcrumb, or
crash payload** — the only way a secret reaches a "crash report" in this
codebase is the OS's own default unhandled-exception/ANR logging (logcat),
which is the same exposure surface as the general console-logging findings
above (S-4), not a distinct integration-specific risk.

**Debugging / Flipper:** grepped `MainApplication.kt` (the file that would
register Flipper's `ReactNativeFlipper.initializeFlipper()` call in a
pre-0.86 RN template) and the whole `android/` tree for `Flipper` —
**zero matches anywhere.** `MainApplication.kt`'s package list
(lines 17-22) registers exactly `KyberPackage`, `MalachiServicePackage`,
`MalachiNotificationPackage`, `MalachiCallPackage` — no Flipper
initialization block exists at all (not even a commented-out one).
**PROVEN** — the RN 0.86 upgrade's claimed Flipper removal is confirmed
true against the current source, not merely asserted by the upgrade plan.

**IPC (JS↔Kotlin bridge):** `KyberModule.kt` (the only native module that
ever touches key material) never logs (`grepped for `Log\.` calls across
the whole `android/app/src/main/java/com/securecommapp` tree: only one hit,
`TelecomHelper.kt:40`, unrelated to crypto — call metadata for Telecom
registration failure, not a secret). Every `KyberModule` method's error
path returns only `e.message` via `promise.reject()` (`KyberModule.kt:21,42,56,68,77`)
— BouncyCastle/`MessageDigest` exception messages describe structural
failures (wrong length, malformed encoding), not data contents, so this
**ASSUMPTION** (no standard JCE/BouncyCastle exception embeds raw key
bytes in its message) is reasonable but not exhaustively proven against
every possible internal BouncyCastle exception type — **NOT TESTABLE
UNDER JEST** (would need to force each specific native exception path on
a real device/JVM and inspect the exact message text). Once such an
`e.message` crosses back into JS, ordinary JS `catch` blocks around
`generateKyberKeypair()`/`kyberEncapsulate()`/`kyberDecapsulate()` log it
via `console.error` (e.g. `WebRTCManager.js:327`,
`console.error('[Crypto] Key Exchange fehlgeschlagen:', e)`) — so *if* a
Kotlin exception message ever did embed sensitive bytes, it would
propagate straight into the same logging surface as Finding S-4. No
evidence this currently happens; flagged as a structural possibility, not
a proven leak.

---

## 8. Recovery material and prekeys — explicitly confirmed absent

Per the task's own instruction to check rather than assume: grepped the
entire repository for `recover`, `Recovery`, `prekey`/`preKey`/`PreKey`,
`backup.?code`, and `Wiederherstellung` — **zero matches** outside this
report itself. There is no prekey-bundle protocol (the Kyber exchange is
fully interactive, both messages exchanged live per session, never
pre-published), and no account-recovery/backup-code feature of any kind.
Losing the PIN (native) or the PIN+relay-pepper combination (web) is
unrecoverable by the app's own explicit design (the 5-fail wipe and the
"no offline unlock" trade-off in `Storage.ts` are both framed in-code as
intentional, not oversights). **Confirmed absent, not merely assumed —
N/A for this codebase.**

---

## 9. AsyncStorage vs. EncryptedStorage — where the line actually falls

Cross-checked every persisted secret-shaped value against which storage
layer holds it:

| Value | Storage used | Correct? |
|---|---|---|
| `shared_secret_<chatId>` | `EncryptedStorage` (native) / pepper-gated AES-GCM (web) | Yes — **PROVEN** |
| `chat_<chatId>` (message history) | `EncryptedStorage` / web `Storage.ts` | Yes — **PROVEN** |
| `app_pin` | `EncryptedStorage` | Yes (though see the separately-established Claim 9 finding that this doesn't gate a key) |
| `queue_<msgId>.enc` files | Ciphertext written via `RNFS`, path tracked in `EncryptedStorage` `queue_<chatId>` list | Yes — **PROVEN**, confirmed the blob itself is `encryptMsg()` output, not plaintext |
| `contacts` (names, roles, IDs — not secret key material, but identity/routing metadata) | **Plain `AsyncStorage`**, not `EncryptedStorage` (`App.tsx:891,906,928` etc.) | **Design choice, not a secret-storage bug** — no key material lives in the contacts array (confirmed by reading its object shape: `id,name,initials,color,tc,role,unread,last,time,wiped` — no `secret`/`pin`/`token` field anywhere), but it does mean the *social graph* (who this device has paired with, under what display name) sits in cleartext-readable `AsyncStorage` on a rooted/ADB-accessible device, unlike the message content and key material it references by ID. Not previously called out this precisely by name — flagged here as a metadata-adjacent observation, not a "secret leaked" finding, since contact names/IDs are not one of the enumerated secret types in this audit's scope. |
| Raw voice recording (`malachi_<ts>.mp4`) | Neither — plain filesystem, no storage-layer wrapper at all | **No** — see Finding S-5; this is the one secret-shaped value in the app that bypasses both `AsyncStorage` and `EncryptedStorage` entirely |

---

## Not testable under Jest — what a device test would need

- **Release-build console stripping (Finding S-4).** Needs: build a release
  APK (`cd android && ./gradlew assembleWebRelease` - since the Play
  variant exists, plain `assembleRelease` builds both flavors, see
  PLAY_STORE.md), install on
  a device/emulator, attach `adb logcat`, send/receive a text message
  between two paired devices, grep the captured log for the message's
  literal text. Confirms or refutes whether `App.tsx:1732`/`:3249`'s
  `console.log` calls actually reach a persistent, potentially
  externally-accessible log store in the shipped app, or are stripped by
  the release build pipeline.
- **In-memory secret retention after wipe (Finding S-1).** Needs: pair two
  real devices, trigger the 5-fail wipe on one, immediately have the other
  device send a message, and use a memory-inspection tool (or simply
  observe whether the "wiped" device's `RTCStore` state — inspectable via
  a temporary debug log inserted for the test — still decrypts and buffers
  it) to confirm the live reproduction, not just the code-level absence of
  a clearing call.
- **Orphaned recording files (Finding S-5).** Needs: record and send
  several voice messages, then use `adb shell run-as com.securecommapp
  find <app-data-dir> -name "malachi_*.mp4"` (or equivalent) to confirm the
  files physically remain on disk after send, after chat delete, and after
  a full wipe.
- **BouncyCastle exception message contents (§7 IPC finding).** Needs
  forcing each specific native-side exception path (malformed key bytes of
  various kinds) on a real device and inspecting the exact string that
  crosses the bridge, to exhaustively confirm no internal exception type
  ever embeds raw bytes.
- **JS heap zeroing timing (Findings S-1/S-2/S-3's GC caveats).** Needs a
  heap snapshot (Hermes/V8 memory profiler) taken immediately after a
  "deletion" event to measure how long the old secret/plaintext bytes
  remain physically present in memory before GC reclaims them — inherent
  to the JS-string-based key material design throughout this app, not
  fixable by a small patch.

---

## Prioritized findings summary

Ordered by real-world severity (confidentiality-impacting first,
completeness/robustness gaps last), consistent with how prior reviews in
this repo rank findings:

1. **(S-4) Decrypted chat message plaintext is logged to console
   unconditionally** at `App.tsx:1732` and `App.tsx:3249` — no `__DEV__`
   gate, executes in every build containing this code. Highest-priority,
   most concretely provable finding in this document. Whether it reaches a
   release build's persistent logs is unverified (needs a device test),
   but the development-time exposure (Metro console, any shared dev logs,
   bug-report copy-paste) is real regardless.

2. **(S-1) The 5-fail wipe (native) and the pepper-triggered wipe (web) do
   not clear the in-memory `RTCStore` singleton** — cached session
   secrets, live WebRTC connections (which keep transmitting cover traffic
   and can keep receiving/decrypting/buffering real plaintext after the
   "wipe"), and buffered plaintext all survive the wipe as long as the JS
   process stays alive. Undermines the core promise of the wipe feature on
   both platforms.

3. **(S-5) Raw voice-message recordings are never deleted from disk** —
   not on send, not on explicit cancel, not on chat delete, not on the
   5-fail wipe. Every voice message ever recorded leaves a permanent
   unencrypted file, bypassing both `AsyncStorage` and `EncryptedStorage`
   entirely.

4. **(S-3) Chat deletion does not purge that contact's already-buffered
   plaintext / partial attachment chunks from `RTCStore`** — a smaller-scope
   version of Finding 2's underlying mechanism, reachable via ordinary
   chat deletion (no wipe/5-fail needed).

5. **(S-2) The ephemeral Kyber keypair (`myKyberKeys`, including the
   ML-KEM secret key) is never explicitly nulled in `close()`** on either
   platform — relies entirely on garbage collection rather than deliberate
   zeroing, inconsistent with its "ephemeral, single-use" design intent.
   Low exploitability on its own but part of the same pattern as 1-4.

6. **The Safety Code (`SHA-256(sharedSecret)`) is logged unconditionally,
   native-only, at two call sites** (`WebRTCManager.js:381,408`,
   `RTCStore.js:219`) — a one-way-hashed derivative, not the raw secret,
   but it directly exposes the value the app's one manual MITM-detection
   feature depends on being compared out-of-band, to anyone with log
   access. Not present on web — an unexplained platform asymmetry.

7. **Contacts (names, roles, pairing IDs) are stored in plain `AsyncStorage`
   rather than `EncryptedStorage`**, unlike every actual secret value in
   the app — no key material is exposed by this, but the social-graph
   metadata is readable in cleartext on a rooted/ADB-accessible device.
   Metadata-adjacent, not a secret-type leak per this audit's own scope.

   > **CORRECTION (verified false positive, added during the contacts
   > lost-update race fix pass — see `CONTACTS_RACE_FIX.md`):** this finding
   > is incorrect and should be disregarded. `App.tsx:22-26` defines
   > `AsyncStorage` as a local compatibility shim whose every method
   > (`getItem`/`setItem`/`removeItem`/`multiGet`/`multiSet`/`multiRemove`)
   > delegates 1:1 to the real `EncryptedStorage` (imported from
   > `react-native-encrypted-storage`) — it is not, and never was, the
   > actual `@react-native-async-storage/async-storage` npm package. A
   > repo-wide grep for that package name turns up zero import sites (only
   > two comments elsewhere already correctly noting the same distinction).
   > Every `AsyncStorage.getItem('contacts')`/`setItem('contacts', ...)`
   > call in `App.tsx` is therefore, and always was, an `EncryptedStorage`
   > call under a locally-named alias — contacts are encrypted at rest like
   > every other value in this file. `SECURITY_SECRETS_LIFECYCLE_FIXES.md`
   > Fix 7 (which already skipped acting on this finding for unrelated
   > scope reasons) carries the same correction.

8. **Full error objects (not sanitized `.message` strings) are logged at
   several call sites** (`ImageCrypto.js:100`, `AudioCrypto.js:78`,
   `MessageCrypto.js:103,131`) — no live leak found today (current thrown
   errors carry only fixed strings), but a fragile pattern that would
   silently start leaking through an already-present log line if any
   future change embedded data into an `Error`'s message.

**What this audit did *not* find:** no clipboard usage anywhere in the app
(closing off a whole leak class); no analytics/crash-reporting SDK of any
kind (Crashlytics/Sentry/etc. all confirmed absent); Flipper confirmed
genuinely removed post-RN-0.86-upgrade (not merely claimed); local/push
notification content confirmed structurally incapable of leaking message
plaintext (hardcoded generic strings, FCM payload content-blind); no
prekey or recovery-code feature exists to audit; the raw session secret
and PIN values themselves are never directly logged anywhere in the JS or
Kotlin layers (only a hashed derivative in one place, Finding 6 above);
Android's `allowBackup="false"` genuinely and unconditionally disables OS
backup for every secret discussed in this document.
