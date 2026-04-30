-- T-D7-7: both purge functions return 0 cleanly when the matching window
-- is empty (no rows older than the cutoff). retention_run_log row is still
-- written with rows_deleted=0, hit_cap=false, batches_run=0.
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('d7-empty@test');
  v_anon uuid := gen_random_uuid();
  v_returned int;
BEGIN
  -- Recent feed event (5d old) — won't be purged.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'hook_impression', gen_random_uuid(),
            '{}'::jsonb, 'test_fixture',
            now() - interval '5 days');

  -- Recent anon session (1d old) — won't be purged.
  INSERT INTO public.anon_feed_sessions (anon_id, last_active_at)
    VALUES (v_anon, now() - interval '1 day');

  -- feed_events_raw purge: empty window.
  SELECT public.purge_feed_events_raw() INTO v_returned;
  RETURN NEXT is(v_returned, 0, '1: purge_feed_events_raw returns 0 on empty window');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.retention_run_log
       WHERE job_name = 'feed_events_raw_purge'
         AND rows_deleted = 0
         AND batches_run = 0
         AND hit_cap = false
    ),
    '2: retention_run_log row written with rows_deleted=0, batches_run=0, hit_cap=false'
  );

  -- anon purge: empty window.
  SELECT public.purge_anon_feed_sessions() INTO v_returned;
  RETURN NEXT is(v_returned, 0, '3: purge_anon_feed_sessions returns 0 on empty window');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.retention_run_log
       WHERE job_name = 'anon_feed_sessions_purge'
         AND rows_deleted = 0
         AND batches_run = 0
         AND hit_cap = false
    ),
    '4: retention_run_log row written for anon purge with rows_deleted=0'
  );

  -- Recent rows untouched.
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.feed_events_raw WHERE user_id = v_user),
    '5: 5d-old feed event preserved'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.anon_feed_sessions WHERE anon_id = v_anon),
    '6: 1d-old anon session preserved'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
