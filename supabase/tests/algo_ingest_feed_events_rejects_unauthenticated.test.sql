-- §9.2: ingest_feed_events raises SQLSTATE 28000 (invalid_authorization_
-- specification) when auth.uid() IS NULL. M2: distinct from 42501 so the
-- API route can map to 401 (sign in) rather than 403 (forbidden).
BEGIN;
SELECT plan(1);

SELECT throws_ok(
  $$ SELECT public.ingest_feed_events('[]'::jsonb) $$,
  '28000',
  'auth_required',
  '1: unauthenticated call raises SQLSTATE 28000'
);

SELECT * FROM finish();
ROLLBACK;
