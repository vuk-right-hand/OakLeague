-- ─────────────────────────────────────────────────────────────────────────
-- session_rollover — restore the close-the-old-session contract (regression fix)
-- ─────────────────────────────────────────────────────────────────────────
--
-- REGRESSION (introduced 20260521000009, carried into 20260522000100):
-- That migration's stated intent was ONLY to snapshot corpus_version /
-- retrieval_version onto the new session row ("CREATE OR REPLACE preserves the
-- signatures + GRANTs"). But in rewriting the body it silently INVERTED the
-- old-session contract and DROPPED the close:
--
--   * original (20260502000002 / 20260511000000): the old session must still be
--     OPEN (ended_at IS NULL); rollover then CLOSES it (ended_at, status='ended',
--     end_reason, active_seconds), resolves open pauses, charges the elapsed
--     seconds, and opens the new session. `ended_at IS NOT NULL` → P0006 (a
--     second tab already closed it; refuse a duplicate rollover).
--   * 20260521000009 flipped this to `ended_at IS NULL → old_session_still_open`
--     (P0001) AND removed the `UPDATE sessions SET ended_at …` close + the
--     session_pauses resolution, and recomputed elapsed from ended_at.
--
-- The client triggers rollover from a ticker AT the 15-min Gemini cap and
-- OVERLAP-swaps the proxy WS (use-session-pipe.ts header step 9) — i.e. the
-- OLD session is still OPEN at rollover time, and /api/sessions/rollover
-- (route.ts) calls this RPC WITHOUT pre-closing it (session_close is only
-- called on the route's failure paths). So the inverted guard rejects EVERY
-- real rollover with old_session_still_open → paid-tier conversations get cut
-- off at 15 minutes. pgTAP session_open_hook_creator_mismatch_rejected test 4
-- (happy-path rollover) is the correct side and was failing on this.
--
-- THIS MIGRATION restores the original (proven) close-the-open-old-session body
-- and KEEPS the corpus_version_at_session + retrieval_version_at_session
-- snapshot that 20260521000009 / 20260522000100 legitimately added. No signature
-- or GRANT change (CREATE OR REPLACE; SECURITY DEFINER preserved).
--
-- Rollback: re-apply 20260522000100's body (re-introduces the regression — do
-- NOT, this is the fix).

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
  -- NOTE (deliberate, matches original 20260511000000): we do NOT assert
  -- v_old.creator_id = p_creator_id. The hook→video→creator binding check above
  -- proves (p_hook_id, p_creator_id) are mutually consistent; continuity of
  -- creator across the old→new boundary is not enforced here (client always
  -- passes the same creator). 20260522000100 had added that check; not carried,
  -- to stay byte-faithful to the proven original. (auditor Small)
  -- The old session must still be OPEN. ended_at IS NOT NULL ⇒ another tab
  -- already closed it; refuse a duplicate rollover (P0006).
  IF v_old.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  v_inherit_tier := v_old.tier_at_session;

  SELECT p.timezone INTO v_tz FROM public.profiles p WHERE p.id = v_caller;
  -- Charge against the OLD session's start day (its quota bucket), not today.
  v_qdate := (v_old.started_at AT TIME ZONE v_tz)::date;

  v_limit_s := CASE v_inherit_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  -- Live elapsed: now - start - paused, clamped to the tier ceiling.
  v_elapsed    := GREATEST(EXTRACT(EPOCH FROM (now() - v_old.started_at))::int - v_old.paused_seconds_total, 0);
  v_old_active := LEAST(v_elapsed, v_limit_s);

  -- CLOSE the old session (the load-bearing line the regression dropped).
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
  -- (The legitimate addition from 20260521000009 / 20260522000100 — kept.)
  SELECT current_corpus_version, retrieval_version
    INTO v_corpus_version, v_retrieval_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;
  IF v_corpus_version IS NULL THEN
    RAISE EXCEPTION 'creator_not_found' USING ERRCODE = '42501';
  END IF;
  -- column is NOT NULL DEFAULT 1 — defensive COALESCE dropped (S7).

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
