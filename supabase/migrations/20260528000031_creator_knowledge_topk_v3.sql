-- 20260528000031 — _creator_knowledge_topk_v3 (RAG v3 step 5 / plan §4 item 6).
--
-- The scoped hybrid retrieval RPC. Caller has already run
-- _creator_route_sections_v3 (mig 30) and passes the resulting top-S
-- section_ids here. We do vector + BM25 + RRF over the v3 child chunks
-- restricted to (creator_id, chunker_version=3, section_id = ANY(p_section_ids))
-- — the "right unit competes inside its own neighborhood's top-N, not against
-- a global SUM-RRF top-20 that buries it" promise from plan §0 #2.
--
-- ── Ranking is PARAMETERIZED — DO NOT freeze without the harness ────────
-- §3b carry-over from the RAG live-fix workstream: parent aggregation is
-- the load-bearing decision and must be MEASURED, never pre-committed.
-- p_rank_mode picks one of four candidates from plan §3b:
--
--   'max'        — pure MAX(child_rrf). The most aggressive needle-surfacer
--                  (single strongest beat wins). Risk: noisy.
--   'max_blend'  — MAX(child_rrf) + lambda * ln(1 + n_children). The DEFAULT
--                  (audit round-4 M2 — canonical IDs pinned). Conservative
--                  prior: rewards the strongest signal but gives a small
--                  bonus to parents with many corroborating hits.
--   'vec_max'    — MAX(vec_sim) with BM25 as tiebreak. Tiebreak encoded as
--                  +1e-4 * (1 - 1/(1+MAX(bm25_rank))) — BOUNDED in [0, 1e-4)
--                  per audit C4 (ts_rank_cd is unbounded above; a heavily-
--                  matched chunk with bm25_rank≈15 would otherwise produce a
--                  +1.5e-3 boost — within an order of magnitude of real
--                  cosine deltas — defeating "pure vector with bm25 only
--                  when vector ties"). rrf_score is meaningless under this
--                  mode (audit M5) — caller dashboards must NOT compare
--                  rrf_score across modes.
--   'best_child' — same parent_score formula as 'max' BUT matched_child_chunk_ids
--                  is collapsed to the SINGLE best child id (vs all candidate
--                  children for the other modes). Downstream injection sees
--                  one chunk per parent — useful when the "needle" is a
--                  specific quote, not an aggregated theme. Audit M7: caller
--                  MUST NOT compute weighted features from
--                  `cardinality(matched_child_chunk_ids)` — it is MODE-DEPENDENT.
--
-- Unknown p_rank_mode → RAISE EXCEPTION (fail-loud, never silent-default).
--
-- ── parent_score column (audit round-2 M7 + round-4 Small) ──────────────
-- v3 returns a column named `parent_score` (NOT `rrf_score`) so v2's
-- SUM-RRF score and v3's per-rank-mode aggregation are NEVER compared as
-- the same metric in dashboards / telemetry. `rrf_score` is also returned
-- (raw SUM of children's RRF) for parity-debugging with v2 — the proxy/
-- telemetry SHOULD ignore it and sort on parent_score.
--
-- ── min_sim floor — placeholder until §7 harness pins it ────────────────
-- v2's 0.30 was tuned for SUM-RRF and is meaningless for MAX-child ranking
-- (plan §4 item 6 + §7 #3 + #7 — "harness-produced p_min_sim value pinned
-- in code" is the prod-flip blocker). Default 0.30 here is conservative so
-- the migration is shippable; the harness must rewrite this default before
-- v3 takes prod traffic. The floor gates on the UNDERLYING signals
-- regardless of rank_mode — "definitely not relevant" doesn't depend on
-- the score formula picked. BM25-side gating is EXISTENCE of a bm25_top hit,
-- not `MAX(bm25_rank) >= 1e-6` — audit C3: ts_rank_cd can legitimately return
-- 0.0 on a real match (chunk has the term but no proximity bonus); the
-- threshold-on-rank version silently dropped lexical-only matches. Now any
-- chunk that appeared in bm25_top (i.e. `text_search @@ p_query_tsq` fired)
-- counts as bm25 signal — true to "the parent had a real lexical match."
--
-- ── Top-N PER SECTION clamp ─────────────────────────────────────────────
-- p_n_parent_per_section is the second new knob (vs v2's flat p_k_parent).
-- With S sections × N parents/section we cap at S*N total rows. Window
-- function partitions by section_id so the rerank candidate set is balanced
-- across sections — prevents one over-recalled section from swamping the
-- rerank input while a thin-recall section gets 0 representation.
--
-- ── HNSW strict_order + partial-HNSW pushdown ───────────────────────────
-- Same pattern as v2 + the route RPC: set_config('hnsw.iterative_scan',
-- 'strict_order', true) for true distance ordering under post-filter, and
-- the WHERE clause includes `c.embedding IS NOT NULL` textually so the
-- planner picks the partial HNSW index (the v2 HNSW partial index already
-- covers all chunker_versions — sample_content_chunks does NOT have a
-- chunker_version=3-specific HNSW yet; one global partial index serves all
-- read paths, filtered by chunker_version in the WHERE).
--
-- ── TODO: chunker_version=3-specific partial HNSW at scale ──────────────
-- The shared partial-HNSW index serves v1/v2/v3 reads today. Once v3 chunks
-- exceed ~50k rows in prod, build a dedicated partial HNSW for
-- chunker_version=3 to avoid v3 reads paying for v1/v2 noise in HNSW
-- candidate generation (audit S7). Gate the rebuild on:
--   SELECT count(*) FROM sample_content_chunks WHERE chunker_version=3;
-- and run as a CONCURRENTLY operation off-hours.

CREATE FUNCTION public._creator_knowledge_topk_v3(
  p_creator_id            uuid,
  p_section_ids           uuid[],
  p_query_vec             halfvec(768),
  p_query_tsq             tsquery,
  p_k_child               int     DEFAULT 30,
  p_n_parent_per_section  int     DEFAULT 5,
  p_min_sim               float   DEFAULT 0.30,
  p_rank_mode             text    DEFAULT 'max_blend',
  p_lambda                float   DEFAULT 0.10
) RETURNS TABLE (
  parent_unit_id           uuid,
  parent_text              text,
  parent_title             text,
  sample_id                uuid,
  source_type              public.sample_source_type,
  section_id               uuid,
  vector_score             float,
  bm25_score               float,
  rrf_score                float,
  parent_score             float,
  matched_child_chunk_ids  uuid[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- Fail-loud on unknown rank_mode. Frozen canonical IDs (audit M2):
  -- silently defaulting to 'max_blend' would let a caller-typo skew harness
  -- results. The set is small + pinned in §4 item 6 + cross-referenced in §7.
  IF p_rank_mode IS NULL
     OR p_rank_mode NOT IN ('max', 'max_blend', 'vec_max', 'best_child') THEN
    RAISE EXCEPTION
      'creator_knowledge_topk_v3: unknown p_rank_mode'
      USING DETAIL = format('got=%s; allowed=max | max_blend | vec_max | best_child',
                             coalesce(p_rank_mode, '<null>'));
  END IF;

  -- Empty section list → zero rows (caller's route RPC returned nothing).
  -- Cheap short-circuit before the HNSW set_config.
  IF p_section_ids IS NULL OR cardinality(p_section_ids) = 0 THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY
  WITH params AS (
    -- Clamps. Audit M2: p_lambda's upper bound is 10.0 (not 1.0) so the §7
    -- harness can sweep the high end of the regime; if it turns out 1.4 is
    -- the local optimum we don't want a 1.0 clamp to silently mis-report.
    -- p_k_child clamped at 100 (one HNSW batch); p_n_parent_per_section at
    -- 20 (rerank batch is k=20-25). Both are hard ceilings the harness must
    -- not exceed — clamping silently is intentional (caller is buggy if it
    -- asks for more); the COMMENT documents the limits.
    SELECT GREATEST(1, LEAST(p_k_child,              100))::int   AS k_child,
           GREATEST(1, LEAST(p_n_parent_per_section,  20))::int   AS n_per_section,
           GREATEST(0::float, LEAST(p_min_sim, 1.0))              AS min_sim,
           GREATEST(0::float, LEAST(p_lambda, 10.0))              AS lambda,
           p_rank_mode                                            AS rank_mode
  ),
  vec_top AS (
    SELECT c.id              AS chunk_id,
           c.parent_unit_id  AS parent_unit_id,
           c.section_id      AS section_id,
           1 - (c.embedding <=> p_query_vec) AS sim,
           row_number() OVER (ORDER BY c.embedding <=> p_query_vec) AS rk
      FROM public.sample_content_chunks c, params
     WHERE c.creator_id = p_creator_id
       AND c.chunker_version = 3
       AND c.section_id = ANY(p_section_ids)
       AND c.embedding IS NOT NULL          -- partial-HNSW pushdown (same contract as v2)
       AND c.parent_unit_id IS NOT NULL
     ORDER BY c.embedding <=> p_query_vec
     LIMIT (SELECT k_child FROM params)
  ),
  bm25_top AS (
    SELECT c.id              AS chunk_id,
           c.parent_unit_id  AS parent_unit_id,
           c.section_id      AS section_id,
           ts_rank_cd(c.text_search, p_query_tsq)::float AS rnk,
           row_number() OVER (ORDER BY ts_rank_cd(c.text_search, p_query_tsq) DESC) AS rk
      FROM public.sample_content_chunks c, params
     WHERE c.creator_id = p_creator_id
       AND c.chunker_version = 3
       AND c.section_id = ANY(p_section_ids)
       AND c.parent_unit_id IS NOT NULL
       AND c.text_search @@ p_query_tsq
     ORDER BY ts_rank_cd(c.text_search, p_query_tsq) DESC
     LIMIT (SELECT k_child FROM params)
  ),
  combined AS (
    SELECT COALESCE(v.chunk_id,        b.chunk_id)        AS chunk_id,
           COALESCE(v.parent_unit_id,  b.parent_unit_id)  AS parent_unit_id,
           COALESCE(v.section_id,      b.section_id)      AS section_id,
           v.sim                                          AS vec_sim,
           b.rnk                                          AS bm25_rank,
           v.rk                                           AS vec_rk,
           b.rk                                           AS bm25_rk
      FROM vec_top v
      FULL OUTER JOIN bm25_top b ON b.chunk_id = v.chunk_id
  ),
  scored AS (
    SELECT chunk_id,
           parent_unit_id,
           section_id,
           vec_sim,
           bm25_rank,
           (1.0 / (60 + COALESCE(vec_rk,  10000)))
         + (1.0 / (60 + COALESCE(bm25_rk, 10000))) AS rrf
      FROM combined
  ),
  -- Group by parent. Compute every aggregate up-front; the rank_mode CASE
  -- below picks ONE of these to become parent_score. Doing all four
  -- aggregates is cheap (small N from k_child cap) and keeps the SELECT
  -- shape stable across modes.
  -- Group by parent_unit_id, projecting section_id from narrative_units
  -- (NOT the denormalized chunks.section_id) — round-5 audit C2.
  --
  -- WHY: the denormalized chunks.section_id is enforced to match
  -- parent_unit.section_id at write time by _insert_chunk_v3_unsafe (mig 14),
  -- but a raw-INSERT bypass or backfill bug could spread a parent across
  -- two sections. Trusting the denormalization would split the parent into
  -- two rows here — double-counting parent budget under the per-section
  -- clamp and polluting rerank with duplicate parent_text. Joining
  -- narrative_units gives the AUTHORITATIVE section per parent → exactly
  -- one row per parent, always.
  --
  -- Cost: 100-row JOIN (scored is bounded by k_child=100), negligible.
  --
  -- `has_bm25`: bool_or(bm25_rank IS NOT NULL) — used by the floor below.
  -- TRUE iff at least one of this parent's children appeared in bm25_top
  -- (i.e. `text_search @@ p_query_tsq` fired). Distinct from "max_bm25 > 0"
  -- because ts_rank_cd can legitimately return 0.0 on a real match (audit C3).
  parent_grouped AS (
    SELECT s.parent_unit_id,
           u.section_id,                                      -- authoritative
           COUNT(*)::int                                      AS n_children,
           MAX(COALESCE(s.vec_sim, 0))::float                 AS max_vec,
           MAX(COALESCE(s.bm25_rank, 0))::float               AS max_bm25,
           bool_or(s.bm25_rank IS NOT NULL)                   AS has_bm25,
           MAX(s.rrf)::float                                  AS max_rrf,
           SUM(s.rrf)::float                                  AS rrf_sum,
           array_agg(s.chunk_id ORDER BY s.rrf DESC)          AS all_child_ids,
           (array_agg(s.chunk_id ORDER BY s.rrf DESC))[1:1]   AS best_child_id_arr
      FROM scored s
      JOIN public.sample_content_narrative_units u
        ON u.id = s.parent_unit_id
     WHERE s.parent_unit_id IS NOT NULL
       AND u.section_id     IS NOT NULL  -- v3 invariant; v1/v2 units excluded
     GROUP BY s.parent_unit_id, u.section_id
  ),
  -- Floor: keep parents where EITHER vector signal cleared min_sim OR any
  -- child had a real lexical match (`has_bm25`). The previous threshold
  -- `MAX(bm25_rank) >= 1e-6` silently dropped lexical-only matches when
  -- ts_rank_cd was 0.0 (audit C3) — exactly the "he blanks on something
  -- he plainly knows" failure mode plan §0.0 calls the worst outcome.
  filtered AS (
    SELECT pg.*
      FROM parent_grouped pg, params
     WHERE pg.max_vec >= params.min_sim
        OR pg.has_bm25
  ),
  -- Pick parent_score per rank_mode + collapse matched_child_chunk_ids for
  -- 'best_child' only. 'vec_max' encodes BM25 as a +1e-4 tiebreak so a
  -- single ORDER BY parent_score DESC resolves cleanly.
  rank_scored AS (
    SELECT f.parent_unit_id,
           f.section_id,
           f.max_vec,
           f.max_bm25,
           f.rrf_sum,
           CASE p.rank_mode
             WHEN 'max'        THEN f.max_rrf
             WHEN 'max_blend'  THEN f.max_rrf + p.lambda * ln(1 + f.n_children)
             -- vec_max tiebreak BOUNDED in [0, 1e-4) — audit C4. ts_rank_cd
             -- is unbounded above, so a heavily-matched chunk with
             -- bm25_rank≈15 would otherwise add ~1.5e-3 to parent_score,
             -- within an order of magnitude of real cosine deltas
             -- (0.82 vs 0.819 differs by 1e-3) — defeating "pure vector with
             -- bm25 only when vector ties." 1 - 1/(1+x) is the saturating
             -- map (0→0, ∞→1) → bounded tiebreak.
             WHEN 'vec_max'    THEN f.max_vec + 1e-4 * (1 - 1.0 / (1 + f.max_bm25))
             WHEN 'best_child' THEN f.max_rrf
           END AS parent_score,
           CASE p.rank_mode
             WHEN 'best_child' THEN f.best_child_id_arr
             ELSE                   f.all_child_ids
           END AS matched_child_ids
      FROM filtered f, params p
  ),
  -- Top-N PER SECTION clamp. Window partitioned by section_id so each
  -- section contributes at most n_per_section parents — prevents one
  -- over-recalled section from swamping rerank input.
  -- Tiebreak: (parent_score DESC, section_id, parent_unit_id) — audit M6.
  -- section_id is uuid (random) but at least gives intra-section grouping
  -- meaning; parent_unit_id is the leaf-level uuid fallback (deterministic
  -- under fixed fixtures, though "fixture-pinned" rather than natural).
  per_section_ranked AS (
    SELECT rs.*,
           row_number() OVER (
             PARTITION BY rs.section_id
             ORDER BY rs.parent_score DESC, rs.section_id, rs.parent_unit_id
           ) AS rn
      FROM rank_scored rs
  ),
  clamped AS (
    SELECT psr.*
      FROM per_section_ranked psr, params
     WHERE psr.rn <= params.n_per_section
  ),
  -- Pre-truncate parent unit text before JOIN (same M6 optimization as v2).
  parent_units_truncated AS (
    SELECT u.id,
           u.sample_id,
           u.title,
           LEFT(u.text, 3500) AS text_truncated
      FROM public.sample_content_narrative_units u
     WHERE u.id IN (SELECT parent_unit_id FROM clamped)
  )
  SELECT
    c.parent_unit_id                   AS parent_unit_id,
    put.text_truncated                 AS parent_text,
    put.title                          AS parent_title,
    put.sample_id                      AS sample_id,
    s.source_type                      AS source_type,
    c.section_id                       AS section_id,
    c.max_vec                          AS vector_score,
    c.max_bm25                         AS bm25_score,
    c.rrf_sum                          AS rrf_score,
    c.parent_score                     AS parent_score,
    c.matched_child_ids                AS matched_child_chunk_ids
    FROM clamped c
    JOIN parent_units_truncated put ON put.id = c.parent_unit_id
    JOIN public.sample_content s    ON s.id  = put.sample_id
   ORDER BY c.parent_score DESC, c.section_id, c.parent_unit_id;  -- audit M6: section_id bucketing then leaf uuid
END;
$$;

COMMENT ON FUNCTION public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float) IS
  'v3 SCOPED hybrid retrieval (vector + BM25 + RRF) over chunker_version=3 chunks restricted to (creator_id, section_id = ANY(p_section_ids)). Returns top-p_n_parent_per_section parents PER SECTION (S sections × N parents = max rows) with per-rank-mode `parent_score` (distinct from v2''s `rrf_score` so SUM-RRF and MAX-child scores never compare as the same metric — audit round-2 M7). p_rank_mode: max | max_blend (default — MAX(rrf) + lambda*ln(1+n_children)) | vec_max | best_child. Unknown rank_mode RAISES (fail-loud, no silent default). CALLER MUST PASS SESSION-CLOSURE-CAPTURED creator_id — never from req.body. p_section_ids comes from _creator_route_sections_v3. p_min_sim default 0.30 is a PLACEHOLDER (the §7 harness pins the prod value before v3 takes traffic). HNSW strict_order + textual `embedding IS NOT NULL` for partial-HNSW pushdown. Pre-truncates parent text 3500 chars before JOIN. Reranking is CALLER''s job; this RPC is BM25+vector+RRF only. p_lambda clamped [0, 10.0] (consumed by max_blend only — ignored for other modes). CALLER CONTRACTS (audit round-5): (1) rrf_score is MEANINGLESS under vec_max (mode uses cosine only); (2) cardinality(matched_child_chunk_ids) is MODE-DEPENDENT (1 for best_child, k for others — never weight features on it).';

REVOKE ALL ON FUNCTION public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)
  TO service_role, authenticated;
