-- §9.8 / NM1: a new minute window creates a fresh bucket (hit_count = 1).
-- Simulated by backdating the old row's window_start by 2 minutes; the
-- next call hits date_trunc('minute', now()) which doesn't match the old
-- row and inserts a new bucket.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_result boolean;
  i int;
BEGIN
  -- Saturate the current window at limit=2.
  FOR i IN 1..3 LOOP
    SELECT public.rate_limit_hit('feed_events_reset', 'key_b', '1 minute', 2)
      INTO v_result;
  END LOOP;
  -- 3rd call is over limit.
  RETURN NEXT is(v_result, false, '1: saturated window returns false');

  -- Backdate the bucket into a prior minute.
  UPDATE public.rate_limit_counters
     SET window_start = window_start - interval '2 minutes'
   WHERE scope = 'feed_events_reset' AND key = 'key_b';

  -- Next call lands in a fresh window → hit_count 1 ≤ limit 2 → true.
  SELECT public.rate_limit_hit('feed_events_reset', 'key_b', '1 minute', 2)
    INTO v_result;
  RETURN NEXT is(v_result, true, '2: new window → fresh bucket, call allowed');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
