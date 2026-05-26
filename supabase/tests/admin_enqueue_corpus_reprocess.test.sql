-- RAG SOTA Day-6 — admin_enqueue_corpus_reprocess RPC + _unsafe variant.
--
-- Auth pattern: setup runs as postgres (bypasses RLS for table reads/writes).
-- Authenticate only around the RPC call (so _assert_caller_is_admin gets a
-- real auth.uid). Reset to postgres for post-call assertions because the
-- corpus_reprocess_jobs + admin_audit_log tables are RLS deny-all.
--
-- Coverage:
--   1. Non-admin caller → 42501 forbidden
--   2. NULL creator_id → 22023 creator_id_null
--   3. Non-existent creator_id → 42704 creator_not_found
--   4. 0 ready samples → enqueued=0, +1 audit row
--   5. 2 ready + 1 NULL-raw_text samples → enqueued=2, 2 corpus_reprocess_jobs rows
--   6. Re-call (force=false) with all rows pending → 0 enqueued + skipped_already_queued=2
--   7. Re-call (force=false) with one row done → 1 enqueued + version bump
--   8. force=true with all rows pending → 2 enqueued + version bumps
--   9. force=true with row claimed <540s → 1 enqueued, 1 skipped in-flight
--  10. Audit log row written per call
--  11. _unsafe NULL admin_user_id → 22023
--  12. _unsafe non-admin admin_user_id → 42501
--  13. Mixed force=false (1 done + 1 pending) → enqueued=1, skipped_already_queued=1
--  14. force=true with claimed_at >540s ago → 2 enqueued, 0 skipped

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
  -- ── Setup (postgres role) ───────────────────────────────────────────────
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'aecr-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'AECR Creator', 'aecrc1',
            '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'AECR Creator', 'aecrc1', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- ── 1: non-admin → 42501 ────────────────────────────────────────────────
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_enqueue_corpus_reprocess(v_creator, false);
    RETURN NEXT fail('1: non-admin caller should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('1: non-admin → 42501 forbidden');
  END;
  PERFORM tests.reset_role();

  -- ── 2: admin + NULL creator_id → 22023 ──────────────────────────────────
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

  -- ── 3: admin + non-existent creator → 42704 ────────────────────────────
  BEGIN
    PERFORM public.admin_enqueue_corpus_reprocess(gen_random_uuid(), false);
    RETURN NEXT fail('3: non-existent creator should have raised');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('3: non-existent creator → 42704 creator_not_found');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('3: non-existent creator → unexpected sqlstate %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- ── 4: 0 ready samples → enqueued=0 + audit row written ─────────────────
  SELECT count(*) INTO v_pre_audit FROM public.admin_audit_log
   WHERE target_id = v_creator AND action = 'creator_corpus_reprocess_enqueue';
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, total_ready_samples, skipped_in_flight, skipped_already_queued
    INTO v_enqueued, v_total, v_skipped, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_audit_n FROM public.admin_audit_log
   WHERE target_id = v_creator AND action = 'creator_corpus_reprocess_enqueue';
  RETURN NEXT ok(
    v_enqueued = 0 AND v_total = 0 AND v_skipped = 0 AND v_already = 0
      AND v_audit_n = v_pre_audit + 1,
    '4: 0 ready samples → enqueued=0, total=0, skipped_already_queued=0, +1 audit row'
  );

  -- ── 5: Insert 3 samples (1 raw_text=NULL) + first real enqueue ──────────
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S1', 'body 1', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample1;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S2', 'body 2', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S3', NULL, ARRAY['topic-a'], 'pending')
    RETURNING id INTO v_sample3;
  -- Clear legacy queue rows the on-INSERT trigger created (v1 routing).
  DELETE FROM public.sample_content_embedding_jobs
   WHERE sample_id IN (v_sample1, v_sample2, v_sample3);
  DELETE FROM public.corpus_reprocess_jobs
   WHERE sample_id IN (v_sample1, v_sample2, v_sample3);

  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, total_ready_samples, skipped_in_flight, skipped_already_queued
    INTO v_enqueued, v_total, v_skipped, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_job_count
    FROM public.corpus_reprocess_jobs
   WHERE sample_id IN (v_sample1, v_sample2) AND target_version = 2;
  RETURN NEXT ok(
    v_enqueued = 2 AND v_total = 2 AND v_skipped = 0 AND v_already = 0 AND v_job_count = 2,
    format('5: 2 ready samples + 1 NULL → enqueued=%s total=%s already=%s jobs=%s',
           v_enqueued, v_total, v_already, v_job_count)
  );

  -- ── 6: re-call force=false with pending rows → 0 enqueued, already=2 ────
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, skipped_already_queued INTO v_enqueued, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    v_enqueued = 0 AND v_already = 2,
    format('6: re-call (force=false) with pending → enqueued=%s already=%s (want 0/2)', v_enqueued, v_already)
  );

  -- ── 7: mark sample1 done, re-call force=false → 1 enqueued + version bump
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE sample_id = v_sample1 AND target_version = 2;
  SELECT enqueue_version INTO v_enq_v_pre
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count INTO v_enqueued
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  PERFORM tests.reset_role();
  SELECT enqueue_version INTO v_enq_v_post
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  RETURN NEXT ok(
    v_enqueued = 1 AND v_enq_v_post = v_enq_v_pre + 1,
    format('7: re-call force=false with done → enqueued=%s pre=%s post=%s', v_enqueued, v_enq_v_pre, v_enq_v_post)
  );

  -- ── 8: force=true with pending rows → 2 enqueued + version bumps ────────
  UPDATE public.corpus_reprocess_jobs
     SET status = 'pending', claimed_at = NULL, claimed_by = NULL
   WHERE sample_id IN (v_sample1, v_sample2) AND target_version = 2;
  SELECT enqueue_version INTO v_enq_v_pre
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, skipped_in_flight INTO v_enqueued, v_skipped
    FROM public.admin_enqueue_corpus_reprocess(v_creator, true);
  PERFORM tests.reset_role();
  SELECT enqueue_version INTO v_enq_v_post
    FROM public.corpus_reprocess_jobs
   WHERE sample_id = v_sample1 AND target_version = 2;
  RETURN NEXT ok(
    v_enqueued = 2 AND v_skipped = 0 AND v_enq_v_post = v_enq_v_pre + 1,
    format('8: force=true with pending → enqueued=%s skipped=%s pre=%s post=%s', v_enqueued, v_skipped, v_enq_v_pre, v_enq_v_post)
  );

  -- ── 9: force=true with row claimed <540s → 1 enqueued, 1 skipped ────────
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing', claimed_at = now(), claimed_by = 'test-worker'
   WHERE sample_id = v_sample1 AND target_version = 2;
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, skipped_in_flight INTO v_enqueued, v_skipped
    FROM public.admin_enqueue_corpus_reprocess(v_creator, true);
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    v_enqueued = 1 AND v_skipped = 1,
    format('9: force=true with row claimed <540s → enqueued=%s skipped=%s', v_enqueued, v_skipped)
  );

  -- ── 10: audit log row count after all calls (exact, not >=) ────────────
  -- Tests that succeed and write audit so far: 4, 5, 6, 7, 8, 9 = 6 rows.
  -- Tests 2/3 raise before audit insert. Exact match catches double-audits.
  SELECT count(*) INTO v_audit_n FROM public.admin_audit_log
   WHERE target_id = v_creator AND action = 'creator_corpus_reprocess_enqueue';
  RETURN NEXT ok(
    v_audit_n = 6,
    format('10: audit rows for all 6 calls present (got %s)', v_audit_n)
  );

  -- ── 11: _unsafe with NULL admin_user_id → 22023 ─────────────────────────
  BEGIN
    PERFORM public._admin_enqueue_corpus_reprocess_unsafe(NULL, v_creator, false);
    RETURN NEXT fail('11: NULL admin_user_id should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('11: _unsafe NULL admin_user_id → 22023 admin_user_id_null');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('11: NULL admin_user_id → unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 12: _unsafe with non-admin user_id → 42501 ──────────────────────────
  BEGIN
    PERFORM public._admin_enqueue_corpus_reprocess_unsafe(v_user, v_creator, false);
    RETURN NEXT fail('12: non-admin p_admin_user_id should have raised');
  EXCEPTION
    WHEN sqlstate '42501' THEN
      RETURN NEXT pass('12: _unsafe non-admin → 42501 not_an_active_admin');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('12: non-admin p_admin_user_id → unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 13: mixed force=false (1 done + 1 pending) → enqueued=1, already=1 ──
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now(), claimed_at = NULL, claimed_by = NULL
   WHERE sample_id = v_sample1 AND target_version = 2;
  UPDATE public.corpus_reprocess_jobs
     SET status = 'pending', claimed_at = NULL, claimed_by = NULL, finished_at = NULL
   WHERE sample_id = v_sample2 AND target_version = 2;
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, skipped_already_queued INTO v_enqueued, v_already
    FROM public.admin_enqueue_corpus_reprocess(v_creator, false);
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    v_enqueued = 1 AND v_already = 1,
    format('13: mixed force=false (1 done + 1 pending) → enqueued=%s already=%s', v_enqueued, v_already)
  );

  -- ── 14: force=true w/ claimed_at >540s ago → 2 enqueued, 0 skipped ──────
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing',
         claimed_at = now() - INTERVAL '600 seconds',
         claimed_by = 'crashed-worker'
   WHERE sample_id = v_sample1 AND target_version = 2;
  PERFORM tests.set_authenticated(v_admin);
  SELECT enqueued_count, skipped_in_flight INTO v_enqueued, v_skipped
    FROM public.admin_enqueue_corpus_reprocess(v_creator, true);
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    v_enqueued = 2 AND v_skipped = 0,
    format('14: force=true with claimed_at >540s ago → enqueued=%s skipped=%s', v_enqueued, v_skipped)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
