-- 0051 — cogs_log.turn_number + turn idempotency + cogs_insert_turn signature
--
-- Days 8–12 plan REV 5, migration 7 of 11.
-- REPLACES REV 3's idempotency-only migration per REV 4 N2-C1: cogs_log has
-- NO pre-existing `turn_number` column, so an ON CONFLICT on a phantom
-- column is a silent no-op. This migration adds the column, tightens the
-- append-only trigger to treat it as immutable post-insert (N3-S2), builds
-- the partial unique index, and re-creates `cogs_insert_turn` with a
-- trailing `p_turn_number int DEFAULT NULL` argument so existing Spike A
-- call sites don't break at rollout time (they pass NULL, partial index
-- excludes them — no false conflicts).

-- 1. Column --------------------------------------------------------------------

ALTER TABLE public.cogs_log
  ADD COLUMN turn_number int
    CHECK (turn_number IS NULL OR turn_number > 0);

-- 2. Append-only trigger — tighten to treat turn_number as immutable ---------
-- N3-S2: IS DISTINCT FROM (not `=` or `<>`) so NULL→NULL is the only allowed
-- "no-change" transition. After insert, turn_number cannot be altered.

CREATE OR REPLACE FUNCTION public.cogs_log_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- turn_number is append-only post-insert (N3-S2). This guard fires before
  -- the existing column-allow-list so an FK-cascade that somehow re-touches
  -- the row can't silently mutate turn_number even if it tries.
  IF NEW.turn_number IS DISTINCT FROM OLD.turn_number THEN
    RAISE EXCEPTION 'cogs_log.turn_number is immutable after insert'
      USING ERRCODE = '42501';
  END IF;

  -- Existing allow-list (unchanged from 0040's amended body): every business
  -- column unchanged and FK-cascade may null user_id / session_id only.
  IF NEW.id          = OLD.id
 AND NEW.created_at  = OLD.created_at
 AND NEW.service     = OLD.service
 AND NEW.operation   = OLD.operation
 AND NEW.units       = OLD.units
 AND NEW.unit_label  = OLD.unit_label
 AND NEW.cost_usd    = OLD.cost_usd
 AND NEW.metadata    IS NOT DISTINCT FROM OLD.metadata
 AND NEW.environment = OLD.environment
 AND (NEW.user_id    IS NOT DISTINCT FROM OLD.user_id    OR NEW.user_id    IS NULL)
 AND (NEW.session_id IS NOT DISTINCT FROM OLD.session_id OR NEW.session_id IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cogs_log is append-only' USING ERRCODE = '42501';
END;$$;

REVOKE EXECUTE ON FUNCTION public.cogs_log_block_update() FROM public;

-- 3. Partial unique index for turn-level idempotency --------------------------
-- Key is (session_id, turn_number, service, operation) — NOT just
-- (session_id, turn_number, service). A single turn writes multiple legs
-- with the same service but distinct operations (free path: 2 rows with
-- operation='voice_audio_input_seconds'/'voice_audio_output_seconds'; Pro
-- path: up to 6 rows across STT, reasoning, and TTS legs, also same
-- service values). Without `operation` in the key, the second leg insert
-- would ON CONFLICT DO NOTHING and silently drop COGS data.
--
-- Excludes NULL turn_numbers (voice-clone uploads, resume-context-tokens
-- COGS rows, etc.) so non-turn writers never collide.

CREATE UNIQUE INDEX cogs_log_turn_idempotency
  ON public.cogs_log (session_id, turn_number, service, operation)
  WHERE turn_number IS NOT NULL;

-- 4. cogs_insert_turn: extend signature with p_turn_number ---------------------
-- DROP + CREATE because Postgres won't change the parameter list of an
-- existing function. Using DEFAULT NULL for append-only compatibility: any
-- caller (proxy) that doesn't pass a turn number behaves exactly as before
-- and lands NULL rows that the partial index ignores. Proxy-side code is
-- updated in Phase 1 to pass p_turn_number.

DROP FUNCTION public.cogs_insert_turn(
  uuid, uuid, cogs_service, text, numeric, numeric, numeric, numeric, text, jsonb
);

CREATE FUNCTION public.cogs_insert_turn(
  p_user_id        uuid,
  p_session_id     uuid,
  p_service        cogs_service,
  p_model          text,
  p_input_seconds  numeric,
  p_output_seconds numeric,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_metadata       jsonb DEFAULT '{}'::jsonb,
  p_turn_number    int   DEFAULT NULL
) RETURNS TABLE (input_row_id bigint, output_row_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_input_id  bigint;
  v_output_id bigint;
  v_jwt_role  text;
BEGIN
  -- Caller identity guard (preserved from 0043).
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot insert turn for another user'
        USING ERRCODE = '42501';
    END IF;
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
  IF p_turn_number IS NOT NULL AND p_turn_number <= 0 THEN
    RAISE EXCEPTION 'turn_number must be positive' USING ERRCODE = '22003';
  END IF;

  -- ON CONFLICT (session_id, turn_number, service) — the partial unique
  -- index. If the turn was already recorded, return the existing row ids
  -- instead of raising; the proxy's retry path treats this as idempotent
  -- success (Round-2 audit R2).
  INSERT INTO public.cogs_log
    (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata, turn_number)
  VALUES
    (p_user_id, p_session_id, p_service, 'voice_audio_input_seconds',
     p_input_seconds, 'seconds', p_input_cost, p_environment,
     p_metadata || jsonb_build_object('model', p_model, 'direction', 'input'),
     p_turn_number)
  ON CONFLICT (session_id, turn_number, service, operation) WHERE turn_number IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_input_id;

  INSERT INTO public.cogs_log
    (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata, turn_number)
  VALUES
    (p_user_id, p_session_id, p_service, 'voice_audio_output_seconds',
     p_output_seconds, 'seconds', p_output_cost, p_environment,
     p_metadata || jsonb_build_object('model', p_model, 'direction', 'output'),
     p_turn_number)
  ON CONFLICT (session_id, turn_number, service, operation) WHERE turn_number IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_output_id;

  -- If both conflict-skipped, v_input_id / v_output_id are NULL; proxy
  -- treats NULLs as "already recorded — move on."
  RETURN QUERY SELECT v_input_id, v_output_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn(
  uuid, uuid, cogs_service, text, numeric, numeric, numeric, numeric, text, jsonb, int
) FROM public, anon, authenticated;
