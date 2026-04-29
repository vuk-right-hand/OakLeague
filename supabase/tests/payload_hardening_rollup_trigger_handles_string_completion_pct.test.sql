-- 0504-05 hardening: rollup trigger does not crash on malformed
-- completion_pct (string instead of number). Pre-hardening, the cast
-- (NEW.payload->>'completion_pct')::real would raise 22P02 and roll back.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('hardening-rollup@test');
BEGIN
  -- Insert directly via service-role (bypasses ingest RPC's dead-zone /
  -- payload guards). The rollup trigger fires AFTER INSERT.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload)
  VALUES (
    v_user, 'hook_dwell_end', gen_random_uuid(),
    jsonb_build_object('completion_pct', '0.85')   -- STRING, not number
  );
  RETURN NEXT pass('1: rollup trigger did not crash on string completion_pct');

  -- Same with dwell_ms as string.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload)
  VALUES (
    v_user, 'hook_dwell_end', gen_random_uuid(),
    jsonb_build_object('completion_pct', 0.85, 'dwell_ms', 'foo')
  );
  RETURN NEXT pass('2: rollup trigger did not crash on string dwell_ms');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
