-- HUME_TTS_PLAN §3.3 — cogs_insert_turn_voice_v2 (provider-aware)
--
-- Adds a v2 RPC that takes p_tts_service so legs 3+4 land with the right
-- cogs_service value ('cartesia' OR 'hume'). v1 RPC stays callable for the
-- deploy-window overlap; it becomes a forwarding shim that calls v2 with
-- p_tts_service := 'cartesia'.
--
-- Changes from v1 (migration 0055 / 20260428000001):
--   * NEW PARAM: p_tts_service cogs_service — drives legs 3+4 service column
--   * NEW PARAM: p_tts_provider tts_provider — written into p_metadata so
--                cogs-aggregations.ts can group by provider on every leg
--   * RENAMED PARAMS (semantics unchanged):
--       p_cartesia_characters    → p_tts_characters
--       p_cartesia_cost          → p_tts_cost
--       p_cartesia_audio_seconds → p_tts_audio_seconds
--   * TIGHTENED CAP (Vuk-M3 fix): p_tts_characters upper bound 200000 → 100000
--     for BOTH providers (Cartesia previously 200k). OUTPUT_TRANSCRIPT_MAX_CHARS
--     is 4000 per Gemini turn so 100k is 25× headroom for accidental concat.
--   * Operation strings unchanged: voice_audio_input_seconds, voice_audio_out_tokens,
--     voice_tts_characters, voice_tts_audio_seconds. The (service, operation)
--     pair is the new dashboard grouping key (HUME_TTS_PLAN §6.5).
--
-- v1 forwarding-shim (separate UPDATE below): the existing
-- cogs_insert_turn_voice signature stays, body redirects to v2 with
-- p_tts_service := 'cartesia'. Old proxy VMs (in-flight WS sessions during
-- rolling deploy) keep writing correct rows.

-- Audit C6 fix (2026-05-13) — refined per unit-wide audit M3 (2026-05-13):
-- dependency guard via pg_enum catalog lookup, NOT enum literal cast.
--
-- The original guard did `PERFORM 'hume'::cogs_service` — PG 12+ rejects
-- using a newly-added enum value in the SAME transaction as the ADD VALUE.
-- Local `supabase db reset` runs each migration in its own tx so it worked,
-- but `supabase db push` against remote can batch multiple files into one
-- connection. If 0001 (ALTER TYPE ADD VALUE 'hume') and 0003 land in the
-- same psql session, the literal cast in this guard raises
-- "unsafe use of new value 'hume' of enum type" — the migration fails
-- with the wrong reason and the EXCEPTION block's `undefined_object`
-- handler doesn't catch the alternate error code (55P03).
--
-- Catalog lookup against pg_enum is metadata-only — no use-of-value
-- restriction. Works in the same tx as ADD VALUE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'cogs_service'
       AND t.typnamespace = 'public'::regnamespace
       AND e.enumlabel = 'hume'
  ) THEN
    RAISE EXCEPTION 'migration 20260520000003 requires 20260520000001 (cogs_service+hume). Apply in order.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_type
     WHERE typname = 'tts_provider'
       AND typnamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'migration 20260520000003 requires 20260520000002 (tts_provider enum). Apply in order.';
  END IF;
END $$;

