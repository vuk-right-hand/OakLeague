-- Audit H1: per-user rate limit fires INSIDE ingest_feed_events (not just
-- at the planned /api/events/feed-batch route layer). Guards against
-- direct PostgREST /rest/v1/rpc/ingest_feed_events calls that bypass the
-- Next.js route. SQLSTATE 54000 (program_limit_exceeded) → HTTP 429.
--
-- Pre-seeding at-limit hit_count and firing one call is the tightest
-- deterministic test: pre-seed and call are consecutive so the
-- date_trunc('minute', now()) bucket matches (M3 stability).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-ratelim@test');
BEGIN
  -- Pre-seed the user's minute bucket at exactly the 600-per-minute limit.
  -- Next RPC call increments to 601 → rate_limit_hit returns false →
  -- ingest_feed_events raises 54000.
  INSERT INTO public.rate_limit_counters
    (scope, key, window_start, hit_count)
  VALUES
    ('feed_events_user', v_user::text, date_trunc('minute', now()), 600);

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
    '1: at-limit call raises SQLSTATE 54000 (program_limit_exceeded)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
