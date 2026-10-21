# Secrets Lifecycle Audit — Fixes Applied

Fixes all 8 findings from `SECURITY_SECRETS_LIFECYCLE.md`'s "Prioritized
findings summary", in that order. No cryptography changed — all fixes are
logging/lifecycle/cleanup only, as scoped.

**Concurrent editing note:** a separate agent was simultaneously fixing 4
unrelated findings from `SECURITY_CHAOS_TESTING.md` in overlapping files
(`relay.js`, `WebRTCManager.js`/`.ts`, `web/src/lib/Storage.ts`,
`App.tsx`/`web/src/App.tsx` poll loops). All files were re-read immediately
before each edit; no collisions occurred. `git diff --stat` at the end shows
both sessions' changes intermixed in the same files, as expected.

---

## Fix 1 (S-4): plaintext logged unconditionally — FIXED

- `App.tsx`: `console.log('[Chat] Nachricht via RTCStore:', msg)` →
  `msg.type` only, inside `ChatScreen`'s `RTCStore.setMessageListener`
  callback.
- `App.tsx`: `console.log('[P2P] Message:', msg)` → `msg.type` only, in the
  `WebRTCManager` constructor callback of the phone-connect flow.
- Grepped both `App.tsx` and `web/src/App.tsx` for every other
  `console.log/warn/error` call touching `msg`/`message`/`data`/`payload`:
  all remaining sites (e.g. `msg.chatId`, `msg.name`, `msg.mode`, `msg.myId`,
  `item.msgId`, `e.message`) already log only metadata/scalars, never the
  full object or `.text`/`.base64`. No other outliers found; `web/src/App.tsx`
  had no full-message-object log sites at all.

## Fix 2 (S-1): wipe doesn't clear in-memory RTCStore — FIXED

- Added `RTCStore.resetAll()` to both `RTCStore.js` (native) and
  `web/src/lib/RTCStore.ts` (web): closes every live connection
  (try/catch-wrapped), then clears `connections`, `listeners`, `buffer`,
  `sharedSecrets`, and — native only, guarded with `?.clear()` since they're
  lazily created — `audioBuffer`, `imgBuffer`, `pendingAvatars`,
  `pendingAvatarExpected`, `profileSent`.
- Wired into `App.tsx`'s 5-fail wipe branch, placed right after the
  `device_wiped`-notification code (which reads `RTCStore.sharedSecrets`)
  and before the `AsyncStorage`/`EncryptedStorage` clearing.
- Wired into `web/src/App.tsx`'s `onUnlock`'s `case 'wiped':` branch, before
  the returned display string.
- Test: `__tests__/security/stateMachine.rtcStoreWipeLifecycle.test.js` —
  populates both native and web `RTCStore` singletons with a connection
  (close spy), shared secret, buffered message, and (native only)
  audioBuffer/imgBuffer/pendingAvatars/pendingAvatarExpected entries, then
  asserts `resetAll()` empties everything and every connection's `.close()`
  was actually invoked, including when one connection's `close()` throws.
  Also asserts the App.tsx/web wiring via source-position checks (same
  pattern as `stateMachine.pollCycleGuard.test.js`: resetAll() call is
  textually after the notification code and before the storage clear on
  native, and present in the `'wiped'` case on web).

## Fix 3 (S-5): raw voice recordings never deleted — FIXED (code-verified, not unit-tested)

- `sendAudioPreview()`: captures `audioPreview.path` before
  `setAudioPreview(null)` and calls `RNFS.unlink(rawRecordingPath).catch(()
  => {})` immediately (the base64 is already in memory from
  `stopRecording()`, so the raw file is redundant regardless of which send
  branch — P2P/relay/queue — is taken next).
- Cancel button (`x` icon in the preview bar): now unlinks
  `audioPreview.path` before calling `setAudioPreview(null)`.
- `playAudio()`: the temp file unlink now happens inside the `player.play()`
  completion callback on **both** the success and error paths (previously
  only implicit success), plus a best-effort unlink in the outer `catch`
  block for failures before/during playback setup. Used a `let path`
  declared before the `try` (with a locally-scoped `RNFSLocal` for the write
  call) so the `catch` block can still reference `path` for cleanup without
  a `ReferenceError` if it's still `undefined`.
- **Judgment call on tests:** did not add a unit test for this fix. Driving
  `startRecording`/`stopRecording`/`sendAudioPreview`/`playAudio` requires
  mocking the `Recorder` class, `PermissionsAndroid`, `@react-native-community/audio-toolkit`'s
  `Player`, and multiple pieces of component state inside a 190KB monolithic
  `ChatScreen` component — none of which have existing mocks/harnesses in
  this repo (the existing `__mocks__/react-native-fs.js` mock only covers
  the filesystem calls, not the recorder/player). This matches how this
  session's prior chaos-testing pass already treated similarly
  hard-to-render UI logic (see `stateMachine.pollCycleGuard.test.js`'s own
  comment: full render deemed disproportionate for a single finding,
  verified via source-structure checks instead). Fixed directly via code
  reading and manual trace of all 4 call sites; verified no other `unlink`
  call site was missed by re-grepping `RNFS.unlink`/`RNFS.writeFile` in
  `App.tsx` after the change.

