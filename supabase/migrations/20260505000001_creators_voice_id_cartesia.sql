-- R3-M5 / R4 — repurpose creators.voice_id as the Cartesia IVC voice UUID.
--
-- Pre-flight: voice_id was a free-text column in 0011 with no callers
-- writing real values yet (verified: only the admin creator-detail page
-- reads it). Repurposing now is safe IFF every existing row is NULL.
-- The DO block raises if any non-NULL row exists so a stray write
-- doesn't get silently relabeled.
--
-- Adds:
--   * COMMENT documenting the new contract.
--   * CHECK constraint pinning voice_id length to [1, 128] (matches
--     voice_clone_uploads.cartesia_voice_id shape from 0047).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.creators WHERE voice_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'creators.voice_id has non-NULL rows; cannot repurpose without a backfill plan';
  END IF;
END $$;

COMMENT ON COLUMN public.creators.voice_id IS
  'Cartesia IVC voice UUID set by voice_clone_finalize RPC. NULL until an admin uploads a clone clip via /api/admin/voice-clone.';

ALTER TABLE public.creators
  ADD CONSTRAINT creators_voice_id_shape
    CHECK (voice_id IS NULL OR char_length(voice_id) BETWEEN 1 AND 128);
