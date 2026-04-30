-- 0504-07 — retention pg_cron (algo plan §9.7, plan doc D7_RETENTION_PG_CRON.md)
--
-- Daily 90d retention purge for feed_events_raw (preserving mic_tap forever)
-- + 30d cleanup for anon_feed_sessions orphans, scheduled via pg_cron.
--
-- DELETE on feed_events_raw is permitted (see 20260503000002_feed_events_raw.sql:51) —
-- the append-only triggers fire on UPDATE/TRUNCATE only.
--
-- Hard assumption: the migration role is superuser (or has CREATE EXTENSION
-- privilege on pg_cron). True on Supabase Cloud and Supabase local Docker.
-- On any other Postgres deploy target this migration will fail at the
-- CREATE EXTENSION line below — that is the intended signal, not a bug.

-- ── 1.1  Auto-enable + fail-fast ─────────────────────────────────────────
-- Idempotent on Supabase Cloud (already installed) and on local Supabase
-- Docker (the bundled Postgres image ships pg_cron). Fails loudly on any
-- vanilla Postgres without pg_cron available — which is the correct signal.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron required for D7 retention migration; '
      'CREATE EXTENSION above did not register the extension.';
  END IF;
END $$;

-- ── 1.2  retention_run_log table ────────────────────────────────────────
CREATE TABLE public.retention_run_log (
  id            bigserial   PRIMARY KEY,
  job_name      text        NOT NULL,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  rows_deleted  int         NOT NULL,
  duration_ms   int         NOT NULL,
  batches_run   int         NOT NULL,
  hit_cap       boolean     NOT NULL DEFAULT false
);

CREATE INDEX retention_run_log_job_time_idx
  ON public.retention_run_log (job_name, ran_at DESC);

ALTER TABLE public.retention_run_log ENABLE ROW LEVEL SECURITY;
-- Zero policies: service-role only. Reads go through admin_retention_recent_runs RPC.

REVOKE ALL ON public.retention_run_log FROM PUBLIC;
REVOKE ALL ON public.retention_run_log FROM anon;
REVOKE ALL ON public.retention_run_log FROM authenticated;
REVOKE ALL ON public.retention_run_log FROM service_role;
-- Build-audit M1: Supabase grants service_role full DML on every public.*
-- table by default, NOT via PUBLIC inheritance — REVOKE FROM PUBLIC doesn't
-- reach it. Without this explicit REVOKE, a leaked service-role key could
-- bypass admin_retention_recent_runs and read/mutate the run-log directly.
-- The cron-path INSERT runs as postgres (table owner via SECURITY DEFINER on
-- the purge functions), so this is non-breaking.

-- target_kind convention is documented here because the admin-purge wrappers
-- below introduce 'system' as a new value alongside existing 'profile' and
-- 'session'. No CHECK enforced — add one when the set stabilizes.
COMMENT ON COLUMN public.admin_audit_log.target_kind IS
  'Convention: profile | session | system. No CHECK enforced — add one when the set stabilizes.';

-- ── 1.3  purge_feed_events_raw — postgres-only raw purge ────────────────
CREATE OR REPLACE FUNCTION public.purge_feed_events_raw()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total    int := 0;
  v_n        int;
  v_batches  int := 0;
  v_hit_cap  boolean := false;
  v_started  timestamptz := clock_timestamp();
