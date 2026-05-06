-- admin_force_retrain_creator (post-R2-C1) — when a face is force-retrained,
-- the matching face_clone_uploads row must transition to 'deleted'. Otherwise
-- the audit log diverges from creators.simli_face_id and the trigger's
-- ready→deleted-only constraint locks it in forever.
--
-- Also asserts the lock-namespace migration to face_clone_overwrite:<id>.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('afrt-admin@test');
  v_cuid   uuid := tests.create_auth_user('afrt-creator@test');
  v_cid    uuid;
  v_uid    bigint;
  v_face   text := '66666666-7777-4888-9999-aaaaaaaaaaaa';
  v_pending bigint;
  v_state  text;
  v_qcount bigint;
  v_def    text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'afrt-admin@test', 'superadmin');
  UPDATE public.profiles SET handle = 'afrt' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at, simli_face_id)
    VALUES (v_cuid, 'AFRT', 'afrt', 'ready', now(), v_face)
    RETURNING id INTO v_cid;

  -- Seed a 'ready' row matching the live face_id.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state, ready_at)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('a', 64), 'image/jpeg', 1024, 512, 512, v_face, 'ready', now())
  RETURNING id INTO v_uid;

  -- And a stale pending row that should also be cleaned up.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes, width, height,
     vendor_face_id, state)
  VALUES
    (v_admin, v_cid, 'simli', 'image',
     repeat('b', 64), 'image/jpeg', 1024, 512, 512, NULL, 'pending')
  RETURNING id INTO v_pending;

  -- Call force-retrain as the admin (auth role).
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_force_retrain_creator(v_cid);
  PERFORM tests.reset_role();

  -- 1. simli_face_id cleared.
  RETURN NEXT ok(
    (SELECT simli_face_id FROM public.creators WHERE id = v_cid) IS NULL,
    '1: creators.simli_face_id cleared'
  );

  -- 2. The ready row transitioned to 'deleted'.
  SELECT state::text INTO v_state FROM public.face_clone_uploads WHERE id = v_uid;
  RETURN NEXT is(v_state, 'deleted', '2: matching ready row → deleted (R2-C1)');

  -- 3. Pending row marked 'failed' to free the M1 resume path.
  SELECT state::text INTO v_state FROM public.face_clone_uploads WHERE id = v_pending;
  RETURN NEXT is(v_state, 'failed', '3: stale pending row marked failed');

  -- 4. Prior face enqueued for 60s-deferred delete.
  SELECT count(*) INTO v_qcount FROM public.simli_face_delete_queue WHERE face_id = v_face;
  RETURN NEXT is(v_qcount::int, 1, '4: prior face enqueued for delete');

  -- 5. Lock-namespace sanity: function body uses the new
  -- 'face_clone_overwrite:' lock, not the legacy 'creator_retrain:'.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public' AND p.proname = 'admin_force_retrain_creator'
   LIMIT 1;
  RETURN NEXT ok(
    v_def LIKE '%face_clone_overwrite:%' AND v_def NOT LIKE '%creator_retrain:%',
    '5: function uses unified face_clone_overwrite lock namespace'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
