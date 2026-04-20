-- R6-C2: LA user opening at 23:55 PST — spans UTC midnight — stays on the
-- SAME local day. session_turns_guard must use (started_at AT TIME ZONE tz).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_computed date;
BEGIN
  v_computed := ('2026-04-21 06:55:00+00'::timestamptz AT TIME ZONE 'America/Los_Angeles')::date;
  RETURN NEXT ok(
    v_computed = DATE '2026-04-20',
    'UTC 06:55 on day N is PDT 23:55 on day N-1 — stays on local day N-1'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
