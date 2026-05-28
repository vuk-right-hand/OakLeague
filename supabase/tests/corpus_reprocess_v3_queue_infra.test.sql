-- RAG v3 step 4c — queue infra: widened target_version, claim returns
-- target_version, mark_done_v3 stub.
--
-- 1. corpus_reprocess_jobs.target_version=3 accepted (was IN (2), now IN (2, 3)).
-- 2. corpus_reprocess_jobs.target_version=4 rejected (CHECK ceiling holds).
-- 3. claim_corpus_reprocess_job RETURNS target_version (the new column).
-- 4. claim returns target_version=2 for a v2 job, =3 for a v3 job.
-- 5. corpus_reprocess_mark_done_v3 is service-role only.
-- 6. mark_done_v3 happy path: matching version + status='processing' +
--    target_version=3 → status='done', returns p_job_id.
-- 7. mark_done_v3 silent abandon on enqueue_version mismatch → NULL,
--    status unchanged.
-- 8. mark_done_v3 silent abandon when target_version=2 (job is v2) → NULL,
--    status unchanged (defends against worker calling wrong RPC).

BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('crv3-q@test');
  v_app       uuid;
  v_creator   uuid;
  v_sample_v2 uuid;
  v_sample_v3 uuid;
  v_job_v2    uuid;
  v_job_v3    uuid;
  v_claim_tv  smallint;
  v_done_ret  uuid;
  v_status    text;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CRV3Q', 'crv3q', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CRV3Q', 'crv3q', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'V2 Sample', 'v2 body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample_v2;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'V3 Sample', 'v3 body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample_v3;

  -- 1: target_version=3 accepted.
  INSERT INTO public.corpus_reprocess_jobs (id, sample_id, target_version, status, enqueue_version)
    VALUES (gen_random_uuid(), v_sample_v3, 3, 'pending', 1)
    RETURNING id INTO v_job_v3;
  RETURN NEXT ok(v_job_v3 IS NOT NULL, '1: target_version=3 INSERT accepted (widened CHECK)');

  -- 2: target_version=4 rejected.
  BEGIN
    INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
      VALUES (v_sample_v3, 4, 'pending', 1);
    RETURN NEXT fail('2: target_version=4 should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('2: CHECK target_version IN (2, 3) rejects 4 (enum ceiling)');
  END;

  -- 3 + 4: claim returns target_version.
  -- Seed a v2 job so we have one of each.
  INSERT INTO public.corpus_reprocess_jobs (id, sample_id, target_version, status, enqueue_version)
    VALUES (gen_random_uuid(), v_sample_v2, 2, 'pending', 1)
    RETURNING id INTO v_job_v2;

  -- Claim FIFO — v_job_v3 was inserted FIRST (test 1) so it should be claimed first.
  SELECT target_version INTO v_claim_tv
    FROM public.claim_corpus_reprocess_job('test-worker-v3');
  RETURN NEXT ok(
    v_claim_tv IS NOT NULL,
    '3: claim RPC returns target_version column'
  );
  RETURN NEXT is(
    v_claim_tv::int, 3,
    '4: claim returns target_version=3 for the v3 job (FIFO order)'
  );

  -- 5: mark_done_v3 service-role only.
  RETURN NEXT ok(
    NOT has_function_privilege('anon'::regrole,
        'public.corpus_reprocess_mark_done_v3(uuid, int)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated'::regrole,
        'public.corpus_reprocess_mark_done_v3(uuid, int)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
        'public.corpus_reprocess_mark_done_v3(uuid, int)', 'EXECUTE'),
    '5: mark_done_v3 is service-role-only'
  );

  -- 6: happy path — v3 job at status='processing' (claimed in test 3), matching
  -- enqueue_version → marks done.
  SELECT public.corpus_reprocess_mark_done_v3(v_job_v3, 1) INTO v_done_ret;
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job_v3;
  RETURN NEXT is(
    coalesce(v_done_ret::text, '<null>') || '|' || v_status,
    v_job_v3::text || '|done',
    '6: mark_done_v3 happy path → returns p_job_id + flips status=done'
  );

  -- 7: silent abandon on enqueue_version mismatch.
  -- Setup: bump enqueue_version 1→2 + put back to processing.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing', enqueue_version = 2
   WHERE id = v_job_v3;
  SELECT public.corpus_reprocess_mark_done_v3(v_job_v3, 1) INTO v_done_ret;  -- claim=1, table=2
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job_v3;
  RETURN NEXT is(
    coalesce(v_done_ret::text, '<null>') || '|' || v_status,
    '<null>|processing',
    '7: mark_done_v3 enqueue_version mismatch → NULL, status unchanged'
  );

  -- 8: mark_done_v3 refuses a v2 job (target_version filter holds).
  -- Setup: claim the v2 job to set status='processing' (use a fresh worker id
  -- since the v3 job above is still in 'processing' from the failed mark).
  -- Reset v3 to done so claim picks v2 next.
  UPDATE public.corpus_reprocess_jobs SET status='done' WHERE id = v_job_v3;
  PERFORM public.claim_corpus_reprocess_job('test-worker-v2');
  SELECT public.corpus_reprocess_mark_done_v3(v_job_v2, 1) INTO v_done_ret;
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job_v2;
  RETURN NEXT is(
    coalesce(v_done_ret::text, '<null>') || '|' || v_status,
    '<null>|processing',
    '8: mark_done_v3 refuses v2 job (target_version=3 filter) → NULL, status unchanged'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
