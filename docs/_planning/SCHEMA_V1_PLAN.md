# OakLeague v1 Schema Plan

Status: **v7 — audit round 6 (user-timezone fix) applied. Approval-ready; cleared for implementation.**
Author: Claude (planning loop, per CLAUDE.md §Planning)
Date: 2026-04-20

---

## Scope

Ship production-grade Supabase schema for:
- User onboarding (goals, obstacles, tier)
- Invite-only creator pipeline (invitation → application → approval → brain training → published)
- Topic-drawer knowledge base (up to 5 topics per creator, 5 source types per topic)
- Hook feed + welcome hooks (separate)
- Voice sessions with tier-locked routing, per-turn telemetry, COGS tracking, kill-switch
- Admin console backends (service-role only tables)
- Waitlist + email-signup verification flow (ghost-user-safe)

Out of scope for v1: Stripe, vector RAG, brand/sponsored_segment creator_type (enum values exist, gated by CHECK; unused).

---

## Revisions v4 → v5 (external auditor round 4)

**Critical:**
- **R4-C1 — subquery-in-CHECK won't compile.** Postgres rejects subqueries in CHECK constraints (`cannot use subquery in check constraint`). Array-element caps now enforced via `IMMUTABLE` SQL helper functions `public._max_text_array_elem_len(text[])` and `public._all_text_array_elems_within(text[], int)`. CHECK calls the function; Postgres accepts function bodies even when the body contains a set-returning expression like `unnest`. Migration `…0002_touch_updated_at.sql` renamed conceptually and still ships `touch_updated_at`, but the helper functions ship in `…0001_extensions_and_enums.sql` so they are available to `…0005_profiles.sql`.

**Medium:**
- **R4-M1 — cross-midnight kill-switch gap.** `session_turns_enforce_kill_switch` now keys on the session's own starting day, not `current_date`, and upserts the day-N+1 quota row if missing. A turn at 00:03 on day N+1 belonging to a session that started at 23:55 on day N checks day-N+1 quota (or is created with the session's tier snapshot).
- **R4-M2 — misleading trigger comment.** The comment block above the RAISE in `session_turns_enforce_kill_switch` claimed a side-effect UPDATE that doesn't exist. Rewritten: "RAISE with ERRCODE P0001 and HINT; voice service catches the driver error, then issues its own `UPDATE sessions SET status='ending', end_reason='kill_switch'` out-of-band. Nothing in this trigger persists."
- **R4-M3 — handle reuse across profile→creator promotion.** Policy committed: **Option B (promote).** On creator approval, the creator sync trigger atomically (a) reassigns the `handles_registry` row from `('profile', user_id)` to `('creator', creator_id)` and (b) sets `profiles.handle = NULL`. Applicant keeps their chosen handle as their creator handle. Documented in §Edge cases; pgTAP test `handle_promotion_profile_to_creator.test.sql` added.

**Small:**
- **R4-S1 — `kill_switch_fired_at` writer named.** New trigger `daily_quotas_latch_kill_switch` (BEFORE UPDATE on `daily_quotas`, not SECURITY DEFINER) writes the latch when `NEW.seconds_used >= (NEW.daily_limit_s * 3) / 2 AND OLD.kill_switch_fired_at IS NULL`. This is the single writer; the column is no longer functionally dead. Both enforcement triggers now have a durable signal to observe across sessions.
- **R4-S2 — `service_role` can still DELETE `admin_roles`.** Grants migration now includes `service_role` in the admin_roles DELETE revoke. DBAs bypass via the `postgres` role when needed. `BEFORE DELETE ON admin_roles` trigger remains as defense-in-depth; raises regardless of role.
- **R4-S3 — `cogs_log` operation/metadata uncapped.** `CHECK (length(operation) <= 64)` and `CHECK (octet_length(metadata::text) <= 4096)` added to `cogs_log`. A buggy provider adapter can't bloat the table.
- **R4-S4 — `a_`/`b_` prefix ordering brittle.** Merged `a_session_turns_populate_user_id` and `b_session_turns_kill_switch` into a single BEFORE INSERT trigger `session_turns_guard` whose body populates user_id first, then enforces kill-switch. One trigger, one ordering guarantee — next dev can't accidentally add a peer trigger that runs in-between.
- **R4-S5 — publish+errored atomicity.** §Edge cases documents: retraining failure that un-publishes a creator MUST be a single UPDATE setting both `brain_status='errored'` AND `published_at=NULL`. Server action doing two UPDATEs will violate the publication-integrity CHECK on the first one.

**Carried forward from v4 (no change):** C-α through C-ζ, M-α through M-η, S-i through S-iii, S-iv, S-v. All still correct per auditor round 4.

---

## Revisions v6 → v7 (user-timezone correctness)

One silent UX/billing landmine caught on final pass: the product spec says **"Answer Time resets at user-local midnight."** v6 used `started_at::date` and `current_date`, which Postgres evaluates in UTC. A Los Angeles user starting a session at 4:55 PM PST would hit a quota reset at 5 PM PST (UTC midnight). Unacceptable for a paid tier.

