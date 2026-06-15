-- MEMORY_BREADTH_PLAN Unit 1b (audit R2-C3) — the memory_extract COGS leg
-- must be proven END-TO-END through the RPC, not by an index probe: the
-- round-2 audit caught that the partial unique index tolerates any positive
-- turn_number while the function's own `<= 0` guard rejected the originally
-- planned sentinel 0. These tests call the real RPC with the real sentinel.
--
--  1. service_role + memory_extract + sentinel 2147483647 → exactly ONE
--     cogs_log row, pipeline = 'memory_extract' (NOT decoupled_brain).
--  2. duplicate fire (same session) → ON CONFLICT DO NOTHING, still one row,
--     cost not doubled.
--  3. memory_extract with turn_number 0 → 22003 (the guard is KEPT; the
--     sentinel is how the proxy complies — regression-pin so a future edit
--     doesn't silently relax it).

BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user     uuid := tests.create_auth_user('memextract@test');
  v_creator  uuid;
  v_app      uuid;
  v_session  uuid;
  v_rows     int;
  v_cost     numeric;
  v_meta     jsonb;
  c_sentinel int := 2147483647; -- MEMORY_EXTRACT_TURN_SENTINEL (proxy constant)
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'MemX Creator', 'memx1', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'MemX Creator', 'memx1', 'ready', 'vector')
  RETURNING id INTO v_creator;
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
  VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting')
  RETURNING id INTO v_session;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1: end-to-end insert with the sentinel.
  PERFORM public.cogs_insert_brain_leg(
    v_user, v_session, c_sentinel, 'memory_extract',
    2500, 120, 0.00075, 0.0003, 'production');
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session AND operation = 'memory_extract';
  SELECT cost_usd, metadata INTO v_cost, v_meta
    FROM public.cogs_log
   WHERE session_id = v_session AND operation = 'memory_extract'
   LIMIT 1;
  RETURN NEXT ok(
    v_rows = 1
      AND v_cost = 0.00105
      AND (v_meta ->> 'pipeline') = 'memory_extract'
      AND (v_meta ->> 'input_tokens')::int = 2500,
    '1: memory_extract leg lands end-to-end with sentinel turn_number'
  );

  -- 2: duplicate fire → idempotent (unique on session+turn+service+operation).
  PERFORM public.cogs_insert_brain_leg(
    v_user, v_session, c_sentinel, 'memory_extract',
    9999, 9999, 5, 5, 'production');
  SELECT count(*), max(cost_usd) INTO v_rows, v_cost
    FROM public.cogs_log
   WHERE session_id = v_session AND operation = 'memory_extract';
  RETURN NEXT ok(
    v_rows = 1 AND v_cost = 0.00105,
    '2: duplicate memory_extract fire is DO NOTHING — cost not doubled'
  );

  -- 3: the positive-turn guard is KEPT (sentinel compliance, not relaxation).
  BEGIN
    PERFORM public.cogs_insert_brain_leg(
      v_user, v_session, 0, 'memory_extract', 1, 1, 0, 0, 'production');
    RETURN NEXT fail('3: turn_number 0 should still raise 22003');
  EXCEPTION
    WHEN SQLSTATE '22003' THEN RETURN NEXT pass('3: turn_number <= 0 still rejected (22003)');
    WHEN OTHERS THEN RETURN NEXT fail('3: expected 22003, got ' || SQLSTATE);
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
