-- §9.8 / NC1: ingest_feed_events_anon raises SQLSTATE 28000
-- (invalid_authorization_specification) when the anon_id is unknown.
-- This maps to 401 in the API route — "your cookie is invalid, re-mint."
BEGIN;
SELECT plan(1);

SELECT throws_ok(
  $$ SELECT public.ingest_feed_events_anon(gen_random_uuid(), '[]'::jsonb) $$,
  '28000',
  'anon_session_not_found',
  '1: unknown anon_id raises SQLSTATE 28000'
);

SELECT * FROM finish();
ROLLBACK;