Option A (DB-anchored per-user timezone) chosen. Option B (client-passed local date) was rejected: any client can pass yesterday's date to reset the quota — a COGS exploit that violates "never trust the client."

- **R6-C1 — `profiles.timezone` column + validator.** New column `profiles.timezone text NOT NULL DEFAULT 'UTC'` with CHECK against a new STABLE helper `public._is_valid_timezone(text)` that attempts `PERFORM now() AT TIME ZONE $1` in a subtransaction. Onboarding writes `Intl.DateTimeFormat().resolvedOptions().timeZone` from the browser; settings page lets the user override. `UTC` default means if onboarding fails to capture tz, quota math is still deterministic (just wrong for user experience — fix in UI, not by letting the DB silently default to server-tz math).
- **R6-C2 — triggers compute local date from profile tz.** All `::date` casts on `timestamptz` values are now `(<ts> AT TIME ZONE p.timezone)::date`. Affected triggers: `sessions_enforce_tier_and_kill_switch` (computes `quota_date` from `now()`) and `session_turns_guard` (computes `quota_date` from `sessions.started_at`). Both join `profiles` in their SELECT to get tz alongside tier.
- **R6-C3 — `daily_quotas.quota_date` semantics clarified.** Column doc: "user-local calendar date, computed as `(ts AT TIME ZONE profiles.timezone)::date`." Not UTC, not server-local. Every trigger and query that keys on `quota_date` must use the same formula or it will miss rows.
- **R6-M1 — tz change mid-session is bounded by 15-min Gemini cap.** A user who flips their tz during an open session could cross a local-date boundary in the middle. Since sessions are capped at 15 minutes by the voice provider, the worst case is 15 minutes of turns keyed to the "wrong" (new-tz) day. Documented in §Edge cases; not worth a `timezone_at_session` snapshot.
- **R6-M2 — traveling users get new-tz behavior on next session.** Profile-current tz (not session-snapshot) means a user who flies LA → NYC and updates their tz gets a reset aligned to ET going forward. Matches product intent.

---

## Revisions v5 → v6 (external auditor round 5 — final)

Three small hardening items folded in before build. No criticals, no mediums — auditor cleared v5 as shippable; these tighten the invariant surface.

- **R5-S1 — latch trigger also fires on INSERT.** `daily_quotas_latch_kill_switch` changed from `BEFORE UPDATE` to `BEFORE INSERT OR UPDATE`. Body guards the `OLD` reference with `TG_OP`:
  ```sql
  IF (TG_OP = 'INSERT' OR OLD.kill_switch_fired_at IS NULL)
     AND NEW.seconds_used >= (NEW.daily_limit_s * 3) / 2 THEN
    NEW.kill_switch_fired_at := now();
  END IF;
  ```
  Closes the invariant "any row with `seconds_used >= 150%` has `kill_switch_fired_at` set" across backfills, manual inserts, or a future migration that seeds quotas pre-populated.

- **R5-S2 — latch survives tier upgrades (policy written down).** Added to §Edge cases: once `kill_switch_fired_at` is set, a same-day tier upgrade does not unlatch. New sessions still fail until midnight or until an admin explicitly `UPDATE daily_quotas SET kill_switch_fired_at = NULL`. This is intentional — tier upgrade is not a bypass mechanism. Ops runbook reference added so on-call knows how to clear the latch.

- **R5-S3 — `service_role` can direct-DELETE from `handles_registry`.** Grants migration extends the revoke: `REVOKE DELETE, UPDATE, INSERT ON handles_registry FROM service_role`. SECURITY DEFINER sync triggers run as function owner (`postgres`) and bypass the revoke — they still work. Server-code direct writes are no longer possible; registry can only be mutated through the profile/creator sync path. Prevents orphaned registry rows from a buggy server action.

---

## Migration order

1. `20260420000001_extensions_and_enums.sql` — extensions, enums, **size-cap helper functions**
2. `20260420000002_touch_updated_at.sql`
3. `20260420000003_reserved_handles.sql`
4. `20260420000004_handles_registry.sql`
5. `20260420000005_profiles.sql`
6. `20260420000006_admin_roles.sql` — with `revoked_at`
7. `20260420000007_waitlist.sql`
8. `20260420000008_auth_pending_verifications.sql`
9. `20260420000009_creator_invitations.sql`
10. `20260420000010_creator_applications.sql`
11. `20260420000011_creators.sql`
12. `20260420000012_creator_topics.sql`
13. `20260420000013_sample_content.sql`
14. `20260420000014_videos.sql`
15. `20260420000015_welcome_hooks.sql`
16. `20260420000016_hooks.sql`
17. `20260420000017_sessions.sql`
18. `20260420000018_session_turns.sql` — single merged `session_turns_guard` trigger
19. `20260420000019_daily_quotas.sql` — with `daily_quotas_latch_kill_switch`
20. `20260420000020_cogs_log.sql` — with operation/metadata CHECKs
21. `20260420000021_grants.sql` — exhaustive, + TRUNCATE revokes, + service_role admin_roles DELETE revoke

