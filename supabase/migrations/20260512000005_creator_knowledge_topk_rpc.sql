-- 20260512000005 — creator_knowledge_topk RPC.
--
-- M5 of pgvector RAG plan. Per-turn top-K vector retrieval.
--
-- Application-layer invariant (NOT SQL-enforced, documented on the function):
--   caller passes the verified creator_id captured at voice-ticket consume
--   time, stored as a closure const for the session's duration in the proxy.
--   Never client-supplied.
--
-- Hard caps:
--   * K capped at 5 (R2 M5 fix: was 10, lowered to bound wire bytes — top
--     of K=5 × 2000 chars = 10KB per call, well under PostgREST default).
--   * min_similarity floored at 0.30 inside the function regardless of caller.
--   * text server-truncated at 2000 chars before returning (R2 M5 fix: was
--     no cap, could return 8000 chars × K = 80KB per call).
--   * Duplicate-text dedup via md5(LEFT(text,200)) prevents two samples
--     carrying the same passage from returning twice. (R2 Small fix.)

CREATE FUNCTION public.creator_knowledge_topk(
  p_creator_id     uuid,
  p_query_vec      halfvec(768),
  p_k              int     DEFAULT 3,
  p_min_similarity numeric DEFAULT 0.55
) RETURNS TABLE (
  chunk_id    uuid,
  sample_id   uuid,
  text        text,
  source_type sample_source_type,
  similarity  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH ranked AS (
    SELECT c.id AS chunk_id,
           c.sample_id,
           LEFT(c.text, 2000) AS text,
           s.source_type,
           (1 - (c.embedding <=> p_query_vec))::numeric AS similarity,
           md5(LEFT(c.text, 200)) AS dedup_key,
           c.embedding <=> p_query_vec AS dist
      FROM public.sample_content_chunks c
      JOIN public.sample_content s ON s.id = c.sample_id
     WHERE c.creator_id = p_creator_id
       AND c.embedding IS NOT NULL
       AND s.fetch_status <> 'errored'
       AND (1 - (c.embedding <=> p_query_vec)) >= GREATEST(p_min_similarity, 0.30)
     ORDER BY c.embedding <=> p_query_vec
     LIMIT LEAST(p_k, 5) * 4  -- pre-dedup overshoot
  )
  SELECT DISTINCT ON (dedup_key)
         chunk_id, sample_id, text, source_type, similarity
    FROM ranked
   ORDER BY dedup_key, dist
   LIMIT LEAST(p_k, 5);
$$;

COMMENT ON FUNCTION public.creator_knowledge_topk(uuid, halfvec(768), int, numeric) IS
  'Top-K vector retrieval over a creator''s sample_content_chunks. Application-layer invariant: caller passes the verified creator_id captured at voice-ticket consume time. Service-role only. K hard-capped at 5; text truncated at 2000 chars server-side; duplicate-text passages deduped by md5 of first 200 chars.';

REVOKE ALL ON FUNCTION public.creator_knowledge_topk(uuid, halfvec(768), int, numeric)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_knowledge_topk(uuid, halfvec(768), int, numeric)
  TO service_role;
