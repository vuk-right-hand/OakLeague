-- 20260512000011 — finalize_embedding_job RPC.
--
-- M11 of pgvector RAG plan (R2 C2 fix: atomic version-checked finish).
--
-- The embed-worker:
--   1. Claims a job: UPDATE jobs SET status='processing', claimed_by, claimed_at
--      ... RETURNING id, sample_id, enqueue_version.
--   2. Reads sample_content.raw_text + creator_id + topic_tags.
--   3. Chunks + embeds (paid Gemini API call).
--   4. Calls THIS RPC with (job_id, sample_id, chunks, vectors, claimed_version).
--
-- Inside the RPC, ALL of the following happens in one transaction:
--   a. Atomic version check: UPDATE jobs SET status='done' WHERE id=$1 AND
--      enqueue_version=$claimed RETURNING id.
--   b. If RETURNING 0 rows → concurrent re-enqueue bumped the version
--      mid-flight (creator pasted again while we were embedding). The
--      function RETURNS NULL; caller treats this as "silent abandon, the
--      new pending row will be re-claimed."
--   c. DELETE FROM sample_content_chunks WHERE sample_id (atomic chunk
--      replacement).
--   d. INSERT new chunks with their pre-computed embeddings.
--
-- If any of c/d fail, the entire transaction rolls back including the
-- status='done' UPDATE. The job returns to status='processing' from the
-- claim, where the 60s reaper picks it up. Bounded blast radius.

CREATE FUNCTION public.finalize_embedding_job(
  p_job_id          uuid,
  p_sample_id       uuid,
  p_chunks          jsonb,        -- [{ chunk_index, text, token_count, topic_tags }]
  p_vectors         halfvec(768)[],
  p_claimed_version int
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_done       uuid;
  v_creator_id uuid;
  v_n          int;
  v_i          int;
  v_chunk      jsonb;
BEGIN
  SELECT creator_id INTO v_creator_id
    FROM public.sample_content
   WHERE id = p_sample_id;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION 'sample_not_found' USING ERRCODE='42704';
  END IF;

  v_n := jsonb_array_length(p_chunks);
  IF v_n <> COALESCE(array_length(p_vectors, 1), 0) THEN
    RAISE EXCEPTION 'chunk_vector_length_mismatch' USING ERRCODE='22023';
  END IF;

  -- Atomic version-check finish FIRST. If a concurrent trigger bumped
  -- enqueue_version while we were embedding, this matches zero rows and we
  -- exit clean — no chunk writes. The locked job row stays at
  -- status='processing' from the worker's earlier claim; the reaper picks
  -- it up after 60s OR the worker's next claim attempt finds it stale and
  -- requeues via the reaper. Either way, the new content gets re-processed.
  UPDATE public.sample_content_embedding_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id AND enqueue_version = p_claimed_version
   RETURNING id INTO v_done;
  IF v_done IS NULL THEN
    RETURN NULL;
  END IF;

  -- Replace chunks atomically within the same transaction.
  DELETE FROM public.sample_content_chunks WHERE sample_id = p_sample_id;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_chunk := p_chunks -> v_i;
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding, embedded_at)
    VALUES (
      p_sample_id, v_creator_id,
      (v_chunk ->> 'chunk_index')::int,
      v_chunk ->> 'text',
      NULLIF(v_chunk ->> 'token_count', '')::int,
      ARRAY(SELECT jsonb_array_elements_text(v_chunk -> 'topic_tags')),
      p_vectors[v_i + 1],
      now()
    );
  END LOOP;

  RETURN v_done;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_embedding_job(uuid, uuid, jsonb, halfvec(768)[], int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_embedding_job(uuid, uuid, jsonb, halfvec(768)[], int)
  TO service_role;

COMMENT ON FUNCTION public.finalize_embedding_job(uuid, uuid, jsonb, halfvec(768)[], int) IS
  'Atomic worker-finish: version-checks the job row, replaces chunks for the sample, and marks job done. Returns NULL on version mismatch (silent abandon — the re-enqueued row will be re-claimed). Service-role only.';
