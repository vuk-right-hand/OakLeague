-- admin_list_feed_algo_weights: admin guard + full row set. (0613-01)
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('weights-list-admin@test');
  v_other uuid := tests.create_auth_user('weights-list-other@test');
  v_count int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'weights-list-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_ok(
    $$SELECT * FROM public.admin_list_feed_algo_weights()$$,
    '42501', NULL, '1: non-admin caller rejected (42501)');
  PERFORM tests.reset_role();

  PERFORM tests.set_authenticated(v_admin);
  SELECT count(*)::int INTO v_count FROM public.admin_list_feed_algo_weights();
  PERFORM tests.reset_role();

  RETURN NEXT is(v_count, 11, '2: admin sees all 11 weight rows');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.feed_algo_weights WHERE weight_key = 'W_DIVERSITY_STEP'),
    '3: W_DIVERSITY_STEP row present (consumed by 0613-03 slate re-rank)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
