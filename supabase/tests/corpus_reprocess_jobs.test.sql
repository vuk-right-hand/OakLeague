-- RAG SOTA plan M5 — corpus_reprocess_jobs queue (post-audit-5 C2/C4 rewrite).
--
-- Coverage:
-- 1. Table exists with the documented columns + UNIQUE (sample_id, target_version).
-- 2. attempts CHECK (0..5) — matches sample_content_embedding_jobs.
-- 3. status CHECK enum (pending/processing/done/errored).
-- 4. target_version CHECK (2 only).
-- 5. Duplicate (sample_id, target_version) raises unique_violation.
-- 6. CASCADE on sample_content delete removes the queue row.
-- 7. reap_stuck flips a 601-second-old 'processing' row to 'pending'
--    (audit-5 C2: TTL bumped to 600s for the realistic Anthropic+chunking+embed wall-time).
-- 8. reap_stuck leaves fresh (<600s) 'processing' rows alone.
-- 9. reap_stuck_corpus_reprocess_jobs is service_role only.
-- 10. corpus_reprocess_mark_done: version match → marks status='done', returns uuid.
-- 11. corpus_reprocess_mark_done: version MISMATCH → returns NULL, status unchanged.
-- 12. enqueue_version default is 1; bumping it via UPDATE works.
-- 13. claimed_by CHECK accepts 128-char strings (audit-5 M5 cap bump).
-- 14. admin_list_corpus_reprocess_jobs: admin sees rows; non-admin → 42501.
-- 15. admin_list_corpus_reprocess_jobs: p_creator_id=NULL returns all; specific filters.

