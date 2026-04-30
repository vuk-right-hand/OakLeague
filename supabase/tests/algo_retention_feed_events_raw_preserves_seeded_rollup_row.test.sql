-- T-D7-3: purging old feed_events_raw rows does NOT touch the rollup tables
-- (user_topic_affinity, user_creator_affinity, hook_global_stats). The rollup
-- trigger fires AFTER INSERT only — there is no DELETE-side cascade — so
-- seeded rollup rows must survive the retention sweep verbatim.
--
-- Implementation note: we seed user_topic_affinity directly (not via the
-- trigger), then INSERT a feed event with skipped_reason='test_fixture' to
-- prevent the rollup trigger from creating its own row that would mask
-- whether the seeded row survives. If a future migration changes the rollup
-- trigger to process skipped events, this test must be reworked.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('d7-rollup@test');
  v_returned int;
  v_seeded_score real;
BEGIN
  -- Seed a user_topic_affinity row directly. tests.create_auth_user fires the
  -- on_auth_user_created trigger so the profiles row already exists; FK to
  -- profiles(id) is satisfied.
  INSERT INTO public.user_topic_affinity
    (user_id, topic_slug, impressions, affinity_score, last_event_at)
    VALUES (v_user, 'cold_outreach', 7, 0.42,
            now() - interval '120 days');

  -- Insert a 91d-old event with skipped_reason='test_fixture' to verify the
  -- purge runs cleanly. Rollup trigger short-circuits on non-NULL
  -- skipped_reason so the seeded row is the only rollup signal under test.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'hook_impression', gen_random_uuid(),
            '{}'::jsonb, 'test_fixture',
            now() - interval '91 days');

  SELECT public.purge_feed_events_raw() INTO v_returned;

  -- Seeded rollup row is unchanged.
  SELECT affinity_score INTO v_seeded_score
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'cold_outreach';

  RETURN NEXT is(v_returned, 1, '1: 91d-old event purged');
  RETURN NEXT ok(
    v_seeded_score IS NOT NULL AND v_seeded_score > 0.41 AND v_seeded_score < 0.43,
    format('2: seeded user_topic_affinity row preserved (score=%s)', v_seeded_score)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