## Fix 4 (S-3): chat-delete doesn't purge buffered plaintext — FIXED

- Added `RTCStore.clearContact(chatId)` to both `RTCStore.js` and
  `web/src/lib/RTCStore.ts`: closes+deletes that one connection, deletes its
  `sharedSecrets`/`buffer`/`listeners` entries, and (native only) deletes
  any `audioBuffer`/`imgBuffer` keys matching the `chatId + '_'` or
  `'avatar_' + chatId + '_'` prefix (matches the exact key formats used in
  `RTCStore.js`'s `onMessage` handler) and the `pendingAvatars`/
  `pendingAvatarExpected` entries for that contact.
- `App.tsx`'s local chat-delete handler (`onDelete`): replaced the manual
  `RTCStore.connections.delete(chatId)` / `RTCStore.sharedSecrets.delete(chatId)`
  pair with a single `RTCStore.clearContact(chatId)` call.
- `App.tsx`'s `device_wiped` tombstone handler (contact reset their own
  device): replaced its manual connection-close + `sharedSecrets.delete`
  with `RTCStore.clearContact(contact.id)` (optional simplification from the
  task, applied since it was a clean drop-in).
- `web/src/App.tsx`'s `device_wiped` tombstone handler: same simplification,
  `RTCStore.clearContact(contact.id)`.
