-- 20260615000003 — Growth & Minutes Economy, Phase 1c: de-stale the session RPCs
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §3 (R4-C1).
--
-- session_open and session_rollover still carried the pre-2026-05-10 hardcoded
-- tier CASE (free=600 / premium=3600 / boardroom=14400) for their System-A
-- `daily_limit_remaining_s` math. Those literals are stale (free's real cap is
-- 300) and, in rollover, the `LEAST(v_elapsed, v_limit_s)` clamp UNDER-CHARGES a
-- wallet/paid rollover that legitimately ran past the base cap.
--
-- THE UNIFIED BALANCE NOW LIVES IN THE ROUTE. /api/sessions/open and /rollover
-- call voice_balance_check (20260615000002) for the 429 gate, the max_duration_s
-- clamp, and the 150%-fuse anchor — so these RPCs' return value is no longer the
-- driver. This migration just removes the stale literals so the System-A number
-- they DO return is honest, and fixes the rollover under-charge.
--
-- R4-C1: these are CREATE OR REPLACE against the HIGHEST-timestamp live bodies
-- (session_open = 20260522000100, session_rollover = 20260522000104), re-grepped
-- 2026-06-16. Replacing the superseded 20260511000000 body would be silently
-- clobbered on db:reset. Signatures + GRANTs preserved (CREATE OR REPLACE).
--
-- BYTE-FAITHFUL to the live bodies EXCEPT:
--   session_open      — the unreachable v_limit_s IS NULL fallback CASE → profile cap.
--   session_rollover  — v_limit_s CASE → profile cap (charge clamp kept).
--
-- Wrapped in BEGIN/COMMIT so a mid-apply error can't leave session_open replaced
-- while session_rollover keeps the stale body (M3).

BEGIN;