BEGIN
  -- lock_timeout MUST be set before pg_advisory_xact_lock — it applies to the
  -- lock-acquisition wait, but only if set first (build-audit B1). Without
  -- this ordering, an admin clicking the manual-purge button while cron is
  -- running would hang up to 30min holding a pooled connection.
  SET LOCAL lock_timeout      = '5s';
  SET LOCAL statement_timeout = '30min';

  -- Explicit ::bigint cast disambiguates pg_advisory_xact_lock(bigint) overload.
  -- xact-scoped is sufficient: pg_cron runs each scheduled invocation as a
  -- fresh BackgroundWorker transaction, so the lock auto-releases on return.
  PERFORM pg_advisory_xact_lock(hashtext('purge_feed_events_raw')::bigint);

  LOOP
    WITH d AS (
      SELECT id
        FROM public.feed_events_raw
       WHERE created_at < now() - interval '90 days'
         AND event_name <> 'mic_tap'
       ORDER BY created_at        -- aligns with feed_events_raw_created_at_idx
       LIMIT 10000
       FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.feed_events_raw f
     USING d
     WHERE f.id = d.id;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXIT WHEN v_n = 0;

    v_total   := v_total + v_n;
    v_batches := v_batches + 1;

    IF v_batches >= 100 THEN  -- 1M rows / run hard cap
      v_hit_cap := true;
      EXIT;
    END IF;
  END LOOP;

  IF v_hit_cap THEN
    RAISE WARNING 'purge_feed_events_raw hit batch cap (1M rows); backlog remaining';
  END IF;

  INSERT INTO public.retention_run_log
    (job_name, rows_deleted, duration_ms, batches_run, hit_cap)
    VALUES ('feed_events_raw_purge',
            v_total,
            (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
            v_batches,
            v_hit_cap);

  RETURN v_total;

EXCEPTION WHEN OTHERS THEN
  -- No log-row write here: it would roll back with the RAISE. Visibility
  -- comes from this WARNING + cron.job_run_details.return_message.
  RAISE WARNING 'purge_feed_events_raw FAILED after % batches: %', v_batches, SQLERRM;
  RAISE;
END;
$$;

ALTER FUNCTION public.purge_feed_events_raw() OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION public.purge_feed_events_raw()
  FROM PUBLIC, anon, authenticated, service_role;
-- Supabase grants service_role EXECUTE on functions by default (not via PUBLIC
-- inheritance — explicit role grant), so we must REVOKE it explicitly. The
-- on-demand admin path is admin_purge_feed_events_raw (§1.5).

COMMENT ON FUNCTION public.purge_feed_events_raw() IS
  '90d retention; preserves mic_tap forever at raw level (rollup tables also '
  'retain compressed signal) — for retention only; profile-cascade still '
  'applies, so GDPR profile deletion wipes mic_taps. Single-transaction '
  'batched purge — autovacuum does not interleave; dead tuples reclaim '
  'post-commit. Manual backlog drain: re-invoke until returns 0. NOT '
  'compatible with logical-replication subscribers without slot bookkeeping.';

-- ── 1.4  purge_anon_feed_sessions — postgres-only raw purge ─────────────
CREATE OR REPLACE FUNCTION public.purge_anon_feed_sessions()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total    int := 0;
  v_n        int;
  v_batches  int := 0;
  v_hit_cap  boolean := false;
  v_started  timestamptz := clock_timestamp();
BEGIN
  -- See purge_feed_events_raw above re: SET LOCAL lock_timeout BEFORE the
  -- advisory-lock acquisition (build-audit B1).
  SET LOCAL lock_timeout      = '5s';
  SET LOCAL statement_timeout = '30min';

  PERFORM pg_advisory_xact_lock(hashtext('purge_anon_feed_sessions')::bigint);

  LOOP
    WITH d AS (
      SELECT anon_id
        FROM public.anon_feed_sessions
       WHERE last_active_at < now() - interval '30 days'
       ORDER BY last_active_at    -- aligns with anon_feed_sessions_last_active_idx
       LIMIT 10000
       FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.anon_feed_sessions a
     USING d
     WHERE a.anon_id = d.anon_id;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXIT WHEN v_n = 0;

    v_total   := v_total + v_n;
    v_batches := v_batches + 1;

    IF v_batches >= 100 THEN
      v_hit_cap := true;
      EXIT;
    END IF;
  END LOOP;

  IF v_hit_cap THEN
    RAISE WARNING 'purge_anon_feed_sessions hit batch cap (1M rows); backlog remaining';
  END IF;

  INSERT INTO public.retention_run_log
    (job_name, rows_deleted, duration_ms, batches_run, hit_cap)
    VALUES ('anon_feed_sessions_purge',
            v_total,
            (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
            v_batches,
            v_hit_cap);

  RETURN v_total;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'purge_anon_feed_sessions FAILED after % batches: %', v_batches, SQLERRM;
  RAISE;
END;
$$;

ALTER FUNCTION public.purge_anon_feed_sessions() OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION public.purge_anon_feed_sessions()
  FROM PUBLIC, anon, authenticated, service_role;
-- See purge_feed_events_raw above re: explicit service_role REVOKE.

COMMENT ON FUNCTION public.purge_anon_feed_sessions() IS
  '30d retention on last_active_at. last_active_at is bumped on every event '
  'by ingest_feed_events_anon, so engaged anons stay alive; only true 30d-'
  'silent rows die. Trade-off: a 31d+ silent lurker returning loses pre-'
  'signup signal (merge_anon_feed_state silent no-op on missing anon_id). '
  'Companion frontend fix in src/lib/feed/anon-id.ts re-mints stale cookies '
  'so the user-visible failure mode is bounded to one client tick.';

-- ── 1.5  Admin wrappers — admin_purge_* SECURITY DEFINER, return jsonb ──
-- Wrappers return jsonb (not int) because Supabase JS does not surface
-- PostgreSQL RAISE WARNING — manual-purge UX would be blind to hit_cap.
-- The wrapper queries the run-log row the inner function just wrote and
-- materializes hit_cap into the return value.

CREATE OR REPLACE FUNCTION public.admin_purge_feed_events_raw()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_rows     int;
  v_hit_cap  boolean;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  -- Build-audit S1: if the inner purge raises (advisory lock timeout,
  -- statement_timeout), this whole tx rolls back — no admin_audit_log row,
  -- no jsonb return. Operators must check Postgres logs / cron.job_run_details
  -- to see admin click-failures. Documented limitation; autonomous-tx via
  -- dblink would close it but isn't worth the complexity for v1.
  v_rows := public.purge_feed_events_raw();

  -- Build-audit M2: ORDER BY id DESC (not ran_at) — id is bigserial, monotonic,
  -- never ties; ran_at can collide on microsecond boundaries when two admins
  -- click within the same tx-start instant.
  SELECT r.hit_cap INTO v_hit_cap
    FROM public.retention_run_log r
   WHERE r.job_name = 'feed_events_raw_purge'
   ORDER BY r.id DESC
   LIMIT 1;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
    VALUES (v_admin_id, 'admin_purge_feed_events_raw', 'system', NULL, NULL,
            jsonb_build_object('rows_deleted', v_rows, 'hit_cap', COALESCE(v_hit_cap, false)));

  RETURN jsonb_build_object('rows_deleted', v_rows, 'hit_cap', COALESCE(v_hit_cap, false));
END;
$$;

ALTER FUNCTION public.admin_purge_feed_events_raw() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.admin_purge_feed_events_raw() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_purge_feed_events_raw() TO authenticated;

COMMENT ON FUNCTION public.admin_purge_feed_events_raw() IS
  'Admin-gated on-demand wrapper around purge_feed_events_raw. Body asserts '
  'admin_roles before delegating. Writes admin_audit_log with target_kind=''system''. '
  'Returns jsonb {rows_deleted, hit_cap} so admin UI can render cap-hit banner.';

CREATE OR REPLACE FUNCTION public.admin_purge_anon_feed_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_rows     int;
  v_hit_cap  boolean;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  -- See admin_purge_feed_events_raw above re: build-audit S1 (failure-mode
  -- visibility) and M2 (ORDER BY id DESC for tie-free ordering).
  v_rows := public.purge_anon_feed_sessions();

  SELECT r.hit_cap INTO v_hit_cap
    FROM public.retention_run_log r
   WHERE r.job_name = 'anon_feed_sessions_purge'
   ORDER BY r.id DESC
   LIMIT 1;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
    VALUES (v_admin_id, 'admin_purge_anon_feed_sessions', 'system', NULL, NULL,
            jsonb_build_object('rows_deleted', v_rows, 'hit_cap', COALESCE(v_hit_cap, false)));

  RETURN jsonb_build_object('rows_deleted', v_rows, 'hit_cap', COALESCE(v_hit_cap, false));
END;
$$;

ALTER FUNCTION public.admin_purge_anon_feed_sessions() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.admin_purge_anon_feed_sessions() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_purge_anon_feed_sessions() TO authenticated;

COMMENT ON FUNCTION public.admin_purge_anon_feed_sessions() IS
  'Admin-gated on-demand wrapper around purge_anon_feed_sessions. Body '
  'asserts admin_roles before delegating. Writes admin_audit_log with '
  'target_kind=''system''. Returns jsonb {rows_deleted, hit_cap}.';

-- ── 1.6  admin_retention_recent_runs — read RPC ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_retention_recent_runs(p_limit int DEFAULT 50)
RETURNS TABLE(
  id           bigint,
  job_name     text,
  ran_at       timestamptz,
  rows_deleted int,
  duration_ms  int,
  batches_run  int,
  hit_cap      boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_admin_id uuid := auth.uid();
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'p_limit must be 1..500' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT r.id, r.job_name, r.ran_at, r.rows_deleted,
           r.duration_ms, r.batches_run, r.hit_cap
      FROM public.retention_run_log r
     ORDER BY r.ran_at DESC
     LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.admin_retention_recent_runs(int) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.admin_retention_recent_runs(int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_retention_recent_runs(int) TO authenticated;

COMMENT ON FUNCTION public.admin_retention_recent_runs(int) IS
  'Admin-gated read of retention_run_log. Mirrors the D6 admin_algo_* '
  'pattern: SECURITY DEFINER + admin_roles check + REVOKE-then-GRANT to '
  'authenticated. Body validates p_limit in 1..500.';

-- ── 1.7  Cron registration ──────────────────────────────────────────────
-- unschedule wrapped in DO/EXCEPTION so re-running the migration is
-- idempotent when the named jobs already exist or never existed.
DO $guard$
BEGIN
  PERFORM cron.unschedule('feed_events_raw_purge');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule of feed_events_raw_purge skipped: %', SQLERRM;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.unschedule('anon_feed_sessions_purge');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule of anon_feed_sessions_purge skipped: %', SQLERRM;
END;
$guard$;

-- schedule is NOT wrapped in EXCEPTION (round-3 C4): a failure here must be
-- surfaced loudly. The §1.1 precondition guarantees pg_cron exists.
SELECT cron.schedule(
  'feed_events_raw_purge',
  '0 9 * * *',            -- 09:00 UTC = 5 AM EST / 1 AM PST (pre-commute, off-peak)
  $job$ SELECT public.purge_feed_events_raw(); $job$
);
SELECT cron.schedule(
  'anon_feed_sessions_purge',
  '0 10 * * *',           -- 10:00 UTC = 6 AM EST / 2 AM PST (1h gap from feed purge)
  $job$ SELECT public.purge_anon_feed_sessions(); $job$
);
