-- RAG SOTA Day-6 — admin_enqueue_corpus_reprocess RPC + _unsafe variant.
--
-- Coverage (public wrapper):
-- 1. Non-admin caller → 42501 forbidden
-- 2. Admin + NULL creator_id → 22023 creator_id_null
-- 3. Admin + non-existent creator_id → 42704 creator_not_found
-- 4. Admin, creator with 0 ready samples → enqueued=0, total=0, 1 audit row
-- 5. Admin, creator with 2 ready + 1 NULL-raw_text samples → enqueued=2,
--    total=2, 2 corpus_reprocess_jobs rows
-- 6. Re-call (force=false) with all rows pending → 0 enqueued
-- 7. Re-call (force=false) with one row done → 1 enqueued + version bump
-- 8. force=true with all rows pending → enqueues all + version bumps
-- 9. force=true with one row claimed <540s → 1 enqueued, 1 skipped in-flight
-- 10. Audit log row written for every call
--
-- Coverage (_unsafe variant — service-role path):
-- 11. NULL p_admin_user_id → 22023 admin_user_id_null
-- 12. Non-admin p_admin_user_id → 42501 not_an_active_admin
--
-- Audit-1 follow-ups:
-- 13. force=false mixed case — some done, some pending; assert
--     skipped_already_queued reflects the pending count
-- 14. force=true with claimed_at older than 540s — row IS re-enqueued
--     (the in-flight courtesy gate only protects FRESH claims; expired
--     claims must be reassignable so a crashed worker doesn't permanently
--     block re-process)

