-- §9.1 / §9.6 RLS: anon_feed_sessions has zero authenticated/anon policies.
BEGIN;
SELECT plan(3);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.anon_feed_sessions'::regclass),
  '1: RLS enabled on anon_feed_sessions'
);

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'anon_feed_sessions'),
  0,
  '2: anon_feed_sessions has zero RLS policies'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.anon_feed_sessions', 'SELECT')
  AND NOT has_table_privilege('anon',          'public.anon_feed_sessions', 'SELECT'),
  '3: authenticated/anon cannot SELECT anon_feed_sessions'
);

SELECT * FROM finish();
ROLLBACK;
