# Cartesia α' wire-up — post-YC follow-ups

Filed alongside the wire-up PR per R4-S9 ("file the post-YC GH issues NOW,
not 'later'"). Each entry is the body of a GitHub issue to open after merge.
Linked from `.claude_learnings.md` so dead-code-debt doesn't compound.

---

## Issue 1 — Remove `enableOutputTranscription` flag (R3-S8)

**When:** 14 days after `VOICE_CARTESIA_ENABLED=1` has been stable in prod.

**Body:** GeminiBridge currently takes `enableOutputTranscription:boolean`.
Once we're committed to Pipeline α' on every tier (i.e., Cartesia is the
only voice path), the flag is dead-code-debt. Open a PR that removes the
constructor option, hardcodes `outputAudioTranscription:{}` in `open()`,
and drops the `discardAudioOut` knob to also be always-on. Update the
α'-related tests to drop the off-path branches.

**Acceptance:** `enableOutputTranscription` and `discardAudioOut` no
longer appear in `server/voice-proxy/gemini-bridge.js`. `VOICE_CARTESIA_ENABLED`
env stays as the rollback dial for emergencies; the bridge constructor
no longer reads it.

---

## Issue 2 — Add `creators.voice_id` index when admin-filter ships (R2-M2)

**When:** when an admin dashboard adds a "trained creators" filter or any
query that reads `WHERE voice_id IS NOT NULL`.

**Body:** Today `creators.voice_id` is read by PK lookup only (cheap). If
a future query filters by `voice_id IS NOT NULL`, it seq-scans. Pre-empt
with `CREATE INDEX creators_voice_id_idx ON creators(voice_id) WHERE
voice_id IS NOT NULL` in a tiny migration when that query lands.

---

## Issue 3 — Cartesia voice deletion + retention policy

**When:** post-YC.

**Body:** v1 leaves orphan Cartesia voice ids in two places:
(a) `voice_clone_uploads` rows whose `creators.voice_id` was overwritten
(R3-M6 / R4-M3 enqueues a 60s deferred DELETE, but failures past 10
attempts sit forever); (b) audit-only rows for failed Cartesia clone
calls (`cartesia_voice_id IS NULL`). Define a retention policy: how long
do we keep the audit history vs. how aggressively do we GDPR-erase the
underlying clone bytes (we don't store them — Cartesia does — but the
hash + duration in our table is metadata about user-supplied audio).

**Owner:** Vuk (legal + GDPR posture). Pull in admin_audit + Cartesia
account audit-log review.

---

## Issue 4 — Backpressure metric: ghost-session ratio (R3-S1)

**When:** 2 weeks post-merge.

**Body:** Eager Cartesia open at session-open spends ~200ms of handshake +
WS keepalive on ghost sessions (mic-tap → user closes tab before audio).
Add PostHog event pair `voice.cartesia.opened` and `voice.session.ready`
with `session_id`. After 2 weeks of data, compute the ratio. If
abandonment > 30% of opens, switch to lazy-on-first-`turn_start` open
(adds 200ms TTFA but only on real sessions).

---

## Issue 5 — Voice-delete queue persistence audit (R4-M3)

**When:** post-YC.

**Body:** `voice_delete_queue` table is single-machine (every Fly machine
runs the worker, so concurrent dequeue is possible). v1 accepts the
duplicated DELETE call as benign (Cartesia 200/204/404 all dequeue), but
formally audit:
- multiple Fly machines vs `SELECT ... FOR UPDATE SKIP LOCKED` (Postgres
  advisory locks already exist on the reaper for the same reason);
- crash-recovery semantics — what if a row's DELETE succeeded against
  Cartesia but the post-DELETE dequeue UPDATE failed?
- attempts=10 escape: Sentry alert + manual cleanup checklist.

Expected outcome: tighten the worker with a per-row advisory lock or
move it onto the reaper's existing `pg_try_advisory_lock`.