---

## Extensions, enums, helper functions (`…0001`)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE profile_tier AS ENUM ('free', 'premium', 'boardroom');
CREATE TYPE creator_type AS ENUM ('human', 'brand', 'sponsored_segment');
CREATE TYPE brain_status AS ENUM ('pending', 'queued', 'training', 'ready', 'errored');
CREATE TYPE sample_source_type AS ENUM ('youtube', 'transcript', 'book_or_doc', 'mastermind_or_course', 'testimonial');
CREATE TYPE application_status AS ENUM ('submitted', 'under_review', 'approved', 'rejected');
CREATE TYPE video_status AS ENUM ('uploading', 'processing', 'ready', 'failed');
CREATE TYPE session_status AS ENUM ('starting', 'active', 'ending', 'ended', 'errored');
CREATE TYPE session_turn_role AS ENUM ('user', 'assistant');
CREATE TYPE admin_role_name AS ENUM ('superadmin', 'reviewer');
CREATE TYPE cogs_service AS ENUM ('gemini', 'cartesia', 'simli', 'tavus', 'mux', 'supabase', 'livekit', 'resend');
CREATE TYPE verification_purpose AS ENUM ('email_signup', 'magic_link');
CREATE TYPE handle_owner_kind AS ENUM ('profile', 'creator');
CREATE TYPE voice_model AS ENUM (
  'gemini_3_1_flash_live_preview',
  'gemini_live_2_5_flash_native_audio',
  'gemini_pro_audio_v2'
);

CREATE FUNCTION public.voice_model_wire_value(m voice_model) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE m
    WHEN 'gemini_3_1_flash_live_preview' THEN 'gemini-3.1-flash-live-preview'
    WHEN 'gemini_live_2_5_flash_native_audio' THEN 'gemini-live-2.5-flash-native-audio'
    WHEN 'gemini_pro_audio_v2' THEN 'gemini-pro-audio-v2'
  END;
$$;

-- Size-cap helpers for array-element CHECKs (R4-C1 fix).
-- Postgres rejects subqueries in CHECK bodies but accepts functions whose bodies
-- contain subqueries, so we wrap unnest() in an IMMUTABLE helper.
CREATE FUNCTION public._max_text_array_elem_len(arr text[]) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(max(char_length(x)), 0) FROM unnest(arr) x;
$$;

CREATE FUNCTION public._all_text_array_elems_within(arr text[], max_len int) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT arr IS NULL OR public._max_text_array_elem_len(arr) <= max_len;
$$;

-- Timezone validator for profiles.timezone CHECK (R6-C1).
-- STABLE (not IMMUTABLE) because pg_timezone_names is a system catalog view
-- that can change across Postgres upgrades. CHECK constraints accept STABLE
-- functions; Postgres just doesn't re-validate existing rows when tzdata moves.
-- Acceptable: an Olson tz name removed in a future pg upgrade is a migration
-- concern, not a correctness concern for today.
CREATE FUNCTION public._is_valid_timezone(tz text) RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF tz IS NULL THEN RETURN false; END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value OR undefined_object THEN
  RETURN false;
