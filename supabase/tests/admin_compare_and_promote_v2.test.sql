-- RAG SOTA Day-7 — admin_compare_v1_v2_retrieval + admin_promote_v2_chunks.
--
-- Coverage:
--   compare:
--     1. Non-admin caller → 42501
--     2. Admin + creator with mixed v1+v2 chunks → returns both buckets
--     3. Admin + creator with only v1 → returns only v1 rows
--     4. Admin + creator with only v2 → returns only v2 rows
--     5. Admin + NULL creator_id → 22023 creator_id_null
--     6. Admin + NULL query_vec → 22023 query_vec_null
--     7. k clamping: pass 9999 → clamps to 20
--     8. _unsafe rejects NULL admin_user_id
--     9. _unsafe rejects non-admin admin_user_id
--
--   promote:
--    10. Non-admin → 42501
--    11. Admin + creator with NO v2 chunks → 22023 (no_v2_chunks_yet — refuses)
--    12. Admin + creator with v2 chunks → DELETEs v1, audit row written
--    13. Admin + non-existent creator → 42704
--    14. _unsafe rejects non-admin admin_user_id
--
-- Audit-2 follow-ups:
--    15. compare creator_not_found → 42704 (M4 — symmetric with promote)
--    16. promote w/ advisory lock already held by another session → 55P03
--        within ~5s (C3 — lock_timeout)
--    17. promote with active 'processing' job for this creator → 55P03
--        'reprocess_in_progress' (audit-3 C1 state-guard)

BEGIN;
SELECT plan(17);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin       uuid := tests.create_auth_user('acpv-admin@test');
  v_user        uuid := tests.create_auth_user('acpv-user@test');
  v_creator     uuid;
  v_app         uuid;
  v_sample      uuid;
  v_parent      uuid;
  v_vec         halfvec(768);
  v_v1_count    int;
  v_v2_count    int;
  v_row_count   int;
  v_audit_n     int;
  v_remaining   int;
  v_deleted     int;
