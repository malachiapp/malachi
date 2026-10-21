# State Machine Security Analysis — SecureCommApp ("Malachi")

**Scope of this pass:** the 9th security review this session, and the first with a
state-machine lens specifically. Prior reviews (`SECURITY_REVIEW_1`–`6`,
`SECURITY_AUDIT_CRYPTO_CLAIMS.md`, `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`) are
treated as context, not ground truth — every claim below was re-derived from the
current code. **Note on timing:** this codebase is under active, concurrent revision
during this same session (other passes were editing `App.tsx`, `relay.js`,
`coturn-setup.sh`, `WebRTCManager.ts`/`.js` while this analysis was being written —
confirmed via `git diff`). Line numbers cite the state of each file at the time it was
read; where a section was independently touched by a concurrent fix, that is called
out explicitly rather than presented as still-open.

**Files read in full or in the relevant sections:** `App.tsx` (pairing/reconnect
~380-804, delete-chat ~820-884, LockScreen 963-1250, message receive handling
1600-1720, secret-chat UI 2350-2450, phone-connect 2690-2870), `RTCStore.js`,
`WebRTCManager.js` (full, both pre- and post-fix), `web/src/lib/WebRTCManager.ts`
(full), `web/src/App.tsx` (pairing guards 1-200, message-status fields), `relay.js`
(full, 958 lines), `web/src/lib/Storage.ts` (full), `web/src/lib/HybridCrypto.ts`,
`HybridCrypto.js`.

---

## 0. Which state machines actually exist here

Confirmed by grep (`Group|group` → 0 matches in `App.tsx`, no group-chat data model
anywhere) and by re-reading the pairing code: this app has **no accounts, no groups,
and no server-side identity** of any kind. What follows is the state-machine
inventory that actually exists, with the N/A ones stated briefly rather than padded.

---

## 1. Account State — N/A (confirmed, not merely assumed)

There is no server-side account object anywhere. `relay.js` has no user/session/login
route (confirmed by re-reading the full route list). The closest thing to "account
state" is **local device setup state**, tracked by a single flag:

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `no-device-identity` | `SetupScreen.finish()` — user enters a display name | `device-identity-established` | `App.tsx:942-950` (`setup_done='true'`, `my_id` generated) |
| `device-identity-established` | 5 failed PIN attempts | `no-device-identity` (full local wipe, see §9) | `App.tsx:1108-1144` |
| `device-identity-established` | reinstall / fresh `EncryptedStorage` | `no-device-identity` | implicit (no server record to recover from) |

**Impossible states:** none representable — `setup_done` is a single boolean, `my_id`
is generated once and never conditionally re-generated, so there's no way to reach
`setup_done=true` with `my_id` unset via any code path found.

**N/A for this app:** no login/logout, no password, no session token, no
multi-device-same-account concept — "device identity" and "account" are the same
thing here, scoped to one `EncryptedStorage`/`localStorage` instance.

---

## 2. Authentication State — native LockScreen vs. web pepper-gate

These are **local data-access gates**, not identity gates (matches
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 9, independently re-confirmed here
from the state-transition angle specifically).

### 2a. Native (`App.tsx` `LockScreen`, 963-1244)

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `no-pin-set` | first 4/6-digit entry | `setup-awaiting-confirm` | `:1048-1054` |
| `setup-awaiting-confirm` | confirmation matches | `unlocked` (PIN persisted) | `:1059-1066` |
| `setup-awaiting-confirm` | confirmation mismatch | `no-pin-set` (restart) | `:1067-1074` |
| `locked` | correct PIN | `unlocked`, `att=0` | `:1079-1088` |
| `locked` | wrong PIN, `att<3` | `locked`, `att+=1` | `:1090-1096` |
| `locked` | wrong PIN, `att==3` | `locked-timed(30s)` | `:1098-1102` |
| `locked` | wrong PIN, `att==4` | `locked-timed(60s)` | `:1103-1107` |
| `locked` | wrong PIN, `att>=5` | `wiped` → `no-device-identity` | `:1108-1144` |
| `locked-timed(N)` | timer expires | `locked` | `:1156-1173` |
| `locked` | biometric success (`bio_enabled`) | `unlocked` | `:1021-1029` |

**Key correctness property, confirmed:** the fail counter and lock-until timestamp are
persisted to `EncryptedStorage` *before* anything else on every failed attempt
(`:1094-1096`), and the countdown re-derives from an absolute timestamp on next launch
(`:1153-1155` comment, `:1156-1173`) — so killing the app mid-lockout does not reset
the counter. This is a genuinely solid piece of state persistence.

**Impossible/unauthenticated state, confirmed structurally:** biometric success calls
`onUnlock()` directly (`:1027`) with **no interaction with the fail counter at all** —
`att`/`pin_attempts` are PIN-path-only. This means the 5-fail wipe is a **PIN-only**
guarantee; there is no story for "5 failed biometric prompts" because
`rnBiometrics.simplePrompt` either succeeds or the user falls back to PIN — biometric
failure isn't counted anywhere, so it cannot itself trigger lockout/wipe. This isn't
exploitable (biometric failure is normally OS-arbitrated with its own hardware
lockout), but it does mean the app's own 5-fail wipe promise is silently only about
one of its two unlock paths.

