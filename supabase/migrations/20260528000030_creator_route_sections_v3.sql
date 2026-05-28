-- 20260528000030 — _creator_route_sections_v3 (RAG v3 step 5 / plan §4 item 5).
--
-- The routing layer that fixes Wall B. Caller picks the top-S relevant
-- sections for a query BEFORE the scoped hybrid retrieval (step 5 mig 6
-- creator_knowledge_topk_v3) draws candidates from inside those sections —
-- so the "right unit" competes only inside its own neighborhood's top-N,
-- not against a global SUM-RRF top-20 that buries it (plan §0 #2).
--
-- Score per section (plan §2.4): max(cos(query, summary_embedding),
-- cos(query, centroid_embedding)) + soft topic_tags overlap boost.
-- summary catches topical words / proper nouns (LLM-generated short
-- description); centroid catches the section's actual content distribution
-- (length-weighted unit-normalized mean of child chunk embeddings —
-- computed in step 4d's worker). MAX of the two so a section wins on
-- EITHER signal — robust to a Flash-summary that missed key topical words
-- AND robust to a centroid dominated by filler chunks.
--
-- topic_tags boost is SOFT (not a hard filter). The contract from §2.4:
--   • a creator with mistagged samples must still be retrievable
--   • an off-topic query against a tagged creator must still work
-- Implementation: + lambda_topic * cardinality(intersect(section.topic_tags,
--                                                       p_topic_tags))
-- lambda_topic is small (~0.05) so it's a tiebreaker, not the primary signal.
--
-- ── HNSW partial-index contract (audit round-4 M3, load-bearing) ─────────
-- The HNSW indexes on sample_content_sections.summary_embedding and
-- .centroid_embedding are PARTIAL — WHERE *_embedding IS NOT NULL
-- (migration 20260528000010). For the planner to pick the partial index
-- instead of falling back to seq-scan, this RPC's WHERE clause MUST
-- TEXTUALLY include the same `IS NOT NULL` predicate. PG 15 does NOT
-- infer non-NULL from the `<=> $vec` operator alone. Both `summary_top`
-- and `centroid_top` CTEs include the predicate explicitly. A pgTAP
-- EXPLAIN-assert in the test file pins this so a future refactor that
-- drops the predicate fails LOUD.
--
-- ── HNSW strict_order ────────────────────────────────────────────────────
-- Same set_config('hnsw.iterative_scan', 'strict_order', true) as v2's
-- creator_knowledge_topk_v2 — preserves true distance ordering so the
-- post-WHERE filter (creator_id + IS NOT NULL) returns the actual top-K
-- nearest neighbors, not a relaxed-order approximation. Soft-fail on
-- older pgvector versions.
--
-- ── Section-count guard ──────────────────────────────────────────────────
-- p_top_s clamped to [1, 10]. Plan §10 OQ #2: ship conservative S adaptive
-- 2-6; the harness picks the freeze value (round-4 C1 gate). 10 is a hard
-- ceiling on what any harness configuration can request — beyond that the
-- scoped topk_v3 candidate budget (10 parents/section × 10 sections × ~5
-- candidates after rerank = 500) blows the Voyage rerank window.

CREATE FUNCTION public._creator_route_sections_v3(
  p_creator_id   uuid,
  p_query_vec    halfvec(768),
  p_topic_tags   text[]  DEFAULT NULL,
  p_top_s        int     DEFAULT 4,
  p_min_sim      float   DEFAULT 0.30,
  p_lambda_topic float   DEFAULT 0.05
) RETURNS TABLE (
  section_id     uuid,
  sample_id      uuid,
  title          text,
  summary_sim    float,
  centroid_sim   float,
  topic_boost    float,
  score          float
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  BEGIN
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY
  WITH params AS (
    SELECT GREATEST(1, LEAST(p_top_s, 10))::int    AS top_s,
           GREATEST(0::float, LEAST(p_min_sim, 1.0)) AS min_sim
  ),
  -- Two-vector pattern. Each CTE pulls k_candidates = top_s × 3 (hard cap)
  -- via partial HNSW pushdown, then we MERGE per section_id taking MAX
  -- per signal + add the topic boost.
  summary_top AS (
    SELECT s.id           AS section_id,
           s.sample_id    AS sample_id,
           s.title        AS title,
           s.topic_tags   AS topic_tags,
           1 - (s.summary_embedding <=> p_query_vec) AS sim
      FROM public.sample_content_sections s, params
     WHERE s.creator_id = p_creator_id
       AND s.summary_embedding IS NOT NULL    -- audit M3 — partial-HNSW pushdown
       AND s.centroid_embedding IS NOT NULL   -- (caller invariant — both NN gates same population)
     ORDER BY s.summary_embedding <=> p_query_vec
     LIMIT (SELECT top_s * 3 FROM params)
  ),
  centroid_top AS (
    SELECT s.id           AS section_id,
           s.sample_id    AS sample_id,
           s.title        AS title,
           s.topic_tags   AS topic_tags,
           1 - (s.centroid_embedding <=> p_query_vec) AS sim
      FROM public.sample_content_sections s, params
     WHERE s.creator_id = p_creator_id
       AND s.summary_embedding IS NOT NULL    -- audit M3 — partial-HNSW pushdown
       AND s.centroid_embedding IS NOT NULL
     ORDER BY s.centroid_embedding <=> p_query_vec
     LIMIT (SELECT top_s * 3 FROM params)
  ),
  -- Union + dedup by section_id. MAX of the two cosine signals per section.
  -- COALESCE(other, 0) handles sections that landed in only one CTE.
  merged AS (
    SELECT COALESCE(s.section_id, c.section_id)             AS section_id,
           COALESCE(s.sample_id,  c.sample_id)              AS sample_id,
           COALESCE(s.title,      c.title)                  AS title,
           COALESCE(s.topic_tags, c.topic_tags)             AS topic_tags,
           COALESCE(s.sim, 0)                               AS summary_sim,
           COALESCE(c.sim, 0)                               AS centroid_sim
      FROM summary_top  s
      FULL OUTER JOIN centroid_top c ON c.section_id = s.section_id
  ),
  scored AS (
    SELECT m.section_id,
           m.sample_id,
           m.title,
           m.summary_sim,
           m.centroid_sim,
           CASE
             WHEN p_topic_tags IS NULL OR cardinality(p_topic_tags) = 0 THEN 0::float
             ELSE p_lambda_topic * cardinality(
               ARRAY(SELECT unnest(m.topic_tags) INTERSECT SELECT unnest(p_topic_tags))
             )::float
           END                                              AS topic_boost,
           GREATEST(m.summary_sim, m.centroid_sim)          AS sim_max
      FROM merged m
  ),
  -- Floor: drop sections where BOTH cosine signals miss the min_sim
  -- threshold. Topic boost alone is not enough to surface a section the
  -- query is semantically distant from.
  gated AS (
    SELECT s.section_id,
           s.sample_id,
           s.title,
           s.summary_sim,
           s.centroid_sim,
           s.topic_boost,
           (s.sim_max + s.topic_boost)::float AS score
      FROM scored s, params
     WHERE s.sim_max >= params.min_sim
  )
  SELECT g.section_id, g.sample_id, g.title,
         g.summary_sim, g.centroid_sim, g.topic_boost, g.score
    FROM gated g, params
   ORDER BY g.score DESC
   LIMIT (SELECT top_s FROM params);
END;
$$;

COMMENT ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float) IS
  'v3 routing: returns top-S sections for a query. Score = max(cos(query, summary_emb), cos(query, centroid_emb)) + soft topic_tags overlap boost (lambda*intersection). Partial-HNSW pushdown via TEXTUAL `IS NOT NULL` predicates on both embedding columns (audit M3 — required for planner to pick the partial index). HNSW strict_order preserves true distance order so post-filter floor (creator_id) returns true top-K. Caller passes session-closure-captured creator_id; SECURITY DEFINER. p_top_s clamped [1,10], p_min_sim [0,1]. p_topic_tags NULL or empty array disables the soft boost.';

REVOKE ALL ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)
  TO service_role, authenticated;
