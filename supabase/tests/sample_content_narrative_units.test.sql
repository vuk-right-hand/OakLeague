-- RAG SOTA plan M2 — sample_content_narrative_units.
--
-- 1. INSERT happy path: owning creator can be referenced; row created.
-- 2. Owning creator can SELECT (own-read policy).
-- 3. Another user cannot SELECT a creator's narrative units.
-- 4. CASCADE on sample_content delete removes narrative_units rows.
-- 5. CHECK rejects title > 200 chars.
-- 6. CHECK rejects token_count > 2048.
-- 7. UNIQUE (sample_id, unit_index) rejects duplicate unit_index.
-- 8. verify_narrative_unit_topic_slugs rejects unregistered slugs (audit-4 C4/M1).
-- 9. creator_topics slug rename blocked when narrative_units reference it (audit-4 C4).
-- 10. creator_topics slug delete blocked when narrative_units reference it (audit-4 C4).

BEGIN;
SELECT plan(10);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('nu-creator@test');
  v_other     uuid := tests.create_auth_user('nu-other@test');
  v_creator   uuid;
  v_app       uuid;
  v_sample    uuid;
  v_unit_1    uuid;
  v_visible   int;
  v_other_n   int;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user, 'approved', 'NU Creator', 'nucreator')
    RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'NU Creator', 'nucreator', 'ready')
    RETURNING id INTO v_creator;

  -- Need a registered topic on the creator before we can attach topic_tags.
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'leverage', 'Leverage', 0);

  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Test Sample',
            'sample raw text here', ARRAY['leverage'], 'ready')
    RETURNING id INTO v_sample;

  -- 1: INSERT happy path.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (v_sample, v_creator, 0, 'The Twins Story',
     'Two twins walk into a bar. One is a builder; the other a borrower. ...',
     180, ARRAY['leverage'])
  RETURNING id INTO v_unit_1;
  RETURN NEXT ok(v_unit_1 IS NOT NULL, '1: narrative_unit insert happy path');

  -- 2: owning creator SELECTs.
  PERFORM tests.set_authenticated(v_user);
  SELECT count(*) INTO v_visible
    FROM public.sample_content_narrative_units
   WHERE id = v_unit_1;
  RETURN NEXT is(v_visible, 1, '2: owning creator can SELECT own narrative_unit');
  PERFORM tests.reset_role();

  -- 3: another user cannot SELECT.
  PERFORM tests.set_authenticated(v_other);
  SELECT count(*) INTO v_other_n
    FROM public.sample_content_narrative_units
   WHERE id = v_unit_1;
  RETURN NEXT is(v_other_n, 0, '3: another user cannot SELECT this narrative_unit');
  PERFORM tests.reset_role();

  -- 4: CASCADE on sample_content delete.
  -- Audit-4 M6: be explicit that this count is measuring deletion, not RLS
  -- denial of read. Force RLS off (we're already superuser so this is
  -- belt-and-suspenders, but it documents intent and protects against future
  -- harness changes that might switch the test role).
  SET LOCAL row_security = off;
  DELETE FROM public.sample_content WHERE id = v_sample;
  SELECT count(*) INTO v_visible
    FROM public.sample_content_narrative_units
   WHERE id = v_unit_1;
  RETURN NEXT is(v_visible, 0, '4: sample_content delete cascades to narrative_units');
  SET LOCAL row_security = on;

  -- 5: re-create sample for the constraint tests.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Test Sample 2',
            'sample raw text here', ARRAY['leverage'], 'ready')
    RETURNING id INTO v_sample;

  BEGIN
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES
      (v_sample, v_creator, 0, repeat('x', 201),
       'short text', 100, ARRAY['leverage']);
    RETURN NEXT fail('5: title>200 should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('5: CHECK rejects title>200 chars');
  END;

  -- 6: token_count > 2048.
  BEGIN
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES
      (v_sample, v_creator, 0, 'ok title', 'ok text', 2049, ARRAY['leverage']);
    RETURN NEXT fail('6: token_count>2048 should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('6: CHECK rejects token_count>2048');
  END;

  -- 7: duplicate unit_index for same sample → unique_violation.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (v_sample, v_creator, 0, 'First Unit', 'first text', 100, ARRAY['leverage']);
  BEGIN
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES
      (v_sample, v_creator, 0, 'Duplicate Unit', 'duplicate text', 100, ARRAY['leverage']);
    RETURN NEXT fail('7: duplicate (sample_id, unit_index) should have raised unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('7: UNIQUE (sample_id, unit_index) enforced');
  END;

  -- 8: verify_narrative_unit_topic_slugs rejects unregistered slugs (audit-4 C4/M1).
  BEGIN
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES
      (v_sample, v_creator, 5, 'Bad Slug Unit', 'text', 100, ARRAY['nonexistent-slug']);
    RETURN NEXT fail('8: unregistered slug should have been rejected');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('8: verify_narrative_unit_topic_slugs rejects unregistered slug (audit-4 C4)');
  END;

  -- 9-10 setup: register a SECOND topic 'isolated' and reference it ONLY from
  -- a narrative_unit (NOT from sample_content). This isolates the new guard
  -- — without it, cases 9-10 could trip the sample_content branch of the
  -- guard and pass for the wrong reason.
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'isolated', 'Isolated', 1);
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (v_sample, v_creator, 9, 'Isolated Unit', 'isolated-only text', 100, ARRAY['isolated']);

  -- 9: slug RENAME blocked specifically by narrative_units reference (audit-4 C4).
  BEGIN
    UPDATE public.creator_topics
       SET slug = 'isolated-renamed'
     WHERE creator_id = v_creator AND slug = 'isolated';
    RETURN NEXT fail('9: slug rename should have been blocked by narrative_units reference');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('9: slug rename blocked by narrative_units.topic_tags reference (audit-4 C4)');
  END;

  -- 10: slug DELETE blocked specifically by narrative_units reference (audit-4 C4).
  BEGIN
    DELETE FROM public.creator_topics
     WHERE creator_id = v_creator AND slug = 'isolated';
    RETURN NEXT fail('10: slug delete should have been blocked by narrative_units reference');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('10: slug delete blocked by narrative_units.topic_tags reference (audit-4 C4)');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
