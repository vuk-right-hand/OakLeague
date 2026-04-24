-- §9.2: dead-zone swipes (<500ms) are stored in feed_events_raw with
-- skipped_reason='dead_zone_swipe' so the rollup trigger skips them, but
-- the raw row is kept for debugging.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-dz@test');
  v_inserted int;
  v_dead     int;
  v_skip_reason text;
BEGIN
  PERFORM tests.set_authenticated(v_user);

  SELECT inserted, dead_zoned INTO v_inserted, v_dead
    FROM public.ingest_feed_events(jsonb_build_array(jsonb_build_object(
      'event_name',      'hook_swipe',
      'idempotency_key', gen_random_uuid()::text,
      'payload', jsonb_build_object('direction', 'up', 'seconds_to_decision_ms', 200)
    )));

  RETURN NEXT is(v_inserted, 0, '1: 0 real events inserted (all dead)');
  RETURN NEXT is(v_dead,     1, '2: 1 dead-zone counted');

  PERFORM tests.reset_role();

  SELECT skipped_reason INTO v_skip_reason
    FROM public.feed_events_raw
   WHERE user_id = v_user AND event_name = 'hook_swipe'
   LIMIT 1;
  RETURN NEXT is(
    v_skip_reason,
    'dead_zone_swipe',
    '3: raw row carries skipped_reason=dead_zone_swipe'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