CREATE FUNCTION public.cogs_insert_turn_voice_v2(
  p_user_id                     uuid,
  p_session_id                  uuid,
  p_turn_number                 int,
  -- Leg 1: Gemini audio-in seconds
  p_gemini_audio_in_seconds     numeric,
  p_gemini_audio_in_cost        numeric,
  -- Leg 2: Gemini audio-out tokens (audio discarded; tokens billed)
  p_gemini_audio_out_tokens     int,
  p_gemini_audio_out_cost       numeric,
  -- Legs 3+4: provider-neutral TTS billing
  p_tts_service                 cogs_service,        -- 'cartesia' | 'hume'
  p_tts_provider                public.tts_provider, -- 'cartesia' | 'hume' (echoed into metadata)
  p_tts_characters              int,
  p_tts_cost                    numeric,
  p_tts_audio_seconds           numeric,
  p_environment                 text,
  p_metadata                    jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role         text;
  v_meta             jsonb;
  v_session_provider public.tts_provider;
BEGIN
  -- Caller guard: service_role bypass; user must match own row.
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot insert voice turn for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Provider sanity: p_tts_service and p_tts_provider must agree.
  -- ('cartesia','cartesia') OR ('hume','hume'). Mismatch = bug in caller.
  IF p_tts_service::text <> p_tts_provider::text THEN
    RAISE EXCEPTION 'p_tts_service (%) and p_tts_provider (%) must match',
      p_tts_service, p_tts_provider USING ERRCODE = '22023';
  END IF;
  IF p_tts_service NOT IN ('cartesia', 'hume') THEN
    RAISE EXCEPTION 'p_tts_service must be cartesia or hume (got %)', p_tts_service
      USING ERRCODE = '22023';
  END IF;

  -- Audit M2 fix (2026-05-13): cross-check the session's snapshotted
  -- provider. The cogs_log unique index is (session_id, turn_number, service,
  -- operation) so legs 3+4 from a different-provider retry would NOT trip
  -- ON CONFLICT — they'd silently double-bill. The session row holds the
  -- single-source-of-truth provider (snapshotted at /api/sessions/open and
  -- never re-read). Refuse any call that disagrees with it. NULL on session
  -- row is allowed (pre-migration sessions = 'cartesia' by construction).
  SELECT tts_provider_at_session
    INTO v_session_provider
    FROM public.sessions
   WHERE id = p_session_id;
  IF v_session_provider IS NOT NULL AND v_session_provider <> p_tts_provider THEN
    RAISE EXCEPTION 'p_tts_provider (%) disagrees with sessions.tts_provider_at_session (%) for session %',
      p_tts_provider, v_session_provider, p_session_id
      USING ERRCODE = '22023';
  END IF;

  IF p_environment NOT IN ('production', 'spike_a', 'spike_b', 'dev') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment USING ERRCODE = '22023';
  END IF;
  IF p_turn_number IS NULL OR p_turn_number <= 0 THEN
    RAISE EXCEPTION 'turn_number must be positive' USING ERRCODE = '22003';
  END IF;

  -- Range guards (Vuk-M3 + R3-M6 tightened cap)
  IF p_gemini_audio_in_seconds < 0 OR p_gemini_audio_in_seconds > 3600   THEN RAISE EXCEPTION 'gemini_audio_in_seconds oob'  USING ERRCODE = '22003'; END IF;
  IF p_gemini_audio_out_tokens < 0 OR p_gemini_audio_out_tokens > 200000 THEN RAISE EXCEPTION 'gemini_audio_out_tokens oob'  USING ERRCODE = '22003'; END IF;
  IF p_tts_characters          < 0 OR p_tts_characters          > 100000 THEN RAISE EXCEPTION 'tts_characters oob'           USING ERRCODE = '22003'; END IF;
  IF p_tts_audio_seconds       < 0 OR p_tts_audio_seconds       > 3600   THEN RAISE EXCEPTION 'tts_audio_seconds oob'        USING ERRCODE = '22003'; END IF;

  -- Cost sanity
  IF p_gemini_audio_in_cost  < 0 OR p_gemini_audio_in_cost  > 10 THEN RAISE EXCEPTION 'gemini_audio_in_cost oob'  USING ERRCODE = '22003'; END IF;
  IF p_gemini_audio_out_cost < 0 OR p_gemini_audio_out_cost > 10 THEN RAISE EXCEPTION 'gemini_audio_out_cost oob' USING ERRCODE = '22003'; END IF;
  IF p_tts_cost              < 0 OR p_tts_cost              > 10 THEN RAISE EXCEPTION 'tts_cost oob'              USING ERRCODE = '22003'; END IF;

  -- C4 fix: echo tts_provider into metadata so cogs-aggregations.ts can
  -- group by provider on EVERY leg (not just legs 3+4 where service column
  -- carries it directly).
  v_meta := p_metadata || jsonb_build_object('tts_provider', p_tts_provider::text);

  -- Leg 1: Gemini audio-in seconds
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, 'gemini', 'voice_audio_input_seconds',
     p_gemini_audio_in_seconds, 'seconds', p_gemini_audio_in_cost, p_environment,
     v_meta || jsonb_build_object('leg', 'gemini_audio_in', 'pipeline', 'alpha_prime'))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;

  -- Leg 2: Gemini audio-out tokens (α' pays-and-discards)
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, 'gemini', 'voice_audio_out_tokens',
     p_gemini_audio_out_tokens, 'tokens', p_gemini_audio_out_cost, p_environment,
     v_meta || jsonb_build_object('leg', 'gemini_audio_out', 'pipeline', 'alpha_prime', 'audio_discarded', true))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;

  -- Leg 3: TTS characters (Cartesia or Hume — service column distinguishes)
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, p_tts_service, 'voice_tts_characters',
     p_tts_characters, 'characters', p_tts_cost, p_environment,
     v_meta || jsonb_build_object('leg', 'tts_chars', 'pipeline', 'alpha_prime'))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;

  -- Leg 4: TTS audio seconds (observability; cost=0 to dodge USD double-count)
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, p_tts_service, 'voice_tts_audio_seconds',
     p_tts_audio_seconds, 'seconds', 0, p_environment,
     v_meta || jsonb_build_object('leg', 'tts_audio', 'pipeline', 'alpha_prime', 'observability_only', true))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;
