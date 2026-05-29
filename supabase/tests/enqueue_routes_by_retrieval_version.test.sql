-- RAG SOTA Day-5 — enqueue_sample_embedding_job routes by retrieval_version.
-- Closes integration-audit C1 (stale v2 chunks after raw_text edit).
--
-- Coverage:
-- 1. v1 creator INSERT → row appears in sample_content_embedding_jobs only.
-- 2. v2 creator INSERT → row appears in corpus_reprocess_jobs only.
-- 3. v2 creator raw_text UPDATE → bumps enqueue_version on existing
--    corpus_reprocess_jobs row (no new row, no duplicate sample_id violation).
-- 4. v2 creator non-raw_text UPDATE (topic_tags) → does NOT enqueue.
-- 5. raw_text=NULL INSERT → does not enqueue either queue.
-- 6. v1 creator behavior is unchanged (regression guard).
-- 7. v3 creator INSERT → corpus_reprocess_jobs row with target_version=3
--    (RAG v3 step 7 / mig 20260528000051). The pre-mig-51 trigger RAISEd
--    feature_not_supported on v=3 — this proves the tripwire is closed.
-- 8. v3 creator raw_text UPDATE → bumps enqueue_version on the v3 job row.

BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user_v1   uuid := tests.create_auth_user('erbrv-v1@test');
  v_user_v2   uuid := tests.create_auth_user('erbrv-v2@test');
  v_user_v3   uuid := tests.create_auth_user('erbrv-v3@test');
  v_creator_v1 uuid;
  v_creator_v2 uuid;
  v_creator_v3 uuid;
  v_app       uuid;
  v_sample1   uuid;
  v_sample2   uuid;
  v_sample3   uuid;
  v_sample_v3 uuid;
  v_legacy_n  int;
  v_reprocess_n int;
  v_tv        smallint;
  v_enq_v1    int;
  v_enq_v2    int;
