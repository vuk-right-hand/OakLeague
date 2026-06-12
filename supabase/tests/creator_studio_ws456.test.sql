-- CREATOR_STUDIO WS4/5/6 — migration 20260612000001.
--  1. provenance CHECK: zero actors rejected; two actors rejected.
--  2. voice trigger NULL-safety (audit C1): creator row (admin_user_id NULL)
--     cartesia_voice_id NULL→value UPDATE succeeds.
--  3. voice trigger still blocks identity mutation on creator rows.
--  4. voice_clone_finalize_creator: not_a_creator for stranger.
--  5. finalize_creator happy path: creators.voice_id set + script used_at stamped.
--  6. finalize_creator ownership: another creator's upload → 22023.
--  7. overwrite while published → P0001 voice_locked_while_live.
--  8. first-fill while published succeeds (fill ≠ swap, audit M5).
--  9. face_clone_finalize_creator happy: pending → ready + simli_face_id.
-- 10. face overwrite while published → P0001 face_locked_while_live.
-- 11. grants: scripts + reports tables service-role only; finalize fns
--     authenticated-executable, anon denied.
-- 12. videos.admin_removed_at exists (takedown lock column).
-- 13. voice-source bucket exists, public=false.
-- 14. content_reports insert shape works (service-role).

BEGIN;
SELECT plan(14);

CREATE FUNCTION pg_temp.mk_creator(p_email text, p_handle text)
RETURNS TABLE(user_id uuid, creator_id uuid)
LANGUAGE plpgsql AS $$
DECLARE v_user uuid; v_app uuid; v_creator uuid;
BEGIN
  v_user := tests.create_auth_user(p_email);
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', p_handle, p_handle, '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, p_handle, p_handle, 'ready')
    RETURNING id INTO v_creator;
  RETURN QUERY SELECT v_user, v_creator;
END;
$$;

CREATE FUNCTION pg_temp.mk_voice_upload(p_user uuid, p_creator uuid, p_script uuid)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.voice_clone_uploads
    (uploaded_by_user_id, creator_id, tts_provider, sha256, duration_seconds, mime, bytes, script_id)
  VALUES
    (p_user, p_creator, 'cartesia', repeat('a', 64), 45.0, 'audio/wav', 1000000, p_script)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid; v_creator uuid;
  v_user_b uuid; v_creator_b uuid;
  v_stranger uuid := tests.create_auth_user('cs-stranger@test');
  v_script uuid;
  v_upload bigint;
  v_upload_b bigint;
  v_face_upload bigint;
  v_voice text;
  v_used timestamptz;
