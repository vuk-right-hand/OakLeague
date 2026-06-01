-- RAG v3 step 3 / migration 3 — chunks v3 enum extension + section_id +
-- partial UNIQUE indexes.
--
--  1. chunker_version=3 INSERT accepted (new enum value).
--  2. chunker_version=4 INSERT rejected (enum freeze holds at 1..3).
--  3. v1/v2 partial UNIQUE: dup (sample, chunker_version=2, chunk_index)
--     raises 23505 — back-compat with R2-C4 part 1.
--  4. v3 partial UNIQUE: dup (sample, 3, section_index, chunk_index)
--     within the SAME section raises 23505.
--  5. v3 partial UNIQUE: same chunk_index in DIFFERENT sections is
--     allowed (section-local chunk_index per C5).
--  6. Cross-version: a v2 chunk at (sample, 2, chunk_index=0) and a v3
--     chunk at (sample, 3, section, 0) coexist (no collision; partials are
--     orthogonal).
--  7. CASCADE on section delete removes chunker_version=3 chunks.
--  8. section_index column accepts NULL (v1/v2) and non-negative ints (v3).
--  9. (Audit M4) v2 partial UNIQUE FIRES on a dup `(sample, 2, chunk_index)`
--     with section_index NULL in both rows — proves the v1/v2 partial
--     doesn't lose dedup when section_index is NULL on both sides (NULL
--     semantics defense). Symmetric to test 3 with section_index pinned
--     explicit on both rows.

BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('cv3-creator@test');
  v_app       uuid;
  v_creator   uuid;
  v_sample    uuid;
  v_unit_v2   uuid;
  v_unit_v3a  uuid;
  v_unit_v3b  uuid;
  v_sec_a     uuid;
  v_sec_b     uuid;
  v_chunk_v3  uuid;
  v_dummy_vec halfvec(768);
  v_count     int;
