-- 20260517000003 — Day-5 audit M1: fix claim_corpus_reprocess_job query ordering.
--
-- Two changes vs the original 20260516000002:
--
-- 1. Read sample_content BEFORE issuing the UPDATE on the queue row. The
--    original ordering UPDATEd the queue row to status='processing' and
--    THEN ran `RETURN QUERY SELECT ... FROM sample_content WHERE s.id=v_sample_id`.
--    If sample_content was deleted between the FOR UPDATE SKIP LOCKED and
--    the RETURN QUERY (shouldn't normally happen — FK ON DELETE CASCADE on
--    corpus_reprocess_jobs.sample_id holds the lock chain — but defensive),
--    the RPC returns zero rows while the queue row is committed at
--    status='processing'. The 600s reaper eventually requeues, but that's
--    a 10-minute stall per ghost row. Cheaper to detect at claim time and
--    mark errored explicitly.
--
-- 2. Add `id ASC` secondary sort. The original `ORDER BY created_at ASC`
--    has no tie-breaker. Postgres timestamptz is microsecond — collisions
--    rare but real on a `corpus-reprocess.mjs --force` bulk-enqueue. Two
--    workers calling the RPC at the exact same microsecond can pick the
--    same row out of FOR UPDATE SKIP LOCKED IF tied on created_at; the
--    secondary id sort is the deterministic break.

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
  -- (created_at then id for tie-break).
  SELECT id, sample_id, enqueue_version
    INTO v_job_id, v_sample_id, v_enqueue_version
    FROM public.corpus_reprocess_jobs
   WHERE status = 'pending' AND attempts < 5
   ORDER BY created_at ASC, id ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  -- Day-5-audit M1: read sample BEFORE flipping the queue status. If the
  -- sample disappeared (concurrent DELETE racing the FK CASCADE chain),
  -- we mark the queue row errored explicitly instead of leaving it in
  -- the limbo state status='processing' waiting on the reaper.
  SELECT creator_id INTO v_creator_id
    FROM public.sample_content
   WHERE id = v_sample_id;

  IF v_creator_id IS NULL THEN
    UPDATE public.corpus_reprocess_jobs
       SET status      = 'errored',
           last_error  = 'sample_not_found_at_claim_time',
           finished_at = now()
     WHERE id = v_job_id;
    -- Don't return the row to the worker — there's nothing to process.
    RETURN;
  END IF;

  -- Flip the queue row to processing now that we know the work is real.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing',
         claimed_by = v_claimed_by,
         claimed_at = now()
   WHERE id = v_job_id;

  RETURN QUERY
    SELECT v_job_id, v_sample_id, v_creator_id, v_enqueue_version;
END;$$;

COMMENT ON FUNCTION public.claim_corpus_reprocess_job(text) IS
  'Atomic claim of one corpus_reprocess_jobs row via FOR UPDATE SKIP LOCKED with deterministic (created_at, id) ordering. Reads sample_content BEFORE the queue UPDATE so an orphaned sample marks the job errored instead of stalling at processing (Day-5 audit M1). Worker pairs with corpus_reprocess_mark_done version-check; the reaper additionally bumps enqueue_version on requeue (Day-5 audit C5). Service-role only.';

REVOKE ALL ON FUNCTION public.claim_corpus_reprocess_job(text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_corpus_reprocess_job(text)
  TO service_role;
