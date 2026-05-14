-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8 MIG-2
-- creator_knowledge_topk_v2 (hybrid retrieval RPC) + try_build_tsquery helper
-- ─────────────────────────────────────────────────────────────────────────
--
-- This is the production read path for creators on retrieval_version=2.
-- v1 path (creator_knowledge_topk) is already chunker_version=1-filtered
-- in Phase 1 migration 20260514000003, so v1 and v2 readers never see each
-- other's chunks.
--
-- Hybrid pipeline (vector + BM25 + RRF) in one RPC:
--   1. Vector top-p_k_child via halfvec cosine over chunker_version=2 chunks
--   2. BM25 top-p_k_child via ts_rank_cd on text_search tsvector (chunk_context
--      prefix is already folded into text_search via the GENERATED column)
--   3. Reciprocal-rank fusion (k=60) over the two ranked lists
--   4. Group by parent_unit_id; sum RRF across children sharing a parent
--   5. Floor: drop parents where MAX(vector) < p_min_sim AND MAX(bm25) < 1e-6
--      (neither signal fired — definitely not relevant)
--   6. JOIN narrative_units for parent title/text; pre-truncate parent text
--      to 3500 chars in a subquery BEFORE the JOIN so we don't ship full
--      8000-char rows over the wire just to project-truncate (audit M6).
--
-- Reranking is the CALLER's job (proxy / Next), AFTER this RPC returns
-- top-p_k_parent candidates. This RPC is BM25+vector+RRF only — fast,
-- pure-SQL, no external calls.
--
-- Caller MUST pass session-closure-captured creator_id, never from req.body.
-- The COMMENT below is the contract; no separate audit assertion needed.
-- Same pattern as the legacy creator_knowledge_topk RPC.

-- ── try_build_tsquery: caller-side helper for parsing user text ──────────
-- Caller cannot try/catch a Postgres function call from JS (audit-2 M1).
-- This helper does the try/catch inside plpgsql and always returns a usable
-- tsquery (possibly empty if both parsers fail).
--
-- STABLE (not IMMUTABLE) — websearch_to_tsquery's behavior depends on the
-- text-search configuration which can change at runtime. STABLE is the
-- correct volatility class (auditor Small finding).
--
-- Exception handler narrowed to syntax_error + invalid_text_representation
-- per auditor M5 — was previously WHEN OTHERS which would swallow OOM,
-- statement_timeout, admin cancellation. Same "don't silently catch" rule
-- as the application code (CLAUDE.md).

CREATE FUNCTION public.try_build_tsquery(
  p_text text,
  p_lang regconfig DEFAULT 'english'
) RETURNS tsquery
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
BEGIN
  RETURN websearch_to_tsquery(p_lang, p_text);
EXCEPTION
  WHEN syntax_error OR invalid_text_representation THEN
    BEGIN
      RETURN plainto_tsquery(p_lang, p_text);
    EXCEPTION
      WHEN syntax_error OR invalid_text_representation THEN
        RETURN ''::tsquery;
    END;
END;
$$;

COMMENT ON FUNCTION public.try_build_tsquery(text, regconfig) IS
  'Robust tsquery builder for user-supplied text. Tries websearch_to_tsquery first (handles "phrase queries" and -negation); falls back to plainto_tsquery on parse error; returns empty tsquery if both fail. Caller should NOT try/catch — this RPC guarantees a usable return value. Used by callers of creator_knowledge_topk_v2 to safely pre-parse rewritten queries.';

GRANT EXECUTE ON FUNCTION public.try_build_tsquery(text, regconfig)
  TO service_role, authenticated;

