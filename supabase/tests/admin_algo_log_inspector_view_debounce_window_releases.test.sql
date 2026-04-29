-- Debounce window releases after 5s. Simulate by backdating the existing
-- audit row's created_at instead of pg_sleep (avoids slow tests; matches
-- the codebase pattern from algo decay tests).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-deb-rel-admin@test');
  v_user  uuid := tests.create_auth_user('algo-deb-rel-user@test');
  v_count int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-deb-rel-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_user, gen_random_uuid());

  -- Backdate to 6 seconds ago — outside the 5s debounce window.
  PERFORM tests.reset_role();
  UPDATE public.admin_audit_log SET created_at = now() - interval '6 seconds'
   WHERE admin_user_id = v_admin AND target_id = v_user;

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_user, gen_random_uuid());
  PERFORM tests.reset_role();

  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user
     AND action = 'algo_profile_viewed';
  RETURN NEXT is(v_count, 2, '1: after 6s, second call writes a new row');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
