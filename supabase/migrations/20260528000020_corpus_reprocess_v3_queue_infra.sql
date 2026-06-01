-- 20260528000020 — corpus_reprocess v3 queue infra (RAG v3 step 4c).
--
-- Wires the queue side of the v3 ingestion path so the worker can claim a
-- v3 job and finish it. Three coordinated changes; single transaction.
--
-- 1. Widen `corpus_reprocess_jobs.target_version` CHECK from IN (2) to
--    IN (2, 3). Plan §11/C4: the existing CHECK rejects v3 enqueues, so
--    without this widen the enqueue trigger / admin enqueue RPC cannot
--    create a v3 job (and the worker therefore can't claim one). The
--    constraint is auto-named per migration 20260515000001:36 — drop
--    IF EXISTS (audit-round-4 M1 discipline) then re-add.
--
-- 2. Add `target_version` to `claim_corpus_reprocess_job`'s RETURNS TABLE
--    (plan §12/R2-C2). The worker today receives only (job_id, sample_id,
--    creator_id, enqueue_version) — it has no way to tell a v2 job from a
--    v3 job and would route ALL claims through the v2 code path. Adding
--    target_version is the dispatch signal the v3 worker branch reads.
--
--    Postgres CREATE OR REPLACE FUNCTION cannot change the return type
--    (TABLE column list is part of the type), so DROP then CREATE. Single
--    migration transaction means the window between DROP and CREATE is
--    sub-millisecond — no production traffic can hit the function during
--    migration apply.
--
-- 3. NEW `corpus_reprocess_mark_done_v3` (plan §11/C1 option (i)): the
--    v3 worker branch's finish RPC. STUB shape — does status flip +
--    enqueue_version check only. The full v3 cutover (DELETE this sample's
--    v1/v2 chunks + sections + bump current_corpus_version under per-creator
--    advisory lock) lands in step 7 as `corpus_reprocess_finalize_v3` and
--    THIS stub will be upgraded to delegate to it. Until then a v3
--    reprocess leaves stale cache entries for up to 7 days — acceptable
--    inside the rag-v3-scaling branch's pre-deploy window (step 7 lands
--    before any PROD_DEPLOY_GATE flip).
--
--    The stub is deliberately not a thin call into the v2 mark_done.
--    v2 mark_done now delegates to corpus_reprocess_finalize (step 1b),
--    which DELETEs chunker_version=1 chunks for the sample — wrong for a
--    v3 job (would delete v3 chunks the v3 worker just wrote? no — finalize
--    only targets chunker_version=1, so v3 chunks survive; but the
--    creators.current_corpus_version bump under v3 happens, which is
--    correct cache invalidation). Decision: keep v3 ON A SEPARATE RPC
--    so step 7 can swap its body without touching the live v2 path.

-- ── 1. Widen target_version CHECK ─────────────────────────────────────────
ALTER TABLE public.corpus_reprocess_jobs
  DROP CONSTRAINT IF EXISTS corpus_reprocess_jobs_target_version_check;

ALTER TABLE public.corpus_reprocess_jobs
  ADD CONSTRAINT corpus_reprocess_jobs_target_version_check
    CHECK (target_version IN (2, 3));

COMMENT ON COLUMN public.corpus_reprocess_jobs.target_version IS
  '2 = v2 narrative+contextual reprocess (legacy → narrative_units + chunker_version=2 chunks). 3 = v3 routed-hierarchy reprocess (narrative_units + sections + chunker_version=3 chunks). v3 added 2026-05-28 via migration 20260528000020 as step-4c prerequisite for the v3 worker branch dispatch.';

-- ── 2. claim_corpus_reprocess_job — add target_version to RETURNS TABLE ──
-- DROP + CREATE because CREATE OR REPLACE cannot change return type.
DROP FUNCTION IF EXISTS public.claim_corpus_reprocess_job(text);

