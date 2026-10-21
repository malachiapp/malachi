# Simplification Pass — Redundancy, Overengineering, Dead Code

Scope: the four merged requests (redundant/duplicated code, semantic
redundancy, overengineering, dead/legacy code) applied as one surgical pass
over the native RN app (repo root) and web client (`web/src/`). No crypto
primitives/protocol logic touched (`MessageCrypto.js`/`.ts`, `HybridCrypto.*`,
Kyber/ML-KEM exchange in `WebRTCManager.*`) — only import/dead-code/duplicate
cleanup around them. No commits made; everything left for review.

There is no traditional database in this codebase (per the architecture
docs: `relay.js` holds only in-RAM `Map`s, clients use
`AsyncStorage`/`EncryptedStorage`/`localStorage`) — the "unnecessary DB
queries" item from the task is reinterpreted as "unnecessary storage reads",
addressed in A4 below.

## Redundancy map

| # | Finding | Location | Category | Action |
|---|---|---|---|---|
| A1 | Duplicate `else if` branch for `profile_avatar_removed`, byte-identical, immediately following the real one — second copy structurally unreachable | `App.tsx` buffered-message replay loop (~L1663) | A (safe removal) | Removed |
| A2 | Duplicate object key `setup:` in the `screens` map, identical JSX value both times | `App.tsx` `AppInner.screens` (~L947) | A | Removed (kept one) |
| A3 | Expire-mode → `expireAt` ternary chain (`'read'/'1h'/'24h'/'7d'` → timestamp) duplicated verbatim 3× in `ChatScreen` (buffered receive, live receive, own send) | `App.tsx` `ChatScreen` | B (merge) | Extracted `expireModeToExpireAt()` module-level helper, 3 call sites now one line each |
| A4 | `AsyncStorage.multiGet([storageKey, 'timer_'+chat?.id])` where the second value (`timer`) was destructured but never read | `App.tsx` `ChatScreen` (~L1971) | A | Simplified to a single `getItem(storageKey)` — removes one unnecessary storage read per chat-open |
| A5 | Systemic pattern: a module already statically imported at file top, then re-imported via `await import(...)` at the call site anyway (12 sites: `RNFS` ×6, `RELAY_URL` ×3, `EncryptedStorage`-as-`ES` ×1, `decryptMsg`-as-`dm` ×1, plus one renamed to `RNFSLocal` apparently only to dodge the eslint no-shadow warning instead of removing the redundant import) | `App.tsx` (multiple), `WebRTCManager.js` `_startCoverTraffic()` (re-resolves `MessageCrypto` on **every** 3s cover-traffic tick), `ImageCrypto.js` `sendEncryptedImageOffline()` (re-resolves `MessageCrypto` on **every chunk** in the send loop) | B (merge onto existing static import) | All 12+ sites now use the existing static import; zero behavior change, removes real repeated module-resolution work from a hot 8s poll loop, a 3s interval, and a per-chunk send loop |
| A6 | Unused imports: `Platform`, `Vibration`, `relayStatus`, `getSignalOffer`, `getSignalAnswer`, `kyberEncapsulate`, `ENCRYPTION_STATUS`, `Player` (static form), `RNRestart`, `NetInfo` — all confirmed zero references anywhere else in the file/repo | `App.tsx` top-of-file imports | A | Removed. `RNRestart`'s own npm dependency is now also unused repo-wide but `package.json`/lockfile intentionally left untouched (separate, lower-value decision with its own risk) |
| A7 | Dead locals: `EXPIRE_RECONNECT` (App.tsx's own copy — `relay.js` has its own real, used constant of the same name/value; the App.tsx one was never referenced), `MSGS` (placeholder/mock chat array from early development), `setupMode`/`setSetup` (whole unused `useState` pair in `LockScreen`), `webrtc` ref (unused, in `ChatScreen`), `recordingRef` (unused duplicate of the actually-used `recorderRef`), `bgColor` (computed, unused — `bgLabel` is what's actually rendered), `answerKey` (superseded by `dynamicAnswerKey` parsed from the offer payload itself), `avatarUri` (computed data-URI string, never consumed — `pendingAvatars` stores `{base64, mimeType}` separately) | `App.tsx`, various | A | All removed, confirmed via eslint's scope-aware unused-var analysis plus manual grep verification per symbol |
| A8 | Unused variable capture: `const res = await fetch(...)` in `sendReconnectOffer`, `res` never read (function always returns `true`/`false` regardless of HTTP status — pre-existing behavior, not changed) | `RelayClient.js` | A | Dropped the unused capture |
| A9 | `isEmulator` computed via `NativeModules.PlatformConstants` but never read — the very next comment already says "no emulator special-casing here anymore" (logic it used to gate was already removed) | `WebRTCManager.js` (~L95) | A | Removed; the now-fully-unused `import { Platform, NativeModules } from 'react-native'` in the same file removed too |
| B1 | `AsyncStorage.getItem('contacts').then(saved => {...transform one contact...; setItem...})` shape repeated ~14× across `App.tsx` (profile name/avatar updates, renames, deletes, secret-chat bookkeeping) | `App.tsx`, `AppInner` + `ChatScreen` | E (investigated, not merged) | See rationale below |
| B2 | `ImageCrypto.js`/`AudioCrypto.js` chunk-validation (`Number.isInteger(total)`, bounds checks, `MAX_CHUNKS`) duplicated 3× total across `ImageCrypto.js`, `AudioCrypto.js`, `RTCStore.js` (avatar-chunk path) | native crypto/store files | D (intentional) | Left alone — each site's own comment explicitly documents this as a deliberate, independently-reviewed duplication (Fuzzing-Kampagne Fund 7a/7b), not accidental |
| B3 | `RTCStore.js`/`CallManager.js` use `await import(...)` exclusively (no matching static import exists to be redundant against) for `EncryptedStorage`, `RNFS`, `ImageCrypto`, `AudioCrypto` | `RTCStore.js`, `CallManager.js` | D (intentional, lower confidence) | Left alone — no circular-import blocker found, but converting would mean *adding* new static imports to two heavily-reviewed core files rather than removing an existing redundant one; different, larger-footprint change than A5, out of scope for a surgical pass |
| B4 | Live message listener (`RTCStore.setMessageListener`) vs. buffered-message replay loop in `ChatScreen` implement the same message-type handling (secret_start/end, avatar, name, receipts) twice, in parallel, with slightly different code shapes | `App.tsx` `ChatScreen` | D (intentional-by-necessity) | Left alone — genuinely different code paths (array of already-received messages replayed once on mount vs. a live per-event callback), not a copy-paste accident; unifying them would be a real behavioral refactor, not a "smallest sensible simplification" |
| B5 | Native `App.tsx` vs. `web/src/App.tsx` (and their respective `WebRTCManager`/`RTCStore`/`CallManager`/`MessageCrypto` pairs) | repo root vs. `web/src/` | D (intentional, explicitly out of scope) | Not touched — separate runtimes per the task's own framing |
| C1 | `relay.js` scanned for duplicated route/validation logic (offer/answer reconnect handlers, catch/`res.end` boilerplate) | `relay.js` | D / no finding | Nothing rose above ordinary short HTTP-handler boilerplate; no structural duplication found worth extracting. Left untouched given the file's extensive prior security-review history |
| C2 | `web/src/App.tsx` message-listener vs. buffered-replay code | `web/src/*.ts(x)` | D / no finding | Already factored through a shared `appendIncoming()` helper — no redundancy present to begin with |

