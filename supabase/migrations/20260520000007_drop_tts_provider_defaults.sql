-- HUME_TTS_PLAN §5.5 follow-up — drop the temporary DEFAULT 'cartesia' on
-- tts_provider columns now that every writer (Cartesia route, Hume paste
-- route, voice-delete-worker, mint-voice-ticket §6 — when that lands)
-- passes the value explicitly.
--
-- Why this migration exists: §3.2 + §5 staged ADD COLUMN with a temporary
-- DEFAULT so the migration could land first and existing routes kept
-- working. §5.5 patched every writer site to pass tts_provider explicitly
-- AND CI grep (scripts/check-tts-provider-writes.sh) gates new writers.
-- Dropping the DEFAULT now means any FUTURE writer that forgets gets a
-- 23502 NOT NULL violation immediately, instead of silently mis-tagging
-- rows as 'cartesia'.
--
-- Ordering (CRITICAL):
--   1. §3.2 + §5 migrations landed with DEFAULT 'cartesia' ✓
--   2. §5.5 route patches landed (Cartesia + Hume routes pass explicitly) ✓
--   3. CI grep gates new writers ✓
--   4. THIS migration drops the DEFAULT ← only safe NOW
--
-- voice_tickets.tts_provider also carries a DEFAULT (added in 0002 for
-- the M1 atomic-NOT-NULL fix). The §6 PR will patch mint-voice-ticket
-- to pass tts_provider explicitly, then a future migration drops THAT
-- DEFAULT too. NOT touched here because §6 hasn't shipped yet.

-- §5 audit S5 fix (2026-05-13): sanity-check that no NULL rows exist
-- BEFORE dropping the DEFAULT. The NOT NULL constraint catches future
-- inserts, but existing NULL rows from a hypothetical CI-grep-escape
-- would persist silently. ASSERT raises if any NULL is present so the
-- migration can't ship with hidden data corruption.
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.voice_clone_uploads WHERE tts_provider IS NULL),
    'voice_clone_uploads has NULL tts_provider rows — CI grep escape detected; backfill before dropping DEFAULT';
  ASSERT NOT EXISTS (SELECT 1 FROM public.voice_delete_queue WHERE tts_provider IS NULL),
    'voice_delete_queue has NULL tts_provider rows — CI grep escape detected; backfill before dropping DEFAULT';
END $$;

ALTER TABLE public.voice_clone_uploads
  ALTER COLUMN tts_provider DROP DEFAULT;

ALTER TABLE public.voice_delete_queue
  ALTER COLUMN tts_provider DROP DEFAULT;

COMMENT ON COLUMN public.voice_clone_uploads.tts_provider IS
  'Which TTS provider this clone targets. NOT NULL with NO DEFAULT — every writer site must pass explicitly (HUME_TTS_PLAN §5.5; CI grep enforces).';
COMMENT ON COLUMN public.voice_delete_queue.tts_provider IS
  'Which provider DELETE to dispatch. NOT NULL with NO DEFAULT — every enqueue site must pass explicitly. Cartesia: DELETE /voices/{voice_id}; Hume: DELETE /v0/tts/voices?name=<voice_name>.';

NOTIFY pgrst, 'reload schema';
