-- 0044 — Nightly purge of expired rate_limit_log buckets via pg_cron.
-- Days 6-7 feed plan §2.3. Supabase requires pg_cron to live in the
-- `extensions` schema; the extension itself must be enabled via the
-- dashboard (Database → Extensions) or a prior migration.
--
-- PREREQ (one-time, manual):
--   1. Supabase dashboard → Database → Extensions → enable `pg_cron`.
--   2. Confirm extensions.cron.job is queryable.
--
-- Fallback: if pg_cron is unavailable in the target environment, remove
-- this migration and register a Vercel Cron that hits an admin-gated
-- /api/admin/ratelimit-purge route.
--
-- rate_limit_log column is window_start (NOT created_at) — verified
-- against migration 0032.

-- Unschedule any prior registration (idempotent re-run). Wrapped in DO so
-- we don't fail if the job doesn't exist yet.
DO $guard$
BEGIN
  PERFORM cron.unschedule('rate_limit_log_purge');
EXCEPTION WHEN OTHERS THEN
  -- Job didn't exist or pg_cron not installed; ignore and proceed.
  NULL;
END;
$guard$;

-- Schedule is wrapped in DO/EXCEPTION so a project without pg_cron enabled
-- (e.g. the default local Supabase Docker image) still lands the migration
-- and every migration after it. Operator re-runs after enabling pg_cron;
-- the unschedule above makes the re-run idempotent.
DO $guard$
BEGIN
  PERFORM cron.schedule(
    'rate_limit_log_purge',
    '17 3 * * *',
    $job$ DELETE FROM public.rate_limit_log
           WHERE window_start < now() - interval '24 hours' $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; rate_limit_log_purge not scheduled. Enable pg_cron in Supabase → Database → Extensions and re-run this migration.';
END;
$guard$;
