-- RAG v3 step 6 / mig 41 -- admin_set_creator_retrieval_version: v3 flip gate.
--
-- Plan §6 step 3 -- "the admin literally cannot flip a half-built creator."
-- Pins the v3 flip's creator_v3_ready gate so a future RPC refactor that
-- drops the gate trips this test.
--
-- 1. Flip v=1->v=3 when creator_v3_ready returns FALSE -> check_violation
--    'creator_v3_not_ready' (no samples means trivially not ready).
-- 2. Flip v=1->v=3 when creator_v3_ready returns TRUE -> succeeds + persisted.
-- 3. Round-5 C3 -- same-version v=3->v=3 is a NO-OP: no audit row written,
--    no recompile triggered, no raise. Strengthened (round-5 C2) by ALSO
--    breaking the gate AND deleting v3 data before the same-version call:
--    proves the early-return is independent of the recompile path AND the
--    gate path, not just the recompile-doesn't-touch-sections coincidence.
-- 4. v=3->v=2 downgrade succeeds (the flip itself works).
-- 5. admin_audit_log carries before/after for v3 flips (with id tiebreaker
--    so the per-statement timestamp tie doesn't make this flap -- round-5 M4).
-- 6. Round-5 M6 -- v3->v2 downgrade leaves chunker_version=3 chunks + v3
--    sections ALIVE (the documented cleanup gap). Forward marker: when the
--    cleanup migration lands, flip the assert from "alive" to "deleted".
-- 7. Round-5 C3 partner -- v=1->v=1 same-version also no-ops cleanly
--    (idempotency holds at every base version, not just v=3).

BEGIN;
SELECT plan(7);

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

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin           uuid := tests.create_auth_user('av3-admin@test');
  v_user            uuid := tests.create_auth_user('av3-user@test');
  v_creator         uuid;
  v_app             uuid;
  v_sample          uuid;
  v_sec             uuid;
  v_unit            uuid;
  v_after           smallint;
  v_audit_after     text;
  v_audit_before    text;
  v_audit_count_pre int;
  v_audit_count_post int;
  v_chunks_v3       int;
  v_sections_v3     int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'av3-admin@test', 'superadmin');
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'AV3', 'av3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
    VALUES (gen_random_uuid(), v_user, v_app, 'AV3', 'av3', 'ready', 'vector')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- 1: flip to v=3 with empty creator (creator_v3_ready=FALSE) -> reject.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_set_creator_retrieval_version(v_creator, 3::smallint);
    RETURN NEXT fail('1: flip to v=3 on half-built creator should raise');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('1: creator_v3_not_ready gate trips on empty creator');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('1: expected check_violation, got %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- Wire up the creator fully so creator_v3_ready returns TRUE.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'OK', 'b',
            ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
    VALUES (v_sample, 3, 'done', 1);
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 0, 'S1', 's', 0, 100, ARRAY['topic-a'],
     pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 0, 'U1', 'u', 10, ARRAY['topic-a'], v_sec)
  RETURNING id INTO v_unit;
  -- Round-5 M5: use the v3 insert RPC, not a raw INSERT, so the test
  -- exercises the production write path (including cross-section closure).
  PERFORM public._insert_chunk_v3_unsafe(
    v_unit, v_sec, 0, 'c', NULL, 10, ARRAY['topic-a'], pg_temp.unit_vec(1));

  -- 2: flip to v=3 succeeds + persists.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_retrieval_version(v_creator, 3::smallint);
  PERFORM tests.reset_role();
  SELECT retrieval_version INTO v_after
    FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_after::int, 3, '2: flip to v=3 succeeds when creator_v3_ready=TRUE');

  -- 3: Round-5 C3 + C2 strengthening. Same-version v=3->v=3 is a NO-OP.
  -- Break the gate AND delete v3 data so a "naive" implementation that
  -- re-runs the gate would raise check_violation. Also count audit rows
  -- before/after to prove no audit-log noise on same-version.
  --
  -- Why this is stronger than the previous version: brain_compile (mig
  -- 20260514000001b) doesn't read sections/chunks today, so just NULLing
  -- a section embedding didn't isolate the gate-skip from the recompile.
  -- Here we ALSO blow away v3 chunks + sections; the early-return at the
  -- top of the RPC is the ONLY thing standing between the test and a
  -- creator_v3_not_ready raise.
  DELETE FROM public.sample_content_chunks
    WHERE creator_id = v_creator AND chunker_version = 3;
  DELETE FROM public.sample_content_narrative_units
    WHERE creator_id = v_creator;
  DELETE FROM public.sample_content_sections WHERE id = v_sec;
  SELECT count(*) INTO v_audit_count_pre
    FROM public.admin_audit_log
   WHERE action = 'creator_retrieval_version_set' AND target_id = v_creator;
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_retrieval_version(v_creator, 3::smallint);
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_audit_count_post
    FROM public.admin_audit_log
   WHERE action = 'creator_retrieval_version_set' AND target_id = v_creator;
  RETURN NEXT is(
    v_audit_count_post, v_audit_count_pre,
    '3: same-version v=3->v=3 is a NO-OP (no audit row, no gate re-check, even with broken data)'
  );

  -- Restore minimal wiring so test 4 can verify a real flip happens.
  -- (Recreate section + unit + chunk via RPC.)
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 0, 'S1', 's', 0, 100, ARRAY['topic-a'],
     pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 0, 'U1', 'u', 10, ARRAY['topic-a'], v_sec)
  RETURNING id INTO v_unit;
  PERFORM public._insert_chunk_v3_unsafe(
    v_unit, v_sec, 0, 'c', NULL, 10, ARRAY['topic-a'], pg_temp.unit_vec(1));

  -- 4: v=3->v=2 downgrade succeeds (the flip itself).
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_retrieval_version(v_creator, 2::smallint);
  PERFORM tests.reset_role();
  SELECT retrieval_version INTO v_after
    FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_after::int, 2, '4: v=3->v=2 downgrade flip succeeds');

  -- 5: admin_audit_log carries the v=3 flip's before/after.
  -- Round-5 M4: tiebreak by id so the per-statement timestamp tie doesn't
  -- flap. We want the audit row whose before=1 AND after=3 -- the actual
  -- v=2->v=3 flip from test 2.
  SELECT after->>'retrieval_version', before->>'retrieval_version'
    INTO v_audit_after, v_audit_before
    FROM public.admin_audit_log
   WHERE action = 'creator_retrieval_version_set'
     AND target_id = v_creator
     AND (before->>'retrieval_version') = '1'
     AND (after->>'retrieval_version')  = '3'
   ORDER BY created_at DESC, id DESC LIMIT 1;
  RETURN NEXT is(
    v_audit_before || '->' || v_audit_after, '1->3',
    '5: admin_audit_log records v=1->v=3 flip (with id tiebreaker -- round-5 M4)'
  );

  -- 6: Round-5 M6 -- v3->v2 downgrade leaves v3 chunks + sections ALIVE.
  -- The documented cleanup gap (mig 41 COMMENT). Forward marker: when the
  -- v3->v2 cleanup migration lands, flip these counts to 0 and add a
  -- v_units_deleted assert.
  SELECT count(*) INTO v_chunks_v3
    FROM public.sample_content_chunks
   WHERE creator_id = v_creator AND chunker_version = 3;
  SELECT count(*) INTO v_sections_v3
    FROM public.sample_content_sections
   WHERE creator_id = v_creator;
  RETURN NEXT ok(
    v_chunks_v3 > 0 AND v_sections_v3 > 0,
    '6: v3->v2 downgrade documented gap -- chunker_version=3 chunks + sections ALIVE (flip to =0 when cleanup migration lands)'
  );

  -- 7: Round-5 C3 partner -- v=2->v=2 same-version also no-ops cleanly.
  -- Idempotency holds at every base version, not only v=3.
  -- Creator is at v=2 from test 4.
  SELECT count(*) INTO v_audit_count_pre
    FROM public.admin_audit_log
   WHERE action = 'creator_retrieval_version_set' AND target_id = v_creator;
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_retrieval_version(v_creator, 2::smallint);
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_audit_count_post
    FROM public.admin_audit_log
   WHERE action = 'creator_retrieval_version_set' AND target_id = v_creator;
  RETURN NEXT is(
    v_audit_count_post, v_audit_count_pre,
    '7: same-version v=2->v=2 is a NO-OP (idempotency at every base version)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
