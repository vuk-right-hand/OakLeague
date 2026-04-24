-- §9.8 / NM1: rate_limit_hit returns true while under the limit and false
-- once the bucket hit_count crosses p_limit in the same window.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_result boolean;
  i int;
BEGIN
  -- Limit 3 for a fast test. First 3 calls return true.
  FOR i IN 1..3 LOOP
    SELECT public.rate_limit_hit('feed_events_test', 'key_a', '1 minute', 3) INTO v_result;
    IF NOT v_result THEN
      RAISE EXCEPTION 'call % unexpectedly returned false', i;
    END IF;
  END LOOP;
  RETURN NEXT ok(true, '1: first 3 calls under limit returned true');

  -- 4th call crosses the limit.
  SELECT public.rate_limit_hit('feed_events_test', 'key_a', '1 minute', 3) INTO v_result;
  RETURN NEXT is(v_result, false, '2: 4th call returns false (over limit)');

  -- 5th call also returns false.
  SELECT public.rate_limit_hit('feed_events_test', 'key_a', '1 minute', 3) INTO v_result;
  RETURN NEXT is(v_result, false, '3: subsequent calls stay false for rest of window');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
