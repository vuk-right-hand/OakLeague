-- DECOUPLED_BRAIN_PLAN P1-5.1b (audit gate #2, finding C1) —
-- cogs_insert_brain_leg: the PER-LEG token-based COGS RPC for the
-- decoupled brain.
--
-- WHY A NEW RPC (not an extension of cogs_insert_turn_voice_v2):
-- a decoupled turn fires TWO paid Gemini `generateContentStream` calls
-- — the hedged paraphrase (dead-air mask) and the deep answer — at
-- DIFFERENT times within the turn, and EACH bills in full server-side
-- even on a client barge (P0-4a). cogs_insert_turn_voice_v2 is ONE
-- atomic 4-leg write keyed (session_id,turn_number) that assumes all
-- legs are known at turn_complete. That is structurally wrong for
-- decoupled. This RPC is PER-LEG: ONE call per leg, service='gemini'
-- (the EXISTING enum value — no ADD VALUE, no new cogs_service),
-- operation ∈ {brain_deep_answer, brain_paraphrase}.
--
-- IDEMPOTENCY: reuses the migration-0051 partial unique index
-- (session_id, turn_number, service, operation) WHERE turn_number IS
-- NOT NULL. The two decoupled operation strings are distinct from each
-- other AND from the v2 RPC's gemini legs (voice_audio_input_seconds /
-- voice_audio_out_tokens), so a decoupled turn writing both legs +
-- (in a rollback-to-legacy) the v2 audio legs never collide; a
-- barge-retry of the same leg is a DO NOTHING (no double-bill).
--
-- ONE row per call: units = input+output tokens; cost_usd = the SUM of
-- the two token-rate costs so the 150%-of-quota kill-switch sees the
-- FULL spend in one place; metadata carries the input/output split +
-- the billed_partial flag. M6: a barged turn still bills server-side,
-- so the caller writes the leg from the bridge's `.partial` with
-- p_billed_partial=true (token counts may be estimates when
-- usageMetadata never arrived before the abort — flagged, never
-- silently dropped: a billed call MUST be cogs-visible).
--
-- Caller-guard / SECURITY DEFINER / REVOKE / env+range guards mirror
-- cogs_insert_turn_voice_v2 (20260520000003) verbatim. Append-only
-- (raise_append_only trigger) and service_role-only by REVOKE.
--
-- Migration number 000103: after 000102 (decoupled flag); collision-
-- safe vs Hume 000001 (NEVER rename) and RAG 000100/000101.

CREATE FUNCTION public.cogs_insert_brain_leg(
  p_user_id        uuid,
  p_session_id     uuid,
  p_turn_number    int,
  p_operation      text,    -- 'brain_deep_answer' | 'brain_paraphrase'
  p_input_tokens   int,
  p_output_tokens  int,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_billed_partial boolean DEFAULT false,
  p_metadata       jsonb DEFAULT '{}'::jsonb
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

  IF p_operation NOT IN ('brain_deep_answer', 'brain_paraphrase') THEN
    RAISE EXCEPTION 'p_operation must be brain_deep_answer or brain_paraphrase (got %)', p_operation
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
    (p_user_id, p_session_id, p_turn_number, 'gemini', p_operation,
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

-- Lock down: service_role only (mirrors every cogs_insert_* RPC).
REVOKE EXECUTE ON FUNCTION public.cogs_insert_brain_leg(
  uuid, uuid, int, text, int, int, numeric, numeric, text, boolean, jsonb
) FROM public, anon, authenticated;

-- RPC signature change → invalidate PostgREST's OpenAPI cache (else
-- PGRST202 for up to 60-300s after apply). Mirrors 20260520000003.
NOTIFY pgrst, 'reload schema';
