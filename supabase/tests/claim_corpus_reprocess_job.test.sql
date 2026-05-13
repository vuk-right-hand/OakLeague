-- RAG SOTA Day-5 — claim_corpus_reprocess_job RPC.
-- Closes the Day-1+2+3 integration audit's M2 finding.
--
-- Coverage:
-- 1. Happy path: claim flips status pending→processing, returns the row's
--    id + sample_id + creator_id (derived) + enqueue_version.
-- 2. claimed_by is recorded on the row; empty/NULL becomes 'unknown'.
-- 3. claimed_by > 128 chars is truncated, not rejected.
-- 4. No pending rows → returns zero rows (RPC exits clean).
-- 5. attempts >= 5 rows are skipped.
-- 6. Two consecutive claims return DIFFERENT rows (FIFO + lock not re-claim).
-- 7. ACL: service_role only.
-- 8. enqueue_version captured AT CLAIM matches the row's current value.

BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('ccrj-user@test');
  v_other     uuid := tests.create_auth_user('ccrj-other@test');
  v_creator   uuid;
  v_app       uuid;
  v_sample1   uuid;
  v_sample2   uuid;
  v_job1      uuid;
  v_job2      uuid;
  v_status    text;
  v_claimed_by text;
  v_creator_back uuid;
  v_seen      int;
  v_enq_ret   int;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CCRJ Creator', 'ccrjcreator')
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CCRJ Creator', 'ccrjcreator', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- Two samples + queue rows. We'll claim them in created_at order.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CCRJ S1', 'one', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample1;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
    VALUES (v_sample1, 2, 'pending', 7)
    RETURNING id INTO v_job1;

  -- Tiny sleep to guarantee created_at ordering on cluster with high clock res.
  PERFORM pg_sleep(0.05);

  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CCRJ S2', 'two', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
    VALUES (v_sample2, 2, 'pending', 3)
    RETURNING id INTO v_job2;

  -- 1: Happy path — claim returns job1 (FIFO), correct fields.
  PERFORM tests.set_role('service_role');
  DECLARE
    v_returned_job uuid;
    v_returned_sample uuid;
    v_returned_creator uuid;
    v_returned_enq int;
  BEGIN
    SELECT job_id, sample_id, creator_id, enqueue_version
      INTO v_returned_job, v_returned_sample, v_returned_creator, v_returned_enq
      FROM public.claim_corpus_reprocess_job('test-worker:1');
    RETURN NEXT ok(
      v_returned_job = v_job1
        AND v_returned_sample = v_sample1
        AND v_returned_creator = v_creator
        AND v_returned_enq = 7,
      '1: claim returns FIFO row with sample_id, derived creator_id, enqueue_version'
    );
  END;

  -- 2: claimed_by recorded on the row.
  SELECT status, claimed_by INTO v_status, v_claimed_by
    FROM public.corpus_reprocess_jobs WHERE id = v_job1;
  RETURN NEXT ok(
    v_status = 'processing' AND v_claimed_by = 'test-worker:1',
    '2: claim flips status to processing and records claimed_by'
  );

  -- 3: Empty claimed_by → 'unknown'.
  DECLARE
    v_returned_job uuid;
  BEGIN
    SELECT job_id INTO v_returned_job
      FROM public.claim_corpus_reprocess_job('');
  END;
  SELECT claimed_by INTO v_claimed_by
    FROM public.corpus_reprocess_jobs WHERE id = v_job2;
  RETURN NEXT ok(v_claimed_by = 'unknown', '3: empty claimed_by falls back to ''unknown''');

  -- 4: No pending rows → zero rows returned (job2 is now processing too).
  DECLARE
    v_returned_job uuid;
  BEGIN
    SELECT job_id INTO v_returned_job
      FROM public.claim_corpus_reprocess_job('test-worker:3');
    RETURN NEXT ok(v_returned_job IS NULL, '4: no pending rows → claim returns zero rows');
  END;

  -- 5: attempts >= 5 are skipped. Reset job1 to pending, attempts=5.
  UPDATE public.corpus_reprocess_jobs
     SET status='pending', attempts=5, claimed_by=NULL, claimed_at=NULL
   WHERE id = v_job1;
  DECLARE
    v_returned_job uuid;
  BEGIN
    SELECT job_id INTO v_returned_job
      FROM public.claim_corpus_reprocess_job('test-worker:5');
    RETURN NEXT ok(v_returned_job IS NULL, '5: attempts>=5 rows are not claimed');
  END;

  -- 6: claimed_by truncated to 128 chars (not rejected).
  UPDATE public.corpus_reprocess_jobs
     SET status='pending', attempts=0, claimed_by=NULL, claimed_at=NULL
   WHERE id = v_job1;
  DECLARE
    v_long text := repeat('x', 200);
    v_returned_job uuid;
  BEGIN
    SELECT job_id INTO v_returned_job
      FROM public.claim_corpus_reprocess_job(v_long);
  END;
  SELECT claimed_by INTO v_claimed_by
    FROM public.corpus_reprocess_jobs WHERE id = v_job1;
  RETURN NEXT ok(
    char_length(v_claimed_by) = 128 AND v_claimed_by = repeat('x', 128),
    '6: claimed_by > 128 chars is truncated, not rejected'
  );

  -- 7: ACL — non-service-role cannot execute.
  PERFORM tests.set_authenticated(v_other);
  BEGIN
    PERFORM public.claim_corpus_reprocess_job('hacker');
    RETURN NEXT fail('7: authenticated caller should not have EXECUTE on claim_corpus_reprocess_job');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('7: ACL — authenticated callers cannot claim (insufficient_privilege)');
  END;
  PERFORM tests.reset_role();

  -- 8: FIFO + lock — fresh state, two consecutive claims return different rows.
  UPDATE public.corpus_reprocess_jobs SET status='pending', attempts=0, claimed_by=NULL, claimed_at=NULL;
  PERFORM tests.set_role('service_role');
  DECLARE
    v_claim1 uuid;
    v_claim2 uuid;
  BEGIN
    SELECT job_id INTO v_claim1 FROM public.claim_corpus_reprocess_job('w1');
    SELECT job_id INTO v_claim2 FROM public.claim_corpus_reprocess_job('w2');
    RETURN NEXT ok(
      v_claim1 IS NOT NULL AND v_claim2 IS NOT NULL AND v_claim1 <> v_claim2,
      '8: two consecutive claims return different rows (FIFO + no double-claim)'
    );
  END;

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
