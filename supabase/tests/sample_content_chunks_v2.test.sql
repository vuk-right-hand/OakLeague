-- RAG SOTA plan M3-M4 — sample_content_chunks v2 columns + _insert_chunk_v2_unsafe
-- + legacy creator_knowledge_topk chunker_version=1 freeze.
--
-- 1. chunker_version default = 1 for new inserts via legacy v1 path.
-- 2. CHECK rejects chunker_version=4 (post-v3 enum extension 2026-05-28
--    accepts (1, 2, 3); v3-specific behavior is covered by
--    sample_content_chunks_v3.test.sql — this test only locks the enum CEILING).
-- 3. chunk_context > 1000 chars rejected by CHECK.
-- 4. text_search GENERATED column populates from coalesce(chunk_context,'') || ' ' || text.
-- 5. _insert_chunk_v2_unsafe service_role-only grant.
-- 6. _insert_chunk_v2_unsafe parent-not-found → 42704.
-- 7. _insert_chunk_v2_unsafe derives sample_id + creator_id from parent
--    (audit-2 C1 parameter-trust closure).
-- 8. Legacy creator_knowledge_topk:
--    (a) returns zero chunker_version=2 chunks even when v2 chunks exist (audit-3 C4)
--    (b) returns at least one v1 chunk (positive control — audit-4 C2 fix)

BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('cv2-creator@test');
  v_creator     uuid;
  v_app         uuid;
  v_sample      uuid;
  v_unit        uuid;
  v_chunk_v1    uuid;
  v_chunk_v2    uuid;
  v_ts_v        tsvector;
  v_default     smallint;
  v_chunk_sid   uuid;
  v_chunk_cid   uuid;
  v_topk_n      int;
  v_dummy_vec   halfvec(768);
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CV2 Creator', 'cv2creator', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CV2 Creator', 'cv2creator', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic_a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CV2 Sample',
            'lorem ipsum dolor sit amet', ARRAY['topic_a'], 'ready')
    RETURNING id INTO v_sample;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES (v_sample, v_creator, 0, 'Unit Zero',
            'Parent unit text body here.', 100, ARRAY['topic_a'])
    RETURNING id INTO v_unit;

  -- Audit-4 C2 fix: a 768-dim ZERO vector produces undefined cosine distance
  -- (division by zero in cosine = NaN). pgvector returns NaN, which fails any
  -- numeric comparison including the `>= 0.30` floor inside creator_knowledge_topk.
  -- The result: a zero-vector query returns zero rows REGARDLESS of any other
  -- filter — and test 8's `count(...) = 0` would pass even if the
  -- chunker_version=1 filter were removed.
  --
  -- Fix: use a non-zero vector (all-0.01) so cosine is well-defined and at
  -- least one chunk has positive similarity to the query.
  v_dummy_vec := ('[' || array_to_string(array_fill(0.01::real, ARRAY[768]), ',') || ']')::halfvec(768);

  -- 1: chunker_version default=1 via legacy direct INSERT path (no parent_unit_id).
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding, embedded_at)
  VALUES
    (v_sample, v_creator, 0, 'Legacy v1 chunk one with leverage content.',
     20, ARRAY['topic_a'], v_dummy_vec, now())
  RETURNING id INTO v_chunk_v1;
  SELECT chunker_version INTO v_default
    FROM public.sample_content_chunks WHERE id = v_chunk_v1;
  RETURN NEXT is(v_default::int, 1, '1: legacy direct INSERT defaults to chunker_version=1');

  -- 2: CHECK rejects chunker_version=4 (post-v3 extension still rejects
  -- values outside {1,2,3} — see migration 20260528000012).
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags,
       embedding, embedded_at, chunker_version)
    VALUES
      (v_sample, v_creator, 99, 'should fail', 10, ARRAY['topic_a'],
       v_dummy_vec, now(), 4);
    RETURN NEXT fail('2: chunker_version=4 should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('2: CHECK rejects chunker_version=4 (enum ceiling)');
  END;

  -- 3: chunk_context > 1000 chars rejected.
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
       topic_tags, embedding, embedded_at, chunker_version, parent_unit_id)
    VALUES
      (v_sample, v_creator, 98, 'short text', repeat('x', 1001), 10,
       ARRAY['topic_a'], v_dummy_vec, now(), 2, v_unit);
    RETURN NEXT fail('3: chunk_context>1000 should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('3: CHECK rejects chunk_context>1000 chars');
  END;

  -- 4: GENERATED tsvector populates from coalesce(chunk_context,'') || ' ' || text.
  -- Use a v2 chunk via _insert_chunk_v2_unsafe to exercise the full path.
  SELECT public._insert_chunk_v2_unsafe(
    p_parent_unit_id  := v_unit,
    p_chunk_index     := 1,
    p_text            := 'leverage builds compounding wealth over time',
    p_chunk_context   := 'This excerpt discusses how leverage compounds',
    p_token_count     := 50,
    p_topic_tags      := ARRAY['topic_a'],
    p_embedding       := v_dummy_vec
  ) INTO v_chunk_v2;
  SELECT text_search INTO v_ts_v
    FROM public.sample_content_chunks WHERE id = v_chunk_v2;
  -- Tsvector should include lexemes from BOTH the context and the text.
  RETURN NEXT ok(
    v_ts_v @@ to_tsquery('english', 'leverage') AND v_ts_v @@ to_tsquery('english', 'compound'),
    '4: text_search GENERATED column merges chunk_context + text via to_tsvector'
  );

  -- 5: _insert_chunk_v2_unsafe service_role-only.
  RETURN NEXT ok(
    NOT has_function_privilege(
      'authenticated'::regrole,
      'public._insert_chunk_v2_unsafe(uuid, integer, text, text, integer, text[], halfvec, text)',
      'EXECUTE'
    ),
    '5: authenticated has no EXECUTE on _insert_chunk_v2_unsafe'
  );

  -- 6: parent-not-found → 42704.
  BEGIN
    PERFORM public._insert_chunk_v2_unsafe(
      p_parent_unit_id  := gen_random_uuid(),
      p_chunk_index     := 0,
      p_text            := 'should fail',
      p_chunk_context   := 'ctx',
      p_token_count     := 5,
      p_topic_tags      := ARRAY['topic_a'],
      p_embedding       := v_dummy_vec
    );
    RETURN NEXT fail('6: missing parent unit should have raised');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('6: missing parent unit → 42704 parent_unit_not_found');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('6: unexpected sqlstate %s', SQLSTATE));
  END;

  -- 7: derived IDs match the parent unit's sample_id + creator_id.
  SELECT sample_id, creator_id INTO v_chunk_sid, v_chunk_cid
    FROM public.sample_content_chunks WHERE id = v_chunk_v2;
  RETURN NEXT is(
    v_chunk_sid::text || '|' || v_chunk_cid::text,
    v_sample::text || '|' || v_creator::text,
    '7: _insert_chunk_v2_unsafe derived sample_id + creator_id from parent unit (audit-2 C1)'
  );

  -- 8: legacy creator_knowledge_topk returns ONLY chunker_version=1 chunks.
  -- v_chunk_v1 (v1) and v_chunk_v2 (v2) both exist for this creator.
  -- Default pgTAP role is superuser; bypasses GRANT and calls the function
  -- directly. SET ROLE inside a plpgsql function crashes the server
  -- (per the comment in creator_brain_compile_unsafe_blocked_from_roles.test.sql).
  --
  -- Audit-4 C2 fix: TWO assertions, not one.
  --   (a) zero v2 chunks returned (the freeze does what it says)
  --   (b) at least one v1 chunk IS returned (the function still works at all,
  --       so case (a) isn't passing trivially from an empty result set)

  -- (a) Negative: zero v2 chunks returned.
  SELECT count(*) INTO v_topk_n
    FROM public.creator_knowledge_topk(
      p_creator_id     := v_creator,
      p_query_vec      := v_dummy_vec,
      p_k              := 5,
      p_min_similarity := 0.00
    ) topk
    JOIN public.sample_content_chunks c ON c.id = topk.chunk_id
   WHERE c.chunker_version = 2;
  RETURN NEXT is(
    v_topk_n,
    0,
    '8a: legacy creator_knowledge_topk returns zero chunker_version=2 chunks (audit-3 C4)'
  );

  -- (b) Positive: at least one v1 chunk IS returned (so 8a isn't trivially-true).
  SELECT count(*) INTO v_topk_n
    FROM public.creator_knowledge_topk(
      p_creator_id     := v_creator,
      p_query_vec      := v_dummy_vec,
      p_k              := 5,
      p_min_similarity := 0.00
    ) topk
    JOIN public.sample_content_chunks c ON c.id = topk.chunk_id
   WHERE c.chunker_version = 1;
  RETURN NEXT ok(
    v_topk_n >= 1,
    '8b: legacy creator_knowledge_topk DOES return v1 chunks (positive control for 8a)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