BEGIN
  -- v1 creator (default retrieval_version=1).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user_v1, 'approved', 'V1 Creator', 'v1creator', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user_v1, v_app, 'V1 Creator', 'v1creator', 'ready')
    RETURNING id INTO v_creator_v1;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator_v1, 'topic-a', 'Topic A', 0);

  -- v2 creator (explicit retrieval_version=2).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user_v2, 'approved', 'V2 Creator', 'v2creator', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, retrieval_version)
    VALUES (gen_random_uuid(), v_user_v2, v_app, 'V2 Creator', 'v2creator', 'ready', 2)
    RETURNING id INTO v_creator_v2;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator_v2, 'topic-a', 'Topic A', 0);

  -- 1: v1 creator INSERT → legacy queue only.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator_v1, 'transcript', 'V1 Sample', 'v1 body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample1;
  SELECT count(*) INTO v_legacy_n
    FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample1;
  SELECT count(*) INTO v_reprocess_n
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample1;
  RETURN NEXT ok(
    v_legacy_n = 1 AND v_reprocess_n = 0,
    '1: v1 creator INSERT routes to legacy queue only'
  );

  -- 2: v2 creator INSERT → corpus_reprocess_jobs only.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator_v2, 'transcript', 'V2 Sample', 'v2 body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;
  SELECT count(*) INTO v_legacy_n
    FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample2;
  SELECT count(*) INTO v_reprocess_n
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample2;
  RETURN NEXT ok(
    v_legacy_n = 0 AND v_reprocess_n = 1,
    '2: v2 creator INSERT routes to corpus_reprocess_jobs only (integration-audit C1)'
  );

  -- 3: v2 creator raw_text UPDATE bumps enqueue_version on the existing row.
  -- Capture the pre-edit enqueue_version, then edit, then verify bump.
  SELECT enqueue_version INTO v_enq_v1
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample2;
  UPDATE public.sample_content
     SET raw_text = 'v2 body EDITED'
   WHERE id = v_sample2;
  SELECT enqueue_version, count(*) OVER () INTO v_enq_v2, v_reprocess_n
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample2;
  RETURN NEXT ok(
    v_enq_v2 = v_enq_v1 + 1 AND v_reprocess_n = 1,
    '3: v2 raw_text edit bumps enqueue_version on existing corpus_reprocess_jobs row'
  );

  -- 4: v2 creator non-raw_text UPDATE (topic_tags) does NOT enqueue.
  -- First add another tag slug so the UPDATE doesn't fail the slug verify.
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator_v2, 'topic-b', 'Topic B', 1);
  SELECT enqueue_version INTO v_enq_v1
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample2;
  UPDATE public.sample_content
     SET topic_tags = ARRAY['topic-a', 'topic-b']
   WHERE id = v_sample2;
  SELECT enqueue_version INTO v_enq_v2
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample2;
  RETURN NEXT ok(
    v_enq_v2 = v_enq_v1,
    '4: v2 non-raw_text UPDATE does not bump enqueue_version'
  );

  -- 5: raw_text=NULL INSERT does not enqueue either queue.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator_v2, 'transcript', 'V2 Empty', NULL, ARRAY['topic-a'], 'pending')
    RETURNING id INTO v_sample3;
  SELECT count(*) INTO v_legacy_n
    FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample3;
  SELECT count(*) INTO v_reprocess_n
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample3;
  RETURN NEXT ok(
    v_legacy_n = 0 AND v_reprocess_n = 0,
    '5: raw_text=NULL INSERT does not enqueue either queue (preserves original short-circuit)'
  );

  -- 6: v1 creator raw_text UPDATE bumps legacy queue (regression guard for v1 path).
  SELECT enqueue_version INTO v_enq_v1
    FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample1;
  UPDATE public.sample_content
     SET raw_text = 'v1 body EDITED'
   WHERE id = v_sample1;
  SELECT enqueue_version INTO v_enq_v2
    FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample1;
  RETURN NEXT ok(
    v_enq_v2 = v_enq_v1 + 1,
    '6: v1 creator raw_text edit still bumps legacy queue (regression guard)'
  );

  -- v3 creator (explicit retrieval_version=3). Requires the widened CHECK
  -- from mig 20260528000041 (step 6a).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user_v3, 'approved', 'V3 Creator', 'v3creator', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, retrieval_version)
    VALUES (gen_random_uuid(), v_user_v3, v_app, 'V3 Creator', 'v3creator', 'ready', 3)
    RETURNING id INTO v_creator_v3;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator_v3, 'topic-a', 'Topic A', 0);

  -- 7: v3 creator INSERT → corpus_reprocess_jobs with target_version=3.
  -- Pre-mig-51 this INSERT RAISEd feature_not_supported (the M9 tripwire).
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator_v3, 'transcript', 'V3 Sample', 'v3 body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample_v3;
  SELECT count(*) INTO v_legacy_n
    FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample_v3;
  SELECT count(*), max(target_version) INTO v_reprocess_n, v_tv
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample_v3;
  RETURN NEXT ok(
    v_legacy_n = 0 AND v_reprocess_n = 1 AND v_tv = 3,
    format('7: v3 creator INSERT routes to corpus_reprocess_jobs target_version=3 (legacy=%s reprocess=%s tv=%s)',
           v_legacy_n, v_reprocess_n, v_tv)
  );

  -- 8: v3 creator raw_text UPDATE bumps enqueue_version on the v3 job row.
  SELECT enqueue_version INTO v_enq_v1
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample_v3 AND target_version = 3;
  UPDATE public.sample_content
     SET raw_text = 'v3 body EDITED'
   WHERE id = v_sample_v3;
  SELECT enqueue_version, count(*) OVER () INTO v_enq_v2, v_reprocess_n
    FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample_v3 AND target_version = 3;
  RETURN NEXT ok(
    v_enq_v2 = v_enq_v1 + 1 AND v_reprocess_n = 1,
    '8: v3 raw_text edit bumps enqueue_version on the v3 corpus_reprocess_jobs row'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
