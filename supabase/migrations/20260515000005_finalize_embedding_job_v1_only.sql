-- 20260515000005 — finalize_embedding_job freezes to chunker_version=1.
--
-- Audit-6 C1 fix. The legacy `finalize_embedding_job` RPC (20260512000011) at
-- its DELETE step removes ALL chunks for a sample without filtering on
-- chunker_version. Once v2 chunks exist for a sample, ANY raw_text edit by
-- the creator re-triggers the legacy embed-worker queue
-- (sample_content_embedding_jobs trigger on UPDATE OF raw_text), claims the
-- job, calls this RPC, and WIPES THE V2 CHUNKS. The v2 narrative_units
-- survive but lose all child chunks, so hybrid retrieval returns empty.
--
-- Today this is latent — no creator is at retrieval_version=2 yet (migration 6
-- invariant_check enforces). The trap arms the moment the first real Phase 2
-- reprocess lands. Fixing in Day 2.5 closes the window before Day 5 worker
-- arrives.
--
-- Symmetric to audit-3 C4 (legacy creator_knowledge_topk RPC filtered to
-- chunker_version=1 reads). This migration freezes the legacy embed-worker
-- finalize to chunker_version=1 writes. Together, the legacy v1 pipeline is
-- isolated from the v2 pipeline at both ends. v2 writes happen exclusively
-- via _insert_chunk_v2_unsafe + (future Phase 2) corpus_reprocess_finalize.

CREATE OR REPLACE FUNCTION public.finalize_embedding_job(
  p_job_id          uuid,
  p_sample_id       uuid,
  p_chunks          jsonb,
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

  UPDATE public.sample_content_embedding_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id AND enqueue_version = p_claimed_version
   RETURNING id INTO v_done;
  IF v_done IS NULL THEN
    RETURN NULL;
  END IF;

  -- Audit-6 C1 fix: legacy worker manages v1 chunks ONLY. Without the
  -- chunker_version=1 predicate, any raw_text edit on a sample at
  -- retrieval_version=2 would wipe the v2 chunks and the v2 narrative_units
  -- would be left orphaned. Symmetric to the audit-3 C4 read-side freeze.
  DELETE FROM public.sample_content_chunks
    WHERE sample_id = p_sample_id
      AND chunker_version = 1;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_chunk := p_chunks -> v_i;
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding, embedded_at)
      -- chunker_version defaults to 1 (column DEFAULT from 20260514000003);
      -- legacy insert path does not set parent_unit_id or chunk_context.
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

COMMENT ON FUNCTION public.finalize_embedding_job(uuid, uuid, jsonb, halfvec(768)[], int) IS
  'Atomic worker-finish for the legacy v1 embed-worker. Audit-6 C1: DELETE now filtered to chunker_version=1 so a raw_text edit on a v2-flipped sample does not silently wipe v2 chunks (symmetric to audit-3 C4''s read-side freeze on creator_knowledge_topk). Version-checks the embedding job row; returns NULL on enqueue_version mismatch (silent abandon — re-enqueued row will be re-claimed). Service-role only.';

-- ACLs preserved by CREATE OR REPLACE.
