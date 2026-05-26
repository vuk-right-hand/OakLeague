-- DECOUPLED_BRAIN_PLAN P1-5.1b (audit gate #2 C1) — cogs_insert_brain_leg.
--
--  1. caller guard: no service_role JWT + no matching auth.uid() → 42501.
--  2. service_role + valid brain_deep_answer → exactly ONE gemini row,
--     units = in+out tokens, cost = in+out cost, metadata split correct.
--  3. brain_paraphrase in the SAME (session,turn) → a DISTINCT 2nd row
--     (distinct operation ⇒ no idempotency collision; both bill).
--  4. idempotency: re-call brain_deep_answer same (session,turn) → still
--     exactly ONE deep_answer row, cost NOT doubled (barge-retry safe).
--  5. invalid p_operation → 22023.
--  6. turn_number <= 0 → 22003.
--  7. cost out of range (> $10/leg) → 22003.
--
-- Fixture pattern = current-correct (create_auth_user → app → creator →
-- session; topics/proof NOT NULL since 20260420000010). The guard reads
-- the JWT claim `role`, NOT the DB role, so service_role is simulated by
-- set_config('request.jwt.claims', …) exactly as the RPC checks it.

BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('brainleg@test');
  v_creator uuid;
  v_session uuid;
  v_app     uuid;
  v_rows    int;
  v_units   numeric;
  v_cost    numeric;
  v_meta    jsonb;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'BrainLeg Creator', 'brainleg1', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'BrainLeg Creator', 'brainleg1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
  VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting')
  RETURNING id INTO v_session;

  -- 1: caller guard — no JWT (claims GUC unset ⇒ NULL), auth.uid() NULL.
  BEGIN
    PERFORM public.cogs_insert_brain_leg(
      v_user, v_session, 1, 'brain_deep_answer', 100, 200, 0.0001, 0.0005, 'dev');
    RETURN NEXT fail('1: unauthenticated call should have raised 42501');
  EXCEPTION
    WHEN SQLSTATE '42501' THEN RETURN NEXT pass('1: caller guard → 42501 when not service_role');
    WHEN OTHERS THEN RETURN NEXT fail('1: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- Simulate the proxy's service-role JWT (the guard checks the CLAIM,
  -- not the DB role).
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 2: happy brain_deep_answer.
  PERFORM public.cogs_insert_brain_leg(
    v_user, v_session, 1, 'brain_deep_answer', 1200, 90, 0.00036, 0.000225, 'production');
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session AND turn_number = 1
     AND service = 'gemini' AND operation = 'brain_deep_answer';
  SELECT units, cost_usd, metadata INTO v_units, v_cost, v_meta
    FROM public.cogs_log
   WHERE session_id = v_session AND turn_number = 1
     AND service = 'gemini' AND operation = 'brain_deep_answer'
   LIMIT 1;
  RETURN NEXT ok(
    v_rows = 1
      AND v_units = 1290                              -- 1200 + 90
      AND v_cost  = 0.000585                          -- 0.00036 + 0.000225
      AND (v_meta ->> 'pipeline') = 'decoupled_brain'
      AND (v_meta ->> 'input_tokens')::int  = 1200
      AND (v_meta ->> 'output_tokens')::int = 90
      AND (v_meta ->> 'billed_partial')::bool = false,
    '2: brain_deep_answer → 1 row, summed units/cost, metadata split'
  );

  -- 3: brain_paraphrase, SAME session+turn → distinct 2nd row.
  PERFORM public.cogs_insert_brain_leg(
    v_user, v_session, 1, 'brain_paraphrase', 140, 18, 0.000042, 0.000045, 'production', true);
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session AND turn_number = 1 AND service = 'gemini';
  RETURN NEXT ok(
    v_rows = 2
      AND (SELECT (metadata ->> 'billed_partial')::bool
             FROM public.cogs_log
            WHERE session_id = v_session AND turn_number = 1
              AND operation = 'brain_paraphrase') = true,
    '3: brain_paraphrase same turn → distinct 2nd row, billed_partial flag honored'
  );

  -- 4: idempotency — re-call brain_deep_answer same (session,turn).
  PERFORM public.cogs_insert_brain_leg(
    v_user, v_session, 1, 'brain_deep_answer', 9999, 9999, 9.9, 9.9, 'production');
  SELECT count(*), max(cost_usd) INTO v_rows, v_cost
    FROM public.cogs_log
   WHERE session_id = v_session AND turn_number = 1
     AND service = 'gemini' AND operation = 'brain_deep_answer';
  RETURN NEXT ok(
    v_rows = 1 AND v_cost = 0.000585,
    '4: idempotent — re-call is DO NOTHING, cost NOT doubled (barge-retry safe)'
  );

  -- 5: invalid operation → 22023.
  BEGIN
    PERFORM public.cogs_insert_brain_leg(
      v_user, v_session, 2, 'brain_freestyle', 1, 1, 0, 0, 'production');
    RETURN NEXT fail('5: invalid operation should have raised 22023');
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN NEXT pass('5: invalid p_operation → 22023');
    WHEN OTHERS THEN RETURN NEXT fail('5: expected 22023, got ' || SQLSTATE);
  END;

  -- 6: turn_number <= 0 → 22003.
  BEGIN
    PERFORM public.cogs_insert_brain_leg(
      v_user, v_session, 0, 'brain_deep_answer', 1, 1, 0, 0, 'production');
    RETURN NEXT fail('6: turn_number 0 should have raised 22003');
  EXCEPTION
    WHEN SQLSTATE '22003' THEN RETURN NEXT pass('6: turn_number <= 0 → 22003');
    WHEN OTHERS THEN RETURN NEXT fail('6: expected 22003, got ' || SQLSTATE);
  END;

  -- 7: cost out of range (> $10) → 22003 (decimal-place-bug guard).
  BEGIN
    PERFORM public.cogs_insert_brain_leg(
      v_user, v_session, 3, 'brain_deep_answer', 1, 1, 11, 0, 'production');
    RETURN NEXT fail('7: input_cost 11 should have raised 22003');
  EXCEPTION
    WHEN SQLSTATE '22003' THEN RETURN NEXT pass('7: cost > $10/leg → 22003');
    WHEN OTHERS THEN RETURN NEXT fail('7: expected 22003, got ' || SQLSTATE);
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
