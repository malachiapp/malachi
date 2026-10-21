# Contacts Storage Lost-Update Race — Fix

Fixes the confirmed, reproduced lost-update race documented in
`SECURITY_CONCURRENCY_REVIEW.md` §5 and independently found as
`SIMPLIFICATION_PASS.md` finding B1: ~18 independent
`AsyncStorage.getItem('contacts')` call sites in `App.tsx`, of which 9 are
genuine read-modify-write cycles against the same storage key with no
coordination between them. Both prior passes deliberately left this unfixed
because another session was concurrently editing `App.tsx` at the time —
that is no longer the case, so this pass does the full fix.

## 1. False-positive correction (done first, as requested)

`SECURITY_SECRETS_LIFECYCLE.md` (finding 7) and
`SECURITY_SECRETS_LIFECYCLE_FIXES.md` (Fix 7) both claimed `contacts` is
stored in plain, unencrypted `AsyncStorage`. This is false. `App.tsx:22-40`
defines `AsyncStorage` as a local compatibility shim whose every method
(`getItem`/`setItem`/`removeItem`/`multiGet`/`multiSet`/`multiRemove`)
delegates 1:1 to the real `EncryptedStorage` (from
`react-native-encrypted-storage`). A repo-wide grep for
`@react-native-async-storage/async-storage` turns up zero import sites (only
two pre-existing comments elsewhere already correctly noting the same
distinction). Every `AsyncStorage.getItem('contacts')`/`setItem('contacts',
...)` call in `App.tsx` is, and always was, an `EncryptedStorage` call under
a locally-named alias — contacts were never in plaintext storage.

Correction notes (clearly marked, not rewrites) were inserted:
- `SECURITY_SECRETS_LIFECYCLE.md`, directly under finding 7.
- `SECURITY_SECRETS_LIFECYCLE_FIXES.md`, at the top of the "Fix 7" section.

## 2. `updateContacts()` design

Added directly after the `AsyncStorage` shim definition in `App.tsx`
(module scope, before the component functions, so both `AppInner` and
`ChatScreen` can use it):

```js
let contactsWriteChain = Promise.resolve();
export async function updateContacts(mutator) {
  const run = contactsWriteChain.then(async () => {
    const saved = await AsyncStorage.getItem('contacts');
    const current = saved ? JSON.parse(saved) : [];
    const updated = await mutator(current);
    if (updated != null) await AsyncStorage.setItem('contacts', JSON.stringify(updated));
    return updated;
  });
  contactsWriteChain = run.catch(() => {});
  return run;
}
```

