-- HUME_TTS_PLAN §6 auditor M1 (2026-05-13) — pin voice-id env on the ticket.
--
-- Pre-audit: the proxy read `process.env.VOICE_ID_ENV` to pick which of the
-- three env-scoped voice columns to query (`voice_id` vs `_preview` vs
-- `_dev`). The env var was undocumented, defaulted to 'production', and had
-- no provisioning story — a preview-deploy Fly machine would silently
-- target the production voice column.
--
-- Fix (ticket-as-contract pattern, Vuk-M5 precedent): the Vercel route
-- knows VERCEL_ENV authoritatively. Pin it onto the voice_ticket at mint
-- time. The proxy's consumeTicket() reads it from the ticket — no env-var
-- assumptions, no proxy-side fallback. A future swap (e.g., Hume staging
-- env) just sets the right value on the route side; proxy code untouched.
--
-- Column is nullable for the migration window — pre-migration tickets carry
-- NULL; the proxy treats NULL as 'production' (the historical default).
-- After §6 ships and all old tickets have been consumed/expired (TTL=120s),
-- a follow-up migration tightens to NOT NULL.

ALTER TABLE public.voice_tickets
  ADD COLUMN IF NOT EXISTS voice_id_env text
    CHECK (voice_id_env IS NULL OR voice_id_env IN ('production', 'preview', 'development'));

COMMENT ON COLUMN public.voice_tickets.voice_id_env IS
  'VERCEL_ENV at mint time. Drives which env-scoped voice column the proxy reads. NULL on pre-migration tickets — proxy defaults to ''production''.';

NOTIFY pgrst, 'reload schema';
