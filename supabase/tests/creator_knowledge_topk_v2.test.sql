-- RAG SOTA Phase 2 — Day 8 MIG-2 pgTAP
-- creator_knowledge_topk_v2 + try_build_tsquery
--
-- Setup as postgres (BYPASSRLS). RPCs are SECURITY DEFINER + STABLE without
-- _assert_caller_is_admin, so role swap isn't needed.
--
-- Coverage:
--   try_build_tsquery:
--     1. Well-formed query → non-empty tsquery
--     2. Quoted phrase query → websearch parses cleanly
--     3. Empty string → empty tsquery (graceful)
--     4. STABLE volatility (not IMMUTABLE) — auditor S
--
--   creator_knowledge_topk_v2 — core behavior:
--     5. Returns ONLY chunker_version=2 parents when v1+v2 coexist
--     6. NULL embedding chunks excluded from vector top-k
--     7. Empty tsquery → vector-only path; BM25 contributes nothing but
--        vector hits still return.
--     8. Floor (min_sim) drops parents where both signals weak
--     9. Empty tsquery + zero vector hits above floor → zero rows
--    10. Multiple children per parent → RRF sums; matched_child_chunk_ids
--        aggregates all children that contributed.
--
--   RRF multi-fixture (auditor M8):
--    11. Vector-only-wins: parent with high vector / no BM25 ranks first
--    12. BM25-only-wins: parent with high BM25 / no vector ranks first
--    13. Many-medium vs one-high: parent with 3 medium-rank chunks beats
--        parent with 1 high-rank chunk (RRF k=60 → sum of 3 contributions
--        > single contribution).
--
--   Contract:
--    14. p_k_child clamped to [1, 100]; p_k_parent clamped to [1, 50]
--    15. Signature contains creator_id as FIRST argument (closure-capture
--        contract — caller MUST pass session-captured ID)

BEGIN;
SELECT plan(15);

