-- FISH_AUDIO_PHASE_1 §4 M3 — cogs_insert_turn_voice_v3 (Fish-aware)
--
-- See docs/_planning/FISH_AUDIO_PHASE_1.md §4 M3 for the design context.
--
-- Adds a v3 RPC whose body matches v2's except the provider-gate accepts
-- 'fish' as a third allowed value, the NULL-tts_provider_at_session escape
-- hatch is closed (M3 audit M6 fix — Fish has no "= cartesia by
-- construction" guarantee that the original branch assumed for Hume), and
-- p_metadata is coalesced from NULL to '{}'::jsonb (audit C2 — fixes a
-- latent NULL-metadata bug v2 silently inherited).
--
-- v2 body is REPLACED with PERFORM v3(...). v1 body is also REWRITTEN
-- (audit C3): instead of hard-coding 'cartesia' as the forwarding provider,
-- v1 now reads sessions.tts_provider_at_session for p_session_id. Any
-- legacy proxy VM still calling v1 during a Fish cutover deploy bills
-- against the SESSION'S snapshot, not against 'cartesia' (which would
-- silently mis-bill Fish sessions). v1 → v2 → v3 transitively.
--
-- Changes from v2 (migration 20260520000003):
--   * Provider gate widened: ('cartesia','hume') → ('cartesia','hume','fish')
--   * v2 body REPLACED with: PERFORM v3(...same args...). v2 is no longer the
--     substantive impl — v3 is. PG CREATE OR REPLACE FUNCTION is
--     catalog-update-on-commit, so in-flight v2 calls execute to completion
--     before the new body is visible. Brain-leg RPCs unaffected (separate
--     function, separate signature).
--   * No new params. Signature is byte-identical to v2 so the v2-shim's
--     PERFORM is just a positional re-dispatch.
--   * Existing v2 callers (proxy, tests) continue to work unchanged. New
--     code (fish-bridge orchestrator) should call v3 directly to skip the
--     extra dispatch hop.
--
-- Dependency guard (catalog lookup, not literal cast — same reason as v2):
-- using 'fish'::cogs_service or 'fish'::tts_provider in the same tx as the
-- ALTER TYPE ADD VALUE in M1/M2 would raise "unsafe use of new value" on
-- bundled deploys. pg_enum lookup is metadata-only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'cogs_service'
       AND t.typnamespace = 'public'::regnamespace
       AND e.enumlabel = 'fish'
  ) THEN
    RAISE EXCEPTION 'migration 20260608100003 requires 20260608100002 (cogs_service+fish). Apply in order.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'tts_provider'
       AND t.typnamespace = 'public'::regnamespace
       AND e.enumlabel = 'fish'
  ) THEN
    RAISE EXCEPTION 'migration 20260608100003 requires 20260608100001 (tts_provider+fish). Apply in order.';
  END IF;

  -- Audit M6 pre-flight: M3 closes the NULL-snapshot escape hatch in v3.
  -- If any active session has NULL tts_provider_at_session at the moment
  -- this migration applies, v3 would refuse to bill it on the very next
  -- turn. Fail the migration loudly with operator instructions instead
  -- of letting voice cogs stop landing in prod for an unknown subset of
  -- sessions.
  DECLARE v_null_active bigint;
  BEGIN
    SELECT count(*) INTO v_null_active
      FROM public.sessions
     WHERE tts_provider_at_session IS NULL
       AND ended_at IS NULL;
    IF v_null_active > 0 THEN
      RAISE EXCEPTION 'M3 pre-flight: % active session(s) have NULL tts_provider_at_session. Backfill with admin SQL before applying (UPDATE public.sessions SET tts_provider_at_session = ''cartesia''::public.tts_provider WHERE tts_provider_at_session IS NULL AND ended_at IS NULL).', v_null_active;
    END IF;
  END;
END $$;

