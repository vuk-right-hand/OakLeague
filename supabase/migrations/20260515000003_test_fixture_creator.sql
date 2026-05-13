-- 20260515000003 — is_test_fixture flag + staging-only daily purge.
--
-- M7 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3, audit-2 M7 +
-- audit-3 M4 staging-only guard).
--
-- Adds `creators.is_test_fixture boolean`. Test fixtures used by
-- RUN_REAL_API_TESTS=1 integration tests UPSERT a stable-UUID creator with
-- is_test_fixture=true; teardown leaves chunks in place; cron purges them
-- nightly so the next run starts clean.
--
-- ─── Audit-3 M4 / audit-4 follow-up ──────────────────────────────────────────
-- The purge runs on staging ONLY. Two guards:
--   1. The cron.schedule registration call is wrapped in
--      `IF current_setting('app.environment', true) = 'staging' THEN ... END IF`.
--      Production never registers the schedule in the first place.
--   2. The purge proc opens with a sanity check on the same setting and
--      RAISEs if invoked anywhere other than staging. Belt-and-suspenders:
--      even if the schedule somehow gets created on prod (manual SQL,
--      restored staging snapshot, etc.), the proc itself refuses to run.
--
-- The Supabase `app.environment` GUC is set per-cluster as a Day-0 admin
-- task documented in docs/_planning/RAG_SOTA_PLAN.md §10:
--   * production cluster: ALTER DATABASE ... SET app.environment = 'production'
--   * staging cluster:    ALTER DATABASE ... SET app.environment = 'staging'
-- The migration's hard-fail-on-missing-setting is intentional — if the GUC
-- isn't set, we don't know whether to register the cron, so we don't.

ALTER TABLE public.creators
  ADD COLUMN is_test_fixture boolean NOT NULL DEFAULT false;

CREATE INDEX creators_is_test_fixture_idx
  ON public.creators (is_test_fixture)
  WHERE is_test_fixture = true;

COMMENT ON COLUMN public.creators.is_test_fixture IS
  'Marks creator as a real-API integration-test fixture. Daily staging-only pg_cron purges this creator''s sample_content + chunks + narrative_units + corpus_reprocess_jobs so RUN_REAL_API_TESTS=1 starts clean each night. NEVER set true in production.';


-- ── Purge proc ───────────────────────────────────────────────────────────────

CREATE FUNCTION public.purge_test_fixture_rag_data() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_env           text;
  v_creators_n    int;
  v_samples_n     int;
BEGIN
  -- Audit-3 M4 guard #2: refuse to run anywhere other than staging.
  -- current_setting(name, missing_ok=true) returns NULL if the GUC isn't set.
  v_env := current_setting('app.environment', true);
  IF v_env IS NULL OR v_env <> 'staging' THEN
    RAISE EXCEPTION
      'purge_test_fixture_rag_data refused: app.environment is %, expected ''staging''',
      coalesce(v_env, '<unset>')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Delete the upstream sample_content rows; CASCADE handles:
  --   * sample_content_chunks (FK CASCADE from 20260512000003)
  --   * sample_content_narrative_units (FK CASCADE from 20260514000002)
  --   * sample_content_embedding_jobs (FK CASCADE from 20260512000004)
  --   * corpus_reprocess_jobs (FK CASCADE from 20260515000001)
  DELETE FROM public.sample_content
   WHERE creator_id IN (SELECT id FROM public.creators WHERE is_test_fixture);
  GET DIAGNOSTICS v_samples_n = ROW_COUNT;

  -- Count surviving test fixtures for the audit log.
  SELECT count(*) INTO v_creators_n
    FROM public.creators WHERE is_test_fixture;

  RAISE NOTICE 'purge_test_fixture_rag_data: removed % samples across % test fixtures',
    v_samples_n, v_creators_n;

  RETURN v_samples_n;
END;$$;

REVOKE ALL ON FUNCTION public.purge_test_fixture_rag_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_test_fixture_rag_data() TO service_role;


-- ── Staging-only pg_cron schedule (audit-3 M4 guard #1 + audit-5 C3) ────────
--
-- Audit-5 C3 fix: idempotently unschedule before re-registering. Without this,
-- a snapshot restore (staging promoted from prod-snapshot, PITR drill, etc)
-- can leave a dangling schedule registered on a cluster whose GUC later moves
-- away from 'staging' — pg_cron does NOT auto-disable failing schedules, so
-- the proc would daily raise insufficient_privilege into cron.job_run_details.
-- Idempotent unschedule lets every migration re-apply produce a clean state.

DO $$
DECLARE
  v_env text;
BEGIN
  -- Always try to unschedule first. If pg_cron is absent the parent
  -- DO-block handles undefined_function below; if the schedule doesn't
  -- exist, pg_cron raises a "could not find valid entry" message and we
  -- swallow that specifically (narrow per audit-6 small — no global
  -- WHEN OTHERS that would mask actual deploy bugs).
  BEGIN
    PERFORM cron.unschedule('purge_test_fixture_rag_data');
  EXCEPTION
    WHEN undefined_function THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%could not find valid entry%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
  END;

  v_env := current_setting('app.environment', true);

  IF v_env IS NULL THEN
    RAISE NOTICE 'purge_test_fixture_rag_data: app.environment GUC not set; skipping cron registration. Set ALTER DATABASE ... SET app.environment = ''staging'' on staging cluster only, then re-run this migration.';
    RETURN;
  END IF;

  IF v_env <> 'staging' THEN
    RAISE NOTICE 'purge_test_fixture_rag_data: app.environment is %, skipping cron registration (staging-only).', v_env;
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.schedule(
      'purge_test_fixture_rag_data',
      '0 4 * * *',  -- 4am UTC daily
      $sched$SELECT public.purge_test_fixture_rag_data();$sched$
    );
    RAISE NOTICE 'purge_test_fixture_rag_data: scheduled daily 4am UTC on staging.';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'pg_cron not installed; staging tests must invoke purge_test_fixture_rag_data() manually before each run.';
  END;
END$$;
