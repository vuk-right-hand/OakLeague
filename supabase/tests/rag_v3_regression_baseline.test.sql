-- rag_v3_regression_baseline.test.sql
--
-- TRIPWIRE + HYPOTHESIS baseline for the RAG_SCALING_V3_PLAN work.
-- Purpose: BEFORE any v3 code is written, lock the current behavior of the
-- shared surfaces v3 will touch, AND prove the plan's core hypothesis on a
-- synthetic large corpus — so when we start coding we "know the outcome in
-- advance" (Vuk, 2026-05-27).
--
-- Three blocks:
--
--   A. POST-FIX TRIPWIRE — corpus_reprocess_mark_done now BUMPS version + DELETES v1.
--      Migration 20260528000001 (RAG v3 step 1b, R3-C2) folded the
--      version-bump + chunker_version=1 delete into mark_done by delegating
--      to corpus_reprocess_finalize. The assertions LOCK the new contract so
--      a future regression (e.g. an inadvertent revert of mark_done's body
--      back to a pure status-flip) is caught at db:test time, not in prod.
--
--   B. TRIPWIRE — the 3-col UNIQUE (sample_id, chunker_version, chunk_index)
--      rejects an exact duplicate. This pins the dedup that migration
--      20260523000003 added, so the plan's R2-C4 change (a section dimension
--      / NULL-bearing 4-col unique) cannot silently loosen v1/v2 dedup
--      without turning this red.
--
--   C. HYPOTHESIS PROOF — reproduce Wall B (SUM-RRF + k_parent window buries a
--      single-strong "needle" unit at book scale) and prove the plan's two
--      levers recover it, using ONLY columns creator_knowledge_topk_v2 ALREADY
--      returns: rrf_score (= SUM child RRF) and vector_score (= MAX child
--      cosine). No API, no live data, fully deterministic. This is the cheap
--      "does MAX-ranking + a wider window even help" probe the plan calls for
--      as step 0 — runnable today with zero schema change.
--
-- Setup runs as the migration/postgres role (BYPASSRLS). The topk RPC is
-- SECURITY DEFINER so no role swap needed (mirrors creator_knowledge_topk_v2.test).

BEGIN;
SELECT plan(8);

