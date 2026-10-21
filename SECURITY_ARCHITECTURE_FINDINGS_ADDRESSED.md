# Architecture Threat Model — Findings Addressed This Pass

Tracks which findings from `SECURITY_ARCHITECTURE_THREAT_MODEL.md` were fixed
directly (comment/documentation/wording only, no structural or cryptographic
change) versus queued for later. Full backlog for Part 5's alternative-
architecture rows is in `SECURITY_ARCHITECTURE_BACKLOG.md`.

## Fixed directly in this pass

### §1 — Trust-boundary honesty (relay = signaling = discovery = TURN issuer)

`relay.js`'s header comment now states explicitly, in its own section, that
this single Node process wears all four roles simultaneously and that
compromising it compromises all four at once — citing
`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §1.7/§1.13's "one process, four hats"
finding directly, so a future reader of the code alone (not just the audit
docs) gets the same precise framing.

- `relay.js` header comment (top of file): added a "EIN PROZESS, VIER ROLLEN"
  section.

No structural change was made or considered — per the task's own framing,
splitting these roles into separate trust domains is a large redesign, not
requested and correctly out of scope.

### §2 — "Zero-Knowledge" terminology conflation

Every place the codebase used the blanket term "Zero-Knowledge" for a
property that is actually "this specific value is hashed/minimized, not a
formal ZKP or blanket confidentiality guarantee" was reworded to name the
specific property:

- `App.tsx` phone-connect screen caveat string (~line 3414): was
  "🔒 Zero-Knowledge: ...", now leads with "Datensparsam, nicht
  'Zero-Knowledge'" and keeps/extends the existing Claim-6 caveat that the
  hash is a rendezvous key, not a secret, against anyone who already knows
  both phone numbers.
- `relay.js`'s `/phone/register` section-header dev comment: was
  "PHONE LOOKUP (Zero-Knowledge)", now names the actual property (hash
  rendezvous, not formal zero-knowledge) with a pointer to the threat
  model's §2.3 concept table.

`web/src/App.tsx` was checked and does not contain an equivalent
phone-connect string (the phone-hash rendezvous UI is native-only), so no
change was needed there for this finding.

### §3 — `device_wiped` suppression is an inherent, accepted limitation

Added a clearly-labeled comment at both the send site and the receive site
stating plainly that a malicious/compromised relay can suppress this
notification (drop it, or delay it past the 15-minute freshness window), that
this is inherent to the single-relay delivery model (the same relay could
suppress *any* message), and that this is a documented, accepted trade-off —
not an oversight — with a pointer to
`SECURITY_ARCHITECTURE_THREAT_MODEL.md` §3.2 for the full analysis. No
mitigation was attempted (an out-of-band/second-channel fix would itself be
new protocol design, out of scope per the hard constraint on this pass).

- `App.tsx` (send site, 5-fail wipe path, near the existing "Threat-Model-
  Abwaegung" comment): added "BEKANNTE, AKZEPTIERTE EINSCHRAENKUNG" block.
- `web/src/App.tsx` (receive handler for `subtype === 'device_wiped'`):
  added the matching receive-side note.

### §4 — `hashIp()` framing refined: log-hygiene, not real-time IP-minimization

Tightened the existing (already-once-reworded) comments to make the precise
distinction from the threat model's §4.3 explicit: `hashIp()` prevents a
*later* reader of log files (without the live process's in-memory secret)
from reversing raw IPs at scale, but does **not** reduce what the *live*
relay process itself observes in real time — it holds the raw IP and the
HMAC key simultaneously, at the same instant, in the same process.

- `relay.js`, `hashIp()` definition: added a precise "LOG-HYGIENE, keine
  IP-MINIMIERUNG" comment directly above the function.
- `relay.js`, header comment: added a forward-reference to this distinction.
- `relay.js`, `/status` endpoint's `logs` field: reworded the field value
  itself (`'nur Betriebsereignisse, keine IP-/Kontakt-Metadaten'` →
  `'nur Betriebsereignisse in Logdateien, keine IP-/Kontakt-Metadaten im
  Klartext'`) plus a comment clarifying the field describes what lands in
  log *files*, not what the live process sees. Confirmed no test asserts on
  the old string (`__tests__/` grep for the field found no matches).

## Deferred to the backlog (`SECURITY_ARCHITECTURE_BACKLOG.md`)

Part 5's full 12-row comparison table was turned into backlog entries. Five
rows (Identity, Peer discovery/PAKE, Session establishment/X3DH-analog, Group
messaging/MLS-style, Key recovery) are scoped as "needs independent
cryptography review" only — no implementation, per the hard constraint
governing this entire pass. Seven rows have non-cryptographic
engineering/config improvements available; none were implemented in this
pass (each spans files/scope beyond a documentation-only change, or several
touch files mid-flight in this session's own git status), but each has a
concretely scoped follow-up in the backlog document, with a priority
(P0–P3) and explicit rationale for why it wasn't done inline here.

## Verification

- `npx jest` — run after all edits (see final report for result).
- `cd web && npx tsc --noEmit` — run after all edits (see final report for
  result).
- Confirmed no test in `__tests__/` asserts on the exact string values
  changed in `relay.js`'s `/status` `logs` field or `App.tsx`'s phone-connect
  caveat text before editing them.
