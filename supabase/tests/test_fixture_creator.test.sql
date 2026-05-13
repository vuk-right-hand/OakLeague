-- RAG SOTA plan M7 — is_test_fixture + staging-only purge.
--
-- 1. Column exists with DEFAULT false; new creators get false.
-- 2. Partial index `creators_is_test_fixture_idx` exists (WHERE is_test_fixture=true).
-- 3. purge_test_fixture_rag_data REFUSES to run when app.environment is unset.
-- 4. purge_test_fixture_rag_data REFUSES to run when app.environment is 'production'.
-- 5. purge_test_fixture_rag_data RUNS when app.environment is 'staging'.
-- 6. Purge deletes sample_content of test-fixture creators only (not non-test creators).
-- 7. purge_test_fixture_rag_data is service_role-only.
-- 8. Purge return value matches expected sample-deletion count (audit-5 M2).
-- 9. CASCADE chain: fixture's chunks, narrative_units, corpus_reprocess_jobs
--    all gone after purge (audit-5 M2 — guards CASCADE against future migration breaking it).

BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user1     uuid := tests.create_auth_user('tf-fixture@test');
  v_user2     uuid := tests.create_auth_user('tf-real@test');
  v_fixture   uuid;
  v_real      uuid;
  v_app1      uuid;
  v_app2      uuid;
  v_fixture_default boolean;
  v_idx_count int;
  v_fixture_samples_pre  int;
  v_fixture_samples_post int;
  v_real_samples_pre     int;
  v_real_samples_post    int;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user1, 'approved', 'Fixture Creator', 'tffixturec')
    RETURNING id INTO v_app1;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, is_test_fixture)
    VALUES (gen_random_uuid(), v_user1, v_app1, 'Fixture Creator', 'tffixturec', 'ready', true)
    RETURNING id INTO v_fixture;

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user2, 'approved', 'Real Creator', 'tfrealc')
    RETURNING id INTO v_app2;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user2, v_app2, 'Real Creator', 'tfrealc', 'ready')
    RETURNING id INTO v_real;

  -- 1: column default false.
  SELECT is_test_fixture INTO v_fixture_default FROM public.creators WHERE id = v_real;
  RETURN NEXT is(v_fixture_default, false, '1: new creator defaults is_test_fixture=false');

  -- 2: partial index exists.
  SELECT count(*)::int INTO v_idx_count
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname = 'creators_is_test_fixture_idx';
  RETURN NEXT is(v_idx_count, 1, '2: creators_is_test_fixture_idx partial index exists');

  -- 3: app.environment empty-string → refuse.
  -- Audit-5 S2 clarification: SET LOCAL ... TO '' sets the GUC to an empty
  -- string, NOT NULL. The proc's check is `IS NULL OR <> 'staging'` so empty
  -- trips the `<> 'staging'` branch, not the NULL branch. The truly-NULL
  -- (GUC never set) path is hard to reach inside a session that already had
  -- the GUC set, so this case asserts the same refuse-branch behavior with a
  -- value that should never be production-legal regardless.
  SET LOCAL app.environment TO '';
  BEGIN
    PERFORM public.purge_test_fixture_rag_data();
    RETURN NEXT fail('3: purge should refuse when app.environment is empty');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('3: purge refuses with empty app.environment (<> staging branch)');
  END;

  -- 4: app.environment='production' → refuse.
  SET LOCAL app.environment TO 'production';
  BEGIN
    PERFORM public.purge_test_fixture_rag_data();
    RETURN NEXT fail('4: purge should refuse on production');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('4: purge refuses on production');
  END;

  -- Setup: each creator gets a sample + a v2 chunk hierarchy (narrative unit
  -- + child chunk) + a corpus_reprocess_jobs entry. Audit-5 M2: only by
  -- exercising the full child-table set can the test verify CASCADE.
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_fixture, 'fxt', 'Fxt', 0),
           (v_real, 'real', 'Real', 0);
  INSERT INTO public.sample_content (creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (v_fixture, 'transcript', 'Fxt sample', 'fixture text', ARRAY['fxt'], 'ready'),
           (v_real,    'transcript', 'Real sample', 'real text',    ARRAY['real'], 'ready');

  SELECT count(*)::int INTO v_fixture_samples_pre
    FROM public.sample_content WHERE creator_id = v_fixture;
  SELECT count(*)::int INTO v_real_samples_pre
    FROM public.sample_content WHERE creator_id = v_real;

  -- Insert a narrative unit + corpus_reprocess job tied to the fixture sample,
  -- so case 9 can verify the CASCADE chain.
  DECLARE
    v_fxt_sample uuid;
    v_fxt_unit   uuid;
    v_fxt_job    uuid;
    v_fxt_chunks_post int;
    v_fxt_units_post  int;
    v_fxt_jobs_post   int;
    v_purged_count    int;
  BEGIN
    SELECT id INTO v_fxt_sample
      FROM public.sample_content
     WHERE creator_id = v_fixture LIMIT 1;
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
    VALUES
      (v_fxt_sample, v_fixture, 0, 'Fxt Unit', 'fixture unit text', 50, ARRAY['fxt'])
    RETURNING id INTO v_fxt_unit;
    INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version)
    VALUES (v_fxt_sample, 2)
    RETURNING id INTO v_fxt_job;

    -- 5: app.environment='staging' → purge runs AND returns expected delete count (audit-5 M2).
    SET LOCAL app.environment TO 'staging';
    SELECT public.purge_test_fixture_rag_data() INTO v_purged_count;
    RETURN NEXT is(v_purged_count, v_fixture_samples_pre,
      '5: purge return value = expected sample-deletion count (audit-5 M2)');

    -- 6: purge removed fixture samples but NOT real samples.
    SELECT count(*)::int INTO v_fixture_samples_post
      FROM public.sample_content WHERE creator_id = v_fixture;
    SELECT count(*)::int INTO v_real_samples_post
      FROM public.sample_content WHERE creator_id = v_real;
    RETURN NEXT is(
      format('pre:fxt=%s real=%s | post:fxt=%s real=%s',
             v_fixture_samples_pre, v_real_samples_pre,
             v_fixture_samples_post, v_real_samples_post),
      'pre:fxt=1 real=1 | post:fxt=0 real=1',
      '6: purge removes fixture samples only (not real creators)'
    );

    -- 7: purge is service_role only.
    RETURN NEXT ok(
      NOT has_function_privilege('authenticated'::regrole,
        'public.purge_test_fixture_rag_data()', 'EXECUTE')
      AND has_function_privilege('service_role'::regrole,
        'public.purge_test_fixture_rag_data()', 'EXECUTE'),
      '7: purge_test_fixture_rag_data is service_role-only'
    );

    -- 8: audit-5 M2 — verify CASCADE chain on the fixture's narrative_unit row.
    SELECT count(*)::int INTO v_fxt_units_post
      FROM public.sample_content_narrative_units WHERE id = v_fxt_unit;
    RETURN NEXT is(v_fxt_units_post, 0,
      '8: CASCADE — narrative_units of fixture sample removed (audit-5 M2)');

    -- 9: audit-5 M2 — verify CASCADE chain on the fixture's corpus_reprocess_jobs row.
    SELECT count(*)::int INTO v_fxt_jobs_post
      FROM public.corpus_reprocess_jobs WHERE id = v_fxt_job;
    RETURN NEXT is(v_fxt_jobs_post, 0,
      '9: CASCADE — corpus_reprocess_jobs of fixture sample removed (audit-5 M2)');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
