-- DEEP_BRAIN_SWITCH_PLAN — creator-scoped Deep Brain enable/activate RPCs
-- (mig 20260608000001). Creator turns on v3 retrieval from their OWN dashboard.
--
--  1. Grants: enable/activate EXECUTE for authenticated, denied anon/public;
--     the shared core _set_retrieval_version_v3_unsafe is NOT authenticated-
--     callable (only the SECDEF wrappers reach it).
--  2. enable: no jwt → not_authenticated (28000).
--  3. enable: authenticated non-creator → not_a_creator (42501).
--  4. enable: creator with zero text samples → no_ready_samples (P0001).
--  5. enable: creator brain_status='errored' → brain_errored (P0001).
--  6. enable happy: 2 text samples, no jobs → 2 pending v3 jobs enqueued.
--  7. enable writes a creator_audit_log row with the creator's (non-admin) uid
--     — proves the C1 FK fix (admin_audit_log would 23503-violate here).
--  8. enable idempotent (plan C4): re-enable after jobs go 'done' → 0 enqueued,
--     done jobs untouched (never re-embeds a built sample).
--  9. enable resurrects an 'errored' job → back to 'pending'.
-- 10. enable ownership isolation: caller's enable never touches another
--     creator's samples (no creator_id param → IDOR-proof).
-- 11. activate: build incomplete → creator_v3_not_ready (check_violation).
-- 12. activate happy: fully v3-wired → retrieval_version=3 + audit row.
-- 13. activate idempotent (plan M1): second activate → already, no new audit row.
-- 14. enable when already on v3 → already_on, no new jobs.

BEGIN;
SELECT plan(17);

