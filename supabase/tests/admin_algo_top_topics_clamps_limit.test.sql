-- top_topics clamps p_limit to [1, 50]. Out-of-range and negative values
-- both clamp; no SQLSTATE error.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-tt-clamp-admin@test');
  v_user  uuid := tests.create_auth_user('algo-tt-clamp-user@test');
  v_count int;
  i int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-tt-clamp-admin@test', 'superadmin');

  -- Seed 60 topics so the 50 ceiling actually clamps.
  FOR i IN 1..60 LOOP
    INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
      VALUES (v_user, format('topic_%s', i), i::real);
  END LOOP;

  PERFORM tests.set_authenticated(v_admin);

  SELECT count(*) INTO v_count FROM public.admin_algo_top_topics(v_user, 10000);
  RETURN NEXT is(v_count, 50, '1: p_limit=10000 clamps to 50');

  SELECT count(*) INTO v_count FROM public.admin_algo_top_topics(v_user, -5);
  RETURN NEXT is(v_count, 1,  '2: p_limit=-5 clamps to 1');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