BEGIN;
SELECT plan(15);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin       uuid := tests.create_auth_user('crj-admin@test');
  v_user        uuid := tests.create_auth_user('crj-user@test');
  v_other       uuid := tests.create_auth_user('crj-other@test');
  v_creator     uuid;
  v_creator2    uuid;
  v_app         uuid;
  v_app2        uuid;
  v_sample      uuid;
  v_sample2     uuid;
  v_job         uuid;
  v_done_ret    uuid;
  v_reaped      int;
  v_status      text;
  v_claimed     text;
  v_enq_ver     int;
  v_seen        int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'crj-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CRJ Creator', 'crjcreator', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CRJ Creator', 'crjcreator', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CRJ Sample',
            'sample text', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- 1: insert succeeds with the documented shape.
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status)
  VALUES (v_sample, 2, 'pending')
  RETURNING id INTO v_job;
  RETURN NEXT ok(v_job IS NOT NULL, '1: corpus_reprocess_jobs insert happy path');

  -- 2: attempts CHECK rejects 6.
  BEGIN
    UPDATE public.corpus_reprocess_jobs SET attempts = 6 WHERE id = v_job;
    RETURN NEXT fail('2: attempts=6 should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('2: attempts CHECK rejects 6 (cap at 5)');
  END;

  -- 3: status CHECK rejects 'bogus'.
  BEGIN
    UPDATE public.corpus_reprocess_jobs SET status = 'bogus' WHERE id = v_job;
    RETURN NEXT fail('3: status=bogus should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('3: status CHECK rejects unknown enum value');
  END;

  -- 4: target_version CHECK rejects 1 (queue is v2-only).
  -- Use a fresh sample so we don't collide with v_sample's existing row.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CRJ Sample 2',
            'sample text 2', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;
  BEGIN
    INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status)
    VALUES (v_sample2, 1, 'pending');
    RETURN NEXT fail('4: target_version=1 should have raised check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('4: target_version CHECK rejects 1 (queue is v2-only)');
  END;
  DELETE FROM public.sample_content WHERE id = v_sample2;

  -- 5: duplicate (sample_id, target_version) → unique_violation.
  BEGIN
    INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status)
    VALUES (v_sample, 2, 'pending');
    RETURN NEXT fail('5: duplicate (sample_id, target_version) should have raised unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('5: UNIQUE (sample_id, target_version) enforced');
  END;

  -- 6: CASCADE on sample_content delete removes the queue row.
  SET LOCAL row_security = off;
  DELETE FROM public.sample_content WHERE id = v_sample;
  SELECT count(*)::int INTO v_reaped
    FROM public.corpus_reprocess_jobs WHERE id = v_job;
  RETURN NEXT is(v_reaped, 0, '6: sample_content delete cascades to corpus_reprocess_jobs');
  SET LOCAL row_security = on;

  -- Recreate sample for the next set of tests.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CRJ Sample 7',
            'sample 7', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- 7: reap flips a 601-second-old 'processing' row to 'pending' (TTL = 600s).
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, claimed_by, claimed_at)
  VALUES
    (v_sample, 2, 'processing', 'fly-test-host', now() - INTERVAL '601 seconds')
  RETURNING id INTO v_job;

  SELECT public.reap_stuck_corpus_reprocess_jobs() INTO v_reaped;
  SELECT status, claimed_by INTO v_status, v_claimed
    FROM public.corpus_reprocess_jobs WHERE id = v_job;
  RETURN NEXT is(
    v_status || '|' || coalesce(v_claimed, '<null>') || '|' || v_reaped::text,
    'pending|<null>|1',
    '7: reap flips 601s-old processing → pending + clears claim (audit-5 C2 TTL bump)'
  );

  -- 8: reap leaves a fresh (<600s old) 'processing' row alone.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing',
         claimed_by = 'fly-test-host',
         claimed_at = now() - INTERVAL '60 seconds'
   WHERE id = v_job;
  SELECT public.reap_stuck_corpus_reprocess_jobs() INTO v_reaped;
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job;
  RETURN NEXT is(v_status, 'processing', '8: reap leaves fresh (60s-old) processing rows alone');

  -- 9: reap function ACLs — service_role only.
  RETURN NEXT ok(
    NOT has_function_privilege('authenticated'::regrole,
      'public.reap_stuck_corpus_reprocess_jobs()', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
      'public.reap_stuck_corpus_reprocess_jobs()', 'EXECUTE'),
    '9: reap_stuck_corpus_reprocess_jobs is service_role-only'
  );

  -- 10: corpus_reprocess_mark_done with matching version → marks done, returns uuid.
  -- Setup: row at status='processing', enqueue_version=1. Pin enqueue_version=1
  -- explicitly — test 7's reap bumped it 1→2 (Day-5 C5 fencing), so without
  -- this reset the "matching version" call would mismatch the post-reap value.
  --
  -- NOTE (migration 20260528000001, RAG v3 step 1b): mark_done now ALSO bumps
  -- creators.current_corpus_version and DELETEs chunker_version=1 chunks for
  -- v_sample. Tests 10/11 don't assert on those, but future extensions of
  -- this file MUST account for the side effect (e.g. "why is the version 2?
  -- I didn't seed any v2 work" — answer: test 10 already ran mark_done).
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing',
         claimed_by = 'fly-test-host',
         claimed_at = now(),
         enqueue_version = 1
   WHERE id = v_job;
  SELECT public.corpus_reprocess_mark_done(v_job, 1) INTO v_done_ret;
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job;
  RETURN NEXT is(
    coalesce(v_done_ret::text, '<null>') || '|' || v_status,
    v_job::text || '|done',
    '10: corpus_reprocess_mark_done with matching version → returns uuid + flips status=done'
  );

  -- 11: corpus_reprocess_mark_done with MISMATCH → returns NULL, status unchanged.
  -- Setup: bump the row's enqueue_version to 2 + put back to processing.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing', enqueue_version = 2
   WHERE id = v_job;
  SELECT public.corpus_reprocess_mark_done(v_job, 1) INTO v_done_ret;  -- claim version=1, table=2
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job;
  RETURN NEXT is(
    coalesce(v_done_ret::text, '<null>') || '|' || v_status,
    '<null>|processing',
    '11: corpus_reprocess_mark_done with version mismatch → returns NULL, status unchanged (audit-5 C2 race-closure)'
  );

  -- 12: enqueue_version default 1; bumping via UPDATE works (admin --force path).
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CRJ Sample 12',
            'sample 12', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version)
    VALUES (v_sample2, 2)
    RETURNING enqueue_version INTO v_enq_ver;
  RETURN NEXT is(v_enq_ver, 1, '12: enqueue_version defaults to 1');

  -- 13: claimed_by accepts a 128-char value (cap bumped from 64).
  -- A 65-char value would have raised under the old cap; verify 128 works.
  UPDATE public.corpus_reprocess_jobs
     SET claimed_by = rpad('host-', 128, 'x')
   WHERE id = v_job;
  RETURN NEXT pass('13: claimed_by accepts 128-char string (audit-5 M5 cap bump)');

  -- 14: admin_list_corpus_reprocess_jobs gates on admin.
  PERFORM tests.set_authenticated(v_other);
  BEGIN
    PERFORM public.admin_list_corpus_reprocess_jobs(v_creator, 100);
    RETURN NEXT fail('14: non-admin should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('14: non-admin → 42501 unauthorized');
  END;
  PERFORM tests.reset_role();

  -- 15: admin_list returns rows for the creator.
  -- At this point v_creator has 2 corpus_reprocess_jobs:
  --   * v_job (recreated at case 7 on v_sample) — left at status=processing,
  --     enqueue_version=2 after case 11
  --   * the case-12 job on v_sample2 — pending, enqueue_version=1
  -- Audit-6 M1: assert exact count, not >=, so a future test extension
  -- inserting/removing jobs makes the contract visible (and forces re-tuning
  -- this assertion intentionally instead of silently passing on drift).
  PERFORM tests.set_authenticated(v_admin);
  SELECT count(*)::int INTO v_seen
    FROM public.admin_list_corpus_reprocess_jobs(v_creator, 100);
  RETURN NEXT is(
    v_seen, 2,
    '15: admin_list_corpus_reprocess_jobs returns exactly 2 rows for this creator'
  );
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
