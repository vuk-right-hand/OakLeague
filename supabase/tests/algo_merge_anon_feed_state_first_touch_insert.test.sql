-- §9.6: first-touch merge (no prior user affinity rows) INSERTs the anon
-- values directly rather than blending with a zero default.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('algo-merge-fresh@test');
  v_anon_id uuid := gen_random_uuid();
  v_topic   real;
BEGIN
  INSERT INTO public.anon_feed_sessions (anon_id, topic_affinity)
    VALUES (v_anon_id, jsonb_build_object('build_in_public', 0.9));

  PERFORM public.merge_anon_feed_state(v_anon_id, v_user);

  SELECT affinity_score INTO v_topic
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'build_in_public';

  RETURN NEXT ok(
    abs(v_topic - 0.9) < 0.001,
    format('1: first-touch INSERT preserves anon value 0.9 (got %s)', v_topic)
  );
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.anon_feed_sessions WHERE anon_id = v_anon_id),
    0,
    '2: anon row deleted'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