END;$$;
```

`cogs_service / operation` convention unchanged from v3.

---

## Size caps (CHECK constraints)

| table.column | cap | enforced as |
|---|---|---|
| `profiles.display_name` | `length ≤ 80` | inline CHECK |
| `profiles.handle` | `length BETWEEN 3 AND 30` | inline CHECK |
| `profiles.avatar_url` | `length ≤ 500` | inline CHECK |
| `profiles.goals[i]` | each element `length ≤ 200` | `CHECK (public._all_text_array_elems_within(goals, 200))` |
| `profiles.obstacles[i]` | each element `length ≤ 200` | `CHECK (public._all_text_array_elems_within(obstacles, 200))` |
| `creators.display_name` | `length ≤ 80` | inline CHECK |
| `creators.bio` | `length ≤ 2000` | inline CHECK |
| `creators.avatar_url` | `length ≤ 500` | inline CHECK |
| `creator_applications.display_name` | `length ≤ 80` | inline CHECK |
| `creator_applications.bio` | `length ≤ 2000` | inline CHECK |
| `creator_applications.topics` | `octet_length(topics::text) ≤ 16384` | inline CHECK |
| `creator_applications.proof` | `octet_length(proof::text) ≤ 32768` | inline CHECK |
| `creator_applications.rejection_reason` | `length ≤ 500` | inline CHECK |
| `creator_topics.title` | `length ≤ 100` | inline CHECK |
| `creator_topics.description` | `length ≤ 500` | inline CHECK |
| `creator_topics.slug` | `length BETWEEN 2 AND 40` | inline CHECK |
| `sample_content.title` | `length ≤ 200` | inline CHECK |
| `sample_content.source_url` | `length ≤ 2048` | inline CHECK |
| `sample_content.raw_text` | `length ≤ 262144` (256 KB) | inline CHECK |
| `hooks.caption` | `length ≤ 280` | inline CHECK |
| `sessions.end_reason` | `length ≤ 200` | inline CHECK |
| `session_turns.transcript` | `length ≤ 8192` | inline CHECK |
| `waitlist.source` | `length ≤ 100` | inline CHECK |
| `cogs_log.operation` | `length ≤ 64` | inline CHECK (**R4-S3**) |
| `cogs_log.metadata` | `octet_length(metadata::text) ≤ 4096` | inline CHECK (**R4-S3**) |

All array-element caps call the `public._all_text_array_elems_within` helper. No raw `SELECT` expressions appear inside any CHECK body.

---

## Tables

### `reserved_handles`
`(handle citext PK)`. Seed: `admin, oakleague, support, api, www, root, system, null, undefined, settings, login, signup, waitlist, about, terms, privacy, help, contact, creator, creators, user, users, home, feed`. **`vuk` not seeded.** Service-role only; RLS enabled, zero policies.

### `handles_registry`

| column | type | constraints |
|---|---|---|
| `handle` | citext | PK |
| `owner_kind` | handle_owner_kind | NOT NULL |
| `owner_id` | uuid | NOT NULL |
| `created_at` | timestamptz | default now() |

UNIQUE `(owner_kind, owner_id)` ensures one handle per owner row.

No FK to profiles/creators (polymorphic). Registry rows written by `profiles_handle_sync` and `creators_handle_sync` triggers (SECURITY DEFINER). Cleanup on owner delete via same triggers. Promotion path (profile→creator) mutates `owner_kind` / `owner_id` in place atomically (see §Creator promotion flow).

Service-role only. RLS enabled, zero policies.

### `profiles`

Columns as v3. Changes:
- No `UNIQUE` on `profiles.handle` (uniqueness now lives in `handles_registry`).
- Format CHECK stays; size caps per table above (inline + helper-function for arrays).
- `handle` normalized to lower case before CHECK via trigger.
- **New column `timezone text NOT NULL DEFAULT 'UTC' CHECK (public._is_valid_timezone(timezone))`** (R6-C1). IANA name (`America/Los_Angeles`, `Europe/Berlin`, etc.). Set from `Intl.DateTimeFormat().resolvedOptions().timeZone` at signup; user-editable in settings. Used by all quota-date computations — `daily_quotas.quota_date` is the user's local date per this column, not UTC.

**Trigger `profiles_handle_sync`** — SECURITY DEFINER, `SET search_path = public, pg_temp`. BEFORE INSERT OR UPDATE OF handle:
```
IF NEW.handle IS NOT NULL THEN
  NEW.handle := lower(NEW.handle);
  IF EXISTS (SELECT 1 FROM reserved_handles WHERE handle = NEW.handle) THEN
    RAISE EXCEPTION 'handle "%" is reserved', NEW.handle USING ERRCODE = 'check_violation';
  END IF;
END IF;
```
AFTER INSERT OR UPDATE OF handle:
```
IF NEW.handle IS DISTINCT FROM OLD.handle THEN
  DELETE FROM handles_registry WHERE owner_kind = 'profile' AND owner_id = NEW.id;
  IF NEW.handle IS NOT NULL THEN
    INSERT INTO handles_registry (handle, owner_kind, owner_id) VALUES (NEW.handle, 'profile', NEW.id);
  END IF;
END IF;
```

BEFORE DELETE ON profiles:
```
DELETE FROM handles_registry WHERE owner_kind = 'profile' AND owner_id = OLD.id;
```

**Trigger `handle_new_user`** — unchanged from v3.

RLS and grants unchanged.

### `admin_roles`

| column | type | constraints |
|---|---|---|
| `email` | citext | PK |
| `role` | admin_role_name | NOT NULL default 'superadmin' |
| `revoked_at` | timestamptz | nullable |
| `created_at` | timestamptz | default now() |

**Seed:** `vukpjescic@gmail.com` as `superadmin`.

Service-role only. RLS enabled, zero policies. Physical DELETE blocked at grant level (service_role included per **R4-S2**) AND via `admin_roles_block_delete` BEFORE DELETE trigger. Soft-delete: `UPDATE admin_roles SET revoked_at = now() WHERE email = ?`.

`assertAdminFromSession()` requires `revoked_at IS NULL`.

### `waitlist`, `auth_pending_verifications`, `creator_invitations`

Unchanged from v4.

### `creator_applications`

As v4:
- Partial UNIQUE index `(user_id) WHERE status IN ('submitted', 'under_review')`.
- Size CHECKs per §Size caps.
- `creator_applications_freeze_after_submit` and `creator_applications_block_delete_with_creator` triggers unchanged.
- DELETE policy unchanged (superadmin only).

### `creators`

As v4:
- `application_id uuid UNIQUE REFERENCES creator_applications(id) DEFERRABLE INITIALLY DEFERRED`
- CHECK `(published_at IS NULL OR brain_status = 'ready')`
- CHECK `creator_type = 'human'` (v1 gate)
- Size CHECKs per §Size caps
- No `UNIQUE` on `creators.handle` (uniqueness via `handles_registry`)
- Handle sync trigger `creators_handle_sync` mirrors `profiles_handle_sync` AND handles promotion (see below)

### `sessions`

As v4 (CHECK `ended_at IS NULL OR ended_at >= started_at`, size CHECKs, and the tier-sync ON CONFLICT). In v7, the tier-sync trigger `sessions_enforce_tier_and_kill_switch` joins `profiles` for **both** tier and timezone, and computes `quota_date` in user-local time (R6-C2):

```sql
-- Inside sessions_enforce_tier_and_kill_switch, BEFORE INSERT on sessions, SECURITY DEFINER
SELECT tier, timezone INTO v_tier, v_tz
  FROM profiles WHERE id = NEW.user_id;

