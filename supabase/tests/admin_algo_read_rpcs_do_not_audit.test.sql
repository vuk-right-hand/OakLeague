-- C2: read-only fan-out RPCs (user_summary, top_topics, top_creators,
-- funnel_7d, recent_events) write 0 audit rows. Only log_inspector_view
-- writes the page-scoped audit row.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-noaudit-admin@test');
  v_user  uuid := tests.create_auth_user('algo-noaudit-user@test');
  v_count int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-noaudit-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_admin);

  PERFORM public.admin_algo_user_summary(v_user);
  PERFORM count(*) FROM public.admin_algo_top_topics(v_user, 5);
  PERFORM count(*) FROM public.admin_algo_top_creators(v_user, 5);
  PERFORM public.admin_algo_funnel_7d(v_user);
  PERFORM count(*) FROM public.admin_algo_recent_events(v_user, 50);
  PERFORM tests.reset_role();

  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user;
  RETURN NEXT is(v_count, 0, '1: read RPCs write 0 audit rows');

  -- Now log_inspector_view → exactly 1.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_log_inspector_view(v_user, gen_random_uuid());
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user;
  RETURN NEXT is(v_count, 1, '2: log_inspector_view writes 1 audit row');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