CREATE FUNCTION public.claim_corpus_reprocess_job(
  p_claimed_by text
) RETURNS TABLE (
  job_id          uuid,
  sample_id       uuid,
  creator_id      uuid,
  enqueue_version int,
  target_version  smallint        -- NEW (step 4c, R2-C2)
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_id          uuid;
  v_sample_id       uuid;
  v_creator_id      uuid;
  v_enqueue_version int;
  v_target_version  smallint;
  v_claimed_by      text;
BEGIN
  v_claimed_by := COALESCE(NULLIF(p_claimed_by, ''), 'unknown');
  IF char_length(v_claimed_by) > 128 THEN
    v_claimed_by := substring(v_claimed_by FROM 1 FOR 128);
  END IF;

  -- Day-9-cross C1 lock_timeout preserved from prior migration.
  SET LOCAL lock_timeout = '5s';

  -- Atomic claim — FOR UPDATE SKIP LOCKED with deterministic ordering.
  SELECT j.id, j.sample_id, j.enqueue_version, j.target_version
    INTO v_job_id, v_sample_id, v_enqueue_version, v_target_version
    FROM public.corpus_reprocess_jobs j
   WHERE j.status = 'pending' AND j.attempts < 5
   ORDER BY j.created_at ASC, j.id ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  -- Read sample BEFORE flipping queue status. Day-5 audit M1.
  SELECT s.creator_id INTO v_creator_id
    FROM public.sample_content s
   WHERE s.id = v_sample_id;

  IF v_creator_id IS NULL THEN
    UPDATE public.corpus_reprocess_jobs j
       SET status      = 'errored',
           last_error  = 'sample_not_found_at_claim_time',
           finished_at = now()
     WHERE j.id = v_job_id;
    RETURN;
  END IF;

  -- Per-creator advisory lock (Day-8 retrofit, preserved).
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || v_creator_id::text));

  UPDATE public.corpus_reprocess_jobs j
     SET status = 'processing',
         claimed_by = v_claimed_by,
         claimed_at = now()
   WHERE j.id = v_job_id;

  RETURN QUERY
    SELECT v_job_id, v_sample_id, v_creator_id, v_enqueue_version, v_target_version;
END;$$;

COMMENT ON FUNCTION public.claim_corpus_reprocess_job(text) IS
  'Atomic claim of one corpus_reprocess_jobs row. Returns (job_id, sample_id, creator_id, enqueue_version, target_version) — target_version added 2026-05-28 by migration 20260528000020 (step 4c, R2-C2) so the worker can branch v2 vs v3 by job. Per-creator pg_advisory_xact_lock + 5s lock_timeout preserved from prior migration. Service-role only.';

REVOKE ALL ON FUNCTION public.claim_corpus_reprocess_job(text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_corpus_reprocess_job(text)
  TO service_role;

-- ── 3. corpus_reprocess_mark_done_v3 STUB ────────────────────────────────
-- Mirrors the pre-step-1b mark_done shape (status flip only). Step 7's
-- corpus_reprocess_finalize_v3 will land + this stub's body will be
-- replaced with a delegating one-liner. Until then the v3 worker branch
-- finishes jobs without the version-bump + v1/v2 cutover delete — fine
-- in-tree pre-deploy.

CREATE FUNCTION public.corpus_reprocess_mark_done_v3(
  p_job_id          uuid,
  p_claimed_version int
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_done uuid;
BEGIN
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id
     AND status = 'processing'
     AND enqueue_version = p_claimed_version
     AND target_version = 3
   RETURNING id INTO v_done;
  -- NULL ⇔ silent abandon (admin re-enqueued OR not processing OR not v3).
  -- Caller's contract: NULL = retry-on-next-claim (reaper handles after TTL).
  RETURN v_done;
END;$$;

COMMENT ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int) IS
  'STUB v3 worker-finish for corpus_reprocess_jobs (target_version=3 only). Status flip + enqueue_version check; NO version-bump + NO chunk delete yet — step 7 (corpus_reprocess_finalize_v3) will land + this stub upgraded to delegate. Worker contract identical to v2 mark_done (returns uuid on success, NULL on silent abandon). Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int)
  TO service_role;
