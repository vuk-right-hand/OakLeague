-- D4 audit H1: per-anon_id rate limit inside ingest_feed_events_anon.
-- Guards against distributed-IP flooding of a single oak_anon_id which
-- would otherwise bloat that session's topic_affinity / creator_affinity
-- jsonb blobs against the 4096-byte hard CHECK.
-- SQLSTATE 54000 (program_limit_exceeded) → HTTP 429 at the route.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_anon_id uuid;
BEGIN
  -- Mint a bona-fide anon session so the RPC gets past the 28000 guard.
  INSERT INTO public.anon_feed_sessions DEFAULT VALUES
    RETURNING anon_id INTO v_anon_id;

  -- Pre-seed the per-anon minute bucket at exactly the 300/min limit.
  -- Next RPC call increments to 301 → rate_limit_hit returns false →
  -- ingest_feed_events_anon raises 54000 before touching the blob.
  INSERT INTO public.rate_limit_counters
    (scope, key, window_start, hit_count)
  VALUES
    ('feed_events_anon', v_anon_id::text, date_trunc('minute', now()), 300);

  RETURN NEXT throws_ok(
    format($q$
      SELECT public.ingest_feed_events_anon(
        %L::uuid,
        jsonb_build_array(jsonb_build_object(
          'event_name',      'hook_impression',
          'idempotency_key', %L,
          'payload',         '{}'::jsonb
        ))
      )
    $q$, v_anon_id::text, gen_random_uuid()::text),
    '54000',
    'rate_limited',
    '1: at-limit anon call raises SQLSTATE 54000 (program_limit_exceeded)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