BEGIN;
SELECT plan(14);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin       uuid := tests.create_auth_user('aecr-admin@test');
  v_user        uuid := tests.create_auth_user('aecr-user@test');
  v_creator     uuid;
  v_app         uuid;
  v_sample1     uuid;
  v_sample2     uuid;
  v_sample3     uuid;
  v_enqueued    int;
  v_total       int;
  v_skipped     int;
  v_already     int;
  v_audit_n     int;
  v_job_count   int;
  v_enq_v_pre   int;
  v_enq_v_post  int;
  v_pre_audit   int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'aecr-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user, 'approved', 'AECR Creator', 'aecrc1')
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'AECR Creator', 'aecrc1', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- 1: non-admin → 42501.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_enqueue_corpus_reprocess(v_creator, false);
    RETURN NEXT fail('1: non-admin caller should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('1: non-admin → 42501 forbidden');
  END;
  PERFORM tests.reset_role();

  -- 2: admin + NULL creator_id → 22023.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_enqueue_corpus_reprocess(NULL, false);
    RETURN NEXT fail('2: NULL creator_id should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('2: NULL creator_id → 22023 creator_id_null');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('2: NULL creator_id → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 3: admin + non-existent creator → 42704.
  BEGIN
    PERFORM public.admin_enqueue_corpus_reprocess(gen_random_uuid(), false);
    RETURN NEXT fail('3: non-existent creator should have raised');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('3: non-existent creator → 42704 creator_not_found');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('3: non-existent creator → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 4: admin, creator with 0 ready samples.
  SELECT count(*) INTO v_pre_audit FROM public.admin_audit_log
   WHERE target_id = v_creator
     AND action = 'creator_corpus_reprocess_enqueue';
  SELECT enqueued_count, total_ready_samples, skipped_in_flight, skipped_already_queued
    INTO v_enqueued, v_total, v_skipped, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  SELECT count(*) INTO v_audit_n FROM public.admin_audit_log
   WHERE target_id = v_creator
     AND action = 'creator_corpus_reprocess_enqueue';
  RETURN NEXT ok(
    v_enqueued = 0 AND v_total = 0 AND v_skipped = 0 AND v_already = 0
      AND v_audit_n = v_pre_audit + 1,
    '4: 0 ready samples → enqueued=0, total=0, skipped_already_queued=0, +1 audit row'
  );

  -- 5: insert 3 samples (1 with raw_text=NULL).
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S1', 'body 1', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample1;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S2', 'body 2', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S3', NULL, ARRAY['topic-a'], 'pending')
    RETURNING id INTO v_sample3;

  -- Clear v1 legacy queue rows the trigger inserted (we're testing v2 only).
  DELETE FROM public.sample_content_embedding_jobs
   WHERE sample_id IN (v_sample1, v_sample2, v_sample3);
  -- Defensive: clear corpus_reprocess_jobs too. Trigger doesn't route v1
  -- creators here, but belt-and-suspenders.
  DELETE FROM public.corpus_reprocess_jobs
   WHERE sample_id IN (v_sample1, v_sample2, v_sample3);

  SELECT enqueued_count, total_ready_samples, skipped_in_flight, skipped_already_queued
    INTO v_enqueued, v_total, v_skipped, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  SELECT count(*) INTO v_job_count
    FROM public.corpus_reprocess_jobs
   WHERE sample_id IN (v_sample1, v_sample2)
     AND target_version = 2;
  RETURN NEXT ok(
    v_enqueued = 2 AND v_total = 2 AND v_skipped = 0 AND v_already = 0 AND v_job_count = 2,
    '5: 2 ready samples + 1 NULL → enqueued=2, total=2, skipped_already_queued=0, 2 jobs rows'
  );

  -- 6: re-call (force=false) with all rows pending → 0 enqueued,
  -- skipped_already_queued reflects them.
  SELECT enqueued_count, skipped_already_queued INTO v_enqueued, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  RETURN NEXT ok(
    v_enqueued = 0 AND v_already = 2,
    '6: re-call (force=false) with pending rows → 0 enqueued, skipped_already_queued=2'
  );

  -- 7: mark sample1 done, re-call without force.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE sample_id = v_sample1 AND target_version = 2;
  SELECT enqueue_version INTO v_enq_v_pre
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  SELECT enqueued_count INTO v_enqueued
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  SELECT enqueue_version INTO v_enq_v_post
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  RETURN NEXT ok(
    v_enqueued = 1 AND v_enq_v_post = v_enq_v_pre + 1,
    '7: re-call (force=false) with done row → 1 enqueued + version bumped'
  );

  -- 8: force=true with all rows pending → enqueues all + bumps versions.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'pending', claimed_at = NULL, claimed_by = NULL
   WHERE sample_id IN (v_sample1, v_sample2) AND target_version = 2;
  SELECT enqueue_version INTO v_enq_v_pre
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  SELECT enqueued_count, skipped_in_flight INTO v_enqueued, v_skipped
    FROM public.admin_enqueue_corpus_reprocess(v_creator, true);
  SELECT enqueue_version INTO v_enq_v_post
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  RETURN NEXT ok(
    v_enqueued = 2 AND v_skipped = 0 AND v_enq_v_post = v_enq_v_pre + 1,
    '8: force=true with pending → 2 enqueued + version bumped'
  );

  -- 9: simulate sample1 claimed within 540s, force=true should skip it.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing', claimed_at = now(), claimed_by = 'test-worker'
   WHERE sample_id = v_sample1 AND target_version = 2;
  SELECT enqueued_count, skipped_in_flight INTO v_enqueued, v_skipped
    FROM public.admin_enqueue_corpus_reprocess(v_creator, true);
  RETURN NEXT ok(
    v_enqueued = 1 AND v_skipped = 1,
    '9: force=true with one row claimed <540s → 1 enqueued, 1 skipped'
  );

  -- 10: audit log row written for every call (6 calls so far for v_creator
  -- under the action filter).
  SELECT count(*) INTO v_audit_n FROM public.admin_audit_log
   WHERE target_id = v_creator
     AND action = 'creator_corpus_reprocess_enqueue';
  RETURN NEXT ok(
    v_audit_n >= 6,
    format('10: audit rows for all 6 calls present (got %s)', v_audit_n)
  );

  PERFORM tests.reset_role();

  -- 11: _unsafe with NULL admin_user_id → 22023.
  -- Service-role context — _unsafe is granted to service_role only. pgTAP
  -- runs as superuser which can call it.
  BEGIN
    PERFORM public._admin_enqueue_corpus_reprocess_unsafe(NULL, v_creator, false);
    RETURN NEXT fail('11: NULL admin_user_id should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('11: _unsafe NULL admin_user_id → 22023 admin_user_id_null');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('11: NULL admin_user_id → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 12: _unsafe with non-admin user_id → 42501.
  BEGIN
    PERFORM public._admin_enqueue_corpus_reprocess_unsafe(v_user, v_creator, false);
    RETURN NEXT fail('12: non-admin p_admin_user_id should have raised');
  EXCEPTION
    WHEN sqlstate '42501' THEN
      RETURN NEXT pass('12: _unsafe non-admin p_admin_user_id → 42501 not_an_active_admin');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('12: non-admin p_admin_user_id → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 13: Audit-1 C3 — mixed force=false case (1 done + 1 pending).
  -- Reset sample1 to done, leave sample2 pending. Expect enqueued=1
  -- (for sample1) and skipped_already_queued=1 (for sample2).
  PERFORM tests.set_authenticated(v_admin);
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now(), claimed_at = NULL, claimed_by = NULL
   WHERE sample_id = v_sample1 AND target_version = 2;
  UPDATE public.corpus_reprocess_jobs
     SET status = 'pending', claimed_at = NULL, claimed_by = NULL, finished_at = NULL
   WHERE sample_id = v_sample2 AND target_version = 2;
  SELECT enqueued_count, skipped_already_queued INTO v_enqueued, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  RETURN NEXT ok(
    v_enqueued = 1 AND v_already = 1,
    '13: mixed force=false (1 done + 1 pending) → enqueued=1, skipped_already_queued=1'
  );

  -- 14: Audit-1 S3 — force=true with claimed_at older than 540s. Worker
  -- crashed → claim must be reassignable. Re-enqueue must SUCCEED (not be
  -- treated as in-flight).
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing',
         claimed_at = now() - INTERVAL '600 seconds',
         claimed_by = 'crashed-worker'
   WHERE sample_id = v_sample1 AND target_version = 2;
  SELECT enqueued_count, skipped_in_flight INTO v_enqueued, v_skipped
    FROM public.admin_enqueue_corpus_reprocess(v_creator, true);
  RETURN NEXT ok(
    v_enqueued = 2 AND v_skipped = 0,
    '14: force=true with claimed_at >540s ago → 2 enqueued, 0 skipped (stale claim released)'
  );
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
