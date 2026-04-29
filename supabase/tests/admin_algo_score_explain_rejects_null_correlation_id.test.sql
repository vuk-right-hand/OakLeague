-- score_explain requires non-NULL session_correlation_id; rejects with
-- SQLSTATE 22023 (invalid_parameter_value).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-senull-admin@test');
  v_user  uuid := tests.create_auth_user('algo-senull-user@test');
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-senull-admin@test', 'superadmin');

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);

  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_score_explain(%L, %L, NULL::uuid)',
           v_user, gen_random_uuid()),
    '22023', NULL, '1: NULL correlation_id → 22023'
  );
  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_score_explain(NULL::uuid, %L, %L)',
           gen_random_uuid(), gen_random_uuid()),
    '22023', NULL, '2: NULL p_user_id → 22023'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
