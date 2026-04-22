-- Day 13–14 plan REV 5, migration 2 of 5.
-- Session lifecycle RPCs + rollover trigger patch.
--
-- All RPCs are SECURITY DEFINER and identify the caller via auth.uid()
-- (migration 0043 pattern). Production routes call these after
-- getCallerUserId() + same-origin checks at the Next.js boundary.
--
-- Custom PG errcodes (R3-S10; route layer maps errcode → HTTP + typed body):
--   P0001 — generic kill-switch (preserved from 0017)
--   P0003 — downgrade_blocked_until_tomorrow (used in migration 4)
--   P0004 — has_active_session              (used in migration 4)
--   P0005 — already_active                  (session_open)
--   P0006 — not_found_or_dead               (session_close / admin)

-- ── sessions_enforce_tier_and_kill_switch trigger patch (R4-M2) ──────────
-- Rollover inserts carry metadata={rollover:true, prev_session_id:…}. When
-- detected, SKIP:
--   (1) the tier-snapshot (NEW.tier_at_session := v_tier) — caller-supplied
--       tier_at_session from session_rollover is the one from the OLD row.
--       Inheriting the current profiles.tier would cross-leak if admin
--       flipped between UPDATE-old (step 3) and INSERT-new (step 4).
--   (2) the daily_quotas upsert — quota was already charged against the
--       old row's active_seconds path at session_close(old). Re-upserting
--       with a possibly-flipped tier would back-door the downgrade-block.

CREATE OR REPLACE FUNCTION public.sessions_enforce_tier_and_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tier       profile_tier;
  v_tz         text;
  v_limit_s    int;
  v_local_date date;
  v_latched    boolean;
  v_is_rollover boolean;
BEGIN
  v_is_rollover := COALESCE(NEW.metadata->>'rollover', 'false') = 'true';

  SELECT tier, timezone INTO v_tier, v_tz
    FROM public.profiles WHERE id = NEW.user_id;
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'sessions.user_id % has no profile', NEW.user_id USING ERRCODE = '23503';
  END IF;

  -- Rollover path: tier_at_session was set by session_rollover to the old
  -- row's snapshot. Do NOT overwrite. Do NOT double-charge quota.
  IF v_is_rollover THEN
    RETURN NEW;
  END IF;

  NEW.tier_at_session := v_tier;

  v_limit_s := CASE v_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_local_date := (now() AT TIME ZONE v_tz)::date;

  SELECT kill_switch_fired_at IS NOT NULL INTO v_latched
    FROM public.daily_quotas
   WHERE user_id = NEW.user_id AND quota_date = v_local_date;
  IF v_latched THEN
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT    = 'daily quota latched; admin must clear to unlock',
            ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s)
  VALUES (NEW.user_id, v_local_date, v_tier, v_limit_s)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    daily_limit_s = EXCLUDED.daily_limit_s,
    tier_snapshot = EXCLUDED.tier_snapshot
  WHERE public.daily_quotas.kill_switch_fired_at IS NULL;

  RETURN NEW;
END;$$;

-- ── session_open ─────────────────────────────────────────────────────────
-- Inserts a new sessions row on behalf of auth.uid(). No p_user_id param
-- (matches 0043 pattern). Tier + kill-switch enforcement fires via the
-- sessions_enforce_tier_and_kill_switch BEFORE trigger — this function only
-- translates the unique_violation on sessions_one_active_per_user into a
-- typed 'already_active' errcode.
--
-- Returns daily_limit_remaining_s so the client can display the cost ticker
-- upper bound without an extra round trip.