- **Web has no chat-delete/`onDelete` flow at all** — confirmed by grep
  (`onDelete`/`deleteChat`/`delete_chat` handler: zero matches outside a
  comment noting web deliberately doesn't implement `delete_chat` yet). So
  there is no "equivalent onDelete handler" to wire on web for this fix;
  only the `device_wiped` tombstone path applies there, which is now fixed.
- Test: covered in the same `stateMachine.rtcStoreWipeLifecycle.test.js` —
  populates two contacts' worth of data on both platforms, calls
  `clearContact()` on one, and asserts that contact's connection/secret/
  buffer/audio/image/avatar data is gone while the other contact's data
  (including its own audio/image buffer entries with the same numeric
  suffix, to catch a prefix-matching bug) is fully intact.

## Fix 5 (S-2): ephemeral Kyber keypair never nulled in close() — FIXED

- Added `this.myKyberKeys = null;` and `this.safetyCode = null;` to
  `close()` in both `WebRTCManager.js` and `web/src/lib/WebRTCManager.ts`,
  alongside the existing `pc`/`dataChannel`/`sharedSecret`/`keyExchangeDone`
  resets.
- Verified via the existing `close()`-exercising tests in
  `__tests__/security/chaos.keyStateRace.test.js` (calls `.close()` on both
  native and web `WebRTCManager` instances after a real Kyber handshake) —
  these continued to pass unchanged, confirming no regression. Did not add
  a new assertion there since that file is concurrently owned by the other
  session's Kyber-timing work; instead this is covered structurally by the
  full test suite passing with the new `close()` body executing on every
  existing `.close()` call site in the test suite.

## Fix 6: Safety Code logged unconditionally, native-only — FIXED

- `WebRTCManager.js` (two call sites, responder + initiator branches):
  `console.log('[WebRTC] Safety Code:', this.safetyCode)` →
  `console.log('[WebRTC] Safety Code berechnet')` (no value).
- `RTCStore.js` (post-key-exchange profile-send flow):
  `console.log('[Safety] Code:', rtc.safetyCode)` →
  `console.log('[Safety] Code verfuegbar')` (no value).
- Confirmed `web/src/lib/WebRTCManager.ts` never had this log site to begin
  with (matches the audit's noted native/web asymmetry) — no web-side change
  needed.

## Fix 7: contacts in plain AsyncStorage — SKIPPED, documented

> **CORRECTION (verified false positive, added during the contacts
> lost-update race fix pass — see `CONTACTS_RACE_FIX.md`):** the premise of
> this finding is incorrect. `App.tsx`'s own `AsyncStorage` (defined at
> `App.tsx:22-26`) is not the real `@react-native-async-storage/async-storage`
> package — it is a local compatibility shim whose every method delegates
> 1:1 to the real `EncryptedStorage` (imported from
> `react-native-encrypted-storage`; confirmed by reading the shim's code and
> by a repo-wide grep for the real package name, which returns zero import
> sites). So every one of the ~30 `AsyncStorage.getItem('contacts')`/
> `setItem('contacts', ...)` call sites counted below was, and always has
> been, an `EncryptedStorage` call under a locally-named alias — contacts
> were never in plain/unencrypted storage. The "skipped" decision below
> turned out to be moot for the reason it gives (no key material exposed by
> plaintext contacts), since there was no plaintext storage to begin with;
> it is being correctly addressed instead as a **lost-update concurrency
> race** on that same key (`SECURITY_CONCURRENCY_REVIEW.md` §5,
> `SIMPLIFICATION_PASS.md` B1), fixed via a serializing `updateContacts()`
> helper — see `CONTACTS_RACE_FIX.md`. The investigation notes below are
> left as-is for the historical record, with this correction taking
> precedence wherever they conflict.

Investigated scope before touching anything, per the task's own framing of
this as the lowest-priority, most architecturally-invasive, and explicitly
optional finding:

- **Web:** already not applicable — `web/src/App.tsx` uses `getItem`/
  `setItem`/`removeItem` imported from `./lib/Storage` (the PIN+pepper-gated
  encrypted wrapper) for the `'contacts'` key, never raw `localStorage`.
  Confirmed by reading the import (`import { getItem, setItem, removeItem, ...} from './lib/Storage'`)
  and its usage sites. No action needed.
- **Native:** grepped every `'contacts'` reference in `App.tsx` — found
  **~30 individual `AsyncStorage.getItem('contacts')`/`setItem('contacts', ...)`
  call sites** scattered across the file (setup, rename, delete-chat,
  message-receive handlers, handshake/profile handlers, phone-connect flow,
  etc.), plus one `multiRemove(asyncKeys)` batch in the wipe path where
  `'contacts'` sits alongside `my_id`/`username`/`avatar`/`app_pin`/
  `pin_length`/`bio_enabled`/`setup_done`/`settings` — that batch is already
  followed by a defensive per-key `EncryptedStorage.removeItem()` loop over
  the *same* key list, so the wipe path already double-clears `contacts`
  from both stores regardless of which one it's "really" in.
- **Decision: skipped.** A clean migration would require touching all ~30
  call sites individually (each one is a standalone, non-batched call, so
  there's no `multiGet`/`multiRemove` entanglement blocking a swap
  mechanically) — but this is not "a handful of call sites" as the task's
  go/no-go criterion describes, it's a sweep across the entire 3600+ line
  file. Combined with a separate agent concurrently editing large sections
  of this exact file (poll loops, LockScreen wipe block) in this same
  session, a broad find-and-replace-style change here carries real risk of
  merge conflicts or silently reverting the other session's in-flight work.
  Given the audit's own verdict that no key material is exposed by this
  (contacts objects have no `secret`/`pin`/`token` field) and its explicit
  framing as optional, I left this as-is rather than forcing a 30-site
  refactor. Flagging for a dedicated follow-up pass once the concurrent
  edits have landed.

## Fix 8: full error objects logged instead of sanitized messages — FIXED

- `ImageCrypto.js:100`: `console.error('[ImageCrypto] Fehler:', e)` →
  `e?.message || e`.
- `AudioCrypto.js:78`: `console.error('[AudioCrypto] Fehler:', e)` →
  `e?.message || e`.
- `MessageCrypto.js` (both call sites, encrypt + decrypt failure paths):
  same change, `e?.message || e`.
- No test added (task marked this optional/trivial) — verified the existing
  test suite (which exercises these catch paths via `chaos.corruptedState.test.js`
  and others) continues to pass unchanged with the new log format.

---

## Test run

`npx jest` (full suite, 22 suites / 232 tests including the new
`stateMachine.rtcStoreWipeLifecycle.test.js`):

- One run: 1 failed (`relay.js - Body-Groessenlimit` → `read ECONNRESET`),
  231 passed — this is the documented pre-existing flake from parallel
  full-suite load. Re-ran `npx jest relay.http.test.js` in isolation: all 39
  tests in that file, including the body-size-limit one, passed cleanly.
- A separate, unrelated intermittent issue was observed during this session:
  two **untracked** fuzz test files added by the concurrent
  chaos-testing session (`fuzz.messageCrypto.test.js`,
  `fuzz.keyMaterial.test.js`, not part of this task's scope or git history)
  occasionally failed or crashed a Jest worker when run as part of the full
  parallel suite, but passed cleanly every time when run in isolation
  (`--runInBand`). These files test property-based fuzzing of
  `MessageCrypto`'s encode/round-trip logic and key-material handling — not
  code this task touched (my only change to `MessageCrypto.js` was the
  Fix 8 log-sanitization line, which doesn't affect control flow or return
  values). Left untouched as out-of-scope; belongs to the other in-flight
  session.
- With those two unrelated fuzz files excluded, the full suite is
  consistently green: 19 suites / 205 tests passing, repeated twice.

No commits were made; all changes are left in the working tree for review.
