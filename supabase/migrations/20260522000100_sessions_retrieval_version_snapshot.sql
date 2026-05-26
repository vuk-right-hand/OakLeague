-- ─────────────────────────────────────────────────────────────────────────
-- Day-13 audit C1 — sessions.retrieval_version_at_session snapshot
-- ─────────────────────────────────────────────────────────────────────────
--
-- Phase 2 added per-creator `creators.retrieval_version` (migration
-- 20260514000001) as the v1↔v2 switch. Day-13 wires the Fly proxy to
-- branch on this value at session-open. WITHOUT a snapshot column the
-- proxy would have to read it live per WS-open → an admin v1→v2 flip
-- mid-ticket (≤120s TTL) silently breaks the session: ticket minted at
-- v1 against drawer-flow chunks, proxy reads live as v2, orchestrator
-- queries v2 narrative_units that may not exist for that creator yet.
-- Mirror failure on v2→v1 rollback.
--
-- The fix mirrors MIG-9's corpus_version_at_session pattern: snapshot
-- creators.retrieval_version into sessions at session_open / session_
-- rollover under the SAME FOR SHARE row lock already in place. Proxy
-- reads sessions.retrieval_version_at_session in attachToSession() and
-- treats it as a closure const for the WS lifetime. Mid-session admin
-- flips never affect already-open sessions; new sessions opened after
-- the flip get the new value.
--
-- This migration does NOT add a column to voice_tickets. The ticket
-- consume path runs BEFORE attachToSession() in the proxy, but the
-- proxy reads BOTH (ticket then session) before opening the Gemini WS
-- — so the SELECT from sessions arrives in time. Single source of truth
-- = sessions row; no new trigger; no double-snapshot drift risk.
--
-- The legacy admin spike-a path (proxy's openSession() in JS) explicitly
-- hard-pins retrieval_version_at_session=1 on INSERT. If admin runs
-- spike-a against a creator that's already on retrieval_version=2, the
-- session opens but v1 retrieveTopK returns ZERO matching chunks
-- (chunker_version=1 chunks may not exist after v2 reprocess) — admin
-- sees silent zero retrieval, NOT a security issue. Audit-build M4
-- adds a warning probe in openSession() that surfaces this when it
-- occurs.
--
-- BACKFILL: not required. Day-13 cold-deploys with ALL creators at
-- retrieval_version=1 per RAG_SOTA_PLAN.md §10 Day-13 line 796. Existing
-- OPEN sessions correctly snapshot DEFAULT 1. The first v2 creator
-- flip happens on Day-15 (Vuk dogfood) — at which point all NEW sessions
-- correctly snapshot to 2, and any session OPEN during the flip stays
-- at 1 by snapshot semantics, which is correct.

-- ─── 1. Column on sessions ───────────────────────────────────────────────

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS retrieval_version_at_session smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.sessions.retrieval_version_at_session IS
  'Snapshot of creators.retrieval_version captured at session_open / '
  'session_rollover under FOR SHARE row lock. Day-13: proxy reads this '
  'in attachToSession() and uses it to route per-turn retrieval (v1 '
  'legacy retrieveTopK vs v2 retrieveKnowledgeV2 shim). NEVER updated '
  'after INSERT — admin flips on creators.retrieval_version do not '
  'affect already-open sessions (snapshot-at-session-open contract).';

-- CHECK constraint: retrieval_version is currently 1 or 2 (smallint enum).
-- Defensive — a future v3 flip requires both updating the column constraint
-- AND the proxy's branching logic; this raises a loud signal.
ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_retrieval_version_at_session_chk;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_retrieval_version_at_session_chk
    CHECK (retrieval_version_at_session IN (1, 2));

-- ─── 2. Patch session_open to snapshot retrieval_version ─────────────────

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
  -- Day-13 audit C1: snapshot retrieval_version in the SAME row lock so
  -- the two values cannot disagree (e.g. corpus advances + retrieval
  -- version flips in the same admin txn — the proxy would otherwise
  -- read corpus_version=2 with retrieval_version=1, querying v2 chunks
  -- through v1's legacy retrieveTopK which filters chunker_version=1).
  SELECT current_corpus_version, retrieval_version
    INTO v_corpus_version, v_retrieval_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;
  IF v_corpus_version IS NULL THEN
    RAISE EXCEPTION 'creator_not_found' USING ERRCODE = '42501';
  END IF;
  -- column is NOT NULL DEFAULT 1 per 20260514000001 — defensive COALESCE
  -- dropped (audit-build S7).

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

-- ─── 3. Patch session_rollover same pattern ──────────────────────────────

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

  -- Day-13 audit C1: same pair-snapshot under FOR SHARE as session_open.
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

REVOKE EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.session_open(uuid, uuid, voice_model) IS
  'Open a new voice session. Phase-2 + Day-13: snapshots both '
  'creators.current_corpus_version → sessions.corpus_version_at_session '
  'AND creators.retrieval_version → sessions.retrieval_version_at_session '
  'in the same FOR SHARE row lock so the two snapshots can never disagree.';

COMMENT ON FUNCTION public.session_rollover(uuid, uuid, uuid, voice_model) IS
  'Open a rollover voice session after the previous one ended. Same '
  'pair-snapshot semantics as session_open.';
