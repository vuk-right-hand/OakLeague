-- feed_algo_weights is service-role-only: RLS enabled, zero policies, no
-- direct table privileges for authenticated/anon. Reads flow through the
-- secdef helper; writes through the audited admin RPC. (0613-01)
BEGIN;
SELECT plan(6);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.feed_algo_weights'::regclass),
  '1: RLS enabled on feed_algo_weights'
);

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'feed_algo_weights'),
  0,
  '2: zero RLS policies (service-role only)'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feed_algo_weights', 'SELECT'),
  '3: authenticated has no SELECT'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feed_algo_weights', 'UPDATE'),
  '4: authenticated has no UPDATE'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.feed_algo_weights', 'SELECT'),
  '5: anon has no SELECT'
);

SELECT ok(
  has_table_privilege('service_role', 'public.feed_algo_weights', 'SELECT, INSERT, UPDATE, DELETE'),
  '6: service_role has full table privileges (Oct-30 explicit-grant rule)'
);

SELECT * FROM finish();
ROLLBACK;
