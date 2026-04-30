-- T-D7-1: purge_feed_events_raw deletes events older than 90 days
-- (excluding mic_tap) and leaves newer events untouched. Asserts return
-- value, retention_run_log row written, hit_cap=false on small data.
--
-- skipped_reason='test_fixture' short-circuits the rollup trigger
-- (feed_events_raw_rollup line 34) so the fixture INSERTs don't pollute
-- user_topic_affinity / user_creator_affinity / hook_global_stats.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('d7-purge-1@test');
  v_old_id  bigint;
  v_new_id  bigint;
  v_returned int;
  v_logged   int;
BEGIN
  -- 91-day-old event: expected to be purged.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'hook_impression', gen_random_uuid(),
            '{}'::jsonb, 'test_fixture',
            now() - interval '91 days')
    RETURNING id INTO v_old_id;

  -- 89-day-old event: expected to survive.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'hook_impression', gen_random_uuid(),
            '{}'::jsonb, 'test_fixture',
            now() - interval '89 days')
    RETURNING id INTO v_new_id;

  SELECT public.purge_feed_events_raw() INTO v_returned;

  RETURN NEXT is(v_returned, 1, '1: function returns 1 (the 91d-old row)');

  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM public.feed_events_raw WHERE id = v_old_id),
    '2: 91d-old row purged'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.feed_events_raw WHERE id = v_new_id),
    '3: 89d-old row preserved'
  );

  -- retention_run_log row written with rows_deleted=1, hit_cap=false.
  SELECT count(*)::int INTO v_logged
    FROM public.retention_run_log
   WHERE job_name = 'feed_events_raw_purge'
     AND rows_deleted = 1
     AND hit_cap = false
     AND batches_run = 1;
  RETURN NEXT is(v_logged, 1, '4: retention_run_log row written, hit_cap=false');

  -- Idempotent re-call: returns 0, second log row.
  SELECT public.purge_feed_events_raw() INTO v_returned;
  RETURN NEXT is(v_returned, 0, '5: re-invoke returns 0 — no backlog');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