**Authentication ≠ key derivation (re-confirmed from the state-machine angle):**
`onUnlock()` is a pure UI-state transition (`nav('home')`) — it does not gate
`EncryptedStorage`'s Keystore-backed AES key in any way (already established in
`SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 9). State-machine framing of the same
finding: the **`locked`/`unlocked` FSM here has no edge back into the Key State
machine (§5) at all** — key material is available identically regardless of which
state this FSM is in.

### 2b. Web (`web/src/lib/Storage.ts`)

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `no-pin` (`hasPinSetup()==false`) | `setupEncryption(pin)` succeeds (needs live relay) | `unlocked`, `dek` set | `Storage.ts:93-103` |
| `no-pin` | relay unreachable during setup | `no-pin` (throws, no partial state) | `:96` |
| `locked` (`dek==null`) | `unlockEncryption(pin)`, correct PIN, pepper `success` | `unlocked`, `dek=newKey`, **pepper rotated + all keys re-encrypted** | `:114-168` |
| `locked` | correct PIN, but `pepperSuccess()` network-fails after marker check passed | `unlocked`, `dek=key` (**old, un-rotated key**) — degrades gracefully, not a bug | `:165-166` |
| `locked` | wrong PIN | `locked`, server fail-counter++ | `:129-138` |
| `locked` | 5th server-side fail | `wiped` (local `localStorage.clear()` + `dek=null`) | `:131-134`, mirrors `relay.js` `applyPepperFail` |
| `locked` | relay unreachable | `locked` (`reason:'offline'`) — **no offline unlock exists at all** | `:121-123` |
| `unlocked` | `lock()` called | `locked` | `:171-173` |

**This is the strongest FSM in the app** — `getItem()`/`setItem()` are structurally
gated on `dek !== null` (`:175-185`), so "unlocked" is a real cryptographic state, not
a UI flag (contrast with 2a).

**Finding 13 (key rotation during active session) — concrete, traced:** during
`unlockEncryption()`, `dek` (the module-global in-memory key) is **not reassigned
until the very last statement of the function** (`:164` or `:166`). Between the
successful marker-decrypt (proof the PIN was right, `:129`) and that final
assignment, the code does: `pepperSuccess()` (one more network round trip,
`:150`), then — only if that succeeds — a **synchronous-looking but `await`-laden
loop over every `localStorage` key** that decrypts-under-old-key/re-encrypts-under-new-key
one entry at a time (`:152-161`), *then* sets `dek`. Concretely:

1. User enters correct PIN. `unlockEncryption()` is called, `await`s `pepperRequest`,
   `deriveKey`, `decryptRaw` (marker check passes).
2. `await pepperSuccess(...)` — a second network round trip. On a slow/degraded
   connection this can take seconds. **`dek` is still `null` this entire time** (it
   was `null` since the last `lock()`/page load).
3. **Any other code path in the app that calls `Storage.setItem()` during this window
   throws** (`Storage.ts:183`, `"Storage ist gesperrt - unlockEncryption() zuerst
   aufrufen"`) even though the user has, from their own point of view, just
   successfully entered their PIN. If that caller does fire-and-forget
   (`.catch(()=>{})`, the dominant pattern used everywhere else in this codebase — see
   `WebRTCManager.ts` persistence calls), the write is **silently dropped**, not
   retried, not surfaced to the user.
4. Once step 2 resolves, the function loops over **every** `malachi_`-prefixed
   `localStorage` key, decrypting under the *old* key and re-encrypting under the
   *new* one (`:152-161`). If code elsewhere reads via `Storage.getItem()` during this
   loop, it still returns `null` (dek null) — a UI element that expects, e.g., contact
   list data to already be available at this point sees nothing.
5. Only then does `dek = newKey` (or `dek = key` on rotation failure) run, and the
   promise `unlockEncryption()` finally resolves.