A single module-level promise chain serializes every read+write cycle: each
call waits for the previous one to fully settle (read, mutate, write) before
it starts its own read, so two overlapping updates for different contacts
can no longer both compute from the same stale snapshot. The chain
continues past a rejected call (`.catch(() => {})` on the chain variable,
while the caller's own promise still rejects normally) so one failing
mutator can't permanently wedge every future `'contacts'` access. A mutator
returns `null`/`undefined` to signal "nothing to write" (used at sites that
already have a not-found/no-op guard), which skips the `setItem` entirely.

Exported as a named export alongside `App`'s default export, solely so the
test suite can exercise the real mechanism directly (see §4) instead of only
a reimplemented mirror of it.

## 3. Migrated call sites

Grepped all `AsyncStorage.getItem('contacts')` call sites and read each one
individually. Of the 18 sites cited in `SECURITY_CONCURRENCY_REVIEW.md` §5,
**9 are genuine read-modify-write cycles** (migrated below) and **9 are
pure reads** used only to iterate the contact list for polling/connection
purposes, with no write-back to `'contacts'` anywhere in their block —
these were deliberately left untouched (see §3b).

| Site (current line, in `AppInner`/`ChatScreen`) | What it does | Side effect preserved |
|---|---|---|
| `nav()`, badge reset on chat open | Sets `unread: 0` for the opened contact | Existing `setContacts(c => ...)` React-state update kept as-is (separate call); storage RMW now via `updateContacts(...).catch(() => {})` |
| `ChatScreen` buffered replay, `profile_avatar_received` | Sets `theirAvatar` from a buffered avatar message | `onRename?.(...)` + `console.log` now chained on `updateContacts(...).then(...)` |
| `ChatScreen` buffered replay, `profile_avatar_removed` | Clears `theirAvatar` | `onRename?.(...)` + `console.log` chained the same way |
| `ChatScreen` buffered replay, `profile_name` | Sets `name`/`theirName`, guarded by `!contact.nameEdited` | Guard moved into the mutator (`return null` if not found/edited); `onRename?.(...)` only fires `if (updated)` |
| `ChatScreen` live listener, `handshake` | Sets `name`/`theirName` from the bundled handshake packet, same `nameEdited` guard | Same guard-in-mutator pattern; `onRename?.(...)` only on real update |
| `ChatScreen` live listener, `profile_name` (legacy) | Same as handshake, plus a `console.log` | Guard + `onRename?.(...)` + `console.log`, both gated on `updated` |
| `ChatScreen` live listener, `profile_avatar_received` | Sets `theirAvatar` (no guard) | `onRename?.(...)` + `console.log` chained |
| `ChatScreen` live listener, `hello`/`myId` | Sets `theirMyId` for auto-reconnect (no guard) | `console.log` chained |
| Rename dialog `onPress` handler | Persists `nameEdited: true` + the new name | `onRename({...})` was already called synchronously before the storage write in the original code and stays exactly there (unaffected by the migration) |

Each mutator reproduces the exact original transform (`cs.map(...)` with the
identical predicate/patch) and the exact original guard where one existed.
No field, condition, or downstream callback was changed — only the
read+write mechanism (independent racing calls → serialized queued calls).

### 3b. Pure-read sites, deliberately left unchanged

`217/255, 309/347, 434/472, 474/512, 624/662, 1252/1285, 3568/3570,
3595/3597, 3606/3608` (original/current line numbers) load `'contacts'`
only to iterate the list — incoming-call polling, outgoing/incoming
reconnect polling, initial contacts load into React state, the offline
relay-transfer queue check, the device-wipe notification fan-out, and the
avatar-hash-clear loops. None of them write back to `'contacts'`, so they
carry no lost-update risk on their own. Routing them through
`updateContacts()` would have been either a no-op wrapper or, in the
polling loops' case, would have forced their entire multi-second network
I/O (multiple `fetch()`/`await` calls per contact) to run *inside* the
shared write-chain — serializing an unrelated rename/avatar-update behind a
slow network poll. That would be a genuine behavioral regression, not a
mechanism swap, so these were left as plain reads per the task's own
"don't force this everywhere" guidance.

Also left untouched (out of scope — no `getItem('contacts')` involved,
mentioned here only for completeness): `global.incrementBadge` and the
`AppInner` central `useEffect([contacts])` auto-persist, plus `onDelete`/
`onRename` handlers in the `screens` map that write `'contacts'` straight
from the closure's `contacts` React state rather than a fresh storage read.
These already existed before this pass and were flagged in
`SECURITY_CONCURRENCY_REVIEW.md` §5 as a separate (lower-severity, React-
state-mediated) concern, not part of the 18 sites this task scoped in.

## 4. Test verification

Updated `__tests__/security/concurrency.contactsStorageLostUpdate.test.js`:
- Added a new describe block that imports the **real** `updateContacts`
  from `../../App` (works cleanly — `App.tsx` already renders successfully
  under the RN Jest preset + existing manual mocks, per `__tests__/App.test.tsx`)
  and exercises it directly: concurrent updates to different contacts (the
  exact scenario from the task), concurrent updates to the same contact's
  different fields, a `null`-returning mutator producing no write, and a
  throwing mutator not permanently blocking the chain. All 6 tests pass.
- Kept the original mirrored/unsafe-pattern tests in a second describe
  block, relabeled as "documentation of the original finding" rather than a
  claim about current `App.tsx` behavior — they still demonstrate the bug
  *would* exist without a mutex, for contrast with the fixed tests above.

Results:
- `npx jest __tests__/security/concurrency.contactsStorageLostUpdate.test.js --runInBand` → **6/6 passed**.
- `npx jest` (full suite) → **32/32 suites, 318/318 tests passed.** The
  previously-documented `relay.js - Body-Groessenlimit` flake did not
  reproduce in this run.
- Re-read all 9 migrated call sites afterward against their original code
  to confirm no guard, field, or callback silently changed.

## Files touched

- `App.tsx` — added `updateContacts()` (module scope, named export), migrated 9 call sites.
- `__tests__/security/concurrency.contactsStorageLostUpdate.test.js` — rewritten to test the real function plus retained documentation tests.
- `SECURITY_SECRETS_LIFECYCLE.md` — correction note under finding 7.
- `SECURITY_SECRETS_LIFECYCLE_FIXES.md` — correction note in Fix 7.

No git commit was made; everything is left in the working tree for review.