END;$$;

-- Lock down: service_role only.
REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn_voice_v2(
  uuid, uuid, int,
  numeric, numeric,
  int, numeric,
  cogs_service, tts_provider, int, numeric, numeric,
  text, jsonb
) FROM public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- v1 forwarding shim — R2-C2 fix
-- ─────────────────────────────────────────────────────────────────────
-- Replace the v1 body so any old proxy VM still calling v1 (during a Fly
-- rolling deploy) writes correct rows via v2 with cartesia defaults.
-- This is NOT a renamed function — same signature as the original 0055
-- definition; CREATE OR REPLACE swaps the body in place.
--
-- Stays callable indefinitely per HUME_TTS_PLAN §6.6 (drop-symbol is
-- gated on zero pre-v2 sessions open AND ≥30 days since v2 deploy).

CREATE OR REPLACE FUNCTION public.cogs_insert_turn_voice(
  p_user_id                     uuid,
  p_session_id                  uuid,
  p_turn_number                 int,
  p_gemini_audio_in_seconds     numeric,
  p_gemini_audio_in_cost        numeric,
  p_gemini_audio_out_tokens     int,
  p_gemini_audio_out_cost       numeric,
  p_cartesia_characters         int,
  p_cartesia_cost               numeric,
  p_cartesia_audio_seconds      numeric,
  p_environment                 text,
  p_metadata                    jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.cogs_insert_turn_voice_v2(
    p_user_id, p_session_id, p_turn_number,
    p_gemini_audio_in_seconds, p_gemini_audio_in_cost,
    p_gemini_audio_out_tokens, p_gemini_audio_out_cost,
    'cartesia'::public.cogs_service,
    'cartesia'::public.tts_provider,
    p_cartesia_characters, p_cartesia_cost, p_cartesia_audio_seconds,
    p_environment, p_metadata
  );
END;$$;

-- Unit-wide audit M2 fix (2026-05-13): every migration that mutates RPC
-- signatures must invalidate PostgREST's OpenAPI cache; otherwise routes
-- get PGRST202 for up to 60-300s after apply. 0002 has its own NOTIFY;
-- adding to 0003 covers cogs_insert_turn_voice_v2 + the v1 shim rewrite.
NOTIFY pgrst, 'reload schema';
