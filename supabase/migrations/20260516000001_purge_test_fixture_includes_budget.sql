-- 20260516000001 — Day-3 integration-audit M3 fix.
--
-- Extends `purge_test_fixture_rag_data()` to also wipe accumulated
-- `creator_embedding_budget` rows for test-fixture creators.
--
-- Bug being fixed: the original purge DELETEs sample_content (CASCADE
-- handles chunks/units/embedding_jobs/reprocess_jobs) but leaves the
-- creator row in place — that's by design, so the next test run finds
-- the same stable-UUID creator. However, `creator_embedding_budget` is
-- a separate table FK'd to creators (ON DELETE CASCADE), keyed on
-- `(creator_id, budget_date)`. Repeated same-day runs of RUN_REAL_API_TESTS=1
-- accumulate spend in this table. After ~3 same-day runs the fixture hits
-- the $10 daily cap and the embed-worker short-circuits with
-- `creator_daily_budget_blown_preflight` — the test passes its assertions
-- against empty chunks and silently masks regressions.
--
-- Fix: in the purge, after sample_content DELETE, also DELETE budget rows
-- for any test-fixture creator. Same staging-only guard applies.
--
-- Why a separate migration (not editing 20260515000003): migrations are
-- immutable once applied. CREATE OR REPLACE on the function body is the
-- standard forward-only fix.

CREATE OR REPLACE FUNCTION public.purge_test_fixture_rag_data() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_env           text;
  v_creators_n    int;
  v_samples_n     int;
  v_budget_n      int;
BEGIN
  -- Same staging-only guard as the original (audit-3 M4 #2).
  v_env := current_setting('app.environment', true);
  IF v_env IS NULL OR v_env <> 'staging' THEN
    RAISE EXCEPTION
      'purge_test_fixture_rag_data refused: app.environment is %, expected ''staging''',
      coalesce(v_env, '<unset>')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Delete upstream sample_content rows; CASCADE handles chunks / narrative
  -- units / embedding_jobs / corpus_reprocess_jobs.
  DELETE FROM public.sample_content
   WHERE creator_id IN (SELECT id FROM public.creators WHERE is_test_fixture);
  GET DIAGNOSTICS v_samples_n = ROW_COUNT;

  -- Day-3 integration-audit M3 fix: also wipe accumulated budget so
  -- repeated same-day test runs don't trip the daily cap and silently
  -- skip embedding work.
  DELETE FROM public.creator_embedding_budget
   WHERE creator_id IN (SELECT id FROM public.creators WHERE is_test_fixture);
  GET DIAGNOSTICS v_budget_n = ROW_COUNT;

  SELECT count(*) INTO v_creators_n
    FROM public.creators WHERE is_test_fixture;

  RAISE NOTICE 'purge_test_fixture_rag_data: removed % samples + % budget rows across % test fixtures',
    v_samples_n, v_budget_n, v_creators_n;

  RETURN v_samples_n;
END;$$;

-- ACLs survive CREATE OR REPLACE on the body but be defensive: re-apply.
REVOKE ALL ON FUNCTION public.purge_test_fixture_rag_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_test_fixture_rag_data() TO service_role;
