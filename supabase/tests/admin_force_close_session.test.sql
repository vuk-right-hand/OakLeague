-- admin_force_close_session:
--   1. Non-admin caller → 42501
--   2. Missing session → P0002
--   3. Empty reason → 22023 bad_reason
--   4. Happy path: session closed with 'admin_force_close: …' prefix, audit row
--   5. Idempotent on already-closed session: no change, audit noop row
--
-- RLS note: sessions.SELECT policy = `user_id = auth.uid()` (only owner reads);
-- admin_audit_log has ZERO client policies (service-role only, RLS denies all
-- authenticated reads). Reset role before assertion SELECTs so postgres sees
-- every row.
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('fc-admin@test');
  v_user   uuid := tests.create_auth_user('fc-user@test');
  v_cuid   uuid := tests.create_auth_user('fc-creator@test');
  v_other  uuid := tests.create_auth_user('fc-other@test');
  v_cid    uuid;
  v_sid    uuid;
  v_end1   timestamptz;
  v_reason text;
  v_audit  bigint;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'fc-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'fcc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'FCC', 'fcc', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  -- 1. Non-admin rejected.
  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_like(
    format('SELECT public.admin_force_close_session(%L, %L)', v_sid, 'test'),
    '%admin not authorized%',
    '1: non-admin rejected'
  );
  PERFORM tests.reset_role();

  -- 2. Missing session.
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_force_close_session(%L, %L)', gen_random_uuid(), 'test'),
    '%not found%',
    '2: missing session → not_found'
  );

  -- 3. Empty reason.
  RETURN NEXT throws_like(
    format('SELECT public.admin_force_close_session(%L, %L)', v_sid, ''),
    '%bad_reason%',
    '3: empty reason rejected'
  );

  -- 4. Happy path.
  PERFORM public.admin_force_close_session(v_sid, 'zombie cleanup');
  PERFORM tests.reset_role();
  SELECT end_reason, ended_at INTO v_reason, v_end1
    FROM public.sessions WHERE id = v_sid;
  RETURN NEXT ok(
    v_reason = 'admin_force_close: zombie cleanup' AND v_end1 IS NOT NULL,
    '4: session closed with prefixed reason'
  );

  -- 5. Idempotent: second call writes audit-noop, does not re-touch ended_at.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_force_close_session(v_sid, 'retry');
  PERFORM tests.reset_role();

  SELECT count(*) INTO v_audit
    FROM public.admin_audit_log
   WHERE target_id = v_sid AND action = 'force_close_noop';
  RETURN NEXT is(v_audit::int, 1, '5a: idempotent call writes force_close_noop audit row');

  SELECT count(*) INTO v_audit
    FROM public.admin_audit_log
   WHERE target_id = v_sid AND action = 'force_close';
  RETURN NEXT is(v_audit::int, 1, '5b: original force_close row untouched');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
