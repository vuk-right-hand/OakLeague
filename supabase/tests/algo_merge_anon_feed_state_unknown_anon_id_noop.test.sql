-- §9.6: merge_anon_feed_state with unknown anon_id is a silent no-op
-- (not an error — the auth callback should not fail just because the anon
-- cookie has expired or was never minted).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user   uuid := tests.create_auth_user('algo-merge-noop@test');
  v_bogus  uuid := gen_random_uuid();
BEGIN
  -- No anon row. Call should succeed and leave the user table empty.
  PERFORM public.merge_anon_feed_state(v_bogus, v_user);

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_topic_affinity   WHERE user_id = v_user),
    0,
    '1: no topic rows inserted for missing anon_id'
  );
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_creator_affinity WHERE user_id = v_user),
    0,
    '2: no creator rows inserted for missing anon_id'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
