-- ─────────────────────────────────────────────────────────────────────────
-- RAG fix #3 — try_build_tsquery: OR-semantics (revive the dead BM25 half)
-- ─────────────────────────────────────────────────────────────────────────
--
-- ROOT CAUSE (measured 2026-05-25 via scripts/diag-retrieve-v2.mjs): the BM25
-- half of creator_knowledge_topk_v2 returned bm25_score=0 for EVERY parent on
-- EVERY natural-language query. Why: the old try_build_tsquery used
-- websearch_to_tsquery, which joins bare terms with AND. For
--   "lumberjack monk businessman hunter what is there to learn from that story"
-- it produced
--   'lumberjack' & 'monk' & 'businessman' & 'hunter' & 'learn' & 'stori'
-- and the RPC's `text_search @@ p_query_tsq` then required a single ~150-token
-- child chunk to contain ALL six lexemes — including the QUESTION words
-- ("learn","story") that aren't even in the corpus. No chunk ever matched all
-- of them, so BM25 contributed nothing AND its empty rank-list still polluted
-- the RRF fusion (it helped demote the strongest vector hit).
--
-- FIX: build the tsquery by OR-joining the query's content lexemes. A chunk
-- that contains SOME of the terms now matches and is scored by ts_rank_cd
-- (which already weights term frequency + proximity), so the lexical signal
-- actually fuses with the vector signal instead of being dead weight.
--   * to_tsvector(p_lang, ...) extracts NORMALIZED/STEMMED lexemes and DROPS
--     true stop words (the/is/there/from/that/to/what …) for free — so the
--     grammatical "question words" the old AND query choked on are already gone.
--   * OR-join the remaining lexemes; cast via to_tsquery (idempotent re-stem).
--   * Empty input (all stop words, or parse failure) → ''::tsquery, which the
--     RPC's BM25 branch already treats as "skip BM25, vector half still runs".
--
-- NOT in scope here (deliberate): ranking parents by MAX child instead of
-- SUM-RRF. That only matters once a creator exceeds the k_parent=20 rerank
-- window (today every unit reaches the reranker), and it belongs with the
-- parent-ranking redesign + eval harness in the RAG scaling work (#4), not
-- bolted on untested. See docs/_planning/RAG_SCALING_ARCHITECTURE_BRIEF.md.
--
-- Signature UNCHANGED (text, regconfig) → no PostgREST cache concern, no caller
-- change: creator_knowledge_topk_v2 + retrieve-knowledge.ts call it as before.
-- STABLE + PARALLEL SAFE preserved. Exception handling preserved (narrow, no
-- WHEN OTHERS) per the original auditor M5.

CREATE OR REPLACE FUNCTION public.try_build_tsquery(
  p_text text,
  p_lang regconfig DEFAULT 'english'
) RETURNS tsquery
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE
  v_lexemes text[];
  v_query   text;
BEGIN
  -- Content lexemes only (stop words removed by the text-search config),
  -- de-duplicated. tsvector_to_array strips positions/weights → bare lexemes.
  -- Audit S3 — array_agg(DISTINCT) order is nondeterministic; that's fine and
  -- intentional: '|' is commutative so term order does not change the tsquery.
  -- Do NOT add ORDER BY thinking it matters (the fn is STABLE, not IMMUTABLE).
  SELECT array_agg(DISTINCT lx)
    INTO v_lexemes
    FROM unnest(tsvector_to_array(to_tsvector(p_lang, p_text))) AS lx;

  IF v_lexemes IS NULL OR array_length(v_lexemes, 1) = 0 THEN
    -- Nothing lexical to match (all stop words / empty). The RPC treats an
    -- empty tsquery as "skip BM25" — the vector half still runs.
    RETURN ''::tsquery;
  END IF;

  v_query := array_to_string(v_lexemes, ' | ');
  RETURN to_tsquery(p_lang, v_query);
EXCEPTION
  -- Narrow handler (original auditor M5 — never WHEN OTHERS, which would swallow
  -- OOM / statement_timeout / cancellation).
  WHEN syntax_error OR invalid_text_representation THEN
    -- Re-audit M6 — middle-tier fallback, restoring the robustness the original
    -- 3-tier builder had. A lexeme that re-tokenizes badly through to_tsquery
    -- (URL / email / host tokens carrying ':' '@' '/' — interpreted as tsquery
    -- weight/operator syntax) would otherwise drop the BM25 half entirely.
    -- plainto_tsquery ANDs terms (the thing we moved off of), but a non-empty
    -- AND query beats zero lexical signal; '' only if even plainto fails.
    BEGIN
      RETURN plainto_tsquery(p_lang, p_text);
    EXCEPTION
      WHEN syntax_error OR invalid_text_representation THEN
        RETURN ''::tsquery;
    END;
END;
$$;

COMMENT ON FUNCTION public.try_build_tsquery(text, regconfig) IS
  'Robust tsquery builder for user-supplied text. OR-joins the content lexemes of p_text (stop words dropped by the text-search config; stemmed; de-duplicated) so a chunk matching SOME query terms scores via ts_rank_cd. Replaced the prior websearch_to_tsquery AND-semantics, which required a single chunk to contain EVERY term (incl. question words) → BM25 returned zero rows for every natural-language query and the dead rank-list polluted RRF. Returns empty tsquery on parse failure / all-stop-word input (caller skips the BM25 half, vector half still runs). Caller should NOT try/catch — guaranteed usable return.';

GRANT EXECUTE ON FUNCTION public.try_build_tsquery(text, regconfig)
  TO service_role, authenticated;
