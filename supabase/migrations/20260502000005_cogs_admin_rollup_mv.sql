-- 0502000005 — cogs_log_admin_rollup materialized view + pg_cron refresh.
-- Day 14 AM, Migration 5. Plan refs: M3-R1, M2-R2, R3-C5.
--
-- Why a materialized view: /api/admin/cogs polls every 30s. Scanning cogs_log
-- live aggregates at 100K+ rows/day becomes index-stale slow. The rollup is
-- keyed by (minute, service, environment) — drops the admin query to <20ms.
--
-- Why CONCURRENTLY: non-concurrent REFRESH takes an ACCESS EXCLUSIVE lock for
-- the whole view → admin reads block while the cron fires. CONCURRENTLY
-- requires a UNIQUE INDEX on the MV (R3-C5), so we define one below.
--
-- Grants: owner postgres, zero grants to PUBLIC / anon / authenticated. The
-- admin routes read via the service-role client. (R2-M2)

-- ── Materialized view ─────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW public.cogs_log_admin_rollup AS
SELECT
  date_trunc('minute', created_at) AS bucket_ts,
  service,
  environment,
  sum(cost_usd)::numeric(14,6) AS cost_usd,
  sum(units)::numeric(16,4)    AS units,
  count(*)::bigint             AS row_count
FROM public.cogs_log
GROUP BY 1, 2, 3;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY (R3-C5).
CREATE UNIQUE INDEX cogs_log_admin_rollup_uq
  ON public.cogs_log_admin_rollup (bucket_ts, service, environment);

CREATE INDEX cogs_log_admin_rollup_bucket_idx
  ON public.cogs_log_admin_rollup (bucket_ts DESC);

-- Initial populate (non-concurrent; CONCURRENTLY requires a prior populated
-- refresh, and the view is empty on creation).
REFRESH MATERIALIZED VIEW public.cogs_log_admin_rollup;

-- Lockdown: owner postgres, no grants to client roles. Admin routes go
-- through the service-role client. (R2-M2)
ALTER MATERIALIZED VIEW public.cogs_log_admin_rollup OWNER TO postgres;
REVOKE ALL ON public.cogs_log_admin_rollup FROM PUBLIC;
REVOKE ALL ON public.cogs_log_admin_rollup FROM anon;
REVOKE ALL ON public.cogs_log_admin_rollup FROM authenticated;

-- ── pg_cron: refresh every 60s ────────────────────────────────────────────
--
-- PREREQ (one-time, manual): Supabase dashboard → Database → Extensions →
-- enable `pg_cron`. If unavailable, substitute a Vercel Cron hitting an
-- admin-gated /api/admin/cogs-refresh route.
--
-- Idempotent unschedule guard — pattern copied from 20260425000003.
-- Both unschedule AND schedule are wrapped in DO/EXCEPTION so a project
-- without pg_cron enabled still lands the migration (MV + grants). Operator
-- re-runs after enabling pg_cron; the DO blocks are idempotent.

DO $guard$
BEGIN
  PERFORM cron.unschedule('cogs_rollup_refresh');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.schedule(
    'cogs_rollup_refresh',
    '* * * * *',
    $job$ REFRESH MATERIALIZED VIEW CONCURRENTLY public.cogs_log_admin_rollup $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; cogs_rollup_refresh not scheduled. Enable pg_cron in Supabase → Database → Extensions and re-run this migration.';
END;
$guard$;