## Why B1 (contacts-update pattern) was left alone

Six-plus call sites share the shape "read `contacts` from storage, transform
the one matching contact by id, write back, notify." They are **not**
identical: some guard on `contact.nameEdited` before applying an incoming
name, some don't; the live listener handles `profile_avatar_received` and
`profile_name` but has **no** `profile_avatar_removed` case at all (the
buffered-replay path does) — an asymmetry that looks more like a possible
gap than a redundancy, and is not this pass's call to fix (would need
product/security judgment on whether avatar-removal while a chat is open is
supposed to be a no-op or a bug). Introducing a shared helper across two
different closures (`AppInner` top-level effects vs. `ChatScreen`) risked
exactly the anti-pattern the task warned against — swapping one form of
complexity for another (a generic transform-callback abstraction) for
inconsistent call sites. Flagged as category E for a future, dedicated pass
that also resolves the avatar-removal asymmetry, rather than merged now.

## Verification

- `npx jest` (full suite): **272 passed, 1 failed, 273 total.** The one
  failure is the pre-documented flake, `relay.js - Body-Groessenlimit ›
  ein sehr grosser /packet-Body ... wird mit 413 abgelehnt` (`ECONNRESET`
  under parallel test-suite load). Re-ran in isolation
  (`npx jest __tests__/security/relay.http.test.js -t "Body-Groessenlimit"`):
  passes (2 passed, rest skipped by the `-t` filter). No other failures.
- `cd web && npx tsc --noEmit`: clean, zero errors. (`web/src` was not
  modified — its own `tsconfig.app.json` already enables `noUnusedLocals`/
  `noUnusedParameters`, which structurally prevents most of the dead-code
  classes found in native `App.tsx`; this is itself worth noting as a
  cross-platform inconsistency in tooling rigor, not something this pass
  changed.)
- Re-read every changed region after editing to confirm each simplification
  actually reduced code (net **58 insertions / 86 deletions** across 5
  files) rather than relocating complexity or introducing a new abstraction
  to replace an old one. The only new abstraction introduced is the single
  `expireModeToExpireAt()` pure function (A3), which has exactly one
  reasonable shape and three real call sites already.

## Files changed

`App.tsx`, `AudioCrypto.js`, `ImageCrypto.js`, `RelayClient.js`,
`WebRTCManager.js`. `relay.js`, `RTCStore.js`, `CallManager.js`,
`MessageCrypto.js`, `HybridCrypto.js`, and everything under `web/src/` were
reviewed and intentionally left unmodified (see D-category rows above).

No git commit was made — changes are staged in the working tree for review.
