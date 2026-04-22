-- Day 13–14 plan REV 5, migration 3 of 5.
-- Avatar per-turn COGS RPC with 60s grace window on closed sessions.
--
-- Audit refs:
--   R2-M1 — route must not service-role-INSERT into cogs_log directly in prod;
--           RPC enforces caller-identity the same way cogs_insert_turn does.
--   R3-C4 — in-flight avatar turn may arrive AFTER session_close has set
--           ended_at. Grace window matches reap_stale_sessions's 60s default
--           so the final trailing frame is not rejected as "dead session."

CREATE FUNCTION public.cogs_insert_avatar_turn(
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
  IF p_provider NOT IN ('simli', 'tavus') THEN
    RAISE EXCEPTION 'invalid_provider_for_avatar_turn: %', p_provider USING ERRCODE = '22023';
  END IF;

  IF p_duration_s IS NULL OR p_duration_s <= 0 OR p_duration_s > 60 THEN
    RAISE EXCEPTION 'duration_out_of_bounds [0,60]' USING ERRCODE = '22003';
  END IF;

  -- Ceiling rate per-minute, mirroring migration 0042-era bounds:
  --   simli Trinity-1  ≈ $0.01/min (dev pricing, conservative 2× cap)
  --   tavus Phoenix-4  ≈ $0.32/min
  -- Ceilings are 2× published to absorb provider tier creep without breaking
  -- writes. If a row is rejected here, we want to know at the call site.
  v_cost_cap := (p_duration_s / 60.0) * (CASE p_provider
    WHEN 'simli' THEN 0.05
    WHEN 'tavus' THEN 1.00
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

  -- Grace window (R3-C4): accept turns up to 60s after ended_at so the
  -- final in-flight frame after session_close is not rejected. Matches
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

REVOKE EXECUTE ON FUNCTION public.cogs_insert_avatar_turn(uuid, cogs_service, numeric, numeric, jsonb)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.cogs_insert_avatar_turn(uuid, cogs_service, numeric, numeric, jsonb)
  TO authenticated, service_role;
