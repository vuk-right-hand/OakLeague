-- 0055 — cogs_insert_turn_voice (Pipeline α' unified voice COGS RPC)
--
-- Days 8–12 plan REV 5.1, migration 11 of 12.
--
-- ONE RPC for every tier's voice turn. Pipeline α' architecture verified in
-- Phase 0 (`scripts/voice-phase0-verify.mjs` check #7, 2026-04-22):
--
--   user audio  → Gemini 3.1 Flash Live (AUDIO mode + outputAudioTranscription)
--              → we DISCARD Gemini's synthesized audio, read only its
--                streaming outputTranscription text chunks
--              → Cartesia Sonic 3 cloned voice (IVC, per-creator cartesia_voice_id)
--              → user hears creator's cloned voice
--
-- Four legs per turn:
--   1. gemini voice_audio_input_seconds — billable, per-second (user mic)
--                                         (op-string preserved from Spike-A
--                                          2-leg RPC so dashboards keep one series)
--   2. gemini voice_audio_out_tokens    — billable (we pay for audio we throw away;
--                                         non-trivial because outputTranscription
--                                         only ships as a side-effect of AUDIO modality)
--   3. cartesia voice_tts_characters    — billable (primary Cartesia billing unit)
--   4. cartesia voice_tts_audio_seconds — cost=0 observability; drives minutes-per-day cap
--
-- Idempotency comes from the partial unique index in migration 0051
-- (cogs_log_turn_idempotency) on (session_id, turn_number, service, operation).
-- Each leg uses a distinct operation string so per-leg dedup is automatic.
--
-- SPAN CORRELATION (REV 5.2 decision — audit M1):
-- This RPC is `RETURNS void`; it does NOT emit per-leg row ids. Sentry
-- spans + admin-dashboard joins correlate voice-turn rows via the natural
-- key (session_id, turn_number). That tuple is present on every row this
-- RPC writes AND on every row voice_usage_turns writes — so trace-id-
-- equivalent joins are free. Row-id return values were considered and
-- rejected: they'd just duplicate what the natural key already gives us.
--
-- LEG 1 OPERATION STRING (REV 5.2 decision — audit M2):
-- Leg 1 writes operation='voice_audio_input_seconds' — same string the
-- legacy 2-leg cogs_insert_turn used (pre-α'). Preserving it means the
-- admin COGS dashboard's GROUP BY operation queries see one continuous
-- series across Spike-A + α' rows. Leg 2 legitimately uses a new string
-- (voice_audio_out_tokens) because the unit really changed (seconds→tokens).
--
-- This RPC SUPERSEDES the 6-leg cogs_insert_turn_pro drafted in REV 5. That
-- design assumed a Pro-only Cartesia pipeline with a separate STT + reasoning
-- split. Pipeline α' has no separate STT step — 3.1 Flash Live handles
-- audio-in + reasoning + audio-out (discarded) in one hop. Tier is a
-- minutes-per-day dial, not a pipeline swap.
--
-- Also DROPS the 2-leg Spike-A cogs_insert_turn: its (input_seconds /
-- output_seconds) legs were shaped around an audio-output-to-user pipeline
-- that is now dead. Any Spike-A rows already written stay; the function
-- itself goes so a future service_role caller can't write mis-shaped data.
-- Rollback (if we ever need to reintroduce a 2-leg path) is a one-migration
-- re-CREATE with the original signature from migration 0051.

-- 1. Drop the 2-leg Spike-A RPC (superseded) -------------------------------
-- Signature matches the CREATE in migration 0051 (the DROP+RECREATE that
-- added p_turn_number). 0040's original 10-arg signature was already
-- dropped in 0051, so there's no lingering variant to name here.

DROP FUNCTION IF EXISTS public.cogs_insert_turn(
  uuid, uuid, cogs_service, text, numeric, numeric, numeric, numeric, text, jsonb, int
);

-- 2. The α' unified voice turn RPC -----------------------------------------

CREATE FUNCTION public.cogs_insert_turn_voice(
  p_user_id                     uuid,
  p_session_id                  uuid,
  p_turn_number                 int,
  -- Leg 1: Gemini 3.1 Live audio input (user's mic seconds)
  p_gemini_audio_in_seconds     numeric,
  p_gemini_audio_in_cost        numeric,
  -- Leg 2: Gemini 3.1 Live audio-output tokens (audio discarded; tokens billed)
  p_gemini_audio_out_tokens     int,
  p_gemini_audio_out_cost       numeric,
  -- Leg 3: Cartesia TTS characters (primary billable Cartesia unit)
  p_cartesia_characters         int,
  p_cartesia_cost               numeric,
  -- Leg 4: Cartesia TTS audio-output seconds (observability + minutes cap)
  p_cartesia_audio_seconds      numeric,
  p_environment                 text,
  p_metadata                    jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  -- Caller guard: service_role bypass, else user must match p_user_id.
  -- Mirrors the guard on cogs_insert_turn (0043 + 0051).
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot insert voice turn for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_environment NOT IN ('production', 'spike_a', 'spike_b', 'dev') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment USING ERRCODE = '22023';
  END IF;
  IF p_turn_number IS NULL OR p_turn_number <= 0 THEN
    RAISE EXCEPTION 'turn_number must be positive' USING ERRCODE = '22003';
  END IF;

  -- Range guards — upper bounds generous enough to absorb long-tail turns
  -- without accepting nonsense from a buggy bridge. 3600s = 1h cap per leg.
  IF p_gemini_audio_in_seconds  < 0 OR p_gemini_audio_in_seconds  > 3600   THEN RAISE EXCEPTION 'gemini_audio_in_seconds oob'  USING ERRCODE = '22003'; END IF;
  IF p_gemini_audio_out_tokens  < 0 OR p_gemini_audio_out_tokens  > 200000 THEN RAISE EXCEPTION 'gemini_audio_out_tokens oob'  USING ERRCODE = '22003'; END IF;
  IF p_cartesia_characters      < 0 OR p_cartesia_characters      > 200000 THEN RAISE EXCEPTION 'cartesia_characters oob'     USING ERRCODE = '22003'; END IF;
  IF p_cartesia_audio_seconds   < 0 OR p_cartesia_audio_seconds   > 3600   THEN RAISE EXCEPTION 'cartesia_audio_seconds oob'  USING ERRCODE = '22003'; END IF;

  -- Cost sanity — catch a decimal-place bug before it writes $1,000 to the log.
  IF p_gemini_audio_in_cost  < 0 OR p_gemini_audio_in_cost  > 10 THEN RAISE EXCEPTION 'gemini_audio_in_cost oob'  USING ERRCODE = '22003'; END IF;
  IF p_gemini_audio_out_cost < 0 OR p_gemini_audio_out_cost > 10 THEN RAISE EXCEPTION 'gemini_audio_out_cost oob' USING ERRCODE = '22003'; END IF;
  IF p_cartesia_cost         < 0 OR p_cartesia_cost         > 10 THEN RAISE EXCEPTION 'cartesia_cost oob'         USING ERRCODE = '22003'; END IF;

  -- Leg 1: Gemini audio-in seconds -------------------------------------------
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, 'gemini', 'voice_audio_input_seconds',
     p_gemini_audio_in_seconds, 'seconds', p_gemini_audio_in_cost, p_environment,
     p_metadata || jsonb_build_object('leg', 'gemini_audio_in', 'pipeline', 'alpha_prime'))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;

  -- Leg 2: Gemini audio-output tokens (α' pays-and-discards) -----------------
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, 'gemini', 'voice_audio_out_tokens',
     p_gemini_audio_out_tokens, 'tokens', p_gemini_audio_out_cost, p_environment,
     p_metadata || jsonb_build_object('leg', 'gemini_audio_out', 'pipeline', 'alpha_prime', 'audio_discarded', true))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;

  -- Leg 3: Cartesia characters (primary Cartesia billable) ------------------
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, 'cartesia', 'voice_tts_characters',
     p_cartesia_characters, 'characters', p_cartesia_cost, p_environment,
     p_metadata || jsonb_build_object('leg', 'cartesia_tts_chars', 'pipeline', 'alpha_prime'))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;

  -- Leg 4: Cartesia audio seconds (observability only; drives minutes-per-day)
  -- cost_usd = 0 so this leg does NOT double-count against USD kill-switch.
  -- Seconds here are what the ticket-mint RPC reads to enforce daily cap.
  INSERT INTO public.cogs_log
    (user_id, session_id, turn_number, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES
    (p_user_id, p_session_id, p_turn_number, 'cartesia', 'voice_tts_audio_seconds',
     p_cartesia_audio_seconds, 'seconds', 0, p_environment,
     p_metadata || jsonb_build_object('leg', 'cartesia_tts_audio', 'pipeline', 'alpha_prime', 'observability_only', true))
  ON CONFLICT (session_id, turn_number, service, operation)
    WHERE turn_number IS NOT NULL
    DO NOTHING;
END;$$;

-- Lock down: service_role only.
REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn_voice(
  uuid, uuid, int,
  numeric, numeric,
  int, numeric,
  int, numeric,
  numeric,
  text, jsonb
) FROM public, anon, authenticated;
