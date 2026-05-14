-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8 MIG-1
-- creators.current_corpus_version + corpus_reprocess_finalize RPC
-- ─────────────────────────────────────────────────────────────────────────
--
-- This is the foundation Phase 2 builds on. Two concerns are deliberately
-- kept in separate columns (auditor C1+C5 disposition):
--
--   creators.retrieval_version    (Phase 1, already exists)
--     = read-path cutover. 1 = legacy creator_knowledge_topk (chunker_v1
--       only). 2 = creator_knowledge_topk_v2 (chunker_v2 hybrid RPC,
--       lands in MIG-2). Admin flips via UI. Monotonic per creator.
--
--   creators.current_corpus_version  (this migration)
--     = cache-invalidation revision. Bumped once per successful sample
--       finalize. Drives semantic_query_cache key (MIG-3). Two finalizes
--       for the same creator = two bumps = cache entries from older
--       revision are stale and miss on lookup.
--
-- These do NOT collapse into one column — read-path cutover and cache
-- revision have different lifecycles. Future readers should not "simplify"
-- by merging them.
--
-- The corpus_reprocess_finalize RPC is the single atomic cutover point
-- for one sample's v2 reprocess:
--   1. DELETE the sample's chunker_version=1 chunks
--   2. UPDATE creators.current_corpus_version += 1
--   3. Mark the corpus_reprocess_jobs row done
--
-- All in one transaction. Caller (the worker) passes only p_job_id +
-- p_claimed_version. sample_id and creator_id are server-derived from
-- the job + sample join — a buggy or malicious worker cannot mismatch
-- IDs and wipe v1 chunks for an unrelated sample (audit-2 C1 closure).
--
-- pg_advisory_xact_lock on hashtext('reprocess:'||creator_id) serializes
-- finalize across concurrent workers for the same creator, so the
-- current_corpus_version bump + DELETE pair never interleaves with
-- another sample's finalize for the same creator (audit-day-8 C4).
--
-- Silent-abandon on enqueue_version mismatch matches corpus_reprocess_mark_done
-- semantics — if an admin re-enqueued the job mid-flight, the in-flight
-- worker's finalize is dropped and the re-enqueued row stays at
-- status='processing' until the reaper requeues it after 600s TTL.

-- ── 1. creators.current_corpus_version column ───────────────────────────
-- NOT NULL DEFAULT 1 is metadata-only on PG ≥11 (no table rewrite). This
-- migration runs alone in its transaction; no other ALTER on creators here.
ALTER TABLE public.creators
  ADD COLUMN current_corpus_version int NOT NULL DEFAULT 1
    CHECK (current_corpus_version >= 1);

COMMENT ON COLUMN public.creators.current_corpus_version IS
  'Monotonically increasing cache-invalidation revision. Bumped once per successful sample finalize via corpus_reprocess_finalize. Drives semantic_query_cache key. DISTINCT from retrieval_version (which is the read-path cutover 1→2). Cache entries written under revision N become stale on bump to N+1.';

-- ── 2. corpus_reprocess_finalize RPC ────────────────────────────────────
CREATE FUNCTION public.corpus_reprocess_finalize(
  p_job_id          uuid,
  p_claimed_version int
) RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sample_id   uuid;
  v_creator_id  uuid;
  v_new_version int;
BEGIN
  -- Server-derive sample_id + creator_id from the job + sample join.
  -- FOR UPDATE OF j locks the jobs row only (not sample_content readers).
  -- enqueue_version match enforces silent-abandon on mid-flight re-enqueue.
  SELECT j.sample_id, s.creator_id
    INTO v_sample_id, v_creator_id
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE j.id = p_job_id
     AND j.status = 'processing'
     AND j.enqueue_version = p_claimed_version
   FOR UPDATE OF j;

  IF v_sample_id IS NULL THEN
    -- Silent-abandon: job missing, not processing, or version-mismatched.
    -- Matches corpus_reprocess_mark_done semantics. Reaper handles the
    -- re-enqueued row after the 600s claim TTL.
    RETURN NULL;
  END IF;

  -- Creator-level serialization. Two workers finalizing different samples
  -- for the same creator queue up here so the DELETE-v1 + bump-version
  -- pair executes atomically per-creator. Released at xact end.
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || v_creator_id::text));

  -- Cutover: drop this sample's legacy v1 chunks. v2 chunks for this
  -- sample landed via _insert_chunk_v2_unsafe earlier in the same worker
  -- run. After this DELETE, the sample is fully v2.
  DELETE FROM public.sample_content_chunks
   WHERE sample_id = v_sample_id
     AND chunker_version = 1;

  -- Bump cache-invalidation revision. Any semantic_query_cache row under
  -- the prior revision will now miss on lookup (MIG-3 filters by
  -- corpus_version equality).
  --
  -- Day-8-final audit M5: the SELECT join only locks the jobs row, not
  -- creators. If creators got deleted between the SELECT and this UPDATE,
  -- v_new_version would be NULL and we'd return NULL — indistinguishable
  -- from silent-abandon. Raise instead so the worker sees an actionable
  -- error instead of cascading the abandon to spurious requeues.
  UPDATE public.creators
     SET current_corpus_version = current_corpus_version + 1
   WHERE id = v_creator_id
   RETURNING current_corpus_version INTO v_new_version;

  IF v_new_version IS NULL THEN
    RAISE EXCEPTION 'creator_disappeared_during_finalize creator_id=%', v_creator_id
      USING ERRCODE = 'no_data_found';  -- 02000
  END IF;

  -- Mark job done. enqueue_version was already verified in the SELECT
  -- (we hold the row lock since then), so no version re-check needed here.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id;

  RETURN v_new_version;
END;
$$;

COMMENT ON FUNCTION public.corpus_reprocess_finalize(uuid, int) IS
  'Atomic worker-finalize for one sample reprocess. Derives sample_id + creator_id server-side from the job + sample join (caller cannot mismatch). pg_advisory_xact_lock on hashtext(''reprocess:''||creator_id) serializes per-creator finalizes. Returns new current_corpus_version on success, NULL on silent-abandon (enqueue_version mismatch or job not in processing state). Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_finalize(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_finalize(uuid, int)
  TO service_role;
