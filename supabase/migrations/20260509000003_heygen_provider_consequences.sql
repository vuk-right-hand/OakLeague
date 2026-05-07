-- 20260509000003 — heygen provider consequences (CHECK + function)
--
-- HeyGen wireup, migration 3 of 4. Drops + recreates the dependent objects
-- that hardcode 'simli' / 'tavus' as the only allowed avatar providers,
-- now that 20260509000002 has added 'heygen' to the cogs_service enum.
--
-- This migration MUST run after 20260509000002 (Postgres requires the
-- enum's new value to be committed before functions / CHECKs that reference
-- it are parsed and applied). Supabase per-file commit ordering guarantees
-- this — see comment block in the prior migration.
--
-- Audit round 1 / C2:
--   1. spike_b_runs.provider CHECK constraint (auto-named
--      `spike_b_runs_provider_check`) hardcodes IN ('simli','tavus') —
--      drop + readd with 'heygen'.
--   2. cogs_insert_avatar_turn() function body raises EXCEPTION when
--      p_provider NOT IN ('simli','tavus') (migration 20260502000003:29) —
--      replace with heygen included + add ceiling rate per Phase 0 §14.
--
-- Heygen ceiling rate: $0.10/min Lite (Phase 0 §14). 2× cap = $0.20/min,
-- mirroring the 2× headroom posture used for Simli ($0.025 ceiling vs
-- $0.01 published) and Tavus ($1.00 ceiling vs $0.32 published).
-- Companion test: supabase/tests/heygen_provider_consequences.test.sql

-- 1. spike_b_runs.provider CHECK ---------------------------------------------

ALTER TABLE public.spike_b_runs
  DROP CONSTRAINT spike_b_runs_provider_check;

ALTER TABLE public.spike_b_runs
  ADD CONSTRAINT spike_b_runs_provider_check
  CHECK (provider IN ('simli', 'tavus', 'heygen'));

-- 2. cogs_insert_avatar_turn — REPLACE with heygen branch --------------------

CREATE OR REPLACE FUNCTION public.cogs_insert_avatar_turn(
  p_session_id uuid,
  p_provider   cogs_service,
  p_duration_s numeric,
  p_cost_usd   numeric,
  p_metadata   jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller     uuid;
  v_is_service boolean;
  v_owner      uuid;
  v_ended_at   timestamptz;
  v_cost_cap   numeric;
  v_row_id     bigint;
BEGIN
  -- Avatar providers only. cogs_service also covers gemini/cartesia/mux/etc —
  -- wrong service on this RPC is a bug.
  IF p_provider NOT IN ('simli', 'tavus', 'heygen') THEN
    RAISE EXCEPTION 'invalid_provider_for_avatar_turn: %', p_provider USING ERRCODE = '22023';
  END IF;

  IF p_duration_s IS NULL OR p_duration_s <= 0 OR p_duration_s > 60 THEN
    RAISE EXCEPTION 'duration_out_of_bounds [0,60]' USING ERRCODE = '22003';
  END IF;

  -- Ceiling rate per-minute. 2× published to absorb provider tier creep.
  --   simli Trinity-1     ≈ $0.01/min published, $0.025 cap before reuse here
  --   tavus Phoenix-4     ≈ $0.32/min published, $1.00 cap (legacy)
  --   heygen LiveAvatar Lite ≈ $0.10/min published (Phase 0 §14), $0.20 cap
  v_cost_cap := (p_duration_s / 60.0) * (CASE p_provider
    WHEN 'simli'  THEN 0.05
    WHEN 'tavus'  THEN 1.00
    WHEN 'heygen' THEN 0.20
  END);

  IF p_cost_usd IS NULL OR p_cost_usd < 0 OR p_cost_usd > v_cost_cap THEN
    RAISE EXCEPTION 'cost_out_of_bounds; cap=%, got=%', v_cost_cap, p_cost_usd
      USING ERRCODE = '22003';
  END IF;

  v_caller := auth.uid();
  v_is_service := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';

  SELECT s.user_id, s.ended_at INTO v_owner, v_ended_at
    FROM public.sessions s WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  IF NOT v_is_service AND v_owner <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  -- Grace window: accept turns up to 60s after ended_at so the final
  -- in-flight frame after session_close is not rejected. Matches
  -- reap_stale_sessions default threshold.
  IF v_ended_at IS NOT NULL AND v_ended_at < now() - interval '60 seconds' THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  INSERT INTO public.cogs_log (
    user_id, session_id, service, operation, units, unit_label,
    cost_usd, environment, metadata
  )
  VALUES (
    v_owner, p_session_id, p_provider, 'avatar_lipsync_seconds',
    p_duration_s, 'seconds',
    p_cost_usd, 'production',
    p_metadata
  )
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;$$;

-- Permissions: same posture as the original definition.
REVOKE EXECUTE ON FUNCTION public.cogs_insert_avatar_turn(uuid, cogs_service, numeric, numeric, jsonb)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.cogs_insert_avatar_turn(uuid, cogs_service, numeric, numeric, jsonb)
  TO authenticated, service_role;
