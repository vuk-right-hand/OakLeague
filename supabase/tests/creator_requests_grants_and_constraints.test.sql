-- creator_requests (CREATOR_JOURNEY WS1): service-role-only table with a public
-- lead funnel. Verifies the security contract that the public /request form
-- relies on:
--   - RLS enabled (zero policies = deny-all for anon/authenticated)
--   - service_role has full access; anon + authenticated have NONE
--   - status CHECK + proof-is-object CHECK hold
--
-- Grant checks use has_table_privilege (NO role switching) to dodge the PG 17.6
-- secdef+set_role segfault trap (.claude_learnings 2026-05-22).
BEGIN;
SELECT plan(9);

-- RLS on.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.creator_requests'::regclass),
  '1: RLS enabled on creator_requests');

-- Zero policies (deny-all under RLS).
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'creator_requests'),
  0,
  '2: zero RLS policies (service-role only)');

-- service_role has full table access.
SELECT ok(has_table_privilege('service_role', 'public.creator_requests', 'INSERT'),
  '3: service_role can INSERT');
SELECT ok(has_table_privilege('service_role', 'public.creator_requests', 'SELECT'),
  '4: service_role can SELECT');

-- anon + authenticated have NONE (the public insert goes through the
-- service-role action, never a client-side .from()).
SELECT ok(NOT has_table_privilege('anon', 'public.creator_requests', 'SELECT'),
  '5: anon cannot SELECT');
SELECT ok(NOT has_table_privilege('anon', 'public.creator_requests', 'INSERT'),
  '6: anon cannot INSERT');
SELECT ok(NOT has_table_privilege('authenticated', 'public.creator_requests', 'SELECT'),
  '7: authenticated cannot SELECT');

-- status CHECK rejects unknown values.
SELECT throws_ok(
  $$INSERT INTO public.creator_requests (email, status) VALUES ('x@y.co', 'bogus')$$,
  '23514',
  NULL,
  '8: status CHECK rejects unknown status');

-- proof must be a JSON object (not an array/scalar).
SELECT throws_ok(
  $$INSERT INTO public.creator_requests (email, proof) VALUES ('x@y.co', '["a"]'::jsonb)$$,
  '23514',
  NULL,
  '9: proof CHECK rejects non-object');

SELECT * FROM finish();
ROLLBACK;
