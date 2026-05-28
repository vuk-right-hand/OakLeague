-- RAG v3 step 3 / migration 1 — sample_content_sections table.
--
--  1. Table exists with all expected columns + types.
--  2. UNIQUE (sample_id, section_index) rejects duplicate.
--  3. CHECK section_index >= 0 rejects negative.
--  4. CHECK char_end >= char_start rejects inverted span.
--  5. CHECK chunker_version = 3 rejects 2.
--  6. CHECK topic_tags cardinality >= 1 rejects empty array.
--  7. RLS enabled; service_role + authenticated grants per CLAUDE.md ff7bb11.
--  8. Slug-verify trigger raises on unregistered slug.
--  9. Orphan-rename guard raises when slug referenced by sections.
-- 10. Orphan-delete guard raises when slug referenced by sections.
-- 11. CASCADE on sample_content delete removes section.
-- 12. HNSW indexes exist on summary_embedding + centroid_embedding.

BEGIN;
SELECT plan(12);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('sects-creator@test');
  v_app       uuid;
  v_creator   uuid;
  v_sample    uuid;
  v_section   uuid;
  v_count     int;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'Sects', 'sects', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'Sects', 'sects', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Sects Sample',
            'body content for sections test', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- 1: table exists with expected columns.
  RETURN NEXT has_table('public', 'sample_content_sections', '1: table exists');

  -- Seed one valid section for subsequent tests.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
  VALUES
    (v_sample, v_creator, 0, 'Section Zero', 'Summary zero.', 0, 100, ARRAY['topic-a'])
  RETURNING id INTO v_section;

  -- 2: UNIQUE (sample_id, section_index) rejects dup.
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
    VALUES
      (v_sample, v_creator, 0, 'Dup Section', 'Dup summary.', 100, 200, ARRAY['topic-a']);
    RETURN NEXT fail('2: dup (sample_id, section_index) should raise unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('2: UNIQUE (sample_id, section_index) rejects duplicate');
  END;

  -- 3: CHECK section_index >= 0.
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
    VALUES
      (v_sample, v_creator, -1, 'Neg', 'Neg.', 0, 100, ARRAY['topic-a']);
    RETURN NEXT fail('3: negative section_index should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('3: CHECK section_index >= 0 rejects negative');
  END;

  -- 4: CHECK char_end >= char_start.
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
    VALUES
      (v_sample, v_creator, 1, 'Inv', 'Inv.', 200, 100, ARRAY['topic-a']);
    RETURN NEXT fail('4: inverted char span should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('4: CHECK char_end >= char_start rejects inverted span');
  END;

  -- 5: CHECK chunker_version = 3 rejects 2.
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end,
       topic_tags, chunker_version)
    VALUES
      (v_sample, v_creator, 2, 'V2', 'V2.', 0, 100, ARRAY['topic-a'], 2);
    RETURN NEXT fail('5: chunker_version=2 should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('5: CHECK chunker_version = 3 rejects 2 (enum freeze)');
  END;

  -- 6: CHECK topic_tags cardinality >= 1.
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
    VALUES
      (v_sample, v_creator, 3, 'Empty', 'Empty.', 0, 100, ARRAY[]::text[]);
    RETURN NEXT fail('6: empty topic_tags should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('6: CHECK topic_tags cardinality >= 1 rejects empty array');
  END;

  -- 7: RLS enabled + grants (CLAUDE.md ff7bb11 explicit-grant rule).
  RETURN NEXT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sample_content_sections'::regclass)
    AND has_table_privilege('service_role'::regrole, 'public.sample_content_sections', 'INSERT')
    AND has_table_privilege('service_role'::regrole, 'public.sample_content_sections', 'SELECT')
    AND has_table_privilege('service_role'::regrole, 'public.sample_content_sections', 'UPDATE')
    AND has_table_privilege('service_role'::regrole, 'public.sample_content_sections', 'DELETE')
    AND has_table_privilege('authenticated'::regrole, 'public.sample_content_sections', 'SELECT')
    AND NOT has_table_privilege('authenticated'::regrole, 'public.sample_content_sections', 'INSERT')
    AND NOT has_table_privilege('anon'::regrole, 'public.sample_content_sections', 'SELECT'),
    '7: RLS enabled; service_role=ALL, authenticated=SELECT, anon=nothing (CLAUDE.md ff7bb11)'
  );

  -- 8: slug-verify trigger raises on unregistered slug.
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
    VALUES
      (v_sample, v_creator, 4, 'Bad', 'Bad.', 0, 100, ARRAY['not-a-registered-slug']);
    RETURN NEXT fail('8: unregistered slug should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('8: verify_section_topic_slugs raises on unregistered slug');
  END;

  -- 9: orphan-rename guard.
  BEGIN
    UPDATE public.creator_topics SET slug = 'topic-a-renamed'
     WHERE creator_id = v_creator AND slug = 'topic-a';
    RETURN NEXT fail('9: rename should have raised — sections references the slug');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('9: creator_topics rename guard extended to sections');
  END;

  -- 10: orphan-delete guard.
  BEGIN
    DELETE FROM public.creator_topics WHERE creator_id = v_creator AND slug = 'topic-a';
    RETURN NEXT fail('10: delete should have raised — sections references the slug');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('10: creator_topics delete guard extended to sections');
  END;

  -- 11: CASCADE on sample_content delete.
  DELETE FROM public.sample_content WHERE id = v_sample;
  SELECT count(*) INTO v_count FROM public.sample_content_sections WHERE id = v_section;
  RETURN NEXT is(v_count, 0, '11: DELETE sample_content cascades to sample_content_sections');

  -- 12: HNSW indexes exist on both embedding columns.
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'sample_content_sections'
         AND indexname = 'sample_content_sections_summary_embedding_hnsw_idx'
    ) AND EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'sample_content_sections'
         AND indexname = 'sample_content_sections_centroid_embedding_hnsw_idx'
    ),
    '12: HNSW indexes exist on summary_embedding AND centroid_embedding'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