-- Snapshot tier on the session row itself (no mid-session swap).
NEW.tier_at_session := v_tier;

-- Compute the user's local calendar date. Never `current_date`, never `now()::date`.
v_local_date := (now() AT TIME ZONE v_tz)::date;

INSERT INTO daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s)
VALUES (NEW.user_id, v_local_date, v_tier, v_limit)
ON CONFLICT (user_id, quota_date)
DO UPDATE SET
  daily_limit_s = EXCLUDED.daily_limit_s,
  tier_snapshot = EXCLUDED.tier_snapshot
WHERE daily_quotas.kill_switch_fired_at IS NULL;
```

### `session_turns`

**New in v5: single merged trigger `session_turns_guard`** replacing the two-trigger `a_`/`b_` split. BEFORE INSERT, SECURITY DEFINER, `SET search_path = public, pg_temp`:

```sql
CREATE FUNCTION public.session_turns_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_session record;
  v_quota   record;
BEGIN
  -- Part 1: populate/validate user_id + capture session start day (user-local, R6-C2)
  SELECT s.user_id, s.started_at, s.tier_at_session, p.timezone
    INTO v_session
    FROM sessions s JOIN profiles p ON p.id = s.user_id
    WHERE s.id = NEW.session_id;

  IF v_session.user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', NEW.session_id;
  END IF;

  IF NEW.user_id IS NULL THEN
    NEW.user_id := v_session.user_id;
  ELSIF NEW.user_id <> v_session.user_id THEN
    RAISE EXCEPTION 'session_turns.user_id (%) does not match sessions.user_id (%)',
      NEW.user_id, v_session.user_id;
  END IF;

  -- Part 2: kill-switch enforcement keyed on SESSION START DAY IN USER-LOCAL TZ (R4-M1 + R6-C2)
  -- Cross-midnight (in user-local terms) sessions check the user's local day the
  -- session started on, not UTC and not current_date. If that day's quota row does
  -- not exist (e.g. session opened before any turn landed), the sessions-level
  -- gate already seeded it, so absence here genuinely = no usage yet = pass.
  SELECT seconds_used, daily_limit_s, kill_switch_fired_at
    INTO v_quota
    FROM daily_quotas
    WHERE user_id = v_session.user_id
      AND quota_date = (v_session.started_at AT TIME ZONE v_session.timezone)::date;

  IF FOUND AND (
       v_quota.kill_switch_fired_at IS NOT NULL
    OR v_quota.seconds_used >= (v_quota.daily_limit_s * 3) / 2
  ) THEN
    -- Nothing in this trigger persists. RAISE rolls back the turn insert.
    -- Voice service catches the driver error on P0001 and issues its own
    -- UPDATE sessions SET status='ending', end_reason='kill_switch'
    -- in a separate transaction. HINT is advisory for observability.
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT = 'voice service: UPDATE sessions SET status=''ending'', end_reason=''kill_switch'' out-of-band',
            ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;$$;
REVOKE EXECUTE ON FUNCTION public.session_turns_guard() FROM public;

CREATE TRIGGER session_turns_guard
  BEFORE INSERT ON session_turns
  FOR EACH ROW EXECUTE FUNCTION public.session_turns_guard();
```

Rationale for merging (R4-S4): ordering of populate-then-enforce is now expressed in a single function body, not in the alphabetical sort of trigger names. A future engineer adding another BEFORE INSERT trigger cannot split the logic or reorder the halves.

### `daily_quotas`

As v4, plus **new trigger `daily_quotas_latch_kill_switch`** (R4-S1 — names the writer):

```sql
CREATE FUNCTION public.daily_quotas_latch_kill_switch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fires on both INSERT and UPDATE (R5-S1). On INSERT, OLD is NULL, so the
  -- TG_OP guard short-circuits before dereferencing OLD.kill_switch_fired_at.
  IF (TG_OP = 'INSERT' OR OLD.kill_switch_fired_at IS NULL)
     AND NEW.seconds_used >= (NEW.daily_limit_s * 3) / 2 THEN
    NEW.kill_switch_fired_at := now();
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER daily_quotas_latch_kill_switch
  BEFORE INSERT OR UPDATE ON daily_quotas
  FOR EACH ROW EXECUTE FUNCTION public.daily_quotas_latch_kill_switch();