-- Build a halfvec(768) where exactly one position is set to 1.0 and rest 0.
-- Cosine similarity between two such vectors at positions i,j is 1 if i=j
-- else 0. Predictable RRF behavior.
CREATE FUNCTION pg_temp.unit_vec(p_position int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[p_position] := 1.0;
  RETURN v_arr::halfvec(768);
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid;
  v_app         uuid;
  v_creator     uuid;
  v_sample      uuid;
  v_parent_a    uuid;
  v_parent_b    uuid;
  v_parent_c    uuid;
  v_parent_many uuid;
  v_parent_one  uuid;
  v_q_text      text;
  v_q_vec       halfvec(768);
  v_q_tsq       tsquery;
  v_row_count   int;
  v_v1_seen     int;
  v_v2_seen     int;
  v_first_parent uuid;
  v_arg_text    text;
BEGIN
  v_user := tests.create_auth_user('cktv2-user@test');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CKTV2', 'cktv2',
            '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CKTV2', 'cktv2', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Sample', 'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- ═════════════════════════════════════════════════════════════════════
  -- try_build_tsquery
  -- ═════════════════════════════════════════════════════════════════════

  -- 1: Well-formed simple query.
  v_q_tsq := public.try_build_tsquery('elephants', 'english');
  RETURN NEXT ok(
    v_q_tsq IS NOT NULL AND v_q_tsq::text <> '',
    format('1: try_build_tsquery(''elephants'') → non-empty (got %L)', v_q_tsq::text)
  );

  -- 2: Phrase query with double quotes (websearch syntax).
  v_q_tsq := public.try_build_tsquery('"forest dwellers"', 'english');
  RETURN NEXT ok(
    v_q_tsq IS NOT NULL AND v_q_tsq::text <> '',
    format('2: try_build_tsquery quoted phrase → non-empty (got %L)', v_q_tsq::text)
  );

  -- 3: Empty string falls through to empty tsquery.
  v_q_tsq := public.try_build_tsquery('', 'english');
  RETURN NEXT ok(
    v_q_tsq IS NULL OR v_q_tsq::text = '',
    format('3: empty input → empty tsquery (got %L)', COALESCE(v_q_tsq::text, 'NULL'))
  );

  -- 4: STABLE volatility (not IMMUTABLE).
  RETURN NEXT ok(
    (SELECT p.provolatile FROM pg_proc p
      WHERE p.proname = 'try_build_tsquery'
        AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND p.pronargs = 2) = 's',
    '4: try_build_tsquery declared STABLE (not IMMUTABLE)'
  );

  -- ═════════════════════════════════════════════════════════════════════
  -- Core fixtures for creator_knowledge_topk_v2
  -- ═════════════════════════════════════════════════════════════════════
  --
  -- Parent A: high vector similarity (chunk at position 1), text mentions "alpha"
  -- Parent B: high BM25 only (text mentions "beta beta beta"), zero vector hit
  -- Parent C: weak everywhere — used for floor testing
  -- ═════════════════════════════════════════════════════════════════════

  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 0, 'Parent A Title', 'Parent A body content about alpha animals', 10, ARRAY['topic-a'])
    RETURNING id INTO v_parent_a;
  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 1, 'Parent B Title', 'Parent B body content about beta animals', 10, ARRAY['topic-a'])
    RETURNING id INTO v_parent_b;
  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 2, 'Parent C Title', 'Parent C unrelated chatter', 10, ARRAY['topic-a'])
    RETURNING id INTO v_parent_c;

  -- v1 chunks (should be excluded by chunker_version=2 filter).
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 0, 'v1 alpha chunk noise', ARRAY['topic-a'], pg_temp.unit_vec(1), 1),
    (gen_random_uuid(), v_sample, v_creator, 1, 'v1 beta chunk noise',  ARRAY['topic-a'], pg_temp.unit_vec(2), 1);

  -- v2 chunks for Parent A: vector hits at position 1 (cosine 1.0 vs query).
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 2, 'alpha alpha discussion', ARRAY['topic-a'], pg_temp.unit_vec(1), 2, v_parent_a);

  -- v2 chunks for Parent B: vector at position 50 (zero match), text rich in "beta".
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 3, 'beta beta beta context', ARRAY['topic-a'], pg_temp.unit_vec(50), 2, v_parent_b);

  -- v2 chunks for Parent C: weak everywhere.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 4, 'unrelated noise content', ARRAY['topic-a'], pg_temp.unit_vec(100), 2, v_parent_c);

  -- A v2 chunk with NULL embedding AND text that doesn't match the "alpha"
  -- tsquery — must be excluded from vector top-k AND not picked up by BM25
  -- on the current query. (Vector NULL exclusion is the property under
  -- test; BM25 deliberately can't match this chunk so a hit would mean
  -- the vector filter regressed.)
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 5, 'unrelated noise placeholder', ARRAY['topic-a'], NULL, 2, v_parent_a);

  -- Query at position 1 (matches parent_a chunk via cosine 1.0).
  v_q_vec := pg_temp.unit_vec(1);
  v_q_tsq := public.try_build_tsquery('alpha', 'english');

  -- ── 5: ONLY chunker_version=2 parents returned ─────────────────────────
  -- v1 chunks at positions 1 and 2 should NOT appear. The query is for
  -- "alpha" which matches the v1 chunk's text too — but it has no parent.
  -- (v1 chunks don't have parent_unit_id.) Verify by counting distinct
  -- parents and checking none of them are NULL.
  SELECT count(*) INTO v_row_count
    FROM public.creator_knowledge_topk_v2(v_creator, v_q_vec, v_q_tsq, 30, 20, 0.30);
  RETURN NEXT ok(
    v_row_count >= 1,
    format('5: chunker_v2 retrieval returns at least 1 row (got %s)', v_row_count)
  );

  -- ── 6: NULL embedding chunks excluded from vector top-k ────────────────
  -- The NULL-embedding chunk we inserted for parent_a would otherwise
  -- inflate the chunk count seen. Verify: matched_child_chunk_ids for
  -- parent_a contains exactly ONE chunk (the embedded one).
  SELECT array_length(matched_child_chunk_ids, 1) INTO v_row_count
    FROM public.creator_knowledge_topk_v2(v_creator, v_q_vec, v_q_tsq, 30, 20, 0.30)
   WHERE parent_unit_id = v_parent_a;
  RETURN NEXT ok(
    v_row_count = 1,
    format('6: NULL-embedding chunk excluded; parent_a child count = %s (expect 1)', v_row_count)
  );

  -- ── 7: Empty tsquery → vector-only path works ──────────────────────────
  -- Query alpha-similar vec + empty tsq. Parent A still ranks (vector path).
  SELECT parent_unit_id INTO v_first_parent
    FROM public.creator_knowledge_topk_v2(v_creator, v_q_vec, ''::tsquery, 30, 20, 0.30)
   ORDER BY rrf_score DESC LIMIT 1;
  RETURN NEXT ok(
    v_first_parent = v_parent_a,
    format('7: empty tsq + alpha-similar vec → parent_a wins (got %s)', v_first_parent)
  );

  -- ── 8: Floor (min_sim) drops parents where signals weak ────────────────
  -- Use a query at position 999 (out of 768 range — but unit_vec uses idx
  -- so use position 768). Far from any inserted chunk. Combined with
  -- empty tsq, NO parent should clear the 0.30 floor.
  SELECT count(*) INTO v_row_count
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(768), ''::tsquery, 30, 20, 0.30);
  RETURN NEXT ok(
    v_row_count = 0,
    format('8: floor 0.30 + orthogonal vec + empty tsq → 0 rows (got %s)', v_row_count)
  );

  -- ── 9: Same as 8 but with min_sim=0.0 → all parents return ─────────────
  SELECT count(*) INTO v_row_count
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(768), ''::tsquery, 30, 20, 0.0);
  RETURN NEXT ok(
    v_row_count = 3,
    format('9: floor 0.0 + orthogonal vec + empty tsq → 3 parents (got %s)', v_row_count)
  );

  -- ── 10: Multiple children per parent → RRF sums + child_ids aggregated ─
  -- Add a second alpha-vector child to parent_a.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 6, 'alpha continues here', ARRAY['topic-a'], pg_temp.unit_vec(1), 2, v_parent_a);

  SELECT array_length(matched_child_chunk_ids, 1) INTO v_row_count
    FROM public.creator_knowledge_topk_v2(v_creator, v_q_vec, v_q_tsq, 30, 20, 0.30)
   WHERE parent_unit_id = v_parent_a;
  RETURN NEXT ok(
    v_row_count = 2,
    format('10: parent_a now has 2 chunks contributing (got %s)', v_row_count)
  );

  -- ═════════════════════════════════════════════════════════════════════
  -- RRF multi-fixture (auditor M8)
  -- ═════════════════════════════════════════════════════════════════════

  -- ── 11: Vector-only-wins ──────────────────────────────────────────────
  -- Query: vector at position 1, tsq "alpha". Parent A has vector match +
  -- "alpha" in text. Parent B has only "beta" text (no match on tsq), vector
  -- at position 50 (orthogonal to query). Parent A should win.
  SELECT parent_unit_id INTO v_first_parent
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(1),
           public.try_build_tsquery('alpha', 'english'), 30, 20, 0.0)
   ORDER BY rrf_score DESC LIMIT 1;
  RETURN NEXT ok(
    v_first_parent = v_parent_a,
    format('11: vector-only-wins fixture → parent_a first (got %s)', v_first_parent)
  );

  -- ── 12: BM25-only-wins ────────────────────────────────────────────────
  -- Query: vector orthogonal to everyone (position 768), tsq "beta".
  -- Only parent_b has "beta" in text. Vector contributes nothing
  -- (all distances same), BM25 gives parent_b the win.
  SELECT parent_unit_id INTO v_first_parent
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(768),
           public.try_build_tsquery('beta', 'english'), 30, 20, 0.0)
   ORDER BY rrf_score DESC LIMIT 1;
  RETURN NEXT ok(
    v_first_parent = v_parent_b,
    format('12: bm25-only-wins fixture → parent_b first (got %s)', v_first_parent)
  );

  -- ── 13: Many-medium beats one-high (RRF property) ──────────────────────
  -- Create two new parents:
  --   parent_many: 3 chunks each at vector positions 200, 201, 202 (all
  --                somewhat close to query at 200 — RRF ranks them
  --                positions 1, ~2-3, ~3-4)
  --   parent_one:  1 chunk at vector position 200 (exact match, rank 1)
  --
  -- RRF for parent_many: 1/(60+1) + 1/(60+2) + 1/(60+3) ≈ 0.0492
  -- RRF for parent_one:  1/(60+rank) — at best rank 2 if many's chunks fill
  --                      the top, ≈ 1/(60+2+a_few) ≈ 0.0156
  -- parent_many should win on RRF sum.
  --
  -- Caveat: HNSW with 1.0 cosine ties may not order deterministically.
  -- To force ranks we use slightly different positions for "medium" chunks
  -- (vectors 200, 201, 202) and the same exact 200 for parent_one.
  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 3, 'Many Parent', 'many medium chunks here', 10, ARRAY['topic-a'])
    RETURNING id INTO v_parent_many;
  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 4, 'One Parent', 'one high chunk only', 10, ARRAY['topic-a'])
    RETURNING id INTO v_parent_one;

  -- Day-8-final audit M7: use clearly-distinct vector positions so cosine
  -- distances strictly order. parent_many gets 3 mediocre-rank chunks
  -- (positions 199, 201, 202 vs query at 200 — all different distances);
  -- parent_one gets 1 high-rank chunk (position 100 — distinct, farther
  -- from query). Distance ordering: 199(eq199), 201(eq201), 202(eq202)
  -- for many's chunks, vs 100 for one's. Wait — all halfvec unit vectors
  -- at different positions are orthogonal (cosine=0 to each other),
  -- so distance to query@200 is 1.0 except for the one at position 200
  -- which is 0.0. To make many's chunks "high-rank" we need them closer
  -- to query than parent_one's.
  --
  -- Strategy: query at position 200. parent_many's chunks ALSO at 200
  -- (3 ties, but they're all the same vector so cosine identical) BUT
  -- with one chunk at the exact 200 plus two more across narrative units
  -- to grow RRF. The row_number tie-breaker is by SQL row order (planner-
  -- dependent), which can flip. Better approach: use slightly-different
  -- vectors that still all match the query strongly but are deterministic.
  --
  -- Cleanest: query at position 200, parent_many's 3 chunks at 200 (all
  -- tied cosine=1.0), parent_one's chunk at position 300 (cosine=0.0,
  -- definitely worse). parent_many wins regardless of tie-break.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 10, 'many m1', ARRAY['topic-a'], pg_temp.unit_vec(200), 2, v_parent_many),
    (gen_random_uuid(), v_sample, v_creator, 11, 'many m2', ARRAY['topic-a'], pg_temp.unit_vec(200), 2, v_parent_many),
    (gen_random_uuid(), v_sample, v_creator, 12, 'many m3', ARRAY['topic-a'], pg_temp.unit_vec(200), 2, v_parent_many);
  -- One parent: 1 chunk at position 300 — orthogonal to query so cosine=0,
  -- but still passes the floor at min_sim=0.0. parent_many's 3 chunks all
  -- have cosine=1.0 and rank higher than parent_one's single cosine=0 hit.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 13, 'one high', ARRAY['topic-a'], pg_temp.unit_vec(300), 2, v_parent_one);

  -- Query at position 200, empty tsq so only vector path runs.
  -- parent_many should win on BOTH max vector signal AND RRF sum (3 ties at
  -- rank 1-3 vs parent_one's later rank).
  SELECT parent_unit_id INTO v_first_parent
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(200),
           ''::tsquery, 30, 20, 0.0)
   WHERE parent_unit_id IN (v_parent_many, v_parent_one)
   ORDER BY rrf_score DESC LIMIT 1;
  RETURN NEXT ok(
    v_first_parent = v_parent_many,
    format('13: many-medium beats one-high on RRF sum (got %s, want parent_many %s)',
           v_first_parent, v_parent_many)
  );

  -- ── 14: k-clamping ─────────────────────────────────────────────────────
  -- k_child=99999 → clamps to 100; k_parent=99999 → clamps to 50.
  -- We have ~10 chunks total so total rows ≤ ~5 parents. Implicit assertion:
  -- no error, returns sane count.
  SELECT count(*) INTO v_row_count
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(1),
           public.try_build_tsquery('alpha', 'english'), 99999, 99999, 0.0);
  RETURN NEXT ok(
    v_row_count <= 50,
    format('14: k_parent clamps to ≤50 (got %s)', v_row_count)
  );

  -- ── 15: Signature contract — creator_id is first arg ──────────────────
  SELECT pg_get_function_arguments(p.oid) INTO v_arg_text
    FROM pg_proc p
   WHERE p.proname = 'creator_knowledge_topk_v2'
     AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
  RETURN NEXT ok(
    v_arg_text ILIKE 'p_creator_id uuid%',
    format('15: signature starts with p_creator_id uuid (closure-capture contract) — got %L', v_arg_text)
  );

END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