-- One-hot unit vector helper (mirrors creator_knowledge_topk_v2.test).
CREATE FUNCTION pg_temp.unit_vec(p_position int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[p_position] := 1.0;
  RETURN v_arr::halfvec(768);
END;
$$;

-- Two-hot normalized vector: value 0.7071 at positions a and b → unit norm,
-- cosine 0.7071 to a one-hot query at position a. Used for the "mediocre"
-- filler children so they sit strictly below the needle (cosine 1.0) but
-- comfortably above the 0.30 floor.
CREATE FUNCTION pg_temp.two_hot(p_a int, p_b int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[p_a] := 0.70710677::real;
  v_arr[p_b] := 0.70710677::real;
  RETURN v_arr::halfvec(768);
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user           uuid;
  v_app            uuid;
  v_creator        uuid;
  v_sample         uuid;
  v_job            uuid;
  v_needle         uuid;
  v_filler         uuid;
  v_ver_before     int;
  v_ver_after      int;
  v_done_ret       uuid;
  v_idx            int;
  v_chunk_idx      int := 0;
  v_needle_in_20   int;
  v_needle_in_50   int;
  v_rank_by_sum    int;
  v_rank_by_max    int;
BEGIN
  v_user := tests.create_auth_user('ragv3-base@test');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'RAGV3', 'ragv3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'RAGV3', 'ragv3', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Sample', 'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- ════════════════════════════════════════════════════════════════════════
  -- BLOCK A — POST-FIX TRIPWIRE: mark_done bumps version + deletes v1 chunks
  -- ════════════════════════════════════════════════════════════════════════
  -- Migration 20260528000001 (RAG v3 step 1b) folded version-bump + v1-chunk
  -- delete into mark_done. Seed the sample with BOTH a v1 zombie chunk
  -- (chunker_version=1, should be deleted) AND v2 chunks (chunker_version=2,
  -- should survive) + a claimed reprocess job, then finish it via mark_done.
  DECLARE
    v_v1_chunks_before  int;
    v_v1_chunks_after   int;
    v_v2_chunks_before  int;
    v_v2_chunks_after   int;
  BEGIN
    INSERT INTO public.sample_content_chunks
      (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
    VALUES
      (gen_random_uuid(), v_sample, v_creator, 0, 'v2 survivor one', ARRAY['topic-a'], pg_temp.unit_vec(1), 2),
      (gen_random_uuid(), v_sample, v_creator, 1, 'v2 survivor two', ARRAY['topic-a'], pg_temp.unit_vec(2), 2),
      -- v1 zombie chunk (legacy windowed; should be deleted by mark_done's cutover):
      (gen_random_uuid(), v_sample, v_creator, 2, 'v1 zombie',     ARRAY['topic-a'], pg_temp.unit_vec(3), 1);

    SELECT current_corpus_version INTO v_ver_before FROM public.creators WHERE id = v_creator;
    SELECT count(*) INTO v_v1_chunks_before
      FROM public.sample_content_chunks WHERE sample_id = v_sample AND chunker_version = 1;
    SELECT count(*) INTO v_v2_chunks_before
      FROM public.sample_content_chunks WHERE sample_id = v_sample AND chunker_version = 2;

    INSERT INTO public.corpus_reprocess_jobs (id, sample_id, target_version, status, enqueue_version, claimed_by, claimed_at)
      VALUES (gen_random_uuid(), v_sample, 2, 'processing', 1, 'ragv3-base', now())
      RETURNING id INTO v_job;
    SELECT public.corpus_reprocess_mark_done(v_job, 1) INTO v_done_ret;

    SELECT current_corpus_version INTO v_ver_after FROM public.creators WHERE id = v_creator;
    SELECT count(*) INTO v_v1_chunks_after
      FROM public.sample_content_chunks WHERE sample_id = v_sample AND chunker_version = 1;
    SELECT count(*) INTO v_v2_chunks_after
      FROM public.sample_content_chunks WHERE sample_id = v_sample AND chunker_version = 2;

    -- A0 (audit S5): mark_done returned the job-id, not silent-abandon. Without
    -- this guard, a misseeded enqueue_version would silent-abandon and A1/A3
    -- would assert against an unchanged state — passing for the wrong reason.
    RETURN NEXT isnt(
      v_done_ret, NULL::uuid,
      'A0: mark_done returned the job-id (no silent-abandon under matching enqueue_version)'
    );
    -- A1 (POST-FIX): version IS bumped by exactly one.
    RETURN NEXT is(
      v_ver_after, v_ver_before + 1,
      format('A1: mark_done bumps current_corpus_version (before=%s after=%s) — step-1b lock-in',
             v_ver_before, v_ver_after)
    );
    -- A2 (POST-FIX): v2 chunks survive (mark_done only deletes v1, not v2).
    RETURN NEXT is(
      v_v2_chunks_after, v_v2_chunks_before,
      format('A2: mark_done preserves chunker_version=2 chunks (before=%s after=%s)',
             v_v2_chunks_before, v_v2_chunks_after)
    );
    -- A3 (NEW, POST-FIX): v1 zombie chunks ARE deleted. Use format() for a
    -- readable failure diagnostic (audit M3) — `is(int, int, format(...))`.
    RETURN NEXT is(
      v_v1_chunks_after, 0,
      format('A3: mark_done deletes chunker_version=1 zombie chunks (before=%s after=%s; expected after=0)',
             v_v1_chunks_before, v_v1_chunks_after)
    );
  END;

  -- ════════════════════════════════════════════════════════════════════════
  -- BLOCK B — TRIPWIRE: 3-col UNIQUE (sample_id, chunker_version, chunk_index)
  -- ════════════════════════════════════════════════════════════════════════
  -- An exact duplicate of an existing (sample, chunker_version, chunk_index)
  -- must raise unique_violation (23505). Guards against the R2-C4 loosening.
  RETURN NEXT throws_ok(
    format($q$
      INSERT INTO public.sample_content_chunks
        (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
      VALUES (gen_random_uuid(), %L, %L, 0, 'dup of chunk 0', ARRAY['topic-a'], NULL, 2)
    $q$, v_sample, v_creator),
    '23505',
    NULL,
    'B1: duplicate (sample_id, chunker_version, chunk_index) rejected (23505) — R2-C4 dedup tripwire'
  );

  -- ════════════════════════════════════════════════════════════════════════
  -- BLOCK C — HYPOTHESIS PROOF: Wall B burial + MAX/wider-window recovery
  -- ════════════════════════════════════════════════════════════════════════
  -- Build a "book-scale" shape on one sample:
  --   * NEEDLE parent: ONE child at position 1 → cosine 1.0 (the single
  --     strongest chunk of the whole corpus — the "lumberjack story").
  --     SUM-RRF contribution = 1/(60+1) ≈ 0.0164 (one child only).
  --   * 22 FILLER parents: each has 3 children at cosine 0.7071 (two-hot at
  --     positions 1 & 200). Each filler's SUM-RRF ≈ 3 reciprocals in the
  --     rank-2..67 band ≈ ≥0.0238 > the needle's single 0.0164 — so EVERY
  --     filler out-SUMs the needle. Needle therefore ranks ~#23 by rrf_score
  --     (SUM) → BELOW a k_parent=20 window → never reaches the reranker.
  --   * But the needle has the highest vector_score (MAX child cosine = 1.0),
  --     so a MAX-based order surfaces it at #1.
  -- k_child=100 (clamp max) captures all 67 children; min_sim=0.0 keeps fillers.

  -- Needle parent + its single strong child.
  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES (gen_random_uuid(), v_sample, v_creator, 100, 'The Lumberjack Story',
          'the single strongest beat in the whole corpus', 10, ARRAY['topic-a'])
  RETURNING id INTO v_needle;
  v_chunk_idx := 100;
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
  VALUES (gen_random_uuid(), v_sample, v_creator, v_chunk_idx, 'lumberjack exact match',
          ARRAY['topic-a'], pg_temp.unit_vec(1), 2, v_needle);
  v_chunk_idx := v_chunk_idx + 1;

  -- 22 filler parents, 3 mediocre children each.
  FOR v_idx IN 1..22 LOOP
    INSERT INTO public.sample_content_narrative_units
      (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES (gen_random_uuid(), v_sample, v_creator, 200 + v_idx,
            format('Worldview unit %s', v_idx), format('paradigm chatter %s', v_idx), 10, ARRAY['topic-a'])
    RETURNING id INTO v_filler;
    INSERT INTO public.sample_content_chunks
      (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id)
    VALUES
      (gen_random_uuid(), v_sample, v_creator, v_chunk_idx,     format('mediocre %s a', v_idx), ARRAY['topic-a'], pg_temp.two_hot(1, 200), 2, v_filler),
      (gen_random_uuid(), v_sample, v_creator, v_chunk_idx + 1, format('mediocre %s b', v_idx), ARRAY['topic-a'], pg_temp.two_hot(1, 200), 2, v_filler),
      (gen_random_uuid(), v_sample, v_creator, v_chunk_idx + 2, format('mediocre %s c', v_idx), ARRAY['topic-a'], pg_temp.two_hot(1, 200), 2, v_filler);
    v_chunk_idx := v_chunk_idx + 3;
  END LOOP;

  -- C1 — Wall B reproduced: at k_parent=20 the needle is BURIED (not returned).
  SELECT count(*) INTO v_needle_in_20
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(1), ''::tsquery, 100, 20, 0.0)
   WHERE parent_unit_id = v_needle;
  RETURN NEXT is(
    v_needle_in_20, 0,
    'C1: WALL B reproduced — single-strong needle buried below the k_parent=20 SUM-RRF window (never reaches reranker)'
  );

  -- C2 — Lever 1 (wider window): at k_parent=50 the needle IS returned.
  SELECT count(*) INTO v_needle_in_50
    FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(1), ''::tsquery, 100, 50, 0.0)
   WHERE parent_unit_id = v_needle;
  RETURN NEXT is(
    v_needle_in_50, 1,
    'C2: LEVER 1 (wider k_parent=50 window, already supported, no schema) recovers the needle into candidates'
  );

  -- C3 — Lever 2 (MAX vs SUM): in the k_parent=50 candidate set, the needle is
  -- LAST-ish by rrf_score (SUM) but FIRST by vector_score (MAX child cosine).
  -- This is the whole plan in one assertion: SUM buries it, MAX surfaces it.
  WITH cand AS (
    SELECT parent_unit_id,
           row_number() OVER (ORDER BY rrf_score   DESC) AS rank_sum,
           row_number() OVER (ORDER BY vector_score DESC) AS rank_max
      FROM public.creator_knowledge_topk_v2(v_creator, pg_temp.unit_vec(1), ''::tsquery, 100, 50, 0.0)
  )
  SELECT rank_sum, rank_max INTO v_rank_by_sum, v_rank_by_max
    FROM cand WHERE parent_unit_id = v_needle;
  RETURN NEXT ok(
    v_rank_by_sum > 20 AND v_rank_by_max = 1,
    format('C3: LEVER 2 — needle rank by SUM(rrf)=%s (>20, buried) vs by MAX(vec)=%s (=1, surfaced). MAX-ranking fixes Wall B.',
           v_rank_by_sum, v_rank_by_max)
  );

END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
