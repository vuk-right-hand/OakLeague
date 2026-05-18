-- ─────────────────────────────────────────────────────────────────────────
-- HUME_TTS_PLAN follow-up — env split for hume_tts_speed
-- ─────────────────────────────────────────────────────────────────────────
--
-- Migration 20260520000002_hume_voice_provider.sql added env-split variants
-- (_preview, _dev) for hume_trailing_silence, hume_voice_description, and
-- hume_model_version — but skipped the same split for hume_tts_speed.
--
-- The admin RPC creator_set_hume_prosody (20260520000011) and the admin
-- detail page (src/app/admin/creators/[id]/page.tsx) both expect all four
-- dials to be env-split. Without the missing columns:
--   * page SELECT 400s on hume_tts_speed_preview/_dev → notFound() → 404
--   * RPC UPDATE 42703s on _preview/_dev in non-prod env
--
-- IF NOT EXISTS keeps this idempotent and safe to re-run.
-- Same CHECK constraint as the base column (0.5..2.0 or NULL).
--
-- Audit C3 — deploy-ordering guard. This migration is a follow-up to
-- 20260520000002 (which created the base `hume_tts_speed` column). On a
-- FRESH prod apply both land for the first time; if 20260520000002 fails
-- or is skipped, silently adding the env-split columns here would leave a
-- half-built schema and the admin creator page (which SELECTs all four
-- dials and notFound()s on any select error) would 404 for EVERY creator.
-- Fail loud at migration time instead. Mirrors the pre-flight DO-block
-- pattern used in 20260520000003.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'creators'
      AND column_name = 'hume_tts_speed'
  ) THEN
    RAISE EXCEPTION
      'creators.hume_tts_speed (base column) missing — 20260520000002 must apply before 20260522000001. Migration order is broken; refusing to half-build the env-split schema.';
  END IF;
END $$;

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS hume_tts_speed_preview numeric
    CHECK (hume_tts_speed_preview IS NULL OR (hume_tts_speed_preview >= 0.5 AND hume_tts_speed_preview <= 2.0)),
  ADD COLUMN IF NOT EXISTS hume_tts_speed_dev     numeric
    CHECK (hume_tts_speed_dev     IS NULL OR (hume_tts_speed_dev     >= 0.5 AND hume_tts_speed_dev     <= 2.0));

COMMENT ON COLUMN public.creators.hume_tts_speed_preview IS
  'Hume TTS speed dial (0.5–2.0, NULL = Hume default) for Vercel preview deploys. See hume_tts_speed.';
COMMENT ON COLUMN public.creators.hume_tts_speed_dev IS
  'Hume TTS speed dial (0.5–2.0, NULL = Hume default) for local/dev. See hume_tts_speed.';
