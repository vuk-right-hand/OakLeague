-- RAG SOTA plan — audit-6 C1 regression test.
--
-- The legacy finalize_embedding_job must DELETE only chunker_version=1 chunks
-- and leave chunker_version=2 chunks intact. Without this, a creator at
-- retrieval_version=2 editing their raw_text would silently wipe their v2
-- chunks via the legacy embed-worker pipeline.

BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('fej-creator@test');
  v_creator     uuid;
  v_app         uuid;
  v_sample      uuid;
  v_unit        uuid;
  v_v1_chunk    uuid;
  v_v2_chunk    uuid;
  v_job         uuid;
  v_done        uuid;
  v_dummy_vec   halfvec(768);
  v_v1_after    int;
  v_v2_after    int;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user, 'approved', 'FEJ Creator', 'fejcreator')
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'FEJ Creator', 'fejcreator', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'FEJ Sample',
            'sample text', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- Set up a v2 narrative unit + v2 chunk via the canonical v2 path.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (v_sample, v_creator, 0, 'Unit Zero', 'parent text', 50, ARRAY['topic-a'])
  RETURNING id INTO v_unit;

  v_dummy_vec := ('[' || array_to_string(array_fill(0.01::real, ARRAY[768]), ',') || ']')::halfvec(768);

  -- Pre-existing v1 chunk for this sample.
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, token_count, topic_tags, embedding, embedded_at)
    -- chunker_version defaults to 1
  VALUES
    (v_sample, v_creator, 0, 'legacy v1 chunk', 10, ARRAY['topic-a'], v_dummy_vec, now())
  RETURNING id INTO v_v1_chunk;

  -- v2 chunk via _insert_chunk_v2_unsafe (the canonical v2 write path).
  SELECT public._insert_chunk_v2_unsafe(
    p_parent_unit_id := v_unit,
    p_chunk_index    := 1,
    p_text           := 'v2 chunk text',
    p_chunk_context  := 'v2 context header',
    p_token_count    := 20,
    p_topic_tags     := ARRAY['topic-a'],
    p_embedding      := v_dummy_vec
  ) INTO v_v2_chunk;

  -- Simulate the legacy embed-worker: enqueue an embedding job + claim it +
  -- call finalize. Insert into the job queue directly because we're skipping
  -- the trigger path.
  INSERT INTO public.sample_content_embedding_jobs (sample_id, status, attempts, claimed_by, claimed_at)
  VALUES (v_sample, 'processing', 1, 'fej-test-host', now())
  ON CONFLICT (sample_id) DO UPDATE SET
    status = 'processing', claimed_by = 'fej-test-host', claimed_at = now()
  RETURNING id INTO v_job;

  -- Call finalize with a single new v1 chunk. This deletes existing chunks
  -- and inserts the new one. Audit-6 C1: the delete must be filtered to
  -- chunker_version=1; v_v2_chunk must survive.
  SELECT public.finalize_embedding_job(
    p_job_id          := v_job,
    p_sample_id       := v_sample,
    p_chunks          := jsonb_build_array(jsonb_build_object(
                          'chunk_index', 99,
                          'text', 'fresh v1 chunk',
                          'token_count', 12,
                          'topic_tags', jsonb_build_array('topic-a')
                        )),
    p_vectors         := ARRAY[v_dummy_vec],
    p_claimed_version := 1
  ) INTO v_done;

  -- 1: v2 chunk SURVIVES the legacy finalize (audit-6 C1).
  SELECT count(*)::int INTO v_v2_after
    FROM public.sample_content_chunks
    WHERE id = v_v2_chunk AND chunker_version = 2;
  RETURN NEXT is(v_v2_after, 1,
    '1: v2 chunk survives legacy finalize_embedding_job (audit-6 C1)');

  -- 2: v1 chunks were replaced (the old v_v1_chunk deleted, new chunk_index=99 inserted).
  SELECT count(*)::int INTO v_v1_after
    FROM public.sample_content_chunks
    WHERE sample_id = v_sample AND chunker_version = 1;
  RETURN NEXT is(v_v1_after, 1,
    '2: legacy v1 chunks replaced by finalize (only the new chunk_index=99 row remains)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
