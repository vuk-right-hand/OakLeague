-- All admin_algo_* RPCs raise 42501 for an authenticated non-admin caller.
BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-deny-user@test');
BEGIN
  PERFORM tests.set_authenticated(v_user);

  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_log_inspector_view(%L, %L)', v_user, gen_random_uuid()),
    '42501', NULL, '1: log_inspector_view denies non-admin'
  );
  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_user_summary(%L)', v_user),
    '42501', NULL, '2: user_summary denies non-admin'
  );
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.admin_algo_top_topics(%L, 5)', v_user),
    '42501', NULL, '3: top_topics denies non-admin'
  );
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.admin_algo_top_creators(%L, 5)', v_user),
    '42501', NULL, '4: top_creators denies non-admin'
  );
  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_funnel_7d(%L)', v_user),
    '42501', NULL, '5: funnel_7d denies non-admin'
  );
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.admin_algo_recent_events(%L, 50)', v_user),
    '42501', NULL, '6: recent_events denies non-admin'
  );
  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_score_explain(%L, %L, %L)',
           v_user, gen_random_uuid(), gen_random_uuid()),
    '42501', NULL, '7: score_explain denies non-admin'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
