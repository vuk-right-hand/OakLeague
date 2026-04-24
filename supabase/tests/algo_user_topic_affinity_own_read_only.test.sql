-- §9.1 RLS: user_topic_affinity is own-read only.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user_a uuid := tests.create_auth_user('algo-uta-a@test');
  v_user_b uuid := tests.create_auth_user('algo-uta-b@test');
BEGIN
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
  VALUES
    (v_user_a, 'cold_outreach', 1.0),
    (v_user_b, 'cold_outreach', 1.0);

  PERFORM tests.set_authenticated(v_user_a);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_topic_affinity),
    1,
    '1: user A sees only own affinity row'
  );

  PERFORM tests.set_authenticated(v_user_b);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_topic_affinity),
    1,
    '2: user B sees only own affinity row'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