-- Audit C1: CREATE OR REPLACE so a partial M3 apply (v3 created, v2-shim
-- failed) can be re-run without 42723. Safe — function shape is identical
-- across re-runs by construction; OR REPLACE swaps the body.
CREATE OR REPLACE FUNCTION public.cogs_insert_turn_voice_v3(
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
  p_tts_service                 cogs_service,        -- 'cartesia' | 'hume' | 'fish'
  p_tts_provider                public.tts_provider, -- must match service
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
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot insert voice turn for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_tts_service::text <> p_tts_provider::text THEN
    RAISE EXCEPTION 'p_tts_service (%) and p_tts_provider (%) must match',
      p_tts_service, p_tts_provider USING ERRCODE = '22023';
  END IF;
  IF p_tts_service NOT IN ('cartesia', 'hume', 'fish') THEN
    RAISE EXCEPTION 'p_tts_service must be cartesia, hume or fish (got %)', p_tts_service
      USING ERRCODE = '22023';
  END IF;

  -- Audit M6: close the NULL-snapshot escape hatch. v2 allowed NULL on the
  -- assumption "pre-Hume sessions = cartesia by construction" which held in
  -- 2026-05. For Fish cutover (2026-06+) that assumption is broken — a
  -- NULL snapshot can no longer be safely treated as cartesia. Refuse and
  -- force the operator to backfill or end the session. The M3 pre-flight
  -- check in the DO block above ensures no active sessions have NULL at
  -- apply time, so this RAISE will only fire if a brand-new session
  -- opened without snapshot write (proxy bug — should be loud).
  SELECT tts_provider_at_session
    INTO v_session_provider
    FROM public.sessions
   WHERE id = p_session_id;
  IF v_session_provider IS NULL THEN
    RAISE EXCEPTION 'session % has no tts_provider_at_session snapshot — refusing voice cogs write to prevent silent mis-billing (M3 audit M6)', p_session_id
      USING ERRCODE = '22023';
  END IF;
  IF v_session_provider <> p_tts_provider THEN
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

  IF p_gemini_audio_in_seconds < 0 OR p_gemini_audio_in_seconds > 3600   THEN RAISE EXCEPTION 'gemini_audio_in_seconds oob'  USING ERRCODE = '22003'; END IF;
  IF p_gemini_audio_out_tokens < 0 OR p_gemini_audio_out_tokens > 200000 THEN RAISE EXCEPTION 'gemini_audio_out_tokens oob'  USING ERRCODE = '22003'; END IF;
  IF p_tts_characters          < 0 OR p_tts_characters          > 100000 THEN RAISE EXCEPTION 'tts_characters oob'           USING ERRCODE = '22003'; END IF;
  IF p_tts_audio_seconds       < 0 OR p_tts_audio_seconds       > 3600   THEN RAISE EXCEPTION 'tts_audio_seconds oob'        USING ERRCODE = '22003'; END IF;

  IF p_gemini_audio_in_cost  < 0 OR p_gemini_audio_in_cost  > 10 THEN RAISE EXCEPTION 'gemini_audio_in_cost oob'  USING ERRCODE = '22003'; END IF;
  IF p_gemini_audio_out_cost < 0 OR p_gemini_audio_out_cost > 10 THEN RAISE EXCEPTION 'gemini_audio_out_cost oob' USING ERRCODE = '22003'; END IF;
  IF p_tts_cost              < 0 OR p_tts_cost              > 10 THEN RAISE EXCEPTION 'tts_cost oob'              USING ERRCODE = '22003'; END IF;

  -- Audit C2 fix: coalesce(p_metadata, '{}') closes the latent NULL bug v2
  -- silently shipped. PG `NULL || jsonb` is NULL, which would have stamped
  -- every cogs_log.metadata as NULL for any caller passing NULL explicitly.
  -- Audit S5: the right-hand `||` is authoritative — if a caller stuffed a
  -- `tts_provider` key in p_metadata, this overrides it with the actual
  -- p_tts_provider param (single source of truth).
  v_meta := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('tts_provider', p_tts_provider::text);

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

  -- Leg 3: TTS characters (service column distinguishes cartesia/hume/fish)
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

-- Lock down: service_role only. Audit M7: explicit GRANT after REVOKE
-- (defense-in-depth per the secdef-grant-leak post-mortem — never rely
-- on implicit owner-EXECUTE for SECURITY DEFINER functions).
REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn_voice_v3(
  uuid, uuid, int,
  numeric, numeric,
  int, numeric,
  cogs_service, tts_provider, int, numeric, numeric,
  text, jsonb
) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cogs_insert_turn_voice_v3(
  uuid, uuid, int,
  numeric, numeric,
  int, numeric,
  cogs_service, tts_provider, int, numeric, numeric,
  text, jsonb
) TO service_role;


-- ─────────────────────────────────────────────────────────────────────
-- v2 forwarding shim — v2 body becomes PERFORM v3(...)
-- ─────────────────────────────────────────────────────────────────────
-- Same byte-identical signature as 20260520000003's v2; CREATE OR REPLACE
-- swaps the body. Old proxy VMs still calling v2 during a rolling deploy
-- transparently land in v3. v1 already forwards to v2, so v1 → v2 → v3
-- transitively.
--
-- PG safety note: CREATE OR REPLACE FUNCTION is catalog-update-on-commit.
-- In-flight v2 calls execute to completion against the OLD body before
-- the new body becomes visible. No mid-call splice; no double-billing
-- risk during deploy. Brain-leg RPCs (separate function, separate
-- signature) are entirely unaffected by this migration.

CREATE OR REPLACE FUNCTION public.cogs_insert_turn_voice_v2(
  p_user_id                     uuid,
  p_session_id                  uuid,
  p_turn_number                 int,
  p_gemini_audio_in_seconds     numeric,
  p_gemini_audio_in_cost        numeric,
  p_gemini_audio_out_tokens     int,
  p_gemini_audio_out_cost       numeric,
  p_tts_service                 cogs_service,
  p_tts_provider                public.tts_provider,
  p_tts_characters              int,
  p_tts_cost                    numeric,
  p_tts_audio_seconds           numeric,
  p_environment                 text,
  p_metadata                    jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.cogs_insert_turn_voice_v3(
    p_user_id, p_session_id, p_turn_number,
    p_gemini_audio_in_seconds, p_gemini_audio_in_cost,
    p_gemini_audio_out_tokens, p_gemini_audio_out_cost,
    p_tts_service, p_tts_provider,
    p_tts_characters, p_tts_cost, p_tts_audio_seconds,
    p_environment, p_metadata
  );
END;$$;


-- ─────────────────────────────────────────────────────────────────────
-- v1 rewrite — Audit C3 fix
-- ─────────────────────────────────────────────────────────────────────
-- Pre-M3 v1 hard-coded 'cartesia' for legs 3+4 when forwarding to v2.
-- During a Fish cutover rolling deploy, any in-flight VM still calling
-- v1 would mis-bill Fish sessions as Cartesia AND trip v3's snapshot
-- mismatch check (legs 3+4 silently dropped, COGS underbills).
--
-- New v1 body: read sessions.tts_provider_at_session for p_session_id and
-- forward THAT value as both p_tts_service and p_tts_provider. NULL
-- snapshot fails fast (matches v3's M6 behavior — no silent fallback).
-- Per HUME_TTS_PLAN §6.6 the v1 drop gate (≥30 days since v2 deploy) is
-- satisfied as of 2026-06-08, but rewriting v1 instead of dropping
-- preserves the deploy-window safety net for any FUTURE provider cutover.
-- The signature stays byte-identical to the original 20260428000001 to
-- avoid breaking still-running v1 callers' arg lists.

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
DECLARE
  v_provider public.tts_provider;
  v_service  cogs_service;
BEGIN
  SELECT tts_provider_at_session
    INTO v_provider
    FROM public.sessions
   WHERE id = p_session_id;
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'v1 forward: session % has no tts_provider_at_session snapshot — refusing voice cogs write to prevent silent mis-billing (M3 audit M6)', p_session_id
      USING ERRCODE = '22023';
  END IF;
  -- tts_provider and cogs_service enums share label names cartesia|hume|
  -- fish — cast through text since PG forbids direct cross-enum casts.
  --
  -- WARNING (audit round 2 M3): any future tts_provider widening (e.g.
  -- adding 'elevenlabs') MUST be accompanied by an identical cogs_service
  -- widening in the SAME migration set, else this cast raises 22P02
  -- (invalid_text_representation) at runtime for sessions with the new
  -- provider. The defensive guard below converts that into a readable
  -- 22023 with the operator hint.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'cogs_service'
       AND t.typnamespace = 'public'::regnamespace
       AND e.enumlabel = v_provider::text
  ) THEN
    RAISE EXCEPTION 'v1 forward: tts_provider value % has no matching cogs_service enum label. The two enums must widen together — see FISH_AUDIO_PHASE_1 §4 M1+M2 for the precedent pair.', v_provider
      USING ERRCODE = '22023';
  END IF;
  v_service := v_provider::text::public.cogs_service;
  PERFORM public.cogs_insert_turn_voice_v2(
    p_user_id, p_session_id, p_turn_number,
    p_gemini_audio_in_seconds, p_gemini_audio_in_cost,
    p_gemini_audio_out_tokens, p_gemini_audio_out_cost,
    v_service, v_provider,
    p_cartesia_characters, p_cartesia_cost, p_cartesia_audio_seconds,
    p_environment, p_metadata
  );
END;$$;

NOTIFY pgrst, 'reload schema';
