-- FISH_AUDIO_PHASE_1 dispatchFish audit C1 — provider-agnostic charset +
-- length CHECK on voice_delete_queue.voice_id.
--
-- Pre-audit: voice_delete_queue.voice_id is plain `text` (since
-- 20260505000003_voice_delete_queue.sql, never constrained). The writer
-- discipline at admin/voice-clone routes enforces UUID shapes today, but
-- a future writer (Fish admin clone-upload UI, an admin SQL paste, or a
-- bug in mint flow) could push a garbage value into the queue.
--
-- Why this matters for GDPR (dispatchFish audit C1):
--   * dispatchFish calls `DELETE https://api.fish.audio/model/<id>`.
--   * Fish returns 404 for unknown ids → worker treats 404 as success →
--     dequeues the row.
--   * If `voice_id` was garbage (empty / spaces / wrong shape), the real
--     creator data may still be on Fish's servers. The dequeue claims
--     compliance for a delete that never targeted the right model.
--
-- The CHECK is intentionally LOOSE — [A-Za-z0-9_-] permits:
--   * Fish 32-char hex (e.g. baa1fcbdb14d4bb492af632c1cb17ace)
--   * Cartesia + Hume UUIDs (36 chars with hyphens)
--   * Future opaque-token shapes that fit the same alphabet
--
-- Permissive enough to not block legitimate provider id shapes; strict
-- enough to catch empty/whitespace/path-traversal/multibyte garbage that
-- would otherwise silently dequeue.
--
-- Pre-flight backfill check: assert no existing rows violate the
-- constraint before adding it (would block ADD CONSTRAINT). Cartesia +
-- Hume UUIDs all satisfy [A-Za-z0-9_-]; if a stale row from a prior
-- writer bug exists, this DO block surfaces it with the offending row's
-- voice_id so the operator can inspect + repair before re-running.

DO $$
DECLARE
  v_bad_count int;
BEGIN
  SELECT count(*) INTO v_bad_count
    FROM public.voice_delete_queue
   WHERE voice_id IS NULL
      OR char_length(voice_id) NOT BETWEEN 1 AND 128
      OR voice_id !~ '^[A-Za-z0-9_-]+$';
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'voice_delete_queue has % rows whose voice_id violates the new charset/length CHECK — inspect via: SELECT tts_provider, voice_id FROM public.voice_delete_queue WHERE voice_id IS NULL OR char_length(voice_id) NOT BETWEEN 1 AND 128 OR voice_id !~ ''^[A-Za-z0-9_-]+$'';',
      v_bad_count;
  END IF;
END $$;

ALTER TABLE public.voice_delete_queue
  DROP CONSTRAINT IF EXISTS voice_delete_queue_voice_id_shape;
ALTER TABLE public.voice_delete_queue
  ADD CONSTRAINT voice_delete_queue_voice_id_shape
  CHECK (
    voice_id IS NOT NULL
    AND char_length(voice_id) BETWEEN 1 AND 128
    AND voice_id ~ '^[A-Za-z0-9_-]+$'
  );

COMMENT ON CONSTRAINT voice_delete_queue_voice_id_shape ON public.voice_delete_queue IS
  'FISH_AUDIO_PHASE_1 dispatchFish audit C1 — refuses empty/whitespace/path-traversal/multibyte garbage at the queue boundary so the worker never silently dequeues a GDPR delete that targeted the wrong (or nothing) model.';

NOTIFY pgrst, 'reload schema';
