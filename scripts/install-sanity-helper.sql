-- install-sanity-helper.sql
--
-- One-time helper for `scripts/sanity-check-cogs-turn-idempotency.ts`. Run
-- this once in the Supabase SQL Editor against a NON-PROD project. The TS
-- script then calls `public.cogs_sanity_check_scratch_v1()` via the service
-- role client (supabase.rpc()). After the sanity run you may DROP the
-- function again — see bottom of file.
--
-- Why this is a separate file:
-- Supabase does not expose a generic `exec_sql` RPC by default. The audit
-- (C3) flagged that the TS script embedded the CREATE FUNCTION inline and
-- depended on `supabase.rpc('exec_sql', { query })` — which fails on most
-- projects. Shipping the DDL as a normal SQL file keeps the contract
-- honest: install once, then the TS script is a pure RPC consumer.
--
-- WARNING (audit M5): this function INSERTS rows into cogs_log and cannot
-- DELETE them (append-only trigger blocks DELETE; FK cascade from sessions
-- sets session_id=NULL instead). Rows persist forever, tagged with
-- metadata.sanity=true. DO NOT RUN AGAINST PRODUCTION.
--
-- Assertions executed inside the function (plan REV 5 N3-S5):
--   (a) EXPLAIN picks the `cogs_log_turn_idempotency` partial index.
--   (b) Duplicate (session_id, turn_number, service, operation) → 23505.
--   (c) Two NULL-turn_number inserts both succeed (partial predicate
--       excludes NULLs from the unique index).

CREATE OR REPLACE FUNCTION public.cogs_sanity_check_scratch_v1()
RETURNS TABLE (assertion text, passed boolean, detail text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_user_id    uuid;
  v_creator_id uuid;
  v_session_id uuid := gen_random_uuid();
  v_plan       jsonb;
  v_plan_txt   text;
  v_ok         boolean;
  v_sqlstate   text;
  v_detail     text;
BEGIN
  SELECT id INTO v_user_id    FROM public.profiles LIMIT 1;
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_user_id IS NULL OR v_creator_id IS NULL THEN
    RAISE EXCEPTION 'sanity check needs at least 1 profile + 1 creator fixture';
  END IF;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session)
  VALUES (v_session_id, v_user_id, v_creator_id,
          'gemini_3_1_flash_live_preview'::voice_model, 'free'::profile_tier);

  -- (a) EXPLAIN plans an Index Scan on cogs_log_turn_idempotency ---------------
  EXECUTE $q$
    EXPLAIN (FORMAT JSON)
    SELECT 1 FROM public.cogs_log
     WHERE session_id  = $1
       AND turn_number = 1
       AND service     = 'gemini'
       AND operation   = 'voice_audio_input_seconds'
  $q$
  INTO v_plan
  USING v_session_id;

  v_plan_txt := v_plan::text;
  v_ok := v_plan_txt ILIKE '%Index Scan%' AND v_plan_txt ILIKE '%cogs_log_turn_idempotency%';
  assertion := '(a) partial index chosen';
  passed    := v_ok;
  detail    := CASE WHEN v_ok THEN 'ok' ELSE substring(v_plan_txt from 1 for 400) END;
  RETURN NEXT;

  -- (b) Duplicate (session_id, turn_number, service, operation) → 23505. -------
  INSERT INTO public.cogs_log
    (user_id, session_id, service, operation, units, unit_label, cost_usd,
     environment, turn_number, metadata)
  VALUES
    (v_user_id, v_session_id, 'gemini', 'voice_audio_input_seconds',
     1, 'seconds', 0, 'dev', 1, jsonb_build_object('sanity', true));

  v_ok := false;
  BEGIN
    INSERT INTO public.cogs_log
      (user_id, session_id, service, operation, units, unit_label, cost_usd,
       environment, turn_number, metadata)
    VALUES
      (v_user_id, v_session_id, 'gemini', 'voice_audio_input_seconds',
       2, 'seconds', 0, 'dev', 1, jsonb_build_object('sanity', true));
  EXCEPTION WHEN unique_violation THEN
    v_ok := true;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
  END;
  v_detail := CASE WHEN v_ok THEN 'sqlstate=' || COALESCE(v_sqlstate, '23505')
                   ELSE 'no conflict raised — idempotency index missing?' END;
  assertion := '(b) duplicate 4-tuple raises 23505';
  passed    := v_ok;
  detail    := v_detail;
  RETURN NEXT;

  -- (c) Two inserts with turn_number=NULL both succeed -------------------------
  v_ok := true;
  BEGIN
    INSERT INTO public.cogs_log
      (user_id, session_id, service, operation, units, unit_label, cost_usd,
       environment, turn_number, metadata)
    VALUES
      (v_user_id, v_session_id, 'cartesia', 'voice_clone_upload',
       1024, 'bytes', 0, 'dev', NULL, jsonb_build_object('sanity', true));
    INSERT INTO public.cogs_log
      (user_id, session_id, service, operation, units, unit_label, cost_usd,
       environment, turn_number, metadata)
    VALUES
      (v_user_id, v_session_id, 'cartesia', 'voice_clone_upload',
       2048, 'bytes', 0, 'dev', NULL, jsonb_build_object('sanity', true));
  EXCEPTION WHEN unique_violation THEN
    v_ok := false;
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
  END;
  assertion := '(c) two NULL-turn_number inserts both succeed';
  passed    := v_ok;
  detail    := CASE WHEN v_ok THEN 'ok'
                    ELSE 'unexpected unique_violation sqlstate=' || COALESCE(v_sqlstate, 'unknown') END;
  RETURN NEXT;

  -- Cleanup: delete the scratch session. FK cascade sets cogs_log.session_id
  -- to NULL on the sanity rows; rows themselves persist (append-only trigger).
  DELETE FROM public.sessions WHERE id = v_session_id;

  RETURN;
END;
$fn$;

-- Lock down — service role only (mirrors the rest of the voice RPC family).
REVOKE EXECUTE ON FUNCTION public.cogs_sanity_check_scratch_v1()
  FROM public, anon, authenticated;

-- After the sanity run, drop the helper:
--
--   DROP FUNCTION public.cogs_sanity_check_scratch_v1();
