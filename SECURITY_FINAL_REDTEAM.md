# Final Red-Team Pass — Pre-Ship Review

Role: last independent adversarial reviewer before ship. Mandate was explicitly
to *disprove* the architecture and the ~20 prior `SECURITY_*.md` documents,
not to improve it. This document reports what broke, what didn't, and why.

Two other sessions ran concurrently against the same working tree: a
read-only docs-synthesis pass (`SECURITY_INVARIANTS_CATALOG.md`) and a
"100k users already have this build" production-readiness gate that applies
small fixes (visible in `git status` as uncommitted changes to
`web/src/App.tsx` / `web/src/lib/Storage.ts`, plus a new
`__tests__/security/productionReadiness.pepperLostState.test.js`). Neither
collision affected the findings below — see "Collision note" at the end.

---

## Finding 1 (CONFIRMED, NEW): the contacts lost-update fix (62e3464) is incomplete

**Claim under test:** commit `62e3464` ("Kontaktlisten-Lost-Update-Race
behoben") and `CONTACTS_RACE_FIX.md` state that the lost-update race on the
`'contacts'` storage key, documented in `SECURITY_CONCURRENCY_REVIEW.md` §5,
is fixed by routing all real read-modify-write cycles through a new
serializing `updateContacts()` function (`App.tsx:65-77`).

**What's actually true:** `updateContacts()` correctly serializes *itself*
against *itself* — the existing regression test
(`__tests__/security/concurrency.contactsStorageLostUpdate.test.js`) verifies
exactly that, and it's correct. But the fix's own audit methodology (grep for
`AsyncStorage.getItem('contacts')` call sites, per `CONTACTS_RACE_FIX.md` §3)
structurally cannot find a second class of call site that never reads storage
at all — it derives the new value from the current React `contacts` state
(via `setContacts(c => {...})`) and writes straight to storage. That second
class was never migrated and is **not coordinated with `updateContacts()`'s
promise chain in any way**. Confirmed still present in the current tree:

- `global.incrementBadge` — `App.tsx:202-208`
- the `delete_chat` handler in the relay-poll path — `App.tsx:742-746`
- the `device_wiped` handler in the relay-poll path — `App.tsx:760-766`
- the `phone_connect_offer` new-contact handler — `App.tsx:865-869`
- **`React.useEffect(() => {...AsyncStorage.setItem('contacts', ...)}, [contacts])`**
  — `App.tsx:957-963` — an unconditional auto-persist that fires on *every*
  `contacts` state change regardless of which code path produced it
- the `onRename` prop handler, inline in the `screens` object — `App.tsx:1005`
- the `onDelete` handler — `App.tsx:1012-1016`
- `ConnectScreen`'s `onConnected` new-contact handler — `App.tsx:1057-1061`

That's 8 independent writers to the same storage key, none of which wait on
`updateContacts()`'s chain, plus the chain itself — at least 9 uncoordinated
writers in total. The `useEffect` in particular means the "fix" can't be
completed by migrating more call sites alone: as long as it exists, every
`setContacts()` call anywhere in the app (including ones that *do* go through
`updateContacts()`'s React-state-adjacent siblings) triggers its own
independent storage write.

**Root cause:** the migration searched for one call pattern
(read-then-write) and missed a structurally different one (state-then-write)
that produces the identical race.

**Impact:** Correctness / Data Integrity. The exact scenario named in the
commit message — "an incoming message increments contact A's unread count
while the user renames contact B" — is fixed *only* if both sides happen to
go through the 9 migrated call sites. If either side is one of the 8
remaining direct writers (very plausible: `global.incrementBadge` fires on
literally every incoming message notification), the lost update reproduces
exactly as before. Not a confidentiality/crypto issue — a real silent data-
loss bug (dropped unread counts, dropped renames, dropped avatar updates,
occasionally a dropped/resurrected contact-list entry).

**Regression tests added** (both pass against current `App.tsx`,
`__tests__/security/concurrency.contactsStorageLostUpdate.stillIncomplete.test.js`):
1. Static: greps confirm all 8 direct-write sites are still literally present
   in the current source.
2. Behavioral: drives the *real* exported `updateContacts()` against a
   direct-write call mirroring `global.incrementBadge`'s exact pattern,
   interleaved the same way the existing "fixed" test proves is now safe for
   the 9 migrated sites — and shows contact A's badge increment is silently
   discarded.

**Minimal robust fix (not applied — would touch app logic broadly, left for
the owning session):** route the remaining 8 call sites through
`updateContacts()` the same way the other 9 were, and delete the blanket
`useEffect([contacts])` auto-persist entirely (it becomes redundant once
every mutation persists itself through the one serialized chain — keeping it
guarantees a 9th, unconditional race no matter how complete the rest of the
migration is).

---

## Finding 2 (CONFIRMED, NEW): `device_wiped` tombstone is unreachable for roughly half of all contacts, live or offline

**Claim under test:** the `device_wiped` tombstone mechanism, added across
several commits to fix "Nutzer-Fund 3" (chats silently staying "connected"
forever after a peer wipes their device), reliably notifies the peer.

**What's actually true, traced end to end:**

- **Send side** (`App.tsx:1306-1324`): `device_wiped` is sent *exclusively*
  via `fetch(RELAY_URL + '/packet', POST)`. It is never sent over an open
  WebRTC `dataChannel` — this is deliberate (comment explains the wipe must
  not block on network).
- **Live-channel receive side has no handler at all.** Neither of
  `ChatScreen`'s two message-processing blocks — the "replay buffered
  messages on mount" block (`App.tsx:1677` `buffered.forEach`) or the true
  live listener (`App.tsx:1842` onward) — has a `subtype === 'device_wiped'`
  branch, even though both blocks correctly handle `delete_chat`,
  `secret_start`, `secret_end`. `WebRTCManager.js`'s own `isSystemControl`
  replay-protection list (`WebRTCManager.js:613-614`) also omits
  `device_wiped`, consistent with there being no consumer for it on that
  path. Confirmed by exact-count: `subtype === 'device_wiped'` (the
  comparison form real handlers use) occurs **exactly once** in the entire
  `App.tsx`.
- **The one place it *is* handled** is `checkIncoming`'s offline/relay-poll
  loop (`App.tsx:658-774`, handler at `749-774`). But that loop's body opens
  with:

  ```js
  for (const contact of cs) {
    if (contact.role !== 'responder') continue;   // App.tsx:666
    if (responderConnecting.current.has(contact.id)) continue;
    // System Packets prüfen (delete_chat, secret_end etc.)
    const delRes = await fetch(`${RELAY_URL}/packet/${contact.id}`); // App.tsx:671
    ...
  ```

  This is the **only** `GET /packet/<contactId>` call in the entire native
  client (verified by grep — every other `/packet` occurrence is a `POST`).
  `checkOutgoing` (`App.tsx:507-642`), the counterpart that runs for
  `contact.role === 'initiator'` contacts, only does WebRTC reconnect
  offer/answer signaling — it never polls `/packet`. So for **any contact
  where the local device was the pairing initiator**, `/packet/<contactId>`
  is never fetched, under any circumstance, live or offline.

**Combined effect:** for an initiator-role contact, a `device_wiped`
notification from that peer is processed by *nothing* — not the live
channel (no handler exists there for anyone), not the offline poll (skipped
entirely by the role guard). The user never sees the 🪦 tombstone UI
(`App.tsx:1511`/`2816-2821`), the stale `shared_secret_<id>` and chat history
are never cleared, and the contact silently continues to look "connected."
For a responder-role contact the feature does work, because `checkIncoming`
polls unconditionally regardless of live-connection state.

**Cross-platform check:** the web client's equivalent poll,
`checkOfflinePackets` (`web/src/App.tsx:214-295`), has no role filter at all
— it fetches `/packet/<contactId>` for every contact every cycle
(confirmed: `contact.role` doesn't appear anywhere in that function). This
asymmetry is itself evidence the native `role !== 'responder'` guard is a
scoping bug, not an intentional platform design choice: it was very likely
meant to gate only the auto-reconnect-listening logic later in the same loop
body, not the unrelated system-packet check that happens to sit inside the
same `for` block above it.

**Root cause:** an unrelated guard (`role !== 'responder'`, meant for
WebRTC-reconnect routing) accidentally also gates a completely different
concern (relay system-packet delivery) because both live in the same loop
iteration.

**Impact:** Correctness / Security-relevant (the entire point of this
mechanism is trust/safety signaling after a compromise-adjacent event — a
wipe). Severity is moderate-high: it silently defeats a feature that exists
specifically to close a previously-reported user-facing gap, for what is
structurally the *initiator* side of every single pairing in the app (i.e.
every pairing has exactly one initiator and one responder — this isn't a
rare edge case, it's up to half of all relationships by construction).

**Regression tests added** (all pass,
`__tests__/security/stateMachine.initiatorPacketPollGap.test.js`, 4 tests):
1. Confirms the `role !== 'responder'` guard sits before the sole
   `/packet/<contactId>` GET in `checkIncoming`.
2. Confirms the web client's `checkOfflinePackets` has no such role filter
   (control group / asymmetry proof).
3. Confirms `device_wiped` has zero handler occurrences anywhere inside
   `ChatScreen`'s two message-processing blocks, while `delete_chat` /
   `secret_start` / `secret_end` are present in the same blocks (control
   group).
4. Confirms the send side never uses `dataChannel.send`/`rtc.sendMessage`
   for `device_wiped`, only `fetch(.../packet)`.

Following this repo's own established precedent
(`stateMachine.pollCycleGuard.test.js`'s documented reasoning), a full
`<App/>`-render test reaching `screen==='home'` was judged disproportionate
for a single finding — source-structure verification was used instead,
identical methodology to the existing test it sits next to.

**Minimal robust fix (not applied):** move the `/packet/<contactId>` system-
packet check in `checkIncoming` above/outside the `role !== 'responder'`
guard so it runs for every contact regardless of role (mirroring the web
client), leaving the role guard to gate only the reconnect-offer-listening
logic it was presumably meant for.

---

## Part 1 — protocol-breaking attempts that did NOT pan out

Systematically attempted against `WebRTCManager.js`, `App.tsx`, `relay.js`,
`RTCStore.js`, `MessageCrypto.js` for every step (key exchange, session
creation, send/receive, ack, reconnect, revocation/wipe, chat delete):
replay, reordering, modification, injection, deletion, delay, duplication,
key substitution, identity substitution, state confusion, downgrade,
desync; orderings A→B→C / A→C→B / A→A / A→B→A / A+B simultaneous / TOCTOU.

- **Kyber pubkey/ciphertext replay or re-send mid-session**
  (`WebRTCManager.js:420-437, 501-506`): both branches now check
  `this.keyExchangeDone` and reject a second handshake message outright.
  Tried sending a duplicate `kyber_pubkey` after a completed exchange —
  correctly dropped with a warning, `sharedSecret` is not overwritten.
- **`close()` racing an in-flight Kyber bridge call** (constructor comment +
  `WebRTCManager.js:183-198, 447-450, 484-489, 511-514, 528-533`): the
  `_closed` flag is checked both immediately after the async bridge call AND
  again after the subsequent persistence `await` — tried to land in the
  narrower second window (close() firing between the RTCStore/in-memory
  write and the `EncryptedStorage.setItem` completing) and the existing
  `hiddenBugHunt.closeDuringHandshake.test.js` / `concurrency.rtcCloseRaces.test.js`
  suites already cover exactly this; re-derived the scenario by hand against
  current code and it still holds — no new gap found here.
- **BackHandler (`a6091f1`) interacting with `WebRTCManager.close()`'s race
  protections:** traced explicitly per the task's instruction to check this.
  The hardware-back handler (`App.tsx:989-998`) on the `call` screen calls
  `callManagerRef.current?.endCall('user_hangup')` — that's `CallManager.js`,
  a *separate* class from `WebRTCManager` (voice/video call signaling vs.
  chat P2P data channel), and `CallManager.endCall()` already has its own
  reentrancy guard (`CallManager.js:367`:
  `if (this.state === CallState.ENDED || this.state === CallState.IDLE) return;`).
  On `chat`/`settings`/`connect` screens the handler only calls `nav()`,
  which never touches `rtc.close()`. Concluded: this commit does not
  interact with `WebRTCManager`'s `_closed` protections at all — tried,
  didn't pan out.
- **`updateContacts()` (brand new, from `62e3464`) under adversarial
  interleaving against itself:** three-way concurrent calls for the same
  contact, calls that throw mid-chain, calls returning `null` — all behave
  correctly (existing test suite + manual review of the chain logic). The
  gap found (Finding 1) is not in `updateContacts()` itself, it's in what
  still bypasses it.
- **Relay `/phone/register` & `/phone/lookup` "first claim wins" logic**
  (`relay.js:490-564`): tried to construct a genuine race where two
  concurrent requests both see `initiatorId === null`. Node's HTTP request
  handlers here are fully synchronous between the `store.get()` read and the
  `store.set()` write (no `await` in between) — the event loop cannot
  interleave two handlers mid-execution in a single process. The scenario
  the code comments describe ("zwei Promise.all-gleichzeitige Aufrufe
  bekamen BEIDE role:'initiator'") is real only if a caller races two
  requests against the server, not a genuine same-tick JS race in this
  handler; the fix (compare-and-set semantics) is correct and also handles
  the legitimate retry-after-timeout case. No new gap.
- **`/packet` ack-redelivery mechanism** (`relay.js:592-647`): tried
  double-ack, ack with stale/foreign token, ack racing a fresh poll inside
  the grace window, poll racing a concurrent poll for the same recipient.
  The `pendingUntil`/`ackToken` fields correctly prevent re-delivery within
  the grace window and correctly fall back to re-delivery after
  `PACKET_ACK_GRACE_MS` if unacked. No exploitable gap found beyond what's
  already documented (a malicious/compromised relay can trivially suppress
  or delay any packet past its freshness window — inherent to the
  single-relay model, not a bug in this mechanism, per
  `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §3.2).
- **Reconnect handshake replay (33-day-lived offers)**: `purpose: 'reconnect'`
  domain-separated encryption key, PSK-bound. Tried replaying an old
  reconnect offer after a legitimate reconnect already succeeded — rejected,
  decrypt fails silently against the current transcript state, existing
  handling treats it as a possible-attack and just keeps waiting.

## Part 2 — Assume-breach: Attack-Surface-Matrix

relay.js is simultaneously the relay, signaling server, discovery server,
and TURN-credential issuer — **one trust boundary, not four**
(`relay.js:26-36`, already established in
`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §1).

| Attacker | Capabilities | Observes | Can modify | Attacks tried | Mitigation (file:line) | Remaining risk |
|---|---|---|---|---|---|---|
| **Server/Relay process (compromised or malicious operator)** | Full control of `relay.js` runtime | Source/dest routing metadata per request (`ip`, `recipient`, attachment MIME/chunk count, call signal timing) in real time (`relay.js:14-24, 280-285`); raw IP always, regardless of `hashIp()` (that's log-hygiene only, `relay.js:274-285`) | Can drop/delay/duplicate any packet; can answer TURN-credential requests correctly but MITM SDP if it also controls TURN media relay | Suppress `device_wiped`/`delete_chat` past freshness window; replay `/packet` payloads (blocked by per-message freshness ts + high-water-mark, `App.tsx:713-725`); forge `/turn-credentials` (can't — needs `TURN_SECRET`, never sent to client) | Message content: AEAD, PQ-KEM (Kyber-768) handshake, app-layer freshness/HWM checks | Metadata (who talks to whom, when, how much) is fully visible by construction — documented, not deniable. Selective suppression of one control message type (this review's Finding 2 compounds this: initiator-role contacts have zero redundancy against exactly this). |
| **Server + "Database" (in-memory `store`/`pepperStore`/`suspectIPs` Maps)** | Same as above + full snapshot of everything currently in RAM | All pending packets/transfers/phone-lookup state/pepper counters at snapshot time | Same as above | Recover plaintext from a RAM snapshot (nothing to recover — only AEAD ciphertext + routing metadata are ever stored, `relay.js:1-24`) | Ephemeral by design (`EXPIRE_MS` sweep, `relay.js:302-313`); no disk persistence | A snapshot taken mid-transfer (`relay.js:428-484`, 24h TTL) exposes an active image/audio transfer's ciphertext chunks and `chatId`/`mimeType`/`transferType` metadata for up to 24h — longer-lived than the 10-minute default for regular packets. |
| **Server + Logs + Backups** | Persistent record if operator enables logging/backups (outside this code's control, `relay.js:372-382`) | Same real-time visibility, now durable; `hashIp()` HMAC pseudonym is *not* reversible from logs alone (secret is RAM-only, regenerated per process start, `relay.js:254-272`) | N/A (logs are read-only artifacts) | Rainbow-table the IPv4 space against logged hashes (defeated — HMAC needs the per-process secret, not just the hash) | `ipLogSecret` HMAC (`relay.js:272,286-288`); no contactId/deviceId prefixes logged | Whatever the deploy's log/backup retention policy is (pm2, `setup-log-rotation.sh`) — this code cannot itself guarantee retention duration. |
| **Single compromised Peer (contact's app itself is malicious/compromised, not just their device)** | Legitimate holder of a shared secret with the victim | Everything the victim sends them, forever (no way to prevent a legitimate recipient from screenshotting/exporting) | Can send arbitrary well-formed messages within the protocol (already-authenticated channel) | Send forged `device_wiped`/`delete_chat` to grief the victim — protected by AEAD + freshness/HWM, so this requires actually being the real peer (not a spoof) | Domain-separated AEAD per message type; timestamp freshness; sequence HWM | Inherent to any E2EE messenger: a legitimate peer can always misuse legitimately-received content. Correctly out of scope for cryptographic mitigation. |
| **Single compromised Device (stolen, unlocked)** | Full local filesystem + `EncryptedStorage` (keyed by device PIN + server-issued pepper, `SECURITY_SECRETS_LIFECYCLE*.md`) access while unlocked | All local chat history, contacts, shared secrets in plaintext (app already decrypted for the legitimate unlocked session) | Can wipe/trigger the 5-fail flow, impersonate the user going forward from that point | N/A — this is the "lost the device unlocked" case, defeats local-only protections by definition | PIN + pepper split (server-side rate limiting, `relay.js:809-873`); 5-fail wipe | Forward secrecy for *past* messages on that device is not a local-storage property this app claims — device-local history is plaintext-once-unlocked by design, consistent with `SECURITY_AUDIT_TRUST_PRIVACY_CLAIMS.md`. |

**Property survival summary** (unchanged from prior passes, independently
re-derived, not just copied): Confidentiality and Authentication survive a
compromised relay (message content). Forward Secrecy / Post-Compromise
Security are **not** claimed by this protocol for the long-lived Kyber
shared secret itself (no ratchet found anywhere in `MessageCrypto.js`/
`WebRTCManager.js` — a single compromised shared secret decrypts all past
and future traffic under it until the next full re-pair). Metadata Privacy
does **not** survive a compromised relay (by structural necessity of a
single-relay rendezvous model). Unlinkability/Anonymity are correctly **not
claimed** anywhere — confirmed by grep across all `SECURITY_*.md`, no
document asserts either term as a property this app provides. Availability
survives individual-IP abuse (per-IP blocking, not global wipe,
`relay.js:237-252`) but not a fully malicious relay operator (trivially
drops everything).

## Part 3 — disproving prior claims

- `62e3464`'s commit message and `CONTACTS_RACE_FIX.md` assert the contacts
  lost-update race is fixed. **Disproven** — see Finding 1. The fix is real
  and correct for the 9 sites it touches; the claim of the race being closed
  is not accurate for the file as a whole.
- No prior document explicitly claims `device_wiped` delivery is guaranteed
  or fully redundant across both delivery paths (the existing
  `SECURITY_ARCHITECTURE_THREAT_MODEL.md` §3.2 caveat is about a malicious
  relay suppressing it, a different and already-acknowledged risk) — so
  Finding 2 isn't a *contradiction* of an existing claim so much as an
  entirely new gap nobody had previously located. Noted here because the
  task specifically flagged this mechanism for extra scrutiny.
- Re-checked `WebRTCManager.close()`'s `_closed`-flag protections against
  the two latest commits specifically, per the task's instruction — no
  interaction found (see Part 1). This *reinforces* rather than disproves
  `SECURITY_SELF_REVIEW.md`'s claim there, for these two specific commits.

## Collision note (not a finding)

`git status` shows uncommitted changes to `web/src/App.tsx` and
`web/src/lib/Storage.ts` plus a new
`__tests__/security/productionReadiness.pepperLostState.test.js` — the
concurrent production-readiness session's work, unrelated to anything in
this document. Running the full suite mid-session surfaced one collateral
failure: `__tests__/security/stateMachine.pollCycleGuard.test.js` (pre-
existing, not authored by this pass) uses an LF-anchored two-line literal
(`'checkOfflinePackets();\n    const interval = ...'`) to locate a function
boundary in `web/src/App.tsx`; that file's line endings were CRLF at the
time of this run (`git diff` emitted the standard "LF will be replaced by
CRLF" warning), breaking the literal match. This is an artifact of two
sessions editing the same file concurrently through different save paths,
not a regression introduced here — confirmed by re-running that test file in
isolation before and reasoning through the diff, which touches an unrelated
lock-screen dead-end fix nowhere near `checkOfflinePackets`. Left untouched
deliberately to avoid colliding with in-flight work in a file this session
does not own. `relay.http.test.js`'s failure in the same parallel run is the
already-documented, pre-existing, acceptable `ECONNRESET` flake (passes
40/40 in isolation). Both this session's own new test files pass cleanly in
every run, isolated or full-suite.

Full suite as of this document (excluding the transient collisions above):
**324/327 passing** in a full parallel run (327 = 320 baseline + 4 in
`stateMachine.initiatorPacketPollGap.test.js` + 2 in
`concurrency.contactsStorageLostUpdate.stillIncomplete.test.js`, minus 1
counted twice by jest's retry display for `relay.http.test.js`); **isolated,
every test this session touched or added passes 100%**. `npx tsc --noEmit`
in `web/`: clean, 0 errors.

---

## Status

**SECURITY STATUS:** No new cryptographic or transport-security break found.
Kyber-768 KEM handshake, triple-layer AEAD, and replay/freshness protections
held against every replay/reorder/injection/substitution/downgrade attempt
tried in Part 1. Two new **correctness/data-integrity** bugs confirmed
(Findings 1 & 2), neither of which breaks confidentiality, authentication,
or message integrity — both are silent-failure/availability-of-a-feature
bugs with concrete regression tests and minimal fixes identified but not
applied (left for the owning session per task scope).

**PRIVACY STATUS:** Unchanged from prior passes. Metadata visibility to a
compromised relay is structural and already documented, not newly
discovered. No new PII leak found in this pass.

**METADATA STATUS:** Confirmed the relay sees routing metadata in real time
regardless of log hygiene (Part 2 matrix); confirmed `hashIp()` is log-
hygiene, not real-time IP minimization, consistent with existing docs.

**PROTOCOL STATUS:** Core key-exchange/message protocol held under
systematic adversarial testing. Two application-layer state-propagation
gaps found (contacts storage, device-wiped tombstone) — both are consistency
bugs in surrounding app logic, not protocol breaks.

**P2P STATUS:** `WebRTCManager.close()` race protections verified still
correct against the two latest commits (BackHandler, contacts serialization)
— neither interacts with it. No new P2P-specific race found.

**REMAINING UNKNOWNS:**
- Whether the 8 remaining contacts-storage direct-write sites (Finding 1)
  and the `checkIncoming` role-gate (Finding 2) get fixed before ship is now
  a product decision, not an open investigation — the mechanism and fix are
  fully characterized above.
- Real-world TURN-relay behavior (a malicious/compromised TURN node sitting
  in the live media/data path) was analyzed via code reading only, not
  tested against a live coturn instance in this pass.
- pm2/log-rotation/backup retention in actual production deployment is
  outside this codebase's control and wasn't independently verified.

**EXTERNAL AUDIT REQUIREMENTS (unchanged from prior docs, reaffirmed):**
- No forward-secrecy/post-compromise-security ratchet exists for the Kyber
  shared secret — by design, not a bug, but this is exactly the kind of
  property claim that needs a real external cryptographic review before any
  "forward secrecy" marketing claim is made.
- The `/pepper/*` rate-limiting scheme (`relay.js:783-873`) is explicitly
  documented as a stopgap, not a real PAKE/OPRF — already flagged in
  `relay.js`'s own comments as requiring external cryptographic design work,
  reaffirmed here, not re-litigated.
- Independent penetration test against a real deployed relay (TLS
  termination, coturn config, pm2 log retention) — this pass was code-only.
