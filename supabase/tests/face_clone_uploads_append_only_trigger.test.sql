-- face_clone_uploads_block_update trigger:
--   1. INSERT default state='pending', warnings='[]', force_overwrite=false → ok
--   2. UPDATE state pending → ready under finalize_locked allowed
--   3. UPDATE state ready → deleted (force-retrain path) allowed
--   4. UPDATE state ready → pending blocked
--   5. Direct UPDATE setting force_overwrite=true on existing row blocked (auditor R2-M2)
--   6. Direct UPDATE rewriting warnings on a row whose warnings already populated blocked (auditor R2-C4)
--   7. Direct UPDATE rewriting last_error on a failed row blocked (auditor R2-C4)
--   8. Direct UPDATE rewriting vendor_face_id once non-null blocked
--   9. Partial unique index — second 'ready' row with same (vendor, vendor_face_id) raises 23505
BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('fcu-admin@test');
  v_cuid   uuid := tests.create_auth_user('fcu-creator@test');
  v_cid    uuid;
  v_uid    bigint;
  v_uid2   bigint;
  v_face   text := 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'fcu-admin@test', 'superadmin');
  UPDATE public.profiles SET handle = 'fcuc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'FCUC', 'fcuc', 'ready', now())
    RETURNING id INTO v_cid;

  -- 1. INSERT happy path.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('a', 64), 'image/jpeg', 1024, 512, 512)
  RETURNING id INTO v_uid;
  RETURN NEXT ok(v_uid IS NOT NULL, '1: insert pending row default state ok');

  -- 2. pending → ready (set vendor_face_id + state via finalize-style update).
  UPDATE public.face_clone_uploads SET vendor_face_id = v_face WHERE id = v_uid;
  UPDATE public.face_clone_uploads SET state = 'ready', ready_at = now() WHERE id = v_uid;
  RETURN NEXT pass('2: pending → ready transition allowed');

  -- 3. ready → deleted.
  UPDATE public.face_clone_uploads SET state = 'deleted' WHERE id = v_uid;
  RETURN NEXT pass('3: ready → deleted allowed');

  -- 4. Re-create a fresh row, attempt ready → pending (illegal).
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, ready_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('b', 64), 'image/jpeg', 1024, 512, 512,
     '11111111-2222-4333-9444-555555555555', 'ready', now())
  RETURNING id INTO v_uid;

  RETURN NEXT throws_like(
    format('UPDATE public.face_clone_uploads SET state = %L WHERE id = %s', 'pending', v_uid),
    '%append-only%',
    '4: ready → pending blocked'
  );

  -- 5. force_overwrite is immutable after insert.
  RETURN NEXT throws_like(
    format('UPDATE public.face_clone_uploads SET force_overwrite = TRUE WHERE id = %s', v_uid),
    '%append-only%',
    '5: force_overwrite mutation blocked (R2-M2)'
  );

  -- 6. warnings fill-in-once. The row above has default warnings='[]'.
  UPDATE public.face_clone_uploads SET warnings = '[{"k":"first"}]'::jsonb WHERE id = v_uid;
  RETURN NEXT throws_like(
    format('UPDATE public.face_clone_uploads SET warnings = %L::jsonb WHERE id = %s',
           '[{"k":"second"}]', v_uid),
    '%append-only%',
    '6: warnings overwrite blocked once populated (R2-C4)'
  );

  -- 7. last_error fill-in-once. Use a fresh row so we own the lifecycle.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('c', 64), 'image/jpeg', 1024, 512, 512)
  RETURNING id INTO v_uid2;
  -- pending → failed with last_error.
  UPDATE public.face_clone_uploads SET state = 'failed', last_error = 'first reason' WHERE id = v_uid2;
  RETURN NEXT throws_like(
    format('UPDATE public.face_clone_uploads SET last_error = %L WHERE id = %s', 'second reason', v_uid2),
    '%append-only%',
    '7: last_error overwrite blocked once populated (R2-C4)'
  );

  -- 8. vendor_face_id is fill-in-once.
  RETURN NEXT throws_like(
    format('UPDATE public.face_clone_uploads SET vendor_face_id = %L WHERE id = %s',
           '99999999-2222-4333-9444-555555555555', v_uid),
    '%append-only%',
    '8: vendor_face_id rewrite blocked'
  );

  -- 9. Partial unique on (vendor, vendor_face_id) WHERE state='ready'.
  -- The row at v_uid is state='ready' with vendor_face_id='11111111-...';
  -- attempt to create a second ready row with the same vendor_face_id.
  RETURN NEXT throws_like(
    $sql$
    INSERT INTO public.face_clone_uploads
      (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
       vendor_face_id, state, ready_at)
    VALUES
      ('$sql$ || v_admin || $sql$', '$sql$ || v_cid || $sql$', 'simli', 'image',
       'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1', 'image/jpeg', 1024, 512, 512,
       '11111111-2222-4333-9444-555555555555', 'ready', now())
    $sql$,
    '%face_clone_uploads_one_ready_per_vendor_idx%',
    '9: second ready row with same vendor_face_id blocked (R2-M3)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
