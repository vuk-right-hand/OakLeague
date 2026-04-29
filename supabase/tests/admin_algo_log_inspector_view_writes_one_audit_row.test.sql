-- log_inspector_view writes exactly one admin_audit_log row with the
-- correct shape: action='algo_profile_viewed', target_kind='profile',
-- target_id=p_user_id, after.session_correlation_id matches.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin   uuid := tests.create_auth_user('algo-log-admin@test');
  v_user    uuid := tests.create_auth_user('algo-log-user@test');
  v_corr    uuid := gen_random_uuid();
  v_count   int;
  v_action  text;
  v_target  uuid;
  v_corr_db text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-log-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_user, v_corr);
  PERFORM tests.reset_role();   -- RLS on admin_audit_log denies authenticated.

  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user;
  RETURN NEXT is(v_count,  1, '1: exactly one row written');

  SELECT action, target_id, after->>'session_correlation_id'
    INTO v_action, v_target, v_corr_db
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user
   LIMIT 1;
  RETURN NEXT is(v_action, 'algo_profile_viewed',   '2: action correct');
  RETURN NEXT is(v_target, v_user,                  '3: target_id matches p_user_id');
  RETURN NEXT is(v_corr_db, v_corr::text,           '4: session_correlation_id persisted');

  -- target_kind invariant.
  SELECT target_kind INTO v_action
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user
   LIMIT 1;
  RETURN NEXT is(v_action, 'profile', '5: target_kind=profile');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
