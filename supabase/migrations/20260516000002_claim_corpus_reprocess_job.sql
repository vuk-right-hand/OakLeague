-- 20260516000002 — claim_corpus_reprocess_job RPC.
--
-- Day-5 build for the Day-1+2+3 integration audit's M2 finding.
--
-- The Day-2 migration 20260515000001 created the corpus_reprocess_jobs table
-- and the mark_done + reap + admin_list RPCs, but deliberately punted the
-- worker-side CLAIM RPC to Day 5 when the worker integration would land.
-- Without an atomic claim, the Day 5 reprocess worker would either:
--   (a) reproduce the documented PostgREST UPDATE-LIMIT-without-ORDER-BY bug
--       from sample_content_embedding_jobs (embed-worker.js:207-213), or
--   (b) double-claim the same row on multi-instance Fly deployments.
--
-- This RPC fixes both via FOR UPDATE SKIP LOCKED + server-side ORDER BY.
-- Returns the claimed job's id, sample_id, creator_id (server-derived from
-- sample_content join — caller cannot tamper), and enqueue_version captured
-- at claim time (used by corpus_reprocess_mark_done's version-check).
--
-- The creator_id is returned so the worker can immediately take a
-- pg_advisory_xact_lock(hashtext('embed_worker:' + creator_id)) WITHOUT a
-- second round-trip — same locking key the legacy embed-worker will use
-- after the Day-5 advisory-lock fix lands (integration-audit C2).

CREATE FUNCTION public.claim_corpus_reprocess_job(
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
  v_enqueue_version int;
  v_claimed_by      text;
BEGIN
  -- Cap to match corpus_reprocess_jobs.claimed_by CHECK (≤128 chars).
  -- Empty / NULL fall back to 'unknown' so the row always reflects an actor.
  v_claimed_by := COALESCE(NULLIF(p_claimed_by, ''), 'unknown');
  IF char_length(v_claimed_by) > 128 THEN
    v_claimed_by := substring(v_claimed_by FROM 1 FOR 128);
  END IF;

  -- Atomic claim. FOR UPDATE SKIP LOCKED prevents two concurrent workers
  -- from claiming the same row. ORDER BY created_at ASC ensures FIFO
  -- fairness — oldest pending job first.
  SELECT id, sample_id, enqueue_version
    INTO v_job_id, v_sample_id, v_enqueue_version
    FROM public.corpus_reprocess_jobs
   WHERE status = 'pending' AND attempts < 5
   ORDER BY created_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job_id IS NULL THEN
    -- No work. Return zero rows; worker tick exits cleanly.
    RETURN;
  END IF;

  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing',
         claimed_by = v_claimed_by,
         claimed_at = now()
   WHERE id = v_job_id;

  -- Return the job + server-derived creator_id from the sample's row.
  -- Caller never supplies creator_id; the parent sample is the single
  -- source of truth (same audit-2 C1 parameter-trust closure as
  -- _insert_chunk_v2_unsafe).
  RETURN QUERY
    SELECT v_job_id, v_sample_id, s.creator_id, v_enqueue_version
      FROM public.sample_content s
     WHERE s.id = v_sample_id;
END;$$;

COMMENT ON FUNCTION public.claim_corpus_reprocess_job(text) IS
  'Atomic claim of one corpus_reprocess_jobs row via FOR UPDATE SKIP LOCKED. Returns job_id + sample_id + creator_id (derived from sample_content join) + enqueue_version (for the mark_done version-check). Worker pairs with pg_advisory_xact_lock on creator_id to serialize concurrent work on the same creator. Service-role only.';

REVOKE ALL ON FUNCTION public.claim_corpus_reprocess_job(text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_corpus_reprocess_job(text)
  TO service_role;
