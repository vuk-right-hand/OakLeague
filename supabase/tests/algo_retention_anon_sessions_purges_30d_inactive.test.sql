-- T-D7-4: purge_anon_feed_sessions deletes rows with last_active_at older
-- than 30 days; rows active within 30 days are preserved.
--
-- last_active_at is bumped by ingest_feed_events_anon on every event
-- (anon_feed_identity.sql:285), so engaged anons stay alive; only true
-- 30d-silent rows die.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_old_anon uuid := gen_random_uuid();
  v_new_anon uuid := gen_random_uuid();
  v_returned int;
BEGIN
  -- 31d-silent anon: should be purged.
  INSERT INTO public.anon_feed_sessions (anon_id, last_active_at)
    VALUES (v_old_anon, now() - interval '31 days');

  -- 29d-silent anon: should be preserved.
  INSERT INTO public.anon_feed_sessions (anon_id, last_active_at)
    VALUES (v_new_anon, now() - interval '29 days');

  SELECT public.purge_anon_feed_sessions() INTO v_returned;

  RETURN NEXT is(v_returned, 1, '1: function returns 1 (the 31d-silent row)');

  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM public.anon_feed_sessions WHERE anon_id = v_old_anon),
    '2: 31d-silent anon row purged'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.anon_feed_sessions WHERE anon_id = v_new_anon),
    '3: 29d-silent anon row preserved'
  );

  -- retention_run_log row written.
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.retention_run_log
       WHERE job_name = 'anon_feed_sessions_purge'
         AND rows_deleted = 1
         AND hit_cap = false
    ),
    '4: retention_run_log row written for anon purge'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
