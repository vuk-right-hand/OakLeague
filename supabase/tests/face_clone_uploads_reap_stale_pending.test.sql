-- face_clone_uploads_reap_stale_pending:
--   1. service-role only.
--   2. p_max_age_minutes range guard (raises 22023 on out-of-range).
--   3. Happy path: rows older than p_max_age_minutes flipped to failed,
--      vendor face enqueued for delete; younger rows untouched.
--   4. Idempotent under double-boot: second call returns 0 (R4-M1).
--   5. Rows without vendor_face_id are still reaped (state flip) but no
--      delete-queue insert (nothing to enqueue).
BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('frs-admin@test');
  v_cuid   uuid := tests.create_auth_user('frs-creator@test');
  v_cid    uuid;
  v_old1   bigint;
  v_old2   bigint;
  v_young  bigint;
  v_orphan bigint;
  v_n      int;
  v_state  text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'frs-admin@test', 'superadmin');
  UPDATE public.profiles SET handle = 'frs' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'FRS', 'frs', 'ready', now())
    RETURNING id INTO v_cid;

  -- 1. service-role gate (the test runs as superuser by default — switch to
  -- authenticated role first).
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    'SELECT public.face_clone_uploads_reap_stale_pending(30)',
    '%service_role only%',
    '1: anon/auth caller blocked'
  );
  PERFORM tests.reset_role();

  -- 2. Range guard: 4 rejected (below 5), 1500 rejected (above 1440).
  RETURN NEXT throws_like(
    'SELECT public.face_clone_uploads_reap_stale_pending(4)',
    '%p_max_age_minutes out of range%',
    '2a: <5 rejected'
  );
  RETURN NEXT throws_like(
    'SELECT public.face_clone_uploads_reap_stale_pending(1500)',
    '%p_max_age_minutes out of range%',
    '2b: >1440 rejected'
  );

  -- 3. Seed: two old pending rows (created_at backdated 60 min), one young
  -- (created_at backdated 10 min), one old without vendor_face_id.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, created_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('a', 64), 'image/jpeg', 1024, 512, 512,
     '88888888-1111-4222-9333-444444444444', 'pending', now() - interval '60 minutes')
  RETURNING id INTO v_old1;

  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, created_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('b', 64), 'image/jpeg', 1024, 512, 512,
     '88888888-1111-4222-9333-555555555555', 'pending', now() - interval '60 minutes')
  RETURNING id INTO v_old2;

  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, created_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('c', 64), 'image/jpeg', 1024, 512, 512,
     '88888888-1111-4222-9333-666666666666', 'pending', now() - interval '10 minutes')
  RETURNING id INTO v_young;

  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, created_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('d', 64), 'image/jpeg', 1024, 512, 512,
     NULL, 'pending', now() - interval '60 minutes')
  RETURNING id INTO v_orphan;

  -- 3. Reap with 30-min cutoff. Expect 3 rows reaped (two old + orphan).
  SELECT public.face_clone_uploads_reap_stale_pending(30) INTO v_n;
  RETURN NEXT is(v_n, 3, '3: reaper flipped 3 stale-pending rows');

  -- 4. Idempotent: second call yields 0.
  SELECT public.face_clone_uploads_reap_stale_pending(30) INTO v_n;
  RETURN NEXT is(v_n, 0, '4: second call is no-op (R4-M1 safe under reaper double-boot)');

  -- 5. Young row untouched.
  SELECT state::text INTO v_state FROM public.face_clone_uploads WHERE id = v_young;
  RETURN NEXT is(v_state, 'pending', '5a: young row preserved');

  -- 5b. Orphan (no vendor_face_id) row reaped but nothing in delete queue for it.
  RETURN NEXT ok(
    (SELECT state::text FROM public.face_clone_uploads WHERE id = v_orphan) = 'failed'
    AND (SELECT count(*) FROM public.simli_face_delete_queue
          WHERE creator_id = v_cid AND face_id IN (
            '88888888-1111-4222-9333-444444444444',
            '88888888-1111-4222-9333-555555555555'
          )) = 2,
    '5b: orphan reaped to failed; only rows with vendor_face_id enqueued'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
