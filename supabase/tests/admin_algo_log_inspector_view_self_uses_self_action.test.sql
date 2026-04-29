-- log_inspector_view called with p_user_id == admin_id writes
-- action='algo_profile_viewed_self' (Q4 — distinguishes self-debug from
-- inspecting other users in audit-review queries).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-self-admin@test');
  v_action text;
  v_count int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-self-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_admin, gen_random_uuid());
  PERFORM tests.reset_role();

  SELECT action INTO v_action
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_admin;
  RETURN NEXT is(v_action, 'algo_profile_viewed_self', '1: self-action set');

  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_admin
     AND action = 'algo_profile_viewed';
  RETURN NEXT is(v_count, 0, '2: non-self action NOT used');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
