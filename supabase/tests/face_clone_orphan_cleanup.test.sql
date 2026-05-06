-- face_clone_orphan_cleanup:
--   1. happy path on pending row: marks failed, enqueues vendor_face_id for delete.
--   2. on already-failed row: skips state UPDATE but still enqueues (idempotent).
--   3. R3-NM5 guard — refuses when state='ready' AND creators.simli_face_id matches (live face).
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('foc-admin@test');
  v_cuid   uuid := tests.create_auth_user('foc-creator@test');
  v_cid    uuid;
  v_uid    bigint;
  v_face   text := '44444444-5555-4666-9777-888888888888';
  v_state  text;
  v_qcount bigint;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'foc-admin@test', 'superadmin');
  UPDATE public.profiles SET handle = 'focc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'FOCC', 'focc', 'ready', now())
    RETURNING id INTO v_cid;

  -- 1. Happy path: pending row + vendor_face_id, orphan_cleanup marks failed.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('a', 64), 'image/jpeg', 1024, 512, 512, v_face, 'pending')
  RETURNING id INTO v_uid;

  PERFORM public.face_clone_orphan_cleanup(v_admin, v_uid, v_cid, v_face, 'lost_test_race');

  SELECT state::text INTO v_state FROM public.face_clone_uploads WHERE id = v_uid;
  RETURN NEXT is(v_state, 'failed', '1a: pending → failed via orphan_cleanup');

  SELECT count(*) INTO v_qcount FROM public.simli_face_delete_queue WHERE face_id = v_face;
  RETURN NEXT is(v_qcount::int, 1, '1b: vendor_face_id enqueued for delete');

  -- 2. Idempotent: second orphan_cleanup on the now-failed row updates the queue
  --    (ON CONFLICT DO UPDATE) but does not change state.
  PERFORM public.face_clone_orphan_cleanup(v_admin, v_uid, v_cid, v_face, 'second_call');
  SELECT state::text INTO v_state FROM public.face_clone_uploads WHERE id = v_uid;
  RETURN NEXT is(v_state, 'failed', '2: idempotent re-call leaves state=failed');

  -- 3. R3-NM5 — orphan_cleanup against a ready row whose face is currently
  -- creators.simli_face_id must refuse.
  -- Set up: insert a ready row whose vendor_face_id matches a freshly-set
  -- creators.simli_face_id.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, ready_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('b', 64), 'image/jpeg', 1024, 512, 512,
     '55555555-6666-4777-9888-999999999999', 'ready', now())
  RETURNING id INTO v_uid;
  UPDATE public.creators SET simli_face_id = '55555555-6666-4777-9888-999999999999'
   WHERE id = v_cid;

  RETURN NEXT throws_like(
    format('SELECT public.face_clone_orphan_cleanup(%L, %s, %L, %L, %L)',
           v_admin, v_uid, v_cid, '55555555-6666-4777-9888-999999999999', 'replay_test'),
    '%orphan_cleanup_refused_live_face%',
    '3a: orphan_cleanup against live ready face refused (R3-NM5)'
  );

  -- 3b — assert no extra queue rows enqueued for the live face.
  SELECT count(*) INTO v_qcount FROM public.simli_face_delete_queue
   WHERE face_id = '55555555-6666-4777-9888-999999999999';
  RETURN NEXT is(v_qcount::int, 0, '3b: live face not enqueued for delete');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
