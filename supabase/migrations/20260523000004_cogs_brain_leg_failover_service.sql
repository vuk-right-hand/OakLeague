-- 20260523000004 — DECOUPLED_BRAIN_PLAN Step 2 (Gemini→Haiku failover),
-- audit gate finding C1: cogs_insert_brain_leg must attribute the Haiku
-- failover spend correctly AND never collide with the Gemini leg.
--
-- WHY (the silent-billing hole):
-- 20260522000103 created cogs_insert_brain_leg with service HARDCODED to
-- 'gemini' and ON CONFLICT (session_id, turn_number, service, operation)
-- DO NOTHING. The Step-2 failover writes a SECOND deep-answer leg for the
-- same turn when Gemini 503s and Claude Haiku carries the answer. Written
-- under the old contract that leg would be service='gemini' +
-- operation='brain_deep_answer' — IDENTICAL key to any Gemini partial leg
-- for the same turn → ON CONFLICT DO NOTHING → the real Haiku spend is
-- SILENTLY DROPPED and the 150%-of-quota kill-switch never sees it.
--
-- FIX (two independent guards, both applied):
--   1. New trailing param `p_service cogs_service DEFAULT 'gemini'` so the
--      Haiku leg writes under service='anthropic' (the enum value already
--      exists — 20260517000002). Correct provider attribution ("production
--      from line one"): COGS-by-provider stays honest.
--   2. New operation value 'brain_deep_answer_failover'. Distinct from
--      'brain_deep_answer' so the failover leg can never share a unique
--      slot with the primary Gemini leg even if a future caller mis-sets
--      the service. Belt-and-suspenders on top of guard 1.
--
-- p_service is GUARDED to ('gemini','anthropic') — brain legs are only ever
-- these two providers; anything else is a caller bug, fail loud (22023).
--
-- DROP + CREATE because Postgres won't change a function's parameter list.
-- The trailing DEFAULT keeps the 11-arg call site (proxy-handlers logBrainLeg
-- pre-Step-2) working unchanged: it omits p_service → 'gemini', exactly the
-- old behavior. Step-2's logBrainLeg passes p_service explicitly.
--
-- Everything else (caller guard, SECURITY DEFINER, REVOKE, env+range guards,
-- idempotency index reuse, append-only) is preserved verbatim from
-- 20260522000103. Migration number 000004: after 000003 (already in prod),
-- collision-safe vs Hume 20260522000001 (NEVER rename).

DROP FUNCTION IF EXISTS public.cogs_insert_brain_leg(
  uuid, uuid, int, text, int, int, numeric, numeric, text, boolean, jsonb
);

CREATE FUNCTION public.cogs_insert_brain_leg(
  p_user_id        uuid,
  p_session_id     uuid,
  p_turn_number    int,
  p_operation      text,    -- 'brain_deep_answer' | 'brain_paraphrase' | 'brain_deep_answer_failover'
  p_input_tokens   int,
  p_output_tokens  int,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_billed_partial boolean DEFAULT false,
  p_metadata       jsonb DEFAULT '{}'::jsonb,
  -- Step-2 audit C1: provider attribution. Trailing DEFAULT keeps the
  -- pre-Step-2 11-arg call site working (omit → 'gemini').
  p_service        cogs_service DEFAULT 'gemini'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  -- Caller guard: service_role bypass, else user must match p_user_id.
  -- Mirrors cogs_insert_turn_voice_v2 (0043 + 0051 + 20260520000003).
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot insert brain leg for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Step-2: 'brain_deep_answer_failover' is the Haiku failover leg.
  IF p_operation NOT IN ('brain_deep_answer', 'brain_paraphrase', 'brain_deep_answer_failover') THEN
    RAISE EXCEPTION 'p_operation must be brain_deep_answer, brain_paraphrase or brain_deep_answer_failover (got %)', p_operation
      USING ERRCODE = '22023';
  END IF;
  -- Step-2 audit C1: brain legs are only ever gemini (primary) or anthropic
  -- (Haiku failover). Anything else is a caller bug — fail loud, never
  -- mis-attribute COGS to an unrelated service.
  IF p_service NOT IN ('gemini', 'anthropic') THEN
    RAISE EXCEPTION 'p_service must be gemini or anthropic for brain legs (got %)', p_service
      USING ERRCODE = '22023';
  END IF;
  IF p_environment NOT IN ('production', 'spike_a', 'spike_b', 'dev') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment USING ERRCODE = '22023';
  END IF;
  IF p_turn_number IS NULL OR p_turn_number <= 0 THEN
    RAISE EXCEPTION 'turn_number must be positive' USING ERRCODE = '22003';
  END IF;

  -- Range guards — mirror cogs_insert_turn_voice_v2: tokens ≤ 200000,
  -- cost ≤ $10/leg catches a decimal-place bug before it writes $1,000.
  IF p_input_tokens  IS NULL OR p_input_tokens  < 0 OR p_input_tokens  > 200000 THEN RAISE EXCEPTION 'brain input_tokens oob'  USING ERRCODE = '22003'; END IF;
  IF p_output_tokens IS NULL OR p_output_tokens < 0 OR p_output_tokens > 200000 THEN RAISE EXCEPTION 'brain output_tokens oob' USING ERRCODE = '22003'; END IF;
  IF p_input_cost    IS NULL OR p_input_cost    < 0 OR p_input_cost    > 10     THEN RAISE EXCEPTION 'brain input_cost oob'    USING ERRCODE = '22003'; END IF;
  IF p_output_cost   IS NULL OR p_output_cost   < 0 OR p_output_cost   > 10     THEN RAISE EXCEPTION 'brain output_cost oob'   USING ERRCODE = '22003'; END IF;

  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, p_service, p_operation,
     p_input_tokens + p_output_tokens, 'tokens', p_input_cost + p_output_cost, p_environment,
     p_metadata || jsonb_build_object(
       'leg',            p_operation,
       'pipeline',       'decoupled_brain',
       'input_tokens',   p_input_tokens,
       'output_tokens',  p_output_tokens,
       'input_cost',     p_input_cost,
       'output_cost',    p_output_cost,
       'billed_partial', p_billed_partial))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;
END;$$;

-- Lock down: service_role only (mirrors every cogs_insert_* RPC). New
-- 12-arg signature.
REVOKE EXECUTE ON FUNCTION public.cogs_insert_brain_leg(
  uuid, uuid, int, text, int, int, numeric, numeric, text, boolean, jsonb, cogs_service
) FROM public, anon, authenticated;

-- RPC signature change → invalidate PostgREST's OpenAPI cache (else
-- PGRST202 for up to 60-300s after apply). Mirrors 20260520000003.
NOTIFY pgrst, 'reload schema';