Net effect: **there is a real window — bounded by one full network round trip plus a
full re-encryption pass over local storage — during which the web app is
PIN-verified-correct but `Storage`-locked.** Any concurrent write attempted in that
window is lost silently (not queued, not retried) unless its caller happens to await
the *same* `unlockEncryption()` promise first. This is not a cryptographic flaw (no
data is exposed, nothing is corrupted — writes just don't happen), but it is a real,
reachable **key-state / storage-state mismatch with the UI's implicit model** ("PIN
correct" ≠ "storage usable" for a measurable window). Not fixed here — the correct fix
(a pending/unlocking intermediate UI state that queues or blocks writes) is a small
UX-and-code change, not a redesign, but out of scope for a "narrowly scoped, low-risk"
fix given it touches call sites across the web app; flagged for a follow-up pass
instead of patched blind.

---

## 3. Device State — pairing role per contact

There is no separate "device state" object; it's folded into the **per-contact `role`
field** (`'initiator' | 'responder'`) plus the presence/absence of a `shared_secret_*`
entry. Three independent pairing flows write this: QR/deep-link, phone-number
rendezvous, and the always-on reconnect loops.

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `unpaired` | QR/deep-link offer created | `pairing (role=initiator)` | `App.tsx` `ConnectScreen`, `~2850` (`role:'initiator'`) |
| `unpaired` | QR/deep-link offer received | `pairing (role=responder)` | `~2808` / `~3042` (`role:'responder'`) |
| `unpaired` | phone rendezvous, second registrant | `pairing (role=initiator)` | `App.tsx:2773-2777`, `relay.js` `/phone/register` "Zweiter → Initiator" |
| `unpaired` | phone rendezvous, first registrant | `pairing (role=responder)`, polls | `App.tsx:2779-2831` |
| `pairing` | `onConnected` fires (ICE connected + DataChannel open) | `paired` (contact object persisted with fixed `role`) | `App.tsx:886-903`, `RTCStore.setConnection` |
| `paired` | app restart | `paired` (role/contact reloaded from storage, secret reloaded from `EncryptedStorage`) | `App.tsx:408-429` |
| `paired` | 5-fail wipe (§9) or explicit delete (§10) | `unpaired`/gone-locally | — |

**Role is assigned once, at pairing time, and never re-derived or re-validated
afterward.** Every subsequent reconnect (`checkOutgoing`/`checkIncoming`, both native
and web) branches purely on `contact.role`, never on any live evidence of who
actually holds the "offer" side of the current handshake.

**Impossible state, confirmed structurally:** the local `contacts` array and the
`RTCStore.sharedSecrets`/`EncryptedStorage 'shared_secret_'+id` entry are **two
independently-updated pieces of state with no atomic link between them.** It is fully
representable (and, per §11 below, reachable) for a contact object to exist in
`contacts` with **no** corresponding shared secret (e.g., app killed between
`RTCStore.setConnection()` persisting the contact and the Kyber handshake completing
and persisting `shared_secret_<id>` — see `WebRTCManager.js` `_setupDataChannel`,
secret is set asynchronously in the `kyber_pubkey`/`kyber_ciphertext` handlers,
*after* `onConnected`/`RTCStore.setConnection` already fired). Code that assumes
"paired implies has-secret" (e.g. the reconnect loops' `if (!secret) { ...; return;
}` guards, `App.tsx:526-527`, `:763-764`) **handles this defensively already** — they
silently give up rather than crash — but the user-visible result is a contact that
sits forever unable to reconnect, with no error surfaced, indistinguishable in the UI
from a healthy contact that's just currently offline.

**Concurrent requests / glare (finding 9 — QR pairing):** both `ConnectScreen`'s QR
flow and the phone-rendezvous flow assign role via **out-of-band coordination** (who
scans first / who the relay tells "you're the second registrant") rather than any
tie-breaking inside the WebRTC layer itself. There is **no code path where both sides
believe they are `initiator`** for the *same* pairing attempt, because the relay
(`relay.js` `/phone/register`) and the QR scan action itself are the single source of
truth for who calls `createOffer()` vs. `createAnswer()`. Traced but not found
exploitable: this specific glare class is structurally prevented by the pairing
protocols' own design, not by a runtime check — worth noting as a "held invariant"
rather than a gap.

---

## 4. Session State — WebRTC connection lifecycle

Tracked across three places that must stay consistent: `WebRTCManager`'s own
`pc.iceConnectionState`/`dataChannel.readyState`, `RTCStore.connections` (chatId →
manager instance), and the per-effect `initiatorAttempting`/`responderConnecting` /
`initiatorConnecting` Sets (native/web) that gate *starting* a new attempt.

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `disconnected` | 15s timer (native) / 10s timer (web) tick, `role=initiator`, not already attempting | `connecting (initiator)` | `App.tsx:440-568`; `web/src/App.tsx:88-151` |
| `disconnected` | wake-signal (`onWake`) fires | `connecting` (same guard) | `App.tsx:566`; `web/src/App.tsx:149` |
| `connecting (initiator)` | ICE `connected`/`completed` + DataChannel `open` | `connected` | `WebRTCManager.js:236-256` (`_setupPC`), `onConnected` |
| `connecting` | offer/answer round-trip times out (30 min native / 5 min web safety net) | `disconnected` (guard flag cleared) | `App.tsx:553`; `web/src/App.tsx:136-139` |
| `connected` | ICE `failed` | `disconnected` (`onDisc` fires) | `WebRTCManager.js:243-245` |
| `connected` | ICE `disconnected` for >3s (self-heals if it recovers) | `disconnected` | `:247-255` |
| `connected` | DataChannel `onclose` | `disconnected` | `:279-282` |
| `connected` | no traffic (cover or real) for `STALE_TIMEOUT_MS` (12s) | `disconnected` ("zombie" — active `close()`) | `:464-475` |

**Race conditions (finding 5), specifically checked and found NOT exploitable as
originally hypothesized:** the `initiatorAttempting`/`responderConnecting` Sets are
plain `useRef(new Set())`s checked-then-added **synchronously within a single
`.then()`/async continuation**, with no `await` between the check and the add
(`App.tsx:448-453`; identical pattern `web/src/App.tsx:93-94`). Because JS promise
callbacks never interleave mid-body, two overlapping triggers (the 15s/10s timer and
a wake-signal) **cannot both pass the guard for the same `contact.id`** — whichever
async chain's `AsyncStorage.getItem('contacts')`/loop reaches the check-and-add first
wins outright; the second sees the flag already set and skips. This is a genuine,
correctly-implemented mutex despite being "just a Set" — worth stating plainly since
the task brief flagged this as a likely TOCTOU gap and it is not one, on inspection.

**What IS a real gap (finding 3 — missing state check):** none of `doInitiatorConnect`
/ the responder path re-checks `RTCStore.isConnected(contact.id)` **immediately
before** calling `rtc.createOffer()`/`rtc.createAnswer()` a second time inside the same
attempt — only once at the very top of the loop iteration and once at the top of
`doInitiatorConnect()` itself (`App.tsx:448`, `:455`). Between those checks and the
actual `createOffer()` call there are several `await`s (`_pcConfig()` → `await
getTurnCredentials()`, a real network call). If the *other* side's reconnect attempt
completes and calls this device's `onConnected` **during that window** (e.g., the
responder path found and answered an older, still-pending offer concurrently), this
device proceeds to also finish constructing a **second, redundant** `RTCPeerConnection`
for a contact that is, by the time `createOffer()`'s promise resolves, actually already
`isConnected()`. The result isn't corruption — `RTCStore.setConnection()` simply
overwrites the map entry with whichever `WebRTCManager` instance's `onConnected`
fires second — but it does mean **the "losing" connection's `pc`/`dataChannel` are
silently orphaned** (never explicitly `.close()`d, no reference kept once overwritten,
relying entirely on the liveness watchdog + GC rather than being torn down
deterministically). This is a genuine resource-leak-shaped bug, low severity (bounded
by the number of concurrent reconnect races, self-limits via the liveness watchdog),
not fixed here (would need a "supersede and explicitly close the old rtc" step in
`RTCStore.setConnection`, a small but not zero-risk change to a core shared path used
by every connection type — image/audio/call included).

**Duplicate/out-of-order events (findings 6-7) — kyber_pubkey/kyber_ciphertext: see §5,
this is the highest-value finding in this whole report.**

**App restarts mid-transition (finding 11):** `RTCStore.connections` (in-memory Map)
and `RTCStore.sharedSecrets` (in-memory Map, rehydrated from `EncryptedStorage` at
launch, `App.tsx:415-425`) are **not the same object** as the persisted
`shared_secret_<id>` `EncryptedStorage` entry that `WebRTCManager._setupDataChannel`'s
kyber handlers write to (`WebRTCManager.js:330-339`/`:363-372`, fire-and-forget
`import(...).then(m => m.default.setItem(...))`, not awaited by the handler). A kill
between `this.sharedSecret = result.sharedSecret` (in-memory, immediate) and that
fire-and-forget disk write completing means: **this session still has and uses the new
secret in RAM for as long as the process lives, but on next launch the OLD (or no)
secret is reloaded from disk** — the two sides of the pairing then hold *different*
secrets after restart, and neither will decrypt the other's next message until a fresh
reconnect handshake runs again (self-healing, since every reconnect re-derives a fresh
secret per `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3 — but there is a real, if narrow,
window of totally undecryptable cross-restart traffic with zero user-facing
explanation of why).

---

## 5. Key State — shared-secret lifecycle

