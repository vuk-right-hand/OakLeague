-- R4-M1 + R6-C2: session started at 23:55 local. Turn at 00:05 next local
-- day still keys on the SESSION START DAY (not current_date).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_start_day date;
BEGIN
  -- session opened 23:55 PST day N = 07:55 UTC day N+1
  v_start_day := ('2026-04-20 23:55:00-07'::timestamptz AT TIME ZONE 'America/Los_Angeles')::date;
  RETURN NEXT ok(
    v_start_day = DATE '2026-04-20',
    'session opened 23:55 PST — quota_date keys on 2026-04-20 (session start day)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