-- halfvec helper (same pattern as creator_v3_ready / v3 route tests).
CREATE FUNCTION pg_temp.unit_vec(p_position int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
        v_idx int := ((p_position - 1) % 768) + 1;
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[v_idx] := 1.0::real;
  RETURN v_arr::halfvec(768);
END;
$$;

-- Fully wire a creator so creator_v3_ready(creator)=TRUE (mirrors the admin
-- v3-gate test fixture): ready text sample + done v3 job + section w/ embeddings
-- + a v3 child chunk via the production insert RPC.
CREATE FUNCTION pg_temp.wire_v3(p_creator uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_sample uuid; v_sec uuid; v_unit uuid;
BEGIN
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), p_creator, 'transcript', 'OK', 'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
    VALUES (v_sample, 3, 'done', 1);
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES (v_sample, p_creator, 0, 'S1', 's', 0, 100, ARRAY['topic-a'],
          pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, p_creator, 0, 'U1', 'u', 10, ARRAY['topic-a'], v_sec)
  RETURNING id INTO v_unit;
  PERFORM public._insert_chunk_v3_unsafe(
    v_unit, v_sec, 0, 'c', NULL, 10, ARRAY['topic-a'], pg_temp.unit_vec(1));
END;
$$;

CREATE FUNCTION pg_temp.mk_creator(p_email text, p_handle text)
RETURNS TABLE(user_id uuid, creator_id uuid)
LANGUAGE plpgsql AS $$
DECLARE v_user uuid; v_app uuid; v_creator uuid;
BEGIN
  v_user := tests.create_auth_user(p_email);
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', p_handle, p_handle, '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
    VALUES (gen_random_uuid(), v_user, v_app, p_handle, p_handle, 'ready', 'vector')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  RETURN QUERY SELECT v_user, v_creator;
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid;
  v_creator     uuid;
  v_stranger    uuid := tests.create_auth_user('dbstranger@test');
  v_user_b      uuid;
  v_creator_b   uuid;
  v_user_c      uuid;
  v_creator_c   uuid;
  v_s1          uuid;
  v_s2          uuid;
  v_res         jsonb;
  v_pending     int;
  v_done        int;
  v_audit_pre   int;
  v_audit_post  int;
  v_rv          smallint;
BEGIN
  -- 1: grants.
  RETURN NEXT ok(
        has_function_privilege('authenticated'::regrole, 'public.creator_enable_deep_brain()',   'EXECUTE')
    AND has_function_privilege('authenticated'::regrole, 'public.creator_activate_deep_brain()', 'EXECUTE')
    AND NOT has_function_privilege('anon'::regrole,   'public.creator_enable_deep_brain()',   'EXECUTE')
    AND NOT has_function_privilege('public',          'public.creator_enable_deep_brain()',   'EXECUTE')
    AND NOT has_function_privilege('anon'::regrole,   'public.creator_activate_deep_brain()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated'::regrole,
            'public._set_retrieval_version_v3_unsafe(uuid)', 'EXECUTE'),
    '1: enable/activate granted to authenticated only; core not authenticated-callable'
  );

  -- 2: no jwt → not_authenticated.
  RETURN NEXT throws_ok(
    'SELECT public.creator_enable_deep_brain()', '28000', NULL,
    '2: enable with no auth → not_authenticated (28000)'
  );

  -- 3: authenticated non-creator → not_a_creator.
  PERFORM tests.set_authenticated(v_stranger);
  RETURN NEXT throws_ok(
    'SELECT public.creator_enable_deep_brain()', '42501', NULL,
    '3: enable as a non-creator → not_a_creator (42501)'
  );
  PERFORM tests.reset_role();

  -- Build creator A.
  SELECT c.user_id, c.creator_id INTO v_user, v_creator FROM pg_temp.mk_creator('dbA@test','dba') c;

  -- 4: no text samples → no_ready_samples.
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT throws_ok(
    'SELECT public.creator_enable_deep_brain()', 'P0001', 'no_ready_samples',
    '4: enable with zero text samples → no_ready_samples'
  );
  PERFORM tests.reset_role();

  -- 5: brain errored → brain_errored. (Add a sample so it's not no_ready_samples.)
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S1', 'txt', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_s1;
  UPDATE public.creators SET brain_status = 'errored' WHERE id = v_creator;
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT throws_ok(
    'SELECT public.creator_enable_deep_brain()', 'P0001', 'brain_errored',
    '5: enable with brain_status=errored → brain_errored'
  );
  PERFORM tests.reset_role();
  UPDATE public.creators SET brain_status = 'ready' WHERE id = v_creator;

  -- 6: happy — add a 2nd sample, enable → 2 pending v3 jobs.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S2', 'txt2', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_s2;
  PERFORM tests.set_authenticated(v_user);
  SELECT public.creator_enable_deep_brain() INTO v_res;
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_pending
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE s.creator_id = v_creator AND j.target_version = 3 AND j.status = 'pending';
  RETURN NEXT is(v_pending, 2, '6: enable enqueues a pending v3 job per text sample (2)');

  -- 7: creator_audit_log row written with the creator's (non-admin) uid (C1).
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.creator_audit_log
      WHERE user_id = v_user AND action = 'creator_deep_brain_enable'),
    1, '7: enable audits to creator_audit_log with a non-admin uid (C1 FK fix)'
  );

  -- 8: idempotent (C4) — mark both jobs done, re-enable → 0 new, done untouched.
  UPDATE public.corpus_reprocess_jobs j
     SET status = 'done'
    FROM public.sample_content s
   WHERE s.id = j.sample_id AND s.creator_id = v_creator AND j.target_version = 3;
  PERFORM tests.set_authenticated(v_user);
  SELECT public.creator_enable_deep_brain() INTO v_res;
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_done
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE s.creator_id = v_creator AND j.target_version = 3 AND j.status = 'done';
  RETURN NEXT ok(
    (v_res->>'enqueued') = '0' AND v_done = 2,
    format('8: re-enable does NOT re-embed done samples (enqueued=%s, done=%s want 0/2)',
           v_res->>'enqueued', v_done)
  );

  -- 9: resurrect an errored job → pending.
  UPDATE public.corpus_reprocess_jobs j
     SET status = 'errored'
    FROM public.sample_content s
   WHERE s.id = j.sample_id AND s.creator_id = v_creator
     AND j.target_version = 3 AND s.id = v_s1;
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.creator_enable_deep_brain();
  PERFORM tests.reset_role();
  RETURN NEXT is(
    (SELECT status FROM public.corpus_reprocess_jobs WHERE sample_id = v_s1 AND target_version = 3),
    'pending', '9: enable resurrects an errored v3 job → pending'
  );

  -- 10: ownership isolation — creator B's sample untouched by A's enable.
  SELECT c.user_id, c.creator_id INTO v_user_b, v_creator_b FROM pg_temp.mk_creator('dbB@test','dbb') c;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator_b, 'transcript', 'B', 'btxt', ARRAY['topic-a'], 'ready');
  PERFORM tests.set_authenticated(v_user);          -- A enables again
  PERFORM public.creator_enable_deep_brain();
  PERFORM tests.reset_role();
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.corpus_reprocess_jobs j
       JOIN public.sample_content s ON s.id = j.sample_id
      WHERE s.creator_id = v_creator_b),
    0, '10: A''s enable never enqueues B''s samples (IDOR-proof, no creator_id param)'
  );

  -- 11: activate when build incomplete → creator_v3_not_ready. Explicit
  -- BEGIN/EXCEPTION (the reference admin v3-gate test's pattern) — throws_ok
  -- doesn't cleanly trap a check_violation re-raised through the nested SECDEF
  -- core + advisory lock.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.creator_activate_deep_brain();
    RETURN NEXT fail('11: activate on an unbuilt creator should raise');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('11: activate on an unbuilt creator → creator_v3_not_ready');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('11: expected check_violation, got %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- 12: activate happy — fresh creator C, single fully-wired sample (creator B
  -- carries an intentionally-unbuilt sample from test 10, so it isn't v3-ready).
  SELECT c.user_id, c.creator_id INTO v_user_c, v_creator_c FROM pg_temp.mk_creator('dbC@test','dbc') c;
  PERFORM pg_temp.wire_v3(v_creator_c);
  PERFORM tests.set_authenticated(v_user_c);
  SELECT public.creator_activate_deep_brain() INTO v_res;
  PERFORM tests.reset_role();
  SELECT retrieval_version INTO v_rv FROM public.creators WHERE id = v_creator_c;
  RETURN NEXT ok(
    v_rv = 3 AND (v_res->>'already') = 'false'
      AND EXISTS (SELECT 1 FROM public.creator_audit_log
                   WHERE user_id = v_user_c AND action = 'creator_deep_brain_activate'),
    format('12: activate flips retrieval_version to 3 + audits (rv=%s, already=%s)', v_rv, v_res->>'already')
  );

  -- 13: activate idempotent (M1) — second activate → already, no new audit row.
  SELECT count(*)::int INTO v_audit_pre FROM public.creator_audit_log
   WHERE user_id = v_user_c AND action = 'creator_deep_brain_activate';
  PERFORM tests.set_authenticated(v_user_c);
  SELECT public.creator_activate_deep_brain() INTO v_res;
  PERFORM tests.reset_role();
  SELECT count(*)::int INTO v_audit_post FROM public.creator_audit_log
   WHERE user_id = v_user_c AND action = 'creator_deep_brain_activate';
  RETURN NEXT ok(
    (v_res->>'already') = 'true' AND v_audit_post = v_audit_pre,
    format('13: second activate is a no-op (already=%s, audit %s→%s)', v_res->>'already', v_audit_pre, v_audit_post)
  );

  -- 14: enable when already on v3 → already_on, no new jobs.
  PERFORM tests.set_authenticated(v_user_c);
  SELECT public.creator_enable_deep_brain() INTO v_res;
  PERFORM tests.reset_role();
  RETURN NEXT is(
    v_res->>'already_on', 'true',
    '14: enable when already on v3 → already_on (one-way switch)'
  );

  -- 15: status for creator A (still v1, has v3 jobs queued) → own state.
  PERFORM tests.set_authenticated(v_user);
  SELECT public.creator_deep_brain_status() INTO v_res;
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    (v_res->>'retrieval_version') = '1'
      AND (v_res->>'ready') = 'false'
      AND (v_res->>'total')::int > 0,
    format('15: status returns own retrieval_version + counts (rv=%s ready=%s total=%s)',
           v_res->>'retrieval_version', v_res->>'ready', v_res->>'total')
  );

  -- 16: status as a non-creator → not_a_creator.
  PERFORM tests.set_authenticated(v_stranger);
  RETURN NEXT throws_ok(
    'SELECT public.creator_deep_brain_status()', '42501', NULL,
    '16: status as a non-creator → not_a_creator (42501)'
  );
  PERFORM tests.reset_role();

  -- 17: re-audit M5 — a raw_text sample that is NOT fetch_status='ready' is NOT
  -- buildable (enable's predicate must match creator_v3_ready's 'ready' gate,
  -- else a creator builds yet never satisfies activate). Fresh creator with one
  -- 'pending' (has raw_text) sample → enable raises no_ready_samples.
  DECLARE v_user_d uuid; v_creator_d uuid;
  BEGIN
    SELECT c.user_id, c.creator_id INTO v_user_d, v_creator_d FROM pg_temp.mk_creator('dbD@test','dbd') c;
    INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
      VALUES (gen_random_uuid(), v_creator_d, 'transcript', 'P', 'has text', ARRAY['topic-a'], 'pending');
    PERFORM tests.set_authenticated(v_user_d);
    RETURN NEXT throws_ok(
      'SELECT public.creator_enable_deep_brain()', 'P0001', 'no_ready_samples',
      '17: a non-ready raw_text sample is not buildable (M5 predicate alignment)'
    );
    PERFORM tests.reset_role();
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