-- ── creator_knowledge_topk_v2: hybrid retrieval ──────────────────────────
--
-- Audit Day-8-final C2: the existing HNSW index on sample_content_chunks
-- has no creator_id predicate. A naive `ORDER BY embedding <=> $vec LIMIT 30`
-- plan returns the 30 globally-nearest chunks, which at 50 creators × 5K
-- chunks each = 250K v2 chunks may contain ZERO for the target creator.
-- Result: silent retrieval miss.
--
-- Fix: pgvector 0.8 ships `hnsw.iterative_scan = 'strict_order'` which
-- iterates more candidates from HNSW until the post-filter (creator_id +
-- chunker_version) is satisfied. plpgsql wrapper applies it transaction-
-- locally via set_config(..., true) — function-clause `SET hnsw.*` fails
-- with "permission denied" on Supabase because custom-extension GUCs
-- require role-level permission that the migration role lacks.
--
-- `strict_order` preserves true distance ordering (vs `relaxed_order`
-- which lets the planner return out-of-order for more speed) — important
-- because we feed rank into RRF and rank assumptions break under relaxed.
CREATE FUNCTION public.creator_knowledge_topk_v2(
  p_creator_id uuid,
  p_query_vec  halfvec(768),
  p_query_tsq  tsquery,
  p_k_child    int   DEFAULT 30,
  p_k_parent   int   DEFAULT 20,
  p_min_sim    float DEFAULT 0.30
) RETURNS TABLE (
  parent_unit_id           uuid,
  parent_text              text,
  parent_title             text,
  sample_id                uuid,
  source_type              public.sample_source_type,
  vector_score             float,
  bm25_score               float,
  rrf_score                float,
  matched_child_chunk_ids  uuid[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- Transaction-local; reverts after the function returns. Soft-fail
  -- on systems without pgvector >= 0.7 so the function still runs on
  -- older boxes (with the C2 caveat: HNSW filter may under-fetch).
  BEGIN
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY
  -- Clamp k bounds at the SQL boundary so a buggy caller can't ask for
  -- LIMIT 999999. Cap k_child at 100 (one batch's worth of HNSW probes),
  -- k_parent at 50 (rerank batch is k=20-25; 50 is comfortable headroom).
  WITH params AS (
    SELECT GREATEST(1, LEAST(p_k_child,  100))::int  AS k_child,
           GREATEST(1, LEAST(p_k_parent, 50))::int   AS k_parent,
           GREATEST(0::float, LEAST(p_min_sim, 1.0)) AS min_sim
  ),
  -- Vector top-k_child. chunker_version=2 hardcoded — v2 chunks are a
  -- permanent enum; cache invalidation lives at creators.current_corpus_version
  -- (MIG-1), not in this filter.
  vec_top AS (
    SELECT c.id            AS chunk_id,
           c.parent_unit_id,
           1 - (c.embedding <=> p_query_vec) AS sim,
           row_number() OVER (ORDER BY c.embedding <=> p_query_vec) AS rk
      FROM public.sample_content_chunks c, params
     WHERE c.creator_id = p_creator_id
       AND c.chunker_version = 2
       AND c.embedding IS NOT NULL
       AND c.parent_unit_id IS NOT NULL
     ORDER BY c.embedding <=> p_query_vec
     LIMIT (SELECT k_child FROM params)
  ),
  -- BM25 top-k_child. text_search GENERATED column already folds
  -- chunk_context prefix + chunk text (see sample_content_chunks DDL).
  -- Empty tsquery (''::tsquery) yields zero rows — try_build_tsquery
  -- returns empty on parse failure, so this branch silently contributes
  -- nothing in that case (vector half still runs).
  bm25_top AS (
    SELECT c.id            AS chunk_id,
           c.parent_unit_id,
           ts_rank_cd(c.text_search, p_query_tsq)::float AS rnk,
           row_number() OVER (ORDER BY ts_rank_cd(c.text_search, p_query_tsq) DESC) AS rk
      FROM public.sample_content_chunks c, params
     WHERE c.creator_id = p_creator_id
       AND c.chunker_version = 2
       AND c.parent_unit_id IS NOT NULL
       AND c.text_search @@ p_query_tsq
     ORDER BY ts_rank_cd(c.text_search, p_query_tsq) DESC
     LIMIT (SELECT k_child FROM params)
  ),
  -- Union the two ranked lists. NULL ranks default to large sentinel so the
  -- RRF contribution from the missing half is ~0 (1/(60+10000) ≈ 0).
  combined AS (
    SELECT COALESCE(v.chunk_id, b.chunk_id)                AS chunk_id,
           COALESCE(v.parent_unit_id, b.parent_unit_id)    AS parent_unit_id,
           v.sim                                           AS vec_sim,
           b.rnk                                           AS bm25_rank,
           v.rk                                            AS vec_rk,
           b.rk                                            AS bm25_rk
      FROM vec_top v
      FULL OUTER JOIN bm25_top b ON b.chunk_id = v.chunk_id
  ),
  -- RRF: 1/(k + rank). k=60 is the canonical default (Cormack et al.
  -- "Reciprocal Rank Fusion outperforms Condorcet and individual Rank
  -- Learning Methods", SIGIR 2009). Missing-list rank → 10000 sentinel.
  scored AS (
    SELECT chunk_id,
           parent_unit_id,
           vec_sim,
           bm25_rank,
           (1.0 / (60 + COALESCE(vec_rk,  10000)))
         + (1.0 / (60 + COALESCE(bm25_rk, 10000))) AS rrf
      FROM combined
  ),
  -- Group by parent: sum RRF, max signals, collect child IDs.
  parent_grouped AS (
    SELECT parent_unit_id,
           SUM(rrf)::float                                    AS rrf_sum,
           MAX(COALESCE(vec_sim, 0))::float                   AS max_vec,
           MAX(COALESCE(bm25_rank, 0))::float                 AS max_bm25,
           array_agg(chunk_id ORDER BY rrf DESC)              AS child_ids
      FROM scored
     WHERE parent_unit_id IS NOT NULL
     GROUP BY parent_unit_id
  ),
  -- Floor: drop parents where neither signal fired meaningfully.
  -- (vector < min_sim) AND (bm25 < 1e-6) means definitely-not-relevant.
  filtered AS (
    SELECT pg.*
      FROM parent_grouped pg, params
     WHERE pg.max_vec  >= params.min_sim
        OR pg.max_bm25 >= 1e-6
  ),
  -- Top k_parent by RRF.
  ranked_parents AS (
    SELECT f.parent_unit_id, f.rrf_sum, f.max_vec, f.max_bm25, f.child_ids
      FROM filtered f, params
     ORDER BY f.rrf_sum DESC
     LIMIT (SELECT k_parent FROM params)
  ),
  -- Pre-truncate narrative unit text to 3500 chars BEFORE the join (audit M6).
  -- Without this, JOIN ships full 8000-char rows for parents we'll truncate
  -- in projection. Pre-truncation lets the planner pick a column-pruning plan.
  parent_units_truncated AS (
    SELECT u.id,
           u.sample_id,
           u.title,
           LEFT(u.text, 3500) AS text_truncated
      FROM public.sample_content_narrative_units u
     WHERE u.id IN (SELECT parent_unit_id FROM ranked_parents)
  )
  SELECT
    rp.parent_unit_id                  AS parent_unit_id,
    put.text_truncated                 AS parent_text,
    put.title                          AS parent_title,
    put.sample_id                      AS sample_id,
    s.source_type                      AS source_type,
    rp.max_vec                         AS vector_score,
    rp.max_bm25                        AS bm25_score,
    rp.rrf_sum                         AS rrf_score,
    rp.child_ids                       AS matched_child_chunk_ids
    FROM ranked_parents rp
    JOIN parent_units_truncated put ON put.id = rp.parent_unit_id
    JOIN public.sample_content s ON s.id = put.sample_id
   ORDER BY rp.rrf_sum DESC;
END;
$$;

COMMENT ON FUNCTION public.creator_knowledge_topk_v2(uuid, halfvec, tsquery, int, int, float) IS
  'Hybrid retrieval RPC (vector + BM25 + RRF) over chunker_version=2 chunks. Returns top-p_k_parent parent narrative units grouped from p_k_child child hits per ranked list, with RRF score, max vector/BM25 signals, and matched child IDs. parent_text server-truncated to 3500 chars in a pre-JOIN subquery. Reranking is the CALLER''S job (proxy / Next), AFTER this RPC returns. CALLER MUST PASS SESSION-CLOSURE-CAPTURED creator_id — never from req.body. Tier routing snapshot occurs at session-open (sessions.tier_at_session) and the proxy carries the captured creator_id in closure for every read. p_query_tsq is parsed via try_build_tsquery — empty tsquery silently skips the BM25 half. Floor: drops parents where MAX(vector) < p_min_sim AND MAX(bm25) < 1e-6.';

GRANT EXECUTE ON FUNCTION public.creator_knowledge_topk_v2(uuid, halfvec, tsquery, int, int, float)
  TO service_role, authenticated;
