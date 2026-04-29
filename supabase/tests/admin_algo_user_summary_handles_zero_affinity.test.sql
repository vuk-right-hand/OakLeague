-- Fresh user with no affinity: user_topic_max=5.0, user_creator_max=5.0,
-- engagement_depth=0, events_30d.total=0. No errors.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-zero-admin@test');
  v_user  uuid := tests.create_auth_user('algo-zero-user@test');
  v_summary jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-zero-admin@test', 'superadmin');

  PERFORM tests.set_authenticated(v_admin);
  v_summary := public.admin_algo_user_summary(v_user);

  RETURN NEXT is((v_summary->>'engagement_depth')::int,        0,    '1: engagement_depth=0');
  RETURN NEXT is((v_summary->'events_30d'->>'total')::int,     0,    '2: events_30d.total=0');
  RETURN NEXT is((v_summary->>'user_topic_max')::real,         5.0::real, '3: user_topic_max=5.0 floor');
  RETURN NEXT is((v_summary->>'user_creator_max')::real,       5.0::real, '4: user_creator_max=5.0 floor');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