CREATE FUNCTION public.session_open(
  p_creator_id uuid,
  p_hook_id    uuid,
  p_model      voice_model
) RETURNS TABLE (
  session_id              uuid,
  tier                    profile_tier,
  daily_limit_remaining_s int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id   uuid;
  v_tz        text;
  v_qdate     date;
  v_new_id    uuid;
  v_tier      profile_tier;
  v_limit_s   int;
  v_used      int;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  -- Insert. The BEFORE trigger snapshots tier_at_session + upserts today's
  -- quota row + raises P0001 if kill-switch already latched.
  BEGIN
    INSERT INTO public.sessions (user_id, creator_id, hook_id, model_used, tier_at_session, status, avatar_status)
    VALUES (v_user_id, p_creator_id, p_hook_id, p_model, 'free'::profile_tier, 'starting', 'pending')
    RETURNING id INTO v_new_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- sessions_one_active_per_user collision. Route maps to HTTP 409.
      RAISE EXCEPTION 'already_active' USING ERRCODE = 'P0005';
  END;

  -- Read back the snapshot set by the trigger + today's remaining quota.
  SELECT s.tier_at_session, p.timezone
    INTO v_tier, v_tz
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = v_new_id;

  v_qdate := (now() AT TIME ZONE v_tz)::date;

  SELECT q.daily_limit_s, q.seconds_used
    INTO v_limit_s, v_used
    FROM public.daily_quotas q
   WHERE q.user_id = v_user_id AND q.quota_date = v_qdate;

  IF v_limit_s IS NULL THEN
    -- Defensive; trigger should have upserted. Fall back to tier default.
    v_limit_s := CASE v_tier
      WHEN 'free'      THEN 600
      WHEN 'premium'   THEN 3600
      WHEN 'boardroom' THEN 14400
    END;
    v_used := 0;
  END IF;

  RETURN QUERY SELECT v_new_id, v_tier, GREATEST(v_limit_s - v_used, 0);
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_open(uuid, uuid, voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_open(uuid, uuid, voice_model)
  TO authenticated, service_role;

-- ── session_close ─────────────────────────────────────────────────────────
-- User self-close OR service path. Ownership asserted via auth.uid(). Admin
-- force-close is a separate RPC (migration 4) so the two guards can never
-- merge into a single "admin OR owner" check (R2-C3).
--
-- Server-computed active_seconds = LEAST(
--   EXTRACT(EPOCH FROM now() - started_at) - paused_seconds_total,
--   tier_limit_s
-- ).
-- Increments daily_quotas.seconds_used by active_seconds; the latch trigger
-- fires at 1.5× limit per existing 0019 policy.

CREATE FUNCTION public.session_close(
  p_session_id uuid,
  p_end_reason text
) RETURNS TABLE (
  session_id     uuid,
  active_seconds int,
  end_reason     text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller      uuid;
  v_row         public.sessions%ROWTYPE;
  v_tz          text;
  v_qdate       date;
  v_limit_s     int;
  v_elapsed     int;
  v_active      int;
  v_is_service  boolean;
BEGIN
  v_caller := auth.uid();
  v_is_service := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';

  IF p_end_reason IS NULL OR char_length(p_end_reason) = 0 OR char_length(p_end_reason) > 200 THEN
    RAISE EXCEPTION 'bad_end_reason' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  IF NOT v_is_service AND v_row.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: closing an already-closed row is a no-op that returns the
  -- existing active_seconds (routes don't need to distinguish).
  IF v_row.ended_at IS NOT NULL THEN
    RETURN QUERY SELECT v_row.id, v_row.active_seconds, v_row.end_reason;
    RETURN;
  END IF;

  SELECT p.timezone INTO v_tz FROM public.profiles p WHERE p.id = v_row.user_id;
  v_qdate := (v_row.started_at AT TIME ZONE v_tz)::date;

  v_limit_s := CASE v_row.tier_at_session
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_elapsed := GREATEST(EXTRACT(EPOCH FROM (now() - v_row.started_at))::int - v_row.paused_seconds_total, 0);
  v_active  := LEAST(v_elapsed, v_limit_s);

  UPDATE public.sessions
     SET ended_at       = now(),
         status         = 'ended',
         end_reason     = p_end_reason,
         active_seconds = v_active
   WHERE id = p_session_id;

  -- Close any still-open pause row defensively.
  UPDATE public.session_pauses
     SET resumed_at = now()
   WHERE session_id = p_session_id AND resumed_at IS NULL;

  -- Quota accrual; latch trigger fires on cross.
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_row.user_id, v_qdate, v_row.tier_at_session, v_limit_s, v_active)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    seconds_used = public.daily_quotas.seconds_used + EXCLUDED.seconds_used;

  RETURN QUERY SELECT p_session_id, v_active, p_end_reason;
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_close(uuid, text)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_close(uuid, text)
  TO authenticated, service_role;

-- ── session_rollover (R2-C1, R3-M1, R4-M2) ───────────────────────────────
-- Atomic close-old + insert-new in one transaction. Ordering is load-bearing:
--   1. Ownership assert on old row
--   2. Capture v_inherit_tier := old.tier_at_session (R4-M2)
--   3. UPDATE old SET ended_at/... — clears sessions_one_active_per_user
--   4. INSERT new with metadata={rollover:true, prev_session_id}
-- Swap 3 & 4 and you get 23505 unique_violation.
--
-- The BEFORE trigger (patched above) sees rollover=true and SKIPS both the
-- tier-snapshot and the quota upsert. The quota for the day was already
-- charged against the old row at session_close(old) — wait, we don't call
-- session_close(old) here. Instead, we inline-charge the old row's
-- active_seconds against daily_quotas, mirroring the close path, and set
-- end_reason='gemini_15min_cap'.

CREATE FUNCTION public.session_rollover(
  p_old_session_id uuid,
  p_creator_id     uuid,
  p_hook_id        uuid,
  p_model          voice_model
) RETURNS TABLE (
  new_session_id          uuid,
  tier                    profile_tier,
  daily_limit_remaining_s int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller        uuid;
  v_old           public.sessions%ROWTYPE;
  v_inherit_tier  profile_tier;
  v_tz            text;
  v_qdate         date;
  v_limit_s       int;
  v_elapsed       int;
  v_old_active    int;
  v_new_id        uuid;
  v_used_today    int;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_old FROM public.sessions WHERE id = p_old_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;
  IF v_old.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;
  IF v_old.ended_at IS NOT NULL THEN
    -- Another tab already closed. Refuse to open a duplicate rollover.
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  -- R4-M2: inherit tier from the OLD row, NOT profiles.tier. If admin flipped
  -- between close-old and insert-new, we want the conversation to stay on
  -- the tier it opened on.
  v_inherit_tier := v_old.tier_at_session;

  SELECT p.timezone INTO v_tz FROM public.profiles p WHERE p.id = v_caller;
  v_qdate := (v_old.started_at AT TIME ZONE v_tz)::date;

  v_limit_s := CASE v_inherit_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_elapsed    := GREATEST(EXTRACT(EPOCH FROM (now() - v_old.started_at))::int - v_old.paused_seconds_total, 0);
  v_old_active := LEAST(v_elapsed, v_limit_s);

  -- Step 3 — close OLD first so the partial-unique predicate no longer
  -- applies to its row before we INSERT the NEW row.
  UPDATE public.sessions
     SET ended_at       = now(),
         status         = 'ended',
         end_reason     = 'gemini_15min_cap',
         active_seconds = v_old_active
   WHERE id = p_old_session_id;

  UPDATE public.session_pauses
     SET resumed_at = now()
   WHERE session_id = p_old_session_id AND resumed_at IS NULL;

  -- Charge OLD row's active_seconds against today's quota (same rule as
  -- session_close). Latch trigger fires on cross.
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_caller, v_qdate, v_inherit_tier, v_limit_s, v_old_active)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    seconds_used = public.daily_quotas.seconds_used + EXCLUDED.seconds_used;

  -- R5-C1: re-check the latch AFTER the quota upsert and BEFORE the rollover
  -- INSERT. The BEFORE trigger's rollover branch skips its own latch check
  -- (metadata.rollover=true), so without this guard a user past 1.5× their
  -- daily cap would get a fresh 15-min Gemini window on every rollover.
  IF EXISTS (
    SELECT 1 FROM public.daily_quotas
     WHERE user_id = v_caller AND quota_date = v_qdate
       AND kill_switch_fired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT    = 'daily quota latched during rollover charge; rollover denied',
            ERRCODE = 'P0001';
  END IF;

  -- Step 4 — INSERT new. tier_at_session is SET EXPLICITLY because the
  -- rollover branch of the trigger will see metadata->>'rollover'='true'
  -- and skip its own snapshot.
  INSERT INTO public.sessions (
    user_id, creator_id, hook_id, model_used, tier_at_session,
    status, avatar_status, metadata
  )
  VALUES (
    v_caller, p_creator_id, p_hook_id, p_model, v_inherit_tier,
    'starting', 'pending',
    jsonb_build_object('rollover', true, 'prev_session_id', p_old_session_id)
  )
  RETURNING id INTO v_new_id;

  -- Remaining seconds after the OLD row's charge landed.
  SELECT q.seconds_used INTO v_used_today
    FROM public.daily_quotas q
   WHERE q.user_id = v_caller AND q.quota_date = v_qdate;

  RETURN QUERY SELECT v_new_id, v_inherit_tier, GREATEST(v_limit_s - COALESCE(v_used_today, 0), 0);
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  TO authenticated, service_role;

-- ── session_heartbeat (R3-M3) ────────────────────────────────────────────
-- Tri-state return maps to route layer: 'ok' → 200, 'rate_limited' → 204,
-- 'not_found_or_dead' → 410 Gone (client stops polling + shows reconnect UI).
-- NO delta_seconds input — quota accrual happens at close.

CREATE FUNCTION public.session_heartbeat(p_session_id uuid)
RETURNS TABLE (status text, last_heartbeat_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller uuid;
  v_row    record;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT s.user_id, s.ended_at, s.last_heartbeat_at
    INTO v_row
    FROM public.sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND OR v_row.ended_at IS NOT NULL THEN
    RETURN QUERY SELECT 'not_found_or_dead'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_row.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  -- Rate-limit floor: 10s between heartbeats.
  IF v_row.last_heartbeat_at > now() - interval '10 seconds' THEN
    RETURN QUERY SELECT 'rate_limited'::text, v_row.last_heartbeat_at;
    RETURN;
  END IF;

  UPDATE public.sessions
     SET last_heartbeat_at = now()
   WHERE id = p_session_id
   RETURNING public.sessions.last_heartbeat_at INTO v_row.last_heartbeat_at;

  RETURN QUERY SELECT 'ok'::text, v_row.last_heartbeat_at;
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_heartbeat(uuid)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_heartbeat(uuid)
  TO authenticated, service_role;

-- ── session_pause (R3-M6) ────────────────────────────────────────────────
-- Opens a session_pauses row. Duplicate-open → soft no-op returning current
-- paused_seconds_total. Partial-unique index is the guard.

CREATE FUNCTION public.session_pause(p_session_id uuid)
RETURNS TABLE (paused_seconds_total int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller uuid;
  v_row    record;
  v_total  int;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT s.user_id, s.ended_at, s.paused_seconds_total
    INTO v_row
    FROM public.sessions s
   WHERE s.id = p_session_id
     FOR UPDATE;
  IF NOT FOUND OR v_row.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;
  IF v_row.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO public.session_pauses (session_id) VALUES (p_session_id);
  EXCEPTION
    WHEN unique_violation THEN
      -- Double-pause: idempotent soft no-op.
      NULL;
  END;

  v_total := v_row.paused_seconds_total;
  RETURN QUERY SELECT v_total;
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_pause(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_pause(uuid) TO authenticated, service_role;

-- ── session_resume (R3-M6) ───────────────────────────────────────────────
-- Closes the open pause row; adds (now() - paused_at) to paused_seconds_total.
-- No open row → soft no-op.

CREATE FUNCTION public.session_resume(p_session_id uuid)
RETURNS TABLE (paused_seconds_total int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller uuid;
  v_row    record;
  v_delta  int;
  v_total  int;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT s.user_id, s.ended_at, s.paused_seconds_total
    INTO v_row
    FROM public.sessions s
   WHERE s.id = p_session_id
     FOR UPDATE;
  IF NOT FOUND OR v_row.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;
  IF v_row.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  UPDATE public.session_pauses
     SET resumed_at = now()
   WHERE session_id = p_session_id AND resumed_at IS NULL
   RETURNING GREATEST(EXTRACT(EPOCH FROM (now() - paused_at))::int, 0) INTO v_delta;

  IF v_delta IS NULL THEN
    -- No open pause; soft no-op.
    RETURN QUERY SELECT v_row.paused_seconds_total;
    RETURN;
  END IF;

  v_total := v_row.paused_seconds_total + v_delta;

  UPDATE public.sessions
     SET paused_seconds_total = v_total
   WHERE id = p_session_id;

  RETURN QUERY SELECT v_total;
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_resume(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_resume(uuid) TO authenticated, service_role;

-- ── session_set_avatar_status (R2-M3, R3-S7) ─────────────────────────────
-- Transition table enforced in-function:
--   pending → {minted, skipped_tier, failed_mint, not_applicable}
--   minted  → failed_connect
-- All other transitions raise 22023 'bad_avatar_status_transition'.
--
-- Ownership asserted via auth.uid() OR service-role. The route path is
-- user-authed; the avatar WebRTC error surface flips minted→failed_connect
-- via this RPC from the client, same ownership rules apply.

CREATE FUNCTION public.session_set_avatar_status(
  p_session_id uuid,
  p_status     text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller     uuid;
  v_is_service boolean;
  v_current    text;
  v_owner      uuid;
  v_allowed    boolean;
BEGIN
  v_caller := auth.uid();
  v_is_service := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';

  SELECT s.avatar_status, s.user_id
    INTO v_current, v_owner
    FROM public.sessions s
   WHERE s.id = p_session_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;
  IF NOT v_is_service AND v_owner <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  v_allowed :=
    (v_current = 'pending' AND p_status IN ('minted', 'skipped_tier', 'failed_mint', 'not_applicable'))
    OR (v_current = 'minted' AND p_status = 'failed_connect')
    OR (v_current = p_status);  -- idempotent self-assignment

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'bad_avatar_status_transition: % → %', v_current, p_status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.sessions SET avatar_status = p_status WHERE id = p_session_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_set_avatar_status(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_set_avatar_status(uuid, text) TO authenticated, service_role;
