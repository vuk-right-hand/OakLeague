-- 0504-05 hardening (round-3 critical 3): ingest_feed_events does not crash
-- on a hook_swipe with seconds_to_decision_ms as string. Pre-hardening, this
-- would raise 22P02 and roll back the entire 50-event batch insert.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('hardening-ingest@test');
  v_inserted int;
  v_dead     int;
BEGIN
  PERFORM tests.set_authenticated(v_user);

  -- Mixed batch: one good event, one with malformed seconds_to_decision_ms.
  -- Post-hardening: both insert, the bad one is NOT classified as dead-zone
  -- (helper returns NULL → COALESCE(NULL, 9999) → 9999 < 500 is false).
  SELECT inserted, dead_zoned INTO v_inserted, v_dead
    FROM public.ingest_feed_events(jsonb_build_array(
      jsonb_build_object(
        'event_name',      'hook_swipe',
        'idempotency_key', gen_random_uuid()::text,
        'payload', jsonb_build_object(
          'direction',              'down',
          'seconds_to_decision_ms', 'fast'   -- STRING, not number
        )
      ),
      jsonb_build_object(
        'event_name',      'hook_swipe',
        'idempotency_key', gen_random_uuid()::text,
        'payload', jsonb_build_object('direction', 'right')
      )
    ));

  RETURN NEXT is(v_inserted, 2, '1: both events inserted (batch did not crash)');
  RETURN NEXT is(v_dead,     0, '2: malformed event treated as not-dead-zone (no flagging on NULL)');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
