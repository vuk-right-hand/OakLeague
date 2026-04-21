-- 0005 — service-role caller guards on voice RPCs + fatal P0002 on missing quota row
--
-- Pre-apply audit (Round 3) surfaced three issues that survived 0004:
--
-- B1. voice_check_quota silently returned {0, 0, null, false} when
--     daily_quotas had no row. The proxy read that as "not over" and allowed
--     the first turn. The session then burned Gemini cost before turn_end
--     raised P0002 on voice_accumulate_seconds. Worse: the "healthy" sentinel
--     poisoned the proxy's quotaCache, so a later degraded-RPC window also
--     passed. Symmetry fix: NOT FOUND must raise the same P0002 that
--     voice_accumulate_seconds raises, so the proxy tears down (WS close 4006)
--     before any audio flows.
--
-- B2. cogs_insert_turn's caller guard was "authenticated may self-attribute."
--     But p_input_cost / p_output_cost are client-supplied, and cogs_log is
--     append-only (no UPDATE trigger). If EXECUTE ever leaks, a logged-in
--     user can spray arbitrary cost rows attributed to themselves and
--     permanently skew COGS analytics before a demo. Flip to unconditional
--     deny for non-service-role — REVOKE is still the primary defense, but
--     the guard now refuses to help even if someone re-GRANTs later.
--
-- B3. voice_accumulate_seconds and voice_check_quota had NO caller-identity
--     guard at all. If EXECUTE leaked to authenticated, any logged-in user
--     could call voice_accumulate_seconds(<victim_session_id>, 3600) and
--     latch the victim's kill-switch. Add the same service-role-only gate.
--
-- Migration policy: 0003 and 0004 are edited here via CREATE OR REPLACE
-- (preserves grants; REVOKEs from 0004 still apply). No in-place edits.

-- ── voice_check_quota: fatal NOT FOUND + service-role guard ─────────────────

CREATE OR REPLACE FUNCTION public.voice_check_quota(p_session_id uuid)
RETURNS TABLE (
  seconds_used          int,
  daily_limit_s         int,
  kill_switch_fired_at  timestamptz,
  over_150_pct          boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role   text;
  v_user_id    uuid;
  v_started_at timestamptz;
  v_tz         text;
  v_qdate      date;
  v_row        record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_check_quota: non-service-role caller'
      USING ERRCODE = '42501';
  END IF;

  SELECT s.user_id, s.started_at, p.timezone
    INTO v_user_id, v_started_at, v_tz
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = p_session_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE = '23503';
  END IF;

  v_qdate := (v_started_at AT TIME ZONE v_tz)::date;

  SELECT q.seconds_used, q.daily_limit_s, q.kill_switch_fired_at
    INTO v_row
    FROM public.daily_quotas q
   WHERE q.user_id = v_user_id AND q.quota_date = v_qdate;

  -- B1 fix: no defensive "return zero row" branch. sessions_enforce_tier_and_
  -- kill_switch (0017) upserts daily_quotas at session-insert time; a missing
  -- row here means an admin wiped it or the trigger regressed. Either way the
  -- caller must treat it as fatal (WS close 4006), not silently permit a turn.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no daily_quotas row for user=% date=% (session insert trigger should have created it)',
      v_user_id, v_qdate USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY SELECT
    v_row.seconds_used,
    v_row.daily_limit_s,
    v_row.kill_switch_fired_at,
    (v_row.seconds_used >= (v_row.daily_limit_s * 3) / 2);
END;$$;

-- ── voice_accumulate_seconds: add service-role guard ───────────────────────

CREATE OR REPLACE FUNCTION public.voice_accumulate_seconds(
  p_session_id uuid,
  p_seconds    numeric
) RETURNS TABLE (
  seconds_used          int,
  daily_limit_s         int,
  kill_switch_fired_at  timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role   text;
  v_user_id    uuid;
  v_started_at timestamptz;
  v_tz         text;
  v_qdate      date;
  v_row        record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_accumulate_seconds: non-service-role caller'
      USING ERRCODE = '42501';
  END IF;

  IF p_seconds < 0 OR p_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds out of range [0,3600]' USING ERRCODE = '22003';
  END IF;

  SELECT s.user_id, s.started_at, p.timezone
    INTO v_user_id, v_started_at, v_tz
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = p_session_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE = '23503';
  END IF;

  v_qdate := (v_started_at AT TIME ZONE v_tz)::date;

  UPDATE public.daily_quotas q
     SET seconds_used = q.seconds_used + CEIL(p_seconds)::int
   WHERE q.user_id = v_user_id AND q.quota_date = v_qdate
  RETURNING q.seconds_used, q.daily_limit_s, q.kill_switch_fired_at
    INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no daily_quotas row for user=% date=% (session insert trigger should have created it)',
      v_user_id, v_qdate USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY SELECT v_row.seconds_used, v_row.daily_limit_s, v_row.kill_switch_fired_at;
END;$$;

-- ── cogs_insert_turn: flip non-service-role to unconditional deny ──────────

CREATE OR REPLACE FUNCTION public.cogs_insert_turn(
  p_user_id        uuid,
  p_session_id     uuid,
  p_service        cogs_service,
  p_model          text,
  p_input_seconds  numeric,
  p_output_seconds numeric,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_metadata       jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (input_row_id bigint, output_row_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_input_id  bigint;
  v_output_id bigint;
  v_jwt_role  text;
BEGIN
  -- B2 fix: cost fields are client-supplied and cogs_log is append-only. Even
  -- self-attributed writes let a leaked-EXECUTE caller skew COGS dashboards
  -- permanently. Only service_role may call; REVOKE is first line of defense,
  -- this guard is the second.
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'cogs_insert_turn: non-service-role caller'
      USING ERRCODE = '42501';
  END IF;

  IF p_environment NOT IN ('production', 'spike_a', 'spike_b', 'dev') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment USING ERRCODE = '22023';
  END IF;
  IF p_input_seconds < 0 OR p_output_seconds < 0 THEN
    RAISE EXCEPTION 'negative seconds' USING ERRCODE = '22003';
  END IF;
  IF p_input_seconds > 3600 OR p_output_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds exceed per-turn cap (3600)' USING ERRCODE = '22003';
  END IF;

  INSERT INTO public.cogs_log (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES (p_user_id, p_session_id, p_service, 'voice_audio_input_seconds',
          p_input_seconds, 'seconds', p_input_cost, p_environment,
          p_metadata || jsonb_build_object('model', p_model, 'direction', 'input'))
  RETURNING id INTO v_input_id;

  INSERT INTO public.cogs_log (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES (p_user_id, p_session_id, p_service, 'voice_audio_output_seconds',
          p_output_seconds, 'seconds', p_output_cost, p_environment,
          p_metadata || jsonb_build_object('model', p_model, 'direction', 'output'))
  RETURNING id INTO v_output_id;

  RETURN QUERY SELECT v_input_id, v_output_id;
END;$$;

-- CREATE OR REPLACE preserves grants, so the REVOKEs from 0004 still hold.
-- Re-REVOKE here anyway for belt-and-braces clarity; idempotent.

REVOKE EXECUTE ON FUNCTION public.voice_check_quota(uuid)
  FROM public, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.voice_accumulate_seconds(uuid, numeric)
  FROM public, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn(uuid, uuid, cogs_service, text, numeric, numeric, numeric, numeric, text, jsonb)
  FROM public, anon, authenticated;
