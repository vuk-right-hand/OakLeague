-- log_inspector_view debounces: a second call within 5 seconds for the
-- same (admin, target, action) does not write a new audit row. Coalesces
-- accidental refresh-loops so the audit log doesn't bloat.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-deb-admin@test');
  v_user  uuid := tests.create_auth_user('algo-deb-user@test');
  v_other uuid := tests.create_auth_user('algo-deb-other@test');
  v_count int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-deb-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_user, gen_random_uuid());
  PERFORM public.admin_algo_log_inspector_view(v_user, gen_random_uuid());
  PERFORM public.admin_algo_log_inspector_view(v_user, gen_random_uuid());
  PERFORM tests.reset_role();

  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user
     AND action = 'algo_profile_viewed';
  RETURN NEXT is(v_count, 1, '1: 3 calls within 5s → 1 audit row');

  -- Different target → not debounced.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_other, gen_random_uuid());
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND action = 'algo_profile_viewed';
  RETURN NEXT is(v_count, 2, '2: different target → new audit row');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
