-- SIMLI_WIREUP §12a.1 / R3-Missing-1 / R4-M6 — env-scoped voice_id columns.
--
-- Today: single creators.voice_id column. First local-dev clone of a
-- creator's voice → push → prod voice_id is silently overwritten with
-- the dev clone's UUID. Sev-1 the day a second creator onboards.
--
-- Fix: three columns scoped by VERCEL_ENV (production | preview | development).
-- /api/admin/voice-clone writes to the env-appropriate column;
-- /api/sessions/open reads the env-appropriate column.
--
-- R4-M6 enforces VERCEL_ENV (not NODE_ENV) — Vercel preview deploys run
-- as NODE_ENV=production, so NODE_ENV-gated code would silently let a
-- preview-branch test overwrite the prod creator's voice.
--
-- creators.voice_id is the production column (kept as-is for backward
-- compatibility with everything that already reads it). The other two
-- are new and nullable.

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS voice_id_preview text
    CHECK (voice_id_preview IS NULL OR char_length(voice_id_preview) BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS voice_id_dev     text
    CHECK (voice_id_dev     IS NULL OR char_length(voice_id_dev)     BETWEEN 1 AND 128);

COMMENT ON COLUMN public.creators.voice_id IS
  'Cartesia IVC voice UUID for VERCEL_ENV=production. NULL until an admin uploads a clone clip via /api/admin/voice-clone in production.';

COMMENT ON COLUMN public.creators.voice_id_preview IS
  'Cartesia IVC voice UUID for VERCEL_ENV=preview deploys. Isolates branch tests from prod voice ids (R4-M6).';

COMMENT ON COLUMN public.creators.voice_id_dev IS
  'Cartesia IVC voice UUID for local development (no VERCEL_ENV set, or VERCEL_ENV=development). Isolates dev tests from prod.';
