-- 20260515000002 — RAG v2 invariant check at migration time.
--
-- M6 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3, audit-3 S3:
-- renamed from "pre_flight_audit" since this runs at migration apply, not
-- as a per-reprocess guard).
--
-- Validates the v1 → v2 coexistence invariants on the current schema and
-- logs counts as a migration-history audit trail. Hard-fails if:
--   * Any NON-TEST creator has retrieval_version=2 (audit-5 M4: test fixtures
--     legitimately flip to v2 mid-integration-test; restoring a staging
--     snapshot then re-running this migration would otherwise hard-fail
--     forever. Exclusion is gated on is_test_fixture column existing —
--     this migration runs BEFORE 20260515000003 which adds the column — so
--     we use information_schema to defensively check.)
--   * Any v2 chunks exist (chunker_version=2 with no v2 narrative_unit
--     ancestry — shouldn't happen given _insert_chunk_v2_unsafe is the
--     only insertion path and it requires parent_unit_id).
--
-- Logs current counts as RAISE NOTICE so the migration log carries the
-- baseline going into Phase 1 reprocess work.

DO $$
DECLARE
  v_creators_total       bigint;
  v_creators_v1          bigint;
  v_creators_v2          bigint;
  v_creators_v2_real     bigint;   -- v2 NOT counting test fixtures
  v_creators_drawer      bigint;
  v_creators_vector      bigint;
  v_chunks_total         bigint;
  v_chunks_v1            bigint;
  v_chunks_v2            bigint;
  v_chunks_v2_no_parent  bigint;
  v_narrative_units      bigint;
  v_has_test_fixture_col boolean;
BEGIN
  -- Audit-6 M5 fix: explicit search_path on the DO block. Migrations run as
  -- superuser; DO blocks lack the SET clause of CREATE FUNCTION. Schema-
  -- qualifying every reference below covers it today, but a future
  -- maintainer dropping the `public.` qualifier shouldn't accidentally
  -- resolve `creators` against a foreign schema.
  SET LOCAL search_path = public, pg_temp;

  -- audit-5 M4: detect whether is_test_fixture column exists. This migration
  -- runs BEFORE 20260515000003 adds the column; in a fresh-deploy scenario
  -- the column won't exist and v_creators_v2 = v_creators_v2_real. In a
  -- snapshot-restore scenario where the column already exists, the exclusion
  -- kicks in and prevents permanent migrate-fail on test-fixture rows at v2.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='creators' AND column_name='is_test_fixture'
  ) INTO v_has_test_fixture_col;

  -- Audit-5 S4 fix: drop unnecessary `FILTER (WHERE true)` on the total count.
  SELECT
    count(*),
    count(*) FILTER (WHERE retrieval_version = 1),
    count(*) FILTER (WHERE retrieval_version = 2),
    count(*) FILTER (WHERE brain_mode = 'drawer'),
    count(*) FILTER (WHERE brain_mode = 'vector')
  INTO v_creators_total, v_creators_v1, v_creators_v2, v_creators_drawer, v_creators_vector
  FROM public.creators;

  IF v_has_test_fixture_col THEN
    EXECUTE 'SELECT count(*) FROM public.creators WHERE retrieval_version = 2 AND is_test_fixture = false'
      INTO v_creators_v2_real;
  ELSE
    v_creators_v2_real := v_creators_v2;
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE chunker_version = 1),
    count(*) FILTER (WHERE chunker_version = 2),
    count(*) FILTER (WHERE chunker_version = 2 AND parent_unit_id IS NULL)
  INTO v_chunks_total, v_chunks_v1, v_chunks_v2, v_chunks_v2_no_parent
  FROM public.sample_content_chunks;

  SELECT count(*) INTO v_narrative_units
    FROM public.sample_content_narrative_units;

  RAISE NOTICE 'rag_v2_invariant_check: creators total=% drawer=% vector=% retrieval_v1=% retrieval_v2=% retrieval_v2_real=% has_test_fixture_col=%',
    v_creators_total, v_creators_drawer, v_creators_vector, v_creators_v1, v_creators_v2, v_creators_v2_real, v_has_test_fixture_col;
  RAISE NOTICE 'rag_v2_invariant_check: chunks total=% v1=% v2=% v2_orphaned=% narrative_units=%',
    v_chunks_total, v_chunks_v1, v_chunks_v2, v_chunks_v2_no_parent, v_narrative_units;

  -- Invariant 1: no NON-TEST creator should be at retrieval_version=2 yet.
  -- Phase 1 has just landed the schema; no admin has run the flip RPC; no
  -- real reprocess has completed. Test-fixture creators (audit-5 M4 exclusion)
  -- are allowed to be at v2 — they get flipped + reset every night by the
  -- staging purge. If this trips, investigate before continuing.
  IF v_creators_v2_real > 0 THEN
    RAISE EXCEPTION
      'rag_v2_invariant_check FAIL: % NON-TEST creators at retrieval_version=2 before Phase 1 reprocess complete. Investigate before continuing.',
      v_creators_v2_real
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Invariant 2: any chunker_version=2 chunk must have a parent_unit_id.
  -- _insert_chunk_v2_unsafe (the only insert path) enforces this; defensive.
  IF v_chunks_v2_no_parent > 0 THEN
    RAISE EXCEPTION
      'rag_v2_invariant_check FAIL: % chunker_version=2 chunks have NULL parent_unit_id. Check direct INSERTs that bypassed _insert_chunk_v2_unsafe.',
      v_chunks_v2_no_parent
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