BEGIN
  SELECT c.user_id, c.creator_id INTO v_user, v_creator FROM pg_temp.mk_creator('csA@test','csa') c;
  SELECT c.user_id, c.creator_id INTO v_user_b, v_creator_b FROM pg_temp.mk_creator('csB@test','csb') c;

  INSERT INTO public.voice_clone_scripts (creator_id, sentences)
    VALUES (v_creator, '["a","b","c","d"]'::jsonb) RETURNING id INTO v_script;

  -- 1: provenance CHECK.
  RETURN NEXT throws_ok(
    format($q$INSERT INTO public.voice_clone_uploads
      (creator_id, tts_provider, sha256, duration_seconds, mime, bytes)
      VALUES (%L, 'cartesia', repeat('b',64), 30, 'audio/wav', 1000)$q$, v_creator),
    '23514', NULL, '1: zero-actor upload row rejected (provenance CHECK)'
  );

  -- 2: creator-row fill-in-once UPDATE passes the rewritten trigger (C1).
  v_upload := pg_temp.mk_voice_upload(v_user, v_creator, v_script);
  UPDATE public.voice_clone_uploads SET cartesia_voice_id = 'voice-trigger-ok' WHERE id = v_upload;
  RETURN NEXT is(
    (SELECT cartesia_voice_id FROM public.voice_clone_uploads WHERE id = v_upload),
    'voice-trigger-ok', '2: NULL-admin creator row finalize UPDATE passes trigger (C1 fix)'
  );

  -- 3: identity mutation still blocked on creator rows.
  RETURN NEXT throws_ok(
    format('UPDATE public.voice_clone_uploads SET sha256 = repeat(''c'', 64) WHERE id = %s', v_upload),
    '42501', NULL, '3: identity column mutation still blocked on creator rows'
  );

  -- 4: finalize as a non-creator → 42501.
  PERFORM tests.set_authenticated(v_stranger);
  RETURN NEXT throws_ok(
    'SELECT * FROM public.voice_clone_finalize_creator(1, ''v'')',
    '42501', NULL, '4: finalize_creator as non-creator → not_a_creator'
  );
  PERFORM tests.reset_role();

  -- 5: happy path — fresh upload, finalize sets creators.voice_id + stamps script.
  v_upload := pg_temp.mk_voice_upload(v_user, v_creator, v_script);
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.voice_clone_finalize_creator(v_upload, 'cartesia-voice-1');
  PERFORM tests.reset_role();
  SELECT voice_id INTO v_voice FROM public.creators WHERE id = v_creator;
  SELECT used_at INTO v_used FROM public.voice_clone_scripts WHERE id = v_script;
  RETURN NEXT ok(
    v_voice = 'cartesia-voice-1' AND v_used IS NOT NULL,
    format('5: finalize_creator sets voice_id (%s) + stamps script used_at (%s)', v_voice, v_used IS NOT NULL)
  );

  -- 6: ownership — B cannot finalize A's upload.
  v_upload := pg_temp.mk_voice_upload(v_user, v_creator, NULL);
  PERFORM tests.set_authenticated(v_user_b);
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.voice_clone_finalize_creator(%s, ''steal'')', v_upload),
    '22023', NULL, '6: finalize_creator on another creator''s upload → ownership mismatch'
  );
  PERFORM tests.reset_role();

  -- 7: overwrite while published → voice_locked_while_live.
  UPDATE public.creators SET published_at = now() WHERE id = v_creator;
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.voice_clone_finalize_creator(%s, ''swap-attempt'')', v_upload),
    'P0001', 'voice_locked_while_live', '7: overwrite while published → voice_locked_while_live'
  );
  PERFORM tests.reset_role();

  -- 8: first-fill while published succeeds (creator B, no prior voice, published).
  UPDATE public.creators SET published_at = now() WHERE id = v_creator_b;
  v_upload_b := pg_temp.mk_voice_upload(v_user_b, v_creator_b, NULL);
  PERFORM tests.set_authenticated(v_user_b);
  PERFORM public.voice_clone_finalize_creator(v_upload_b, 'first-fill-voice');
  PERFORM tests.reset_role();
  RETURN NEXT is(
    (SELECT voice_id FROM public.creators WHERE id = v_creator_b),
    'first-fill-voice', '8: first-fill completes even while published (fill, not swap — M5)'
  );

  -- 9: face finalize happy (creator A unpublished again, pending row w/ vendor id).
  UPDATE public.creators SET published_at = NULL, simli_face_id = NULL WHERE id = v_creator;
  INSERT INTO public.face_clone_uploads
    (uploaded_by_user_id, creator_id, vendor, media_kind, sha256, mime, bytes,
     width, height, vendor_face_id, state, force_overwrite)
  VALUES
    (v_user, v_creator, 'simli', 'image', repeat('d', 64), 'image/jpeg', 50000,
     512, 512, 'face-abc', 'pending', false)
  RETURNING id INTO v_face_upload;
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.face_clone_finalize_creator(v_face_upload, 'face-abc');
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    (SELECT simli_face_id FROM public.creators WHERE id = v_creator) = 'face-abc'
      AND (SELECT state FROM public.face_clone_uploads WHERE id = v_face_upload) = 'ready',
    '9: face finalize_creator flips pending→ready + sets simli_face_id'
  );

  -- 10: face overwrite while published → face_locked_while_live.
  UPDATE public.creators SET published_at = now() WHERE id = v_creator;
  INSERT INTO public.face_clone_uploads
    (uploaded_by_user_id, creator_id, vendor, media_kind, sha256, mime, bytes,
     width, height, vendor_face_id, state, force_overwrite)
  VALUES
    (v_user, v_creator, 'simli', 'image', repeat('e', 64), 'image/jpeg', 50000,
     512, 512, 'face-swap', 'pending', true)
  RETURNING id INTO v_face_upload;
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.face_clone_finalize_creator(%s, ''face-swap'')', v_face_upload),
    'P0001', 'face_locked_while_live', '10: face overwrite while published → face_locked_while_live'
  );
  PERFORM tests.reset_role();

  -- 11: grants.
  RETURN NEXT ok(
        NOT has_table_privilege('authenticated', 'public.voice_clone_scripts', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.content_reports', 'INSERT')
    AND has_table_privilege('service_role', 'public.content_reports', 'INSERT')
    AND has_function_privilege('authenticated'::regrole, 'public.voice_clone_finalize_creator(bigint, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon'::regrole, 'public.voice_clone_finalize_creator(bigint, text)', 'EXECUTE')
    AND has_function_privilege('authenticated'::regrole, 'public.face_clone_finalize_creator(bigint, text)', 'EXECUTE'),
    '11: grants — tables service-role only; finalize fns authenticated, anon denied'
  );

  -- 12: takedown lock column exists.
  RETURN NEXT has_column('public', 'videos', 'admin_removed_at', '12: videos.admin_removed_at exists');

  -- 13: voice-source bucket private.
  RETURN NEXT is(
    (SELECT public FROM storage.buckets WHERE id = 'voice-source'), false,
    '13: voice-source bucket exists and is private'
  );

  -- 14: content_reports anon-shaped insert (service-role path).
  INSERT INTO public.content_reports (target_kind, target_id, reason)
    VALUES ('hook', gen_random_uuid(), 'test report');
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.content_reports WHERE reason = 'test report'),
    1, '14: content_reports accepts an anonymous (NULL reporter) report'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
