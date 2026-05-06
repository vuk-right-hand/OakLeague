-- face_clone_finalize_locked end-to-end lifecycle:
--   1. service-role required (anon caller raises 42501).
--   2. happy path: pending → ready, sets creators.simli_face_id, returns prior=NULL.
--   3. force=false on a creator with existing face raises 23505 'already has a face'.
--   4. force=true with active session raises 55006.
--   5. wrong-state finalize (state='failed') raises P0002 (auditor R3-NM6 split).
--   6. idempotent re-call on state='ready' with matching simli_face_id returns success.
--   7. drift detection: state='ready' but creators.simli_face_id NULL raises P0001 face_state_drift.
BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('fcl-admin@test');
  v_user   uuid := tests.create_auth_user('fcl-user@test');
  v_cuid   uuid := tests.create_auth_user('fcl-creator@test');
  v_cid    uuid;
  v_uid    bigint;
  v_face   text := '22222222-3333-4444-9555-666666666666';
  v_face2  text := '77777777-8888-4999-9aaa-bbbbbbbbbbbb';
  v_prior  text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'fcl-admin@test', 'superadmin');
  UPDATE public.profiles SET handle = 'fclc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'FCLC', 'fclc', 'ready', now())
    RETURNING id INTO v_cid;

  -- 1. service-role guard. tests.set_authenticated runs as auth role.
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT * FROM public.face_clone_finalize_locked(%L, %s, %L, %L)',
           v_admin, 0, v_cid, v_face),
    '%service_role only%',
    '1: anon/auth caller blocked'
  );
  PERFORM tests.reset_role();

  -- 2. happy path.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('a', 64), 'image/jpeg', 1024, 512, 512, v_face, 'pending')
  RETURNING id INTO v_uid;

  SELECT prior_face_id INTO v_prior
    FROM public.face_clone_finalize_locked(v_admin, v_uid, v_cid, v_face);
  RETURN NEXT ok(
    v_prior IS NULL
    AND (SELECT simli_face_id FROM public.creators WHERE id = v_cid) = v_face
    AND (SELECT state::text FROM public.face_clone_uploads WHERE id = v_uid) = 'ready',
    '2: happy path sets simli_face_id, flips state'
  );

  -- 3. second upload with force_overwrite=false on a creator that now HAS a face.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, force_overwrite)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('b', 64), 'image/jpeg', 1024, 512, 512, v_face2, 'pending', false)
  RETURNING id INTO v_uid;
  RETURN NEXT throws_like(
    format('SELECT * FROM public.face_clone_finalize_locked(%L, %s, %L, %L)',
           v_admin, v_uid, v_cid, v_face2),
    '%creator already has a face%',
    '3: force=false + prior face raises 23505'
  );

  -- 4. force=true with active session. Mark current row force=true via direct
  -- update — but that's blocked by the trigger. Insert a fresh row instead.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, force_overwrite)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('c', 64), 'image/jpeg', 1024, 512, 512,
     '33333333-3333-4444-9555-666666666666', 'pending', true)
  RETURNING id INTO v_uid;

  -- Open a session against the creator.
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user, v_cid, 'gemini_3_1_flash_live_preview', 'free');

  RETURN NEXT throws_like(
    format('SELECT * FROM public.face_clone_finalize_locked(%L, %s, %L, %L)',
           v_admin, v_uid, v_cid,
           '33333333-3333-4444-9555-666666666666'),
    '%active sessions%',
    '4: force=true + active session raises 55006'
  );

  -- Close the session for subsequent tests.
  UPDATE public.sessions SET ended_at = now(), end_reason = 'test_cleanup'
   WHERE creator_id = v_cid AND ended_at IS NULL;

  -- 5. wrong-state P0002. Mark current pending row 'failed' and try to finalize.
  UPDATE public.face_clone_uploads SET state = 'failed', last_error = 'test'
   WHERE id = v_uid;
  RETURN NEXT throws_like(
    format('SELECT * FROM public.face_clone_finalize_locked(%L, %s, %L, %L)',
           v_admin, v_uid, v_cid,
           '33333333-3333-4444-9555-666666666666'),
    '%cannot finalize from state=failed%',
    '5: wrong-state finalize raises with P0002 sentinel (R3-NM6)'
  );

  -- 6. Idempotent re-call on a ready row whose simli_face_id still matches.
  -- The first happy-path call left v_face on creators; finalize the same upload
  -- (id captured at step 2) re-call should succeed quietly.
  -- Find the upload-id that's currently 'ready'.
  SELECT id INTO v_uid FROM public.face_clone_uploads
   WHERE creator_id = v_cid AND state = 'ready' AND vendor_face_id = v_face
   LIMIT 1;
  PERFORM public.face_clone_finalize_locked(v_admin, v_uid, v_cid, v_face);
  RETURN NEXT pass('6: idempotent re-call on ready+matching face succeeds');

  -- 7. Drift detection. NULL out simli_face_id and re-call finalize on the ready row.
  UPDATE public.creators SET simli_face_id = NULL WHERE id = v_cid;
  RETURN NEXT throws_like(
    format('SELECT * FROM public.face_clone_finalize_locked(%L, %s, %L, %L)',
           v_admin, v_uid, v_cid, v_face),
    '%face_state_drift%',
    '7: ready+drift raises P0001 face_state_drift (R2-C3)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
