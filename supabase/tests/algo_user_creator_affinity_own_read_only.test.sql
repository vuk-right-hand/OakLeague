-- §9.1 RLS: user_creator_affinity is own-read only.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user_a uuid := tests.create_auth_user('algo-uca-a@test');
  v_user_b uuid := tests.create_auth_user('algo-uca-b@test');
  v_creator_user uuid := tests.create_auth_user('algo-uca-creator@test');
  v_creator_id uuid;
BEGIN
  UPDATE public.profiles SET handle = 'ucaowner' WHERE id = v_creator_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_user, 'UCA Owner', 'ucaowner', 'pending')
    RETURNING id INTO v_creator_id;

  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
  VALUES
    (v_user_a, v_creator_id, 1.0),
    (v_user_b, v_creator_id, 1.0);

  PERFORM tests.set_authenticated(v_user_a);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_creator_affinity),
    1,
    '1: user A sees only own creator-affinity row'
  );

  PERFORM tests.set_authenticated(v_user_b);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_creator_affinity),
    1,
    '2: user B sees only own creator-affinity row'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
