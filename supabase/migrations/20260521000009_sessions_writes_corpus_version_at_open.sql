-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — final ship-readiness audit C1
-- session_open + session_rollover must WRITE corpus_version_at_session
-- ─────────────────────────────────────────────────────────────────────────
--
-- MIG-6 added `sessions.corpus_version_at_session int NOT NULL DEFAULT 1`.
-- MIG-7 backfilled existing OPEN sessions. But the two RPCs that CREATE
-- new sessions (`session_open` from 20260511000000 and `session_rollover`
-- from the same file) still INSERT without supplying the column. Every
-- new session pins to DEFAULT 1 regardless of the creator's actual
-- current_corpus_version.
--
-- Consequence chain for ANY creator past version 1:
--   * session-open snapshot = 1
--   * Day-13 proxy reads `1` as the closure const
--   * semantic_query_cache_lookup filters corpus_version = 1 → permanent miss
--   * semantic_query_cache_upsert's FOR SHARE check vs current_corpus_version = N
--     rejects with NULL → orchestrator marks cacheStaleCorpus=true on EVERY turn
--   * Cache effectively disabled for any creator who has reprocessed.
--
-- This migration replaces both RPCs to snapshot creators.current_corpus_version
-- at INSERT time with FOR SHARE row lock (matches the pattern in MIG-3's
-- upsert RPC). CREATE OR REPLACE preserves the signatures + GRANTs from
-- the original 20260511000000 migration.

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

  -- Phase-2 ship audit C1: snapshot the creator's current corpus_version
  -- at session-open. FOR SHARE locks the creators row against a concurrent
  -- corpus_reprocess_finalize bump landing between this SELECT and the
  -- session INSERT. Without this lock the snapshot could be from one side
  -- of the finalize while subsequent cache writes use the other.
  SELECT current_corpus_version
    INTO v_corpus_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;
  IF v_corpus_version IS NULL THEN
    -- Creator was deleted or never existed. Same path as the existing
    -- session_open behavior pre-Phase-2: subsequent CHECK fails with FK.
    -- Make the failure mode explicit and uniform.
    RAISE EXCEPTION 'creator_not_found' USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO public.sessions (
      user_id, creator_id, hook_id, model_used, tier_at_session,
      status, avatar_status, corpus_version_at_session
    )
    VALUES (
      v_user_id, p_creator_id, p_hook_id, p_model, 'free'::profile_tier,
      'starting', 'pending', v_corpus_version
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
  v_caller         uuid;
  v_old            public.sessions%ROWTYPE;
  v_inherit_tier   profile_tier;
  v_tz             text;
  v_qdate          date;
  v_limit_s        int;
  v_elapsed        int;
  v_old_active     int;
  v_new_id         uuid;
  v_used_today     int;
  v_corpus_version int;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_old FROM public.sessions WHERE id = p_old_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'old_session_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.user_id <> v_caller THEN
    RAISE EXCEPTION 'old_session_not_caller' USING ERRCODE = '42501';
  END IF;
  IF v_old.creator_id <> p_creator_id THEN
    RAISE EXCEPTION 'old_session_creator_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_old.ended_at IS NULL THEN
    RAISE EXCEPTION 'old_session_still_open' USING ERRCODE = 'P0001';
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

  v_inherit_tier := v_old.tier_at_session;
  v_elapsed := COALESCE(
    EXTRACT(EPOCH FROM (v_old.ended_at - v_old.started_at))::int,
    0
  );
  v_old_active := GREATEST(0, v_elapsed);

  SELECT p.timezone INTO v_tz
    FROM public.profiles p
   WHERE p.id = v_caller;
  v_qdate := (now() AT TIME ZONE v_tz)::date;

  v_limit_s := CASE v_inherit_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

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

  -- Phase-2 ship audit C1: snapshot current corpus_version for the new
  -- (rollover) session — same FOR SHARE pattern as session_open above.
  SELECT current_corpus_version
    INTO v_corpus_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;
  IF v_corpus_version IS NULL THEN
    RAISE EXCEPTION 'creator_not_found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.sessions (
    user_id, creator_id, hook_id, model_used, tier_at_session,
    status, avatar_status, metadata, corpus_version_at_session
  )
  VALUES (
    v_caller, p_creator_id, p_hook_id, p_model, v_inherit_tier,
    'starting', 'pending',
    jsonb_build_object('rollover', true, 'prev_session_id', p_old_session_id),
    v_corpus_version
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
  'Open a new voice session. Phase-2: snapshots creators.current_corpus_version into sessions.corpus_version_at_session under FOR SHARE row lock so the closure-capture contract for retrieval_version=2 actually holds.';

COMMENT ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model) IS
  'Open a rollover voice session after the previous one ended. Phase-2: same corpus_version snapshot semantics as session_open.';
