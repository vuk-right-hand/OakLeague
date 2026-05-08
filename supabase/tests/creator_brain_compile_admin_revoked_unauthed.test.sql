-- Public wrapper auth gating:
--   * active admin can recompile any creator
--   * revoked admin cannot (42501)
--   * unrelated user cannot (42501)
--   * unauthed (auth.uid()=NULL) cannot (42501)
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin_active   uuid := tests.create_auth_user('cbc-aa@test');
  v_admin_revoked  uuid := tests.create_auth_user('cbc-ar@test');
  v_other_user     uuid := tests.create_auth_user('cbc-ot@test');
  v_creat_user     uuid := tests.create_auth_user('cbc-cu@test');
  v_creator        uuid;
  v_err_state      text;
BEGIN
  INSERT INTO admin_roles (user_id, email, role, revoked_at)
    VALUES
      (v_admin_active,  'cbc-aa@test', 'superadmin', NULL),
      (v_admin_revoked, 'cbc-ar@test', 'superadmin', now());

  UPDATE public.profiles SET handle = 'cbcadrcu' WHERE id = v_creat_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creat_user, 'Test', 'cbcadrcu', 'training')
    RETURNING id INTO v_creator;

  -- 1) Active admin can call.
  PERFORM tests.set_authenticated(v_admin_active);
  PERFORM public.creator_brain_compile(v_creator);
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    (SELECT system_prompt FROM creators WHERE id = v_creator) IS NOT NULL,
    '1: active admin can recompile');

  -- 2) Revoked admin cannot.
  PERFORM tests.set_authenticated(v_admin_revoked);
  BEGIN
    PERFORM public.creator_brain_compile(v_creator);
    PERFORM tests.reset_role();
    RETURN NEXT fail('2: revoked admin should have been denied');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE;
    PERFORM tests.reset_role();
    RETURN NEXT is(v_err_state, '42501', '2: revoked admin gets 42501');
  END;

  -- 3) Random other user cannot.
  PERFORM tests.set_authenticated(v_other_user);
  BEGIN
    PERFORM public.creator_brain_compile(v_creator);
    PERFORM tests.reset_role();
    RETURN NEXT fail('3: other user should have been denied');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE;
    PERFORM tests.reset_role();
    RETURN NEXT is(v_err_state, '42501', '3: other user gets 42501');
  END;

  -- 4) Unauthed: with reset_role + no jwt claim, auth.uid() returns NULL.
  --    The public wrapper raises 42501 unauthorized.
  PERFORM tests.reset_role();
  BEGIN
    PERFORM public.creator_brain_compile(v_creator);
    RETURN NEXT fail('4: unauthed should have been denied');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err_state, '42501', '4: unauthed gets 42501');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
