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
-- 8. Step-9 audit C1 (SOFT CUTOVER) -- flip v=2->v=3 NO LONGER deletes the
--    creator's chunker_version IN (1,2) chunks or v2-shape narrative_units.
--    ALL versions survive (v1+v2 go dormant, v3 live) so rollback works. The
--    audit row carries soft_cutover=true + legacy_chunks_purged=false.
-- 9. Step-9 audit C1 (ROLLBACK) -- after the v2->v3 flip, flipping v=3->v=2
--    still finds the (preserved) chunker_version=2 chunks -- rollback is NOT
--    bricked. This is the bug the soft cutover fixes.
-- 10. Step-9 audit C1 (PURGE) -- admin_purge_legacy_chunks on the v3 creator
--    deletes the dormant v1+v2 chunks + v2-shape units, preserves v3, bumps
--    current_corpus_version, returns counts.
-- 11. Step-9 audit C1 (PURGE) -- admin_purge_legacy_chunks deletes dormant
--    v1+v2 + v2-shape units, preserves v3, returns counts.
-- 12. Step-9 audit M2 (ROLLBACK-AFTER-PURGE) -- once legacy_purged_at is set,
--    admin_set_creator_retrieval_version refuses a 3->2 rollback
--    (check_violation 'rollback_refused_legacy_purged' -- the v1/v2 corpus is
--    gone, so the rollback would read empty). Pre-purge rollback (case 10)
--    still succeeds; this proves the gate only fires post-purge.
-- 13. Step-9 audit C1 (PURGE GUARD) -- admin_purge_legacy_chunks on a creator
--    NOT on v3 raises check_violation 'purge_refused_creator_not_on_v3'
--    (refuses to delete a live v2 corpus).

