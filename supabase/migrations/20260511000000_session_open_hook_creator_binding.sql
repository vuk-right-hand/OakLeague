-- 20260511000000 — session_open + session_rollover hook↔creator binding
--
-- Privacy fix (R3 audit C1). Pre-fix, both RPCs trusted p_creator_id and
-- p_hook_id independently — a request {creator_id: A, hook_id: <of_B>}
-- inserted a sessions row binding hook B to creator A, which then leaked
-- creator A's sample_content into a session whose UI context shows creator
-- B (when the brain wire-up lands). The brain plan amplifies the impact;
-- the leak exists today.
--
-- Fix: enforce hook → video → creator_id == p_creator_id inside both RPCs
-- at the top, before any INSERT/UPDATE. Routes also pre-validate so the
-- error surfaces as a typed 400 before the RPC is reached, but the DB
-- check is the correctness wall.
--
-- Companion test: supabase/tests/session_open_hook_creator_mismatch_rejected.test.sql
--
-- Note on draft videos: this binding check intentionally does NOT require
-- v.published_at IS NOT NULL. Creator preview flows (and admin testing
-- against unpublished hooks) rely on opening sessions against draft
-- content. Publish-state filtering happens at the feed/discovery layer,
-- not at session-open. (R-PR1 audit C2 — explicit decision.)
--
-- ACLs: original 20260502000002 declared REVOKE/GRANT after each function.
-- CREATE OR REPLACE preserves the existing proacl, but we re-emit the
-- ACL block here to keep the contract visible in the file that owns the
-- function definition (defense-in-depth + survives CI rebuilds from
-- migrations alone). (R-PR1 audit C1.)

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

  -- R3 audit C1: cross-creator binding rejected. hook → video → creator_id
  -- must match p_creator_id. Without this, a user could pass any hook with
  -- any creator and brain-prefix would seed the wrong creator's content.
  IF NOT EXISTS (
    SELECT 1
      FROM public.hooks h
      JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = p_hook_id
       AND v.creator_id = p_creator_id
  ) THEN
    RAISE EXCEPTION 'hook_creator_mismatch' USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO public.sessions (user_id, creator_id, hook_id, model_used, tier_at_session, status, avatar_status)
    VALUES (v_user_id, p_creator_id, p_hook_id, p_model, 'free'::profile_tier, 'starting', 'pending')
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

  -- R3 audit C1: same binding check on rollover. Cross-creator rollover
  -- would create a NEW session row binding hook B to creator A.
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
  v_qdate := (v_old.started_at AT TIME ZONE v_tz)::date;

  v_limit_s := CASE v_inherit_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_elapsed    := GREATEST(EXTRACT(EPOCH FROM (now() - v_old.started_at))::int - v_old.paused_seconds_total, 0);
  v_old_active := LEAST(v_elapsed, v_limit_s);

  UPDATE public.sessions
     SET ended_at       = now(),
         status         = 'ended',
         end_reason     = 'gemini_15min_cap',
         active_seconds = v_old_active
   WHERE id = p_old_session_id;

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

  SELECT q.seconds_used INTO v_used_today
    FROM public.daily_quotas q
   WHERE q.user_id = v_caller AND q.quota_date = v_qdate;

  RETURN QUERY SELECT v_new_id, v_inherit_tier, GREATEST(v_limit_s - COALESCE(v_used_today, 0), 0);
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  TO authenticated, service_role;
