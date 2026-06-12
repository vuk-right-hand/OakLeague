-- 20260612000003 — MEMORY_BREADTH_PLAN Unit 1b (audit R1-C1 + R2-C1):
-- widen cogs_insert_brain_leg to accept the post-session memory-extraction
-- leg (operation 'memory_extract').
--
-- Targets the LIVE 12-arg signature from 20260523000004 (the 11-arg
-- 20260522000103 version was DROPped there — R2-C1 caught a widen written
-- against the dead signature). Same arg list → CREATE OR REPLACE is a true
-- replace, no second overload.
--
-- turn_number for the memory leg: the function's `<= 0` guard is KEPT
-- (R2-C1 — 0 is rejected); the proxy writes the leg with the sentinel
-- 2147483647 (int4 max). Uniqueness: (session_id, 2147483647, service,
-- 'memory_extract') — once per session by construction; the partial unique
-- index (WHERE turn_number IS NOT NULL, 20260522000103) tolerates any
-- positive int. A duplicate fire hits ON CONFLICT DO NOTHING.
--
-- metadata.pipeline: 'memory_extract' for this leg (NOT 'decoupled_brain')
-- so COGS dashboards separate per-turn brain spend from per-session memory
-- spend.
--
-- Changes vs 20260523000004, in full (everything else verbatim):
--   1. p_operation allowlist gains 'memory_extract'.
--   2. metadata pipeline is operation-conditional.

CREATE OR REPLACE FUNCTION public.cogs_insert_brain_leg(
  p_user_id        uuid,
  p_session_id     uuid,
  p_turn_number    int,
  p_operation      text,    -- 'brain_deep_answer' | 'brain_paraphrase' | 'brain_deep_answer_failover' | 'memory_extract'
  p_input_tokens   int,
  p_output_tokens  int,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_billed_partial boolean DEFAULT false,
  p_metadata       jsonb DEFAULT '{}'::jsonb,
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

  -- Unit 1b: 'memory_extract' is the once-per-session post-teardown leg.
  IF p_operation NOT IN ('brain_deep_answer', 'brain_paraphrase', 'brain_deep_answer_failover', 'memory_extract') THEN
    RAISE EXCEPTION 'p_operation must be brain_deep_answer, brain_paraphrase, brain_deep_answer_failover or memory_extract (got %)', p_operation
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
       'pipeline',       CASE WHEN p_operation = 'memory_extract' THEN 'memory_extract' ELSE 'decoupled_brain' END,
       'input_tokens',   p_input_tokens,
       'output_tokens',  p_output_tokens,
       'input_cost',     p_input_cost,
       'output_cost',    p_output_cost,
       'billed_partial', p_billed_partial))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;
END;$$;

-- Re-state the lockdown (CREATE OR REPLACE preserves ACLs, but explicit
-- beats implicit per the secdef footer rule).
REVOKE EXECUTE ON FUNCTION public.cogs_insert_brain_leg(
  uuid, uuid, int, text, int, int, numeric, numeric, text, boolean, jsonb, cogs_service
) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