BEGIN;
SELECT plan(13);

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

  -- ── 8-11: Step-9 audit C1 — SOFT cutover + rollback + purge ───────────
  -- Fresh creator with v1 + v2 + v3 chunks coexisting (the additive-build
  -- end-state: build complete, creator_v3_ready=true, about to flip). Flip
  -- v2->v3 and assert ALL versions SURVIVE (soft cutover), then prove
  -- rollback to v2 still works, then prove the explicit purge deletes the
  -- dormant legacy + guards a non-v3 creator.
  DECLARE
    v_user_c     uuid := tests.create_auth_user('av3-cutover@test');
    v_app_c      uuid;
    v_creator_c  uuid;
    v_sample_c   uuid;
    v_sec_c      uuid;
    v_unit_v3_c  uuid;
    v_v1_after   int;
    v_v2_after   int;
    v_v3_after   int;
    v_v2u_after  int;
    v_v3u_after  int;
    v_soft       text;
    v_purged_flag text;
    v_purge_res  jsonb;
  BEGIN
    INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
      VALUES (gen_random_uuid(), v_user_c, 'approved', 'AV3C', 'av3c', '[]'::jsonb, '{}'::jsonb)
      RETURNING id INTO v_app_c;
    INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode, retrieval_version)
      VALUES (gen_random_uuid(), v_user_c, v_app_c, 'AV3C', 'av3c', 'ready', 'vector', 2)
      RETURNING id INTO v_creator_c;
    INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
      VALUES (v_creator_c, 'topic-a', 'Topic A', 0);
    INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
      VALUES (gen_random_uuid(), v_creator_c, 'transcript', 'S', 'b', ARRAY['topic-a'], 'ready')
      RETURNING id INTO v_sample_c;
    INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
      VALUES (v_sample_c, 3, 'done', 1);
    -- v3 section + unit (additive-build survivors).
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end,
       topic_tags, summary_embedding, centroid_embedding)
    VALUES (v_sample_c, v_creator_c, 0, 'S', 's', 0, 100, ARRAY['topic-a'],
            pg_temp.unit_vec(1), pg_temp.unit_vec(2))
    RETURNING id INTO v_sec_c;
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
    VALUES (v_sample_c, v_creator_c, 1000, 'V3U', 'u', 10, ARRAY['topic-a'], v_sec_c)
    RETURNING id INTO v_unit_v3_c;
    PERFORM public._insert_chunk_v3_unsafe(
      v_unit_v3_c, v_sec_c, 0, 'v3c', NULL, 10, ARRAY['topic-a'], pg_temp.unit_vec(1));
    -- v2-shape unit (section_id NULL) + v1 + v2 chunks (the to-be-cut corpus).
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
    VALUES (v_sample_c, v_creator_c, 0, 'V2U', 'u2', 10, ARRAY['topic-a'], NULL);
    INSERT INTO public.sample_content_chunks
      (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
    VALUES
      (gen_random_uuid(), v_sample_c, v_creator_c, 0, 'v1', ARRAY['topic-a'], pg_temp.unit_vec(1), 1),
      (gen_random_uuid(), v_sample_c, v_creator_c, 1, 'v2', ARRAY['topic-a'], pg_temp.unit_vec(1), 2);

    -- Flip v2->v3 (creator_v3_ready=true: the one sample has done job +
    -- section w/ embeddings + a v3 chunk).
    PERFORM tests.set_authenticated(v_admin);
    PERFORM public.admin_set_creator_retrieval_version(v_creator_c, 3::smallint);
    PERFORM tests.reset_role();

    -- 8: SOFT cutover — ALL versions survive the flip (v1+v2 dormant, v3 live).
    SELECT count(*) INTO v_v1_after FROM public.sample_content_chunks
     WHERE creator_id = v_creator_c AND chunker_version = 1;
    SELECT count(*) INTO v_v2_after FROM public.sample_content_chunks
     WHERE creator_id = v_creator_c AND chunker_version = 2;
    SELECT count(*) INTO v_v3_after FROM public.sample_content_chunks
     WHERE creator_id = v_creator_c AND chunker_version = 3;
    SELECT count(*) INTO v_v2u_after FROM public.sample_content_narrative_units
     WHERE creator_id = v_creator_c AND section_id IS NULL;
    SELECT count(*) INTO v_v3u_after FROM public.sample_content_narrative_units
     WHERE creator_id = v_creator_c AND section_id IS NOT NULL;
    RETURN NEXT ok(
      v_v1_after = 1 AND v_v2_after = 1 AND v_v3_after = 1
        AND v_v2u_after = 1 AND v_v3u_after = 1,
      format('8: v2->v3 SOFT cutover — v1=%s v2=%s v3=%s v2u=%s v3u=%s (want 1/1/1/1/1, all survive)',
             v_v1_after, v_v2_after, v_v3_after, v_v2u_after, v_v3u_after)
    );

    -- 9: audit row carries soft_cutover=true + legacy_chunks_purged=false.
    SELECT after->>'soft_cutover', after->>'legacy_chunks_purged'
      INTO v_soft, v_purged_flag
      FROM public.admin_audit_log
     WHERE action = 'creator_retrieval_version_set'
       AND target_id = v_creator_c
       AND (after->>'retrieval_version') = '3'
     ORDER BY created_at DESC, id DESC LIMIT 1;
    RETURN NEXT is(
      v_soft || '|' || v_purged_flag, 'true|false',
      format('9: v2->v3 audit carries soft_cutover=%s legacy_chunks_purged=%s (want true|false)',
             COALESCE(v_soft, 'NULL'), COALESCE(v_purged_flag, 'NULL'))
    );

    -- 10: ROLLBACK — flip v3->v2 still finds the preserved v2 chunks. This is
    -- the bug the soft cutover fixes: pre-fix, the v2 chunks were gone so a
    -- v3->v2 rollback read zero chunks. Assert the v2 chunk survives the
    -- round-trip (flip back to 2 then count chunker_version=2).
    PERFORM tests.set_authenticated(v_admin);
    PERFORM public.admin_set_creator_retrieval_version(v_creator_c, 2::smallint);
    PERFORM tests.reset_role();
    SELECT count(*) INTO v_v2_after FROM public.sample_content_chunks
     WHERE creator_id = v_creator_c AND chunker_version = 2;
    RETURN NEXT ok(
      v_v2_after = 1,
      format('10: rollback v3->v2 — v2 chunk preserved (count=%s, want 1, NOT bricked)',
             v_v2_after)
    );

    -- 11: PURGE — flip back to v3, then admin_purge_legacy_chunks deletes the
    -- dormant v1+v2 + v2-shape unit, preserves v3, returns counts.
    PERFORM tests.set_authenticated(v_admin);
    PERFORM public.admin_set_creator_retrieval_version(v_creator_c, 3::smallint);
    SELECT public.admin_purge_legacy_chunks(v_creator_c) INTO v_purge_res;
    PERFORM tests.reset_role();
    SELECT count(*) INTO v_v1_after FROM public.sample_content_chunks
     WHERE creator_id = v_creator_c AND chunker_version IN (1, 2);
    SELECT count(*) INTO v_v3_after FROM public.sample_content_chunks
     WHERE creator_id = v_creator_c AND chunker_version = 3;
    SELECT count(*) INTO v_v2u_after FROM public.sample_content_narrative_units
     WHERE creator_id = v_creator_c AND section_id IS NULL;
    RETURN NEXT ok(
      v_v1_after = 0 AND v_v3_after = 1 AND v_v2u_after = 0
        AND (v_purge_res->>'legacy_chunks_deleted') = '2'
        AND (v_purge_res->>'v2_narrative_units_deleted') = '1',
      format('11: purge — legacy v1/v2=%s v3=%s v2u=%s res.chunks=%s res.units=%s (want 0/1/0, res 2/1)',
             v_v1_after, v_v3_after, v_v2u_after,
             v_purge_res->>'legacy_chunks_deleted', v_purge_res->>'v2_narrative_units_deleted')
    );

    -- 13: Step-9 audit M2 — ROLLBACK-AFTER-PURGE refused. creator_c is on v3
    -- with legacy_purged_at now set (case 11). A 3->2 rollback must RAISE: the
    -- v1/v2 corpus is gone, so it would read empty. Contrast case 10 where the
    -- pre-purge rollback succeeded — same flip, opposite outcome, the only
    -- difference being the purge stamped legacy_purged_at.
    PERFORM tests.set_authenticated(v_admin);
    RETURN NEXT throws_ok(
      format('SELECT public.admin_set_creator_retrieval_version(%L::uuid, 2::smallint)', v_creator_c),
      '23514',  -- check_violation (rollback_refused_legacy_purged)
      NULL,
      '12: M2 — rollback v3->v2 REFUSED after legacy purge (would read empty corpus)'
    );
    PERFORM tests.reset_role();
  END;

  -- ── 12: purge GUARD is its own slot.
  -- New creator on v2 (never flipped to 3): purge must REFUSE.
  DECLARE
    v_user_d     uuid := tests.create_auth_user('av3-purgeguard@test');
    v_app_d      uuid;
    v_creator_d  uuid;
  BEGIN
    INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
      VALUES (gen_random_uuid(), v_user_d, 'approved', 'AV3D', 'av3d', '[]'::jsonb, '{}'::jsonb)
      RETURNING id INTO v_app_d;
    INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode, retrieval_version)
      VALUES (gen_random_uuid(), v_user_d, v_app_d, 'AV3D', 'av3d', 'ready', 'vector', 2)
      RETURNING id INTO v_creator_d;
    PERFORM tests.set_authenticated(v_admin);
    RETURN NEXT throws_ok(
      format('SELECT public.admin_purge_legacy_chunks(%L::uuid)', v_creator_d),
      '23514',  -- check_violation SQLSTATE (matches the RPC's errcode='check_violation')
      NULL,
      '13: guard — admin_purge_legacy_chunks refuses a creator not on v3 (would brick live v2 corpus)'
    );
    PERFORM tests.reset_role();
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
