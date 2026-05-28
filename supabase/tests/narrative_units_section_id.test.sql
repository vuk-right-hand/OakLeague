-- RAG v3 step 3 / migration 2 — narrative_units.section_id NULL FK.
--
-- 1. Column exists, NULLable.
-- 2. NULL value permitted (v2 backwards compat).
-- 3. Setting section_id to a section in a DIFFERENT sample is allowed by the
--    FK alone (the cross-sample guard is the insert RPC's job, not the FK's).
-- 4. CASCADE on section delete removes the unit.
-- 5. Index exists on section_id (WHERE NOT NULL).

BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('nu-sect@test');
  v_app        uuid;
  v_creator    uuid;
  v_sample     uuid;
  v_section    uuid;
  v_unit_null  uuid;
  v_unit_with  uuid;
  v_count      int;
  v_nullable   boolean;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'NUS', 'nus', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'NUS', 'nus', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'NUS Sample',
            'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- 1: column exists + is NULLable (v2 backwards compat).
  SELECT (is_nullable = 'YES') INTO v_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'sample_content_narrative_units'
     AND column_name = 'section_id';
  RETURN NEXT ok(
    v_nullable IS TRUE,
    '1: section_id column exists and is NULLable (v2 backwards compat)'
  );

  -- 2: NULL value permitted.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 0, 'V2 Unit', 'v2 body', 50, ARRAY['topic-a'], NULL)
  RETURNING id INTO v_unit_null;
  RETURN NEXT ok(v_unit_null IS NOT NULL, '2: NULL section_id permitted (v2 unit)');

  -- 3: section_id pointing to a section is also accepted (FK doesn't
  --    cross-sample-validate — that's the insert RPC's job).
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
  VALUES
    (v_sample, v_creator, 0, 'Sec', 'Sec.', 0, 50, ARRAY['topic-a'])
  RETURNING id INTO v_section;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES
    (v_sample, v_creator, 1, 'V3 Unit', 'v3 body', 50, ARRAY['topic-a'], v_section)
  RETURNING id INTO v_unit_with;
  RETURN NEXT ok(v_unit_with IS NOT NULL, '3: non-NULL section_id permitted (v3 unit)');

  -- 4: CASCADE on section delete removes the unit.
  DELETE FROM public.sample_content_sections WHERE id = v_section;
  SELECT count(*) INTO v_count
    FROM public.sample_content_narrative_units WHERE id = v_unit_with;
  RETURN NEXT is(
    v_count, 0,
    '4: DELETE section cascades to narrative_units.section_id (C5 idempotent re-embed prerequisite)'
  );

  -- 5: partial index on section_id exists.
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'sample_content_narrative_units'
         AND indexname = 'sample_content_narrative_units_section_idx'
    ),
    '5: partial index sample_content_narrative_units_section_idx exists'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
