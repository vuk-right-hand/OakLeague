-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8 MIG-5
-- claim_corpus_reprocess_job: add per-creator advisory lock at claim time
-- ─────────────────────────────────────────────────────────────────────────
--
-- Audit-3 deferred-item retrofit. The original RPC's COMMENT promised
-- "Worker pairs with pg_advisory_xact_lock on creator_id to serialize
-- concurrent work on the same creator" but neither the SQL nor the worker
-- code follows through. This migration takes the lock at the SQL level so
-- the contract is true within the RPC's scope.
--
-- Scope and limitation
-- --------------------
-- The lock is xact-scoped (`pg_advisory_xact_lock` releases at transaction
-- end). The claim transaction itself is fast — read job + read sample + flip
-- status, all in milliseconds. The actual heavy work (Flash narrative
-- chunking, Haiku contextual gen, Voyage embeds) happens AFTER claim
-- returns, in a different transaction. The lock does NOT span that work.
--
-- What the lock DOES provide:
--   - At most one in-flight `claim_corpus_reprocess_job` call per creator
--     at any moment. Blocks the rare race where two workers hit claim for
--     the same creator at the same instant.
--   - Hook point for future per-creator concurrency caps without changing
--     callers.
--   - Companion to the lock corpus_reprocess_finalize takes on the same key
--     (`reprocess:` + creator_id). The two locks together serialize the
--     full claim-and-finalize boundary, even though processing in between
--     is unserialized.
--
-- What it does NOT provide:
--   - Serialization across the worker's full processing run. That requires
--     a session-level lock (pg_advisory_lock, not _xact_) held by the
--     worker process across the claim → process → finalize boundary.
--     Deferred to Day-9 worker code where the lifecycle hook is available.
--
-- The pre-existing FOR UPDATE SKIP LOCKED + (created_at, id) ordering
-- guarantees correctness without this lock — the lock is defense-in-depth
-- and forward-compatibility, not a fix for an active bug.

CREATE OR REPLACE FUNCTION public.claim_corpus_reprocess_job(
  p_claimed_by text
) RETURNS TABLE (
  job_id          uuid,
  sample_id       uuid,
  creator_id      uuid,
  enqueue_version int
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_id          uuid;
  v_sample_id       uuid;
  v_creator_id      uuid;
  v_enqueue_version int;
  v_claimed_by      text;
BEGIN
  v_claimed_by := COALESCE(NULLIF(p_claimed_by, ''), 'unknown');
  IF char_length(v_claimed_by) > 128 THEN
    v_claimed_by := substring(v_claimed_by FROM 1 FOR 128);
  END IF;

  -- Atomic claim — FOR UPDATE SKIP LOCKED with deterministic ordering
  -- (created_at then id for tie-break). Table alias `j` is required:
  -- plpgsql.variable_conflict=error treats the unqualified column names
  -- as ambiguous against the OUT params (job_id, sample_id, ...).
  SELECT j.id, j.sample_id, j.enqueue_version
    INTO v_job_id, v_sample_id, v_enqueue_version
    FROM public.corpus_reprocess_jobs j
   WHERE j.status = 'pending' AND j.attempts < 5
   ORDER BY j.created_at ASC, j.id ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  -- Read sample BEFORE flipping queue status. If the sample disappeared,
  -- mark the queue row errored explicitly (Day-5 audit M1).
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

  -- Day-8 audit retrofit: take the per-creator advisory lock now that we
  -- know creator_id. xact-scoped; pairs with corpus_reprocess_finalize's
  -- lock on the same key. See header for scope/limitation.
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || v_creator_id::text));

  -- Flip the queue row to processing.
  UPDATE public.corpus_reprocess_jobs j
     SET status = 'processing',
         claimed_by = v_claimed_by,
         claimed_at = now()
   WHERE j.id = v_job_id;

  RETURN QUERY
    SELECT v_job_id, v_sample_id, v_creator_id, v_enqueue_version;
END;$$;

COMMENT ON FUNCTION public.claim_corpus_reprocess_job(text) IS
  'Atomic claim of one corpus_reprocess_jobs row via FOR UPDATE SKIP LOCKED with deterministic (created_at, id) ordering. Reads sample_content BEFORE the queue UPDATE so an orphaned sample marks the job errored instead of stalling at processing (Day-5 audit M1). Day-8 retrofit: takes pg_advisory_xact_lock on hashtext(''reprocess:''||creator_id) before the status flip; pairs with corpus_reprocess_finalize''s lock on the same key. Lock is xact-scoped so it does NOT span the worker''s subsequent processing — true session-level serialization is worker code (Day 9). Service-role only.';

REVOKE ALL ON FUNCTION public.claim_corpus_reprocess_job(text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_corpus_reprocess_job(text)
  TO service_role;