BEGIN
  -- Build a dummy halfvec(768) of zeros — cosine vs zero vector is undefined
  -- but PG returns a real number; we don't rely on the score, only on the
  -- row count and chunker_version split.
  SELECT array_fill(0::real, ARRAY[768])::halfvec(768) INTO v_vec;

  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'acpv-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
    VALUES (gen_random_uuid(), v_user, 'approved', 'ACPV Creator', 'acpvc1')
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'ACPV Creator', 'acpvc1', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Sample', 'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;

  -- 2 v1 chunks.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 0, 'v1 chunk one body text', ARRAY['topic-a'], v_vec, 1),
    (gen_random_uuid(), v_sample, v_creator, 1, 'v1 chunk two body text', ARRAY['topic-a'], v_vec, 1);

  -- 3 v2 chunks (need a parent narrative unit first).
  INSERT INTO public.sample_content_narrative_units
    (id, sample_id, creator_id, unit_index, title, text, token_count, topic_tags)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 0, 'Parent Unit', 'parent text body', 10, ARRAY['topic-a'])
    RETURNING id INTO v_parent;
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id, chunk_context)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 2, 'v2 chunk one',   ARRAY['topic-a'], v_vec, 2, v_parent, 'ctx one'),
    (gen_random_uuid(), v_sample, v_creator, 3, 'v2 chunk two',   ARRAY['topic-a'], v_vec, 2, v_parent, 'ctx two'),
    (gen_random_uuid(), v_sample, v_creator, 4, 'v2 chunk three', ARRAY['topic-a'], v_vec, 2, v_parent, 'ctx three');

  -- 1: non-admin → 42501.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_compare_v1_v2_retrieval(v_creator, v_vec, 5);
    RETURN NEXT fail('1: non-admin should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('1: compare non-admin → 42501');
  END;
  PERFORM tests.reset_role();

  -- 2: admin compare returns v1 + v2 buckets.
  PERFORM tests.set_authenticated(v_admin);
  SELECT count(*) FILTER (WHERE chunker_version = 1),
         count(*) FILTER (WHERE chunker_version = 2)
    INTO v_v1_count, v_v2_count
    FROM public.admin_compare_v1_v2_retrieval(v_creator, v_vec, 5);
  RETURN NEXT ok(
    v_v1_count = 2 AND v_v2_count = 3,
    format('2: compare returns v1=%s v2=%s (expected 2/3)', v_v1_count, v_v2_count)
  );

  -- 3: only v1 (delete the v2 chunks temporarily; restore after).
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator AND chunker_version = 2;
  SELECT count(*) FILTER (WHERE chunker_version = 1),
         count(*) FILTER (WHERE chunker_version = 2)
    INTO v_v1_count, v_v2_count
    FROM public.admin_compare_v1_v2_retrieval(v_creator, v_vec, 5);
  RETURN NEXT ok(
    v_v1_count = 2 AND v_v2_count = 0,
    '3: only v1 → returns v1 rows only'
  );
  -- Restore v2 chunks for later tests.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version, parent_unit_id, chunk_context)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 2, 'v2 chunk one',   ARRAY['topic-a'], v_vec, 2, v_parent, 'ctx one'),
    (gen_random_uuid(), v_sample, v_creator, 3, 'v2 chunk two',   ARRAY['topic-a'], v_vec, 2, v_parent, 'ctx two'),
    (gen_random_uuid(), v_sample, v_creator, 4, 'v2 chunk three', ARRAY['topic-a'], v_vec, 2, v_parent, 'ctx three');

  -- 4: only v2.
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator AND chunker_version = 1;
  SELECT count(*) FILTER (WHERE chunker_version = 1),
         count(*) FILTER (WHERE chunker_version = 2)
    INTO v_v1_count, v_v2_count
    FROM public.admin_compare_v1_v2_retrieval(v_creator, v_vec, 5);
  RETURN NEXT ok(
    v_v1_count = 0 AND v_v2_count = 3,
    '4: only v2 → returns v2 rows only'
  );
  -- Restore v1 for later tests.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 0, 'v1 chunk one body text', ARRAY['topic-a'], v_vec, 1),
    (gen_random_uuid(), v_sample, v_creator, 1, 'v1 chunk two body text', ARRAY['topic-a'], v_vec, 1);

  -- 5: NULL creator_id → 22023.
  BEGIN
    PERFORM public.admin_compare_v1_v2_retrieval(NULL, v_vec, 5);
    RETURN NEXT fail('5: NULL creator_id should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('5: NULL creator_id → 22023');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('5: NULL creator_id → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 6: NULL query_vec → 22023.
  BEGIN
    PERFORM public.admin_compare_v1_v2_retrieval(v_creator, NULL, 5);
    RETURN NEXT fail('6: NULL query_vec should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('6: NULL query_vec → 22023');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('6: NULL query_vec → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 7: k=9999 clamps to 20. We only have 2+3=5 chunks so total rows = 5
  -- and v1 rows ≤ 20, v2 rows ≤ 20. Implicit assertion: no error.
  SELECT count(*) INTO v_row_count
    FROM public.admin_compare_v1_v2_retrieval(v_creator, v_vec, 9999);
  RETURN NEXT ok(
    v_row_count = 5,
    format('7: k=9999 clamps without erroring, all rows returned (%s)', v_row_count)
  );
  PERFORM tests.reset_role();

  -- 8: _unsafe rejects NULL admin_user_id.
  BEGIN
    PERFORM public._admin_compare_v1_v2_retrieval_unsafe(NULL, v_creator, v_vec, 5);
    RETURN NEXT fail('8: _unsafe NULL admin_user_id should raise');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('8: _unsafe NULL admin_user_id → 22023');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('8: _unsafe NULL admin_user_id → %s', SQLSTATE));
  END;

  -- 9: _unsafe rejects non-admin admin_user_id.
  BEGIN
    PERFORM public._admin_compare_v1_v2_retrieval_unsafe(v_user, v_creator, v_vec, 5);
    RETURN NEXT fail('9: _unsafe non-admin should raise');
  EXCEPTION
    WHEN sqlstate '42501' THEN
      RETURN NEXT pass('9: _unsafe non-admin → 42501');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('9: _unsafe non-admin → %s', SQLSTATE));
  END;

  -- 10: promote non-admin → 42501.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_promote_v2_chunks(v_creator);
    RETURN NEXT fail('10: non-admin promote should be blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('10: promote non-admin → 42501');
  END;
  PERFORM tests.reset_role();

  -- 11: promote with NO v2 chunks → 22023 (refuse).
  PERFORM tests.set_authenticated(v_admin);
  DELETE FROM public.sample_content_chunks WHERE creator_id = v_creator AND chunker_version = 2;
  BEGIN
    PERFORM public.admin_promote_v2_chunks(v_creator);
    RETURN NEXT fail('11: promote with no v2 chunks should refuse');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('11: promote no_v2_chunks_yet → 22023');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('11: promote no_v2 → unexpected %s', SQLSTATE));
  END;

  -- 12: promote with v2 chunks → DELETEs v1, audit row written.
  -- Restore v2 chunks.
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, embedding, chunker_version, parent_unit_id, chunk_context)
  VALUES
    (gen_random_uuid(), v_sample, v_creator, 2, 'v2 chunk one',   v_vec, 2, v_parent, 'ctx one'),
    (gen_random_uuid(), v_sample, v_creator, 3, 'v2 chunk two',   v_vec, 2, v_parent, 'ctx two'),
    (gen_random_uuid(), v_sample, v_creator, 4, 'v2 chunk three', v_vec, 2, v_parent, 'ctx three');

  SELECT deleted_v1_count, remaining_v2_count INTO v_deleted, v_remaining
    FROM public.admin_promote_v2_chunks(v_creator);
  SELECT count(*) INTO v_v1_count
    FROM public.sample_content_chunks
   WHERE creator_id = v_creator AND chunker_version = 1;
  SELECT count(*) INTO v_v2_count
    FROM public.sample_content_chunks
   WHERE creator_id = v_creator AND chunker_version = 2;
  SELECT count(*) INTO v_audit_n
    FROM public.admin_audit_log
   WHERE action = 'creator_promote_v2_chunks' AND target_id = v_creator;
  RETURN NEXT ok(
    v_deleted = 2 AND v_remaining = 3 AND v_v1_count = 0 AND v_v2_count = 3 AND v_audit_n = 1,
    format('12: promote → deleted_v1=%s remaining_v2=%s actual_v1=%s actual_v2=%s audits=%s',
           v_deleted, v_remaining, v_v1_count, v_v2_count, v_audit_n)
  );

  -- 13: non-existent creator → 42704.
  BEGIN
    PERFORM public.admin_promote_v2_chunks(gen_random_uuid());
    RETURN NEXT fail('13: non-existent creator should raise');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('13: non-existent creator → 42704');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('13: non-existent → %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- 14: _unsafe promote rejects non-admin admin_user_id.
  BEGIN
    PERFORM public._admin_promote_v2_chunks_unsafe(v_user, v_creator);
    RETURN NEXT fail('14: _unsafe non-admin promote should raise');
  EXCEPTION
    WHEN sqlstate '42501' THEN
      RETURN NEXT pass('14: _unsafe promote non-admin → 42501');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('14: _unsafe promote → %s', SQLSTATE));
  END;

  -- 15: Audit-2 M4 — compare with non-existent creator → 42704.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_compare_v1_v2_retrieval(gen_random_uuid(), v_vec, 5);
    RETURN NEXT fail('15: compare non-existent creator should raise');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('15: compare non-existent creator → 42704');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('15: compare non-existent → unexpected %s', SQLSTATE));
  END;

  -- 16: Audit-2 C3 — lock_timeout. We take the advisory lock manually,
  -- then call promote and assert it raises 55P03 within ~5s (the lock_timeout
  -- set inside _admin_promote_v2_chunks_unsafe).
  --
  -- Trick: pg_advisory_xact_lock is bound to THIS transaction. The promote
  -- call runs inside the same transaction in pgTAP, so the lock would be
  -- recursive (same backend = no wait). To test lock_timeout we need
  -- a different session. pgTAP doesn't easily run multi-session. Instead,
  -- assert the SET LOCAL lock_timeout = '5s' is present in the function body.
  -- This is a textual proof rather than a behavioral one — full lock_timeout
  -- behavior is verified manually in staging.
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.proname = '_admin_promote_v2_chunks_unsafe'
         AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
         AND pg_get_functiondef(p.oid) ILIKE '%set local lock_timeout%'
    ),
    '16: _admin_promote_v2_chunks_unsafe has SET LOCAL lock_timeout (C3 guard)'
  );

  -- 17: Audit-3 C1 — state guard. Simulate an active reprocess by
  -- inserting a corpus_reprocess_jobs row in 'processing' state with a
  -- fresh claimed_at. Promote MUST refuse with 55P03 reprocess_in_progress.
  PERFORM tests.set_authenticated(v_admin);
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version, claimed_by, claimed_at)
  VALUES
    (v_sample, 2, 'processing', 1, 1, 'test-worker-c1', now())
  ON CONFLICT (sample_id, target_version) DO UPDATE
    SET status = 'processing', claimed_at = now(), claimed_by = 'test-worker-c1';
  BEGIN
    PERFORM public.admin_promote_v2_chunks(v_creator);
    RETURN NEXT fail('17: promote should refuse with active processing row');
  EXCEPTION
    WHEN sqlstate '55P03' THEN
      RETURN NEXT pass('17: promote refuses with 55P03 when status=processing for creator (audit-3 C1)');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('17: promote with active processing → %s', SQLSTATE));
  END;
  -- Clean up to leave the test deterministic if a future test follows.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'pending', claimed_at = NULL, claimed_by = NULL
   WHERE sample_id = v_sample AND target_version = 2;
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
