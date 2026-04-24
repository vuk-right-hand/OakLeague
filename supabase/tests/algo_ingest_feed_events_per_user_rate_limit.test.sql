-- Audit H1: per-user rate limit fires INSIDE ingest_feed_events (not just
-- at the /api/events/feed-batch route layer). Guards against direct
-- PostgREST /rest/v1/rpc/ingest_feed_events calls that bypass the Next.js
-- route. SQLSTATE 54000 (program_limit_exceeded) → HTTP 429.
--
-- To test without actually firing 601 batches: pre-seed rate_limit_counters
-- with hit_count at PER_USER_LIMIT_PER_MIN so the next RPC call trips
-- immediately.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-ratelim@test');
  v_under_limit_result record;
  v_batch jsonb;
BEGIN
  PERFORM tests.set_authenticated(v_user);

  -- Under limit: call succeeds.
  v_batch := jsonb_build_array(jsonb_build_object(
    'event_name',      'hook_impression',
    'idempotency_key', gen_random_uuid()::text,
    'payload',         '{}'::jsonb
  ));
  SELECT * INTO v_under_limit_result FROM public.ingest_feed_events(v_batch);
  RETURN NEXT is(v_under_limit_result.inserted, 1, '1: under limit → call succeeds');

  PERFORM tests.reset_role();

  -- Simulate saturation: push the user's counter to exactly the limit
  -- (600). Next call increments to 601 → RPC raises 54000.
  INSERT INTO public.rate_limit_counters (scope, key, window_start, hit_count)
    VALUES ('feed_events_user', v_user::text, date_trunc('minute', now()), 600)
  ON CONFLICT (scope, key, window_start) DO UPDATE SET hit_count = 600;

  PERFORM tests.set_authenticated(v_user);

  RETURN NEXT throws_ok(
    format($q$
      SELECT public.ingest_feed_events(
        jsonb_build_array(jsonb_build_object(
          'event_name',      'hook_impression',
          'idempotency_key', %L,
          'payload',         '{}'::jsonb
        ))
      )
    $q$, gen_random_uuid()::text),
    '54000',
    'rate_limited',
    '2: at-limit call raises SQLSTATE 54000 (program_limit_exceeded)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
