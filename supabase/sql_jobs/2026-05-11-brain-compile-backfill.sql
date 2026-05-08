-- 2026-05-11 brain-compile backfill
--
-- Populates creators.system_prompt for every published creator that
-- doesn't already have one populated, OR whose persona is stale relative
-- to creator_topics + sample_content updates.
--
-- Runs as postgres superuser via Supabase SQL job runner. _unsafe is
-- callable here because the function is owned by postgres (SECURITY
-- DEFINER's owner-privilege chain). service_role callers also work via
-- the explicit GRANT in migration 20260511000002.
--
-- Audit-driven design:
--   * R3 M3 — skip brain_status='errored' rows (don't clobber prior failures)
--   * R3 small — chunked DO-block with pg_sleep(0.1) per 100 rows; at
--     >5K creators consider swapping to a paced job runner.
--   * R-PR1 M2 — per-row exception block so one corrupt creator
--     (e.g., NULL title in creator_topics breaking string_agg) doesn't
--     abort the whole loop and waste prior progress.
--   * R-PR1 M3 — re-runs are idempotent at the data level; this
--     backfill skips creators whose persona is already fresh
--     (system_prompt populated AND brain_compiled_at >= max topic/sample
--     updated_at). Avoids false-churn on dashboards that key off
--     brain_compiled_at.
--
-- Verification (run after the DO-block):
--   SELECT count(*) FILTER (WHERE system_prompt IS NULL) AS null_prompts,
--          count(*) AS total
--     FROM creators
--    WHERE published_at IS NOT NULL AND brain_status <> 'errored';
--   -- null_prompts MUST be 0.

DO $$
DECLARE
  r record;
  i_ok    int := 0;
  i_skip  int := 0;
  i_fail  int := 0;
  v_max_dep timestamptz;
BEGIN
  FOR r IN
    SELECT id FROM creators
     WHERE published_at IS NOT NULL
       AND brain_status <> 'errored'
     ORDER BY id
  LOOP
    -- Staleness gate: skip when persona is already fresh.
    SELECT GREATEST(
      COALESCE((SELECT max(updated_at) FROM creator_topics WHERE creator_id = r.id), 'epoch'::timestamptz),
      COALESCE((SELECT max(updated_at) FROM sample_content  WHERE creator_id = r.id), 'epoch'::timestamptz)
    ) INTO v_max_dep;
    IF EXISTS (
      SELECT 1 FROM creators
       WHERE id = r.id
         AND system_prompt IS NOT NULL
         AND brain_compiled_at IS NOT NULL
         AND brain_compiled_at >= v_max_dep
    ) THEN
      i_skip := i_skip + 1;
      CONTINUE;
    END IF;

    -- Per-row exception block — one bad creator doesn't abort the loop.
    BEGIN
      PERFORM _creator_brain_compile_unsafe(r.id);
      i_ok := i_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      i_fail := i_fail + 1;
      RAISE NOTICE 'creator % compile failed: % (%)', r.id, SQLERRM, SQLSTATE;
    END;

    IF (i_ok + i_fail) % 100 = 0 THEN
      PERFORM pg_sleep(0.1);
    END IF;
  END LOOP;
  RAISE NOTICE 'brain-compile backfill: % compiled, % skipped (already fresh), % failed', i_ok, i_skip, i_fail;
END $$;
