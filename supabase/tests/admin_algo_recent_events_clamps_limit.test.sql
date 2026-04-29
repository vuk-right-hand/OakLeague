-- recent_events clamps p_limit to [1, 200].
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-re-clamp-admin@test');
  v_user  uuid := tests.create_auth_user('algo-re-clamp-user@test');
  v_count int;
  i int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-re-clamp-admin@test', 'superadmin');

  FOR i IN 1..210 LOOP
    INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
      VALUES (v_user, 'hook_impression', gen_random_uuid(),
              jsonb_build_object('served_rank', 0));
  END LOOP;

  PERFORM tests.set_authenticated(v_admin);

  SELECT count(*) INTO v_count FROM public.admin_algo_recent_events(v_user, 10000);
  RETURN NEXT is(v_count, 200, '1: p_limit=10000 clamps to 200');

  SELECT count(*) INTO v_count FROM public.admin_algo_recent_events(v_user, -5);
  RETURN NEXT is(v_count, 1,   '2: p_limit=-5 clamps to 1');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