CREATE OR REPLACE FUNCTION public.session_open(
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
  v_user_id          uuid;
  v_new_id           uuid;
  v_tier             profile_tier;
  v_tz               text;
  v_qdate            date;
  v_limit_s          int;
  v_used             int;
  v_corpus_version   int;
  v_retrieval_version smallint;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  -- R3 audit C1: cross-creator binding rejected.
  IF NOT EXISTS (
    SELECT 1
      FROM public.hooks h
      JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = p_hook_id
       AND v.creator_id = p_creator_id
  ) THEN
    RAISE EXCEPTION 'hook_creator_mismatch' USING ERRCODE = '42501';
  END IF;

  -- MIG-9 (Phase-2 C1): snapshot corpus_version under FOR SHARE.
  -- Day-13 audit C1: snapshot retrieval_version in the SAME row lock.
  SELECT current_corpus_version, retrieval_version
    INTO v_corpus_version, v_retrieval_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;
  IF v_corpus_version IS NULL THEN
    RAISE EXCEPTION 'creator_not_found' USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO public.sessions (
      user_id, creator_id, hook_id, model_used, tier_at_session,
      status, avatar_status,
      corpus_version_at_session, retrieval_version_at_session
    )
    VALUES (
      v_user_id, p_creator_id, p_hook_id, p_model, 'free'::profile_tier,
      'starting', 'pending',
      v_corpus_version, v_retrieval_version
    )
    RETURNING id INTO v_new_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'already_active' USING ERRCODE = 'P0005';
  END;

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
    -- Defensive only: the session-insert trigger (sessions_enforce_tier_and_
    -- kill_switch) always upserts today's daily_quotas row before we read it,
    -- so this is unreachable in normal flow. De-staled from the old hardcoded
    -- 600/3600/14400 CASE (R4-C1) to the actual source of truth, the profile cap.
    v_limit_s := (SELECT voice_daily_cap_seconds FROM public.profiles WHERE id = v_user_id);
    v_used := 0;
  END IF;

  RETURN QUERY SELECT v_new_id, v_tier, GREATEST(v_limit_s - v_used, 0);
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_open(uuid, uuid, voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_open(uuid, uuid, voice_model)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.session_rollover(
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
  v_caller            uuid;
  v_old               public.sessions%ROWTYPE;
  v_inherit_tier      profile_tier;
  v_tz                text;
  v_qdate             date;
  v_limit_s           int;
  v_elapsed           int;
  v_old_active        int;
  v_new_id            uuid;
  v_used_today        int;
  v_corpus_version    int;
  v_retrieval_version smallint;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.hooks h
      JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = p_hook_id
       AND v.creator_id = p_creator_id
  ) THEN
    RAISE EXCEPTION 'hook_creator_mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_old FROM public.sessions WHERE id = p_old_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;
  IF v_old.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;
  IF v_old.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  v_inherit_tier := v_old.tier_at_session;

  SELECT p.timezone INTO v_tz FROM public.profiles p WHERE p.id = v_caller;
  -- Charge against the OLD session's start day (its quota bucket), not today.
  v_qdate := (v_old.started_at AT TIME ZONE v_tz)::date;

  -- De-staled from the hardcoded 600/3600/14400 CASE (R4-C1) to the profile cap.
  -- Used as the daily_quotas insert default (the route's voice_fuse_anchor_apply
  -- then GREATEST-raises it to entitlement) and the vestigial System-A return.
  v_limit_s := (SELECT voice_daily_cap_seconds FROM public.profiles WHERE id = v_caller);

  -- Live elapsed: now - start - paused.
  v_elapsed    := GREATEST(EXTRACT(EPOCH FROM (now() - v_old.started_at))::int - v_old.paused_seconds_total, 0);
  -- Clamp the System-A charge to the (de-staled) profile cap, matching the
  -- original 20260522000104 behavior (audit C3 — REVERTED an earlier raw-elapsed
  -- change). Raw elapsed could latch the kill switch against a base-cap-anchored
  -- daily_quotas row at a date boundary (the RPC charges v_old.started_at's day,
  -- the route's fuse anchor raises now()'s day). The wallet draw (System B /
  -- voice_usage_record_v2) is the authoritative per-turn meter, so System A
  -- staying a lenient COGS backstop here is correct, not a regression.
  v_old_active := LEAST(v_elapsed, v_limit_s);

  -- CLOSE the old session (the load-bearing line the 000100 regression dropped).
  UPDATE public.sessions
     SET ended_at       = now(),
         status         = 'ended',
         end_reason     = 'gemini_15min_cap',
         active_seconds = v_old_active
   WHERE id = p_old_session_id;

  -- Resolve any open pause so the closed session leaves no dangling pause row.
  UPDATE public.session_pauses
     SET resumed_at = now()
   WHERE session_id = p_old_session_id AND resumed_at IS NULL;

  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_caller, v_qdate, v_inherit_tier, v_limit_s, v_old_active)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    seconds_used = public.daily_quotas.seconds_used + EXCLUDED.seconds_used;

  IF EXISTS (
    SELECT 1 FROM public.daily_quotas
     WHERE user_id = v_caller AND quota_date = v_qdate
       AND kill_switch_fired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT    = 'daily quota latched during rollover charge; rollover denied',
            ERRCODE = 'P0001';
  END IF;

  -- Day-13 audit C1: same pair-snapshot under FOR SHARE as session_open.
  SELECT current_corpus_version, retrieval_version
    INTO v_corpus_version, v_retrieval_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;
  IF v_corpus_version IS NULL THEN
    RAISE EXCEPTION 'creator_not_found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.sessions (
    user_id, creator_id, hook_id, model_used, tier_at_session,
    status, avatar_status, metadata,
    corpus_version_at_session, retrieval_version_at_session
  )
  VALUES (
    v_caller, p_creator_id, p_hook_id, p_model, v_inherit_tier,
    'starting', 'pending',
    jsonb_build_object('rollover', true, 'prev_session_id', p_old_session_id),
    v_corpus_version, v_retrieval_version
  )
  RETURNING id INTO v_new_id;

  SELECT q.seconds_used INTO v_used_today
    FROM public.daily_quotas q
   WHERE q.user_id = v_caller AND q.quota_date = v_qdate;

  RETURN QUERY SELECT v_new_id, v_inherit_tier, GREATEST(v_limit_s - COALESCE(v_used_today, 0), 0);
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.session_open(uuid, uuid, voice_model) IS
  'Open a new voice session. Snapshots corpus_version + retrieval_version under FOR '
  'SHARE. daily_limit_remaining_s is System-A-shaped (de-staled to the profile cap); the '
  'unified wallet+allowance balance is owned by the route via voice_balance_check.';

COMMENT ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model) IS
  'Roll a session at the Gemini 15-min cap: close the old (elapsed clamped to the profile '
  'cap), open the new with the same pair-snapshot. Wallet+allowance balance owned by the route.';

COMMIT;