```

This trigger is SECURITY INVOKER (not DEFINER) — it runs as whichever role is writing the quota row (service_role from the voice service's usage accumulator). No search_path hardening needed because it doesn't query other RLS-protected tables.

This is the single writer of `kill_switch_fired_at`. Both session-creation and per-turn enforcement triggers read it as an authoritative latch. The invariant "any row with `seconds_used >= 150%` has `kill_switch_fired_at` set" holds across INSERT, UPDATE, backfill, and manual reseeds.

### `cogs_log`

As v4, plus:
- `CHECK (length(operation) <= 64)` (**R4-S3**)
- `CHECK (octet_length(metadata::text) <= 4096)` (**R4-S3**)
- `BEFORE TRUNCATE ON cogs_log FOR EACH STATEMENT` trigger calls `raise_append_only()`.
- Grants migration revokes TRUNCATE from all roles including `service_role`.

---

## Creator promotion flow (handle reuse — R4-M3)

When an application is approved and a `creators` row is inserted with `user_id = applicant`:

1. `creators_handle_sync` BEFORE INSERT: lowercase + reserved check on `NEW.handle`.
2. `creators_handle_sync` AFTER INSERT, inside the same transaction:
   ```sql
   -- If applicant's profile holds this handle, promote it atomically.
   UPDATE handles_registry
      SET owner_kind = 'creator', owner_id = NEW.id
    WHERE handle = NEW.handle
      AND owner_kind = 'profile'
      AND owner_id = NEW.user_id;

   IF NOT FOUND THEN
     -- Not a promotion; insert fresh. Will violate UNIQUE if another owner has it.
     INSERT INTO handles_registry (handle, owner_kind, owner_id)
     VALUES (NEW.handle, 'creator', NEW.id);
   END IF;

   -- Null out the profile's handle column since the registry slot has moved.
   UPDATE profiles SET handle = NULL WHERE id = NEW.user_id AND handle = NEW.handle;
   ```
3. Subsequent updates to `creators.handle` (renames) follow the standard pattern: delete creator's registry row, insert the new one. No promotion logic on renames.

This makes the shared-namespace constraint invisible to the applicant: they keep their handle when they become a creator. Their profile's `handle` field becomes NULL — they can pick a new one later if they want two.

---

## Token strategy

Same as v4. Atomic redemption UPDATE:

```sql
UPDATE creator_invitations
   SET used_at = now(), used_by_user_id = $1
 WHERE token_hash IN ($2, $3)
   AND used_at IS NULL
   AND expires_at > now()
   AND email = (SELECT email FROM auth.users WHERE id = $1)
 RETURNING id, email;