**This is where the most valuable finding of this review lives.**

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `none` | new `WebRTCManager()` constructed | `none` (`sharedSecret=null`) | `WebRTCManager.js:96` |
| `none` | initiator: DataChannel `onopen`, sends `kyber_pubkey` (plaintext, by design — pre-secret) | `none` (still waiting on peer's response) | `:264-277` |
| `none` | responder: receives `kyber_pubkey` | `active` (`kyberEncapsulate`, `keyExchangeDone=true`, secret persisted) | `:311-350` (post-fix, see below) |
| `none` | initiator: receives `kyber_ciphertext` | `active` (`kyberDecapsulate`) | `:355-381` (post-fix) |
| `active` | reconnect completes (new `WebRTCManager` instance, fresh Kyber exchange) | `active` (**overwritten** with new secret — real forward secrecy at session boundaries, per `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 3) | same handlers, new instance |
| `active` | *(bug, now fixed — see below)* another `kyber_pubkey`/`kyber_ciphertext` for the SAME instance | *(bug, now fixed)* silently → `active` with a **different** secret | — |
| `active` | contact deleted (§10) | `none` (`RTCStore.sharedSecrets.delete`, `EncryptedStorage.removeItem('shared_secret_'+id)`) | `App.tsx:860-862` |
| — | 33-day reconnect-offer TTL expires with no successful reconnect | secret simply persists forever in storage, **never expires on its own** | confirmed absent — no code path ever calls `removeItem('shared_secret_...')` on a timer |

### Finding: duplicate/replayed kyber_pubkey/kyber_ciphertext silently rotates the
### active secret mid-session — found, and FIXED in this pass

**The bug (pre-fix code, as read verbatim from the repository before this review's
edit):**

```js
// WebRTCManager.js, channel.onmessage, BEFORE this review's fix
if (msg.type === 'system' && msg.subtype === 'kyber_pubkey') {
  console.log('[Crypto] Kyber Public Key empfangen → encapsulate');
  const result = await kyberEncapsulate(msg.publicKey);
  this.sharedSecret    = result.sharedSecret;   // <-- unconditional overwrite
  this.keyExchangeDone = true;
  ...
```

Neither this handler nor its `kyber_ciphertext` counterpart (native or web) ever
checked `this.keyExchangeDone` before running. `kyber_pubkey`/`kyber_ciphertext` are
the **only** message types sent as plaintext over the DataChannel, by explicit design
(`sendMessage()`: *"Key-Exchange Nachrichten immer plain"*), and — per
`SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 6 — the live P2P path had (at the time this
review started; see below) no replay/freshness protection at all. That makes these two
message types uniquely dangerous: **a second, duplicated, or maliciously replayed
copy of either one, delivered any time after the real handshake completed, silently
regenerates and overwrites `this.sharedSecret` with a brand-new value — with zero
signal to the user or the rest of the app.**

**Concrete attack/failure scenario (Key State + Session State):**
1. Two devices pair, Kyber exchange completes, `sharedSecret = S1`, `keyExchangeDone =
   true`. Chat proceeds normally.
2. An attacker positioned to write to the DataChannel data path (a compromised TURN
   relay in the NAT-traversal fallback case — `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`
   Claim 7 already confirms the TURN *control* channel is plaintext-by-explicit-config
   via `coturn-setup.sh`'s `no-tls`/`no-dtls`; the *data* channel itself rides
   DTLS-SRTP/DTLS-over-SCTP which the attacker does not need to break if they can
   simply retransmit an already-once-seen ciphertext frame at the transport level they
   do control) replays the original `kyber_pubkey` frame it observed during the
   original handshake.
3. The responder's `WebRTCManager` runs `kyberEncapsulate` **again**, computes a new
   `S2 ≠ S1`, sets `this.sharedSecret = S2`, persists it over the old value in
   `EncryptedStorage`/`localStorage`, and sends a fresh `kyber_ciphertext` back — to
   whoever is listening, which may or may not still be the real peer's socket.
4. Any message the real peer sends in the (short, but nonzero) window before it also
   observes/processes a `kyber_ciphertext` under `S2` is now encrypted under `S1` on
   one side and expected to decrypt under `S2` on the other — **silent decrypt failure,
   no error surfaced beyond a `console.warn`**, indistinguishable from ordinary packet
   loss.
5. Nothing in the app ever tells the user "your secure session's key just changed
   unexpectedly, without a normal reconnect." The Safety Code (§ per
   `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 5) *would* reflect the new secret if
   recomputed, and — as of a concurrent fix landing during this same session
   (`App.tsx` `safetyChanged` state, `~2201`) — the UI now does raise a small red-dot
   indicator on the shield icon when the computed code differs from the last one the
   user acknowledged. That is a real, independent mitigation for the *symptom*, but it
   does not stop the underlying re-keying from happening in the first place, and nothing
   revokes trust in the session or drops in-flight messages safely.

**Fix applied in this pass (narrowly scoped, matches the bar set by
`SECURITY_REVIEW_4`/`5`'s own fixes):** both handlers, in both `WebRTCManager.js`
(native, lines ~311-328 and ~355-360) and `web/src/lib/WebRTCManager.ts` (lines
~257-266 and ~282-287), now check `if (this.keyExchangeDone) { console.warn(...);
return; }` before doing anything else — a duplicate/replayed handshake message for an
already-keyed connection is now dropped instead of silently re-keying the session.
This does not change any legitimate behavior: a *new* `WebRTCManager` instance is
always constructed for a genuine reconnect (confirmed in §4), so `keyExchangeDone`
starts `false` again exactly when it should.

**Test written and run — `__tests__/security/stateMachine.keyExchangeDuplicate.test.js`**
(4 tests, both native and web implementations, covering both `kyber_pubkey` and
`kyber_ciphertext` duplicate delivery). Real pass/fail output:

```
PASS __tests__/security/stateMachine.keyExchangeDuplicate.test.js
  WebRTCManager (native) - Key State: dupliziertes kyber_pubkey/kyber_ciphertext
    √ zweites kyber_pubkey nach abgeschlossenem Austausch wird verworfen statt sharedSecret zu ueberschreiben (9 ms)
    √ zweites kyber_ciphertext nach abgeschlossenem Austausch wird verworfen (Initiator-Seite) (6 ms)
  WebRTCManager (web) - Key State: dupliziertes kyber_pubkey/kyber_ciphertext
    √ zweites kyber_pubkey nach abgeschlossenem Austausch wird verworfen statt sharedSecret zu ueberschreiben (16 ms)
    √ zweites kyber_ciphertext nach abgeschlossenem Austausch wird verworfen (Initiator-Seite) (8 ms)

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
```

**Verified this test actually catches the bug** by temporarily stripping the two
native guards back out and re-running just this file:

```
FAIL __tests__/security/stateMachine.keyExchangeDuplicate.test.js
    × zweites kyber_pubkey nach abgeschlossenem Austausch wird verworfen ... (7 ms)
    × zweites kyber_ciphertext nach abgeschlossenem Austausch wird verworfen ... (4 ms)
    √ (web tests still pass - only native guard was stripped)
    √
Tests:       2 failed, 2 passed, 4 total
```
(guards restored immediately after, confirmed back to 4/4 passing, full
`__tests__/security` suite re-run afterward: 119/120 passed — the 1 failure is a
pre-existing, unrelated flaky network test in `relay.http.test.js`, `ECONNRESET` on a
>2MB body test against a spawned real HTTP server; not touched by this pass, not
related to WebRTCManager.)

### Pepper rotation state machine (web, `relay.js` /pepper/*) — state transitions
### specifically (crypto already proven safe by the prior audit)

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `no-entry` | `/pepper/register` | `active(fails=0)` | `relay.js` `/pepper/register` handler |
| `active(fails=0)` | `/pepper/request`, no pending token | `active`, `pendingToken` set (30s TTL) | `/pepper/request` handler |
| `active`, `pendingToken` set | `/pepper/request` again before resolving | **429 `versuch_laeuft_noch`, no state change** | same handler — correctly serializes concurrent unlock attempts for one `deviceId` |
| `active`, `pendingToken` set | `pendingToken` expires unused | `active(fails+=1)` (implicit fail) | same handler, "Abgelaufenes ... Token = impliziter Fehlversuch" |
| `active`, `pendingToken` set | `/pepper/fail` with matching token | `active(fails+=1)`, possibly `locked(30s/60s)` or `wiped` | `applyPepperFail` |
| `active`, `pendingToken` set | `/pepper/success` with matching token | `active(fails=0)`, **pepper rotated** | `/pepper/success` handler |
| `active(fails>=5)` | (any) | `no-entry` (`pepperStore.delete`) — client-side mirrors with `localStorage.clear()` | `applyPepperFail` |

**Held invariant, confirmed:** the `pendingToken`/`pendingExpiresAt` pair genuinely
enforces **one in-flight attempt per `deviceId`** — this correctly prevents the
"attacker fires many parallel guesses without ever calling `/pepper/fail`" bypass that
motivated the whole token design (already covered by the crypto audit; re-confirmed
here as a real state-machine mutex, not just a comment's claim).

**Not a new finding, but worth restating precisely for the state-machine lens:** the
one remaining gap (already flagged by the crypto audit as an accepted, documented
residual risk, not re-litigated here) is that an attacker-controlled client can call
`/pepper/success` **instead of** `/pepper/fail` after a wrong guess, resetting `fails`
to 0 itself — this is a state-machine-level trust gap (the state machine trusts the
caller to self-report which branch it took), not fixable without a real PAKE/OPRF
protocol, and the code's own comment says so honestly (`relay.js`, `/pepper/request`
handler comment block).

---

## 6. Message State — send/queue/deliver/expire

| Current State | Event | Next State | Citation |
|---|---|---|---|
| — | user taps send, `RTCStore.isConnected()==true` | `sending` → `sent` | `App.tsx:2124-2130`; `web/src/App.tsx:747-761` |
| — | user taps send, not connected | `sending` → relay POST `/packet` → `sent` (relay accepted) or `failed` | `App.tsx:2143-2151`; `web/src/App.tsx:749-782` |
| `sending` | live send + relay POST both fail | `failed` | both files, `updateStatus('failed')` paths |
| `sent` | peer's `receipt` message arrives | `delivered` (native only — `App.tsx:1600-1606`, `status:'delivered'` supported in the UI render logic `2513-2518` but **no code path in the reviewed sections ever sets `status:'read'`** despite the UI rendering a `read` glyph) | `App.tsx:1605-1606` |
| image/audio: `sending` | queued to disk (`queue_<contactId>`) when offline | `queued-offline` | `App.tsx` `_onReady` queue-processing blocks, `RTCStore.js:131-167`/`230-261` |
| `queued-offline` | next successful connection, `_onReady` fires | `sent` (queue flushed) or **stays queued** if decrypt fails | `App.tsx:474-519` |

**Impossible state, confirmed:** a message can be marked `'sent'` in local UI state
purely because `RTCStore.sendMessage()` returned `true` — and `sendMessage()` returns
`true` in **two** distinct underlying situations that the caller cannot distinguish:
(a) the DataChannel really is open and the ciphertext was hand off to
`dataChannel.send()` (`WebRTCManager.js` `sendMessage()`), or (b) **no shared secret
exists yet**, in which case the message is merely pushed onto `this.pendingMsgs` and
`sendMessage()` still returns `true` (`WebRTCManager.js:191-194` /
`web`'s equivalent `:158-161`). Case (b) means: **a message can show "✓ sent" in the
UI while it has not actually left the device** — it's sitting in an in-memory
`pendingMsgs` array, not even the durable `queue_<id>` disk queue, so **an app kill
before `_flushPending()` runs loses it silently**, with the UI having already told the
user it was sent. This is a real "impossible state" (UI status doesn't match reality)
reachable any time a reconnect's DataChannel opens (`onConnected` fires,
`RTCStore.isConnected()` may already read `true` since it only checks
`dataChannel.readyState`+`iceConnectionState`, not `keyExchangeDone`) fractionally
before the Kyber handshake completes.

**Read receipts:** the `'read'` status has UI rendering support
(`App.tsx:2517-2518`, a `✓✓✓` glyph) but no code path in the reviewed message-handling
logic (`App.tsx:1580-1720`) ever transitions a message to `status:'read'` — this
status is dead/unreachable in the current build, not a security bug but a
state-machine dead-end worth flagging (the UI can never actually show it, despite
rendering logic for it existing).

---

## 7. Delivery State — relay packet lifecycle vs. client polling

`relay.js`'s `store` Map is the ground truth. Three delivery patterns coexist with
**different** at-most-once guarantees:

| Endpoint | Delete timing | Citation |
|---|---|---|
| `POST /send` → `GET /receive/:recipient` | marks `delivered=true` **synchronously** inside the same request handler, actual `store.delete` deferred 1s via `setTimeout` | relay.js `/receive/` handler |
| `POST /packet` → `GET /packet/:recipient` | `store.delete(key)` **synchronously**, same request, no delay | relay.js `/packet/` handler |
| `POST/GET /reconnect/offer(/answer)` | `store.delete` synchronously on the GET that finds it | relay.js `/reconnect/offer/`, `/reconnect/answer/` handlers |

**Held invariant, confirmed by re-reading the Node event-loop model:** because every
one of these delete-on-fetch operations happens in a **synchronous** code block
(no `await` between "found it" and "deleted it") inside a single request callback,
Node's single-threaded execution model means two concurrent `GET` requests for the
same recipient **cannot both observe the same still-present packet** — whichever
request's callback runs first (fully, to completion, since nothing yields control
mid-loop) deletes it before the second request's callback body even starts. **The
originally-hypothesized "double delivery" window does not exist at the relay layer**
for any of these endpoints, for a single relay process. (It could reappear behind a
load balancer fronting multiple relay processes/instances sharing no state — but this
app's relay is explicitly single-process, in-RAM-only by design, so that's out of
scope, not a gap in the current architecture.)

### The real bug this task's framing was aimed at: **message loss, not double delivery**

Because deletion happens **synchronously with the GET that fetches it**, and the
relay never asks the client to *acknowledge* successful local processing, the actual
risk runs the other direction:

**Concrete scenario (Delivery State):**
1. Device B is offline while Device A sends a message; A's live send fails, A's relay
   fallback succeeds — `POST /packet` stores it, `store.set('packet_B_<ts>', ...)`.
2. B comes online. `checkIncoming`/web's equivalent polls `GET /packet/B`.
3. The relay's handler synchronously **finds the entry, pushes it into the response
   array, and calls `store.delete(key)` — all before the HTTP response is even
   flushed to the socket** (`relay.js` `/packet/` GET handler).
4. The HTTP response is now in flight back to B. **If B's process is killed, or the
   network drops, at any point between the relay sending this response and B finishing
   `decryptMsg()` + `RTCStore.buffer.get(id).push(original)` / the equivalent
   persistence step**, the message is now **permanently gone**: it no longer exists on
   the relay (already deleted server-side, step 3), and B never actually stored it
   locally.
5. There is no redelivery mechanism anywhere in the protocol for this case — no ack
   step, no "didn't confirm receipt, keep it a bit longer" grace period. Contrast this
   with the *image/audio transfer queue* (`queue_<contactId>` in `EncryptedStorage`),
   which explicitly *is* designed to survive exactly this kind of interruption by
   persisting to disk before attempting delivery — ordinary relay-fallback **text**
   messages and system packets (`delete_chat`/`secret_end`/`secret_start`) have no
   equivalent durability on the *receiving* side.

This is a genuine, previously-uncited (by any prior review, and inverted from what the
task brief's own hypothesis assumed) **message-loss** window, not a double-delivery
window. Not fixed here — a real fix needs either a client-ack step before server-side
deletion (a protocol change touching every polling endpoint) or a short deletion delay
plus idempotent client-side dedup (a more contained change, but still touches the
relay's core delivery guarantee and every client poll site) — out of scope for a
narrowly-scoped patch.

---

## 8. Group State — N/A, confirmed

Grep for `[Gg]roup` across `App.tsx` returns zero matches. There is no group-chat data
model, no multi-party session key, no membership list anywhere in the codebase. The
architecture is strictly 1:1 (confirmed by the pairing model in §3, which has exactly
one `role` per contact and exactly one shared secret per contact — no N-party key
agreement exists in `HybridCrypto.js`/`.ts`). Nothing further to analyze here.

---

## 9. Recovery State — PIN forgotten / 5-fail wipe

**Native: there is no recovery path at all.** `LockScreen`'s `n>=5` branch
(`App.tsx:1108-1144`) performs a full local wipe:
`AsyncStorage.multiRemove([...])` + `AsyncStorage.clear()` + per-key
`EncryptedStorage.removeItem` + `EncryptedStorage.clear()` + deletion of any queued
media files — **including every `shared_secret_<contactId>` entry**. This is
confirmed exhaustive (it clears the *entire* `EncryptedStorage`/`AsyncStorage`
namespace, not just a curated key list, per the explicit `AsyncStorage.clear()` +
`EncryptedStorage.clear()` calls). "Recovery" is not recovery — it is **irreversible
data loss**, and the code makes no claim otherwise (`err: '🔴 Gerät wird
zurückgesetzt...'`). Re-pairing afterward necessarily uses a fresh
`generateContactId()` (cryptographically random, `App.tsx:77-93`) — **there is no way
to resurrect the old `contactId` even if the user wanted to**, since nothing about
device identity survives the wipe.

**Concrete scenario — what happens to the OTHER party's device (traced, not
speculative):**
1. Device B (the wiped one) had contact A paired, `role='responder'` say, with a live
   `shared_secret_A` and A present in B's `contacts` array.
2. B fails the PIN 5 times. Full wipe runs (`App.tsx:1108-1144`). **No `delete_chat` or
   `secret_end` notification is ever sent to A** — the wipe branch contains no call to
   `RTCStore.sendMessage`/`fetch(RELAY_URL + '/packet', ...)` of any kind; it is purely
   local cleanup.
3. Device A's `checkOutgoing`/`checkIncoming` loop (§4) continues polling for B
   indefinitely: A's `contacts` array still lists B, A still holds
   `shared_secret_B` (now orphaned — B no longer has the matching half), and A's
   `role` for B (`initiator` or `responder`) determines which reconnect loop keeps
   running for up to the 33-day `EXPIRE_RECONNECT` TTL on any offer A posts to the
   relay (`relay.js`, `EXPIRE_MS`/`EXPIRE_RECONNECT` constants) — after which A simply
   gets silent 404s/`null` back from `/reconnect/offer/*` forever, retried every 15s/8s
   (native) or 10s/8s (web), forever, with **zero user-facing indication that anything
   is wrong** — a contact that just looks permanently "not yet connected."
4. If B re-pairs with A as a *new* contact afterward, this produces a **second,
   unrelated contact entry on A's side** (new `contactId`, new secret) — A now has two
   entries that both nominally represent "B," one dead, one live, with no automatic
   reconciliation or even a naming hint (both default to `"Neuer Kontakt"` until a
   handshake profile-name packet arrives, `App.tsx:717-721` etc.).

This confirms, concretely, exactly the scenario the task brief anticipated: recovery
is "start over as a new pairing," and the other party's device is left holding a dead
contact indefinitely with no error signal, no automatic cleanup, and (if they
re-pair) a confusing duplicate-contact state. **Not fixed here** — the correct fix (a
best-effort `delete_chat`/`secret_end` broadcast attempted *before* the wipe
proceeds, to every contact with a live secret) is a small, plausible addition
(`fetch` calls already exist in the same file for exactly this purpose, see §10) but
was deliberately not added blind under this task's "narrowly scoped, low risk" bar,
because the 5-fail wipe path is explicitly a break-glass/adversarial-device scenario
— sending outbound network traffic (even best-effort) at exactly the moment a hostile
actor has been brute-forcing the PIN is a judgment call about threat model
(does notifying contacts leak that "device X was just wiped, possibly seized" to a
relay-observing adversary?) that deserves an explicit decision from the project owner,
not a silent addition in a review pass.

**Web:** functionally identical pattern — `unlockEncryption()`'s 5th fail wipes
`localStorage.clear()` client-side (`Storage.ts:131-134`) after the *server-side*
pepper entry is already deleted (`relay.js` `applyPepperFail`, `fails>=5`) — same
"no recovery, no peer notification" characteristics apply.

---

## 10. Logout/Revocation State — delete_chat / secret_end

There is no "logout" concept (no session to log out of, per §1/§2). Revocation is
per-contact, via two system message subtypes.

| Current State | Event | Next State | Citation |
|---|---|---|---|
| `paired, chat-active` | user taps trash icon (in-chat header) | live `delete_chat` sent via `RTCStore.sendMessage` (P2P-only, best-effort, **not confirmed delivered**), then local delete after 500ms regardless | `App.tsx:2364-2382` (ChatScreen header button) |
| `paired, chat-active` | that 500ms timer fires → `onDelete` prop handler | full local teardown (contact removed, chat/timer/secret/queue storage wiped, RTC connection closed, secret deleted from `RTCStore`+`EncryptedStorage`) **synchronously**, THEN an encrypted relay-fallback `delete_chat` POST is fired **fire-and-forget** (`.catch(()=>{})`, not awaited) | `App.tsx:838-883` |
| `paired, secret-chat-active` | user ends secret chat | live `secret_end` send + encrypted relay-fallback POST (same fire-and-forget pattern) + local message wipe | `App.tsx:2393-2429` |
| peer receives `delete_chat` (post-freshness-check) | contact removed from peer's local list, chat/timer storage wiped | — | `App.tsx:630-638` (relay-fallback path), equivalent in `WebRTCManager.js`'s live-onmessage path |
| peer receives `secret_end` | secret-chat flag cleared, chat history wiped, `secret_ended_<id>` marker set | — | `App.tsx:625-629`, `:1653-1666` |

**Finding — network interruption / app restart mid-transition (findings 10, 11,
14), concrete and reachable:** the deletion handler at `App.tsx:838-883` performs
**all local, irreversible state changes synchronously and immediately** — contact
array filtered, chat/timer/secret/queue storage removed, RTC connection closed, secret
deleted from both `RTCStore` and `EncryptedStorage` — and only *afterward* kicks off
the peer-notification chain: `encryptMsg(...).then(enc => { fetch(...).catch(() =>
{}) })`, entirely unawaited by the caller, with `nav('home')` firing immediately
after. Concretely:

1. User taps delete, confirms in the `Alert`.
2. `onDelete` handler runs: local state is now fully gone (steps in `:844-863`).
3. **If the app is killed, backgrounded-and-OS-reaped, or the device loses
   connectivity in the next few hundred milliseconds** — before the `encryptMsg`
   promise resolves and the subsequent `fetch()` completes — **the peer is never
   notified**, and there is **no retry, no durable queue entry, no persisted
   "pending notification" record anywhere** for this specific operation (contrast
   again with the image/audio `queue_<id>` mechanism, which *is* durable across
   restarts).
4. Net result: **exactly the mutually-inconsistent state the task brief asked about**
   — the local user's device has fully and irreversibly forgotten the contact; the
   peer's device still has the contact, the (now one-sided) shared secret, and will
   keep attempting reconnects against it indefinitely (same failure mode as §9,
   minus the possibility of a duplicate re-pair since this side no longer has any
   record at all to accidentally collide with).

This is a real, reachable "logout"/revocation-durability gap: the *notification* of
revocation has strictly weaker delivery guarantees than the local revocation itself,
with no code-level acknowledgment that this asymmetry exists. Not fixed here — the
correct fix (persist the pending `delete_chat` notification to disk *before*
performing local teardown, and retry it on next launch until acknowledged or expired,
mirroring the existing `queue_<id>` pattern used for media) is a real feature
addition, not a narrow patch, and risks interacting with the 33-day reconnect TTL and
the relay's packet-expiry semantics in ways that deserve dedicated design attention
rather than a blind addition here.

**Duplicate events (finding 6), checked:** a second, duplicated `secret_end` for a
chat that was already ended: `App.tsx:625-629`/`:1653-1666` handlers are all
idempotent no-ops on a second delivery (`removeItem` on an already-removed key,
`setSecret(false)` on already-`false` state) — **no bug found here**, this class of
duplicate is handled safely by construction.

**Replay of a `secret_start` within the freshness window, right after a legitimate
`secret_end` (finding 8), traced:** `isFreshTimestamp()` only rejects packets older
than 15 minutes or more than 5 minutes in the future (`App.tsx:103-109`) — it does
**not** track "have I already processed a `secret_end` more recent than this
`secret_start`'s timestamp." A `secret_start` captured and replayed by a relay-position
attacker **within** the same 15-minute freshness window as a legitimate, subsequent
`secret_end` **is accepted** — `original.type === 'system' && original.subtype ===
'secret_start'` (`App.tsx:620-624`/`:1667-1679`) has no ordering check against
`secret_end`, only the blanket freshness check shared by every system-control type.
Concretely: attacker observes a genuine `secret_start` (necessarily plaintext-adjacent
metadata is *not* exposed — the packet itself is still AEAD-ciphertext, so this
requires the attacker to have observed the *exact* ciphertext blob once, e.g. via
relay access to the `/packet` store before its 10-minute TTL, or via a compromised TURN
control channel timing side-channel establishing that *a* system packet of some kind
was exchanged) and replays it after the real `secret_end` — the recipient's secret-chat
UI re-activates with the *original* `mins`/`endsAt` values from the replayed packet,
potentially **resurrecting an already-intentionally-ended self-destruct timer state**
for up to the remainder of the 15-minute freshness window. This is a genuine, narrow,
previously-uncited state-level replay gap layered on top of an already-fixed
transport-level replay protection (the freshness check itself works correctly for what
it's designed for — timestamp staleness — it just isn't sequence-aware). Not fixed
here: closing it properly needs a monotonic per-chat sequence number or a
last-processed-timestamp high-water-mark persisted per contact, which is a small but
real protocol change (affects the wire format) rather than a one-line guard, so it's
documented rather than patched blind.

---

## Summary — prioritized findings

### Real, exploitable/reachable state-machine bugs (ranked by impact)

1. **Fixed in this pass** — `WebRTCManager.js`/`.ts`: duplicate or replayed
   `kyber_pubkey`/`kyber_ciphertext` silently re-keyed an active session mid-conversation
   with zero signal to the user (§5). This was the most severe finding: it turns the
   *only* unauthenticated, unprotected message type on the live P2P path into a session
   disruption/potential-hijack primitive for anyone positioned to write to the
   DataChannel transport (e.g. via the TURN control-channel weaknesses independently
   confirmed in `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 7). Guard added, 4 tests
   written and passing, verified to fail pre-fix.
2. **Message loss on relay-fallback delivery** (§7): the relay deletes a packet
   synchronously as part of serving the `GET` that fetches it, with no client
   acknowledgment step — an app kill/network drop between the HTTP response and local
   persistence permanently loses the message, with no redelivery path. Inverse of, and
   more concretely reachable than, the "double delivery" scenario the task brief
   hypothesized. Not fixed (protocol-level change).
3. **Revocation-notification durability gap** (§10): local `delete_chat` deletion is
   synchronous and irreversible; the peer-notification fetch is fire-and-forget with no
   durable retry. An app kill in the following instant leaves the two parties
   permanently, silently inconsistent (one thinks the chat is gone, the other's device
   keeps retrying a dead contact forever). Not fixed (needs a durable queue, same
   pattern as the existing media queue).
4. **5-fail wipe never notifies paired contacts** (§9): both native PIN wipe and web
   pepper wipe leave every paired contact's device holding a dead, orphaned secret with
   no notification, for up to 33 days of silent retries, and duplicate-contact risk on
   re-pair. Deliberately not fixed blind (threat-model judgment call: broadcasting
   "this device was just wiped" during an adversarial brute-force scenario needs an
   explicit decision, not a silent addition).
5. **`secret_start` replay within the freshness window can resurrect an
   already-ended secret chat** (§10): the freshness check is staleness-aware but not
   sequence-aware; a captured-and-replayed `secret_start` sent within 15 minutes of a
   legitimate `secret_end` re-activates the self-destruct-timer UI with stale
   parameters. Narrow window, requires prior ciphertext capture; documented, not
   patched (needs a wire-format sequence number).
6. **Web `Storage.ts` key-rotation window** (§2b): `dek` stays unset for a full network
   round-trip plus a full local-storage re-encryption pass even after the PIN has been
   verified correct; concurrent `setItem()` calls in that window throw and (if
   fire-and-forget, the codebase's dominant pattern) are silently dropped. Documented,
   not patched (needs an explicit "unlocking" UI/code state across call sites).
7. **UI "sent" status can be shown for a message that never left the device**
   (§6): `WebRTCManager.sendMessage()` returns `true` both when a message is actually
   handed to the open DataChannel and when it's merely queued in a non-durable
   in-memory array pending key exchange — the caller cannot tell the difference, and an
   app kill in the latter case loses the message despite the UI already showing
   "sent." Documented, not patched.
8. **Orphaned `RTCPeerConnection`/`WebRTCManager` on a reconnect race** (§4): two
   overlapping reconnect attempts for the same contact can both complete; the losing
   instance is silently overwritten in `RTCStore.connections` without being explicitly
   closed. Low severity (self-bounds via the liveness watchdog), documented, not
   patched (touches a shared path used by every connection type).

### Stylistic / robustness observations (lower priority, included for completeness)

- Native LockScreen's biometric path never participates in the 5-fail wipe counter
  (§2a) — not exploitable (OS-arbitrated biometrics have their own lockout), but the
  app's "5 wrong attempts wipes the device" promise is implicitly PIN-only.
- The `'read'` message status has UI rendering support but is structurally
  unreachable — no code path ever sets it (§6). Dead code / incomplete feature, not a
  security issue.
- Device/pairing "impossible state" where a contact exists with no corresponding
  shared secret (§3) is already defensively handled (silent no-op) everywhere it's
  read, but produces a permanently-stuck, unexplained contact in the UI rather than an
  actionable error.

---

## What this pass independently confirms was already fixed, concurrently, during
## this same session

While this analysis was being written, other passes in this session (visible via
`git diff` against the pre-session baseline) independently:
- Added a live-P2P-path freshness/replay check for `type:'text'` messages in both
  `WebRTCManager.js` and `.ts` (closing the exact "replay-proof everywhere" gap
  `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 6 flagged as open) — confirmed present and
  correctly wired to `Date.now()`-based wire timestamps, not display-string ones.
- Added a Safety-Code-changed indicator (`safetyChanged` state, red dot + banner) to
  `App.tsx`'s `ChatScreen`, meaningfully improving (though not fully closing) the
  "Safety Code is theater" finding from `SECURITY_AUDIT_CRYPTO_CLAIMS.md` Claim 5 —
  this is directly relevant to §5's Key State machine, since it's the first
  user-facing signal that a session's key material changed outside a normal
  reconnect.
- Switched `relay.js`'s `hashIp()` from bare `sha256(ip)` to an HMAC keyed by a
  per-process random secret, closing the reversibility gap
  `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md` Claim 3 identified.
- Softened the phone-connect "Zero-Knowledge" UI string and the relay's file-header
  "keine Metadaten, keine Logs" claim to match what the code actually guarantees.

These are noted here rather than re-presented as open findings, per the instruction to
independently verify current-vs-stale claims rather than inherit any prior document's
framing uncritically.
