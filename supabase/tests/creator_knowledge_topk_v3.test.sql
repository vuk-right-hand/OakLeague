-- RAG v3 step 5 / migration 6 — _creator_knowledge_topk_v3 RPC.
--
--  1. Service-role + authenticated grant; anon + public denied.
--  2. Unknown p_rank_mode → RAISE (fail-loud, no silent default).
--  3. Empty p_section_ids → 0 rows (cheap short-circuit).
--  4. Happy path: a v3 chunk in a listed section surfaces with parent_score
--     populated under the default 'max_blend' mode.
--  5. Scope: chunker_version=2 chunks are NEVER returned (permanent enum
--     discipline — v2 readers and v3 readers must never see each other's
--     chunks; CLAUDE.md §"Permanent-enum discipline").
--  6. Scope: a chunk in a section NOT in p_section_ids is invisible (proves
--     the section_id = ANY filter actually gates).
--  7. Ranking — 'max' vs 'max_blend' ORDER FLIP. Two parents:
--     P_solo has the SINGLE strongest child (vec_rk=1, max_rrf=1/61).
--     P_many has 3 weaker children (vec_rk=2,3,4, max_rrf=1/62 — strictly
--     less than P_solo's). Under 'max' P_solo wins (strongest beat). Under
--     'max_blend' (lambda=0.10) the +lambda*ln(1+n_children) bonus flips the
--     order so P_many wins. This pins the load-bearing §3b behavior: the
--     parameterization is REAL, the harness can pick either mode.
--  8. Ranking — 'vec_max': bm25 tiebreaks ties on max(vec_sim). Two parents
--     at vec_sim=1.0 (identical vectors); one chunk text matches the tsquery,
--     the other doesn't → vec_max gives the matching one a +1e-4*max_bm25
--     edge → it wins.
--  9. Ranking — 'best_child' collapses matched_child_chunk_ids to a SINGLE
--     element (the parent's single best child) vs the default mode which
--     returns all candidate children. Same parent, different shape.
-- 10. Top-N PER SECTION clamp: 2 sections × 3 parents each + n_per_section=1
--     → exactly 2 rows (one parent per section), not 1 globally.
-- 11. min_sim floor: a parent whose MAX(vec_sim) is below p_min_sim AND
--     whose MAX(bm25_rank) is 0 is dropped.
-- 12. round-5 M1 — BM25-only floor: a parent with vec_sim=0 BUT a real
--     lexical match (text_search @@ tsq fires, ts_rank_cd may return 0.0)
--     MUST surface under the new `has_bm25` floor (the prior threshold
--     `MAX(bm25_rank) >= 1e-6` silently dropped these — audit C3).
-- 13. round-5 C2 (read defense) — direct INSERT spreads one parent's
--     chunks across TWO sections (bypassing the v3 RPC's
--     section_parent_mismatch check). topk_v3 MUST emit exactly one row
--     per parent (the parent_grouped JOIN to narrative_units uses
--     authoritative section_id, not the denormalized chunks.section_id).
-- 14. round-5 C1 — EXPLAIN-assert: the partial-HNSW on
--     sample_content_chunks.embedding is REACHABLE from the v3 RPC's
--     textual IS NOT NULL predicate. Pin the planner contract.

BEGIN;
SELECT plan(14);

CREATE FUNCTION pg_temp.unit_vec(p_position int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
        v_idx int := ((p_position - 1) % 768) + 1;
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[v_idx] := 1.0::real;
  RETURN v_arr::halfvec(768);
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('topk3-route@test');
  v_app       uuid;
  v_creator   uuid;
  v_sample    uuid;
  v_sec1      uuid;
  v_sec2      uuid;
  v_sec3      uuid;
  v_unit_solo uuid;
  v_unit_many uuid;
  v_unit_sec2 uuid;
  v_unit_v2   uuid;
  v_unit_p1a  uuid;
  v_unit_p1b  uuid;
  v_unit_p1c  uuid;
  v_unit_p2a  uuid;
  v_unit_p2b  uuid;
  v_unit_p2c  uuid;
  v_unit_lowx uuid;
  v_unit_lowy uuid;
  v_unit_match  uuid;
  v_unit_nomatch uuid;
  v_chunk_best   uuid;
  v_count       int;
  v_first_pid   uuid;
  v_first_score float;
  v_matched     uuid[];
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'TOPK3', 'topk3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'TOPK3', 'topk3', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'TOPK3 Sample',
            'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;
  -- Three sections to cover scope + per-section clamp.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 0, 'Sec 1', 's1', 0, 100, ARRAY['topic-a'],
     pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec1;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 1, 'Sec 2', 's2', 100, 200, ARRAY['topic-a'],
     pg_temp.unit_vec(3), pg_temp.unit_vec(4))
  RETURNING id INTO v_sec2;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 2, 'Sec 3', 's3', 200, 300, ARRAY['topic-a'],
     pg_temp.unit_vec(5), pg_temp.unit_vec(6))
  RETURNING id INTO v_sec3;

  -- 1: privileges. SECURITY HOTFIX (audit C1, mig 20260601000001): this SECURITY
  -- DEFINER fn trusts a caller-supplied creator_id, so authenticated MUST be
  -- DENIED (was a cross-tenant corpus-exfil hole). service_role ONLY.
  RETURN NEXT ok(
    NOT has_function_privilege('public',
        'public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)', 'EXECUTE')
    AND NOT has_function_privilege('anon'::regrole,
        'public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated'::regrole,
        'public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
        'public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)', 'EXECUTE'),
    '1: service_role ONLY EXECUTE; public/anon/authenticated denied (audit C1)'
  );

  -- 2: unknown rank_mode → RAISE.
  BEGIN
    PERFORM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1], pg_temp.unit_vec(1), ''::tsquery, 30, 5, 0.0, 'made_up_mode');
    RETURN NEXT fail('2: unknown p_rank_mode should RAISE');
  EXCEPTION WHEN raise_exception THEN
    RETURN NEXT pass('2: unknown p_rank_mode → RAISE (no silent default)');
  END;

  -- 3: empty p_section_ids → 0 rows.
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[]::uuid[], pg_temp.unit_vec(1), ''::tsquery, 30, 5, 0.0);
  RETURN NEXT is(v_count, 0, '3: empty p_section_ids → empty result');

  -- 4: happy path — single parent in sec1 with one chunk; query matches vec.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 100, 'Happy Unit', 'happy body', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_solo;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'happy chunk text', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(1), 'gemini-embedding-001', now(),
     v_unit_solo, 3, v_sec1, 0);
  SELECT parent_unit_id, parent_score INTO v_first_pid, v_first_score
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1], pg_temp.unit_vec(1), ''::tsquery, 30, 5, 0.0)
   ORDER BY parent_score DESC LIMIT 1;
  RETURN NEXT ok(
    v_first_pid = v_unit_solo AND v_first_score > 0,
    '4: happy path — parent surfaces with positive parent_score (default max_blend)'
  );

  -- 5: scope — chunker_version=2 chunk is invisible to v3 RPC.
  -- Insert a v2 chunk under the same parent + section with the SAME embedding.
  -- If the v3 RPC mistakenly matched chunker_version=2, count would be ≥2.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 999, 'v2 trespass', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(1), 'gemini-embedding-001', now(),
     v_unit_solo, 2, NULL, NULL);
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1], pg_temp.unit_vec(1), ''::tsquery, 30, 5, 0.0);
  RETURN NEXT is(v_count, 1, '5: chunker_version=2 chunk invisible (v3-only scope)');

  -- 6: scope — chunk in sec2 invisible when caller only passes sec1.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 200, 'Sec2 Unit', 'sec2 body', 10, ARRAY['topic-a'], v_sec2)
  RETURNING id INTO v_unit_sec2;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'sec2 chunk', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(1), 'gemini-embedding-001', now(),
     v_unit_sec2, 3, v_sec2, 1);
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1], pg_temp.unit_vec(1), ''::tsquery, 30, 5, 0.0);
  RETURN NEXT is(v_count, 1, '6: section_id = ANY filter gates — sec2 chunk invisible');

  -- 7: max vs max_blend ORDER FLIP. Reset to a clean two-parent setup in sec3.
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_narrative_units WHERE creator_id = v_creator;
  -- Parent A (solo strongest): 1 child at unit_vec(10) — global vec_rk=1.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 700, 'P_solo', 'solo body', 10, ARRAY['topic-a'], v_sec3)
  RETURNING id INTO v_unit_solo;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'solo chunk', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(10), 'gemini-embedding-001', now(),
     v_unit_solo, 3, v_sec3, 2);
  -- Parent B (many weaker): 3 children at unit_vec(11), (12), (13).
  -- Query at unit_vec(10) → A's child cosine 1.0, B's children cosine 0.0
  -- (orthogonal unit vectors). So A's vec_rk=1; B's vec_rk={2,3,4} (any order).
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 701, 'P_many', 'many body', 10, ARRAY['topic-a'], v_sec3)
  RETURNING id INTO v_unit_many;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 1, 'many a', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(11), 'gemini-embedding-001', now(),
     v_unit_many, 3, v_sec3, 2),
    (v_sample, v_creator, 2, 'many b', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(12), 'gemini-embedding-001', now(),
     v_unit_many, 3, v_sec3, 2),
    (v_sample, v_creator, 3, 'many c', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(13), 'gemini-embedding-001', now(),
     v_unit_many, 3, v_sec3, 2);
  -- Math (audit M4 — explicit so a future test reader can verify):
  --   'max' mode:
  --     P_solo's max_rrf = 1/(60+1) = 1/61 ≈ 0.01639
  --     P_many's max_rrf = 1/(60+2) = 1/62 ≈ 0.01613 (best of vec_rk 2,3,4)
  --     gap 2.6e-4 — P_solo wins
  --   'max_blend' (lambda=0.10):
  --     P_solo: 0.01639 + 0.10 * ln(1+1) = 0.01639 + 0.10*ln(2) ≈ 0.0857
  --     P_many: 0.01613 + 0.10 * ln(1+3) = 0.01613 + 0.10*ln(4) ≈ 0.1548
  --     gap 0.069 absolute (1.8× ratio) — P_many wins by a margin well
  --     above any float-precision concern.
  --   Test pins lambda=0.10 explicitly → default-value drift doesn't
  --   affect this assertion.
  SELECT parent_unit_id INTO v_first_pid
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec3], pg_temp.unit_vec(10), ''::tsquery, 30, 5, 0.0, 'max', 0.10)
   ORDER BY parent_score DESC LIMIT 1;
  DECLARE v_first_pid_blend uuid;
  BEGIN
    SELECT parent_unit_id INTO v_first_pid_blend
      FROM public._creator_knowledge_topk_v3(
        v_creator, ARRAY[v_sec3], pg_temp.unit_vec(10), ''::tsquery, 30, 5, 0.0, 'max_blend', 0.10)
     ORDER BY parent_score DESC LIMIT 1;
    RETURN NEXT is(
      v_first_pid::text || '|' || v_first_pid_blend::text,
      v_unit_solo::text || '|' || v_unit_many::text,
      '7: ''max'' picks P_solo (strongest beat); ''max_blend'' flips to P_many (lambda*ln boost)'
    );
  END;

  -- 8: 'vec_max' — bm25 tiebreaks ties on max(vec_sim).
  -- Two parents, both with one chunk at unit_vec(20) (vec_sim=1.0 to query).
  -- P_match chunk text contains 'foobarbaz'; P_nomatch's doesn't. tsq='foobarbaz'.
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_narrative_units WHERE creator_id = v_creator;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 800, 'P_match', 'm', 10, ARRAY['topic-a'], v_sec3)
  RETURNING id INTO v_unit_match;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 801, 'P_nomatch', 'n', 10, ARRAY['topic-a'], v_sec3)
  RETURNING id INTO v_unit_nomatch;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'foobarbaz is here', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(20), 'gemini-embedding-001', now(),
     v_unit_match, 3, v_sec3, 2),
    (v_sample, v_creator, 1, 'nothing relevant', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(20), 'gemini-embedding-001', now(),
     v_unit_nomatch, 3, v_sec3, 2);
  SELECT parent_unit_id INTO v_first_pid
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec3], pg_temp.unit_vec(20),
      to_tsquery('english', 'foobarbaz'), 30, 5, 0.0, 'vec_max', 0.0)
   ORDER BY parent_score DESC LIMIT 1;
  RETURN NEXT is(v_first_pid, v_unit_match,
    '8: ''vec_max'' uses bm25 as tiebreak on equal max(vec_sim)');

  -- 9: 'best_child' — matched_child_chunk_ids has exactly 1 element.
  -- Same fixture as test 7 but rerun under 'best_child' for P_many.
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_narrative_units WHERE creator_id = v_creator;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 900, 'P_best', 'b', 10, ARRAY['topic-a'], v_sec3)
  RETURNING id INTO v_unit_many;
  -- Three chunks; the unit_vec(30) one is the global vec_rk=1.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'best', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(30), 'gemini-embedding-001', now(),
     v_unit_many, 3, v_sec3, 2)
  RETURNING id INTO v_chunk_best;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 1, 'mid', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(31), 'gemini-embedding-001', now(),
     v_unit_many, 3, v_sec3, 2),
    (v_sample, v_creator, 2, 'low', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(32), 'gemini-embedding-001', now(),
     v_unit_many, 3, v_sec3, 2);
  SELECT matched_child_chunk_ids INTO v_matched
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec3], pg_temp.unit_vec(30), ''::tsquery, 30, 5, 0.0, 'best_child')
   ORDER BY parent_score DESC LIMIT 1;
  RETURN NEXT is(
    cardinality(v_matched)::text || '|' || v_matched[1]::text,
    '1|' || v_chunk_best::text,
    '9: ''best_child'' collapses matched_child_chunk_ids to [best_child_id]'
  );

  -- 10: top-N per-section clamp. 2 sections × 3 parents/section + n_per_section=1
  -- → exactly 2 rows (one per section), not 1 globally.
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_narrative_units WHERE creator_id = v_creator;
  -- Sec1: parents P1A, P1B, P1C (one chunk each at unit_vec(40)).
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1100, 'P1A', 'a', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_p1a;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1101, 'P1B', 'b', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_p1b;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1102, 'P1C', 'c', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_p1c;
  -- Sec2: P2A, P2B, P2C.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1200, 'P2A', 'a', 10, ARRAY['topic-a'], v_sec2)
  RETURNING id INTO v_unit_p2a;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1201, 'P2B', 'b', 10, ARRAY['topic-a'], v_sec2)
  RETURNING id INTO v_unit_p2b;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1202, 'P2C', 'c', 10, ARRAY['topic-a'], v_sec2)
  RETURNING id INTO v_unit_p2c;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 't', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(40), 'gemini-embedding-001', now(), v_unit_p1a, 3, v_sec1, 0),
    (v_sample, v_creator, 1, 't', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(40), 'gemini-embedding-001', now(), v_unit_p1b, 3, v_sec1, 0),
    (v_sample, v_creator, 2, 't', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(40), 'gemini-embedding-001', now(), v_unit_p1c, 3, v_sec1, 0),
    (v_sample, v_creator, 3, 't', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(40), 'gemini-embedding-001', now(), v_unit_p2a, 3, v_sec2, 1),
    (v_sample, v_creator, 4, 't', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(40), 'gemini-embedding-001', now(), v_unit_p2b, 3, v_sec2, 1),
    (v_sample, v_creator, 5, 't', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(40), 'gemini-embedding-001', now(), v_unit_p2c, 3, v_sec2, 1);
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1, v_sec2], pg_temp.unit_vec(40), ''::tsquery, 30, 1, 0.0);
  RETURN NEXT is(v_count, 2,
    '10: top-N per-section clamp (2 sections × N=1 → 2 rows, not 1 globally)');

  -- 11: min_sim floor. Setup: one parent whose chunk embedding is FAR from
  -- the query (vec_sim well below 0.5). With BM25 also empty (tsq=''),
  -- max_bm25=0 → floor drops the parent.
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_narrative_units WHERE creator_id = v_creator;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 1300, 'P_far', 'far', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_lowx;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'irrelevant words', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(50), 'gemini-embedding-001', now(),
     v_unit_lowx, 3, v_sec1, 0);
  -- Query @ unit_vec(60) — orthogonal → vec_sim=0.0; min_sim=0.5 → dropped.
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1], pg_temp.unit_vec(60), ''::tsquery, 30, 5, 0.5);
  RETURN NEXT is(v_count, 0,
    '11: min_sim floor drops parents where MAX(vec_sim) < min_sim AND no bm25 match');

  -- 12: M1 — BM25-only floor. Same setup as 11 (vec_sim=0 to a far query),
  -- but now the chunk text matches a tsquery → has_bm25=TRUE → floor MUST
  -- keep the parent even with min_sim=0.5.
  -- Reuse v_unit_lowx + its chunk from test 11 (text='irrelevant words').
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1], pg_temp.unit_vec(60),
      to_tsquery('english', 'irrelevant'), 30, 5, 0.5);
  RETURN NEXT is(v_count, 1,
    '12: BM25-only floor — vec_sim=0 + has_bm25=TRUE keeps parent (audit C3 fix)');

  -- 13: C2 (read defense) — cross-section data integrity. Direct INSERT
  -- chunks of one parent into TWO sections (bypassing the v3 RPC). The
  -- parent_grouped JOIN to narrative_units must give us ONE row using the
  -- parent's authoritative section_id (NOT the denormalized chunks.section_id).
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_narrative_units WHERE creator_id = v_creator;
  -- Parent lives in sec1 (authoritative).
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 1400, 'P_cross', 'x', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_lowy;
  -- BAD DATA: chunks denormalized as sec1 AND sec2 (impossible via RPC,
  -- possible via raw INSERT / partial backfill / future bug).
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'in sec1', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(70), 'gemini-embedding-001', now(),
     v_unit_lowy, 3, v_sec1, 0),
    (v_sample, v_creator, 1, 'in sec2 (bad)', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(70), 'gemini-embedding-001', now(),
     v_unit_lowy, 3, v_sec2, 1);
  -- Caller asks for both sections. topk_v3 must NOT return 2 rows.
  -- (Authoritative section_id = sec1 from narrative_units; the bad sec2
  -- denormalization is dropped at the JOIN.)
  SELECT count(*) INTO v_count
    FROM public._creator_knowledge_topk_v3(
      v_creator, ARRAY[v_sec1, v_sec2], pg_temp.unit_vec(70), ''::tsquery, 30, 5, 0.0);
  RETURN NEXT is(v_count, 1,
    '13: cross-section bad-data → topk emits ONE row (auth from narrative_units.section_id)');

  -- 14: round-5 C1 — chunks partial-HNSW pushdown contract.
  -- TWO-PART CONTRACT ASSERTION (see route_sections test 9 for the rationale
  -- on why EXPLAIN-assert at fixture-size is planner-unstable): assert the
  -- chunks HNSW partial index exists with the IS NOT NULL predicate AND the
  -- v3 RPC source contains `c.embedding IS NOT NULL` so the planner CAN
  -- match the partial at prod volume. Catches a future refactor that drops
  -- the predicate from either side.
  DECLARE
    v_idx_ok  boolean;
    v_rpc_src text;
    v_rpc_ok  boolean;
  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'sample_content_chunks'
         AND indexname = 'sample_content_chunks_embedding_hnsw_idx'
         AND indexdef ILIKE '%where (embedding is not null)%'
    ) INTO v_idx_ok;
    SELECT pg_get_functiondef(
      ('public._creator_knowledge_topk_v3(uuid,uuid[],halfvec,tsquery,int,int,float,text,float)')::regprocedure
    ) INTO v_rpc_src;
    v_rpc_ok := v_rpc_src ILIKE '%c.embedding IS NOT NULL%';
    RETURN NEXT ok(
      v_idx_ok AND v_rpc_ok,
      '14: chunks partial-HNSW contract — index partial WHERE + RPC textual IS NOT NULL'
    );
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