BEGIN
  v_dummy_vec := ('[' || array_to_string(array_fill(0.01::real, ARRAY[768]), ',') || ']')::halfvec(768);

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CV3', 'cv3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CV3', 'cv3', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CV3 Sample',
            'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- Sections + units to satisfy FKs.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
  VALUES
    (v_sample, v_creator, 0, 'Sec A', 'Sec A summary', 0, 100, ARRAY['topic-a'])
  RETURNING id INTO v_sec_a;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
  VALUES
    (v_sample, v_creator, 1, 'Sec B', 'Sec B summary', 100, 200, ARRAY['topic-a'])
  RETURNING id INTO v_sec_b;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES (v_sample, v_creator, 0, 'V2 Unit', 'v2 body', 50, ARRAY['topic-a'])
  RETURNING id INTO v_unit_v2;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 1, 'V3 Unit A', 'v3 body', 50, ARRAY['topic-a'], v_sec_a)
  RETURNING id INTO v_unit_v3a;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 2, 'V3 Unit B', 'v3 body B', 50, ARRAY['topic-a'], v_sec_b)
  RETURNING id INTO v_unit_v3b;

  -- 1: chunker_version=3 accepted.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
     chunker_version, parent_unit_id, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'v3 chunk one', 10, ARRAY['topic-a'], v_dummy_vec,
     3, v_unit_v3a, v_sec_a, 0)
  RETURNING id INTO v_chunk_v3;
  RETURN NEXT ok(v_chunk_v3 IS NOT NULL, '1: chunker_version=3 INSERT accepted');

  -- 2: chunker_version=4 rejected by extended CHECK.
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
       chunker_version, parent_unit_id, section_id, section_index)
    VALUES
      (v_sample, v_creator, 99, 'v4 chunk', 10, ARRAY['topic-a'], v_dummy_vec,
       4, v_unit_v3a, v_sec_a, 0);
    RETURN NEXT fail('2: chunker_version=4 should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('2: CHECK chunker_version IN (1, 2, 3) rejects 4 (enum freeze holds)');
  END;

  -- 3: v1/v2 partial UNIQUE — dup (sample, 2, chunk_index) raises 23505.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
     chunker_version, parent_unit_id)
  VALUES
    (v_sample, v_creator, 100, 'v2 chunk', 10, ARRAY['topic-a'], v_dummy_vec, 2, v_unit_v2);
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
       chunker_version, parent_unit_id)
    VALUES
      (v_sample, v_creator, 100, 'dup v2 chunk', 10, ARRAY['topic-a'], v_dummy_vec, 2, v_unit_v2);
    RETURN NEXT fail('3: dup (sample, 2, chunk_index) should raise unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('3: v1/v2 partial UNIQUE rejects dup (R2-C4 back-compat)');
  END;

  -- 4: v3 partial UNIQUE — dup (sample, 3, section_index, chunk_index)
  --    within the SAME section raises 23505.
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
       chunker_version, parent_unit_id, section_id, section_index)
    VALUES
      (v_sample, v_creator, 0, 'dup v3 chunk in same section', 10, ARRAY['topic-a'], v_dummy_vec,
       3, v_unit_v3a, v_sec_a, 0);
    RETURN NEXT fail('4: dup v3 (sample, 3, section_index=0, chunk_index=0) should raise unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('4: v3 partial UNIQUE rejects dup within same section (R2-C4 part 2)');
  END;

  -- 5: same chunk_index across DIFFERENT sections is OK (section-local C5).
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
     chunker_version, parent_unit_id, section_id, section_index)
  VALUES
    (v_sample, v_creator, 0, 'v3 chunk 0 in section B', 10, ARRAY['topic-a'], v_dummy_vec,
     3, v_unit_v3b, v_sec_b, 1);
  RETURN NEXT pass('5: v3 chunk_index=0 in section_index=1 accepted (section-local namespace)');

  -- 6: cross-version no collision. v2 has chunk_index=100; v3 has chunk_index=100 in section A.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
     chunker_version, parent_unit_id, section_id, section_index)
  VALUES
    (v_sample, v_creator, 100, 'v3 chunk 100', 10, ARRAY['topic-a'], v_dummy_vec,
     3, v_unit_v3a, v_sec_a, 0);
  RETURN NEXT pass('6: v3 (3, sec=0, chunk=100) coexists with v2 (2, chunk=100) — partials are orthogonal');

  -- 7: CASCADE on section delete removes its v3 chunks.
  SELECT count(*) INTO v_count
    FROM public.sample_content_chunks
   WHERE sample_id = v_sample AND chunker_version = 3 AND section_id = v_sec_a;
  -- (sanity: section A should have chunks from tests 1 + 6 = at least 2)
  DELETE FROM public.sample_content_sections WHERE id = v_sec_a;
  SELECT count(*) INTO v_count
    FROM public.sample_content_chunks
   WHERE chunker_version = 3 AND section_id = v_sec_a;
  RETURN NEXT is(v_count, 0, '7: DELETE section cascades to chunker_version=3 chunks (C5 re-embed prerequisite)');

  -- 8: section_index accepts NULL (v1/v2) and non-negative int (v3).
  --    Try NULL first: insert a v1-style chunk with section_index NULL.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding, chunker_version)
  VALUES (v_sample, v_creator, 200, 'v1 chunk', 10, ARRAY['topic-a'], v_dummy_vec, 1);
  -- Now try negative (should fail CHECK).
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
       chunker_version, parent_unit_id, section_id, section_index)
    VALUES
      (v_sample, v_creator, 0, 'neg', 10, ARRAY['topic-a'], v_dummy_vec, 3, v_unit_v3b, v_sec_b, -1);
    RETURN NEXT fail('8: negative section_index should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('8: CHECK section_index IS NULL OR >= 0 enforces non-negative for v3');
  END;

  -- 9: Audit M4 — v1/v2 partial UNIQUE still fires when both rows have
  -- section_index NULL. Defense against a future bad refactor that widens
  -- the partial WHERE in a way that lets NULL-section_index v2 dups slip
  -- through. Insert a v2 chunk at (sample, 2, chunk_index=400) with NULL
  -- section_index; second INSERT with the same triple must raise 23505.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
     chunker_version, parent_unit_id)
  VALUES
    (v_sample, v_creator, 400, 'v2 chunk null sect-idx', 10, ARRAY['topic-a'],
     v_dummy_vec, 2, v_unit_v2);
  BEGIN
    INSERT INTO public.sample_content_chunks
      (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding,
       chunker_version, parent_unit_id)
    VALUES
      (v_sample, v_creator, 400, 'dup v2 null sect-idx', 10, ARRAY['topic-a'],
       v_dummy_vec, 2, v_unit_v2);
    RETURN NEXT fail('9: dup v2 with NULL section_index on both sides should raise unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('9: v1/v2 partial UNIQUE fires even when section_index NULL on both sides (NULL-semantics defense, audit M4)');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
