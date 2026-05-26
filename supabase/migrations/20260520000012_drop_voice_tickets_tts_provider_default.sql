-- HUME_TTS_PLAN unit-wide audit M2 (2026-05-13).
--
-- Migration 0007 explicitly skipped dropping the DEFAULT on
-- `voice_tickets.tts_provider` because §6 mint code wasn't shipped yet.
-- §6 is shipped. The DEFAULT is now dead weight AND a hidden landmine:
-- a future writer-site PR that drops the literal `tts_provider:` key
-- would silently land cartesia rows on what should be Hume sessions.
-- The CI grep at scripts/check-tts-provider-writes.sh is the gate, but
-- a DB DEFAULT undermines what the CI is trying to enforce — explicit
-- writes only.
--
-- Sanity pre-flight: assert every voice_tickets row has tts_provider set
-- (should be true since 0002 wrote NOT NULL with backfill).

DO $$
DECLARE
  v_nulls bigint;
BEGIN
  SELECT count(*) INTO v_nulls FROM public.voice_tickets WHERE tts_provider IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'migration 0012 pre-flight failed: voice_tickets has % rows with tts_provider IS NULL', v_nulls;
  END IF;
END $$;

ALTER TABLE public.voice_tickets ALTER COLUMN tts_provider DROP DEFAULT;

NOTIFY pgrst, 'reload schema';
