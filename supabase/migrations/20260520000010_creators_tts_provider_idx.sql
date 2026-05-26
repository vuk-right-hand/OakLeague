-- HUME_TTS_PLAN §6 auditor M2 (2026-05-13) — partial index on
-- creators.tts_provider for the proxy boot-time override probe.
--
-- The proxy's provisionPricing() runs `SELECT id FROM creators WHERE
-- tts_provider='hume' LIMIT 1` at every Fly boot to decide whether Hume
-- pricing must be validated. Without an index this is a seq scan over the
-- entire creators table — cheap at 1 row, wasteful at scale, and degrades
-- silently as creator count grows.
--
-- Partial index: only rows with a non-NULL override are indexed (most
-- creators inherit env and have NULL). The probe filter exactly matches
-- the index predicate, so Postgres uses an index-only scan with a tiny
-- footprint.

CREATE INDEX IF NOT EXISTS creators_tts_provider_override_idx
  ON public.creators (tts_provider)
  WHERE tts_provider IS NOT NULL;

COMMENT ON INDEX public.creators_tts_provider_override_idx IS
  'HUME_TTS_PLAN §6 audit M2 — supports the proxy boot probe for any creator with a non-default tts_provider override.';