```

**Rotation window:** `INVITE_TOKEN_HMAC_SECRET_NEXT` active for ≥ 7 days (max invitation lifetime).

---

## Grants migration (`…0021_grants.sql`)

As v4, plus (**R4-S2**):

```sql
REVOKE DELETE ON admin_roles FROM PUBLIC, authenticated, anon, service_role;
REVOKE TRUNCATE ON cogs_log   FROM PUBLIC, authenticated, anon, service_role;
-- R5-S3: service_role loses all direct write paths to handles_registry.
-- SECURITY DEFINER sync triggers run as owner (postgres) and bypass this revoke.
REVOKE DELETE, UPDATE, INSERT ON handles_registry FROM PUBLIC, authenticated, anon, service_role;
```

DBAs bypass via the `postgres` role when genuinely needed. Every server-action path runs as `service_role`, which now cannot physically delete admin_roles rows (demotions go through `revoked_at` soft-delete) and cannot directly mutate `handles_registry` (all changes flow through the profile/creator sync triggers).

---

## Functions / triggers inventory (v5)

1. `public.touch_updated_at()`
2. `public.handle_new_user()` — SECURITY DEFINER
3. `public.profiles_handle_sync()` — SECURITY DEFINER
4. `public.creators_handle_sync()` — SECURITY DEFINER, includes promotion logic
5. `public.verify_sample_topic_slugs()`
6. `public.verify_hook_topic_slugs()`
7. `public.creator_topics_prevent_orphan_slugs()`
8. `public.welcome_hooks_video_same_creator()`
9. `public.hooks_video_same_creator()`
10. `public.sessions_enforce_tier_and_kill_switch()` — SECURITY DEFINER
11. `public.session_turns_guard()` — SECURITY DEFINER, **single merged trigger** (was `a_`+`b_` split)
12. `public.daily_quotas_latch_kill_switch()` — SECURITY INVOKER, BEFORE INSERT OR UPDATE (R4-S1 + R5-S1)
13. `public.creator_applications_freeze_after_submit()`
14. `public.creator_applications_block_delete_with_creator()`
15. `public.admin_roles_block_delete()` — BEFORE DELETE, raises regardless of role
16. `public.raise_append_only()` — BEFORE UPDATE/DELETE/TRUNCATE on cogs_log
17. `public._max_text_array_elem_len(text[])` — IMMUTABLE, size-cap helper
18. `public._all_text_array_elems_within(text[], int)` — IMMUTABLE, size-cap helper
19. `public.voice_model_wire_value(voice_model)` — IMMUTABLE
20. `public._is_valid_timezone(text)` — STABLE, backs `profiles.timezone` CHECK (R6-C1)

All DEFINER functions `SET search_path = public, pg_temp` and `REVOKE EXECUTE … FROM public`.

---

## Auth guard contract (`src/lib/auth-guards.ts` — Day 1)

```ts
export async function getCallerUserId(): Promise<string>
export async function assertAdminFromSession(): Promise<{ userId: string; email: string; role: 'superadmin'|'reviewer' }>
// Implementation: checks admin_roles WHERE email = <caller email> AND revoked_at IS NULL
export async function assertCreatorFromSession(): Promise<{ userId: string; creatorId: string }>
```

Every server action calls one of these first. Never inline.

---

## Tests (pgTAP via `supabase test db`)

All v4 tests plus:

**Round-6 coverage (user-timezone):**
- `profile_tz_rejects_invalid.test.sql` — `UPDATE profiles SET timezone = 'Mars/Phobos'` raises check_violation; `UPDATE … SET timezone = 'America/Los_Angeles'` succeeds.
- `quota_date_is_user_local.test.sql` — user in `America/Los_Angeles`; open session at UTC 07:00 (which is 23:00 PST the previous local day); assert `daily_quotas.quota_date` equals the PST calendar date, not the UTC date.
- `cross_utc_midnight_same_local_day.test.sql` — LA user opens session at 23:55 PST (07:55 UTC next day); turn lands at 00:05 PST (08:05 UTC); same `quota_date` used, no reset. Asserts R4-M1 + R6-C2 interact correctly.
- `cross_local_midnight_new_day.test.sql` — LA user opens session at 23:55 PST; trigger seeds quota for PST day N. A turn landing after local PST midnight still hits day N's quota (session-start-day keying).
- `utc_default_user_gets_utc_reset.test.sql` — profile.timezone left as `'UTC'`; quota_date math equals UTC ::date — baseline for users who didn't complete tz capture.

**Round-5 coverage:**
- `latch_on_insert.test.sql` — `INSERT INTO daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used) VALUES (?, current_date, 'free', 1200, 2000)` → assert `kill_switch_fired_at IS NOT NULL` immediately after the insert (no prior UPDATE needed).
- `tier_upgrade_does_not_unlatch.test.sql` — quota row latched on free tier; flip `profiles.tier` to premium; open new session → session insert fails with kill-switch raise; quota row still shows `kill_switch_fired_at IS NOT NULL`.
- `admin_clear_latch_unblocks.test.sql` — same setup; admin runs `UPDATE daily_quotas SET kill_switch_fired_at = NULL`; new session succeeds.
- `handles_registry_service_role_blocked.test.sql` — SET ROLE service_role; direct `DELETE`, `UPDATE`, `INSERT` on `handles_registry` all raise permission errors; a profile handle change via `UPDATE profiles SET handle = ?` still succeeds (sync trigger runs as postgres).

**Round-4 coverage:**
- `array_elem_cap_compiles.test.sql` — migration applies cleanly; insert into profiles with a `goals` element > 200 chars raises, ≤ 200 passes. Proves R4-C1 is fixed.
- `cross_midnight_kill_switch.test.sql` — session starts 23:55 day N, quota for day N has kill_switch fired; turn inserted at 00:03 day N+1 raises P0001.
- `cross_midnight_day_boundary_no_latch.test.sql` — session starts 23:55 day N, day N quota fresh (no latch); turn at 00:03 day N+1 passes (keys on session start day, latch not set).
- `handle_promotion_profile_to_creator.test.sql` — user has `profiles.handle='alice'`; on creator approval with `handle='alice'`, registry row mutates to `('creator', creator_id)`, `profiles.handle` becomes NULL, no UNIQUE violation.
- `handle_promotion_taken_by_other_rejected.test.sql` — user has `profiles.handle='alice'`; a *different* creator already holds `alice`; attempt to create creator with `handle='alice'` raises UNIQUE violation.
- `kill_switch_latch_written_by_trigger.test.sql` — UPDATE daily_quotas SET seconds_used = daily_limit_s * 2; assert `kill_switch_fired_at IS NOT NULL` after the update.
- `admin_roles_service_role_delete_blocked.test.sql` — SET ROLE service_role; DELETE FROM admin_roles raises.
- `cogs_log_operation_cap.test.sql` — INSERT with operation of 65 chars raises.
- `cogs_log_metadata_cap.test.sql` — INSERT with metadata > 4096 octets raises.
- `session_turns_single_trigger_ordering.test.sql` — assert exactly one BEFORE INSERT trigger on session_turns; assert it populates user_id AND raises on exceeded quota in one call.

**Round-3 coverage (unchanged from v4):**
- `cascade_auth_user_delete.test.sql`
- `handle_guard_under_rls.test.sql`
- `handle_registry_race_denied.test.sql`
- `quota_tier_flip_same_day.test.sql`
- `quota_kill_switch_latch_preserved.test.sql`
- `session_turns_mid_session_kill_switch.test.sql`
- `invitation_email_binding.test.sql`
- `reserved_handles_no_vuk.test.sql`
- `cogs_log_truncate_blocked.test.sql`
- `admin_roles_revoked_denied.test.sql`
- `size_caps.test.sql`
- `creators_publish_requires_ready.test.sql`
- `creator_applications_no_double_active.test.sql`
- `handle_lowercased_on_insert.test.sql`
- `creator_type_human_only_v1.test.sql`
- `sessions_ended_after_started.test.sql`

---

## Edge cases covered

All v4 cases plus:

- **Profile→creator handle promotion** → handled atomically in `creators_handle_sync` (§Creator promotion flow). Applicant retains their handle on approval; profile's handle column is nulled.
- **Cross-midnight session** → `session_turns_guard` keys quota lookup on `sessions.started_at::date`, not `current_date`. A session started at 23:55 is still bounded by its opening day's quota and latch.
- **`kill_switch_fired_at` writer** → `daily_quotas_latch_kill_switch` trigger (BEFORE INSERT OR UPDATE); fires whenever a quota row crosses 150% on any write path. Column is authoritative, not vestigial.
- **Kill-switch latch survives tier upgrades (R5-S2).** Once `kill_switch_fired_at` is set, upgrading `profiles.tier` does NOT unblock the user for the rest of the day. `sessions_enforce_tier_and_kill_switch` upsert clause `WHERE daily_quotas.kill_switch_fired_at IS NULL` intentionally skips latched rows. To unblock an upgraded user same-day, an admin must run `UPDATE daily_quotas SET kill_switch_fired_at = NULL WHERE user_id = ? AND quota_date = current_date`. This is intentional: tier upgrade is not a bypass mechanism. On-call runbook references this clearance procedure.
- **handles_registry has no direct server-action write path (R5-S3).** All mutations flow through `profiles_handle_sync` / `creators_handle_sync` SECURITY DEFINER triggers. Attempting `DELETE FROM handles_registry` or `INSERT INTO handles_registry` from a service-role server action raises a permission error. Registry orphans from a buggy server action are now structurally impossible.
- **User-local midnight, not UTC (R6-C1 / R6-C2 / R6-C3).** `daily_quotas.quota_date` is always the user's local calendar date per `profiles.timezone`. All triggers computing `quota_date` use `(<ts> AT TIME ZONE p.timezone)::date`. A Los Angeles user's quota resets at local midnight (08:00 UTC), a Sydney user's at local midnight (13:00/14:00 UTC), a UTC-default user's at UTC midnight. No one gets a mid-afternoon quota reset.
- **Timezone changes mid-session (R6-M1).** If a user flips tz during an active session, subsequent turns within the 15-min Gemini cap could key to a different local day. Accepted: worst case is 15 minutes of "wrong-day" attribution, bounded by the provider. Not worth a `sessions.timezone_at_session` snapshot.
- **Traveling users (R6-M2).** Profile-current tz (not session-snapshot) means a user who flies LA→NYC and updates their tz gets a quota window aligned to ET on their next session open. Matches "reset at local midnight" as the user now experiences it.
- **Retraining failure after publish** → server action MUST issue a single `UPDATE creators SET brain_status='errored', published_at=NULL WHERE …`. Two separate UPDATEs will violate `(published_at IS NULL OR brain_status='ready')` on the first write. Single-statement atomicity is required.
- **Service-role bug attempting `DELETE FROM admin_roles`** → grant REVOKE + BEFORE DELETE trigger both block. Audit trail preserved via `revoked_at`.
- **Oversized `cogs_log.metadata` from buggy provider adapter** → CHECK raises at insert; offending call fails loudly instead of bloating the table.
- (From v4) Admin demotion audit trail, same-day tier change, mid-session runaway cost, invite link forwarding, auth user hard-delete, welcome hook removed on video delete, topic renamed after historical session — all unchanged.

---

## Explicit non-features (unchanged)

- No `is_founder`, `is_vuk`, hardcoded founder identity, or handle carve-out for Vuk.
- No Stripe columns — v2.
- No vector embeddings — topic drawers are text retrieval.
- Brand/sponsored_segment creator types exist in enum but gated by CHECK; flip in v2 migration.
- No in-DB rate limiting — infra layer.
