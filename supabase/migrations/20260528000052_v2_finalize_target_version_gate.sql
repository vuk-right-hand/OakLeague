-- 20260528000052 — corpus_reprocess_finalize (v2): add target_version=2 gate
-- (RAG v3 step 7 / round-5 audit C2 — the mirror fence).
--
-- ── The one-directional-fence bug ───────────────────────────────────────
-- finalize_v3 (20260528000050) gates on `target_version = 3` so a v2 job
-- can't be finalized via the v3 path. But the v2 finalize
-- (corpus_reprocess_finalize, 20260521000001) gates ONLY on
-- status='processing' + enqueue_version — NO target_version filter. So a
-- leftover target_version=2 job (e.g. enqueued before a v2→v3 flip, still
-- pending) can be claimed + the worker's v2 branch runs + calls v2
-- mark_done → v2 finalize, which would happily finalize it: deleting v1
-- chunks + bumping current_corpus_version for a creator now reading v3, and
-- (worse) the v2 pipeline would have written fresh chunker_version=2 chunks
-- that are pure garbage in a v3 corpus. The protection was half a fence.
--
-- ── Fix ─────────────────────────────────────────────────────────────────
-- Add `AND j.target_version = 2` to the v2 finalize SELECT. Now a v2
-- finalize REFUSES a target_version=3 job (silent-abandon → NULL), exactly
-- mirroring finalize_v3's refusal of a v2 job. Combined with the worker's
-- per-target_version dispatch (claim returns target_version; worker branches
-- 2 vs 3) and the legacy worker's `!== 1` skip, a job can now only ever be
-- finalized by the finalize matching its target_version.
--
-- Everything else in the function is preserved verbatim from
-- 20260521000001 (the step-1b wrapper 20260528000001 calls THIS, so its
-- behavior flows through unchanged except for the added gate).

CREATE OR REPLACE FUNCTION public.corpus_reprocess_finalize(
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
  SET LOCAL lock_timeout = '5s';

  -- Round-5 C2: added `AND j.target_version = 2`. A v2 finalize must refuse
  -- a v3 job (mirror of finalize_v3's target_version=3 gate).
  SELECT j.sample_id, s.creator_id
    INTO v_sample_id, v_creator_id
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE j.id = p_job_id
     AND j.status = 'processing'
     AND j.enqueue_version = p_claimed_version
     AND j.target_version = 2
   FOR UPDATE OF j;

  IF v_sample_id IS NULL THEN
    -- Silent-abandon: job missing, not processing, version-mismatched, OR
    -- target_version<>2.
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || v_creator_id::text));

  -- v2 cutover: drop this sample's legacy v1 chunks. v2 chunks landed via
  -- _insert_chunk_v2_unsafe earlier in the worker run.
  DELETE FROM public.sample_content_chunks
   WHERE sample_id = v_sample_id
     AND chunker_version = 1;

  UPDATE public.creators
     SET current_corpus_version = current_corpus_version + 1
   WHERE id = v_creator_id
   RETURNING current_corpus_version INTO v_new_version;

  IF v_new_version IS NULL THEN
    RAISE EXCEPTION 'creator_disappeared_during_finalize creator_id=%', v_creator_id
      USING ERRCODE = 'no_data_found';  -- 02000
  END IF;

  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id;

  RETURN v_new_version;
END;
$$;

COMMENT ON FUNCTION public.corpus_reprocess_finalize(uuid, int) IS
  'Atomic v2 worker-finalize for one sample reprocess (target_version=2 only — gate added round-5 C2 so a v3 job can never be finalized via the v2 path). Derives sample_id + creator_id server-side. pg_advisory_xact_lock on hashtext(''reprocess:''||creator_id). DELETEs the sample''s chunker_version=1 chunks, bumps creators.current_corpus_version. Returns new version on success, NULL on silent-abandon (enqueue_version mismatch / not processing / target_version<>2), RAISES 02000 on creator-disappeared. Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_finalize(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_finalize(uuid, int)
  TO service_role;
